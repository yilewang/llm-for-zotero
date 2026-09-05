import type {
  AgentEvent,
  AgentRuntimeRequest,
  ResolvedAgentRuntimeRequest,
} from "../types";
import {
  evaluateActionContract,
  formatReceiptStatus,
} from "./actionEvaluation";
import type {
  AgentActionContract,
  AgentActionProgressLedger,
  AgentActionReceipt,
} from "./types";

export type ActionContractCheckpoint = {
  contract: AgentActionContract;
  progress: AgentActionProgressLedger;
};

export type ActionContractInitialization =
  | { kind: "ready" }
  | { kind: "failed"; userMessage: string };

export type ActionContractFinalDecision =
  | { kind: "accept" }
  | { kind: "correct"; correction: string }
  | { kind: "fail"; failure: string };

export type RejectedActionContractFinalDecision = Extract<
  ActionContractFinalDecision,
  { kind: "correct" | "fail" }
>;

type ActionContractCreationPort = {
  createActionContract(
    request: AgentRuntimeRequest,
  ): Promise<AgentActionContract | null>;
  createActionProgress(
    contract: AgentActionContract,
  ): AgentActionProgressLedger;
};

type ActionContractRunSessionParams = {
  request: ResolvedAgentRuntimeRequest;
  contracts: ActionContractCreationPort;
  emit: (event: AgentEvent) => Promise<void>;
};

function isExplicitResumeRequest(text: string): boolean {
  return /^\s*(?:continue|resume|keep going|go on|pick up where you left off)\b/i.test(
    text,
  );
}

export function readLatestActionContractCheckpoint(
  events: readonly AgentEvent[],
): ActionContractCheckpoint | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event.type !== "provider_event" ||
      event.providerType !== "agent_action_contract"
    ) {
      continue;
    }
    const contract = event.payload?.contract as AgentActionContract | undefined;
    const progress = event.payload?.progress as
      | AgentActionProgressLedger
      | undefined;
    if (
      contract?.version === 2 &&
      typeof contract.id === "string" &&
      Array.isArray(contract.obligations) &&
      progress?.version === 1 &&
      progress.contractId === contract.id &&
      Array.isArray(progress.obligations)
    ) {
      return { contract, progress };
    }
  }
  return null;
}

export class ActionContractRunSession {
  private readonly request: ResolvedAgentRuntimeRequest;
  private readonly contracts: ActionContractCreationPort;
  private readonly emit: (event: AgentEvent) => Promise<void>;
  private readonly receipts: AgentActionReceipt[] = [];

  constructor(params: ActionContractRunSessionParams) {
    this.request = params.request;
    this.contracts = params.contracts;
    this.emit = params.emit;
  }

  async initialize(params: {
    checkpoint: ActionContractCheckpoint | null;
  }): Promise<ActionContractInitialization> {
    try {
      if (params.checkpoint && isExplicitResumeRequest(this.request.userText)) {
        this.request.actionContract = params.checkpoint.contract;
        this.request.actionProgress = params.checkpoint.progress;
      } else {
        this.request.actionContract =
          (await this.contracts.createActionContract(this.request)) ||
          undefined;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.emit({
        type: "provider_event",
        providerType: "agent_action_contract",
        payload: { state: "failed", retryable: true, reason },
      });
      return {
        kind: "failed",
        userMessage: `I could not safely resolve the requested action scope: ${reason}`,
      };
    }

    const contract = this.request.actionContract;
    if (contract) {
      if (this.request.actionProgress?.contractId !== contract.id) {
        this.request.actionProgress =
          this.contracts.createActionProgress(contract);
      }
      await this.emitSnapshot();
    }
    return { kind: "ready" };
  }

  async checkpoint(): Promise<void> {
    if (!this.request.actionContract || !this.request.actionProgress) return;
    await this.emitSnapshot();
  }

  async recordToolReceipts(
    receipts: readonly AgentActionReceipt[],
  ): Promise<void> {
    this.receipts.push(...receipts);
    if (!this.request.actionContract || !this.request.actionProgress) return;
    await this.emitSnapshot();
  }

  async evaluateFinal(params: {
    canCorrect: boolean;
  }): Promise<ActionContractFinalDecision> {
    const contract = this.request.actionContract;
    if (!contract) return { kind: "accept" };

    const progress = this.request.actionProgress;
    const evaluation = evaluateActionContract(
      contract,
      this.receipts,
      progress,
    );
    if (progress && evaluation.state !== "failed") {
      progress.state = evaluation.state;
    }
    await this.emitSnapshot(evaluation.state);

    if (evaluation.state === "satisfied" || evaluation.state === "cancelled") {
      return { kind: "accept" };
    }
    if (
      (progress?.correctionCount || 0) < 1 &&
      params.canCorrect &&
      evaluation.correction
    ) {
      return { kind: "correct", correction: evaluation.correction };
    }
    return {
      kind: "fail",
      failure:
        evaluation.failure ||
        "I could not verify completion of the requested action.",
    };
  }

  commitRejectedFinal(decision: RejectedActionContractFinalDecision): void {
    const progress = this.request.actionProgress;
    if (!progress) return;
    if (decision.kind === "correct") {
      progress.correctionCount += 1;
    } else {
      progress.state = "failed";
    }
    progress.updatedAt = Date.now();
  }

  receiptStatus(): string {
    const contract = this.request.actionContract;
    if (!contract) return "";
    const relevantReceipts = this.receipts.filter((receipt) =>
      contract.obligations.some(
        (obligation) =>
          receipt.obligationId === obligation.id ||
          (receipt.operation === obligation.operation &&
            receipt.proofDomain === obligation.proofDomain),
      ),
    );
    return formatReceiptStatus(relevantReceipts);
  }

  private async emitSnapshot(
    state?: AgentActionProgressLedger["state"],
  ): Promise<void> {
    const contract = this.request.actionContract;
    const progress = this.request.actionProgress;
    if (!contract || !progress) return;
    await this.emit({
      type: "provider_event",
      providerType: "agent_action_contract",
      payload: {
        ...(state ? { state } : {}),
        contract,
        progress,
      },
    });
  }
}

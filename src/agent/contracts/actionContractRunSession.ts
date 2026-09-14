import { carryWorkflowProgress } from "./workflowContinuation";
import type { ActionContractCheckpoint } from "./workflowCheckpoint";
export {
  readLatestActionContractCheckpoint,
  type ActionContractCheckpoint,
} from "./workflowCheckpoint";
import { ActionReferenceResolutionError } from "./actionScope";
import type {
  AgentEvent,
  AgentRuntimeRequest,
  ResolvedAgentRuntimeRequest,
} from "../types";
import {
  evaluatePreparedActionContract,
  formatReceiptStatus,
} from "./actionEvaluation";
import type {
  AgentActionContract,
  AgentActionProgressLedger,
  AgentActionReceipt,
} from "./types";

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
    if (this.request.classifiedIntent?.semantic)
      await this.emit({
        type: "provider_event",
        providerType: "agent_semantic_intent",
        payload: {
          intent: this.request.classifiedIntent,
          clarificationHistory: this.request.clarificationHistory || [],
        },
      });
    try {
      if (this.request.planContext?.phase === "executing") {
        // PlanExecutionRunSession has restored either the initial frozen
        // contract or a separately approved research-derived contract. An
        // absent contract is intentional and must not be inferred from the
        // synthetic execution prompt.
        if (
          params.checkpoint &&
          this.request.actionContract?.id === params.checkpoint.contract.id &&
          params.checkpoint.progress.contractId ===
            this.request.actionContract.id
        )
          this.request.actionProgress = params.checkpoint.progress;
      } else {
        this.request.workflowCheckpoint ||= params.checkpoint || undefined;
        this.request.actionPreparation = { state: "resolving", issues: [] };
        this.request.actionContract =
          (await this.contracts.createActionContract(this.request)) ||
          undefined;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof ActionReferenceResolutionError) {
        this.request.actionContract = undefined;
        this.request.actionPreparation = {
          state: "needs_input",
          issues: [reason],
          sourceSelection: error.sourceSelection,
        };
        await this.emit({
          type: "provider_event",
          providerType: "agent_action_preparation",
          payload: this.request.actionPreparation,
        });
        return { kind: "ready" };
      }
      this.request.actionPreparation = {
        state: "unavailable",
        issues: [reason],
      };
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

    this.request.actionPreparation = { state: "ready", issues: [] };
    const contract = this.request.actionContract;
    if (contract) {
      if (this.request.actionProgress?.contractId !== contract.id) {
        this.request.actionProgress =
          this.contracts.createActionProgress(contract);
      }
      if (this.request.planContext?.phase !== "executing") {
        try {
          await carryWorkflowProgress(
            this.request,
            contract,
            this.request.actionProgress!,
          );
        } catch (error) {
          return {
            kind: "failed",
            userMessage: `Prior workflow evidence could not be reused: ${String(error)}`,
          };
        }
      }
      await this.emitSnapshot();
    }
    return { kind: "ready" };
  }

  async checkpoint(): Promise<void> {
    const contract = this.request.actionContract;
    if (!contract) return;
    if (this.request.actionProgress?.contractId !== contract.id) {
      this.request.actionProgress =
        this.contracts.createActionProgress(contract);
    }
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
    const progress = this.request.actionProgress;
    const evaluation = evaluatePreparedActionContract(
      this.request,
      this.receipts,
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

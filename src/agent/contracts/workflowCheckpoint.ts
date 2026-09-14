import type { AgentEvent, AgentRunRecord } from "../types";
import type { AgentActionContract, AgentActionProgressLedger } from "./types";
import {
  getAgentRunTrace,
  getLatestAgentRunForConversation,
} from "../store/traceStore";
export type ActionContractCheckpoint = {
  contract: AgentActionContract;
  progress: AgentActionProgressLedger;
};
export function readLatestActionContractCheckpoint(
  events: readonly AgentEvent[],
): ActionContractCheckpoint | null {
  let predecessor: ActionContractCheckpoint | null = null;
  for (const event of [...events].reverse()) {
    if (
      event.type !== "provider_event" ||
      !["agent_action_contract", "agent_workflow_predecessor"].includes(
        event.providerType || "",
      )
    )
      continue;
    const contract = event.payload?.contract as AgentActionContract | undefined;
    const progress = event.payload?.progress as
      | AgentActionProgressLedger
      | undefined;
    if (
      contract?.version === 4 &&
      typeof contract.id === "string" &&
      Array.isArray(contract.obligations) &&
      progress?.version === 1 &&
      progress.contractId === contract.id &&
      Array.isArray(progress.obligations)
    )
      if (event.providerType === "agent_action_contract")
        return { contract, progress };
      else predecessor ||= { contract, progress };
  }
  return predecessor;
}
export async function loadWorkflowCheckpoint(
  conversationKey: number,
  knownPriorRun?: AgentRunRecord | null,
): Promise<ActionContractCheckpoint | undefined> {
  const prior =
    knownPriorRun === undefined
      ? await getLatestAgentRunForConversation(conversationKey)
      : knownPriorRun;
  if (!prior || prior.status === "running") return undefined;
  const trace = await getAgentRunTrace(prior.runId);
  return (
    readLatestActionContractCheckpoint(
      trace.events.map((event) => event.payload),
    ) || undefined
  );
}

/** Only identity, requested meaning, and verified progress belong in model context. */
export function workflowCheckpointEvidence(
  checkpoint?: ActionContractCheckpoint,
) {
  if (!checkpoint) return null;
  return {
    contractId: checkpoint.contract.id,
    intent: checkpoint.contract.intent,
    obligations: checkpoint.contract.obligations,
    progress: {
      obligations: checkpoint.progress.obligations,
      materialOutputs: checkpoint.progress.materialOutputs,
      updatedAt: checkpoint.progress.updatedAt,
    },
  };
}

import { actionIsComplete } from "../contracts/workflowDependencies";
import type {
  AgentActionObligation,
  AgentActionOperation,
  AgentRuntimeRequest,
  AgentToolCall,
} from "../types";

export type PreparedActionBinding = {
  toolName: string;
  checkpointPerItem?: boolean;
  bind: (
    obligation: AgentActionObligation,
    request: AgentRuntimeRequest,
  ) =>
    | { arguments: unknown; summary: string }
    | null
    | Promise<{ arguments: unknown; summary: string } | null>;
};
export type PreparedActionCall = {
  obligationId: string;
  call: AgentToolCall;
  summary: string;
};
export type PreparedActionBindings = Map<
  AgentActionOperation,
  PreparedActionBinding
>;

export type WorkflowStep =
  | { kind: "action"; prepared: PreparedActionCall }
  | { kind: "model"; reason: string }
  | {
      kind: "blocked";
      code: "cancelled" | "invalid_binding";
      reason: string;
    }
  | { kind: "complete" };

/** Select from frozen intent and verified progress; the ledger remains the durable owner. */
export async function selectWorkflowStep(
  request: AgentRuntimeRequest,
  bindings: PreparedActionBindings,
  allowedObligationIds?: readonly string[],
): Promise<WorkflowStep> {
  const contract = request.actionContract;
  if (
    request.actionPreparation?.state !== "ready" ||
    !contract?.obligations.length
  )
    return { kind: "model", reason: "No prepared action workflow" };
  const progress =
    request.actionProgress?.contractId === contract.id
      ? request.actionProgress
      : undefined;
  let remaining = false;
  let modelReason = "The approved active task requires model work";
  for (const obligation of contract.obligations) {
    const state = progress?.obligations.find(
      (entry) => entry.obligationId === obligation.id,
    );
    if (state && ["fulfilled", "already_satisfied"].includes(state.status))
      continue;
    if (state?.status === "cancelled")
      return {
        kind: "blocked",
        code: "cancelled",
        reason:
          "A requested action was cancelled; nothing changed for that action. Verified earlier progress is retained and dependent effects remain stopped.",
      };
    remaining = true;
    if (allowedObligationIds && !allowedObligationIds.includes(obligation.id))
      continue;
    if (
      (obligation.dependsOn || []).some(
        (index) => !actionIsComplete(contract, progress, index),
      )
    )
      continue;
    if (obligation.destinationCreation) {
      modelReason =
        "A destination must be created and verified before this action";
      continue;
    }
    if (
      obligation.contentFrom &&
      !progress?.materialOutputs?.some(
        (entry) => entry.outputId === obligation.contentFrom,
      )
    ) {
      modelReason = `Generate and finalize requested material '${obligation.contentFrom}'`;
      continue;
    }
    const binding = bindings.get(obligation.operation);
    const verified = new Set(state?.verifiedTargetIds || []);
    const remainingBoundary = obligation.targetBoundary
      ? {
          ...obligation.targetBoundary,
          frozenTargetIds: obligation.targetBoundary.frozenTargetIds
            .filter((id) => !verified.has(`item:${id}`))
            .slice(0, binding?.checkpointPerItem ? 1 : undefined),
        }
      : undefined;
    const pendingObligation = remainingBoundary
      ? { ...obligation, targetBoundary: remainingBoundary }
      : obligation;
    const bound = await binding?.bind(pendingObligation, request);
    if (!binding || !bound) {
      modelReason = `Prepare the remaining ${obligation.operation} work within the frozen intent`;
      continue;
    }
    return {
      kind: "action",
      prepared: {
        obligationId: obligation.id,
        call: {
          id: `workflow:${obligation.id}${binding.checkpointPerItem && remainingBoundary?.frozenTargetIds.length ? `:item:${remainingBoundary.frozenTargetIds[0]}` : ""}`,
          name: binding.toolName,
          arguments: bound.arguments,
        },
        summary: bound.summary,
      },
    };
  }
  const material = contract.intent?.semantic?.materialOutputs || [];
  if (
    remaining ||
    material.some(
      (output) =>
        !progress?.materialOutputs?.some(
          (entry) => entry.outputId === output.id,
        ),
    )
  )
    return { kind: "model", reason: modelReason };
  return { kind: "complete" };
}

import type { AgentRuntimeRequest } from "../types";
import type { PlanDocument } from "../documents/types";
import { loadPlanExecutionLedger } from "./store";
import { planExecutionCoordinator } from "./coordinator";

/** A generated intermediate artifact is verified before any action saves it. */
export async function requirePlanMaterialTask(
  request: AgentRuntimeRequest,
  outputId: string,
) {
  const plan = request.planContext;
  if (plan?.phase !== "executing") return undefined;
  const ledger = await loadPlanExecutionLedger(plan.executionId);
  const task = ledger?.tasks.find(
    (entry) => entry.taskId === ledger.activeTaskId,
  );
  const requirement = task?.completionRequirements?.find(
    (entry) => entry.kind === "material_integrity",
  );
  if (
    !task ||
    task.status !== "in_progress" ||
    task.materialOutputId !== outputId ||
    !requirement
  )
    throw new Error(
      `Start the approved artifact step for materialOutputId '${outputId}' before generating it.`,
    );
  return { ledger: ledger!, task, requirement };
}

export async function attachPlanMaterialEvidence(
  request: AgentRuntimeRequest,
  outputId: string,
  document: PlanDocument,
): Promise<void> {
  const active = await requirePlanMaterialTask(request, outputId);
  if (!active) return;
  if (
    !document.validation.integrityValidated ||
    document.conversationKey !== request.conversationKey
  )
    throw new Error(
      "The stored workflow material has not passed integrity validation",
    );
  const { ledger, task, requirement } = active;
  await planExecutionCoordinator.attachEvidence({
    version: 3,
    evidenceId: `${ledger.executionId}:${task.taskId}:${document.documentId}:material`,
    executionId: ledger.executionId,
    taskId: task.taskId,
    kind: "material_integrity",
    verified: true,
    requirementId: requirement.requirementId,
    criterionIds: requirement.criterionIds,
    contractDigest: requirement.contractDigest,
    payload: {
      type: "material_integrity",
      materialOutputId: outputId,
      documentId: document.documentId,
      contentHash: document.contentHash,
      integrityValidated: true,
    },
    reference: document.contentHash,
    summary:
      "The exact generated material was verified and stored for its dependent save action",
    createdAt: Date.now(),
  });
}

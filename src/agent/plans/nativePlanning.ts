import { planExecutionCoordinator } from "./coordinator";
import { loadPlanArtifact, savePlanArtifact } from "./store";
import type { PlanArtifact, PlanRuntimeContext } from "./types";

export async function beginNativePlanningAttempt(
  plan: Extract<PlanRuntimeContext, { phase: "planning" }>,
): Promise<void> {
  await planExecutionCoordinator.supersedePriorDraft(
    plan.planId,
    plan.revision,
  );
  const artifact = await loadPlanArtifact(plan.planId, plan.revision);
  if (!artifact) return;
  if (
    artifact.status === "approved" ||
    artifact.status === "cancelled" ||
    artifact.status === "superseded"
  ) {
    throw new Error(
      "This plan revision is closed. Request a new revision to continue planning.",
    );
  }
  if (artifact.status === "awaiting_approval")
    await savePlanArtifact({
      ...artifact,
      status: "drafting",
      updatedAt: Date.now(),
    });
}

export async function finalizeNativePlanProposal(params: {
  plan: Extract<PlanRuntimeContext, { phase: "planning" }>;
  conversationKey: number;
  proposal: { threadId: string; turnId: string; itemId: string; text: string };
}): Promise<PlanArtifact> {
  const { plan, proposal } = params;
  const attempt = plan.nativePlanning;
  const artifact = await loadPlanArtifact(plan.planId, plan.revision);
  if (
    !attempt ||
    !artifact ||
    artifact.conversationKey !== params.conversationKey ||
    artifact.nativePlanning?.attemptId !== attempt.attemptId ||
    artifact.nativePlanning.threadId !== proposal.threadId ||
    (artifact.nativePlanning.turnId !== undefined &&
      artifact.nativePlanning.turnId !== proposal.turnId) ||
    attempt.threadId !== proposal.threadId ||
    attempt.turnId !== proposal.turnId
  ) {
    throw new Error(
      "Codex must prepare execution requirements for this planning attempt before the proposal can be reviewed",
    );
  }
  if (!proposal.text.trim() || !proposal.itemId)
    throw new Error("Codex returned an empty plan proposal");
  if (
    artifact.status === "awaiting_approval" &&
    artifact.nativePlanning.proposal?.itemId === proposal.itemId &&
    artifact.nativePlanning.proposal.markdown === proposal.text
  )
    return artifact;
  return planExecutionCoordinator.updateDraft({
    ...artifact,
    steps: artifact.steps.map((step) => ({
      ...step,
      acceptanceCriteria:
        step.acceptanceCriteria as import("./types").PlanAcceptanceCriterion[],
    })),
    nativePlanning: {
      ...attempt,
      proposal: { itemId: proposal.itemId, markdown: proposal.text },
    },
    ready: true,
  });
}

import type { AgentRuntimeRequest, AgentInvocationPlan } from "../types";

export type ActionPreparation = {
  state: "interpreting" | "resolving" | "needs_input" | "ready" | "unavailable";
  issues: string[];
  sourceSelection?: {
    actionIndex: number;
    question: string;
    candidates: Array<{ id: number; name: string; path: string }>;
  };
};

/** Preparation never grants effects. The executable contract remains the authority. */
export function preparationEffectBlock(
  request: AgentRuntimeRequest,
  plan: AgentInvocationPlan,
): string | null {
  if (plan.impact === "read_only") {
    if (
      request.actionPreparation &&
      request.actionPreparation.state !== "ready"
    ) {
      if (!request.classifiedIntent?.semantic)
        return "Semantic interpretation is unavailable; supporting operations are paused.";
      if (plan.mechanism !== "none")
        return "Preparation permits host-owned reads and clarification, not command or script execution.";
      if (
        plan.domains.includes("network") &&
        (!request.classifiedIntent.externalSearchIntent ||
          request.classifiedIntent.externalSearchIntent === "none")
      ) {
        return "This preparation has no authority for external discovery.";
      }
    }
    return null;
  }
  if (
    request.actionPreparation &&
    request.actionPreparation.state !== "ready"
  ) {
    return "Action targets are unresolved. Resolve the references or ask for the missing information before changing state.";
  }
  if (
    request.actionContract?.version !== 4 ||
    !request.actionContract.intent?.semantic
  ) {
    return "No current semantic action contract authorizes this effect. Legacy contracts are history-only.";
  }
  return null;
}

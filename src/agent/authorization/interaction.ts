import type { AgentActionProposal, AgentRuntimeRequest } from "../types";
import type { ActionInteraction } from "./types";

/** Scope a review preference to the operation and concrete targets it governs. */
export function resolveActionInteraction(
  request: AgentRuntimeRequest,
  proposals: readonly AgentActionProposal[],
  forceReview = false,
): ActionInteraction {
  const preferences = (request.actionContract?.obligations || [])
    .filter((obligation) =>
      proposals.some((proposal) => {
        if (proposal.operation !== obligation.operation) return false;
        const ids =
          obligation.targetBoundary?.frozenTargetIds ||
          (obligation.parameters?.targetNoteId
            ? [obligation.parameters.targetNoteId]
            : []);
        return (
          !ids.length ||
          !proposal.requestedTargets.length ||
          proposal.requestedTargets.some((target) =>
            ids.some((id) => target === `item:${id}`),
          )
        );
      }),
    )
    .map((obligation) => obligation.reviewPreference ?? "default");
  return {
    entryPoint:
      request.actionEntryPoint || (forceReview ? "action_ui" : "conversation"),
    reviewPreference: preferences.includes("review")
      ? "review"
      : preferences.includes("direct")
        ? "direct"
        : "default",
  };
}

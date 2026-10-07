import type { AgentRuntimeUnansweredOutcome } from "../types";

/**
 * The error the throwing `runTurn` contract raises for a turn that ended
 * without an answer: what the run threw, unchanged, or `Error("Aborted")` for
 * a Stop found between model steps, where nothing was thrown.
 */
export function unansweredTurnError(
  outcome: AgentRuntimeUnansweredOutcome,
): unknown {
  if (outcome.cause !== undefined) return outcome.cause;
  return new Error(outcome.kind === "cancelled" ? "Aborted" : outcome.message);
}

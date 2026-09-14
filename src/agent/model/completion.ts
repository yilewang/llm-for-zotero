import type { ModelTurnCompletion } from "../../shared/llm";

export type AgentRecoverableCompletionReason =
  | "output_limit"
  | "provider_pause"
  | "stream_interrupted";

export function resolveAgentRecoverableCompletion(
  completion: ModelTurnCompletion,
): AgentRecoverableCompletionReason | null {
  if (completion.status === "complete") return null;
  const providerDetail = completion.providerReason
    ? ` (${completion.providerReason})`
    : "";
  if (completion.status === "blocked") {
    if (completion.reason === "safety") {
      throw new Error(
        `The provider blocked this model step for safety${providerDetail}.`,
      );
    }
    if (completion.reason === "refusal") {
      throw new Error(`The model refused this agent step${providerDetail}.`);
    }
    if (completion.reason === "malformed_tool_call") {
      throw new Error(
        `The model returned a malformed tool call; it was not executed${providerDetail}.`,
      );
    }
    throw new Error(`The provider blocked this model step${providerDetail}.`);
  }
  if (completion.reason === "context_limit") {
    throw new Error(
      `The model context window was exhausted before this agent step completed${providerDetail}.`,
    );
  }
  return completion.reason;
}

export function buildAgentRecoveryInstruction(
  reason: AgentRecoverableCompletionReason,
  toolNoun: "tool call" | "function call",
): string {
  if (reason === "stream_interrupted") {
    return `The response stream was interrupted before this step completed. Its partial text and tool arguments were discarded and no tool call from that step executed. Resume from the preserved completed results, without repeating completed actions, and emit the next required ${toolNoun} with complete arguments.`;
  }
  return reason === "output_limit"
    ? `The provider stopped at its output limit before completing this step. Continue without repeating completed analysis, and emit the next required ${toolNoun} only after all arguments are complete.`
    : `The provider paused this step. Resume from the preserved state without repeating completed analysis, and emit the next required ${toolNoun} only after all arguments are complete.`;
}

/**
 * Instruction for a final answer (no tool call in flight) that the provider
 * cut off at its output limit. The text already written stays on screen and
 * in the transcript, so the model must only supply the remainder.
 */
export function buildAnswerContinuationInstruction(): string {
  return "Your previous message was cut off by the provider's output limit before the answer was complete. Continue exactly from where it stopped: do not repeat any text already written, do not restart or summarize the answer, and finish it.";
}

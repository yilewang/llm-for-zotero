import {
  callLLMStream,
  type ChatParams,
  type ModelTurnCompletion,
  type ModelTurnOutcome,
  type ReasoningEvent,
  type UsageStats,
} from "../../utils/llmClient";
import { sanitizeText } from "./textUtils";

export const EMPTY_OUTPUT_LIMIT_MESSAGE =
  "The model used its available output on reasoning before producing an answer. Try Continue, lower reasoning effort, or choose another model.";

export function resolveEmptyModelOutcomeMessage(
  completion: ModelTurnCompletion,
): string {
  if (completion.status === "complete") {
    return "The model completed without producing visible text.";
  }
  if (completion.status === "incomplete") {
    if (completion.reason === "output_limit") {
      return EMPTY_OUTPUT_LIMIT_MESSAGE;
    }
    if (completion.reason === "context_limit") {
      return "The response stopped because the model's context window was exhausted. Start a new conversation or reduce the attached context.";
    }
    return "The provider paused this response before producing visible text. Try Continue.";
  }
  if (completion.reason === "safety") {
    return "The provider stopped this response for a safety reason.";
  }
  if (completion.reason === "refusal") {
    return "The model refused this request.";
  }
  if (completion.reason === "malformed_tool_call") {
    return "The model returned an incomplete tool call that was not executed.";
  }
  return "The provider ended the response without usable output.";
}

export function appendContinuationText(
  existingText: string,
  continuationText: string,
): string {
  const existing = sanitizeText(existingText);
  const continuation = sanitizeText(continuationText);
  if (!existing) return continuation;
  if (!continuation) return existing;
  if (continuation.startsWith(existing)) return continuation;
  const maxOverlap = Math.min(existing.length, continuation.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (existing.endsWith(continuation.slice(0, overlap))) {
      return existing + continuation.slice(overlap);
    }
  }
  return existing + continuation;
}

export async function callDirectChatTurnWithRecovery(params: {
  request: ChatParams;
  onDelta: (delta: string) => void;
  onReasoning?: (event: ReasoningEvent) => void;
  onUsage?: (usage: UsageStats) => void;
  call?: typeof callLLMStream;
}): Promise<ModelTurnOutcome> {
  const call = params.call ?? callLLMStream;
  const first = await call(
    params.request,
    params.onDelta,
    params.onReasoning,
    params.onUsage,
  );
  if (
    first.completion.status !== "incomplete" ||
    first.completion.reason !== "output_limit" ||
    first.text.trim()
  ) {
    return first;
  }

  (
    globalThis as typeof globalThis & {
      ztoolkit?: { log?: (...args: unknown[]) => void };
    }
  ).ztoolkit?.log?.("LLM: Recovering empty output-limited direct-chat turn", {
    settingMode: params.request.outputTokenLimit?.mode || "auto",
    providerStopReason: first.completion.providerReason,
    recoveryCount: 1,
  });
  const responseId =
    first.continuationState &&
    typeof first.continuationState === "object" &&
    typeof (first.continuationState as { responseId?: unknown }).responseId ===
      "string"
      ? (first.continuationState as { responseId: string }).responseId
      : undefined;
  const continuationHistory = responseId
    ? undefined
    : [
        ...(params.request.history || []),
        { role: "user" as const, content: params.request.prompt },
      ];
  return call(
    {
      ...params.request,
      prompt:
        "Continue from the prior response. Produce the answer now without repeating prior text.",
      history: continuationHistory,
      ...(responseId
        ? {
            context: undefined,
            attachments: undefined,
            continuationState: { responseId },
          }
        : {}),
    },
    params.onDelta,
    params.onReasoning,
    params.onUsage,
  );
}

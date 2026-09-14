import { getAbortController } from "./apiHelpers";
import { callLLM, type ChatParams } from "./llmClient";
import type { ModelTurnOutcome } from "../shared/llm";

/** Default bound for short, internal model calls. */
export const DEFAULT_LLM_CALL_TIMEOUT_MS = 10_000;

export type LLMCallWithTimeoutParams = Omit<ChatParams, "signal"> & {
  parentSignal?: AbortSignal;
  timeoutMs?: number;
  /** Test seam: replaces callLLM. */
  llmCall?: (chatParams: ChatParams) => Promise<ModelTurnOutcome>;
};

/**
 * Run a bounded model call while preserving the caller's cancellation signal.
 *
 * The Zotero chrome scope does not always expose AbortController, so the timer
 * remains authoritative even when the underlying request cannot be cancelled.
 */
export async function callLLMWithTimeout(
  params: LLMCallWithTimeoutParams,
): Promise<ModelTurnOutcome> {
  const { parentSignal, timeoutMs, llmCall, ...chatParams } = params;
  const budgetMs = timeoutMs || DEFAULT_LLM_CALL_TIMEOUT_MS;
  const createAbortError = () => {
    const error = new Error("LLM call aborted");
    error.name = "AbortError";
    return error;
  };
  if (parentSignal?.aborted) throw createAbortError();
  const AbortControllerCtor = getAbortController();
  const controller = AbortControllerCtor ? new AbortControllerCtor() : null;
  let onAbort: () => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      controller?.abort();
      reject(createAbortError());
    };
  });
  parentSignal?.addEventListener("abort", onAbort!, { once: true });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller?.abort();
      reject(new Error(`LLM call timed out after ${budgetMs}ms`));
    }, budgetMs);
  });
  try {
    const invoke = llmCall || callLLM;
    const call = invoke({
      ...chatParams,
      signal: controller?.signal,
    } as ChatParams);
    // A request may reject after the timeout wins the race. Keep that late
    // rejection handled so a bounded helper never creates an unhandled error.
    call.catch(() => {});
    return await Promise.race([call, timeoutPromise, abortPromise]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    parentSignal?.removeEventListener("abort", onAbort!);
  }
}

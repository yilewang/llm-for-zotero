import { callLLM, type ChatParams } from "./llmClient";

/** Default bound for short, internal model calls. */
export const DEFAULT_LLM_CALL_TIMEOUT_MS = 10_000;

export type LLMCallWithTimeoutParams = Omit<ChatParams, "signal"> & {
  parentSignal?: AbortSignal;
  timeoutMs?: number;
  /** Test seam: replaces callLLM. */
  llmCall?: (chatParams: ChatParams) => Promise<string>;
};

/**
 * Run a bounded model call while preserving the caller's cancellation signal.
 *
 * The Zotero chrome scope does not always expose AbortController, so the timer
 * remains authoritative even when the underlying request cannot be cancelled.
 */
export async function callLLMWithTimeout(
  params: LLMCallWithTimeoutParams,
): Promise<string> {
  const { parentSignal, timeoutMs, llmCall, ...chatParams } = params;
  const budgetMs = timeoutMs || DEFAULT_LLM_CALL_TIMEOUT_MS;
  const AbortControllerCtor = (
    globalThis as { AbortController?: typeof AbortController }
  ).AbortController;
  const controller = AbortControllerCtor ? new AbortControllerCtor() : null;
  const onAbort = () => controller?.abort();
  parentSignal?.addEventListener("abort", onAbort, { once: true });
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
    return await Promise.race([call, timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    parentSignal?.removeEventListener("abort", onAbort);
  }
}

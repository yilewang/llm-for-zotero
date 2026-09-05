import {
  callUtilityLLM,
  describeUtilityLLMFailure,
} from "../../utils/utilityLLM";
import type { ActionExecutionContext } from "./types";

export type ActionLlmBatchOptions = {
  signal?: AbortSignal;
  /**
   * Called once per failed batch so the action can tell the user that part of
   * the page fell back, instead of silently mixing model and deterministic
   * suggestions.
   */
  onBatchError?: (error: unknown, batchIndex: number) => void;
};

/**
 * Run `runBatch` over `items` in batches, keeping whatever completes.
 *
 * Each batch is one bounded model call, so a blank reply or a timeout on one
 * batch says nothing about the batches that already succeeded. Losing their
 * results would turn a single hiccup into "every item on this review page got
 * deterministic suggestions" — the failure is scoped to the batch that caused
 * it. A run in which no batch survives still throws, so the caller's
 * "AI suggestions unavailable" branch keeps handling a real outage.
 */
export async function collectActionLlmBatchResults<TItem, TResult>(
  items: readonly TItem[],
  batchSize: number,
  runBatch: (batch: TItem[]) => Promise<TResult[]>,
  options: ActionLlmBatchOptions = {},
): Promise<TResult[]> {
  const results: TResult[] = [];
  let firstError: unknown;
  let ranABatch = false;
  let batchIndex = 0;
  for (let i = 0; i < items.length; i += batchSize, batchIndex += 1) {
    // Batches run one after another, so a long queue is only cancellable
    // between them. Check here rather than after the loop so a stop lands
    // within one batch instead of at the end of the run.
    if (options.signal?.aborted) break;
    try {
      results.push(...(await runBatch(items.slice(i, i + batchSize))));
      ranABatch = true;
    } catch (error) {
      if (firstError === undefined) firstError = error;
      options.onBatchError?.(error, batchIndex);
    }
  }
  // `ranABatch`, not `results.length`: a batch that legitimately returns no
  // suggestions is a success, and must not be mistaken for an outage.
  if (firstError !== undefined && !ranABatch) throw firstError;
  return results;
}

/**
 * Run one bounded model call on behalf of an action.
 *
 * Throws when the model was reachable but the call failed, so the caller's
 * "AI suggestions unavailable" fallback path runs and the user is told. An
 * empty string means only "no model is configured" — a legitimate state in
 * which actions are expected to fall back to their deterministic behavior.
 */
export async function callActionLlm(params: {
  ctx: ActionExecutionContext;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
}): Promise<string> {
  const { ctx, prompt, maxTokens, timeoutMs } = params;
  if (!ctx.llm) return "";
  const result = await callUtilityLLM({
    prompt,
    model: ctx.llm.model,
    apiBase: ctx.llm.apiBase,
    apiKey: ctx.llm.apiKey,
    authMode: ctx.llm.authMode,
    providerProtocol: ctx.llm.providerProtocol,
    profileOverride: ctx.llm.profileOverride,
    temperature: 0,
    jsonBudget: maxTokens,
    timeoutMs,
    signal: ctx.signal,
    llmCall: ctx.llm.llmCall,
  });
  if (!result.ok) {
    throw new Error(describeUtilityLLMFailure(result));
  }
  return result.text;
}

export function extractJsonArray(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return trimmed;
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return null;
}

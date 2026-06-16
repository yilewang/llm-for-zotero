import { callLLM } from "../../utils/llmClient";
import type { ActionExecutionContext } from "./types";

export async function collectActionLlmBatchResults<TItem, TResult>(
  items: readonly TItem[],
  batchSize: number,
  runBatch: (batch: TItem[]) => Promise<TResult[]>,
): Promise<TResult[]> {
  const results: TResult[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    results.push(...(await runBatch(items.slice(i, i + batchSize))));
  }
  return results;
}

export async function callActionLlm(params: {
  ctx: ActionExecutionContext;
  prompt: string;
  maxTokens: number;
}): Promise<string> {
  const { ctx, prompt, maxTokens } = params;
  if (!ctx.llm) return "";
  return callLLM({
    prompt,
    model: ctx.llm.model,
    apiBase: ctx.llm.apiBase,
    apiKey: ctx.llm.apiKey,
    authMode: ctx.llm.authMode,
    providerProtocol: ctx.llm.providerProtocol,
    temperature: 0,
    maxTokens,
  });
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

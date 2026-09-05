import type { ChatParams } from "../../utils/llmClient";
import type { ProviderProtocol } from "../../utils/providerProtocol";
import {
  callUtilityLLM,
  logUtilityLLMFailure,
  type UtilityLLMParams,
} from "../../utils/utilityLLM";
import type { ModelProfileOverride } from "../../modelCapabilities";

export type LibraryRetrieveTriageCandidate = {
  itemId: string;
  title: string;
  abstract: string;
  matchedVia: string;
};

export type LibraryRetrieveTriageResult = {
  /** Papers to expand into snippets, highest priority first. */
  selectedItemIds: string[];
  /** Optional targeted sub-query per selected paper (what to look for). */
  perPaperQueries?: Record<string, string>;
  /** Optional fresh scope-wide keyword probes when candidates look off. */
  suggestedProbes?: string[];
};

const TRIAGE_TIMEOUT_MS = 10_000;
const TRIAGE_MAX_PROBES = 4;
const TRIAGE_MAX_PER_PAPER_QUERY_CHARS = 160;

function normalizeLine(value: unknown, maxChars: number): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

/**
 * One bounded LLM call that decides which shortlisted papers deserve the
 * snippet-expansion slots and what to look for in each, instead of the blind
 * "first N by lexical score, all searched with the global query" slice.
 * Returns null on ANY failure — callers must keep the lexical ordering then.
 */
export async function triageCandidatesWithModel(params: {
  query: string;
  intent: "enumerate" | "verify" | "summarize";
  candidates: LibraryRetrieveTriageCandidate[];
  maxSelect: number;
  model?: string;
  apiBase?: string;
  apiKey?: string;
  authMode?: ChatParams["authMode"];
  providerProtocol?: ProviderProtocol;
  profileOverride?: ModelProfileOverride;
  signal?: AbortSignal;
  timeoutMs?: number;
  llmCall?: UtilityLLMParams["llmCall"];
}): Promise<LibraryRetrieveTriageResult | null> {
  if (!params.candidates.length) return null;
  if (!params.apiBase && !params.apiKey) return null;
  const knownIds = new Set(params.candidates.map((entry) => entry.itemId));
  const prompt = [
    "Triage candidate papers for a library evidence search.",
    'Return strict JSON only in this shape: {"selectedItemIds":["..."],"perPaperQueries":{"<itemId>":"..."},"suggestedProbes":["..."]}.',
    `Select up to ${params.maxSelect} papers most likely to contain evidence for the question, ordered by priority.`,
    "For each selected paper, optionally give a short targeted sub-query describing what to look for in that specific paper.",
    `Optionally suggest up to ${TRIAGE_MAX_PROBES} new short keyword probes for the whole scope when the candidate list looks off-topic.`,
    "Do not answer the question. Do not invent item ids.",
    "",
    `Question (intent: ${params.intent}): ${params.query}`,
    "",
    "Candidates:",
    ...params.candidates.map((entry) => {
      const header = `- id=${entry.itemId} | ${normalizeLine(entry.title, 160)}${
        entry.matchedVia
          ? ` | matched via: ${normalizeLine(entry.matchedVia, 120)}`
          : ""
      }`;
      const abstract = normalizeLine(entry.abstract, 300);
      return abstract ? `${header}\n  ${abstract}` : header;
    }),
  ].join("\n");
  try {
    const result = await callUtilityLLM({
      prompt,
      model: params.model,
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      authMode: params.authMode,
      providerProtocol: params.providerProtocol,
      profileOverride: params.profileOverride,
      jsonBudget: 400,
      temperature: 0,
      signal: params.signal,
      timeoutMs: params.timeoutMs || TRIAGE_TIMEOUT_MS,
      llmCall: params.llmCall,
      systemMessages: [
        "You are a retrieval triage assistant. Return JSON only. Do not answer the user's question.",
      ],
    });
    if (!result.ok) {
      logUtilityLLMFailure("Retrieval triage skipped", result);
      return null;
    }
    const raw = result.text;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as {
      selectedItemIds?: unknown[];
      perPaperQueries?: Record<string, unknown>;
      suggestedProbes?: unknown[];
    };
    const selectedItemIds = Array.isArray(parsed.selectedItemIds)
      ? parsed.selectedItemIds
          .map((value) => normalizeLine(value, 40))
          .filter((value) => value && knownIds.has(value))
          .slice(0, Math.max(1, params.maxSelect))
      : [];
    if (!selectedItemIds.length) return null;
    const perPaperQueries: Record<string, string> = {};
    if (parsed.perPaperQueries && typeof parsed.perPaperQueries === "object") {
      for (const [itemId, value] of Object.entries(parsed.perPaperQueries)) {
        const normalizedId = normalizeLine(itemId, 40);
        const query = normalizeLine(value, TRIAGE_MAX_PER_PAPER_QUERY_CHARS);
        if (normalizedId && knownIds.has(normalizedId) && query) {
          perPaperQueries[normalizedId] = query;
        }
      }
    }
    const suggestedProbes = Array.isArray(parsed.suggestedProbes)
      ? parsed.suggestedProbes
          .map((value) => normalizeLine(value, 120))
          .filter(Boolean)
          .slice(0, TRIAGE_MAX_PROBES)
      : [];
    return {
      selectedItemIds,
      perPaperQueries: Object.keys(perPaperQueries).length
        ? perPaperQueries
        : undefined,
      suggestedProbes: suggestedProbes.length ? suggestedProbes : undefined,
    };
  } catch {
    return null;
  }
}

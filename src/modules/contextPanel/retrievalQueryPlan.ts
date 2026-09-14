import type { ChatParams } from "../../utils/llmClient";
import type { ProviderProtocol } from "../../utils/providerProtocol";
import {
  callLLMWithTimeout,
  type LLMCallWithTimeoutParams,
} from "../../utils/llmCallTimeout";
import {
  callUtilityLLM,
  describeUtilityLLMFailure,
  logUtilityLLMFailure,
} from "../../utils/utilityLLM";
import type { ModelProfileOverride } from "../../modelCapabilities";
import { tokenizeRetrievalQuery } from "./retrievalTokenizer";
import {
  buildCanonicalReferenceQuery,
  parseDocumentReferences,
  type QueryReference,
} from "../../shared/documentReferences";

export type DocumentReadIntent = "targeted" | "full-once";

export type RetrievalQueryPlan = {
  originalQuery: string;
  variants: string[];
  effectiveQueries: string[];
  lexicalTerms: string[];
  semanticQuery: string;
  variantLimitHit: boolean;
  notes: string[];
  readIntent: DocumentReadIntent;
  references: QueryReference[];
  retrievalPurpose?:
    | "factual"
    | "conceptual"
    | "methodological"
    | "comparative"
    | "citation"
    | "visual"
    | "general";
  quoteAnchorPolicy?: "none" | "verified";
  fullReadTargets?: import("../../shared/fullReadTargetResolver").FullReadTargetSelection;
};

export type DocumentQueryPlan = RetrievalQueryPlan;

export const RETRIEVAL_QUERY_VARIANT_DEFAULT_LIMIT = 6;
export const RETRIEVAL_QUERY_VARIANT_HARD_LIMIT = 8;
const RETRIEVAL_QUERY_VARIANT_MAX_CHARS = 160;
const RETRIEVAL_SEMANTIC_QUERY_MAX_CHARS = 700;
// Generous enough for slower OpenAI-compatible providers to return first
// tokens; the parse-retry loop makes the worst case roughly twice this.
export const RETRIEVAL_QUERY_PLAN_TIMEOUT_MS = 10_000;

function normalizeQueryText(value: unknown, maxChars = 0): string {
  const normalized = `${value ?? ""}`.replace(/\s+/g, " ").trim();
  if (!maxChars || normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars).trim();
}

function normalizeComparableQuery(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function clampVariantLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return RETRIEVAL_QUERY_VARIANT_DEFAULT_LIMIT;
  }
  return Math.max(
    1,
    Math.min(RETRIEVAL_QUERY_VARIANT_HARD_LIMIT, Math.floor(parsed)),
  );
}

function normalizeVariants(params: {
  originalQuery: string;
  variants?: unknown[];
  maxVariants?: number;
}): { variants: string[]; variantLimitHit: boolean } {
  const maxVariants = clampVariantLimit(params.maxVariants);
  const originalComparable = normalizeComparableQuery(params.originalQuery);
  const seen = new Set<string>(originalComparable ? [originalComparable] : []);
  const out: string[] = [];
  let nonEmptyCount = 0;
  for (const value of params.variants || []) {
    const normalized = normalizeQueryText(
      value,
      RETRIEVAL_QUERY_VARIANT_MAX_CHARS,
    );
    if (!normalized) continue;
    nonEmptyCount += 1;
    const comparable = normalizeComparableQuery(normalized);
    if (!comparable || seen.has(comparable)) continue;
    seen.add(comparable);
    if (out.length >= maxVariants) continue;
    out.push(normalized);
  }
  return {
    variants: out,
    variantLimitHit: nonEmptyCount > out.length,
  };
}

function buildSemanticQuery(effectiveQueries: string[]): string {
  const joined = effectiveQueries
    .map((query, index) => (index === 0 ? query : `Variant: ${query}`))
    .filter(Boolean)
    .join("\n");
  return normalizeQueryText(joined, RETRIEVAL_SEMANTIC_QUERY_MAX_CHARS);
}

export function buildRetrievalQueryPlan(params: {
  query: string;
  queryVariants?: unknown[];
  maxVariants?: number;
  notes?: string[];
  readIntent?: DocumentReadIntent;
  references?: QueryReference[];
}): RetrievalQueryPlan {
  const originalQuery = normalizeQueryText(params.query);
  const references =
    params.references || parseDocumentReferences(originalQuery);
  const normalized = normalizeVariants({
    originalQuery,
    variants: [
      ...(params.queryVariants || []),
      ...references.map(buildCanonicalReferenceQuery),
    ],
    maxVariants: params.maxVariants,
  });
  const effectiveQueries = [originalQuery, ...normalized.variants].filter(
    Boolean,
  );
  const lexicalTerms = Array.from(
    new Set(effectiveQueries.flatMap((query) => tokenizeRetrievalQuery(query))),
  );
  const notes = [...(params.notes || [])];
  if (normalized.variantLimitHit) {
    notes.push(
      `Query variants were capped at ${clampVariantLimit(params.maxVariants)}.`,
    );
  }
  if (!normalized.variants.length) {
    notes.push("No query variants were used.");
  }
  return {
    originalQuery,
    variants: normalized.variants,
    effectiveQueries,
    lexicalTerms,
    semanticQuery: buildSemanticQuery(effectiveQueries),
    variantLimitHit: normalized.variantLimitHit,
    notes,
    readIntent: params.readIntent || "targeted",
    references,
  };
}

export function buildRetrievalQueryPlanCacheKey(
  queryPlan: RetrievalQueryPlan,
): string {
  return [queryPlan.originalQuery, ...queryPlan.variants]
    .map((entry) =>
      normalizeComparableQuery(entry)
        .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .join(" || ")
    .slice(0, 300);
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || "",
    trimmed.match(/\{[\s\S]*\}/)?.[0] || "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next extraction shape.
    }
  }
  return null;
}

function isValidPlannerOutput(
  value: Record<string, unknown> | null,
): value is Record<string, unknown> & {
  variants: unknown[];
} {
  return Boolean(
    value &&
    Array.isArray(value.variants) &&
    value.variants.every((variant) => typeof variant === "string"),
  );
}

export function shouldAutoGenerateQueryVariants(params: {
  query: string;
  hasRetrievalContext: boolean;
}): boolean {
  const query = normalizeQueryText(params.query);
  if (!params.hasRetrievalContext || query.length < 4) return false;
  return !/^10\.\d{4,9}\/\S+$/i.test(query);
}

// Kept as a compatibility export for retrieval and focused runtime tests;
// the implementation lives in the dependency-neutral utility layer.
export { callLLMWithTimeout };
export type { LLMCallWithTimeoutParams };

const RETRIEVAL_PROBE_REFORMULATION_TIMEOUT_MS = 6000;

/**
 * Ask the model for fresh corpus-language search probes after a weak
 * quicksearch pass. Any failure degrades to an empty variant list with an
 * explanatory note — callers must treat that as "keep the existing probes".
 */
export async function generateRetrievalProbeReformulation(params: {
  query: string;
  triedProbes: string[];
  matchedProbes: string[];
  scopeTitles: string[];
  model?: string;
  apiBase?: string;
  apiKey?: string;
  authMode?: ChatParams["authMode"];
  providerProtocol?: ProviderProtocol;
  profileOverride?: ModelProfileOverride;
  signal?: AbortSignal;
  timeoutMs?: number;
  llmCall?: LLMCallWithTimeoutParams["llmCall"];
}): Promise<{ variants: string[]; notes: string[] }> {
  const failure = {
    variants: [] as string[],
    notes: ["Probe reformulation failed; kept the existing probes."],
  };
  if (!params.apiBase && !params.apiKey) return failure;
  const scopeTitles = params.scopeTitles
    .map((title) => normalizeQueryText(title, 160))
    .filter(Boolean)
    .slice(0, 8);
  const prompt = [
    "Reformulate library search probes for a Zotero corpus search that found too few matches.",
    'Return strict JSON only in this shape: {"variants":["..."]}.',
    "Propose at most 4 NEW short keyword probes that were not tried before.",
    "Use the corpus language(s) shown by the sample titles, including translations of the query's key terms when languages differ.",
    "Prefer distinctive technical vocabulary over generic words.",
    "",
    `User query: ${params.query}`,
    `Probes already tried: ${params.triedProbes.slice(0, 16).join(" | ") || "none"}`,
    `Probes that matched documents: ${
      params.matchedProbes.slice(0, 8).join(" | ") || "none"
    }`,
    ...(scopeTitles.length
      ? [
          "Sample titles from the search scope:",
          ...scopeTitles.map((title) => `- ${title}`),
        ]
      : []),
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
      jsonBudget: 200,
      temperature: 0,
      signal: params.signal,
      timeoutMs: params.timeoutMs || RETRIEVAL_PROBE_REFORMULATION_TIMEOUT_MS,
      llmCall: params.llmCall,
      systemMessages: [
        "You are a search probe reformulator. Return JSON only. Do not answer the user's question.",
      ],
    });
    if (!result.ok) {
      logUtilityLLMFailure("Probe reformulation skipped", result);
      return failure;
    }
    const raw = result.text;
    const parsed = extractJsonObject(raw);
    const variants = Array.isArray(
      (parsed as { variants?: unknown[] } | null)?.variants,
    )
      ? ((parsed as { variants: unknown[] }).variants || [])
          .map((variant) => normalizeQueryText(variant, 120))
          .filter(Boolean)
          .slice(0, 4)
      : [];
    if (!variants.length) return failure;
    return { variants, notes: [] };
  } catch {
    return failure;
  }
}

export function buildRetrievalPlannerPrompt(params: {
  query: string;
  sourceSamples?: string[];
}): string {
  const sourceSamples = (params.sourceSamples || [])
    .map((sample) => normalizeQueryText(sample, 800))
    .filter(Boolean)
    .slice(0, 3);
  return [
    "Plan document retrieval for a user's Zotero papers.",
    'Return strict JSON only in this shape: {"variants":["..."]}.',
    "Generate search probes, not an answer.",
    "Preserve the user's intent.",
    "Generate variants in the language used by the supplied document samples, including translation when query and source languages differ.",
    "If the user query language differs from the document samples' language, include at least one probe in each language.",
    "Include common acronyms, notation variants, and technical equivalents when useful.",
    "Preserve literal figure and table identifiers exactly.",
    "Avoid broad conceptual drift and do not invent paper-specific claims.",
    `Return at most ${RETRIEVAL_QUERY_VARIANT_DEFAULT_LIMIT} variants.`,
    "",
    `User query: ${params.query}`,
    ...(sourceSamples.length
      ? ["", "Bounded document samples:", ...sourceSamples]
      : []),
  ].join("\n");
}

export async function generateRetrievalQueryPlanWithModel(params: {
  query: string;
  hasRetrievalContext: boolean;
  readIntent?: DocumentReadIntent;
  model?: string;
  apiBase?: string;
  apiKey?: string;
  authMode?: ChatParams["authMode"];
  providerProtocol?: ProviderProtocol;
  profileOverride?: ModelProfileOverride;
  signal?: AbortSignal;
  timeoutMs?: number;
  sourceSamples?: string[];
  llmCall?: LLMCallWithTimeoutParams["llmCall"];
}): Promise<RetrievalQueryPlan> {
  const fallback = buildRetrievalQueryPlan({
    query: params.query,
    readIntent: params.readIntent,
  });
  if (!shouldAutoGenerateQueryVariants(params)) return fallback;
  if (!params.apiBase && !params.apiKey) return fallback;

  const prompt = buildRetrievalPlannerPrompt({
    query: params.query,
    sourceSamples: params.sourceSamples,
  });

  try {
    let parsed: ReturnType<typeof extractJsonObject> = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await callUtilityLLM({
        prompt,
        model: params.model,
        apiBase: params.apiBase,
        apiKey: params.apiKey,
        authMode: params.authMode,
        providerProtocol: params.providerProtocol,
        profileOverride: params.profileOverride,
        jsonBudget: 260,
        temperature: 0,
        signal: params.signal,
        timeoutMs: params.timeoutMs || RETRIEVAL_QUERY_PLAN_TIMEOUT_MS,
        llmCall: params.llmCall,
        systemMessages: [
          "You are a retrieval query planner. Return JSON only. Do not answer the user's research question.",
        ],
      });
      if (!result.ok) {
        // A blank response is exactly what the second attempt exists for —
        // re-prompting often lands the JSON. Every other reason is either
        // terminal or would just burn another timeout.
        if (result.reason === "empty") continue;
        throw new Error(
          `Retrieval planner ${describeUtilityLLMFailure(result)}`,
        );
      }
      const raw = result.text;
      const candidate = extractJsonObject(raw);
      if (isValidPlannerOutput(candidate)) {
        parsed = candidate;
        break;
      }
    }
    if (!isValidPlannerOutput(parsed)) {
      throw new Error("The retrieval planner returned malformed output");
    }
    const variants = Array.isArray(parsed?.variants) ? parsed.variants : [];
    const readIntent = params.readIntent;
    return buildRetrievalQueryPlan({
      query: params.query,
      queryVariants: variants,
      readIntent,
      notes: variants.length
        ? ["Query variants were generated by the retrieval planner."]
        : ["The retrieval planner returned no usable variants."],
    });
  } catch {
    return buildRetrievalQueryPlan({
      query: params.query,
      readIntent: params.readIntent,
      notes: ["Query variant planning failed; used the original query only."],
    });
  }
}

function hasUsableVariants(values: unknown[] | undefined): boolean {
  return (
    Array.isArray(values) && values.some((value) => normalizeQueryText(value))
  );
}

export async function resolveRetrievalQueryPlan(params: {
  query: string;
  queryVariants?: unknown[];
  queryPlan?: RetrievalQueryPlan;
  hasRetrievalContext: boolean;
  readIntent?: DocumentReadIntent;
  model?: string;
  apiBase?: string;
  apiKey?: string;
  authMode?: ChatParams["authMode"];
  providerProtocol?: ProviderProtocol;
  profileOverride?: ModelProfileOverride;
  signal?: AbortSignal;
  timeoutMs?: number;
  sourceSamples?: string[];
  llmCall?: LLMCallWithTimeoutParams["llmCall"];
}): Promise<RetrievalQueryPlan> {
  if (params.queryPlan) return params.queryPlan;
  if (hasUsableVariants(params.queryVariants)) {
    return buildRetrievalQueryPlan({
      query: params.query,
      queryVariants: params.queryVariants,
      readIntent: params.readIntent,
      notes: ["Query variants were provided by the caller."],
    });
  }
  return generateRetrievalQueryPlanWithModel({
    query: params.query,
    hasRetrievalContext: params.hasRetrievalContext,
    readIntent: params.readIntent,
    model: params.model,
    apiBase: params.apiBase,
    apiKey: params.apiKey,
    authMode: params.authMode,
    providerProtocol: params.providerProtocol,
    profileOverride: params.profileOverride,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    sourceSamples: params.sourceSamples,
    llmCall: params.llmCall,
  });
}

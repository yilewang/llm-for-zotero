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
import {
  excludesEnglishFullRead,
  hasJapaneseFullReadNegation,
  hasKoreanFullReadNegation,
  isAffirmativeFullReadCommandAt,
} from "../../shared/fullReadIntentPolarity";

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
    readIntent:
      params.readIntent ||
      (detectExplicitFullReadIntent(originalQuery) ? "full-once" : "targeted"),
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
  readIntent: DocumentReadIntent;
  variants: unknown[];
} {
  return Boolean(
    value &&
    (value.readIntent === "targeted" || value.readIntent === "full-once") &&
    Array.isArray(value.variants) &&
    value.variants.every((variant) => typeof variant === "string"),
  );
}

function isLikelyExactLookupQuery(query: string): boolean {
  const lower = query.toLocaleLowerCase();
  if (/\b10\.\d{4,9}\/[-._;()/:a-z0-9]+\b/i.test(query)) return true;
  if (/\b(?:doi|pmid|pmcid|isbn|issn|arxiv|citation key)\b/.test(lower)) {
    return true;
  }
  if (
    /\b(?:exact phrase|literal phrase|verbatim|exact quote|quote exactly)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  if (
    /\b(?:title|author)\b/.test(lower) &&
    /\b(?:find|lookup|look up|search|open|locate)\b/.test(lower)
  ) {
    return true;
  }
  return false;
}

/**
 * Conservative local fallback for explicit full-reading commands.
 * The model planner remains the primary multilingual classifier when configured.
 */
function selectorTreatsDocumentAsContainer(selector: string): boolean {
  const trimmed = selector.trim();
  if (
    /\b(?:about|across|for|from|in|of|throughout)\s+(?:(?:the|this|that)\s*)?$/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  return /\b(?:analysis|argument|assessment|comparison|critique|description|discussion|explanation|interpretation|list|overview|review|summary)\b[^;.!?。！？；\n]{0,48}\b(?:about|across|for|from|in|of|throughout)\s+(?:(?:a|an|the|this|that)\s+[\p{L}\p{N}'’ -]+|[\p{L}][\p{L}-]*['’]s)$/iu.test(
    trimmed,
  );
}

function hasCompoundNounAfterDocument(value: string): boolean {
  if (/^\s*['’]s\b/u.test(value)) return true;
  const firstWord = value.match(/^\s*([\p{L}\p{N}_-]+)/u)?.[1] || "";
  if (!firstWord) return false;
  if (
    /^(?:after|again|and|before|beforehand|by|called|cover|first|focusing|focussing|for|from|in|next|now|of|once|please|then|titled|to|when|while|with)$/i.test(
      firstWord,
    )
  ) {
    return false;
  }
  return !/ly$/i.test(firstWord);
}

function hasEnglishFullDocumentModifierIntent(normalized: string): boolean {
  const commandPattern =
    /\b(?:read|use|analy[sz]e|review|process|send|provide)\b[^;.!?。！？；\n]{0,64}?\b(?:the\s+)?(entire|whole|complete|full)\b/gi;
  for (const match of normalized.matchAll(commandPattern)) {
    if (!isAffirmativeFullReadCommandAt(normalized, match.index || 0)) continue;
    if (excludesEnglishFullRead(match[0])) continue;
    const tail = normalized
      .slice((match.index || 0) + match[0].length)
      .split(/[;.!?。！？；\n]/, 1)[0]
      .slice(0, 80);
    const documentMatch = tail.match(
      /\b(?:papers?|articles?|documents?|texts?|pdfs?)\b/i,
    );
    if (!documentMatch || documentMatch.index === undefined) continue;
    if (
      match[1]?.toLocaleLowerCase() === "full" &&
      /^texts?$/i.test(documentMatch[0])
    ) {
      // "Full text" selects document evidence. It does not by itself ask to
      // process every chunk of the document.
      continue;
    }
    const selector = tail.slice(0, documentMatch.index);
    if (selectorTreatsDocumentAsContainer(selector)) continue;
    const afterDocument = tail.slice(
      documentMatch.index + documentMatch[0].length,
    );
    if (hasCompoundNounAfterDocument(afterDocument)) continue;
    return true;
  }
  return false;
}

function hasEnglishDocumentSuffixIntent(normalized: string): boolean {
  const commandPattern =
    /\b(?:read|use|analy[sz]e|review|process|send|provide)\b([^;.!?。！？；\n]{0,96}?)\b(papers?|articles?|documents?|texts?|pdfs?)\b/gi;
  for (const match of normalized.matchAll(commandPattern)) {
    if (!isAffirmativeFullReadCommandAt(normalized, match.index || 0)) continue;
    if (excludesEnglishFullRead(match[1] || "")) continue;
    if (selectorTreatsDocumentAsContainer(match[1] || "")) continue;
    const afterDocument = normalized
      .slice((match.index || 0) + match[0].length)
      .split(/[;.!?。！？；\n]/, 1)[0]
      .slice(0, 64);
    const completeness = afterDocument.match(
      /\b(?:in\s+(?:its\s+)?entirety|in\s+full|completely|fully|cover\s+to\s+cover|from\s+start\s+to\s+finish)\b/i,
    );
    if (!completeness || completeness.index === undefined) continue;
    const beforeCompleteness = afterDocument.slice(0, completeness.index);
    if (/^\s*['’]s\b/u.test(beforeCompleteness)) continue;
    const isNumberedPaperList =
      /^\s*(?:numbers?\s+)?\d{1,2}(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)\d{1,2})+\s*$/i.test(
        beforeCompleteness,
      );
    if (
      beforeCompleteness.trim() &&
      !/^\s*(?:by|called|from|titled)\b/i.test(beforeCompleteness) &&
      !isNumberedPaperList
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function hasEnglishEveryDocumentUnitIntent(normalized: string): boolean {
  const pattern =
    /\b(?:read|use|analy[sz]e|review|process)\b[^;.!?。！？；\n]{0,48}\bevery\s+(?:section|page)\b([^;.!?。！？；\n]*)/gi;
  for (const match of normalized.matchAll(pattern)) {
    if (!isAffirmativeFullReadCommandAt(normalized, match.index || 0)) continue;
    if (excludesEnglishFullRead(match[0])) continue;
    const scope = (match[1] || "").trim();
    if (!scope) return true;
    if (
      /^of\s+(?:(?:a|the|this|that)\s+)?(?:paper|article|document|pdf)\b/i.test(
        scope,
      )
    ) {
      return true;
    }
  }
  return false;
}

function hasEnglishLeadingCompletenessIntent(normalized: string): boolean {
  const leading = normalized.match(
    /\b(?:completely|fully)\s+(?:read|use|analy[sz]e|review|process)\b[^;.!?。！？；\n]{0,48}\b(?:it|papers?|articles?|documents?|pdfs?)\b/i,
  );
  if (
    leading &&
    isAffirmativeFullReadCommandAt(normalized, leading.index || 0)
  ) {
    return !excludesEnglishFullRead(leading[0]);
  }
  const pronoun = normalized.match(
    /\bread\s+it\s+(?:completely|fully|cover\s+to\s+cover|from\s+start\s+to\s+finish)\b/i,
  );
  return Boolean(
    pronoun && isAffirmativeFullReadCommandAt(normalized, pronoun.index || 0),
  );
}

function hasChineseFullDocumentIntent(normalized: string): boolean {
  const pattern =
    /(?:通读[^。！？；\n]{0,32}?(?:(?:整篇|完整|全部)(?:的)?)?(?:论文|文章|文档|全文)|(?:完整|全部)阅读[^。！？；\n]{0,32}?(?:论文|文章|文档|全文)|阅读(?:完整|全部)(?:的)?[^。！？；\n]{0,32}?(?:论文|文章|文档)|阅读(?:这|该|当前)?(?:篇)?(?:论文|文章|文档)(?:的)?(?:完整|全部)(?:内容|全文)|阅读(?:完整|全部)?全文|阅读全文|分析全文|使用全文|发送全文)/gu;
  for (const match of normalized.matchAll(pattern)) {
    if (!isAffirmativeFullReadCommandAt(normalized, match.index || 0)) continue;
    const tail = normalized.slice((match.index || 0) + match[0].length);
    if (/^(?:的)?(?:摘要|结论|方法|讨论|引言|结果|部分|章节)/u.test(tail)) {
      continue;
    }
    return true;
  }
  const startToFinishPattern =
    /(?:从头到尾[^。！？；\n]{0,16}?(?:阅读|通读)|(?:阅读|通读)[^。！？；\n]{0,16}?从头到尾)/gu;
  for (const match of normalized.matchAll(startToFinishPattern)) {
    if (isAffirmativeFullReadCommandAt(normalized, match.index || 0)) {
      return true;
    }
  }
  return false;
}

function hasJapaneseFullDocumentIntent(normalized: string): boolean {
  const pattern =
    /(?:全文|(?:論文|記事|文書)[^。！？；\n]{0,16}(?:全文|全体))([^。！？；\n]{0,20}?)(?:読む|読んで|分析)/gu;
  for (const match of normalized.matchAll(pattern)) {
    if (!isAffirmativeFullReadCommandAt(normalized, match.index || 0)) continue;
    const clause = normalized.slice(
      match.index || 0,
      (match.index || 0) + match[0].length + 32,
    );
    if (hasJapaneseFullReadNegation(clause)) continue;
    if (/(?:要約|概要|抄録|結論|方法|議論|序論|結果)/u.test(match[1] || "")) {
      continue;
    }
    return true;
  }
  const startToFinishPattern =
    /(?:最初から最後まで[^。！？\n]{0,12}(?:読む|読んで)|(?:読む|読んで)[^。！？\n]{0,12}最初から最後まで)/gu;
  for (const match of normalized.matchAll(startToFinishPattern)) {
    const clause = normalized.slice(
      match.index || 0,
      (match.index || 0) + match[0].length + 32,
    );
    if (
      isAffirmativeFullReadCommandAt(normalized, match.index || 0) &&
      !hasJapaneseFullReadNegation(clause)
    ) {
      return true;
    }
  }
  return false;
}

function hasKoreanFullDocumentIntent(normalized: string): boolean {
  const pattern =
    /(?:전문|(?:논문|문서|기사)[^.!?\n]{0,16}(?:전문|전체))([^.!?\n]{0,20}?)(?:읽|분석)/gu;
  for (const match of normalized.matchAll(pattern)) {
    if (!isAffirmativeFullReadCommandAt(normalized, match.index || 0)) continue;
    if (/(?:요약|초록|결론|방법|토론|서론|결과)/u.test(match[1] || "")) {
      continue;
    }
    const clause = normalized.slice(
      match.index || 0,
      (match.index || 0) + match[0].length + 24,
    );
    if (hasKoreanFullReadNegation(clause)) continue;
    return true;
  }
  const startToFinishPattern =
    /(?:처음부터\s*끝까지[^.!?\n]{0,12}읽|읽[^.!?\n]{0,12}처음부터\s*끝까지)/gu;
  for (const match of normalized.matchAll(startToFinishPattern)) {
    if (!isAffirmativeFullReadCommandAt(normalized, match.index || 0)) continue;
    const clause = normalized.slice(
      match.index || 0,
      (match.index || 0) + match[0].length + 16,
    );
    if (hasKoreanFullReadNegation(clause)) continue;
    return true;
  }
  return false;
}

export function detectExplicitFullReadIntent(query: string): boolean {
  const normalized = normalizeQueryText(query).toLocaleLowerCase();
  if (!normalized) return false;
  return (
    hasEnglishFullDocumentModifierIntent(normalized) ||
    hasEnglishDocumentSuffixIntent(normalized) ||
    hasEnglishEveryDocumentUnitIntent(normalized) ||
    hasEnglishLeadingCompletenessIntent(normalized) ||
    hasChineseFullDocumentIntent(normalized) ||
    hasJapaneseFullDocumentIntent(normalized) ||
    hasKoreanFullDocumentIntent(normalized)
  );
}

export type PaperEvidenceSource =
  | "metadata"
  | "document_text"
  | "rendered_pages";

export type PaperReadCoverage = "overview" | "targeted" | "exhaustive";

export type PaperReadIntent = Readonly<{
  source: PaperEvidenceSource;
  coverage: PaperReadCoverage;
}>;

/**
 * Keep the requested evidence source independent from how comprehensively the
 * document should be processed. In particular, "full text" means document
 * evidence, not an exhaustive read.
 */
export function classifyPaperReadIntent(query: string): PaperReadIntent {
  const normalized = normalizeQueryText(query).toLocaleLowerCase();
  const source: PaperEvidenceSource =
    /\b(?:rendered?\s+(?:pdf\s+)?pages?|page\s+(?:layout|image|render|screenshot)|(?:layout|image|render|screenshot)\s+of\s+(?:pdf\s+)?pages?|pdf\s+(?:layout|render|screenshot))\b/i.test(
      normalized,
    )
      ? "rendered_pages"
      : /\b(?:metadata|bibliographic|catalog)\b/i.test(normalized) &&
          !/\b(?:pdf|full[-\s]?text|paper\s+text|document\s+text)\b/i.test(
            normalized,
          )
        ? "metadata"
        : "document_text";
  const coverage: PaperReadCoverage = detectExplicitFullReadIntent(normalized)
    ? "exhaustive"
    : /\b(?:summari[sz]e|summary|overview|main\s+(?:message|points?)|key\s+points?)\b/i.test(
          normalized,
        )
      ? "overview"
      : "targeted";
  return { source, coverage };
}

export function reconcilePlannerReadIntent(
  query: string,
  plannedIntent: DocumentReadIntent,
): DocumentReadIntent {
  return plannedIntent === "full-once" && detectExplicitFullReadIntent(query)
    ? "full-once"
    : "targeted";
}

export function shouldAutoGenerateQueryVariants(params: {
  query: string;
  hasRetrievalContext: boolean;
}): boolean {
  const query = normalizeQueryText(params.query);
  if (!params.hasRetrievalContext || query.length < 4) return false;
  return !isLikelyExactLookupQuery(query);
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
    'Return strict JSON only in this shape: {"readIntent":"targeted|full-once","variants":["..."]}.',
    "Generate search probes, not an answer.",
    "Preserve the user's intent.",
    'Use readIntent "full-once" only when the user explicitly asks to read, use, analyze, or send the complete document.',
    "Keep readIntent targeted when complete, entire, or whole describes an explanation, mechanism, argument, figure, table, section, or other requested answer rather than the document itself.",
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
  const fallback = buildRetrievalQueryPlan({ query: params.query });
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
    const readIntent = reconcilePlannerReadIntent(
      params.query,
      parsed.readIntent,
    );
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
      notes: ["Query variants were provided by the caller."],
    });
  }
  return generateRetrievalQueryPlanWithModel({
    query: params.query,
    hasRetrievalContext: params.hasRetrievalContext,
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

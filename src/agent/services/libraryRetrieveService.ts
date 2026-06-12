import { buildPaperRetrievalCandidates } from "../../modules/contextPanel/pdfContext";
import {
  buildRetrievalQueryPlan,
  resolveRetrievalQueryPlan,
  type RetrievalQueryPlan,
} from "../../modules/contextPanel/retrievalQueryPlan";
import type {
  PaperContextCandidate,
  PdfContext,
} from "../../modules/contextPanel/types";
import type { AgentRuntimeRequest } from "../types";
import type {
  PaperContextRef,
  QuoteCitation,
  TagContextRef,
} from "../../shared/types";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../modules/contextPanel/paperAttribution";
import {
  buildQuoteCitation,
  mergeQuoteCitations,
} from "../../modules/contextPanel/quoteCitations";
import type {
  AgentLibraryFilters,
  EditableArticleMetadataSnapshot,
  LibraryItemTarget,
  ZoteroGateway,
} from "./zoteroGateway";
import type { PdfService } from "./pdfService";

export type LibraryRetrieveDepth = "pool" | "metadata" | "evidence" | "verify";
export type LibraryRetrieveIntent =
  | "enumerate"
  | "verify"
  | "summarize";
export type LibraryRetrieveMethod =
  | "metadata"
  | "abstract"
  | "exact"
  | "fts"
  | "semantic";

export type LibraryRetrieveScopeInput = {
  libraryID?: number;
  collectionIds?: number[];
  tagNames?: string[];
  tagScopes?: Array<"allTagged" | "untagged">;
  includeAutomaticTags?: boolean;
  itemIds?: number[];
};

export type LibraryRetrieveInput = {
  scope?: LibraryRetrieveScopeInput;
  query: string;
  queryVariants?: string[];
  /** "discover" is accepted only for legacy callers and normalizes to "enumerate". */
  intent?: LibraryRetrieveIntent | "discover";
  depth?: LibraryRetrieveDepth;
  methods?: LibraryRetrieveMethod[];
  maxMetadataItems?: number;
  maxCandidatePapers?: number;
  /** Deprecated alias for maxSnippetPapers. */
  maxFullTextPapers?: number;
  maxSnippetPapers?: number;
  perPaperTopK?: number;
  maxTotalSnippets?: number;
  requireExact?: boolean;
};

export type LibraryRetrieveResourceState =
  | "available"
  | "metadata_loaded"
  | "text_available"
  | "text_indexed"
  | "unsupported";

export type LibraryRetrieveQueryState =
  | "matched_metadata"
  | "shortlisted"
  | "content_loaded"
  | "snippet_returned"
  | "evidence_used";

export type LibraryRetrieveSourceKind =
  | "metadata"
  | "abstract"
  | "pdf_text"
  | "mineru"
  | "note"
  | "attachment";

export type LibraryRetrieveMatchMethod =
  | "metadata"
  | "exact"
  | "fts"
  | "bm25"
  | "semantic";

export type LibraryRetrieveMatchBasis =
  | "metadata"
  | "abstract"
  | "indexed_text"
  | "chunk_text"
  | "semantic";

export type LibraryRetrievePaperMatchStatus =
  | "strong"
  | "possible"
  | "weak"
  | "semantic_only"
  | "mentions_only"
  | "not_enough_evidence";

export type LibraryRetrieveCoverageStatus = "complete" | "partial" | "none";
export type LibraryRetrieveSnippetCoverageStatus = "sampled" | "expanded";

export type LibraryRetrievePaperMatch = {
  itemId: string;
  title: string;
  matchStatus: LibraryRetrievePaperMatchStatus;
  basis: LibraryRetrieveMatchBasis[];
  returnedSnippetCount: number;
  confidence: "high" | "medium" | "low";
  whyMatched: string;
  matchedQueryVariants?: string[];
};

export type LibraryRetrieveFrontier = {
  needsSnippetExpansion: string[];
  needsCloseRead: string[];
  suggestedNextQueries: string[];
  stopReason:
    | "enough_evidence"
    | "needs_more_specific_query"
    | "budget_limit"
    | "unreadable_sources";
};

export type LibraryRetrieveAnswerContract = {
  metadataCoverage: Extract<
    LibraryRetrieveCoverageStatus,
    "complete" | "partial"
  >;
  indexedTextCoverage: LibraryRetrieveCoverageStatus;
  snippetCoverage: LibraryRetrieveSnippetCoverageStatus;
  safeClaims: string[];
  unsafeClaims: string[];
};

export type LibraryRetrieveCandidate = {
  itemId: string;
  title: string;
  year?: string;
  creators?: string[];
  resourceState: LibraryRetrieveResourceState[];
  queryState: LibraryRetrieveQueryState[];
  score: number;
  whyMatched: string;
  matchedQueryVariants?: string[];
};

export type LibraryRetrieveSnippet = {
  snippetId: string;
  itemId: string;
  contextItemId?: string;
  chunkIndex?: number;
  title: string;
  citationLabel?: string;
  sourceLabel?: string;
  sourceKind: LibraryRetrieveSourceKind;
  matchMethod: LibraryRetrieveMatchMethod;
  sectionLabel?: string;
  pageLabel?: string;
  charStart?: number;
  charEnd?: number;
  quoteCitationId?: string;
  snippet: string;
  surroundingText?: string;
  score: number;
  whyMatched: string;
  matchedQueryVariant?: string;
};

export type LibraryRetrieveResult = {
  queryPlan: RetrievalQueryPlan;
  resourcePool: {
    type: "library" | "collection" | "tag" | "mixed" | "items";
    name?: string;
    scope: {
      libraryID?: number;
      collectionIds?: number[];
      tagNames?: string[];
      tagScopes?: Array<"allTagged" | "untagged">;
      itemIds?: number[];
    };
    totalItems: number;
    states: {
      available: number;
      metadataLoaded: number;
      textAvailable: number;
      textIndexed: number;
      unsupported: number;
    };
    queryCoverage: {
      metadataInspected: number;
      abstractsInspected: number;
      matchedMetadata: number;
      shortlisted: number;
      indexedTextAvailable: number;
      indexedTextScanned: number;
      indexedTextMatched: number;
      snippetPapersExpanded: number;
      /** Deprecated compatibility alias for snippetPapersExpanded. */
      fullTextSearched: number;
      snippetsReturned: number;
      evidencePapers: number;
      deepReadPapers: number;
    };
  };
  intent: LibraryRetrieveIntent;
  depth: LibraryRetrieveDepth;
  methodsUsed: LibraryRetrieveMethod[];
  candidates: LibraryRetrieveCandidate[];
  paperMatches: LibraryRetrievePaperMatch[];
  frontier: LibraryRetrieveFrontier;
  answerContract: LibraryRetrieveAnswerContract;
  snippets: LibraryRetrieveSnippet[];
  quoteCitations?: QuoteCitation[];
  warnings: string[];
};

export const LIBRARY_RETRIEVE_DEFAULT_BUDGETS = {
  maxMetadataItems: 500,
  maxCollectionMetadataItems: 2000,
  maxCandidatePapers: 80,
  maxEnumerateCandidatePapers: 200,
  maxFullTextPapers: 30,
  perPaperTopK: 3,
  maxTotalSnippets: 80,
} as const;

export const LIBRARY_RETRIEVE_HARD_CAPS = {
  maxMetadataItems: 5000,
  maxCandidatePapers: 200,
  maxFullTextPapers: 100,
  perPaperTopK: 5,
  maxTotalSnippets: 200,
} as const;

function buildSnippetQuoteCitation(
  snippet: LibraryRetrieveSnippet,
): QuoteCitation | undefined {
  const itemId = Number(snippet.itemId);
  const contextItemId = Number(snippet.contextItemId);
  if (
    !Number.isFinite(itemId) ||
    itemId <= 0 ||
    !Number.isFinite(contextItemId) ||
    contextItemId <= 0
  ) {
    return undefined;
  }
  const citationLabel = snippet.sourceLabel || snippet.citationLabel;
  return buildQuoteCitation({
    quoteText: snippet.snippet,
    citationLabel,
    contextItemId,
    itemId,
  });
}

function attachQuoteCitationsToSnippets(
  snippets: LibraryRetrieveSnippet[],
): {
  snippets: LibraryRetrieveSnippet[];
  quoteCitations: QuoteCitation[];
} {
  const quoteCitations: QuoteCitation[] = [];
  const pairedSnippets = snippets.map((snippet) => {
    const citation = buildSnippetQuoteCitation(snippet);
    if (!citation) return snippet;
    quoteCitations.push(citation);
    return {
      ...snippet,
      quoteCitationId: citation.id,
    };
  });
  return {
    snippets: pairedSnippets,
    quoteCitations: mergeQuoteCitations(quoteCitations),
  };
}

type NormalizedLibraryRetrieveInput = Required<
  Pick<
    LibraryRetrieveInput,
    | "query"
    | "depth"
    | "methods"
    | "maxMetadataItems"
    | "maxCandidatePapers"
    | "maxFullTextPapers"
    | "perPaperTopK"
    | "maxTotalSnippets"
  >
> & {
  scope?: LibraryRetrieveScopeInput;
  queryVariants: string[];
  queryPlan: RetrievalQueryPlan;
  intent: LibraryRetrieveIntent;
  requireExact: boolean;
};

type ScopeResolution = {
  type: "library" | "collection" | "tag" | "mixed" | "items";
  name?: string;
  libraryID: number;
  collectionIds: number[];
  tagContexts: TagContextRef[];
  tagItemIds: number[];
  explicitItemIds: number[];
  items: LibraryItemTarget[];
  totalItems: number;
  warnings: string[];
};

type ResourceRecord = {
  target: LibraryItemTarget;
  metadata: EditableArticleMetadataSnapshot | null;
  abstractText: string;
  creators: string[];
  paperContext: PaperContextRef | null;
  resourceState: Set<LibraryRetrieveResourceState>;
  queryState: Set<LibraryRetrieveQueryState>;
  metadataScore: number;
  ftsScore: number;
  quicksearchMatched: boolean;
  matchedQueryVariants: Set<string>;
  score: number;
  why: string[];
};

type IndexedTextScanResult = {
  available: number;
  scanned: number;
  matched: number;
  truncated: boolean;
};

type CandidateBuilder = typeof buildPaperRetrievalCandidates;

const DEFAULT_METHODS: LibraryRetrieveMethod[] = [
  "metadata",
  "abstract",
  "exact",
  "fts",
  "semantic",
];

const DEFAULT_INTENT: LibraryRetrieveIntent = "enumerate";

function clampBudget(
  value: unknown,
  fallback: number,
  hardCap: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(hardCap, Math.floor(parsed)));
}

function dedupeNumbers(values: number[] | undefined): number[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.floor(value)),
    ),
  );
}

function normalizeIntent(
  value: unknown,
  depth: LibraryRetrieveDepth,
  query: string,
): LibraryRetrieveIntent {
  if (
    value === "enumerate" ||
    value === "verify" ||
    value === "summarize"
  ) {
    return value;
  }
  if (value === "discover") return "enumerate";
  if (depth === "verify") return "verify";
  const normalized = query.toLowerCase();
  if (
    /\b(?:all|which|how many|list|enumerate|papers?\s+that|contain|contains|containing|use|uses|using|discuss|discusses|mention|mentions)\b/.test(
      normalized,
    )
  ) {
    return "enumerate";
  }
  if (
    /\b(?:summari[sz]e|summary|taxonomy|methods?|themes?|comprehensive|overview)\b/.test(
      normalized,
    )
  ) {
    return "summarize";
  }
  return DEFAULT_INTENT;
}

function hasCollectionLikeScope(
  input: LibraryRetrieveInput,
  request?: AgentRuntimeRequest,
): boolean {
  if (
    input.scope?.collectionIds?.length ||
    input.scope?.tagNames?.length ||
    input.scope?.tagScopes?.length ||
    input.scope?.itemIds?.length
  ) {
    return true;
  }
  return Boolean(
    request?.selectedCollectionContexts?.length ||
      request?.selectedTagContexts?.length,
  );
}

function normalizeInput(
  input: LibraryRetrieveInput,
  request?: AgentRuntimeRequest,
  queryPlan?: RetrievalQueryPlan,
): NormalizedLibraryRetrieveInput {
  const depth: LibraryRetrieveDepth =
    input.depth === "pool" ||
    input.depth === "metadata" ||
    input.depth === "verify" ||
    input.depth === "evidence"
      ? input.depth
      : "evidence";
  const methods =
    Array.isArray(input.methods) && input.methods.length
      ? Array.from(
          new Set(
            input.methods.filter((method): method is LibraryRetrieveMethod =>
              DEFAULT_METHODS.includes(method as LibraryRetrieveMethod),
            ),
          ),
        )
      : DEFAULT_METHODS;
  const intent = normalizeIntent(input.intent, depth, input.query);
  const collectionLikeScope = hasCollectionLikeScope(input, request);
  const comprehensiveIntent =
    intent === "enumerate" || intent === "verify" || intent === "summarize";
  const effectiveQueryPlan =
    queryPlan ||
    buildRetrievalQueryPlan({
      query: input.query.trim(),
      queryVariants: input.queryVariants,
    });
  return {
    scope: input.scope,
    query: input.query.trim(),
    queryVariants: effectiveQueryPlan.variants,
    queryPlan: effectiveQueryPlan,
    intent,
    depth,
    methods,
    maxMetadataItems: clampBudget(
      input.maxMetadataItems,
      comprehensiveIntent
        ? LIBRARY_RETRIEVE_HARD_CAPS.maxMetadataItems
        : collectionLikeScope
          ? LIBRARY_RETRIEVE_DEFAULT_BUDGETS.maxCollectionMetadataItems
          : LIBRARY_RETRIEVE_DEFAULT_BUDGETS.maxMetadataItems,
      LIBRARY_RETRIEVE_HARD_CAPS.maxMetadataItems,
    ),
    maxCandidatePapers: clampBudget(
      input.maxCandidatePapers,
      comprehensiveIntent
        ? LIBRARY_RETRIEVE_DEFAULT_BUDGETS.maxEnumerateCandidatePapers
        : LIBRARY_RETRIEVE_DEFAULT_BUDGETS.maxCandidatePapers,
      LIBRARY_RETRIEVE_HARD_CAPS.maxCandidatePapers,
    ),
    maxFullTextPapers: clampBudget(
      input.maxSnippetPapers ?? input.maxFullTextPapers,
      comprehensiveIntent
        ? LIBRARY_RETRIEVE_HARD_CAPS.maxFullTextPapers
        : LIBRARY_RETRIEVE_DEFAULT_BUDGETS.maxFullTextPapers,
      LIBRARY_RETRIEVE_HARD_CAPS.maxFullTextPapers,
    ),
    perPaperTopK: clampBudget(
      input.perPaperTopK,
      LIBRARY_RETRIEVE_DEFAULT_BUDGETS.perPaperTopK,
      LIBRARY_RETRIEVE_HARD_CAPS.perPaperTopK,
    ),
    maxTotalSnippets: clampBudget(
      input.maxTotalSnippets,
      depth === "verify"
        ? 120
        : comprehensiveIntent
          ? LIBRARY_RETRIEVE_HARD_CAPS.maxTotalSnippets
          : LIBRARY_RETRIEVE_DEFAULT_BUDGETS.maxTotalSnippets,
      LIBRARY_RETRIEVE_HARD_CAPS.maxTotalSnippets,
    ),
    requireExact:
      input.requireExact === true || depth === "verify" || intent === "verify",
  };
}

function normalizeText(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim();
}

function normalizeForSearch(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

function creatorLabel(creator: {
  name?: string;
  firstName?: string;
  lastName?: string;
}): string {
  return (
    normalizeText(creator.name) ||
    [normalizeText(creator.firstName), normalizeText(creator.lastName)]
      .filter(Boolean)
      .join(" ")
      .trim()
  );
}

function scoreField(params: {
  fieldName: string;
  text: string;
  queryPlan: RetrievalQueryPlan;
  phraseWeight: number;
  termWeight: number;
}): { score: number; why: string[]; matchedQueryVariants: string[] } {
  const haystack = normalizeForSearch(params.text);
  if (!haystack) return { score: 0, why: [], matchedQueryVariants: [] };
  const why: string[] = [];
  const matchedQueryVariants = new Set<string>();
  let score = 0;
  for (const query of params.queryPlan.effectiveQueries) {
    const normalizedQuery = normalizeForSearch(query);
    if (normalizedQuery.length > 2 && haystack.includes(normalizedQuery)) {
      score += params.phraseWeight;
      matchedQueryVariants.add(query);
      why.push(`${params.fieldName} phrase match: ${query}`);
    }
  }
  const matchedTerms = params.queryPlan.lexicalTerms.filter((term) =>
    haystack.includes(term),
  );
  if (matchedTerms.length) {
    score += matchedTerms.length * params.termWeight;
    for (const query of params.queryPlan.effectiveQueries) {
      const queryTerms = query
        .toLowerCase()
        .match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu);
      if (queryTerms?.some((term) => haystack.includes(term))) {
        matchedQueryVariants.add(query);
      }
    }
    why.push(
      `${params.fieldName} keyword match: ${matchedTerms.slice(0, 5).join(", ")}`,
    );
  }
  return { score, why, matchedQueryVariants: Array.from(matchedQueryVariants) };
}

function scoreMetadata(params: {
  target: LibraryItemTarget;
  metadata: EditableArticleMetadataSnapshot | null;
  abstractText: string;
  creators: string[];
  queryPlan: RetrievalQueryPlan;
}): { score: number; why: string[]; matchedQueryVariants: string[] } {
  const fields = params.metadata?.fields || ({} as Record<string, string>);
  const parts = [
    scoreField({
      fieldName: "title",
      text: params.target.title,
      queryPlan: params.queryPlan,
      phraseWeight: 10,
      termWeight: 3,
    }),
    scoreField({
      fieldName: "abstract",
      text: params.abstractText,
      queryPlan: params.queryPlan,
      phraseWeight: 7,
      termWeight: 1.4,
    }),
    scoreField({
      fieldName: "tags",
      text: params.target.tags.join(" "),
      queryPlan: params.queryPlan,
      phraseWeight: 6,
      termWeight: 2,
    }),
    scoreField({
      fieldName: "creators",
      text: params.creators.join(" "),
      queryPlan: params.queryPlan,
      phraseWeight: 3,
      termWeight: 0.8,
    }),
    scoreField({
      fieldName: "venue/extra metadata",
      text: [
        fields.publicationTitle,
        fields.proceedingsTitle,
        fields.extra,
        fields.DOI,
        fields.date,
      ].join(" "),
      queryPlan: params.queryPlan,
      phraseWeight: 3,
      termWeight: 0.7,
    }),
  ];
  return {
    score: parts.reduce((sum, part) => sum + part.score, 0),
    why: parts.flatMap((part) => part.why),
    matchedQueryVariants: Array.from(
      new Set(parts.flatMap((part) => part.matchedQueryVariants)),
    ),
  };
}

function itemHasPdf(target: LibraryItemTarget): boolean {
  return target.attachments.some((attachment) => {
    const contentType = normalizeForSearch(attachment.contentType);
    const title = normalizeForSearch(attachment.title);
    return (
      contentType === "application/pdf" ||
      title.endsWith(".pdf") ||
      title === "pdf"
    );
  });
}

function sourceKindFromPdfContext(
  pdfContext: PdfContext | undefined,
  paperContext: PaperContextRef,
): LibraryRetrieveSourceKind {
  if (
    pdfContext?.sourceType === "mineru" ||
    paperContext.contentSourceMode === "mineru"
  ) {
    return "mineru";
  }
  if (pdfContext?.sourceType?.startsWith("attachment-")) return "attachment";
  return "pdf_text";
}

function snippetTextAround(
  text: string,
  start: number,
  end: number,
  radius = 360,
): string {
  const left = Math.max(0, start - radius);
  const right = Math.min(text.length, end + radius);
  const prefix = left > 0 ? "..." : "";
  const suffix = right < text.length ? "..." : "";
  return `${prefix}${text.slice(left, right).replace(/\s+/g, " ").trim()}${suffix}`;
}

function truncateText(text: string, maxChars: number): string {
  const normalized = normalizeText(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function findExactMatch(
  text: string,
  query: string,
  terms: string[],
): {
  start: number;
  end: number;
  score: number;
  reason: string;
  matchedQueryVariant: string;
} | null {
  const lower = text.toLowerCase();
  const queryLower = query.toLowerCase();
  if (queryLower.length > 2) {
    const phraseIndex = lower.indexOf(queryLower);
    if (phraseIndex >= 0) {
      return {
        start: phraseIndex,
        end: phraseIndex + queryLower.length,
        score: 60 + terms.length * 2,
        reason: `Exact phrase match for "${query}"`,
        matchedQueryVariant: query,
      };
    }
  }
  const hits = terms
    .map((term) => ({ term, index: lower.indexOf(term) }))
    .filter((entry) => entry.index >= 0);
  if (!hits.length) return null;
  const requireAllTerms = terms.length <= 4;
  if (requireAllTerms && hits.length < terms.length) return null;
  const first = hits.sort((a, b) => a.index - b.index)[0];
  return {
    start: first.index,
    end: first.index + first.term.length,
    score: 35 + hits.length * 3,
    reason: `Exact keyword match: ${hits.map((hit) => hit.term).join(", ")}`,
    matchedQueryVariant: query,
  };
}

function findExactMatchForQueryPlan(
  text: string,
  queryPlan: RetrievalQueryPlan,
): {
  start: number;
  end: number;
  score: number;
  reason: string;
  matchedQueryVariant: string;
} | null {
  for (const query of queryPlan.effectiveQueries) {
    const terms = buildRetrievalQueryPlan({ query }).lexicalTerms;
    const match = findExactMatch(text, query, terms);
    if (match) return match;
  }
  return null;
}

function matchMethodFromCandidate(
  candidate: PaperContextCandidate,
  semanticAllowed: boolean,
): LibraryRetrieveMatchMethod {
  if (
    semanticAllowed &&
    Number.isFinite(candidate.embeddingScore) &&
    candidate.embeddingScore > 0 &&
    candidate.embeddingScore >= candidate.bm25Score
  ) {
    return "semantic";
  }
  return "bm25";
}

function snippetChunkKey(snippet: LibraryRetrieveSnippet): string | null {
  if (!snippet.contextItemId || snippet.chunkIndex === undefined) return null;
  const chunkIndex = Number(snippet.chunkIndex);
  if (!Number.isFinite(chunkIndex) || chunkIndex < 0) return null;
  return `${snippet.itemId}:${snippet.contextItemId}:${Math.floor(chunkIndex)}`;
}

function candidateChunkKey(candidate: PaperContextCandidate): string {
  return `${candidate.itemId}:${candidate.contextItemId}:${candidate.chunkIndex}`;
}

function resourceStates(
  record: ResourceRecord,
): LibraryRetrieveResourceState[] {
  return Array.from(record.resourceState);
}

function queryStates(record: ResourceRecord): LibraryRetrieveQueryState[] {
  return Array.from(record.queryState);
}

function candidateFromRecord(record: ResourceRecord): LibraryRetrieveCandidate {
  return {
    itemId: String(record.target.itemId),
    title: record.target.title,
    year: record.target.year,
    creators: record.creators.length ? record.creators : undefined,
    resourceState: resourceStates(record),
    queryState: queryStates(record),
    score: Number(record.score.toFixed(3)),
    whyMatched: record.why.length
      ? record.why.slice(0, 4).join("; ")
      : "No query match",
    matchedQueryVariants: record.matchedQueryVariants.size
      ? Array.from(record.matchedQueryVariants)
      : undefined,
  };
}

function recordHasAbstractMatch(record: ResourceRecord): boolean {
  return record.why.some((reason) => reason.startsWith("abstract "));
}

function recordHasMetadataOnlyMatch(record: ResourceRecord): boolean {
  return record.why.some((reason) => !reason.startsWith("abstract "));
}

function snippetBasisForRecord(
  snippets: LibraryRetrieveSnippet[],
): Set<LibraryRetrieveMatchBasis> {
  const basis = new Set<LibraryRetrieveMatchBasis>();
  for (const snippet of snippets) {
    if (snippet.matchMethod === "semantic") {
      basis.add("semantic");
    } else {
      basis.add("chunk_text");
    }
  }
  return basis;
}

function paperMatchStatus(params: {
  record: ResourceRecord;
  basis: Set<LibraryRetrieveMatchBasis>;
  snippetCount: number;
}): LibraryRetrievePaperMatchStatus {
  const { record, basis, snippetCount } = params;
  const hasMetadata = basis.has("metadata") || basis.has("abstract");
  const hasIndexed = basis.has("indexed_text");
  const hasChunk = basis.has("chunk_text");
  const hasSemantic = basis.has("semantic");
  if (hasSemantic && !hasMetadata && !hasIndexed && !hasChunk) {
    return "semantic_only";
  }
  if (hasChunk && (hasMetadata || hasIndexed || snippetCount > 1)) {
    return "strong";
  }
  if (hasIndexed && hasMetadata) return "strong";
  if (hasIndexed && !hasChunk && !hasMetadata) return "mentions_only";
  if (hasChunk || hasIndexed || record.metadataScore >= 7) return "possible";
  if (record.metadataScore > 0) return "weak";
  if (hasSemantic) return "semantic_only";
  return "not_enough_evidence";
}

function paperMatchConfidence(
  status: LibraryRetrievePaperMatchStatus,
): "high" | "medium" | "low" {
  if (status === "strong") return "high";
  if (status === "possible") return "medium";
  return "low";
}

function buildPaperMatches(params: {
  records: ResourceRecord[];
  snippets: LibraryRetrieveSnippet[];
  maxMatches: number;
}): LibraryRetrievePaperMatch[] {
  const snippetsByItem = new Map<string, LibraryRetrieveSnippet[]>();
  for (const snippet of params.snippets) {
    const rows = snippetsByItem.get(snippet.itemId) || [];
    rows.push(snippet);
    snippetsByItem.set(snippet.itemId, rows);
  }
  const matches: LibraryRetrievePaperMatch[] = [];
  for (const record of params.records) {
    const snippets = snippetsByItem.get(String(record.target.itemId)) || [];
    const matchedQueryVariants = new Set(record.matchedQueryVariants);
    for (const snippet of snippets) {
      if (snippet.matchedQueryVariant) {
        matchedQueryVariants.add(snippet.matchedQueryVariant);
      }
    }
    const basis = snippetBasisForRecord(snippets);
    if (recordHasMetadataOnlyMatch(record)) basis.add("metadata");
    if (recordHasAbstractMatch(record)) basis.add("abstract");
    if (record.quicksearchMatched) basis.add("indexed_text");
    const status = paperMatchStatus({
      record,
      basis,
      snippetCount: snippets.length,
    });
    const hasEvidence =
      basis.size > 0 ||
      snippets.length > 0 ||
      record.metadataScore > 0 ||
      record.quicksearchMatched;
    if (!hasEvidence) continue;
    matches.push({
      itemId: String(record.target.itemId),
      title: record.target.title,
      matchStatus: status,
      basis: Array.from(basis),
      returnedSnippetCount: snippets.length,
      confidence: paperMatchConfidence(status),
      matchedQueryVariants: matchedQueryVariants.size
        ? Array.from(matchedQueryVariants)
        : undefined,
      whyMatched:
        record.why.length || snippets.length
          ? [
              ...record.why.slice(0, 3),
              ...snippets.slice(0, 2).map((snippet) => snippet.whyMatched),
            ]
              .filter(Boolean)
              .join("; ")
          : "Shortlisted but no direct evidence was found at this retrieval depth",
    });
  }
  return matches
    .sort((left, right) => {
      const rank: Record<LibraryRetrievePaperMatchStatus, number> = {
        strong: 5,
        possible: 4,
        weak: 3,
        mentions_only: 2,
        semantic_only: 1,
        not_enough_evidence: 0,
      };
      const delta = rank[right.matchStatus] - rank[left.matchStatus];
      if (delta !== 0) return delta;
      return right.returnedSnippetCount - left.returnedSnippetCount;
    })
    .slice(0, params.maxMatches);
}

function buildFrontier(params: {
  input: NormalizedLibraryRetrieveInput;
  scope: ScopeResolution;
  records: ResourceRecord[];
  paperMatches: LibraryRetrievePaperMatch[];
  snippets: LibraryRetrieveSnippet[];
  indexedScan: IndexedTextScanResult;
  metadataComplete: boolean;
}): LibraryRetrieveFrontier {
  const unresolved = params.paperMatches.filter((match) =>
    [
      "possible",
      "weak",
      "mentions_only",
      "semantic_only",
      "not_enough_evidence",
    ].includes(match.matchStatus),
  );
  const needsSnippetExpansion = unresolved
    .filter((match) => match.returnedSnippetCount === 0)
    .map((match) => match.itemId)
    .slice(0, 25);
  const needsCloseRead = unresolved
    .filter((match) => match.returnedSnippetCount > 0)
    .map((match) => match.itemId)
    .slice(0, 10);
  const unreadableCount = params.records.filter((record) =>
    record.resourceState.has("unsupported"),
  ).length;
  const snippetBudgetHit =
    params.snippets.length >= params.input.maxTotalSnippets;
  const expandedBudgetHit =
    params.paperMatches.length > params.input.maxFullTextPapers &&
    needsSnippetExpansion.length > 0;
  const stopReason: LibraryRetrieveFrontier["stopReason"] =
    !params.metadataComplete ||
    params.indexedScan.truncated ||
    snippetBudgetHit ||
    expandedBudgetHit
      ? "budget_limit"
      : unreadableCount && !params.indexedScan.scanned
        ? "unreadable_sources"
        : unresolved.length > Math.max(5, params.paperMatches.length / 2)
          ? "needs_more_specific_query"
          : "enough_evidence";
  const suggestedNextQueries =
    stopReason === "needs_more_specific_query"
      ? [
          `${params.input.query} method`,
          `${params.input.query} evidence`,
          `${params.input.query} results`,
        ]
      : [];
  return {
    needsSnippetExpansion,
    needsCloseRead,
    suggestedNextQueries,
    stopReason,
  };
}

function buildAnswerContract(params: {
  input: NormalizedLibraryRetrieveInput;
  metadataComplete: boolean;
  indexedScan: IndexedTextScanResult;
  paperMatches: LibraryRetrievePaperMatch[];
  snippetPapersExpanded: number;
  snippetCapHit: boolean;
}): LibraryRetrieveAnswerContract {
  const metadataCoverage = params.metadataComplete ? "complete" : "partial";
  const indexedTextCoverage: LibraryRetrieveCoverageStatus =
    params.indexedScan.scanned <= 0
      ? "none"
      : params.indexedScan.truncated ||
          params.indexedScan.scanned < params.indexedScan.available
        ? "partial"
        : "complete";
  const snippetCoverage: LibraryRetrieveSnippetCoverageStatus =
    params.snippetCapHit ||
    params.snippetPapersExpanded <
      params.paperMatches.filter((match) =>
        [
          "strong",
          "possible",
          "weak",
          "mentions_only",
          "semantic_only",
        ].includes(match.matchStatus),
      ).length
      ? "sampled"
      : "expanded";
  const safeClaims: string[] = [];
  const unsafeClaims: string[] = [];
  if (metadataCoverage === "complete") {
    safeClaims.push(
      "Can describe metadata and abstract matches across the scoped pool.",
    );
  } else {
    safeClaims.push(
      "Can describe matches only within the metadata-inspected subset.",
    );
    unsafeClaims.push("Do not claim complete coverage of all scoped records.");
  }
  if (indexedTextCoverage === "complete") {
    safeClaims.push(
      "Can enumerate lexical/indexed-text matches within available indexed/searchable text.",
    );
  } else if (indexedTextCoverage === "partial") {
    safeClaims.push(
      "Can report indexed/searchable-text candidates found within the scan budget.",
    );
    unsafeClaims.push("Do not claim all full-text-only matches were found.");
  } else {
    unsafeClaims.push(
      "Do not make full-text presence or absence claims from this result.",
    );
  }
  if (
    params.paperMatches.some((match) => match.matchStatus === "semantic_only")
  ) {
    unsafeClaims.push(
      "Do not count semantic-only matches as verified without metadata, abstract, indexed-text, or chunk-text support.",
    );
  }
  if (snippetCoverage === "sampled") {
    safeClaims.push(
      "Can summarize returned snippets as sampled supporting evidence.",
    );
  } else {
    safeClaims.push(
      "Can use returned snippets as expanded evidence for the matched ledger.",
    );
  }
  return {
    metadataCoverage,
    indexedTextCoverage,
    snippetCoverage,
    safeClaims: Array.from(new Set(safeClaims)),
    unsafeClaims: Array.from(new Set(unsafeClaims)),
  };
}

export class LibraryRetrieveService {
  constructor(
    private readonly zoteroGateway: ZoteroGateway,
    private readonly pdfService: PdfService,
    private readonly candidateBuilder: CandidateBuilder = buildPaperRetrievalCandidates,
  ) {}

  async retrieve(
    params: LibraryRetrieveInput & {
      request?: AgentRuntimeRequest;
      item?: Zotero.Item | null;
      model?: string;
      apiBase?: string;
      apiKey?: string;
      authMode?: AgentRuntimeRequest["authMode"];
      providerProtocol?: AgentRuntimeRequest["providerProtocol"];
      reasoning?: AgentRuntimeRequest["reasoning"];
      signal?: AbortSignal;
    },
  ): Promise<LibraryRetrieveResult> {
    const requestedIntent = params.intent;
    const requestedDepth = params.depth;
    const queryPlan = await resolveRetrievalQueryPlan({
      query: params.query,
      queryVariants: params.queryVariants,
      hasRetrievalContext:
        requestedDepth !== "verify" && requestedIntent !== "verify",
      model: params.model || params.request?.model,
      apiBase: params.apiBase || params.request?.apiBase,
      apiKey: params.apiKey || params.request?.apiKey,
      authMode: params.authMode || params.request?.authMode,
      providerProtocol:
        params.providerProtocol || params.request?.providerProtocol,
      reasoning: params.reasoning || params.request?.reasoning,
      signal: params.signal,
    });
    const input = normalizeInput(params, params.request, queryPlan);
    const warnings: string[] = [];
    const methodsUsed = new Set<LibraryRetrieveMethod>();
    const scope = await this.resolveScope(input, params.request, params.item);
    warnings.push(...scope.warnings);
    const metadataComplete = scope.totalItems <= scope.items.length;
    if (scope.totalItems > scope.items.length) {
      warnings.push(
        `Metadata budget inspected ${scope.items.length}/${scope.totalItems} scoped items. Raise maxMetadataItems to inspect more.`,
      );
    }

    const records = this.buildResourceRecords(scope.items, input);
    if (records.length) methodsUsed.add("metadata");
    if (records.some((record) => record.abstractText))
      methodsUsed.add("abstract");
    const indexedTextAvailable = records.filter((record) =>
      record.resourceState.has("text_available"),
    ).length;
    let indexedScan: IndexedTextScanResult = {
      available: indexedTextAvailable,
      scanned: 0,
      matched: 0,
      truncated: false,
    };

    if (
      input.depth !== "pool" &&
      input.depth !== "metadata" &&
      (input.methods.includes("fts") || input.methods.includes("exact"))
    ) {
      indexedScan = await this.addQuicksearchMatches(
        scope,
        records,
        input,
        warnings,
      );
      if (input.methods.includes("fts")) methodsUsed.add("fts");
    }

    for (const record of records) {
      record.score =
        record.metadataScore +
        record.ftsScore +
        (record.paperContext ? 0.5 : 0);
      if (record.metadataScore > 0) {
        record.queryState.add("matched_metadata");
      }
    }

    const sorted = records.slice().sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.paperContext && !right.paperContext) return -1;
      if (!left.paperContext && right.paperContext) return 1;
      return left.target.title.localeCompare(right.target.title);
    });

    const matchedRecords = sorted.filter(
      (record) => record.metadataScore > 0 || record.ftsScore > 0,
    );
    const shouldPreferMatchedLedger =
      input.intent === "enumerate" ||
      input.intent === "verify" ||
      input.intent === "summarize";
    const candidateSource =
      shouldPreferMatchedLedger && scope.type !== "items"
        ? matchedRecords
        : sorted;
    const candidateRecords =
      input.depth === "pool"
        ? []
        : candidateSource.slice(0, input.maxCandidatePapers);
    candidateRecords.forEach((record) => record.queryState.add("shortlisted"));

    const snippets: LibraryRetrieveSnippet[] = [];
    let snippetPapersExpanded = 0;
    let evidencePapers = 0;

    if (input.depth === "evidence" || input.depth === "verify") {
      const fullTextRecords = candidateRecords
        .filter((record) => record.paperContext)
        .slice(0, input.maxFullTextPapers);
      for (const record of fullTextRecords) {
        if (snippets.length >= input.maxTotalSnippets) break;
        const remaining = input.maxTotalSnippets - snippets.length;
        const paperSnippets = await this.retrievePaperSnippets({
          record,
          input,
          maxSnippets: Math.min(input.perPaperTopK, remaining),
          apiBase: params.apiBase,
          apiKey: params.apiKey,
          methodsUsed,
          warnings,
        });
        if (!record.queryState.has("content_loaded")) continue;
        snippetPapersExpanded += 1;
        record.resourceState.add("text_indexed");
        if (paperSnippets.length) {
          record.queryState.add("snippet_returned");
          evidencePapers += 1;
          snippets.push(...paperSnippets);
        }
      }
      if (input.requireExact && snippets.length === 0) {
        warnings.push(
          "Verify mode found no exact passage snippets in the searched full-text candidates.",
        );
      }
    }

    const dedupedRawSnippets = this.dedupeAndRankSnippets(snippets).slice(
      0,
      input.maxTotalSnippets,
    );
    const snippetQuotePack = attachQuoteCitationsToSnippets(dedupedRawSnippets);
    const dedupedSnippets = snippetQuotePack.snippets;
    const snippetPaperKeys = new Set(
      dedupedSnippets.map(
        (snippet) => `${snippet.itemId}:${snippet.contextItemId || ""}`,
      ),
    );
    evidencePapers = snippetPaperKeys.size;
    const paperMatches = buildPaperMatches({
      records: candidateRecords,
      snippets: dedupedSnippets,
      maxMatches: input.maxCandidatePapers,
    });
    const snippetCapHit = dedupedSnippets.length >= input.maxTotalSnippets;
    const frontier = buildFrontier({
      input,
      scope,
      records,
      paperMatches,
      snippets: dedupedSnippets,
      indexedScan,
      metadataComplete,
    });
    const answerContract = buildAnswerContract({
      input,
      metadataComplete,
      indexedScan,
      paperMatches,
      snippetPapersExpanded,
      snippetCapHit,
    });
    if (answerContract.unsafeClaims.length) {
      warnings.push(...answerContract.unsafeClaims);
    }

    const candidates = candidateRecords.map(candidateFromRecord);
    return {
      queryPlan: input.queryPlan,
      resourcePool: {
        type: scope.type,
        name: scope.name,
        scope: {
          libraryID: scope.libraryID || undefined,
          collectionIds: scope.collectionIds.length
            ? scope.collectionIds
            : undefined,
          tagNames: scope.tagContexts
            .filter((tag) => !tag.scope)
            .map((tag) => tag.name),
          tagScopes: scope.tagContexts
            .map((tag) => tag.scope)
            .filter((scope): scope is "allTagged" | "untagged" =>
              Boolean(scope),
            ),
          itemIds: scope.explicitItemIds.length
            ? scope.explicitItemIds
            : undefined,
        },
        totalItems: scope.totalItems,
        states: {
          available: records.filter((record) =>
            record.resourceState.has("available"),
          ).length,
          metadataLoaded: records.filter((record) =>
            record.resourceState.has("metadata_loaded"),
          ).length,
          textAvailable: records.filter((record) =>
            record.resourceState.has("text_available"),
          ).length,
          textIndexed: records.filter((record) =>
            record.resourceState.has("text_indexed"),
          ).length,
          unsupported: records.filter((record) =>
            record.resourceState.has("unsupported"),
          ).length,
        },
        queryCoverage: {
          metadataInspected: records.length,
          abstractsInspected: records.filter((record) => record.abstractText)
            .length,
          matchedMetadata: records.filter((record) =>
            record.queryState.has("matched_metadata"),
          ).length,
          shortlisted: candidateRecords.length,
          indexedTextAvailable,
          indexedTextScanned: indexedScan.scanned,
          indexedTextMatched: indexedScan.matched,
          snippetPapersExpanded,
          fullTextSearched: snippetPapersExpanded,
          snippetsReturned: dedupedSnippets.length,
          evidencePapers,
          deepReadPapers: 0,
        },
      },
      intent: input.intent,
      depth: input.depth,
      methodsUsed: Array.from(methodsUsed),
      candidates,
      paperMatches,
      frontier,
      answerContract,
      snippets: dedupedSnippets,
      quoteCitations: snippetQuotePack.quoteCitations.length
        ? snippetQuotePack.quoteCitations
        : undefined,
      warnings,
    };
  }

  private async resolveScope(
    input: NormalizedLibraryRetrieveInput,
    request?: AgentRuntimeRequest,
    item?: Zotero.Item | null,
  ): Promise<ScopeResolution> {
    const warnings: string[] = [];
    const explicitScope = input.scope || {};
    const hasExplicitScope = Boolean(
      explicitScope.libraryID ||
        explicitScope.collectionIds?.length ||
        explicitScope.itemIds?.length ||
        explicitScope.tagNames?.length ||
        explicitScope.tagScopes?.length,
    );
    const selectedCollections =
      !hasExplicitScope
        ? request?.selectedCollectionContexts || []
        : [];
    const selectedTags = !hasExplicitScope
      ? request?.selectedTagContexts || []
      : [];
    const collectionIds = dedupeNumbers(
      explicitScope.collectionIds ||
        selectedCollections.map((collection) => collection.collectionId),
    );
    const explicitItemIds = dedupeNumbers(explicitScope.itemIds);
    const inferredCollectionLibraryID =
      selectedCollections[0]?.libraryID ||
      (collectionIds[0]
        ? this.zoteroGateway.getCollectionSummary(collectionIds[0])?.libraryID
        : undefined);
    const inferredTagLibraryID = selectedTags[0]?.libraryID;
    const libraryID = this.zoteroGateway.resolveLibraryID({
      request,
      item,
      libraryID:
        explicitScope.libraryID || inferredCollectionLibraryID || inferredTagLibraryID,
    });
    if (!libraryID)
      throw new Error("No active library available for library_retrieve");
    const explicitTagContexts: TagContextRef[] = [];
    const includeAutomatic = explicitScope.includeAutomaticTags === true;
    const seenExplicitTags = new Set<string>();
    for (const name of explicitScope.tagNames || []) {
      const normalizedName = normalizeText(name).toLowerCase();
      if (!normalizedName || seenExplicitTags.has(`tag:${normalizedName}`)) {
        continue;
      }
      seenExplicitTags.add(`tag:${normalizedName}`);
      explicitTagContexts.push({
        name: normalizeText(name),
        normalizedName,
        libraryID,
        includeAutomatic,
      });
    }
    for (const scope of explicitScope.tagScopes || []) {
      if (scope !== "allTagged" && scope !== "untagged") continue;
      if (seenExplicitTags.has(`scope:${scope}`)) continue;
      seenExplicitTags.add(`scope:${scope}`);
      explicitTagContexts.push({
        name: scope === "allTagged" ? "All Tagged" : "Untagged",
        libraryID,
        scope,
        includeAutomatic,
      });
    }
    const tagContexts = selectedTags.length ? selectedTags : explicitTagContexts;

    if (explicitItemIds.length) {
      const items =
        this.zoteroGateway.getBibliographicItemTargetsByItemIds(
          explicitItemIds,
        );
      return {
        type: "items",
        name: `${items.length} selected items`,
        libraryID,
        collectionIds: [],
        tagContexts: [],
        tagItemIds: [],
        explicitItemIds,
        items,
        totalItems: items.length,
        warnings,
      };
    }

    if (collectionIds.length || tagContexts.length) {
      const byItemId = new Map<number, LibraryItemTarget>();
      const tagItemIds = new Set<number>();
      let totalItems = 0;
      const names: string[] = [];
      for (const collectionId of collectionIds) {
        const result = await this.zoteroGateway.listCollectionItemTargets({
          libraryID,
          collectionId,
          limit: input.maxMetadataItems,
        });
        totalItems += result.totalCount;
        names.push(result.collection.path || result.collection.name);
        for (const target of result.items) {
          if (
            byItemId.size >= input.maxMetadataItems &&
            !byItemId.has(target.itemId)
          ) {
            continue;
          }
          byItemId.set(target.itemId, target);
        }
      }
      if (collectionIds.length > 1 && byItemId.size < totalItems) {
        warnings.push(
          "Multiple collection totals may include overlapping items; retrieval uses unique item IDs.",
        );
      }
      for (const tagContext of tagContexts) {
        const result = await this.zoteroGateway.listTagItemTargets({
          libraryID,
          tagContext,
          limit: input.maxMetadataItems,
        });
        totalItems += result.totalCount;
        names.push(result.tagName);
        for (const target of result.items) {
          if (
            byItemId.size >= input.maxMetadataItems &&
            !byItemId.has(target.itemId)
          ) {
            continue;
          }
          byItemId.set(target.itemId, target);
          tagItemIds.add(target.itemId);
        }
      }
      if (tagContexts.length > 1 && byItemId.size < totalItems) {
        warnings.push(
          "Multiple tag totals may include overlapping items; retrieval uses unique item IDs.",
        );
      }
      if (collectionIds.length && tagContexts.length && byItemId.size < totalItems) {
        warnings.push(
          "Selected collection and tag totals may include overlapping items; retrieval uses unique item IDs.",
        );
      }
      const isMetadataCapped =
        byItemId.size >= input.maxMetadataItems && totalItems > byItemId.size;
      return {
        type:
          collectionIds.length && tagContexts.length
            ? "mixed"
            : collectionIds.length
              ? "collection"
              : "tag",
        name: names.join(" + "),
        libraryID,
        collectionIds,
        tagContexts,
        tagItemIds: Array.from(tagItemIds),
        explicitItemIds: [],
        items: Array.from(byItemId.values()),
        totalItems: isMetadataCapped ? totalItems : byItemId.size,
        warnings,
      };
    }

    const result = await this.zoteroGateway.listBibliographicItemTargets({
      libraryID,
      limit: input.maxMetadataItems,
    });
    return {
      type: "library",
      name: `Library ${libraryID}`,
      libraryID,
      collectionIds: [],
      tagContexts: [],
      tagItemIds: [],
      explicitItemIds: [],
      items: result.items,
      totalItems: result.totalCount,
      warnings,
    };
  }

  private buildResourceRecords(
    items: LibraryItemTarget[],
    input: NormalizedLibraryRetrieveInput,
  ): ResourceRecord[] {
    return items.map((target) => {
      const metadata = this.zoteroGateway.getEditableArticleMetadata(
        this.zoteroGateway.getItem(target.itemId),
      );
      const abstractText =
        normalizeText(metadata?.fields.abstractNote) ||
        normalizeText(
          (metadata?.fields as Record<string, string> | undefined)
            ?.abstractNote,
        );
      const creators = (metadata?.creators || [])
        .map(creatorLabel)
        .filter(Boolean);
      const paperContext = this.zoteroGateway.resolvePaperContextTarget({
        itemId: target.itemId,
      });
      const resourceState = new Set<LibraryRetrieveResourceState>([
        "available",
        "metadata_loaded",
      ]);
      if (paperContext || itemHasPdf(target)) {
        resourceState.add("text_available");
      } else {
        resourceState.add("unsupported");
      }
      const scored = scoreMetadata({
        target,
        metadata,
        abstractText,
        creators,
        queryPlan: input.queryPlan,
      });
      return {
        target,
        metadata,
        abstractText,
        creators,
        paperContext,
        resourceState,
        queryState: new Set<LibraryRetrieveQueryState>(),
        metadataScore: scored.score,
        ftsScore: 0,
        quicksearchMatched: false,
        matchedQueryVariants: new Set(scored.matchedQueryVariants),
        score: scored.score,
        why: scored.why,
      };
    });
  }

  private async addQuicksearchMatches(
    scope: ScopeResolution,
    records: ResourceRecord[],
    input: NormalizedLibraryRetrieveInput,
    warnings: string[],
  ): Promise<IndexedTextScanResult> {
    const scan: IndexedTextScanResult = {
      available: records.filter((record) =>
        record.resourceState.has("text_available"),
      ).length,
      scanned: records.filter((record) =>
        record.resourceState.has("text_available"),
      ).length,
      matched: 0,
      truncated: false,
    };
    const byItemId = new Map(
      records.map((record) => [record.target.itemId, record]),
    );
    const matchedIds = new Set<number>();
    const mark = (itemId: number, matchedQuery: string) => {
      const record = byItemId.get(itemId);
      if (!record) return;
      record.ftsScore = Math.max(record.ftsScore, 12);
      record.quicksearchMatched = true;
      if (matchedQuery) record.matchedQueryVariants.add(matchedQuery);
      matchedIds.add(record.target.itemId);
      if (
        !record.why.includes("Zotero indexed-text/quicksearch matched query")
      ) {
        record.why.push("Zotero indexed-text/quicksearch matched query");
      }
    };
    const scanLimit =
      input.intent === "enumerate" ||
      input.intent === "verify" ||
      input.intent === "summarize"
        ? records.length
        : input.maxCandidatePapers;
    try {
      const allRecordItemIds = Array.from(byItemId.keys());
      const runQuicksearch = async (
        query: string,
        options: {
          filters?: AgentLibraryFilters;
          allowedItemIds?: number[];
        } = {},
      ): Promise<void> => {
        const result = await this.zoteroGateway.searchAllLibraryItems({
          libraryID: scope.libraryID,
          query,
          filters: options.filters,
          allowedItemIds: options.allowedItemIds,
          limit: scanLimit,
        });
        if (result.totalCount > result.items.length) scan.truncated = true;
        result.items.forEach((target) => mark(target.itemId, query));
      };

      if (scope.collectionIds.length) {
        for (const query of input.queryPlan.effectiveQueries) {
          for (const collectionId of scope.collectionIds) {
            await runQuicksearch(query, {
              filters: { collectionId },
            });
          }
        }
      }
      if (scope.tagContexts.length) {
        for (const query of input.queryPlan.effectiveQueries) {
          if (scope.tagItemIds.length) {
            await runQuicksearch(query, {
              allowedItemIds: scope.tagItemIds,
            });
          }
        }
      }
      if (scope.collectionIds.length || scope.tagContexts.length) {
        scan.matched = matchedIds.size;
        return scan;
      }
      const explicit = new Set(scope.explicitItemIds);
      for (const query of input.queryPlan.effectiveQueries) {
        await runQuicksearch(
          query,
          explicit.size ? { allowedItemIds: allRecordItemIds } : {},
        );
      }
      scan.matched = matchedIds.size;
      return scan;
    } catch (error) {
      warnings.push(
        `Zotero quicksearch candidate expansion failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      scan.scanned = 0;
      return scan;
    }
  }

  private async retrievePaperSnippets(params: {
    record: ResourceRecord;
    input: NormalizedLibraryRetrieveInput;
    maxSnippets: number;
    apiBase?: string;
    apiKey?: string;
    methodsUsed: Set<LibraryRetrieveMethod>;
    warnings: string[];
  }): Promise<LibraryRetrieveSnippet[]> {
    const paperContext = params.record.paperContext;
    if (!paperContext || params.maxSnippets <= 0) return [];
    let pdfContext: PdfContext | undefined;
    try {
      pdfContext = await this.pdfService.ensurePaperContext(paperContext);
    } catch (error) {
      params.warnings.push(
        `Could not load full text for "${params.record.target.title}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
    if (!pdfContext?.chunks.length) return [];
    params.record.queryState.add("content_loaded");
    const sourceKind = sourceKindFromPdfContext(pdfContext, paperContext);
    const citationLabel = formatPaperCitationLabel(paperContext);
    const sourceLabel = formatPaperSourceLabel(paperContext);
    const snippets: LibraryRetrieveSnippet[] = [];
    if (params.input.methods.includes("exact") || params.input.requireExact) {
      params.methodsUsed.add("exact");
      snippets.push(
        ...this.buildExactSnippets({
          record: params.record,
          paperContext,
          pdfContext,
          sourceKind,
          queryPlan: params.input.queryPlan,
          maxSnippets: params.maxSnippets,
        }),
      );
    }
    if (!params.input.requireExact && snippets.length < params.maxSnippets) {
      params.methodsUsed.add("fts");
      const candidates = await this.candidateBuilder(
        paperContext,
        pdfContext,
        params.input.query,
        {
          apiBase: params.apiBase,
          apiKey: params.apiKey,
          disableEmbeddings: !params.input.methods.includes("semantic"),
          queryPlan: params.input.queryPlan,
        },
        {
          topK: params.maxSnippets,
          mode: "evidence",
          disableEmbeddings: !params.input.methods.includes("semantic"),
          queryPlan: params.input.queryPlan,
        },
      );
      const seenChunks = new Set(
        snippets
          .map((snippet) => snippetChunkKey(snippet))
          .filter((key): key is string => Boolean(key)),
      );
      for (const candidate of candidates) {
        if (snippets.length >= params.maxSnippets) break;
        const matchMethod = matchMethodFromCandidate(
          candidate,
          params.input.methods.includes("semantic"),
        );
        if (matchMethod === "semantic") params.methodsUsed.add("semantic");
        const key = candidateChunkKey(candidate);
        if (seenChunks.has(key)) continue;
        seenChunks.add(key);
        for (const query of candidate.matchedQueryVariants || []) {
          params.record.matchedQueryVariants.add(query);
        }
        snippets.push({
          snippetId: `lr_${candidate.itemId}_${candidate.contextItemId}_${candidate.chunkIndex}_${matchMethod}`,
          itemId: String(candidate.itemId),
          contextItemId: String(candidate.contextItemId),
          chunkIndex: candidate.chunkIndex,
          title: candidate.title,
          citationLabel,
          sourceLabel,
          sourceKind,
          matchMethod,
          sectionLabel: candidate.sectionLabel,
          snippet: truncateText(candidate.chunkText, 900),
          surroundingText: truncateText(candidate.chunkText, 1200),
          score: Number(
            (params.record.score + candidate.evidenceScore * 10).toFixed(3),
          ),
          matchedQueryVariant: candidate.matchedQueryVariant,
          whyMatched:
            matchMethod === "semantic"
              ? "Semantic retrieval ranked this passage highly"
              : "Full-text BM25 retrieval ranked this passage highly",
        });
      }
    }
    return snippets;
  }

  private buildExactSnippets(params: {
    record: ResourceRecord;
    paperContext: PaperContextRef;
    pdfContext: PdfContext;
    sourceKind: LibraryRetrieveSourceKind;
    queryPlan: RetrievalQueryPlan;
    maxSnippets: number;
  }): LibraryRetrieveSnippet[] {
    const snippets: LibraryRetrieveSnippet[] = [];
    const chunkMeta = params.pdfContext.chunkMeta || [];
    for (let index = 0; index < params.pdfContext.chunks.length; index += 1) {
      if (snippets.length >= params.maxSnippets) break;
      const chunk = params.pdfContext.chunks[index] || "";
      const match = findExactMatchForQueryPlan(chunk, params.queryPlan);
      if (!match) continue;
      params.record.matchedQueryVariants.add(match.matchedQueryVariant);
      const meta = chunkMeta[index];
      snippets.push({
        snippetId: `lr_${params.paperContext.itemId}_${params.paperContext.contextItemId}_${index}_exact`,
        itemId: String(params.paperContext.itemId),
        contextItemId: String(params.paperContext.contextItemId),
        chunkIndex: index,
        title: params.paperContext.title,
        citationLabel: formatPaperCitationLabel(params.paperContext),
        sourceLabel: formatPaperSourceLabel(params.paperContext),
        sourceKind: params.sourceKind,
        matchMethod: "exact",
        sectionLabel: meta?.sectionLabel,
        charStart: match.start,
        charEnd: match.end,
        snippet: snippetTextAround(chunk, match.start, match.end),
        surroundingText: truncateText(chunk, 1200),
        score: Number((params.record.score + match.score).toFixed(3)),
        whyMatched: match.reason,
        matchedQueryVariant: match.matchedQueryVariant,
      });
    }
    return snippets.sort((left, right) => right.score - left.score);
  }

  private dedupeAndRankSnippets(
    snippets: LibraryRetrieveSnippet[],
  ): LibraryRetrieveSnippet[] {
    const seen = new Set<string>();
    const out: LibraryRetrieveSnippet[] = [];
    for (const snippet of snippets.sort(
      (left, right) => right.score - left.score,
    )) {
      const key = [
        snippet.itemId,
        snippet.contextItemId || "",
        snippet.matchMethod,
        normalizeForSearch(snippet.snippet).slice(0, 220),
      ].join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(snippet);
    }
    return out;
  }
}

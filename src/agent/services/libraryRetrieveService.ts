import {
  buildChunkIndex,
  buildPaperRetrievalCandidates,
  scoreChunkBM25,
} from "../../services/paperContent/pdfContext";
import {
  buildRetrievalQueryPlan,
  generateRetrievalProbeReformulation,
  resolveRetrievalQueryPlan,
  RETRIEVAL_QUERY_VARIANT_HARD_LIMIT,
  type RetrievalQueryPlan,
} from "../../services/retrieval/retrievalQueryPlan";
import {
  extractCjkKeywordProbes,
  findFirstIndexTermMatch,
  isCjkDominantText,
  stripTerminalPunctuation,
  toRetrievalIndexTerm,
  tokenizeRetrievalText,
} from "../../services/retrieval/retrievalTokenizer";
import type {
  PaperContextCandidate,
  PdfContext,
  PdfChunkKind,
} from "../../services/paperContent/types";
import type { AgentRuntimeRequest } from "../types";
import { resolveResearchPolicy } from "../context/researchPolicy";
import { getTurnPaperScopeFromRequest } from "../context/requestTurnPaperScope";
import type {
  PaperContextRef,
  QuoteCitation,
  TagContextRef,
} from "../../shared/types";
import {
  buildLibraryChatCoverageReceipt,
  completeLibraryChatReadStrategyDiagnostics,
  DEEP_SYNTHESIS_MAX_PAPERS,
  resolveLibraryChatReadStrategy,
  type LibraryChatCoverageReceipt,
  type LibraryChatReadStrategyDiagnostics,
} from "../../shared/libraryChatReadStrategy";
import {
  admitsAsBodyEvidence,
  compareEvidenceCandidatesForSections,
  isBodyEvidenceSection,
  renderSectionLabel,
  wantedSectionKinds,
  type EvidenceSectionKind,
} from "../../shared/libraryChatEvidencePolicy";
import { buildLibraryRetrieveEvidencePack } from "./libraryRetrieveEvidencePack";
import { triageCandidatesWithModel } from "./libraryRetrieveTriage";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../services/paperContent/paperAttribution";
import {
  buildQuoteCitation,
  mergeQuoteCitations,
} from "../../services/quotes/quoteCitations";
import {
  flattenText,
  hasHeadingLine,
  windowBodyRanges,
  type TextRange,
} from "../../services/quotes/sentenceSplit";
import type {
  EditableArticleCreator,
  EditableArticleMetadataSnapshot,
  LibraryItemTarget,
  ZoteroGateway,
} from "./zoteroGateway";
import { groupPaperWorks } from "./paperWorkIdentity";
import type { PdfService } from "./pdfService";
import type { ModelProfileOverride } from "../../modelCapabilities";
import { libraryIndexService } from "../../services/libraryIndexService";
import {
  createRetrievalTimer,
  recordRetrievalTiming,
  type RetrievalTimer,
} from "../../services/retrieval/retrievalTiming";
import { appLogger } from "../../core/logging";
import {
  beginRetrievalActivity,
  libraryTextIndex,
  type IndexedChunkHit,
  type IndexedPaperHit,
  type LibraryTextIndexFacade,
} from "../../services/libraryTextIndex";
import {
  INDEX_COVERAGE_SKIP_PROBES_RATIO,
  INDEX_PLANNER_SOFT_DEADLINE_MS,
  MAX_UNINDEXED_FALLBACK_PAPERS,
} from "../../services/libraryTextIndex/constants";
import {
  callEmbeddings,
  resolveSemanticSearchState,
} from "../../utils/llmClient";

export type LibraryRetrieveDepth = "pool" | "metadata" | "evidence" | "verify";
export type LibraryRetrieveIntent = "enumerate" | "verify" | "summarize";
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
  /** Paper sections the user asked about; snippet ranking prefers them. */
  sections?: EvidenceSectionKind[];
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
  | "matched_bm25"
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
  /**
   * Why the paper shows no passage. `not_returned_budget`: its text was
   * available but the snippet cap was full before it was read, so its
   * returned snippet count says nothing about its content.
   * `no_pdf_attachment`: it has no full text to read, and no abstract
   * passage matched (paper_read's word for the same state).
   */
  passageStatus?: "not_returned_budget" | "no_pdf_attachment";
  /**
   * Set only when another shortlisted item is a version of the same work
   * (a preprint and its journal version, say); rows are marked, not merged.
   */
  workGroupId?: string;
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

export type LibraryRetrieveAnswerContract =
  LibraryChatReadStrategyDiagnostics & {
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
  chunkKind?: PdfChunkKind;
  pageLabel?: string;
  charStart?: number;
  charEnd?: number;
  quoteCitationId?: string;
  snippet: string;
  /**
   * The text the snippet's window was cut from, so its quote can skip
   * headings and cut formulas. Internal: removed before the result leaves
   * the service.
   */
  quoteSource?: string;
  surroundingText?: string;
  score: number;
  whyMatched: string;
  matchedQueryVariant?: string;
  /** The paper's leading passage, served because nothing in it matched. */
  leadingPassage?: true;
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
      /** Records matched via abstract/title BM25 token overlap only. */
      matchedBm25: number;
      shortlisted: number;
      indexedTextAvailable: number;
      indexedTextScanned: number;
      indexedTextMatched: number;
      /** Extra model-driven probe reformulation rounds that ran. */
      probeRounds: number;
      /** Distinct search probes tried across all quicksearch passes. */
      variantsTried: number;
      snippetPapersExpanded: number;
      /** Deprecated compatibility alias for snippetPapersExpanded. */
      fullTextSearched: number;
      snippetsReturned: number;
      evidencePapers: number;
      /**
       * Distinct works among the evidence papers: versions of one work
       * (same workGroupId) count once. Caps still count items.
       */
      evidenceWorks: number;
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
  coverageReceipt: LibraryChatCoverageReceipt;
  evidenceLedgerText?: string;
  synthesisDigest?: string;
  snippets: LibraryRetrieveSnippet[];
  quoteCitations?: QuoteCitation[];
  warnings: string[];
};

const CHAT_RESEARCH_POLICY = resolveResearchPolicy("chat");

export const LIBRARY_RETRIEVE_DEFAULT_BUDGETS = {
  maxMetadataItems: CHAT_RESEARCH_POLICY.defaultMetadataItems,
  maxCollectionMetadataItems:
    CHAT_RESEARCH_POLICY.defaultCollectionMetadataItems,
  maxCandidatePapers: CHAT_RESEARCH_POLICY.defaultCandidatePapers,
  maxEnumerateCandidatePapers:
    CHAT_RESEARCH_POLICY.defaultEnumerateCandidatePapers,
  maxFullTextPapers: CHAT_RESEARCH_POLICY.defaultFullTextPapers,
  perPaperTopK: CHAT_RESEARCH_POLICY.defaultSnippetsPerPaper,
  maxTotalSnippets: CHAT_RESEARCH_POLICY.defaultTotalSnippets,
} as const;

export const LIBRARY_RETRIEVE_HARD_CAPS = {
  maxMetadataItems: CHAT_RESEARCH_POLICY.maxMetadataItemsPerCall,
  maxCandidatePapers: CHAT_RESEARCH_POLICY.maxCandidatePapersPerCall,
  maxFullTextPapers: CHAT_RESEARCH_POLICY.maxFullTextPapersPerCall,
  perPaperTopK: CHAT_RESEARCH_POLICY.maxSnippetsPerPaper,
  maxTotalSnippets: CHAT_RESEARCH_POLICY.maxTotalSnippetsPerCall,
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
  for (const quoteText of snippetQuoteTexts(
    snippet.snippet,
    snippet.quoteSource ?? snippet.snippet,
  )) {
    const citation = buildQuoteCitation({
      quoteText,
      citationLabel,
      sourceMatchKind: snippet.matchMethod === "exact" ? "exact" : "trusted",
      sourceMatchSource: "context-text",
      sourceSectionLabel: snippet.sectionLabel,
      sourceChunkKind: snippet.chunkKind,
      contextItemId,
      itemId,
    });
    if (citation) return citation;
  }
  return undefined;
}

const SNIPPET_ELLIPSIS = "...";

/**
 * The texts a snippet's quote may be cut from, in text order; each is a
 * substring of the snippet. `source` is the text its window was cut from.
 * The quote is the window's body text (the shared window rule: never a
 * heading, never a cut formula); a window that keeps all of it quotes the
 * snippet itself.
 */
function snippetQuoteTexts(snippet: string, source: string): string[] {
  const flatSource = flattenText(source);
  const window = locateSnippetWindow(snippet, flatSource);
  if (!window) return hasHeadingLine(source) ? [] : [snippet];
  return windowBodyRanges(source, window).map((range) =>
    range.start === window.start && range.end === window.end
      ? snippet
      : flatSource.slice(range.start, range.end).trim(),
  );
}

/** Where the snippet's text, without its "..." cut marks, sits in the
 * flattened source. */
function locateSnippetWindow(
  snippet: string,
  flatSource: string,
): TextRange | undefined {
  const flat = flattenText(snippet);
  const cutHead = flat.startsWith(SNIPPET_ELLIPSIS);
  const cutTail = flat.endsWith(SNIPPET_ELLIPSIS);
  const bodies = [flat];
  if (cutHead) bodies.push(flat.slice(SNIPPET_ELLIPSIS.length));
  if (cutTail) bodies.push(flat.slice(0, -SNIPPET_ELLIPSIS.length));
  if (cutHead && cutTail) {
    bodies.push(flat.slice(SNIPPET_ELLIPSIS.length, -SNIPPET_ELLIPSIS.length));
  }
  for (const candidate of bodies) {
    const body = candidate.trim();
    const start = body ? flatSource.indexOf(body) : -1;
    if (start >= 0) return { start, end: start + body.length };
  }
  return undefined;
}

function attachQuoteCitationsToSnippets(
  snippets: LibraryRetrieveSnippet[],
  options: { includeQuoteAnchors: boolean },
): {
  snippets: LibraryRetrieveSnippet[];
  quoteCitations: QuoteCitation[];
} {
  if (!options.includeQuoteAnchors) {
    return {
      snippets: snippets.map((snippet) => {
        const {
          quoteCitationId: _quoteCitationId,
          quoteSource: _quoteSource,
          ...rest
        } = snippet;
        void _quoteCitationId;
        void _quoteSource;
        return rest;
      }),
      quoteCitations: [],
    };
  }
  const quoteCitations: QuoteCitation[] = [];
  const pairedSnippets = snippets.map((snippet) => {
    const citation = buildSnippetQuoteCitation(snippet);
    const { quoteSource: _quoteSource, ...rest } = snippet;
    void _quoteSource;
    if (!citation) return rest;
    quoteCitations.push(citation);
    return {
      ...rest,
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
  sections?: EvidenceSectionKind[];
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
  bm25Score: number;
  bm25TermHits: number;
  bm25DistinctiveHits: number;
  quicksearchMatched: boolean;
  /** Blended library-text-index contribution, merged by max across rounds. */
  indexScore: number;
  /** The library text index ranked this paper for the query. */
  indexMatched: boolean;
  /** The paper's attachment is in the library text index. */
  indexed: boolean;
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

/** Embeds retrieval queries; injectable so tests need no provider. */
export type LibraryQueryEmbedder = {
  /** Whether semantic search is on (an explicit user "off" always wins). */
  isEnabled: () => boolean;
  embed: (text: string, signal?: AbortSignal) => Promise<number[] | undefined>;
};

const defaultQueryEmbedder: LibraryQueryEmbedder = {
  isEnabled: () => resolveSemanticSearchState().enabled,
  embed: async (text, signal) => (await callEmbeddings([text], { signal }))[0],
};

/** Embeds a query text at most once per retrieve. */
type QueryEmbeddingMemo = (text: string) => Promise<number[]>;

const QUICKSEARCH_CONCURRENCY = 4;

/**
 * Runs `fn` over `items` with at most `limit` calls in flight. After the first
 * failure no new item starts; `failedAt` is the lowest failed index (-1 when
 * all succeeded) so callers can keep exactly the results a sequential loop
 * would have kept.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<{
  results: Array<R | undefined>;
  failedAt: number;
  error: unknown;
}> {
  const results = new Array<R | undefined>(items.length);
  let next = 0;
  let failedAt = -1;
  let error: unknown;
  const worker = async () => {
    while (failedAt < 0 && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]);
      } catch (caught) {
        if (failedAt < 0 || index < failedAt) {
          failedAt = index;
          error = caught;
        }
      }
    }
  };
  const workers = Math.max(0, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return { results, failedAt, error };
}

const DEFAULT_METHODS: LibraryRetrieveMethod[] = [
  "metadata",
  "abstract",
  "exact",
  "fts",
  "semantic",
];

export const QUICKSEARCH_MAX_PROBES = 8;
export const LIBRARY_RETRIEVE_MIN_MATCHED_SHORTLIST = 5;

// In-service probe iteration: when the first quicksearch pass matches fewer
// records than this, ask the model for fresh corpus-language probes and
// rescan, bounded by rounds and wall clock. The initial query-plan LLM call
// has its own separate 10s budget.
const PROBE_WEAK_MATCH_THRESHOLD = 3;
const MAX_EXTRA_PROBE_ROUNDS = 2;
const PROBE_LOOP_DEADLINE_MS = 15_000;
const TRIAGE_MAX_CANDIDATES = 40;

// Normalized pool-BM25 contribution to a record's blended score: below a
// title phrase match (10) so exact titles keep winning, above tag/creator
// term weights so distinctive-vocabulary overlap outranks generic noise.
const BM25_BLEND_WEIGHT = 8;

// Normalized library-text-index contribution: the best index-ranked paper
// scores like a quicksearch hit (12), the rest in proportion.
const INDEX_BLEND_WEIGHT = 12;

const BM25_MIN_TERM_HITS = 2;

/**
 * Whether the query itself reached this paper — the one definition of "matched"
 * this service has. Everything that ranks, shortlists or displaces a paper must
 * ask this and nothing narrower: `quicksearchMatched` alone, for instance,
 * silently demotes every paper found by metadata or BM25 rather than by the
 * indexed-text probe.
 */
function recordMatchedQuery(record: ResourceRecord): boolean {
  return (
    record.indexMatched ||
    record.metadataScore > 0 ||
    record.ftsScore > 0 ||
    recordBm25Matched(record)
  );
}

function recordBm25Matched(record: ResourceRecord): boolean {
  // A single shared token (often one CJK bigram) is noise, and tokens shared
  // by most of the pool (generic vocabulary) carry no signal either — at
  // least one hit must be distinctive to the pool.
  return (
    record.bm25Score > 0 &&
    record.bm25TermHits >= BM25_MIN_TERM_HITS &&
    record.bm25DistinctiveHits >= 1
  );
}
const CJK_FULL_PHRASE_PROBE_MAX_CHARS = 12;
const CJK_KEYWORD_PROBES_PER_QUERY = 4;

/**
 * Zotero's quicksearch treats a whitespace-free query as one literal
 * substring, so a raw CJK question (often ending in ？) matches nothing.
 * Derive bounded probes from the query plan instead: strip terminal
 * punctuation everywhere, and for CJK-dominant queries send segmented
 * keyword probes rather than the full sentence.
 */
/** Bounded quicksearch probes for one query/variant string. */
export function expandProbeText(text: string): string[] {
  const stripped = stripTerminalPunctuation(text);
  if (!stripped) return [];
  if (!isCjkDominantText(stripped)) return [stripped];
  const probes: string[] = [];
  if (stripped.length <= CJK_FULL_PHRASE_PROBE_MAX_CHARS) probes.push(stripped);
  probes.push(
    ...extractCjkKeywordProbes(stripped, CJK_KEYWORD_PROBES_PER_QUERY),
  );
  return probes;
}

export function buildQuicksearchProbes(
  queryPlan: RetrievalQueryPlan,
  options: { includeFullPhrases?: boolean } = {},
): string[] {
  const probes: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    probes.push(trimmed);
  };
  for (const query of queryPlan.effectiveQueries) {
    if (probes.length >= QUICKSEARCH_MAX_PROBES) break;
    if (options.includeFullPhrases) {
      // verify/requireExact callers need the literal scanned pool-wide even
      // when it is a long CJK phrase the keyword probes would replace.
      const stripped = stripTerminalPunctuation(query);
      if (stripped) push(stripped);
    }
    for (const probe of expandProbeText(query)) push(probe);
  }
  return probes.slice(0, QUICKSEARCH_MAX_PROBES);
}

const DEFAULT_INTENT: LibraryRetrieveIntent = "enumerate";

/**
 * Index hits fetched per paper, as a multiple of its snippet slots, while
 * ranking prefers sections: room to find them among the paper's matching
 * chunks. On the live suite's three real papers a section-labelled chunk
 * ranked 7th to 19th of 20 to 39 matches; 12 hits (the default 3 slots)
 * reached one in 6 of 12 measured cases, against 3 with the usual 5, at
 * under twice the pass search's time on 250 real-length papers.
 */
const SECTION_STEERING_FETCH_FACTOR = 4;

/**
 * The sections a paper's evidence should come from, the same whether the
 * paper is read from the index or directly: those the model named (from a
 * request in any language), else the English cue of the question (triage's
 * per-paper question when it gave one) or of its variants.
 */
function wantedSectionsFor(
  input: NormalizedLibraryRetrieveInput,
  queryOverride?: string,
): EvidenceSectionKind[] {
  return wantedSectionKinds({
    question: queryOverride || input.query,
    queryVariants: input.queryVariants,
    sections: input.sections,
  });
}

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
  if (value === "enumerate" || value === "verify" || value === "summarize") {
    return value;
  }
  if (value === "discover") return "enumerate";
  if (depth === "verify") return "verify";
  // The tool arguments are the only intent input.
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
  if (!request) return false;
  const scope = getTurnPaperScopeFromRequest(request);
  return Boolean(scope.collections.length || scope.tags.length);
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
    sections: input.sections,
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
  return sourceKindFromSourceType(pdfContext?.sourceType, paperContext);
}

function sourceKindFromSourceType(
  sourceType: string | undefined,
  paperContext: PaperContextRef,
): LibraryRetrieveSourceKind {
  if (sourceType === "mineru" || paperContext.contentSourceMode === "mineru") {
    return "mineru";
  }
  if (sourceType?.startsWith("attachment-")) return "attachment";
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

/**
 * An index chunk's snippet: a window around the earliest occurrence of any
 * matched term (a chunk head would cut passages deep in the chunk), or the
 * chunk head when no term occurs, as for zero-score leading chunks. A term
 * occurs as a substring or, as BM25 counted it, as a word with the same
 * index term ("error" for the query term "errors").
 */
function indexSnippetText(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  let start = -1;
  let end = -1;
  for (const term of terms) {
    const needle = term.trim().toLowerCase();
    if (!needle) continue;
    const at = lower.indexOf(needle);
    if (at >= 0 && (start < 0 || at < start)) {
      start = at;
      end = at + needle.length;
    }
  }
  const stemmed = findFirstIndexTermMatch(text, terms);
  if (stemmed && (start < 0 || stemmed.start < start)) {
    start = stemmed.start;
    end = stemmed.end;
  }
  return start >= 0
    ? snippetTextAround(text, start, end)
    : truncateText(text, 900);
}

function truncateText(text: string, maxChars: number): string {
  const normalized = normalizeText(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

/**
 * Index of `term` in `lower` as a whole word: not preceded or followed by a
 * letter or digit (Unicode-aware). Terms with Han, Kana, or Hangul characters
 * use plain indexOf, because CJK text has no word boundaries.
 */
function indexOfWholeTerm(lower: string, term: string): number {
  if (!term) return -1;
  if (
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
      term,
    )
  )
    return lower.indexOf(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A term ending in a letter may take an English plural ending (s or es).
  const plural = /\p{L}$/u.test(term) ? "(?:s|es)?" : "";
  return lower.search(
    new RegExp(`(?<![\\p{L}\\p{N}])${escaped}${plural}(?![\\p{L}\\p{N}])`, "u"),
  );
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
    const phraseIndex = indexOfWholeTerm(lower, queryLower);
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
    .map((term) => ({ term, index: indexOfWholeTerm(lower, term) }))
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

/**
 * Fold the papers only a triage-suggested rescan matched into the shortlist.
 *
 * The shortlist is capped, and on the pool-fallback path that triage exists
 * for it arrives already full — mostly of papers nothing matched, carried as
 * leads to verify rather than as evidence. A paper the rescan matched outranks
 * those, so it takes their seats instead of queueing behind them: appending
 * would leave it past the snippet budget, which reads the shortlist in order,
 * and at capacity it would not enter at all.
 *
 * Only unmatched leads may be displaced. Triage's own picks and every paper
 * the query already reached — by metadata, FTS or BM25, not just by the
 * indexed-text probe — keep their places, because a probe hit is the weaker
 * evidence of the two. Whatever still does not fit is reported rather than
 * dropped in silence.
 */
function mergeRescanDiscoveries<
  TRecord extends { target: { itemId: number | string }; bm25Score: number },
>(params: {
  shortlist: readonly TRecord[];
  discovered: readonly TRecord[];
  /** True for a paper that is already evidence and so cannot be displaced. */
  isEstablished: (record: TRecord) => boolean;
  maxCandidatePapers: number;
}): { shortlist: TRecord[]; displaced: TRecord[]; droppedDiscoveries: number } {
  if (!params.discovered.length) {
    return {
      shortlist: [...params.shortlist],
      displaced: [],
      droppedDiscoveries: 0,
    };
  }
  const established: TRecord[] = [];
  const leads: TRecord[] = [];
  for (const record of params.shortlist) {
    (params.isEstablished(record) ? established : leads).push(record);
  }
  // Discoveries arrive in library order, which says nothing about relevance —
  // and since they now sit ahead of the leads, that order would decide which
  // ones are read. `score` is the pre-rescan ranking and is not recomputed, so
  // it is uniform here; `bm25Score` is, against a plan that now carries the
  // probe terms, which is exactly what separates these papers.
  const ranked = [...params.discovered].sort(
    (left, right) => right.bm25Score - left.bm25Score,
  );
  const merged = [...established, ...ranked, ...leads];
  const shortlist = merged.slice(0, Math.max(0, params.maxCandidatePapers));
  const kept = new Set(shortlist.map((record) => String(record.target.itemId)));
  return {
    shortlist,
    displaced: params.shortlist.filter(
      (record) => !kept.has(String(record.target.itemId)),
    ),
    droppedDiscoveries: params.discovered.filter(
      (record) => !kept.has(String(record.target.itemId)),
    ).length,
  };
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

/** The reason applyIndexPapers records: indexed text, not metadata. */
const INDEX_MATCH_REASON_PREFIX = "library index:";

function recordHasMetadataOnlyMatch(record: ResourceRecord): boolean {
  return record.why.some(
    (reason) =>
      !reason.startsWith("abstract ") &&
      !reason.startsWith(INDEX_MATCH_REASON_PREFIX),
  );
}

function snippetBasisForRecord(
  snippets: LibraryRetrieveSnippet[],
): Set<LibraryRetrieveMatchBasis> {
  const basis = new Set<LibraryRetrieveMatchBasis>();
  for (const snippet of snippets) {
    // A leading passage was served because nothing in the paper matched.
    if (snippet.leadingPassage) continue;
    if (snippet.sourceKind === "abstract") {
      basis.add("abstract");
    } else if (snippet.matchMethod === "semantic") {
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

/**
 * Snippet slots per paper, in rank order: one for every full-text paper
 * while the cap lasts, then one for each of the `abstractPapers` abstract-only
 * papers, then the full-text papers topped up in rank order to each paper's
 * own count. An abstract passage so never takes a full-text paper's first
 * slot, but comes before any full-text paper's second.
 */
function allocateSnippetSlots(
  available: readonly number[],
  maxTotal: number,
  abstractPapers = 0,
): { slots: number[]; abstractSlots: number } {
  const slots = available.map(() => 0);
  let left = Math.max(0, maxTotal);
  for (let index = 0; index < available.length && left > 0; index += 1) {
    if (available[index] <= 0) continue;
    slots[index] = 1;
    left -= 1;
  }
  const abstractSlots = Math.min(left, Math.max(0, abstractPapers));
  left -= abstractSlots;
  for (let index = 0; index < available.length && left > 0; index += 1) {
    const extra = Math.min(left, available[index] - slots[index]);
    if (extra <= 0) continue;
    slots[index] += extra;
    left -= extra;
  }
  return { slots, abstractSlots };
}

/**
 * The passage a paper without full text gets from its abstract: in verify
 * mode only when the abstract holds an exact match (the same test a body
 * chunk passes), otherwise when the abstract holds at least two distinct query terms as whole
 * tokens (one, if the plan has only one). It has no
 * attachment, so it carries no quote anchor and is never body evidence.
 */
function buildAbstractSnippet(
  record: ResourceRecord,
  input: NormalizedLibraryRetrieveInput,
): LibraryRetrieveSnippet | null {
  const abstractText = record.abstractText;
  if (record.paperContext || !abstractText) return null;
  const lower = abstractText.toLowerCase();
  // The exact match decides only in verify mode; elsewhere the whole-token
  // rule below applies.
  const exact = input.requireExact
    ? findExactMatchForQueryPlan(abstractText, input.queryPlan)
    : null;
  let match: {
    start: number;
    end: number;
    score: number;
    reason: string;
    matchedQueryVariant?: string;
  } | null = exact;
  if (!match && !input.requireExact) {
    const planTerms = Array.from(
      new Set(
        input.queryPlan.lexicalTerms
          .map((term) => term.toLowerCase())
          .filter(Boolean),
      ),
    );
    const abstractTokens = new Set(
      tokenizeRetrievalText(abstractText, { filterStopwords: false }),
    );
    const hits = planTerms
      .filter((term) => {
        const termTokens = tokenizeRetrievalText(term, {
          filterStopwords: false,
        });
        return (
          termTokens.length > 0 &&
          termTokens.every((token) => abstractTokens.has(token))
        );
      })
      .map((term) => ({ term, index: indexOfWholeTerm(lower, term) }))
      .filter((hit) => hit.index >= 0)
      .sort((left, right) => left.index - right.index);
    // One generic term is weak: ask for two distinct terms when the plan has two.
    const needed = Math.min(2, planTerms.length);
    if (hits.length > 0 && hits.length >= needed) {
      match = {
        start: hits[0].index,
        end: hits[0].index + hits[0].term.length,
        score: hits.length,
        reason: `Abstract keyword match: ${hits
          .slice(0, 5)
          .map((hit) => hit.term)
          .join(", ")}`,
      };
    }
  }
  if (!match) return null;
  // Labels only: a no-PDF record has no attachment, so the reference names
  // the parent item and no contextItemId reaches the passage.
  const labelRef: PaperContextRef = {
    itemId: record.target.itemId,
    contextItemId: 0,
    title: record.target.title,
    firstCreator: record.target.firstCreator,
    year: record.target.year,
  };
  const itemId = String(record.target.itemId);
  return {
    snippetId: `lr_${itemId}_abstract`,
    itemId,
    title: record.target.title,
    citationLabel: formatPaperCitationLabel(labelRef),
    sourceLabel: formatPaperSourceLabel(labelRef),
    sourceKind: "abstract",
    matchMethod: "metadata",
    sectionLabel: "Abstract",
    chunkKind: "abstract",
    snippet:
      abstractText.length <= 900
        ? abstractText
        : snippetTextAround(abstractText, match.start, match.end),
    surroundingText: truncateText(abstractText, 1200),
    score: Number((record.score + match.score).toFixed(3)),
    whyMatched: `Abstract only (no PDF attachment): ${match.reason}`,
    ...(match.matchedQueryVariant
      ? { matchedQueryVariant: match.matchedQueryVariant }
      : {}),
  };
}

function lastNameOf(creator: EditableArticleCreator | undefined): string {
  if (!creator) return "";
  const lastName = normalizeText(creator.lastName);
  if (lastName) return lastName;
  return normalizeText(creator.name).split(" ").pop() || "";
}

/** Work group ids for the shortlisted records that share a work. */
function workGroupsFor(
  records: readonly ResourceRecord[],
): Map<number, string> {
  return groupPaperWorks(
    records.map((record) => {
      const creators = record.metadata?.creators || [];
      const fields = record.metadata?.fields;
      return {
        itemId: record.target.itemId,
        title: record.target.title,
        firstCreatorLastName: lastNameOf(
          creators.find((creator) => creator.creatorType === "author") ||
            creators[0],
        ),
        year: record.target.year || fields?.date,
        doi: fields?.DOI,
        url: fields?.url,
        extra: fields?.extra,
      };
    }),
  );
}

function buildPaperMatches(params: {
  records: ResourceRecord[];
  snippets: LibraryRetrieveSnippet[];
  maxMatches: number;
  /** Item ids of papers the snippet cap left without a passage. */
  budgetCutItemIds?: ReadonlySet<string>;
  /** Work group ids of the records that share a work with another record. */
  workGroups?: ReadonlyMap<number, string>;
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
    if (record.quicksearchMatched || record.indexMatched) {
      basis.add("indexed_text");
    }
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
    const budgetCut =
      !snippets.length &&
      Boolean(params.budgetCutItemIds?.has(String(record.target.itemId)));
    const passageStatus: LibraryRetrievePaperMatch["passageStatus"] = budgetCut
      ? "not_returned_budget"
      : !snippets.length && !record.paperContext
        ? "no_pdf_attachment"
        : undefined;
    const workGroupId = params.workGroups?.get(record.target.itemId);
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
      whyMatched: [
        record.why.length || snippets.length || budgetCut
          ? [
              ...record.why.slice(0, 3),
              ...snippets.slice(0, 2).map((snippet) => snippet.whyMatched),
            ]
              .filter(Boolean)
              .join("; ")
          : "Shortlisted but no direct evidence was found at this retrieval depth",
        budgetCut
          ? "Not returned because the passage budget was full; this is not evidence of absence"
          : "",
      ]
        .filter(Boolean)
        .join("; "),
      ...(passageStatus ? { passageStatus } : {}),
      ...(workGroupId ? { workGroupId } : {}),
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
  // A paper nothing matched (a fallback lead) is not an unresolved match.
  const unresolved = params.paperMatches.filter(
    (match) =>
      match.basis.length > 0 &&
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

function applyReadStrategyBudgets(
  input: NormalizedLibraryRetrieveInput,
  strategy: ReturnType<typeof resolveLibraryChatReadStrategy>,
  scope: ScopeResolution,
): NormalizedLibraryRetrieveInput {
  if (strategy.resolvedStrategy !== "deep_synthesis") return input;
  const plannedPapers = Math.min(
    DEEP_SYNTHESIS_MAX_PAPERS,
    Math.max(0, scope.items.length || scope.totalItems),
  );
  if (plannedPapers <= 0) return input;
  return {
    ...input,
    maxFullTextPapers: Math.max(input.maxFullTextPapers, plannedPapers),
    perPaperTopK: Math.max(input.perPaperTopK, 2),
    maxTotalSnippets: Math.max(input.maxTotalSnippets, plannedPapers * 2),
  };
}

function snippetIsBodyEvidence(snippet: LibraryRetrieveSnippet): boolean {
  return isBodyEvidenceSection(snippet.sectionLabel, snippet.chunkKind);
}

function buildReadStrategyDiagnostics(params: {
  strategy: ReturnType<typeof resolveLibraryChatReadStrategy>;
  candidateRecords: ResourceRecord[];
  snippets: LibraryRetrieveSnippet[];
  frontier: LibraryRetrieveFrontier;
  /** Item ids of papers the snippet cap left without a passage. */
  budgetCutItemIds?: ReadonlySet<string>;
}): LibraryChatReadStrategyDiagnostics {
  const plannedRecords = params.candidateRecords;
  const snippetItemIds = new Set(
    params.snippets.map((snippet) => snippet.itemId),
  );
  const bodyItemIds = new Set(
    params.snippets
      .filter(snippetIsBodyEvidence)
      .map((snippet) => snippet.itemId),
  );
  const readablePlannedCount = plannedRecords.filter(
    (record) => record.paperContext,
  ).length;
  const unreadableReasons: string[] = [];
  for (const record of plannedRecords) {
    const itemId = String(record.target.itemId);
    if (params.budgetCutItemIds?.has(itemId)) {
      unreadableReasons.push(
        `${itemId}: not returned because the passage budget was full`,
      );
      continue;
    }
    if (!record.paperContext) {
      unreadableReasons.push(`${itemId}: no full-text attachment available`);
      continue;
    }
    if (!record.queryState.has("content_loaded")) {
      unreadableReasons.push(`${itemId}: full text was not loaded`);
      continue;
    }
    if (!snippetItemIds.has(itemId)) {
      unreadableReasons.push(`${itemId}: no snippet returned`);
      continue;
    }
    if (!bodyItemIds.has(itemId)) {
      unreadableReasons.push(
        `${itemId}: only abstract/front-matter snippets returned`,
      );
    }
  }
  const hasBodyCoverageForReadablePapers =
    readablePlannedCount > 0 && bodyItemIds.size >= readablePlannedCount;
  const frontierEntries = hasBodyCoverageForReadablePapers
    ? unreadableReasons
    : [
        ...params.frontier.needsSnippetExpansion.map(
          (itemId) => `${itemId}: needs snippet expansion`,
        ),
        ...params.frontier.needsCloseRead.map(
          (itemId) => `${itemId}: needs close reading`,
        ),
        ...unreadableReasons,
      ];
  const coverageFrontier = Array.from(new Set(frontierEntries)).slice(0, 50);
  const papersBodyRead = bodyItemIds.size;
  const papersMetadataOnly = plannedRecords.filter(
    (record) => !bodyItemIds.has(String(record.target.itemId)),
  ).length;
  const stopReason = !coverageFrontier.length
    ? "enough_evidence"
    : params.frontier.stopReason === "enough_evidence"
      ? "unreadable_sources"
      : params.frontier.stopReason;
  return completeLibraryChatReadStrategyDiagnostics({
    base: params.strategy,
    papersPlanned: plannedRecords.length,
    papersBodyRead,
    papersMetadataOnly,
    unreadableReasons,
    coverageFrontier,
    stopReason,
  });
}

function buildAnswerContract(params: {
  input: NormalizedLibraryRetrieveInput;
  readStrategy: LibraryChatReadStrategyDiagnostics;
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
      "Do not make full-text presence or absence claims from this result; a title or author lookup with library_search can show that a paper is absent from the library.",
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
    ...params.readStrategy,
    metadataCoverage,
    indexedTextCoverage,
    snippetCoverage,
    safeClaims: Array.from(new Set(safeClaims)),
    unsafeClaims: Array.from(new Set(unsafeClaims)),
  };
}

type LibraryRetrieveParams = LibraryRetrieveInput & {
  request?: AgentRuntimeRequest;
  item?: Zotero.Item | null;
  model?: string;
  apiBase?: string;
  apiKey?: string;
  authMode?: AgentRuntimeRequest["authMode"];
  providerProtocol?: AgentRuntimeRequest["providerProtocol"];
  profileOverride?: ModelProfileOverride;
  signal?: AbortSignal;
};

export type LibraryRetrieveServiceOptions = {
  /** Planner wait cap while the index is on (default INDEX_PLANNER_SOFT_DEADLINE_MS). */
  plannerSoftDeadlineMs?: number;
  /** Query planner override (tests inject a fake). */
  queryPlanner?: typeof resolveRetrievalQueryPlan;
};

export class LibraryRetrieveService {
  constructor(
    private readonly zoteroGateway: ZoteroGateway,
    private readonly pdfService: PdfService,
    private readonly candidateBuilder: CandidateBuilder = buildPaperRetrievalCandidates,
    private readonly probeReformulator: typeof generateRetrievalProbeReformulation = generateRetrievalProbeReformulation,
    private readonly triage: typeof triageCandidatesWithModel = triageCandidatesWithModel,
    private readonly textIndex: LibraryTextIndexFacade = libraryTextIndex,
    private readonly queryEmbedder: LibraryQueryEmbedder = defaultQueryEmbedder,
    private readonly options: LibraryRetrieveServiceOptions = {},
  ) {}

  /**
   * One query embedding per distinct semantic query text for the whole
   * retrieve, instead of one per paper inside the candidate builder. Returns
   * undefined when semantic retrieval is off, so no embedding is ever spent.
   * A failed or empty embedding resolves to `[]`, which the builder reads as
   * "rank without embeddings" — the same outcome as its own per-paper failure,
   * without retrying the provider for every paper.
   */
  private createQueryEmbeddingMemo(
    input: NormalizedLibraryRetrieveInput,
    signal?: AbortSignal,
  ): QueryEmbeddingMemo | undefined {
    if (!input.methods.includes("semantic")) return undefined;
    let enabled = false;
    try {
      enabled = this.queryEmbedder.isEnabled();
    } catch {
      enabled = false;
    }
    if (!enabled) return undefined;
    const memo = new Map<string, Promise<number[]>>();
    return (text) => {
      let pending = memo.get(text);
      if (!pending) {
        pending = this.queryEmbedder
          .embed(text, signal)
          .then((vector) => (Array.isArray(vector) ? vector : []))
          .catch((error) => {
            appLogger.warn(
              "Query embedding failed; ranking without embeddings:",
              error,
            );
            return [];
          });
        memo.set(text, pending);
      }
      return pending;
    };
  }

  /**
   * Runs the query planner. While the index serves this retrieve (index on,
   * a depth that searches text) and a model is configured, the planner gets
   * a soft deadline: past it, the literal plan is used and the late plan is
   * discarded. Pool and metadata depths never search the index, so they
   * wait for the planner as before.
   */
  private async planQuery(
    params: LibraryRetrieveParams,
    plannerParams: Parameters<typeof resolveRetrievalQueryPlan>[0],
    hasModelConfig: boolean,
    depth: LibraryRetrieveDepth,
    timer: RetrievalTimer,
    warnings: string[],
  ): Promise<RetrievalQueryPlan> {
    const planner = this.options.queryPlanner ?? resolveRetrievalQueryPlan;
    const plannerPromise = planner(plannerParams);
    const softDeadline =
      hasModelConfig &&
      depth !== "pool" &&
      depth !== "metadata" &&
      this.textIndex.isEnabled()
        ? (this.options.plannerSoftDeadlineMs ?? INDEX_PLANNER_SOFT_DEADLINE_MS)
        : null;
    if (softDeadline === null) return plannerPromise;
    // A late plan is discarded; swallow its rejection so it is never unhandled.
    void plannerPromise.catch(() => undefined);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<RetrievalQueryPlan>((resolve) => {
      deadlineTimer = setTimeout(() => {
        timer.count("plannerTimedOut");
        warnings.push(
          `Query planner exceeded ${Math.round(softDeadline / 1000)} s; searched with the literal query.`,
        );
        resolve(
          buildRetrievalQueryPlan({
            query: params.query,
            queryVariants: params.queryVariants,
            readIntent: plannerParams.readIntent,
          }),
        );
      }, softDeadline);
    });
    try {
      return await Promise.race([plannerPromise, deadline]);
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  async retrieve(
    params: LibraryRetrieveParams,
  ): Promise<LibraryRetrieveResult> {
    const timer = createRetrievalTimer();
    // The background indexer backs off while a question is being answered.
    const endActivity = beginRetrievalActivity();
    try {
      return await this.retrieveTimed(params, timer);
    } finally {
      endActivity();
      const report = timer.finish();
      recordRetrievalTiming(report);
      appLogger.debug("LLM retrieve timing", report);
    }
  }

  private async retrieveTimed(
    params: LibraryRetrieveParams,
    timer: RetrievalTimer,
  ): Promise<LibraryRetrieveResult> {
    const requestedIntent = params.intent;
    const requestedDepth = params.depth;
    // Resolve the scope before planning (it only reads scope/budget inputs)
    // so the query planner can see corpus samples for language and
    // vocabulary matching.
    const provisionalInput = normalizeInput(params, params.request);
    const scope = await timer.span("scope", () =>
      this.resolveScope(provisionalInput, params.request, params.item),
    );
    const warnings: string[] = [];
    const hasModelConfig = Boolean(
      params.apiBase ||
      params.apiKey ||
      params.request?.apiBase ||
      params.request?.apiKey,
    );
    const queryPlan = await timer.span("plan", () =>
      this.planQuery(
        params,
        {
          query: params.query,
          queryVariants: params.queryVariants,
          readIntent: "targeted",
          hasRetrievalContext:
            requestedDepth !== "verify" && requestedIntent !== "verify",
          model: params.model || params.request?.model,
          apiBase: params.apiBase || params.request?.apiBase,
          apiKey: params.apiKey || params.request?.apiKey,
          authMode: params.authMode || params.request?.authMode,
          providerProtocol:
            params.providerProtocol || params.request?.providerProtocol,
          profileOverride:
            params.profileOverride || params.request?.advanced?.profileOverride,
          signal: params.signal,
          sourceSamples: this.buildScopeSourceSamples(scope),
        },
        hasModelConfig,
        provisionalInput.depth,
        timer,
        warnings,
      ),
    );
    queryPlan.quoteAnchorPolicy = "none";
    let input = normalizeInput(params, params.request, queryPlan);
    for (const note of new Set(input.queryPlan.notes)) {
      warnings.push(`Query planner: ${note}`);
    }
    const methodsUsed = new Set<LibraryRetrieveMethod>();
    const readStrategyBase = resolveLibraryChatReadStrategy({
      intent: input.intent,
      depth: input.depth,
      paperCount: scope.totalItems,
      scopeType: scope.type,
      explicitPaperScope: Boolean(scope.explicitItemIds.length),
    });
    input = applyReadStrategyBudgets(input, readStrategyBase, scope);
    // Later input rebuilds (probe rounds) keep `methods`, so one memo serves
    // every paper; it is keyed by the exact text the builder would embed.
    const embedQuery = this.createQueryEmbeddingMemo(input, params.signal);
    warnings.push(...scope.warnings);
    const metadataComplete = scope.totalItems <= scope.items.length;
    if (scope.totalItems > scope.items.length) {
      warnings.push(
        `Metadata budget inspected ${scope.items.length}/${scope.totalItems} scoped items. Raise maxMetadataItems to inspect more.`,
      );
    }

    const records = timer.spanSync("records", () =>
      this.buildResourceRecords(scope.items, input),
    );
    let poolBm25Corpus: ReturnType<typeof buildChunkIndex> | undefined;
    const rescorePoolBm25 = (queryPlan: RetrievalQueryPlan): void => {
      if (!queryPlan.lexicalTerms.length || !records.length) return;
      timer.spanSync("pool_bm25", () => {
        poolBm25Corpus ??= buildChunkIndex(
          records.map((record) =>
            [record.target.title, record.abstractText]
              .filter(Boolean)
              .join("\n"),
          ),
        );
        this.applyPoolBm25Scores(records, queryPlan, poolBm25Corpus);
      });
    };
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

    rescorePoolBm25(input.queryPlan);

    // Library text index first. A null result (disabled, unavailable, or
    // failed) leaves every index rule below inert: today's path runs as is.
    const scopeAttachmentIds = records
      .map((record) => record.paperContext?.contextItemId)
      .filter((id): id is number => typeof id === "number");
    // Same reach as quicksearch's scan limit: a comprehensive intent ranks
    // every paper in scope, so the match count is the whole scope's. Chunk
    // rows are read only for the papers that can reach the shortlist.
    const indexScansScope =
      input.intent === "enumerate" ||
      input.intent === "verify" ||
      input.intent === "summarize";
    let indexTotalMatching = 0;
    let indexTruncated = false;
    const searchIndex = async (queries: string[]) => {
      const result = await this.textIndex.search({
        scopeAttachmentIds,
        queries: queries.length ? queries : [input.query],
        maxPapers: indexScansScope
          ? Math.max(scopeAttachmentIds.length, 1)
          : input.maxCandidatePapers,
        perPaperTopK: Math.max(
          wantedSectionsFor(input).length
            ? SECTION_STEERING_FETCH_FACTOR * input.perPaperTopK
            : input.perPaperTopK,
          5,
        ),
        chunkPapers: input.maxCandidatePapers,
      });
      if (result) {
        const total = result.totalMatchingPapers ?? result.papers.length;
        indexTotalMatching = Math.max(indexTotalMatching, total);
        // Matches past maxPapers were never seen: the scan is not complete.
        if (total > result.papers.length) indexTruncated = true;
      }
      return result;
    };
    const indexResult =
      input.depth === "pool" ||
      input.depth === "metadata" ||
      !this.textIndex.isEnabled()
        ? null
        : await timer.span("index_search", () =>
            searchIndex(input.queryPlan.effectiveQueries),
          );
    const indexHitsByAttachment = new Map<number, IndexedChunkHit[]>();
    const collectIndexHits = (chunks: IndexedChunkHit[]) => {
      for (const hit of chunks) {
        const list = indexHitsByAttachment.get(hit.attachmentId) || [];
        if (list.some((known) => known.chunkIndex === hit.chunkIndex)) continue;
        list.push(hit);
        indexHitsByAttachment.set(hit.attachmentId, list);
      }
    };
    let indexCoversScope = false;
    if (indexResult) {
      timer.count("indexChunks", indexResult.chunks.length);
      const unindexed = new Set(indexResult.coverage.unindexed);
      for (const record of records) {
        record.indexed = Boolean(
          record.paperContext &&
          !unindexed.has(record.paperContext.contextItemId),
        );
      }
      this.applyIndexPapers(records, indexResult.papers, methodsUsed);
      collectIndexHits(indexResult.chunks);
      indexCoversScope =
        indexResult.coverage.scopeAttachments > 0 &&
        indexResult.coverage.indexed / indexResult.coverage.scopeAttachments >=
          INDEX_COVERAGE_SKIP_PROBES_RATIO;
    }
    // At full coverage only the reformulation-round quicksearch rescans are
    // skipped (variants go to the index). The first pass always runs: it is
    // the only path to matches in child notes, annotations and second PDFs,
    // and below the ratio to papers the index does not hold yet.
    const skipProbes = indexCoversScope;

    let probeRounds = 0;
    const variantsTried = new Set(
      buildQuicksearchProbes(input.queryPlan).map((probe) =>
        probe.toLowerCase(),
      ),
    );
    if (
      input.depth !== "pool" &&
      input.depth !== "metadata" &&
      (input.methods.includes("fts") || input.methods.includes("exact"))
    ) {
      indexedScan = await timer.span("quicksearch", () =>
        this.addQuicksearchMatches(scope, records, input, warnings),
      );
      if (input.methods.includes("fts")) methodsUsed.add("fts");

      const probeDeadline = Date.now() + PROBE_LOOP_DEADLINE_MS;
      await timer.span("probe_loop", async () => {
        while (
          hasModelConfig &&
          probeRounds < MAX_EXTRA_PROBE_ROUNDS &&
          this.countMatchedRecords(records, input.queryPlan) <
            PROBE_WEAK_MATCH_THRESHOLD &&
          Date.now() < probeDeadline &&
          !params.signal?.aborted
        ) {
          const matchedProbes = Array.from(
            new Set(
              records.flatMap((record) =>
                Array.from(record.matchedQueryVariants),
              ),
            ),
          ).slice(0, 8);
          const reformulation = await this.probeReformulator({
            query: input.query,
            triedProbes: Array.from(variantsTried),
            matchedProbes,
            scopeTitles: scope.items
              .slice(0, 8)
              .map((item) => item.title)
              .filter(Boolean),
            model: params.model || params.request?.model,
            apiBase: params.apiBase || params.request?.apiBase,
            apiKey: params.apiKey || params.request?.apiKey,
            authMode: params.authMode || params.request?.authMode,
            providerProtocol:
              params.providerProtocol || params.request?.providerProtocol,
            profileOverride:
              params.profileOverride ||
              params.request?.advanced?.profileOverride,
            signal: params.signal,
          });
          warnings.push(...reformulation.notes);
          const freshVariants = Array.from(
            new Set(
              reformulation.variants
                .map((variant) => variant.trim())
                .filter(Boolean),
            ),
          ).filter((variant) => !variantsTried.has(variant.toLowerCase()));
          if (!freshVariants.length) break;
          probeRounds += 1;
          for (const variant of freshVariants) {
            variantsTried.add(variant.toLowerCase());
          }
          // Fresh variants go first so the variant cap trims older ones.
          input = {
            ...input,
            queryPlan: buildRetrievalQueryPlan({
              query: input.query,
              queryVariants: [...freshVariants, ...input.queryPlan.variants],
              maxVariants: RETRIEVAL_QUERY_VARIANT_HARD_LIMIT,
              notes: input.queryPlan.notes,
              readIntent: input.queryPlan.readIntent,
            }),
          };
          if (indexResult) {
            // Variants search the index (milliseconds) and merge paper hits
            // by max score.
            const round = await timer.span("index_search", () =>
              searchIndex(freshVariants),
            );
            if (round) {
              this.applyIndexPapers(records, round.papers, methodsUsed);
              collectIndexHits(round.chunks);
            }
          }
          if (!skipProbes) {
            const rescan = await this.addQuicksearchMatches(
              scope,
              records,
              input,
              warnings,
              {
                probesOverride: freshVariants
                  .flatMap((variant) => expandProbeText(variant))
                  .slice(0, QUICKSEARCH_MAX_PROBES),
              },
            );
            indexedScan = {
              available: Math.max(indexedScan.available, rescan.available),
              scanned: Math.max(indexedScan.scanned, rescan.scanned),
              matched: indexedScan.matched,
              truncated: indexedScan.truncated || rescan.truncated,
            };
          }
          rescorePoolBm25(input.queryPlan);
        }
      });
      indexedScan = {
        ...indexedScan,
        matched: records.filter(
          (record) => record.quicksearchMatched || record.indexMatched,
        ).length,
      };
    }

    const maxBm25 = records.reduce(
      (max, record) => Math.max(max, record.bm25Score),
      0,
    );
    for (const record of records) {
      record.score =
        record.metadataScore +
        record.ftsScore +
        (maxBm25 > 0 ? (record.bm25Score / maxBm25) * BM25_BLEND_WEIGHT : 0) +
        record.indexScore +
        (record.paperContext ? 0.5 : 0);
      if (record.metadataScore > 0) {
        record.queryState.add("matched_metadata");
      }
      if (recordBm25Matched(record)) {
        record.queryState.add("matched_bm25");
      }
    }

    const sorted = records.slice().sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.paperContext && !right.paperContext) return -1;
      if (!left.paperContext && right.paperContext) return 1;
      // Neutral, deterministic ties: raw lexical strength, then library id.
      // Never the title: alphabetical order is not relevance and would favor
      // some papers on every tied query.
      if (right.bm25Score !== left.bm25Score) {
        return right.bm25Score - left.bm25Score;
      }
      return left.target.itemId - right.target.itemId;
    });

    const matchedRecords = sorted.filter(recordMatchedQuery);
    const shouldPreferMatchedLedger =
      input.intent === "enumerate" ||
      input.intent === "verify" ||
      input.intent === "summarize";
    const shouldUseBoundedSynthesisPool =
      readStrategyBase.resolvedStrategy === "deep_synthesis" &&
      scope.totalItems <= DEEP_SYNTHESIS_MAX_PAPERS;
    const fallbackEligible =
      shouldPreferMatchedLedger &&
      scope.type !== "items" &&
      !shouldUseBoundedSynthesisPool;
    // A near-empty matched ledger must not silently produce zero candidates:
    // fall back to the top-scored pool slice and say so.
    const usedPoolFallback =
      fallbackEligible &&
      matchedRecords.length <
        Math.min(LIBRARY_RETRIEVE_MIN_MATCHED_SHORTLIST, sorted.length) &&
      sorted.length > matchedRecords.length;
    const candidateSource = shouldUseBoundedSynthesisPool
      ? sorted
      : fallbackEligible
        ? usedPoolFallback
          ? sorted
          : matchedRecords
        : sorted;
    if (usedPoolFallback && input.depth !== "pool") {
      warnings.push(
        `Lexical/metadata matching found only ${matchedRecords.length} direct match(es) in this scope; returning the top-scored pool slice instead (LOW CONFIDENCE). Treat unmatched candidates as leads to verify, not evidence.`,
      );
    }
    let candidateRecords =
      input.depth === "pool"
        ? []
        : candidateSource.slice(0, input.maxCandidatePapers);
    candidateRecords.forEach((record) => record.queryState.add("shortlisted"));

    // Evidence triage: when the lexical ordering is known-unreliable (pool
    // fallback, or far more matches than expansion slots), one bounded LLM
    // call picks which papers get the snippet slots and what to look for in
    // each. Null keeps today's ordering.
    let triagePerPaperQueries: Record<string, string> | undefined;
    const shouldTriage =
      input.depth !== "pool" &&
      candidateRecords.length > 1 &&
      (usedPoolFallback ||
        matchedRecords.length > input.maxFullTextPapers * 2) &&
      hasModelConfig;
    if (shouldTriage) {
      const triageResult = await timer.span("triage", () =>
        this.triage({
          query: input.query,
          intent: input.intent,
          candidates: candidateRecords
            .slice(0, TRIAGE_MAX_CANDIDATES)
            .map((record) => ({
              itemId: String(record.target.itemId),
              title: record.target.title,
              abstract: truncateText(record.abstractText, 300),
              matchedVia: record.why.slice(0, 2).join("; "),
            })),
          maxSelect: input.maxFullTextPapers,
          model: params.model || params.request?.model,
          apiBase: params.apiBase || params.request?.apiBase,
          apiKey: params.apiKey || params.request?.apiKey,
          authMode: params.authMode || params.request?.authMode,
          providerProtocol:
            params.providerProtocol || params.request?.providerProtocol,
          profileOverride:
            params.profileOverride || params.request?.advanced?.profileOverride,
          signal: params.signal,
        }),
      );
      if (triageResult) {
        const rank = new Map(
          triageResult.selectedItemIds.map((itemId, index) => [itemId, index]),
        );
        // Stable sort: selected papers first in triage order, the rest keep
        // their lexical relative order.
        candidateRecords.sort((left, right) => {
          const leftRank = rank.get(String(left.target.itemId));
          const rightRank = rank.get(String(right.target.itemId));
          if (leftRank !== undefined && rightRank !== undefined) {
            return leftRank - rightRank;
          }
          if (leftRank !== undefined) return -1;
          if (rightRank !== undefined) return 1;
          return 0;
        });
        triagePerPaperQueries = triageResult.perPaperQueries;
        warnings.push("Candidate triage refined selection by LLM.");
        const suggestedProbes = triageResult.suggestedProbes || [];
        const triageProbes = suggestedProbes
          .flatMap((probe) => expandProbeText(probe))
          .filter((probe) => !variantsTried.has(probe.toLowerCase()))
          .slice(0, QUICKSEARCH_MAX_PROBES);
        if (
          triageProbes.length &&
          input.depth !== "metadata" &&
          probeRounds < MAX_EXTRA_PROBE_ROUNDS &&
          this.countMatchedRecords(records, input.queryPlan) <
            PROBE_WEAK_MATCH_THRESHOLD &&
          !params.signal?.aborted
        ) {
          probeRounds += 1;
          for (const probe of triageProbes) {
            variantsTried.add(probe.toLowerCase());
          }
          // Mirror the reformulation loop: fold the probes into the plan so
          // BM25 rescoring and downstream chunk retrieval see the new terms.
          input = {
            ...input,
            queryPlan: buildRetrievalQueryPlan({
              query: input.query,
              queryVariants: [...suggestedProbes, ...input.queryPlan.variants],
              maxVariants: RETRIEVAL_QUERY_VARIANT_HARD_LIMIT,
              notes: input.queryPlan.notes,
              readIntent: input.queryPlan.readIntent,
            }),
          };
          const previouslyMatched = new Set(
            records
              .filter((record) => record.quicksearchMatched)
              .map((record) => record.target.itemId),
          );
          const rescan = await this.addQuicksearchMatches(
            scope,
            records,
            input,
            warnings,
            { probesOverride: triageProbes },
          );
          indexedScan = {
            available: Math.max(indexedScan.available, rescan.available),
            scanned: Math.max(indexedScan.scanned, rescan.scanned),
            matched: records.filter((record) => record.quicksearchMatched)
              .length,
            truncated: indexedScan.truncated || rescan.truncated,
          };
          rescorePoolBm25(input.queryPlan);
          // Papers matched only by the rescan must be able to reach the
          // ledger and snippet expansion — counters alone would overstate
          // coverage the answer never saw.
          const candidateIds = new Set(
            candidateRecords.map((record) => record.target.itemId),
          );
          const discovered = records.filter(
            (record) =>
              record.quicksearchMatched &&
              !previouslyMatched.has(record.target.itemId) &&
              !candidateIds.has(record.target.itemId),
          );
          const merged = mergeRescanDiscoveries({
            shortlist: candidateRecords,
            discovered,
            isEstablished: (record) =>
              rank.has(String(record.target.itemId)) ||
              recordMatchedQuery(record),
            maxCandidatePapers: input.maxCandidatePapers,
          });
          for (const record of merged.displaced) {
            record.queryState.delete("shortlisted");
          }
          for (const record of merged.shortlist) {
            record.queryState.add("shortlisted");
          }
          candidateRecords = merged.shortlist;
          if (merged.droppedDiscoveries) {
            warnings.push(
              `${merged.droppedDiscoveries} paper(s) matched by the follow-up probes did not fit the candidate budget and were not read.`,
            );
          }
        }
      } else {
        warnings.push("LLM triage unavailable; kept lexical ranking.");
      }
    }

    const snippets: LibraryRetrieveSnippet[] = [];
    const budgetCutItemIds = new Set<string>();
    let snippetPapersExpanded = 0;
    let evidencePapers = 0;
    let fallbackRead = 0;
    let fallbackSkipped = 0;
    // Evidence depth defaults to body-first ranking: BM25 loves term-dense
    // abstracts/intros, which is exactly the "answers from the introduction"
    // failure this counteracts.
    const preferBodyEvidence =
      input.depth === "evidence" ||
      readStrategyBase.resolvedStrategy === "deep_synthesis" ||
      (readStrategyBase.resolvedStrategy === "evidence_overview" &&
        input.intent === "summarize");

    if (input.depth === "evidence" || input.depth === "verify") {
      const fullTextRecords = candidateRecords
        .filter((record) => record.paperContext)
        .slice(0, input.maxFullTextPapers);
      // Indexed papers answer from their index hits without loading text;
      // verify/exact scanning still needs the whole document.
      const useIndexSnippets =
        Boolean(indexResult) &&
        input.depth === "evidence" &&
        !input.requireExact;
      // Every paper read keeps at least one snippet, so reading stops once
      // as many papers returned one as the cap allows; the rest are cut by
      // the budget, not by their content.
      const readPapers: Array<{
        record: ResourceRecord;
        paperSnippets: LibraryRetrieveSnippet[];
      }> = [];
      for (const record of fullTextRecords) {
        if (readPapers.length >= input.maxTotalSnippets) {
          budgetCutItemIds.add(String(record.target.itemId));
          continue;
        }
        const maxSnippets = input.perPaperTopK;
        let paperSnippets: LibraryRetrieveSnippet[];
        if (useIndexSnippets && record.indexed && record.paperContext) {
          const queryOverride =
            triagePerPaperQueries?.[String(record.target.itemId)];
          const wantedSections = wantedSectionsFor(input, queryOverride);
          const hits = await timer.span("index_search", () =>
            this.indexHitsForPaper({
              attachmentId: record.paperContext!.contextItemId,
              passHits: indexHitsByAttachment.get(
                record.paperContext!.contextItemId,
              ),
              queryOverride,
              maxSnippets,
              fetch: wantedSections.length
                ? SECTION_STEERING_FETCH_FACTOR * maxSnippets
                : maxSnippets,
            }),
          );
          paperSnippets = this.snippetsFromIndexHits({
            record,
            hits,
            maxSnippets,
            preferBodyEvidence,
            wantedSections,
            fallbackTerms: input.queryPlan.lexicalTerms,
          });
          // Loaded only when the index actually served text for the paper.
          if (hits.length) record.queryState.add("content_loaded");
        } else {
          if (indexResult && !record.indexed) {
            // Capped only where the index serves evidence; verify/exact
            // scans every shortlisted paper, as without the index.
            if (
              useIndexSnippets &&
              fallbackRead >= MAX_UNINDEXED_FALLBACK_PAPERS
            ) {
              fallbackSkipped += 1;
              continue;
            }
            fallbackRead += 1;
          }
          paperSnippets = await timer.span(
            indexResult && !record.indexed
              ? "fallback_snippets"
              : "paper_snippets",
            () =>
              this.retrievePaperSnippets({
                record,
                input,
                maxSnippets,
                preferBodyEvidence,
                queryOverride:
                  triagePerPaperQueries?.[String(record.target.itemId)],
                apiBase: params.apiBase,
                apiKey: params.apiKey,
                embedQuery,
                methodsUsed,
                warnings,
              }),
          );
        }
        timer.count("papersTouched");
        if (!record.queryState.has("content_loaded")) continue;
        snippetPapersExpanded += 1;
        record.resourceState.add("text_indexed");
        if (paperSnippets.length) readPapers.push({ record, paperSnippets });
      }
      // Papers without full text answer from their abstract: one passage
      // each, in rank order, outside the full-text paper count.
      const abstractPapers = input.methods.includes("abstract")
        ? candidateRecords.flatMap((record) => {
            const snippet = buildAbstractSnippet(record, input);
            return snippet ? [{ record, snippet }] : [];
          })
        : [];
      const { slots, abstractSlots } = allocateSnippetSlots(
        readPapers.map((paper) => paper.paperSnippets.length),
        input.maxTotalSnippets,
        abstractPapers.length,
      );
      abstractPapers.forEach(({ record, snippet }, index) => {
        if (index >= abstractSlots) {
          budgetCutItemIds.add(String(record.target.itemId));
          return;
        }
        record.queryState.add("snippet_returned");
        if (snippet.matchedQueryVariant)
          record.matchedQueryVariants.add(snippet.matchedQueryVariant);
        snippets.push(snippet);
      });
      readPapers.forEach(({ record, paperSnippets }, index) => {
        // Invariant: reading stopped at maxTotalSnippets papers and each read
        // paper holds at least one snippet, so every one gets a first slot
        // (allocateSnippetSlots) and `kept` is never empty.
        const kept = paperSnippets.slice(0, slots[index]);
        record.queryState.add("snippet_returned");
        evidencePapers += 1;
        snippets.push(...kept);
      });
      if (
        input.requireExact &&
        !snippets.some((snippet) => snippet.sourceKind !== "abstract")
      ) {
        warnings.push(
          "Verify mode found no exact passage snippets in the searched full-text candidates.",
        );
      }
    }
    if (indexResult && indexResult.coverage.unindexed.length) {
      const unindexedCount = indexResult.coverage.unindexed.length;
      const failedCount = indexResult.coverage.failed.length;
      const notRead = Math.max(0, unindexedCount - fallbackRead);
      warnings.push(
        `${unindexedCount} paper(s) in scope are not yet in the library text index${
          failedCount ? `, ${failedCount} could not be indexed` : ""
        }; ${fallbackRead} were read directly, ${notRead} were not read.`,
      );
    }
    if (indexResult && indexCoversScope) {
      // Coverage comes from the index, not from a quicksearch scan. Matches
      // count every paper the index matched, not only those it returned.
      indexedScan = {
        available: indexedTextAvailable,
        scanned: indexResult.coverage.indexed + fallbackRead,
        matched: Math.max(
          indexTotalMatching,
          records.filter(
            (record) => record.indexMatched || record.quicksearchMatched,
          ).length,
        ),
        truncated:
          indexTruncated ||
          fallbackSkipped > 0 ||
          indexResult.coverage.unindexed.length > fallbackRead,
      };
    } else if (indexResult) {
      // Quicksearch scanned the scope. Shortlisted papers outside the index
      // left unread past the fallback cap, or index matches cut at maxPapers,
      // mean the scan is not complete.
      indexedScan = {
        ...indexedScan,
        matched: Math.max(indexedScan.matched, indexTotalMatching),
        truncated:
          indexedScan.truncated || indexTruncated || fallbackSkipped > 0,
      };
    }

    const snippetQuotePack = timer.spanSync("rank", () =>
      attachQuoteCitationsToSnippets(
        this.dedupeAndRankSnippets(snippets).slice(0, input.maxTotalSnippets),
        {
          includeQuoteAnchors:
            input.depth === "verify" || input.intent === "verify",
        },
      ),
    );
    const dedupedSnippets = snippetQuotePack.snippets;
    const snippetPaperKeys = new Set(
      dedupedSnippets.map(
        (snippet) => `${snippet.itemId}:${snippet.contextItemId || ""}`,
      ),
    );
    evidencePapers = snippetPaperKeys.size;
    const workGroups = workGroupsFor(candidateRecords);
    const evidenceWorks = new Set(
      dedupedSnippets.map(
        (snippet) => workGroups.get(Number(snippet.itemId)) || snippet.itemId,
      ),
    ).size;
    const paperMatches = buildPaperMatches({
      records: candidateRecords,
      snippets: dedupedSnippets,
      maxMatches: input.maxCandidatePapers,
      budgetCutItemIds,
      workGroups,
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
    const readStrategy = buildReadStrategyDiagnostics({
      strategy: readStrategyBase,
      candidateRecords,
      snippets: dedupedSnippets,
      frontier,
      budgetCutItemIds,
    });
    const answerContract = buildAnswerContract({
      input,
      readStrategy,
      metadataComplete,
      indexedScan,
      paperMatches,
      snippetPapersExpanded,
      snippetCapHit,
    });
    if (answerContract.unsafeClaims.length) {
      warnings.push(...answerContract.unsafeClaims);
    }
    const coverageReceipt = buildLibraryChatCoverageReceipt(readStrategy);
    const evidencePack = buildLibraryRetrieveEvidencePack({
      papers: candidateRecords
        .map((record) => record.paperContext)
        .filter((paper): paper is PaperContextRef => Boolean(paper)),
      snippets: dedupedSnippets,
    });

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
          matchedBm25: records.filter((record) =>
            record.queryState.has("matched_bm25"),
          ).length,
          shortlisted: candidateRecords.length,
          indexedTextAvailable,
          indexedTextScanned: indexedScan.scanned,
          indexedTextMatched: indexedScan.matched,
          probeRounds,
          variantsTried: variantsTried.size,
          snippetPapersExpanded,
          fullTextSearched: snippetPapersExpanded,
          snippetsReturned: dedupedSnippets.length,
          evidencePapers,
          evidenceWorks,
          deepReadPapers: readStrategy.papersBodyRead,
        },
      },
      intent: input.intent,
      depth: input.depth,
      methodsUsed: Array.from(methodsUsed),
      candidates,
      paperMatches,
      frontier,
      answerContract,
      coverageReceipt,
      evidenceLedgerText: evidencePack.evidenceLedgerText,
      synthesisDigest: evidencePack.synthesisDigest,
      snippets: dedupedSnippets,
      quoteCitations: snippetQuotePack.quoteCitations.length
        ? snippetQuotePack.quoteCitations
        : undefined,
      warnings,
    };
  }

  private countMatchedRecords(
    records: ResourceRecord[],
    queryPlan: RetrievalQueryPlan,
  ): number {
    return records.filter(
      (record) =>
        record.indexMatched ||
        record.metadataScore > 0 ||
        record.ftsScore > 0 ||
        recordBm25Matched(record),
    ).length;
  }

  /** Blends index paper hits into the records, merging by max across rounds. */
  private applyIndexPapers(
    records: ResourceRecord[],
    papers: IndexedPaperHit[],
    methodsUsed: Set<LibraryRetrieveMethod>,
  ): void {
    const recordByAttachment = new Map<number, ResourceRecord>();
    for (const record of records) {
      if (record.paperContext) {
        recordByAttachment.set(record.paperContext.contextItemId, record);
      }
    }
    const best = papers.reduce((max, paper) => Math.max(max, paper.score), 0);
    for (const paper of papers) {
      const record = recordByAttachment.get(paper.attachmentId);
      if (!record) continue;
      const score = best > 0 ? (paper.score / best) * INDEX_BLEND_WEIGHT : 0;
      if (score <= record.indexScore) continue;
      record.indexScore = score;
      record.indexMatched = true;
      record.queryState.add("matched_bm25");
      record.resourceState.add("text_indexed");
      if (
        !record.why.some((why) => why.startsWith(INDEX_MATCH_REASON_PREFIX))
      ) {
        record.why.push(
          `${INDEX_MATCH_REASON_PREFIX} ${paper.matchingChunks} matching passage(s)`,
        );
      }
    }
    if (papers.length) methodsUsed.add("fts");
  }

  /**
   * The index chunks an indexed paper's evidence comes from: triage's
   * per-paper query searched against this paper alone, else the pass hits,
   * else the paper's leading body chunks (the direct path likewise admits
   * zero-score chunks, so a paper the index did not rank is still read).
   */
  private async indexHitsForPaper(params: {
    attachmentId: number;
    passHits?: IndexedChunkHit[];
    queryOverride?: string;
    maxSnippets: number;
    /** Hits this paper's own reads fetch: more than its slots while
     * ranking prefers sections. */
    fetch: number;
  }): Promise<IndexedChunkHit[]> {
    if (params.maxSnippets <= 0) return [];
    if (params.queryOverride) {
      const own = await this.textIndex.search({
        scopeAttachmentIds: [params.attachmentId],
        queries: [params.queryOverride],
        maxPapers: 1,
        perPaperTopK: params.fetch,
      });
      if (own?.chunks.length) return own.chunks;
    }
    // Pass hits merge across the first pass and the reformulation rounds;
    // the best-scoring ones take the paper's slots.
    if (params.passHits?.length)
      return params.passHits
        .slice()
        .sort(
          (a, b) =>
            b.hybridScore - a.hybridScore ||
            b.bm25Score - a.bm25Score ||
            a.chunkIndex - b.chunkIndex,
        );
    return (
      (await this.textIndex.leadingChunks(params.attachmentId, params.fetch)) ||
      []
    );
  }

  /**
   * Snippets for an indexed paper straight from its index hits, with the
   * same section ranking and body-first admission as `retrievePaperSnippets`.
   */
  private snippetsFromIndexHits(params: {
    record: ResourceRecord;
    hits: IndexedChunkHit[];
    maxSnippets: number;
    preferBodyEvidence: boolean;
    /** Sections the evidence should come from; their hits rank first. */
    wantedSections: readonly EvidenceSectionKind[];
    /** Query tokens to window on when a hit carries no matched terms. */
    fallbackTerms: string[];
  }): LibraryRetrieveSnippet[] {
    const paperContext = params.record.paperContext;
    if (!paperContext || params.maxSnippets <= 0) return [];
    const citationLabel = formatPaperCitationLabel(paperContext);
    const sourceLabel = formatPaperSourceLabel(paperContext);
    const ranked = params.wantedSections.length
      ? params.hits
          .map((hit) => ({
            hit,
            sectionLabel: hit.meta.sectionLabel,
            enclosingSection: hit.meta.enclosingSection,
            chunkKind: hit.meta.chunkKind,
            chunkIndex: hit.chunkIndex,
            title: hit.title || paperContext.title,
          }))
          .sort(
            compareEvidenceCandidatesForSections(
              params.wantedSections,
              (entry) => entry.hit.hybridScore,
            ),
          )
          .map((entry) => entry.hit)
      : params.hits;
    const isBody = (hit: IndexedChunkHit) =>
      admitsAsBodyEvidence(
        params.wantedSections,
        hit.meta.sectionLabel,
        hit.meta.chunkKind,
        hit.meta.enclosingSection,
        hit.title || paperContext.title,
      );
    // Body evidence fills the slots first; front matter is capped at one.
    const ordered = params.preferBodyEvidence
      ? [
          ...ranked.filter(isBody),
          ...ranked.filter((hit) => !isBody(hit)).slice(0, 1),
        ]
      : ranked;
    const snippets: LibraryRetrieveSnippet[] = [];
    for (const hit of ordered) {
      if (snippets.length >= params.maxSnippets) break;
      snippets.push({
        snippetId: `lr_${paperContext.itemId}_${paperContext.contextItemId}_${hit.chunkIndex}_bm25`,
        itemId: String(paperContext.itemId),
        contextItemId: String(paperContext.contextItemId),
        chunkIndex: hit.chunkIndex,
        title: hit.title || paperContext.title,
        citationLabel,
        sourceLabel,
        sourceKind: sourceKindFromSourceType(hit.sourceType, paperContext),
        matchMethod: "bm25",
        sectionLabel: renderSectionLabel(
          hit.meta.sectionLabel,
          hit.meta.enclosingSection,
          hit.title || paperContext.title,
        ),
        chunkKind: hit.meta.chunkKind,
        // Same convention as the direct path's BM25 snippets: no
        // charStart/charEnd/pageLabel (exact snippets carry chunk-relative
        // offsets; document offsets from the index would mean something else).
        snippet: indexSnippetText(
          hit.text,
          hit.matchedTerms.length ? hit.matchedTerms : params.fallbackTerms,
        ),
        quoteSource: hit.text,
        surroundingText: truncateText(hit.text, 1200),
        score: Number(
          (params.record.score + hit.evidenceScore * 10).toFixed(3),
        ),
        // A leading chunk served for an unranked paper matched nothing.
        ...(hit.hybridScore > 0 || hit.bm25Score > 0
          ? { whyMatched: "Library index BM25 ranked this passage highly" }
          : {
              whyMatched:
                "Leading passage of an indexed paper (no direct match)",
              leadingPassage: true as const,
            }),
      });
    }
    return snippets;
  }

  private applyPoolBm25Scores(
    records: ResourceRecord[],
    queryPlan: RetrievalQueryPlan,
    corpus: ReturnType<typeof buildChunkIndex>,
  ): void {
    const { chunkStats, docFreq, avgChunkLength } = corpus;
    records.forEach((record, index) => {
      const stats = chunkStats[index];
      if (!stats) return;
      record.bm25Score = scoreChunkBM25(
        stats,
        queryPlan.lexicalTerms,
        docFreq,
        records.length,
        avgChunkLength || 1,
      );
      // The corpus is keyed by index terms; one hit per index term, shown
      // by its first surface term ("errors" and "error" are one hit).
      const hitsByIndexTerm = new Map<string, string>();
      for (const term of queryPlan.lexicalTerms) {
        const indexTerm = toRetrievalIndexTerm(term);
        if (stats.tf[indexTerm] && !hitsByIndexTerm.has(indexTerm))
          hitsByIndexTerm.set(indexTerm, term);
      }
      const hits = [...hitsByIndexTerm.values()];
      record.bm25TermHits = hits.length;
      const distinctiveCeiling = Math.max(1, Math.floor(records.length / 2));
      record.bm25DistinctiveHits = [...hitsByIndexTerm.keys()].filter(
        (indexTerm) => (docFreq[indexTerm] || 0) <= distinctiveCeiling,
      ).length;
      if (recordBm25Matched(record)) {
        // The "abstract " prefix keeps recordHasAbstractMatch attributing
        // this basis correctly in the paper-match ledger.
        const why = `abstract bm25 match: ${hits.slice(0, 4).join(", ")}`;
        if (!record.why.includes(why)) record.why.push(why);
      }
    });
  }

  private buildScopeSourceSamples(scope: ScopeResolution): string[] {
    const withAbstract: string[] = [];
    const titleOnly: string[] = [];
    const snapshot = libraryIndexService.peekSnapshot(scope.libraryID);
    for (const target of scope.items.slice(0, 20)) {
      if (withAbstract.length >= 3) break;
      const indexed = snapshot?.itemById.get(target.itemId);
      const abstract = normalizeText(indexed?.abstractNote).slice(0, 240);
      const sample = [normalizeText(target.title), abstract]
        .filter(Boolean)
        .join("\n");
      if (!sample) continue;
      (abstract ? withAbstract : titleOnly).push(sample);
    }
    return [...withAbstract, ...titleOnly].slice(0, 3);
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
    const turnScope = request
      ? getTurnPaperScopeFromRequest(request)
      : undefined;
    const selectedCollections = !hasExplicitScope
      ? turnScope?.collections || []
      : [];
    const selectedTags = !hasExplicitScope ? turnScope?.tags || [] : [];
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
        explicitScope.libraryID ||
        inferredCollectionLibraryID ||
        inferredTagLibraryID,
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
    const tagContexts = selectedTags.length
      ? selectedTags
      : explicitTagContexts;

    if (explicitItemIds.length || collectionIds.length || tagContexts.length) {
      const resolved = await this.zoteroGateway.resolveLibraryScopeItemIds({
        libraryID,
        itemIds: explicitItemIds,
        collectionIds,
        tagContexts: [...tagContexts],
        // Papers the user removed from the task in Task progress.
        excludedItemIds: [
          ...selectedCollections.flatMap(
            (collection) => collection.excludedItemIds || [],
          ),
          ...selectedTags.flatMap((tag) => tag.excludedItemIds || []),
        ],
      });
      const cappedIds = resolved.itemIds.slice(0, input.maxMetadataItems);
      // Materialize each unique target exactly once, after the complete union
      // and the single metadata budget have been applied.
      const items =
        this.zoteroGateway.getBibliographicItemTargetsByItemIds(cappedIds);
      const included = new Set(items.map((target) => target.itemId));
      const filteredExplicitIds = explicitItemIds.filter((id) =>
        resolved.itemIds.includes(id),
      );
      if (filteredExplicitIds.length < explicitItemIds.length) {
        warnings.push(
          "Some explicit item IDs were not bibliographic items in the resolved library and were excluded.",
        );
      }
      if (
        resolved.summedScopeCount > resolved.itemIds.length &&
        collectionIds.length > 1
      ) {
        warnings.push(
          "Multiple collection totals may include overlapping items; retrieval uses unique item IDs.",
        );
      }
      if (
        resolved.summedScopeCount > resolved.itemIds.length &&
        tagContexts.length > 1
      ) {
        warnings.push(
          "Multiple tag totals may include overlapping items; retrieval uses unique item IDs.",
        );
      }
      if (
        resolved.summedScopeCount > resolved.itemIds.length &&
        collectionIds.length &&
        tagContexts.length
      ) {
        warnings.push(
          "Selected collection and tag totals may include overlapping items; retrieval uses unique item IDs.",
        );
      }
      const scopeKinds = [
        explicitItemIds.length ? "items" : "",
        collectionIds.length ? "collection" : "",
        tagContexts.length ? "tag" : "",
      ].filter(Boolean);
      const names = [
        ...(explicitItemIds.length
          ? [`${filteredExplicitIds.length} selected items`]
          : []),
        ...resolved.collectionNames,
        ...resolved.tagNames,
      ];
      return {
        type:
          scopeKinds.length > 1
            ? "mixed"
            : explicitItemIds.length
              ? "items"
              : collectionIds.length
                ? "collection"
                : "tag",
        name: names.join(" + "),
        libraryID,
        collectionIds,
        tagContexts: [...tagContexts],
        tagItemIds: resolved.tagItemIds.filter((id) => included.has(id)),
        explicitItemIds: filteredExplicitIds,
        items,
        totalItems: resolved.itemIds.length,
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
        bm25Score: 0,
        bm25TermHits: 0,
        bm25DistinctiveHits: 0,
        quicksearchMatched: false,
        indexScore: 0,
        indexMatched: false,
        indexed: false,
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
    options: { probesOverride?: string[] } = {},
  ): Promise<IndexedTextScanResult> {
    const probes = options.probesOverride?.length
      ? options.probesOverride
      : buildQuicksearchProbes(input.queryPlan, {
          includeFullPhrases: input.requireExact || input.depth === "verify",
        });
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
      const runQuicksearch = (query: string, allowedItemIds?: number[]) =>
        this.zoteroGateway.searchAllLibraryItems({
          libraryID: scope.libraryID,
          query,
          allowedItemIds,
          limit: scanLimit,
        });

      const scoped = Boolean(
        scope.collectionIds.length ||
        scope.tagContexts.length ||
        scope.explicitItemIds.length,
      );
      const allowedItemIds = scoped ? Array.from(byItemId.keys()) : undefined;
      // Probes run in parallel but merge in probe order, so matched-variant
      // order and the kept results equal the sequential loop's.
      const run = await mapWithConcurrency(
        probes,
        QUICKSEARCH_CONCURRENCY,
        (query) => runQuicksearch(query, allowedItemIds),
      );
      const kept = run.failedAt < 0 ? probes.length : run.failedAt;
      for (let index = 0; index < kept; index += 1) {
        const result = run.results[index];
        if (!result) continue;
        if (result.totalCount > result.items.length) scan.truncated = true;
        result.items.forEach((target) => mark(target.itemId, probes[index]));
      }
      if (run.failedAt >= 0) throw run.error;
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
    preferBodyEvidence?: boolean;
    /** Triage-provided per-paper question; falls back to the main query. */
    queryOverride?: string;
    apiBase?: string;
    apiKey?: string;
    /** Shared query embedding for this retrieve; absent when semantic is off. */
    embedQuery?: QueryEmbeddingMemo;
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
      const candidateTopK = params.preferBodyEvidence
        ? Math.max(params.maxSnippets, 5)
        : params.maxSnippets;
      const retrievalQuestion = params.queryOverride || params.input.query;
      // With a per-paper override, build a per-paper plan around it: the
      // shared plan's lexicalTerms would otherwise win (queryPlanTerms
      // precedence) and make the override a no-op, while dropping the plan
      // entirely would lose the corpus-language variants on exactly the
      // papers triage prioritized.
      const paperQueryPlan = params.queryOverride
        ? buildRetrievalQueryPlan({
            query: retrievalQuestion,
            queryVariants: params.input.queryPlan.variants,
            maxVariants: RETRIEVAL_QUERY_VARIANT_HARD_LIMIT,
            readIntent: params.input.queryPlan.readIntent,
          })
        : params.input.queryPlan;
      const wantedSections = wantedSectionsFor(
        params.input,
        params.queryOverride,
      );
      // The builder embeds `semanticQuery || question`; embed that same text.
      const semanticText = paperQueryPlan.semanticQuery || retrievalQuestion;
      const precomputedQueryEmbedding =
        params.embedQuery && semanticText.trim()
          ? await params.embedQuery(semanticText)
          : undefined;
      const sharedEmbedding = precomputedQueryEmbedding
        ? { precomputedQueryEmbedding }
        : {};
      const candidates = await this.candidateBuilder(
        paperContext,
        pdfContext,
        retrievalQuestion,
        {
          apiBase: params.apiBase,
          apiKey: params.apiKey,
          disableEmbeddings: !params.input.methods.includes("semantic"),
          queryPlan: paperQueryPlan,
          ...sharedEmbedding,
        },
        {
          topK: candidateTopK,
          mode: "evidence",
          disableEmbeddings: !params.input.methods.includes("semantic"),
          queryPlan: paperQueryPlan,
          ...sharedEmbedding,
        },
      ).then((rows) =>
        params.preferBodyEvidence
          ? rows.sort(
              compareEvidenceCandidatesForSections(
                wantedSections,
                (candidate) =>
                  candidate.evidenceScore || candidate.hybridScore || 0,
              ),
            )
          : rows,
      );
      const seenChunks = new Set(
        snippets
          .map((snippet) => snippetChunkKey(snippet))
          .filter((key): key is string => Boolean(key)),
      );
      const admitCandidate = (candidate: PaperContextCandidate): boolean => {
        if (snippets.length >= params.maxSnippets) return false;
        const matchMethod = matchMethodFromCandidate(
          candidate,
          params.input.methods.includes("semantic"),
        );
        if (matchMethod === "semantic") params.methodsUsed.add("semantic");
        const key = candidateChunkKey(candidate);
        if (seenChunks.has(key)) return false;
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
          sectionLabel: renderSectionLabel(
            candidate.sectionLabel,
            candidate.enclosingSection,
            candidate.title,
          ),
          chunkKind: candidate.chunkKind,
          snippet: truncateText(candidate.chunkText, 900),
          quoteSource: candidate.chunkText,
          surroundingText: truncateText(candidate.chunkText, 1200),
          score: Number(
            (params.record.score + candidate.evidenceScore * 10).toFixed(3),
          ),
          matchedQueryVariant: candidate.matchedQueryVariant,
          // A chunk no query signal ranked is the paper's leading passage.
          ...(candidate.why?.querySignal === "none"
            ? {
                whyMatched: "Leading passage of a paper (no direct match)",
                leadingPassage: true as const,
              }
            : {
                whyMatched:
                  matchMethod === "semantic"
                    ? "Semantic retrieval ranked this passage highly"
                    : "Full-text BM25 retrieval ranked this passage highly",
              }),
        });
        return true;
      };
      if (params.preferBodyEvidence) {
        // Body evidence fills the slots first; front matter (abstract/intro)
        // is capped at one snippet and only when slots remain. Exact-match
        // snippets above are exempt — verify mode keeps literal hits — and
        // so is a section the request names, such as the abstract (never a
        // reference list).
        const isFrontMatterCandidate = (candidate: PaperContextCandidate) =>
          !admitsAsBodyEvidence(
            wantedSections,
            candidate.sectionLabel,
            candidate.chunkKind,
            candidate.enclosingSection,
            candidate.title,
          );
        for (const candidate of candidates) {
          if (isFrontMatterCandidate(candidate)) continue;
          if (snippets.length >= params.maxSnippets) break;
          admitCandidate(candidate);
        }
        let frontMatterAdmitted = 0;
        for (const candidate of candidates) {
          if (!isFrontMatterCandidate(candidate)) continue;
          if (frontMatterAdmitted >= 1) break;
          if (snippets.length >= params.maxSnippets) break;
          if (admitCandidate(candidate)) frontMatterAdmitted += 1;
        }
      } else {
        for (const candidate of candidates) {
          if (snippets.length >= params.maxSnippets) break;
          admitCandidate(candidate);
        }
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
    // Walk every chunk (bounded by the paper's chunk count, ~77 on average):
    // stopping at the first maxSnippets matches would keep the earliest, not
    // the strongest, ones.
    for (let index = 0; index < params.pdfContext.chunks.length; index += 1) {
      const chunk = params.pdfContext.chunks[index] || "";
      const match = findExactMatchForQueryPlan(chunk, params.queryPlan);
      if (!match) continue;
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
        sectionLabel: renderSectionLabel(
          meta?.sectionLabel,
          meta?.enclosingSection,
          params.paperContext.title,
        ),
        chunkKind: meta?.chunkKind,
        charStart: match.start,
        charEnd: match.end,
        snippet: snippetTextAround(chunk, match.start, match.end),
        quoteSource: chunk,
        surroundingText: truncateText(chunk, 1200),
        score: Number((params.record.score + match.score).toFixed(3)),
        whyMatched: match.reason,
        matchedQueryVariant: match.matchedQueryVariant,
      });
    }
    // Stable sort: equal scores keep document order (earlier chunk first).
    const top = snippets
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(0, params.maxSnippets));
    for (const snippet of top) {
      params.record.matchedQueryVariants.add(snippet.matchedQueryVariant!);
    }
    return top;
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

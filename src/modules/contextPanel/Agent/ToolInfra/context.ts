import { formatPaperCitationLabel } from "../../paperAttribution";
import {
  TOKEN_ESTIMATE_CHARS_PER_TOKEN,
  estimateTextTokens,
} from "../../../../utils/modelInputCap";
import { CHUNK_TARGET_LENGTH } from "../../constants";
import {
  countQuickSearchRegularItems,
  listLibraryPaperCandidates,
  searchPaperCandidates,
  type PaperSearchGroupCandidate,
} from "../../paperSearch";
import { sanitizeText } from "../../textUtils";
import type { PaperContextRef } from "../../types";
import { AGENT_METADATA_PREFIX_RATIO } from "../config";

/** Minimal plan shape consumed by resolveAgentContext. */
type AgentContextPlan = {
  action?: string;
  searchQuery?: string;
  maxPapersToRead?: number;
};

export type AgentContextResolution = {
  mode: "library-overview" | "library-search";
  contextPrefix: string;
  paperContexts: PaperContextRef[];
  pinnedPaperContexts: PaperContextRef[];
  statusText: string;
  traceLines: string[];
};

function normalizeQuestionText(value: string): string {
  return sanitizeText(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function hasLibraryReference(normalizedQuestion: string): boolean {
  return (
    /\b(?:my|the|this)\s+(?:zotero\s+)?(?:library|collection)\b/.test(
      normalizedQuestion,
    ) ||
    /\b(?:in|from|within|across)\s+(?:my|the|this)\s+(?:zotero\s+)?(?:library|collection)\b/.test(
      normalizedQuestion,
    ) ||
    /\bzotero\s+library\b/.test(normalizedQuestion)
  );
}

function isCountIntentQuestion(question: string): boolean {
  const normalizedQuestion = normalizeQuestionText(question);
  if (!normalizedQuestion) return false;
  return /\b(?:how many|count|number of|total number|how much)\b/.test(
    normalizedQuestion,
  );
}

export function isLibraryOverviewQuery(question: string): boolean {
  const normalizedQuestion = normalizeQuestionText(question);
  if (!normalizedQuestion) return false;
  return [
    /\b(?:read|scan|summari[sz]e|overview|review|analy[sz]e|describe|tell me about)\b.*\b(?:my|the|this)\s+(?:zotero\s+)?(?:library|collection)\b/,
    /\b(?:whole|entire|full|complete)\s+(?:zotero\s+)?(?:library|collection)\b/,
    /\bwhat(?:'s| is)\s+in\s+(?:my|the|this)\s+(?:zotero\s+)?(?:library|collection)\b/,
    /\b(?:all|every)\s+(?:papers?|articles?|studies?)\s+in\s+(?:my|the|this)\s+(?:zotero\s+)?(?:library|collection)\b/,
  ].some((pattern) => pattern.test(normalizedQuestion));
}

export function isLibraryScopedSearchQuery(
  question: string,
  conversationMode: "paper" | "open",
): boolean {
  const normalizedQuestion = normalizeQuestionText(question);
  if (!normalizedQuestion || isLibraryOverviewQuery(normalizedQuestion)) {
    return false;
  }
  if (hasLibraryReference(normalizedQuestion)) {
    return true;
  }
  if (conversationMode !== "open") {
    return false;
  }
  return (
    (/\b(?:which|find|show|list|compare|review|search|look for)\b/.test(
      normalizedQuestion,
    ) &&
      /\b(?:paper|papers|study|studies|article|articles|author|authors|work|works)\b/.test(
        normalizedQuestion,
      )) ||
    /\bwhat\s+(?:papers|studies|articles|authors|works)\b/.test(
      normalizedQuestion,
    )
  );
}

function buildPaperContextRef(
  candidate: PaperSearchGroupCandidate,
): PaperContextRef | null {
  const attachment = candidate.attachments[0];
  if (!attachment) return null;
  return {
    itemId: candidate.itemId,
    contextItemId: attachment.contextItemId,
    title: candidate.title,
    citationKey: candidate.citationKey,
    firstCreator: candidate.firstCreator,
    year: candidate.year,
  };
}

function formatTracePaperLabel(candidate: PaperSearchGroupCandidate): string {
  const ref = buildPaperContextRef(candidate);
  if (!ref) return candidate.title;
  const citation = formatPaperCitationLabel(ref);
  return citation ? `${citation} - ${candidate.title}` : candidate.title;
}

function buildSelectedPaperTraceLine(
  candidates: PaperSearchGroupCandidate[],
): string {
  const labels = candidates
    .slice(0, 4)
    .map((candidate) => formatTracePaperLabel(candidate));
  if (!labels.length) return "";
  return `Selected papers: ${labels.join(" | ")}`;
}

function clampReadLimit(value: number | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function dedupePaperContexts(values: PaperContextRef[]): PaperContextRef[] {
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = `${value.itemId}:${value.contextItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function formatPaperListLine(
  candidate: PaperSearchGroupCandidate,
  index: number,
): string {
  const ref = buildPaperContextRef(candidate);
  const citation = ref ? formatPaperCitationLabel(ref) : "";
  return `${index + 1}. ${candidate.title}${citation ? ` - ${citation}` : ""}`;
}

function buildGroundingRulesBlock(extraLine: string): string[] {
  return [
    "- Grounding rule: Use only the retrieved Zotero library snapshot and paper contexts below.",
    "- Do not invent library-wide statistics, item counts, tags, annotation counts, citation counts, or subject breakdowns that are not explicitly present in the retrieved data.",
    extraLine,
  ];
}

function buildLibraryOverviewContext(
  candidates: PaperSearchGroupCandidate[],
  papersToRead: number,
  maxPrefixTokens?: number,
): string {
  const lines = [
    "Zotero Agent Retrieval",
    "- Mode: whole-library overview",
    `- Readable PDF-backed papers found in the active Zotero library: ${candidates.length}`,
    `- Papers loaded for detailed reading in this answer: ${Math.min(candidates.length, papersToRead)}`,
    ...buildGroundingRulesBlock(
      "- If the user asks for information outside this retrieved snapshot, say that you do not have enough grounded Zotero data.",
    ),
  ];
  return appendPaperListWithinBudget({
    baseLines: lines,
    heading: "Retrieved library paper list:",
    candidates,
    maxPrefixTokens,
    overflowLabel: (remainingCount) =>
      `- Additional readable papers not listed here due to brevity: ${remainingCount}`,
  });
}

function buildLibrarySearchContext(
  question: string,
  candidates: PaperSearchGroupCandidate[],
  papersToRead: number,
  quicksearchRegularMatchCount?: number,
  maxPrefixTokens?: number,
): string {
  const lines = [
    "Zotero Agent Retrieval",
    "- Mode: library search",
    `- User request: ${sanitizeText(question).trim() || "(empty)"}`,
    Number.isFinite(quicksearchRegularMatchCount) &&
    Number(quicksearchRegularMatchCount) > 0
      ? `- Zotero quicksearch regular-item matches (library-wide): ${Math.floor(Number(quicksearchRegularMatchCount))}`
      : "",
    Number.isFinite(quicksearchRegularMatchCount) &&
    Number(quicksearchRegularMatchCount) > 0
      ? "- Counting guidance: for count/how-many requests, use the quicksearch regular-item match count as the total."
      : "",
    `- Matched readable PDF-backed papers: ${candidates.length}`,
    `- Papers loaded for detailed reading in this answer: ${Math.min(candidates.length, papersToRead)}`,
    ...buildGroundingRulesBlock(
      "- If there are no retrieved matches for a claim, say that the current Zotero retrieval did not find evidence for it.",
    ),
  ].filter(Boolean) as string[];
  return appendPaperListWithinBudget({
    baseLines: lines,
    heading: "Top retrieved library matches:",
    candidates,
    maxPrefixTokens,
    overflowLabel: (remainingCount) =>
      `- Additional readable matches not listed here due to brevity: ${remainingCount}`,
  });
}

function buildNoResultsContext(
  mode: AgentContextResolution["mode"],
  question: string,
): string {
  return [
    "Zotero Agent Retrieval",
    `- Mode: ${mode === "library-overview" ? "whole-library overview" : "library search"}`,
    `- User request: ${sanitizeText(question).trim() || "(empty)"}`,
    "- No readable PDF-backed papers were retrieved from the active Zotero library for this request.",
    "- Grounding rule: Do not invent library contents, counts, author frequencies, document types, or paper summaries.",
    "- Instead, say that no grounded Zotero library data was retrieved for the request.",
  ].join("\n");
}

function deriveAgentPrefixTokenBudget(params: {
  availableContextBudgetTokens?: number;
  papersToRead: number;
}): number | undefined {
  const totalBudget = Math.floor(Number(params.availableContextBudgetTokens));
  if (!Number.isFinite(totalBudget)) return undefined;
  if (totalBudget <= 0) return 0;
  const sharedPrefixBudget = Math.max(
    0,
    Math.floor(totalBudget * AGENT_METADATA_PREFIX_RATIO),
  );
  const estimatedPerPaperBudget = Math.max(
    1,
    Math.floor(CHUNK_TARGET_LENGTH / TOKEN_ESTIMATE_CHARS_PER_TOKEN),
  );
  const reservedRetrievalBudget = params.papersToRead * estimatedPerPaperBudget;
  const availableAfterReserve = Math.max(
    0,
    totalBudget - reservedRetrievalBudget,
  );
  return Math.max(0, Math.min(sharedPrefixBudget, availableAfterReserve));
}

function appendPaperListWithinBudget(params: {
  baseLines: string[];
  heading: string;
  candidates: PaperSearchGroupCandidate[];
  maxPrefixTokens?: number;
  overflowLabel: (remainingCount: number) => string;
}): string {
  const lines = [...params.baseLines, "", params.heading];
  const budget =
    Number.isFinite(params.maxPrefixTokens) &&
    Number(params.maxPrefixTokens) > 0
      ? Math.floor(Number(params.maxPrefixTokens))
      : Number.POSITIVE_INFINITY;
  if (budget <= 0) {
    return params.baseLines.join("\n");
  }
  let listedCount = 0;
  for (const [index, candidate] of params.candidates.entries()) {
    const line = formatPaperListLine(candidate, index);
    const next = [...lines, line].join("\n");
    if (estimateTextTokens(next) > budget && listedCount > 0) {
      break;
    }
    lines.push(line);
    listedCount += 1;
    if (estimateTextTokens(lines.join("\n")) > budget) {
      lines.pop();
      listedCount -= 1;
      break;
    }
  }
  const remainingCount = params.candidates.length - listedCount;
  if (remainingCount > 0) {
    const overflowLine = params.overflowLabel(remainingCount);
    const withOverflow = [...lines, overflowLine].join("\n");
    if (estimateTextTokens(withOverflow) <= budget) {
      lines.push(overflowLine);
    }
  }
  return lines.join("\n");
}

export async function resolveAgentContext(params: {
  question: string;
  libraryID: number;
  conversationMode: "paper" | "open";
  plan?: AgentContextPlan | null;
  availableContextBudgetTokens?: number;
  onStatus?: (statusText: string) => void;
}): Promise<AgentContextResolution | null> {
  const normalizedLibraryID = Number(params.libraryID);
  if (!Number.isFinite(normalizedLibraryID) || normalizedLibraryID <= 0) {
    return null;
  }

  const planAction = params.plan?.action;
  const forceOverview =
    planAction === "library-overview" ||
    (!planAction && isLibraryOverviewQuery(params.question));
  const forceSearch =
    planAction === "library-search" ||
    (!planAction &&
      isLibraryScopedSearchQuery(params.question, params.conversationMode));

  if (forceOverview) {
    params.onStatus?.("Reading library metadata now...");
    const candidates = await listLibraryPaperCandidates(normalizedLibraryID);
    const papersToRead = clampReadLimit(
      params.plan?.maxPapersToRead,
      Math.max(1, candidates.length),
    );
    const selectedCandidates = candidates.slice(0, papersToRead);
    const prefixBudget = deriveAgentPrefixTokenBudget({
      availableContextBudgetTokens: params.availableContextBudgetTokens,
      papersToRead,
    });
    const paperContexts = dedupePaperContexts(
      selectedCandidates
        .map((candidate) => buildPaperContextRef(candidate))
        .filter((candidate): candidate is PaperContextRef =>
          Boolean(candidate),
        ),
    );
    const traceLines = [
      candidates.length
        ? `Retrieved ${candidates.length} readable papers from the active library.`
        : "No readable library papers were found.",
      buildSelectedPaperTraceLine(selectedCandidates),
    ].filter(Boolean);
    return {
      mode: "library-overview",
      contextPrefix: candidates.length
        ? buildLibraryOverviewContext(candidates, papersToRead, prefixBudget)
        : buildNoResultsContext("library-overview", params.question),
      paperContexts,
      pinnedPaperContexts: paperContexts,
      statusText: candidates.length
        ? `Reading library (${candidates.length} papers)`
        : "No readable library papers found",
      traceLines,
    };
  }

  if (forceSearch) {
    params.onStatus?.("Searching library metadata now...");
    const searchQuery =
      sanitizeText(params.plan?.searchQuery || "").trim() || params.question;
    const papersToRead = clampReadLimit(params.plan?.maxPapersToRead, 1);
    const countIntent = isCountIntentQuestion(params.question);
    const searchLimit = countIntent
      ? 0
      : Math.max(papersToRead, papersToRead * 4);
    const quicksearchRegularMatchCount = countIntent
      ? await countQuickSearchRegularItems(normalizedLibraryID, searchQuery)
      : 0;
    const candidates = await searchPaperCandidates(
      normalizedLibraryID,
      searchQuery,
      null,
      searchLimit,
    );
    const selectedCandidates = candidates.slice(0, papersToRead);
    const prefixBudget = deriveAgentPrefixTokenBudget({
      availableContextBudgetTokens: params.availableContextBudgetTokens,
      papersToRead,
    });
    const paperContexts = dedupePaperContexts(
      selectedCandidates
        .map((candidate) => buildPaperContextRef(candidate))
        .filter((candidate): candidate is PaperContextRef =>
          Boolean(candidate),
        ),
    );
    const traceLines = [
      `Library search query: ${sanitizeText(searchQuery).replace(/\s+/g, " ").trim() || "(empty)"}`,
      countIntent
        ? "Count intent detected: searching across all searchable library fields."
        : "",
      countIntent && quicksearchRegularMatchCount > 0
        ? `Zotero quicksearch regular-item matches: ${quicksearchRegularMatchCount}.`
        : "",
      candidates.length
        ? `Matched ${candidates.length} readable papers in the active library.`
        : "No readable library matches were found.",
      buildSelectedPaperTraceLine(selectedCandidates),
    ].filter(Boolean);
    return {
      mode: "library-search",
      contextPrefix: candidates.length
        ? buildLibrarySearchContext(
            searchQuery,
            candidates,
            papersToRead,
            quicksearchRegularMatchCount,
            prefixBudget,
          )
        : buildNoResultsContext("library-search", searchQuery),
      paperContexts,
      pinnedPaperContexts: paperContexts,
      statusText: candidates.length
        ? `Searching library (${candidates.length} matches)`
        : "No readable library matches found",
      traceLines,
    };
  }

  return null;
}

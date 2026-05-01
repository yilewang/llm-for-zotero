import type { ChatMessage, ReasoningConfig } from "../../utils/llmClient";
import {
  estimateAvailableContextBudget,
  callEmbeddings,
  checkEmbeddingAvailability,
} from "../../utils/llmClient";
import { estimateTextTokens } from "../../utils/modelInputCap";
import {
  COLLECTION_RETRIEVAL_MAX_PAPERS,
  COLLECTION_RETRIEVAL_MIN_SCORE_FALLBACK_PAPERS,
  PAPER_FOLLOWUP_RETRIEVAL_MAX_CHUNKS,
  PAPER_FOLLOWUP_RETRIEVAL_MIN_CHUNKS,
  RETRIEVAL_MMR_LAMBDA,
  RETRIEVAL_MIN_ACTIVE_PAPER_CHUNKS,
  RETRIEVAL_MIN_OTHER_PAPER_CHUNKS,
  RETRIEVAL_TOP_K_PER_PAPER,
} from "./constants";
import { normalizePaperContextRefs } from "./normalizers";

import {
  resolvePaperContextRefFromAttachment,
  resolvePaperContextRefFromNote,
} from "./paperAttribution";
import {
  buildFullPaperContext,
  buildTruncatedFullPaperContext,
  buildPaperKey,
  buildPaperRetrievalCandidates,
  preGenerateEmbeddings,
  ensurePDFTextCached,
  ensureNoteTextCached,
  renderEvidencePack,
} from "./pdfContext";
import { pdfTextCache } from "./state";
import { sanitizeText } from "./textUtils";

// ── Cross-turn retrieval cache ──────────────────────────────────────────────
// Caches chunk candidates returned by buildPaperRetrievalCandidates so that
// follow-up questions about the same paper re-use the already-retrieved set.
// Key: `${paperKey}::${normalizedQuestion}`
const MAX_RETRIEVAL_CACHE_ENTRIES = 300;
const retrievalCandidateCache = new Map<string, PaperContextCandidate[]>();

function buildRetrievalCacheKey(paperKey: string, question: string): string {
  const normQ = question
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${paperKey}::${normQ}`;
}

function getCachedRetrievalCandidates(
  paperKey: string,
  question: string,
): PaperContextCandidate[] | undefined {
  return retrievalCandidateCache.get(buildRetrievalCacheKey(paperKey, question));
}

function setCachedRetrievalCandidates(
  paperKey: string,
  question: string,
  candidates: PaperContextCandidate[],
): void {
  const key = buildRetrievalCacheKey(paperKey, question);
  if (retrievalCandidateCache.size >= MAX_RETRIEVAL_CACHE_ENTRIES) {
    // Evict the oldest entry (Maps preserve insertion order).
    const first = retrievalCandidateCache.keys().next().value;
    if (first !== undefined) retrievalCandidateCache.delete(first);
  }
  retrievalCandidateCache.set(key, candidates);
}

/**
 * Evict retrieval candidates for a specific context item (PDF attachment
 * or note), or all entries if no contextItemId is given.
 * Called when chunks change (MinerU refresh) or when the embedding
 * provider changes (scores become stale).
 *
 * Paper keys are formatted as "${parentItemId}:${contextItemId}", so we
 * match on ":${contextItemId}::" to find the right entries.
 */
export function clearRetrievalCandidateCache(contextItemId?: number): void {
  if (contextItemId == null) {
    retrievalCandidateCache.clear();
    return;
  }
  const needle = `:${Math.floor(contextItemId)}::`;
  for (const key of [...retrievalCandidateCache.keys()]) {
    if (key.includes(needle)) retrievalCandidateCache.delete(key);
  }
}

/**
 * Builds a richer retrieval query by appending a short excerpt of the most
 * recent assistant response.  This helps semantic search find chunks that are
 * relevant to the evolving discussion rather than just the literal question.
 */
function buildEnrichedRetrievalQuery(
  question: string,
  history: ChatMessage[] | undefined,
): string {
  if (!history?.length) return question;
  const lastAssistant = [...history]
    .reverse()
    .find((m) => m.role === "assistant");
  if (!lastAssistant) return question;
  const ctx = sanitizeText(
    typeof lastAssistant.content === "string" ? lastAssistant.content : "",
  )
    .trim()
    .slice(0, 280);
  if (!ctx) return question;
  return `${question}\n[Prior answer context: ${ctx}]`;
}

import type {
  AdvancedModelParams,
  CollectionContextRef,
  MultiContextPlan,
  PaperContextCandidate,
  PaperContextRef,
  PdfContext,
} from "./types";

type PlannerPaperEntry = {
  order: number;
  paperKey: string;
  paperContext: PaperContextRef;
  contextItem: Zotero.Item | null;
  pdfContext: PdfContext | undefined;
  isActive: boolean;
  pinKind: "explicit" | "implicit-active" | "none";
};

type ConversationMode = "paper" | "open";

function getFirstPdfChildAttachment(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  if (!item || item.isAttachment()) return null;
  const attachments = item.getAttachments();
  for (const attachmentId of attachments) {
    const attachment = Zotero.Items.get(attachmentId);
    if (
      attachment &&
      attachment.isAttachment() &&
      attachment.attachmentContentType === "application/pdf"
    ) {
      return attachment;
    }
  }
  return null;
}

function resolveContextItem(ref: PaperContextRef): Zotero.Item | null {
  const direct = Zotero.Items.get(ref.contextItemId);
  if (
    direct &&
    direct.isAttachment() &&
    direct.attachmentContentType === "application/pdf"
  ) {
    return direct;
  }
  if (direct && (direct as any).isNote?.()) {
    return direct;
  }
  const item = Zotero.Items.get(ref.itemId);
  if (item && (item as any).isNote?.()) {
    return item;
  }
  return getFirstPdfChildAttachment(item);
}

function normalizePaperContextEntries(value: unknown): PaperContextRef[] {
  return normalizePaperContextRefs(value, { sanitizeText });
}

function buildPaperRefFromContextItem(
  contextItem: Zotero.Item | null | undefined,
): PaperContextRef | null {
  if ((contextItem as any)?.isNote?.()) {
    return resolvePaperContextRefFromNote(contextItem);
  }
  return resolvePaperContextRefFromAttachment(contextItem);
}

function buildMetadataOnlyFallback(papers: PaperContextRef[]): string {
  if (!papers.length) return "";
  const blocks = papers.map((paper, index) => {
    return `Paper ${index + 1}\n${buildFullPaperContext(paper, undefined)}`;
  });
  return `Paper Context Metadata:\n\n${blocks.join("\n\n---\n\n")}`;
}

function normalizeCollectionId(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : null;
}

function readItemField(item: Zotero.Item | null | undefined, field: string): string {
  if (!item) return "";
  try {
    return sanitizeText(item.getField?.(field as _ZoteroTypes.Item.ItemField) || "").trim();
  } catch (_err) {
    return "";
  }
}

function sanitizeUnknownText(value: unknown): string {
  return typeof value === "string" ? sanitizeText(value).trim() : "";
}

function readItemCreators(item: Zotero.Item | null | undefined): string {
  if (!item) return "";
  try {
    const creators = item.getCreators?.() || [];
    const creatorText = creators
      .map((creator) => {
        const first = sanitizeUnknownText((creator as { firstName?: unknown }).firstName);
        const last = sanitizeUnknownText((creator as { lastName?: unknown }).lastName);
        const name = sanitizeUnknownText((creator as { name?: unknown }).name);
        return [first, last].filter(Boolean).join(" ") || name || last;
      })
      .filter(Boolean)
      .join(" ");
    return (
      creatorText ||
      sanitizeUnknownText((item as { firstCreator?: unknown }).firstCreator) ||
      readItemField(item, "firstCreator")
    );
  } catch (_err) {
    return sanitizeUnknownText((item as { firstCreator?: unknown }).firstCreator);
  }
}

function readModifiedTimestamp(item: Zotero.Item | null | undefined): number {
  const raw = sanitizeUnknownText((item as { dateModified?: unknown })?.dateModified);
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildPaperRefFromRegularItem(item: Zotero.Item): PaperContextRef | null {
  const target = item?.isRegularItem?.() ? item : null;
  if (!target) return null;
  const attachment = getFirstPdfChildAttachment(target);
  if (!attachment) return null;
  const title =
    readItemField(target, "title") ||
    sanitizeUnknownText(target.getDisplayTitle?.()) ||
    `Item ${target.id}`;
  const firstCreator =
    sanitizeUnknownText((target as { firstCreator?: unknown }).firstCreator) ||
    readItemField(target, "firstCreator") ||
    undefined;
  const year = readItemField(target, "date").match(/\b(19|20)\d{2}\b/)?.[0];
  const attachmentTitle =
    readItemField(attachment, "title") ||
    sanitizeUnknownText(
      (attachment as unknown as { attachmentFilename?: unknown }).attachmentFilename,
    ) ||
    undefined;
  return {
    itemId: target.id,
    contextItemId: attachment.id,
    title,
    attachmentTitle,
    firstCreator,
    year,
  };
}

function normalizeMetadataText(value: string): string {
  return sanitizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeMetadataQuery(question: string): string[] {
  return Array.from(
    new Set(
      normalizeMetadataText(question)
        .split(/\s+/g)
        .filter((token) => token.length >= 3),
    ),
  );
}

function scoreCollectionPaperMetadata(params: {
  questionTokens: string[];
  title: string;
  creators: string;
  year: string;
  abstractNote: string;
  collectionName: string;
}): number {
  const title = normalizeMetadataText(params.title);
  const creators = normalizeMetadataText(params.creators);
  const year = normalizeMetadataText(params.year);
  const abstractNote = normalizeMetadataText(params.abstractNote);
  const collectionName = normalizeMetadataText(params.collectionName);
  let score = 0;
  for (const token of params.questionTokens) {
    if (title.includes(token)) score += 5;
    if (creators.includes(token)) score += 3;
    if (year.includes(token)) score += 2;
    if (abstractNote.includes(token)) score += 2;
    if (collectionName.includes(token)) score += 1;
  }
  return score;
}

function getCollectionChildItemIds(collection: Zotero.Collection): number[] {
  try {
    return (collection.getChildItems?.(true, false) || [])
      .map((id) => normalizeCollectionId(id))
      .filter((id): id is number => Boolean(id));
  } catch (_err) {
    return [];
  }
}

function getCollectionChildCollectionIds(collection: Zotero.Collection): number[] {
  try {
    return (collection.getChildCollections?.(true, false) || [])
      .map((id) => normalizeCollectionId(id))
      .filter((id): id is number => Boolean(id));
  } catch (_err) {
    return [];
  }
}

function collectCollectionItemIds(
  collectionId: number,
  seenCollections = new Set<number>(),
): number[] {
  if (seenCollections.has(collectionId)) return [];
  seenCollections.add(collectionId);
  const collection = Zotero.Collections.get(collectionId);
  if (!collection) return [];
  const out = new Set<number>(getCollectionChildItemIds(collection));
  for (const childCollectionId of getCollectionChildCollectionIds(collection)) {
    for (const childItemId of collectCollectionItemIds(childCollectionId, seenCollections)) {
      out.add(childItemId);
    }
  }
  return Array.from(out);
}

type CollectionScopeResolution = {
  papers: PlannerPaperEntry[];
  contextText: string;
  totalPaperCount: number;
  shortlistedPaperCount: number;
};

async function resolveCollectionScopePapers(params: {
  collectionContexts?: CollectionContextRef[];
  question: string;
  excludePaperKeys: Set<string>;
  orderStart: number;
}): Promise<CollectionScopeResolution> {
  const collectionContexts = Array.isArray(params.collectionContexts)
    ? params.collectionContexts
    : [];
  if (!collectionContexts.length) {
    return {
      papers: [],
      contextText: "",
      totalPaperCount: 0,
      shortlistedPaperCount: 0,
    };
  }

  const questionTokens = tokenizeMetadataQuery(params.question);
  const candidates: Array<{
    paperContext: PaperContextRef;
    item: Zotero.Item;
    score: number;
    modifiedAt: number;
    collectionLabel: string;
  }> = [];
  const summaries: string[] = ["Selected Zotero collection scopes:"];
  const seenPaperKeys = new Set(params.excludePaperKeys);
  let totalPaperCount = 0;

  for (const collectionContext of collectionContexts) {
    const collectionId = normalizeCollectionId(collectionContext.collectionId);
    if (!collectionId) continue;
    const collection = Zotero.Collections.get(collectionId);
    const collectionName =
      sanitizeText(collectionContext.name).trim() ||
      sanitizeText(collection?.name || "").trim() ||
      `Collection ${collectionId}`;
    const itemIds = collection ? collectCollectionItemIds(collectionId) : [];
    let collectionPaperCount = 0;
    for (const itemId of itemIds) {
      const item = Zotero.Items.get(itemId);
      if (!item?.isRegularItem?.()) continue;
      const paperContext = buildPaperRefFromRegularItem(item);
      if (!paperContext) continue;
      collectionPaperCount += 1;
      const paperKey = buildPaperKey(paperContext);
      if (seenPaperKeys.has(paperKey)) continue;
      seenPaperKeys.add(paperKey);
      const title = paperContext.title;
      const creators = readItemCreators(item);
      const year = paperContext.year || readItemField(item, "date");
      const abstractNote = readItemField(item, "abstractNote");
      candidates.push({
        paperContext,
        item,
        score: scoreCollectionPaperMetadata({
          questionTokens,
          title,
          creators,
          year,
          abstractNote,
          collectionName,
        }),
        modifiedAt: readModifiedTimestamp(item),
        collectionLabel: collectionName,
      });
    }
    totalPaperCount += collectionPaperCount;
    summaries.push(
      `- ${collectionName} [collectionId=${collectionId}, libraryID=${collectionContext.libraryID}, papers=${collectionPaperCount}]`,
    );
  }

  candidates.sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (scoreDelta !== 0) return scoreDelta;
    const modifiedDelta = right.modifiedAt - left.modifiedAt;
    if (modifiedDelta !== 0) return modifiedDelta;
    return left.paperContext.title.localeCompare(right.paperContext.title, undefined, {
      sensitivity: "base",
    });
  });

  const positive = candidates.filter((candidate) => candidate.score > 0);
  const shortlistSource = positive.length ? positive : candidates;
  const shortlistLimit = positive.length
    ? COLLECTION_RETRIEVAL_MAX_PAPERS
    : Math.min(
        COLLECTION_RETRIEVAL_MAX_PAPERS,
        COLLECTION_RETRIEVAL_MIN_SCORE_FALLBACK_PAPERS,
      );
  const shortlisted = shortlistSource.slice(0, shortlistLimit);
  const papers: PlannerPaperEntry[] = [];
  for (const [index, candidate] of shortlisted.entries()) {
    const contextItem = resolveContextItem(candidate.paperContext);
    if (contextItem) {
      await ensurePDFTextCached(contextItem);
    }
    papers.push({
      order: params.orderStart + index,
      paperKey: buildPaperKey(candidate.paperContext),
      paperContext: candidate.paperContext,
      contextItem,
      pdfContext: contextItem ? pdfTextCache.get(contextItem.id) : undefined,
      isActive: false,
      pinKind: "none",
    });
  }

  summaries.push(
    `Collection retrieval strategy: metadata-ranked shortlist; ${shortlisted.length} of ${totalPaperCount} PDF-backed papers selected for deeper retrieval. Full text was not read for every paper in the collection.`,
  );

  return {
    papers,
    contextText: summaries.join("\n"),
    totalPaperCount,
    shortlistedPaperCount: shortlisted.length,
  };
}

function candidateKey(candidate: PaperContextCandidate): string {
  return `${candidate.paperKey}:${candidate.chunkIndex}`;
}

function normalizeScores(values: number[]): number[] {
  if (!values.length) return [];
  let min = values[0];
  let max = values[0];
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (max === min) return values.map(() => 0);
  return values.map((value) => (value - min) / (max - min));
}

function tokenizeForDiversity(text: string): Set<string> {
  const tokens = (text.toLowerCase().match(/[a-z0-9]{3,}/g) || []).slice(
    0,
    256,
  );
  return new Set(tokens);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  if (!union) return 0;
  return intersection / union;
}

type RetrievedAssembly = {
  contextText: string;
  selectedChunkCount: number;
  selectedPaperCount: number;
  citationPaperContexts: PaperContextRef[];
};

type RetrievedAssemblyOptions = {
  guaranteedAbstractPaperKey?: string;
  maxChunks?: number;
  minTotalChunks?: number;
};

function mergePlannerCitationPaperContexts(
  ...groups: Array<Array<PlannerPaperEntry | PaperContextRef> | undefined>
): PaperContextRef[] {
  const refs: PaperContextRef[] = [];
  for (const group of groups) {
    for (const entry of group || []) {
      refs.push("paperContext" in entry ? entry.paperContext : entry);
    }
  }
  return normalizePaperContextEntries(refs);
}

function citationPaperContextsForKeys(
  papers: PlannerPaperEntry[],
  keys: Set<string>,
): PaperContextRef[] {
  if (!keys.size) return [];
  return mergePlannerCitationPaperContexts(
    papers.filter((paper) => keys.has(paper.paperKey)),
  );
}

export function assembleFullMultiPaperContext(params: {
  papers: PlannerPaperEntry[];
}): {
  contextText: string;
  estimatedTokens: number;
} {
  const blocks: string[] = [];
  for (const [index, paper] of params.papers.entries()) {
    const block = buildFullPaperContext(paper.paperContext, paper.pdfContext);
    if (!block.trim()) continue;
    blocks.push(`Paper ${index + 1}\n${block.trim()}`);
  }
  if (!blocks.length) {
    return { contextText: "", estimatedTokens: 0 };
  }
  const contextText = `Full Paper Contexts:\n\n${blocks.join("\n\n---\n\n")}`;
  return {
    contextText,
    estimatedTokens: estimateTextTokens(contextText),
  };
}

function formatFullPaperBlock(params: {
  paper: PlannerPaperEntry;
  index: number;
  text: string;
}): string {
  return `Paper ${params.index + 1}\n${params.text.trim()}`;
}

function buildFullPaperContextWrapper(blocks: string[]): string {
  if (!blocks.length) return "";
  return `Full Paper Contexts:\n\n${blocks.join("\n\n---\n\n")}`;
}

function assembleBestEffortFullMultiPaperContext(params: {
  papers: PlannerPaperEntry[];
  contextBudgetTokens: number;
}): {
  contextText: string;
  estimatedTokens: number;
  selectedPaperCount: number;
  includedPaperKeys: Set<string>;
} {
  const blocks: string[] = [];
  const includedPaperKeys = new Set<string>();
  const budget = Math.max(0, Math.floor(params.contextBudgetTokens));
  if (!params.papers.length || budget <= 0) {
    return {
      contextText: "",
      estimatedTokens: 0,
      selectedPaperCount: 0,
      includedPaperKeys,
    };
  }

  for (const [index, paper] of params.papers.entries()) {
    const fullBlock = formatFullPaperBlock({
      paper,
      index,
      text: buildFullPaperContext(paper.paperContext, paper.pdfContext),
    });
    const fullCombined = buildFullPaperContextWrapper([...blocks, fullBlock]);
    const fullCombinedTokens = estimateTextTokens(fullCombined);
    if (fullCombinedTokens <= budget) {
      blocks.push(fullBlock);
      includedPaperKeys.add(paper.paperKey);
      continue;
    }

    const currentCombined = buildFullPaperContextWrapper(blocks);
    const currentTokens = estimateTextTokens(currentCombined);
    const separatorTokens = estimateTextTokens(blocks.length ? "\n\n---\n\n" : "");
    const paperHeadingTokens = estimateTextTokens(`Paper ${index + 1}\n`);
    const wrapperTokens = blocks.length
      ? 0
      : estimateTextTokens("Full Paper Contexts:\n\n");
    const remainingForPaper =
      budget - currentTokens - separatorTokens - paperHeadingTokens - wrapperTokens;
    if (remainingForPaper <= 0) {
      continue;
    }

    const truncated = buildTruncatedFullPaperContext(
      paper.paperContext,
      paper.pdfContext,
      { maxTokens: remainingForPaper },
    );
    const truncatedBlock = formatFullPaperBlock({
      paper,
      index,
      text: truncated.text,
    });
    const truncatedCombined = buildFullPaperContextWrapper([
      ...blocks,
      truncatedBlock,
    ]);
    if (estimateTextTokens(truncatedCombined) > budget) {
      continue;
    }
    blocks.push(truncatedBlock);
    includedPaperKeys.add(paper.paperKey);
  }

  const contextText = buildFullPaperContextWrapper(blocks);
  return {
    contextText,
    estimatedTokens: estimateTextTokens(contextText),
    selectedPaperCount: includedPaperKeys.size,
    includedPaperKeys,
  };
}

export function selectContextAssemblyMode(params: {
  fullContextText: string;
  fullContextTokens: number;
  contextBudgetTokens: number;
}): "full" | "retrieval" {
  if (!params.fullContextText.trim()) return "retrieval";
  return params.fullContextTokens <= params.contextBudgetTokens
    ? "full"
    : "retrieval";
}

export async function assembleRetrievedMultiPaperContext(params: {
  papers: PlannerPaperEntry[];
  question: string;
  contextBudgetTokens: number;
  minChunksByPaper?: Map<string, number>;
  options?: RetrievedAssemblyOptions;
}): Promise<RetrievedAssembly> {
  const {
    papers,
    question,
    contextBudgetTokens,
    minChunksByPaper,
    options,
  } = params;
  if (!papers.length || contextBudgetTokens <= 0) {
    return {
      contextText: "",
      selectedChunkCount: 0,
      selectedPaperCount: 0,
      citationPaperContexts: [],
    };
  }

  // Pre-compute query embedding once so we don't make N identical API calls
  // for N papers in the loop below.
  let precomputedQueryEmbedding: number[] | undefined;
  if (question.trim() && checkEmbeddingAvailability()) {
    try {
      precomputedQueryEmbedding = (await callEmbeddings([question]))[0];
    } catch {
      // Embedding unavailable — fall back to BM25-only scoring per paper.
    }
  }

  const allCandidates: PaperContextCandidate[] = [];
  for (const paper of papers) {
    const cached = getCachedRetrievalCandidates(paper.paperKey, question);
    if (cached) {
      allCandidates.push(...cached);
      continue;
    }
    const candidates = await buildPaperRetrievalCandidates(
      paper.paperContext,
      paper.pdfContext,
      question,
      {
        topK: RETRIEVAL_TOP_K_PER_PAPER,
        mode: "evidence",
        precomputedQueryEmbedding,
      },
    );
    setCachedRetrievalCandidates(paper.paperKey, question, candidates);
    allCandidates.push(...candidates);
  }

  if (!allCandidates.length) {
    return {
      contextText: buildMetadataOnlyFallback(
        papers.map((entry) => entry.paperContext),
      ),
      selectedChunkCount: 0,
      selectedPaperCount: papers.length,
      citationPaperContexts: mergePlannerCitationPaperContexts(papers),
    };
  }

  const globalHybrid = normalizeScores(
    allCandidates.map((candidate) => candidate.hybridScore),
  );
  const relevanceByCandidate = new Map<string, number>();
  for (const [index, candidate] of allCandidates.entries()) {
    relevanceByCandidate.set(candidateKey(candidate), globalHybrid[index] || 0);
  }

  const candidatesByPaper = new Map<string, PaperContextCandidate[]>();
  for (const candidate of allCandidates) {
    const list = candidatesByPaper.get(candidate.paperKey) || [];
    list.push(candidate);
    candidatesByPaper.set(candidate.paperKey, list);
  }
  for (const list of candidatesByPaper.values()) {
    list.sort((a, b) => {
      const scoreDelta =
        (relevanceByCandidate.get(candidateKey(b)) || 0) -
        (relevanceByCandidate.get(candidateKey(a)) || 0);
      if (scoreDelta !== 0) return scoreDelta;
      return a.chunkIndex - b.chunkIndex;
    });
  }

  const maxChunks = Number.isFinite(options?.maxChunks)
    ? Math.max(1, Math.floor(options?.maxChunks as number))
    : Number.POSITIVE_INFINITY;
  const minTotalChunks = Number.isFinite(options?.minTotalChunks)
    ? Math.max(0, Math.floor(options?.minTotalChunks as number))
    : 0;
  const selected = new Map<string, PaperContextCandidate>();
  let remainingTokens = contextBudgetTokens;
  let lockedAbstractPaperKey = "";
  let lockedAbstractCandidateKey = "";
  const shouldSkipCandidate = (candidate: PaperContextCandidate): boolean => {
    if (!lockedAbstractPaperKey) return false;
    if (candidate.paperKey !== lockedAbstractPaperKey) return false;
    if (candidate.chunkKind !== "abstract") return false;
    return candidateKey(candidate) !== lockedAbstractCandidateKey;
  };
  const selectCandidate = (candidate: PaperContextCandidate): boolean => {
    const key = candidateKey(candidate);
    if (selected.has(key)) return false;
    if (shouldSkipCandidate(candidate)) return false;
    if (selected.size >= maxChunks) return false;
    if (candidate.estimatedTokens > remainingTokens) return false;
    selected.set(key, candidate);
    remainingTokens -= candidate.estimatedTokens;
    return true;
  };

  const guaranteedPaperKey = sanitizeText(
    options?.guaranteedAbstractPaperKey || "",
  ).trim();
  if (guaranteedPaperKey) {
    const preferred = candidatesByPaper.get(guaranteedPaperKey) || [];
    const guaranteedCandidate =
      preferred.find((candidate) => candidate.chunkKind === "abstract") ||
      preferred[0] ||
      null;
    if (guaranteedCandidate) {
      if (selectCandidate(guaranteedCandidate)) {
        if (guaranteedCandidate.chunkKind === "abstract") {
          lockedAbstractPaperKey = guaranteedCandidate.paperKey;
          lockedAbstractCandidateKey = candidateKey(guaranteedCandidate);
        }
      }
    }
  }

  // First pass: guarantee per-paper coverage before global reranking.
  for (const paper of papers) {
    const key = paper.paperKey;
    const minChunks = Math.max(0, minChunksByPaper?.get(key) || 0);
    if (minChunks <= 0) continue;
    const list = candidatesByPaper.get(key) || [];
    let added = 0;
    for (const candidate of list) {
      if (shouldSkipCandidate(candidate)) continue;
      if (added >= minChunks) break;
      if (selectCandidate(candidate)) {
        added += 1;
      }
    }
  }

  const diversityTokens = new Map<string, Set<string>>();
  for (const candidate of allCandidates) {
    diversityTokens.set(
      candidateKey(candidate),
      tokenizeForDiversity(candidate.chunkText),
    );
  }

  // Cap the candidate pool to prevent O(N²) complexity in the MMR loop.
  // Beyond 80 candidates the marginal relevance gain is negligible, and
  // Jaccard comparisons against the growing selected set become expensive
  // in Zotero's single-threaded runtime.
  const MAX_MMR_CANDIDATES = 80;
  // Sort by relevance before slicing so we keep the globally top-ranked
  // candidates rather than whichever papers happened to be appended first.
  const sortedCandidates = [...allCandidates].sort(
    (a, b) =>
      (relevanceByCandidate.get(candidateKey(b)) || 0) -
      (relevanceByCandidate.get(candidateKey(a)) || 0),
  );
  const mmrPool =
    sortedCandidates.length > MAX_MMR_CANDIDATES
      ? sortedCandidates.slice(0, MAX_MMR_CANDIDATES)
      : sortedCandidates;

  while (remainingTokens > 0 && selected.size < maxChunks) {
    let best: PaperContextCandidate | null = null;
    let bestUtility = -Infinity;
    for (const candidate of mmrPool) {
      const key = candidateKey(candidate);
      if (selected.has(key)) continue;
      if (shouldSkipCandidate(candidate)) continue;
      if (candidate.estimatedTokens > remainingTokens) continue;

      const relevance = relevanceByCandidate.get(key) || 0;
      let maxSimilarity = 0;
      const currentTokens = diversityTokens.get(key) || new Set<string>();
      for (const selectedCandidate of selected.values()) {
        const selectedTokens =
          diversityTokens.get(candidateKey(selectedCandidate)) ||
          new Set<string>();
        const similarity = jaccardSimilarity(currentTokens, selectedTokens);
        if (similarity > maxSimilarity) {
          maxSimilarity = similarity;
        }
      }
      const marginalScore =
        RETRIEVAL_MMR_LAMBDA * relevance -
        (1 - RETRIEVAL_MMR_LAMBDA) * maxSimilarity;
      const utility = marginalScore / Math.max(1, candidate.estimatedTokens);
      if (utility > bestUtility) {
        bestUtility = utility;
        best = candidate;
      }
    }
    if (!best) break;
    if (!selectCandidate(best)) break;
    if (selected.size >= maxChunks && selected.size >= minTotalChunks) {
      break;
    }
  }

  const selectedCandidates = Array.from(selected.values());
  selectedCandidates.sort((a, b) => {
    if (a.paperKey !== b.paperKey) return a.paperKey.localeCompare(b.paperKey);
    return a.chunkIndex - b.chunkIndex;
  });

  const contextText =
    renderEvidencePack({
      papers: papers.map((paper) => paper.paperContext),
      candidates: selectedCandidates,
    }) || buildMetadataOnlyFallback(papers.map((entry) => entry.paperContext));

  return {
    contextText,
    selectedChunkCount: selectedCandidates.length,
    selectedPaperCount: selectedCandidates.length
      ? new Set(selectedCandidates.map((candidate) => candidate.paperKey)).size
      : papers.length,
    citationPaperContexts: selectedCandidates.length
      ? citationPaperContextsForKeys(
          papers,
          new Set(selectedCandidates.map((candidate) => candidate.paperKey)),
        )
      : mergePlannerCitationPaperContexts(papers),
  };
}

function buildMinChunkMapForRetrievedPapers(
  papers: PlannerPaperEntry[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const paper of papers) {
    if (paper.isActive) {
      out.set(paper.paperKey, RETRIEVAL_MIN_ACTIVE_PAPER_CHUNKS);
    } else {
      // Every paper in context gets at least 1 chunk so the LLM is aware of
      // all papers, even when they are unpinned / retrieval-only.
      out.set(paper.paperKey, RETRIEVAL_MIN_OTHER_PAPER_CHUNKS);
    }
  }
  return out;
}

function appendContextBlocks(blocks: string[]): string {
  const nonEmpty = blocks
    .map((entry) => sanitizeText(entry || "").trim())
    .filter(Boolean);
  if (!nonEmpty.length) return "";
  return nonEmpty.join("\n\n---\n\n");
}

function isFirstPaperTurn(history: ChatMessage[] | undefined): boolean {
  return !history?.length;
}

function questionNeedsPaperCapabilityReminder(question: string): boolean {
  const normalized = question.trim().toLowerCase();
  if (!normalized) return false;
  return (
    /\b(?:full text|full paper|whole paper|entire paper|entire article|whole article)\b/.test(
      normalized,
    ) ||
    /\b(?:all sections|all parts|entire document|complete paper)\b/.test(
      normalized,
    ) ||
    /\b(?:do you have access|can you access|can you read|did you read)\b/.test(
      normalized,
    ) ||
    /\b(?:coverage|scope|everything in the paper)\b/.test(normalized)
  );
}

function buildPaperFollowupAssistantInstruction(
  question: string,
): string | undefined {
  if (!questionNeedsPaperCapabilityReminder(question)) return undefined;
  return [
    "If the user asks about access or coverage, answer directly that you can",
    "access the paper's full text.",
    "Do not say that you lack access or only have snippets.",
    "Then say that, for this reply, you are using the abstract plus the most",
    "relevant retrieved chunks instead of quoting the entire paper text.",
  ].join(" ");
}

async function resolvePlannerPaperEntries(params: {
  conversationMode: ConversationMode;
  activeContextItem: Zotero.Item | null;
  paperContexts: PaperContextRef[] | undefined;
  fullTextPaperContexts: PaperContextRef[] | undefined;
  historyPaperContexts: PaperContextRef[] | undefined;
}): Promise<PlannerPaperEntry[]> {
  const selected = normalizePaperContextEntries(params.paperContexts || []);
  const explicitFullText = normalizePaperContextEntries(
    params.fullTextPaperContexts || [],
  );
  const historyPool = normalizePaperContextEntries(
    params.historyPaperContexts || [],
  );
  const orderedRefs: PaperContextRef[] = [];
  const seen = new Set<string>();

  const explicitFullTextKeys = new Set(
    explicitFullText.map((paper) => buildPaperKey(paper)),
  );
  const activePaper =
    params.conversationMode === "paper"
      ? buildPaperRefFromContextItem(params.activeContextItem)
      : null;
  const activeKey = activePaper ? buildPaperKey(activePaper) : "";
  const includeHistoryPool =
    params.conversationMode === "paper" &&
    selected.length === 0 &&
    explicitFullText.length === 0;

  const pushRef = (paper: PaperContextRef) => {
    const key = buildPaperKey(paper);
    if (seen.has(key)) return;
    seen.add(key);
    orderedRefs.push(paper);
  };

  if (activePaper) {
    pushRef(activePaper);
  }

  for (const paper of selected) {
    pushRef(paper);
  }
  for (const paper of explicitFullText) {
    pushRef(paper);
  }
  if (includeHistoryPool) {
    for (const paper of historyPool) {
      pushRef(paper);
    }
  }

  const out: PlannerPaperEntry[] = [];
  for (const [index, paperContext] of orderedRefs.entries()) {
    const paperKey = buildPaperKey(paperContext);
    const contextItem = resolveContextItem(paperContext);
    if (contextItem) {
      if ((contextItem as any).isNote?.()) {
        await ensureNoteTextCached(contextItem);
      } else {
        await ensurePDFTextCached(contextItem);
      }
    }
    const isActive = Boolean(activeKey && paperKey === activeKey);
    const pinKind: PlannerPaperEntry["pinKind"] = explicitFullTextKeys.has(
      paperKey,
    )
      ? "explicit"
      : "none";
    out.push({
      order: index + 1,
      paperKey,
      paperContext,
      contextItem,
      pdfContext: contextItem ? pdfTextCache.get(contextItem.id) : undefined,
      isActive,
      pinKind,
    });
  }
  return out;
}

export async function resolveMultiContextPlan(params: {
  conversationMode: ConversationMode;
  activeContextItem: Zotero.Item | null;
  question: string;
  contextPrefix?: string;
  paperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  collectionContexts?: CollectionContextRef[];
  historyPaperContexts?: PaperContextRef[];
  history?: ChatMessage[];
  images?: string[];
  image?: string;
  model: string;
  reasoning?: ReasoningConfig;
  advanced?: AdvancedModelParams;
  apiBase?: string;
  apiKey?: string;
  providerProtocol?: import("../../utils/providerProtocol").ProviderProtocol;
  systemPrompt?: string;
  signal?: AbortSignal;
}): Promise<MultiContextPlan> {
  const papers = await resolvePlannerPaperEntries({
    conversationMode: params.conversationMode,
    activeContextItem: params.activeContextItem,
    paperContexts: params.paperContexts,
    fullTextPaperContexts: params.fullTextPaperContexts,
    historyPaperContexts: params.historyPaperContexts,
  });
  const collectionScope = await resolveCollectionScopePapers({
    collectionContexts: params.collectionContexts,
    question: params.question,
    excludePaperKeys: new Set(papers.map((paper) => paper.paperKey)),
    orderStart: papers.length + 1,
  });
  const collectionPapers = collectionScope.papers;
  const prependCollectionScope = (contextText: string): string =>
    appendContextBlocks([collectionScope.contextText, contextText]);
  const contextBudget = estimateAvailableContextBudget({
    model: params.model,
    prompt: params.question,
    history: params.history,
    images: params.images,
    image: params.image,
    reasoning: params.reasoning,
    maxTokens: params.advanced?.maxTokens,
    inputTokenCap: params.advanced?.inputTokenCap,
    systemPrompt: params.systemPrompt,
  });
  const reservedPrefixTokens = estimateTextTokens(params.contextPrefix || "");
  const adjustedContextBudget = {
    ...contextBudget,
    contextBudgetTokens: Math.max(
      0,
      contextBudget.contextBudgetTokens - reservedPrefixTokens,
    ),
  };

  if (!papers.length && !collectionPapers.length) {
    const contextText = prependCollectionScope("");
    return {
      mode: "retrieval",
      strategy: "general-retrieval",
      contextText,
      contextBudget: adjustedContextBudget,
      usedContextTokens: estimateTextTokens(contextText),
      selectedPaperCount: 0,
      selectedChunkCount: 0,
      citationPaperContexts: [],
    };
  }

  if (!papers.length && collectionPapers.length) {
    const retrieved = await assembleRetrievedMultiPaperContext({
      papers: collectionPapers,
      question: params.question,
      contextBudgetTokens: adjustedContextBudget.contextBudgetTokens,
      minChunksByPaper: new Map<string, number>(),
    });
    const contextText = prependCollectionScope(retrieved.contextText);
    return {
      mode: "retrieval",
      strategy: "general-retrieval",
      contextText,
      contextBudget: adjustedContextBudget,
      usedContextTokens: estimateTextTokens(contextText),
      selectedPaperCount: retrieved.selectedPaperCount,
      selectedChunkCount: retrieved.selectedChunkCount,
      citationPaperContexts: retrieved.citationPaperContexts,
    };
  }

  const fullTextPapers = papers.filter((paper) => paper.pinKind !== "none");
  const explicitFullTextPapers = papers.filter(
    (paper) => paper.pinKind === "explicit",
  );
  const unpinned = papers.filter((paper) => paper.pinKind === "none");
  const activePaper = papers.find((paper) => paper.isActive) || papers[0] || null;
  const firstPaperTurn =
    params.conversationMode === "paper" && isFirstPaperTurn(params.history);

  if (params.conversationMode === "paper" && activePaper) {
    // Collect other explicitly selected papers (@-referenced) beyond the
    // active paper so they are not silently dropped.
    const otherPapers = papers.filter((p) => !p.isActive);
    const otherPinned = otherPapers.filter((p) => p.pinKind !== "none");
    const otherUnpinned = otherPapers.filter((p) => p.pinKind === "none");

    if (activePaper.pinKind !== "none") {
      // Active paper + any other pinned papers in full text.
      const pinnedPapers = [activePaper, ...otherPinned];
      const full = assembleFullMultiPaperContext({ papers: pinnedPapers });

      // Pre-generate embeddings in the background so they are cached for
      // future retrieval queries (e.g. multi-paper or long conversations).
      for (const paper of pinnedPapers) {
        preGenerateEmbeddings(paper.pdfContext, paper.paperContext.contextItemId);
      }

      // Include remaining @-referenced (unpinned) papers via retrieval if
      // there is token budget left.
      let extraRetrieved: RetrievedAssembly | null = null;
      const extraRetrievalPapers = [...otherUnpinned, ...collectionPapers];
      if (extraRetrievalPapers.length) {
        const remainingTokens = Math.max(
          0,
          adjustedContextBudget.contextBudgetTokens - full.estimatedTokens,
        );
        if (remainingTokens > 0) {
          const enrichedQuestion = buildEnrichedRetrievalQuery(
            params.question,
            params.history,
          );
          extraRetrieved = await assembleRetrievedMultiPaperContext({
            papers: extraRetrievalPapers,
            question: enrichedQuestion,
            contextBudgetTokens: remainingTokens,
            minChunksByPaper: buildMinChunkMapForRetrievedPapers(otherUnpinned),
          });
        }
      }

      const combinedContext = prependCollectionScope(
        appendContextBlocks([
          full.contextText,
          extraRetrieved?.selectedChunkCount ? extraRetrieved.contextText : "",
        ]),
      );
      const usedContextTokens = estimateTextTokens(combinedContext);
      return {
        mode: "full",
        strategy: firstPaperTurn ? "paper-first-full" : "paper-manual-full",
        contextText: combinedContext,
        contextBudget: adjustedContextBudget,
        usedContextTokens,
        selectedPaperCount:
          (full.contextText ? pinnedPapers.length : 0) +
          (extraRetrieved?.selectedPaperCount || 0),
        selectedChunkCount: extraRetrieved?.selectedChunkCount || 0,
        citationPaperContexts: mergePlannerCitationPaperContexts(
          full.contextText ? pinnedPapers : [],
          extraRetrieved?.citationPaperContexts,
        ),
      };
    }

    // Enrich the retrieval query with the last assistant response so semantic
    // search finds chunks relevant to the evolving conversation.
    const enrichedQuestion = buildEnrichedRetrievalQuery(
      params.question,
      params.history,
    );
    // Include all papers (active + @-referenced) in retrieval, not just the
    // active paper alone.
    const directRetrievalPapers = [activePaper, ...otherPapers];
    const allRetrievalPapers = [...directRetrievalPapers, ...collectionPapers];
    const retrieved = await assembleRetrievedMultiPaperContext({
      papers: allRetrievalPapers,
      question: enrichedQuestion,
      contextBudgetTokens: adjustedContextBudget.contextBudgetTokens,
      minChunksByPaper: buildMinChunkMapForRetrievedPapers(directRetrievalPapers),
      options: {
        guaranteedAbstractPaperKey: activePaper.paperKey,
        maxChunks: PAPER_FOLLOWUP_RETRIEVAL_MAX_CHUNKS,
        minTotalChunks: PAPER_FOLLOWUP_RETRIEVAL_MIN_CHUNKS,
      },
    });
    const contextText = prependCollectionScope(retrieved.contextText);
    const usedContextTokens = estimateTextTokens(contextText);
    return {
      mode: "retrieval",
      strategy: firstPaperTurn
        ? "paper-explicit-retrieval"
        : "paper-followup-retrieval",
      contextText,
      contextBudget: adjustedContextBudget,
      usedContextTokens,
      selectedPaperCount: retrieved.selectedPaperCount,
      selectedChunkCount: retrieved.selectedChunkCount,
      citationPaperContexts: retrieved.citationPaperContexts,
      assistantInstruction:
        firstPaperTurn
          ? undefined
          : buildPaperFollowupAssistantInstruction(params.question),
    };
  }

  const fullPreferredPapers =
    params.conversationMode === "paper"
      ? fullTextPapers
      : explicitFullTextPapers;

  if (fullPreferredPapers.length) {
    const full = assembleFullMultiPaperContext({ papers: fullPreferredPapers });

    // Pre-generate embeddings for full-text papers in background
    for (const paper of fullPreferredPapers) {
      preGenerateEmbeddings(paper.pdfContext, paper.paperContext.contextItemId);
    }

    if (
      selectContextAssemblyMode({
        fullContextText: full.contextText,
        fullContextTokens: full.estimatedTokens,
        contextBudgetTokens: adjustedContextBudget.contextBudgetTokens,
      }) === "full"
    ) {
      const remainingTokens = Math.max(
        0,
        adjustedContextBudget.contextBudgetTokens - full.estimatedTokens,
      );
      let extraUnpinned: RetrievedAssembly | null = null;
      const extraUnpinnedPapers = [...unpinned, ...collectionPapers];
      if (remainingTokens >= 1024 && extraUnpinnedPapers.length) {
        extraUnpinned = await assembleRetrievedMultiPaperContext({
          papers: extraUnpinnedPapers,
          question: params.question,
          contextBudgetTokens: remainingTokens,
          minChunksByPaper: buildMinChunkMapForRetrievedPapers(unpinned),
        });
      }
      const extraBlock =
        extraUnpinned && extraUnpinned.selectedChunkCount > 0
          ? extraUnpinned.contextText
          : "";
      const combinedContext = prependCollectionScope(
        appendContextBlocks([
          full.contextText,
          extraBlock,
        ]),
      );
      const usedContextTokens = estimateTextTokens(combinedContext);
      const selectedPaperCount =
        fullPreferredPapers.length +
        (extraUnpinned?.selectedChunkCount
          ? extraUnpinned.selectedPaperCount
          : 0);
      return {
        mode: "full",
        strategy: "general-full",
        contextText: combinedContext,
        contextBudget: adjustedContextBudget,
        usedContextTokens,
        selectedPaperCount,
        selectedChunkCount: extraUnpinned?.selectedChunkCount || 0,
        citationPaperContexts: mergePlannerCitationPaperContexts(
          fullPreferredPapers,
          extraUnpinned?.citationPaperContexts,
        ),
      };
    }

    const partialFull = assembleBestEffortFullMultiPaperContext({
      papers: fullPreferredPapers,
      contextBudgetTokens: adjustedContextBudget.contextBudgetTokens,
    });
    if (partialFull.selectedPaperCount > 0) {
      const remainingTokens = Math.max(
        0,
        adjustedContextBudget.contextBudgetTokens - partialFull.estimatedTokens,
      );
      const hasOverflowPreferredPapers = fullPreferredPapers.some(
        (paper) => !partialFull.includedPaperKeys.has(paper.paperKey),
      );
      const retrievalCompanionPapers = [
        ...fullPreferredPapers.filter(
          (paper) => !partialFull.includedPaperKeys.has(paper.paperKey),
        ),
        ...unpinned.filter(
          (paper) => !partialFull.includedPaperKeys.has(paper.paperKey),
        ),
        ...collectionPapers.filter(
          (paper) => !partialFull.includedPaperKeys.has(paper.paperKey),
        ),
      ];
      let extraRetrieved: RetrievedAssembly | null = null;
      if (
        retrievalCompanionPapers.length &&
        (hasOverflowPreferredPapers
          ? remainingTokens > 0
          : remainingTokens >= 1024)
      ) {
        extraRetrieved = await assembleRetrievedMultiPaperContext({
          papers: retrievalCompanionPapers,
          question: params.question,
          contextBudgetTokens: remainingTokens,
          minChunksByPaper: buildMinChunkMapForRetrievedPapers(
            retrievalCompanionPapers.filter(
              (paper) => !collectionPapers.some((entry) => entry.paperKey === paper.paperKey),
            ),
          ),
        });
      }
      const combinedContext = prependCollectionScope(
        appendContextBlocks([
          partialFull.contextText,
          extraRetrieved?.selectedChunkCount ? extraRetrieved.contextText : "",
        ]),
      );
      const usedContextTokens = estimateTextTokens(combinedContext);
      const selectedPaperCount =
        partialFull.selectedPaperCount +
        (extraRetrieved?.selectedChunkCount
          ? extraRetrieved.selectedPaperCount
          : 0);
      return {
        mode: "full",
        strategy: "general-full",
        contextText: combinedContext,
        contextBudget: adjustedContextBudget,
        usedContextTokens,
        selectedPaperCount,
        selectedChunkCount: extraRetrieved?.selectedChunkCount || 0,
        citationPaperContexts: mergePlannerCitationPaperContexts(
          citationPaperContextsForKeys(
            fullPreferredPapers,
            partialFull.includedPaperKeys,
          ),
          extraRetrieved?.citationPaperContexts,
        ),
      };
    }
  }

  // Directly selected papers get per-paper coverage; collection papers are a
  // metadata-ranked retrieval pool and do not get guaranteed per-paper chunks.
  const directRetrievalPapers = [...fullTextPapers, ...unpinned];
  const retrievalPapers = [...directRetrievalPapers, ...collectionPapers];
  if (!retrievalPapers.length) {
    const contextText = prependCollectionScope("");
    return {
      mode: "retrieval",
      strategy: "general-retrieval",
      contextText,
      contextBudget: adjustedContextBudget,
      usedContextTokens: estimateTextTokens(contextText),
      selectedPaperCount: 0,
      selectedChunkCount: 0,
      citationPaperContexts: [],
    };
  }

  const retrieved = await assembleRetrievedMultiPaperContext({
    papers: retrievalPapers,
    question: params.question,
    contextBudgetTokens: adjustedContextBudget.contextBudgetTokens,
    minChunksByPaper: buildMinChunkMapForRetrievedPapers(directRetrievalPapers),
  });
  const contextText = prependCollectionScope(retrieved.contextText);
  const usedContextTokens = estimateTextTokens(contextText);
  return {
    mode: "retrieval",
    strategy: "general-retrieval",
    contextText,
    contextBudget: adjustedContextBudget,
    usedContextTokens,
    selectedPaperCount: retrieved.selectedPaperCount,
    selectedChunkCount: retrieved.selectedChunkCount,
    citationPaperContexts: retrieved.citationPaperContexts,
  };
}

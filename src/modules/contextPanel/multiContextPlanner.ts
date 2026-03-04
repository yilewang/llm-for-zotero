import type { ChatMessage, ReasoningConfig } from "../../utils/llmClient";
import { estimateAvailableContextBudget } from "../../utils/llmClient";
import { estimateTextTokens } from "../../utils/modelInputCap";
import {
  RETRIEVAL_MMR_LAMBDA,
  RETRIEVAL_MIN_ACTIVE_PAPER_CHUNKS,
  RETRIEVAL_MIN_OTHER_PAPER_CHUNKS,
  RETRIEVAL_TOP_K_PER_PAPER,
} from "./constants";
import { normalizePaperContextRefs } from "./normalizers";
import { resolvePaperContextRefFromAttachment } from "./paperAttribution";
import {
  buildFullPaperContext,
  buildTruncatedFullPaperContext,
  buildPaperKey,
  buildPaperRetrievalCandidates,
  ensurePDFTextCached,
  renderEvidencePack,
} from "./pdfContext";
import { pdfTextCache } from "./state";
import { sanitizeText } from "./textUtils";
import type {
  AdvancedModelParams,
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
  const item = Zotero.Items.get(ref.itemId);
  return getFirstPdfChildAttachment(item);
}

function normalizePaperContextEntries(value: unknown): PaperContextRef[] {
  return normalizePaperContextRefs(value, { sanitizeText });
}

function buildPaperRefFromContextItem(
  contextItem: Zotero.Item | null | undefined,
): PaperContextRef | null {
  return resolvePaperContextRefFromAttachment(contextItem);
}

function buildMetadataOnlyFallback(papers: PaperContextRef[]): string {
  if (!papers.length) return "";
  const blocks = papers.map((paper, index) => {
    return `Paper ${index + 1}\n${buildFullPaperContext(paper, undefined)}`;
  });
  return `Paper Context Metadata:\n\n${blocks.join("\n\n---\n\n")}`;
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

function tokenizeForMatching(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
}

function hasPaperQuestionSignals(question: string): boolean {
  const normalized = question.toLowerCase();
  if (!normalized.trim()) return false;
  if (
    /\b(paper|study|article|author|method|methodology|experiment|result|finding|conclusion|limitation|evidence|dataset|table|figure|section|citation|related work|ablation|baseline)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  if (
    /\b(compare|contrast|difference|similarity|why|how|what about|based on)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/\b(this|that|these|those|it|they|them)\b/.test(normalized)) {
    return true;
  }
  return false;
}

function isObviouslyContextFreeQuestion(question: string): boolean {
  const normalized = question.trim().toLowerCase();
  if (!normalized) return true;
  if (
    /^(hi|hello|hey|thanks|thank you|thx|ok|okay|cool|great|sounds good|got it)[.!?]*$/.test(
      normalized,
    )
  ) {
    return true;
  }
  return false;
}

function normalizeTextForLookup(value: string | undefined): string {
  return sanitizeText(value || "")
    .trim()
    .toLowerCase();
}

function collectPaperReferenceTokens(
  paperContext: PaperContextRef,
): Set<string> {
  const tokens = new Set<string>();
  const add = (value: string | undefined) => {
    const terms = tokenizeForMatching(value || "");
    for (const term of terms) tokens.add(term);
  };
  add(paperContext.title);
  add(paperContext.firstCreator);
  add(paperContext.citationKey);
  if (paperContext.year && /^\d{4}$/.test(paperContext.year.trim())) {
    tokens.add(paperContext.year.trim());
  }
  return tokens;
}

function parseOrdinalTargets(question: string): Set<number> {
  const normalized = question.toLowerCase();
  const out = new Set<number>();
  const numericMatches = normalized.match(/\bpaper\s*(\d+)\b/g) || [];
  for (const match of numericMatches) {
    const raw = match.replace(/[^0-9]/g, "");
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) out.add(parsed);
  }
  if (/\bfirst\b/.test(normalized)) out.add(1);
  if (/\bsecond\b/.test(normalized)) out.add(2);
  if (/\bthird\b/.test(normalized)) out.add(3);
  if (/\bfourth\b/.test(normalized)) out.add(4);
  if (/\bfifth\b/.test(normalized)) out.add(5);
  return out;
}

function rankUnpinnedPapersByQuestion(params: {
  papers: PlannerPaperEntry[];
  question: string;
}): PlannerPaperEntry[] {
  if (!params.papers.length) return [];
  if (isObviouslyContextFreeQuestion(params.question)) return [];

  const questionText = normalizeTextForLookup(params.question);
  const questionTokens = new Set(tokenizeForMatching(questionText));
  const ordinalTargets = parseOrdinalTargets(questionText);

  const scored = params.papers.map((paper) => {
    let score = 0;
    let explicit = false;
    if (ordinalTargets.has(paper.order)) {
      score += 10;
      explicit = true;
    }

    const citation = normalizeTextForLookup(paper.paperContext.citationKey);
    if (citation && questionText.includes(citation)) {
      score += 8;
      explicit = true;
    }

    const author = normalizeTextForLookup(paper.paperContext.firstCreator);
    if (author) {
      const authorTokens = tokenizeForMatching(author);
      for (const authorToken of authorTokens) {
        if (questionTokens.has(authorToken)) {
          score += 4;
          explicit = true;
          break;
        }
      }
    }

    const year = normalizeTextForLookup(paper.paperContext.year);
    if (year && questionText.includes(year)) {
      score += 2;
      explicit = true;
    }

    const paperTokens = collectPaperReferenceTokens(paper.paperContext);
    let overlap = 0;
    for (const token of paperTokens) {
      if (questionTokens.has(token)) overlap += 1;
    }
    score += overlap;
    if (overlap >= 2) explicit = true;

    return { paper, score, explicit };
  });

  const explicitHits = scored.filter(
    (entry) => entry.explicit && entry.score > 0,
  );
  if (explicitHits.length) {
    explicitHits.sort((a, b) => b.score - a.score);
    return explicitHits.map((entry) => entry.paper);
  }

  const questionLooksPaperGrounded = hasPaperQuestionSignals(questionText);
  if (!questionLooksPaperGrounded) {
    return [];
  }

  scored.sort((a, b) => b.score - a.score);
  const positive = scored
    .filter((entry) => entry.score > 0)
    .map((entry) => entry.paper);
  if (positive.length) {
    return positive.slice(0, Math.min(2, positive.length));
  }
  return params.papers.slice(0, 1);
}

type RetrievedAssembly = {
  contextText: string;
  selectedChunkCount: number;
  selectedPaperCount: number;
};

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
  apiOverrides?: { apiBase?: string; apiKey?: string };
}): Promise<RetrievedAssembly> {
  const {
    papers,
    question,
    contextBudgetTokens,
    minChunksByPaper,
    apiOverrides,
  } = params;
  if (!papers.length || contextBudgetTokens <= 0) {
    return { contextText: "", selectedChunkCount: 0, selectedPaperCount: 0 };
  }

  const allCandidates: PaperContextCandidate[] = [];
  for (const paper of papers) {
    const candidates = await buildPaperRetrievalCandidates(
      paper.paperContext,
      paper.pdfContext,
      question,
      apiOverrides,
      { topK: RETRIEVAL_TOP_K_PER_PAPER },
    );
    allCandidates.push(...candidates);
  }

  if (!allCandidates.length) {
    return {
      contextText: buildMetadataOnlyFallback(
        papers.map((entry) => entry.paperContext),
      ),
      selectedChunkCount: 0,
      selectedPaperCount: papers.length,
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

  const selected = new Map<string, PaperContextCandidate>();
  let remainingTokens = contextBudgetTokens;
  const selectCandidate = (candidate: PaperContextCandidate): boolean => {
    const key = candidateKey(candidate);
    if (selected.has(key)) return false;
    if (candidate.estimatedTokens > remainingTokens) return false;
    selected.set(key, candidate);
    remainingTokens -= candidate.estimatedTokens;
    return true;
  };

  // First pass: guarantee per-paper coverage before global reranking.
  for (const paper of papers) {
    const key = paper.paperKey;
    const minChunks = Math.max(0, minChunksByPaper?.get(key) || 0);
    if (minChunks <= 0) continue;
    const list = candidatesByPaper.get(key) || [];
    let added = 0;
    for (const candidate of list) {
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

  while (remainingTokens > 0) {
    let best: PaperContextCandidate | null = null;
    let bestUtility = -Infinity;
    for (const candidate of allCandidates) {
      const key = candidateKey(candidate);
      if (selected.has(key)) continue;
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
  };
}

function buildMinChunkMapForRetrievedPapers(
  papers: PlannerPaperEntry[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const paper of papers) {
    if (paper.pinKind === "none") {
      out.set(paper.paperKey, 0);
      continue;
    }
    out.set(
      paper.paperKey,
      paper.isActive
        ? RETRIEVAL_MIN_ACTIVE_PAPER_CHUNKS
        : RETRIEVAL_MIN_OTHER_PAPER_CHUNKS,
    );
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

async function resolvePlannerPaperEntries(params: {
  conversationMode: ConversationMode;
  activeContextItem: Zotero.Item | null;
  paperContexts: PaperContextRef[] | undefined;
  pinnedPaperContexts: PaperContextRef[] | undefined;
  historyPaperContexts: PaperContextRef[] | undefined;
}): Promise<PlannerPaperEntry[]> {
  const selected = normalizePaperContextEntries(params.paperContexts || []);
  const explicitlyPinned = normalizePaperContextEntries(
    params.pinnedPaperContexts || [],
  );
  const historyPool = normalizePaperContextEntries(
    params.historyPaperContexts || [],
  );
  const orderedRefs: PaperContextRef[] = [];
  const seen = new Set<string>();

  const explicitPinnedKeys = new Set(
    explicitlyPinned.map((paper) => buildPaperKey(paper)),
  );
  const activePaper =
    params.conversationMode === "paper"
      ? buildPaperRefFromContextItem(params.activeContextItem)
      : null;
  const activeKey = activePaper ? buildPaperKey(activePaper) : "";
  const includeHistoryPool =
    params.conversationMode === "paper" &&
    selected.length === 0 &&
    explicitlyPinned.length === 0;

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
  for (const paper of explicitlyPinned) {
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
      await ensurePDFTextCached(contextItem);
    }
    const isActive = Boolean(activeKey && paperKey === activeKey);
    const pinKind: PlannerPaperEntry["pinKind"] = explicitPinnedKeys.has(
      paperKey,
    )
      ? "explicit"
      : isActive && params.conversationMode === "paper"
        ? "implicit-active"
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
  pinnedPaperContexts?: PaperContextRef[];
  historyPaperContexts?: PaperContextRef[];
  history?: ChatMessage[];
  images?: string[];
  image?: string;
  model: string;
  reasoning?: ReasoningConfig;
  advanced?: AdvancedModelParams;
  apiBase?: string;
  apiKey?: string;
  systemPrompt?: string;
}): Promise<MultiContextPlan> {
  const papers = await resolvePlannerPaperEntries({
    conversationMode: params.conversationMode,
    activeContextItem: params.activeContextItem,
    paperContexts: params.paperContexts,
    pinnedPaperContexts: params.pinnedPaperContexts,
    historyPaperContexts: params.historyPaperContexts,
  });
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

  if (!papers.length) {
    return {
      mode: "retrieval",
      contextText: "",
      contextBudget: adjustedContextBudget,
      usedContextTokens: 0,
      selectedPaperCount: 0,
      selectedChunkCount: 0,
    };
  }

  const pinned = papers.filter((paper) => paper.pinKind !== "none");
  const explicitPinned = papers.filter((paper) => paper.pinKind === "explicit");
  const unpinned = papers.filter((paper) => paper.pinKind === "none");
  const relevantUnpinned = rankUnpinnedPapersByQuestion({
    papers: unpinned,
    question: params.question,
  });
  const fullPreferredPapers =
    params.conversationMode === "paper" ? pinned : explicitPinned;

  if (fullPreferredPapers.length) {
    const full = assembleFullMultiPaperContext({ papers: fullPreferredPapers });
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
      if (remainingTokens >= 1024 && relevantUnpinned.length) {
        extraUnpinned = await assembleRetrievedMultiPaperContext({
          papers: relevantUnpinned,
          question: params.question,
          contextBudgetTokens: remainingTokens,
          minChunksByPaper: new Map<string, number>(),
          apiOverrides: {
            apiBase: params.apiBase,
            apiKey: params.apiKey,
          },
        });
      }
      const extraBlock =
        extraUnpinned && extraUnpinned.selectedChunkCount > 0
          ? extraUnpinned.contextText
          : "";
      const combinedContext = appendContextBlocks([
        full.contextText,
        extraBlock,
      ]);
      const usedContextTokens = estimateTextTokens(combinedContext);
      const selectedPaperCount =
        fullPreferredPapers.length +
        (extraUnpinned?.selectedChunkCount
          ? extraUnpinned.selectedPaperCount
          : 0);
      return {
        mode: "full",
        contextText: combinedContext,
        contextBudget: adjustedContextBudget,
        usedContextTokens,
        selectedPaperCount,
        selectedChunkCount: extraUnpinned?.selectedChunkCount || 0,
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
        ...relevantUnpinned.filter(
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
            retrievalCompanionPapers,
          ),
          apiOverrides: {
            apiBase: params.apiBase,
            apiKey: params.apiKey,
          },
        });
      }
      const combinedContext = appendContextBlocks([
        partialFull.contextText,
        extraRetrieved?.selectedChunkCount ? extraRetrieved.contextText : "",
      ]);
      const usedContextTokens = estimateTextTokens(combinedContext);
      const selectedPaperCount =
        partialFull.selectedPaperCount +
        (extraRetrieved?.selectedChunkCount
          ? extraRetrieved.selectedPaperCount
          : 0);
      return {
        mode: "full",
        contextText: combinedContext,
        contextBudget: adjustedContextBudget,
        usedContextTokens,
        selectedPaperCount,
        selectedChunkCount: extraRetrieved?.selectedChunkCount || 0,
      };
    }
  }

  const retrievalPapers = [...pinned, ...relevantUnpinned];
  if (!retrievalPapers.length) {
    return {
      mode: "retrieval",
      contextText: "",
      contextBudget: adjustedContextBudget,
      usedContextTokens: 0,
      selectedPaperCount: 0,
      selectedChunkCount: 0,
    };
  }

  const retrieved = await assembleRetrievedMultiPaperContext({
    papers: retrievalPapers,
    question: params.question,
    contextBudgetTokens: adjustedContextBudget.contextBudgetTokens,
    minChunksByPaper: buildMinChunkMapForRetrievedPapers(retrievalPapers),
    apiOverrides: {
      apiBase: params.apiBase,
      apiKey: params.apiKey,
    },
  });
  const usedContextTokens = estimateTextTokens(retrieved.contextText);
  return {
    mode: "retrieval",
    contextText: retrieved.contextText,
    contextBudget: adjustedContextBudget,
    usedContextTokens,
    selectedPaperCount: retrieved.selectedPaperCount,
    selectedChunkCount: retrieved.selectedChunkCount,
  };
}

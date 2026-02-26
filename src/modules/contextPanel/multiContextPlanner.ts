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
  paperContext: PaperContextRef;
  contextItem: Zotero.Item | null;
  pdfContext: PdfContext | undefined;
};

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

type RetrievedAssembly = {
  contextText: string;
  selectedChunkCount: number;
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
  activePaperKey?: string;
  apiOverrides?: { apiBase?: string; apiKey?: string };
}): Promise<RetrievedAssembly> {
  const {
    papers,
    question,
    contextBudgetTokens,
    activePaperKey,
    apiOverrides,
  } = params;
  if (!papers.length || contextBudgetTokens <= 0) {
    return { contextText: "", selectedChunkCount: 0 };
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
    const key = buildPaperKey(paper.paperContext);
    const minChunks =
      key === activePaperKey
        ? RETRIEVAL_MIN_ACTIVE_PAPER_CHUNKS
        : RETRIEVAL_MIN_OTHER_PAPER_CHUNKS;
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
  };
}

async function resolvePlannerPaperEntries(params: {
  activeContextItem: Zotero.Item | null;
  paperContexts: PaperContextRef[] | undefined;
}): Promise<PlannerPaperEntry[]> {
  const selected = normalizePaperContextEntries(params.paperContexts || []);
  const orderedRefs: PaperContextRef[] = [];
  const seen = new Set<string>();

  const activePaper = buildPaperRefFromContextItem(params.activeContextItem);
  if (activePaper) {
    const key = buildPaperKey(activePaper);
    if (!seen.has(key)) {
      seen.add(key);
      orderedRefs.push(activePaper);
    }
  }

  for (const paper of selected) {
    const key = buildPaperKey(paper);
    if (seen.has(key)) continue;
    seen.add(key);
    orderedRefs.push(paper);
  }

  const out: PlannerPaperEntry[] = [];
  for (const paperContext of orderedRefs) {
    const contextItem = resolveContextItem(paperContext);
    if (contextItem) {
      await ensurePDFTextCached(contextItem);
    }
    out.push({
      paperContext,
      contextItem,
      pdfContext: contextItem ? pdfTextCache.get(contextItem.id) : undefined,
    });
  }
  return out;
}

export async function resolveMultiContextPlan(params: {
  activeContextItem: Zotero.Item | null;
  question: string;
  paperContexts?: PaperContextRef[];
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
    activeContextItem: params.activeContextItem,
    paperContexts: params.paperContexts,
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

  if (!papers.length) {
    return {
      mode: "retrieval",
      contextText: "",
      contextBudget,
      usedContextTokens: 0,
      selectedPaperCount: 0,
      selectedChunkCount: 0,
    };
  }

  const full = assembleFullMultiPaperContext({ papers });
  if (
    selectContextAssemblyMode({
      fullContextText: full.contextText,
      fullContextTokens: full.estimatedTokens,
      contextBudgetTokens: contextBudget.contextBudgetTokens,
    }) === "full"
  ) {
    return {
      mode: "full",
      contextText: full.contextText,
      contextBudget,
      usedContextTokens: full.estimatedTokens,
      selectedPaperCount: papers.length,
      selectedChunkCount: 0,
    };
  }

  const activePaper = buildPaperRefFromContextItem(params.activeContextItem);
  const retrieved = await assembleRetrievedMultiPaperContext({
    papers,
    question: params.question,
    contextBudgetTokens: contextBudget.contextBudgetTokens,
    activePaperKey: activePaper ? buildPaperKey(activePaper) : undefined,
    apiOverrides: {
      apiBase: params.apiBase,
      apiKey: params.apiKey,
    },
  });
  const usedContextTokens = estimateTextTokens(retrieved.contextText);
  return {
    mode: "retrieval",
    contextText: retrieved.contextText,
    contextBudget,
    usedContextTokens,
    selectedPaperCount: papers.length,
    selectedChunkCount: retrieved.selectedChunkCount,
  };
}

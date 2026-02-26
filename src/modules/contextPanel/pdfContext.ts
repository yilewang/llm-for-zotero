import { callEmbeddings } from "../../utils/llmClient";
import { estimateTextTokens } from "../../utils/modelInputCap";
import {
  CHUNK_TARGET_LENGTH,
  CHUNK_OVERLAP,
  EMBEDDING_BATCH_SIZE,
  HYBRID_WEIGHT_BM25,
  HYBRID_WEIGHT_EMBEDDING,
  RETRIEVAL_TOP_K_PER_PAPER,
  STOPWORDS,
} from "./constants";
import { pdfTextCache, pdfTextLoadingTasks } from "./state";
import type {
  PdfContext,
  ChunkStat,
  PaperContextRef,
  PaperContextCandidate,
} from "./types";

async function cachePDFText(item: Zotero.Item) {
  if (pdfTextCache.has(item.id)) return;

  try {
    let pdfText = "";
    const mainItem =
      item.isAttachment() && item.parentID
        ? Zotero.Items.get(item.parentID)
        : null;

    const title = mainItem?.getField("title") || item.getField("title") || "";

    const pdfItem =
      item.isAttachment() && item.attachmentContentType === "application/pdf"
        ? item
        : null;

    if (pdfItem) {
      try {
        const result = await Zotero.PDFWorker.getFullText(pdfItem.id);
        if (result && result.text) {
          pdfText = result.text;
        }
      } catch (e) {
        ztoolkit.log("PDF extraction failed:", e);
      }
    }

    if (pdfText) {
      const chunks = splitIntoChunks(pdfText, CHUNK_TARGET_LENGTH);
      const { chunkStats, docFreq, avgChunkLength } = buildChunkIndex(chunks);
      pdfTextCache.set(item.id, {
        title,
        chunks,
        chunkStats,
        docFreq,
        avgChunkLength,
        fullLength: pdfText.length,
        embeddingFailed: false,
      });
    } else {
      pdfTextCache.set(item.id, {
        title,
        chunks: [],
        chunkStats: [],
        docFreq: {},
        avgChunkLength: 0,
        fullLength: 0,
        embeddingFailed: false,
      });
    }
  } catch (e) {
    ztoolkit.log("Error caching PDF:", e);
    pdfTextCache.set(item.id, {
      title: "",
      chunks: [],
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 0,
      fullLength: 0,
      embeddingFailed: false,
    });
  }
}

export async function ensurePDFTextCached(item: Zotero.Item): Promise<void> {
  if (pdfTextCache.has(item.id)) return;
  const existingTask = pdfTextLoadingTasks.get(item.id);
  if (existingTask) {
    await existingTask;
    return;
  }
  const task = (async () => {
    try {
      await cachePDFText(item);
    } finally {
      pdfTextLoadingTasks.delete(item.id);
    }
  })();
  pdfTextLoadingTasks.set(item.id, task);
  await task;
}

function splitIntoChunks(text: string, targetLength: number): string[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;
    if (p.length > targetLength) {
      pushCurrent();
      let start = 0;
      while (start < p.length) {
        const end = Math.min(start + targetLength, p.length);
        const slice = p.slice(start, end).trim();
        if (slice) chunks.push(slice);
        if (end === p.length) break;
        start = Math.max(0, end - CHUNK_OVERLAP);
      }
      continue;
    }
    if (current.length + p.length + 2 <= targetLength) {
      current = current ? `${current}\n\n${p}` : p;
    } else {
      pushCurrent();
      current = p;
    }
  }
  pushCurrent();
  return chunks;
}

function tokenizeText(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function buildChunkIndex(chunks: string[]): {
  chunkStats: ChunkStat[];
  docFreq: Record<string, number>;
  avgChunkLength: number;
} {
  const docFreq: Record<string, number> = {};
  const chunkStats: ChunkStat[] = [];
  let totalLength = 0;

  chunks.forEach((chunk, index) => {
    const tokens = tokenizeText(chunk);
    const tf: Record<string, number> = {};
    for (const term of tokens) {
      tf[term] = (tf[term] || 0) + 1;
    }
    const uniqueTerms = Object.keys(tf);
    for (const term of uniqueTerms) {
      docFreq[term] = (docFreq[term] || 0) + 1;
    }
    const length = tokens.length;
    totalLength += length;
    chunkStats.push({ index, length, tf, uniqueTerms });
  });

  const avgChunkLength = chunks.length ? totalLength / chunks.length : 0;
  return { chunkStats, docFreq, avgChunkLength };
}

function tokenizeQuery(query: string): string[] {
  const tokens = tokenizeText(query);
  return Array.from(new Set(tokens));
}

function scoreChunkBM25(
  chunk: ChunkStat,
  terms: string[],
  docFreq: Record<string, number>,
  totalChunks: number,
  avgChunkLength: number,
): number {
  if (!terms.length || !chunk.length) return 0;
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;

  for (const term of terms) {
    const tf = chunk.tf[term] || 0;
    if (!tf) continue;
    const df = docFreq[term] || 0;
    const idf = Math.log(1 + (totalChunks - df + 0.5) / (df + 0.5));
    const norm =
      (tf * (k1 + 1)) /
      (tf + k1 * (1 - b + (b * chunk.length) / avgChunkLength));
    score += idf * norm;
  }

  return score;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalizeScores(scores: number[]): number[] {
  if (!scores.length) return [];
  let min = scores[0];
  let max = scores[0];
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  if (max === min) return scores.map(() => 0);
  return scores.map((s) => (s - min) / (max - min));
}

async function embedTexts(
  texts: string[],
  overrides?: { apiBase?: string; apiKey?: string },
): Promise<number[][]> {
  const all: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const batchEmbeddings = await callEmbeddings(batch, overrides);
    all.push(...batchEmbeddings);
  }
  return all;
}

async function ensureEmbeddings(
  pdfContext: PdfContext,
  overrides?: { apiBase?: string; apiKey?: string },
): Promise<boolean> {
  if (pdfContext.embeddingFailed) return false;
  if (pdfContext.embeddings && pdfContext.embeddings.length) {
    return pdfContext.embeddings.length === pdfContext.chunks.length;
  }

  if (pdfContext.embeddingPromise) {
    const result = await pdfContext.embeddingPromise;
    if (result) {
      pdfContext.embeddings = result;
      return result.length === pdfContext.chunks.length;
    }
    return false;
  }

  pdfContext.embeddingPromise = (async () => {
    try {
      const embeddings = await embedTexts(pdfContext.chunks, overrides);
      return embeddings;
    } catch (err) {
      ztoolkit.log("Embedding generation failed:", err);
      return null;
    }
  })();

  const result = await pdfContext.embeddingPromise;
  pdfContext.embeddingPromise = undefined;
  if (result) {
    pdfContext.embeddings = result;
    return result.length === pdfContext.chunks.length;
  }
  pdfContext.embeddingFailed = true;
  return false;
}

export function buildPaperKey(ref: PaperContextRef): string {
  return `${Math.floor(ref.itemId)}:${Math.floor(ref.contextItemId)}`;
}

function formatPaperMetadataLines(ref: PaperContextRef): string[] {
  const lines = [`Title: ${ref.title}`];
  if (ref.citationKey) lines.push(`Citation key: ${ref.citationKey}`);
  if (ref.firstCreator) lines.push(`Author: ${ref.firstCreator}`);
  if (ref.year) lines.push(`Year: ${ref.year}`);
  return lines;
}

export function buildFullPaperContext(
  paperContext: PaperContextRef,
  pdfContext: PdfContext | undefined,
): string {
  const metadata = formatPaperMetadataLines(paperContext);
  if (!pdfContext || !pdfContext.chunks.length) {
    return [
      ...metadata,
      "",
      "[No extractable PDF text available. Using metadata only.]",
    ].join("\n");
  }
  return [...metadata, "", "Paper Text:", pdfContext.chunks.join("\n\n")].join(
    "\n",
  );
}

function shouldTryEmbeddings(overrides?: {
  apiBase?: string;
  apiKey?: string;
}): boolean {
  if (!overrides) return false;
  return Boolean(
    (overrides.apiBase || "").trim() || (overrides.apiKey || "").trim(),
  );
}

export async function buildPaperRetrievalCandidates(
  paperContext: PaperContextRef,
  pdfContext: PdfContext | undefined,
  question: string,
  apiOverrides?: { apiBase?: string; apiKey?: string },
  options?: {
    topK?: number;
  },
): Promise<PaperContextCandidate[]> {
  if (!pdfContext) return [];
  const { chunks, chunkStats, docFreq, avgChunkLength } = pdfContext;
  if (!chunks.length || !chunkStats.length) return [];

  const topK = Number.isFinite(options?.topK)
    ? Math.max(1, Math.floor(options?.topK as number))
    : RETRIEVAL_TOP_K_PER_PAPER;

  const terms = tokenizeQuery(question);
  const bm25Scores = chunkStats.map((chunk) =>
    scoreChunkBM25(chunk, terms, docFreq, chunks.length, avgChunkLength || 1),
  );
  const bm25Norm = normalizeScores(bm25Scores);

  let embedNorm: number[] | null = null;
  if (question.trim() && shouldTryEmbeddings(apiOverrides)) {
    const embeddingsReady = await ensureEmbeddings(pdfContext, apiOverrides);
    if (embeddingsReady && pdfContext.embeddings) {
      try {
        const queryEmbedding =
          (await callEmbeddings([question], apiOverrides))[0] || [];
        if (queryEmbedding.length) {
          const embeddingScores = pdfContext.embeddings.map((vec) =>
            cosineSimilarity(queryEmbedding, vec),
          );
          embedNorm = normalizeScores(embeddingScores);
        }
      } catch (err) {
        ztoolkit.log("Query embedding failed:", err);
      }
    }
  }

  const bm25Weight = embedNorm ? HYBRID_WEIGHT_BM25 : 1;
  const embedWeight = embedNorm ? HYBRID_WEIGHT_EMBEDDING : 0;

  const scored = chunkStats.map((chunk, idx) => {
    const bm25Score = bm25Norm[idx] || 0;
    const embeddingScore = embedNorm ? embedNorm[idx] || 0 : 0;
    const hybridScore = bm25Score * bm25Weight + embeddingScore * embedWeight;
    return {
      index: chunk.index,
      chunkText: chunks[chunk.index],
      bm25Score,
      embeddingScore,
      hybridScore,
    };
  });

  scored.sort((a, b) => {
    if (b.hybridScore !== a.hybridScore) return b.hybridScore - a.hybridScore;
    return a.index - b.index;
  });

  return scored.slice(0, topK).map((entry) => ({
    paperKey: buildPaperKey(paperContext),
    itemId: paperContext.itemId,
    contextItemId: paperContext.contextItemId,
    title: paperContext.title,
    citationKey: paperContext.citationKey,
    firstCreator: paperContext.firstCreator,
    year: paperContext.year,
    chunkIndex: entry.index,
    chunkText: entry.chunkText,
    estimatedTokens: Math.max(1, estimateTextTokens(entry.chunkText)),
    bm25Score: entry.bm25Score,
    embeddingScore: entry.embeddingScore,
    hybridScore: entry.hybridScore,
  }));
}

export function renderEvidencePack(params: {
  papers: PaperContextRef[];
  candidates: PaperContextCandidate[];
}): string {
  const { papers, candidates } = params;
  if (!papers.length || !candidates.length) return "";

  const deduped = new Map<string, PaperContextCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.paperKey}:${candidate.chunkIndex}`;
    if (!deduped.has(key)) {
      deduped.set(key, candidate);
    }
  }

  const byPaper = new Map<string, PaperContextCandidate[]>();
  for (const candidate of deduped.values()) {
    const list = byPaper.get(candidate.paperKey) || [];
    list.push(candidate);
    byPaper.set(candidate.paperKey, list);
  }

  const blocks: string[] = [];
  for (const [paperIndex, paper] of papers.entries()) {
    const paperKey = buildPaperKey(paper);
    const paperCandidates = byPaper.get(paperKey) || [];
    if (!paperCandidates.length) continue;
    paperCandidates.sort((a, b) => a.chunkIndex - b.chunkIndex);
    const lines: string[] = [`Paper ${paperIndex + 1}`];
    lines.push(...formatPaperMetadataLines(paper));
    lines.push("", "Evidence:");
    for (const candidate of paperCandidates) {
      const label = `[P${paperIndex + 1}-C${candidate.chunkIndex + 1}]`;
      lines.push(label);
      lines.push(candidate.chunkText);
      lines.push("");
    }
    blocks.push(lines.join("\n").trimEnd());
  }

  if (!blocks.length) return "";
  return `Retrieved Evidence:\n\n${blocks.join("\n\n---\n\n")}`;
}

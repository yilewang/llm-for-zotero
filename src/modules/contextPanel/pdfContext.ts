import { callEmbeddings } from "../../utils/llmClient";
import {
  CHUNK_TARGET_LENGTH,
  CHUNK_OVERLAP,
  MAX_CONTEXT_CHUNKS,
  EMBEDDING_BATCH_SIZE,
  HYBRID_WEIGHT_BM25,
  HYBRID_WEIGHT_EMBEDDING,
  MAX_CONTEXT_LENGTH,
  MAX_CONTEXT_LENGTH_WITH_IMAGE,
  FORCE_FULL_CONTEXT,
  FULL_CONTEXT_CHAR_LIMIT,
  STOPWORDS,
} from "./constants";
import { pdfTextCache, pdfTextLoadingTasks } from "./state";
import type { PdfContext, ChunkStat } from "./types";

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

export async function buildContext(
  pdfContext: PdfContext | undefined,
  question: string,
  hasImage: boolean,
  apiOverrides?: { apiBase?: string; apiKey?: string },
): Promise<string> {
  if (!pdfContext) return "";
  const { title, chunks, chunkStats, docFreq, avgChunkLength, fullLength } =
    pdfContext;
  const contextParts: string[] = [];
  if (title) contextParts.push(`Title: ${title}`);
  if (!chunks.length) return contextParts.join("\n\n");
  if (FORCE_FULL_CONTEXT && !hasImage) {
    if (!fullLength || fullLength <= FULL_CONTEXT_CHAR_LIMIT) {
      contextParts.push("Paper Text:");
      contextParts.push(chunks.join("\n\n"));
      if (fullLength) {
        contextParts.push(`\n[Full context ${fullLength} chars]`);
      }
      return contextParts.join("\n\n");
    }
    contextParts.push(
      `\n[Full context ${fullLength} chars exceeds ${FULL_CONTEXT_CHAR_LIMIT}. Falling back to retrieval.]`,
    );
  }

  const terms = tokenizeQuery(question);
  const bm25Scores = chunkStats.map((chunk) =>
    scoreChunkBM25(chunk, terms, docFreq, chunks.length, avgChunkLength || 1),
  );

  let embeddingScores: number[] | null = null;
  const embeddingsReady = await ensureEmbeddings(pdfContext, apiOverrides);
  if (embeddingsReady && pdfContext.embeddings) {
    try {
      const queryEmbedding =
        (await callEmbeddings([question], apiOverrides))[0] || [];
      if (queryEmbedding.length) {
        embeddingScores = pdfContext.embeddings.map((vec) =>
          cosineSimilarity(queryEmbedding, vec),
        );
      }
    } catch (err) {
      ztoolkit.log("Query embedding failed:", err);
    }
  }

  const bm25Norm = normalizeScores(bm25Scores);
  const embedNorm = embeddingScores ? normalizeScores(embeddingScores) : null;

  const bm25Weight = embedNorm ? HYBRID_WEIGHT_BM25 : 1;
  const embedWeight = embedNorm ? HYBRID_WEIGHT_EMBEDDING : 0;

  const scored = chunkStats.map((chunk, idx) => ({
    index: chunk.index,
    chunk: chunks[chunk.index],
    score:
      bm25Norm[idx] * bm25Weight +
      (embedNorm ? embedNorm[idx] * embedWeight : 0),
  }));

  scored.sort((a, b) => b.score - a.score);
  const picked = new Set<number>();
  const addIndex = (idx: number) => {
    if (idx < 0 || idx >= chunks.length) return;
    if (picked.size >= MAX_CONTEXT_CHUNKS) return;
    picked.add(idx);
  };

  for (const entry of scored) {
    if (picked.size >= MAX_CONTEXT_CHUNKS) break;
    if (entry.score === 0 && picked.size > 0) break;
    addIndex(entry.index);
  }

  if (picked.size === 0) {
    addIndex(0);
    addIndex(1);
  }

  if (picked.size < MAX_CONTEXT_CHUNKS) {
    const primary = Array.from(picked);
    for (const idx of primary) {
      if (picked.size >= MAX_CONTEXT_CHUNKS) break;
      addIndex(idx - 1);
      if (picked.size >= MAX_CONTEXT_CHUNKS) break;
      addIndex(idx + 1);
    }
  }

  const totalChunks = chunks.length;
  let remaining = hasImage ? MAX_CONTEXT_LENGTH_WITH_IMAGE : MAX_CONTEXT_LENGTH;
  if (title) remaining -= `Title: ${title}`.length + 2;

  const excerpts: string[] = [];
  const sortedPicked = Array.from(picked).sort((a, b) => a - b);
  for (const index of sortedPicked) {
    if (index < 0 || index >= totalChunks) continue;
    const label = `Excerpt ${index + 1}/${totalChunks}`;
    const body = chunks[index];
    const block = `${label}\n${body}`;
    if (remaining <= 0) break;
    if (block.length > remaining) {
      excerpts.push(block.slice(0, Math.max(0, remaining)));
      remaining = 0;
      break;
    }
    excerpts.push(block);
    remaining -= block.length + 2;
  }

  if (excerpts.length) {
    contextParts.push("Paper Text:");
    contextParts.push(excerpts.join("\n\n"));
  }

  if (fullLength) {
    contextParts.push(`\n[Context window from ${fullLength} chars total]`);
  }

  return contextParts.join("\n\n");
}

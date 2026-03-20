import { callEmbeddings } from "../../utils/llmClient";
import { estimateTextTokens } from "../../utils/modelInputCap";
import {
  CHUNK_OVERLAP,
  EMBEDDING_BATCH_SIZE,
  CHUNK_TARGET_LENGTH,
  HYBRID_WEIGHT_BM25,
  HYBRID_WEIGHT_EMBEDDING,
  RETRIEVAL_TOP_K_PER_PAPER,
  STOPWORDS,
} from "./constants";
import {
  buildPaperQuoteCitationGuidance,
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "./paperAttribution";
import { readNoteSnapshot } from "./notes";
import { pdfTextCache, pdfTextLoadingTasks } from "./state";
import { readCachedMineruMd, invalidateMineruMd } from "./mineruCache";
import type {
  PdfContext,
  ChunkStat,
  PaperContextRef,
  PaperContextCandidate,
  PdfChunkMeta,
  PdfChunkKind,
} from "./types";

async function cachePDFText(item: Zotero.Item) {
  if (pdfTextCache.has(item.id)) return;

  try {
    let pdfText = "";
    let sourceType: "mineru" | "zotero-worker" | undefined;
    const mainItem =
      item.isAttachment() && item.parentID
        ? Zotero.Items.get(item.parentID)
        : null;

    const title = mainItem?.getField("title") || item.getField("title") || "";

    const pdfItem =
      item.isAttachment() && item.attachmentContentType === "application/pdf"
        ? item
        : null;

    // 1. Try MinerU disk cache (silent — no cloud API calls here)
    const cachedMd = await readCachedMineruMd(item.id);
    if (cachedMd) {
      pdfText = cachedMd;
      sourceType = "mineru";
    }

    // 2. Fallback to Zotero.PDFWorker
    if (!pdfText && pdfItem) {
      try {
        const result = await Zotero.PDFWorker.getFullText(pdfItem.id);
        if (result && result.text) {
          pdfText = result.text;
          sourceType = "zotero-worker";
        }
      } catch (e) {
        ztoolkit.log("PDF extraction failed:", e);
      }
    }

    if (pdfText) {
      const chunks = splitIntoChunks(pdfText, CHUNK_TARGET_LENGTH);
      const chunkMeta = buildChunkMetadata(chunks);
      const { chunkStats, docFreq, avgChunkLength } = buildChunkIndex(chunks);
      pdfTextCache.set(item.id, {
        title,
        chunks,
        chunkMeta,
        chunkStats,
        docFreq,
        avgChunkLength,
        fullLength: pdfText.length,
        embeddingFailed: false,
        sourceType,
      });
    } else {
      pdfTextCache.set(item.id, {
        title,
        chunks: [],
        chunkMeta: [],
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
      chunkMeta: [],
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

async function cacheNoteText(item: Zotero.Item) {
  if (pdfTextCache.has(item.id)) return;
  try {
    const snapshot = readNoteSnapshot(item);
    const text = snapshot?.text || "";
    const title = sanitizePdfText(snapshot?.title || text.split("\n")[0] || "").slice(0, 120);
    if (text) {
      const chunks = splitIntoChunks(text, CHUNK_TARGET_LENGTH);
      const chunkMeta = buildChunkMetadata(chunks);
      const { chunkStats, docFreq, avgChunkLength } = buildChunkIndex(chunks);
      pdfTextCache.set(item.id, {
        title,
        chunks,
        chunkMeta,
        chunkStats,
        docFreq,
        avgChunkLength,
        fullLength: text.length,
        embeddingFailed: false,
      });
    } else {
      pdfTextCache.set(item.id, {
        title,
        chunks: [],
        chunkMeta: [],
        chunkStats: [],
        docFreq: {},
        avgChunkLength: 0,
        fullLength: 0,
        embeddingFailed: false,
      });
    }
  } catch (e) {
    ztoolkit.log("Error caching note:", e);
    pdfTextCache.set(item.id, {
      title: "",
      chunks: [],
      chunkMeta: [],
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 0,
      fullLength: 0,
      embeddingFailed: false,
    });
  }
}

export async function ensureNoteTextCached(item: Zotero.Item): Promise<void> {
  if (pdfTextCache.has(item.id)) return;
  const existingTask = pdfTextLoadingTasks.get(item.id);
  if (existingTask) {
    await existingTask;
    return;
  }
  const task = (async () => {
    try {
      await cacheNoteText(item);
    } finally {
      pdfTextLoadingTasks.delete(item.id);
    }
  })();
  pdfTextLoadingTasks.set(item.id, task);
  await task;
}

export function invalidateCachedContextText(itemId: number): void {
  if (!Number.isFinite(itemId) || itemId <= 0) return;
  const normalizedItemId = Math.floor(itemId);
  pdfTextCache.delete(normalizedItemId);
  pdfTextLoadingTasks.delete(normalizedItemId);
  invalidateMineruMd(normalizedItemId).catch((e) => {
    ztoolkit.log("MinerU cache invalidation failed:", e);
  });
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

type SectionHeadingPattern = {
  label: string;
  kind: PdfChunkKind;
  pattern: RegExp;
};

type SectionHeadingMatch = {
  label: string;
  kind: PdfChunkKind;
};

const SECTION_HEADING_PATTERNS: SectionHeadingPattern[] = [
  {
    label: "Abstract",
    kind: "abstract",
    pattern: /^(?:\d+(?:\.\d+)*)?\s*abstract\b[:.\s-]*$/i,
  },
  {
    label: "Introduction",
    kind: "introduction",
    pattern: /^(?:\d+(?:\.\d+)*)?\s*introduction\b[:.\s-]*$/i,
  },
  {
    label: "Related Work",
    kind: "introduction",
    pattern: /^(?:\d+(?:\.\d+)*)?\s*related work\b[:.\s-]*$/i,
  },
  {
    label: "Methods",
    kind: "methods",
    pattern:
      /^(?:\d+(?:\.\d+)*)?\s*(?:methods?|methodology|materials and methods)\b[:.\s-]*$/i,
  },
  {
    label: "Results",
    kind: "results",
    pattern: /^(?:\d+(?:\.\d+)*)?\s*results?\b[:.\s-]*$/i,
  },
  {
    label: "Discussion",
    kind: "discussion",
    pattern: /^(?:\d+(?:\.\d+)*)?\s*discussion\b[:.\s-]*$/i,
  },
  {
    label: "Conclusion",
    kind: "conclusion",
    pattern: /^(?:\d+(?:\.\d+)*)?\s*conclusions?\b[:.\s-]*$/i,
  },
  {
    label: "Appendix",
    kind: "appendix",
    pattern:
      /^(?:\d+(?:\.\d+)*)?\s*(?:appendix|supplement(?:ary)? materials?)\b[:.\s-]*$/i,
  },
  {
    label: "References",
    kind: "references",
    pattern:
      /^(?:\d+(?:\.\d+)*)?\s*(?:references|bibliography|works cited|literature cited|references and notes)\b[:.\s-]*$/i,
  },
];

const FIGURE_CAPTION_PATTERN =
  /^(?:\d+\s+)?(?:fig(?:ure)?\.?)\s*(?:s(?:upp(?:lementary)?)?\s*)?\d+[a-z]?(?:\s*[:.)-]\s*|\s+)/i;
const TABLE_CAPTION_PATTERN =
  /^(?:\d+\s+)?table\s*(?:s(?:upp(?:lementary)?)?\s*)?\d+[a-z]?(?:\s*[:.)-]\s*|\s+)/i;

function normalizeEvidenceText(value: string): string {
  return sanitizePdfText(value).replace(/\s+/g, " ").trim();
}

function sanitizePdfText(value: string): string {
  return (value || "").replace(/\r\n?/g, "\n").trim();
}

function matchSectionHeading(
  chunkText: string,
): SectionHeadingMatch | undefined {
  const lines = sanitizePdfText(chunkText)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  for (const line of lines) {
    for (const heading of SECTION_HEADING_PATTERNS) {
      if (heading.pattern.test(line)) {
        return { label: heading.label, kind: heading.kind };
      }
    }
    if (line.length > 100 || /[.!?]/.test(line)) {
      break;
    }
  }
  const normalized = normalizeEvidenceText(chunkText);
  for (const heading of SECTION_HEADING_PATTERNS) {
    const inlinePattern = new RegExp(
      `^(?:\\d+(?:\\.\\d+)*)?\\s*${heading.label.replace(/\s+/g, "\\s+")}\\b[:.\\s-]+`,
      "i",
    );
    if (inlinePattern.test(normalized)) {
      return { label: heading.label, kind: heading.kind };
    }
  }
  return undefined;
}

function trimLeadingSectionHeading(
  chunkText: string,
  sectionLabel: string | undefined,
): string {
  if (!sectionLabel) return sanitizePdfText(chunkText);
  const trimmed = sanitizePdfText(chunkText);
  const lines = trimmed.split(/\n+/);
  const firstLine = lines[0]?.trim() || "";
  const headingPattern = new RegExp(
    `^(?:\\d+(?:\\.\\d+)*)?\\s*${sectionLabel.replace(/\s+/g, "\\s+")}\\b[:.\\s-]*$`,
    "i",
  );
  if (headingPattern.test(firstLine)) {
    return lines.slice(1).join(" ").trim() || trimmed;
  }
  const inlinePattern = new RegExp(
    `^(?:\\d+(?:\\.\\d+)*)?\\s*${sectionLabel.replace(/\s+/g, "\\s+")}\\b[:.\\s-]+`,
    "i",
  );
  return trimmed.replace(inlinePattern, "").trim() || trimmed;
}

function looksLikeReferenceEntry(text: string): boolean {
  const normalized = normalizeEvidenceText(text);
  if (!normalized) return false;
  const tokenCount = normalized.split(/\s+/).length;
  if (tokenCount < 4) return false;
  return (
    /\b(?:19|20)\d{2}[a-z]?\b/.test(normalized) ||
    /\bdoi\b/i.test(normalized) ||
    /https?:\/\//i.test(normalized) ||
    /^\[\d+\]/.test(normalized) ||
    /^\d{1,3}[.)]/.test(normalized)
  );
}

function looksLikeCitationList(text: string): boolean {
  const normalized = normalizeEvidenceText(text);
  if (!normalized) return false;
  return (
    looksLikeReferenceEntry(normalized) ||
    /^[A-Z][A-Za-z'`.-]+(?:,\s*[A-Z][A-Za-z'`.-]+){2,}.*\b(?:19|20)\d{2}[a-z]?\b/.test(
      normalized,
    )
  );
}

function looksLikeFigureCaption(text: string): boolean {
  return FIGURE_CAPTION_PATTERN.test(sanitizePdfText(text));
}

function looksLikeTableCaption(text: string): boolean {
  return TABLE_CAPTION_PATTERN.test(sanitizePdfText(text));
}

function cleanLeadingEvidenceNoise(text: string, chunkKind: PdfChunkKind): {
  text: string;
  removedLeadingNoise: boolean;
} {
  const original = normalizeEvidenceText(text);
  let cleaned = original;
  if (chunkKind === "figure-caption") {
    cleaned = cleaned.replace(FIGURE_CAPTION_PATTERN, "").trim();
  } else if (chunkKind === "table-caption") {
    cleaned = cleaned.replace(TABLE_CAPTION_PATTERN, "").trim();
  }
  cleaned = cleaned.replace(/^[-–—:;,.()\[\]]+\s*/, "").trim();
  cleaned = cleaned.replace(/^(?:\d{1,3}\s+){1,3}(?=[A-Za-z])/u, "").trim();
  cleaned = cleaned.replace(
    /^(?:[a-z][a-z-]{1,24}\.)\s+(?=[A-Z])/u,
    "",
  );
  cleaned = cleaned.replace(
    /^(?:page|p)\s*\d{1,4}(?:\s+of\s+\d{1,4})?\s*/i,
    "",
  );
  cleaned = cleaned.replace(/^[-–—:;,.()\[\]]+\s*/, "").trim();
  return {
    text: cleaned || original,
    removedLeadingNoise: Boolean(cleaned && cleaned !== original),
  };
}

function buildEvidenceAnchorFromText(text: string): string {
  const normalized = normalizeEvidenceText(text);
  if (!normalized) return "";
  const maxChars = 120;
  const sentenceBoundary = normalized.search(/[.!?](?:\s|$)/);
  if (sentenceBoundary >= 25 && sentenceBoundary < maxChars) {
    return normalized.slice(0, sentenceBoundary + 1).trim();
  }
  if (normalized.length <= maxChars) return normalized;
  const boundary = normalized.lastIndexOf(" ", maxChars);
  const truncated =
    boundary >= 40
      ? normalized.slice(0, boundary).trim()
      : normalized.slice(0, maxChars).trim();
  return `${truncated}...`;
}

function resolveChunkKind(params: {
  chunkText: string;
  normalizedText: string;
  sectionHeading?: SectionHeadingMatch;
}): PdfChunkKind {
  const { chunkText, normalizedText, sectionHeading } = params;
  if (sectionHeading?.kind) {
    return sectionHeading.kind;
  }
  if (looksLikeReferenceEntry(normalizedText) || looksLikeCitationList(normalizedText)) {
    return "references";
  }
  if (looksLikeFigureCaption(chunkText)) {
    return "figure-caption";
  }
  if (looksLikeTableCaption(chunkText)) {
    return "table-caption";
  }
  if (/\bappendix\b/i.test(normalizedText)) {
    return "appendix";
  }
  return normalizedText ? "body" : "unknown";
}

function getSupportLevelLabel(chunkKind: PdfChunkKind | undefined): string {
  switch (chunkKind) {
    case "abstract":
    case "results":
    case "discussion":
    case "conclusion":
      return "likely direct";
    case "methods":
    case "introduction":
    case "body":
    case "figure-caption":
    case "table-caption":
      return "contextual";
    case "references":
      return "background only";
    case "appendix":
      return "weak or peripheral";
    default:
      return "contextual";
  }
}

export function buildChunkMetadata(chunks: string[]): PdfChunkMeta[] {
  const chunkMeta: PdfChunkMeta[] = [];
  let activeSection: SectionHeadingMatch | undefined;
  for (const [chunkIndex, chunkText] of chunks.entries()) {
    const explicitSection = matchSectionHeading(chunkText);
    if (explicitSection) {
      activeSection = explicitSection;
    }
    const normalizedText = normalizeEvidenceText(chunkText);
    const sectionHeading = explicitSection || activeSection;
    const chunkKind = resolveChunkKind({
      chunkText,
      normalizedText,
      sectionHeading,
    });
    const textWithoutHeading = explicitSection
      ? trimLeadingSectionHeading(chunkText, explicitSection.label)
      : sanitizePdfText(chunkText);
    const cleaned = cleanLeadingEvidenceNoise(textWithoutHeading, chunkKind);
    chunkMeta.push({
      chunkIndex,
      text: chunkText,
      normalizedText,
      sectionLabel: sectionHeading?.label,
      chunkKind,
      anchorText: buildEvidenceAnchorFromText(cleaned.text) || undefined,
      leadingNoiseRemoved: cleaned.removedLeadingNoise || undefined,
    });
  }
  return chunkMeta;
}

function buildCompactPaperSourceLabel(ref: PaperContextRef): string {
  const verbose = normalizeEvidenceText(formatPaperCitationLabel(ref));
  if (verbose && !/^paper\b/i.test(verbose)) {
    return verbose
      .replace(/\set al\.,?/gi, "")
      .replace(/,/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (ref.citationKey) {
    return normalizeEvidenceText(ref.citationKey);
  }
  return /^paper\b/i.test(verbose) ? verbose : "Paper";
}

function buildEvidenceAnchor(
  chunkText: string,
  sectionLabel?: string,
  chunkKind: PdfChunkKind = "body",
  fallbackAnchor?: string,
): string {
  if (fallbackAnchor) {
    return fallbackAnchor;
  }
  const textWithoutHeading = trimLeadingSectionHeading(chunkText, sectionLabel);
  const cleaned = cleanLeadingEvidenceNoise(textWithoutHeading, chunkKind);
  return buildEvidenceAnchorFromText(cleaned.text);
}

export function formatSuggestedEvidenceCitation(
  paper: PaperContextRef,
  candidate: Pick<
    PaperContextCandidate,
    "chunkText" | "sectionLabel" | "chunkKind" | "anchorText"
  >,
): string {
  const citationParts = [buildCompactPaperSourceLabel(paper)];
  const sectionLabel =
    candidate.sectionLabel ||
    matchSectionHeading(candidate.chunkText)?.label;
  if (sectionLabel) {
    citationParts.push(sectionLabel);
  }
  const anchor = buildEvidenceAnchor(
    candidate.chunkText,
    sectionLabel,
    candidate.chunkKind || "body",
    candidate.anchorText,
  );
  if (anchor) {
    citationParts.push(`"${anchor}"`);
  }
  return `(${citationParts.join(", ")})`;
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
  lines.push(`Source label: ${formatPaperSourceLabel(ref)}`);
  return lines;
}

function formatPerPaperQuoteGuidanceLines(ref: PaperContextRef): string[] {
  return buildPaperQuoteCitationGuidance(ref);
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
      ...formatPerPaperQuoteGuidanceLines(paperContext),
      "",
      "[No extractable PDF text available. Using metadata only.]",
    ].join("\n");
  }
  return [
    ...metadata,
    "",
    ...formatPerPaperQuoteGuidanceLines(paperContext),
    "",
    "Paper Text:",
    pdfContext.chunks.join("\n\n"),
  ].join("\n");
}

export function buildTruncatedFullPaperContext(
  paperContext: PaperContextRef,
  pdfContext: PdfContext | undefined,
  options: { maxTokens: number },
): {
  text: string;
  estimatedTokens: number;
  truncated: boolean;
  fullLength: number;
} {
  const metadata = formatPaperMetadataLines(paperContext);
  if (!pdfContext || !pdfContext.chunks.length) {
    const text = [
      ...metadata,
      "",
      ...formatPerPaperQuoteGuidanceLines(paperContext),
      "",
      "[No extractable PDF text available. Using metadata only.]",
    ].join("\n");
    return {
      text,
      estimatedTokens: estimateTextTokens(text),
      truncated: false,
      fullLength: pdfContext?.fullLength || 0,
    };
  }

  const maxTokens = Math.max(1, Math.floor(options.maxTokens));
  const parts = [
    ...metadata,
    "",
    ...formatPerPaperQuoteGuidanceLines(paperContext),
    "",
    "Paper Text:",
  ];
  let text = parts.join("\n");
  let estimatedTokens = estimateTextTokens(text);
  let includedChunks = 0;

  for (const chunk of pdfContext.chunks) {
    const nextText = `${text}\n\n${chunk}`;
    const nextTokens = estimateTextTokens(nextText);
    if (nextTokens > maxTokens) {
      break;
    }
    text = nextText;
    estimatedTokens = nextTokens;
    includedChunks += 1;
  }

  const truncated = includedChunks < pdfContext.chunks.length;
  if (!includedChunks) {
    text = [
      ...metadata,
      "",
      ...formatPerPaperQuoteGuidanceLines(paperContext),
      "",
      "[Full paper text was available but exceeded the current tool budget before any chunk could be included.]",
    ].join("\n");
    estimatedTokens = estimateTextTokens(text);
  }

  return {
    text,
    estimatedTokens,
    truncated,
    fullLength: pdfContext.fullLength,
  };
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

function queryMentionsFiguresOrTables(question: string): boolean {
  return /\b(?:figure|fig\.?|table|caption)\b/i.test(question);
}

function queryLooksMethodFocused(question: string): boolean {
  return /\b(?:method|methods|methodology|training|implementation|algorithm|setup|dataset|protocol|procedure|hyperparameter)\b/i.test(
    question,
  );
}

function scoreEvidenceHeuristics(params: {
  candidate: PaperContextCandidate;
  question: string;
}): number {
  const { candidate, question } = params;
  const chunkText = normalizeEvidenceText(candidate.chunkText);
  const wordCount = chunkText ? chunkText.split(/\s+/).length : 0;
  const wantsVisuals = queryMentionsFiguresOrTables(question);
  const wantsMethods = queryLooksMethodFocused(question);
  let score = 0;

  switch (candidate.chunkKind) {
    case "abstract":
      score += 0.9;
      break;
    case "results":
      score += 1.2;
      break;
    case "discussion":
      score += 0.95;
      break;
    case "conclusion":
      score += 0.8;
      break;
    case "methods":
      score += wantsMethods ? 0.2 : -0.2;
      break;
    case "introduction":
      score += 0.2;
      break;
    case "figure-caption":
    case "table-caption":
      score += wantsVisuals ? -0.1 : -1.1;
      break;
    case "appendix":
      score -= 1.6;
      break;
    case "references":
      score -= 2.4;
      break;
    case "body":
      score += 0.1;
      break;
    default:
      score -= 0.1;
      break;
  }

  if (wordCount > 0 && wordCount < 7) {
    score -= 0.7;
  } else if (wordCount > 0 && wordCount < 12) {
    score -= 0.25;
  }

  if (looksLikeCitationList(chunkText)) {
    score -= 1.3;
  }
  if (candidate.leadingNoiseRemoved && wordCount < 16) {
    score -= 0.15;
  }
  if (!candidate.anchorText) {
    score -= 0.25;
  }
  return score;
}

export async function buildPaperRetrievalCandidates(
  paperContext: PaperContextRef,
  pdfContext: PdfContext | undefined,
  question: string,
  apiOverrides?: { apiBase?: string; apiKey?: string },
  options?: {
    topK?: number;
    mode?: "general" | "evidence";
  },
): Promise<PaperContextCandidate[]> {
  if (!pdfContext) return [];
  const { chunks, chunkStats, docFreq, avgChunkLength } = pdfContext;
  if (!chunks.length || !chunkStats.length) return [];
  const chunkMeta =
    Array.isArray(pdfContext.chunkMeta) &&
    pdfContext.chunkMeta.length === chunks.length
      ? pdfContext.chunkMeta
      : buildChunkMetadata(chunks);

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
  const retrievalMode = options?.mode || "general";

  const scored = chunkStats.map((chunk, idx) => {
    const bm25Score = bm25Norm[idx] || 0;
    const embeddingScore = embedNorm ? embedNorm[idx] || 0 : 0;
    const hybridScore = bm25Score * bm25Weight + embeddingScore * embedWeight;
    const meta = chunkMeta[chunk.index];
    const candidate: PaperContextCandidate = {
      paperKey: buildPaperKey(paperContext),
      itemId: paperContext.itemId,
      contextItemId: paperContext.contextItemId,
      title: paperContext.title,
      citationKey: paperContext.citationKey,
      firstCreator: paperContext.firstCreator,
      year: paperContext.year,
      chunkIndex: chunk.index,
      chunkText: chunks[chunk.index],
      sectionLabel: meta?.sectionLabel,
      chunkKind: meta?.chunkKind,
      anchorText: meta?.anchorText,
      leadingNoiseRemoved: meta?.leadingNoiseRemoved,
      estimatedTokens: Math.max(1, estimateTextTokens(chunks[chunk.index])),
      bm25Score,
      embeddingScore,
      hybridScore,
      evidenceScore: hybridScore,
    };
    const evidenceScore =
      retrievalMode === "evidence"
        ? hybridScore + scoreEvidenceHeuristics({ candidate, question })
        : hybridScore;
    candidate.evidenceScore = evidenceScore;
    return {
      candidate,
      score: evidenceScore,
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.candidate.chunkIndex - b.candidate.chunkIndex;
  });

  return scored.slice(0, topK).map((entry) => entry.candidate);
}

function buildEvidenceQuoteText(
  candidate: Pick<
    PaperContextCandidate,
    "chunkText" | "sectionLabel" | "chunkKind"
  >,
): string {
  const baseText = sanitizePdfText(candidate.chunkText);
  if (!baseText) return "";
  const sectionLabel =
    candidate.sectionLabel || matchSectionHeading(candidate.chunkText)?.label;
  return cleanLeadingEvidenceNoise(
    trimLeadingSectionHeading(baseText, sectionLabel),
    candidate.chunkKind || "body",
  ).text;
}

function formatMarkdownBlockquote(text: string): string {
  const normalized = sanitizePdfText(text);
  if (!normalized) return "> [No quoted text available]";
  return normalized
    .split(/\n+/)
    .map((line) => `> ${line.trim()}`)
    .join("\n");
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

  const blocks: string[] = [
    [
      "Retrieved Evidence:",
      "",
      ...buildPaperQuoteCitationGuidance(),
      "The full paper remains available in paper chat.",
      "For this reply, prioritize these retrieved snippets as the primary evidence pack.",
      "Do not use snippets from references as empirical evidence.",
      "If support is weak or indirect, say so instead of overstating the claim.",
    ].join("\n"),
  ];
  for (const [paperIndex, paper] of papers.entries()) {
    const paperKey = buildPaperKey(paper);
    const paperCandidates = byPaper.get(paperKey) || [];
    if (!paperCandidates.length) continue;
    paperCandidates.sort((a, b) => a.chunkIndex - b.chunkIndex);
    const lines: string[] = [`Paper ${paperIndex + 1}`];
    lines.push(...formatPaperMetadataLines(paper));
    lines.push("", "Evidence:");
    for (const [candidateIndex, candidate] of paperCandidates.entries()) {
      lines.push(`Evidence snippet ${candidateIndex + 1}`);
      lines.push(`Section: ${candidate.sectionLabel || "Unlabeled body text"}`);
      lines.push(`Source label: ${formatPaperSourceLabel(paper)}`);
      lines.push("Quoted evidence:");
      lines.push(formatMarkdownBlockquote(buildEvidenceQuoteText(candidate)));
      lines.push("");
    }
    blocks.push(lines.join("\n").trimEnd());
  }

  if (blocks.length <= 1) return "";
  return blocks.join("\n\n---\n\n");
}

export function renderClaimEvidencePack(params: {
  paper: PaperContextRef;
  candidates: PaperContextCandidate[];
}): string {
  const { paper, candidates } = params;
  if (!candidates.length) return "";
  const lines = [
    "Claim Evidence:",
    "",
    ...buildPaperQuoteCitationGuidance(),
    "The full paper remains available in paper chat.",
    "Use the evidence snippets below as the primary grounding for this claim assessment.",
    "Do not treat references or background citations as direct empirical evidence.",
    "If the evidence is indirect or mixed, say so explicitly.",
    "",
  ];
  candidates.forEach((candidate, index) => {
    lines.push(`Evidence snippet ${index + 1}`);
    lines.push(
      `Support level: ${getSupportLevelLabel(candidate.chunkKind).toLowerCase()}`,
    );
    lines.push(`Section: ${candidate.sectionLabel || "Unlabeled body text"}`);
    lines.push(`Source label: ${formatPaperSourceLabel(paper)}`);
    lines.push("Quoted evidence:");
    lines.push(formatMarkdownBlockquote(buildEvidenceQuoteText(candidate)));
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

import {
  callEmbeddings,
  EmbeddingUnsupportedError,
  getResolvedEmbeddingConfig,
  checkEmbeddingAvailability,
  getEmbeddingUnavailableReason,
} from "../../utils/llmClient";
import { estimateTextTokens } from "../../utils/modelInputCap";
import {
  computeChunkHash,
  loadCachedEmbeddings,
  saveCachedEmbeddings,
} from "./embeddingCache";
import {
  CHUNK_OVERLAP,
  EMBEDDING_BATCH_SIZE,
  CHUNK_TARGET_LENGTH,
  RETRIEVAL_TOP_K_PER_PAPER,
  RRF_K,
  STOPWORDS,
} from "./constants";
import {
  buildPaperQuoteCitationGuidance,
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "./paperAttribution";
import { readNoteSnapshot } from "./notes";
import { pdfTextCache, pdfTextLoadingTasks } from "./state";
import { readCachedMineruMd, ensureManifest } from "./mineruCache";
import type { MineruManifest, ManifestSection } from "./mineruCache";
import { isMineruEnabled } from "../../utils/mineruConfig";
import type {
  PdfContext,
  ChunkStat,
  PaperContextRef,
  PaperContextCandidate,
  PdfChunkMeta,
  PdfChunkKind,
} from "./types";
import { config } from "./constants";

const prefKey = (key: string) => `${config.prefsPrefix}.${key}`;
const getPref = (key: string) => Zotero.Prefs.get(prefKey(key), true);

// ── HTML table → Markdown table conversion ──────────────────────────────────
// MinerU sometimes emits tables as raw <table> HTML in the markdown.
// LLMs struggle with HTML table markup, so we convert to markdown tables
// at ingestion time (once, in memory) for better readability.

const HTML_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeHtmlEntities(text: string): string {
  let result = text;
  for (const [entity, char] of Object.entries(HTML_ENTITY_MAP)) {
    result = result.split(entity).join(char);
  }
  // Decode numeric entities: &#123; and &#x1A;
  result = result.replace(/&#(\d+);/g, (_, code) =>
    String.fromCharCode(Number(code)),
  );
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  return result;
}

function htmlTableToMarkdown(tableHtml: string): string {
  // Extract rows: split by <tr> tags
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellPattern = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

  const rows: string[][] = [];
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(tableHtml)) !== null) {
    const rowHtml = rowMatch[1];
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    const cellRe = new RegExp(cellPattern.source, cellPattern.flags);
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      // Strip any nested HTML tags, decode entities, trim
      const cellText = decodeHtmlEntities(
        cellMatch[1].replace(/<[^>]*>/g, "").trim(),
      );
      cells.push(cellText);
    }
    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  if (rows.length === 0) return "";

  // Normalize column count (pad shorter rows)
  const maxCols = Math.max(...rows.map((r) => r.length));
  for (const row of rows) {
    while (row.length < maxCols) row.push("");
  }

  // Build markdown table
  const lines: string[] = [];
  // Header row
  lines.push("| " + rows[0].map((c) => c || " ").join(" | ") + " |");
  // Separator
  lines.push("| " + rows[0].map(() => "---").join(" | ") + " |");
  // Data rows
  for (let i = 1; i < rows.length; i++) {
    lines.push("| " + rows[i].map((c) => c || " ").join(" | ") + " |");
  }

  return lines.join("\n");
}

function convertHtmlTablesToMarkdown(mdText: string): string {
  // Match <table>...</table> blocks (possibly spanning multiple lines)
  return mdText.replace(/<table[^>]*>[\s\S]*?<\/table>/gi, (tableBlock) => {
    try {
      const md = htmlTableToMarkdown(tableBlock);
      return md || tableBlock; // Keep original if conversion produces nothing
    } catch {
      return tableBlock; // Keep original on error
    }
  });
}

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

    // 1. Try MinerU disk cache (only if MinerU is enabled)
    const cachedMd = isMineruEnabled()
      ? await readCachedMineruMd(item.id)
      : null;
    if (cachedMd) {
      pdfText = convertHtmlTablesToMarkdown(cachedMd);
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
      // Try manifest-aware chunking for MinerU papers
      let manifest: MineruManifest | null = null;
      if (sourceType === "mineru") {
        try {
          manifest = await ensureManifest(item.id);
        } catch {
          // Non-critical — fall back to heuristic chunking
        }
      }

      let chunks: string[];
      let chunkMeta: PdfChunkMeta[];

      if (manifest && !manifest.noSections && manifest.sections.length > 0) {
        // Manifest-aware chunking: slice from the raw markdown (offsets match raw full.md),
        // build metadata from the raw chunks, then convert HTML tables for LLM readability.
        // Using pdfText (post-conversion) would misalign because convertHtmlTablesToMarkdown
        // changes character counts.
        const rawMd = cachedMd!;
        const rawChunks = splitWithManifestSections(
          rawMd,
          manifest.sections,
          CHUNK_TARGET_LENGTH,
        );
        chunkMeta = buildChunkMetadataFromManifest(
          rawChunks,
          rawMd,
          manifest.sections,
        );
        chunks = rawChunks.map((chunk) => convertHtmlTablesToMarkdown(chunk));
        // Update chunkMeta text fields to reflect converted content
        for (let i = 0; i < chunks.length; i++) {
          chunkMeta[i].text = chunks[i];
          chunkMeta[i].normalizedText = normalizeEvidenceText(chunks[i]);
        }
      } else if (sourceType === "mineru") {
        chunks = splitMarkdownIntoChunks(pdfText, CHUNK_TARGET_LENGTH);
        chunkMeta = buildChunkMetadata(chunks, sourceType);
      } else {
        chunks = splitIntoChunks(pdfText, CHUNK_TARGET_LENGTH);
        chunkMeta = buildChunkMetadata(chunks, sourceType);
      }

      const { chunkStats, docFreq, avgChunkLength } = buildChunkIndex(chunks);
      pdfTextCache.set(item.id, {
        title,
        chunks,
        chunkMeta,
        chunkStats,
        docFreq,
        avgChunkLength,
        fullLength: pdfText.length,

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
    const title = sanitizePdfText(
      snapshot?.title || text.split("\n")[0] || "",
    ).slice(0, 120);
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

/**
 * Reset embedding failure markers on all cached PdfContexts.
 * Called when the user changes embedding provider config in preferences,
 * so subsequent queries re-attempt embeddings with the new settings.
 */
export function resetEmbeddingFailedFlags(): void {
  pdfTextCache.forEach((ctx) => {
    ctx.embeddingFailureKey = undefined;
  });
}

export function invalidateCachedContextText(itemId: number): void {
  if (!Number.isFinite(itemId) || itemId <= 0) return;
  const normalizedItemId = Math.floor(itemId);
  pdfTextCache.delete(normalizedItemId);
  pdfTextLoadingTasks.delete(normalizedItemId);
  // Clear retrieval candidate cache — cached candidates carry stale chunk
  // text and scores after a MinerU refresh.  Lazy import to avoid circular
  // dependency (multiContextPlanner imports from pdfContext).
  import("./multiContextPlanner")
    .then(({ clearRetrievalCandidateCache }) =>
      clearRetrievalCandidateCache(normalizedItemId),
    )
    .catch(() => {});
  // Clear embedding cache — chunks will change when MinerU content is refreshed,
  // so cached embeddings are stale. Do NOT delete MinerU files themselves:
  // this function is called right after writeMineruCacheFiles(), so deleting
  // the MinerU directory would destroy the freshly written content.
  import("./embeddingCache")
    .then(({ clearEmbeddingCache }) => clearEmbeddingCache(normalizedItemId))
    .catch((e) => {
      ztoolkit.log("Embedding cache invalidation failed:", e);
    });
}

// ── Markdown-aware chunking (MinerU only) ─────────────────────────────────────

function splitMarkdownIntoChunks(text: string, targetLength: number): string[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  // Phase 1: Split into sections by heading boundaries
  const lines = normalized.split("\n");
  const sections: string[] = [];
  let currentSection = "";

  for (const line of lines) {
    if (/^#{1,4}\s+/.test(line) && currentSection.trim()) {
      // New heading — flush previous section
      sections.push(currentSection.trim());
      currentSection = line + "\n";
    } else {
      currentSection += line + "\n";
    }
  }
  if (currentSection.trim()) {
    sections.push(currentSection.trim());
  }

  if (sections.length === 0) return [];

  // Phase 2: Accumulate small sections, split large ones
  const chunks: string[] = [];
  let accumulator = "";

  const flushAccumulator = () => {
    if (accumulator.trim()) {
      chunks.push(accumulator.trim());
    }
    accumulator = "";
  };

  for (const section of sections) {
    if (section.length > targetLength) {
      // Large section: flush accumulator, then split internally by paragraphs
      flushAccumulator();
      const paragraphs = section.split(/\n\s*\n/);
      let subChunk = "";
      for (const para of paragraphs) {
        const p = para.trim();
        if (!p) continue;
        if (p.length > targetLength) {
          // Oversized paragraph: flush and slice with sentence-aware overlap
          if (subChunk.trim()) {
            chunks.push(subChunk.trim());
            subChunk = "";
          }
          let start = 0;
          while (start < p.length) {
            const prevStart = start;
            const rawEnd = Math.min(start + targetLength, p.length);
            const end =
              rawEnd < p.length ? findSentenceBoundary(p, rawEnd, 200) : rawEnd;
            const slice = p.slice(start, end).trim();
            if (slice) chunks.push(slice);
            if (end >= p.length) break;
            const rawOverlapStart = Math.max(0, end - CHUNK_OVERLAP);
            start = findSentenceBoundary(p, rawOverlapStart, 100);
            // Guard: ensure forward progress to prevent infinite loop
            if (start <= prevStart) start = prevStart + targetLength;
          }
        } else if (subChunk.length + p.length + 2 <= targetLength) {
          subChunk = subChunk ? `${subChunk}\n\n${p}` : p;
        } else {
          if (subChunk.trim()) chunks.push(subChunk.trim());
          subChunk = p;
        }
      }
      if (subChunk.trim()) chunks.push(subChunk.trim());
    } else if (accumulator.length + section.length + 2 <= targetLength) {
      // Small enough to accumulate
      accumulator = accumulator ? `${accumulator}\n\n${section}` : section;
    } else {
      // Would exceed budget — flush and start new
      flushAccumulator();
      accumulator = section;
    }
  }
  flushAccumulator();

  return chunks;
}

// ── Sentence boundary detection ─────────────────────────────────────────────

/**
 * Find the nearest sentence boundary (`. `, `? `, `! `, or `\n`) to
 * {@link targetPos}, searching up to {@link maxDrift} characters in both
 * directions.  Returns {@link targetPos} unchanged when no boundary is found
 * within the allowed range.
 */
function findSentenceBoundary(
  text: string,
  targetPos: number,
  maxDrift: number,
): number {
  const searchStart = Math.max(0, targetPos - maxDrift);
  const searchEnd = Math.min(text.length, targetPos + maxDrift);
  const region = text.slice(searchStart, searchEnd);

  // Require uppercase or newline after punctuation+space to avoid splitting
  // at abbreviations like "Fig. 2", "e.g. the", "Dr. Smith", "et al. showed".
  const sentenceEnders = /[.!?]\s+(?=[A-Z\n])|[.!?](?=\n)|\n/g;
  let bestPos = targetPos;
  let bestDist = maxDrift + 1;

  let match: RegExpExecArray | null;
  while ((match = sentenceEnders.exec(region)) !== null) {
    const absPos = searchStart + match.index + match[0].length;
    const dist = Math.abs(absPos - targetPos);
    if (dist < bestDist) {
      bestDist = dist;
      bestPos = absPos;
    }
  }

  return bestDist <= maxDrift ? bestPos : targetPos;
}

// ── Plain-text chunking (PDFWorker, notes) ────────────────────────────────────

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
        const prevStart = start;
        const rawEnd = Math.min(start + targetLength, p.length);
        const end =
          rawEnd < p.length ? findSentenceBoundary(p, rawEnd, 200) : rawEnd;
        const slice = p.slice(start, end).trim();
        if (slice) chunks.push(slice);
        if (end >= p.length) break;
        const rawOverlapStart = Math.max(0, end - CHUNK_OVERLAP);
        start = findSentenceBoundary(p, rawOverlapStart, 100);
        // Guard: ensure forward progress to prevent infinite loop
        if (start <= prevStart) start = prevStart + targetLength;
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

// ── Manifest-aware chunking ──────────────────────────────────────────────────

/**
 * Split full.md at section boundaries from the manifest, then sub-chunk
 * large sections using the existing markdown chunking logic.
 */
function splitWithManifestSections(
  text: string,
  sections: ManifestSection[],
  targetLength: number,
): string[] {
  const chunks: string[] = [];

  for (const section of sections) {
    const sectionText = text.slice(section.charStart, section.charEnd).trim();
    if (!sectionText) continue;

    if (sectionText.length <= targetLength) {
      chunks.push(sectionText);
    } else {
      // Sub-chunk large sections using markdown-aware splitting
      const subChunks = splitMarkdownIntoChunks(sectionText, targetLength);
      chunks.push(...subChunks);
    }
  }

  // Handle any text before the first section (preamble)
  if (sections.length > 0 && sections[0].charStart > 0) {
    const preamble = text.slice(0, sections[0].charStart).trim();
    if (preamble) {
      if (preamble.length <= targetLength) {
        chunks.unshift(preamble);
      } else {
        const preambleChunks = splitMarkdownIntoChunks(preamble, targetLength);
        chunks.unshift(...preambleChunks);
      }
    }
  }

  return chunks;
}

/**
 * Build chunk metadata using manifest section boundaries for accurate labels.
 */
function buildChunkMetadataFromManifest(
  chunks: string[],
  fullText: string,
  sections: ManifestSection[],
): PdfChunkMeta[] {
  // Build a lookup: for any char position in fullText, which section is it?
  function findSectionForText(chunkText: string): ManifestSection | undefined {
    const pos = fullText.indexOf(chunkText.slice(0, 100));
    if (pos < 0) return undefined;
    for (const section of sections) {
      if (pos >= section.charStart && pos < section.charEnd) return section;
    }
    return undefined;
  }

  // Map standard section headings to chunk kinds
  function sectionHeadingToKind(heading: string): PdfChunkKind {
    const lower = heading.toLowerCase().trim();
    if (/^abstract/.test(lower)) return "abstract";
    if (/^introduction/.test(lower)) return "introduction";
    if (
      /^method/.test(lower) ||
      /^materials?\s+and\s+method/.test(lower) ||
      /^experimental/.test(lower)
    )
      return "methods";
    if (/^results?/.test(lower)) return "results";
    if (/^discussion/.test(lower)) return "discussion";
    if (/^conclusion/.test(lower)) return "conclusion";
    if (/^reference/.test(lower) || /^bibliography/.test(lower))
      return "references";
    if (/^appendix/.test(lower) || /^supplement/.test(lower)) return "appendix";
    if (/^fig(?:ure)?\.?\s*\d/i.test(lower)) return "figure-caption";
    if (/^table\s*\d/i.test(lower)) return "table-caption";
    return "body";
  }

  const meta: PdfChunkMeta[] = [];
  for (const [chunkIndex, chunkText] of chunks.entries()) {
    const section = findSectionForText(chunkText);
    const sectionLabel = section?.heading;
    const chunkKind = section
      ? sectionHeadingToKind(section.heading)
      : resolveChunkKind({
          chunkText,
          normalizedText: normalizeEvidenceText(chunkText),
          sectionHeading: matchSectionHeading(chunkText),
        });

    const normalizedText = normalizeEvidenceText(chunkText);
    const textWithoutHeading = sectionLabel
      ? trimLeadingSectionHeading(chunkText, sectionLabel)
      : sanitizePdfText(chunkText);
    const cleaned = cleanLeadingEvidenceNoise(textWithoutHeading, chunkKind);

    meta.push({
      chunkIndex,
      text: chunkText,
      normalizedText,
      sectionLabel,
      chunkKind,
      anchorText: buildEvidenceAnchorFromText(cleaned.text) || undefined,
      leadingNoiseRemoved: cleaned.removedLeadingNoise || undefined,
    });
  }
  return meta;
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

// ── Markdown heading detection (MinerU only) ─────────────────────────────────

const MARKDOWN_HEADING_MAP: Record<
  string,
  { label: string; kind: PdfChunkKind }
> = {
  abstract: { label: "Abstract", kind: "abstract" },
  introduction: { label: "Introduction", kind: "introduction" },
  "related work": { label: "Related Work", kind: "introduction" },
  "literature review": { label: "Related Work", kind: "introduction" },
  background: { label: "Introduction", kind: "introduction" },
  method: { label: "Methods", kind: "methods" },
  methods: { label: "Methods", kind: "methods" },
  methodology: { label: "Methods", kind: "methods" },
  "materials and methods": { label: "Methods", kind: "methods" },
  "experimental setup": { label: "Methods", kind: "methods" },
  "experimental methods": { label: "Methods", kind: "methods" },
  result: { label: "Results", kind: "results" },
  results: { label: "Results", kind: "results" },
  "results and discussion": { label: "Results", kind: "results" },
  experiments: { label: "Results", kind: "results" },
  discussion: { label: "Discussion", kind: "discussion" },
  conclusion: { label: "Conclusion", kind: "conclusion" },
  conclusions: { label: "Conclusion", kind: "conclusion" },
  "concluding remarks": { label: "Conclusion", kind: "conclusion" },
  summary: { label: "Conclusion", kind: "conclusion" },
  appendix: { label: "Appendix", kind: "appendix" },
  "supplementary materials": { label: "Appendix", kind: "appendix" },
  "supplementary material": { label: "Appendix", kind: "appendix" },
  references: { label: "References", kind: "references" },
  bibliography: { label: "References", kind: "references" },
  "works cited": { label: "References", kind: "references" },
};

function matchMarkdownSectionHeading(
  chunkText: string,
): SectionHeadingMatch | undefined {
  const lines = sanitizePdfText(chunkText)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  for (const line of lines) {
    // Match: # Title, ## Title, ### Title (with optional numbering after #)
    const md = line.match(/^#{1,4}\s+(?:\d+(?:\.\d+)*\s*)?(.+?)\s*$/);
    if (md) {
      const heading = md[1]
        .replace(/[:.;\-–—]+$/, "")
        .trim()
        .toLowerCase();
      const match = MARKDOWN_HEADING_MAP[heading];
      if (match) return match;
    }
    // Stop scanning if we hit a long line or sentence
    if (line.length > 100 || /[.!?]/.test(line)) break;
  }
  return undefined;
}

// ── Plain-text heading detection (original PDFWorker path) ────────────────────

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

function cleanLeadingEvidenceNoise(
  text: string,
  chunkKind: PdfChunkKind,
): {
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
  cleaned = cleaned.replace(/^(?:[a-z][a-z-]{1,24}\.)\s+(?=[A-Z])/u, "");
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
  if (
    looksLikeReferenceEntry(normalizedText) ||
    looksLikeCitationList(normalizedText)
  ) {
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

export function buildChunkMetadata(
  chunks: string[],
  sourceType?: "mineru" | "zotero-worker",
): PdfChunkMeta[] {
  const chunkMeta: PdfChunkMeta[] = [];
  let activeSection: SectionHeadingMatch | undefined;
  for (const [chunkIndex, chunkText] of chunks.entries()) {
    const explicitSection =
      sourceType === "mineru"
        ? matchMarkdownSectionHeading(chunkText) ||
          matchSectionHeading(chunkText)
        : matchSectionHeading(chunkText);
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
    candidate.sectionLabel || matchSectionHeading(candidate.chunkText)?.label;
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
  const lower = text.toLowerCase();

  // Unicode-aware word tokens (Latin, Cyrillic, accented, etc.)
  const wordTokens = (lower.match(/[\p{L}\p{N}]+/gu) || []).filter(
    (t) => t.length >= 2 && !STOPWORDS.has(t),
  );

  // CJK character bigrams (Chinese, Japanese Kanji, Korean Hanja)
  const cjkChars =
    lower.match(/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g) || [];
  const cjkBigrams: string[] = [];
  for (let i = 0; i < cjkChars.length - 1; i++) {
    cjkBigrams.push(cjkChars[i] + cjkChars[i + 1]);
  }

  // Japanese Hiragana/Katakana bigrams
  const kanaChars = lower.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || [];
  const kanaBigrams: string[] = [];
  for (let i = 0; i < kanaChars.length - 1; i++) {
    kanaBigrams.push(kanaChars[i] + kanaChars[i + 1]);
  }

  return [...wordTokens, ...cjkBigrams, ...kanaBigrams];
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

async function embedTexts(texts: string[]): Promise<number[][]> {
  const all: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const batchEmbeddings = await callEmbeddings(batch);
    all.push(...batchEmbeddings);
  }
  return all;
}

async function ensureEmbeddings(
  pdfContext: PdfContext,
  itemId?: number,
): Promise<boolean> {
  let embeddingConfig: ReturnType<typeof getResolvedEmbeddingConfig>;
  try {
    embeddingConfig = getResolvedEmbeddingConfig();
  } catch {
    return false;
  }
  const embeddingModel = embeddingConfig.model;
  const providerKey = embeddingConfig.providerKey;
  const embeddingCacheKey = embeddingConfig.cacheKey;
  const embeddingAttemptKey = embeddingConfig.attemptKey;

  // Previously failed — don't retry until the effective embedding config changes.
  if (pdfContext.embeddingFailureKey === embeddingAttemptKey) return false;

  // Layer 1: In-memory — already loaded for this provider/model combination
  if (
    pdfContext.embeddings &&
    pdfContext.embeddings.length &&
    pdfContext.embeddingCacheKey === embeddingCacheKey
  ) {
    return pdfContext.embeddings.length === pdfContext.chunks.length;
  }

  // Dedup concurrent calls: join existing in-flight promise
  if (
    pdfContext.embeddingPromise &&
    pdfContext.embeddingPromiseKey === embeddingAttemptKey
  ) {
    const result = await pdfContext.embeddingPromise;
    if (result) {
      pdfContext.embeddings = result;
      pdfContext.embeddingCacheKey = embeddingCacheKey;
      pdfContext.embeddingFailureKey = undefined;
      return result.length === pdfContext.chunks.length;
    }
    return false;
  }

  // Layers 2+3: assign the promise slot FIRST (atomically) so concurrent
  // callers join this promise instead of starting a duplicate API call.
  const chunkHash = computeChunkHash(pdfContext.chunks);
  const chunkCount = pdfContext.chunks.length;
  const promise = (async () => {
    // Layer 2: Disk cache — check before calling the API
    if (itemId != null) {
      try {
        const cached = await loadCachedEmbeddings(
          itemId,
          chunkHash,
          embeddingModel,
          providerKey,
        );
        if (cached && cached.length === chunkCount) return cached;
      } catch {
        /* disk cache miss or read error — continue to API */
      }
    }

    // Layer 3: API call
    try {
      return await embedTexts(pdfContext.chunks);
    } catch (err) {
      if (err instanceof EmbeddingUnsupportedError) {
        ztoolkit.log(
          `[Semantic Search] Provider "${(err as EmbeddingUnsupportedError).providerLabel}" does not support embeddings. ` +
            "Configure a separate embedding provider in Settings → Customization. Falling back to keyword search.",
        );
      } else {
        ztoolkit.log("[Semantic Search] Embedding generation failed:", err);
      }
      return null;
    }
  })();
  pdfContext.embeddingPromise = promise;
  pdfContext.embeddingPromiseKey = embeddingAttemptKey;

  const result = await promise;
  const ownsPromiseSlot = pdfContext.embeddingPromise === promise;
  if (ownsPromiseSlot) {
    pdfContext.embeddingPromise = undefined;
    pdfContext.embeddingPromiseKey = undefined;
  }
  if (result) {
    pdfContext.embeddings = result;
    pdfContext.embeddingCacheKey = embeddingCacheKey;
    pdfContext.embeddingFailureKey = undefined;
    // Persist to disk cache in background (fire-and-forget)
    if (itemId != null && result.length > 0) {
      const dims = result[0].length;
      saveCachedEmbeddings(
        itemId,
        chunkHash,
        embeddingModel,
        providerKey,
        dims,
        result,
      ).catch((err) =>
        ztoolkit.log("[Semantic Search] Embedding cache write failed:", err),
      );
    }
    return result.length === chunkCount;
  }
  // Only mark failure if we still own the slot — a newer call with a
  // different config should not be blocked by this failure.
  if (ownsPromiseSlot) {
    pdfContext.embeddingFailureKey = embeddingAttemptKey;
  }
  return false;
}

/**
 * Pre-generate embeddings for a paper in the background.
 * Called from the multi-context planner so embeddings are cached even when
 * the system uses full-text mode (which skips the retrieval pipeline).
 * Fire-and-forget — callers should NOT await this.
 */
export function preGenerateEmbeddings(
  pdfContext: PdfContext | undefined,
  itemId: number,
): void {
  if (!pdfContext || !pdfContext.chunks.length) return;
  if (!shouldTryEmbeddings()) return;
  let embeddingConfig: ReturnType<typeof getResolvedEmbeddingConfig>;
  try {
    embeddingConfig = getResolvedEmbeddingConfig();
  } catch {
    return;
  }
  // Already loaded or in-flight for this exact embedding config — nothing to do
  if (
    pdfContext.embeddings?.length &&
    pdfContext.embeddingCacheKey === embeddingConfig.cacheKey
  ) {
    return;
  }
  if (
    pdfContext.embeddingPromise &&
    pdfContext.embeddingPromiseKey === embeddingConfig.attemptKey
  ) {
    return;
  }

  ensureEmbeddings(pdfContext, itemId).catch((err) => {
    if (typeof ztoolkit !== "undefined") {
      ztoolkit.log(
        "[Semantic Search] Background embedding pre-generation failed:",
        err,
      );
    }
  });
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

function shouldTryEmbeddings(): boolean {
  // Respect the user's "Enable semantic search" toggle (off by default)
  const enabledPref = getPref("enableSemanticSearch");
  if (enabledPref !== true && enabledPref !== "true") return false;

  // Delegate to the centralized availability check in llmClient.
  const available = checkEmbeddingAvailability();
  if (!available && typeof ztoolkit !== "undefined") {
    const reason = getEmbeddingUnavailableReason();
    if (reason) {
      ztoolkit.log(`[Semantic Search] Embeddings unavailable: ${reason}`);
    }
  }
  return available;
}

// ── Intent-driven evidence heuristics ────────────────────────────────────────

type QueryIntent =
  | "factual"
  | "conceptual"
  | "methodological"
  | "comparative"
  | "citation"
  | "visual"
  | "general";

function detectQueryIntent(question: string): QueryIntent {
  if (
    /\b(?:method|protocol|procedure|algorithm|implementation|pipeline|training|hyperparameter|setup|dataset)\b/i.test(
      question,
    )
  )
    return "methodological";
  if (
    /\b(?:figure|fig\.?|table|chart|plot|diagram|caption|image)\b/i.test(
      question,
    )
  )
    return "visual";
  if (
    /\b(?:compar|differ|versus|vs\.?|contrast|similar|distinguish)\b/i.test(
      question,
    )
  )
    return "comparative";
  if (/\b(?:cit(?:e|ation|ed)|refer(?:ence|red)|bibliograph)\b/i.test(question))
    return "citation";
  if (
    /\b(?:how many|sample size|number of|percentage|ratio|count|statistic)\b/i.test(
      question,
    )
  )
    return "factual";
  if (
    /\b(?:mechanism|pathway|relationship|role of|function of|why does|how does)\b/i.test(
      question,
    )
  )
    return "conceptual";
  return "general";
}

/** Section boost profiles keyed by query intent. */
const SECTION_BOOST_PROFILES: Record<
  QueryIntent,
  Partial<Record<PdfChunkKind, number>>
> = {
  general: {
    abstract: 0.9,
    results: 1.2,
    discussion: 0.95,
    conclusion: 0.8,
    introduction: 0.2,
    methods: -0.2,
    "figure-caption": -1.1,
    "table-caption": -1.1,
    appendix: -1.6,
    references: -2.4,
    body: 0.1,
  },
  factual: {
    results: 1.5,
    methods: 0.8,
    abstract: 0.5,
    discussion: 0.4,
    "figure-caption": -0.8,
    "table-caption": -0.8,
    appendix: -1.4,
    references: -2.4,
  },
  conceptual: {
    discussion: 1.4,
    abstract: 1.0,
    results: 0.8,
    introduction: 0.6,
    "figure-caption": -0.8,
    "table-caption": -0.8,
    appendix: -1.4,
    references: -2.4,
  },
  methodological: {
    methods: 1.5,
    abstract: 0.4,
    results: 0.3,
    appendix: 0.2,
    "figure-caption": -0.5,
    "table-caption": -0.5,
    references: -2.0,
  },
  comparative: {
    results: 1.4,
    discussion: 1.2,
    abstract: 0.6,
    methods: 0.2,
    "figure-caption": -0.5,
    "table-caption": -0.5,
    appendix: -1.2,
    references: -2.0,
  },
  citation: {
    references: 1.0,
    introduction: 0.8,
    discussion: 0.6,
    abstract: 0.3,
    "figure-caption": -0.8,
    "table-caption": -0.8,
    appendix: -0.5,
  },
  visual: {
    "figure-caption": 0.8,
    "table-caption": 0.8,
    results: 0.6,
    methods: 0.2,
    appendix: -1.0,
    references: -2.0,
  },
};

function scoreEvidenceHeuristics(params: {
  candidate: PaperContextCandidate;
  question: string;
}): number {
  const { candidate, question } = params;
  const chunkText = normalizeEvidenceText(candidate.chunkText);
  const wordCount = chunkText ? chunkText.split(/\s+/).length : 0;

  const intent = detectQueryIntent(question);
  const profile = SECTION_BOOST_PROFILES[intent];
  let score = profile[candidate.chunkKind as PdfChunkKind] ?? -0.1;

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
  options?: {
    topK?: number;
    mode?: "general" | "evidence";
    /** Pre-computed query embedding to avoid redundant API calls in multi-paper loops. */
    precomputedQueryEmbedding?: number[];
  },
): Promise<PaperContextCandidate[]> {
  if (!pdfContext) return [];
  const { chunks, chunkStats, docFreq, avgChunkLength } = pdfContext;
  if (!chunks.length || !chunkStats.length) return [];
  const chunkMeta =
    Array.isArray(pdfContext.chunkMeta) &&
    pdfContext.chunkMeta.length === chunks.length
      ? pdfContext.chunkMeta
      : buildChunkMetadata(chunks, pdfContext.sourceType);

  const topK = Number.isFinite(options?.topK)
    ? Math.max(1, Math.floor(options?.topK as number))
    : RETRIEVAL_TOP_K_PER_PAPER;

  const terms = tokenizeQuery(question);
  const bm25Scores = chunkStats.map((chunk) =>
    scoreChunkBM25(chunk, terms, docFreq, chunks.length, avgChunkLength || 1),
  );

  // Compute BM25 ranks (1-based, descending by score)
  const bm25Ranked = chunkStats
    .map((_, i) => i)
    .sort((a, b) => bm25Scores[b] - bm25Scores[a]);
  const bm25Rank = new Array<number>(chunkStats.length);
  bm25Ranked.forEach((idx, rank) => {
    bm25Rank[idx] = rank + 1;
  });

  // Compute embedding ranks if available
  let embedRank: number[] | null = null;
  let rawEmbeddingScores: number[] | null = null;
  if (question.trim() && shouldTryEmbeddings()) {
    const embeddingsReady = await ensureEmbeddings(
      pdfContext,
      paperContext.contextItemId,
    );
    if (embeddingsReady && pdfContext.embeddings) {
      try {
        const queryEmbedding =
          options?.precomputedQueryEmbedding ||
          (await callEmbeddings([question]))[0] ||
          [];
        if (queryEmbedding.length) {
          rawEmbeddingScores = pdfContext.embeddings.map((vec) =>
            cosineSimilarity(queryEmbedding, vec),
          );
          const embedRanked = chunkStats
            .map((_, i) => i)
            .sort((a, b) => rawEmbeddingScores![b] - rawEmbeddingScores![a]);
          embedRank = new Array<number>(chunkStats.length);
          embedRanked.forEach((idx, rank) => {
            embedRank![idx] = rank + 1;
          });
        }
      } catch (err) {
        ztoolkit.log("Query embedding failed:", err);
      }
    }
  }

  // Reciprocal Rank Fusion (RRF) — rank-based fusion that avoids
  // normalization sensitivity and fixed weight tuning.
  const retrievalMode = options?.mode || "general";

  const scored = chunkStats.map((chunk, idx) => {
    const bm25Score = bm25Scores[idx] || 0;
    const embeddingScore = rawEmbeddingScores
      ? rawEmbeddingScores[idx] || 0
      : 0;
    const hybridScore = embedRank
      ? 1 / (RRF_K + bm25Rank[idx]) + 1 / (RRF_K + embedRank[idx])
      : 1 / (RRF_K + bm25Rank[idx]);
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
  if (!papers.length) return "";

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
    paperCandidates.sort((a, b) => a.chunkIndex - b.chunkIndex);
    const lines: string[] = [`Paper ${paperIndex + 1}`];
    lines.push(...formatPaperMetadataLines(paper));
    if (paperCandidates.length) {
      lines.push("", "Evidence:");
      for (const [candidateIndex, candidate] of paperCandidates.entries()) {
        lines.push(`Evidence snippet ${candidateIndex + 1}`);
        lines.push(
          `Section: ${candidate.sectionLabel || "Unlabeled body text"}`,
        );
        lines.push(`Source label: ${formatPaperSourceLabel(paper)}`);
        lines.push("Quoted evidence:");
        lines.push(formatMarkdownBlockquote(buildEvidenceQuoteText(candidate)));
        lines.push("");
      }
    } else {
      lines.push("", "(No retrieved snippets for this paper in this turn.)");
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

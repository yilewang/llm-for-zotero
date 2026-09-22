import { appLogger } from "../../core/logging";
import {
  callEmbeddings,
  embedItems,
  EmbeddingUnsupportedError,
  getResolvedEmbeddingConfig,
  getEmbeddingUnavailableReason,
  resolveSemanticSearchState,
} from "../../utils/llmClient";
import { estimateTextTokens } from "../../utils/modelInputCap";
import {
  clearEmbeddingCache,
  computeChunkHash,
  loadCachedEmbeddings,
  saveCachedEmbeddings,
} from "../retrieval/embeddingCache";
import {
  CHUNK_OVERLAP,
  CHUNK_TARGET_LENGTH,
  RETRIEVAL_TOP_K_PER_PAPER,
  RRF_K,
} from "../retrieval/constants";
import { cosineSimilarity } from "../retrieval/similarity";
import { computeSectionPageSpans } from "../retrieval/imageSelection";
import { imageIndex } from "./imageIndex";
import {
  tokenizeRetrievalQuery,
  tokenizeRetrievalText,
} from "../retrieval/retrievalTokenizer";
import type { RetrievalQueryPlan } from "../retrieval/retrievalQueryPlan";
import {
  buildGenericSourceQuoteCitationGuidance,
  buildPaperQuoteCitationGuidance,
  formatAttachmentSourceType,
  formatPaperAttachmentTitle,
  formatPaperCitationLabel,
  formatPaperSourceLabel,
  isTextLikeAttachmentSourceMode,
} from "./paperAttribution";
import {
  buildQuoteAnchorPromptBlock,
  buildQuoteCitation,
  isQuoteWorthySourceText,
  mergeQuoteCitations,
} from "../quotes/quoteCitations";
import { readNoteSnapshot } from "../notes/noteSnapshot";
import { readAttachmentBytes } from "../attachmentStorage";
import { pdfTextCache, pdfTextLoadingTasks } from "./contextCache";
import {
  buildAndWriteManifest,
  buildManifest,
  ensureManifest,
  readCachedMineruMd,
  stripMineruSourceImageEmbedsFromMarkdown,
} from "../mineru/mineruCache";
import type { MineruManifest, ManifestSection } from "../mineru/mineruCache";
import { ensureMineruRuntimeCacheForAttachment } from "../mineru/sync";
import { isMineruEnabled } from "../../utils/mineruConfig";
import type {
  PdfContext,
  ChunkStat,
  DocumentOutline,
  DocumentOutlineSection,
  PaperContextCandidate,
  PdfChunkMeta,
  PdfChunkKind,
  RetrievalExplanation,
} from "./types";
import type {
  PaperContentSourceMode,
  PaperContextRef,
  QuoteCitation,
} from "../../shared/types";
import {
  extractTextAttachmentContent,
  resolveTextAttachmentSourceModeFromMetadata,
} from "./textAttachmentExtraction";
import type { TextAttachmentSourceMode } from "./contextAttachmentTypes";
import { isPdfContextAttachment } from "./contextAttachmentSupport";
import { invalidateRetrievalCandidates } from "../retrieval/cacheInvalidation";
import { isBodyEvidenceSection } from "../../shared/libraryChatEvidencePolicy";
import {
  extractDocumentReferenceEvidence,
  parseDocumentReferences,
  resolveDocumentReferenceMatches,
} from "../../shared/documentReferences";
import { createZoteroMetadataResolver } from "../../services/zoteroMetadata/resolver";
import { projectPaperMetadata } from "../../services/zoteroMetadata/projections";
import type {
  ProjectedPaperMetadata,
  ZoteroMetadataResolver,
} from "../../services/zoteroMetadata/types";

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

function formatErrorForLog(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message || String(error);
  }
  if (typeof error === "string") return error;
  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}") return json;
  } catch {
    /* ignore */
  }
  return String(error || "Unknown error");
}

function decodeFileContents(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return new TextDecoder("utf-8").decode(data);
  if (data instanceof ArrayBuffer) {
    return new TextDecoder("utf-8").decode(new Uint8Array(data));
  }
  return "";
}

async function readLocalTextFile(source: string | nsIFile): Promise<string> {
  const zoteroFile = (
    Zotero as unknown as {
      File?: {
        getContentsAsync?: (
          source: string | nsIFile,
          charset?: string,
        ) => Promise<unknown> | unknown;
      };
    }
  ).File;
  if (zoteroFile?.getContentsAsync) {
    try {
      const data = await zoteroFile.getContentsAsync(source, "utf-8");
      const text = decodeFileContents(data);
      if (text) return text;
    } catch (error) {
      appLogger.debug(
        "LLM: Zotero.File text read failed; trying lower-level readers:",
        formatErrorForLog(error),
      );
    }
  }

  const path = typeof source === "string" ? source : source.path;
  const IOUtils = (
    globalThis as unknown as {
      IOUtils?: {
        read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
      };
    }
  ).IOUtils;
  if (IOUtils?.read) {
    return decodeFileContents(await IOUtils.read(path));
  }

  const OS = (
    globalThis as unknown as {
      OS?: {
        File?: {
          read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
        };
      };
    }
  ).OS;
  if (OS?.File?.read) {
    return decodeFileContents(await OS.File.read(path));
  }

  return "";
}

async function readZoteroFulltextCache(item: Zotero.Item): Promise<string> {
  try {
    const fulltext =
      (
        Zotero as unknown as {
          Fulltext?: { getItemCacheFile?: (item: Zotero.Item) => nsIFile };
          FullText?: { getItemCacheFile?: (item: Zotero.Item) => nsIFile };
        }
      ).Fulltext ||
      (
        Zotero as unknown as {
          FullText?: { getItemCacheFile?: (item: Zotero.Item) => nsIFile };
        }
      ).FullText;
    const cacheFile = fulltext?.getItemCacheFile?.(item);
    if (!cacheFile) return "";
    if (typeof cacheFile.exists === "function" && !cacheFile.exists()) {
      return "";
    }
    return sanitizePdfText(await readLocalTextFile(cacheFile));
  } catch (error) {
    appLogger.debug(
      "LLM: Zotero full-text cache read failed:",
      formatErrorForLog(error),
    );
    return "";
  }
}

function getAttachmentFilename(item: Zotero.Item): string {
  return sanitizePdfText(
    String(
      (item as unknown as { attachmentFilename?: unknown })
        .attachmentFilename || "",
    ),
  );
}

function getAttachmentContentType(item: Zotero.Item): string {
  return sanitizePdfText(
    String(
      (item as unknown as { attachmentContentType?: unknown })
        .attachmentContentType || "",
    ),
  ).toLowerCase();
}

function getAttachmentTitle(item: Zotero.Item): string {
  return sanitizePdfText(
    String(item.getField("title") || getAttachmentFilename(item) || ""),
  );
}

export function resolveTextAttachmentSourceMode(
  item: Zotero.Item | null | undefined,
): TextAttachmentSourceMode | null {
  if (!item?.isAttachment?.()) return null;
  return resolveTextAttachmentSourceModeFromMetadata({
    contentType: getAttachmentContentType(item),
    filename: getAttachmentFilename(item),
  });
}

function sourceTypeForTextAttachment(
  mode: TextAttachmentSourceMode,
): PdfContext["sourceType"] {
  return `attachment-${mode}` as PdfContext["sourceType"];
}

function cachedContextMatchesSourceMode(
  cached: PdfContext,
  sourceMode?: PaperContentSourceMode,
): boolean {
  if (!sourceMode) return true;
  if (sourceMode === "pdf") return true;
  if (sourceMode === "mineru") return cached.sourceType === "mineru";
  if (sourceMode === "text") return cached.sourceType !== "mineru";
  if (
    sourceMode === "markdown" ||
    sourceMode === "html" ||
    sourceMode === "txt" ||
    sourceMode === "docx"
  ) {
    return cached.sourceType === sourceTypeForTextAttachment(sourceMode);
  }
  return true;
}

async function cacheTextAttachment(
  item: Zotero.Item,
  sourceMode: TextAttachmentSourceMode,
): Promise<void> {
  const title = getAttachmentTitle(item) || `Attachment ${item.id}`;
  try {
    const filePath: string | undefined =
      (
        item as unknown as { getFilePath?: () => string | undefined }
      ).getFilePath?.() || undefined;
    if (!filePath) {
      pdfTextCache.set(item.id, {
        title,
        chunks: [],
        chunkMeta: [],
        chunkStats: [],
        docFreq: {},
        avgChunkLength: 0,
        fullLength: 0,
        sourceType: sourceTypeForTextAttachment(sourceMode),
      });
      return;
    }
    const bytes = await readAttachmentBytes(filePath);
    const text = sanitizePdfText(
      extractTextAttachmentContent(bytes, sourceMode),
    );
    if (text) {
      const chunks = splitIntoChunks(text, CHUNK_TARGET_LENGTH);
      const chunkMeta = buildChunkMetadata(
        chunks,
        sourceTypeForTextAttachment(sourceMode),
      );
      const { chunkStats, docFreq, avgChunkLength } = buildChunkIndex(chunks);
      pdfTextCache.set(item.id, {
        title,
        chunks,
        chunkMeta,
        chunkStats,
        docFreq,
        avgChunkLength,
        fullLength: text.length,
        sourceType: sourceTypeForTextAttachment(sourceMode),
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
        sourceType: sourceTypeForTextAttachment(sourceMode),
      });
    }
  } catch (error) {
    appLogger.warn("Error caching text attachment:", error);
    pdfTextCache.set(item.id, {
      title,
      chunks: [],
      chunkMeta: [],
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 0,
      fullLength: 0,
      sourceType: sourceTypeForTextAttachment(sourceMode),
    });
  }
}

async function cachePDFText(
  item: Zotero.Item,
  options?: { sourceMode?: PaperContentSourceMode },
) {
  if (pdfTextCache.has(item.id)) return;

  try {
    const requestedTextAttachmentMode =
      options?.sourceMode === "markdown" ||
      options?.sourceMode === "html" ||
      options?.sourceMode === "txt" ||
      options?.sourceMode === "docx"
        ? options.sourceMode
        : null;
    const inferredTextAttachmentMode = resolveTextAttachmentSourceMode(item);
    const textAttachmentMode =
      requestedTextAttachmentMode || inferredTextAttachmentMode;
    if (textAttachmentMode) {
      await cacheTextAttachment(item, textAttachmentMode);
      return;
    }

    let pdfText = "";
    let sourceType: PdfContext["sourceType"];
    let pdfWorkerPageChars: number[] | undefined;
    const mainItem =
      item.isAttachment() && item.parentID
        ? Zotero.Items.get(item.parentID)
        : null;

    const title = mainItem?.getField("title") || item.getField("title") || "";

    const pdfItem = isPdfContextAttachment(item) ? item : null;

    // 1. Try MinerU disk cache (only if MinerU is enabled)
    const allowMineru = options?.sourceMode !== "text";
    if (allowMineru && isMineruEnabled() && pdfItem) {
      try {
        await ensureMineruRuntimeCacheForAttachment(pdfItem);
      } catch (error) {
        appLogger.warn("LLM: MinerU sync restore failed", error);
      }
    }
    const cachedMd =
      allowMineru && isMineruEnabled()
        ? await readCachedMineruMd(item.id)
        : null;
    if (cachedMd) {
      pdfText = convertHtmlTablesToMarkdown(
        stripMineruSourceImageEmbedsFromMarkdown(cachedMd),
      );
      sourceType = "mineru";
    }

    // 2. Fallback to Zotero.PDFWorker
    if (!pdfText && pdfItem) {
      try {
        const result = await Zotero.PDFWorker.getFullText(pdfItem.id);
        if (result && result.text) {
          pdfText = result.text;
          sourceType = "zotero-worker";
          const rawPageChars = Array.isArray(result.pageChars)
            ? result.pageChars.map((value: unknown) => Number(value))
            : undefined;
          pdfWorkerPageChars = rawPageChars?.every(
            (value: number) => Number.isFinite(value) && value >= 0,
          )
            ? rawPageChars
            : undefined;
        }
      } catch (e) {
        appLogger.warn("PDF extraction failed:", e);
      }
    }

    // 3. Fallback to Zotero's full-text cache/index. PDFWorker can return no
    // text even when Zotero already has indexed text for the attachment.
    if (!pdfText && pdfItem) {
      const cachedText = await readZoteroFulltextCache(pdfItem);
      if (cachedText) {
        pdfText = cachedText;
        sourceType = "zotero-fulltext-cache";
      }
    }

    if (pdfText) {
      // Try manifest-aware chunking for MinerU papers
      let manifest: MineruManifest | null = null;
      if (sourceType === "mineru") {
        try {
          manifest = await ensureManifest(item.id);
          if (
            manifest &&
            cachedMd &&
            typeof manifest.totalChars === "number" &&
            manifest.totalChars !== cachedMd.length
          ) {
            appLogger.debug(
              "LLM: MinerU manifest length mismatch; rebuilding",
              {
                attachmentId: item.id,
                manifestTotalChars: manifest.totalChars,
                mdLength: cachedMd.length,
              },
            );
            manifest = await buildAndWriteManifest(item.id);
          }
        } catch (e) {
          appLogger.debug(
            "LLM: MinerU manifest unavailable; using markdown chunks",
            formatErrorForLog(e),
          );
          // Non-critical — fall back to heuristic chunking
        }
      }

      let chunks: string[];
      let chunkMeta: PdfChunkMeta[];

      // Section-aware chunking: slice from the raw markdown (offsets match raw
      // full.md), build metadata from the raw chunks, then convert HTML tables
      // for LLM readability. Using pdfText (post-conversion) would misalign
      // because convertHtmlTablesToMarkdown changes character counts.
      const chunkBySections = (
        rawMd: string,
        sections: ManifestSection[],
      ): { chunks: string[]; chunkMeta: PdfChunkMeta[] } => {
        const rawChunks = splitWithManifestSections(
          rawMd,
          sections,
          CHUNK_TARGET_LENGTH,
        );
        const meta = buildChunkMetadataFromManifest(rawChunks, rawMd, sections);
        const converted = rawChunks.map((chunk) =>
          convertHtmlTablesToMarkdown(
            stripMineruSourceImageEmbedsFromMarkdown(chunk),
          ),
        );
        // Update chunkMeta text fields to reflect converted content
        for (let i = 0; i < converted.length; i++) {
          meta[i].text = converted[i];
          meta[i].normalizedText = normalizeEvidenceText(converted[i]);
        }
        return { chunks: converted, chunkMeta: meta };
      };

      // MinerU text the manifest could not section: the markdown headings are
      // still there, so rebuild sections from them and keep one labeller.
      // Only text with no structure at all falls back to flat chunking.
      const chunkMineruWithoutManifestSections = (): {
        chunks: string[];
        chunkMeta: PdfChunkMeta[];
      } => {
        if (cachedMd) {
          try {
            const synthetic = buildSyntheticManifestSections(cachedMd);
            if (synthetic.length > 2)
              return chunkBySections(cachedMd, synthetic);
          } catch (e) {
            appLogger.debug(
              "LLM: MinerU heading fallback failed; using flat markdown chunks",
              { attachmentId: item.id, error: formatErrorForLog(e) },
            );
          }
        }
        const flatChunks = splitMarkdownIntoChunks(
          pdfText,
          CHUNK_TARGET_LENGTH,
        );
        return {
          chunks: flatChunks,
          chunkMeta: buildChunkMetadata(flatChunks, sourceType),
        };
      };

      if (manifest && !manifest.noSections && manifest.sections.length > 0) {
        try {
          ({ chunks, chunkMeta } = chunkBySections(
            cachedMd!,
            manifest.sections,
          ));
        } catch (e) {
          appLogger.debug(
            "LLM: MinerU manifest chunking failed; using markdown headings",
            {
              attachmentId: item.id,
              manifestTotalChars: manifest.totalChars,
              mdLength: cachedMd?.length || 0,
              error: formatErrorForLog(e),
            },
          );
          ({ chunks, chunkMeta } = chunkMineruWithoutManifestSections());
        }
      } else if (sourceType === "mineru") {
        ({ chunks, chunkMeta } = chunkMineruWithoutManifestSections());
      } else {
        chunks = splitIntoChunks(pdfText, CHUNK_TARGET_LENGTH);
        chunkMeta = buildChunkMetadata(chunks, sourceType, {
          sourceText: pdfText,
          pageChars: pdfWorkerPageChars,
        });
      }

      const { chunkStats, docFreq, avgChunkLength } = buildChunkIndex(chunks);
      // MinerU chunks carry only their section's first page; image matching
      // needs the whole span the section covers.
      const chunkPageSpans =
        sourceType === "mineru" &&
        manifest &&
        !manifest.noSections &&
        manifest.sections.length > 0
          ? computeSectionPageSpans(
              chunkMeta,
              manifest.sections,
              manifest.totalPages,
            )
          : undefined;
      const context: PdfContext = {
        title,
        chunks,
        chunkMeta,
        chunkStats,
        docFreq,
        avgChunkLength,
        fullLength: pdfText.length,

        sourceType,
        ...(chunkPageSpans ? { chunkPageSpans } : {}),
      };
      pdfTextCache.set(item.id, context);
      // Images are extracted alongside the chunks while image embedding is
      // on; nothing waits for it here.
      if (pdfItem) imageIndex.startExtraction(context, pdfItem.id);
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
    appLogger.warn("Error caching PDF:", formatErrorForLog(e), e);
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

export async function ensurePDFTextCached(
  item: Zotero.Item,
  options?: { sourceMode?: PaperContentSourceMode },
): Promise<void> {
  const cached = pdfTextCache.get(item.id);
  if (cached && cachedContextMatchesSourceMode(cached, options?.sourceMode)) {
    return;
  }
  if (cached) {
    pdfTextCache.delete(item.id);
  }
  const existingTask = pdfTextLoadingTasks.get(item.id);
  if (existingTask) {
    await existingTask;
    const latest = pdfTextCache.get(item.id);
    if (latest && cachedContextMatchesSourceMode(latest, options?.sourceMode)) {
      return;
    }
    if (latest) {
      pdfTextCache.delete(item.id);
    }
  }
  if (pdfTextCache.has(item.id)) {
    return;
  }
  const task = (async () => {
    try {
      await cachePDFText(item, options);
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
    appLogger.warn("Error caching note:", e);
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
  invalidateRetrievalCandidates(normalizedItemId);
  // Clear embedding cache — chunks will change when MinerU content is refreshed,
  // so cached embeddings are stale. Do NOT delete MinerU files themselves:
  // this function is called right after writeMineruCacheFiles(), so deleting
  // the MinerU directory would destroy the freshly written content.
  void clearEmbeddingCache(normalizedItemId).catch((error) => {
    appLogger.warn("Embedding cache invalidation failed:", error);
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
 * Section list derived from the markdown headings alone, for MinerU text whose
 * manifest holds no usable sections. The manifest builder already owns the
 * heading scan, the ids, the parents and the heading paths, so this reuses it
 * with an empty content list: same sections, no figures or tables.
 */
export function buildSyntheticManifestSections(md: string): ManifestSection[] {
  return buildManifest(md, []).sections;
}

/**
 * Build chunk metadata using manifest section boundaries for accurate labels.
 */
function buildChunkMetadataFromManifest(
  chunks: string[],
  fullText: string,
  sections: ManifestSection[],
): PdfChunkMeta[] {
  const sourceFingerprint = buildPdfSourceFingerprint(fullText, "mineru");
  // Build a lookup: for any char position in fullText, which section is it?
  function findChunkPosition(chunkText: string): number {
    return fullText.indexOf(chunkText.slice(0, 100));
  }

  function findSectionIndexForPosition(pos: number): number {
    if (pos < 0) return -1;
    for (let index = 0; index < sections.length; index += 1) {
      const section = sections[index];
      if (pos >= section.charStart && pos < section.charEnd) return index;
    }
    return -1;
  }

  const meta: PdfChunkMeta[] = [];
  for (const [chunkIndex, chunkText] of chunks.entries()) {
    const sourceStart = findChunkPosition(chunkText);
    const sourceEnd =
      sourceStart >= 0
        ? Math.min(fullText.length, sourceStart + chunkText.length)
        : -1;
    const sectionIndex = findSectionIndexForPosition(sourceStart);
    const section = sectionIndex >= 0 ? sections[sectionIndex] : undefined;
    const sectionLabel = section?.heading;
    // The manifest heading decides the kind when it names a standard section;
    // otherwise ("2.2 Kinematic condition") the chunk text decides.
    const headingKind = section
      ? classifyHeadingKind(section.heading)
      : undefined;
    // Inside a section the heading is the authority. When it names no
    // standard section ("Bed roughness") the chunk is body text: only a
    // caption still reads its own kind off the text, because the text
    // heuristics cannot tell prose from a reference list reliably enough to
    // demote a whole section. Outside every section (the preamble) the text
    // is all there is.
    const chunkKind =
      headingKind?.kind ?? resolveSectionedChunkKind(chunkText, section);

    const normalizedText = normalizeEvidenceText(chunkText);
    const textWithoutHeading = sectionLabel
      ? trimLeadingSectionHeading(chunkText, sectionLabel)
      : sanitizePdfText(chunkText);
    const cleaned = cleanLeadingEvidenceNoise(textWithoutHeading, chunkKind);
    const references = extractDocumentReferenceEvidence(chunkText);
    const manifestRecords = [
      ...(section?.figures || []).map((record) => ({
        kind: "figure" as const,
        record,
      })),
      ...(section?.tables || []).map((record) => ({
        kind: "table" as const,
        record,
      })),
    ];
    for (const { kind, record } of manifestRecords) {
      const parsed = parseDocumentReferences(
        record.baseLabel || record.label,
      )[0];
      if (!parsed || parsed.kind !== kind) continue;
      const captionProbe = normalizeEvidenceText(record.caption)
        .slice(0, 80)
        .toLocaleLowerCase();
      const pathProbe = record.path.trim();
      if (
        (captionProbe &&
          normalizedText.toLocaleLowerCase().includes(captionProbe)) ||
        (pathProbe && chunkText.includes(pathProbe))
      ) {
        references.push({
          kind,
          id: parsed.id,
          ...(parsed.panel ? { panel: parsed.panel } : {}),
          confidence: "high",
          provenance: ["mineru-manifest", "source-range"],
          ...(record.page !== undefined
            ? { pageStart: record.page, pageEnd: record.page }
            : {}),
        });
      }
    }

    meta.push({
      chunkIndex,
      text: chunkText,
      normalizedText,
      sectionLabel,
      ...(section
        ? {
            sectionIndex,
            sectionPath: section.path,
            sectionLevel: section.level,
          }
        : {}),
      chunkKind,
      kindSource: headingKind ? "manifest" : "heuristic",
      anchorText: buildEvidenceAnchorFromText(cleaned.text) || undefined,
      leadingNoiseRemoved: cleaned.removedLeadingNoise || undefined,
      sourceType: "mineru",
      sourceFingerprint,
      ...(sourceStart >= 0
        ? { sourceStart, sourceEnd: Math.max(sourceStart, sourceEnd) }
        : {}),
      ...(section?.page !== undefined
        ? { pageStart: section.page, pageEnd: section.page }
        : {}),
      references: references.length ? references : undefined,
    });
  }
  return meta;
}

type SectionHeadingPattern = {
  label: string;
  kind: PdfChunkKind;
  /** Heading that stops at the keyword: "Results", "3. Results:". */
  pattern: RegExp;
  /** Heading that runs on past the keyword: "Results and discussion". */
  prefixPattern: RegExp;
};

type SectionHeadingMatch = {
  label: string;
  kind: PdfChunkKind;
};

/**
 * Build the two forms of one standard-section heading from its keywords, so
 * the strict and the run-on form can never drift apart.
 */
function sectionHeadingPattern(
  label: string,
  kind: PdfChunkKind,
  keywords: string,
): SectionHeadingPattern {
  const opening = `^(?:\\d+(?:\\.\\d+)*)?\\s*${keywords}\\b`;
  return {
    label,
    kind,
    pattern: new RegExp(`${opening}[:.\\s-]*$`, "i"),
    prefixPattern: new RegExp(opening, "i"),
  };
}

const SECTION_HEADING_PATTERNS: SectionHeadingPattern[] = [
  sectionHeadingPattern("Abstract", "abstract", "abstract"),
  sectionHeadingPattern("Introduction", "introduction", "introduction"),
  sectionHeadingPattern("Related Work", "introduction", "related work"),
  sectionHeadingPattern(
    "Methods",
    "methods",
    "(?:methods?|methodology|materials and methods)",
  ),
  sectionHeadingPattern("Results", "results", "results?"),
  sectionHeadingPattern("Discussion", "discussion", "discussion"),
  sectionHeadingPattern("Conclusion", "conclusion", "conclusions?"),
  sectionHeadingPattern(
    "Appendix",
    "appendix",
    "(?:appendix|supplement(?:ary)? materials?)",
  ),
  sectionHeadingPattern(
    "References",
    "references",
    "(?:references|bibliography|works cited|literature cited|references and notes)",
  ),
];

/** Enumerators that can precede a heading: "2.1", "3.", "IV.", "a)". */
const HEADING_ENUMERATOR_PATTERN =
  /^(?:\d+(?:\.\d+)*\.?|[ivxlcdm]+\.|[a-z]\))\s+/i;

/**
 * How strictly a candidate string is read as a heading.
 * - `heading`: the caller already knows this is a heading, so a run-on title
 *   ("1 Introduction and model statement") still names its section.
 * - `line`: the candidate is an arbitrary line of body text, so only a line
 *   that ends at the keyword counts ("3. Results").
 */
export type HeadingClassifyMode = "heading" | "line";

/**
 * The single owner of "which standard section is this heading?". Strips a
 * leading enumerator first, so numbered and unnumbered headings classify
 * alike, and returns undefined for headings that name no standard section
 * (for example "2.2 Kinematic condition").
 */
export function classifyHeadingKind(
  heading: string,
  mode: HeadingClassifyMode = "heading",
): SectionHeadingMatch | undefined {
  const candidate = normalizeEvidenceText(heading)
    .replace(HEADING_ENUMERATOR_PATTERN, "")
    .trim();
  if (!candidate) return undefined;
  for (const entry of SECTION_HEADING_PATTERNS) {
    if (
      entry.pattern.test(candidate) ||
      (mode === "heading" && entry.prefixPattern.test(candidate))
    ) {
      return { label: entry.label, kind: entry.kind };
    }
  }
  return undefined;
}

const FIGURE_CAPTION_PATTERN =
  /^(?:\d+\s+)?(?:fig(?:ure)?\.?)\s*(?:s(?:upp(?:lementary)?)?\s*)?\d+[a-z]?(?:\s*[:.)-]\s*|\s+)/i;
const TABLE_CAPTION_PATTERN =
  /^(?:\d+\s+)?table\s*(?:s(?:upp(?:lementary)?)?\s*)?\d+[a-z]?(?:\s*[:.)-]\s*|\s+)/i;

function normalizeEvidenceText(value: string): string {
  return sanitizePdfText(value).replace(/\s+/g, " ").trim();
}

function buildPdfSourceFingerprint(
  sourceText: string,
  sourceType?: PdfContext["sourceType"],
): string {
  let hash = 2166136261;
  const value = `${sourceType || "unknown"}\0${sourceText}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function sanitizePdfText(value: string): string {
  return (value || "").replace(/\r\n?/g, "\n").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sectionLabelPatternSource(sectionLabel: string): string {
  return escapeRegExp(sectionLabel).replace(/\s+/g, "\\s+");
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
    const lineHeading = classifyHeadingKind(line, "line");
    if (lineHeading) return lineHeading;
    if (line.length > 100 || /[.!?]/.test(line)) {
      break;
    }
  }
  // A chunk can also open with its heading run into the first sentence
  // ("Results. The film ruptures ..."), which the line scan cannot see.
  return classifyHeadingKind(chunkText, "heading");
}

function trimLeadingSectionHeading(
  chunkText: string,
  sectionLabel: string | undefined,
): string {
  if (!sectionLabel) return sanitizePdfText(chunkText);
  const trimmed = sanitizePdfText(chunkText);
  const lines = trimmed.split(/\n+/);
  const firstLine = lines[0]?.trim() || "";
  const escapedSectionLabel = sectionLabelPatternSource(sectionLabel);
  const headingPattern = new RegExp(
    `^(?:\\d+(?:\\.\\d+)*)?\\s*${escapedSectionLabel}\\b[:.\\s-]*$`,
    "i",
  );
  if (headingPattern.test(firstLine)) {
    return lines.slice(1).join(" ").trim() || trimmed;
  }
  const inlinePattern = new RegExp(
    `^(?:\\d+(?:\\.\\d+)*)?\\s*${escapedSectionLabel}\\b[:.\\s-]+`,
    "i",
  );
  return trimmed.replace(inlinePattern, "").trim() || trimmed;
}

/** Numbered reference entry: "[12] ..." or "12. ...". */
const REFERENCE_ENTRY_NUMBERED_PATTERN = /^(?:\[\d+\]|\d{1,3}[.)])\s+\S/;
/** Author-year reference entry: "Ernst MO, Banks MS (2002) ...". */
const REFERENCE_ENTRY_AUTHOR_YEAR_PATTERN =
  /^[A-Z][^\n]{0,120}?\b(?:19|20)\d{2}[a-z]?\b/;
/** What every reference entry carries somewhere: a year, a DOI or a URL. */
const REFERENCE_ENTRY_EVIDENCE_PATTERN =
  /\b(?:19|20)\d{2}[a-z]?\b|\bdoi\b|https?:\/\//i;

/**
 * Is this chunk a reference list rather than prose that cites sources? A
 * single year is not evidence — most body paragraphs of an author-year paper
 * contain one. A list is a run of entry lines: at least three of them, and at
 * least 40% of the chunk's non-empty lines.
 */
function looksLikeReferenceList(text: string): boolean {
  const lines = sanitizePdfText(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) return false;
  let entries = 0;
  for (const line of lines) {
    if (!REFERENCE_ENTRY_EVIDENCE_PATTERN.test(line)) continue;
    if (
      REFERENCE_ENTRY_NUMBERED_PATTERN.test(line) ||
      REFERENCE_ENTRY_AUTHOR_YEAR_PATTERN.test(line)
    ) {
      entries += 1;
    }
  }
  return entries >= 3 && entries >= lines.length * 0.4;
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
  cleaned = cleaned.replace(/^[-–—:;,.()[\]]+\s*/, "").trim();
  cleaned = cleaned.replace(/^(?:\d{1,3}\s+){1,3}(?=[A-Za-z])/u, "").trim();
  cleaned = cleaned.replace(/^(?:[a-z][a-z-]{1,24}\.)\s+(?=[A-Z])/u, "");
  cleaned = cleaned.replace(
    /^(?:page|p)\s*\d{1,4}(?:\s+of\s+\d{1,4})?\s*/i,
    "",
  );
  cleaned = cleaned.replace(/^[-–—:;,.()[\]]+\s*/, "").trim();
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
  if (looksLikeReferenceList(chunkText)) {
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

/**
 * Kind of a chunk that a manifest section encloses. A heading that names no
 * standard section still says "this is document body", so only a figure or
 * table caption overrides it; the reference and appendix text heuristics are
 * for unsectioned text, where the heading cannot speak.
 */
function resolveSectionedChunkKind(
  chunkText: string,
  section: ManifestSection | undefined,
): PdfChunkKind {
  if (!section) {
    return resolveChunkKind({
      chunkText,
      normalizedText: normalizeEvidenceText(chunkText),
      sectionHeading: matchSectionHeading(chunkText),
    });
  }
  if (looksLikeFigureCaption(chunkText)) return "figure-caption";
  if (looksLikeTableCaption(chunkText)) return "table-caption";
  return normalizeEvidenceText(chunkText) ? "body" : "unknown";
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
  sourceType?: PdfContext["sourceType"],
  source?: {
    sourceText?: string;
    pageChars?: number[];
  },
): PdfChunkMeta[] {
  const chunkMeta: PdfChunkMeta[] = [];
  const sourceText =
    typeof source?.sourceText === "string" ? source.sourceText : undefined;
  const sourceFingerprint = buildPdfSourceFingerprint(
    sourceText ?? chunks.join("\n\n"),
    sourceType,
  );
  let activeSection: SectionHeadingMatch | undefined;
  let sourceCursor = 0;
  let sourceSearchCursor = 0;
  const pageBoundaries = (() => {
    if (!Array.isArray(source?.pageChars) || !source.pageChars.length) {
      return [];
    }
    const boundaries: Array<{ pageIndex: number; start: number; end: number }> =
      [];
    let offset = 0;
    for (
      let pageIndex = 0;
      pageIndex < source.pageChars.length;
      pageIndex += 1
    ) {
      const charCount = Number(source.pageChars[pageIndex]);
      if (!Number.isFinite(charCount) || charCount < 0) return [];
      boundaries.push({
        pageIndex,
        start: offset,
        end: offset + charCount,
      });
      offset += charCount;
    }
    return boundaries;
  })();
  const pageForSourceOffset = (offset: number): number | undefined => {
    const match = pageBoundaries.find(
      (page) => offset >= page.start && offset < page.end,
    );
    return match?.pageIndex;
  };
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
    let sourceStart = sourceCursor;
    let sourceEnd = sourceStart + chunkText.length;
    let hasExactSourceRange = false;
    if (sourceText) {
      const exactStart = sourceText.indexOf(chunkText, sourceSearchCursor);
      const fallbackStart =
        exactStart >= 0
          ? exactStart
          : sourceText.indexOf(chunkText.slice(0, 120), sourceSearchCursor);
      if (fallbackStart >= 0) {
        const tail = chunkText.slice(-120);
        const tailStart = sourceText.indexOf(
          tail,
          fallbackStart + Math.max(0, chunkText.length - tail.length - 256),
        );
        if (tailStart >= fallbackStart) {
          sourceStart = fallbackStart;
          sourceEnd = tailStart + tail.length;
          sourceSearchCursor = fallbackStart + 1;
          hasExactSourceRange = true;
        }
      }
    }
    sourceCursor = sourceEnd + 2;
    const pageStart = hasExactSourceRange
      ? pageForSourceOffset(sourceStart)
      : undefined;
    const pageEnd =
      hasExactSourceRange && sourceEnd > sourceStart
        ? pageForSourceOffset(sourceEnd - 1)
        : undefined;
    const references = extractDocumentReferenceEvidence(chunkText);
    chunkMeta.push({
      chunkIndex,
      text: chunkText,
      normalizedText,
      sectionLabel: sectionHeading?.label,
      chunkKind,
      anchorText: buildEvidenceAnchorFromText(cleaned.text) || undefined,
      leadingNoiseRemoved: cleaned.removedLeadingNoise || undefined,
      sourceType,
      sourceFingerprint,
      sourceStart,
      sourceEnd,
      ...(pageStart !== undefined && pageEnd !== undefined
        ? { pageStart, pageEnd }
        : {}),
      references: references.length ? references : undefined,
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
  return tokenizeRetrievalText(text);
}

export function buildChunkIndex(chunks: string[]): {
  chunkStats: ChunkStat[];
  docFreq: Record<string, number>;
  avgChunkLength: number;
} {
  // Prototype-less records: tokens like "constructor" must hit own
  // properties, not Object.prototype, or term counts turn into NaN.
  const docFreq: Record<string, number> = Object.create(null);
  const chunkStats: ChunkStat[] = [];
  let totalLength = 0;

  chunks.forEach((chunk, index) => {
    const tokens = tokenizeText(chunk);
    const tf: Record<string, number> = Object.create(null);
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
  return tokenizeRetrievalQuery(query);
}

function queryPlanTerms(
  question: string,
  queryPlan: RetrievalQueryPlan | undefined,
): string[] {
  return queryPlan?.lexicalTerms?.length
    ? queryPlan.lexicalTerms
    : tokenizeQuery(question);
}

function matchedQueryVariantsForText(
  text: string,
  queryPlan: RetrievalQueryPlan | undefined,
): string[] {
  if (!queryPlan?.effectiveQueries.length || !text.trim()) return [];
  const haystack = text.toLocaleLowerCase();
  const matches: string[] = [];
  for (const query of queryPlan.effectiveQueries) {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery.length > 2 && haystack.includes(normalizedQuery)) {
      matches.push(query);
      continue;
    }
    const terms = tokenizeQuery(query);
    if (terms.length && terms.some((term) => haystack.includes(term))) {
      matches.push(query);
    }
  }
  return Array.from(new Set(matches));
}

export function scoreChunkBM25(
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

    // Layer 3: API call. Images that still lack vectors go in the same
    // embedItems call as the chunks; an image failure never costs the text.
    try {
      const pendingImages =
        itemId != null
          ? await imageIndex
              .pendingImageInputs(pdfContext, itemId)
              .catch(() => [])
          : [];
      if (itemId != null && pendingImages.length) {
        try {
          const vectors = await embedItems([
            ...pdfContext.chunks.map((text) => ({
              kind: "text" as const,
              text,
            })),
            ...pendingImages.map((entry) => entry.item),
          ]);
          await imageIndex.storeImageVectors(
            pdfContext,
            itemId,
            pendingImages,
            vectors.slice(chunkCount),
          );
          return vectors.slice(0, chunkCount);
        } catch (jointError) {
          appLogger.warn(
            "[Semantic Search] Joint text+image embedding failed; retrying text only:",
            jointError,
          );
          imageIndex.markFailure(pdfContext);
        }
      }
      // The client batches by the configured limits (16 per request by default).
      return await callEmbeddings(pdfContext.chunks);
    } catch (err) {
      if (err instanceof EmbeddingUnsupportedError) {
        appLogger.info(
          `[Semantic Search] Provider "${(err as EmbeddingUnsupportedError).providerLabel}" does not support embeddings. ` +
            "Configure a separate embedding provider in Settings → Customization. Falling back to keyword search.",
        );
      } else {
        appLogger.warn("[Semantic Search] Embedding generation failed:", err);
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
        appLogger.debug("[Semantic Search] Embedding cache write failed:", err),
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

/** Retrieval entry point for image vectors; rebuilds a missing index. */
export function ensurePaperImageVectors(
  pdfContext: PdfContext,
  itemId: number,
) {
  return imageIndex.ensureImageVectors(pdfContext, itemId);
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
      appLogger.debug(
        "[Semantic Search] Background embedding pre-generation failed:",
        err,
      );
    }
  });
}

export function buildPaperKey(ref: PaperContextRef): string {
  return `${Math.floor(ref.itemId)}:${Math.floor(ref.contextItemId)}`;
}

function resolvePaperPromptMetadata(
  ref: PaperContextRef,
  resolver: ZoteroMetadataResolver = createZoteroMetadataResolver(),
): ProjectedPaperMetadata {
  return projectPaperMetadata(resolver.resolvePaperMetadata(ref), ref);
}

function formatBibliographicMetadataLines(
  metadata: ProjectedPaperMetadata,
): string[] {
  const lines: string[] = [];
  if (metadata.title) lines.push(`Title: ${metadata.title}`);
  if (metadata.creatorDisplay) {
    lines.push(`Authors: ${metadata.creatorDisplay}`);
  }
  if (metadata.publicationDate) {
    lines.push(`Publication date: ${metadata.publicationDate}`);
  }
  if (metadata.year) lines.push(`Year: ${metadata.year}`);
  if (metadata.citationKey) {
    lines.push(`Citation key: ${metadata.citationKey}`);
  }
  if (metadata.doi) lines.push(`DOI: ${metadata.doi}`);
  if (metadata.containerTitle) {
    lines.push(
      `Container title: ${metadata.containerTitle} (Zotero field: ${metadata.containerSourceField})`,
    );
  }
  if (metadata.eventTitle) {
    lines.push(
      `Event title: ${metadata.eventTitle} (Zotero field: ${metadata.eventSourceField})`,
    );
  }
  if (metadata.journalAbbreviation) {
    lines.push(`Journal abbreviation: ${metadata.journalAbbreviation}`);
  }
  return lines;
}

function formatPaperMetadataLines(
  ref: PaperContextRef,
  metadata: ProjectedPaperMetadata,
): string[] {
  const lines = formatBibliographicMetadataLines(metadata);
  lines.push(`Source label: ${formatPaperSourceLabel(ref)}`);
  return lines;
}

function formatSelectedAttachmentMetadataLines(
  ref: PaperContextRef,
  metadata: ProjectedPaperMetadata,
): string[] {
  const contentSource = metadata.contentSource;
  const lines = [
    "Parent Zotero Item:",
    ...formatBibliographicMetadataLines(metadata),
  ];
  lines.push(
    "",
    "Selected Source:",
    `Type: ${contentSource?.contentType || formatAttachmentSourceType(ref.contentSourceMode)}`,
    `Attachment title: ${contentSource?.title || formatPaperAttachmentTitle(ref)}`,
    ...(contentSource?.filename
      ? [`Attachment filename: ${contentSource.filename}`]
      : []),
    "Relationship: Child attachment under the parent item; it may be user OCR, a translated file, supplement, notes, or another related file.",
    `Source label: ${formatPaperSourceLabel(ref)}`,
  );
  return lines;
}

function formatSelectedAttachmentGuidanceLines(): string[] {
  return [
    "Selected attachment guidance:",
    "- Treat this selected attachment as the primary evidence source for the current chat.",
    "- Use parent item metadata for bibliographic/contextual grounding, but do not override the selected attachment text with inferences from the parent title.",
    "- Do not infer that the attachment failed or is corrupted merely because its content differs from the parent title.",
    '- If the user asks about "this paper", state that the current source is the selected attachment under the parent item and answer from this source.',
  ];
}

function formatPerPaperQuoteGuidanceLines(ref: PaperContextRef): string[] {
  return buildPaperQuoteCitationGuidance(ref);
}

export function buildFullPaperContext(
  paperContext: PaperContextRef,
  pdfContext: PdfContext | undefined,
  metadataResolver: ZoteroMetadataResolver = createZoteroMetadataResolver(),
): string {
  const resolvedMetadata = resolvePaperPromptMetadata(
    paperContext,
    metadataResolver,
  );
  const isSelectedAttachment = isTextLikeAttachmentSourceMode(
    paperContext.contentSourceMode,
  );
  const metadata = isSelectedAttachment
    ? formatSelectedAttachmentMetadataLines(paperContext, resolvedMetadata)
    : formatPaperMetadataLines(paperContext, resolvedMetadata);
  const guidance = isSelectedAttachment
    ? [
        ...formatSelectedAttachmentGuidanceLines(),
        "",
        ...formatPerPaperQuoteGuidanceLines(paperContext),
      ]
    : formatPerPaperQuoteGuidanceLines(paperContext);
  if (!pdfContext || !pdfContext.chunks.length) {
    return [
      ...metadata,
      "",
      ...guidance,
      "",
      isSelectedAttachment
        ? "[No extractable selected attachment text available. Using metadata only.]"
        : "[No extractable PDF text available. Using metadata only.]",
    ].join("\n");
  }
  return [
    ...metadata,
    "",
    ...guidance,
    "",
    isSelectedAttachment ? "Selected Attachment Text:" : "Paper Text:",
    pdfContext.chunks.join("\n\n"),
  ].join("\n");
}

export function buildTruncatedFullPaperContext(
  paperContext: PaperContextRef,
  pdfContext: PdfContext | undefined,
  options: {
    maxTokens: number;
    metadataResolver?: ZoteroMetadataResolver;
  },
): {
  text: string;
  estimatedTokens: number;
  truncated: boolean;
  fullLength: number;
} {
  const resolvedMetadata = resolvePaperPromptMetadata(
    paperContext,
    options.metadataResolver,
  );
  const isSelectedAttachment = isTextLikeAttachmentSourceMode(
    paperContext.contentSourceMode,
  );
  const metadata = isSelectedAttachment
    ? formatSelectedAttachmentMetadataLines(paperContext, resolvedMetadata)
    : formatPaperMetadataLines(paperContext, resolvedMetadata);
  const guidance = isSelectedAttachment
    ? [
        ...formatSelectedAttachmentGuidanceLines(),
        "",
        ...formatPerPaperQuoteGuidanceLines(paperContext),
      ]
    : formatPerPaperQuoteGuidanceLines(paperContext);
  if (!pdfContext || !pdfContext.chunks.length) {
    const text = [
      ...metadata,
      "",
      ...guidance,
      "",
      isSelectedAttachment
        ? "[No extractable selected attachment text available. Using metadata only.]"
        : "[No extractable PDF text available. Using metadata only.]",
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
    ...guidance,
    "",
    isSelectedAttachment ? "Selected Attachment Text:" : "Paper Text:",
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
  // Semantic search runs whenever an embedding config resolves; an explicit
  // "off" always wins. llmClient owns both decisions.
  const state = resolveSemanticSearchState();
  if (
    !state.enabled &&
    state.source === "pref" &&
    typeof ztoolkit !== "undefined"
  ) {
    // Only the user who asked for semantic search needs to hear that it is
    // unavailable; under auto there is simply nothing to reuse.
    const reason = getEmbeddingUnavailableReason();
    if (reason) {
      appLogger.info(`[Semantic Search] Embeddings unavailable: ${reason}`);
    }
  }
  return state.enabled;
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

/**
 * Section priors keyed by query intent. Only the *sign* of a prior survives:
 * a boosted kind moves up a fixed two ranks, a demoted kind moves to the end.
 * `introduction`, `body` and `unknown` never move — a prior may break a tie,
 * it may not decide the order (reciprocal-rank fusion spans ~0.03 in total,
 * so the old additive constants of 0.8–1.5 overruled relevance outright).
 */
const SECTION_BOOST_PROFILES: Record<
  QueryIntent,
  { boost: PdfChunkKind[]; demote: PdfChunkKind[] }
> = {
  general: {
    boost: ["abstract", "results", "discussion", "conclusion"],
    demote: ["figure-caption", "table-caption", "appendix", "references"],
  },
  factual: {
    boost: ["results", "methods", "abstract", "discussion"],
    demote: ["figure-caption", "table-caption", "appendix", "references"],
  },
  conceptual: {
    boost: ["discussion", "abstract", "results"],
    demote: ["figure-caption", "table-caption", "appendix", "references"],
  },
  methodological: {
    boost: ["methods", "abstract", "results"],
    // The old profile gave `appendix` a positive weight for method questions.
    demote: ["figure-caption", "table-caption", "references"],
  },
  comparative: {
    boost: ["results", "discussion", "abstract"],
    demote: ["figure-caption", "table-caption", "appendix", "references"],
  },
  citation: {
    boost: ["references", "discussion", "abstract"],
    demote: ["figure-caption", "table-caption", "appendix"],
  },
  visual: {
    boost: ["figure-caption", "table-caption", "results"],
    demote: ["appendix", "references"],
  },
};

/** Ranks a boosted section kind can climb. */
const SECTION_PRIOR_RANK_SHIFT = -2;
/** Chunks shorter than this are evidence-poor whatever their section says. */
const MIN_EVIDENCE_WORD_COUNT = 12;

/** The prior a chunk carries: a bounded rank shift, or a demotion. */
type SectionPrior = Pick<RetrievalExplanation, "priorShift" | "demoted">;

/** A demoted chunk sorts behind every other chunk; its shift is not a number. */
const DEMOTED_PRIOR: SectionPrior = { priorShift: 0, demoted: true };
const NEUTRAL_PRIOR: SectionPrior = { priorShift: 0 };

/**
 * Bounded section prior: a rank shift, not a score. Demoted chunks carry
 * `demoted: true` and sort to the end; they stay candidates so a
 * reference-locked read can still pull a caption or a reference entry back.
 */
function priorShiftFor(params: {
  chunkText: string;
  chunkKind?: PdfChunkKind;
  kindSource?: "manifest" | "heuristic";
  intent?: QueryIntent;
}): SectionPrior {
  const chunkText = normalizeEvidenceText(params.chunkText);
  const wordCount = chunkText ? chunkText.split(/\s+/).length : 0;
  if (wordCount < MIN_EVIDENCE_WORD_COUNT) return DEMOTED_PRIOR;
  if (looksLikeReferenceList(params.chunkText)) return DEMOTED_PRIOR;

  const profile = SECTION_BOOST_PROFILES[params.intent || "general"];
  const kind = params.chunkKind as PdfChunkKind | undefined;
  if (!kind) return NEUTRAL_PRIOR;
  if (profile.demote.includes(kind)) return DEMOTED_PRIOR;
  if (profile.boost.includes(kind) && params.kindSource === "manifest") {
    return { priorShift: SECTION_PRIOR_RANK_SHIFT };
  }
  return NEUTRAL_PRIOR;
}

// ── Structure stage ──────────────────────────────────────────────────────────

export type RetrievalSectionSummary = {
  sectionId: string;
  title: string;
  index: number;
};

/** The outline id of a section: the one owner of the `s<n>` convention. */
export function sectionIdForIndex(sectionIndex: number): string {
  return `s${sectionIndex}`;
}

function isDemotedCandidate(candidate: PaperContextCandidate): boolean {
  return candidate.why?.demoted === true;
}

function setStructureRule(
  candidate: PaperContextCandidate,
  rule: NonNullable<RetrievalExplanation["structureRule"]>,
): void {
  if (!candidate.why) return;
  candidate.why.structureRule = rule;
}

/**
 * Pick the delivered set out of the ranked list: relevance order first, then
 * the four structure rules of the design (heading match, per-section cap,
 * neighbour expansion, section-diverse fallback). Pure, so the rules can be
 * unit-tested without a PdfContext.
 *
 * `ranked` must already be ordered (fused rank plus bounded prior). Candidates
 * without a `sectionIndex` (PDF-worker text has no headings) skip the
 * section-based rules but still take part in neighbour expansion.
 */
export function selectStructuredCandidates(params: {
  ranked: PaperContextCandidate[];
  topK: number;
  queryTerms: string[];
  sections: ReadonlyArray<RetrievalSectionSummary>;
  sectionIds?: string[];
  hasSignal: boolean;
}): PaperContextCandidate[] {
  const topK = Math.max(1, Math.floor(params.topK));
  const requestedSectionIds = (params.sectionIds || []).filter(Boolean);
  let pool = params.ranked;
  if (requestedSectionIds.length) {
    const wanted = new Set(requestedSectionIds);
    // Same rule as the ranking stage: a requested scope that matches nothing
    // returns nothing rather than widening to the whole document.
    pool = params.ranked.filter(
      (candidate) =>
        candidate.sectionIndex !== undefined &&
        wanted.has(sectionIdForIndex(candidate.sectionIndex)),
    );
  }
  if (!pool.length) return [];
  // A read of fewer than four chunks has no room for structure: a reserved
  // heading slot or a per-section cap would displace the best match instead
  // of diversifying around it. Reference locks, preferred chunks and the body
  // fallback still apply — they run after this stage.
  if (topK < 4) return pool.slice(0, topK);

  const poolOrder = new Map(
    pool.map((candidate, index) => [candidate, index] as const),
  );
  const sectioned = pool.filter(
    (candidate) => candidate.sectionIndex !== undefined,
  );

  if (!params.hasSignal && sectioned.length) {
    return selectSectionDiverseFallback(pool, topK);
  }

  const selected: PaperContextCandidate[] = [];
  const chosen = new Set<PaperContextCandidate>();
  const reserved = new Set<PaperContextCandidate>();
  const perSection = new Map<number, number>();
  const take = (candidate: PaperContextCandidate): void => {
    if (chosen.has(candidate)) return;
    chosen.add(candidate);
    selected.push(candidate);
    if (candidate.sectionIndex !== undefined) {
      perSection.set(
        candidate.sectionIndex,
        (perSection.get(candidate.sectionIndex) || 0) + 1,
      );
    }
  };

  // (i) Heading match — up to two named sections keep a slot.
  const queryTokens = new Set(
    params.queryTerms
      .flatMap((term) => tokenizeRetrievalText(term))
      .filter(Boolean),
  );
  const requestedIdSet = new Set(requestedSectionIds);
  const named = params.sections
    .map((section) => {
      const titleTokens = tokenizeRetrievalText(section.title || "");
      const shared = new Set(
        titleTokens.filter((token) => queryTokens.has(token)),
      ).size;
      const addressed = requestedIdSet.has(section.sectionId);
      return { section, shared, addressed };
    })
    .filter((entry) => entry.shared > 0 || entry.addressed)
    .sort((a, b) => b.shared - a.shared || a.section.index - b.section.index)
    .slice(0, 2);
  for (const entry of named) {
    const best = pool.find(
      (candidate) => candidate.sectionIndex === entry.section.index,
    );
    if (!best || chosen.has(best) || selected.length >= topK) continue;
    take(best);
    reserved.add(best);
    setStructureRule(best, "heading_match");
  }

  // (ii) Rank order, bounded by the per-section cap.
  const cap = Math.max(1, Math.ceil(topK / 3));
  let pendingCapSkip = false;
  for (const candidate of pool) {
    if (selected.length >= topK) break;
    if (chosen.has(candidate)) continue;
    if (
      candidate.sectionIndex !== undefined &&
      (perSection.get(candidate.sectionIndex) || 0) >= cap
    ) {
      pendingCapSkip = true;
      continue;
    }
    take(candidate);
    if (pendingCapSkip) {
      setStructureRule(candidate, "section_cap");
      pendingCapSkip = false;
    }
  }

  // (iii) Neighbour expansion for wide reads.
  if (topK >= 6) {
    const head = pool[0];
    const neighbour = pool.find(
      (candidate) =>
        candidate.chunkIndex === head.chunkIndex + 1 &&
        candidate.sectionIndex === head.sectionIndex &&
        !chosen.has(candidate),
    );
    if (neighbour) {
      if (selected.length >= topK) {
        const replaceIndex = selected.findLastIndex(
          (candidate) => !reserved.has(candidate),
        );
        if (replaceIndex >= 0) {
          chosen.delete(selected[replaceIndex]);
          selected.splice(replaceIndex, 1);
          take(neighbour);
          setStructureRule(neighbour, "neighbour");
        }
      } else {
        take(neighbour);
        setStructureRule(neighbour, "neighbour");
      }
    }
  }

  // (iv) Back-fill. The per-section cap drops candidates without replacing
  // them, so a pool concentrated in one section can deliver fewer chunks than
  // the caller asked for. Membership rules shape a read; they never shrink it.
  if (selected.length < topK) {
    for (const candidate of pool) {
      if (selected.length >= topK) break;
      if (chosen.has(candidate)) continue;
      take(candidate);
    }
  }

  // Relevance order is the delivered order; the rules decide membership.
  return selected.sort(
    (a, b) => (poolOrder.get(a) ?? 0) - (poolOrder.get(b) ?? 0),
  );
}

/**
 * Nothing matched lexically and no embeddings ran: deliver one chunk per
 * section in document order instead of the front of the document.
 */
function selectSectionDiverseFallback(
  pool: PaperContextCandidate[],
  topK: number,
): PaperContextCandidate[] {
  const bySection = new Map<number, PaperContextCandidate[]>();
  for (const candidate of pool) {
    if (candidate.sectionIndex === undefined) continue;
    const bucket = bySection.get(candidate.sectionIndex);
    if (bucket) bucket.push(candidate);
    else bySection.set(candidate.sectionIndex, [candidate]);
  }
  const selected: PaperContextCandidate[] = [];
  const chosen = new Set<PaperContextCandidate>();
  for (const sectionIndex of [...bySection.keys()].sort((a, b) => a - b)) {
    if (selected.length >= topK) break;
    const bucket = [...(bySection.get(sectionIndex) || [])].sort(
      (a, b) => a.chunkIndex - b.chunkIndex,
    );
    const pick = bucket.find((candidate) => !isDemotedCandidate(candidate));
    const chunk = pick || bucket[0];
    if (!chunk) continue;
    chosen.add(chunk);
    selected.push(chunk);
  }
  if (selected.length < topK) {
    const rest = pool
      .filter((candidate) => !chosen.has(candidate))
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
    for (const candidate of rest) {
      if (selected.length >= topK) break;
      chosen.add(candidate);
      selected.push(candidate);
    }
  }
  for (const candidate of selected) {
    setStructureRule(candidate, "section_diverse_fallback");
  }
  return selected;
}

/** Sections of a document, derived from the chunk metadata. */
function buildSectionSummaries(
  chunkMeta: PdfChunkMeta[],
): RetrievalSectionSummary[] {
  const byIndex = new Map<number, RetrievalSectionSummary>();
  for (const meta of chunkMeta) {
    if (meta?.sectionIndex === undefined || byIndex.has(meta.sectionIndex)) {
      continue;
    }
    byIndex.set(meta.sectionIndex, {
      sectionId: sectionIdForIndex(meta.sectionIndex),
      title: meta.sectionLabel || "",
      index: meta.sectionIndex,
    });
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/**
 * The section list of a document, derived from the chunk metadata: one entry
 * per `sectionIndex`, with the chunk range and character count that tell the
 * model how much text a section holds before it asks to read it.
 *
 * Pure: the MinerU parse-health block is passed in by the caller (the tool
 * reads it through `ensureManifest`) rather than read from disk here.
 */
export function buildDocumentOutline(
  ctx: PdfContext | undefined,
  structure?: MineruManifest["structure"],
): DocumentOutline {
  const chunkMeta = Array.isArray(ctx?.chunkMeta) ? ctx.chunkMeta : [];
  const byIndex = new Map<number, DocumentOutlineSection>();
  for (const meta of chunkMeta) {
    if (!meta || meta.sectionIndex === undefined) continue;
    const chunkIndex = Number.isFinite(meta.chunkIndex)
      ? Math.floor(meta.chunkIndex)
      : 0;
    const chars = (meta.text || "").length;
    const existing = byIndex.get(meta.sectionIndex);
    if (!existing) {
      byIndex.set(meta.sectionIndex, {
        sectionId: sectionIdForIndex(meta.sectionIndex),
        title: meta.sectionLabel || "",
        level: meta.sectionLevel ?? 1,
        path: meta.sectionPath || meta.sectionLabel || "",
        chunkIndexes: [chunkIndex, chunkIndex],
        chars,
      });
      continue;
    }
    existing.chunkIndexes = [
      Math.min(existing.chunkIndexes[0], chunkIndex),
      Math.max(existing.chunkIndexes[1], chunkIndex),
    ];
    existing.chars += chars;
  }
  const sections = [...byIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, section]) => section);
  return {
    sections,
    totalChunks: Array.isArray(ctx?.chunks)
      ? ctx.chunks.length
      : chunkMeta.length,
    ...(structure ? { structure } : {}),
  };
}

export async function buildPaperRetrievalCandidates(
  paperContext: PaperContextRef,
  pdfContext: PdfContext | undefined,
  question: string,
  apiOverridesOrOptions?: {
    apiBase?: string;
    apiKey?: string;
    topK?: number;
    mode?: "general" | "evidence";
    /** Pre-computed query embedding to avoid redundant API calls in multi-paper loops. */
    precomputedQueryEmbedding?: number[];
    /** Disable semantic embeddings even when the global semantic-search preference is enabled. */
    disableEmbeddings?: boolean;
    /** Shared retrieval query plan with bounded variants and lexical terms. */
    queryPlan?: RetrievalQueryPlan;
    /** Chunk indexes that must remain available for locked retrieval selection. */
    preferredChunkIndexes?: number[];
    /** Restrict candidates to these section ids (`s<n>`) before ranking. */
    sectionIds?: string[];
  },
  compatibilityOptions?: {
    topK?: number;
    mode?: "general" | "evidence";
    /** Pre-computed query embedding to avoid redundant API calls in multi-paper loops. */
    precomputedQueryEmbedding?: number[];
    /** Disable semantic embeddings even when the global semantic-search preference is enabled. */
    disableEmbeddings?: boolean;
    /** Shared retrieval query plan with bounded variants and lexical terms. */
    queryPlan?: RetrievalQueryPlan;
    /** Chunk indexes that must remain available for locked retrieval selection. */
    preferredChunkIndexes?: number[];
    /** Restrict candidates to these section ids (`s<n>`) before ranking. */
    sectionIds?: string[];
  },
): Promise<PaperContextCandidate[]> {
  if (!pdfContext) return [];
  const options =
    compatibilityOptions ||
    ("topK" in (apiOverridesOrOptions || {}) ||
    "mode" in (apiOverridesOrOptions || {}) ||
    "precomputedQueryEmbedding" in (apiOverridesOrOptions || {}) ||
    "queryPlan" in (apiOverridesOrOptions || {}) ||
    "preferredChunkIndexes" in (apiOverridesOrOptions || {}) ||
    "sectionIds" in (apiOverridesOrOptions || {})
      ? apiOverridesOrOptions
      : undefined);
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

  const queryPlan = options?.queryPlan;
  const terms = queryPlanTerms(question, queryPlan);
  const semanticQuery = queryPlan?.semanticQuery || question;
  const referenceMatches = resolveDocumentReferenceMatches(
    queryPlan?.references || parseDocumentReferences(question),
    chunkMeta,
  );
  const referenceConfidenceByChunk = new Map(
    referenceMatches.map((match) => [match.chunkIndex, match.confidence]),
  );
  const highConfidenceNeighborIndexes = new Set<number>();
  for (const match of referenceMatches) {
    if (match.confidence !== "high") continue;
    if (match.chunkIndex > 0)
      highConfidenceNeighborIndexes.add(match.chunkIndex - 1);
    if (match.chunkIndex + 1 < chunks.length) {
      highConfidenceNeighborIndexes.add(match.chunkIndex + 1);
    }
  }
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
  if (
    semanticQuery.trim() &&
    !options?.disableEmbeddings &&
    shouldTryEmbeddings()
  ) {
    const embeddingsReady = await ensureEmbeddings(
      pdfContext,
      paperContext.contextItemId,
    );
    if (embeddingsReady && pdfContext.embeddings) {
      try {
        const queryEmbedding =
          options?.precomputedQueryEmbedding ||
          (await callEmbeddings([semanticQuery]))[0] ||
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
        appLogger.warn("Query embedding failed:", err);
      }
    }
  }

  // Reciprocal Rank Fusion (RRF) — rank-based fusion that avoids
  // normalization sensitivity and fixed weight tuning.
  const retrievalMode = options?.mode || "general";

  const intent = queryPlan?.retrievalPurpose;

  const candidates = chunkStats.map((chunk, idx) => {
    const bm25Score = bm25Scores[idx] || 0;
    const embeddingScore = rawEmbeddingScores
      ? rawEmbeddingScores[idx] || 0
      : 0;
    const hybridScore = embedRank
      ? 1 / (RRF_K + bm25Rank[idx]) + 1 / (RRF_K + embedRank[idx])
      : 1 / (RRF_K + bm25Rank[idx]);
    const meta = chunkMeta[chunk.index];
    const matchedQueryVariants = matchedQueryVariantsForText(
      chunks[chunk.index],
      queryPlan,
    );
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
      sectionIndex: meta?.sectionIndex,
      sectionPath: meta?.sectionPath,
      chunkKind: meta?.chunkKind,
      anchorText: meta?.anchorText,
      leadingNoiseRemoved: meta?.leadingNoiseRemoved,
      sourceStart: meta?.sourceStart,
      sourceEnd: meta?.sourceEnd,
      sourceFingerprint: meta?.sourceFingerprint,
      pageStart: meta?.pageStart,
      pageEnd: meta?.pageEnd,
      estimatedTokens: Math.max(1, estimateTextTokens(chunks[chunk.index])),
      bm25Score,
      embeddingScore,
      hybridScore,
      evidenceScore: hybridScore,
      matchedQueryVariant: matchedQueryVariants[0],
      matchedQueryVariants: matchedQueryVariants.length
        ? matchedQueryVariants
        : undefined,
      referenceConfidence: referenceConfidenceByChunk.get(chunk.index),
      why: {
        bm25Rank: bm25Rank[idx],
        querySignal:
          bm25Score > 0 ? "lexical" : embedRank ? "semantic" : "none",
        embeddingRank: embedRank ? embedRank[idx] : undefined,
        // A general read never reorders by section: the prior exists to break
        // ties inside an evidence read, nothing more.
        ...(retrievalMode === "evidence"
          ? priorShiftFor({
              chunkText: chunks[chunk.index],
              chunkKind: meta?.chunkKind,
              kindSource: meta?.kindSource,
              intent,
            })
          : NEUTRAL_PRIOR),
        kindSource: meta?.kindSource,
      },
    };
    return candidate;
  });

  // Stage 3 — bounded prior. The fused rank moves by at most two ranks; a
  // demoted chunk goes behind every other chunk but stays a candidate, so a
  // reference-locked read can still pull it back.
  const demoteRankShift = candidates.length + 1;
  const fusedRank = new Map<PaperContextCandidate, number>();
  [...candidates]
    .sort(
      (a, b) => b.hybridScore - a.hybridScore || a.chunkIndex - b.chunkIndex,
    )
    .forEach((candidate, index) => fusedRank.set(candidate, index + 1));

  const adjustedRank = new Map<PaperContextCandidate, number>();
  const referenceTier = new Map<PaperContextCandidate, number>();
  for (const candidate of candidates) {
    const priorShift = candidate.why?.priorShift ?? 0;
    const demoted = candidate.why?.demoted === true;
    // A document reference the query named outranks the section prior: a
    // high-confidence match is the read, medium and neighbours only move up.
    const referenceShift =
      candidate.referenceConfidence === "medium"
        ? -2
        : highConfidenceNeighborIndexes.has(candidate.chunkIndex)
          ? -1
          : 0;
    const rank = fusedRank.get(candidate) || 0;
    // A prior may improve a rank, never overtake the best lexical match: a
    // boosted chunk stops at rank 2 unless it already won the fusion.
    const priorRank = demoted
      ? rank + demoteRankShift
      : priorShift < 0
        ? Math.max(rank + priorShift, rank > 1 ? 2 : 1)
        : rank + priorShift;
    adjustedRank.set(candidate, priorRank + referenceShift);
    referenceTier.set(
      candidate,
      candidate.referenceConfidence === "high" ? 0 : 1,
    );
  }
  const byAdjustedRank = (
    a: PaperContextCandidate,
    b: PaperContextCandidate,
  ): number =>
    (referenceTier.get(a) || 0) - (referenceTier.get(b) || 0) ||
    (adjustedRank.get(a) || 0) - (adjustedRank.get(b) || 0) ||
    (fusedRank.get(a) || 0) - (fusedRank.get(b) || 0);
  const allRanked = [...candidates].sort(byAdjustedRank);
  const requestedSections = new Set(options?.sectionIds || []);
  const restricted = requestedSections.size
    ? allRanked.filter(
        (candidate) =>
          candidate.sectionIndex !== undefined &&
          requestedSections.has(sectionIdForIndex(candidate.sectionIndex)),
      )
    : [];
  // Every later reservation and fallback must obey the same valid scope.
  // A requested scope that matches nothing returns nothing: falling back to
  // the whole document would deliver out-of-scope passages without a warning.
  const ranked = requestedSections.size ? restricted : allRanked;

  // Stage 2 — structure.
  const selected = selectStructuredCandidates({
    ranked,
    topK,
    queryTerms: terms,
    sections: buildSectionSummaries(chunkMeta),
    sectionIds: options?.sectionIds,
    hasSignal: bm25Scores.some((score) => score > 0) || embedRank !== null,
  });
  const selectionOrder = new Map(
    selected.map((candidate, index) => [candidate, index] as const),
  );

  const preferredChunkIndexes = new Set(
    (options?.preferredChunkIndexes || [])
      .map((index) => Number(index))
      .filter((index) => Number.isFinite(index) && index >= 0)
      .map((index) => Math.floor(index)),
  );
  for (const preferred of ranked.filter((candidate) =>
    preferredChunkIndexes.has(candidate.chunkIndex),
  )) {
    if (!selected.includes(preferred)) selected.push(preferred);
  }
  const requiredReferenceEntries = ranked.filter(
    (candidate) =>
      candidate.referenceConfidence === "high" ||
      highConfidenceNeighborIndexes.has(candidate.chunkIndex),
  );
  const requiredReferenceIndexes = new Set(
    requiredReferenceEntries.map((candidate) => candidate.chunkIndex),
  );
  for (const referenceEntry of requiredReferenceEntries) {
    if (selected.includes(referenceEntry)) continue;
    if (selected.length < topK) {
      selected.push(referenceEntry);
    } else {
      const replaceIndex = selected.findLastIndex(
        (candidate) => !requiredReferenceIndexes.has(candidate.chunkIndex),
      );
      if (replaceIndex >= 0) {
        selected[replaceIndex] = referenceEntry;
      } else {
        selected.push(referenceEntry);
      }
    }
  }
  if (
    retrievalMode === "evidence" &&
    selected.length &&
    !selected.some((candidate) =>
      isBodyEvidenceSection(candidate.sectionLabel, candidate.chunkKind),
    )
  ) {
    const bodyEntry = ranked.find((candidate) =>
      isBodyEvidenceSection(candidate.sectionLabel, candidate.chunkKind),
    );
    if (bodyEntry && !selected.includes(bodyEntry)) {
      const replaceIndex = selected.findLastIndex(
        (candidate) => !requiredReferenceIndexes.has(candidate.chunkIndex),
      );
      if (replaceIndex >= 0) selected[replaceIndex] = bodyEntry;
    }
  }

  // Delivered order: reference locks first, then the structure stage's order,
  // then anything added afterwards. `evidenceScore` is the reciprocal of the
  // final rank so cross-paper merging stays rank-based.
  const lateAddition = Number.MAX_SAFE_INTEGER;
  selected.sort(
    (a, b) =>
      (referenceTier.get(a) || 0) - (referenceTier.get(b) || 0) ||
      (selectionOrder.get(a) ?? lateAddition) -
        (selectionOrder.get(b) ?? lateAddition) ||
      (adjustedRank.get(a) || 0) - (adjustedRank.get(b) || 0) ||
      a.chunkIndex - b.chunkIndex,
  );
  selected.forEach((candidate, index) => {
    candidate.evidenceScore = 1 / (RRF_K + index + 1);
  });

  return selected;
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

export type EvidenceQuoteAnchorPolicy = "none" | "verified";

type EvidenceQuoteAnchorRejectionReason =
  | "policy-none"
  | "boilerplate-section"
  | "reference-section"
  | "not-quote-worthy";

export type EvidenceQuoteAnchorDiagnostics = {
  policy: EvidenceQuoteAnchorPolicy;
  candidateCount: number;
  acceptedCount: number;
  rejectedReasons: Partial<Record<EvidenceQuoteAnchorRejectionReason, number>>;
};

function incrementQuoteAnchorRejection(
  diagnostics: EvidenceQuoteAnchorDiagnostics,
  reason: EvidenceQuoteAnchorRejectionReason,
): void {
  diagnostics.rejectedReasons[reason] =
    (diagnostics.rejectedReasons[reason] || 0) + 1;
}

const BOILERPLATE_QUOTE_SECTION_PATTERN =
  /^(?:in brief|highlights?|graphical abstract|author summary|summary|keywords?|article info(?:rmation)?|author contributions?|declaration of interests?|acknowledg(?:e)?ments?)$/i;

function normalizeSectionLabelForQuoteGate(value: string | undefined): string {
  return sanitizePdfText(value || "")
    .replace(/^#+\s*/, "")
    .replace(/[:.\s-]+$/g, "")
    .trim();
}

function isEvidenceQuoteAnchorEligible(params: {
  candidate: PaperContextCandidate;
  quoteText: string;
}): { eligible: boolean; reason?: EvidenceQuoteAnchorRejectionReason } {
  const { candidate, quoteText } = params;
  const sectionLabel = normalizeSectionLabelForQuoteGate(
    candidate.sectionLabel,
  );
  if (sectionLabel && BOILERPLATE_QUOTE_SECTION_PATTERN.test(sectionLabel)) {
    return { eligible: false, reason: "boilerplate-section" };
  }
  if (candidate.chunkKind === "references") {
    return { eligible: false, reason: "reference-section" };
  }
  if (!isQuoteWorthySourceText(quoteText)) {
    return { eligible: false, reason: "not-quote-worthy" };
  }
  return { eligible: true };
}

function formatMarkdownBlockquote(text: string): string {
  const normalized = sanitizePdfText(text);
  if (!normalized) return "> [No quoted text available]";
  return normalized
    .split(/\n+/)
    .map((line) => `> ${line.trim()}`)
    .join("\n");
}

function evidenceSupportId(paperIndex: number, candidateIndex: number): string {
  return `P${paperIndex + 1}.S${candidateIndex + 1}`;
}

function sectionLabelForDigest(candidate: PaperContextCandidate): string {
  return sanitizePdfText(
    candidate.sectionLabel ||
      (candidate.chunkKind && candidate.chunkKind !== "unknown"
        ? candidate.chunkKind
        : "Unlabeled body text"),
  );
}

function candidateHasBodyEvidence(candidate: PaperContextCandidate): boolean {
  return isBodyEvidenceSection(candidate.sectionLabel, candidate.chunkKind);
}

function truncateDigestText(text: string, maxChars = 220): string {
  const normalized = sanitizePdfText(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function buildPaperSynthesisDigest(params: {
  papers: PaperContextRef[];
  byPaper: Map<string, PaperContextCandidate[]>;
}): string {
  const lines = [
    "Paper synthesis digest:",
    "Use this digest as the first-pass synthesis ledger before writing the final answer. Support IDs point to retrieved snippets below; cite papers normally in prose and use quote cards only for verified exact wording.",
  ];
  for (const [paperIndex, paper] of params.papers.entries()) {
    const paperKey = buildPaperKey(paper);
    const candidates = [...(params.byPaper.get(paperKey) || [])].sort(
      (a, b) => a.chunkIndex - b.chunkIndex,
    );
    const supportIds = candidates.map((_, candidateIndex) =>
      evidenceSupportId(paperIndex, candidateIndex),
    );
    const sections = Array.from(
      new Set(candidates.map(sectionLabelForDigest).filter(Boolean)),
    );
    const preferred =
      candidates.find(candidateHasBodyEvidence) || candidates[0] || null;
    const coverage = candidates.length
      ? candidates.some(candidateHasBodyEvidence)
        ? "body evidence"
        : "abstract/front matter only"
      : "metadata only";
    const contribution = preferred
      ? truncateDigestText(buildEvidenceQuoteText(preferred))
      : "No retrieved snippet was available in this turn.";
    lines.push(
      [
        `- Paper ${paperIndex + 1}: ${formatPaperSourceLabel(paper)}`,
        `coverage: ${coverage}`,
        `sections: ${sections.length ? sections.join(", ") : "none"}`,
        `support: ${supportIds.length ? supportIds.join(", ") : "none"}`,
        `contribution: ${contribution}`,
      ].join("; "),
    );
  }
  return lines.join("\n");
}

export function buildEvidencePack(params: {
  papers: PaperContextRef[];
  candidates: PaperContextCandidate[];
  quoteAnchorPolicy?: EvidenceQuoteAnchorPolicy;
}): {
  contextText: string;
  ledgerText: string;
  synthesisDigest: string;
  retrievedEvidenceText: string;
  quoteCitations: QuoteCitation[];
  quoteAnchorDiagnostics: EvidenceQuoteAnchorDiagnostics;
} {
  const { papers, candidates } = params;
  const metadataResolver = createZoteroMetadataResolver();
  const quoteAnchorPolicy = params.quoteAnchorPolicy || "none";
  const quoteAnchorDiagnostics: EvidenceQuoteAnchorDiagnostics = {
    policy: quoteAnchorPolicy,
    candidateCount: candidates.length,
    acceptedCount: 0,
    rejectedReasons: {},
  };
  if (!papers.length) {
    return {
      contextText: "",
      ledgerText: "",
      synthesisDigest: "",
      retrievedEvidenceText: "",
      quoteCitations: [],
      quoteAnchorDiagnostics,
    };
  }

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

  const quoteCitations: QuoteCitation[] = [];
  for (const paper of papers) {
    const paperKey = buildPaperKey(paper);
    for (const candidate of byPaper.get(paperKey) || []) {
      const quoteText = buildEvidenceQuoteText(candidate);
      if (quoteAnchorPolicy === "none") {
        incrementQuoteAnchorRejection(quoteAnchorDiagnostics, "policy-none");
        continue;
      }
      const eligibility = isEvidenceQuoteAnchorEligible({
        candidate,
        quoteText,
      });
      if (!eligibility.eligible) {
        incrementQuoteAnchorRejection(
          quoteAnchorDiagnostics,
          eligibility.reason || "not-quote-worthy",
        );
        continue;
      }
      const citation = buildQuoteCitation({
        quoteText,
        citationLabel: formatPaperSourceLabel(paper),
        sourceMatchKind: "trusted",
        sourceMatchSource: "context-text",
        sourceSectionLabel: candidate.sectionLabel,
        sourceChunkKind: candidate.chunkKind,
        contextItemId: paper.contextItemId,
        itemId: paper.itemId,
      });
      if (citation) {
        quoteAnchorDiagnostics.acceptedCount += 1;
        quoteCitations.push(citation);
      } else {
        incrementQuoteAnchorRejection(
          quoteAnchorDiagnostics,
          "not-quote-worthy",
        );
      }
    }
  }
  const normalizedQuoteCitations = mergeQuoteCitations(quoteCitations);
  const quoteAnchorGuidance = buildQuoteAnchorPromptBlock(
    normalizedQuoteCitations,
  );
  const hasSelectedAttachmentSource = papers.some((paper) =>
    isTextLikeAttachmentSourceMode(paper.contentSourceMode),
  );

  const blocks: string[] = [];
  const ledgerLines = ["Paper coverage ledger:"];
  for (const [paperIndex, paper] of papers.entries()) {
    const paperKey = buildPaperKey(paper);
    const paperCandidates = byPaper.get(paperKey) || [];
    ledgerLines.push(
      `- Paper ${paperIndex + 1}: ${formatPaperSourceLabel(paper)}; retrieved snippets: ${paperCandidates.length}`,
    );
  }
  const ledgerText = ledgerLines.join("\n");
  const synthesisDigest = buildPaperSynthesisDigest({ papers, byPaper });
  const retrievedEvidenceText = [
    "Retrieved Evidence:",
    "",
    ...quoteAnchorGuidance,
    ...(quoteAnchorGuidance.length ? [""] : []),
    ...(hasSelectedAttachmentSource
      ? buildGenericSourceQuoteCitationGuidance()
      : buildPaperQuoteCitationGuidance()),
    hasSelectedAttachmentSource
      ? "The full paper or selected attachment source remains available in paper chat."
      : "The full paper remains available in paper chat.",
    "For this reply, prioritize these retrieved snippets as the primary evidence pack.",
    "For broad synthesis, work from the paper ledger and snippets first; do not turn snippets into quote cards unless verified quote anchors are provided and exact wording is useful.",
    "Do not use snippets from references as empirical evidence.",
    "If support is weak or indirect, say so instead of overstating the claim.",
  ].join("\n");
  blocks.push(ledgerText);
  blocks.push(synthesisDigest);
  blocks.push(retrievedEvidenceText);
  for (const [paperIndex, paper] of papers.entries()) {
    const paperKey = buildPaperKey(paper);
    const paperCandidates = byPaper.get(paperKey) || [];
    paperCandidates.sort((a, b) => a.chunkIndex - b.chunkIndex);
    const lines: string[] = [`Paper ${paperIndex + 1}`];
    lines.push(
      ...formatPaperMetadataLines(
        paper,
        resolvePaperPromptMetadata(paper, metadataResolver),
      ),
    );
    if (paperCandidates.length) {
      lines.push("", "Evidence:");
      for (const [candidateIndex, candidate] of paperCandidates.entries()) {
        lines.push(
          `Evidence snippet ${candidateIndex + 1} (${evidenceSupportId(
            paperIndex,
            candidateIndex,
          )})`,
        );
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

  if (blocks.length <= 1) {
    return {
      contextText: "",
      ledgerText: "",
      synthesisDigest: "",
      retrievedEvidenceText: "",
      quoteCitations: [],
      quoteAnchorDiagnostics,
    };
  }
  return {
    contextText: blocks.join("\n\n---\n\n"),
    ledgerText,
    synthesisDigest,
    retrievedEvidenceText,
    quoteCitations: normalizedQuoteCitations,
    quoteAnchorDiagnostics,
  };
}

export function renderEvidencePack(params: {
  papers: PaperContextRef[];
  candidates: PaperContextCandidate[];
}): string {
  return buildEvidencePack(params).contextText;
}

export function renderClaimEvidencePack(params: {
  paper: PaperContextRef;
  candidates: PaperContextCandidate[];
}): string {
  const { paper, candidates } = params;
  if (!candidates.length) return "";
  const quoteCitations = mergeQuoteCitations(
    candidates
      .map((candidate) =>
        buildQuoteCitation({
          quoteText: buildEvidenceQuoteText(candidate),
          citationLabel: formatPaperSourceLabel(paper),
          contextItemId: paper.contextItemId,
          itemId: paper.itemId,
        }),
      )
      .filter((entry): entry is QuoteCitation => Boolean(entry)),
  );
  const quoteAnchorGuidance = buildQuoteAnchorPromptBlock(quoteCitations);
  const hasSelectedAttachmentSource = isTextLikeAttachmentSourceMode(
    paper.contentSourceMode,
  );
  const lines = [
    "Claim Evidence:",
    "",
    ...quoteAnchorGuidance,
    ...(quoteAnchorGuidance.length ? [""] : []),
    ...(hasSelectedAttachmentSource
      ? buildGenericSourceQuoteCitationGuidance()
      : buildPaperQuoteCitationGuidance()),
    hasSelectedAttachmentSource
      ? "The full paper or selected attachment source remains available in paper chat."
      : "The full paper remains available in paper chat.",
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

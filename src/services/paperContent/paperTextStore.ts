/**
 * The one owner of extracted paper text held in memory.
 *
 * Backed by the existing `pdfTextCache` and `pdfTextLoadingTasks` instances,
 * so code (and tests) that seed those maps directly keep working. Extraction
 * itself stays in `pdfContext.ts`: `load` and `loadNote` take the extractor,
 * which fills the entry through `write`.
 *
 * Reading and dropping text have distinct rules, so each rule is its own
 * named operation:
 * - `peek` reads whatever is cached and ignores source mode.
 * - `invalidate` is the full clean-up after the text changed.
 * - `invalidateMineruRuntimeText` is the MinerU clean-up, which never queues
 *   a re-index.
 * - `discardEmptyEntry` drops an entry without text so it can be retried.
 * - `borrow` lets a caller evict only what it loaded itself.
 */
import { appLogger } from "../../core/logging";
import type { PaperContentSourceMode } from "../../shared/types";
import { invalidateRetrievalCandidates } from "../retrieval/cacheInvalidation";
import { clearEmbeddingCache } from "../retrieval/embeddingCache";
import type { TextAttachmentSourceMode } from "./contextAttachmentTypes";
import {
  notifyPdfContextLoaded,
  pdfTextCache,
  pdfTextLoadingTasks,
} from "./contextCache";
import type { PdfContext } from "./types";

export type PaperTextLoadOptions = {
  sourceMode?: PaperContentSourceMode;
  preferFulltextCache?: boolean;
  /** Background index loads: fill the cache without firing the write-through hook. */
  silentLoad?: boolean;
};

/** Extracts one item's text and stores it with `paperTextStore.write`. */
export type PaperTextExtractor = (
  item: Zotero.Item,
  options?: PaperTextLoadOptions,
) => Promise<void>;

export function sourceTypeForTextAttachment(
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

function entryText(itemId: number): string {
  const cached = pdfTextCache.get(itemId);
  return Array.isArray(cached?.chunks) ? cached.chunks.join("\n\n") : "";
}

/**
 * Drops an entry another source mode produced. The reload changes the chunks,
 * so the retrieval candidates built from the old chunks go too. The on-disk
 * embeddings stay: their chunk-hash check invalidates them when the chunks
 * really changed. The in-progress load (if any) is left for its waiters.
 */
function dropMismatchedEntry(itemId: number): void {
  pdfTextCache.delete(itemId);
  invalidateRetrievalCandidates(itemId);
}

async function load(
  item: Zotero.Item,
  options: PaperTextLoadOptions | undefined,
  extract: PaperTextExtractor,
): Promise<void> {
  const cached = pdfTextCache.get(item.id);
  if (cached && cachedContextMatchesSourceMode(cached, options?.sourceMode)) {
    return;
  }
  if (cached) {
    dropMismatchedEntry(item.id);
  }
  const existingTask = pdfTextLoadingTasks.get(item.id);
  if (existingTask) {
    await existingTask;
    const latest = pdfTextCache.get(item.id);
    if (latest && cachedContextMatchesSourceMode(latest, options?.sourceMode)) {
      return;
    }
    if (latest) {
      dropMismatchedEntry(item.id);
    }
  }
  if (pdfTextCache.has(item.id)) {
    return;
  }
  const task = (async () => {
    try {
      await extract(item, options);
      // Fresh loads with text only; cache hits and waits on an existing task return before this.
      const loaded = pdfTextCache.get(item.id);
      if (loaded && loaded.chunks.length && !options?.silentLoad) {
        notifyPdfContextLoaded(item.id);
      }
    } finally {
      pdfTextLoadingTasks.delete(item.id);
    }
  })();
  pdfTextLoadingTasks.set(item.id, task);
  await task;
}

async function loadNote(
  item: Zotero.Item,
  extract: (item: Zotero.Item) => Promise<void>,
): Promise<void> {
  if (pdfTextCache.has(item.id)) return;
  const existingTask = pdfTextLoadingTasks.get(item.id);
  if (existingTask) {
    await existingTask;
    return;
  }
  const task = (async () => {
    try {
      await extract(item);
    } finally {
      pdfTextLoadingTasks.delete(item.id);
    }
  })();
  pdfTextLoadingTasks.set(item.id, task);
  await task;
}

function invalidate(itemId: number): void {
  if (!Number.isFinite(itemId) || itemId <= 0) return;
  const normalizedItemId = Math.floor(itemId);
  pdfTextCache.delete(normalizedItemId);
  pdfTextLoadingTasks.delete(normalizedItemId);
  // Cached candidates carry stale chunk text and scores after a MinerU refresh.
  invalidateRetrievalCandidates(normalizedItemId);
  // Re-index the new text. Lazy import: indexer.ts imports this module.
  void import("../libraryTextIndex/scheduler")
    .then(({ libraryTextIndexScheduler }) =>
      libraryTextIndexScheduler.enqueue([normalizedItemId], "textInvalidated"),
    )
    .catch((error) =>
      appLogger.debug("LLM index: re-index enqueue failed", error),
    );
  // Clear embedding cache — chunks will change when MinerU content is refreshed,
  // so cached embeddings are stale. Do NOT delete MinerU files themselves:
  // this is called right after writeMineruCacheFiles(), so deleting the
  // MinerU directory would destroy the freshly written content.
  void clearEmbeddingCache(normalizedItemId).catch((error) => {
    appLogger.warn("Embedding cache invalidation failed:", error);
  });
}

function invalidateMineruRuntimeText(attachmentId: number): void {
  pdfTextCache.delete(attachmentId);
  pdfTextLoadingTasks.delete(attachmentId);
  invalidateRetrievalCandidates(attachmentId);
  void clearEmbeddingCache(attachmentId).catch(() => {});
}

function discardEmptyEntry(itemId: number): void {
  if (!entryText(itemId).trim() && pdfTextCache.has(itemId)) {
    pdfTextCache.delete(itemId);
  }
}

function borrow(itemId: number): () => void {
  const hadEntry = pdfTextCache.has(itemId);
  return () => {
    if (!hadEntry) pdfTextCache.delete(itemId);
  };
}

export const paperTextStore = {
  /** The cached entry, whatever source mode produced it. */
  peek(itemId: number): PdfContext | undefined {
    return pdfTextCache.get(itemId);
  },
  has(itemId: number): boolean {
    return pdfTextCache.has(itemId);
  },
  /** True when text is cached or a load for it is in progress. */
  isCachedOrLoading(itemId: number): boolean {
    return pdfTextCache.has(itemId) || pdfTextLoadingTasks.has(itemId);
  },
  /** Stores an extractor's result. Only extractors call this. */
  write(itemId: number, context: PdfContext): void {
    pdfTextCache.set(itemId, context);
  },
  forEach(fn: (context: PdfContext, itemId: number) => void): void {
    pdfTextCache.forEach(fn);
  },
  /**
   * Ensures text for `item` is cached. A cached entry is reused only when it
   * matches `options.sourceMode`; a mismatched one is dropped and reloaded.
   * Concurrent callers share one in-progress load. Listeners hear only a
   * fresh, non-silent load that produced chunks.
   */
  load,
  /** Ensures note text is cached. Any cached entry is reused as is. */
  loadNote,
  /**
   * Full clean-up after an item's text changed: the entry, its in-progress
   * load, retrieval candidates, and the embedding cache, then a re-index.
   * Ignores ids that are not positive numbers and floors the rest.
   */
  invalidate,
  /**
   * MinerU runtime clean-up: the same steps as `invalidate` except that it
   * never queues a re-index.
   */
  invalidateMineruRuntimeText,
  /**
   * Drops an entry whose chunks hold no text, so the next load retries the
   * extraction. Leaves the in-progress load and every other cache alone.
   */
  discardEmptyEntry,
  /**
   * Marks the start of a load the caller may own. The returned release evicts
   * the entry only when it was not cached at borrow time, so a paper that
   * someone else loaded stays cached.
   */
  borrow,
  /** Drops every entry and every in-progress load (plugin shutdown). */
  clear(): void {
    pdfTextCache.clear();
    pdfTextLoadingTasks.clear();
  },
};

/**
 * Backfill page-index and page-label metadata into the in-memory PdfContext
 * cache for every Zotero item that already has a MinerU manifest on disk.
 *
 * ## Background
 *
 * When `llm-for-zotero` caches a PDF attachment's extracted text it now also
 * records `pageIndex` / `pageLabel` on each chunk (see `PdfChunkMeta`).  That
 * information comes from:
 * - MinerU manifests — `ManifestSection.page` for chunk-to-page mapping
 * - PDFWorker `pageChars` — character-offset-based page mapping
 *
 * Items that were cached *before* this feature landed have no page info.
 * This script walks every regular item, finds PDF attachments with an
 * existing MinerU manifest, and forces a re-cache so page metadata is
 * populated.
 *
 * ## Usage
 *
 * ```js
 * // In the Zotero JavaScript console (Tools → Developer → Run JavaScript):
 * const { backfillPageInfo } = ChromeUtils.import(
 *   "chrome://llm-for-zotero/content/agent/actions/backfillPageInfo.js"
 * );
 * backfillPageInfo({ dryRun: true }).then(console.log);
 * ```
 *
 * Or via the `zotero_script` agent tool:
 * ```
 * zotero_script({ mode: "read", script: `
 *   const mod = ChromeUtils.import("chrome://llm-for-zotero/content/agent/actions/backfillPageInfo.js");
 *   return mod.backfillPageInfo({ dryRun: false, limit: 50 });
 * `})
 * ```
 *
 * @module backfillPageInfo
 */

import { pdfTextCache } from "../../modules/contextPanel/state";
import {
  ensurePDFTextCached,
  invalidateCachedContextText,
} from "../../modules/contextPanel/pdfContext";
import {
  ensureManifest,
  getMineruItemDir,
} from "../../modules/contextPanel/mineruCache";

export type BackfillOptions = {
  /** Report what would be done without actually modifying the cache. */
  dryRun?: boolean;
  /** Maximum number of items to process (useful for testing). */
  limit?: number;
  /** Only process items in this collection (Zotero collection ID). */
  collectionId?: number;
  /** Only process a specific library (Zotero library ID). */
  libraryId?: number;
  /** If true, also process items cached from PDFWorker text (not just MinerU). */
  includeWorker?: boolean;
  /** Number of PDFs to process concurrently (default: 4). */
  concurrency?: number;
};

export type BackfillResult = {
  /** Total items inspected. */
  scanned: number;
  /** Items whose PdfContext was updated with page info. */
  updated: number;
  /** Items that already had page info (no-op). */
  alreadyOk: number;
  /** Items skipped (no MinerU manifest, no PDF, etc.). */
  skipped: number;
  /** Items that failed to process. */
  errors: number;
  /** Error messages (first 50). */
  errorMessages: string[];
  /** Whether this was a dry run. */
  dryRun: boolean;
  /** Duration in ms. */
  durationMs: number;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function isRegularItem(item: any): boolean {
  return typeof item?.isRegularItem === "function" && item.isRegularItem();
}

function isPdfAttachment(item: any): boolean {
  return (
    typeof item?.isAttachment === "function" &&
    item.isAttachment() &&
    item.attachmentContentType === "application/pdf"
  );
}

function getPdfChildAttachments(regularItem: any): any[] {
  if (!isRegularItem(regularItem)) return [];
  const out: any[] = [];
  try {
    const attachmentIds: number[] = regularItem.getAttachments?.() || [];
    for (const id of attachmentIds) {
      const att = Zotero.Items.get(id);
      if (att && isPdfAttachment(att)) out.push(att);
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * Check whether a MinerU cache directory exists on disk for the given
 * attachment item ID.
 */
function mineruCacheDirExists(attachmentId: number): boolean {
  try {
    const dir = getMineruItemDir(attachmentId);
    // Use Zotero's I/O to check existence.
    if (typeof (Zotero as any).IO?.exists === "function") {
      return !!(Zotero as any).IO.exists(dir);
    }
    // Fallback: assume MinerU is available; the main flow will verify.
    return true;
  } catch {
    return false;
  }
}

/**
 * Collect all regular-item IDs that have at least one PDF child attachment
 * with a MinerU cache directory on disk.
 */
async function collectCandidateItems(
  options: BackfillOptions,
): Promise<number[]> {
  const candidateIds: number[] = [];
  const limit =
    options.limit && options.limit > 0 ? Math.floor(options.limit) : Infinity;
  const libraryId = options.libraryId;

  // Scope to a single collection if requested.
  let items: any[];
  if (options.collectionId && options.collectionId > 0) {
    const collection = Zotero.Collections.get(options.collectionId);
    if (!collection) {
      throw new Error(`Collection not found: ${options.collectionId}`);
    }
    items = (collection as any).getChildItems?.() || [];
  } else {
    // Walk all items for the given library (defaults to the current library).
    const libId = libraryId ?? (Zotero.Libraries as any).userLibraryID ?? 1;
    items = await Zotero.Items.getAll(libId, false, false, false);
  }

  for (const item of items) {
    if (!item || item.deleted) continue;
    const itemId = typeof item === "number" ? item : (item as any).id;
    if (!itemId || !Number.isFinite(itemId)) continue;

    const resolved = typeof item === "number" ? Zotero.Items.get(itemId) : item;
    if (!resolved || !isRegularItem(resolved)) continue;
    if (candidateIds.length >= limit) break;

    const pdfs = getPdfChildAttachments(resolved);
    if (!pdfs.length) continue;

    // Check if any PDF attachment has a MinerU cache on disk.
    for (const pdf of pdfs) {
      if (mineruCacheDirExists(pdf.id)) {
        candidateIds.push(itemId as number);
        break;
      }
    }
  }

  return candidateIds;
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function backfillPageInfo(
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const startTime = Date.now();
  const result: BackfillResult = {
    scanned: 0,
    updated: 0,
    alreadyOk: 0,
    skipped: 0,
    errors: 0,
    errorMessages: [],
    dryRun: !!options.dryRun,
    durationMs: 0,
  };

  try {
    ztoolkit.log("[backfillPageInfo] START dryRun=" + result.dryRun);

    if (!Zotero?.Items) {
      result.errors = 1;
      result.errorMessages.push("Zotero.Items API is not available.");
      result.durationMs = Date.now() - startTime;
      ztoolkit.log("[backfillPageInfo] ABORT: no Zotero.Items");
      return result;
    }

    ztoolkit.log("[backfillPageInfo] collecting candidates...");
    let candidateIds: number[];
    try {
      candidateIds = await collectCandidateItems(options);
    } catch (err) {
      result.errors = 1;
      result.errorMessages.push(
        `Failed to collect candidates: ${err instanceof Error ? err.message : String(err)}`,
      );
      result.durationMs = Date.now() - startTime;
      ztoolkit.log(
        "[backfillPageInfo] FAIL collecting: " + result.errorMessages[0],
      );
      return result;
    }

    result.scanned = candidateIds.length;
    ztoolkit.log("[backfillPageInfo] candidates=" + candidateIds.length);

    const concurrency = Math.max(
      1,
      options.concurrency && options.concurrency > 0
        ? Math.floor(options.concurrency)
        : 4,
    );
    ztoolkit.log("[backfillPageInfo] concurrency=" + concurrency);

    const MAX_ERRORS = 50;

    type ItemOutcome = {
      updated: number;
      alreadyOk: number;
      skipped: number;
      error: string | null;
    };

    const processItem = async (itemId: number): Promise<ItemOutcome> => {
      try {
        const item = Zotero.Items.get(itemId);
        if (!item || !isRegularItem(item))
          return { updated: 0, alreadyOk: 0, skipped: 1, error: null };
        const pdfs = getPdfChildAttachments(item);
        if (!pdfs.length)
          return { updated: 0, alreadyOk: 0, skipped: 1, error: null };

        for (const pdf of pdfs) {
          try {
            let cached = pdfTextCache.get(pdf.id);
            if (
              cached &&
              cached.chunkMeta?.length > 0 &&
              cached.chunkMeta.some((m: any) => typeof m.pageIndex === "number")
            ) {
              return { updated: 0, alreadyOk: 1, skipped: 0, error: null };
            }

            const manifest = await ensureManifest(pdf.id);
            const manifestHasPageInfo =
              manifest &&
              !manifest.noSections &&
              manifest.sections?.length > 0 &&
              manifest.sections.some((s) => typeof s.page === "number");

            if (manifestHasPageInfo) {
              if (!options.dryRun) {
                invalidateCachedContextText(pdf.id);
                await ensurePDFTextCached(pdf, { sourceMode: "mineru" });
                cached = pdfTextCache.get(pdf.id);
              }
              const ok =
                !options.dryRun &&
                cached &&
                cached.chunkMeta?.length > 0 &&
                cached.chunkMeta.some(
                  (m: any) => typeof m.pageIndex === "number",
                );
              if (ok || options.dryRun)
                return { updated: 1, alreadyOk: 0, skipped: 0, error: null };
              return { updated: 0, alreadyOk: 0, skipped: 1, error: null };
            }

            // PDFWorker fallback
            if (!options.dryRun) {
              invalidateCachedContextText(pdf.id);
              await ensurePDFTextCached(pdf, { sourceMode: "text" });
              cached = pdfTextCache.get(pdf.id);
            }
            const ok =
              !options.dryRun &&
              cached &&
              cached.chunkMeta?.length > 0 &&
              cached.chunkMeta.some(
                (m: any) => typeof m.pageIndex === "number",
              );
            if (ok || options.dryRun)
              return { updated: 1, alreadyOk: 0, skipped: 0, error: null };
            return { updated: 0, alreadyOk: 0, skipped: 1, error: null };
          } catch (err) {
            return {
              updated: 0,
              alreadyOk: 0,
              skipped: 0,
              error: `Item ${itemId} attachment ${pdf.id}: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }
        return { updated: 0, alreadyOk: 0, skipped: 1, error: null };
      } catch (err) {
        return {
          updated: 0,
          alreadyOk: 0,
          skipped: 0,
          error: `Item ${itemId}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    };

    // Process in concurrent batches, collecting outcomes without shared mutable state.
    const outcomes: ItemOutcome[] = [];
    for (let i = 0; i < candidateIds.length; i += concurrency) {
      const batch = candidateIds.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((id) => processItem(id)),
      );
      outcomes.push(...batchResults);
    }

    // Aggregate outcomes into the result.
    for (const o of outcomes) {
      result.updated += o.updated;
      result.alreadyOk += o.alreadyOk;
      result.skipped += o.skipped;
      if (o.error && result.errors < MAX_ERRORS) {
        result.errorMessages.push(o.error);
        result.errors += 1;
      }
    }
  } catch (err) {
    // Top-level safety net — should never be reached since inner code
    // has its own error handling, but guarantees we always return a result.
    result.errors = 1;
    result.errorMessages.push(
      `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  result.durationMs = Date.now() - startTime;
  ztoolkit.log(
    "[backfillPageInfo] DONE scanned=" +
      result.scanned +
      " updated=" +
      result.updated +
      " alreadyOk=" +
      result.alreadyOk +
      " skipped=" +
      result.skipped +
      " errors=" +
      result.errors +
      " duration=" +
      result.durationMs +
      "ms",
  );
  return result;
}

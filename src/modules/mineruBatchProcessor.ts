import {
  parsePdfWithMineru,
  MineruRateLimitError,
  MineruCancelledError,
} from "../utils/mineruClient";
import {
  writeMineruCacheFiles,
  writeMineruSourceProvenanceForAttachment,
  invalidateMineruMd,
  getMineruCacheDir,
} from "./contextPanel/mineruCache";
import { invalidateCachedContextText } from "./contextPanel/pdfContext";
import {
  setItemProcessing,
  setItemCached,
  setItemFailed,
} from "./mineruProcessingStatus";
import {
  getMineruAvailabilityForAttachment,
  publishMineruCachePackageForAttachment,
  type MineruAvailabilityStatus,
} from "./contextPanel/mineruSync";
import { normalizeMineruTagName } from "./mineruTagIndex";
import {
  getMineruParseEligibility,
  type MineruParseExclusionReason,
} from "./mineruParseEligibility";
import {
  buildMineruFilenameMatcher,
  type MineruFilenameMatcher,
} from "../utils/mineruConfig";

// ── Types ────────────────────────────────────────────────────────────────────

export type MineruBatchState = {
  running: boolean;
  paused: boolean;
  currentItemId: number | null;
  currentItemTitle: string;
  statusMessage: string;
  processedCount: number;
  totalCount: number;
  error: string | null;
  rateLimited: boolean;
  /** ID of the last item that failed processing (null if last item succeeded) */
  lastFailedItemId: number | null;
  /** Human-readable reason for the most recent failure (persists across items) */
  lastFailedMessage: string | null;
  /** Number of items that failed during the current batch run */
  failedCount: number;
};

type QueueEntry = {
  parentItemId: number;
  attachmentId: number;
  title: string;
};

// ── Singleton state ──────────────────────────────────────────────────────────

let state: MineruBatchState = {
  running: false,
  paused: false,
  currentItemId: null,
  currentItemTitle: "",
  statusMessage: "",
  processedCount: 0,
  totalCount: 0,
  error: null,
  rateLimited: false,
  lastFailedItemId: null,
  lastFailedMessage: null,
  failedCount: 0,
};

let queue: QueueEntry[] = [];
let queueBuilt = false;
const listeners = new Set<(s: MineruBatchState) => void>();
let currentAbort: AbortController | null = null;

function getAbortControllerCtor(): (new () => AbortController) | null {
  return (
    (ztoolkit.getGlobal("AbortController") as
      | (new () => AbortController)
      | undefined) ||
    (
      globalThis as typeof globalThis & {
        AbortController?: new () => AbortController;
      }
    ).AbortController ||
    null
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function snapshot(): MineruBatchState {
  return { ...state };
}

function notify(): void {
  const s = snapshot();
  for (const fn of listeners) {
    try {
      fn(s);
    } catch {
      /* ignore */
    }
  }
}

function getPdfAttachments(item: Zotero.Item): Zotero.Item[] {
  const out: Zotero.Item[] = [];
  if (!item?.isRegularItem?.()) return out;
  for (const attId of item.getAttachments()) {
    const att = Zotero.Items.get(attId);
    if (
      att?.isAttachment?.() &&
      att.attachmentContentType === "application/pdf"
    ) {
      out.push(att);
    }
  }
  return out;
}

function isPdfAttachment(item: Zotero.Item | null | undefined): boolean {
  return Boolean(
    item?.isAttachment?.() && item.attachmentContentType === "application/pdf",
  );
}

function getParentItemForPdf(pdfAtt: Zotero.Item): Zotero.Item | null {
  const parentId = Number(pdfAtt.parentID);
  if (!Number.isFinite(parentId) || parentId <= 0) return null;
  const parentItem = Zotero.Items.get(Math.floor(parentId));
  return parentItem?.isRegularItem?.() ? parentItem : null;
}

type ZoteroTagLike = string | { tag?: unknown; name?: unknown; type?: unknown };

function getItemTagNames(item: Zotero.Item | null | undefined): {
  manual: string[];
  automatic: string[];
} {
  const manual = new Set<string>();
  const automatic = new Set<string>();
  try {
    const tags = (
      item as { getTags?: () => ZoteroTagLike[] } | null
    )?.getTags?.();
    if (!Array.isArray(tags)) return { manual: [], automatic: [] };
    for (const raw of tags) {
      const rawName =
        typeof raw === "string" ? raw : (raw?.tag ?? raw?.name ?? "");
      const name = normalizeMineruTagName(rawName);
      if (!name) continue;
      const type = typeof raw === "string" ? undefined : Number(raw.type);
      if (type === 1) automatic.add(name);
      else manual.add(name);
    }
  } catch {
    /* ignore */
  }
  return {
    manual: [...manual].sort((a, b) => a.localeCompare(b)),
    automatic: [...automatic].sort((a, b) => a.localeCompare(b)),
  };
}

function getCandidateTagNames(
  parentItem: Zotero.Item | null,
  pdfAtt: Zotero.Item,
): { manual: string[]; automatic: string[] } {
  const parentTags = getItemTagNames(parentItem);
  if (parentTags.manual.length > 0 || parentTags.automatic.length > 0) {
    return parentTags;
  }
  return getItemTagNames(pdfAtt);
}

type MineruPdfCandidate = {
  parentItem: Zotero.Item | null;
  pdfAtt: Zotero.Item;
  siblingPdfs: Zotero.Item[];
};

function collectMineruPdfCandidates(
  allItems: Zotero.Item[],
): MineruPdfCandidate[] {
  const candidates: MineruPdfCandidate[] = [];
  const seenAttachmentIds = new Set<number>();
  const addCandidate = (
    parentItem: Zotero.Item | null,
    pdfAtt: Zotero.Item,
    siblingPdfs?: Zotero.Item[],
  ) => {
    if (seenAttachmentIds.has(pdfAtt.id)) return;
    seenAttachmentIds.add(pdfAtt.id);
    candidates.push({
      parentItem,
      pdfAtt,
      siblingPdfs: siblingPdfs?.length ? siblingPdfs : [pdfAtt],
    });
  };

  for (const item of allItems) {
    if (item.isRegularItem?.()) {
      const pdfs = getPdfAttachments(item);
      for (const pdfAtt of pdfs) {
        addCandidate(item, pdfAtt, pdfs);
      }
      continue;
    }

    if (isPdfAttachment(item)) {
      const parentItem = getParentItemForPdf(item);
      addCandidate(
        parentItem,
        item,
        parentItem ? getPdfAttachments(parentItem) : [item],
      );
    }
  }

  return candidates;
}

function getPdfAttachmentDisplayTitle(pdfAtt: Zotero.Item): string {
  return (
    pdfAtt.getField?.("title") ||
    (pdfAtt as unknown as { attachmentFilename?: string }).attachmentFilename ||
    `PDF ${pdfAtt.id}`
  );
}

// ── Queue building ───────────────────────────────────────────────────────────

async function buildQueue(): Promise<void> {
  const libraryID = Zotero.Libraries.userLibraryID;
  const allItems: Zotero.Item[] = await Zotero.Items.getAll(
    libraryID,
    true,
    false,
    false,
  );

  const candidates = collectMineruPdfCandidates(allItems);

  // Sort newest-first by dateAdded
  candidates.sort((a, b) => {
    const da =
      a.parentItem?.getField("dateAdded") ||
      a.pdfAtt.getField("dateAdded") ||
      "";
    const db =
      b.parentItem?.getField("dateAdded") ||
      b.pdfAtt.getField("dateAdded") ||
      "";
    return db > da ? 1 : db < da ? -1 : 0;
  });

  // Build queue — skip items already cached or excluded by parse filters
  queue = [];
  let processed = 0;
  let totalEligible = 0;
  const filenameMatcher = buildMineruFilenameMatcher();
  for (const { parentItem, pdfAtt, siblingPdfs } of candidates) {
    const eligibility = await getMineruParseEligibility(parentItem, pdfAtt, {
      filenameMatcher,
    });
    if (eligibility.excluded) continue;
    totalEligible++;
    const availability = await getMineruAvailabilityForAttachment(pdfAtt, {
      validateSyncedPackage: false,
    });
    const cached = availability.status !== "missing";
    const parentTitle =
      parentItem?.getField("title") ||
      getPdfAttachmentDisplayTitle(pdfAtt) ||
      `PDF ${pdfAtt.id}`;
    const title =
      siblingPdfs.length > 1
        ? `${parentTitle} [${getPdfAttachmentDisplayTitle(pdfAtt)}]`
        : parentTitle;
    if (cached) {
      processed++;
    } else {
      queue.push({
        parentItemId: parentItem?.id || pdfAtt.id,
        attachmentId: pdfAtt.id,
        title,
      });
    }
  }

  state.totalCount = totalEligible;
  state.processedCount = processed;
  queueBuilt = true;
  notify();
}

// ── Processing loop ──────────────────────────────────────────────────────────

async function processNext(): Promise<void> {
  if (state.paused || queue.length === 0) {
    state.running = false;
    state.currentItemId = null;
    state.currentItemTitle = "";
    currentAbort = null;
    notify();
    return;
  }

  const entry = queue.shift()!;
  state.currentItemId = entry.attachmentId;
  state.currentItemTitle = entry.title;
  state.statusMessage = `Starting: ${entry.title}`;
  state.error = null;
  notify();

  setItemProcessing(entry.attachmentId);

  // Create an AbortController for this item so pause/stop can cancel it
  const AbortCtor = getAbortControllerCtor();
  const abort = AbortCtor ? new AbortCtor() : null;
  currentAbort = abort;

  try {
    const pdfItem = Zotero.Items.get(entry.attachmentId);
    if (!pdfItem) {
      ztoolkit.log(
        `MinerU batch: item ${entry.attachmentId} not found, skipping`,
      );
      setItemFailed(entry.attachmentId, "Item not found");
      scheduleNext();
      return;
    }

    const pdfPath = await (
      pdfItem as unknown as { getFilePathAsync?: () => Promise<string | false> }
    ).getFilePathAsync?.();

    if (!pdfPath) {
      ztoolkit.log(
        `MinerU batch: no file path for ${entry.attachmentId}, skipping`,
      );
      setItemFailed(entry.attachmentId, "No file path");
      scheduleNext();
      return;
    }

    const result = await parsePdfWithMineru(
      pdfPath as string,
      (stage) => {
        state.statusMessage = stage;
        notify();
      },
      abort?.signal,
    );
    if (result?.mdContent) {
      await writeMineruCacheFiles(
        entry.attachmentId,
        result.mdContent,
        result.files,
      );
      await writeMineruSourceProvenanceForAttachment(pdfItem);
      setItemCached(entry.attachmentId);
      void publishMineruCachePackageForAttachment(entry.attachmentId).then(
        (published) => {
          if (published.status === "error") {
            ztoolkit.log("LLM: MinerU sync package publish failed", published);
          }
        },
      );
      // Flush stale in-memory text cache and disk embedding cache so the
      // next query picks up MinerU-quality chunks and re-generates embeddings.
      invalidateCachedContextText(entry.attachmentId);
      state.processedCount++;
      state.lastFailedItemId = null;
    } else {
      const failReason = state.statusMessage || "No content returned";
      ztoolkit.log(
        `MinerU batch: no content returned for "${entry.title}", skipping`,
      );
      setItemFailed(entry.attachmentId, failReason);
      state.lastFailedItemId = entry.attachmentId;
      state.lastFailedMessage = failReason;
      state.failedCount++;
    }
  } catch (e) {
    if (e instanceof MineruCancelledError) {
      ztoolkit.log(`MinerU batch: cancelled "${entry.title}"`);
      setItemFailed(entry.attachmentId, "Cancelled");
      // Put the item back so it can be retried on resume
      queue.unshift(entry);
      state.running = false;
      state.currentItemId = null;
      state.currentItemTitle = "";
      state.statusMessage = "Paused";
      // Signal the UI that this item did NOT succeed — prevents green dot
      state.lastFailedItemId = entry.attachmentId;
      state.lastFailedMessage = "Cancelled";
      currentAbort = null;
      notify();
      return;
    }
    if (e instanceof MineruRateLimitError) {
      state.rateLimited = true;
      state.paused = true;
      state.running = false;
      state.error = e.message || "Daily limit reached. Resume tomorrow.";
      setItemFailed(entry.attachmentId, e.message || "Rate limited");
      state.lastFailedItemId = entry.attachmentId;
      state.lastFailedMessage = e.message || "Daily limit reached";
      state.failedCount++;
      state.currentItemId = null;
      state.currentItemTitle = "";
      // Put entry back at front so it retries next time
      queue.unshift(entry);
      currentAbort = null;
      notify();
      return;
    }
    const errMsg = (e as Error).message || String(e);
    ztoolkit.log(`MinerU batch: error processing "${entry.title}":`, e);
    setItemFailed(entry.attachmentId, errMsg);
    state.lastFailedItemId = entry.attachmentId;
    state.lastFailedMessage = errMsg;
    state.failedCount++;
  }

  currentAbort = null;
  scheduleNext();
}

function scheduleNext(): void {
  state.currentItemId = null;
  state.currentItemTitle = "";
  state.statusMessage = "";
  notify();
  setTimeout(() => void processNext(), 500);
}

// ── Public API ───────────────────────────────────────────────────────────────

export function getMineruBatchState(): MineruBatchState {
  return snapshot();
}

export async function startBatchProcessing(): Promise<void> {
  if (state.running) return;

  state.paused = false;
  state.rateLimited = false;
  state.error = null;
  state.running = true;
  state.failedCount = 0;
  state.lastFailedMessage = null;
  state.lastFailedItemId = null;
  notify();

  if (!queueBuilt) {
    await buildQueue();
  }

  if (queue.length === 0) {
    state.running = false;
    notify();
    return;
  }

  void processNext();
}

/**
 * Process only the given attachment IDs (manual selection).
 */
export async function processSelectedItems(
  attachmentIds: number[],
  options: {
    filenameMatcher?: MineruFilenameMatcher;
    overrideEligibility?: boolean;
  } = {},
): Promise<void> {
  if (state.running) return;
  if (attachmentIds.length === 0) return;

  // Build a queue from the selected IDs. Manager-confirmed selections can
  // override parse filters; bulk/filter actions should keep them.
  queue = [];
  const filenameMatcher =
    options.filenameMatcher || buildMineruFilenameMatcher();
  for (const attId of attachmentIds) {
    const pdfItem = Zotero.Items.get(attId);
    if (!pdfItem) continue;
    const parentId = pdfItem.parentID;
    const parentItem = parentId ? Zotero.Items.get(parentId) : null;
    const eligibility = await getMineruParseEligibility(parentItem, pdfItem, {
      filenameMatcher,
    });
    if (eligibility.excluded && !options.overrideEligibility) continue;
    const title = parentItem?.getField?.("title") || `Item ${attId}`;
    queue.push({ parentItemId: parentId || attId, attachmentId: attId, title });
  }

  state.paused = false;
  state.rateLimited = false;
  state.error = null;
  state.running = true;
  state.totalCount = queue.length;
  state.processedCount = 0;
  state.failedCount = 0;
  state.lastFailedMessage = null;
  state.lastFailedItemId = null;
  notify();

  void processNext();
}

export function pauseBatchProcessing(): void {
  state.paused = true;
  // Abort the in-flight operation so pause takes effect immediately
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
  }
  notify();
}

export async function resetBatchQueue(): Promise<void> {
  state.paused = true;
  state.running = false;
  state.currentItemId = null;
  state.currentItemTitle = "";
  state.error = null;
  state.rateLimited = false;
  queueBuilt = false;
  queue = [];
  notify();

  // Rebuild queue to get fresh counts
  await buildQueue();
}

export async function deleteAllMineruCache(): Promise<void> {
  pauseBatchProcessing();

  const cacheDir = getMineruCacheDir();
  const IOUtils = (
    globalThis as unknown as {
      IOUtils?: {
        remove?: (
          p: string,
          opts?: { recursive?: boolean; ignoreAbsent?: boolean },
        ) => Promise<void>;
      };
    }
  ).IOUtils;
  if (IOUtils?.remove) {
    try {
      await IOUtils.remove(cacheDir, { recursive: true, ignoreAbsent: true });
    } catch {
      /* ignore */
    }
  }

  await resetBatchQueue();
}

export async function deleteMineruCacheForItem(itemId: number): Promise<void> {
  await invalidateMineruMd(itemId);
  // If queue is built, we need to re-add this item to the queue
  // Simplest approach: reset and rebuild
  if (queueBuilt) {
    const wasRunning = state.running;
    queueBuilt = false;
    await buildQueue();
    // Don't auto-resume if it was running — let the user restart
    if (wasRunning && !state.paused) {
      state.running = false;
      notify();
    }
  }
}

export function onBatchStateChange(
  listener: (s: MineruBatchState) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export type MineruItemEntry = {
  parentItemId: number;
  attachmentId: number;
  title: string;
  pdfTitle: string;
  firstCreator: string;
  year: string;
  dateAdded: string;
  cached: boolean;
  localCached: boolean;
  syncedPackage: boolean;
  availability: MineruAvailabilityStatus;
  excluded: boolean;
  exclusionReason: MineruParseExclusionReason | null;
  exclusionLabel: string;
  pageCount: number | null;
  collectionIds: number[];
  tags: string[];
  tagsAuto: string[];
};

export type MineruParentGroup = {
  parentItemId: number;
  title: string;
  firstCreator: string;
  year: string;
  dateAdded: string;
  collectionIds: number[];
  children: MineruItemEntry[];
};

export function groupByParent(items: MineruItemEntry[]): MineruParentGroup[] {
  const map = new Map<number, MineruParentGroup>();
  for (const item of items) {
    let group = map.get(item.parentItemId);
    if (!group) {
      group = {
        parentItemId: item.parentItemId,
        title: item.title,
        firstCreator: item.firstCreator,
        year: item.year,
        dateAdded: item.dateAdded,
        collectionIds: item.collectionIds,
        children: [],
      };
      map.set(item.parentItemId, group);
    }
    group.children.push(item);
  }
  return [...map.values()];
}

export type MineruCollectionNode = {
  collectionId: number;
  name: string;
  parentId: number;
  children: MineruCollectionNode[];
};

/**
 * Returns the full list of library items with PDF attachments and their
 * MinerU cache status. Used by the manager window to render the items list.
 */
export async function getMineruItemList(): Promise<MineruItemEntry[]> {
  const libraryID = Zotero.Libraries.userLibraryID;
  const allItems: Zotero.Item[] = await Zotero.Items.getAll(
    libraryID,
    true,
    false,
    false,
  );

  const results: MineruItemEntry[] = [];
  const filenameMatcher = buildMineruFilenameMatcher();

  for (const { parentItem, pdfAtt } of collectMineruPdfCandidates(allItems)) {
    try {
      let collectionIds: number[] = [];
      try {
        collectionIds = ((parentItem || pdfAtt).getCollections?.() || [])
          .map((id: unknown) => Number(id))
          .filter((id: number) => Number.isFinite(id) && id > 0);
      } catch {
        /* ignore */
      }
      let parentTitle = parentItem
        ? `Item ${parentItem.id}`
        : getPdfAttachmentDisplayTitle(pdfAtt);
      let firstCreator = "";
      let year = "";
      let dateAdded = "";
      try {
        parentTitle =
          parentItem?.getField("title") ||
          getPdfAttachmentDisplayTitle(pdfAtt) ||
          parentTitle;
      } catch {
        /* ignore */
      }
      try {
        firstCreator = parentItem?.getField("firstCreator") || "";
      } catch {
        /* ignore */
      }
      try {
        year = parentItem?.getField("year") || "";
      } catch {
        /* ignore */
      }
      try {
        dateAdded =
          parentItem?.getField("dateAdded") ||
          pdfAtt.getField("dateAdded") ||
          "";
      } catch {
        /* ignore */
      }
      const availability = await getMineruAvailabilityForAttachment(pdfAtt, {
        validateSyncedPackage: false,
      });
      const cached = availability.status !== "missing";
      const pdfTitle = getPdfAttachmentDisplayTitle(pdfAtt);
      // Keep manager opening cheap. Page-count checks read PDF bytes, so they
      // are deferred to enqueue/processing paths instead of every row load.
      const eligibility = await getMineruParseEligibility(parentItem, pdfAtt, {
        filenameMatcher,
        inspectPageCount: false,
      });
      const tagNames = getCandidateTagNames(parentItem, pdfAtt);
      results.push({
        parentItemId: parentItem?.id || pdfAtt.id,
        attachmentId: pdfAtt.id,
        title: parentTitle,
        pdfTitle,
        firstCreator,
        year,
        dateAdded,
        cached,
        localCached: availability.localCached,
        syncedPackage: availability.syncedPackage,
        availability: availability.status,
        excluded: eligibility.excluded,
        exclusionReason: eligibility.primaryReason,
        exclusionLabel: eligibility.reasonLabel,
        pageCount: eligibility.pageCount,
        collectionIds,
        tags: tagNames.manual,
        tagsAuto: tagNames.automatic,
      });
    } catch (err) {
      ztoolkit.log("LLM MinerU: Failed to process item", pdfAtt?.id, err);
    }
  }

  // Sort newest-first
  results.sort((a, b) =>
    b.dateAdded > a.dateAdded ? 1 : b.dateAdded < a.dateAdded ? -1 : 0,
  );

  return results;
}

/**
 * Returns the collection tree for the user library.
 */
export function getLibraryCollectionTree(): MineruCollectionNode[] {
  const libraryID = Zotero.Libraries.userLibraryID;
  let collections: Zotero.Collection[];
  try {
    collections = Zotero.Collections.getByLibrary(libraryID, true) || [];
  } catch {
    return [];
  }

  const byId = new Map<number, MineruCollectionNode>();
  for (const col of collections) {
    byId.set(col.id, {
      collectionId: col.id,
      name: col.name || `Collection ${col.id}`,
      parentId:
        Number.isFinite(Number(col.parentID)) && Number(col.parentID) > 0
          ? Math.floor(Number(col.parentID))
          : 0,
      children: [],
    });
  }

  const roots: MineruCollectionNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId > 0 && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort children alphabetically
  const sortChildren = (nodes: MineruCollectionNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) sortChildren(n.children);
  };
  sortChildren(roots);

  return roots;
}

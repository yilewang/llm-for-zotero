import { config } from "../../package.json";
import { getMineruApiKey } from "../utils/mineruConfig";
import {
  parsePdfWithMineruCloud,
  MineruRateLimitError,
  MineruCancelledError,
} from "../utils/mineruClient";
import {
  hasCachedMineruMd,
  writeMineruCacheFiles,
} from "./contextPanel/mineruCache";

// ── Types ────────────────────────────────────────────────────────────────────

type QueueEntry = {
  attachmentId: number;
  title: string;
  parentItemId?: number;
};

type ProgressListener = (status: AutoWatchStatus) => void;

type AutoWatchStatus = {
  isProcessing: boolean;
  currentItem: string;
  queueLength: number;
  lastCompleted?: string;
  lastError?: string;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 3000;

// ── State ────────────────────────────────────────────────────────────────────

let notifierId: string | null = null;
let processingQueue: QueueEntry[] = [];
let isProcessing = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let currentAbort: AbortController | null = null;
let currentItemTitle = "";
const progressListeners = new Set<ProgressListener>();

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

// ── Progress Notifications ───────────────────────────────────────────────────

function notifyProgress(): void {
  const status: AutoWatchStatus = {
    isProcessing,
    currentItem: currentItemTitle,
    queueLength: processingQueue.length,
  };
  for (const listener of progressListeners) {
    try {
      listener(status);
    } catch {
      /* ignore */
    }
  }
}

export function onAutoWatchProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

function showNotification(title: string, message: string): void {
  try {
    const progressWindow = new (
      Zotero as unknown as {
        ProgressWindow: new () => {
          changeHeadline: (text: string) => void;
          addDescription: (text: string) => void;
          show: () => void;
          close: () => void;
        };
      }
    ).ProgressWindow();
    progressWindow.changeHeadline(title);
    progressWindow.addDescription(message);
    progressWindow.show();
    // Auto-close after 3 seconds
    setTimeout(() => progressWindow.close(), 3000);
  } catch (err) {
    ztoolkit.log("MinerU auto-watch: failed to show notification", err);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Check if an item is a PDF attachment
 */
function isPdfAttachment(item: Zotero.Item): boolean {
  return (
    item?.isAttachment?.() && item.attachmentContentType === "application/pdf"
  );
}

/**
 * Check if an item belongs to a watched collection (directly or via ancestor)
 */
async function isItemInWatchedCollection(
  item: Zotero.Item,
  watchedIds: Set<number>,
): Promise<boolean> {
  // Get all collection IDs this item belongs to
  let collectionIds: number[] = [];
  try {
    collectionIds = (item.getCollections?.() || [])
      .map((id: unknown) => Number(id))
      .filter((id: number) => Number.isFinite(id) && id > 0);
  } catch {
    /* ignore */
  }

  // For attachments, also check parent item's collections
  if (isPdfAttachment(item) && item.parentID) {
    try {
      const parentItem = Zotero.Items.get(item.parentID);
      if (parentItem) {
        const parentCollections = (parentItem.getCollections?.() || [])
          .map((id: unknown) => Number(id))
          .filter((id: number) => Number.isFinite(id) && id > 0);
        collectionIds.push(...parentCollections);
      }
    } catch {
      /* ignore */
    }
  }

  collectionIds = [...new Set(collectionIds)];

  // Check each collection and its ancestors
  for (const colId of collectionIds) {
    if (watchedIds.has(colId)) return true;
    // Walk up the tree
    let currentId = colId;
    while (currentId > 0) {
      const col = Zotero.Collections.get(currentId);
      if (!col) break;
      const parentId = Number(col.parentID);
      if (!Number.isFinite(parentId) || parentId <= 0) break;
      if (watchedIds.has(parentId)) return true;
      currentId = parentId;
    }
  }

  return false;
}

// ── Configuration (from mineruConfig.ts) ─────────────────────────────────────

const MINERU_AUTO_WATCH_KEY = `${config.prefsPrefix}.mineruAutoWatchCollections`;

function getAutoWatchCollectionIds(): Set<number> {
  const value = Zotero.Prefs.get(MINERU_AUTO_WATCH_KEY, true);
  const str = typeof value === "string" ? value : "";
  if (!str) return new Set();
  const ids = str
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((id) => Number.isFinite(id) && id > 0);
  return new Set(ids);
}

function setAutoWatchCollectionIds(ids: Set<number>): void {
  const str = Array.from(ids).join(",");
  Zotero.Prefs.set(MINERU_AUTO_WATCH_KEY, str, true);
}

export function addAutoWatchCollection(collectionId: number): void {
  const ids = getAutoWatchCollectionIds();
  ids.add(collectionId);
  setAutoWatchCollectionIds(ids);
}

export function removeAutoWatchCollection(collectionId: number): void {
  const ids = getAutoWatchCollectionIds();
  ids.delete(collectionId);
  setAutoWatchCollectionIds(ids);
}

export function isAutoWatchCollection(collectionId: number): boolean {
  return getAutoWatchCollectionIds().has(collectionId);
}

export { getAutoWatchCollectionIds };

// ── Queue Processing ─────────────────────────────────────────────────────────

async function processQueue(): Promise<void> {
  if (isProcessing || processingQueue.length === 0) return;

  isProcessing = true;
  notifyProgress();

  const apiKey = getMineruApiKey();
  let processedCount = 0;
  let errorCount = 0;

  while (processingQueue.length > 0) {
    const entry = processingQueue.shift()!;
    currentItemTitle = entry.title;
    notifyProgress();

    // Skip if already cached
    if (await hasCachedMineruMd(entry.attachmentId)) {
      ztoolkit.log(
        `MinerU auto-watch: skipping cached item ${entry.attachmentId}`,
      );
      continue;
    }

    // Create abort controller for this item
    const AbortCtor = getAbortControllerCtor();
    const abort = AbortCtor ? new AbortCtor() : null;
    currentAbort = abort;

    try {
      const pdfItem = Zotero.Items.get(entry.attachmentId);
      if (!pdfItem) {
        ztoolkit.log(`MinerU auto-watch: item ${entry.attachmentId} not found`);
        continue;
      }

      const pdfPath = await (
        pdfItem as unknown as {
          getFilePathAsync?: () => Promise<string | false>;
        }
      ).getFilePathAsync?.();

      if (!pdfPath) {
        ztoolkit.log(
          `MinerU auto-watch: no file path for ${entry.attachmentId}`,
        );
        continue;
      }

      ztoolkit.log(`MinerU auto-watch: processing ${entry.title}`);
      const result = await parsePdfWithMineruCloud(
        pdfPath as string,
        apiKey,
        undefined,
        abort?.signal,
      );

      if (result?.mdContent) {
        await writeMineruCacheFiles(
          entry.attachmentId,
          result.mdContent,
          result.files,
        );
        processedCount++;
        ztoolkit.log(`MinerU auto-watch: cached ${entry.title}`);
      } else {
        errorCount++;
        ztoolkit.log(`MinerU auto-watch: no content for ${entry.title}`);
      }
    } catch (e) {
      errorCount++;
      if (e instanceof MineruCancelledError) {
        ztoolkit.log(`MinerU auto-watch: cancelled ${entry.title}`);
        processingQueue.unshift(entry);
        break;
      }
      if (e instanceof MineruRateLimitError) {
        ztoolkit.log(
          `MinerU auto-watch: rate limited - ${(e as Error).message}`,
        );
        processingQueue.unshift(entry);
        showNotification(
          "MinerU Auto-Parse Paused",
          "Daily quota reached. Resume tomorrow.",
        );
        break;
      }
      ztoolkit.log(`MinerU auto-watch: error processing ${entry.title}:`, e);
    }
  }

  currentAbort = null;
  currentItemTitle = "";
  isProcessing = false;
  notifyProgress();

  // Show completion notification
  if (processedCount > 0) {
    showNotification(
      "MinerU Auto-Parse Complete",
      `Successfully parsed ${processedCount} PDF${processedCount > 1 ? "s" : ""}.`,
    );
  } else if (errorCount > 0 && processingQueue.length === 0) {
    showNotification(
      "MinerU Auto-Parse",
      `${errorCount} PDF${errorCount > 1 ? "s" : ""} could not be parsed.`,
    );
  }
}

function enqueueForProcessing(
  attachmentId: number,
  title: string,
  parentItemId?: number,
): void {
  if (processingQueue.some((e) => e.attachmentId === attachmentId)) return;
  processingQueue.push({ attachmentId, title, parentItemId });
  notifyProgress();

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void processQueue();
  }, DEBOUNCE_MS);
}

// ── Notifier Handler ─────────────────────────────────────────────────────────

async function handleItemNotification(
  event: string,
  type: string,
  ids: Array<string | number>,
): Promise<void> {
  if (event !== "add" || type !== "item") return;

  const watchedIds = getAutoWatchCollectionIds();
  if (watchedIds.size === 0) return;

  ztoolkit.log(`MinerU auto-watch: handling ${ids.length} added item(s)`);

  for (const id of ids) {
    const itemId = typeof id === "string" ? parseInt(id, 10) : id;
    if (!Number.isFinite(itemId)) continue;

    const item = Zotero.Items.get(itemId);
    if (!item) continue;

    ztoolkit.log(
      `MinerU auto-watch: checking item ${itemId} (type: ${item.itemType})`,
    );

    // Check if item is in a watched collection
    const shouldProcess = await isItemInWatchedCollection(item, watchedIds);
    if (!shouldProcess) {
      ztoolkit.log(
        `MinerU auto-watch: item ${itemId} not in watched collection`,
      );
      continue;
    }

    ztoolkit.log(`MinerU auto-watch: item ${itemId} is in watched collection`);

    // Case 1: Regular item with PDF attachments
    if (item.isRegularItem?.()) {
      const pdfs = getPdfAttachments(item);
      ztoolkit.log(`MinerU auto-watch: found ${pdfs.length} PDF attachment(s)`);
      for (const pdf of pdfs) {
        if (await hasCachedMineruMd(pdf.id)) {
          ztoolkit.log(`MinerU auto-watch: PDF ${pdf.id} already cached`);
          continue;
        }
        const title = item.getField?.("title") || `Item ${pdf.id}`;
        ztoolkit.log(`MinerU auto-watch: enqueuing ${title}`);
        enqueueForProcessing(pdf.id, title, item.id);
      }
    }
    // Case 2: Standalone PDF attachment
    else if (isPdfAttachment(item)) {
      if (await hasCachedMineruMd(item.id)) {
        ztoolkit.log(`MinerU auto-watch: PDF ${item.id} already cached`);
        continue;
      }
      const parentItem = item.parentID ? Zotero.Items.get(item.parentID) : null;
      const title =
        parentItem?.getField?.("title") ||
        item.getField?.("title") ||
        `PDF ${item.id}`;
      ztoolkit.log(`MinerU auto-watch: enqueuing standalone PDF ${title}`);
      enqueueForProcessing(item.id, title, item.parentID || undefined);
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function startAutoWatch(): void {
  if (notifierId) return;

  try {
    const notifier = (
      Zotero as unknown as {
        Notifier?: {
          registerObserver?: (
            observer: {
              notify: (
                event: string,
                type: string,
                ids: unknown[],
                extraData: Record<string, unknown>,
              ) => void;
            },
            types: string[],
            id?: string,
          ) => string;
          unregisterObserver?: (id: string) => void;
        };
      }
    ).Notifier;

    if (notifier?.registerObserver) {
      notifierId = notifier.registerObserver(
        {
          notify(
            event: string,
            type: string,
            ids: unknown[],
            _extraData: Record<string, unknown>,
          ) {
            void handleItemNotification(
              event,
              type,
              ids as Array<string | number>,
            );
          },
        },
        ["item"],
        "mineruAutoWatch",
      );
      ztoolkit.log("MinerU auto-watch: started");
    }
  } catch (err) {
    ztoolkit.log("MinerU auto-watch: failed to start", err);
  }
}

export function stopAutoWatch(): void {
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
  }

  processingQueue = [];
  isProcessing = false;
  currentItemTitle = "";

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  if (notifierId) {
    try {
      const notifier = (
        Zotero as unknown as {
          Notifier?: { unregisterObserver?: (id: string) => void };
        }
      ).Notifier;
      notifier?.unregisterObserver?.(notifierId);
    } catch {
      /* ignore */
    }
    notifierId = null;
  }

  progressListeners.clear();
  ztoolkit.log("MinerU auto-watch: stopped");
}

export function getAutoWatchStatus(): AutoWatchStatus {
  return {
    isProcessing,
    currentItem: currentItemTitle,
    queueLength: processingQueue.length,
  };
}

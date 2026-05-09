import { config } from "../../package.json";
import {
  isGlobalAutoParseEnabled,
  isFilenameExcluded,
} from "../utils/mineruConfig";
import {
  parsePdfWithMineru,
  MineruRateLimitError,
  MineruCancelledError,
} from "../utils/mineruClient";
import {
  writeMineruCacheFiles,
  writeMineruSourceProvenanceForAttachment,
} from "./contextPanel/mineruCache";
import { invalidateCachedContextText } from "./contextPanel/pdfContext";
import {
  setItemProcessing,
  setItemCached,
  setItemFailed,
  clearItemStatus,
} from "./mineruProcessingStatus";
import {
  getMineruAvailabilityForAttachment,
  publishMineruCachePackageForAttachment,
} from "./contextPanel/mineruSync";

type QueueEntry = {
  attachmentId: number;
  title: string;
  parentItemId?: number;
};

type ProgressListener = (status: AutoWatchStatus) => void;

type AutoWatchStatus = {
  isProcessing: boolean;
  isPaused: boolean;
  currentItem: string;
  queueLength: number;
  lastCompleted?: string;
  lastError?: string;
};

const DEBOUNCE_MS = 3000;

let notifierId: string | null = null;
let processingQueue: QueueEntry[] = [];
let isProcessing = false;
let isPaused = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let currentAbort: AbortController | null = null;
let currentItemTitle = "";
let currentAttachmentId: number | null = null;
const staleAbortAttachmentIds = new Set<number>();
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

function notifyProgress(): void {
  const status: AutoWatchStatus = {
    isProcessing,
    isPaused,
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
    setTimeout(() => progressWindow.close(), 3000);
  } catch (err) {
    ztoolkit.log("MinerU auto-parse: failed to show notification", err);
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

function isPdfAttachment(item: Zotero.Item): boolean {
  return (
    item?.isAttachment?.() && item.attachmentContentType === "application/pdf"
  );
}

function normalizeNotifierId(id: string | number): number | null {
  const itemId = typeof id === "string" ? parseInt(id, 10) : id;
  return Number.isFinite(itemId) ? itemId : null;
}

function getValidatedQueueItem(entry: QueueEntry): Zotero.Item | null {
  const item = Zotero.Items.get(entry.attachmentId);
  if (!item || !isPdfAttachment(item)) return null;

  const itemParentId = Number(item.parentID);
  const normalizedItemParentId =
    Number.isFinite(itemParentId) && itemParentId > 0
      ? Math.floor(itemParentId)
      : null;

  if (entry.parentItemId && normalizedItemParentId !== entry.parentItemId) {
    return null;
  }

  if (normalizedItemParentId) {
    const parentItem = Zotero.Items.get(normalizedItemParentId);
    const attachmentIds = parentItem?.getAttachments?.() || [];
    if (!attachmentIds.includes(entry.attachmentId)) return null;
  }

  return item;
}

function discardStaleEntry(entry: QueueEntry, reason: string): void {
  clearItemStatus(entry.attachmentId);
  ztoolkit.log(
    `MinerU auto-parse: skipping stale PDF ${entry.attachmentId} (${reason})`,
  );
}

function removeDeletedAttachmentsFromQueue(ids: number[]): void {
  const deletedIds = new Set(ids);
  const previousLength = processingQueue.length;
  processingQueue = processingQueue.filter(
    (entry) => !deletedIds.has(entry.attachmentId),
  );

  for (const id of deletedIds) {
    clearItemStatus(id);
  }

  if (previousLength !== processingQueue.length) {
    ztoolkit.log(
      `MinerU auto-parse: removed ${
        previousLength - processingQueue.length
      } deleted PDF(s) from queue`,
    );
  }

  if (currentAttachmentId !== null && deletedIds.has(currentAttachmentId)) {
    staleAbortAttachmentIds.add(currentAttachmentId);
    if (currentAbort) {
      currentAbort.abort();
      currentAbort = null;
    }
    ztoolkit.log(
      `MinerU auto-parse: cancelled deleted PDF ${currentAttachmentId}`,
    );
  }

  notifyProgress();
}

async function processQueue(): Promise<void> {
  if (isProcessing || isPaused || processingQueue.length === 0) return;

  isProcessing = true;
  isPaused = false;
  notifyProgress();

  let processedCount = 0;
  let errorCount = 0;

  while (processingQueue.length > 0) {
    if (isPaused) {
      break;
    }
    const entry = processingQueue.shift()!;
    currentItemTitle = entry.title;
    notifyProgress();

    const entryItem = getValidatedQueueItem(entry);
    if (!entryItem) {
      discardStaleEntry(entry, "attachment no longer current");
      continue;
    }

    if (
      (
        await getMineruAvailabilityForAttachment(entryItem, {
          validateSyncedPackage: false,
        })
      ).status !== "missing"
    ) {
      ztoolkit.log(
        `MinerU auto-parse: skipping available item ${entry.attachmentId}`,
      );
      continue;
    }

    setItemProcessing(entry.attachmentId);

    const AbortCtor = getAbortControllerCtor();
    const abort = AbortCtor ? new AbortCtor() : null;
    currentAbort = abort;
    currentAttachmentId = entry.attachmentId;

    try {
      const pdfItem = getValidatedQueueItem(entry);
      if (!pdfItem) {
        discardStaleEntry(entry, "attachment changed before parse");
        continue;
      }

      const pdfPath = await (
        pdfItem as unknown as {
          getFilePathAsync?: () => Promise<string | false>;
        }
      ).getFilePathAsync?.();

      if (!pdfPath) {
        ztoolkit.log(
          `MinerU auto-parse: no file path for ${entry.attachmentId}`,
        );
        setItemFailed(entry.attachmentId, "No file path");
        continue;
      }

      ztoolkit.log(`MinerU auto-parse: processing ${entry.title}`);
      const result = await parsePdfWithMineru(
        pdfPath as string,
        undefined,
        abort?.signal,
      );

      if (result?.mdContent) {
        if (!getValidatedQueueItem(entry)) {
          discardStaleEntry(entry, "attachment changed before cache write");
          continue;
        }

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
              ztoolkit.log(
                "LLM: MinerU sync package publish failed",
                published,
              );
            }
          },
        );
        // Flush stale in-memory text cache and disk embedding cache so the
        // next query picks up MinerU-quality chunks and re-generates embeddings.
        invalidateCachedContextText(entry.attachmentId);
        processedCount++;
        ztoolkit.log(`MinerU auto-parse: cached ${entry.title}`);
      } else {
        errorCount++;
        setItemFailed(entry.attachmentId, "No content returned");
        ztoolkit.log(`MinerU auto-parse: no content for ${entry.title}`);
      }
    } catch (e) {
      if (e instanceof MineruCancelledError) {
        if (staleAbortAttachmentIds.has(entry.attachmentId)) {
          staleAbortAttachmentIds.delete(entry.attachmentId);
          discardStaleEntry(entry, "attachment deleted while parsing");
          continue;
        }
        errorCount++;
        ztoolkit.log(`MinerU auto-parse: cancelled ${entry.title}`);
        setItemFailed(entry.attachmentId, "Cancelled");
        processingQueue.unshift(entry);
        break;
      }
      if (e instanceof MineruRateLimitError) {
        errorCount++;
        ztoolkit.log(
          `MinerU auto-parse: rate limited - ${(e as Error).message}`,
        );
        setItemFailed(entry.attachmentId, "Rate limited");
        processingQueue.unshift(entry);
        showNotification(
          "MinerU Auto-Parse Paused",
          "Daily quota reached. Resume tomorrow.",
        );
        break;
      }
      errorCount++;
      const errorMsg = (e as Error).message || String(e);
      setItemFailed(entry.attachmentId, errorMsg);
      ztoolkit.log(`MinerU auto-parse: error processing ${entry.title}:`, e);
    } finally {
      if (currentAttachmentId === entry.attachmentId) {
        currentAttachmentId = null;
        currentAbort = null;
      }
      staleAbortAttachmentIds.delete(entry.attachmentId);
    }
  }

  currentAbort = null;
  currentAttachmentId = null;
  currentItemTitle = "";
  isProcessing = false;
  notifyProgress();

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

async function handleItemNotification(
  event: string,
  type: string,
  ids: Array<string | number>,
): Promise<void> {
  if (type !== "item") return;

  const itemIds = ids
    .map(normalizeNotifierId)
    .filter((id): id is number => id !== null);

  if (event === "delete") {
    removeDeletedAttachmentsFromQueue(itemIds);
    return;
  }

  if (event !== "add") return;

  if (!isGlobalAutoParseEnabled()) return;

  ztoolkit.log(`MinerU auto-parse: handling ${itemIds.length} added item(s)`);

  for (const itemId of itemIds) {
    const item = Zotero.Items.get(itemId);
    if (!item) continue;

    ztoolkit.log(
      `MinerU auto-parse: checking item ${itemId} (type: ${item.itemType})`,
    );

    if (item.isRegularItem?.()) {
      const pdfs = getPdfAttachments(item);
      ztoolkit.log(`MinerU auto-parse: found ${pdfs.length} PDF attachment(s)`);
      for (const pdf of pdfs) {
        const pdfFilename =
          (pdf as unknown as { attachmentFilename?: string })
            .attachmentFilename || "";
        if (isFilenameExcluded(pdfFilename)) {
          ztoolkit.log(
            `MinerU auto-parse: PDF ${pdf.id} excluded by filename pattern`,
          );
          continue;
        }
        if (
          (
            await getMineruAvailabilityForAttachment(pdf, {
              validateSyncedPackage: false,
            })
          ).status !== "missing"
        ) {
          ztoolkit.log(`MinerU auto-parse: PDF ${pdf.id} already available`);
          continue;
        }
        const title = item.getField?.("title") || `Item ${pdf.id}`;
        ztoolkit.log(`MinerU auto-parse: enqueuing ${title}`);
        enqueueForProcessing(pdf.id, title, item.id);
      }
    } else if (isPdfAttachment(item)) {
      const pdfFilename =
        (item as unknown as { attachmentFilename?: string })
          .attachmentFilename || "";
      if (isFilenameExcluded(pdfFilename)) {
        ztoolkit.log(
          `MinerU auto-parse: PDF ${item.id} excluded by filename pattern`,
        );
        continue;
      }
      if (
        (
          await getMineruAvailabilityForAttachment(item, {
            validateSyncedPackage: false,
          })
        ).status !== "missing"
      ) {
        ztoolkit.log(`MinerU auto-parse: PDF ${item.id} already available`);
        continue;
      }
      const parentItem = item.parentID ? Zotero.Items.get(item.parentID) : null;
      const title =
        parentItem?.getField?.("title") ||
        item.getField?.("title") ||
        `PDF ${item.id}`;
      ztoolkit.log(`MinerU auto-parse: enqueuing standalone PDF ${title}`);
      enqueueForProcessing(item.id, title, item.parentID || undefined);
    }
  }
}

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
      ztoolkit.log("MinerU auto-parse: started");
    }
  } catch (err) {
    ztoolkit.log("MinerU auto-parse: failed to start", err);
  }
}

export function pauseAutoWatch(): void {
  if (!isProcessing || isPaused) return;
  isPaused = true;
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
  }
  notifyProgress();
  ztoolkit.log("MinerU auto-parse: paused");
}

export function resumeAutoWatch(): void {
  if (!isPaused) return;
  isPaused = false;
  notifyProgress();
  if (processingQueue.length > 0) {
    void processQueue();
  }
  ztoolkit.log("MinerU auto-parse: resumed");
}

export function stopAutoWatch(): void {
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
  }

  processingQueue = [];
  isProcessing = false;
  isPaused = false;
  currentItemTitle = "";
  currentAttachmentId = null;
  staleAbortAttachmentIds.clear();

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
  ztoolkit.log("MinerU auto-parse: stopped");
}

export function getAutoWatchStatus(): AutoWatchStatus {
  return {
    isProcessing,
    isPaused,
    currentItem: currentItemTitle,
    queueLength: processingQueue.length,
  };
}

export async function handleAutoWatchNotificationForTests(
  event: string,
  type: string,
  ids: Array<string | number>,
): Promise<void> {
  await handleItemNotification(event, type, ids);
}

export async function processAutoWatchQueueForTests(): Promise<void> {
  await processQueue();
}

export function getAutoWatchQueueSnapshotForTests(): QueueEntry[] {
  return processingQueue.map((entry) => ({ ...entry }));
}

export function isAutoWatchQueueEntryCurrentForTests(
  entry: QueueEntry,
): boolean {
  return Boolean(getValidatedQueueItem(entry));
}

export function resetAutoWatchForTests(): void {
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
  }

  processingQueue = [];
  isProcessing = false;
  isPaused = false;
  currentItemTitle = "";
  currentAttachmentId = null;
  staleAbortAttachmentIds.clear();

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  progressListeners.clear();
}

import { config } from "../../package.json";
import { getMineruApiKey, isGlobalAutoParseEnabled } from "../utils/mineruConfig";
import {
  parsePdfWithMineruCloud,
  MineruRateLimitError,
  MineruCancelledError,
} from "../utils/mineruClient";
import {
  hasCachedMineruMd,
  writeMineruCacheFiles,
} from "./contextPanel/mineruCache";
import {
  setItemProcessing,
  setItemCached,
  setItemFailed,
} from "./mineruProcessingStatus";

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

const DEBOUNCE_MS = 3000;

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

    if (await hasCachedMineruMd(entry.attachmentId)) {
      ztoolkit.log(
        `MinerU auto-parse: skipping cached item ${entry.attachmentId}`,
      );
      continue;
    }

    setItemProcessing(entry.attachmentId);

    const AbortCtor = getAbortControllerCtor();
    const abort = AbortCtor ? new AbortCtor() : null;
    currentAbort = abort;

    try {
      const pdfItem = Zotero.Items.get(entry.attachmentId);
      if (!pdfItem) {
        ztoolkit.log(`MinerU auto-parse: item ${entry.attachmentId} not found`);
        setItemFailed(entry.attachmentId, "Item not found");
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
        setItemCached(entry.attachmentId);
        processedCount++;
        ztoolkit.log(`MinerU auto-parse: cached ${entry.title}`);
      } else {
        errorCount++;
        setItemFailed(entry.attachmentId, "No content returned");
        ztoolkit.log(`MinerU auto-parse: no content for ${entry.title}`);
      }
    } catch (e) {
      errorCount++;
      if (e instanceof MineruCancelledError) {
        ztoolkit.log(`MinerU auto-parse: cancelled ${entry.title}`);
        setItemFailed(entry.attachmentId, "Cancelled");
        processingQueue.unshift(entry);
        break;
      }
      if (e instanceof MineruRateLimitError) {
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
      const errorMsg = (e as Error).message || String(e);
      setItemFailed(entry.attachmentId, errorMsg);
      ztoolkit.log(`MinerU auto-parse: error processing ${entry.title}:`, e);
    }
  }

  currentAbort = null;
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
  if (event !== "add" || type !== "item") return;

  if (!isGlobalAutoParseEnabled()) return;

  ztoolkit.log(`MinerU auto-parse: handling ${ids.length} added item(s)`);

  for (const id of ids) {
    const itemId = typeof id === "string" ? parseInt(id, 10) : id;
    if (!Number.isFinite(itemId)) continue;

    const item = Zotero.Items.get(itemId);
    if (!item) continue;

    ztoolkit.log(
      `MinerU auto-parse: checking item ${itemId} (type: ${item.itemType})`,
    );

    if (item.isRegularItem?.()) {
      const pdfs = getPdfAttachments(item);
      ztoolkit.log(`MinerU auto-parse: found ${pdfs.length} PDF attachment(s)`);
      for (const pdf of pdfs) {
        if (await hasCachedMineruMd(pdf.id)) {
          ztoolkit.log(`MinerU auto-parse: PDF ${pdf.id} already cached`);
          continue;
        }
        const title = item.getField?.("title") || `Item ${pdf.id}`;
        ztoolkit.log(`MinerU auto-parse: enqueuing ${title}`);
        enqueueForProcessing(pdf.id, title, item.id);
      }
    }
    else if (isPdfAttachment(item)) {
      if (await hasCachedMineruMd(item.id)) {
        ztoolkit.log(`MinerU auto-parse: PDF ${item.id} already cached`);
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
  ztoolkit.log("MinerU auto-parse: stopped");
}

export function getAutoWatchStatus(): AutoWatchStatus {
  return {
    isProcessing,
    currentItem: currentItemTitle,
    queueLength: processingQueue.length,
  };
}

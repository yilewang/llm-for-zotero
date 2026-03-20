import { getMineruApiKey } from "../utils/mineruConfig";
import {
  parsePdfWithMineruCloud,
  MineruRateLimitError,
} from "../utils/mineruClient";
import {
  hasCachedMineruMd,
  writeMineruCacheFiles,
  invalidateMineruMd,
  getMineruCacheDir,
} from "./contextPanel/mineruCache";

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
};

let queue: QueueEntry[] = [];
let queueBuilt = false;
const listeners = new Set<(s: MineruBatchState) => void>();

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
    if (att?.isAttachment?.() && att.attachmentContentType === "application/pdf") {
      out.push(att);
    }
  }
  return out;
}

// ── Queue building ───────────────────────────────────────────────────────────

async function buildQueue(): Promise<void> {
  const libraryID = Zotero.Libraries.userLibraryID;
  const allItems: Zotero.Item[] = await Zotero.Items.getAll(libraryID, true, false, false);

  // Filter to regular items — include ALL PDF attachments per item
  const candidates: { item: Zotero.Item; pdfAtt: Zotero.Item }[] = [];
  for (const item of allItems) {
    if (!item.isRegularItem?.()) continue;
    const pdfs = getPdfAttachments(item);
    for (const pdfAtt of pdfs) {
      candidates.push({ item, pdfAtt });
    }
  }

  // Sort newest-first by dateAdded
  candidates.sort((a, b) => {
    const da = a.item.getField("dateAdded") || "";
    const db = b.item.getField("dateAdded") || "";
    return db > da ? 1 : db < da ? -1 : 0;
  });

  // Build queue — skip items already cached
  queue = [];
  let processed = 0;
  for (const { item, pdfAtt } of candidates) {
    const cached = await hasCachedMineruMd(pdfAtt.id);
    const parentTitle = item.getField("title") || `Item ${item.id}`;
    // Count PDFs for this parent to decide whether to show attachment name
    const siblingPdfs = getPdfAttachments(item);
    const title = siblingPdfs.length > 1
      ? `${parentTitle} [${pdfAtt.getField?.("title") || `PDF ${pdfAtt.id}`}]`
      : parentTitle;
    if (cached) {
      processed++;
    } else {
      queue.push({
        parentItemId: item.id,
        attachmentId: pdfAtt.id,
        title,
      });
    }
  }

  state.totalCount = candidates.length;
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
    notify();
    return;
  }

  const entry = queue.shift()!;
  state.currentItemId = entry.attachmentId;
  state.currentItemTitle = entry.title;
  state.statusMessage = `Starting: ${entry.title}`;
  state.error = null;
  notify();

  try {
    const pdfItem = Zotero.Items.get(entry.attachmentId);
    if (!pdfItem) {
      ztoolkit.log(`MinerU batch: item ${entry.attachmentId} not found, skipping`);
      scheduleNext();
      return;
    }

    const pdfPath = await (
      pdfItem as unknown as { getFilePathAsync?: () => Promise<string | false> }
    ).getFilePathAsync?.();

    if (!pdfPath) {
      ztoolkit.log(`MinerU batch: no file path for ${entry.attachmentId}, skipping`);
      scheduleNext();
      return;
    }

    const apiKey = getMineruApiKey();
    if (!apiKey) {
      state.running = false;
      state.paused = true;
      state.error = "No API key configured";
      state.currentItemId = null;
      state.currentItemTitle = "";
      state.statusMessage = "";
      // Put entry back
      queue.unshift(entry);
      notify();
      return;
    }

    const result = await parsePdfWithMineruCloud(pdfPath as string, apiKey, (stage) => {
      state.statusMessage = stage;
      notify();
    });
    if (result?.mdContent) {
      await writeMineruCacheFiles(entry.attachmentId, result.mdContent, result.files);
      state.processedCount++;
    } else {
      ztoolkit.log(`MinerU batch: no content returned for "${entry.title}", skipping`);
    }
  } catch (e) {
    if (e instanceof MineruRateLimitError) {
      state.rateLimited = true;
      state.paused = true;
      state.running = false;
      state.error = e.message || "Daily limit reached. Resume tomorrow.";
      state.currentItemId = null;
      state.currentItemTitle = "";
      // Put entry back at front so it retries next time
      queue.unshift(entry);
      notify();
      return;
    }
    ztoolkit.log(`MinerU batch: error processing "${entry.title}":`, e);
  }

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
): Promise<void> {
  if (state.running) return;
  if (attachmentIds.length === 0) return;

  // Build a queue from the selected IDs
  queue = [];
  for (const attId of attachmentIds) {
    const pdfItem = Zotero.Items.get(attId);
    if (!pdfItem) continue;
    const parentId = pdfItem.parentID;
    const parentItem = parentId ? Zotero.Items.get(parentId) : null;
    const title = parentItem?.getField?.("title") || `Item ${attId}`;
    queue.push({ parentItemId: parentId || attId, attachmentId: attId, title });
  }

  state.paused = false;
  state.rateLimited = false;
  state.error = null;
  state.running = true;
  state.totalCount = queue.length;
  state.processedCount = 0;
  notify();

  void processNext();
}

export function pauseBatchProcessing(): void {
  state.paused = true;
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
  const IOUtils = (globalThis as unknown as {
    IOUtils?: { remove?: (p: string, opts?: { recursive?: boolean; ignoreAbsent?: boolean }) => Promise<void> };
  }).IOUtils;
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
  firstCreator: string;
  year: string;
  dateAdded: string;
  cached: boolean;
  collectionIds: number[];
};

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
  const allItems: Zotero.Item[] = await Zotero.Items.getAll(libraryID, true, false, false);

  const results: MineruItemEntry[] = [];

  for (const item of allItems) {
    if (!item.isRegularItem?.()) continue;
    const pdfs = getPdfAttachments(item);
    if (pdfs.length === 0) continue;
    let collectionIds: number[] = [];
    try {
      collectionIds = (item.getCollections?.() || [])
        .map((id: unknown) => Number(id))
        .filter((id: number) => Number.isFinite(id) && id > 0);
    } catch { /* ignore */ }
    const parentTitle = item.getField("title") || `Item ${item.id}`;
    const firstCreator = item.getField("firstCreator") || "";
    const year = item.getField("year") || "";
    const dateAdded = item.getField("dateAdded") || "";
    for (const pdfAtt of pdfs) {
      const cached = await hasCachedMineruMd(pdfAtt.id);
      const title = pdfs.length > 1
        ? `${parentTitle} [${pdfAtt.getField?.("title") || `PDF ${pdfAtt.id}`}]`
        : parentTitle;
      results.push({
        parentItemId: item.id,
        attachmentId: pdfAtt.id,
        title,
        firstCreator,
        year,
        dateAdded,
        cached,
        collectionIds,
      });
    }
  }

  // Sort newest-first
  results.sort((a, b) => (b.dateAdded > a.dateAdded ? 1 : b.dateAdded < a.dateAdded ? -1 : 0));

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
      parentId: Number.isFinite(Number(col.parentID)) && Number(col.parentID) > 0
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

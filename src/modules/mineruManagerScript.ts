import {
  getMineruBatchState,
  getMineruItemList,
  getLibraryCollectionTree,
  startBatchProcessing,
  pauseBatchProcessing,
  processSelectedItems,
  deleteAllMineruCache,
  deleteMineruCacheForItem,
  onBatchStateChange,
  groupByParent,
} from "./mineruBatchProcessor";
import { t } from "../utils/i18n";
import type {
  MineruBatchState,
  MineruItemEntry,
  MineruCollectionNode,
  MineruParentGroup,
} from "./mineruBatchProcessor";
import { getMineruItemDir } from "./contextPanel/mineruCache";
import {
  getMineruStatus,
  onProcessingStatusChange,
  type MineruStatus,
} from "./mineruProcessingStatus";
import {
  getAutoWatchStatus,
  pauseAutoWatch,
  resumeAutoWatch,
  onAutoWatchProgress,
} from "./mineruAutoWatch";
import {
  getMineruAvailabilityForAttachmentId,
  repairMineruCaches,
  type MineruCacheRepairResult,
} from "./contextPanel/mineruSync";

/** Show a confirm dialog with a custom title using ztoolkit.Dialog. */
async function confirmDialog(message: string): Promise<boolean> {
  const dialogData: { [key: string]: unknown } = {
    loadCallback: () => {
      return;
    },
    unloadCallback: () => {
      return;
    },
  };
  new ztoolkit.Dialog(1, 1)
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      properties: { innerHTML: message },
      styles: { width: "320px", lineHeight: "1.45" },
    })
    .addButton("OK", "ok")
    .addButton("Cancel", "cancel")
    .setDialogData(dialogData)
    .open(t("Delete confirmation"));
  await (dialogData as { unloadLock: { promise: Promise<void> } }).unloadLock
    .promise;
  return (dialogData as { _lastButtonId?: string })._lastButtonId === "ok";
}

function fmtDate(d: string): string {
  if (!d) return "";
  try {
    const o = new Date(d);
    return `${o.getFullYear()}-${String(o.getMonth() + 1).padStart(2, "0")}-${String(o.getDate()).padStart(2, "0")}`;
  } catch {
    return d.slice(0, 10);
  }
}

type SortKey = "cached" | "title" | "firstCreator" | "year" | "dateAdded";
type SortDir = "asc" | "desc";
type ResizableColumnKey = "firstCreator" | "year" | "dateAdded";
type ResizeBoundary =
  | "title|firstCreator"
  | "firstCreator|year"
  | "year|dateAdded";
type ResizeHandlePlacement = {
  boundary: ResizeBoundary;
  side: "left" | "right";
};

const DOT_COLUMN_WIDTH = 8;
const CHECKBOX_SPACER_WIDTH = 13;
const TITLE_CONTENT_OFFSET = 4;
const DEFAULT_COLUMN_WIDTHS: Record<ResizableColumnKey, number> = {
  firstCreator: 110,
  year: 40,
  dateAdded: 72,
};
const MIN_COLUMN_WIDTHS = {
  title: 140,
  firstCreator: 80,
  year: 34,
  dateAdded: 64,
} as const;
const MINERU_STATUS_DOT_COLORS: Record<MineruStatus, string> = {
  cached: "#10b981",
  processing: "#f59e0b",
  failed: "#ef4444",
  idle: "#d1d5db",
};

export type MineruParentStatusChild = Pick<
  MineruItemEntry,
  "availability" | "excluded"
> & {
  status: MineruStatus;
};

export function getMineruParentDisplayStatus(
  children: readonly MineruParentStatusChild[],
): MineruStatus {
  const actionableChildren = children.filter((child) => !child.excluded);
  if (!actionableChildren.length) return "idle";

  if (actionableChildren.some((child) => child.status === "processing")) {
    return "processing";
  }
  if (actionableChildren.some((child) => child.status === "failed")) {
    return "failed";
  }
  if (
    actionableChildren.every(
      (child) => child.status === "cached" || child.availability !== "missing",
    )
  ) {
    return "cached";
  }
  return "idle";
}

export async function registerMineruManagerScript(
  win: Window,
  idPrefix = "llmforzotero",
): Promise<void> {
  const doc = win.document;
  const $ = (suffix: string) =>
    doc.getElementById(`${idPrefix}-mineru-mgr-${suffix}`);

  const progressEl = $("progress") as HTMLProgressElement | null;
  const progressLabel = $("progress-label") as HTMLSpanElement | null;
  const statusEl = $("status") as HTMLDivElement | null;
  const startBtn = $("start-btn") as HTMLButtonElement | null;
  const repairBtn = $("repair-btn") as HTMLButtonElement | null;
  const deleteBtn = $("delete-btn") as HTMLButtonElement | null;
  const errorSpan = $("error") as HTMLSpanElement | null;
  const sidebar = $("sidebar") as HTMLDivElement | null;
  const colHeaders = $("col-headers") as HTMLDivElement | null;
  const itemsList = $("items-list") as HTMLDivElement | null;
  const contextMenu = $("context-menu") as HTMLDivElement | null;
  const ctxProcessBtn = $("ctx-process") as HTMLDivElement | null;
  const ctxShowFolderBtn = $("ctx-show-folder") as HTMLDivElement | null;
  const ctxDeleteBtn = $("ctx-delete") as HTMLDivElement | null;
  const contextMenuId = `${idPrefix}-mineru-mgr-context-menu`;

  if (!sidebar || !itemsList) return;

  // ── Data ───────────────────────────────────────────────────────────────────
  let allItems: MineruItemEntry[] = [];
  let collectionTree: MineruCollectionNode[] = [];
  const directItemsMap = new Map<number, Set<number>>();
  const recursiveItemsMap = new Map<number, Set<number>>();

  // ── UI state ───────────────────────────────────────────────────────────────
  let activeCollectionId: number | "all" | "unfiled" = "all";
  let contextMenuItemId: number | null = null;
  const dotElements = new Map<number, HTMLSpanElement>();
  let localTotalCount = 0;
  let localProcessedCount = 0;
  const collapsedSidebar = new Set<number>();
  let isRepairing = false;

  // Sorting
  let sortKey: SortKey = "dateAdded";
  let sortDir: SortDir = "desc";
  const columnWidths: Record<ResizableColumnKey, number> = {
    ...DEFAULT_COLUMN_WIDTHS,
  };
  let stopActiveResize: (() => void) | null = null;

  // Tree view collapse state
  const collapsedParents = new Set<number>();

  // Multi-selection (shift/cmd+click)
  const selectedIds = new Set<number>();
  let lastClickedId: number | null = null; // for shift-range
  // Keep an ordered list of visible items for shift-range
  let visibleItemsOrdered: MineruItemEntry[] = [];

  // ── Helpers ────────────────────────────────────────────────────────────────
  function updateProgressBar(): void {
    if (progressEl) {
      progressEl.max = localTotalCount || 1;
      progressEl.value = localProcessedCount;
    }
    if (progressLabel) {
      progressLabel.textContent = `${localProcessedCount} / ${localTotalCount}`;
    }
  }

  function formatRepairSummary(result: MineruCacheRepairResult): string {
    return `Checked ${result.checked} PDFs. Restored ${result.restored}. Removed: ${result.removedOrphanCaches} orphan caches, ${result.removedOrphanSyncPackages} orphan sync packages. Failed ${result.failed}.`;
  }

  function isMineruAvailable(item: MineruItemEntry): boolean {
    return item.availability !== "missing";
  }

  function getAvailabilityDisplayStatus(item: MineruItemEntry): MineruStatus {
    return isMineruAvailable(item) ? "cached" : "idle";
  }

  function setDotDisplayStatus(
    dot: HTMLSpanElement,
    status: MineruStatus,
  ): void {
    dot.style.background = MINERU_STATUS_DOT_COLORS[status];
  }

  function getAvailabilityTooltip(item: MineruItemEntry): string {
    if (item.availability === "synced") {
      return t(
        "Synced MinerU package available; local cache will restore when needed.",
      );
    }
    if (item.availability === "both") {
      return t("Local MinerU cache and synced package available.");
    }
    if (item.availability === "local") {
      return t("Local MinerU cache available.");
    }
    return t("No MinerU cache available.");
  }

  async function refreshEntryAvailability(attachmentId: number): Promise<void> {
    const entry = allItems.find((i) => i.attachmentId === attachmentId);
    if (!entry) return;
    const availability = await getMineruAvailabilityForAttachmentId(
      attachmentId,
      {
        validateSyncedPackage: false,
      },
    );
    entry.localCached = availability.localCached;
    entry.syncedPackage = availability.syncedPackage;
    entry.availability = availability.status;
    entry.cached = availability.status !== "missing";
    const dot = dotElements.get(attachmentId);
    if (dot) {
      setDotDisplayStatus(dot, await getMineruStatus(attachmentId));
      dot.title = getAvailabilityTooltip(entry);
    }
    void updateParentDotForAttachment(attachmentId);
  }

  function getVisibleItems(): MineruItemEntry[] {
    let items: MineruItemEntry[];
    if (activeCollectionId === "all") items = allItems;
    else if (activeCollectionId === "unfiled")
      items = allItems.filter((i) => i.collectionIds.length === 0);
    else {
      const ids = recursiveItemsMap.get(activeCollectionId as number);
      items = ids ? allItems.filter((i) => ids.has(i.attachmentId)) : [];
    }
    // Sort
    const copy = [...items];
    const dir = sortDir === "asc" ? 1 : -1;
    copy.sort((a, b) => {
      if (sortKey === "cached") {
        const va = isMineruAvailable(a) ? 1 : 0;
        const vb = isMineruAvailable(b) ? 1 : 0;
        return (va - vb) * dir;
      }
      const va = a[sortKey] || "";
      const vb = b[sortKey] || "";
      return va < vb ? -dir : va > vb ? dir : 0;
    });
    return copy;
  }

  function getVisibleGroups(): MineruParentGroup[] {
    const items = getVisibleItems();
    const groups = groupByParent(items);
    const dir = sortDir === "asc" ? 1 : -1;
    groups.sort((a, b) => {
      if (sortKey === "cached") {
        const va = a.children.every(isMineruAvailable) ? 1 : 0;
        const vb = b.children.every(isMineruAvailable) ? 1 : 0;
        return (va - vb) * dir;
      }
      const va = (a[sortKey as keyof MineruParentGroup] as string) || "";
      const vb = (b[sortKey as keyof MineruParentGroup] as string) || "";
      return va < vb ? -dir : va > vb ? dir : 0;
    });
    return groups;
  }

  function isSubfolder(): boolean {
    return activeCollectionId !== "all" && activeCollectionId !== "unfiled";
  }

  function getFolderItemIds(): number[] {
    if (activeCollectionId === "unfiled")
      return allItems
        .filter((i) => i.collectionIds.length === 0)
        .map((i) => i.attachmentId);
    if (typeof activeCollectionId === "number") {
      const s = recursiveItemsMap.get(activeCollectionId);
      return s ? [...s] : [];
    }
    return [];
  }

  // ── Update contextual buttons ──────────────────────────────────────────────
  function updateButtons(): void {
    const s = getMineruBatchState();
    const aw = getAutoWatchStatus();
    const hasSelection = selectedIds.size > 0;
    const inFolder = isSubfolder() || activeCollectionId === "unfiled";

    if (startBtn) {
      startBtn.disabled = isRepairing;
      if ((s.running && !s.paused) || (aw.isProcessing && !aw.isPaused)) {
        startBtn.textContent = t("Pause");
      } else if (hasSelection) {
        startBtn.textContent = `${t("Start Selected")} (${selectedIds.size})`;
      } else if (inFolder) {
        startBtn.textContent = t("Start Folder");
      } else {
        startBtn.textContent = t("Start All");
      }
    }

    if (repairBtn) {
      repairBtn.disabled = isRepairing || s.running || aw.isProcessing;
      repairBtn.textContent = isRepairing
        ? t("Repairing...")
        : t("Repair Cache");
    }

    if (deleteBtn) {
      deleteBtn.disabled = isRepairing;
      if (hasSelection) {
        deleteBtn.textContent = `${t("Delete Cache")} (${selectedIds.size})`;
      } else if (inFolder) {
        deleteBtn.textContent = t("Delete Folder Cache");
      } else {
        deleteBtn.textContent = t("Delete All Cache");
      }
    }
  }

  // ── Build index maps ───────────────────────────────────────────────────────
  function buildCollectionMaps(): void {
    directItemsMap.clear();
    recursiveItemsMap.clear();
    for (const item of allItems) {
      for (const colId of item.collectionIds) {
        let s = directItemsMap.get(colId);
        if (!s) {
          s = new Set();
          directItemsMap.set(colId, s);
        }
        s.add(item.attachmentId);
      }
    }
    function recurse(node: MineruCollectionNode): Set<number> {
      const set = new Set<number>(directItemsMap.get(node.collectionId) || []);
      for (const child of node.children) {
        for (const id of recurse(child)) set.add(id);
      }
      recursiveItemsMap.set(node.collectionId, set);
      return set;
    }
    for (const root of collectionTree) recurse(root);
  }

  // ── Sidebar ────────────────────────────────────────────────────────────────
  function renderSidebar(): void {
    if (!sidebar) return;
    sidebar.innerHTML = "";
    const inner = doc.createElement("div");
    inner.style.cssText = "min-width: max-content;";
    sidebar.appendChild(inner);
    inner.appendChild(
      createSidebarEntry(t("My Library"), "all", 0, allItems.length),
    );
    for (const root of collectionTree) renderSidebarNode(inner, root, 1);
    const uc = allItems.filter((i) => i.collectionIds.length === 0).length;
    if (uc > 0)
      inner.appendChild(
        createSidebarEntry(t("Unfiled Items"), "unfiled", 0, uc),
      );
  }

  function createSidebarEntry(
    name: string,
    key: number | "all" | "unfiled",
    indent: number,
    count: number,
  ): HTMLElement {
    const row = doc.createElement("div");
    row.style.cssText =
      "display: flex; align-items: center; gap: 4px; padding: 4px 8px; cursor: pointer; user-select: none; border-radius: 4px; margin: 1px 4px;";
    row.style.paddingLeft = `${8 + indent * 14}px`;
    if (activeCollectionId === key)
      row.style.background =
        "color-mix(in srgb, var(--color-accent, #2563eb) 15%, transparent)";
    const icon = doc.createElement("span");
    icon.style.cssText = "font-size: 12px; flex-shrink: 0;";
    icon.textContent = key === "all" ? "\uD83D\uDCDA" : "\uD83D\uDCC1";
    row.appendChild(icon);
    const nm = doc.createElement("span");
    nm.style.cssText =
      "flex: 1; white-space: nowrap; font-size: 12px;";
    nm.style.fontWeight =
      key === "all" || activeCollectionId === key ? "600" : "400";
    nm.textContent = name;
    row.appendChild(nm);
    const ct = doc.createElement("span");
    ct.style.cssText = "font-size: 10px; color: #888; flex-shrink: 0;";
    ct.textContent = String(count);
    row.appendChild(ct);
    row.addEventListener("click", () => {
      activeCollectionId = key;
      selectedIds.clear();
      lastClickedId = null;
      renderSidebar();
      renderItemsList();
      updateButtons();
    });
    return row;
  }

  function renderSidebarNode(
    parent: HTMLElement,
    node: MineruCollectionNode,
    indent: number,
  ): void {
    const recSet = recursiveItemsMap.get(node.collectionId);
    const count = recSet ? recSet.size : 0;
    const hasChildren = node.children.length > 0;
    const collapsed = collapsedSidebar.has(node.collectionId);
    const row = doc.createElement("div");
    row.style.cssText =
      "display: flex; align-items: center; gap: 4px; padding: 4px 8px; cursor: pointer; user-select: none; border-radius: 4px; margin: 1px 4px;";
    row.style.paddingLeft = `${8 + indent * 14}px`;
    if (activeCollectionId === node.collectionId)
      row.style.background =
        "color-mix(in srgb, var(--color-accent, #2563eb) 15%, transparent)";
    if (hasChildren) {
      const chev = doc.createElement("span");
      chev.style.cssText =
        "width: 10px; flex-shrink: 0; font-size: 9px; text-align: center; color: #888; font-weight: 700;";
      chev.textContent = collapsed ? "\u203A" : "\u2304";
      chev.addEventListener("click", (e) => {
        e.stopPropagation();
        if (collapsed) collapsedSidebar.delete(node.collectionId);
        else collapsedSidebar.add(node.collectionId);
        renderSidebar();
      });
      row.appendChild(chev);
    } else {
      const sp = doc.createElement("span");
      sp.style.cssText = "width: 10px; flex-shrink: 0;";
      row.appendChild(sp);
    }
    const icon = doc.createElement("span");
    icon.style.cssText = "font-size: 12px; flex-shrink: 0;";
    icon.textContent = "\uD83D\uDCC1";
    row.appendChild(icon);
    const nm = doc.createElement("span");
    nm.style.cssText =
      "flex: 1; white-space: nowrap; font-size: 12px;";
    nm.style.fontWeight =
      activeCollectionId === node.collectionId ? "600" : "400";
    nm.textContent = node.name;
    row.appendChild(nm);
    const ct = doc.createElement("span");
    ct.style.cssText = "font-size: 10px; color: #888; flex-shrink: 0;";
    ct.textContent = String(count);
    row.appendChild(ct);
    row.addEventListener("click", () => {
      activeCollectionId = node.collectionId;
      selectedIds.clear();
      lastClickedId = null;
      renderSidebar();
      renderItemsList();
      updateButtons();
    });
    parent.appendChild(row);
    if (hasChildren && !collapsed) {
      for (const child of node.children)
        renderSidebarNode(parent, child, indent + 1);
    }
  }

  // ── Column header sorting ──────────────────────────────────────────────────
  function setColumnWidthStyle(cell: HTMLElement, key: SortKey): void {
    cell.setAttribute("data-mineru-column", key);
    if (key === "cached") {
      cell.style.flex = `0 0 ${DOT_COLUMN_WIDTH}px`;
      cell.style.width = `${DOT_COLUMN_WIDTH}px`;
      cell.style.minWidth = `${DOT_COLUMN_WIDTH}px`;
      cell.style.maxWidth = `${DOT_COLUMN_WIDTH}px`;
      return;
    }
    if (key === "title") {
      cell.style.flex = "1 1 auto";
      cell.style.minWidth = "0";
      cell.style.width = "";
      cell.style.maxWidth = "";
      return;
    }

    const width = columnWidths[key];
    cell.style.flex = `0 0 ${width}px`;
    cell.style.width = `${width}px`;
    cell.style.minWidth = `${width}px`;
    cell.style.maxWidth = `${width}px`;
  }

  function applyColumnLayout(root: ParentNode | null = null): void {
    const scope = root ?? colHeaders?.parentElement ?? itemsList ?? doc;
    if (!("querySelectorAll" in scope)) return;
    const cells = scope.querySelectorAll("[data-mineru-column]");
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i] as HTMLElement;
      const key = cell.getAttribute("data-mineru-column") as SortKey | null;
      if (!key) continue;
      setColumnWidthStyle(cell, key);
    }
  }

  function getHeaderContentWidth(): number {
    if (!colHeaders) return 0;
    const styles = win.getComputedStyle(colHeaders);
    if (!styles) return colHeaders.clientWidth;
    const paddingLeft = Number.parseFloat(styles.paddingLeft || "0") || 0;
    const paddingRight = Number.parseFloat(styles.paddingRight || "0") || 0;
    return Math.max(0, colHeaders.clientWidth - paddingLeft - paddingRight);
  }

  function getHeaderGapWidth(): number {
    if (!colHeaders) return 0;
    const styles = win.getComputedStyle(colHeaders);
    if (!styles) return 0;
    return (
      Number.parseFloat(styles.columnGap || styles.gap || "0") ||
      Number.parseFloat(styles.gap || "0") ||
      0
    );
  }

  function getCurrentTitleWidth(): number {
    const hasSpacer = !!doc.getElementById(CHECKBOX_SPACER_ID);
    const itemCount = hasSpacer ? 6 : 5;
    const gapWidth = getHeaderGapWidth() * Math.max(0, itemCount - 1);
    const fixedWidth =
      DOT_COLUMN_WIDTH +
      (hasSpacer ? CHECKBOX_SPACER_WIDTH : 0) +
      columnWidths.firstCreator +
      columnWidths.year +
      columnWidths.dateAdded;
    return Math.max(0, getHeaderContentWidth() - fixedWidth - gapWidth);
  }

  function startColumnResize(
    boundary: ResizeBoundary,
    event: MouseEvent,
  ): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    stopActiveResize?.();

    const startX = event.clientX;
    const startWidths = { ...columnWidths };
    const startTitleWidth = getCurrentTitleWidth();
    const rootEl = doc.documentElement as HTMLElement;
    const previousCursor = rootEl.style.cursor;
    const previousUserSelect = rootEl.style.userSelect;

    const onMouseMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      const rawDelta = moveEvent.clientX - startX;
      let appliedDelta = rawDelta;

      if (boundary === "title|firstCreator") {
        const minDelta = Math.min(0, MIN_COLUMN_WIDTHS.title - startTitleWidth);
        const maxDelta = Math.max(
          0,
          startWidths.firstCreator - MIN_COLUMN_WIDTHS.firstCreator,
        );
        appliedDelta = Math.min(maxDelta, Math.max(minDelta, rawDelta));
        columnWidths.firstCreator = startWidths.firstCreator - appliedDelta;
      } else if (boundary === "firstCreator|year") {
        const minDelta = Math.min(
          0,
          MIN_COLUMN_WIDTHS.firstCreator - startWidths.firstCreator,
        );
        const maxDelta = Math.max(0, startWidths.year - MIN_COLUMN_WIDTHS.year);
        appliedDelta = Math.min(maxDelta, Math.max(minDelta, rawDelta));
        columnWidths.firstCreator = startWidths.firstCreator + appliedDelta;
        columnWidths.year = startWidths.year - appliedDelta;
      } else {
        const minDelta = Math.min(0, MIN_COLUMN_WIDTHS.year - startWidths.year);
        const maxDelta = Math.max(
          0,
          startWidths.dateAdded - MIN_COLUMN_WIDTHS.dateAdded,
        );
        appliedDelta = Math.min(maxDelta, Math.max(minDelta, rawDelta));
        columnWidths.year = startWidths.year + appliedDelta;
        columnWidths.dateAdded = startWidths.dateAdded - appliedDelta;
      }

      applyColumnLayout(colHeaders?.parentElement ?? itemsList ?? doc);
    };

    const onMouseUp = () => {
      cleanup();
    };

    const cleanup = () => {
      win.removeEventListener("mousemove", onMouseMove, true);
      win.removeEventListener("mouseup", onMouseUp, true);
      rootEl.style.cursor = previousCursor;
      rootEl.style.userSelect = previousUserSelect;
      if (stopActiveResize === cleanup) {
        stopActiveResize = null;
      }
    };

    stopActiveResize = cleanup;
    rootEl.style.cursor = "col-resize";
    rootEl.style.userSelect = "none";
    win.addEventListener("mousemove", onMouseMove, true);
    win.addEventListener("mouseup", onMouseUp, true);
  }

  function ensureHeaderCellLabel(cell: HTMLElement): HTMLSpanElement {
    let label = cell.querySelector(
      "[data-mineru-header-label]",
    ) as HTMLSpanElement | null;
    if (label) return label;

    label = doc.createElement("span");
    label.setAttribute("data-mineru-header-label", "true");
    label.style.cssText =
      "display: block; width: 100%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    label.textContent = cell.textContent || "";
    cell.textContent = "";
    cell.appendChild(label);
    return label;
  }

  function getHeaderHandlePlacements(key: SortKey): ResizeHandlePlacement[] {
    if (key === "title") {
      return [{ boundary: "title|firstCreator", side: "right" }];
    }
    if (key === "firstCreator") {
      return [{ boundary: "firstCreator|year", side: "right" }];
    }
    if (key === "year") {
      return [{ boundary: "year|dateAdded", side: "right" }];
    }
    return [];
  }

  function ensureResizableHeaderCells(): void {
    if (!colHeaders) return;
    const spans = colHeaders.querySelectorAll("[data-sort-key]");
    for (let i = 0; i < spans.length; i++) {
      const cell = spans[i] as HTMLElement;
      const key = cell.getAttribute("data-sort-key") as SortKey;
      const label = ensureHeaderCellLabel(cell);
      cell.style.display = "flex";
      cell.style.alignItems = "center";
      cell.style.position = "relative";
      cell.style.minWidth = "0";
      label.style.textAlign = key === "cached" ? "center" : "left";
      label.style.paddingLeft =
        key === "title" ? `${TITLE_CONTENT_OFFSET}px` : "0";
      setColumnWidthStyle(cell, key);

      const placements = getHeaderHandlePlacements(key);
      for (const placement of placements) {
        const handleId = `${placement.boundary}:${placement.side}`;
        if (cell.querySelector(`[data-mineru-resize-handle="${handleId}"]`)) {
          continue;
        }

        const handle = doc.createElement("span");
        handle.setAttribute("data-mineru-resize-handle", handleId);
        handle.style.cssText = `position: absolute; top: -4px; ${placement.side}: -6px; width: 12px; height: calc(100% + 8px); cursor: col-resize; z-index: 2;`;

        const guide = doc.createElement("span");
        guide.style.cssText =
          "position: absolute; top: 20%; left: 50%; width: 1px; height: 60%; background: rgba(128,128,128,0.35); transform: translateX(-0.5px); pointer-events: none;";
        handle.appendChild(guide);

        handle.addEventListener("mousedown", (e) =>
          startColumnResize(placement.boundary, e as MouseEvent),
        );
        handle.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
        });

        cell.appendChild(handle);
      }
    }
  }

  function renderColumnHeaders(): void {
    if (!colHeaders) return;
    ensureResizableHeaderCells();
    const spans = colHeaders.querySelectorAll("[data-sort-key]");
    for (let i = 0; i < spans.length; i++) {
      const sp = spans[i] as HTMLElement;
      const key = sp.getAttribute("data-sort-key") as SortKey;
      const labelEl = ensureHeaderCellLabel(sp);
      const label = {
        cached: "\u25CF",
        title: t("Title"),
        firstCreator: t("Author"),
        year: t("Year"),
        dateAdded: t("Added"),
      }[key];
      if (sortKey === key) {
        if (key === "cached") {
          labelEl.textContent = sortDir === "asc" ? "\u25B2" : "\u25BC";
        } else {
          labelEl.textContent = `${label} ${sortDir === "asc" ? "\u25B2" : "\u25BC"}`;
        }
        sp.style.color = "FieldText";
      } else {
        labelEl.textContent = label || "";
        sp.style.color = "#888";
      }
    }
    applyColumnLayout(colHeaders.parentElement ?? colHeaders);
  }

  if (colHeaders) {
    colHeaders.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest(
        "[data-sort-key]",
      ) as HTMLElement | null;
      if (!target) return;
      const key = target.getAttribute("data-sort-key") as SortKey;
      if (sortKey === key) {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortKey = key;
        sortDir = key === "dateAdded" ? "desc" : "asc";
      }
      renderColumnHeaders();
      renderItemsList();
    });
  }

  // ── Items list rendering ───────────────────────────────────────────────────
  const CHECKBOX_SPACER_ID = `${idPrefix}-mineru-mgr-cb-spacer`;

  function syncHeaderCheckboxSpacer(hasSelection: boolean): void {
    if (!colHeaders) return;
    const existing = doc.getElementById(CHECKBOX_SPACER_ID);
    if (hasSelection && !existing) {
      const spacer = doc.createElement("span");
      spacer.id = CHECKBOX_SPACER_ID;
      spacer.style.cssText = "width: 13px; flex-shrink: 0;";
      colHeaders.insertBefore(spacer, colHeaders.firstChild);
    } else if (!hasSelection && existing) {
      existing.remove();
    }
  }

  // Parent dot aggregation for multi-PDF items
  const parentDotElements = new Map<number, HTMLSpanElement>();

  function getInitialParentDisplayStatus(
    group: MineruParentGroup,
  ): MineruStatus {
    return getMineruParentDisplayStatus(
      group.children.map((child) => ({
        availability: child.availability,
        excluded: child.excluded,
        status: getAvailabilityDisplayStatus(child),
      })),
    );
  }

  async function getResolvedParentDisplayStatus(
    group: MineruParentGroup,
  ): Promise<MineruStatus> {
    const childStatuses = await Promise.all(
      group.children.map(async (child) => ({
        availability: child.availability,
        excluded: child.excluded,
        status: await getMineruStatus(child.attachmentId),
      })),
    );
    return getMineruParentDisplayStatus(childStatuses);
  }

  async function updateParentDot(
    parentId: number,
    group: MineruParentGroup,
  ): Promise<void> {
    const parentDot = parentDotElements.get(parentId);
    if (!parentDot) return;
    const status = await getResolvedParentDisplayStatus(group);
    if (parentDotElements.get(parentId) !== parentDot) return;
    setDotDisplayStatus(parentDot, status);
  }

  function findRenderedGroupForAttachment(
    attachmentId: number,
  ): MineruParentGroup | null {
    return (
      getVisibleGroups().find((group) =>
        group.children.some((child) => child.attachmentId === attachmentId),
      ) || null
    );
  }

  function markParentDotProcessingForAttachment(attachmentId: number): void {
    const group = findRenderedGroupForAttachment(attachmentId);
    if (!group) return;
    const parentDot = parentDotElements.get(group.parentItemId);
    if (parentDot) setDotDisplayStatus(parentDot, "processing");
  }

  function updateParentDotForAttachment(attachmentId: number): void {
    const group = findRenderedGroupForAttachment(attachmentId);
    if (group) void updateParentDot(group.parentItemId, group);
  }

  function refreshRenderedParentDots(): void {
    for (const group of getVisibleGroups()) {
      void updateParentDot(group.parentItemId, group);
    }
  }

  async function refreshAttachmentDot(
    attachmentId: number,
    dot: HTMLSpanElement,
  ): Promise<void> {
    setDotDisplayStatus(dot, await getMineruStatus(attachmentId));
  }

  /** Build a standard item row (reused for parent, child, and single-PDF rows). */
  function buildItemRow(
    item: MineruItemEntry,
    opts: { isChild?: boolean; fontWeight?: string } = {},
  ): HTMLDivElement {
    const row = doc.createElement("div");
    row.setAttribute("data-attachment-id", String(item.attachmentId));
    row.style.cssText =
      "display: flex; align-items: center; gap: 8px; padding: 4px 10px; border-bottom: 1px solid rgba(128,128,128,0.1); cursor: default;";
    if (opts.fontWeight) row.style.fontWeight = opts.fontWeight;
    if (opts.isChild) row.style.borderBottomColor = "rgba(128,128,128,0.06)";

    const dot = doc.createElement("span");
    dot.style.cssText =
      "width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;";
    setColumnWidthStyle(dot, "cached");
    setDotDisplayStatus(dot, getAvailabilityDisplayStatus(item));
    dot.title = getAvailabilityTooltip(item);
    dotElements.set(item.attachmentId, dot);
    row.appendChild(dot);

    void (async () => {
      await refreshAttachmentDot(item.attachmentId, dot);
    })();

    const titleSpan = doc.createElement("span");
    titleSpan.style.cssText =
      "flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px;";
    if (opts.isChild) {
      titleSpan.style.paddingLeft = `${20 + TITLE_CONTENT_OFFSET}px`;
      titleSpan.style.color = "#888";
      titleSpan.style.fontSize = "11.5px";
      titleSpan.textContent = item.pdfTitle;
      titleSpan.title = item.pdfTitle;
    } else {
      titleSpan.style.paddingLeft = `${TITLE_CONTENT_OFFSET}px`;
      titleSpan.textContent = item.title;
      titleSpan.title = item.title;
    }
    setColumnWidthStyle(titleSpan, "title");
    row.appendChild(titleSpan);

    const authorSpan = doc.createElement("span");
    authorSpan.style.cssText =
      "flex: 0 0 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: #888;";
    authorSpan.textContent = opts.isChild ? "" : item.firstCreator;
    setColumnWidthStyle(authorSpan, "firstCreator");
    row.appendChild(authorSpan);

    const yearSpan = doc.createElement("span");
    yearSpan.style.cssText =
      "flex: 0 0 40px; text-align: left; font-size: 11.5px; color: #888;";
    yearSpan.textContent = opts.isChild ? "" : item.year;
    setColumnWidthStyle(yearSpan, "year");
    row.appendChild(yearSpan);

    const dateSpan = doc.createElement("span");
    dateSpan.style.cssText =
      "flex: 0 0 72px; text-align: right; font-size: 11px; color: #888;";
    dateSpan.textContent = opts.isChild ? "" : fmtDate(item.dateAdded);
    setColumnWidthStyle(dateSpan, "dateAdded");
    row.appendChild(dateSpan);

    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      handleRowClick(item.attachmentId, e as MouseEvent);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      contextMenuItemId = item.attachmentId;
      if (!selectedIds.has(item.attachmentId)) {
        selectedIds.clear();
        selectedIds.add(item.attachmentId);
        lastClickedId = item.attachmentId;
        renderItemsList();
        updateButtons();
      }
      showContextMenu(e as MouseEvent);
    });

    return row;
  }

  function renderItemsList(): void {
    if (!itemsList) return;
    itemsList.innerHTML = "";
    dotElements.clear();
    parentDotElements.clear();

    const groups = getVisibleGroups();
    visibleItemsOrdered = [];
    for (const g of groups) {
      for (const c of g.children) visibleItemsOrdered.push(c);
    }

    const hasSelection = selectedIds.size > 0;
    syncHeaderCheckboxSpacer(hasSelection);
    const fragment = doc.createDocumentFragment();

    for (const group of groups) {
      const isMultiPdf = group.children.length > 1;
      const collapsed = collapsedParents.has(group.parentItemId);

      // ── Parent row (all groups, single or multi) ────────────────────
      const parentRow = doc.createElement("div");
      parentRow.setAttribute("data-parent-id", String(group.parentItemId));
      const allChildrenSelected = group.children.every((c) =>
        selectedIds.has(c.attachmentId),
      );
      parentRow.style.cssText =
        "display: flex; align-items: center; gap: 8px; padding: 4px 10px; border-bottom: 1px solid rgba(128,128,128,0.1); cursor: default;";
      if (allChildrenSelected)
        parentRow.style.background =
          "color-mix(in srgb, var(--color-accent, #2563eb) 12%, transparent)";
      const allExcluded = group.children.every((c) => c.excluded);
      if (allExcluded) parentRow.style.opacity = "0.45";

      // Checkbox
      if (hasSelection) {
        const cb = doc.createElement("input");
        cb.type = "checkbox";
        cb.checked = allChildrenSelected;
        cb.style.cssText = "flex-shrink: 0; margin: 0; cursor: pointer;";
        cb.addEventListener("change", () => {
          if (cb.checked) {
            for (const c of group.children) selectedIds.add(c.attachmentId);
          } else {
            for (const c of group.children) selectedIds.delete(c.attachmentId);
          }
          renderItemsList();
          updateButtons();
        });
        cb.addEventListener("click", (e: Event) => {
          e.stopPropagation();
          if ((e as MouseEvent).shiftKey && lastClickedId !== null) {
            e.preventDefault();
            const anchorIdx = visibleItemsOrdered.findIndex(
              (i) => i.attachmentId === lastClickedId,
            );
            const firstIdx = visibleItemsOrdered.findIndex(
              (i) => i.attachmentId === group.children[0]?.attachmentId,
            );
            const lastIdx = visibleItemsOrdered.findIndex(
              (i) =>
                i.attachmentId ===
                group.children[group.children.length - 1]?.attachmentId,
            );
            if (anchorIdx >= 0 && firstIdx >= 0 && lastIdx >= 0) {
              const targetIdx = anchorIdx <= firstIdx ? lastIdx : firstIdx;
              const from = Math.min(anchorIdx, targetIdx);
              const to = Math.max(anchorIdx, targetIdx);
              for (let i = from; i <= to; i++) {
                selectedIds.add(visibleItemsOrdered[i].attachmentId);
              }
            }
            renderItemsList();
            updateButtons();
          }
        });
        parentRow.appendChild(cb);
      }

      // Aggregated status dot (before chevron)
      const parentDot = doc.createElement("span");
      parentDot.style.cssText =
        "width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;";
      setColumnWidthStyle(parentDot, "cached");

      // Chevron (expand/collapse) — SVG triangle, after dot, before title
      const chev = doc.createElement("span");
      chev.style.cssText = `width: 12px; height: 12px; flex-shrink: 0; cursor: pointer; user-select: none; display: inline-flex; align-items: center; justify-content: center; margin-left: ${TITLE_CONTENT_OFFSET}px;`;
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = doc.createElementNS(svgNS, "svg");
      svg.setAttribute("width", "8");
      svg.setAttribute("height", "8");
      svg.setAttribute("viewBox", "0 0 8 8");
      svg.setAttribute(
        "style",
        collapsed
          ? "transform: rotate(0deg); transition: transform 0.1s;"
          : "transform: rotate(90deg); transition: transform 0.1s;",
      );
      const path = doc.createElementNS(svgNS, "path");
      path.setAttribute("d", "M2 1 L6 4 L2 7 Z");
      path.setAttribute("fill", "#888");
      svg.appendChild(path);
      chev.appendChild(svg);
      chev.addEventListener("click", (e) => {
        e.stopPropagation();
        if (collapsed) collapsedParents.delete(group.parentItemId);
        else collapsedParents.add(group.parentItemId);
        renderItemsList();
      });
      setDotDisplayStatus(parentDot, getInitialParentDisplayStatus(group));
      parentDotElements.set(group.parentItemId, parentDot);
      void updateParentDot(group.parentItemId, group);
      parentRow.appendChild(parentDot);
      parentRow.appendChild(chev);

      // Title
      const titleSpan = doc.createElement("span");
      titleSpan.style.cssText =
        "flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px;";
      titleSpan.textContent = group.title;
      titleSpan.title = group.title;
      setColumnWidthStyle(titleSpan, "title");
      parentRow.appendChild(titleSpan);

      // Badge (multi-PDF only)
      if (isMultiPdf) {
        const badge = doc.createElement("span");
        badge.style.cssText =
          "flex-shrink: 0; font-size: 9px; color: #888; background: rgba(128,128,128,0.15); border-radius: 3px; padding: 0 4px; font-weight: 600;";
        badge.textContent = String(group.children.length);
        parentRow.appendChild(badge);
      }

      // Author / Year / Added
      const authorSpan = doc.createElement("span");
      authorSpan.style.cssText =
        "flex: 0 0 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: #888;";
      authorSpan.textContent = group.firstCreator;
      setColumnWidthStyle(authorSpan, "firstCreator");
      parentRow.appendChild(authorSpan);

      const yearSpan = doc.createElement("span");
      yearSpan.style.cssText =
        "flex: 0 0 40px; text-align: left; font-size: 11.5px; color: #888;";
      yearSpan.textContent = group.year;
      setColumnWidthStyle(yearSpan, "year");
      parentRow.appendChild(yearSpan);

      const dateSpan = doc.createElement("span");
      dateSpan.style.cssText =
        "flex: 0 0 72px; text-align: right; font-size: 11px; color: #888;";
      dateSpan.textContent = fmtDate(group.dateAdded);
      setColumnWidthStyle(dateSpan, "dateAdded");
      parentRow.appendChild(dateSpan);

      // Click: select all children
      parentRow.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).tagName === "INPUT") return;
        const isMeta = (e as MouseEvent).metaKey || (e as MouseEvent).ctrlKey;
        const isShift = (e as MouseEvent).shiftKey;
        if (isShift && lastClickedId !== null) {
          const anchorIdx = visibleItemsOrdered.findIndex(
            (i) => i.attachmentId === lastClickedId,
          );
          const firstIdx = visibleItemsOrdered.findIndex(
            (i) => i.attachmentId === group.children[0]?.attachmentId,
          );
          const lastIdx = visibleItemsOrdered.findIndex(
            (i) =>
              i.attachmentId ===
              group.children[group.children.length - 1]?.attachmentId,
          );
          if (anchorIdx >= 0 && firstIdx >= 0 && lastIdx >= 0) {
            const targetIdx = anchorIdx <= firstIdx ? lastIdx : firstIdx;
            const from = Math.min(anchorIdx, targetIdx);
            const to = Math.max(anchorIdx, targetIdx);
            if (!isMeta) selectedIds.clear();
            for (let i = from; i <= to; i++) {
              selectedIds.add(visibleItemsOrdered[i].attachmentId);
            }
          }
        } else if (isMeta) {
          if (allChildrenSelected) {
            for (const c of group.children) selectedIds.delete(c.attachmentId);
          } else {
            for (const c of group.children) selectedIds.add(c.attachmentId);
          }
        } else {
          selectedIds.clear();
          for (const c of group.children) selectedIds.add(c.attachmentId);
        }
        if (!isShift) lastClickedId = group.children[0]?.attachmentId ?? null;
        renderItemsList();
        updateButtons();
      });
      parentRow.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        contextMenuItemId = group.children[0]?.attachmentId ?? null;
        if (!allChildrenSelected) {
          selectedIds.clear();
          for (const c of group.children) selectedIds.add(c.attachmentId);
          lastClickedId = group.children[0]?.attachmentId ?? null;
          renderItemsList();
          updateButtons();
        }
        showContextMenu(e as MouseEvent);
      });
      fragment.appendChild(parentRow);

      // ── Child rows (when expanded) ──────────────────────────────────
      if (!collapsed) {
        for (const child of group.children) {
          const childRow = buildItemRow(child, { isChild: true });
          if (child.excluded) childRow.style.opacity = "0.45";
          if (selectedIds.has(child.attachmentId))
            childRow.style.background =
              "color-mix(in srgb, var(--color-accent, #2563eb) 12%, transparent)";

          const childDot = dotElements.get(child.attachmentId);
          if (childDot) {
            void (async () => {
              await refreshAttachmentDot(child.attachmentId, childDot);
              void updateParentDot(group.parentItemId, group);
            })();
          }

          if (hasSelection) {
            const isSelected = selectedIds.has(child.attachmentId);
            const cb = doc.createElement("input");
            cb.type = "checkbox";
            cb.checked = isSelected;
            cb.style.cssText = "flex-shrink: 0; margin: 0; cursor: pointer;";
            cb.addEventListener("change", () => {
              if (cb.checked) selectedIds.add(child.attachmentId);
              else selectedIds.delete(child.attachmentId);
              lastClickedId = child.attachmentId;
              renderItemsList();
              updateButtons();
            });
            cb.addEventListener("click", (e: Event) => {
              e.stopPropagation();
              if ((e as MouseEvent).shiftKey && lastClickedId !== null) {
                e.preventDefault();
                const idxA = visibleItemsOrdered.findIndex(
                  (i) => i.attachmentId === lastClickedId,
                );
                const idxB = visibleItemsOrdered.findIndex(
                  (i) => i.attachmentId === child.attachmentId,
                );
                if (idxA >= 0 && idxB >= 0) {
                  const from = Math.min(idxA, idxB);
                  const to = Math.max(idxA, idxB);
                  for (let i = from; i <= to; i++) {
                    selectedIds.add(visibleItemsOrdered[i].attachmentId);
                  }
                }
                renderItemsList();
                updateButtons();
              }
            });
            childRow.insertBefore(cb, childRow.firstChild);
          }
          fragment.appendChild(childRow);
        }
      }
    }

    itemsList.appendChild(fragment);
    applyColumnLayout(colHeaders?.parentElement ?? itemsList);
    updateButtons();
  }

  function handleRowClick(attachmentId: number, e: MouseEvent): void {
    const isMeta = e.metaKey || e.ctrlKey;
    const isShift = e.shiftKey;

    if (isShift && lastClickedId !== null) {
      // Range select: from lastClickedId to attachmentId
      const idxA = visibleItemsOrdered.findIndex(
        (i) => i.attachmentId === lastClickedId,
      );
      const idxB = visibleItemsOrdered.findIndex(
        (i) => i.attachmentId === attachmentId,
      );
      if (idxA >= 0 && idxB >= 0) {
        const from = Math.min(idxA, idxB);
        const to = Math.max(idxA, idxB);
        if (!isMeta) selectedIds.clear();
        for (let i = from; i <= to; i++) {
          selectedIds.add(visibleItemsOrdered[i].attachmentId);
        }
      }
      // Don't update lastClickedId on shift-click (anchor stays)
    } else if (isMeta) {
      // Toggle individual
      if (selectedIds.has(attachmentId)) selectedIds.delete(attachmentId);
      else selectedIds.add(attachmentId);
      lastClickedId = attachmentId;
    } else {
      // Plain click: single select (or deselect if clicking the only selected)
      if (selectedIds.size === 1 && selectedIds.has(attachmentId)) {
        selectedIds.clear();
        lastClickedId = null;
      } else {
        selectedIds.clear();
        selectedIds.add(attachmentId);
        lastClickedId = attachmentId;
      }
    }

    renderItemsList();
    updateButtons();
  }

  // ── Context menu ───────────────────────────────────────────────────────────
  function showContextMenu(e: MouseEvent): void {
    if (!contextMenu) return;
    contextMenu.style.display = "block";
    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.style.top = `${e.clientY}px`;
  }
  function hideContextMenu(): void {
    if (contextMenu) contextMenu.style.display = "none";
    contextMenuItemId = null;
  }

  doc.addEventListener("mousedown", (e) => {
    if (
      contextMenu &&
      contextMenu.style.display !== "none" &&
      !(e.target as HTMLElement)?.closest?.(`#${contextMenuId}`)
    ) {
      hideContextMenu();
    }
  });
  doc.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") {
      hideContextMenu();
      if (selectedIds.size > 0) {
        selectedIds.clear();
        lastClickedId = null;
        renderItemsList();
        updateButtons();
      }
    }
  });

  function addHover(el: HTMLElement): void {
    el.addEventListener("mouseenter", () => {
      el.style.background = "color-mix(in srgb, currentColor 10%, transparent)";
    });
    el.addEventListener("mouseleave", () => {
      el.style.background = "transparent";
    });
  }

  if (ctxProcessBtn) {
    ctxProcessBtn.addEventListener("click", () => {
      const ids =
        selectedIds.size > 0
          ? [...selectedIds]
          : contextMenuItemId != null
            ? [contextMenuItemId]
            : [];
      hideContextMenu();
      if (ids.length > 0) void processSelectedItems(ids);
    });
    addHover(ctxProcessBtn);
  }

  if (ctxShowFolderBtn) {
    ctxShowFolderBtn.addEventListener("click", () => {
      if (contextMenuItemId != null) {
        const dirPath = getMineruItemDir(contextMenuItemId);
        hideContextMenu();
        try {
          const Cc = (
            globalThis as unknown as {
              Components?: {
                classes?: Record<
                  string,
                  { createInstance: (iface: unknown) => unknown }
                >;
              };
            }
          ).Components?.classes;
          const Ci = (
            globalThis as unknown as {
              Components?: { interfaces?: Record<string, unknown> };
            }
          ).Components?.interfaces;
          if (Cc && Ci) {
            const f = Cc["@mozilla.org/file/local;1"]?.createInstance(
              Ci.nsIFile as unknown,
            ) as
              | { initWithPath?: (p: string) => void; reveal?: () => void }
              | undefined;
            if (f?.initWithPath) {
              f.initWithPath(dirPath);
              f.reveal?.();
            }
          }
        } catch {
          try {
            (
              Zotero as unknown as { launchFile?: (p: string) => void }
            ).launchFile?.(dirPath);
          } catch {
            /* */
          }
        }
      }
    });
    addHover(ctxShowFolderBtn);
  }

  if (ctxDeleteBtn) {
    ctxDeleteBtn.addEventListener("click", async () => {
      const ids =
        selectedIds.size > 0
          ? [...selectedIds]
          : contextMenuItemId != null
            ? [contextMenuItemId]
            : [];
      hideContextMenu();
      for (const id of ids) {
        await deleteMineruCacheForItem(id);
        await refreshEntryAvailability(id);
      }
      localProcessedCount = allItems.filter(
        (i) => !i.excluded && isMineruAvailable(i),
      ).length;
      updateProgressBar();
    });
    addHover(ctxDeleteBtn);
  }

  // ── Batch state sync ───────────────────────────────────────────────────────
  function syncUIFromState(s: MineruBatchState): void {
    if (s.totalCount > 0) {
      localTotalCount = s.totalCount;
      localProcessedCount = s.processedCount;
      updateProgressBar();
    }
    updateButtons();
    if (statusEl) {
      if (s.statusMessage) {
        // Currently processing — show live status
        statusEl.textContent = s.statusMessage;
        statusEl.title = s.statusMessage;
        statusEl.style.color = "";
      } else if (s.failedCount > 0 && s.lastFailedMessage) {
        // Not actively processing, but there were failures — show error reason
        // Error reason goes first (actionable); count provides context
        const msg =
          s.failedCount > 1
            ? `${s.failedCount} ${t("items failed")} — ${s.lastFailedMessage}`
            : `${t("Failed")} — ${s.lastFailedMessage}`;
        statusEl.textContent = msg;
        statusEl.title = msg;
        statusEl.style.color = "#dc2626";
      } else if (!s.running && s.processedCount > 0 && s.failedCount === 0) {
        statusEl.textContent = "";
        statusEl.title = "";
        statusEl.style.color = "";
      } else {
        statusEl.textContent = "";
        statusEl.title = "";
        statusEl.style.color = "";
      }
    }
    if (errorSpan) {
      if (s.error) {
        errorSpan.style.display = "inline";
        errorSpan.textContent = s.error;
      } else {
        errorSpan.style.display = "none";
        errorSpan.textContent = "";
      }
    }
    if (itemsList) {
      const rows = itemsList.querySelectorAll("[data-attachment-id]");
      for (let i = 0; i < rows.length; i++) {
        const el = rows[i] as HTMLElement;
        const attId = Number(el.getAttribute("data-attachment-id"));
        if (s.currentItemId && attId === s.currentItemId) {
          el.style.background = "color-mix(in srgb, #f59e0b 15%, transparent)";
          // Also set dot to yellow
          const dot = dotElements.get(attId);
          if (dot) setDotDisplayStatus(dot, "processing");
        } else if (!selectedIds.has(attId)) {
          el.style.background = "";
        }
      }
    }
    if (s.currentItemId) {
      markParentDotProcessingForAttachment(s.currentItemId);
    }
  }

  let lastSeenCurrentId: number | null = null;
  const unsubscribe = onBatchStateChange((s: MineruBatchState) => {
    syncUIFromState(s);
    if (s.currentItemId) {
      lastSeenCurrentId = s.currentItemId;
    } else if (lastSeenCurrentId !== null) {
      const failed = s.lastFailedItemId === lastSeenCurrentId;
      const dot = dotElements.get(lastSeenCurrentId);
      if (dot) setDotDisplayStatus(dot, failed ? "failed" : "cached");
      const entry = allItems.find((i) => i.attachmentId === lastSeenCurrentId);
      if (entry && !failed) {
        entry.localCached = true;
        entry.cached = true;
        entry.availability = entry.syncedPackage ? "both" : "local";
        const currentDot = dotElements.get(entry.attachmentId);
        if (currentDot) currentDot.title = getAvailabilityTooltip(entry);
      }
      updateParentDotForAttachment(lastSeenCurrentId);
      lastSeenCurrentId = null;
    }
  });

  // Poll-based dot updater: check every 500ms if there's an active item
  // and set its dot to yellow. Guard against duplicate intervals.
  const existingInterval = (win as unknown as { _mineruDotPoll?: number })
    ._mineruDotPoll;
  if (existingInterval) win.clearInterval(existingInterval);
  const dotPollInterval = win.setInterval(() => {
    const s = getMineruBatchState();
    if (s.currentItemId) {
      const dot = dotElements.get(s.currentItemId);
      if (dot && dot.style.background !== "rgb(245, 158, 11)") {
        setDotDisplayStatus(dot, "processing");
      }
      markParentDotProcessingForAttachment(s.currentItemId);
    }
  }, 500);
  (win as unknown as { _mineruDotPoll?: number })._mineruDotPoll =
    dotPollInterval;
  win.addEventListener("unload", () => clearInterval(dotPollInterval));

  // ── Button handlers ────────────────────────────────────────────────────────
  if (startBtn) {
    startBtn.addEventListener("click", () => {
      if (isRepairing) return;
      const s = getMineruBatchState();
      const aw = getAutoWatchStatus();
      // Pause batch processing if running
      if (s.running && !s.paused) {
        pauseBatchProcessing();
        return;
      }
      // Pause auto-watch if processing
      if (aw.isProcessing && !aw.isPaused) {
        pauseAutoWatch();
        updateButtons();
        return;
      }
      // Resume auto-watch if it was paused and has queued items
      if (aw.isPaused && aw.queueLength > 0) {
        resumeAutoWatch();
        updateButtons();
        return;
      }
      if (selectedIds.size > 0) {
        const ids = [...selectedIds];
        selectedIds.clear();
        lastClickedId = null;
        void processSelectedItems(ids);
        renderItemsList();
      } else if (isSubfolder() || activeCollectionId === "unfiled") {
        const ids = getFolderItemIds();
        if (ids.length > 0) void processSelectedItems(ids);
      } else {
        void startBatchProcessing();
      }
    });
  }

  if (repairBtn) {
    repairBtn.addEventListener("click", async () => {
      if (isRepairing) return;
      const s = getMineruBatchState();
      const aw = getAutoWatchStatus();
      if (s.running || aw.isProcessing) return;

      isRepairing = true;
      selectedIds.clear();
      lastClickedId = null;
      if (statusEl) {
        statusEl.textContent = t("Repairing MinerU cache...");
        statusEl.title = statusEl.textContent;
        statusEl.style.color = "";
      }
      updateButtons();

      try {
        const result = await repairMineruCaches({
          onProgress: (progress) => {
            if (!statusEl) return;
            const msg = formatRepairSummary(progress);
            statusEl.textContent = msg;
            statusEl.title = msg;
          },
        });
        await loadData();
        renderSidebar();
        renderColumnHeaders();
        renderItemsList();
        const msg = formatRepairSummary(result);
        if (statusEl) {
          statusEl.textContent = msg;
          statusEl.title = msg;
          statusEl.style.color = result.failed > 0 ? "#dc2626" : "";
        }
      } catch (error) {
        const msg = `Repair failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        if (statusEl) {
          statusEl.textContent = msg;
          statusEl.title = msg;
          statusEl.style.color = "#dc2626";
        }
        ztoolkit.log("LLM MinerU: repair failed", error);
      } finally {
        isRepairing = false;
        updateButtons();
      }
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      if (isRepairing) return;
      if (selectedIds.size > 0) {
        if (
          !(await confirmDialog(
            `${t("Delete MinerU cache for")} ${selectedIds.size} ${t("selected item(s)?")}`,
          ))
        )
          return;
        for (const id of selectedIds) {
          await deleteMineruCacheForItem(id);
          await refreshEntryAvailability(id);
        }
        selectedIds.clear();
        lastClickedId = null;
        localProcessedCount = allItems.filter(
          (i) => !i.excluded && isMineruAvailable(i),
        ).length;
        updateProgressBar();
        renderItemsList();
      } else if (isSubfolder() || activeCollectionId === "unfiled") {
        const ids = getFolderItemIds();
        if (
          !(await confirmDialog(
            `${t("Delete MinerU cache for")} ${ids.length} ${t("item(s) in this folder?")}`,
          ))
        )
          return;
        for (const id of ids) {
          await deleteMineruCacheForItem(id);
          await refreshEntryAvailability(id);
        }
        localProcessedCount = allItems.filter(
          (i) => !i.excluded && isMineruAvailable(i),
        ).length;
        updateProgressBar();
        renderItemsList();
      } else {
        if (
          !(await confirmDialog(
            t("Delete all MinerU cached files? This cannot be undone."),
          ))
        )
          return;
        await deleteAllMineruCache();
        await loadData();
        renderSidebar();
        renderItemsList();
      }
      updateButtons();
    });
  }

  // ── Load data & initial render ─────────────────────────────────────────────
  async function loadData(): Promise<void> {
    try {
      allItems = await getMineruItemList();
    } catch (err) {
      ztoolkit.log("LLM MinerU: getMineruItemList failed", err);
      allItems = [];
    }
    try {
      collectionTree = getLibraryCollectionTree();
    } catch (err) {
      ztoolkit.log("LLM MinerU: getLibraryCollectionTree failed", err);
      collectionTree = [];
    }
    buildCollectionMaps();
    const actionableItems = allItems.filter((i) => !i.excluded);
    localTotalCount = actionableItems.length;
    localProcessedCount = actionableItems.filter(isMineruAvailable).length;
    updateProgressBar();
  }

  // ── Auto-refresh on library changes ────────────────────────────────────────
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshInProgress = false;
  let refreshQueued = false;
  async function runRefresh(): Promise<void> {
    if (refreshInProgress) {
      refreshQueued = true;
      return;
    }
    refreshInProgress = true;
    try {
      const prevCollectionId = activeCollectionId;
      await loadData();
      // If the previously selected collection no longer exists, reset to "all"
      if (
        typeof prevCollectionId === "number" &&
        !recursiveItemsMap.has(prevCollectionId)
      ) {
        activeCollectionId = "all";
      }
      renderSidebar();
      renderItemsList();
    } finally {
      refreshInProgress = false;
      if (refreshQueued) {
        refreshQueued = false;
        scheduleRefresh(2500);
      }
    }
  }

  function scheduleRefresh(delayMs = 2000): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      await runRefresh();
    }, delayMs);
  }

  const debouncedRefresh = () => {
    scheduleRefresh();
  };

  let notifierId: string | null = null;
  try {
    const notifier = (
      Zotero as unknown as {
        Notifier?: {
          registerObserver?: (
            observer: {
              notify: (event: string, type: string, ids: unknown[]) => void;
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
          notify(event: string, type: string) {
            if (
              (type === "item" &&
                ["add", "modify", "delete", "trash", "remove"].includes(
                  event,
                )) ||
              (type === "collection" &&
                ["add", "modify", "delete", "remove"].includes(event))
            ) {
              debouncedRefresh();
            }
          },
        },
        ["item", "collection"],
        "mineruManager",
      );
    }
  } catch {
    /* Notifier not available */
  }

  const unsubscribeAutoWatch = onAutoWatchProgress(() => {
    updateButtons();
  });

  const unsubscribeProcessingStatus = onProcessingStatusChange(() => {
    void (async () => {
      for (const [attachmentId, dot] of dotElements.entries()) {
        await refreshAttachmentDot(attachmentId, dot);
      }
      refreshRenderedParentDots();
    })();
  });

  win.addEventListener("unload", () => {
    stopActiveResize?.();
    unsubscribe();
    unsubscribeAutoWatch();
    unsubscribeProcessingStatus();
    if (refreshTimer) clearTimeout(refreshTimer);
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
    }
  });

  await loadData();
  // Default: collapse single-PDF items, expand multi-PDF items
  const initGroups = groupByParent(allItems);
  for (const g of initGroups) {
    if (g.children.length === 1) collapsedParents.add(g.parentItemId);
  }
  renderSidebar();
  renderColumnHeaders();
  renderItemsList();
  syncUIFromState(getMineruBatchState());
}

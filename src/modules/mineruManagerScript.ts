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
  type AutoWatchStatus,
} from "./mineruAutoWatch";
import {
  getMineruAvailabilityForAttachmentId,
  repairMineruCaches,
  type MineruCacheRepairResult,
} from "./contextPanel/mineruSync";
import {
  buildMineruTagIndex,
  computeMineruTagAvailability,
  filterMineruItemsForFolderAndTagView,
  filterMineruItemsForTagView,
  getSortedMineruTagInfos,
  normalizeMineruTagName,
  type MineruFolderScope,
  type MineruTagInfo,
  type MineruTagScope,
} from "./mineruTagIndex";
import { getMineruParseEligibility } from "./mineruParseEligibility";
import {
  buildMineruFilenameMatcher,
  type MineruFilenameMatcher,
} from "../utils/mineruConfig";

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
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 520;
const MINERU_STATUS_DOT_COLORS: Record<MineruStatus, string> = {
  cached: "#10b981",
  processing: "#f59e0b",
  failed: "#ef4444",
  idle: "#d1d5db",
};

export type MineruManagerActionLabelInput = {
  batchRunning: boolean;
  batchPaused: boolean;
  autoProcessing: boolean;
  autoPaused: boolean;
  selectedCount: number;
  filteredCount: number;
  deleteFilteredCount?: number;
  filterActive: boolean;
};

export function getMineruManagerActionLabels(
  input: MineruManagerActionLabelInput,
): { startLabel: string; deleteLabel: string } {
  let startLabel: string;
  if (
    (input.batchRunning && !input.batchPaused) ||
    (input.autoProcessing && !input.autoPaused)
  ) {
    startLabel = t("Pause");
  } else if (input.selectedCount > 0) {
    startLabel = `${t("Start Selected")} (${input.selectedCount})`;
  } else if (input.filterActive) {
    startLabel = `${t("Start Filtered")} (${input.filteredCount})`;
  } else {
    startLabel = t("Start All");
  }

  const deleteLabel =
    input.selectedCount > 0
      ? `${t("Delete Cache")} (${input.selectedCount})`
      : input.filterActive
        ? `${t("Delete Filtered Cache")} (${
            input.deleteFilteredCount ?? input.filteredCount
          })`
        : t("Delete All Cache");

  return { startLabel, deleteLabel };
}

export type MineruParentStatusChild = Pick<
  MineruItemEntry,
  "availability" | "excluded"
> & {
  status: MineruStatus;
};

export function getMineruParentDisplayStatus(
  children: readonly MineruParentStatusChild[],
): MineruStatus {
  if (children.some((child) => child.status === "processing")) {
    return "processing";
  }
  if (children.some((child) => child.status === "failed")) {
    return "failed";
  }
  const actionableChildren = children.filter((child) => !child.excluded);
  if (!actionableChildren.length) {
    return children.length > 0 &&
      children.every(
        (child) =>
          child.status === "cached" || child.availability !== "missing",
      )
      ? "cached"
      : "idle";
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
  const sidebarInitialCssText = sidebar.style.cssText;

  // ── Data ───────────────────────────────────────────────────────────────────
  let allItems: MineruItemEntry[] = [];
  let collectionTree: MineruCollectionNode[] = [];
  const directItemsMap = new Map<number, Set<number>>();
  const recursiveItemsMap = new Map<number, Set<number>>();
  let tagIndex = new Map<string, MineruTagInfo>();

  // ── UI state ───────────────────────────────────────────────────────────────
  let activeCollectionId: MineruFolderScope = "all";
  let tagScope: MineruTagScope = "all";
  const selectedTags = new Set<string>();
  let tagFilterQuery = "";
  let showAutomaticTags = false;
  let tagFilterMenuOpen = false;
  let sidebarFolderPaneRatio = 0.42;
  let sidebarWidthPx: number | null = null;
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

  function resolveTagColor(name: string): string | null {
    try {
      const color = (
        Zotero as unknown as {
          Tags?: { getColor?: (libraryID: number, name: string) => unknown };
          Libraries?: { userLibraryID?: number };
        }
      ).Tags?.getColor?.(Zotero.Libraries.userLibraryID, name);
      if (typeof color === "string") return color;
      if (
        color &&
        typeof color === "object" &&
        typeof (color as { color?: unknown }).color === "string"
      ) {
        return (color as { color: string }).color;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function rebuildTagIndex(): void {
    tagIndex = buildMineruTagIndex(allItems, {
      includeAutomatic: showAutomaticTags,
      getColor: resolveTagColor,
    });
    pruneSelectedTags();
  }

  function pruneSelectedTags(): void {
    for (const tag of [...selectedTags]) {
      if (!tagIndex.has(tag)) selectedTags.delete(tag);
    }
  }

  function isFolderFilterActive(): boolean {
    return activeCollectionId !== "all";
  }

  function isTagFilterActive(): boolean {
    return (
      selectedTags.size > 0 ||
      tagScope === "allTagged" ||
      tagScope === "untagged"
    );
  }

  function getActiveFolderItemIdSet(): ReadonlySet<number> | undefined {
    if (typeof activeCollectionId !== "number") return undefined;
    return recursiveItemsMap.get(activeCollectionId);
  }

  function getFolderScopedItems(): MineruItemEntry[] {
    return filterMineruItemsForFolderAndTagView(allItems, {
      folderScope: activeCollectionId,
      folderItemIds: getActiveFolderItemIdSet(),
      tagScope: "all",
      includeAutomatic: showAutomaticTags,
    });
  }

  function getCombinedFilteredItems(): MineruItemEntry[] {
    return filterMineruItemsForFolderAndTagView(allItems, {
      folderScope: activeCollectionId,
      folderItemIds: getActiveFolderItemIdSet(),
      tagScope,
      selectedTags,
      includeAutomatic: showAutomaticTags,
    });
  }

  function getFilteredItemIds(): number[] {
    return getCombinedFilteredItems().map((item) => item.attachmentId);
  }

  function getProcessableFilteredItemIds(): number[] {
    return getCombinedFilteredItems()
      .filter((item) => !item.excluded && !isMineruAvailable(item))
      .map((item) => item.attachmentId);
  }

  function isCombinedFilterActive(): boolean {
    return isFolderFilterActive() || isTagFilterActive();
  }

  function findCollectionName(
    nodes: readonly MineruCollectionNode[],
    collectionId: number,
  ): string | null {
    for (const node of nodes) {
      if (node.collectionId === collectionId) return node.name;
      const child = findCollectionName(node.children, collectionId);
      if (child) return child;
    }
    return null;
  }

  function getActiveFolderFilterSummary(): string {
    if (activeCollectionId === "all") return "";
    if (activeCollectionId === "unfiled") return t("Unfiled Items");
    return (
      findCollectionName(collectionTree, activeCollectionId) ||
      `Collection ${activeCollectionId}`
    );
  }

  function getTagFilterSummary(): string {
    if (selectedTags.size > 0) {
      return [...selectedTags].sort((a, b) => a.localeCompare(b)).join(" + ");
    }
    if (tagScope === "allTagged") return t("All Tagged");
    if (tagScope === "untagged") return t("Untagged");
    return "";
  }

  function getCombinedFilterSummary(): string {
    const parts = [
      getActiveFolderFilterSummary(),
      getTagFilterSummary(),
    ].filter(Boolean);
    return parts.join(" + ");
  }

  function getVisibleItems(): MineruItemEntry[] {
    const items = getCombinedFilteredItems();
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

  // ── Update contextual buttons ──────────────────────────────────────────────
  function updateButtons(): void {
    const s = getMineruBatchState();
    const aw = getAutoWatchStatus();
    const filterActive = isCombinedFilterActive();
    const filteredCount = filterActive
      ? getProcessableFilteredItemIds().length
      : 0;
    const deleteFilteredCount = filterActive ? getFilteredItemIds().length : 0;
    const labels = getMineruManagerActionLabels({
      batchRunning: s.running,
      batchPaused: s.paused,
      autoProcessing: aw.isProcessing,
      autoPaused: aw.isPaused,
      selectedCount: selectedIds.size,
      filteredCount,
      deleteFilteredCount,
      filterActive,
    });

    if (startBtn) {
      startBtn.disabled = isRepairing;
      startBtn.textContent = labels.startLabel;
    }

    if (repairBtn) {
      repairBtn.disabled = isRepairing || s.running || aw.isProcessing;
      repairBtn.textContent = isRepairing
        ? t("Repairing...")
        : t("Repair Cache");
    }

    if (deleteBtn) {
      deleteBtn.disabled = isRepairing;
      deleteBtn.textContent = labels.deleteLabel;
    }
  }

  function getAutoWatchStatusMessage(status: AutoWatchStatus): string {
    if (status.statusMessage) return status.statusMessage;
    if (status.isPaused && status.queueLength > 0) {
      return `${t("MinerU auto-parse paused")} (${status.queueLength} ${t("queued")})`;
    }
    if (status.isProcessing && status.currentItem) {
      return `${t("Auto-parsing")}: ${status.currentItem}`;
    }
    if (status.queueLength > 0) {
      return `${t("Queued for MinerU auto-parse")} (${status.queueLength})`;
    }
    return "";
  }

  function syncUIFromAutoWatchStatus(status: AutoWatchStatus): boolean {
    const msg = getAutoWatchStatusMessage(status);
    if (!statusEl || !msg) return false;
    statusEl.textContent = msg;
    statusEl.title = msg;
    statusEl.style.color = status.isPaused ? "#b45309" : "";
    return true;
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
  function getSidebarFolderPaneBasis(): string {
    return `${Math.round(sidebarFolderPaneRatio * 1000) / 10}%`;
  }

  function clampSidebarFolderPaneRatio(value: number): number {
    return Math.min(0.72, Math.max(0.24, value));
  }

  function clampSidebarWidth(value: number): number {
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
  }

  function applySidebarWidth(width: number): void {
    if (!sidebar) return;
    const nextWidth = clampSidebarWidth(width);
    sidebarWidthPx = nextWidth;
    sidebar.style.width = `${nextWidth}px`;
    sidebar.style.minWidth = `${SIDEBAR_MIN_WIDTH}px`;
    sidebar.style.maxWidth = `${SIDEBAR_MAX_WIDTH}px`;
  }

  function startSidebarWidthResize(event: MouseEvent): void {
    if (!sidebar) return;
    event.preventDefault();
    event.stopPropagation();
    stopActiveResize?.();

    const startX = event.clientX;
    const startWidth =
      sidebar.getBoundingClientRect().width || SIDEBAR_MIN_WIDTH;
    const rootEl = doc.documentElement as HTMLElement;
    const previousCursor = rootEl.style.cursor;
    const previousUserSelect = rootEl.style.userSelect;

    const onMouseMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      applySidebarWidth(startWidth + moveEvent.clientX - startX);
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

  function startSidebarPaneResize(
    event: MouseEvent,
    folderPane: HTMLElement,
  ): void {
    if (!sidebar) return;
    event.preventDefault();
    event.stopPropagation();
    stopActiveResize?.();

    const sidebarRect = sidebar.getBoundingClientRect();
    const rootEl = doc.documentElement as HTMLElement;
    const previousCursor = rootEl.style.cursor;
    const previousUserSelect = rootEl.style.userSelect;

    const updateFromClientY = (clientY: number) => {
      const nextRatio = clampSidebarFolderPaneRatio(
        (clientY - sidebarRect.top) / Math.max(1, sidebarRect.height),
      );
      sidebarFolderPaneRatio = nextRatio;
      folderPane.style.flex = `0 0 ${getSidebarFolderPaneBasis()}`;
    };

    const onMouseMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      updateFromClientY(moveEvent.clientY);
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
    rootEl.style.cursor = "row-resize";
    rootEl.style.userSelect = "none";
    win.addEventListener("mousemove", onMouseMove, true);
    win.addEventListener("mouseup", onMouseUp, true);
  }

  function renderSidebar(): void {
    if (!sidebar) return;
    sidebar.style.cssText = `${sidebarInitialCssText}; display: flex; flex-direction: column; overflow: hidden; padding: 0; position: relative;`;
    sidebar.style.minWidth = `${SIDEBAR_MIN_WIDTH}px`;
    sidebar.style.maxWidth = `${SIDEBAR_MAX_WIDTH}px`;
    if (sidebarWidthPx !== null) applySidebarWidth(sidebarWidthPx);
    sidebar.innerHTML = "";
    const folderPane = doc.createElement("div");
    folderPane.style.cssText = `flex: 0 0 ${getSidebarFolderPaneBasis()}; min-height: 96px; max-height: 72%; overflow: auto; padding: 4px 0;`;
    sidebar.appendChild(folderPane);

    renderFolderSidebar(folderPane);

    const separator = doc.createElement("div");
    separator.style.cssText =
      "position: relative; flex: 0 0 7px; cursor: row-resize; z-index: 1;";
    const separatorLine = doc.createElement("div");
    separatorLine.style.cssText =
      "position: absolute; left: 0; right: 0; top: 3px; border-top: 1px solid rgba(128,128,128,0.24); pointer-events: none;";
    separator.appendChild(separatorLine);
    separator.addEventListener("mousedown", (event) =>
      startSidebarPaneResize(event as MouseEvent, folderPane),
    );
    sidebar.appendChild(separator);

    const tagPane = doc.createElement("div");
    tagPane.style.cssText =
      "flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;";
    sidebar.appendChild(tagPane);
    renderTagPanel(tagPane);

    const sidebarResizeHandle = doc.createElement("div");
    sidebarResizeHandle.title = "Resize sidebar";
    sidebarResizeHandle.setAttribute("aria-label", "Resize sidebar");
    sidebarResizeHandle.style.cssText =
      "position: absolute; top: 0; right: -4px; bottom: 0; width: 8px; cursor: col-resize; z-index: 3;";
    sidebarResizeHandle.addEventListener("mousedown", (event) =>
      startSidebarWidthResize(event as MouseEvent),
    );
    sidebar.appendChild(sidebarResizeHandle);
  }

  function renderFolderSidebar(parent: HTMLElement): void {
    const inner = doc.createElement("div");
    inner.style.cssText = "min-width: max-content;";
    parent.appendChild(inner);
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

  function getAllTaggedCount(baseItems: readonly MineruItemEntry[]): number {
    return filterMineruItemsForTagView(baseItems, {
      scope: "allTagged",
      includeAutomatic: showAutomaticTags,
    }).length;
  }

  function getUntaggedCount(baseItems: readonly MineruItemEntry[]): number {
    return filterMineruItemsForTagView(baseItems, {
      scope: "untagged",
      includeAutomatic: showAutomaticTags,
    }).length;
  }

  function renderTagPanel(panel: HTMLElement): void {
    panel.innerHTML = "";
    panel.style.background = "transparent";
    const baseItems = getFolderScopedItems();
    const baseTagIndex = buildMineruTagIndex(baseItems, {
      includeAutomatic: showAutomaticTags,
      getColor: resolveTagColor,
    });

    const header = doc.createElement("div");
    header.style.cssText =
      "display: flex; align-items: center; gap: 8px; padding: 8px 10px 6px; font-size: 12px; font-weight: 600; border-bottom: 1px solid rgba(128,128,128,0.16);";
    const headerLabel = doc.createElement("span");
    headerLabel.textContent = t("Tags");
    headerLabel.style.cssText = "flex: 1; min-width: 0;";
    header.appendChild(headerLabel);
    const headerCount = doc.createElement("span");
    headerCount.textContent = String(baseItems.length);
    headerCount.style.cssText =
      "font-size: 11px; color: var(--fill-secondary, #888); font-weight: 500;";
    header.appendChild(headerCount);
    panel.appendChild(header);

    const scopes = doc.createElement("div");
    scopes.style.cssText =
      "display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 10px 0;";
    panel.appendChild(scopes);
    scopes.appendChild(
      createTagScopePill(
        "allTagged",
        `${t("All Tagged")} ${getAllTaggedCount(baseItems)}`,
      ),
    );
    scopes.appendChild(
      createTagScopePill(
        "untagged",
        `${t("Untagged")} ${getUntaggedCount(baseItems)}`,
      ),
    );

    const scroll = doc.createElement("div");
    scroll.style.cssText =
      "flex: 1; min-height: 0; overflow: auto; padding: 8px 10px 10px;";
    panel.appendChild(scroll);

    const tagInfos = getSortedMineruTagInfos(tagIndex)
      .map((info) => {
        const baseInfo = baseTagIndex.get(info.name);
        return {
          ...info,
          count: baseInfo?.count ?? 0,
          itemIds: baseInfo ? new Set(baseInfo.itemIds) : new Set<number>(),
        };
      })
      .sort((a, b) => {
        const countDelta = b.count - a.count;
        return countDelta || a.name.localeCompare(b.name);
      })
      .filter((info) => {
      if (!tagFilterQuery.trim()) return true;
      return info.name
        .toLowerCase()
        .includes(tagFilterQuery.trim().toLowerCase());
      });
    const filteredItems = getCombinedFilteredItems();
    const availability = computeMineruTagAvailability(
      getSortedMineruTagInfos(tagIndex),
      filteredItems,
      selectedTags,
      showAutomaticTags,
    );

    const selectedLine = doc.createElement("div");
    selectedLine.style.cssText =
      "display: flex; flex-wrap: wrap; align-items: center; gap: 4px 5px; min-height: 22px;";
    scroll.appendChild(selectedLine);

    if (selectedTags.size > 0) {
      for (const tagName of [...selectedTags].sort((a, b) =>
        a.localeCompare(b),
      )) {
        const info = tagIndex.get(tagName);
        selectedLine.appendChild(createTagChip(tagName, info, true, true));
      }
    }

    const cloud = doc.createElement("div");
    cloud.style.cssText =
      "display: flex; flex-wrap: wrap; align-content: flex-start; align-items: flex-start; gap: 4px 6px; padding-top: 4px;";
    scroll.appendChild(cloud);

    for (const info of tagInfos) {
      if (selectedTags.has(info.name)) continue;
      const state = availability.get(info.name);
      cloud.appendChild(
        createTagChip(info.name, info, false, !!state?.available),
      );
    }

    if (tagInfos.length === 0) {
      const empty = doc.createElement("div");
      empty.textContent =
        tagFilterQuery.trim().length > 0
          ? t("No matching tags.")
          : t("No tags found. Add tags to your items in Zotero.");
      empty.style.cssText =
        "font-size: 11.5px; color: var(--fill-secondary, #888); line-height: 1.35; padding: 4px 0;";
      cloud.appendChild(empty);
    }

    const meta = doc.createElement("div");
    meta.style.cssText =
      "border-top: 1px solid rgba(128,128,128,0.16); padding: 6px 10px 7px; font-size: 11px; color: var(--fill-secondary, #888); line-height: 1.35;";
    if (selectedTags.size > 0) {
      const clearRow = doc.createElement("div");
      clearRow.style.cssText =
        "display: flex; align-items: center; gap: 8px; margin-bottom: 3px;";
      const selectedText = doc.createElement("span");
      selectedText.textContent = `${selectedTags.size} ${t("selected")}`;
      selectedText.style.cssText = "flex: 1; min-width: 0;";
      clearRow.appendChild(selectedText);
      const clear = doc.createElement("button");
      clear.type = "button";
      clear.textContent = `× ${t("clear")}`;
      clear.style.cssText =
        "border: none; background: transparent; color: var(--fill-secondary, #888); padding: 0 2px; font-size: 11px; cursor: pointer;";
      clear.addEventListener("click", () => {
        selectedTags.clear();
        tagScope = "all";
        selectedIds.clear();
        lastClickedId = null;
        renderSidebar();
        renderItemsList();
        updateButtons();
      });
      clearRow.appendChild(clear);
      meta.appendChild(clearRow);
    }

    if (isCombinedFilterActive()) {
      const match = doc.createElement("div");
      match.textContent = `${filteredItems.length} ${t("papers match")} ${getCombinedFilterSummary()}`;
      match.title = match.textContent;
      match.style.cssText =
        "white-space: normal; overflow-wrap: anywhere; color: FieldText;";
      meta.appendChild(match);
    }
    panel.appendChild(meta);
    panel.appendChild(createTagFilterBar());
  }

  function createTagScopePill(
    scope: MineruTagScope,
    label: string,
  ): HTMLElement {
    const pill = doc.createElement("button");
    pill.type = "button";
    pill.textContent = label;
    pill.style.cssText =
      "border: none; border-radius: 4px; padding: 2px 5px; font-size: 11px; line-height: 1.35; cursor: pointer; background: transparent; color: var(--fill-secondary, #888);";
    if (tagScope === scope && selectedTags.size === 0) {
      pill.style.background = "color-mix(in srgb, FieldText 18%, transparent)";
      pill.style.color = "FieldText";
    }
    pill.addEventListener("click", () => {
      tagScope = tagScope === scope && selectedTags.size === 0 ? "all" : scope;
      selectedTags.clear();
      selectedIds.clear();
      lastClickedId = null;
      renderSidebar();
      renderItemsList();
      updateButtons();
    });
    return pill;
  }

  function createTagChip(
    name: string,
    info: MineruTagInfo | undefined,
    selected: boolean,
    available: boolean,
  ): HTMLElement {
    const chip = doc.createElement("button");
    chip.type = "button";
    chip.title = info ? `${name} (${info.count})` : name;
    const color = info?.color || "";
    const label = selected || available ? name : `(${name})`;
    chip.textContent = label;
    chip.style.cssText =
      "border: none; border-radius: 4px; padding: 2px 4px; font-size: 12px; line-height: 1.35; background: transparent; color: FieldText; cursor: pointer; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    if (color) {
      chip.style.borderLeft = `3px solid ${color}`;
      chip.style.paddingLeft = "5px";
    }
    if (selected) {
      chip.style.background = "color-mix(in srgb, FieldText 32%, transparent)";
      chip.style.color = "FieldText";
      chip.style.fontWeight = "500";
    } else if (!available) {
      chip.style.color = "var(--fill-secondary, #888)";
      chip.style.opacity = "0.62";
      chip.disabled = true;
      chip.style.cursor = "default";
    }
    chip.addEventListener("click", () => {
      const normalized = normalizeMineruTagName(name);
      if (!normalized) return;
      tagScope = "all";
      if (selectedTags.has(normalized)) selectedTags.delete(normalized);
      else selectedTags.add(normalized);
      selectedIds.clear();
      lastClickedId = null;
      renderSidebar();
      renderItemsList();
      updateButtons();
    });
    return chip;
  }

  function createTagFilterIcon(): SVGSVGElement {
    const svg = doc.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    ) as unknown as SVGSVGElement;
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "19");
    svg.setAttribute("height", "19");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "display: block;";

    const path = doc.createElementNS(
      "http://www.w3.org/2000/svg",
      "path",
    ) as unknown as SVGPathElement;
    path.setAttribute("d", "M5 6.5h14l-5.4 6.2v4.5l-3.2 2.3v-6.8L5 6.5z");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.65");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-linecap", "round");
    svg.appendChild(path);
    return svg;
  }

  function createTagFilterBar(): HTMLElement {
    const bar = doc.createElement("div");
    bar.style.cssText =
      "border-top: 1px solid rgba(128,128,128,0.16); padding: 8px 6px 7px; display: flex; align-items: center; gap: 6px;";

    const input = doc.createElement("input");
    input.type = "search";
    input.placeholder = t("Filter Tags");
    input.value = tagFilterQuery;
    input.style.cssText =
      "flex: 1; min-width: 0; height: 30px; border: 1px solid rgba(0,0,0,0.16); border-radius: 7px; padding: 3px 10px; font-size: 12px; background: rgba(0,0,0,0.28); color: FieldText; box-shadow: inset 0 1px 1px rgba(0,0,0,0.18);";
    input.addEventListener("input", () => {
      tagFilterQuery = input.value;
      const selectionStart = input.selectionStart ?? tagFilterQuery.length;
      renderSidebar();
      const next = doc.querySelector(
        `#${idPrefix}-mineru-mgr-tag-filter`,
      ) as HTMLInputElement | null;
      next?.focus();
      next?.setSelectionRange(selectionStart, selectionStart);
    });
    input.id = `${idPrefix}-mineru-mgr-tag-filter`;
    bar.appendChild(input);

    const menuWrap = doc.createElement("div");
    menuWrap.style.cssText =
      "position: relative; flex: 0 0 auto; display: flex; align-items: center; gap: 1px;";
    const menuBtn = doc.createElement("button");
    menuBtn.type = "button";
    menuBtn.title = t("Show automatic tags");
    menuBtn.setAttribute("aria-label", t("Show automatic tags"));
    menuBtn.appendChild(createTagFilterIcon());
    menuBtn.style.cssText =
      "height: 30px; width: 25px; border: none; border-radius: 5px; background: transparent; color: var(--fill-secondary, #9ca3af); display: inline-flex; align-items: center; justify-content: center; padding: 0; cursor: pointer;";
    menuBtn.addEventListener("click", () => {
      tagFilterMenuOpen = !tagFilterMenuOpen;
      renderSidebar();
    });
    menuWrap.appendChild(menuBtn);

    const chevronBtn = doc.createElement("button");
    chevronBtn.type = "button";
    chevronBtn.title = t("Show automatic tags");
    chevronBtn.setAttribute("aria-label", t("Show automatic tags"));
    chevronBtn.textContent = "⌄";
    chevronBtn.style.cssText =
      "height: 30px; width: 11px; border: none; border-radius: 4px; background: transparent; color: var(--fill-secondary, #9ca3af); font-size: 13px; line-height: 1; padding: 0; cursor: pointer;";
    chevronBtn.addEventListener("click", () => {
      tagFilterMenuOpen = !tagFilterMenuOpen;
      renderSidebar();
    });
    menuWrap.appendChild(chevronBtn);

    if (tagFilterMenuOpen) {
      const menu = doc.createElement("div");
      menu.style.cssText =
        "position: absolute; right: 0; bottom: 28px; min-width: 160px; background: Field; color: FieldText; border: 1px solid rgba(128,128,128,0.28); border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.18); padding: 4px 0; z-index: 4;";
      const row = doc.createElement("label");
      row.style.cssText =
        "display: flex; align-items: center; gap: 6px; padding: 5px 9px; font-size: 11.5px; cursor: pointer; white-space: nowrap;";
      const cb = doc.createElement("input");
      cb.type = "checkbox";
      cb.checked = showAutomaticTags;
      cb.style.cssText = "margin: 0;";
      cb.addEventListener("change", () => {
        showAutomaticTags = cb.checked;
        tagFilterMenuOpen = false;
        selectedIds.clear();
        lastClickedId = null;
        rebuildTagIndex();
        renderSidebar();
        renderItemsList();
        updateButtons();
      });
      row.appendChild(cb);
      const text = doc.createElement("span");
      text.textContent = t("Show automatic tags");
      row.appendChild(text);
      menu.appendChild(row);
      menuWrap.appendChild(menu);
    }

    bar.appendChild(menuWrap);
    return bar;
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
    nm.style.cssText = "flex: 1; white-space: nowrap; font-size: 12px;";
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
    nm.style.cssText = "flex: 1; white-space: nowrap; font-size: 12px;";
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

  function renderHeaderStatusDot(label: HTMLSpanElement): void {
    label.textContent = "";
    const marker = doc.createElement("span");
    marker.setAttribute("aria-hidden", "true");
    marker.style.cssText =
      "display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: 0 0 auto;";
    label.appendChild(marker);
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
      if (key === "cached") {
        label.style.display = "inline-flex";
        label.style.alignItems = "center";
        label.style.justifyContent = "center";
        label.style.overflow = "visible";
        label.style.textOverflow = "clip";
      }
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
        if (key === "cached") {
          renderHeaderStatusDot(labelEl);
        } else {
          labelEl.textContent = label || "";
        }
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

  function getSkippedLabel(item: MineruItemEntry): string {
    return item.excluded && item.exclusionLabel
      ? `${t("Skipped")}: ${item.exclusionLabel}`
      : "";
  }

  function getParentSkippedLabel(group: MineruParentGroup): string {
    const excludedChildren = group.children.filter((child) => child.excluded);
    if (!excludedChildren.length) return "";
    if (excludedChildren.length !== group.children.length) return "";
    const labels = new Set(
      excludedChildren.map((child) => child.exclusionLabel).filter(Boolean),
    );
    if (labels.size === 1) {
      return `${t("Skipped")}: ${[...labels][0]}`;
    }
    return t("Skipped");
  }

  function appendSkippedBadge(row: HTMLDivElement, label: string): void {
    if (!label) return;
    const badge = doc.createElement("span");
    badge.style.cssText =
      "flex-shrink: 0; font-size: 10.5px; color: #a16207; background: rgba(245,158,11,0.12); border-radius: 3px; padding: 1px 4px; white-space: nowrap;";
    badge.textContent = label;
    row.appendChild(badge);
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
    appendSkippedBadge(row, getSkippedLabel(item));

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
      appendSkippedBadge(parentRow, getParentSkippedLabel(group));

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

  async function countExcludedIdsForProcessing(
    ids: readonly number[],
    filenameMatcher: MineruFilenameMatcher,
  ): Promise<number> {
    let count = 0;
    for (const id of ids) {
      const pdfItem = Zotero.Items.get(id);
      if (!pdfItem) continue;
      const parentId = Number(pdfItem.parentID);
      const parentItem =
        Number.isFinite(parentId) && parentId > 0
          ? Zotero.Items.get(Math.floor(parentId))
          : null;
      const eligibility = await getMineruParseEligibility(parentItem, pdfItem, {
        filenameMatcher,
      });
      if (eligibility.excluded) count++;
    }
    return count;
  }

  async function processSelectionWithOptionalOverride(
    ids: number[],
  ): Promise<void> {
    if (!ids.length) return;
    const filenameMatcher = buildMineruFilenameMatcher();
    const excludedCount = await countExcludedIdsForProcessing(
      ids,
      filenameMatcher,
    );
    const overrideEligibility =
      excludedCount > 0
        ? await confirmDialog(
            `${excludedCount} ${t(
              "selected item(s) are skipped by MinerU parsing filters. Parse anyway?",
            )}`,
          )
        : false;
    if (excludedCount > 0 && !overrideEligibility) return;
    await processSelectedItems(ids, { filenameMatcher, overrideEligibility });
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
      if (ids.length > 0) void processSelectionWithOptionalOverride(ids);
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
      } else if (syncUIFromAutoWatchStatus(getAutoWatchStatus())) {
        // Auto-parse uses a separate queue from manual batch processing.
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
        void processSelectionWithOptionalOverride(ids);
        renderItemsList();
      } else if (isCombinedFilterActive()) {
        const ids = getProcessableFilteredItemIds();
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
      } else if (isCombinedFilterActive()) {
        const ids = getFilteredItemIds();
        if (
          !(await confirmDialog(
            `${t("Delete MinerU cache for")} ${ids.length} ${t("item(s) in this filter?")}`,
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
    rebuildTagIndex();
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
                ["add", "modify", "delete", "remove"].includes(event)) ||
              (type === "tag" &&
                ["add", "modify", "delete", "remove"].includes(event))
            ) {
              debouncedRefresh();
            }
          },
        },
        ["item", "collection", "tag"],
        "mineruManager",
      );
    }
  } catch {
    /* Notifier not available */
  }

  const unsubscribeAutoWatch = onAutoWatchProgress((status) => {
    if (!syncUIFromAutoWatchStatus(status)) {
      syncUIFromState(getMineruBatchState());
    }
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

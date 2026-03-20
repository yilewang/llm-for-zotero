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
} from "./mineruBatchProcessor";
import type {
  MineruBatchState,
  MineruItemEntry,
  MineruCollectionNode,
} from "./mineruBatchProcessor";
import { getMineruItemDir } from "./contextPanel/mineruCache";

function fmtDate(d: string): string {
  if (!d) return "";
  try { const o = new Date(d); return `${o.getFullYear()}-${String(o.getMonth()+1).padStart(2,"0")}-${String(o.getDate()).padStart(2,"0")}`; }
  catch { return d.slice(0,10); }
}

type SortKey = "title" | "firstCreator" | "year" | "dateAdded";
type SortDir = "asc" | "desc";

export async function registerMineruManagerScript(
  win: Window,
  idPrefix = "llmforzotero",
): Promise<void> {
  const doc = win.document;
  const $ = (suffix: string) => doc.getElementById(`${idPrefix}-mineru-mgr-${suffix}`);

  const progressEl = $("progress") as HTMLProgressElement | null;
  const progressLabel = $("progress-label") as HTMLSpanElement | null;
  const startBtn = $("start-btn") as HTMLButtonElement | null;
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

  // Sorting
  let sortKey: SortKey = "dateAdded";
  let sortDir: SortDir = "desc";

  // Multi-selection (shift/cmd+click)
  const selectedIds = new Set<number>();
  let lastClickedId: number | null = null; // for shift-range
  // Keep an ordered list of visible items for shift-range
  let visibleItemsOrdered: MineruItemEntry[] = [];

  // ── Helpers ────────────────────────────────────────────────────────────────
  function updateProgressBar(): void {
    if (progressEl) { progressEl.max = localTotalCount || 1; progressEl.value = localProcessedCount; }
    if (progressLabel) { progressLabel.textContent = `${localProcessedCount} / ${localTotalCount}`; }
  }

  function getVisibleItems(): MineruItemEntry[] {
    let items: MineruItemEntry[];
    if (activeCollectionId === "all") items = allItems;
    else if (activeCollectionId === "unfiled") items = allItems.filter((i) => i.collectionIds.length === 0);
    else {
      const ids = recursiveItemsMap.get(activeCollectionId as number);
      items = ids ? allItems.filter((i) => ids.has(i.attachmentId)) : [];
    }
    // Sort
    const copy = [...items];
    const dir = sortDir === "asc" ? 1 : -1;
    copy.sort((a, b) => {
      const va = a[sortKey] || "";
      const vb = b[sortKey] || "";
      return va < vb ? -dir : va > vb ? dir : 0;
    });
    return copy;
  }

  function isSubfolder(): boolean {
    return activeCollectionId !== "all" && activeCollectionId !== "unfiled";
  }

  function getFolderItemIds(): number[] {
    if (activeCollectionId === "unfiled") return allItems.filter((i) => i.collectionIds.length === 0).map((i) => i.attachmentId);
    if (typeof activeCollectionId === "number") {
      const s = recursiveItemsMap.get(activeCollectionId);
      return s ? [...s] : [];
    }
    return [];
  }

  // ── Update contextual buttons ──────────────────────────────────────────────
  function updateButtons(): void {
    const s = getMineruBatchState();
    const hasSelection = selectedIds.size > 0;
    const inFolder = isSubfolder() || activeCollectionId === "unfiled";

    if (startBtn) {
      if (s.running && !s.paused) {
        startBtn.textContent = "Pause";
      } else if (hasSelection) {
        startBtn.textContent = `Start Selected (${selectedIds.size})`;
      } else if (inFolder) {
        startBtn.textContent = "Start Folder";
      } else {
        startBtn.textContent = "Start All";
      }
    }

    if (deleteBtn) {
      if (hasSelection) {
        deleteBtn.textContent = `Delete Selected (${selectedIds.size})`;
      } else if (inFolder) {
        deleteBtn.textContent = "Delete Folder";
      } else {
        deleteBtn.textContent = "Delete All";
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
        if (!s) { s = new Set(); directItemsMap.set(colId, s); }
        s.add(item.attachmentId);
      }
    }
    function recurse(node: MineruCollectionNode): Set<number> {
      const set = new Set<number>(directItemsMap.get(node.collectionId) || []);
      for (const child of node.children) { for (const id of recurse(child)) set.add(id); }
      recursiveItemsMap.set(node.collectionId, set);
      return set;
    }
    for (const root of collectionTree) recurse(root);
  }

  // ── Sidebar ────────────────────────────────────────────────────────────────
  function renderSidebar(): void {
    if (!sidebar) return;
    sidebar.innerHTML = "";
    sidebar.appendChild(createSidebarEntry("My Library", "all", 0, allItems.length));
    for (const root of collectionTree) renderSidebarNode(sidebar, root, 1);
    const uc = allItems.filter((i) => i.collectionIds.length === 0).length;
    if (uc > 0) sidebar.appendChild(createSidebarEntry("Unfiled Items", "unfiled", 0, uc));
  }

  function createSidebarEntry(name: string, key: number | "all" | "unfiled", indent: number, count: number): HTMLElement {
    const row = doc.createElement("div");
    row.style.cssText = "display: flex; align-items: center; gap: 4px; padding: 4px 8px; cursor: pointer; user-select: none; border-radius: 4px; margin: 1px 4px;";
    row.style.paddingLeft = `${8 + indent * 14}px`;
    if (activeCollectionId === key) row.style.background = "color-mix(in srgb, var(--color-accent, #2563eb) 15%, transparent)";
    const icon = doc.createElement("span"); icon.style.cssText = "font-size: 12px; flex-shrink: 0;";
    icon.textContent = key === "all" ? "\uD83D\uDCDA" : "\uD83D\uDCC1"; row.appendChild(icon);
    const nm = doc.createElement("span"); nm.style.cssText = "flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px;";
    nm.style.fontWeight = key === "all" || activeCollectionId === key ? "600" : "400"; nm.textContent = name; row.appendChild(nm);
    const ct = doc.createElement("span"); ct.style.cssText = "font-size: 10px; color: #888; flex-shrink: 0;"; ct.textContent = String(count); row.appendChild(ct);
    row.addEventListener("click", () => { activeCollectionId = key; selectedIds.clear(); lastClickedId = null; renderSidebar(); renderItemsList(); updateButtons(); });
    return row;
  }

  function renderSidebarNode(parent: HTMLElement, node: MineruCollectionNode, indent: number): void {
    const recSet = recursiveItemsMap.get(node.collectionId);
    const count = recSet ? recSet.size : 0;
    const hasChildren = node.children.length > 0;
    const collapsed = collapsedSidebar.has(node.collectionId);
    const row = doc.createElement("div");
    row.style.cssText = "display: flex; align-items: center; gap: 4px; padding: 4px 8px; cursor: pointer; user-select: none; border-radius: 4px; margin: 1px 4px;";
    row.style.paddingLeft = `${8 + indent * 14}px`;
    if (activeCollectionId === node.collectionId) row.style.background = "color-mix(in srgb, var(--color-accent, #2563eb) 15%, transparent)";
    if (hasChildren) {
      const chev = doc.createElement("span"); chev.style.cssText = "width: 10px; flex-shrink: 0; font-size: 9px; text-align: center; color: #888; font-weight: 700;";
      chev.textContent = collapsed ? "\u203A" : "\u2304";
      chev.addEventListener("click", (e) => { e.stopPropagation(); if (collapsed) collapsedSidebar.delete(node.collectionId); else collapsedSidebar.add(node.collectionId); renderSidebar(); });
      row.appendChild(chev);
    } else { const sp = doc.createElement("span"); sp.style.cssText = "width: 10px; flex-shrink: 0;"; row.appendChild(sp); }
    const icon = doc.createElement("span"); icon.style.cssText = "font-size: 12px; flex-shrink: 0;"; icon.textContent = "\uD83D\uDCC1"; row.appendChild(icon);
    const nm = doc.createElement("span"); nm.style.cssText = "flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px;";
    nm.style.fontWeight = activeCollectionId === node.collectionId ? "600" : "400"; nm.textContent = node.name; row.appendChild(nm);
    const ct = doc.createElement("span"); ct.style.cssText = "font-size: 10px; color: #888; flex-shrink: 0;"; ct.textContent = String(count); row.appendChild(ct);
    row.addEventListener("click", () => { activeCollectionId = node.collectionId; selectedIds.clear(); lastClickedId = null; renderSidebar(); renderItemsList(); updateButtons(); });
    parent.appendChild(row);
    if (hasChildren && !collapsed) { for (const child of node.children) renderSidebarNode(parent, child, indent + 1); }
  }

  // ── Column header sorting ──────────────────────────────────────────────────
  function renderColumnHeaders(): void {
    if (!colHeaders) return;
    const spans = colHeaders.querySelectorAll("[data-sort-key]");
    for (let i = 0; i < spans.length; i++) {
      const sp = spans[i] as HTMLElement;
      const key = sp.getAttribute("data-sort-key") as SortKey;
      const label = { title: "Title", firstCreator: "Author", year: "Year", dateAdded: "Added" }[key];
      if (sortKey === key) {
        sp.textContent = `${label} ${sortDir === "asc" ? "\u25B2" : "\u25BC"}`;
        sp.style.color = "FieldText";
      } else {
        sp.textContent = label;
        sp.style.color = "#888";
      }
    }
  }

  if (colHeaders) {
    colHeaders.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest("[data-sort-key]") as HTMLElement | null;
      if (!target) return;
      const key = target.getAttribute("data-sort-key") as SortKey;
      if (sortKey === key) { sortDir = sortDir === "asc" ? "desc" : "asc"; }
      else { sortKey = key; sortDir = key === "dateAdded" ? "desc" : "asc"; }
      renderColumnHeaders();
      renderItemsList();
    });
  }

  // ── Items list rendering ───────────────────────────────────────────────────
  function renderItemsList(): void {
    if (!itemsList) return;
    itemsList.innerHTML = "";
    dotElements.clear();

    visibleItemsOrdered = getVisibleItems();
    const hasSelection = selectedIds.size > 0;
    const fragment = doc.createDocumentFragment();

    for (const item of visibleItemsOrdered) {
      const row = doc.createElement("div");
      row.setAttribute("data-attachment-id", String(item.attachmentId));
      const isSelected = selectedIds.has(item.attachmentId);
      row.style.cssText = "display: flex; align-items: center; gap: 8px; padding: 4px 10px; border-bottom: 1px solid rgba(128,128,128,0.1); cursor: default;";
      if (isSelected) row.style.background = "color-mix(in srgb, var(--color-accent, #2563eb) 12%, transparent)";

      // Checkbox (shown when any selection exists)
      if (hasSelection) {
        const cb = doc.createElement("input");
        cb.type = "checkbox";
        cb.checked = isSelected;
        cb.style.cssText = "flex-shrink: 0; margin: 0; cursor: pointer;";
        cb.addEventListener("change", () => {
          if (cb.checked) selectedIds.add(item.attachmentId);
          else selectedIds.delete(item.attachmentId);
          lastClickedId = item.attachmentId;
          renderItemsList();
          updateButtons();
        });
        cb.addEventListener("click", (e) => e.stopPropagation());
        row.appendChild(cb);
      }

      // Status dot
      const dot = doc.createElement("span");
      dot.style.cssText = "width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;";
      dot.style.background = item.cached ? "#10b981" : "#d1d5db";
      dotElements.set(item.attachmentId, dot);
      row.appendChild(dot);

      // Title
      const titleSpan = doc.createElement("span");
      titleSpan.style.cssText = "flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px;";
      titleSpan.textContent = item.title; titleSpan.title = item.title;
      row.appendChild(titleSpan);

      // Author
      const authorSpan = doc.createElement("span");
      authorSpan.style.cssText = "flex: 0 0 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: #888;";
      authorSpan.textContent = item.firstCreator;
      row.appendChild(authorSpan);

      // Year
      const yearSpan = doc.createElement("span");
      yearSpan.style.cssText = "flex: 0 0 40px; text-align: right; font-size: 11.5px; color: #888;";
      yearSpan.textContent = item.year;
      row.appendChild(yearSpan);

      // Date added
      const dateSpan = doc.createElement("span");
      dateSpan.style.cssText = "flex: 0 0 72px; text-align: right; font-size: 11px; color: #888;";
      dateSpan.textContent = fmtDate(item.dateAdded);
      row.appendChild(dateSpan);

      // Click handler: shift=range, cmd/ctrl=toggle, plain=single select
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).tagName === "INPUT") return;
        handleRowClick(item.attachmentId, e as MouseEvent);
      });

      // Right-click
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        contextMenuItemId = item.attachmentId;
        if (!selectedIds.has(item.attachmentId)) {
          // If right-clicking an unselected row, select only it
          selectedIds.clear();
          selectedIds.add(item.attachmentId);
          lastClickedId = item.attachmentId;
          renderItemsList();
          updateButtons();
        }
        showContextMenu(e as MouseEvent);
      });

      fragment.appendChild(row);
    }

    itemsList.appendChild(fragment);
    updateButtons();
  }

  function handleRowClick(attachmentId: number, e: MouseEvent): void {
    const isMeta = e.metaKey || e.ctrlKey;
    const isShift = e.shiftKey;

    if (isShift && lastClickedId !== null) {
      // Range select: from lastClickedId to attachmentId
      const idxA = visibleItemsOrdered.findIndex((i) => i.attachmentId === lastClickedId);
      const idxB = visibleItemsOrdered.findIndex((i) => i.attachmentId === attachmentId);
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
    if (contextMenu && contextMenu.style.display !== "none" &&
      !(e.target as HTMLElement)?.closest?.(`#${contextMenuId}`)) {
      hideContextMenu();
    }
  });
  doc.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") {
      hideContextMenu();
      if (selectedIds.size > 0) {
        selectedIds.clear(); lastClickedId = null;
        renderItemsList(); updateButtons();
      }
    }
  });

  function addHover(el: HTMLElement): void {
    el.addEventListener("mouseenter", () => { el.style.background = "color-mix(in srgb, currentColor 10%, transparent)"; });
    el.addEventListener("mouseleave", () => { el.style.background = "transparent"; });
  }

  if (ctxProcessBtn) {
    ctxProcessBtn.addEventListener("click", () => {
      const ids = selectedIds.size > 0 ? [...selectedIds] : (contextMenuItemId != null ? [contextMenuItemId] : []);
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
          const Cc = (globalThis as unknown as { Components?: { classes?: Record<string, { createInstance: (iface: unknown) => unknown }> } }).Components?.classes;
          const Ci = (globalThis as unknown as { Components?: { interfaces?: Record<string, unknown> } }).Components?.interfaces;
          if (Cc && Ci) {
            const f = Cc["@mozilla.org/file/local;1"]?.createInstance(Ci.nsIFile as unknown) as
              | { initWithPath?: (p: string) => void; reveal?: () => void } | undefined;
            if (f?.initWithPath) { f.initWithPath(dirPath); f.reveal?.(); }
          }
        } catch {
          try { (Zotero as unknown as { launchFile?: (p: string) => void }).launchFile?.(dirPath); } catch { /* */ }
        }
      }
    });
    addHover(ctxShowFolderBtn);
  }

  if (ctxDeleteBtn) {
    ctxDeleteBtn.addEventListener("click", async () => {
      const ids = selectedIds.size > 0 ? [...selectedIds] : (contextMenuItemId != null ? [contextMenuItemId] : []);
      hideContextMenu();
      for (const id of ids) {
        await deleteMineruCacheForItem(id);
        const dot = dotElements.get(id);
        if (dot) dot.style.background = "#d1d5db";
        const entry = allItems.find((i) => i.attachmentId === id);
        if (entry) entry.cached = false;
      }
      localProcessedCount = allItems.filter((i) => i.cached).length;
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
    if (errorSpan) {
      if (s.error) { errorSpan.style.display = "inline"; errorSpan.textContent = s.error; }
      else { errorSpan.style.display = "none"; errorSpan.textContent = ""; }
    }
    if (itemsList) {
      const rows = itemsList.querySelectorAll("[data-attachment-id]");
      for (let i = 0; i < rows.length; i++) {
        const el = rows[i] as HTMLElement;
        const attId = Number(el.getAttribute("data-attachment-id"));
        if (s.currentItemId && attId === s.currentItemId) {
          el.style.background = "color-mix(in srgb, #f59e0b 15%, transparent)";
        } else if (!selectedIds.has(attId)) {
          el.style.background = "";
        }
      }
    }
  }

  let lastSeenCurrentId: number | null = null;
  const unsubscribe = onBatchStateChange((s: MineruBatchState) => {
    syncUIFromState(s);
    if (s.currentItemId) {
      lastSeenCurrentId = s.currentItemId;
    } else if (lastSeenCurrentId !== null) {
      const dot = dotElements.get(lastSeenCurrentId);
      if (dot) dot.style.background = "#10b981";
      const entry = allItems.find((i) => i.attachmentId === lastSeenCurrentId);
      if (entry) entry.cached = true;
      lastSeenCurrentId = null;
    }
  });

  // ── Button handlers ────────────────────────────────────────────────────────
  if (startBtn) {
    startBtn.addEventListener("click", () => {
      const s = getMineruBatchState();
      if (s.running && !s.paused) {
        pauseBatchProcessing();
        return;
      }
      if (selectedIds.size > 0) {
        const ids = [...selectedIds];
        selectedIds.clear(); lastClickedId = null;
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

  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      if (selectedIds.size > 0) {
        if (!win.confirm(`Delete MinerU cache for ${selectedIds.size} selected item(s)?`)) return;
        for (const id of selectedIds) {
          await deleteMineruCacheForItem(id);
          const entry = allItems.find((i) => i.attachmentId === id);
          if (entry) entry.cached = false;
        }
        selectedIds.clear(); lastClickedId = null;
        localProcessedCount = allItems.filter((i) => i.cached).length;
        updateProgressBar();
        renderItemsList();
      } else if (isSubfolder() || activeCollectionId === "unfiled") {
        const ids = getFolderItemIds();
        if (!win.confirm(`Delete MinerU cache for ${ids.length} item(s) in this folder?`)) return;
        for (const id of ids) {
          await deleteMineruCacheForItem(id);
          const entry = allItems.find((i) => i.attachmentId === id);
          if (entry) entry.cached = false;
        }
        localProcessedCount = allItems.filter((i) => i.cached).length;
        updateProgressBar();
        renderItemsList();
      } else {
        if (!win.confirm("Delete all MinerU cached files? This cannot be undone.")) return;
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
    allItems = await getMineruItemList();
    collectionTree = getLibraryCollectionTree();
    buildCollectionMaps();
    localTotalCount = allItems.length;
    localProcessedCount = allItems.filter((i) => i.cached).length;
    updateProgressBar();
  }

  win.addEventListener("unload", () => { unsubscribe(); });

  await loadData();
  renderSidebar();
  renderColumnHeaders();
  renderItemsList();
  syncUIFromState(getMineruBatchState());
}

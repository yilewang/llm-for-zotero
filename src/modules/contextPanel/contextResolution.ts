import {
  sanitizeText,
  normalizeSelectedText,
  truncateSelectedText,
  isLikelyCorruptedSelectedText,
  setStatus,
} from "./textUtils";
import {
  selectedTextCache,
  selectedTextPreviewExpandedCache,
  recentReaderSelectionCache,
} from "./state";
import type { ZoteroTabsState, ResolvedContextSource } from "./types";

function getActiveReaderForSelectedTab(): any | null {
  const tabs = getZoteroTabsState();
  const selectedTabId = tabs?.selectedID;
  if (selectedTabId === undefined || selectedTabId === null) return null;
  return (
    (
      Zotero as unknown as {
        Reader?: { getByTabID?: (id: string | number) => any };
      }
    ).Reader?.getByTabID?.(selectedTabId as string | number) || null
  );
}

function parseItemID(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isTabsState(value: unknown): value is ZoteroTabsState {
  if (!value || typeof value !== "object") return false;
  const obj = value as any;
  return (
    "selectedID" in obj || "selectedType" in obj || Array.isArray(obj._tabs)
  );
}

function getZoteroTabsStateWithSource(): {
  tabs: ZoteroTabsState | null;
  source: string;
} {
  const candidates: Array<{ source: string; value: unknown }> = [];
  const push = (source: string, value: unknown) => {
    candidates.push({ source, value });
  };

  push(
    "local.Zotero.Tabs",
    (Zotero as unknown as { Tabs?: ZoteroTabsState }).Tabs,
  );

  let mainWindow: any = null;
  try {
    mainWindow = Zotero.getMainWindow?.() || null;
  } catch (_error) {
    void _error;
  }
  if (mainWindow) {
    push("mainWindow.Zotero.Tabs", mainWindow.Zotero?.Tabs);
    push("mainWindow.Zotero_Tabs", mainWindow.Zotero_Tabs);
    push("mainWindow.Tabs", mainWindow.Tabs);
  }

  let activePaneWindow: any = null;
  try {
    activePaneWindow =
      Zotero.getActiveZoteroPane?.()?.document?.defaultView || null;
  } catch (_error) {
    void _error;
  }
  if (activePaneWindow) {
    push("activePaneWindow.Zotero.Tabs", activePaneWindow.Zotero?.Tabs);
    push("activePaneWindow.Zotero_Tabs", activePaneWindow.Zotero_Tabs);
  }

  let anyMainWindow: any = null;
  try {
    const windows = Zotero.getMainWindows?.() || [];
    anyMainWindow = windows[0] || null;
  } catch (_error) {
    void _error;
  }
  if (anyMainWindow) {
    push("mainWindows[0].Zotero.Tabs", anyMainWindow.Zotero?.Tabs);
    push("mainWindows[0].Zotero_Tabs", anyMainWindow.Zotero_Tabs);
  }

  try {
    const wmRecent = (Services as any).wm?.getMostRecentWindow?.(
      "navigator:browser",
    ) as any;
    push("wm:navigator:browser.Zotero.Tabs", wmRecent?.Zotero?.Tabs);
    push("wm:navigator:browser.Zotero_Tabs", wmRecent?.Zotero_Tabs);
  } catch (_error) {
    void _error;
  }
  try {
    const wmAny = (Services as any).wm?.getMostRecentWindow?.("") as any;
    push("wm:any.Zotero.Tabs", wmAny?.Zotero?.Tabs);
    push("wm:any.Zotero_Tabs", wmAny?.Zotero_Tabs);
  } catch (_error) {
    void _error;
  }

  const globalAny = globalThis as any;
  push("globalThis.Zotero_Tabs", globalAny.Zotero_Tabs);
  push("globalThis.window.Zotero_Tabs", globalAny.window?.Zotero_Tabs);

  for (const candidate of candidates) {
    if (isTabsState(candidate.value)) {
      return { tabs: candidate.value, source: candidate.source };
    }
  }
  return { tabs: null, source: "none" };
}

function getZoteroTabsState(): ZoteroTabsState | null {
  return getZoteroTabsStateWithSource().tabs;
}

function collectCandidateItemIDsFromObject(source: any): number[] {
  if (!source || typeof source !== "object") return [];
  const directCandidates = [
    source.itemID,
    source.itemId,
    source.attachmentID,
    source.attachmentId,
    source.readerItemID,
    source.readerItemId,
    source.id,
  ];
  const nestedObjects = [
    source.item,
    source.attachment,
    source.reader,
    source.state,
    source.params,
    source.extraData,
  ];
  const out: number[] = [];
  const seen = new Set<number>();
  const pushParsed = (value: unknown) => {
    const parsed = parseItemID(value);
    if (parsed === null || seen.has(parsed)) return;
    seen.add(parsed);
    out.push(parsed);
  };

  for (const candidate of directCandidates) {
    pushParsed(candidate);
  }
  for (const nested of nestedObjects) {
    if (!nested || typeof nested !== "object") continue;
    pushParsed((nested as any).itemID);
    pushParsed((nested as any).itemId);
    pushParsed((nested as any).attachmentID);
    pushParsed((nested as any).attachmentId);
    pushParsed((nested as any).id);
  }
  return out;
}

export function getActiveContextAttachmentFromTabs(): Zotero.Item | null {
  const tabs = getZoteroTabsState();
  if (!tabs) return null;
  const selectedType = `${tabs.selectedType || ""}`.toLowerCase();
  if (selectedType && !selectedType.includes("reader")) return null;

  const selectedId =
    tabs.selectedID === undefined || tabs.selectedID === null
      ? ""
      : `${tabs.selectedID}`;
  if (!selectedId) return null;

  const tabList = Array.isArray(tabs._tabs) ? tabs._tabs : [];
  const activeTab = tabList.find((tab) => `${tab?.id || ""}` === selectedId);
  const activeType = `${activeTab?.type || ""}`.toLowerCase();
  if (!activeTab || (activeType && !activeType.includes("reader"))) return null;

  const data = activeTab.data || {};
  const candidateIDs = collectCandidateItemIDsFromObject(data);
  for (const itemId of candidateIDs) {
    const item = Zotero.Items.get(itemId);
    if (isSupportedContextAttachment(item)) return item;
  }

  // Fallback: map selected tab id to reader instance if available.
  const reader = (
    Zotero as unknown as {
      Reader?: { getByTabID?: (id: string | number) => any };
    }
  ).Reader?.getByTabID?.(selectedId);
  const readerItemId = parseItemID(reader?._item?.id ?? reader?.itemID);
  if (readerItemId !== null) {
    const readerItem = Zotero.Items.get(readerItemId);
    if (isSupportedContextAttachment(readerItem)) return readerItem;
  }

  return null;
}

function isSupportedContextAttachment(
  item: Zotero.Item | null | undefined,
): item is Zotero.Item {
  return Boolean(
    item &&
    item.isAttachment() &&
    item.attachmentContentType === "application/pdf",
  );
}

function getContextItemLabel(item: Zotero.Item): string {
  const title = sanitizeText(item.getField("title") || "").trim();
  if (title) return title;
  return `Attachment ${item.id}`;
}

function getFirstPdfChildAttachment(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  if (!item || item.isAttachment()) return null;
  const attachments = item.getAttachments();
  for (const attachmentId of attachments) {
    const attachment = Zotero.Items.get(attachmentId);
    if (isSupportedContextAttachment(attachment)) {
      return attachment;
    }
  }
  return null;
}

export function resolveContextSourceItem(
  panelItem: Zotero.Item,
): ResolvedContextSource {
  const activeItem = getActiveContextAttachmentFromTabs();
  if (activeItem) {
    const label = getContextItemLabel(activeItem);
    return {
      contextItem: activeItem,
      statusText: `Using context: ${label} (active tab)`,
    };
  }

  if (
    panelItem.isAttachment() &&
    panelItem.attachmentContentType === "application/pdf"
  ) {
    const label = getContextItemLabel(panelItem);
    return {
      contextItem: panelItem,
      statusText: `using the selected ${label} as context`,
    };
  }

  const parentItem =
    panelItem.isAttachment() && panelItem.parentID
      ? Zotero.Items.get(panelItem.parentID) || null
      : panelItem;
  const firstPdfChild = getFirstPdfChildAttachment(parentItem);
  if (firstPdfChild && parentItem) {
    const parentTitle =
      sanitizeText(parentItem.getField("title") || "").trim() ||
      `Item ${parentItem.id}`;
    return {
      contextItem: firstPdfChild,
      statusText: `using first child item from ${parentTitle} as context`,
    };
  }

  const selectedTab = getZoteroTabsState();
  const selectedId =
    selectedTab?.selectedID === undefined || selectedTab?.selectedID === null
      ? ""
      : `${selectedTab.selectedID}`;
  const activeTab = Array.isArray(selectedTab?._tabs)
    ? selectedTab!._tabs!.find((tab) => `${tab?.id || ""}` === selectedId)
    : null;
  const dataKeys = activeTab?.data
    ? Object.keys(activeTab.data).slice(0, 6)
    : [];
  return {
    contextItem: null,
    statusText: `No active tab PDF context (tab=${selectedTab?.selectedID ?? "?"}, type=${selectedTab?.selectedType ?? "?"}, tabType=${activeTab?.type ?? "?"}, dataKeys=${dataKeys.join("|") || "-"})`,
  };
}

export function getItemSelectionCacheKeys(
  item: Zotero.Item | null | undefined,
): number[] {
  if (!item) return [];
  const keys = new Set<number>();
  keys.add(item.id);
  if (item.isAttachment() && item.parentID) {
    keys.add(item.parentID);
  } else {
    const attachments = item.getAttachments();
    for (const attId of attachments) {
      const att = Zotero.Items.get(attId);
      if (att && att.attachmentContentType === "application/pdf") {
        keys.add(att.id);
      }
    }
  }
  return Array.from(keys);
}

export function getActiveReaderSelectionText(
  panelDoc: Document,
  currentItem?: Zotero.Item | null,
): string {
  const reader = getActiveReaderForSelectedTab();

  const selectionFrom = (doc?: Document | null): string => {
    if (!doc) return "";
    const selected = doc.defaultView?.getSelection?.()?.toString() || "";
    return normalizeSelectedText(selected);
  };

  // 1. Check the reader's outer iframe document
  const readerDoc =
    (reader?._iframeWindow?.document as Document | undefined) ||
    (reader?._iframe?.contentDocument as Document | undefined) ||
    (reader?._window?.document as Document | undefined);
  const fromReaderDoc = selectionFrom(readerDoc);
  if (fromReaderDoc) return fromReaderDoc;

  // 2. Check the inner view iframe(s) (PDF text-layer, EPUB, snapshot)
  const internalReader = reader?._internalReader;
  const views = [internalReader?._primaryView, internalReader?._secondaryView];
  for (const view of views) {
    if (!view) continue;
    const viewDoc =
      (view._iframeWindow?.document as Document | undefined) ||
      (view._iframe?.contentDocument as Document | undefined);
    if (viewDoc) {
      const fromView = selectionFrom(viewDoc);
      if (fromView) return fromView;
    }
  }

  // 3. Check the panel document and its iframes
  const fromPanelDoc = selectionFrom(panelDoc);
  if (fromPanelDoc) return fromPanelDoc;

  const iframes = Array.from(
    panelDoc.querySelectorAll("iframe"),
  ) as HTMLIFrameElement[];
  for (const frame of iframes) {
    const fromFrame = selectionFrom(frame.contentDocument);
    if (fromFrame) return fromFrame;
  }

  // 4. Cache fallback — populated by the renderTextSelectionPopup event
  //    handler which also tracks popup lifecycle via a sentinel element.
  //    When the popup is dismissed the sentinel becomes disconnected and
  //    the cache entry is automatically cleared, preventing stale results.
  const itemId = reader?._item?.id || reader?.itemID;
  if (typeof itemId === "number") {
    const readerItem = Zotero.Items.get(itemId) || null;
    const readerKeys = getItemSelectionCacheKeys(readerItem);
    for (const key of readerKeys) {
      const fromCache = recentReaderSelectionCache.get(key) || "";
      if (fromCache) return fromCache;
    }
  }

  const panelKeys = getItemSelectionCacheKeys(currentItem || null);
  for (const key of panelKeys) {
    const fromCache = recentReaderSelectionCache.get(key) || "";
    if (fromCache) return fromCache;
  }

  return "";
}

export function applySelectedTextPreview(body: Element, itemId: number) {
  const previewBox = body.querySelector(
    "#llm-selected-context",
  ) as HTMLDivElement | null;
  const previewText = body.querySelector(
    "#llm-selected-context-text",
  ) as HTMLDivElement | null;
  const previewWarning = body.querySelector(
    "#llm-selected-context-warning",
  ) as HTMLDivElement | null;
  const selectTextBtn = body.querySelector(
    "#llm-select-text",
  ) as HTMLButtonElement | null;
  if (!previewBox || !previewText) return;
  const selectedText = selectedTextCache.get(itemId) || "";
  if (!selectedText) {
    previewBox.style.display = "none";
    previewBox.classList.remove("expanded");
    previewBox.setAttribute("aria-expanded", "false");
    previewBox.title = "";
    previewText.textContent = "";
    selectedTextPreviewExpandedCache.delete(itemId);
    if (previewWarning) previewWarning.style.display = "none";
    if (selectTextBtn) {
      selectTextBtn.classList.remove("llm-action-btn-active");
    }
    return;
  }
  const expanded = selectedTextPreviewExpandedCache.get(itemId) === true;
  previewBox.style.display = "flex";
  previewBox.classList.toggle("expanded", expanded);
  previewBox.setAttribute("aria-expanded", expanded ? "true" : "false");
  previewBox.title = expanded
    ? "Click to collapse selected context"
    : "Click to expand selected context";
  previewText.textContent = expanded
    ? selectedText
    : truncateSelectedText(selectedText);
  if (previewWarning) {
    previewWarning.style.display = isLikelyCorruptedSelectedText(selectedText)
      ? "block"
      : "none";
  }
  if (selectTextBtn) {
    selectTextBtn.classList.add("llm-action-btn-active");
  }
}

export function includeSelectedTextFromReader(
  body: Element,
  item: Zotero.Item,
  prefetchedText?: string,
): boolean {
  const selectedText =
    normalizeSelectedText(prefetchedText || "") ||
    getActiveReaderSelectionText(body.ownerDocument as Document, item);
  const status = body.querySelector("#llm-status") as HTMLElement | null;
  if (!selectedText) {
    if (status) setStatus(status, "No text selected in reader", "error");
    return false;
  }
  selectedTextCache.set(item.id, selectedText);
  selectedTextPreviewExpandedCache.set(item.id, false);
  applySelectedTextPreview(body, item.id);
  if (status) setStatus(status, "Selected text included", "ready");
  const inputEl = body.querySelector(
    "#llm-input",
  ) as HTMLTextAreaElement | null;
  inputEl?.focus({ preventScroll: true });
  return true;
}

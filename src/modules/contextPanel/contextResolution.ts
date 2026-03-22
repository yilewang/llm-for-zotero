import {
  sanitizeText,
  normalizeSelectedText,
  isLikelyCorruptedSelectedText,
  setStatus,
} from "./textUtils";
import {
  buildNoteContextIdentityKey,
  normalizeNoteContextRef,
  normalizePaperContextRefs,
  normalizePositiveInt,
  normalizeSelectedTextSource,
} from "./normalizers";
import { MAX_SELECTED_TEXT_CONTEXTS } from "./constants";
import {
  selectedTextCache,
  selectedTextPreviewExpandedCache,
  selectedNotePreviewExpandedCache,
  recentReaderSelectionCache,
  pinnedSelectedTextKeys,
} from "./state";
import type {
  NoteContextRef,
  ZoteroTabsState,
  ResolvedContextSource,
  SelectedTextContext,
  SelectedTextSource,
  PaperContextRef,
} from "./types";
import {
  isGlobalPortalItem,
  resolveActiveNoteSession,
} from "./portalScope";
import { formatPaperCitationLabel } from "./paperAttribution";
import {
  getFirstSelectionFromReader,
  getSelectionFromDocument,
} from "./readerSelection";
import { resolveCurrentSelectionPageLocationFromReader } from "./livePdfSelectionLocator";
import {
  buildPinnedSelectedTextKey,
  isPinnedSelectedText,
  prunePinnedSelectedTextKeys,
} from "./setupHandlers/controllers/pinnedContextController";
import { readNoteSnapshot } from "./notes";

type SelectedTextPageLocation = {
  contextItemId?: number;
  pageIndex?: number;
  pageLabel?: string;
};

type NoteChipSnapshot = {
  noteId?: number;
  title: string;
  text: string;
};

type CreateNoteChipOptions = {
  ownerId: number;
  expanded: boolean;
  pinned?: boolean;
  removableIndex?: number;
  noteChipKind: "active" | "selected";
};

/**
 * Last known selected tab ID.  Updated every time we successfully read
 * selectedID from Zotero.Tabs (which fails during nested Tabs.select
 * transitions).  Used by restoreNonReaderTab as a fallback.
 */
let _lastKnownSelectedTabId: string | number | null = null;

export function getLastKnownSelectedTabId(): string | number | null {
  return _lastKnownSelectedTabId;
}

export function getActiveReaderForSelectedTab(): any | null {
  const tabs = getZoteroTabsState();
  const selectedTabId = tabs?.selectedID;
  if (selectedTabId === undefined || selectedTabId === null) return null;
  // Cache whenever we see a valid ID
  _lastKnownSelectedTabId = selectedTabId;
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

/**
 * Select a Zotero tab by ID using the same fallback discovery as
 * getZoteroTabsState.  Returns true if a select() call was made.
 */
export function selectZoteroTab(tabId: string | number): boolean {
  const { tabs, source } = getZoteroTabsStateWithSource();
  if (!tabs) return false;
  const tabsAny = tabs as unknown as {
    select?: (id: string | number) => void;
  };
  if (typeof tabsAny.select === "function") {
    try {
      tabsAny.select(tabId);
      ztoolkit.log(`[LLM] selectZoteroTab: selected "${tabId}" via ${source}`);
      return true;
    } catch (err) {
      ztoolkit.log(`[LLM] selectZoteroTab: error selecting "${tabId}" via ${source} — ${err}`);
    }
  }
  return false;
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
  if (isGlobalPortalItem(panelItem)) {
    return {
      contextItem: null,
      statusText: "No active paper context. Type / to add papers.",
    };
  }

  const activeNoteSession = resolveActiveNoteSession(panelItem);
  if (activeNoteSession?.noteKind === "standalone") {
    return {
      contextItem: null,
      statusText: `Using note: ${activeNoteSession.title}`,
    };
  }
  if (activeNoteSession?.noteKind === "item" && activeNoteSession.parentItemId) {
    const activeItem = getActiveContextAttachmentFromTabs();
    if (activeItem?.parentID === activeNoteSession.parentItemId) {
      const label = getContextItemLabel(activeItem);
      return {
        contextItem: activeItem,
        statusText: `Using note: ${activeNoteSession.title} with parent paper context ${label}`,
      };
    }
    const parentItem = Zotero.Items.get(activeNoteSession.parentItemId) || null;
    const firstPdfChild = getFirstPdfChildAttachment(parentItem);
    if (firstPdfChild) {
      const label = getContextItemLabel(firstPdfChild);
      return {
        contextItem: firstPdfChild,
        statusText: `Using note: ${activeNoteSession.title} with parent paper context ${label}`,
      };
    }
    return {
      contextItem: null,
      statusText: `Using note: ${activeNoteSession.title}; parent item has no PDF context`,
    };
  }

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
  if (item.isAttachment?.() && item.parentID) {
    keys.add(item.parentID);
  } else if (item.isRegularItem?.()) {
    try {
      const attachments = item.getAttachments();
      for (const attId of attachments) {
        const att = Zotero.Items.get(attId);
        if (att && att.attachmentContentType === "application/pdf") {
          keys.add(att.id);
        }
      }
    } catch {
      /* getAttachments() not available for this item type */
    }
  }
  return Array.from(keys);
}

export function getActiveReaderSelectionText(
  panelDoc: Document,
  currentItem?: Zotero.Item | null,
): string {
  const reader = getActiveReaderForSelectedTab();
  const fromReader = getFirstSelectionFromReader(reader, normalizeSelectedText);
  if (fromReader) return fromReader;

  // 3. Check the panel document and its iframes
  const fromPanelDoc = getSelectionFromDocument(
    panelDoc,
    normalizeSelectedText,
  );
  if (fromPanelDoc) return fromPanelDoc;

  const iframes = Array.from(
    panelDoc.querySelectorAll("iframe"),
  ) as HTMLIFrameElement[];
  for (const frame of iframes) {
    const fromFrame = getSelectionFromDocument(
      frame.contentDocument,
      normalizeSelectedText,
    );
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

function normalizeSelectedTextContexts(value: unknown): SelectedTextContext[] {
  if (Array.isArray(value)) {
    const out: SelectedTextContext[] = [];
    for (const entry of value) {
      if (typeof entry === "string") {
        const normalizedText = normalizeSelectedText(entry);
        if (!normalizedText) continue;
        out.push({ text: normalizedText, source: "pdf" });
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const typed = entry as {
        text?: unknown;
        source?: unknown;
        paperContext?: unknown;
        noteContext?: unknown;
        contextItemId?: unknown;
        pageIndex?: unknown;
        pageLabel?: unknown;
      };
      const normalizedText = normalizeSelectedText(
        typeof typed.text === "string" ? typed.text : "",
      );
      if (!normalizedText) continue;
      const normalizedPaperContext = normalizePaperContextRefs([
        typed.paperContext,
      ])[0];
      const normalizedNoteContext = normalizeNoteContextRef(
        typed.noteContext,
        { sanitizeText },
      );
      const contextItemId = normalizePositiveInt(typed.contextItemId) || undefined;
      const rawPageIndex = Number(typed.pageIndex);
      const pageIndex =
        Number.isFinite(rawPageIndex) && rawPageIndex >= 0
          ? Math.floor(rawPageIndex)
          : undefined;
      const pageLabel =
        typeof typed.pageLabel === "string" && typed.pageLabel.trim()
          ? typed.pageLabel.trim()
          : pageIndex !== undefined
            ? `${pageIndex + 1}`
            : undefined;
      out.push({
        text: normalizedText,
        source: normalizeSelectedTextSource(typed.source),
        paperContext: normalizedPaperContext,
        noteContext: normalizedNoteContext,
        contextItemId,
        pageIndex,
        pageLabel,
      });
    }
    return out;
  }
  if (typeof value === "string") {
    const normalized = normalizeSelectedText(value);
    return normalized ? [{ text: normalized, source: "pdf" }] : [];
  }
  return [];
}

export function getSelectedTextContexts(itemId: number): string[] {
  return getSelectedTextContextEntries(itemId).map((entry) => entry.text);
}

export function getSelectedTextContextEntries(
  itemId: number,
): SelectedTextContext[] {
  const raw = selectedTextCache.get(itemId);
  const normalized = normalizeSelectedTextContexts(raw);
  const synced = syncNoteBackedSelectedTextContexts(normalized);
  if (synced.changed) {
    selectedTextCache.set(itemId, synced.contexts);
  }
  return synced.contexts;
}

export function setSelectedTextContexts(itemId: number, texts: string[]): void {
  const normalized = texts
    .map((text) => normalizeSelectedText(text))
    .filter(Boolean)
    .map((text) => ({ text, source: "pdf" as const }));
  setSelectedTextContextEntries(itemId, normalized);
}

function resolveNoteItemFromContext(
  noteContext?: NoteContextRef | null,
): Zotero.Item | null {
  if (!noteContext) return null;
  const noteItemId = normalizePositiveInt(noteContext.noteItemId);
  if (noteItemId) {
    const noteItem = Zotero.Items.get(noteItemId) || null;
    if (noteItem) return noteItem;
  }
  const libraryID = normalizePositiveInt(noteContext.libraryID);
  const noteItemKey =
    typeof noteContext.noteItemKey === "string" && noteContext.noteItemKey.trim()
      ? noteContext.noteItemKey.trim().toUpperCase()
      : "";
  const getByLibraryAndKey = (Zotero.Items as unknown as {
    getByLibraryAndKey?: (
      libraryID: number,
      key: string,
    ) => Zotero.Item | null | undefined;
  }).getByLibraryAndKey;
  if (libraryID && noteItemKey && typeof getByLibraryAndKey === "function") {
    return getByLibraryAndKey(libraryID, noteItemKey) || null;
  }
  return null;
}

function syncNoteBackedSelectedTextContexts(
  contexts: SelectedTextContext[],
): {
  contexts: SelectedTextContext[];
  changed: boolean;
} {
  let changed = false;
  const nextContexts = contexts.map((entry) => {
    if (entry.source !== "note" || !entry.noteContext) {
      return entry;
    }
    const noteItem = resolveNoteItemFromContext(entry.noteContext);
    const snapshot = readNoteSnapshot(noteItem);
    if (!snapshot?.text) {
      return entry;
    }
    const nextNoteContext: NoteContextRef = {
      libraryID: snapshot.libraryID,
      noteItemKey: snapshot.noteItemKey || entry.noteContext.noteItemKey,
      noteItemId: snapshot.noteId,
      parentItemId: snapshot.parentItemId,
      parentItemKey: snapshot.parentItemKey || entry.noteContext.parentItemKey,
      noteKind: snapshot.noteKind,
      title: snapshot.title || entry.noteContext.title || `Note ${snapshot.noteId}`,
    };
    if (
      entry.text === snapshot.text &&
      buildNoteContextIdentityKey(entry.noteContext) ===
        buildNoteContextIdentityKey(nextNoteContext) &&
      entry.noteContext.noteItemId === nextNoteContext.noteItemId &&
      entry.noteContext.parentItemId === nextNoteContext.parentItemId &&
      entry.noteContext.parentItemKey === nextNoteContext.parentItemKey &&
      entry.noteContext.noteKind === nextNoteContext.noteKind &&
      entry.noteContext.title === nextNoteContext.title
    ) {
      return entry;
    }
    changed = true;
    return {
      ...entry,
      text: snapshot.text,
      noteContext: nextNoteContext,
    };
  });
  return { contexts: nextContexts, changed };
}

function normalizeSelectedTextPageLocation(
  location?: SelectedTextPageLocation | null,
): SelectedTextPageLocation | undefined {
  if (!location || typeof location !== "object") return undefined;
  const contextItemId = normalizePositiveInt(location.contextItemId) || undefined;
  const rawPageIndex = Number(location.pageIndex);
  const pageIndex =
    Number.isFinite(rawPageIndex) && rawPageIndex >= 0
      ? Math.floor(rawPageIndex)
      : undefined;
  const pageLabel =
    typeof location.pageLabel === "string" && location.pageLabel.trim()
      ? location.pageLabel.trim()
      : pageIndex !== undefined
        ? `${pageIndex + 1}`
        : undefined;
  if (
    contextItemId === undefined &&
    pageIndex === undefined &&
    pageLabel === undefined
  ) {
    return undefined;
  }
  return {
    contextItemId,
    pageIndex,
    pageLabel,
  };
}

function buildSelectedTextContext(
  text: string,
  source: SelectedTextSource,
  paperContext?: PaperContextRef | null,
  location?: SelectedTextPageLocation | null,
  noteContext?: NoteContextRef | null,
): SelectedTextContext {
  const normalizedPaperContext = normalizePaperContextRefs([paperContext])[0];
  const normalizedLocation = normalizeSelectedTextPageLocation(location);
  const normalizedNoteContext = normalizeNoteContextRef(noteContext, {
    sanitizeText,
  });
  return {
    text,
    source: normalizeSelectedTextSource(source),
    paperContext: normalizedPaperContext,
    noteContext: normalizedNoteContext,
    contextItemId: normalizedLocation?.contextItemId,
    pageIndex: normalizedLocation?.pageIndex,
    pageLabel: normalizedLocation?.pageLabel,
  };
}

export function formatSelectedTextContextPageLabel(
  context: SelectedTextContext,
): string | null {
  if (!Number.isFinite(context.pageIndex) || (context.pageIndex as number) < 0) {
    return null;
  }
  const label =
    typeof context.pageLabel === "string" && context.pageLabel.trim()
      ? context.pageLabel.trim()
      : `${Math.floor(context.pageIndex as number) + 1}`;
  return `page ${label}`;
}

export function setSelectedTextContextEntries(
  itemId: number,
  contexts: SelectedTextContext[],
): void {
  const normalized = normalizeSelectedTextContexts(contexts);
  if (!normalized.length) {
    selectedTextCache.delete(itemId);
    selectedTextPreviewExpandedCache.delete(itemId);
    return;
  }
  selectedTextCache.set(itemId, normalized);
}

function areSelectedTextContextsEquivalent(
  left: SelectedTextContext,
  right: SelectedTextContext,
): boolean {
  const leftPaperKey = left.paperContext
    ? `${left.paperContext.itemId}:${left.paperContext.contextItemId}`
    : "";
  const rightPaperKey = right.paperContext
    ? `${right.paperContext.itemId}:${right.paperContext.contextItemId}`
    : "";
  return (
    left.text === right.text &&
    left.source === right.source &&
    leftPaperKey === rightPaperKey &&
    buildNoteContextIdentityKey(left.noteContext) ===
      buildNoteContextIdentityKey(right.noteContext) &&
    (left.contextItemId || 0) === (right.contextItemId || 0) &&
    (left.pageIndex ?? -1) === (right.pageIndex ?? -1) &&
    (left.pageLabel || "") === (right.pageLabel || "")
  );
}

export function syncSelectedTextContextForSource(
  itemId: number,
  text: string,
  source: SelectedTextSource,
  options?: {
    paperContext?: PaperContextRef | null;
    location?: SelectedTextPageLocation | null;
    noteContext?: NoteContextRef | null;
  },
): boolean {
  const normalizedSource = normalizeSelectedTextSource(source);
  const existingContexts = getSelectedTextContextEntries(itemId);
  const retainedContexts = existingContexts.filter(
    (entry) => entry.source !== normalizedSource,
  );
  const normalizedText = normalizeSelectedText(text || "");
  if (!normalizedText) {
    if (retainedContexts.length === existingContexts.length) {
      return false;
    }
    setSelectedTextContextEntries(itemId, retainedContexts);
    selectedTextPreviewExpandedCache.delete(itemId);
    return true;
  }

  const nextContext = buildSelectedTextContext(
    normalizedText,
    normalizedSource,
    options?.paperContext,
    options?.location,
    options?.noteContext,
  );
  const existingContext = existingContexts.find(
    (entry) => entry.source === normalizedSource,
  );
  if (
    existingContext &&
    retainedContexts.length === existingContexts.length - 1 &&
    areSelectedTextContextsEquivalent(existingContext, nextContext)
  ) {
    return false;
  }

  const nextContexts =
    normalizedSource === "note-edit"
      ? [nextContext, ...retainedContexts]
      : [...retainedContexts, nextContext];
  setSelectedTextContextEntries(itemId, nextContexts);
  selectedTextPreviewExpandedCache.delete(itemId);
  return true;
}

export function appendSelectedTextContextForItem(
  itemId: number,
  text: string,
  source: SelectedTextSource = "pdf",
  paperContext?: PaperContextRef | null,
  location?: SelectedTextPageLocation | null,
  noteContext?: NoteContextRef | null,
): boolean {
  const normalizedText = normalizeSelectedText(text || "");
  if (!normalizedText) return false;
  const existingContexts = getSelectedTextContextEntries(itemId);
  const dedupeKey = (entry: SelectedTextContext): string => {
    const sourceKey = entry.source;
    const paperKey = entry.paperContext
      ? `${entry.paperContext.itemId}:${entry.paperContext.contextItemId}`
      : "-";
    const noteKey = buildNoteContextIdentityKey(entry.noteContext) || "-";
    const contextItemId = Number.isFinite(entry.contextItemId)
      ? Math.floor(entry.contextItemId as number)
      : 0;
    const pageIndex = Number.isFinite(entry.pageIndex)
      ? Math.floor(entry.pageIndex as number)
      : -1;
    return `${sourceKey}\u241f${noteKey}\u241f${entry.text}\u241f${paperKey}\u241f${contextItemId}\u241f${pageIndex}`;
  };
  const incomingEntry = buildSelectedTextContext(
    normalizedText,
    source,
    paperContext,
    location,
    noteContext,
  );
  const incomingKey = dedupeKey(incomingEntry);
  if (existingContexts.some((entry) => dedupeKey(entry) === incomingKey)) {
    return false;
  }
  if (existingContexts.length >= MAX_SELECTED_TEXT_CONTEXTS) return false;
  setSelectedTextContextEntries(itemId, [...existingContexts, incomingEntry]);
  selectedTextPreviewExpandedCache.delete(itemId);
  return true;
}

export function getSelectedTextExpandedIndex(
  itemId: number,
  count: number,
): number {
  const raw = selectedTextPreviewExpandedCache.get(itemId) as unknown;
  const normalized = (() => {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return Math.floor(raw);
    }
    if (raw === true) return 0;
    return -1;
  })();
  if (normalized < 0 || normalized >= count) {
    selectedTextPreviewExpandedCache.delete(itemId);
    return -1;
  }
  return normalized;
}

export function setSelectedTextExpandedIndex(
  itemId: number,
  index: number | null,
): void {
  if (index === null || index < 0 || !Number.isFinite(index)) {
    selectedTextPreviewExpandedCache.delete(itemId);
    return;
  }
  selectedTextPreviewExpandedCache.set(itemId, Math.floor(index));
}

export function isNoteContextExpanded(itemId: number): boolean {
  return selectedNotePreviewExpandedCache.get(itemId) === true;
}

export function setNoteContextExpanded(
  itemId: number,
  expanded: boolean | null,
): void {
  if (expanded !== true) {
    selectedNotePreviewExpandedCache.delete(itemId);
    return;
  }
  selectedNotePreviewExpandedCache.set(itemId, true);
}

type AddSelectedTextContextOptions = {
  noSelectionStatusText?: string;
  successStatusText?: string;
  focusInput?: boolean;
  source?: SelectedTextSource;
  paperContext?: PaperContextRef | null;
  location?: SelectedTextPageLocation | null;
  noteContext?: NoteContextRef | null;
};

export function addSelectedTextContext(
  body: Element,
  itemId: number,
  text: string,
  options: AddSelectedTextContextOptions = {},
): boolean {
  const normalizedText = normalizeSelectedText(text || "");
  const status = ((body as any).__llmFloatedPanel || body).querySelector("#llm-status") as HTMLElement | null;
  if (!normalizedText) {
    if (status && options.noSelectionStatusText) {
      setStatus(status, options.noSelectionStatusText, "error");
    }
    return false;
  }

  const appended = appendSelectedTextContextForItem(
    itemId,
    normalizedText,
    options.source || "pdf",
    options.paperContext,
    options.location,
    options.noteContext,
  );
  if (!appended) {
    if (status) setStatus(status, "Text Context up to 5", "error");
    return false;
  }
  applySelectedTextPreview(body, itemId);
  if (status && options.successStatusText) {
    setStatus(status, options.successStatusText, "ready");
  }
  if (options.focusInput !== false) {
    const inputEl = ((body as any).__llmFloatedPanel || body).querySelector(
      "#llm-input",
    ) as HTMLTextAreaElement | null;
    inputEl?.focus({ preventScroll: true });
  }
  return true;
}

function resolveNoteChipSnapshot(
  note: number | NoteContextRef,
  fallback?: {
    title?: string;
    text?: string;
  },
): NoteChipSnapshot | null {
  const normalizedNoteId =
    typeof note === "number" && Number.isFinite(note) && note > 0
      ? Math.floor(note)
      : typeof note === "object"
        ? normalizePositiveInt(note.noteItemId) || undefined
        : undefined;
  const noteItem =
    typeof note === "object"
      ? resolveNoteItemFromContext(note)
      : normalizedNoteId
        ? Zotero.Items.get(normalizedNoteId) || null
        : null;
  const snapshot = readNoteSnapshot(noteItem);
  const fallbackTitle =
    fallback?.title ||
    (typeof note === "object" ? note.title : "") ||
    (normalizedNoteId ? `Note ${normalizedNoteId}` : "Note");
  if (!snapshot && !normalizedNoteId && !fallback?.text && !fallbackTitle) {
    return null;
  }
  return {
    noteId: snapshot?.noteId || normalizedNoteId,
    title: snapshot?.title || fallbackTitle,
    text: snapshot?.text || fallback?.text || "",
  };
}

export function createNoteContextChip(
  ownerDoc: Document,
  snapshot: NoteChipSnapshot,
  options: CreateNoteChipOptions,
): HTMLDivElement {
  const noteLabelText = snapshot.noteId
    ? `Note ${snapshot.noteId}`
    : snapshot.title || "Note";
  const noteChip = ownerDoc.createElement("div");
  noteChip.className = "llm-selected-context llm-note-context-chip";
  if (options.pinned) {
    noteChip.classList.add("llm-selected-context-pinned");
  }
  noteChip.dataset.noteChip = "true";
  noteChip.dataset.noteChipKind = options.noteChipKind;
  noteChip.dataset.noteId = snapshot.noteId ? `${snapshot.noteId}` : "";
  noteChip.dataset.contextOwnerId = `${options.ownerId}`;
  noteChip.dataset.pinned = options.pinned ? "true" : "false";
  noteChip.classList.toggle("expanded", options.expanded);
  noteChip.classList.toggle("collapsed", !options.expanded);

  const noteHeader = ownerDoc.createElement("div");
  noteHeader.className = "llm-image-preview-header llm-selected-context-header";

  const noteMeta = ownerDoc.createElement("button");
  noteMeta.type = "button";
  noteMeta.className =
    "llm-image-preview-meta llm-selected-context-meta llm-note-context-meta";
  noteMeta.setAttribute("aria-label", `Note context: ${noteLabelText}`);
  noteMeta.setAttribute("aria-expanded", options.expanded ? "true" : "false");
  if (options.removableIndex !== undefined) {
    noteMeta.dataset.contextIndex = `${options.removableIndex}`;
    noteChip.dataset.contextIndex = `${options.removableIndex}`;
  }
  const noteIcon = ownerDoc.createElement("span");
  noteIcon.className = "llm-note-context-icon";
  noteIcon.textContent = "📝";
  const noteLabel = ownerDoc.createElement("span");
  noteLabel.className = "llm-note-context-label";
  noteLabel.textContent = noteLabelText;
  noteMeta.append(noteIcon, noteLabel);
  noteHeader.appendChild(noteMeta);

  if (options.removableIndex !== undefined) {
    const noteClear = ownerDoc.createElement("button");
    noteClear.type = "button";
    noteClear.className = "llm-remove-img-btn llm-selected-context-clear";
    noteClear.dataset.contextIndex = `${options.removableIndex}`;
    noteClear.textContent = "×";
    noteClear.title = `Clear ${noteLabelText}`;
    noteClear.setAttribute("aria-label", `Clear ${noteLabelText}`);
    noteHeader.appendChild(noteClear);
  }

  const noteExpanded = ownerDoc.createElement("div");
  noteExpanded.className =
    "llm-image-preview-expanded llm-selected-context-expanded";
  noteExpanded.hidden = false;
  noteExpanded.style.display = "flex";
  const noteBody = ownerDoc.createElement("div");
  noteBody.className = "llm-selected-context-text llm-note-context-text";
  noteBody.textContent = snapshot.text || "Empty note";
  noteExpanded.appendChild(noteBody);

  noteChip.append(noteHeader, noteExpanded);
  return noteChip;
}

export function refreshNoteChipPreview(noteChip: Element): void {
  const noteId = Number((noteChip as HTMLDivElement).dataset.noteId || 0);
  const snapshot = resolveNoteChipSnapshot(noteId);
  if (!snapshot) return;
  (noteChip as HTMLDivElement).dataset.noteId = snapshot.noteId
    ? `${snapshot.noteId}`
    : "";
  const noteMeta = noteChip.querySelector(
    ".llm-note-context-meta",
  ) as HTMLButtonElement | null;
  if (noteMeta) {
    noteMeta.removeAttribute("title");
    const noteLabelText = snapshot.noteId
      ? `Note ${snapshot.noteId}`
      : snapshot.title || "Note";
    noteMeta.setAttribute("aria-label", `Note context: ${noteLabelText}`);
    const noteLabel = noteMeta.querySelector(
      ".llm-note-context-label",
    ) as HTMLSpanElement | null;
    if (noteLabel) {
      noteLabel.textContent = noteLabelText;
    }
  }
  const bodyEl = noteChip.querySelector(
    ".llm-note-context-text",
  ) as HTMLDivElement | null;
  if (bodyEl) {
    bodyEl.textContent = snapshot.text || "Empty note";
  }
}

export function applySelectedTextPreview(body: Element, itemId: number) {
  const previewList = ((body as any).__llmFloatedPanel || body).querySelector(
    "#llm-selected-context-list",
  ) as HTMLDivElement | null;
  const selectTextBtn = ((body as any).__llmFloatedPanel || body).querySelector(
    "#llm-select-text",
  ) as HTMLButtonElement | null;
  if (!previewList) return;

  const selectedContexts = getSelectedTextContextEntries(itemId);
  const panelRoot = ((body as any).__llmFloatedPanel || body).querySelector("#llm-main") as HTMLDivElement | null;
  // Show the active-note chip whenever the panel is in note-editing mode,
  // regardless of whether the user has selected any text in the editor.
  const showActiveNoteChip = Boolean(panelRoot?.dataset.noteId);
  const activeNoteChipData = (() => {
    if (!panelRoot || !showActiveNoteChip) return null;
    const noteId = Number(panelRoot.dataset.noteId || 0);
    const snapshot = resolveNoteChipSnapshot(noteId, {
      title: panelRoot.dataset.noteTitle || "",
    });
    if (!snapshot) return null;
    const title = `${snapshot.title || panelRoot.dataset.noteTitle || ""}`.trim();
    if (snapshot.title) {
      panelRoot.dataset.noteTitle = snapshot.title;
    }
    return {
      noteId: snapshot.noteId,
      title,
      text: snapshot.text,
    };
  })();
  if (!showActiveNoteChip) {
    selectedNotePreviewExpandedCache.delete(itemId);
  }
  prunePinnedSelectedTextKeys(pinnedSelectedTextKeys, itemId, selectedContexts);
  if (!selectedContexts.length && !activeNoteChipData) {
    previewList.style.display = "none";
    previewList.innerHTML = "";
    selectedTextPreviewExpandedCache.delete(itemId);
    selectedNotePreviewExpandedCache.delete(itemId);
    if (selectTextBtn) {
      selectTextBtn.classList.remove("llm-action-btn-active");
    }
    return;
  }

  const ownerDoc = body.ownerDocument;
  if (!ownerDoc) return;

  const expandedIndex = getSelectedTextExpandedIndex(
    itemId,
    selectedContexts.length,
  );
  const isNoteExpanded = isNoteContextExpanded(itemId);
  const isGlobalConversation = panelRoot?.dataset.conversationKind === "global";
  previewList.style.display = "contents";
  previewList.innerHTML = "";

  if (activeNoteChipData) {
    previewList.appendChild(
      createNoteContextChip(ownerDoc, activeNoteChipData, {
        ownerId: itemId,
        expanded: isNoteExpanded,
        pinned: true,
        noteChipKind: "active",
      }),
    );
  }

  for (const [index, selectedContext] of selectedContexts.entries()) {
    const selectedText = selectedContext.text;
    const selectedSource = selectedContext.source;
    const isExpanded = expandedIndex === index;
    const pinned = isPinnedSelectedText(
      pinnedSelectedTextKeys,
      itemId,
      selectedContext,
    );
    if (selectedSource === "note" && selectedContext.noteContext) {
      const noteSnapshot = resolveNoteChipSnapshot(selectedContext.noteContext, {
        title: selectedContext.noteContext.title,
        text: selectedContext.text,
      });
      if (noteSnapshot) {
        previewList.appendChild(
          createNoteContextChip(ownerDoc, noteSnapshot, {
            ownerId: itemId,
            expanded: isExpanded,
            pinned,
            removableIndex: index,
            noteChipKind: "selected",
          }),
        );
        continue;
      }
    }
    const contextLabel =
      (() => {
        if (selectedSource === "note-edit") {
          return "Editing";
        }
        const pageLabel = formatSelectedTextContextPageLabel(selectedContext);
        if (selectedSource === "pdf" && pageLabel) {
          if (isGlobalConversation) {
            const paperLabel = formatPaperCitationLabel(
              selectedContext.paperContext,
            );
            return paperLabel
              ? `${paperLabel}, ${pageLabel.replace(/^page /, "p")}`
              : pageLabel.replace(/^page /, "p");
          }
          return pageLabel;
        }
        return isGlobalConversation && selectedSource === "pdf"
          ? formatPaperCitationLabel(selectedContext.paperContext)
          : selectedContexts.length > 1 && index > 0
            ? `Text Context (${index + 1})`
            : "Text Context";
      })();

    const previewBox = ownerDoc.createElement("div");
    previewBox.className = "llm-selected-context";
    previewBox.dataset.contextIndex = `${index}`;
    previewBox.dataset.contextSource = selectedSource;
    previewBox.classList.toggle("expanded", isExpanded);
    previewBox.classList.toggle("collapsed", !isExpanded);
    previewBox.classList.toggle(
      "llm-selected-context-source-pdf",
      selectedSource === "pdf",
    );
    previewBox.classList.toggle(
      "llm-selected-context-source-model",
      selectedSource === "model",
    );
    previewBox.classList.toggle(
      "llm-selected-context-source-note-edit",
      selectedSource === "note-edit",
    );
    previewBox.classList.toggle("llm-selected-context-pinned", pinned);
    previewBox.dataset.pinned = pinned ? "true" : "false";
    previewBox.dataset.contextPinKey =
      buildPinnedSelectedTextKey(selectedContext);

    const previewHeader = ownerDoc.createElement("div");
    previewHeader.className =
      "llm-image-preview-header llm-selected-context-header";

    const previewMeta = ownerDoc.createElement("button");
    previewMeta.type = "button";
    previewMeta.className = "llm-image-preview-meta llm-selected-context-meta";
    previewMeta.dataset.contextIndex = `${index}`;
    previewMeta.dataset.contextSource = selectedSource;
    previewMeta.classList.toggle(
      "llm-selected-context-source-pdf",
      selectedSource === "pdf",
    );
    previewMeta.classList.toggle(
      "llm-selected-context-source-model",
      selectedSource === "model",
    );
    previewMeta.classList.toggle(
      "llm-selected-context-source-note-edit",
      selectedSource === "note-edit",
    );
    previewMeta.textContent = contextLabel;
    const isCorrupted = isLikelyCorruptedSelectedText(selectedText);
    previewMeta.classList.toggle(
      "llm-selected-context-meta-corrupted",
      isCorrupted,
    );
    const pageLabel = formatSelectedTextContextPageLabel(selectedContext);
    const isJumpablePdfContext =
      selectedSource === "pdf" &&
      Number.isFinite(selectedContext.pageIndex) &&
      (selectedContext.pageIndex as number) >= 0;
    previewMeta.title = isJumpablePdfContext
      ? `Jump to ${pageLabel || "page"}`
      : selectedSource === "note-edit"
        ? isExpanded
          ? "Collapse editing focus"
          : "Expand editing focus"
      : isExpanded
        ? "Collapse text context"
        : "Expand text context";
    previewMeta.setAttribute(
      "aria-expanded",
      isJumpablePdfContext ? "false" : isExpanded ? "true" : "false",
    );
    previewMeta.dataset.contextPageIndex =
      Number.isFinite(selectedContext.pageIndex)
        ? `${Math.floor(selectedContext.pageIndex as number)}`
        : "";
    previewMeta.dataset.contextPageLabel = selectedContext.pageLabel || "";
    previewMeta.dataset.contextItemId =
      Number.isFinite(selectedContext.contextItemId)
        ? `${Math.floor(selectedContext.contextItemId as number)}`
        : "";

    previewHeader.appendChild(previewMeta);
    if (selectedSource !== "note-edit") {
      const previewClear = ownerDoc.createElement("button");
      previewClear.type = "button";
      previewClear.className = "llm-remove-img-btn llm-selected-context-clear";
      previewClear.dataset.contextIndex = `${index}`;
      previewClear.textContent = "×";
      previewClear.title = "Clear selected context";
      previewClear.setAttribute("aria-label", "Clear selected context");
      previewHeader.appendChild(previewClear);
    }

    const previewExpanded = ownerDoc.createElement("div");
    previewExpanded.className =
      "llm-image-preview-expanded llm-selected-context-expanded";
    previewExpanded.hidden = false;
    previewExpanded.style.display = "flex";

    const previewText = ownerDoc.createElement("div");
    previewText.className = "llm-selected-context-text";
    previewText.textContent = selectedText;

    const previewWarning = ownerDoc.createElement("div");
    previewWarning.className = "llm-selected-context-warning";
    previewWarning.textContent =
      "Recommend to use screenshots option for corrupted text";
    previewWarning.style.display = isCorrupted ? "block" : "none";

    previewExpanded.append(previewText, previewWarning);
    previewBox.append(previewHeader, previewExpanded);
    previewList.appendChild(previewBox);
  }

  if (selectTextBtn) {
    selectTextBtn.classList.toggle(
      "llm-action-btn-active",
      selectedContexts.length > 0,
    );
  }
}

export function refreshActiveNoteChipPreview(body: Element): void {
  const panelRoot = ((body as any).__llmFloatedPanel || body).querySelector("#llm-main") as HTMLDivElement | null;
  const previewList = ((body as any).__llmFloatedPanel || body).querySelector(
    "#llm-selected-context-list",
  ) as HTMLDivElement | null;
  if (!panelRoot || !previewList) return;
  const noteChip = previewList.querySelector(
    "[data-note-chip='true'][data-note-chip-kind='active']",
  ) as HTMLDivElement | null;
  if (!noteChip) return;
  const noteId = Number(panelRoot.dataset.noteId || noteChip.dataset.noteId || 0);
  const snapshot = resolveNoteChipSnapshot(noteId);
  if (!snapshot) return;
  panelRoot.dataset.noteTitle = snapshot.title;
  refreshNoteChipPreview(noteChip);
  const contextOwnerId = Number(
    noteChip.dataset.contextOwnerId || panelRoot.dataset.itemId || 0,
  );
  const noteMeta = noteChip.querySelector(
    ".llm-note-context-meta",
  ) as HTMLButtonElement | null;
  noteMeta?.setAttribute(
    "aria-expanded",
    isNoteContextExpanded(contextOwnerId) ? "true" : "false",
  );
}

export async function includeSelectedTextFromReader(
  body: Element,
  item: Zotero.Item,
  prefetchedText?: string,
  options?: {
    paperContext?: PaperContextRef | null;
    targetItemId?: number | null;
  },
): Promise<boolean> {
  const selectedText =
    normalizeSelectedText(prefetchedText || "") ||
    getActiveReaderSelectionText(body.ownerDocument as Document, item);
  const targetItemId =
    typeof options?.targetItemId === "number" && options.targetItemId > 0
      ? Math.floor(options.targetItemId)
      : item.id;
  const reader = getActiveReaderForSelectedTab();
  const location = await resolveCurrentSelectionPageLocationFromReader(
    reader,
    selectedText,
  );
  return addSelectedTextContext(body, targetItemId, selectedText, {
    noSelectionStatusText: "No text selected in reader",
    successStatusText: "Selected text included",
    focusInput: true,
    source: "pdf",
    paperContext: options?.paperContext,
    location,
  });
}

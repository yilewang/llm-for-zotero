import {
  GLOBAL_CONVERSATION_KEY_BASE,
  PAPER_CONVERSATION_KEY_BASE,
  isUpstreamGlobalConversationKey,
} from "./constants";
import { normalizePositiveInt } from "./normalizers";
import {
  buildPaperStateKey,
  getLastUsedPaperConversationKey,
  getLockedGlobalConversationKey,
} from "./prefHelpers";
import {
  activeConversationModeByLibrary,
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
} from "./state";
import type {
  ActiveNoteSession,
  GlobalPortalItem,
  PaperPortalItem,
} from "./types";
import type { ConversationSystem } from "../../shared/types";
import {
  buildDefaultClaudeGlobalConversationKey,
  buildDefaultClaudePaperConversationKey,
} from "../../claudeCode/constants";
import {
  createClaudeGlobalPortalItem,
  createClaudePaperPortalItem,
  isClaudeGlobalPortalItem,
  isClaudePaperPortalItem,
  resolveClaudePaperPortalBaseItem,
} from "../../claudeCode/portal";
import {
  getConversationSystemPref,
  getLastUsedClaudeConversationMode,
  getLastUsedClaudeGlobalConversationKey,
  getLastUsedClaudePaperConversationKey,
  isClaudeCodeModeEnabled,
} from "../../claudeCode/prefs";
import {
  activeClaudeConversationModeByLibrary,
  activeClaudeGlobalConversationByLibrary,
  activeClaudePaperConversationByPaper,
  buildClaudeLibraryStateKey,
  buildClaudePaperStateKey,
} from "../../claudeCode/state";
import {
  buildDefaultCodexGlobalConversationKey,
  buildDefaultCodexPaperConversationKey,
} from "../../codexAppServer/constants";
import {
  createCodexGlobalPortalItem,
  createCodexPaperPortalItem,
  isCodexGlobalPortalItem,
  isCodexPaperPortalItem,
  resolveCodexPaperPortalBaseItem,
} from "../../codexAppServer/portal";
import {
  getLastUsedCodexConversationMode,
  getLastUsedCodexGlobalConversationKey,
  getLastUsedCodexPaperConversationKey,
  isCodexAppServerModeEnabled,
} from "../../codexAppServer/prefs";
import {
  activeCodexConversationModeByLibrary,
  activeCodexGlobalConversationByLibrary,
  activeCodexPaperConversationByPaper,
  buildCodexLibraryStateKey,
  buildCodexPaperStateKey,
} from "../../codexAppServer/state";

export function resolveActiveLibraryID(): number | null {
  try {
    const pane = Zotero.getActiveZoteroPane?.() as
      | {
          getSelectedLibraryID?: () => unknown;
          getSelectedItems?: () => Zotero.Item[];
        }
      | undefined;
    const selectedLibraryID = normalizePositiveInt(
      pane?.getSelectedLibraryID?.(),
    );
    if (selectedLibraryID) return selectedLibraryID;
    const selectedItems = pane?.getSelectedItems?.() || [];
    const firstItemLibrary = normalizePositiveInt(selectedItems[0]?.libraryID);
    if (firstItemLibrary) return firstItemLibrary;
  } catch (_err) {
    void _err;
  }

  const userLibraryID = normalizePositiveInt(
    (Zotero as unknown as { Libraries?: { userLibraryID?: unknown } }).Libraries
      ?.userLibraryID,
  );
  return userLibraryID;
}

export function createGlobalPortalItem(
  libraryID: number,
  conversationKey: number,
): Zotero.Item {
  const normalizedLibraryID = normalizePositiveInt(libraryID) || 1;
  const normalizedConversationKey =
    normalizePositiveInt(conversationKey) || GLOBAL_CONVERSATION_KEY_BASE;
  const portalItem: GlobalPortalItem = {
    __llmGlobalPortalItem: true,
    id: normalizedConversationKey,
    libraryID: normalizedLibraryID,
    parentID: undefined,
    attachmentContentType: "",
    isAttachment: () => false,
    isRegularItem: () => false,
    getAttachments: () => [],
    getField: (field: string) => {
      if (field === "title") return "Global Library Portal";
      if (field === "libraryCatalog") return "Library";
      return "";
    },
  };
  return portalItem as unknown as Zotero.Item;
}

export function isGlobalPortalItem(item: unknown): item is GlobalPortalItem {
  if (!item || typeof item !== "object") return false;
  const typed = item as Partial<GlobalPortalItem>;
  if (typed.__llmGlobalPortalItem !== true) return false;
  const normalizedId = normalizePositiveInt(typed.id);
  return Boolean(normalizedId && normalizedId >= GLOBAL_CONVERSATION_KEY_BASE);
}

export function createPaperPortalItem(
  basePaperItem: Zotero.Item,
  conversationKey: number,
  sessionVersion: number,
): Zotero.Item {
  const basePaperItemID = normalizePositiveInt(basePaperItem?.id) || 0;
  const normalizedLibraryID =
    normalizePositiveInt(basePaperItem?.libraryID) || 1;
  const normalizedConversationKey =
    normalizePositiveInt(conversationKey) || PAPER_CONVERSATION_KEY_BASE;
  const normalizedSessionVersion = normalizePositiveInt(sessionVersion) || 1;
  const portalItem: PaperPortalItem = {
    __llmPaperPortalItem: true,
    __llmPaperPortalBaseItemID: basePaperItemID,
    __llmPaperPortalSessionVersion: normalizedSessionVersion,
    id: normalizedConversationKey,
    libraryID: normalizedLibraryID,
    parentID: undefined,
    attachmentContentType: "",
    isAttachment: () => false,
    isRegularItem: () => true,
    getAttachments: () => {
      const resolvedBase = basePaperItemID
        ? Zotero.Items.get(basePaperItemID) || null
        : null;
      if (!resolvedBase?.isRegularItem?.()) return [];
      return resolvedBase.getAttachments();
    },
    getField: (field: string) => {
      const resolvedBase = basePaperItemID
        ? Zotero.Items.get(basePaperItemID) || null
        : null;
      if (resolvedBase) {
        try {
          return String(resolvedBase.getField(field) || "");
        } catch (_err) {
          void _err;
        }
      }
      if (field === "title") return "Paper chat";
      return "";
    },
  };
  return portalItem as unknown as Zotero.Item;
}

export function isPaperPortalItem(item: unknown): item is PaperPortalItem {
  if (!item || typeof item !== "object") return false;
  const typed = item as Partial<PaperPortalItem>;
  if (typed.__llmPaperPortalItem !== true) return false;
  const normalizedConversationKey = normalizePositiveInt(typed.id);
  const normalizedBasePaperID = normalizePositiveInt(
    typed.__llmPaperPortalBaseItemID,
  );
  return Boolean(normalizedConversationKey && normalizedBasePaperID);
}

export function getPaperPortalBaseItemID(item: unknown): number | null {
  if (!isPaperPortalItem(item)) return null;
  const normalized = normalizePositiveInt(item.__llmPaperPortalBaseItemID);
  return normalized || null;
}

export function getPaperPortalSessionVersion(item: unknown): number | null {
  if (!isPaperPortalItem(item)) return null;
  const normalized = normalizePositiveInt(item.__llmPaperPortalSessionVersion);
  return normalized || null;
}

export function resolvePaperPortalBaseItem(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  const baseItemID = getPaperPortalBaseItemID(item);
  if (!baseItemID) return null;
  const resolved = Zotero.Items.get(baseItemID) || null;
  return resolved?.isRegularItem?.() ? resolved : null;
}

export function resolveNoteParentItem(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  if (!(item as any)?.isNote?.()) return null;
  const parentID = normalizePositiveInt(item?.parentID);
  if (!parentID) return null;
  const parentItem = Zotero.Items.get(parentID) || null;
  return parentItem?.isRegularItem?.() ? parentItem : null;
}

function resolveActiveTabTitleForNote(
  item: Zotero.Item | null | undefined,
): string {
  const noteId = normalizePositiveInt(item?.id);
  if (!noteId) return "";
  const tabsCandidates = [
    (Zotero as unknown as { Tabs?: unknown }).Tabs,
    (Zotero.getMainWindow?.() as { Zotero?: { Tabs?: unknown } } | undefined)
      ?.Zotero?.Tabs,
    (Zotero.getActiveZoteroPane?.() as { document?: Document } | undefined)
      ?.document?.defaultView &&
      (
        (
          Zotero.getActiveZoteroPane?.() as { document?: Document } | undefined
        )?.document?.defaultView as { Zotero?: { Tabs?: unknown } }
      ).Zotero?.Tabs,
  ];
  for (const candidate of tabsCandidates) {
    const tabs = candidate as
      | {
          selectedID?: string | number;
          _tabs?: Array<Record<string, unknown>>;
        }
      | undefined;
    const selectedId =
      tabs?.selectedID === undefined || tabs?.selectedID === null
        ? ""
        : `${tabs.selectedID}`;
    const activeTab = Array.isArray(tabs?._tabs)
      ? tabs!._tabs!.find((tab) => `${tab?.id || ""}` === selectedId)
      : null;
    if (!activeTab) continue;
    const data = (activeTab.data || {}) as Record<string, unknown>;
    const candidateItemId = normalizePositiveInt(
      data.itemID || data.itemId || data.id,
    );
    if (candidateItemId && candidateItemId !== noteId) continue;
    const titleCandidates = [
      activeTab.title,
      activeTab.label,
      activeTab.name,
      data.title,
      data.label,
      data.name,
      data.noteTitle,
      data.itemTitle,
    ];
    for (const raw of titleCandidates) {
      const title = typeof raw === "string" ? raw.trim() : "";
      if (title) return title;
    }
  }
  return "";
}

export function resolveNoteTitle(
  item: Zotero.Item | null | undefined,
): string {
  if (!(item as any)?.isNote?.()) return "";
  const activeTabTitle = resolveActiveTabTitleForNote(item);
  if (activeTabTitle) return activeTabTitle;
  try {
    const raw = String((item as any).getDisplayTitle?.() || "").trim();
    if (raw) return raw;
  } catch (_err) {
    void _err;
  }
  try {
    const raw = String((item as any).getField?.("title") || "").trim();
    if (raw) return raw;
  } catch (_err) {
    void _err;
  }
  try {
    const raw = String((item as any).getNoteTitle?.() || "").trim();
    if (raw) return raw;
  } catch (_err) {
    void _err;
  }
  return "";
}

export function resolveActiveNoteSession(
  item: Zotero.Item | null | undefined,
): ActiveNoteSession | null {
  if (!(item as any)?.isNote?.()) return null;
  const noteId = normalizePositiveInt(item?.id);
  if (!noteId) return null;
  const parentItem = resolveNoteParentItem(item);
  return {
    noteKind: parentItem ? "item" : "standalone",
    noteId,
    title: resolveNoteTitle(item),
    parentItemId: parentItem?.id,
    displayConversationKind: parentItem ? "paper" : "global",
    capabilities: {
      showModeSwitch: false,
      showNewConversation: false,
      showHistory: false,
    },
  };
}

export function resolveDisplayConversationKind(
  item: Zotero.Item | null | undefined,
): "global" | "paper" | null {
  const noteSession = resolveActiveNoteSession(item);
  if (noteSession) {
    return noteSession.displayConversationKind;
  }
  if (!item) return null;
  return isGlobalPortalItem(item) ||
    isClaudeGlobalPortalItem(item) ||
    isCodexGlobalPortalItem(item)
    ? "global"
    : "paper";
}

export function resolveConversationBaseItem(
  targetItem: Zotero.Item | null | undefined,
): Zotero.Item | null {
  if (!targetItem) return null;
  if (
    isGlobalPortalItem(targetItem) ||
    isClaudeGlobalPortalItem(targetItem) ||
    isCodexGlobalPortalItem(targetItem)
  ) {
    return null;
  }
  if (isPaperPortalItem(targetItem)) {
    return resolvePaperPortalBaseItem(targetItem);
  }
  if (isClaudePaperPortalItem(targetItem)) {
    return resolveClaudePaperPortalBaseItem(targetItem);
  }
  if (isCodexPaperPortalItem(targetItem)) {
    return resolveCodexPaperPortalBaseItem(targetItem);
  }
  const noteParentItem = resolveNoteParentItem(targetItem);
  if (noteParentItem) {
    return noteParentItem;
  }
  if ((targetItem as any).isNote?.()) {
    return targetItem;
  }
  if (targetItem.isAttachment() && targetItem.parentID) {
    const parent = Zotero.Items.get(targetItem.parentID) || null;
    return parent?.isRegularItem?.() ? parent : null;
  }
  return targetItem?.isRegularItem?.() ? targetItem : null;
}


function resolveLibraryIdFromItem(
  targetItem: Zotero.Item | null | undefined,
): number {
  const parsed = Number(targetItem?.libraryID);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return resolveActiveLibraryID() || 0;
}

export function resolveConversationSystemForItem(
  item: Zotero.Item | null | undefined,
): ConversationSystem | null {
  if (isClaudeGlobalPortalItem(item) || isClaudePaperPortalItem(item)) {
    return "claude_code";
  }
  if (isCodexGlobalPortalItem(item) || isCodexPaperPortalItem(item)) {
    return "codex";
  }
  if (isGlobalPortalItem(item) || isPaperPortalItem(item)) {
    return "upstream";
  }
  return null;
}

export function resolvePreferredConversationSystem(params: {
  item: Zotero.Item | null | undefined;
  preferredSystem?: ConversationSystem | null;
}): ConversationSystem {
  const preferred =
    params.preferredSystem ||
    getConversationSystemPref();
  if (resolveActiveNoteSession(params.item)) {
    return preferred === "codex" && isCodexAppServerModeEnabled()
      ? "codex"
      : "upstream";
  }
  const itemSystem = resolveConversationSystemForItem(params.item);
  if (itemSystem === "claude_code" && !isClaudeCodeModeEnabled()) {
    return "upstream";
  }
  if (itemSystem === "codex" && !isCodexAppServerModeEnabled()) {
    return "upstream";
  }
  if (preferred === "claude_code" && !isClaudeCodeModeEnabled()) {
    return "upstream";
  }
  if (preferred === "codex" && !isCodexAppServerModeEnabled()) {
    return "upstream";
  }
  return itemSystem || preferred;
}

function resolvePreferredConversationMode(
  libraryID: number,
  system: ConversationSystem,
): "global" | "paper" {
  if (system === "claude_code") {
    const rememberedMode =
      activeClaudeConversationModeByLibrary.get(buildClaudeLibraryStateKey(libraryID)) ||
      getLastUsedClaudeConversationMode(libraryID);
    return rememberedMode === "global" ? "global" : "paper";
  }
  if (system === "codex") {
    const rememberedMode =
      activeCodexConversationModeByLibrary.get(buildCodexLibraryStateKey(libraryID)) ||
      getLastUsedCodexConversationMode(libraryID);
    return rememberedMode === "global" ? "global" : "paper";
  }
  if (getLockedGlobalConversationKey(libraryID) !== null) {
    return "global";
  }
  const rememberedMode = activeConversationModeByLibrary.get(libraryID);
  return rememberedMode === "global" ? "global" : "paper";
}

function resolveGlobalConversationKey(
  libraryID: number,
  system: ConversationSystem,
): number {
  if (system === "claude_code") {
    return Math.floor(
      Number(
        activeClaudeGlobalConversationByLibrary.get(buildClaudeLibraryStateKey(libraryID)) ||
          getLastUsedClaudeGlobalConversationKey(libraryID) ||
          buildDefaultClaudeGlobalConversationKey(libraryID),
      ),
    );
  }
  if (system === "codex") {
    return Math.floor(
      Number(
        activeCodexGlobalConversationByLibrary.get(buildCodexLibraryStateKey(libraryID)) ||
          getLastUsedCodexGlobalConversationKey(libraryID) ||
          buildDefaultCodexGlobalConversationKey(libraryID),
      ),
    );
  }
  const lockedKey = getLockedGlobalConversationKey(libraryID);
  if (lockedKey !== null) return lockedKey;
  const activeKey = Number(activeGlobalConversationByLibrary.get(libraryID) || 0);
  if (isUpstreamGlobalConversationKey(activeKey)) {
    return Math.floor(activeKey);
  }
  return GLOBAL_CONVERSATION_KEY_BASE;
}

export function resolveInitialPanelItemState(
  initialItem: Zotero.Item | null | undefined,
  options?: {
    conversationSystem?: ConversationSystem | null;
  },
): {
  item: Zotero.Item | null;
  basePaperItem: Zotero.Item | null;
} {
  let item = initialItem || null;
  const noteSession = resolveActiveNoteSession(item);
  if (noteSession) {
    return {
      item,
      basePaperItem:
        noteSession.noteKind === "item" && noteSession.parentItemId
          ? Zotero.Items.get(noteSession.parentItemId) || null
          : null,
    };
  }
  if (
    ((isClaudeGlobalPortalItem(item) || isClaudePaperPortalItem(item)) &&
      !isClaudeCodeModeEnabled()) ||
    ((isCodexGlobalPortalItem(item) || isCodexPaperPortalItem(item)) &&
      !isCodexAppServerModeEnabled())
  ) {
    item = resolveConversationBaseItem(item);
  }
  const basePaperItem = resolveConversationBaseItem(item);
  if (!basePaperItem) {
    return { item, basePaperItem: null };
  }

  if (
    isPaperPortalItem(item) ||
    (isClaudePaperPortalItem(item) && isClaudeCodeModeEnabled()) ||
    (isCodexPaperPortalItem(item) && isCodexAppServerModeEnabled())
  ) {
    return { item, basePaperItem };
  }

  const libraryID = resolveLibraryIdFromItem(basePaperItem);
  const conversationSystem = resolvePreferredConversationSystem({
    item,
    preferredSystem: options?.conversationSystem,
  });
  const preferredMode = resolvePreferredConversationMode(
    libraryID,
    conversationSystem,
  );

  if (preferredMode === "global") {
    const conversationKey = resolveGlobalConversationKey(
      libraryID,
      conversationSystem,
    );
    item = conversationSystem === "claude_code"
      ? createClaudeGlobalPortalItem(libraryID, conversationKey)
      : conversationSystem === "codex"
        ? createCodexGlobalPortalItem(libraryID, conversationKey)
        : createGlobalPortalItem(libraryID, conversationKey);
    return { item, basePaperItem };
  }

  const paperItemID = Number(basePaperItem.id || 0);
  const rememberedPaperKey = Number(
    conversationSystem === "claude_code"
      ? activeClaudePaperConversationByPaper.get(
          buildClaudePaperStateKey(libraryID, paperItemID),
        ) ||
          getLastUsedClaudePaperConversationKey(libraryID, paperItemID) ||
          buildDefaultClaudePaperConversationKey(paperItemID)
      : conversationSystem === "codex"
        ? activeCodexPaperConversationByPaper.get(
            buildCodexPaperStateKey(libraryID, paperItemID),
          ) ||
            getLastUsedCodexPaperConversationKey(libraryID, paperItemID) ||
            buildDefaultCodexPaperConversationKey(paperItemID)
      : activePaperConversationByPaper.get(
          buildPaperStateKey(libraryID, paperItemID),
        ) ||
          getLastUsedPaperConversationKey(libraryID, paperItemID) ||
          0,
  );
  if (
    Number.isFinite(rememberedPaperKey) &&
    rememberedPaperKey > 0 &&
    Math.floor(rememberedPaperKey) !== paperItemID
  ) {
    item = conversationSystem === "claude_code"
      ? createClaudePaperPortalItem(basePaperItem, Math.floor(rememberedPaperKey))
      : conversationSystem === "codex"
        ? createCodexPaperPortalItem(basePaperItem, Math.floor(rememberedPaperKey))
        : createPaperPortalItem(
            basePaperItem,
            Math.floor(rememberedPaperKey),
            0,
          );
  }

  return { item, basePaperItem };
}

import {
  buildDefaultUpstreamGlobalConversationKey,
  GLOBAL_CONVERSATION_KEY_BASE,
  PAPER_CONVERSATION_KEY_BASE,
  isUpstreamGlobalConversationKey,
} from "./constants";
import { isSupportedContextAttachment } from "./contextAttachmentSupport";
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
import {
  resolveNoteFocusSystemSwitch as resolveNoteFocusSystemSwitchPolicy,
  resolveNoteEditingParentItem,
  resolveNoteEditingScope,
  resolveNoteEditingTitle,
  resolvePreferredNoteFocusSystem,
} from "./noteEditing";

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
    normalizePositiveInt(conversationKey) ||
    buildDefaultUpstreamGlobalConversationKey(normalizedLibraryID);
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
      if (resolvedBase?.isRegularItem?.()) return resolvedBase.getAttachments();
      if (isSupportedContextAttachment(resolvedBase)) return [basePaperItemID];
      return [];
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
  return isPaperChatBaseItem(resolved) ? resolved : null;
}

export function resolveNoteParentItem(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  return resolveNoteEditingParentItem(item);
}

export function resolveNoteTitle(item: Zotero.Item | null | undefined): string {
  return resolveNoteEditingTitle(item);
}

export function resolveActiveNoteSession(
  item: Zotero.Item | null | undefined,
): ActiveNoteSession | null {
  return resolveNoteEditingScope(item);
}

export function resolveDisplayConversationKind(
  item: Zotero.Item | null | undefined,
): "global" | "paper" | null {
  const noteSession = resolveActiveNoteSession(item);
  if (noteSession) {
    return noteSession.conversationKind;
  }
  if (!item) return null;
  return isGlobalPortalItem(item) ||
    isClaudeGlobalPortalItem(item) ||
    isCodexGlobalPortalItem(item)
    ? "global"
    : "paper";
}

// Show shortcuts only on real paper-chat sessions. Hide for library/global,
// any note-editing session (even when attached to a paper), and when no item.
export function resolveShortcutMode(
  item: Zotero.Item | null | undefined,
): "paper" | "library" {
  if (!item) return "library";
  if (resolveActiveNoteSession(item)) return "library";
  return resolveDisplayConversationKind(item) === "global"
    ? "library"
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
  return resolvePaperChatSourceItem(targetItem);
}

export function isPaperChatBaseItem(
  item: Zotero.Item | null | undefined,
): item is Zotero.Item {
  if (!item) return false;
  if (item.isAttachment?.()) {
    return isSupportedContextAttachment(item);
  }
  return Boolean(item.isRegularItem?.());
}

export function resolvePaperChatSourceItem(
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
  if ((targetItem as any).isNote?.()) {
    return resolveNoteParentItem(targetItem);
  }
  if (targetItem.isAttachment() && targetItem.parentID) {
    if (!isSupportedContextAttachment(targetItem)) return null;
    const parent = Zotero.Items.get(targetItem.parentID) || null;
    return parent?.isRegularItem?.() ? parent : null;
  }
  return isPaperChatBaseItem(targetItem) ? targetItem : null;
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
  const preferred = params.preferredSystem || getConversationSystemPref();
  if (resolveActiveNoteSession(params.item)) {
    return resolvePreferredNoteFocusSystem({
      preferredSystem: preferred,
      claudeAvailable: isClaudeCodeModeEnabled(),
      codexAvailable: isCodexAppServerModeEnabled(),
    });
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

export function resolveNoteFocusSystemSwitch(params: {
  nextSystem: ConversationSystem;
  codexAvailable: boolean;
  claudeAvailable?: boolean;
}): ConversationSystem | null {
  return resolveNoteFocusSystemSwitchPolicy({
    nextSystem: params.nextSystem,
    claudeAvailable: params.claudeAvailable === true,
    codexAvailable: params.codexAvailable,
  });
}

function resolvePreferredConversationMode(
  libraryID: number,
  system: ConversationSystem,
): "global" | "paper" {
  if (system === "claude_code") {
    const rememberedMode =
      activeClaudeConversationModeByLibrary.get(
        buildClaudeLibraryStateKey(libraryID),
      ) || getLastUsedClaudeConversationMode(libraryID);
    return rememberedMode === "global" ? "global" : "paper";
  }
  if (system === "codex") {
    const rememberedMode =
      activeCodexConversationModeByLibrary.get(
        buildCodexLibraryStateKey(libraryID),
      ) || getLastUsedCodexConversationMode(libraryID);
    return rememberedMode === "global" ? "global" : "paper";
  }
  const rememberedMode = activeConversationModeByLibrary.get(libraryID);
  if (rememberedMode === "paper") {
    return "paper";
  }
  if (getLockedGlobalConversationKey(libraryID) !== null) {
    return "global";
  }
  return rememberedMode === "global" ? "global" : "paper";
}

function resolveGlobalConversationKey(
  libraryID: number,
  system: ConversationSystem,
): number {
  if (system === "claude_code") {
    return Math.floor(
      Number(
        activeClaudeGlobalConversationByLibrary.get(
          buildClaudeLibraryStateKey(libraryID),
        ) ||
          getLastUsedClaudeGlobalConversationKey(libraryID) ||
          buildDefaultClaudeGlobalConversationKey(libraryID),
      ),
    );
  }
  if (system === "codex") {
    return Math.floor(
      Number(
        activeCodexGlobalConversationByLibrary.get(
          buildCodexLibraryStateKey(libraryID),
        ) ||
          getLastUsedCodexGlobalConversationKey(libraryID) ||
          buildDefaultCodexGlobalConversationKey(libraryID),
      ),
    );
  }
  const lockedKey = getLockedGlobalConversationKey(libraryID);
  if (lockedKey !== null) {
    return lockedKey === GLOBAL_CONVERSATION_KEY_BASE
      ? buildDefaultUpstreamGlobalConversationKey(libraryID)
      : lockedKey;
  }
  const activeKey = Number(
    activeGlobalConversationByLibrary.get(libraryID) || 0,
  );
  if (isUpstreamGlobalConversationKey(activeKey)) {
    return activeKey === GLOBAL_CONVERSATION_KEY_BASE
      ? buildDefaultUpstreamGlobalConversationKey(libraryID)
      : Math.floor(activeKey);
  }
  return buildDefaultUpstreamGlobalConversationKey(libraryID);
}

export function resolveRememberedGlobalPanelItem(
  libraryID: number,
  conversationSystem: ConversationSystem,
): Zotero.Item | null {
  const normalizedLibraryID = normalizePositiveInt(libraryID);
  if (!normalizedLibraryID) return null;
  const conversationKey = resolveGlobalConversationKey(
    normalizedLibraryID,
    conversationSystem,
  );
  return conversationSystem === "claude_code"
    ? createClaudeGlobalPortalItem(normalizedLibraryID, conversationKey)
    : conversationSystem === "codex"
      ? createCodexGlobalPortalItem(normalizedLibraryID, conversationKey)
      : createGlobalPortalItem(normalizedLibraryID, conversationKey);
}

function resolvePaperConversationKeyForBaseItem(
  basePaperItem: Zotero.Item,
  system: ConversationSystem,
): number {
  const libraryID = resolveLibraryIdFromItem(basePaperItem);
  const paperItemID = normalizePositiveInt(basePaperItem?.id) || 0;
  if (!libraryID || !paperItemID) return paperItemID;
  const rememberedPaperKey = Number(
    system === "claude_code"
      ? activeClaudePaperConversationByPaper.get(
          buildClaudePaperStateKey(libraryID, paperItemID),
        ) ||
          getLastUsedClaudePaperConversationKey(libraryID, paperItemID) ||
          buildDefaultClaudePaperConversationKey(paperItemID)
      : system === "codex"
        ? activeCodexPaperConversationByPaper.get(
            buildCodexPaperStateKey(libraryID, paperItemID),
          ) ||
          getLastUsedCodexPaperConversationKey(libraryID, paperItemID) ||
          buildDefaultCodexPaperConversationKey(paperItemID)
        : activePaperConversationByPaper.get(
            buildPaperStateKey(libraryID, paperItemID),
          ) ||
          getLastUsedPaperConversationKey(libraryID, paperItemID) ||
          paperItemID,
  );
  return Number.isFinite(rememberedPaperKey) && rememberedPaperKey > 0
    ? Math.floor(rememberedPaperKey)
    : paperItemID;
}

export function resolveConversationKeyForNoteFocus(
  item: Zotero.Item | null | undefined,
  options?: { conversationSystem?: ConversationSystem | null },
): number | null {
  const noteSession = resolveActiveNoteSession(item);
  if (!noteSession) return null;
  const conversationSystem = resolvePreferredConversationSystem({
    item,
    preferredSystem: options?.conversationSystem,
  });
  if (noteSession.noteKind === "standalone") {
    return resolveGlobalConversationKey(
      noteSession.libraryID,
      conversationSystem,
    );
  }
  const parentItem = noteSession.parentItemId
    ? Zotero.Items.get(noteSession.parentItemId) || null
    : null;
  if (!parentItem?.isRegularItem?.()) return null;
  return resolvePaperConversationKeyForBaseItem(parentItem, conversationSystem);
}

export function resolveInitialPanelItemState(
  initialItem: Zotero.Item | null | undefined,
  options?: {
    conversationSystem?: ConversationSystem | null;
    conversationMode?: "global" | "paper";
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
    item?.isAttachment?.() &&
    item.parentID &&
    basePaperItem.isRegularItem?.()
  ) {
    item = basePaperItem;
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
  const preferredMode =
    options?.conversationMode ||
    resolvePreferredConversationMode(libraryID, conversationSystem);

  if (preferredMode === "global") {
    item = resolveRememberedGlobalPanelItem(libraryID, conversationSystem);
    return { item, basePaperItem };
  }

  const paperItemID = Number(basePaperItem.id || 0);
  const rememberedPaperKey = resolvePaperConversationKeyForBaseItem(
    basePaperItem,
    conversationSystem,
  );
  if (
    Number.isFinite(rememberedPaperKey) &&
    rememberedPaperKey > 0 &&
    Math.floor(rememberedPaperKey) !== paperItemID
  ) {
    item =
      conversationSystem === "claude_code"
        ? createClaudePaperPortalItem(
            basePaperItem,
            Math.floor(rememberedPaperKey),
          )
        : conversationSystem === "codex"
          ? createCodexPaperPortalItem(
              basePaperItem,
              Math.floor(rememberedPaperKey),
            )
          : createPaperPortalItem(
              basePaperItem,
              Math.floor(rememberedPaperKey),
              0,
            );
  }

  return { item, basePaperItem };
}

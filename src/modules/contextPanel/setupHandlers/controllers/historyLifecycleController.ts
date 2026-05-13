import { createElement } from "../../../../utils/domHelpers";
import { t } from "../../../../utils/i18n";
import type { ConversationSystem } from "../../../../shared/types";
import {
  MAX_SELECTED_PAPER_CONTEXTS,
  GLOBAL_HISTORY_LIMIT,
  PERSISTED_HISTORY_LIMIT,
  isUpstreamGlobalConversationKey,
} from "../../constants";
import type { Message } from "../../types";
import {
  chatHistory,
  loadedConversationKeys,
  selectedModelCache,
  selectedReasoningCache,
  selectedReasoningProviderCache,
  activeConversationModeByLibrary,
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
  draftInputCache,
  selectedImageCache,
  inlineEditCleanup,
  setInlineEditCleanup,
  setInlineEditTarget,
  setInlineEditInputSection,
  setInlineEditSavedDraft,
  isRequestPending,
} from "../../state";
import { setStatus } from "../../textUtils";
import {
  positionMenuBelowButton,
  positionMenuAtPointer,
} from "../../menuPositioning";
import { renderShortcuts } from "../../shortcuts";
import {
  ensureConversationLoaded,
  getConversationKey,
  refreshConversationPanels,
} from "../../chat";
import { clearConversationSummary as clearConversationSummaryFromCache } from "../../conversationSummaryCache";
import {
  clearConversation as clearStoredConversation,
  clearConversationTitle,
  createGlobalConversation,
  createPaperConversation,
  deleteTurnMessages,
  deleteGlobalConversation,
  deletePaperConversation,
  ensureGlobalConversationExists,
  getGlobalConversationUserTurnCount,
  getLatestEmptyGlobalConversation,
  loadConversation,
  getPaperConversation,
  listGlobalConversations,
  listPaperConversations,
  ensurePaperV1Conversation,
  setGlobalConversationTitle,
  setPaperConversationTitle,
} from "../../../../utils/chatStore";
import {
  loadAllConversationHistory,
  loadConversationHistoryScope,
} from "../../historyLoader";
import {
  loadAllClaudeConversationHistory,
  loadClaudeConversationHistoryScope,
} from "../../../../claudeCode/historyLoader";
import {
  loadAllCodexConversationHistory,
  loadCodexConversationHistoryScope,
} from "../../../../codexAppServer/historyLoader";
import {
  buildClaudeScope,
  invalidateClaudeConversationSession,
  rememberClaudeConversationSelection,
  resolveRememberedClaudeConversationKey,
  touchClaudeConversation,
} from "../../../../claudeCode/runtime";
import {
  getConversationSystemPref,
  getLastUsedClaudeGlobalConversationKey,
  getLastUsedClaudePaperConversationKey,
  removeLastUsedClaudeGlobalConversationKey,
  removeLastUsedClaudePaperConversationKey,
  setConversationSystemPref,
  setLastUsedClaudeGlobalConversationKey,
  setLastUsedClaudePaperConversationKey,
} from "../../../../claudeCode/prefs";
import {
  activeClaudeGlobalConversationByLibrary,
  activeClaudePaperConversationByPaper,
  buildClaudeLibraryStateKey,
  buildClaudePaperStateKey,
} from "../../../../claudeCode/state";
import {
  createClaudeGlobalPortalItem,
  createClaudePaperPortalItem,
} from "../../../../claudeCode/portal";
import {
  clearClaudeConversation,
  createClaudeGlobalConversation,
  createClaudePaperConversation,
  deleteClaudeConversation,
  deleteClaudeTurnMessages,
  ensureClaudePaperConversation,
  getClaudeConversationSummary,
  listClaudeGlobalConversations,
  listClaudePaperConversations,
  loadClaudeConversation,
  setClaudeConversationTitle,
  upsertClaudeConversationSummary,
} from "../../../../claudeCode/store";
import {
  getLastUsedCodexGlobalConversationKey,
  getLastUsedCodexPaperConversationKey,
  removeLastUsedCodexGlobalConversationKey,
  removeLastUsedCodexPaperConversationKey,
  setLastUsedCodexGlobalConversationKey,
  setLastUsedCodexPaperConversationKey,
} from "../../../../codexAppServer/prefs";
import {
  activeCodexGlobalConversationByLibrary,
  activeCodexPaperConversationByPaper,
  buildCodexLibraryStateKey,
  buildCodexPaperStateKey,
} from "../../../../codexAppServer/state";
import {
  createCodexGlobalPortalItem,
  createCodexPaperPortalItem,
} from "../../../../codexAppServer/portal";
import {
  clearCodexConversation,
  createCodexGlobalConversation,
  createCodexPaperConversation,
  deleteCodexConversation,
  deleteCodexTurnMessages,
  ensureCodexPaperConversation,
  getCodexConversationSummary,
  listCodexGlobalConversations,
  listCodexPaperConversations,
  loadCodexConversation,
  setCodexConversationTitle,
  upsertCodexConversationSummary,
} from "../../../../codexAppServer/store";
import {
  createGlobalPortalItem,
  createPaperPortalItem,
  resolveConversationBaseItem,
  resolveDisplayConversationKind,
  resolveShortcutMode,
} from "../../portalScope";
import { normalizeAttachmentContentHash } from "../../normalizers";
import {
  clearOwnerAttachmentRefs,
  replaceOwnerAttachmentRefs,
} from "../../../../utils/attachmentRefStore";
import {
  extractManagedBlobHash,
  removeConversationAttachmentFiles,
} from "../../attachmentStorage";
import {
  getLastUsedPaperConversationKey,
  setLastUsedPaperConversationKey,
  removeLastUsedPaperConversationKey,
  getLockedGlobalConversationKey,
  setLockedGlobalConversationKey,
  buildPaperStateKey,
} from "../../prefHelpers";
import { getCoreAgentRuntime } from "../../../../agent";
import {
  formatGlobalHistoryTimestamp,
  formatHistoryRowDisplayTitle,
  groupHistoryEntriesByDay,
  normalizeConversationTitleSeed,
  normalizeHistoryTitle,
  GLOBAL_HISTORY_UNDO_WINDOW_MS,
  type ConversationHistoryEntry,
  type HistorySwitchTarget,
  type PendingHistoryDeletion,
} from "./conversationHistoryController";
import {
  appendHistorySearchHighlightedText,
  buildHistorySearchResults,
  createHistorySearchDocument,
  createHistorySearchDocumentFingerprint,
  normalizeHistorySearchQuery,
  tokenizeHistorySearchQuery,
  type HistorySearchDocument,
  type HistorySearchResult,
} from "./historySearchController";

type StatusLevel = "ready" | "warning" | "error";
type PendingTurnDeletion = {
  conversationKey: number;
  userTimestamp: number;
  assistantTimestamp: number;
  userIndex: number;
  userMessage: Message;
  assistantMessage: Message;
  timeoutId: number | null;
  expiresAt: number;
};
type CachedHistorySearchDocument = {
  fingerprint: string;
  document: HistorySearchDocument;
};
type PendingHistorySearchDocumentTask = {
  fingerprint: string;
  task: Promise<HistorySearchDocument>;
};

export type HistoryLifecycleControllerDeps = {
  body: Element;
  inputBox: HTMLTextAreaElement;
  panelRoot: HTMLElement;
  status: HTMLElement | null;
  historyBar: HTMLElement | null;
  titleStatic: HTMLElement | null;
  historyNewBtn: HTMLButtonElement | null;
  historyNewMenu: HTMLDivElement | null;
  historyNewOpenBtn: HTMLButtonElement | null;
  historyNewPaperBtn: HTMLButtonElement | null;
  historyToggleBtn: HTMLButtonElement | null;
  historyMenu: HTMLDivElement | null;
  historyRowMenu: HTMLDivElement | null;
  historyRowRenameBtn: HTMLButtonElement | null;
  historyUndo: HTMLElement | null;
  historyUndoText: HTMLElement | null;
  historyUndoBtn: HTMLButtonElement | null;
  modeChipBtn: HTMLButtonElement | null;
  claudeSystemToggleBtn: HTMLButtonElement | null;
  getItem: () => Zotero.Item | null;
  setItem: (item: Zotero.Item | null) => void;
  getBasePaperItem: () => Zotero.Item | null;
  setBasePaperItem: (item: Zotero.Item | null) => void;
  getConversationSystem: () => ConversationSystem;
  isClaudeConversationSystem: () => boolean;
  isCodexConversationSystem: () => boolean;
  isRuntimeConversationSystem: () => boolean;
  isNoteSession: () => boolean;
  isGlobalMode: () => boolean;
  isPaperMode: () => boolean;
  isWebChatMode: () => boolean;
  getCurrentLibraryID: () => number;
  resolveCurrentPaperBaseItem: () => Zotero.Item | null;
  getManualPaperContextsForItem: (itemId: number, auto: any) => any[];
  resolveAutoLoadedPaperContext: () => any;
  persistDraftInputForCurrentConversation: () => void;
  restoreDraftInputForCurrentConversation: () => void;
  syncConversationIdentity: () => void;
  syncQueuedFollowUpRegistration: () => void;
  updateRuntimeModeButton: () => void;
  updateClaudeSystemToggle: () => void;
  refreshChatPreservingScroll: () => void;
  resetComposePreviewUI: () => void;
  updateModelButton: () => void;
  updateReasoningButton: () => void;
  updatePaperPreviewPreservingScroll: () => void;
  clearForcedSkill: () => void;
  closePaperPicker: () => void;
  closePromptMenu: () => void;
  closeResponseMenu: () => void;
  closeRetryModelMenu: () => void;
  closeExportMenu: () => void;
  closeHistoryRowMenu: () => void;
  closeHistoryNewMenu: () => void;
  closeHistoryMenu: () => void;
  isHistoryMenuOpen: () => boolean;
  isHistoryNewMenuOpen: () => boolean;
  runWithChatScrollGuard: (fn: () => void) => void;
  clearSelectedImageState: (itemId: number) => void;
  clearSelectedFileState: (itemId: number) => void;
  clearSelectedTextState: (itemId: number) => void;
  clearDraftInputState: (itemId: number) => void;
  clearTransientComposeStateForItem: (itemId: number) => void;
  scheduleAttachmentGc: () => void;
  notifyConversationHistoryChanged: () => void;
  renderWebChatHistoryMenu: () => Promise<void>;
  closeModelMenu: () => void;
  closeReasoningMenu: () => void;
  closeSlashMenu: () => void;
  getSelectedModelInfo: () => {
    selectedEntryId: string;
    selectedEntry: { authMode?: string; entryId?: string } | null;
    currentModel: string;
  };
  markNextWebChatSendAsNewChat: () => void;
  primeFreshWebChatPaperChipState: () => void;
  updateImagePreviewPreservingScroll: () => void;
  getPreferredTargetSystem: () => ConversationSystem;
  switchConversationSystem: (
    nextSystem: ConversationSystem,
    options?: { forceFresh?: boolean },
  ) => Promise<void>;
  runExplicitNewChatAction?: (action: () => Promise<void>) => Promise<void>;
  setActiveEditSession: (value: any) => void;
  getCoreAgentRuntime: () => ReturnType<typeof getCoreAgentRuntime>;
  clearPendingRequestForConversation?: (conversationKey: number) => void;
  setStatusMessage?: (message: string, level: StatusLevel) => void;
  log: (message: string, ...args: unknown[]) => void;
};

export function createHistoryLifecycleController(
  deps: HistoryLifecycleControllerDeps,
) {
  let item = deps.getItem();
  let basePaperItem = deps.getBasePaperItem();
  const syncStateFromDeps = () => {
    item = deps.getItem();
    basePaperItem = deps.getBasePaperItem();
  };
  const setCurrentItem = (nextItem: Zotero.Item | null) => {
    item = nextItem;
    deps.setItem(nextItem);
  };
  const setBasePaperItem = (nextItem: Zotero.Item | null) => {
    basePaperItem = nextItem;
    deps.setBasePaperItem(nextItem);
  };
  const {
    body,
    inputBox,
    panelRoot,
    status,
    historyBar,
    titleStatic,
    historyNewBtn,
    historyNewMenu,
    historyNewOpenBtn,
    historyNewPaperBtn,
    historyToggleBtn,
    historyMenu,
    historyRowMenu,
    historyRowRenameBtn,
    historyUndo,
    historyUndoText,
    historyUndoBtn,
    modeChipBtn,
    claudeSystemToggleBtn,
  } = deps;
  const getConversationSystem = deps.getConversationSystem;
  const isClaudeConversationSystem = deps.isClaudeConversationSystem;
  const isCodexConversationSystem = deps.isCodexConversationSystem;
  const isRuntimeConversationSystem = deps.isRuntimeConversationSystem;
  const isNoteSession = deps.isNoteSession;
  const isGlobalMode = deps.isGlobalMode;
  const isPaperMode = deps.isPaperMode;
  const isWebChatMode = deps.isWebChatMode;
  const getCurrentLibraryID = deps.getCurrentLibraryID;
  const resolveCurrentPaperBaseItem = deps.resolveCurrentPaperBaseItem;
  const getManualPaperContextsForItem = deps.getManualPaperContextsForItem;
  const resolveAutoLoadedPaperContext = deps.resolveAutoLoadedPaperContext;
  const persistDraftInputForCurrentConversation =
    deps.persistDraftInputForCurrentConversation;
  const restoreDraftInputForCurrentConversation =
    deps.restoreDraftInputForCurrentConversation;
  const syncConversationIdentity = deps.syncConversationIdentity;
  const syncQueuedFollowUpRegistration = deps.syncQueuedFollowUpRegistration;
  const updateRuntimeModeButton = deps.updateRuntimeModeButton;
  const updateClaudeSystemToggle = deps.updateClaudeSystemToggle;
  const refreshChatPreservingScroll = deps.refreshChatPreservingScroll;
  const resetComposePreviewUI = deps.resetComposePreviewUI;
  const updateModelButton = deps.updateModelButton;
  const updateReasoningButton = deps.updateReasoningButton;
  const updatePaperPreviewPreservingScroll =
    deps.updatePaperPreviewPreservingScroll;
  const clearForcedSkill = deps.clearForcedSkill;
  const closePaperPicker = deps.closePaperPicker;
  const closePromptMenu = deps.closePromptMenu;
  const closeResponseMenu = deps.closeResponseMenu;
  const closeRetryModelMenu = deps.closeRetryModelMenu;
  const closeExportMenu = deps.closeExportMenu;
  let historyRowMenuTarget: {
    kind: "paper" | "global";
    conversationKey: number;
  } | null = null;
  const resetHistorySearchState = () => {
    historySearchLoadSeq += 1;
    historySearchQuery = "";
    historySearchExpanded = false;
    historySearchLoading = false;
    historySearchEntries = [];
  };
  const closeHistoryRowMenu = () => {
    deps.closeHistoryRowMenu();
    historyRowMenuTarget = null;
  };
  const closeHistoryNewMenu = deps.closeHistoryNewMenu;
  const closeHistoryMenu = () => {
    deps.closeHistoryMenu();
  };
  const isHistoryMenuOpen = deps.isHistoryMenuOpen;
  const isHistoryNewMenuOpen = deps.isHistoryNewMenuOpen;
  const runWithChatScrollGuard = deps.runWithChatScrollGuard;
  const clearSelectedImageState = deps.clearSelectedImageState;
  const clearSelectedFileState = deps.clearSelectedFileState;
  const clearSelectedTextState = deps.clearSelectedTextState;
  const clearDraftInputState = deps.clearDraftInputState;
  const clearTransientComposeStateForItem =
    deps.clearTransientComposeStateForItem;
  const scheduleAttachmentGc = deps.scheduleAttachmentGc;
  const notifyConversationHistoryChanged =
    deps.notifyConversationHistoryChanged;
  const renderWebChatHistoryMenu = deps.renderWebChatHistoryMenu;
  const closeModelMenu = deps.closeModelMenu;
  const closeReasoningMenu = deps.closeReasoningMenu;
  const closeSlashMenu = deps.closeSlashMenu;
  const getSelectedModelInfo = deps.getSelectedModelInfo;
  const markNextWebChatSendAsNewChat = deps.markNextWebChatSendAsNewChat;
  const primeFreshWebChatPaperChipState = deps.primeFreshWebChatPaperChipState;
  const updateImagePreviewPreservingScroll =
    deps.updateImagePreviewPreservingScroll;
  const getPreferredTargetSystem = deps.getPreferredTargetSystem;
  const switchConversationSystem = deps.switchConversationSystem;
  const setActiveEditSession = deps.setActiveEditSession;
  const ztoolkit = { log: deps.log };
  const panelWin = body.ownerDocument?.defaultView || null;
  const ensureClaudeConversationCatalogEntry = async (params: {
    conversationKey: number;
    libraryID: number;
    kind: "global" | "paper";
    paperItemID?: number;
    title?: string;
  }) => {
    const existing = await getClaudeConversationSummary(params.conversationKey);
    if (existing) return existing;
    await upsertClaudeConversationSummary({
      conversationKey: params.conversationKey,
      libraryID: params.libraryID,
      kind: params.kind,
      paperItemID: params.paperItemID,
      title: params.title || "",
    });
    return getClaudeConversationSummary(params.conversationKey);
  };
  const ensureCodexConversationCatalogEntry = async (params: {
    conversationKey: number;
    libraryID: number;
    kind: "global" | "paper";
    paperItemID?: number;
    title?: string;
  }) => {
    const existing = await getCodexConversationSummary(params.conversationKey);
    if (existing) return existing;
    await upsertCodexConversationSummary({
      conversationKey: params.conversationKey,
      libraryID: params.libraryID,
      kind: params.kind,
      paperItemID: params.paperItemID,
      title: params.title || "",
    });
    return getCodexConversationSummary(params.conversationKey);
  };
  const isClaudeConversationDraft = async (conversationKey: number) => {
    const summary = await getClaudeConversationSummary(conversationKey);
    return !summary || (summary.userTurnCount || 0) <= 0;
  };
  const isCodexConversationDraft = async (conversationKey: number) => {
    const summary = await getCodexConversationSummary(conversationKey);
    return !summary || (summary.userTurnCount || 0) <= 0;
  };
  let latestConversationHistory: ConversationHistoryEntry[] = [];
  let explicitNewChatInFlight = false;

  let historySearchQuery = "";
  let historySearchExpanded = false;
  let historySearchLoading = false;
  let historySearchEntries: ConversationHistoryEntry[] = [];
  let historySearchLoadSeq = 0;
  const historySearchDocumentCache = new Map<
    number,
    CachedHistorySearchDocument
  >();
  const historySearchDocumentTasks = new Map<
    number,
    PendingHistorySearchDocumentTask
  >();
  const historySearchDocumentCacheLimit = Math.max(GLOBAL_HISTORY_LIMIT, 200);
  let globalHistoryLoadSeq = 0;
  let pendingHistoryDeletion: PendingHistoryDeletion | null = null;
  const pendingHistoryDeletionKeys = new Set<number>();
  const MESSAGE_TURN_UNDO_WINDOW_MS = 8000;
  type PendingTurnDeletion = {
    conversationKey: number;
    userTimestamp: number;
    assistantTimestamp: number;
    userIndex: number;
    userMessage: Message;
    assistantMessage: Message;
    timeoutId: number | null;
    expiresAt: number;
  };
  let pendingTurnDeletion: PendingTurnDeletion | null = null;

  const getWindowTimeout = (fn: () => void, delayMs: number): number => {
    const win = body.ownerDocument?.defaultView;
    if (win) return win.setTimeout(fn, delayMs);
    return (setTimeout(fn, delayMs) as unknown as number) || 0;
  };

  const clearWindowTimeout = (timeoutId: number | null) => {
    if (!Number.isFinite(timeoutId)) return;
    const win = body.ownerDocument?.defaultView;
    if (win) {
      win.clearTimeout(timeoutId as number);
      return;
    }
    clearTimeout(timeoutId as unknown as ReturnType<typeof setTimeout>);
  };

  const hideHistoryUndoToast = () => {
    if (historyUndo) historyUndo.style.display = "none";
    if (historyUndoText) historyUndoText.textContent = "";
  };

  const showHistoryUndoToast = (title: string) => {
    if (!historyUndo || !historyUndoText) return;
    const displayTitle =
      normalizeHistoryTitle(title) || normalizeHistoryTitle("Untitled chat");
    historyUndoText.textContent = `Deleted "${displayTitle}"`;
    historyUndo.style.display = "flex";
  };

  const showTurnUndoToast = () => {
    if (!historyUndo || !historyUndoText) return;
    historyUndoText.textContent = t("Deleted one turn");
    historyUndo.style.display = "flex";
  };

  const cloneTurnMessageForUndo = (message: Message): Message => ({
    ...message,
    selectedTexts: Array.isArray(message.selectedTexts)
      ? [...message.selectedTexts]
      : undefined,
    selectedTextSources: Array.isArray(message.selectedTextSources)
      ? [...message.selectedTextSources]
      : undefined,
    selectedTextPaperContexts: Array.isArray(message.selectedTextPaperContexts)
      ? [...message.selectedTextPaperContexts]
      : undefined,
    selectedTextNoteContexts: Array.isArray(message.selectedTextNoteContexts)
      ? [...message.selectedTextNoteContexts]
      : undefined,
    screenshotImages: Array.isArray(message.screenshotImages)
      ? [...message.screenshotImages]
      : undefined,
    paperContexts: Array.isArray(message.paperContexts)
      ? [...message.paperContexts]
      : undefined,
    fullTextPaperContexts: Array.isArray(message.fullTextPaperContexts)
      ? [...message.fullTextPaperContexts]
      : undefined,
    citationPaperContexts: Array.isArray(message.citationPaperContexts)
      ? [...message.citationPaperContexts]
      : undefined,
    attachments: Array.isArray(message.attachments)
      ? message.attachments.map((attachment) => ({ ...attachment }))
      : undefined,
  });

  const findTurnPairByTimestamps = (
    history: Message[],
    userTimestamp: number,
    assistantTimestamp: number,
  ): {
    userIndex: number;
    userMessage: Message;
    assistantMessage: Message;
  } | null => {
    const normalizedUserTimestamp = Number.isFinite(userTimestamp)
      ? Math.floor(userTimestamp)
      : 0;
    const normalizedAssistantTimestamp = Number.isFinite(assistantTimestamp)
      ? Math.floor(assistantTimestamp)
      : 0;
    if (normalizedUserTimestamp <= 0 || normalizedAssistantTimestamp <= 0) {
      return null;
    }
    for (let index = 0; index < history.length - 1; index++) {
      const userMessage = history[index];
      const assistantMessage = history[index + 1];
      if (!userMessage || !assistantMessage) continue;
      if (
        userMessage.role !== "user" ||
        assistantMessage.role !== "assistant"
      ) {
        continue;
      }
      if (
        Math.floor(userMessage.timestamp) === normalizedUserTimestamp &&
        Math.floor(assistantMessage.timestamp) === normalizedAssistantTimestamp
      ) {
        return { userIndex: index, userMessage, assistantMessage };
      }
    }
    return null;
  };

  const collectAttachmentHashesFromMessages = (
    messages: Message[],
  ): string[] => {
    const hashes = new Set<string>();
    for (const message of messages) {
      const attachments = Array.isArray(message.attachments)
        ? message.attachments
        : [];
      for (const attachment of attachments) {
        if (!attachment || attachment.category === "image") continue;
        const contentHash =
          normalizeAttachmentContentHash(attachment.contentHash) ||
          extractManagedBlobHash(attachment.storedPath);
        if (!contentHash) continue;
        hashes.add(contentHash);
      }
    }
    return Array.from(hashes);
  };

  const isHistoryEntryActive = (entry: ConversationHistoryEntry): boolean => {
    if (!item) return false;
    const activeConversationKey = getConversationKey(item);
    if (entry.kind === "paper" && !isGlobalMode()) {
      return !isGlobalMode() && activeConversationKey === entry.conversationKey;
    }
    if (entry.kind === "global" && isGlobalMode()) {
      return activeConversationKey === entry.conversationKey;
    }
    return false;
  };

  const resolveHistoryPaperLabel = (paperItemID?: number): string => {
    const normalizedPaperItemID =
      Number.isFinite(Number(paperItemID)) && Number(paperItemID) > 0
        ? Math.floor(Number(paperItemID))
        : 0;
    if (!normalizedPaperItemID) return "Paper chat";
    try {
      const paperItem = Zotero.Items.get(normalizedPaperItemID) || null;
      const title = String(paperItem?.getField?.("title") || "").trim();
      return title || "Paper chat";
    } catch (_err) {
      return "Paper chat";
    }
  };

  const resolveHistoryScopeChipLabel = (
    entry: ConversationHistoryEntry,
  ): string => {
    if (entry.kind !== "paper") return "Library chat";
    const paperItemID = Number(entry.paperItemID || 0);
    if (!Number.isFinite(paperItemID) || paperItemID <= 0) {
      return "Paper chat";
    }
    try {
      const paperItem = Zotero.Items.get(Math.floor(paperItemID)) || null;
      let firstCreator = "";
      let year = "";
      try {
        firstCreator = String(
          paperItem?.getField?.("firstCreator") || "",
        ).trim();
      } catch (_err) {
        firstCreator = "";
      }
      try {
        year = String(paperItem?.getField?.("year") || "").trim();
      } catch (_err) {
        year = "";
      }
      if (firstCreator && year) return `${firstCreator}, ${year}`;
      if (firstCreator) return firstCreator;
      if (year) return year;
      return "Paper chat";
    } catch (_err) {
      return "Paper chat";
    }
  };

  const createHistorySearchEntry = (params: {
    kind: "paper" | "global";
    conversationKey: number;
    title?: string;
    createdAt?: number;
    lastActivityAt: number;
    isDraft?: boolean;
    paperItemID?: number;
    sessionVersion?: number;
  }): ConversationHistoryEntry | null => {
    const conversationKey = Number(params.conversationKey);
    if (!Number.isFinite(conversationKey) || conversationKey <= 0) {
      return null;
    }
    const lastActivity = Number(params.lastActivityAt || params.createdAt || 0);
    const normalizedLastActivity = Number.isFinite(lastActivity)
      ? Math.floor(lastActivity)
      : 0;
    const isDraft = Boolean(params.isDraft);
    const paperItemID =
      params.kind === "paper" &&
      Number.isFinite(Number(params.paperItemID)) &&
      Number(params.paperItemID) > 0
        ? Math.floor(Number(params.paperItemID))
        : undefined;
    return {
      kind: params.kind,
      section: params.kind === "paper" ? "paper" : "open",
      sectionTitle:
        params.kind === "paper"
          ? resolveHistoryPaperLabel(paperItemID)
          : "Library chat",
      conversationKey: Math.floor(conversationKey),
      title:
        normalizeHistoryTitle(params.title) ||
        (isDraft ? "New chat" : "Untitled chat"),
      timestampText: isDraft
        ? "Draft"
        : formatGlobalHistoryTimestamp(normalizedLastActivity) ||
          (params.kind === "paper" ? "Paper chat" : "Library chat"),
      deletable: true,
      isDraft,
      isPendingDelete: false,
      lastActivityAt: normalizedLastActivity,
      paperItemID,
      sessionVersion:
        params.kind === "paper" &&
        Number.isFinite(Number(params.sessionVersion)) &&
        Number(params.sessionVersion) > 0
          ? Math.floor(Number(params.sessionVersion))
          : undefined,
    };
  };

  const loadSearchableConversationHistory = async (
    libraryID: number,
  ): Promise<ConversationHistoryEntry[]> => {
    const normalizedLibraryID =
      Number.isFinite(libraryID) && libraryID > 0 ? Math.floor(libraryID) : 0;
    if (!normalizedLibraryID) return [];
    const searchLimit = Math.max(GLOBAL_HISTORY_LIMIT, 100);
    const entries: ConversationHistoryEntry[] = [];

    if (isClaudeConversationSystem()) {
      const summaries = await loadAllClaudeConversationHistory({
        libraryID: normalizedLibraryID,
        limit: searchLimit,
      });
      for (const summary of summaries) {
        const entry = createHistorySearchEntry({
          kind: summary.kind === "paper" ? "paper" : "global",
          conversationKey: summary.conversationKey,
          title: summary.title,
          createdAt: summary.createdAt,
          lastActivityAt: summary.lastActivityAt,
          isDraft: summary.isDraft,
          paperItemID: summary.paperItemID,
        });
        if (entry) entries.push(entry);
      }
    } else if (isCodexConversationSystem()) {
      const summaries = await loadAllCodexConversationHistory({
        libraryID: normalizedLibraryID,
        limit: searchLimit,
      });
      for (const summary of summaries) {
        const entry = createHistorySearchEntry({
          kind: summary.kind === "paper" ? "paper" : "global",
          conversationKey: summary.conversationKey,
          title: summary.title,
          createdAt: summary.createdAt,
          lastActivityAt: summary.lastActivityAt,
          isDraft: summary.isDraft,
          paperItemID: summary.paperItemID,
        });
        if (entry) entries.push(entry);
      }
    } else {
      const summaries = await loadAllConversationHistory({
        libraryID: normalizedLibraryID,
        limit: searchLimit,
      });
      for (const summary of summaries) {
        const entry = createHistorySearchEntry({
          kind: summary.mode === "paper" ? "paper" : "global",
          conversationKey: summary.conversationKey,
          title: summary.title,
          createdAt: summary.createdAt,
          lastActivityAt: summary.lastActivityAt,
          isDraft: summary.isDraft,
          paperItemID: summary.paperItemID,
          sessionVersion: summary.sessionVersion,
        });
        if (entry) entries.push(entry);
      }
    }

    entries.sort((a, b) => {
      if (b.lastActivityAt !== a.lastActivityAt) {
        return b.lastActivityAt - a.lastActivityAt;
      }
      return b.conversationKey - a.conversationKey;
    });
    return entries;
  };

  const buildHistorySearchDocument = async (
    entry: ConversationHistoryEntry,
  ): Promise<HistorySearchDocument> => {
    const messages = isClaudeConversationSystem()
      ? await loadClaudeConversation(
          entry.conversationKey,
          PERSISTED_HISTORY_LIMIT,
        )
      : isCodexConversationSystem()
        ? await loadCodexConversation(
            entry.conversationKey,
            PERSISTED_HISTORY_LIMIT,
          )
        : await loadConversation(
            entry.conversationKey,
            PERSISTED_HISTORY_LIMIT,
          );
    return createHistorySearchDocument(entry, messages);
  };

  const getHistorySearchDocumentFingerprint = (
    entry: ConversationHistoryEntry,
  ): string => createHistorySearchDocumentFingerprint(entry);

  const getUsableHistorySearchDocument = (
    entry: ConversationHistoryEntry,
  ): HistorySearchDocument | null => {
    const cached = historySearchDocumentCache.get(entry.conversationKey);
    if (!cached) return null;
    if (cached.fingerprint !== getHistorySearchDocumentFingerprint(entry)) {
      return null;
    }
    return cached.document;
  };

  const hasUsableHistorySearchDocument = (
    entry: ConversationHistoryEntry,
  ): boolean => Boolean(getUsableHistorySearchDocument(entry));

  const getHistorySearchDocumentMap = (
    entries: ConversationHistoryEntry[],
  ): Map<number, HistorySearchDocument> => {
    const documents = new Map<number, HistorySearchDocument>();
    for (const entry of entries) {
      const document = getUsableHistorySearchDocument(entry);
      if (document) {
        documents.set(entry.conversationKey, document);
      }
    }
    return documents;
  };

  const pruneHistorySearchDocumentCache = () => {
    if (historySearchDocumentCache.size <= historySearchDocumentCacheLimit) {
      return;
    }
    const retainedKeys = new Set(
      latestConversationHistory
        .slice(0, historySearchDocumentCacheLimit)
        .map((entry) => entry.conversationKey),
    );
    for (const key of Array.from(historySearchDocumentCache.keys())) {
      if (historySearchDocumentCache.size <= historySearchDocumentCacheLimit) {
        return;
      }
      if (!retainedKeys.has(key)) {
        historySearchDocumentCache.delete(key);
      }
    }
    for (const key of Array.from(historySearchDocumentCache.keys())) {
      if (historySearchDocumentCache.size <= historySearchDocumentCacheLimit) {
        return;
      }
      historySearchDocumentCache.delete(key);
    }
  };

  const invalidateHistorySearchDocument = (conversationKey: number) => {
    const normalizedKey = Number.isFinite(conversationKey)
      ? Math.floor(conversationKey)
      : 0;
    if (normalizedKey <= 0) return;
    historySearchDocumentCache.delete(normalizedKey);
    historySearchDocumentTasks.delete(normalizedKey);
  };

  const ensureHistorySearchDocument = async (
    entry: ConversationHistoryEntry,
  ): Promise<HistorySearchDocument> => {
    const fingerprint = getHistorySearchDocumentFingerprint(entry);
    const cached = historySearchDocumentCache.get(entry.conversationKey);
    if (cached?.fingerprint === fingerprint) return cached.document;
    const pending = historySearchDocumentTasks.get(entry.conversationKey);
    if (pending?.fingerprint === fingerprint) return pending.task;
    const task = buildHistorySearchDocument(entry)
      .then((document) => {
        const currentTask = historySearchDocumentTasks.get(
          entry.conversationKey,
        );
        if (currentTask?.task === task) {
          historySearchDocumentCache.set(entry.conversationKey, {
            fingerprint,
            document,
          });
          historySearchDocumentTasks.delete(entry.conversationKey);
          pruneHistorySearchDocumentCache();
        }
        return document;
      })
      .catch((error) => {
        const currentTask = historySearchDocumentTasks.get(
          entry.conversationKey,
        );
        if (currentTask?.task === task) {
          historySearchDocumentTasks.delete(entry.conversationKey);
        }
        ztoolkit.log("LLM: Failed to index conversation history for search", {
          conversationKey: entry.conversationKey,
          error,
        });
        const fallback: HistorySearchDocument = {
          conversationKey: entry.conversationKey,
          candidates: [],
        };
        if (currentTask?.task === task) {
          historySearchDocumentCache.set(entry.conversationKey, {
            fingerprint,
            document: fallback,
          });
          pruneHistorySearchDocumentCache();
        }
        return fallback;
      });
    historySearchDocumentTasks.set(entry.conversationKey, {
      fingerprint,
      task,
    });
    return task;
  };

  const ensureHistorySearchDocuments = async (
    entries: ConversationHistoryEntry[],
  ) => {
    await Promise.all(
      entries.map((entry) => ensureHistorySearchDocument(entry)),
    );
  };

  const renderGlobalHistoryMenu = () => {
    if (!historyMenu) return;
    historyMenu.innerHTML = "";
    const searchQuery = historySearchQuery;
    const normalizedSearchQuery = normalizeHistorySearchQuery(searchQuery);
    const searchTokens = tokenizeHistorySearchQuery(normalizedSearchQuery);
    const searchActive = searchTokens.length > 0;
    const scopedEntries = latestConversationHistory.filter(
      (entry) => !entry.isPendingDelete,
    );
    const allEntries = searchActive
      ? historySearchEntries.filter((entry) => !entry.isPendingDelete)
      : scopedEntries;
    const searchWrap = createElement(
      body.ownerDocument as Document,
      "div",
      "llm-history-menu-search",
    ) as HTMLDivElement;
    if (historySearchExpanded) {
      const searchInput = createElement(
        body.ownerDocument as Document,
        "input",
        "llm-history-menu-search-input",
        {
          type: "text",
          value: searchQuery,
          placeholder: "Search history",
          autocomplete: "off",
          spellcheck: false,
        },
      ) as HTMLInputElement;
      searchInput.setAttribute("aria-label", "Search chat history");
      searchWrap.appendChild(searchInput);
    } else {
      const searchTrigger = createElement(
        body.ownerDocument as Document,
        "button",
        "llm-history-menu-search-trigger",
        {
          type: "button",
          textContent: "Search history",
          title: "Search chat history",
        },
      ) as HTMLButtonElement;
      searchTrigger.dataset.action = "expand-search";
      searchWrap.appendChild(searchTrigger);
    }
    historyMenu.appendChild(searchWrap);

    if (searchActive && historySearchLoading) {
      const loadingRow = createElement(
        body.ownerDocument as Document,
        "div",
        "llm-history-menu-empty",
        {
          textContent: "Searching history...",
        },
      );
      historyMenu.appendChild(loadingRow);
      return;
    }

    if (!allEntries.length) {
      const emptyRow = createElement(
        body.ownerDocument as Document,
        "div",
        "llm-history-menu-empty",
        {
          textContent: searchActive ? "No matching history" : "No history yet",
        },
      );
      historyMenu.appendChild(emptyRow);
      return;
    }

    const searchDocumentsReady = searchActive
      ? allEntries.every((entry) => hasUsableHistorySearchDocument(entry))
      : true;
    if (searchActive && !searchDocumentsReady) {
      const loadingRow = createElement(
        body.ownerDocument as Document,
        "div",
        "llm-history-menu-empty",
        {
          textContent: "Searching history...",
        },
      );
      historyMenu.appendChild(loadingRow);
      return;
    }
    const rawSearchResults = searchActive
      ? buildHistorySearchResults(
          allEntries,
          normalizedSearchQuery,
          getHistorySearchDocumentMap(allEntries),
        )
      : [];
    const searchResultsByKey = new Map<number, HistorySearchResult>();
    for (const result of rawSearchResults) {
      const existing = searchResultsByKey.get(result.entry.conversationKey);
      if (!existing || result.matchCount > existing.matchCount) {
        searchResultsByKey.set(result.entry.conversationKey, result);
      }
    }
    const searchResults = Array.from(searchResultsByKey.values());
    const filteredEntries = searchActive
      ? searchResults.map((result) => result.entry)
      : allEntries;
    if (!filteredEntries.length) {
      const emptyRow = createElement(
        body.ownerDocument as Document,
        "div",
        "llm-history-menu-empty",
        {
          textContent: "No matching history",
        },
      );
      historyMenu.appendChild(emptyRow);
      return;
    }
    // Sort entries: by match count when searching, otherwise by recency
    const sortedEntries = searchActive
      ? [...filteredEntries].sort((a, b) => {
          const matchDelta =
            (searchResultsByKey.get(b.conversationKey)?.matchCount || 0) -
            (searchResultsByKey.get(a.conversationKey)?.matchCount || 0);
          if (matchDelta !== 0) return matchDelta;
          if (b.lastActivityAt !== a.lastActivityAt) {
            return b.lastActivityAt - a.lastActivityAt;
          }
          return b.conversationKey - a.conversationKey;
        })
      : [...filteredEntries].sort(
          (a, b) => b.lastActivityAt - a.lastActivityAt,
        );

    // Group by day (matching standalone sidebar style)
    const dayGroups = groupHistoryEntriesByDay(sortedEntries, { translate: t });

    const itemsList = createElement(
      body.ownerDocument as Document,
      "div",
      "llm-history-items-list",
    ) as HTMLDivElement;

    for (const group of dayGroups) {
      const dayLabel = createElement(
        body.ownerDocument as Document,
        "div",
        "llm-history-day-label",
        { textContent: group.label },
      );
      itemsList.appendChild(dayLabel);

      for (const entry of group.items) {
        // Use <div> instead of <button> — Gecko buttons ignore overflow:hidden
        const item = createElement(
          body.ownerDocument as Document,
          "div",
          "llm-history-item",
        ) as HTMLDivElement;
        item.setAttribute("role", "button");
        item.setAttribute("tabindex", "0");
        item.dataset.conversationKey = `${entry.conversationKey}`;
        item.dataset.historyKind = entry.kind;
        item.dataset.historySection = entry.section;
        if (entry.paperItemID) {
          item.dataset.paperItemId = `${entry.paperItemID}`;
        }
        if (entry.sessionVersion) {
          item.dataset.sessionVersion = `${entry.sessionVersion}`;
        }
        if (isHistoryEntryActive(entry)) {
          item.classList.add("active");
        }
        if (entry.isPendingDelete) {
          item.classList.add("pending-delete");
        }

        const titleRow = createElement(
          body.ownerDocument as Document,
          "div",
          "llm-history-item-title-row",
        ) as HTMLDivElement;

        if (searchActive) {
          const scopeChip = createElement(
            body.ownerDocument as Document,
            "span",
            "llm-history-item-scope-chip",
            { textContent: resolveHistoryScopeChipLabel(entry) },
          ) as HTMLSpanElement;
          scopeChip.dataset.labelType =
            entry.kind === "paper" ? "paper" : "library";
          titleRow.appendChild(scopeChip);
        }

        const titleSpan = createElement(
          body.ownerDocument as Document,
          "span",
          "llm-history-item-title",
        );
        const displayTitle = formatHistoryRowDisplayTitle(entry.title);
        titleSpan.title = entry.title;
        const searchResult = searchResultsByKey.get(entry.conversationKey);
        if (searchResult?.titleRanges.length) {
          appendHistorySearchHighlightedText(
            titleSpan,
            displayTitle,
            searchResult.titleRanges,
          );
        } else {
          titleSpan.textContent = displayTitle;
        }
        titleRow.appendChild(titleSpan);

        if (entry.deletable) {
          const deleteBtn = createElement(
            body.ownerDocument as Document,
            "span",
            "llm-history-item-delete",
          ) as HTMLSpanElement;
          deleteBtn.setAttribute("role", "button");
          deleteBtn.setAttribute("aria-label", `Delete ${entry.title}`);
          deleteBtn.title = t("Delete conversation");
          deleteBtn.dataset.action = "delete";
          titleRow.appendChild(deleteBtn);
        }

        item.appendChild(titleRow);

        if (searchActive) {
          const metaParts = [
            entry.kind === "paper"
              ? entry.sectionTitle || "Paper chat"
              : "Library chat",
            entry.timestampText,
          ].filter((part) => Boolean(String(part || "").trim()));
          if (metaParts.length) {
            const meta = createElement(
              body.ownerDocument as Document,
              "div",
              "llm-history-item-meta",
              { textContent: metaParts.join(" · ") },
            );
            item.appendChild(meta);
          }
        }

        // Search preview snippet
        if (searchResult && searchResult.previewText) {
          item.classList.add("has-preview");
          const preview = createElement(
            body.ownerDocument as Document,
            "div",
            "llm-history-item-preview",
          );
          appendHistorySearchHighlightedText(
            preview,
            searchResult.previewText,
            searchResult.previewRanges,
          );
          item.appendChild(preview);
        }

        itemsList.appendChild(item);
      }
    }

    historyMenu.appendChild(itemsList);
  };

  const restoreHistorySearchInputFocus = () => {
    if (!historySearchExpanded) return;
    if (!historyMenu || historyMenu.style.display === "none") return;
    const searchInput = historyMenu.querySelector(
      ".llm-history-menu-search-input",
    ) as HTMLInputElement | null;
    if (!searchInput) return;
    const caret = searchInput.value.length;
    searchInput.focus({ preventScroll: true });
    try {
      searchInput.setSelectionRange(caret, caret);
    } catch (_error) {
      void _error;
    }
  };

  const expandHistorySearch = () => {
    historySearchExpanded = true;
    renderGlobalHistoryMenu();
    if (
      historyToggleBtn &&
      historyMenu &&
      historyMenu.style.display !== "none"
    ) {
      positionMenuBelowButton(body, historyMenu, historyToggleBtn);
    }
    restoreHistorySearchInputFocus();
  };

  const collapseHistorySearch = () => {
    if (!historySearchExpanded && !historySearchQuery) return;
    historySearchLoadSeq += 1;
    historySearchExpanded = false;
    historySearchQuery = "";
    historySearchLoading = false;
    renderGlobalHistoryMenu();
    if (
      historyToggleBtn &&
      historyMenu &&
      historyMenu.style.display !== "none"
    ) {
      positionMenuBelowButton(body, historyMenu, historyToggleBtn);
    }
  };

  const refreshHistorySearchMenu = async () => {
    const requestId = ++historySearchLoadSeq;
    const normalizedSearchQuery =
      normalizeHistorySearchQuery(historySearchQuery);
    if (!normalizedSearchQuery) {
      historySearchEntries = [];
      historySearchLoading = false;
      renderGlobalHistoryMenu();
      if (
        historyToggleBtn &&
        historyMenu &&
        historyMenu.style.display !== "none"
      ) {
        positionMenuBelowButton(body, historyMenu, historyToggleBtn);
      }
      restoreHistorySearchInputFocus();
      return;
    }
    historySearchLoading = true;
    renderGlobalHistoryMenu();
    if (
      historyToggleBtn &&
      historyMenu &&
      historyMenu.style.display !== "none"
    ) {
      positionMenuBelowButton(body, historyMenu, historyToggleBtn);
    }
    restoreHistorySearchInputFocus();

    let entries: ConversationHistoryEntry[] = [];
    try {
      const libraryID = getCurrentLibraryID();
      entries = libraryID
        ? await loadSearchableConversationHistory(libraryID)
        : [];
    } catch (err) {
      ztoolkit.log("LLM: Failed to load searchable conversation history", err);
      entries = [];
    }
    if (requestId !== historySearchLoadSeq) return;
    historySearchEntries = entries.filter(
      (entry) => !pendingHistoryDeletionKeys.has(entry.conversationKey),
    );

    const missingEntries = historySearchEntries.filter(
      (entry) => !hasUsableHistorySearchDocument(entry),
    );
    if (!missingEntries.length) {
      historySearchLoading = false;
      renderGlobalHistoryMenu();
      if (
        historyToggleBtn &&
        historyMenu &&
        historyMenu.style.display !== "none"
      ) {
        positionMenuBelowButton(body, historyMenu, historyToggleBtn);
      }
      restoreHistorySearchInputFocus();
      return;
    }
    await ensureHistorySearchDocuments(missingEntries);
    if (requestId !== historySearchLoadSeq) return;
    historySearchLoading = false;
    renderGlobalHistoryMenu();
    if (
      historyToggleBtn &&
      historyMenu &&
      historyMenu.style.display !== "none"
    ) {
      positionMenuBelowButton(body, historyMenu, historyToggleBtn);
    }
    restoreHistorySearchInputFocus();
  };

  const refreshGlobalHistoryHeader = async () => {
    if (!historyBar || !titleStatic || !item) {
      if (titleStatic) titleStatic.style.display = "";
      if (historyBar) historyBar.style.display = "none";
      closeHistoryNewMenu();
      closeHistoryMenu();
      hideHistoryUndoToast();
      notifyConversationHistoryChanged();
      return;
    }
    if (isNoteSession()) {
      titleStatic.style.display = "none";
      historyBar.style.display = "inline-flex";
      if (historyNewBtn) {
        historyNewBtn.style.display = "none";
        historyNewBtn.setAttribute("aria-expanded", "false");
      }
      if (historyToggleBtn) {
        historyToggleBtn.style.display = "none";
        historyToggleBtn.setAttribute("aria-expanded", "false");
      }
      if (historyMenu) {
        historyMenu.style.display = "none";
        historyMenu.textContent = "";
      }
      latestConversationHistory = [];
      closeHistoryNewMenu();
      closeHistoryMenu();
      hideHistoryUndoToast();
      notifyConversationHistoryChanged();
      return;
    }
    const libraryID = getCurrentLibraryID();
    const requestId = ++globalHistoryLoadSeq;
    const paperEntries: ConversationHistoryEntry[] = [];
    const globalEntries: ConversationHistoryEntry[] = [];
    const paperItem = resolveCurrentPaperBaseItem();

    if (libraryID && paperItem) {
      const paperItemID = Number(paperItem.id || 0);
      if (paperItemID > 0) {
        try {
          if (isClaudeConversationSystem()) {
            const activePaperKey =
              !isGlobalMode() &&
              item &&
              Number.isFinite(getConversationKey(item))
                ? Math.floor(getConversationKey(item))
                : 0;
            if (activePaperKey > 0) {
              await ensureClaudeConversationCatalogEntry({
                conversationKey: activePaperKey,
                libraryID,
                kind: "paper",
                paperItemID,
              });
            }
            const summaries = await loadClaudeConversationHistoryScope({
              libraryID,
              kind: "paper",
              paperItemID,
              limit: GLOBAL_HISTORY_LIMIT,
            });
            if (requestId !== globalHistoryLoadSeq) return;
            const seenPaperKeys = new Set<number>();
            for (const summary of summaries) {
              const conversationKey = Number(summary.conversationKey);
              const summaryPaperItemID = Number(summary.paperItemID);
              if (
                !Number.isFinite(conversationKey) ||
                conversationKey <= 0 ||
                !Number.isFinite(summaryPaperItemID) ||
                summaryPaperItemID !== paperItemID
              ) {
                continue;
              }
              const normalizedKey = Math.floor(conversationKey);
              if (pendingHistoryDeletionKeys.has(normalizedKey)) continue;
              if (seenPaperKeys.has(normalizedKey)) continue;
              seenPaperKeys.add(normalizedKey);
              const lastActivity = Number(
                summary.lastActivityAt || summary.createdAt || 0,
              );
              const isDraft = Boolean(summary.isDraft);
              paperEntries.push({
                kind: "paper",
                section: "paper",
                sectionTitle: "Paper Chat",
                conversationKey: normalizedKey,
                title: summary.title,
                timestampText: isDraft
                  ? "Draft"
                  : formatGlobalHistoryTimestamp(lastActivity) || "Paper chat",
                deletable: true,
                isDraft,
                isPendingDelete: false,
                lastActivityAt: Number.isFinite(lastActivity)
                  ? Math.floor(lastActivity)
                  : 0,
                paperItemID,
              });
            }
          } else if (isCodexConversationSystem()) {
            const activePaperKey =
              !isGlobalMode() &&
              item &&
              Number.isFinite(getConversationKey(item))
                ? Math.floor(getConversationKey(item))
                : 0;
            if (activePaperKey > 0) {
              await ensureCodexConversationCatalogEntry({
                conversationKey: activePaperKey,
                libraryID,
                kind: "paper",
                paperItemID,
              });
            }
            const summaries = await loadCodexConversationHistoryScope({
              libraryID,
              kind: "paper",
              paperItemID,
              limit: GLOBAL_HISTORY_LIMIT,
            });
            if (requestId !== globalHistoryLoadSeq) return;
            const seenPaperKeys = new Set<number>();
            for (const summary of summaries) {
              const conversationKey = Number(summary.conversationKey);
              const summaryPaperItemID = Number(summary.paperItemID);
              if (
                !Number.isFinite(conversationKey) ||
                conversationKey <= 0 ||
                !Number.isFinite(summaryPaperItemID) ||
                summaryPaperItemID !== paperItemID
              ) {
                continue;
              }
              const normalizedKey = Math.floor(conversationKey);
              if (pendingHistoryDeletionKeys.has(normalizedKey)) continue;
              if (seenPaperKeys.has(normalizedKey)) continue;
              seenPaperKeys.add(normalizedKey);
              const lastActivity = Number(
                summary.lastActivityAt || summary.createdAt || 0,
              );
              const isDraft = Boolean(summary.isDraft);
              paperEntries.push({
                kind: "paper",
                section: "paper",
                sectionTitle: "Paper Chat",
                conversationKey: normalizedKey,
                title: summary.title,
                timestampText: isDraft
                  ? "Draft"
                  : formatGlobalHistoryTimestamp(lastActivity) || "Paper chat",
                deletable: true,
                isDraft,
                isPendingDelete: false,
                lastActivityAt: Number.isFinite(lastActivity)
                  ? Math.floor(lastActivity)
                  : 0,
                paperItemID,
              });
            }
          } else {
            const summaries = await loadConversationHistoryScope({
              mode: "paper",
              libraryID,
              paperItemID,
              limit: GLOBAL_HISTORY_LIMIT,
            });
            if (requestId !== globalHistoryLoadSeq) return;
            const seenPaperKeys = new Set<number>();
            for (const summary of summaries) {
              const conversationKey = Number(summary.conversationKey);
              const sessionVersion = Number(summary.sessionVersion);
              const summaryPaperItemID = Number(summary.paperItemID);
              if (
                !Number.isFinite(conversationKey) ||
                conversationKey <= 0 ||
                !Number.isFinite(sessionVersion) ||
                sessionVersion <= 0 ||
                !Number.isFinite(summaryPaperItemID) ||
                summaryPaperItemID !== paperItemID
              ) {
                continue;
              }
              const normalizedKey = Math.floor(conversationKey);
              if (pendingHistoryDeletionKeys.has(normalizedKey)) continue;
              if (seenPaperKeys.has(normalizedKey)) continue;
              seenPaperKeys.add(normalizedKey);
              const lastActivity = Number(
                summary.lastActivityAt || summary.createdAt || 0,
              );
              const isDraft = Boolean(summary.isDraft);
              paperEntries.push({
                kind: "paper",
                section: "paper",
                sectionTitle: "Paper Chat",
                conversationKey: normalizedKey,
                title: summary.title,
                timestampText: isDraft
                  ? "Draft"
                  : formatGlobalHistoryTimestamp(lastActivity) || "Paper chat",
                deletable: true,
                isDraft,
                isPendingDelete: false,
                lastActivityAt: Number.isFinite(lastActivity)
                  ? Math.floor(lastActivity)
                  : 0,
                paperItemID,
                sessionVersion: Math.floor(sessionVersion),
              });
            }
          }
        } catch (err) {
          ztoolkit.log("LLM: Failed to load paper history entries", err);
        }
        paperEntries.sort((a, b) => {
          if (b.lastActivityAt !== a.lastActivityAt) {
            return b.lastActivityAt - a.lastActivityAt;
          }
          return b.conversationKey - a.conversationKey;
        });
      }
    }

    if (libraryID) {
      if (isClaudeConversationSystem()) {
        let activeGlobalKey = 0;
        if (isGlobalMode() && item && Number.isFinite(item.id) && item.id > 0) {
          activeGlobalKey = Math.floor(item.id);
        } else {
          const remembered = Number(
            activeClaudeGlobalConversationByLibrary.get(
              buildClaudeLibraryStateKey(libraryID),
            ) ||
              getLastUsedClaudeGlobalConversationKey(libraryID) ||
              0,
          );
          if (Number.isFinite(remembered) && remembered > 0) {
            activeGlobalKey = Math.floor(remembered);
          }
        }
        if (activeGlobalKey > 0) {
          try {
            await ensureClaudeConversationCatalogEntry({
              conversationKey: activeGlobalKey,
              libraryID,
              kind: "global",
            });
          } catch (err) {
            ztoolkit.log(
              "LLM: Failed to ensure active Claude history row",
              err,
            );
          }
        }
        if (requestId !== globalHistoryLoadSeq) return;

        let historyEntries = [] as Array<
          Awaited<
            ReturnType<typeof getClaudeConversationSummary>
          > extends infer T
            ? T extends null
              ? never
              : T
            : never
        >;
        try {
          historyEntries = await listClaudeGlobalConversations(
            libraryID,
            GLOBAL_HISTORY_LIMIT,
          );
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to load Claude global history entries",
            err,
          );
        }
        if (requestId !== globalHistoryLoadSeq) return;

        const seenGlobalKeys = new Set<number>();
        for (const entry of historyEntries) {
          const conversationKey = Number(entry.conversationKey);
          if (!Number.isFinite(conversationKey) || conversationKey <= 0)
            continue;
          const normalizedKey = Math.floor(conversationKey);
          if (pendingHistoryDeletionKeys.has(normalizedKey)) continue;
          if (seenGlobalKeys.has(normalizedKey)) continue;
          seenGlobalKeys.add(normalizedKey);
          const lastActivity = Number(entry.updatedAt || entry.createdAt || 0);
          const isDraft = entry.userTurnCount <= 0;
          globalEntries.push({
            kind: "global",
            section: "open",
            sectionTitle: "Library Chat",
            conversationKey: normalizedKey,
            title: entry.title || (isDraft ? "New Claude chat" : ""),
            timestampText: isDraft
              ? "Draft"
              : formatGlobalHistoryTimestamp(lastActivity) || "Standalone chat",
            deletable: true,
            isDraft,
            isPendingDelete: false,
            lastActivityAt: Number.isFinite(lastActivity)
              ? Math.floor(lastActivity)
              : 0,
          });
        }
      } else if (isCodexConversationSystem()) {
        let activeGlobalKey = 0;
        if (isGlobalMode() && item && Number.isFinite(item.id) && item.id > 0) {
          activeGlobalKey = Math.floor(item.id);
        } else {
          const remembered = Number(
            activeCodexGlobalConversationByLibrary.get(
              buildCodexLibraryStateKey(libraryID),
            ) ||
              getLastUsedCodexGlobalConversationKey(libraryID) ||
              0,
          );
          if (Number.isFinite(remembered) && remembered > 0) {
            activeGlobalKey = Math.floor(remembered);
          }
        }
        if (activeGlobalKey > 0) {
          try {
            await ensureCodexConversationCatalogEntry({
              conversationKey: activeGlobalKey,
              libraryID,
              kind: "global",
            });
          } catch (err) {
            ztoolkit.log("LLM: Failed to ensure active Codex history row", err);
          }
        }
        if (requestId !== globalHistoryLoadSeq) return;

        let historyEntries = [] as Array<
          Awaited<
            ReturnType<typeof getCodexConversationSummary>
          > extends infer T
            ? T extends null
              ? never
              : T
            : never
        >;
        try {
          historyEntries = await listCodexGlobalConversations(
            libraryID,
            GLOBAL_HISTORY_LIMIT,
          );
        } catch (err) {
          ztoolkit.log("LLM: Failed to load Codex global history entries", err);
        }
        if (requestId !== globalHistoryLoadSeq) return;

        const seenGlobalKeys = new Set<number>();
        for (const entry of historyEntries) {
          const conversationKey = Number(entry.conversationKey);
          if (!Number.isFinite(conversationKey) || conversationKey <= 0)
            continue;
          const normalizedKey = Math.floor(conversationKey);
          if (pendingHistoryDeletionKeys.has(normalizedKey)) continue;
          if (seenGlobalKeys.has(normalizedKey)) continue;
          seenGlobalKeys.add(normalizedKey);
          const lastActivity = Number(entry.updatedAt || entry.createdAt || 0);
          const isDraft = entry.userTurnCount <= 0;
          globalEntries.push({
            kind: "global",
            section: "open",
            sectionTitle: "Library Chat",
            conversationKey: normalizedKey,
            title: entry.title || (isDraft ? "New Codex chat" : ""),
            timestampText: isDraft
              ? "Draft"
              : formatGlobalHistoryTimestamp(lastActivity) || "Standalone chat",
            deletable: true,
            isDraft,
            isPendingDelete: false,
            lastActivityAt: Number.isFinite(lastActivity)
              ? Math.floor(lastActivity)
              : 0,
          });
        }
      } else {
        let activeGlobalKey = 0;
        if (isGlobalMode() && item && Number.isFinite(item.id) && item.id > 0) {
          activeGlobalKey = Math.floor(item.id);
        } else {
          const remembered = Number(
            activeGlobalConversationByLibrary.get(libraryID),
          );
          if (Number.isFinite(remembered) && remembered > 0) {
            activeGlobalKey = Math.floor(remembered);
          }
        }
        if (activeGlobalKey > 0) {
          try {
            await ensureGlobalConversationExists(libraryID, activeGlobalKey);
          } catch (err) {
            ztoolkit.log(
              "LLM: Failed to ensure active global history row",
              err,
            );
          }
        }
        if (requestId !== globalHistoryLoadSeq) return;

        let historyEntries: Awaited<
          ReturnType<typeof loadConversationHistoryScope>
        > = [];
        try {
          historyEntries = await loadConversationHistoryScope({
            mode: "open",
            libraryID,
            limit: GLOBAL_HISTORY_LIMIT,
          });
        } catch (err) {
          ztoolkit.log("LLM: Failed to load global history entries", err);
        }
        if (requestId !== globalHistoryLoadSeq) return;

        const seenGlobalKeys = new Set<number>();
        for (const entry of historyEntries) {
          const conversationKey = Number(entry.conversationKey);
          if (!Number.isFinite(conversationKey) || conversationKey <= 0)
            continue;
          const normalizedKey = Math.floor(conversationKey);
          if (pendingHistoryDeletionKeys.has(normalizedKey)) continue;
          if (seenGlobalKeys.has(normalizedKey)) continue;
          seenGlobalKeys.add(normalizedKey);
          const lastActivity = Number(
            entry.lastActivityAt || entry.createdAt || 0,
          );
          globalEntries.push({
            kind: "global",
            section: "open",
            sectionTitle: "Library Chat",
            conversationKey: normalizedKey,
            title: entry.title,
            timestampText: entry.isDraft
              ? "Draft"
              : formatGlobalHistoryTimestamp(lastActivity) || "Standalone chat",
            deletable: true,
            isDraft: Boolean(entry.isDraft),
            isPendingDelete: false,
            lastActivityAt: Number.isFinite(lastActivity)
              ? Math.floor(lastActivity)
              : 0,
          });
        }
      }

      const dedupedGlobalEntries: ConversationHistoryEntry[] = [];
      const seenGlobalEntryKeys = new Set<number>();
      for (const entry of globalEntries) {
        if (seenGlobalEntryKeys.has(entry.conversationKey)) continue;
        seenGlobalEntryKeys.add(entry.conversationKey);
        dedupedGlobalEntries.push(entry);
      }
      dedupedGlobalEntries.sort((a, b) => {
        if (b.lastActivityAt !== a.lastActivityAt) {
          return b.lastActivityAt - a.lastActivityAt;
        }
        if (a.isDraft !== b.isDraft) {
          return a.isDraft ? 1 : -1;
        }
        return b.conversationKey - a.conversationKey;
      });
      globalEntries.splice(0, globalEntries.length, ...dedupedGlobalEntries);
    }

    const activeHistorySection = isGlobalMode() ? "open" : "paper";
    const allEntries =
      activeHistorySection === "paper" ? paperEntries : globalEntries;
    const visibleEntries = allEntries.filter(
      (entry) => !pendingHistoryDeletionKeys.has(entry.conversationKey),
    );
    latestConversationHistory = [...visibleEntries].sort((a, b) => {
      if (b.lastActivityAt !== a.lastActivityAt) {
        return b.lastActivityAt - a.lastActivityAt;
      }
      if (a.isDraft !== b.isDraft) {
        return a.isDraft ? 1 : -1;
      }
      return b.conversationKey - a.conversationKey;
    });
    pruneHistorySearchDocumentCache();

    titleStatic.style.display = "none";
    historyBar.style.display = "inline-flex";
    renderGlobalHistoryMenu();
    notifyConversationHistoryChanged();
  };

  const switchGlobalConversation = async (nextConversationKey: number) => {
    if (!item || isNoteSession()) return;
    persistDraftInputForCurrentConversation();
    const libraryID = getCurrentLibraryID();
    if (!libraryID) return;
    const normalizedConversationKey = Number.isFinite(nextConversationKey)
      ? Math.floor(nextConversationKey)
      : 0;
    if (normalizedConversationKey <= 0) return;
    if (isClaudeConversationSystem()) {
      await ensureClaudeConversationCatalogEntry({
        conversationKey: normalizedConversationKey,
        libraryID,
        kind: "global",
      });
    } else if (isCodexConversationSystem()) {
      await ensureCodexConversationCatalogEntry({
        conversationKey: normalizedConversationKey,
        libraryID,
        kind: "global",
      });
    }
    const nextItem = isClaudeConversationSystem()
      ? createClaudeGlobalPortalItem(libraryID, normalizedConversationKey)
      : isCodexConversationSystem()
        ? createCodexGlobalPortalItem(libraryID, normalizedConversationKey)
        : createGlobalPortalItem(libraryID, normalizedConversationKey);
    setCurrentItem(nextItem as any);
    syncConversationIdentity();
    void renderShortcuts(body, item as Zotero.Item, resolveShortcutMode(item));
    if (isClaudeConversationSystem()) {
      rememberClaudeConversationSelection({
        conversationKey: normalizedConversationKey,
        kind: "global",
        libraryID,
      });
      void touchClaudeConversation(normalizedConversationKey, {
        updatedAt: Date.now(),
      });
    } else if (isCodexConversationSystem()) {
      activeCodexGlobalConversationByLibrary.set(
        buildCodexLibraryStateKey(libraryID),
        normalizedConversationKey,
      );
      setLastUsedCodexGlobalConversationKey(
        libraryID,
        normalizedConversationKey,
      );
    }
    setActiveEditSession(null);
    inlineEditCleanup?.();
    setInlineEditCleanup(null);
    setInlineEditTarget(null);
    clearForcedSkill();
    closePaperPicker();
    closePromptMenu();
    closeResponseMenu();
    closeRetryModelMenu();
    closeExportMenu();
    closeHistoryNewMenu();
    closeHistoryMenu();
    await ensureConversationLoaded(item as Zotero.Item);
    invalidateHistorySearchDocument(normalizedConversationKey);
    restoreDraftInputForCurrentConversation();
    refreshChatPreservingScroll();
    resetComposePreviewUI();
    updateModelButton();
    updateReasoningButton();
    void refreshGlobalHistoryHeader();
  };

  const switchPaperConversation = async (
    nextConversationKey?: number,
    options?: { paperItem?: Zotero.Item | null },
  ) => {
    if (!item || isNoteSession()) return;
    persistDraftInputForCurrentConversation();
    const paperItem = options?.paperItem || resolveCurrentPaperBaseItem();
    if (!paperItem) return;
    setBasePaperItem(paperItem);
    const libraryID = getCurrentLibraryID();
    if (!libraryID) return;
    const paperItemID = Number(paperItem.id || 0);
    if (!Number.isFinite(paperItemID) || paperItemID <= 0) return;

    const requestedConversationKey = Number(nextConversationKey || 0);
    if (isClaudeConversationSystem()) {
      let targetSummary =
        Number.isFinite(requestedConversationKey) &&
        requestedConversationKey > 0
          ? await getClaudeConversationSummary(
              Math.floor(requestedConversationKey),
            )
          : null;
      if (
        targetSummary &&
        (targetSummary.kind !== "paper" ||
          Number(targetSummary.paperItemID || 0) !== paperItemID)
      ) {
        targetSummary = null;
      }
      if (!targetSummary) {
        const rememberedConversationKey = Number(
          resolveRememberedClaudeConversationKey({
            libraryID,
            kind: "paper",
            paperItemID,
          }) || 0,
        );
        if (
          Number.isFinite(rememberedConversationKey) &&
          rememberedConversationKey > 0
        ) {
          const rememberedSummary = await getClaudeConversationSummary(
            Math.floor(rememberedConversationKey),
          );
          if (
            rememberedSummary &&
            rememberedSummary.kind === "paper" &&
            Number(rememberedSummary.paperItemID || 0) === paperItemID
          ) {
            targetSummary = rememberedSummary;
          }
        }
      }
      if (!targetSummary) {
        targetSummary = await ensureClaudePaperConversation(
          libraryID,
          paperItemID,
        );
      }
      if (!targetSummary) return;
      const resolvedConversationKey = Math.floor(targetSummary.conversationKey);
      setCurrentItem(
        createClaudePaperPortalItem(paperItem, resolvedConversationKey) as any,
      );
    } else if (isCodexConversationSystem()) {
      let targetSummary =
        Number.isFinite(requestedConversationKey) &&
        requestedConversationKey > 0
          ? await getCodexConversationSummary(
              Math.floor(requestedConversationKey),
            )
          : null;
      if (
        targetSummary &&
        (targetSummary.kind !== "paper" ||
          Number(targetSummary.paperItemID || 0) !== paperItemID)
      ) {
        targetSummary = null;
      }
      if (!targetSummary) {
        const rememberedConversationKey = Number(
          activeCodexPaperConversationByPaper.get(
            buildCodexPaperStateKey(libraryID, paperItemID),
          ) ||
            getLastUsedCodexPaperConversationKey(libraryID, paperItemID) ||
            0,
        );
        if (
          Number.isFinite(rememberedConversationKey) &&
          rememberedConversationKey > 0
        ) {
          const rememberedSummary = await getCodexConversationSummary(
            Math.floor(rememberedConversationKey),
          );
          if (
            rememberedSummary &&
            rememberedSummary.kind === "paper" &&
            Number(rememberedSummary.paperItemID || 0) === paperItemID
          ) {
            targetSummary = rememberedSummary;
          }
        }
      }
      if (!targetSummary) {
        targetSummary = await ensureCodexPaperConversation(
          libraryID,
          paperItemID,
        );
      }
      if (!targetSummary) return;
      const resolvedConversationKey = Math.floor(targetSummary.conversationKey);
      setCurrentItem(
        createCodexPaperPortalItem(paperItem, resolvedConversationKey) as any,
      );
    } else {
      let targetSummary =
        Number.isFinite(requestedConversationKey) &&
        requestedConversationKey > 0
          ? await getPaperConversation(Math.floor(requestedConversationKey))
          : null;
      if (targetSummary && targetSummary.paperItemID !== paperItemID) {
        targetSummary = null;
      }
      if (!targetSummary) {
        const rememberedConversationKey = Number(
          activePaperConversationByPaper.get(
            buildPaperStateKey(libraryID, paperItemID),
          ) ||
            getLastUsedPaperConversationKey(libraryID, paperItemID) ||
            0,
        );
        if (
          Number.isFinite(rememberedConversationKey) &&
          rememberedConversationKey > 0
        ) {
          const rememberedSummary = await getPaperConversation(
            Math.floor(rememberedConversationKey),
          );
          if (
            rememberedSummary &&
            rememberedSummary.paperItemID === paperItemID
          ) {
            targetSummary = rememberedSummary;
          }
        }
      }
      if (!targetSummary) {
        targetSummary = await ensurePaperV1Conversation(libraryID, paperItemID);
      }
      if (!targetSummary) return;
      const normalizedConversationKey = Math.floor(
        targetSummary.conversationKey,
      );
      const nextItem =
        normalizedConversationKey === paperItemID
          ? paperItem
          : createPaperPortalItem(
              paperItem,
              normalizedConversationKey,
              targetSummary.sessionVersion,
            );
      setCurrentItem(nextItem as any);
    }
    syncConversationIdentity();
    void renderShortcuts(body, item as Zotero.Item, resolveShortcutMode(item));
    if (isClaudeConversationSystem()) {
      rememberClaudeConversationSelection({
        conversationKey: Math.floor(getConversationKey(item as Zotero.Item)),
        kind: "paper",
        libraryID,
        paperItemID,
      });
      void touchClaudeConversation(
        Math.floor(getConversationKey(item as Zotero.Item)),
        {
          updatedAt: Date.now(),
        },
      );
    } else if (isCodexConversationSystem()) {
      const normalizedConversationKey = Math.floor(
        getConversationKey(item as Zotero.Item),
      );
      activeCodexPaperConversationByPaper.set(
        buildCodexPaperStateKey(libraryID, paperItemID),
        normalizedConversationKey,
      );
      setLastUsedCodexPaperConversationKey(
        libraryID,
        paperItemID,
        normalizedConversationKey,
      );
    }
    setActiveEditSession(null);
    inlineEditCleanup?.();
    setInlineEditCleanup(null);
    setInlineEditTarget(null);
    clearForcedSkill();
    closePaperPicker();
    closePromptMenu();
    closeResponseMenu();
    closeRetryModelMenu();
    closeExportMenu();
    closeHistoryNewMenu();
    closeHistoryMenu();
    await ensureConversationLoaded(item as Zotero.Item);
    invalidateHistorySearchDocument(getConversationKey(item as Zotero.Item));
    restoreDraftInputForCurrentConversation();
    refreshChatPreservingScroll();
    resetComposePreviewUI();
    updateModelButton();
    updateReasoningButton();
    void refreshGlobalHistoryHeader();
  };

  const switchToHistoryTarget = async (
    target: HistorySwitchTarget,
  ): Promise<void> => {
    if (!target) return;
    if (target.kind === "paper") {
      await switchPaperConversation(target.conversationKey);
      return;
    }
    await switchGlobalConversation(target.conversationKey);
  };

  const selectPaperItemFromHistoryEntry = async (
    entry: ConversationHistoryEntry,
  ): Promise<Zotero.Item | null> => {
    const paperItemID = Number(entry.paperItemID || 0);
    if (!Number.isFinite(paperItemID) || paperItemID <= 0) return null;
    const paperItem = Zotero.Items.get(Math.floor(paperItemID)) || null;
    if (!paperItem) return null;
    try {
      const pane = Zotero.getActiveZoteroPane?.() as
        | _ZoteroTypes.ZoteroPane
        | undefined;
      if (pane) {
        if (typeof pane.selectItems === "function") {
          await pane.selectItems([paperItem.id], true);
        } else if (typeof pane.selectItem === "function") {
          pane.selectItem(paperItem.id, true);
        }
      }
    } catch (err) {
      ztoolkit.log("LLM: Failed to select searched conversation paper", {
        paperItemID,
        error: err,
      });
    }
    return paperItem;
  };

  const switchToHistoryEntry = async (
    entry: ConversationHistoryEntry,
  ): Promise<void> => {
    if (entry.kind === "paper") {
      const paperItem = await selectPaperItemFromHistoryEntry(entry);
      if (!paperItem) {
        if (status) {
          setStatus(status, t("Could not find this paper"), "error");
        }
        return;
      }
      await switchPaperConversation(entry.conversationKey, { paperItem });
      return;
    }
    await switchGlobalConversation(entry.conversationKey);
  };

  const resolveFallbackAfterPaperDelete = async (
    libraryID: number,
    paperItemID: number,
    deletedConversationKey: number,
  ): Promise<HistorySwitchTarget> => {
    if (isClaudeConversationSystem()) {
      let summaries: Awaited<ReturnType<typeof listClaudePaperConversations>> =
        [];
      try {
        summaries = await listClaudePaperConversations(
          libraryID,
          paperItemID,
          GLOBAL_HISTORY_LIMIT,
        );
      } catch (err) {
        ztoolkit.log(
          "LLM: Failed to load fallback Claude paper history candidates",
          err,
        );
      }
      for (const summary of summaries) {
        const candidateKey = Number(summary.conversationKey);
        if (!Number.isFinite(candidateKey) || candidateKey <= 0) continue;
        const normalizedKey = Math.floor(candidateKey);
        if (normalizedKey === deletedConversationKey) continue;
        if (pendingHistoryDeletionKeys.has(normalizedKey)) continue;
        return { kind: "paper", conversationKey: normalizedKey };
      }
      let createdSummary: Awaited<
        ReturnType<typeof createClaudePaperConversation>
      > = null;
      try {
        createdSummary = await createClaudePaperConversation(
          libraryID,
          paperItemID,
        );
      } catch (err) {
        ztoolkit.log(
          "LLM: Failed to create fallback Claude paper conversation",
          err,
        );
      }
      if (createdSummary?.conversationKey) {
        return {
          kind: "paper",
          conversationKey: Math.floor(createdSummary.conversationKey),
        };
      }
      const ensured = await ensureClaudePaperConversation(
        libraryID,
        paperItemID,
      );
      if (ensured?.conversationKey) {
        const normalizedKey = Math.floor(ensured.conversationKey);
        if (
          normalizedKey === deletedConversationKey ||
          pendingHistoryDeletionKeys.has(normalizedKey)
        ) {
          return null;
        }
        return {
          kind: "paper",
          conversationKey: normalizedKey,
        };
      }
      return null;
    }
    let summaries: Awaited<ReturnType<typeof listPaperConversations>> = [];
    try {
      summaries = await listPaperConversations(
        libraryID,
        paperItemID,
        GLOBAL_HISTORY_LIMIT,
        true,
      );
    } catch (err) {
      ztoolkit.log(
        "LLM: Failed to load fallback paper history candidates",
        err,
      );
    }
    for (const summary of summaries) {
      const candidateKey = Number(summary.conversationKey);
      if (!Number.isFinite(candidateKey) || candidateKey <= 0) continue;
      const normalizedKey = Math.floor(candidateKey);
      if (normalizedKey === deletedConversationKey) continue;
      if (pendingHistoryDeletionKeys.has(normalizedKey)) continue;
      return { kind: "paper", conversationKey: normalizedKey };
    }
    let createdSummary: Awaited<ReturnType<typeof createPaperConversation>> =
      null;
    try {
      createdSummary = await createPaperConversation(libraryID, paperItemID);
    } catch (err) {
      ztoolkit.log("LLM: Failed to create fallback paper conversation", err);
    }
    if (createdSummary?.conversationKey) {
      return {
        kind: "paper",
        conversationKey: Math.floor(createdSummary.conversationKey),
      };
    }
    const ensured = await ensurePaperV1Conversation(libraryID, paperItemID);
    if (ensured?.conversationKey) {
      const normalizedKey = Math.floor(ensured.conversationKey);
      if (
        normalizedKey === deletedConversationKey ||
        pendingHistoryDeletionKeys.has(normalizedKey)
      ) {
        return null;
      }
      return {
        kind: "paper",
        conversationKey: normalizedKey,
      };
    }
    return null;
  };

  const resolveFallbackAfterGlobalDelete = async (
    libraryID: number,
    deletedConversationKey: number,
  ): Promise<HistorySwitchTarget> => {
    if (isClaudeConversationSystem()) {
      let remainingHistorical: Awaited<
        ReturnType<typeof listClaudeGlobalConversations>
      > = [];
      try {
        remainingHistorical = await listClaudeGlobalConversations(
          libraryID,
          GLOBAL_HISTORY_LIMIT,
        );
      } catch (err) {
        ztoolkit.log(
          "LLM: Failed to load fallback Claude global history candidates",
          err,
        );
      }
      for (const entry of remainingHistorical) {
        const candidateKey = Number(entry.conversationKey);
        if (!Number.isFinite(candidateKey) || candidateKey <= 0) continue;
        const normalizedKey = Math.floor(candidateKey);
        if (normalizedKey === deletedConversationKey) continue;
        if (pendingHistoryDeletionKeys.has(normalizedKey)) continue;
        return { kind: "global", conversationKey: normalizedKey };
      }
      const isEmptyDraft = async (
        conversationKey: number,
      ): Promise<boolean> => {
        if (!Number.isFinite(conversationKey) || conversationKey <= 0)
          return false;
        const normalizedKey = Math.floor(conversationKey);
        if (normalizedKey === deletedConversationKey) return false;
        if (pendingHistoryDeletionKeys.has(normalizedKey)) return false;
        const summary = await getClaudeConversationSummary(normalizedKey);
        return Boolean(summary && (summary.userTurnCount || 0) === 0);
      };
      let candidateDraftKey = Number(
        activeClaudeGlobalConversationByLibrary.get(
          buildClaudeLibraryStateKey(libraryID),
        ) ||
          getLastUsedClaudeGlobalConversationKey(libraryID) ||
          0,
      );
      if (!(await isEmptyDraft(candidateDraftKey))) {
        candidateDraftKey = 0;
        for (const summary of remainingHistorical) {
          const candidateKey = Number(summary.conversationKey);
          if (await isEmptyDraft(candidateKey)) {
            candidateDraftKey = Math.floor(candidateKey);
            break;
          }
        }
      }
      if (candidateDraftKey > 0) {
        return {
          kind: "global",
          conversationKey: Math.floor(candidateDraftKey),
        };
      }
      let createdDraftKey = 0;
      try {
        createdDraftKey = Number(
          (await createClaudeGlobalConversation(libraryID))?.conversationKey ||
            0,
        );
      } catch (err) {
        ztoolkit.log(
          "LLM: Failed to create fallback Claude draft conversation",
          err,
        );
      }
      if (createdDraftKey > 0) {
        return {
          kind: "global",
          conversationKey: Math.floor(createdDraftKey),
        };
      }
      return null;
    }
    let remainingHistorical: Awaited<
      ReturnType<typeof listGlobalConversations>
    > = [];
    try {
      remainingHistorical = await listGlobalConversations(
        libraryID,
        GLOBAL_HISTORY_LIMIT,
        false,
      );
    } catch (err) {
      ztoolkit.log(
        "LLM: Failed to load fallback global history candidates",
        err,
      );
    }
    for (const entry of remainingHistorical) {
      const candidateKey = Number(entry.conversationKey);
      if (!Number.isFinite(candidateKey) || candidateKey <= 0) continue;
      const normalizedKey = Math.floor(candidateKey);
      if (normalizedKey === deletedConversationKey) continue;
      if (pendingHistoryDeletionKeys.has(normalizedKey)) continue;
      return { kind: "global", conversationKey: normalizedKey };
    }
    const isEmptyDraft = async (conversationKey: number): Promise<boolean> => {
      if (!Number.isFinite(conversationKey) || conversationKey <= 0)
        return false;
      const normalizedKey = Math.floor(conversationKey);
      if (normalizedKey === deletedConversationKey) return false;
      if (pendingHistoryDeletionKeys.has(normalizedKey)) return false;
      try {
        const count = await getGlobalConversationUserTurnCount(normalizedKey);
        return count === 0;
      } catch (err) {
        ztoolkit.log(
          "LLM: Failed to inspect draft candidate user turn count",
          err,
        );
        return false;
      }
    };

    let candidateDraftKey = Number(
      activeGlobalConversationByLibrary.get(libraryID),
    );
    if (!(await isEmptyDraft(candidateDraftKey))) {
      candidateDraftKey = 0;
      try {
        const latestEmpty = await getLatestEmptyGlobalConversation(libraryID);
        const latestEmptyKey = Number(latestEmpty?.conversationKey || 0);
        if (await isEmptyDraft(latestEmptyKey)) {
          candidateDraftKey = Math.floor(latestEmptyKey);
        }
      } catch (err) {
        ztoolkit.log("LLM: Failed to load latest empty draft candidate", err);
      }
    }
    if (candidateDraftKey > 0) {
      return {
        kind: "global",
        conversationKey: Math.floor(candidateDraftKey),
      };
    }

    let createdDraftKey = 0;
    try {
      createdDraftKey = await createGlobalConversation(libraryID);
    } catch (err) {
      ztoolkit.log("LLM: Failed to create fallback draft conversation", err);
    }
    if (createdDraftKey > 0) {
      ztoolkit.log("LLM: Fallback target created new draft", {
        libraryID,
        conversationKey: createdDraftKey,
      });
      return {
        kind: "global",
        conversationKey: Math.floor(createdDraftKey),
      };
    }
    return null;
  };

  const clearPendingDeletionCaches = (conversationKey: number) => {
    invalidateHistorySearchDocument(conversationKey);
    chatHistory.delete(conversationKey);
    loadedConversationKeys.delete(conversationKey);
    selectedModelCache.delete(conversationKey);
    selectedReasoningCache.delete(conversationKey);
    selectedReasoningProviderCache.delete(conversationKey);
    clearTransientComposeStateForItem(conversationKey);
    clearConversationSummaryFromCache(conversationKey);
  };

  const invalidateClaudeConversationForDeletion = async (
    conversationKey: number,
    summary?: {
      libraryID?: number;
      kind?: "global" | "paper";
      paperItemID?: number;
      scopeType?: string;
      scopeId?: string;
      scopeLabel?: string;
    } | null,
  ): Promise<void> => {
    if (!isClaudeConversationSystem()) return;
    const libraryID = Number(summary?.libraryID || 0);
    const kind = summary?.kind;
    if (!Number.isFinite(libraryID) || libraryID <= 0 || !kind) {
      return;
    }
    const scope =
      summary?.scopeType === "paper" || summary?.scopeType === "open"
        ? {
            scopeType: summary.scopeType as "paper" | "open",
            scopeId: String(summary.scopeId || ""),
            scopeLabel:
              typeof summary.scopeLabel === "string" &&
              summary.scopeLabel.trim()
                ? summary.scopeLabel.trim()
                : undefined,
          }
        : buildClaudeScope({
            libraryID: Math.floor(libraryID),
            kind,
            paperItemID:
              kind === "paper"
                ? Number(summary?.paperItemID || 0) || undefined
                : undefined,
          });
    await invalidateClaudeConversationSession(getCoreAgentRuntime(), {
      conversationKey,
      scope,
    });
  };

  const finalizeGlobalConversationDeletion = async (
    pending: PendingHistoryDeletion,
  ): Promise<void> => {
    const conversationKey = pending.conversationKey;
    if (isClaudeConversationSystem()) {
      const rememberedKey = Number(
        activeClaudeGlobalConversationByLibrary.get(
          buildClaudeLibraryStateKey(pending.libraryID),
        ) || 0,
      );
      if (
        Number.isFinite(rememberedKey) &&
        Math.floor(rememberedKey) === conversationKey
      ) {
        activeClaudeGlobalConversationByLibrary.delete(
          buildClaudeLibraryStateKey(pending.libraryID),
        );
      }
      const persistedKey = Number(
        getLastUsedClaudeGlobalConversationKey(pending.libraryID) || 0,
      );
      if (
        Number.isFinite(persistedKey) &&
        Math.floor(persistedKey) === conversationKey
      ) {
        removeLastUsedClaudeGlobalConversationKey(pending.libraryID);
      }
    } else if (isCodexConversationSystem()) {
      const stateKey = buildCodexLibraryStateKey(pending.libraryID);
      const rememberedKey = Number(
        activeCodexGlobalConversationByLibrary.get(stateKey) || 0,
      );
      if (
        Number.isFinite(rememberedKey) &&
        Math.floor(rememberedKey) === conversationKey
      ) {
        activeCodexGlobalConversationByLibrary.delete(stateKey);
      }
      const persistedKey = Number(
        getLastUsedCodexGlobalConversationKey(pending.libraryID) || 0,
      );
      if (
        Number.isFinite(persistedKey) &&
        Math.floor(persistedKey) === conversationKey
      ) {
        removeLastUsedCodexGlobalConversationKey(pending.libraryID);
      }
    } else {
      const rememberedKey = Number(
        activeGlobalConversationByLibrary.get(pending.libraryID),
      );
      const lockedKey = getLockedGlobalConversationKey(pending.libraryID);
      if (
        Number.isFinite(lockedKey) &&
        lockedKey !== null &&
        Math.floor(lockedKey) === conversationKey
      ) {
        setLockedGlobalConversationKey(pending.libraryID, null);
      }
      if (
        Number.isFinite(rememberedKey) &&
        Math.floor(rememberedKey) === conversationKey
      ) {
        activeGlobalConversationByLibrary.delete(pending.libraryID);
      }
    }
    clearPendingDeletionCaches(conversationKey);
    let hasError = false;
    if (isClaudeConversationSystem()) {
      try {
        await invalidateClaudeConversationForDeletion(conversationKey, {
          libraryID: pending.libraryID,
          kind: "global",
          scopeType: "open",
          scopeId: buildClaudeScope({
            libraryID: Math.floor(pending.libraryID),
            kind: "global",
          }).scopeId,
          scopeLabel: "Open Chat",
        });
      } catch (err) {
        hasError = true;
        ztoolkit.log(
          "LLM: Failed to invalidate deleted Claude global conversation",
          err,
        );
      }
    }
    try {
      if (isClaudeConversationSystem()) {
        await clearClaudeConversation(conversationKey);
      } else if (isCodexConversationSystem()) {
        await clearCodexConversation(conversationKey);
      } else {
        await clearStoredConversation(conversationKey);
      }
    } catch (err) {
      hasError = true;
      ztoolkit.log("LLM: Failed to clear deleted history conversation", err);
    }
    try {
      await clearOwnerAttachmentRefs("conversation", conversationKey);
    } catch (err) {
      hasError = true;
      ztoolkit.log("LLM: Failed to clear deleted history attachment refs", err);
    }
    try {
      await removeConversationAttachmentFiles(conversationKey);
    } catch (err) {
      hasError = true;
      ztoolkit.log(
        "LLM: Failed to remove deleted history attachment files",
        err,
      );
    }
    try {
      if (isClaudeConversationSystem()) {
        await deleteClaudeConversation(conversationKey);
      } else if (isCodexConversationSystem()) {
        await deleteCodexConversation(conversationKey);
      } else {
        await deleteGlobalConversation(conversationKey);
      }
    } catch (err) {
      hasError = true;
      ztoolkit.log("LLM: Failed to delete global history conversation", err);
    }
    scheduleAttachmentGc();
    if (hasError && status) {
      setStatus(
        status,
        t("Failed to fully delete conversation. Check logs."),
        "error",
      );
    }
  };

  const finalizePaperConversationDeletion = async (
    pending: PendingHistoryDeletion,
  ): Promise<void> => {
    const conversationKey = pending.conversationKey;
    let paperItemID = Number(pending.paperItemID || 0);
    if (!paperItemID) {
      if (isClaudeConversationSystem()) {
        const summary = await getClaudeConversationSummary(conversationKey);
        paperItemID = Number(summary?.paperItemID || 0);
      } else if (isCodexConversationSystem()) {
        const summary = await getCodexConversationSummary(conversationKey);
        paperItemID = Number(summary?.paperItemID || 0);
      } else {
        const summary = await getPaperConversation(conversationKey);
        paperItemID = Number(summary?.paperItemID || 0);
      }
    }
    if (paperItemID > 0) {
      if (isClaudeConversationSystem()) {
        const paperStateKey = buildClaudePaperStateKey(
          pending.libraryID,
          paperItemID,
        );
        const rememberedConversationKey = Number(
          activeClaudePaperConversationByPaper.get(paperStateKey) || 0,
        );
        if (
          Number.isFinite(rememberedConversationKey) &&
          Math.floor(rememberedConversationKey) === conversationKey
        ) {
          activeClaudePaperConversationByPaper.delete(paperStateKey);
        }
        const persistedConversationKey = Number(
          getLastUsedClaudePaperConversationKey(
            pending.libraryID,
            paperItemID,
          ) || 0,
        );
        if (
          Number.isFinite(persistedConversationKey) &&
          Math.floor(persistedConversationKey) === conversationKey
        ) {
          removeLastUsedClaudePaperConversationKey(
            pending.libraryID,
            paperItemID,
          );
        }
      } else if (isCodexConversationSystem()) {
        const paperStateKey = buildCodexPaperStateKey(
          pending.libraryID,
          paperItemID,
        );
        const rememberedConversationKey = Number(
          activeCodexPaperConversationByPaper.get(paperStateKey) || 0,
        );
        if (
          Number.isFinite(rememberedConversationKey) &&
          Math.floor(rememberedConversationKey) === conversationKey
        ) {
          activeCodexPaperConversationByPaper.delete(paperStateKey);
        }
        const persistedConversationKey = Number(
          getLastUsedCodexPaperConversationKey(
            pending.libraryID,
            paperItemID,
          ) || 0,
        );
        if (
          Number.isFinite(persistedConversationKey) &&
          Math.floor(persistedConversationKey) === conversationKey
        ) {
          removeLastUsedCodexPaperConversationKey(
            pending.libraryID,
            paperItemID,
          );
        }
      } else {
        const paperStateKey = buildPaperStateKey(
          pending.libraryID,
          paperItemID,
        );
        const rememberedConversationKey = Number(
          activePaperConversationByPaper.get(paperStateKey) || 0,
        );
        if (
          Number.isFinite(rememberedConversationKey) &&
          Math.floor(rememberedConversationKey) === conversationKey
        ) {
          activePaperConversationByPaper.delete(paperStateKey);
        }
        const persistedConversationKey = Number(
          getLastUsedPaperConversationKey(pending.libraryID, paperItemID) || 0,
        );
        if (
          Number.isFinite(persistedConversationKey) &&
          Math.floor(persistedConversationKey) === conversationKey
        ) {
          removeLastUsedPaperConversationKey(pending.libraryID, paperItemID);
        }
      }
    }
    clearPendingDeletionCaches(conversationKey);
    let hasError = false;
    if (isClaudeConversationSystem()) {
      try {
        await invalidateClaudeConversationForDeletion(conversationKey, {
          libraryID: pending.libraryID,
          kind: "paper",
          paperItemID,
        });
      } catch (err) {
        hasError = true;
        ztoolkit.log(
          "LLM: Failed to invalidate deleted Claude paper conversation",
          err,
        );
      }
    }
    try {
      if (isClaudeConversationSystem()) {
        await clearClaudeConversation(conversationKey);
      } else if (isCodexConversationSystem()) {
        await clearCodexConversation(conversationKey);
      } else {
        await clearStoredConversation(conversationKey);
      }
    } catch (err) {
      hasError = true;
      ztoolkit.log("LLM: Failed to clear deleted paper conversation", err);
    }
    try {
      await clearOwnerAttachmentRefs("conversation", conversationKey);
    } catch (err) {
      hasError = true;
      ztoolkit.log("LLM: Failed to clear deleted paper attachment refs", err);
    }
    try {
      await removeConversationAttachmentFiles(conversationKey);
    } catch (err) {
      hasError = true;
      ztoolkit.log("LLM: Failed to remove deleted paper attachment files", err);
    }
    try {
      if (isClaudeConversationSystem()) {
        await deleteClaudeConversation(conversationKey);
      } else if (isCodexConversationSystem()) {
        await deleteCodexConversation(conversationKey);
      } else {
        await deletePaperConversation(conversationKey);
      }
    } catch (err) {
      hasError = true;
      ztoolkit.log(
        "LLM: Failed to delete paper conversation metadata row",
        err,
      );
    }
    scheduleAttachmentGc();
    if (hasError && status) {
      setStatus(
        status,
        t("Failed to fully delete conversation. Check logs."),
        "error",
      );
    }
  };

  const clearPendingTurnDeletion = (): PendingTurnDeletion | null => {
    if (!pendingTurnDeletion) return null;
    const pending = pendingTurnDeletion;
    clearWindowTimeout(pending.timeoutId);
    pending.timeoutId = null;
    pendingTurnDeletion = null;
    hideHistoryUndoToast();
    return pending;
  };

  const finalizePendingTurnDeletion = async (
    reason: "timeout" | "superseded",
  ): Promise<void> => {
    const pending = clearPendingTurnDeletion();
    if (!pending) return;
    let hasError = false;
    try {
      if (isClaudeConversationSystem()) {
        await deleteClaudeTurnMessages(
          pending.conversationKey,
          pending.userTimestamp,
          pending.assistantTimestamp,
        );
      } else if (isCodexConversationSystem()) {
        await deleteCodexTurnMessages(
          pending.conversationKey,
          pending.userTimestamp,
          pending.assistantTimestamp,
        );
      } else {
        await deleteTurnMessages(
          pending.conversationKey,
          pending.userTimestamp,
          pending.assistantTimestamp,
        );
      }
    } catch (err) {
      hasError = true;
      ztoolkit.log("LLM: Failed to delete turn messages", err);
    }
    try {
      const remainingHistory = chatHistory.get(pending.conversationKey) || [];
      await replaceOwnerAttachmentRefs(
        "conversation",
        pending.conversationKey,
        collectAttachmentHashesFromMessages(remainingHistory),
      );
    } catch (err) {
      hasError = true;
      ztoolkit.log("LLM: Failed to refresh turn attachment refs", err);
    }
    scheduleAttachmentGc();
    invalidateHistorySearchDocument(pending.conversationKey);
    if (hasError && status) {
      setStatus(status, t("Failed to fully delete turn. Check logs."), "error");
    } else if (reason === "timeout" && status) {
      setStatus(status, t("Turn deleted"), "ready");
    }
    void refreshGlobalHistoryHeader();
  };

  const undoPendingTurnDeletion = () => {
    const pending = clearPendingTurnDeletion();
    if (!pending) return;
    const history = chatHistory.get(pending.conversationKey) || [];
    const existingPair = findTurnPairByTimestamps(
      history,
      pending.userTimestamp,
      pending.assistantTimestamp,
    );
    if (!existingPair) {
      const insertAt = Math.max(0, Math.min(pending.userIndex, history.length));
      history.splice(
        insertAt,
        0,
        cloneTurnMessageForUndo(pending.userMessage),
        cloneTurnMessageForUndo(pending.assistantMessage),
      );
      chatHistory.set(pending.conversationKey, history);
    }
    invalidateHistorySearchDocument(pending.conversationKey);
    if (item && getConversationKey(item) === pending.conversationKey) {
      setActiveEditSession(null);
      refreshChatPreservingScroll();
    }
    if (status) setStatus(status, t("Turn restored"), "ready");
    void refreshGlobalHistoryHeader();
  };

  const queueTurnDeletion = async (target: {
    conversationKey: number;
    userTimestamp: number;
    assistantTimestamp: number;
  }) => {
    if (!item) return;
    if (isRequestPending(target.conversationKey)) {
      if (status) {
        setStatus(status, t("Cannot delete while generating"), "ready");
      }
      return;
    }
    const activeConversationKey = getConversationKey(item);
    if (activeConversationKey !== target.conversationKey) {
      if (status) setStatus(status, t("Delete target changed"), "error");
      return;
    }
    await ensureConversationLoaded(item as Zotero.Item);
    if (!item || getConversationKey(item) !== target.conversationKey) {
      if (status) setStatus(status, t("Delete target changed"), "error");
      return;
    }
    if (pendingHistoryDeletion) {
      await finalizePendingHistoryDeletion("superseded");
    }
    if (pendingTurnDeletion) {
      const sameTurn =
        pendingTurnDeletion.conversationKey === target.conversationKey &&
        pendingTurnDeletion.userTimestamp === target.userTimestamp &&
        pendingTurnDeletion.assistantTimestamp === target.assistantTimestamp;
      if (sameTurn) return;
      await finalizePendingTurnDeletion("superseded");
    }
    const history = chatHistory.get(target.conversationKey) || [];
    const pair = findTurnPairByTimestamps(
      history,
      target.userTimestamp,
      target.assistantTimestamp,
    );
    if (!pair) {
      if (status) setStatus(status, t("No deletable turn found"), "error");
      return;
    }

    history.splice(pair.userIndex, 2);
    chatHistory.set(target.conversationKey, history);
    invalidateHistorySearchDocument(target.conversationKey);
    setActiveEditSession(null);
    refreshChatPreservingScroll();

    const pending: PendingTurnDeletion = {
      conversationKey: target.conversationKey,
      userTimestamp: Math.floor(target.userTimestamp),
      assistantTimestamp: Math.floor(target.assistantTimestamp),
      userIndex: pair.userIndex,
      userMessage: cloneTurnMessageForUndo(pair.userMessage),
      assistantMessage: cloneTurnMessageForUndo(pair.assistantMessage),
      timeoutId: null,
      expiresAt: Date.now() + MESSAGE_TURN_UNDO_WINDOW_MS,
    };
    pending.timeoutId = getWindowTimeout(() => {
      void finalizePendingTurnDeletion("timeout");
    }, MESSAGE_TURN_UNDO_WINDOW_MS);
    pendingTurnDeletion = pending;
    showTurnUndoToast();
    if (status) setStatus(status, t("Turn deleted. Undo available."), "ready");
  };

  const clearPendingHistoryDeletion = (
    restoreRowVisibility: boolean,
  ): PendingHistoryDeletion | null => {
    if (!pendingHistoryDeletion) return null;
    const pending = pendingHistoryDeletion;
    clearWindowTimeout(pending.timeoutId);
    pending.timeoutId = null;
    if (restoreRowVisibility) {
      pendingHistoryDeletionKeys.delete(pending.conversationKey);
    }
    pendingHistoryDeletion = null;
    hideHistoryUndoToast();
    return pending;
  };

  const finalizePendingHistoryDeletion = async (
    reason: "timeout" | "superseded",
  ) => {
    const pending = clearPendingHistoryDeletion(false);
    if (!pending) return;
    ztoolkit.log("LLM: Finalizing pending history deletion", {
      reason,
      kind: pending.kind,
      conversationKey: pending.conversationKey,
      libraryID: pending.libraryID,
      title: pending.title,
    });
    const originalSystem = getConversationSystemPref();
    const targetSystem = pending.conversationSystem;
    if (originalSystem !== targetSystem) {
      setConversationSystemPref(targetSystem);
    }
    try {
      if (pending.kind === "global") {
        await finalizeGlobalConversationDeletion(pending);
      } else {
        await finalizePaperConversationDeletion(pending);
      }
    } finally {
      if (originalSystem !== targetSystem) {
        setConversationSystemPref(originalSystem);
      }
    }
    pendingHistoryDeletionKeys.delete(pending.conversationKey);
    await refreshGlobalHistoryHeader();
  };

  const undoPendingHistoryDeletion = async () => {
    const pending = clearPendingHistoryDeletion(true);
    if (!pending) return;
    ztoolkit.log("LLM: Restoring pending history deletion", {
      kind: pending.kind,
      conversationKey: pending.conversationKey,
      libraryID: pending.libraryID,
      title: pending.title,
    });
    invalidateHistorySearchDocument(pending.conversationKey);
    if (pending.wasActive) {
      await switchToHistoryTarget({
        kind: pending.kind,
        conversationKey: pending.conversationKey,
      });
      if (status) setStatus(status, t("Conversation restored"), "ready");
      return;
    }
    await refreshGlobalHistoryHeader();
    if (status) setStatus(status, t("Conversation restored"), "ready");
  };

  const findHistoryEntryByKey = (
    historyKind: "paper" | "global",
    conversationKey: number,
  ): ConversationHistoryEntry | null => {
    return (
      latestConversationHistory.find(
        (entry) =>
          entry.kind === historyKind &&
          entry.conversationKey === conversationKey,
      ) ||
      historySearchEntries.find(
        (entry) =>
          entry.kind === historyKind &&
          entry.conversationKey === conversationKey,
      ) ||
      null
    );
  };

  const getHistoryRowMenuEntry = (): ConversationHistoryEntry | null => {
    if (!historyRowMenuTarget) return null;
    return findHistoryEntryByKey(
      historyRowMenuTarget.kind,
      historyRowMenuTarget.conversationKey,
    );
  };

  const promptConversationRename = (
    entry: ConversationHistoryEntry,
  ): string | null => {
    const promptFn = panelWin?.prompt;
    if (typeof promptFn !== "function") {
      if (status) {
        setStatus(
          status,
          "Rename prompt is unavailable in this window",
          "error",
        );
      }
      return null;
    }
    const suggestedTitle = normalizeHistoryTitle(entry.title) || "";
    const raw = promptFn.call(panelWin, "Rename chat", suggestedTitle);
    if (raw === null) return null;
    const normalized = normalizeConversationTitleSeed(raw);
    if (!normalized) {
      if (status) setStatus(status, t("Chat title cannot be empty"), "error");
      return null;
    }
    return normalized;
  };

  const renameHistoryEntry = async (
    entry: ConversationHistoryEntry,
  ): Promise<void> => {
    if (isRequestPending(entry.conversationKey)) {
      if (status) {
        setStatus(
          status,
          t("History is unavailable while generating"),
          "ready",
        );
      }
      return;
    }
    const nextTitle = promptConversationRename(entry);
    if (!nextTitle) return;
    try {
      if (isClaudeConversationSystem()) {
        await setClaudeConversationTitle(entry.conversationKey, nextTitle);
      } else if (entry.kind === "paper") {
        await setPaperConversationTitle(entry.conversationKey, nextTitle);
      } else {
        await setGlobalConversationTitle(entry.conversationKey, nextTitle);
      }
      invalidateHistorySearchDocument(entry.conversationKey);
      await refreshGlobalHistoryHeader();
      if (status) setStatus(status, t("Conversation renamed"), "ready");
    } catch (err) {
      ztoolkit.log("LLM: Failed to rename conversation", err);
      if (status)
        setStatus(status, t("Failed to rename conversation"), "error");
    }
  };

  const queueHistoryDeletion = async (entry: ConversationHistoryEntry) => {
    if (!item) return;
    if (!entry.deletable) return;
    const libraryID = getCurrentLibraryID();
    if (!libraryID) {
      if (status)
        setStatus(status, t("No active library for deletion"), "error");
      return;
    }

    if (pendingHistoryDeletion) {
      if (pendingHistoryDeletion.conversationKey === entry.conversationKey) {
        return;
      }
      await finalizePendingHistoryDeletion("superseded");
    }
    if (pendingTurnDeletion) {
      await finalizePendingTurnDeletion("superseded");
    }

    const wasActive = isHistoryEntryActive(entry);
    let fallbackTarget: HistorySwitchTarget = null;
    if (wasActive) {
      if (entry.kind === "paper") {
        const paperItemID = Number(entry.paperItemID || 0);
        if (!paperItemID) {
          if (status) {
            setStatus(
              status,
              t("Cannot resolve active paper session"),
              "error",
            );
          }
          return;
        }
        fallbackTarget = await resolveFallbackAfterPaperDelete(
          libraryID,
          paperItemID,
          entry.conversationKey,
        );
      } else {
        fallbackTarget = await resolveFallbackAfterGlobalDelete(
          libraryID,
          entry.conversationKey,
        );
      }
      if (!fallbackTarget) {
        if (status) {
          setStatus(
            status,
            t("Cannot delete active conversation right now"),
            "error",
          );
        }
        return;
      }
      await switchToHistoryTarget(fallbackTarget);
      if (fallbackTarget.kind === "paper") {
        if (isClaudeConversationSystem()) {
          activeClaudeGlobalConversationByLibrary.delete(
            buildClaudeLibraryStateKey(libraryID),
          );
        } else {
          activeGlobalConversationByLibrary.delete(libraryID);
          const lockedKey = getLockedGlobalConversationKey(libraryID);
          if (
            Number.isFinite(lockedKey) &&
            lockedKey !== null &&
            Math.floor(lockedKey) === entry.conversationKey
          ) {
            setLockedGlobalConversationKey(libraryID, null);
          }
        }
      }
    }

    pendingHistoryDeletionKeys.add(entry.conversationKey);
    invalidateHistorySearchDocument(entry.conversationKey);
    const pending: PendingHistoryDeletion = {
      kind: entry.kind,
      conversationKey: entry.conversationKey,
      libraryID,
      conversationSystem: getConversationSystem(),
      paperItemID: entry.paperItemID,
      title: entry.title,
      wasActive,
      fallbackTarget,
      expiresAt: Date.now() + GLOBAL_HISTORY_UNDO_WINDOW_MS,
      timeoutId: null,
    };
    pending.timeoutId = getWindowTimeout(() => {
      void finalizePendingHistoryDeletion("timeout");
    }, GLOBAL_HISTORY_UNDO_WINDOW_MS);
    pendingHistoryDeletion = pending;

    ztoolkit.log("LLM: Queued history deletion", {
      kind: entry.kind,
      conversationKey: entry.conversationKey,
      libraryID,
      wasActive,
      fallbackTarget,
      expiresAt: pending.expiresAt,
    });
    showHistoryUndoToast(entry.title);
    await refreshGlobalHistoryHeader();
    if (status)
      setStatus(status, t("Conversation deleted. Undo available."), "ready");
  };

  const createAndSwitchGlobalConversation = async (forceFresh = false) => {
    if (!item || isNoteSession()) return;
    closeHistoryNewMenu();
    const libraryID = getCurrentLibraryID();
    if (!libraryID) {
      if (status) {
        setStatus(
          status,
          t("No active library for global conversation"),
          "error",
        );
      }
      return;
    }

    let targetConversationKey = 0;
    let reuseReason: "active-draft" | "latest-draft" | null = null;

    if (isClaudeConversationSystem()) {
      const currentCandidate = isGlobalMode()
        ? getConversationKey(item)
        : forceFresh
          ? 0
          : Number(
              activeClaudeGlobalConversationByLibrary.get(
                buildClaudeLibraryStateKey(libraryID),
              ) || 0,
            );
      const normalizedCurrentCandidate = Number.isFinite(currentCandidate)
        ? Math.floor(currentCandidate)
        : 0;
      if (!forceFresh && normalizedCurrentCandidate > 0) {
        try {
          const currentSummary = await getClaudeConversationSummary(
            normalizedCurrentCandidate,
          );
          if (currentSummary && (currentSummary.userTurnCount || 0) === 0) {
            targetConversationKey = normalizedCurrentCandidate;
            reuseReason = "active-draft";
          }
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to inspect active Claude candidate for draft reuse",
            err,
          );
        }
      }
      if (!forceFresh && targetConversationKey <= 0) {
        try {
          const summaries = await listClaudeGlobalConversations(
            libraryID,
            GLOBAL_HISTORY_LIMIT,
          );
          const latestEmpty = summaries.find(
            (summary) => (summary.userTurnCount || 0) === 0,
          );
          const latestEmptyKey = Number(latestEmpty?.conversationKey || 0);
          if (Number.isFinite(latestEmptyKey) && latestEmptyKey > 0) {
            targetConversationKey = Math.floor(latestEmptyKey);
            reuseReason = "latest-draft";
          }
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to load latest empty Claude global conversation",
            err,
          );
        }
      }
      if (targetConversationKey <= 0) {
        try {
          targetConversationKey = Number(
            (await createClaudeGlobalConversation(libraryID))
              ?.conversationKey || 0,
          );
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to create new Claude global conversation",
            err,
          );
        }
        reuseReason = null;
      }
      if (!targetConversationKey) {
        if (status)
          setStatus(status, t("Failed to create conversation"), "error");
        return;
      }
      activeClaudeGlobalConversationByLibrary.set(
        buildClaudeLibraryStateKey(libraryID),
        targetConversationKey,
      );
    } else if (isCodexConversationSystem()) {
      const currentCandidate = isGlobalMode()
        ? getConversationKey(item)
        : forceFresh
          ? 0
          : Number(
              activeCodexGlobalConversationByLibrary.get(
                buildCodexLibraryStateKey(libraryID),
              ) || 0,
            );
      const normalizedCurrentCandidate = Number.isFinite(currentCandidate)
        ? Math.floor(currentCandidate)
        : 0;
      if (!forceFresh && normalizedCurrentCandidate > 0) {
        try {
          if (await isCodexConversationDraft(normalizedCurrentCandidate)) {
            targetConversationKey = normalizedCurrentCandidate;
            reuseReason = "active-draft";
          }
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to inspect active Codex candidate for draft reuse",
            err,
          );
        }
      }
      if (!forceFresh && targetConversationKey <= 0) {
        try {
          const summaries = await listCodexGlobalConversations(
            libraryID,
            GLOBAL_HISTORY_LIMIT,
          );
          const latestEmpty = summaries.find(
            (summary) => (summary.userTurnCount || 0) === 0,
          );
          const latestEmptyKey = Number(latestEmpty?.conversationKey || 0);
          if (Number.isFinite(latestEmptyKey) && latestEmptyKey > 0) {
            targetConversationKey = Math.floor(latestEmptyKey);
            reuseReason = "latest-draft";
          }
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to load latest empty Codex global conversation",
            err,
          );
        }
      }
      if (targetConversationKey <= 0) {
        try {
          targetConversationKey = Number(
            (await createCodexGlobalConversation(libraryID))?.conversationKey ||
              0,
          );
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to create new Codex global conversation",
            err,
          );
        }
        reuseReason = null;
      }
      if (!targetConversationKey) {
        if (status)
          setStatus(status, t("Failed to create conversation"), "error");
        return;
      }
      activeCodexGlobalConversationByLibrary.set(
        buildCodexLibraryStateKey(libraryID),
        targetConversationKey,
      );
      setLastUsedCodexGlobalConversationKey(libraryID, targetConversationKey);
    } else {
      const currentCandidate =
        isGlobalMode() &&
        isUpstreamGlobalConversationKey(Number(getConversationKey(item) || 0))
          ? getConversationKey(item)
          : forceFresh
            ? 0
            : Number(activeGlobalConversationByLibrary.get(libraryID) || 0);
      const normalizedCurrentCandidate = Number.isFinite(currentCandidate)
        ? Math.floor(currentCandidate)
        : 0;
      if (!forceFresh && normalizedCurrentCandidate > 0) {
        try {
          const turnCount = await getGlobalConversationUserTurnCount(
            normalizedCurrentCandidate,
          );
          if (turnCount === 0) {
            targetConversationKey = normalizedCurrentCandidate;
            reuseReason = "active-draft";
          }
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to inspect active candidate for draft reuse",
            err,
          );
        }
      }

      if (!forceFresh && targetConversationKey <= 0) {
        try {
          const latestEmpty = await getLatestEmptyGlobalConversation(libraryID);
          const latestEmptyKey = Number(latestEmpty?.conversationKey || 0);
          if (Number.isFinite(latestEmptyKey) && latestEmptyKey > 0) {
            targetConversationKey = Math.floor(latestEmptyKey);
            reuseReason = "latest-draft";
          }
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to load latest empty global conversation",
            err,
          );
        }
      }

      if (targetConversationKey <= 0) {
        try {
          targetConversationKey = await createGlobalConversation(libraryID);
        } catch (err) {
          ztoolkit.log("LLM: Failed to create new global conversation", err);
        }
        reuseReason = null;
      }
      if (!targetConversationKey) {
        if (status)
          setStatus(status, t("Failed to create conversation"), "error");
        return;
      }
      activeGlobalConversationByLibrary.set(libraryID, targetConversationKey);
    }

    ztoolkit.log("LLM: + conversation action", {
      libraryID,
      targetConversationKey,
      action: reuseReason ? "reuse" : "create",
      reason: reuseReason || "new",
    });
    await switchGlobalConversation(targetConversationKey);
    if (status) {
      setStatus(
        status,
        reuseReason
          ? t("Reused existing new conversation")
          : t("Started new conversation"),
        "ready",
      );
    }
    inputBox.focus({ preventScroll: true });
  };

  const createAndSwitchPaperConversation = async (forceFresh = false) => {
    if (!item || isNoteSession()) return;
    closeHistoryNewMenu();
    const paperItem = resolveCurrentPaperBaseItem();
    if (!paperItem) {
      if (status) {
        setStatus(status, t("Open a paper to start a paper chat"), "error");
      }
      return;
    }
    setBasePaperItem(paperItem);
    const libraryID = getCurrentLibraryID();
    const paperItemID = Number(paperItem.id || 0);
    if (!libraryID || !Number.isFinite(paperItemID) || paperItemID <= 0) {
      if (status) {
        setStatus(status, t("No active paper for paper chat"), "error");
      }
      return;
    }

    let targetConversationKey = 0;
    let reuseReason: "active-draft" | "existing-draft" | null = null;

    if (isClaudeConversationSystem()) {
      const currentKey = Number(getConversationKey(item) || 0);
      if (!forceFresh && Number.isFinite(currentKey) && currentKey > 0) {
        try {
          const currentSummary = await getClaudeConversationSummary(currentKey);
          if (
            currentSummary &&
            currentSummary.kind === "paper" &&
            (currentSummary.userTurnCount || 0) === 0
          ) {
            targetConversationKey = currentKey;
            reuseReason = "active-draft";
          }
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to inspect active Claude paper conversation for draft reuse",
            err,
          );
        }
      }
      if (!forceFresh && targetConversationKey <= 0) {
        try {
          const summaries = await listClaudePaperConversations(
            libraryID,
            paperItemID,
            50,
          );
          const emptyEntry = summaries.find(
            (s) => (s.userTurnCount || 0) === 0,
          );
          if (emptyEntry?.conversationKey) {
            targetConversationKey = emptyEntry.conversationKey;
            reuseReason = "existing-draft";
          }
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to list Claude paper conversations for draft reuse",
            err,
          );
        }
      }
      if (targetConversationKey <= 0) {
        let createdSummary: Awaited<
          ReturnType<typeof createClaudePaperConversation>
        > = null;
        try {
          createdSummary = await createClaudePaperConversation(
            libraryID,
            paperItemID,
          );
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to create new Claude paper conversation",
            err,
          );
        }
        if (!createdSummary?.conversationKey) {
          if (status)
            setStatus(status, t("Failed to create paper chat"), "error");
          return;
        }
        targetConversationKey = createdSummary.conversationKey;
        reuseReason = null;
      }
    } else if (isCodexConversationSystem()) {
      const currentKey = Number(getConversationKey(item) || 0);
      if (!forceFresh && Number.isFinite(currentKey) && currentKey > 0) {
        try {
          const currentSummary = await getCodexConversationSummary(currentKey);
          if (
            currentSummary &&
            currentSummary.kind === "paper" &&
            (currentSummary.userTurnCount || 0) === 0
          ) {
            targetConversationKey = currentKey;
            reuseReason = "active-draft";
          }
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to inspect active Codex paper conversation for draft reuse",
            err,
          );
        }
      }
      if (!forceFresh && targetConversationKey <= 0) {
        try {
          const summaries = await listCodexPaperConversations(
            libraryID,
            paperItemID,
            50,
          );
          const emptyEntry = summaries.find(
            (s) => (s.userTurnCount || 0) === 0,
          );
          if (emptyEntry?.conversationKey) {
            targetConversationKey = emptyEntry.conversationKey;
            reuseReason = "existing-draft";
          }
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to list Codex paper conversations for draft reuse",
            err,
          );
        }
      }
      if (targetConversationKey <= 0) {
        let createdSummary: Awaited<
          ReturnType<typeof createCodexPaperConversation>
        > = null;
        try {
          createdSummary = await createCodexPaperConversation(
            libraryID,
            paperItemID,
          );
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to create new Codex paper conversation",
            err,
          );
        }
        if (!createdSummary?.conversationKey) {
          if (status)
            setStatus(status, t("Failed to create paper chat"), "error");
          return;
        }
        targetConversationKey = createdSummary.conversationKey;
        reuseReason = null;
      }
    } else {
      const currentKey = Number(getConversationKey(item) || 0);
      if (!forceFresh && Number.isFinite(currentKey) && currentKey > 0) {
        try {
          const currentSummary = await getPaperConversation(currentKey);
          if (currentSummary && currentSummary.userTurnCount === 0) {
            targetConversationKey = currentKey;
            reuseReason = "active-draft";
          }
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to inspect active paper conversation for draft reuse",
            err,
          );
        }
      }

      if (!forceFresh && targetConversationKey <= 0) {
        try {
          const summaries = await listPaperConversations(
            libraryID,
            paperItemID,
            50,
          );
          const emptyEntry = summaries.find((s) => s.userTurnCount === 0);
          if (emptyEntry?.conversationKey) {
            targetConversationKey = emptyEntry.conversationKey;
            reuseReason = "existing-draft";
          }
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to list paper conversations for draft reuse",
            err,
          );
        }
      }

      if (targetConversationKey <= 0) {
        let createdSummary: Awaited<
          ReturnType<typeof createPaperConversation>
        > = null;
        try {
          createdSummary = await createPaperConversation(
            libraryID,
            paperItemID,
          );
        } catch (err) {
          ztoolkit.log("LLM: Failed to create new paper conversation", err);
        }
        if (!createdSummary?.conversationKey) {
          if (status)
            setStatus(status, t("Failed to create paper chat"), "error");
          return;
        }
        targetConversationKey = createdSummary.conversationKey;
        reuseReason = null;
      }
    }

    ztoolkit.log("LLM: + paper conversation action", {
      libraryID,
      paperItemID,
      targetConversationKey,
      action: reuseReason ? "reuse" : "create",
      reason: reuseReason || "new",
    });

    await switchPaperConversation(targetConversationKey);
    if (status) {
      setStatus(
        status,
        reuseReason
          ? t("Reused existing new chat")
          : t("Started new paper chat"),
        "ready",
      );
    }
    inputBox.focus({ preventScroll: true });
  };

  const runExplicitNewChatAction = async (action: () => Promise<void>) => {
    if (explicitNewChatInFlight) return;
    explicitNewChatInFlight = true;
    try {
      await action();
    } finally {
      explicitNewChatInFlight = false;
    }
  };

  const openHistoryRowMenuAtPointer = (
    entry: ConversationHistoryEntry,
    clientX: number,
    clientY: number,
  ) => {
    if (!historyRowMenu || !historyRowRenameBtn) return;
    historyRowMenuTarget = {
      kind: entry.kind,
      conversationKey: entry.conversationKey,
    };
    const renameDisabled = entry.isPendingDelete;
    historyRowRenameBtn.disabled = renameDisabled;
    historyRowRenameBtn.setAttribute(
      "aria-disabled",
      renameDisabled ? "true" : "false",
    );
    positionMenuAtPointer(body, historyRowMenu, clientX, clientY);
    historyRowMenu.style.display = "grid";
  };

  if (historyNewBtn) {
    historyNewBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item || isNoteSession()) return;
      // Allow creating new conversations even if another is generating.
      closeModelMenu();
      closeReasoningMenu();
      closeRetryModelMenu();
      closeSlashMenu();
      closeResponseMenu();
      closePromptMenu();
      closeExportMenu();
      closeHistoryMenu();

      // [webchat] In webchat mode, "+" creates a new ChatGPT conversation
      const { selectedEntry: _debugEntry } = getSelectedModelInfo();
      ztoolkit.log(
        `[webchat] + clicked: authMode=${_debugEntry?.authMode}, entryId=${_debugEntry?.entryId}, isWebChat=${_debugEntry?.authMode === "webchat"}`,
      );
      if (isWebChatMode()) {
        // Clear local chat panel and mark the relay as needing a new chat.
        // The next send carries an explicit force_new_chat intent to the relay,
        // and we also trigger a remote new-chat command immediately.
        markNextWebChatSendAsNewChat();
        primeFreshWebChatPaperChipState();
        // Clear cached images so stale screenshots don't auto-attach to ChatGPT
        if (item) {
          selectedImageCache.delete(item.id);
          updateImagePreviewPreservingScroll();
        }
        void (async () => {
          try {
            const [{ getRelayBaseUrl }, { sendNewChat }] = await Promise.all([
              import("../../../../webchat/relayServer"),
              import("../../../../webchat/client"),
            ]);
            await sendNewChat(getRelayBaseUrl());
          } catch (err) {
            ztoolkit.log("[webchat] Failed to trigger immediate new chat", err);
          }
        })();
        const key = getConversationKey(item);
        chatHistory.set(key, []);
        refreshChatPreservingScroll();
        if (status)
          setStatus(status, t("New chat — send a message to start"), "ready");
        return;
      }

      // Create a truly fresh session in whichever mode is currently active.
      void runExplicitNewChatAction(async () => {
        if (isGlobalMode()) {
          await createAndSwitchGlobalConversation(true);
        } else {
          await createAndSwitchPaperConversation(true);
        }
      });
    });
  }

  if (historyNewOpenBtn) {
    historyNewOpenBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (isNoteSession()) return;
      closeHistoryNewMenu();
      void runExplicitNewChatAction(() =>
        createAndSwitchGlobalConversation(true),
      );
    });
  }

  if (historyNewPaperBtn) {
    historyNewPaperBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (isNoteSession()) return;
      if (historyNewPaperBtn.disabled) return;
      closeHistoryNewMenu();
      void runExplicitNewChatAction(() =>
        createAndSwitchPaperConversation(true),
      );
    });
  }

  if (historyUndoBtn) {
    historyUndoBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (pendingTurnDeletion) {
        undoPendingTurnDeletion();
        return;
      }
      void undoPendingHistoryDeletion();
    });
  }

  // --- Mode chip handler ---
  if (modeChipBtn) {
    modeChipBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item || isNoteSession()) return;
      if (isGlobalMode()) {
        void switchPaperConversation();
        return;
      }
      const libraryID = getCurrentLibraryID();
      const targetGlobalKey = isClaudeConversationSystem()
        ? resolveRememberedClaudeConversationKey({
            libraryID,
            kind: "global",
          }) ||
          getLastUsedClaudeGlobalConversationKey(libraryID) ||
          0
        : isCodexConversationSystem()
          ? activeCodexGlobalConversationByLibrary.get(
              buildCodexLibraryStateKey(libraryID),
            ) ||
            getLastUsedCodexGlobalConversationKey(libraryID) ||
            0
          : (() => {
              const lockedKey = getLockedGlobalConversationKey(libraryID);
              if (lockedKey !== null) return lockedKey;
              const activeKey = Number(
                activeGlobalConversationByLibrary.get(libraryID) || 0,
              );
              return isUpstreamGlobalConversationKey(activeKey)
                ? Math.floor(activeKey)
                : 0;
            })();
      if (targetGlobalKey > 0) {
        void switchGlobalConversation(targetGlobalKey);
      } else {
        void createAndSwitchGlobalConversation();
      }
    });
  }

  if (claudeSystemToggleBtn) {
    claudeSystemToggleBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      const nextSystem = isRuntimeConversationSystem()
        ? "upstream"
        : getPreferredTargetSystem();
      void switchConversationSystem(nextSystem, { forceFresh: true });
    });
  }

  if (historyToggleBtn) {
    historyToggleBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item || isNoteSession()) return;
      // Allow history navigation even during generation.
      void (async () => {
        closeModelMenu();
        closeReasoningMenu();
        closeRetryModelMenu();
        closeSlashMenu();
        closeResponseMenu();
        closePromptMenu();
        closeExportMenu();
        closeHistoryNewMenu();

        // [webchat] Show ChatGPT conversation history
        if (isWebChatMode()) {
          if (isHistoryMenuOpen()) {
            closeHistoryMenu();
            return;
          }
          if (!historyMenu) return;
          await renderWebChatHistoryMenu();
          positionMenuBelowButton(body, historyMenu, historyToggleBtn);
          historyMenu.style.display = "flex";
          historyToggleBtn.setAttribute("aria-expanded", "true");
          return;
        }

        await refreshGlobalHistoryHeader();
        if (!latestConversationHistory.length) {
          closeHistoryMenu();
          return;
        }
        if (isHistoryMenuOpen()) {
          closeHistoryMenu();
          return;
        }
        if (!historyMenu) return;
        renderGlobalHistoryMenu();
        positionMenuBelowButton(body, historyMenu, historyToggleBtn);
        historyMenu.style.display = "flex";
        historyToggleBtn.setAttribute("aria-expanded", "true");
      })();
    });
  }

  if (historyMenu) {
    historyMenu.addEventListener("input", (e: Event) => {
      const target = e.target as HTMLInputElement | null;
      if (
        !target ||
        !target.classList.contains("llm-history-menu-search-input")
      )
        return;
      historySearchQuery = target.value || "";
      void refreshHistorySearchMenu();
    });
    historyMenu.addEventListener("keydown", (e: Event) => {
      const keyboardEvent = e as KeyboardEvent;
      const target = e.target as HTMLInputElement | null;
      if (
        !target ||
        !target.classList.contains("llm-history-menu-search-input") ||
        keyboardEvent.key !== "Escape"
      ) {
        return;
      }
      keyboardEvent.preventDefault();
      keyboardEvent.stopPropagation();
      collapseHistorySearch();
    });

    historyMenu.addEventListener("click", (e: Event) => {
      const target = e.target as Element | null;
      if (!target || !item) return;
      // Allow switching conversations even during generation.
      closeHistoryRowMenu();

      const searchTrigger = target.closest(
        ".llm-history-menu-search-trigger",
      ) as HTMLButtonElement | null;
      if (searchTrigger) {
        e.preventDefault();
        e.stopPropagation();
        expandHistorySearch();
        return;
      }

      // Delete button inside a history item
      const deleteBtn = target.closest(
        ".llm-history-item-delete",
      ) as HTMLElement | null;
      if (deleteBtn) {
        const row = deleteBtn.closest(
          ".llm-history-item",
        ) as HTMLButtonElement | null;
        if (!row) return;
        e.preventDefault();
        e.stopPropagation();
        const parsedConversationKey = Number.parseInt(
          row.dataset.conversationKey || "",
          10,
        );
        if (
          !Number.isFinite(parsedConversationKey) ||
          parsedConversationKey <= 0
        ) {
          return;
        }
        const historyKind =
          row.dataset.historyKind === "paper" ? "paper" : "global";
        const entry = findHistoryEntryByKey(historyKind, parsedConversationKey);
        if (!entry || !entry.deletable) return;
        void queueHistoryDeletion(entry);
        return;
      }

      // Click on a history item to switch conversation
      const row = target.closest(
        ".llm-history-item",
      ) as HTMLButtonElement | null;
      if (!row) return;
      e.preventDefault();
      e.stopPropagation();
      const parsedConversationKey = Number.parseInt(
        row.dataset.conversationKey || "",
        10,
      );
      if (
        !Number.isFinite(parsedConversationKey) ||
        parsedConversationKey <= 0
      ) {
        return;
      }
      const historyKind =
        row.dataset.historyKind === "paper" ? "paper" : "global";
      const entry = findHistoryEntryByKey(historyKind, parsedConversationKey);
      void (async () => {
        if (entry) {
          await switchToHistoryEntry(entry);
        } else if (historyKind === "paper") {
          await switchPaperConversation(parsedConversationKey);
        } else {
          await switchGlobalConversation(parsedConversationKey);
        }
        if (status) setStatus(status, t("Conversation loaded"), "ready");
      })();
    });

    historyMenu.addEventListener("contextmenu", (e: Event) => {
      const target = e.target as Element | null;
      if (!target || !item) return;
      // Allow context menu even during generation.
      const row = target.closest(
        ".llm-history-item",
      ) as HTMLButtonElement | null;
      if (!row) {
        closeHistoryRowMenu();
        return;
      }
      const parsedConversationKey = Number.parseInt(
        row.dataset.conversationKey || "",
        10,
      );
      if (
        !Number.isFinite(parsedConversationKey) ||
        parsedConversationKey <= 0
      ) {
        closeHistoryRowMenu();
        return;
      }
      const historyKind =
        row.dataset.historyKind === "paper" ? "paper" : "global";
      const entry = findHistoryEntryByKey(historyKind, parsedConversationKey);
      if (!entry) {
        closeHistoryRowMenu();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      closeHistoryNewMenu();
      closeModelMenu();
      closeReasoningMenu();
      closeRetryModelMenu();
      closeSlashMenu();
      closeResponseMenu();
      closePromptMenu();
      closeExportMenu();
      const mouse = e as MouseEvent;
      let { clientX, clientY } = mouse;
      if (
        !Number.isFinite(clientX) ||
        !Number.isFinite(clientY) ||
        (clientX === 0 && clientY === 0)
      ) {
        const rect = row.getBoundingClientRect();
        clientX = rect.left + Math.min(18, rect.width / 2);
        clientY = rect.top + Math.min(18, rect.height / 2);
      }
      openHistoryRowMenuAtPointer(entry, clientX, clientY);
    });
  }

  if (historyRowRenameBtn) {
    historyRowRenameBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const entry = getHistoryRowMenuEntry();
      closeHistoryRowMenu();
      if (!entry) return;
      void renameHistoryEntry(entry);
    });
  }

  return {
    refreshGlobalHistoryHeader: async () => {
      syncStateFromDeps();
      return refreshGlobalHistoryHeader();
    },
    switchGlobalConversation: async (nextConversationKey: number) => {
      syncStateFromDeps();
      return switchGlobalConversation(nextConversationKey);
    },
    switchPaperConversation: async (nextConversationKey?: number) => {
      syncStateFromDeps();
      return switchPaperConversation(nextConversationKey);
    },
    switchToHistoryTarget: async (target: HistorySwitchTarget) => {
      syncStateFromDeps();
      return switchToHistoryTarget(target);
    },
    createAndSwitchGlobalConversation: async (forceFresh = false) => {
      syncStateFromDeps();
      return createAndSwitchGlobalConversation(forceFresh);
    },
    createAndSwitchPaperConversation: async (forceFresh = false) => {
      syncStateFromDeps();
      return createAndSwitchPaperConversation(forceFresh);
    },
    runExplicitNewChatAction,
    queueTurnDeletion,
    clearPendingTurnDeletion,
    resetHistorySearchState,
    hasPendingTurnDeletionForConversation: (conversationKey: number) =>
      pendingTurnDeletion?.conversationKey === conversationKey,
  };
}

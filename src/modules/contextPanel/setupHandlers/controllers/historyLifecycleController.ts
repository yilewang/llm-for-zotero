import { createElement } from "../../../../utils/domHelpers";
import { t } from "../../../../utils/i18n";
import type { ConversationSystem } from "../../../../shared/types";
import {
  loadTruncatedConversationIndexMatches,
  searchConversationIndexWithStatus,
  type ConversationSearchIndexMatch,
  type ConversationSearchIndexResult,
} from "../../../../shared/conversationSearchIndex";
import {
  conversationRepository,
  type ConversationCatalogEntry,
} from "../../../../core/conversations/repository";
import { resolveFreshConversationDraft } from "../../freshConversationDraft";
import { resolveWebChatSessionConversation } from "../../webchatSessionConversation";
import {
  evaluateConversationForkEligibility,
  type ConversationForkEligibilityReason,
} from "../../../../core/conversations/forkEligibility";
import {
  buildDefaultUpstreamGlobalConversationKey,
  GLOBAL_CONVERSATION_KEY_BASE,
  MAX_SELECTED_PAPER_CONTEXTS,
  GLOBAL_HISTORY_LIMIT,
  PERSISTED_HISTORY_LIMIT,
  isUpstreamGlobalConversationKey,
} from "../../constants";
import type { Message } from "../../types";
import {
  chatHistory,
  conversationForkLinks,
  loadedConversationKeys,
  webChatIsolatedConversationKeys,
  activeConversationModeByLibrary,
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
  draftInputCache,
  inlineEditCleanup,
  setInlineEditCleanup,
  setInlineEditTarget,
  setInlineEditInputSection,
  setInlineEditSavedDraft,
  setForkSourceNavigationRunner,
  isRequestPending,
} from "../../state";
import type { ConversationForkLink } from "../../../../shared/conversationForkLinks";
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
  rememberClaudeConversationSelection,
  resolveRememberedClaudeConversationKey,
  touchClaudeConversation,
} from "../../../../claudeCode/runtime";
import {
  getConversationSystemPref,
  getLastUsedClaudeGlobalConversationKey,
  setConversationSystemPref,
  setLastUsedClaudeGlobalConversationKey,
} from "../../../../claudeCode/prefs";
import {
  activeClaudeGlobalConversationByLibrary,
  buildClaudeLibraryStateKey,
} from "../../../../claudeCode/state";
import {
  createClaudeGlobalPortalItem,
  createClaudePaperPortalItem,
} from "../../../../claudeCode/portal";
import {
  getLastUsedCodexGlobalConversationKey,
  getLastUsedCodexPaperConversationKey,
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
  createGlobalPortalItem,
  createPaperPortalItem,
  resolveConversationBaseItem,
  resolveDisplayConversationKind,
  resolveShortcutMode,
} from "../../portalScope";
import { replaceOwnerAttachmentRefs } from "../../../../utils/attachmentRefStore";
import {
  collectAttachmentHashesFromMessages,
  filterMessagesInPendingTurns,
  findTurnPairByTimestamps,
} from "../../turnMessageUtils";
import {
  getLastUsedUpstreamGlobalConversationKey,
  getLastUsedPaperConversationKey,
  getLockedGlobalConversationKey,
  setLastUsedUpstreamGlobalConversationKey,
  setLastUsedPaperConversationKey,
  setLockedGlobalConversationKey,
  buildPaperStateKey,
} from "../../prefHelpers";
import type { AgentRuntime } from "../../../../agent/runtime";
import { clearActiveConversationForPendingDeletion } from "../../conversationDeletionActivation";
import {
  createSerializedConversationDeletionEventQueue,
  resolveConversationDeletionSurfaceAction,
  type ConversationDeletionSurfaceSnapshot,
} from "../../conversationDeletionSurfaceSync";
import {
  forgetRecentlyDeletedConversation,
  hasConversationDeletionTombstoneForKey,
  isConversationInstanceRecentlyDeleted,
  markConversationInstanceRecentlyDeleted,
} from "../../../../core/conversations/recentlyDeletedConversations";
import {
  pendingDeletionStore,
  type PendingConversationDeletionEntry,
  type PendingDeletionEvent,
} from "../../../../core/conversations/pendingDeletionStore";
import { getConversationWriteGeneration } from "../../../../shared/conversationWriteFence";
import { getRegisteredConversationScope } from "../../../../shared/conversationRegistry";
import {
  formatGlobalHistoryTimestamp,
  formatHistoryRowDisplayTitle,
  formatHistoryPaperScopeLabel,
  getHistoryEntryLabelType,
  groupHistoryEntriesByDay,
  isOrphanHistoryEntry,
  maybeSelectPaperHistoryTarget,
  normalizeHistoryPaperItemID,
  normalizeConversationTitleSeed,
  normalizeHistoryTitle,
  resolveHistoryEntryPaperBaseItem,
  resolveHistoryEntryPaperDisplayMetadata,
  resolveHistoryEntrySourceState,
  resolvePaperHistoryNavigationDecision,
  type ConversationHistoryEntry,
  type HistoryPaperPaneSelector,
  type HistorySwitchTarget,
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
import { createHistorySearchPopupController } from "./historySearchPopupController";
import { collapseDuplicateReusableConversationDrafts } from "../../standaloneConversationResolution";
import { showConversationRenameDialog } from "../../conversationRenameDialog";
import {
  canCommitConversationRename,
  isConversationRenameEligible,
  type ConversationRenameIdentity,
} from "../../conversationRenameEligibility";
import { primeHistoryNavigationMode } from "../../historyNavigationModeSync";

type HistorySearchIndexFallbackStatus = Pick<
  ConversationSearchIndexResult,
  "catalogRowCount" | "matches" | "status"
>;

export function shouldFallbackToLoadedConversationHistorySearch(
  indexed: HistorySearchIndexFallbackStatus,
): boolean {
  if (indexed.status === "unavailable" || indexed.status === "stale") {
    return true;
  }
  return (
    indexed.matches.length === 0 &&
    indexed.catalogRowCount > 0 &&
    indexed.status !== "ready"
  );
}

type StatusLevel = "ready" | "warning" | "error";

const pendingDeletionSubscriptionsByBody = new WeakMap<Element, () => void>();

// Conversations a surface gave up because a deletion was queued, keyed by
// pending-deletion entry id. Kept on the body (not the controller) so a panel
// rebuild inside the same window still knows where to put the user back.
const surrenderedDeletionTargetsByBody = new WeakMap<
  Element,
  Map<string, HistorySwitchTarget>
>();

export function disposePendingDeletionSubscriptionForBody(body: Element): void {
  const unsubscribe = pendingDeletionSubscriptionsByBody.get(body);
  if (unsubscribe) {
    unsubscribe();
    pendingDeletionSubscriptionsByBody.delete(body);
  }
}

type CachedHistorySearchDocument = {
  fingerprint: string;
  document: HistorySearchDocument;
};
type PendingHistorySearchDocumentTask = {
  fingerprint: string;
  task: Promise<HistorySearchDocument>;
};
type CreateConversationOptions = {
  forceFresh?: boolean;
  excludeConversationKey?: number;
};
type ForkTurnTarget = {
  item: Zotero.Item;
  conversationKey: number;
  userTimestamp: number;
  assistantTimestamp: number;
  userMessageID?: number;
  assistantMessageID?: number;
};

export { clearDeletedAgentConversationState } from "../../agentConversationCleanup";

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
  topToast: HTMLElement | null;
  modeChipBtn: HTMLButtonElement | null;
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
  refreshAutoLoadedPaperContextForCurrentItem: () => void;
  persistDraftInputForCurrentConversation: () => void;
  restoreDraftInputForCurrentConversation: () => void;
  syncConversationIdentity: () => void;
  syncQueuedFollowUpRegistration: () => void;
  updateRuntimeModeButton: () => void;
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
  switchConversationSystem: (
    nextSystem: ConversationSystem,
    options?: { forceFresh?: boolean },
  ) => Promise<void>;
  runExplicitNewChatAction?: (action: () => Promise<void>) => Promise<void>;
  setActiveEditSession: (value: any) => void;
  getCoreAgentRuntime: () => AgentRuntime | Promise<AgentRuntime>;
  clearPendingRequestForConversation?: (conversationKey: number) => void;
  clearAgentToolCaches?: (conversationKey: number) => void;
  clearAgentConversationState?: (conversationKey: number) => Promise<void>;
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
  const getForkEligibilityStatusMessage = (
    reason?: ConversationForkEligibilityReason,
  ): string => {
    switch (reason) {
      case "pending_response":
        return t("Wait for the current response to finish before forking");
      case "claude_code":
        return t("Fork is not supported for Claude Code conversations");
      case "codex_older_turn":
        return t("Codex fork is only supported for the latest response");
      case "missing_provider_session":
        return t(
          "Cannot fork this Codex conversation because it has no native thread",
        );
      case "webchat":
      case "compact_marker":
      case "unsupported_system":
        return t("Fork is not supported for this conversation type yet");
      case "invalid_turn":
      default:
        return t("No forkable turn found");
    }
  };
  const getForkEligibilityStatusLevel = (
    reason?: ConversationForkEligibilityReason,
  ): StatusLevel => {
    return reason === "invalid_turn" || reason === "missing_provider_session"
      ? "error"
      : "warning";
  };
  const normalizeCreateConversationOptions = (
    options: boolean | CreateConversationOptions | undefined,
  ): Required<CreateConversationOptions> => {
    if (typeof options === "boolean") {
      return { forceFresh: options, excludeConversationKey: 0 };
    }
    return {
      forceFresh: Boolean(options?.forceFresh),
      excludeConversationKey:
        Number.isFinite(options?.excludeConversationKey) &&
        Number(options?.excludeConversationKey) > 0
          ? Math.floor(Number(options?.excludeConversationKey))
          : 0,
    };
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
    topToast,
    modeChipBtn,
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
  const refreshAutoLoadedPaperContextForCurrentItem =
    deps.refreshAutoLoadedPaperContextForCurrentItem;
  const persistDraftInputForCurrentConversation =
    deps.persistDraftInputForCurrentConversation;
  const restoreDraftInputForCurrentConversation =
    deps.restoreDraftInputForCurrentConversation;
  const syncConversationIdentity = deps.syncConversationIdentity;
  const syncQueuedFollowUpRegistration = deps.syncQueuedFollowUpRegistration;
  const updateRuntimeModeButton = deps.updateRuntimeModeButton;
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
    cancelHistorySearchDebounce();
    historySearchLoadSeq += 1;
    historySearchQuery = "";
    historySearchExpanded = false;
    historySearchLoading = false;
    historySearchEntries = [];
    historySearchResultsByKey = new Map();
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
  const setActiveEditSession = deps.setActiveEditSession;
  const ztoolkit = { log: deps.log };
  const ensureConversationCatalogEntry = async (params: {
    system: ConversationSystem;
    conversationKey: number;
    libraryID: number;
    kind: "global" | "paper";
    paperItemID?: number;
    title?: string;
  }) => {
    return conversationRepository.ensureCatalogEntry({
      system: params.system,
      conversationKey: params.conversationKey,
      libraryID: params.libraryID,
      kind: params.kind,
      paperItemID: params.paperItemID,
      title: params.title || "",
    });
  };
  // Ambient "keep the mounted conversation listed" seeding. A conversation
  // queued for deletion — or one whose deletion just committed — must never be
  // seeded back: for a global portal item item.id IS the conversation key, so
  // any second panel still mounted on the doomed key would INSERT OR IGNORE a
  // bare row and the chat would reappear as an empty "New chat". Deliberate
  // navigation uses ensureConversationCatalogEntry and lifts the tombstone.
  const ensureActiveConversationCatalogEntry = async (params: {
    system: ConversationSystem;
    conversationKey: number;
    libraryID: number;
    kind: "global" | "paper";
    paperItemID?: number;
  }) => {
    if (
      pendingDeletionStore.isConversationPendingDeletion(params.conversationKey)
    ) {
      return null;
    }
    const identityWitness =
      await conversationRepository.getCatalogIdentityWitness(params);
    if (
      identityWitness?.instanceID &&
      isConversationInstanceRecentlyDeleted(
        params.conversationKey,
        identityWitness.instanceID,
      )
    ) {
      return null;
    }
    if (
      !identityWitness &&
      (await hasConversationDeletionTombstoneForKey(params.conversationKey))
    ) {
      return null;
    }
    return ensureConversationCatalogEntry(params);
  };
  const touchEmptyDraftActivity = async (
    conversationKey: number,
    kind: "global" | "paper",
  ): Promise<void> => {
    const normalizedKey = Number.isFinite(conversationKey)
      ? Math.floor(conversationKey)
      : 0;
    if (normalizedKey <= 0) return;
    const now = Date.now();
    await conversationRepository.touchEmptyCatalogActivity({
      system: getConversationSystem(),
      conversationKey: normalizedKey,
      kind,
      timestamp: now,
    });
  };
  let latestConversationHistory: ConversationHistoryEntry[] = [];
  let explicitNewChatInFlight = false;

  let historySearchQuery = "";
  let historySearchDebounceTimer: number | null = null;
  let historySearchExpanded = false;
  let historySearchLoading = false;
  let historySearchEntries: ConversationHistoryEntry[] = [];
  let historySearchResultsByKey = new Map<number, HistorySearchResult>();
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
  const TOP_TOAST_TIMEOUT_MS = 2600;
  let topToastTimer: number | null = null;

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

  const showHistoryUndoToast = () => {
    if (!historyUndo || !historyUndoText) return;
    historyUndoText.textContent = `Conversation deleted — Undo`;
    historyUndo.style.display = "flex";
  };

  const showTurnUndoToast = () => {
    if (!historyUndo || !historyUndoText) return;
    historyUndoText.textContent = t("Deleted one turn");
    historyUndo.style.display = "flex";
  };

  const showTopToast = (message: string): void => {
    if (!topToast) return;
    clearWindowTimeout(topToastTimer);
    topToastTimer = null;
    topToast.textContent = message;
    topToast.style.display = "flex";
    topToast.setAttribute("aria-hidden", "false");
    const win = body.ownerDocument?.defaultView;
    const reveal = () => topToast.classList.add("llm-top-toast-visible");
    if (win?.requestAnimationFrame) {
      win.requestAnimationFrame(reveal);
    } else {
      reveal();
    }
    topToastTimer = getWindowTimeout(() => {
      topToast.classList.remove("llm-top-toast-visible");
      topToast.setAttribute("aria-hidden", "true");
      topToast.style.display = "none";
      topToastTimer = null;
    }, TOP_TOAST_TIMEOUT_MS);
  };

  const isHistoryEntryActive = (
    entry: ConversationHistoryEntry,
    conversationSystem: ConversationSystem = getConversationSystem(),
  ): boolean => {
    if (!item) return false;
    if (getConversationSystem() !== conversationSystem) return false;
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
    const metadata = resolveHistoryEntryPaperDisplayMetadata(
      { paperItemID },
      (id) => Zotero.Items.get(id) as Zotero.Item | null,
    );
    return metadata?.title || "Paper chat";
  };

  const resolveHistoryScopeLabel = (
    entry: ConversationHistoryEntry,
  ): string => {
    if (isOrphanHistoryEntry(entry)) return t("Orphan");
    return entry.kind === "paper"
      ? resolveHistoryPaperLabel(entry.paperItemID)
      : t("Library chat");
  };

  const resolveHistoryScopeChipLabel = (
    entry: ConversationHistoryEntry,
  ): string => {
    if (isOrphanHistoryEntry(entry)) return t("Orphan");
    if (entry.kind !== "paper") return t("Library chat");
    return formatHistoryPaperScopeLabel(
      resolveHistoryEntryPaperDisplayMetadata(
        entry,
        (id) => Zotero.Items.get(id) as Zotero.Item | null,
      ),
      t("Paper chat"),
    );
  };

  const createHistorySearchEntry = (params: {
    kind: "paper" | "global";
    conversationID?: string;
    conversationKey: number;
    title?: string;
    createdAt?: number;
    lastActivityAt: number;
    isDraft?: boolean;
    userTurnCount?: number;
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
    const sourceState = resolveHistoryEntrySourceState(
      { kind: params.kind, paperItemID },
      (id) => Zotero.Items.get(id) as Zotero.Item | null,
    );
    return {
      kind: params.kind,
      sourceState,
      section: params.kind === "paper" ? "paper" : "open",
      sectionTitle:
        params.kind === "paper"
          ? sourceState === "orphan"
            ? "Orphan"
            : resolveHistoryPaperLabel(paperItemID)
          : "Library chat",
      conversationID: params.conversationID,
      conversationKey: Math.floor(conversationKey),
      title:
        normalizeHistoryTitle(params.title) ||
        (isDraft ? "New chat" : "Untitled chat"),
      timestampText: isDraft
        ? "Draft"
        : formatGlobalHistoryTimestamp(normalizedLastActivity) ||
          (params.kind === "paper"
            ? sourceState === "orphan"
              ? "Orphan"
              : "Paper chat"
            : "Library chat"),
      deletable: true,
      isDraft,
      isPendingDelete: pendingDeletionStore.isConversationPendingDeletion(
        Math.floor(conversationKey),
      ),
      lastActivityAt: normalizedLastActivity,
      userTurnCount:
        Number.isFinite(Number(params.userTurnCount)) &&
        Number(params.userTurnCount) >= 0
          ? Math.floor(Number(params.userTurnCount))
          : undefined,
      paperItemID,
      catalogPaperItemID: paperItemID,
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
    options: { limit?: number | null } = {},
  ): Promise<ConversationHistoryEntry[]> => {
    const normalizedLibraryID =
      Number.isFinite(libraryID) && libraryID > 0 ? Math.floor(libraryID) : 0;
    if (!normalizedLibraryID) return [];
    const searchLimit =
      options.limit === null
        ? null
        : (options.limit ?? Math.max(GLOBAL_HISTORY_LIMIT, 100));
    const entries: ConversationHistoryEntry[] = [];

    if (isClaudeConversationSystem()) {
      const summaries = await loadAllClaudeConversationHistory({
        libraryID: normalizedLibraryID,
        limit: searchLimit,
      });
      for (const summary of summaries) {
        const entry = createHistorySearchEntry({
          kind: summary.kind === "paper" ? "paper" : "global",
          conversationID: summary.conversationID,
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
          conversationID: summary.conversationID,
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
          conversationID: summary.conversationID,
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

  const runHistorySearchDocumentLoads = async (
    entries: ConversationHistoryEntry[],
    documents: Map<number, HistorySearchDocument>,
  ): Promise<void> => {
    const concurrency = 8;
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, entries.length) },
      async () => {
        for (;;) {
          const index = nextIndex;
          nextIndex += 1;
          const entry = entries[index];
          if (!entry) return;
          documents.set(
            entry.conversationKey,
            await ensureHistorySearchDocument(entry),
          );
        }
      },
    );
    await Promise.all(workers);
  };

  const createHistorySearchEntryFromIndexMatch = (
    match: ConversationSearchIndexMatch,
  ): ConversationHistoryEntry | null => {
    return createHistorySearchEntry({
      kind: match.kind,
      conversationID: match.conversationID,
      conversationKey: match.conversationKey,
      title: match.title,
      createdAt: match.lastActivityAt,
      lastActivityAt: match.lastActivityAt,
      isDraft: match.userTurnCount <= 0,
      userTurnCount: match.userTurnCount,
      paperItemID: match.paperItemID,
    });
  };

  const cacheHistorySearchDocument = (
    entry: ConversationHistoryEntry,
    document: HistorySearchDocument,
  ): void => {
    const fingerprint = getHistorySearchDocumentFingerprint(entry);
    historySearchDocumentCache.set(entry.conversationKey, {
      fingerprint,
      document,
    });
    historySearchDocumentTasks.delete(entry.conversationKey);
    pruneHistorySearchDocumentCache();
  };

  const searchIndexedConversationHistory = async (
    libraryID: number,
    query: string,
  ): Promise<{
    entries: ConversationHistoryEntry[];
    resultsByKey: Map<number, HistorySearchResult>;
  }> => {
    const system = getConversationSystem();
    let indexed = await searchConversationIndexWithStatus({
      system,
      libraryID,
      query,
      refresh: false,
    });
    if (indexed.status === "empty" || indexed.status === "stale") {
      const refreshed = await searchConversationIndexWithStatus({
        system,
        libraryID,
        query,
        refresh: true,
      });
      if (refreshed.status !== "unavailable") {
        indexed = refreshed;
      }
    }
    if (shouldFallbackToLoadedConversationHistorySearch(indexed)) {
      return await searchLoadedConversationHistory(libraryID, query);
    }
    const entryByKey = new Map<number, ConversationHistoryEntry>();
    const documents = new Map<number, HistorySearchDocument>();
    const entriesNeedingVisibleRebuild: ConversationHistoryEntry[] = [];
    const addIndexedMatch = (match: ConversationSearchIndexMatch): void => {
      const entry = createHistorySearchEntryFromIndexMatch(match);
      if (
        !entry ||
        pendingDeletionStore.isConversationPendingDeletion(
          entry.conversationKey,
        )
      ) {
        return;
      }
      entryByKey.set(entry.conversationKey, entry);
      if (
        pendingDeletionStore.getPendingTurnsForConversation(
          entry.conversationKey,
        ).length > 0
      ) {
        // The shared index row still contains text from turns queued for
        // deletion. Rebuild this conversation's document from visible rows
        // and re-score; a conversation whose only hits were hidden text then
        // drops out via the matchCount gate.
        entriesNeedingVisibleRebuild.push(entry);
        return;
      }
      const document = createHistorySearchDocument(entry, [
        { text: match.bodyText },
      ]);
      cacheHistorySearchDocument(entry, document);
      documents.set(entry.conversationKey, document);
    };
    for (const match of indexed.matches) {
      addIndexedMatch(match);
    }
    if (entriesNeedingVisibleRebuild.length) {
      await runHistorySearchDocumentLoads(
        entriesNeedingVisibleRebuild,
        documents,
      );
    }
    if (indexed.status === "truncated") {
      const truncatedMatches = await loadTruncatedConversationIndexMatches({
        system,
        libraryID,
      });
      const truncatedEntries: ConversationHistoryEntry[] = [];
      for (const match of truncatedMatches) {
        const entry = createHistorySearchEntryFromIndexMatch(match);
        if (
          !entry ||
          pendingDeletionStore.isConversationPendingDeletion(
            entry.conversationKey,
          )
        ) {
          continue;
        }
        entryByKey.set(entry.conversationKey, entry);
        truncatedEntries.push(entry);
      }
      await runHistorySearchDocumentLoads(truncatedEntries, documents);
    }
    const entries = Array.from(entryByKey.values());
    const rawResults = buildHistorySearchResults(
      entries,
      normalizeHistorySearchQuery(query),
      documents,
    );
    const resultsByKey = new Map<number, HistorySearchResult>();
    for (const result of rawResults) {
      resultsByKey.set(result.entry.conversationKey, result);
    }
    return {
      entries: rawResults.map((result) => result.entry),
      resultsByKey,
    };
  };

  const searchLoadedConversationHistory = async (
    libraryID: number,
    query: string,
  ): Promise<{
    entries: ConversationHistoryEntry[];
    resultsByKey: Map<number, HistorySearchResult>;
  }> => {
    const entries = (
      await loadSearchableConversationHistory(libraryID, { limit: null })
    ).filter(
      (entry) =>
        !pendingDeletionStore.isConversationPendingDeletion(
          entry.conversationKey,
        ),
    );
    const documents = new Map<number, HistorySearchDocument>();
    await runHistorySearchDocumentLoads(entries, documents);
    const rawResults = buildHistorySearchResults(
      entries,
      normalizeHistorySearchQuery(query),
      documents,
    );
    const resultsByKey = new Map<number, HistorySearchResult>();
    for (const result of rawResults) {
      resultsByKey.set(result.entry.conversationKey, result);
    }
    return {
      entries: rawResults.map((result) => result.entry),
      resultsByKey,
    };
  };

  const buildHistorySearchDocument = async (
    entry: ConversationHistoryEntry,
  ): Promise<HistorySearchDocument> => {
    const messages = await conversationRepository.loadMessages({
      system: getConversationSystem(),
      conversationKey: entry.conversationKey,
      limit: PERSISTED_HISTORY_LIMIT,
    });
    // Rows from turns queued for deletion are still in the DB during the
    // undo window; keep them out of the searchable document so search can
    // never surface text the chat hides.
    const visibleMessages = filterMessagesInPendingTurns(
      entry.conversationKey,
      messages as Array<{
        role?: unknown;
        timestamp?: unknown;
        text?: unknown;
      }>,
    );
    return createHistorySearchDocument(entry, visibleMessages);
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

    const hasIndexedSearchResults =
      searchActive && historySearchResultsByKey.size > 0;
    const searchDocumentsReady = searchActive
      ? hasIndexedSearchResults ||
        allEntries.every((entry) => hasUsableHistorySearchDocument(entry))
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
      ? hasIndexedSearchResults
        ? Array.from(historySearchResultsByKey.values())
        : buildHistorySearchResults(
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
          scopeChip.dataset.labelType = getHistoryEntryLabelType(entry);
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

        if (canRenameHistoryEntry(entry)) {
          const renameBtn = createElement(
            body.ownerDocument as Document,
            "span",
            "llm-history-item-rename",
          ) as HTMLSpanElement;
          renameBtn.setAttribute("role", "button");
          renameBtn.setAttribute("aria-label", t("Rename chat"));
          renameBtn.title = t("Rename chat");
          renameBtn.dataset.action = "rename";
          titleRow.appendChild(renameBtn);
        }

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
            resolveHistoryScopeLabel(entry),
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
    cancelHistorySearchDebounce();
    historySearchLoadSeq += 1;
    historySearchExpanded = false;
    historySearchQuery = "";
    historySearchLoading = false;
    historySearchResultsByKey = new Map();
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
      historySearchResultsByKey = new Map();
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

    const libraryID = getCurrentLibraryID();
    try {
      const indexed = libraryID
        ? await searchIndexedConversationHistory(libraryID, historySearchQuery)
        : { entries: [], resultsByKey: new Map<number, HistorySearchResult>() };
      if (requestId !== historySearchLoadSeq) return;
      historySearchEntries = indexed.entries;
      historySearchResultsByKey = indexed.resultsByKey;
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
    } catch (err) {
      ztoolkit.log("LLM: DB-backed conversation history search failed", err);
    }

    try {
      const loaded = libraryID
        ? await searchLoadedConversationHistory(libraryID, historySearchQuery)
        : { entries: [], resultsByKey: new Map<number, HistorySearchResult>() };
      if (requestId !== historySearchLoadSeq) return;
      historySearchEntries = loaded.entries;
      historySearchResultsByKey = loaded.resultsByKey;
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
    } catch (err) {
      ztoolkit.log("LLM: Failed to load searchable conversation history", err);
    }
    if (requestId !== historySearchLoadSeq) return;
    historySearchEntries = [];
    historySearchResultsByKey = new Map();
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

  function cancelHistorySearchDebounce(): void {
    const win = deps.body.ownerDocument.defaultView;
    if (!win || historySearchDebounceTimer === null) return;
    win.clearTimeout(historySearchDebounceTimer);
    historySearchDebounceTimer = null;
  }

  function scheduleHistorySearchMenuRefresh(): void {
    const win = deps.body.ownerDocument.defaultView;
    if (!win) {
      void refreshHistorySearchMenu();
      return;
    }
    if (historySearchDebounceTimer !== null) {
      win.clearTimeout(historySearchDebounceTimer);
    }
    historySearchDebounceTimer = win.setTimeout(() => {
      historySearchDebounceTimer = null;
      void refreshHistorySearchMenu();
    }, 200);
  }

  const refreshGlobalHistoryHeader = async () => {
    if (!historyBar || !titleStatic || !item) {
      if (titleStatic) titleStatic.style.display = "";
      if (historyBar) historyBar.style.display = "none";
      closeHistoryNewMenu();
      closeHistoryMenu();
      // A live pending deletion keeps its undo toast even while the header
      // is unavailable — hiding it here silently withdrew undo mid-window.
      if (!pendingDeletionStore.getLatestPending()) hideHistoryUndoToast();
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
              await ensureActiveConversationCatalogEntry({
                system: "claude_code",
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
              if (
                pendingDeletionStore.isConversationPendingDeletion(
                  normalizedKey,
                )
              )
                continue;
              if (seenPaperKeys.has(normalizedKey)) continue;
              seenPaperKeys.add(normalizedKey);
              const lastActivity = Number(
                summary.lastActivityAt || summary.createdAt || 0,
              );
              const isDraft = Boolean(summary.isDraft);
              paperEntries.push({
                kind: "paper",
                sourceState: "active",
                section: "paper",
                sectionTitle: "Paper Chat",
                conversationID: summary.conversationID,
                conversationKey: normalizedKey,
                libraryID,
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
                userTurnCount: summary.userTurnCount,
                paperItemID,
                providerSessionId: summary.providerSessionId,
                scopedConversationKey: summary.scopedConversationKey,
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
              await ensureActiveConversationCatalogEntry({
                system: "codex",
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
              if (
                pendingDeletionStore.isConversationPendingDeletion(
                  normalizedKey,
                )
              )
                continue;
              if (seenPaperKeys.has(normalizedKey)) continue;
              seenPaperKeys.add(normalizedKey);
              const lastActivity = Number(
                summary.lastActivityAt || summary.createdAt || 0,
              );
              const isDraft = Boolean(summary.isDraft);
              paperEntries.push({
                kind: "paper",
                sourceState: "active",
                section: "paper",
                sectionTitle: "Paper Chat",
                conversationID: summary.conversationID,
                conversationKey: normalizedKey,
                libraryID,
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
                userTurnCount: summary.userTurnCount,
                paperItemID,
                providerSessionId: summary.providerSessionId,
                scopedConversationKey: summary.scopedConversationKey,
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
              if (
                pendingDeletionStore.isConversationPendingDeletion(
                  normalizedKey,
                )
              )
                continue;
              if (seenPaperKeys.has(normalizedKey)) continue;
              seenPaperKeys.add(normalizedKey);
              const lastActivity = Number(
                summary.lastActivityAt || summary.createdAt || 0,
              );
              const isDraft = Boolean(summary.isDraft);
              paperEntries.push({
                kind: "paper",
                sourceState: "active",
                section: "paper",
                sectionTitle: "Paper Chat",
                conversationID: summary.conversationID,
                conversationKey: normalizedKey,
                libraryID,
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
                userTurnCount: summary.userTurnCount,
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
        paperEntries.splice(
          0,
          paperEntries.length,
          ...collapseDuplicateReusableConversationDrafts({
            entries: paperEntries,
            activeConversationKey: item ? getConversationKey(item) : null,
          }),
        );
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
            await ensureActiveConversationCatalogEntry({
              system: "claude_code",
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

        let historyEntries: Awaited<
          ReturnType<typeof loadClaudeConversationHistoryScope>
        > = [];
        try {
          historyEntries = await loadClaudeConversationHistoryScope({
            libraryID,
            kind: "global",
            limit: GLOBAL_HISTORY_LIMIT,
          });
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
          if (pendingDeletionStore.isConversationPendingDeletion(normalizedKey))
            continue;
          if (seenGlobalKeys.has(normalizedKey)) continue;
          seenGlobalKeys.add(normalizedKey);
          const lastActivity = Number(
            entry.lastActivityAt || entry.createdAt || 0,
          );
          const isDraft = Boolean(entry.isDraft);
          globalEntries.push({
            kind: "global",
            sourceState: "active",
            section: "open",
            sectionTitle: "Library Chat",
            conversationID: entry.conversationID,
            conversationKey: normalizedKey,
            libraryID,
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
            userTurnCount: entry.userTurnCount,
            providerSessionId: entry.providerSessionId,
            scopedConversationKey: entry.scopedConversationKey,
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
            await ensureActiveConversationCatalogEntry({
              system: "codex",
              conversationKey: activeGlobalKey,
              libraryID,
              kind: "global",
            });
          } catch (err) {
            ztoolkit.log("LLM: Failed to ensure active Codex history row", err);
          }
        }
        if (requestId !== globalHistoryLoadSeq) return;

        let historyEntries: Awaited<
          ReturnType<typeof loadCodexConversationHistoryScope>
        > = [];
        try {
          historyEntries = await loadCodexConversationHistoryScope({
            libraryID,
            kind: "global",
            limit: GLOBAL_HISTORY_LIMIT,
          });
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
          if (pendingDeletionStore.isConversationPendingDeletion(normalizedKey))
            continue;
          if (seenGlobalKeys.has(normalizedKey)) continue;
          seenGlobalKeys.add(normalizedKey);
          const lastActivity = Number(
            entry.lastActivityAt || entry.createdAt || 0,
          );
          const isDraft = Boolean(entry.isDraft);
          globalEntries.push({
            kind: "global",
            sourceState: "active",
            section: "open",
            sectionTitle: "Library Chat",
            conversationID: entry.conversationID,
            conversationKey: normalizedKey,
            libraryID,
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
            userTurnCount: entry.userTurnCount,
            providerSessionId: entry.providerSessionId,
            scopedConversationKey: entry.scopedConversationKey,
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
            activeGlobalKey =
              remembered === GLOBAL_CONVERSATION_KEY_BASE
                ? buildDefaultUpstreamGlobalConversationKey(libraryID)
                : Math.floor(remembered);
          }
        }
        if (activeGlobalKey > 0) {
          try {
            await ensureActiveConversationCatalogEntry({
              system: "upstream",
              conversationKey: activeGlobalKey,
              libraryID,
              kind: "global",
            });
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
          if (pendingDeletionStore.isConversationPendingDeletion(normalizedKey))
            continue;
          if (seenGlobalKeys.has(normalizedKey)) continue;
          seenGlobalKeys.add(normalizedKey);
          const lastActivity = Number(
            entry.lastActivityAt || entry.createdAt || 0,
          );
          globalEntries.push({
            kind: "global",
            sourceState: "active",
            section: "open",
            sectionTitle: "Library Chat",
            conversationID: entry.conversationID,
            conversationKey: normalizedKey,
            libraryID,
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
            userTurnCount: entry.userTurnCount,
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
      globalEntries.splice(
        0,
        globalEntries.length,
        ...collapseDuplicateReusableConversationDrafts({
          entries: dedupedGlobalEntries,
          activeConversationKey: item ? getConversationKey(item) : null,
        }),
      );
    }

    const activeHistorySection = isGlobalMode() ? "open" : "paper";
    const allEntries =
      activeHistorySection === "paper" ? paperEntries : globalEntries;
    const visibleEntries = allEntries.filter(
      (entry) =>
        !pendingDeletionStore.isConversationPendingDeletion(
          entry.conversationKey,
        ),
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

  const switchGlobalConversation = async (
    nextConversationKey: number,
  ): Promise<boolean> => {
    if (!item) return false;
    const noteFocusItem = isNoteSession() ? item : null;
    persistDraftInputForCurrentConversation();
    const libraryID = getCurrentLibraryID();
    if (!libraryID) return false;
    const normalizedConversationKey = Number.isFinite(nextConversationKey)
      ? Math.floor(nextConversationKey)
      : 0;
    if (normalizedConversationKey <= 0) return false;
    if (
      pendingDeletionStore.isConversationPendingDeletion(
        normalizedConversationKey,
      )
    ) {
      if (status) {
        setStatus(status, t("Deletion pending; retrying safely"), "warning");
      }
      return false;
    }
    const system = getConversationSystem();
    // Deliberate navigation: the user wants this key alive again, so a stale
    // just-deleted tombstone must not keep its catalog row suppressed. It also
    // means this surface has chosen where it sits, so any remembered surrender
    // is void — an abandoned deletion must not yank it off the chat the user
    // just opened.
    forgetRecentlyDeletedConversation(normalizedConversationKey);
    getSurrenderedDeletionTargets().clear();
    const ensured = await ensureConversationCatalogEntry({
      system,
      conversationKey: normalizedConversationKey,
      libraryID,
      kind: "global",
    });
    if (
      !ensured ||
      ensured.kind !== "global" ||
      ensured.libraryID !== libraryID
    ) {
      ztoolkit.log("LLM: Refused to switch to mismatched global conversation", {
        system,
        conversationKey: normalizedConversationKey,
        libraryID,
        registeredLibraryID: ensured?.libraryID,
        registeredKind: ensured?.kind,
      });
      if (status)
        setStatus(status, t("Could not load this conversation"), "error");
      return false;
    }
    const nextItem =
      system === "claude_code"
        ? createClaudeGlobalPortalItem(libraryID, normalizedConversationKey)
        : system === "codex"
          ? createCodexGlobalPortalItem(libraryID, normalizedConversationKey)
          : createGlobalPortalItem(libraryID, normalizedConversationKey);
    if (!noteFocusItem) {
      setCurrentItem(nextItem as any);
    }
    if (system === "claude_code") {
      rememberClaudeConversationSelection({
        conversationKey: normalizedConversationKey,
        kind: "global",
        libraryID,
      });
      void touchClaudeConversation(normalizedConversationKey, {
        updatedAt: Date.now(),
      });
    } else if (system === "codex") {
      activeCodexGlobalConversationByLibrary.set(
        buildCodexLibraryStateKey(libraryID),
        normalizedConversationKey,
      );
      setLastUsedCodexGlobalConversationKey(
        libraryID,
        normalizedConversationKey,
      );
    } else {
      activeGlobalConversationByLibrary.set(
        libraryID,
        normalizedConversationKey,
      );
      setLastUsedUpstreamGlobalConversationKey(
        libraryID,
        normalizedConversationKey,
      );
    }
    syncConversationIdentity();
    void renderShortcuts(body, item as Zotero.Item, resolveShortcutMode(item));
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
    return true;
  };

  const switchPaperConversation = async (
    nextConversationKey?: number,
    options?: {
      paperItem?: Zotero.Item | null;
      allowedCatalogPaperItemID?: number;
    },
  ): Promise<boolean> => {
    if (!item) return false;
    const noteFocusItem = isNoteSession() ? item : null;
    persistDraftInputForCurrentConversation();
    const paperItem = options?.paperItem || resolveCurrentPaperBaseItem();
    if (!paperItem) return false;
    setBasePaperItem(paperItem);
    const libraryID = getCurrentLibraryID();
    if (!libraryID) return false;
    const paperItemID = Number(paperItem.id || 0);
    if (!Number.isFinite(paperItemID) || paperItemID <= 0) return false;

    const system = getConversationSystem();
    const requestedConversationKey = Number(nextConversationKey || 0);
    const allowedCatalogPaperItemID = normalizeHistoryPaperItemID(
      options?.allowedCatalogPaperItemID,
    );
    const loadPaperCatalogEntry = async (
      conversationKey: number,
    ): Promise<ConversationCatalogEntry | null> => {
      if (!Number.isFinite(conversationKey) || conversationKey <= 0) {
        return null;
      }
      const normalizedConversationKey = Math.floor(conversationKey);
      if (
        pendingDeletionStore.isConversationPendingDeletion(
          normalizedConversationKey,
        )
      ) {
        return null;
      }
      const entry =
        system === "upstream"
          ? await conversationRepository.ensureCatalogEntry({
              system,
              kind: "paper",
              conversationKey: normalizedConversationKey,
              libraryID,
              paperItemID,
            })
          : await conversationRepository.getCatalogEntry({
              system,
              kind: "paper",
              conversationKey: normalizedConversationKey,
            });
      const entryPaperItemID = normalizeHistoryPaperItemID(entry?.paperItemID);
      if (
        !entry ||
        entry.kind !== "paper" ||
        !entryPaperItemID ||
        (entryPaperItemID !== paperItemID &&
          entryPaperItemID !== allowedCatalogPaperItemID)
      ) {
        return null;
      }
      return entry;
    };
    const resolveRememberedPaperConversationKey = (): number => {
      if (system === "claude_code") {
        return Number(
          resolveRememberedClaudeConversationKey({
            libraryID,
            kind: "paper",
            paperItemID,
          }) || 0,
        );
      }
      if (system === "codex") {
        return Number(
          activeCodexPaperConversationByPaper.get(
            buildCodexPaperStateKey(libraryID, paperItemID),
          ) ||
            getLastUsedCodexPaperConversationKey(libraryID, paperItemID) ||
            0,
        );
      }
      return Number(
        activePaperConversationByPaper.get(
          buildPaperStateKey(libraryID, paperItemID),
        ) ||
          getLastUsedPaperConversationKey(libraryID, paperItemID) ||
          0,
      );
    };

    let targetSummary = await loadPaperCatalogEntry(requestedConversationKey);
    if (!targetSummary) {
      targetSummary = await loadPaperCatalogEntry(
        resolveRememberedPaperConversationKey(),
      );
    }
    if (!targetSummary) {
      targetSummary = await conversationRepository.ensureCatalogEntry({
        system,
        kind: "paper",
        libraryID,
        paperItemID,
      });
    }
    if (!targetSummary) return false;

    const resolvedConversationKey = Math.floor(targetSummary.conversationKey);
    if (
      pendingDeletionStore.isConversationPendingDeletion(
        resolvedConversationKey,
      )
    ) {
      if (status) {
        setStatus(status, t("Deletion pending; retrying safely"), "warning");
      }
      return false;
    }
    // Deliberate navigation to a different instance may clear only the
    // legacy key-only compatibility tombstone; it never cancels a pending
    // deletion intent.
    forgetRecentlyDeletedConversation(resolvedConversationKey);
    if (!noteFocusItem) {
      if (system === "claude_code") {
        setCurrentItem(
          createClaudePaperPortalItem(
            paperItem,
            resolvedConversationKey,
          ) as any,
        );
      } else if (system === "codex") {
        setCurrentItem(
          createCodexPaperPortalItem(paperItem, resolvedConversationKey) as any,
        );
      } else {
        const nextItem =
          resolvedConversationKey === paperItemID
            ? paperItem
            : createPaperPortalItem(
                paperItem,
                resolvedConversationKey,
                targetSummary.sessionVersion || 1,
              );
        setCurrentItem(nextItem as any);
      }
    }
    if (system === "claude_code") {
      rememberClaudeConversationSelection({
        conversationKey: resolvedConversationKey,
        kind: "paper",
        libraryID,
        paperItemID,
      });
      void touchClaudeConversation(resolvedConversationKey, {
        updatedAt: Date.now(),
      });
    } else if (system === "codex") {
      activeCodexPaperConversationByPaper.set(
        buildCodexPaperStateKey(libraryID, paperItemID),
        resolvedConversationKey,
      );
      setLastUsedCodexPaperConversationKey(
        libraryID,
        paperItemID,
        resolvedConversationKey,
      );
    } else {
      activePaperConversationByPaper.set(
        buildPaperStateKey(libraryID, paperItemID),
        resolvedConversationKey,
      );
      // Ephemeral webchat session rows (flagged in the catalog) are swept at
      // the next startup, so they must never become the paper's persisted
      // last-used conversation. Registering the key in the isolation set
      // BEFORE syncConversationIdentity() runs makes the guard inside
      // setLastUsedPaperConversationKey hold for every later writer too —
      // identity sync and history-navigation priming both re-persist the
      // active key on their own.
      if (targetSummary.webchatSession === true) {
        webChatIsolatedConversationKeys.add(resolvedConversationKey);
      } else {
        setLastUsedPaperConversationKey(
          libraryID,
          paperItemID,
          resolvedConversationKey,
        );
      }
    }
    syncConversationIdentity();
    refreshAutoLoadedPaperContextForCurrentItem();
    void renderShortcuts(body, item as Zotero.Item, resolveShortcutMode(item));
    if (isWebChatMode()) {
      const hadWebChatSession =
        webChatIsolatedConversationKeys.has(resolvedConversationKey) &&
        chatHistory.has(resolvedConversationKey);
      webChatIsolatedConversationKeys.add(resolvedConversationKey);
      if (!hadWebChatSession) {
        chatHistory.set(resolvedConversationKey, []);
        markNextWebChatSendAsNewChat();
        primeFreshWebChatPaperChipState();
      }
      loadedConversationKeys.add(resolvedConversationKey);
    } else {
      await ensureConversationLoaded(item as Zotero.Item);
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
    invalidateHistorySearchDocument(getConversationKey(item as Zotero.Item));
    restoreDraftInputForCurrentConversation();
    refreshChatPreservingScroll();
    resetComposePreviewUI();
    updateModelButton();
    updateReasoningButton();
    void refreshGlobalHistoryHeader();
    return true;
  };

  const openForkSourceConversation = async (
    link: ConversationForkLink,
  ): Promise<void> => {
    syncStateFromDeps();
    const sourceConversationKey = normalizeHistoryPaperItemID(
      link.sourceConversationKey,
    );
    if (!sourceConversationKey) {
      showTopToast(t("Original conversation not found"));
      if (status)
        setStatus(status, t("Original conversation not found"), "warning");
      return;
    }

    if (getConversationSystem() !== link.sourceSystem) {
      await deps.switchConversationSystem(link.sourceSystem);
      syncStateFromDeps();
    }

    const sourceEntry = await conversationRepository.getCatalogEntry({
      system: link.sourceSystem,
      kind: link.sourceKind,
      conversationKey: sourceConversationKey,
    });
    if (!sourceEntry || sourceEntry.kind !== link.sourceKind) {
      showTopToast(t("Original conversation not found"));
      if (status)
        setStatus(status, t("Original conversation not found"), "warning");
      return;
    }

    const libraryID =
      normalizeHistoryPaperItemID(sourceEntry.libraryID) ||
      normalizeHistoryPaperItemID(link.sourceLibraryID) ||
      getCurrentLibraryID();
    const targetModeSnapshot = primeHistoryNavigationMode({
      system: link.sourceSystem,
      libraryID,
      mode: link.sourceKind,
      conversationKey: sourceConversationKey,
      paperItemID:
        link.sourceKind === "paper"
          ? normalizeHistoryPaperItemID(
              sourceEntry.paperItemID || link.sourcePaperItemID,
            )
          : undefined,
    });
    let loaded = false;
    try {
      if (link.sourceKind === "paper") {
        const paperItemID =
          normalizeHistoryPaperItemID(sourceEntry.paperItemID) ||
          normalizeHistoryPaperItemID(link.sourcePaperItemID);
        const paperItem = paperItemID
          ? (Zotero.Items.get(paperItemID) as Zotero.Item | null)
          : null;
        if (!paperItem) {
          showTopToast(t("This chat's source item was deleted"));
          if (status) {
            setStatus(
              status,
              t("This chat's source item was deleted"),
              "warning",
            );
          }
          return;
        }
        loaded = await switchPaperConversation(sourceConversationKey, {
          paperItem,
          allowedCatalogPaperItemID: paperItemID,
        });
      } else {
        loaded = await switchGlobalConversation(sourceConversationKey);
      }
      if (!loaded) {
        showTopToast(t("Could not load this conversation"));
        if (status)
          setStatus(status, t("Could not load this conversation"), "error");
      }
    } finally {
      if (!loaded) {
        targetModeSnapshot.restore();
      }
    }
  };

  setForkSourceNavigationRunner(body, openForkSourceConversation);

  const switchToHistoryTarget = async (
    target: HistorySwitchTarget,
  ): Promise<boolean> => {
    if (!target) return false;
    if (target.kind === "paper") {
      return switchPaperConversation(target.conversationKey);
    }
    return switchGlobalConversation(target.conversationKey);
  };

  const resolvePaperItemFromHistoryEntry = (
    entry: ConversationHistoryEntry,
  ): Zotero.Item | null => {
    return resolveHistoryEntryPaperBaseItem(
      entry,
      (paperItemID) => Zotero.Items.get(paperItemID) as Zotero.Item | null,
    );
  };

  const getCurrentHistoryPaperItemID = (): number => {
    return normalizeHistoryPaperItemID(resolveCurrentPaperBaseItem()?.id);
  };

  const maybeSelectHistoryEntryPaperItem = async (
    decision: ReturnType<typeof resolvePaperHistoryNavigationDecision>,
    paperItem: Zotero.Item,
  ): Promise<boolean> => {
    try {
      return await maybeSelectPaperHistoryTarget({
        decision,
        paperItemID: paperItem.id,
        getPane: () =>
          Zotero.getActiveZoteroPane?.() as
            | HistoryPaperPaneSelector
            | undefined,
      });
    } catch (err) {
      ztoolkit.log("LLM: Failed to select searched conversation paper", {
        paperItemID: paperItem.id,
        error: err,
      });
      return false;
    }
  };

  const switchToHistoryEntry = async (
    entry: ConversationHistoryEntry,
  ): Promise<boolean> => {
    if (entry.kind === "paper") {
      if (isOrphanHistoryEntry(entry)) {
        if (status) {
          setStatus(
            status,
            t("This chat's source item was deleted"),
            "warning",
          );
        }
        return false;
      }
      const paperItem = resolvePaperItemFromHistoryEntry(entry);
      if (!paperItem) {
        if (status) {
          setStatus(
            status,
            t("This chat's source item was deleted"),
            "warning",
          );
        }
        return false;
      }
      const navigationDecision = resolvePaperHistoryNavigationDecision({
        entryPaperItemID: paperItem.id,
        currentPaperItemID: getCurrentHistoryPaperItemID(),
      });
      if (navigationDecision === "missing-target-paper") {
        if (status) {
          setStatus(status, t("Could not find this paper"), "error");
        }
        return false;
      }
      const targetModeSnapshot = primeHistoryNavigationMode({
        system: getConversationSystem(),
        libraryID:
          normalizeHistoryPaperItemID(entry.libraryID) ||
          normalizeHistoryPaperItemID(paperItem.libraryID) ||
          getCurrentLibraryID(),
        mode: "paper",
        conversationKey: entry.conversationKey,
        paperItemID: paperItem.id,
      });
      let loaded = false;
      try {
        if (navigationDecision === "select-target-paper") {
          const selected = await maybeSelectHistoryEntryPaperItem(
            navigationDecision,
            paperItem,
          );
          if (!selected) {
            if (status) {
              setStatus(status, t("Could not focus this paper"), "error");
            }
            return false;
          }
        }
        loaded = await switchPaperConversation(entry.conversationKey, {
          paperItem,
          allowedCatalogPaperItemID:
            normalizeHistoryPaperItemID(entry.catalogPaperItemID) ||
            normalizeHistoryPaperItemID(entry.paperItemID) ||
            undefined,
        });
        if (!loaded && status) {
          setStatus(status, t("Could not load this conversation"), "error");
        }
        return loaded;
      } finally {
        if (!loaded) {
          targetModeSnapshot.restore();
        }
      }
    }
    const targetModeSnapshot = primeHistoryNavigationMode({
      system: getConversationSystem(),
      libraryID:
        normalizeHistoryPaperItemID(entry.libraryID) || getCurrentLibraryID(),
      mode: "global",
      conversationKey: entry.conversationKey,
    });
    let loaded = false;
    try {
      loaded = await switchGlobalConversation(entry.conversationKey);
      return loaded;
    } finally {
      if (!loaded) {
        targetModeSnapshot.restore();
      }
    }
  };

  const forkConversationFromTurn = async (
    target: ForkTurnTarget,
  ): Promise<void> => {
    syncStateFromDeps();
    const targetItem = target.item || item;
    const sourceConversationKey = Number.isFinite(target.conversationKey)
      ? Math.floor(target.conversationKey)
      : 0;
    const assistantTimestamp = Number.isFinite(target.assistantTimestamp)
      ? Math.floor(target.assistantTimestamp)
      : 0;
    if (!targetItem || sourceConversationKey <= 0 || assistantTimestamp <= 0) {
      if (status) setStatus(status, t("No forkable turn found"), "error");
      return;
    }
    const activeSystem = getConversationSystem();
    const initialEligibility = evaluateConversationForkEligibility({
      system: activeSystem,
      assistantTimestamp,
      pendingResponse: isRequestPending(sourceConversationKey),
      webchatMode: isWebChatMode(),
    });
    if (!initialEligibility.allowed) {
      if (status)
        setStatus(
          status,
          getForkEligibilityStatusMessage(initialEligibility.reason),
          getForkEligibilityStatusLevel(initialEligibility.reason),
        );
      return;
    }

    const overlappingPendingTurns = pendingDeletionStore
      .getPendingTurnsForConversation(sourceConversationKey)
      .filter((pending) => pending.assistantTimestamp <= assistantTimestamp);
    for (const pending of overlappingPendingTurns) {
      const finalized = await pendingDeletionStore.finalize(
        pending.id,
        "fork-overlap",
      );
      if (!finalized) return;
    }

    const sourceHistory = chatHistory.get(sourceConversationKey) || [];
    const turnPair = findTurnPairByTimestamps(
      sourceHistory,
      target.userTimestamp,
      assistantTimestamp,
    );
    if (!turnPair) {
      if (status) setStatus(status, t("No forkable turn found"), "error");
      return;
    }

    const kind = resolveDisplayConversationKind(targetItem);
    if (kind !== "global" && kind !== "paper") {
      if (status) setStatus(status, t("No forkable turn found"), "error");
      return;
    }
    const baseItem = resolveConversationBaseItem(targetItem);
    const libraryID =
      normalizeHistoryPaperItemID(targetItem.libraryID) ||
      normalizeHistoryPaperItemID(baseItem?.libraryID) ||
      getCurrentLibraryID();
    if (!libraryID) {
      if (status)
        setStatus(
          status,
          t("No active library for conversation fork"),
          "error",
        );
      return;
    }

    const paperItemID =
      kind === "paper" ? normalizeHistoryPaperItemID(baseItem?.id) : 0;
    if (kind === "paper" && (!baseItem || !paperItemID)) {
      if (status)
        setStatus(status, t("No active paper for paper chat"), "error");
      return;
    }

    const executionEligibility = evaluateConversationForkEligibility({
      system: activeSystem,
      assistantTimestamp,
      assistantMessage: turnPair.assistantMessage,
      history: sourceHistory,
    });
    if (!executionEligibility.allowed) {
      if (status)
        setStatus(
          status,
          getForkEligibilityStatusMessage(executionEligibility.reason),
          getForkEligibilityStatusLevel(executionEligibility.reason),
        );
      return;
    }

    let result: Awaited<
      ReturnType<typeof conversationRepository.forkConversation>
    > | null = null;
    try {
      result = await conversationRepository.forkConversation({
        system: activeSystem,
        kind,
        libraryID,
        paperItemID: paperItemID || undefined,
        sourceConversationKey,
        throughAssistantTimestamp: assistantTimestamp,
      });
    } catch (err) {
      ztoolkit.log("LLM: Failed to fork conversation", err);
    }
    if (!result?.entry?.conversationKey) {
      if (status) setStatus(status, t("Failed to fork conversation"), "error");
      return;
    }

    const nextConversationKey = Math.floor(result.entry.conversationKey);
    conversationForkLinks.set(nextConversationKey, result.forkLink);
    chatHistory.delete(nextConversationKey);
    loadedConversationKeys.delete(nextConversationKey);
    invalidateHistorySearchDocument(sourceConversationKey);
    invalidateHistorySearchDocument(nextConversationKey);

    let loaded = false;
    if (kind === "paper") {
      loaded = Boolean(
        await switchPaperConversation(nextConversationKey, {
          paperItem: baseItem,
          allowedCatalogPaperItemID: paperItemID,
        }),
      );
    } else {
      loaded = await switchGlobalConversation(nextConversationKey);
    }
    if (!loaded) {
      if (status)
        setStatus(status, t("Could not load this conversation"), "error");
      return;
    }

    try {
      const forkedHistory = chatHistory.get(nextConversationKey) || [];
      await replaceOwnerAttachmentRefs(
        "conversation",
        nextConversationKey,
        collectAttachmentHashesFromMessages(forkedHistory),
        getConversationWriteGeneration(nextConversationKey),
      );
    } catch (err) {
      ztoolkit.log("LLM: Failed to refresh fork attachment refs", err);
    }
    void refreshGlobalHistoryHeader();
    showTopToast(t("Conversation forked"));
    if (status) setStatus(status, t("Conversation forked"), "ready");
  };

  const historySearchPopupController = createHistorySearchPopupController({
    parent: panelRoot || (body as HTMLElement),
    loadEntries: async () => {
      const libraryID = getCurrentLibraryID();
      const entries = libraryID
        ? await loadSearchableConversationHistory(libraryID)
        : [];
      return entries.filter(
        (entry) =>
          !pendingDeletionStore.isConversationPendingDeletion(
            entry.conversationKey,
          ),
      );
    },
    loadDocument: (entry) => ensureHistorySearchDocument(entry),
    searchEntries: async (query) => {
      const libraryID = getCurrentLibraryID();
      if (!libraryID) {
        return {
          entries: [],
          resultsByKey: new Map<number, HistorySearchResult>(),
        };
      }
      try {
        return await searchIndexedConversationHistory(libraryID, query);
      } catch (err) {
        ztoolkit.log("LLM: DB-backed history search popup failed", err);
        return await searchLoadedConversationHistory(libraryID, query);
      }
    },
    onSelect: async (entry) => {
      const loaded = await switchToHistoryEntry(entry);
      if (loaded && status)
        setStatus(status, t("Conversation loaded"), "ready");
      return loaded;
    },
    onDelete: async (entry) => {
      await queueHistoryDeletion(entry);
    },
    translate: t,
    log: (...args) => ztoolkit.log("LLM: history search popup", args),
    resolveLabel: (entry) => resolveHistoryScopeChipLabel(entry),
    resolveScopeLabel: (entry) => resolveHistoryScopeLabel(entry),
  });

  const clearPendingDeletionCaches = (conversationKey: number) => {
    invalidateHistorySearchDocument(conversationKey);
  };

  const queueTurnDeletion = async (target: {
    conversationKey: number;
    userTimestamp: number;
    assistantTimestamp: number;
    userMessageID?: number;
    assistantMessageID?: number;
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

    const catalog = await conversationRepository.getCatalogEntry({
      system: getConversationSystem(),
      kind:
        resolveDisplayConversationKind(item) === "paper" ? "paper" : "global",
      conversationKey: target.conversationKey,
    });
    const turnDeletionInput = {
      conversationKey: target.conversationKey,
      system: getConversationSystem(),
      ...(catalog?.instanceID ? { instanceID: catalog.instanceID } : {}),
      ...(catalog?.kind ? { conversationKind: catalog.kind } : {}),
      ...(catalog?.libraryID ? { libraryID: catalog.libraryID } : {}),
      ...(catalog?.paperItemID ? { paperItemID: catalog.paperItemID } : {}),
      userTimestamp: Math.floor(target.userTimestamp),
      assistantTimestamp: Math.floor(target.assistantTimestamp),
      ...(pair.userMessage.id ? { userMessageID: pair.userMessage.id } : {}),
      ...(pair.assistantMessage.id
        ? { assistantMessageID: pair.assistantMessage.id }
        : {}),
      ...(catalog?.providerSessionId
        ? { providerSessionId: catalog.providerSessionId }
        : {}),
    };
    const queued =
      await pendingDeletionStore.queueTurnDeletion(turnDeletionInput);
    if (!queued) {
      if (status) {
        setStatus(status, t("Failed to queue deletion. Check logs."), "error");
      }
      return;
    }
    invalidateHistorySearchDocument(target.conversationKey);
    setActiveEditSession(null);
    refreshChatPreservingScroll();
    if (status) setStatus(status, t("Turn deleted. Undo available."), "ready");
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

  const getHistoryEntryRenameIdentity = (
    entry: ConversationHistoryEntry,
    system = getConversationSystem(),
  ): ConversationRenameIdentity => ({
    system,
    kind: entry.kind,
    conversationKey: entry.conversationKey,
  });

  const canRenameHistoryEntry = (entry: ConversationHistoryEntry): boolean =>
    isConversationRenameEligible({
      identity: getHistoryEntryRenameIdentity(entry),
      pendingDelete:
        entry.isPendingDelete ||
        pendingDeletionStore.isConversationPendingDeletion(
          entry.conversationKey,
        ),
      orphan: isOrphanHistoryEntry(entry),
      requestPending: isRequestPending(entry.conversationKey),
    });

  const getHistoryRowMenuEntry = (): ConversationHistoryEntry | null => {
    if (!historyRowMenuTarget) return null;
    return findHistoryEntryByKey(
      historyRowMenuTarget.kind,
      historyRowMenuTarget.conversationKey,
    );
  };

  const promptConversationRename = async (
    entry: ConversationHistoryEntry,
  ): Promise<string | null> => {
    const suggestedTitle = normalizeHistoryTitle(entry.title) || "";
    const raw = await showConversationRenameDialog(body.ownerDocument, {
      title: t("Rename chat"),
      initialTitle: suggestedTitle,
      confirmLabel: t("Rename"),
      cancelLabel: t("Cancel"),
    });
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
    if (isOrphanHistoryEntry(entry)) {
      if (status) {
        setStatus(status, t("This chat's source item was deleted"), "warning");
      }
      return;
    }
    if (
      entry.isPendingDelete ||
      pendingDeletionStore.isConversationPendingDeletion(entry.conversationKey)
    ) {
      return;
    }
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
    const target = getHistoryEntryRenameIdentity(entry);
    const renameGeneration = getConversationWriteGeneration(
      target.conversationKey,
    );
    const nextTitle = await promptConversationRename(entry);
    if (!nextTitle) return;
    try {
      let currentEntry = findHistoryEntryByKey(
        target.kind,
        target.conversationKey,
      );
      if (
        !canCommitConversationRename({
          target,
          current: currentEntry
            ? getHistoryEntryRenameIdentity(currentEntry)
            : null,
          pendingDelete:
            Boolean(currentEntry?.isPendingDelete) ||
            pendingDeletionStore.isConversationPendingDeletion(
              target.conversationKey,
            ),
          orphan: currentEntry ? isOrphanHistoryEntry(currentEntry) : false,
          requestPending: isRequestPending(target.conversationKey),
        })
      ) {
        return;
      }
      const summary = await conversationRepository.getCatalogEntry(target);
      currentEntry = findHistoryEntryByKey(target.kind, target.conversationKey);
      if (
        !summary ||
        summary.kind !== target.kind ||
        !canCommitConversationRename({
          target,
          current: currentEntry
            ? getHistoryEntryRenameIdentity(currentEntry)
            : null,
          pendingDelete:
            Boolean(currentEntry?.isPendingDelete) ||
            pendingDeletionStore.isConversationPendingDeletion(
              target.conversationKey,
            ),
          orphan: currentEntry ? isOrphanHistoryEntry(currentEntry) : false,
          requestPending: isRequestPending(target.conversationKey),
        })
      ) {
        return;
      }
      await conversationRepository.setCatalogTitle({
        ...target,
        expectedGeneration: renameGeneration,
        title: nextTitle,
      });
      invalidateHistorySearchDocument(target.conversationKey);
      await refreshGlobalHistoryHeader();
      if (status) setStatus(status, t("Conversation renamed"), "ready");
    } catch (err) {
      ztoolkit.log("LLM: Failed to rename conversation", err);
      if (status)
        setStatus(status, t("Failed to rename conversation"), "error");
    }
  };

  const hydrateHistoryEntryForDeletion = async (
    entry: ConversationHistoryEntry,
    conversationSystem: ConversationSystem,
  ): Promise<ConversationHistoryEntry> => {
    try {
      const summary = await conversationRepository.getCatalogEntry({
        system: conversationSystem,
        kind: entry.kind,
        conversationKey: entry.conversationKey,
      });
      if (!summary || summary.kind !== entry.kind) return entry;
      return {
        ...entry,
        conversationID: summary.conversationID || entry.conversationID,
        libraryID: summary.libraryID || entry.libraryID,
        title: entry.title || summary.title || "",
        userTurnCount: summary.userTurnCount ?? entry.userTurnCount,
        paperItemID: summary.paperItemID || entry.paperItemID,
        catalogPaperItemID: summary.paperItemID || entry.catalogPaperItemID,
        sessionVersion: summary.sessionVersion || entry.sessionVersion,
        providerSessionId: summary.providerSessionId || entry.providerSessionId,
        scopedConversationKey:
          summary.scopedConversationKey || entry.scopedConversationKey,
      };
    } catch (err) {
      ztoolkit.log("LLM: Failed to hydrate history row before deletion", {
        conversationKey: entry.conversationKey,
        error: err,
      });
      return entry;
    }
  };

  const rejectConversationDeletionWhileGenerating = (
    conversationKey: number,
  ): boolean => {
    if (!isRequestPending(conversationKey)) return false;
    if (status) {
      setStatus(status, t("Cannot delete while generating"), "ready");
    }
    return true;
  };

  const queueHistoryDeletion = async (
    entry: ConversationHistoryEntry,
    conversationSystem: ConversationSystem = getConversationSystem(),
  ): Promise<boolean> => {
    if (!item) return false;
    if (!entry.deletable) return false;
    if (rejectConversationDeletionWhileGenerating(entry.conversationKey)) {
      return false;
    }
    const targetEntry = await hydrateHistoryEntryForDeletion(
      entry,
      conversationSystem,
    );
    if (
      rejectConversationDeletionWhileGenerating(targetEntry.conversationKey)
    ) {
      return false;
    }
    const libraryID =
      normalizeHistoryPaperItemID(targetEntry.libraryID) ||
      getCurrentLibraryID();
    if (!libraryID) {
      if (status)
        setStatus(status, t("No active library for deletion"), "error");
      return false;
    }

    if (
      pendingDeletionStore.isConversationPendingDeletion(
        targetEntry.conversationKey,
      )
    ) {
      return false;
    }

    const wasActive = isHistoryEntryActive(targetEntry, conversationSystem);
    // Capture the catalog row's identity witness BEFORE queueing: keys are
    // recycled, so this is the only value that lets the finalizer prove it is
    // still deleting this conversation. A missing witness is persisted as a
    // durable intent and moves to identity quarantine after the Undo window.
    const identityWitness =
      await conversationRepository.getCatalogIdentityWitness({
        system: conversationSystem,
        kind: targetEntry.kind,
        conversationKey: targetEntry.conversationKey,
      });
    // No await may separate this final check from queueConversationDeletion:
    // that call freezes writes synchronously at the durable intent boundary.
    if (
      rejectConversationDeletionWhileGenerating(targetEntry.conversationKey)
    ) {
      return false;
    }
    const queued = await pendingDeletionStore.queueConversationDeletion({
      conversationKind: targetEntry.kind,
      instanceID: identityWitness?.instanceID || "",
      conversationID:
        identityWitness?.conversationID || targetEntry.conversationID,
      catalogCreatedAt: identityWitness?.catalogCreatedAt || 0,
      conversationKey: targetEntry.conversationKey,
      libraryID,
      system: conversationSystem,
      paperItemID: targetEntry.paperItemID,
      providerSessionId: targetEntry.providerSessionId || undefined,
      title: targetEntry.title,
      wasActive,
    });
    if (!queued) {
      if (status) {
        setStatus(status, t("Failed to queue deletion. Check logs."), "error");
      }
      await refreshGlobalHistoryHeader();
      return false;
    }

    // The intent is durable now.  Only after the write-ahead row exists may
    // the local search surface hide the conversation; a crash before this
    // point must not lose the user's deletion decision or leave a silently
    // filtered but otherwise live conversation.
    invalidateHistorySearchDocument(targetEntry.conversationKey);

    ztoolkit.log("LLM: Queued history deletion", {
      kind: targetEntry.kind,
      conversationKey: targetEntry.conversationKey,
      libraryID,
      wasActive,
      expiresAt: queued.expiresAt,
    });
    if (wasActive) {
      // We already stepped off this chat above; remember where we came from so
      // an undo or an abandoned deletion can put the user back instead of
      // leaving them stranded on the fresh blank chat.
      getSurrenderedDeletionTargets().set(queued.id, {
        kind: targetEntry.kind,
        conversationKey: targetEntry.conversationKey,
      });
    }
    await refreshGlobalHistoryHeader();
    if (status)
      setStatus(status, t("Conversation deleted. Undo available."), "ready");
    return true;
  };

  /**
   * Delete the conversation currently mounted in this surface through the
   * exact same durable/undoable lifecycle as a history-row Delete action.
   *
   * The system, kind, key, and catalog data are captured before the first
   * await. This prevents a runtime-mode or item switch during hydration from
   * retargeting the destructive action to a different conversation.
   */
  const queueCurrentConversationDeletion = async (): Promise<boolean> => {
    syncStateFromDeps();
    const targetItem = item;
    if (!targetItem) return false;

    const conversationSystem = getConversationSystem();
    const conversationKey = Math.floor(Number(getConversationKey(targetItem)));
    const kind = resolveDisplayConversationKind(targetItem);
    if (kind !== "global" && kind !== "paper") return false;
    if (!Number.isFinite(conversationKey) || conversationKey <= 0) {
      return false;
    }
    if (pendingDeletionStore.isConversationPendingDeletion(conversationKey)) {
      if (status) {
        setStatus(status, t("Deletion pending; retrying safely"), "warning");
      }
      return false;
    }
    if (rejectConversationDeletionWhileGenerating(conversationKey)) {
      return false;
    }

    const summary = await conversationRepository.getCatalogEntry({
      system: conversationSystem,
      kind,
      conversationKey,
    });
    if (!summary || summary.kind !== kind) {
      if (status) {
        setStatus(status, t("No saved conversation to delete"), "warning");
      }
      return false;
    }

    const entry = createHistorySearchEntry({
      kind,
      conversationID: summary.conversationID,
      conversationKey,
      title: summary.title,
      createdAt: summary.createdAt,
      lastActivityAt: summary.lastActivityAt,
      isDraft: summary.userTurnCount === 0,
      userTurnCount: summary.userTurnCount,
      paperItemID: summary.paperItemID,
      sessionVersion: summary.sessionVersion,
    });
    if (!entry) return false;

    return queueHistoryDeletion(
      {
        ...entry,
        libraryID: summary.libraryID,
        providerSessionId: summary.providerSessionId,
        scopedConversationKey: summary.scopedConversationKey,
      },
      conversationSystem,
    );
  };

  const createAndSwitchGlobalConversation = async (
    options: boolean | CreateConversationOptions = false,
  ): Promise<boolean> => {
    const { excludeConversationKey, forceFresh } =
      normalizeCreateConversationOptions(options);
    if (!item) return false;
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
      return false;
    }

    let targetConversationKey = 0;
    let reuseReason: "active-draft" | "latest-draft" | null = null;
    const system = getConversationSystem();
    const currentCandidate = (() => {
      if (system === "claude_code") {
        return isGlobalMode()
          ? getConversationKey(item)
          : Number(
              activeClaudeGlobalConversationByLibrary.get(
                buildClaudeLibraryStateKey(libraryID),
              ) || 0,
            );
      }
      if (system === "codex") {
        return isGlobalMode()
          ? getConversationKey(item)
          : Number(
              activeCodexGlobalConversationByLibrary.get(
                buildCodexLibraryStateKey(libraryID),
              ) || 0,
            );
      }
      return isGlobalMode() &&
        isUpstreamGlobalConversationKey(Number(getConversationKey(item) || 0))
        ? getConversationKey(item)
        : Number(activeGlobalConversationByLibrary.get(libraryID) || 0);
    })();
    const normalizedCurrentCandidate = Number.isFinite(currentCandidate)
      ? Math.floor(currentCandidate)
      : 0;

    const freshDraft = await resolveFreshConversationDraft({
      system,
      kind: "global",
      libraryID,
      currentConversationKey: normalizedCurrentCandidate,
      excludeConversationKey,
      limit: GLOBAL_HISTORY_LIMIT,
    });
    targetConversationKey = freshDraft.conversationKey;
    reuseReason =
      freshDraft.source === "current"
        ? "active-draft"
        : freshDraft.source === "listed"
          ? "latest-draft"
          : null;

    if (
      Math.floor(Number(targetConversationKey || 0)) === excludeConversationKey
    ) {
      targetConversationKey = 0;
    }
    if (!targetConversationKey) {
      if (status)
        setStatus(status, t("Failed to create conversation"), "error");
      return false;
    }

    if (system === "claude_code") {
      activeClaudeGlobalConversationByLibrary.set(
        buildClaudeLibraryStateKey(libraryID),
        targetConversationKey,
      );
    } else if (system === "codex") {
      activeCodexGlobalConversationByLibrary.set(
        buildCodexLibraryStateKey(libraryID),
        targetConversationKey,
      );
      setLastUsedCodexGlobalConversationKey(libraryID, targetConversationKey);
    } else {
      activeGlobalConversationByLibrary.set(libraryID, targetConversationKey);
      setLastUsedUpstreamGlobalConversationKey(
        libraryID,
        targetConversationKey,
      );
    }

    ztoolkit.log("LLM: + conversation action", {
      libraryID,
      targetConversationKey,
      action: reuseReason ? "reuse" : "create",
      reason: reuseReason || "new",
    });
    if (reuseReason) {
      await touchEmptyDraftActivity(targetConversationKey, "global");
    }
    if (forceFresh) {
      clearTransientComposeStateForItem(targetConversationKey);
    }
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
    return true;
  };

  const createAndSwitchPaperConversation = async (
    options: boolean | CreateConversationOptions = false,
  ): Promise<boolean> => {
    const { excludeConversationKey, forceFresh } =
      normalizeCreateConversationOptions(options);
    if (!item) return false;
    closeHistoryNewMenu();
    const paperItem = resolveCurrentPaperBaseItem();
    if (!paperItem) {
      if (status) {
        setStatus(status, t("Open a paper to start a paper chat"), "error");
      }
      return false;
    }
    setBasePaperItem(paperItem);
    const libraryID = getCurrentLibraryID();
    const paperItemID = Number(paperItem.id || 0);
    if (!libraryID || !Number.isFinite(paperItemID) || paperItemID <= 0) {
      if (status) {
        setStatus(status, t("No active paper for paper chat"), "error");
      }
      return false;
    }

    let targetConversationKey = 0;
    let reuseReason: "active-draft" | "existing-draft" | null = null;

    const system = getConversationSystem();
    const currentKey = Number(getConversationKey(item) || 0);
    const freshDraft = await resolveFreshConversationDraft({
      system,
      kind: "paper",
      libraryID,
      paperItemID,
      currentConversationKey: currentKey,
      excludeConversationKey,
    });
    targetConversationKey = freshDraft.conversationKey;
    reuseReason =
      freshDraft.source === "current"
        ? "active-draft"
        : freshDraft.source === "listed"
          ? "existing-draft"
          : null;
    if (
      Math.floor(Number(targetConversationKey || 0)) === excludeConversationKey
    ) {
      targetConversationKey = 0;
    }
    if (!targetConversationKey) {
      if (status) setStatus(status, t("Failed to create paper chat"), "error");
      return false;
    }

    ztoolkit.log("LLM: + paper conversation action", {
      libraryID,
      paperItemID,
      targetConversationKey,
      action: reuseReason ? "reuse" : "create",
      reason: reuseReason || "new",
    });

    if (reuseReason) {
      await touchEmptyDraftActivity(targetConversationKey, "paper");
    }
    if (forceFresh) {
      clearTransientComposeStateForItem(targetConversationKey);
    }
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
    return true;
  };

  // [webchat] Entering webchat mode anchors the panel on a dedicated,
  // catalog-hidden session row instead of a normal draft: webchat transcripts
  // live on the provider site, so nothing from the session may surface in the
  // local history list or claim a draft the user created.
  const ensureWebChatSessionPaperConversation = async (): Promise<boolean> => {
    if (!item) return false;
    closeHistoryNewMenu();
    const paperItem = resolveCurrentPaperBaseItem();
    if (!paperItem) {
      if (status) {
        setStatus(status, t("Open a paper to start a paper chat"), "error");
      }
      return false;
    }
    setBasePaperItem(paperItem);
    const libraryID = getCurrentLibraryID();
    const paperItemID = Number(paperItem.id || 0);
    if (!libraryID || !Number.isFinite(paperItemID) || paperItemID <= 0) {
      if (status) {
        setStatus(status, t("No active paper for paper chat"), "error");
      }
      return false;
    }
    const session = await resolveWebChatSessionConversation({
      libraryID,
      paperItemID,
    });
    if (!session?.conversationKey) {
      if (status) setStatus(status, t("Failed to create paper chat"), "error");
      return false;
    }
    // The resolve is async: if the user already picked a non-webchat model
    // again, switching now would snap the panel onto the hidden session row
    // and override the conversation they just navigated back to.
    if (!isWebChatMode()) return false;
    ztoolkit.log("LLM: webchat session conversation", {
      libraryID,
      paperItemID,
      conversationKey: session.conversationKey,
      action: session.reused ? "reuse" : "create",
    });
    await switchPaperConversation(session.conversationKey);
    return true;
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
    const renameDisabled = !canRenameHistoryEntry(entry);
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
      if (!item) return;
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
        if (item) {
          clearTransientComposeStateForItem(item.id);
          updateImagePreviewPreservingScroll();
        }
        primeFreshWebChatPaperChipState();
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
        webChatIsolatedConversationKeys.add(key);
        chatHistory.set(key, []);
        loadedConversationKeys.add(key);
        refreshChatPreservingScroll();
        if (status)
          setStatus(status, t("New chat — send a message to start"), "ready");
        return;
      }

      // Reuse an existing blank draft in the active mode, or create one if none
      // exists. Webchat above is the only mode where "+" always requests a new
      // remote conversation.
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
      void runExplicitNewChatAction(async () => {
        await createAndSwitchGlobalConversation(true);
      });
    });
  }

  if (historyNewPaperBtn) {
    historyNewPaperBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (isNoteSession()) return;
      if (historyNewPaperBtn.disabled) return;
      closeHistoryNewMenu();
      void runExplicitNewChatAction(async () => {
        await createAndSwitchPaperConversation(true);
      });
    });
  }

  if (historyUndoBtn) {
    historyUndoBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const latest = pendingDeletionStore.getLatestPending();
      if (!latest) return;
      void pendingDeletionStore.undo(latest.id).then((undone) => {
        if (!status) return;
        if (undone) {
          setStatus(
            status,
            t(
              undone.kind === "turn"
                ? "Turn restored"
                : "Conversation restored",
            ),
            "ready",
          );
          return;
        }
        setStatus(status, t("Failed to restore. Check logs."), "error");
      });
    });
  }

  const renderPendingDeletionToast = () => {
    const latest = pendingDeletionStore.getLatestPending();
    if (!latest || latest.expiresAt <= Date.now()) {
      hideHistoryUndoToast();
      return;
    }
    if (latest.kind === "turn") {
      showTurnUndoToast();
      return;
    }
    showHistoryUndoToast();
  };

  const getSurrenderedDeletionTargets = (): Map<
    string,
    HistorySwitchTarget
  > => {
    let targets = surrenderedDeletionTargetsByBody.get(body);
    if (!targets) {
      targets = new Map<string, HistorySwitchTarget>();
      surrenderedDeletionTargetsByBody.set(body, targets);
    }
    return targets;
  };

  const getConversationDeletionSurfaceSnapshot =
    async (): Promise<ConversationDeletionSurfaceSnapshot | null> => {
      if (!item) return null;
      const activeConversationKey = Number(getConversationKey(item) || 0);
      if (
        !Number.isFinite(activeConversationKey) ||
        activeConversationKey <= 0
      ) {
        return null;
      }
      const registered = await getRegisteredConversationScope(
        Math.floor(activeConversationKey),
      );
      return {
        conversationKey: Math.floor(activeConversationKey),
        instanceID: registered?.instanceID || undefined,
        kind: isGlobalMode() ? "global" : "paper",
        system: getConversationSystem(),
      };
    };

  const leaveConversationForPendingDeletion = async (
    entry: PendingConversationDeletionEntry,
  ): Promise<boolean> => {
    return clearActiveConversationForPendingDeletion(entry.conversationKind, {
      createFreshGlobalConversation: () =>
        createAndSwitchGlobalConversation({
          forceFresh: true,
          excludeConversationKey: entry.conversationKey,
        }),
      createFreshPaperConversation: () =>
        createAndSwitchPaperConversation({
          forceFresh: true,
          excludeConversationKey: entry.conversationKey,
        }),
      log: (message, ...args) => ztoolkit.log(message, ...args),
    });
  };

  const enqueueConversationDeletionEvent =
    createSerializedConversationDeletionEventQueue();

  // Every panel subscribes to the same store, so each one has to decide for
  // itself whether it is the surface showing the doomed chat.
  const handleConversationPendingDeletionEvent = async (
    eventType: PendingDeletionEvent["type"],
    entry: PendingConversationDeletionEntry,
    dropped = false,
  ): Promise<void> => {
    // The mounted item can have changed since this closure was created; the
    // surface snapshot below is only meaningful against the current one.
    syncStateFromDeps();
    const surrendered = getSurrenderedDeletionTargets();
    const action = resolveConversationDeletionSurfaceAction({
      eventType,
      entry,
      surface: await getConversationDeletionSurfaceSnapshot(),
      surrendered: surrendered.has(entry.id),
      dropped,
    });
    if (action.type === "leave") {
      const left = await leaveConversationForPendingDeletion(entry);
      if (left && action.remember) {
        surrendered.set(entry.id, {
          kind: entry.conversationKind,
          conversationKey: entry.conversationKey,
        });
      } else if (!action.remember) {
        // Nothing to come back to; drop the memory rather than leaking it.
        surrendered.delete(entry.id);
      }
      if (!left && status) {
        setStatus(
          status,
          t("Cannot delete active conversation right now"),
          "error",
        );
      }
    } else if (action.type === "restore") {
      surrendered.delete(entry.id);
      const restored = await switchToHistoryTarget({
        kind: entry.conversationKind,
        conversationKey: entry.conversationKey,
      });
      if (!restored && status) {
        setStatus(status, t("Could not load this conversation"), "error");
      }
    } else if (action.type === "forget") {
      surrendered.delete(entry.id);
    }
    await refreshGlobalHistoryHeader();
  };

  const onPendingDeletionEvent = (event: PendingDeletionEvent) => {
    // Self-heal: a body whose window is gone can never render again, and its
    // MutationObserver-based cleanup never fires when the whole window closed.
    try {
      if (body.isConnected === false) {
        disposePendingDeletionSubscriptionForBody(body);
        return;
      }
    } catch {
      disposePendingDeletionSubscriptionForBody(body);
      return;
    }
    renderPendingDeletionToast();
    if (event.entry.kind === "conversation") {
      const entry = event.entry;
      clearPendingDeletionCaches(entry.conversationKey);
      // The store drops the entry before it notifies, so this tombstone is the
      // only thing standing between the deleted key and the seeding paths.
      // Record it before any refresh runs.
      // Only a REAL deletion tombstones the key; a dropped intent leaves the
      // conversation alive and it must stay seedable.
      if (
        (event.type === "completed" || event.type === "finalized") &&
        !event.dropped
      ) {
        if (entry.instanceID) {
          markConversationInstanceRecentlyDeleted(
            entry.conversationKey,
            entry.instanceID,
            Date.now(),
            entry.identityDigest,
          );
        }
      }
      void enqueueConversationDeletionEvent(() =>
        handleConversationPendingDeletionEvent(
          event.type,
          entry,
          Boolean(event.dropped),
        ),
      );
      return;
    }
    invalidateHistorySearchDocument(event.entry.conversationKey);
    if (
      (event.type === "undone" ||
        event.type === "finalized" ||
        event.type === "completed" ||
        event.type === "local-deleted") &&
      item &&
      getConversationKey(item) === event.entry.conversationKey
    ) {
      setActiveEditSession(null);
      refreshChatPreservingScroll();
    }
    void refreshGlobalHistoryHeader();
  };

  disposePendingDeletionSubscriptionForBody(body);
  pendingDeletionSubscriptionsByBody.set(
    body,
    pendingDeletionStore.subscribe(onPendingDeletionEvent),
  );
  renderPendingDeletionToast();
  void pendingDeletionStore.sweepExpired("panel-init");

  // --- Mode chip handler ---
  if (modeChipBtn) {
    modeChipBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item || isNoteSession() || isWebChatMode()) return;
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
                activeGlobalConversationByLibrary.get(libraryID) ||
                  getLastUsedUpstreamGlobalConversationKey(libraryID) ||
                  0,
              );
              if (!isUpstreamGlobalConversationKey(activeKey)) return 0;
              return activeKey === GLOBAL_CONVERSATION_KEY_BASE
                ? buildDefaultUpstreamGlobalConversationKey(libraryID)
                : Math.floor(activeKey);
            })();
      if (targetGlobalKey > 0) {
        void switchGlobalConversation(targetGlobalKey);
      } else {
        void createAndSwitchGlobalConversation();
      }
    });
  }

  if (historyToggleBtn) {
    historyToggleBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
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
      if (!normalizeHistorySearchQuery(historySearchQuery)) {
        cancelHistorySearchDebounce();
        void refreshHistorySearchMenu();
        return;
      }
      scheduleHistorySearchMenuRefresh();
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
        closeHistoryMenu();
        historySearchPopupController.open();
        return;
      }

      // Rename button inside a history item
      const renameBtn = target.closest(
        ".llm-history-item-rename",
      ) as HTMLElement | null;
      if (renameBtn) {
        const row = renameBtn.closest(
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
        if (!entry) return;
        void renameHistoryEntry(entry);
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
        let loaded = true;
        if (entry) {
          loaded = await switchToHistoryEntry(entry);
        } else if (historyKind === "paper") {
          loaded = await switchPaperConversation(parsedConversationKey);
        } else {
          loaded = await switchGlobalConversation(parsedConversationKey);
        }
        if (loaded && status) {
          setStatus(status, t("Conversation loaded"), "ready");
        }
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
    ensureWebChatSessionPaperConversation: async () => {
      syncStateFromDeps();
      return ensureWebChatSessionPaperConversation();
    },
    runExplicitNewChatAction,
    queueCurrentConversationDeletion,
    queueTurnDeletion,
    forkConversationFromTurn,
    isConversationPendingDeletion: (conversationKey: number) =>
      pendingDeletionStore.isConversationPendingDeletion(conversationKey),
    resetHistorySearchState,
    hasPendingTurnDeletionForConversation: (conversationKey: number) =>
      pendingDeletionStore.getPendingTurnsForConversation(conversationKey)
        .length > 0,
    searchConversationHistoryForWorkflowTest: async (query: string) => {
      syncStateFromDeps();
      const libraryID = getCurrentLibraryID();
      if (!libraryID) {
        return {
          entries: [] as Array<{ conversationKey: number; title: string }>,
          previews: [] as string[],
        };
      }
      let result: {
        entries: ConversationHistoryEntry[];
        resultsByKey: Map<number, HistorySearchResult>;
      };
      try {
        result = await searchIndexedConversationHistory(libraryID, query);
      } catch {
        result = await searchLoadedConversationHistory(libraryID, query);
      }
      return {
        entries: result.entries.map((entry) => ({
          conversationKey: entry.conversationKey,
          title: entry.title || "",
        })),
        previews: Array.from(result.resultsByKey.values()).map(
          (searchResult) => searchResult.previewText,
        ),
      };
    },
  };
}

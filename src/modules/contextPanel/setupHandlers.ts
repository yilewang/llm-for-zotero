import { createElement } from "../../utils/domHelpers";
import { t } from "../../utils/i18n";
import { getAllSkills } from "../../agent/skills";
import type { AgentSkill } from "../../agent/skills/skillLoader";
import type { RuntimeModelEntry } from "../../utils/modelProviders";
import type { ConversationSystem } from "../../shared/types";
import {
  getLastUsedModelEntryId,
  getModelEntryById,
} from "../../utils/modelProviders";
import {
  buildQueuedFollowUpThreadKey,
  enqueueQueuedFollowUp,
  getQueuedFollowUps,
  registerQueuedFollowUpBody,
  removeQueuedFollowUp,
  scheduleQueuedFollowUpDrainForThread,
  SCHEDULE_QUEUED_FOLLOW_UP_DRAIN_PROPERTY,
  SCHEDULE_QUEUED_FOLLOW_UP_THREAD_DRAIN_PROPERTY,
  setQueuedFollowUpBodySyncCallback,
  shiftQueuedFollowUp,
  unregisterQueuedFollowUpBody,
} from "./queuedFollowUps";
import {
  config,
  AUTO_SCROLL_BOTTOM_THRESHOLD,
  MAX_SELECTED_IMAGES,
  MAX_SELECTED_PAPER_CONTEXTS,
  PERSISTED_HISTORY_LIMIT,
  formatFigureCountLabel,
  formatFileCountLabel,
  GLOBAL_HISTORY_LIMIT,
  isUpstreamGlobalConversationKey,
  PREFERENCES_PANE_ID,
} from "./constants";
import {
  selectedModelCache,
  selectedReasoningCache,
  selectedReasoningProviderCache,
  selectedRuntimeModeCache,
  selectedImageCache,
  selectedFileAttachmentCache,
  selectedImagePreviewExpandedCache,
  selectedImagePreviewActiveIndexCache,
  selectedFilePreviewExpandedCache,
  selectedPaperContextCache,
  selectedOtherRefContextCache,
  selectedCollectionContextCache,
  paperContextModeOverrides,
  selectedPaperPreviewExpandedCache,
  pinnedSelectedTextKeys,
  pinnedImageKeys,
  pinnedFileKeys,
  setCancelledRequestId,
  setPendingRequestId,
  getPendingRequestId,
  getAbortController,
  setAbortController,
  isRequestPending,
  responseMenuTarget,
  setResponseMenuTarget,
  promptMenuTarget,
  setPromptMenuTarget,
  chatHistory,
  loadedConversationKeys,
  currentRequestId,
  activeConversationModeByLibrary,
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
  draftInputCache,
  activeContextPanels,
  activeContextPanelRawItems,
  activeContextPanelStateSync,
  inlineEditTarget,
  setInlineEditTarget,
  inlineEditCleanup,
  setInlineEditCleanup,
  setInlineEditInputSection,
  setInlineEditSavedDraft,
  pdfTextCache,
  addAutoLockedGlobalConversationKey,
  removeAutoLockedGlobalConversationKey,
  isAutoLockedGlobalConversation,
} from "./state";
import {
  sanitizeText,
  setStatus,
  buildQuestionWithSelectedTextContexts,
  buildModelPromptWithFileContext,
  resolvePromptText,
  getAttachmentTypeLabel,
  normalizeSelectedTextSource,
} from "./textUtils";
import {
  formatActionLabel,
  resolveActionCompletionStatusText,
} from "./actionStatusText";
import {
  normalizeAttachmentContentHash,
  normalizeSelectedTextPaperContexts,
} from "./normalizers";
import {
  positionMenuBelowButton,
  positionMenuAtPointer,
} from "./menuPositioning";
import {
  getAvailableModelEntries,
  getStringPref,
  getAgentModeEnabled,
  getClaudeCodeModeEnabled,
  getSelectedModelEntryForItem,
  applyPanelFontScale,
  getAdvancedModelParamsForEntry,
  setSelectedModelEntryForItem,
  getLastUsedReasoningLevel,
  getLastUsedReasoningLevelForProvider,
  setLastUsedReasoningLevel,
  setLastUsedReasoningLevelForProvider,
  getLastUsedPaperConversationKey,
  setLastUsedPaperConversationKey,
  removeLastUsedPaperConversationKey,
  getLockedGlobalConversationKey,
  setLockedGlobalConversationKey,
  buildPaperStateKey,
} from "./prefHelpers";
import {
  sendQuestion,
  refreshChat,
  syncUserContextAlignmentWidths,
  getConversationKey,
  ensureConversationLoaded,
  persistChatScrollSnapshot,
  isScrollUpdateSuspended,
  withScrollGuard,
  copyTextToClipboard,
  refreshConversationPanels,
  detectReasoningProvider,
  getReasoningOptions,
  getSelectedReasoningForItem,
  retryLatestAssistantResponse,
  editLatestUserMessageAndRetry,
  editUserTurnAndRetry,
  findLatestRetryPair,
  type EditLatestTurnMarker,
} from "./chat";
import {
  getActiveContextAttachmentFromTabs,
  addSelectedTextContext,
  appendSelectedTextContextForItem,
  applySelectedTextPreview,
  formatSelectedTextContextPageLabel,
  getSelectedTextContextEntries,
  getSelectedTextContexts,
  getSelectedTextExpandedIndex,
  isNoteContextExpanded,
  refreshNoteChipPreview,
  refreshActiveNoteChipPreview,
  resolveContextSourceItem,
  setNoteContextExpanded,
  setSelectedTextContextEntries,
  setSelectedTextExpandedIndex,
} from "./contextResolution";
import {
  resolvePaperContextRefFromAttachment,
  resolvePaperContextRefFromItem,
} from "./paperAttribution";
import {
  filterManualPaperContextsAgainstAutoLoaded,
  isSamePaperContextRef,
  resolveRuntimeModeForConversation,
} from "./modeBehavior";
import {
  resolveSlashActionChatMode,
  shouldRenderDynamicSlashMenu,
  shouldRenderSkillSlashMenu,
} from "./slashMenuBehavior";
import { buildPaperKey } from "./pdfContext";
import {
  getPaperModeOverride,
  setPaperModeOverride,
  clearPaperModeOverrides,
  isPaperContextFullTextMode,
  getPaperContentSourceOverride,
  setPaperContentSourceOverride,
  clearPaperContentSourceOverrides,
  getNextContentSourceMode,
  clearSelectedPaperState,
  clearAllRefContextState,
} from "./contexts/paperContextState";
import {
  clearSelectedImageState as clearSelectedImageState_,
  retainPinnedImageState as retainPinnedImageState_,
} from "./contexts/imageContextState";
import {
  clearSelectedFileState as clearSelectedFileState_,
  retainPinnedFileState as retainPinnedFileState_,
} from "./contexts/fileContextState";
import {
  clearSelectedTextState as clearSelectedTextState_,
  retainPinnedTextState as retainPinnedTextState_,
} from "./contexts/textContextState";
import { optimizeImageDataUrl } from "./screenshot";
import { readNoteSnapshot } from "./notes";
import {
  persistAttachmentBlob,
  extractManagedBlobHash,
  isManagedBlobPath,
  removeAttachmentFile,
  removeConversationAttachmentFiles,
} from "./attachmentStorage";
import { clearConversationSummary as clearConversationSummaryFromCache } from "./conversationSummaryCache";
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
  touchPaperConversationTitle,
  touchGlobalConversationTitle,
} from "../../utils/chatStore";
import {
  ATTACHMENT_GC_MIN_AGE_MS,
  clearOwnerAttachmentRefs,
  collectAndDeleteUnreferencedBlobs,
  replaceOwnerAttachmentRefs,
} from "../../utils/attachmentRefStore";
import type {
  Message,
  ChatRuntimeMode,
  ReasoningLevelSelection,
  ReasoningOption,
  AdvancedModelParams,
  PaperContextRef,
  OtherContextRef,
  CollectionContextRef,
  PaperContextSendMode,
  PaperContentSourceMode,
  SelectedTextContext,
} from "./types";
import type { ReasoningLevel as LLMReasoningLevel } from "../../utils/llmClient";
import type { ReasoningConfig as LLMReasoningConfig } from "../../utils/llmClient";
import {
  browseAllItemCandidates,
  searchAllItemCandidates,
  searchCollectionCandidates,
  ZOTERO_NOTE_CONTENT_TYPE,
  normalizePaperSearchText,
  parsePaperSearchSlashToken,
  parseAtSearchToken,
  type PaperBrowseCollectionCandidate,
  type PaperSearchAttachmentCandidate,
  type PaperSearchGroupCandidate,
  type PaperSearchSlashToken,
} from "./paperSearch";
import {
  resolvePaperScopedCommandInput,
  type PaperScopedActionCollectionCandidate,
  type PaperScopedActionProfile,
} from "./paperScopeCommand";
import {
  getAgentApi,
  getCoreAgentRuntime,
  initAgentSubsystem,
} from "../../agent/index";
import type { ActionRequestContext } from "../../agent/actions";
import { renderPendingActionCard } from "./agentTrace/render";
import type {
  AgentPendingAction,
  AgentConfirmationResolution,
} from "../../agent/types";
import {
  createGlobalPortalItem,
  createPaperPortalItem,
  isGlobalPortalItem,
  resolveActiveNoteSession,
  resolveConversationSystemForItem,
  resolveDisplayConversationKind,
  resolveConversationBaseItem,
  resolveInitialPanelItemState,
  resolveActiveLibraryID,
  resolvePreferredConversationSystem,
  resolveNoteConversationSystemSwitch,
  resolveShortcutMode,
} from "./portalScope";
import { getPanelDomRefs } from "./setupHandlers/domRefs";
import type { SetupHandlersContext } from "./setupHandlers/types";
import { observeElementDisconnected } from "./setupHandlers/lifecycle";
import {
  MODEL_MENU_OPEN_CLASS,
  REASONING_MENU_OPEN_CLASS,
  RETRY_MODEL_MENU_OPEN_CLASS,
  SLASH_MENU_OPEN_CLASS,
  isFloatingMenuOpen,
  positionFloatingMenu,
  setFloatingMenuOpen,
} from "./setupHandlers/controllers/menuController";
import { createActionLayoutController } from "./setupHandlers/controllers/actionLayoutController";
import {
  getReasoningLevelDisplayLabel,
  isReasoningDisplayLabelActive,
  getScreenshotDisabledHint,
  isScreenshotUnsupportedModel,
  getModelPdfSupport,
} from "./setupHandlers/controllers/modelReasoningController";
import {
  GLOBAL_HISTORY_UNDO_WINDOW_MS,
  type ConversationHistoryEntry,
  type HistorySwitchTarget,
  type PendingHistoryDeletion,
  formatGlobalHistoryTimestamp,
  formatHistoryRowDisplayTitle,
  groupHistoryEntriesByDay,
  normalizeConversationTitleSeed,
  normalizeHistoryTitle,
} from "./setupHandlers/controllers/conversationHistoryController";
import {
  appendHistorySearchHighlightedText,
  buildHistorySearchResults,
  createHistorySearchDocument,
  normalizeHistorySearchQuery,
  tokenizeHistorySearchQuery,
  type HistorySearchDocument,
  type HistorySearchResult,
} from "./setupHandlers/controllers/historySearchController";
import {
  formatPaperContextChipLabel,
  formatPaperContextChipTitle,
  normalizePaperContextEntries,
  resolvePaperContextDisplayMetadata,
  resolveAttachmentTitle,
} from "./setupHandlers/controllers/composeContextController";
import {
  isPinnedFile,
  isPinnedImage,
  prunePinnedFileKeys,
  prunePinnedImageKeys,
  removePinnedFile,
  removePinnedImage,
  removePinnedSelectedText,
  togglePinnedFile,
  togglePinnedImage,
  togglePinnedSelectedText,
} from "./setupHandlers/controllers/pinnedContextController";
import {
  createFileIntakeController,
  extractFilesFromClipboard,
  isFileDragEvent,
  isZoteroItemDragEvent,
  parseZoteroItemDragData,
} from "./setupHandlers/controllers/fileIntakeController";
import { createSendFlowController } from "./setupHandlers/controllers/sendFlowController";
import { createClearConversationController } from "./setupHandlers/controllers/clearConversationController";
import { cancelVisiblePendingConfirmationCards } from "./setupHandlers/controllers/cancelPendingConfirmationController";
import { buildInlineEditRetryContextSnapshot } from "./setupHandlers/controllers/inlineEditRetryController";
import { attachAssistantSelectionPopup } from "./setupHandlers/controllers/assistantSelectionPopupController";
import { attachMenuActionController } from "./setupHandlers/controllers/menuActionController";
import { createPdfPaperAttachmentResolver } from "./setupHandlers/controllers/pdfPaperAttachmentResolver";
import { resolvePdfModeModelInputs } from "./setupHandlers/controllers/pdfPaperModelInputController";
import { createWebChatHistoryController } from "./setupHandlers/controllers/webChatHistoryController";
import { createHistoryLifecycleController } from "./setupHandlers/controllers/historyLifecycleController";
import { attachComposePreviewInteractionController } from "./setupHandlers/controllers/composePreviewInteractionController";
import { attachFontScaleShortcutController } from "./setupHandlers/controllers/fontScaleShortcutController";
import { attachComposeCaptureController } from "./setupHandlers/controllers/composeCaptureController";
import { attachFloatingMenuInteractionController } from "./setupHandlers/controllers/floatingMenuInteractionController";
import { createPaperPickerController } from "./setupHandlers/controllers/paperPickerController";
import { createActionCommandController } from "./setupHandlers/controllers/actionCommandController";
import {
  createCoalescedFrameScheduler,
  getOrCreateKeyedInFlightTask,
} from "./setupHandlers/controllers/uiSchedulingController";
import { clearAllAgentToolCaches } from "../../agent/tools";
import { clearAgentMemory } from "../../agent/store/conversationMemory";
import { clearAgentTranscript } from "../../agent/store/transcriptStore";
import { clearPersistedAgentEvidence } from "../../agent/context/cacheManagement";
import { clearPersistedAgentCoverage } from "../../agent/context/coverageLedger";
import { clearAgentResourceLifecycleState } from "../../agent/context/resourceLifecycle";
import { renderShortcuts } from "./shortcuts";
import { loadConversationHistoryScope } from "./historyLoader";
import { loadClaudeConversationHistoryScope } from "../../claudeCode/historyLoader";
import { loadCodexConversationHistoryScope } from "../../codexAppServer/historyLoader";
import {
  buildClaudeScope,
  getClaudeRuntimeModelEntries,
  getSelectedClaudeRuntimeEntry,
  invalidateAllClaudeHotRuntimes,
  invalidateClaudeConversationSession,
  listClaudeEfforts,
  rememberClaudeConversationSelection,
  resolveRememberedClaudeConversationKey,
  refreshClaudeSlashCommands,
  touchClaudeConversation,
} from "../../claudeCode/runtime";
import {
  getClaudeReasoningModePref,
  getConversationSystemPref,
  getLastUsedClaudeGlobalConversationKey,
  setClaudeCodeModeEnabled,
  setConversationSystemPref,
  getLastUsedClaudePaperConversationKey,
  removeLastUsedClaudeGlobalConversationKey,
  removeLastUsedClaudePaperConversationKey,
  setClaudeReasoningModePref,
  setClaudeRuntimeModelPref,
  setLastUsedClaudeConversationMode,
} from "../../claudeCode/prefs";
import {
  getCodexReasoningModePref,
  getCodexRuntimeModelPref,
  getLastUsedCodexConversationMode,
  getLastUsedCodexGlobalConversationKey,
  getLastUsedCodexPaperConversationKey,
  isCodexAppServerModeEnabled,
  removeLastUsedCodexGlobalConversationKey,
  removeLastUsedCodexPaperConversationKey,
  setLastUsedCodexGlobalConversationKey,
  setLastUsedCodexPaperConversationKey,
  setLastUsedCodexConversationMode,
  setCodexReasoningModePref,
  setCodexRuntimeModelPref,
} from "../../codexAppServer/prefs";
import { getConfiguredCodexAppServerBinaryPath } from "../../codexAppServer/binaryPath";
import {
  activeClaudeConversationModeByLibrary,
  activeClaudeGlobalConversationByLibrary,
  activeClaudePaperConversationByPaper,
  buildClaudeLibraryStateKey,
  buildClaudePaperStateKey,
} from "../../claudeCode/state";
import {
  activeCodexConversationModeByLibrary,
  activeCodexGlobalConversationByLibrary,
  activeCodexPaperConversationByPaper,
  buildCodexLibraryStateKey,
  buildCodexPaperStateKey,
} from "../../codexAppServer/state";
import {
  retainClaudeRuntimeForBody,
  releaseClaudeRuntimeForBody,
} from "../../claudeCode/runtimeRetention";
import { isClaudePaperPortalItem } from "../../claudeCode/portal";
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
  touchClaudeConversationTitle,
  upsertClaudeConversationSummary,
} from "../../claudeCode/store";
import {
  createClaudeGlobalPortalItem,
  createClaudePaperPortalItem,
} from "../../claudeCode/portal";
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
  touchCodexConversationTitle,
  upsertCodexConversationSummary,
} from "../../codexAppServer/store";
import {
  createCodexGlobalPortalItem,
  createCodexPaperPortalItem,
} from "../../codexAppServer/portal";

setQueuedFollowUpBodySyncCallback((body) => {
  try {
    activeContextPanelStateSync.get(body)?.();
  } catch (_err) {
    void _err;
  }
});

/** Monotonic counter incremented every time setupHandlers rebuilds a panel. */
let setupHandlersGeneration = 0;

export type SetupHandlersHooks = {
  onConversationHistoryChanged?: () => void;
  onWebChatModeChanged?: (isWebChat: boolean) => void;
  /** Called by standalone to clear force-new-chat intent before loading a session. */
  clearWebChatNewChatIntent?: () => void;
  /** Called by standalone to resolve the currently selected model consistently. */
  getCurrentModelName?: () => string | null;
};

export function setupHandlers(
  body: Element,
  initialItem?: Zotero.Item | null,
  hooks?: SetupHandlersHooks,
) {
  const existingPanelRoot = body.querySelector(
    "#llm-main",
  ) as HTMLElement | null;
  const preferredConversationSystem =
    existingPanelRoot?.dataset?.conversationSystem === "claude_code"
      ? "claude_code"
      : existingPanelRoot?.dataset?.conversationSystem === "codex"
        ? "codex"
        : existingPanelRoot?.dataset?.conversationSystem === "upstream"
          ? "upstream"
          : resolveConversationSystemForItem(initialItem);
  const resolvedInitialState = resolveInitialPanelItemState(initialItem, {
    conversationSystem: preferredConversationSystem,
  });
  const rawPanelItem =
    activeContextPanelRawItems.get(body) || initialItem || null;
  let item = resolvedInitialState.item;
  let basePaperItem =
    resolvedInitialState.basePaperItem ||
    resolveConversationBaseItem(rawPanelItem);
  const buildPaperStateKey = (libraryID: number, paperItemID: number): string =>
    `${Math.floor(libraryID)}:${Math.floor(paperItemID)}`;
  const resolveLibraryIdFromItem = (
    targetItem: Zotero.Item | null | undefined,
  ): number => {
    const parsed = Number(targetItem?.libraryID);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
    return resolveActiveLibraryID() || 0;
  };

  const panelRefs = getPanelDomRefs(body);
  const {
    inputBox,
    inputSection,
    sendBtn,
    cancelBtn,
    modelBtn,
    modelSlot,
    modelMenu,
    reasoningBtn,
    runtimeModeBtn,
    reasoningSlot,
    reasoningMenu,
    actionsRow,
    actionsLeft,
    actionsRight,
    popoutBtn,
    settingsBtn,
    exportBtn,
    clearBtn,
    titleStatic,
    historyBar,
    historyNewBtn,
    historyNewMenu,
    historyNewOpenBtn,
    historyNewPaperBtn,
    historyToggleBtn,
    historyModeIndicator,
    historyMenu,
    modeCapsule,
    modeChipBtn,
    historyRowMenu,
    historyRowRenameBtn,
    historyUndo,
    historyUndoText,
    historyUndoBtn,
    claudeSystemToggleBtn,
    claudeSystemToggleIcon,
    selectTextBtn,
    screenshotBtn,
    uploadBtn,
    uploadInput,
    slashMenu,
    slashUploadOption,
    slashReferenceOption,
    slashPdfPageOption,
    slashPdfMultiplePagesOption,
    imagePreview,
    selectedContextList,
    previewStrip,
    previewExpanded,
    previewSelected,
    previewSelectedImg,
    previewMeta,
    removeImgBtn,
    filePreview,
    filePreviewMeta,
    filePreviewExpanded,
    filePreviewList,
    filePreviewClear,
    paperPreview,
    paperPreviewList,
    paperPicker,
    paperPickerList,
    actionPicker,
    actionPickerList,
    actionHitlPanel,
    queueBar,
    responseMenu,
    responseMenuCopyBtn,
    responseMenuNoteBtn,
    responseMenuDeleteBtn,
    promptMenu,
    promptMenuDeleteBtn,
    exportMenu,
    exportMenuCopyBtn,
    exportMenuNoteBtn,
    retryModelMenu,
    status,
    chatBox,
    panelRoot,
  } = panelRefs;

  if (!inputBox || !sendBtn) {
    ztoolkit.log("LLM: Could not find input or send button");
    return;
  }

  if (!panelRoot) {
    ztoolkit.log("LLM: Could not find panel root");
    return;
  }

  // Guard: skip re-wiring if handlers were already attached to this exact
  // panelRoot element.  buildUI() creates a fresh panelRoot each time, so
  // the stamp is only present when setupHandlers is called twice on the
  // same DOM tree without an intervening rebuild.
  const thisGen = String(++setupHandlersGeneration);
  if (panelRoot.dataset.handlersAttached) {
    return;
  }
  panelRoot.dataset.handlersAttached = thisGen;

  activeContextPanels.set(body, () => item);
  let isWebChatModeActive = () => panelRoot.dataset.webchatMode === "true";
  const getQueuedFollowUpThreadKey = (): string | null =>
    buildQueuedFollowUpThreadKey({
      conversationSystem: currentConversationSystem,
      conversationKey: item ? getConversationKey(item) : null,
      webChatActive: isWebChatModeActive(),
    });
  const queuedFollowUpBody = body as Element & {
    __llmQueuedFollowUpRegisteredThreadKey?: string | null;
  };
  let registeredQueuedFollowUpThreadKey: string | null =
    queuedFollowUpBody.__llmQueuedFollowUpRegisteredThreadKey || null;
  const syncQueuedFollowUpRegistration = () => {
    const nextThreadKey = getQueuedFollowUpThreadKey();
    if (registeredQueuedFollowUpThreadKey === nextThreadKey) return;
    unregisterQueuedFollowUpBody(registeredQueuedFollowUpThreadKey, body);
    registeredQueuedFollowUpThreadKey = nextThreadKey;
    queuedFollowUpBody.__llmQueuedFollowUpRegisteredThreadKey =
      registeredQueuedFollowUpThreadKey;
    registerQueuedFollowUpBody(registeredQueuedFollowUpThreadKey, body);
  };

  // Disconnect previous ResizeObservers to prevent accumulation across
  // successive setupHandlers calls (each call creates fresh observers).
  const prevObservers = (body as any).__llmResizeObservers as
    | ResizeObserver[]
    | undefined;
  if (prevObservers) {
    for (const obs of prevObservers) obs.disconnect();
    delete (body as any).__llmResizeObservers;
  }

  let renderQueuedFollowUpInputs: () => void = () => {};
  let scheduleQueuedFollowUpDrain: () => void = () => {};
  let isQueuedFollowUpSendAvailable: () => boolean = () => false;
  let queueFollowUpInput: (text: string) => void = () => {};

  const syncRequestUiForCurrentConversation = () => {
    const activeConversationKey = item ? getConversationKey(item) : null;
    const isWebChatActive = isWebChatModeActive();
    const isCurrentConversationPending =
      activeConversationKey !== null &&
      Number.isFinite(activeConversationKey) &&
      isRequestPending(activeConversationKey);
    if (sendBtn) {
      sendBtn.style.display = isCurrentConversationPending ? "none" : "";
      sendBtn.disabled = !item;
      sendBtn.title = "Send";
    }
    if (cancelBtn) {
      cancelBtn.style.display = isCurrentConversationPending ? "" : "none";
    }
    if (inputBox) {
      inputBox.disabled =
        !item || (isCurrentConversationPending && isWebChatActive);
    }
    renderQueuedFollowUpInputs();
  };

  // buildUI() wipes body.textContent whenever onAsyncRender fires (item
  // navigation), which destroys the cancel/send button DOM mid-stream.
  // Re-apply the current conversation's request state immediately so a panel
  // switch never inherits stale send/cancel UI from another conversation.
  syncRequestUiForCurrentConversation();

  const panelDoc = body.ownerDocument;
  if (!panelDoc) {
    ztoolkit.log("LLM: Could not find panel document");
    return;
  }
  const panelWin = panelDoc?.defaultView || null;
  const ElementCtor = panelDoc.defaultView?.Element;
  const isElementNode = (value: unknown): value is Element =>
    Boolean(ElementCtor && value instanceof ElementCtor);
  const headerTop = body.querySelector(
    ".llm-header-top",
  ) as HTMLDivElement | null;
  panelRoot.tabIndex = 0;
  applyPanelFontScale(panelRoot);

  const resolveCurrentNoteSession = () => resolveActiveNoteSession(item);
  const isNoteSession = () => Boolean(resolveCurrentNoteSession());
  const notifyConversationHistoryChanged = () => {
    try {
      hooks?.onConversationHistoryChanged?.();
    } catch (err) {
      ztoolkit.log("LLM: standalone history hook failed", err);
    }
  };
  const isGlobalMode = () => resolveDisplayConversationKind(item) === "global";
  const isPaperMode = () => resolveDisplayConversationKind(item) === "paper";
  const initialConversationSystem: ConversationSystem =
    panelRoot.dataset.conversationSystem === "claude_code"
      ? "claude_code"
      : panelRoot.dataset.conversationSystem === "codex"
        ? "codex"
        : resolvePreferredConversationSystem({ item });
  let currentConversationSystem: ConversationSystem =
    resolvePreferredConversationSystem({
      item,
      preferredSystem: initialConversationSystem,
    });
  const getConversationSystem = (): ConversationSystem =>
    currentConversationSystem;
  const isClaudeConversationSystem = () =>
    getConversationSystem() === "claude_code";
  const isCodexConversationSystem = () => getConversationSystem() === "codex";
  const isRuntimeConversationSystem = () =>
    isClaudeConversationSystem() || isCodexConversationSystem();
  const shouldRenderDynamicSlashMenuForCurrentConversation = () =>
    shouldRenderDynamicSlashMenu({
      itemPresent: Boolean(item),
      isWebChat: isWebChatModeActive(),
      runtimeMode: getCurrentRuntimeMode(),
      conversationSystem: getConversationSystem(),
    });
  const shouldRenderSkillSlashMenuForCurrentConversation = () =>
    shouldRenderSkillSlashMenu({
      itemPresent: Boolean(item),
      isWebChat: isWebChatModeActive(),
      runtimeMode: getCurrentRuntimeMode(),
      conversationSystem: getConversationSystem(),
    });
  panelRoot.dataset.conversationSystem = currentConversationSystem;
  syncQueuedFollowUpRegistration();
  const isClaudeModeAvailable = () => getClaudeCodeModeEnabled();
  const isCodexModeAvailable = () => isCodexAppServerModeEnabled();
  const getCodexRuntimeModelEntries = (): RuntimeModelEntry[] => {
    const model = getCodexRuntimeModelPref();
    return [
      {
        entryId: `codex_app_server::${model}`,
        groupId: "codex_app_server",
        model,
        apiBase: getConfiguredCodexAppServerBinaryPath(),
        apiKey: "",
        authMode: "codex_app_server",
        providerProtocol: "codex_responses",
        providerLabel: "Codex",
        providerOrder: -1,
        displayModelLabel: model,
        advanced: {
          temperature: 0.3,
          maxTokens: 4096,
        },
      },
    ];
  };
  const getSelectedCodexRuntimeEntry = (): RuntimeModelEntry =>
    getCodexRuntimeModelEntries()[0]!;
  const getPreferredTargetSystem = (): ConversationSystem => {
    if (isNoteSession()) {
      return isCodexModeAvailable() ? "codex" : "upstream";
    }
    const preferred = getConversationSystemPref();
    if (preferred === "codex" && isCodexModeAvailable()) return "codex";
    if (preferred === "claude_code" && isClaudeModeAvailable())
      return "claude_code";
    if (isCodexModeAvailable()) return "codex";
    if (isClaudeModeAvailable()) return "claude_code";
    return "upstream";
  };
  const getCurrentLibraryID = (): number => {
    const fromItem =
      item && Number.isFinite(item.libraryID) && item.libraryID > 0
        ? Math.floor(item.libraryID)
        : 0;
    if (fromItem > 0) return fromItem;
    return resolveActiveLibraryID() || 0;
  };
  const getCurrentRuntimeMode = (): ChatRuntimeMode => {
    if (!item) return "chat";
    const key = getConversationKey(item);
    const noteSession = resolveCurrentNoteSession();
    return resolveRuntimeModeForConversation({
      cachedMode: selectedRuntimeModeCache.get(key) || null,
      isRuntimeConversationSystem: isRuntimeConversationSystem(),
      runtimeConversationSystem: getConversationSystem(),
      isWebChat: isWebChatModeActive(),
      agentModeEnabled: getAgentModeEnabled(),
      displayConversationKind: resolveDisplayConversationKind(item),
      noteKind: noteSession?.noteKind || null,
    });
  };
  const updateRuntimeModeButton = () => {
    if (!runtimeModeBtn) return;
    const indicator = runtimeModeBtn.querySelector(
      ".llm-agent-toggle-indicator",
    ) as HTMLSpanElement | null;
    if (isRuntimeConversationSystem()) {
      const labelText = isCodexConversationSystem() ? "Codex" : "Claude Code";
      const staticMode: ChatRuntimeMode = isCodexConversationSystem()
        ? "chat"
        : "agent";
      runtimeModeBtn.style.display = "";
      const label = runtimeModeBtn.querySelector(
        ".llm-agent-toggle-label",
      ) as HTMLSpanElement | null;
      if (label) {
        label.textContent = labelText;
      }
      runtimeModeBtn.classList.remove("llm-agent-toggle-enabled");
      runtimeModeBtn.classList.add("llm-runtime-mode-static");
      runtimeModeBtn.dataset.mode = staticMode;
      runtimeModeBtn.dataset.system = getConversationSystem();
      runtimeModeBtn.title = isCodexConversationSystem()
        ? "Codex native runtime"
        : labelText;
      runtimeModeBtn.setAttribute(
        "aria-label",
        isCodexConversationSystem() ? "Codex native runtime" : labelText,
      );
      runtimeModeBtn.setAttribute("aria-pressed", "false");
      runtimeModeBtn.setAttribute("aria-disabled", "true");
      runtimeModeBtn.disabled = true;
      if (indicator) indicator.style.display = "none";
      panelRoot.dataset.runtimeMode = staticMode;
      return;
    }
    runtimeModeBtn.classList.remove("llm-runtime-mode-static");
    delete runtimeModeBtn.dataset.system;
    runtimeModeBtn.removeAttribute("aria-disabled");
    runtimeModeBtn.disabled = false;
    if (indicator) indicator.style.display = "";
    const agentFeatureEnabled = getAgentModeEnabled();
    // [webchat] Agent mode not available in webchat — hide toggle
    let webChatActive = false;
    try {
      webChatActive = isWebChatModeActive();
    } catch {
      /* not ready */
    }
    // Hide the entire toggle when agent feature is disabled or in webchat mode.
    const shouldHide = !agentFeatureEnabled || webChatActive;
    runtimeModeBtn.style.display = shouldHide ? "none" : "";
    if (shouldHide) {
      panelRoot.dataset.runtimeMode = "chat";
      return;
    }
    const mode = getCurrentRuntimeMode();
    const enabled = mode === "agent";
    const label = runtimeModeBtn.querySelector(
      ".llm-agent-toggle-label",
    ) as HTMLSpanElement | null;
    if (label) {
      label.textContent = t("Agent (beta)");
    }
    runtimeModeBtn.classList.toggle("llm-agent-toggle-enabled", enabled);
    runtimeModeBtn.dataset.mode = mode;
    runtimeModeBtn.title = enabled
      ? t("Agent mode ON. Click to switch to Chat mode")
      : t("Agent mode OFF. Click to switch to Agent mode");
    runtimeModeBtn.setAttribute(
      "aria-label",
      mode === "agent" ? t("Switch to Chat mode") : t("Switch to Agent mode"),
    );
    runtimeModeBtn.setAttribute("aria-pressed", enabled ? "true" : "false");
    panelRoot.dataset.runtimeMode = mode;
  };
  const setCurrentRuntimeMode = (mode: ChatRuntimeMode) => {
    if (!item || isRuntimeConversationSystem()) {
      updateRuntimeModeButton();
      return;
    }
    selectedRuntimeModeCache.set(getConversationKey(item), mode);
    updateRuntimeModeButton();
  };
  const updateClaudeSystemToggle = () => {
    if (!claudeSystemToggleBtn || !claudeSystemToggleIcon) return;
    const targetSystem = getPreferredTargetSystem();
    const webChatActive = isWebChatModeActive();
    const available =
      !webChatActive &&
      (isNoteSession()
        ? targetSystem === "codex" || isCodexConversationSystem()
        : isClaudeModeAvailable() || isCodexModeAvailable());
    claudeSystemToggleBtn.style.display = available ? "inline-flex" : "none";
    if (!available) return;
    const active = isRuntimeConversationSystem();
    const inactiveLabel =
      targetSystem === "codex"
        ? "Switch to Codex mode"
        : "Switch to Claude Code mode";
    const activeLabel = "Switch to upstream mode";
    claudeSystemToggleBtn.dataset.active = active ? "true" : "false";
    claudeSystemToggleBtn.setAttribute(
      "aria-pressed",
      active ? "true" : "false",
    );
    claudeSystemToggleBtn.title = active ? activeLabel : inactiveLabel;
    claudeSystemToggleBtn.setAttribute(
      "aria-label",
      active ? activeLabel : inactiveLabel,
    );
    const iconSystem = active ? getConversationSystem() : targetSystem;
    if (iconSystem === "codex") {
      claudeSystemToggleIcon.classList.add("llm-codex-system-toggle-icon");
      claudeSystemToggleIcon.textContent = "";
      claudeSystemToggleIcon.setAttribute("aria-hidden", "true");
      return;
    }
    claudeSystemToggleIcon.classList.remove("llm-codex-system-toggle-icon");
    claudeSystemToggleIcon.setAttribute("aria-hidden", "true");
    claudeSystemToggleIcon.innerHTML = active
      ? `<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><path clip-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" fill="#D97757" fill-rule="evenodd"></path></svg>`
      : `<svg fill="currentColor" fill-rule="evenodd" height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><path clip-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"></path></svg>`;
  };
  let claudeWarmupInFlight: Promise<void> | null = null;
  const warmClaudeModeCaches = () => {
    if (!isClaudeModeAvailable() || isNoteSession()) return;
    if (claudeWarmupInFlight) return;
    const coreRuntime = getCoreAgentRuntime();
    claudeWarmupInFlight = Promise.allSettled([
      refreshClaudeSlashCommands(coreRuntime, false),
      listClaudeEfforts(coreRuntime, getSelectedClaudeRuntimeEntry().model),
    ])
      .finally(() => {
        claudeWarmupInFlight = null;
      })
      .then(() => undefined);
  };
  let resetComposePreviewUI = () => {};
  let updateModelButton = () => {};
  let updateReasoningButton = () => {};
  let getSelectedModelInfo: () => {
    selectedEntryId: string;
    selectedEntry: RuntimeModelEntry | null;
    choices: RuntimeModelEntry[];
    groupedChoices: Array<{
      providerLabel: string;
      entries: RuntimeModelEntry[];
    }>;
    currentModel: string;
    currentModelDisplay: string;
    currentModelHint: string;
  } = () => ({
    selectedEntryId: "",
    selectedEntry: null,
    choices: [],
    groupedChoices: [],
    currentModel: "",
    currentModelDisplay: "",
    currentModelHint: "",
  });
  let markNextWebChatSendAsNewChat = () => {};
  let primeFreshWebChatPaperChipState = () => {};
  let refreshGlobalHistoryHeader: () => Promise<void> = async () => {};
  let switchGlobalConversation: (
    nextConversationKey: number,
  ) => Promise<void> = async () => {};
  let switchPaperConversation: (
    nextConversationKey?: number,
  ) => Promise<void> = async () => {};
  let createAndSwitchGlobalConversation: (
    forceFresh?: boolean,
  ) => Promise<void> = async () => {};
  let createAndSwitchPaperConversation: (
    forceFresh?: boolean,
  ) => Promise<void> = async () => {};
  let queueTurnDeletion: (target: {
    conversationKey: number;
    userTimestamp: number;
    assistantTimestamp: number;
  }) => Promise<void> = async () => {};
  let clearPendingTurnDeletion: () => unknown = () => null;
  let hasPendingTurnDeletionForConversation = (_conversationKey: number) =>
    false;
  let closePaperPicker = () => {};
  let clearForcedSkill = () => {};
  let renderWebChatHistoryMenu: () => Promise<void> = async () => {};
  let isWebChatMode = () => isWebChatModeActive();
  const switchConversationSystem = async (
    nextSystem: ConversationSystem,
    options?: { forceFresh?: boolean },
  ) => {
    if (!item) return;
    const noteSession = resolveCurrentNoteSession();
    if (noteSession) {
      const resolvedNextSystem = resolveNoteConversationSystemSwitch({
        nextSystem,
        codexAvailable: isCodexModeAvailable(),
      });
      if (!resolvedNextSystem) return;
      if (resolvedNextSystem === getConversationSystem()) return;
      persistDraftInputForCurrentConversation();
      currentConversationSystem = resolvedNextSystem;
      panelRoot.dataset.conversationSystem = resolvedNextSystem;
      syncQueuedFollowUpRegistration();
      updateRuntimeModeButton();
      updateClaudeSystemToggle();
      await ensureConversationLoaded(item);
      restoreDraftInputForCurrentConversation();
      refreshChatPreservingScroll();
      resetComposePreviewUI();
      updateModelButton();
      updateReasoningButton();
      return;
    }
    if (nextSystem === getConversationSystem()) return;
    const libraryID = getCurrentLibraryID();
    if (!libraryID) return;
    const forceFresh = options?.forceFresh === true;
    persistDraftInputForCurrentConversation();
    setConversationSystemPref(nextSystem);
    currentConversationSystem = nextSystem;
    panelRoot.dataset.conversationSystem = nextSystem;
    syncQueuedFollowUpRegistration();
    updateClaudeSystemToggle();
    if (nextSystem === "claude_code") {
      warmClaudeModeCaches();
    }
    if (isGlobalMode()) {
      if (forceFresh) {
        await createAndSwitchGlobalConversation(true);
        return;
      }
      const nextConversationKey =
        nextSystem === "claude_code"
          ? resolveRememberedClaudeConversationKey({
              libraryID,
              kind: "global",
            }) ||
            getLastUsedClaudeGlobalConversationKey(libraryID) ||
            0
          : nextSystem === "codex"
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
      if (nextConversationKey > 0) {
        await switchGlobalConversation(nextConversationKey);
      } else {
        await createAndSwitchGlobalConversation();
      }
      return;
    }
    if (forceFresh) {
      const rawBaseItem = resolveCurrentPaperBaseItem();
      if (!rawBaseItem) return;
      const resolvedState = resolveInitialPanelItemState(rawBaseItem, {
        conversationSystem: nextSystem,
      });
      item = resolvedState.item || item;
      basePaperItem = resolvedState.basePaperItem || basePaperItem;
      syncConversationIdentity();
      await createAndSwitchPaperConversation(true);
      return;
    }
    const rawBaseItem = resolveCurrentPaperBaseItem();
    if (!rawBaseItem) return;
    const resolvedState = resolveInitialPanelItemState(rawBaseItem, {
      conversationSystem: nextSystem,
    });
    item = resolvedState.item || item;
    basePaperItem = resolvedState.basePaperItem || basePaperItem;
    syncConversationIdentity();
    if (nextSystem === "claude_code") {
      warmClaudeModeCaches();
    }
    await ensureConversationLoaded(item as Zotero.Item);
    await renderShortcuts(
      body,
      item as Zotero.Item,
      resolveShortcutMode(item as Zotero.Item),
    );
    restoreDraftInputForCurrentConversation();
    refreshChatPreservingScroll();
    resetComposePreviewUI();
    updateModelButton();
    updateReasoningButton();
    updateClaudeSystemToggle();
    void refreshGlobalHistoryHeader();
  };
  const ensureClaudeConversationCatalogEntry = async (params: {
    conversationKey: number;
    libraryID: number;
    kind: "global" | "paper";
    paperItemID?: number;
  }) => {
    const existing = await getClaudeConversationSummary(params.conversationKey);
    if (existing) return existing;
    await upsertClaudeConversationSummary({
      conversationKey: params.conversationKey,
      libraryID: params.libraryID,
      kind: params.kind,
      paperItemID: params.paperItemID,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return getClaudeConversationSummary(params.conversationKey);
  };
  const ensureCodexConversationCatalogEntry = async (params: {
    conversationKey: number;
    libraryID: number;
    kind: "global" | "paper";
    paperItemID?: number;
  }) => {
    const existing = await getCodexConversationSummary(params.conversationKey);
    if (existing) return existing;
    await upsertCodexConversationSummary({
      conversationKey: params.conversationKey,
      libraryID: params.libraryID,
      kind: params.kind,
      paperItemID: params.paperItemID,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return getCodexConversationSummary(params.conversationKey);
  };
  const isClaudeConversationDraft = async (conversationKey: number) => {
    const summary = await getClaudeConversationSummary(conversationKey);
    return Boolean(summary && (summary.userTurnCount || 0) === 0);
  };
  const isCodexConversationDraft = async (conversationKey: number) => {
    const summary = await getCodexConversationSummary(conversationKey);
    return Boolean(summary && (summary.userTurnCount || 0) === 0);
  };
  const resolveCurrentNoteParentItem = (): Zotero.Item | null => {
    const noteSession = resolveCurrentNoteSession();
    if (!noteSession?.parentItemId) return null;
    const parentItem = Zotero.Items.get(noteSession.parentItemId) || null;
    return parentItem?.isRegularItem?.() ? parentItem : null;
  };
  const resolveCurrentPaperBaseItem = (): Zotero.Item | null => {
    const noteSession = resolveCurrentNoteSession();
    if (noteSession?.noteKind === "item") {
      const parentItem = resolveCurrentNoteParentItem();
      if (parentItem) {
        basePaperItem = parentItem;
        return parentItem;
      }
    }
    if (noteSession) {
      return null;
    }
    if (basePaperItem?.isRegularItem?.()) return basePaperItem;
    const resolvedFromItem = resolveConversationBaseItem(item);
    if (resolvedFromItem?.isRegularItem?.()) {
      basePaperItem = resolvedFromItem;
      return resolvedFromItem;
    }
    const activeContext = getActiveContextAttachmentFromTabs();
    const resolvedFromContext =
      activeContext && activeContext.parentID
        ? Zotero.Items.get(activeContext.parentID) || null
        : null;
    if (resolvedFromContext?.isRegularItem?.()) {
      basePaperItem = resolvedFromContext;
      return resolvedFromContext;
    }
    return null;
  };

  // Compute conversation key early so all closures can reference it.
  let conversationKey = item ? getConversationKey(item) : null;
  const getTextContextConversationKey = (): number | null =>
    item ? getConversationKey(item) : null;
  const syncConversationIdentity = () => {
    conversationKey = item ? getConversationKey(item) : null;
    activeContextPanels.set(body, () => item);
    void retainClaudeRuntimeForBody(body, item);
    if ((body as HTMLElement).dataset?.standalone === "true") {
      activeContextPanelRawItems.set(body, item || null);
    }
    panelRoot.dataset.itemId =
      Number.isFinite(conversationKey) && (conversationKey as number) > 0
        ? `${conversationKey}`
        : "";
    const libraryID = getCurrentLibraryID();
    panelRoot.dataset.libraryId = libraryID > 0 ? `${libraryID}` : "";
    const noteSession = resolveCurrentNoteSession();
    const mode: "global" | "paper" | null = item
      ? resolveDisplayConversationKind(item)
      : null;
    panelRoot.dataset.conversationKind = mode || "";
    currentConversationSystem = resolvePreferredConversationSystem({
      item,
      preferredSystem: currentConversationSystem,
    });
    panelRoot.dataset.conversationSystem = currentConversationSystem;
    syncQueuedFollowUpRegistration();
    const currentBasePaperItemID =
      mode === "paper" ? Number(resolveCurrentPaperBaseItem()?.id || 0) : 0;
    panelRoot.dataset.basePaperItemId =
      Number.isFinite(currentBasePaperItemID) && currentBasePaperItemID > 0
        ? `${Math.floor(currentBasePaperItemID)}`
        : "";
    panelRoot.dataset.noteKind = noteSession?.noteKind || "";
    panelRoot.dataset.noteId = noteSession?.noteId
      ? `${noteSession.noteId}`
      : "";
    panelRoot.dataset.noteTitle = noteSession?.title || "";
    panelRoot.dataset.noteParentItemId = noteSession?.parentItemId
      ? `${noteSession.parentItemId}`
      : "";
    if (historyNewBtn) {
      historyNewBtn.style.display = noteSession ? "none" : "";
    }
    if (historyToggleBtn) {
      historyToggleBtn.style.display = noteSession ? "none" : "";
    }
    if (item && libraryID > 0 && mode && !noteSession) {
      if (isClaudeConversationSystem()) {
        activeClaudeConversationModeByLibrary.set(
          buildClaudeLibraryStateKey(libraryID),
          mode,
        );
        setLastUsedClaudeConversationMode(libraryID, mode);
      } else if (isCodexConversationSystem()) {
        activeCodexConversationModeByLibrary.set(
          buildCodexLibraryStateKey(libraryID),
          mode,
        );
        setLastUsedCodexConversationMode(libraryID, mode);
        if (mode === "global") {
          activeCodexGlobalConversationByLibrary.set(
            buildCodexLibraryStateKey(libraryID),
            item.id,
          );
          setLastUsedCodexGlobalConversationKey(libraryID, item.id);
        } else if (
          Number.isFinite(conversationKey) &&
          (conversationKey as number) > 0 &&
          Number.isFinite(currentBasePaperItemID) &&
          currentBasePaperItemID > 0
        ) {
          const normalizedConversationKey = Math.floor(
            conversationKey as number,
          );
          const paperStateKey = buildCodexPaperStateKey(
            libraryID,
            Math.floor(currentBasePaperItemID),
          );
          activeCodexPaperConversationByPaper.set(
            paperStateKey,
            normalizedConversationKey,
          );
          setLastUsedCodexPaperConversationKey(
            libraryID,
            Math.floor(currentBasePaperItemID),
            normalizedConversationKey,
          );
        }
      } else {
        activeConversationModeByLibrary.set(libraryID, mode);
        if (mode === "global") {
          activeGlobalConversationByLibrary.set(libraryID, item.id);
        } else if (
          Number.isFinite(conversationKey) &&
          (conversationKey as number) > 0 &&
          Number.isFinite(currentBasePaperItemID) &&
          currentBasePaperItemID > 0
        ) {
          const lockedGlobalKey = getLockedGlobalConversationKey(libraryID);
          if (lockedGlobalKey !== null) {
            setLockedGlobalConversationKey(libraryID, null);
            removeAutoLockedGlobalConversationKey(lockedGlobalKey);
          }
          const normalizedConversationKey = Math.floor(
            conversationKey as number,
          );
          const paperStateKey = buildPaperStateKey(
            libraryID,
            Math.floor(currentBasePaperItemID),
          );
          activePaperConversationByPaper.set(
            paperStateKey,
            normalizedConversationKey,
          );
          setLastUsedPaperConversationKey(
            libraryID,
            Math.floor(currentBasePaperItemID),
            normalizedConversationKey,
          );
        }
      }
    }
    syncRequestUiForCurrentConversation();
    if (historyModeIndicator) {
      // Keep historyModeIndicator (which is the clock history button) accessible.
      // Its label is static "Conversation history" — no text update needed.
    }
    // Update mode capsule data-active state
    if (modeCapsule) {
      modeCapsule.dataset.mode = mode || "";
    }
    if (modeChipBtn) {
      // [webchat] Don't overwrite — applyWebChatModeUI manages the chip in webchat mode
      if (!modeChipBtn.querySelector(".llm-webchat-dot")) {
        const currentLabel = noteSession
          ? "Note editing"
          : mode === "global"
            ? "Library chat"
            : "Paper chat";
        modeChipBtn.textContent = currentLabel;
        modeChipBtn.title = noteSession
          ? currentLabel
          : mode === "global"
            ? "Switch to paper chat"
            : "Switch to library chat";
        modeChipBtn.setAttribute(
          "aria-label",
          noteSession
            ? currentLabel
            : mode === "global"
              ? "Switch to paper chat"
              : "Switch to library chat",
        );
      }
    }
    if (inputBox && !noteSession) {
      inputBox.placeholder =
        mode === "global"
          ? t("Ask anything... Type / for actions, @ to add papers")
          : t("Ask about this paper... Type / for actions, @ to add papers");
    }
    updateRuntimeModeButton();
    updateClaudeSystemToggle();
  };
  syncConversationIdentity();
  if (getConversationSystem() === "claude_code") {
    warmClaudeModeCaches();
  }

  // Keep the agent mode toggle in sync when the preference is changed in the
  // Preferences window (which runs in a separate window context).
  let cleanupPrefObservers: (() => void) | null = null;
  {
    const agentPrefKey = `${config.prefsPrefix}.enableAgentMode`;
    const claudeModePrefKey = `${config.prefsPrefix}.enableClaudeCodeMode`;
    const codexModePrefKey = `${config.prefsPrefix}.enableCodexAppServerMode`;
    let agentObserverId: symbol | undefined;
    let claudeObserverId: symbol | undefined;
    let codexObserverId: symbol | undefined;
    const unregister = (observerId: symbol | undefined) => {
      if (observerId === undefined) return;
      try {
        (Zotero as any).Prefs.unregisterObserver(observerId);
      } catch {
        void 0;
      }
    };
    cleanupPrefObservers = () => {
      unregister(agentObserverId);
      unregister(claudeObserverId);
      unregister(codexObserverId);
      agentObserverId = undefined;
      claudeObserverId = undefined;
      codexObserverId = undefined;
    };
    const onAgentPrefChange = () => {
      if (!(body as Element).isConnected) {
        cleanupPrefObservers?.();
        return;
      }
      updateRuntimeModeButton();
    };
    const onClaudeModePrefChange = () => {
      if (!(body as Element).isConnected) {
        cleanupPrefObservers?.();
        return;
      }
      if (!getClaudeCodeModeEnabled()) {
        void releaseClaudeRuntimeForBody(body);
        void invalidateAllClaudeHotRuntimes(getCoreAgentRuntime()).catch(
          (err: unknown) => {
            ztoolkit.log(
              "LLM: Failed to invalidate all Claude hot runtimes",
              err,
            );
          },
        );
        setConversationSystemPref("upstream");
        if (isClaudeConversationSystem()) {
          void switchConversationSystem("upstream");
          return;
        }
      }
      updateClaudeSystemToggle();
    };
    const onCodexModePrefChange = () => {
      if (!(body as Element).isConnected) {
        cleanupPrefObservers?.();
        return;
      }
      if (!isCodexAppServerModeEnabled()) {
        if (getConversationSystemPref() === "codex") {
          setConversationSystemPref("upstream");
        }
        if (isCodexConversationSystem()) {
          void switchConversationSystem("upstream");
          return;
        }
      }
      updateClaudeSystemToggle();
      updateRuntimeModeButton();
    };
    try {
      agentObserverId = (Zotero as any).Prefs.registerObserver(
        agentPrefKey,
        onAgentPrefChange,
        true,
      );
      claudeObserverId = (Zotero as any).Prefs.registerObserver(
        claudeModePrefKey,
        onClaudeModePrefChange,
        true,
      );
      codexObserverId = (Zotero as any).Prefs.registerObserver(
        codexModePrefKey,
        onCodexModePrefChange,
        true,
      );
    } catch {
      // Zotero.Prefs.registerObserver not available – no live sync
    }
  }

  let activeEditSession: EditLatestTurnMarker | null = null;
  let attachmentGcTimer: number | null = null;
  const scheduleAttachmentGc = (delayMs = 5_000) => {
    const win = body.ownerDocument?.defaultView;
    const clearTimer = () => {
      if (attachmentGcTimer === null) return;
      if (win) {
        win.clearTimeout(attachmentGcTimer);
      } else {
        clearTimeout(attachmentGcTimer);
      }
      attachmentGcTimer = null;
    };
    clearTimer();
    const runGc = () => {
      attachmentGcTimer = null;
      void collectAndDeleteUnreferencedBlobs(ATTACHMENT_GC_MIN_AGE_MS).catch(
        (err) => {
          ztoolkit.log("LLM: Attachment GC failed", err);
        },
      );
    };
    if (win) {
      attachmentGcTimer = win.setTimeout(runGc, delayMs);
    } else {
      attachmentGcTimer =
        (setTimeout(runGc, delayMs) as unknown as number) || 0;
    }
  };

  const persistCurrentChatScrollSnapshot = () => {
    if (!item || !chatBox || !chatBox.childElementCount) return;
    if (!isChatViewportVisible(chatBox)) return;
    persistChatScrollSnapshot(item, chatBox);
  };

  const isChatViewportVisible = (box: HTMLDivElement): boolean => {
    return box.clientHeight > 0 && box.getClientRects().length > 0;
  };

  type ChatBoxViewportState = {
    width: number;
    height: number;
    maxScrollTop: number;
    scrollTop: number;
    nearBottom: boolean;
  };
  const buildChatBoxViewportState = (): ChatBoxViewportState | null => {
    if (!chatBox) return null;
    if (!isChatViewportVisible(chatBox)) return null;
    const width = Math.max(0, Math.round(chatBox.clientWidth));
    const height = Math.max(0, Math.round(chatBox.clientHeight));
    const maxScrollTop = Math.max(
      0,
      chatBox.scrollHeight - chatBox.clientHeight,
    );
    const scrollTop = Math.max(0, Math.min(maxScrollTop, chatBox.scrollTop));
    const nearBottom = maxScrollTop - scrollTop <= AUTO_SCROLL_BOTTOM_THRESHOLD;
    return {
      width,
      height,
      maxScrollTop,
      scrollTop,
      nearBottom,
    };
  };
  let chatBoxViewportState = buildChatBoxViewportState();
  const captureChatBoxViewportState = () => {
    chatBoxViewportState = buildChatBoxViewportState();
  };

  if (item && chatBox) {
    const persistScroll = () => {
      if (!item) return;
      if (!chatBox.childElementCount) return;
      if (!isChatViewportVisible(chatBox)) return;
      const currentWidth = Math.max(0, Math.round(chatBox.clientWidth));
      const currentHeight = Math.max(0, Math.round(chatBox.clientHeight));
      const previousViewport = chatBoxViewportState;
      let viewportResized = false;
      if (previousViewport) {
        viewportResized =
          currentWidth !== previousViewport.width ||
          currentHeight !== previousViewport.height;
      }
      // Ignore resize-induced scroll events so the last pre-resize viewport
      // state remains available for relative-position restoration.
      if (viewportResized) return;
      // Skip persistence when scroll was caused by our own programmatic
      // scrollTop writes or by layout mutations (e.g. button relayout
      // changing the flex-sized chat area).
      if (isScrollUpdateSuspended()) {
        captureChatBoxViewportState();
        return;
      }
      persistChatScrollSnapshot(item, chatBox);
      captureChatBoxViewportState();
    };
    chatBox.addEventListener("scroll", persistScroll, { passive: true });
  }

  // Capture scroll before click/focus interactions that may trigger a panel
  // re-render, so restore uses the most recent user position.
  body.addEventListener("pointerdown", persistCurrentChatScrollSnapshot, true);
  // NOTE: We intentionally do NOT persist on "focusin" because focusin fires
  // AFTER focus() has already caused a potential scroll adjustment in Gecko.
  // Persisting at that point overwrites the correct pre-interaction snapshot
  // (captured by pointerdown) with a corrupted position. The scroll event
  // handler on chatBox already keeps the snapshot up to date for programmatic
  // scroll changes.

  let retryMenuAnchor: HTMLButtonElement | null = null;
  const closeResponseMenu = () => {
    if (responseMenu) responseMenu.style.display = "none";
    setResponseMenuTarget(null);
  };
  const closePromptMenu = () => {
    if (promptMenu) promptMenu.style.display = "none";
    setPromptMenuTarget(null);
  };
  const closeExportMenu = () => {
    if (exportMenu) exportMenu.style.display = "none";
  };
  let resetHistorySearchState = () => {};
  const closeHistoryRowMenu = () => {
    if (historyRowMenu) historyRowMenu.style.display = "none";
  };
  const closeHistoryNewMenu = () => {
    if (historyNewMenu) historyNewMenu.style.display = "none";
    if (historyNewBtn) {
      historyNewBtn.setAttribute("aria-expanded", "false");
    }
    closeHistoryRowMenu();
  };
  const closeHistoryMenu = () => {
    if (historyMenu) historyMenu.style.display = "none";
    if (historyToggleBtn) {
      historyToggleBtn.setAttribute("aria-expanded", "false");
    }
    resetHistorySearchState();
    closeHistoryRowMenu();
  };
  let closeSlashMenu = () => {
    setFloatingMenuOpen(slashMenu, SLASH_MENU_OPEN_CLASS, false);
    if (uploadBtn) {
      uploadBtn.setAttribute("aria-expanded", "false");
    }
  };
  let openModelMenu = () => {};
  let closeModelMenu = () => {
    setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, false);
  };
  let openReasoningMenu = () => {};
  let closeReasoningMenu = () => {
    setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
  };
  const isHistoryMenuOpen = () =>
    Boolean(historyMenu && historyMenu.style.display !== "none");
  const isHistoryNewMenuOpen = () =>
    Boolean(historyNewMenu && historyNewMenu.style.display !== "none");
  const closeRetryModelMenu = () => {
    setFloatingMenuOpen(retryModelMenu, RETRY_MODEL_MENU_OPEN_CLASS, false);
    retryMenuAnchor = null;
  };

  const handlerContext: SetupHandlersContext = {
    body,
    refs: panelRefs,
    getItem: () => item,
    getConversationKey,
    setStatusMessage: (message, level) => {
      if (status) setStatus(status, message, level);
    },
    refreshChatPreservingScroll: () => refreshChatPreservingScroll(),
    refreshGlobalHistoryHeader: () => refreshGlobalHistoryHeader(),
    logError: (message, ...args) => {
      ztoolkit.log(message, ...args);
    },
  };

  attachAssistantSelectionPopup({
    body: handlerContext.body,
    panelRoot,
    panelDoc,
    panelWin,
    chatBox,
    inputBox,
    status,
    getItem: handlerContext.getItem,
    getTextContextConversationKey,
    runWithChatScrollGuard: (fn) => runWithChatScrollGuard(fn),
    updateSelectedTextPreviewPreservingScroll: () =>
      updateSelectedTextPreviewPreservingScroll(),
    isElementNode,
  });

  attachMenuActionController({
    body,
    status,
    responseMenu,
    responseMenuCopyBtn,
    responseMenuNoteBtn,
    responseMenuDeleteBtn,
    promptMenu,
    promptMenuDeleteBtn,
    exportMenu,
    exportMenuCopyBtn,
    exportMenuNoteBtn,
    exportBtn,
    popoutBtn,
    settingsBtn,
    preferencesPaneId: PREFERENCES_PANE_ID,
    getItem: () => item,
    getResponseMenuTarget: () => responseMenuTarget,
    getPromptMenuTarget: () => promptMenuTarget,
    getCurrentLibraryID,
    getConversationSystem,
    getCurrentRuntimeModeForItem: (targetItem) =>
      selectedRuntimeModeCache.get(getConversationKey(targetItem)) || null,
    isGlobalMode,
    ensureConversationLoaded,
    getConversationKey,
    getHistory: (conversationKey) => chatHistory.get(conversationKey) || [],
    resolveActiveNoteSession,
    closeResponseMenu,
    closePromptMenu,
    closeExportMenu,
    closeRetryModelMenu,
    closeSlashMenu,
    closeHistoryNewMenu,
    closeHistoryMenu,
    queueTurnDeletion: (target) => queueTurnDeletion(target),
    logError: (message, error) => {
      ztoolkit.log(message, error);
    },
  });

  // Clicking non-interactive panel area gives keyboard focus to the panel.
  panelRoot.addEventListener("mousedown", (e: Event) => {
    const me = e as MouseEvent;
    if (me.button !== 0) return;
    const target = me.target as Element | null;
    if (!target) return;
    const isInteractive = Boolean(
      target.closest(
        "input, textarea, button, select, option, a[href], [contenteditable='true']",
      ),
    );
    if (!isInteractive) {
      panelRoot.focus({ preventScroll: true });
    }
  });

  const { applyResponsiveActionButtonsLayout } = createActionLayoutController({
    body,
    panelRoot,
    actionsRow,
    actionsLeft,
    modelBtn,
    modelSlot,
    reasoningBtn,
    reasoningSlot,
    uploadBtn,
    selectTextBtn,
    screenshotBtn,
    sendBtn,
    cancelBtn,
  });
  const responsiveLayoutScheduler = createCoalescedFrameScheduler({
    getWindow: () => body.ownerDocument?.defaultView || null,
    run: () => {
      withScrollGuard(
        chatBox,
        conversationKey,
        () => {
          applyResponsiveActionButtonsLayout();
          syncUserContextAlignmentWidths(body);
        },
        "relative",
      );
    },
  });
  const scheduleResponsiveLayoutSync = () => {
    responsiveLayoutScheduler.schedule();
  };
  const flushResponsiveLayoutSyncNow = () => {
    responsiveLayoutScheduler.flush();
  };

  const clearSelectedImageState = (itemId: number) =>
    clearSelectedImageState_(pinnedImageKeys, itemId);

  const clearSelectedFileState = (itemId: number) =>
    clearSelectedFileState_(pinnedFileKeys, itemId);

  const hasUserTurnsForCurrentConversation = (): boolean => {
    if (!item) return false;
    const history = chatHistory.get(getConversationKey(item)) || [];
    return history.some((message) => message.role === "user");
  };

  // getPaperModeOverride, setPaperModeOverride, clearPaperModeOverrides
  // → imported from ./contexts/paperContextState

  const consumePaperModeState = (
    itemId: number,
    opts?: { webchatGreyOut?: boolean },
  ) => {
    if (!item || item.id !== itemId) {
      clearPaperModeOverrides(itemId);
      return;
    }
    // Standard path: consume full-next mode for non-PDF papers
    const fullTextPaperContexts = getEffectiveFullTextPaperContexts(item);
    for (const paperContext of fullTextPaperContexts) {
      const mode = resolvePaperContextNextSendMode(itemId, paperContext);
      if (mode === "full-next") {
        setPaperModeOverride(itemId, paperContext, "retrieval");
      }
    }
    // [webchat] Also consume full-next for PDF-source papers.
    // getEffectiveFullTextPaperContexts excludes PDF-source papers,
    // but in webchat mode these papers also use full-next/full-sticky semantics
    // for controlling whether to send the PDF binary to ChatGPT.
    if (opts?.webchatGreyOut) {
      const allPaperContexts = getAllEffectivePaperContexts(item);
      for (const paperContext of allPaperContexts) {
        if (resolvePaperContentSourceMode(itemId, paperContext) !== "pdf")
          continue;
        const mode = resolvePaperContextNextSendMode(itemId, paperContext);
        if (mode === "full-next") {
          setPaperModeOverride(itemId, paperContext, "retrieval");
        }
      }
    }
  };

  // isPaperContextFullTextMode, getPaperContentSourceOverride,
  // setPaperContentSourceOverride, clearPaperContentSourceOverrides
  // → imported from ./contexts/paperContextState

  const resolvePaperContentSourceMode = (
    itemId: number,
    paperContext: PaperContextRef,
  ): PaperContentSourceMode => {
    // [webchat] Always use PDF content source — webchat sends raw PDF via drag-and-drop
    if (isWebChatMode()) return "pdf";
    const explicit = getPaperContentSourceOverride(itemId, paperContext);
    return explicit || (isPaperContextMineru(paperContext) ? "mineru" : "text");
  };

  // getNextContentSourceMode → imported from ./contexts/paperContextState

  // Lightweight sync cache: once checkAndApplyMineruChipStyle confirms MinerU
  // exists on disk, the contextItemId is added here so isPaperContextMineru
  // returns true immediately without waiting for pdfTextCache to be populated.
  const mineruAvailableIds = new Set<number>();
  const pendingMineruAvailabilityChecks = new Map<number, Promise<void>>();
  let mineruChipStyleDepsPromise: Promise<{
    getMineruAvailabilityForAttachmentId: typeof import("./mineruSync").getMineruAvailabilityForAttachmentId;
    isMineruEnabled: typeof import("../../utils/mineruConfig").isMineruEnabled;
  }> | null = null;
  const loadMineruChipStyleDeps = () => {
    if (!mineruChipStyleDepsPromise) {
      mineruChipStyleDepsPromise = Promise.all([
        import("./mineruSync"),
        import("../../utils/mineruConfig"),
      ]).then(([mineruSync, mineruConfig]) => ({
        getMineruAvailabilityForAttachmentId:
          mineruSync.getMineruAvailabilityForAttachmentId,
        isMineruEnabled: mineruConfig.isMineruEnabled,
      }));
    }
    return mineruChipStyleDepsPromise;
  };

  const isPaperContextMineru = (paperContext: PaperContextRef): boolean => {
    if (mineruAvailableIds.has(paperContext.contextItemId)) return true;
    // Check in-memory pdfTextCache (populated after ensurePDFTextCached)
    const cached = pdfTextCache.get(paperContext.contextItemId);
    if (cached?.sourceType === "mineru") {
      mineruAvailableIds.add(paperContext.contextItemId);
      return true;
    }
    // Cache may not be populated yet — trigger async check and update chip later
    if (!cached) {
      void checkAndApplyMineruChipStyle(paperContext.contextItemId);
    }
    return false;
  };

  const checkAndApplyMineruChipStyle = async (
    contextItemId: number,
  ): Promise<void> => {
    if (mineruAvailableIds.has(contextItemId)) return;
    return getOrCreateKeyedInFlightTask(
      pendingMineruAvailabilityChecks,
      contextItemId,
      async () => {
        try {
          if (mineruAvailableIds.has(contextItemId)) return;
          const { getMineruAvailabilityForAttachmentId, isMineruEnabled } =
            await loadMineruChipStyleDeps();
          if (!isMineruEnabled()) return;
          const availability = await getMineruAvailabilityForAttachmentId(
            contextItemId,
            {
              validateSyncedPackage: false,
            },
          );
          if (availability.status === "missing") return;
          mineruAvailableIds.add(contextItemId);
          // MinerU is now available; re-render chips so the default mode flips.
          schedulePanelStateRefresh();
        } catch {
          /* ignore */
        }
      },
    );
  };

  const resolvePaperContextNextSendMode = (
    itemId: number,
    paperContext: PaperContextRef,
  ): PaperContextSendMode => {
    const explicitMode = getPaperModeOverride(itemId, paperContext);
    if (explicitMode) return explicitMode;
    const autoLoadedPaperContext =
      item && item.id === itemId ? resolveAutoLoadedPaperContext() : null;
    if (
      autoLoadedPaperContext &&
      buildPaperKey(autoLoadedPaperContext) === buildPaperKey(paperContext) &&
      !hasUserTurnsForCurrentConversation()
    ) {
      return "full-next";
    }
    return "retrieval";
  };

  const getManualPaperContextsForItem = (
    itemId: number,
    autoLoadedPaperContext: PaperContextRef | null,
    selectedPaperContexts?: PaperContextRef[],
  ): PaperContextRef[] => {
    const fromCache = selectedPaperContexts === undefined;
    const normalized = normalizePaperContextEntries(
      fromCache
        ? selectedPaperContextCache.get(itemId) || []
        : selectedPaperContexts,
    );
    const filtered = filterManualPaperContextsAgainstAutoLoaded(
      normalized,
      autoLoadedPaperContext,
    );
    if (fromCache && filtered.length !== normalized.length) {
      if (filtered.length) {
        selectedPaperContextCache.set(itemId, filtered);
      } else {
        selectedPaperContextCache.delete(itemId);
      }
    }
    return filtered;
  };

  const getAllEffectivePaperContexts = (
    currentItem: Zotero.Item,
    selectedPaperContexts?: PaperContextRef[],
  ): PaperContextRef[] => {
    const autoLoadedPaperContext = isGlobalPortalItem(currentItem)
      ? null
      : resolveAutoLoadedPaperContext();
    const selectedPapers = getManualPaperContextsForItem(
      currentItem.id,
      autoLoadedPaperContext,
      selectedPaperContexts,
    );
    return normalizePaperContextEntries([
      ...(autoLoadedPaperContext ? [autoLoadedPaperContext] : []),
      ...selectedPapers,
    ]);
  };

  const getEffectiveFullTextPaperContexts = (
    currentItem: Zotero.Item,
    selectedPaperContexts?: PaperContextRef[],
  ): PaperContextRef[] => {
    return getAllEffectivePaperContexts(
      currentItem,
      selectedPaperContexts,
    ).filter(
      (paperContext) =>
        resolvePaperContentSourceMode(currentItem.id, paperContext) !== "pdf" &&
        isPaperContextFullTextMode(
          resolvePaperContextNextSendMode(currentItem.id, paperContext),
        ),
    );
  };

  const getEffectivePdfModePaperContexts = (
    currentItem: Zotero.Item,
    selectedPaperContexts?: PaperContextRef[],
  ): PaperContextRef[] => {
    return getAllEffectivePaperContexts(
      currentItem,
      selectedPaperContexts,
    ).filter(
      (paperContext) =>
        resolvePaperContentSourceMode(currentItem.id, paperContext) === "pdf",
    );
  };

  /** [webchat] Check if any paper has PDF content source AND full-text send mode (purple chip). */
  const hasActivePdfFullTextPapers = (
    currentItem: Zotero.Item,
    selectedPaperContexts?: PaperContextRef[],
  ): boolean => {
    return getAllEffectivePaperContexts(
      currentItem,
      selectedPaperContexts,
    ).some(
      (paperContext) =>
        resolvePaperContentSourceMode(currentItem.id, paperContext) === "pdf" &&
        isPaperContextFullTextMode(
          resolvePaperContextNextSendMode(currentItem.id, paperContext),
        ),
    );
  };

  // clearSelectedPaperState, clearAllRefContextState
  // → imported from ./contexts/paperContextState

  const clearSelectedTextState = (itemId: number) =>
    clearSelectedTextState_(pinnedSelectedTextKeys, itemId);
  const setDraftInputForConversation = (
    conversationKey: number,
    value: string,
  ) => {
    if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
    const normalizedKey = Math.floor(conversationKey);
    if (value) {
      draftInputCache.set(normalizedKey, value);
    } else {
      draftInputCache.delete(normalizedKey);
    }
  };
  const persistDraftInputForCurrentConversation = () => {
    // Don't persist the edit-mode text as a draft; the real draft was saved in
    // inlineEditSavedDraft when edit mode was entered.
    if (!item || !inputBox || inlineEditTarget) return;
    setDraftInputForConversation(getConversationKey(item), inputBox.value);
  };
  const restoreDraftInputForCurrentConversation = () => {
    if (!item || !inputBox) return;
    // Don't overwrite the user's in-progress edit text; the real draft was saved
    // in inlineEditSavedDraft when edit mode was entered and will be restored by
    // inlineEditCleanup when the edit session ends.
    if (inlineEditTarget) return;
    inputBox.value = draftInputCache.get(getConversationKey(item)) || "";
  };
  const clearDraftInputState = (itemId: number) => {
    draftInputCache.delete(itemId);
  };
  const retainPinnedImageState = (itemId: number) =>
    retainPinnedImageState_(pinnedImageKeys, itemId);
  const retainPinnedFileState = (itemId: number) =>
    retainPinnedFileState_(pinnedFileKeys, itemId);
  const retainPaperState = (itemId: number) => {
    const autoLoadedPaperContext =
      item && item.id === itemId ? resolveAutoLoadedPaperContext() : null;
    const retained = getManualPaperContextsForItem(
      itemId,
      autoLoadedPaperContext,
    );
    if (retained.length) {
      selectedPaperContextCache.set(itemId, retained);
    } else {
      selectedPaperContextCache.delete(itemId);
    }
    // Retain other ref contexts across sends (they persist like paper contexts).
    // Prune orphaned mode overrides for papers that are no longer selected.
    const validPaperKeys = new Set(
      retained.map((paperContext) => buildPaperKey(paperContext)),
    );
    if (autoLoadedPaperContext) {
      validPaperKeys.add(buildPaperKey(autoLoadedPaperContext));
    }
    const prefix = `${itemId}:`;
    for (const key of Array.from(paperContextModeOverrides.keys())) {
      if (key.startsWith(prefix)) {
        const paperKey = key.slice(prefix.length);
        if (!validPaperKeys.has(paperKey)) {
          paperContextModeOverrides.delete(key);
        }
      }
    }
    if (retained.length) {
      return;
    }
    if (!autoLoadedPaperContext) {
      selectedPaperPreviewExpandedCache.delete(itemId);
    }
  };
  const retainPinnedTextState = (itemId: number) =>
    retainPinnedTextState_(pinnedSelectedTextKeys, itemId);
  const clearTransientComposeStateForItem = (itemId: number) => {
    clearDraftInputState(itemId);
    clearSelectedImageState(itemId);
    clearAllRefContextState(itemId);
    clearPaperContentSourceOverrides(itemId);
    clearSelectedFileState(itemId);
    clearSelectedTextState(itemId);
  };
  const runWithChatScrollGuard = (fn: () => void) => {
    withScrollGuard(chatBox, conversationKey, fn);
  };
  const EDIT_STALE_STATUS_TEXT = t(
    "Edit target changed. Please edit latest prompt again.",
  );
  const getLatestEditablePair = async () => {
    if (!item) return null;
    await ensureConversationLoaded(item as Zotero.Item);
    const key = getConversationKey(item);
    const history = chatHistory.get(key) || [];
    const pair = findLatestRetryPair(history);
    if (!pair) return null;
    return { conversationKey: key, pair };
  };

  const resolveAutoLoadedPaperContext = (): PaperContextRef | null => {
    if (!item) return null;
    const noteSession = resolveCurrentNoteSession();
    if (noteSession?.noteKind === "standalone") return null;
    if (noteSession?.noteKind === "item") {
      const parentItem = resolveCurrentNoteParentItem();
      if (!parentItem) return null;
      const activeReaderAttachment = getActiveContextAttachmentFromTabs();
      if (activeReaderAttachment?.parentID === parentItem.id) {
        return (
          resolvePaperContextRefFromAttachment(activeReaderAttachment) ||
          resolvePaperContextRefFromItem(parentItem)
        );
      }
      return resolvePaperContextRefFromItem(parentItem);
    }
    if (isGlobalMode()) return null;
    const contextSource = resolveContextSourceItem(item);
    return (
      resolvePaperContextRefFromAttachment(contextSource.contextItem) ||
      resolvePaperContextRefFromItem(resolveCurrentPaperBaseItem())
    );
  };

  let paperChipMenu: HTMLDivElement | null = null;
  let paperChipMenuAnchor: HTMLDivElement | null = null;
  let paperChipMenuSticky = false;
  let paperChipMenuTarget: PaperContextRef | null = null;
  let paperChipMenuHideTimer: number | null = null;
  const clearPaperChipMenuHideTimer = () => {
    if (paperChipMenuHideTimer === null) return;
    const win = body.ownerDocument?.defaultView;
    if (win) {
      win.clearTimeout(paperChipMenuHideTimer);
    } else {
      clearTimeout(
        paperChipMenuHideTimer as unknown as ReturnType<typeof setTimeout>,
      );
    }
    paperChipMenuHideTimer = null;
  };
  const closePaperChipMenu = () => {
    clearPaperChipMenuHideTimer();
    if (paperChipMenu) {
      paperChipMenu.style.display = "none";
    }
    paperChipMenuAnchor = null;
    paperChipMenuTarget = null;
    paperChipMenuSticky = false;
  };
  const buildPaperChipAttachmentText = (
    paperContext: PaperContextRef,
  ): string => {
    const attachmentTitle = sanitizeText(
      paperContext.attachmentTitle || "",
    ).trim();
    const paperTitle = sanitizeText(paperContext.title || "").trim();
    if (!attachmentTitle || attachmentTitle === paperTitle) return "";
    return attachmentTitle;
  };
  const buildPaperMetaText = (paper: {
    citationKey?: string;
    firstCreator?: string;
    year?: string;
  }): string => {
    const parts = [
      paper.firstCreator || "",
      paper.year || "",
      paper.citationKey || "",
    ].filter(Boolean);
    return parts.join(" · ");
  };
  const buildPaperChipMenuCard = (
    ownerDoc: Document,
    paperContext: PaperContextRef,
    options?: { contentSourceMode?: PaperContentSourceMode },
  ): HTMLButtonElement => {
    const card = createElement(
      ownerDoc,
      "button",
      "llm-paper-picker-item llm-paper-picker-group-row llm-paper-chip-menu-row",
      {
        type: "button",
        title: `Jump to ${paperContext.title}`,
      },
    ) as HTMLButtonElement;
    const rowMain = createElement(
      ownerDoc,
      "div",
      "llm-paper-picker-group-row-main",
    );
    const titleLine = createElement(
      ownerDoc,
      "div",
      "llm-paper-picker-group-title-line",
    );
    const title = createElement(ownerDoc, "span", "llm-paper-picker-title", {
      textContent: paperContext.title,
      title: paperContext.title,
    });
    titleLine.appendChild(title);
    const mode = options?.contentSourceMode;
    const badgeText =
      mode === "mineru"
        ? "MD"
        : mode === "pdf"
          ? "PDF"
          : mode === "text"
            ? "Text"
            : null;
    if (badgeText) {
      titleLine.appendChild(
        createElement(ownerDoc, "span", "llm-paper-picker-badge", {
          textContent: badgeText,
        }),
      );
    }
    rowMain.appendChild(titleLine);
    const metaText = buildPaperMetaText(paperContext);
    if (metaText) {
      rowMain.appendChild(
        createElement(ownerDoc, "span", "llm-paper-picker-meta", {
          textContent: metaText,
          title: metaText,
        }),
      );
    }
    // Attachment line: PDF shows real title, MinerU shows "full.md", Text has none
    const displayAttachmentText =
      mode === "pdf"
        ? buildPaperChipAttachmentText(paperContext) ||
          resolveAttachmentTitle(paperContext)
        : mode === "mineru"
          ? "full.md"
          : ""; // text mode: no attachment line
    if (displayAttachmentText) {
      rowMain.appendChild(
        createElement(
          ownerDoc,
          "span",
          "llm-paper-picker-meta llm-paper-context-card-attachment",
          {
            textContent: displayAttachmentText,
            title: displayAttachmentText,
          },
        ),
      );
    }
    card.appendChild(rowMain);
    return card;
  };
  const ensurePaperChipMenu = (): HTMLDivElement | null => {
    if (paperChipMenu?.isConnected) return paperChipMenu;
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc) return null;
    const menu = createElement(
      ownerDoc,
      "div",
      "llm-model-menu llm-paper-chip-menu",
    );
    menu.style.display = "none";
    menu.addEventListener("mouseenter", () => {
      clearPaperChipMenuHideTimer();
    });
    menu.addEventListener("mouseleave", () => {
      if (!paperChipMenuSticky) {
        const win = body.ownerDocument?.defaultView;
        if (!win) {
          closePaperChipMenu();
          return;
        }
        clearPaperChipMenuHideTimer();
        paperChipMenuHideTimer = win.setTimeout(() => {
          closePaperChipMenu();
        }, 100);
      }
    });
    menu.addEventListener("click", (e: Event) => {
      const target = e.target as Element | null;
      if (!target) return;
      const card = target.closest(
        ".llm-paper-chip-menu-row",
      ) as HTMLButtonElement | null;
      if (!card || !paperChipMenuTarget) return;
      e.preventDefault();
      e.stopPropagation();
      void focusPaperContextInActiveTab(paperChipMenuTarget)
        .then((focused) => {
          if (!focused && status) {
            setStatus(status, t("Could not focus this paper"), "error");
          }
        })
        .catch((err) => {
          ztoolkit.log("LLM: Failed to focus paper context from menu", err);
          if (status) {
            setStatus(status, t("Could not focus this paper"), "error");
          }
        });
    });
    body.appendChild(menu);
    paperChipMenu = menu;
    return menu;
  };
  const positionPaperChipMenuAboveAnchor = (
    menu: HTMLDivElement,
    anchor: HTMLElement,
  ) => {
    const win = body.ownerDocument?.defaultView;
    if (!win) return;

    const viewportMargin = 8;
    const gap = 6;
    const panelRect = body.getBoundingClientRect();
    const minLeftBound = Math.max(
      viewportMargin,
      Math.round(panelRect.left) + 2,
    );
    const minTopBound = Math.max(viewportMargin, Math.round(panelRect.top) + 2);
    const maxRightBound = Math.round(panelRect.right) - 2;
    const maxBottomBound = Math.round(panelRect.bottom) - 2;
    const anchorRect = anchor.getBoundingClientRect();
    const availableWidth = Math.max(
      160,
      Math.floor(panelRect.width) - viewportMargin * 2 - 4,
    );

    menu.style.position = "fixed";
    menu.style.display = "grid";
    menu.style.visibility = "hidden";
    menu.style.boxSizing = "border-box";
    menu.style.maxWidth = `${availableWidth}px`;
    menu.style.maxHeight = `${Math.max(120, Math.floor(panelRect.height) - viewportMargin * 2)}px`;
    menu.style.overflowY = "auto";
    menu.style.overflowX = "hidden";

    const menuRect = menu.getBoundingClientRect();
    const maxLeft = Math.max(
      minLeftBound,
      Math.min(
        win.innerWidth - menuRect.width - viewportMargin,
        maxRightBound - menuRect.width,
      ),
    );
    const maxTop = Math.max(
      minTopBound,
      Math.min(
        win.innerHeight - menuRect.height - viewportMargin,
        maxBottomBound - menuRect.height,
      ),
    );
    const preferredLeft =
      anchorRect.left + menuRect.width <= maxRightBound
        ? anchorRect.left
        : anchorRect.right - menuRect.width;
    const spaceAbove = anchorRect.top - minTopBound;
    const spaceBelow = maxBottomBound - anchorRect.bottom;
    const preferredTop =
      spaceAbove >= menuRect.height || spaceAbove >= spaceBelow
        ? anchorRect.top - menuRect.height - gap
        : anchorRect.bottom + gap;
    const left = Math.min(Math.max(minLeftBound, preferredLeft), maxLeft);
    const top = Math.min(Math.max(minTopBound, preferredTop), maxTop);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.visibility = "visible";
  };
  const openPaperChipMenu = (
    chip: HTMLDivElement,
    paperContext: PaperContextRef,
    options?: { sticky?: boolean },
  ) => {
    const menu = ensurePaperChipMenu();
    const ownerDoc = body.ownerDocument;
    if (!menu || !ownerDoc) return;
    clearPaperChipMenuHideTimer();
    paperChipMenuAnchor = chip;
    paperChipMenuSticky = options?.sticky === true;
    paperChipMenuTarget = paperContext;
    menu.innerHTML = "";
    menu.appendChild(
      buildPaperChipMenuCard(ownerDoc, paperContext, {
        contentSourceMode:
          (chip.dataset.contentSource as PaperContentSourceMode) || "text",
      }),
    );
    positionPaperChipMenuAboveAnchor(menu, chip);
    menu.style.display = "grid";
  };
  const schedulePaperChipMenuClose = () => {
    if (paperChipMenuSticky) return;
    const win = body.ownerDocument?.defaultView;
    if (!win) {
      closePaperChipMenu();
      return;
    }
    clearPaperChipMenuHideTimer();
    paperChipMenuHideTimer = win.setTimeout(() => {
      closePaperChipMenu();
    }, 100);
  };
  const resolvePaperContextFromChipElement = (
    chip: HTMLElement,
  ): PaperContextRef | null => {
    if (chip.dataset.autoLoaded === "true") {
      return resolveAutoLoadedPaperContext();
    }
    const paperItemId = Number.parseInt(chip.dataset.paperItemId || "", 10);
    const contextItemId = Number.parseInt(
      chip.dataset.paperContextItemId || "",
      10,
    );
    if (
      !Number.isFinite(paperItemId) ||
      paperItemId <= 0 ||
      !Number.isFinite(contextItemId) ||
      contextItemId <= 0
    ) {
      return null;
    }
    if (item) {
      const selectedPapers = getManualPaperContextsForItem(
        item.id,
        resolveAutoLoadedPaperContext(),
      );
      const matchedPaper = selectedPapers.find(
        (paperContext) =>
          paperContext.itemId === paperItemId &&
          paperContext.contextItemId === contextItemId,
      );
      if (matchedPaper) {
        return matchedPaper;
      }
    }
    const attachment = Zotero.Items.get(contextItemId) || null;
    return resolvePaperContextRefFromAttachment(attachment);
  };
  const focusPaperContextInActiveTab = async (
    paperContext: PaperContextRef,
  ): Promise<boolean> => {
    const tabs = (
      Zotero as unknown as {
        Tabs?: {
          selectedType?: string;
          getTabIDByItemID?: (itemID: number) => string;
          select?: (id: string, reopening?: boolean, options?: unknown) => void;
        };
      }
    ).Tabs;
    const selectedType = String(tabs?.selectedType || "").toLowerCase();
    if (selectedType.includes("reader")) {
      const existingReaderTabId =
        tabs?.getTabIDByItemID?.(paperContext.contextItemId) ||
        tabs?.getTabIDByItemID?.(paperContext.itemId);
      if (existingReaderTabId && typeof tabs?.select === "function") {
        tabs.select(existingReaderTabId);
        return true;
      }
      const readerApi = Zotero.Reader as
        | {
            open?: (
              itemID: number,
              location?: _ZoteroTypes.Reader.Location,
            ) => Promise<void | _ZoteroTypes.ReaderInstance>;
          }
        | undefined;
      if (typeof readerApi?.open === "function") {
        await readerApi.open(paperContext.contextItemId);
        return true;
      }
    }
    const pane = Zotero.getActiveZoteroPane?.() as
      | _ZoteroTypes.ZoteroPane
      | undefined;
    if (pane) {
      if (typeof pane.selectItems === "function") {
        const selected = await pane.selectItems([paperContext.itemId], true);
        if (selected !== false) return true;
      }
      if (typeof pane.selectItem === "function") {
        const selected = pane.selectItem(paperContext.itemId, true);
        if (selected !== false) return true;
      }
      if (paperContext.contextItemId !== paperContext.itemId) {
        if (typeof pane.selectItems === "function") {
          const selected = await pane.selectItems(
            [paperContext.contextItemId],
            true,
          );
          if (selected !== false) return true;
        }
        if (typeof pane.selectItem === "function") {
          const selected = pane.selectItem(paperContext.contextItemId, true);
          if (selected !== false) return true;
        }
      }
    }
    return false;
  };

  const appendPaperChip = (
    ownerDoc: Document,
    list: HTMLDivElement,
    paperContext: PaperContextRef,
    options?: {
      removable?: boolean;
      removableIndex?: number;
      autoLoaded?: boolean;
      fullText?: boolean;
      contentSourceMode?: PaperContentSourceMode;
    },
  ) => {
    const removable = options?.removable === true;
    const fullText = options?.fullText === true;
    const contentSourceMode = options?.contentSourceMode || "text";
    const chip = createElement(
      ownerDoc,
      "div",
      "llm-selected-context llm-paper-context-chip",
    );
    if (options?.autoLoaded) {
      chip.classList.add("llm-paper-context-chip-autoloaded");
      chip.dataset.autoLoaded = "true";
    }
    chip.dataset.paperItemId = `${paperContext.itemId}`;
    chip.dataset.paperContextItemId = `${paperContext.contextItemId}`;
    if (removable) {
      chip.dataset.paperContextIndex = `${options?.removableIndex ?? -1}`;
    }
    chip.dataset.fullText = fullText ? "true" : "false";
    chip.classList.toggle("llm-paper-context-chip-full", fullText);
    chip.dataset.contentSource = contentSourceMode;
    const showPdfChipStyle =
      contentSourceMode === "pdf" && (!isWebChatMode() || fullText);
    const showTextChipStyle =
      contentSourceMode === "text" ||
      (isWebChatMode() && contentSourceMode === "pdf" && !fullText);
    chip.classList.toggle(
      "llm-paper-context-chip-mineru",
      contentSourceMode === "mineru",
    );
    chip.classList.toggle("llm-paper-context-chip-pdf", showPdfChipStyle);
    chip.classList.toggle("llm-paper-context-chip-text", showTextChipStyle);
    chip.classList.add("collapsed");

    const chipHeader = createElement(
      ownerDoc,
      "div",
      "llm-image-preview-header llm-selected-context-header llm-paper-context-chip-header",
    );
    const chipLabel = createElement(
      ownerDoc,
      "span",
      "llm-paper-context-chip-label",
      {
        textContent: formatPaperContextChipLabel(
          paperContext,
          contentSourceMode,
        ),
        title: formatPaperContextChipTitle(paperContext, contentSourceMode),
      },
    );
    chipHeader.append(chipLabel);

    if (removable) {
      const removeBtn = createElement(
        ownerDoc,
        "button",
        "llm-remove-img-btn llm-paper-context-clear",
        {
          type: "button",
          textContent: "×",
          title: `Remove ${paperContext.title}`,
        },
      ) as HTMLButtonElement;
      removeBtn.dataset.paperContextIndex = `${options?.removableIndex ?? -1}`;
      removeBtn.setAttribute("aria-label", `Remove ${paperContext.title}`);
      chipHeader.append(removeBtn);
    }

    // Inline expanded paper card (shown on hover via CSS, or sticky when .expanded class present)
    const chipExpanded = createElement(
      ownerDoc,
      "div",
      "llm-selected-context-expanded llm-paper-context-chip-expanded",
    );
    chipExpanded.appendChild(
      buildPaperChipMenuCard(ownerDoc, paperContext, { contentSourceMode }),
    );
    chip.append(chipExpanded, chipHeader);

    // Restore expanded (sticky) state after re-render
    const currentExpandedId = item
      ? selectedPaperPreviewExpandedCache.get(item.id)
      : undefined;
    if (
      typeof currentExpandedId === "number" &&
      currentExpandedId === paperContext.contextItemId
    ) {
      chip.classList.add("expanded");
      chip.classList.remove("collapsed");
    }
    list.appendChild(chip);
  };

  const appendOtherRefChip = (
    ownerDoc: Document,
    list: HTMLDivElement,
    ref: OtherContextRef,
    removableIndex: number,
  ) => {
    const chip = createElement(
      ownerDoc,
      "div",
      `llm-selected-context llm-other-ref-chip llm-other-ref-chip-${ref.refKind}`,
    );
    chip.dataset.otherRefItemId = `${ref.contextItemId}`;
    chip.dataset.otherRefIndex = `${removableIndex}`;
    chip.classList.add("collapsed");

    const icon = ref.refKind === "figure" ? "🖼" : "📎";
    const chipHeader = createElement(
      ownerDoc,
      "div",
      "llm-image-preview-header llm-selected-context-header llm-other-ref-chip-header",
    );
    const chipLabel = createElement(
      ownerDoc,
      "span",
      "llm-other-ref-chip-label",
      {
        textContent: `${icon} ${ref.title}`,
        title: `${ref.refKind === "figure" ? "Figure" : "File"}: ${ref.title}`,
      },
    );
    const removeBtn = createElement(
      ownerDoc,
      "button",
      "llm-remove-img-btn llm-other-ref-clear",
      {
        type: "button",
        textContent: "×",
        title: `Remove ${ref.title}`,
      },
    ) as HTMLButtonElement;
    removeBtn.dataset.otherRefIndex = `${removableIndex}`;
    removeBtn.setAttribute("aria-label", `Remove ${ref.title}`);
    chipHeader.append(chipLabel, removeBtn);
    chip.appendChild(chipHeader);
    list.appendChild(chip);
  };

  const appendCollectionChip = (
    ownerDoc: Document,
    list: HTMLDivElement,
    ref: CollectionContextRef,
    removableIndex: number,
  ) => {
    const chip = createElement(
      ownerDoc,
      "div",
      "llm-selected-context llm-collection-context-chip",
    );
    chip.dataset.collectionId = `${ref.collectionId}`;
    chip.dataset.collectionIndex = `${removableIndex}`;
    chip.classList.add("collapsed");

    const chipHeader = createElement(
      ownerDoc,
      "div",
      "llm-image-preview-header llm-selected-context-header llm-collection-chip-header",
    );
    const chipLabel = createElement(
      ownerDoc,
      "span",
      "llm-collection-chip-label",
      {
        textContent: `\u{1F5C2}\uFE0F ${ref.name}`,
        title: `Collection: ${ref.name}`,
      },
    );
    const removeBtn = createElement(
      ownerDoc,
      "button",
      "llm-remove-img-btn llm-collection-clear",
      {
        type: "button",
        textContent: "\u00D7",
        title: `Remove ${ref.name}`,
      },
    ) as HTMLButtonElement;
    removeBtn.dataset.collectionIndex = `${removableIndex}`;
    removeBtn.setAttribute("aria-label", `Remove ${ref.name}`);
    chipHeader.append(chipLabel, removeBtn);
    chip.appendChild(chipHeader);
    list.appendChild(chip);
  };

  const updatePaperPreview = () => {
    if (!item || !paperPreview || !paperPreviewList) return;
    closePaperChipMenu();
    const itemId = item.id;
    const autoLoadedPaperContext = resolveAutoLoadedPaperContext();
    const selectedPapers = getManualPaperContextsForItem(
      itemId,
      autoLoadedPaperContext,
    );
    const selectedOtherRefs = selectedOtherRefContextCache.get(itemId) || [];
    const selectedCollections =
      selectedCollectionContextCache.get(itemId) || [];
    const hasAnyContext =
      selectedPapers.length > 0 ||
      selectedOtherRefs.length > 0 ||
      selectedCollections.length > 0 ||
      !!autoLoadedPaperContext;
    if (!hasAnyContext) {
      paperPreview.style.display = "none";
      paperPreviewList.innerHTML = "";
      clearSelectedPaperState(itemId);
      clearPaperContentSourceOverrides(itemId);
      return;
    }
    if (selectedPapers.length) {
      selectedPaperContextCache.set(itemId, selectedPapers);
    } else {
      selectedPaperContextCache.delete(itemId);
      selectedPaperPreviewExpandedCache.delete(itemId);
      // Don't clear mode overrides when an auto-loaded paper exists — its
      // override (e.g. webchat PDF toggle) must survive re-renders.
      if (!autoLoadedPaperContext) {
        clearPaperModeOverrides(itemId);
      }
    }
    // Do not reset expanded state here — preserve which chip was sticky across re-renders
    paperPreview.style.display = "contents";
    paperPreviewList.style.display = "contents";
    paperPreviewList.innerHTML = "";
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc) return;
    if (autoLoadedPaperContext) {
      appendPaperChip(ownerDoc, paperPreviewList, autoLoadedPaperContext, {
        autoLoaded: true,
        fullText: isPaperContextFullTextMode(
          resolvePaperContextNextSendMode(itemId, autoLoadedPaperContext),
        ),
        contentSourceMode: resolvePaperContentSourceMode(
          itemId,
          autoLoadedPaperContext,
        ),
      });
    }
    selectedPapers.forEach((paperContext, index) => {
      appendPaperChip(ownerDoc, paperPreviewList, paperContext, {
        removable: true,
        removableIndex: index,
        fullText: isPaperContextFullTextMode(
          resolvePaperContextNextSendMode(itemId, paperContext),
        ),
        contentSourceMode: resolvePaperContentSourceMode(itemId, paperContext),
      });
    });
    selectedOtherRefs.forEach((ref, index) => {
      appendOtherRefChip(ownerDoc, paperPreviewList, ref, index);
    });
    selectedCollections.forEach((ref, index) => {
      appendCollectionChip(ownerDoc, paperPreviewList, ref, index);
    });
  };

  const updateFilePreview = () => {
    if (
      !item ||
      !filePreview ||
      !filePreviewMeta ||
      !filePreviewExpanded ||
      !filePreviewList
    )
      return;
    const itemId = item.id;
    const allFiles = selectedFileAttachmentCache.get(itemId) || [];
    // Exclude PDF-paper attachments from file preview — they're shown under the paper chip instead
    const files = allFiles.filter(
      (f) =>
        !(
          typeof f.id === "string" &&
          (f.id.startsWith("pdf-paper-") || f.id.startsWith("pdf-page-"))
        ),
    );
    prunePinnedFileKeys(pinnedFileKeys, itemId, files);
    if (!files.length) {
      filePreview.style.display = "none";
      filePreview.classList.remove("expanded", "collapsed");
      filePreviewExpanded.style.display = "none";
      filePreviewMeta.textContent = formatFileCountLabel(0);
      filePreviewMeta.classList.remove("expanded");
      filePreviewMeta.setAttribute("aria-expanded", "false");
      filePreviewMeta.title = t("Expand files panel");
      filePreviewList.innerHTML = "";
      clearSelectedFileState(itemId);
      return;
    }
    let expanded = selectedFilePreviewExpandedCache.get(itemId);
    if (typeof expanded !== "boolean") {
      expanded = false;
      selectedFilePreviewExpandedCache.set(itemId, false);
    }
    filePreview.style.display = "flex";
    filePreview.classList.toggle("expanded", expanded);
    filePreview.classList.toggle("collapsed", !expanded);
    filePreviewExpanded.style.display = "grid";
    filePreviewMeta.textContent = formatFileCountLabel(files.length);
    filePreviewMeta.classList.toggle("expanded", expanded);
    filePreviewMeta.setAttribute("aria-expanded", expanded ? "true" : "false");
    filePreviewMeta.title = expanded
      ? t("Collapse files panel")
      : t("Expand files panel");
    filePreviewList.innerHTML = "";
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc) return;
    files.forEach((attachment, index) => {
      const row = createElement(ownerDoc, "div", "llm-file-context-item");
      row.dataset.fileContextIndex = `${index}`;
      const pinned = isPinnedFile(pinnedFileKeys, itemId, attachment);
      row.classList.toggle("llm-file-context-item-pinned", pinned);
      row.dataset.pinned = pinned ? "true" : "false";
      const type = createElement(ownerDoc, "span", "llm-file-context-type", {
        textContent: getAttachmentTypeLabel(attachment),
        title: attachment.mimeType || attachment.category || "file",
      });
      const info = createElement(ownerDoc, "div", "llm-file-context-text");
      const name = createElement(ownerDoc, "span", "llm-file-context-name", {
        textContent: attachment.name,
        title: attachment.name,
      });
      const meta = createElement(
        ownerDoc,
        "span",
        "llm-file-context-meta-info",
        {
          textContent: `${attachment.mimeType || "application/octet-stream"} · ${(attachment.sizeBytes / 1024 / 1024).toFixed(2)} MB`,
        },
      );
      const removeBtn = createElement(
        ownerDoc,
        "button",
        "llm-file-context-remove",
        {
          type: "button",
          textContent: "×",
          title: `Remove ${attachment.name}`,
        },
      );
      removeBtn.addEventListener("click", (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        if (!item) return;
        const currentFiles = selectedFileAttachmentCache.get(item.id) || [];
        const removedEntry = attachment;
        const nextFiles = currentFiles.filter((f) => f.id !== removedEntry.id);
        removePinnedFile(pinnedFileKeys, item.id, removedEntry);
        if (nextFiles.length) {
          selectedFileAttachmentCache.set(item.id, nextFiles);
        } else {
          clearSelectedFileState(item.id);
        }
        if (
          removedEntry?.storedPath &&
          !removedEntry.contentHash &&
          !isManagedBlobPath(removedEntry.storedPath)
        ) {
          void removeAttachmentFile(removedEntry.storedPath).catch((err) => {
            ztoolkit.log(
              "LLM: Failed to remove discarded attachment file",
              err,
            );
          });
        } else if (removedEntry?.storedPath) {
          scheduleAttachmentGc();
        }
        updateFilePreviewPreservingScroll();
        if (status) {
          setStatus(
            status,
            `${t("Attachment removed")} (${nextFiles.length})`,
            "ready",
          );
        }
      });
      info.append(name, meta);
      row.append(type, info, removeBtn);
      filePreviewList.appendChild(row);
    });
  };

  // Helper to update image preview UI
  const updateImagePreview = () => {
    if (
      !item ||
      !imagePreview ||
      !previewStrip ||
      !previewExpanded ||
      !previewSelected ||
      !previewSelectedImg ||
      !previewMeta ||
      !screenshotBtn
    )
      return;
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc) return;
    const { currentModel } = getSelectedModelInfo();
    const screenshotUnsupported = isScreenshotUnsupportedModel(currentModel);
    const screenshotDisabledHint = getScreenshotDisabledHint(currentModel);
    let selectedImages = selectedImageCache.get(item.id) || [];
    if (screenshotUnsupported && selectedImages.length) {
      clearSelectedImageState(item.id);
      selectedImages = [];
    }
    prunePinnedImageKeys(pinnedImageKeys, item.id, selectedImages);
    if (selectedImages.length) {
      const imageCount = selectedImages.length;
      let expanded = selectedImagePreviewExpandedCache.get(item.id);
      if (typeof expanded !== "boolean") {
        expanded = false;
        selectedImagePreviewExpandedCache.set(item.id, false);
      }

      let activeIndex = selectedImagePreviewActiveIndexCache.get(item.id);
      if (typeof activeIndex !== "number" || !Number.isFinite(activeIndex)) {
        activeIndex = imageCount - 1;
      }
      activeIndex = Math.max(
        0,
        Math.min(imageCount - 1, Math.floor(activeIndex)),
      );
      selectedImagePreviewActiveIndexCache.set(item.id, activeIndex);

      previewMeta.textContent = formatFigureCountLabel(imageCount);
      previewMeta.classList.toggle("expanded", expanded);
      previewMeta.setAttribute("aria-expanded", expanded ? "true" : "false");
      previewMeta.title = expanded
        ? t("Collapse figures panel")
        : t("Expand figures panel");

      imagePreview.style.display = "flex";
      imagePreview.classList.toggle("expanded", expanded);
      imagePreview.classList.toggle("collapsed", !expanded);
      previewExpanded.hidden = false;
      previewExpanded.style.display = "grid";
      previewSelected.style.display = "";

      previewStrip.innerHTML = "";
      for (const [index, imageUrl] of selectedImages.entries()) {
        const thumbItem = createElement(ownerDoc, "div", "llm-preview-item");
        thumbItem.dataset.imageContextIndex = `${index}`;
        const pinned = isPinnedImage(pinnedImageKeys, item.id, imageUrl);
        thumbItem.classList.toggle("llm-preview-item-pinned", pinned);
        thumbItem.dataset.pinned = pinned ? "true" : "false";
        const thumbBtn = createElement(
          ownerDoc,
          "button",
          "llm-preview-thumb",
          {
            type: "button",
            title: `Screenshot ${index + 1}`,
          },
        ) as HTMLButtonElement;
        thumbBtn.classList.toggle("active", index === activeIndex);
        const thumb = createElement(ownerDoc, "img", "llm-preview-img", {
          alt: "Selected screenshot",
        }) as HTMLImageElement;
        thumb.src = imageUrl;
        thumbBtn.appendChild(thumb);
        thumbBtn.addEventListener("click", (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
          if (!item) return;
          selectedImagePreviewActiveIndexCache.set(item.id, index);
          if (selectedImagePreviewExpandedCache.get(item.id) !== true) {
            selectedImagePreviewExpandedCache.set(item.id, true);
          }
          updateImagePreviewPreservingScroll();
        });

        const removeOneBtn = createElement(
          ownerDoc,
          "button",
          "llm-preview-remove-one",
          {
            type: "button",
            textContent: "×",
            title: `Remove screenshot ${index + 1}`,
          },
        );
        removeOneBtn.addEventListener("click", (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
          if (!item) return;
          const currentImages = selectedImageCache.get(item.id) || [];
          if (index < 0 || index >= currentImages.length) return;
          const removedImage = currentImages[index];
          if (removedImage) {
            removePinnedImage(pinnedImageKeys, item.id, removedImage);
          }
          const nextImages = currentImages.filter((_, i) => i !== index);
          if (nextImages.length) {
            selectedImageCache.set(item.id, nextImages);
            let nextActive =
              selectedImagePreviewActiveIndexCache.get(item.id) || 0;
            if (index < nextActive) {
              nextActive -= 1;
            }
            if (nextActive >= nextImages.length) {
              nextActive = nextImages.length - 1;
            }
            selectedImagePreviewActiveIndexCache.set(item.id, nextActive);
          } else {
            clearSelectedImageState(item.id);
          }
          updateImagePreviewPreservingScroll();
          if (status) {
            setStatus(
              status,
              `Screenshot removed (${nextImages.length})`,
              "ready",
            );
          }
        });
        thumbItem.append(thumbBtn, removeOneBtn);
        previewStrip.appendChild(thumbItem);
      }
      previewSelectedImg.src = selectedImages[activeIndex];
      previewSelectedImg.alt = `Selected screenshot ${activeIndex + 1}`;
      screenshotBtn.disabled =
        screenshotUnsupported || imageCount >= MAX_SELECTED_IMAGES;
      screenshotBtn.title = screenshotUnsupported
        ? screenshotDisabledHint
        : imageCount >= MAX_SELECTED_IMAGES
          ? `Max ${MAX_SELECTED_IMAGES} screenshots`
          : `Add screenshot (${imageCount})`;
    } else {
      imagePreview.style.display = "none";
      imagePreview.classList.remove("expanded", "collapsed");
      previewExpanded.hidden = true;
      previewExpanded.style.display = "none";
      previewStrip.innerHTML = "";
      previewSelected.style.display = "none";
      previewSelectedImg.removeAttribute("src");
      previewSelectedImg.alt = "Selected screenshot preview";
      previewMeta.textContent = formatFigureCountLabel(0);
      previewMeta.classList.remove("expanded");
      previewMeta.setAttribute("aria-expanded", "false");
      previewMeta.title = t("Expand figures panel");
      clearSelectedImageState(item.id);
      screenshotBtn.disabled = screenshotUnsupported;
      screenshotBtn.title = screenshotUnsupported
        ? screenshotDisabledHint
        : "Select figure screenshot";
    }
    applyResponsiveActionButtonsLayout();
  };

  const updateSelectedTextPreview = () => {
    if (!item) return;
    const textContextKey = getTextContextConversationKey();
    if (!textContextKey) return;
    applySelectedTextPreview(body, textContextKey);
  };
  const syncConversationPanelState = () => {
    syncRequestUiForCurrentConversation();
    restoreDraftInputForCurrentConversation();
    updatePaperPreview();
    updateFilePreview();
    updateImagePreview();
    updateSelectedTextPreview();
  };
  activeContextPanelStateSync.set(body, syncConversationPanelState);
  const runPanelStateRefreshNow = () => {
    if (!item) {
      runWithChatScrollGuard(syncConversationPanelState);
      return;
    }
    refreshConversationPanels(body, item, {
      includeChat: false,
      includePanelState: true,
    });
  };
  const panelStateRefreshScheduler = createCoalescedFrameScheduler({
    getWindow: () => body.ownerDocument?.defaultView || null,
    run: runPanelStateRefreshNow,
  });
  const schedulePanelStateRefresh = () => {
    panelStateRefreshScheduler.schedule();
  };
  const flushPanelStateRefreshNow = () => {
    panelStateRefreshScheduler.flush();
  };
  const updatePaperPreviewPreservingScroll = () => {
    schedulePanelStateRefresh();
  };
  const updateFilePreviewPreservingScroll = () => {
    schedulePanelStateRefresh();
  };
  const updateImagePreviewPreservingScroll = () => {
    schedulePanelStateRefresh();
  };
  const updateSelectedTextPreviewPreservingScroll = () => {
    schedulePanelStateRefresh();
  };
  const refreshChatPreservingScroll = () => {
    if (!item) {
      runWithChatScrollGuard(() => {
        refreshChat(body, item);
      });
      return;
    }
    refreshConversationPanels(body, item);
  };

  resetComposePreviewUI = () => {
    updatePaperPreviewPreservingScroll();
    updateFilePreviewPreservingScroll();
    updateImagePreviewPreservingScroll();
    updateSelectedTextPreviewPreservingScroll();
  };

  const historyLifecycleController = createHistoryLifecycleController({
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
    getItem: () => item,
    setItem: (nextItem) => {
      item = nextItem as any;
    },
    getBasePaperItem: () => basePaperItem,
    setBasePaperItem: (nextItem) => {
      basePaperItem = nextItem;
    },
    getConversationSystem,
    isClaudeConversationSystem,
    isCodexConversationSystem,
    isRuntimeConversationSystem,
    isNoteSession,
    isGlobalMode,
    isPaperMode,
    isWebChatMode,
    getCurrentLibraryID,
    resolveCurrentPaperBaseItem,
    getManualPaperContextsForItem,
    resolveAutoLoadedPaperContext,
    persistDraftInputForCurrentConversation,
    restoreDraftInputForCurrentConversation,
    syncConversationIdentity,
    syncQueuedFollowUpRegistration,
    updateRuntimeModeButton,
    updateClaudeSystemToggle,
    refreshChatPreservingScroll,
    resetComposePreviewUI,
    updateModelButton: () => updateModelButton(),
    updateReasoningButton: () => updateReasoningButton(),
    updatePaperPreviewPreservingScroll,
    clearForcedSkill: () => clearForcedSkill(),
    closePaperPicker: () => closePaperPicker(),
    closePromptMenu,
    closeResponseMenu,
    closeRetryModelMenu,
    closeExportMenu,
    closeHistoryRowMenu,
    closeHistoryNewMenu,
    closeHistoryMenu,
    isHistoryMenuOpen,
    isHistoryNewMenuOpen,
    runWithChatScrollGuard,
    clearSelectedImageState,
    clearSelectedFileState,
    clearSelectedTextState,
    clearDraftInputState,
    clearTransientComposeStateForItem,
    scheduleAttachmentGc,
    notifyConversationHistoryChanged,
    renderWebChatHistoryMenu: () => renderWebChatHistoryMenu(),
    closeModelMenu: () => closeModelMenu(),
    closeReasoningMenu: () => closeReasoningMenu(),
    closeSlashMenu: () => closeSlashMenu(),
    getSelectedModelInfo: () => getSelectedModelInfo(),
    markNextWebChatSendAsNewChat: () => markNextWebChatSendAsNewChat(),
    primeFreshWebChatPaperChipState: () => primeFreshWebChatPaperChipState(),
    updateImagePreviewPreservingScroll,
    getPreferredTargetSystem,
    switchConversationSystem,
    setActiveEditSession: (value) => {
      activeEditSession = value;
    },
    getCoreAgentRuntime,
    setStatusMessage: status
      ? (message, level) => {
          setStatus(status, message, level);
        }
      : undefined,
    log: (message, ...args) => {
      ztoolkit.log(message, ...args);
    },
  });
  refreshGlobalHistoryHeader =
    historyLifecycleController.refreshGlobalHistoryHeader;
  switchGlobalConversation =
    historyLifecycleController.switchGlobalConversation;
  switchPaperConversation = historyLifecycleController.switchPaperConversation;
  createAndSwitchGlobalConversation =
    historyLifecycleController.createAndSwitchGlobalConversation;
  createAndSwitchPaperConversation =
    historyLifecycleController.createAndSwitchPaperConversation;
  queueTurnDeletion = historyLifecycleController.queueTurnDeletion;
  clearPendingTurnDeletion =
    historyLifecycleController.clearPendingTurnDeletion;
  resetHistorySearchState = historyLifecycleController.resetHistorySearchState;
  hasPendingTurnDeletionForConversation =
    historyLifecycleController.hasPendingTurnDeletionForConversation;

  const getModelChoices = () => {
    const choices = isClaudeConversationSystem()
      ? getClaudeRuntimeModelEntries()
      : isCodexConversationSystem()
        ? getCodexRuntimeModelEntries()
        : getAvailableModelEntries();
    const groupedChoices: Array<{
      providerLabel: string;
      entries: RuntimeModelEntry[];
    }> = [];
    const groupedByProvider = new Map<string, RuntimeModelEntry[]>();

    for (const entry of choices) {
      const existing = groupedByProvider.get(entry.providerLabel);
      if (existing) {
        existing.push(entry);
        continue;
      }
      const entries = [entry];
      groupedByProvider.set(entry.providerLabel, entries);
      groupedChoices.push({
        providerLabel: entry.providerLabel,
        entries,
      });
    }

    return { choices, groupedChoices };
  };

  getSelectedModelInfo = () => {
    const { choices, groupedChoices } = getModelChoices();
    const selectedEntry = isClaudeConversationSystem()
      ? getSelectedClaudeRuntimeEntry()
      : isCodexConversationSystem()
        ? getSelectedCodexRuntimeEntry()
        : item
          ? getSelectedModelEntryForItem(item.id)
          : null;
    const currentModel =
      selectedEntry?.model ||
      choices[0]?.model ||
      getStringPref("modelPrimary") ||
      getStringPref("model") ||
      "default";
    const currentModelDisplay =
      selectedEntry?.displayModelLabel || currentModel;
    const currentModelHint = selectedEntry
      ? `${selectedEntry.providerLabel} · ${selectedEntry.displayModelLabel || selectedEntry.model}`
      : currentModel;
    return {
      selectedEntryId: selectedEntry?.entryId || "",
      selectedEntry,
      choices,
      groupedChoices,
      currentModel,
      currentModelDisplay,
      currentModelHint,
    };
  };

  updateModelButton = () => {
    if (!item || !modelBtn) return;
    withScrollGuard(chatBox, conversationKey, () => {
      const { choices, currentModel, currentModelDisplay, currentModelHint } =
        getSelectedModelInfo();
      const hasSecondary = choices.length > 1;
      modelBtn.dataset.modelLabel = `${currentModelDisplay || currentModel || "default"}`;
      modelBtn.dataset.modelHint = hasSecondary
        ? currentModelHint
        : currentModelHint || "Only one model is configured";
      modelBtn.disabled = !item;
      scheduleResponsiveLayoutSync();
      updateImagePreviewPreservingScroll();
    });
  };

  const isPrimaryPointerEvent = (e: Event): boolean => {
    const me = e as MouseEvent;
    return typeof me.button !== "number" || me.button === 0;
  };

  const appendDropdownInstruction = (
    menu: HTMLDivElement,
    text: string,
    className: string,
  ) => {
    const hint = createElement(
      body.ownerDocument as Document,
      "div",
      className,
      {
        textContent: text,
      },
    );
    hint.setAttribute("aria-hidden", "true");
    menu.appendChild(hint);
  };

  const appendModelProviderSection = (
    menu: HTMLDivElement,
    providerLabel: string,
  ) => {
    const section = createElement(
      body.ownerDocument as Document,
      "div",
      "llm-model-menu-section",
      {
        textContent: providerLabel,
      },
    );
    section.setAttribute("aria-hidden", "true");
    menu.appendChild(section);
  };

  const appendModelMenuEmptyState = (menu: HTMLDivElement, text: string) => {
    const empty = createElement(
      body.ownerDocument as Document,
      "div",
      "llm-model-menu-empty",
      {
        textContent: text,
      },
    );
    empty.setAttribute("aria-hidden", "true");
    menu.appendChild(empty);
  };

  const rebuildModelMenu = () => {
    if (!item || !modelMenu) return;
    const { groupedChoices, selectedEntryId } = getSelectedModelInfo();

    modelMenu.innerHTML = "";
    appendDropdownInstruction(
      modelMenu,
      t("Select model"),
      "llm-model-menu-hint",
    );
    if (!groupedChoices.length) {
      appendModelMenuEmptyState(modelMenu, t("No models configured yet."));
      return;
    }

    for (const group of groupedChoices) {
      appendModelProviderSection(modelMenu, group.providerLabel);
      for (const entry of group.entries) {
        const isSelected = entry.entryId === selectedEntryId;
        const option = createElement(
          body.ownerDocument as Document,
          "button",
          "llm-response-menu-item llm-model-option",
          {
            type: "button",
            textContent: isSelected
              ? `\u2713 ${entry.displayModelLabel || "default"}`
              : entry.displayModelLabel || "default",
            title: `${entry.providerLabel} · ${entry.model}`,
          },
        );
        const applyModelSelection = (e: Event) => {
          if (!isPrimaryPointerEvent(e)) return;
          e.preventDefault();
          e.stopPropagation();
          if (!item) return;
          if (isClaudeConversationSystem()) {
            clearClaudeReasoningDisplayOverride();
            setClaudeRuntimeModelPref(entry.model);
            setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, false);
            setFloatingMenuOpen(
              reasoningMenu,
              REASONING_MENU_OPEN_CLASS,
              false,
            );
            updateModelButton();
            updateReasoningButton();
            return;
          }
          if (isCodexConversationSystem()) {
            setCodexRuntimeModelPref(entry.model);
            setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, false);
            setFloatingMenuOpen(
              reasoningMenu,
              REASONING_MENU_OPEN_CLASS,
              false,
            );
            updateModelButton();
            updateReasoningButton();
            return;
          }
          // [webchat] Remember current model before switching to webchat
          const wasWebChat = isWebChatMode();
          if (!wasWebChat && entry.authMode === "webchat") {
            const { selectedEntryId } = getSelectedModelInfo();
            previousNonWebchatModelId = selectedEntryId || null;
          }

          setSelectedModelEntryForItem(item.id, entry.entryId);
          setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, false);
          setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);

          // Auto-correct PDF mode for models that don't support native full-PDF
          // input. Downgrade to text/mineru so the user doesn't end up with a
          // broken send.
          const newPdfSupport = getModelPdfSupport(
            entry.model,
            entry.providerProtocol,
            entry.authMode,
            entry.apiBase,
          );
          const shouldDowngrade = newPdfSupport !== "native";
          if (shouldDowngrade) {
            const papers = getManualPaperContextsForItem(
              item.id,
              resolveAutoLoadedPaperContext(),
            );
            let didDowngrade = false;
            for (const pc of papers) {
              if (resolvePaperContentSourceMode(item.id, pc) === "pdf") {
                const mineruAvailable = isPaperContextMineru(pc);
                setPaperContentSourceOverride(
                  item.id,
                  pc,
                  mineruAvailable ? "mineru" : "text",
                );
                didDowngrade = true;
              }
            }
            if (didDowngrade) {
              updatePaperPreviewPreservingScroll();
              if (status) {
                setStatus(
                  status,
                  t(
                    "Full PDF mode is only available for native PDF providers. Switched to Text/MinerU mode.",
                  ),
                  "warning",
                );
              }
            }
          }

          // [webchat] Entering webchat mode → fresh session, then apply webchat UI AFTER re-render
          if (entry.authMode === "webchat" && !wasWebChat) {
            markNextWebChatSendAsNewChat();
            primeFreshWebChatPaperChipState();
            // Clear cached images so stale screenshots don't auto-attach to ChatGPT
            if (item) {
              selectedImageCache.delete(item.id);
              updateImagePreviewPreservingScroll();
            }
            // Set active target BEFORE applyWebChatModeUI so the hook's
            // renderWebChatSidebar() reads the correct target for filtering.
            try {
              const { getWebChatTargetByModelName: getEntryTarget } =
                require("../../webchat/types") as typeof import("../../webchat/types");
              const { relaySetActiveTarget: setTarget } =
                require("../../webchat/relayServer") as typeof import("../../webchat/relayServer");
              const earlyTargetEntry = getEntryTarget(entry.model || "");
              if (earlyTargetEntry?.id) setTarget(earlyTargetEntry.id);
            } catch {
              /* modules not yet loaded — async path below will handle it */
            }
            // Apply webchat UI immediately so model button is disabled during preload
            applyWebChatModeUI();
            void (async () => {
              if (isGlobalMode()) {
                await createAndSwitchGlobalConversation();
              } else {
                await createAndSwitchPaperConversation();
              }

              // Show preloading screen to verify connectivity before enabling webchat
              const chatShellEl = body.querySelector(
                ".llm-chat-shell",
              ) as HTMLElement | null;
              if (chatShellEl) {
                try {
                  abortWebChatPreload();
                  const token = { aborted: false };
                  webchatPreloadAbort = token;
                  const { showWebChatPreloadScreen } =
                    await import("../../webchat/preloadScreen");
                  const { getWebChatTargetByModelName } =
                    await import("../../webchat/types");
                  const { relaySetActiveTarget } =
                    await import("../../webchat/relayServer");
                  const webchatProfile = getSelectedProfile();
                  const webchatTargetEntry = getWebChatTargetByModelName(
                    webchatProfile?.model || "",
                  );
                  // Tell the relay (and thereby the extension) which site to use
                  if (webchatTargetEntry?.id)
                    relaySetActiveTarget(webchatTargetEntry.id);
                  await showWebChatPreloadScreen(
                    chatShellEl,
                    token,
                    webchatTargetEntry?.label,
                    webchatTargetEntry?.modelName,
                  );
                } catch {
                  // Preload failed or was aborted — still apply UI (dot will show status)
                } finally {
                  webchatPreloadAbort = null;
                }
              }

              // If user exited webchat during preload, don't re-apply webchat UI
              if (!isWebChatMode()) return;
              // Re-apply after conversation switch re-renders (refreshes connection dot etc.)
              applyWebChatModeUI();
            })();
          } else {
            applyWebChatModeUI();
          }

          updateModelButton();
          updateReasoningButton();
        };
        option.addEventListener("pointerdown", applyModelSelection);
        option.addEventListener("click", applyModelSelection);
        modelMenu.appendChild(option);
      }
    }
  };

  const rebuildRetryModelMenu = () => {
    if (!item || !retryModelMenu) return;
    const { groupedChoices } = getModelChoices();
    // Show checkmark on the model that generated the current response, not the currently selected model
    const convKey = getConversationKey(item);
    const historyForRetry = chatHistory.get(convKey) || [];
    const latestPair = findLatestRetryPair(historyForRetry);
    const latestAssistantModelName =
      latestPair?.assistantMessage?.modelName?.trim() || "";
    const latestAssistantModelEntryId =
      latestPair?.assistantMessage?.modelEntryId?.trim() || "";
    const latestAssistantProviderLabel =
      latestPair?.assistantMessage?.modelProviderLabel?.trim() || "";
    const matchingLegacyEntries = latestAssistantModelName
      ? groupedChoices.flatMap((group) =>
          group.entries.filter(
            (entry) => entry.model === latestAssistantModelName,
          ),
        )
      : [];
    retryModelMenu.innerHTML = "";
    if (!groupedChoices.length) {
      appendModelMenuEmptyState(retryModelMenu, t("No models configured yet."));
      return;
    }
    for (const group of groupedChoices) {
      appendModelProviderSection(retryModelMenu, group.providerLabel);
      for (const entry of group.entries) {
        const isSelected = latestAssistantModelEntryId
          ? entry.entryId === latestAssistantModelEntryId
          : latestAssistantModelName
            ? entry.model === latestAssistantModelName &&
              (latestAssistantProviderLabel
                ? entry.providerLabel === latestAssistantProviderLabel
                : matchingLegacyEntries.length === 1)
            : false;
        const option = createElement(
          body.ownerDocument as Document,
          "button",
          "llm-response-menu-item llm-model-option",
          {
            type: "button",
            textContent: isSelected
              ? `\u2713 ${entry.displayModelLabel || "default"}`
              : entry.displayModelLabel || "default",
            title: `${entry.providerLabel} · ${entry.model}`,
          },
        );
        const runRetry = async (e: Event) => {
          if (!isPrimaryPointerEvent(e)) return;
          e.preventDefault();
          e.stopPropagation();
          if (!item) return;
          closeRetryModelMenu();
          const retryReasoning = getSelectedReasoningForItem(
            item.id,
            entry.model,
            entry.apiBase,
            entry.providerProtocol,
          );
          const retryAdvanced = getAdvancedModelParams(entry.entryId);
          await retryLatestAssistantResponse(
            body,
            item,
            entry.model,
            entry.apiBase,
            entry.apiKey,
            entry.authMode,
            entry.providerProtocol,
            entry.entryId,
            entry.providerLabel,
            retryReasoning,
            retryAdvanced,
          );
        };
        option.addEventListener("click", (e: Event) => {
          void runRetry(e);
        });
        retryModelMenu.appendChild(option);
      }
    }
  };

  type ClaudeReasoningDisplayMode =
    | "auto"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";

  let claudeReasoningDisplayOverride: {
    mode: ClaudeReasoningDisplayMode;
    modelKey: string;
  } | null = null;

  const getClaudeReasoningDisplayScopeKey = () => {
    const { selectedEntryId, currentModel } = getSelectedModelInfo();
    return `${selectedEntryId || "claude-runtime"}::${currentModel}`;
  };

  const normalizeClaudeReasoningDisplayMode = (
    value: unknown,
  ): ClaudeReasoningDisplayMode | null => {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === "default" || normalized === "none") return "auto";
    if (
      normalized === "auto" ||
      normalized === "low" ||
      normalized === "medium" ||
      normalized === "high" ||
      normalized === "xhigh" ||
      normalized === "max"
    ) {
      return normalized;
    }
    return null;
  };

  const getClaudeReasoningDisplayMode = (): ClaudeReasoningDisplayMode => {
    if (claudeReasoningDisplayOverride) {
      if (
        claudeReasoningDisplayOverride.modelKey ===
        getClaudeReasoningDisplayScopeKey()
      ) {
        return claudeReasoningDisplayOverride.mode;
      }
      claudeReasoningDisplayOverride = null;
    }
    return getClaudeReasoningModePref();
  };

  const getClaudeReasoningDisplayLabel = (mode: ClaudeReasoningDisplayMode) => {
    if (mode === "auto") return "Auto";
    if (mode === "xhigh") return "XHigh";
    if (mode === "max") return "Max";
    if (mode === "high") return "High";
    if (mode === "medium") return "Medium";
    if (mode === "low") return "Low";
    return "Auto";
  };

  const buildClaudeReasoningConfigForDisplayMode = (
    mode: ClaudeReasoningDisplayMode,
  ): LLMReasoningConfig | undefined => {
    if (mode === "auto") return undefined;
    return {
      provider: "anthropic",
      level: mode === "max" ? "xhigh" : mode,
    };
  };

  const clearClaudeReasoningDisplayOverride = () => {
    claudeReasoningDisplayOverride = null;
  };

  const applyClaudeResolvedReasoningDisplay = (effort: unknown) => {
    if (!isClaudeConversationSystem()) return;
    const mode = normalizeClaudeReasoningDisplayMode(effort);
    if (!mode) return;
    if (mode === getClaudeReasoningModePref()) {
      claudeReasoningDisplayOverride = null;
    } else {
      claudeReasoningDisplayOverride = {
        mode,
        modelKey: getClaudeReasoningDisplayScopeKey(),
      };
    }
    updateReasoningButton();
    if (isFloatingMenuOpen(reasoningMenu)) {
      rebuildReasoningMenu();
    }
  };

  const getReasoningState = () => {
    if (!item) {
      return {
        provider: "unsupported" as const,
        currentModel: "",
        options: [] as ReasoningOption[],
        enabledLevels: [] as LLMReasoningLevel[],
        selectedLevel: "none" as ReasoningLevelSelection,
      };
    }
    const { currentModel } = getSelectedModelInfo();
    if (isClaudeConversationSystem()) {
      const selectedMode = getClaudeReasoningDisplayMode();
      const options: ReasoningOption[] = [
        { level: "low", enabled: true, label: "Low" },
        { level: "medium", enabled: true, label: "Medium" },
        { level: "high", enabled: true, label: "High" },
        { level: "xhigh", enabled: true, label: "XHigh" },
        {
          level: "xhigh",
          enabled: true,
          label: "Max",
        },
      ];
      const selectedLevel =
        selectedMode === "auto"
          ? "none"
          : selectedMode === "max"
            ? ("xhigh" as ReasoningLevelSelection)
            : (selectedMode as ReasoningLevelSelection);
      return {
        provider: "anthropic" as const,
        currentModel,
        options,
        enabledLevels: options.map((option) => option.level),
        selectedLevel,
      };
    }
    if (isCodexConversationSystem()) {
      const selectedMode = getCodexReasoningModePref();
      const options: ReasoningOption[] = [
        { level: "low", enabled: true, label: "Low" },
        { level: "medium", enabled: true, label: "Medium" },
        { level: "high", enabled: true, label: "High" },
        { level: "xhigh", enabled: true, label: "XHigh" },
      ];
      return {
        provider: "openai" as const,
        currentModel,
        options,
        enabledLevels: options.map((option) => option.level),
        selectedLevel:
          selectedMode === "auto"
            ? "none"
            : (selectedMode as ReasoningLevelSelection),
      };
    }
    const selectedProfile = getSelectedModelEntryForItem(item.id);
    const provider = detectReasoningProvider(currentModel);
    const options = getReasoningOptions(
      provider,
      currentModel,
      selectedProfile?.apiBase,
      selectedProfile?.providerProtocol,
    );
    const enabledLevels = options
      .filter((option) => option.enabled)
      .map((option) => option.level);
    const cachedProvider = selectedReasoningProviderCache.get(item.id);
    const cachedLevel =
      cachedProvider === provider ? selectedReasoningCache.get(item.id) : null;
    let selectedLevel =
      cachedLevel ||
      getLastUsedReasoningLevelForProvider(provider) ||
      (provider === "anthropic"
        ? "none"
        : getLastUsedReasoningLevel() || "none");
    if (provider === "anthropic") {
      if (!enabledLevels.includes(selectedLevel as LLMReasoningLevel)) {
        selectedLevel = "none";
      }
    } else if (enabledLevels.length > 0) {
      if (
        selectedLevel === "none" ||
        !enabledLevels.includes(selectedLevel as LLMReasoningLevel)
      ) {
        selectedLevel = enabledLevels[0];
      }
    } else {
      selectedLevel = "none";
    }
    selectedReasoningCache.set(item.id, selectedLevel);
    selectedReasoningProviderCache.set(item.id, provider);
    return { provider, currentModel, options, enabledLevels, selectedLevel };
  };

  // [webchat] ChatGPT mode options: maps reasoning levels to ChatGPT modes
  const WEBCHAT_MODES: Array<{
    level: string;
    label: string;
    chatgptMode: string | undefined;
  }> = [
    { level: "none", label: "Instant", chatgptMode: "instant" },
    {
      level: "medium",
      label: "Standard Thinking",
      chatgptMode: "thinking_standard",
    },
    {
      level: "high",
      label: "Extended Thinking",
      chatgptMode: "thinking_extended",
    },
  ];

  isWebChatMode = () => {
    const { selectedEntry } = getSelectedModelInfo();
    return selectedEntry?.authMode === "webchat";
  };
  isWebChatModeActive = () => {
    try {
      return isWebChatMode();
    } catch (_err) {
      void _err;
      return panelRoot.dataset.webchatMode === "true";
    }
  };

  // [webchat] Remember the previous model so "Exit" can restore it
  let previousNonWebchatModelId: string | null = null;
  let webchatForceNewChatOnNextSend = false;
  let webchatPdfUploadedInCurrentConversation = false;
  let webchatConnectionTimer: ReturnType<typeof setInterval> | null = null;
  // Simple abort token — Zotero's Gecko context lacks AbortController.
  let webchatPreloadAbort: { aborted: boolean } | null = null;

  const abortWebChatPreload = () => {
    if (webchatPreloadAbort) {
      webchatPreloadAbort.aborted = true;
      webchatPreloadAbort = null;
    }
  };

  markNextWebChatSendAsNewChat = () => {
    webchatForceNewChatOnNextSend = true;
    webchatPdfUploadedInCurrentConversation = false;
  };

  const clearNextWebChatNewChatIntent = () => {
    webchatForceNewChatOnNextSend = false;
  };

  const consumeWebChatForceNewChatIntent = () => {
    const shouldForce = webchatForceNewChatOnNextSend;
    webchatForceNewChatOnNextSend = false;
    return shouldForce;
  };

  primeFreshWebChatPaperChipState = () => {
    if (!item) return;
    const autoLoadedPaperContext = resolveAutoLoadedPaperContext();
    if (autoLoadedPaperContext) {
      // Default to "full-next" (purple chip = send PDF to ChatGPT).
      // Users can right-click the chip to toggle to "retrieval" (grey)
      // when they want to skip attaching the PDF.
      setPaperModeOverride(item.id, autoLoadedPaperContext, "full-next");
    }
    updatePaperPreviewPreservingScroll();
  };

  const hasUploadedPdfInCurrentWebChatConversation = () =>
    webchatPdfUploadedInCurrentConversation;

  const markWebChatPdfUploadedForCurrentConversation = () => {
    webchatPdfUploadedInCurrentConversation = true;
  };

  const resetWebChatPdfUploadedForCurrentConversation = () => {
    webchatPdfUploadedInCurrentConversation = false;
  };

  // Expose webchat intent clearing via hooks so standalone can call it
  // when loading a conversation from its own sidebar/popup.
  if (hooks) {
    hooks.clearWebChatNewChatIntent = () => {
      clearNextWebChatNewChatIntent();
      resetWebChatPdfUploadedForCurrentConversation();
    };
    hooks.getCurrentModelName = () =>
      getSelectedModelInfo().currentModel || null;
  }

  const startWebChatConnectionCheck = (dot: HTMLElement) => {
    stopWebChatConnectionCheck();
    const check = async () => {
      try {
        // Always use dynamic port — saved apiBase may be stale
        const { getRelayBaseUrl } = await import("../../webchat/relayServer");
        const host = getRelayBaseUrl();
        const { testConnection } = await import("../../webchat/client");
        const alive = await testConnection(host);
        dot.className = alive
          ? "llm-webchat-dot llm-webchat-dot-connected"
          : "llm-webchat-dot llm-webchat-dot-disconnected";
      } catch {
        dot.className = "llm-webchat-dot llm-webchat-dot-disconnected";
      }
    };
    void check(); // immediate first check
    webchatConnectionTimer = setInterval(check, 5000);
  };

  const stopWebChatConnectionCheck = () => {
    if (webchatConnectionTimer !== null) {
      clearInterval(webchatConnectionTimer);
      webchatConnectionTimer = null;
    }
  };

  updateReasoningButton = () => {
    if (!item || !reasoningBtn) return;
    withScrollGuard(chatBox, conversationKey, () => {
      // [webchat] Hide reasoning dropdown — users control thinking mode on chatgpt.com
      if (isWebChatMode()) {
        reasoningBtn.style.display = "none";
        scheduleResponsiveLayoutSync();
        return;
      }
      reasoningBtn.style.display = "";

      const { provider, currentModel, options, enabledLevels, selectedLevel } =
        getReasoningState();
      const available = enabledLevels.length > 0;
      const resolvedReasoningLabel = isClaudeConversationSystem()
        ? (() => {
            return getClaudeReasoningDisplayLabel(
              getClaudeReasoningDisplayMode(),
            );
          })()
        : isCodexConversationSystem()
          ? (() => {
              const mode = getCodexReasoningModePref();
              if (mode === "auto") return "Auto";
              if (mode === "xhigh") return "XHigh";
              return mode.charAt(0).toUpperCase() + mode.slice(1);
            })()
          : selectedLevel === "none"
            ? "off"
            : available
              ? getReasoningLevelDisplayLabel(
                  selectedLevel as LLMReasoningLevel,
                  provider,
                  currentModel,
                  options,
                )
              : "off";
      const active =
        available && isReasoningDisplayLabelActive(resolvedReasoningLabel);
      const reasoningLabel = resolvedReasoningLabel;
      reasoningBtn.disabled = !item;
      reasoningBtn.classList.toggle(
        "llm-reasoning-btn-unavailable",
        !available,
      );
      reasoningBtn.classList.toggle("llm-reasoning-btn-active", active);
      reasoningBtn.style.background = "";
      reasoningBtn.style.borderColor = "";
      reasoningBtn.style.color = "";
      const reasoningHint = "Click to adjust reasoning level";
      reasoningBtn.dataset.reasoningLabel = reasoningLabel;
      reasoningBtn.dataset.reasoningHint = reasoningHint;
      scheduleResponsiveLayoutSync();
    });
  };

  const rebuildReasoningMenu = () => {
    if (!item || !reasoningMenu) return;
    const { provider, currentModel, options, selectedLevel, enabledLevels } =
      getReasoningState();
    reasoningMenu.innerHTML = "";

    // [webchat] Show dedicated ChatGPT mode options
    if (isWebChatMode()) {
      reasoningMenu.innerHTML = "";
      appendDropdownInstruction(
        reasoningMenu,
        "Webchat mode",
        "llm-reasoning-menu-section",
      );
      const currentSel = selectedReasoningCache.get(item.id) || "none";
      for (const mode of WEBCHAT_MODES) {
        const isSelected = currentSel === mode.level;
        const option = createElement(
          body.ownerDocument as Document,
          "button",
          "llm-response-menu-item llm-reasoning-option",
          {
            type: "button",
            textContent: isSelected ? `\u2713 ${mode.label}` : mode.label,
          },
        );
        const applyMode = (e: Event) => {
          if (!isPrimaryPointerEvent(e)) return;
          e.preventDefault();
          e.stopPropagation();
          if (!item) return;
          if (isClaudeConversationSystem()) {
            clearClaudeReasoningDisplayOverride();
            setClaudeReasoningModePref(
              mode.level === "none" ? "auto" : (mode.level as any),
            );
          } else {
            selectedReasoningCache.clear();
            selectedReasoningCache.set(item.id, mode.level as any);
            selectedReasoningProviderCache.set(item.id, "unsupported");
            setLastUsedReasoningLevel(mode.level as any);
          }
          setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
          updateReasoningButton();
        };
        option.addEventListener("pointerdown", applyMode);
        option.addEventListener("click", applyMode);
        reasoningMenu.appendChild(option);
      }
      return;
    }

    appendDropdownInstruction(
      reasoningMenu,
      t("Reasoning level"),
      "llm-reasoning-menu-section",
    );
    if (isClaudeConversationSystem()) {
      const claudeModes: Array<{
        value: "auto" | "low" | "medium" | "high" | "xhigh" | "max";
        label: string;
      }> = [
        { value: "auto", label: "Auto" },
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "XHigh" },
        { value: "max", label: "Max" },
      ];
      const currentMode = getClaudeReasoningDisplayMode();
      for (const mode of claudeModes) {
        const option = createElement(
          body.ownerDocument as Document,
          "button",
          "llm-response-menu-item llm-reasoning-option",
          {
            type: "button",
            textContent:
              currentMode === mode.value ? `\u2713 ${mode.label}` : mode.label,
          },
        );
        const applyClaudeSelection = (e: Event) => {
          if (!isPrimaryPointerEvent(e)) return;
          e.preventDefault();
          e.stopPropagation();
          if (!item) return;
          clearClaudeReasoningDisplayOverride();
          setClaudeReasoningModePref(mode.value as any);
          setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
          updateReasoningButton();
        };
        option.addEventListener("pointerdown", applyClaudeSelection);
        option.addEventListener("click", applyClaudeSelection);
        reasoningMenu.appendChild(option);
      }
      return;
    }
    if (isCodexConversationSystem()) {
      const codexModes: Array<{
        value: "auto" | "low" | "medium" | "high" | "xhigh";
        label: string;
      }> = [
        { value: "auto", label: "Auto" },
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "XHigh" },
      ];
      const currentMode = getCodexReasoningModePref();
      for (const mode of codexModes) {
        const option = createElement(
          body.ownerDocument as Document,
          "button",
          "llm-response-menu-item llm-reasoning-option",
          {
            type: "button",
            textContent:
              currentMode === mode.value ? `\u2713 ${mode.label}` : mode.label,
          },
        );
        const applyCodexSelection = (e: Event) => {
          if (!isPrimaryPointerEvent(e)) return;
          e.preventDefault();
          e.stopPropagation();
          setCodexReasoningModePref(mode.value);
          setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
          updateReasoningButton();
        };
        option.addEventListener("pointerdown", applyCodexSelection);
        option.addEventListener("click", applyCodexSelection);
        reasoningMenu.appendChild(option);
      }
      return;
    }
    if (!enabledLevels.length) {
      const offOption = createElement(
        body.ownerDocument as Document,
        "button",
        "llm-response-menu-item llm-reasoning-option",
        {
          type: "button",
          textContent: "\u2713 off",
        },
      );
      const applyOffSelection = (e: Event) => {
        if (!isPrimaryPointerEvent(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (!item) return;
        if (isClaudeConversationSystem()) {
          clearClaudeReasoningDisplayOverride();
          setClaudeReasoningModePref("auto");
        } else {
          selectedReasoningCache.clear();
          selectedReasoningCache.set(item.id, "none");
          selectedReasoningProviderCache.set(item.id, provider);
          setLastUsedReasoningLevelForProvider(provider, "none");
          if (provider !== "anthropic") {
            setLastUsedReasoningLevel("none");
          }
        }
        setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
        updateReasoningButton();
      };
      offOption.addEventListener("pointerdown", applyOffSelection);
      offOption.addEventListener("click", applyOffSelection);
      reasoningMenu.appendChild(offOption);
      return;
    }
    if (provider === "anthropic") {
      const isSelected = selectedLevel === "none";
      const offOption = createElement(
        body.ownerDocument as Document,
        "button",
        "llm-response-menu-item llm-reasoning-option",
        {
          type: "button",
          textContent: isSelected ? "\u2713 Off" : "Off",
        },
      );
      const applyAnthropicOffSelection = (e: Event) => {
        if (!isPrimaryPointerEvent(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (!item) return;
        selectedReasoningCache.set(item.id, "none");
        selectedReasoningProviderCache.set(item.id, provider);
        setLastUsedReasoningLevelForProvider(provider, "none");
        setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
        updateReasoningButton();
      };
      offOption.addEventListener("pointerdown", applyAnthropicOffSelection);
      offOption.addEventListener("click", applyAnthropicOffSelection);
      reasoningMenu.appendChild(offOption);
    }
    for (const optionState of options) {
      const level = optionState.level;
      const option = createElement(
        body.ownerDocument as Document,
        "button",
        "llm-response-menu-item llm-reasoning-option",
        {
          type: "button",
          textContent:
            selectedLevel === level
              ? `\u2713 ${getReasoningLevelDisplayLabel(level, provider, currentModel, options)}`
              : getReasoningLevelDisplayLabel(
                  level,
                  provider,
                  currentModel,
                  options,
                ),
        },
      );
      if (optionState.enabled) {
        const applyReasoningSelection = (e: Event) => {
          if (!isPrimaryPointerEvent(e)) return;
          e.preventDefault();
          e.stopPropagation();
          if (!item) return;
          if (isClaudeConversationSystem()) {
            const nextMode = optionState.label === "Max" ? "max" : level;
            clearClaudeReasoningDisplayOverride();
            setClaudeReasoningModePref(nextMode as any);
          } else {
            selectedReasoningCache.clear();
            selectedReasoningCache.set(item.id, level);
            selectedReasoningProviderCache.set(item.id, provider);
            setLastUsedReasoningLevelForProvider(provider, level);
            if (provider !== "anthropic") {
              setLastUsedReasoningLevel(level);
            }
          }
          setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
          updateReasoningButton();
        };
        option.addEventListener("pointerdown", applyReasoningSelection);
        option.addEventListener("click", applyReasoningSelection);
      } else {
        option.disabled = true;
        option.classList.add("llm-reasoning-option-disabled");
      }
      reasoningMenu.appendChild(option);
    }
  };

  (body as any).__llmApplyResolvedClaudeEffort =
    applyClaudeResolvedReasoningDisplay;

  const syncModelFromPrefs = () => {
    updateModelButton();
    updateReasoningButton();
    if (isFloatingMenuOpen(modelMenu)) {
      rebuildModelMenu();
    }
    if (isFloatingMenuOpen(reasoningMenu)) {
      rebuildReasoningMenu();
    }
  };

  const webChatHistoryController = createWebChatHistoryController({
    body,
    historyMenu,
    getItem: () => item,
    getSelectedModelInfo,
    closeHistoryMenu,
    getConversationKey,
    setConversationHistory: (conversationKey, messages) => {
      chatHistory.set(conversationKey, messages);
    },
    refreshChatPreservingScroll,
    isWebChatMode,
    resetWebChatPdfUploadedForCurrentConversation,
    clearNextWebChatNewChatIntent,
    setSelectedReasoningLevel: (itemId, level) => {
      selectedReasoningCache.set(itemId, level);
    },
    setSelectedReasoningProvider: (itemId, provider) => {
      selectedReasoningProviderCache.set(itemId, provider);
    },
    updateReasoningButton,
    setStatusMessage: status
      ? (message, level) => {
          setStatus(status, message, level);
        }
      : undefined,
    log: (message, ...args) => {
      ztoolkit.log(message, ...args);
    },
  });
  const { warmUpWebChatHistory } = webChatHistoryController;
  renderWebChatHistoryMenu = webChatHistoryController.renderWebChatHistoryMenu;

  // [webchat] Apply webchat-specific UI changes. Safe to call any time —
  // only modifies UI when actually in webchat mode, restores defaults otherwise.
  const applyWebChatModeUI = () => {
    let isWebChat = false;
    try {
      const { selectedEntry } = getSelectedModelInfo();
      isWebChat = selectedEntry?.authMode === "webchat";
    } catch {
      // getSelectedModelInfo may not be ready during initial render —
      // fall back to checking the last-used model entry directly.
      try {
        const lastId = getLastUsedModelEntryId();
        const entry = lastId ? getModelEntryById(lastId) : null;
        isWebChat = entry?.authMode === "webchat";
      } catch {
        return;
      }
    }

    panelRoot.dataset.webchatMode = isWebChat ? "true" : "false";
    syncQueuedFollowUpRegistration();

    // Mode chip: show target site name with connection dot, or restore original
    if (modeChipBtn) {
      if (isWebChat) {
        // Resolve the target label from the current model name
        let webchatChipLabel = "chatgpt";
        let webchatChipTitle = "WebChat Sync";
        try {
          const { currentModel } = getSelectedModelInfo();
          const { getWebChatTargetByModelName } =
            require("../../webchat/types") as typeof import("../../webchat/types");
          const entry = getWebChatTargetByModelName(currentModel || "");
          if (entry) {
            webchatChipLabel = entry.displayName;
            webchatChipTitle = `${entry.label} Web Sync (${entry.modelName})`;
          }
        } catch {
          /* fallback to defaults */
        }

        let dot = modeChipBtn.querySelector(
          ".llm-webchat-dot",
        ) as HTMLElement | null;
        if (!dot) {
          dot = (modeChipBtn.ownerDocument as Document).createElement("span");
          dot.className = "llm-webchat-dot llm-webchat-dot-disconnected";
        }
        modeChipBtn.textContent = "";
        modeChipBtn.appendChild(dot);
        modeChipBtn.appendChild(
          (modeChipBtn.ownerDocument as Document).createTextNode(
            ` ${webchatChipLabel}`,
          ),
        );
        modeChipBtn.title = webchatChipTitle;
        modeChipBtn.style.cursor = "default";
        startWebChatConnectionCheck(dot);
      } else {
        const oldDot = modeChipBtn.querySelector(".llm-webchat-dot");
        if (oldDot) {
          oldDot.remove();
          // Restore mode chip text — the normal render sync skips it while the dot is present
          const chipLabel = isGlobalMode() ? "Library chat" : "Paper chat";
          modeChipBtn.textContent = chipLabel;
          modeChipBtn.title = isGlobalMode()
            ? "Switch to paper chat"
            : "Switch to library chat";
        }
        stopWebChatConnectionCheck();
        modeChipBtn.style.cursor = "";
      }
    }

    // Model dropdown: fully disabled in webchat (model is ChatGPT, use Exit to change)
    if (modelBtn) {
      (modelBtn as HTMLButtonElement).disabled = isWebChat;
      modelBtn.style.opacity = isWebChat ? "0.5" : "";
      modelBtn.style.cursor = isWebChat ? "default" : "";
      modelBtn.style.pointerEvents = isWebChat ? "none" : "";
    }

    // [webchat] Pre-fetch history in background so it's ready when user clicks
    if (isWebChat) {
      void warmUpWebChatHistory();
    }

    // Clear button → "Exit" in webchat, restore "Clear" otherwise
    if (clearBtn) {
      if (isWebChat) {
        clearBtn.textContent = "Exit";
        (clearBtn as HTMLButtonElement).disabled = false;
        clearBtn.style.opacity = "";
        clearBtn.title = "Exit webchat and return to previous model";
      } else {
        clearBtn.textContent = "Clear";
        clearBtn.title = "";
      }
    }

    // [webchat] Hide the "/" action button — slash menu is disabled in webchat
    if (uploadBtn) {
      uploadBtn.style.display = isWebChat ? "none" : "";
    }

    // [webchat] Re-render paper chips to reflect forced PDF content source
    if (isWebChat) {
      updatePaperPreviewPreservingScroll();
    }

    updateRuntimeModeButton();
    updateClaudeSystemToggle();

    // Notify standalone window (or other listeners) of webchat mode change
    hooks?.onWebChatModeChanged?.(isWebChat);
    syncRequestUiForCurrentConversation();
  };

  // Initialize preview state
  updatePaperPreviewPreservingScroll();
  updateFilePreviewPreservingScroll();
  updateImagePreviewPreservingScroll();
  updateSelectedTextPreviewPreservingScroll();
  flushPanelStateRefreshNow();
  syncModelFromPrefs();
  flushResponsiveLayoutSyncNow();
  flushPanelStateRefreshNow();
  // Set active_target before applyWebChatModeUI so sidebar filters by the correct site
  try {
    if (isWebChatMode()) {
      const { getWebChatTargetByModelName: getColdTarget } =
        require("../../webchat/types") as typeof import("../../webchat/types");
      const { relaySetActiveTarget: setColdTarget } =
        require("../../webchat/relayServer") as typeof import("../../webchat/relayServer");
      const { currentModel: coldStartModel } = getSelectedModelInfo();
      const coldEntry = getColdTarget(coldStartModel || "");
      if (coldEntry?.id) setColdTarget(coldEntry.id);
    }
  } catch {
    /* isWebChatMode may not be ready */
  }
  applyWebChatModeUI();
  // [webchat] Cold startup → show preload screen so user knows they're in webchat mode
  try {
    if (isWebChatMode()) {
      const chatShellEl = body.querySelector(
        ".llm-chat-shell",
      ) as HTMLElement | null;
      if (chatShellEl) {
        void (async () => {
          try {
            abortWebChatPreload();
            const token = { aborted: false };
            webchatPreloadAbort = token;
            const { showWebChatPreloadScreen } =
              await import("../../webchat/preloadScreen");
            const { getWebChatTargetByModelName } =
              await import("../../webchat/types");
            const { relaySetActiveTarget: relaySetTarget2 } =
              await import("../../webchat/relayServer");
            const { currentModel: coldModel } = getSelectedModelInfo();
            const coldTargetEntry = getWebChatTargetByModelName(
              coldModel || "",
            );
            if (coldTargetEntry?.id) relaySetTarget2(coldTargetEntry.id);
            await showWebChatPreloadScreen(
              chatShellEl,
              token,
              coldTargetEntry?.label,
              coldTargetEntry?.modelName,
            );
          } catch {
            // Preload failed or was aborted — dot will show connection status
          } finally {
            webchatPreloadAbort = null;
          }
        })();
      }
    }
  } catch {
    // isWebChatMode may not be ready during initial render
  }
  restoreDraftInputForCurrentConversation();
  if (isNoteSession()) {
    void refreshGlobalHistoryHeader();
  } else if (isPaperMode()) {
    // In the standalone window, mountChatPanel's own async IIFE handles
    // conversation loading.  The parameter-less auto-fire would race with it
    // and resolve to a different (default) conversation, overwriting the
    // explicitly targeted one.
    const isStandalone = panelRoot.dataset.standalone === "true";
    if (!isStandalone) {
      void switchPaperConversation().catch((err) => {
        ztoolkit.log("LLM: Failed to restore paper conversation session", err);
      });
    }
  } else {
    void refreshGlobalHistoryHeader();
  }

  // Preferences can change outside this panel (e.g., settings window).
  // Re-sync model label when the user comes back (pointerenter).
  // NOTE: We intentionally do NOT sync on "focusin" because focusin fires
  // on every internal focus change (e.g. clicking the input box).
  // syncModelFromPrefs → updateModelButton → applyResponsiveActionButtonsLayout
  // mutates DOM → changes flex layout → resizes .llm-messages → shifts scroll
  // position.  pointerenter is sufficient and fires before interaction.
  body.addEventListener("pointerenter", () => {
    withScrollGuard(chatBox, conversationKey, () => {
      syncModelFromPrefs();
      syncConversationPanelState();
    });
  });
  const ResizeObserverCtor = body.ownerDocument?.defaultView?.ResizeObserver;
  if (ResizeObserverCtor && panelRoot && modelBtn) {
    const newObservers: ResizeObserver[] = [];
    const ro = new ResizeObserverCtor(() => {
      // Keep layout mutations on the guarded scheduler so flex-driven
      // resize of .llm-messages doesn't corrupt the scroll snapshot.
      withScrollGuard(
        chatBox,
        conversationKey,
        () => {
          scheduleResponsiveLayoutSync();
        },
        "relative",
      );
    });
    newObservers.push(ro);
    ro.observe(panelRoot);
    if (actionsRow) ro.observe(actionsRow);
    if (actionsLeft) ro.observe(actionsLeft);
    if (chatBox) {
      const chatBoxResizeObserver = new ResizeObserverCtor(() => {
        if (!chatBox) return;
        if (!isChatViewportVisible(chatBox)) return;
        const previous = chatBoxViewportState;
        const current = buildChatBoxViewportState();
        if (!current) return;
        const viewportChanged = Boolean(
          previous &&
          (current.width !== previous.width ||
            current.height !== previous.height),
        );
        if (viewportChanged && previous && previous.nearBottom) {
          const targetBottom = Math.max(
            0,
            chatBox.scrollHeight - chatBox.clientHeight,
          );
          if (Math.abs(chatBox.scrollTop - targetBottom) > 1) {
            chatBox.scrollTop = chatBox.scrollHeight;
          }
          captureChatBoxViewportState();
          if (item && chatBox.childElementCount) {
            persistChatScrollSnapshot(item, chatBox);
          }
          return;
        }
        if (
          viewportChanged &&
          previous &&
          !previous.nearBottom &&
          previous.maxScrollTop > 0
        ) {
          const progress = Math.max(
            0,
            Math.min(1, previous.scrollTop / previous.maxScrollTop),
          );
          const targetScrollTop = Math.round(current.maxScrollTop * progress);
          if (Math.abs(chatBox.scrollTop - targetScrollTop) > 1) {
            chatBox.scrollTop = targetScrollTop;
          }
          captureChatBoxViewportState();
          if (item && chatBox.childElementCount) {
            persistChatScrollSnapshot(item, chatBox);
          }
          return;
        }
        chatBoxViewportState = current;
      });
      newObservers.push(chatBoxResizeObserver);
      chatBoxResizeObserver.observe(chatBox);
    }
    // Store observers on body so they can be disconnected on next
    // setupHandlers call (prevents accumulation across tab switches).
    (body as any).__llmResizeObservers = newObservers;
  }

  const getSelectedProfile = () => {
    if (!item) return null;
    if (isClaudeConversationSystem()) {
      return getSelectedClaudeRuntimeEntry();
    }
    if (isCodexConversationSystem()) {
      return getSelectedCodexRuntimeEntry();
    }
    return getSelectedModelEntryForItem(item.id);
  };

  const getAdvancedModelParams = (
    entryId: string | undefined,
  ): AdvancedModelParams | undefined => {
    if (!entryId) return undefined;
    if (isClaudeConversationSystem()) {
      return getSelectedClaudeRuntimeEntry().advanced;
    }
    if (isCodexConversationSystem()) {
      return getSelectedCodexRuntimeEntry().advanced;
    }
    return getAdvancedModelParamsForEntry(entryId);
  };

  const getSelectedReasoning = (): LLMReasoningConfig | undefined => {
    if (!item) return undefined;
    if (isClaudeConversationSystem()) {
      return buildClaudeReasoningConfigForDisplayMode(
        getClaudeReasoningDisplayMode(),
      );
    }
    if (isCodexConversationSystem()) {
      const mode = getCodexReasoningModePref();
      return mode === "auto" ? undefined : { provider: "openai", level: mode };
    }
    const { provider, enabledLevels, selectedLevel } = getReasoningState();
    if (provider === "unsupported" || selectedLevel === "none")
      return undefined;
    if (!enabledLevels.includes(selectedLevel as LLMReasoningLevel)) {
      return undefined;
    }
    return { provider, level: selectedLevel as LLMReasoningLevel };
  };

  const { processIncomingFiles } = createFileIntakeController({
    body,
    getItem: () => item,
    getCurrentModel: () => getSelectedModelInfo().currentModel,
    isScreenshotUnsupportedModel,
    optimizeImageDataUrl,
    persistAttachmentBlob,
    selectedImageCache,
    selectedFileAttachmentCache,
    updateImagePreview,
    updateFilePreview,
    scheduleAttachmentGc,
    setStatusMessage: status
      ? (message, level) => {
          setStatus(status, message, level);
        }
      : undefined,
  });

  const setInputDropActive = (active: boolean) => {
    if (inputSection) {
      inputSection.classList.toggle("llm-input-drop-active", active);
    }
    if (inputBox) {
      inputBox.classList.toggle("llm-input-drop-active", active);
    }
  };

  const paperPickerController = createPaperPickerController({
    body,
    panelRoot,
    inputBox,
    paperPicker,
    paperPickerList,
    getItem: () => item,
    getCurrentLibraryID,
    isWebChatMode,
    resolveAutoLoadedPaperContext,
    getManualPaperContextsForItem,
    isPaperContextMineru,
    getTextContextConversationKey,
    persistDraftInputForCurrentConversation,
    updatePaperPreviewPreservingScroll,
    updateSelectedTextPreviewPreservingScroll,
    setStatusMessage: status
      ? (message, level) => {
          setStatus(status, message, level);
        }
      : undefined,
    log: (message, ...args) => {
      ztoolkit.log(message, ...args);
    },
  });
  const {
    getActiveAtToken,
    isPaperPickerOpen,
    closePaperPicker: closePaperPickerFromController,
    schedulePaperPickerSearch,
    moveActiveRow: movePaperPickerActiveRow,
    selectActiveRow: selectActivePaperPickerRow,
    handleArrowRight: handlePaperPickerArrowRight,
    handleArrowLeft: handlePaperPickerArrowLeft,
    addZoteroItemsAsPaperContext,
  } = paperPickerController;
  closePaperPicker = closePaperPickerFromController;
  const getActiveActionToken = (): PaperSearchSlashToken | null => {
    const caretEnd =
      typeof inputBox.selectionStart === "number"
        ? inputBox.selectionStart
        : inputBox.value.length;
    return parsePaperSearchSlashToken(inputBox.value, caretEnd);
  };
  let doSend: (options?: {
    overrideText?: string;
    preserveInputDraft?: boolean;
  }) => Promise<void> = async () => {};

  const actionCommandController = createActionCommandController({
    body,
    panelRoot,
    inputBox,
    slashMenu,
    uploadBtn,
    actionPicker,
    actionPickerList,
    actionHitlPanel,
    chatBox,
    getItem: () => item,
    getActiveActionToken,
    persistDraftInputForCurrentConversation,
    shouldRenderDynamicSlashMenu:
      shouldRenderDynamicSlashMenuForCurrentConversation,
    shouldRenderSkillSlashMenu:
      shouldRenderSkillSlashMenuForCurrentConversation,
    isWebChatMode,
    isClaudeConversationSystem,
    getCurrentRuntimeMode,
    setCurrentRuntimeMode,
    getCurrentLibraryID,
    resolveCurrentPaperBaseItem,
    getAllEffectivePaperContexts,
    getEffectivePdfModePaperContexts,
    getEffectiveFullTextPaperContexts,
    getSelectedProfile,
    getDoSend: () => doSend,
    closeRetryModelMenu,
    closeModelMenu,
    closeReasoningMenu,
    closeHistoryNewMenu,
    closeHistoryMenu,
    closeResponseMenu,
    closePromptMenu,
    closeExportMenu,
    setStatusMessage: status
      ? (message, level) => {
          setStatus(status, message, level);
        }
      : undefined,
    logError: (message, error) => {
      ztoolkit.log(message, error);
    },
  });
  const {
    isActionPickerOpen,
    closeActionPicker,
    moveActionPickerSelection,
    selectActiveActionPickerItem,
    renderDynamicSlashMenuSections,
    scheduleActionPickerTrigger,
    closeSlashMenu: closeActionSlashMenu,
    openSlashMenuWithSelection,
    moveSlashMenuSelection,
    selectActiveSlashMenuItem,
    syncHasActionCardAttr,
    clearForcedSkill: clearForcedSkillFromActionController,
    clearCommandChip,
    clearCommandRowSelection,
    getActiveCommandAction,
    consumeForcedSkillIds,
    handleInlineCommand,
    consumeActiveActionToken,
  } = actionCommandController;
  closeSlashMenu = closeActionSlashMenu;
  clearForcedSkill = clearForcedSkillFromActionController;

  if (inputSection && inputBox) {
    let fileDragDepth = 0;

    const isDragRelevant = (dragEvent: DragEvent): boolean =>
      isFileDragEvent(dragEvent) || isZoteroItemDragEvent(dragEvent);

    inputSection.addEventListener("dragenter", (e: Event) => {
      const dragEvent = e as DragEvent;
      if (!isDragRelevant(dragEvent)) return;
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      fileDragDepth += 1;
      setInputDropActive(true);
    });

    inputSection.addEventListener("dragover", (e: Event) => {
      const dragEvent = e as DragEvent;
      if (!isDragRelevant(dragEvent)) return;
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      if (dragEvent.dataTransfer) {
        dragEvent.dataTransfer.dropEffect = "copy";
      }
      if (!inputSection.classList.contains("llm-input-drop-active")) {
        setInputDropActive(true);
      }
    });

    inputSection.addEventListener("dragleave", (e: Event) => {
      const dragEvent = e as DragEvent;
      if (!isDragRelevant(dragEvent)) return;
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      fileDragDepth = Math.max(0, fileDragDepth - 1);
      if (fileDragDepth === 0) {
        setInputDropActive(false);
      }
    });

    inputSection.addEventListener("drop", (e: Event) => {
      const dragEvent = e as DragEvent;
      if (!isDragRelevant(dragEvent)) return;
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      fileDragDepth = 0;
      setInputDropActive(false);

      // Handle Zotero library item drops
      if (isZoteroItemDragEvent(dragEvent)) {
        const data = dragEvent.dataTransfer?.getData("zotero/item");
        const itemIds = parseZoteroItemDragData(data);
        const zoteroItems = itemIds
          .map((id) => Zotero.Items.get(id))
          .filter((zi): zi is Zotero.Item => Boolean(zi));
        if (zoteroItems.length) {
          addZoteroItemsAsPaperContext(zoteroItems);
        }
        inputBox.focus({ preventScroll: true });
        return;
      }

      // Handle file drops (existing logic)
      const files = dragEvent.dataTransfer?.files
        ? Array.from(dragEvent.dataTransfer.files)
        : [];
      if (!files.length) return;
      void processIncomingFiles(files);
      inputBox.focus({ preventScroll: true });
    });

    inputBox.addEventListener("paste", (e: Event) => {
      if (!item) return;
      const clipboardEvent = e as ClipboardEvent;
      const files = extractFilesFromClipboard(clipboardEvent);
      if (!files.length) return;
      clipboardEvent.preventDefault();
      clipboardEvent.stopPropagation();
      void processIncomingFiles(files);
      inputBox.focus({ preventScroll: true });
    });

    /** Auto-resize the textarea to fit its content, up to max-height. */
    const autoResizeInput = (): void => {
      inputBox.style.height = "auto";
      const max = 220; // matches CSS max-height
      inputBox.style.height = `${Math.min(inputBox.scrollHeight, max)}px`;
    };

    inputBox.addEventListener("input", () => {
      autoResizeInput();
      persistDraftInputForCurrentConversation();
      schedulePaperPickerSearch();
      scheduleActionPickerTrigger();
    });
    inputBox.addEventListener("click", () => {
      schedulePaperPickerSearch();
      scheduleActionPickerTrigger();
    });

    // Command row dismiss button (reuses .llm-paper-context-clear class)
    const commandRowClearBtn = body.querySelector(
      "#llm-command-row .llm-paper-context-clear",
    );
    if (commandRowClearBtn) {
      commandRowClearBtn.addEventListener("click", () => {
        clearCommandRowSelection();
        inputBox.focus({ preventScroll: true });
      });
    }

    inputBox.addEventListener("keyup", (e: Event) => {
      const key = (e as KeyboardEvent).key;
      if (
        key === "ArrowUp" ||
        key === "ArrowDown" ||
        key === "ArrowLeft" ||
        key === "ArrowRight"
      )
        return;
      if (key === "Enter" || key === "Tab" || key === "Escape") return;
      schedulePaperPickerSearch();
      scheduleActionPickerTrigger();
    });
  }

  let queuedFollowUpDrainTimer: number | null = null;

  const getQueuedFollowUpInputs = () =>
    getQueuedFollowUps(getQueuedFollowUpThreadKey());

  renderQueuedFollowUpInputs = () => {
    if (!queueBar) return;
    const queuedFollowUpInputs = getQueuedFollowUpInputs();
    if (!queuedFollowUpInputs.length) {
      queueBar.textContent = "";
      queueBar.style.display = "none";
      return;
    }

    const ownerDoc = body.ownerDocument!;
    queueBar.textContent = "";
    queueBar.style.display = "flex";

    const rail = ownerDoc.createElement("div") as HTMLDivElement;
    rail.className = "llm-queued-input-rail";

    const list = ownerDoc.createElement("div") as HTMLDivElement;
    list.className = "llm-queued-input-list";
    for (const entry of queuedFollowUpInputs) {
      const row = ownerDoc.createElement("div") as HTMLDivElement;
      row.className = "llm-queued-input-item";

      const text = ownerDoc.createElement("span") as HTMLSpanElement;
      text.className = "llm-queued-input-chip";
      text.textContent = entry.text;
      text.title = entry.text;

      const removeBtn = ownerDoc.createElement("button") as HTMLButtonElement;
      removeBtn.type = "button";
      removeBtn.className = "llm-queued-input-remove";
      removeBtn.textContent = "×";
      removeBtn.title = "Remove queued input";
      removeBtn.setAttribute("aria-label", "Remove queued input");
      removeBtn.addEventListener("click", (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        removeQueuedFollowUp(getQueuedFollowUpThreadKey(), entry.id);
        renderQueuedFollowUpInputs();
      });

      row.append(text, removeBtn);
      list.appendChild(row);
    }

    rail.append(list);
    queueBar.appendChild(rail);
  };

  scheduleQueuedFollowUpDrain = () => {
    const threadKey = getQueuedFollowUpThreadKey();
    if (!threadKey) return;
    if (queuedFollowUpDrainTimer !== null) return;
    const win = body.ownerDocument?.defaultView;
    if (!win) return;
    queuedFollowUpDrainTimer = win.setTimeout(() => {
      queuedFollowUpDrainTimer = null;
      void drainQueuedFollowUpInput();
    }, 220) as unknown as number;
  };
  (body as any)[SCHEDULE_QUEUED_FOLLOW_UP_DRAIN_PROPERTY] =
    scheduleQueuedFollowUpDrain;
  (body as any)[SCHEDULE_QUEUED_FOLLOW_UP_THREAD_DRAIN_PROPERTY] = () => {
    scheduleQueuedFollowUpDrainForThread(getQueuedFollowUpThreadKey());
  };

  isQueuedFollowUpSendAvailable = () => {
    const activeConversationKey = item ? getConversationKey(item) : null;
    return Boolean(
      getQueuedFollowUpThreadKey() &&
      activeConversationKey !== null &&
      isRequestPending(activeConversationKey),
    );
  };

  queueFollowUpInput = (text: string) => {
    const nextQueue = enqueueQueuedFollowUp(getQueuedFollowUpThreadKey(), text);
    if (!nextQueue.length) return;
    inputBox.value = "";
    persistDraftInputForCurrentConversation();
    renderQueuedFollowUpInputs();
    if (status) {
      setStatus(
        status,
        nextQueue.length === 1
          ? t("Queued 1 follow-up")
          : t(`Queued ${nextQueue.length} follow-ups`),
        "ready",
      );
    }
  };

  syncRequestUiForCurrentConversation();
  const pdfPaperResolver = createPdfPaperAttachmentResolver({
    logError: (message, ...args) => {
      ztoolkit.log(message, ...args);
    },
  });

  const sendFlowController = createSendFlowController({
    body,
    inputBox,
    getItem: () => item,
    closeSlashMenu,
    closePaperPicker,
    getSelectedTextContextEntries,
    getSelectedPaperContexts: (itemId) =>
      getManualPaperContextsForItem(
        itemId,
        item && item.id === itemId ? resolveAutoLoadedPaperContext() : null,
      ),
    getSelectedCollectionContexts: (itemId) =>
      selectedCollectionContextCache.get(itemId) || [],
    getFullTextPaperContexts: (currentItem, selectedPaperContexts) =>
      getEffectiveFullTextPaperContexts(currentItem, selectedPaperContexts),
    getPdfModePaperContexts: (currentItem, selectedPaperContexts) =>
      getEffectivePdfModePaperContexts(currentItem, selectedPaperContexts),
    hasActivePdfFullTextPapers: (
      currentItem: Zotero.Item,
      selectedPaperContexts?: any[],
    ) => hasActivePdfFullTextPapers(currentItem, selectedPaperContexts),
    hasUploadedPdfInCurrentWebChatConversation,
    markWebChatPdfUploadedForCurrentConversation,
    resolvePdfPaperAttachments: pdfPaperResolver.resolvePdfPaperAttachments,
    renderPdfPagesAsImages: pdfPaperResolver.renderPdfPagesAsImages,
    getModelPdfSupport: (modelName, protocol, authMode, apiBase) =>
      getModelPdfSupport(modelName, protocol, authMode, apiBase),
    uploadPdfForProvider: pdfPaperResolver.uploadPdfForProvider,
    resolvePdfBytes: pdfPaperResolver.resolvePdfBytes,
    getSelectedFiles: (itemId) => selectedFileAttachmentCache.get(itemId) || [],
    getSelectedImages: (itemId) => selectedImageCache.get(itemId) || [],
    resolvePromptText,
    buildQuestionWithSelectedTextContexts,
    buildModelPromptWithFileContext,
    isAgentMode: () => getCurrentRuntimeMode() === "agent",
    isGlobalMode,
    isClaudeConversationSystem,
    isCodexConversationSystem,
    normalizeConversationTitleSeed,
    getConversationKey,
    touchClaudeConversationTitle,
    touchCodexConversationTitle,
    touchGlobalConversationTitle,
    touchPaperConversationTitle,
    getSelectedProfile,
    getCurrentModelName: () => getSelectedModelInfo().currentModel,
    isScreenshotUnsupportedModel,
    getSelectedReasoning,
    getAdvancedModelParams,
    getActiveEditSession: () => activeEditSession,
    setActiveEditSession: (nextEditSession) => {
      activeEditSession = nextEditSession;
    },
    getLatestEditablePair,
    editLatestUserMessageAndRetry,
    sendQuestion,
    retainClaudeRuntime: async (sendBody, sendItem) => {
      await retainClaudeRuntimeForBody(sendBody, sendItem);
    },
    retainPinnedImageState,
    retainPaperState,
    consumePaperModeState,
    consumeWebChatForceNewChatIntent,
    retainPinnedFileState,
    retainPinnedTextState,
    updatePaperPreviewPreservingScroll,
    updateFilePreviewPreservingScroll,
    updateImagePreviewPreservingScroll,
    updateSelectedTextPreviewPreservingScroll,
    scheduleAttachmentGc,
    refreshGlobalHistoryHeader: () => {
      void refreshGlobalHistoryHeader();
    },
    persistDraftInput: persistDraftInputForCurrentConversation,
    autoLockGlobalChat: () => {
      if (isRuntimeConversationSystem()) return;
      if (!item || !isGlobalMode() || isNoteSession()) return;
      const ck = conversationKey;
      if (ck === null) return;
      const libraryID = getCurrentLibraryID();
      const existingLock = getLockedGlobalConversationKey(libraryID);
      if (existingLock) return; // already manually locked — don't override
      setLockedGlobalConversationKey(libraryID, ck);
      addAutoLockedGlobalConversationKey(ck);
      syncConversationIdentity();
    },
    autoUnlockGlobalChat: () => {
      if (isRuntimeConversationSystem()) return;
      const ck = conversationKey;
      if (ck === null || !isAutoLockedGlobalConversation(ck)) return;
      removeAutoLockedGlobalConversationKey(ck);
      const libraryID = getCurrentLibraryID();
      const currentLock = getLockedGlobalConversationKey(libraryID);
      if (currentLock === ck) {
        setLockedGlobalConversationKey(libraryID, null);
        syncConversationIdentity();
      }
    },
    setStatusMessage: status
      ? (message, level) => {
          setStatus(status, message, level);
        }
      : undefined,
    editStaleStatusText: EDIT_STALE_STATUS_TEXT,
    consumeForcedSkillIds,
  });
  doSend = sendFlowController.doSend;
  const { clearCurrentConversation } = createClearConversationController({
    getConversationKey: () => (item ? getConversationKey(item) : null),
    getCurrentItemID: () =>
      item && Number.isFinite(item.id) && item.id > 0 ? item.id : null,
    getPendingRequestId,
    getAbortController,
    setCancelledRequestId,
    setPendingRequestId,
    setAbortController,
    clearPendingTurnDeletion: (conversationKey) => {
      if (hasPendingTurnDeletionForConversation(conversationKey)) {
        clearPendingTurnDeletion();
      }
    },
    clearTransientComposeStateForItem,
    resetComposePreviewUI,
    resetConversationHistory: (conversationKey) => {
      chatHistory.set(conversationKey, []);
    },
    markConversationLoaded: (conversationKey) => {
      loadedConversationKeys.add(conversationKey);
    },
    invalidateConversationSession: async (conversationKey) => {
      if (!isClaudeConversationSystem() || !item) return;
      const libraryID = Number(item.libraryID || 0);
      const currentKind = resolveDisplayConversationKind(item);
      const baseItem = resolveConversationBaseItem(item);
      if (!Number.isFinite(libraryID) || libraryID <= 0 || !currentKind) return;
      const scope = buildClaudeScope({
        libraryID: Math.floor(libraryID),
        kind: currentKind,
        paperItemID:
          currentKind === "paper"
            ? Number(baseItem?.id || 0) || undefined
            : undefined,
        paperTitle:
          currentKind === "paper"
            ? String(baseItem?.getField?.("title") || "").trim() || undefined
            : undefined,
      });
      await invalidateClaudeConversationSession(getCoreAgentRuntime(), {
        conversationKey,
        scope,
      });
      void touchClaudeConversation(conversationKey, {
        providerSessionId: undefined,
        scopedConversationKey: undefined,
        scopeType: undefined,
        scopeId: undefined,
        scopeLabel: undefined,
        cwd: undefined,
        updatedAt: Date.now(),
      });
    },
    clearStoredConversation: (conversationKey) =>
      isClaudeConversationSystem()
        ? clearClaudeConversation(conversationKey)
        : isCodexConversationSystem()
          ? clearCodexConversation(conversationKey)
          : clearStoredConversation(conversationKey),
    resetConversationTitle: (conversationKey) =>
      isClaudeConversationSystem()
        ? setClaudeConversationTitle(conversationKey, "")
        : isCodexConversationSystem()
          ? setCodexConversationTitle(conversationKey, "")
          : clearConversationTitle(conversationKey),
    clearOwnerAttachmentRefs,
    removeConversationAttachmentFiles,
    refreshChatPreservingScroll,
    refreshGlobalHistoryHeader: () => {
      void refreshGlobalHistoryHeader();
    },
    scheduleAttachmentGc,
    clearAgentToolCaches: clearAllAgentToolCaches,
    clearAgentConversationState: async (conversationKey) => {
      await Promise.all([
        clearAgentMemory(conversationKey),
        clearAgentTranscript(conversationKey),
        clearPersistedAgentEvidence(conversationKey),
        clearPersistedAgentCoverage(conversationKey),
      ]);
      clearAgentResourceLifecycleState(conversationKey);
    },
    setStatusMessage: status
      ? (message, level) => {
          setStatus(status, message, level);
        }
      : undefined,
    logError: (message, err) => {
      ztoolkit.log(message, err);
    },
    // [webchat] Check if the currently selected model uses webchat auth
    isWebChatActive: () => {
      const { selectedEntry } = getSelectedModelInfo();
      return selectedEntry?.authMode === "webchat";
    },
    getWebChatHost: () => {
      const port = Zotero.Prefs.get("httpServer.port") || 23119;
      return `http://127.0.0.1:${port}/llm-for-zotero/webchat`;
    },
    markNextWebChatSendAsNewChat,
  });
  const executeSend = async () => {
    // If the inline edit widget is active, route through editUserTurnAndRetry
    // instead of the normal send flow.
    if (inlineEditTarget && item) {
      const currentItem = item;
      const editTarget = inlineEditTarget;
      const newText = inputBox?.value.trim() ?? "";
      const textContextKey = getTextContextConversationKey();
      const selectedContexts = textContextKey
        ? getSelectedTextContextEntries(textContextKey)
        : [];
      const {
        selectedTexts,
        selectedTextSources,
        selectedTextPaperContexts,
        selectedTextNoteContexts,
        selectedCollectionContexts,
      } = buildInlineEditRetryContextSnapshot({
        selectedContexts,
        selectedCollectionContexts: selectedCollectionContextCache.get(
          currentItem.id,
        ),
      });
      const allPaperContexts = getManualPaperContextsForItem(
        currentItem.id,
        currentItem.id === item?.id ? resolveAutoLoadedPaperContext() : null,
      );
      // Agent mode always uses text/MinerU pipeline — it fetches PDF pages on demand
      const isAgent = getCurrentRuntimeMode() === "agent";
      const pdfModePapers = isAgent
        ? []
        : getEffectivePdfModePaperContexts(currentItem, allPaperContexts);
      const pdfModeKeys = new Set(
        pdfModePapers.map((p) => `${p.itemId}:${p.contextItemId}`),
      );
      const selectedPaperContexts = allPaperContexts.filter(
        (p) => !pdfModeKeys.has(`${p.itemId}:${p.contextItemId}`),
      );
      const fullTextPaperContexts = getEffectiveFullTextPaperContexts(
        currentItem,
        selectedPaperContexts,
      );
      const selectedProfile = getSelectedProfile();
      const activeModelName = (
        selectedProfile?.model ||
        getSelectedModelInfo().currentModel ||
        ""
      ).trim();
      const baseSelectedFiles =
        selectedFileAttachmentCache.get(currentItem.id) || [];
      const selectedImages = (
        selectedImageCache.get(currentItem.id) || []
      ).slice(0, MAX_SELECTED_IMAGES);
      const pdfInputs = await resolvePdfModeModelInputs({
        deps: {
          setInputDisabled: (disabled) => {
            inputBox.disabled = disabled;
          },
          setStatusMessage: status
            ? (message, level) => {
                setStatus(status, message, level);
              }
            : undefined,
          logError: (message, ...args) => {
            ztoolkit.log(message, ...args);
          },
          isScreenshotUnsupportedModel,
          getModelPdfSupport,
          resolvePdfPaperAttachments:
            pdfPaperResolver.resolvePdfPaperAttachments,
          renderPdfPagesAsImages: pdfPaperResolver.renderPdfPagesAsImages,
          uploadPdfForProvider: pdfPaperResolver.uploadPdfForProvider,
          resolvePdfBytes: pdfPaperResolver.resolvePdfBytes,
        },
        paperContexts: pdfModePapers,
        selectedBaseFiles: baseSelectedFiles,
        selectedImageCountForBudget: isScreenshotUnsupportedModel(
          activeModelName,
        )
          ? 0
          : selectedImages.length,
        profile: selectedProfile,
        currentModelName: activeModelName,
        isWebChat: isWebChatMode(),
      });
      if (!pdfInputs.ok) return;
      const {
        selectedFiles,
        modelFiles,
        pdfPageImageDataUrls,
        pdfUploadSystemMessages,
      } = pdfInputs;
      const images = [
        ...(isScreenshotUnsupportedModel(activeModelName)
          ? []
          : selectedImages),
        ...pdfPageImageDataUrls,
      ].slice(0, MAX_SELECTED_IMAGES);
      const selectedReasoning = getSelectedReasoning();
      const advancedParams = getAdvancedModelParams(selectedProfile?.entryId);
      const targetRuntimeMode = getCurrentRuntimeMode();
      inlineEditCleanup?.();
      setInlineEditCleanup(null);
      setInlineEditInputSection(null, null, null);
      setInlineEditSavedDraft("");
      setInlineEditTarget(null);
      if (newText) {
        consumePaperModeState(currentItem.id, {
          webchatGreyOut: isWebChatMode(),
        });
        retainPaperState(currentItem.id);
        updatePaperPreviewPreservingScroll();
        void editUserTurnAndRetry({
          body,
          item: currentItem,
          userTimestamp: editTarget.userTimestamp,
          assistantTimestamp: editTarget.assistantTimestamp,
          newText,
          selectedTexts,
          selectedTextSources,
          selectedTextPaperContexts,
          selectedTextNoteContexts,
          selectedCollectionContexts,
          screenshotImages: images,
          paperContexts: selectedPaperContexts,
          fullTextPaperContexts,
          attachments: selectedFiles,
          modelAttachments: modelFiles,
          pdfUploadSystemMessages: pdfUploadSystemMessages.length
            ? pdfUploadSystemMessages
            : undefined,
          targetRuntimeMode,
          model: selectedProfile?.model,
          apiBase: selectedProfile?.apiBase,
          apiKey: selectedProfile?.apiKey,
          reasoning: selectedReasoning,
          advanced: advancedParams,
        });
      } else {
        // Nothing to submit — refresh the chat to remove the stale inline
        // edit widget (the "Editing" header div) that cleanup left in chatBox.
        refreshConversationPanels(body, currentItem);
      }
      return;
    }
    if (isQueuedFollowUpSendAvailable()) {
      const queuedText = inputBox?.value?.trim() ?? "";
      if (queuedText) {
        queueFollowUpInput(queuedText);
        return;
      }
    }
    closeActionPicker();
    // Intercept command chip: if a command chip is active, route to action execution
    const chipAction = getActiveCommandAction();
    if (chipAction) {
      const params = inputBox?.value?.trim() ?? "";
      clearCommandChip(); // also restores placeholder
      inputBox.value = "";
      const EvtCtor2 =
        (inputBox.ownerDocument?.defaultView as any)?.Event ?? Event;
      inputBox.dispatchEvent(new EvtCtor2("input", { bubbles: true }));
      persistDraftInputForCurrentConversation();
      void handleInlineCommand(chipAction.name, params);
      return;
    }
    await doSend();
    persistDraftInputForCurrentConversation();
    scheduleQueuedFollowUpDrainForThread(getQueuedFollowUpThreadKey());
  };

  async function drainQueuedFollowUpInput(): Promise<void> {
    const queuedFollowUpInputs = getQueuedFollowUpInputs();
    if (!queuedFollowUpInputs.length) {
      renderQueuedFollowUpInputs();
      return;
    }
    const activeConversationKey = item ? getConversationKey(item) : null;
    const threadKey = getQueuedFollowUpThreadKey();
    if (!threadKey || activeConversationKey === null) {
      return;
    }
    if (isRequestPending(activeConversationKey)) {
      scheduleQueuedFollowUpDrain();
      return;
    }
    const next = shiftQueuedFollowUp(threadKey);
    renderQueuedFollowUpInputs();
    if (!next) return;
    await doSend({
      overrideText: next.text,
      preserveInputDraft: true,
    });
    persistDraftInputForCurrentConversation();
    scheduleQueuedFollowUpDrainForThread(getQueuedFollowUpThreadKey());
  }

  // Send button - use addEventListener
  sendBtn.addEventListener("click", (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    void executeSend();
  });

  if (runtimeModeBtn) {
    runtimeModeBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      const nextMode: ChatRuntimeMode =
        getCurrentRuntimeMode() === "agent" ? "chat" : "agent";
      setCurrentRuntimeMode(nextMode);
      if (status) {
        setStatus(
          status,
          nextMode === "agent"
            ? t("Agent mode enabled")
            : t("Chat mode enabled"),
          "ready",
        );
      }
    });
  }

  // Enter key (Shift+Enter for newline)
  inputBox.addEventListener("keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
    if (isFloatingMenuOpen(slashMenu)) {
      if (ke.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        moveSlashMenuSelection(1);
        return;
      }
      if (ke.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        moveSlashMenuSelection(-1);
        return;
      }
      if (ke.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeSlashMenu();
        return;
      }
      if (ke.key === "Enter" || ke.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        selectActiveSlashMenuItem();
        return;
      }
    }
    if (isActionPickerOpen()) {
      if (ke.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        moveActionPickerSelection(1);
        return;
      }
      if (ke.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        moveActionPickerSelection(-1);
        return;
      }
      if (ke.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeActionPicker();
        return;
      }
      if (ke.key === "Enter" || ke.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        void selectActiveActionPickerItem();
        return;
      }
    }
    if (isPaperPickerOpen()) {
      if (ke.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        movePaperPickerActiveRow(1);
        return;
      }
      if (ke.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        movePaperPickerActiveRow(-1);
        return;
      }
      if (ke.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        handlePaperPickerArrowRight();
        return;
      }
      if (ke.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        handlePaperPickerArrowLeft();
        return;
      }
      if (ke.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closePaperPicker();
        return;
      }
      if (ke.key === "Enter" || ke.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        selectActivePaperPickerRow();
        return;
      }
    }
    // Backspace at position 0 with active badge: remove it
    if (
      ke.key === "Backspace" &&
      inputBox.selectionStart === 0 &&
      inputBox.selectionEnd === 0
    ) {
      if (clearCommandRowSelection()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    // Escape with active command/skill badge: remove the badge
    if (ke.key === "Escape" && clearCommandRowSelection()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Up-arrow prompt recall: when input is empty or cursor is at position 0,
    // recall the last user message from the current conversation.
    if (ke.key === "ArrowUp" && !ke.shiftKey) {
      const cursorAtStart =
        inputBox.selectionStart === 0 && inputBox.selectionEnd === 0;
      if (!inputBox.value.trim() || cursorAtStart) {
        const convKey = item ? getConversationKey(item) : null;
        const history = convKey != null ? chatHistory.get(convKey) || [] : [];
        const lastUserMsg = [...history]
          .reverse()
          .find((m) => m.role === "user");
        if (lastUserMsg?.text) {
          e.preventDefault();
          e.stopPropagation();
          inputBox.value = lastUserMsg.text;
          persistDraftInputForCurrentConversation();
          inputBox.selectionStart = inputBox.value.length;
          inputBox.selectionEnd = inputBox.value.length;
          return;
        }
      }
    }
    if (ke.key === "Escape" && inlineEditTarget) {
      e.preventDefault();
      e.stopPropagation();
      inlineEditCleanup?.();
      setInlineEditCleanup(null);
      setInlineEditInputSection(null, null, null);
      setInlineEditSavedDraft("");
      setInlineEditTarget(null);
      refreshConversationPanels(body, item);
      return;
    }
    if (ke.key === "Enter" && !ke.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      void executeSend();
    }
  });

  attachFontScaleShortcutController(panelDoc);

  attachComposeCaptureController({
    body,
    inputBox,
    screenshotBtn,
    uploadBtn,
    uploadInput,
    slashMenu,
    slashUploadOption,
    slashReferenceOption,
    slashPdfPageOption,
    slashPdfMultiplePagesOption,
    modelMenu,
    reasoningMenu,
    retryModelMenu,
    getItem: () => item,
    getConversationKey,
    getSelectedModelInfo,
    getActiveAtToken,
    consumeActiveActionToken,
    persistDraftInputForCurrentConversation,
    processIncomingFiles,
    renderDynamicSlashMenuSections,
    openSlashMenuWithSelection,
    closeSlashMenu,
    closeHistoryNewMenu,
    closeHistoryMenu,
    closeResponseMenu,
    closePromptMenu,
    closeExportMenu,
    schedulePaperPickerSearch,
    updateImagePreviewPreservingScroll,
    setStatusMessage: status
      ? (message, level) => {
          setStatus(status, message, level);
        }
      : undefined,
    log: (message, ...args) => {
      ztoolkit.log(message, ...args);
    },
  });

  openModelMenu = () => {
    if (!modelMenu || !modelBtn) return;
    if ((modelBtn as HTMLButtonElement).disabled) return;
    closeSlashMenu();
    closeRetryModelMenu();
    closeReasoningMenu();
    closePromptMenu();
    closeHistoryNewMenu();
    closeHistoryMenu();
    updateModelButton();
    flushResponsiveLayoutSyncNow();
    flushPanelStateRefreshNow();
    rebuildModelMenu();
    if (!modelMenu.childElementCount) {
      closeModelMenu();
      return;
    }
    positionFloatingMenu(body, modelMenu, modelBtn);
    setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, true);
  };

  closeModelMenu = () => {
    setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, false);
  };

  openReasoningMenu = () => {
    if (!reasoningMenu || !reasoningBtn) return;
    closeSlashMenu();
    closeRetryModelMenu();
    closeModelMenu();
    closePromptMenu();
    closeHistoryNewMenu();
    closeHistoryMenu();
    updateReasoningButton();
    flushResponsiveLayoutSyncNow();
    rebuildReasoningMenu();
    if (!reasoningMenu.childElementCount) {
      closeReasoningMenu();
      return;
    }
    positionFloatingMenu(body, reasoningMenu, reasoningBtn);
    setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, true);
  };

  closeReasoningMenu = () => {
    setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
  };

  const openRetryModelMenu = (anchor: HTMLButtonElement) => {
    if (!item || !retryModelMenu) return;
    closeSlashMenu();
    closeResponseMenu();
    closeExportMenu();
    closePromptMenu();
    closeHistoryNewMenu();
    closeHistoryMenu();
    closeModelMenu();
    closeReasoningMenu();
    rebuildRetryModelMenu();
    if (!retryModelMenu.childElementCount) {
      closeRetryModelMenu();
      return;
    }
    retryMenuAnchor = anchor;
    positionFloatingMenu(body, retryModelMenu, anchor);
    setFloatingMenuOpen(retryModelMenu, RETRY_MODEL_MENU_OPEN_CLASS, true);
  };

  attachFloatingMenuInteractionController({
    body,
    panelDoc,
    chatBox,
    modelBtn,
    reasoningBtn,
    modelMenu,
    reasoningMenu,
    retryModelMenu,
    slashMenu,
    historyMenu,
    historyNewMenu,
    historyRowMenu,
    promptMenu,
    paperPicker,
    getPaperChipMenu: () => paperChipMenu,
    getPaperChipMenuSticky: () => paperChipMenuSticky,
    getPaperChipMenuAnchor: () => paperChipMenuAnchor,
    closePaperChipMenu,
    getItem: () => item,
    getInlineEditTarget: () => inlineEditTarget,
    getInlineEditCleanup: () => inlineEditCleanup,
    clearInlineEdit: () => {
      setInlineEditCleanup(null);
      setInlineEditTarget(null);
    },
    closePromptMenu,
    closeRetryModelMenu,
    closePaperPicker,
    closeHistoryRowMenu,
    openRetryModelMenu,
    openModelMenu,
    closeModelMenu,
    openReasoningMenu,
    closeReasoningMenu,
    clearRetryMenuAnchor: () => {
      retryMenuAnchor = null;
    },
    isElementNode,
  });

  attachComposePreviewInteractionController({
    body,
    imagePreview,
    selectedContextList,
    previewMeta,
    removeImgBtn,
    filePreview,
    filePreviewMeta,
    filePreviewClear,
    filePreviewList,
    previewStrip,
    paperPreview,
    getItem: () => item,
    getTextContextConversationKey,
    resolveAutoLoadedPaperContext,
    getManualPaperContextsForItem,
    resolvePaperContentSourceMode,
    resolvePaperContextNextSendMode,
    isPaperContextMineru,
    isWebChatMode,
    getCurrentRuntimeMode,
    getSelectedProfile,
    getSelectedModelInfo,
    resolveCurrentPaperBaseItem,
    clearSelectedImageState,
    clearSelectedFileState,
    closePaperChipMenu,
    resolvePaperContextFromChipElement,
    focusPaperContextInActiveTab,
    updatePaperPreviewPreservingScroll,
    updateFilePreviewPreservingScroll,
    updateImagePreviewPreservingScroll,
    updateSelectedTextPreviewPreservingScroll,
    scheduleAttachmentGc,
    setStatusMessage: status
      ? (message, level) => {
          setStatus(status, message, level);
        }
      : undefined,
    logError: (message, error) => {
      ztoolkit.log(message, error);
    },
  });

  // Cancel button
  if (cancelBtn) {
    cancelBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      cancelVisiblePendingConfirmationCards(
        chatBox || body,
        (requestId, resolution) =>
          getAgentApi().resolveConfirmation(requestId, resolution),
      );
      syncHasActionCardAttr();
      const cancelConvKey = item ? getConversationKey(item) : null;
      if (cancelConvKey !== null) {
        const ctrl = getAbortController(cancelConvKey);
        if (ctrl) ctrl.abort();
      }
      // [webchat] Tell the browser extension to stop ChatGPT generation
      if (isWebChatMode()) {
        try {
          const { relayRequestStop } = require("../../webchat/relayServer");
          relayRequestStop();
        } catch {
          /* relay may not be loaded */
        }
      }
      if (cancelConvKey !== null) {
        setCancelledRequestId(
          cancelConvKey,
          getPendingRequestId(cancelConvKey),
        );
        setPendingRequestId(cancelConvKey, 0);
      }
      if (status) setStatus(status, t("Cancelled"), "ready");
      // Immediately mark the last assistant message as not streaming so any
      // queued refresh won't bring back the loading dots.
      if (item) {
        const key = getConversationKey(item);
        const history = chatHistory.get(key);
        if (history) {
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === "assistant") {
              history[i].streaming = false;
              if (!history[i].text) history[i].text = "[Cancelled]";
              break;
            }
          }
        }
      }
      body
        .querySelectorAll(".llm-typing")
        .forEach((el: Element) => el.remove());
      // Re-enable UI for the cancelled conversation
      if (inputBox) inputBox.disabled = false;
      if (sendBtn) {
        sendBtn.style.display = "";
        sendBtn.disabled = false;
      }
      cancelBtn.style.display = "none";
      scheduleQueuedFollowUpDrainForThread(getQueuedFollowUpThreadKey());
    });
  }

  // Clear button
  if (clearBtn) {
    clearBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      closePaperPicker();
      closeExportMenu();
      closePromptMenu();
      closeHistoryNewMenu();
      closeHistoryMenu();
      activeEditSession = null;
      if (!item) return;

      // [webchat] "Exit" button → restore previous model and leave webchat mode
      if (isWebChatMode()) {
        abortWebChatPreload();
        // Immediately remove preload overlay for instant visual feedback
        body.querySelector(".llm-webchat-preload")?.remove();
        stopWebChatConnectionCheck();
        clearNextWebChatNewChatIntent();
        resetWebChatPdfUploadedForCurrentConversation();
        // Restore previous model, or fall back to first non-webchat model
        const restoreId =
          previousNonWebchatModelId ||
          getAvailableModelEntries().find((e) => e.authMode !== "webchat")
            ?.entryId ||
          null;
        if (restoreId) {
          setSelectedModelEntryForItem(item.id, restoreId);
        }
        previousNonWebchatModelId = null;
        // Refresh UI back to normal mode
        updateModelButton();
        updateReasoningButton();
        applyWebChatModeUI();
        // Clear webchat conversation (DB + in-memory) so history doesn't
        // persist into normal mode and the panel is ready for a fresh start.
        void clearCurrentConversation();
        return;
      }

      void clearCurrentConversation();
    });
  }

  const cleanupBody = body as Element & {
    __llmQueuedFollowUpCleanupRegistered?: boolean;
    __llmQueuedFollowUpDisconnectCleanup?: () => void;
  };
  if (!cleanupBody.__llmQueuedFollowUpCleanupRegistered) {
    cleanupBody.__llmQueuedFollowUpCleanupRegistered = true;
    cleanupBody.__llmQueuedFollowUpDisconnectCleanup =
      observeElementDisconnected(body, () => {
        cleanupPrefObservers?.();
        unregisterQueuedFollowUpBody(registeredQueuedFollowUpThreadKey, body);
        queuedFollowUpBody.__llmQueuedFollowUpRegisteredThreadKey = null;
        activeContextPanelStateSync.delete(body);
        delete (body as any).__llmApplyResolvedClaudeEffort;
        delete (body as any)[SCHEDULE_QUEUED_FOLLOW_UP_DRAIN_PROPERTY];
        delete (body as any)[SCHEDULE_QUEUED_FOLLOW_UP_THREAD_DRAIN_PROPERTY];
        delete (body as any).__llmScheduleClaudeQueueDrain;
        delete (body as any).__llmScheduleClaudeThreadQueueDrain;
        void releaseClaudeRuntimeForBody(body);
        delete cleanupBody.__llmQueuedFollowUpDisconnectCleanup;
        cleanupBody.__llmQueuedFollowUpCleanupRegistered = false;
      });
  }
}

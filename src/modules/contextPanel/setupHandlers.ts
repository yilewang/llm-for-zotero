import { appLogger } from "../../core/logging";
import { copyNoteEditingSelectedTextContext } from "./noteEditing/selectionController";
import {
  bindTaskProgressToggle,
  disposeTaskProgressPanel,
  syncTaskProgressPanel,
} from "./taskProgress/panel";
import {
  TASK_PROGRESS_OPEN_PASSAGE_EVENT,
  TASK_PROGRESS_REMOVE_PAPER_EVENT,
} from "./taskProgress/view";
import {
  TASK_PROGRESS_OFFER_EVENT,
  TASK_PROGRESS_OPEN_SOURCE_EVENT,
  TASK_PROGRESS_SHOW_IN_ANSWER_EVENT,
  type TaskProgressOfferDetail,
  type TaskProgressOpenSourceDetail,
  type TaskProgressShowInAnswerDetail,
} from "./taskProgress/outsideView";
import type { TaskPaperPassageTarget } from "./taskProgress/passageSource";
import {
  findCitationChipForItem,
  navigateToTaskPaperPassage,
} from "./assistantCitationLinks";
import { openWebSourceLink } from "./webSourcesSidePanel";
import {
  clearAnswerQuoteHighlights,
  findAnswerRoots,
  highlightAnswerQuote,
  highlightAnswerQuoteCard,
  highlightSentenceBeforeMark,
  sentenceClosingMarks,
  pulseAnswerQuote,
} from "./answerQuoteHighlight";
import { resolveTaskPaperScopeItemIds } from "../../agent/context/taskPaperScopeListing";
import { libraryIndexService } from "../../services/libraryIndexService";
import { createNoteConversationItem } from "../../services/notes/conversationItem";
/* eslint-disable @typescript-eslint/no-require-imports */
import { createElement } from "../../utils/domHelpers";
import { t } from "../../utils/i18n";
import { observeHistoryActivity } from "./historyActivity";
import { isLivePanelBody } from "./panelLiveness";
import { revealLocalPath } from "../../utils/revealLocalPath";
import { isReaderApiEntry } from "../../agent/reader/readerChoiceFromSelection";
import { getAllSkills } from "../../agent/skills";
import type { AgentSkill } from "../../agent/skills/skillLoader";
import type { RuntimeModelEntry } from "../../utils/modelProviders";
import type { ConversationSystem } from "../../shared/types";
import {
  getModelEntryById,
  getModelProviderGroups,
} from "../../utils/modelProviders";
import {
  bindSurfaceChoices,
  demoteConversationSystemOnEverySurface,
} from "./surfaceChoices";
import {
  buildQueuedFollowUpThreadKey,
  enqueueQueuedFollowUp,
  getQueuedFollowUps,
  registerQueuedFollowUpBody,
  removeQueuedFollowUp,
  restoreQueuedFollowUp,
  scheduleQueuedFollowUpDrainForThread,
  SCHEDULE_QUEUED_FOLLOW_UP_DRAIN_PROPERTY,
  SCHEDULE_QUEUED_FOLLOW_UP_THREAD_DRAIN_PROPERTY,
  setQueuedFollowUpBodySyncCallback,
  shiftQueuedFollowUp,
  unregisterQueuedFollowUpBody,
} from "./queuedFollowUps";
import {
  buildDefaultUpstreamGlobalConversationKey,
  config,
  MAX_FULL_TEXT_PAPER_CONTEXTS,
  MAX_SELECTED_IMAGES,
  MAX_SELECTED_PAPER_CONTEXTS,
  PERSISTED_HISTORY_LIMIT,
  formatFigureCountLabel,
  formatFileCountLabel,
  GLOBAL_CONVERSATION_KEY_BASE,
  GLOBAL_HISTORY_LIMIT,
  isUpstreamGlobalConversationKey,
  PREFERENCES_PANE_ID,
} from "./constants";
import { bindChatScrollLifecycle } from "./chatScrollLifecycle";
import { getChatCoveredTop } from "./chatScrollGeometry";
import {
  isChatViewportVisible,
  navigateChatToMessage,
} from "./chatScrollSnapshots";
import { flushPendingChatRender } from "./progressiveChatRender";
import { bindChatLatestButton } from "./chatLatestButton";
import { bindFloatingComposer } from "./chatFloatingComposer";
import {
  createConversationTurnNavigator,
  disposeConversationTurnNavigator,
  SIDEBAR_TURN_NAVIGATOR_MIN_WIDTH_PX,
  STANDALONE_TURN_NAVIGATOR_MIN_WIDTH_PX,
} from "./conversationTurnNavigator";
import {
  clearManualTextareaHeight,
  resizeTextareaToContent,
} from "./textareaSizing";
import {
  noteQuoteValidationUserActivity,
  QUOTE_PROVENANCE_REVALIDATION_REQUEST_EVENT,
} from "./quoteValidationActivity";
import { createContextIcon } from "./contextIcons";
import {
  selectedReasoningCache,
  selectedReasoningProviderCache,
  reasoningCacheKey,
  clearSelectedReasoningForSurface,
  selectedRuntimeModeCache,
  selectedImageCache,
  selectedFileAttachmentCache,
  selectedImagePreviewExpandedCache,
  selectedImagePreviewActiveIndexCache,
  selectedFilePreviewExpandedCache,
  selectedPaperContextCache,
  selectedPaperContextListExpandedCache,
  selectedOtherRefContextCache,
  selectedCollectionContextCache,
  selectedTagContextCache,
  initializedConversationComposeContextKeys,
  paperContextModeOverrides,
  selectedPaperPreviewExpandedCache,
  pinnedSelectedTextKeys,
  pinnedImageKeys,
  pinnedFileKeys,
  setCancelledRequestId,
  getPendingRequestId,
  getAbortController,
  isRequestPending,
  isRequestOwner,
  getResponseMenuTarget,
  setResponseMenuTarget,
  getPromptMenuTarget,
  setPromptMenuTarget,
  releaseMenuTargets,
  chatHistory,
  loadedConversationKeys,
  webChatIsolatedConversationKeys,
  markWebChatConversationForceNewChat,
  clearWebChatConversationForceNewChat,
  consumeWebChatConversationForceNewChat,
  currentRequestId,
  draftInputCache,
  webChatDraftInputCache,
  activeContextPanels,
  unregisterContextPanel,
  activeContextPanelRawItems,
  activeContextPanelStateSync,
  addAutoLockedGlobalConversationKey,
  removeAutoLockedGlobalConversationKey,
  isAutoLockedGlobalConversation,
  getConversationWriteGeneration,
} from "./state";
import { paperTextStore } from "../../services/paperContent/paperTextStore";
import {
  setStatus,
  buildQuestionWithSelectedTextContexts,
  buildModelPromptWithFileContext,
  resolvePromptText,
  getAttachmentTypeLabel,
} from "./textUtils";
import { sanitizeText } from "../../utils/textSanitization";
import { normalizeSelectedTextSource } from "../../services/context/normalizers";
import { resolveSelectedTextAnchors } from "./selectedTextAnchors";
import {
  formatActionLabel,
  resolveActionCompletionStatusText,
} from "./actionStatusText";
import {
  normalizeAttachmentContentHash,
  normalizeSelectedTextPaperContexts,
} from "../../services/context/normalizers";
import {
  positionMenuBelowButton,
  positionMenuAtPointer,
} from "./menuPositioning";
import {
  getAvailableModelEntries,
  getStringPref,
  getAgentModeEnabled,
  getClaudeCodeModeEnabled,
  applyPanelFontScale,
  getAdvancedModelParamsForEntry,
  getLastUsedPaperConversationKey,
  removeLastUsedPaperConversationKey,
  getLockedGlobalConversationKey,
  setLockedGlobalConversationKey,
} from "./prefHelpers";
import {
  isTornSurface,
  recall,
  recallActive,
  remember,
  rememberMode,
  type SelectionSurface,
} from "./conversationSelection";
import { refreshConfiguredProviderModelCatalogs } from "../../utils/modelProviders";
import {
  refreshModelCapabilityRegistry,
  subscribeModelCapabilities,
  getModelCapabilities,
} from "../../modelCapabilities";
import type { ModelProfileOverride } from "../../modelCapabilities";
import {
  sendQuestion,
  refreshChat,
  syncUserContextAlignmentWidths,
  getConversationKey,
  shouldMoveToOwnWebChatSession,
  ensureConversationLoaded,
  persistChatScrollSnapshot,
  requestChatScrollFollowBottom,
  disposeChatRendering,
  withScrollGuard,
  copyTextToClipboard,
  refreshConversationPanels,
  beginPanelRequest,
  finishPanelRequest,
  clearPendingRequestIdAndSync,
  detectReasoningProvider,
  getReasoningOptions,
  getSelectedReasoningForItem,
  retryLatestAssistantResponse,
  resetSessionTokens,
  editLatestUserMessageAndRetry,
  editUserTurnAndRetry,
  findLatestRetryPair,
  registerContextPanelModelSync,
  type EditLatestTurnMarker,
} from "./chat";
import { scheduleConversationQuoteRevalidation } from "./quoteValidation/scheduling";
import {
  getWorkflowTestHistoryOpenFailure,
  getWorkflowTestSendInterceptor,
  notifyWorkflowTestSendSettled,
} from "./workflowTestHooks";
import { isEphemeralConversationKey } from "../../shared/conversationKeySpace";
import {
  bindSidePanelHost,
  bindStandalonePanelHost,
  bindTestPanelHost,
  canCommitPanelConversation,
  capturePanelOperationLease,
  evaluatePanelOwnership,
  getPanelHostBinding,
  isPanelHostCompatibleWithPaper,
  isPanelOperationLeaseCurrent,
  renderPanelOwnershipBlocked,
  requireCurrentPanelOwnership,
  isSidePanelBody,
  resolveSelectionSurfaceForBody,
  shouldOwnershipFenceSwallowEvent,
} from "./panelHostOwnership";
import { clearCompletedPanelLifecycleSignature } from "./panelLifecycleSignature";
import { runInPlacePaperSwitch } from "./inPlacePaperSwitch";
import {
  publishPanelHandle,
  unpublishPanelHandle,
  type PanelHandle,
} from "./panelHandle";
import {
  resolveStandaloneConversationSwitch,
  type StandaloneConversationSwitchDecision,
} from "./standaloneConversationSwitch";
import { createChatInputLock } from "./chatInputLock";
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
  resolveContextSourceItemAsync,
  setNoteContextExpanded,
  setSelectedTextContextEntries,
  setSelectedTextExpandedIndex,
  updateSelectedTextContextQueryForItem,
} from "./contextResolution";
import {
  isTextLikeAttachmentSourceMode,
  resolvePaperContextRefFromAttachment,
} from "../../services/paperContent/paperAttribution";
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
import { FULL_PDF_UNSUPPORTED_MESSAGE } from "./pdfSupportMessages";
import { buildPaperKey } from "../../services/paperContent/pdfContext";
import { ownerScopedPaperKey } from "../../shared/paperKey";
import { isSupportedContextAttachment } from "../../services/paperContent/contextAttachmentSupport";
import { getContextSourceModeCssClassName } from "../../services/paperContent/contextSourceModes";
import {
  getPaperModeOverride,
  setPaperModeOverride,
  clearPaperModeOverrides,
  isPaperContextFullTextMode,
  getPaperContentSourceOverride,
  setPaperContentSourceOverride,
  clearPaperContentSourceOverrides,
  clearSelectedPaperState,
  clearAllRefContextState,
} from "./contexts/paperContextState";
import {
  getMineruBatchState,
  onBatchStateChange,
  pauseBatchProcessing,
  processSelectedItems,
} from "../mineruBatchProcessor";
import { getAutoWatchStatus, pauseAutoWatch } from "../mineruAutoWatch";
import {
  getItemStatus,
  getMineruStatus,
  onProcessingStatusChange,
} from "../mineruProcessingStatus";
import { isMineruEnabled } from "../../utils/mineruConfig";
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
import { composeContextStore } from "./contexts/composeContextStore";
import {
  buildAttachedConversationRef,
  formatAttachedConversationLabel,
  isPastConversationEntry,
  listPastConversationEntries,
  searchPastConversationEntries,
} from "./pastConversationSource";
import { createHistorySearchPopupController } from "./setupHandlers/controllers/historySearchPopupController";
import {
  MAX_ATTACHED_CONVERSATIONS,
  normalizeAttachedConversationRefs,
} from "../../services/context/normalizers";
import { optimizeImageDataUrl } from "./screenshot";
import { readNoteSnapshot } from "../../services/notes/noteSnapshot";
import {
  persistAttachmentBlob,
  extractManagedBlobHash,
  isManagedBlobPath,
  removeAttachmentFile,
} from "../../services/attachmentStorage";
import { conversationRepository } from "../../core/conversations/repository";
import { pendingDeletionStore } from "../../core/conversations/pendingDeletionStore";
import {
  touchPaperConversationTitle,
  touchGlobalConversationTitle,
} from "../../utils/chatStore";
import {
  ATTACHMENT_GC_MIN_AGE_MS,
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
  TagContextRef,
  AttachedConversationRef,
  PaperContextSendMode,
  PaperContentSourceMode,
  ResolvedContextSource,
  SelectedTextContext,
} from "./types";
import type { ReasoningLevel as LLMReasoningLevel } from "../../utils/llmClient";
import { isReasoningLevelActive } from "../../utils/llmClient";
import type { ReasoningConfig as LLMReasoningConfig } from "../../utils/llmClient";
import {
  browseAllItemCandidates,
  searchAllItemCandidates,
  searchCollectionCandidates,
  ZOTERO_NOTE_CONTENT_TYPE,
  normalizePaperSearchText,
  parsePaperSearchSlashToken,
  parseSkillSearchDollarToken,
  parseAtSearchToken,
  type PaperBrowseCollectionCandidate,
  type PaperSearchAttachmentCandidate,
  type PaperSearchGroupCandidate,
  type PaperSearchSlashToken,
} from "./paperSearch";
import {
  resolvePaperScopedDefaultInput,
  type PaperScopedActionCollectionCandidate,
  type PaperScopedActionProfile,
} from "./paperScopeCommand";
import { getAgentApi, initAgentSubsystem } from "../../agent/index";
import type { ActionRequestContext } from "../../agent/actions";
import { renderPendingActionCard } from "./agentTrace/render";
import type {
  AgentPendingAction,
  AgentConfirmationResolution,
} from "../../agent/types";
import {
  resolveConversationKeyForNoteFocus,
  createGlobalPortalItem,
  createPaperPortalItem,
  resolveActiveNoteSession,
  resolveConversationSystemForItem,
  resolveDisplayConversationKind,
  resolveConversationBaseItem,
  resolvePaperChatSourceItem,
  resolveInitialPanelItemState,
  resolvePreferredConversationSystem,
  resolveNoteFocusSystemSwitch,
  resolveShortcutMode,
} from "./portalScope";
import { isGlobalPortalItem } from "../../services/context/portalItems";
import { resolveActiveLibraryID } from "../../utils/zoteroLibraryScope";
import {
  RUNTIME_CONVERSATION_SYSTEMS,
  resolveRuntimeSystemToggleTarget,
  syncRuntimeSystemControls,
  type RuntimeConversationSystem,
  type RuntimeSystemControls,
} from "./runtimeSystemControls";
import {
  resolveSidebarChatModeToggleState,
  type SidebarChatModeTab,
} from "./sidebarChatModeToggle";
import {
  playSidebarModeChangeFade,
  removeSidebarModeSwitchDot,
  showSidebarModeSwitchDot,
  syncSidebarModeSwitch,
} from "./sidebarModeSwitch";
import { getPanelDomRefs } from "./setupHandlers/domRefs";
import {
  chooseAutoLoadedContextPanelItem,
  chooseCurrentPaperBaseItemForMode,
  isAutoLoadedSnapshotForCurrentPaper,
} from "./paperContextPreloadIdentity";
import type { SetupHandlersContext } from "./setupHandlers/types";
import {
  observeElementDisconnected,
  PanelLifecycle,
} from "./setupHandlers/lifecycle";
import { createWebChatFeature } from "./setupHandlers/features/webChat";
import {
  MENU_OPTION_SELECTED_CLASS,
  MODEL_MENU_OPEN_CLASS,
  REASONING_MENU_OPEN_CLASS,
  RETRY_MODEL_MENU_OPEN_CLASS,
  SLASH_MENU_OPEN_CLASS,
  isFloatingMenuOpen,
  positionComposerMenu,
  positionFloatingMenu,
  setFloatingMenuOpen,
} from "./setupHandlers/controllers/menuController";
import {
  createReaderMenuController,
  describeReaderSelection,
  formatReaderTooltipLine,
} from "./setupHandlers/controllers/readerMenuController";
import { readerRuntimeKeyForSystem } from "../../shared/readerSelection";
import {
  MENUS_CLOSED_BY_MODEL_MENU,
  MENUS_CLOSED_BY_REASONING_MENU,
  MENUS_CLOSED_BY_RETRY_MODEL_MENU,
  createMenuRegistry,
} from "./setupHandlers/controllers/menuRegistry";
import { createActionLayoutController } from "./setupHandlers/controllers/actionLayoutController";
import {
  getReasoningLevelDisplayLabel,
  getScreenshotDisabledHint,
  isScreenshotUnsupportedModel,
  getModelPdfSupport,
} from "./setupHandlers/controllers/modelReasoningController";
import {
  type ConversationHistoryEntry,
  type HistorySwitchTarget,
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
  createWebChatModeController,
  type LeaveWebChatModeOptions,
} from "./setupHandlers/controllers/webChatModeController";
import {
  formatPaperContextCardAttachmentLine,
  formatPaperContextChipLabel,
  formatPaperContextChipTitle,
  hasPaperChipSourceMenuOption,
  isPaperContextReaderFocusableSourceMode,
  normalizePaperContextEntries,
  resolvePaperContextDisplayMetadata,
  resolvePaperContextForcedSendMode,
} from "./setupHandlers/controllers/composeContextController";
import { getPaperContextCollapseState } from "./setupHandlers/controllers/paperContextCollapseController";
import {
  isPinnedFile,
  isPinnedImage,
  prunePinnedFileKeys,
  prunePinnedImageKeys,
  removePinnedFile,
  removePinnedImage,
} from "./setupHandlers/controllers/pinnedContextController";
import {
  createFileIntakeController,
  extractFilesFromClipboard,
  isFileDragEvent,
  isZoteroItemDragEvent,
  parseZoteroItemDragData,
} from "./setupHandlers/controllers/fileIntakeController";
import {
  createSendFlowController,
  type SendFlowOptions,
} from "./setupHandlers/controllers/sendFlowController";
import { cancelVisiblePendingConfirmationCards } from "./setupHandlers/controllers/cancelPendingConfirmationController";
import {
  buildInlineEditRetryContextSnapshot,
  resolveInlineEditSubmitText,
} from "./setupHandlers/controllers/inlineEditRetryController";
import {
  endInlineEdit,
  getInlineEditTarget,
  releaseInlineEdit,
} from "./inlineEditState";
import { attachAssistantSelectionPopup } from "./setupHandlers/controllers/assistantSelectionPopupController";
import { attachMenuActionController } from "./setupHandlers/controllers/menuActionController";
import { createPdfPaperAttachmentResolver } from "./setupHandlers/controllers/pdfPaperAttachmentResolver";
import { createLocalPdfResourceResolver } from "./setupHandlers/controllers/localPdfResourceResolver";
import { isZoteroPdfAttachmentCandidate } from "./setupHandlers/controllers/pdfAttachmentPolicy";
import { resolvePdfModeModelInputs } from "./setupHandlers/controllers/pdfPaperModelInputController";
import {
  FOOTER_PERMISSION_MENU_OPEN_CLASS,
  attachFooterPermissionControl,
} from "./footerPermissionControl";
import { resolveRuntimeBadgeState } from "./runtimeBadge";
import { attachFooterQuotaControl } from "./footerQuotaControl";
import { readFooterQuota } from "./footerQuotaReader";
import { resolveQuotaTarget } from "../../providers/quota";
import { createWebChatHistoryController } from "./setupHandlers/controllers/webChatHistoryController";
import {
  createHistoryLifecycleController,
  disposePendingDeletionSubscriptionForBody,
  disposeConversationCatalogSubscriptionForBody,
  type RuntimeHistoryTarget,
} from "./setupHandlers/controllers/historyLifecycleController";
import { resolveUnifiedHistorySystems } from "./unifiedHistorySource";
import { attachComposePreviewInteractionController } from "./setupHandlers/controllers/composePreviewInteractionController";
import { attachFontScaleShortcutController } from "./setupHandlers/controllers/fontScaleShortcutController";
import { updateHeaderSpacing } from "./setupHandlers/controllers/headerSpacing";
import { attachComposeCaptureController } from "./setupHandlers/controllers/composeCaptureController";
import { attachFloatingMenuInteractionController } from "./setupHandlers/controllers/floatingMenuInteractionController";
import { createPaperPickerController } from "./setupHandlers/controllers/paperPickerController";
import { createActionCommandController } from "./setupHandlers/controllers/actionCommandController";
import { parseInlineActionCommand } from "./setupHandlers/controllers/actionCommandParams";
import { addZoteroItemsAsDefaultContext } from "./contextSelectionActions";
import { registerContextSurfaceActionTarget } from "./zoteroItemContextMenu";
import {
  createCoalescedFrameScheduler,
  getOrCreateKeyedInFlightTask,
} from "./setupHandlers/controllers/uiSchedulingController";
import {
  buildPaperSourceOptions as buildPaperSourceOptionsController,
  canRevealMineruCacheForSourceOption,
  resolvePaperPdfSupportForConversation,
  shouldDowngradePdfSourceForConversation,
  type MineruSourceAction,
  type MineruSourceUiState,
  type PaperSourceOption,
} from "./setupHandlers/controllers/paperSourceOptionsController";
import { clearAllAgentToolCaches } from "../../agent/tools";
import { clearAgentConversationState } from "./agentConversationCleanup";
import { renderShortcuts } from "./shortcuts";
import { loadConversationHistoryScope } from "./historyLoader";
import {
  buildClaudeScope,
  getClaudeRuntimeModelEntries as getFallbackClaudeRuntimeModelEntries,
  invalidateAllClaudeHotRuntimes,
  listClaudeEfforts,
  listClaudeModels,
  rememberClaudeConversationSelection,
  refreshClaudeSlashCommands,
  touchClaudeConversation,
} from "../../claudeCode/runtime";
import {
  getClaudeBridgeUrl,
  getClaudeSettingSourcesCsvByPref,
  setClaudeCodeModeEnabled,
  getLastUsedClaudePaperConversationKey,
  removeLastUsedClaudeGlobalConversationKey,
  removeLastUsedClaudePaperConversationKey,
} from "../../claudeCode/prefs";
import {
  buildClaudeRuntimeModelEntries,
  type ClaudeModelCatalogEntry,
  type ClaudeModelCatalogRequestContext,
} from "../../claudeCode/modelCatalog";
import {
  getLastUsedCodexConversationMode,
  getLastUsedCodexPaperConversationKey,
  isCodexAppServerModeEnabled,
  removeLastUsedCodexGlobalConversationKey,
  removeLastUsedCodexPaperConversationKey,
} from "../../codexAppServer/prefs";
import { getConfiguredCodexAppServerBinaryPath } from "../../codexAppServer/binaryPath";
import { buildCodexAppServerReasoningConfig } from "../../codexAppServer/reasoning";
import {
  buildCodexRuntimeModelEntries,
  getCodexAppServerReasoningChoices,
  loadCodexAppServerModelCatalog,
  resolveCodexAppServerReasoningSelection,
  type CodexAppServerModelCatalogEntry,
} from "../../codexAppServer/modelCatalog";
import {
  activeClaudeGlobalConversationByLibrary,
  activeClaudePaperConversationByPaper,
  buildClaudePaperStateKey,
} from "../../claudeCode/state";
import {
  retainClaudeRuntimeForBody,
  releaseClaudeRuntimeForBody,
} from "../../claudeCode/runtimeRetention";
import { isClaudePaperPortalItem } from "../../claudeCode/portal";
import { touchClaudeConversationTitle } from "../../claudeCode/store";
import {
  createClaudeGlobalPortalItem,
  createClaudePaperPortalItem,
} from "../../claudeCode/portal";
import { touchCodexConversationTitle } from "../../codexAppServer/store";
import {
  createCodexGlobalPortalItem,
  createCodexPaperPortalItem,
} from "../../codexAppServer/portal";
import type { CodexReasoningChoice } from "../../codex/catalogSelection";
import {
  createCodexDirectModelReasoningController,
  type CodexDirectModelReasoningController,
} from "./setupHandlers/controllers/codexDirectModelReasoningController";

type ActionMenuTrigger = "/" | "$";
type ActiveActionToken = PaperSearchSlashToken & {
  trigger: ActionMenuTrigger;
};

setQueuedFollowUpBodySyncCallback((body) => {
  try {
    activeContextPanelStateSync.get(body)?.();
  } catch (_err) {
    void _err;
  }
});

/** Monotonic counter incremented every time setupHandlers rebuilds a panel. */
let setupHandlersGeneration = 0;

export type ContextPreviewRenderMetrics = {
  previousHeight: number;
  nextHeight: number;
};

export type SetupHandlersHooks = {
  onConversationHistoryChanged?: () => void;
  /**
   * The panel moved to another conversation by itself (its own New chat
   * button, a deleted chat's fallback). The standalone window adopts it, so
   * its state and Miscellaneous view follow the chat the panel shows.
   * Fired only when the key changed; a window-driven switch has already moved
   * the window to this key, which makes the handler a no-op.
   */
  onConversationIdentityChanged?: (
    item: Zotero.Item,
    conversationKey: number,
  ) => void;
  onDefaultContextRendered?: () => void;
  onContextPreviewRendered?: (metrics: ContextPreviewRenderMetrics) => void;
  onWebChatModeChanged?: (isWebChat: boolean) => void;
  prepareItemsAsDefaultContextTarget?: () =>
    | Promise<boolean | void>
    | boolean
    | void;
  /** Called by standalone to clear force-new-chat intent before loading a session. */
  clearWebChatNewChatIntent?: () => void;
  /**
   * Called by standalone before it switches the conversation runtime while the
   * mounted panel is in WebChat, so a non-webchat model entry is restored
   * before the remount. Resolves false when the panel was not in WebChat.
   */
  leaveWebChatMode?: () => Promise<boolean>;
  /** Called by standalone to resolve the currently selected model consistently. */
  getCurrentModelName?: () => string | null;
  /**
   * Called when the runtime badge menu picks a runtime. The standalone window
   * owns its runtime and remounts the panel, so it switches itself (with a
   * fresh draft). Without this hook the panel switches the sidebar runtime.
   */
  requestConversationSystem?: (system: ConversationSystem) => void;
};

const setupHandlersCleanupByBody = new WeakMap<Element, () => void>();

export function disposeSetupHandlers(body: Element): void {
  setupHandlersCleanupByBody.get(body)?.();
}

export function setupHandlers(
  body: Element,
  initialItem?: Zotero.Item | null,
  hooks?: SetupHandlersHooks,
) {
  const existingPanelRoot = body.querySelector(
    "#llm-main",
  ) as HTMLElement | null;
  // A repeated lifecycle callback for the same completed DOM must be a true
  // no-op. Disposing before this check would tear down cleanup-managed
  // observers and registrations, then return without replacing them.
  if (existingPanelRoot?.dataset.handlersInitialized) {
    return;
  }
  disposeSetupHandlers(body);
  const preferredConversationSystem =
    existingPanelRoot?.dataset?.conversationSystem === "claude_code"
      ? "claude_code"
      : existingPanelRoot?.dataset?.conversationSystem === "codex"
        ? "codex"
        : existingPanelRoot?.dataset?.conversationSystem === "upstream"
          ? "upstream"
          : resolveConversationSystemForItem(initialItem);
  const preferredConversationMode =
    existingPanelRoot?.dataset?.conversationKind === "global"
      ? "global"
      : existingPanelRoot?.dataset?.conversationKind === "paper"
        ? "paper"
        : undefined;
  // Which surface's remembered selection this panel reads and writes: the
  // standalone window's own, or the one every sidebar panel shares.
  const selectionSurface = (): SelectionSurface =>
    resolveSelectionSurfaceForBody(body);
  // The window and its side chat: neither takes nor releases the sidebar's
  // library lock. Only the sidebar (embedded) surface writes prefs.
  const isStandaloneSelectionSurface = () => selectionSurface() !== "embedded";
  // The window's temporary side chat (markSidePanelBody): API runtime only,
  // never saved, and never a Zotero "Add as context" target.
  const isSidePanel = isSidePanelBody(body);
  // WebChat drives one browser session that only the sidebar and the
  // standalone window use: a side chat is never saved, and a torn-off window
  // never takes the session from the standalone window.
  const offersWebChatModels = () =>
    !isSidePanel && !isTornSurface(selectionSurface());
  // The model and backend this panel's surface has chosen (surfaceChoices.ts):
  // the sidebar's are the saved prefs; the window's live in memory.
  const panelChoices = bindSurfaceChoices(selectionSurface);
  const resolvedInitialState = resolveInitialPanelItemState(initialItem, {
    conversationSystem: preferredConversationSystem,
    conversationMode: preferredConversationMode,
    surface: selectionSurface(),
  });
  const rawPanelItem =
    activeContextPanelRawItems.get(body) || initialItem || null;
  if (__env__ !== "production" && !getPanelHostBinding(body)) {
    // A body declares its own surface (a torn window's "torn:<id>"); the
    // standalone window's is the default.
    const declaredSurface = selectionSurface();
    if (isSidePanel) {
      bindSidePanelHost(body, rawPanelItem);
    } else if (existingPanelRoot?.dataset.standalone === "true") {
      bindStandalonePanelHost(
        body,
        rawPanelItem,
        isTornSurface(declaredSurface) ? declaredSurface : "standalone",
      );
    } else {
      bindTestPanelHost(body, rawPanelItem);
    }
  }
  const resolveLiveRawPanelItem = (): Zotero.Item | null => {
    if (activeContextPanelRawItems.has(body)) {
      return activeContextPanelRawItems.get(body) || null;
    }
    return rawPanelItem;
  };
  let item = resolvedInitialState.item;
  let basePaperItem =
    resolvedInitialState.basePaperItem ||
    resolveConversationBaseItem(rawPanelItem);
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
    runtimeMenu,
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
    chatModeTabs,
    paperChatTabBtn,
    libraryChatTabBtn,
    modeSwitch,
    historyRowMenu,
    historyRowRenameBtn,
    historyUndo,
    historyUndoText,
    historyUndoBtn,
    topToast,
    runtimeSystemControls,
    codexSystemToggleBtn,
    claudeSystemToggleBtn,
    selectTextBtn,
    screenshotBtn,
    uploadBtn,
    uploadInput,
    slashMenu,
    slashUploadOption,
    slashReferenceOption,
    slashPastConversationOption,
    slashPdfPageOption,
    slashPdfMultiplePagesOption,
    slashSideChatOption,
    imagePreview,
    contextPreviews,
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
    shortcutMenu,
    queueBar,
    responseMenu,
    responseMenuCopyBtn,
    responseMenuNoteBtn,
    responseMenuForkBtn,
    responseMenuDeleteBtn,
    promptMenu,
    promptMenuForkBtn,
    promptMenuDeleteBtn,
    exportMenu,
    exportMenuCopyBtn,
    exportMenuNoteBtn,
    retryModelMenu,
    status,
    permissionControl,
    permissionButton,
    permissionMenu,
    chatBox,
    panelRoot,
  } = panelRefs;

  if (!inputBox || !sendBtn) {
    appLogger.warn("LLM: Could not find input or send button");
    return;
  }

  if (!panelRoot) {
    appLogger.warn("LLM: Could not find panel root");
    return;
  }

  const panelLifecycle = new PanelLifecycle();

  const isStandalonePanel = panelRoot.dataset.standalone === "true";
  // The header's Task progress button. The standalone window binds its own
  // title-bar button to this body, so its hidden header button stays unbound.
  const taskProgressToggleBtn = body.querySelector(
    "#llm-task-progress-toggle",
  ) as HTMLButtonElement | null;
  const unbindTaskProgressToggle =
    taskProgressToggleBtn && !isStandalonePanel
      ? bindTaskProgressToggle(body, taskProgressToggleBtn)
      : null;
  const chatShell = body.querySelector(
    "#llm-chat-shell",
  ) as HTMLDivElement | null;
  if (chatBox && chatShell) {
    createConversationTurnNavigator({
      body,
      chatShell,
      chatBox,
      conversationKey: item ? getConversationKey(item) : null,
      minimumWidthPx: isStandalonePanel
        ? STANDALONE_TURN_NAVIGATOR_MIN_WIDTH_PX
        : SIDEBAR_TURN_NAVIGATOR_MIN_WIDTH_PX,
    });
  }

  const thisGen = String(++setupHandlersGeneration);
  panelRoot.dataset.handlersAttached = thisGen;
  panelRoot.dataset.rawContextItemId = rawPanelItem
    ? `${Number(rawPanelItem.id || 0) || ""}`
    : "";

  activeContextPanels.set(body, () => item);
  const ownershipProtectedEventTypes = [
    "pointerdown",
    "mousedown",
    "click",
    "command",
    "keydown",
    "input",
    "change",
    "paste",
    "drop",
  ] as const;
  const enforcePanelOwnershipForEvent = (event: Event) => {
    if (!item) return;
    const target = event.target as Node | null;
    if (target !== body && target && !panelRoot.contains(target)) return;
    // The decision itself lives in panelHostOwnership.ts: a panel that refuses
    // its own input must still be escapable, so events aimed at the runtime
    // toggles (which re-resolve the panel's scope before switching) and
    // application accelerators the panel does not bind are delivered, while
    // everything else stays fenced. Without that, any scope bug degrades into a
    // dead, apparently unquittable UI.
    if (!shouldOwnershipFenceSwallowEvent(body, item, event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const eventType of ownershipProtectedEventTypes) {
    body.addEventListener(eventType, enforcePanelOwnershipForEvent, true);
  }
  let isWebChatModeActive = () => panelRoot.dataset.webchatMode === "true";
  let leaveWebChatMode: (
    options?: LeaveWebChatModeOptions,
  ) => Promise<boolean> = async () => false;
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

  let renderQueuedFollowUpInputs: () => void = () => {};
  let scheduleQueuedFollowUpDrain: () => void = () => {};
  let isQueuedFollowUpSendAvailable: () => boolean = () => false;
  let queueFollowUpInput: (
    text: string,
    options?: { preserveInputDraft?: boolean },
  ) => boolean = () => false;

  let quotaControl: ReturnType<typeof attachFooterQuotaControl> | null = null;
  let quotaPendingConversationKey: number | null = null;
  let quotaRequestWasPending = false;
  const syncRequestUiForCurrentConversation = () => {
    const activeConversationKey = item ? getConversationKey(item) : null;
    const isWebChatActive = isWebChatModeActive();
    const isCurrentConversationPending =
      activeConversationKey !== null &&
      Number.isFinite(activeConversationKey) &&
      isRequestPending(activeConversationKey);
    if (
      quotaRequestWasPending &&
      !isCurrentConversationPending &&
      quotaPendingConversationKey === activeConversationKey
    ) {
      void quotaControl?.sync(true);
    }
    quotaPendingConversationKey = activeConversationKey;
    quotaRequestWasPending = isCurrentConversationPending;
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
    appLogger.warn("LLM: Could not find panel document");
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
      appLogger.warn("LLM: standalone history hook failed", err);
    }
  };
  const isGlobalMode = () => resolveDisplayConversationKind(item) === "global";
  const isPaperMode = () => resolveDisplayConversationKind(item) === "paper";
  const initialConversationSystem: ConversationSystem =
    panelRoot.dataset.conversationSystem === "claude_code"
      ? "claude_code"
      : panelRoot.dataset.conversationSystem === "codex"
        ? "codex"
        : resolvePreferredConversationSystem({
            item,
            surface: selectionSurface(),
          });
  let currentConversationSystem: ConversationSystem =
    resolvePreferredConversationSystem({
      item,
      preferredSystem: initialConversationSystem,
      surface: selectionSurface(),
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
  // A side chat is never saved, so it cannot use a runtime that keeps
  // provider-side state (Claude Code, Codex): their switches stay hidden.
  const isClaudeModeAvailable = () =>
    !isSidePanel && getClaudeCodeModeEnabled();
  const isCodexModeAvailable = () =>
    !isSidePanel && isCodexAppServerModeEnabled();
  let claudeModelCatalogStatus: "idle" | "loading" | "ready" | "error" = "idle";
  let claudeModelCatalogError = "";
  let claudeModelCatalogModels: ClaudeModelCatalogEntry[] = [];
  let claudeModelCatalogLegacy = false;
  let claudeModelCatalogInFlight: Promise<void> | null = null;
  let claudeModelCatalogInFlightForced = false;
  let claudeModelCatalogRequestId = 0;
  let claudeModelCatalogIdentity = "";
  let claudeModelCatalogLoadedAt = 0;
  const CLAUDE_MODEL_CATALOG_UI_TTL_MS = 60_000;
  let codexModelCatalogStatus: "idle" | "loading" | "ready" | "error" = "idle";
  let codexModelCatalogError = "";
  let codexModelCatalogModels: CodexAppServerModelCatalogEntry[] = [];
  let codexModelCatalogInFlight: Promise<void> | null = null;
  let codexModelCatalogPath = "";
  let codexModelCatalogRequestId = 0;
  const resolveClaudeModelCatalogContext = ():
    | ClaudeModelCatalogRequestContext
    | undefined => {
    if (!item) return undefined;
    const conversationKey = getConversationKey(item);
    const kind = resolveDisplayConversationKind(item);
    const baseItem = resolveConversationBaseItem(item);
    const libraryID = Number(item.libraryID || baseItem?.libraryID || 0);
    if (
      !Number.isFinite(conversationKey) ||
      conversationKey <= 0 ||
      !kind ||
      !Number.isFinite(libraryID) ||
      libraryID <= 0
    ) {
      return undefined;
    }
    const scope = buildClaudeScope({
      libraryID: Math.floor(libraryID),
      kind,
      paperItemID:
        kind === "paper" ? Number(baseItem?.id || 0) || undefined : undefined,
      paperTitle:
        kind === "paper"
          ? String(baseItem?.getField?.("title") || "").trim() || undefined
          : undefined,
    });
    return {
      conversationKey,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      scopeLabel: scope.scopeLabel,
    };
  };
  const resolveClaudeModelCatalogIdentity = (
    context = resolveClaudeModelCatalogContext(),
  ) =>
    [
      getClaudeBridgeUrl().trim().replace(/\/+$/, ""),
      getClaudeSettingSourcesCsvByPref(),
      context?.conversationKey || "runtime-root",
      context?.scopeType || "",
      context?.scopeId || "",
    ].join("|");
  const refreshOpenClaudeModelMenu = () => {
    updateModelButton();
    if (!modelMenu || !modelBtn || !isFloatingMenuOpen(modelMenu)) return;
    rebuildModelMenu();
    if (!modelMenu.childElementCount) {
      closeModelMenu();
      return;
    }
    positionComposerMenu(body, modelMenu, modelBtn);
  };
  const ensureClaudeModelCatalogLoaded = (force = false): Promise<void> => {
    if (!isClaudeConversationSystem()) return Promise.resolve();
    const context = resolveClaudeModelCatalogContext();
    const identity = resolveClaudeModelCatalogIdentity(context);
    const identityChanged = identity !== claudeModelCatalogIdentity;
    if (
      !force &&
      !identityChanged &&
      claudeModelCatalogStatus === "ready" &&
      Date.now() - claudeModelCatalogLoadedAt < CLAUDE_MODEL_CATALOG_UI_TTL_MS
    ) {
      return Promise.resolve();
    }
    if (
      claudeModelCatalogInFlight &&
      !identityChanged &&
      (!force || claudeModelCatalogInFlightForced)
    ) {
      // Rapid re-opens piggyback on the running FORCED fetch instead of
      // launching a parallel one; an unforced in-flight load never satisfies
      // a forced request (its data may come from the bridge cache).
      return claudeModelCatalogInFlight;
    }
    if (identityChanged) {
      claudeModelCatalogModels = [];
      claudeModelCatalogLegacy = false;
      claudeModelCatalogLoadedAt = 0;
    }
    claudeModelCatalogStatus = "loading";
    claudeModelCatalogError = "";
    claudeModelCatalogIdentity = identity;
    claudeModelCatalogInFlightForced = force;
    const requestId = ++claudeModelCatalogRequestId;
    refreshOpenClaudeModelMenu();
    claudeModelCatalogInFlight = initAgentSubsystem()
      .then((coreRuntime) =>
        listClaudeModels(coreRuntime, force, context, {
          conversationSystem: getConversationSystem(),
        }),
      )
      .then((catalog) => {
        if (
          requestId !== claudeModelCatalogRequestId ||
          identity !== resolveClaudeModelCatalogIdentity()
        ) {
          return;
        }
        claudeModelCatalogModels = catalog.models;
        claudeModelCatalogLegacy = catalog.legacy;
        claudeModelCatalogStatus = "ready";
        claudeModelCatalogError = "";
        claudeModelCatalogLoadedAt = Date.now();
      })
      .catch((error: unknown) => {
        if (
          requestId !== claudeModelCatalogRequestId ||
          identity !== resolveClaudeModelCatalogIdentity()
        ) {
          return;
        }
        claudeModelCatalogStatus = "error";
        claudeModelCatalogError =
          error instanceof Error ? error.message : String(error);
        appLogger.warn("Claude Code: failed to load model catalog", error);
      })
      .finally(() => {
        if (requestId !== claudeModelCatalogRequestId) return;
        claudeModelCatalogInFlight = null;
        claudeModelCatalogInFlightForced = false;
        refreshOpenClaudeModelMenu();
      });
    return claudeModelCatalogInFlight;
  };
  const getClaudeRuntimeModelEntries = (): RuntimeModelEntry[] =>
    buildClaudeRuntimeModelEntries({
      models: claudeModelCatalogModels,
      selectedModel: panelChoices.getClaudeRuntimeModel(),
    });
  const getSelectedClaudeRuntimeEntry = (): RuntimeModelEntry => {
    const selectedModel = panelChoices.getClaudeRuntimeModel();
    const entries = getClaudeRuntimeModelEntries();
    return (
      entries.find((entry) => entry.model === selectedModel) ||
      entries[0] ||
      getFallbackClaudeRuntimeModelEntries()[0]!
    );
  };
  const resolveCurrentCodexReasoningSelection = () =>
    resolveCodexAppServerReasoningSelection({
      mode: panelChoices.getCodexReasoningMode(),
      choices: getCodexAppServerReasoningChoices({
        models: codexModelCatalogModels,
        selectedModel: panelChoices.getCodexRuntimeModel(),
      }),
      catalogReady: codexModelCatalogStatus === "ready",
    });
  const getCodexReasoningChoices = () =>
    resolveCurrentCodexReasoningSelection().choices;
  const reconcileSelectedCodexReasoningMode = () => {
    const currentMode = panelChoices.getCodexReasoningMode();
    const reconciledMode = resolveCurrentCodexReasoningSelection().mode;
    if (codexModelCatalogStatus === "ready" && reconciledMode !== currentMode) {
      panelChoices.setCodexReasoningMode(reconciledMode);
    }
    return reconciledMode;
  };
  const refreshOpenCodexModelMenu = () => {
    updateModelButton();
    updateReasoningButton();
    if (reasoningMenu && reasoningBtn && isFloatingMenuOpen(reasoningMenu)) {
      rebuildReasoningMenu();
      positionComposerMenu(body, reasoningMenu, reasoningBtn);
    }
    if (!modelMenu || !modelBtn || !isFloatingMenuOpen(modelMenu)) return;
    rebuildModelMenu();
    if (!modelMenu.childElementCount) {
      closeModelMenu();
      return;
    }
    positionComposerMenu(body, modelMenu, modelBtn);
  };
  const ensureCodexModelCatalogLoaded = (force = false): Promise<void> => {
    if (!isCodexConversationSystem()) return Promise.resolve();
    const codexPath = getConfiguredCodexAppServerBinaryPath();
    const pathChanged = codexPath !== codexModelCatalogPath;
    if (!force && codexModelCatalogStatus === "ready" && !pathChanged) {
      return Promise.resolve();
    }
    if (codexModelCatalogInFlight && !pathChanged)
      return codexModelCatalogInFlight;
    if (pathChanged) {
      codexModelCatalogModels = [];
    }
    const requestId = ++codexModelCatalogRequestId;
    const isCurrentRequest = () =>
      !setupHandlersCleaned &&
      requestId === codexModelCatalogRequestId &&
      codexPath === getConfiguredCodexAppServerBinaryPath();
    codexModelCatalogStatus = "loading";
    codexModelCatalogError = "";
    codexModelCatalogPath = codexPath;
    refreshOpenCodexModelMenu();
    codexModelCatalogInFlight = loadCodexAppServerModelCatalog({ codexPath })
      .then((catalog) => {
        if (!isCurrentRequest()) return;
        codexModelCatalogModels = catalog.models;
        codexModelCatalogStatus = "ready";
        codexModelCatalogError = "";
        reconcileSelectedCodexReasoningMode();
      })
      .catch((error: unknown) => {
        if (!isCurrentRequest()) return;
        codexModelCatalogStatus = "error";
        codexModelCatalogError =
          error instanceof Error ? error.message : String(error);
        appLogger.warn("Codex app-server: failed to load model catalog", error);
      })
      .finally(() => {
        if (requestId !== codexModelCatalogRequestId) return;
        codexModelCatalogInFlight = null;
        if (!setupHandlersCleaned) refreshOpenCodexModelMenu();
      });
    return codexModelCatalogInFlight;
  };
  const getCodexRuntimeModelEntries = (): RuntimeModelEntry[] => {
    const model = panelChoices.getCodexRuntimeModel();
    return buildCodexRuntimeModelEntries({
      models: codexModelCatalogModels,
      selectedModel: model,
      codexPath: getConfiguredCodexAppServerBinaryPath(),
    });
  };
  const getSelectedCodexRuntimeEntry = (): RuntimeModelEntry => {
    const selectedModel = panelChoices.getCodexRuntimeModel().toLowerCase();
    const entries = getCodexRuntimeModelEntries();
    return (
      entries.find((entry) => entry.model.toLowerCase() === selectedModel) ||
      entries[0]!
    );
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
    return resolveRuntimeModeForConversation({
      isRuntimeConversationSystem: isRuntimeConversationSystem(),
      runtimeConversationSystem: getConversationSystem(),
      isWebChat: isWebChatModeActive(),
      agentModeEnabled: getAgentModeEnabled(),
    });
  };
  let syncFooterPermissionControl = () => Promise.resolve();
  let disposeFooterPermissionControl: (() => void) | null = null;
  const updateRuntimeModeButton = () => {
    updateRuntimeModeButtonState();
    // Plain chat lists the scope only; Agent mode records reads.
    syncTaskProgressPanel(body);
  };
  const closeRuntimeMenu = () => {
    if (!runtimeMenu) return;
    setFloatingMenuOpen(runtimeMenu, FOOTER_PERMISSION_MENU_OPEN_CLASS, false);
    runtimeMenu.replaceChildren();
    runtimeModeBtn?.setAttribute("aria-expanded", "false");
  };
  const getRuntimeBadgeState = () => {
    let webChatActive = false;
    try {
      webChatActive = isWebChatModeActive();
    } catch {
      /* not ready */
    }
    return resolveRuntimeBadgeState({
      system: getConversationSystem(),
      agentEnabled: getAgentModeEnabled(),
      codexEnabled: isCodexModeAvailable(),
      claudeEnabled: isClaudeModeAvailable(),
      isWebChat: webChatActive,
      isSideChat: isSidePanel,
      isTornWindow: isTornSurface(selectionSurface()),
    });
  };
  const updateRuntimeModeButtonState = () => {
    void syncFooterPermissionControl();
    if (!runtimeModeBtn) return;
    const state = getRuntimeBadgeState();
    const mode = getCurrentRuntimeMode();
    panelRoot.dataset.runtimeMode = mode;
    runtimeModeBtn.style.display = state.visible ? "" : "none";
    if (!state.visible) {
      closeRuntimeMenu();
      return;
    }
    const label = runtimeModeBtn.querySelector(
      ".llm-agent-toggle-label",
    ) as HTMLSpanElement | null;
    if (label) label.textContent = state.label;
    runtimeModeBtn.dataset.mode = mode;
    runtimeModeBtn.dataset.system = getConversationSystem();
    runtimeModeBtn.classList.toggle(
      "llm-runtime-mode-static",
      !state.clickable,
    );
    runtimeModeBtn.disabled = !state.clickable;
    if (state.clickable) {
      runtimeModeBtn.removeAttribute("aria-disabled");
      runtimeModeBtn.setAttribute("aria-haspopup", "menu");
      if (!runtimeModeBtn.hasAttribute("aria-expanded")) {
        runtimeModeBtn.setAttribute("aria-expanded", "false");
      }
      runtimeModeBtn.title = t("Switch runtime");
      runtimeModeBtn.setAttribute(
        "aria-label",
        `${state.label}, ${t("Switch runtime")}`,
      );
    } else {
      closeRuntimeMenu();
      runtimeModeBtn.setAttribute("aria-disabled", "true");
      runtimeModeBtn.removeAttribute("aria-haspopup");
      runtimeModeBtn.removeAttribute("aria-expanded");
      runtimeModeBtn.title = state.label;
      runtimeModeBtn.setAttribute("aria-label", state.label);
    }
  };
  const setCurrentRuntimeMode = (mode: ChatRuntimeMode) => {
    if (!item || isRuntimeConversationSystem()) {
      updateRuntimeModeButton();
      return;
    }
    selectedRuntimeModeCache.set(getConversationKey(item), mode);
    updateRuntimeModeButton();
  };
  const panelRuntimeSystemControls: RuntimeSystemControls = {
    group: runtimeSystemControls,
    buttons: {
      codex: codexSystemToggleBtn,
      claude_code: claudeSystemToggleBtn,
    },
  };
  let runtimeSystemSwitchInFlight = false;
  const runtimeDivider = body.querySelector(
    "#llm-header-runtime-controls .llm-header-runtime-divider",
  ) as HTMLElement | null;
  const updateRuntimeSystemToggles = () => {
    const state = syncRuntimeSystemControls(panelRuntimeSystemControls, {
      activeSystem: getConversationSystem(),
      codexEnabled: isCodexModeAvailable(),
      claudeEnabled: isClaudeModeAvailable(),
      busy: runtimeSystemSwitchInFlight,
    });
    // The divider before the runtime systems goes when they do. Their
    // wrapper stays: in the Stacked layout it also holds the mode chip.
    if (runtimeDivider) {
      runtimeDivider.style.display = state.groupVisible ? "" : "none";
    }
  };
  let claudeWarmupInFlight: Promise<void> | null = null;
  const warmClaudeModeCaches = () => {
    if (!isClaudeModeAvailable()) return;
    if (claudeWarmupInFlight) return;
    claudeWarmupInFlight = initAgentSubsystem()
      .then((coreRuntime) => {
        const context = resolveClaudeModelCatalogContext();
        // This panel's own system gates the lists, not the saved one.
        const gate = { conversationSystem: getConversationSystem() };
        return Promise.allSettled([
          refreshClaudeSlashCommands(coreRuntime, false),
          listClaudeEfforts(
            coreRuntime,
            getSelectedClaudeRuntimeEntry().model,
            context,
            gate,
          ),
          listClaudeModels(coreRuntime, false, context, gate),
        ]);
      })
      .catch((err: unknown) => {
        appLogger.warn("LLM: Failed to warm Claude mode caches", err);
      })
      .finally(() => {
        claudeWarmupInFlight = null;
      })
      .then(() => undefined);
  };
  let resetComposePreviewUI = () => {};
  let updateModelButton: (onlyIfChanged?: boolean) => void = () => {};
  let updateReasoningButton: (onlyIfChanged?: boolean) => void = () => {};
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
    options?: { quietHistory?: boolean },
  ) => Promise<boolean> = async () => false;
  let switchPaperConversation: (
    nextConversationKey?: number,
    options?: {
      paperItem?: Zotero.Item | null;
      allowedCatalogPaperItemID?: number;
      quietHistory?: boolean;
    },
  ) => Promise<boolean | void> = async () => {};
  let createAndSwitchGlobalConversation: (
    forceFresh?: boolean,
  ) => Promise<boolean | void> = async () => {};
  let createAndSwitchPaperConversation: (
    forceFresh?: boolean,
  ) => Promise<boolean | void> = async () => {};
  let ensureWebChatSessionPaperConversation: () => Promise<
    boolean | void
  > = async () => {};
  let queueTurnDeletion: (target: {
    conversationKey: number;
    userTimestamp: number;
    assistantTimestamp: number;
    userMessageID?: number;
    assistantMessageID?: number;
  }) => Promise<void> = async () => {};
  let forkConversationFromTurn: (target: {
    item: Zotero.Item;
    conversationKey: number;
    userTimestamp: number;
    assistantTimestamp: number;
  }) => Promise<void> = async () => {};
  let closePaperPicker = () => {};
  let clearForcedSkill = () => {};
  let renderWebChatHistoryMenu: () => Promise<void> = async () => {};
  let isWebChatMode = () => isWebChatModeActive();
  /**
   * Moves this panel to `nextSystem`. Without a target it opens that runtime's
   * remembered conversation (or a fresh draft with `forceFresh`). With a
   * `target` (a history row of that runtime) it opens the target directly and
   * never loads the remembered conversation first. Resolves true when the
   * panel ended on the requested runtime.
   */
  const switchConversationSystem = async (
    nextSystem: ConversationSystem,
    options?: { forceFresh?: boolean; target?: RuntimeHistoryTarget },
  ): Promise<boolean> => {
    if (
      !item ||
      !requireCurrentPanelOwnership(body, item, "switch-provider-system")
    ) {
      return false;
    }
    const ownershipLease = capturePanelOperationLease(body);
    if (!ownershipLease) return false;
    // WebChat is an upstream-only provider mode. Restore a non-webchat model
    // entry before the runtime changes so a later return to upstream (or the
    // next Zotero start) cannot silently re-enter webchat. The runtime switch
    // below replaces the conversation, so no paper conversation restore here.
    if (isWebChatModeActive()) {
      await leaveWebChatMode({ restoreConversation: false });
      if (!isPanelOperationLeaseCurrent(ownershipLease)) return false;
    }
    const noteSession = resolveCurrentNoteSession();
    if (noteSession) {
      // A note lists only its own runtime's chats, so no history row of
      // another runtime can ask to open here.
      if (options?.target) return false;
      const resolvedNextSystem = resolveNoteFocusSystemSwitch({
        nextSystem,
        codexAvailable: isCodexModeAvailable(),
        claudeAvailable: isClaudeModeAvailable(),
      });
      if (!resolvedNextSystem) return false;
      if (resolvedNextSystem === getConversationSystem()) return true;
      persistDraftInputForCurrentConversation();
      const nextKey = resolveConversationKeyForNoteFocus(item, {
        conversationSystem: resolvedNextSystem,
      });
      if (!nextKey) return false;
      const nextItem = createNoteConversationItem(
        item,
        resolvedNextSystem,
        nextKey,
      );
      if (
        !canCommitPanelConversation(
          body,
          nextItem,
          "switch-note-provider",
          ownershipLease,
        )
      )
        return false;
      item = nextItem;
      panelChoices.setConversationSystem(resolvedNextSystem);
      currentConversationSystem = resolvedNextSystem;
      syncConversationIdentity();
      syncQueuedFollowUpRegistration();
      if (resolvedNextSystem === "claude_code") {
        warmClaudeModeCaches();
      }
      updateRuntimeModeButton();
      updateRuntimeSystemToggles();
      if (options?.forceFresh === true) {
        await createAndSwitchPaperConversation(true);
        return true;
      }
      await ensureConversationLoaded(item, { body });
      restoreDraftInputForCurrentConversation();
      refreshChatPreservingScroll();
      resetComposePreviewUI();
      updateModelButton();
      updateReasoningButton();
      return true;
    }
    if (nextSystem === getConversationSystem()) return true;
    const libraryID = getCurrentLibraryID();
    if (!libraryID) return false;
    const forceFresh = options?.forceFresh === true;
    const previousSystem = getConversationSystem();
    persistDraftInputForCurrentConversation();
    panelChoices.setConversationSystem(nextSystem);
    currentConversationSystem = nextSystem;
    // The mounted DOM scope must keep describing the conversation the panel is
    // actually on. `dataset.conversationSystem` is half of that scope, so
    // writing the new system here — before the conversation key has moved —
    // makes the panel's own ownership check disagree with its own item, and
    // every later step of this switch is refused by that check. It is written
    // by `syncConversationIdentity` instead, together with the new key, once
    // the panel has committed the conversation of the system being entered.
    syncQueuedFollowUpRegistration();
    updateRuntimeSystemToggles();
    if (nextSystem === "claude_code") {
      warmClaudeModeCaches();
    }
    const target = options?.target;
    if (target) {
      // The panel has not left its conversation yet: put the runtime back.
      const restorePreviousSystem = () => {
        panelChoices.setConversationSystem(previousSystem);
        currentConversationSystem = previousSystem;
        syncQueuedFollowUpRegistration();
        updateRuntimeSystemToggles();
        updateRuntimeModeButton();
      };
      if (target.kind === "global") {
        const loaded = getWorkflowTestHistoryOpenFailure()?.({
          system: nextSystem,
          conversationKey: target.conversationKey,
        })
          ? false
          : await switchGlobalConversation(target.conversationKey);
        if (
          !loaded &&
          item &&
          (resolveConversationSystemForItem(item) || "upstream") !== nextSystem
        ) {
          restorePreviousSystem();
        }
        return loaded;
      }
      const rawBaseItem = target.paperItem || resolveCurrentPaperBaseItem();
      if (!rawBaseItem) {
        restorePreviousSystem();
        return false;
      }
      const resolvedState = resolveInitialPanelItemState(rawBaseItem, {
        conversationSystem: nextSystem,
        surface: selectionSurface(),
      });
      const nextItem = resolvedState.item || item;
      const nextBasePaperItem = resolvedState.basePaperItem || basePaperItem;
      if (
        !isPanelOperationLeaseCurrent(ownershipLease) ||
        !canCommitPanelConversation(
          body,
          nextItem,
          "switch-provider-system-commit",
          ownershipLease,
        ) ||
        (nextBasePaperItem &&
          !isPanelHostCompatibleWithPaper(body, nextBasePaperItem))
      ) {
        restorePreviousSystem();
        return false;
      }
      const previousItem = item;
      const previousBasePaperItem = basePaperItem;
      item = nextItem;
      basePaperItem = nextBasePaperItem;
      syncConversationIdentity();
      const loaded = await switchPaperConversation(target.conversationKey, {
        paperItem: target.paperItem || nextBasePaperItem,
        allowedCatalogPaperItemID: target.allowedCatalogPaperItemID,
      });
      if (loaded) return true;
      // The target could not open. Put the previous runtime and chat back; the
      // caller restores the remembered keys, so they agree with the panel.
      if (!isPanelOperationLeaseCurrent(ownershipLease)) return false;
      restorePreviousSystem();
      item = previousItem;
      basePaperItem = previousBasePaperItem;
      syncConversationIdentity();
      await ensureConversationLoaded(item as Zotero.Item, { body });
      if (!isPanelOperationLeaseCurrent(ownershipLease)) return false;
      restoreDraftInputForCurrentConversation();
      refreshChatPreservingScroll();
      resetComposePreviewUI();
      updateModelButton();
      updateReasoningButton();
      updateRuntimeSystemToggles();
      void refreshGlobalHistoryHeader();
      return false;
    }
    if (isGlobalMode()) {
      if (forceFresh) {
        await createAndSwitchGlobalConversation(true);
        return true;
      }
      const surface = selectionSurface();
      const nextConversationKey =
        nextSystem === "claude_code"
          ? recall({
              system: "claude_code",
              libraryID,
              kind: "global",
              surface,
            })
          : nextSystem === "codex"
            ? recall({ system: "codex", libraryID, kind: "global", surface })
            : (() => {
                // The library lock is the sidebar's; the window has none.
                const lockedKey =
                  surface !== "embedded"
                    ? null
                    : getLockedGlobalConversationKey(libraryID);
                if (lockedKey !== null) return lockedKey;
                // Upstream reads the active map only here, not the pref.
                const activeKey = recallActive({
                  system: "upstream",
                  libraryID,
                  kind: "global",
                  surface,
                });
                if (!isUpstreamGlobalConversationKey(activeKey)) return 0;
                return activeKey === GLOBAL_CONVERSATION_KEY_BASE
                  ? buildDefaultUpstreamGlobalConversationKey(libraryID)
                  : Math.floor(activeKey);
              })();
      if (nextConversationKey > 0) {
        await switchGlobalConversation(nextConversationKey);
      } else {
        await createAndSwitchGlobalConversation();
      }
      return true;
    }
    if (forceFresh) {
      const rawBaseItem = resolveCurrentPaperBaseItem();
      if (!rawBaseItem) return false;
      const resolvedState = resolveInitialPanelItemState(rawBaseItem, {
        conversationSystem: nextSystem,
        surface: selectionSurface(),
      });
      const nextItem = resolvedState.item || item;
      const nextBasePaperItem = resolvedState.basePaperItem || basePaperItem;
      if (
        !isPanelOperationLeaseCurrent(ownershipLease) ||
        !canCommitPanelConversation(
          body,
          nextItem,
          "switch-provider-system-commit",
          ownershipLease,
        ) ||
        (nextBasePaperItem &&
          !isPanelHostCompatibleWithPaper(body, nextBasePaperItem))
      ) {
        return false;
      }
      item = nextItem;
      basePaperItem = nextBasePaperItem;
      syncConversationIdentity();
      await createAndSwitchPaperConversation(true);
      return true;
    }
    const rawBaseItem = resolveCurrentPaperBaseItem();
    if (!rawBaseItem) return false;
    const resolvedState = resolveInitialPanelItemState(rawBaseItem, {
      conversationSystem: nextSystem,
      surface: selectionSurface(),
    });
    const nextItem = resolvedState.item || item;
    const nextBasePaperItem = resolvedState.basePaperItem || basePaperItem;
    if (
      !isPanelOperationLeaseCurrent(ownershipLease) ||
      !canCommitPanelConversation(
        body,
        nextItem,
        "switch-provider-system-commit",
        ownershipLease,
      ) ||
      (nextBasePaperItem &&
        !isPanelHostCompatibleWithPaper(body, nextBasePaperItem))
    ) {
      return false;
    }
    item = nextItem;
    basePaperItem = nextBasePaperItem;
    syncConversationIdentity();
    if (nextSystem === "claude_code") {
      warmClaudeModeCaches();
    }
    await ensureConversationLoaded(item as Zotero.Item, { body });
    if (!isPanelOperationLeaseCurrent(ownershipLease)) return false;
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
    updateRuntimeSystemToggles();
    void refreshGlobalHistoryHeader();
    return true;
  };
  const isClaudeConversationDraft = async (conversationKey: number) => {
    const summary = await conversationRepository.getCatalogEntry({
      system: "claude_code",
      conversationKey,
    });
    return Boolean(summary && (summary.userTurnCount || 0) === 0);
  };
  const isCodexConversationDraft = async (conversationKey: number) => {
    const summary = await conversationRepository.getCatalogEntry({
      system: "codex",
      conversationKey,
    });
    return Boolean(summary && (summary.userTurnCount || 0) === 0);
  };
  const resolveCurrentNoteParentItem = (): Zotero.Item | null => {
    const noteSession = resolveCurrentNoteSession();
    if (!noteSession?.parentItemId) return null;
    const parentItem = Zotero.Items.get(noteSession.parentItemId) || null;
    return parentItem?.isRegularItem?.() ? parentItem : null;
  };
  const resolvePaperChatBaseItem = (
    candidate: Zotero.Item | null | undefined,
  ): Zotero.Item | null => {
    return resolvePaperChatSourceItem(candidate);
  };
  const resolveActiveReaderPaperBaseItem = (): Zotero.Item | null => {
    const activeContext = getActiveContextAttachmentFromTabs();
    const resolvedFromContext =
      activeContext && activeContext.parentID
        ? Zotero.Items.get(activeContext.parentID) || null
        : activeContext;
    return resolvePaperChatSourceItem(resolvedFromContext);
  };
  const resolveCurrentPaperBaseItem = (): Zotero.Item | null => {
    const noteSession = resolveCurrentNoteSession();
    if (noteSession) return resolveConversationBaseItem(item);
    const resolvedBaseItem = chooseCurrentPaperBaseItemForMode({
      isGlobalMode: isGlobalMode(),
      liveRawBaseItem: resolvePaperChatBaseItem(resolveLiveRawPanelItem()),
      activeReaderBaseItem: resolveActiveReaderPaperBaseItem(),
      cachedBasePaperItem: resolvePaperChatBaseItem(basePaperItem),
      currentItemBaseItem: resolvePaperChatBaseItem(item),
    });
    return resolvedBaseItem || null;
  };

  // Compute conversation key early so all closures can reference it.
  let conversationKey = item ? getConversationKey(item) : null;
  const handleQuoteProvenanceRevalidationRequest = () => {
    const activeConversationKey = item ? getConversationKey(item) : null;
    if (activeConversationKey) {
      scheduleConversationQuoteRevalidation(activeConversationKey);
    }
  };
  body.addEventListener(
    QUOTE_PROVENANCE_REVALIDATION_REQUEST_EVENT,
    handleQuoteProvenanceRevalidationRequest,
  );
  const getTextContextConversationKey = (): number | null =>
    item ? getConversationKey(item) : null;
  // WebChat owns the paper slot's tooltip while it is active, and the Stacked
  // chip shows its site there.
  let webChatModeTabTitle = "";
  let webChatModeChipLabel = "";
  let lastSyncedModeTab: SidebarChatModeTab | null = null;
  // One sync for both mode controls, the Independent tabs and the Stacked
  // chip, so whichever the layout shows always matches the panel's mode.
  const syncChatModeTabs = () => {
    const state = resolveSidebarChatModeToggleState({
      isGlobalMode: Boolean(item) && isGlobalMode(),
      isNoteSession: isNoteSession(),
      isWebChat: panelRoot.dataset.webchatMode === "true",
    });
    const paperLabel = t(state.paperTabLabel);
    if (chatModeTabs && paperChatTabBtn && libraryChatTabBtn) {
      chatModeTabs.dataset.mode = state.activeTab;
      const paperLabelEl = paperChatTabBtn.querySelector(
        ".llm-header-mode-tab-label",
      );
      if (paperLabelEl) paperLabelEl.textContent = paperLabel;
      paperChatTabBtn.title =
        state.showWebChatDot && webChatModeTabTitle
          ? webChatModeTabTitle
          : paperLabel;
      for (const tab of [paperChatTabBtn, libraryChatTabBtn]) {
        const active = tab.dataset.tab === state.activeTab;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-pressed", active ? "true" : "false");
        tab.disabled = state.disabled;
        if (state.disabled) tab.setAttribute("aria-disabled", "true");
        else tab.removeAttribute("aria-disabled");
      }
    }
    if (modeSwitch) {
      const webChatSite = state.showWebChatDot ? webChatModeChipLabel : "";
      syncSidebarModeSwitch(modeSwitch, {
        activeTab: state.activeTab,
        paperLabel: webChatSite || paperLabel,
        libraryLabel: t(state.libraryTabLabel),
        disabled: state.disabled,
        paperTitle: webChatSite ? webChatModeTabTitle : "",
      });
    }
    // The chat settles in on a mode change (CSS plays it in Stacked only).
    if (chatBox && lastSyncedModeTab && lastSyncedModeTab !== state.activeTab) {
      playSidebarModeChangeFade(chatBox);
    }
    lastSyncedModeTab = state.activeTab;
    // The Task progress row follows the conversation and mode shown.
    syncTaskProgressPanel(body);
  };
  const syncConversationIdentity = () => {
    if (
      item &&
      !canCommitPanelConversation(body, item, "sync-conversation-identity")
    ) {
      return;
    }
    const previousConversationKey = conversationKey;
    conversationKey = item ? getConversationKey(item) : null;
    if (
      resolveCurrentNoteSession() &&
      previousConversationKey &&
      conversationKey
    ) {
      copyNoteEditingSelectedTextContext({
        fromConversationKey: previousConversationKey,
        toConversationKey: conversationKey,
      });
    }
    activeContextPanels.set(body, () => item);
    void retainClaudeRuntimeForBody(body, item);
    if ((body as HTMLElement).dataset?.standalone === "true") {
      activeContextPanelRawItems.set(body, item || null);
    }
    const noteSession = resolveCurrentNoteSession();
    panelRoot.dataset.itemId =
      Number.isFinite(conversationKey) && (conversationKey as number) > 0
        ? `${conversationKey}`
        : "";
    const libraryID = getCurrentLibraryID();
    panelRoot.dataset.libraryId = libraryID > 0 ? `${libraryID}` : "";
    const mode: "global" | "paper" | null = item
      ? resolveDisplayConversationKind(item)
      : null;
    panelRoot.dataset.conversationKind =
      noteSession?.conversationKind || mode || "";
    currentConversationSystem = resolvePreferredConversationSystem({
      item,
      preferredSystem: currentConversationSystem,
      surface: selectionSurface(),
    });
    panelRoot.dataset.conversationSystem = currentConversationSystem;
    syncQueuedFollowUpRegistration();
    const currentBasePaperItemID = noteSession
      ? noteSession.parentItemId || 0
      : mode === "paper"
        ? Number(resolveCurrentPaperBaseItem()?.id || 0)
        : 0;
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
      historyNewBtn.style.display = "";
    }
    if (historyToggleBtn) {
      historyToggleBtn.style.display = "";
    }
    if (
      item &&
      libraryID > 0 &&
      mode &&
      !noteSession &&
      // A side chat's ephemeral conversation is never remembered.
      !isEphemeralConversationKey(Number(conversationKey))
    ) {
      // Each runtime writes a different set here: Claude Code only the mode;
      // Codex and upstream also the library chat (map and pref) and the
      // paper chat (map only). All of it goes to this panel's own surface:
      // the standalone window's writes stay in its own slots.
      const surface = selectionSurface();
      if (isClaudeConversationSystem()) {
        rememberMode("claude_code", libraryID, mode, { surface });
      } else if (isCodexConversationSystem()) {
        rememberMode("codex", libraryID, mode, { surface });
        if (mode === "global") {
          remember(
            { system: "codex", libraryID, kind: "global", surface },
            item.id,
          );
        } else if (
          Number.isFinite(conversationKey) &&
          (conversationKey as number) > 0 &&
          Number.isFinite(currentBasePaperItemID) &&
          currentBasePaperItemID > 0
        ) {
          remember(
            {
              system: "codex",
              libraryID,
              kind: "paper",
              paperItemID: Math.floor(currentBasePaperItemID),
              surface,
            },
            Math.floor(conversationKey as number),
            { persist: false },
          );
        }
      } else {
        rememberMode("upstream", libraryID, mode, { surface });
        if (mode === "global") {
          remember(
            { system: "upstream", libraryID, kind: "global", surface },
            item.id,
          );
        } else if (
          Number.isFinite(conversationKey) &&
          (conversationKey as number) > 0 &&
          Number.isFinite(currentBasePaperItemID) &&
          currentBasePaperItemID > 0
        ) {
          // A sidebar panel back in Paper chat releases the sidebar's library
          // lock. The window (and its side chat) has no lock and must not
          // release the sidebar's.
          if (surface === "embedded") {
            const lockedGlobalKey = getLockedGlobalConversationKey(libraryID);
            if (lockedGlobalKey !== null) {
              setLockedGlobalConversationKey(libraryID, null);
              removeAutoLockedGlobalConversationKey(lockedGlobalKey);
            }
          }
          remember(
            {
              system: "upstream",
              libraryID,
              kind: "paper",
              paperItemID: Math.floor(currentBasePaperItemID),
              surface,
            },
            Math.floor(conversationKey as number),
            { persist: false },
          );
        }
      }
    }
    syncRequestUiForCurrentConversation();
    if (historyModeIndicator) {
      // Keep historyModeIndicator (which is the clock history button) accessible.
      // Its label is static "Conversation history" — no text update needed.
    }
    syncChatModeTabs();
    if (inputBox && !noteSession) {
      inputBox.placeholder =
        mode === "global"
          ? t("Ask anything... Type / for actions, @ to add papers")
          : t("Ask about this paper... Type / for actions, @ to add papers");
    }
    updateRuntimeModeButton();
    updateRuntimeSystemToggles();
    if (
      item &&
      !noteSession &&
      previousConversationKey &&
      conversationKey &&
      conversationKey !== previousConversationKey &&
      !isEphemeralConversationKey(Number(conversationKey))
    ) {
      try {
        hooks?.onConversationIdentityChanged?.(item, conversationKey);
      } catch (err) {
        ztoolkit.log("LLM: conversation identity hook failed", err);
      }
    }
  };
  syncConversationIdentity();
  if (getConversationSystem() === "claude_code") {
    warmClaudeModeCaches();
  }

  // Keep the agent mode toggle in sync when the preference is changed in the
  // Preferences window (which runs in a separate window context).
  let cleanupPrefObservers: (() => void) | null = null;
  let cleanupMineruPaperSourceObservers: (() => void) | null = null;
  let cleanupModelCapabilitySubscription: (() => void) | null = null;
  let cleanupModelProviderSync: (() => void) | null = null;
  let codexDirectController: CodexDirectModelReasoningController | null = null;
  {
    const agentPrefKey = `${config.prefsPrefix}.enableAgentMode`;
    const claudeModePrefKey = `${config.prefsPrefix}.enableClaudeCodeMode`;
    const codexModePrefKey = `${config.prefsPrefix}.enableCodexAppServerMode`;
    const permissionPrefObservers: Array<{
      key: string;
      system: ConversationSystem;
    }> = [
      {
        key: `${config.prefsPrefix}.originalAgentPermissionMode`,
        system: "upstream",
      },
      {
        key: `${config.prefsPrefix}.claudeCodePermissionMode`,
        system: "claude_code",
      },
      {
        key: `${config.prefsPrefix}.agentBackendBridgeUrl`,
        system: "claude_code",
      },
      {
        key: `${config.prefsPrefix}.claudeCodeBridgeMode`,
        system: "claude_code",
      },
      {
        key: `${config.prefsPrefix}.agentClaudeConfigSource`,
        system: "claude_code",
      },
      {
        key: `${config.prefsPrefix}.codexAppServerPermissionState`,
        system: "codex",
      },
      {
        key: `${config.prefsPrefix}.codexAppServerPath`,
        system: "codex",
      },
      {
        key: `${config.prefsPrefix}.codexHome`,
        system: "codex",
      },
    ];
    let agentObserverId: symbol | undefined;
    let claudeObserverId: symbol | undefined;
    let codexObserverId: symbol | undefined;
    const permissionObserverIds: symbol[] = [];
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
      for (const observerId of permissionObserverIds.splice(0)) {
        unregister(observerId);
      }
      agentObserverId = undefined;
      claudeObserverId = undefined;
      codexObserverId = undefined;
    };
    const isPanelUnavailable = () =>
      !(body as Element).isConnected ||
      body.ownerDocument?.defaultView?.closed === true;
    // A follower window's panel stays on its chat when that chat's runtime
    // is turned off: the window closes (standaloneWindow.ts).
    const leaveTurnedOffRuntime = () => {
      if (isTornSurface(selectionSurface())) return;
      void switchConversationSystem("upstream");
    };
    const onAgentPrefChange = () => {
      if (isPanelUnavailable()) {
        cleanupPrefObservers?.();
        return;
      }
      updateRuntimeModeButton();
    };
    const onClaudeModePrefChange = () => {
      if (isPanelUnavailable()) {
        cleanupPrefObservers?.();
        return;
      }
      if (!getClaudeCodeModeEnabled()) {
        void releaseClaudeRuntimeForBody(body);
        void initAgentSubsystem()
          .then((coreRuntime) => invalidateAllClaudeHotRuntimes(coreRuntime))
          .catch((err: unknown) => {
            appLogger.warn(
              "LLM: Failed to invalidate all Claude hot runtimes",
              err,
            );
          });
        demoteConversationSystemOnEverySurface("claude_code");
        if (isClaudeConversationSystem()) {
          leaveTurnedOffRuntime();
          return;
        }
      }
      updateRuntimeSystemToggles();
    };
    const onCodexModePrefChange = () => {
      if (isPanelUnavailable()) {
        cleanupPrefObservers?.();
        return;
      }
      if (!isCodexAppServerModeEnabled()) {
        demoteConversationSystemOnEverySurface("codex");
        if (isCodexConversationSystem()) {
          leaveTurnedOffRuntime();
          return;
        }
      }
      updateRuntimeSystemToggles();
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
      for (const observer of permissionPrefObservers) {
        permissionObserverIds.push(
          (Zotero as any).Prefs.registerObserver(
            observer.key,
            () => {
              if (isPanelUnavailable()) {
                cleanupPrefObservers?.();
                return;
              }
              if (getConversationSystem() !== observer.system) return;
              void syncFooterPermissionControl();
            },
            true,
          ),
        );
      }
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
          appLogger.warn("LLM: Attachment GC failed", err);
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

  const cleanupChatScroll = chatBox
    ? bindChatScrollLifecycle(
        chatBox,
        () => (item ? getConversationKey(item) : null),
        noteQuoteValidationUserActivity,
      )
    : () => {};

  const latestButton =
    body.querySelector<HTMLButtonElement>("#llm-chat-latest");
  if (chatBox && latestButton) {
    panelLifecycle.add(
      bindChatLatestButton({
        button: latestButton,
        chatBox,
        getConversationKey: () => (item ? getConversationKey(item) : null),
        onJumpToLatest: () => {
          if (item) requestChatScrollFollowBottom(body, item, chatBox);
        },
      }),
    );
  }

  const floatingPanel = body.querySelector<HTMLElement>("#llm-main");
  const floatingShortcuts = body.querySelector<HTMLElement>("#llm-shortcuts");
  const floatingComposer = floatingPanel?.querySelector<HTMLElement>(
    ":scope > .llm-input-section",
  );
  if (floatingPanel && floatingShortcuts && floatingComposer) {
    panelLifecycle.add(
      bindFloatingComposer({
        panel: floatingPanel,
        shortcuts: floatingShortcuts,
        composer: floatingComposer,
      }),
    );
  }

  // Capture scroll before click/focus interactions that may trigger a panel
  // re-render, so restore uses the most recent user position.
  body.addEventListener("pointerdown", persistCurrentChatScrollSnapshot, true);
  const handleQuoteValidationUserActivity = () => {
    noteQuoteValidationUserActivity();
  };
  body.addEventListener("pointerdown", handleQuoteValidationUserActivity, true);
  // NOTE: We intentionally do NOT persist on "focusin" because focusin fires
  // AFTER focus() has already caused a potential scroll adjustment in Gecko.
  // Persisting at that point overwrites the correct pre-interaction snapshot
  // (captured by pointerdown) with a corrupted position. The scroll event
  // handler on chatBox already keeps the snapshot up to date for programmatic
  // scroll changes.

  let retryMenuAnchor: HTMLButtonElement | null = null;
  const menus = createMenuRegistry();
  const closeResponseMenu = () => {
    if (responseMenu) responseMenu.style.display = "none";
    setResponseMenuTarget(body, null);
  };
  const closePromptMenu = () => {
    if (promptMenu) promptMenu.style.display = "none";
    setPromptMenuTarget(body, null);
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
  {
    const controller = attachFooterPermissionControl({
      body,
      control: permissionControl,
      button: permissionButton,
      menu: permissionMenu,
      getConversationSystem,
      getRuntimeMode: getCurrentRuntimeMode,
      onWarning: (message) => {
        if (status) setStatus(status, message, "warning");
      },
    });
    syncFooterPermissionControl = controller.sync;
    disposeFooterPermissionControl = controller.dispose;
    void syncFooterPermissionControl();
  }
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
  menus.register("response", closeResponseMenu);
  menus.register("prompt", closePromptMenu);
  menus.register("export", closeExportMenu);
  menus.register("historyRow", closeHistoryRowMenu);
  menus.register("historyNew", closeHistoryNewMenu, isHistoryNewMenuOpen);
  menus.register("history", closeHistoryMenu, isHistoryMenuOpen);
  menus.register("slash", closeSlashMenu);
  menus.register("model", closeModelMenu);
  menus.register("reasoning", closeReasoningMenu);
  menus.register("retryModel", closeRetryModelMenu);

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
      appLogger.debug(message, ...args);
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
    responseMenuForkBtn,
    responseMenuDeleteBtn,
    promptMenu,
    promptMenuForkBtn,
    promptMenuDeleteBtn,
    exportMenu,
    exportMenuCopyBtn,
    exportMenuNoteBtn,
    exportBtn,
    popoutBtn,
    settingsBtn,
    preferencesPaneId: PREFERENCES_PANE_ID,
    getItem: () => item,
    getResponseMenuTarget: () => getResponseMenuTarget(body),
    getPromptMenuTarget: () => getPromptMenuTarget(body),
    getCurrentLibraryID,
    getConversationSystem,
    getCurrentRuntimeModeForItem: (targetItem) =>
      selectedRuntimeModeCache.get(getConversationKey(targetItem)) || null,
    isGlobalMode,
    ensureConversationLoaded: (targetItem) =>
      ensureConversationLoaded(targetItem, { body }),
    getConversationKey,
    getHistory: (conversationKey) => chatHistory.get(conversationKey) || [],
    captureOwnership: (operation, targetConversationKey) => {
      const ownedItem = item;
      if (
        !ownedItem ||
        !requireCurrentPanelOwnership(body, ownedItem, operation) ||
        (targetConversationKey &&
          getConversationKey(ownedItem) !== targetConversationKey)
      ) {
        return null;
      }
      const lease = capturePanelOperationLease(body);
      if (!lease) return null;
      return () =>
        isPanelOperationLeaseCurrent(lease) &&
        requireCurrentPanelOwnership(body, ownedItem, `${operation}-commit`);
    },
    resolveActiveNoteSession,
    closeResponseMenu,
    closePromptMenu,
    closeExportMenu,
    closeRetryModelMenu,
    closeSlashMenu,
    closeHistoryNewMenu,
    closeHistoryMenu,
    queueTurnDeletion: (target) => queueTurnDeletion(target),
    forkConversationFromTurn: (target) => forkConversationFromTurn(target),
    logError: (message, error) => {
      appLogger.debug(message, error);
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
  let lastUserContextAlignmentPanelWidth = -1;
  const getRoundedPanelWidth = () =>
    Math.ceil(
      panelRoot.getBoundingClientRect?.().width || panelRoot.clientWidth || 0,
    );
  const responsiveLayoutScheduler = createCoalescedFrameScheduler({
    getWindow: () => body.ownerDocument?.defaultView || null,
    run: () => {
      if (!panelRoot.isConnected) return;
      const panelWidth = getRoundedPanelWidth();
      if (panelWidth <= 0) return;
      withScrollGuard(chatBox, conversationKey, () => {
        applyResponsiveActionButtonsLayout();
        // The runtime systems share the actions row (row 2) with the panel
        // actions; that row's gap is the one they compress against.
        updateHeaderSpacing(
          headerTop?.querySelector<HTMLElement>(".llm-header-nav-row") ||
            headerTop,
        );
        if (panelWidth !== lastUserContextAlignmentPanelWidth) {
          syncUserContextAlignmentWidths(body);
          lastUserContextAlignmentPanelWidth = panelWidth;
        }
      });
    },
  });
  panelLifecycle.add(responsiveLayoutScheduler.dispose);
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
    const explicit = getPaperContentSourceOverride(itemId, paperContext);
    // WebChat uploads only genuine PDF attachments. Retained Markdown, HTML,
    // DOCX, and other text-like contexts must not be coerced into this lane.
    if (isWebChatMode()) {
      const attachment = Zotero.Items.get(paperContext.contextItemId);
      if (isZoteroPdfAttachmentCandidate(attachment)) return "pdf";
      return (
        (explicit === "pdf" ? undefined : explicit) ||
        (paperContext.contentSourceMode === "pdf"
          ? undefined
          : paperContext.contentSourceMode) ||
        (isPaperContextMineru(paperContext) ? "mineru" : "text")
      );
    }
    return (
      explicit ||
      paperContext.contentSourceMode ||
      (isPaperContextMineru(paperContext) ? "mineru" : "text")
    );
  };

  const withResolvedPaperContentSourceMode = (
    itemId: number,
    paperContext: PaperContextRef,
  ): PaperContextRef => ({
    ...paperContext,
    contentSourceMode: resolvePaperContentSourceMode(itemId, paperContext),
  });

  // Lightweight sync cache: once checkAndApplyMineruChipStyle confirms MinerU
  // exists on disk, the contextItemId is added here so isPaperContextMineru
  // returns true immediately without waiting for pdfTextCache to be populated.
  const mineruAvailableIds = new Set<number>();
  const pendingMineruAvailabilityChecks = new Map<number, Promise<void>>();
  let mineruChipStyleDepsPromise: Promise<{
    getMineruAvailabilityForAttachmentId: typeof import("../../services/mineru/sync").getMineruAvailabilityForAttachmentId;
  }> | null = null;
  const loadMineruChipStyleDeps = () => {
    if (!mineruChipStyleDepsPromise) {
      mineruChipStyleDepsPromise = import("../../services/mineru/sync").then(
        (mineruSync) => ({
          getMineruAvailabilityForAttachmentId:
            mineruSync.getMineruAvailabilityForAttachmentId,
        }),
      );
    }
    return mineruChipStyleDepsPromise;
  };

  const isPaperContextMineru = (paperContext: PaperContextRef): boolean => {
    if (mineruAvailableIds.has(paperContext.contextItemId)) return true;
    // Check the in-memory paper text (populated after ensurePDFTextCached)
    const cached = paperTextStore.peek(paperContext.contextItemId);
    if (cached?.sourceType === "mineru") {
      mineruAvailableIds.add(paperContext.contextItemId);
      return true;
    }
    // Cache may not be populated yet — trigger async check and update chip later
    void checkAndApplyMineruChipStyle(paperContext.contextItemId);
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
          const { getMineruAvailabilityForAttachmentId } =
            await loadMineruChipStyleDeps();
          const availability = await getMineruAvailabilityForAttachmentId(
            contextItemId,
            {
              validateSyncedPackage: false,
            },
          );
          await getMineruStatus(contextItemId);
          if (availability.status === "missing") return;
          mineruAvailableIds.add(contextItemId);
          upgradePaperContextsToMineruForAttachment(contextItemId);
          // MinerU is now available; re-render chips so the default mode flips.
          schedulePanelStateRefresh();
          refreshOpenPaperChipMenu();
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
    const forcedMode = resolvePaperContextForcedSendMode(
      resolvePaperContentSourceMode(itemId, paperContext),
      isWebChatMode(),
    );
    if (forcedMode) return forcedMode;
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
    ]).map((paperContext) =>
      withResolvedPaperContentSourceMode(currentItem.id, paperContext),
    );
  };

  const getEffectiveFullTextPaperContexts = (
    currentItem: Zotero.Item,
    selectedPaperContexts?: PaperContextRef[],
  ): PaperContextRef[] => {
    return getAllEffectivePaperContexts(currentItem, selectedPaperContexts)
      .filter(
        (paperContext) =>
          resolvePaperContentSourceMode(currentItem.id, paperContext) !==
            "pdf" &&
          isPaperContextFullTextMode(
            resolvePaperContextNextSendMode(currentItem.id, paperContext),
          ),
      )
      .slice(0, MAX_FULL_TEXT_PAPER_CONTEXTS);
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

  /** [webchat] Resolve PDF chips that are active for the next upload. */
  const getActiveWebChatPdfPaperContexts = (
    currentItem: Zotero.Item,
    selectedPaperContexts?: PaperContextRef[],
  ): PaperContextRef[] => {
    return getAllEffectivePaperContexts(
      currentItem,
      selectedPaperContexts,
    ).filter(
      (paperContext) =>
        resolvePaperContentSourceMode(currentItem.id, paperContext) === "pdf" &&
        isPaperContextFullTextMode(
          resolvePaperContextNextSendMode(currentItem.id, paperContext),
        ),
    );
  };

  /** [webchat] Check if any paper has PDF content source AND full-text send mode (purple chip). */
  const hasActivePdfFullTextPapers = (
    currentItem: Zotero.Item,
    selectedPaperContexts?: PaperContextRef[],
  ): boolean => {
    return (
      getActiveWebChatPdfPaperContexts(currentItem, selectedPaperContexts)
        .length > 0
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
    const cache = isWebChatModeActive()
      ? webChatDraftInputCache
      : draftInputCache;
    if (value) {
      cache.set(normalizedKey, value);
    } else {
      cache.delete(normalizedKey);
    }
  };
  const persistDraftInputForCurrentConversation = (options?: {
    resize?: boolean;
  }) => {
    // Most programmatic composer updates already persist immediately. Keeping
    // sizing here makes those paths share the same behavior as typed input.
    // A conversation switch skips it: the next draft is restored and sized
    // right after, and measuring here forces an extra layout of the window.
    if (options?.resize !== false) resizeTextareaToContent(inputBox);
    // Don't persist the edit-mode text as a draft; the real draft was saved
    // with this panel's edit when edit mode was entered.
    if (!item || !inputBox || getInlineEditTarget(body)) return;
    setDraftInputForConversation(getConversationKey(item), inputBox.value);
  };
  const restoreDraftInputForCurrentConversation = () => {
    if (!item || !inputBox) return;
    // Don't overwrite the user's in-progress edit text; the real draft was saved
    // with this panel's edit when edit mode was entered and is restored when
    // the edit ends.
    if (getInlineEditTarget(body)) return;
    const cache = isWebChatModeActive()
      ? webChatDraftInputCache
      : draftInputCache;
    inputBox.value = cache.get(getConversationKey(item)) || "";
    resizeTextareaToContent(inputBox);
  };
  const clearDraftInputState = (itemId: number) => {
    draftInputCache.delete(itemId);
    webChatDraftInputCache.delete(itemId);
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
    initializedConversationComposeContextKeys.delete(itemId);
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
    await ensureConversationLoaded(item as Zotero.Item, { body });
    const key = getConversationKey(item);
    const history = chatHistory.get(key) || [];
    const pair = findLatestRetryPair(history);
    if (!pair) return null;
    return { conversationKey: key, pair };
  };

  let autoLoadedContextSourceSnapshot: ResolvedContextSource | null | undefined;
  let autoLoadedPaperContextOwnerItemId: number | null = null;
  let autoLoadedPaperContextItemId: number | null = null;
  let autoLoadedPaperContextContentSourceMode: string | null = null;
  let autoLoadedContextPanelItemKey: string | null = null;
  let autoLoadedContextSourceSnapshotIsExplicit = false;
  let autoLoadedPaperContextGeneration = 0;
  let autoLoadedContextSourcePromise: Promise<ResolvedContextSource | null> | null =
    null;
  let requestAutoLoadedPaperContextRefresh: (() => void) | null = null;

  const writeAutoLoadedContextItemId = (
    contextSource: ResolvedContextSource | null,
  ) => {
    const sourceItem = contextSource?.contextItem || null;
    const paperContext = contextSource?.paperContext || null;
    const contextItemId = Math.floor(
      Number(paperContext?.contextItemId || sourceItem?.id || 0),
    );
    panelRoot.dataset.contextItemId =
      Number.isFinite(contextItemId) && contextItemId > 0
        ? `${contextItemId}`
        : "";
  };

  const setAutoLoadedContextSnapshot = (
    contextSource: ResolvedContextSource | null,
    contextPanelItem?: Zotero.Item | null,
    options?: { explicitSourceSelection?: boolean },
  ) => {
    if (isGlobalMode()) {
      panelRoot.dataset.contextItemId = "";
      return;
    }
    const sourceItem = contextSource?.contextItem || null;
    const paperContext = contextSource?.paperContext || null;
    const ownerItemId = Math.floor(
      Number(paperContext?.itemId || resolveCurrentPaperBaseItem()?.id || 0),
    );
    autoLoadedPaperContextOwnerItemId =
      Number.isFinite(ownerItemId) && ownerItemId > 0 ? ownerItemId : null;
    const contextItemId = Math.floor(
      Number(paperContext?.contextItemId || sourceItem?.id || 0),
    );
    autoLoadedPaperContextItemId =
      Number.isFinite(contextItemId) && contextItemId > 0
        ? contextItemId
        : null;
    autoLoadedPaperContextContentSourceMode =
      paperContext?.contentSourceMode || null;
    const contextPanelItemId = Math.floor(
      Number(contextPanelItem?.id || sourceItem?.id || 0),
    );
    autoLoadedContextPanelItemKey =
      Number.isFinite(contextPanelItemId) && contextPanelItemId > 0
        ? `${contextPanelItemId}`
        : null;
    autoLoadedContextSourceSnapshot = contextSource;
    autoLoadedContextSourceSnapshotIsExplicit =
      options?.explicitSourceSelection === true;
    writeAutoLoadedContextItemId(contextSource);
    requestAutoLoadedPaperContextRefresh?.();
  };

  const clearAutoLoadedContextSnapshot = () => {
    autoLoadedPaperContextGeneration += 1;
    autoLoadedContextSourceSnapshot = undefined;
    autoLoadedPaperContextOwnerItemId = null;
    autoLoadedPaperContextItemId = null;
    autoLoadedPaperContextContentSourceMode = null;
    autoLoadedContextPanelItemKey = null;
    autoLoadedContextSourceSnapshotIsExplicit = false;
    autoLoadedContextSourcePromise = null;
    panelRoot.dataset.contextItemId = "";
  };

  const getCurrentAutoLoadedPaperOwnerItemId = (): number | null => {
    if (!item || isGlobalMode()) return null;
    const ownerItemId = Math.floor(
      Number(resolveCurrentPaperBaseItem()?.id || 0),
    );
    return Number.isFinite(ownerItemId) && ownerItemId > 0 ? ownerItemId : null;
  };

  const isAutoLoadedContextSnapshotCurrent = (): boolean => {
    const currentPanelItem = resolveAutoLoadedContextPanelItem();
    const currentPanelItemId = Math.floor(Number(currentPanelItem?.id || 0));
    const currentPanelItemKey =
      Number.isFinite(currentPanelItemId) && currentPanelItemId > 0
        ? `${currentPanelItemId}`
        : null;
    if (
      autoLoadedContextPanelItemKey &&
      currentPanelItemKey &&
      autoLoadedContextPanelItemKey !== currentPanelItemKey
    ) {
      return false;
    }
    const currentContextSource =
      resolveAutoLoadedContextSourceSync(currentPanelItem);
    const currentContextSourceItem = currentContextSource?.contextItem || null;
    const currentPaperContext = currentContextSource?.paperContext || null;
    return isAutoLoadedSnapshotForCurrentPaper({
      currentOwnerItemId: getCurrentAutoLoadedPaperOwnerItemId(),
      snapshotOwnerItemId: autoLoadedPaperContextOwnerItemId,
      currentContextItemId:
        currentPaperContext?.contextItemId ||
        (currentContextSourceItem
          ? Math.floor(Number(currentContextSourceItem.id || 0))
          : null),
      snapshotContextItemId: autoLoadedPaperContextItemId,
      currentContentSourceMode: currentPaperContext?.contentSourceMode || null,
      snapshotContentSourceMode: autoLoadedPaperContextContentSourceMode,
      allowExplicitContextOverride: autoLoadedContextSourceSnapshotIsExplicit,
    });
  };

  const resolveAutoLoadedContextPanelItem = (): Zotero.Item | null => {
    const liveRawPanelItem = resolveLiveRawPanelItem();
    return chooseAutoLoadedContextPanelItem({
      isGlobalMode: isGlobalMode(),
      currentItem: item,
      currentPaperBaseItem: resolveCurrentPaperBaseItem(),
      liveRawPanelItem,
      liveRawPanelItemIsSupportedAttachment:
        isSupportedContextAttachment(liveRawPanelItem),
    });
  };

  const resolveAutoLoadedContextSourceSync = (
    panelItemOverride?: Zotero.Item | null,
  ): ResolvedContextSource | null => {
    if (!item) return null;
    const noteSession = resolveCurrentNoteSession();
    if (noteSession?.noteKind === "standalone") return null;
    if (noteSession?.noteKind === "item") {
      const parentItem = resolveCurrentNoteParentItem();
      if (!parentItem) return null;
      const activeReaderAttachment = getActiveContextAttachmentFromTabs();
      if (activeReaderAttachment?.parentID === parentItem.id) {
        return resolveContextSourceItem(activeReaderAttachment);
      }
      return null;
    }
    if (isGlobalMode()) return null;
    const sourceItem =
      panelItemOverride === undefined
        ? resolveAutoLoadedContextPanelItem()
        : panelItemOverride;
    if (
      sourceItem?.isAttachment?.() &&
      resolvePaperContextRefFromAttachment(sourceItem)
    ) {
      return resolveContextSourceItem(sourceItem);
    }
    const activeReaderAttachment = getActiveContextAttachmentFromTabs();
    if (activeReaderAttachment) {
      const ownerPaperId = sourceItem?.isAttachment?.()
        ? sourceItem.parentID
        : sourceItem?.id;
      if (
        sourceItem &&
        ownerPaperId &&
        activeReaderAttachment.id !== sourceItem.id &&
        activeReaderAttachment.parentID !== ownerPaperId
      ) {
        // The reader shows another paper; resolve the panel's own paper.
        return resolveContextSourceItem(sourceItem);
      }
      return resolveContextSourceItem(activeReaderAttachment);
    }
    return null;
  };

  const resolveAutoLoadedPaperContext = (): PaperContextRef | null => {
    if (isGlobalMode()) {
      panelRoot.dataset.contextItemId = "";
      return null;
    }
    if (autoLoadedContextSourceSnapshot !== undefined) {
      if (isAutoLoadedContextSnapshotCurrent()) {
        writeAutoLoadedContextItemId(autoLoadedContextSourceSnapshot);
        return autoLoadedContextSourceSnapshot?.paperContext || null;
      }
      clearAutoLoadedContextSnapshot();
    }
    return resolveAutoLoadedContextSourceSync()?.paperContext || null;
  };

  // Resolves to this call's own resolution. The shared snapshot can be
  // cleared or replaced while it awaits (the panel moving to another paper),
  // so a send must not read the snapshot back after the await.
  const resolveAutoLoadedContextSourceAsync =
    async (): Promise<ResolvedContextSource | null> => {
      if (!item) return null;
      if (isGlobalMode()) {
        panelRoot.dataset.contextItemId = "";
        return null;
      }
      if (autoLoadedContextSourceSnapshot !== undefined) {
        if (isAutoLoadedContextSnapshotCurrent()) {
          writeAutoLoadedContextItemId(autoLoadedContextSourceSnapshot);
          return autoLoadedContextSourceSnapshot;
        }
        clearAutoLoadedContextSnapshot();
      }
      if (autoLoadedContextSourcePromise) return autoLoadedContextSourcePromise;
      const requestGeneration = autoLoadedPaperContextGeneration;
      const pending = (async () => {
        const panelItem = resolveAutoLoadedContextPanelItem();
        if (!panelItem) return null;
        const contextSource = await resolveContextSourceItemAsync(panelItem);
        if (
          panelRoot.dataset.handlersAttached === thisGen &&
          requestGeneration === autoLoadedPaperContextGeneration
        ) {
          setAutoLoadedContextSnapshot(contextSource, panelItem);
        }
        return contextSource;
      })();
      autoLoadedContextSourcePromise = pending;
      try {
        return await pending;
      } finally {
        // A newer resolution may own the slot by now; leave it in place.
        if (autoLoadedContextSourcePromise === pending) {
          autoLoadedContextSourcePromise = null;
        }
      }
    };

  const resolveAutoLoadedPaperContextAsync =
    async (): Promise<PaperContextRef | null> =>
      (await resolveAutoLoadedContextSourceAsync())?.paperContext || null;

  const refreshAutoLoadedPaperContextForCurrentItem = () => {
    clearAutoLoadedContextSnapshot();
    if (!item || isGlobalMode()) return;
    const panelItem = resolveAutoLoadedContextPanelItem();
    const contextSource = resolveAutoLoadedContextSourceSync(panelItem);
    const paperContext = contextSource?.paperContext || null;
    if (paperContext) {
      setAutoLoadedContextSnapshot(contextSource, panelItem);
      return;
    }
    void resolveAutoLoadedPaperContextAsync();
  };

  let paperChipMenu: HTMLDivElement | null = null;
  let paperChipMineruCacheMenu: HTMLDivElement | null = null;
  let paperChipMineruCacheMenuTarget: { contextItemId: number } | null = null;
  let paperChipMenuAnchor: HTMLDivElement | null = null;
  let paperChipMenuSticky = false;
  let paperChipMenuTarget: PaperContextRef | null = null;
  let paperChipMenuHideTimer: number | null = null;
  let refreshOpenPaperChipMenu = () => {};
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
  const closePaperChipMineruCacheMenu = () => {
    if (paperChipMineruCacheMenu) {
      paperChipMineruCacheMenu.style.display = "none";
    }
    paperChipMineruCacheMenuTarget = null;
  };
  const closePaperChipMenu = () => {
    closePaperChipMineruCacheMenu();
    clearPaperChipMenuHideTimer();
    if (paperChipMenu) {
      paperChipMenu.style.display = "none";
    }
    paperChipMenuAnchor?.classList.remove("llm-paper-context-chip-menu-open");
    paperChipMenuAnchor = null;
    paperChipMenuTarget = null;
    paperChipMenuSticky = false;
  };
  const buildPaperMetaText = (paper: {
    firstCreator?: string;
    year?: string;
  }): string => {
    const parts = [paper.firstCreator || "", paper.year || ""].filter(Boolean);
    return parts.join(" · ");
  };

  const resolveCurrentPdfSupport = () => {
    const selectedProfile = getSelectedProfile();
    const modelName = (
      selectedProfile?.model ||
      getSelectedModelInfo().currentModel ||
      ""
    ).trim();
    const inputMode = getAdvancedModelParamsForEntry(
      selectedProfile?.entryId,
    )?.inputMode;
    return resolvePaperPdfSupportForConversation({
      basePdfSupport: getModelPdfSupport(
        modelName,
        selectedProfile?.providerProtocol,
        selectedProfile?.authMode,
        selectedProfile?.apiBase,
        inputMode,
      ),
      isClaudeCode: isClaudeConversationSystem(),
      isCodex: isCodexConversationSystem(),
    });
  };

  const getMineruDisabledParsingMessage = (): string =>
    t("⚠️ enable MinerU to start PDF parsing");

  const buildPaperSourceOptions = (
    paperContext: PaperContextRef,
  ): PaperSourceOption[] => {
    return buildPaperSourceOptionsController({
      paperContext,
      getItemById: (itemId) => Zotero.Items.get(itemId) || null,
      webChatMode: isWebChatMode(),
      pdfSupport: resolveCurrentPdfSupport(),
      isMineruEnabled: isMineruEnabled(),
      getItemStatus,
      isPaperContextMineru,
      mineruAvailableIds,
      fullPdfUnsupportedMessage: FULL_PDF_UNSUPPORTED_MESSAGE,
      mineruDisabledParsingMessage: getMineruDisabledParsingMessage(),
      translate: t,
    });
  };

  const buildPaperChipMenuCard = (
    ownerDoc: Document,
    paperContext: PaperContextRef,
    options?: {
      contentSourceMode?: PaperContentSourceMode;
      badge?: string;
      title?: string;
      description?: string;
      disabledReason?: string;
      selected?: boolean;
      sourceOption?: boolean;
      mineruState?: MineruSourceUiState;
      mineruAction?: MineruSourceAction;
      mineruActionTitle?: string;
      mineruCacheReveal?: boolean;
    },
  ): HTMLButtonElement => {
    const card = createElement(
      ownerDoc,
      "button",
      `llm-paper-picker-item llm-paper-picker-group-row llm-paper-chip-menu-row ${getContextSourceModeCssClassName(options?.contentSourceMode)}`,
      {
        type: "button",
        title: options?.sourceOption
          ? options.description || options.title || paperContext.title
          : `Jump to ${paperContext.title}`,
      },
    ) as HTMLButtonElement;
    if (options?.sourceOption) {
      card.dataset.sourceMode = options.contentSourceMode || "";
      card.dataset.contextItemId = `${paperContext.contextItemId}`;
      card.dataset.paperItemId = `${paperContext.itemId}`;
    }
    if (options?.mineruState) {
      card.dataset.mineruState = options.mineruState;
      card.classList.add(
        `llm-paper-chip-menu-row-mineru-${options.mineruState}`,
      );
      if (options.mineruAction && options.mineruAction !== "select") {
        card.dataset.mineruAction = options.mineruAction;
      }
      if (options.mineruActionTitle) {
        card.title = options.mineruActionTitle;
      }
    }
    if (options?.mineruCacheReveal) {
      card.dataset.mineruCacheReveal = "true";
    }
    if (options?.disabledReason) {
      card.disabled = true;
      card.setAttribute("aria-disabled", "true");
      card.classList.add("llm-paper-chip-menu-row-disabled");
      card.title = options.disabledReason;
    }
    if (options?.selected) {
      card.setAttribute("aria-selected", "true");
    }
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
      textContent: options?.title || paperContext.title,
      title: options?.title || paperContext.title,
    });
    titleLine.appendChild(title);
    const mode = options?.contentSourceMode;
    const badgeText =
      options?.badge ||
      (mode === "mineru" || mode === "markdown"
        ? "MD"
        : mode === "pdf"
          ? "PDF"
          : mode === "text"
            ? "Text"
            : mode === "html"
              ? "HTML"
              : mode === "txt"
                ? "TXT"
                : mode === "docx"
                  ? "DOCX"
                  : null);
    if (badgeText) {
      const badge = createElement(ownerDoc, "span", "llm-paper-picker-badge", {
        textContent: badgeText,
        title: options?.mineruActionTitle,
      });
      titleLine.appendChild(badge);
    }
    rowMain.appendChild(titleLine);
    const metaText = isTextLikeAttachmentSourceMode(mode)
      ? ""
      : buildPaperMetaText(paperContext);
    if (metaText) {
      rowMain.appendChild(
        createElement(ownerDoc, "span", "llm-paper-picker-meta", {
          textContent: metaText,
          title: metaText,
        }),
      );
    }
    const displayAttachmentText =
      options?.description ||
      formatPaperContextCardAttachmentLine(paperContext, mode);
    const disabledReasonAlreadyShown =
      !!options?.disabledReason &&
      (displayAttachmentText === options.disabledReason ||
        displayAttachmentText.endsWith(`· ${options.disabledReason}`));
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
    if (options?.disabledReason && !disabledReasonAlreadyShown) {
      rowMain.appendChild(
        createElement(
          ownerDoc,
          "span",
          "llm-paper-picker-meta llm-paper-chip-disabled-reason",
          {
            textContent: options.disabledReason,
            title: options.disabledReason,
          },
        ),
      );
    }
    card.appendChild(rowMain);
    return card;
  };

  const upgradePaperContextsToMineruForAttachment = (
    contextItemId: number,
  ): boolean => {
    if (!item || !Number.isFinite(contextItemId) || contextItemId <= 0) {
      return false;
    }
    const currentItem = item;
    let didUpgrade = false;
    const autoLoadedPaperContext = resolveAutoLoadedPaperContext();

    if (autoLoadedPaperContext?.contextItemId === contextItemId) {
      const currentMode = resolvePaperContentSourceMode(
        currentItem.id,
        autoLoadedPaperContext,
      );
      if (currentMode !== "pdf" && currentMode !== "mineru") {
        setPaperContentSourceOverride(
          currentItem.id,
          autoLoadedPaperContext,
          "mineru",
        );
        didUpgrade = true;
      }
    }

    const selectedPapers = getManualPaperContextsForItem(
      currentItem.id,
      autoLoadedPaperContext,
    );
    if (!selectedPapers.length) return didUpgrade;

    const nextPapers = selectedPapers.map((paperContext) => {
      if (paperContext.contextItemId !== contextItemId) return paperContext;
      const currentMode = resolvePaperContentSourceMode(
        currentItem.id,
        paperContext,
      );
      if (currentMode === "pdf" || currentMode === "mineru") {
        return paperContext;
      }
      didUpgrade = true;
      const nextContext: PaperContextRef = {
        ...paperContext,
        contentSourceMode: "mineru",
      };
      setPaperContentSourceOverride(currentItem.id, nextContext, "mineru");
      return nextContext;
    });

    if (didUpgrade) {
      selectedPaperContextCache.set(currentItem.id, nextPapers);
    }
    return didUpgrade;
  };

  const syncMineruPaperSourceState = (): void => {
    if (!item) return;
    const autoLoadedPaperContext = resolveAutoLoadedPaperContext();
    const selectedPapers = getManualPaperContextsForItem(
      item.id,
      autoLoadedPaperContext,
    );
    const paperContexts = [
      ...(autoLoadedPaperContext ? [autoLoadedPaperContext] : []),
      ...selectedPapers,
    ];
    let didRefresh = false;
    for (const paperContext of paperContexts) {
      const status = getItemStatus(paperContext.contextItemId);
      if (status?.status !== "cached") continue;
      mineruAvailableIds.add(paperContext.contextItemId);
      if (
        upgradePaperContextsToMineruForAttachment(paperContext.contextItemId)
      ) {
        didRefresh = true;
      }
    }
    if (didRefresh) {
      updatePaperPreviewPreservingScroll();
    }
  };

  const handleMineruSourceAction = async (
    sourceOption: PaperSourceOption,
  ): Promise<void> => {
    const action = sourceOption.mineruAction;
    if (!action || action === "select") return;
    const attachmentId = sourceOption.paperContext.contextItemId;

    if (action === "pause") {
      const batchState = getMineruBatchState();
      if (batchState.running && !batchState.paused) {
        pauseBatchProcessing();
      } else {
        const autoWatchStatus = getAutoWatchStatus();
        if (autoWatchStatus.isProcessing && !autoWatchStatus.isPaused) {
          pauseAutoWatch();
        }
      }
      if (status) setStatus(status, t("Click to do MinerU parsing"), "ready");
      return;
    }

    if (!isMineruEnabled()) {
      if (status) {
        setStatus(status, getMineruDisabledParsingMessage(), "warning");
      }
      return;
    }

    const batchState = getMineruBatchState();
    if (batchState.running) {
      if (status) setStatus(status, t("MinerU parsing…"), "warning");
      return;
    }

    if (status) setStatus(status, t("MinerU parsing…"), "ready");
    await processSelectedItems([attachmentId], { overrideEligibility: true });
    refreshOpenPaperChipMenu();
  };

  const resolvePaperChipMenuSourceOptionFromCard = (
    card: HTMLButtonElement,
  ): PaperSourceOption | null => {
    if (!paperChipMenuTarget) return null;
    const mode = card.dataset.sourceMode as PaperContentSourceMode | "";
    const contextItemId = Number.parseInt(card.dataset.contextItemId || "", 10);
    const paperItemId = Number.parseInt(card.dataset.paperItemId || "", 10);
    if (!mode || !Number.isFinite(contextItemId) || contextItemId <= 0) {
      return null;
    }
    return (
      buildPaperSourceOptions(paperChipMenuTarget).find(
        (candidate) =>
          candidate.mode === mode &&
          candidate.paperContext.contextItemId === contextItemId &&
          candidate.paperContext.itemId === paperItemId,
      ) || null
    );
  };

  const handleShowMineruCacheInFileSystem = async (): Promise<void> => {
    const target = paperChipMineruCacheMenuTarget;
    closePaperChipMineruCacheMenu();
    if (!target) return;

    const attachment = Zotero.Items.get(target.contextItemId) || null;
    if (!attachment) {
      if (status) {
        setStatus(status, t("Could not find this paper attachment."), "error");
      }
      return;
    }

    try {
      const { ensureMineruCacheDirForAttachment } =
        await import("../../services/mineru/sync");
      const cacheDir = await ensureMineruCacheDirForAttachment(attachment);
      if (!cacheDir) {
        if (status) {
          setStatus(
            status,
            t("MinerU cache is not available in the file system."),
            "error",
          );
        }
        return;
      }
      if (!revealLocalPath(cacheDir)) {
        if (status) {
          setStatus(
            status,
            t("Could not show MinerU cache in file system."),
            "error",
          );
        }
        return;
      }
      if (status) {
        setStatus(status, t("Showing MinerU cache in file system."), "ready");
      }
    } catch (error) {
      appLogger.warn("LLM: Failed to show MinerU cache folder", error);
      if (status) {
        setStatus(
          status,
          t("Could not show MinerU cache in file system."),
          "error",
        );
      }
    }
  };

  const ensurePaperChipMineruCacheMenu = (): HTMLDivElement | null => {
    if (paperChipMineruCacheMenu?.isConnected) {
      return paperChipMineruCacheMenu;
    }
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc) return null;
    const menu = createElement(
      ownerDoc,
      "div",
      "llm-model-menu llm-paper-chip-cache-menu",
    );
    menu.style.display = "none";
    menu.addEventListener("pointerdown", (event: Event) => {
      event.stopPropagation();
    });
    menu.addEventListener("mousedown", (event: Event) => {
      event.stopPropagation();
    });
    menu.addEventListener("contextmenu", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    const showCacheButton = createElement(
      ownerDoc,
      "button",
      "llm-paper-chip-cache-menu-item",
      {
        type: "button",
        textContent: t("Show MinerU cache in file system"),
      },
    ) as HTMLButtonElement;
    showCacheButton.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      void handleShowMineruCacheInFileSystem();
    });
    menu.appendChild(showCacheButton);

    ownerDoc.addEventListener(
      "keydown",
      (event: Event) => {
        const keyboardEvent = event as KeyboardEvent;
        if (
          keyboardEvent.key !== "Escape" ||
          !paperChipMineruCacheMenu ||
          paperChipMineruCacheMenu.style.display === "none"
        ) {
          return;
        }
        closePaperChipMineruCacheMenu();
        event.preventDefault();
        event.stopPropagation();
      },
      true,
    );

    body.appendChild(menu);
    paperChipMineruCacheMenu = menu;
    return menu;
  };

  const openPaperChipMineruCacheMenu = (
    contextItemId: number,
    clientX: number,
    clientY: number,
  ): void => {
    const menu = ensurePaperChipMineruCacheMenu();
    if (!menu) return;
    paperChipMineruCacheMenuTarget = { contextItemId };
    positionMenuAtPointer(body, menu, clientX, clientY);
    menu.style.display = "grid";
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
      if (card.disabled || card.getAttribute("aria-disabled") === "true") {
        if (status && card.title) setStatus(status, card.title, "error");
        return;
      }
      const option = resolvePaperChipMenuSourceOptionFromCard(card);
      if (!option || option.disabledReason) {
        if (status && option?.disabledReason) {
          setStatus(status, option.disabledReason, "error");
        }
        return;
      }
      if (option.mineruAction && option.mineruAction !== "select") {
        void handleMineruSourceAction(option);
        return;
      }
      const currentItem = item;
      if (!currentItem) return;
      const mode = option.mode;
      const selectedContext = option.paperContext;
      if (paperChipMenuAnchor?.dataset.autoLoaded === "true") {
        const contextItem =
          Zotero.Items.get(selectedContext.contextItemId) || null;
        const contextSource = contextItem
          ? {
              ...resolveContextSourceItem(contextItem),
              paperContext: selectedContext,
              contentSourceMode: selectedContext.contentSourceMode,
            }
          : {
              contextItem: null,
              paperContext: selectedContext,
              statusText: selectedContext.attachmentTitle
                ? `using the selected ${selectedContext.attachmentTitle} as context`
                : "using the selected attachment as context",
              contentSourceMode: selectedContext.contentSourceMode,
            };
        setAutoLoadedContextSnapshot(
          contextSource,
          resolveAutoLoadedContextPanelItem(),
          { explicitSourceSelection: true },
        );
      } else {
        const selectedPapers = getManualPaperContextsForItem(
          currentItem.id,
          resolveAutoLoadedPaperContext(),
        );
        const currentIndex = selectedPapers.findIndex(
          (paper) =>
            paper.itemId === paperChipMenuTarget?.itemId &&
            paper.contextItemId === paperChipMenuTarget?.contextItemId,
        );
        const nextPapers =
          currentIndex >= 0
            ? selectedPapers.map((paper, index) =>
                index === currentIndex ? selectedContext : paper,
              )
            : [...selectedPapers, selectedContext];
        selectedPaperContextCache.set(currentItem.id, nextPapers);
      }
      setPaperContentSourceOverride(currentItem.id, selectedContext, mode);
      closePaperChipMenu();
      updatePaperPreviewPreservingScroll();
      if (status) {
        setStatus(status, `${t("Content source:")} ${option.badge}`, "ready");
      }
    });
    menu.addEventListener("contextmenu", (e: Event) => {
      const target = e.target as Element | null;
      if (!target) return;
      const card = target.closest(
        ".llm-paper-chip-menu-row",
      ) as HTMLButtonElement | null;
      if (!card || !paperChipMenuTarget) return;
      const option = resolvePaperChipMenuSourceOptionFromCard(card);
      if (
        card.dataset.mineruCacheReveal !== "true" ||
        !option ||
        !canRevealMineruCacheForSourceOption(option)
      ) {
        closePaperChipMineruCacheMenu();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const mouseEvent = e as MouseEvent;
      openPaperChipMineruCacheMenu(
        option.paperContext.contextItemId,
        mouseEvent.clientX,
        mouseEvent.clientY,
      );
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
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc) return;
    const currentMode =
      (chip.dataset.contentSource as PaperContentSourceMode) ||
      paperContext.contentSourceMode ||
      "text";
    const sourceOptions = buildPaperSourceOptions(paperContext);
    if (!hasPaperChipSourceMenuOption(sourceOptions)) {
      closePaperChipMenu();
      return;
    }
    const menu = ensurePaperChipMenu();
    if (!menu) return;
    clearPaperChipMenuHideTimer();
    if (paperChipMenuAnchor && paperChipMenuAnchor !== chip) {
      paperChipMenuAnchor.classList.remove("llm-paper-context-chip-menu-open");
    }
    paperChipMenuAnchor = chip;
    chip.classList.add("llm-paper-context-chip-menu-open");
    chip.classList.remove("expanded");
    chip.classList.add("collapsed");
    if (item) {
      selectedPaperPreviewExpandedCache.delete(item.id);
    }
    paperChipMenuSticky = options?.sticky === true;
    paperChipMenuTarget = paperContext;
    closePaperChipMineruCacheMenu();
    menu.innerHTML = "";
    for (const sourceOption of sourceOptions) {
      menu.appendChild(
        buildPaperChipMenuCard(ownerDoc, sourceOption.paperContext, {
          contentSourceMode: sourceOption.mode,
          badge: sourceOption.badge,
          title: sourceOption.title,
          description: sourceOption.description,
          disabledReason: sourceOption.disabledReason,
          mineruState: sourceOption.mineruState,
          mineruAction: sourceOption.mineruAction,
          mineruActionTitle: sourceOption.mineruActionTitle,
          mineruCacheReveal: canRevealMineruCacheForSourceOption(sourceOption),
          selected:
            sourceOption.mode === currentMode &&
            sourceOption.paperContext.contextItemId ===
              paperContext.contextItemId,
          sourceOption: true,
        }),
      );
    }
    if (!menu.childElementCount) {
      menu.appendChild(
        buildPaperChipMenuCard(ownerDoc, paperContext, {
          contentSourceMode: currentMode,
        }),
      );
    }
    positionPaperChipMenuAboveAnchor(menu, chip);
    menu.style.display = "grid";
  };
  refreshOpenPaperChipMenu = () => {
    if (
      !paperChipMenu ||
      !paperChipMenuAnchor ||
      !paperChipMenuTarget ||
      paperChipMenu.style.display === "none"
    ) {
      return;
    }
    openPaperChipMenu(paperChipMenuAnchor, paperChipMenuTarget, {
      sticky: paperChipMenuSticky,
    });
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
        const selectItems = pane.selectItems as (
          itemIDs: number[],
          options?: { selectInLibrary?: boolean },
        ) => unknown;
        const selected = await selectItems([paperContext.itemId], {
          selectInLibrary: true,
        });
        if (selected !== false) return true;
      }
      if (typeof pane.selectItem === "function") {
        const selected = pane.selectItem(paperContext.itemId, true);
        if (selected !== false) return true;
      }
      if (paperContext.contextItemId !== paperContext.itemId) {
        if (typeof pane.selectItems === "function") {
          const selectItems = pane.selectItems as (
            itemIDs: number[],
            options?: { selectInLibrary?: boolean },
          ) => unknown;
          const selected = await selectItems([paperContext.contextItemId], {
            selectInLibrary: true,
          });
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
    const sourceOptions = buildPaperSourceOptions(paperContext);
    const hasSourceMenu = hasPaperChipSourceMenuOption(sourceOptions);
    const hasReaderFocus =
      isPaperContextReaderFocusableSourceMode(contentSourceMode);
    const isStaticChip = !hasSourceMenu && !hasReaderFocus;
    const chip = createElement(
      ownerDoc,
      "div",
      "llm-selected-context llm-paper-context-chip",
    );
    chip.dataset.paperContextMenu = hasSourceMenu ? "true" : "false";
    chip.classList.toggle("llm-paper-context-chip-static", isStaticChip);
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
    chip.classList.add(getContextSourceModeCssClassName(contentSourceMode));
    chip.classList.toggle(
      "llm-paper-context-chip-webchat-inactive",
      isWebChatMode() && contentSourceMode === "pdf" && !fullText,
    );
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
        title: formatPaperContextChipTitle(paperContext, contentSourceMode),
      },
    );
    const chipIcon = createContextIcon(
      ownerDoc,
      "paper",
      "llm-paper-context-chip-icon",
    );
    const chipText = createElement(
      ownerDoc,
      "span",
      "llm-paper-context-chip-text",
      {
        textContent: formatPaperContextChipLabel(
          paperContext,
          contentSourceMode,
        ),
      },
    );
    chipLabel.append(chipIcon, chipText);
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
    chip.append(chipExpanded);
    chip.append(chipHeader);

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

  const appendPaperSummaryChip = (
    ownerDoc: Document,
    list: HTMLDivElement,
    params: {
      paperCount: number;
      expanded: boolean;
      label: string;
    },
  ) => {
    const summaryChip = createElement(
      ownerDoc,
      "div",
      "llm-selected-context llm-paper-context-summary-chip",
    ) as HTMLDivElement;
    summaryChip.dataset.paperContextSummary = "true";
    summaryChip.dataset.paperContextCount = `${params.paperCount}`;

    const summaryToggle = createElement(
      ownerDoc,
      "button",
      "llm-paper-context-summary-toggle",
      {
        type: "button",
        title: params.expanded
          ? t("Collapse paper contexts")
          : t("Expand paper contexts"),
      },
    ) as HTMLButtonElement;
    summaryToggle.setAttribute(
      "aria-expanded",
      params.expanded ? "true" : "false",
    );
    summaryToggle.setAttribute(
      "aria-label",
      params.expanded
        ? t("Collapse paper contexts")
        : t("Expand paper contexts"),
    );

    const summaryIcon = createContextIcon(
      ownerDoc,
      "papers",
      "llm-paper-context-summary-icon",
    );
    const summaryText = createElement(
      ownerDoc,
      "span",
      "llm-paper-context-summary-text",
      { textContent: params.label },
    );
    summaryToggle.append(summaryIcon, summaryText);
    const clearButton = createElement(
      ownerDoc,
      "button",
      "llm-remove-img-btn llm-paper-context-summary-clear",
      {
        type: "button",
        textContent: "×",
        title: t("Clear all context"),
      },
    ) as HTMLButtonElement;
    clearButton.setAttribute("aria-label", t("Clear all context"));
    summaryChip.append(summaryToggle, clearButton);
    list.appendChild(summaryChip);
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
        title: `${ref.refKind === "figure" ? "Figure" : "File"}: ${ref.title}`,
      },
    );
    const chipIcon = createContextIcon(
      ownerDoc,
      ref.refKind === "figure" ? "image" : "file",
      "llm-other-ref-chip-icon",
    );
    const chipTitle = createElement(
      ownerDoc,
      "span",
      "llm-other-ref-chip-title",
      { textContent: ref.title },
    );
    chipLabel.append(chipIcon, chipTitle);
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

  /** A folder or tag chip's name, with the papers removed in Task progress. */
  const withExcludedCount = (name: string, excluded?: number[]) =>
    excluded?.length
      ? `${name} · ${
          excluded.length === 1
            ? t("1 excluded")
            : t("{count} excluded").replace("{count}", `${excluded.length}`)
        }`
      : name;

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
        title: `Collection: ${ref.name}`,
      },
    );
    const chipIcon = createContextIcon(
      ownerDoc,
      "collection",
      "llm-collection-chip-icon",
    );
    const chipTitle = createElement(
      ownerDoc,
      "span",
      "llm-collection-chip-title",
      { textContent: withExcludedCount(ref.name, ref.excludedItemIds) },
    );
    chipLabel.append(chipIcon, chipTitle);
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

  const appendTagChip = (
    ownerDoc: Document,
    list: HTMLDivElement,
    ref: TagContextRef,
    removableIndex: number,
  ) => {
    const chip = createElement(
      ownerDoc,
      "div",
      "llm-selected-context llm-tag-context-chip",
    );
    chip.dataset.tagIndex = `${removableIndex}`;
    chip.classList.add("collapsed");

    const chipHeader = createElement(
      ownerDoc,
      "div",
      "llm-image-preview-header llm-selected-context-header llm-tag-chip-header",
    );
    const chipLabel = createElement(ownerDoc, "span", "llm-tag-chip-label", {
      title: `Tag: ${ref.name}`,
    });
    const chipIcon = createContextIcon(ownerDoc, "tag", "llm-tag-chip-icon");
    const chipTitle = createElement(ownerDoc, "span", "llm-tag-chip-title", {
      textContent: withExcludedCount(ref.name, ref.excludedItemIds),
    });
    chipLabel.append(chipIcon, chipTitle);
    const removeBtn = createElement(
      ownerDoc,
      "button",
      "llm-remove-img-btn llm-tag-clear",
      {
        type: "button",
        textContent: "\u00D7",
        title: `Remove ${ref.name}`,
      },
    ) as HTMLButtonElement;
    removeBtn.dataset.tagIndex = `${removableIndex}`;
    removeBtn.setAttribute("aria-label", `Remove ${ref.name}`);
    chipHeader.append(chipLabel, removeBtn);
    chip.appendChild(chipHeader);
    list.appendChild(chip);
  };

  const appendConversationChip = (
    ownerDoc: Document,
    list: HTMLDivElement,
    ref: AttachedConversationRef,
    removableIndex: number,
  ) => {
    const chip = createElement(
      ownerDoc,
      "div",
      "llm-selected-context llm-conversation-context-chip",
    );
    chip.dataset.conversationIndex = `${removableIndex}`;
    chip.classList.add("collapsed");

    const chipHeader = createElement(
      ownerDoc,
      "div",
      "llm-image-preview-header llm-selected-context-header llm-conversation-chip-header",
    );
    const labelText = formatAttachedConversationLabel(ref);
    const chipLabel = createElement(
      ownerDoc,
      "span",
      "llm-conversation-chip-label",
      { title: labelText },
    );
    const chipIcon = createContextIcon(
      ownerDoc,
      "model",
      "llm-conversation-chip-icon",
    );
    const chipTitle = createElement(
      ownerDoc,
      "span",
      "llm-conversation-chip-title",
      { textContent: labelText },
    );
    chipLabel.append(chipIcon, chipTitle);
    const removeBtn = createElement(
      ownerDoc,
      "button",
      "llm-remove-img-btn llm-conversation-clear",
      {
        type: "button",
        textContent: "\u00D7",
        title: `Remove ${ref.title}`,
      },
    ) as HTMLButtonElement;
    removeBtn.dataset.conversationIndex = `${removableIndex}`;
    removeBtn.setAttribute("aria-label", `Remove ${ref.title}`);
    chipHeader.append(chipLabel, removeBtn);
    chip.appendChild(chipHeader);
    list.appendChild(chip);
  };

  const updatePaperPreview = () => {
    renderPaperPreview();
    // Task progress lists what the context bar holds: follow every change.
    syncTaskProgressPanel(body);
  };

  const renderPaperPreview = () => {
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
    const selectedTags = selectedTagContextCache.get(itemId) || [];
    const selectedConversations =
      composeContextStore.attachedConversations.list(itemId);
    const hasAnyContext =
      selectedPapers.length > 0 ||
      selectedOtherRefs.length > 0 ||
      selectedCollections.length > 0 ||
      selectedTags.length > 0 ||
      selectedConversations.length > 0 ||
      !!autoLoadedPaperContext;
    if (!hasAnyContext) {
      paperPreview.style.display = "none";
      paperPreviewList.innerHTML = "";
      // Rendering an empty preview must not clear item-scoped compose state.
      // Another mounted panel can share this conversation while resolving a
      // different local context source; explicit remove/reset actions own the
      // corresponding state mutation.
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
    const effectivePaperCount =
      selectedPapers.length + (autoLoadedPaperContext ? 1 : 0);
    const paperCollapseState = getPaperContextCollapseState({
      itemId,
      paperCount: effectivePaperCount,
      expandedByItem: selectedPaperContextListExpandedCache,
    });
    if (paperCollapseState.showSummaryChip) {
      appendPaperSummaryChip(ownerDoc, paperPreviewList, {
        paperCount: effectivePaperCount,
        expanded: paperCollapseState.expanded,
        label: paperCollapseState.summaryLabel,
      });
    }
    if (paperCollapseState.showPaperChips) {
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
          contentSourceMode: resolvePaperContentSourceMode(
            itemId,
            paperContext,
          ),
        });
      });
    }
    selectedOtherRefs.forEach((ref, index) => {
      appendOtherRefChip(ownerDoc, paperPreviewList, ref, index);
    });
    selectedCollections.forEach((ref, index) => {
      appendCollectionChip(ownerDoc, paperPreviewList, ref, index);
    });
    selectedTags.forEach((ref, index) => {
      appendTagChip(ownerDoc, paperPreviewList, ref, index);
    });
    selectedConversations.forEach((ref, index) => {
      appendConversationChip(ownerDoc, paperPreviewList, ref, index);
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
            appLogger.warn(
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

  const getSelectedScreenshotSupport = () => {
    const selectedProfile = getSelectedProfile();
    const currentModel = (
      selectedProfile?.model ||
      getSelectedModelInfo().currentModel ||
      ""
    ).trim();
    const inputMode = getAdvancedModelParamsForEntry(
      selectedProfile?.entryId,
    )?.inputMode;
    const screenshotUnsupported = isScreenshotUnsupportedModel(
      currentModel,
      selectedProfile?.providerProtocol,
      selectedProfile?.authMode,
      selectedProfile?.apiBase,
      inputMode,
    );
    return { currentModel, screenshotUnsupported };
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
    const { currentModel, screenshotUnsupported } =
      getSelectedScreenshotSupport();
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
  const measureContextPreviewHeight = (): number => {
    if (!contextPreviews) return 0;
    const rect = contextPreviews.getBoundingClientRect?.();
    const rectHeight = Number(rect?.height);
    if (Number.isFinite(rectHeight) && rectHeight >= 0) return rectHeight;
    const scrollHeight = Number(contextPreviews.scrollHeight);
    if (Number.isFinite(scrollHeight) && scrollHeight >= 0) {
      return scrollHeight;
    }
    const offsetHeight = Number(contextPreviews.offsetHeight);
    return Number.isFinite(offsetHeight) && offsetHeight >= 0
      ? offsetHeight
      : 0;
  };
  const syncConversationPanelState = () => {
    syncQueuedFollowUpRegistration();
    syncRequestUiForCurrentConversation();
    restoreDraftInputForCurrentConversation();
    updatePaperPreview();
    updateFilePreview();
    updateImagePreview();
    updateSelectedTextPreview();
  };
  activeContextPanelStateSync.set(body, syncConversationPanelState);
  const disposeHistoryActivity = historyMenu
    ? observeHistoryActivity(historyMenu)
    : null;
  const runPanelStateRefreshNow = () => {
    if (!panelRoot.isConnected) return;
    const previousHeight = measureContextPreviewHeight();
    if (!item) {
      runWithChatScrollGuard(syncConversationPanelState);
    } else {
      refreshConversationPanels(body, item, {
        includeChat: false,
        includePanelState: true,
      });
    }
    const nextHeight = measureContextPreviewHeight();
    hooks?.onContextPreviewRendered?.({
      previousHeight,
      nextHeight,
    });
  };
  const panelStateRefreshScheduler = createCoalescedFrameScheduler({
    getWindow: () => body.ownerDocument?.defaultView || null,
    run: runPanelStateRefreshNow,
  });
  panelLifecycle.add(panelStateRefreshScheduler.dispose);
  const schedulePanelStateRefresh = () => {
    panelStateRefreshScheduler.schedule();
  };
  const flushPanelStateRefreshNow = () => {
    panelStateRefreshScheduler.flush();
  };
  const updatePaperPreviewPreservingScroll = () => {
    schedulePanelStateRefresh();
  };
  requestAutoLoadedPaperContextRefresh = updatePaperPreviewPreservingScroll;

  // Task progress lists the context bar's papers and can remove one. A paper
  // added on its own loses its chip; a paper that came with a folder or a tag
  // is excluded from that folder or tag (the chip stays and counts it), so
  // retrieval and the next question leave it out.
  body.addEventListener(TASK_PROGRESS_REMOVE_PAPER_EVENT, (event: Event) => {
    void removeTaskProgressPaper(event);
  });
  // "Source" on a passage the card lists, or a citation under its paper:
  // open the paper at the passage.
  body.addEventListener(TASK_PROGRESS_OPEN_PASSAGE_EVENT, (event: Event) => {
    const target = (event as CustomEvent<TaskPaperPassageTarget>).detail;
    if (!target || !(Number(target.itemId) > 0)) return;
    const button =
      (event.target as Element | null)?.closest?.<HTMLButtonElement>(
        "button.llm-task-paper-open, button.llm-task-paper-citation",
      ) || null;
    void navigateToTaskPaperPassage({ body, target, button }).catch(
      (error: unknown) => {
        appLogger.warn("LLM task progress passage open failed", error);
      },
    );
  });
  // "Open page" on a scholarly paper or web page: the side panel's page view
  // when the window has one, otherwise the default browser.
  body.addEventListener(TASK_PROGRESS_OPEN_SOURCE_EVENT, (event: Event) => {
    const source = (event as CustomEvent<TaskProgressOpenSourceDetail>).detail
      ?.source;
    if (!source?.url) return;
    openWebSourceLink(body.ownerDocument, {
      url: source.url,
      title: source.title,
      organization: source.organization,
      hostname: source.hostname,
      faviconUrl: source.faviconUrl,
      ...(source.kind === "paper" ? { kind: "paper" as const } : {}),
      runId: (event as CustomEvent<TaskProgressOpenSourceDetail>).detail.runId,
    });
  });
  // "Show in answer": scroll the chat to the sentence that uses the source,
  // light it, and flash its marker (or a library paper's quote chip).
  let clearAnswerLight: ((event: Event) => void) | null = null;
  body.addEventListener(TASK_PROGRESS_SHOW_IN_ANSWER_EVENT, (event: Event) => {
    const detail = (event as CustomEvent<TaskProgressShowInAnswerDetail>)
      .detail;
    if (!detail?.key) return;
    const chatBox = body.querySelector(
      "#llm-chat-box",
    ) as HTMLDivElement | null;
    // Older turns of a long conversation may still be waiting to be drawn.
    flushPendingChatRender(chatBox);
    clearAnswerQuoteHighlights(body);
    const roots = findAnswerRoots(body, detail.runId);
    // A cited passage: every sentence that cites it, by its marks.
    const passage = detail.citationId
      ? lightCitedPassage(roots, detail.citationId, detail.texts || [])
      : null;
    const mark = passage ? passage.mark : findAnswerSourceMark(detail);
    const lit = passage
      ? passage.lit
      : detail.text
        ? highlightAnswerQuote(roots, detail.text, mark)
        : [];
    // Never a click that does nothing: without the sentence or its marker,
    // the run's answer itself, and a line that says so.
    const own = detail.runId ? roots[0] : undefined;
    const target = lit[0] || mark || own;
    if (!lit.length && !mark && status && (detail.text || detail.citationId))
      setStatus(
        status,
        target
          ? t("Couldn't find that sentence in the answer; showing the answer")
          : t("Couldn't find that sentence in the chat"),
        "warning",
      );
    if (!target) return;
    const win = body.ownerDocument?.defaultView;
    // Its start at the top of what shows of the chat: a long sentence reads
    // down from there, above the chips and composer. As a navigation, so a
    // chat that was following its last answer stops pulling back down.
    const navigated =
      chatBox &&
      navigateChatToMessage({
        conversationKey: Number(panelRoot.dataset.itemId),
        chatBox,
        targetElement: target,
        behavior: win?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
          ? "auto"
          : "smooth",
        // Its first line below what covers the chat's top (the standalone
        // window's title row runs over it), with the chat's own gap.
        viewportOffsetTop:
          (Number.parseFloat(
            win?.getComputedStyle(chatBox)?.scrollPaddingTop || "0",
          ) || 0) + getChatCoveredTop(chatBox),
      });
    if (!navigated) {
      try {
        target.scrollIntoView({ block: "start", behavior: "smooth" });
      } catch {
        target.scrollIntoView();
      }
    }
    pulseAnswerQuote(lit);
    if (mark) {
      mark.classList.remove("llm-web-source-flash");
      void mark.getBoundingClientRect();
      mark.classList.add("llm-web-source-flash");
      win?.setTimeout(
        () => mark.classList.remove("llm-web-source-flash"),
        1600,
      );
    }
    if (lit.length) {
      // The light stays until the next click in the chat, not on the
      // scrollbar or the lit words (to select and copy them).
      const chat = body.querySelector("#llm-chat-box") || body;
      if (clearAnswerLight)
        chat.removeEventListener("mousedown", clearAnswerLight);
      const clear = (event: Event) => {
        const hit = event.target as Element | null;
        if (hit === chat || lit.some((node) => hit && node.contains(hit)))
          return;
        chat.removeEventListener("mousedown", clear);
        clearAnswerLight = null;
        clearAnswerQuoteHighlights(body);
      };
      clearAnswerLight = clear;
      win?.setTimeout(() => {
        if (clearAnswerLight === clear)
          chat.addEventListener("mousedown", clear);
      }, 0);
    }
  });
  /**
   * Light each sentence that cites a passage near the answer's marks that
   * hold its id (the nth sentence by the mark that closes it); a sentence
   * whose words are not found lights as its mark's own sentence. A passage the answer
   * only quotes lights its card. In reading order, with its first mark.
   */
  const lightCitedPassage = (
    roots: readonly HTMLElement[],
    citationId: string,
    texts: readonly string[],
  ): { mark: HTMLElement | null; lit: HTMLElement[] } => {
    const marks = roots.flatMap(
      (root) =>
        Array.from(
          root.querySelectorAll(".llm-paper-cite-mark[data-citation-ids]"),
        ) as HTMLElement[],
    );
    const own = marks.filter((node) =>
      (node.dataset.citationIds || "").split(" ").includes(citationId),
    );
    const lit: HTMLElement[] = [];
    const add = (nodes: readonly HTMLElement[]) => {
      for (const node of nodes) if (!lit.includes(node)) lit.push(node);
    };
    // One mark per sentence, as `texts` has one entry per sentence.
    const closing = sentenceClosingMarks(own);
    texts.forEach((text, index) => {
      const near = closing[index] || own[0] || null;
      const found = text ? highlightAnswerQuote(roots, text, near) : [];
      if (found.length) add(found);
      else if (closing[index]) add(highlightSentenceBeforeMark(closing[index]));
    });
    if (!lit.length)
      for (const node of own) add(highlightSentenceBeforeMark(node));
    if (!lit.length) add(highlightAnswerQuoteCard(roots, citationId));
    lit.sort((left, right) =>
      left.compareDocumentPosition(right) & 4 ? -1 : 1,
    );
    return { mark: own[0] || null, lit };
  };
  const findAnswerSourceMark = (
    detail: TaskProgressShowInAnswerDetail,
  ): HTMLElement | null => {
    const indicators = Array.from(
      body.querySelectorAll(".llm-web-source-indicator"),
    ) as HTMLElement[];
    const ofRun = (node: HTMLElement, runId?: string) =>
      !runId || node.dataset.runId === runId;
    // The quote's own marker first.
    if (detail.anchor !== undefined) {
      const own =
        indicators.find(
          (node) =>
            ofRun(node, detail.runId) &&
            node.dataset.anchorIndex === String(detail.anchor),
        ) || null;
      if (own) return own;
    }
    const marks = (runId?: string) =>
      indicators.find(
        (node) =>
          ofRun(node, runId) &&
          node.dataset.placement !== "end" &&
          (node.dataset.sourceKeys || "").split(" ").includes(detail.key),
      ) || null;
    const itemId = Number(detail.itemId);
    const chip = (runId?: string) =>
      itemId > 0 ? findCitationChipForItem(body, itemId, runId) : null;
    // Only the run's own: another answer's chip would lead to that answer.
    return marks(detail.runId) || chip(detail.runId);
  };
  // "Search scholarly sources too" / "Search the web too": ask it as a
  // follow-up.
  body.addEventListener(TASK_PROGRESS_OFFER_EVENT, (event: Event) => {
    const what = (event as CustomEvent<TaskProgressOfferDetail>).detail?.what;
    if (what !== "scholarly" && what !== "web") return;
    if (!item || isRequestPending(getConversationKey(item))) return;
    void doSend({
      overrideText:
        what === "web"
          ? t("Yes, search the web too.")
          : t("Yes, search scholarly sources too."),
      // The composer's own draft stays; nothing to put back if it fails.
      preserveInputDraft: true,
      restoreQueuedInput: () => undefined,
    });
  });
  const removeTaskProgressPaper = async (event: Event) => {
    if (!item) return;
    const owner = item;
    const itemId = Math.floor(
      Number((event as CustomEvent<{ itemId?: number }>).detail?.itemId || 0),
    );
    if (!(itemId > 0)) return;
    const autoLoaded = resolveAutoLoadedPaperContext();
    if (autoLoaded?.itemId === itemId) return;
    const papers = getManualPaperContextsForItem(item.id, autoLoaded);
    const removed = papers.filter((paper) => paper.itemId === itemId);
    let changed = false;
    if (removed.length) {
      for (const paper of removed) {
        paperContextModeOverrides.delete(ownerScopedPaperKey(item.id, paper));
      }
      const next = papers.filter((paper) => paper.itemId !== itemId);
      if (next.length) selectedPaperContextCache.set(item.id, next);
      else clearSelectedPaperState(item.id);
      changed = true;
    }
    // A folder or tag that also brings the paper keeps it out from now on.
    const collections = selectedCollectionContextCache.get(item.id) || [];
    const tags = selectedTagContextCache.get(item.id) || [];
    const libraryID =
      collections[0]?.libraryID || tags[0]?.libraryID || item.libraryID;
    const snapshot =
      collections.length || tags.length
        ? await libraryIndexService.getSnapshot(libraryID).catch(() => null)
        : null;
    // The panel moved on to another conversation while the index loaded.
    if (item !== owner) return;
    if (snapshot) {
      const holds = (
        contexts: Parameters<typeof resolveTaskPaperScopeItemIds>[1],
      ) => resolveTaskPaperScopeItemIds(snapshot, contexts).includes(itemId);
      const exclude = <T extends { excludedItemIds?: number[] }>(ref: T): T =>
        ({
          ...ref,
          excludedItemIds: [...(ref.excludedItemIds || []), itemId],
        }) as T;
      let excluded = false;
      const nextCollections = collections.map((ref) => {
        if (!holds({ collections: [ref] })) return ref;
        excluded = true;
        return exclude(ref);
      });
      const nextTags = tags.map((ref) => {
        if (!holds({ tags: [ref] })) return ref;
        excluded = true;
        return exclude(ref);
      });
      if (excluded) {
        if (collections.length)
          selectedCollectionContextCache.set(item.id, nextCollections);
        if (tags.length) selectedTagContextCache.set(item.id, nextTags);
        changed = true;
      }
    }
    if (!changed) return;
    initializedConversationComposeContextKeys.add(item.id);
    updatePaperPreviewPreservingScroll();
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
  cleanupMineruPaperSourceObservers = (() => {
    const unsubscribeProcessing = onProcessingStatusChange(() => {
      syncMineruPaperSourceState();
      updatePaperPreviewPreservingScroll();
      refreshOpenPaperChipMenu();
    });
    const unsubscribeBatch = onBatchStateChange(() => {
      refreshOpenPaperChipMenu();
    });
    return () => {
      unsubscribeProcessing();
      unsubscribeBatch();
    };
  })();
  // Counts chat draws, so an in-place paper switch can tell that another
  // conversation was drawn while it was loading.
  let chatDrawCount = 0;
  const refreshChatPreservingScroll = () => {
    chatDrawCount += 1;
    if (!item) {
      runWithChatScrollGuard(() => {
        refreshChat(body, item);
      });
      return;
    }
    refreshConversationPanels(body, item);
  };
  const refreshOwnChatPreservingScroll = () => {
    if (!item) {
      refreshChatPreservingScroll();
      return;
    }
    chatDrawCount += 1;
    refreshChat(body, item);
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
    topToast,
    paperChatTabBtn,
    libraryChatTabBtn,
    modeSwitch,
    getItem: () => item,
    setItem: (nextItem) => {
      if (
        nextItem &&
        !canCommitPanelConversation(
          body,
          nextItem,
          "commit-conversation-identity",
        )
      ) {
        return false;
      }
      item = nextItem as any;
      return true;
    },
    getBasePaperItem: () => basePaperItem,
    setBasePaperItem: (nextItem) => {
      if (nextItem && !isPanelHostCompatibleWithPaper(body, nextItem)) {
        return false;
      }
      basePaperItem = nextItem;
      return true;
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
    refreshAutoLoadedPaperContextForCurrentItem,
    persistDraftInputForCurrentConversation,
    restoreDraftInputForCurrentConversation,
    syncConversationIdentity,
    syncQueuedFollowUpRegistration,
    updateRuntimeModeButton,
    refreshChatPreservingScroll,
    refreshOwnChatPreservingScroll,
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
    moveToOwnWebChatSession: () => moveToOwnWebChatSession(),
    updateImagePreviewPreservingScroll,
    switchConversationSystem,
    getHistorySystems: () =>
      resolveUnifiedHistorySystems({
        activeSystem: getConversationSystem(),
        codexEnabled: isCodexModeAvailable(),
        claudeEnabled: isClaudeModeAvailable(),
        singleSystem: isSidePanel || isNoteSession(),
      }),
    isRuntimeSystemSwitchInFlight: () => runtimeSystemSwitchInFlight,
    openHistoryEntryInSystem: (system, target) =>
      openHistoryEntryInSystem(system, target),
    setSurfaceConversationSystem: (system) => {
      const previous = panelChoices.getConversationSystem();
      panelChoices.setConversationSystem(system);
      return () => {
        if (panelChoices.getConversationSystem() === system) {
          panelChoices.setConversationSystem(previous);
        }
      };
    },
    setActiveEditSession: (value) => {
      activeEditSession = value;
    },
    getCoreAgentRuntime: initAgentSubsystem,
    clearAgentToolCaches: clearAllAgentToolCaches,
    clearAgentConversationState,
    setStatusMessage: status
      ? (message, level) => {
          setStatus(status, message, level);
        }
      : undefined,
    log: (message, ...args) => {
      appLogger.debug(message, ...args);
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
  ensureWebChatSessionPaperConversation =
    historyLifecycleController.ensureWebChatSessionPaperConversation;
  queueTurnDeletion = historyLifecycleController.queueTurnDeletion;
  if (__env__ !== "production") {
    (body as HTMLElement & Record<string, unknown>).__llmQueueTurnDeletion =
      historyLifecycleController.queueTurnDeletion;
    (body as HTMLElement & Record<string, unknown>).__llmSearchPanelHistory =
      historyLifecycleController.searchConversationHistoryForWorkflowTest;
  }
  forkConversationFromTurn =
    historyLifecycleController.forkConversationFromTurn;
  resetHistorySearchState = historyLifecycleController.resetHistorySearchState;

  /**
   * The runtime toggle is the reader's way out of a panel whose declared scope
   * has drifted from the conversation it is showing. Delivering the click is
   * only half of that: `switchConversationSystem` gates on the same ownership
   * verdict, so without this the click would arrive and then be refused. A
   * `stale-candidate` verdict means the panel's own item is sound and only its
   * declaration is wrong, so re-derive the declaration from the item and carry
   * on. Any other verdict is a genuine host problem and is left to the gate.
   */
  const recoverDriftedPanelScopeForRuntimeToggle = () => {
    if (!item) return;
    if (evaluatePanelOwnership(body, item) !== "stale-candidate") return;
    appLogger.debug(
      "LLM: re-resolving a drifted panel scope for the runtime toggle",
      {
        conversationKey: getConversationKey(item),
        declaredSystem: panelRoot.dataset.conversationSystem,
      },
    );
    syncConversationIdentity();
  };

  /**
   * Switches this panel's runtime to `targetSystem`. The header buttons resolve
   * their toggle rule first (`resolveRuntimeSystemToggleTarget`); the runtime
   * badge menu passes the picked system straight through.
   */
  const switchRuntimeSystemFromControl = async (
    targetSystem: ConversationSystem,
  ) => {
    if (
      runtimeSystemSwitchInFlight ||
      !item ||
      (targetSystem === "codex" && !isCodexModeAvailable()) ||
      (targetSystem === "claude_code" && !isClaudeModeAvailable())
    ) {
      return;
    }
    recoverDriftedPanelScopeForRuntimeToggle();
    runtimeSystemSwitchInFlight = true;
    updateRuntimeSystemToggles();
    try {
      await switchConversationSystem(targetSystem, { forceFresh: true });
    } catch (err) {
      appLogger.warn("LLM: Failed to switch conversation runtime", err);
    } finally {
      runtimeSystemSwitchInFlight = false;
      updateRuntimeSystemToggles();
    }
  };
  /**
   * Opens a history row of another runtime: switches this panel to `system`
   * and opens the row's conversation directly. Runs inside the same in-flight
   * guard as the badge and the header buttons, so they show busy and a second
   * row click is refused until this one ends.
   */
  const openHistoryEntryInSystem = async (
    system: ConversationSystem,
    target: RuntimeHistoryTarget,
  ): Promise<boolean> => {
    if (
      runtimeSystemSwitchInFlight ||
      !item ||
      (system === "codex" && !isCodexModeAvailable()) ||
      (system === "claude_code" && !isClaudeModeAvailable())
    ) {
      return false;
    }
    recoverDriftedPanelScopeForRuntimeToggle();
    runtimeSystemSwitchInFlight = true;
    updateRuntimeSystemToggles();
    try {
      return await switchConversationSystem(system, { target });
    } catch (err) {
      appLogger.warn("LLM: Failed to open a history row in its runtime", err);
      return false;
    } finally {
      runtimeSystemSwitchInFlight = false;
      updateRuntimeSystemToggles();
      updateRuntimeModeButton();
    }
  };
  for (const system of RUNTIME_CONVERSATION_SYSTEMS) {
    const button = panelRuntimeSystemControls.buttons[system];
    if (!button) continue;
    button.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      void switchRuntimeSystemFromControl(
        resolveRuntimeSystemToggleTarget(getConversationSystem(), system),
      );
    });
  }

  const getModelChoices = () => {
    const choices = isClaudeConversationSystem()
      ? getClaudeRuntimeModelEntries()
      : isCodexConversationSystem()
        ? getCodexRuntimeModelEntries()
        : getAvailableModelEntries().filter(
            // Neither a side chat nor a torn-off window runs on WebChat.
            (entry) => offersWebChatModels() || entry.authMode !== "webchat",
          );
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
          ? panelChoices.getSelectedModelEntry()
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

  quotaControl = attachFooterQuotaControl({
    button: body.querySelector<HTMLButtonElement>("#llm-provider-quota"),
    getTarget: () => {
      if (!item) return null;
      if (isClaudeConversationSystem()) {
        const context = resolveClaudeModelCatalogContext();
        return context
          ? {
              kind: "claude",
              bridgeUrl: getClaudeBridgeUrl(),
              settingSources: getClaudeSettingSourcesCsvByPref(),
              context,
            }
          : null;
      }
      return resolveQuotaTarget(getSelectedModelInfo().selectedEntry);
    },
    read: readFooterQuota,
  });

  updateModelButton = (onlyIfChanged = false) => {
    void quotaControl?.sync();
    if (!item || !modelBtn) return;
    const { choices, currentModel, currentModelDisplay, currentModelHint } =
      getSelectedModelInfo();
    const modelLabel = `${currentModelDisplay || currentModel || "default"}`;
    const readerRuntime = readerRuntimeKeyForSystem(getConversationSystem());
    // Only the tooltip names the reader; the button shows the main model.
    const readerLine = formatReaderTooltipLine(
      describeReaderSelection({
        runtime: readerRuntime,
        selection: panelChoices.getReaderSelection(readerRuntime),
        lookupEntry: getModelEntryById,
        runtimeEntries: isClaudeConversationSystem()
          ? getClaudeRuntimeModelEntries()
          : isCodexConversationSystem()
            ? getCodexRuntimeModelEntries()
            : [],
      }),
    );
    const mainModelHint =
      choices.length > 1
        ? currentModelHint
        : currentModelHint || "Only one model is configured";
    const modelHint = readerLine
      ? `${mainModelHint}\n${readerLine}`
      : mainModelHint;
    // A model can keep its name while its image-input capability changes in
    // settings. Keep that real change eligible for the preview refresh too.
    const { screenshotUnsupported } = getSelectedScreenshotSupport();
    const imageCount = selectedImageCache.get(item.id)?.length || 0;
    const screenshotStateChanged =
      screenshotBtn &&
      (screenshotBtn.disabled !==
        (screenshotUnsupported || imageCount >= MAX_SELECTED_IMAGES) ||
        (screenshotUnsupported && imageCount > 0));
    const buttonChanged =
      modelBtn.dataset.modelLabel !== modelLabel ||
      modelBtn.dataset.modelHint !== modelHint ||
      modelBtn.disabled !== !item;
    if (onlyIfChanged && !screenshotStateChanged && !buttonChanged) return;
    withScrollGuard(chatBox, conversationKey, () => {
      modelBtn.dataset.modelLabel = modelLabel;
      modelBtn.dataset.modelHint = modelHint;
      modelBtn.disabled = !item;
      scheduleResponsiveLayoutSync();
      // The image preview shows the model's screenshot support and names the
      // model in its disabled hint. Rebuilding every preview (paper chips,
      // files, task progress) when neither changed made each model-menu open
      // pay for a full panel-state refresh.
      if (buttonChanged || screenshotStateChanged) {
        updateImagePreviewPreservingScroll();
      }
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

  const appendModelMenuEmptyState = (
    menu: HTMLDivElement,
    text: string,
  ): HTMLDivElement => {
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
    return empty;
  };

  const appendModelMenuAction = (
    menu: HTMLDivElement,
    text: string,
    onActivate: (event: Event) => void,
  ) => {
    const action = createElement(
      body.ownerDocument as Document,
      "button",
      "llm-response-menu-item llm-model-option",
      {
        type: "button",
        textContent: text,
      },
    );
    action.addEventListener("pointerdown", onActivate);
    action.addEventListener("click", onActivate);
    menu.appendChild(action);
  };

  const appendModelCatalogStatus = (params: {
    menu: HTMLDivElement;
    status: "idle" | "loading" | "ready" | "error";
    modelCount: number;
    loadingMessage: string;
    errorMessage: string;
    errorTitle?: string;
    emptyMessage: string;
    retryLabel: string;
    onRetry: (event: Event) => void;
  }): boolean => {
    if (params.status === "loading") {
      // A refresh of a list the menu already shows stays quiet: the menu
      // updates in place when the new list lands. A status row here made the
      // menu open with one size and jump to another a moment later.
      if (params.modelCount > 0) return false;
      appendModelMenuEmptyState(params.menu, params.loadingMessage);
      return true;
    }
    if (params.status === "error") {
      const message = appendModelMenuEmptyState(
        params.menu,
        params.errorMessage,
      );
      if (params.errorTitle) message.title = params.errorTitle;
      appendModelMenuAction(params.menu, params.retryLabel, params.onRetry);
      return true;
    }
    if (params.status === "ready" && params.modelCount === 0) {
      appendModelMenuEmptyState(params.menu, params.emptyMessage);
      return true;
    }
    return false;
  };

  const appendCodexModelCatalogStatus = (menu: HTMLDivElement) => {
    if (!isCodexConversationSystem()) return;
    appendModelCatalogStatus({
      menu,
      status: codexModelCatalogStatus,
      modelCount: codexModelCatalogModels.length,
      loadingMessage: codexModelCatalogModels.length
        ? t("Refreshing Codex models…")
        : t("Loading Codex models…"),
      errorMessage: codexModelCatalogModels.length
        ? t("Could not refresh Codex models. Showing the last known list.")
        : t("Could not load Codex models. Showing current model only."),
      errorTitle: codexModelCatalogError,
      emptyMessage: t("Codex did not return any available models."),
      retryLabel: t("Retry loading Codex models"),
      onRetry: (event) => {
        if (!isPrimaryPointerEvent(event)) return;
        event.preventDefault();
        event.stopPropagation();
        void ensureCodexModelCatalogLoaded(true);
      },
    });
  };

  const appendClaudeModelCatalogStatus = (menu: HTMLDivElement) => {
    if (!isClaudeConversationSystem()) return;
    const statusHandled = appendModelCatalogStatus({
      menu,
      status: claudeModelCatalogStatus,
      modelCount: claudeModelCatalogModels.length,
      loadingMessage: claudeModelCatalogModels.length
        ? t("Refreshing Claude models…")
        : t("Loading Claude models…"),
      errorMessage: claudeModelCatalogModels.length
        ? t("Could not refresh Claude models. Showing the last known list.")
        : t("Could not load Claude models. Showing the current model only."),
      errorTitle: claudeModelCatalogError,
      emptyMessage: t("Claude Code did not return any available models."),
      retryLabel: t("Retry loading Claude models"),
      onRetry: (event) => {
        if (!isPrimaryPointerEvent(event)) return;
        event.preventDefault();
        event.stopPropagation();
        void ensureClaudeModelCatalogLoaded(true);
      },
    });
    if (statusHandled) return;
    if (claudeModelCatalogStatus === "ready" && claudeModelCatalogLegacy) {
      appendModelMenuEmptyState(
        menu,
        t(
          "Using a legacy adapter model list. Update the adapter for model details.",
        ),
      );
    }
  };

  const getModelOptionTitle = (entry: RuntimeModelEntry): string => {
    if (!isClaudeConversationSystem()) {
      return `${entry.providerLabel} · ${entry.model}`;
    }
    const catalogModel =
      claudeModelCatalogModels.find((model) => model.value === entry.model) ||
      claudeModelCatalogModels.find(
        (model) => model.resolvedModel === entry.model,
      );
    return [
      `${entry.providerLabel} · ${entry.model}`,
      catalogModel?.resolvedModel && catalogModel.resolvedModel !== entry.model
        ? `${t("Resolves to")}: ${catalogModel.resolvedModel}`
        : "",
      catalogModel?.description || "",
    ]
      .filter(Boolean)
      .join("\n");
  };

  /** The subagent card and page of the model menu. */
  const readerMenu = createReaderMenuController({
    doc: body.ownerDocument as Document,
    getRuntime: () => readerRuntimeKeyForSystem(getConversationSystem()),
    getSelection: (runtime) => panelChoices.getReaderSelection(runtime),
    setSelection: (runtime, selection) =>
      panelChoices.setReaderSelection(runtime, selection),
    getApiEntries: () => getAvailableModelEntries().filter(isReaderApiEntry),
    getRuntimeEntries: () =>
      isClaudeConversationSystem()
        ? getClaudeRuntimeModelEntries()
        : isCodexConversationSystem()
          ? getCodexRuntimeModelEntries()
          : [],
    lookupEntry: getModelEntryById,
    appendRuntimeCatalogStatus: (menu) => {
      appendClaudeModelCatalogStatus(menu);
      appendCodexModelCatalogStatus(menu);
    },
    appendProviderSection: appendModelProviderSection,
    optionTitle: (entry, own) =>
      own
        ? getModelOptionTitle(entry)
        : `${entry.providerLabel} · ${entry.model}`,
    isPrimaryPointerEvent,
    onPageChange: () => {
      if (!modelMenu || !modelBtn) return;
      // The menu fits its names, and the two pages list different names.
      // Keep the wider of the two widths while the menu is open, so turning
      // the page never makes it jump narrower.
      const widthBefore = modelMenu.getBoundingClientRect().width;
      modelMenu.style.width = "";
      rebuildModelMenu();
      positionComposerMenu(body, modelMenu, modelBtn);
      if (widthBefore > modelMenu.getBoundingClientRect().width) {
        modelMenu.style.width = `${widthBefore}px`;
        positionComposerMenu(body, modelMenu, modelBtn);
      }
    },
    onPick: () => {
      updateModelButton();
    },
  });

  const rebuildModelMenu = () => {
    if (!item || !modelMenu) return;
    // No catalog refresh here: a refresh notifies capability listeners, which
    // rebuild an open menu. openModelMenu starts the refresh once per open.
    const { groupedChoices, selectedEntryId } = getSelectedModelInfo();

    // The menu itself is only a frame; its cards sit in one column inside it.
    modelMenu.innerHTML = "";
    const stack = createElement(
      body.ownerDocument as Document,
      "div",
      "llm-model-menu-stack",
    ) as HTMLDivElement;
    modelMenu.appendChild(stack);
    if (readerMenu.getPage() === "subagent") {
      readerMenu.appendReaderList(stack);
      return;
    }
    // Card 1: the subagent, small, on top. Card 2: the chat models.
    readerMenu.appendSubagentCard(stack);
    const list = readerMenu.createCard("llm-model-menu-list");
    stack.appendChild(list);
    readerMenu.appendCardTitle(list, t("Main Agent"));
    appendClaudeModelCatalogStatus(list);
    appendCodexModelCatalogStatus(list);
    codexDirectController?.appendCatalogStatus({
      menu: list,
      renderStatus: appendModelCatalogStatus,
      appendEmptyState: appendModelMenuEmptyState,
      isPrimaryPointerEvent,
    });
    if (!groupedChoices.length) {
      appendModelMenuEmptyState(list, t("No models configured yet."));
      return;
    }

    for (const group of groupedChoices) {
      appendModelProviderSection(list, group.providerLabel);
      for (const entry of group.entries) {
        const isSelected = entry.entryId === selectedEntryId;
        const option = createElement(
          body.ownerDocument as Document,
          "button",
          "llm-response-menu-item llm-model-option",
          {
            type: "button",
            textContent: entry.displayModelLabel || "default",
            title: getModelOptionTitle(entry),
          },
        );
        option.classList.toggle(MENU_OPTION_SELECTED_CLASS, isSelected);
        option.dataset.entryId = entry.entryId;
        if (entry.catalogAvailability === "saved-unavailable") {
          option.disabled = true;
          option.classList.add("llm-model-option-disabled");
          option.title = t(
            "This saved model is not present in the current Codex Direct catalog.",
          );
        }
        const applyModelSelection = (e: Event) => {
          if (!isPrimaryPointerEvent(e)) return;
          if (entry.catalogAvailability === "saved-unavailable") return;
          e.preventDefault();
          e.stopPropagation();
          if (!item) return;
          if (isClaudeConversationSystem()) {
            clearClaudeReasoningDisplayOverride();
            panelChoices.setClaudeRuntimeModel(entry.model);
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
            panelChoices.setCodexRuntimeModel(entry.model);
            reconcileSelectedCodexReasoningMode();
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
          const wasWebChat = isWebChatMode();
          setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, false);
          setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
          // [webchat] Picking an API model from inside webchat is a mode exit:
          // the shared owner restores the entry, drops the hidden session
          // row, and returns to the paper's remembered conversation.
          if (wasWebChat && entry.authMode !== "webchat") {
            void leaveWebChatMode({ targetEntryId: entry.entryId });
            return;
          }
          // [webchat] Remember current model before switching to webchat
          if (!wasWebChat && entry.authMode === "webchat") {
            webChatModeController.rememberModelBeforeEnteringWebChat();
          }

          panelChoices.setSelectedModelEntry(entry.entryId);

          // Keep the relay target synchronized when switching between webchat
          // providers as well as when entering webchat from a local/API model.
          // Otherwise the model button can show DeepSeek while the extension
          // continues sending to the previous ChatGPT tab.
          if (entry.authMode === "webchat") {
            try {
              const { getWebChatTargetByModelName } =
                require("../../webchat/types") as typeof import("../../webchat/types");
              const { relaySetActiveTarget } =
                require("../../webchat/relayServer") as typeof import("../../webchat/relayServer");
              const selectedWebChatTarget = getWebChatTargetByModelName(
                entry.model || "",
              );
              if (selectedWebChatTarget?.id) {
                relaySetActiveTarget(selectedWebChatTarget.id);
              }
            } catch {
              /* async preload path will retry when entering webchat */
            }
          }

          // Auto-correct PDF mode for models that don't support native full-PDF
          // input. Downgrade to text/mineru so the user doesn't end up with a
          // broken send.
          const shouldDowngrade = shouldDowngradePdfSourceForConversation({
            basePdfSupport: getModelPdfSupport(
              entry.model,
              entry.providerProtocol,
              entry.authMode,
              entry.apiBase,
              entry.advanced?.inputMode,
            ),
            isClaudeCode: isClaudeConversationSystem(),
            isCodex: isCodexConversationSystem(),
          });
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
                    "Your current model provider doesn't support direct PDF upload.",
                  ),
                  "warning",
                );
              }
            }
          }

          // [webchat] Entering webchat mode → fresh session, then apply webchat UI AFTER re-render
          if (entry.authMode === "webchat" && !wasWebChat) {
            // Clear cached images so stale screenshots don't auto-attach to ChatGPT
            if (item) {
              selectedImageCache.delete(item.id);
              updateImagePreviewPreservingScroll();
            }
            // Apply webchat UI immediately so model button is disabled during preload
            applyWebChatModeUI();
            void (async () => {
              // Anchor on the paper's dedicated webchat session row (hidden
              // from history, swept at startup) — never a normal draft.
              const anchored = await ensureWebChatSessionPaperConversation();
              if (!isWebChatMode()) return;
              if (!anchored) {
                // Fail closed: webchat must never bind to the paper's real
                // conversation. Leave webchat (restores the remembered
                // non-webchat entry) and keep the conversation on screen.
                await leaveWebChatMode({ restoreConversation: false });
                if (status) {
                  setStatus(status, t("Failed to create paper chat"), "error");
                }
                return;
              }
              resetCurrentWebChatConversation();
              refreshChatPreservingScroll();

              // Show preloading screen to verify connectivity before enabling webchat
              const chatShellEl = body.querySelector(
                ".llm-chat-shell",
              ) as HTMLElement | null;
              if (chatShellEl) {
                try {
                  const token = webChatFeature.beginPreload();
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
                  webChatFeature.clearPreload();
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
        list.appendChild(option);
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
      // [webchat] Retries never route through the browser-relay pipeline, so
      // webchat entries must not be offered as retry targets.
      const retryEntries = group.entries.filter(
        (entry) => entry.authMode !== "webchat",
      );
      if (!retryEntries.length) continue;
      appendModelProviderSection(retryModelMenu, group.providerLabel);
      for (const entry of retryEntries) {
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
            textContent: entry.displayModelLabel || "default",
            title: getModelOptionTitle(entry),
          },
        );
        option.classList.toggle(MENU_OPTION_SELECTED_CLASS, isSelected);
        if (entry.catalogAvailability === "saved-unavailable") {
          option.disabled = true;
          option.classList.add("llm-model-option-disabled");
        }
        const runRetry = async (e: Event) => {
          if (!isPrimaryPointerEvent(e)) return;
          if (entry.catalogAvailability === "saved-unavailable") return;
          e.preventDefault();
          e.stopPropagation();
          if (!item) return;
          closeRetryModelMenu();
          const retryReasoning =
            entry.authMode === "codex_auth"
              ? codexDirectController?.getRetryReasoning(entry)
              : getSelectedReasoningForItem(
                  item.id,
                  entry.model,
                  entry.apiBase,
                  entry.providerProtocol,
                  entry.advanced?.profileOverride,
                  selectionSurface(),
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
    return panelChoices.getClaudeReasoningMode();
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
    if (mode === panelChoices.getClaudeReasoningMode()) {
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
      const selectedMode = panelChoices.getCodexReasoningMode();
      const options: ReasoningOption[] = getCodexReasoningChoices()
        .filter((choice) => choice.value !== "auto")
        .map((choice) => ({
          level: choice.value as LLMReasoningLevel,
          enabled: true,
          label: choice.label,
        }));
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
    const directSelection =
      codexDirectController?.resolveReasoningSelection() || {
        mode: "auto",
        choices: [] as CodexReasoningChoice[],
      };
    if (directSelection.choices.length) {
      const options: ReasoningOption[] = directSelection.choices
        .filter((choice) => choice.value !== "auto")
        .map((choice) => ({
          level: choice.value as LLMReasoningLevel,
          enabled: true,
          label: choice.label,
        }));
      return {
        provider: "openai" as const,
        currentModel,
        options,
        enabledLevels: options.map((option) => option.level),
        selectedLevel:
          directSelection.mode === "auto"
            ? "none"
            : (directSelection.mode as ReasoningLevelSelection),
        activeThinking: directSelection.mode !== "none",
      };
    }
    const selectedProfile = panelChoices.getSelectedModelEntry();
    const provider = detectReasoningProvider(
      currentModel,
      selectedProfile?.apiBase,
    );
    const options = getReasoningOptions(
      provider,
      currentModel,
      selectedProfile?.apiBase,
      selectedProfile?.providerProtocol,
      selectedProfile?.advanced?.profileOverride,
    );
    const enabledLevels = options
      .filter((option) => option.enabled)
      .map((option) => option.level);
    const previousLevel =
      selectedReasoningCache.get(
        reasoningCacheKey(selectionSurface(), item.id),
      ) ||
      panelChoices.getLastUsedReasoningLevelForProvider(provider) ||
      panelChoices.getLastUsedReasoningLevel();
    const resolved = getSelectedReasoningForItem(
      item.id,
      currentModel,
      selectedProfile?.apiBase,
      selectedProfile?.providerProtocol,
      selectedProfile?.advanced?.profileOverride,
      selectionSurface(),
    );
    const selectedLevel = resolved?.level || "auto";
    if (
      reasoningBtn &&
      previousLevel &&
      previousLevel !== "auto" &&
      previousLevel !== "default" &&
      selectedLevel === "auto"
    ) {
      reasoningBtn.dataset.reasoningAdjustment =
        "The previous reasoning level is unavailable for this model. Using Auto.";
    }
    return {
      provider,
      currentModel,
      options,
      enabledLevels,
      selectedLevel,
      // Judged by the request the level sends, not by what it is called.
      activeThinking:
        selectedLevel === "auto" ||
        isReasoningLevelActive(
          getModelCapabilities({
            provider,
            model: currentModel,
            apiBase: selectedProfile?.apiBase,
            protocol: selectedProfile?.providerProtocol,
            profileOverride: selectedProfile?.advanced?.profileOverride,
          }),
          selectedLevel,
        ),
    };
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

  // Panel features register their teardown here. cleanupSetupHandlers stays
  // explicitly ordered, so it calls the handle returned by add() at the exact
  // position the feature's undo used to sit; dispose() is the safety net for
  // any feature that is registered but not listed there.
  const webChatFeature = createWebChatFeature({
    isWebChatMode: () => isWebChatMode(),
    hasExistingWebChatSession: () => hasExistingWebChatSessionForCurrentItem(),
    getCurrentModelName: () => getSelectedModelInfo().currentModel,
  });
  const disposeWebChatFeature = panelLifecycle.add(() =>
    webChatFeature.unmount(),
  );

  markNextWebChatSendAsNewChat = () => {
    if (!item) return;
    markWebChatConversationForceNewChat(getConversationKey(item));
  };

  const clearNextWebChatNewChatIntent = () => {
    if (!item) return;
    clearWebChatConversationForceNewChat(getConversationKey(item));
  };

  const consumeWebChatForceNewChatIntent = () => {
    if (!item) return false;
    return consumeWebChatConversationForceNewChat(getConversationKey(item));
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

  const resetCurrentWebChatConversation = () => {
    if (!item) return;
    const key = getConversationKey(item);
    clearTransientComposeStateForItem(item.id);
    webChatIsolatedConversationKeys.add(key);
    chatHistory.set(key, []);
    loadedConversationKeys.add(key);
    markNextWebChatSendAsNewChat();
    primeFreshWebChatPaperChipState();
    if (inputBox && !getInlineEditTarget(body)) {
      inputBox.value = "";
      resizeTextareaToContent(inputBox);
    }
  };

  // In WebChat a paper chat panel is only ever on the paper's WebChat session,
  // never on its ordinary chat: WebChat empties the chat it is on, and the
  // other surface (on an API model) may show that chat. A panel that opens in
  // WebChat on an ordinary chat moves to the WebChat session, as picking a
  // WebChat model does.
  let movingToOwnWebChatSession = false;
  async function moveToOwnWebChatSession(): Promise<void> {
    // The move itself switches the panel; it never starts a second move.
    if (movingToOwnWebChatSession) return;
    movingToOwnWebChatSession = true;
    let anchored = false;
    try {
      anchored = (await ensureWebChatSessionPaperConversation()) === true;
    } finally {
      movingToOwnWebChatSession = false;
    }
    if (!isWebChatMode()) return;
    if (!anchored) {
      await leaveWebChatMode({ restoreConversation: false });
      if (status) setStatus(status, t("Failed to create paper chat"), "error");
      return;
    }
    resetCurrentWebChatConversation();
    refreshChatPreservingScroll();
  }

  const initializeWebChatConversationForCurrentItem = () => {
    if (!item) return;
    const key = getConversationKey(item);
    const hadWebChatSession =
      webChatIsolatedConversationKeys.has(key) && chatHistory.has(key);
    if (
      shouldMoveToOwnWebChatSession({
        conversationKey: key,
        paperMode: isPaperMode(),
        body,
      })
    ) {
      void moveToOwnWebChatSession().catch((err) => {
        appLogger.warn("LLM: Failed to open the WebChat session", err);
      });
      return;
    }
    webChatIsolatedConversationKeys.add(key);
    if (!hadWebChatSession) {
      chatHistory.set(key, []);
    }
    loadedConversationKeys.add(key);
    if (!hadWebChatSession) {
      webChatDraftInputCache.delete(key);
      markNextWebChatSendAsNewChat();
      primeFreshWebChatPaperChipState();
      if (inputBox && !getInlineEditTarget(body)) {
        inputBox.value = "";
        resizeTextareaToContent(inputBox);
      }
    }
  };

  const hasExistingWebChatSessionForCurrentItem = () => {
    if (!item) return false;
    const key = getConversationKey(item);
    return webChatIsolatedConversationKeys.has(key) && chatHistory.has(key);
  };

  // Expose webchat intent clearing via hooks so standalone can call it
  // when loading a conversation from its own sidebar/popup.
  const webChatModeController = createWebChatModeController({
    getItem: () => item,
    isWebChatMode: () => isWebChatMode(),
    getConversationKey,
    getAvailableModelEntries,
    getSelectedModelEntryId: () =>
      getSelectedModelInfo().selectedEntryId || null,
    setSelectedModelEntry: panelChoices.setSelectedModelEntry,
    abortPreload: () => webChatFeature.abortPreload(),
    removePreloadOverlay: () => {
      body.querySelector(".llm-webchat-preload")?.remove();
    },
    stopConnectionCheck: () => webChatFeature.stopConnectionCheck(),
    clearNewChatIntent: clearNextWebChatNewChatIntent,
    applyWebChatModeUI: () => applyWebChatModeUI(),
    updateModelButton: () => updateModelButton(),
    updateReasoningButton: () => updateReasoningButton(),
    readComposerText: () => inputBox?.value || "",
    writeComposerText: (text) => {
      if (!inputBox) return;
      inputBox.value = text;
      resizeTextareaToContent(inputBox);
    },
    switchPaperConversation: async () =>
      (await switchPaperConversation()) === true,
    refreshChatPreservingScroll: () => refreshChatPreservingScroll(),
    resetComposePreviewUI: () => resetComposePreviewUI(),
    log: (message, ...args) => appLogger.warn(message, ...args),
  });
  leaveWebChatMode = webChatModeController.leaveWebChatMode;
  if (hooks) {
    hooks.clearWebChatNewChatIntent = () => {
      clearNextWebChatNewChatIntent();
    };
    hooks.getCurrentModelName = () =>
      getSelectedModelInfo().currentModel || null;
    hooks.leaveWebChatMode = () =>
      leaveWebChatMode({ restoreConversation: false });
  }

  updateReasoningButton = (onlyIfChanged = false) => {
    if (!item || !reasoningBtn) return;
    // [webchat] Hide reasoning dropdown — users control thinking mode on chatgpt.com
    if (isWebChatMode()) {
      if (onlyIfChanged && reasoningBtn.style.display === "none") return;
      withScrollGuard(chatBox, conversationKey, () => {
        reasoningBtn.style.display = "none";
        scheduleResponsiveLayoutSync();
      });
      return;
    }

    const {
      provider,
      currentModel,
      options,
      enabledLevels,
      selectedLevel,
      activeThinking,
    } = getReasoningState();
    const directSelection =
      codexDirectController?.resolveReasoningSelection() || {
        mode: "auto",
        choices: [] as CodexReasoningChoice[],
      };
    const available =
      directSelection.choices.length > 0 || enabledLevels.length > 0;
    const resolvedReasoningLabel = isClaudeConversationSystem()
      ? (() => {
          return getClaudeReasoningDisplayLabel(
            getClaudeReasoningDisplayMode(),
          );
        })()
      : isCodexConversationSystem()
        ? (() => {
            const mode = panelChoices.getCodexReasoningMode();
            return (
              getCodexReasoningChoices().find(
                (choice) => choice.value.toLowerCase() === mode.toLowerCase(),
              )?.label || "Auto"
            );
          })()
        : directSelection.choices.length
          ? directSelection.choices.find(
              (choice) =>
                choice.value.toLowerCase() ===
                directSelection.mode.toLowerCase(),
            )?.label || "Auto"
          : available
            ? getReasoningLevelDisplayLabel(
                selectedLevel as LLMReasoningLevel,
                provider,
                currentModel,
                options,
              )
            : "Not supported";
    const active = Boolean(available && activeThinking);
    const reasoningLabel = resolvedReasoningLabel;
    const reasoningHint =
      reasoningBtn.dataset.reasoningAdjustment ||
      "Click to adjust reasoning level";
    if (
      onlyIfChanged &&
      reasoningBtn.style.display === "" &&
      reasoningBtn.disabled === !item &&
      reasoningBtn.classList.contains("llm-reasoning-btn-unavailable") ===
        !available &&
      reasoningBtn.classList.contains("llm-reasoning-btn-active") === active &&
      reasoningBtn.dataset.reasoningLabel === reasoningLabel &&
      reasoningBtn.dataset.reasoningHint === reasoningHint
    )
      return;
    withScrollGuard(chatBox, conversationKey, () => {
      reasoningBtn.style.display = "";
      reasoningBtn.disabled = !item;
      reasoningBtn.classList.toggle(
        "llm-reasoning-btn-unavailable",
        !available,
      );
      reasoningBtn.classList.toggle("llm-reasoning-btn-active", active);
      reasoningBtn.style.background = "";
      reasoningBtn.style.borderColor = "";
      reasoningBtn.style.color = "";
      reasoningBtn.dataset.reasoningLabel = reasoningLabel;
      reasoningBtn.dataset.reasoningHint = reasoningHint;
      scheduleResponsiveLayoutSync();
    });
  };

  const appendReasoningChoiceButtons = (params: {
    menu: HTMLDivElement;
    choices: CodexReasoningChoice[];
    currentValue: string;
    onSelect: (value: string) => void;
    disabled?: boolean;
  }) => {
    for (const choice of params.choices) {
      const option = createElement(
        body.ownerDocument as Document,
        "button",
        "llm-response-menu-item llm-reasoning-option",
        {
          type: "button",
          textContent: choice.label,
        },
      );
      option.classList.toggle(
        MENU_OPTION_SELECTED_CLASS,
        params.currentValue.toLowerCase() === choice.value.toLowerCase(),
      );
      const applySelection = (event: Event) => {
        if (!isPrimaryPointerEvent(event) || params.disabled) return;
        event.preventDefault();
        event.stopPropagation();
        params.onSelect(choice.value);
      };
      if (params.disabled) {
        option.disabled = true;
        option.classList.add("llm-reasoning-option-disabled");
      } else {
        option.addEventListener("pointerdown", applySelection);
        option.addEventListener("click", applySelection);
      }
      params.menu.appendChild(option);
    }
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
      const currentSel =
        selectedReasoningCache.get(
          reasoningCacheKey(selectionSurface(), item.id),
        ) || "none";
      for (const mode of WEBCHAT_MODES) {
        const isSelected = currentSel === mode.level;
        const option = createElement(
          body.ownerDocument as Document,
          "button",
          "llm-response-menu-item llm-reasoning-option",
          {
            type: "button",
            textContent: mode.label,
          },
        );
        option.classList.toggle(MENU_OPTION_SELECTED_CLASS, isSelected);
        const applyMode = (e: Event) => {
          if (!isPrimaryPointerEvent(e)) return;
          e.preventDefault();
          e.stopPropagation();
          if (!item) return;
          if (isClaudeConversationSystem()) {
            clearClaudeReasoningDisplayOverride();
            panelChoices.setClaudeReasoningMode(
              mode.level === "none" ? "auto" : (mode.level as any),
            );
          } else {
            const reasoningKey = reasoningCacheKey(selectionSurface(), item.id);
            clearSelectedReasoningForSurface(selectionSurface());
            selectedReasoningCache.set(reasoningKey, mode.level as any);
            selectedReasoningProviderCache.set(reasoningKey, "unsupported");
            panelChoices.setLastUsedReasoningLevel(mode.level as any);
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
            textContent: mode.label,
          },
        );
        option.classList.toggle(
          MENU_OPTION_SELECTED_CLASS,
          currentMode === mode.value,
        );
        const applyClaudeSelection = (e: Event) => {
          if (!isPrimaryPointerEvent(e)) return;
          e.preventDefault();
          e.stopPropagation();
          if (!item) return;
          clearClaudeReasoningDisplayOverride();
          panelChoices.setClaudeReasoningMode(mode.value as any);
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
      const codexModes = getCodexReasoningChoices();
      const currentMode = panelChoices.getCodexReasoningMode();
      appendReasoningChoiceButtons({
        menu: reasoningMenu,
        choices: codexModes,
        currentValue: currentMode,
        onSelect: (value) => {
          panelChoices.setCodexReasoningMode(value);
          setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
          updateReasoningButton();
        },
      });
      return;
    }
    if (
      codexDirectController?.appendReasoningChoices({
        menu: reasoningMenu,
        renderChoices: appendReasoningChoiceButtons,
        closeMenu: () => {
          setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
        },
      })
    ) {
      return;
    }
    if (!enabledLevels.length) {
      const unavailable = createElement(
        body.ownerDocument as Document,
        "button",
        "llm-response-menu-item llm-reasoning-option",
        {
          type: "button",
          textContent: "Not supported",
        },
      );
      unavailable.disabled = true;
      reasoningMenu.appendChild(unavailable);
      return;
    }
    for (const optionState of options) {
      const level = optionState.level;
      const option = createElement(
        body.ownerDocument as Document,
        "button",
        "llm-response-menu-item llm-reasoning-option",
        {
          type: "button",
          textContent: getReasoningLevelDisplayLabel(
            level,
            provider,
            currentModel,
            options,
          ),
        },
      );
      option.classList.toggle(
        MENU_OPTION_SELECTED_CLASS,
        selectedLevel === level,
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
            panelChoices.setClaudeReasoningMode(nextMode as any);
          } else {
            if (reasoningBtn) delete reasoningBtn.dataset.reasoningAdjustment;
            const reasoningKey = reasoningCacheKey(selectionSurface(), item.id);
            clearSelectedReasoningForSurface(selectionSurface());
            selectedReasoningCache.set(reasoningKey, level);
            selectedReasoningProviderCache.set(
              reasoningKey,
              provider === "unsupported" ? "customized" : provider,
            );
            panelChoices.setLastUsedReasoningLevelForProvider(provider, level);
            if (provider !== "anthropic") {
              panelChoices.setLastUsedReasoningLevel(level);
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

  const syncModelFromPrefs = (onlyIfChanged = false) => {
    updateModelButton(onlyIfChanged);
    updateReasoningButton(onlyIfChanged);
    if (isFloatingMenuOpen(modelMenu)) {
      rebuildModelMenu();
    }
    if (isFloatingMenuOpen(reasoningMenu)) {
      rebuildReasoningMenu();
    }
  };

  cleanupModelCapabilitySubscription = subscribeModelCapabilities(() => {
    if (setupHandlersCleaned) return;
    syncModelFromPrefs();
  });
  // Settings edits to the saved providers: update the model and reasoning
  // controls in place (chat.ts rebuilds the chat only when needed).
  cleanupModelProviderSync = registerContextPanelModelSync(body, () => {
    if (setupHandlersCleaned) return;
    syncModelFromPrefs(true);
  });
  codexDirectController = createCodexDirectModelReasoningController({
    getSelectedEntry: () =>
      item ? panelChoices.getSelectedModelEntry() : null,
    isRuntimeConversationSystem,
    onStateChange: syncModelFromPrefs,
    getReasoningSelection: panelChoices.getCodexDirectReasoningSelection,
    setReasoningSelection: panelChoices.setCodexDirectReasoningSelection,
  });

  let setupHandlersCleaned = false;
  // Set once the panel's context actions are wired, further below.
  let addItemsAsDefaultContextForHandle: (
    zoteroItems: Zotero.Item[],
  ) => Promise<void> = async () => undefined;
  // Latest in-place paper switch; only it may re-enable the chat box.
  let paperItemSwitchToken = 0;
  let conversationInPlaceSwitchToken = 0;
  const conversationSwitchInputLock = chatBox
    ? createChatInputLock(chatBox)
    : null;
  /** See standaloneConversationSwitch.ts. */
  const resolveConversationSwitchForPanel = (
    nextItem: Zotero.Item,
  ): StandaloneConversationSwitchDecision => {
    const currentKind = item ? resolveDisplayConversationKind(item) : null;
    const nextKind = resolveDisplayConversationKind(nextItem);
    const panelAlive =
      !setupHandlersCleaned && Boolean(item) && panelRoot.isConnected;
    if (panelAlive && (!currentKind || !nextKind)) {
      return { inPlace: false, reason: "mode-changed" };
    }
    const kindOrGlobal = (kind: "global" | "paper" | null) =>
      kind === "paper" ? "paper" : "global";
    const nextBasePaper =
      nextKind === "paper" ? resolveConversationBaseItem(nextItem) : null;
    const currentBasePaper =
      currentKind === "paper" ? resolveCurrentPaperBaseItem() : null;
    return resolveStandaloneConversationSwitch({
      panelAlive,
      standalonePanel: isStandalonePanel,
      sidePanel: isSidePanel,
      ownershipBlocked: Boolean(panelRoot.dataset.ownershipBlocked),
      webChat: isWebChatModeActive(),
      runtimeSwitchInFlight: runtimeSystemSwitchInFlight,
      inlineEditOpen: Boolean(getInlineEditTarget(body)),
      current: {
        system: currentConversationSystem,
        kind: kindOrGlobal(currentKind),
        libraryID: getCurrentLibraryID(),
        basePaperItemID: Number(currentBasePaper?.id || 0),
        isNote: isNoteSession(),
      },
      next: {
        system: resolveConversationSystemForItem(nextItem) || "upstream",
        kind: kindOrGlobal(nextKind),
        libraryID: Number(nextItem.libraryID || 0),
        basePaperItemID: Number(nextBasePaper?.id || 0),
        isNote: Boolean(resolveActiveNoteSession(nextItem)),
      },
    });
  };
  const panelHandle: PanelHandle = {
    addItemsAsDefaultContext: (zoteroItems) =>
      addItemsAsDefaultContextForHandle(zoteroItems),
    addTextContext: (text, options) => {
      const textContextKey = getTextContextConversationKey();
      if (setupHandlersCleaned || !item || !textContextKey) return false;
      let outcome = "empty" as ReturnType<typeof addSelectedTextContext>;
      withScrollGuard(chatBox, conversationKey, () => {
        outcome = addSelectedTextContext(body, textContextKey, text, {
          source: options.source,
          focusInput: options.focusInput,
        });
      });
      const question = String(options.question || "").trim();
      const questionSet =
        Boolean(question) &&
        (outcome === "added" || outcome === "duplicate") &&
        updateSelectedTextContextQueryForItem(
          textContextKey,
          text,
          options.source,
          null,
          question,
        );
      if (outcome !== "added" && !questionSet) return false;
      updateSelectedTextPreviewPreservingScroll();
      return outcome === "added";
    },
    refreshContextSourceForCurrentItem: () => {
      withScrollGuard(chatBox, conversationKey, () => {
        refreshAutoLoadedPaperContextForCurrentItem();
        updatePaperPreviewPreservingScroll();
        syncModelFromPrefs();
        flushResponsiveLayoutSyncNow();
        flushPanelStateRefreshNow();
        if (item && chatBox && !chatBox.childElementCount) {
          refreshChat(body, item);
        }
      });
    },
    applyResolvedClaudeEffort: applyClaudeResolvedReasoningDisplay,
    switchToPaperItem: (nextItem, nextBasePaperItem, rebuild) => {
      // Only the plain paper-chat case moves in place. Notes, WebChat, the
      // standalone window, an open inline edit, a runtime switch in flight,
      // or a change of mode or runtime all keep the full remount.
      if (
        setupHandlersCleaned ||
        isStandalonePanel ||
        isSidePanel ||
        !item ||
        !panelRoot.isConnected ||
        panelRoot.dataset.ownershipBlocked ||
        !isPaperMode() ||
        isNoteSession() ||
        isWebChatModeActive() ||
        runtimeSystemSwitchInFlight ||
        getInlineEditTarget(body) ||
        resolveActiveNoteSession(nextItem) ||
        resolveDisplayConversationKind(nextItem) !== "paper" ||
        (resolveConversationSystemForItem(nextItem) || "upstream") !==
          currentConversationSystem
      ) {
        return false;
      }
      const lease = capturePanelOperationLease(body);
      if (!lease) return false;
      persistDraftInputForCurrentConversation({ resize: false });
      // The host is already bound to the next paper, so the mounted scope is
      // written before syncConversationIdentity runs its ownership check.
      item = nextItem;
      basePaperItem =
        nextBasePaperItem || resolveConversationBaseItem(nextItem);
      const nextKey = getConversationKey(nextItem);
      panelRoot.dataset.itemId = nextKey > 0 ? `${nextKey}` : "";
      panelRoot.dataset.libraryId = nextItem.libraryID
        ? `${nextItem.libraryID}`
        : "";
      panelRoot.dataset.conversationKind = "paper";
      panelRoot.dataset.conversationSystem = currentConversationSystem;
      const nextBaseId = Number(basePaperItem?.id || 0);
      panelRoot.dataset.basePaperItemId = nextBaseId > 0 ? `${nextBaseId}` : "";
      clearAutoLoadedContextSnapshot();
      syncConversationIdentity();
      // Before switchPaperConversation persists the composer as this paper's
      // draft, the composer must hold this paper's draft, not the last one's.
      restoreDraftInputForCurrentConversation();
      // The composer's chips are per paper: show this paper's at once, so
      // send and chip removal never act on chips the last paper left behind.
      resetComposePreviewUI();
      flushPanelStateRefreshNow();
      syncRequestUiForCurrentConversation();
      if (status) setStatus(status, t("Ready"), "ready");
      // The previous paper's messages stay on screen until the next paper's
      // chat is drawn; they must not take input meanwhile.
      const switchToken = ++paperItemSwitchToken;
      const chatDrawsAtSwitch = chatDrawCount;
      chatBox?.setAttribute("inert", "");
      void runInPlacePaperSwitch({
        isLatest: () =>
          switchToken === paperItemSwitchToken &&
          !setupHandlersCleaned &&
          body.querySelector("#llm-main") === panelRoot,
        switchConversation: async () =>
          (await switchPaperConversation()) === true,
        canDrawFallback: () =>
          item === nextItem && isPanelOperationLeaseCurrent(lease),
        drawFallback: async () => {
          await ensureConversationLoaded(nextItem, { body });
          if (item !== nextItem || !isPanelOperationLeaseCurrent(lease)) {
            return false;
          }
          restoreDraftInputForCurrentConversation();
          refreshChatPreservingScroll();
          resetComposePreviewUI();
          return true;
        },
        // The user opened another conversation (history, Library chat) and
        // it was drawn; leave it alone.
        movedToOtherConversation: () =>
          item !== nextItem && chatDrawCount !== chatDrawsAtSwitch,
        // Nothing drew this paper's chat, so the last paper's messages must
        // not stay under this paper's identity. Show the same restoring state
        // a full rebuild starts from, then rebuild: Zotero already rendered
        // this paper and sends no further render that would.
        clearUndrawn: () => {
          renderPanelOwnershipBlocked(
            body,
            "paper-switch-in-place",
            "unresolved",
          );
          clearCompletedPanelLifecycleSignature(body);
        },
        rebuild,
        release: () => {
          chatBox?.removeAttribute("inert");
        },
        onError: (err) => {
          appLogger.warn("LLM: in-place paper switch failed", err);
        },
      });
      return true;
    },
    resolveConversationSwitch: (nextItem) =>
      resolveConversationSwitchForPanel(nextItem),
    switchConversationInPlace: async (nextItem) => {
      if (!resolveConversationSwitchForPanel(nextItem).inPlace) return false;
      const nextKey = getConversationKey(nextItem);
      if (!Number.isFinite(nextKey) || nextKey <= 0) return false;
      const isGlobal = resolveDisplayConversationKind(nextItem) === "global";
      // The last conversation's messages stay on screen until the next one is
      // drawn; they must not take input meanwhile (retry/edit would act on
      // the next conversation's history). Only the latest switch clears it.
      // (Not `inert`: that restyles every message of a long chat.)
      const switchToken = ++conversationInPlaceSwitchToken;
      conversationSwitchInputLock?.lock();
      try {
        const switched = isGlobal
          ? await switchGlobalConversation(nextKey, { quietHistory: true })
          : (await switchPaperConversation(nextKey, {
              paperItem:
                resolveConversationBaseItem(nextItem) ||
                resolveCurrentPaperBaseItem(),
              quietHistory: true,
            })) === true;
        if (
          switched &&
          status &&
          switchToken === conversationInPlaceSwitchToken
        ) {
          // Status writes reach only panels showing the request's
          // conversation, so the last conversation's status would linger.
          // Start from the text a fresh mount shows, then let this
          // conversation's own request state (if any) take over.
          setStatus(
            status,
            isGlobal
              ? t("No active paper context. Type / to add papers.")
              : t("Ready"),
            "ready",
          );
          syncRequestUiForCurrentConversation();
        }
        return switched;
      } finally {
        if (switchToken === conversationInPlaceSwitchToken) {
          conversationSwitchInputLock?.unlock();
        }
      }
    },
  };
  publishPanelHandle(body, panelHandle);

  const webChatHistoryController = createWebChatHistoryController({
    body,
    historyMenu,
    getItem: () => item,
    getSelectedModelInfo,
    closeHistoryMenu,
    getConversationKey,
    setConversationHistory: (conversationKey, messages) => {
      webChatIsolatedConversationKeys.add(conversationKey);
      chatHistory.set(conversationKey, messages);
      loadedConversationKeys.add(conversationKey);
    },
    refreshChatPreservingScroll,
    isWebChatMode,
    clearNextWebChatNewChatIntent,
    setSelectedReasoningLevel: (itemId, level) => {
      selectedReasoningCache.set(
        reasoningCacheKey(selectionSurface(), itemId),
        level,
      );
    },
    setSelectedReasoningProvider: (itemId, provider) => {
      selectedReasoningProviderCache.set(
        reasoningCacheKey(selectionSurface(), itemId),
        provider,
      );
    },
    updateReasoningButton,
    setStatusMessage: status
      ? (message, level) => {
          setStatus(status, message, level);
        }
      : undefined,
    log: (message, ...args) => {
      appLogger.debug(message, ...args);
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
        const lastId = panelChoices.getModelEntryId();
        const entry = lastId ? getModelEntryById(lastId) : null;
        isWebChat = entry?.authMode === "webchat";
      } catch {
        return;
      }
    }

    panelRoot.dataset.webchatMode = isWebChat ? "true" : "false";
    syncQueuedFollowUpRegistration();

    // Mode controls: WebChat takes the paper slot, with its connection dot,
    // in the Independent tab and the Stacked chip (which names the site), and
    // both stay static until WebChat exits.
    if (paperChatTabBtn) {
      if (isWebChat) {
        let webchatTabTitle = "WebChat Sync";
        let webchatChipLabel = "chatgpt";
        try {
          const { currentModel } = getSelectedModelInfo();
          const { getWebChatTargetByModelName } =
            require("../../webchat/types") as typeof import("../../webchat/types");
          const entry = getWebChatTargetByModelName(currentModel || "");
          if (entry) {
            webchatTabTitle = `${entry.label} Web Sync (${entry.modelName})`;
            webchatChipLabel = entry.displayName;
          }
        } catch {
          /* fallback to defaults */
        }
        webChatModeTabTitle = webchatTabTitle;
        webChatModeChipLabel = webchatChipLabel;

        let dot = paperChatTabBtn.querySelector(
          ".llm-webchat-dot",
        ) as HTMLElement | null;
        if (!dot) {
          dot = (paperChatTabBtn.ownerDocument as Document).createElement(
            "span",
          );
          dot.className = "llm-webchat-dot llm-webchat-dot-disconnected";
        }
        paperChatTabBtn.prepend(dot);
        const modeSwitchDot = showSidebarModeSwitchDot(modeSwitch);
        syncChatModeTabs();
        webChatFeature.startConnectionCheck(dot, modeSwitchDot);
      } else {
        webChatModeTabTitle = "";
        webChatModeChipLabel = "";
        const oldDot = paperChatTabBtn.querySelector(".llm-webchat-dot");
        if (oldDot) {
          oldDot.remove();
        }
        removeSidebarModeSwitchDot(modeSwitch);
        webChatFeature.stopConnectionCheck();
        syncChatModeTabs();
      }
    }

    // [webchat] Pre-fetch history in background so it's ready when user clicks
    if (isWebChat && !hasExistingWebChatSessionForCurrentItem()) {
      void warmUpWebChatHistory();
    }

    // The conversation trash action becomes "Exit" only in WebChat.
    if (clearBtn) {
      if (isWebChat) {
        clearBtn.textContent = "Exit";
        (clearBtn as HTMLButtonElement).disabled = false;
        clearBtn.style.opacity = "";
        clearBtn.title = t("Exit webchat and return to previous model");
        clearBtn.setAttribute(
          "aria-label",
          t("Exit webchat and return to previous model"),
        );
      } else {
        clearBtn.textContent = "";
        clearBtn.title = t("Delete conversation");
        clearBtn.setAttribute("aria-label", t("Delete conversation"));
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
    updateRuntimeSystemToggles();

    // Notify standalone window (or other listeners) of webchat mode change
    hooks?.onWebChatModeChanged?.(isWebChat);
    syncRequestUiForCurrentConversation();
  };

  // Initialize model and preview state.  Keep panel-state DOM refresh queued
  // until setup-local helpers are ready, then flush once.
  refreshAutoLoadedPaperContextForCurrentItem();
  syncModelFromPrefs();
  flushResponsiveLayoutSyncNow();
  // Set active_target before applyWebChatModeUI so sidebar filters by the correct site
  webChatFeature.primeColdStartTarget();
  applyWebChatModeUI();
  resetComposePreviewUI();
  flushPanelStateRefreshNow();
  // [webchat] Cold startup → show preload screen so user knows they're in webchat mode
  webChatFeature.mount(handlerContext);
  restoreDraftInputForCurrentConversation();
  if (isWebChatMode()) {
    initializeWebChatConversationForCurrentItem();
    refreshChatPreservingScroll();
  } else if (isPaperMode()) {
    // In the standalone window, mountChatPanel's own async IIFE handles
    // conversation loading.  The parameter-less auto-fire would race with it
    // and resolve to a different (default) conversation, overwriting the
    // explicitly targeted one.
    // A side chat's mount controller owns its ephemeral conversation too.
    if (!isStandalonePanel && !isSidePanel) {
      void switchPaperConversation().catch((err) => {
        appLogger.warn(
          "LLM: Failed to restore paper conversation session",
          err,
        );
      });
    }
  } else {
    void refreshGlobalHistoryHeader();
  }

  // Preferences can change outside this panel. Returning from the paper only
  // needs to reconcile changed model/reasoning controls: rebuilding unchanged
  // previews and remeasuring the draft transiently resizes the chat viewport.
  // In particular, do not apply a stored scroll snapshot on an unchanged hover.
  // Conversation/context mutations already request their own panel-state sync.
  body.addEventListener("pointerenter", () => {
    syncModelFromPrefs(true);
    // Another view of this conversation can edit the shared draft. Restore
    // that change without remeasuring an unchanged composer on every visit.
    if (item && inputBox && !getInlineEditTarget(body)) {
      const cache = isWebChatModeActive()
        ? webChatDraftInputCache
        : draftInputCache;
      if (inputBox.value !== (cache.get(getConversationKey(item)) || "")) {
        runWithChatScrollGuard(restoreDraftInputForCurrentConversation);
      }
    }
  });
  const ResizeObserverCtor = body.ownerDocument?.defaultView?.ResizeObserver;
  if (ResizeObserverCtor && panelRoot && modelBtn) {
    const ro = new ResizeObserverCtor(() => {
      // Keep layout mutations on the guarded scheduler so resize callbacks
      // stay cheap during sidebar drags.
      scheduleResponsiveLayoutSync();
    });
    panelLifecycle.add(() => ro.disconnect());
    ro.observe(panelRoot);
    if (actionsRow) ro.observe(actionsRow);
    if (actionsLeft) ro.observe(actionsLeft);
    if (headerTop) ro.observe(headerTop);
    for (const element of Array.from(
      headerTop?.querySelectorAll(
        ".llm-header-nav-row, .llm-runtime-system-controls",
      ) || [],
    ))
      ro.observe(element as Element);
  }

  function getSelectedProfile() {
    if (!item) return null;
    const selected = isClaudeConversationSystem()
      ? getSelectedClaudeRuntimeEntry()
      : isCodexConversationSystem()
        ? getSelectedCodexRuntimeEntry()
        : panelChoices.getSelectedModelEntry();
    if (!selected) return null;
    return {
      ...selected,
      profileOverride: selected.advanced?.profileOverride as
        | ModelProfileOverride
        | undefined,
    };
  }

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
      const mode =
        codexModelCatalogStatus === "ready"
          ? reconcileSelectedCodexReasoningMode()
          : panelChoices.getCodexReasoningMode();
      return buildCodexAppServerReasoningConfig(mode);
    }
    const directEntry = codexDirectController?.getSelectedEntry();
    if (directEntry) {
      return codexDirectController?.getSendReasoning();
    }
    const { provider, enabledLevels, selectedLevel } = getReasoningState();
    if (!enabledLevels.length) return undefined;
    if (!enabledLevels.includes(selectedLevel as LLMReasoningLevel)) {
      return undefined;
    }
    return {
      provider: provider === "unsupported" ? "customized" : provider,
      level: selectedLevel as LLMReasoningLevel,
    };
  };

  const { processIncomingFiles } = createFileIntakeController({
    body,
    getItem: () => item,
    captureOwnership: (ownedItem, operation) => {
      if (!requireCurrentPanelOwnership(body, ownedItem, operation)) {
        return null;
      }
      const lease = capturePanelOperationLease(body);
      if (!lease) return null;
      return () =>
        isPanelOperationLeaseCurrent(lease) &&
        requireCurrentPanelOwnership(body, ownedItem, `${operation}-commit`);
    },
    getCurrentModel: () => getSelectedModelInfo().currentModel,
    getCurrentPdfSupport: () => {
      const profile = getSelectedProfile();
      const modelName = (
        profile?.model ||
        getSelectedModelInfo().currentModel ||
        ""
      ).trim();
      const inputMode = getAdvancedModelParamsForEntry(
        profile?.entryId,
      )?.inputMode;
      return getModelPdfSupport(
        modelName,
        profile?.providerProtocol,
        profile?.authMode,
        profile?.apiBase,
        inputMode,
      );
    },
    isScreenshotUnsupportedModel: (modelName) => {
      const profile = getSelectedProfile();
      const inputMode = getAdvancedModelParamsForEntry(
        profile?.entryId,
      )?.inputMode;
      return isScreenshotUnsupportedModel(
        (profile?.model || modelName || "").trim(),
        profile?.providerProtocol,
        profile?.authMode,
        profile?.apiBase,
        inputMode,
      );
    },
    optimizeImageDataUrl,
    persistAttachmentBlob,
    selectedImageCache: composeContextStore.images,
    selectedFileAttachmentCache: composeContextStore.files,
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
      appLogger.debug(message, ...args);
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
  const getActiveActionToken = (): ActiveActionToken | null => {
    const caretEnd =
      typeof inputBox.selectionStart === "number"
        ? inputBox.selectionStart
        : inputBox.value.length;
    const slashToken = parsePaperSearchSlashToken(inputBox.value, caretEnd);
    const dollarToken = parseSkillSearchDollarToken(inputBox.value, caretEnd);
    if (slashToken && dollarToken) {
      return slashToken.slashStart > dollarToken.slashStart
        ? { ...slashToken, trigger: "/" }
        : { ...dollarToken, trigger: "$" };
    }
    if (dollarToken) return { ...dollarToken, trigger: "$" };
    if (slashToken) return { ...slashToken, trigger: "/" };
    return null;
  };
  let doSend: (options?: SendFlowOptions) => Promise<void> = async () => {};

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
    // Lets a long batched action publish its abort controller under the
    // active conversation, so the panel's stop button cancels it.
    getConversationKey: () => (item ? getConversationKey(item) : null),
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
      appLogger.debug(message, error);
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
  menus.register("slash", closeSlashMenu);
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

    inputBox.addEventListener("input", () => {
      noteQuoteValidationUserActivity(500);
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

    // Draft restoration happens before handlers are attached.
    resizeTextareaToContent(inputBox);
  }

  const resetComposerInputHeight = (): void => {
    clearManualTextareaHeight(inputBox);
    resizeTextareaToContent(inputBox);
  };

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

  queueFollowUpInput = (text, options) => {
    const nextQueue = enqueueQueuedFollowUp(getQueuedFollowUpThreadKey(), text);
    if (!nextQueue.length) return false;
    // Text that did not come from the composer must not erase its draft.
    if (!options?.preserveInputDraft) {
      inputBox.value = "";
      persistDraftInputForCurrentConversation();
    }
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
    return true;
  };

  syncRequestUiForCurrentConversation();
  const pdfPaperResolver = createPdfPaperAttachmentResolver({
    logError: (message, ...args) => {
      appLogger.debug(message, ...args);
    },
  });
  const localPdfResourceResolver = createLocalPdfResourceResolver();

  const sendFlowController = createSendFlowController({
    body,
    inputBox,
    getItem: () => item,
    requireCurrentOwnership: (candidateItem, operation) =>
      requireCurrentPanelOwnership(body, candidateItem, operation),
    beginRequest: beginPanelRequest,
    isRequestOwner,
    finishRequest: finishPanelRequest,
    queueFollowUpInput: (text, options) => queueFollowUpInput(text, options),
    resolveContextSource: resolveAutoLoadedContextSourceAsync,
    closeSlashMenu,
    closePaperPicker,
    getSelectedTextContextEntries,
    resolveSelectedTextAnchors,
    getSelectedPaperContexts: (itemId) =>
      getManualPaperContextsForItem(
        itemId,
        item && item.id === itemId ? resolveAutoLoadedPaperContext() : null,
      ).map((paperContext) =>
        withResolvedPaperContentSourceMode(itemId, paperContext),
      ),
    getSelectedCollectionContexts: (itemId) =>
      selectedCollectionContextCache.get(itemId) || [],
    getSelectedTagContexts: (itemId) =>
      selectedTagContextCache.get(itemId) || [],
    getAttachedConversations: (itemId) =>
      composeContextStore.attachedConversations.list(itemId),
    clearAttachedConversations: (itemId) => {
      composeContextStore.attachedConversations.delete(itemId);
    },
    getFullTextPaperContexts: (currentItem, selectedPaperContexts) =>
      getEffectiveFullTextPaperContexts(currentItem, selectedPaperContexts),
    getPdfModePaperContexts: (currentItem, selectedPaperContexts) =>
      getEffectivePdfModePaperContexts(currentItem, selectedPaperContexts),
    hasActivePdfFullTextPapers: (
      currentItem: Zotero.Item,
      selectedPaperContexts?: any[],
    ) => hasActivePdfFullTextPapers(currentItem, selectedPaperContexts),
    getActiveWebChatPdfPaperContexts: (
      currentItem: Zotero.Item,
      selectedPaperContexts?: PaperContextRef[],
    ) => getActiveWebChatPdfPaperContexts(currentItem, selectedPaperContexts),
    resolvePaperContextNextSendMode,
    setPaperModeOverride,
    resolvePdfPaperAttachments: pdfPaperResolver.resolvePdfPaperAttachments,
    resolveLocalPdfResources: localPdfResourceResolver.resolve,
    preflightLocalPdfCapability: async () => {
      const { preflightClaudeBridgeLocalPdfCapability } =
        await import("../../agent/externalBackendBridge");
      await preflightClaudeBridgeLocalPdfCapability();
    },
    renderPdfPagesAsImages: pdfPaperResolver.renderPdfPagesAsImages,
    getModelPdfSupport: (modelName, protocol, authMode, apiBase, inputMode) =>
      resolvePaperPdfSupportForConversation({
        basePdfSupport: getModelPdfSupport(
          modelName,
          protocol,
          authMode,
          apiBase,
          inputMode,
        ),
        isClaudeCode: isClaudeConversationSystem(),
        isCodex: isCodexConversationSystem(),
      }),
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
    getConversationWriteGeneration,
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
    sendQuestion: async (opts) => {
      const workflowTestSendInterceptor = getWorkflowTestSendInterceptor();
      if (workflowTestSendInterceptor) {
        const continueToModelBoundary = await workflowTestSendInterceptor(opts);
        if (continueToModelBoundary !== true) return;
      }
      await sendQuestion(opts);
    },
    retainClaudeRuntime: async (sendBody, sendItem) => {
      await retainClaudeRuntimeForBody(sendBody, sendItem);
    },
    retainPinnedImageState,
    retainPaperState,
    consumePaperModeState,
    consumeWebChatForceNewChatIntent,
    markWebChatForceNewChatIntent: () => markNextWebChatSendAsNewChat(),
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
    // The library lock keeps the sidebar panels on a Library chat while it
    // answers. The standalone window does not follow the selection in Library
    // chat, so its sends neither take nor release that lock.
    autoLockGlobalChat: () => {
      if (isRuntimeConversationSystem()) return;
      if (isStandaloneSelectionSurface()) return;
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
      if (isStandaloneSelectionSurface()) return;
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
    onSendSettled:
      __env__ === "test" ? notifyWorkflowTestSendSettled : undefined,
    setStatusMessage: status
      ? (message, level) => {
          setStatus(status, message, level);
        }
      : undefined,
    editStaleStatusText: EDIT_STALE_STATUS_TEXT,
    onComposerDraftCleared: resetComposerInputHeight,
    onComposerDraftRestored: resetComposerInputHeight,
    consumeForcedSkillIds,
  });
  doSend = sendFlowController.doSend;
  // The header trash action uses the same durable, undoable deletion
  // lifecycle as Delete in conversation history.
  const executeSend = async () => {
    // If the inline edit widget is active, route through editUserTurnAndRetry
    // instead of the normal send flow.
    const panelEditTarget = getInlineEditTarget(body);
    if (panelEditTarget && item) {
      const currentItem = item;
      const editTarget = panelEditTarget;
      const composerText = inputBox?.value.trim() ?? "";
      // Read the chips now: endInlineEdit strips their questions below.
      const textContextKey = getTextContextConversationKey();
      const selectedContexts = textContextKey
        ? getSelectedTextContextEntries(textContextKey)
        : [];
      // An empty composer still edits the turn when the chips carry questions.
      const newText = resolveInlineEditSubmitText(
        composerText,
        selectedContexts,
      );
      if (!newText && isRequestPending(getConversationKey(currentItem))) return;
      const inlineRequest = newText
        ? beginPanelRequest(body, currentItem, "Preparing edited retry...")
        : null;
      if (newText && !inlineRequest) return;
      let providerDispatchStarted = false;
      if (inlineRequest) {
        inputBox.value = "";
        persistDraftInputForCurrentConversation();
        resetComposerInputHeight();
      }
      const finishInlineRequest = () => {
        if (!inlineRequest) return;
        // The conversation key can change mid-flight (editUserTurnAndRetry
        // transfers the claim after ensureConversationLoaded). Mirror the
        // send controller's finally: finish under the current key, then fall
        // back to the key the claim was taken under so it never strands.
        const currentConversationKey = getConversationKey(currentItem);
        const finished = finishPanelRequest(
          body,
          currentItem,
          currentConversationKey,
          inlineRequest.requestId,
        );
        if (
          !finished &&
          currentConversationKey !== inlineRequest.conversationKey
        ) {
          finishPanelRequest(
            body,
            currentItem,
            inlineRequest.conversationKey,
            inlineRequest.requestId,
          );
        }
        if (!providerDispatchStarted) {
          inputBox.value = composerText;
          persistDraftInputForCurrentConversation();
          resetComposerInputHeight();
          // A refused chip-question edit gets its questions back: endInlineEdit
          // stripped them, and the composer holds nothing to retry with.
          if (!composerText && textContextKey) {
            setSelectedTextContextEntries(textContextKey, selectedContexts);
            updateSelectedTextPreviewPreservingScroll();
          }
        }
      };
      const {
        selectedTexts,
        selectedTextSources,
        selectedTextPaperContexts,
        selectedTextNoteContexts,
        selectedCollectionContexts,
        selectedTagContexts,
        attachedConversations,
      } = buildInlineEditRetryContextSnapshot({
        selectedContexts,
        selectedCollectionContexts: selectedCollectionContextCache.get(
          currentItem.id,
        ),
        selectedTagContexts: selectedTagContextCache.get(currentItem.id),
        attachedConversations: composeContextStore.attachedConversations.list(
          currentItem.id,
        ),
      });
      const contextSource = await resolveAutoLoadedContextSourceAsync().catch(
        (error) => {
          finishInlineRequest();
          throw error;
        },
      );
      const allPaperContexts = getManualPaperContextsForItem(
        currentItem.id,
        currentItem.id === item?.id ? resolveAutoLoadedPaperContext() : null,
      );
      // The original plugin agent keeps text/MinerU behavior; Claude Code can
      // explicitly receive raw PDF paths.
      const isAgent = getCurrentRuntimeMode() === "agent";
      const pdfModePapers =
        isAgent && !isClaudeConversationSystem()
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
      const advancedParams = getAdvancedModelParams(selectedProfile?.entryId);
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
            appLogger.debug(message, ...args);
          },
          isScreenshotUnsupportedModel,
          getModelPdfSupport: (
            modelName,
            protocol,
            authMode,
            apiBase,
            inputMode,
          ) =>
            resolvePaperPdfSupportForConversation({
              basePdfSupport: getModelPdfSupport(
                modelName,
                protocol,
                authMode,
                apiBase,
                inputMode,
              ),
              isClaudeCode: isClaudeConversationSystem(),
              isCodex: isCodexConversationSystem(),
            }),
          resolvePdfPaperAttachments:
            pdfPaperResolver.resolvePdfPaperAttachments,
          resolveLocalPdfResources: localPdfResourceResolver.resolve,
          renderPdfPagesAsImages: pdfPaperResolver.renderPdfPagesAsImages,
          uploadPdfForProvider: pdfPaperResolver.uploadPdfForProvider,
          resolvePdfBytes: pdfPaperResolver.resolvePdfBytes,
        },
        paperContexts: pdfModePapers,
        selectedBaseFiles: baseSelectedFiles,
        selectedImageCountForBudget: isScreenshotUnsupportedModel(
          activeModelName,
          selectedProfile?.providerProtocol,
          selectedProfile?.authMode,
          selectedProfile?.apiBase,
          advancedParams?.inputMode,
        )
          ? 0
          : selectedImages.length,
        profile: selectedProfile
          ? { ...selectedProfile, inputMode: advancedParams?.inputMode }
          : null,
        currentModelName: activeModelName,
        isWebChat: isWebChatMode(),
      }).catch((error) => {
        finishInlineRequest();
        throw error;
      });
      if (!pdfInputs.ok) {
        finishInlineRequest();
        return;
      }
      const {
        selectedFiles,
        modelFiles,
        pdfPageImageDataUrls,
        pdfUploadSystemMessages,
        localDocuments,
      } = pdfInputs;
      if (localDocuments.length && isClaudeConversationSystem()) {
        try {
          const { preflightClaudeBridgeLocalPdfCapability } =
            await import("../../agent/externalBackendBridge");
          await preflightClaudeBridgeLocalPdfCapability();
        } catch (error) {
          if (status) {
            setStatus(
              status,
              error instanceof Error && error.message.trim()
                ? error.message
                : "Claude bridge does not support raw local PDF paths.",
              "error",
            );
          }
          finishInlineRequest();
          return;
        }
      }
      const images = [
        ...(isScreenshotUnsupportedModel(
          activeModelName,
          selectedProfile?.providerProtocol,
          selectedProfile?.authMode,
          selectedProfile?.apiBase,
          advancedParams?.inputMode,
        )
          ? []
          : selectedImages),
        ...pdfPageImageDataUrls,
      ].slice(0, MAX_SELECTED_IMAGES);
      const selectedReasoning = getSelectedReasoning();
      const targetRuntimeMode = getCurrentRuntimeMode();
      endInlineEdit(body);
      if (newText) {
        const webchatGreyOut = isWebChatMode();
        let retrySucceeded = false;
        try {
          retrySucceeded = await editUserTurnAndRetry({
            body,
            item: currentItem,
            requestId: inlineRequest!.requestId,
            onProviderDispatch: () => {
              providerDispatchStarted = true;
            },
            contextSource,
            userTimestamp: editTarget.userTimestamp,
            assistantTimestamp: editTarget.assistantTimestamp,
            newText,
            selectedTextContexts: selectedContexts,
            selectedTexts,
            selectedTextSources,
            selectedTextPaperContexts,
            selectedTextNoteContexts,
            selectedCollectionContexts,
            selectedTagContexts,
            attachedConversations,
            screenshotImages: images,
            paperContexts: selectedPaperContexts,
            pdfPaperContexts: pdfModePapers,
            fullTextPaperContexts,
            attachments: selectedFiles,
            modelAttachments: modelFiles,
            localDocuments,
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
        } finally {
          finishInlineRequest();
        }
        if (retrySucceeded) {
          consumePaperModeState(currentItem.id, { webchatGreyOut });
          retainPaperState(currentItem.id);
          updatePaperPreviewPreservingScroll();
        }
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
    const clearSubmittedCommandDraft = () => {
      inputBox.value = "";
      const EvtCtor =
        (inputBox.ownerDocument?.defaultView as any)?.Event ?? Event;
      inputBox.dispatchEvent(new EvtCtor("input", { bubbles: true }));
      persistDraftInputForCurrentConversation();
    };
    // Intercept command chip: if a command chip is active, route to action execution
    const chipAction = getActiveCommandAction();
    if (chipAction) {
      const params = inputBox?.value?.trim() ?? "";
      clearCommandChip(); // also restores placeholder
      clearSubmittedCommandDraft();
      void handleInlineCommand(chipAction.name, params);
      return;
    }
    // The natural-language action interceptor used to run here, matching
    // phrases like "reorganize all items in my library" and diverting them to
    // a slash-command action before the agent turn began. That is exactly the
    // request `library_batch` exists to handle, and the agent can now chain a
    // batch job with other steps in one turn — which the interceptor could
    // never do, because it replaced the turn entirely.
    //
    // Explicit slash commands and the action picker are untouched: those are
    // deterministic user gestures, and they remain the surface that reviews
    // each page before applying it.
    const inlineCommand = parseInlineActionCommand(inputBox?.value ?? "");
    if (inlineCommand) {
      closeSlashMenu();
      clearSubmittedCommandDraft();
      void handleInlineCommand(inlineCommand.actionName, inlineCommand.params);
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
    let queuedInputRestored = false;
    await doSend({
      overrideText: next.text,
      preserveInputDraft: true,
      restoreQueuedInput: () => {
        queuedInputRestored = true;
        restoreQueuedFollowUp(threadKey, next);
      },
    });
    persistDraftInputForCurrentConversation();
    if (!queuedInputRestored) {
      scheduleQueuedFollowUpDrainForThread(getQueuedFollowUpThreadKey());
    }
  }

  // Send button - use addEventListener
  sendBtn.addEventListener("click", (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    void executeSend();
  });

  // The runtime badge opens a small menu above it; picking a runtime switches
  // to it with a fresh draft, like the header buttons.
  const pickRuntimeFromBadgeMenu = (system: ConversationSystem) => {
    closeRuntimeMenu();
    if (system === getConversationSystem()) return;
    if (hooks?.requestConversationSystem) {
      hooks.requestConversationSystem(system);
      return;
    }
    void switchRuntimeSystemFromControl(system);
  };
  const renderRuntimeMenu = () => {
    if (!runtimeMenu) return;
    runtimeMenu.replaceChildren();
    const state = getRuntimeBadgeState();
    const currentSystem = getConversationSystem();
    for (const entry of state.items) {
      const selected = entry.system === currentSystem;
      const row = runtimeMenu.ownerDocument.createElement("button");
      row.type = "button";
      row.className = "llm-permission-option";
      row.dataset.runtimeSystem = entry.system;
      row.setAttribute("role", "menuitemradio");
      row.setAttribute("aria-checked", String(selected));
      row.classList.toggle("llm-permission-option-selected", selected);
      row.textContent = entry.label;
      row.addEventListener("click", (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        pickRuntimeFromBadgeMenu(entry.system);
        runtimeModeBtn?.focus();
      });
      runtimeMenu.appendChild(row);
    }
  };
  const stopRuntimeMenuPointerEvent = (event: Event) => event.stopPropagation();
  const onRuntimeMenuOutsidePointerDown = (event: Event) => {
    if (!runtimeMenu || !isFloatingMenuOpen(runtimeMenu)) return;
    const target = event.target as Node | null;
    if (
      target &&
      (runtimeMenu.contains(target) || runtimeModeBtn?.contains(target))
    ) {
      return;
    }
    closeRuntimeMenu();
  };
  const onRuntimeMenuEscape = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (
      keyboardEvent.key !== "Escape" ||
      !runtimeMenu ||
      !isFloatingMenuOpen(runtimeMenu)
    ) {
      return;
    }
    closeRuntimeMenu();
    runtimeModeBtn?.focus();
    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
  };
  const runtimeMenuDoc = body.ownerDocument;
  if (runtimeModeBtn && runtimeMenu) {
    runtimeModeBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (runtimeModeBtn.disabled) return;
      if (runtimeModeBtn.getAttribute("aria-expanded") === "true") {
        closeRuntimeMenu();
        return;
      }
      // Same contract as the runtime-system toggles: the fence delivers this
      // click even on a drifted panel, so the handler repairs the drift instead
      // of refusing the only control that can end it.
      recoverDriftedPanelScopeForRuntimeToggle();
      if (
        !item ||
        !requireCurrentPanelOwnership(body, item, "switch-runtime-mode")
      ) {
        return;
      }
      if (!getRuntimeBadgeState().clickable) return;
      renderRuntimeMenu();
      positionFloatingMenu(body, runtimeMenu, runtimeModeBtn, {
        horizontalAlignment: "center",
        verticalPlacement: "above",
      });
      if (runtimeMenu.scrollHeight <= runtimeMenu.clientHeight) {
        runtimeMenu.style.overflowY = "hidden";
      }
      setFloatingMenuOpen(runtimeMenu, FOOTER_PERMISSION_MENU_OPEN_CLASS, true);
      runtimeModeBtn.setAttribute("aria-expanded", "true");
    });
    runtimeMenu.addEventListener("pointerdown", stopRuntimeMenuPointerEvent);
    runtimeMenu.addEventListener("mousedown", stopRuntimeMenuPointerEvent);
    runtimeMenuDoc.addEventListener(
      "pointerdown",
      onRuntimeMenuOutsidePointerDown,
      true,
    );
    runtimeMenuDoc.addEventListener("keydown", onRuntimeMenuEscape, true);
  }

  // Enter key (Shift+Enter for newline).
  // Every key this handler binds is declared in `composerKeyBindings.ts`; the
  // panel ownership fence reads that declaration to keep these keys behind the
  // fence, so a binding added here must be added there too.
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
    if (ke.key === "Escape" && getInlineEditTarget(body)) {
      e.preventDefault();
      e.stopPropagation();
      endInlineEdit(body);
      refreshConversationPanels(body, item);
      return;
    }
    if (ke.key === "Enter" && !ke.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      // A held Enter that started in an inline selection prompt lands here
      // as auto-repeat after that box closes; it must not send the draft.
      if (ke.repeat) return;
      void executeSend();
    }
  });

  attachFontScaleShortcutController(panelDoc);

  // "Add past conversation": the history popup, listing chats of every system
  // for this library. Picking a row attaches a reference chip to the composer.
  const pastConversationPicker = createHistorySearchPopupController({
    parent: panelRoot,
    searchPlaceholder: t("Search past chats"),
    showRuntimeLabel: true,
    loadEntries: async () =>
      await listPastConversationEntries({
        libraryID: getCurrentLibraryID(),
        excludeConversationKey: item ? getConversationKey(item) : null,
      }),
    loadDocument: async (entry) => createHistorySearchDocument(entry, []),
    searchEntries: async (query) =>
      await searchPastConversationEntries({
        libraryID: getCurrentLibraryID(),
        query,
        excludeConversationKey: item ? getConversationKey(item) : null,
      }),
    onSelect: (entry) => {
      if (!item || !isPastConversationEntry(entry)) return false;
      const ref = buildAttachedConversationRef(entry, getCurrentLibraryID());
      if (!ref) return false;
      const current = composeContextStore.attachedConversations.list(item.id);
      if (current.length >= MAX_ATTACHED_CONVERSATIONS) {
        if (status) {
          setStatus(status, t("Up to 3 past chats per message"), "warning");
        }
        return true;
      }
      composeContextStore.attachedConversations.replace(
        item.id,
        normalizeAttachedConversationRefs([...current, ref]),
      );
      updatePaperPreview();
      return true;
    },
    translate: t,
    log: (...args) => appLogger.warn("LLM: past conversation picker", args),
    // Rows read exactly like the history search: "(Creator, year)" or
    // "Library chat", the title, the small "Codex"/"Claude" label, and the
    // paper title underneath.
    resolveLabel: (entry) =>
      historyLifecycleController.resolveHistoryScopeChipLabel(entry),
    resolveScopeLabel: (entry) =>
      historyLifecycleController.resolveHistoryScopeLabel(entry),
  });

  attachComposeCaptureController({
    body,
    inputBox,
    screenshotBtn,
    uploadBtn,
    uploadInput,
    slashMenu,
    slashUploadOption,
    slashReferenceOption,
    slashPastConversationOption,
    openPastConversationPicker: () => {
      if (!item) return;
      pastConversationPicker.open();
    },
    getAttachedConversationCount: () =>
      item ? composeContextStore.attachedConversations.list(item.id).length : 0,
    slashPdfPageOption,
    slashPdfMultiplePagesOption,
    slashSideChatOption,
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
    isScreenshotUnsupportedModel: (modelName) => {
      const profile = getSelectedProfile();
      const inputMode = getAdvancedModelParamsForEntry(
        profile?.entryId,
      )?.inputMode;
      return isScreenshotUnsupportedModel(
        (profile?.model || modelName || "").trim(),
        profile?.providerProtocol,
        profile?.authMode,
        profile?.apiBase,
        inputMode,
      );
    },
    setStatusMessage: status
      ? (message, level) => {
          setStatus(status, message, level);
        }
      : undefined,
    log: (message, ...args) => {
      appLogger.debug(message, ...args);
    },
  });

  openModelMenu = () => {
    if (!modelMenu || !modelBtn) return;
    if ((modelBtn as HTMLButtonElement).disabled) return;
    menus.closeMany(MENUS_CLOSED_BY_MODEL_MENU);
    // Refresh cached provider catalogs when the picker is opened.  The current
    // snapshot renders synchronously; the menu updates when a changed list
    // lands (failed refreshes back off inside the capability service).
    void refreshModelCapabilityRegistry();
    void refreshConfiguredProviderModelCatalogs();
    if (isCodexConversationSystem()) {
      // A loaded catalog can change while this chat stays mounted. Revalidate
      // on each user opening and update the menu when model/list returns.
      void ensureCodexModelCatalogLoaded(true);
    } else if (isClaudeConversationSystem()) {
      // Force: the catalog cache identity (bridge URL, prefs, profile-dir
      // hash, scope) cannot see in-place ~/.claude/settings.json profile
      // changes, so a user-initiated open must revalidate. Non-blocking — the
      // menu opens on the cached list and live-updates when the fetch lands.
      void ensureClaudeModelCatalogLoaded(true);
    } else if (codexDirectController?.hasConfiguredProvider()) {
      codexDirectController.ensureCatalog();
    }
    updateModelButton();
    flushResponsiveLayoutSyncNow();
    flushPanelStateRefreshNow();
    // The menu always opens on the chat model page, at its own width.
    readerMenu.resetPage();
    modelMenu.style.width = "";
    rebuildModelMenu();
    if (!modelMenu.childElementCount) {
      closeModelMenu();
      return;
    }
    positionComposerMenu(body, modelMenu, modelBtn);
    setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, true);
  };

  closeModelMenu = () => {
    setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, false);
  };
  menus.register("model", closeModelMenu);

  openReasoningMenu = () => {
    if (!reasoningMenu || !reasoningBtn) return;
    menus.closeMany(MENUS_CLOSED_BY_REASONING_MENU);
    if (isCodexConversationSystem()) {
      void ensureCodexModelCatalogLoaded();
    } else if (codexDirectController?.getSelectedEntry()) {
      codexDirectController.ensureCatalog();
    }
    updateReasoningButton();
    flushResponsiveLayoutSyncNow();
    rebuildReasoningMenu();
    if (!reasoningMenu.childElementCount) {
      closeReasoningMenu();
      return;
    }
    positionComposerMenu(body, reasoningMenu, reasoningBtn);
    setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, true);
  };

  closeReasoningMenu = () => {
    setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
  };
  menus.register("reasoning", closeReasoningMenu);

  const openRetryModelMenu = (anchor: HTMLButtonElement) => {
    if (!item || !retryModelMenu) return;
    menus.closeMany(MENUS_CLOSED_BY_RETRY_MODEL_MENU);
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
    shortcutMenu,
    paperPicker,
    getPaperChipMenu: () => paperChipMenu,
    getPaperChipMineruCacheMenu: () => paperChipMineruCacheMenu,
    getPaperChipMenuSticky: () => paperChipMenuSticky,
    getPaperChipMenuAnchor: () => paperChipMenuAnchor,
    closePaperChipMineruCacheMenu,
    closePaperChipMenu,
    getItem: () => item,
    getInlineEditTarget: () => getInlineEditTarget(body),
    endInlineEdit: () => endInlineEdit(body),
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
    isWebChatMode,
    resolveCurrentPaperBaseItem,
    clearSelectedImageState,
    clearSelectedFileState,
    closePaperChipMenu,
    openPaperChipMenu,
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
      appLogger.debug(message, error);
    },
  });

  // Adds Zotero items as default context to this panel's current
  // conversation (no new conversation). The Zotero "Add as context" action
  // and the panel handle both use it.
  const addItemsAsDefaultContextForPanel = async (
    zoteroItems: Zotero.Item[],
  ) => {
    const result = await addZoteroItemsAsDefaultContext(
      {
        item,
        resolveAutoLoadedPaperContext,
        getManualPaperContextsForItem,
        isPaperContextMineru,
        getTextContextConversationKey,
        updatePaperPreviewPreservingScroll,
        updateSelectedTextPreviewPreservingScroll,
      },
      zoteroItems,
    );
    if (result.statusMessage && status) {
      setStatus(status, result.statusMessage, result.statusLevel || "ready");
    }
    inputBox.focus({ preventScroll: true });
    return result;
  };
  addItemsAsDefaultContextForHandle = async (zoteroItems) => {
    if (setupHandlersCleaned || !item) return;
    const result = await addItemsAsDefaultContextForPanel(zoteroItems);
    if (result.changed) flushPanelStateRefreshNow();
  };

  // The side chat and a torn-off window never capture Zotero's "Add as
  // context": that action always goes to the one standalone window (or a
  // sidebar panel).
  const unregisterContextSurfaceActions =
    isSidePanel || isTornSurface(selectionSurface())
      ? () => undefined
      : registerContextSurfaceActionTarget(body, {
          surfaceKind: isStandalonePanel ? "standalone" : "embedded",
          addItemsAsDefaultContext: addItemsAsDefaultContextForPanel,
          afterItemsAsDefaultContextAdded: (result) => {
            if (!isStandalonePanel || !result.changed) return;
            flushPanelStateRefreshNow();
            hooks?.onDefaultContextRendered?.();
          },
          prepareItemsAsDefaultContextTarget: isStandalonePanel
            ? hooks?.prepareItemsAsDefaultContextTarget
            : async () => {
                if (isNoteSession() || isWebChatMode()) return false;
                const lease = capturePanelOperationLease(body);
                const libraryID = getCurrentLibraryID();
                if (!lease || !libraryID) return false;
                const summary = await conversationRepository.createCatalogEntry(
                  {
                    system: getConversationSystem(),
                    kind: "global",
                    libraryID,
                  },
                );
                if (!summary || !isPanelOperationLeaseCurrent(lease))
                  return false;
                return switchGlobalConversation(summary.conversationKey);
              },
        });

  const cancelActiveAgentAction = (options?: {
    requireVisibleReviewCard?: boolean;
  }): boolean => {
    if (
      !item ||
      !requireCurrentPanelOwnership(body, item, "cancel-active-request")
    ) {
      return false;
    }
    const cancelledReviewRequestIds = cancelVisiblePendingConfirmationCards(
      chatBox || body,
      (requestId, resolution) =>
        getAgentApi().resolveConfirmation(requestId, resolution),
    );
    if (
      options?.requireVisibleReviewCard &&
      !cancelledReviewRequestIds.length
    ) {
      return false;
    }
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
      const pendingRequestId = getPendingRequestId(cancelConvKey);
      if (pendingRequestId > 0) {
        setCancelledRequestId(cancelConvKey, pendingRequestId);
      }
      // Force-release the claim so Cancel always restores a sendable
      // conversation, even when the in-flight call ignores the abort signal
      // and never settles. The cancelled-id fence above keeps the zombie
      // request from dispatching, and its own finally's id-fenced
      // finishRequest no-ops once the claim is gone.
      clearPendingRequestIdAndSync(cancelConvKey, body, item);
      scheduleQueuedFollowUpDrainForThread(getQueuedFollowUpThreadKey());
    }
    if (status) setStatus(status, t("Cancelled"), "ready");
    // Immediately mark the last assistant message as not streaming so any
    // queued refresh won't bring back the loading dots.
    if (item) {
      const key = getConversationKey(item);
      const history = chatHistory.get(key);
      if (history) {
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].role === "assistant" && history[i].streaming) {
            history[i].streaming = false;
            if (!history[i].text) history[i].text = "[Cancelled]";
            break;
          }
        }
      }
    }
    body.querySelectorAll(".llm-typing").forEach((el: Element) => el.remove());
    return true;
  };

  // Cancel button
  if (cancelBtn) {
    cancelBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      cancelActiveAgentAction();
    });
  }

  body.addEventListener("keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key !== "Escape" || ke.defaultPrevented) return;
    if (!cancelActiveAgentAction({ requireVisibleReviewCard: true })) return;
    e.preventDefault();
    e.stopPropagation();
  });

  // Delete conversation button
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
      if (cancelActiveAgentAction({ requireVisibleReviewCard: true })) return;
      if (!item) return;

      // [webchat] "Exit" button → restore previous model and leave webchat mode
      if (isWebChatMode()) {
        void leaveWebChatMode();
        return;
      }

      void historyLifecycleController.queueCurrentConversationDeletion();
    });
  }

  let disconnectObserverCleanup: (() => void) | null = null;
  const cleanupSetupHandlers = () => {
    if (setupHandlersCleaned) return;
    setupHandlersCleaned = true;
    // WebChat first, exactly where its undo used to sit: the connection-check
    // interval and preload token outlive the detached body otherwise.
    disposeWebChatFeature();
    disconnectObserverCleanup?.();
    disconnectObserverCleanup = null;
    cleanupPrefObservers?.();
    quotaControl?.dispose();
    quotaControl = null;
    disposeFooterPermissionControl?.();
    disposeFooterPermissionControl = null;
    runtimeMenuDoc.removeEventListener(
      "pointerdown",
      onRuntimeMenuOutsidePointerDown,
      true,
    );
    runtimeMenuDoc.removeEventListener("keydown", onRuntimeMenuEscape, true);
    cleanupMineruPaperSourceObservers?.();
    cleanupModelCapabilitySubscription?.();
    cleanupModelCapabilitySubscription = null;
    cleanupModelProviderSync?.();
    cleanupModelProviderSync = null;
    disposeHistoryActivity?.();
    // Before the panel's teardown, which would repaint the button.
    unbindTaskProgressToggle?.();
    disposeTaskProgressPanel(body);
    disposeConversationTurnNavigator(body);
    disposeChatRendering(body);
    cleanupChatScroll();
    codexDirectController?.dispose();
    codexDirectController = null;
    body.removeEventListener(
      QUOTE_PROVENANCE_REVALIDATION_REQUEST_EVENT,
      handleQuoteProvenanceRevalidationRequest,
    );
    body.removeEventListener(
      "pointerdown",
      handleQuoteValidationUserActivity,
      true,
    );
    for (const eventType of ownershipProtectedEventTypes) {
      body.removeEventListener(eventType, enforcePanelOwnershipForEvent, true);
    }
    unregisterQueuedFollowUpBody(registeredQueuedFollowUpThreadKey, body);
    queuedFollowUpBody.__llmQueuedFollowUpRegisteredThreadKey = null;
    activeContextPanelStateSync.delete(body);
    // Rebuilding the root of a still-mounted body must retain its raw paper
    // identity. A detached body, or one whose window closed, owns no
    // surviving UI registration.
    if (!isLivePanelBody(body)) {
      unregisterContextPanel(body);
      releaseInlineEdit(body);
    }
    releaseMenuTargets(body);
    unpublishPanelHandle(body, panelHandle);
    delete (body as any)[SCHEDULE_QUEUED_FOLLOW_UP_DRAIN_PROPERTY];
    delete (body as any)[SCHEDULE_QUEUED_FOLLOW_UP_THREAD_DRAIN_PROPERTY];
    delete (body as any).__llmQueueTurnDeletion;
    delete (body as any).__llmSearchPanelHistory;
    panelLifecycle.dispose();
    unregisterContextSurfaceActions();
    disposePendingDeletionSubscriptionForBody(body);
    disposeConversationCatalogSubscriptionForBody(body);
    void releaseClaudeRuntimeForBody(body);
    if (setupHandlersCleanupByBody.get(body) === cleanupSetupHandlers) {
      setupHandlersCleanupByBody.delete(body);
    }
  };
  setupHandlersCleanupByBody.set(body, cleanupSetupHandlers);
  disconnectObserverCleanup = observeElementDisconnected(
    panelRoot,
    cleanupSetupHandlers,
  );
  panelRoot.dataset.handlersInitialized = thisGen;
}

import { createElement } from "../../utils/domHelpers";
import type { RuntimeModelEntry } from "../../utils/modelProviders";
import {
  config,
  AUTO_SCROLL_BOTTOM_THRESHOLD,
  MAX_SELECTED_IMAGES,
  MAX_SELECTED_PAPER_CONTEXTS,
  PERSISTED_HISTORY_LIMIT,
  formatFigureCountLabel,
  formatFileCountLabel,
  FONT_SCALE_MIN_PERCENT,
  FONT_SCALE_MAX_PERCENT,
  FONT_SCALE_STEP_PERCENT,
  FONT_SCALE_DEFAULT_PERCENT,
  SELECT_TEXT_EXPANDED_LABEL,
  SELECT_TEXT_COMPACT_LABEL,
  SCREENSHOT_EXPANDED_LABEL,
  SCREENSHOT_COMPACT_LABEL,
  UPLOAD_FILE_EXPANDED_LABEL,
  UPLOAD_FILE_COMPACT_LABEL,
  REASONING_COMPACT_LABEL,
  ACTION_LAYOUT_CONTEXT_ICON_WIDTH_PX,
  ACTION_LAYOUT_DROPDOWN_ICON_WIDTH_PX,
  ACTION_LAYOUT_MODEL_WRAP_MIN_CHARS,
  ACTION_LAYOUT_MODEL_FULL_MAX_LINES,
  GLOBAL_HISTORY_LIMIT,
  PREFERENCES_PANE_ID,
  MAX_UPLOAD_PDF_SIZE_BYTES,
} from "./constants";
import {
  selectedModelCache,
  selectedReasoningCache,
  selectedRuntimeModeCache,
  selectedImageCache,
  selectedFileAttachmentCache,
  selectedImagePreviewExpandedCache,
  selectedImagePreviewActiveIndexCache,
  selectedFilePreviewExpandedCache,
  selectedPaperContextCache,
  selectedOtherRefContextCache,
  paperContextModeOverrides,
  selectedPaperPreviewExpandedCache,
  pinnedSelectedTextKeys,
  pinnedImageKeys,
  pinnedFileKeys,
  setCancelledRequestId,
  currentAbortController,
  panelFontScalePercent,
  setPanelFontScalePercent,
  responseMenuTarget,
  setResponseMenuTarget,
  promptMenuTarget,
  setPromptMenuTarget,
  chatHistory,
  loadedConversationKeys,
  currentRequestId,
  pendingRequestId,
  activeGlobalConversationByLibrary,
  activeConversationModeByLibrary,
  activePaperConversationByPaper,
  draftInputCache,
  activeContextPanels,
  activeContextPanelStateSync,
  inlineEditTarget,
  setInlineEditTarget,
  inlineEditCleanup,
  setInlineEditCleanup,
  setInlineEditInputSection,
  setInlineEditSavedDraft,
} from "./state";
import {
  sanitizeText,
  setStatus,
  clampNumber,
  buildQuestionWithSelectedTextContexts,
  buildModelPromptWithFileContext,
  resolvePromptText,
  getSelectedTextWithinBubble,
  getAttachmentTypeLabel,
  normalizeSelectedTextSource,
} from "./textUtils";
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
  getSelectedModelEntryForItem,
  applyPanelFontScale,
  getAdvancedModelParamsForEntry,
  setSelectedModelEntryForItem,
  getLastUsedReasoningLevel,
  setLastUsedReasoningLevel,
  getLastUsedPaperConversationKey,
  setLastUsedPaperConversationKey,
  removeLastUsedPaperConversationKey,
  getLockedGlobalConversationKey,
  setLockedGlobalConversationKey,
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
  copyRenderedMarkdownToClipboard,
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
  getActiveReaderForSelectedTab,
  getActiveReaderSelectionText,
  getActiveContextAttachmentFromTabs,
  addSelectedTextContext,
  appendSelectedTextContextForItem,
  applySelectedTextPreview,
  formatSelectedTextContextPageLabel,
  getSelectedTextContextEntries,
  getSelectedTextContexts,
  getSelectedTextExpandedIndex,
  includeSelectedTextFromReader,
  isNoteContextExpanded,
  refreshNoteChipPreview,
  refreshActiveNoteChipPreview,
  resolveContextSourceItem,
  setNoteContextExpanded,
  setSelectedTextContextEntries,
  setSelectedTextContexts,
  setSelectedTextExpandedIndex,
} from "./contextResolution";
import {
  flashPageInLivePdfReader,
} from "./livePdfSelectionLocator";
import {
  resolvePaperContextRefFromAttachment,
  resolvePaperContextRefFromItem,
} from "./paperAttribution";
import { buildPaperKey } from "./pdfContext";
import { captureScreenshotSelection, optimizeImageDataUrl } from "./screenshot";
import { captureCurrentPdfPage } from "./pdfPageCapture";
import {
  createNoteFromAssistantText,
  createStandaloneNoteFromAssistantText,
  createNoteFromChatHistory,
  createStandaloneNoteFromChatHistory,
  buildChatHistoryNotePayload,
  readNoteSnapshot,
} from "./notes";
import {
  persistAttachmentBlob,
  readAttachmentBytes,
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
  PaperContextSendMode,
  SelectedTextContext,
} from "./types";
import type { ReasoningLevel as LLMReasoningLevel } from "../../utils/llmClient";
import type { ReasoningConfig as LLMReasoningConfig } from "../../utils/llmClient";
import {
  browseAllItemCandidates,
  searchAllItemCandidates,
  ZOTERO_NOTE_CONTENT_TYPE,
  normalizePaperSearchText,
  parsePaperSearchSlashToken,
  parseAtSearchToken,
  type PaperBrowseCollectionCandidate,
  type PaperSearchAttachmentCandidate,
  type PaperSearchGroupCandidate,
  type PaperSearchSlashToken,
} from "./paperSearch";
import { getAgentApi } from "../../agent/index";
import { renderPendingActionCard } from "./agentTrace/render";
import type {
  AgentPendingAction,
  AgentConfirmationResolution,
} from "../../agent/types";
import {
  createGlobalPortalItem,
  createPaperPortalItem,
  getPaperPortalBaseItemID,
  isGlobalPortalItem,
  resolveActiveNoteSession,
  resolveDisplayConversationKind,
  resolveConversationBaseItem,
  resolveInitialPanelItemState,
  resolveActiveLibraryID,
} from "./portalScope";
import { getPanelDomRefs } from "./setupHandlers/domRefs";
import {
  MODEL_MENU_OPEN_CLASS,
  REASONING_MENU_OPEN_CLASS,
  RETRY_MODEL_MENU_OPEN_CLASS,
  SLASH_MENU_OPEN_CLASS,
  isFloatingMenuOpen,
  positionFloatingMenu,
  setFloatingMenuOpen,
} from "./setupHandlers/controllers/menuController";
import {
  getReasoningLevelDisplayLabel,
  isReasoningDisplayLabelActive,
  getScreenshotDisabledHint,
  isScreenshotUnsupportedModel,
} from "./setupHandlers/controllers/modelReasoningController";
import {
  GLOBAL_HISTORY_UNDO_WINDOW_MS,
  type ConversationHistoryEntry,
  type HistorySwitchTarget,
  type PendingHistoryDeletion,
  formatGlobalHistoryTimestamp,
  formatHistoryRowDisplayTitle,
  normalizeConversationTitleSeed,
  normalizeHistoryTitle,
} from "./setupHandlers/controllers/conversationHistoryController";
import {
  formatPaperContextChipLabel,
  formatPaperContextChipTitle,
  normalizePaperContextEntries,
  resolvePaperContextDisplayMetadata,
} from "./setupHandlers/controllers/composeContextController";
import {
  clearPinnedContextOwner,
  isPinnedFile,
  isPinnedImage,
  prunePinnedFileKeys,
  prunePinnedImageKeys,
  removePinnedFile,
  removePinnedImage,
  removePinnedSelectedText,
  retainPinnedFiles,
  retainPinnedImages,
  retainPinnedSelectedTextContexts,
  togglePinnedFile,
  togglePinnedImage,
  togglePinnedSelectedText,
} from "./setupHandlers/controllers/pinnedContextController";
import {
  createFileIntakeController,
  extractFilesFromClipboard,
  isFileDragEvent,
} from "./setupHandlers/controllers/fileIntakeController";
import { createSendFlowController } from "./setupHandlers/controllers/sendFlowController";
import { createClearConversationController } from "./setupHandlers/controllers/clearConversationController";
import { clearAllAgentToolCaches } from "../../agent/tools";

export function setupHandlers(body: Element, initialItem?: Zotero.Item | null) {
  const resolvedInitialState = resolveInitialPanelItemState(initialItem);
  let item = resolvedInitialState.item;
  let basePaperItem = resolvedInitialState.basePaperItem;
  const buildPaperStateKey = (libraryID: number, paperItemID: number): string =>
    `${Math.floor(libraryID)}:${Math.floor(paperItemID)}`;
  const resolveLibraryIdFromItem = (
    targetItem: Zotero.Item | null | undefined,
  ): number => {
    const parsed = Number(targetItem?.libraryID);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
    return resolveActiveLibraryID() || 0;
  };

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
    modeLockBtn,
    historyRowMenu,
    historyRowRenameBtn,
    historyUndo,
    historyUndoText,
    historyUndoBtn,
    selectTextBtn,
    screenshotBtn,
    uploadBtn,
    uploadInput,
    slashMenu,
    slashUploadOption,
    slashReferenceOption,
    slashPdfPageOption,
    slashFullPdfOption,
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
  } = getPanelDomRefs(body);

  if (!inputBox || !sendBtn) {
    ztoolkit.log("LLM: Could not find input or send button");
    return;
  }

  if (!panelRoot) {
    ztoolkit.log("LLM: Could not find panel root");
    return;
  }
  activeContextPanels.set(body, () => item);

  // buildUI() wipes body.textContent whenever onAsyncRender fires (item
  // navigation), which destroys the cancel/send button DOM mid-stream.
  // Re-apply the generating state immediately so the user never sees a stale
  // idle UI while a request is still running in the background.
  // pendingRequestId is set at the very start of doSend/retry, so it covers
  // the full request lifecycle — not just streaming.
  if (pendingRequestId > 0) {
    if (sendBtn) sendBtn.style.display = "none";
    if (cancelBtn) cancelBtn.style.display = "";
    if (inputBox) inputBox.disabled = true;
    if (historyToggleBtn) {
      historyToggleBtn.disabled = true;
      historyToggleBtn.setAttribute("aria-disabled", "true");
    }
    if (historyNewBtn) {
      historyNewBtn.disabled = true;
      historyNewBtn.setAttribute("aria-disabled", "true");
    }
    const historyMenuEl = body.querySelector(
      "#llm-history-menu",
    ) as HTMLDivElement | null;
    if (historyMenuEl) historyMenuEl.style.display = "none";
    const historyNewMenuEl = body.querySelector(
      "#llm-history-new-menu",
    ) as HTMLDivElement | null;
    if (historyNewMenuEl) historyNewMenuEl.style.display = "none";
  }

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
  const isGlobalMode = () =>
    resolveDisplayConversationKind(item) === "global";
  const isPaperMode = () =>
    resolveDisplayConversationKind(item) === "paper";
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
    return selectedRuntimeModeCache.get(key) || "chat";
  };
  const updateRuntimeModeButton = () => {
    if (!runtimeModeBtn) return;
    const agentFeatureEnabled = getAgentModeEnabled();
    // Hide the entire toggle when the agent mode feature is disabled in prefs.
    runtimeModeBtn.style.display = agentFeatureEnabled ? "" : "none";
    if (!agentFeatureEnabled) {
      // Force chat mode when the feature is hidden so state stays consistent.
      if (item) selectedRuntimeModeCache.set(getConversationKey(item), "chat");
      panelRoot.dataset.runtimeMode = "chat";
      return;
    }
    const mode = getCurrentRuntimeMode();
    const enabled = mode === "agent";
    const label = runtimeModeBtn.querySelector(
      ".llm-agent-toggle-label",
    ) as HTMLSpanElement | null;
    if (label) {
      label.textContent = "Agent (beta)";
    }
    runtimeModeBtn.classList.toggle("llm-agent-toggle-enabled", enabled);
    runtimeModeBtn.dataset.mode = mode;
    runtimeModeBtn.title = enabled
      ? "Agent mode ON. Click to switch to Chat mode"
      : "Agent mode OFF. Click to switch to Agent mode";
    runtimeModeBtn.setAttribute(
      "aria-label",
      mode === "agent" ? "Switch to Chat mode" : "Switch to Agent mode",
    );
    runtimeModeBtn.setAttribute("aria-pressed", enabled ? "true" : "false");
    panelRoot.dataset.runtimeMode = mode;
  };
  const setCurrentRuntimeMode = (mode: ChatRuntimeMode) => {
    if (!item) return;
    selectedRuntimeModeCache.set(getConversationKey(item), mode);
    updateRuntimeModeButton();
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
      activeConversationModeByLibrary.set(libraryID, mode);
      if (mode === "global") {
        activeGlobalConversationByLibrary.set(libraryID, item.id);
      } else if (
        Number.isFinite(conversationKey) &&
        (conversationKey as number) > 0 &&
        Number.isFinite(currentBasePaperItemID) &&
        currentBasePaperItemID > 0
      ) {
        const normalizedConversationKey = Math.floor(conversationKey as number);
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
    if (historyModeIndicator) {
      // Keep historyModeIndicator (which is the clock history button) accessible.
      // Its label is static "Conversation history" — no text update needed.
    }
    // Update mode capsule data-active state
    if (modeCapsule) {
      modeCapsule.dataset.mode = mode || "";
    }
    if (modeChipBtn) {
      const currentLabel = noteSession
        ? (mode === "global" ? "Open note" : "Paper note")
        : (mode === "global" ? "Open chat" : "Paper chat");
      modeChipBtn.textContent = currentLabel;
      modeChipBtn.title = noteSession
        ? currentLabel
        : mode === "global"
          ? "Switch to paper chat"
          : "Switch to open chat";
      modeChipBtn.setAttribute(
        "aria-label",
        noteSession
          ? currentLabel
          : mode === "global"
            ? "Switch to paper chat"
            : "Switch to open chat",
      );
    }
    // Lock button: visible only in open-chat mode; reflect lock state
    if (modeLockBtn) {
      modeLockBtn.style.display =
        mode === "global" && !noteSession ? "flex" : "none";
      const libraryID = getCurrentLibraryID();
      const lockedKey =
        libraryID > 0 ? getLockedGlobalConversationKey(libraryID) : null;
      const currentKey =
        conversationKey !== null ? Math.floor(conversationKey as number) : null;
      const isLocked =
        lockedKey !== null && currentKey !== null && lockedKey === currentKey;
      modeLockBtn.dataset.locked = isLocked ? "true" : "false";
      modeLockBtn.title = isLocked
        ? "Unlock open chat default"
        : "Lock open chat as default";
      modeLockBtn.setAttribute(
        "aria-label",
        isLocked ? "Unlock open chat default" : "Lock open chat as default",
      );
    }
    updateRuntimeModeButton();
  };
  syncConversationIdentity();

  // Keep the agent mode toggle in sync when the preference is changed in the
  // Preferences window (which runs in a separate window context).
  {
    const agentPrefKey = `${config.prefsPrefix}.enableAgentMode`;
    let observerId: symbol | undefined;
    const onAgentPrefChange = () => {
      if (!(body as Element).isConnected) {
        // Panel is gone – clean up the observer.
        try {
          if (observerId !== undefined)
            (Zotero as any).Prefs.unregisterObserver(observerId);
        } catch {
          // no-op
        }
        return;
      }
      updateRuntimeModeButton();
    };
    try {
      observerId = (Zotero as any).Prefs.registerObserver(
        agentPrefKey,
        onAgentPrefChange,
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
  let historyRowMenuTarget: {
    kind: "paper" | "global";
    conversationKey: number;
  } | null = null;
  const closeHistoryRowMenu = () => {
    if (historyRowMenu) historyRowMenu.style.display = "none";
    historyRowMenuTarget = null;
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
    const win = body.ownerDocument?.defaultView;
    if (win && Number.isFinite(historySectionViewportFrameId)) {
      win.cancelAnimationFrame(historySectionViewportFrameId as number);
    }
    historySectionViewportFrameId = null;
    historySearchLoadSeq += 1;
    historySearchQuery = "";
    historySearchExpanded = false;
    historySearchLoading = false;
    historySearchDocumentCache.clear();
    historySearchDocumentTasks.clear();
    closeHistoryRowMenu();
  };
  const closeSlashMenu = () => {
    slashMenuActiveIndex = -1;
    clearAgentSlashItems();
    if (slashMenu) {
      Array.from(slashMenu.querySelectorAll(".llm-action-picker-item")).forEach(
        (el) => (el as HTMLButtonElement).removeAttribute("aria-selected"),
      );
    }
    setFloatingMenuOpen(slashMenu, SLASH_MENU_OPEN_CLASS, false);
    if (uploadBtn) {
      uploadBtn.setAttribute("aria-expanded", "false");
    }
  };
  const isHistoryMenuOpen = () =>
    Boolean(historyMenu && historyMenu.style.display !== "none");
  const isHistoryNewMenuOpen = () =>
    Boolean(historyNewMenu && historyNewMenu.style.display !== "none");
  const closeRetryModelMenu = () => {
    setFloatingMenuOpen(retryModelMenu, RETRY_MODEL_MENU_OPEN_CLASS, false);
    retryMenuAnchor = null;
  };

  // Show floating "Quote" action when selecting assistant response text.
  // Keep one quote instance per panel and proactively clean stale DOM buttons.
  const popupHost = panelRoot as HTMLDivElement & {
    __llmSelectionPopupCleanup?: () => void;
  };
  panelRoot
    .querySelectorAll(".llm-assistant-selection-action")
    .forEach((node: Element) => node.remove());
  if (popupHost.__llmSelectionPopupCleanup) {
    popupHost.__llmSelectionPopupCleanup();
    delete popupHost.__llmSelectionPopupCleanup;
  }
  const selectionPopup = createElement(
    panelDoc,
    "button",
    "llm-shortcut-btn llm-assistant-selection-action",
    {
      type: "button",
      textContent: "❞ Quote",
      title: "Quote selected text",
    },
  ) as HTMLButtonElement;
  panelRoot.appendChild(selectionPopup);
  let selectionPopupText = "";
  let selectionDragStartBubble: HTMLElement | null = null;

  const showSelectionPopup = () => {
    if (!selectionPopup.classList.contains("is-visible")) {
      selectionPopup.classList.add("is-visible");
    }
  };
  const hideSelectionPopup = () => {
    selectionPopup.classList.remove("is-visible");
    selectionPopupText = "";
  };

  const findAssistantBubbleFromSelection = (): HTMLElement | null => {
    if (!chatBox || !panelWin) return null;
    const selection = panelWin.getSelection?.();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }
    const anchorEl = isElementNode(selection.anchorNode)
      ? selection.anchorNode
      : selection.anchorNode?.parentElement || null;
    const focusEl = isElementNode(selection.focusNode)
      ? selection.focusNode
      : selection.focusNode?.parentElement || null;
    if (!anchorEl || !focusEl) return null;
    const bubbleA = anchorEl.closest(".llm-bubble.assistant");
    const bubbleB = focusEl.closest(".llm-bubble.assistant");
    if (!bubbleA || !bubbleB || bubbleA !== bubbleB) return null;
    if (!chatBox.contains(bubbleA)) return null;
    return bubbleA as HTMLElement;
  };

  const updateSelectionPopup = (bubble?: HTMLElement | null) => {
    if (
      !panelWin ||
      !chatBox ||
      !panelRoot.isConnected ||
      panelRoot.getClientRects().length === 0
    ) {
      hideSelectionPopup();
      return;
    }
    const targetBubble = bubble || findAssistantBubbleFromSelection();
    if (!targetBubble) {
      hideSelectionPopup();
      return;
    }
    const selected = sanitizeText(
      getSelectedTextWithinBubble(panelDoc, targetBubble),
    ).trim();
    if (!selected) {
      hideSelectionPopup();
      return;
    }
    selectionPopupText = selected;
    const selection = panelWin.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      hideSelectionPopup();
      return;
    }
    const range = selection.getRangeAt(0);
    let rect = range.getBoundingClientRect();
    const rects = range.getClientRects();
    const anchorRect =
      rects && rects.length > 0
        ? rects[rects.length - 1] || rects[0] || rect
        : rect;
    // Prefer the selection focus endpoint (where mouse-up happened),
    // so the popup appears near the "last selected" text.
    let focusRect: DOMRect | null = null;
    try {
      const focusNode = selection.focusNode;
      if (focusNode) {
        const focusRange = panelDoc.createRange();
        focusRange.setStart(focusNode, selection.focusOffset);
        focusRange.setEnd(focusNode, selection.focusOffset);
        let fr = focusRange.getBoundingClientRect();
        const frs = focusRange.getClientRects();
        if ((!fr.width || !fr.height) && frs && frs.length > 0) {
          const first = frs[0];
          if (first) fr = first;
        }
        if (fr.width || fr.height) {
          focusRect = fr;
        }
      }
    } catch (_err) {
      void _err;
    }
    const positionRect = focusRect || anchorRect || rect;
    if ((!rect.width || !rect.height) && anchorRect) {
      rect = anchorRect;
    }
    if (!rect.width && !rect.height) {
      hideSelectionPopup();
      return;
    }
    const panelRect = panelRoot.getBoundingClientRect();
    const chatRect = chatBox.getBoundingClientRect();
    const popupRect = selectionPopup.getBoundingClientRect();
    const margin = 8;
    const hostLeft = chatRect.left - panelRect.left;
    const hostTop = chatRect.top - panelRect.top;
    const hostRight = hostLeft + chatRect.width;
    const hostBottom = hostTop + chatRect.height;
    // Anchor to focus endpoint (last selected text) for natural placement.
    const focusX = positionRect.right - panelRect.left;
    const focusTop = positionRect.top - panelRect.top;
    const focusBottom = positionRect.bottom - panelRect.top;
    let left = focusX + 8;
    let top = focusTop - popupRect.height - 10;
    if (top < hostTop + margin) top = rect.bottom - panelRect.top + 10;
    if (top < hostTop + margin) top = focusBottom + 10;
    if (left > hostRight - popupRect.width - margin) {
      left = focusX - popupRect.width - 8;
    }
    left = clampNumber(
      left,
      hostLeft + margin,
      hostRight - popupRect.width - margin,
    );
    top = clampNumber(
      top,
      hostTop + margin,
      hostBottom - popupRect.height - margin,
    );
    selectionPopup.style.left = `${Math.round(left)}px`;
    selectionPopup.style.top = `${Math.round(top)}px`;
    showSelectionPopup();
  };

  const quoteSelectedAssistantText = () => {
    if (!item) {
      hideSelectionPopup();
      return;
    }
    let selected = sanitizeText(selectionPopupText).trim();
    if (!selected) {
      const targetBubble = findAssistantBubbleFromSelection();
      if (targetBubble) {
        selected = sanitizeText(
          getSelectedTextWithinBubble(panelDoc, targetBubble),
        ).trim();
      }
    }
    if (!selected) {
      hideSelectionPopup();
      if (status) setStatus(status, "No assistant text selected", "error");
      return;
    }
    let added = false;
    const activeItemId = getTextContextConversationKey();
    if (!activeItemId) {
      hideSelectionPopup();
      return;
    }
    runWithChatScrollGuard(() => {
      added = addSelectedTextContext(body, activeItemId, selected, {
        successStatusText: "Selected response text included",
        focusInput: false,
        source: "model",
      });
    });
    if (added) {
      updateSelectedTextPreviewPreservingScroll();
    }
    hideSelectionPopup();
    if (added) {
      inputBox.focus({ preventScroll: true });
    }
  };

  const onPanelMouseUp = (e: Event) => {
    if (!panelWin) return;
    if (!panelRoot.isConnected) {
      disposeSelectionPopup();
      return;
    }
    const me = e as MouseEvent;
    if (typeof me.button === "number" && me.button !== 0) {
      selectionDragStartBubble = null;
      hideSelectionPopup();
      return;
    }
    const target = e.target as Element | null;
    const targetInsidePanel = Boolean(target && panelRoot.contains(target));
    if (!targetInsidePanel && !selectionDragStartBubble) {
      hideSelectionPopup();
      return;
    }
    const bubble = target?.closest(
      ".llm-bubble.assistant",
    ) as HTMLElement | null;
    const fallbackBubble = bubble || selectionDragStartBubble;
    selectionDragStartBubble = null;
    panelWin.setTimeout(() => updateSelectionPopup(fallbackBubble), 0);
  };
  const onDocKeyUp = () => {
    if (!panelRoot.isConnected) {
      disposeSelectionPopup();
      return;
    }
    panelWin?.setTimeout(() => updateSelectionPopup(), 0);
  };
  const onPanelPointerDown = (e: Event) => {
    const target = e.target as Node | null;
    if (target && selectionPopup.contains(target)) return;
    const targetEl = target as Element | null;
    selectionDragStartBubble =
      (targetEl?.closest(".llm-bubble.assistant") as HTMLElement | null) ||
      null;
    hideSelectionPopup();
  };
  const onChatScrollHide = () => hideSelectionPopup();
  const onChatContextMenu = () => hideSelectionPopup();

  let selectionPopupHandled = false;
  const triggerSelectionPopupAction = (e: Event) => {
    if (selectionPopupHandled) return;
    selectionPopupHandled = true;
    e.preventDefault();
    e.stopPropagation();
    quoteSelectedAssistantText();
    panelWin?.setTimeout(() => {
      selectionPopupHandled = false;
    }, 0);
  };
  const isPrimarySelectionPopupEvent = (e: Event): boolean => {
    const maybeMouse = e as MouseEvent;
    return typeof maybeMouse.button !== "number" || maybeMouse.button === 0;
  };
  selectionPopup.addEventListener("pointerdown", (e: Event) => {
    if (!isPrimarySelectionPopupEvent(e)) return;
    triggerSelectionPopupAction(e);
  });
  selectionPopup.addEventListener("mousedown", (e: Event) => {
    if (!isPrimarySelectionPopupEvent(e)) return;
    triggerSelectionPopupAction(e);
  });
  selectionPopup.addEventListener("click", triggerSelectionPopupAction);
  selectionPopup.addEventListener("command", triggerSelectionPopupAction);
  selectionPopup.addEventListener("contextmenu", (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    hideSelectionPopup();
  });

  panelDoc.addEventListener("mouseup", onPanelMouseUp, true);
  panelDoc.addEventListener("keyup", onDocKeyUp, true);
  panelRoot.addEventListener("pointerdown", onPanelPointerDown, true);
  chatBox?.addEventListener("scroll", onChatScrollHide, { passive: true });
  chatBox?.addEventListener("contextmenu", onChatContextMenu, true);
  panelWin?.addEventListener("resize", onChatScrollHide, { passive: true });

  const disposeSelectionPopup = () => {
    panelDoc.removeEventListener("mouseup", onPanelMouseUp, true);
    panelDoc.removeEventListener("keyup", onDocKeyUp, true);
    panelRoot.removeEventListener("pointerdown", onPanelPointerDown, true);
    chatBox?.removeEventListener("scroll", onChatScrollHide);
    chatBox?.removeEventListener("contextmenu", onChatContextMenu, true);
    panelWin?.removeEventListener("resize", onChatScrollHide);
    selectionPopup.remove();
    if (popupHost.__llmSelectionPopupCleanup === disposeSelectionPopup) {
      delete popupHost.__llmSelectionPopupCleanup;
    }
  };
  popupHost.__llmSelectionPopupCleanup = disposeSelectionPopup;

  if (responseMenu && responseMenuCopyBtn && responseMenuNoteBtn) {
    if (!responseMenu.dataset.listenerAttached) {
      responseMenu.dataset.listenerAttached = "true";
      // Stop propagation for both pointer and mouse events so that the
      // document-level dismiss handler cannot race with button clicks.
      responseMenu.addEventListener("pointerdown", (e: Event) => {
        e.stopPropagation();
      });
      responseMenu.addEventListener("mousedown", (e: Event) => {
        e.stopPropagation();
      });
      responseMenu.addEventListener("contextmenu", (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
      });
      responseMenuCopyBtn.addEventListener("click", async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        const target = responseMenuTarget;
        closeResponseMenu();
        if (!target) return;
        // Render through renderMarkdownForNote and copy both HTML
        // (for rich-text paste into Zotero notes) and plain text
        // (for plain-text editors).  Uses the selection if present,
        // otherwise the full response.
        await copyRenderedMarkdownToClipboard(body, target.contentText);
        if (status) setStatus(status, "Copied response", "ready");
      });
      responseMenuNoteBtn.addEventListener("click", async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        // Capture all needed values immediately before any async work,
        // so that even if responseMenuTarget is cleared we still have them.
        const target = responseMenuTarget;
        closeResponseMenu();
        if (!target) {
          ztoolkit.log("LLM: Note save – no responseMenuTarget");
          return;
        }
        const { item: targetItem, contentText, modelName } = target;
        if (!targetItem || !contentText) {
          ztoolkit.log("LLM: Note save – missing item or contentText");
          return;
        }
        try {
          const targetNoteSession = resolveActiveNoteSession(targetItem);
          if (
            isGlobalPortalItem(targetItem) ||
            targetNoteSession?.noteKind === "standalone"
          ) {
            const libraryID =
              Number.isFinite(targetItem.libraryID) && targetItem.libraryID > 0
                ? Math.floor(targetItem.libraryID)
                : getCurrentLibraryID();
            await createStandaloneNoteFromAssistantText(
              libraryID,
              contentText,
              modelName,
            );
            if (status) {
              setStatus(status, "Created a new note", "ready");
            }
            return;
          }
          const saveResult = await createNoteFromAssistantText(
            targetItem,
            contentText,
            modelName,
          );
          if (status) {
            setStatus(
              status,
              saveResult === "appended"
                ? "Appended to existing note"
                : "Created a new note",
              "ready",
            );
          }
        } catch (err) {
          ztoolkit.log("Create note failed:", err);
          if (status) setStatus(status, "Failed to create note", "error");
        }
      });
      if (responseMenuDeleteBtn) {
        responseMenuDeleteBtn.addEventListener("click", async (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
          const target = responseMenuTarget;
          closeResponseMenu();
          if (!target || !item) return;
          const conversationKey = Number(target.conversationKey || 0);
          const userTimestamp = Number(target.userTimestamp || 0);
          const assistantTimestamp = Number(target.assistantTimestamp || 0);
          if (
            !Number.isFinite(conversationKey) ||
            conversationKey <= 0 ||
            !Number.isFinite(userTimestamp) ||
            userTimestamp <= 0 ||
            !Number.isFinite(assistantTimestamp) ||
            assistantTimestamp <= 0
          ) {
            if (status) setStatus(status, "No deletable turn found", "error");
            return;
          }
          await queueTurnDeletion({
            conversationKey: Math.floor(conversationKey),
            userTimestamp: Math.floor(userTimestamp),
            assistantTimestamp: Math.floor(assistantTimestamp),
          });
        });
      }
    }
  }

  if (promptMenu) {
    if (!promptMenu.dataset.listenerAttached) {
      promptMenu.dataset.listenerAttached = "true";
      promptMenu.addEventListener("pointerdown", (e: Event) => {
        e.stopPropagation();
      });
      promptMenu.addEventListener("mousedown", (e: Event) => {
        e.stopPropagation();
      });
      promptMenu.addEventListener("contextmenu", (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
      });
      if (promptMenuDeleteBtn) {
        promptMenuDeleteBtn.addEventListener("click", async (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
          const target = promptMenuTarget;
          closePromptMenu();
          if (!target || !item) return;
          if (
            !Number.isFinite(target.userTimestamp) ||
            target.userTimestamp <= 0 ||
            !Number.isFinite(target.assistantTimestamp) ||
            target.assistantTimestamp <= 0
          ) {
            if (status) setStatus(status, "No deletable turn found", "error");
            return;
          }
          await queueTurnDeletion({
            conversationKey: Math.floor(target.conversationKey),
            userTimestamp: Math.floor(target.userTimestamp),
            assistantTimestamp: Math.floor(target.assistantTimestamp),
          });
        });
      }
    }
  }

  if (exportMenu && exportMenuCopyBtn && exportMenuNoteBtn) {
    if (!exportMenu.dataset.listenerAttached) {
      exportMenu.dataset.listenerAttached = "true";
      exportMenu.addEventListener("pointerdown", (e: Event) => {
        e.stopPropagation();
      });
      exportMenu.addEventListener("mousedown", (e: Event) => {
        e.stopPropagation();
      });
      exportMenu.addEventListener("contextmenu", (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
      });
      exportMenuCopyBtn.addEventListener("click", async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        if (!item) return;
        await ensureConversationLoaded(item);
        const conversationKey = getConversationKey(item);
        const history = chatHistory.get(conversationKey) || [];
        const payload = buildChatHistoryNotePayload(history);
        if (!payload.noteText) {
          if (status) setStatus(status, "No chat history detected.", "ready");
          closeExportMenu();
          return;
        }
        // Match single-response "copy as md": copy markdown/plain text only.
        await copyTextToClipboard(body, payload.noteText);
        if (status) setStatus(status, "Copied chat as md", "ready");
        closeExportMenu();
      });
      exportMenuNoteBtn.addEventListener("click", async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        const currentItem = item;
        const currentLibraryID = getCurrentLibraryID();
        closeExportMenu();
        if (!currentItem) return;
        try {
          await ensureConversationLoaded(currentItem);
          const conversationKey = getConversationKey(currentItem);
          const history = chatHistory.get(conversationKey) || [];
          const payload = buildChatHistoryNotePayload(history);
          if (!payload.noteText) {
            if (status) setStatus(status, "No chat history detected.", "ready");
            return;
          }
          if (isGlobalMode()) {
            await createStandaloneNoteFromChatHistory(
              currentLibraryID,
              history,
            );
          } else {
            await createNoteFromChatHistory(currentItem, history);
          }
          if (status)
            setStatus(status, "Saved chat history to new note", "ready");
        } catch (err) {
          ztoolkit.log("Save chat history note failed:", err);
          if (status) setStatus(status, "Failed to save chat history", "error");
        }
      });
    }
  }

  if (exportBtn) {
    exportBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (exportBtn.disabled || !exportMenu || !item) return;
      closeRetryModelMenu();
      closeSlashMenu();
      closeResponseMenu();
      closePromptMenu();
      closeHistoryNewMenu();
      closeHistoryMenu();
      if (exportMenu.style.display !== "none") {
        closeExportMenu();
        return;
      }
      positionMenuBelowButton(body, exportMenu, exportBtn);
    });
  }

  if (settingsBtn) {
    settingsBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        closeRetryModelMenu();
        closeSlashMenu();
        closeResponseMenu();
        closePromptMenu();
        closeHistoryNewMenu();
        closeHistoryMenu();
        closeExportMenu();
        const paneId =
          settingsBtn.dataset.preferencesPaneId || PREFERENCES_PANE_ID;
        Zotero.Utilities.Internal.openPreferences(paneId);
      } catch (error) {
        ztoolkit.log("LLM: Failed to open plugin preferences", error);
        if (status) {
          setStatus(status, "Could not open plugin settings", "error");
        }
      }
    });
  }

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

  const clearSelectedImageState = (itemId: number) => {
    selectedImageCache.delete(itemId);
    selectedImagePreviewExpandedCache.delete(itemId);
    selectedImagePreviewActiveIndexCache.delete(itemId);
    clearPinnedContextOwner(pinnedImageKeys, itemId);
  };

  const clearSelectedFileState = (itemId: number) => {
    selectedFileAttachmentCache.delete(itemId);
    selectedFilePreviewExpandedCache.delete(itemId);
    clearPinnedContextOwner(pinnedFileKeys, itemId);
  };

  const hasUserTurnsForCurrentConversation = (): boolean => {
    if (!item) return false;
    const history = chatHistory.get(getConversationKey(item)) || [];
    return history.some((message) => message.role === "user");
  };

  const getPaperModeOverride = (
    itemId: number,
    paperContext: PaperContextRef,
  ): PaperContextSendMode | null => {
    return paperContextModeOverrides.get(itemId)?.get(buildPaperKey(paperContext)) || null;
  };

  const setPaperModeOverride = (
    itemId: number,
    paperContext: PaperContextRef,
    mode: PaperContextSendMode,
  ) => {
    let overrides = paperContextModeOverrides.get(itemId);
    if (!overrides) {
      overrides = new Map<string, PaperContextSendMode>();
      paperContextModeOverrides.set(itemId, overrides);
    }
    overrides.set(buildPaperKey(paperContext), mode);
  };

  const clearPaperModeOverrides = (itemId: number) => {
    paperContextModeOverrides.delete(itemId);
  };

  const consumePaperModeState = (itemId: number) => {
    if (!item || item.id !== itemId) {
      clearPaperModeOverrides(itemId);
      return;
    }
    const fullTextPaperContexts = getEffectiveFullTextPaperContexts(item);
    if (!fullTextPaperContexts.length) return;
    let overrides = paperContextModeOverrides.get(itemId);
    for (const paperContext of fullTextPaperContexts) {
      if (resolvePaperContextNextSendMode(itemId, paperContext) !== "full-next") {
        continue;
      }
      if (!overrides) {
        overrides = new Map<string, PaperContextSendMode>();
        paperContextModeOverrides.set(itemId, overrides);
      }
      overrides.set(buildPaperKey(paperContext), "retrieval");
    }
  };

  const isPaperContextFullTextMode = (
    mode: PaperContextSendMode | null | undefined,
  ): boolean => {
    return mode === "full-next" || mode === "full-sticky";
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

  const getEffectiveFullTextPaperContexts = (
    currentItem: Zotero.Item,
    selectedPaperContexts?: PaperContextRef[],
  ): PaperContextRef[] => {
    const selectedPapers =
      selectedPaperContexts ||
      normalizePaperContextEntries(selectedPaperContextCache.get(currentItem.id) || []);
    const autoLoadedPaperContext = isGlobalPortalItem(currentItem)
      ? null
      : resolveAutoLoadedPaperContext();
    const effectivePapers = normalizePaperContextEntries([
      ...(autoLoadedPaperContext ? [autoLoadedPaperContext] : []),
      ...selectedPapers,
    ]);
    return effectivePapers.filter(
      (paperContext) =>
        isPaperContextFullTextMode(
          resolvePaperContextNextSendMode(currentItem.id, paperContext),
        ),
    );
  };

  const clearSelectedPaperState = (itemId: number) => {
    selectedPaperContextCache.delete(itemId);
    selectedPaperPreviewExpandedCache.delete(itemId);
    clearPaperModeOverrides(itemId);
  };
  const clearAllRefContextState = (itemId: number) => {
    clearSelectedPaperState(itemId);
    selectedOtherRefContextCache.delete(itemId);
  };

  const clearSelectedTextState = (itemId: number) => {
    setSelectedTextContexts(itemId, []);
    setSelectedTextExpandedIndex(itemId, null);
    setNoteContextExpanded(itemId, null);
    clearPinnedContextOwner(pinnedSelectedTextKeys, itemId);
  };
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
  const retainPinnedImageState = (itemId: number) => {
    const retained = retainPinnedImages(
      pinnedImageKeys,
      itemId,
      selectedImageCache.get(itemId) || [],
    );
    if (retained.length) {
      selectedImageCache.set(itemId, retained);
      const currentActiveIndex =
        selectedImagePreviewActiveIndexCache.get(itemId);
      const normalizedActiveIndex =
        typeof currentActiveIndex === "number" &&
        Number.isFinite(currentActiveIndex)
          ? Math.max(
              0,
              Math.min(retained.length - 1, Math.floor(currentActiveIndex)),
            )
          : 0;
      selectedImagePreviewActiveIndexCache.set(itemId, normalizedActiveIndex);
      return;
    }
    selectedImageCache.delete(itemId);
    selectedImagePreviewExpandedCache.delete(itemId);
    selectedImagePreviewActiveIndexCache.delete(itemId);
  };
  const retainPinnedFileState = (itemId: number) => {
    const retained = retainPinnedFiles(
      pinnedFileKeys,
      itemId,
      selectedFileAttachmentCache.get(itemId) || [],
    );
    if (retained.length) {
      selectedFileAttachmentCache.set(itemId, retained);
      return;
    }
    selectedFileAttachmentCache.delete(itemId);
    selectedFilePreviewExpandedCache.delete(itemId);
  };
  const retainPaperState = (itemId: number) => {
    const retained = normalizePaperContextEntries(
      selectedPaperContextCache.get(itemId) || [],
    );
    if (retained.length) {
      selectedPaperContextCache.set(itemId, retained);
    } else {
      selectedPaperContextCache.delete(itemId);
    }
    // Retain other ref contexts across sends (they persist like paper contexts).
    const autoLoadedPaperContext =
      item && item.id === itemId ? resolveAutoLoadedPaperContext() : null;
    const overrides = paperContextModeOverrides.get(itemId);
    if (overrides?.size) {
      const validKeys = new Set(
        retained.map((paperContext) => buildPaperKey(paperContext)),
      );
      if (autoLoadedPaperContext) {
        validKeys.add(buildPaperKey(autoLoadedPaperContext));
      }
      for (const key of Array.from(overrides.keys())) {
        if (!validKeys.has(key)) {
          overrides.delete(key);
        }
      }
      if (!overrides.size) {
        paperContextModeOverrides.delete(itemId);
      }
    }
    if (retained.length) {
      return;
    }
    if (!autoLoadedPaperContext) {
      selectedPaperPreviewExpandedCache.delete(itemId);
    }
  };
  const retainPinnedTextState = (itemId: number) => {
    const retained = retainPinnedSelectedTextContexts(
      pinnedSelectedTextKeys,
      itemId,
      getSelectedTextContextEntries(itemId),
    );
    setSelectedTextContextEntries(itemId, retained);
    setSelectedTextExpandedIndex(itemId, null);
    setNoteContextExpanded(itemId, null);
  };
  const clearTransientComposeStateForItem = (itemId: number) => {
    clearDraftInputState(itemId);
    clearSelectedImageState(itemId);
    clearAllRefContextState(itemId);
    clearSelectedFileState(itemId);
    clearSelectedTextState(itemId);
  };
  const runWithChatScrollGuard = (fn: () => void) => {
    withScrollGuard(chatBox, conversationKey, fn);
  };
  const EDIT_STALE_STATUS_TEXT =
    "Edit target changed. Please edit latest prompt again.";
  const getLatestEditablePair = async () => {
    if (!item) return null;
    await ensureConversationLoaded(item);
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
      clearTimeout(paperChipMenuHideTimer as unknown as ReturnType<
        typeof setTimeout
      >);
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
    const attachmentTitle = sanitizeText(paperContext.attachmentTitle || "").trim();
    const paperTitle = sanitizeText(paperContext.title || "").trim();
    if (!attachmentTitle || attachmentTitle === paperTitle) return "";
    return attachmentTitle;
  };
  const buildPaperChipMenuCard = (
    ownerDoc: Document,
    paperContext: PaperContextRef,
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
    const attachmentText = buildPaperChipAttachmentText(paperContext);
    if (attachmentText) {
      titleLine.appendChild(
        createElement(ownerDoc, "span", "llm-paper-picker-badge", {
          textContent: "PDF",
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
    if (attachmentText) {
      rowMain.appendChild(
        createElement(
          ownerDoc,
          "span",
          "llm-paper-picker-meta llm-paper-context-card-attachment",
          {
            textContent: attachmentText,
            title: attachmentText,
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
    const menu = createElement(ownerDoc, "div", "llm-model-menu llm-paper-chip-menu");
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
            setStatus(status, "Could not focus this paper", "error");
          }
        })
        .catch((err) => {
          ztoolkit.log("LLM: Failed to focus paper context from menu", err);
          if (status) {
            setStatus(status, "Could not focus this paper", "error");
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
    const minLeftBound = Math.max(viewportMargin, Math.round(panelRect.left) + 2);
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
    menu.appendChild(buildPaperChipMenuCard(ownerDoc, paperContext));
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
      const selectedPapers = normalizePaperContextEntries(
        selectedPaperContextCache.get(item.id) || [],
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
    const tabs = (Zotero as unknown as {
      Tabs?: {
        selectedType?: string;
        getTabIDByItemID?: (itemID: number) => string;
        select?: (id: string, reopening?: boolean, options?: unknown) => void;
      };
    }).Tabs;
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
    },
  ) => {
    const removable = options?.removable === true;
    const fullText = options?.fullText === true;
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
        textContent: formatPaperContextChipLabel(paperContext),
        title: formatPaperContextChipTitle(paperContext),
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
    chipExpanded.appendChild(buildPaperChipMenuCard(ownerDoc, paperContext));
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

  const updatePaperPreview = () => {
    if (!item || !paperPreview || !paperPreviewList) return;
    closePaperChipMenu();
    const itemId = item.id;
    const selectedPapers = normalizePaperContextEntries(
      selectedPaperContextCache.get(itemId) || [],
    );
    const selectedOtherRefs = selectedOtherRefContextCache.get(itemId) || [];
    const autoLoadedPaperContext = resolveAutoLoadedPaperContext();
    const hasAnyContext =
      selectedPapers.length > 0 ||
      selectedOtherRefs.length > 0 ||
      !!autoLoadedPaperContext;
    if (!hasAnyContext) {
      paperPreview.style.display = "none";
      paperPreviewList.innerHTML = "";
      clearSelectedPaperState(itemId);
      return;
    }
    if (selectedPapers.length) {
      selectedPaperContextCache.set(itemId, selectedPapers);
    } else {
      clearSelectedPaperState(itemId);
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
        fullText:
          isPaperContextFullTextMode(
            resolvePaperContextNextSendMode(itemId, autoLoadedPaperContext),
          ),
      });
    }
    selectedPapers.forEach((paperContext, index) => {
      appendPaperChip(ownerDoc, paperPreviewList, paperContext, {
        removable: true,
        removableIndex: index,
        fullText:
          isPaperContextFullTextMode(
            resolvePaperContextNextSendMode(itemId, paperContext),
        ),
      });
    });
    selectedOtherRefs.forEach((ref, index) => {
      appendOtherRefChip(ownerDoc, paperPreviewList, ref, index);
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
    const files = selectedFileAttachmentCache.get(itemId) || [];
    prunePinnedFileKeys(pinnedFileKeys, itemId, files);
    if (!files.length) {
      filePreview.style.display = "none";
      filePreview.classList.remove("expanded", "collapsed");
      filePreviewExpanded.style.display = "none";
      filePreviewMeta.textContent = formatFileCountLabel(0);
      filePreviewMeta.classList.remove("expanded");
      filePreviewMeta.setAttribute("aria-expanded", "false");
      filePreviewMeta.title = "Expand files panel";
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
      ? "Collapse files panel"
      : "Expand files panel";
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
            `Attachment removed (${nextFiles.length})`,
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
        ? "Collapse figures panel"
        : "Expand figures panel";

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
              `Screenshot removed (${nextImages.length}/${MAX_SELECTED_IMAGES})`,
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
          : `Add screenshot (${imageCount}/${MAX_SELECTED_IMAGES})`;
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
      previewMeta.title = "Expand figures panel";
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
    restoreDraftInputForCurrentConversation();
    updatePaperPreview();
    updateFilePreview();
    updateImagePreview();
    updateSelectedTextPreview();
  };
  activeContextPanelStateSync.set(body, syncConversationPanelState);
  const updatePaperPreviewPreservingScroll = () => {
    if (!item) {
      runWithChatScrollGuard(syncConversationPanelState);
      return;
    }
    refreshConversationPanels(body, item, {
      includeChat: false,
      includePanelState: true,
    });
  };
  const updateFilePreviewPreservingScroll = () => {
    if (!item) {
      runWithChatScrollGuard(syncConversationPanelState);
      return;
    }
    refreshConversationPanels(body, item, {
      includeChat: false,
      includePanelState: true,
    });
  };
  const updateImagePreviewPreservingScroll = () => {
    if (!item) {
      runWithChatScrollGuard(syncConversationPanelState);
      return;
    }
    refreshConversationPanels(body, item, {
      includeChat: false,
      includePanelState: true,
    });
  };
  const updateSelectedTextPreviewPreservingScroll = () => {
    if (!item) {
      runWithChatScrollGuard(syncConversationPanelState);
      return;
    }
    refreshConversationPanels(body, item, {
      includeChat: false,
      includePanelState: true,
    });
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

  type HistorySearchTextCandidate = {
    kind: "title" | "message";
    text: string;
    normalizedText: string;
  };
  type HistorySearchDocument = {
    conversationKey: number;
    candidates: HistorySearchTextCandidate[];
  };
  type HistorySearchRange = {
    start: number;
    end: number;
  };
  type HistorySearchResult = {
    entry: ConversationHistoryEntry;
    matchCount: number;
    titleRanges: HistorySearchRange[];
    previewText: string;
    previewRanges: HistorySearchRange[];
  };

  let latestConversationHistory: ConversationHistoryEntry[] = [];
  const HISTORY_SECTION_VISIBLE_ROW_COUNT = 5;
  let historySectionViewportFrameId: number | null = null;
  const historySectionExpandedState = new Map<"paper" | "open", boolean>([
    ["paper", true],
    ["open", false],
  ]);
  let historySearchQuery = "";
  let historySearchExpanded = false;
  let historySearchLoading = false;
  let historySearchLoadSeq = 0;
  const historySearchDocumentCache = new Map<number, HistorySearchDocument>();
  const historySearchDocumentTasks = new Map<
    number,
    Promise<HistorySearchDocument>
  >();
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
    historyUndoText.textContent = "Deleted one turn";
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

  const isHistorySectionExpanded = (section: "paper" | "open"): boolean =>
    historySectionExpandedState.get(section) ?? section === "paper";

  const setHistorySectionExpanded = (
    section: "paper" | "open",
    expanded: boolean,
  ) => {
    historySectionExpandedState.set(section, expanded);
  };

  const normalizeHistorySearchQuery = (value: string): string =>
    sanitizeText(value || "")
      .trim()
      .toLocaleLowerCase();

  const normalizeHistorySearchText = (value: unknown): string =>
    sanitizeText(typeof value === "string" ? value : String(value || ""))
      .replace(/\s+/g, " ")
      .trim();

  const tokenizeHistorySearchQuery = (normalizedQuery: string): string[] =>
    Array.from(
      new Set(
        normalizedQuery
          .split(/\s+/)
          .map((token) => token.trim())
          .filter(Boolean),
      ),
    );

  const countHistorySearchTokenOccurrences = (
    normalizedText: string,
    token: string,
  ): { count: number; firstIndex: number } => {
    if (!normalizedText || !token) {
      return { count: 0, firstIndex: -1 };
    }
    let count = 0;
    let firstIndex = -1;
    let cursor = 0;
    while (cursor < normalizedText.length) {
      const index = normalizedText.indexOf(token, cursor);
      if (index < 0) break;
      count += 1;
      if (firstIndex < 0) {
        firstIndex = index;
      }
      cursor = index + token.length;
    }
    return { count, firstIndex };
  };

  const collectHistorySearchRanges = (
    text: string,
    searchTokens: string[],
  ): HistorySearchRange[] => {
    if (!text || !searchTokens.length) return [];
    const normalizedText = text.toLocaleLowerCase();
    const ranges: HistorySearchRange[] = [];
    for (const token of searchTokens) {
      let cursor = 0;
      while (cursor < normalizedText.length) {
        const index = normalizedText.indexOf(token, cursor);
        if (index < 0) break;
        ranges.push({
          start: index,
          end: index + token.length,
        });
        cursor = index + token.length;
      }
    }
    if (!ranges.length) return [];
    ranges.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return a.end - b.end;
    });
    const merged: HistorySearchRange[] = [ranges[0]];
    for (const range of ranges.slice(1)) {
      const previous = merged[merged.length - 1];
      if (range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end);
        continue;
      }
      merged.push({ ...range });
    }
    return merged;
  };

  const appendHistorySearchHighlightedText = (
    container: HTMLElement,
    text: string,
    ranges: HistorySearchRange[],
  ) => {
    container.textContent = "";
    if (!ranges.length) {
      container.textContent = text;
      return;
    }
    const ownerDoc = container.ownerDocument;
    if (!ownerDoc) {
      container.textContent = text;
      return;
    }
    let cursor = 0;
    for (const range of ranges) {
      const start = Math.max(0, Math.min(text.length, range.start));
      const end = Math.max(start, Math.min(text.length, range.end));
      if (start > cursor) {
        container.appendChild(
          ownerDoc.createTextNode(text.slice(cursor, start)),
        );
      }
      const mark = createElement(
        ownerDoc,
        "mark",
        "llm-history-search-highlight",
        {
          textContent: text.slice(start, end),
        },
      );
      container.appendChild(mark);
      cursor = end;
    }
    if (cursor < text.length) {
      container.appendChild(ownerDoc.createTextNode(text.slice(cursor)));
    }
  };

  const scoreHistorySearchCandidate = (
    candidate: HistorySearchTextCandidate,
    searchTokens: string[],
  ): { matchCount: number; firstIndex: number } => {
    let matchCount = 0;
    let firstIndex = -1;
    for (const token of searchTokens) {
      const occurrence = countHistorySearchTokenOccurrences(
        candidate.normalizedText,
        token,
      );
      matchCount += occurrence.count;
      if (
        occurrence.firstIndex >= 0 &&
        (firstIndex < 0 || occurrence.firstIndex < firstIndex)
      ) {
        firstIndex = occurrence.firstIndex;
      }
    }
    return { matchCount, firstIndex };
  };

  const buildHistorySearchPreview = (
    text: string,
    searchTokens: string[],
  ): { previewText: string; previewRanges: HistorySearchRange[] } => {
    const normalizedText = normalizeHistorySearchText(text);
    if (!normalizedText) {
      return { previewText: "", previewRanges: [] };
    }
    const ranges = collectHistorySearchRanges(normalizedText, searchTokens);
    if (!ranges.length) {
      return { previewText: "", previewRanges: [] };
    }
    const firstRange = ranges[0];
    const beforeContext = 14;
    const afterContext = 52;
    const minimumSnippetLength = 72;
    let start = Math.max(0, firstRange.start - beforeContext);
    let end = Math.min(normalizedText.length, firstRange.end + afterContext);
    if (end - start < minimumSnippetLength) {
      const deficit = minimumSnippetLength - (end - start);
      const shiftLeft = Math.min(start, Math.ceil(deficit / 2));
      start -= shiftLeft;
      end = Math.min(normalizedText.length, end + (deficit - shiftLeft));
    }
    const prefix = start > 0 ? "... " : "";
    const suffix = end < normalizedText.length ? " ..." : "";
    const snippet = normalizedText.slice(start, end);
    const snippetRanges = ranges
      .filter((range) => range.end > start && range.start < end)
      .map((range) => ({
        start: prefix.length + Math.max(0, range.start - start),
        end: prefix.length + Math.min(end, range.end) - start,
      }));
    return {
      previewText: `${prefix}${snippet}${suffix}`,
      previewRanges: snippetRanges,
    };
  };

  const buildHistorySearchDocument = async (
    entry: ConversationHistoryEntry,
  ): Promise<HistorySearchDocument> => {
    const titleText = normalizeHistorySearchText(entry.title);
    const messages = await loadConversation(
      entry.conversationKey,
      PERSISTED_HISTORY_LIMIT,
    );
    const candidates: HistorySearchTextCandidate[] = [];
    if (titleText) {
      candidates.push({
        kind: "title",
        text: titleText,
        normalizedText: titleText.toLocaleLowerCase(),
      });
    }
    for (const message of messages) {
      const text = normalizeHistorySearchText(message.text);
      if (!text) continue;
      candidates.push({
        kind: "message",
        text,
        normalizedText: text.toLocaleLowerCase(),
      });
    }
    return {
      conversationKey: entry.conversationKey,
      candidates,
    };
  };

  const ensureHistorySearchDocument = async (
    entry: ConversationHistoryEntry,
  ): Promise<HistorySearchDocument> => {
    const cached = historySearchDocumentCache.get(entry.conversationKey);
    if (cached) return cached;
    const pending = historySearchDocumentTasks.get(entry.conversationKey);
    if (pending) return pending;
    const task = buildHistorySearchDocument(entry)
      .then((document) => {
        historySearchDocumentCache.set(entry.conversationKey, document);
        historySearchDocumentTasks.delete(entry.conversationKey);
        return document;
      })
      .catch((error) => {
        historySearchDocumentTasks.delete(entry.conversationKey);
        ztoolkit.log("LLM: Failed to index conversation history for search", {
          conversationKey: entry.conversationKey,
          error,
        });
        const fallback: HistorySearchDocument = {
          conversationKey: entry.conversationKey,
          candidates: [],
        };
        historySearchDocumentCache.set(entry.conversationKey, fallback);
        return fallback;
      });
    historySearchDocumentTasks.set(entry.conversationKey, task);
    return task;
  };

  const ensureHistorySearchDocuments = async (
    entries: ConversationHistoryEntry[],
  ) => {
    await Promise.all(
      entries.map((entry) => ensureHistorySearchDocument(entry)),
    );
  };

  const buildHistorySearchResults = (
    entries: ConversationHistoryEntry[],
    normalizedQuery: string,
  ): HistorySearchResult[] => {
    const searchTokens = tokenizeHistorySearchQuery(normalizedQuery);
    if (!searchTokens.length) return [];
    const results: HistorySearchResult[] = [];
    for (const entry of entries) {
      const document = historySearchDocumentCache.get(entry.conversationKey);
      if (!document) continue;
      let matchCount = 0;
      let bestPreviewCandidate: HistorySearchTextCandidate | null = null;
      let bestPreviewScore = 0;
      let bestPreviewIndex = Number.POSITIVE_INFINITY;
      for (const candidate of document.candidates) {
        const score = scoreHistorySearchCandidate(candidate, searchTokens);
        if (score.matchCount <= 0) continue;
        matchCount += score.matchCount;
        if (
          candidate.kind === "message" &&
          (score.matchCount > bestPreviewScore ||
            (score.matchCount === bestPreviewScore &&
              score.firstIndex >= 0 &&
              score.firstIndex < bestPreviewIndex))
        ) {
          bestPreviewCandidate = candidate;
          bestPreviewScore = score.matchCount;
          bestPreviewIndex =
            score.firstIndex >= 0 ? score.firstIndex : bestPreviewIndex;
        }
      }
      if (matchCount <= 0) continue;
      const displayTitle = formatHistoryRowDisplayTitle(entry.title);
      const titleRanges = collectHistorySearchRanges(
        displayTitle,
        searchTokens,
      );
      const preview = bestPreviewCandidate
        ? buildHistorySearchPreview(bestPreviewCandidate.text, searchTokens)
        : { previewText: "", previewRanges: [] };
      results.push({
        entry,
        matchCount,
        titleRanges,
        previewText: preview.previewText,
        previewRanges: preview.previewRanges,
      });
    }
    results.sort((a, b) => {
      if (b.matchCount !== a.matchCount) {
        return b.matchCount - a.matchCount;
      }
      if (b.entry.lastActivityAt !== a.entry.lastActivityAt) {
        return b.entry.lastActivityAt - a.entry.lastActivityAt;
      }
      return b.entry.conversationKey - a.entry.conversationKey;
    });
    return results;
  };

  const applyHistorySectionExpandedState = (
    sectionBlock: HTMLDivElement,
    expanded: boolean,
  ) => {
    sectionBlock.dataset.expanded = expanded ? "true" : "false";
    const sectionHeader = sectionBlock.querySelector(
      ".llm-history-menu-section",
    ) as HTMLButtonElement | null;
    if (sectionHeader) {
      sectionHeader.setAttribute("aria-expanded", expanded ? "true" : "false");
    }
    const sectionIcon = sectionBlock.querySelector(
      ".llm-history-menu-section-icon",
    ) as HTMLSpanElement | null;
    if (sectionIcon) {
      sectionIcon.textContent = expanded ? "▾" : "▸";
    }
    const sectionViewport = sectionBlock.querySelector(
      ".llm-history-menu-section-viewport",
    ) as HTMLDivElement | null;
    if (sectionViewport) {
      sectionViewport.hidden = !expanded;
      sectionViewport.style.display = expanded ? "block" : "none";
    }
  };

  const applyHistorySectionViewportHeights = () => {
    if (!historyMenu || historyMenu.style.display === "none") return;
    const sectionViewports = Array.from(
      historyMenu.querySelectorAll(".llm-history-menu-section-viewport"),
    ) as HTMLDivElement[];
    for (const sectionViewport of sectionViewports) {
      const shouldLimit =
        sectionViewport.dataset.scrollLimited === "true" &&
        !sectionViewport.hidden &&
        sectionViewport.style.display !== "none";
      if (!shouldLimit) {
        sectionViewport.style.maxHeight = "";
        continue;
      }
      const sectionRows = sectionViewport.querySelector(
        ".llm-history-menu-section-rows",
      ) as HTMLDivElement | null;
      if (!sectionRows) {
        sectionViewport.style.maxHeight = "";
        continue;
      }
      const rowElements = Array.from(sectionRows.children).filter((child) =>
        child.classList.contains("llm-history-menu-row"),
      ) as HTMLDivElement[];
      if (!rowElements.length) {
        sectionViewport.style.maxHeight = "";
        continue;
      }
      const computedRowsStyle =
        body.ownerDocument?.defaultView?.getComputedStyle(sectionRows);
      const parsedRowGap = Number.parseFloat(computedRowsStyle?.rowGap || "");
      const parsedGap = Number.parseFloat(computedRowsStyle?.gap || "");
      const rowGap = Number.isFinite(parsedRowGap)
        ? parsedRowGap
        : Number.isFinite(parsedGap)
          ? parsedGap
          : 0;
      let visibleHeight = 0;
      for (const row of rowElements.slice(
        0,
        HISTORY_SECTION_VISIBLE_ROW_COUNT,
      )) {
        const measuredHeight =
          row.getBoundingClientRect().height || row.offsetHeight;
        if (measuredHeight > 0) visibleHeight += measuredHeight;
      }
      if (visibleHeight <= 0) {
        sectionViewport.style.maxHeight = "";
        continue;
      }
      visibleHeight +=
        rowGap * Math.max(0, HISTORY_SECTION_VISIBLE_ROW_COUNT - 1);
      sectionViewport.style.maxHeight = `${Math.ceil(visibleHeight)}px`;
    }
  };

  const queueHistorySectionViewportHeights = () => {
    const win = body.ownerDocument?.defaultView;
    if (!win) {
      applyHistorySectionViewportHeights();
      return;
    }
    if (Number.isFinite(historySectionViewportFrameId)) {
      win.cancelAnimationFrame(historySectionViewportFrameId as number);
    }
    historySectionViewportFrameId = win.requestAnimationFrame(() => {
      historySectionViewportFrameId = null;
      applyHistorySectionViewportHeights();
      if (
        historyToggleBtn &&
        historyMenu &&
        historyMenu.style.display !== "none"
      ) {
        positionMenuBelowButton(body, historyMenu, historyToggleBtn);
        historyMenu.style.display = "flex";
      }
    });
  };

  const renderGlobalHistoryMenu = () => {
    if (!historyMenu) return;
    historyMenu.innerHTML = "";
    const searchQuery = historySearchQuery;
    const normalizedSearchQuery = normalizeHistorySearchQuery(searchQuery);
    const searchTokens = tokenizeHistorySearchQuery(normalizedSearchQuery);
    const searchActive = searchTokens.length > 0;
    const allEntries = latestConversationHistory.filter(
      (entry) => !entry.isPendingDelete,
    );
    if (!allEntries.length) {
      const emptyRow = createElement(
        body.ownerDocument as Document,
        "div",
        "llm-history-menu-empty",
        {
          textContent: "No history yet",
        },
      );
      historyMenu.appendChild(emptyRow);
      return;
    }
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
          textContent: "\u{1F50D} Search history",
          title: "Search chat history",
        },
      ) as HTMLButtonElement;
      searchTrigger.dataset.action = "expand-search";
      searchWrap.appendChild(searchTrigger);
    }
    historyMenu.appendChild(searchWrap);

    const searchDocumentsReady = searchActive
      ? allEntries.every((entry) =>
          historySearchDocumentCache.has(entry.conversationKey),
        )
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
    const searchResults = searchActive
      ? buildHistorySearchResults(allEntries, normalizedSearchQuery)
      : [];
    const searchResultsByKey = new Map<number, HistorySearchResult>(
      searchResults.map((result) => [result.entry.conversationKey, result]),
    );
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
    const sectionEntries = new Map<
      "paper" | "open",
      { title: string; entries: ConversationHistoryEntry[] }
    >();
    for (const entry of filteredEntries) {
      const section = sectionEntries.get(entry.section) || {
        title: entry.sectionTitle,
        entries: [],
      };
      section.entries.push(entry);
      sectionEntries.set(entry.section, section);
    }
    const orderedSections = (["paper", "open"] as const)
      .map((sectionKey) => {
        const section = sectionEntries.get(sectionKey);
        if (!section) return null;
        const latestActivity = section.entries.reduce(
          (max, entry) => Math.max(max, entry.lastActivityAt || 0),
          0,
        );
        const topMatchCount = searchActive
          ? section.entries.reduce(
              (max, entry) =>
                Math.max(
                  max,
                  searchResultsByKey.get(entry.conversationKey)?.matchCount ||
                    0,
                ),
              0,
            )
          : 0;
        const orderedEntries = searchActive
          ? [...section.entries].sort((a, b) => {
              const matchDelta =
                (searchResultsByKey.get(b.conversationKey)?.matchCount || 0) -
                (searchResultsByKey.get(a.conversationKey)?.matchCount || 0);
              if (matchDelta !== 0) return matchDelta;
              if (b.lastActivityAt !== a.lastActivityAt) {
                return b.lastActivityAt - a.lastActivityAt;
              }
              return b.conversationKey - a.conversationKey;
            })
          : section.entries;
        return {
          sectionKey,
          title: section.title,
          entries: orderedEntries,
          latestActivity,
          topMatchCount,
        };
      })
      .filter(
        (
          section,
        ): section is {
          sectionKey: "paper" | "open";
          title: string;
          entries: ConversationHistoryEntry[];
          latestActivity: number;
          topMatchCount: number;
        } => Boolean(section),
      );

    for (const section of orderedSections) {
      const expanded = normalizedSearchQuery
        ? true
        : isHistorySectionExpanded(section.sectionKey);
      const sectionBlock = createElement(
        body.ownerDocument as Document,
        "div",
        "llm-history-menu-section-block",
      ) as HTMLDivElement;
      sectionBlock.dataset.historySection = section.sectionKey;

      const sectionHeader = createElement(
        body.ownerDocument as Document,
        "button",
        "llm-history-menu-section",
        {
          type: "button",
        },
      );
      sectionHeader.dataset.action = "toggle-section";
      sectionHeader.dataset.historySection = section.sectionKey;
      const sectionLabel = createElement(
        body.ownerDocument as Document,
        "span",
        "llm-history-menu-section-label",
        {
          textContent: section.title,
        },
      );
      const sectionIcon = createElement(
        body.ownerDocument as Document,
        "span",
        "llm-history-menu-section-icon",
        {
          textContent: expanded ? "▾" : "▸",
        },
      );
      sectionIcon.setAttribute("aria-hidden", "true");
      sectionHeader.append(sectionLabel, sectionIcon);
      sectionBlock.appendChild(sectionHeader);

      const sectionViewport = createElement(
        body.ownerDocument as Document,
        "div",
        "llm-history-menu-section-viewport",
      ) as HTMLDivElement;
      sectionViewport.dataset.scrollLimited =
        section.entries.length > HISTORY_SECTION_VISIBLE_ROW_COUNT
          ? "true"
          : "false";
      const sectionRows = createElement(
        body.ownerDocument as Document,
        "div",
        "llm-history-menu-section-rows",
      ) as HTMLDivElement;
      sectionViewport.appendChild(sectionRows);
      sectionBlock.appendChild(sectionViewport);
      applyHistorySectionExpandedState(sectionBlock, expanded);

      for (const entry of section.entries) {
        const row = createElement(
          body.ownerDocument as Document,
          "div",
          "llm-history-menu-row",
        ) as HTMLDivElement;
        row.classList.add(
          section.sectionKey === "paper"
            ? "llm-history-menu-row-paper"
            : "llm-history-menu-row-open",
        );
        row.dataset.conversationKey = `${entry.conversationKey}`;
        row.dataset.historyKind = entry.kind;
        row.dataset.historySection = entry.section;
        if (isHistoryEntryActive(entry)) {
          row.classList.add("active");
        }
        if (entry.isPendingDelete) {
          row.classList.add("pending-delete");
        }
        const rowMain = createElement(
          body.ownerDocument as Document,
          "button",
          "llm-history-menu-row-main",
          {
            type: "button",
          },
        ) as HTMLButtonElement;
        rowMain.dataset.action = "switch";
        const titleLine = createElement(
          body.ownerDocument as Document,
          "div",
          "llm-history-row-title-line",
        );
        const title = createElement(
          body.ownerDocument as Document,
          "span",
          "llm-history-row-title",
        );
        const displayTitle = formatHistoryRowDisplayTitle(entry.title);
        title.title = entry.title;
        const searchResult = searchResultsByKey.get(entry.conversationKey);
        if (searchResult?.titleRanges.length) {
          appendHistorySearchHighlightedText(
            title,
            displayTitle,
            searchResult.titleRanges,
          );
        } else {
          title.textContent = displayTitle;
        }
        titleLine.append(title);
        const preview =
          searchResult && searchResult.previewText
            ? createElement(
                body.ownerDocument as Document,
                "div",
                "llm-history-row-preview",
              )
            : null;
        if (preview && searchResult) {
          appendHistorySearchHighlightedText(
            preview,
            searchResult.previewText,
            searchResult.previewRanges,
          );
        }
        const meta = createElement(
          body.ownerDocument as Document,
          "span",
          "llm-history-row-meta",
          {
            textContent: entry.timestampText,
            title: entry.timestampText,
          },
        );
        if (preview) {
          rowMain.append(titleLine, preview, meta);
        } else {
          rowMain.append(titleLine, meta);
        }
        row.appendChild(rowMain);

        if (entry.deletable) {
          const deleteBtn = createElement(
            body.ownerDocument as Document,
            "button",
            "llm-history-row-delete",
            {
              type: "button",
              title: "Delete conversation",
            },
          ) as HTMLButtonElement;
          deleteBtn.setAttribute("aria-label", `Delete ${entry.title}`);
          deleteBtn.dataset.action = "delete";
          row.appendChild(deleteBtn);
        }

        sectionRows.appendChild(row);
      }

      historyMenu.appendChild(sectionBlock);
    }

    if (historyMenu.style.display !== "none") {
      queueHistorySectionViewportHeights();
    }
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
      queueHistorySectionViewportHeights();
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
      queueHistorySectionViewportHeights();
    }
  };

  const refreshHistorySearchMenu = async () => {
    const requestId = ++historySearchLoadSeq;
    const normalizedSearchQuery =
      normalizeHistorySearchQuery(historySearchQuery);
    const entries = latestConversationHistory.filter(
      (entry) => !entry.isPendingDelete,
    );
    if (!normalizedSearchQuery) {
      historySearchLoading = false;
      renderGlobalHistoryMenu();
      if (
        historyToggleBtn &&
        historyMenu &&
        historyMenu.style.display !== "none"
      ) {
        positionMenuBelowButton(body, historyMenu, historyToggleBtn);
        queueHistorySectionViewportHeights();
      }
      restoreHistorySearchInputFocus();
      return;
    }
    const missingEntries = entries.filter(
      (entry) => !historySearchDocumentCache.has(entry.conversationKey),
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
        queueHistorySectionViewportHeights();
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
      queueHistorySectionViewportHeights();
    }
    restoreHistorySearchInputFocus();
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
      queueHistorySectionViewportHeights();
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
          await ensurePaperV1Conversation(libraryID, paperItemID);
        } catch (err) {
          ztoolkit.log("LLM: Failed to ensure legacy v1 paper session", err);
        }
        if (requestId !== globalHistoryLoadSeq) return;
        let summaries: Awaited<ReturnType<typeof listPaperConversations>> = [];
        try {
          summaries = await listPaperConversations(
            libraryID,
            paperItemID,
            GLOBAL_HISTORY_LIMIT,
            true,
          );
        } catch (err) {
          ztoolkit.log("LLM: Failed to load paper history entries", err);
        }
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
          const isDraft = Number(summary.userTurnCount || 0) <= 0;
          const title =
            normalizeHistoryTitle(summary.title) ||
            (isDraft ? "New chat" : "Untitled chat");
          paperEntries.push({
            kind: "paper",
            section: "paper",
            sectionTitle: "Paper Chat",
            conversationKey: normalizedKey,
            title,
            timestampText: isDraft
              ? "Draft"
              : formatGlobalHistoryTimestamp(lastActivity) || "Paper chat",
            deletable: true,
            isDraft,
            isPendingDelete: false,
            lastActivityAt: Number.isFinite(lastActivity)
              ? Math.floor(lastActivity)
              : 0,
            paperItemID: paperItemID,
            sessionVersion: Math.floor(sessionVersion),
          });
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
      let historyEntries: Awaited<ReturnType<typeof listGlobalConversations>> =
        [];
      try {
        historyEntries = await listGlobalConversations(
          libraryID,
          GLOBAL_HISTORY_LIMIT,
          false,
        );
      } catch (err) {
        ztoolkit.log("LLM: Failed to load global history entries", err);
      }
      if (requestId !== globalHistoryLoadSeq) return;

      const seenGlobalKeys = new Set<number>();
      for (const entry of historyEntries) {
        const conversationKey = Number(entry.conversationKey);
        if (!Number.isFinite(conversationKey) || conversationKey <= 0) continue;
        const normalizedKey = Math.floor(conversationKey);
        if (pendingHistoryDeletionKeys.has(normalizedKey)) continue;
        if (seenGlobalKeys.has(normalizedKey)) continue;
        seenGlobalKeys.add(normalizedKey);
        const title = normalizeHistoryTitle(entry.title) || "Untitled chat";
        const lastActivity = Number(
          entry.lastActivityAt || entry.createdAt || 0,
        );
        globalEntries.push({
          kind: "global",
          section: "open",
          sectionTitle: "Open Chat",
          conversationKey: normalizedKey,
          title,
          timestampText:
            formatGlobalHistoryTimestamp(lastActivity) || "Standalone chat",
          deletable: true,
          isDraft: false,
          isPendingDelete: false,
          lastActivityAt: Number.isFinite(lastActivity)
            ? Math.floor(lastActivity)
            : 0,
        });
      }

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
      if (
        activeGlobalKey > 0 &&
        !pendingHistoryDeletionKeys.has(activeGlobalKey)
      ) {
        let userTurnCount = 0;
        try {
          userTurnCount =
            await getGlobalConversationUserTurnCount(activeGlobalKey);
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to inspect active global draft conversation",
            err,
          );
        }
        if (requestId !== globalHistoryLoadSeq) return;
        if (userTurnCount === 0) {
          const existsInHistorical = globalEntries.some(
            (entry) => entry.conversationKey === activeGlobalKey,
          );
          if (!existsInHistorical) {
            globalEntries.unshift({
              kind: "global",
              section: "open",
              sectionTitle: "Open Chat",
              conversationKey: activeGlobalKey,
              title: "New chat",
              timestampText: "Draft",
              deletable: true,
              isDraft: true,
              isPendingDelete: false,
              lastActivityAt: 0,
            });
          }
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

    const visibleEntries = [...paperEntries, ...globalEntries].filter(
      (entry) => !pendingHistoryDeletionKeys.has(entry.conversationKey),
    );
    const visibleSections = [
      {
        section: "paper" as const,
        latestActivity: paperEntries.reduce(
          (max, entry) => Math.max(max, entry.lastActivityAt || 0),
          0,
        ),
      },
      {
        section: "open" as const,
        latestActivity: globalEntries.reduce(
          (max, entry) => Math.max(max, entry.lastActivityAt || 0),
          0,
        ),
      },
    ]
      .filter((entry) =>
        visibleEntries.some((row) => row.section === entry.section),
      )
      .sort((a, b) => {
        if (b.latestActivity !== a.latestActivity) {
          return b.latestActivity - a.latestActivity;
        }
        if (a.section === b.section) return 0;
        return a.section === "paper" ? -1 : 1;
      });
    latestConversationHistory = visibleSections.flatMap((section) =>
      visibleEntries.filter((entry) => entry.section === section.section),
    );

    titleStatic.style.display = "none";
    historyBar.style.display = "inline-flex";
    renderGlobalHistoryMenu();
  };

  const resetComposePreviewUI = () => {
    updatePaperPreviewPreservingScroll();
    updateFilePreviewPreservingScroll();
    updateImagePreviewPreservingScroll();
    updateSelectedTextPreviewPreservingScroll();
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
    const nextItem = createGlobalPortalItem(
      libraryID,
      normalizedConversationKey,
    );
    item = nextItem;
    syncConversationIdentity();
    activeEditSession = null;
    inlineEditCleanup?.();
    setInlineEditCleanup(null);
    setInlineEditTarget(null);
    closePaperPicker();
    closePromptMenu();
    closeResponseMenu();
    closeRetryModelMenu();
    closeExportMenu();
    closeHistoryNewMenu();
    closeHistoryMenu();
    await ensureConversationLoaded(item);
    restoreDraftInputForCurrentConversation();
    refreshChatPreservingScroll();
    resetComposePreviewUI();
    updateModelButton();
    updateReasoningButton();
    void refreshGlobalHistoryHeader();
  };

  const switchPaperConversation = async (nextConversationKey?: number) => {
    if (!item || isNoteSession()) return;
    persistDraftInputForCurrentConversation();
    const paperItem = resolveCurrentPaperBaseItem();
    if (!paperItem) return;
    basePaperItem = paperItem;
    const libraryID = getCurrentLibraryID();
    if (!libraryID) return;
    const paperItemID = Number(paperItem.id || 0);
    if (!Number.isFinite(paperItemID) || paperItemID <= 0) return;

    const requestedConversationKey = Number(nextConversationKey || 0);
    let targetSummary =
      Number.isFinite(requestedConversationKey) && requestedConversationKey > 0
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
    const normalizedConversationKey = Math.floor(targetSummary.conversationKey);
    const nextItem =
      normalizedConversationKey === paperItemID
        ? paperItem
        : createPaperPortalItem(
            paperItem,
            normalizedConversationKey,
            targetSummary.sessionVersion,
          );
    item = nextItem;
    syncConversationIdentity();
    activeEditSession = null;
    inlineEditCleanup?.();
    setInlineEditCleanup(null);
    setInlineEditTarget(null);
    closePaperPicker();
    closePromptMenu();
    closeResponseMenu();
    closeRetryModelMenu();
    closeExportMenu();
    closeHistoryNewMenu();
    closeHistoryMenu();
    await ensureConversationLoaded(item);
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

  const resolveFallbackAfterPaperDelete = async (
    libraryID: number,
    paperItemID: number,
    deletedConversationKey: number,
  ): Promise<HistorySwitchTarget> => {
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
    const paperItem = resolveCurrentPaperBaseItem();
    const paperItemID = Number(paperItem?.id || 0);
    if (paperItemID > 0) {
      const paperTarget = await resolveFallbackAfterPaperDelete(
        libraryID,
        paperItemID,
        deletedConversationKey,
      );
      if (paperTarget) return paperTarget;
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
    chatHistory.delete(conversationKey);
    loadedConversationKeys.delete(conversationKey);
    selectedModelCache.delete(conversationKey);
    selectedReasoningCache.delete(conversationKey);
    clearTransientComposeStateForItem(conversationKey);
    clearConversationSummaryFromCache(conversationKey);
  };

  const finalizeGlobalConversationDeletion = async (
    pending: PendingHistoryDeletion,
  ): Promise<void> => {
    const conversationKey = pending.conversationKey;
    const rememberedKey = Number(
      activeGlobalConversationByLibrary.get(pending.libraryID),
    );
    if (
      Number.isFinite(rememberedKey) &&
      Math.floor(rememberedKey) === conversationKey
    ) {
      activeGlobalConversationByLibrary.delete(pending.libraryID);
    }
    clearPendingDeletionCaches(conversationKey);
    let hasError = false;
    try {
      await clearStoredConversation(conversationKey);
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
      await deleteGlobalConversation(conversationKey);
    } catch (err) {
      hasError = true;
      ztoolkit.log("LLM: Failed to delete global history conversation", err);
    }
    scheduleAttachmentGc();
    if (hasError && status) {
      setStatus(
        status,
        "Failed to fully delete conversation. Check logs.",
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
      const summary = await getPaperConversation(conversationKey);
      paperItemID = Number(summary?.paperItemID || 0);
    }
    if (paperItemID > 0) {
      const paperStateKey = buildPaperStateKey(pending.libraryID, paperItemID);
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
    clearPendingDeletionCaches(conversationKey);
    let hasError = false;
    try {
      await clearStoredConversation(conversationKey);
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
      await deletePaperConversation(conversationKey);
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
        "Failed to fully delete conversation. Check logs.",
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
      await deleteTurnMessages(
        pending.conversationKey,
        pending.userTimestamp,
        pending.assistantTimestamp,
      );
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
    if (hasError && status) {
      setStatus(status, "Failed to fully delete turn. Check logs.", "error");
    } else if (reason === "timeout" && status) {
      setStatus(status, "Turn deleted", "ready");
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
    if (item && getConversationKey(item) === pending.conversationKey) {
      activeEditSession = null;
      refreshChatPreservingScroll();
    }
    if (status) setStatus(status, "Turn restored", "ready");
    void refreshGlobalHistoryHeader();
  };

  const queueTurnDeletion = async (target: {
    conversationKey: number;
    userTimestamp: number;
    assistantTimestamp: number;
  }) => {
    if (!item) return;
    if (
      currentAbortController ||
      historyToggleBtn?.disabled ||
      inputBox?.disabled
    ) {
      if (status) {
        setStatus(status, "Cannot delete while generating", "ready");
      }
      return;
    }
    const activeConversationKey = getConversationKey(item);
    if (activeConversationKey !== target.conversationKey) {
      if (status) setStatus(status, "Delete target changed", "error");
      return;
    }
    await ensureConversationLoaded(item);
    if (!item || getConversationKey(item) !== target.conversationKey) {
      if (status) setStatus(status, "Delete target changed", "error");
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
      if (status) setStatus(status, "No deletable turn found", "error");
      return;
    }

    history.splice(pair.userIndex, 2);
    chatHistory.set(target.conversationKey, history);
    activeEditSession = null;
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
    if (status) setStatus(status, "Turn deleted. Undo available.", "ready");
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
    if (pending.kind === "global") {
      await finalizeGlobalConversationDeletion(pending);
    } else {
      await finalizePaperConversationDeletion(pending);
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
    if (pending.wasActive) {
      await switchToHistoryTarget({
        kind: pending.kind,
        conversationKey: pending.conversationKey,
      });
      if (status) setStatus(status, "Conversation restored", "ready");
      return;
    }
    await refreshGlobalHistoryHeader();
    if (status) setStatus(status, "Conversation restored", "ready");
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
      ) || null
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
      if (status) setStatus(status, "Chat title cannot be empty", "error");
      return null;
    }
    return normalized;
  };

  const renameHistoryEntry = async (
    entry: ConversationHistoryEntry,
  ): Promise<void> => {
    if (
      currentAbortController ||
      historyToggleBtn?.disabled ||
      inputBox?.disabled
    ) {
      if (status) {
        setStatus(status, "History is unavailable while generating", "ready");
      }
      return;
    }
    const nextTitle = promptConversationRename(entry);
    if (!nextTitle) return;
    try {
      if (entry.kind === "paper") {
        await setPaperConversationTitle(entry.conversationKey, nextTitle);
      } else {
        await setGlobalConversationTitle(entry.conversationKey, nextTitle);
      }
      await refreshGlobalHistoryHeader();
      if (status) setStatus(status, "Conversation renamed", "ready");
    } catch (err) {
      ztoolkit.log("LLM: Failed to rename conversation", err);
      if (status) setStatus(status, "Failed to rename conversation", "error");
    }
  };

  const queueHistoryDeletion = async (entry: ConversationHistoryEntry) => {
    if (!item) return;
    if (!entry.deletable) return;
    const libraryID = getCurrentLibraryID();
    if (!libraryID) {
      if (status) setStatus(status, "No active library for deletion", "error");
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
            setStatus(status, "Cannot resolve active paper session", "error");
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
            "Cannot delete active conversation right now",
            "error",
          );
        }
        return;
      }
      await switchToHistoryTarget(fallbackTarget);
      if (fallbackTarget.kind === "paper") {
        activeGlobalConversationByLibrary.delete(libraryID);
      }
    }

    pendingHistoryDeletionKeys.add(entry.conversationKey);
    const pending: PendingHistoryDeletion = {
      kind: entry.kind,
      conversationKey: entry.conversationKey,
      libraryID,
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
      setStatus(status, "Conversation deleted. Undo available.", "ready");
  };

  const createAndSwitchGlobalConversation = async () => {
    if (!item || isNoteSession()) return;
    if (
      currentAbortController ||
      historyNewBtn?.disabled ||
      inputBox?.disabled
    ) {
      if (status) {
        setStatus(
          status,
          "Wait for the current response to finish before starting a new chat",
          "ready",
        );
      }
      return;
    }
    closeHistoryNewMenu();
    const libraryID = getCurrentLibraryID();
    if (!libraryID) {
      if (status) {
        setStatus(status, "No active library for global conversation", "error");
      }
      return;
    }

    let targetConversationKey = 0;
    let reuseReason: "active-draft" | "latest-draft" | null = null;

    const currentCandidate = isGlobalMode()
      ? getConversationKey(item)
      : Number(activeGlobalConversationByLibrary.get(libraryID) || 0);
    const normalizedCurrentCandidate = Number.isFinite(currentCandidate)
      ? Math.floor(currentCandidate)
      : 0;
    if (normalizedCurrentCandidate > 0) {
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

    if (targetConversationKey <= 0) {
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
      if (status) setStatus(status, "Failed to create conversation", "error");
      return;
    }

    ztoolkit.log("LLM: + conversation action", {
      libraryID,
      targetConversationKey,
      action: reuseReason ? "reuse" : "create",
      reason: reuseReason || "new",
    });
    activeGlobalConversationByLibrary.set(libraryID, targetConversationKey);
    await switchGlobalConversation(targetConversationKey);
    if (status) {
      setStatus(
        status,
        reuseReason
          ? "Reused existing new conversation"
          : "Started new conversation",
        "ready",
      );
    }
    inputBox.focus({ preventScroll: true });
  };

  const createAndSwitchPaperConversation = async () => {
    if (!item || isNoteSession()) return;
    if (
      currentAbortController ||
      historyNewBtn?.disabled ||
      inputBox?.disabled
    ) {
      if (status) {
        setStatus(
          status,
          "Wait for the current response to finish before starting a new chat",
          "ready",
        );
      }
      return;
    }
    closeHistoryNewMenu();
    const paperItem = resolveCurrentPaperBaseItem();
    if (!paperItem) {
      if (status) {
        setStatus(status, "Open a paper to start a paper chat", "error");
      }
      return;
    }
    basePaperItem = paperItem;
    const libraryID = getCurrentLibraryID();
    const paperItemID = Number(paperItem.id || 0);
    if (!libraryID || !Number.isFinite(paperItemID) || paperItemID <= 0) {
      if (status) {
        setStatus(status, "No active paper for paper chat", "error");
      }
      return;
    }

    let targetConversationKey = 0;
    let reuseReason: "active-draft" | "existing-draft" | null = null;

    // Step 1: If the currently active conversation is already empty, reuse it.
    const currentKey = Number(getConversationKey(item) || 0);
    if (Number.isFinite(currentKey) && currentKey > 0) {
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

    // Step 2: Look for any other existing empty conversation for this paper.
    if (targetConversationKey <= 0) {
      try {
        const summaries = await listPaperConversations(libraryID, paperItemID, 50);
        const emptyEntry = summaries.find(
          (s) => s.userTurnCount === 0,
        );
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

    // Step 3: No empty draft found — create a genuinely new conversation.
    if (targetConversationKey <= 0) {
      let createdSummary: Awaited<ReturnType<typeof createPaperConversation>> =
        null;
      try {
        createdSummary = await createPaperConversation(libraryID, paperItemID);
      } catch (err) {
        ztoolkit.log("LLM: Failed to create new paper conversation", err);
      }
      if (!createdSummary?.conversationKey) {
        if (status) setStatus(status, "Failed to create paper chat", "error");
        return;
      }
      targetConversationKey = createdSummary.conversationKey;
      reuseReason = null;
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
        reuseReason ? "Reused existing new chat" : "Started new paper chat",
        "ready",
      );
    }
    inputBox.focus({ preventScroll: true });
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
      if (
        currentAbortController ||
        historyNewBtn.disabled ||
        inputBox?.disabled
      ) {
        if (status) {
          setStatus(
            status,
            "Wait for the current response to finish before starting a new chat",
            "ready",
          );
        }
        return;
      }
      closeModelMenu();
      closeReasoningMenu();
      closeRetryModelMenu();
      closeSlashMenu();
      closeResponseMenu();
      closePromptMenu();
      closeExportMenu();
      closeHistoryMenu();
      // Create new session directly in whichever mode is currently active
      if (isGlobalMode()) {
        void createAndSwitchGlobalConversation();
      } else {
        void createAndSwitchPaperConversation();
      }
    });
  }

  if (historyNewOpenBtn) {
    historyNewOpenBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (isNoteSession()) return;
      closeHistoryNewMenu();
      void createAndSwitchGlobalConversation();
    });
  }

  if (historyNewPaperBtn) {
    historyNewPaperBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (isNoteSession()) return;
      if (historyNewPaperBtn.disabled) return;
      closeHistoryNewMenu();
      void createAndSwitchPaperConversation();
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

  // --- Mode chip + lock button handlers ---
  if (modeChipBtn) {
    modeChipBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item || isNoteSession()) return;
      if (currentAbortController || inputBox?.disabled) {
        if (status) {
          setStatus(
            status,
            "Wait for the current response to finish before switching modes",
            "ready",
          );
        }
        return;
      }
      closeHistoryMenu();
      closeHistoryNewMenu();
      if (isGlobalMode()) {
        const libraryID = getCurrentLibraryID();
        if (libraryID) {
          // Explicit click always overrides the lock — clear it so
          // resolveInitialPanelItemState doesn't snap back to global on the
          // next onAsyncRender.
          setLockedGlobalConversationKey(libraryID, null);
        }
        // When the lock was active, resolveInitialPanelItemState set
        // basePaperItem to null.  Recover it from initialItem so that
        // switchPaperConversation can find the paper to switch to.
        if (!basePaperItem) {
          basePaperItem = resolveConversationBaseItem(initialItem) ?? null;
        }
        void switchPaperConversation();
      } else {
        void (async () => {
          const libraryID = getCurrentLibraryID();
          if (!libraryID) return;
          const remembered = activeGlobalConversationByLibrary.get(libraryID);
          const rememberedKey =
            remembered && Number.isFinite(Number(remembered))
              ? Math.floor(Number(remembered))
              : 0;
          if (rememberedKey > 0) {
            await switchGlobalConversation(rememberedKey);
          } else {
            await createAndSwitchGlobalConversation();
          }
        })();
      }
    });
  }

  if (modeLockBtn) {
    modeLockBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item || isNoteSession() || !isGlobalMode()) return;
      const libraryID = getCurrentLibraryID();
      if (!libraryID) return;
      const currentKey =
        conversationKey !== null ? Math.floor(conversationKey as number) : null;
      if (!currentKey) return;
      const lockedKey = getLockedGlobalConversationKey(libraryID);
      const isLocked = lockedKey !== null && lockedKey === currentKey;
      if (isLocked) {
        setLockedGlobalConversationKey(libraryID, null);
      } else {
        setLockedGlobalConversationKey(libraryID, currentKey);
      }
      syncConversationIdentity();
    });
  }

  if (historyToggleBtn) {
    historyToggleBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item || isNoteSession()) return;
      if (
        currentAbortController ||
        historyToggleBtn.disabled ||
        inputBox?.disabled
      ) {
        closeHistoryNewMenu();
        closeHistoryMenu();
        if (status) {
          setStatus(status, "History is unavailable while generating", "ready");
        }
        return;
      }
      void (async () => {
        closeModelMenu();
        closeReasoningMenu();
        closeRetryModelMenu();
        closeSlashMenu();
        closeResponseMenu();
        closePromptMenu();
        closeExportMenu();
        closeHistoryNewMenu();
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
        queueHistorySectionViewportHeights();
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
      if (
        currentAbortController ||
        historyToggleBtn?.disabled ||
        inputBox?.disabled
      ) {
        e.preventDefault();
        e.stopPropagation();
        closeHistoryNewMenu();
        closeHistoryMenu();
        if (status) {
          setStatus(status, "History is unavailable while generating", "ready");
        }
        return;
      }
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

      const sectionToggle = target.closest(
        ".llm-history-menu-section",
      ) as HTMLButtonElement | null;
      if (sectionToggle) {
        e.preventDefault();
        e.stopPropagation();
        const section =
          sectionToggle.dataset.historySection === "paper" ? "paper" : "open";
        const nextExpanded =
          sectionToggle.getAttribute("aria-expanded") !== "true";
        setHistorySectionExpanded(section, nextExpanded);
        sectionToggle.setAttribute(
          "aria-expanded",
          nextExpanded ? "true" : "false",
        );
        const sectionBlock = sectionToggle.closest(
          ".llm-history-menu-section-block",
        ) as HTMLDivElement | null;
        if (sectionBlock) {
          applyHistorySectionExpandedState(sectionBlock, nextExpanded);
          queueHistorySectionViewportHeights();
        }
        return;
      }

      const deleteBtn = target.closest(
        ".llm-history-row-delete",
      ) as HTMLButtonElement | null;
      if (deleteBtn) {
        const row = deleteBtn.closest(
          ".llm-history-menu-row",
        ) as HTMLDivElement | null;
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

      const rowMain = target.closest(
        ".llm-history-menu-row-main",
      ) as HTMLButtonElement | null;
      if (!rowMain) return;
      const row = rowMain.closest(
        ".llm-history-menu-row",
      ) as HTMLDivElement | null;
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
      void (async () => {
        if (historyKind === "paper") {
          await switchPaperConversation(parsedConversationKey);
        } else {
          await switchGlobalConversation(parsedConversationKey);
        }
        if (status) setStatus(status, "Conversation loaded", "ready");
      })();
    });

    historyMenu.addEventListener("contextmenu", (e: Event) => {
      const target = e.target as Element | null;
      if (!target || !item) return;
      if (
        currentAbortController ||
        historyToggleBtn?.disabled ||
        inputBox?.disabled
      ) {
        e.preventDefault();
        e.stopPropagation();
        closeHistoryRowMenu();
        if (status) {
          setStatus(status, "History is unavailable while generating", "ready");
        }
        return;
      }
      const row = target.closest(
        ".llm-history-menu-row",
      ) as HTMLDivElement | null;
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

  const getModelChoices = () => {
    const choices = getAvailableModelEntries();
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

  const getSelectedModelInfo = () => {
    const { choices, groupedChoices } = getModelChoices();
    const selectedEntry = item ? getSelectedModelEntryForItem(item.id) : null;
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

  type ActionLabelMode = "icon" | "full";
  type ModelLabelMode = "icon" | "full-single" | "full-wrap2";
  type ActionLayoutMode = "icon" | "half" | "full";
  type ActionRevealState = {
    send: ActionLabelMode;
    reasoning: ActionLabelMode;
    model: ModelLabelMode;
    screenshot: ActionLabelMode;
    selectText: ActionLabelMode;
  };

  const setActionButtonLabel = (
    button: HTMLButtonElement | null,
    expandedLabel: string,
    compactLabel: string,
    mode: ActionLabelMode,
  ) => {
    if (!button) return;
    const nextLabel = mode === "icon" ? compactLabel : expandedLabel;
    if (button.textContent !== nextLabel) {
      button.textContent = nextLabel;
    }
    button.classList.toggle("llm-action-icon-only", mode === "icon");
  };

  const setSendButtonLabel = (mode: ActionLabelMode) => {
    setActionButtonLabel(sendBtn, "Send", "↑", mode);
    sendBtn.title = "Send";
    setActionButtonLabel(cancelBtn, "Cancel", "X", mode);
    if (cancelBtn) {
      cancelBtn.title = "Cancel";
    }
  };

  const setPanelActionLayoutMode = (mode: ActionLayoutMode) => {
    if (panelRoot.dataset.llmActionLayoutMode !== mode) {
      panelRoot.dataset.llmActionLayoutMode = mode;
    }
  };

  let layoutRetryScheduled = false;
  const applyResponsiveActionButtonsLayout = () => {
    if (!modelBtn || !actionsLeft) return;
    const modelLabel = modelBtn.dataset.modelLabel || "default";
    const modelHint = modelBtn.dataset.modelHint || "";
    const modelCanUseTwoLineWrap =
      [...(modelLabel || "").trim()].length >
      ACTION_LAYOUT_MODEL_WRAP_MIN_CHARS;
    const reasoningLabel =
      reasoningBtn?.dataset.reasoningLabel ||
      reasoningBtn?.textContent ||
      "off";
    const reasoningHint = reasoningBtn?.dataset.reasoningHint || "";

    const immediateAvailableWidth = (() => {
      const rowWidth = actionsRow?.clientWidth || 0;
      if (rowWidth > 0) return rowWidth;
      const leftWidth = actionsLeft.clientWidth || 0;
      if (leftWidth > 0) return leftWidth;
      return panelRoot?.clientWidth || 0;
    })();
    if (immediateAvailableWidth <= 0) {
      const view = body.ownerDocument?.defaultView;
      if (view && !layoutRetryScheduled) {
        layoutRetryScheduled = true;
        view.requestAnimationFrame(() => {
          layoutRetryScheduled = false;
          applyResponsiveActionButtonsLayout();
        });
      }
      return;
    }

    const getComputedSizePx = (
      style: CSSStyleDeclaration | null | undefined,
      property: string,
      fallback = 0,
    ) => {
      if (!style) return fallback;
      const value = Number.parseFloat(style.getPropertyValue(property));
      return Number.isFinite(value) ? value : fallback;
    };

    const textMeasureContext = (() => {
      const canvas = body.ownerDocument?.createElement(
        "canvas",
      ) as HTMLCanvasElement | null;
      return (
        (canvas?.getContext("2d") as CanvasRenderingContext2D | null) || null
      );
    })();

    const measureLabelTextWidth = (
      button: HTMLButtonElement | null,
      label: string,
    ) => {
      if (!button || !label) return 0;
      const view = body.ownerDocument?.defaultView;
      const style = view?.getComputedStyle(button);
      if (textMeasureContext && style) {
        const font =
          style.font && style.font !== ""
            ? style.font
            : `${style.fontWeight || "400"} ${style.fontSize || "12px"} ${style.fontFamily || "sans-serif"}`;
        textMeasureContext.font = font;
        return textMeasureContext.measureText(label).width;
      }
      return label.length * 8;
    };

    const getElementGapPx = (element: HTMLElement | null) => {
      if (!element) return 0;
      const view = body.ownerDocument?.defaultView;
      const style = view?.getComputedStyle(element);
      const columnGap = getComputedSizePx(style, "column-gap", NaN);
      if (Number.isFinite(columnGap)) return columnGap;
      return getComputedSizePx(style, "gap", 0);
    };

    const getButtonNaturalWidth = (
      button: HTMLButtonElement | null,
      label: string,
      maxLines = 1,
    ) => {
      if (!button) return 0;
      const view = body.ownerDocument?.defaultView;
      const style = view?.getComputedStyle(button);
      const textWidth = measureLabelTextWidth(button, label);
      const normalizedMaxLines = Math.max(1, Math.floor(maxLines));
      const wrappedTextWidth =
        normalizedMaxLines > 1
          ? (() => {
              const segments = label
                .split(/[\s._-]+/g)
                .map((segment) => segment.trim())
                .filter(Boolean);
              const longestSegmentWidth = segments.reduce((max, segment) => {
                return Math.max(max, measureLabelTextWidth(button, segment));
              }, 0);
              return Math.max(
                textWidth / normalizedMaxLines,
                longestSegmentWidth,
              );
            })()
          : textWidth;
      const paddingWidth =
        getComputedSizePx(style, "padding-left") +
        getComputedSizePx(style, "padding-right");
      const borderWidth =
        getComputedSizePx(style, "border-left-width") +
        getComputedSizePx(style, "border-right-width");
      const chevronAllowance =
        button === modelBtn || button === reasoningBtn ? 16 : 0;
      return Math.ceil(
        wrappedTextWidth + paddingWidth + borderWidth + chevronAllowance,
      );
    };

    const getSlotWidthBounds = (slot: HTMLElement | null) => {
      const view = body.ownerDocument?.defaultView;
      const style = slot ? view?.getComputedStyle(slot) : null;
      const minWidth = getComputedSizePx(style, "min-width", 0);
      const maxRaw = getComputedSizePx(
        style,
        "max-width",
        Number.POSITIVE_INFINITY,
      );
      const maxWidth = Number.isFinite(maxRaw)
        ? maxRaw
        : Number.POSITIVE_INFINITY;
      return { minWidth, maxWidth };
    };

    const getFullSlotRequiredWidth = (
      slot: HTMLElement | null,
      button: HTMLButtonElement | null,
      label: string,
      maxLines = 1,
    ) => {
      if (!button) return 0;
      const naturalWidth = getButtonNaturalWidth(button, label, maxLines);
      if (!slot) return naturalWidth;
      const { minWidth, maxWidth } = getSlotWidthBounds(slot);
      return Math.min(maxWidth, Math.max(minWidth, naturalWidth));
    };

    const getRenderedWidthPx = (
      element: HTMLElement | null,
      fallback: number,
    ) => {
      const width = element?.getBoundingClientRect?.().width || 0;
      return width > 0 ? Math.ceil(width) : fallback;
    };

    const getAvailableRowWidth = () => {
      const hostWidth = Math.ceil(
        (body as HTMLElement | null)?.getBoundingClientRect?.().width || 0,
      );
      const rowWidth = actionsRow?.clientWidth || 0;
      if (rowWidth > 0)
        return hostWidth > 0 ? Math.min(rowWidth, hostWidth) : rowWidth;
      const panelWidth = panelRoot?.clientWidth || 0;
      if (panelWidth > 0)
        return hostWidth > 0 ? Math.min(panelWidth, hostWidth) : panelWidth;
      const leftWidth = actionsLeft.clientWidth || 0;
      if (leftWidth > 0)
        return hostWidth > 0 ? Math.min(leftWidth, hostWidth) : leftWidth;
      return hostWidth;
    };

    const uploadSlot = uploadBtn?.parentElement as HTMLElement | null;
    const selectTextSlot = selectTextBtn?.parentElement as HTMLElement | null;
    const screenshotSlot = screenshotBtn?.parentElement as HTMLElement | null;
    const sendSlot = sendBtn?.parentElement as HTMLElement | null;

    const getModelWidth = (mode: ModelLabelMode) => {
      if (!modelBtn) return 0;
      if (mode === "icon") return ACTION_LAYOUT_DROPDOWN_ICON_WIDTH_PX;
      const maxLines =
        mode === "full-wrap2" ? ACTION_LAYOUT_MODEL_FULL_MAX_LINES : 1;
      return getFullSlotRequiredWidth(
        modelSlot,
        modelBtn,
        modelLabel,
        maxLines,
      );
    };

    const getReasoningWidth = (mode: ActionLabelMode) => {
      if (!reasoningBtn) return 0;
      return mode === "full"
        ? getFullSlotRequiredWidth(reasoningSlot, reasoningBtn, reasoningLabel)
        : ACTION_LAYOUT_DROPDOWN_ICON_WIDTH_PX;
    };

    const getContextButtonWidth = (
      slot: HTMLElement | null,
      button: HTMLButtonElement | null,
      expandedLabel: string,
      mode: ActionLabelMode,
    ) => {
      if (!button) return 0;
      return mode === "full"
        ? getFullSlotRequiredWidth(slot, button, expandedLabel)
        : ACTION_LAYOUT_CONTEXT_ICON_WIDTH_PX;
    };

    const getSendWidth = (mode: ActionLabelMode) => {
      if (!sendBtn) return 0;
      if (mode === "icon") {
        return ACTION_LAYOUT_CONTEXT_ICON_WIDTH_PX;
      }
      const sendWidth = getFullSlotRequiredWidth(sendSlot, sendBtn, "Send");
      const cancelWidth = getFullSlotRequiredWidth(
        sendSlot,
        cancelBtn,
        "Cancel",
      );
      return Math.max(sendWidth, cancelWidth, 72);
    };

    const getRequiredWidth = (state: ActionRevealState) => {
      const leftSlotWidths = [
        uploadBtn
          ? getRenderedWidthPx(
              uploadSlot || uploadBtn,
              Math.max(
                uploadBtn.scrollWidth || 0,
                ACTION_LAYOUT_CONTEXT_ICON_WIDTH_PX,
              ),
            )
          : 0,
        getContextButtonWidth(
          selectTextSlot,
          selectTextBtn,
          SELECT_TEXT_EXPANDED_LABEL,
          state.selectText,
        ),
        getContextButtonWidth(
          screenshotSlot,
          screenshotBtn,
          SCREENSHOT_EXPANDED_LABEL,
          state.screenshot,
        ),
        getModelWidth(state.model),
        getReasoningWidth(state.reasoning),
      ].filter((width) => width > 0);
      const leftGap = getElementGapPx(actionsLeft);
      const leftRequiredWidth =
        leftSlotWidths.reduce((sum, width) => sum + width, 0) +
        Math.max(0, leftSlotWidths.length - 1) * leftGap;
      const rightRequiredWidth = getSendWidth(state.send);
      const rowGap = getElementGapPx(actionsRow);
      return leftRequiredWidth + rightRequiredWidth + rowGap;
    };

    const doesStateFit = (state: ActionRevealState) =>
      getAvailableRowWidth() + 1 >= getRequiredWidth(state);

    const getPanelLayoutMode = (state: ActionRevealState): ActionLayoutMode => {
      if (state.selectText === "full") {
        return "full";
      }
      if (
        state.screenshot === "full" ||
        state.model !== "icon" ||
        state.reasoning === "full"
      ) {
        return "half";
      }
      return "icon";
    };

    const applyMeasurementBaseline = () => {
      // Normalize controls into a stable full-text style before measuring.
      // This keeps width estimation independent from the currently rendered
      // icon/full state and prevents flip-flopping around thresholds.
      setActionButtonLabel(
        uploadBtn,
        UPLOAD_FILE_EXPANDED_LABEL,
        UPLOAD_FILE_COMPACT_LABEL,
        "icon",
      );
      setActionButtonLabel(
        selectTextBtn,
        SELECT_TEXT_EXPANDED_LABEL,
        SELECT_TEXT_COMPACT_LABEL,
        "full",
      );
      setActionButtonLabel(
        screenshotBtn,
        SCREENSHOT_EXPANDED_LABEL,
        SCREENSHOT_COMPACT_LABEL,
        "full",
      );
      setSendButtonLabel("full");

      modelBtn.classList.toggle("llm-model-btn-collapsed", false);
      modelSlot?.classList.toggle("llm-model-dropdown-collapsed", false);
      modelBtn.classList.toggle("llm-model-btn-wrap-2line", false);
      modelBtn.textContent = modelLabel;
      modelBtn.title = modelHint;

      if (reasoningBtn) {
        reasoningBtn.classList.toggle("llm-reasoning-btn-collapsed", false);
        reasoningSlot?.classList.toggle(
          "llm-reasoning-dropdown-collapsed",
          false,
        );
        reasoningBtn.textContent = reasoningLabel;
        reasoningBtn.title = reasoningHint;
      }
    };

    const applyState = (state: ActionRevealState) => {
      setActionButtonLabel(
        uploadBtn,
        UPLOAD_FILE_EXPANDED_LABEL,
        UPLOAD_FILE_COMPACT_LABEL,
        "icon",
      );
      setActionButtonLabel(
        selectTextBtn,
        SELECT_TEXT_EXPANDED_LABEL,
        SELECT_TEXT_COMPACT_LABEL,
        state.selectText,
      );
      setActionButtonLabel(
        screenshotBtn,
        SCREENSHOT_EXPANDED_LABEL,
        SCREENSHOT_COMPACT_LABEL,
        state.screenshot,
      );
      setSendButtonLabel(state.send);

      const modelCollapsed = state.model === "icon";
      modelBtn.classList.toggle("llm-model-btn-collapsed", modelCollapsed);
      modelSlot?.classList.toggle(
        "llm-model-dropdown-collapsed",
        modelCollapsed,
      );
      modelBtn.classList.toggle(
        "llm-model-btn-wrap-2line",
        state.model === "full-wrap2",
      );
      if (modelCollapsed) {
        modelBtn.textContent = "";
        modelBtn.title = modelHint ? `${modelLabel}\n${modelHint}` : modelLabel;
      } else {
        modelBtn.textContent = modelLabel;
        modelBtn.title = modelHint;
      }

      if (reasoningBtn) {
        const reasoningCollapsed = state.reasoning === "icon";
        reasoningBtn.classList.toggle(
          "llm-reasoning-btn-collapsed",
          reasoningCollapsed,
        );
        reasoningSlot?.classList.toggle(
          "llm-reasoning-dropdown-collapsed",
          reasoningCollapsed,
        );
        if (!reasoningCollapsed) {
          reasoningBtn.textContent = reasoningLabel;
          reasoningBtn.title = reasoningHint;
        } else {
          reasoningBtn.textContent = REASONING_COMPACT_LABEL;
          reasoningBtn.title = reasoningHint
            ? `${reasoningLabel}\n${reasoningHint}`
            : reasoningLabel;
        }
      }

      setPanelActionLayoutMode(getPanelLayoutMode(state));
    };

    const widestState: ActionRevealState = {
      send: "full",
      reasoning: "full",
      model: "full-single",
      screenshot: "full",
      selectText: "full",
    };
    const screenshotState: ActionRevealState = {
      send: "full",
      reasoning: "full",
      model: "full-single",
      screenshot: "full",
      selectText: "icon",
    };
    const modelState: ActionRevealState = {
      send: "full",
      reasoning: "full",
      model: "full-single",
      screenshot: "icon",
      selectText: "icon",
    };
    const reasoningState: ActionRevealState = {
      send: "full",
      reasoning: "full",
      model: "icon",
      screenshot: "icon",
      selectText: "icon",
    };
    const sendState: ActionRevealState = {
      send: "full",
      reasoning: "icon",
      model: "icon",
      screenshot: "icon",
      selectText: "icon",
    };
    const iconOnlyState: ActionRevealState = {
      send: "icon",
      reasoning: "icon",
      model: "icon",
      screenshot: "icon",
      selectText: "icon",
    };

    // Reveal order as width grows:
    // send/cancel -> reasoning -> model -> screenshots -> add text.
    const candidateStates: ActionRevealState[] = [
      widestState,
      screenshotState,
      modelState,
      reasoningState,
      sendState,
      iconOnlyState,
    ];

    if (modelCanUseTwoLineWrap) {
      candidateStates.splice(
        1,
        0,
        { ...widestState, model: "full-wrap2" },
        { ...screenshotState, model: "full-wrap2" },
        { ...modelState, model: "full-wrap2" },
      );
    }

    applyMeasurementBaseline();
    for (const state of candidateStates) {
      if (!doesStateFit(state)) continue;
      applyState(state);
      return;
    }

    applyState(iconOnlyState);
  };

  const updateModelButton = () => {
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
      applyResponsiveActionButtonsLayout();
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
    appendDropdownInstruction(modelMenu, "Select model", "llm-model-menu-hint");
    if (!groupedChoices.length) {
      appendModelMenuEmptyState(modelMenu, "No models configured yet.");
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
          setSelectedModelEntryForItem(item.id, entry.entryId);
          setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, false);
          setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
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
          group.entries.filter((entry) => entry.model === latestAssistantModelName),
        )
      : [];
    retryModelMenu.innerHTML = "";
    if (!groupedChoices.length) {
      appendModelMenuEmptyState(retryModelMenu, "No models configured yet.");
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
          );
          const retryAdvanced = getAdvancedModelParams(entry.entryId);
          await retryLatestAssistantResponse(
            body,
            item,
            entry.model,
            entry.apiBase,
            entry.apiKey,
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
    const selectedProfile = getSelectedModelEntryForItem(item.id);
    const provider = detectReasoningProvider(currentModel);
    const options = getReasoningOptions(
      provider,
      currentModel,
      selectedProfile?.apiBase,
    );
    const enabledLevels = options
      .filter((option) => option.enabled)
      .map((option) => option.level);
    let selectedLevel =
      selectedReasoningCache.get(item.id) ||
      getLastUsedReasoningLevel() ||
      "none";
    if (enabledLevels.length > 0) {
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
    return { provider, currentModel, options, enabledLevels, selectedLevel };
  };

  const updateReasoningButton = () => {
    if (!item || !reasoningBtn) return;
    withScrollGuard(chatBox, conversationKey, () => {
      const { provider, currentModel, options, enabledLevels, selectedLevel } =
        getReasoningState();
      const available = enabledLevels.length > 0;
      const resolvedReasoningLabel = available
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
      applyResponsiveActionButtonsLayout();
    });
  };

  const rebuildReasoningMenu = () => {
    if (!item || !reasoningMenu) return;
    const { provider, currentModel, options, selectedLevel, enabledLevels } =
      getReasoningState();
    reasoningMenu.innerHTML = "";
    appendDropdownInstruction(
      reasoningMenu,
      "Reasoning level",
      "llm-reasoning-menu-section",
    );
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
        selectedReasoningCache.clear();
        selectedReasoningCache.set(item.id, "none");
        setLastUsedReasoningLevel("none");
        setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
        updateReasoningButton();
      };
      offOption.addEventListener("pointerdown", applyOffSelection);
      offOption.addEventListener("click", applyOffSelection);
      reasoningMenu.appendChild(offOption);
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
          selectedReasoningCache.clear();
          selectedReasoningCache.set(item.id, level);
          setLastUsedReasoningLevel(level);
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

  // Initialize preview state
  updatePaperPreviewPreservingScroll();
  updateFilePreviewPreservingScroll();
  updateImagePreviewPreservingScroll();
  updateSelectedTextPreviewPreservingScroll();
  syncModelFromPrefs();
  restoreDraftInputForCurrentConversation();
  if (isNoteSession()) {
    void refreshGlobalHistoryHeader();
  } else if (isPaperMode()) {
    void switchPaperConversation().catch((err) => {
      ztoolkit.log("LLM: Failed to restore paper conversation session", err);
    });
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
    const ro = new ResizeObserverCtor(() => {
      // Wrap layout mutations in scroll guard so that flex-driven
      // resize of .llm-messages doesn't corrupt the scroll snapshot.
      withScrollGuard(
        chatBox,
        conversationKey,
        () => {
          applyResponsiveActionButtonsLayout();
          syncUserContextAlignmentWidths(body);
        },
        "relative",
      );
    });
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
      chatBoxResizeObserver.observe(chatBox);
    }
  }

  const getSelectedProfile = () => {
    if (!item) return null;
    return getSelectedModelEntryForItem(item.id);
  };

  const getAdvancedModelParams = (
    entryId: string | undefined,
  ): AdvancedModelParams | undefined => {
    if (!entryId) return undefined;
    return getAdvancedModelParamsForEntry(entryId);
  };

  const getSelectedReasoning = (): LLMReasoningConfig | undefined => {
    if (!item) return undefined;
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

  type ActiveSlashToken = PaperSearchSlashToken;
  type PaperPickerMode = "browse" | "search" | "empty";
  type PaperPickerRow =
    | {
        kind: "collection";
        collectionId: number;
        depth: number;
      }
    | {
        kind: "paper";
        itemId: number;
        depth: number;
      }
    | {
        kind: "attachment";
        itemId: number;
        attachmentIndex: number;
        depth: number;
      };
  let paperPickerMode: PaperPickerMode = "browse";
  let paperPickerEmptyMessage = "No references available.";
  let paperPickerGroups: PaperSearchGroupCandidate[] = [];
  let paperPickerCollections: PaperBrowseCollectionCandidate[] = [];
  let paperPickerGroupByItemId = new Map<number, PaperSearchGroupCandidate>();
  let paperPickerCollectionById = new Map<
    number,
    PaperBrowseCollectionCandidate
  >();
  let paperPickerExpandedPaperKeys = new Set<number>();
  let paperPickerExpandedCollectionKeys = new Set<number>();
  let paperPickerRows: PaperPickerRow[] = [];
  let paperPickerActiveRowIndex = 0;
  let paperPickerRequestSeq = 0;
  let paperPickerDebounceTimer: number | null = null;
  const clearPaperPickerDebounceTimer = () => {
    if (paperPickerDebounceTimer === null) return;
    const win = body.ownerDocument?.defaultView;
    if (win) {
      win.clearTimeout(paperPickerDebounceTimer);
    } else {
      clearTimeout(paperPickerDebounceTimer);
    }
    paperPickerDebounceTimer = null;
  };
  const resetPaperPickerState = () => {
    paperPickerMode = "browse";
    paperPickerEmptyMessage = "No references available.";
    paperPickerGroups = [];
    paperPickerCollections = [];
    paperPickerGroupByItemId = new Map<number, PaperSearchGroupCandidate>();
    paperPickerCollectionById = new Map<
      number,
      PaperBrowseCollectionCandidate
    >();
    paperPickerExpandedPaperKeys = new Set<number>();
    paperPickerExpandedCollectionKeys = new Set<number>();
    paperPickerRows = [];
    paperPickerActiveRowIndex = 0;
  };
  // Paper picker is now triggered by '@'; action picker is triggered by '/'
  const getActiveAtToken = (): ActiveSlashToken | null => {
    const caretEnd =
      typeof inputBox.selectionStart === "number"
        ? inputBox.selectionStart
        : inputBox.value.length;
    return parseAtSearchToken(inputBox.value, caretEnd);
  };
  const getActiveSlashToken = (): ActiveSlashToken | null =>
    getActiveAtToken();
  const getActiveActionToken = (): ActiveSlashToken | null => {
    const caretEnd =
      typeof inputBox.selectionStart === "number"
        ? inputBox.selectionStart
        : inputBox.value.length;
    return parsePaperSearchSlashToken(inputBox.value, caretEnd);
  };
  const isPaperPickerOpen = () =>
    Boolean(paperPicker && paperPicker.style.display !== "none");
  const closePaperPicker = () => {
    paperPickerRequestSeq += 1;
    clearPaperPickerDebounceTimer();
    resetPaperPickerState();
    if (paperPicker) {
      paperPicker.style.display = "none";
    }
    if (paperPickerList) {
      paperPickerList.innerHTML = "";
    }
  };
  // ── Slash menu keyboard navigation ────────────────────────────────────────
  let slashMenuActiveIndex = -1;
  const clearAgentSlashItems = () => {
    if (!slashMenu) return;
    Array.from(slashMenu.querySelectorAll("[data-slash-agent-item]")).forEach(
      (el) => (el as Element).remove(),
    );
  };
  const getVisibleSlashItems = (): HTMLButtonElement[] => {
    if (!slashMenu) return [];
    const win = body.ownerDocument?.defaultView;
    return Array.from(
      slashMenu.querySelectorAll(".llm-action-picker-item"),
    ).filter((el) => {
      const style = win?.getComputedStyle(el as Element);
      return style ? style.display !== "none" : true;
    }) as HTMLButtonElement[];
  };
  const updateSlashMenuSelection = () => {
    const items = getVisibleSlashItems();
    items.forEach((item, idx) => {
      item.setAttribute(
        "aria-selected",
        idx === slashMenuActiveIndex ? "true" : "false",
      );
    });
    if (slashMenuActiveIndex >= 0 && items[slashMenuActiveIndex] && slashMenu) {
      const activeItem = items[slashMenuActiveIndex];
      // Walk offsetParent chain to get offset relative to the scroll container
      let offsetTop = 0;
      let el: HTMLElement | null = activeItem;
      while (el && el !== slashMenu) {
        offsetTop += el.offsetTop;
        el = el.offsetParent as HTMLElement | null;
      }
      const itemBottom = offsetTop + activeItem.offsetHeight;
      if (offsetTop < slashMenu.scrollTop) {
        slashMenu.scrollTop = offsetTop;
      } else if (itemBottom > slashMenu.scrollTop + slashMenu.clientHeight) {
        slashMenu.scrollTop = itemBottom - slashMenu.clientHeight;
      }
    }
  };
  const openSlashMenuWithSelection = () => {
    slashMenuActiveIndex = 0;
    setFloatingMenuOpen(slashMenu, SLASH_MENU_OPEN_CLASS, true);
    updateSlashMenuSelection();
  };
  const selectActiveSlashMenuItem = () => {
    const items = getVisibleSlashItems();
    if (slashMenuActiveIndex >= 0 && items[slashMenuActiveIndex]) {
      items[slashMenuActiveIndex].click();
    }
  };

  // ── Action picker ─────────────────────────────────────────────────────────
  type ActionPickerItem = { name: string; description: string; inputSchema: object };
  let actionPickerItems: ActionPickerItem[] = [];
  let actionPickerActiveIndex = 0;
  const isActionPickerOpen = () =>
    Boolean(actionPicker && actionPicker.style.display !== "none");
  const closeActionPicker = () => {
    if (actionPicker) actionPicker.style.display = "none";
    if (actionPickerList) actionPickerList.innerHTML = "";
    actionPickerItems = [];
    actionPickerActiveIndex = 0;
  };
  const formatActionLabel = (name: string): string =>
    name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  /** Renders the action picker dropdown. */
  const renderActionPicker = () => {
    if (!actionPicker || !actionPickerList) return;
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc) return;
    actionPickerList.innerHTML = "";
    if (!actionPickerItems.length) {
      const empty = createElement(ownerDoc, "div", "llm-action-picker-empty", {
        textContent: "No actions matched.",
      });
      actionPickerList.appendChild(empty);
      actionPicker.style.display = "block";
      return;
    }
    actionPickerItems.forEach((action, idx) => {
      const option = createElement(ownerDoc, "div", "llm-action-picker-item", {});
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", idx === actionPickerActiveIndex ? "true" : "false");
      option.tabIndex = -1;
      const titleEl = createElement(ownerDoc, "div", "llm-action-picker-title", {
        textContent: formatActionLabel(action.name),
      });
      const descEl = createElement(ownerDoc, "div", "llm-action-picker-description", {
        textContent: action.description,
      });
      option.append(titleEl, descEl);
      option.addEventListener("mousedown", (e: Event) => {
        e.preventDefault();
        actionPickerActiveIndex = idx;
        void selectActionPickerItem(idx);
      });
      actionPickerList.appendChild(option);
    });
    actionPicker.style.display = "block";
  };

  /** Populates the slash menu (and, in agent mode, appends agent actions). */
  const scheduleActionPickerTrigger = () => {
    if (!item) {
      closeActionPicker();
      return;
    }
    closeActionPicker();
    const token = getActiveActionToken();
    if (!token) {
      closeSlashMenu();
      return;
    }
    // Agent mode: render filtered agent actions into slash menu
    if (getCurrentRuntimeMode() === "agent") {
      const query = token.query.toLowerCase().trim();
      renderAgentActionsInSlashMenu(query);
    }
    if (!isFloatingMenuOpen(slashMenu)) {
      closeRetryModelMenu();
      closeModelMenu();
      closeReasoningMenu();
      closeHistoryNewMenu();
      closeHistoryMenu();
      closeResponseMenu();
      closePromptMenu();
      closeExportMenu();
      openSlashMenuWithSelection();
    } else {
      // Already open — re-render selection after agent items may have changed
      slashMenuActiveIndex = 0;
      updateSlashMenuSelection();
    }
  };

  // ── Action HITL panel ──────────────────────────────────────────────────────
  const closeActionHitlPanel = () => {
    if (actionHitlPanel) {
      actionHitlPanel.style.display = "none";
      actionHitlPanel.innerHTML = "";
    }
    chatBox?.querySelector(".llm-action-inline-card")?.remove();
  };

  const showActionHitlCard = (requestId: string, action: AgentPendingAction): Promise<AgentConfirmationResolution> => {
    return new Promise((resolve) => {
      getAgentApi().registerPendingConfirmation(requestId, (resolution) => {
        closeActionHitlPanel();
        resolve(resolution);
      });
      const ownerDoc = body.ownerDocument;
      if (ownerDoc && chatBox) {
        chatBox.querySelector(".llm-action-inline-card")?.remove();
        const wrapper = ownerDoc.createElement("div");
        wrapper.className = "llm-action-inline-card";
        const card = renderPendingActionCard(ownerDoc, { requestId, action });
        wrapper.appendChild(card);
        chatBox.appendChild(wrapper);
        chatBox.scrollTop = chatBox.scrollHeight;
      }
    });
  };

  // ── Action launch form ─────────────────────────────────────────────────────
  /**
   * Returns the required fields that cannot be auto-filled from context.
   * `itemId` is auto-filled from the current item. All other required fields
   * need user input.
   */
  const getNeedsUserInputFields = (actionName: string, schema: object): string[] => {
    const s = schema as { required?: string[] };
    if (!s.required?.length) return [];
    const autoFillable = new Set(["itemId"]);
    return s.required.filter((f) => !autoFillable.has(f));
  };

  /**
   * Resolves the initial input for an action. Auto-fills `itemId` from context.
   */
  const buildActionInput = (actionName: string, schema: object, extraFields: Record<string, string>): Record<string, unknown> => {
    const input: Record<string, unknown> = { ...extraFields };
    const s = schema as { required?: string[] };
    if (s.required?.includes("itemId") && item) {
      input.itemId = item.id;
    }
    return input;
  };

  /**
   * Shows an inline launch form for actions that require user-provided fields
   * when their required inputs cannot be derived from the current context.
   * Returns a promise that resolves with the filled input, or null if cancelled.
   */
  const showActionLaunchForm = (
    actionName: string,
    requiredFields: string[],
    schema: object,
  ): Promise<Record<string, unknown> | null> => {
    return new Promise((resolve) => {
      const ownerDoc = body.ownerDocument;
      if (!ownerDoc || !chatBox) {
        resolve(null);
        return;
      }
      const props = (schema as { properties?: Record<string, { description?: string }> }).properties || {};
      chatBox.querySelector(".llm-action-inline-card")?.remove();
      const wrapper = ownerDoc.createElement("div");
      wrapper.className = "llm-action-inline-card";
      const form = createElement(ownerDoc, "div", "llm-action-launch-form", {});
      const header = createElement(ownerDoc, "div", "llm-action-launch-form-header", {
        textContent: formatActionLabel(actionName),
      });
      form.appendChild(header);
      const fieldEls: Array<{ name: string; input: HTMLInputElement | HTMLTextAreaElement }> = [];
      for (const fieldName of requiredFields) {
        const label = createElement(ownerDoc, "label", "llm-action-launch-form-label", {
          textContent: props[fieldName]?.description ?? fieldName,
        });
        const input = createElement(ownerDoc, "textarea", "llm-action-launch-form-input llm-input", {
          placeholder: fieldName,
        }) as HTMLTextAreaElement;
        input.rows = 2;
        form.append(label, input);
        fieldEls.push({ name: fieldName, input });
      }
      const btns = createElement(ownerDoc, "div", "llm-action-launch-form-btns", {});
      const runBtn = createElement(ownerDoc, "button", "llm-action-launch-form-run-btn", {
        textContent: "Run",
        type: "button",
      }) as HTMLButtonElement;
      const cancelBtn2 = createElement(ownerDoc, "button", "llm-action-launch-form-cancel-btn", {
        textContent: "Cancel",
        type: "button",
      }) as HTMLButtonElement;
      btns.append(runBtn, cancelBtn2);
      form.appendChild(btns);
      wrapper.appendChild(form);
      const dismiss = () => {
        closeActionHitlPanel();
        inputBox.focus({ preventScroll: true });
      };
      runBtn.addEventListener("click", () => {
        const filled: Record<string, unknown> = {};
        for (const { name, input } of fieldEls) {
          filled[name] = input.value.trim();
        }
        dismiss();
        resolve(filled);
      });
      cancelBtn2.addEventListener("click", () => {
        dismiss();
        resolve(null);
      });
      chatBox.appendChild(wrapper);
      chatBox.scrollTop = chatBox.scrollHeight;
      // Focus first field
      fieldEls[0]?.input.focus();
    });
  };

  /** Core action execution — shared between action picker and slash menu. */
  const executeAgentAction = async (action: ActionPickerItem): Promise<void> => {
    inputBox.focus({ preventScroll: true });
    const needsInput = getNeedsUserInputFields(action.name, action.inputSchema);
    let extraFields: Record<string, string> = {};
    if (needsInput.length) {
      const filled = await showActionLaunchForm(action.name, needsInput, action.inputSchema);
      if (!filled) return;
      extraFields = Object.fromEntries(
        Object.entries(filled).map(([k, v]) => [k, String(v)]),
      );
    }
    const input = buildActionInput(action.name, action.inputSchema, extraFields);
    if (status) setStatus(status, `Running: ${formatActionLabel(action.name)}…`, "ready");
    try {
      const agentApi = getAgentApi();
      const result = await agentApi.runAction(action.name, input, {
        confirmationMode: "native_ui",
        onProgress: (event) => {
          if (event.type === "step_start" && status) {
            setStatus(status, `${event.step} (${event.index}/${event.total})`, "ready");
          } else if (event.type === "step_done" && event.summary && status) {
            setStatus(status, event.summary, "ready");
          }
        },
        requestConfirmation: (requestId, pendingAction) =>
          showActionHitlCard(requestId, pendingAction),
      });
      if (status) {
        setStatus(
          status,
          result.ok
            ? `${formatActionLabel(action.name)} complete`
            : `${formatActionLabel(action.name)} failed: ${result.error}`,
          result.ok ? "ready" : "error",
        );
      }
    } catch (err) {
      ztoolkit.log("LLM: action picker run error", err);
      if (status) setStatus(status, `Error: ${String(err)}`, "error");
    }
  };

  /** Prepends filtered agent actions into the slash menu (agent mode only). */
  const renderAgentActionsInSlashMenu = (query: string = "") => {
    clearAgentSlashItems();
    let allActions: ActionPickerItem[] = [];
    try {
      allActions = getAgentApi().listActions();
    } catch {
      return;
    }
    const filtered = query
      ? allActions.filter(
          (a) =>
            a.name.toLowerCase().includes(query) ||
            a.description.toLowerCase().includes(query),
        )
      : allActions;
    const ownerDoc = body.ownerDocument;
    const list = slashMenu?.querySelector(".llm-action-picker-list");
    if (!ownerDoc || !list) return;
    const firstBase = list.firstChild;
    const mkAgentEl = (tag: string, cls: string): HTMLElement => {
      const el = ownerDoc.createElement(tag);
      el.className = cls;
      el.setAttribute("data-slash-agent-item", "true");
      return el;
    };
    // "Agent actions" section label
    const agentLabel = mkAgentEl("div", "llm-slash-menu-section");
    agentLabel.setAttribute("aria-hidden", "true");
    agentLabel.textContent = "Agent actions";
    list.insertBefore(agentLabel, firstBase);
    // Agent action items
    filtered.forEach((action) => {
      const btn = mkAgentEl("button", "llm-action-picker-item") as HTMLButtonElement;
      btn.type = "button";
      const titleEl = ownerDoc.createElement("span");
      titleEl.className = "llm-action-picker-title";
      titleEl.textContent = formatActionLabel(action.name);
      const descEl = ownerDoc.createElement("span");
      descEl.className = "llm-action-picker-description";
      descEl.textContent = action.description;
      btn.append(titleEl, descEl);
      btn.addEventListener("mousedown", (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        consumeActiveActionToken();
        closeSlashMenu();
        void executeAgentAction(action);
      });
      list.insertBefore(btn, firstBase);
    });
    // "Base actions" section label (above the static base items)
    const baseLabel = mkAgentEl("div", "llm-slash-menu-section");
    baseLabel.setAttribute("aria-hidden", "true");
    baseLabel.textContent = "Base actions";
    list.insertBefore(baseLabel, firstBase);
  };

  /** Selects an action from the (legacy) action picker by index. */
  const selectActionPickerItem = async (index: number): Promise<void> => {
    const action = actionPickerItems[index];
    if (!action) return;
    consumeActiveActionToken();
    closeActionPicker();
    await executeAgentAction(action);
  };

  function buildPaperMetaText(paper: {
    citationKey?: string;
    firstCreator?: string;
    year?: string;
  }): string {
    const parts = [
      paper.firstCreator || "",
      paper.year || "",
      paper.citationKey || "",
    ].filter(Boolean);
    return parts.join(" · ");
  }
  function resolvePickerItemKind(
    contentType?: string,
  ): "pdf" | "note" | "figure" | "other" {
    if (!contentType) return "other";
    if (contentType === "application/pdf") return "pdf";
    if (contentType === ZOTERO_NOTE_CONTENT_TYPE) return "note";
    if (contentType.startsWith("image/")) return "figure";
    return "other";
  }
  function resolvePickerKindIcon(kind: "pdf" | "note" | "figure" | "other"): string {
    if (kind === "pdf") return "📚";
    if (kind === "note") return "📝";
    if (kind === "figure") return "🖼";
    return "📎";
  }
  function resolvePickerKindLabel(kind: "pdf" | "note" | "figure" | "other"): string {
    if (kind === "pdf") return "PDF";
    if (kind === "note") return "Note";
    if (kind === "figure") return "Figure";
    return "File";
  }
  function resolveGroupIcon(group: PaperSearchGroupCandidate): string {
    if (group.itemKind === "standalone-note") return "📝";
    const hasPdf = group.attachments.some(
      (a) => resolvePickerItemKind(a.contentType) === "pdf",
    );
    if (hasPdf) return "📚";
    const hasFigure = group.attachments.some(
      (a) => resolvePickerItemKind(a.contentType) === "figure",
    );
    if (hasFigure) return "🖼";
    const hasNote = group.attachments.some(
      (a) => resolvePickerItemKind(a.contentType) === "note",
    );
    if (hasNote) return "📝";
    if (group.attachments.length > 0) return "📎";
    return "📄";
  }
  const getPaperPickerAttachmentDisplayTitle = (
    group: PaperSearchGroupCandidate,
    attachment: PaperSearchAttachmentCandidate,
    attachmentIndex: number,
  ): string => {
    const normalizedTitle = sanitizeText(attachment.title || "").trim();
    if (normalizedTitle) return normalizedTitle;
    const kind = resolvePickerItemKind(attachment.contentType);
    return group.attachments.length > 1
      ? `${resolvePickerKindLabel(kind)} ${attachmentIndex + 1}`
      : resolvePickerKindLabel(kind);
  };
  const getPaperPickerGroupByItemId = (
    itemId: number,
  ): PaperSearchGroupCandidate | null =>
    paperPickerGroupByItemId.get(itemId) || null;
  const getPaperPickerCollectionById = (
    collectionId: number,
  ): PaperBrowseCollectionCandidate | null =>
    paperPickerCollectionById.get(collectionId) || null;
  const isPaperPickerGroupExpanded = (itemId: number): boolean => {
    const group = getPaperPickerGroupByItemId(itemId);
    if (!group || group.attachments.length <= 1) return false;
    return paperPickerExpandedPaperKeys.has(itemId);
  };
  const isPaperPickerCollectionExpanded = (collectionId: number): boolean =>
    paperPickerExpandedCollectionKeys.has(collectionId);
  const togglePaperPickerGroupExpanded = (
    itemId: number,
    expanded?: boolean,
  ): boolean => {
    const group = getPaperPickerGroupByItemId(itemId);
    if (!group || group.attachments.length <= 1) return false;
    const currentlyExpanded = paperPickerExpandedPaperKeys.has(itemId);
    const nextExpanded = expanded === undefined ? !currentlyExpanded : expanded;
    if (nextExpanded === currentlyExpanded) return false;
    if (nextExpanded) {
      paperPickerExpandedPaperKeys.add(itemId);
    } else {
      paperPickerExpandedPaperKeys.delete(itemId);
    }
    rebuildPaperPickerRows();
    return true;
  };
  const togglePaperPickerCollectionExpanded = (
    collectionId: number,
    expanded?: boolean,
  ): boolean => {
    const collection = getPaperPickerCollectionById(collectionId);
    if (!collection) return false;
    const currentlyExpanded =
      paperPickerExpandedCollectionKeys.has(collectionId);
    const nextExpanded = expanded === undefined ? !currentlyExpanded : expanded;
    if (nextExpanded === currentlyExpanded) return false;
    if (nextExpanded) {
      paperPickerExpandedCollectionKeys.add(collectionId);
    } else {
      paperPickerExpandedCollectionKeys.delete(collectionId);
    }
    rebuildPaperPickerRows();
    return true;
  };
  const setPaperPickerSearchGroups = (
    groups: PaperSearchGroupCandidate[],
  ): void => {
    paperPickerMode = groups.length ? "search" : "empty";
    paperPickerEmptyMessage = "No papers matched.";
    paperPickerGroups = groups;
    paperPickerCollections = [];
    paperPickerGroupByItemId = new Map<number, PaperSearchGroupCandidate>();
    paperPickerCollectionById = new Map<
      number,
      PaperBrowseCollectionCandidate
    >();
    paperPickerExpandedPaperKeys = new Set<number>();
    paperPickerExpandedCollectionKeys = new Set<number>();
    for (const group of groups) {
      paperPickerGroupByItemId.set(group.itemId, group);
    }
  };
  const setPaperPickerCollections = (
    collections: PaperBrowseCollectionCandidate[],
  ): void => {
    paperPickerMode = collections.length ? "browse" : "empty";
    paperPickerEmptyMessage = "No references available.";
    paperPickerGroups = [];
    paperPickerCollections = collections;
    paperPickerGroupByItemId = new Map<number, PaperSearchGroupCandidate>();
    paperPickerCollectionById = new Map<
      number,
      PaperBrowseCollectionCandidate
    >();
    paperPickerExpandedPaperKeys = new Set<number>();
    paperPickerExpandedCollectionKeys = new Set<number>();

    const registerCollection = (collection: PaperBrowseCollectionCandidate) => {
      paperPickerCollectionById.set(collection.collectionId, collection);
      for (const paper of collection.papers) {
        paperPickerGroupByItemId.set(paper.itemId, paper);
      }
      for (const child of collection.childCollections) {
        registerCollection(child);
      }
    };
    for (const collection of collections) {
      registerCollection(collection);
    }
  };
  const rebuildPaperPickerRows = () => {
    const rows: PaperPickerRow[] = [];
    const appendPaperRow = (
      group: PaperSearchGroupCandidate,
      depth: number,
    ) => {
      rows.push({
        kind: "paper",
        itemId: group.itemId,
        depth,
      });
      if (group.attachments.length <= 1) return;
      if (!isPaperPickerGroupExpanded(group.itemId)) return;
      group.attachments.forEach((_attachment, attachmentIndex) => {
        rows.push({
          kind: "attachment",
          itemId: group.itemId,
          attachmentIndex,
          depth: depth + 1,
        });
      });
    };
    const appendCollectionRows = (
      collections: PaperBrowseCollectionCandidate[],
      depth: number,
    ) => {
      for (const collection of collections) {
        rows.push({
          kind: "collection",
          collectionId: collection.collectionId,
          depth,
        });
        if (!isPaperPickerCollectionExpanded(collection.collectionId)) continue;
        appendCollectionRows(collection.childCollections, depth + 1);
        for (const paper of collection.papers) {
          appendPaperRow(paper, depth + 1);
        }
      }
    };

    if (paperPickerMode === "browse") {
      appendCollectionRows(paperPickerCollections, 0);
    } else if (paperPickerMode === "search") {
      paperPickerGroups.forEach((group) => {
        appendPaperRow(group, 0);
      });
    }

    paperPickerRows = rows;
    if (!paperPickerRows.length) {
      paperPickerActiveRowIndex = 0;
      return;
    }
    paperPickerActiveRowIndex = Math.max(
      0,
      Math.min(paperPickerRows.length - 1, paperPickerActiveRowIndex),
    );
  };
  const getPaperPickerRowAt = (index: number): PaperPickerRow | null =>
    paperPickerRows[index] || null;
  const findPaperPickerPaperRowIndex = (itemId: number): number => {
    for (let index = 0; index < paperPickerRows.length; index += 1) {
      const row = paperPickerRows[index];
      if (row.kind === "paper" && row.itemId === itemId) {
        return index;
      }
    }
    return -1;
  };
  const findPaperPickerFirstAttachmentRowIndex = (itemId: number): number => {
    for (let index = 0; index < paperPickerRows.length; index += 1) {
      const row = paperPickerRows[index];
      if (row.kind === "attachment" && row.itemId === itemId) {
        return index;
      }
    }
    return -1;
  };
  const findPaperPickerParentRowIndex = (index: number): number => {
    const row = getPaperPickerRowAt(index);
    if (!row || row.depth <= 0) return -1;
    for (
      let candidateIndex = index - 1;
      candidateIndex >= 0;
      candidateIndex -= 1
    ) {
      const candidateRow = paperPickerRows[candidateIndex];
      if (candidateRow && candidateRow.depth === row.depth - 1) {
        return candidateIndex;
      }
    }
    return -1;
  };
  const findPaperPickerFirstChildRowIndex = (index: number): number => {
    const row = getPaperPickerRowAt(index);
    if (!row) return -1;
    const nextRow = getPaperPickerRowAt(index + 1);
    if (nextRow && nextRow.depth === row.depth + 1) {
      return index + 1;
    }
    return -1;
  };
  const upsertPaperContext = (paper: PaperContextRef): boolean => {
    if (!item) return false;
    const selectedPapers = normalizePaperContextEntries(
      selectedPaperContextCache.get(item.id) || [],
    );
    const duplicate = selectedPapers.some(
      (entry) =>
        entry.itemId === paper.itemId &&
        entry.contextItemId === paper.contextItemId,
    );
    if (duplicate) {
      if (status) setStatus(status, "Paper already selected", "warning");
      return false;
    }
    if (selectedPapers.length >= MAX_SELECTED_PAPER_CONTEXTS) {
      if (status) {
        setStatus(
          status,
          `Paper Context up to ${MAX_SELECTED_PAPER_CONTEXTS}`,
          "error",
        );
      }
      return false;
    }
    const metadata = resolvePaperContextDisplayMetadata(paper);
    const nextPapers = [
      ...selectedPapers,
      {
        ...paper,
        firstCreator: metadata.firstCreator || paper.firstCreator,
        year: metadata.year || paper.year,
      },
    ];
    selectedPaperContextCache.set(item.id, nextPapers);
    setPaperModeOverride(
      item.id,
      nextPapers[nextPapers.length - 1],
      "full-next",
    );
    selectedPaperPreviewExpandedCache.set(item.id, false);
    updatePaperPreviewPreservingScroll();
    if (status) {
      setStatus(
        status,
        "Paper context added. Full text will be sent on the next turn.",
        "ready",
      );
    }
    return true;
  };
  const upsertNoteTextContext = (contextItemId: number): boolean => {
    const textContextKey = getTextContextConversationKey();
    if (!item || !textContextKey) return false;
    const noteItem = Zotero.Items.get(contextItemId) || null;
    const snapshot = readNoteSnapshot(noteItem);
    if (!snapshot?.text) {
      if (status) setStatus(status, "Selected note is empty", "warning");
      return false;
    }
    const appended = appendSelectedTextContextForItem(
      textContextKey,
      snapshot.text,
      "note",
      undefined,
      undefined,
      {
        libraryID: snapshot.libraryID,
        noteItemKey: snapshot.noteItemKey || "",
        noteItemId: snapshot.noteId,
        parentItemId: snapshot.parentItemId,
        parentItemKey: snapshot.parentItemKey,
        noteKind: snapshot.noteKind,
        title: snapshot.title || `Note ${snapshot.noteId}`,
      },
    );
    if (!appended) {
      if (status) setStatus(status, "Note already selected", "warning");
      return false;
    }
    updateSelectedTextPreviewPreservingScroll();
    if (status) setStatus(status, "Note context added as text.", "ready");
    return true;
  };
  const upsertOtherRefContext = (ref: OtherContextRef): boolean => {
    if (!item) return false;
    const existing = selectedOtherRefContextCache.get(item.id) || [];
    const duplicate = existing.some((e) => e.contextItemId === ref.contextItemId);
    if (duplicate) {
      if (status) setStatus(status, "File already selected", "warning");
      return false;
    }
    selectedOtherRefContextCache.set(item.id, [...existing, ref]);
    updatePaperPreviewPreservingScroll();
    if (status) setStatus(status, `${ref.refKind === "figure" ? "Figure" : "File"} context added.`, "ready");
    return true;
  };
  const consumeActiveAtToken = (): boolean => {
    const token = getActiveAtToken();
    if (!token) return false;
    const beforeAt = inputBox.value.slice(0, token.slashStart);
    const afterCaret = inputBox.value.slice(token.caretEnd);
    inputBox.value = `${beforeAt}${afterCaret}`;
    persistDraftInputForCurrentConversation();
    const nextCaret = beforeAt.length;
    inputBox.setSelectionRange(nextCaret, nextCaret);
    return true;
  };
  const consumeActiveSlashToken = (): boolean =>
    consumeActiveAtToken();
  const consumeActiveActionToken = (): boolean => {
    const token = getActiveActionToken();
    if (!token) return false;
    const beforeSlash = inputBox.value.slice(0, token.slashStart);
    const afterCaret = inputBox.value.slice(token.caretEnd);
    inputBox.value = `${beforeSlash}${afterCaret}`;
    persistDraftInputForCurrentConversation();
    const nextCaret = beforeSlash.length;
    inputBox.setSelectionRange(nextCaret, nextCaret);
    return true;
  };
  const selectPaperPickerAttachment = (
    itemId: number,
    attachmentIndex: number,
    selectionKind: "paper-single" | "attachment",
  ): boolean => {
    const selectedGroup = getPaperPickerGroupByItemId(itemId);
    if (!selectedGroup) return false;
    const selectedAttachment = selectedGroup.attachments[attachmentIndex];
    if (!selectedAttachment) return false;
    consumeActiveSlashToken();
    const contentType = selectedAttachment.contentType;
    const kind = resolvePickerItemKind(contentType);
    ztoolkit.log("LLM: Picker selection", {
      selectionKind,
      kind,
      itemId: selectedGroup.itemId,
      contextItemId: selectedAttachment.contextItemId,
    });
    if (kind === "pdf") {
      upsertPaperContext({
        itemId: selectedGroup.itemId,
        contextItemId: selectedAttachment.contextItemId,
        title: selectedGroup.title,
        attachmentTitle: selectedAttachment.title,
        citationKey: selectedGroup.citationKey,
        firstCreator: selectedGroup.firstCreator,
        year: selectedGroup.year,
      });
    } else if (kind === "note") {
      upsertNoteTextContext(selectedAttachment.contextItemId);
    } else {
      upsertOtherRefContext({
        contextItemId: selectedAttachment.contextItemId,
        parentItemId: selectedGroup.itemId !== selectedAttachment.contextItemId
          ? selectedGroup.itemId
          : undefined,
        title: selectedAttachment.title || selectedGroup.title,
        contentType: contentType || "application/octet-stream",
        refKind: kind === "figure" ? "figure" : "other",
      });
    }
    closePaperPicker();
    inputBox.focus({ preventScroll: true });
    return true;
  };
  const selectPaperPickerRowAt = (index: number): boolean => {
    const row = getPaperPickerRowAt(index);
    if (!row) return false;
    if (row.kind === "collection") {
      togglePaperPickerCollectionExpanded(row.collectionId);
      renderPaperPicker();
      return true;
    }
    if (row.kind === "attachment") {
      return selectPaperPickerAttachment(
        row.itemId,
        row.attachmentIndex,
        "attachment",
      );
    }
    const group = getPaperPickerGroupByItemId(row.itemId);
    if (!group) return false;
    if (group.attachments.length <= 1) {
      return selectPaperPickerAttachment(row.itemId, 0, "paper-single");
    }
    if (!isPaperPickerGroupExpanded(row.itemId)) {
      togglePaperPickerGroupExpanded(row.itemId, true);
      ztoolkit.log("LLM: Paper picker expanded group via keyboard", {
        itemId: group.itemId,
      });
      renderPaperPicker();
      return true;
    }
    const firstChildIndex = findPaperPickerFirstAttachmentRowIndex(row.itemId);
    if (firstChildIndex >= 0) {
      paperPickerActiveRowIndex = firstChildIndex;
      renderPaperPicker();
      return true;
    }
    return false;
  };
  const handlePaperPickerArrowRight = (): boolean => {
    const activeRow = getPaperPickerRowAt(paperPickerActiveRowIndex);
    if (!activeRow) return false;
    if (activeRow.kind === "collection") {
      if (!isPaperPickerCollectionExpanded(activeRow.collectionId)) {
        togglePaperPickerCollectionExpanded(activeRow.collectionId, true);
        renderPaperPicker();
        return true;
      }
      const firstChildIndex = findPaperPickerFirstChildRowIndex(
        paperPickerActiveRowIndex,
      );
      if (firstChildIndex >= 0) {
        paperPickerActiveRowIndex = firstChildIndex;
        renderPaperPicker();
        return true;
      }
      return false;
    }
    if (activeRow.kind !== "paper") return false;
    const group = getPaperPickerGroupByItemId(activeRow.itemId);
    if (!group || group.attachments.length <= 1) return false;
    if (!isPaperPickerGroupExpanded(activeRow.itemId)) {
      togglePaperPickerGroupExpanded(activeRow.itemId, true);
      renderPaperPicker();
      return true;
    }
    const firstChildIndex = findPaperPickerFirstAttachmentRowIndex(
      activeRow.itemId,
    );
    if (firstChildIndex >= 0 && firstChildIndex !== paperPickerActiveRowIndex) {
      paperPickerActiveRowIndex = firstChildIndex;
      renderPaperPicker();
      return true;
    }
    return false;
  };
  const handlePaperPickerArrowLeft = (): boolean => {
    const activeRow = getPaperPickerRowAt(paperPickerActiveRowIndex);
    if (!activeRow) return false;
    if (activeRow.kind === "collection") {
      if (isPaperPickerCollectionExpanded(activeRow.collectionId)) {
        togglePaperPickerCollectionExpanded(activeRow.collectionId, false);
        renderPaperPicker();
        return true;
      }
      const parentIndex = findPaperPickerParentRowIndex(
        paperPickerActiveRowIndex,
      );
      if (parentIndex >= 0) {
        paperPickerActiveRowIndex = parentIndex;
        renderPaperPicker();
        return true;
      }
      return false;
    }
    if (activeRow.kind === "attachment") {
      const parentIndex = findPaperPickerPaperRowIndex(activeRow.itemId);
      if (parentIndex >= 0 && parentIndex !== paperPickerActiveRowIndex) {
        paperPickerActiveRowIndex = parentIndex;
        renderPaperPicker();
        return true;
      }
      return false;
    }
    const group = getPaperPickerGroupByItemId(activeRow.itemId);
    if (
      group &&
      group.attachments.length > 1 &&
      isPaperPickerGroupExpanded(activeRow.itemId)
    ) {
      togglePaperPickerGroupExpanded(activeRow.itemId, false);
      renderPaperPicker();
      return true;
    }
    const parentIndex = findPaperPickerParentRowIndex(
      paperPickerActiveRowIndex,
    );
    if (parentIndex >= 0) {
      paperPickerActiveRowIndex = parentIndex;
      renderPaperPicker();
      return true;
    }
    return false;
  };
  const renderPaperPicker = () => {
    if (!paperPicker || !paperPickerList) return;
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc) return;
    if (paperPickerMode === "empty") {
      paperPickerList.innerHTML = "";
      paperPicker.scrollTop = 0;
      const empty = createElement(ownerDoc, "div", "llm-paper-picker-empty", {
        textContent: paperPickerEmptyMessage,
      });
      paperPickerList.appendChild(empty);
      paperPicker.style.display = "block";
      return;
    }
    rebuildPaperPickerRows();
    if (!paperPickerRows.length) {
      const emptyMessage =
        paperPickerMode === "browse"
          ? "No items available."
          : "No items matched.";
      paperPickerMode = "empty";
      paperPickerEmptyMessage = emptyMessage;
      renderPaperPicker();
      return;
    }
    paperPickerList.innerHTML = "";
    paperPickerRows.forEach((row, rowIndex) => {
      const option = createElement(
        ownerDoc,
        "div",
        `llm-paper-picker-item ${
          row.kind === "attachment"
            ? "llm-paper-picker-attachment-row"
            : row.kind === "paper"
              ? "llm-paper-picker-group-row"
              : "llm-paper-picker-group-row llm-paper-picker-collection-row"
        }`,
      );
      option.setAttribute("role", "option");
      option.setAttribute(
        "aria-selected",
        rowIndex === paperPickerActiveRowIndex ? "true" : "false",
      );
      option.tabIndex = -1;
      option.style.paddingLeft = `${9 + row.depth * 14}px`;

      if (row.kind === "collection") {
        const collection = getPaperPickerCollectionById(row.collectionId);
        if (!collection) return;
        option.setAttribute(
          "aria-expanded",
          isPaperPickerCollectionExpanded(row.collectionId) ? "true" : "false",
        );
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
        const chevron = createElement(
          ownerDoc,
          "span",
          isPaperPickerCollectionExpanded(row.collectionId)
            ? "llm-paper-picker-group-chevron llm-folder-open"
            : "llm-paper-picker-group-chevron llm-folder-closed",
        );
        const title = createElement(
          ownerDoc,
          "span",
          "llm-paper-picker-title",
          {
            textContent: collection.name,
            title: collection.name,
          },
        );
        titleLine.append(chevron, title);
        rowMain.appendChild(titleLine);
        option.appendChild(rowMain);
      } else if (row.kind === "paper") {
        const group = getPaperPickerGroupByItemId(row.itemId);
        if (!group) return;
        const isMultiAttachment = group.attachments.length > 1;
        const expanded = isPaperPickerGroupExpanded(row.itemId);
        if (isMultiAttachment) {
          option.setAttribute("aria-expanded", expanded ? "true" : "false");
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
        const itemIcon = createElement(
          ownerDoc,
          "span",
          "llm-paper-picker-item-icon",
          { textContent: resolveGroupIcon(group) },
        );
        const title = createElement(
          ownerDoc,
          "span",
          "llm-paper-picker-title",
          {
            textContent: group.title,
            title: group.title,
          },
        );
        titleLine.append(itemIcon, title);
        if (isMultiAttachment) {
          const attachmentCount = createElement(
            ownerDoc,
            "span",
            "llm-paper-picker-badge",
            {
              textContent: `${group.attachments.length} files`,
            },
          );
          titleLine.appendChild(attachmentCount);
        }
        rowMain.appendChild(titleLine);
        const metaText = buildPaperMetaText(group);
        if (metaText) {
          const meta = createElement(
            ownerDoc,
            "span",
            "llm-paper-picker-meta",
            {
              textContent: metaText,
            },
          );
          rowMain.appendChild(meta);
        }
        option.appendChild(rowMain);
      } else {
        const group = getPaperPickerGroupByItemId(row.itemId);
        if (!group) return;
        const attachment = group.attachments[row.attachmentIndex];
        if (!attachment) return;
        const attachmentTitle = getPaperPickerAttachmentDisplayTitle(
          group,
          attachment,
          row.attachmentIndex,
        );
        const attachmentKind = resolvePickerItemKind(attachment.contentType);
        const indent = createElement(
          ownerDoc,
          "span",
          "llm-paper-picker-attachment-indent",
        );
        const attachmentMain = createElement(
          ownerDoc,
          "div",
          "llm-paper-picker-attachment-main",
        );
        const attachmentText = createElement(
          ownerDoc,
          "div",
          "llm-paper-picker-attachment-text",
        );
        const kindIcon = createElement(
          ownerDoc,
          "span",
          "llm-paper-picker-item-icon",
          { textContent: resolvePickerKindIcon(attachmentKind) },
        );
        const title = createElement(
          ownerDoc,
          "span",
          "llm-paper-picker-title",
          {
            textContent: attachmentTitle,
            title: attachmentTitle,
          },
        );
        const meta = createElement(ownerDoc, "span", "llm-paper-picker-meta", {
          textContent: `${resolvePickerKindLabel(attachmentKind)} attachment`,
        });
        attachmentText.append(title, meta);
        attachmentMain.append(kindIcon, attachmentText);
        option.append(indent, attachmentMain);
      }

      const choosePaperRow = (e: Event) => {
        const mouse = e as MouseEvent;
        if (typeof mouse.button === "number" && mouse.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        paperPickerActiveRowIndex = rowIndex;
        if (row.kind === "collection") {
          togglePaperPickerCollectionExpanded(row.collectionId);
          renderPaperPicker();
          return;
        }
        if (row.kind === "paper") {
          const group = getPaperPickerGroupByItemId(row.itemId);
          if (!group) return;
          if (group.attachments.length <= 1) {
            selectPaperPickerAttachment(row.itemId, 0, "paper-single");
            return;
          }
          togglePaperPickerGroupExpanded(row.itemId);
          const parentIndex = findPaperPickerPaperRowIndex(row.itemId);
          if (parentIndex >= 0) {
            paperPickerActiveRowIndex = parentIndex;
          }
          renderPaperPicker();
          return;
        }
        selectPaperPickerAttachment(
          row.itemId,
          row.attachmentIndex,
          "attachment",
        );
      };
      option.addEventListener("mousedown", choosePaperRow);
      option.addEventListener("click", (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
      });
      paperPickerList.appendChild(option);
    });
    paperPicker.style.display = "block";
    const activeOption = paperPickerList.children[
      paperPickerActiveRowIndex
    ] as HTMLElement | null;
    if (paperPickerActiveRowIndex <= 0) {
      paperPicker.scrollTop = 0;
    } else {
      activeOption?.scrollIntoView({
        block: "nearest",
      });
    }
  };
  const schedulePaperPickerSearch = () => {
    if (!item || !paperPicker || !paperPickerList) {
      closePaperPicker();
      return;
    }
    const slashToken = getActiveSlashToken();
    if (!slashToken) {
      closePaperPicker();
      return;
    }
    clearPaperPickerDebounceTimer();
    const requestId = ++paperPickerRequestSeq;
    const runSearch = async () => {
      paperPickerDebounceTimer = null;
      if (!item) return;
      const activeSlashToken = getActiveSlashToken();
      if (!activeSlashToken) {
        closePaperPicker();
        return;
      }
      const libraryID = getCurrentLibraryID();
      if (!libraryID) {
        closePaperPicker();
        return;
      }
      const normalizedQuery = normalizePaperSearchText(activeSlashToken.query);
      if (!normalizedQuery) {
        const collections = await browseAllItemCandidates(libraryID);
        if (requestId !== paperPickerRequestSeq) return;
        if (!getActiveSlashToken()) {
          closePaperPicker();
          return;
        }
        setPaperPickerCollections(collections);
        paperPickerActiveRowIndex = 0;
        renderPaperPicker();
        return;
      }
      const results = await searchAllItemCandidates(
        libraryID,
        activeSlashToken.query,
        20,
      );
      if (requestId !== paperPickerRequestSeq) return;
      if (!getActiveSlashToken()) {
        closePaperPicker();
        return;
      }
      setPaperPickerSearchGroups(results);
      paperPickerActiveRowIndex = 0;
      renderPaperPicker();
    };
    const win = body.ownerDocument?.defaultView;
    if (win) {
      paperPickerDebounceTimer = win.setTimeout(() => {
        void runSearch();
      }, 120);
    } else {
      paperPickerDebounceTimer =
        (setTimeout(() => {
          void runSearch();
        }, 120) as unknown as number) || 0;
    }
  };

  if (inputSection && inputBox) {
    let fileDragDepth = 0;

    inputSection.addEventListener("dragenter", (e: Event) => {
      const dragEvent = e as DragEvent;
      if (!isFileDragEvent(dragEvent)) return;
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      fileDragDepth += 1;
      setInputDropActive(true);
    });

    inputSection.addEventListener("dragover", (e: Event) => {
      const dragEvent = e as DragEvent;
      if (!isFileDragEvent(dragEvent)) return;
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
      if (!isFileDragEvent(dragEvent)) return;
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      fileDragDepth = Math.max(0, fileDragDepth - 1);
      if (fileDragDepth === 0) {
        setInputDropActive(false);
      }
    });

    inputSection.addEventListener("drop", (e: Event) => {
      const dragEvent = e as DragEvent;
      if (!isFileDragEvent(dragEvent)) return;
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      fileDragDepth = 0;
      setInputDropActive(false);
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
      persistDraftInputForCurrentConversation();
      schedulePaperPickerSearch();
      scheduleActionPickerTrigger();
    });
    inputBox.addEventListener("click", () => {
      schedulePaperPickerSearch();
      scheduleActionPickerTrigger();
    });
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

  const { doSend } = createSendFlowController({
    body,
    inputBox,
    getItem: () => item,
    closeSlashMenu,
    closePaperPicker,
    getSelectedTextContextEntries,
    getSelectedPaperContexts: (itemId) =>
      normalizePaperContextEntries(selectedPaperContextCache.get(itemId) || []),
    getFullTextPaperContexts: (currentItem, selectedPaperContexts) =>
      getEffectiveFullTextPaperContexts(currentItem, selectedPaperContexts),
    getSelectedFiles: (itemId) => selectedFileAttachmentCache.get(itemId) || [],
    getSelectedImages: (itemId) => selectedImageCache.get(itemId) || [],
    resolvePromptText,
    buildQuestionWithSelectedTextContexts,
    buildModelPromptWithFileContext,
    isAgentMode: () => getCurrentRuntimeMode() === "agent",
    isGlobalMode,
    normalizeConversationTitleSeed,
    getConversationKey,
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
    retainPinnedImageState,
    retainPaperState,
    consumePaperModeState,
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
    setStatusMessage: status
      ? (message, level) => {
          setStatus(status, message, level);
        }
      : undefined,
    editStaleStatusText: EDIT_STALE_STATUS_TEXT,
  });
  const { clearCurrentConversation } = createClearConversationController({
    getConversationKey: () => (item ? getConversationKey(item) : null),
    getCurrentItemID: () =>
      item && Number.isFinite(item.id) && item.id > 0 ? item.id : null,
    clearPendingTurnDeletion: (conversationKey) => {
      if (pendingTurnDeletion?.conversationKey === conversationKey) {
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
    clearStoredConversation,
    resetConversationTitle: clearConversationTitle,
    clearOwnerAttachmentRefs,
    removeConversationAttachmentFiles,
    refreshChatPreservingScroll,
    refreshGlobalHistoryHeader: () => {
      void refreshGlobalHistoryHeader();
    },
    scheduleAttachmentGc,
    clearAgentToolCaches: clearAllAgentToolCaches,
    setStatusMessage: status
      ? (message, level) => {
          setStatus(status, message, level);
        }
      : undefined,
    logError: (message, err) => {
      ztoolkit.log(message, err);
    },
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
      const selectedTexts = selectedContexts.map((entry) => entry.text);
      const selectedTextSources = selectedContexts.map((entry) => entry.source);
      const selectedTextPaperContexts = selectedContexts.map(
        (entry) => entry.paperContext,
      );
      const selectedTextNoteContexts = selectedContexts.map(
        (entry) => entry.noteContext,
      );
      const selectedPaperContexts = normalizePaperContextEntries(
        selectedPaperContextCache.get(currentItem.id) || [],
      );
      const fullTextPaperContexts = getEffectiveFullTextPaperContexts(
        currentItem,
        selectedPaperContexts,
      );
      const selectedFiles =
        selectedFileAttachmentCache.get(currentItem.id) || [];
      const selectedProfile = getSelectedProfile();
      const activeModelName = (
        selectedProfile?.model ||
        getSelectedModelInfo().currentModel ||
        ""
      ).trim();
      const selectedImages = (selectedImageCache.get(currentItem.id) || []).slice(
        0,
        MAX_SELECTED_IMAGES,
      );
      const images = isScreenshotUnsupportedModel(activeModelName)
        ? []
        : selectedImages;
      const selectedReasoning = getSelectedReasoning();
      const advancedParams = getAdvancedModelParams(selectedProfile?.entryId);
      const targetRuntimeMode = getCurrentRuntimeMode();
      inlineEditCleanup?.();
      setInlineEditCleanup(null);
      setInlineEditInputSection(null, null, null);
      setInlineEditSavedDraft("");
      setInlineEditTarget(null);
      if (newText) {
        consumePaperModeState(currentItem.id);
        retainPaperState(currentItem.id);
        updatePaperPreviewPreservingScroll();
        void editUserTurnAndRetry(
          body,
          currentItem,
          editTarget.userTimestamp,
          editTarget.assistantTimestamp,
          newText,
          selectedTexts,
          selectedTextSources,
          selectedTextPaperContexts,
          selectedTextNoteContexts,
          images,
          selectedPaperContexts,
          fullTextPaperContexts,
          selectedFiles,
          targetRuntimeMode,
          selectedProfile?.model,
          selectedProfile?.apiBase,
          selectedProfile?.apiKey,
          selectedReasoning,
          advancedParams,
        );
      } else {
        // Nothing to submit — refresh the chat to remove the stale inline
        // edit widget (the "Editing" header div) that cleanup left in chatBox.
        refreshConversationPanels(body, currentItem);
      }
      return;
    }
    closeActionPicker();
    await doSend();
    persistDraftInputForCurrentConversation();
  };

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
          nextMode === "agent" ? "Agent mode enabled" : "Chat mode enabled",
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
        const items = getVisibleSlashItems();
        if (items.length) {
          slashMenuActiveIndex = (slashMenuActiveIndex + 1) % items.length;
          updateSlashMenuSelection();
        }
        return;
      }
      if (ke.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const items = getVisibleSlashItems();
        if (items.length) {
          slashMenuActiveIndex =
            (slashMenuActiveIndex - 1 + items.length) % items.length;
          updateSlashMenuSelection();
        }
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
        if (actionPickerItems.length) {
          actionPickerActiveIndex =
            (actionPickerActiveIndex + 1) % actionPickerItems.length;
          renderActionPicker();
        }
        return;
      }
      if (ke.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        if (actionPickerItems.length) {
          actionPickerActiveIndex =
            (actionPickerActiveIndex - 1 + actionPickerItems.length) %
            actionPickerItems.length;
          renderActionPicker();
        }
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
        void selectActionPickerItem(actionPickerActiveIndex);
        return;
      }
    }
    if (isPaperPickerOpen()) {
      if (ke.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        if (paperPickerRows.length) {
          paperPickerActiveRowIndex =
            (paperPickerActiveRowIndex + 1) % paperPickerRows.length;
          renderPaperPicker();
        }
        return;
      }
      if (ke.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        if (paperPickerRows.length) {
          paperPickerActiveRowIndex =
            (paperPickerActiveRowIndex - 1 + paperPickerRows.length) %
            paperPickerRows.length;
          renderPaperPicker();
        }
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
        selectPaperPickerRowAt(paperPickerActiveRowIndex);
        return;
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

  if (
    panelDoc &&
    !(panelDoc as unknown as { __llmFontScaleShortcut?: boolean })
      .__llmFontScaleShortcut
  ) {
    const isEventWithinActivePanel = (event: Event) => {
      const panel = panelDoc.querySelector("#llm-main") as HTMLElement | null;
      if (!panel) return null;
      const target = event.target as Node | null;
      const activeEl = panelDoc.activeElement;
      const inPanel = Boolean(
        (target && panel.contains(target)) ||
        (activeEl && panel.contains(activeEl)),
      );
      if (!inPanel) return null;
      return panel;
    };

    const applyDelta = (
      event: Event,
      delta: number | null,
      reset: boolean = false,
    ) => {
      if (!reset && delta === null) return;
      const panel = isEventWithinActivePanel(event);
      if (!panel) return;
      setPanelFontScalePercent(
        reset
          ? FONT_SCALE_DEFAULT_PERCENT
          : clampNumber(
              panelFontScalePercent + (delta || 0),
              FONT_SCALE_MIN_PERCENT,
              FONT_SCALE_MAX_PERCENT,
            ),
      );
      event.preventDefault();
      event.stopPropagation();
      applyPanelFontScale(panel);
    };

    panelDoc.addEventListener(
      "keydown",
      (e: Event) => {
        const ke = e as KeyboardEvent;
        if (!(ke.metaKey || ke.ctrlKey) || ke.altKey) return;

        if (
          ke.key === "+" ||
          ke.key === "=" ||
          ke.code === "Equal" ||
          ke.code === "NumpadAdd"
        ) {
          applyDelta(ke, FONT_SCALE_STEP_PERCENT);
        } else if (
          ke.key === "-" ||
          ke.key === "_" ||
          ke.code === "Minus" ||
          ke.code === "NumpadSubtract"
        ) {
          applyDelta(ke, -FONT_SCALE_STEP_PERCENT);
        } else if (
          ke.key === "0" ||
          ke.code === "Digit0" ||
          ke.code === "Numpad0"
        ) {
          applyDelta(ke, null, true);
        }
      },
      true,
    );

    // Some platforms route Cmd/Ctrl +/- through zoom commands instead of keydown.
    panelDoc.addEventListener(
      "command",
      (e: Event) => {
        const target = e.target as Element | null;
        const commandId = target?.id || "";
        if (
          commandId === "cmd_fullZoomEnlarge" ||
          commandId === "cmd_textZoomEnlarge"
        ) {
          applyDelta(e, FONT_SCALE_STEP_PERCENT);
        } else if (
          commandId === "cmd_fullZoomReduce" ||
          commandId === "cmd_textZoomReduce"
        ) {
          applyDelta(e, -FONT_SCALE_STEP_PERCENT);
        } else if (
          commandId === "cmd_fullZoomReset" ||
          commandId === "cmd_textZoomReset"
        ) {
          applyDelta(e, null, true);
        }
      },
      true,
    );

    (
      panelDoc as unknown as { __llmFontScaleShortcut?: boolean }
    ).__llmFontScaleShortcut = true;
  }

  if (selectTextBtn) {
    let pendingSelectedText = "";
    const cacheSelectionBeforeFocusShift = () => {
      if (!item) return;
      pendingSelectedText = getActiveReaderSelectionText(
        body.ownerDocument as Document,
        item,
      );
    };
    selectTextBtn.addEventListener(
      "pointerdown",
      cacheSelectionBeforeFocusShift,
    );
    selectTextBtn.addEventListener("mousedown", cacheSelectionBeforeFocusShift);
    selectTextBtn.addEventListener("click", async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      const selectedText = pendingSelectedText;
      pendingSelectedText = "";
      const activeReaderAttachment = getActiveContextAttachmentFromTabs();
      const resolvedPaperContext = resolvePaperContextRefFromAttachment(
        activeReaderAttachment,
      );
      const textContextKey = getTextContextConversationKey();
      if (!textContextKey) return;
      if (!isGlobalMode()) {
        const activeBasePaperItemID = Number(
          resolveCurrentPaperBaseItem()?.id ||
            getPaperPortalBaseItemID(item) ||
            0,
        );
        const paperMismatch =
          !resolvedPaperContext ||
          activeBasePaperItemID <= 0 ||
          resolvedPaperContext.itemId !== activeBasePaperItemID;
        if (paperMismatch) {
          if (status) {
            setStatus(
              status,
              "Paper mode only accepts text from this paper",
              "error",
            );
          }
          return;
        }
      }
      const added = await includeSelectedTextFromReader(
        body,
        item,
        selectedText,
        {
          targetItemId: textContextKey,
          paperContext: isGlobalMode() ? resolvedPaperContext : null,
        },
      );
      if (added) {
        updateSelectedTextPreviewPreservingScroll();
      }
    });
  }

  // Screenshot button
  if (screenshotBtn) {
    screenshotBtn.addEventListener("click", async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      const { currentModel } = getSelectedModelInfo();
      if (isScreenshotUnsupportedModel(currentModel)) {
        if (status) {
          setStatus(status, getScreenshotDisabledHint(currentModel), "error");
        }
        updateImagePreviewPreservingScroll();
        return;
      }

      // Get the main Zotero window
      // Try multiple methods to find the correct window
      let mainWindow: Window | null = null;

      // Method 1: Try Zotero.getMainWindow()
      mainWindow = Zotero.getMainWindow();
      ztoolkit.log("Screenshot: Zotero.getMainWindow() =", mainWindow);

      // Method 2: If that doesn't work, try getting top window from our document
      if (!mainWindow) {
        const panelWin = body.ownerDocument?.defaultView;
        mainWindow = panelWin?.top || panelWin || null;
        ztoolkit.log("Screenshot: Using panel's top window");
      }

      if (!mainWindow) {
        ztoolkit.log("Screenshot: No window found");
        return;
      }

      ztoolkit.log(
        "Screenshot: Using window, body exists:",
        !!mainWindow.document.body,
      );
      ztoolkit.log(
        "Screenshot: documentElement exists:",
        !!mainWindow.document.documentElement,
      );

      const currentImages = selectedImageCache.get(item.id) || [];
      if (currentImages.length >= MAX_SELECTED_IMAGES) {
        if (status) {
          setStatus(
            status,
            `Maximum ${MAX_SELECTED_IMAGES} screenshots allowed`,
            "error",
          );
        }
        updateImagePreviewPreservingScroll();
        return;
      }
      if (status) setStatus(status, "Select a region...", "sending");

      try {
        ztoolkit.log("Screenshot: Starting capture selection...");
        const dataUrl = await captureScreenshotSelection(mainWindow);
        ztoolkit.log(
          "Screenshot: Capture returned:",
          dataUrl ? "image data" : "null",
        );
        if (dataUrl) {
          const optimized = await optimizeImageDataUrl(mainWindow, dataUrl);
          const existingImages = selectedImageCache.get(item.id) || [];
          const nextImages = [...existingImages, optimized].slice(
            0,
            MAX_SELECTED_IMAGES,
          );
          selectedImageCache.set(item.id, nextImages);
          const expandedBeforeCapture = selectedImagePreviewExpandedCache.get(
            item.id,
          );
          selectedImagePreviewExpandedCache.set(
            item.id,
            typeof expandedBeforeCapture === "boolean"
              ? expandedBeforeCapture
              : false,
          );
          selectedImagePreviewActiveIndexCache.set(
            item.id,
            nextImages.length - 1,
          );
          updateImagePreviewPreservingScroll();
          if (status) {
            setStatus(
              status,
              `Screenshot captured (${nextImages.length}/${MAX_SELECTED_IMAGES})`,
              "ready",
            );
          }
        } else {
          if (status) setStatus(status, "Selection cancelled", "ready");
        }
      } catch (err) {
        ztoolkit.log("Screenshot selection error:", err);
        if (status) setStatus(status, "Screenshot failed", "error");
      }
    });
  }

  const openReferenceSlashFromMenu = () => {
    if (!item) return;
    // Paper picker is now triggered by '@'
    const existingToken = getActiveAtToken();
    if (!existingToken) {
      const selectionStart =
        typeof inputBox.selectionStart === "number"
          ? inputBox.selectionStart
          : inputBox.value.length;
      const selectionEnd =
        typeof inputBox.selectionEnd === "number"
          ? inputBox.selectionEnd
          : selectionStart;
      const before = inputBox.value.slice(0, selectionStart);
      const after = inputBox.value.slice(selectionEnd);
      const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
      const insertion = `${needsLeadingSpace ? " " : ""}@`;
      inputBox.value = `${before}${insertion}${after}`;
      persistDraftInputForCurrentConversation();
      const nextCaret = before.length + insertion.length;
      inputBox.setSelectionRange(nextCaret, nextCaret);
    }
    inputBox.focus({ preventScroll: true });
    schedulePaperPickerSearch();
    if (status) {
      setStatus(
        status,
        "Reference picker ready. Browse collections or type to search papers.",
        "ready",
      );
    }
  };

  if (uploadBtn && uploadInput) {
    uploadBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      if (!slashMenu) {
        uploadInput.click();
        return;
      }
      if (isFloatingMenuOpen(slashMenu)) {
        closeSlashMenu();
        return;
      }
      closeRetryModelMenu();
      closeModelMenu();
      closeReasoningMenu();
      closeHistoryNewMenu();
      closeHistoryMenu();
      closeResponseMenu();
      closePromptMenu();
      closeExportMenu();
      if (getCurrentRuntimeMode() === "agent") {
        renderAgentActionsInSlashMenu();
      }
      openSlashMenuWithSelection();
      uploadBtn.setAttribute("aria-expanded", "true");
    });
    uploadInput.addEventListener("change", async () => {
      if (!item) return;
      const files = Array.from(uploadInput.files || []);
      uploadInput.value = "";
      await processIncomingFiles(files);
    });
  }

  if (slashUploadOption && uploadInput) {
    slashUploadOption.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      consumeActiveActionToken();
      closeSlashMenu();
      uploadInput.click();
    });
  }

  if (slashReferenceOption) {
    slashReferenceOption.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      consumeActiveActionToken();
      closeSlashMenu();
      openReferenceSlashFromMenu();
    });
  }

  if (slashFullPdfOption) {
    slashFullPdfOption.addEventListener("click", async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      consumeActiveActionToken();
      closeSlashMenu();
      const attachment = getActiveContextAttachmentFromTabs();
      if (!attachment) {
        if (status) setStatus(status, "No PDF open — open a PDF in the reader first", "error");
        return;
      }
      const filePath =
        typeof (attachment as { getFilePath?: () => string | undefined }).getFilePath === "function"
          ? (attachment as { getFilePath: () => string | undefined }).getFilePath()
          : (attachment as unknown as { attachmentPath?: string }).attachmentPath;
      if (!filePath) {
        if (status) setStatus(status, "Could not locate the PDF file", "error");
        return;
      }
      if (status) setStatus(status, "Loading PDF...", "sending");
      try {
        const bytes = await readAttachmentBytes(filePath);
        if (bytes.byteLength > MAX_UPLOAD_PDF_SIZE_BYTES) {
          if (status) setStatus(status, `PDF too large (max ${Math.round(MAX_UPLOAD_PDF_SIZE_BYTES / 1024 / 1024)} MB)`, "error");
          return;
        }
        const fileName = filePath.split(/[\\/]/).pop() || "document.pdf";
        const file = new File([bytes], fileName, { type: "application/pdf" });
        await processIncomingFiles([file]);
        if (status) setStatus(status, "PDF added to context", "ready");
      } catch (err) {
        ztoolkit.log("Full PDF load error:", err);
        if (status) setStatus(status, "Failed to load PDF", "error");
      }
    });
  }

  if (slashPdfPageOption) {
    slashPdfPageOption.addEventListener("click", async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      consumeActiveActionToken();
      closeSlashMenu();
      const { currentModel } = getSelectedModelInfo();
      if (isScreenshotUnsupportedModel(currentModel)) {
        if (status) setStatus(status, getScreenshotDisabledHint(currentModel), "error");
        return;
      }
      const currentImages = selectedImageCache.get(item.id) || [];
      if (currentImages.length >= MAX_SELECTED_IMAGES) {
        if (status) setStatus(status, `Maximum ${MAX_SELECTED_IMAGES} images allowed`, "error");
        return;
      }
      if (status) setStatus(status, "Capturing PDF page...", "sending");
      try {
        const dataUrl = await captureCurrentPdfPage();
        if (dataUrl) {
          const win =
            body.ownerDocument?.defaultView ||
            (Zotero.getMainWindow?.() as Window | null);
          const optimized = win ? await optimizeImageDataUrl(win, dataUrl) : dataUrl;
          const existingImages = selectedImageCache.get(item.id) || [];
          const nextImages = [...existingImages, optimized].slice(0, MAX_SELECTED_IMAGES);
          selectedImageCache.set(item.id, nextImages);
          const expandedBefore = selectedImagePreviewExpandedCache.get(item.id);
          selectedImagePreviewExpandedCache.set(
            item.id,
            typeof expandedBefore === "boolean" ? expandedBefore : false,
          );
          selectedImagePreviewActiveIndexCache.set(item.id, nextImages.length - 1);
          updateImagePreviewPreservingScroll();
          if (status) setStatus(status, `Page captured (${nextImages.length}/${MAX_SELECTED_IMAGES})`, "ready");
        } else {
          if (status) setStatus(status, "No PDF page found — open a PDF in the reader first", "error");
          updateImagePreviewPreservingScroll();
        }
      } catch (err) {
        ztoolkit.log("PDF page capture error:", err);
        if (status) setStatus(status, "PDF page capture failed", "error");
        updateImagePreviewPreservingScroll();
      }
    });
  }

  const openModelMenu = () => {
    if (!modelMenu || !modelBtn) return;
    closeSlashMenu();
    closeRetryModelMenu();
    closeReasoningMenu();
    closePromptMenu();
    closeHistoryNewMenu();
    closeHistoryMenu();
    updateModelButton();
    rebuildModelMenu();
    if (!modelMenu.childElementCount) {
      closeModelMenu();
      return;
    }
    positionFloatingMenu(body, modelMenu, modelBtn);
    setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, true);
  };

  const closeModelMenu = () => {
    setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, false);
  };

  const openReasoningMenu = () => {
    if (!reasoningMenu || !reasoningBtn) return;
    closeSlashMenu();
    closeRetryModelMenu();
    closeModelMenu();
    closePromptMenu();
    closeHistoryNewMenu();
    closeHistoryMenu();
    updateReasoningButton();
    rebuildReasoningMenu();
    if (!reasoningMenu.childElementCount) {
      closeReasoningMenu();
      return;
    }
    positionFloatingMenu(body, reasoningMenu, reasoningBtn);
    setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, true);
  };

  const closeReasoningMenu = () => {
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

  if (modelMenu) {
    modelMenu.addEventListener("pointerdown", (e: Event) => {
      e.stopPropagation();
    });
    modelMenu.addEventListener("mousedown", (e: Event) => {
      e.stopPropagation();
    });
  }

  if (reasoningMenu) {
    reasoningMenu.addEventListener("pointerdown", (e: Event) => {
      e.stopPropagation();
    });
    reasoningMenu.addEventListener("mousedown", (e: Event) => {
      e.stopPropagation();
    });
  }

  if (retryModelMenu) {
    retryModelMenu.addEventListener("pointerdown", (e: Event) => {
      e.stopPropagation();
    });
    retryModelMenu.addEventListener("mousedown", (e: Event) => {
      e.stopPropagation();
    });
  }

  if (slashMenu) {
    slashMenu.addEventListener("pointerdown", (e: Event) => {
      e.stopPropagation();
    });
    slashMenu.addEventListener("mousedown", (e: Event) => {
      e.stopPropagation();
    });
  }

  if (historyMenu) {
    historyMenu.addEventListener("pointerdown", (e: Event) => {
      e.stopPropagation();
    });
    historyMenu.addEventListener("mousedown", (e: Event) => {
      e.stopPropagation();
    });
  }

  if (historyNewMenu) {
    historyNewMenu.addEventListener("pointerdown", (e: Event) => {
      e.stopPropagation();
    });
    historyNewMenu.addEventListener("mousedown", (e: Event) => {
      e.stopPropagation();
    });
  }

  if (historyRowMenu) {
    historyRowMenu.addEventListener("pointerdown", (e: Event) => {
      e.stopPropagation();
    });
    historyRowMenu.addEventListener("mousedown", (e: Event) => {
      e.stopPropagation();
    });
    historyRowMenu.addEventListener("contextmenu", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  const bodyWithRetryMenuDismiss = body as Element & {
    __llmRetryMenuDismissHandler?: (event: PointerEvent) => void;
  };
  if (bodyWithRetryMenuDismiss.__llmRetryMenuDismissHandler) {
    panelDoc.removeEventListener(
      "pointerdown",
      bodyWithRetryMenuDismiss.__llmRetryMenuDismissHandler,
      true,
    );
  }
  const dismissRetryMenuOnOutsidePointerDown = (e: PointerEvent) => {
    if (typeof e.button === "number" && e.button !== 0) return;
    if (!retryModelMenu || !isFloatingMenuOpen(retryModelMenu)) return;
    const target = e.target as Node | null;
    if (target && retryModelMenu.contains(target)) return;
    closeRetryModelMenu();
  };
  panelDoc.addEventListener(
    "pointerdown",
    dismissRetryMenuOnOutsidePointerDown,
    true,
  );
  bodyWithRetryMenuDismiss.__llmRetryMenuDismissHandler =
    dismissRetryMenuOnOutsidePointerDown;

  const bodyWithPromptMenuDismiss = body as Element & {
    __llmPromptMenuDismissHandler?: (event: PointerEvent) => void;
  };
  if (bodyWithPromptMenuDismiss.__llmPromptMenuDismissHandler) {
    panelDoc.removeEventListener(
      "pointerdown",
      bodyWithPromptMenuDismiss.__llmPromptMenuDismissHandler,
      true,
    );
  }
  const dismissPromptMenuOnOutsidePointerDown = (e: PointerEvent) => {
    if (!promptMenu || promptMenu.style.display === "none") return;
    const target = e.target as Node | null;
    if (target && promptMenu.contains(target)) return;
    closePromptMenu();
  };
  panelDoc.addEventListener(
    "pointerdown",
    dismissPromptMenuOnOutsidePointerDown,
    true,
  );
  bodyWithPromptMenuDismiss.__llmPromptMenuDismissHandler =
    dismissPromptMenuOnOutsidePointerDown;

  const bodyWithPaperPickerDismiss = body as Element & {
    __llmPaperPickerDismissHandler?: (event: PointerEvent) => void;
  };
  if (bodyWithPaperPickerDismiss.__llmPaperPickerDismissHandler) {
    panelDoc.removeEventListener(
      "pointerdown",
      bodyWithPaperPickerDismiss.__llmPaperPickerDismissHandler,
      true,
    );
  }
  const dismissPaperPickerOnOutsidePointerDown = (e: PointerEvent) => {
    if (!isPaperPickerOpen()) return;
    const target = e.target as Node | null;
    if (target && paperPicker?.contains(target)) return;
    if (target && inputBox.contains(target)) return;
    closePaperPicker();
  };
  panelDoc.addEventListener(
    "pointerdown",
    dismissPaperPickerOnOutsidePointerDown,
    true,
  );
  bodyWithPaperPickerDismiss.__llmPaperPickerDismissHandler =
    dismissPaperPickerOnOutsidePointerDown;

  const bodyWithPaperChipDismiss = body as Element & {
    __llmPaperChipDismissHandler?: (event: PointerEvent) => void;
  };
  if (bodyWithPaperChipDismiss.__llmPaperChipDismissHandler) {
    panelDoc.removeEventListener(
      "pointerdown",
      bodyWithPaperChipDismiss.__llmPaperChipDismissHandler,
      true,
    );
  }
  const dismissPaperChipOnOutsidePointerDown = (e: PointerEvent) => {
    if (typeof e.button === "number" && e.button !== 0) return;
    if (!paperChipMenuSticky || !paperChipMenu || paperChipMenu.style.display === "none")
      return;
    const target = e.target as Node | null;
    if (target && paperChipMenu.contains(target)) return;
    if (target && paperChipMenuAnchor?.contains(target)) return;
    closePaperChipMenu();
  };
  panelDoc.addEventListener(
    "pointerdown",
    dismissPaperChipOnOutsidePointerDown,
    true,
  );
  bodyWithPaperChipDismiss.__llmPaperChipDismissHandler =
    dismissPaperChipOnOutsidePointerDown;

  if (chatBox) {
    chatBox.addEventListener("click", (e: Event) => {
      // Dismiss inline edit when clicking outside the edit widget
      if (inlineEditTarget) {
        const isInsideEdit = (e.target as Element | null)?.closest(
          ".llm-inline-edit-wrapper",
        );
        if (!isInsideEdit) {
          inlineEditCleanup?.();
          setInlineEditCleanup(null);
          setInlineEditTarget(null);
          refreshConversationPanels(body, item);
          return;
        }
      }

      const retryTarget = (e.target as Element | null)?.closest(
        ".llm-retry-latest",
      ) as HTMLButtonElement | null;
      if (!retryTarget) return;
      e.preventDefault();
      e.stopPropagation();
      closePromptMenu();
      if (!item || !retryModelMenu) return;
      if (isFloatingMenuOpen(retryModelMenu)) {
        closeRetryModelMenu();
      } else {
        openRetryModelMenu(retryTarget);
      }
    });
  }

  if (modelBtn) {
    modelBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item || !modelMenu) return;
      if (!isFloatingMenuOpen(modelMenu)) {
        openModelMenu();
      } else {
        closeModelMenu();
      }
    });
  }

  if (reasoningBtn) {
    reasoningBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item || !reasoningMenu || reasoningBtn.disabled) return;
      if (!isFloatingMenuOpen(reasoningMenu)) {
        openReasoningMenu();
      } else {
        closeReasoningMenu();
      }
    });
  }

  const doc = body.ownerDocument;
  if (
    doc &&
    !(doc as unknown as { __llmModelMenuDismiss?: boolean })
      .__llmModelMenuDismiss
  ) {
    doc.addEventListener("mousedown", (e: Event) => {
      const me = e as MouseEvent;
      const modelMenus = Array.from(
        doc.querySelectorAll("#llm-model-menu"),
      ) as HTMLDivElement[];
      const reasoningMenus = Array.from(
        doc.querySelectorAll("#llm-reasoning-menu"),
      ) as HTMLDivElement[];
      const target = e.target as Node | null;
      const retryButtonTarget = isElementNode(target)
        ? (target.closest(".llm-retry-latest") as HTMLButtonElement | null)
        : null;
      const retryModelMenus = Array.from(
        doc.querySelectorAll("#llm-retry-model-menu"),
      ) as HTMLDivElement[];
      const responseMenus = Array.from(
        doc.querySelectorAll("#llm-response-menu"),
      ) as HTMLDivElement[];
      const promptMenus = Array.from(
        doc.querySelectorAll("#llm-prompt-menu"),
      ) as HTMLDivElement[];
      const exportMenus = Array.from(
        doc.querySelectorAll("#llm-export-menu"),
      ) as HTMLDivElement[];
      const slashMenus = Array.from(
        doc.querySelectorAll("#llm-slash-menu"),
      ) as HTMLDivElement[];
      const historyMenus = Array.from(
        doc.querySelectorAll("#llm-history-menu"),
      ) as HTMLDivElement[];
      const historyNewMenus = Array.from(
        doc.querySelectorAll("#llm-history-new-menu"),
      ) as HTMLDivElement[];
      const historyRowMenus = Array.from(
        doc.querySelectorAll("#llm-history-row-menu"),
      ) as HTMLDivElement[];
      for (const modelMenuEl of modelMenus) {
        if (!isFloatingMenuOpen(modelMenuEl)) continue;
        const panelRoot = modelMenuEl.closest("#llm-main");
        const modelButtonEl = panelRoot?.querySelector(
          "#llm-model-toggle",
        ) as HTMLButtonElement | null;
        if (
          !target ||
          (!modelMenuEl.contains(target) && !modelButtonEl?.contains(target))
        ) {
          setFloatingMenuOpen(modelMenuEl, MODEL_MENU_OPEN_CLASS, false);
        }
      }
      for (const reasoningMenuEl of reasoningMenus) {
        if (!isFloatingMenuOpen(reasoningMenuEl)) continue;
        const panelRoot = reasoningMenuEl.closest("#llm-main");
        const reasoningButtonEl = panelRoot?.querySelector(
          "#llm-reasoning-toggle",
        ) as HTMLButtonElement | null;
        if (
          !target ||
          (!reasoningMenuEl.contains(target) &&
            !reasoningButtonEl?.contains(target))
        ) {
          setFloatingMenuOpen(
            reasoningMenuEl,
            REASONING_MENU_OPEN_CLASS,
            false,
          );
        }
      }
      for (const retryModelMenuEl of retryModelMenus) {
        if (!isFloatingMenuOpen(retryModelMenuEl)) continue;
        const panelRoot = retryModelMenuEl.closest("#llm-main");
        const clickedRetryButtonInSamePanel = Boolean(
          retryButtonTarget &&
          panelRoot &&
          panelRoot.contains(retryButtonTarget),
        );
        if (
          !target ||
          (!retryModelMenuEl.contains(target) && !clickedRetryButtonInSamePanel)
        ) {
          setFloatingMenuOpen(
            retryModelMenuEl,
            RETRY_MODEL_MENU_OPEN_CLASS,
            false,
          );
          retryMenuAnchor = null;
        }
      }
      if (me.button === 0) {
        let responseMenuClosed = false;
        for (const responseMenuEl of responseMenus) {
          if (responseMenuEl.style.display === "none") continue;
          if (target && responseMenuEl.contains(target)) continue;
          responseMenuEl.style.display = "none";
          responseMenuClosed = true;
        }
        if (responseMenuClosed) {
          setResponseMenuTarget(null);
        }
        let promptMenuClosed = false;
        for (const promptMenuEl of promptMenus) {
          if (promptMenuEl.style.display === "none") continue;
          if (target && promptMenuEl.contains(target)) continue;
          promptMenuEl.style.display = "none";
          promptMenuClosed = true;
        }
        if (promptMenuClosed) {
          setPromptMenuTarget(null);
        }

        for (const exportMenuEl of exportMenus) {
          if (exportMenuEl.style.display === "none") continue;
          if (target && exportMenuEl.contains(target)) continue;
          const panelRoot = exportMenuEl.closest("#llm-main");
          const exportButtonEl = panelRoot?.querySelector(
            "#llm-export",
          ) as HTMLButtonElement | null;
          if (target && exportButtonEl?.contains(target)) continue;
          exportMenuEl.style.display = "none";
        }

        for (const slashMenuEl of slashMenus) {
          if (slashMenuEl.style.display === "none") continue;
          if (target && slashMenuEl.contains(target)) continue;
          const panelRoot = slashMenuEl.closest("#llm-main");
          const slashButtonEl = panelRoot?.querySelector(
            "#llm-upload-file",
          ) as HTMLButtonElement | null;
          if (target && slashButtonEl?.contains(target)) continue;
          slashMenuEl.style.display = "none";
          slashButtonEl?.setAttribute("aria-expanded", "false");
        }

        for (const historyMenuEl of historyMenus) {
          if (historyMenuEl.style.display === "none") continue;
          if (target && historyMenuEl.contains(target)) continue;
          const panelRoot = historyMenuEl.closest("#llm-main");
          const historyToggleEl = panelRoot?.querySelector(
            "#llm-history-toggle",
          ) as HTMLButtonElement | null;
          const historyNewEl = panelRoot?.querySelector(
            "#llm-history-new",
          ) as HTMLButtonElement | null;
          if (target && historyToggleEl?.contains(target)) continue;
          if (target && historyNewEl?.contains(target)) continue;
          historyMenuEl.style.display = "none";
          historyToggleEl?.setAttribute("aria-expanded", "false");
        }

        for (const historyNewMenuEl of historyNewMenus) {
          if (historyNewMenuEl.style.display === "none") continue;
          if (target && historyNewMenuEl.contains(target)) continue;
          const panelRoot = historyNewMenuEl.closest("#llm-main");
          const historyNewEl = panelRoot?.querySelector(
            "#llm-history-new",
          ) as HTMLButtonElement | null;
          if (target && historyNewEl?.contains(target)) continue;
          historyNewMenuEl.style.display = "none";
          historyNewEl?.setAttribute("aria-expanded", "false");
        }

        for (const historyRowMenuEl of historyRowMenus) {
          if (historyRowMenuEl.style.display === "none") continue;
          if (target && historyRowMenuEl.contains(target)) continue;
          closeHistoryRowMenu();
          break;
        }
      }
    });
    (
      doc as unknown as { __llmModelMenuDismiss?: boolean }
    ).__llmModelMenuDismiss = true;
  }

  // Remove image button
  if (previewMeta) {
    previewMeta.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      const selectedImages = selectedImageCache.get(item.id) || [];
      if (!selectedImages.length) return;
      const expanded = selectedImagePreviewExpandedCache.get(item.id) === true;
      const nextExpanded = !expanded;
      selectedImagePreviewExpandedCache.set(item.id, nextExpanded);
      if (nextExpanded) {
        selectedImagePreviewActiveIndexCache.set(item.id, 0);
        const textContextKey = getTextContextConversationKey();
        if (textContextKey) {
          setSelectedTextExpandedIndex(textContextKey, null);
          setNoteContextExpanded(textContextKey, null);
        }
        selectedPaperPreviewExpandedCache.set(item.id, false);
        selectedFilePreviewExpandedCache.set(item.id, false);
      }
      updatePaperPreviewPreservingScroll();
      updateFilePreviewPreservingScroll();
      updateSelectedTextPreviewPreservingScroll();
      updateImagePreviewPreservingScroll();
    });
  }

  if (removeImgBtn) {
    removeImgBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      clearSelectedImageState(item.id);
      updateImagePreviewPreservingScroll();
      if (status) setStatus(status, "Figures cleared", "ready");
    });
  }

  if (filePreviewMeta) {
    filePreviewMeta.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      const selectedFiles = selectedFileAttachmentCache.get(item.id) || [];
      if (!selectedFiles.length) return;
      const expanded = selectedFilePreviewExpandedCache.get(item.id) === true;
      const nextExpanded = !expanded;
      selectedFilePreviewExpandedCache.set(item.id, nextExpanded);
      if (nextExpanded) {
        const textContextKey = getTextContextConversationKey();
        if (textContextKey) {
          setSelectedTextExpandedIndex(textContextKey, null);
          setNoteContextExpanded(textContextKey, null);
        }
        selectedImagePreviewExpandedCache.set(item.id, false);
        selectedPaperPreviewExpandedCache.set(item.id, false);
      }
      updatePaperPreviewPreservingScroll();
      updateSelectedTextPreviewPreservingScroll();
      updateImagePreviewPreservingScroll();
      updateFilePreviewPreservingScroll();
    });
  }

  if (filePreviewClear) {
    filePreviewClear.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      const selectedFiles = selectedFileAttachmentCache.get(item.id) || [];
      for (const entry of selectedFiles) {
        if (!entry?.storedPath) continue;
        if (entry.contentHash || isManagedBlobPath(entry.storedPath)) continue;
        void removeAttachmentFile(entry.storedPath).catch((err) => {
          ztoolkit.log("LLM: Failed to remove cleared attachment file", err);
        });
      }
      clearSelectedFileState(item.id);
      updateFilePreviewPreservingScroll();
      scheduleAttachmentGc();
      if (status) setStatus(status, "Files cleared", "ready");
    });
  }

  if (filePreviewList) {
    filePreviewList.addEventListener("contextmenu", (e: Event) => {
      if (!item) return;
      const target = e.target as Element | null;
      if (!target) return;
      const row = target.closest(
        ".llm-file-context-item",
      ) as HTMLDivElement | null;
      if (!row || !filePreviewList.contains(row)) return;
      const index = Number.parseInt(row.dataset.fileContextIndex || "", 10);
      const selectedFiles = selectedFileAttachmentCache.get(item.id) || [];
      if (
        !Number.isFinite(index) ||
        index < 0 ||
        index >= selectedFiles.length
      ) {
        return;
      }
      const targetFile = selectedFiles[index];
      if (!targetFile) return;
      e.preventDefault();
      e.stopPropagation();
      const nextPinned = togglePinnedFile(pinnedFileKeys, item.id, targetFile);
      updateFilePreviewPreservingScroll();
      if (status) {
        setStatus(
          status,
          nextPinned ? "File pinned for next sends" : "File unpinned",
          "ready",
        );
      }
    });
  }

  if (previewStrip) {
    previewStrip.addEventListener("contextmenu", (e: Event) => {
      if (!item) return;
      const target = e.target as Element | null;
      if (!target) return;
      const thumbItem = target.closest(
        ".llm-preview-item",
      ) as HTMLDivElement | null;
      if (!thumbItem || !previewStrip.contains(thumbItem)) return;
      const index = Number.parseInt(
        thumbItem.dataset.imageContextIndex || "",
        10,
      );
      const selectedImages = selectedImageCache.get(item.id) || [];
      if (
        !Number.isFinite(index) ||
        index < 0 ||
        index >= selectedImages.length
      ) {
        return;
      }
      const targetImage = selectedImages[index];
      if (!targetImage) return;
      e.preventDefault();
      e.stopPropagation();
      const nextPinned = togglePinnedImage(
        pinnedImageKeys,
        item.id,
        targetImage,
      );
      updateImagePreviewPreservingScroll();
      if (status) {
        setStatus(
          status,
          nextPinned
            ? "Screenshot pinned for next sends"
            : "Screenshot unpinned",
          "ready",
        );
      }
    });
  }

  if (paperPreview) {
    paperPreview.addEventListener("click", (e: Event) => {
      if (!item) return;
      const target = e.target as Element | null;
      if (!target) return;

      // Other/figure ref chip removal
      const otherClearBtn = target.closest(
        ".llm-other-ref-clear",
      ) as HTMLButtonElement | null;
      if (otherClearBtn) {
        e.preventDefault();
        e.stopPropagation();
        const index = Number.parseInt(otherClearBtn.dataset.otherRefIndex || "", 10);
        const others = selectedOtherRefContextCache.get(item.id) || [];
        if (Number.isFinite(index) && index >= 0 && index < others.length) {
          const next = others.filter((_, i) => i !== index);
          if (next.length) {
            selectedOtherRefContextCache.set(item.id, next);
          } else {
            selectedOtherRefContextCache.delete(item.id);
          }
          updatePaperPreviewPreservingScroll();
          if (status) setStatus(status, `File context removed (${next.length})`, "ready");
        }
        return;
      }

      // Paper chip removal
      const clearBtn = target.closest(
        ".llm-paper-context-clear",
      ) as HTMLButtonElement | null;
      if (!clearBtn) return;
      e.preventDefault();
      e.stopPropagation();
      const index = Number.parseInt(
        clearBtn.dataset.paperContextIndex || "",
        10,
      );
      const selectedPapers = normalizePaperContextEntries(
        selectedPaperContextCache.get(item.id) || [],
      );
      if (
        !Number.isFinite(index) ||
        index < 0 ||
        index >= selectedPapers.length
      ) {
        return;
      }
      const removedPaper = selectedPapers[index];
      if (removedPaper) {
        paperContextModeOverrides.get(item.id)?.delete(buildPaperKey(removedPaper));
      }
      const nextPapers = selectedPapers.filter((_, i) => i !== index);
      if (nextPapers.length) {
        selectedPaperContextCache.set(item.id, nextPapers);
      } else {
        clearSelectedPaperState(item.id);
      }
      updatePaperPreviewPreservingScroll();
      if (status) {
        setStatus(
          status,
          `Paper context removed (${nextPapers.length})`,
          "ready",
        );
      }
      closePaperChipMenu();
      return;
    });
    paperPreview.addEventListener("contextmenu", (e: Event) => {
      if (!item) return;
      const target = e.target as Element | null;
      if (!target) return;
      const paperChip = target.closest(
        ".llm-paper-context-chip",
      ) as HTMLDivElement | null;
      if (!paperChip || !paperPreview.contains(paperChip)) return;
      if (target.closest(".llm-paper-context-clear")) return;
      const paperContext = resolvePaperContextFromChipElement(paperChip);
      if (!paperContext) return;
      e.preventDefault();
      e.stopPropagation();
      const nextMode =
        resolvePaperContextNextSendMode(item.id, paperContext) === "full-sticky"
          ? "retrieval"
          : "full-sticky";
      setPaperModeOverride(item.id, paperContext, nextMode);
      paperChip.dataset.fullText = isPaperContextFullTextMode(nextMode)
        ? "true"
        : "false";
      paperChip.classList.toggle(
        "llm-paper-context-chip-full",
        isPaperContextFullTextMode(nextMode),
      );
      closePaperChipMenu();
      if (status) {
        setStatus(
          status,
          nextMode === "full-sticky"
            ? "Paper set to always send full text."
            : "Paper set to retrieval mode.",
          "ready",
        );
      }
    });
    paperPreview.addEventListener("click", (e: Event) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (target.closest(".llm-paper-context-clear")) return;

      // Clicking the paper card (inside the expanded area) navigates to the paper
      const cardRow = target.closest(
        ".llm-paper-chip-menu-row",
      ) as HTMLButtonElement | null;
      if (cardRow) {
        const paperChipForCard = cardRow.closest(
          ".llm-paper-context-chip",
        ) as HTMLDivElement | null;
        if (!paperChipForCard || !paperPreview.contains(paperChipForCard)) return;
        e.preventDefault();
        e.stopPropagation();
        const paperContextForCard =
          resolvePaperContextFromChipElement(paperChipForCard);
        if (!paperContextForCard) return;
        void focusPaperContextInActiveTab(paperContextForCard)
          .then((focused) => {
            if (!focused && status) {
              setStatus(status, "Could not focus this paper", "error");
            }
          })
          .catch((err) => {
            ztoolkit.log(
              "LLM: Failed to focus paper context from card",
              err,
            );
            if (status) {
              setStatus(status, "Could not focus this paper", "error");
            }
          });
        return;
      }

      // Clicking the chip header area toggles the sticky-expanded state
      const paperChip = target.closest(
        ".llm-paper-context-chip",
      ) as HTMLDivElement | null;
      if (!paperChip || !paperPreview.contains(paperChip)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      const paperContext = resolvePaperContextFromChipElement(paperChip);
      if (!paperContext) return;
      const currentExpandedId = selectedPaperPreviewExpandedCache.get(item.id);
      const isAlreadyExpanded =
        typeof currentExpandedId === "number" &&
        currentExpandedId === paperContext.contextItemId;
      const nextExpandedId = isAlreadyExpanded ? false : paperContext.contextItemId;
      selectedPaperPreviewExpandedCache.set(item.id, nextExpandedId);

      // Toggle expanded class directly on the chip — no full re-render, no blink.
      const allChips = paperPreviewList?.querySelectorAll<HTMLDivElement>(
        ".llm-paper-context-chip",
      );
      if (allChips) {
        allChips.forEach((c: HTMLDivElement) => {
          const isThis = c === paperChip;
          const shouldExpand = isThis && nextExpandedId !== false;
          c.classList.toggle("expanded", shouldExpand);
          c.classList.toggle("collapsed", !shouldExpand);
        });
      }

      if (nextExpandedId !== false) {
        const textContextKey = getTextContextConversationKey();
        if (textContextKey) {
          setSelectedTextExpandedIndex(textContextKey, null);
          setNoteContextExpanded(textContextKey, null);
        }
        selectedImagePreviewExpandedCache.set(item.id, false);
        selectedFilePreviewExpandedCache.set(item.id, false);
      }
      // No full re-render here — DOM classes already toggled above, cache is updated.
    });
  }

  const resolveSelectedContextTargetItemId = (
    selectedContext: SelectedTextContext,
  ): number | null => {
    const explicitContextItemId = Number(selectedContext.contextItemId);
    if (Number.isFinite(explicitContextItemId) && explicitContextItemId > 0) {
      return Math.floor(explicitContextItemId);
    }

    const paperContextItemId = Number(
      selectedContext.paperContext?.contextItemId,
    );
    if (Number.isFinite(paperContextItemId) && paperContextItemId > 0) {
      return Math.floor(paperContextItemId);
    }

    const activeContextItem = getActiveContextAttachmentFromTabs();
    const activeContextItemId = Number(activeContextItem?.id || 0);
    if (Number.isFinite(activeContextItemId) && activeContextItemId > 0) {
      return Math.floor(activeContextItemId);
    }

    const currentPanelItemId = Number(
      item?.isAttachment?.() && item.attachmentContentType === "application/pdf"
        ? item.id
        : 0,
    );
    if (Number.isFinite(currentPanelItemId) && currentPanelItemId > 0) {
      return Math.floor(currentPanelItemId);
    }

    const basePaper = resolveCurrentPaperBaseItem();
    if (!basePaper) return null;
    const attachments = basePaper.getAttachments?.() || [];
    for (const attachmentId of attachments) {
      const attachment = Zotero.Items.get(attachmentId) || null;
      if (attachment?.attachmentContentType === "application/pdf") {
        return attachment.id;
      }
    }
    return null;
  };

  const navigateSelectedTextContextToPage = async (
    selectedContext: SelectedTextContext,
  ): Promise<boolean> => {
    const rawPageIndex = Number(selectedContext.pageIndex);
    if (!Number.isFinite(rawPageIndex) || rawPageIndex < 0) return false;
    const pageIndex = Math.floor(rawPageIndex);
    const pageLabel = selectedContext.pageLabel || `${pageIndex + 1}`;
    const targetItemId = resolveSelectedContextTargetItemId(selectedContext);
    if (!targetItemId) return false;

    const location = {
      pageIndex,
      pageLabel,
    };
    const activeReader = getActiveReaderForSelectedTab();
    const activeReaderItemId = Number(
      activeReader?._item?.id || activeReader?.itemID || 0,
    );
    if (
      Number.isFinite(activeReaderItemId) &&
      activeReaderItemId === targetItemId &&
      typeof activeReader?.navigate === "function"
    ) {
      await activeReader.navigate(location);
      await flashPageInLivePdfReader(activeReader, pageIndex);
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
      const openedReader = await readerApi.open(targetItemId, location);
      const nextReader =
        openedReader ||
        ((
          Zotero.Reader as
            | {
                getByTabID?: (
                  tabID: string | number,
                ) => _ZoteroTypes.ReaderInstance;
              }
            | undefined
        )?.getByTabID &&
          (() => {
            const tabs = (
              Zotero as unknown as {
                Tabs?: { selectedID?: string | number | null };
              }
            ).Tabs;
            const selectedTabId = tabs?.selectedID;
            return selectedTabId !== undefined && selectedTabId !== null
              ? Zotero.Reader.getByTabID?.(`${selectedTabId}`) || null
              : null;
          })()) ||
        getActiveReaderForSelectedTab();
      if (nextReader) {
        await flashPageInLivePdfReader(nextReader, pageIndex);
      }
      return true;
    }

    const pane = Zotero.getActiveZoteroPane?.() as
      | {
          viewPDF?: (
            itemID: number,
            location: _ZoteroTypes.Reader.Location,
          ) => Promise<void>;
        }
      | undefined;
    if (typeof pane?.viewPDF === "function") {
      await pane.viewPDF(targetItemId, location);
      const nextReader = getActiveReaderForSelectedTab();
      if (nextReader) {
        await flashPageInLivePdfReader(nextReader, pageIndex);
      }
      return true;
    }

    return false;
  };

  if (selectedContextList) {
    selectedContextList.addEventListener("mouseover", (e: Event) => {
      const target = e.target as Element | null;
      const noteChip = target?.closest("[data-note-chip='true']") as
        | HTMLDivElement
        | null;
      if (!noteChip) {
        return;
      }
      if (noteChip.dataset.noteChipKind === "active") {
        refreshActiveNoteChipPreview(body);
      } else {
        refreshNoteChipPreview(noteChip);
      }
    });
    selectedContextList.addEventListener("focusin", (e: Event) => {
      const target = e.target as Element | null;
      const noteChip = target?.closest("[data-note-chip='true']") as
        | HTMLDivElement
        | null;
      if (!noteChip) {
        return;
      }
      if (noteChip.dataset.noteChipKind === "active") {
        refreshActiveNoteChipPreview(body);
      } else {
        refreshNoteChipPreview(noteChip);
      }
    });
    selectedContextList.addEventListener("click", (e: Event) => {
      if (!item) return;
      const target = e.target as Element | null;
      if (!target) return;
      const noteChip = target.closest("[data-note-chip='true']") as
        | HTMLDivElement
        | null;
      const noteChipKind = noteChip?.dataset.noteChipKind || "";
      const noteMetaBtn = target.closest(
        ".llm-note-context-meta",
      ) as HTMLButtonElement | null;
      if (noteMetaBtn && noteChipKind === "active") {
        e.preventDefault();
        e.stopPropagation();
        const textContextKey = getTextContextConversationKey();
        if (!textContextKey) return;
        refreshActiveNoteChipPreview(body);
        const nextExpanded = !isNoteContextExpanded(textContextKey);
        setNoteContextExpanded(textContextKey, nextExpanded);
        if (nextExpanded) {
          setSelectedTextExpandedIndex(textContextKey, null);
          selectedImagePreviewExpandedCache.set(item.id, false);
          selectedPaperPreviewExpandedCache.set(item.id, false);
          selectedFilePreviewExpandedCache.set(item.id, false);
        }
        updatePaperPreviewPreservingScroll();
        updateFilePreviewPreservingScroll();
        updateImagePreviewPreservingScroll();
        updateSelectedTextPreviewPreservingScroll();
        return;
      }
      if (noteChip && noteChipKind === "active") {
        return;
      }

      const clearBtn = target.closest(
        ".llm-selected-context-clear",
      ) as HTMLButtonElement | null;
      if (clearBtn) {
        e.preventDefault();
        e.stopPropagation();
        const textContextKey = getTextContextConversationKey();
        if (!textContextKey) return;
        const index = Number.parseInt(clearBtn.dataset.contextIndex || "", 10);
        const selectedContexts = getSelectedTextContextEntries(textContextKey);
        if (
          !Number.isFinite(index) ||
          index < 0 ||
          index >= selectedContexts.length
        ) {
          return;
        }
        removePinnedSelectedText(
          pinnedSelectedTextKeys,
          textContextKey,
          selectedContexts[index],
        );
        const nextContexts = selectedContexts.filter((_, i) => i !== index);
        setSelectedTextContextEntries(textContextKey, nextContexts);
        setSelectedTextExpandedIndex(textContextKey, null);
        updateSelectedTextPreviewPreservingScroll();
        if (status) setStatus(status, "Selected text removed", "ready");
        return;
      }

      const metaBtn = target.closest(
        ".llm-selected-context-meta",
      ) as HTMLButtonElement | null;
      if (!metaBtn) return;
      e.preventDefault();
      e.stopPropagation();
      const textContextKey = getTextContextConversationKey();
      if (!textContextKey) return;
      const index = Number.parseInt(metaBtn.dataset.contextIndex || "", 10);
      const selectedContexts = getSelectedTextContextEntries(textContextKey);
      if (
        !Number.isFinite(index) ||
        index < 0 ||
        index >= selectedContexts.length
      )
        return;
      const targetContext = selectedContexts[index];
      const isJumpablePdfContext =
        targetContext?.source === "pdf" &&
        Number.isFinite(targetContext.pageIndex) &&
        (targetContext.pageIndex as number) >= 0;
      if (isJumpablePdfContext) {
        void navigateSelectedTextContextToPage(targetContext)
          .then((navigated) => {
            if (!status) return;
            if (navigated) {
              setStatus(
                status,
                `Jumped to ${formatSelectedTextContextPageLabel(targetContext) || "page"}`,
                "ready",
              );
              return;
            }
            setStatus(
              status,
              "Could not open the page for this text context",
              "error",
            );
          })
          .catch((error) => {
            ztoolkit.log(
              "LLM: Failed to navigate selected text context",
              error,
            );
            if (status) {
              setStatus(
                status,
                "Could not open the page for this text context",
                "error",
              );
            }
          });
        return;
      }
      const expandedIndex = getSelectedTextExpandedIndex(
        textContextKey,
        selectedContexts.length,
      );
      const nextExpandedIndex = expandedIndex === index ? null : index;
      setSelectedTextExpandedIndex(textContextKey, nextExpandedIndex);
      if (nextExpandedIndex !== null) {
        setNoteContextExpanded(textContextKey, null);
        selectedImagePreviewExpandedCache.set(item.id, false);
        selectedPaperPreviewExpandedCache.set(item.id, false);
        selectedFilePreviewExpandedCache.set(item.id, false);
      }
      updatePaperPreviewPreservingScroll();
      updateFilePreviewPreservingScroll();
      updateImagePreviewPreservingScroll();
      updateSelectedTextPreviewPreservingScroll();
    });
    selectedContextList.addEventListener("contextmenu", (e: Event) => {
      if (!item) return;
      const target = e.target as Element | null;
      if (!target) return;
      const noteChip = target.closest("[data-note-chip='true']") as
        | HTMLDivElement
        | null;
      if (noteChip?.dataset.noteChipKind === "active") {
        e.preventDefault();
        e.stopPropagation();
        if (status) {
          setStatus(
            status,
            "Live note preview is pinned while editing",
            "ready",
          );
        }
        return;
      }
      const selectedContext = target.closest(
        ".llm-selected-context",
      ) as HTMLDivElement | null;
      if (!selectedContext || !selectedContextList.contains(selectedContext)) {
        return;
      }
      const textContextKey = getTextContextConversationKey();
      if (!textContextKey) return;
      const index = Number.parseInt(
        selectedContext.dataset.contextIndex || "",
        10,
      );
      const selectedContexts = getSelectedTextContextEntries(textContextKey);
      if (
        !Number.isFinite(index) ||
        index < 0 ||
        index >= selectedContexts.length
      ) {
        return;
      }
      if (selectedContexts[index]?.source === "note-edit") {
        e.preventDefault();
        e.stopPropagation();
        if (status) {
          setStatus(
            status,
            "Editing focus syncs to the live note selection",
            "ready",
          );
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const nextPinned = togglePinnedSelectedText(
        pinnedSelectedTextKeys,
        textContextKey,
        selectedContexts[index],
      );
      updateSelectedTextPreviewPreservingScroll();
      if (status) {
        setStatus(
          status,
          nextPinned
            ? "Text context pinned for next sends"
            : "Text context unpinned",
          "ready",
        );
      }
    });
  }

  const bodyWithPinnedDismiss = body as Element & {
    __llmPinnedContextDismissHandler?: (event: MouseEvent) => void;
  };
  if (bodyWithPinnedDismiss.__llmPinnedContextDismissHandler) {
    body.removeEventListener(
      "mousedown",
      bodyWithPinnedDismiss.__llmPinnedContextDismissHandler,
      true,
    );
  }
  const dismissPinnedContextPanels = (e: MouseEvent) => {
    if (e.button !== 0) return;
    if (!item) return;
    const target = e.target as Node | null;
    const clickedInsideTextPanel = Boolean(
      selectedContextList && target && selectedContextList.contains(target),
    );
    const clickedInsideFigurePanel = Boolean(
      imagePreview && target && imagePreview.contains(target),
    );
    const clickedInsideFilePanel = Boolean(
      filePreview && target && filePreview.contains(target),
    );
    const clickedInsidePaperPanel = Boolean(
      paperPreview && target && paperPreview.contains(target),
    );
    if (
      clickedInsideTextPanel ||
      clickedInsideFigurePanel ||
      clickedInsideFilePanel ||
      clickedInsidePaperPanel
    )
      return;

    const textContextKey = getTextContextConversationKey();
    if (!textContextKey) return;
    const textPinned =
      getSelectedTextExpandedIndex(
        textContextKey,
        getSelectedTextContexts(textContextKey).length,
      ) >= 0;
    const notePinned = isNoteContextExpanded(textContextKey);
    const figurePinned =
      selectedImagePreviewExpandedCache.get(item.id) === true;
    const paperPinned =
      typeof selectedPaperPreviewExpandedCache.get(item.id) === "number";
    const filePinned = selectedFilePreviewExpandedCache.get(item.id) === true;
    if (!textPinned && !notePinned && !figurePinned && !paperPinned && !filePinned)
      return;

    setSelectedTextExpandedIndex(textContextKey, null);
    setNoteContextExpanded(textContextKey, null);
    selectedImagePreviewExpandedCache.set(item.id, false);
    selectedPaperPreviewExpandedCache.set(item.id, false);
    selectedFilePreviewExpandedCache.set(item.id, false);
    updatePaperPreviewPreservingScroll();
    updateFilePreviewPreservingScroll();
    updateSelectedTextPreviewPreservingScroll();
    updateImagePreviewPreservingScroll();
  };
  body.addEventListener("mousedown", dismissPinnedContextPanels, true);
  bodyWithPinnedDismiss.__llmPinnedContextDismissHandler =
    dismissPinnedContextPanels;

  // Cancel button
  if (cancelBtn) {
    cancelBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (currentAbortController) {
        currentAbortController.abort();
      }
      setCancelledRequestId(currentRequestId);
      if (status) setStatus(status, "Cancelled", "ready");
      // Re-enable UI
      if (inputBox) inputBox.disabled = false;
      if (sendBtn) {
        sendBtn.style.display = "";
        sendBtn.disabled = false;
      }
      cancelBtn.style.display = "none";
      if (historyNewBtn) {
        historyNewBtn.disabled = false;
        historyNewBtn.setAttribute("aria-disabled", "false");
      }
      if (historyToggleBtn) {
        historyToggleBtn.disabled = false;
        historyToggleBtn.setAttribute("aria-disabled", "false");
      }
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
      void clearCurrentConversation();
    });
  }
}

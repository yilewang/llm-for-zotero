import { createElement } from "../../utils/domHelpers";
import {
  AUTO_SCROLL_BOTTOM_THRESHOLD,
  MAX_SELECTED_IMAGES,
  MAX_SELECTED_PAPER_CONTEXTS,
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
  MODEL_PROFILE_ORDER,
  GLOBAL_HISTORY_LIMIT,
  type ModelProfileKey,
} from "./constants";
import {
  selectedModelCache,
  selectedReasoningCache,
  selectedImageCache,
  selectedFileAttachmentCache,
  selectedImagePreviewExpandedCache,
  selectedImagePreviewActiveIndexCache,
  selectedFilePreviewExpandedCache,
  selectedPaperContextCache,
  selectedPaperPreviewExpandedCache,
  pinnedSelectedTextKeys,
  pinnedImageKeys,
  pinnedFileKeys,
  pinnedPaperKeys,
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
  activeGlobalConversationByLibrary,
  activeConversationModeByLibrary,
  activePaperConversationByPaper,
  draftInputCache,
  activeContextPanels,
  activeContextPanelStateSync,
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
  getApiProfiles,
  getSelectedProfileForItem,
  applyPanelFontScale,
  getAdvancedModelParamsForProfile,
  getLastUsedModelProfileKey,
  setLastUsedModelProfileKey,
  getLastUsedReasoningLevel,
  setLastUsedReasoningLevel,
  getLastUsedPaperConversationKey,
  setLastUsedPaperConversationKey,
  removeLastUsedPaperConversationKey,
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
  findLatestRetryPair,
  type EditLatestTurnMarker,
} from "./chat";
import {
  getActiveReaderSelectionText,
  getActiveContextAttachmentFromTabs,
  addSelectedTextContext,
  applySelectedTextPreview,
  getSelectedTextContextEntries,
  getSelectedTextContexts,
  getSelectedTextExpandedIndex,
  includeSelectedTextFromReader,
  resolveContextSourceItem,
  setSelectedTextContextEntries,
  setSelectedTextContexts,
  setSelectedTextExpandedIndex,
} from "./contextResolution";
import { resolvePaperContextRefFromAttachment } from "./paperAttribution";
import { captureScreenshotSelection, optimizeImageDataUrl } from "./screenshot";
import {
  createNoteFromAssistantText,
  createNoteFromChatHistory,
  createStandaloneNoteFromChatHistory,
  buildChatHistoryNotePayload,
} from "./notes";
import {
  persistAttachmentBlob,
  extractManagedBlobHash,
  isManagedBlobPath,
  removeAttachmentFile,
  removeConversationAttachmentFiles,
} from "./attachmentStorage";
import {
  clearConversation as clearStoredConversation,
  createGlobalConversation,
  createPaperConversation,
  deleteTurnMessages,
  deleteGlobalConversation,
  deletePaperConversation,
  getGlobalConversationUserTurnCount,
  getLatestEmptyGlobalConversation,
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
  ReasoningLevelSelection,
  ReasoningOption,
  AdvancedModelParams,
  PaperContextRef,
} from "./types";
import type { ReasoningLevel as LLMReasoningLevel } from "../../utils/llmClient";
import type { ReasoningConfig as LLMReasoningConfig } from "../../utils/llmClient";
import {
  searchPaperCandidates,
  type PaperSearchAttachmentCandidate,
  type PaperSearchGroupCandidate,
} from "./paperSearch";
import {
  createGlobalPortalItem,
  createPaperPortalItem,
  getPaperPortalBaseItemID,
  isGlobalPortalItem,
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
  isPinnedPaper,
  prunePinnedFileKeys,
  prunePinnedImageKeys,
  prunePinnedPaperKeys,
  removePinnedFile,
  removePinnedImage,
  removePinnedPaper,
  removePinnedSelectedText,
  retainPinnedFiles,
  retainPinnedImages,
  retainPinnedPapers,
  retainPinnedSelectedTextContexts,
  togglePinnedFile,
  togglePinnedImage,
  togglePinnedPaper,
  togglePinnedSelectedText,
} from "./setupHandlers/controllers/pinnedContextController";
import {
  createFileIntakeController,
  extractFilesFromClipboard,
  isFileDragEvent,
} from "./setupHandlers/controllers/fileIntakeController";
import { createSendFlowController } from "./setupHandlers/controllers/sendFlowController";

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
    reasoningSlot,
    reasoningMenu,
    actionsRow,
    actionsLeft,
    actionsRight,
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
    responseMenu,
    responseMenuCopyBtn,
    responseMenuNoteBtn,
    responseMenuDeleteBtn,
    promptMenu,
    promptMenuEditBtn,
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

  const isGlobalMode = () => Boolean(item && isGlobalPortalItem(item));
  const isPaperMode = () => Boolean(item && !isGlobalPortalItem(item));
  const getCurrentLibraryID = (): number => {
    const fromItem =
      item && Number.isFinite(item.libraryID) && item.libraryID > 0
        ? Math.floor(item.libraryID)
        : 0;
    if (fromItem > 0) return fromItem;
    return resolveActiveLibraryID() || 0;
  };
  const resolveCurrentPaperBaseItem = (): Zotero.Item | null => {
    if (basePaperItem?.isRegularItem?.()) return basePaperItem;
    const resolvedFromItem = resolveConversationBaseItem(item);
    if (resolvedFromItem) {
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
  const updateHistoryModeIndicatorPosition = () => {
    if (!historyModeIndicator || !historyNewBtn || !exportBtn || !headerTop) {
      return;
    }
    if (!historyBar || historyBar.style.display === "none") return;
    if (!item) return;

    const hostRect = headerTop.getBoundingClientRect();
    const historyAnchorRect = historyNewBtn.getBoundingClientRect();
    const exportRect = exportBtn.getBoundingClientRect();
    if (
      hostRect.width <= 0 ||
      historyAnchorRect.width <= 0 ||
      exportRect.width <= 0
    ) {
      return;
    }

    const indicatorWidth = Math.max(
      historyModeIndicator.getBoundingClientRect().width,
      historyModeIndicator.offsetWidth,
      0,
    );
    const preferredLeft = historyAnchorRect.right - hostRect.left + 6;
    const maxLeft = exportRect.left - hostRect.left - indicatorWidth - 8;
    let left = preferredLeft;
    if (Number.isFinite(maxLeft) && maxLeft >= preferredLeft) {
      left = clampNumber(preferredLeft, preferredLeft, maxLeft);
    } else {
      left = clampNumber(left, 0, Math.max(0, hostRect.width - indicatorWidth));
    }
    historyModeIndicator.style.left = `${Math.round(left)}px`;
  };
  const syncConversationIdentity = () => {
    conversationKey = item ? getConversationKey(item) : null;
    panelRoot.dataset.itemId =
      Number.isFinite(conversationKey) && (conversationKey as number) > 0
        ? `${conversationKey}`
        : "";
    const libraryID = getCurrentLibraryID();
    panelRoot.dataset.libraryId = libraryID > 0 ? `${libraryID}` : "";
    const mode: "global" | "paper" | null = item
      ? isGlobalMode()
        ? "global"
        : "paper"
      : null;
    panelRoot.dataset.conversationKind = mode || "";
    const currentBasePaperItemID =
      mode === "paper" ? Number(resolveCurrentPaperBaseItem()?.id || 0) : 0;
    panelRoot.dataset.basePaperItemId =
      Number.isFinite(currentBasePaperItemID) && currentBasePaperItemID > 0
        ? `${Math.floor(currentBasePaperItemID)}`
        : "";
    if (item && libraryID > 0 && mode) {
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
      const modeLabel = item
        ? mode === "global"
          ? "Open chat"
          : "Paper chat"
        : "";
      historyModeIndicator.textContent = item ? modeLabel : "";
      historyModeIndicator.title = modeLabel
        ? `${modeLabel} history`
        : "Conversation history";
      historyModeIndicator.setAttribute(
        "aria-label",
        modeLabel ? `${modeLabel} history` : "Conversation history",
      );
      const requestFrame = panelWin?.requestAnimationFrame;
      if (typeof requestFrame === "function") {
        requestFrame(() => {
          updateHistoryModeIndicatorPosition();
        });
      } else {
        updateHistoryModeIndicatorPosition();
      }
    }
  };
  syncConversationIdentity();
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
    closeHistoryRowMenu();
  };
  const closeSlashMenu = () => {
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

  selectionPopup.addEventListener("mousedown", (e: Event) => {
    const me = e as MouseEvent;
    if (me.button !== 0) return;
    me.preventDefault();
    me.stopPropagation();
    quoteSelectedAssistantText();
  });
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
          if (isGlobalPortalItem(targetItem)) {
            const libraryID =
              Number.isFinite(targetItem.libraryID) && targetItem.libraryID > 0
                ? Math.floor(targetItem.libraryID)
                : getCurrentLibraryID();
            await createStandaloneNoteFromChatHistory(libraryID, [
              {
                role: "assistant",
                text: contentText,
                timestamp: Date.now(),
                modelName,
              },
            ]);
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

  if (promptMenu && promptMenuEditBtn) {
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
      promptMenuEditBtn.addEventListener("click", async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        const target = promptMenuTarget;
        closePromptMenu();
        if (!item || !target) return;
        if (!target.editable) {
          if (status)
            setStatus(status, "Only the latest prompt is editable", "ready");
          return;
        }
        if (
          target.item.id !== item.id ||
          target.conversationKey !== getConversationKey(item)
        ) {
          activeEditSession = null;
          if (status) setStatus(status, EDIT_STALE_STATUS_TEXT, "error");
          return;
        }
        const latest = await getLatestEditablePair();
        if (!latest) {
          activeEditSession = null;
          if (status) setStatus(status, "No editable latest prompt", "error");
          return;
        }
        const { conversationKey: latestKey, pair } = latest;
        if (
          pair.assistantMessage.streaming ||
          pair.userMessage.timestamp !== target.userTimestamp ||
          pair.assistantMessage.timestamp !== target.assistantTimestamp
        ) {
          activeEditSession = null;
          if (status) setStatus(status, EDIT_STALE_STATUS_TEXT, "error");
          return;
        }

        inputBox.value = sanitizeText(pair.userMessage.text || "");
        persistDraftInputForCurrentConversation();

        const restoredSelectedTexts = Array.isArray(
          pair.userMessage.selectedTexts,
        )
          ? pair.userMessage.selectedTexts
              .map((value) =>
                typeof value === "string" ? sanitizeText(value).trim() : "",
              )
              .filter(Boolean)
          : typeof pair.userMessage.selectedText === "string" &&
              sanitizeText(pair.userMessage.selectedText).trim()
            ? [sanitizeText(pair.userMessage.selectedText).trim()]
            : [];
        const selectedTextPaperContexts = normalizeSelectedTextPaperContexts(
          pair.userMessage.selectedTextPaperContexts,
          restoredSelectedTexts.length,
          { sanitizeText },
        );
        const restoredSelectedEntries = restoredSelectedTexts.map(
          (text, index) => ({
            text,
            source: normalizeSelectedTextSource(
              pair.userMessage.selectedTextSources?.[index],
            ),
            paperContext: selectedTextPaperContexts[index],
          }),
        );
        const textContextKey = getTextContextConversationKey();
        if (!textContextKey) return;
        if (restoredSelectedEntries.length) {
          setSelectedTextContextEntries(
            textContextKey,
            restoredSelectedEntries,
          );
        } else {
          clearSelectedTextState(textContextKey);
        }
        setSelectedTextExpandedIndex(textContextKey, null);

        const restoredPaperContexts = normalizePaperContextEntries(
          pair.userMessage.paperContexts,
        );
        if (restoredPaperContexts.length) {
          selectedPaperContextCache.set(item.id, restoredPaperContexts);
          selectedPaperPreviewExpandedCache.set(item.id, false);
        } else {
          clearSelectedPaperState(item.id);
        }

        const restoredFiles = (
          Array.isArray(pair.userMessage.attachments)
            ? pair.userMessage.attachments.filter(
                (attachment) =>
                  Boolean(attachment) &&
                  typeof attachment === "object" &&
                  attachment.category !== "image" &&
                  typeof attachment.id === "string" &&
                  attachment.id.trim() &&
                  typeof attachment.name === "string" &&
                  attachment.name.trim(),
              )
            : []
        ).map((attachment) => ({
          ...attachment,
          id: attachment.id.trim(),
          name: attachment.name.trim(),
          mimeType:
            typeof attachment.mimeType === "string" &&
            attachment.mimeType.trim()
              ? attachment.mimeType.trim()
              : "application/octet-stream",
          sizeBytes: Number.isFinite(attachment.sizeBytes)
            ? Math.max(0, attachment.sizeBytes)
            : 0,
          textContent:
            typeof attachment.textContent === "string"
              ? attachment.textContent
              : undefined,
          storedPath:
            typeof attachment.storedPath === "string" &&
            attachment.storedPath.trim()
              ? attachment.storedPath.trim()
              : undefined,
          contentHash:
            typeof attachment.contentHash === "string" &&
            /^[a-f0-9]{64}$/i.test(attachment.contentHash.trim())
              ? attachment.contentHash.trim().toLowerCase()
              : undefined,
        }));
        if (restoredFiles.length) {
          selectedFileAttachmentCache.set(item.id, restoredFiles);
          selectedFilePreviewExpandedCache.set(item.id, false);
        } else {
          clearSelectedFileState(item.id);
        }

        const restoredImages = Array.isArray(pair.userMessage.screenshotImages)
          ? pair.userMessage.screenshotImages
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean)
              .slice(0, MAX_SELECTED_IMAGES)
          : [];
        if (restoredImages.length) {
          selectedImageCache.set(item.id, restoredImages);
          selectedImagePreviewExpandedCache.set(item.id, false);
          selectedImagePreviewActiveIndexCache.set(item.id, 0);
        } else {
          clearSelectedImageState(item.id);
        }

        updatePaperPreviewPreservingScroll();
        updateFilePreviewPreservingScroll();
        updateImagePreviewPreservingScroll();
        updateSelectedTextPreviewPreservingScroll();
        activeEditSession = {
          conversationKey: latestKey,
          userTimestamp: pair.userMessage.timestamp,
          assistantTimestamp: pair.assistantMessage.timestamp,
        };
        inputBox.focus({ preventScroll: true });
        if (status) setStatus(status, "Editing latest prompt", "ready");
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

  const clearSelectedPaperState = (itemId: number) => {
    selectedPaperContextCache.delete(itemId);
    selectedPaperPreviewExpandedCache.delete(itemId);
    clearPinnedContextOwner(pinnedPaperKeys, itemId);
  };

  const clearSelectedTextState = (itemId: number) => {
    setSelectedTextContexts(itemId, []);
    setSelectedTextExpandedIndex(itemId, null);
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
    if (!item || !inputBox) return;
    setDraftInputForConversation(getConversationKey(item), inputBox.value);
  };
  const restoreDraftInputForCurrentConversation = () => {
    if (!item || !inputBox) return;
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
  const retainPinnedPaperState = (itemId: number) => {
    const retained = retainPinnedPapers(
      pinnedPaperKeys,
      itemId,
      normalizePaperContextEntries(selectedPaperContextCache.get(itemId) || []),
    );
    if (retained.length) {
      selectedPaperContextCache.set(itemId, retained);
      return;
    }
    selectedPaperContextCache.delete(itemId);
    selectedPaperPreviewExpandedCache.delete(itemId);
  };
  const retainPinnedTextState = (itemId: number) => {
    const retained = retainPinnedSelectedTextContexts(
      pinnedSelectedTextKeys,
      itemId,
      getSelectedTextContextEntries(itemId),
    );
    setSelectedTextContextEntries(itemId, retained);
    setSelectedTextExpandedIndex(itemId, null);
  };
  const clearTransientComposeStateForItem = (itemId: number) => {
    clearDraftInputState(itemId);
    clearSelectedImageState(itemId);
    clearSelectedPaperState(itemId);
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
    if (!item || isGlobalMode()) return null;
    const contextSource = resolveContextSourceItem(item);
    return resolvePaperContextRefFromAttachment(contextSource.contextItem);
  };

  const appendPaperChip = (
    ownerDoc: Document,
    list: HTMLDivElement,
    paperContext: PaperContextRef,
    options?: {
      removable?: boolean;
      removableIndex?: number;
      autoLoaded?: boolean;
      pinned?: boolean;
    },
  ) => {
    const removable = options?.removable === true;
    const pinned = options?.pinned === true;
    const chip = createElement(
      ownerDoc,
      "div",
      "llm-selected-context llm-paper-context-chip",
    );
    if (options?.autoLoaded) {
      chip.classList.add("llm-paper-context-chip-autoloaded");
      chip.dataset.autoLoaded = "true";
    }
    if (removable) {
      chip.dataset.paperContextIndex = `${options?.removableIndex ?? -1}`;
    }
    chip.dataset.pinned = pinned ? "true" : "false";
    chip.classList.toggle("llm-paper-context-chip-pinned", pinned);
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

    chip.append(chipHeader);
    list.appendChild(chip);
  };

  const updatePaperPreview = () => {
    if (!item || !paperPreview || !paperPreviewList) return;
    const itemId = item.id;
    const selectedPapers = normalizePaperContextEntries(
      selectedPaperContextCache.get(itemId) || [],
    );
    prunePinnedPaperKeys(pinnedPaperKeys, itemId, selectedPapers);
    const autoLoadedPaperContext = resolveAutoLoadedPaperContext();
    if (!selectedPapers.length && !autoLoadedPaperContext) {
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
    selectedPaperPreviewExpandedCache.set(itemId, false);
    paperPreview.style.display = "contents";
    paperPreviewList.style.display = "contents";
    paperPreviewList.innerHTML = "";
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc) return;
    if (autoLoadedPaperContext) {
      appendPaperChip(ownerDoc, paperPreviewList, autoLoadedPaperContext, {
        autoLoaded: true,
        pinned: true,
      });
    }
    selectedPapers.forEach((paperContext, index) => {
      appendPaperChip(ownerDoc, paperPreviewList, paperContext, {
        removable: true,
        removableIndex: index,
        pinned: isPinnedPaper(pinnedPaperKeys, itemId, paperContext),
      });
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
        const removedEntry = currentFiles[index];
        const nextFiles = currentFiles.filter((_entry, i) => i !== index);
        if (removedEntry) {
          removePinnedFile(pinnedFileKeys, item.id, removedEntry);
        }
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

  let latestConversationHistory: ConversationHistoryEntry[] = [];
  const historySectionExpandedState = new Map<"paper" | "open", boolean>([
    ["paper", true],
    ["open", false],
  ]);
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
    screenshotImages: Array.isArray(message.screenshotImages)
      ? [...message.screenshotImages]
      : undefined,
    paperContexts: Array.isArray(message.paperContexts)
      ? [...message.paperContexts]
      : undefined,
    pinnedPaperContexts: Array.isArray(message.pinnedPaperContexts)
      ? [...message.pinnedPaperContexts]
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
    historySectionExpandedState.get(section) ?? (section === "paper");

  const setHistorySectionExpanded = (
    section: "paper" | "open",
    expanded: boolean,
  ) => {
    historySectionExpandedState.set(section, expanded);
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
    const sectionRows = sectionBlock.querySelector(
      ".llm-history-menu-section-rows",
    ) as HTMLDivElement | null;
    if (sectionRows) {
      sectionRows.hidden = !expanded;
      sectionRows.style.display = expanded ? "flex" : "none";
    }
  };

  const renderGlobalHistoryMenu = () => {
    if (!historyMenu) return;
    historyMenu.innerHTML = "";
    if (!latestConversationHistory.length) {
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
    const sectionEntries = new Map<
      "paper" | "open",
      { title: string; entries: ConversationHistoryEntry[] }
    >();
    for (const entry of latestConversationHistory) {
      if (entry.isPendingDelete) continue;
      const section = sectionEntries.get(entry.section) || {
        title: entry.sectionTitle,
        entries: [],
      };
      section.entries.push(entry);
      sectionEntries.set(entry.section, section);
    }
    const orderedSections = Array.from(sectionEntries.entries())
      .map(([sectionKey, section]) => {
        const latestActivity = section.entries.reduce(
          (max, entry) => Math.max(max, entry.lastActivityAt || 0),
          0,
        );
        return {
          sectionKey,
          title: section.title,
          entries: section.entries,
          latestActivity,
        };
      })
      .sort((a, b) => {
        if (b.latestActivity !== a.latestActivity) {
          return b.latestActivity - a.latestActivity;
        }
        if (a.sectionKey === b.sectionKey) return 0;
        return a.sectionKey === "paper" ? -1 : 1;
      });

    for (const section of orderedSections) {
      const expanded = isHistorySectionExpanded(section.sectionKey);
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

      const sectionRows = createElement(
        body.ownerDocument as Document,
        "div",
        "llm-history-menu-section-rows",
      ) as HTMLDivElement;
      sectionBlock.appendChild(sectionRows);
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
          {
            textContent: formatHistoryRowDisplayTitle(entry.title),
            title: entry.title,
          },
        );
        titleLine.append(title);
        const meta = createElement(
          body.ownerDocument as Document,
          "span",
          "llm-history-row-meta",
          {
            textContent: entry.timestampText,
            title: entry.timestampText,
          },
        );
        rowMain.append(titleLine, meta);
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
    updateHistoryModeIndicatorPosition();
  };

  const resetComposePreviewUI = () => {
    updatePaperPreviewPreservingScroll();
    updateFilePreviewPreservingScroll();
    updateImagePreviewPreservingScroll();
    updateSelectedTextPreviewPreservingScroll();
  };

  const switchGlobalConversation = async (nextConversationKey: number) => {
    if (!item) return;
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
    if (!item) return;
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
    if (!item) return;
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
    if (!item) return;
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
    await switchPaperConversation(createdSummary.conversationKey);
    if (status) {
      setStatus(status, "Started paper chat", "ready");
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

  if (historyNewBtn && historyNewMenu) {
    historyNewBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      if (
        currentAbortController ||
        historyNewBtn.disabled ||
        inputBox?.disabled
      ) {
        closeHistoryNewMenu();
        if (status) {
          setStatus(
            status,
            "New chat is unavailable while generating",
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
      const paperContextAvailable = Boolean(resolveCurrentPaperBaseItem());
      if (historyNewPaperBtn) {
        historyNewPaperBtn.disabled = !paperContextAvailable;
        historyNewPaperBtn.setAttribute(
          "aria-disabled",
          paperContextAvailable ? "false" : "true",
        );
        historyNewPaperBtn.title = paperContextAvailable
          ? "Start a new paper chat session"
          : "Open a paper to enable paper chat";
      }
      if (isHistoryNewMenuOpen()) {
        closeHistoryNewMenu();
        return;
      }
      positionMenuBelowButton(body, historyNewMenu, historyNewBtn);
      historyNewMenu.style.display = "flex";
      historyNewBtn.setAttribute("aria-expanded", "true");
    });
  }

  if (historyNewOpenBtn) {
    historyNewOpenBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      closeHistoryNewMenu();
      void createAndSwitchGlobalConversation();
    });
  }

  if (historyNewPaperBtn) {
    historyNewPaperBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
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

  if (historyToggleBtn && historyMenu) {
    historyToggleBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
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
        renderGlobalHistoryMenu();
        positionMenuBelowButton(body, historyMenu, historyToggleBtn);
        historyMenu.style.display = "flex";
        historyToggleBtn.setAttribute("aria-expanded", "true");
      })();
    });
  }

  if (historyMenu) {
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
    const profiles = getApiProfiles();
    const normalize = (value: string) =>
      value.trim().replace(/\s+/g, " ").toLowerCase();
    const primaryModel =
      (profiles.primary.model || "default").trim() || "default";
    const choices: Array<{ key: ModelProfileKey; model: string }> = [];
    const seenModels = new Set<string>();

    for (const key of MODEL_PROFILE_ORDER) {
      const model = (
        key === "primary" ? primaryModel : profiles[key].model
      ).trim();
      if (!model) continue;
      const normalized = normalize(model);
      if (seenModels.has(normalized)) continue;
      seenModels.add(normalized);
      choices.push({ key, model });
    }

    if (!choices.length) {
      choices.push({ key: "primary", model: primaryModel });
    }

    return { profiles, choices };
  };

  const getSelectedModelInfo = () => {
    const { choices } = getModelChoices();
    if (!item) {
      return {
        selected: "primary" as const,
        choices,
        currentModel: choices[0]?.model || "default",
      };
    }
    let selected =
      getLastUsedModelProfileKey() ||
      selectedModelCache.get(item.id) ||
      "primary";
    if (!choices.some((entry) => entry.key === selected)) {
      selected = choices[0]?.key || "primary";
    }
    selectedModelCache.set(item.id, selected);
    const current =
      choices.find((entry) => entry.key === selected) || choices[0];
    return {
      selected,
      choices,
      currentModel: current?.model || "default",
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
      "Reasoning";
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
      const { choices, currentModel } = getSelectedModelInfo();
      const hasSecondary = choices.length > 1;
      modelBtn.dataset.modelLabel = `${currentModel || "default"}`;
      modelBtn.dataset.modelHint = hasSecondary
        ? "Click to choose a model"
        : "Only one model is configured";
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

  const rebuildModelMenu = () => {
    if (!item || !modelMenu) return;
    const { choices, selected } = getSelectedModelInfo();

    modelMenu.innerHTML = "";
    appendDropdownInstruction(modelMenu, "Select model", "llm-model-menu-hint");
    for (const entry of choices) {
      const isSelected = entry.key === selected;
      const option = createElement(
        body.ownerDocument as Document,
        "button",
        "llm-response-menu-item llm-model-option",
        {
          type: "button",
          textContent: isSelected
            ? `\u2713 ${entry.model || "default"}`
            : entry.model || "default",
        },
      );
      const applyModelSelection = (e: Event) => {
        if (!isPrimaryPointerEvent(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (!item) return;
        selectedModelCache.clear();
        selectedModelCache.set(item.id, entry.key);
        setLastUsedModelProfileKey(entry.key);
        setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, false);
        setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
        updateModelButton();
        updateReasoningButton();
      };
      option.addEventListener("pointerdown", applyModelSelection);
      option.addEventListener("click", applyModelSelection);
      modelMenu.appendChild(option);
    }
  };

  const rebuildRetryModelMenu = () => {
    if (!item || !retryModelMenu) return;
    const { profiles, choices } = getModelChoices();
    const selectedKey = getSelectedModelInfo().selected;
    retryModelMenu.innerHTML = "";
    for (const entry of choices) {
      const profile = profiles[entry.key];
      const isSelected = selectedKey === entry.key;
      const option = createElement(
        body.ownerDocument as Document,
        "button",
        "llm-response-menu-item llm-model-option",
        {
          type: "button",
          textContent: isSelected
            ? `\u2713 ${entry.model || "default"}`
            : entry.model || "default",
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
          profile.model,
          profile.apiBase,
        );
        const retryAdvanced = getAdvancedModelParams(entry.key);
        await retryLatestAssistantResponse(
          body,
          item,
          profile.model,
          profile.apiBase,
          profile.apiKey,
          retryReasoning,
          retryAdvanced,
        );
      };
      option.addEventListener("click", (e: Event) => {
        void runRetry(e);
      });
      retryModelMenu.appendChild(option);
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
    const selectedProfile = getSelectedProfileForItem(item.id);
    const provider = detectReasoningProvider(currentModel);
    const options = getReasoningOptions(
      provider,
      currentModel,
      selectedProfile.apiBase,
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
      const active = available && selectedLevel !== "none";
      const reasoningLabel = active
        ? getReasoningLevelDisplayLabel(
            selectedLevel as LLMReasoningLevel,
            provider,
            currentModel,
            options,
          )
        : "Reasoning";
      reasoningBtn.disabled = !item || !available;
      reasoningBtn.classList.toggle(
        "llm-reasoning-btn-unavailable",
        !available,
      );
      reasoningBtn.classList.toggle("llm-reasoning-btn-active", active);
      reasoningBtn.style.background = "";
      reasoningBtn.style.borderColor = "";
      reasoningBtn.style.color = "";
      const reasoningHint = available
        ? "Click to choose reasoning level"
        : "Reasoning unavailable for current model";
      reasoningBtn.dataset.reasoningLabel = reasoningLabel;
      reasoningBtn.dataset.reasoningHint = reasoningHint;
      applyResponsiveActionButtonsLayout();
    });
  };

  const rebuildReasoningMenu = () => {
    if (!item || !reasoningMenu) return;
    const { provider, currentModel, options, selectedLevel } =
      getReasoningState();
    reasoningMenu.innerHTML = "";
    appendDropdownInstruction(
      reasoningMenu,
      "Reasoning level",
      "llm-reasoning-menu-hint",
    );
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
  if (isPaperMode()) {
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
          updateHistoryModeIndicatorPosition();
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
    return getSelectedProfileForItem(item.id);
  };

  const getAdvancedModelParams = (
    profileKey: ModelProfileKey | undefined,
  ): AdvancedModelParams | undefined => {
    if (!profileKey) return undefined;
    return getAdvancedModelParamsForProfile(profileKey);
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

  type ActiveSlashToken = {
    query: string;
    slashStart: number;
    caretEnd: number;
  };
  type PaperPickerRow =
    | {
        kind: "paper";
        groupIndex: number;
      }
    | {
        kind: "attachment";
        groupIndex: number;
        attachmentIndex: number;
      };
  let paperPickerGroups: PaperSearchGroupCandidate[] = [];
  let paperPickerExpandedGroupKeys = new Set<number>();
  let paperPickerRows: PaperPickerRow[] = [];
  let paperPickerActiveRowIndex = 0;
  let paperPickerRequestSeq = 0;
  let paperPickerDebounceTimer: number | null = null;
  const getActiveSlashToken = (): ActiveSlashToken | null => {
    const caretEnd =
      typeof inputBox.selectionStart === "number"
        ? inputBox.selectionStart
        : inputBox.value.length;
    const prefix = inputBox.value.slice(0, caretEnd);
    const match = prefix.match(/(?:^|\s)\/([^\s/]*)$/);
    if (!match) return null;
    const raw = match[0] || "";
    const fullStart = (match.index ?? prefix.length - raw.length) || 0;
    const slashStart = raw.startsWith(" ") ? fullStart + 1 : fullStart;
    return {
      query: sanitizeText(match[1] || "").trim(),
      slashStart,
      caretEnd,
    };
  };
  const isPaperPickerOpen = () =>
    Boolean(paperPicker && paperPicker.style.display !== "none");
  const closePaperPicker = () => {
    if (!paperPicker || !paperPickerList) return;
    paperPicker.style.display = "none";
    paperPickerGroups = [];
    paperPickerExpandedGroupKeys = new Set<number>();
    paperPickerRows = [];
    paperPickerActiveRowIndex = 0;
    paperPickerList.innerHTML = "";
  };
  const buildPaperMetaText = (paper: {
    citationKey?: string;
    firstCreator?: string;
    year?: string;
  }): string => {
    const parts = [
      paper.citationKey || "",
      paper.firstCreator || "",
      paper.year || "",
    ].filter(Boolean);
    return parts.join(" · ");
  };
  const getPaperPickerAttachmentDisplayTitle = (
    group: PaperSearchGroupCandidate,
    attachment: PaperSearchAttachmentCandidate,
    attachmentIndex: number,
  ): string => {
    const normalizedTitle = sanitizeText(attachment.title || "").trim();
    if (normalizedTitle) return normalizedTitle;
    return group.attachments.length > 1 ? `PDF ${attachmentIndex + 1}` : "PDF";
  };
  const getPaperPickerGroupKey = (group: PaperSearchGroupCandidate): number =>
    group.itemId;
  const isPaperPickerGroupExpanded = (
    group: PaperSearchGroupCandidate,
  ): boolean => {
    if (group.attachments.length <= 1) return false;
    return paperPickerExpandedGroupKeys.has(getPaperPickerGroupKey(group));
  };
  const rebuildPaperPickerRows = () => {
    const rows: PaperPickerRow[] = [];
    paperPickerGroups.forEach((group, groupIndex) => {
      rows.push({
        kind: "paper",
        groupIndex,
      });
      if (group.attachments.length <= 1) return;
      if (!isPaperPickerGroupExpanded(group)) return;
      group.attachments.forEach((_attachment, attachmentIndex) => {
        rows.push({
          kind: "attachment",
          groupIndex,
          attachmentIndex,
        });
      });
    });
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
  const findPaperPickerPaperRowIndex = (groupIndex: number): number => {
    for (let index = 0; index < paperPickerRows.length; index += 1) {
      const row = paperPickerRows[index];
      if (row.kind === "paper" && row.groupIndex === groupIndex) {
        return index;
      }
    }
    return -1;
  };
  const findPaperPickerFirstAttachmentRowIndex = (
    groupIndex: number,
  ): number => {
    for (let index = 0; index < paperPickerRows.length; index += 1) {
      const row = paperPickerRows[index];
      if (row.kind === "attachment" && row.groupIndex === groupIndex) {
        return index;
      }
    }
    return -1;
  };
  const togglePaperPickerGroupExpanded = (
    groupIndex: number,
    expanded?: boolean,
  ): boolean => {
    const group = paperPickerGroups[groupIndex];
    if (!group || group.attachments.length <= 1) return false;
    const groupKey = getPaperPickerGroupKey(group);
    const currentlyExpanded = paperPickerExpandedGroupKeys.has(groupKey);
    const nextExpanded = expanded === undefined ? !currentlyExpanded : expanded;
    if (nextExpanded === currentlyExpanded) return false;
    if (nextExpanded) {
      paperPickerExpandedGroupKeys.add(groupKey);
    } else {
      paperPickerExpandedGroupKeys.delete(groupKey);
    }
    rebuildPaperPickerRows();
    return true;
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
    selectedPaperPreviewExpandedCache.set(item.id, false);
    updatePaperPreviewPreservingScroll();
    if (status) {
      setStatus(
        status,
        `Paper context added (${nextPapers.length}/${MAX_SELECTED_PAPER_CONTEXTS})`,
        "ready",
      );
    }
    return true;
  };
  const consumeActiveSlashToken = (): boolean => {
    const token = getActiveSlashToken();
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
    groupIndex: number,
    attachmentIndex: number,
    selectionKind: "paper-single" | "attachment",
  ): boolean => {
    const selectedGroup = paperPickerGroups[groupIndex];
    if (!selectedGroup) return false;
    const selectedAttachment = selectedGroup.attachments[attachmentIndex];
    if (!selectedAttachment) return false;
    consumeActiveSlashToken();
    ztoolkit.log("LLM: Paper picker selection", {
      selectionKind,
      itemId: selectedGroup.itemId,
      contextItemId: selectedAttachment.contextItemId,
    });
    upsertPaperContext({
      itemId: selectedGroup.itemId,
      contextItemId: selectedAttachment.contextItemId,
      title: selectedGroup.title,
      citationKey: selectedGroup.citationKey,
      firstCreator: selectedGroup.firstCreator,
      year: selectedGroup.year,
    });
    closePaperPicker();
    inputBox.focus({ preventScroll: true });
    return true;
  };
  const selectPaperPickerRowAt = (index: number): boolean => {
    const row = getPaperPickerRowAt(index);
    if (!row) return false;
    if (row.kind === "attachment") {
      return selectPaperPickerAttachment(
        row.groupIndex,
        row.attachmentIndex,
        "attachment",
      );
    }
    const group = paperPickerGroups[row.groupIndex];
    if (!group) return false;
    if (group.attachments.length <= 1) {
      return selectPaperPickerAttachment(row.groupIndex, 0, "paper-single");
    }
    if (!isPaperPickerGroupExpanded(group)) {
      togglePaperPickerGroupExpanded(row.groupIndex, true);
      ztoolkit.log("LLM: Paper picker expanded group via keyboard", {
        itemId: group.itemId,
      });
      renderPaperPicker();
      return true;
    }
    const firstChildIndex = findPaperPickerFirstAttachmentRowIndex(
      row.groupIndex,
    );
    if (firstChildIndex >= 0) {
      paperPickerActiveRowIndex = firstChildIndex;
      renderPaperPicker();
      return true;
    }
    return false;
  };
  const handlePaperPickerArrowRight = (): boolean => {
    const activeRow = getPaperPickerRowAt(paperPickerActiveRowIndex);
    if (!activeRow || activeRow.kind !== "paper") return false;
    const group = paperPickerGroups[activeRow.groupIndex];
    if (!group || group.attachments.length <= 1) return false;
    if (!isPaperPickerGroupExpanded(group)) {
      togglePaperPickerGroupExpanded(activeRow.groupIndex, true);
      renderPaperPicker();
      return true;
    }
    const firstChildIndex = findPaperPickerFirstAttachmentRowIndex(
      activeRow.groupIndex,
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
    if (activeRow.kind === "attachment") {
      const parentIndex = findPaperPickerPaperRowIndex(activeRow.groupIndex);
      if (parentIndex >= 0 && parentIndex !== paperPickerActiveRowIndex) {
        paperPickerActiveRowIndex = parentIndex;
        renderPaperPicker();
        return true;
      }
      return false;
    }
    const group = paperPickerGroups[activeRow.groupIndex];
    if (!group || group.attachments.length <= 1) return false;
    if (!isPaperPickerGroupExpanded(group)) return false;
    togglePaperPickerGroupExpanded(activeRow.groupIndex, false);
    const parentIndex = findPaperPickerPaperRowIndex(activeRow.groupIndex);
    if (parentIndex >= 0) {
      paperPickerActiveRowIndex = parentIndex;
    }
    renderPaperPicker();
    return true;
  };
  const renderPaperPicker = () => {
    if (!paperPicker || !paperPickerList) return;
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc) return;
    if (!paperPickerGroups.length) {
      paperPickerList.innerHTML = "";
      const empty = createElement(ownerDoc, "div", "llm-paper-picker-empty", {
        textContent: "No papers matched.",
      });
      paperPickerList.appendChild(empty);
      paperPicker.style.display = "block";
      return;
    }
    rebuildPaperPickerRows();
    if (!paperPickerRows.length) {
      paperPickerList.innerHTML = "";
      const empty = createElement(ownerDoc, "div", "llm-paper-picker-empty", {
        textContent: "No papers matched.",
      });
      paperPickerList.appendChild(empty);
      paperPicker.style.display = "block";
      return;
    }
    paperPickerList.innerHTML = "";
    paperPickerRows.forEach((row, rowIndex) => {
      const option = createElement(
        ownerDoc,
        "div",
        `llm-paper-picker-item ${
          row.kind === "paper"
            ? "llm-paper-picker-group-row"
            : "llm-paper-picker-attachment-row"
        }`,
      );
      option.setAttribute("role", "option");
      option.setAttribute(
        "aria-selected",
        rowIndex === paperPickerActiveRowIndex ? "true" : "false",
      );
      option.tabIndex = -1;

      if (row.kind === "paper") {
        const group = paperPickerGroups[row.groupIndex];
        if (!group) return;
        const isMultiAttachment = group.attachments.length > 1;
        const expanded = isPaperPickerGroupExpanded(group);
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
        const title = createElement(
          ownerDoc,
          "span",
          "llm-paper-picker-title",
          {
            textContent: group.title,
            title: group.title,
          },
        );
        titleLine.appendChild(title);
        if (isMultiAttachment) {
          const attachmentCount = createElement(
            ownerDoc,
            "span",
            "llm-paper-picker-group-meta",
            {
              textContent: `${group.attachments.length} PDFs`,
            },
          );
          const chevron = createElement(
            ownerDoc,
            "span",
            "llm-paper-picker-group-chevron",
            {
              textContent: expanded ? "▾" : "▸",
            },
          );
          titleLine.append(attachmentCount, chevron);
        }
        rowMain.appendChild(titleLine);
        const meta = createElement(ownerDoc, "span", "llm-paper-picker-meta", {
          textContent: buildPaperMetaText(group) || "Supplemental paper",
        });
        rowMain.appendChild(meta);
        option.appendChild(rowMain);
      } else {
        const group = paperPickerGroups[row.groupIndex];
        if (!group) return;
        const attachment = group.attachments[row.attachmentIndex];
        if (!attachment) return;
        const attachmentTitle = getPaperPickerAttachmentDisplayTitle(
          group,
          attachment,
          row.attachmentIndex,
        );
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
          textContent: "PDF attachment",
        });
        attachmentMain.append(title, meta);
        option.append(indent, attachmentMain);
      }

      const choosePaperRow = (e: Event) => {
        const mouse = e as MouseEvent;
        if (typeof mouse.button === "number" && mouse.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (row.kind === "paper") {
          paperPickerActiveRowIndex = rowIndex;
          const group = paperPickerGroups[row.groupIndex];
          if (!group) return;
          if (group.attachments.length <= 1) {
            selectPaperPickerAttachment(row.groupIndex, 0, "paper-single");
            return;
          }
          togglePaperPickerGroupExpanded(row.groupIndex);
          const parentIndex = findPaperPickerPaperRowIndex(row.groupIndex);
          if (parentIndex >= 0) {
            paperPickerActiveRowIndex = parentIndex;
          }
          renderPaperPicker();
          return;
        }
        paperPickerActiveRowIndex = rowIndex;
        selectPaperPickerAttachment(
          row.groupIndex,
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
    if (paperPickerDebounceTimer !== null) {
      const win = body.ownerDocument?.defaultView;
      if (win) {
        win.clearTimeout(paperPickerDebounceTimer);
      } else {
        clearTimeout(paperPickerDebounceTimer);
      }
      paperPickerDebounceTimer = null;
    }
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
      const contextSource = resolveContextSourceItem(item);
      const excludeContextItemId = contextSource.contextItem?.id ?? null;
      const results = await searchPaperCandidates(
        libraryID,
        activeSlashToken.query,
        excludeContextItemId,
        20,
      );
      if (requestId !== paperPickerRequestSeq) return;
      if (!getActiveSlashToken()) {
        closePaperPicker();
        return;
      }
      paperPickerGroups = results;
      paperPickerExpandedGroupKeys = new Set<number>();
      if (activeSlashToken.query.trim()) {
        for (const group of paperPickerGroups) {
          if (
            group.attachments.length > 1 &&
            group.attachments.some((attachment) => attachment.score > 0)
          ) {
            paperPickerExpandedGroupKeys.add(getPaperPickerGroupKey(group));
          }
        }
      }
      const attachmentCount = paperPickerGroups.reduce(
        (count, group) => count + group.attachments.length,
        0,
      );
      ztoolkit.log("LLM: Paper picker grouped candidates", {
        groups: paperPickerGroups.length,
        attachments: attachmentCount,
        autoExpandedGroups: paperPickerExpandedGroupKeys.size,
      });
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
    });
    inputBox.addEventListener("click", () => {
      schedulePaperPickerSearch();
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
    getPinnedPaperContexts: (itemId) =>
      normalizePaperContextEntries(
        selectedPaperContextCache.get(itemId) || [],
      ).filter((paperContext) =>
        isPinnedPaper(pinnedPaperKeys, itemId, paperContext),
      ),
    getSelectedFiles: (itemId) => selectedFileAttachmentCache.get(itemId) || [],
    getSelectedImages: (itemId) => selectedImageCache.get(itemId) || [],
    resolvePromptText,
    buildQuestionWithSelectedTextContexts,
    buildModelPromptWithFileContext,
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
    retainPinnedPaperState,
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
    setStatusMessage: status
      ? (message, level) => {
          setStatus(status, message, level);
        }
      : undefined,
    editStaleStatusText: EDIT_STALE_STATUS_TEXT,
  });
  const executeSend = async () => {
    await doSend();
    persistDraftInputForCurrentConversation();
  };

  // Send button - use addEventListener
  sendBtn.addEventListener("click", (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    void executeSend();
  });

  // Enter key (Shift+Enter for newline)
  inputBox.addEventListener("keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
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
    selectTextBtn.addEventListener("click", (e: Event) => {
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
      const added = includeSelectedTextFromReader(body, item, selectedText, {
        targetItemId: textContextKey,
        paperContext: isGlobalMode() ? resolvedPaperContext : null,
      });
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
    const existingToken = getActiveSlashToken();
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
      const insertion = `${needsLeadingSpace ? " " : ""}/`;
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
        "Reference picker ready. Type to search papers.",
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
      positionFloatingMenu(body, slashMenu, uploadBtn);
      setFloatingMenuOpen(slashMenu, SLASH_MENU_OPEN_CLASS, true);
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
      closeSlashMenu();
      uploadInput.click();
    });
  }

  if (slashReferenceOption) {
    slashReferenceOption.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      closeSlashMenu();
      openReferenceSlashFromMenu();
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

  if (chatBox) {
    chatBox.addEventListener("click", (e: Event) => {
      const editTarget = (e.target as Element | null)?.closest(
        ".llm-edit-latest",
      ) as HTMLButtonElement | null;
      if (editTarget) {
        e.preventDefault();
        e.stopPropagation();
        closeResponseMenu();
        closeExportMenu();
        closeRetryModelMenu();
        if (!item || !promptMenuEditBtn) return;
        const userTimestamp = Number(editTarget.dataset.userTimestamp || "");
        const assistantTimestamp = Number(
          editTarget.dataset.assistantTimestamp || "",
        );
        if (
          !Number.isFinite(userTimestamp) ||
          !Number.isFinite(assistantTimestamp)
        ) {
          if (status) setStatus(status, "No editable latest prompt", "error");
          return;
        }
        setPromptMenuTarget({
          item,
          conversationKey: getConversationKey(item),
          userTimestamp,
          assistantTimestamp,
          editable: true,
        });
        promptMenuEditBtn.disabled = false;
        promptMenuEditBtn.click();
        return;
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
      removePinnedPaper(pinnedPaperKeys, item.id, selectedPapers[index]);
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
    });
    paperPreview.addEventListener("contextmenu", (e: Event) => {
      if (!item) return;
      const target = e.target as Element | null;
      if (!target) return;
      const paperChip = target.closest(
        ".llm-paper-context-chip",
      ) as HTMLDivElement | null;
      if (!paperChip || !paperPreview.contains(paperChip)) return;
      e.preventDefault();
      e.stopPropagation();
      if (paperChip.dataset.autoLoaded === "true") {
        if (status) {
          setStatus(status, "Default paper context is always pinned", "ready");
        }
        return;
      }
      const index = Number.parseInt(
        paperChip.dataset.paperContextIndex || "",
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
      const nextPinned = togglePinnedPaper(
        pinnedPaperKeys,
        item.id,
        selectedPapers[index],
      );
      updatePaperPreviewPreservingScroll();
      if (status) {
        setStatus(
          status,
          nextPinned ? "Paper pinned for next sends" : "Paper unpinned",
          "ready",
        );
      }
    });
  }

  if (selectedContextList) {
    selectedContextList.addEventListener("click", (e: Event) => {
      if (!item) return;
      const target = e.target as Element | null;
      if (!target) return;

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
      const expandedIndex = getSelectedTextExpandedIndex(
        textContextKey,
        selectedContexts.length,
      );
      const nextExpandedIndex = expandedIndex === index ? null : index;
      setSelectedTextExpandedIndex(textContextKey, nextExpandedIndex);
      if (nextExpandedIndex !== null) {
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
    const figurePinned =
      selectedImagePreviewExpandedCache.get(item.id) === true;
    const paperPinned = selectedPaperPreviewExpandedCache.get(item.id) === true;
    const filePinned = selectedFilePreviewExpandedCache.get(item.id) === true;
    if (!textPinned && !figurePinned && !paperPinned && !filePinned) return;

    setSelectedTextExpandedIndex(textContextKey, null);
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
      const conversationToClear = getConversationKey(item);
      if (pendingTurnDeletion?.conversationKey === conversationToClear) {
        clearPendingTurnDeletion();
      }
      const currentItemId = item.id;
      const libraryID = getCurrentLibraryID();
      clearTransientComposeStateForItem(currentItemId);
      resetComposePreviewUI();
      void (async () => {
        chatHistory.delete(conversationToClear);
        loadedConversationKeys.add(conversationToClear);
        try {
          await clearStoredConversation(conversationToClear);
        } catch (err) {
          ztoolkit.log("LLM: Failed to clear persisted chat history", err);
        }
        try {
          await clearOwnerAttachmentRefs("conversation", conversationToClear);
        } catch (err) {
          ztoolkit.log(
            "LLM: Failed to clear conversation attachment refs",
            err,
          );
        }
        try {
          await removeConversationAttachmentFiles(conversationToClear);
        } catch (err) {
          ztoolkit.log("LLM: Failed to clear chat attachment files", err);
        }

        if (isGlobalMode() && libraryID > 0) {
          try {
            await deleteGlobalConversation(conversationToClear);
          } catch (err) {
            ztoolkit.log("LLM: Failed to delete global conversation row", err);
          }
          let nextConversationKey = 0;
          try {
            const nextConversations = await listGlobalConversations(
              libraryID,
              1,
              true,
            );
            nextConversationKey = nextConversations[0]?.conversationKey || 0;
          } catch (err) {
            ztoolkit.log(
              "LLM: Failed to load next global conversation after clear",
              err,
            );
          }
          if (!nextConversationKey) {
            if (basePaperItem) {
              await switchPaperConversation();
              void refreshGlobalHistoryHeader();
              scheduleAttachmentGc();
              if (status) setStatus(status, "Cleared", "ready");
              return;
            }
            nextConversationKey = await createGlobalConversation(libraryID);
          }
          if (nextConversationKey > 0) {
            activeGlobalConversationByLibrary.set(
              libraryID,
              nextConversationKey,
            );
            await switchGlobalConversation(nextConversationKey);
          } else {
            refreshChatPreservingScroll();
          }
          void refreshGlobalHistoryHeader();
        } else {
          refreshChatPreservingScroll();
          void refreshGlobalHistoryHeader();
        }
        scheduleAttachmentGc();
        if (status) setStatus(status, "Cleared", "ready");
      })();
    });
  }
}

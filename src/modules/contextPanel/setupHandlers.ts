import { createElement } from "../../utils/domHelpers";
import {
  MAX_SELECTED_IMAGES,
  MAX_UPLOAD_PDF_SIZE_BYTES,
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
  ACTION_LAYOUT_FULL_MODE_BUFFER_PX,
  ACTION_LAYOUT_PARTIAL_MODE_BUFFER_PX,
  ACTION_LAYOUT_CONTEXT_ICON_WIDTH_PX,
  ACTION_LAYOUT_DROPDOWN_ICON_WIDTH_PX,
  ACTION_LAYOUT_MODEL_WRAP_MIN_CHARS,
  ACTION_LAYOUT_MODEL_FULL_MAX_LINES,
  MODEL_PROFILE_ORDER,
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
  selectedTextCache,
  selectedTextPreviewExpandedCache,
  setCancelledRequestId,
  currentAbortController,
  panelFontScalePercent,
  setPanelFontScalePercent,
  responseMenuTarget,
  setResponseMenuTarget,
  chatHistory,
  loadedConversationKeys,
  currentRequestId,
} from "./state";
import {
  sanitizeText,
  setStatus,
  clampNumber,
  buildQuestionWithSelectedText,
  getSelectedTextWithinBubble,
  getAttachmentTypeLabel,
} from "./textUtils";
import {
  positionMenuBelowButton,
  positionMenuAtPointer,
} from "./menuPositioning";
import {
  getApiProfiles,
  getSelectedProfileForItem,
  applyPanelFontScale,
  getAdvancedModelParamsForProfile,
} from "./prefHelpers";
import {
  sendQuestion,
  refreshChat,
  getConversationKey,
  ensureConversationLoaded,
  persistChatScrollSnapshot,
  isScrollUpdateSuspended,
  withScrollGuard,
  copyTextToClipboard,
  copyRenderedMarkdownToClipboard,
  detectReasoningProvider,
  getReasoningOptions,
  getSelectedReasoningForItem,
} from "./chat";
import {
  getActiveReaderSelectionText,
  applySelectedTextPreview,
  includeSelectedTextFromReader,
} from "./contextResolution";
import { captureScreenshotSelection, optimizeImageDataUrl } from "./screenshot";
import {
  createNoteFromAssistantText,
  createNoteFromChatHistory,
  buildChatHistoryNotePayload,
} from "./notes";
import {
  persistConversationAttachmentFile,
  removeAttachmentFile,
  removeConversationAttachmentFiles,
} from "./attachmentStorage";
import { clearConversation as clearStoredConversation } from "../../utils/chatStore";
import type {
  ReasoningLevelSelection,
  ReasoningOption,
  ReasoningProviderKind,
  AdvancedModelParams,
  ChatAttachment,
} from "./types";
import type { ReasoningLevel as LLMReasoningLevel } from "../../utils/llmClient";
import type { ReasoningConfig as LLMReasoningConfig } from "../../utils/llmClient";

export function setupHandlers(body: Element, item?: Zotero.Item | null) {
  // Use querySelector on body to find elements
  const inputBox = body.querySelector(
    "#llm-input",
  ) as HTMLTextAreaElement | null;
  const inputSection = body.querySelector(
    ".llm-input-section",
  ) as HTMLDivElement | null;
  const sendBtn = body.querySelector("#llm-send") as HTMLButtonElement | null;
  const cancelBtn = body.querySelector(
    "#llm-cancel",
  ) as HTMLButtonElement | null;
  const modelBtn = body.querySelector(
    "#llm-model-toggle",
  ) as HTMLButtonElement | null;
  const modelSlot = body.querySelector(
    "#llm-model-dropdown",
  ) as HTMLDivElement | null;
  const modelMenu = body.querySelector(
    "#llm-model-menu",
  ) as HTMLDivElement | null;
  const reasoningBtn = body.querySelector(
    "#llm-reasoning-toggle",
  ) as HTMLButtonElement | null;
  const reasoningSlot = body.querySelector(
    "#llm-reasoning-dropdown",
  ) as HTMLDivElement | null;
  const reasoningMenu = body.querySelector(
    "#llm-reasoning-menu",
  ) as HTMLDivElement | null;
  const actionsRow = body.querySelector(
    ".llm-actions",
  ) as HTMLDivElement | null;
  const actionsLeft = body.querySelector(
    ".llm-actions-left",
  ) as HTMLDivElement | null;
  const actionsRight = body.querySelector(
    ".llm-actions-right",
  ) as HTMLDivElement | null;
  const exportBtn = body.querySelector(
    "#llm-export",
  ) as HTMLButtonElement | null;
  const clearBtn = body.querySelector("#llm-clear") as HTMLButtonElement | null;
  const selectTextBtn = body.querySelector(
    "#llm-select-text",
  ) as HTMLButtonElement | null;
  const screenshotBtn = body.querySelector(
    "#llm-screenshot",
  ) as HTMLButtonElement | null;
  const uploadBtn = body.querySelector(
    "#llm-upload-file",
  ) as HTMLButtonElement | null;
  const uploadInput = body.querySelector(
    "#llm-upload-input",
  ) as HTMLInputElement | null;
  const imagePreview = body.querySelector(
    "#llm-image-preview",
  ) as HTMLDivElement | null;
  const selectedContextPanel = body.querySelector(
    "#llm-selected-context",
  ) as HTMLDivElement | null;
  const selectedContextClear = body.querySelector(
    "#llm-selected-context-clear",
  ) as HTMLButtonElement | null;
  const selectedContextMeta = body.querySelector(
    "#llm-selected-context-meta",
  ) as HTMLButtonElement | null;
  const previewStrip = body.querySelector(
    "#llm-image-preview-strip",
  ) as HTMLDivElement | null;
  const previewExpanded = body.querySelector(
    "#llm-image-preview-expanded",
  ) as HTMLDivElement | null;
  const previewSelected = body.querySelector(
    "#llm-image-preview-selected",
  ) as HTMLDivElement | null;
  const previewSelectedImg = body.querySelector(
    "#llm-image-preview-selected-img",
  ) as HTMLImageElement | null;
  const previewMeta = body.querySelector(
    "#llm-image-preview-meta",
  ) as HTMLButtonElement | null;
  const removeImgBtn = body.querySelector(
    "#llm-remove-img",
  ) as HTMLButtonElement | null;
  const filePreview = body.querySelector(
    "#llm-file-context-preview",
  ) as HTMLDivElement | null;
  const filePreviewMeta = body.querySelector(
    "#llm-file-context-meta",
  ) as HTMLButtonElement | null;
  const filePreviewExpanded = body.querySelector(
    "#llm-file-context-expanded",
  ) as HTMLDivElement | null;
  const filePreviewList = body.querySelector(
    "#llm-file-context-list",
  ) as HTMLDivElement | null;
  const filePreviewClear = body.querySelector(
    "#llm-file-context-clear",
  ) as HTMLButtonElement | null;
  const responseMenu = body.querySelector(
    "#llm-response-menu",
  ) as HTMLDivElement | null;
  const responseMenuCopyBtn = body.querySelector(
    "#llm-response-menu-copy",
  ) as HTMLButtonElement | null;
  const responseMenuNoteBtn = body.querySelector(
    "#llm-response-menu-note",
  ) as HTMLButtonElement | null;
  const exportMenu = body.querySelector(
    "#llm-export-menu",
  ) as HTMLDivElement | null;
  const exportMenuCopyBtn = body.querySelector(
    "#llm-export-copy",
  ) as HTMLButtonElement | null;
  const exportMenuNoteBtn = body.querySelector(
    "#llm-export-note",
  ) as HTMLButtonElement | null;
  const status = body.querySelector("#llm-status") as HTMLElement | null;
  const chatBox = body.querySelector("#llm-chat-box") as HTMLDivElement | null;

  if (!inputBox || !sendBtn) {
    ztoolkit.log("LLM: Could not find input or send button");
    return;
  }

  const panelRoot = body.querySelector("#llm-main") as HTMLDivElement | null;
  if (!panelRoot) {
    ztoolkit.log("LLM: Could not find panel root");
    return;
  }
  const panelDoc = body.ownerDocument;
  if (!panelDoc) {
    ztoolkit.log("LLM: Could not find panel document");
    return;
  }
  const panelWin = panelDoc?.defaultView || null;
  panelRoot.tabIndex = 0;
  applyPanelFontScale(panelRoot);

  // Compute conversation key early so all closures can reference it.
  const conversationKey = item ? getConversationKey(item) : null;

  const persistCurrentChatScrollSnapshot = () => {
    if (!item || !chatBox || !chatBox.childElementCount) return;
    persistChatScrollSnapshot(item, chatBox);
  };

  if (item && chatBox) {
    const persistScroll = () => {
      if (!chatBox.childElementCount) return;
      // Skip persistence when scroll was caused by our own programmatic
      // scrollTop writes or by layout mutations (e.g. button relayout
      // changing the flex-sized chat area).
      if (isScrollUpdateSuspended()) return;
      persistChatScrollSnapshot(item, chatBox);
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

  const MODEL_MENU_OPEN_CLASS = "llm-model-menu-open";
  const REASONING_MENU_OPEN_CLASS = "llm-reasoning-menu-open";
  const setFloatingMenuOpen = (
    menu: HTMLDivElement | null,
    openClass: string,
    isOpen: boolean,
  ) => {
    if (!menu) return;
    if (isOpen) {
      menu.style.display = "grid";
      menu.classList.add(openClass);
      return;
    }
    menu.classList.remove(openClass);
    menu.style.display = "none";
  };
  const isFloatingMenuOpen = (menu: HTMLDivElement | null) =>
    Boolean(menu && menu.style.display !== "none");
  const closeResponseMenu = () => {
    if (responseMenu) responseMenu.style.display = "none";
    setResponseMenuTarget(null);
  };
  const closeExportMenu = () => {
    if (exportMenu) exportMenu.style.display = "none";
  };

  // Show floating "Quote" action when selecting assistant response text.
  const popupHost = panelRoot as HTMLDivElement & {
    __llmSelectionPopupCleanup?: () => void;
  };
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
    const anchorEl =
      selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode?.parentElement || null;
    const focusEl =
      selection.focusNode instanceof Element
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
    if (!panelWin || !chatBox) {
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
    selectedTextCache.set(item.id, selected);
    selectedTextPreviewExpandedCache.set(item.id, false);
    runWithChatScrollGuard(() => {
      applySelectedTextPreview(body, item.id);
    });
    hideSelectionPopup();
    if (status) setStatus(status, "Selected response text included", "ready");
    inputBox.focus({ preventScroll: true });
  };

  const onPanelMouseUp = (e: Event) => {
    if (!panelWin) return;
    const me = e as MouseEvent;
    if (typeof me.button === "number" && me.button !== 0) {
      selectionDragStartBubble = null;
      hideSelectionPopup();
      return;
    }
    const target = e.target as Element | null;
    const bubble = target?.closest(
      ".llm-bubble.assistant",
    ) as HTMLElement | null;
    const fallbackBubble = bubble || selectionDragStartBubble;
    selectionDragStartBubble = null;
    panelWin.setTimeout(() => updateSelectionPopup(fallbackBubble), 0);
  };
  const onDocKeyUp = () => {
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

  popupHost.__llmSelectionPopupCleanup = () => {
    panelDoc.removeEventListener("mouseup", onPanelMouseUp, true);
    panelDoc.removeEventListener("keyup", onDocKeyUp, true);
    panelRoot.removeEventListener("pointerdown", onPanelPointerDown, true);
    chatBox?.removeEventListener("scroll", onChatScrollHide);
    chatBox?.removeEventListener("contextmenu", onChatContextMenu, true);
    panelWin?.removeEventListener("resize", onChatScrollHide);
    selectionPopup.remove();
  };

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
          await createNoteFromChatHistory(currentItem, history);
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
      closeResponseMenu();
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
  };

  const clearSelectedFileState = (itemId: number) => {
    selectedFileAttachmentCache.delete(itemId);
    selectedFilePreviewExpandedCache.delete(itemId);
  };

  const clearSelectedTextState = (itemId: number) => {
    selectedTextCache.delete(itemId);
    selectedTextPreviewExpandedCache.delete(itemId);
  };
  const runWithChatScrollGuard = (fn: () => void) => {
    withScrollGuard(chatBox, conversationKey, fn);
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
    const files = selectedFileAttachmentCache.get(item.id) || [];
    if (!files.length) {
      filePreview.style.display = "none";
      filePreview.classList.remove("expanded", "collapsed");
      filePreviewExpanded.style.display = "none";
      filePreviewMeta.textContent = formatFileCountLabel(0);
      filePreviewMeta.classList.remove("expanded");
      filePreviewMeta.setAttribute("aria-expanded", "false");
      filePreviewMeta.title = "Pin files panel";
      filePreviewList.innerHTML = "";
      clearSelectedFileState(item.id);
      return;
    }
    let expanded = selectedFilePreviewExpandedCache.get(item.id);
    if (typeof expanded !== "boolean") {
      expanded = false;
      selectedFilePreviewExpandedCache.set(item.id, false);
    }
    filePreview.style.display = "flex";
    filePreview.classList.toggle("expanded", expanded);
    filePreview.classList.toggle("collapsed", !expanded);
    filePreviewExpanded.style.display = "grid";
    filePreviewMeta.textContent = formatFileCountLabel(files.length);
    filePreviewMeta.classList.toggle("expanded", expanded);
    filePreviewMeta.setAttribute("aria-expanded", expanded ? "true" : "false");
    filePreviewMeta.title = expanded ? "Unpin files panel" : "Pin files panel";
    filePreviewList.innerHTML = "";
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc) return;
    files.forEach((attachment, index) => {
      const row = createElement(ownerDoc, "div", "llm-file-context-item");
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
        if (nextFiles.length) {
          selectedFileAttachmentCache.set(item.id, nextFiles);
        } else {
          clearSelectedFileState(item.id);
        }
        if (removedEntry?.storedPath) {
          void removeAttachmentFile(removedEntry.storedPath).catch((err) => {
            ztoolkit.log(
              "LLM: Failed to remove discarded attachment file",
              err,
            );
          });
        }
        updateFilePreview();
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
        ? "Unpin figures panel"
        : "Pin figures panel";

      imagePreview.style.display = "flex";
      imagePreview.classList.toggle("expanded", expanded);
      imagePreview.classList.toggle("collapsed", !expanded);
      previewExpanded.hidden = false;
      previewExpanded.style.display = "grid";
      previewSelected.style.display = "";

      previewStrip.innerHTML = "";
      for (const [index, imageUrl] of selectedImages.entries()) {
        const thumbItem = createElement(ownerDoc, "div", "llm-preview-item");
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
      previewMeta.title = "Pin figures panel";
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
    applySelectedTextPreview(body, item.id);
  };
  const updateFilePreviewPreservingScroll = () => {
    runWithChatScrollGuard(() => {
      updateFilePreview();
    });
  };
  const updateImagePreviewPreservingScroll = () => {
    runWithChatScrollGuard(() => {
      updateImagePreview();
    });
  };
  const updateSelectedTextPreviewPreservingScroll = () => {
    runWithChatScrollGuard(() => {
      updateSelectedTextPreview();
    });
  };
  const refreshChatPreservingScroll = () => {
    runWithChatScrollGuard(() => {
      refreshChat(body, item);
    });
  };

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
    let selected = selectedModelCache.get(item.id) || "primary";
    if (!choices.some((entry) => entry.key === selected)) {
      selected = "primary";
      selectedModelCache.set(item.id, selected);
    }
    const current =
      choices.find((entry) => entry.key === selected) || choices[0];
    return {
      selected,
      choices,
      currentModel: current?.model || "default",
    };
  };

  const isScreenshotUnsupportedModel = (modelName: string): boolean => {
    const normalized = modelName.trim().toLowerCase();
    return /^deepseek-(?:chat|reasoner)(?:$|[.-])/.test(normalized);
  };

  const getScreenshotDisabledHint = (modelName: string): string => {
    const label = modelName.trim() || "current model";
    return `Screenshots are disabled for ${label}`;
  };

  const setActionButtonLabel = (
    button: HTMLButtonElement | null,
    expandedLabel: string,
    compactLabel: string,
    mode: "icon" | "full",
  ) => {
    if (!button) return;
    const nextLabel = mode === "icon" ? compactLabel : expandedLabel;
    if (button.textContent !== nextLabel) {
      button.textContent = nextLabel;
    }
    button.classList.toggle("llm-action-icon-only", mode === "icon");
  };
  const setSendButtonLabel = (mode: "icon" | "full") => {
    const nextLabel = mode === "icon" ? "↑" : "Send";
    if (sendBtn.textContent !== nextLabel) {
      sendBtn.textContent = nextLabel;
    }
    sendBtn.classList.toggle("llm-action-icon-only", mode === "icon");
    sendBtn.title = "Send";
  };

  let layoutRetryScheduled = false;
  const applyResponsiveActionButtonsLayout = () => {
    if (!modelBtn) return;
    const modelLabel = modelBtn.dataset.modelLabel || "default";
    const modelCanUseTwoLineWrap =
      [...(modelLabel || "").trim()].length >
      ACTION_LAYOUT_MODEL_WRAP_MIN_CHARS;
    const modelHint = modelBtn.dataset.modelHint || "";
    const reasoningLabel =
      reasoningBtn?.dataset.reasoningLabel ||
      reasoningBtn?.textContent ||
      "Reasoning";
    const reasoningHint = reasoningBtn?.dataset.reasoningHint || "";
    modelBtn.classList.remove("llm-model-btn-collapsed");
    modelSlot?.classList.remove("llm-model-dropdown-collapsed");
    reasoningBtn?.classList.remove("llm-reasoning-btn-collapsed");
    reasoningSlot?.classList.remove("llm-reasoning-dropdown-collapsed");
    modelBtn.textContent = modelLabel;
    modelBtn.title = modelHint;
    if (reasoningBtn) {
      reasoningBtn.textContent = reasoningLabel;
      reasoningBtn.title = reasoningHint;
    }
    if (!actionsLeft) return;
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
              // Keep enough width for the longest segment while allowing
              // balanced two-line wrapping for long model names.
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
        button === modelBtn || button === reasoningBtn ? 4 : 0;
      const measuredWidth =
        wrappedTextWidth + paddingWidth + borderWidth + chevronAllowance;
      // Use text-metric width instead of current rendered width so thresholding
      // does not become stricter just because buttons are currently expanded.
      return Math.ceil(measuredWidth);
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
    const getModeRequiredWidth = (
      dropdownMode: DropdownMode,
      contextButtonMode: ContextButtonMode,
      modelWrapMode: ModelWrapMode,
    ) => {
      const getRenderedWidthPx = (
        element: HTMLElement | null,
        fallback: number,
      ) => {
        const width = element?.getBoundingClientRect?.().width || 0;
        return width > 0 ? Math.ceil(width) : fallback;
      };
      const uploadSlot = uploadBtn?.parentElement as HTMLElement | null;
      const selectTextSlot = selectTextBtn?.parentElement as HTMLElement | null;
      const screenshotSlot = screenshotBtn?.parentElement as HTMLElement | null;
      const leftSlotWidths = [
        uploadBtn
          ? getRenderedWidthPx(
              uploadSlot || uploadBtn,
              Math.max(uploadBtn.scrollWidth || 0, 20),
            )
          : 0,
        contextButtonMode === "full"
          ? getFullSlotRequiredWidth(
              selectTextSlot,
              selectTextBtn,
              SELECT_TEXT_EXPANDED_LABEL,
            )
          : selectTextBtn
            ? getRenderedWidthPx(
                selectTextBtn,
                ACTION_LAYOUT_CONTEXT_ICON_WIDTH_PX,
              )
            : 0,
        contextButtonMode === "full"
          ? getFullSlotRequiredWidth(
              screenshotSlot,
              screenshotBtn,
              SCREENSHOT_EXPANDED_LABEL,
            )
          : screenshotBtn
            ? getRenderedWidthPx(
                screenshotBtn,
                ACTION_LAYOUT_CONTEXT_ICON_WIDTH_PX,
              )
            : 0,
        dropdownMode === "full"
          ? getFullSlotRequiredWidth(
              modelSlot,
              modelBtn,
              modelLabel,
              modelWrapMode === "wrap2"
                ? ACTION_LAYOUT_MODEL_FULL_MAX_LINES
                : 1,
            )
          : modelBtn
            ? getRenderedWidthPx(modelBtn, ACTION_LAYOUT_DROPDOWN_ICON_WIDTH_PX)
            : 0,
        dropdownMode === "full"
          ? getFullSlotRequiredWidth(
              reasoningSlot,
              reasoningBtn,
              reasoningLabel,
            )
          : reasoningBtn
            ? getRenderedWidthPx(
                reasoningBtn,
                ACTION_LAYOUT_DROPDOWN_ICON_WIDTH_PX,
              )
            : 0,
      ].filter((width) => width > 0);
      const leftGap = getElementGapPx(actionsLeft);
      const leftRequiredWidth =
        leftSlotWidths.reduce((sum, width) => sum + width, 0) +
        Math.max(0, leftSlotWidths.length - 1) * leftGap;
      const rightRequiredWidth = (() => {
        const actionsRightRendered = Math.ceil(
          actionsRight?.getBoundingClientRect?.().width || 0,
        );
        const actionsRightScroll = actionsRight?.scrollWidth || 0;
        const sendRendered = Math.ceil(
          sendBtn?.getBoundingClientRect?.().width || 0,
        );
        const sendScroll = sendBtn?.scrollWidth || 0;
        return Math.max(
          actionsRightRendered,
          actionsRightScroll,
          sendRendered,
          sendScroll,
          72,
        );
      })();
      const rowGap = getElementGapPx(actionsRow);
      return leftRequiredWidth + rightRequiredWidth + rowGap;
    };
    const getAvailableRowWidth = () => {
      const hostWidth = Math.ceil(
        (body as HTMLElement | null)?.getBoundingClientRect?.().width || 0,
      );
      const rowWidth = actionsRow?.clientWidth || 0;
      if (rowWidth > 0) return hostWidth > 0 ? Math.min(rowWidth, hostWidth) : rowWidth;
      const panelWidth = panelRoot?.clientWidth || 0;
      if (panelWidth > 0) return hostWidth > 0 ? Math.min(panelWidth, hostWidth) : panelWidth;
      const leftWidth = actionsLeft.clientWidth || 0;
      if (leftWidth > 0) return hostWidth > 0 ? Math.min(leftWidth, hostWidth) : leftWidth;
      return hostWidth;
    };
    const doesModeFit = (
      dropdownMode: DropdownMode,
      contextButtonMode: ContextButtonMode,
      modelWrapMode: ModelWrapMode,
    ) => {
      const modeRequiredWidth = getModeRequiredWidth(
        dropdownMode,
        contextButtonMode,
        modelWrapMode,
      );
      const modeBuffer =
        dropdownMode === "full" && contextButtonMode === "full"
          ? ACTION_LAYOUT_FULL_MODE_BUFFER_PX
          : dropdownMode === "full" && contextButtonMode === "icon"
            ? ACTION_LAYOUT_PARTIAL_MODE_BUFFER_PX
            : 0;
      return getAvailableRowWidth() + 1 >= modeRequiredWidth + modeBuffer;
    };

    type DropdownMode = "icon" | "full";
    type ContextButtonMode = "icon" | "full";
    type ModelWrapMode = "single" | "wrap2";
    type ActionLayoutMode = "icon" | "half" | "full";

    const setPanelActionLayoutMode = (mode: ActionLayoutMode) => {
      if (panelRoot.dataset.llmActionLayoutMode !== mode) {
        panelRoot.dataset.llmActionLayoutMode = mode;
      }
    };

    const getActionLayoutMode = (
      dropdownMode: DropdownMode,
      contextButtonMode: ContextButtonMode,
      modelWrapMode: ModelWrapMode,
    ): ActionLayoutMode => {
      if (dropdownMode === "icon" && contextButtonMode === "icon") {
        return "icon";
      }
      if (dropdownMode === "full" && contextButtonMode === "full") {
        return "full";
      }
      if (modelWrapMode === "wrap2") {
        return "half";
      }
      return "half";
    };

    const applyLayoutModes = (
      dropdownMode: DropdownMode,
      contextButtonMode: ContextButtonMode,
      modelWrapMode: ModelWrapMode,
    ) => {
      setActionButtonLabel(
        selectTextBtn,
        SELECT_TEXT_EXPANDED_LABEL,
        SELECT_TEXT_COMPACT_LABEL,
        contextButtonMode,
      );
      setActionButtonLabel(
        screenshotBtn,
        SCREENSHOT_EXPANDED_LABEL,
        SCREENSHOT_COMPACT_LABEL,
        contextButtonMode,
      );
      setActionButtonLabel(
        uploadBtn,
        UPLOAD_FILE_EXPANDED_LABEL,
        UPLOAD_FILE_COMPACT_LABEL,
        contextButtonMode,
      );
      setSendButtonLabel(
        dropdownMode === "icon" && contextButtonMode === "icon"
          ? "icon"
          : "full",
      );

      modelBtn.classList.remove("llm-model-btn-collapsed");
      modelSlot?.classList.remove("llm-model-dropdown-collapsed");
      reasoningBtn?.classList.remove("llm-reasoning-btn-collapsed");
      reasoningSlot?.classList.remove("llm-reasoning-dropdown-collapsed");
      modelBtn.classList.toggle(
        "llm-model-btn-wrap-2line",
        dropdownMode !== "icon" && modelWrapMode === "wrap2",
      );
      modelBtn.textContent = modelLabel;
      modelBtn.title = modelHint;
      if (reasoningBtn) {
        reasoningBtn.textContent = reasoningLabel;
        reasoningBtn.title = reasoningHint;
      }

      if (dropdownMode !== "icon") return;
      modelBtn.classList.add("llm-model-btn-collapsed");
      modelSlot?.classList.add("llm-model-dropdown-collapsed");
      modelBtn.textContent = "\ud83e\udde0";
      modelBtn.title = modelHint ? `${modelLabel}\n${modelHint}` : modelLabel;
      if (reasoningBtn) {
        reasoningBtn.classList.add("llm-reasoning-btn-collapsed");
        reasoningSlot?.classList.add("llm-reasoning-dropdown-collapsed");
        reasoningBtn.textContent = REASONING_COMPACT_LABEL;
        reasoningBtn.title = reasoningHint
          ? `${reasoningLabel}\n${reasoningHint}`
          : reasoningLabel;
      }
    };

    const layoutHasIssues = (
      currentDropdownMode: DropdownMode,
      currentContextButtonMode: ContextButtonMode,
      currentModelWrapMode: ModelWrapMode,
    ) =>
      !doesModeFit(
        currentDropdownMode,
        currentContextButtonMode,
        currentModelWrapMode,
      );

    const candidateModes: ReadonlyArray<
      [DropdownMode, ContextButtonMode, ModelWrapMode]
    > = modelCanUseTwoLineWrap
      ? [
          ["full", "full", "single"],
          ["full", "icon", "single"],
          ["full", "icon", "wrap2"],
          ["icon", "icon", "single"],
        ]
      : [
          ["full", "full", "single"],
          ["full", "icon", "single"],
          ["icon", "icon", "single"],
        ];
    let lastAttemptedMode:
      | [DropdownMode, ContextButtonMode, ModelWrapMode]
      | null = null;
    for (const [
      dropdownMode,
      contextButtonMode,
      modelWrapMode,
    ] of candidateModes) {
      lastAttemptedMode = [dropdownMode, contextButtonMode, modelWrapMode];
      applyLayoutModes(dropdownMode, contextButtonMode, modelWrapMode);
      if (!layoutHasIssues(dropdownMode, contextButtonMode, modelWrapMode)) {
        setPanelActionLayoutMode(
          getActionLayoutMode(dropdownMode, contextButtonMode, modelWrapMode),
        );
        return;
      }
    }
    if (lastAttemptedMode) {
      const [dropdownMode, contextButtonMode, modelWrapMode] = lastAttemptedMode;
      setPanelActionLayoutMode(
        getActionLayoutMode(dropdownMode, contextButtonMode, modelWrapMode),
      );
    }
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
      updateImagePreview();
    });
  };

  const isPrimaryPointerEvent = (e: Event): boolean => {
    const me = e as MouseEvent;
    return typeof me.button !== "number" || me.button === 0;
  };

  const rebuildModelMenu = () => {
    if (!item || !modelMenu) return;
    const { choices, selected } = getSelectedModelInfo();

    modelMenu.innerHTML = "";
    for (const entry of choices) {
      const isSelected = entry.key === selected;
      const option = createElement(
        body.ownerDocument as Document,
        "button",
        "llm-model-option",
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
        selectedModelCache.set(item.id, entry.key);
        setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, false);
        setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
        selectedReasoningCache.set(item.id, "none");
        updateModelButton();
        updateReasoningButton();
      };
      option.addEventListener("pointerdown", applyModelSelection);
      option.addEventListener("click", applyModelSelection);
      modelMenu.appendChild(option);
    }
  };

  const getReasoningLevelDisplayLabel = (
    level: LLMReasoningLevel,
    provider: ReasoningProviderKind,
    modelName: string,
    options: ReasoningOption[],
  ): string => {
    const option = options.find((entry) => entry.level === level);
    if (option?.label) {
      return option.label;
    }
    if (level !== "default") {
      return level;
    }
    // Align UI wording with provider payload semantics in llmClient.ts:
    // - DeepSeek: thinking.type = "enabled"
    // - Kimi: reasoning is model-native (no separate level payload)
    if (provider === "deepseek") {
      return "enabled";
    }
    if (provider === "kimi") {
      return "model";
    }
    // Keep "default" as final fallback when no runtime label is available.
    void modelName;
    return "default";
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
    let selectedLevel = selectedReasoningCache.get(item.id) || "none";
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
    for (const optionState of options) {
      const level = optionState.level;
      const option = createElement(
        body.ownerDocument as Document,
        "button",
        "llm-reasoning-option",
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
          selectedReasoningCache.set(item.id, level);
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
  updateFilePreviewPreservingScroll();
  updateImagePreviewPreservingScroll();
  updateSelectedTextPreviewPreservingScroll();
  syncModelFromPrefs();

  // Preferences can change outside this panel (e.g., settings window).
  // Re-sync model label when the user comes back (pointerenter).
  // NOTE: We intentionally do NOT sync on "focusin" because focusin fires
  // on every internal focus change (e.g. clicking the input box).
  // syncModelFromPrefs → updateModelButton → applyResponsiveActionButtonsLayout
  // mutates DOM → changes flex layout → resizes .llm-messages → shifts scroll
  // position.  pointerenter is sufficient and fires before interaction.
  body.addEventListener("pointerenter", () => {
    withScrollGuard(chatBox, conversationKey, syncModelFromPrefs);
  });
  const ResizeObserverCtor = body.ownerDocument?.defaultView?.ResizeObserver;
  if (ResizeObserverCtor && panelRoot && modelBtn) {
    const ro = new ResizeObserverCtor(() => {
      // Wrap layout mutations in scroll guard so that flex-driven
      // resize of .llm-messages doesn't corrupt the scroll snapshot.
      withScrollGuard(chatBox, conversationKey, () => {
        applyResponsiveActionButtonsLayout();
      });
    });
    ro.observe(panelRoot);
    if (actionsRow) ro.observe(actionsRow);
    if (actionsLeft) ro.observe(actionsLeft);
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

  const createAttachmentId = () =>
    `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const isTextLikeFile = (file: File): boolean => {
    const lowerName = (file.name || "").toLowerCase();
    const mime = (file.type || "").toLowerCase();
    if (
      mime.startsWith("text/") ||
      mime.includes("json") ||
      mime.includes("xml") ||
      mime.includes("javascript") ||
      mime.includes("typescript")
    ) {
      return true;
    }
    return /\.(md|markdown|txt|json|ya?ml|xml|html?|css|scss|less|js|jsx|ts|tsx|py|java|c|cc|cpp|h|hpp|go|rs|rb|php|swift|kt|scala|sh|bash|zsh|sql|r|m|mm|lua|toml|ini|cfg|conf)$/i.test(
      lowerName,
    );
  };

  const resolveAttachmentCategory = (
    file: File,
  ): ChatAttachment["category"] => {
    const lowerName = (file.name || "").toLowerCase();
    const mime = (file.type || "").toLowerCase();
    if (mime.startsWith("image/")) return "image";
    if (mime === "application/pdf" || lowerName.endsWith(".pdf")) return "pdf";
    if (/\.(md|markdown)$/i.test(lowerName)) return "markdown";
    if (
      /\.(js|jsx|ts|tsx|py|java|c|cc|cpp|h|hpp|go|rs|rb|php|swift|kt|scala|sh|bash|zsh|sql|r|m|mm|lua)$/i.test(
        lowerName,
      )
    ) {
      return "code";
    }
    if (isTextLikeFile(file)) return "text";
    return "file";
  };

  const readFileAsDataURL = async (file: File): Promise<string> => {
    const view = body.ownerDocument?.defaultView;
    const FileReaderCtor = view?.FileReader || globalThis.FileReader;
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReaderCtor();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
          return;
        }
        reject(new Error("Invalid data URL result"));
      };
      reader.onerror = () =>
        reject(reader.error || new Error("File read failed"));
      reader.readAsDataURL(file);
    });
  };

  const readFileAsText = async (file: File): Promise<string> => {
    const view = body.ownerDocument?.defaultView;
    const FileReaderCtor = view?.FileReader || globalThis.FileReader;
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReaderCtor();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
          return;
        }
        reject(new Error("Invalid text result"));
      };
      reader.onerror = () =>
        reject(reader.error || new Error("File read failed"));
      reader.readAsText(file);
    });
  };

  const readFileAsArrayBuffer = async (file: File): Promise<ArrayBuffer> => {
    const withArrayBuffer = file as File & {
      arrayBuffer?: () => Promise<ArrayBuffer>;
    };
    if (typeof withArrayBuffer.arrayBuffer === "function") {
      return await withArrayBuffer.arrayBuffer();
    }
    const view = body.ownerDocument?.defaultView;
    const FileReaderCtor = view?.FileReader || globalThis.FileReader;
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReaderCtor();
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(reader.result);
          return;
        }
        reject(new Error("Invalid arrayBuffer result"));
      };
      reader.onerror = () =>
        reject(reader.error || new Error("File read failed"));
      reader.readAsArrayBuffer(file);
    });
  };

  const processIncomingFiles = async (incomingFiles: File[]) => {
    if (!item || !incomingFiles.length) return;
    const conversationKey = getConversationKey(item);
    const { currentModel } = getSelectedModelInfo();
    const imageUnsupported = isScreenshotUnsupportedModel(currentModel);
    const nextImages = [...(selectedImageCache.get(item.id) || [])];
    const nextFiles = [...(selectedFileAttachmentCache.get(item.id) || [])];
    let addedCount = 0;
    let replacedCount = 0;
    let rejectedPdfCount = 0;
    let skippedImageCount = 0;
    let failedPersistCount = 0;
    for (const [index, file] of incomingFiles.entries()) {
      const fileName =
        (file.name || "").trim() || `uploaded-file-${Date.now()}-${index + 1}`;
      const lowerName = fileName.toLowerCase();
      const isPdf =
        file.type === "application/pdf" || lowerName.endsWith(".pdf");
      if (isPdf && file.size > MAX_UPLOAD_PDF_SIZE_BYTES) {
        rejectedPdfCount += 1;
        continue;
      }
      const normalizedFile = new File([file], fileName, {
        type: file.type || "application/octet-stream",
        lastModified: file.lastModified || Date.now(),
      });
      const category = resolveAttachmentCategory(normalizedFile);
      if (category === "image") {
        if (imageUnsupported || nextImages.length >= MAX_SELECTED_IMAGES) {
          skippedImageCount += 1;
          continue;
        }
        try {
          const dataUrl = await readFileAsDataURL(normalizedFile);
          nextImages.push(dataUrl);
          addedCount += 1;
        } catch (err) {
          ztoolkit.log("LLM: Failed to read image upload", err);
        }
        continue;
      }
      let textContent: string | undefined;
      if (
        category === "markdown" ||
        category === "code" ||
        category === "text"
      ) {
        try {
          textContent = await readFileAsText(normalizedFile);
        } catch (err) {
          ztoolkit.log("LLM: Failed to read text upload", err);
        }
      }
      let storedPath: string | undefined;
      try {
        const buffer = await readFileAsArrayBuffer(normalizedFile);
        storedPath = await persistConversationAttachmentFile(
          conversationKey,
          fileName,
          new Uint8Array(buffer),
        );
      } catch (err) {
        failedPersistCount += 1;
        ztoolkit.log("LLM: Failed to persist uploaded attachment", err);
        continue;
      }
      const existingIndex = nextFiles.findIndex(
        (entry) =>
          entry &&
          typeof entry.name === "string" &&
          entry.name.trim().toLowerCase() === fileName.toLowerCase(),
      );
      const nextEntry: ChatAttachment = {
        id: createAttachmentId(),
        name: fileName || "untitled",
        mimeType: normalizedFile.type || "application/octet-stream",
        sizeBytes: normalizedFile.size || 0,
        category,
        textContent,
        storedPath,
      };
      if (existingIndex >= 0) {
        const existing = nextFiles[existingIndex];
        nextFiles[existingIndex] = {
          ...nextEntry,
          id: existing.id,
        };
        replacedCount += 1;
      } else {
        nextFiles.push(nextEntry);
        addedCount += 1;
      }
    }
    if (nextImages.length) {
      selectedImageCache.set(item.id, nextImages);
    }
    if (nextFiles.length) {
      selectedFileAttachmentCache.set(item.id, nextFiles);
    }
    updateImagePreview();
    updateFilePreview();
    if (!status) return;
    if (
      (addedCount > 0 || replacedCount > 0) &&
      (rejectedPdfCount > 0 || skippedImageCount > 0 || failedPersistCount > 0)
    ) {
      const replaceText =
        replacedCount > 0 ? `, replaced ${replacedCount}` : "";
      setStatus(
        status,
        `Uploaded ${addedCount} attachment(s)${replaceText}, skipped ${rejectedPdfCount} PDF(s) > 50MB, ${skippedImageCount} image(s), ${failedPersistCount} file(s) not persisted`,
        "warning",
      );
      return;
    }
    if (addedCount > 0 || replacedCount > 0) {
      const replaceText =
        replacedCount > 0 ? `, replaced ${replacedCount}` : "";
      setStatus(
        status,
        `Uploaded ${addedCount} attachment(s)${replaceText}`,
        "ready",
      );
      return;
    }
    if (rejectedPdfCount > 0) {
      setStatus(
        status,
        `PDF exceeds 50MB limit (${rejectedPdfCount} file(s) skipped)`,
        "error",
      );
      return;
    }
    if (failedPersistCount > 0) {
      setStatus(
        status,
        `Failed to persist ${failedPersistCount} file(s) to local chat-attachments`,
        "error",
      );
    }
  };

  const isFileDragEvent = (event: DragEvent): boolean => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) return false;
    if (dataTransfer.files && dataTransfer.files.length > 0) return true;
    const types = Array.from(dataTransfer.types || []);
    return types.includes("Files");
  };

  const extractFilesFromClipboard = (event: ClipboardEvent): File[] => {
    const clipboardData = event.clipboardData;
    if (!clipboardData) return [];
    const files: File[] = [];
    if (clipboardData.files && clipboardData.files.length > 0) {
      files.push(...Array.from(clipboardData.files));
    }
    const items = Array.from(clipboardData.items || []);
    for (const item of items) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (!file) continue;
      const duplicated = files.some(
        (existing) =>
          existing.name === file.name &&
          existing.size === file.size &&
          existing.type === file.type,
      );
      if (!duplicated) files.push(file);
    }
    return files;
  };

  const setInputDropActive = (active: boolean) => {
    if (inputSection) {
      inputSection.classList.toggle("llm-input-drop-active", active);
    }
    if (inputBox) {
      inputBox.classList.toggle("llm-input-drop-active", active);
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
  }

  const buildModelPromptWithFileContext = (
    baseQuestion: string,
    fileAttachments: ChatAttachment[],
  ) => {
    if (!fileAttachments.length) return baseQuestion;
    const textBlocks: string[] = [];
    const metaBlocks: string[] = [];
    for (const attachment of fileAttachments) {
      metaBlocks.push(
        `- ${attachment.name} (${attachment.mimeType || "application/octet-stream"}, ${(attachment.sizeBytes / 1024 / 1024).toFixed(2)} MB)`,
      );
      if (attachment.textContent) {
        const clipped = attachment.textContent.slice(0, 12000);
        textBlocks.push(`### ${attachment.name}\n${clipped}`);
      }
    }
    const blocks: string[] = [baseQuestion];
    if (metaBlocks.length) {
      blocks.push(`\nAttached files:\n${metaBlocks.join("\n")}`);
    }
    if (textBlocks.length) {
      blocks.push(`\nAttached file contents:\n${textBlocks.join("\n\n")}`);
    }
    return blocks.join("\n");
  };

  const doSend = async () => {
    if (!item) return;
    const text = inputBox.value.trim();
    const selectedText = selectedTextCache.get(item.id) || "";
    const selectedFiles = selectedFileAttachmentCache.get(item.id) || [];
    if (!text && !selectedText && !selectedFiles.length) return;
    const promptText =
      text ||
      (selectedText
        ? "Please explain this selected text."
        : "Please analyze attached files.");
    const composedQuestionBase = selectedText
      ? buildQuestionWithSelectedText(selectedText, text)
      : promptText;
    const composedQuestion = buildModelPromptWithFileContext(
      composedQuestionBase,
      selectedFiles,
    );
    const displayQuestion = selectedText ? promptText : text || promptText;
    inputBox.value = "";
    const selectedProfile = getSelectedProfile();
    const activeModelName = (
      selectedProfile?.model ||
      getSelectedModelInfo().currentModel ||
      ""
    ).trim();
    const selectedImages = (selectedImageCache.get(item.id) || []).slice(
      0,
      MAX_SELECTED_IMAGES,
    );
    const images = isScreenshotUnsupportedModel(activeModelName)
      ? []
      : selectedImages;
    // Clear selected images after sending
    clearSelectedImageState(item.id);
    if (selectedFiles.length) {
      clearSelectedFileState(item.id);
      updateFilePreviewPreservingScroll();
    }
    updateImagePreviewPreservingScroll();
    if (selectedText) {
      clearSelectedTextState(item.id);
      updateSelectedTextPreviewPreservingScroll();
    }
    const selectedReasoning = getSelectedReasoning();
    const advancedParams = getAdvancedModelParams(selectedProfile?.key);
    await sendQuestion(
      body,
      item,
      composedQuestion,
      images,
      selectedProfile?.model,
      selectedProfile?.apiBase,
      selectedProfile?.apiKey,
      selectedReasoning,
      advancedParams,
      displayQuestion,
      selectedText || undefined,
      selectedFiles.length ? selectedFiles : undefined,
    );
  };

  // Send button - use addEventListener
  sendBtn.addEventListener("click", (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    doSend();
  });

  // Enter key (Shift+Enter for newline)
  inputBox.addEventListener("keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" && !ke.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      doSend();
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
      includeSelectedTextFromReader(body, item, selectedText);
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

  if (uploadBtn && uploadInput) {
    uploadBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      uploadInput.click();
    });
    uploadInput.addEventListener("change", async () => {
      if (!item) return;
      const files = Array.from(uploadInput.files || []);
      uploadInput.value = "";
      await processIncomingFiles(files);
    });
  }

  const positionFloatingMenu = (
    menu: HTMLDivElement,
    anchor: HTMLButtonElement,
  ) => {
    const win = body.ownerDocument?.defaultView;
    if (!win) return;

    const viewportMargin = 8;
    const gap = 6;

    menu.style.position = "fixed";
    menu.style.display = "grid";
    menu.style.visibility = "hidden";
    menu.style.maxHeight = `${Math.max(120, win.innerHeight - viewportMargin * 2)}px`;
    menu.style.overflowY = "auto";

    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();

    let left = anchorRect.left;
    const maxLeft = Math.max(
      viewportMargin,
      win.innerWidth - menuRect.width - viewportMargin,
    );
    left = Math.min(Math.max(viewportMargin, left), maxLeft);

    const belowTop = anchorRect.bottom + gap;
    const aboveTop = anchorRect.top - gap - menuRect.height;
    let top = belowTop;

    if (belowTop + menuRect.height > win.innerHeight - viewportMargin) {
      if (aboveTop >= viewportMargin) {
        top = aboveTop;
      } else {
        top = Math.max(
          viewportMargin,
          win.innerHeight - menuRect.height - viewportMargin,
        );
      }
    }

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.visibility = "visible";
  };

  const openModelMenu = () => {
    if (!modelMenu || !modelBtn) return;
    closeReasoningMenu();
    updateModelButton();
    rebuildModelMenu();
    if (!modelMenu.childElementCount) {
      closeModelMenu();
      return;
    }
    positionFloatingMenu(modelMenu, modelBtn);
    setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, true);
  };

  const closeModelMenu = () => {
    setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, false);
  };

  const openReasoningMenu = () => {
    if (!reasoningMenu || !reasoningBtn) return;
    closeModelMenu();
    updateReasoningButton();
    rebuildReasoningMenu();
    if (!reasoningMenu.childElementCount) {
      closeReasoningMenu();
      return;
    }
    positionFloatingMenu(reasoningMenu, reasoningBtn);
    setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, true);
  };

  const closeReasoningMenu = () => {
    setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
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
      const modelMenuEl = doc.querySelector(
        "#llm-model-menu",
      ) as HTMLDivElement | null;
      const modelButtonEl = doc.querySelector(
        "#llm-model-toggle",
      ) as HTMLButtonElement | null;
      const reasoningMenuEl = doc.querySelector(
        "#llm-reasoning-menu",
      ) as HTMLDivElement | null;
      const reasoningButtonEl = doc.querySelector(
        "#llm-reasoning-toggle",
      ) as HTMLButtonElement | null;
      const responseMenus = Array.from(
        doc.querySelectorAll("#llm-response-menu"),
      ) as HTMLDivElement[];
      const exportMenus = Array.from(
        doc.querySelectorAll("#llm-export-menu"),
      ) as HTMLDivElement[];
      const target = e.target as Node | null;
      if (
        modelMenuEl &&
        isFloatingMenuOpen(modelMenuEl) &&
        (!target ||
          (!modelMenuEl.contains(target) && !modelButtonEl?.contains(target)))
      ) {
        setFloatingMenuOpen(modelMenuEl, MODEL_MENU_OPEN_CLASS, false);
      }
      if (
        reasoningMenuEl &&
        isFloatingMenuOpen(reasoningMenuEl) &&
        (!target ||
          (!reasoningMenuEl.contains(target) &&
            !reasoningButtonEl?.contains(target)))
      ) {
        setFloatingMenuOpen(reasoningMenuEl, REASONING_MENU_OPEN_CLASS, false);
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
        selectedTextPreviewExpandedCache.set(item.id, false);
        selectedFilePreviewExpandedCache.set(item.id, false);
      }
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
        selectedTextPreviewExpandedCache.set(item.id, false);
        selectedImagePreviewExpandedCache.set(item.id, false);
      }
      updateSelectedTextPreview();
      updateImagePreview();
      updateFilePreview();
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
        void removeAttachmentFile(entry.storedPath).catch((err) => {
          ztoolkit.log("LLM: Failed to remove cleared attachment file", err);
        });
      }
      clearSelectedFileState(item.id);
      updateFilePreview();
      if (status) setStatus(status, "Files cleared", "ready");
    });
  }

  if (selectedContextClear) {
    selectedContextClear.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      clearSelectedTextState(item.id);
      updateSelectedTextPreviewPreservingScroll();
      if (status) setStatus(status, "Selected text removed", "ready");
    });
  }

  if (selectedContextMeta) {
    selectedContextMeta.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      const selectedText = selectedTextCache.get(item.id) || "";
      if (!selectedText) return;
      const expanded = selectedTextPreviewExpandedCache.get(item.id) === true;
      const nextExpanded = !expanded;
      selectedTextPreviewExpandedCache.set(item.id, nextExpanded);
      if (nextExpanded) {
        selectedImagePreviewExpandedCache.set(item.id, false);
        selectedFilePreviewExpandedCache.set(item.id, false);
      }
      updateFilePreviewPreservingScroll();
      updateImagePreviewPreservingScroll();
      updateSelectedTextPreviewPreservingScroll();
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
      selectedContextPanel && target && selectedContextPanel.contains(target),
    );
    const clickedInsideFigurePanel = Boolean(
      imagePreview && target && imagePreview.contains(target),
    );
    const clickedInsideFilePanel = Boolean(
      filePreview && target && filePreview.contains(target),
    );
    if (
      clickedInsideTextPanel ||
      clickedInsideFigurePanel ||
      clickedInsideFilePanel
    )
      return;

    const textPinned = selectedTextPreviewExpandedCache.get(item.id) === true;
    const figurePinned =
      selectedImagePreviewExpandedCache.get(item.id) === true;
    const filePinned = selectedFilePreviewExpandedCache.get(item.id) === true;
    if (!textPinned && !figurePinned && !filePinned) return;

    selectedTextPreviewExpandedCache.set(item.id, false);
    selectedImagePreviewExpandedCache.set(item.id, false);
    selectedFilePreviewExpandedCache.set(item.id, false);
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
    });
  }

  // Clear button
  if (clearBtn) {
    clearBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      closeExportMenu();
      if (item) {
        const conversationKey = getConversationKey(item);
        chatHistory.delete(conversationKey);
        loadedConversationKeys.add(conversationKey);
        void clearStoredConversation(conversationKey).catch((err) => {
          ztoolkit.log("LLM: Failed to clear persisted chat history", err);
        });
        void removeConversationAttachmentFiles(conversationKey).catch((err) => {
          ztoolkit.log("LLM: Failed to clear chat attachment files", err);
        });
        clearSelectedImageState(item.id);
        clearSelectedFileState(item.id);
        clearSelectedTextState(item.id);
        updateFilePreviewPreservingScroll();
        updateImagePreviewPreservingScroll();
        updateSelectedTextPreviewPreservingScroll();
        refreshChatPreservingScroll();
        if (status) setStatus(status, "Cleared", "ready");
      }
    });
  }
}

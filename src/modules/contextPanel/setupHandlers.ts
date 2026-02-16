import { createElement } from "../../utils/domHelpers";
import {
  MAX_UPLOAD_PDF_SIZE_BYTES,
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
  selectedImageNameCache,
  selectedImagePinnedCache,
  selectedFileAttachmentCache,
  selectedFilePinnedCache,
  selectedImagePreviewExpandedCache,
  selectedImagePreviewActiveIndexCache,
  selectedTextCache,
  selectedTextAutoSyncCache,
  selectedTextSourceCache,
  selectedTextReaderSelectionCache,
  selectedTextPanelSelectionCache,
  selectedTextReaderUpdatedAtCache,
  selectedTextPanelUpdatedAtCache,
  selectedTextSuppressedSelectionCache,
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
} from "./contextResolution";
import { captureScreenshotSelection, optimizeImageDataUrl } from "./screenshot";
import {
  createNoteFromAssistantText,
  createNoteFromChatHistory,
  buildChatHistoryNotePayload,
} from "./notes";
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
  const inputSection = body.querySelector(
    ".llm-input-section",
  ) as HTMLDivElement | null;
  const selectedContextClear = body.querySelector(
    "#llm-selected-context-clear",
  ) as HTMLButtonElement | null;
  const selectedContextLabel = body.querySelector(
    "#llm-selected-context-label",
  ) as HTMLDivElement | null;
  const selectedContextPanel = body.querySelector(
    "#llm-selected-context",
  ) as HTMLDivElement | null;
  const previewStrip = body.querySelector(
    "#llm-image-preview-strip",
  ) as HTMLDivElement | null;
  const filePreviewList = body.querySelector(
    "#llm-file-preview-list",
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
    selectedImageNameCache.delete(itemId);
    selectedImagePinnedCache.delete(itemId);
    selectedImagePreviewExpandedCache.delete(itemId);
    selectedImagePreviewActiveIndexCache.delete(itemId);
  };
  const clearSelectedAttachmentState = (itemId: number) => {
    clearSelectedImageState(itemId);
    selectedFileAttachmentCache.delete(itemId);
    selectedFilePinnedCache.delete(itemId);
  };

  const isSelectedTextAutoSyncEnabled = (itemId: number) =>
    selectedTextAutoSyncCache.get(itemId) !== false;
  const setSelectedTextAutoSyncEnabled = (itemId: number, enabled: boolean) => {
    selectedTextAutoSyncCache.set(itemId, enabled);
  };
  const updateSelectedTextSyncToggle = () => {
    if (!item) return;
    const autoSyncEnabled = isSelectedTextAutoSyncEnabled(item.id);
    if (selectTextBtn) {
      selectTextBtn.classList.toggle("llm-action-btn-active", autoSyncEnabled);
      selectTextBtn.title = autoSyncEnabled
        ? "Disable selection tracking"
        : "Enable selection tracking";
    }
  };

  const clearSelectedTextState = (itemId: number) => {
    selectedTextCache.delete(itemId);
    selectedTextPreviewExpandedCache.delete(itemId);
    selectedTextSourceCache.delete(itemId);
    selectedTextReaderSelectionCache.delete(itemId);
    selectedTextPanelSelectionCache.delete(itemId);
    selectedTextReaderUpdatedAtCache.delete(itemId);
    selectedTextPanelUpdatedAtCache.delete(itemId);
  };

  // Helper to update image preview UI
  const updateImagePreview = () => {
    if (
      !item ||
      !imagePreview ||
      !previewStrip ||
      !filePreviewList ||
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
    let selectedImageNames = selectedImageNameCache.get(item.id) || [];
    let selectedImagePinned = selectedImagePinnedCache.get(item.id) || [];
    const selectedFiles = selectedFileAttachmentCache.get(item.id) || [];
    let selectedFilesPinned = selectedFilePinnedCache.get(item.id) || [];
    if (screenshotUnsupported && selectedImages.length) {
      clearSelectedImageState(item.id);
      selectedImages = [];
      selectedImageNames = [];
    }
    if (selectedImages.length !== selectedImageNames.length) {
      selectedImageNames = selectedImages.map(
        (_entry, index) => `Screenshot ${index + 1}.png`,
      );
      selectedImageNameCache.set(item.id, selectedImageNames);
    }
    if (selectedImagePinned.length !== selectedImages.length) {
      selectedImagePinned = selectedImages.map(
        (_entry, index) => selectedImagePinned[index] === true,
      );
      selectedImagePinnedCache.set(item.id, selectedImagePinned);
    }
    if (selectedFilesPinned.length !== selectedFiles.length) {
      selectedFilesPinned = selectedFiles.map(
        (_entry, index) => selectedFilesPinned[index] === true,
      );
      selectedFilePinnedCache.set(item.id, selectedFilesPinned);
    }
    const pinnedCount =
      selectedImagePinned.filter(Boolean).length +
      selectedFilesPinned.filter(Boolean).length;
    const attachmentCount = selectedImages.length + selectedFiles.length;
    if (attachmentCount) {
      const imageCount = selectedImages.length;
      let expanded = selectedImagePreviewExpandedCache.get(item.id);
      if (typeof expanded !== "boolean") {
        expanded = true;
        selectedImagePreviewExpandedCache.set(item.id, true);
      }

      let activeIndex = selectedImagePreviewActiveIndexCache.get(item.id);
      if (typeof activeIndex !== "number" || !Number.isFinite(activeIndex)) {
        activeIndex = imageCount - 1;
      }
      activeIndex = Math.max(
        0,
        Math.min(Math.max(0, imageCount - 1), Math.floor(activeIndex)),
      );
      if (imageCount) {
        selectedImagePreviewActiveIndexCache.set(item.id, activeIndex);
      }

      previewMeta.textContent =
        pinnedCount > 0
          ? `attachments (${attachmentCount}) embedded · pinned ${pinnedCount}`
          : `attachments (${attachmentCount}) embedded`;
      previewMeta.classList.toggle("expanded", expanded);
      previewMeta.setAttribute("aria-expanded", expanded ? "true" : "false");
      previewMeta.title = expanded
        ? "Collapse attachments"
        : "Expand attachments";

      imagePreview.style.display = "flex";
      previewExpanded.hidden = !expanded;
      previewExpanded.style.display = expanded ? "flex" : "none";

      previewStrip.innerHTML = "";
      filePreviewList.innerHTML = "";
      for (const [index, fileAttachment] of selectedFiles.entries()) {
        const fileItem = createElement(ownerDoc, "div", "llm-file-preview-item");
        const fileMeta = createElement(ownerDoc, "div", "llm-file-preview-meta");
        const fileName = createElement(
          ownerDoc,
          "div",
          "llm-file-preview-name",
          { textContent: fileAttachment.name },
        );
        const fileSizeMb = (fileAttachment.sizeBytes / 1024 / 1024).toFixed(2);
        const fileInfo = createElement(
          ownerDoc,
          "div",
          "llm-file-preview-info",
          {
            textContent: `${fileAttachment.mimeType || "application/octet-stream"} · ${fileSizeMb} MB`,
          },
        );
        fileMeta.append(fileName, fileInfo);
        const pinOneBtn = createElement(
          ownerDoc,
          "button",
          "llm-file-preview-pin-one",
          {
            type: "button",
            textContent: selectedFilesPinned[index] ? "Unpin" : "Pin",
            title: selectedFilesPinned[index]
              ? `Unpin ${fileAttachment.name}`
              : `Pin ${fileAttachment.name}`,
          },
        );
        pinOneBtn.classList.toggle("pinned", selectedFilesPinned[index] === true);
        pinOneBtn.addEventListener("click", (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
          if (!item) return;
          const currentPins = selectedFilePinnedCache.get(item.id) || [];
          const nextPins = selectedFiles.map(
            (_entry, i) => (i === index ? !currentPins[i] : currentPins[i] === true),
          );
          selectedFilePinnedCache.set(item.id, nextPins);
          updateImagePreview();
        });
        const removeOneBtn = createElement(
          ownerDoc,
          "button",
          "llm-file-preview-remove-one",
          {
            type: "button",
            textContent: "×",
            title: `Remove ${fileAttachment.name}`,
          },
        );
        removeOneBtn.addEventListener("click", (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
          if (!item) return;
          const currentFiles = selectedFileAttachmentCache.get(item.id) || [];
          const currentPins = selectedFilePinnedCache.get(item.id) || [];
          const nextFiles = currentFiles.filter((_entry, i) => i !== index);
          const nextPins = currentPins.filter((_entry, i) => i !== index);
          if (nextFiles.length) {
            selectedFileAttachmentCache.set(item.id, nextFiles);
            selectedFilePinnedCache.set(item.id, nextPins);
          } else {
            selectedFileAttachmentCache.delete(item.id);
            selectedFilePinnedCache.delete(item.id);
          }
          updateImagePreview();
          if (status) {
            const nextTotal =
              (selectedImageCache.get(item.id) || []).length + nextFiles.length;
            setStatus(status, `Attachment removed (${nextTotal})`, "ready");
          }
        });
        fileItem.append(fileMeta, pinOneBtn, removeOneBtn);
        filePreviewList.appendChild(fileItem);
      }
      for (const [index, imageUrl] of selectedImages.entries()) {
        const thumbItem = createElement(ownerDoc, "div", "llm-preview-item");
        const thumbBtn = createElement(
          ownerDoc,
          "button",
          "llm-preview-thumb",
          {
            type: "button",
            title: selectedImageNames[index] || `Screenshot ${index + 1}`,
          },
        ) as HTMLButtonElement;
        thumbBtn.classList.toggle("active", index === activeIndex);
        const thumb = createElement(ownerDoc, "img", "llm-preview-img", {
          alt: selectedImageNames[index] || "Selected screenshot",
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
          updateImagePreview();
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
        const pinOneBtn = createElement(
          ownerDoc,
          "button",
          "llm-preview-pin-one",
          {
            type: "button",
            textContent: selectedImagePinned[index] ? "📌" : "📍",
            title: selectedImagePinned[index]
              ? `Unpin screenshot ${index + 1}`
              : `Pin screenshot ${index + 1}`,
          },
        );
        pinOneBtn.classList.toggle("pinned", selectedImagePinned[index] === true);
        pinOneBtn.addEventListener("click", (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
          if (!item) return;
          const currentPins = selectedImagePinnedCache.get(item.id) || [];
          const nextPins = selectedImages.map(
            (_entry, i) => (i === index ? !currentPins[i] : currentPins[i] === true),
          );
          selectedImagePinnedCache.set(item.id, nextPins);
          updateImagePreview();
        });
        removeOneBtn.addEventListener("click", (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
          if (!item) return;
          const currentImages = selectedImageCache.get(item.id) || [];
          const currentNames = selectedImageNameCache.get(item.id) || [];
          const currentPins = selectedImagePinnedCache.get(item.id) || [];
          if (index < 0 || index >= currentImages.length) return;
          const nextImages = currentImages.filter((_, i) => i !== index);
          const nextNames = currentNames.filter((_, i) => i !== index);
          const nextPins = currentPins.filter((_entry, i) => i !== index);
          if (nextImages.length) {
            selectedImageCache.set(item.id, nextImages);
            selectedImageNameCache.set(item.id, nextNames);
            selectedImagePinnedCache.set(item.id, nextPins);
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
          updateImagePreview();
          if (status) {
            const nextTotal =
              nextImages.length +
              (selectedFileAttachmentCache.get(item.id) || []).length;
            setStatus(
              status,
              `Attachment removed (${nextTotal})`,
              "ready",
            );
          }
        });
        thumbItem.append(thumbBtn, pinOneBtn, removeOneBtn);
        previewStrip.appendChild(thumbItem);
      }
      if (imageCount > 0) {
        previewSelected.style.display = expanded ? "block" : "none";
        previewSelectedImg.src = selectedImages[activeIndex];
        previewSelectedImg.alt = selectedImageNames[activeIndex]
          ? selectedImageNames[activeIndex]
          : `Selected screenshot ${activeIndex + 1}`;
      } else {
        previewSelected.style.display = "none";
        previewSelectedImg.removeAttribute("src");
        previewSelectedImg.alt = "Selected screenshot preview";
      }
      screenshotBtn.disabled = screenshotUnsupported;
      screenshotBtn.title = screenshotUnsupported
        ? screenshotDisabledHint
        : `Add screenshot (${imageCount})`;
    } else {
      imagePreview.style.display = "none";
      previewExpanded.hidden = true;
      previewExpanded.style.display = "none";
      filePreviewList.innerHTML = "";
      previewStrip.innerHTML = "";
      previewSelected.style.display = "none";
      previewSelectedImg.removeAttribute("src");
      previewSelectedImg.alt = "Selected screenshot preview";
      previewMeta.textContent = "attachments (0) embedded";
      previewMeta.classList.remove("expanded");
      previewMeta.setAttribute("aria-expanded", "false");
      previewMeta.title = "Expand attachments";
      screenshotBtn.disabled = screenshotUnsupported;
      screenshotBtn.title = screenshotUnsupported
        ? screenshotDisabledHint
        : "Select figure screenshot";
    }
    applyResponsiveActionButtonsLayout();
  };

  const updateSelectedTextPreview = () => {
    if (!item) return;
    if (selectedContextLabel) {
      const selectedText = selectedTextCache.get(item.id) || "";
      const source = selectedTextSourceCache.get(item.id);
      const sourceLabel =
        source === "reader" ? "Reader" : source === "panel" ? "Panel" : "Manual";
      selectedContextLabel.textContent = selectedText
        ? `Selected Context · ${sourceLabel}`
        : "Selected Context";
    }
    applySelectedTextPreview(body, item.id);
    updateSelectedTextSyncToggle();
  };

  const syncSelectedTextFromReader = () => {
    if (!item) return;
    if (!isSelectedTextAutoSyncEnabled(item.id)) return;
    const liveReaderSelectedText = getActiveReaderSelectionText(
      body.ownerDocument as Document,
      item,
      { allowCacheFallback: false, readerOnly: true },
    );
    const livePanelSelectedText = getActiveReaderSelectionText(
      body.ownerDocument as Document,
      item,
      { allowCacheFallback: false, panelOnly: true },
    );
    const now = Date.now();
    const prevReaderSelectedText = selectedTextReaderSelectionCache.get(item.id) || "";
    const prevPanelSelectedText = selectedTextPanelSelectionCache.get(item.id) || "";
    if (liveReaderSelectedText !== prevReaderSelectedText) {
      selectedTextReaderSelectionCache.set(item.id, liveReaderSelectedText);
      if (liveReaderSelectedText) {
        selectedTextReaderUpdatedAtCache.set(item.id, now);
      }
    }
    if (livePanelSelectedText !== prevPanelSelectedText) {
      selectedTextPanelSelectionCache.set(item.id, livePanelSelectedText);
      if (livePanelSelectedText) {
        selectedTextPanelUpdatedAtCache.set(item.id, now);
      }
    }

    const activeElement = (body.ownerDocument as Document)
      .activeElement as Element | null;
    const isFocusInsidePanel = activeElement ? body.contains(activeElement) : false;
    const readerUpdatedAt = selectedTextReaderUpdatedAtCache.get(item.id) || 0;
    const panelUpdatedAt = selectedTextPanelUpdatedAtCache.get(item.id) || 0;
    let liveSelectionSource: "reader" | "panel" | null = null;
    let liveSelectedText = "";
    if (liveReaderSelectedText && livePanelSelectedText) {
      if (readerUpdatedAt > panelUpdatedAt) {
        liveSelectionSource = "reader";
        liveSelectedText = liveReaderSelectedText;
      } else if (panelUpdatedAt > readerUpdatedAt) {
        liveSelectionSource = "panel";
        liveSelectedText = livePanelSelectedText;
      } else {
        liveSelectionSource = isFocusInsidePanel ? "panel" : "reader";
        liveSelectedText =
          liveSelectionSource === "panel"
            ? livePanelSelectedText
            : liveReaderSelectedText;
      }
    } else if (liveReaderSelectedText) {
      liveSelectionSource = "reader";
      liveSelectedText = liveReaderSelectedText;
    } else if (livePanelSelectedText) {
      liveSelectionSource = "panel";
      liveSelectedText = livePanelSelectedText;
    }

    const selectedTextSource = selectedTextSourceCache.get(item.id);
    // Keep panel selection when user is still interacting inside LLM panel
    // (e.g. clicking input). If focus moves outside (e.g. paper area), allow
    // it to clear once the live selection disappears.
    const keepPanelSelection = selectedTextSource === "panel" && isFocusInsidePanel;
    // Keep manual text until explicit clear, and keep unknown source for
    // backward compatibility with older cache entries.
    const shouldKeepWithoutLiveSelection =
      keepPanelSelection || selectedTextSource === "manual" || !selectedTextSource;
    const suppressedSelection =
      selectedTextSuppressedSelectionCache.get(item.id) || "";
    const cachedSelectedText = selectedTextCache.get(item.id) || "";
    if (liveSelectedText) {
      if (suppressedSelection && liveSelectedText === suppressedSelection) {
        return;
      }
      if (suppressedSelection && liveSelectedText !== suppressedSelection) {
        selectedTextSuppressedSelectionCache.delete(item.id);
      }
      if (
        liveSelectedText === cachedSelectedText &&
        liveSelectionSource === selectedTextSource
      )
        return;
      selectedTextCache.set(item.id, liveSelectedText);
      if (liveSelectionSource) {
        selectedTextSourceCache.set(item.id, liveSelectionSource);
      }
      selectedTextPreviewExpandedCache.set(item.id, false);
      updateSelectedTextPreview();
      return;
    }
    if (suppressedSelection) {
      selectedTextSuppressedSelectionCache.delete(item.id);
    }
    if (!cachedSelectedText) return;
    if (shouldKeepWithoutLiveSelection) return;
    clearSelectedTextState(item.id);
    updateSelectedTextPreview();
  };

  const clearAutoSelectedTextOnEscape = () => {
    if (!item) return;
    if (!isSelectedTextAutoSyncEnabled(item.id)) return;
    const currentText = (selectedTextCache.get(item.id) || "").trim();
    if (!currentText) return;
    selectedTextSuppressedSelectionCache.set(item.id, currentText);
    clearSelectedTextState(item.id);
    updateSelectedTextPreview();
    if (status) setStatus(status, "Selection cleared", "ready");
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
      const selectTextSlot = selectTextBtn?.parentElement as HTMLElement | null;
      const screenshotSlot = screenshotBtn?.parentElement as HTMLElement | null;
      const uploadSlot = uploadBtn?.parentElement as HTMLElement | null;
      const leftSlotWidths = [
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
        contextButtonMode === "full"
          ? getFullSlotRequiredWidth(
              uploadSlot,
              uploadBtn,
              UPLOAD_FILE_EXPANDED_LABEL,
            )
          : uploadBtn
            ? getRenderedWidthPx(uploadBtn, ACTION_LAYOUT_CONTEXT_ICON_WIDTH_PX)
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
      const rightRequiredWidth =
        actionsRight?.scrollWidth || sendBtn?.scrollWidth || 0;
      const rowGap = getElementGapPx(actionsRow);
      return leftRequiredWidth + rightRequiredWidth + rowGap;
    };
    const getAvailableRowWidth = () => {
      const rowWidth = actionsRow?.clientWidth || 0;
      if (rowWidth > 0) return rowWidth;
      const panelWidth = panelRoot?.clientWidth || 0;
      if (panelWidth > 0) return panelWidth;
      return actionsLeft.clientWidth || 0;
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
    for (const [
      dropdownMode,
      contextButtonMode,
      modelWrapMode,
    ] of candidateModes) {
      applyLayoutModes(dropdownMode, contextButtonMode, modelWrapMode);
      if (!layoutHasIssues(dropdownMode, contextButtonMode, modelWrapMode)) {
        return;
      }
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
      reasoningBtn.classList.toggle("llm-reasoning-btn-unavailable", !available);
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

  // Initialize image preview state
  updateImagePreview();
  updateSelectedTextPreview();
  syncSelectedTextFromReader();
  syncModelFromPrefs();

  // Keep selected-text preview synchronized with current reader selection:
  // - selection exists: auto-fill selected text
  // - selection cleared: auto-clear selected text
  // Preserve existing manual Add Text flow; this only mirrors live selection.
  const selectionSyncTickMs = 220;
  const selectionSyncTimer = setInterval(() => {
    if (!body.isConnected) {
      clearInterval(selectionSyncTimer);
      return;
    }
    syncSelectedTextFromReader();
  }, selectionSyncTickMs);

  const selectionSyncDoc = body.ownerDocument;
  selectionSyncDoc?.addEventListener(
    "pointerup",
    () => {
      if (!body.isConnected) return;
      syncSelectedTextFromReader();
    },
    true,
  );
  selectionSyncDoc?.addEventListener(
    "keyup",
    () => {
      if (!body.isConnected) return;
      syncSelectedTextFromReader();
    },
    true,
  );

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
      reader.onerror = () => reject(reader.error || new Error("File read failed"));
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
      reader.onerror = () => reject(reader.error || new Error("File read failed"));
      reader.readAsText(file);
    });
  };

  const processIncomingFiles = async (
    incomingFiles: File[],
    source: "upload" | "drop" | "paste",
  ) => {
    if (!item || !incomingFiles.length) return;
    const { currentModel } = getSelectedModelInfo();
    const imageUnsupported = isScreenshotUnsupportedModel(currentModel);

    let addedCount = 0;
    let rejectedPdfCount = 0;
    let skippedImageCount = 0;
    const nextImages = [...(selectedImageCache.get(item.id) || [])];
    const nextImageNames = [...(selectedImageNameCache.get(item.id) || [])];
    const nextImagePins = [...(selectedImagePinnedCache.get(item.id) || [])];
    const nextFiles = [...(selectedFileAttachmentCache.get(item.id) || [])];
    const nextFilePins = [...(selectedFilePinnedCache.get(item.id) || [])];

    for (const [index, file] of incomingFiles.entries()) {
      const fallbackName =
        source === "paste"
          ? `pasted-file-${Date.now()}-${index + 1}`
          : `uploaded-file-${Date.now()}-${index + 1}`;
      const fileName = (file.name || "").trim() || fallbackName;
      const lowerName = fileName.toLowerCase();
      const isPdf = file.type === "application/pdf" || lowerName.endsWith(".pdf");
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
        if (imageUnsupported) {
          skippedImageCount += 1;
          continue;
        }
        try {
          const dataUrl = await readFileAsDataURL(normalizedFile);
          nextImages.push(dataUrl);
          nextImageNames.push(fileName || `Image ${nextImages.length}.png`);
          nextImagePins.push(false);
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
      nextFiles.push({
        id: createAttachmentId(),
        name: fileName || "untitled",
        mimeType: normalizedFile.type || "application/octet-stream",
        sizeBytes: normalizedFile.size || 0,
        category,
        textContent,
      });
      nextFilePins.push(false);
      addedCount += 1;
    }

    if (nextImages.length) {
      selectedImageCache.set(item.id, nextImages);
      selectedImageNameCache.set(item.id, nextImageNames);
      selectedImagePinnedCache.set(item.id, nextImagePins);
      selectedImagePreviewExpandedCache.set(item.id, true);
      if (typeof selectedImagePreviewActiveIndexCache.get(item.id) !== "number") {
        selectedImagePreviewActiveIndexCache.set(item.id, nextImages.length - 1);
      }
    }
    if (nextFiles.length) {
      selectedFileAttachmentCache.set(item.id, nextFiles);
      selectedFilePinnedCache.set(item.id, nextFilePins);
    }
    updateImagePreview();

    if (status) {
      const sourceLabel =
        source === "drop" ? "Dropped" : source === "paste" ? "Pasted" : "Uploaded";
      if (addedCount > 0 && (rejectedPdfCount > 0 || skippedImageCount > 0)) {
        setStatus(
          status,
          `${sourceLabel} ${addedCount} attachment(s), skipped ${rejectedPdfCount} PDF(s) > 50MB and ${skippedImageCount} image(s)`,
          "warning",
        );
      } else if (addedCount > 0) {
        setStatus(status, `${sourceLabel} ${addedCount} attachment(s)`, "ready");
      } else if (skippedImageCount > 0) {
        setStatus(
          status,
          `${skippedImageCount} image(s) skipped: ${getScreenshotDisabledHint(currentModel)}`,
          "warning",
        );
      } else if (rejectedPdfCount > 0) {
        setStatus(
          status,
          `PDF exceeds 50MB limit (${rejectedPdfCount} file(s) skipped)`,
          "error",
        );
      }
    }
  };

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
    if (isSelectedTextAutoSyncEnabled(item.id)) {
      syncSelectedTextFromReader();
    }
    const text = inputBox.value.trim();
    const selectedText = selectedTextCache.get(item.id) || "";
    const selectedImages = selectedImageCache.get(item.id) || [];
    const selectedImageNames = selectedImageNameCache.get(item.id) || [];
    const selectedImagePinned = selectedImagePinnedCache.get(item.id) || [];
    const selectedFiles = selectedFileAttachmentCache.get(item.id) || [];
    const selectedFilesPinned = selectedFilePinnedCache.get(item.id) || [];
    if (!text && !selectedText && !selectedImages.length && !selectedFiles.length)
      return;
    const promptText =
      text ||
      (selectedText
        ? "Please explain this selected text."
        : "Please analyze the attached files.");
    const composedBaseQuestion = selectedText
      ? buildQuestionWithSelectedText(selectedText, text)
      : text;
    const composedQuestion = buildModelPromptWithFileContext(
      composedBaseQuestion || promptText,
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
    const images = isScreenshotUnsupportedModel(activeModelName)
      ? []
      : selectedImages;
    const imageAttachments: ChatAttachment[] = images.map((imageDataUrl, index) => ({
      id: createAttachmentId(),
      name:
        selectedImageNames[index] ||
        `Screenshot ${index + 1}.png`,
      mimeType: "image/png",
      sizeBytes: 0,
      category: "image",
      imageDataUrl,
    }));
    const attachments: ChatAttachment[] = [...imageAttachments, ...selectedFiles];
    const keptImages = selectedImages.filter(
      (_entry, index) => selectedImagePinned[index] === true,
    );
    const keptImageNames = selectedImageNames.filter(
      (_entry, index) => selectedImagePinned[index] === true,
    );
    const keptImagePins = keptImages.map(() => true);
    const keptFiles = selectedFiles.filter(
      (_entry, index) => selectedFilesPinned[index] === true,
    );
    const keptFilePins = keptFiles.map(() => true);
    if (keptImages.length || keptFiles.length) {
      if (keptImages.length) {
        selectedImageCache.set(item.id, keptImages);
        selectedImageNameCache.set(item.id, keptImageNames);
        selectedImagePinnedCache.set(item.id, keptImagePins);
      } else {
        selectedImageCache.delete(item.id);
        selectedImageNameCache.delete(item.id);
        selectedImagePinnedCache.delete(item.id);
      }
      if (keptFiles.length) {
        selectedFileAttachmentCache.set(item.id, keptFiles);
        selectedFilePinnedCache.set(item.id, keptFilePins);
      } else {
        selectedFileAttachmentCache.delete(item.id);
        selectedFilePinnedCache.delete(item.id);
      }
      updateImagePreview();
      if (status) {
        setStatus(
          status,
          `Sending with ${keptImages.length + keptFiles.length} pinned attachment(s)...`,
          "sending",
        );
      }
    } else {
      clearSelectedAttachmentState(item.id);
      updateImagePreview();
    }
    if (selectedText) {
      clearSelectedTextState(item.id);
      updateSelectedTextPreview();
    }
    const selectedReasoning = getSelectedReasoning();
    const advancedParams = getAdvancedModelParams(selectedProfile?.key);
    await sendQuestion(
      body,
      item,
      composedQuestion,
      images,
      attachments,
      selectedProfile?.model,
      selectedProfile?.apiBase,
      selectedProfile?.apiKey,
      selectedReasoning,
      advancedParams,
      displayQuestion,
      selectedText || undefined,
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
  inputBox.addEventListener("keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key !== "Escape") return;
    clearAutoSelectedTextOnEscape();
  });

  let inputDragDepth = 0;
  const setInputDragActive = (active: boolean) => {
    inputSection?.classList.toggle("llm-file-drag-active", active);
  };
  const hasFileDragData = (event: DragEvent): boolean => {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    return Array.from(types).includes("Files");
  };

  inputBox.addEventListener("dragenter", (e: Event) => {
    const de = e as DragEvent;
    if (!hasFileDragData(de)) return;
    de.preventDefault();
    de.stopPropagation();
    inputDragDepth += 1;
    setInputDragActive(true);
  });
  inputBox.addEventListener("dragover", (e: Event) => {
    const de = e as DragEvent;
    if (!hasFileDragData(de)) return;
    de.preventDefault();
    de.stopPropagation();
    if (de.dataTransfer) de.dataTransfer.dropEffect = "copy";
    setInputDragActive(true);
  });
  inputBox.addEventListener("dragleave", (e: Event) => {
    const de = e as DragEvent;
    if (!hasFileDragData(de)) return;
    de.preventDefault();
    de.stopPropagation();
    inputDragDepth = Math.max(0, inputDragDepth - 1);
    if (inputDragDepth === 0) setInputDragActive(false);
  });
  inputBox.addEventListener("drop", async (e: Event) => {
    const de = e as DragEvent;
    if (!hasFileDragData(de)) return;
    de.preventDefault();
    de.stopPropagation();
    inputDragDepth = 0;
    setInputDragActive(false);
    const files = Array.from(de.dataTransfer?.files || []);
    if (!files.length) return;
    await processIncomingFiles(files, "drop");
  });
  inputBox.addEventListener("paste", async (e: Event) => {
    const pe = e as ClipboardEvent;
    const clipboard = pe.clipboardData;
    if (!clipboard) return;
    const fileItems = Array.from(clipboard.items || []).filter(
      (entry) => entry.kind === "file",
    );
    if (!fileItems.length) return;
    const files = fileItems
      .map((entry) => entry.getAsFile())
      .filter((entry): entry is File => Boolean(entry));
    if (!files.length) return;
    pe.preventDefault();
    pe.stopPropagation();
    await processIncomingFiles(files, "paste");
  });

  const panelDoc = body.ownerDocument;
  panelDoc?.addEventListener(
    "keydown",
    (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== "Escape") return;
      clearAutoSelectedTextOnEscape();
    },
    true,
  );
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
    selectTextBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      const nextEnabled = !isSelectedTextAutoSyncEnabled(item.id);
      setSelectedTextAutoSyncEnabled(item.id, nextEnabled);
      if (nextEnabled) {
        syncSelectedTextFromReader();
      }
      updateSelectedTextPreview();
      if (status) {
        setStatus(
          status,
          nextEnabled
            ? "Selection tracking enabled"
            : "Selection tracking disabled",
          "ready",
        );
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
        updateImagePreview();
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
          const existingNames = selectedImageNameCache.get(item.id) || [];
          const existingPins = selectedImagePinnedCache.get(item.id) || [];
          const nextImages = [...existingImages, optimized];
          const nextNames = [...existingNames, `Screenshot ${nextImages.length}.png`];
          const nextPins = [...existingPins, false];
          selectedImageCache.set(item.id, nextImages);
          selectedImageNameCache.set(item.id, nextNames);
          selectedImagePinnedCache.set(item.id, nextPins);
          selectedImagePreviewExpandedCache.set(item.id, true);
          selectedImagePreviewActiveIndexCache.set(
            item.id,
            nextImages.length - 1,
          );
          updateImagePreview();
          if (status) {
            setStatus(
              status,
              `Screenshot captured (${nextImages.length})`,
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
      if (!files.length) return;
      await processIncomingFiles(files, "upload");
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
      const responseMenuEl = doc.querySelector(
        "#llm-response-menu",
      ) as HTMLDivElement | null;
      const exportMenuEl = doc.querySelector(
        "#llm-export-menu",
      ) as HTMLDivElement | null;
      const exportButtonEl = doc.querySelector(
        "#llm-export",
      ) as HTMLButtonElement | null;
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
      if (
        responseMenuEl &&
        responseMenuEl.style.display !== "none" &&
        me.button === 0 &&
        (!target || !responseMenuEl.contains(target))
      ) {
        responseMenuEl.style.display = "none";
        setResponseMenuTarget(null);
      }
      if (
        exportMenuEl &&
        exportMenuEl.style.display !== "none" &&
        me.button === 0 &&
        (!target ||
          (!exportMenuEl.contains(target) && !exportButtonEl?.contains(target)))
      ) {
        exportMenuEl.style.display = "none";
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
      const selectedFiles = selectedFileAttachmentCache.get(item.id) || [];
      if (!selectedImages.length && !selectedFiles.length) return;
      const expanded = selectedImagePreviewExpandedCache.get(item.id) === true;
      selectedImagePreviewExpandedCache.set(item.id, !expanded);
      updateImagePreview();
    });
  }

  if (removeImgBtn) {
    removeImgBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      clearSelectedAttachmentState(item.id);
      updateImagePreview();
      if (status) setStatus(status, "Attachments cleared", "ready");
    });
  }

  if (selectedContextClear) {
    selectedContextClear.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      const liveSelectedText = getActiveReaderSelectionText(
        body.ownerDocument as Document,
        item,
        { allowCacheFallback: false },
      ).trim();
      if (liveSelectedText) {
        selectedTextSuppressedSelectionCache.set(item.id, liveSelectedText);
      } else {
        selectedTextSuppressedSelectionCache.delete(item.id);
      }
      clearSelectedTextState(item.id);
      updateSelectedTextPreview();
      if (status) {
        setStatus(status, "Selected text cleared", "ready");
      }
    });
  }

  if (selectedContextPanel) {
    selectedContextPanel.tabIndex = 0;
    selectedContextPanel.setAttribute("role", "button");
    const toggleSelectedContextExpanded = () => {
      if (!item) return;
      const selectedText = selectedTextCache.get(item.id) || "";
      if (!selectedText) return;
      const expanded = selectedTextPreviewExpandedCache.get(item.id) === true;
      selectedTextPreviewExpandedCache.set(item.id, !expanded);
      updateSelectedTextPreview();
    };
    selectedContextPanel.addEventListener("click", (e: Event) => {
      const target = e.target as Node | null;
      if (
        selectedContextClear &&
        target &&
        selectedContextClear.contains(target)
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      toggleSelectedContextExpanded();
    });
    selectedContextPanel.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const target = e.target as Node | null;
      if (
        selectedContextClear &&
        target &&
        selectedContextClear.contains(target)
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      toggleSelectedContextExpanded();
    });
  }

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
        clearSelectedImageState(item.id);
        clearSelectedTextState(item.id);
        updateImagePreview();
        updateSelectedTextPreview();
        refreshChat(body, item);
        if (status) setStatus(status, "Cleared", "ready");
      }
    });
  }
}

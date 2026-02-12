import { createElement } from "../../utils/domHelpers";
import {
  MAX_SELECTED_IMAGES,
  FONT_SCALE_MIN_PERCENT,
  FONT_SCALE_MAX_PERCENT,
  FONT_SCALE_STEP_PERCENT,
  FONT_SCALE_DEFAULT_PERCENT,
  SELECT_TEXT_EXPANDED_LABEL,
  SELECT_TEXT_COMPACT_LABEL,
  SCREENSHOT_EXPANDED_LABEL,
  SCREENSHOT_COMPACT_LABEL,
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
  selectedTextCache,
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
import { clearConversation as clearStoredConversation } from "../../utils/chatStore";
import type {
  ReasoningLevelSelection,
  ReasoningOption,
  ReasoningProviderKind,
  AdvancedModelParams,
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
  const imagePreview = body.querySelector(
    "#llm-image-preview",
  ) as HTMLDivElement | null;
  const selectedContextClear = body.querySelector(
    "#llm-selected-context-clear",
  ) as HTMLButtonElement | null;
  const previewStrip = body.querySelector(
    "#llm-image-preview-strip",
  ) as HTMLDivElement | null;
  const previewMeta = body.querySelector(
    "#llm-image-preview-meta",
  ) as HTMLDivElement | null;
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
      panelRoot.focus();
    }
  });

  // Helper to update image preview UI
  const updateImagePreview = () => {
    if (
      !item ||
      !imagePreview ||
      !previewStrip ||
      !previewMeta ||
      !screenshotBtn
    )
      return;
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc) return;
    const selectedImages = selectedImageCache.get(item.id) || [];
    if (selectedImages.length) {
      previewStrip.innerHTML = "";
      for (const [index, imageUrl] of selectedImages.entries()) {
        const thumbItem = createElement(ownerDoc, "div", "llm-preview-item");
        const thumb = createElement(ownerDoc, "img", "llm-preview-img", {
          alt: "Selected screenshot",
        }) as HTMLImageElement;
        thumb.src = imageUrl;
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
          } else {
            selectedImageCache.delete(item.id);
          }
          updateImagePreview();
          if (status) {
            setStatus(
              status,
              `Screenshot removed (${nextImages.length}/${MAX_SELECTED_IMAGES})`,
              "ready",
            );
          }
        });
        thumbItem.append(thumb, removeOneBtn);
        previewStrip.appendChild(thumbItem);
      }
      previewMeta.textContent = `${selectedImages.length}/${MAX_SELECTED_IMAGES} screenshot${selectedImages.length > 1 ? "s" : ""}`;
      imagePreview.style.display = "flex";
      screenshotBtn.disabled = selectedImages.length >= MAX_SELECTED_IMAGES;
      screenshotBtn.title =
        selectedImages.length >= MAX_SELECTED_IMAGES
          ? `Max ${MAX_SELECTED_IMAGES} screenshots`
          : `Add screenshot (${selectedImages.length}/${MAX_SELECTED_IMAGES})`;
    } else {
      imagePreview.style.display = "none";
      previewStrip.innerHTML = "";
      previewMeta.textContent = "0 images selected";
      screenshotBtn.disabled = false;
      screenshotBtn.title = "Select figure screenshot";
    }
    applyResponsiveActionButtonsLayout();
  };

  const updateSelectedTextPreview = () => {
    if (!item) return;
    applySelectedTextPreview(body, item.id);
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
    const { choices, currentModel } = getSelectedModelInfo();
    const hasSecondary = choices.length > 1;
    modelBtn.dataset.modelLabel = `${currentModel || "default"}`;
    modelBtn.dataset.modelHint = hasSecondary
      ? "Click to choose a model"
      : "Only one model is configured";
    modelBtn.disabled = !item;
    applyResponsiveActionButtonsLayout();
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
  syncModelFromPrefs();

  // Preferences can change outside this panel (e.g., settings window).
  // Re-sync model label when the user comes back and interacts.
  body.addEventListener("pointerenter", syncModelFromPrefs);
  body.addEventListener("focusin", syncModelFromPrefs);
  const ResizeObserverCtor = body.ownerDocument?.defaultView?.ResizeObserver;
  if (ResizeObserverCtor && panelRoot && modelBtn) {
    const ro = new ResizeObserverCtor(() => {
      applyResponsiveActionButtonsLayout();
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

  const doSend = async () => {
    if (!item) return;
    const text = inputBox.value.trim();
    const selectedText = selectedTextCache.get(item.id) || "";
    if (!text && !selectedText) return;
    const composedQuestion = selectedText
      ? buildQuestionWithSelectedText(selectedText, text)
      : text;
    const displayQuestion = selectedText
      ? `[Selected text included]\n${text || "Please explain this selected text."}`
      : text;
    inputBox.value = "";
    const images = (selectedImageCache.get(item.id) || []).slice(
      0,
      MAX_SELECTED_IMAGES,
    );
    // Clear selected images after sending
    selectedImageCache.delete(item.id);
    updateImagePreview();
    if (selectedText) {
      selectedTextCache.delete(item.id);
      updateSelectedTextPreview();
    }
    const selectedProfile = getSelectedProfile();
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

  const panelDoc = body.ownerDocument;
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

      const status = body.querySelector("#llm-status") as HTMLElement | null;
      const currentImages = selectedImageCache.get(item.id) || [];
      if (currentImages.length >= MAX_SELECTED_IMAGES) {
        if (status) {
          setStatus(
            status,
            `Maximum ${MAX_SELECTED_IMAGES} screenshots allowed`,
            "error",
          );
        }
        updateImagePreview();
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
          updateImagePreview();
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
  if (removeImgBtn) {
    removeImgBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      selectedImageCache.delete(item.id);
      updateImagePreview();
      const status = body.querySelector("#llm-status") as HTMLElement | null;
      if (status) setStatus(status, "Screenshots cleared", "ready");
    });
  }

  if (selectedContextClear) {
    selectedContextClear.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      selectedTextCache.delete(item.id);
      updateSelectedTextPreview();
      if (status) setStatus(status, "Selected text removed", "ready");
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
      const status = body.querySelector("#llm-status") as HTMLElement | null;
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
        selectedImageCache.delete(item.id);
        selectedTextCache.delete(item.id);
        updateImagePreview();
        updateSelectedTextPreview();
        refreshChat(body, item);
        const status = body.querySelector("#llm-status") as HTMLElement | null;
        if (status) setStatus(status, "Cleared", "ready");
      }
    });
  }
}

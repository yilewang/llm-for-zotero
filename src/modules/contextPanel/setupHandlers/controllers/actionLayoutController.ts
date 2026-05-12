import {
  ACTION_LAYOUT_CONTEXT_ICON_WIDTH_PX,
  ACTION_LAYOUT_DROPDOWN_ICON_WIDTH_PX,
  ACTION_LAYOUT_MODEL_FULL_MAX_LINES,
  ACTION_LAYOUT_MODEL_WRAP_MIN_CHARS,
  getScreenshotExpandedLabel,
  getSelectTextExpandedLabel,
  REASONING_COMPACT_LABEL,
  SCREENSHOT_COMPACT_LABEL,
  SELECT_TEXT_COMPACT_LABEL,
  UPLOAD_FILE_COMPACT_LABEL,
  UPLOAD_FILE_EXPANDED_LABEL,
} from "../../constants";

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

type ActionLayoutControllerDeps = {
  body: Element;
  panelRoot: HTMLDivElement;
  actionsRow: HTMLDivElement | null;
  actionsLeft: HTMLDivElement | null;
  modelBtn: HTMLButtonElement | null;
  modelSlot: HTMLDivElement | null;
  reasoningBtn: HTMLButtonElement | null;
  reasoningSlot: HTMLDivElement | null;
  uploadBtn: HTMLButtonElement | null;
  selectTextBtn: HTMLButtonElement | null;
  screenshotBtn: HTMLButtonElement | null;
  sendBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement | null;
};

export function createActionLayoutController(
  deps: ActionLayoutControllerDeps,
): {
  setActionButtonLabel: (
    button: HTMLButtonElement | null,
    expandedLabel: string,
    compactLabel: string,
    mode: ActionLabelMode,
  ) => void;
  setSendButtonLabel: (mode: ActionLabelMode) => void;
  applyResponsiveActionButtonsLayout: () => void;
} {
  const {
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
  } = deps;

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
          getSelectTextExpandedLabel(),
          state.selectText,
        ),
        getContextButtonWidth(
          screenshotSlot,
          screenshotBtn,
          getScreenshotExpandedLabel(),
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
      setActionButtonLabel(
        uploadBtn,
        UPLOAD_FILE_EXPANDED_LABEL,
        UPLOAD_FILE_COMPACT_LABEL,
        "icon",
      );
      setActionButtonLabel(
        selectTextBtn,
        getSelectTextExpandedLabel(),
        SELECT_TEXT_COMPACT_LABEL,
        "full",
      );
      setActionButtonLabel(
        screenshotBtn,
        getScreenshotExpandedLabel(),
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
        getSelectTextExpandedLabel(),
        SELECT_TEXT_COMPACT_LABEL,
        state.selectText,
      );
      setActionButtonLabel(
        screenshotBtn,
        getScreenshotExpandedLabel(),
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

  return {
    setActionButtonLabel,
    setSendButtonLabel,
    applyResponsiveActionButtonsLayout,
  };
}

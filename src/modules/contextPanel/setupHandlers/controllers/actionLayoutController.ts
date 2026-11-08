import {
  ACTION_LAYOUT_CONTEXT_ICON_WIDTH_PX,
  ACTION_LAYOUT_DROPDOWN_ICON_WIDTH_PX,
  REASONING_COMPACT_LABEL,
  SCREENSHOT_COMPACT_LABEL,
  SELECT_TEXT_COMPACT_LABEL,
  UPLOAD_FILE_COMPACT_LABEL,
  UPLOAD_FILE_EXPANDED_LABEL,
} from "../../constants";

type ActionLabelMode = "icon" | "full";
type ModelLabelMode = "icon" | "full-single";
type ActionLayoutMode = "icon" | "half" | "full";
/** Extra width a wider action-row state needs before it replaces a narrower one. */
const ACTION_LAYOUT_GROW_MARGIN_PX = 4;

type ActionRevealState = {
  send: ActionLabelMode;
  reasoning: ActionLabelMode;
  model: ModelLabelMode;
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

  // Send and Cancel are always round icon buttons (arrow / stop square);
  // the name lives in title + aria-label, so every width mode is the same.
  const setSendButtonLabel = (_mode: ActionLabelMode) => {
    setActionButtonLabel(sendBtn, "", "", "icon");
    sendBtn.title = "Send";
    setActionButtonLabel(cancelBtn, "", "", "icon");
    if (cancelBtn) {
      cancelBtn.title = "Cancel";
    }
  };

  const setPanelActionLayoutMode = (mode: ActionLayoutMode) => {
    if (panelRoot.dataset.llmActionLayoutMode !== mode) {
      panelRoot.dataset.llmActionLayoutMode = mode;
    }
  };

  const textMeasureContext = (() => {
    const canvas = body.ownerDocument?.createElement(
      "canvas",
    ) as HTMLCanvasElement | null;
    return (
      (canvas?.getContext("2d") as CanvasRenderingContext2D | null) || null
    );
  })();

  // The last applied layout: what it was computed from and what it wrote.
  // updateImagePreview and every layout flush call this; most calls change
  // nothing, and the full pass writes then measures up to five states.
  let lastLayout: {
    inputs: string;
    modelText: string | null;
    reasoningText: string | null;
    mode: string | undefined;
  } | null = null;
  // The state the last pass applied, as "send/reasoning/model".
  let appliedStateKey: string | null = null;

  const applyResponsiveActionButtonsLayout = () => {
    if (
      !body.isConnected ||
      !panelRoot.isConnected ||
      !modelBtn ||
      !actionsLeft
    )
      return;
    const modelLabel = modelBtn.dataset.modelLabel || "default";
    const modelHint = modelBtn.dataset.modelHint || "";
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
    // Retained native tabs can stay hidden indefinitely. Their ResizeObserver
    // requests layout when they become measurable again; do not poll frames.
    if (immediateAvailableWidth <= 0) return;

    const layoutInputs = [
      modelLabel,
      modelHint,
      reasoningLabel,
      reasoningHint,
      immediateAvailableWidth,
      panelRoot.clientWidth || 0,
      Math.ceil(
        (body as HTMLElement | null)?.getBoundingClientRect?.().width || 0,
      ),
      Math.ceil(
        (uploadBtn?.parentElement || uploadBtn)?.getBoundingClientRect?.()
          .width || 0,
      ),
      // Font changes (Zotero font size, the panel's font scale) change the
      // measured label widths without changing the row width.
      body.ownerDocument?.defaultView?.getComputedStyle(modelBtn)?.font || "",
    ].join("\u0001");
    if (
      lastLayout &&
      lastLayout.inputs === layoutInputs &&
      lastLayout.modelText === modelBtn.textContent &&
      lastLayout.reasoningText === (reasoningBtn?.textContent ?? null) &&
      lastLayout.mode === panelRoot.dataset.llmActionLayoutMode
    ) {
      return;
    }
    const rememberLayout = () => {
      lastLayout = {
        inputs: layoutInputs,
        modelText: modelBtn.textContent,
        reasoningText: reasoningBtn?.textContent ?? null,
        mode: panelRoot.dataset.llmActionLayoutMode,
      };
    };

    const getComputedSizePx = (
      style: CSSStyleDeclaration | null | undefined,
      property: string,
      fallback = 0,
    ) => {
      if (!style) return fallback;
      const value = Number.parseFloat(style.getPropertyValue(property));
      return Number.isFinite(value) ? value : fallback;
    };

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
    ) => {
      if (!button) return 0;
      const view = body.ownerDocument?.defaultView;
      const style = view?.getComputedStyle(button);
      const borderWidth =
        getComputedSizePx(style, "border-left-width") +
        getComputedSizePx(style, "border-right-width");
      // The measurement baseline shows the full label, so its laid-out width
      // is exact; canvas text runs about 10% wide for the system-ui font.
      // scrollWidth drops the fraction, so add a pixel.
      if (button.textContent === label && button.scrollWidth > 0) {
        return Math.ceil(button.scrollWidth + borderWidth) + 1;
      }
      const textWidth = measureLabelTextWidth(button, label);
      const paddingWidth =
        getComputedSizePx(style, "padding-left") +
        getComputedSizePx(style, "padding-right");
      return Math.ceil(textWidth + paddingWidth + borderWidth);
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
    ) => {
      if (!button) return 0;
      const naturalWidth = getButtonNaturalWidth(button, label);
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

    const getModelWidth = (mode: ModelLabelMode) => {
      if (!modelBtn) return 0;
      if (mode === "icon") return ACTION_LAYOUT_DROPDOWN_ICON_WIDTH_PX;
      return getFullSlotRequiredWidth(modelSlot, modelBtn, modelLabel);
    };

    const getReasoningWidth = (mode: ActionLabelMode) => {
      if (!reasoningBtn) return 0;
      return mode === "full"
        ? getFullSlotRequiredWidth(reasoningSlot, reasoningBtn, reasoningLabel)
        : ACTION_LAYOUT_DROPDOWN_ICON_WIDTH_PX;
    };

    const getSendWidth = (_mode: ActionLabelMode) =>
      sendBtn
        ? getRenderedWidthPx(
            sendBtn.parentElement as HTMLElement | null,
            ACTION_LAYOUT_CONTEXT_ICON_WIDTH_PX,
          )
        : 0;

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
        selectTextBtn ? ACTION_LAYOUT_CONTEXT_ICON_WIDTH_PX : 0,
        screenshotBtn ? ACTION_LAYOUT_CONTEXT_ICON_WIDTH_PX : 0,
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

    const getPanelLayoutMode = (state: ActionRevealState): ActionLayoutMode => {
      if (
        state.send === "full" &&
        state.model !== "icon" &&
        state.reasoning === "full"
      ) {
        return "full";
      }
      if (
        state.send === "full" &&
        (state.model !== "icon" || state.reasoning === "full")
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
        SELECT_TEXT_COMPACT_LABEL,
        SELECT_TEXT_COMPACT_LABEL,
        "icon",
      );
      setActionButtonLabel(
        screenshotBtn,
        SCREENSHOT_COMPACT_LABEL,
        SCREENSHOT_COMPACT_LABEL,
        "icon",
      );
      setSendButtonLabel("full");

      modelBtn.classList.toggle("llm-model-btn-collapsed", false);
      modelSlot?.classList.toggle("llm-model-dropdown-collapsed", false);
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

    const applyState = (
      state: ActionRevealState,
      layoutMode: ActionLayoutMode,
    ) => {
      setActionButtonLabel(
        uploadBtn,
        UPLOAD_FILE_EXPANDED_LABEL,
        UPLOAD_FILE_COMPACT_LABEL,
        "icon",
      );
      setActionButtonLabel(
        selectTextBtn,
        SELECT_TEXT_COMPACT_LABEL,
        SELECT_TEXT_COMPACT_LABEL,
        "icon",
      );
      setActionButtonLabel(
        screenshotBtn,
        SCREENSHOT_COMPACT_LABEL,
        SCREENSHOT_COMPACT_LABEL,
        "icon",
      );
      setSendButtonLabel(state.send);

      const modelCollapsed = state.model === "icon";
      modelBtn.classList.toggle("llm-model-btn-collapsed", modelCollapsed);
      modelSlot?.classList.toggle(
        "llm-model-dropdown-collapsed",
        modelCollapsed,
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

      setPanelActionLayoutMode(layoutMode);
    };

    const fullState: ActionRevealState = {
      send: "full",
      reasoning: "full",
      model: "full-single",
    };
    // Only sizes the context cards ("half" mode); the buttons never show
    // effort text beside a model icon.
    const reasoningState: ActionRevealState = {
      send: "full",
      reasoning: "full",
      model: "icon",
    };
    const sendState: ActionRevealState = {
      send: "full",
      reasoning: "icon",
      model: "icon",
    };
    const iconOnlyState: ActionRevealState = {
      send: "icon",
      reasoning: "icon",
      model: "icon",
    };

    // Model name and effort show as text together on one line, or both
    // show as icons.
    const candidateStates: ActionRevealState[] = [
      fullState,
      sendState,
      iconOnlyState,
    ];

    const stateKey = (state: ActionRevealState) =>
      `${state.send}/${state.reasoning}/${state.model}`;
    const appliedIndex = candidateStates.findIndex(
      (state) => stateKey(state) === appliedStateKey,
    );
    const applyChosenState = (state: ActionRevealState) => {
      const layoutMode =
        state.model === "icon" &&
        getAvailableRowWidth() + 1 >= getRequiredWidth(reasoningState)
          ? "half"
          : getPanelLayoutMode(state);
      applyState(state, layoutMode);
      appliedStateKey = stateKey(state);
      rememberLayout();
    };

    applyMeasurementBaseline();
    for (const [index, state] of candidateStates.entries()) {
      // A wider state than the applied one must fit with room to spare.
      // Switching states can move the row's width by a pixel; with no margin
      // the two states took turns on every frame, and each switch made the
      // whole panel lay out and measure again.
      const margin =
        appliedIndex >= 0 && index < appliedIndex
          ? ACTION_LAYOUT_GROW_MARGIN_PX
          : 0;
      if (getAvailableRowWidth() + 1 < getRequiredWidth(state) + margin)
        continue;
      applyChosenState(state);
      return;
    }

    applyChosenState(iconOnlyState);
  };

  return {
    setActionButtonLabel,
    setSendButtonLabel,
    applyResponsiveActionButtonsLayout,
  };
}

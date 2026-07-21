import { applyManualTextareaHeight } from "./textareaSizing";

export const STANDALONE_CONTEXT_FIT_MARGIN_PX = 24;

type StandaloneContextFitMetrics = {
  targetBottom: number;
  innerHeight: number;
  outerHeight: number;
  screenY?: number | null;
  screenAvailTop?: number | null;
  screenAvailHeight?: number | null;
};

type StandaloneContextFitOptions = {
  marginPx?: number;
  shouldRun?: () => boolean;
};

export type StandaloneManualVerticalResizeParams = {
  kind: "chat" | "input";
  startScreenY: number;
  currentScreenY: number;
  startWindowHeight: number;
  startElementHeight: number;
  minWindowHeight: number;
  minElementHeight: number;
  maxElementHeight?: number;
};

export type StandaloneManualVerticalResizeFrame = {
  windowHeight: number;
  elementHeight: number;
};

type StandaloneManualResizeOptions = {
  minWindowHeight?: number;
};

type StandaloneWindowLike = {
  innerHeight?: number;
  innerWidth?: number;
  outerHeight?: number;
  outerWidth?: number;
  screenY?: number;
  screenTop?: number;
  screen?: {
    availHeight?: number;
    availTop?: number;
    top?: number;
  };
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  setTimeout?: (callback: () => void, delay?: number) => number;
  resizeTo?: (width: number, height: number) => void;
};

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ceilPositive(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? Math.ceil(parsed) : null;
}

function finiteNonNegative(value: unknown, fallback: number): number {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : fallback;
}

function parseCssPixels(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Keep the resized standalone surface attached to the window's lower edge.
 * The same effective height delta is applied to the element and outer window,
 * so growing the composer never steals space from the chat above it.
 */
export function computeStandaloneManualVerticalResize(
  params: StandaloneManualVerticalResizeParams,
): StandaloneManualVerticalResizeFrame {
  const startScreenY = finiteNumber(params.startScreenY) ?? 0;
  const currentScreenY = finiteNumber(params.currentScreenY) ?? startScreenY;
  const startWindowHeight = finiteNonNegative(params.startWindowHeight, 0);
  const startElementHeight = finiteNonNegative(params.startElementHeight, 0);
  const minWindowHeight = finiteNonNegative(params.minWindowHeight, 0);
  const minElementHeight = finiteNonNegative(params.minElementHeight, 0);
  const maxElementHeight =
    params.kind === "input"
      ? Math.max(
          minElementHeight,
          finiteNonNegative(params.maxElementHeight, Number.POSITIVE_INFINITY),
        )
      : Number.POSITIVE_INFINITY;
  const pointerDelta = currentScreenY - startScreenY;
  const requestedElementHeight = Math.min(
    maxElementHeight,
    Math.max(minElementHeight, startElementHeight + pointerDelta),
  );
  const elementDelta = requestedElementHeight - startElementHeight;
  const windowDelta = Math.max(
    elementDelta,
    minWindowHeight - startWindowHeight,
  );
  const elementHeight = Math.min(
    maxElementHeight,
    Math.max(minElementHeight, startElementHeight + windowDelta),
  );
  const appliedDelta = elementHeight - startElementHeight;

  return {
    windowHeight: Math.max(minWindowHeight, startWindowHeight + appliedDelta),
    elementHeight,
  };
}

/**
 * Replace the two native standalone resize operations with a window-aware
 * drag. Sidebar panels retain their native CSS resizing behavior.
 */
export function installStandaloneVerticalResizeBehavior(
  win: Window,
  root: HTMLElement,
  options: StandaloneManualResizeOptions = {},
): () => void {
  type ActiveDrag = {
    kind: "chat" | "input";
    handle: HTMLElement;
    element: HTMLElement;
    startScreenY: number;
    startWindowHeight: number;
    startWindowWidth: number;
    startElementHeight: number;
    minElementHeight: number;
    maxElementHeight?: number;
    lastWindowHeight: number;
    lastElementHeight: number;
  };

  let activeDrag: ActiveDrag | null = null;
  const minWindowHeight = finiteNonNegative(options.minWindowHeight, 500);

  const endDrag = () => {
    const drag = activeDrag;
    activeDrag = null;
    root.classList.remove("llm-standalone-resizing");
    try {
      (drag?.handle as any)?.releaseCapture?.();
    } catch {
      // Gecko can throw if capture was already released by window teardown.
    }
  };

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    const eventElement = event.target as HTMLElement | null;
    const handle = eventElement?.closest?.(
      ".llm-standalone-resize-handle",
    ) as HTMLElement | null;
    if (!handle || !root.contains(handle)) return;
    const kind = handle.dataset.resizeTarget;
    if (kind !== "chat" && kind !== "input") return;

    const element =
      kind === "chat"
        ? handle.parentElement
        : (handle.parentElement?.querySelector(
            ".llm-input",
          ) as HTMLElement | null);
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const startWindowHeight = finiteNonNegative(
      win.outerHeight || win.innerHeight,
      0,
    );
    const startWindowWidth = finiteNonNegative(
      win.outerWidth || win.innerWidth,
      0,
    );
    if (!startWindowHeight || !startWindowWidth || !rect.height) return;

    const computed = win.getComputedStyle(element);
    const minElementHeight = parseCssPixels(computed?.minHeight) ?? 0;
    const maxElementHeight =
      kind === "input"
        ? (parseCssPixels(computed?.maxHeight) ?? Number.POSITIVE_INFINITY)
        : undefined;
    activeDrag = {
      kind,
      handle,
      element,
      startScreenY: event.screenY,
      startWindowHeight,
      startWindowWidth,
      startElementHeight: rect.height,
      minElementHeight,
      maxElementHeight,
      lastWindowHeight: startWindowHeight,
      lastElementHeight: rect.height,
    };
    root.classList.add("llm-standalone-resizing");
    try {
      (handle as any).setCapture?.(true);
    } catch {
      // Window-level listeners still keep the drag active without capture.
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onMouseMove = (event: MouseEvent) => {
    const drag = activeDrag;
    if (!drag) return;
    const frame = computeStandaloneManualVerticalResize({
      kind: drag.kind,
      startScreenY: drag.startScreenY,
      currentScreenY: event.screenY,
      startWindowHeight: drag.startWindowHeight,
      startElementHeight: drag.startElementHeight,
      minWindowHeight,
      minElementHeight: drag.minElementHeight,
      maxElementHeight: drag.maxElementHeight,
    });

    if (
      drag.kind === "input" &&
      frame.elementHeight !== drag.lastElementHeight
    ) {
      applyManualTextareaHeight(
        drag.element as HTMLTextAreaElement,
        frame.elementHeight,
      );
      drag.lastElementHeight = frame.elementHeight;
    }
    if (frame.windowHeight !== drag.lastWindowHeight) {
      win.resizeTo(drag.startWindowWidth, frame.windowHeight);
      drag.lastWindowHeight = frame.windowHeight;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  root.addEventListener("mousedown", onMouseDown, true);
  win.addEventListener("mousemove", onMouseMove, true);
  win.addEventListener("mouseup", endDrag, true);
  win.addEventListener("blur", endDrag);

  return () => {
    endDrag();
    root.removeEventListener("mousedown", onMouseDown, true);
    win.removeEventListener("mousemove", onMouseMove, true);
    win.removeEventListener("mouseup", endDrag, true);
    win.removeEventListener("blur", endDrag);
  };
}

export function computeStandaloneContextFitHeight(
  metrics: StandaloneContextFitMetrics,
  options: StandaloneContextFitOptions = {},
): number | null {
  const targetBottom = finiteNumber(metrics.targetBottom);
  const innerHeight = ceilPositive(metrics.innerHeight);
  const outerHeight = ceilPositive(metrics.outerHeight);
  if (targetBottom === null || !innerHeight || !outerHeight) return null;

  const marginPx = Math.max(
    0,
    finiteNumber(options.marginPx) ?? STANDALONE_CONTEXT_FIT_MARGIN_PX,
  );
  const overflow = Math.ceil(targetBottom + marginPx - innerHeight);
  if (overflow <= 0) return null;

  let nextHeight = outerHeight + overflow;
  const screenAvailHeight = ceilPositive(metrics.screenAvailHeight);
  if (screenAvailHeight) {
    const screenAvailTop = finiteNumber(metrics.screenAvailTop) ?? 0;
    const screenY = finiteNumber(metrics.screenY) ?? screenAvailTop;
    const maxOuterHeight = Math.floor(
      screenAvailTop + screenAvailHeight - screenY,
    );
    if (maxOuterHeight <= outerHeight) return null;
    if (maxOuterHeight > 0) {
      nextHeight = Math.min(nextHeight, maxOuterHeight);
    }
  }

  return nextHeight > outerHeight ? nextHeight : null;
}

export function resizeStandaloneWindowToFitElement(
  win: StandaloneWindowLike,
  element: { getBoundingClientRect?: () => { bottom?: number } },
  options: StandaloneContextFitOptions = {},
): boolean {
  if (!win?.resizeTo || !element?.getBoundingClientRect) return false;
  const rect = element.getBoundingClientRect();
  const nextHeight = computeStandaloneContextFitHeight(
    {
      targetBottom: Number(rect?.bottom || 0),
      innerHeight: Number(win.innerHeight || 0),
      outerHeight: Number(win.outerHeight || 0),
      screenY: win.screenY ?? win.screenTop,
      screenAvailTop: win.screen?.availTop ?? win.screen?.top,
      screenAvailHeight: win.screen?.availHeight,
    },
    options,
  );
  if (!nextHeight) return false;
  const width = ceilPositive(win.outerWidth) || ceilPositive(win.innerWidth);
  if (!width) return false;
  win.resizeTo(width, nextHeight);
  return true;
}

export function scheduleStandaloneWindowFitForElement(
  win: StandaloneWindowLike | null | undefined,
  element: { getBoundingClientRect?: () => { bottom?: number } } | null,
  options: StandaloneContextFitOptions = {},
): void {
  if (!win || !element) return;
  const run = () => {
    if (options.shouldRun && !options.shouldRun()) return;
    resizeStandaloneWindowToFitElement(win, element, options);
  };
  if (win.requestAnimationFrame) {
    win.requestAnimationFrame(() => run());
    return;
  }
  if (win.setTimeout) {
    win.setTimeout(run, 0);
    return;
  }
  setTimeout(run, 0);
}

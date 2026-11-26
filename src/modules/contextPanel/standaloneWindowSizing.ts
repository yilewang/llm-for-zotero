export const STANDALONE_CONTEXT_FIT_MARGIN_PX = 24;
export const STANDALONE_SIDEBAR_DEFAULT_WIDTH_PX = 220;
export const STANDALONE_SIDEBAR_MIN_WIDTH_PX = 160;
export const STANDALONE_SIDEBAR_MAX_WIDTH_PX = 420;
export const STANDALONE_SIDEBAR_MIN_CONTENT_WIDTH_PX = 360;
export const STANDALONE_SIDEBAR_SEPARATOR_LAYOUT_WIDTH_PX = 5;
/** The window's right-hand side panel (History / Side chat). */
export const STANDALONE_SIDE_PANEL_DEFAULT_WIDTH_PX = 420;
export const STANDALONE_SIDE_PANEL_MIN_WIDTH_PX = 320;
export const STANDALONE_SIDE_PANEL_MAX_WIDTH_PX = 1000;

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

export type StandaloneSidebarWidthParams = {
  requestedWidth: number;
  containerWidth: number;
  minWidth?: number;
  maxWidth?: number;
  minContentWidth?: number;
  separatorWidth?: number;
};

export type StandaloneSidebarWidthLayout = {
  renderedWidth: number;
  effectiveMaxWidth: number;
};

type StandaloneSidebarResizeOptions = {
  /**
   * Which edge of the window the column sits on. A right-hand column grows
   * when its divider moves left, and ArrowLeft grows it. Default "left".
   */
  side?: "left" | "right";
  /** CSS variable set on the container (default: the History pane's). */
  widthVariable?: string;
  /** Class on the container while dragging (default: the History pane's). */
  resizingClass?: string;
  /** Width a double-click restores (default: the History pane's). */
  defaultWidth?: number;
  /** Width other columns take from the container, read on every layout. */
  getReservedWidth?: () => number;
  initialWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  minContentWidth?: number;
  separatorWidth?: number;
  keyboardStep?: number;
  onWidthCommit?: (width: number) => void;
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

export function clampStandaloneSidebarPreferredWidth(
  value: number,
  minWidth = STANDALONE_SIDEBAR_MIN_WIDTH_PX,
  maxWidth = STANDALONE_SIDEBAR_MAX_WIDTH_PX,
): number {
  const safeMin = Math.max(0, finiteNonNegative(minWidth, 0));
  const safeMax = Math.max(safeMin, finiteNonNegative(maxWidth, safeMin));
  const requested = finiteNumber(value) ?? STANDALONE_SIDEBAR_DEFAULT_WIDTH_PX;
  return Math.round(Math.max(safeMin, Math.min(requested, safeMax)));
}

export function computeStandaloneSidebarWidthLayout(
  params: StandaloneSidebarWidthParams,
): StandaloneSidebarWidthLayout {
  const minWidth = finiteNonNegative(
    params.minWidth,
    STANDALONE_SIDEBAR_MIN_WIDTH_PX,
  );
  const maxWidth = Math.max(
    minWidth,
    finiteNonNegative(params.maxWidth, STANDALONE_SIDEBAR_MAX_WIDTH_PX),
  );
  const preferredWidth = clampStandaloneSidebarPreferredWidth(
    params.requestedWidth,
    minWidth,
    maxWidth,
  );
  const containerWidth = finiteNonNegative(params.containerWidth, 0);
  if (!containerWidth) {
    return { renderedWidth: preferredWidth, effectiveMaxWidth: maxWidth };
  }

  const minContentWidth = finiteNonNegative(
    params.minContentWidth,
    STANDALONE_SIDEBAR_MIN_CONTENT_WIDTH_PX,
  );
  const separatorWidth = finiteNonNegative(
    params.separatorWidth,
    STANDALONE_SIDEBAR_SEPARATOR_LAYOUT_WIDTH_PX,
  );
  const availableWidth = Math.floor(
    containerWidth - separatorWidth - minContentWidth,
  );
  const effectiveMax = Math.max(minWidth, Math.min(maxWidth, availableWidth));
  return {
    renderedWidth: Math.round(Math.min(preferredWidth, effectiveMax)),
    effectiveMaxWidth: Math.round(effectiveMax),
  };
}

export type StandaloneColumnResizeBehavior = {
  dispose: () => void;
  /** Re-apply the preferred width (another column opened, closed or moved). */
  relayout: () => void;
  /** The width the user asked for, before any clamping to the window. */
  getPreferredWidth: () => number;
};

/**
 * A resizable column of the standalone window: the History pane on the left
 * or the side panel on the right. Same clamping for both: the column keeps
 * its minimum, and otherwise leaves the main content its minimum width after
 * the other columns (getReservedWidth) take theirs.
 */
export function installStandaloneColumnResizeBehavior(
  win: Window,
  container: HTMLElement,
  sidebarPanel: HTMLElement,
  separator: HTMLElement,
  options: StandaloneSidebarResizeOptions = {},
): StandaloneColumnResizeBehavior {
  const direction = options.side === "right" ? -1 : 1;
  const widthVariable =
    options.widthVariable || "--llm-standalone-sidebar-panel-width";
  const resizingClass =
    options.resizingClass || "llm-standalone-sidebar-resizing";
  const defaultWidth = finiteNonNegative(
    options.defaultWidth,
    STANDALONE_SIDEBAR_DEFAULT_WIDTH_PX,
  );
  const minWidth = finiteNonNegative(
    options.minWidth,
    STANDALONE_SIDEBAR_MIN_WIDTH_PX,
  );
  const maxWidth = Math.max(
    minWidth,
    finiteNonNegative(options.maxWidth, STANDALONE_SIDEBAR_MAX_WIDTH_PX),
  );
  const keyboardStep = Math.max(1, finiteNonNegative(options.keyboardStep, 12));
  let preferredWidth = clampStandaloneSidebarPreferredWidth(
    options.initialWidth ?? defaultWidth,
    minWidth,
    maxWidth,
  );
  let renderedWidth = preferredWidth;
  let effectiveMaxWidth = maxWidth;
  let activeDrag: {
    startScreenX: number;
    startWidth: number;
    moved: boolean;
  } | null = null;
  let pendingDragScreenX: number | null = null;
  let dragFrameId: number | null = null;

  const measureLayout = (requestedWidth: number) => {
    // Negative: room the window is about to gain (a pending resize).
    const reservedWidth = finiteNumber(options.getReservedWidth?.()) ?? 0;
    const containerWidth = Math.max(
      0,
      (container.clientWidth || 0) - reservedWidth,
    );
    return computeStandaloneSidebarWidthLayout({
      requestedWidth,
      containerWidth,
      minWidth,
      maxWidth,
      minContentWidth: options.minContentWidth,
      separatorWidth: options.separatorWidth,
    });
  };

  const applyLayout = (layout: StandaloneSidebarWidthLayout) => {
    renderedWidth = layout.renderedWidth;
    effectiveMaxWidth = layout.effectiveMaxWidth;
    // The layout sidebar and its floating panel inherit the same saved width.
    container.style.setProperty(widthVariable, `${renderedWidth}px`);
    separator.setAttribute("aria-valuemin", `${Math.round(minWidth)}`);
    separator.setAttribute("aria-valuemax", `${effectiveMaxWidth}`);
    separator.setAttribute("aria-valuenow", `${renderedWidth}`);
  };

  const renderPreferredWidth = () => {
    applyLayout(measureLayout(preferredWidth));
  };

  const setUserPreferredWidth = (width: number, commit: boolean) => {
    const requestedWidth = clampStandaloneSidebarPreferredWidth(
      width,
      minWidth,
      maxWidth,
    );
    const layout = measureLayout(requestedWidth);
    preferredWidth = requestedWidth;
    applyLayout(layout);
    if (commit) options.onWidthCommit?.(preferredWidth);
  };

  const cancelScheduledDragFrame = () => {
    if (dragFrameId === null) return;
    if (typeof win.cancelAnimationFrame === "function") {
      win.cancelAnimationFrame(dragFrameId);
    }
    dragFrameId = null;
  };

  const flushPendingDragFrame = () => {
    if (!activeDrag || pendingDragScreenX === null) return;
    const screenX = pendingDragScreenX;
    pendingDragScreenX = null;
    const requestedWidth =
      activeDrag.startWidth + direction * (screenX - activeDrag.startScreenX);
    setUserPreferredWidth(requestedWidth, false);
  };

  const schedulePendingDragFrame = () => {
    if (dragFrameId !== null) return;
    if (typeof win.requestAnimationFrame !== "function") {
      flushPendingDragFrame();
      return;
    }
    dragFrameId = win.requestAnimationFrame(() => {
      dragFrameId = null;
      flushPendingDragFrame();
    });
  };

  const endDrag = (event?: Event) => {
    if (activeDrag) {
      const finalScreenX = finiteNumber(
        (event as MouseEvent | undefined)?.screenX,
      );
      if (finalScreenX !== null) {
        pendingDragScreenX = finalScreenX;
        if (finalScreenX !== activeDrag.startScreenX) activeDrag.moved = true;
      }
    }
    cancelScheduledDragFrame();
    flushPendingDragFrame();
    const drag = activeDrag;
    activeDrag = null;
    pendingDragScreenX = null;
    container.classList.remove(resizingClass);
    try {
      (separator as any).releaseCapture?.();
    } catch {
      // Gecko can throw if capture was released during window teardown.
    }
    if (drag?.moved) options.onWidthCommit?.(preferredWidth);
  };

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    cancelScheduledDragFrame();
    pendingDragScreenX = null;
    const rect = sidebarPanel.getBoundingClientRect();
    activeDrag = {
      startScreenX: event.screenX,
      startWidth: rect.width || renderedWidth,
      moved: false,
    };
    container.classList.add(resizingClass);
    try {
      (separator as any).setCapture?.(true);
    } catch {
      // Window-level listeners keep the drag active without capture.
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onMouseMove = (event: MouseEvent) => {
    if (!activeDrag) return;
    pendingDragScreenX = event.screenX;
    activeDrag.moved = true;
    schedulePendingDragFrame();
    event.preventDefault();
    event.stopPropagation();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? keyboardStep * 4 : keyboardStep;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = renderedWidth - direction * step;
    if (event.key === "ArrowRight")
      nextWidth = renderedWidth + direction * step;
    if (event.key === "Home") nextWidth = minWidth;
    if (event.key === "End") nextWidth = effectiveMaxWidth;
    if (nextWidth === null) return;
    setUserPreferredWidth(nextWidth, true);
    event.preventDefault();
    event.stopPropagation();
  };

  const onDoubleClick = (event: MouseEvent) => {
    setUserPreferredWidth(defaultWidth, true);
    event.preventDefault();
    event.stopPropagation();
  };

  const onWindowResize = () => renderPreferredWidth();

  renderPreferredWidth();
  separator.addEventListener("mousedown", onMouseDown);
  separator.addEventListener("keydown", onKeyDown);
  separator.addEventListener("dblclick", onDoubleClick);
  win.addEventListener("mousemove", onMouseMove, true);
  win.addEventListener("mouseup", endDrag, true);
  win.addEventListener("blur", endDrag);
  win.addEventListener("resize", onWindowResize);

  const dispose = () => {
    endDrag();
    cancelScheduledDragFrame();
    separator.removeEventListener("mousedown", onMouseDown);
    separator.removeEventListener("keydown", onKeyDown);
    separator.removeEventListener("dblclick", onDoubleClick);
    win.removeEventListener("mousemove", onMouseMove, true);
    win.removeEventListener("mouseup", endDrag, true);
    win.removeEventListener("blur", endDrag);
    win.removeEventListener("resize", onWindowResize);
  };
  return {
    dispose,
    relayout: renderPreferredWidth,
    getPreferredWidth: () => preferredWidth,
  };
}

/**
 * The side panel opens and closes like the History pane: zoteroPane.css
 * gives that pane `transition: width 280ms cubic-bezier(0.16, 1, 0.3, 1)`.
 */
export const STANDALONE_PANEL_SLIDE_DURATION_MS = 280;
export const STANDALONE_PANEL_SLIDE_EASING = Object.freeze([
  0.16, 1, 0.3, 1,
] as const);

/** CSS cubic-bezier(x1, y1, x2, y2) as a function of time (0..1). */
export function createCubicBezierEasing(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (time: number) => number {
  const at = (a: number, b: number, t: number) =>
    3 * a * t * (1 - t) * (1 - t) + 3 * b * t * t * (1 - t) + t * t * t;
  const slope = (a: number, b: number, t: number) =>
    3 * a * (1 - t) * (1 - t) + 6 * (b - a) * t * (1 - t) + 3 * (1 - b) * t * t;
  return (time: number) => {
    if (!(time > 0)) return 0;
    if (time >= 1) return 1;
    // Solve x(t) = time: Newton steps, then bisection if they stall.
    let t = time;
    for (let step = 0; step < 8; step++) {
      const error = at(x1, x2, t) - time;
      if (Math.abs(error) < 1e-6) return at(y1, y2, t);
      const d = slope(x1, x2, t);
      if (Math.abs(d) < 1e-6) break;
      t = Math.min(1, Math.max(0, t - error / d));
    }
    let low = 0;
    let high = 1;
    t = time;
    for (let step = 0; step < 40; step++) {
      const x = at(x1, x2, t);
      if (Math.abs(x - time) < 1e-6) break;
      if (x < time) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return at(y1, y2, t);
  };
}

/**
 * One frame of the side panel's open or close: the window's outer width
 * (whole pixels) and the main column's width, both eased the same way.
 */
export function computeStandaloneSidePanelSlideFrame(params: {
  fromOuterWidth: number;
  toOuterWidth: number;
  fromMainWidth: number;
  toMainWidth: number;
  /** Elapsed time over the duration; 1 or more is the end. */
  progress: number;
  ease: (time: number) => number;
}): { outerWidth: number; mainWidth: number; done: boolean } {
  const done = !(params.progress < 1);
  const eased = done ? 1 : params.ease(Math.max(0, params.progress));
  const lerp = (from: number, to: number) => from + (to - from) * eased;
  return {
    outerWidth: Math.round(lerp(params.fromOuterWidth, params.toOuterWidth)),
    mainWidth: lerp(params.fromMainWidth, params.toMainWidth),
    done,
  };
}

export type StandaloneWindowWidthChangeParams = {
  outerWidth: number;
  screenX: number;
  /** Width to add (positive) or give back (negative). */
  delta: number;
  availLeft?: number | null;
  availWidth?: number | null;
  minWidth?: number;
};

export type StandaloneWindowWidthChangeFrame = {
  width: number;
  /** The width change the screen allows (may be less than asked). */
  applied: number;
};

/**
 * Grow or shrink the window by `delta` from its right edge; its left edge
 * never moves. Growth stops at the screen's right edge; the caller squeezes
 * whatever does not fit.
 */
export function computeStandaloneWindowWidthChange(
  params: StandaloneWindowWidthChangeParams,
): StandaloneWindowWidthChangeFrame {
  const outerWidth = Math.round(finiteNonNegative(params.outerWidth, 0));
  const screenX = Math.round(finiteNumber(params.screenX) ?? 0);
  const minWidth = Math.round(finiteNonNegative(params.minWidth, 1));
  const delta = Math.round(finiteNumber(params.delta) ?? 0);
  let width = Math.max(minWidth, outerWidth + delta);
  const availWidth = ceilPositive(params.availWidth);
  if (delta > 0 && availWidth) {
    const availLeft = Math.round(finiteNumber(params.availLeft) ?? 0);
    const roomRight = availLeft + availWidth - screenX;
    width = Math.max(outerWidth, Math.min(width, roomRight));
  }
  return { width, applied: width - outerWidth };
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

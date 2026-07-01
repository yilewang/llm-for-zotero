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
  const run = () => resizeStandaloneWindowToFitElement(win, element, options);
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

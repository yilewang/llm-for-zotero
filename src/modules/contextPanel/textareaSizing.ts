const DEFAULT_MIN_HEIGHT = 60;
const DEFAULT_MAX_HEIGHT = 220;
const DEFAULT_FONT_SIZE = 12;
const DEFAULT_LINE_HEIGHT_MULTIPLIER = 1.2;
const MULTILINE_SPARE_LINES = 1;
const HEIGHT_EPSILON = 0.5;

export type AdaptiveTextareaHeightParams = {
  scrollHeight: number;
  minHeight: number;
  maxHeight: number;
  lineHeight: number;
  borderHeight?: number;
  spareLines?: number;
};

export type AdaptiveTextareaHeight = {
  height: number;
  overflowY: "auto" | "hidden";
};

function finiteNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Resolve a textarea height from its rendered content rather than character
 * count, so explicit newlines and width-dependent wrapping behave identically.
 */
export function calculateAdaptiveTextareaHeight(
  params: AdaptiveTextareaHeightParams,
): AdaptiveTextareaHeight {
  const minHeight = finiteNonNegative(params.minHeight, DEFAULT_MIN_HEIGHT);
  const maxHeight = Math.max(
    minHeight,
    finiteNonNegative(params.maxHeight, DEFAULT_MAX_HEIGHT),
  );
  const lineHeight = finiteNonNegative(
    params.lineHeight,
    DEFAULT_FONT_SIZE * DEFAULT_LINE_HEIGHT_MULTIPLIER,
  );
  const borderHeight = finiteNonNegative(params.borderHeight ?? 0, 0);
  const spareLines = finiteNonNegative(
    params.spareLines ?? MULTILINE_SPARE_LINES,
    MULTILINE_SPARE_LINES,
  );
  const naturalHeight =
    finiteNonNegative(params.scrollHeight, minHeight) + borderHeight;
  const isMultiline = naturalHeight > minHeight + HEIGHT_EPSILON;
  const desiredHeight =
    naturalHeight + (isMultiline ? lineHeight * spareLines : 0);

  return {
    height: Math.min(maxHeight, Math.max(minHeight, desiredHeight)),
    // Do not show a scrollbar merely because the spare line was clipped.
    overflowY: naturalHeight > maxHeight + HEIGHT_EPSILON ? "auto" : "hidden",
  };
}

function parseCssPixels(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function formatCssPixels(value: number): string {
  return `${Math.round(value * 100) / 100}px`;
}

/**
 * Grow or shrink the shared composer textarea to its rendered wrapped content.
 * Multiline content receives one spare visible line and only scrolls after the
 * CSS max-height is reached.
 */
export function resizeTextareaToContent(
  textarea: HTMLTextAreaElement,
): AdaptiveTextareaHeight {
  textarea.style.height = "auto";

  let computed: CSSStyleDeclaration | null = null;
  try {
    computed =
      textarea.ownerDocument?.defaultView?.getComputedStyle(textarea) ?? null;
  } catch {
    // Detached/fake DOMs can lack a working getComputedStyle implementation.
  }

  const fontSize = parseCssPixels(computed?.fontSize) ?? DEFAULT_FONT_SIZE;
  const lineHeight =
    parseCssPixels(computed?.lineHeight) ??
    fontSize * DEFAULT_LINE_HEIGHT_MULTIPLIER;
  const minHeight = parseCssPixels(computed?.minHeight) ?? DEFAULT_MIN_HEIGHT;
  const maxHeight = parseCssPixels(computed?.maxHeight) ?? DEFAULT_MAX_HEIGHT;
  const borderHeight =
    computed?.boxSizing === "border-box"
      ? (parseCssPixels(computed.borderTopWidth) ?? 0) +
        (parseCssPixels(computed.borderBottomWidth) ?? 0)
      : 0;
  const result = calculateAdaptiveTextareaHeight({
    scrollHeight: textarea.scrollHeight,
    minHeight,
    maxHeight,
    lineHeight,
    borderHeight,
  });

  textarea.style.height = formatCssPixels(result.height);
  textarea.style.overflowY = result.overflowY;
  return result;
}

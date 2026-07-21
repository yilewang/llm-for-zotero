const DEFAULT_MIN_HEIGHT = 60;
const DEFAULT_MAX_HEIGHT = 220;
const HEIGHT_EPSILON = 0.5;
const MANUAL_HEIGHT_DATASET_KEY = "llmManualHeight";

export type AdaptiveTextareaHeightParams = {
  scrollHeight: number;
  minHeight: number;
  maxHeight: number;
  borderHeight?: number;
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
  const borderHeight = finiteNonNegative(params.borderHeight ?? 0, 0);
  const naturalHeight =
    finiteNonNegative(params.scrollHeight, minHeight) + borderHeight;

  return {
    height: Math.min(maxHeight, Math.max(minHeight, naturalHeight)),
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

export function applyManualTextareaHeight(
  textarea: HTMLTextAreaElement,
  height: number,
): void {
  textarea.style.height = formatCssPixels(
    finiteNonNegative(height, DEFAULT_MIN_HEIGHT),
  );
  textarea.dataset[MANUAL_HEIGHT_DATASET_KEY] = "true";
}

export function clearManualTextareaHeight(textarea: HTMLTextAreaElement): void {
  delete textarea.dataset[MANUAL_HEIGHT_DATASET_KEY];
}

/**
 * Grow or shrink the shared composer textarea to its rendered wrapped content.
 * Content only scrolls after the CSS max-height is reached.
 */
export function resizeTextareaToContent(
  textarea: HTMLTextAreaElement,
): AdaptiveTextareaHeight {
  let computed: CSSStyleDeclaration | null = null;
  try {
    computed =
      textarea.ownerDocument?.defaultView?.getComputedStyle(textarea) ?? null;
  } catch {
    // Detached/fake DOMs can lack a working getComputedStyle implementation.
  }

  const minHeight = parseCssPixels(computed?.minHeight) ?? DEFAULT_MIN_HEIGHT;
  const maxHeight = parseCssPixels(computed?.maxHeight) ?? DEFAULT_MAX_HEIGHT;
  const borderHeight =
    computed?.boxSizing === "border-box"
      ? (parseCssPixels(computed.borderTopWidth) ?? 0) +
        (parseCssPixels(computed.borderBottomWidth) ?? 0)
      : 0;
  const manualHeight =
    textarea.dataset?.[MANUAL_HEIGHT_DATASET_KEY] === "true"
      ? parseCssPixels(textarea.style.height)
      : null;
  if (manualHeight !== null) {
    const height = Math.min(maxHeight, Math.max(minHeight, manualHeight));
    const naturalHeight =
      finiteNonNegative(textarea.scrollHeight, minHeight) + borderHeight;
    const result: AdaptiveTextareaHeight = {
      height,
      overflowY: naturalHeight > height + HEIGHT_EPSILON ? "auto" : "hidden",
    };
    textarea.style.height = formatCssPixels(result.height);
    textarea.style.overflowY = result.overflowY;
    return result;
  }

  textarea.style.height = "auto";
  const result = calculateAdaptiveTextareaHeight({
    scrollHeight: textarea.scrollHeight,
    minHeight,
    maxHeight,
    borderHeight,
  });

  textarea.style.height = formatCssPixels(result.height);
  textarea.style.overflowY = result.overflowY;
  return result;
}

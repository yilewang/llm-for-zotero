/**
 * Converting text boxes into the rectangles a Zotero annotation expects.
 *
 * Zotero stores highlight rects in **PDF user space**: origin bottom-left,
 * y increasing upward, units in points. Both of this plugin's existing
 * geometry producers emit the opposite convention — top-left origin, y down —
 * and neither is in points:
 *
 *   - the pdf.js path renders at a scale factor and reports canvas pixels;
 *   - the `pdftohtml -xml` path runs at poppler's default `-zoom 1.5`, and
 *     its own struct asserts `pdfWidth = width`, i.e. that XML units *are*
 *     points. That assertion is harmless where it is used today, because the
 *     only consumer re-derives the scale from the true page size and cancels
 *     the error out. Reused for annotation rects it would place every
 *     highlight at roughly two-thirds size, in the wrong corner.
 *
 * So the conversion is kept here, as a pure function with its own tests,
 * rather than inline at a call site where the assumption would be invisible.
 */

export type TopLeftBox = {
  /** Distance from the left edge, in source units. */
  left: number;
  /** Distance from the TOP edge, in source units. */
  top: number;
  width: number;
  height: number;
};

/** `[x1, y1, x2, y2]` in PDF user space, y-up. */
export type PdfRect = [number, number, number, number];

/**
 * Converts a top-left/y-down box into a PDF-user-space rect.
 *
 * `sourceScale` is how many source units make one PDF point — 1.5 for
 * `pdftohtml` at its default zoom, the render scale for a canvas. Passing 1
 * means the box is already in points.
 */
export function toPdfRect(params: {
  box: TopLeftBox;
  /** True page height in POINTS, not in source units. */
  pageHeightPoints: number;
  sourceScale?: number;
}): PdfRect {
  const scale =
    Number.isFinite(params.sourceScale) && Number(params.sourceScale) > 0
      ? Number(params.sourceScale)
      : 1;
  const left = params.box.left / scale;
  const width = params.box.width / scale;
  const top = params.box.top / scale;
  const height = params.box.height / scale;

  // Flip the vertical axis: a distance from the top becomes a distance from
  // the bottom, and the box's top edge becomes the LARGER y.
  const y2 = params.pageHeightPoints - top;
  const y1 = y2 - height;
  return [left, y1, left + width, y2];
}

/**
 * Merges the boxes that together cover one phrase.
 *
 * A title is rarely one text run — pdf.js emits a run per style change, and a
 * wrapped title spans lines. Zotero accepts several rects per annotation, so
 * boxes are merged per line rather than into one page-wide bounding box,
 * which would highlight the whitespace on either side of a short second line.
 */
export function mergeRectsByLine(
  rects: PdfRect[],
  lineTolerancePoints = 2,
): PdfRect[] {
  if (rects.length <= 1) return [...rects];
  const sorted = [...rects].sort((a, b) => b[3] - a[3] || a[0] - b[0]);
  const lines: PdfRect[] = [];
  for (const rect of sorted) {
    const current = lines[lines.length - 1];
    const sameLine =
      current !== undefined &&
      Math.abs(current[3] - rect[3]) <= lineTolerancePoints;
    if (!sameLine) {
      lines.push([...rect] as PdfRect);
      continue;
    }
    current[0] = Math.min(current[0], rect[0]);
    current[1] = Math.min(current[1], rect[1]);
    current[2] = Math.max(current[2], rect[2]);
    current[3] = Math.max(current[3], rect[3]);
  }
  return lines;
}

const PAD = (value: number, width: number): string =>
  String(Math.max(0, Math.floor(value))).padStart(width, "0");

/**
 * Builds Zotero's `annotationSortIndex`.
 *
 * Format-checked on save as `/^\d{5}\|\d{6}\|\d{5}$/`, so a malformed value
 * throws rather than sorting oddly. The middle field is the character offset
 * within the page text and affects only sidebar ordering, so an approximation
 * is safe; the outer two are the page and the distance from the page top.
 */
export function buildAnnotationSortIndex(params: {
  pageIndex: number;
  charOffset?: number;
  /** The annotation's topmost edge, in PDF user space (y-up). */
  topY: number;
  pageHeightPoints: number;
}): string {
  const fromTop = Math.max(0, params.pageHeightPoints - params.topY);
  return [
    PAD(params.pageIndex, 5),
    PAD(params.charOffset ?? 0, 6),
    PAD(fromTop, 5),
  ].join("|");
}

/** Zotero's highlight palette. Its validator is case-sensitive lowercase. */
export const ZOTERO_HIGHLIGHT_COLORS = {
  yellow: "#ffd400",
  red: "#ff6666",
  green: "#5fb236",
  blue: "#2ea8e5",
  purple: "#a28ae5",
  magenta: "#e56eee",
  orange: "#f19837",
  gray: "#aaaaaa",
} as const;

export type ZoteroHighlightColorName = keyof typeof ZOTERO_HIGHLIGHT_COLORS;

export function resolveHighlightColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed in ZOTERO_HIGHLIGHT_COLORS) {
    return ZOTERO_HIGHLIGHT_COLORS[trimmed as ZoteroHighlightColorName];
  }
  // Zotero validates against /#[a-f0-9]{6}/ and that regex is NOT
  // case-insensitive, so an uppercase hex is rejected on save.
  return /^#[a-f0-9]{6}$/.test(trimmed) ? trimmed : null;
}

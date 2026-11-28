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

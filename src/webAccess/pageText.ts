/**
 * Whole web pages, as web_read keeps them for a run's outline, sections and
 * whole-page reads: line breaks kept (headings and paragraphs), spaces inside
 * a line collapsed.
 */

/** The most of one page kept; a longer page is cut and marked truncated. */
export const WEB_PAGE_MAX_CHARS = 400_000;

export function normalizePageText(
  value: unknown,
  maxLength = WEB_PAGE_MAX_CHARS,
): { text: string; truncated: boolean } {
  const raw = typeof value === "string" ? value : "";
  const text = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > maxLength
    ? { text: text.slice(0, maxLength).trimEnd(), truncated: true }
    : { text, truncated: false };
}

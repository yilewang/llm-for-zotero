/**
 * The text form of a document map: one line per section with its id,
 * heading, pages, size and section count, so the model sees how large a
 * part is before it reads it. Deterministic for one file state: the
 * preloaded map is part of the prompt's stable prefix.
 */
import type { DocumentOutline, DocumentOutlineSection } from "./types";

/** "page 3" or "pages 3–6", or "" when the section has no page numbers. */
export function formatSectionPages(section: DocumentOutlineSection): string {
  const { pageStart, pageEnd } = section;
  if (pageStart === undefined || pageEnd === undefined) return "";
  return pageStart === pageEnd
    ? `page ${pageStart}`
    : `pages ${pageStart}–${pageEnd}`;
}

/** `s7 | Introduction | pages 22–85 | ~25198 tokens | 9 sections`. */
export function formatDocumentMapLine(section: DocumentOutlineSection): string {
  const pages = formatSectionPages(section);
  const children = section.childIds.length;
  return [
    section.sectionId,
    section.title,
    ...(pages ? [pages] : []),
    `~${section.tokens} tokens`,
    ...(children ? [`${children} section${children === 1 ? "" : "s"}`] : []),
  ].join(" | ");
}

/** The top-level sections of an outline, in document order. */
export function topLevelSections(
  outline: DocumentOutline,
): DocumentOutlineSection[] {
  return outline.sections.filter((section) => !section.parentId);
}

/** The map's top level as text: a summary line, then one line per part. */
export function formatDocumentMap(outline: DocumentOutline): string {
  const top = topLevelSections(outline);
  const tokens = top.reduce((sum, section) => sum + section.tokens, 0);
  const summary = [
    ...(outline.pageCount ? [`${outline.pageCount} pages`] : []),
    `~${tokens} tokens`,
    `${top.length} top-level part${top.length === 1 ? "" : "s"}`,
  ].join(", ");
  return [
    `Document map (id | heading | pages | size | sections): ${summary}.`,
    ...top.map(formatDocumentMapLine),
  ].join("\n");
}

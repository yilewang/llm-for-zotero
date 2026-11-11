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

/**
 * The chains of sections that hold a place in the document, each from the
 * top level down to the deepest section that holds it. The place is a chunk
 * when the chunk lies in some section, else a page from 1, as the map counts
 * pages. More than one chain when the place lies in more than one deepest
 * section, such as a page shared by two sections; none when nothing holds it.
 * When a chunk lies in several sections, those whose pages hold the page
 * are kept, if any do.
 */
export function locateInOutline(
  outline: DocumentOutline,
  place: { chunkIndex?: number; page?: number },
): DocumentOutlineSection[][] {
  const { chunkIndex, page } = place;
  const holdsPage = ({ pageStart, pageEnd }: DocumentOutlineSection) =>
    page !== undefined &&
    pageStart !== undefined &&
    pageEnd !== undefined &&
    pageStart <= page &&
    page <= pageEnd;
  let holders =
    chunkIndex === undefined
      ? []
      : outline.sections.filter(
          ({ chunkIndexes: [first, last] }) =>
            first <= chunkIndex && chunkIndex <= last,
        );
  if (holders.length > 1 && holders.some(holdsPage))
    holders = holders.filter(holdsPage);
  if (!holders.length) holders = outline.sections.filter(holdsPage);
  const held = new Set(holders.map((section) => section.sectionId));
  const byId = new Map(
    outline.sections.map((section) => [section.sectionId, section]),
  );
  return holders
    .filter((section) => !section.childIds.some((id) => held.has(id)))
    .map((deepest) => {
      const chain = [deepest];
      for (
        let parent = deepest.parentId ? byId.get(deepest.parentId) : undefined;
        parent && !chain.includes(parent);
        parent = parent.parentId ? byId.get(parent.parentId) : undefined
      )
        chain.unshift(parent);
      return chain;
    });
}

/** A chain of sections as map lines, top level first: `a › b › c`. */
export function formatSectionChain(chain: DocumentOutlineSection[]): string {
  return chain.map(formatDocumentMapLine).join(" › ");
}

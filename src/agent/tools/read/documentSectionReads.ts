/**
 * Reading a document by its section tree (`buildDocumentOutline`), under
 * the informed-choice rule: a leaf section's text, or any section's text
 * with `whole`; otherwise its sections with their sizes. A read the measured
 * context, or the model's `maxChars`, cannot hold returns the section's
 * sections, or a leaf's pages, instead of text; no read cuts a section in
 * the middle.
 */
import {
  formatDocumentMapLine,
  topLevelSections,
} from "../../../services/paperContent/documentMap";
import type {
  DocumentOutline,
  DocumentOutlineSection,
  PdfContext,
} from "../../../services/paperContent/types";
import { outlineFirstLine } from "../../digests/sectionPicker";
import { estimateTextTokens } from "../../../utils/modelInputCap";

/** What one requested section returns. */
export type SectionReadDecision =
  | { kind: "text"; section: DocumentOutlineSection }
  | {
      kind: "map";
      section: DocumentOutlineSection;
      /** has_sections: a part named without `whole`; does_not_fit: the read cannot fit. */
      reason: "has_sections" | "does_not_fit";
      /** One line per section, or per page of a leaf. */
      lines: string[];
    };

/** The sections directly under `section`, in document order. */
export function childSections(
  outline: DocumentOutline,
  section: DocumentOutlineSection,
): DocumentOutlineSection[] {
  const byId = new Map(
    outline.sections.map((entry) => [entry.sectionId, entry]),
  );
  return section.childIds.flatMap((id) => byId.get(id) || []);
}

/**
 * One level of the tree: the top level, or the sections under `sectionId`.
 * Null when the outline has no such section.
 */
export function outlineLevel(
  outline: DocumentOutline,
  sectionId?: string,
): DocumentOutlineSection[] | null {
  if (!sectionId) return topLevelSections(outline);
  const section = outline.sections.find(
    (entry) => entry.sectionId === sectionId,
  );
  return section ? childSections(outline, section) : null;
}

/** `sectionIds` with every section nested under them. */
export function withDescendants(
  outline: DocumentOutline,
  sectionIds: readonly string[],
): string[] {
  const byId = new Map(
    outline.sections.map((entry) => [entry.sectionId, entry]),
  );
  const result = new Set<string>();
  const add = (id: string) => {
    if (result.has(id)) return;
    const section = byId.get(id);
    if (!section) return;
    result.add(id);
    for (const child of section.childIds) add(child);
  };
  for (const id of sectionIds) add(id);
  return [...result];
}

/**
 * The address book a targeted read carries: the top level, and the chain
 * of sections down to each section the read returned text from.
 */
export function embeddedOutline(
  outline: DocumentOutline,
  readSectionIds: readonly string[] = [],
): DocumentOutline {
  const byId = new Map(
    outline.sections.map((entry) => [entry.sectionId, entry]),
  );
  const kept = new Set(
    topLevelSections(outline).map((entry) => entry.sectionId),
  );
  for (const id of readSectionIds) {
    let section = byId.get(id);
    while (section) {
      kept.add(section.sectionId);
      section = section.parentId ? byId.get(section.parentId) : undefined;
    }
  }
  return {
    sections: outline.sections.filter((entry) => kept.has(entry.sectionId)),
    totalChunks: outline.totalChunks,
    ...(outline.chaptered ? { chaptered: true as const } : {}),
    ...(outline.pageCount ? { pageCount: outline.pageCount } : {}),
  };
}

/** One line of a page map: the page, its size, its first line. */
export function formatPageMapLine(page: {
  label: string;
  tokens: number;
  firstLine: string;
}): string {
  return [
    ...(page.label ? [page.label] : []),
    `~${page.tokens} tokens`,
    ...(page.firstLine ? [page.firstLine] : []),
  ].join(" | ");
}

/**
 * A run of chunks as pages, one line each with its size and first line
 * (a whole leaf section's, or a whole document's). Without page numbers,
 * one line per chunk.
 */
export function pageMapLines(
  content: Pick<PdfContext, "chunks" | "chunkMeta">,
  section: Pick<DocumentOutlineSection, "chunkIndexes">,
): string[] {
  const [from, to] = section.chunkIndexes;
  const pages: Array<{ label: string; tokens: number; firstLine: string }> = [];
  for (let index = from; index <= to; index += 1) {
    const text = content.chunks[index] || "";
    const meta = content.chunkMeta[index];
    const label =
      meta?.pageStart !== undefined
        ? meta.pageEnd !== undefined && meta.pageEnd !== meta.pageStart
          ? `pages ${meta.pageStart + 1}–${meta.pageEnd + 1}`
          : `page ${meta.pageStart + 1}`
        : "";
    const last = pages[pages.length - 1];
    if (last && label && last.label === label) {
      last.tokens += estimateTextTokens(text);
      continue;
    }
    pages.push({
      label,
      tokens: estimateTextTokens(text),
      firstLine: outlineFirstLine(text),
    });
  }
  return pages.map(formatPageMapLine);
}

/**
 * The informed-choice rule for one section: text for a leaf, or for any
 * section with `whole`, when its size fits `remainingTokens` and, when the
 * model gave a `maxChars`, the characters left of it (`remainingChars`);
 * otherwise its sections with their sizes, or a leaf's pages.
 */
export function decideSectionRead(params: {
  outline: DocumentOutline;
  content: Pick<PdfContext, "chunks" | "chunkMeta" | "textPages">;
  section: DocumentOutlineSection;
  whole: boolean;
  remainingTokens: number;
  remainingChars?: number;
}): SectionReadDecision {
  const { outline, section } = params;
  const children = childSections(outline, section);
  const childLines = () => children.map(formatDocumentMapLine);
  if (children.length && !params.whole)
    return {
      kind: "map",
      section,
      reason: "has_sections",
      lines: childLines(),
    };
  if (
    section.tokens <= params.remainingTokens &&
    (params.remainingChars === undefined ||
      section.chars <= params.remainingChars)
  )
    return { kind: "text", section };
  return {
    kind: "map",
    section,
    reason: "does_not_fit",
    lines: children.length
      ? childLines()
      : (sectionPageLines(params.content, section) ??
        pageMapLines(params.content, section)),
  };
}

/**
 * A leaf section's pages from the document's `textPages` (an unchaptered
 * document read by its bookmark sections), one line per page. Null without
 * them.
 */
function sectionPageLines(
  content: Pick<PdfContext, "textPages">,
  section: Pick<DocumentOutlineSection, "pageStart" | "pageEnd">,
): string[] | null {
  const lines = documentPageMap(content);
  if (
    !lines ||
    section.pageStart === undefined ||
    section.pageEnd === undefined
  )
    return null;
  return lines.slice(section.pageStart - 1, section.pageEnd);
}

/**
 * A whole document as a page map, one line per page, from its `textPages`.
 * Null without them: chunk page numbers cannot stand in (a MinerU chunk
 * carries its section's first page, so pages would go missing).
 */
export function documentPageMap(
  content: Pick<PdfContext, "textPages">,
): string[] | null {
  if (!content.textPages?.length) return null;
  return content.textPages.map((page, index) =>
    formatPageMapLine({
      label: `page ${index + 1}`,
      tokens: page.tokens,
      firstLine: outlineFirstLine(page.firstLine),
    }),
  );
}

/**
 * A paper's text cut to a read scope (`readScope.ts`), as pure helpers:
 * - sections of MinerU text by the exact heading bounds, with their
 *   descendant sections;
 * - sections of plain PDF text by the chunk kinds the PDF reader assigned
 *   (the closed `PdfChunkKind` vocabulary), so their bounds are approximate;
 * - pages from the PDF's own page text.
 * A name nothing matches is reported, never replaced by more text: a read
 * that matches nothing reads nothing and says so.
 */
import {
  buildSyntheticManifestSections,
  classifyHeadingKind,
  enclosingStandardSections,
} from "../../services/paperContent/pdfContext";
import type {
  PdfChunkKind,
  PdfContext,
} from "../../services/paperContent/types";
import { tokenizeRetrievalText } from "../../services/retrieval/retrievalTokenizer";
import { pageRangeText, type ReadScopePageRange } from "./readScope";

/** The standard section kinds a section name can name. */
const STANDARD_KINDS: ReadonlySet<PdfChunkKind> = new Set<PdfChunkKind>([
  "abstract",
  "introduction",
  "methods",
  "results",
  "discussion",
  "conclusion",
]);

/** Whether a section name asks for the abstract. */
export function isAbstractSectionName(name: string): boolean {
  return readScopeSectionKind(name) === "abstract";
}

/**
 * The standard section a requested name names ("results", "Materials and
 * methods"), or undefined for any other name.
 */
export function readScopeSectionKind(name: string): PdfChunkKind | undefined {
  const kind = classifyHeadingKind(name, "heading")?.kind;
  return kind && STANDARD_KINDS.has(kind) ? kind : undefined;
}

/** How a requested name is named in what a read covered. */
function coveredLabel(name: string): string {
  return classifyHeadingKind(name, "heading")?.label || name;
}

function nameTokens(text: string): string[] {
  return tokenizeRetrievalText(text, { filterStopwords: true });
}

type SectionSelection = {
  text: string;
  covered: string[];
  unmatched: string[];
};

/**
 * The named sections of MinerU markdown, by its own heading bounds: each
 * section a name matches (a standard section name by its heading's kind
 * alone; any other name by a heading that holds every word of it) with its
 * descendant sections (by heading depth, and for methods, results,
 * discussion and conclusion the subsections that follow them), in document
 * order. The paper's title heading never matches.
 */
export function selectMineruScopeSections(
  markdown: string,
  names: readonly string[],
): SectionSelection {
  const sections = buildSyntheticManifestSections(markdown);
  const enclosing = enclosingStandardSections(sections);
  const title =
    sections[0]?.level === 1 && sections.some((section) => section.level > 1)
      ? 0
      : -1;
  const chosen = new Set<number>();
  const covered: string[] = [];
  const unmatched: string[] = [];
  const isDescendant = (index: number, roots: ReadonlySet<number>) => {
    let parent = sections[index]?.parentIndex;
    while (parent !== undefined && parent !== null) {
      if (parent !== title && roots.has(parent)) return true;
      parent = sections[parent]?.parentIndex;
    }
    return false;
  };
  for (const name of names) {
    const kind = readScopeSectionKind(name);
    const tokens = nameTokens(name);
    const direct = new Set<number>();
    sections.forEach((section, index) => {
      if (index === title) return;
      // A run-on heading ("Results and discussion") names its section only
      // at the top level: "### Abstract representations emerge in CA1"
      // under Results is a results subsection, not the abstract.
      const topLevel =
        section.parentIndex === undefined ||
        section.parentIndex === null ||
        section.parentIndex === title;
      const headingKind = (
        classifyHeadingKind(section.heading, "line") ||
        (topLevel ? classifyHeadingKind(section.heading) : undefined)
      )?.kind;
      if (kind) {
        // A standard section name matches by heading kind only: word
        // matching would take "Abstract representations ..." for the
        // abstract and "Comparison with other methods" for the methods.
        if (headingKind === kind) direct.add(index);
        return;
      }
      if (!tokens.length) return;
      const heading = new Set(nameTokens(section.heading));
      if (tokens.every((token) => heading.has(token))) direct.add(index);
    });
    if (!direct.size) {
      unmatched.push(name);
      continue;
    }
    covered.push(coveredLabel(name));
    sections.forEach((section, index) => {
      // A section whose enclosing section is its own heading was classed by
      // its run-on words alone ("Abstract representations ..."): it is not
      // inside a standard section of that kind.
      const inherited = enclosing[index];
      if (
        direct.has(index) ||
        isDescendant(index, direct) ||
        (kind !== undefined &&
          inherited !== undefined &&
          inherited !== section.heading &&
          classifyHeadingKind(inherited)?.kind === kind)
      )
        chosen.add(index);
    });
  }
  const text = [...chosen]
    .sort((a, b) => a - b)
    .map((index) =>
      markdown.slice(sections[index].charStart, sections[index].charEnd),
    )
    .join("")
    .trim();
  return { text, covered, unmatched };
}

/** A chunk as the digest reads PDF text: under its `[chunk N]` marker. */
function chunkBlock(index: number, text: string): string {
  return `[chunk ${index}]\n${text.trim()}`;
}

/**
 * The named sections of plain PDF text, by the kind the PDF reader gave
 * each chunk (its heading's, or the standard section it lies in). Only the
 * standard sections can be named this way (abstract, introduction, methods,
 * results, discussion, conclusion); any other name, and a standard one no
 * chunk carries, is unmatched. Chunks of another kind are never read.
 */
export function selectPdfChunkScopeSections(
  context: Pick<PdfContext, "chunks" | "chunkMeta">,
  names: readonly string[],
): SectionSelection {
  const chosen = new Set<number>();
  const covered: string[] = [];
  const unmatched: string[] = [];
  const meta = context.chunkMeta || [];
  for (const name of names) {
    const kind = readScopeSectionKind(name);
    const matched = kind
      ? meta.filter(
          (entry) =>
            entry.chunkKind === kind ||
            (entry.enclosingSection !== undefined &&
              classifyHeadingKind(entry.enclosingSection)?.kind === kind),
        )
      : [];
    if (!matched.length) {
      unmatched.push(name);
      continue;
    }
    covered.push(coveredLabel(name));
    for (const entry of matched) chosen.add(entry.chunkIndex);
  }
  const text = [...chosen]
    .sort((a, b) => a - b)
    .filter((index) => (context.chunks[index] || "").trim())
    .map((index) => chunkBlock(index, context.chunks[index]))
    .join("\n\n");
  return { text, covered, unmatched };
}

/** One PDF page's text, as the page-text cache holds it (0-based index). */
export type ScopePageText = {
  pageIndex: number;
  pageLabel?: string;
  text: string;
};

/**
 * The named page ranges of a PDF's page text, each page under a
 * `[page N]` line. A range with no page that has text is unmatched.
 */
export function selectPageScope(
  pages: readonly ScopePageText[],
  ranges: readonly ReadScopePageRange[],
): SectionSelection {
  const byNumber = new Map(pages.map((page) => [page.pageIndex + 1, page]));
  const chosen = new Set<number>();
  const covered: string[] = [];
  const unmatched: string[] = [];
  for (const range of ranges) {
    const found: number[] = [];
    for (let number = range.from; number <= range.to; number += 1) {
      if ((byNumber.get(number)?.text || "").trim()) found.push(number);
    }
    const label = `pages ${pageRangeText(range)}`;
    if (!found.length) {
      unmatched.push(label);
      continue;
    }
    covered.push(label);
    for (const number of found) chosen.add(number);
  }
  const text = [...chosen]
    .sort((a, b) => a - b)
    .map((number) => `[page ${number}]\n${byNumber.get(number)!.text.trim()}`)
    .join("\n\n");
  return { text, covered, unmatched };
}

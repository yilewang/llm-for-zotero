/**
 * A paper's text cut to a read scope (`readScope.ts`), as pure helpers:
 * - sections of MinerU text by the exact heading bounds, with their
 *   descendant sections;
 * - sections of plain PDF text by the chunk kinds the PDF reader assigned
 *   (the closed `PdfChunkKind` vocabulary), so their bounds are approximate;
 * - pages from the PDF's own page text.
 * A name nothing matches is reported, never replaced by more text: a read
 * that matches nothing reads nothing and says so.
 *
 * A paper that labels neither its abstract nor its results (a Nature
 * article: an unheaded lead paragraph, then topic headings) has them found
 * by their place instead, flagged approximate and named as such in what the
 * read covered (`LEAD_ABSTRACT_LABEL`, `RESULTS_SPAN_LABEL`). When the place
 * gives nothing either, the name stays unmatched.
 */
import type { ManifestSection } from "../../services/mineru/mineruCache";
import {
  buildSyntheticManifestSections,
  classifyHeadingKind,
  enclosingStandardSections,
  isBackMatterHeading,
} from "../../services/paperContent/pdfContext";
import type {
  PdfChunkKind,
  PdfContext,
} from "../../services/paperContent/types";
import { tokenizeRetrievalText } from "../../services/retrieval/retrievalTokenizer";
import {
  LEAD_ABSTRACT_LABEL,
  pageRangeText,
  READ_SCOPE_TEXT_SOURCES,
  RESULTS_SPAN_LABEL,
  type ReadScopePageRange,
} from "./readScope";

export { LEAD_ABSTRACT_LABEL, RESULTS_SPAN_LABEL };

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

/** The shortest lead paragraph read as an abstract. */
const LEAD_ABSTRACT_MIN_CHARS = 600;
/** A prose paragraph has at least this many sentence ends. */
const LEAD_ABSTRACT_MIN_SENTENCES = 3;
/** A Summary heading names the abstract only within this many sections. */
const SUMMARY_ABSTRACT_MAX_INDEX = 3;
/** The title block is at most this many leading sections. */
const TITLE_BLOCK_MAX_SECTIONS = 3;

/** "Summary", "SUMMARY." (Cell's abstract heading); never "Summary statistics". */
const SUMMARY_HEADING_PATTERN = /^summary[:.\s-]*$/i;
/**
 * Introduction headings `classifyHeadingKind` does not name: Nature's
 * "Main" and "Background". Top-level headings only.
 */
const INTRODUCTION_HEADING_PATTERN = /^(?:main|background)[:.\s-]*$/i;
/** Methods headings `classifyHeadingKind` does not name. */
const METHODS_HEADING_PATTERN =
  /^(?:online methods|star methods|experimental procedures?|methods and materials)\b/i;
/**
 * Cell's "STAR Methods" heading line. MinerU drops it as a noise heading,
 * so it is not a section; the markdown still holds the line.
 */
const STAR_METHODS_LINE_PATTERN = /^#{1,6}\s+star\s+methods\s*$/im;
/** Lines that are not prose: an image, a table, math, a caption. */
const NON_PROSE_BLOCK_PATTERN =
  /^(?:!\[|\||<|\$\$|(?:fig(?:ure)?\.?|table|extended data)\s*\d)/i;
/**
 * Front-matter blocks by their phrases, never a single word an abstract
 * can use ("two licensed vaccines"): a licence, a copyright line, the
 * publication dates.
 */
const FRONT_MATTER_BLOCK_PATTERN =
  /\blicensed under\b|\bcreative commons\b|©|\bcopyright\s+\d{4}\b|\ball rights reserved\b|^(?:received|accepted|published)\b/i;
/**
 * An institution as an affiliation names it ("Department of", "1University
 * of"); a block with several lists affiliations. An abstract's "hospital"
 * or "laboratory" is not one.
 */
const AFFILIATION_PHRASE_PATTERN =
  /(?<![a-z])(?:department|university|institute|school|faculty|college)\s+(?:of|for)\b/gi;
/** An affiliation block names at least this many institutions. */
const AFFILIATION_MIN_PHRASES = 3;
/** A sentence end followed by the next sentence ("rest. We"). */
const SENTENCE_END_PATTERN = /[a-z0-9)\]%][.!?]\s+(?=[A-Z(])/g;

/**
 * Kinds that end an unlabelled results span. Methods does not: a Methods
 * section before the results is a front section the span starts after.
 */
const RESULTS_SPAN_END_KINDS: ReadonlySet<PdfChunkKind> = new Set<PdfChunkKind>(
  ["discussion", "conclusion", "references", "appendix"],
);

/** A heading's section number ("2", "2.1"), without a trailing dot. */
function sectionNumber(heading: string): string | undefined {
  return /^(\d+(?:\.\d+)*)\.?\s/.exec(heading.trim())?.[1];
}

function headingText(heading: string): string {
  return heading
    .replace(/^(?:\d+(?:\.\d+)*\.?|[ivxlcdm]+\.)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Each section's standard kind as its heading names it, and the paper's
 * title heading (index 0 when the markdown nests its headings, else -1).
 * A run-on heading ("Results and discussion") names its section only at
 * the top level: "### Abstract representations emerge in CA1" under
 * Results is a results subsection, not the abstract.
 */
function sectionKinds(sections: readonly ManifestSection[]): {
  title: number;
  kinds: Array<PdfChunkKind | undefined>;
} {
  const title =
    sections[0]?.level === 1 && sections.some((section) => section.level > 1)
      ? 0
      : -1;
  const kinds = sections.map((section, index) => {
    if (index === title) return undefined;
    const topLevel =
      section.parentIndex === undefined ||
      section.parentIndex === null ||
      section.parentIndex === title;
    return (
      classifyHeadingKind(section.heading, "line") ||
      (topLevel ? classifyHeadingKind(section.heading) : undefined)
    )?.kind;
  });
  return { title, kinds };
}

/** Whether a paragraph reads as prose, not a front-matter line or block. */
function isLeadProse(block: string): boolean {
  if (block.length < LEAD_ABSTRACT_MIN_CHARS) return false;
  if (/^#{1,6}\s/.test(block) || NON_PROSE_BLOCK_PATTERN.test(block))
    return false;
  if (FRONT_MATTER_BLOCK_PATTERN.test(block)) return false;
  // Correspondence and affiliation blocks carry an email address, or name
  // several institutions.
  if (/\S@\S+\.\S/.test(block)) return false;
  if (
    (block.match(AFFILIATION_PHRASE_PATTERN) || []).length >=
    AFFILIATION_MIN_PHRASES
  )
    return false;
  return (
    (block.match(SENTENCE_END_PATTERN) || []).length + 1 >=
    LEAD_ABSTRACT_MIN_SENTENCES
  );
}

/** The first prose paragraph of a stretch of markdown, or "". */
function firstLeadProse(text: string): string {
  for (const raw of text.split(/\n\s*\n/)) {
    const block = raw.trim();
    if (isLeadProse(block)) return block;
  }
  return "";
}

/**
 * The index after the title block: the leading headings with no text of
 * their own, then the first section that has some, at most the first three
 * sections. MinerU writes the title as one or two headings, sometimes after
 * a running "Article" heading; the section that holds the front matter
 * (authors, dates, the lead) ends the block. A section after it is the
 * body, even when it opens with a long paragraph. The block stops before a
 * standard or back-matter heading, or an introduction by another name
 * ("Background", "Main"), at the top level (0 when the paper opens with
 * one).
 */
function titleBlockEnd(
  markdown: string,
  sections: readonly ManifestSection[],
  kinds: ReadonlyArray<PdfChunkKind | undefined>,
): number {
  const last = Math.min(sections.length, TITLE_BLOCK_MAX_SECTIONS);
  for (let index = 0; index < last; index += 1) {
    const section = sections[index];
    if (kinds[index] || isBackMatterHeading(section.heading)) return index;
    if (
      INTRODUCTION_HEADING_PATTERN.test(headingText(section.heading)) &&
      isTopLevel(sections, index, 1)
    )
      return index;
    const body = markdown
      .slice(section.charStart, section.charEnd)
      .replace(/^[^\n]*\n?/, "");
    if (body.trim()) return index + 1;
  }
  return last;
}

/**
 * The abstract of MinerU markdown that labels none (a Nature article's
 * bold lead): the first prose paragraph of 600 characters or more in the
 * title block, before the first heading after it. Front-matter blocks
 * before it (authors, dates, DOI, affiliations, a licence) are short or
 * not prose, so they are skipped. Empty when there is no such paragraph,
 * or no heading after it to bound it. The caller uses it only when the
 * abstract field, an abstract heading and the PDF abstract chunks have all
 * missed.
 */
export function selectLeadAbstract(markdown: string): string {
  const sections = buildSyntheticManifestSections(markdown);
  if (!sections.length) return "";
  const { kinds } = sectionKinds(sections);
  const end = titleBlockEnd(markdown, sections, kinds);
  if (end >= sections.length) return "";
  return firstLeadProse(markdown.slice(0, sections[end].charStart));
}

/** Whether a section is at the top level (its parent is the title, if any). */
function isTopLevel(
  sections: readonly ManifestSection[],
  index: number,
  titleEnd: number,
): boolean {
  const parent = sections[index]?.parentIndex;
  return parent === undefined || parent === null || parent < titleEnd;
}

/**
 * The index of a Cell-style "Summary" heading that stands for the abstract:
 * one of the first sections, before any standard section heading or an
 * introduction by another name ("Background"). Else -1.
 */
function summaryAbstractIndex(
  sections: readonly ManifestSection[],
  kinds: ReadonlyArray<PdfChunkKind | undefined>,
): number {
  const last = Math.min(sections.length - 1, SUMMARY_ABSTRACT_MAX_INDEX);
  for (let index = 0; index <= last; index += 1) {
    const kind = kinds[index];
    if (kind && STANDARD_KINDS.has(kind)) return -1;
    const heading = headingText(sections[index].heading);
    if (
      INTRODUCTION_HEADING_PATTERN.test(heading) &&
      isTopLevel(sections, index, 1)
    )
      return -1;
    if (SUMMARY_HEADING_PATTERN.test(heading)) return index;
  }
  return -1;
}

/**
 * The results of a paper that labels none, by place: the sections after the
 * title block and after the last front section (an abstract or the summary
 * that stands for one, an introduction, a methods section, each with its
 * subsections), up to the first discussion, conclusion or back-matter
 * heading. Only for a paper with both a Discussion and a Methods heading,
 * which say the sections between are an empirical paper's results; a
 * review without them gets nothing.
 */
function unlabelledResultsSpan(
  markdown: string,
  sections: readonly ManifestSection[],
  kinds: ReadonlyArray<PdfChunkKind | undefined>,
  summary: number,
): number[] {
  const from = titleBlockEnd(markdown, sections, kinds);
  const isMethods = (index: number) =>
    kinds[index] === "methods" ||
    METHODS_HEADING_PATTERN.test(headingText(sections[index].heading));
  if (!kinds.some((kind, index) => index >= from && kind === "discussion"))
    return [];
  if (
    !sections.some((_, index) => isMethods(index)) &&
    !STAR_METHODS_LINE_PATTERN.test(markdown)
  )
    return [];
  let end = sections.length;
  for (let index = from; index < sections.length; index += 1) {
    const kind = kinds[index];
    if (
      (kind && RESULTS_SPAN_END_KINDS.has(kind)) ||
      isBackMatterHeading(sections[index].heading)
    ) {
      end = index;
      break;
    }
  }
  let start = from;
  for (let index = from; index < end; index += 1) {
    const kind = kinds[index];
    if (
      kind === "introduction" ||
      kind === "abstract" ||
      index === summary ||
      isMethods(index) ||
      (INTRODUCTION_HEADING_PATTERN.test(
        headingText(sections[index].heading),
      ) &&
        isTopLevel(sections, index, from))
    )
      start = index + 1;
  }
  const front = start - 1;
  const insideFront = (index: number) => {
    let parent = sections[index]?.parentIndex;
    while (parent !== undefined && parent !== null) {
      if (parent === front) return true;
      parent = sections[parent]?.parentIndex;
    }
    return false;
  };
  // Flat MinerU text has no depth: a front section numbered "2" keeps the
  // sections numbered "2.1", "2.2" that follow it.
  const frontNumber =
    front >= from ? sectionNumber(sections[front].heading) : undefined;
  const numberedInsideFront = (index: number) => {
    const number = sectionNumber(sections[index].heading);
    return (
      frontNumber !== undefined &&
      number !== undefined &&
      number.startsWith(`${frontNumber}.`)
    );
  };
  while (
    start < end &&
    front >= from &&
    (insideFront(start) || numberedInsideFront(start))
  )
    start += 1;
  const span: number[] = [];
  for (let index = start; index < end; index += 1) span.push(index);
  return span;
}

/** A selection of MinerU sections, with how each was found. */
export type MineruScopeSelection = SectionSelection & {
  /** True when a name was found by place, not by its heading. */
  approximate: boolean;
  /** Where the text came from (`READ_SCOPE_TEXT_SOURCES`). */
  sources: string[];
};

/**
 * The named sections of MinerU markdown, by its own heading bounds: each
 * section a name matches (a standard section name by its heading's kind
 * alone; any other name by a heading that holds every word of it) with its
 * descendant sections (by heading depth, and for methods, results,
 * discussion and conclusion the subsections that follow them), in document
 * order. The paper's title heading never matches.
 *
 * Two names are also found where the paper does not label them: the
 * abstract by a "Summary" heading at the start (Cell), with exact bounds;
 * the results, when no heading names them, by the sections before the
 * Discussion (`unlabelledResultsSpan`), flagged approximate.
 */
export function selectMineruScopeSections(
  markdown: string,
  names: readonly string[],
): MineruScopeSelection {
  return mineruScopeSelection(
    markdown,
    chooseMineruScopeSections(markdown, names),
  );
}

/** One name's sections in a MinerU choice. */
export type MineruScopePart = {
  name: string;
  /** What the read covered for the name ("Results (unlabelled sections)"). */
  label: string;
  /** Indexes into the choice's `sections`, in document order. */
  indexes: number[];
  /** Found by place, not by a heading (an unlabelled results span). */
  byPosition: boolean;
};

/** The sections a scope's names choose in MinerU markdown, by index. */
export type MineruScopeChoice = {
  /** The markdown's sections (`buildSyntheticManifestSections`). */
  sections: ManifestSection[];
  parts: MineruScopePart[];
  unmatched: string[];
};

/**
 * The section choice `selectMineruScopeSections` reads, as indexes: the one
 * rule a whole-sections read and a targeted read over named sections share.
 */
export function chooseMineruScopeSections(
  markdown: string,
  names: readonly string[],
): MineruScopeChoice {
  const sections = buildSyntheticManifestSections(markdown);
  const enclosing = enclosingStandardSections(sections);
  const { title, kinds } = sectionKinds(sections);
  const parts: MineruScopePart[] = [];
  const unmatched: string[] = [];
  const summary = summaryAbstractIndex(sections, kinds);
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
      const headingKind = kinds[index];
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
    if (!direct.size && kind === "abstract" && summary >= 0)
      direct.add(summary);
    if (!direct.size && kind === "results") {
      const span = unlabelledResultsSpan(markdown, sections, kinds, summary);
      const spanText = span
        .map((index) =>
          markdown
            .slice(sections[index].charStart, sections[index].charEnd)
            .replace(/^#{1,6}\s[^\n]*$/gm, ""),
        )
        .join("")
        .trim();
      if (spanText) {
        parts.push({
          name,
          label: RESULTS_SPAN_LABEL,
          indexes: span,
          byPosition: true,
        });
        continue;
      }
    }
    if (!direct.size) {
      unmatched.push(name);
      continue;
    }
    const indexes: number[] = [];
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
        indexes.push(index);
    });
    parts.push({ name, label: coveredLabel(name), indexes, byPosition: false });
  }
  return { sections, parts, unmatched };
}

/** A MinerU choice's text, as `selectMineruScopeSections` returns it. */
function mineruScopeSelection(
  markdown: string,
  choice: MineruScopeChoice,
): MineruScopeSelection {
  const { sections } = choice;
  const chosen = new Set<number>();
  const spanChosen = new Set<number>();
  for (const part of choice.parts)
    for (const index of part.indexes)
      (part.byPosition ? spanChosen : chosen).add(index);
  const text = [...new Set([...chosen, ...spanChosen])]
    .sort((a, b) => a - b)
    .map((index) =>
      markdown.slice(sections[index].charStart, sections[index].charEnd),
    )
    .join("")
    .trim();
  const sources: string[] = [];
  if (chosen.size) sources.push(READ_SCOPE_TEXT_SOURCES.mineruSections);
  if (spanChosen.size) sources.push(READ_SCOPE_TEXT_SOURCES.mineruResultsSpan);
  return {
    text,
    covered: choice.parts.map((part) => part.label),
    unmatched: choice.unmatched,
    approximate: spanChosen.size > 0,
    sources,
  };
}

/**
 * The chunks of a MinerU paper that hold the chosen sections. The chunks
 * name their section by its heading and its index in the manifest; the
 * choice indexes the markdown's own sections, so a section is matched by
 * its heading and which occurrence of that heading it is.
 */
export function chunkIndexesForMineruSections(
  context: Pick<PdfContext, "chunkMeta">,
  sections: readonly ManifestSection[],
  indexes: readonly number[],
): number[] {
  const chunkSections = new Map<number, string>();
  for (const meta of context.chunkMeta || [])
    if (
      meta?.sectionIndex !== undefined &&
      !chunkSections.has(meta.sectionIndex)
    )
      chunkSections.set(meta.sectionIndex, meta.sectionLabel || "");
  const ordered = [...chunkSections.entries()].sort(([a], [b]) => a - b);
  const occurrence = (list: readonly string[], index: number) =>
    list.slice(0, index).filter((heading) => heading === list[index]).length;
  const headings = sections.map((section) => section.heading);
  const wanted = new Set<number>();
  for (const index of indexes) {
    const heading = headings[index];
    if (heading === undefined) continue;
    const nth = occurrence(headings, index);
    const match = ordered.filter(([, label]) => label === heading)[nth];
    if (match) wanted.add(match[0]);
  }
  return (context.chunkMeta || [])
    .filter(
      (meta) =>
        meta?.sectionIndex !== undefined && wanted.has(meta.sectionIndex),
    )
    .map((meta) => meta.chunkIndex);
}

/** The chunks that hold an unheaded lead abstract's text. */
export function chunkIndexesForText(
  context: Pick<PdfContext, "chunks">,
  text: string,
): number[] {
  const flat = (value: string) => value.replace(/\s+/g, " ").trim();
  const whole = flat(text);
  if (!whole) return [];
  const PROBE = 80;
  const head = whole.slice(0, PROBE);
  const tail = whole.slice(-PROBE);
  const indexes: number[] = [];
  (context.chunks || []).forEach((chunk, index) => {
    const body = flat(chunk || "");
    if (!body) return;
    if (
      body.includes(head) ||
      body.includes(tail) ||
      whole.includes(body.slice(0, PROBE))
    )
      indexes.push(index);
  });
  return indexes;
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
  options: ChunkKindOptions = {},
): SectionSelection {
  const chosen = new Set<number>();
  const covered: string[] = [];
  const unmatched: string[] = [];
  for (const name of names) {
    const matched = pdfChunkIndexesForSection(context, name, options);
    if (!matched.length) {
      unmatched.push(name);
      continue;
    }
    covered.push(coveredLabel(name));
    for (const index of matched) chosen.add(index);
  }
  const text = [...chosen]
    .sort((a, b) => a - b)
    .filter((index) => (context.chunks[index] || "").trim())
    .map((index) => chunkBlock(index, context.chunks[index]))
    .join("\n\n");
  return { text, covered, unmatched };
}

type ChunkKindOptions = {
  /**
   * The MinerU selector already judged every heading (nested ones by the
   * line rule): only chunks no heading classed (the preamble) count, so
   * "### Abstract representations of space" under Methods is never the
   * abstract.
   */
  headingsJudged?: boolean;
};

/**
 * The chunks of plain PDF text a standard section name names, by the kind
 * the PDF reader gave each chunk; none for any other name.
 */
export function pdfChunkIndexesForSection(
  context: Pick<PdfContext, "chunkMeta">,
  name: string,
  options: ChunkKindOptions = {},
): number[] {
  const kind = readScopeSectionKind(name);
  if (!kind) return [];
  return (context.chunkMeta || [])
    .filter((entry) =>
      options.headingsJudged
        ? entry.kindSource !== "manifest" &&
          entry.sectionIndex === undefined &&
          entry.chunkKind === kind
        : entry.chunkKind === kind ||
          (entry.enclosingSection !== undefined &&
            classifyHeadingKind(entry.enclosingSection)?.kind === kind),
    )
    .map((entry) => entry.chunkIndex);
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

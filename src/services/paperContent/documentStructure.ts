/**
 * The section structure of a plain PDF's text: bookmarks first, else
 * numbered headings that open pages. Pure: the caller passes the text, how
 * it splits into pages, and the bookmarks it read.
 *
 * A structure is returned only for a chaptered document: from bookmarks,
 * every top-level bookmark starts its page, on at least two pages; from
 * headings, at least two numbered chapter headings open pages in an
 * unbroken run. A paper's sections start mid-page, so a paper gets none and
 * keeps today's behavior. Every signal here is structural (bookmarks, page
 * openings, numbering); nothing judges what a section means, and no word of
 * any language is special: a heading's label ("Chapter", "Kapitel", "第") is
 * any run of letters. Numbers are read only as the digits 0-9, so a document
 * numbered otherwise ("第四章", "IV") gets a structure only from bookmarks.
 */
import type { PdfOutlineEntry } from "../../utils/pdfOutline";
import type { DocumentStructureSection } from "./types";
import { estimateTextTokens } from "../../utils/modelInputCap";

export type { DocumentStructureSection, PdfOutlineEntry };

/** How the extracted text splits into the PDF's pages. */
export type PdfPageLayout = {
  /** Characters per page (older Zotero builds); else form feeds split. */
  pageChars?: number[];
  /** The PDF's real page count. */
  totalPages?: number;
};

/** One page of the text: `[start, end)` offsets, its 0-based part index. */
export type TextPageSpan = { index: number; start: number; end: number };

export type DetectedDocumentStructure = {
  source: "bookmarks" | "headings";
  sections: DocumentStructureSection[];
  /** The PDF's page count. */
  pageCount: number;
  /**
   * PDF pages before the text's first page: blank leading pages that the
   * extracted text trimmed away. Text page `i` is PDF page `i + pageOffset`.
   */
  pageOffset: number;
};

/** The title of the text before a document's first section. */
export const BEFORE_FIRST_SECTION_TITLE = "(before the first section)";

/**
 * The text's pages: by `pageChars` when the extractor gave them, else by the
 * form feeds Zotero puts between pages. Null when the split is not usable.
 */
export function splitPdfTextPages(
  text: string,
  layout: PdfPageLayout = {},
): TextPageSpan[] | null {
  if (!text) return null;
  const spans: TextPageSpan[] = [];
  if (layout.pageChars?.length) {
    let offset = 0;
    for (const [index, raw] of layout.pageChars.entries()) {
      const count = Number(raw);
      if (!Number.isFinite(count) || count < 0) return null;
      spans.push({ index, start: offset, end: offset + count });
      offset += count;
    }
    return offset <= text.length ? spans : null;
  }
  let start = 0;
  for (let index = 0; ; index += 1) {
    const feed = text.indexOf("\f", start);
    const end = feed < 0 ? text.length : feed;
    spans.push({ index, start, end });
    if (feed < 0) break;
    start = feed + 1;
  }
  return spans;
}

/** Letters and digits only, case-folded: how titles and page text compare. */
export function normalizeForStructureMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** A numbering label before a title: a word glued to a number, or a number. */
const NUMBER_LABEL = /^\p{L}*\p{N}+$/u;

/**
 * A Roman-numeral label at the start of a raw line: one token of the
 * letters I V X L C D M, all upper or all lower case, alone or after one
 * word ("IV", "Part IV", "Book iii"). Tokens end at a space or a
 * punctuation mark, so a word that only begins with such letters is no label.
 */
const ROMAN_LABEL = /^(?:\p{L}+\s+)?([IVXLCDM]+|[ivxlcdm]+)(?![\p{L}\p{N}])/u;

/** A well-formed Roman numeral (standard subtractive grammar). */
const ROMAN_NUMERAL =
  /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

type PageLine = { text: string; start: number };

function pageLines(text: string, span: TextPageSpan): PageLine[] {
  const lines: PageLine[] = [];
  let offset = span.start;
  for (const raw of text.slice(span.start, span.end).split("\n")) {
    const lead = raw.length - raw.trimStart().length;
    if (raw.trim()) lines.push({ text: raw.trim(), start: offset + lead });
    offset += raw.length + 1;
  }
  return lines;
}

/** The length of the Roman-numeral label that opens a raw line, or 0. */
function romanLabelLength(line: string): number {
  const match = ROMAN_LABEL.exec(line);
  if (!match) return 0;
  const token = match[1];
  // A bare lowercase token is a word ("mix"); lowercase numerals need a word before them.
  if (token === token.toLowerCase() && match[0] === token) return 0;
  if (!ROMAN_NUMERAL.test(token.toUpperCase())) return 0;
  // A lone letter and a period ("M.", "C.") is an initial, not a label.
  if (token.length === 1 && line[match[0].length] === ".") return 0;
  return match[0].length;
}

/** A number label at the start of a raw line, alone or after one word: "4", "Chapter 4". */
const DIGIT_LABEL = /^(?:\p{L}+\s*)?\p{N}+(?!\p{N})/u;

/** The length of the numbering label, digits or Roman, that opens a raw line, or 0. */
function labelLength(line: string): number {
  return DIGIT_LABEL.exec(line)?.[0].length ?? romanLabelLength(line);
}

/** Whether a raw line is a numbering label with nothing else on it. */
function isLabelLine(line: string): boolean {
  const label = labelLength(line);
  return label > 0 && !normalizeForStructureMatch(line.slice(label));
}

/**
 * Whether raw line `line`, then the normalized text `rest` of the lines
 * after it, reads a numbering label and then exactly `core`.
 */
function readsLabelThenCore(line: string, rest: string, core: string): boolean {
  const label = labelLength(line);
  return (
    label > 0 && normalizeForStructureMatch(line.slice(label)) + rest === core
  );
}

/**
 * Whether the page opens with `title`, or with a numbering label and then
 * the title or the title less its own label: the label on the title's line
 * ("Part IV Manuscripts", "Chapter 4 Methods"), or a line of its own just
 * before it ("Part IV", then "MANUSCRIPTS"). Labels are read on the raw
 * line, so a body line before the title never counts as one.
 */
function opensWithTitle(
  lines: PageLine[],
  normalizedPage: string,
  title: string,
): boolean {
  const wanted = normalizeForStructureMatch(title);
  if (!wanted) return false;
  if (normalizedPage.startsWith(wanted)) return true;
  const label = lines.length ? labelLength(lines[0].text) : 0;
  if (!label) return false;
  const core = titleCore(title);
  const length = Math.max(wanted.length, core.length);
  let rest = normalizeForStructureMatch(lines[0].text.slice(label));
  for (let index = 1; index < lines.length && rest.length < length; index += 1)
    rest += normalizeForStructureMatch(lines[index].text);
  return rest.startsWith(wanted) || (Boolean(core) && rest.startsWith(core));
}

/**
 * A title less its leading numbering label: "Chapter 1 Introduction" →
 * "Introduction", "Part IV Manuscripts" → "Manuscripts". The title itself
 * when nothing follows its label.
 */
function titleCore(title: string): string {
  const trimmed = title.trim();
  const roman = romanLabelLength(trimmed);
  const core = roman
    ? normalizeForStructureMatch(trimmed.slice(roman))
    : normalizeForStructureMatch(trimmed).replace(/^\p{L}*\p{N}+/u, "");
  return core || normalizeForStructureMatch(trimmed);
}

/**
 * Whether whole lines at the page's start read exactly `core`, or whole
 * lines at its end read a numbering label and then `core`: a title printed
 * on its own lines, over one line or more (a textbook's chapter opener
 * prints the chapter's number and title last). At the end the label may be
 * on the title's first line or be the line just before it; a heading alone
 * at a page's foot, with no label, does not count.
 */
function linesReadCore(lines: PageLine[], core: string): boolean {
  if (!core) return false;
  const normalized = lines.map((line) => normalizeForStructureMatch(line.text));
  let fromStart = "";
  for (const line of normalized) {
    fromStart += line;
    if (fromStart === core) return true;
    if (fromStart.length >= core.length) break;
  }
  let fromEnd = "";
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (readsLabelThenCore(lines[index].text, fromEnd, core)) return true;
    fromEnd = normalized[index] + fromEnd;
    if (fromEnd === core)
      return index > 0 && isLabelLine(lines[index - 1].text);
    if (fromEnd.length >= core.length) break;
  }
  return false;
}

/** The first line on the page that carries `title`, a label allowed before it. */
function lineWithTitle(lines: PageLine[], title: string): PageLine | null {
  const wanted = normalizeForStructureMatch(title);
  if (!wanted) return null;
  for (const line of lines) {
    const normalized = normalizeForStructureMatch(line.text);
    if (normalized.startsWith(wanted)) return line;
    const at = normalized.indexOf(wanted);
    if (at > 0 && NUMBER_LABEL.test(normalized.slice(0, at))) return line;
  }
  return null;
}

type DraftSection = { title: string; level: number; charStart: number };

/**
 * Sections in document order with their ranges, sizes and pages. The text
 * before the first section becomes a section of its own; a section with no
 * text, subsections included, is left out.
 */
function finishSections(
  text: string,
  drafts: DraftSection[],
  pages: TextPageSpan[],
  pageOffset: number,
): DocumentStructureSection[] {
  const ordered: DraftSection[] = [];
  let floor = 0;
  for (const draft of drafts) {
    // A heading found before the one listed ahead of it starts with it.
    floor = Math.max(floor, draft.charStart);
    ordered.push({ ...draft, charStart: floor });
  }
  if (ordered.length && text.slice(0, ordered[0].charStart).trim())
    ordered.unshift({
      title: BEFORE_FIRST_SECTION_TITLE,
      level: 1,
      charStart: 0,
    });
  const withEnds = ordered.map((section, index) => {
    const ownCharEnd = ordered[index + 1]?.charStart ?? text.length;
    const next = ordered.findIndex(
      (other, at) => at > index && other.level <= section.level,
    );
    const charEnd = next < 0 ? text.length : ordered[next].charStart;
    return { ...section, ownCharEnd, charEnd };
  });
  const kept = withEnds.filter((section) =>
    text.slice(section.charStart, section.charEnd).trim(),
  );
  const pageAt = (offset: number) => {
    let found = pages[0];
    for (const page of pages) {
      if (page.start > offset) break;
      found = page;
    }
    return (found?.index ?? 0) + pageOffset;
  };
  const sections: DocumentStructureSection[] = [];
  const stack: number[] = [];
  for (const section of kept) {
    while (
      stack.length &&
      sections[stack[stack.length - 1]].level >= section.level
    )
      stack.pop();
    const parentIndex = stack.length ? stack[stack.length - 1] : undefined;
    sections.push({
      title: section.title,
      level: section.level,
      ...(parentIndex !== undefined ? { parentIndex } : {}),
      charStart: section.charStart,
      ownCharEnd: section.ownCharEnd,
      charEnd: section.charEnd,
      pageStart: pageAt(section.charStart),
      pageEnd: pageAt(Math.max(section.charStart, section.charEnd - 1)),
      chars: section.charEnd - section.charStart,
      ownChars: section.ownCharEnd - section.charStart,
      tokens: estimateTextTokens(
        text.slice(section.charStart, section.charEnd),
      ),
    });
    stack.push(sections.length - 1);
  }
  return sections;
}

/** Bookmarks whose title has text and whose page is in the PDF. */
function usableBookmarks(
  bookmarks: PdfOutlineEntry[],
  pageCount: number,
): PdfOutlineEntry[] {
  return bookmarks.filter(
    (entry) =>
      entry.title.trim() &&
      Number.isInteger(entry.pageIndex) &&
      entry.pageIndex >= 0 &&
      entry.pageIndex < pageCount,
  );
}

/**
 * Text pages lost at the front (blank pages Zotero trims) shift every
 * destination: the shift under which the most titles are on their page
 * (the first such shift on a tie), how many titles it puts there, and
 * whether no other shift puts as many there.
 */
function alignBookmarks(
  normalizedPages: string[],
  pageCount: number,
  entries: PdfOutlineEntry[],
): { pageOffset: number; score: number; unique: boolean } {
  const missing = pageCount - normalizedPages.length;
  let pageOffset = 0;
  let bestScore = -1;
  let unique = false;
  for (let shift = 0; shift <= missing; shift += 1) {
    let score = 0;
    for (const entry of entries) {
      const page = normalizedPages[entry.pageIndex - shift];
      const title = normalizeForStructureMatch(entry.title);
      if (page !== undefined && title && page.includes(title)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      pageOffset = shift;
      unique = true;
    } else if (score === bestScore) unique = false;
  }
  return { pageOffset, score: Math.max(0, bestScore), unique };
}

/**
 * The PDF page of the text's first page: 0 when the text has every page;
 * when it has fewer, the shift its bookmarks show (`alignBookmarks`), only
 * when that shift puts more titles on their page than any other. Null when
 * no shift can be shown: no bookmarks, none on its page, two shifts that
 * place equally many, or more text pages than the PDF has.
 */
export function textPageOffset(params: {
  text: string;
  layout?: PdfPageLayout;
  bookmarks?: PdfOutlineEntry[] | null;
}): number | null {
  const pages = splitPdfTextPages(params.text, params.layout);
  if (!pages?.length) return null;
  const pageCount = params.layout?.totalPages ?? pages.length;
  if (pageCount < pages.length) return null;
  if (pageCount === pages.length) return 0;
  const entries = usableBookmarks(params.bookmarks || [], pageCount);
  if (!entries.length) return null;
  const { pageOffset, score, unique } = alignBookmarks(
    pages.map((page) =>
      normalizeForStructureMatch(params.text.slice(page.start, page.end)),
    ),
    pageCount,
    entries,
  );
  return score > 0 && unique ? pageOffset : null;
}

function structureFromBookmarks(
  text: string,
  pages: TextPageSpan[],
  pageCount: number,
  bookmarks: PdfOutlineEntry[],
): DetectedDocumentStructure | null {
  const entries = usableBookmarks(bookmarks, pageCount);
  const normalizedPages = pages.map((page) =>
    normalizeForStructureMatch(text.slice(page.start, page.end)),
  );
  const { pageOffset } = alignBookmarks(normalizedPages, pageCount, entries);
  const located = entries.filter(
    (entry) =>
      entry.pageIndex - pageOffset >= 0 &&
      entry.pageIndex - pageOffset < pages.length,
  );
  // Destinations carry position when they name at least two heights; the
  // highest is where a page's text begins. All-/Fit bookmarks, or one shared
  // height, carry none, and only the title test is left.
  const tops = new Set(
    located.flatMap((entry) =>
      typeof entry.top === "number" && Number.isFinite(entry.top)
        ? [entry.top]
        : [],
    ),
  );
  const pageTop = tops.size >= 2 ? Math.max(...tops) : undefined;
  const linesOf = new Map<number, PageLine[]>();
  const linesOn = (page: TextPageSpan) => {
    let lines = linesOf.get(page.index);
    if (!lines) linesOf.set(page.index, (lines = pageLines(text, page)));
    return lines;
  };
  // Its title opens the page (a numbering label, digits or a Roman numeral,
  // allowed before it), or its title less that label is whole lines at the
  // page's start, or a label and then those lines at its end.
  const titleOpensPage = (entry: PdfOutlineEntry) => {
    const page = pages[entry.pageIndex - pageOffset];
    return (
      opensWithTitle(
        linesOn(page),
        normalizedPages[page.index] || "",
        entry.title,
      ) || linesReadCore(linesOn(page), titleCore(entry.title))
    );
  };
  const atPageTop = (entry: PdfOutlineEntry) =>
    pageTop !== undefined && entry.top === pageTop;
  // Chaptered only when every top-level entry starts its page, on at least
  // two pages: a paper fails on its first section that starts mid-page.
  const minDepth = Math.min(...located.map((entry) => entry.depth));
  const topLevel = located.filter((entry) => entry.depth === minDepth);
  if (new Set(topLevel.map((entry) => entry.pageIndex)).size < 2) return null;
  if (!topLevel.every((entry) => titleOpensPage(entry) || atPageTop(entry)))
    return null;
  const firstOnPage = new Set<PdfOutlineEntry>();
  const seenPages = new Set<number>();
  for (const entry of topLevel)
    if (!seenPages.has(entry.pageIndex)) {
      seenPages.add(entry.pageIndex);
      firstOnPage.add(entry);
    }
  // A top-level entry that starts its page owns it from the page start: by
  // its title, or, the first on its page, by its destination alone (a lower
  // line with its title is not where it starts). Any other starts at the
  // line that carries its title, or at the page when no line does.
  const drafts = bookmarkDrafts(
    located,
    (entry, page) => {
      const ownsPage =
        entry.depth === minDepth &&
        (titleOpensPage(entry) || (firstOnPage.has(entry) && atPageTop(entry)));
      const line = ownsPage ? null : lineWithTitle(linesOn(page), entry.title);
      return line ? line.start : page.start;
    },
    pages,
    pageOffset,
  );
  return {
    source: "bookmarks",
    sections: finishSections(text, drafts, pages, pageOffset),
    pageCount,
    pageOffset,
  };
}

/** Bookmarks as draft sections, depth to level by nesting, starts by `startOf`. */
function bookmarkDrafts(
  located: PdfOutlineEntry[],
  startOf: (entry: PdfOutlineEntry, page: TextPageSpan) => number,
  pages: TextPageSpan[],
  pageOffset: number,
): DraftSection[] {
  const drafts: DraftSection[] = [];
  const levelOf: number[] = [];
  for (const entry of located) {
    // Depth to level by nesting, so a skipped depth does not leave a gap.
    while (levelOf.length && levelOf[levelOf.length - 1] >= entry.depth)
      levelOf.pop();
    levelOf.push(entry.depth);
    drafts.push({
      title: entry.title,
      level: levelOf.length,
      charStart: startOf(entry, pages[entry.pageIndex - pageOffset]),
    });
  }
  return drafts;
}

/**
 * An unchaptered document's sections by its bookmarks alone: what its map
 * lists when its whole text does not fit. Each section starts at the line
 * that carries its title on its page, or at the page start when no line
 * does. Null without usable bookmarks: at least two top-level entries on
 * the text's pages, on at least two pages, in page order (and, when the
 * text lacks pages, placed by titles found on their pages).
 */
export function bookmarkSectionTree(params: {
  text: string;
  layout?: PdfPageLayout;
  bookmarks?: PdfOutlineEntry[] | null;
}): DetectedDocumentStructure | null {
  const pages = splitPdfTextPages(params.text, params.layout);
  if (!pages?.length) return null;
  const pageCount = params.layout?.totalPages ?? pages.length;
  if (pageCount < pages.length) return null;
  const entries = usableBookmarks(params.bookmarks || [], pageCount);
  const inPageOrder = entries.every(
    (entry, index) =>
      index === 0 || entry.pageIndex >= entries[index - 1].pageIndex,
  );
  if (!inPageOrder) return null;
  const { pageOffset, score } = alignBookmarks(
    pages.map((page) =>
      normalizeForStructureMatch(params.text.slice(page.start, page.end)),
    ),
    pageCount,
    entries,
  );
  // Text that lacks pages is placed only by titles found on their pages.
  if (pageCount > pages.length && !score) return null;
  const located = entries.filter(
    (entry) =>
      entry.pageIndex - pageOffset >= 0 &&
      entry.pageIndex - pageOffset < pages.length,
  );
  if (!located.length) return null;
  const minDepth = Math.min(...located.map((entry) => entry.depth));
  const topLevel = located.filter((entry) => entry.depth === minDepth);
  if (topLevel.length < 2) return null;
  if (new Set(topLevel.map((entry) => entry.pageIndex)).size < 2) return null;
  const drafts = bookmarkDrafts(
    located,
    (entry, page) =>
      lineWithTitle(pageLines(params.text, page), entry.title)?.start ??
      page.start,
    pages,
    pageOffset,
  );
  const sections = finishSections(params.text, drafts, pages, pageOffset);
  return sections.length
    ? { source: "bookmarks", sections, pageCount, pageOffset }
    : null;
}

/**
 * A chapter heading on a page's first line: any letters as its label, then
 * a number in the digits 0-9 (other digits fail the number check), then a title ("Chapter 4: Title", "Глава 4 Обзор",
 * "第4章 方法", "4 Title").
 */
const CHAPTER_LINE =
  /^(?:(\p{L}+)\s*)?(\p{Nd}+)(?![.,]?\p{Nd})\s*[:.]?\s*(\p{L}.*)$/u;
/** A numbered subsection heading at a line start: "4.2 Title", "4.2.1Title". */
const SUBSECTION_LINE = /^(\p{Nd}+(?:\.\p{Nd}+)+)\.?\s*(\p{L}.*)$/u;

/** A line's chapter label (case-folded) and number, when it reads as one. */
function chapterHeading(
  line: string,
): { label: string; number: number } | null {
  const match = CHAPTER_LINE.exec(line);
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) return null;
  return { label: (match[1] || "").toLocaleLowerCase(), number };
}

/** Whether `next` continues the numbering after `last` (1.2 → 1.3, 1.2.1, 2.1). */
function continuesNumbering(last: number[], next: number[]): boolean {
  if (next.length < 2 || next.length > last.length + 1) return false;
  for (let index = 0; index < next.length - 1; index += 1)
    if (next[index] !== last[index]) return false;
  return next[next.length - 1] === (last[next.length - 1] ?? 0) + 1;
}

function structureFromHeadings(
  text: string,
  pages: TextPageSpan[],
  pageCount: number,
): DetectedDocumentStructure | null {
  type Chapter = {
    page: number;
    label: string;
    number: number;
    line: PageLine;
  };
  const candidates: Chapter[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const first = pageLines(text, page)[0];
    const heading = first && chapterHeading(first.text);
    if (!heading) continue;
    const { label, number } = heading;
    // A running header repeats the chapter's heading: its first page counts.
    const key = `${label}:${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ page: page.index, label, number, line: first });
  }
  // The longest run of chapters numbered one after another, each on a
  // later page, with one label.
  const runs: Chapter[][] = [];
  for (const candidate of candidates) {
    let best: Chapter[] = [];
    for (const run of runs) {
      const tail = run[run.length - 1];
      if (
        tail.label === candidate.label &&
        tail.number + 1 === candidate.number &&
        tail.page < candidate.page &&
        run.length > best.length
      )
        best = run;
    }
    runs.push([...best, candidate]);
  }
  const chapters = runs.reduce<Chapter[]>(
    (longest, run) => (run.length > longest.length ? run : longest),
    [],
  );
  if (chapters.length < 2) return null;
  // Chapters open pages. When the same numbering goes on mid-page, just
  // before the first or just after the last, the run is numbered captions or
  // a paper's sections that happened to open pages.
  const runLabel = chapters[0].label;
  const before = chapters[0].number - 1;
  const after = chapters[chapters.length - 1].number + 1;
  for (const page of pages)
    for (const line of pageLines(text, page).slice(1)) {
      const heading = chapterHeading(line.text);
      if (
        heading?.label === runLabel &&
        (heading.number === before || heading.number === after)
      )
        return null;
    }
  // Running headers number every page; chapters span pages.
  if (
    chapters
      .slice(0, -1)
      .every((chapter, index) => chapters[index + 1].page - chapter.page === 1)
  )
    return null;
  const drafts: DraftSection[] = [];
  for (const [index, chapter] of chapters.entries()) {
    const start = pages[chapter.page].start;
    const end =
      index + 1 < chapters.length
        ? pages[chapters[index + 1].page].start
        : text.length;
    drafts.push({ title: chapter.line.text, level: 1, charStart: start });
    let last = [chapter.number];
    for (const page of pages) {
      if (page.start < start || page.start >= end) continue;
      for (const line of pageLines(text, page)) {
        if (line === chapter.line || line.start === chapter.line.start)
          continue;
        const match = SUBSECTION_LINE.exec(line.text);
        if (!match) continue;
        const numbers = match[1].split(".").map(Number);
        if (!continuesNumbering(last, numbers)) continue;
        last = numbers;
        drafts.push({
          title: line.text,
          level: numbers.length,
          charStart: line.start,
        });
      }
    }
  }
  return {
    source: "headings",
    sections: finishSections(text, drafts, pages, 0),
    pageCount,
    pageOffset: 0,
  };
}

/**
 * The structure of a chaptered plain-PDF text, or null for any other text.
 *
 * Bookmarks decide when they pass the quality check (more than one entry,
 * destinations in page order): the document is chaptered when every
 * top-level bookmark starts its page, on at least two pages. A bookmark
 * starts its page when its title begins the page's text (a numbering label
 * allowed before it), when its title less that label is whole lines at the
 * page's start or end, or when the destinations carry position (two
 * heights or more) and its own is the highest. A whole-page destination
 * alone never counts. Without usable
 * bookmarks, a chapter is a page whose first line is a numbered heading
 * ("Chapter 4: Title", "4 Title"), numbered one after another, with the
 * numbering not going on mid-page; numbered
 * subsections ("4.2", "4.2.1") inside it nest by their numbering, each one
 * continuing the last. A page split that does not match the PDF's page
 * count leaves the heading rule nothing to place, so it returns null.
 */
export function detectDocumentStructure(params: {
  text: string;
  layout?: PdfPageLayout;
  bookmarks?: PdfOutlineEntry[] | null;
}): DetectedDocumentStructure | null {
  const pages = splitPdfTextPages(params.text, params.layout);
  if (!pages?.length) return null;
  const pageCount = params.layout?.totalPages ?? pages.length;
  if (pageCount < pages.length) return null;
  const bookmarks = params.bookmarks || [];
  const inPageOrder = bookmarks.every(
    (entry, index) =>
      index === 0 || entry.pageIndex >= bookmarks[index - 1].pageIndex,
  );
  if (bookmarks.length > 1 && inPageOrder)
    return structureFromBookmarks(params.text, pages, pageCount, bookmarks);
  if (pageCount !== pages.length) return null;
  return structureFromHeadings(params.text, pages, pageCount);
}

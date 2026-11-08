/**
 * The whole pages web_read fetched in a run, kept until the run ends, so the
 * agent can go from a page's outline to its sections or read it all, piece by
 * piece, without fetching it again.
 */
import { looseWebUrlKey } from "./sourceLinks";
import type { WebPageOutlineEntry, WebSourceRecord } from "./types";

export type WebPageSection = WebPageOutlineEntry & {
  start: number;
  end: number;
};

export type StoredWebPage = {
  /** The page's record from the provider, without its text. */
  source: Omit<WebSourceRecord, "content">;
  text: string;
  /** The provider's page was longer than what is kept. */
  truncated: boolean;
  sections: WebPageSection[];
};

/** A page with no headings is split into parts of about this size. */
const PART_CHARS = 6_000;
/** Text before the first heading becomes its own section past this size. */
const LEAD_MIN_CHARS = 200;
/** Pages kept per run; the oldest is dropped past it. */
const MAX_PAGES_PER_RUN = 24;

const pagesByRun = new Map<string, Map<string, StoredWebPage>>();

function pageKey(url: string): string {
  return looseWebUrlKey(url) || url;
}

function cleanHeading(raw: string): string {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** Where a piece of text may end: a paragraph, else a line, else a sentence. */
function snapEnd(text: string, from: number, target: number): number {
  if (target >= text.length) return text.length;
  const floor = from + Math.floor((target - from) * 0.6);
  for (const breakText of ["\n\n", "\n", ". "]) {
    const at = text.lastIndexOf(breakText, target);
    if (at > floor) return at + breakText.length;
  }
  return target;
}

function skipSpace(text: string, at: number): number {
  while (at < text.length && /\s/.test(text[at])) at += 1;
  return at;
}

/**
 * The page's sections: one per Markdown heading, running to the next heading
 * of the same or a higher level (so a section holds its subsections), plus
 * the text before the first heading. A page without headings is split into
 * parts at paragraph breaks.
 */
export function buildWebPageSections(text: string): WebPageSection[] {
  const headings: { start: number; level: number; heading: string }[] = [];
  let offset = 0;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = inFence ? null : line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    const heading = match ? cleanHeading(match[2]) : "";
    if (match && heading) {
      headings.push({ start: offset, level: match[1].length, heading });
    }
    offset += line.length + 1;
  }
  const sections: WebPageSection[] = [];
  if (!headings.length) {
    let start = 0;
    let part = 0;
    while (start < text.length) {
      const end = snapEnd(text, start, start + PART_CHARS);
      part += 1;
      const firstLine = text.slice(start, end).trim().split("\n")[0] || "";
      sections.push({
        id: `p${part}`,
        heading: `Part ${part}: ${cleanHeading(firstLine).slice(0, 80)}`,
        level: 1,
        chars: end - start,
        start,
        end,
      });
      start = skipSpace(text, end);
    }
    return sections;
  }
  if (text.slice(0, headings[0].start).trim().length > LEAD_MIN_CHARS) {
    sections.push({
      id: "s0",
      heading: "(Start of page)",
      level: 1,
      chars: headings[0].start,
      start: 0,
      end: headings[0].start,
    });
  }
  headings.forEach((heading, index) => {
    const next = headings
      .slice(index + 1)
      .find((later) => later.level <= heading.level);
    const end = next ? next.start : text.length;
    sections.push({
      id: `s${index + 1}`,
      heading: heading.heading,
      level: heading.level,
      chars: end - heading.start,
      start: heading.start,
      end,
    });
  });
  return sections;
}

export function storeWebPage(
  runId: string,
  page: WebSourceRecord,
): StoredWebPage {
  const { content, ...source } = page;
  const text = content || "";
  const stored: StoredWebPage = {
    source,
    text,
    truncated: Boolean(page.truncated),
    sections: buildWebPageSections(text),
  };
  let pages = pagesByRun.get(runId);
  if (!pages) {
    pages = new Map();
    pagesByRun.set(runId, pages);
  }
  const key = pageKey(page.url);
  pages.delete(key);
  pages.set(key, stored);
  while (pages.size > MAX_PAGES_PER_RUN) {
    pages.delete(pages.keys().next().value as string);
  }
  return stored;
}

export function getStoredWebPage(
  runId: string,
  url: string,
): StoredWebPage | null {
  return pagesByRun.get(runId)?.get(pageKey(url)) || null;
}

export function clearWebPagesForRun(runId: string): void {
  pagesByRun.delete(runId);
}

export function webPageOutline(page: StoredWebPage): WebPageOutlineEntry[] {
  return page.sections.map(({ id, heading, level, chars }) => ({
    id,
    heading,
    level,
    chars,
  }));
}

export type WebPagePiece = {
  content: string;
  range: { start: number; end: number };
  /** Where the rest starts; absent when the page is read to its end. */
  nextOffset?: number;
};

/** Up to `maxChars` of the page from `offset`, ending at a natural break. */
export function readWebPageRange(
  page: StoredWebPage,
  offset: number,
  maxChars: number,
): WebPagePiece {
  const text = page.text;
  const start = skipSpace(text, Math.max(0, Math.min(offset, text.length)));
  const end = snapEnd(text, start, start + maxChars);
  const nextOffset = skipSpace(text, end);
  return {
    content: text.slice(start, end).trim(),
    range: { start, end },
    ...(nextOffset < text.length ? { nextOffset } : {}),
  };
}

/**
 * The chosen sections, in page order, up to `maxChars`. A section inside
 * another chosen one is read once. When they run past `maxChars`, the rest
 * can be read with a whole-page read from `nextOffset`.
 */
export function readWebPageSections(
  page: StoredWebPage,
  ids: readonly string[],
  maxChars: number,
): WebPagePiece & { sectionIds: string[]; unknownIds: string[] } {
  const byId = new Map(page.sections.map((section) => [section.id, section]));
  const unknownIds = ids.filter((id) => !byId.has(id));
  const chosen = ids
    .filter((id, index) => byId.has(id) && ids.indexOf(id) === index)
    .map((id) => byId.get(id)!)
    .sort((a, b) => a.start - b.start);
  const spans: { start: number; end: number }[] = [];
  for (const section of chosen) {
    const last = spans[spans.length - 1];
    if (last && section.start <= last.end) {
      last.end = Math.max(last.end, section.end);
    } else {
      spans.push({ start: section.start, end: section.end });
    }
  }
  const text = page.text;
  const parts: string[] = [];
  let used = 0;
  let nextOffset: number | undefined;
  let lastEnd = spans[0]?.start ?? 0;
  for (const span of spans) {
    const room = maxChars - used;
    if (room <= 0) {
      nextOffset = span.start;
      break;
    }
    let end = span.end;
    if (end - span.start > room) {
      end = snapEnd(text, span.start, span.start + room);
      nextOffset = skipSpace(text, end);
    }
    const part = text.slice(span.start, end).trim();
    if (part) parts.push(part);
    used += end - span.start;
    lastEnd = end;
    if (nextOffset !== undefined) break;
  }
  return {
    content: parts.join("\n\n[...]\n\n"),
    range: { start: spans[0]?.start ?? 0, end: lastEnd },
    ...(nextOffset !== undefined && nextOffset < text.length
      ? { nextOffset }
      : {}),
    sectionIds: chosen.map((section) => section.id),
    unknownIds,
  };
}

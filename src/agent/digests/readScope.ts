/**
 * What of a paper a reader reads: the one owner of the read scope.
 *
 * A digest part (`task_update`), `paper_digest` (MCP) and the digest worker
 * take a `ReadScope` per paper, so the user's own words decide what is read:
 * "only the abstracts", "the abstract and the results", "pages 3 to 5".
 * Without one a reader reads the whole text, as before scopes existed.
 *
 * This module holds the type and its pure rules, with no runtime imports, so
 * the ledger and the checkpoint types may name it. `readScopeText.ts` cuts a
 * paper's text to a scope; `readPaperScopeText` (paperRead.ts) reads it.
 */
import type { ReadObservationCapability } from "../context/readObservationTypes";

export const READ_SCOPE_SOURCES = [
  "metadata",
  "abstract",
  "sections",
  "pages",
  "full",
  "notes",
] as const;

export type ReadScopeSource = (typeof READ_SCOPE_SOURCES)[number];

/** A page range, 1-based and inclusive, as a user names pages. */
export type ReadScopePageRange = Readonly<{ from: number; to: number }>;

/**
 * What a reader reads of one paper. `sections` names sections for
 * `source:"sections"` ("abstract" resolves by the abstract rule:
 * the Zotero abstract field, else the PDF's abstract); `pages` names page
 * ranges for `source:"pages"`.
 */
export type ReadScope = Readonly<{
  source: ReadScopeSource;
  sections?: readonly string[];
  pages?: readonly ReadScopePageRange[];
}>;

export const FULL_READ_SCOPE: ReadScope = Object.freeze({ source: "full" });

/**
 * A read scope as a tool's input schema names it, kept small: it is sent
 * with every turn. Every object names its properties, because Gemini's
 * schema dialect turns an object with none into a string.
 * `parseReadScope` checks the rest (page ranges are `{from, to}`, 1-based).
 */
export const READ_SCOPE_JSON_SCHEMA = {
  type: "object",
  required: ["source"],
  properties: {
    source: { type: "string", enum: [...READ_SCOPE_SOURCES] },
    sections: { type: "array", items: { type: "string" } },
    pages: {
      type: "array",
      description: "PDF page numbers, not printed labels.",
      items: {
        type: "object",
        required: ["from", "to"],
        properties: {
          from: { type: "integer" },
          to: { type: "integer" },
        },
      },
    },
  },
} as const;

/** Per-paper read scopes as a tool's input schema names them. */
export const READ_SCOPE_OVERRIDES_JSON_SCHEMA = {
  type: "array",
  description: "A paper read otherwise: [{itemId, read}].",
  items: {
    type: "object",
    required: ["itemId", "read"],
    properties: {
      itemId: { type: "integer" },
      read: READ_SCOPE_JSON_SCHEMA,
    },
  },
} as const;

/** The most section names one scope may name. */
export const READ_SCOPE_MAX_SECTIONS = 12;
/** The most page ranges one scope may name. */
export const READ_SCOPE_MAX_PAGE_RANGES = 20;
const MAX_SECTION_NAME_CHARS = 80;

/** Where a scoped read's text came from, as its result names it. */
export const READ_SCOPE_TEXT_SOURCES = Object.freeze({
  zoteroAbstract: "Zotero abstract field",
  pdfAbstract: "PDF abstract",
  mineruSections: "MinerU sections",
  pdfSections: "PDF text sections",
  pdfPages: "PDF page text",
  zoteroNotes: "Zotero notes",
  zoteroRecord: "Zotero record",
  mineruText: "MinerU text",
  pdfText: "PDF text",
});

/** A paper's text cut to a scope, with what the cut covered. */
export type ScopedPaperText = {
  backend: "mineru" | "pdf" | "text";
  /** The text the reader gets, at most the reader's character limit. */
  text: string;
  /** The text the scope selected before the limit cut it. */
  totalCharacters: number;
  /**
   * What the text covers, as the result names it: "Abstract", a section
   * name, "pages 3–5", "notes", "metadata", "full text".
   */
  covered: string[];
  /** Requested sections or pages the paper has none of. */
  unmatched: string[];
  /** Exact bounds (MinerU headings, page text, Zotero fields) or not. */
  bounds: "exact" | "approximate";
  /** Every character the scope selected is in `text`. */
  complete: boolean;
  /** Where the text came from (`READ_SCOPE_TEXT_SOURCES`), joined by "; ". */
  source: string;
};

export type ReadScopeParse =
  | { ok: true; scope: ReadScope }
  | { ok: false; error: string };

function positiveInteger(value: unknown): number | null {
  const number =
    typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number > 0
    ? number
    : null;
}

/**
 * A tool's `read` argument as a scope, or why it is not one. Section names
 * are trimmed and kept once each (case-insensitive); page ranges are 1-based
 * and inclusive (`{from:3, to:5}`; a single page is `{from:3, to:3}`).
 * Fields another source does not use are dropped.
 */
export function parseReadScope(value: unknown, label: string): ReadScopeParse {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return {
      ok: false,
      error: `${label} must be an object such as {source:'abstract'}`,
    };
  const record = value as Record<string, unknown>;
  const source = record.source;
  if (
    typeof source !== "string" ||
    !READ_SCOPE_SOURCES.includes(source as ReadScopeSource)
  )
    return {
      ok: false,
      error: `${label}.source must be one of ${READ_SCOPE_SOURCES.join(", ")}`,
    };
  if (source === "sections") {
    const raw = Array.isArray(record.sections) ? record.sections : [];
    const seen = new Set<string>();
    const sections: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== "string") continue;
      const name = entry.replace(/\s+/g, " ").trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      sections.push(name.slice(0, MAX_SECTION_NAME_CHARS));
    }
    if (!sections.length)
      return {
        ok: false,
        error: `${label}.sections must name at least one section, e.g. ['abstract','results']`,
      };
    if (sections.length > READ_SCOPE_MAX_SECTIONS)
      return {
        ok: false,
        error: `${label}.sections names at most ${READ_SCOPE_MAX_SECTIONS} sections`,
      };
    return { ok: true, scope: { source, sections } };
  }
  if (source === "pages") {
    const raw = Array.isArray(record.pages) ? record.pages : [];
    const pages: ReadScopePageRange[] = [];
    for (const entry of raw) {
      const range =
        entry && typeof entry === "object"
          ? (entry as Record<string, unknown>)
          : { from: entry, to: entry };
      const from = positiveInteger(range.from);
      const to = positiveInteger(range.to ?? range.from);
      if (from === null || to === null || to < from)
        return {
          ok: false,
          error: `${label}.pages takes 1-based ranges such as {from:3, to:5}; got ${JSON.stringify(entry)}`,
        };
      pages.push({ from, to });
    }
    if (!pages.length)
      return {
        ok: false,
        error: `${label}.pages must name at least one page range, e.g. [{from:1, to:2}]`,
      };
    if (pages.length > READ_SCOPE_MAX_PAGE_RANGES)
      return {
        ok: false,
        error: `${label}.pages names at most ${READ_SCOPE_MAX_PAGE_RANGES} ranges`,
      };
    return { ok: true, scope: { source, pages } };
  }
  return { ok: true, scope: { source: source as ReadScopeSource } };
}

/** No scope, or the full text: what a reader read before scopes existed. */
export function isFullReadScope(scope?: ReadScope | null): boolean {
  return !scope || scope.source === "full";
}

/**
 * Whether a reader read every character of the paper's text: a complete
 * read of the full scope ("Full"). A read of named parts is never full,
 * however complete; a record saved before scopes reads as the full scope.
 */
export function isFullTextRead(source: {
  complete?: boolean;
  scope?: ReadScope | Readonly<{ source: string }> | null;
}): boolean {
  return (
    source.complete === true &&
    (!source.scope || source.scope.source === "full")
  );
}

/**
 * The scope's canonical identity, the same for the same scope however it
 * was written: "full" for no scope.
 */
export function readScopeKey(scope?: ReadScope | null): string {
  if (isFullReadScope(scope)) return "full";
  if (scope!.source === "sections")
    return `sections:${(scope!.sections || [])
      .map((name) => name.toLowerCase())
      .join("|")}`;
  if (scope!.source === "pages")
    return `pages:${(scope!.pages || [])
      .map((range) => `${range.from}-${range.to}`)
      .join(",")}`;
  return scope!.source;
}

/** A page range as a result names it: "3" or "3–5". */
export function pageRangeText(range: ReadScopePageRange): string {
  return range.from === range.to
    ? `${range.from}`
    : `${range.from}–${range.to}`;
}

/** The scope in a few words: "the abstract", "sections Abstract, Results". */
export function describeReadScope(scope?: ReadScope | null): string {
  if (isFullReadScope(scope)) return "the full text";
  switch (scope!.source) {
    case "abstract":
      return "the abstract";
    case "metadata":
      return "the Zotero record";
    case "notes":
      return "the Zotero notes";
    case "sections":
      return `sections ${(scope!.sections || []).join(", ")}`;
    case "pages":
      return `pages ${(scope!.pages || []).map(pageRangeText).join(", ")}`;
    default:
      return "the full text";
  }
}

/**
 * What a host-verified read of a scoped digest attests: the paper's body
 * when it read the full text (whole, or at least `bodyDepthChars` of it) or
 * named sections or pages, its abstract for an abstract, its record for
 * metadata or notes.
 */
export function digestReadCapabilities(
  source: {
    scope?: ReadScope;
    complete: boolean;
    readCharacters: number;
    covered?: readonly string[];
  },
  bodyDepthChars: number,
): ReadObservationCapability[] {
  const scope = source.scope;
  if (isFullReadScope(scope))
    return source.complete || source.readCharacters >= bodyDepthChars
      ? ["body"]
      : ["abstract"];
  switch (scope!.source) {
    case "abstract":
      return ["abstract"];
    case "metadata":
    case "notes":
      return ["metadata"];
    default: {
      // Named sections or pages are the paper's text; a scope that only
      // found the abstract read no more than that.
      const covered = source.covered || [];
      return covered.length &&
        covered.every((label) => /^\s*abstract\s*$/i.test(label))
        ? ["abstract"]
        : ["body"];
    }
  }
}

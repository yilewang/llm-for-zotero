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

/** What a read covered when an unheaded lead paragraph is the abstract. */
export const LEAD_ABSTRACT_LABEL = "Abstract (unlabelled lead)";
/** What a read covered when unheaded topic sections are the results. */
export const RESULTS_SPAN_LABEL = "Results (unlabelled sections)";
/** The covered labels a read finds by place, not by a heading. */
export const POSITIONAL_COVERED_LABELS: ReadonlySet<string> = new Set([
  LEAD_ABSTRACT_LABEL,
  RESULTS_SPAN_LABEL,
]);
const ABSTRACT_COVERED_LABELS: ReadonlySet<string> = new Set([
  "Abstract",
  LEAD_ABSTRACT_LABEL,
]);

/** Whether a covered label names the abstract (headed or the lead). */
export function isAbstractCoveredLabel(label: string): boolean {
  return ABSTRACT_COVERED_LABELS.has(label.trim());
}

/** Where a scoped read's text came from, as its result names it. */
export const READ_SCOPE_TEXT_SOURCES = Object.freeze({
  zoteroAbstract: "Zotero abstract field",
  pdfAbstract: "PDF abstract",
  /** An unheaded lead paragraph read as the abstract (approximate). */
  pdfAbstractLead: "PDF lead paragraph",
  mineruSections: "MinerU sections",
  /** Unheaded results sections found by their place (approximate). */
  mineruResultsSpan: "MinerU sections by position",
  pdfSections: "PDF text sections",
  pdfPages: "PDF page text",
  zoteroNotes: "Zotero notes",
  zoteroRecord: "Zotero record",
  mineruText: "MinerU text",
  pdfText: "PDF text",
});

/**
 * What a sections read tells the model of a named part the paper does not
 * have: the answer says so per paper, with why (what kind of paper it is);
 * no other part is presented as it, and what the paper offers instead is
 * used only when labelled so (the user's rules, 2026-10-31 and
 * 2026-11-01). A tool result carries it once, however many papers lack a
 * name; each paper carries only its own missing names and reason
 * (`ScopedPaperText.notFound`).
 */
export const SECTIONS_NOT_FOUND_RULE =
  "The read was limited to the named parts. For each paper that lacks one, say in the answer that it has no such part and why (what kind of paper it is); do not present any other part as that part. Use what the paper offers instead only when you label it as not the requested part.";

/**
 * Why a paper has none of a named part, as its reader judged it: what the
 * paper is ("a review article"), why it has no such part, and what it
 * offers instead, which is never the requested part.
 */
export type ScopedNotFound = Readonly<{
  kind?: string;
  reason?: string;
  offers?: string;
}>;

/**
 * The reader's judgment of a missing part, as a result names it after the
 * missing names: " (a review article: it reports no results of its own;
 * offers instead, not as the requested part: ...)", or "" without one.
 */
export function describeNotFound(notFound?: ScopedNotFound): string {
  if (!notFound) return "";
  const what = [notFound.kind, notFound.reason]
    .map((text) => (text || "").trim())
    .filter(Boolean)
    .join(": ");
  const offers = (notFound.offers || "").trim();
  const parts = [
    what,
    ...(offers ? [`offers instead, not as the requested part: ${offers}`] : []),
  ].filter(Boolean);
  return parts.length ? ` (${parts.join("; ")})` : "";
}

/**
 * One section a read covered, by the paper's own heading (`label`, in the
 * paper's language) and the requested name it was read for (`for`, as the
 * user wrote it). `kind` is set for the abstract, so its depth is known
 * whatever the heading says.
 */
export type CoveredPart = Readonly<{
  label: string;
  for?: string;
  kind?: "abstract";
}>;

/**
 * What a read covered, as its result names it: each heading once, with the
 * names it was read for when they differ from it ("结果与讨论 (for:
 * results)"). The abstract keeps its own label ("Abstract").
 */
export function renderCoveredParts(parts: readonly CoveredPart[]): string[] {
  const order: string[] = [];
  const names = new Map<string, string[]>();
  for (const part of parts) {
    const label = part.label.trim();
    if (!label) continue;
    if (!names.has(label)) {
      order.push(label);
      names.set(label, []);
    }
    const name = (part.for || "").trim();
    const list = names.get(label)!;
    if (
      part.kind !== "abstract" &&
      name &&
      name.toLowerCase() !== label.toLowerCase() &&
      !list.includes(name)
    )
      list.push(name);
  }
  return order.map((label) => {
    const list = names.get(label)!;
    return list.length ? `${label} (for: ${list.join(", ")})` : label;
  });
}

/** A covered name with the " (for: name, name)" suffix, which a clip may cut short. */
const COVERED_FOR = /^(.*?) \(for: (.*?)\)?$/s;

/**
 * The plain name a user reads for a covered label the model keeps for its
 * own use: the two positional labels ("Abstract (unlabelled lead)",
 * "Results (unlabelled sections)") are "Abstract" and "Results", and any
 * spelling of the abstract is "Abstract". Any other label stays as it is.
 * Display only: the model keeps the covered labels.
 */
export function shownPartName(label: string): string {
  const clean = label.trim();
  if (clean === LEAD_ABSTRACT_LABEL) return "Abstract";
  if (clean === RESULTS_SPAN_LABEL) return "Results";
  return clean.toLowerCase() === "abstract" ? "Abstract" : clean;
}

/** A name with its first letter upper-cased when that letter is Latin. */
function capitalizeLatin(name: string): string {
  return /^\p{Script=Latin}/u.test(name)
    ? name.charAt(0).toUpperCase() + name.slice(1)
    : name;
}

/** Names as the user reads them, each once, in the order first seen. */
function dedupeShown(
  entries: readonly { name: string; capitalize: boolean }[],
): string[] {
  const shown: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = shownPartName(
      entry.capitalize ? capitalizeLatin(entry.name.trim()) : entry.name,
    );
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    shown.push(name);
  }
  return shown;
}

/**
 * Requested part names ("results", "结果") as the user reads them: the first
 * Latin letter upper-cased, the abstract as "Abstract", each name once. A
 * name that contains ", " stays one name.
 */
export function userPartNames(names: readonly string[]): string[] {
  return dedupeShown(names.map((name) => ({ name, capitalize: true })));
}

/**
 * What a read of named parts shows the user: the names they asked for, not
 * the headings or places that were found for them. A covered name "X (for:
 * a, b)" becomes "a" and "b" (as the user wrote them, the first Latin
 * letter upper-cased), the abstract stays "Abstract", and a name without
 * the suffix ("Notes", "pages 3–5") stays. Each name appears once, in the
 * order it is first seen. Display only: the model keeps the covered names.
 */
export function requestedPartNames(covered: readonly string[]): string[] {
  const entries: { name: string; capitalize: boolean }[] = [];
  for (const token of covered) {
    const match = COVERED_FOR.exec(token.trim());
    if (!match) {
      entries.push({ name: token, capitalize: false });
      continue;
    }
    for (const name of match[2].split(", "))
      entries.push({ name, capitalize: true });
  }
  return dedupeShown(entries);
}

/**
 * A paper's named parts could not be chosen (the reader's call failed or
 * named nothing in the paper's outline). Nothing is read in their place:
 * the paper's read fails, and a digest may run it again.
 */
export class SectionPickError extends Error {
  /** The reader call's own error, when the call failed. */
  readonly readerError?: unknown;

  constructor(message: string, readerError?: unknown) {
    super(message);
    this.name = "SectionPickError";
    if (readerError !== undefined) this.readerError = readerError;
  }
}

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
  /**
   * The covered sections by heading and requested name, when a reader
   * picked them (`covered` is rendered from them).
   */
  coveredParts?: CoveredPart[];
  /** Why the paper has none of the `unmatched` parts, as its reader judged. */
  notFound?: ScopedNotFound;
  /** The paper's whole text length, when a reader picked the sections. */
  paperCharacters?: number;
  /** Exact bounds (MinerU headings, page text, Zotero fields) or not. */
  bounds: "exact" | "approximate";
  /**
   * Approximate only because a section was found by its place
   * (`POSITIONAL_COVERED_LABELS`); every other section's bounds are exact.
   */
  approximateByPosition?: boolean;
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
      return covered.length && covered.every(isAbstractCoveredLabel)
        ? ["abstract"]
        : ["body"];
    }
  }
}

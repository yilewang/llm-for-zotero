/**
 * A question's sources in groups, in Task progress: what is in the library
 * (the paper rows `view.ts` builds), what the scholarly search and the web
 * gave, each with why the agent went outside, and, when only the library
 * was searched, offers to search further. In each group the sources the
 * answer used come first; the rest fold away.
 *
 * The groups are a model built from the store (`buildTaskOutsideGroups`) and
 * rows built from it (`createTaskSourceRow`); the view places them in its
 * section cards and repaints them when the model changes.
 */
import type {
  TaskPaperCitation,
  TaskPaperLedgerEntry,
  TaskPaperReadEvent,
} from "../../../agent/context/taskPaperLedger";
import { t } from "../../../utils/i18n";
import { createWebFaviconImage } from "../webFavicon";
import { quoteTokenPattern } from "../../../services/quotes/quoteTokenIds";
import {
  indexAnswerCitations,
  iterateCitationRuns,
} from "../../../services/quotes/paragraphCitations";
import { closedSentenceBefore } from "../../../services/quotes/answerSentence";
import { foldAnswerWords } from "../answerQuoteHighlight";
import {
  isTaskAnswerCitationOf,
  type TaskAnswerCitation,
} from "./answerCitations";
import {
  bestTaskPaperReach,
  canOpenTaskPaperPassage,
  taskPaperReadReach,
  type TaskPaperReach,
} from "./passageSource";
import {
  answerSectionAt,
  quoteAroundOffset,
  sourceDoi,
  sourcePii,
  type TaskOutsideKind,
  type TaskOutsideQuote,
  type TaskOutsideRead,
  type TaskOutsideSource,
} from "./outside";
import type { TaskProgressRecord } from "./store";

/** "Open page" on a source: the side panel's page view, or the browser. */
export const TASK_PROGRESS_OPEN_SOURCE_EVENT = "llm-task-progress-open-source";
/** "Show in answer": scroll the chat to the source's marker and flash it. */
export const TASK_PROGRESS_SHOW_IN_ANSWER_EVENT =
  "llm-task-progress-show-in-answer";
/** "Search scholarly sources too" / "Search the web too". */
export const TASK_PROGRESS_OFFER_EVENT = "llm-task-progress-offer";

export type TaskProgressOpenSourceDetail = {
  turn: number;
  runId?: string;
  source: TaskOutsideSource;
  /** The exact words the answer took from it, to highlight in its text. */
  phrases?: string[];
};

export type TaskProgressShowInAnswerDetail = {
  runId?: string;
  key: string;
  /** A library paper's quote chip, when the row is a library paper. */
  itemId?: number;
  /** The quote's marker: the answer's source anchor. */
  anchor?: number;
  /** The quote's sentence, to light in the answer. */
  text?: string;
  /**
   * A cited passage: each of `texts` (the sentences that cite it) is lit
   * near the answer's mark holding the id, or its card when it has none.
   */
  citationId?: string;
  texts?: string[];
};

export type TaskProgressOfferDetail = {
  what: "scholarly" | "web";
};

/** One row of a group: a scholarly paper, a web page, or a library paper. */
export type TaskSourceRow = {
  key: string;
  /** Every source the row stands for: the same work found in several places. */
  keys: string[];
  kind: TaskOutsideKind | "library";
  title: string;
  /** The grey line under the title. */
  sub: string;
  url?: string;
  faviconUrl?: string;
  state: "found" | "skimmed" | "read";
  /** A sentence of the answer uses it. */
  cited: boolean;
  /** The earlier question that read it, for a row reused from there. */
  fromTurn?: number;
  reads: TaskOutsideRead[];
  /** A library paper's reads, for "Source". */
  libraryReads?: TaskPaperReadEvent[];
  quotes: TaskOutsideQuote[];
  /** The place the row opens: the one the agent read most of. */
  source?: TaskOutsideSource;
  library?: { libraryID: number; itemId: number; contextItemIds: number[] };
  /** A library paper's part of the question's answer, for its details. */
  answer?: TaskCitedModel;
};

/** A group's rows: those the answer used first, the rest folded. */
export type TaskSourceGroup = {
  used: TaskSourceRow[];
  unused: TaskSourceRow[];
};

export type TaskOutsideGroups = {
  turn: number;
  runId: string;
  scholarly: TaskSourceGroup;
  web: TaskSourceGroup;
  /** Library papers the answer cites from an earlier question's reading. */
  earlierLibrary: TaskSourceRow[];
  why: Partial<Record<TaskOutsideKind, string>>;
  /** Kinds searched that found nothing for this question. */
  empty: TaskOutsideKind[];
  /** Kinds the run searched. */
  searched: TaskOutsideKind[];
  librarySearched: boolean;
  /** The run searched somewhere: a group it did not search says so. */
  searchedAny: boolean;
  /** Only the library was searched: offer the scholarly search and the web. */
  offer: boolean;
  /** The answer's text, to find the library papers it names. */
  answer: string;
  /** Library papers listed from an earlier question's reading instead. */
  earlierLibraryKeys: Set<string>;
};

function sourceSub(source: TaskOutsideSource): string {
  return source.kind === "paper"
    ? source.organization
    : source.organization && source.organization !== source.hostname
      ? `${source.organization} · ${source.hostname}`
      : source.hostname;
}

/** A page's own title, without what the site put after it. */
export function cleanSourceTitle(title: string): string {
  const clean = title
    .replace(
      /\s+[-|–—]\s+(?:skip to (?:main )?content|customi[sz]e consent|cookie|accept all|sign in|log in|pubmed\b).*$/i,
      "",
    )
    .trim();
  return clean || title;
}

function sourceRow(
  source: TaskOutsideSource,
  extra: Partial<TaskSourceRow> = {},
): TaskSourceRow {
  return {
    key: source.key,
    keys: [source.key],
    kind: source.kind,
    title: cleanSourceTitle(source.title),
    sub: sourceSub(source),
    url: source.url,
    ...(source.faviconUrl ? { faviconUrl: source.faviconUrl } : {}),
    state: source.state,
    cited: source.cited,
    reads: source.reads,
    quotes: source.quotes,
    source,
    ...extra,
  };
}

/** The question before `turn` that found the source, newest first. */
export function findEarlierTaskSource(
  record: TaskProgressRecord,
  key: string,
  turn: number,
): { turn: number; source: TaskOutsideSource } | null {
  const turns = Object.keys(record.outside || {})
    .map(Number)
    .filter((entry) => entry < turn)
    .sort((a, b) => b - a);
  for (const entry of turns) {
    const found = record.outside![entry].sources.find(
      (source) => source.key === key,
    );
    if (found) return { turn: entry, source: found };
  }
  return null;
}

/** A source any question found or cited, the given question's first. */
export function findTaskSource(
  record: TaskProgressRecord | null,
  match: (source: TaskOutsideSource) => boolean,
  preferTurn?: number,
): { turn: number; runId: string; source: TaskOutsideSource } | null {
  if (!record?.outside) return null;
  const turns = Object.keys(record.outside)
    .map(Number)
    .sort((a, b) => (a === preferTurn ? -1 : b === preferTurn ? 1 : b - a));
  for (const turn of turns) {
    const entry = record.outside[turn];
    const found =
      entry.sources.find(match) || entry.earlier.find(match) || null;
    if (found) return { turn, runId: entry.runId, source: found };
  }
  return null;
}

function readable(reads: readonly TaskPaperReadEvent[]) {
  return reads.filter(
    (read) =>
      read.granularity !== "metadata" &&
      // A host digest is not the paper's text. A paper_read that stopped
      // short is a read of it, recorded with the same granularity.
      (read.granularity !== "digest" || Boolean(taskPaperReadReach(read))),
  );
}

/**
 * How far a paper_read went, as a reader sees it: "Full · 122/122 chunks"
 * when it reached the whole text, "Part · 30/32 chunks" when it stopped
 * short. "Full" alone when the read kept no tally.
 */
export function formatTaskPaperReach(reach: TaskPaperReach): string {
  const kind = t(reach.part ? "Part" : "Full");
  return reach.counts ? `${kind} · ${reach.counts}` : kind;
}

/**
 * Whether a read's words are only its heading: the words of its own label,
 * with or without the section's number ("# 2 Results" under "2 Results" or
 * "Results"). Such a read shows nothing the label does not.
 */
export function isTaskPaperHeadingOnlyRead(read: TaskPaperReadEvent): boolean {
  const words = (text: string) =>
    text
      .replace(/\[chunk \d+[^\]]*\]/g, " ")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .replace(/^\d+(?: \d+)* /, "");
  const shown = words(read.snippet || "");
  return shown !== "" && shown === words(read.label || "");
}

function plainQuote(text: string): string {
  return (
    text
      .replace(/\s*\[\[(?:cite|quote):[^\]]*\]\]/g, "")
      // A bare "link" adds no words, as the answer is searched.
      .replace(
        /[;,]?\s*\[(?:link|source|here|pdf|doi|\d{1,3})\]\([^)]*\)/gi,
        "",
      )
      .replace(/\s*\(\s*\)/g, "")
      .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
      // A heading's or a quoted line's marks, not a ">90%" in the words.
      .replace(/^\s*(?:>\s*)+/, "")
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/\s+#+\s*$/, "")
      .replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s+/, "")
      // Emphasis and code marks, not a word's own "_" (as in "J_ij").
      .replace(/\*+|`+/g, "")
      .replace(
        /(^|[^\p{L}\p{N}\\])_+(?=[\p{L}\p{N}])|(?<=[\p{L}\p{N}.!?,;:)])_+(?![\p{L}\p{N}{])/gu,
        "$1",
      )
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * For a question that read nothing of a paper: the latest earlier question
 * that did, and its reads (headings alone left out). Null when this question
 * read it, or no earlier one did.
 */
export function earlierTaskPaperReads(
  entry: Pick<TaskPaperLedgerEntry, "turns">,
  turn: number,
): { from: number; reads: TaskPaperReadEvent[] } | null {
  if (readable(entry.turns[turn]?.reads || []).length) return null;
  const from = Object.keys(entry.turns)
    .map(Number)
    .filter((entryTurn) => entryTurn > 0 && entryTurn < turn)
    .sort((a, b) => b - a)
    .find((entryTurn) => readable(entry.turns[entryTurn].reads).length);
  if (!from) return null;
  return {
    from,
    reads: readable(entry.turns[from].reads).filter(
      (read) => !isTaskPaperHeadingOnlyRead(read),
    ),
  };
}

/**
 * Library papers the question cites without reading them again: an earlier
 * question read them. Each with that question's number and reads.
 */
function earlierLibraryRows(
  record: TaskProgressRecord,
  turn: number,
  passageLabel: (read: TaskPaperReadEvent, title: string) => string,
  answer: string,
): TaskSourceRow[] {
  const rows: TaskSourceRow[] = [];
  for (const key of record.ledger.order) {
    const entry: TaskPaperLedgerEntry | undefined = record.ledger.papers[key];
    const own = entry?.turns[turn];
    if (!entry || !own) continue;
    // The answer's sentences that quote or name the paper.
    const quotes = findLibraryPaperInAnswer(
      answer,
      {
        creator: entry.creator || "",
        year: entry.year || "",
        title: entry.title || "",
      },
      own.citations
        .filter((citation) => citation.source !== "document")
        .map((citation) => citation.citationId),
    );
    if (!own.citations.length) continue;
    const earlier = earlierTaskPaperReads(entry, turn);
    if (!earlier) continue;
    const { from, reads } = earlier;
    const title = entry.title || `#${entry.itemId}`;
    const answerModel = buildTaskCitedModel({
      answerCitations: record.questions.find(
        (question) => question.turn === turn,
      )?.answerCitations,
      ledgerCitations: own.citations,
      questionCitationIds: questionCitationIds(record, turn),
      reads,
      answer,
      paper: {
        itemId: entry.itemId,
        contextItemIds: entry.contextItemIds,
        creator: entry.creator || "",
        year: entry.year || "",
        title,
      },
    });
    rows.push({
      key,
      keys: [key],
      kind: "library",
      title,
      sub: [entry.creator, entry.year].filter(Boolean).join(" "),
      state: "read",
      cited: true,
      fromTurn: from,
      reads: reads.map((read) => ({
        label: passageLabel(read, title),
        text: (read.snippet || "").replace(/\s+/g, " ").trim(),
      })),
      libraryReads: reads,
      quotes,
      library: {
        libraryID: entry.libraryID,
        itemId: entry.itemId,
        contextItemIds: entry.contextItemIds,
      },
      answer: answerModel,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// One work in several places
// ---------------------------------------------------------------------------

function foldText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * A title to compare works by: its first part around " - ", " | " or ": "
 * long enough to name a work (a site's name, or text after it, goes),
 * letters and digits only. Too short to tell works apart, it is empty.
 */
export function workTitleKey(title: string): string {
  for (const part of foldText(title).split(/\s+[-|–—:]\s+/)) {
    const key = part.replace(/[^\p{L}\p{N}]+/gu, "");
    if (key.length >= 24) return key;
  }
  return "";
}

function sameTitle(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const [short, long] =
    left.length < right.length ? [left, right] : [right, left];
  return short.length >= 40 && long.startsWith(short);
}

/** What a work is known by, from each place it was found. */
type WorkIds = { titles: string[]; dois: string[]; piis: string[] };

function workIds(row: TaskSourceRow): WorkIds {
  const doi =
    sourceDoi(row) ||
    sourceDoi({ url: row.source?.url, title: row.source?.title });
  const pii = sourcePii(row.url) || sourcePii(row.source?.url);
  const title = workTitleKey(row.title);
  return {
    titles: title ? [title] : [],
    dois: doi ? [doi] : [],
    piis: pii ? [pii] : [],
  };
}

/** One work: the same DOI, the same PII, or the same title. */
function sameWork(left: WorkIds, right: WorkIds): boolean {
  return (
    left.dois.some((doi) => right.dois.includes(doi)) ||
    left.piis.some((pii) => right.piis.includes(pii)) ||
    left.titles.some((title) =>
      right.titles.some((other) => sameTitle(title, other)),
    )
  );
}

function joinIds(into: WorkIds, from: WorkIds): void {
  for (const key of ["titles", "dois", "piis"] as const)
    for (const id of from[key]) if (!into[key].includes(id)) into[key].push(id);
}

function isPdfLink(url = ""): boolean {
  return /pdf/i.test(url.replace(/^https?:\/\/[^/]+/i, ""));
}

const STATE_RANK = { found: 0, skimmed: 1, read: 2 } as const;

/** Take `other` into `row`: one work, found in another place. */
function mergeRow(row: TaskSourceRow, other: TaskSourceRow): void {
  for (const key of other.keys) if (!row.keys.includes(key)) row.keys.push(key);
  for (const quote of other.quotes) {
    if (!row.quotes.some((known) => known.text === quote.text))
      row.quotes = [...row.quotes, quote];
  }
  row.cited = row.cited || other.cited;
  const better = STATE_RANK[other.state] > STATE_RANK[row.state];
  // A PDF often will not open in the panel, and its "title" is its first
  // line: read as far, a page of the work is the better place.
  const page =
    !better &&
    other.state === row.state &&
    isPdfLink(row.url) &&
    !isPdfLink(other.url);
  if (better || page) {
    row.state = other.state;
    // It opens where the agent read most of it.
    row.source = other.source;
    row.url = other.url;
    row.reads = other.reads;
  }
  if (page && row.kind === "web") {
    row.title = other.title;
    row.sub = other.sub;
    if (other.faviconUrl) row.faviconUrl = other.faviconUrl;
  }
  if (!row.faviconUrl && other.faviconUrl) row.faviconUrl = other.faviconUrl;
}

/**
 * The same work found in several places is one row: a web page that is a
 * scholarly paper's (the same DOI, in its link or title, or the same title)
 * joins the paper's row, and pages of one work (the same DOI, PII or title)
 * join the first of them.
 */
export function mergeSameWork(
  scholarly: readonly TaskSourceRow[],
  web: readonly TaskSourceRow[],
): { scholarly: TaskSourceRow[]; web: TaskSourceRow[] } {
  const papers = scholarly.map((row) => ({
    row: { ...row, keys: [...row.keys] },
    ids: workIds(row),
  }));
  const pages: { row: TaskSourceRow; ids: WorkIds }[] = [];
  for (const row of web) {
    const ids = workIds(row);
    const same =
      papers.find((entry) => sameWork(entry.ids, ids)) ||
      pages.find((entry) => sameWork(entry.ids, ids));
    if (same) {
      mergeRow(same.row, row);
      // What one place knows of the work, the others share.
      joinIds(same.ids, ids);
      continue;
    }
    pages.push({ row: { ...row, keys: [...row.keys] }, ids });
  }
  return {
    scholarly: papers.map((entry) => entry.row),
    web: pages.map((entry) => entry.row),
  };
}

function splitUsed(rows: readonly TaskSourceRow[]): TaskSourceGroup {
  return {
    used: rows.filter((row) => row.cited),
    unused: rows.filter((row) => !row.cited),
  };
}

/**
 * The question's groups, or null when its run left nothing to group (no
 * search, no outside source, no answer): the question then lists its papers
 * as it always did.
 */
export function buildTaskOutsideGroups(
  record: TaskProgressRecord | null,
  turn: number,
  options: {
    completed: boolean;
    passageLabel: (read: TaskPaperReadEvent, title: string) => string;
  },
): TaskOutsideGroups | null {
  const outside = record?.outside?.[turn];
  if (!record || !outside || !(turn > 0)) return null;
  const reused: TaskSourceRow[] = [];
  for (const cited of outside.earlier) {
    const found = findEarlierTaskSource(record, cited.key, turn);
    reused.push(
      found
        ? sourceRow(found.source, {
            cited: true,
            fromTurn: found.turn,
            quotes: cited.quotes,
          })
        : sourceRow(cited),
    );
  }
  const library = earlierLibraryRows(
    record,
    turn,
    options.passageLabel,
    outside.answer || "",
  );
  const own = (kind: TaskOutsideKind) =>
    outside.sources
      .filter((source) => source.kind === kind)
      .map((source) => sourceRow(source));
  const merged = mergeSameWork(
    [...reused.filter((row) => row.kind === "paper"), ...own("paper")],
    [...reused.filter((row) => row.kind === "web"), ...own("web")],
  );
  const empty = outside.searched.filter((kind) =>
    kind === "paper" ? !merged.scholarly.length : !merged.web.length,
  );
  const searchedAny =
    outside.librarySearched ||
    outside.searched.length > 0 ||
    outside.sources.length > 0 ||
    reused.length > 0;
  return {
    turn,
    runId: outside.runId,
    scholarly: splitUsed(merged.scholarly),
    web: splitUsed(merged.web),
    earlierLibrary: library,
    why: outside.why,
    empty,
    searched: outside.searched,
    librarySearched: outside.librarySearched,
    searchedAny,
    offer:
      options.completed &&
      outside.librarySearched &&
      !outside.searched.length &&
      !outside.sources.length &&
      !reused.length &&
      !library.length,
    answer: outside.answer || "",
    earlierLibraryKeys: new Set(library.map((row) => row.key)),
  };
}

// ---------------------------------------------------------------------------
// Library papers the answer names
// ---------------------------------------------------------------------------

/** A sentence's end: not after "et al." or a short abbreviation. */
const SENTENCE_BREAK =
  /(?<=[.!?。！？])(?<!\bet al\.)(?<!\b(?:e\.g|i\.e|vs|cf|Fig|fig|Eq|eq|No|no|ca)\.)\s+(?=[\p{Lu}*([“"])/u;

/** The answer's sentences and table rows, each as written, with its offset. */
function answerUnitsAt(answer: string): { text: string; at: number }[] {
  const units: { text: string; at: number }[] = [];
  let lineAt = 0;
  for (const line of answer.split("\n")) {
    const start = lineAt;
    lineAt += line.length + 1;
    if (!line.trim() || /^\s*\|?\s*:?-{3,}/.test(line)) continue;
    if (/^\s*\|/.test(line)) {
      units.push({ text: line, at: start });
      continue;
    }
    let from = 0;
    const breaks = new RegExp(SENTENCE_BREAK.source, "gu");
    let match: RegExpExecArray | null;
    while ((match = breaks.exec(line))) {
      units.push({ text: line.slice(from, match.index), at: start + from });
      from = match.index + match[0].length;
    }
    units.push({ text: line.slice(from), at: start + from });
  }
  return units.filter((unit) => unit.text);
}

/** A table row as words: its cells joined with " — ". */
function plainUnit(...units: string[]): string {
  const plain = units
    .map((unit) =>
      plainQuote(
        /^\s*\|/.test(unit)
          ? unit
              .replace(/^\s*\||\|\s*$/g, "")
              .split("|")
              .map((cell) => cell.trim())
              .filter(Boolean)
              .join(" — ")
          : unit,
      ),
    )
    .join(" ");
  return plain.length > 240 ? `${plain.slice(0, 239).trimEnd()}…` : plain;
}

/**
 * Every sentence or table row of the answer that names a library paper: its
 * first author's surname and, within a few words, its year (or, without a
 * year, the start of its title). In answer order, with each one's offset.
 */
function namedUnits(
  answer: string,
  paper: { creator: string; year: string; title: string },
): { text: string; at: number }[] {
  // Compared as written but for accents and apostrophes: a surname is
  // capitalised, a word like "long" or "Long-term" is not the paper.
  const plainCase = (text: string) =>
    text
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[‘’]/g, "'");
  const surname = plainCase(
    paper.creator.trim().split(/[\s,]+/)[0] || "",
  ).replace(/[^\p{L}'-]/gu, "");
  if (surname.length < 2 || !answer) return [];
  const year = (paper.year.match(/\d{4}/) || [""])[0];
  const titleStart = foldText(paper.title)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 30);
  const name = `(?<![\\p{L}])${surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}]|-\\p{L})`;
  const pattern = year ? new RegExp(`${name}[^\\n]{0,80}?${year}`, "u") : null;
  const named = new RegExp(name, "u");
  const units = answerUnitsAt(answer);
  // A citation standing alone after its sentence ("… stable. (Roth &
  // Merriam, 2023)") names the paper with the sentence before it.
  const found: { text: string; at: number }[] = [];
  for (const [index, unit] of units.entries()) {
    const cased = plainCase(unit.text);
    const hit =
      (pattern ? pattern.test(cased) : false) ||
      // Its surname with the start of its title, the year anywhere or not.
      (titleStart.length >= 20 &&
        foldText(unit.text)
          .replace(/[^\p{L}\p{N}]+/gu, " ")
          .includes(titleStart) &&
        named.test(cased));
    if (!hit) continue;
    const joined = index > 0 && citationOnly(unit.text);
    found.push({
      text: joined
        ? plainUnit(units[index - 1].text, unit.text)
        : plainUnit(unit.text),
      at: joined ? units[index - 1].at : unit.at,
    });
  }
  return found;
}

/**
 * Where the answer names a library paper: the first sentence or table row
 * with its first author's surname and, within a few words, its year (or,
 * without a year, the start of its title). Null when the answer does not.
 */
export function findNamedInAnswer(
  answer: string,
  paper: { creator: string; year: string; title: string },
): string | null {
  return namedUnits(answer, paper)[0]?.text ?? null;
}

/**
 * The answer's sentences that hold a quote card of the paper: a citation run
 * (`[[cite:A]]`, `[[cite:A,B]]`, adjacent runs) or a `[[quote:A]]` naming one
 * of `citationIds`, each with its offset. A run after a sentence's period
 * stands for that sentence, as the answer's mark does; a card on a line of
 * its own stands for the sentence before it.
 */
function citingUnits(
  answer: string,
  citationIds: readonly string[],
): { text: string; at: number }[] {
  const ids = new Set(citationIds);
  if (!answer || !ids.size) return [];
  const hits: { at: number; run: boolean }[] = [];
  for (const run of iterateCitationRuns(answer)) {
    if (run.ids.some((id) => ids.has(id)))
      hits.push({ at: run.start, run: true });
  }
  for (const match of answer.matchAll(quoteTokenPattern("quote"))) {
    if (ids.has(match[1])) hits.push({ at: match.index || 0, run: false });
  }
  hits.sort((left, right) => left.at - right.at);
  const found: { text: string; at: number }[] = [];
  for (const hit of hits) {
    const lineStart = answer.lastIndexOf("\n", hit.at - 1) + 1;
    const lineEnd = answer.indexOf("\n", hit.at);
    const line = answer.slice(lineStart, lineEnd < 0 ? answer.length : lineEnd);
    let at = hit.at;
    const closed = hit.run ? closedSentenceBefore(answer, at) : undefined;
    let text = /^\s*\|/.test(line)
      ? plainUnit(line)
      : plainUnit(
          closed
            ? quoteAroundOffset(answer.slice(0, closed.end), closed.start)
            : quoteAroundOffset(answer, at),
        );
    // A card on a line of its own stands for the sentence before it.
    const before = answer.slice(0, lineStart).trimEnd();
    if (!text && before) {
      at = before.length - 1;
      text = plainUnit(quoteAroundOffset(answer, at));
    }
    if (text) found.push({ text, at });
  }
  return found;
}

/**
 * Every sentence of the answer that uses a library paper: one holding a quote
 * card of the paper (`[[cite:ID]]`, also among other ids, or `[[quote:ID]]`,
 * ID one of `citationIds`) or one naming it. In answer order, each once, with
 * the answer's heading above it.
 */
export function findLibraryPaperInAnswer(
  answer: string,
  paper: { creator: string; year: string; title: string },
  citationIds: readonly string[],
): TaskOutsideQuote[] {
  if (!answer) return [];
  const found = [
    ...citingUnits(answer, citationIds),
    ...namedUnits(answer, paper),
  ];
  found.sort((left, right) => left.at - right.at);
  const quotes: TaskOutsideQuote[] = [];
  for (const entry of found) {
    if (quotes.some((known) => known.text === entry.text)) continue;
    const section = answerSectionAt(answer, entry.at);
    quotes.push({
      text: entry.text,
      anchor: -1,
      ...(section ? { section } : {}),
    });
  }
  return quotes;
}

// ---------------------------------------------------------------------------
// A library paper's part of an answer: "Cited", and the reads it did not cite
// ---------------------------------------------------------------------------

/**
 * One question's answer as a library paper's details show it: the paper's
 * passages it cites, the sentences that only name the paper, and the reads
 * that match none of the passages.
 */
export type TaskCitedModel = {
  cited: TaskAnswerCitation[];
  named: TaskOutsideQuote[];
  uncited: TaskPaperReadEvent[];
  /**
   * The paper_read that went furthest into the paper this question: shown
   * as one heading line, not among the uncited reads. Absent when the
   * question read the paper by other means.
   */
  reach?: { read: TaskPaperReadEvent; reach: TaskPaperReach };
  /** Reads past the ledger's cap, said under the uncited ones. */
  droppedReads: number;
};

/** Words as compared: folded, letters and digits only, one space between. */
function comparedWords(text: string): string {
  return foldAnswerWords(text.replace(/…/g, " "))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The same words, or one's inside the other's (not a few words alone). */
function sameWords(left: string, right: string): boolean {
  const a = comparedWords(left);
  const b = comparedWords(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return Math.min(a.length, b.length) >= 20 && (a.includes(b) || b.includes(a));
}

/**
 * Whether a read is one of the cited passages (best effort; a read and a
 * citation share no id): the same page of the paper's one attachment, or
 * the words of one inside the other's.
 */
export function isTaskReadCited(
  read: Pick<TaskPaperReadEvent, "snippet" | "pageIndex">,
  cited: ReadonlyArray<
    Pick<TaskAnswerCitation, "quote" | "pageIndex" | "contextItemId">
  >,
  paper: { contextItemIds?: readonly number[] } = {},
): boolean {
  const attachments = paper.contextItemIds || [];
  const words = comparedWords(read.snippet || "");
  return cited.some((citation) => {
    // A read records its page, not its attachment: a page names one place
    // only in a paper with one attachment (or the citation's own).
    if (
      read.pageIndex !== undefined &&
      read.pageIndex === citation.pageIndex &&
      (attachments.length <= 1 ||
        (citation.contextItemId !== undefined &&
          attachments[0] === citation.contextItemId))
    )
      return true;
    const quote = comparedWords(citation.quote || "");
    // A few words could sit in any passage.
    if (words.length < 20 || quote.length < 20) return false;
    return words.includes(quote) || quote.includes(words);
  });
}

/** Every answer citation one question's ledger holds, over its papers. */
export function questionCitationIds(
  record: TaskProgressRecord,
  turn: number,
): string[] {
  const ids = new Set<string>();
  for (const key of record.ledger.order) {
    for (const citation of record.ledger.papers[key]?.turns[turn]?.citations ||
      [])
      if (citation.source !== "document") ids.add(citation.citationId);
  }
  return [...ids];
}

/**
 * A record kept before answers listed their passages: the ledger's
 * citations of the paper, numbered (and their sentences found) in the
 * answer's text.
 */
function ledgerCitedPassages(
  citations: readonly TaskPaperCitation[],
  answer: string,
  questionIds: readonly string[],
  itemId: number,
): TaskAnswerCitation[] {
  const own = citations.filter((citation) => citation.source !== "document");
  if (!own.length) return [];
  const index = new Map(
    indexAnswerCitations(
      answer,
      new Set([...questionIds, ...own.map((citation) => citation.citationId)]),
    ).map((entry) => [entry.id, entry]),
  );
  const passages: TaskAnswerCitation[] = own.map((citation) => {
    const entry = index.get(citation.citationId);
    return {
      id: citation.citationId,
      ...(entry ? { number: entry.number } : {}),
      sentences: entry?.sentences || [],
      quote: citation.quote || "",
      ...(citation.pageLabel ? { pageLabel: citation.pageLabel } : {}),
      ...(citation.sectionLabel ? { section: citation.sectionLabel } : {}),
      itemId,
      ...(citation.contextItemId
        ? { contextItemId: citation.contextItemId }
        : {}),
      kind: entry ? "cite" : "quote",
    };
  });
  // Numbered first, in their numbers' order.
  const rank = (passage: TaskAnswerCitation) =>
    passage.number ?? Number.MAX_SAFE_INTEGER;
  return passages.sort((left, right) => rank(left) - rank(right));
}

/**
 * A library paper's part of one question's answer. The passages come from
 * the question's `answerCitations` (the ledger's citations on a record kept
 * before them); a sentence that names the paper, and holds none of its
 * passages, is listed on its own.
 */
export function buildTaskCitedModel(input: {
  answerCitations?: readonly TaskAnswerCitation[];
  ledgerCitations?: readonly TaskPaperCitation[];
  /** The question's answer citations over every paper, for the numbers. */
  questionCitationIds?: readonly string[];
  reads: readonly TaskPaperReadEvent[];
  droppedReads?: number;
  answer: string;
  paper: {
    itemId: number;
    contextItemIds?: readonly number[];
    creator: string;
    year: string;
    title: string;
  };
}): TaskCitedModel {
  const { paper, answer } = input;
  const cited = input.answerCitations
    ? input.answerCitations.filter((citation) =>
        isTaskAnswerCitationOf(citation, paper),
      )
    : ledgerCitedPassages(
        input.ledgerCitations || [],
        answer,
        input.questionCitationIds || [],
        paper.itemId,
      );
  // The sentences that hold one of its passages, or quote one, are not
  // "named" only.
  const citing = [
    ...cited.flatMap((citation) => [...citation.sentences, citation.quote]),
    ...citingUnits(
      answer,
      cited.map((citation) => citation.id),
    ).map((unit) => unit.text),
  ];
  const named: TaskOutsideQuote[] = [];
  for (const unit of namedUnits(answer, paper)) {
    if (citing.some((sentence) => sameWords(sentence, unit.text))) continue;
    if (named.some((known) => known.text === unit.text)) continue;
    const section = answerSectionAt(answer, unit.at);
    named.push({
      text: unit.text,
      anchor: -1,
      ...(section ? { section } : {}),
    });
  }
  const reach = bestTaskPaperReach(input.reads);
  return {
    cited,
    named,
    // A read of the paper as a whole is the heading's, however many there were.
    uncited: input.reads.filter(
      (read) =>
        !taskPaperReadReach(read) && !isTaskReadCited(read, cited, paper),
    ),
    ...(reach ? { reach } : {}),
    droppedReads: input.droppedReads || 0,
  };
}

/** Whether a paper's part of an answer has anything to list. */
export function hasTaskCitedContent(model: TaskCitedModel): boolean {
  return Boolean(
    model.cited.length ||
    model.named.length ||
    model.uncited.length ||
    model.reach ||
    model.droppedReads,
  );
}

/** A cited passage's label: "p. 7 · Results", either alone, or "Passage". */
export function formatTaskCitedLabel(
  passage: Pick<TaskAnswerCitation, "pageLabel" | "section">,
): string {
  const page = (passage.pageLabel || "").trim();
  const section = (passage.section || "").trim();
  return (
    [page ? t("p. {page}").replace("{page}", page) : "", section]
      .filter(Boolean)
      .join(" · ") || t("Passage")
  );
}

/** A unit that is only author-year citations, with no words of its own. */
function citationOnly(unit: string): boolean {
  if (/^\s*\|/.test(unit)) return false;
  const rest = plainQuote(unit)
    .replace(/\([^()]*\b(?:19|20)\d{2}[a-z]?\b[^()]*\)/g, " ")
    .replace(
      /[\p{Lu}][\p{L}'’.-]+(?:\s+(?:and|&)\s+[\p{Lu}][\p{L}'’.-]+)?(?:\s+et\s+al\.?)?,?\s*\(?(?:19|20)\d{2}[a-z]?\)?/gu,
      " ",
    );
  return !/\p{L}{2,}/u.test(rest);
}

/** A question's outside sources, for its counts. */
export function countTaskOutside(
  record: TaskProgressRecord | null,
  turn: number,
): { total: number; read: number; found: number; cited: number } {
  const outside = record?.outside?.[turn];
  const counts = { total: 0, read: 0, found: 0, cited: 0 };
  if (!outside) return counts;
  for (const source of outside.sources) {
    counts.total += 1;
    if (source.state === "found") counts.found += 1;
    else counts.read += 1;
    if (source.cited) counts.cited += 1;
  }
  counts.cited += outside.earlier.length;
  return counts;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** A chevron: pointing down (a row) or right (a section, a fold). */
export function createTaskChevron(
  doc: Document,
  className = "llm-task-paper-chevron",
  direction: "down" | "right" = "down",
): HTMLElement {
  const node = el(doc, "span", className);
  node.setAttribute("aria-hidden", "true");
  const icon = doc.createElementNS(SVG_NS, "svg");
  for (const [name, value] of Object.entries({
    width: direction === "down" ? "14" : "12",
    height: direction === "down" ? "14" : "12",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2.2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  }))
    icon.setAttribute(name, value);
  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute(
    "d",
    direction === "down" ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6",
  );
  icon.appendChild(path);
  node.appendChild(icon);
  return node;
}

/**
 * The row's site icon: the page's favicon, a page icon for a paper without
 * one (or a library paper), the globe for a web page without one.
 */
export function createTaskSourceIcon(
  doc: Document,
  kind: TaskSourceRow["kind"],
  faviconUrl?: string,
): HTMLElement {
  const icon = el(
    doc,
    "span",
    `llm-task-source-icon llm-task-source-icon-${kind}`,
  );
  icon.setAttribute("aria-hidden", "true");
  if (kind === "library") return icon;
  const image = createWebFaviconImage(
    doc,
    faviconUrl,
    "llm-task-source-favicon",
  );
  if (image) {
    icon.classList.add("llm-task-source-icon-has-favicon");
    image.addEventListener("error", () =>
      icon.classList.remove("llm-task-source-icon-has-favicon"),
    );
    icon.appendChild(image);
  }
  return icon;
}

export type TaskSourceRowContext = {
  doc: Document;
  expanded: boolean;
  highlighted: boolean;
  onToggle: () => void;
  onOpenPage: () => void;
  /** Light one of the answer's sentences that use the row. */
  onShowInAnswer: (quote: TaskOutsideQuote) => void;
  onGoToQuestion: (turn: number) => void;
  onOpenLibraryRead: (read: TaskPaperReadEvent) => void;
  onCopyLink: (url: string) => void;
  onOpenInBrowser: (url: string) => void;
  /** A library row's cited passage: open it in the paper. */
  onOpenCitedPassage?: (passage: TaskAnswerCitation, from: HTMLElement) => void;
  /** A library row's cited passage: light the sentences that cite it. */
  onShowPassage?: (passage: TaskAnswerCitation) => void;
  /** A library row's "Read, not cited" fold: open, and how to toggle it. */
  citedFoldOpen?: boolean;
  onToggleCitedFold?: () => void;
};

function linkButton(
  doc: Document,
  label: string,
  run: () => void,
  className = "llm-task-paper-open",
): HTMLButtonElement {
  const button = el(doc, "button", className, label);
  button.type = "button";
  button.addEventListener("click", (event: Event) => {
    event.preventDefault?.();
    event.stopPropagation?.();
    run();
  });
  return button;
}

/**
 * One piece of an open row, the same in every kind of row: its label at the
 * left, its link at the right ("Show in answer", "Source"), and its words in
 * a soft box under them.
 */
function createTaskDetailBlock(
  doc: Document,
  label: string,
  text: string,
  button?: HTMLButtonElement,
): HTMLElement {
  const item = el(doc, "div", "llm-task-paper-read");
  const head = el(doc, "div", "llm-task-paper-read-head");
  head.append(el(doc, "div", "llm-task-paper-how", label));
  if (button) head.append(button);
  item.append(head);
  if (text) item.append(el(doc, "blockquote", "llm-task-paper-snippet", text));
  return item;
}

/** "Show in answer": light the answer's sentence that uses the source. */
function createTaskShowInAnswerLink(
  doc: Document,
  run: () => void,
): HTMLButtonElement {
  return linkButton(doc, t("Show in answer"), run, "llm-task-source-link");
}

/**
 * Where the answer uses a source: each sentence as a block, labelled with the
 * answer's part it sits in, with its own "Show in answer".
 */
export function createTaskAnswerQuotes(
  doc: Document,
  quotes: readonly TaskOutsideQuote[],
  onShow: (quote: TaskOutsideQuote) => void,
): HTMLElement {
  const block = el(doc, "div", "llm-task-source-in-answer");
  for (const quote of quotes) {
    const item = createTaskDetailBlock(
      doc,
      quote.section
        ? `${t("In the answer")} · ${quote.section}`
        : t("In the answer"),
      `“${quote.text}”`,
      createTaskShowInAnswerLink(doc, () => onShow(quote)),
    );
    item.classList.add("llm-task-source-quote");
    block.append(item);
  }
  return block;
}

/** What a library paper's "Cited" list does when its links are used. */
export type TaskCitedHandlers = {
  /** A read's label and words, as its list shows them. */
  readLabel: (read: TaskPaperReadEvent) => string;
  readText: (read: TaskPaperReadEvent) => string;
  /** "Source" on a cited passage or a read: open it in the paper. */
  onOpenPassage: (passage: TaskAnswerCitation, from: HTMLElement) => void;
  onOpenRead: (read: TaskPaperReadEvent, from: HTMLElement) => void;
  /** "Show in answer" on a cited passage, or on a sentence naming the paper. */
  onShowPassage: (passage: TaskAnswerCitation) => void;
  onShowNamed: (quote: TaskOutsideQuote) => void;
  /** "Read, not cited": open, and how to toggle it. */
  foldOpen: boolean;
  onToggleFold: () => void;
};

/** "Source": open the passage in the paper; a busy button does nothing. */
function sourceButton(doc: Document, run: (from: HTMLElement) => void) {
  const button = el(doc, "button", "llm-task-paper-open", t("Source"));
  button.type = "button";
  button.title = t("Open this passage in the paper");
  button.setAttribute("aria-label", t("Open this passage in the paper"));
  button.addEventListener("click", (event: Event) => {
    event.preventDefault?.();
    event.stopPropagation?.();
    if (button.disabled) return;
    run(button);
  });
  return button;
}

/**
 * One block of the list: its label (with the passage's number) and "Source"
 * above the passage at the right, the passage in a soft box, and "Show in
 * answer" under the box at the right.
 */
function createTaskCitedBlock(
  doc: Document,
  options: {
    number?: number;
    label: string;
    text: string;
    source?: HTMLButtonElement;
    onShow?: () => void;
    named?: boolean;
  },
): HTMLElement {
  const item = el(doc, "div", "llm-task-paper-read llm-task-cited-item");
  if (options.named) item.classList.add("llm-task-cited-named");
  const head = el(doc, "div", "llm-task-paper-read-head");
  const how = el(doc, "div", "llm-task-paper-how");
  if (options.number !== undefined)
    how.append(
      el(doc, "span", "llm-task-cited-number", String(options.number)),
      el(doc, "span", "", options.label),
    );
  else how.textContent = options.label;
  head.append(how);
  if (options.source) head.append(options.source);
  item.append(head);
  if (options.text)
    item.append(el(doc, "blockquote", "llm-task-paper-snippet", options.text));
  if (options.onShow) {
    const foot = el(doc, "div", "llm-task-cited-foot");
    foot.append(createTaskShowInAnswerLink(doc, options.onShow));
    item.append(foot);
  }
  return item;
}

/**
 * How far a paper_read went, as one line over a paper's Cited list: its
 * words at the left and "Source" at the right, as a block's head has them.
 * It is a heading, not a cited passage, so it has no text box beneath it.
 */
function createTaskReachHeading(
  doc: Document,
  label: string,
  source?: HTMLButtonElement,
): HTMLElement {
  const item = el(doc, "div", "llm-task-paper-read llm-task-reach");
  const head = el(doc, "div", "llm-task-paper-read-head");
  head.append(el(doc, "div", "llm-task-paper-how", label));
  if (source) head.append(source);
  item.append(head);
  return item;
}

/**
 * "Read, not cited (n)": the fold line the unused rows have, folding the
 * reads no cited passage matches, and the line for reads past the cap.
 */
function createTaskCitedFold(
  doc: Document,
  model: TaskCitedModel,
  handlers: TaskCitedHandlers,
): HTMLElement {
  const wrap = el(doc, "div", "llm-task-cited-fold");
  const button = el(doc, "button", "llm-task-fold");
  button.type = "button";
  button.setAttribute("aria-expanded", handlers.foldOpen ? "true" : "false");
  const line = el(doc, "span", "llm-task-fold-line");
  line.append(
    createTaskChevron(doc, "llm-task-fold-chevron", "right"),
    el(
      doc,
      "span",
      "llm-task-fold-text",
      t("Read, not cited ({count})").replace(
        "{count}",
        String(model.uncited.length),
      ),
    ),
  );
  button.append(line);
  const body = el(doc, "div", "llm-task-cited-fold-body");
  body.hidden = !handlers.foldOpen;
  for (const read of model.uncited) {
    body.append(
      createTaskCitedBlock(doc, {
        label: handlers.readLabel(read),
        text: handlers.readText(read),
        ...(canOpenTaskPaperPassage(read)
          ? {
              source: sourceButton(doc, (from) =>
                handlers.onOpenRead(read, from),
              ),
            }
          : {}),
      }),
    );
  }
  if (model.droppedReads)
    body.append(
      el(
        doc,
        "div",
        "llm-task-paper-empty",
        t("and {count} more reads").replace(
          "{count}",
          String(model.droppedReads),
        ),
      ),
    );
  button.addEventListener("click", (event: Event) => {
    event.preventDefault?.();
    event.stopPropagation?.();
    // Shown at once; the owner keeps the state for its next paint.
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", open ? "true" : "false");
    body.hidden = !open;
    handlers.onToggleFold();
  });
  wrap.append(button, body);
  return wrap;
}

/**
 * A library paper's part of one question's answer: "Cited", one block per
 * passage the answer cites (its number as the answer's mark shows it) and
 * per sentence that only names the paper, then the reads it did not cite,
 * folded. Nothing when there is nothing to list. Without `heading` the
 * "Cited" line is left out, for a card whose own header already says it.
 */
export function createTaskCitedBlocks(
  doc: Document,
  model: TaskCitedModel,
  handlers: TaskCitedHandlers,
  options: { heading?: boolean } = {},
): HTMLElement[] {
  const children: HTMLElement[] = [];
  // How far the agent read the paper, above what the answer cites of it.
  if (model.reach) {
    const read = model.reach.read;
    children.push(
      createTaskReachHeading(
        doc,
        handlers.readLabel(read),
        canOpenTaskPaperPassage(read)
          ? sourceButton(doc, (from) => handlers.onOpenRead(read, from))
          : undefined,
      ),
    );
  }
  if (options.heading !== false && (model.cited.length || model.named.length))
    children.push(el(doc, "div", "llm-task-paper-turn", t("Cited")));
  for (const passage of model.cited) {
    children.push(
      createTaskCitedBlock(doc, {
        ...(passage.number !== undefined ? { number: passage.number } : {}),
        label: formatTaskCitedLabel(passage),
        text: passage.quote,
        source: sourceButton(doc, (from) =>
          handlers.onOpenPassage(passage, from),
        ),
        onShow: () => handlers.onShowPassage(passage),
      }),
    );
  }
  for (const quote of model.named) {
    children.push(
      createTaskCitedBlock(doc, {
        label: t("Named in the answer, no passage"),
        text: quote.text,
        named: true,
        onShow: () => handlers.onShowNamed(quote),
      }),
    );
  }
  if (model.uncited.length)
    children.push(createTaskCitedFold(doc, model, handlers));
  else if (model.droppedReads)
    children.push(
      el(
        doc,
        "div",
        "llm-task-paper-empty",
        t("and {count} more reads").replace(
          "{count}",
          String(model.droppedReads),
        ),
      ),
    );
  return children;
}

/**
 * "Read while answering Question N", with "Go to Question N": where a paper
 * this question cites without reading it again was read.
 */
export function createTaskReadEarlierBlock(
  doc: Document,
  turn: number,
  onGoToQuestion: () => void,
): HTMLElement {
  const number = String(turn);
  return createTaskDetailBlock(
    doc,
    t("Read while answering Question {number}").replace("{number}", number),
    "",
    linkButton(
      doc,
      t("Go to Question {number}").replace("{number}", number),
      onGoToQuestion,
    ),
  );
}

/**
 * A library paper reused from an earlier question: where it was read, then
 * this question's "Cited" list, with the earlier reads it did not cite
 * folded.
 */
function libraryRowDetails(
  row: TaskSourceRow,
  context: TaskSourceRowContext,
): HTMLElement[] {
  const { doc } = context;
  const children: HTMLElement[] = [];
  if (row.fromTurn) {
    const from = row.fromTurn;
    children.push(
      createTaskReadEarlierBlock(doc, from, () => context.onGoToQuestion(from)),
    );
  }
  const reach = bestTaskPaperReach(row.libraryReads || []);
  const model: TaskCitedModel = row.answer || {
    cited: [],
    named: row.quotes,
    uncited: (row.libraryReads || []).filter(
      (read) => !taskPaperReadReach(read),
    ),
    ...(reach ? { reach } : {}),
    droppedReads: 0,
  };
  const labels = new Map(
    (row.libraryReads || []).map((read, index) => [
      read,
      row.reads[index]?.label || "",
    ]),
  );
  children.push(
    ...createTaskCitedBlocks(doc, model, {
      readLabel: (read) => t(labels.get(read) || ""),
      readText: (read) => (read.snippet || "").replace(/\s+/g, " ").trim(),
      onOpenPassage: (passage, from) =>
        context.onOpenCitedPassage?.(passage, from),
      onOpenRead: (read) => context.onOpenLibraryRead(read),
      onShowPassage: (passage) => context.onShowPassage?.(passage),
      onShowNamed: (quote) => context.onShowInAnswer(quote),
      foldOpen: Boolean(context.citedFoldOpen),
      onToggleFold: () => context.onToggleCitedFold?.(),
    }),
  );
  return children;
}

/**
 * A web page or scholarly paper opened: where the answer uses it, then its
 * page.
 */
function outsideRowDetails(
  row: TaskSourceRow,
  context: TaskSourceRowContext,
): HTMLElement[] {
  const { doc } = context;
  const children: HTMLElement[] = [
    createTaskAnswerQuotes(doc, row.quotes, context.onShowInAnswer),
  ];
  if (row.url)
    children.push(
      linkButton(
        doc,
        t("Open page"),
        context.onOpenPage,
        "llm-task-source-link llm-task-source-open",
      ),
    );
  return children;
}

/** Whether the row unrolls: a web or scholarly row only to its quotes. */
export function taskSourceRowOpens(row: TaskSourceRow): boolean {
  return row.kind === "library" || row.quotes.length > 0;
}

/**
 * One source row: its sign (a check once opened), its site icon, its title
 * over a grey line, "Cited" when the answer uses it, and a fixed slot for
 * the state word that hovering swaps for copy and open-in-browser, so
 * nothing overlaps. A web or scholarly row the answer does not quote opens
 * its page on a click.
 */
export function createTaskSourceRow(
  row: TaskSourceRow,
  context: TaskSourceRowContext,
): HTMLElement {
  const { doc } = context;
  const opens = taskSourceRowOpens(row);
  const li = el(doc, "li", "llm-task-paper llm-task-source");
  li.dataset.key = row.key;
  li.dataset.kind = row.kind;
  // The sign's check says the agent opened it; being used is the tag.
  li.dataset.state = row.state === "found" ? "matched" : row.state;
  li.setAttribute("role", "listitem");
  if (context.highlighted) li.classList.add("llm-task-source-highlighted");
  const summary = el(doc, "button", "llm-task-paper-summary");
  summary.type = "button";
  if (opens)
    summary.setAttribute("aria-expanded", context.expanded ? "true" : "false");
  const grid = el(doc, "span", "llm-task-paper-grid");
  const dot = el(doc, "span", "llm-task-paper-dot");
  dot.setAttribute("aria-hidden", "true");
  const name = el(doc, "span", "llm-task-paper-name");
  const title = el(doc, "span", "llm-task-paper-title", row.title);
  title.title = row.title;
  const cite = el(doc, "span", "llm-task-paper-cite", t("Cited"));
  cite.hidden = !row.cited;
  name.append(createTaskSourceIcon(doc, row.kind, row.faviconUrl), title, cite);
  const tail = el(
    doc,
    "span",
    "llm-task-paper-tail",
    row.state === "found"
      ? t("found")
      : row.state === "skimmed"
        ? t("skimmed")
        : "",
  );
  const meta = el(doc, "span", "llm-task-paper-meta");
  const sub = row.fromTurn
    ? [
        t("From Question {number}").replace("{number}", String(row.fromTurn)),
        row.sub,
      ]
        .filter(Boolean)
        .join(" · ")
    : row.sub;
  meta.append(el(doc, "span", "llm-task-paper-meta-text", sub));
  const chevron = opens
    ? createTaskChevron(doc)
    : el(doc, "span", "llm-task-paper-chevron");
  grid.append(dot, name, tail, chevron, meta);
  summary.append(grid);
  summary.setAttribute(
    "aria-label",
    [
      row.title,
      row.cited ? t("Cited") : "",
      tail.textContent,
      opens ? "" : t("Open page"),
    ]
      .filter(Boolean)
      .join(", "),
  );
  summary.addEventListener("click", (event: Event) => {
    event.preventDefault?.();
    if (opens) context.onToggle();
    else if (row.url) context.onOpenPage();
  });
  li.append(summary);
  if (row.url) {
    const url = row.url;
    const actions = el(doc, "span", "llm-task-source-actions");
    const action = (name: string, label: string, run: () => void) => {
      const button = el(
        doc,
        "button",
        `llm-task-source-action llm-task-source-action-${name}`,
      );
      button.type = "button";
      button.tabIndex = -1;
      button.title = label;
      button.setAttribute("aria-label", label);
      button.addEventListener("click", (event: Event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        run();
      });
      return button;
    };
    actions.append(
      action("copy", t("Copy link"), () => context.onCopyLink(url)),
      action("browser", t("Open in default browser"), () =>
        context.onOpenInBrowser(url),
      ),
    );
    li.classList.add("llm-task-source-has-actions");
    li.append(actions);
  }
  if (opens && context.expanded) {
    const details = el(doc, "div", "llm-task-paper-details");
    details.append(
      ...(row.kind === "library"
        ? libraryRowDetails(row, context)
        : outsideRowDetails(row, context)),
    );
    li.append(details);
  }
  return li;
}

/** A section card's parts: its header button and its body. */
export type TaskCardRefs = {
  root: HTMLElement;
  head: HTMLButtonElement;
  title: HTMLElement;
  counts: HTMLElement;
  body: HTMLElement;
};

/**
 * One section of a question as a soft card: a header button (chevron, name,
 * counts at the right) that folds its body.
 */
export function createTaskCard(doc: Document, key: string): TaskCardRefs {
  const root = el(doc, "section", "llm-task-card");
  root.dataset.card = key;
  const head = el(doc, "button", "llm-task-card-head");
  head.type = "button";
  const title = el(doc, "span", "llm-task-card-title");
  const counts = el(doc, "span", "llm-task-card-counts");
  // Gecko lays a button's children out in an anonymous block: the row is an
  // inner span.
  const line = el(doc, "span", "llm-task-card-line");
  line.append(
    createTaskChevron(doc, "llm-task-card-chevron", "right"),
    title,
    counts,
  );
  head.append(line);
  const body = el(doc, "div", "llm-task-card-body");
  root.append(head, body);
  return { root, head, title, counts, body };
}

/** Set a card's header: its name, counts, and whether it is open or can open. */
export function patchTaskCard(
  card: TaskCardRefs,
  options: { title: string; counts: string; open: boolean; empty: boolean },
): void {
  if (card.title.textContent !== options.title)
    card.title.textContent = options.title;
  if (card.counts.textContent !== options.counts)
    card.counts.textContent = options.counts;
  const open = options.open && !options.empty;
  const expanded = options.empty ? null : open ? "true" : "false";
  if (card.head.getAttribute("aria-expanded") !== expanded) {
    if (expanded === null) card.head.removeAttribute("aria-expanded");
    else card.head.setAttribute("aria-expanded", expanded);
  }
  if (card.head.disabled !== options.empty) card.head.disabled = options.empty;
  if (card.body.hidden !== !open) card.body.hidden = !open;
  card.root.classList.toggle("llm-task-card-empty", options.empty);
}

/** A group's counts: "3 used · 12 not used", "none used · 5 found". */
export function formatTaskGroupCounts(used: number, unused: number): string {
  if (used)
    return unused
      ? t("{used} used · {unused} not used")
          .replace("{used}", String(used))
          .replace("{unused}", String(unused))
      : t("{used} used").replace("{used}", String(used));
  return t("none used · {found} found").replace("{found}", String(unused));
}

/** The one line the rows the answer did not use fold into. */
export function createTaskUnusedFold(
  doc: Document,
  options: { used: number; unused: number; open: boolean },
  onToggle: () => void,
): HTMLButtonElement {
  const button = el(doc, "button", "llm-task-fold");
  button.type = "button";
  button.setAttribute("aria-expanded", options.open ? "true" : "false");
  const line = el(doc, "span", "llm-task-fold-line");
  line.append(
    createTaskChevron(doc, "llm-task-fold-chevron", "right"),
    el(
      doc,
      "span",
      "llm-task-fold-text",
      (options.used
        ? t("{count} more, not used in the answer")
        : t("{count} found, none used in the answer")
      ).replace("{count}", String(options.unused)),
    ),
  );
  button.append(line);
  button.addEventListener("click", (event: Event) => {
    event.preventDefault?.();
    onToggle();
  });
  return button;
}

/** "Show all N", under the first rows of an opened fold. */
export function createTaskShowAll(
  doc: Document,
  count: number,
  onShowAll: () => void,
): HTMLElement {
  const line = el(doc, "div", "llm-task-fold-more");
  line.append(
    linkButton(
      doc,
      t("Show all {count}").replace("{count}", String(count)),
      onShowAll,
      "llm-task-source-link",
    ),
  );
  return line;
}

export function createTaskGroupNote(
  doc: Document,
  className: string,
  text: string,
): HTMLElement {
  return el(doc, "div", className, text);
}

/** A group's heading: its name and, when it lists rows, how many. */
export function createTaskGroupHeading(
  doc: Document,
  label: string,
  count?: number,
): HTMLElement {
  const heading = el(
    doc,
    "div",
    "llm-task-progress-papers-title llm-task-group-title",
  );
  heading.append(doc.createTextNode(label));
  if (count) {
    heading.append(el(doc, "span", "llm-task-group-count", String(count)));
  }
  return heading;
}

export function createTaskWhyOutside(doc: Document, why: string): HTMLElement {
  const line = el(doc, "div", "llm-task-group-why");
  line.append(
    el(doc, "b", "", t("Why outside:")),
    doc.createTextNode(` ${why}`),
  );
  return line;
}

export function createTaskOffer(
  doc: Document,
  onOffer: (what: TaskProgressOfferDetail["what"]) => void,
): HTMLElement {
  const offer = el(doc, "div", "llm-task-group-offer");
  offer.append(
    el(
      doc,
      "span",
      "llm-task-group-offer-text",
      t("Only your library was searched."),
    ),
  );
  const button = (what: TaskProgressOfferDetail["what"], label: string) => {
    const node = el(doc, "button", "llm-task-group-offer-button", label);
    node.type = "button";
    node.addEventListener("click", (event: Event) => {
      event.preventDefault?.();
      onOffer(what);
    });
    return node;
  };
  offer.append(
    button("scholarly", t("Search scholarly sources too")),
    button("web", t("Search the web too")),
  );
  return offer;
}

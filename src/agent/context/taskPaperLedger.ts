/**
 * The per-paper task ledger: what the agent read from each paper in a task's
 * scope, and where the final answer cites it.
 *
 * This is a UI ledger, not model memory. `coverageLedger.ts` remembers a
 * capped, hashed digest for the model; this ledger keeps a bounded, readable
 * record for the Task progress view, fed from the same tool payloads the host
 * attests in `readObservation.ts`. The two switches below and there
 * cover the same tools; a unit test fails when they drift apart.
 *
 * Everything here is pure: no DOM, no Zotero globals. A host that can resolve
 * an attachment to its parent item passes `resolvePaper`; without it a row
 * that names only an attachment is skipped rather than guessed.
 */
import type { QuoteCitation } from "../../shared/types";

/** Monotone reading state of one paper, weakest first. */
export type TaskPaperState =
  | "listed"
  | "matched"
  | "skimmed"
  | "read"
  | "cited";

export const TASK_PAPER_STATES: readonly TaskPaperState[] = [
  "listed",
  "matched",
  "skimmed",
  "read",
  "cited",
];

/** Where the paper's text comes from, most specific first. */
export type TaskPaperTextSource =
  | "mineru"
  | "pdf_text"
  | "indexed"
  | "pdf"
  | "none"
  | "unknown";

const TEXT_SOURCE_RANK: Record<TaskPaperTextSource, number> = {
  unknown: 0,
  none: 1,
  pdf: 2,
  indexed: 3,
  pdf_text: 4,
  mineru: 5,
};

export type TaskPaperReadGranularity =
  | "metadata"
  | "abstract"
  | "outline"
  | "section"
  | "passage"
  | "full"
  | "figure"
  | "page"
  /**
   * A host digest of the paper (`digests/paperDigestWorker.ts`): its answer
   * as the snippet, or, without one, why the digest failed (`whyMatched`).
   * Not the paper's own text: its evidence is recorded as `passage` reads.
   */
  | "digest";

/** How a paper bears on the request, as a host digest judged it. */
export type TaskPaperDigestRelevance = {
  level: "direct" | "partial" | "none" | "unclear";
  reason: string;
};

/** Whether a paper supports the request's claim, as a host digest judged it. */
export type TaskPaperDigestStance = {
  position: "supports" | "challenges" | "mixed" | "unclear";
  reason: string;
};

/** One thing the agent read from one paper during one tool call. */
export type TaskPaperReadEvent = {
  /** `libraryID:itemId` of the paper this read belongs to. */
  key: string;
  callId: string;
  runId?: string;
  /** Set when the delta is applied; a derived delta may not know its turn. */
  turnIndex?: number;
  toolName: string;
  granularity: TaskPaperReadGranularity;
  /** How the host found it: bm25, metadata, exact, overview, targeted, ... */
  method?: string;
  /**
   * Section or page label, when the payload names one; on a `digest` read,
   * the label of the part it answers (`taskPaperDigestPartLabel`).
   */
  label?: string;
  /**
   * At most `TASK_PAPER_SNIPPET_MAX_CHARS` characters
   * (`TASK_PAPER_DIGEST_SNIPPET_MAX_CHARS` for a `digest` read).
   */
  snippet?: string;
  /** At most `TASK_PAPER_WHY_MATCHED_MAX_CHARS` characters. */
  whyMatched?: string;
  /** Chunk index of the paper's text the snippet came from, when known. */
  chunk?: number;
  /**
   * The page index the read came from (the first, for several pages), when
   * the payload names one. Opening the read goes to this page; `label` is
   * for display. Absent on rows saved before reads recorded it.
   */
  pageIndex?: number;
  /** Host observation ids this read attested. */
  observationIds?: string[];
  /**
   * A digest's reads only: the part whose result they are, by its full task
   * id, which names its run, so two runs that both declare a part "papers"
   * stay two parts.
   * Absent on rows saved before parts were recorded.
   */
  partId?: string;
  /** A `digest` read only: the relevance the digest judged, when it did. */
  relevance?: TaskPaperDigestRelevance;
  /** A `digest` read only: the stance the digest judged, when it did. */
  stance?: TaskPaperDigestStance;
};

export type TaskPaperCitation = {
  citationId: string;
  turnIndex: number;
  /** At most `TASK_PAPER_CITATION_QUOTE_MAX_CHARS` characters. */
  quote?: string;
  label?: string;
  sectionLabel?: string;
  /** Every document section the citation is used in, when more than one. */
  sectionLabels?: string[];
  /** The page label the quote recorded; for display. */
  pageLabel?: string;
  /**
   * "document" for a source a `submit_document` call cited; absent (or
   * "answer") for a quote chip of the final answer.
   */
  source?: "answer" | "document";
};

/** One source a submitted document cites, as `material_finalized` names it. */
export type TaskPaperDocumentCitation = {
  citationId: string;
  libraryID: number;
  itemKey: string;
  itemId?: number;
  /** The document heading the citation first appears under. */
  sectionLabel?: string;
  /** Every heading it appears under, in order, when more than one. */
  sectionLabels?: string[];
  /** The paper's record, for a paper no read recorded. */
  title?: string;
  firstCreator?: string;
  year?: string;
};

export type TaskPaperDeltaPaper = {
  key: string;
  libraryID: number;
  itemId: number;
  contextItemId?: number;
  title?: string;
  year?: string;
  creator?: string;
  /** Zotero key of the paper, when the payload or the host names it. */
  itemKey?: string;
  text?: TaskPaperTextSource;
  state: TaskPaperState;
};

/** What one successful read tool call added to the ledger. */
export type TaskPaperLedgerDelta = {
  version: 1;
  callId: string;
  runId?: string;
  turnIndex?: number;
  toolName: string;
  papers: TaskPaperDeltaPaper[];
  reads: TaskPaperReadEvent[];
  /** Reads beyond the per-paper cap, dropped before emission. */
  droppedReads?: number;
};

export type TaskPaperTurnRecord = {
  /** Strongest state this turn earned: its reads, then its citations. */
  state: TaskPaperState;
  /**
   * Strongest state this turn's reads earned, never `cited`. A citation
   * dropped when the turn's answer is re-applied falls back to it.
   */
  readState: TaskPaperState;
  reads: TaskPaperReadEvent[];
  droppedReads: number;
  citations: TaskPaperCitation[];
  /** Answer citations beyond the per-turn cap. */
  droppedCitations: number;
  /** Document citations beyond the per-turn cap. */
  droppedDocumentCitations?: number;
  /**
   * The run whose reads `reads` holds. A re-run of the question (another
   * run id) replaces them, as its document's sources replace the earlier
   * run's.
   */
  readsRunId?: string;
  /** Runs whose reads a later run of the question replaced. */
  supersededRunIds?: string[];
};

export type TaskPaperLedgerEntry = {
  key: string;
  libraryID: number;
  itemId: number;
  /** Zotero key of the paper, once a read or a document citation named it. */
  itemKey?: string;
  contextItemIds: number[];
  title?: string;
  year?: string;
  creator?: string;
  text: TaskPaperTextSource;
  /** Strongest state over every turn. */
  state: TaskPaperState;
  /** Latest turn that touched this paper. */
  latestTurn: number;
  turns: Record<number, TaskPaperTurnRecord>;
};

export type TaskPaperLedger = {
  version: 1;
  /** Insertion order of `papers`. */
  order: string[];
  papers: Record<string, TaskPaperLedgerEntry>;
  /** `runId:callId` of every delta already applied. */
  appliedCalls: Record<string, true>;
  /** Papers refused by the per-conversation cap. */
  droppedPapers: number;
  lastLibraryID?: number;
};

export const TASK_PAPER_MAX_READS_PER_TURN = 12;
export const TASK_PAPER_MAX_CITATIONS_PER_TURN = 8;
/** Document sections one document citation lists. */
export const TASK_PAPER_MAX_DOCUMENT_SECTIONS = 8;
export const TASK_PAPER_MAX_PAPERS = 5000;
export const TASK_PAPER_SNIPPET_MAX_CHARS = 280;
/**
 * A host digest's summary is read in full on the paper's row, so its read
 * keeps up to this many characters; its evidence passages keep the
 * ordinary snippet cap.
 */
export const TASK_PAPER_DIGEST_SNIPPET_MAX_CHARS = 1600;
export const TASK_PAPER_WHY_MATCHED_MAX_CHARS = 120;
export const TASK_PAPER_CITATION_QUOTE_MAX_CHARS = 160;

/**
 * Tools whose payloads this ledger reads. Kept equal to the tools
 * `createTrustedReadObservations` attests.
 */
export const TASK_PAPER_LEDGER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "library_search",
  "library_read",
  "library_retrieve",
  "paper_read",
  "read_attachment",
]);

export function taskPaperKey(libraryID: number, itemId: number): string {
  return `${libraryID}:${itemId}`;
}

/**
 * Read granularities that return a paper's own text, not only its record.
 * A `digest` read is the host's summary, not the paper's text: a digested
 * paper counts by its state (`read`), a failed digest not at all.
 */
const TEXT_GRANULARITIES: ReadonlySet<TaskPaperReadGranularity> =
  new Set<TaskPaperReadGranularity>([
    "section",
    "passage",
    "full",
    "figure",
    "page",
  ]);

/**
 * How deep one call read each paper, by item id, for the outcome ledger
 * (`loop/outcomes.ts` states the rule): `text` when it returned the paper's
 * text (a passage, section, page, figure, the full text, or an overview of
 * it, sampled or complete), `shallow` when only an abstract or an outline,
 * and `noText` when `paper_read` reported the paper has no readable text
 * (its overview fell back to the Zotero record). A metadata row alone is
 * none of these, and a search listing never reports missing text: it did
 * not try to read the paper.
 */
export function taskPaperReadDepths(delta: TaskPaperLedgerDelta | null): {
  text: number[];
  shallow: number[];
  noText: number[];
} {
  const depths = {
    text: [] as number[],
    shallow: [] as number[],
    noText: [] as number[],
  };
  if (!delta) return depths;
  const textKeys = new Set(
    delta.reads
      .filter((read) => TEXT_GRANULARITIES.has(read.granularity))
      .map((read) => read.key),
  );
  for (const paper of delta.papers) {
    if (
      stateRank(paper.state) >= stateRank("read") ||
      textKeys.has(paper.key)
    ) {
      depths.text.push(paper.itemId);
      continue;
    }
    if (paper.state === "skimmed") depths.shallow.push(paper.itemId);
    if (delta.toolName === "paper_read" && paper.text === "none") {
      depths.noText.push(paper.itemId);
    }
  }
  return depths;
}

export function stateRank(state: TaskPaperState): number {
  return TASK_PAPER_STATES.indexOf(state);
}

function strongerState(a: TaskPaperState, b: TaskPaperState): TaskPaperState {
  return stateRank(a) >= stateRank(b) ? a : b;
}

function strongerText(
  a: TaskPaperTextSource | undefined,
  b: TaskPaperTextSource | undefined,
): TaskPaperTextSource {
  const left = a || "unknown";
  const right = b || "unknown";
  return TEXT_SOURCE_RANK[left] >= TEXT_SOURCE_RANK[right] ? left : right;
}

// ---------------------------------------------------------------------------
// Payload readers (mirroring readObservation's tolerant field access)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function record(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : null;
}

function positive(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** A payload's page index; null and empty values name no page. */
function pageIndexOf(value: unknown): number | undefined {
  return value === null || value === undefined || value === ""
    ? undefined
    : nonNegative(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasText(value: unknown, keys: readonly string[]): boolean {
  const input = record(value);
  return Boolean(input && keys.some((key) => text(input[key])));
}

function firstText(value: unknown, keys: readonly string[]): string {
  const input = record(value);
  if (!input) return "";
  for (const key of keys) {
    const found = text(input[key]);
    if (found) return found;
  }
  return "";
}

function hasRows(value: unknown, keys: readonly string[]): boolean {
  const input = record(value);
  return Boolean(
    input &&
    keys.some((key) => Array.isArray(input[key]) && input[key].length > 0),
  );
}

function rowsAt(result: unknown, key: string): unknown[] {
  const output = record(result);
  if (!output) return [];
  const value = output[key];
  if (Array.isArray(value)) return value;
  return record(value) ? Object.values(value as Row) : [];
}

function directRows(result: unknown): unknown[] {
  return ["results", "papers", "paperMatches", "items", "snippets"].flatMap(
    (key) => rowsAt(result, key),
  );
}

/** Collapse whitespace and cut to `max` characters with an ellipsis. */
export function clipTaskPaperText(
  value: unknown,
  max: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

const CHUNK_MARKER_LINE = /^\s*\[chunk \d+[^\]]*\]\s*$/i;
const PASSAGE_MARKER_LINE = /^\s*\[passage [^\]]+\]\s*$/i;
const HEADING_LINE = /^\s*#{1,6}\s+/;
const FRONT_MATTER =
  /\b(University|Institute|Department|Laboratory|Hospital|Correspondence|e-?mail)\b|@|大学|学院|研究所|研究院|研究中心|医院|实验室|通讯作者|通信作者|电子邮件|邮箱/i;
/** Contact lines (a lead label or an e-mail address) are front matter however they end. */
const CONTACT =
  /^\W*(Correspondence|Corresponding author|E-?mail)\b|[\w.+-]+@[\w-]+\.[\w.-]+|通讯作者|通信作者|电子邮件|邮箱/i;
/** "J. Doe", "A.-B. Smith", "J. R. R. Tolkien": an initials-and-surname name. */
const INITIALS_NAME = /(?:^|[\s,;])(?:[A-Z]\.[\s-]?){1,3}[A-Z][\p{L}'-]+/gu;
/** Han, Hiragana and Katakana characters: one word each, unspaced. */
const UNSPACED_CHAR =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const BODY_PARAGRAPH_MIN_WORDS = 25;
const SENTENCE_PARAGRAPH_MIN_WORDS = 8;
/** Prose without spaces between words (Chinese, Japanese) is long by length. */
const UNSPACED_PROSE_MIN_CHARS = 60;
const SENTENCE_END = /[.!?。！？]["'')\]」』）]?$/u;
const FRONT_MATTER_PARAGRAPHS = 5;

/**
 * A paragraph's length in words. Unspaced characters count by length:
 * `UNSPACED_PROSE_MIN_CHARS` of them weigh as much as
 * `BODY_PARAGRAPH_MIN_WORDS` spaced words, so mixed text adds up.
 */
function proseWords(prose: string): number {
  const unspaced = (prose.match(UNSPACED_CHAR) || []).length;
  const spaced = prose
    .replace(UNSPACED_CHAR, " ")
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  return (
    spaced + (unspaced * BODY_PARAGRAPH_MIN_WORDS) / UNSPACED_PROSE_MIN_CHARS
  );
}

/**
 * An author list, an affiliation or a contact line. These open a paper and
 * often end with a period; an abstract that names a university does not read
 * as a comma-separated list.
 */
function isFrontMatter(prose: string, words: number, endsSentence: boolean) {
  if (CONTACT.test(prose)) return true;
  const commas = (prose.match(/[,，、;；]/g) || []).length;
  if (!endsSentence) return FRONT_MATTER.test(prose) || commas > 6;
  // A list: a comma for every few words.
  const listLike = commas >= 2 && words <= 4 * (commas + 1);
  if (!listLike) return false;
  return (
    FRONT_MATTER.test(prose) ||
    commas > 6 ||
    (prose.match(INITIALS_NAME) || []).length >= 2
  );
}

/**
 * First prose paragraph after the title block: no chunk markers, no heading
 * marks. A whole-paper read starts with the title, the authors and their
 * affiliations; the row's snippet should say what the paper is about.
 * Falls back to the first non-empty paragraph, heading marks stripped.
 */
export function firstBodyParagraph(text: string): string {
  const lines = String(text || "")
    .split(/\r?\n/)
    .filter((line) => !CHUNK_MARKER_LINE.test(line))
    .filter((line) => !PASSAGE_MARKER_LINE.test(line));
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim()) {
      current.push(line);
      continue;
    }
    if (current.length) paragraphs.push(current);
    current = [];
  }
  if (current.length) paragraphs.push(current);
  const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
  let fallback = "";
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    if (!fallback) {
      fallback = oneLine(
        paragraph.map((line) => line.replace(HEADING_LINE, "")).join(" "),
      );
    }
    const prose = oneLine(
      paragraph.filter((line) => !HEADING_LINE.test(line)).join(" "),
    );
    if (!prose) continue;
    const words = proseWords(prose);
    const endsSentence = SENTENCE_END.test(prose);
    // Prose: a long paragraph, or a shorter one that ends a sentence (a
    // title, an author list or a running head ends in neither).
    if (
      words < BODY_PARAGRAPH_MIN_WORDS &&
      !(endsSentence && words >= SENTENCE_PARAGRAPH_MIN_WORDS)
    )
      continue;
    // Affiliations and author lists open the paper, with or without a
    // closing period.
    if (
      index < FRONT_MATTER_PARAGRAPHS &&
      isFrontMatter(prose, words, endsSentence)
    )
      continue;
    return prose;
  }
  return fallback;
}

type PaperRef = {
  itemId?: number;
  contextItemId?: number;
  libraryID?: number;
  title?: string;
  year?: string;
  creator?: string;
  itemKey?: string;
};

function paperRef(value: unknown): PaperRef | null {
  const input = record(value);
  if (!input) return null;
  const paper = record(input.paperContext);
  const parent = record(input.parentItem);
  const ref: PaperRef = {
    itemId: positive(
      paper?.itemId ?? input.itemId ?? input.itemID ?? parent?.itemId,
    ),
    contextItemId: positive(
      paper?.contextItemId ?? input.contextItemId ?? input.contextItemID,
    ),
    libraryID: positive(paper?.libraryID ?? input.libraryID),
    title: text(paper?.title) || text(input.title) || text(parent?.title),
    year:
      text(String(paper?.year ?? "")) ||
      text(String(input.year ?? "")) ||
      text(String(parent?.year ?? "")),
    creator:
      text(paper?.firstCreator) ||
      text(input.firstCreator) ||
      text(parent?.firstCreator) ||
      (Array.isArray(input.creators) ? text(input.creators[0]) : undefined),
  };
  const itemKey = text(paper?.itemKey) || text(input.itemKey);
  if (itemKey) ref.itemKey = itemKey;
  return ref.itemId || ref.contextItemId ? ref : null;
}

function inputRefs(input: unknown): PaperRef[] {
  const args = record(input) || {};
  const direct = [
    args.target,
    ...(Array.isArray(args.targets) ? args.targets : []),
  ]
    .map(paperRef)
    .filter((entry): entry is PaperRef => Boolean(entry));
  const itemIds = Array.isArray(args.itemIds)
    ? args.itemIds.map(positive).filter((id): id is number => Boolean(id))
    : [];
  return [
    ...direct,
    ...itemIds.map((itemId) => ({ itemId })),
    ...(positive(args.itemId) ? [{ itemId: positive(args.itemId)! }] : []),
  ];
}

type ReadSeed = Omit<
  TaskPaperReadEvent,
  "key" | "callId" | "runId" | "turnIndex" | "toolName"
>;

type Seed = {
  ref: PaperRef;
  state: TaskPaperState;
  text?: TaskPaperTextSource;
  read?: ReadSeed;
};

function readSeed(fields: {
  granularity: TaskPaperReadGranularity;
  method?: string;
  label?: unknown;
  snippet?: unknown;
  whyMatched?: unknown;
  pageIndex?: unknown;
}): ReadSeed {
  const seed: ReadSeed = { granularity: fields.granularity };
  if (fields.method) seed.method = fields.method;
  const label = clipTaskPaperText(fields.label, 120);
  if (label) seed.label = label;
  const pageIndex = pageIndexOf(fields.pageIndex);
  if (pageIndex !== undefined) seed.pageIndex = pageIndex;
  const snippet = clipTaskPaperText(
    fields.snippet,
    TASK_PAPER_SNIPPET_MAX_CHARS,
  );
  if (snippet) seed.snippet = snippet;
  const whyMatched = clipTaskPaperText(
    fields.whyMatched,
    TASK_PAPER_WHY_MATCHED_MAX_CHARS,
  );
  if (whyMatched) seed.whyMatched = whyMatched;
  return seed;
}

function pageLabelFor(row: Row): string | undefined {
  const label = text(row.pageLabel);
  if (label) return `p. ${label}`;
  const index = nonNegative(row.pageIndex);
  return index === undefined ? undefined : `p. ${index + 1}`;
}

/** Granularity and label of one retrieved passage. */
function passageReadSeed(row: Row, method: string): ReadSeed {
  const chunkKind = text(row.chunkKind);
  const sectionLabel = text(row.sectionLabel);
  if (chunkKind === "page") {
    return readSeed({
      granularity: "page",
      method,
      label: sectionLabel || pageLabelFor(row),
      snippet: row.text,
      pageIndex: row.pageIndex,
    });
  }
  return readSeed({
    granularity: sectionLabel ? "section" : "passage",
    method,
    label: sectionLabel || pageLabelFor(row),
    snippet: row.snippet ?? row.text ?? row.surroundingText,
    whyMatched: row.whyMatched,
    pageIndex: row.pageIndex,
  });
}

function textSourceFromKind(value: unknown): TaskPaperTextSource | undefined {
  const kind = String(value || "").toLowerCase();
  if (kind === "mineru") return "mineru";
  if (kind === "pdf_text" || kind === "raw_pdf_text") return "pdf_text";
  return undefined;
}

function textSourceFromResourceState(
  value: unknown,
): TaskPaperTextSource | undefined {
  const states = Array.isArray(value) ? value.map(String) : [];
  if (states.includes("text_indexed")) return "indexed";
  if (states.includes("text_available")) return "pdf";
  if (states.includes("unsupported")) return "none";
  return undefined;
}

// ---------------------------------------------------------------------------
// Per-tool state rules
// ---------------------------------------------------------------------------

function libraryRetrieveSeeds(result: unknown): Seed[] {
  const output = record(result) || {};
  const pool = record(output.resourcePool);
  const scopeLibraryID = positive(record(pool?.scope)?.libraryID);
  const withLibrary = (ref: PaperRef | null): PaperRef | null =>
    ref ? { ...ref, libraryID: ref.libraryID ?? scopeLibraryID } : null;
  const seeds: Seed[] = [];
  const candidateIds = new Set<number>();
  for (const row of rowsAt(result, "candidates")) {
    const value = record(row);
    const ref = withLibrary(paperRef(row));
    if (!value || !ref) continue;
    if (ref.itemId) candidateIds.add(ref.itemId);
    const queryState = Array.isArray(value.queryState)
      ? value.queryState.map(String)
      : [];
    seeds.push({
      ref,
      state: "matched",
      text: textSourceFromResourceState(value.resourceState),
      read: readSeed({
        granularity: "metadata",
        method: queryState.includes("matched_bm25")
          ? "bm25"
          : queryState.includes("matched_metadata")
            ? "metadata"
            : "shortlist",
        whyMatched: value.whyMatched,
      }),
    });
  }
  for (const row of rowsAt(result, "paperMatches")) {
    const value = record(row);
    const ref = withLibrary(paperRef(row));
    if (!value || !ref) continue;
    seeds.push({
      ref,
      state: "matched",
      ...(ref.itemId && candidateIds.has(ref.itemId)
        ? {}
        : {
            read: readSeed({
              granularity: "metadata",
              method: "metadata",
              whyMatched: value.whyMatched,
            }),
          }),
    });
  }
  for (const row of rowsAt(result, "snippets")) {
    const value = record(row);
    const ref = withLibrary(paperRef(row));
    if (!value || !ref) continue;
    if (!hasText(value, ["snippet", "surroundingText", "text"])) continue;
    const sourceKind = String(value.sourceKind || "").toLowerCase();
    const method = text(value.matchMethod) || "retrieve";
    if (sourceKind === "abstract") {
      seeds.push({
        ref,
        state: "skimmed",
        read: readSeed({
          granularity: "abstract",
          method,
          snippet: value.snippet ?? value.text,
          whyMatched: value.whyMatched,
        }),
      });
      continue;
    }
    if (sourceKind === "metadata") {
      seeds.push({
        ref,
        state: "matched",
        read: readSeed({
          granularity: "metadata",
          method,
          snippet: value.snippet ?? value.text,
          whyMatched: value.whyMatched,
        }),
      });
      continue;
    }
    seeds.push({
      ref,
      state: "read",
      text: textSourceFromKind(sourceKind),
      read: passageReadSeed(value, method),
    });
  }
  return seeds;
}

function metadataListSeeds(input: unknown, result: unknown): Seed[] {
  const mode = text(record(input)?.mode) || "search";
  return directRows(result).flatMap((row) => {
    const ref = paperRef(row);
    return ref
      ? [
          {
            ref,
            state: "matched" as const,
            read: readSeed({ granularity: "metadata", method: mode }),
          },
        ]
      : [];
  });
}

function libraryReadSeeds(result: unknown): Seed[] {
  return directRows(result).flatMap((row): Seed[] => {
    const ref = paperRef(row);
    const value = record(row);
    if (!ref || !value) return [];
    const metadata = record(value.metadata);
    const abstract =
      firstText(metadata, ["abstract", "abstractNote"]) ||
      firstText(value, ["abstract", "abstractNote"]);
    const body =
      hasText(value, ["content", "text", "body", "fullText"]) ||
      hasRows(value, ["passages", "snippets", "chunks", "notes"]);
    if (body) {
      return [
        {
          ref,
          state: "read",
          read: readSeed({
            granularity: hasRows(value, ["passages", "snippets", "chunks"])
              ? "passage"
              : "full",
            method: "library_read",
            snippet: firstBodyParagraph(
              firstText(value, ["content", "text", "body", "fullText"]),
            ),
          }),
        },
      ];
    }
    if (abstract) {
      return [
        {
          ref,
          state: "skimmed",
          read: readSeed({
            granularity: "abstract",
            method: "library_read",
            snippet: abstract,
          }),
        },
      ];
    }
    if (metadata && Object.keys(metadata).length) {
      return [
        {
          ref,
          state: "matched",
          read: readSeed({ granularity: "metadata", method: "library_read" }),
        },
      ];
    }
    return [];
  });
}

function paperReadOverviewSeed(row: Row, ref: PaperRef): Seed | null {
  if (row.ok === false) return null;
  const backend = String(row.backend || "").toLowerCase();
  const sourceKind = String(row.sourceKind || "").toLowerCase();
  if (backend === "zotero_metadata" || sourceKind === "zotero_metadata") {
    const abstractMatch = /(?:^|\n)Abstract:\s*(\S[\s\S]*)/i.exec(
      String(row.text || ""),
    );
    const abstract =
      firstText(row, ["abstract", "abstractNote"]) || abstractMatch?.[1];
    return abstract
      ? {
          ref,
          state: "skimmed",
          text: "none",
          read: readSeed({
            granularity: "abstract",
            method: "overview",
            snippet: abstract,
          }),
        }
      : {
          ref,
          state: "matched",
          text: "none",
          read: readSeed({ granularity: "metadata", method: "overview" }),
        };
  }
  if (!hasText(row, ["text", "content", "body"])) return null;
  const complete = String(row.coverage || "") === "complete";
  return {
    ref,
    state: complete ? "read" : "skimmed",
    text:
      backend === "mineru"
        ? "mineru"
        : backend === "raw_pdf_text"
          ? "pdf_text"
          : undefined,
    read: readSeed({
      granularity: complete ? "full" : "passage",
      method: "overview",
      // An overview starts at the paper's front, sampled or not.
      snippet: firstBodyParagraph(firstText(row, ["text", "content", "body"])),
    }),
  };
}

function paperReadSeeds(input: unknown, result: unknown): Seed[] {
  const args = record(input) || {};
  const output = record(result) || {};
  const mode = text(args.mode) || text(output.mode) || "overview";
  if (mode === "figures" && Array.isArray(output.figures)) {
    return rowsAt(result, "figures").flatMap((row): Seed[] => {
      const value = record(row);
      const ref = paperRef(row);
      if (!value || !ref || !hasText(value, ["cropPath"])) return [];
      return [
        {
          ref,
          state: "read",
          read: readSeed({
            granularity: "figure",
            method: "figures",
            label: [text(value.label), pageLabelFor(value)]
              .filter(Boolean)
              .join(" · "),
            snippet: value.caption,
          }),
        },
      ];
    });
  }
  if (mode === "overview") {
    const rows = directRows(result);
    if (!rows.length) {
      // An aggregate payload speaks for its paper only when there is one.
      const refs = inputRefs(input);
      const seed =
        refs.length === 1 ? paperReadOverviewSeed(output, refs[0]) : null;
      return seed ? [seed] : [];
    }
    return rows.flatMap((row): Seed[] => {
      const value = record(row);
      const ref = paperRef(row);
      const seed = value && ref ? paperReadOverviewSeed(value, ref) : null;
      return seed ? [seed] : [];
    });
  }
  if (mode === "outline") {
    return rowsAt(result, "papers").flatMap((row): Seed[] => {
      const value = record(row);
      const ref = paperRef(row);
      const sections = rowsAt(record(value?.outline), "sections");
      if (!value || !ref || !sections.length) return [];
      return [
        {
          ref,
          // Headings only: the paper's text was not read.
          state: "skimmed",
          read: readSeed({
            granularity: "outline",
            method: "outline",
            label: sections
              .map((section) => text(record(section)?.title))
              .filter(Boolean)
              .slice(0, 6)
              .join(" · "),
          }),
        },
      ];
    });
  }
  if (["figures", "visual", "capture"].includes(mode)) {
    return renderedPageSeeds(input, result);
  }
  // targeted, full, and explicit page reads. Grouped papers carry the same
  // passages as the flat results, so they win when present.
  const groups = rowsAt(result, "papers").filter((row) => paperRef(row));
  const rows = groups.length ? groups : directRows(result);
  if (rows.length) {
    return rows.flatMap((row): Seed[] => {
      const value = record(row);
      const ref = paperRef(row);
      return value && ref ? bodyRowSeeds(value, ref, mode) : [];
    });
  }
  // An aggregate payload speaks for its paper only when there is one.
  const refs = inputRefs(input);
  if (
    refs.length === 1 &&
    (hasText(output, BODY_KEYS) ||
      hasRows(output, ["passages", "snippets", "chunks"]))
  ) {
    return [
      {
        ref: refs[0],
        state: "read",
        read: readSeed({
          granularity: mode === "full" ? "full" : "passage",
          method: mode,
          snippet:
            mode === "full"
              ? firstBodyParagraph(firstText(output, BODY_KEYS))
              : firstText(output, BODY_KEYS),
        }),
      },
    ];
  }
  return [];
}

const BODY_KEYS = ["content", "text", "body", "fullText", "snippet"] as const;

/** The body reads one targeted/full result row carries. */
function bodyRowSeeds(row: Row, ref: PaperRef, mode: string): Seed[] {
  const passages = ["passages", "snippets", "chunks"]
    .flatMap((key) => rowsAt(row, key))
    .flatMap((passage) => {
      const value = record(passage);
      return value && hasText(value, ["text", "snippet"]) ? [value] : [];
    });
  if (passages.length) {
    return passages.map((passage) => ({
      ref,
      state: "read" as const,
      read: passageReadSeed(passage, mode),
    }));
  }
  const processed = Number(row.processedChunks) || 0;
  if (processed > 0 || hasRows(row, ["exactEvidence"])) {
    const total = Number(row.totalChunks) || 0;
    return [
      {
        ref,
        state: "read",
        read: readSeed({
          granularity: "full",
          method: mode,
          label: total ? `${processed}/${total} chunks` : undefined,
        }),
      },
    ];
  }
  if (hasText(row, BODY_KEYS)) {
    const read = passageReadSeed(row, mode);
    if (mode === "full") {
      const snippet = clipTaskPaperText(
        firstBodyParagraph(firstText(row, BODY_KEYS)),
        TASK_PAPER_SNIPPET_MAX_CHARS,
      );
      if (snippet) read.snippet = snippet;
    }
    return [{ ref, state: "read", read }];
  }
  return [];
}

/** One page-level read of `ref`, from the page rows `container` lists. */
function pageSeed(ref: PaperRef, container: Row): Seed | null {
  const pageIndexes: number[] = [];
  const pageRows = [
    ...rowsAt(container, "results"),
    ...rowsAt(container, "pages"),
  ].flatMap((row) => {
    const value = record(row);
    const label = value ? pageLabelFor(value) : undefined;
    const index = value ? pageIndexOf(value.pageIndex) : undefined;
    if (label && index !== undefined) pageIndexes.push(index);
    return label ? [label] : [];
  });
  const captured =
    nonNegative(container.capturedPageIndex) !== undefined
      ? pageLabelFor({
          pageLabel: container.pageLabel,
          pageIndex: container.capturedPageIndex,
        })
      : undefined;
  const own =
    container.pageIndex !== undefined ? pageLabelFor(container) : undefined;
  const labels = [
    ...new Set([
      ...pageRows,
      ...(captured ? [captured] : []),
      ...(own ? [own] : []),
    ]),
  ];
  const hasVisual =
    pageRows.length > 0 ||
    Boolean(captured) ||
    hasRows(container, ["images", "artifacts", "figures", "pages"]);
  if (!hasVisual) return null;
  return {
    ref,
    state: "read",
    read: readSeed({
      granularity: "page",
      method: "view_pages",
      label: labels.slice(0, 8).join(", "),
      snippet: text(container.pageText),
      // The page the label names first.
      pageIndex:
        pageIndexes[0] ??
        pageIndexOf(container.capturedPageIndex) ??
        pageIndexOf(container.pageIndex),
    }),
  };
}

function renderedPageSeeds(input: unknown, result: unknown): Seed[] {
  const output = record(result) || {};
  // Rows that name their own paper speak for it; otherwise the payload's
  // target (or the call's single target) owns the rendered pages.
  const identified = directRows(result).flatMap((row) => {
    const value = record(row);
    const ref = paperRef(row);
    return value && ref ? [{ value, ref }] : [];
  });
  if (identified.length) {
    return identified.flatMap(({ value, ref }) => {
      const seed = pageSeed(ref, value);
      return seed ? [seed] : [];
    });
  }
  const ref =
    paperRef(output.target) || paperRef(output) || inputRefs(input)[0];
  const seed = ref ? pageSeed(ref, output) : null;
  return seed ? [seed] : [];
}

function readAttachmentSeeds(input: unknown, result: unknown): Seed[] {
  const output = record(result) || {};
  const rows = directRows(result);
  if (rows.length) {
    return rows.flatMap((row): Seed[] => {
      const ref = paperRef(row);
      const body = firstText(row, ["content", "text", "body", "textContent"]);
      return ref && body
        ? [
            {
              ref,
              state: "read",
              read: readSeed({
                granularity: "full",
                method: "attachment",
                snippet: firstBodyParagraph(body),
              }),
            },
          ]
        : [];
    });
  }
  const body = firstText(output, ["content", "text", "body", "textContent"]);
  if (!body) return [];
  const ref = paperRef(output) || inputRefs(input)[0];
  if (!ref) return [];
  return [
    {
      ref,
      state: "read",
      read: readSeed({
        granularity: "full",
        method: "attachment",
        label: text(output.attachmentTitle) || text(output.title),
        snippet: firstBodyParagraph(body),
      }),
    },
  ];
}

function seedsFor(toolName: string, input: unknown, result: unknown): Seed[] {
  switch (toolName) {
    case "library_retrieve":
      return libraryRetrieveSeeds(result);
    case "library_search":
      return metadataListSeeds(input, result);
    case "library_read":
      return libraryReadSeeds(result);
    case "paper_read":
      return paperReadSeeds(input, result);
    case "read_attachment":
      return readAttachmentSeeds(input, result);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Delta derivation
// ---------------------------------------------------------------------------

export type TaskPaperResolvedRef = { itemId: number; libraryID?: number };

export type DeriveTaskPaperLedgerDeltaParams = {
  toolName: string;
  callId: string;
  input: unknown;
  /** The tool's original content, never a handle-replaced copy. */
  content: unknown;
  /** Library the call ran against; used when a row names none. */
  libraryID?: number;
  turnIndex?: number;
  runId?: string;
  /**
   * Host lookup from a row's ids to its bibliographic item and library.
   * Without it, a row that names only an attachment is skipped.
   */
  resolvePaper?: (ref: {
    itemId?: number;
    contextItemId?: number;
  }) => TaskPaperResolvedRef | null | undefined;
};

/**
 * What one successful read call adds to the ledger, or `null` when the tool
 * is not a paper read or its payload names no paper.
 */
export function deriveTaskPaperLedgerDelta(
  params: DeriveTaskPaperLedgerDeltaParams,
): TaskPaperLedgerDelta | null {
  if (!TASK_PAPER_LEDGER_TOOL_NAMES.has(params.toolName)) return null;
  const seeds = seedsFor(params.toolName, params.input, params.content);
  if (!seeds.length) return null;
  const papers = new Map<string, TaskPaperDeltaPaper>();
  const readsByKey = new Map<string, TaskPaperReadEvent[]>();
  const readIdentity = new Set<string>();
  let droppedReads = 0;
  for (const seed of seeds) {
    const resolved = resolveRef(seed.ref, params);
    if (!resolved) continue;
    const key = taskPaperKey(resolved.libraryID, resolved.itemId);
    const existing = papers.get(key);
    if (existing) {
      existing.state = strongerState(existing.state, seed.state);
      existing.text = strongerText(existing.text, seed.text);
      // Only defined values: the delta is persisted as JSON, and a key that
      // holds `undefined` would make the live and replayed deltas differ.
      if (!existing.title && seed.ref.title) existing.title = seed.ref.title;
      if (!existing.year && seed.ref.year) existing.year = seed.ref.year;
      if (!existing.creator && seed.ref.creator) {
        existing.creator = seed.ref.creator;
      }
      if (!existing.contextItemId && seed.ref.contextItemId) {
        existing.contextItemId = seed.ref.contextItemId;
      }
      if (!existing.itemKey && seed.ref.itemKey) {
        existing.itemKey = seed.ref.itemKey;
      }
      if (existing.text === "unknown") delete existing.text;
    } else {
      const paper: TaskPaperDeltaPaper = {
        key,
        libraryID: resolved.libraryID,
        itemId: resolved.itemId,
        state: seed.state,
      };
      if (seed.ref.contextItemId) paper.contextItemId = seed.ref.contextItemId;
      if (seed.ref.title) paper.title = seed.ref.title;
      if (seed.ref.year) paper.year = seed.ref.year;
      if (seed.ref.creator) paper.creator = seed.ref.creator;
      if (seed.ref.itemKey) paper.itemKey = seed.ref.itemKey;
      if (seed.text && seed.text !== "unknown") paper.text = seed.text;
      papers.set(key, paper);
    }
    if (!seed.read) continue;
    const identity = `${key}\u0000${JSON.stringify(seed.read)}`;
    if (readIdentity.has(identity)) continue;
    readIdentity.add(identity);
    const reads = readsByKey.get(key) || [];
    if (reads.length >= TASK_PAPER_MAX_READS_PER_TURN) {
      droppedReads += 1;
      continue;
    }
    const event: TaskPaperReadEvent = {
      key,
      callId: params.callId,
      toolName: params.toolName,
      ...seed.read,
    };
    if (params.runId) event.runId = params.runId;
    if (params.turnIndex !== undefined) event.turnIndex = params.turnIndex;
    reads.push(event);
    readsByKey.set(key, reads);
  }
  if (!papers.size) return null;
  const delta: TaskPaperLedgerDelta = {
    version: 1,
    callId: params.callId,
    toolName: params.toolName,
    papers: [...papers.values()].slice(0, TASK_PAPER_MAX_PAPERS),
    reads: [...readsByKey.values()].flat(),
  };
  if (params.runId) delta.runId = params.runId;
  if (params.turnIndex !== undefined) delta.turnIndex = params.turnIndex;
  if (droppedReads) delta.droppedReads = droppedReads;
  return delta;
}

function resolveRef(
  ref: PaperRef,
  params: DeriveTaskPaperLedgerDeltaParams,
): { itemId: number; libraryID: number } | null {
  // A row that already names its paper and library needs no lookup; a
  // 200-candidate retrieval would otherwise ask Zotero 200 times.
  if (ref.itemId && ref.libraryID) {
    return { itemId: ref.itemId, libraryID: ref.libraryID };
  }
  const resolved = params.resolvePaper?.({
    itemId: ref.itemId,
    contextItemId: ref.contextItemId,
  });
  const itemId = resolved?.itemId || ref.itemId;
  const libraryID =
    ref.libraryID || resolved?.libraryID || positive(params.libraryID);
  if (!itemId || !libraryID) return null;
  return { itemId, libraryID };
}

// ---------------------------------------------------------------------------
// Host digests
// ---------------------------------------------------------------------------

/** The paper a host digest belongs to, as the host resolved it. */
export type TaskPaperDigestPaper = {
  libraryID: number;
  itemId: number;
  contextItemId?: number;
  title?: string;
  year?: string;
  creator?: string;
  itemKey?: string;
};

/**
 * The fields of a `HostPaperDigest` (`digests/paperDigestWorker.ts`) the
 * ledger records. Declared here, not imported: the worker's model client
 * would otherwise join this module's import graph (and close a cycle
 * through `agent/types.ts`). A `HostPaperDigest` is assignable to it.
 */
export type TaskPaperDigestInput = {
  contextItemId?: number;
  answer: string;
  relevance?: Readonly<TaskPaperDigestRelevance>;
  stance?: Readonly<TaskPaperDigestStance>;
  evidence?: ReadonlyArray<{ section?: string; quote: string; chunk?: number }>;
  source?: { backend: "mineru" | "pdf" | "text" };
};

/** The fields of a `PaperDigestFailure` the ledger records. */
export type TaskPaperDigestFailureInput = { reason: string };

export type BuildDigestLedgerDeltaParams = {
  runId?: string;
  /** The `task_update` call that ran the digest job. */
  callId: string;
  toolName: string;
  turnIndex?: number;
  /** The full task id of the digest part the paper's result answers. */
  partId?: string;
  /** The part's label (`taskPaperDigestPartLabel`); none without one. */
  label?: string;
  digest: TaskPaperDigestInput;
  paper: TaskPaperDigestPaper;
};

/** The most characters a digest part's label keeps. */
export const TASK_PAPER_DIGEST_LABEL_MAX_CHARS = 60;

/**
 * A digest part's label for its paper rows: its description's first
 * sentence, at most 60 characters, cut at a word (with "…") when longer.
 * Undefined for an empty description.
 */
export function taskPaperDigestPartLabel(
  description: string | undefined,
): string | undefined {
  const clean = `${description ?? ""}`.replace(/\s+/g, " ").trim();
  // A sentence ends at . ! ? before a space, or at 。！？ (unspaced). A
  // question keeps its mark; a closing period is dropped.
  const sentence = clean
    .split(/(?<=[.!?])\s|(?<=[。！？])/u)[0]
    .replace(/[.。\s]+$/u, "")
    .trim();
  if (!sentence) return undefined;
  const max = TASK_PAPER_DIGEST_LABEL_MAX_CHARS;
  if (sentence.length <= max) return sentence;
  const head = sentence.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  // An unspaced script (Han, kana) has no word to cut at.
  const cut = space > max / 2 ? head.slice(0, space) : head;
  return `${cut.replace(/[\s,;:]+$/u, "")}…`;
}

/** A judgment's reason at the snippet cap; defined values only. */
function digestJudgment<T extends { reason: string }>(
  judgment: Readonly<T> | undefined,
): T | undefined {
  if (!judgment) return undefined;
  return {
    ...judgment,
    reason:
      clipTaskPaperText(judgment.reason, TASK_PAPER_SNIPPET_MAX_CHARS) || "",
  } as T;
}

export type BuildDigestFailureLedgerDeltaParams = Omit<
  BuildDigestLedgerDeltaParams,
  "digest"
> & { failure: TaskPaperDigestFailureInput };

/**
 * `DIGEST_FAILURE_REASONS.noText`, kept here so this module stays free of the
 * worker's model client; a unit test keeps the two equal.
 */
export const TASK_PAPER_DIGEST_NO_TEXT_REASON = "No readable text";

const DIGEST_TEXT_SOURCE: Record<
  NonNullable<TaskPaperDigestInput["source"]>["backend"],
  TaskPaperTextSource
> = {
  mineru: "mineru",
  pdf: "pdf_text",
  text: "indexed",
};

function digestDeltaShell(
  params: Omit<BuildDigestLedgerDeltaParams, "digest">,
  callId: string,
  paper: TaskPaperDeltaPaper,
): TaskPaperLedgerDelta {
  const delta: TaskPaperLedgerDelta = {
    version: 1,
    callId,
    toolName: params.toolName,
    papers: [paper],
    reads: [],
  };
  if (params.runId) delta.runId = params.runId;
  if (params.turnIndex !== undefined) delta.turnIndex = params.turnIndex;
  return delta;
}

function digestPaper(
  paper: TaskPaperDigestPaper,
  state: TaskPaperState,
  contextItemId?: number,
): TaskPaperDeltaPaper {
  const row: TaskPaperDeltaPaper = {
    key: taskPaperKey(paper.libraryID, paper.itemId),
    libraryID: paper.libraryID,
    itemId: paper.itemId,
    state,
  };
  // Only defined values: the delta is persisted as JSON.
  const context = positive(contextItemId) || positive(paper.contextItemId);
  if (context) row.contextItemId = context;
  const title = text(paper.title);
  if (title) row.title = title;
  const year = text(paper.year);
  if (year) row.year = year;
  const creator = text(paper.creator);
  if (creator) row.creator = creator;
  const itemKey = text(paper.itemKey);
  if (itemKey) row.itemKey = itemKey;
  return row;
}

function digestRead(
  delta: TaskPaperLedgerDelta,
  key: string,
  seed: ReadSeed,
  partId?: string,
): TaskPaperReadEvent {
  const read: TaskPaperReadEvent = {
    key,
    callId: delta.callId,
    toolName: delta.toolName,
    ...seed,
  };
  if (delta.runId) read.runId = delta.runId;
  if (delta.turnIndex !== undefined) read.turnIndex = delta.turnIndex;
  const part = text(partId);
  if (part) read.partId = part;
  return read;
}

/**
 * What one completed host digest adds to the ledger: the paper read, one
 * `digest` read holding its answer (up to
 * `TASK_PAPER_DIGEST_SNIPPET_MAX_CHARS`), its part's id and label and the
 * relevance and stance it judged, and one `passage` read per verified
 * evidence quote under its section. Built directly, never through
 * `deriveTaskPaperLedgerDelta` (the digest is no read tool's payload). Its
 * call id is the job's call id qualified by the paper, so each paper of one
 * `task_update` call applies once (`applyTaskPaperLedgerDelta` is idempotent
 * by `runId:callId`).
 */
export function buildDigestLedgerDelta(
  params: BuildDigestLedgerDeltaParams,
): TaskPaperLedgerDelta {
  const { digest } = params;
  const paper = digestPaper(params.paper, "read", digest.contextItemId);
  const backend = digest.source?.backend;
  const source = backend ? DIGEST_TEXT_SOURCE[backend] : undefined;
  if (source) paper.text = source;
  const delta = digestDeltaShell(
    params,
    `${params.callId}:digest:${params.paper.itemId}`,
    paper,
  );
  const answer = readSeed({
    granularity: "digest",
    method: "digest",
    label: params.label,
  });
  const clipped = clipTaskPaperText(
    digest.answer,
    TASK_PAPER_DIGEST_SNIPPET_MAX_CHARS,
  );
  if (clipped) answer.snippet = clipped;
  const relevance = digestJudgment(digest.relevance);
  if (relevance) answer.relevance = relevance;
  const stance = digestJudgment(digest.stance);
  if (stance) answer.stance = stance;
  const passages: ReadSeed[] = [];
  for (const evidence of digest.evidence || []) {
    const seed = readSeed({
      granularity: "passage",
      method: "digest",
      label: evidence.section,
      snippet: evidence.quote,
    });
    if (!seed.snippet) continue;
    const chunk = nonNegative(evidence.chunk);
    if (chunk !== undefined) seed.chunk = chunk;
    passages.push(seed);
  }
  // The digest read is never dropped by the cap; the evidence fills the rest.
  const keptPassages = passages.slice(0, TASK_PAPER_MAX_READS_PER_TURN - 1);
  delta.reads = [answer, ...keptPassages].map((seed) =>
    digestRead(delta, paper.key, seed, params.partId),
  );
  if (passages.length > keptPassages.length) {
    delta.droppedReads = passages.length - keptPassages.length;
  }
  return delta;
}

/**
 * What a failed host digest adds to the ledger: the paper as matched (its
 * text was not analyzed) and one `digest` read with no snippet whose
 * `whyMatched` is the host's reason, which the paper's row shows, under its
 * part's id and label. Its call id differs from a success's, so a later
 * digest of the paper in the same call still applies.
 */
export function buildDigestFailureLedgerDelta(
  params: BuildDigestFailureLedgerDeltaParams,
): TaskPaperLedgerDelta {
  const paper = digestPaper(params.paper, "matched");
  // Only a missing text says anything about the paper's text source.
  if (params.failure.reason === TASK_PAPER_DIGEST_NO_TEXT_REASON) {
    paper.text = "none";
  }
  const delta = digestDeltaShell(
    params,
    `${params.callId}:digest:${params.paper.itemId}:failed`,
    paper,
  );
  delta.reads = [
    digestRead(
      delta,
      paper.key,
      readSeed({
        granularity: "digest",
        method: "digest",
        label: params.label,
        whyMatched: params.failure.reason,
      }),
      params.partId,
    ),
  ];
  return delta;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function createTaskPaperLedger(): TaskPaperLedger {
  return {
    version: 1,
    order: [],
    papers: {},
    appliedCalls: {},
    droppedPapers: 0,
  };
}

function emptyTurn(): TaskPaperTurnRecord {
  return {
    state: "listed",
    readState: "listed",
    reads: [],
    droppedReads: 0,
    citations: [],
    droppedCitations: 0,
  };
}

function ensureEntry(
  ledger: TaskPaperLedger,
  paper: { key: string; libraryID: number; itemId: number },
): TaskPaperLedgerEntry | null {
  const existing = ledger.papers[paper.key];
  if (existing) return existing;
  if (ledger.order.length >= TASK_PAPER_MAX_PAPERS) {
    ledger.droppedPapers += 1;
    return null;
  }
  const entry: TaskPaperLedgerEntry = {
    key: paper.key,
    libraryID: paper.libraryID,
    itemId: paper.itemId,
    contextItemIds: [],
    text: "unknown",
    state: "listed",
    latestTurn: 0,
    turns: {},
  };
  ledger.papers[paper.key] = entry;
  ledger.order.push(paper.key);
  return entry;
}

function turnOf(entry: TaskPaperLedgerEntry, turnIndex: number) {
  const turn = entry.turns[turnIndex] || emptyTurn();
  entry.turns[turnIndex] = turn;
  entry.latestTurn = Math.max(entry.latestTurn, turnIndex);
  return turn;
}

function appliedCallKey(delta: TaskPaperLedgerDelta): string {
  return `${delta.runId || ""}:${delta.callId}`;
}

/**
 * Fold one delta into the ledger, in place, and return the ledger.
 *
 * Idempotent by `runId:callId`: a replayed delta changes nothing. States
 * only ever rise. `turnIndex` overrides the delta's own turn, for a store
 * that numbers turns from the conversation rather than from the event.
 *
 * A paper's reads for a question belong to one run: reads from another run
 * of the same question replace them, unless that run is one `options.newerRunIds`
 * names as later (history replayed after the session ran the retry) or one
 * already replaced. `options.runId`, when given, names the run over the
 * delta's own.
 */
export function applyTaskPaperLedgerDelta(
  ledger: TaskPaperLedger,
  delta: TaskPaperLedgerDelta,
  turnIndex?: number,
  options: { runId?: string; newerRunIds?: readonly string[] } = {},
): TaskPaperLedger {
  const callKey = appliedCallKey(delta);
  if (ledger.appliedCalls[callKey]) return ledger;
  ledger.appliedCalls[callKey] = true;
  const turn = turnIndex ?? delta.turnIndex ?? 0;
  const runId = options.runId || delta.runId || undefined;
  for (const paper of delta.papers) {
    const entry = ensureEntry(ledger, paper);
    if (!entry) continue;
    ledger.lastLibraryID = paper.libraryID;
    if (!entry.title && paper.title) entry.title = paper.title;
    if (!entry.year && paper.year) entry.year = paper.year;
    if (!entry.creator && paper.creator) entry.creator = paper.creator;
    if (!entry.itemKey && paper.itemKey) entry.itemKey = paper.itemKey;
    entry.text = strongerText(entry.text, paper.text);
    if (
      paper.contextItemId &&
      !entry.contextItemIds.includes(paper.contextItemId)
    ) {
      entry.contextItemIds.push(paper.contextItemId);
    }
    entry.state = strongerState(entry.state, paper.state);
    const record = turnOf(entry, turn);
    record.state = strongerState(record.state, paper.state);
    record.readState = strongerState(record.readState, paper.state);
  }
  for (const read of delta.reads) {
    const entry = ledger.papers[read.key];
    if (!entry) continue;
    const record = turnOf(entry, turn);
    if (runId && !takesReadsFrom(record, runId, options.newerRunIds)) continue;
    if (record.reads.length >= TASK_PAPER_MAX_READS_PER_TURN) {
      // A digest read is a part's result, and its block and verdict live
      // on it: it makes room by dropping the newest read that is not a
      // digest, and is never dropped itself. Any other read yields.
      const room =
        read.granularity === "digest" ? lastIndexOfNonDigest(record.reads) : -1;
      if (room >= 0) {
        record.reads.splice(room, 1);
        record.droppedReads += 1;
      } else if (read.granularity !== "digest") {
        record.droppedReads += 1;
        continue;
      }
    }
    record.reads.push({ ...read, turnIndex: turn });
  }
  return ledger;
}

function lastIndexOfNonDigest(reads: readonly TaskPaperReadEvent[]): number {
  for (let index = reads.length - 1; index >= 0; index -= 1) {
    if (reads[index].granularity !== "digest") return index;
  }
  return -1;
}

/**
 * Whether `record` takes a read from run `runId`: its own run's, or a newer
 * run's, which first clears the earlier run's reads.
 */
function takesReadsFrom(
  record: TaskPaperTurnRecord,
  runId: string,
  newerRunIds: readonly string[] = [],
): boolean {
  if (record.supersededRunIds?.includes(runId)) return false;
  const held = record.readsRunId;
  if (held === runId) return true;
  if (held && newerRunIds.includes(held)) {
    (record.supersededRunIds ||= []).push(runId);
    return false;
  }
  if (held) {
    (record.supersededRunIds ||= []).push(held);
    record.reads = [];
    record.droppedReads = 0;
  }
  record.readsRunId = runId;
  return true;
}

function isDocumentCitation(citation: TaskPaperCitation): boolean {
  return citation.source === "document";
}

/** A turn's state from its reads and whatever citations it still holds. */
function settleTurnState(turn: TaskPaperTurnRecord): void {
  turn.state =
    turn.citations.length ||
    turn.droppedCitations ||
    turn.droppedDocumentCitations
      ? "cited"
      : turn.readState;
}

/** A paper's state is the strongest over its turns. */
function settleEntryStates(entries: Iterable<TaskPaperLedgerEntry>): void {
  for (const entry of entries) {
    let state: TaskPaperState = "listed";
    for (const turn of Object.values(entry.turns)) {
      state = strongerState(state, turn.state);
    }
    entry.state = state;
  }
}

/**
 * Mark the papers the final answer cites, in place, and return the ledger.
 *
 * Replaces that turn's answer citations exactly: applying the same answer
 * twice is a no-op, and a citation the new answer dropped no longer counts,
 * so a paper cited only by it falls back to the strongest state its reads
 * earned. A document's citations (`applyDocumentCitations`) are kept.
 * Citations naming only an attachment attach to the paper already known to
 * own it; citations naming nothing known are dropped.
 */
export function applyFinalCitations(
  ledger: TaskPaperLedger,
  quoteCitations: readonly QuoteCitation[] | undefined,
  turnIndex: number,
  libraryID?: number,
): TaskPaperLedger {
  const touched = new Set<TaskPaperLedgerEntry>();
  for (const entry of Object.values(ledger.papers)) {
    const turn = entry.turns[turnIndex];
    if (!turn) continue;
    const kept = turn.citations.filter(isDocumentCitation);
    if (kept.length !== turn.citations.length || turn.droppedCitations) {
      touched.add(entry);
    }
    turn.citations = kept;
    turn.droppedCitations = 0;
    settleTurnState(turn);
  }
  const seen = new Set<string>();
  for (const citation of quoteCitations || []) {
    const entry = citationEntry(ledger, citation, libraryID);
    if (!entry) continue;
    const identity = `${entry.key}\u0000${citation.id}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    touched.add(entry);
    const turn = turnOf(entry, turnIndex);
    turn.state = "cited";
    const answerCitations = turn.citations.filter(
      (cited) => !isDocumentCitation(cited),
    ).length;
    if (answerCitations >= TASK_PAPER_MAX_CITATIONS_PER_TURN) {
      turn.droppedCitations += 1;
      continue;
    }
    const cited: TaskPaperCitation = { citationId: citation.id, turnIndex };
    const quote = clipTaskPaperText(
      citation.displayQuoteText || citation.quoteText,
      TASK_PAPER_CITATION_QUOTE_MAX_CHARS,
    );
    if (quote) cited.quote = quote;
    if (citation.citationLabel) cited.label = citation.citationLabel;
    if (citation.sourceSectionLabel) {
      cited.sectionLabel = citation.sourceSectionLabel;
    }
    if (citation.pageHintLabel) cited.pageLabel = citation.pageHintLabel;
    // Answer citations lead; a document's follow them.
    turn.citations.splice(answerCitations, 0, cited);
  }
  settleEntryStates(touched);
  return ledger;
}

/**
 * Mark the papers a submitted document cites, in place, and return the
 * ledger.
 *
 * Mirrors `applyFinalCitations` for the turn's `source: "document"`
 * citations only: re-applying the same sources is a no-op, a source the new
 * document dropped no longer counts, and the answer's own citations are
 * untouched. A source joins its paper by item key first, then by item id
 * (its own, or the one `resolve` finds), creating the entry when no read
 * recorded the paper; a source naming nothing resolvable is dropped.
 */
export function applyDocumentCitations(
  ledger: TaskPaperLedger,
  citations: readonly TaskPaperDocumentCitation[],
  turnIndex: number,
  resolve?: (
    citation: TaskPaperDocumentCitation,
  ) => TaskPaperResolvedRef | null | undefined,
): TaskPaperLedger {
  const touched = new Set<TaskPaperLedgerEntry>();
  for (const entry of Object.values(ledger.papers)) {
    const turn = entry.turns[turnIndex];
    if (!turn) continue;
    const kept = turn.citations.filter((cited) => !isDocumentCitation(cited));
    if (kept.length !== turn.citations.length || turn.droppedDocumentCitations)
      touched.add(entry);
    turn.citations = kept;
    delete turn.droppedDocumentCitations;
    settleTurnState(turn);
  }
  const seen = new Set<string>();
  for (const citation of citations || []) {
    if (!citation?.citationId) continue;
    const entry = documentCitationEntry(ledger, citation, resolve);
    if (!entry) continue;
    const identity = `${entry.key}\u0000${citation.citationId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    touched.add(entry);
    if (!entry.itemKey && citation.itemKey && namesPaperItself(entry, citation))
      entry.itemKey = citation.itemKey;
    const turn = turnOf(entry, turnIndex);
    turn.state = "cited";
    const documentCitations = turn.citations.filter(isDocumentCitation).length;
    if (documentCitations >= TASK_PAPER_MAX_CITATIONS_PER_TURN) {
      turn.droppedDocumentCitations = (turn.droppedDocumentCitations || 0) + 1;
      continue;
    }
    const cited: TaskPaperCitation = {
      citationId: citation.citationId,
      turnIndex,
      source: "document",
    };
    const sectionLabel = clipTaskPaperText(citation.sectionLabel, 120);
    if (sectionLabel) cited.sectionLabel = sectionLabel;
    const sectionLabels = [
      ...new Set(
        (Array.isArray(citation.sectionLabels) ? citation.sectionLabels : [])
          .map((label) => clipTaskPaperText(label, 120))
          .filter((label): label is string => Boolean(label)),
      ),
    ].slice(0, TASK_PAPER_MAX_DOCUMENT_SECTIONS);
    if (sectionLabels.length > 1) cited.sectionLabels = sectionLabels;
    turn.citations.push(cited);
  }
  settleEntryStates(touched);
  return ledger;
}

function documentCitationEntry(
  ledger: TaskPaperLedger,
  citation: TaskPaperDocumentCitation,
  resolve?: (
    citation: TaskPaperDocumentCitation,
  ) => TaskPaperResolvedRef | null | undefined,
): TaskPaperLedgerEntry | null {
  const libraryID = positive(citation.libraryID);
  const itemKey = text(citation.itemKey);
  const entries = Object.values(ledger.papers);
  if (libraryID && itemKey) {
    const known = entries.find(
      (entry) => entry.libraryID === libraryID && entry.itemKey === itemKey,
    );
    if (known) return known;
  }
  const ownId = positive(citation.itemId);
  // A source that names an attachment belongs to the paper known to own it.
  if (ownId) {
    const owner = entries.find(
      (entry) =>
        (!libraryID || entry.libraryID === libraryID) &&
        entry.contextItemIds.includes(ownId),
    );
    if (owner) return owner;
  }
  // The host resolver climbs from an attachment to its parent paper.
  const resolved = resolve?.(citation);
  const itemId = positive(resolved?.itemId) || ownId;
  const resolvedLibrary = libraryID || positive(resolved?.libraryID);
  if (!itemId || !resolvedLibrary) return null;
  const key = taskPaperKey(resolvedLibrary, itemId);
  const created = !ledger.papers[key];
  const entry =
    ledger.papers[key] ||
    ensureEntry(ledger, { key, libraryID: resolvedLibrary, itemId });
  if (!entry) return null;
  if (ownId && ownId !== itemId && !entry.contextItemIds.includes(ownId)) {
    entry.contextItemIds.push(ownId);
  }
  if (created || !entry.title) {
    const title = text(citation.title);
    if (title && !entry.title) entry.title = title;
    const creator = text(citation.firstCreator);
    if (creator && !entry.creator) entry.creator = creator;
    const year = text(citation.year);
    if (year && !entry.year) entry.year = year;
  }
  return entry;
}

/** The citation names this paper itself, not one of its attachments. */
function namesPaperItself(
  entry: TaskPaperLedgerEntry,
  citation: TaskPaperDocumentCitation,
): boolean {
  const ownId = positive(citation.itemId);
  if (ownId) return ownId === entry.itemId;
  return !entry.contextItemIds.length;
}

function citationEntry(
  ledger: TaskPaperLedger,
  citation: QuoteCitation,
  libraryID?: number,
): TaskPaperLedgerEntry | null {
  const itemId = positive(citation.itemId);
  const contextItemId = positive(citation.contextItemId);
  if (itemId) {
    if (libraryID) {
      return (
        ledger.papers[taskPaperKey(libraryID, itemId)] ||
        ensureEntry(ledger, {
          key: taskPaperKey(libraryID, itemId),
          libraryID,
          itemId,
        })
      );
    }
    const known = Object.values(ledger.papers).find(
      (entry) => entry.itemId === itemId,
    );
    if (known) return known;
    const fallback = ledger.lastLibraryID;
    return fallback
      ? ensureEntry(ledger, {
          key: taskPaperKey(fallback, itemId),
          libraryID: fallback,
          itemId,
        })
      : null;
  }
  if (contextItemId) {
    return (
      Object.values(ledger.papers).find((entry) =>
        entry.contextItemIds.includes(contextItemId),
      ) || null
    );
  }
  return null;
}

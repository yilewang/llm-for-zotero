/**
 * The Task progress row (under the panel header) and its drawer: the one
 * task-progress view in the plugin.
 *
 * The row names the run's state and counts; clicking it unrolls the drawer, a
 * card attached under the row at the top of `#llm-chat-shell`. The drawer is
 * in the flow: the chat below it shrinks (to no less than a strip the CSS
 * keeps) while its messages stay mounted, and the chat's scroll owner keeps
 * the reading position or the follow-bottom intent. The drawer is as tall as
 * its content, up to the space above that strip or the height the user
 * dragged it to (remembered for the session, in memory only). It lists every
 * paper in the turn's scope in order, windowed, with what was read from each
 * and where the answer cites it; while a built-in action, Codex's own plan
 * or a run's declared outcomes are in progress, their steps lead the drawer.
 *
 * Opening and closing animate the drawer's height between measured pixel
 * heights (CSS cannot transition to `auto`); with reduced motion, or without
 * a layout (unit tests), every change settles at once.
 *
 * The row itself is there only when it has something to show
 * (`visibility.ts`), or when the user showed it with the standalone window's
 * button (`panel.ts`). When it comes or goes in the conversation on screen it
 * lowers from under the header, or rises back, like a curtain: the card sits
 * in a curtain whose height moves between 0 and the card's, while the card
 * slides by its own height inside it, clipped at the curtain's top edge. The
 * chat below follows the curtain's height and keeps its reading place on
 * every frame. A mount, a conversation switch and a conversation still
 * loading put the row in its state at once.
 *
 * The row's counts describe the latest question. Once the conversation has
 * an earlier question (or built-in action) with steps or papers to show, the
 * drawer is a short history, newest first: the current question named above
 * its own steps and papers, then each earlier one folded to a header (its
 * words, how it ended, its counts) that unrolls its own steps and papers. In
 * a question's list a paper shows only what that question read and cited,
 * so a paper two questions read is listed under both. With one question the
 * drawer shows no history.
 *
 * Repaints are coalesced to at most four a second. The paper list is built
 * only while the drawer is open, an earlier question's rows only while it is
 * unrolled, and a paper's details only while expanded.
 */
import {
  TASK_PAPER_DIGEST_LABEL_MAX_CHARS,
  type TaskPaperLedgerEntry,
  type TaskPaperReadEvent,
  type TaskPaperState,
  type TaskPaperTextSource,
} from "../../../agent/context/taskPaperLedger";
import type { TaskPaperScopeEntry } from "../../../agent/context/taskPaperScopeListing";
import type { RunEndState } from "../../../agent/execution/types";
import { t } from "../../../utils/i18n";
import {
  canOpenTaskPaperPassage,
  taskPaperPassagePageLabel,
  type TaskPaperPassageTarget,
} from "./passageSource";
import { renderChecklistSteps, resolveTaskPaperLabel } from "./planSteps";
import {
  displayedTaskRunState,
  getTaskProgress,
  getTaskProgressViewMemo,
  isInDepthRead,
  isTaskRunLive,
  rememberTaskProgressView,
  subscribeTaskProgress,
  taskQuestionChecklist,
  taskQuestionState,
  taskReadInDepth,
  type TaskProgressChecklist,
  type TaskProgressQuestion,
  type TaskProgressRecord,
  type TaskRunState,
} from "./store";
import {
  shouldAnimateTaskProgressRow,
  shouldShowTaskProgress,
  taskProgressContextApplies,
  type TaskProgressRowFrame,
  type TaskProgressVisibilityInput,
} from "./visibility";

/** Paper rows built at a time; more are added as the list scrolls. */
export const TASK_PROGRESS_WINDOW = 80;
/** Minimum spacing of store-driven repaints: at most four a second. */
export const TASK_PROGRESS_REPAINT_MS = 250;
/** How long a cited quote card stays highlighted after a jump. */
export const TASK_PROGRESS_FLASH_MS = 1400;
/** The least height a drag leaves the drawer (less only if less fits). */
export const TASK_PROGRESS_DRAWER_MIN_PX = 96;
/** One arrow-key step on the drag handle; Shift makes it four. */
const DRAWER_KEY_STEP_PX = 16;
/** Past the transition's own duration, when a missed `transitionend` settles. */
const SETTLE_GRACE_MS = 80;

const ROW_ID = "llm-task-progress";
const DRAWER_ID = "llm-task-progress-drawer";
/** On the shell from the moment the drawer unrolls until it is rolled up. */
const SHOWN_CLASS = "llm-task-progress-shown";
/**
 * Dispatched (bubbling) when the user removes a paper from the list; the
 * panel that owns the context bar removes or excludes it.
 */
export const TASK_PROGRESS_REMOVE_PAPER_EVENT =
  "llm-task-progress-remove-paper";
/**
 * Dispatched (bubbling) when the user asks to see a passage in its paper;
 * the detail is a `TaskPaperPassageTarget`. The panel opens the reader.
 */
export const TASK_PROGRESS_OPEN_PASSAGE_EVENT =
  "llm-task-progress-open-passage";
/** On the chat shell while the Task progress card is in it. */
const PRESENT_CLASS = "llm-task-progress-present";
/** The box the card lowers from and rises into (`createTaskProgressCurtain`). */
const CURTAIN_CLASS = "llm-task-progress-curtain";
/** On the chat shell while the card is in it: where the row's curtain stands. */
const SHELL_CURTAIN_ATTR = "data-task-progress-curtain";
/** On the panel while the drag handle is held. */
const RESIZING_CLASS = "llm-task-progress-resizing";
/** On the row's parent while the row shows: the header drops its divider. */
const ROW_SHOWN_ATTR = "data-task-progress-row";
const DRAWER_MAX_VAR = "--llm-task-progress-drawer-max";
/** The drawer's current height, for the shell's absolutely placed children. */
const DRAWER_INSET_VAR = "--llm-task-progress-inset";
const FLASH_CLASS = "llm-task-progress-flash";

/**
 * The height the user dragged the drawer to, for this session only. Not a
 * pref: persisted state needs the user's sign-off.
 */
let rememberedDrawerHeight: number | null = null;

export function getRememberedTaskProgressDrawerHeight(): number | null {
  return rememberedDrawerHeight;
}

export function resetTaskProgressDrawerHeight(): void {
  rememberedDrawerHeight = null;
}

function format(template: string, values: Record<string, string | number>) {
  return t(template).replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export type TaskProgressPaperRow = {
  key: string;
  /** 1-based position in scope order. */
  index: number;
  libraryID: number;
  itemId: number;
  title: string;
  creator: string;
  year: string;
  folders: string[];
  tags: string[];
  scopeText: TaskPaperScopeEntry["text"] | "unknown";
  /** False for a paper the ledger holds but the scope listing does not. */
  inScope: boolean;
  entry?: TaskPaperLedgerEntry;
  /** Strongest state over every question in the conversation. */
  state: TaskPaperState;
  /** State in the latest question alone: what the counts add up. */
  turnState: TaskPaperState;
};

/** The turn a row summarizes: the latest run's, or every turn before any. */
function summaryTurn(record: TaskProgressRecord | null): number {
  return record?.turnIndex || 0;
}

export function paperStateForTurn(
  entry: TaskPaperLedgerEntry | undefined,
  turn: number,
): TaskPaperState {
  if (!entry) return "listed";
  if (!turn) return entry.state;
  return entry.turns[turn]?.state || "listed";
}

/** Whether question `turn` read, cited or found the paper. */
function touchedInTurn(entry: TaskPaperLedgerEntry, turn: number): boolean {
  const own = entry.turns[turn];
  return Boolean(
    own && (own.state !== "listed" || own.reads.length || own.citations.length),
  );
}

/** The paper as one question saw it: that question's reads and citations only. */
function entryForTurn(
  entry: TaskPaperLedgerEntry,
  turn: number,
): TaskPaperLedgerEntry {
  const own = entry.turns[turn];
  return {
    ...entry,
    state: own?.state || "listed",
    latestTurn: turn,
    turns: own ? { [turn]: own } : {},
  };
}

/**
 * The drawer's rows: the scope in order, then any paper the ledger holds
 * that the scope listing does not (read outside the attached scope, or past
 * the whole-library cap).
 *
 * Given `turn`, the rows are that question's: each paper shows only what
 * that question read and cited, and a paper outside the scope lists only
 * when that question touched it.
 */
export function buildTaskProgressPaperRows(
  record: TaskProgressRecord | null,
  options: { turn?: number } = {},
): TaskProgressPaperRow[] {
  if (!record) return [];
  const only = options.turn;
  const turn = summaryTurn(record);
  const own = (entry: TaskPaperLedgerEntry | undefined) =>
    entry && only !== undefined ? entryForTurn(entry, only) : entry;
  const rows: TaskProgressPaperRow[] = [];
  const seen = new Set<string>();
  for (const scope of record.scope?.listing?.entries || []) {
    if (seen.has(scope.key)) continue;
    seen.add(scope.key);
    const full = record.ledger.papers[scope.key];
    const entry = own(full);
    rows.push({
      key: scope.key,
      index: rows.length + 1,
      libraryID: scope.libraryID,
      itemId: scope.itemId,
      title: scope.title || entry?.title || `#${scope.itemId}`,
      creator: scope.firstCreator || entry?.creator || "",
      year: scope.year || entry?.year || "",
      folders: scope.collectionPaths,
      tags: scope.tags,
      scopeText: scope.text,
      inScope: true,
      entry,
      state: entry?.state || "listed",
      turnState:
        only === undefined
          ? paperStateForTurn(full, turn)
          : entry?.state || "listed",
    });
  }
  for (const key of record.ledger.order) {
    if (seen.has(key)) continue;
    const full = record.ledger.papers[key];
    if (!full || (only !== undefined && !touchedInTurn(full, only))) continue;
    const entry = own(full)!;
    seen.add(key);
    rows.push({
      key,
      index: rows.length + 1,
      libraryID: entry.libraryID,
      itemId: entry.itemId,
      title: entry.title || `#${entry.itemId}`,
      creator: entry.creator || "",
      year: entry.year || "",
      folders: [],
      tags: [],
      scopeText: "unknown",
      inScope: false,
      entry,
      state: entry.state,
      turnState:
        only === undefined ? paperStateForTurn(entry, turn) : entry.state,
    });
  }
  return rows;
}

/** Counts for the latest question. */
export type TaskProgressCounts = {
  total: number;
  matched: number;
  read: number;
  cited: number;
  /** Papers whose text a read took in (`isInDepthRead`), of `matched`. */
  inDepth: number;
};

const STATE_RANK: Record<TaskPaperState, number> = {
  listed: 0,
  matched: 1,
  skimmed: 2,
  read: 3,
  cited: 4,
};

/** Whether the turn `turn` (every turn, before any) read `entry` in depth. */
function readInDepth(
  entry: TaskPaperLedgerEntry | undefined,
  turn: number,
): boolean {
  if (!entry) return false;
  const turns = turn ? [entry.turns[turn]] : Object.values(entry.turns || {});
  return turns.some((record) => record?.reads.some(isInDepthRead));
}

export function countTaskProgress(
  record: TaskProgressRecord | null,
  rows: TaskProgressPaperRow[] = buildTaskProgressPaperRows(record),
): TaskProgressCounts {
  const turn = summaryTurn(record);
  const counts: TaskProgressCounts = {
    total: Math.max(
      rows.length,
      (record?.scope?.listing?.totalItems || 0) +
        rows.filter((row) => !row.inScope).length,
    ),
    matched: 0,
    read: 0,
    cited: 0,
    inDepth: 0,
  };
  for (const row of rows) {
    const rank = STATE_RANK[row.turnState];
    if (rank >= STATE_RANK.matched) counts.matched += 1;
    if (rank >= STATE_RANK.skimmed) counts.read += 1;
    if (rank >= STATE_RANK.cited) counts.cited += 1;
    if (rank >= STATE_RANK.matched && readInDepth(row.entry, turn))
      counts.inDepth += 1;
  }
  return counts;
}

/** The steps the row counts: the checklist's. */
function currentSteps(record: TaskProgressRecord | null) {
  const checklist = record?.checklist;
  if (checklist && checklist.total > 0) {
    return { completed: checklist.done, total: checklist.total };
  }
  return null;
}

/** What a built-in action is doing, or how it ended. */
function actionText(record: TaskProgressRecord | null): string {
  const checklist = record?.checklist;
  if (checklist?.source !== "action") return "";
  const current = checklist.steps.find((step) => step.status === "in_progress");
  return (
    checklist.detail ||
    checklist.summary ||
    current?.label ||
    (checklist.outcome ? "" : checklist.title)
  );
}

/**
 * The row's status pill for a shown state, or empty while the run works.
 * Short, so the count beside it keeps its room; the Steps header says the
 * full phrase.
 */
export function taskRunStatePill(state: TaskRunState | RunEndState): string {
  switch (state) {
    case "completed":
      return t("Completed");
    case "failed":
      return t("Failed");
    case "cancelled":
      return t("Cancelled");
    case "completed_with_exceptions":
      return t("Partly done");
    case "blocked":
    case "waiting":
      return t("Needs input");
    case "interrupted":
      return t("Interrupted");
  }
  return "";
}

/**
 * "8 of 10 done": what a run that completed with exceptions reports when its
 * one outcome is a write over named targets. Empty otherwise.
 */
function targetedWriteText(record: TaskProgressRecord | null): string {
  const checklist = record?.checklist;
  if (
    checklist?.source !== "outcomes" ||
    displayedTaskRunState(record) !== "completed_with_exceptions" ||
    checklist.steps.length !== 1
  )
    return "";
  const outcome = checklist.steps[0].outcome;
  if (!outcome?.write || !outcome.targets) return "";
  return format("{done} of {total} done", {
    done: outcome.doneTargets,
    total: outcome.targets,
  });
}

/** Papers the run's parts over the whole scope cover; 0 without one. */
function scopeWidePapers(record: TaskProgressRecord | null): number {
  const checklist = record?.checklist;
  return checklist?.source === "outcomes" ? checklist.scopePapers || 0 : 0;
}

function papersInScopeText(count: number): string {
  return count === 1
    ? t("1 paper in scope")
    : format("{count} papers in scope", { count });
}

/**
 * The row's count text, e.g. "37 of 200 read · 12 cited". A run with a part
 * over every paper of its scope counts those papers on the part's own row,
 * so this names the scope the part froze: "2/4 steps · 212 papers in scope".
 * With nothing attached, the papers read in depth and those only found are
 * counted apart, a zero left out: "2/2 steps · 3 read in depth · 15 found ·
 * 2 cited".
 */
export function formatTaskProgressCount(
  record: TaskProgressRecord | null,
  recordsReads: boolean,
  counts: TaskProgressCounts = countTaskProgress(record),
): string {
  const state: TaskRunState = record?.runState || "idle";
  const steps = currentSteps(record);
  const stepsText =
    targetedWriteText(record) ||
    (steps
      ? format("{done}/{total} steps", {
          done: steps.completed,
          total: steps.total,
        })
      : "");
  // A built-in action records no reads: the row says what it is doing.
  if (record?.checklist?.source === "action") {
    const parts = [stepsText, actionText(record)].filter(Boolean);
    return parts.join(" · ");
  }
  const scopePapers = scopeWidePapers(record);
  if (scopePapers) {
    const parts = state === "answering" ? [t("Answering…")] : [];
    if (stepsText) parts.push(stepsText);
    parts.push(papersInScopeText(scopePapers));
    return parts.join(" · ");
  }
  const papersKnown = counts.total > 0;
  if (!papersKnown) {
    return stepsText;
  }
  if (!recordsReads || state === "idle") {
    const inScope = papersInScopeText(counts.total);
    return stepsText ? `${stepsText} · ${inScope}` : inScope;
  }
  const parts: string[] = [];
  if (state === "answering") parts.push(t("Answering…"));
  if (stepsText) parts.push(stepsText);
  if (record?.scope?.listing?.wholeLibrary) {
    // Nothing attached: the agent chose its papers, so the row tells the
    // papers it read in depth from those its searches only found.
    const found = counts.matched - counts.inDepth;
    if (counts.inDepth)
      parts.push(format("{count} read in depth", { count: counts.inDepth }));
    if (found) parts.push(format("{count} found", { count: found }));
  } else {
    parts.push(
      format("{read} of {total} read", {
        read: counts.read,
        total: counts.total,
      }),
    );
  }
  if (counts.cited)
    parts.push(format("{count} cited", { count: counts.cited }));
  return parts.join(" · ");
}

const GRANULARITY_LABELS: Record<TaskPaperReadEvent["granularity"], string> = {
  metadata: "Title/abstract match",
  abstract: "Abstract",
  outline: "Outline",
  section: "Passage",
  passage: "Passage",
  full: "Full text",
  figure: "Figure",
  page: "Page",
  digest: "Summary",
};

function looseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Where in the paper a read came from: its section ("Methods §2.3",
 * "Abstract", "p. 4"), or the kind of read when no section is known. A label
 * that only repeats the paper's title says nothing and is dropped.
 */
export function formatTaskPaperPassageLabel(
  read: TaskPaperReadEvent,
  paperTitle = "",
): string {
  const kind = t(GRANULARITY_LABELS[read.granularity] || "Passage");
  const label = (read.label || "").trim();
  const title = looseText(paperTitle);
  const loose = looseText(label);
  const repeatsTitle =
    Boolean(title && loose) &&
    (loose === title || title.startsWith(loose) || loose.startsWith(title));
  if (read.granularity === "digest") {
    return read.snippet ? kind : t("Summary failed");
  }
  if (!label || repeatsTitle || read.granularity === "full") return kind;
  if (read.granularity === "outline") return `${kind}: ${label}`;
  return label;
}

/**
 * A snippet as prose: no chunk markers, no Markdown heading marks (also one a
 * collapsed snippet carries mid-line), no TeX, one line.
 */
export function cleanTaskPaperSnippet(snippet: string): string {
  return snippet
    .replace(/\[chunk \d+[^\]]*\]\s*/g, "")
    .replace(/(^|\s)#{1,6}[ \t]+/g, "$1")
    .replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The reads worth listing: what was actually read, once each. A host
 * digest shows in its part's own block (`paperDigests`), not as a read.
 */
function visibleReads(reads: readonly TaskPaperReadEvent[]) {
  const seen = new Set<string>();
  return reads.filter((read) => {
    if (read.granularity === "metadata" || read.granularity === "digest")
      return false;
    const key = `${read.granularity}\u0000${read.label || ""}\u0000${read.snippet || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceLabel(row: TaskProgressPaperRow, mineruKnown: boolean): string {
  const text: TaskPaperTextSource = row.entry?.text || "unknown";
  if (text === "mineru" || mineruKnown) return "MinerU";
  if (text === "pdf_text" || text === "indexed") return t("PDF text");
  if (text === "pdf") return "PDF";
  if (text === "none") return t("No text");
  if (row.scopeText === "pdf") return "PDF";
  if (row.scopeText === "none") return t("No text");
  return "";
}

function metaText(row: TaskProgressPaperRow): string {
  const who = [row.creator, row.year].filter(Boolean).join(" ");
  return [who, row.folders.join(", "), row.tags.join(", ")]
    .filter(Boolean)
    .join(" · ");
}

/** Section names a targeted read gave: neither a page nor the paper's title. */
function readSectionLabel(
  read: TaskPaperReadEvent,
  paperTitle: string,
): string {
  if (read.granularity !== "section" && read.granularity !== "passage")
    return "";
  const label = (read.label || "").trim();
  if (!label || taskPaperPassagePageLabel(label)) return "";
  const title = looseText(paperTitle);
  const loose = looseText(label);
  if (
    title &&
    loose &&
    (loose === title || title.startsWith(loose) || loose.startsWith(title))
  )
    return "";
  return label;
}

/**
 * The paper's newest host digest over every part: the latest one with an
 * answer, else the latest failure (no answer; `whyMatched` holds the host's
 * reason), else null.
 */
function paperDigest(
  reads: readonly TaskPaperReadEvent[],
): TaskPaperReadEvent | null {
  let failed: TaskPaperReadEvent | null = null;
  let done: TaskPaperReadEvent | null = null;
  for (const read of reads) {
    if (read.granularity !== "digest") continue;
    if (read.snippet) done = read;
    else failed = read;
  }
  return done || failed;
}

/**
 * The paper's host digests, one per part, in the order the parts first
 * appeared: each part's latest result with an answer, else its latest
 * failure. Reads saved before parts were recorded have no `partId`; they
 * are one part, shown as "Summary".
 */
function paperDigests(
  reads: readonly TaskPaperReadEvent[],
): TaskPaperReadEvent[] {
  const parts = new Map<string, TaskPaperReadEvent[]>();
  for (const read of reads) {
    if (read.granularity !== "digest") continue;
    const part = parts.get(read.partId || "");
    if (part) part.push(read);
    else parts.set(read.partId || "", [read]);
  }
  return [...parts.values()].map((part) => paperDigest(part)!);
}

/**
 * A digest's part label, as the host cut it (at most 60 characters; a
 * longer saved one is clipped); empty on a read saved before parts were
 * recorded.
 */
function digestPartLabel(read: TaskPaperReadEvent): string {
  const label = (read.label || "").trim();
  const max = TASK_PAPER_DIGEST_LABEL_MAX_CHARS;
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/** A failed digest's words: "<label> failed", or "Summary failed". */
function digestFailedText(read: TaskPaperReadEvent): string {
  const label = digestPartLabel(read);
  return label ? format("{label} failed", { label }) : t("Summary failed");
}

const RELEVANCE_WORDS = new Map<string, string>([
  ["direct", "Directly relevant"],
  ["partial", "Partly relevant"],
  ["none", "Not relevant"],
  ["unclear", "Relevance unclear"],
]);

const STANCE_WORDS = new Map<string, string>([
  ["supports", "Supports"],
  ["challenges", "Challenges"],
  ["mixed", "Mixed"],
  ["unclear", "Stance unclear"],
]);

/**
 * A digest's judgment as a line, "Directly relevant — <reason>"; empty for
 * a value this version does not know.
 */
function digestJudgmentText(
  word: string | undefined,
  reason: string | undefined,
): string {
  if (!word) return "";
  const why = `${reason || ""}`.replace(/\s+/g, " ").trim();
  return why ? `${t(word)} — ${why}` : t(word);
}

/** Section names the tail lists before it says "…". */
const TAIL_SECTIONS = 3;

/**
 * The row's tail over every question: "Full text" for a whole-paper read;
 * for a paper the host digested, its evidence passage count (when no
 * evidence survived, the label of the part whose answer came last, or
 * "Summary"); else the sections a targeted read named ("Methods,
 * Results"), else a passage count; then "cited N". A paper whose digests
 * all failed and that nothing else read says "<label> failed" ("Summary
 * failed"). Never a byte size or a section count.
 */
export function formatTaskPaperTail(row: TaskProgressPaperRow): string {
  if (row.state === "listed") return "";
  const turns = Object.values(row.entry?.turns || {});
  const reads = turns.flatMap((entry) => entry.reads);
  const digest = paperDigest(reads);
  if (row.state === "matched") {
    return digest && !digest.snippet
      ? digestFailedText(digest)
      : t("title/abstract");
  }
  const citations = turns.flatMap((entry) => entry.citations);
  // The digest's summary is the host's words, not a passage of the paper.
  // The same passage read again (another question, a retry) counts once.
  const passages = new Set(
    reads
      .filter((read) => read.snippet && read.granularity !== "digest")
      .map((read) => read.snippet),
  ).size;
  const passageCount = () =>
    passages === 1
      ? t("1 passage")
      : format("{count} passages", { count: passages });
  const parts: string[] = [];
  const sections = [
    ...new Set(
      reads.map((read) => readSectionLabel(read, row.title)).filter(Boolean),
    ),
  ];
  if (reads.some((read) => read.granularity === "full")) {
    parts.push(t("Full text"));
  } else if (digest?.snippet) {
    parts.push(
      passages ? passageCount() : digestPartLabel(digest) || t("Summary"),
    );
  } else if (sections.length) {
    parts.push(
      sections.slice(0, TAIL_SECTIONS).join(", ") +
        (sections.length > TAIL_SECTIONS ? "…" : ""),
    );
  } else if (passages) {
    parts.push(passageCount());
  } else if (row.state === "skimmed") {
    const last = reads[reads.length - 1];
    parts.push(last?.granularity === "outline" ? t("outline") : t("abstract"));
  }
  if (citations.length) {
    parts.push(format("cited {count}", { count: citations.length }));
  }
  return parts.join(" · ");
}

/**
 * A row whose summarized question only had `paper_read` find no text for it
 * (metadata reads alone) and cited nothing. Such rows fold into the count
 * instead of listing; a search listing's matched rows still list.
 */
export function isMetadataOnlyRow(
  row: TaskProgressPaperRow,
  turn: number,
): boolean {
  const entry = row.entry;
  if (!entry || STATE_RANK[row.state] >= STATE_RANK.skimmed) return false;
  const turns = turn
    ? [entry.turns[turn]].filter(Boolean)
    : Object.values(entry.turns);
  const reads = turns.flatMap((record) => record.reads);
  if (!reads.length) return false;
  if (turns.some((record) => record.citations.length)) return false;
  return reads.every(
    (read) => read.granularity === "metadata" && read.toolName === "paper_read",
  );
}

/**
 * The rows the drawer lists: every row but the metadata-only ones, numbered
 * in the order they list. Rows of one question (`buildTaskProgressPaperRows`
 * given a turn) hold that question alone, so `turn` 0 (every turn) folds
 * them by it.
 */
export function listedTaskProgressPaperRows(
  record: TaskProgressRecord | null,
  rows: TaskProgressPaperRow[] = buildTaskProgressPaperRows(record),
  turn: number = summaryTurn(record),
): TaskProgressPaperRow[] {
  return rows
    .filter((row) => !isMetadataOnlyRow(row, turn))
    .map((row, index) =>
      row.index === index + 1 ? row : { ...row, index: index + 1 },
    );
}

// ---------------------------------------------------------------------------
// Questions: the drawer's history
// ---------------------------------------------------------------------------

/** Characters of the user's words a question's header shows. */
export const TASK_PROGRESS_QUESTION_WORDS_MAX_CHARS = 60;

/**
 * The user's words as a question's header shows them: one line, at most 60
 * characters, cut at a word (with "…") when longer.
 */
export function clipTaskQuestionWords(text: string | undefined): string {
  const clean = `${text ?? ""}`.replace(/\s+/g, " ").trim();
  const max = TASK_PROGRESS_QUESTION_WORDS_MAX_CHARS;
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  // An unspaced script (Han, kana) has no word to cut at.
  const cut = space > max / 2 ? head.slice(0, space) : head;
  return `${cut.replace(/[\s,;:.]+$/u, "")}…`;
}

/**
 * A section's name: "Question 2 · “<the user's words>”"; a built-in action
 * is named by its title, and the request typed with it when there was one.
 */
export function formatTaskQuestionLabel(
  question: TaskProgressQuestion,
): string {
  return splitTaskQuestionLabel(question).join("");
}

/**
 * A question's label in two parts: its name ("Question 2", or an action's
 * name) and its words (" · “…”", or "“…”" without a name).
 */
export function splitTaskQuestionLabel(
  question: TaskProgressQuestion,
): [string, string] {
  const name =
    question.turn > 0
      ? format("Question {number}", { number: question.turn })
      : question.title || "";
  const words = clipTaskQuestionWords(question.text);
  if (!words) return [name, ""];
  return [name, name ? ` · “${words}”` : `“${words}”`];
}

/**
 * One question (or built-in action) in the drawer. The current one's steps
 * and papers are the drawer's own block and list; an earlier one's unroll
 * under its header.
 */
export type TaskProgressSection = {
  /** Its key in the view memo: "question:<number>", or "action:<run id>". */
  id: string;
  question: TaskProgressQuestion;
  /** The one the row describes. */
  current: boolean;
  label: string;
  state: TaskRunState | RunEndState;
  /** Its steps, when there are steps to show. */
  checklist: TaskProgressChecklist | null;
  /** An earlier question's papers; the current one lists the drawer's own. */
  rows: TaskProgressPaperRow[];
};

/** A ledger that only recorded its ending has no steps to show. */
function shownChecklist(
  checklist: TaskProgressChecklist | null | undefined,
): TaskProgressChecklist | null {
  return checklist &&
    (checklist.source !== "outcomes" || checklist.steps.length)
    ? checklist
    : null;
}

function sectionId(question: TaskProgressQuestion): string {
  return question.turn > 0
    ? `question:${question.turn}`
    : `action:${question.runId || ""}`;
}

/**
 * The papers an earlier question read, cited or found, in the order the
 * ledger first saw them, each with that question's reads only. A paper in
 * the scope keeps the scope's details, but only the current question's rows
 * can be removed.
 */
function questionRows(
  record: TaskProgressRecord,
  turn: number,
  keys: readonly string[],
  scopeEntries: ReadonlyMap<string, TaskPaperScopeEntry>,
): TaskProgressPaperRow[] {
  const rows: TaskProgressPaperRow[] = [];
  for (const key of keys) {
    const full = record.ledger.papers[key];
    if (!full) continue;
    const entry = entryForTurn(full, turn);
    const scope = scopeEntries.get(key);
    const row: TaskProgressPaperRow = {
      key,
      index: rows.length + 1,
      libraryID: entry.libraryID,
      itemId: entry.itemId,
      title: scope?.title || entry.title || `#${entry.itemId}`,
      creator: scope?.firstCreator || entry.creator || "",
      year: scope?.year || entry.year || "",
      folders: scope?.collectionPaths || [],
      tags: scope?.tags || [],
      scopeText: scope?.text || "unknown",
      inScope: false,
      entry,
      state: entry.state,
      turnState: entry.state,
    };
    if (!isMetadataOnlyRow(row, 0)) rows.push(row);
  }
  return rows;
}

/**
 * The drawer's history, newest first: the current question (or action),
 * then each earlier one that has steps or papers to show. With one section
 * the drawer shows no history, as before there was one.
 */
export function buildTaskProgressSections(
  record: TaskProgressRecord | null,
): TaskProgressSection[] {
  const questions = record?.questions || [];
  if (!record || !questions.length) return [];
  // Every paper each earlier question touched, in one pass over the ledger;
  // with one question there is none to look for.
  const keysByTurn = new Map<number, string[]>();
  const scopeEntries = new Map<string, TaskPaperScopeEntry>();
  if (questions.length > 1) {
    for (const key of record.ledger.order) {
      const entry = record.ledger.papers[key];
      if (!entry) continue;
      for (const turn of Object.keys(entry.turns).map(Number)) {
        if (!(turn > 0) || !touchedInTurn(entry, turn)) continue;
        const keys = keysByTurn.get(turn);
        if (keys) keys.push(key);
        else keysByTurn.set(turn, [key]);
      }
    }
    for (const entry of record.scope?.listing?.entries || [])
      scopeEntries.set(entry.key, entry);
  }
  const sections: TaskProgressSection[] = [];
  for (let index = questions.length - 1; index >= 0; index--) {
    const question = questions[index];
    const current = index === questions.length - 1;
    const checklist = shownChecklist(taskQuestionChecklist(record, question));
    const rows =
      current || !(question.turn > 0)
        ? []
        : questionRows(
            record,
            question.turn,
            keysByTurn.get(question.turn) || [],
            scopeEntries,
          );
    if (!current && !checklist && !rows.length) continue;
    sections.push({
      id: sectionId(question),
      question,
      current,
      label: formatTaskQuestionLabel(question),
      state: taskQuestionState(record, question),
      checklist,
      rows,
    });
  }
  return sections;
}

/** An earlier question's counts: "2/2 steps · 8 papers", a zero left out. */
export function formatTaskQuestionCounts(section: TaskProgressSection): string {
  const parts: string[] = [];
  const checklist = section.checklist;
  if (checklist && checklist.total > 0) {
    parts.push(
      format("{done}/{total} steps", {
        done: checklist.done,
        total: checklist.total,
      }),
    );
  }
  const papers = section.rows.length;
  if (papers) {
    parts.push(
      format(papers === 1 ? "{count} paper" : "{count} papers", {
        count: papers,
      }),
    );
  }
  return parts.join(" · ");
}

const STATE_LABELS: Record<TaskPaperState, string> = {
  listed: "listed",
  matched: "matched",
  skimmed: "skimmed",
  read: "read",
  cited: "cited",
};

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

function svg(
  doc: Document,
  tag: string,
  attrs: Record<string, string>,
  children: Element[] = [],
): Element {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs))
    node.setAttribute(name, value);
  node.append(...children);
  return node;
}

/** A 20px status ring: a spinning arc while working, a badge once settled. */
function createStatusRing(doc: Document): HTMLElement {
  const ring = el(doc, "span", "llm-task-progress-ring");
  ring.setAttribute("aria-hidden", "true");
  const circle = (className: string, extra: Record<string, string> = {}) =>
    svg(doc, "circle", {
      class: className,
      cx: "10",
      cy: "10",
      r: "8.5",
      fill: "none",
      "stroke-width": "2",
      ...extra,
    });
  ring.append(
    svg(
      doc,
      "svg",
      {
        class: "llm-task-progress-ring-track",
        width: "20",
        height: "20",
        viewBox: "0 0 20 20",
      },
      [
        circle("llm-task-progress-ring-base"),
        circle("llm-task-progress-ring-arc", {
          "stroke-linecap": "round",
          "stroke-dasharray": "15 38.4",
        }),
      ],
    ),
  );
  const badge = (className: string, path: string) => {
    const node = el(doc, "span", `llm-task-progress-badge ${className}`);
    node.append(
      svg(
        doc,
        "svg",
        {
          width: "11",
          height: "11",
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          "stroke-width": "3.5",
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        },
        [svg(doc, "path", { d: path })],
      ),
    );
    return node;
  };
  ring.append(
    badge("llm-task-progress-badge-done", "M20 6L9 17l-5-5"),
    badge("llm-task-progress-badge-failed", "M18 6L6 18M6 6l12 12"),
  );
  return ring;
}

/** The card's header: status ring, label, counts, status pill, chevron. */
export function createTaskProgressRow(doc: Document): HTMLButtonElement {
  const row = el(doc, "button", "llm-task-progress");
  row.id = ROW_ID;
  row.type = "button";
  row.hidden = true;
  row.dataset.state = "idle";
  row.setAttribute("aria-expanded", "false");
  row.setAttribute("aria-controls", DRAWER_ID);
  const label = el(
    doc,
    "strong",
    "llm-task-progress-label",
    t("Task progress"),
  );
  const count = el(doc, "span", "llm-task-progress-count");
  const pill = el(doc, "span", "llm-task-progress-pill");
  pill.hidden = true;
  const chevron = el(doc, "span", "llm-task-progress-chevron");
  chevron.setAttribute("aria-hidden", "true");
  chevron.append(
    svg(
      doc,
      "svg",
      {
        width: "15",
        height: "15",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2.2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
      [svg(doc, "path", { d: "M6 9l6 6 6-6" })],
    ),
  );
  row.append(createStatusRing(doc), label, count, pill, chevron);
  return row;
}

/**
 * The one Task progress container, first in `#llm-chat-shell`: its header row
 * and, under it, the drawer that unrolls inside the same card.
 */
export function createTaskProgressCard(doc: Document): HTMLElement {
  const card = el(doc, "section", "llm-task-progress-card");
  card.hidden = true;
  card.append(createTaskProgressRow(doc), createTaskProgressDrawer(doc));
  return card;
}

/**
 * The curtain the card lowers from and rises into, first in
 * `#llm-chat-shell`. At rest it makes no box (`display: contents`), so the
 * card lays out as the shell's own child; while the row lowers or rises it is
 * a box as tall as the part of the card shown, clipped at its top edge.
 * Hidden, with the card, until the row has something to show.
 */
export function createTaskProgressCurtain(doc: Document): HTMLElement {
  const curtain = el(doc, "div", CURTAIN_CLASS);
  curtain.hidden = true;
  curtain.dataset.curtain = "closed";
  curtain.append(createTaskProgressCard(doc));
  return curtain;
}

/**
 * The drawer, first in `#llm-chat-shell`: a scrolling body and a drag handle
 * on its bottom edge. Hidden until the row opens it.
 */
export function createTaskProgressDrawer(doc: Document): HTMLElement {
  const drawer = el(doc, "div", "llm-task-progress-drawer");
  drawer.id = DRAWER_ID;
  drawer.hidden = true;
  drawer.dataset.state = "closed";
  drawer.setAttribute("role", "region");
  drawer.setAttribute("aria-label", t("Task progress details"));
  const body = el(doc, "div", "llm-task-progress-drawer-body");
  const head = el(doc, "div", "llm-task-progress-head");
  const note = el(
    doc,
    "div",
    "llm-task-progress-note",
    t("Reads are recorded in Agent mode. This list shows the papers in scope."),
  );
  note.hidden = true;
  const steps = el(doc, "section", "llm-task-progress-steps");
  steps.hidden = true;
  steps.setAttribute("aria-label", t("Steps"));
  const list = el(doc, "ol", "llm-task-progress-list");
  list.setAttribute("role", "list");
  list.setAttribute("aria-label", t("Papers in scope"));
  const more = el(doc, "div", "llm-task-progress-more");
  more.hidden = true;
  body.append(head, note, steps, list, more);
  const grip = el(doc, "div", "llm-task-progress-drawer-grip");
  grip.tabIndex = 0;
  grip.title = t("Drag to resize Task progress");
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "horizontal");
  grip.setAttribute("aria-label", t("Resize Task progress"));
  drawer.append(body, grip);
  return drawer;
}

/** A list of paper rows: the drawer's own, or an earlier question's. */
type PaperList = {
  host: HTMLElement;
  rowsByKey: Map<string, PaperRowRefs>;
  ordered: PaperRowRefs[];
  /** Before its rows' keys in the expanded set: none for the drawer's own. */
  scope: string;
};

type PaperRowRefs = {
  li: HTMLElement;
  remove: HTMLButtonElement;
  summary: HTMLButtonElement;
  index: HTMLElement;
  title: HTMLElement;
  tail: HTMLElement;
  meta: HTMLElement;
  source: HTMLElement;
  details: HTMLElement;
  row: TaskProgressPaperRow;
  list: PaperList;
};

/** A question's header: its name, how it ended and, folded, its counts. */
type QuestionHeadRefs = {
  head: HTMLElement;
  label: HTMLElement;
  /** "Question 2", or an action's name: never cut. */
  name: HTMLElement;
  /** " · “the user's words”": cut first when the drawer is narrow. */
  words: HTMLElement;
  pill: HTMLElement;
  counts: HTMLElement | null;
};

/** An earlier question in the drawer's history; its body exists while unrolled. */
type SectionRefs = QuestionHeadRefs & {
  id: string;
  root: HTMLElement;
  head: HTMLButtonElement;
  body: {
    root: HTMLElement;
    steps: HTMLElement;
    papersTitle: HTMLElement;
    list: PaperList;
  } | null;
};

export type TaskProgressViewDeps = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
  /** Whether a paper has MinerU text; asked only for rows on screen. */
  resolveMineru?: (paper: {
    libraryID: number;
    itemId: number;
  }) => Promise<boolean>;
  /** Scroll the chat to a quote card; defaults to `scrollIntoView`. */
  navigateToCitation?: (card: HTMLElement) => void;
  /** Live layout; without it (unit tests) the drawer settles at once. */
  layout?: TaskProgressLayout;
  /** A paper's "(creator, year)" label; defaults to reading it from Zotero. */
  resolvePaperLabel?: (itemId: number) => string | null;
  /** The row came or went (its target; it may still be moving). */
  onVisibilityChange?: (visible: boolean) => void;
};

export type TaskProgressLayout = {
  /** The drawer's height transition in ms; 0 when motion is reduced. */
  motionMs: () => number;
  /** The row's lowering and rising in ms; 0 when motion is reduced. */
  curtainMs: () => number;
  /** The least height the chat keeps below the shown drawer. */
  chatStripPx: () => number;
  /** Watch the drawer's size; returns the disconnect. */
  observeResize: (target: HTMLElement, onResize: () => void) => () => void;
  /** The chat viewport changed size with the drawer: keep its reading place. */
  onChatResized: () => void;
};

export type TaskProgressDrawerState = "closed" | "opening" | "open" | "closing";
/** The row: up and gone, lowering, down, or rising. */
export type TaskProgressCurtainState = TaskProgressDrawerState;

export type TaskProgressViewInput = {
  conversationKey: number | null;
  /** The paper chat's own paper: listed, never removable. */
  basePaperItemId?: number;
  visibility: Omit<TaskProgressVisibilityInput, "planSeen" | "readInDepth">;
  /** False in plain chat: reads are not recorded, only the scope lists. */
  recordsReads: boolean;
  /**
   * False while the context bar is not yet set up for the conversation (the
   * latest question's contexts stand in): a change then is the conversation
   * loading, and the row takes it without motion. Absent means set up.
   */
  composerReady?: boolean;
};

export type TaskProgressView = {
  setInput: (input: TaskProgressViewInput) => void;
  setOpen: (open: boolean, options?: { focusRow?: boolean }) => void;
  /** The state asked for; the drawer may still be animating toward it. */
  isOpen: () => boolean;
  drawerState: () => TaskProgressDrawerState;
  /** Whether the row has something to show; it may still be lowering or rising. */
  isVisible: () => boolean;
  curtainState: () => TaskProgressCurtainState;
  /** Repaint now, skipping the coalescing delay. */
  flush: () => void;
  dispose: () => void;
  /** Paper rows currently in the DOM. */
  renderedRowCount: () => number;
};

export function mountTaskProgressView(params: {
  doc: Document;
  row: HTMLButtonElement;
  drawer: HTMLElement;
  shell: HTMLElement;
  chatBox: HTMLElement;
  /** Receives Escape while focus is anywhere in the panel. */
  keyTarget: HTMLElement;
  deps: TaskProgressViewDeps;
}): TaskProgressView {
  const { doc, row, drawer, shell, chatBox, keyTarget, deps } = params;
  // A not-done row's paper labels, read once per item while the view lives,
  // so a repaint never looks them up again.
  const readPaperLabel = deps.resolvePaperLabel || resolveTaskPaperLabel;
  const paperLabels = new Map<number, string | null>();
  const resolvePaperLabel = (itemId: number): string | null => {
    if (!paperLabels.has(itemId))
      paperLabels.set(itemId, readPaperLabel(itemId));
    return paperLabels.get(itemId) ?? null;
  };
  const body = drawer.querySelector(
    ".llm-task-progress-drawer-body",
  ) as HTMLElement;
  const grip = drawer.querySelector(
    ".llm-task-progress-drawer-grip",
  ) as HTMLElement;
  const head = drawer.querySelector(".llm-task-progress-head") as HTMLElement;
  const note = drawer.querySelector(".llm-task-progress-note") as HTMLElement;
  const steps = drawer.querySelector(".llm-task-progress-steps") as HTMLElement;
  const list = drawer.querySelector(".llm-task-progress-list") as HTMLElement;
  const more = drawer.querySelector(".llm-task-progress-more") as HTMLElement;
  const countEl = row.querySelector(".llm-task-progress-count") as HTMLElement;
  const pillEl = row.querySelector(
    ".llm-task-progress-pill",
  ) as HTMLElement | null;
  const card = row.closest(".llm-task-progress-card") as HTMLElement | null;
  const curtain = (card &&
    row.closest(`.${CURTAIN_CLASS}`)) as HTMLElement | null;

  let input: TaskProgressViewInput = {
    conversationKey: null,
    visibility: {
      conversationKind: "",
      isWebChat: false,
      isNoteSession: false,
      collectionCount: 0,
      tagCount: 0,
      paperCount: 0,
    },
    recordsReads: true,
  };
  let open = false;
  let visible = false;
  /** The visibility last told to `onVisibilityChange`; null before the first. */
  let toldVisible: boolean | null = null;
  let disposed = false;
  let paintTimer: unknown = null;
  let lastPaint = -Infinity;
  let paintedVersion = -1;
  let seenCollapseSeq = 0;
  let limit = TASK_PROGRESS_WINDOW;
  /** The drawer's own list: the current question's papers. */
  const mainList: PaperList = {
    host: list,
    rowsByKey: new Map(),
    ordered: [],
    scope: "",
  };
  let expanded = new Set<string>();
  /** Earlier questions the user unrolled, by section id. */
  let unrolled = new Set<string>();
  /** Some list holds rows past the window: scrolling down grows it. */
  let rowsPastWindow = false;
  /** The drawer's history, built while it shows more than one question. */
  let currentHead: QuestionHeadRefs | null = null;
  let papersTitle: HTMLElement | null = null;
  let historyHost: HTMLElement | null = null;
  let sectionRefs = new Map<string, SectionRefs>();
  /** The sections a record version builds, kept until the record changes. */
  let sectionsCache: {
    record: TaskProgressRecord;
    version: number;
    sections: TaskProgressSection[];
  } | null = null;
  /** The conversation's remembered card was open: reopen it once shown. */
  let restorePending = false;
  /** The record the local state belongs to; 0 before there is one. */
  let seenEpoch = 0;
  const mineruKnown = new Set<string>();
  const mineruAsked = new Set<string>();
  const flashTimers = new Set<unknown>();

  const record = () =>
    input.conversationKey ? getTaskProgress(input.conversationKey) : null;

  const sectionsOf = (
    current: TaskProgressRecord | null,
  ): TaskProgressSection[] => {
    if (!current) return [];
    if (
      sectionsCache?.record !== current ||
      sectionsCache.version !== current.version
    ) {
      sectionsCache = {
        record: current,
        version: current.version,
        sections: buildTaskProgressSections(current),
      };
    }
    return sectionsCache.sections;
  };

  const clearList = (target: PaperList) => {
    for (const refs of target.rowsByKey.values()) refs.li.remove();
    target.rowsByKey = new Map();
    target.ordered = [];
  };

  /** Drop the history's nodes: none shows, or another record's did. */
  const clearHistory = () => {
    currentHead?.head.remove();
    papersTitle?.remove();
    historyHost?.remove();
    currentHead = null;
    papersTitle = null;
    historyHost = null;
    sectionRefs = new Map();
  };

  /**
   * A record cleared under the view (the conversation deleted, a turn edited)
   * takes its expanded papers and questions and its window with it, as it
   * took its memo.
   */
  const adoptRecord = (current: TaskProgressRecord | null) => {
    const epoch = current?.epoch ?? 0;
    if (epoch === seenEpoch) return;
    if (seenEpoch) {
      expanded = new Set();
      unrolled = new Set();
      limit = TASK_PROGRESS_WINDOW;
      clearList(mainList);
      clearHistory();
    }
    seenEpoch = epoch;
  };

  /**
   * Keep how the user left the card, for the next view of this conversation
   * (a panel rebuilt on a tab switch, the reader's sidebar, another window).
   */
  const remember = () => {
    const key = input.conversationKey;
    if (!key || disposed) return;
    rememberTaskProgressView(key, {
      open,
      expanded: Array.from(expanded),
      questions: Array.from(unrolled),
      limit,
      collapseSeq: seenCollapseSeq,
      // A closed drawer keeps the place it was left at.
      ...(open ? { scrollTop: Math.round(Number(body.scrollTop) || 0) } : {}),
    });
  };

  const computeVisible = (current: TaskProgressRecord | null) =>
    Boolean(input.conversationKey) &&
    shouldShowTaskProgress({
      ...input.visibility,
      planSeen: Boolean(current?.planSeen),
      readInDepth: taskReadInDepth(current),
    });

  /** What this paint stands on: how the next change of the row moves. */
  const rowFrame = (
    current: TaskProgressRecord | null,
  ): TaskProgressRowFrame => ({
    identity: [
      input.conversationKey ?? "",
      input.visibility.conversationKind,
      input.visibility.isWebChat,
      input.visibility.isNoteSession,
    ].join("\u0000"),
    shown: visible,
    contextApplies: taskProgressContextApplies(input.visibility),
    // Papers read in depth show the row in a Library chat as steps do: a
    // live run's first one lowers it, history's puts it in place.
    runSteps:
      Boolean(current?.planSeen) ||
      (input.visibility.conversationKind === "global" &&
        taskReadInDepth(current)),
    composerReady: input.composerReady !== false,
    runLive: isTaskRunLive(current),
    userChoice: input.visibility.userChoice,
  });
  /** The previous paint's frame; null before the first. */
  let lastFrame: TaskProgressRowFrame | null = null;

  // -------------------------------------------------------------------------
  // Drawer motion
  // -------------------------------------------------------------------------

  let drawerState: TaskProgressDrawerState = "closed";
  let settleTimer: unknown = null;

  const heightOf = (node: HTMLElement): number =>
    node.getBoundingClientRect?.().height ?? 0;

  const setDrawerState = (next: TaskProgressDrawerState) => {
    drawerState = next;
    drawer.dataset.state = next;
  };

  const clearSettleTimer = () => {
    if (settleTimer === null) return;
    deps.clearTimeout(settleTimer);
    settleTimer = null;
  };

  /** End the motion: open at its natural height, or rolled up and hidden. */
  const settle = () => {
    clearSettleTimer();
    drawer.style.height = "";
    if (drawerState === "opening") setDrawerState("open");
    if (drawerState === "closing") {
      setDrawerState("closed");
      drawer.hidden = true;
      shell.classList.remove(SHOWN_CLASS);
      shell.style.setProperty(DRAWER_INSET_VAR, "");
    }
  };

  const applyDrawerHeight = (height: number | null) => {
    if (height === null) {
      drawer.style.setProperty(DRAWER_MAX_VAR, "");
      grip.removeAttribute("aria-valuenow");
      return;
    }
    drawer.style.setProperty(DRAWER_MAX_VAR, `${Math.round(height)}px`);
    grip.setAttribute("aria-valuenow", `${Math.round(height)}`);
  };

  /**
   * Unroll or roll up the drawer. Height moves between two measured pixel
   * values (from wherever it is now, so a reversal mid-way is smooth); the
   * inline height is released once the motion ends.
   */
  const moveDrawer = (target: "open" | "closed", animated: boolean) => {
    const from = drawerState === "closed" ? 0 : heightOf(drawer);
    if (target === "open") {
      applyDrawerHeight(rememberedDrawerHeight);
      drawer.hidden = false;
      shell.classList.add(SHOWN_CLASS);
    }
    setDrawerState(target === "open" ? "opening" : "closing");
    const ms = animated && deps.layout ? deps.layout.motionMs() : 0;
    if (!(ms > 0)) {
      settle();
      return;
    }
    let to = 0;
    if (target === "open") {
      drawer.style.height = "";
      to = heightOf(drawer);
    }
    drawer.style.height = `${from}px`;
    // Flush layout so the transition starts from `from`.
    heightOf(drawer);
    drawer.style.height = `${to}px`;
    clearSettleTimer();
    settleTimer = deps.setTimeout(settle, ms + SETTLE_GRACE_MS);
  };

  const applyOpen = (
    next: boolean,
    animated = true,
    options: { remember?: boolean } = {},
  ) => {
    // The card must keep its height while the row lowers: finish lowering.
    if (curtainState === "opening") settleCurtain("open");
    open = next;
    row.setAttribute("aria-expanded", next ? "true" : "false");
    moveDrawer(next ? "open" : "closed", animated);
    if (options.remember !== false) remember();
  };

  const onTransitionEnd = (event: Event) => {
    if (event.target !== drawer) return;
    if ((event as TransitionEvent).propertyName !== "height") return;
    if (drawerState === "opening" || drawerState === "closing") settle();
  };

  const onDrawerResize = () => {
    if (drawerState === "closed") return;
    shell.style.setProperty(
      DRAWER_INSET_VAR,
      `${Math.round(heightOf(drawer))}px`,
    );
    deps.layout?.onChatResized();
  };
  const stopObservingDrawer =
    deps.layout?.observeResize(drawer, onDrawerResize) || (() => undefined);

  // -------------------------------------------------------------------------
  // The row lowering and rising
  // -------------------------------------------------------------------------

  /** Up and gone at mount: `createTaskProgressCurtain` builds it hidden. */
  let curtainState: TaskProgressCurtainState = row.hidden ? "closed" : "open";
  let curtainTimer: unknown = null;
  /** The curtain's height with the row down, measured as a motion starts. */
  let curtainOpenPx = 0;

  const clearCurtainTimer = () => {
    if (curtainTimer === null) return;
    deps.clearTimeout(curtainTimer);
    curtainTimer = null;
  };

  /**
   * The shell says where the row stands while it is in the flow: its gap
   * under the header is taken back only while the row lowers or is down
   * (never in the pose a lowering starts from), and moves with the row.
   */
  const syncShellCurtain = () => {
    const value = shell.classList.contains(PRESENT_CLASS) ? curtainState : null;
    if (shell.getAttribute(SHELL_CURTAIN_ATTR) === value) return;
    if (value) shell.setAttribute(SHELL_CURTAIN_ATTR, value);
    else shell.removeAttribute(SHELL_CURTAIN_ATTR);
  };

  const setCurtainState = (next: TaskProgressCurtainState) => {
    curtainState = next;
    if (curtain && curtain.dataset.curtain !== next)
      curtain.dataset.curtain = next;
    syncShellCurtain();
  };

  /** The row's boxes are in the flow from the moment it lowers until it is up. */
  const setRowPresent = (present: boolean) => {
    if (row.hidden !== !present) row.hidden = !present;
    if (card && card.hidden !== !present) card.hidden = !present;
    if (curtain && curtain.hidden !== !present) curtain.hidden = !present;
    if (shell.classList.contains(PRESENT_CLASS) !== present)
      shell.classList.toggle(PRESENT_CLASS, present);
    syncShellCurtain();
  };

  /** End the motion, or skip it: the row down at its own height, or gone. */
  function settleCurtain(target: "open" | "closed") {
    clearCurtainTimer();
    if (curtain?.style.height) curtain.style.height = "";
    if (card?.style.height) card.style.height = "";
    setCurtainState(target);
    setRowPresent(target === "open");
    // Nothing to roll the drawer up toward once the row itself is gone.
    if (target === "closed") closeAtOnce();
  }

  /**
   * Lower or raise the row. The curtain's height moves between measured
   * pixel heights while the card, rigid inside it, slides by its own height
   * (the CSS), so the card's lower edge rides the curtain's. A reversal
   * mid-way runs both back from where they are. Without motion (reduced, no
   * layout, or a change that must not move) it settles at once.
   */
  const moveCurtain = (target: "open" | "closed", animated: boolean) => {
    if (curtainState === target) return;
    const ms =
      animated && curtain && card && deps.layout ? deps.layout.curtainMs() : 0;
    if (!(ms > 0) || !curtain || !card) {
      settleCurtain(target);
      return;
    }
    if (curtainState === (target === "open" ? "opening" : "closing")) return;
    clearCurtainTimer();
    if (target === "open") {
      if (curtainState === "closed") {
        // The pose it lowers from: the card above the curtain's top edge.
        setRowPresent(true);
        curtain.style.height = "";
        curtainOpenPx = heightOf(curtain);
        curtain.style.height = "0px";
        heightOf(curtain); // Flush, so the motion starts from here.
      }
      curtain.style.height = `${curtainOpenPx}px`;
      setCurtainState("opening");
    } else {
      if (curtainState === "open") {
        // The card rises as it stands, an open drawer in it included.
        card.style.height = `${heightOf(card)}px`;
        setCurtainState("closing");
        curtain.style.height = "";
        curtainOpenPx = heightOf(curtain);
        curtain.style.height = `${curtainOpenPx}px`;
        heightOf(curtain);
      } else {
        setCurtainState("closing");
      }
      curtain.style.height = "0px";
    }
    // Flush once more: the curtain and the card start moving together.
    heightOf(curtain);
    curtainTimer = deps.setTimeout(() => {
      curtainTimer = null;
      settleCurtain(curtainState === "closing" ? "closed" : "open");
    }, ms + SETTLE_GRACE_MS);
  };

  const onCurtainTransitionEnd = (event: Event) => {
    if (event.target !== curtain) return;
    if ((event as TransitionEvent).propertyName !== "height") return;
    if (curtainState === "opening") settleCurtain("open");
    else if (curtainState === "closing") settleCurtain("closed");
  };

  /** Every frame the row moves, the chat keeps its bottom or reading place. */
  const onCurtainResize = () => {
    if (curtainState !== "opening" && curtainState !== "closing") return;
    deps.layout?.onChatResized();
  };
  const stopObservingCurtain =
    (curtain && deps.layout?.observeResize(curtain, onCurtainResize)) ||
    (() => undefined);

  // -------------------------------------------------------------------------
  // Drag handle
  // -------------------------------------------------------------------------

  let drag: {
    startY: number;
    startHeight: number;
    min: number;
    max: number;
    height: number;
    moved: boolean;
  } | null = null;

  /** From the least height to all the chat can give while keeping its strip. */
  const dragBounds = () => {
    const current = heightOf(drawer);
    const strip = deps.layout?.chatStripPx() ?? 0;
    const max = Math.max(0, current + Math.max(0, heightOf(chatBox) - strip));
    return { current, min: Math.min(TASK_PROGRESS_DRAWER_MIN_PX, max), max };
  };

  const clamp = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(max, value));

  const commitDrawerHeight = (height: number) => {
    rememberedDrawerHeight = Math.round(height);
    applyDrawerHeight(rememberedDrawerHeight);
  };

  const onDragMove = (event: Event) => {
    if (!drag) return;
    const pointerY = Number((event as MouseEvent).clientY);
    if (!Number.isFinite(pointerY)) return;
    drag.height = clamp(
      drag.startHeight + (pointerY - drag.startY),
      drag.min,
      drag.max,
    );
    drag.moved = true;
    applyDrawerHeight(drag.height);
    event.preventDefault?.();
    event.stopPropagation?.();
  };

  const endDrag = () => {
    if (!drag) return;
    const ended = drag;
    drag = null;
    doc.removeEventListener?.("mousemove", onDragMove, true);
    doc.removeEventListener?.("mouseup", endDrag, true);
    doc.defaultView?.removeEventListener?.("blur", endDrag);
    keyTarget.classList.remove(RESIZING_CLASS);
    try {
      (grip as any).releaseCapture?.();
    } catch {
      // Gecko can throw if capture was already released.
    }
    if (ended.moved) commitDrawerHeight(ended.height);
  };

  const onGripMouseDown = (event: Event) => {
    const pointer = event as MouseEvent;
    if (pointer.button !== 0 || drawerState !== "open") return;
    const bounds = dragBounds();
    drag = {
      startY: pointer.clientY,
      startHeight: bounds.current,
      min: bounds.min,
      max: bounds.max,
      height: bounds.current,
      moved: false,
    };
    grip.setAttribute("aria-valuemin", `${Math.round(bounds.min)}`);
    grip.setAttribute("aria-valuemax", `${Math.round(bounds.max)}`);
    keyTarget.classList.add(RESIZING_CLASS);
    try {
      (grip as any).setCapture?.(true);
    } catch {
      // The document listeners keep the drag going without capture.
    }
    doc.addEventListener?.("mousemove", onDragMove, true);
    doc.addEventListener?.("mouseup", endDrag, true);
    doc.defaultView?.addEventListener?.("blur", endDrag);
    event.preventDefault?.();
    event.stopPropagation?.();
  };

  const onGripKeyDown = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (drawerState !== "open") return;
    const bounds = dragBounds();
    const step = (event as KeyboardEvent).shiftKey
      ? DRAWER_KEY_STEP_PX * 4
      : DRAWER_KEY_STEP_PX;
    let next: number | null = null;
    if (key === "ArrowUp") next = bounds.current - step;
    if (key === "ArrowDown") next = bounds.current + step;
    if (key === "Home") next = bounds.min;
    if (key === "End") next = bounds.max;
    if (next === null) return;
    commitDrawerHeight(clamp(next, bounds.min, bounds.max));
    event.preventDefault?.();
    event.stopPropagation?.();
  };

  /** Double-click: back to fitting the content, up to the chat's strip. */
  const onGripDoubleClick = (event: Event) => {
    rememberedDrawerHeight = null;
    applyDrawerHeight(null);
    event.preventDefault?.();
    event.stopPropagation?.();
  };

  /** "Source": open the paper at this passage (the panel does the work). */
  const openPassageButton = (
    model: TaskProgressPaperRow,
    read: TaskPaperReadEvent,
    cleanedSnippet: string,
  ) => {
    const button = el(doc, "button", "llm-task-paper-open", t("Source"));
    button.type = "button";
    button.title = t("Open this passage in the paper");
    button.setAttribute("aria-label", t("Open this passage in the paper"));
    button.addEventListener("click", (event: Event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      if (button.disabled) return;
      dispatchOpenPassage(button, model, {
        rawSnippet: read.snippet || "",
        cleanedSnippet,
        label: read.label || "",
        ...(read.pageIndex !== undefined ? { pageIndex: read.pageIndex } : {}),
        granularity: read.granularity,
      });
    });
    return button;
  };

  const dispatchOpenPassage = (
    from: HTMLElement,
    model: TaskProgressPaperRow,
    detail: Omit<TaskPaperPassageTarget, "itemId" | "libraryID">,
  ) => {
    const View = (doc.defaultView as any)?.CustomEvent;
    if (typeof View !== "function") return;
    const target: TaskPaperPassageTarget = {
      itemId: model.itemId,
      libraryID: model.libraryID,
      ...detail,
    };
    const contextItemId = model.entry?.contextItemIds?.[0];
    if (contextItemId) target.contextItemId = contextItemId;
    from.dispatchEvent(
      new View(TASK_PROGRESS_OPEN_PASSAGE_EVENT, {
        bubbles: true,
        detail: target,
      }),
    );
  };

  /** A document's citation of the paper: its section; a click opens the paper. */
  const documentCitationButton = (
    model: TaskProgressPaperRow,
    section: string,
  ) => {
    const link = el(
      doc,
      "button",
      "llm-task-paper-citation",
      `↳ ${section || t("Cited in document")}`,
    );
    link.type = "button";
    link.addEventListener("click", (event: Event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      dispatchOpenPassage(link, model, {
        rawSnippet: "",
        cleanedSnippet: "",
        label: section,
        granularity: "full",
      });
    });
    return link;
  };

  const renderDetails = (refs: PaperRowRefs) => {
    const { row: model, details } = refs;
    const children: HTMLElement[] = [];
    const turns = Object.keys(model.entry?.turns || {})
      .map(Number)
      .filter((turn) => Number.isFinite(turn))
      .sort((a, b) => a - b);
    const citations: Array<{ id: string; quote: string; turn: number }> = [];
    const documentSections: string[] = [];
    const readsByTurn = new Map(
      turns.map((turn) => [turn, visibleReads(model.entry!.turns[turn].reads)]),
    );
    // The host's digests of the paper lead, one block per part: its label,
    // the relevance and stance it judged, and its answer, or why it failed.
    const digests = paperDigests(
      turns.flatMap((turn) => model.entry!.turns[turn].reads),
    );
    for (const digest of digests) {
      const block = el(doc, "div", "llm-task-paper-read llm-task-paper-digest");
      const label = digestPartLabel(digest);
      const answer = digest.snippet
        ? cleanTaskPaperSnippet(digest.snippet)
        : "";
      // A row saved before parts were recorded keeps its "Summary" heading,
      // and its failure says why under it, as it did.
      const heading = !label
        ? t("Summary")
        : digest.snippet
          ? label
          : digestFailedText(digest);
      block.append(el(doc, "div", "llm-task-paper-turn", heading));
      for (const line of [
        digestJudgmentText(
          RELEVANCE_WORDS.get(digest.relevance?.level || ""),
          digest.relevance?.reason,
        ),
        digestJudgmentText(
          STANCE_WORDS.get(digest.stance?.position || ""),
          digest.stance?.reason,
        ),
      ]) {
        if (line) block.append(el(doc, "div", "llm-task-paper-how", line));
      }
      if (answer) {
        block.append(el(doc, "blockquote", "llm-task-paper-snippet", answer));
      } else if (digest.whyMatched || !label) {
        block.append(
          el(
            doc,
            "div",
            "llm-task-paper-empty",
            digest.whyMatched ? t(digest.whyMatched) : t("Summary failed"),
          ),
        );
      }
      children.push(block);
    }
    // Question headings only help when more than one question read it.
    const headed =
      turns.filter((turn) => readsByTurn.get(turn)!.length).length > 1;
    for (const turn of turns) {
      const turnRecord = model.entry!.turns[turn];
      const reads = readsByTurn.get(turn)!;
      if (reads.length) {
        if (headed && turn > 0) {
          children.push(
            el(
              doc,
              "div",
              "llm-task-paper-turn",
              format("Question {number}", { number: turn }),
            ),
          );
        }
        for (const read of reads) {
          const item = el(doc, "div", "llm-task-paper-read");
          const snippet = read.snippet
            ? cleanTaskPaperSnippet(read.snippet)
            : "";
          const head = el(doc, "div", "llm-task-paper-read-head");
          head.append(
            el(
              doc,
              "div",
              "llm-task-paper-how",
              formatTaskPaperPassageLabel(read, model.title),
            ),
          );
          if (canOpenTaskPaperPassage(read)) {
            head.append(openPassageButton(model, read, snippet));
          }
          item.append(head);
          if (snippet) {
            item.append(
              el(doc, "blockquote", "llm-task-paper-snippet", snippet),
            );
          }
          children.push(item);
        }
        if (turnRecord.droppedReads) {
          children.push(
            el(
              doc,
              "div",
              "llm-task-paper-empty",
              format("and {count} more reads", {
                count: turnRecord.droppedReads,
              }),
            ),
          );
        }
      }
      for (const citation of turnRecord.citations) {
        if (citation.source === "document") {
          const sections = citation.sectionLabels?.length
            ? citation.sectionLabels
            : [citation.sectionLabel || ""];
          for (const label of sections) {
            const section = label.trim();
            if (!documentSections.includes(section))
              documentSections.push(section);
          }
          continue;
        }
        citations.push({
          id: citation.citationId,
          quote: citation.quote || citation.label || citation.citationId,
          turn,
        });
      }
    }
    const state = model.state;
    // Every question's reads are listed above; the line speaks when none read it.
    if (state === "listed") {
      children.push(
        el(
          doc,
          "div",
          "llm-task-paper-empty",
          input.recordsReads
            ? t("Listed in scope; not read for this question.")
            : t("Reads are recorded in Agent mode."),
        ),
      );
    } else if (
      state === "matched" &&
      !digests.length &&
      !turns.some((turn) =>
        model.entry!.turns[turn].reads.some((read) => read.snippet),
      )
    ) {
      children.push(
        el(
          doc,
          "div",
          "llm-task-paper-empty",
          t("Matched by title or abstract; text not opened."),
        ),
      );
    }
    if (citations.length) {
      const citedIn = el(doc, "div", "llm-task-paper-cited");
      citedIn.append(
        el(doc, "div", "llm-task-paper-turn", t("Cited in answer")),
      );
      for (const citation of citations) {
        const link = el(
          doc,
          "button",
          "llm-task-paper-citation",
          `↳ “${citation.quote}”`,
        );
        link.type = "button";
        link.dataset.citationId = citation.id;
        link.addEventListener("click", (event: Event) => {
          event.preventDefault?.();
          event.stopPropagation?.();
          jumpToCitation(citation.id);
        });
        citedIn.append(link);
      }
      children.push(citedIn);
    }
    if (documentSections.length) {
      const citedIn = el(doc, "div", "llm-task-paper-cited");
      citedIn.append(
        el(doc, "div", "llm-task-paper-turn", t("Cited in document")),
      );
      for (const section of documentSections) {
        citedIn.append(documentCitationButton(model, section));
      }
      children.push(citedIn);
    }
    details.replaceChildren(...children);
  };

  const patchRow = (refs: PaperRowRefs, model: TaskProgressPaperRow) => {
    refs.row = model;
    if (refs.li.dataset.state !== model.state)
      refs.li.dataset.state = model.state;
    const indexText = `${model.index}`;
    if (refs.index.textContent !== indexText)
      refs.index.textContent = indexText;
    if (refs.title.textContent !== model.title) {
      refs.title.textContent = model.title;
      refs.title.title = model.title;
    }
    const tail = formatTaskPaperTail(model);
    if (refs.tail.textContent !== tail) refs.tail.textContent = tail;
    const meta = metaText(model);
    const metaTextEl = refs.meta.firstChild as HTMLElement;
    if (metaTextEl.textContent !== meta) metaTextEl.textContent = meta;
    const source = sourceLabel(model, mineruKnown.has(model.key));
    if (refs.source.textContent !== source) refs.source.textContent = source;
    refs.source.hidden = !source;
    // Papers the context bar added can be removed; the paper chat's own
    // paper and papers the agent found on its own cannot.
    const removable =
      model.inScope && model.itemId !== (input.basePaperItemId || 0);
    if (refs.remove.hidden !== !removable) {
      refs.remove.hidden = !removable;
      refs.li.classList.toggle("llm-task-paper-removable", removable);
    }
    refs.summary.setAttribute(
      "aria-label",
      `${model.index}. ${model.title}, ${t(STATE_LABELS[model.state])}`,
    );
    if (expanded.has(expandKey(refs))) renderDetails(refs);
  };

  /** A row's key in the expanded set: its paper, within its list. */
  const expandKey = (refs: Pick<PaperRowRefs, "list" | "row">) =>
    `${refs.list.scope}${refs.row.key}`;

  const askMineru = (refs: PaperRowRefs) => {
    const model = refs.row;
    if (!deps.resolveMineru || mineruAsked.has(model.key)) return;
    if (model.entry?.text === "mineru" || model.scopeText === "none") return;
    mineruAsked.add(model.key);
    const conversation = input.conversationKey;
    void deps
      .resolveMineru({ libraryID: model.libraryID, itemId: model.itemId })
      .then((hasMineru) => {
        if (!hasMineru || disposed) return;
        mineruKnown.add(model.key);
        if (input.conversationKey !== conversation) return;
        // Every list showing the paper takes it.
        const lists = [
          mainList,
          ...Array.from(sectionRefs.values(), (section) => section.body?.list),
        ];
        for (const owner of lists) {
          const current = owner?.rowsByKey.get(model.key);
          if (current) patchRow(current, current.row);
        }
      })
      .catch(() => undefined);
  };

  const createRowRefs = (
    model: TaskProgressPaperRow,
    owner: PaperList,
  ): PaperRowRefs => {
    const li = el(doc, "li", "llm-task-paper");
    li.dataset.key = model.key;
    li.dataset.itemId = `${model.itemId}`;
    li.setAttribute("role", "listitem");
    const summary = el(doc, "button", "llm-task-paper-summary");
    summary.type = "button";
    summary.setAttribute("aria-expanded", "false");
    const index = el(doc, "span", "llm-task-paper-index");
    const dot = el(doc, "span", "llm-task-paper-dot");
    dot.setAttribute("aria-hidden", "true");
    const title = el(doc, "span", "llm-task-paper-title");
    const tail = el(doc, "span", "llm-task-paper-tail");
    const meta = el(doc, "span", "llm-task-paper-meta");
    const source = el(doc, "span", "llm-task-paper-source");
    meta.append(el(doc, "span", "llm-task-paper-meta-text"), source);
    // Gecko lays a button's children out in an anonymous block, so the grid
    // lives on an inner span.
    const chevron = el(doc, "span", "llm-task-paper-chevron");
    chevron.setAttribute("aria-hidden", "true");
    chevron.append(
      svg(
        doc,
        "svg",
        {
          width: "14",
          height: "14",
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          "stroke-width": "2.2",
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        },
        [svg(doc, "path", { d: "M6 9l6 6 6-6" })],
      ),
    );
    const grid = el(doc, "span", "llm-task-paper-grid");
    grid.append(dot, index, title, tail, chevron, meta);
    summary.append(grid);
    const details = el(doc, "div", "llm-task-paper-details");
    details.hidden = true;
    const remove = el(doc, "button", "llm-task-paper-remove");
    remove.type = "button";
    remove.hidden = true;
    remove.title = t("Remove from this task");
    remove.setAttribute("aria-label", t("Remove from this task"));
    remove.append(
      svg(
        doc,
        "svg",
        {
          width: "12",
          height: "12",
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          "stroke-width": "2.4",
          "stroke-linecap": "round",
        },
        [svg(doc, "path", { d: "M18 6L6 18M6 6l12 12" })],
      ),
    );
    remove.addEventListener("click", (event: Event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      const View = (doc.defaultView as any)?.CustomEvent;
      if (typeof View !== "function") return;
      li.dispatchEvent(
        new View(TASK_PROGRESS_REMOVE_PAPER_EVENT, {
          bubbles: true,
          detail: { itemId: refs.row.itemId },
        }),
      );
    });
    li.append(summary, remove, details);
    const refs: PaperRowRefs = {
      li,
      remove,
      summary,
      index,
      title,
      tail,
      meta,
      source,
      details,
      row: model,
      list: owner,
    };
    summary.addEventListener("click", (event: Event) => {
      event.preventDefault?.();
      const key = expandKey(refs);
      const next = !expanded.has(key);
      if (next) expanded.add(key);
      else expanded.delete(key);
      summary.setAttribute("aria-expanded", next ? "true" : "false");
      details.hidden = !next;
      if (next) renderDetails(refs);
      else details.replaceChildren();
      remember();
    });
    if (expanded.has(expandKey(refs))) {
      summary.setAttribute("aria-expanded", "true");
      details.hidden = false;
    }
    patchRow(refs, model);
    return refs;
  };

  /** Build or patch a list's window of rows, in order. */
  const renderRows = (target: PaperList, rows: TaskProgressPaperRow[]) => {
    const window = rows.slice(0, limit);
    if (rows.length > window.length) rowsPastWindow = true;
    const nextByKey = new Map<string, PaperRowRefs>();
    const nextOrder: PaperRowRefs[] = [];
    let cursor = target.host.firstChild as HTMLElement | null;
    for (const model of window) {
      let refs = target.rowsByKey.get(model.key);
      if (refs) patchRow(refs, model);
      else refs = createRowRefs(model, target);
      if (refs.li !== cursor) target.host.insertBefore(refs.li, cursor);
      else cursor = cursor.nextSibling as HTMLElement | null;
      nextByKey.set(model.key, refs);
      nextOrder.push(refs);
      askMineru(refs);
    }
    for (const [key, refs] of target.rowsByKey) {
      if (!nextByKey.has(key)) refs.li.remove();
    }
    target.rowsByKey = nextByKey;
    target.ordered = nextOrder;
    return window.length;
  };

  /**
   * The current question's rows: as they always were while the drawer shows
   * one question; that question's alone once it shows a history.
   */
  const currentRows = (
    current: TaskProgressRecord | null,
    sections: TaskProgressSection[],
  ): TaskProgressPaperRow[] => {
    if (sections.length < 2) return listedTaskProgressPaperRows(current);
    return listedTaskProgressPaperRows(
      current,
      buildTaskProgressPaperRows(current, {
        turn: sections[0].question.turn,
      }),
      0,
    );
  };

  const renderList = (current: TaskProgressRecord | null) => {
    const sections = sectionsOf(current);
    rowsPastWindow = false;
    const rows = currentRows(current, sections);
    const shown = renderRows(mainList, rows);
    const truncated = current?.scope?.listing?.truncated
      ? current.scope.listing.totalItems - current.scope.listing.listedItems
      : 0;
    const hiddenRows = rows.length - shown;
    more.hidden = !truncated || hiddenRows > 0;
    if (!more.hidden) {
      more.textContent = format("and {count} more", { count: truncated });
    }
    renderHistory(sections, rows.length);
  };

  /** "Papers (3)": a question's list heading, while the drawer shows a history. */
  const setPapersTitle = (node: HTMLElement, count: number) => {
    const text = count ? format("Papers ({count})", { count }) : "";
    if (node.textContent !== text) node.textContent = text;
    if (node.hidden !== !count) node.hidden = !count;
  };

  const createQuestionHead = (
    tag: "div" | "button",
    className: string,
    folded: boolean,
  ): QuestionHeadRefs => {
    const node = el(doc, tag, `llm-task-progress-question ${className}`);
    const grid = el(doc, "span", "llm-task-paper-grid");
    const label = el(
      doc,
      "span",
      "llm-task-paper-title llm-task-progress-question-label",
    );
    const name = el(doc, "span", "llm-task-progress-question-name");
    const words = el(doc, "span", "llm-task-progress-question-words");
    label.append(name, words);
    const tail = el(doc, "span", "llm-task-paper-tail");
    const pill = el(doc, "span", "llm-task-progress-pill");
    pill.hidden = true;
    tail.append(pill);
    let counts: HTMLElement | null = null;
    if (folded) {
      counts = el(doc, "span", "llm-task-progress-question-counts");
      tail.append(counts);
    }
    grid.append(label, tail);
    if (folded) {
      const chevron = el(doc, "span", "llm-task-paper-chevron");
      chevron.setAttribute("aria-hidden", "true");
      chevron.append(
        svg(
          doc,
          "svg",
          {
            width: "14",
            height: "14",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            "stroke-width": "2.2",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
          },
          [svg(doc, "path", { d: "M6 9l6 6 6-6" })],
        ),
      );
      grid.append(chevron);
    }
    node.append(grid);
    return { head: node, label, name, words, pill, counts };
  };

  const patchQuestionHead = (
    refs: QuestionHeadRefs,
    section: TaskProgressSection,
  ) => {
    // The name stays whole; only the words give way in a narrow drawer.
    const [name, words] = splitTaskQuestionLabel(section.question);
    if (refs.name.textContent !== name) refs.name.textContent = name;
    if (refs.words.textContent !== words) refs.words.textContent = words;
    const pillText = taskRunStatePill(section.state);
    if (refs.pill.textContent !== pillText) refs.pill.textContent = pillText;
    if (refs.pill.hidden !== !pillText) refs.pill.hidden = !pillText;
    if (refs.pill.dataset.tone !== section.state)
      refs.pill.dataset.tone = section.state;
    const countsText = refs.counts ? formatTaskQuestionCounts(section) : "";
    if (refs.counts && refs.counts.textContent !== countsText)
      refs.counts.textContent = countsText;
    const ariaLabel = [section.label, pillText, countsText]
      .filter(Boolean)
      .join(", ");
    if (refs.head.getAttribute("aria-label") !== ariaLabel)
      refs.head.setAttribute("aria-label", ariaLabel);
  };

  const createSectionRefs = (section: TaskProgressSection): SectionRefs => {
    const root = el(doc, "section", "llm-task-progress-question-section");
    root.dataset.sectionId = section.id;
    const head = createQuestionHead(
      "button",
      "llm-task-paper-summary",
      true,
    ) as QuestionHeadRefs & { head: HTMLButtonElement };
    head.head.type = "button";
    head.head.setAttribute("aria-expanded", "false");
    root.append(head.head);
    const refs: SectionRefs = { ...head, id: section.id, root, body: null };
    head.head.addEventListener("click", (event: Event) => {
      event.preventDefault?.();
      if (unrolled.has(refs.id)) unrolled.delete(refs.id);
      else unrolled.add(refs.id);
      const shown = sectionsOf(record()).find((next) => next.id === refs.id);
      if (shown) patchSection(refs, shown);
      remember();
    });
    return refs;
  };

  /** An earlier question's header, and its steps and papers while unrolled. */
  const patchSection = (refs: SectionRefs, section: TaskProgressSection) => {
    patchQuestionHead(refs, section);
    const shown = unrolled.has(refs.id);
    const expandedText = shown ? "true" : "false";
    if (refs.head.getAttribute("aria-expanded") !== expandedText)
      refs.head.setAttribute("aria-expanded", expandedText);
    if (!shown) {
      refs.body?.root.remove();
      refs.body = null;
      return;
    }
    if (!refs.body) {
      const root = el(doc, "div", "llm-task-progress-question-body");
      const sectionSteps = el(doc, "section", "llm-task-progress-steps");
      sectionSteps.setAttribute("aria-label", t("Steps"));
      const title = el(doc, "div", "llm-task-progress-papers-title");
      const host = el(doc, "ol", "llm-task-progress-list");
      host.setAttribute("role", "list");
      root.append(sectionSteps, title, host);
      refs.root.append(root);
      refs.body = {
        root,
        steps: sectionSteps,
        papersTitle: title,
        list: {
          host,
          rowsByKey: new Map(),
          ordered: [],
          scope: `${refs.id}\u0000`,
        },
      };
    }
    const parts = refs.body;
    if (parts.steps.hidden !== !section.checklist)
      parts.steps.hidden = !section.checklist;
    if (section.checklist)
      renderChecklistSteps(doc, parts.steps, section.checklist, {
        resolvePaperLabel,
      });
    else if (parts.steps.firstChild) parts.steps.replaceChildren();
    setPapersTitle(parts.papersTitle, section.rows.length);
    renderRows(parts.list, section.rows);
  };

  /**
   * The drawer's history, shown once it holds more than one question: the
   * current question named above its steps and papers, and each earlier one
   * as a header that unrolls them. With one question, none of it exists.
   */
  const renderHistory = (sections: TaskProgressSection[], papers: number) => {
    if (sections.length < 2) {
      if (currentHead || historyHost) clearHistory();
      return;
    }
    if (!currentHead) {
      currentHead = createQuestionHead(
        "div",
        "llm-task-progress-question-current",
        false,
      );
      currentHead.head.setAttribute("role", "heading");
      currentHead.head.setAttribute("aria-level", "3");
    }
    if (currentHead.head.nextSibling !== steps)
      body.insertBefore(currentHead.head, steps);
    patchQuestionHead(currentHead, sections[0]);
    if (!papersTitle) {
      papersTitle = el(doc, "div", "llm-task-progress-papers-title");
    }
    if (papersTitle.nextSibling !== list) body.insertBefore(papersTitle, list);
    setPapersTitle(papersTitle, papers);
    if (!historyHost) historyHost = el(doc, "div", "llm-task-progress-history");
    if (historyHost.parentElement !== body) body.append(historyHost);
    const earlier = sections.slice(1);
    const ids = new Set(earlier.map((section) => section.id));
    for (const [id, refs] of sectionRefs) {
      if (ids.has(id)) continue;
      refs.root.remove();
      sectionRefs.delete(id);
    }
    let cursor = historyHost.firstChild as HTMLElement | null;
    for (const section of earlier) {
      let refs = sectionRefs.get(section.id);
      if (!refs) {
        refs = createSectionRefs(section);
        sectionRefs.set(section.id, refs);
      }
      patchSection(refs, section);
      if (refs.root !== cursor) historyHost.insertBefore(refs.root, cursor);
      else cursor = cursor.nextSibling as HTMLElement | null;
    }
  };

  const renderHead = (current: TaskProgressRecord | null) => {
    // The row already carries the counts; the drawer lists what was read and
    // cited per paper. The head only says the list is still being prepared.
    const preparing =
      !current?.scope?.listing && !countTaskProgress(current).total;
    const text = preparing ? t("Preparing the scope…") : "";
    if (head.textContent !== text) head.textContent = text;
    if (head.hidden !== !preparing) head.hidden = !preparing;
    if (note.hidden !== input.recordsReads) note.hidden = input.recordsReads;
    // With a history, the Steps block is the current question's own.
    const sections = sectionsOf(current);
    const checklist =
      sections.length > 1
        ? sections[0].checklist
        : shownChecklist(current?.checklist);
    if (steps.hidden !== !checklist) steps.hidden = !checklist;
    if (checklist)
      renderChecklistSteps(doc, steps, checklist, { resolvePaperLabel });
    else if (steps.firstChild) steps.replaceChildren();
  };

  const paint = () => {
    paintTimer = null;
    if (disposed) return;
    lastPaint = deps.now();
    const current = record();
    adoptRecord(current);
    paintedVersion = current?.version ?? -1;
    visible = computeVisible(current);
    const frame = rowFrame(current);
    const animated = shouldAnimateTaskProgressRow(lastFrame, frame);
    // Only a new target or another conversation moves the row; any other
    // repaint lets a motion under way run through.
    const target = visible ? "open" : "closed";
    const placeRow =
      !lastFrame ||
      lastFrame.identity !== frame.identity ||
      lastFrame.shown !== frame.shown ||
      (curtainState !== target &&
        curtainState !== (visible ? "opening" : "closing"));
    lastFrame = frame;
    // Unchanged values are not written: a same-value write is still a DOM
    // mutation, and a streaming answer must cause none here. The row's own
    // boxes follow the curtain (`moveCurtain`), below.
    // The card is the separation under the header: the header's own divider
    // gives way while it shows.
    const rowHost = (row.closest(".llm-panel") ||
      row.parentElement) as HTMLElement | null;
    if (rowHost) {
      const shownAttr = visible ? "shown" : null;
      if (rowHost.getAttribute(ROW_SHOWN_ATTR) !== shownAttr) {
        if (shownAttr) rowHost.setAttribute(ROW_SHOWN_ATTR, shownAttr);
        else rowHost.removeAttribute(ROW_SHOWN_ATTR);
      }
    }
    const state = displayedTaskRunState(current);
    if (row.dataset.state !== state) row.dataset.state = state;
    const countText = formatTaskProgressCount(current, input.recordsReads);
    if (countEl.textContent !== countText) countEl.textContent = countText;
    const pillText = taskRunStatePill(state);
    if (pillEl) {
      if (pillEl.textContent !== pillText) pillEl.textContent = pillText;
      if (pillEl.hidden !== !pillText) pillEl.hidden = !pillText;
      if (pillEl.dataset.tone !== state) pillEl.dataset.tone = state;
    }
    const ariaLabel = [t("Task progress"), pillText, countText]
      .filter(Boolean)
      .join(", ");
    if (row.getAttribute("aria-label") !== ariaLabel)
      row.setAttribute("aria-label", ariaLabel);
    // The row rises with an open drawer in it, rolled up once the row is up.
    if (placeRow) moveCurtain(target, animated);
    if (toldVisible !== visible) {
      toldVisible = visible;
      deps.onVisibilityChange?.(visible);
    }
    if (!visible) return;
    if (current && current.collapseSeq !== seenCollapseSeq) {
      seenCollapseSeq = current.collapseSeq;
      if (open) {
        endDrag();
        applyOpen(false);
      }
    }
    if (restorePending) {
      restorePending = false;
      restoreOpen(current);
    }
    renderHead(current);
    if (open) renderList(current);
  };

  /**
   * Reopen the drawer as this conversation's card was left, without motion:
   * unless an answer started since, which collapses it as it would have here.
   */
  const restoreOpen = (current: TaskProgressRecord | null) => {
    const key = input.conversationKey;
    const memo = key ? getTaskProgressViewMemo(key) : null;
    if (!memo?.open || open || !current) return;
    if (memo.collapseSeq !== current.collapseSeq) return;
    seenCollapseSeq = current.collapseSeq;
    renderHead(current);
    renderList(current);
    applyOpen(true, false, { remember: false });
    body.scrollTop = memo.scrollTop;
    remember();
  };

  const schedule = () => {
    if (disposed || paintTimer !== null) return;
    const delay = Math.max(
      0,
      lastPaint + TASK_PROGRESS_REPAINT_MS - deps.now(),
    );
    try {
      paintTimer = deps.setTimeout(paint, delay);
    } catch {
      // The panel's window is gone (a closed standalone window): this view
      // can never paint again, so it stops listening.
      paintTimer = null;
      disposed = true;
      unsubscribe();
    }
  };

  const flush = () => {
    if (paintTimer !== null) {
      deps.clearTimeout(paintTimer);
      paintTimer = null;
    }
    paint();
  };

  /**
   * Close without motion: the row hid (remembered), or the panel moved on to
   * another conversation (the one left keeps its state).
   */
  const closeAtOnce = (options: { remember?: boolean } = {}) => {
    endDrag();
    if (open) applyOpen(false, false, options);
    else if (drawerState === "closing") settle();
  };

  const setOpen = (next: boolean, options?: { focusRow?: boolean }) => {
    if (disposed) return;
    if (next && !visible) return;
    if (next === open) return;
    if (next) {
      // Built before the drawer unrolls, so its height is measured with it.
      const current = record();
      seenCollapseSeq = current?.collapseSeq ?? seenCollapseSeq;
      renderHead(current);
      renderList(current);
    } else {
      endDrag();
    }
    applyOpen(next);
    if (!next && options?.focusRow) row.focus?.({ preventScroll: true });
  };

  function jumpToCitation(citationId: string) {
    setOpen(false);
    const cards = Array.from(
      chatBox.querySelectorAll(".llm-quote-citation-anchor"),
    ) as HTMLElement[];
    const card = cards
      .filter((node) => node?.dataset?.quoteCitationId === citationId)
      .pop();
    if (!card) return;
    if (deps.navigateToCitation) deps.navigateToCitation(card);
    else card.scrollIntoView?.({ block: "center" });
    card.classList.add(FLASH_CLASS);
    const timer = deps.setTimeout(() => {
      flashTimers.delete(timer);
      card.classList.remove(FLASH_CLASS);
    }, TASK_PROGRESS_FLASH_MS);
    flashTimers.add(timer);
  }

  const onRowClick = (event: Event) => {
    event.preventDefault?.();
    setOpen(!open);
  };
  const onKeyDown = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== "Escape" || !open) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    setOpen(false, { focusRow: true });
  };
  const onScroll = () => {
    if (!open) return;
    growWindow();
    remember();
  };
  const growWindow = () => {
    if (!rowsPastWindow) return;
    const remaining =
      Number(body.scrollHeight || 0) -
      Number(body.scrollTop || 0) -
      Number(body.clientHeight || 0);
    if (remaining > 240) return;
    limit += TASK_PROGRESS_WINDOW;
    renderList(record());
  };
  const unsubscribe = subscribeTaskProgress((key) => {
    if (key !== input.conversationKey) return;
    const current = record();
    adoptRecord(current);
    // The answer started: collapse now, not at the next coalesced paint.
    if (current && current.collapseSeq !== seenCollapseSeq) {
      seenCollapseSeq = current.collapseSeq;
      if (open) {
        endDrag();
        applyOpen(false);
      }
    }
    if (current && current.version === paintedVersion) return;
    schedule();
  });
  row.addEventListener("click", onRowClick);
  keyTarget.addEventListener("keydown", onKeyDown);
  body.addEventListener("scroll", onScroll);
  drawer.addEventListener("transitionend", onTransitionEnd);
  curtain?.addEventListener("transitionend", onCurtainTransitionEnd);
  grip.addEventListener("mousedown", onGripMouseDown);
  grip.addEventListener("keydown", onGripKeyDown);
  grip.addEventListener("dblclick", onGripDoubleClick);

  return {
    setInput(next) {
      if (disposed) return;
      const switched = next.conversationKey !== input.conversationKey;
      if (switched) closeAtOnce({ remember: false });
      input = next;
      if (switched) {
        clearList(mainList);
        clearHistory();
        mineruKnown.clear();
        mineruAsked.clear();
        // The conversation shown now comes back as its card was left.
        const memo = next.conversationKey
          ? getTaskProgressViewMemo(next.conversationKey)
          : null;
        expanded = new Set(memo?.expanded || []);
        unrolled = new Set(memo?.questions || []);
        limit = Math.max(TASK_PROGRESS_WINDOW, memo?.limit || 0);
        restorePending = Boolean(memo?.open);
        seenCollapseSeq = record()?.collapseSeq ?? 0;
        seenEpoch = record()?.epoch ?? 0;
      }
      flush();
    },
    setOpen,
    isOpen: () => open,
    drawerState: () => drawerState,
    isVisible: () => visible,
    curtainState: () => curtainState,
    flush,
    renderedRowCount: () =>
      mainList.ordered.length +
      Array.from(sectionRefs.values()).reduce(
        (total, section) => total + (section.body?.list.ordered.length || 0),
        0,
      ),
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      // A closed standalone window's clearTimeout throws, as its setTimeout
      // does (`schedule`); its timers died with it. Each clear is guarded so
      // the rest of the teardown, and the panel's own, still runs.
      const clearing = (clear: () => void) => {
        try {
          clear();
        } catch {
          // The window is gone, and its timers with it.
        }
      };
      if (paintTimer !== null) clearing(() => deps.clearTimeout(paintTimer));
      for (const timer of flashTimers) clearing(() => deps.clearTimeout(timer));
      flashTimers.clear();
      endDrag();
      clearing(clearSettleTimer);
      clearing(clearCurtainTimer);
      stopObservingDrawer();
      stopObservingCurtain();
      row.removeEventListener("click", onRowClick);
      keyTarget.removeEventListener("keydown", onKeyDown);
      body.removeEventListener("scroll", onScroll);
      drawer.removeEventListener("transitionend", onTransitionEnd);
      curtain?.removeEventListener("transitionend", onCurtainTransitionEnd);
      grip.removeEventListener("mousedown", onGripMouseDown);
      grip.removeEventListener("keydown", onGripKeyDown);
      grip.removeEventListener("dblclick", onGripDoubleClick);
    },
  };
}

/**
 * The Task progress store: one record per conversation of what the current
 * task is doing — its run state, the per-paper ledger, the scope it covers,
 * and the steps an action, Codex or the run's outcomes hold — and of the
 * questions and actions before it, each with its own words, steps and
 * ending (`questions`).
 *
 * The store owns no DOM. Writers are the turn owners (the agent engine, the
 * Codex callbacks, the request lifecycle); readers are the Task progress
 * views, which subscribe and repaint on their own schedule. Every writer is
 * idempotent, so a replayed or duplicated event changes nothing.
 *
 * At most `TASK_PROGRESS_MAX_CONVERSATIONS` idle conversations are kept,
 * least recently written first out. A conversation with a live run neither
 * counts against that limit nor is evicted, so live runs can never crowd out
 * the conversations being opened beside them.
 */
import {
  applyDocumentCitations,
  applyFinalCitations,
  applyTaskPaperLedgerDelta,
  createTaskPaperLedger,
  type TaskPaperDocumentCitation,
  type TaskPaperLedger,
  type TaskPaperLedgerDelta,
  type TaskPaperReadEvent,
  type TaskPaperResolvedRef,
} from "../../../agent/context/taskPaperLedger";
import { resolveZoteroPaperRef } from "../../../agent/context/taskPaperLedgerRecorder";
import type {
  TaskPaperScopeContexts,
  TaskPaperScopeListing,
} from "../../../agent/context/taskPaperScopeListing";
import type {
  ExecutionCheckpoint,
  ExecutionTaskStatus,
  OutcomeException,
  RunEndState,
} from "../../../agent/execution/types";
import type { QuoteCitation } from "../../../shared/types";
import type { AgentEvent } from "../../../agent/types";
import type { Message } from "../types";
import {
  buildTaskAnswerCitations,
  type TaskAnswerCitation,
} from "./answerCitations";
import {
  buildTaskOutsideTurn,
  movesTaskOutside,
  type TaskOutsideTurn,
} from "./outside";

export type TaskRunState =
  | "idle"
  | "working"
  | "answering"
  /** Live: a decision card waits on the user. */
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  /** The answer's stream broke off. */
  | "interrupted";

export type TaskProgressStepStatus = ExecutionTaskStatus;

/** What a step drawn from a run's outcome ledger says beyond its label. */
export type TaskProgressOutcomeStep = {
  /** Created by the host from a write, not declared by the model. */
  host: boolean;
  /** A write, whose targets the row can count. */
  write: boolean;
  /** A read, whose papers the row counts as their text is read. */
  read: boolean;
  /** A digest, whose papers the row counts as the host summarizes them. */
  digest: boolean;
  /** Receipt-form targets it names, and how many of those are done. */
  targets: number;
  doneTargets: number;
  /** Targets it did not do, by the host's reason. */
  exceptions: readonly OutcomeException[];
  /**
   * Targets the model left out of what the part delivers, by its reason:
   * not exceptions, so none of them is "not done".
   */
  excluded: readonly OutcomeException[];
  /**
   * Replaced by another part: cancelled with the replacement's reason, and
   * no longer a step to do.
   */
  replaced: boolean;
};

export type TaskProgressStep = {
  label: string;
  status: TaskProgressStepStatus;
  /** Why it ended as it did (an outcome's reason). */
  detail?: string;
  /** Set on a step that is a run's outcome. */
  outcome?: TaskProgressOutcomeStep;
};

/** The runtime that keeps its own steps: Codex's plan, or Claude Code's list. */
export type TaskProgressStepsRuntime = "codex" | "claude";

/**
 * A run's steps: a built-in action's progress, the checklist Codex or Claude
 * Code keeps with its own plan tool, or the outcomes a run's ledger holds.
 */
export type TaskProgressChecklist = {
  source: "action" | TaskProgressStepsRuntime | "outcomes";
  /** The run the steps belong to (an action gets its own id). */
  runId: string;
  /** The action's name; empty for Codex and Claude Code. */
  title: string;
  steps: TaskProgressStep[];
  /** Steps completed, and steps in all (an action announces its total). */
  done: number;
  total: number;
  /** The action's latest step summary. */
  summary: string;
  /** Set once the steps' run ended. */
  outcome?: "completed" | "failed" | "cancelled";
  /** Completion or error text at the end. */
  detail?: string;
  /** How the run that owns the outcomes ended, once its ledger settled. */
  end?: RunEndState;
  /** Papers its parts over the whole scope cover, frozen when declared. */
  scopePapers?: number;
};

/** The scope a turn attached, and its listing once the snapshot resolved it. */
export type TaskProgressScope = {
  /** Identity of the attached contexts; a new signature replaces the listing. */
  signature: string;
  libraryID: number;
  contexts: TaskPaperScopeContexts;
  /** "Drift + Learning", or empty when nothing names the scope. */
  label: string;
  listing: TaskPaperScopeListing | null;
};

/**
 * A question the conversation asked, or a built-in action it ran: one
 * section of the drawer's history. Its papers are the ledger's reads under
 * its question number.
 */
export type TaskProgressQuestion = {
  /** The question's 1-based number; 0 for a built-in action, which asks none. */
  turn: number;
  /** The question's latest run, or the action's own id. */
  runId?: string;
  /** The user's words, as sent; absent until known. */
  text?: string;
  /** An action's name. */
  title?: string;
  /**
   * Its steps, kept here once another question or action took the
   * conversation's steps; until then they are the record's `checklist`.
   */
  checklist: TaskProgressChecklist | null;
  /** The run state it was left in when another question or action took the row. */
  state?: TaskRunState;
  /**
   * The passages its answer cites, numbered as the answer's marks are; set
   * whole each time the answer (or how it is shown) changes. Absent until
   * its answer is in, and on a record built before it was kept.
   */
  answerCitations?: TaskAnswerCitation[];
};

export type TaskProgressRecord = {
  conversationKey: number;
  /** Bumped on every change; views repaint only when it moves. */
  version: number;
  runState: TaskRunState;
  /** The run the state describes, once the runtime named it. */
  runId?: string;
  /** Question number of the current run, 1-based; 0 before any run. */
  turnIndex: number;
  /** Question number of every run seen, by run id. */
  turnByRunId: Record<string, number>;
  ledger: TaskPaperLedger;
  scope: TaskProgressScope | null;
  /**
   * An action's, Codex's or a run's outcome steps: the current question's.
   * When the next question or action starts they move to their own entry
   * in `questions`.
   */
  checklist: TaskProgressChecklist | null;
  /**
   * The questions and actions run here, oldest first, at most
   * `TASK_PROGRESS_MAX_QUESTIONS`. The last is the one the row describes.
   */
  questions: TaskProgressQuestion[];
  /**
   * True once a plan, an action, a Codex plan or a run's outcomes ran here:
   * the row then stays for the conversation.
   */
  planSeen: boolean;
  /** Bumped when the answer starts streaming; open drawers collapse. */
  collapseSeq: number;
  /** True once the persisted history was folded in. */
  hydrated: boolean;
  /**
   * Every source the question's submitted documents cited, by question, and
   * the run that cited them: a run may finalize more than one document, and
   * each `material_finalized` names only its own; a re-run of the question
   * replaces them. In memory only; rebuilt from the run events.
   */
  documentCitations?: Record<
    number,
    { runId?: string; citations: TaskPaperDocumentCitation[] }
  >;
  /**
   * What each question got from outside the library (scholarly papers, web
   * pages), and whether it searched the library, by question: its latest
   * run's. In memory only; rebuilt from the run events.
   */
  outside?: Record<number, TaskOutsideTurn>;
  /** Identity of this record; a cleared and recreated record gets a new one. */
  epoch: number;
};

export const TASK_PROGRESS_MAX_CONVERSATIONS = 6;
/** Questions and actions a record keeps, newest kept. */
export const TASK_PROGRESS_MAX_QUESTIONS = 20;

const records = new Map<number, TaskProgressRecord>();
let nextEpoch = 1;
const listeners = new Set<(conversationKey: number) => void>();

/**
 * How the user left a conversation's Task progress card: the drawer open or
 * closed, the papers expanded, how far the list was windowed and scrolled.
 * Every view of the conversation takes it up when it mounts (a panel rebuilt
 * on a tab switch, the reader's sidebar, the standalone window). Session
 * memory only, never persisted; it lives and dies with the conversation's
 * record, and a write never repaints a view.
 */
export type TaskProgressViewMemo = {
  open: boolean;
  /** Paper row keys. */
  expanded: string[];
  /** Unused-paper folds the user opened, by fold key (question scope and group). */
  openFolds: string[];
  /** Rows the list had grown to. */
  limit: number;
  /** Earlier questions unrolled in the drawer's history, by section id. */
  questions: string[];
  /** Current questions folded, by section id. */
  foldedCurrent: string[];
  /** Section cards folded, by question scope and card. */
  closedCards: string[];
  /** Groups showing all their rows, by fold key. */
  showAllFolds: string[];
  /** The drawer body's scroll offset while open. */
  scrollTop: number;
  /**
   * What was at the top of the list while open, and how far its top sat
   * from the list's: the chat's card and the side panel tab differ in width,
   * so the same place is the same row, not the same offset.
   */
  top?: { id: string; offset: number };
  /** The record's collapseSeq when this was written: an answer started since closes it. */
  collapseSeq: number;
};

const viewMemos = new Map<number, TaskProgressViewMemo>();

function normalizeKey(value: unknown): number {
  const key = Math.floor(Number(value || 0));
  return Number.isFinite(key) && key > 0 ? key : 0;
}

function isLive(state: TaskRunState): boolean {
  return state === "working" || state === "answering" || state === "waiting";
}

/** True while the record's run works, answers or waits on the user. */
export function isTaskRunLive(
  record: TaskProgressRecord | null | undefined,
): boolean {
  return Boolean(record && isLive(record.runState));
}

/**
 * Evict the least recently written idle records beyond the limit, never
 * `keep` (the record the caller is making room for) and never a live one.
 * Counting live records against the limit let a handful of live runs leave
 * room for a single idle record: two conversations being opened then evicted
 * each other on every write and neither ever showed its progress.
 */
function evict(keep: number): void {
  let idle = 0;
  for (const record of records.values()) {
    if (!isLive(record.runState)) idle += 1;
  }
  for (const [key, record] of records) {
    if (idle <= TASK_PROGRESS_MAX_CONVERSATIONS) return;
    if (key === keep || isLive(record.runState)) continue;
    records.delete(key);
    viewMemos.delete(key);
    idle -= 1;
  }
}

function emptyRecord(conversationKey: number): TaskProgressRecord {
  return {
    conversationKey,
    version: 0,
    runState: "idle",
    turnIndex: 0,
    turnByRunId: {},
    ledger: createTaskPaperLedger(),
    scope: null,
    checklist: null,
    questions: [],
    planSeen: false,
    collapseSeq: 0,
    hydrated: false,
    epoch: nextEpoch++,
  };
}

/** The record to write, most recently used last. */
function writable(conversationKey: number): TaskProgressRecord | null {
  const key = normalizeKey(conversationKey);
  if (!key) return null;
  const existing = records.get(key);
  if (existing) {
    records.delete(key);
    records.set(key, existing);
    return existing;
  }
  const created = emptyRecord(key);
  records.set(key, created);
  evict(key);
  return records.get(key) || null;
}

/** Tell every view; a broken view (e.g. a closed window's) never breaks the writer. */
function notify(conversationKey: number): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(conversationKey);
    } catch {
      /* a broken view must not break the writer */
    }
  }
}

function changed(record: TaskProgressRecord): void {
  record.version += 1;
  notify(record.conversationKey);
}

export function getTaskProgress(
  conversationKey: number,
): TaskProgressRecord | null {
  return records.get(normalizeKey(conversationKey)) || null;
}

export function subscribeTaskProgress(
  listener: (conversationKey: number) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function highestTurn(record: TaskProgressRecord): number {
  return Math.max(0, record.turnIndex, ...Object.values(record.turnByRunId));
}

// ---------------------------------------------------------------------------
// Questions: the drawer's history
// ---------------------------------------------------------------------------

function questionForTurn(
  record: TaskProgressRecord,
  turn: number,
): TaskProgressQuestion | undefined {
  return turn > 0
    ? record.questions.find((question) => question.turn === turn)
    : undefined;
}

/** The entry a run belongs to: an action by its id, a question by its number. */
function questionForRun(
  record: TaskProgressRecord,
  runId: string | undefined,
): TaskProgressQuestion | undefined {
  if (!runId) return undefined;
  return (
    record.questions.find((question) => question.runId === runId) ??
    questionForTurn(record, record.turnByRunId[runId] ?? 0)
  );
}

/** The entry the row describes. */
function currentQuestion(
  record: TaskProgressRecord,
): TaskProgressQuestion | undefined {
  return record.questions[record.questions.length - 1];
}

/**
 * The entry a checklist belongs to: its run's, or the current one for steps
 * of a run the record cannot name yet.
 */
function checklistOwner(
  record: TaskProgressRecord,
  checklist: TaskProgressChecklist,
): TaskProgressQuestion | undefined {
  return questionForRun(record, checklist.runId) ?? currentQuestion(record);
}

/** The conversation's steps move on: the outgoing ones stay with their entry. */
function keepChecklist(record: TaskProgressRecord): void {
  const outgoing = record.checklist;
  if (!outgoing) return;
  const owner = checklistOwner(record, outgoing);
  if (owner) owner.checklist = outgoing;
}

/** The current entry stops being the row's: it keeps the state it was left in. */
function leaveCurrentQuestion(record: TaskProgressRecord): void {
  const current = currentQuestion(record);
  if (current) current.state = record.runState;
}

function boundQuestions(record: TaskProgressRecord): void {
  const extra = record.questions.length - TASK_PROGRESS_MAX_QUESTIONS;
  if (extra > 0) record.questions.splice(0, extra);
}

/**
 * The run named for question `turn` starts: its entry becomes the current
 * one. Another run of the same question replaces the question's steps.
 */
function startQuestion(
  record: TaskProgressRecord,
  turn: number,
  runId: string | undefined,
  text: string | undefined,
): void {
  if (!(turn > 0)) return;
  const existing = questionForTurn(record, turn);
  if (existing && existing.runId === runId) {
    if (text && !existing.text) existing.text = text;
    return;
  }
  if (existing) record.questions.splice(record.questions.indexOf(existing), 1);
  const words = text || existing?.text;
  record.questions.push({
    turn,
    ...(runId ? { runId } : {}),
    ...(words ? { text: words } : {}),
    checklist: null,
  });
  boundQuestions(record);
}

/**
 * A run starts: the row turns to working. Called by the request lifecycle
 * (no run id yet) and again by the runtime once it names the run; the second
 * call attaches the id to the same run instead of starting another.
 *
 * `turnIndex` is the question's 1-based position in the conversation. It
 * defaults to the run's position in the order runs were seen. `text` is the
 * user's words.
 *
 * The lifecycle's call comes before its question is in the history, so the
 * number it gives may still be the previous question's (or a retried
 * question's): it creates a question entry only for a number no entry has,
 * and the runtime naming the run settles which question it is.
 */
export function beginTaskRun(
  conversationKey: number,
  params: { runId?: string; turnIndex?: number; text?: string } = {},
): void {
  const record = writable(conversationKey);
  if (!record) return;
  const runId = params.runId?.trim() || undefined;
  const text = params.text?.trim() || undefined;
  const requestedTurn =
    params.turnIndex && params.turnIndex > 0 ? Math.floor(params.turnIndex) : 0;
  if (runId && record.runId === runId) {
    const entry = questionForRun(record, runId);
    let moved = false;
    if (requestedTurn && requestedTurn !== record.turnIndex) {
      record.turnIndex = requestedTurn;
      record.turnByRunId[runId] = requestedTurn;
      if (entry && entry.turn !== requestedTurn) {
        const other = questionForTurn(record, requestedTurn);
        if (other && other !== entry) {
          record.questions.splice(record.questions.indexOf(other), 1);
        }
        entry.turn = requestedTurn;
      }
      moved = true;
    }
    const named = Boolean(entry && text && !entry.text);
    if (entry && named) entry.text = text;
    if (moved || named) changed(record);
    return;
  }
  if (isLive(record.runState) && !record.runId) {
    // The request began this run; the runtime now names it.
    const begun = currentQuestion(record);
    record.runId = runId;
    record.turnIndex = requestedTurn || record.turnIndex;
    if (runId) record.turnByRunId[runId] = record.turnIndex;
    if (begun && !begun.runId && begun.turn === record.turnIndex) {
      // The lifecycle's own entry for this question.
      begun.runId = runId;
      if (text && !begun.text) begun.text = text;
    } else if (runId) {
      startQuestion(record, record.turnIndex, runId, text);
    }
    changed(record);
    return;
  }
  // A replayed start of a run already seen never restarts it.
  if (runId && record.turnByRunId[runId] !== undefined) return;
  const turn = requestedTurn || highestTurn(record) + 1;
  // A new question starts fresh steps; an earlier action's or Codex plan's
  // steps stay with their own question or action.
  if (record.checklist && record.checklist.runId !== runId) {
    keepChecklist(record);
    record.checklist = null;
  }
  leaveCurrentQuestion(record);
  record.runState = "working";
  record.runId = runId;
  record.turnIndex = turn;
  if (runId) record.turnByRunId[runId] = turn;
  if (runId || !questionForTurn(record, turn)) {
    startQuestion(record, turn, runId, text);
  }
  changed(record);
}

/**
 * The question a request asked, as the history holds it once the request
 * ended: its words fill in where none were known. A run no runtime named
 * (plain chat) started under the number the lifecycle could count before
 * the question was added; it takes the question's own number here (the
 * previous question kept its state when the run started).
 */
export function noteTaskQuestion(
  conversationKey: number,
  params: { turnIndex: number; text?: string },
): void {
  const record = records.get(normalizeKey(conversationKey));
  const turn = Math.floor(params.turnIndex || 0);
  if (!record || !(turn > 0)) return;
  const text = params.text?.trim() || undefined;
  let moved = false;
  if (!record.runId && turn > record.turnIndex) {
    record.turnIndex = turn;
    startQuestion(record, turn, undefined, text);
    moved = true;
  }
  const entry = questionForTurn(record, turn);
  const named = Boolean(entry && text && !entry.text);
  if (entry && named) entry.text = text;
  if (!moved && !named) return;
  writable(conversationKey);
  changed(record);
}

/**
 * An entry's steps: the conversation's own while they are its, else the
 * ones it kept.
 */
export function taskQuestionChecklist(
  record: TaskProgressRecord,
  question: TaskProgressQuestion,
): TaskProgressChecklist | null {
  const current = record.checklist;
  if (current && checklistOwner(record, current) === question) return current;
  return question.checklist;
}

/**
 * How an entry ended: its outcome ledger's settled end, an action's own
 * outcome, or the state it was left in. The current entry is the row's.
 */
export function taskQuestionState(
  record: TaskProgressRecord,
  question: TaskProgressQuestion,
): TaskRunState | RunEndState {
  if (question === currentQuestion(record))
    return displayedTaskRunState(record);
  const checklist = taskQuestionChecklist(record, question);
  if (checklist?.source === "outcomes" && checklist.end) return checklist.end;
  if (checklist?.source === "action") return checklist.outcome || "working";
  return question.state || "idle";
}

function turnFor(
  record: TaskProgressRecord,
  runId: string | undefined,
): number | undefined {
  if (runId && record.turnByRunId[runId] !== undefined) {
    return record.turnByRunId[runId];
  }
  if (!runId || runId === record.runId) {
    return record.turnIndex || undefined;
  }
  return undefined;
}

/** True when the event names this record's current run (or names none). */
function isCurrentRun(
  record: TaskProgressRecord,
  runId: string | undefined,
): boolean {
  return !runId || !record.runId || record.runId === runId;
}

/**
 * Fold one `paper_ledger_update` delta in. The turn comes from the run that
 * produced it; a delta from an unknown run falls back to the current turn.
 */
export function applyTaskPaperUpdate(
  conversationKey: number,
  delta: TaskPaperLedgerDelta,
  runId?: string,
): void {
  const record = writable(conversationKey);
  if (!record || !delta) return;
  const run = runId || delta.runId;
  const turn = turnFor(record, run) ?? record.turnIndex;
  // The current run is the newest; a late delta of an earlier run of the
  // same question never takes the question's reads back.
  const newerRunIds =
    record.runId &&
    record.runId !== run &&
    turnFor(record, record.runId) === turn
      ? [record.runId]
      : [];
  const before = Object.keys(record.ledger.appliedCalls).length;
  applyTaskPaperLedgerDelta(record.ledger, delta, turn || undefined, {
    runId: run,
    newerRunIds,
  });
  if (Object.keys(record.ledger.appliedCalls).length !== before) {
    changed(record);
  }
}

/** A live run's events that move its question's outside sources. */
const liveOutsideEvents = new Map<string, { payload: AgentEvent }[]>();

/** Set a question's outside sources; a newer run of it replaces them. */
function setTaskOutside(
  record: TaskProgressRecord,
  turn: number,
  runId: string,
  next: TaskOutsideTurn | null,
): boolean {
  const outside = record.outside || (record.outside = {});
  const before = outside[turn];
  if (!next) {
    if (!before || before.runId === runId) return false;
    delete outside[turn];
    return true;
  }
  if (before && JSON.stringify(before) === JSON.stringify(next)) return false;
  outside[turn] = next;
  return true;
}

/**
 * Fold one live run event into its question's outside sources: a web or
 * scholarly search or read, a library search, or the final answer's markers.
 */
export function applyTaskOutsideEvent(
  conversationKey: number,
  runId: string | undefined,
  event: AgentEvent,
): void {
  if (!runId || !movesTaskOutside(event)) return;
  const record = records.get(normalizeKey(conversationKey));
  if (!record) return;
  const turn = turnFor(record, runId);
  if (!turn) return;
  const events = liveOutsideEvents.get(runId) || [];
  events.push({ payload: event });
  if (event.type === "final") liveOutsideEvents.delete(runId);
  else liveOutsideEvents.set(runId, events);
  if (!setTaskOutside(record, turn, runId, buildTaskOutsideTurn(runId, events)))
    return;
  // A web answer's passages are read from its own text, as it renders.
  const question = questionForTurn(record, turn);
  const answer = question && answerMessages.get(question);
  if (question && answer)
    replaceAnswerCitations(
      question,
      buildTaskAnswerCitations(answer, {
        hasWebSources: answerIsWebSourced(record, question),
      }),
    );
  changed(record);
}

/**
 * The answer started streaming. Returns true on the transition, which also
 * asks every open drawer for this conversation to collapse.
 */
export function markTaskAnswering(
  conversationKey: number,
  runId?: string,
): boolean {
  const record = records.get(normalizeKey(conversationKey));
  if (!record || record.runState !== "working" || !isCurrentRun(record, runId))
    return false;
  writable(conversationKey);
  record.runState = "answering";
  record.collapseSeq += 1;
  changed(record);
  return true;
}

/**
 * The answer is final: mark the papers it cites and show ✓. Applying the
 * same answer again replaces that turn's citations, so it is idempotent.
 */
export function completeTaskRun(
  conversationKey: number,
  params: {
    runId?: string;
    quoteCitations?: readonly QuoteCitation[];
    libraryID?: number;
  } = {},
): void {
  const record = writable(conversationKey);
  if (!record) return;
  const turn = turnFor(record, params.runId);
  if (turn && params.quoteCitations) {
    applyFinalCitations(
      record.ledger,
      params.quoteCitations,
      turn,
      params.libraryID,
    );
  }
  if (isCurrentRun(record, params.runId)) {
    if (params.runId && !record.runId) {
      record.runId = params.runId;
      if (turn) record.turnByRunId[params.runId] = turn;
    }
    record.runState = "completed";
  }
  changed(record);
}

/**
 * The entry an answer belongs to: its run's, or, without a run the record
 * knows, its question's. An earlier run of a question asked again never
 * takes the entry from the newer one.
 */
function answerQuestion(
  record: TaskProgressRecord,
  target: { runId?: string; turn?: number },
): TaskProgressQuestion | undefined {
  const runId = target.runId?.trim();
  if (runId) {
    const own = record.questions.find((question) => question.runId === runId);
    if (own) return own;
    const turn = record.turnByRunId[runId];
    if (turn !== undefined) {
      const entry = questionForTurn(record, turn);
      return entry && !entry.runId ? entry : undefined;
    }
  }
  return target.turn ? questionForTurn(record, target.turn) : undefined;
}

/**
 * The answer each question's cited passages were last read from: when its
 * run's final event arrives after them, they are read again with its web
 * markers in mind. In memory only.
 */
const answerMessages = new WeakMap<
  TaskProgressQuestion,
  Pick<Message, "text" | "quoteCitations" | "quoteDisplayOverride">
>();

/** The question's answer is web-attributed: its run's final event says. */
function answerIsWebSourced(
  record: TaskProgressRecord,
  question: TaskProgressQuestion,
): boolean {
  const outside = record.outside?.[question.turn];
  return Boolean(
    outside?.webSourced &&
    (!question.runId || outside.runId === question.runId),
  );
}

/** Replace an entry's cited passages; true when they changed. */
function replaceAnswerCitations(
  question: TaskProgressQuestion,
  next: TaskAnswerCitation[],
): boolean {
  if (JSON.stringify(question.answerCitations) === JSON.stringify(next))
    return false;
  question.answerCitations = next;
  return true;
}

/**
 * The passages an answer cites, as it is shown now: its question's list,
 * replaced whole (never merged). Called wherever an answer is final or how
 * it shows changes (background quote validation); `message` null clears
 * the list (an answer that records no citations). Changes nothing for a
 * record or question the store does not hold.
 */
export function syncTaskAnswerCitations(
  conversationKey: number,
  target: { runId?: string; turn?: number },
  message: Pick<
    Message,
    "text" | "quoteCitations" | "quoteDisplayOverride"
  > | null,
  /**
   * Whether the answer is web-attributed, as the chat decides it for the
   * render; absent, the question's run's final event says (its markers).
   */
  options: { hasWebSources?: boolean } = {},
): void {
  const record = records.get(normalizeKey(conversationKey));
  if (!record) return;
  const question = answerQuestion(record, target);
  if (!question) return;
  if (message) answerMessages.set(question, message);
  else answerMessages.delete(question);
  const hasWebSources =
    options.hasWebSources ?? answerIsWebSourced(record, question);
  const next = message
    ? buildTaskAnswerCitations(message, { hasWebSources })
    : [];
  if (!replaceAnswerCitations(question, next)) return;
  writable(conversationKey);
  changed(record);
}

/**
 * The paper a document source names, as Zotero knows it: the item its key
 * names, or that item's parent when the key names an attachment.
 */
function resolveDocumentCitationItem(
  citation: TaskPaperDocumentCitation,
): TaskPaperResolvedRef | null {
  try {
    let itemId = Number(citation.itemId) || 0;
    if (!(itemId > 0)) {
      const items = (
        globalThis as {
          Zotero?: {
            Items?: {
              getIDFromLibraryAndKey?: (
                libraryID: number,
                key: string,
              ) => number | false;
            };
          };
        }
      ).Zotero?.Items;
      itemId = Number(
        items?.getIDFromLibraryAndKey?.(citation.libraryID, citation.itemKey),
      );
    }
    if (!Number.isInteger(itemId) || itemId <= 0) return null;
    const paper = resolveZoteroPaperRef({ itemId });
    return paper
      ? { itemId: paper.itemId, libraryID: citation.libraryID }
      : { itemId, libraryID: citation.libraryID };
  } catch {
    return null;
  }
}

/**
 * A submitted document's sources: mark the papers it cites, under the run's
 * question, with the section each first appears in. Re-applying the same
 * sources changes nothing.
 */
export function applyTaskDocumentCitations(
  conversationKey: number,
  runId: string | undefined,
  citations: readonly TaskPaperDocumentCitation[],
): void {
  const record = writable(conversationKey);
  if (!record || !citations?.length) return;
  const turn = turnFor(record, runId);
  if (!turn) return;
  if (foldDocumentCitations(record, citations, turn, runId)) changed(record);
}

function documentCitationIdentity(citation: TaskPaperDocumentCitation): string {
  return [citation.libraryID, citation.itemKey, citation.citationId].join(
    "\u0000",
  );
}

/** Add a document's sources to its question's and re-mark them; true on change. */
function foldDocumentCitations(
  record: TaskProgressRecord,
  citations: readonly TaskPaperDocumentCitation[],
  turn: number,
  runId: string | undefined,
): boolean {
  const byTurn = (record.documentCitations ||= {});
  const held = byTurn[turn];
  // Another run of the same question: its sources replace the earlier run's.
  const merged =
    held && (held.runId || "") === (runId || "") ? [...held.citations] : [];
  const known = new Set(merged.map(documentCitationIdentity));
  for (const citation of citations) {
    const identity = documentCitationIdentity(citation);
    if (known.has(identity)) continue;
    known.add(identity);
    merged.push(citation);
  }
  byTurn[turn] = runId ? { runId, citations: merged } : { citations: merged };
  const before = JSON.stringify(record.ledger.papers);
  applyDocumentCitations(
    record.ledger,
    merged,
    turn,
    resolveDocumentCitationItem,
  );
  return JSON.stringify(record.ledger.papers) !== before;
}

/**
 * A read that took in the paper's text: a digest with an answer, or a
 * paper_read of the whole text, of a whole named section, or of its
 * overview or full-text body (not its metadata, abstract or outline, and
 * not a targeted passage). A scoped digest counts only when what it covered
 * was body text: a summary of the abstract or the notes is no deeper than
 * they are.
 */
export function isInDepthRead(read: TaskPaperReadEvent): boolean {
  if (read.granularity === "digest") {
    if (!read.snippet?.trim()) return false;
    return (
      !read.depth ||
      read.depth === "section" ||
      read.depth === "page" ||
      read.depth === "full"
    );
  }
  if (read.toolName !== "paper_read") return false;
  return (
    read.granularity === "full" ||
    (read.granularity === "section" && read.method === "sections") ||
    ((read.granularity === "passage" || read.granularity === "section") &&
      (read.method === "overview" || read.method === "full"))
  );
}

/**
 * Whether any question of the conversation read a paper in depth: in a
 * Library chat with nothing attached, that is what the row has to show,
 * whether or not the run declared steps.
 */
export function taskReadInDepth(record: TaskProgressRecord | null): boolean {
  return Object.values(record?.ledger.papers || {}).some((entry) =>
    Object.values(entry.turns || {}).some((turn) =>
      turn?.reads.some(isInDepthRead),
    ),
  );
}

/** The run stopped early. The partial ledger stays. */
export function endTaskRun(
  conversationKey: number,
  outcome: "failed" | "cancelled" | "interrupted",
  runId?: string,
): void {
  const record = records.get(normalizeKey(conversationKey));
  if (!record || !isLive(record.runState) || !isCurrentRun(record, runId))
    return;
  writable(conversationKey);
  record.runState = outcome;
  changed(record);
}

/**
 * A decision card opened (`waiting`) or was answered. The run is still live
 * while it waits, and goes back to working once the user decides.
 */
export function markTaskWaiting(
  conversationKey: number,
  runId: string | undefined,
  waiting: boolean,
): void {
  const record = records.get(normalizeKey(conversationKey));
  if (!record || !isCurrentRun(record, runId)) return;
  const applies = waiting
    ? record.runState === "working" || record.runState === "answering"
    : record.runState === "waiting";
  if (!applies) return;
  writable(conversationKey);
  record.runState = waiting ? "waiting" : "working";
  changed(record);
}

/**
 * The state a record shows: how its current run's outcome ledger settled,
 * once it did, or else its run state. A settled ledger is published before
 * the run's final answer, so the answer completing never hides its ending.
 */
export function displayedTaskRunState(
  record: TaskProgressRecord | null | undefined,
): TaskRunState | RunEndState {
  if (!record) return "idle";
  const checklist = record.checklist;
  return checklist?.source === "outcomes" &&
    checklist.end &&
    checklist.runId === record.runId
    ? checklist.end
    : record.runState;
}

/**
 * The scope the latest turn attached. A new signature drops the old listing;
 * the same signature keeps it, so a view can resolve a listing once.
 */
export function setTaskScope(
  conversationKey: number,
  scope: Omit<TaskProgressScope, "listing"> & {
    listing?: TaskPaperScopeListing | null;
  },
): void {
  const record = writable(conversationKey);
  if (!record) return;
  const previous = record.scope;
  if (previous && previous.signature === scope.signature) {
    if (scope.listing && scope.listing !== previous.listing) {
      previous.listing = scope.listing;
      changed(record);
    } else if (scope.label !== previous.label) {
      previous.label = scope.label;
      changed(record);
    }
    return;
  }
  record.scope = { ...scope, listing: scope.listing || null };
  changed(record);
}

// ---------------------------------------------------------------------------
// Checklists: built-in actions and Codex plans
// ---------------------------------------------------------------------------

function countDone(steps: readonly TaskProgressStep[]): number {
  return steps.filter((step) => step.status === "completed").length;
}

/** Steps there are to do: every step but a part another replaced. */
function countSteps(steps: readonly TaskProgressStep[]): number {
  return steps.filter((step) => !step.outcome?.replaced).length;
}

/**
 * A built-in action starts. Its steps become the conversation's steps and
 * the row shows it working, unless a question is running: an action never
 * takes over a live question's state. It gets its own entry in the history,
 * the current one unless a question runs (then it goes just before it).
 * `text` is the user's words when the action was typed with a request.
 */
export function beginTaskAction(
  conversationKey: number,
  params: { runId: string; title: string; text?: string },
): void {
  const record = writable(conversationKey);
  if (!record || !params.runId) return;
  const live = isLive(record.runState);
  if (record.checklist && record.checklist.runId !== params.runId) {
    keepChecklist(record);
  }
  if (!live) leaveCurrentQuestion(record);
  const text = params.text?.trim();
  const entry: TaskProgressQuestion = {
    turn: 0,
    runId: params.runId,
    ...(text ? { text } : {}),
    ...(params.title ? { title: params.title } : {}),
    checklist: null,
  };
  if (live && record.questions.length) {
    record.questions.splice(record.questions.length - 1, 0, entry);
  } else {
    record.questions.push(entry);
  }
  boundQuestions(record);
  record.checklist = {
    source: "action",
    runId: params.runId,
    title: params.title,
    steps: [],
    done: 0,
    total: 0,
    summary: "",
  };
  record.planSeen = true;
  if (!isLive(record.runState)) {
    record.runState = "working";
    record.runId = params.runId;
  }
  changed(record);
}

function actionChecklist(
  record: TaskProgressRecord | null | undefined,
  runId: string,
): TaskProgressChecklist | null {
  const checklist = record?.checklist;
  return checklist?.source === "action" &&
    checklist.runId === runId &&
    !checklist.outcome
    ? checklist
    : null;
}

/** The action reached step `index` of `total`. */
export function setTaskActionStep(
  conversationKey: number,
  runId: string,
  params: { step: string; index: number; total: number },
): void {
  const record = records.get(normalizeKey(conversationKey));
  const checklist = actionChecklist(record, runId);
  if (!record || !checklist) return;
  const index = Math.max(1, Math.floor(params.index) || 1);
  const steps: TaskProgressStep[] = checklist.steps.map((step, position) => ({
    ...step,
    status: position < index - 1 ? "completed" : step.status,
  }));
  steps[index - 1] = { label: params.step, status: "in_progress" };
  for (let position = 0; position < index - 1; position++) {
    steps[position] ||= { label: "", status: "completed" };
  }
  checklist.steps = steps.slice(0, Math.max(index, 0));
  checklist.total = Math.max(Math.floor(params.total) || 0, index);
  checklist.done = countDone(checklist.steps);
  checklist.summary = "";
  writable(conversationKey);
  changed(record);
}

/** The action finished a step and said what it did. */
export function setTaskActionSummary(
  conversationKey: number,
  runId: string,
  summary: string,
): void {
  const record = records.get(normalizeKey(conversationKey));
  const checklist = actionChecklist(record, runId);
  if (!record || !checklist || checklist.summary === summary) return;
  checklist.summary = summary;
  writable(conversationKey);
  changed(record);
}

/** The action ended; the row shows how, with its completion or error text. */
export function endTaskAction(
  conversationKey: number,
  runId: string,
  outcome: "completed" | "failed" | "cancelled",
  detail?: string,
): void {
  const record = records.get(normalizeKey(conversationKey));
  const checklist = actionChecklist(record, runId);
  if (!record || !checklist) return;
  if (outcome === "completed") {
    checklist.steps = checklist.steps.map((step) => ({
      ...step,
      status: "completed",
    }));
    checklist.done = Math.max(checklist.total, checklist.steps.length);
    checklist.total = checklist.done;
  } else {
    checklist.done = countDone(checklist.steps);
  }
  checklist.outcome = outcome;
  if (detail) checklist.detail = detail;
  if (record.runId === runId && isLive(record.runState)) {
    record.runState = outcome;
  }
  writable(conversationKey);
  changed(record);
}

/** Codex's plan or Claude Code's steps for a run, as they stand. */
export function setTaskChecklist(
  conversationKey: number,
  params: {
    source: TaskProgressStepsRuntime;
    runId: string;
    steps: TaskProgressStep[];
    outcome?: TaskProgressChecklist["outcome"];
  },
): void {
  if (!params.runId || !params.steps.length) return;
  const record = writable(conversationKey);
  if (!record) return;
  const previous = record.checklist;
  if (
    previous?.source === params.source &&
    previous.runId === params.runId &&
    previous.outcome === params.outcome &&
    JSON.stringify(previous.steps) === JSON.stringify(params.steps)
  ) {
    return;
  }
  if (previous && previous.runId !== params.runId) keepChecklist(record);
  const done = countDone(params.steps);
  record.checklist = {
    source: params.source,
    runId: params.runId,
    title: "",
    steps: params.steps.map((step) => ({ ...step })),
    done,
    total: params.steps.length,
    summary: "",
    ...(params.outcome ? { outcome: params.outcome } : {}),
  };
  record.planSeen = true;
  changed(record);
}

function copyExceptions(
  entries: readonly OutcomeException[] | undefined,
): OutcomeException[] {
  return (entries || []).map((entry) => ({
    targets: [...entry.targets],
    reason: entry.reason,
  }));
}

/**
 * The steps a run's outcome ledger shows, one per outcome, with how the run
 * ended once it settled. A replaced part keeps its row but is not counted
 * among the steps to do. Null for a ledger with no outcome and no end.
 */
export function taskOutcomesChecklist(
  runId: string,
  checkpoint: ExecutionCheckpoint,
): TaskProgressChecklist | null {
  if (!runId || (!checkpoint.tasks.length && !checkpoint.end)) return null;
  const steps: TaskProgressStep[] = checkpoint.tasks.map((task) => ({
    label: task.description,
    status: task.status,
    ...(task.reason ? { detail: task.reason } : {}),
    outcome: {
      host: task.origin === "host",
      write: task.effect === "mutation",
      read: task.effect === "read",
      digest: task.effect === "digest",
      targets: task.targets?.length || 0,
      doneTargets: task.doneTargets?.length || 0,
      exceptions: copyExceptions(task.exceptions),
      excluded: copyExceptions(task.excludedTargets),
      replaced: Boolean(task.supersededBy),
    },
  }));
  const scopePapers = new Set(
    checkpoint.tasks.flatMap((task) => (task.scope ? task.targets || [] : [])),
  ).size;
  return {
    source: "outcomes",
    runId,
    title: "",
    steps,
    done: countDone(steps),
    total: countSteps(steps),
    summary: "",
    ...(checkpoint.end ? { end: checkpoint.end.state } : {}),
    ...(scopePapers ? { scopePapers } : {}),
  };
}

/**
 * A run's outcome ledger, as its latest checkpoint stands. With at least one
 * outcome the row applies for the conversation, as an action's steps do. A
 * checkpoint that changes nothing the steps show changes nothing here, and
 * another run's checkpoint is ignored.
 */
export function setTaskOutcomes(
  conversationKey: number,
  runId: string,
  checkpoint: ExecutionCheckpoint,
): void {
  const next = taskOutcomesChecklist(runId?.trim() || "", checkpoint);
  if (!next) return;
  const existing = records.get(normalizeKey(conversationKey));
  if (existing && !isCurrentRun(existing, next.runId)) return;
  const record = writable(conversationKey);
  if (!record) return;
  const planSeen = record.planSeen || next.steps.length > 0;
  if (
    planSeen === record.planSeen &&
    JSON.stringify(record.checklist) === JSON.stringify(next)
  ) {
    return;
  }
  if (record.checklist && record.checklist.runId !== next.runId) {
    keepChecklist(record);
  }
  record.checklist = next;
  record.planSeen = planSeen;
  changed(record);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** A run's Codex plan or outcome steps, as its stored events fold. */
export type TaskProgressHistoryChecklist = Omit<
  TaskProgressChecklist,
  "done" | "total" | "summary" | "title"
>;

export type TaskProgressHistoryRun = {
  runId: string;
  /** The question the run answered, 1-based. */
  turn: number;
  /** Still running: its citations are not final yet. */
  live?: boolean;
  deltas: TaskPaperLedgerDelta[];
  /** The citations the persisted answer kept. */
  quoteCitations?: readonly QuoteCitation[];
  /** The passages the persisted answer cites, as it shows them. */
  answerCitations?: TaskAnswerCitation[];
  /** The sources the run's submitted documents cite (`material_finalized`). */
  documentCitations?: readonly TaskPaperDocumentCitation[];
  /** The run's Codex plan or outcome steps, if it had any. */
  checklist?: TaskProgressHistoryChecklist | null;
  /** What the run got from outside the library, if anything. */
  outside?: TaskOutsideTurn | null;
};

/** A question the conversation's user messages hold. */
export type TaskProgressHistoryQuestion = {
  turn: number;
  /** The user's words. */
  text: string;
  /** How its answer ended, or null when it has none. */
  settled: TaskRunState | null;
};

export type TaskProgressHistory = {
  runs: TaskProgressHistoryRun[];
  /** Every question, in order (none in a history saved without them). */
  questions?: TaskProgressHistoryQuestion[];
  /** The latest question's number. */
  latestTurn: number;
  /** How the latest question ended, or null when it has no answer. */
  settled: TaskRunState | null;
  /** A plan, a Codex plan or a run's outcomes ran in the conversation. */
  planSeen: boolean;
  /** The latest run's Codex plan or outcome steps, if it had any. */
  checklist: TaskProgressHistoryChecklist | null;
  libraryID?: number;
};

/** A stored run's steps as the record holds them. */
function historyChecklist(
  checklist: TaskProgressHistoryChecklist,
): TaskProgressChecklist {
  const steps = checklist.steps.map((step) => ({ ...step }));
  return {
    ...checklist,
    title: "",
    steps,
    done: countDone(steps),
    total: countSteps(steps),
    summary: "",
  };
}

/**
 * Fold the history's questions in: each one the record has no entry for
 * goes in by number, before every entry this session started (an action, a
 * later question); one it has gains the words, steps and ending it lacks.
 * Each question takes its latest run's steps.
 */
function hydrateQuestions(
  record: TaskProgressRecord,
  history: TaskProgressHistory,
): void {
  const latestRun = new Map<number, TaskProgressHistoryRun>();
  for (const run of history.runs) {
    if (run.runId && run.turn > 0) latestRun.set(run.turn, run);
  }
  for (const question of history.questions || []) {
    if (!(question.turn > 0)) continue;
    const run = latestRun.get(question.turn);
    const text = question.text?.trim() || undefined;
    const existing = questionForTurn(record, question.turn);
    if (existing) {
      if (text && !existing.text) existing.text = text;
      if (!existing.runId && run && !run.live) existing.runId = run.runId;
      if (
        !existing.checklist &&
        run?.checklist &&
        run.runId === existing.runId
      ) {
        existing.checklist = historyChecklist(run.checklist);
      }
      if (!existing.state && question.settled) {
        existing.state = question.settled;
      }
      continue;
    }
    const at = record.questions.findIndex(
      (entry) => entry.turn === 0 || entry.turn > question.turn,
    );
    record.questions.splice(at < 0 ? record.questions.length : at, 0, {
      turn: question.turn,
      ...(run ? { runId: run.runId } : {}),
      ...(text ? { text } : {}),
      checklist: run?.checklist ? historyChecklist(run.checklist) : null,
      ...(question.settled ? { state: question.settled } : {}),
    });
  }
  boundQuestions(record);
}

/**
 * Fold a conversation's persisted history in: every run's ledger updates
 * under its question, each finished answer's citations, whether a plan ran,
 * and — when nothing runs now — the latest question's outcome. Merges with
 * whatever this session already recorded; every step is idempotent. Returns
 * whether anything changed.
 */
export function hydrateTaskProgress(
  conversationKey: number,
  history: TaskProgressHistory,
): boolean {
  const record = writable(conversationKey);
  if (!record) return false;
  const before = hydrationSignature(record);
  const historyRunIds = new Set(history.runs.map((run) => run.runId));
  for (const [position, run] of history.runs.entries()) {
    if (!run.runId || !(run.turn > 0)) continue;
    if (record.turnByRunId[run.runId] === undefined) {
      record.turnByRunId[run.runId] = run.turn;
    }
    const turn = record.turnByRunId[run.runId];
    // Later runs of the same question, in history or live in this session,
    // keep their reads over this run's.
    const newerRunIds = history.runs
      .slice(position + 1)
      .filter(
        (later) =>
          later.runId &&
          (record.turnByRunId[later.runId] ?? later.turn) === turn,
      )
      .map((later) => later.runId);
    if (
      record.runId &&
      !historyRunIds.has(record.runId) &&
      record.turnByRunId[record.runId] === turn
    )
      newerRunIds.push(record.runId);
    for (const delta of run.deltas) {
      applyTaskPaperLedgerDelta(record.ledger, delta, turn, {
        runId: run.runId,
        newerRunIds,
      });
    }
    if (!run.live && run.quoteCitations) {
      applyFinalCitations(
        record.ledger,
        run.quoteCitations,
        turn,
        history.libraryID,
      );
    }
    if (run.documentCitations?.length) {
      foldDocumentCitations(record, run.documentCitations, turn, run.runId);
    }
  }
  // Each question shows its latest run's outside sources, unless this
  // session ran it again.
  const latestByTurn = new Map<number, TaskProgressHistoryRun>();
  for (const run of history.runs) {
    if (run.runId && run.turn > 0)
      latestByTurn.set(record.turnByRunId[run.runId] ?? run.turn, run);
  }
  for (const [turn, run] of latestByTurn) {
    const rerun =
      record.runId &&
      !historyRunIds.has(record.runId) &&
      record.turnByRunId[record.runId] === turn;
    if (rerun || !run.outside) continue;
    const known = record.outside?.[turn];
    if (known && known.runId !== run.runId) continue;
    setTaskOutside(record, turn, run.runId, run.outside);
  }
  if (history.planSeen) record.planSeen = true;
  // Only a record this session never ran takes the history's outcome.
  if (record.runState === "idle") {
    const latest = history.runs[history.runs.length - 1];
    record.turnIndex = Math.max(record.turnIndex, history.latestTurn);
    if (latest && latest.turn === history.latestTurn) {
      record.runId = latest.runId;
    }
    if (history.settled) record.runState = history.settled;
    if (history.checklist && !record.checklist) {
      record.checklist = historyChecklist(history.checklist);
      // A ledger that only recorded its ending shows no steps.
      if (
        history.checklist.source !== "outcomes" ||
        record.checklist.steps.length
      ) {
        record.planSeen = true;
      }
    }
  }
  hydrateQuestions(record, history);
  // Each question lists the passages its latest finished answer cites,
  // unless this session ran it again.
  for (const [turn, run] of latestByTurn) {
    if (run.live || !run.answerCitations) continue;
    const question = questionForTurn(record, turn);
    if (question && (!question.runId || question.runId === run.runId))
      replaceAnswerCitations(question, run.answerCitations);
  }
  record.hydrated = true;
  // Views repaint only when the history added something: a live run's row
  // must not churn because its conversation's history was folded in.
  if (hydrationSignature(record) === before) return false;
  changed(record);
  return true;
}

function hydrationSignature(record: TaskProgressRecord): string {
  return JSON.stringify([
    record.ledger.papers,
    record.planSeen,
    record.runState,
    record.runId,
    record.turnIndex,
    record.checklist,
    record.questions,
    record.outside,
  ]);
}

/** The 1-based question number of a user message in its conversation. */
export function taskTurnIndexFor(
  history: ReadonlyArray<{ role: string; compactMarker?: boolean }> | undefined,
  userMessage?: { role: string },
): number {
  if (!history?.length) return 0;
  let count = 0;
  for (const message of history) {
    if (message.role !== "user" || message.compactMarker) continue;
    count += 1;
    if (message === userMessage) return count;
  }
  return userMessage ? 0 : count;
}

export function getTaskProgressViewMemo(
  conversationKey: number,
): TaskProgressViewMemo | null {
  const memo = viewMemos.get(normalizeKey(conversationKey));
  return memo
    ? {
        ...memo,
        expanded: [...memo.expanded],
        openFolds: [...memo.openFolds],
        questions: [...memo.questions],
        foldedCurrent: [...memo.foldedCurrent],
        closedCards: [...memo.closedCards],
        showAllFolds: [...memo.showAllFolds],
        ...(memo.top ? { top: { ...memo.top } } : {}),
      }
    : null;
}

/** Merge into the conversation's card state; only while its record exists. */
export function rememberTaskProgressView(
  conversationKey: number,
  patch: Partial<TaskProgressViewMemo>,
): void {
  const key = normalizeKey(conversationKey);
  const record = key ? records.get(key) : undefined;
  if (!record) return;
  const previous = viewMemos.get(key);
  viewMemos.set(key, {
    open: patch.open ?? previous?.open ?? false,
    expanded: [...(patch.expanded ?? previous?.expanded ?? [])],
    openFolds: [...(patch.openFolds ?? previous?.openFolds ?? [])],
    limit: patch.limit ?? previous?.limit ?? 0,
    questions: [...(patch.questions ?? previous?.questions ?? [])],
    foldedCurrent: [...(patch.foldedCurrent ?? previous?.foldedCurrent ?? [])],
    closedCards: [...(patch.closedCards ?? previous?.closedCards ?? [])],
    showAllFolds: [...(patch.showAllFolds ?? previous?.showAllFolds ?? [])],
    scrollTop: patch.scrollTop ?? previous?.scrollTop ?? 0,
    ...((patch.top ?? previous?.top)
      ? { top: { ...(patch.top ?? previous!.top!) } }
      : {}),
    collapseSeq:
      patch.collapseSeq ?? previous?.collapseSeq ?? record.collapseSeq,
  });
}

/** Bumped by every clear; a rebuild started before a clear is dropped. */
const clearCounts = new Map<number, number>();
let clearAllCount = 0;

/** Changes whenever the conversation's record is cleared. */
export function getTaskProgressClearCount(conversationKey: number): number {
  return clearAllCount + (clearCounts.get(normalizeKey(conversationKey)) || 0);
}

export function clearTaskProgress(conversationKey: number): void {
  const key = normalizeKey(conversationKey);
  if (!key) return;
  clearCounts.set(key, (clearCounts.get(key) || 0) + 1);
  viewMemos.delete(key);
  const record = records.get(key);
  if (!record) return;
  records.delete(key);
  record.version += 1;
  notify(key);
}

export function clearAllTaskProgress(): void {
  clearAllCount += 1;
  const keys = Array.from(records.keys());
  records.clear();
  viewMemos.clear();
  liveOutsideEvents.clear();
  for (const key of keys) notify(key);
}

/** Conversation keys kept, least recently written first (tests, diagnostics). */
export function listTaskProgressConversations(): number[] {
  return Array.from(records.keys());
}

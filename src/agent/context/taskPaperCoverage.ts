/**
 * The coverage fold: what a conversation's stored runs say about each paper,
 * as a small paged table for a caller that resumes a large review.
 *
 * It reports reads and decisions so far. It is not proof that a paper was
 * fully covered: a paper with no row was never listed, matched or read.
 *
 * Two pure steps, no DOM and no Zotero globals:
 * - `foldTaskPaperLedgerFromRuns` rebuilds the task paper ledger from stored
 *   `paper_ledger_update` events, as the panel does when it shows a
 *   conversation again (`modules/contextPanel/taskProgress/history.ts` and
 *   `hydrateTaskProgress`), but without importing that module.
 * - `buildTaskPaperCoverage` turns the ledger into one page of rows.
 */
import type { AgentEvent } from "../types";
import {
  TASK_PAPER_READ_GRANULARITY_RANK,
  TASK_PAPER_STATES,
  applyTaskPaperLedgerDelta,
  createTaskPaperLedger,
  latestTaskPaperDecision,
  type TaskPaperDecision,
  type TaskPaperLedger,
  type TaskPaperLedgerDelta,
  type TaskPaperLedgerEntry,
  type TaskPaperReadGranularity,
  type TaskPaperState,
} from "./taskPaperLedger";

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

/** One stored run of a conversation. */
export type TaskPaperCoverageRun = {
  runId: string;
  /**
   * The question this run answered: the conversation's user messages
   * numbered from 1, a compaction marker not counted (the `turn` of a
   * `TaskProgressHistoryRun`). Runs with the same `turn` are runs of one
   * question; a later one replaces the reads and decisions of the earlier
   * ones. A run without a positive `turn` is skipped, as the panel skips it.
   */
  turn: number;
  /** The run's stored events, in order. Only ledger events are read. */
  events: readonly AgentEvent[];
};

/**
 * Fold the conversation's runs into a task paper ledger.
 *
 * `runs` are in conversation order, the order of the answers. Each run's
 * `paper_ledger_update` deltas apply in event order under the run's `turn`.
 * For each run, the runs after it with the same `turn` are passed as newer,
 * so a re-run of a question keeps its own reads and decisions over an
 * earlier run's, whatever order the deltas arrive in.
 *
 * This follows the ledger-delta part of `hydrateTaskProgress` only. It does
 * not apply an answer's quote citations or a document's cited sources, so no
 * paper reaches `cited` here. Pure; the input is not changed.
 */
export function foldTaskPaperLedgerFromRuns(
  runs: readonly TaskPaperCoverageRun[],
): TaskPaperLedger {
  const ledger = createTaskPaperLedger();
  // The first turn a run id was seen under wins, as in the panel's record.
  const turnByRunId = new Map<string, number>();
  for (const [position, run] of runs.entries()) {
    if (!run.runId || !(run.turn > 0)) continue;
    if (!turnByRunId.has(run.runId)) turnByRunId.set(run.runId, run.turn);
    const turn = turnByRunId.get(run.runId) as number;
    const newerRunIds = runs
      .slice(position + 1)
      .filter(
        (later) =>
          later.runId && (turnByRunId.get(later.runId) ?? later.turn) === turn,
      )
      .map((later) => later.runId);
    for (const event of run.events) {
      if (event?.type !== "paper_ledger_update" || !event.delta) continue;
      applyTaskPaperLedgerDelta(
        ledger,
        event.delta as TaskPaperLedgerDelta,
        turn,
        {
          runId: run.runId,
          newerRunIds,
        },
      );
    }
  }
  return ledger;
}

/** The fields of a stored chat message the run numbering reads. */
export type TaskPaperCoverageMessage = {
  role?: unknown;
  compactMarker?: unknown;
  agentRunId?: unknown;
};

/**
 * The runs a conversation's stored messages name, each with the question it
 * answered, in conversation order: the input of `foldTaskPaperLedgerFromRuns`
 * without the events.
 *
 * Numbered as the panel numbers them (`buildTaskProgressHistory` in
 * `modules/contextPanel/taskProgress/history.ts`): each user message is one
 * question, a compaction marker is not one, and an assistant message's
 * `agentRunId` names the run that answered the latest question. An answer
 * before the first question names none. Runs in `excludeRunIds` are left
 * out. Pure.
 */
export function taskPaperCoverageRunsFromMessages(
  messages: readonly TaskPaperCoverageMessage[],
  options: { excludeRunIds?: readonly (string | undefined)[] } = {},
): Array<{ runId: string; turn: number }> {
  const excluded = new Set(
    (options.excludeRunIds || []).filter((id): id is string => Boolean(id)),
  );
  const runs: Array<{ runId: string; turn: number }> = [];
  let question = 0;
  for (const message of messages) {
    if (message?.role === "user") {
      if (message.compactMarker) continue;
      question += 1;
      continue;
    }
    if (message?.role !== "assistant" || question < 1) continue;
    const runId =
      typeof message.agentRunId === "string" ? message.agentRunId.trim() : "";
    if (!runId || excluded.has(runId)) continue;
    runs.push({ runId, turn: question });
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Coverage page
// ---------------------------------------------------------------------------

export const TASK_PAPER_COVERAGE_DEFAULT_LIMIT = 50;
export const TASK_PAPER_COVERAGE_MAX_LIMIT = 200;

export type TaskPaperCoverageDecisionFilter =
  | TaskPaperDecision["value"]
  | "none";

export type TaskPaperCoverageFilter = {
  /** Keep papers in any of these states. Empty or absent keeps all. */
  states?: TaskPaperState[];
  /** Keep papers whose latest decision has this value; "none" keeps those with no decision. */
  decision?: TaskPaperCoverageDecisionFilter;
};

export type TaskPaperCoverageOptions = {
  offset?: number;
  limit?: number;
  filter?: TaskPaperCoverageFilter;
};

/** The agent's latest decision about a paper, without call identity. */
export type TaskPaperCoverageDecision = {
  value: TaskPaperDecision["value"];
  relevance?: TaskPaperDecision["relevance"];
  subquestions?: string[];
  reason: string;
  /** The question that stated it. */
  turnIndex: number;
};

export type TaskPaperCoverageRow = {
  key: string;
  libraryID: number;
  itemId: number;
  itemKey?: string;
  title?: string;
  year?: string;
  creator?: string;
  /** Strongest state over every question. */
  state: TaskPaperState;
  /**
   * The deepest read granularity over every question's kept reads, by
   * `TASK_PAPER_READ_GRANULARITY_RANK`. Absent when the paper has no read.
   * A question keeps a bounded number of reads, so a dropped read is not seen.
   */
  strongestGranularity?: TaskPaperReadGranularity;
  /** Reads recorded over every question, kept and dropped. */
  readCount: number;
  decision?: TaskPaperCoverageDecision;
};

export type TaskPaperCoverageCounts = {
  /** Every paper in the ledger, whatever the filter. */
  total: number;
  byState: Record<TaskPaperState, number>;
  byDecision: Record<TaskPaperDecision["value"], number>;
  /** Papers with no decision. */
  noDecision: number;
};

export type TaskPaperCoverage = {
  papers: TaskPaperCoverageRow[];
  /** Over the whole ledger; the filter does not change them. */
  counts: TaskPaperCoverageCounts;
  /** Papers that pass the filter, before paging. */
  matched: number;
  offset: number;
  limit: number;
  /** Where the next page starts; absent on the last page. */
  nextOffset?: number;
  /** Matching papers after this page. */
  remaining: number;
};

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (value === null || value === undefined || !Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function strongestGranularityOf(
  entry: TaskPaperLedgerEntry,
): TaskPaperReadGranularity | undefined {
  let best: TaskPaperReadGranularity | undefined;
  for (const turn of Object.values(entry.turns)) {
    for (const read of turn.reads) {
      // A scoped digest counts at the depth it covered, not its form.
      const depth = read.depth ?? read.granularity;
      const rank = TASK_PAPER_READ_GRANULARITY_RANK[depth];
      if (rank === undefined) continue;
      if (!best || rank > TASK_PAPER_READ_GRANULARITY_RANK[best]) {
        best = depth;
      }
    }
  }
  return best;
}

function readCountOf(entry: TaskPaperLedgerEntry): number {
  let count = 0;
  for (const turn of Object.values(entry.turns)) {
    count += turn.reads.length + (turn.droppedReads || 0);
  }
  return count;
}

function rowOf(entry: TaskPaperLedgerEntry): TaskPaperCoverageRow {
  const row: TaskPaperCoverageRow = {
    key: entry.key,
    libraryID: entry.libraryID,
    itemId: entry.itemId,
    state: entry.state,
    readCount: readCountOf(entry),
  };
  if (entry.itemKey) row.itemKey = entry.itemKey;
  if (entry.title) row.title = entry.title;
  if (entry.year) row.year = entry.year;
  if (entry.creator) row.creator = entry.creator;
  const strongest = strongestGranularityOf(entry);
  if (strongest) row.strongestGranularity = strongest;
  const decision = latestTaskPaperDecision(entry);
  if (decision) {
    row.decision = {
      value: decision.value,
      ...(decision.relevance ? { relevance: decision.relevance } : {}),
      ...(decision.subquestions?.length
        ? { subquestions: [...decision.subquestions] }
        : {}),
      reason: decision.reason,
      turnIndex: decision.turnIndex,
    };
  }
  return row;
}

const DECISION_FILTERS: ReadonlySet<string> = new Set([
  "include",
  "exclude",
  "defer",
  "none",
]);

function passesFilter(
  row: TaskPaperCoverageRow,
  states: ReadonlySet<TaskPaperState> | null,
  decision: TaskPaperCoverageDecisionFilter | undefined,
): boolean {
  if (states && !states.has(row.state)) return false;
  if (!decision) return true;
  return decision === "none" ? !row.decision : row.decision?.value === decision;
}

/**
 * One page of the ledger's papers in ledger order, with whole-ledger counts.
 *
 * The filter applies before paging; the counts ignore it. `limit` defaults
 * to 50 and is clamped to 1..200; a missing or non-numeric value falls back
 * to the default and `offset` to 0. Pure.
 */
export function buildTaskPaperCoverage(
  ledger: TaskPaperLedger,
  options: TaskPaperCoverageOptions = {},
): TaskPaperCoverage {
  const counts: TaskPaperCoverageCounts = {
    total: 0,
    byState: Object.fromEntries(
      TASK_PAPER_STATES.map((state) => [state, 0]),
    ) as Record<TaskPaperState, number>,
    byDecision: { include: 0, exclude: 0, defer: 0 },
    noDecision: 0,
  };
  const offset = clampInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampInteger(
    options.limit,
    TASK_PAPER_COVERAGE_DEFAULT_LIMIT,
    1,
    TASK_PAPER_COVERAGE_MAX_LIMIT,
  );
  const filter = options.filter || {};
  const stateList = (Array.isArray(filter.states) ? filter.states : []).filter(
    (state) => TASK_PAPER_STATES.includes(state),
  );
  const states = stateList.length ? new Set(stateList) : null;
  const decisionFilter =
    filter.decision && DECISION_FILTERS.has(filter.decision)
      ? filter.decision
      : undefined;

  const papers: TaskPaperCoverageRow[] = [];
  let matched = 0;
  for (const key of ledger.order) {
    const entry = ledger.papers[key];
    if (!entry) continue;
    const row = rowOf(entry);
    counts.total += 1;
    counts.byState[row.state] += 1;
    if (row.decision) counts.byDecision[row.decision.value] += 1;
    else counts.noDecision += 1;
    if (!passesFilter(row, states, decisionFilter)) continue;
    if (matched >= offset && papers.length < limit) papers.push(row);
    matched += 1;
  }
  const end = offset + papers.length;
  const remaining = Math.max(0, matched - end);
  return {
    papers,
    counts,
    matched,
    offset,
    limit,
    ...(remaining > 0 ? { nextOffset: end } : {}),
    remaining,
  };
}

/**
 * The whole-turn stop decisions of the plugin's own agent loop, in one place.
 *
 * `AgentRuntime.runTurn` consults this module each round and acts on what it
 * decides; the module itself is pure (no I/O, no clock of its own). Four
 * rules (docs/plans/2026-10-13-agent-stop-rules.md):
 *
 * 1. Navigation without evidence. Navigation calls (library_search,
 *    library_retrieve, a read-only zotero_script, a paper_read that found
 *    nothing new) are never progress, except a read-only script whose
 *    result the turn has not seen. After `NAVIGATION_ROUNDS_TRIGGER`
 *    navigation rounds and `NAVIGATION_CALLS_TRIGGER` navigation calls since
 *    the last progress, the turn reaches a search checkpoint. Every other
 *    tool keeps the fingerprint rule: a new successful result is progress,
 *    and a whole segment of tool rounds without one stops the turn.
 * 2. Checkpoint, one more window, then a final answer without tools
 *    (`search_exhausted`). A claim that a paper is absent from the library
 *    is sent back once unless the host's record shows the lookups behind it.
 * 3. Safety limits per turn (model calls, input tokens, wall clock), which a
 *    long job restarts each time it settles a paper (`budget_reached`).
 * 4. Incidents: one retry policy for every adapter (`connection_lost` after
 *    it), one compaction for a prompt the provider calls too long.
 *
 * Two errors are guarded against together: stopping too late (a runaway
 * search) and stopping too early (a false "not found", or a pause in normal
 * work). Where a choice trades one for the other, the choice that cannot
 * produce a wrong answer wins.
 *
 * Calibration (the plan's Calibration section):
 * - W and S are twice the longest navigation stretch of a correct
 *   present-paper turn in the CiteME run 1 traces (deepseek-flash, rounds
 *   counted by the runtime's round status events): excerpt 198, 4 navigation
 *   rounds and 9 navigation calls, so W = 8 and S = 18. On the same traces no
 *   correct present-paper turn reaches the trigger; absent excerpt 200 (10
 *   rounds, 18 calls) reaches it in its last round; 243 (7, 14) and 116
 *   (6, 9) do not.
 * - The safety limits are twice the maximum over every library-agent record
 *   in llm4zotero_docs/experiments/benchmarks-2026-10/ (completed turns
 *   without error, CiteME absent excerpts excluded): 50 model calls (CiteME
 *   69) → 100; 3.37 million input tokens (DeepScholar 2505.07166v1) → 6.7
 *   million; 6.1 minutes (CiteME 69) → 12 minutes, floored at 30 minutes
 *   pending the user's decision (a slow local model can reach 12 minutes on
 *   normal work).
 * - Known leak: the CiteME present-paper excerpts are both this calibration
 *   set and the benchmark's P set.
 */
import type { AgentToolEffect } from "../types";
import { buildToolProgressFingerprint } from "../execution/toolResultLifecycle";
import { ModelStreamInterruptedError } from "../model/completion";
import type { RunStopRule } from "./stopRules";

// ── Constants ───────────────────────────────────────────────────────────────

/** W: navigation rounds since the last progress that reach the checkpoint. */
export const NAVIGATION_ROUNDS_TRIGGER = 8;
/** S: navigation calls since the last progress that reach the checkpoint. */
export const NAVIGATION_CALLS_TRIGGER = 18;

export type TurnSafetyLimits = {
  modelCalls: number;
  inputTokens: number;
  wallClockMs: number;
};

/** Rule 3: per-turn safety limits; a long job restarts them as it settles. */
export const TURN_SAFETY_LIMITS: Readonly<TurnSafetyLimits> = Object.freeze({
  modelCalls: 100,
  inputTokens: 6_700_000,
  wallClockMs: 30 * 60_000,
});

/** Rule 4: retries of one failed model step, network or stream or HTTP. */
export const MODEL_STEP_RETRIES = 2;
/** Rule 4: the wait before each retry, unless the provider names one. */
export const MODEL_RETRY_BACKOFF_MS: readonly number[] = Object.freeze([
  2_000, 8_000,
]);
/** The longest provider `retry-after` honored before a retry. */
export const MAX_RETRY_AFTER_MS = 60_000;

/** Why a forced final answer closes the parts it could no longer do. */
export const SEARCH_EXHAUSTED_REASON = "Search exhausted";

/**
 * Final-answer gate: re-asks for the model's open parts since a paper last
 * settled (a long job that keeps settling papers is never cut short).
 */
export const OPEN_PARTS_REASK_LIMIT = 3;

// Failure counters, moved here from the runtime with their constants.
/** Rounds in a row with failing tools and no success that stop the turn. */
export const REPEATED_TOOL_ERROR_ROUNDS = 3;
/** Rounds in a row with only rejected inputs that stop the turn. */
export const REPEATED_INPUT_REJECTION_ROUNDS = 6;
/** The same failure on one paper this many times gives the paper up. */
export const PAPER_FAILURE_REPEATS = 2;
/** At least this many papers given up in a row stop a long job. */
export const MIN_PAPERS_FAILED_IN_A_ROW = 2;

// ── Rule 1: the progress classifier ─────────────────────────────────────────

/** What the boundary reads of one tool call. */
export type BoundaryToolRecord = {
  name: string;
  ok: boolean;
  mutability?: "read" | "write";
  effect?: AgentToolEffect;
  input?: unknown;
  content?: unknown;
  /** For paper_read: whether the read added evidence the turn lacked. */
  frontier?: "advanced" | "unchanged" | "unavailable";
};

/** How one round counts toward the stop rules, as its run event names it. */
export type RoundProgressKind =
  | "progress"
  | "navigation"
  | "no_progress"
  | "no_tools";

type Row = Record<string, unknown>;

function record(value: unknown): Row | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Whether a call only navigates: it lists or finds candidates, or reads
 * again what the turn already holds. Navigation is never progress, whatever
 * its match status says (`strong` is not a "found it" signal).
 */
export function isNavigationCall(call: BoundaryToolRecord): boolean {
  if (call.name === "library_search" || call.name === "library_retrieve")
    return true;
  if (call.name === "zotero_script") return isReadOnlyScript(call);
  return call.name === "paper_read" && call.frontier === "unchanged";
}

/**
 * A zotero_script on the constrained read facade. Only it is a proven read;
 * a privileged script is never treated as one (zoteroScript.ts).
 */
function isReadOnlyScript(call: BoundaryToolRecord): boolean {
  const input = record(call.input);
  return (
    call.name === "zotero_script" &&
    input?.access === "library" &&
    input?.effect === "read"
  );
}

/**
 * A zotero_script declared as a read, on either facade. A privileged read
 * is not a proven read, so it never navigates, but a result it returns that
 * the turn has not seen is progress, as for a read on the library facade.
 */
function isReadScript(call: BoundaryToolRecord): boolean {
  const input = record(call.input);
  return call.name === "zotero_script" && input?.effect === "read";
}

/**
 * A read script's result, without the script: new script text that
 * returns what an earlier one did is no new result. The return value is the
 * result; its log lines (timings, progress) count only when it returns
 * nothing. A script that failed has no result.
 */
function scriptResultFingerprint(call: BoundaryToolRecord): string | undefined {
  const content = record(call.content);
  if (!content || content.error) return undefined;
  return buildToolProgressFingerprint({
    name: call.name,
    content:
      content.returnValue === undefined
        ? { output: content.output }
        : { returnValue: content.returnValue },
  });
}

/**
 * A paper read's content without its per-turn read count: a repeated read
 * would otherwise look new each time.
 */
function withoutReadCount(content: unknown): unknown {
  const row = record(content);
  const progress = record(row?.paperEvidenceProgress);
  if (!row || !progress || !("readsThisTurn" in progress)) return content;
  const { readsThisTurn: _readsThisTurn, ...rest } = progress;
  return { ...row, paperEvidenceProgress: rest };
}

/**
 * The fingerprint a call adds to the turn's progress, or undefined when it
 * cannot count: a failure, a navigation call, a write that changed nothing.
 * A read script (library or privileged) is progress only when it returns a
 * result the turn has not seen (`scriptResultFingerprint`).
 */
export function progressFingerprint(
  call: BoundaryToolRecord,
): string | undefined {
  if (!call.ok) return undefined;
  if (isReadScript(call)) return scriptResultFingerprint(call);
  if (isNavigationCall(call)) return undefined;
  if (
    call.mutability === "write" &&
    call.effect !== "applied" &&
    call.effect !== "partial"
  )
    return undefined;
  return buildToolProgressFingerprint({
    name: call.name,
    effect: call.effect,
    input: call.input,
    content: withoutReadCount(call.content),
  });
}

/**
 * How a round of tool calls counts: progress (a new result fingerprint, or a
 * newly settled paper), navigation (every call navigates), or neither.
 */
export function classifyToolRound(
  calls: readonly BoundaryToolRecord[],
  seenFingerprints: ReadonlySet<string>,
  settledRose: boolean,
): {
  kind: Exclude<RoundProgressKind, "no_tools">;
  navigationCalls: number;
  newFingerprints: string[];
} {
  const newFingerprints = [
    ...new Set(
      calls
        .map(progressFingerprint)
        .filter(
          (fingerprint): fingerprint is string =>
            fingerprint !== undefined && !seenFingerprints.has(fingerprint),
        ),
    ),
  ];
  const navigationCalls = calls.filter(isNavigationCall).length;
  const kind =
    settledRose || newFingerprints.length
      ? "progress"
      : calls.length > 0 && navigationCalls === calls.length
        ? "navigation"
        : "no_progress";
  return { kind, navigationCalls, newFingerprints };
}

// ── Rule 2: the host's record of a search ───────────────────────────────────

export type SearchItem = {
  itemId: string;
  title: string;
  /** The first author and year, when a result carried them. */
  firstAuthor?: string;
  year?: string;
};

/** What the turn's navigation did, from the host's own tool records. */
export type SearchRecord = {
  /** Distinct query strings, as the model wrote them. */
  queries: string[];
  /** Item searches by title, author or other query terms. */
  metadataLookups: number;
  /**
   * Of those, the lookups that returned no item at all (`emptyLookupResult`).
   * The checkpoint and the final-only step show this count to the model.
   */
  emptyLookups: number;
  /** Items the searches listed, in the order first listed. */
  listed: SearchItem[];
  /** Items a successful paper_read read. */
  read: SearchItem[];
  /** Whether any paper_read succeeded. */
  hasRead: boolean;
};

function itemIdOf(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value) && value > 0)
    return String(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim()))
    return value.trim();
  return "";
}

/** Items a paper_read call named. */
function readTargets(input: unknown): string[] {
  const row = record(input);
  if (!row) return [];
  const targets = [
    record(row.target),
    ...(Array.isArray(row.targets) ? row.targets.map(record) : []),
  ];
  return [
    ...targets.map((target) => itemIdOf(target?.itemId)),
    itemIdOf(row.itemId),
  ].filter(Boolean);
}

/** Queries a library_search call carried, and whether it looked items up. */
function searchQueries(input: unknown): {
  queries: string[];
  lookup: boolean;
} {
  const row = record(input);
  if (!row) return { queries: [], lookup: false };
  const filters = record(row.filters);
  const conditions = Array.isArray(row.conditions)
    ? row.conditions.map(record).filter((entry): entry is Row => !!entry)
    : [];
  const queries = [
    text(row.text),
    text(filters?.author) ? `author: ${text(filters?.author)}` : "",
    ...conditions.map((condition) =>
      [text(condition.condition), text(condition.value)]
        .filter(Boolean)
        .join(": "),
    ),
  ].filter(Boolean);
  const entity = text(row.entity) || "items";
  return { queries, lookup: entity === "items" && queries.length > 0 };
}

function listedItems(name: string, content: unknown): SearchItem[] {
  const row = record(content);
  if (!row) return [];
  const entries =
    name === "library_retrieve"
      ? row.paperMatches
      : (row.results ?? row.items ?? row.papers);
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const item = record(entry);
    const itemId = itemIdOf(item?.itemId ?? item?.id);
    return itemId
      ? [{ itemId, title: text(item?.title), ...byline(item) }]
      : [];
  });
}

/** The first author and year a result row carries, if any. */
function byline(item: Row | undefined): {
  firstAuthor?: string;
  year?: string;
} {
  const creators = Array.isArray(item?.creators) ? item!.creators : [];
  const firstAuthor =
    text(item?.firstCreator) ||
    (typeof creators[0] === "string"
      ? text(creators[0])
      : text(record(creators[0])?.lastName) || text(record(creators[0])?.name));
  const year =
    text(item?.year) ||
    (typeof item?.year === "number" ? String(item.year) : "");
  return {
    ...(firstAuthor ? { firstAuthor } : {}),
    ...(year ? { year } : {}),
  };
}

/**
 * Whether one library_search result is empty: its `results` list holds no
 * item and its `totalCount`, when given, is 0. Quick search needs every
 * word, so a guessed title, a wrong year or a misspelling can empty one
 * lookup while another, by the author, lists the paper. A listed item, or a
 * result whose shape the host cannot read, is not empty.
 */
function emptyLookupResult(content: unknown): boolean {
  const row = record(content);
  if (!row || !Array.isArray(row.results) || row.results.length) return false;
  return row.totalCount === undefined || Number(row.totalCount) === 0;
}

/** The host's record of the turn's search, from its tool records. */
export function buildSearchRecord(
  calls: readonly BoundaryToolRecord[],
): SearchRecord {
  const queries = new Map<string, string>();
  const listed = new Map<string, SearchItem>();
  const read = new Map<string, SearchItem>();
  let metadataLookups = 0;
  let emptyLookups = 0;
  let hasRead = false;
  const addQuery = (query: string) => {
    const key = query.toLowerCase().replace(/\s+/g, " ");
    if (key && !queries.has(key)) queries.set(key, query);
  };
  for (const call of calls) {
    if (call.name === "library_search") {
      const { queries: found, lookup } = searchQueries(call.input);
      found.forEach(addQuery);
      if (lookup && call.ok) {
        metadataLookups += 1;
        if (emptyLookupResult(call.content)) emptyLookups += 1;
      }
    } else if (call.name === "library_retrieve") {
      addQuery(text(record(call.input)?.query));
    }
    if (!call.ok) continue;
    if (call.name === "paper_read") {
      hasRead = true;
      for (const itemId of readTargets(call.input))
        if (!read.has(itemId))
          read.set(itemId, {
            itemId,
            title: listed.get(itemId)?.title || "",
          });
      continue;
    }
    if (call.name !== "library_search" && call.name !== "library_retrieve")
      continue;
    const items = listedItems(call.name, call.content);
    for (const item of items)
      if (!listed.has(item.itemId)) listed.set(item.itemId, item);
  }
  for (const [itemId, item] of read)
    if (!item.title && listed.get(itemId)?.title)
      read.set(itemId, { itemId, title: listed.get(itemId)!.title });
  return {
    queries: [...queries.values()],
    metadataLookups,
    emptyLookups,
    listed: [...listed.values()],
    read: [...read.values()],
    hasRead,
  };
}

function itemLabel(item: SearchItem): string {
  const by = [item.firstAuthor, item.year].filter(Boolean).join(", ");
  const where = by ? `${by}; item ${item.itemId}` : `item ${item.itemId}`;
  return item.title ? `“${item.title}” (${where})` : where;
}

function itemList(items: readonly SearchItem[], limit: number): string {
  if (!items.length) return "none";
  const shown = items.slice(0, limit).map(itemLabel).join("; ");
  return items.length > limit
    ? `${shown}; and ${items.length - limit} more`
    : shown;
}

function queryList(queries: readonly string[], limit: number): string {
  if (!queries.length) return "none";
  const shown = queries
    .slice(0, limit)
    .map((query) => `“${query}”`)
    .join(", ");
  return queries.length > limit
    ? `${shown}, and ${queries.length - limit} more`
    : shown;
}

/** The record as the checkpoint and the final-only step show it. */
function renderRecordLines(search: SearchRecord): string[] {
  return [
    `- Searches tried (${search.queries.length}): ${queryList(search.queries, 12)}.`,
    `- Items listed: ${itemList(search.listed, 10)}.`,
    `- Items read: ${itemList(search.read, 10)}.`,
    `- Lookup by title or author: ${
      search.metadataLookups
        ? search.emptyLookups
          ? `made; ${search.emptyLookups < search.metadataLookups ? `${search.emptyLookups} of ${search.metadataLookups}` : search.metadataLookups === 1 ? "it" : "each"} found no item`
          : "made"
        : "not made yet"
    }.`,
  ];
}

/**
 * Whether the record is a lookup that found nothing to read: the turn
 * searched the library and read no paper. Only then can a "not found in the
 * library" answer be offered; a turn that read papers (a question about a
 * paper, a synthesis, an audit) is offered an answer from what it read.
 */
export function isUnreadLookup(search: SearchRecord): boolean {
  return search.queries.length > 0 && !search.hasRead;
}

/**
 * The search checkpoint (Rule 2): a host message, not a stop. It shows the
 * host's record and offers, in this order, to answer, to name one gap and
 * continue, or to answer with what the record shows: "not found" only when
 * the turn searched and read nothing. It never mentions limits, windows,
 * round counts or giving up.
 */
export function renderSearchCheckpoint(
  search: SearchRecord,
  scopeLabel: string,
): string {
  const options = isUnreadLookup(search)
    ? [
        "1. If one of these items is the paper, read it with paper_read and answer with the paper and a quote.",
        "2. If one specific gap remains (for example an author or a title not yet looked up), name that gap and search for it.",
        `3. Otherwise, answer that the paper was not found in ${scopeLabel}, listing the searches and the closest items.`,
      ]
    : [
        "1. If the reads and results so far answer the question, answer now, quoting them.",
        "2. If one specific gap remains (a section, a paper, or a term not yet searched), name that gap and close it.",
        "3. Otherwise, answer with what the reads and searches do and do not show.",
      ];
  return [
    "Search checkpoint. What this turn has done so far, from the host's record:",
    ...renderRecordLines(search),
    "Choose the next step:",
    ...options,
  ].join("\n");
}

/**
 * The instruction of the final answer written without tools: what was found
 * and what was not. Without a title or author lookup, the record cannot show
 * the paper is absent, so the answer may only say it was not confirmed.
 */
export function renderFinalOnlyInstruction(
  search: SearchRecord,
  scopeLabel: string,
): string {
  if (!isUnreadLookup(search))
    return [
      "Answer now, without calling any tool. The host's record of this turn:",
      ...renderRecordLines(search),
      "Answer with what the reads and searches do and do not show, quoting what you read; say “not confirmed” for anything they do not settle.",
    ].join("\n");
  return [
    "Answer now, without calling any tool. The host's record of this turn:",
    ...renderRecordLines(search),
    "Report what you found and what you did not. If the paper is not confirmed, say “not confirmed” and list the searches and the closest items.",
    search.metadataLookups
      ? `Say the paper is not in ${scopeLabel} only if the lookups above show it.`
      : `No lookup by title or author was made, so do not say the paper is absent from ${scopeLabel}; say it was not confirmed.`,
  ].join("\n");
}

/**
 * The answer the host writes when the final-only step still called tools
 * twice: what the record shows, with nothing claimed beyond it.
 */
export function renderSearchExhaustedFallback(
  search: SearchRecord,
  scopeLabel: string,
): string {
  return [
    `I could not confirm the paper in ${scopeLabel}.`,
    "",
    ...renderRecordLines(search),
    "",
    "Say “continue” to search further, or name the paper's title or an author.",
  ].join("\n");
}

// ── Rule 4: the retry policy ────────────────────────────────────────────────

export type ModelFailure =
  | {
      kind: "transient";
      cause: "network" | "stream" | "http";
      status?: number;
      retryAfterMs?: number;
    }
  | { kind: "prompt_too_long" }
  | { kind: "fatal" };

const NETWORK_ERROR =
  /NetworkError|Error in input stream|network error|Failed to fetch|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|connection (?:was )?(?:reset|closed|refused|lost)/i;
const PROMPT_TOO_LONG =
  /prompt is too long|prompt too long|context[_ ]length[_ ]exceeded|maximum context length|context window (?:was )?exhausted|exceeds? the (?:model'?s )?context|input is too long|too many (?:input )?tokens|request too large|input token count \(?\d*\)? exceeds the maximum|exceeded model token limit/i;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

function errorStatus(error: unknown, message: string): number | undefined {
  const own = Number((error as { status?: unknown } | null)?.status);
  if (Number.isInteger(own) && own >= 100) return own;
  const match = /^(\d{3})\b/.exec(message.trim());
  return match ? Number(match[1]) : undefined;
}

/**
 * How a failed model step can be handled: retried (network, a broken stream,
 * HTTP 429/5xx/529), compacted once (a prompt the provider calls too long),
 * or not at all.
 */
export function classifyModelFailure(error: unknown): ModelFailure {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "AbortError") return { kind: "fatal" };
  const message = errorMessage(error);
  const status = errorStatus(error, message);
  const retryAfter = Number(
    (error as { retryAfterMs?: unknown } | null)?.retryAfterMs,
  );
  const retryAfterMs =
    Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined;
  if (error instanceof ModelStreamInterruptedError)
    return {
      kind: "transient",
      cause: "stream",
      ...(error.status ? { status: error.status } : {}),
    };
  if (
    (status === undefined || status === 400 || status === 413) &&
    PROMPT_TOO_LONG.test(message)
  )
    return { kind: "prompt_too_long" };
  if (status !== undefined) {
    return status === 429 || (status >= 500 && status <= 599)
      ? {
          kind: "transient",
          cause: "http",
          status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        }
      : { kind: "fatal" };
  }
  if (NETWORK_ERROR.test(message) || name === "NetworkError")
    return {
      kind: "transient",
      cause: /Error in input stream/i.test(message) ? "stream" : "network",
    };
  return { kind: "fatal" };
}

/**
 * Whether a provider refused the request because of `tool_choice` none: the
 * runtime then sends the final-only step with its default tool choice and
 * refuses any tool call it returns.
 */
export function rejectsToolChoiceNone(error: unknown): boolean {
  const message = errorMessage(error);
  const status = errorStatus(error, message);
  return (
    (status === 400 || status === 422) &&
    /tool[_ ]choice|["'`]none["'`][^.\n]{0,40}(?:not supported|unsupported|invalid)|(?:not supported|unsupported|invalid)[^.\n]{0,40}["'`]none["'`]/i.test(
      message,
    )
  );
}

/**
 * The wait before retry `retry` (1-based): the provider's `retry-after` when
 * it names one (capped), else the backoff.
 */
export function modelRetryDelayMs(
  retry: number,
  failure: Extract<ModelFailure, { kind: "transient" }>,
  backoff: readonly number[] = MODEL_RETRY_BACKOFF_MS,
): number {
  if (failure.retryAfterMs !== undefined)
    return Math.min(MAX_RETRY_AFTER_MS, failure.retryAfterMs);
  return backoff[Math.min(retry, backoff.length) - 1] ?? 0;
}

// ── Resume ──────────────────────────────────────────────────────────────────

/** Stops after which "continue" gets a resume note. */
export const RESUMABLE_STOP_RULES: ReadonlySet<RunStopRule> =
  new Set<RunStopRule>([
    "search_exhausted",
    "budget_reached",
    "connection_lost",
    "prompt_budget_exceeded",
    "empty_answer",
  ]);

const RESUME_REASONS: Partial<Record<RunStopRule, string>> = {
  search_exhausted: "its search ended without confirming the paper",
  budget_reached: "it reached its per-turn safety limit",
  connection_lost: "the connection to the model was lost",
  empty_answer: "the model returned an empty answer twice",
  prompt_budget_exceeded:
    "its prompt stayed too long for the model after compaction; go on only with a narrower step, and if the request needs the whole earlier context, tell the user to narrow the request or start a new chat",
};

/**
 * The prompt-only note a "continue" gets after a turn that stopped by one of
 * the resumable rules, including a turn that declared no parts: its work is
 * the saved transcript above.
 */
export function buildResumeNote(rule: RunStopRule): string | undefined {
  const reason = RESUME_REASONS[rule];
  if (!reason) return undefined;
  return `Resume note: the previous turn stopped before it finished because ${reason}. Its tool calls and results are in the conversation above. Continue the user's request from where it stopped; do not repeat finished steps or any write.`;
}

/** The rule a run's trace recorded at its end, if any. */
export function recordedStopRule(
  events: readonly { payload: unknown }[],
): RunStopRule | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = record(events[index].payload);
    if (
      event?.type === "provider_event" &&
      event.providerType === "agent_run_stop"
    ) {
      const rule = record(event.payload)?.rule;
      return typeof rule === "string" ? (rule as RunStopRule) : undefined;
    }
  }
  return undefined;
}

/** The scope a "not found" answer names: a folder, a tag, or the library. */
export function searchScopeLabel(scope: {
  collections: readonly { name?: string }[];
  tags: readonly { name?: string }[];
}): string {
  const names = (entries: readonly { name?: string }[]) =>
    entries
      .map((entry) => text(entry.name))
      .filter(Boolean)
      .map((name) => `“${name}”`)
      .join(", ");
  if (scope.collections.length)
    return `the selected ${scope.collections.length > 1 ? "collections" : "collection"} ${names(scope.collections)}`.trim();
  if (scope.tags.length) return `the papers tagged ${names(scope.tags)}`.trim();
  return "your library";
}

/**
 * The answer of a turn a resumable incident stopped: why, what it did, and
 * that "continue" goes on. Model text streamed before the stop, if any,
 * leads it.
 */
export function renderStoppedTurnText(params: {
  rule: Extract<
    RunStopRule,
    | "budget_reached"
    | "connection_lost"
    | "prompt_budget_exceeded"
    | "empty_answer"
  >;
  calls: readonly BoundaryToolRecord[];
  parts: { done: number; total: number };
  usage?: { modelCalls: number; elapsedMs: number };
  detail?: string;
}): string {
  const reason =
    params.rule === "budget_reached"
      ? `This turn stopped before it finished: it reached its safety limit${
          params.usage
            ? ` (${params.usage.modelCalls} model requests, ${Math.max(1, Math.round(params.usage.elapsedMs / 60_000))} min)`
            : ""
        }.`
      : params.rule === "connection_lost"
        ? `This turn stopped before it finished: the model could not be reached after ${MODEL_STEP_RETRIES} automatic retries (a network, rate-limit or provider error${params.detail ? `: ${params.detail}` : ""}).`
        : params.rule === "empty_answer"
          ? "The model returned an empty answer twice."
          : "This turn stopped before it finished: the conversation stayed too long for the model after it was compacted.";
  const succeeded = params.calls.filter((call) => call.ok).length;
  const read = buildSearchRecord(params.calls).read.length;
  const done = [
    `${succeeded} tool ${succeeded === 1 ? "call" : "calls"} succeeded`,
    ...(read ? [`${read} ${read === 1 ? "paper" : "papers"} read`] : []),
    ...(params.parts.total
      ? [`${params.parts.done} of ${params.parts.total} parts done`]
      : []),
  ].join(", ");
  return params.rule === "prompt_budget_exceeded"
    ? `${reason} Done so far: ${done}. The work is saved; say “continue” to go on from a compacted transcript, or narrow the request or start a new chat if it stops again.`
    : `${reason} Done so far: ${done}. The work is saved; say “continue” to go on.`;
}

// ── The boundary ────────────────────────────────────────────────────────────

/** What the runtime does after a round, as the boundary decides it. */
export type TurnBoundaryDecision =
  | { kind: "continue" }
  | { kind: "checkpoint" }
  | { kind: "final_only" }
  | { kind: "stop"; rule: RunStopRule };

/** The search phases of Rule 2. */
export type SearchPhase = "searching" | "checkpointed" | "final_only";

/** A round's classification and the counters after it, for its run event. */
export type RoundProgressReport = {
  round: number;
  kind: RoundProgressKind;
  navigationCalls: number;
  navigationRounds: number;
  navigationCallsSinceProgress: number;
  toolRoundsWithoutProgress: number;
  phase: SearchPhase;
};

export type ModelFailureDecision =
  | { kind: "retry"; retry: number; delayMs: number }
  | { kind: "compact" }
  | {
      kind: "stop";
      rule: Extract<RunStopRule, "connection_lost" | "prompt_budget_exceeded">;
    }
  | { kind: "throw" };

/**
 * The turn's boundary: every counter a whole-turn stop reads, and the
 * decisions made from them. One instance per turn.
 */
export class TurnBoundary {
  private readonly limits: TurnSafetyLimits;
  private readonly backoff: readonly number[];
  private readonly navigationRoundsTrigger: number;
  private readonly navigationCallsTrigger: number;
  private readonly maxRounds: number;
  private readonly onSettled?: () => void;

  // Rule 3.
  private windowStart: number;
  private waitedMs = 0;
  private modelCalls = 0;
  private inputTokens = 0;
  private settledTargets: number;

  // Rules 1 and 2.
  private readonly seenFingerprints = new Set<string>();
  private navigationRounds = 0;
  private navigationCalls = 0;
  private toolRoundsWithoutProgress = 0;
  private searchPhase: SearchPhase = "searching";

  // Rule 4.
  private failedAttempts = 0;
  private compacted = false;

  // Failure counters (moved from the runtime).
  private consecutiveToolErrorRounds = 0;
  private consecutiveInputRejectionRounds = 0;
  private readonly paperFailures = new Map<string, number>();
  private failedInARow = 0;
  private failedInARowLimit = 0;

  constructor(params: {
    now: number;
    /** Rounds per segment: the fingerprint rule's span (24, or 32 bulk). */
    maxRounds: number;
    settledTargets: number;
    limits?: Partial<TurnSafetyLimits>;
    retryBackoffMs?: readonly number[];
    navigationTrigger?: { rounds: number; calls: number };
    /**
     * Called when a long job settles a paper; other per-turn counters
     * outside this class (the outside-search ledger) restart with it.
     */
    onSettled?: () => void;
  }) {
    this.onSettled = params.onSettled;
    this.windowStart = params.now;
    this.maxRounds = params.maxRounds;
    this.settledTargets = params.settledTargets;
    this.limits = { ...TURN_SAFETY_LIMITS, ...(params.limits || {}) };
    this.backoff = params.retryBackoffMs ?? MODEL_RETRY_BACKOFF_MS;
    this.navigationRoundsTrigger =
      params.navigationTrigger?.rounds ?? NAVIGATION_ROUNDS_TRIGGER;
    this.navigationCallsTrigger =
      params.navigationTrigger?.calls ?? NAVIGATION_CALLS_TRIGGER;
  }

  get phase(): SearchPhase {
    return this.searchPhase;
  }

  /** Whether the next model step must be written without tools. */
  get finalOnly(): boolean {
    return this.searchPhase === "final_only";
  }

  // Rule 3 ──────────────────────────────────────────────────────────────────

  /**
   * A long job that settled a paper since the last look restarts every
   * safety counter: a job that keeps finishing papers never reaches a limit.
   */
  private noteSettled(settledTargets: number, now: number): boolean {
    if (settledTargets <= this.settledTargets) return false;
    this.settledTargets = settledTargets;
    this.windowStart = now;
    this.waitedMs = 0;
    this.modelCalls = 0;
    this.inputTokens = 0;
    this.compacted = false;
    this.onSettled?.();
    return true;
  }

  /** Time the turn waited on the user (a review card) is not its own. */
  excludeWait(ms: number): void {
    if (ms > 0) this.waitedMs += ms;
  }

  /** One provider request, with the input tokens it reported. */
  recordModelCall(inputTokens: number): void {
    this.modelCalls += 1;
    if (Number.isFinite(inputTokens) && inputTokens > 0)
      this.inputTokens += inputTokens;
  }

  /** Before a model step: whether a safety limit stops the turn. */
  beforeModelCall(params: {
    now: number;
    settledTargets: number;
  }): TurnBoundaryDecision {
    this.noteSettled(params.settledTargets, params.now);
    const elapsed = params.now - this.windowStart - this.waitedMs;
    return this.modelCalls >= this.limits.modelCalls ||
      this.inputTokens >= this.limits.inputTokens ||
      elapsed >= this.limits.wallClockMs
      ? { kind: "stop", rule: "budget_reached" }
      : { kind: "continue" };
  }

  /** The counters of the current safety window, for the stop text. */
  usage(now: number): {
    modelCalls: number;
    inputTokens: number;
    elapsedMs: number;
  } {
    return {
      modelCalls: this.modelCalls,
      inputTokens: this.inputTokens,
      elapsedMs: Math.max(0, now - this.windowStart - this.waitedMs),
    };
  }

  // Rules 1 and 2 ───────────────────────────────────────────────────────────

  /**
   * After a round of tool calls: classify it, move the counters, and decide.
   * A round with progress resets the navigation counters; after the one
   * checkpoint of a turn the search stays in its second phase, so the next
   * full window asks for the answer without tools. A navigation round
   * counts toward the checkpoint only (Rule 1 owns it); a round that is
   * neither navigation nor progress counts toward the fingerprint rule and
   * leaves the navigation counters as they are.
   */
  afterToolRound(params: {
    round: number;
    calls: readonly BoundaryToolRecord[];
    settledTargets: number;
    now: number;
  }): { decision: TurnBoundaryDecision; report: RoundProgressReport } {
    const settledRose = this.noteSettled(params.settledTargets, params.now);
    const classified = classifyToolRound(
      params.calls,
      this.seenFingerprints,
      settledRose,
    );
    for (const fingerprint of classified.newFingerprints)
      this.seenFingerprints.add(fingerprint);
    if (settledRose && this.searchPhase === "checkpointed") {
      // Settling a paper is real progress: the search starts a new phase.
      this.searchPhase = "searching";
      this.navigationRounds = 0;
      this.navigationCalls = 0;
    }
    let decision: TurnBoundaryDecision = { kind: "continue" };
    if (classified.kind === "progress") {
      this.navigationRounds = 0;
      this.navigationCalls = 0;
      this.toolRoundsWithoutProgress = 0;
    } else {
      if (classified.kind === "navigation") {
        this.navigationRounds += 1;
        this.navigationCalls += classified.navigationCalls;
      } else {
        this.toolRoundsWithoutProgress += 1;
      }
      const windowFull =
        this.navigationRounds >= this.navigationRoundsTrigger &&
        this.navigationCalls >= this.navigationCallsTrigger;
      if (windowFull && this.searchPhase === "searching") {
        this.searchPhase = "checkpointed";
        this.navigationRounds = 0;
        this.navigationCalls = 0;
        decision = { kind: "checkpoint" };
      } else if (windowFull && this.searchPhase === "checkpointed") {
        this.searchPhase = "final_only";
        decision = { kind: "final_only" };
      } else if (this.toolRoundsWithoutProgress >= this.maxRounds) {
        decision = { kind: "stop", rule: "segment_without_progress" };
      }
    }
    return {
      decision,
      report: {
        round: params.round,
        kind: classified.kind,
        navigationCalls: classified.navigationCalls,
        navigationRounds: this.navigationRounds,
        navigationCallsSinceProgress: this.navigationCalls,
        toolRoundsWithoutProgress: this.toolRoundsWithoutProgress,
        phase: this.searchPhase,
      },
    };
  }

  /** A round without tool calls, for its run event; it moves no counter. */
  noToolRound(round: number): RoundProgressReport {
    return {
      round,
      kind: "no_tools",
      navigationCalls: 0,
      navigationRounds: this.navigationRounds,
      navigationCallsSinceProgress: this.navigationCalls,
      toolRoundsWithoutProgress: this.toolRoundsWithoutProgress,
      phase: this.searchPhase,
    };
  }

  // Rule 4 ──────────────────────────────────────────────────────────────────

  /**
   * A model step that finished: the next failure starts a new count, and a
   * prompt the provider later calls too long may be compacted again.
   */
  modelStepSucceeded(): void {
    this.failedAttempts = 0;
    this.compacted = false;
  }

  /**
   * A model step that failed. A transient failure is retried up to
   * `MODEL_STEP_RETRIES` times, unless the failed attempt already ran a tool
   * (its effects would repeat); then the turn stops `connection_lost`. A
   * prompt the provider calls too long is compacted once (again after a step
   * that succeeds), then stops `prompt_budget_exceeded`. Anything else is
   * thrown as before. Native adapters run tools only after a step completes,
   * so their failed attempt never ran one; `toolCallSeen` covers an adapter
   * that runs tools during a step through `onToolCall`.
   */
  onModelFailure(
    failure: ModelFailure,
    attempt: { toolCallSeen: boolean },
  ): ModelFailureDecision {
    if (failure.kind === "fatal") return { kind: "throw" };
    if (failure.kind === "prompt_too_long") {
      if (this.compacted)
        return { kind: "stop", rule: "prompt_budget_exceeded" };
      this.compacted = true;
      return { kind: "compact" };
    }
    if (attempt.toolCallSeen) return { kind: "stop", rule: "connection_lost" };
    this.failedAttempts += 1;
    if (this.failedAttempts > MODEL_STEP_RETRIES)
      return { kind: "stop", rule: "connection_lost" };
    return {
      kind: "retry",
      retry: this.failedAttempts,
      delayMs: modelRetryDelayMs(this.failedAttempts, failure, this.backoff),
    };
  }

  // Failure counters (unchanged constants and behavior) ─────────────────────

  /**
   * After a tool round: the rounds in a row with failing tools, or with only
   * rejected inputs. Sibling calls are one attempt.
   */
  recordToolRoundOutcome(round: {
    hadSuccessfulResult: boolean;
    hadToolFailure: boolean;
    hadInputRejection: boolean;
  }):
    | Extract<RunStopRule, "repeated_tool_errors" | "repeated_input_rejections">
    | undefined {
    if (round.hadSuccessfulResult) {
      this.consecutiveToolErrorRounds = 0;
      this.consecutiveInputRejectionRounds = 0;
    } else {
      if (round.hadToolFailure) this.consecutiveToolErrorRounds += 1;
      if (round.hadInputRejection && !round.hadToolFailure)
        this.consecutiveInputRejectionRounds += 1;
    }
    if (this.consecutiveInputRejectionRounds >= REPEATED_INPUT_REJECTION_ROUNDS)
      return "repeated_input_rejections";
    if (this.consecutiveToolErrorRounds >= REPEATED_TOOL_ERROR_ROUNDS)
      return "repeated_tool_errors";
    return undefined;
  }

  /** Whether incomplete model steps used up the segment's rounds. */
  incompleteStepsExhausted(segmentRound: number): boolean {
    return segmentRound >= this.maxRounds;
  }

  /**
   * One failure of a job paper, counted by its reason; true once the same
   * failure happened `PAPER_FAILURE_REPEATS` times and the paper is given up.
   */
  recordPaperFailure(target: string, reason: string): boolean {
    const key = `${target}\n${reason}`;
    const failures = (this.paperFailures.get(key) || 0) + 1;
    this.paperFailures.set(key, failures);
    return failures >= PAPER_FAILURE_REPEATS;
  }

  /**
   * After a long job's round: papers given up since the last one done. A
   * page's worth in a row (the page the run began in, or the papers left
   * before paging), and at least `MIN_PAPERS_FAILED_IN_A_ROW`, stops the
   * job; returns how many failed in a row when it does.
   */
  recordPapersGivenUp(params: {
    doneThisRound: number;
    givenUp: number;
    pageSize: () => number;
  }): number | undefined {
    if (params.doneThisRound > 0) this.failedInARow = 0;
    if (params.givenUp && !this.failedInARow)
      this.failedInARowLimit = Math.max(
        MIN_PAPERS_FAILED_IN_A_ROW,
        params.pageSize(),
      );
    this.failedInARow += params.givenUp;
    return params.givenUp && this.failedInARow >= this.failedInARowLimit
      ? this.failedInARow
      : undefined;
  }
}

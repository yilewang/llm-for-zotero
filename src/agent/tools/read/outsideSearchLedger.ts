import { OUTSIDE_SEARCH_STOP_NOTE } from "./outsideSearchNeed";

/**
 * The turn's record of outside searches, one owner for the text the model
 * reads about them:
 * - a ledger per family (scholarly = literature_search, web = web_search):
 *   the calls that reached a provider, ok or failed, and their queries.
 *   Every outside result closes with it, so the model sees how much it has
 *   searched; at the finish threshold the note asks for the answer.
 * - a latch per provider: once OpenAlex is rate-limited, or web search is
 *   out of quota or rejects its key, later calls this turn return an
 *   unavailable result with one message that names what to do instead.
 * State is keyed by run id (as webAccess/runSources.ts keeps web sources).
 * The runtime clears a run at its end and restarts the counts when a long
 * job settles a paper; a latch stays for the rest of the turn.
 */

export type OutsideSearchFamily = "scholarly" | "web";
export type OutsideSearchLatchKey = "openalex" | "web";

/** At this many outside searches of one family in a turn, finish now. */
export const OUTSIDE_SEARCH_FINISH_AT = 6;
/** At this many, the note no longer allows one more search. */
export const OUTSIDE_SEARCH_FINAL_AT = 12;
/** The note lists at most this many distinct queries. */
export const OUTSIDE_SEARCH_LISTED_QUERIES = 8;
/** A listed query is shortened to this many characters. */
const QUERY_MAX_CHARACTERS = 80;
/** Runs kept at once; a run the runtime never clears is dropped oldest first. */
const MAX_TRACKED_RUNS = 64;
/** The run id prefix of a standalone MCP session (one id for many requests). */
export const SCOPELESS_MCP_RUN_PREFIX = "mcp-run";
/** Whether a run id is one turn, so its searches and latches are tracked. */
export function tracksOutsideSearchTurn(
  runId: string | undefined,
): runId is string {
  return Boolean(runId) && !runId!.startsWith(`${SCOPELESS_MCP_RUN_PREFIX}-`);
}

export const OPENALEX_RATE_LIMIT_MESSAGE =
  "OpenAlex is rate-limited for the rest of this turn (HTTP 429). Do not wait, sleep or retry. Search mode: use source:'europepmc' or 'arxiv'. Recommendations, references and citations need OpenAlex and are unavailable this turn; say so in the answer.";

/** The web latch message; reason is "quota exhausted" or "authentication rejected". */
export function webSearchUnavailableMessage(
  provider: string,
  reason: string,
): string {
  return `Web search is unavailable for the rest of this turn (${provider} ${reason}). Do not retry or fetch pages with shell commands; answer from other sources and say which part could not be checked online.`;
}

const FINISH_NOTE =
  "Finish the request now with what these searches found; if nothing tests the claim, say so and name the searches.";
const ONE_MORE_NOTE = "At most one more search, for one gap you can name.";

type FamilyLedger = { count: number; queries: string[] };
type TurnState = {
  families: Record<OutsideSearchFamily, FamilyLedger>;
  latches: Map<OutsideSearchLatchKey, string>;
};

const turns = new Map<string, TurnState>();

function emptyFamilies(): Record<OutsideSearchFamily, FamilyLedger> {
  return {
    scholarly: { count: 0, queries: [] },
    web: { count: 0, queries: [] },
  };
}

function readState(runId: string): TurnState | undefined {
  return turns.get(runId);
}

function writeState(runId: string): TurnState {
  let state = readState(runId);
  if (!state) {
    state = { families: emptyFamilies(), latches: new Map() };
    turns.set(runId, state);
    while (turns.size > MAX_TRACKED_RUNS) {
      const oldest = turns.keys().next().value;
      if (oldest === undefined) break;
      turns.delete(oldest);
    }
  }
  return state;
}

function shortQuery(query: string): string {
  const flat = query.replace(/\s+/g, " ").trim();
  return flat.length > QUERY_MAX_CHARACTERS
    ? `${flat.slice(0, QUERY_MAX_CHARACTERS - 1).trimEnd()}…`
    : flat;
}

/** One outside search that reached its provider, ok or failed. */
export function recordOutsideSearch(
  runId: string,
  family: OutsideSearchFamily,
  query: string,
): void {
  const ledger = writeState(runId).families[family];
  ledger.count += 1;
  const label = shortQuery(query);
  if (label && !ledger.queries.includes(label)) ledger.queries.push(label);
}

export function outsideSearchCount(
  runId: string,
  family: OutsideSearchFamily,
): number {
  return readState(runId)?.families[family].count || 0;
}

function queryList(queries: readonly string[]): string {
  if (!queries.length) return "none";
  const shown = queries.slice(0, OUTSIDE_SEARCH_LISTED_QUERIES).join("; ");
  return queries.length > OUTSIDE_SEARCH_LISTED_QUERIES
    ? `${shown}; and ${queries.length - OUTSIDE_SEARCH_LISTED_QUERIES} more`
    : shown;
}

/**
 * The last field of an outside result: the family's count and queries,
 * then the stop note, or below it the finish-now note at the thresholds.
 */
export function buildOutsideSearchNote(
  runId: string,
  family: OutsideSearchFamily,
): string {
  const ledger = readState(runId)?.families[family];
  if (!ledger?.count) return OUTSIDE_SEARCH_STOP_NOTE;
  const head = `Outside searches this turn: ${ledger.count} ${family} (queries: ${queryList(ledger.queries)}).`;
  if (ledger.count >= OUTSIDE_SEARCH_FINAL_AT) return `${head} ${FINISH_NOTE}`;
  if (ledger.count >= OUTSIDE_SEARCH_FINISH_AT)
    return `${head} ${FINISH_NOTE} ${ONE_MORE_NOTE}`;
  return `${head} ${OUTSIDE_SEARCH_STOP_NOTE}`;
}

/** Fail every later call to this provider in the turn with this message. */
export function latchOutsideSearch(
  runId: string,
  key: OutsideSearchLatchKey,
  message: string,
): void {
  writeState(runId).latches.set(key, message);
}

/** The latch message when the provider is latched for this turn. */
export function outsideSearchLatch(
  runId: string,
  key: OutsideSearchLatchKey,
): string | undefined {
  return readState(runId)?.latches.get(key);
}

/** A long job settled a paper: its next paper starts with fresh counts. */
export function resetOutsideSearchLedger(runId: string): void {
  const state = readState(runId);
  if (state) state.families = emptyFamilies();
}

/** The run ended. */
export function clearOutsideSearchTurn(runId: string): void {
  turns.delete(runId);
}

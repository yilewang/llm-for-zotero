/**
 * Rebuild a conversation's Task progress from what it persisted, when the
 * conversation is shown again (panel mount, conversation switch, restart).
 *
 * Sources, all already stored — nothing new is written:
 * - the question numbering and each question's words: the conversation's
 *   user messages, and how each was answered: its answer;
 * - every run's `paper_ledger_update` events (in-plugin Agent runs and the
 *   Codex/Claude Code run snapshots, which carry the MCP deltas);
 * - each finished answer's `quoteCitations`, the citations it rendered;
 * - each submitted document's sources (`material_finalized.citedSources`);
 * - whether a plan ran (`plan_*` events), Codex kept a plan (its
 *   `codex-plan-checklist` event) or a run had outcomes (its
 *   `execution_checkpoint` events): the row then stays for the conversation;
 * - each run's Codex plan, or its latest outcome ledger with how the run
 *   ended: the latest run's are the steps, every earlier question keeps
 *   its own in the drawer's history.
 *
 * A built-in action leaves no conversation record, so its steps and its
 * "an action ran here" mark last only for the session.
 *
 * Rebuilding is lazy (a panel sync asks), once per record, and never for a
 * conversation being deleted or whose key is retired.
 */
import { ExecutionCheckpointFold } from "../../../agent/execution/checkpointEvents";
import { listAgentRunEventsForRuns } from "../../../agent/store/traceStore";
import type { AgentRunEventRecord } from "../../../agent/types";
import type {
  TaskPaperDocumentCitation,
  TaskPaperLedgerDelta,
} from "../../../agent/context/taskPaperLedger";
import { isConversationKeyRetiredInMemory } from "../../../shared/conversationKeyLedger";
import {
  areConversationWritesFrozen,
  getConversationWriteGeneration,
} from "../../../shared/conversationWriteFence";
import { chatHistory, loadedConversationKeys } from "../state";
import type { Message } from "../types";
import {
  TASK_PROGRESS_REPLAY_EVENT_TYPES,
  taskProgressEffect,
} from "./runFold";
import {
  getTaskProgress,
  getTaskProgressClearCount,
  hydrateTaskProgress,
  taskOutcomesChecklist,
  type TaskProgressHistory,
  type TaskProgressHistoryChecklist,
  type TaskProgressHistoryQuestion,
  type TaskProgressHistoryRun,
  type TaskRunState,
} from "./store";

/** Event kinds a rebuild reads; everything else in a trace is skipped. */
export const TASK_PROGRESS_HISTORY_EVENT_TYPES =
  TASK_PROGRESS_REPLAY_EVENT_TYPES;

function settledState(message: Message | undefined): TaskRunState | null {
  if (!message || message.role !== "assistant" || message.streaming) {
    return null;
  }
  if (message.text === "[Cancelled]") return "cancelled";
  if (message.interrupted) return "interrupted";
  if (/^Error:/.test(message.text || "")) return "failed";
  return "completed";
}

/** The history a conversation's messages and run events describe. Pure. */
export function buildTaskProgressHistory(
  messages: readonly Message[],
  eventsByRun: ReadonlyMap<string, readonly AgentRunEventRecord[]>,
  libraryID?: number,
): TaskProgressHistory {
  const runs: TaskProgressHistoryRun[] = [];
  const questions: TaskProgressHistoryQuestion[] = [];
  /** The question the next answer settles; none after a compaction marker. */
  let asked: TaskProgressHistoryQuestion | null = null;
  let question = 0;
  let planSeen = false;
  for (const message of messages) {
    if (message.role === "user") {
      asked = null;
      if (message.compactMarker) continue;
      question += 1;
      asked = { turn: question, text: message.text || "", settled: null };
      questions.push(asked);
      continue;
    }
    if (asked && message.role === "assistant") {
      asked.settled = settledState(message);
    }
    const runId = message.agentRunId?.trim();
    if (message.role !== "assistant" || !runId || question < 1) continue;
    const events = eventsByRun.get(runId) || [];
    const deltas: TaskPaperLedgerDelta[] = [];
    // Every document the run finalized: each names only its own sources.
    const documentCitations: TaskPaperDocumentCitation[] = [];
    // The run's ledger events fold to its ledger as it stood last; its
    // steps are that ledger's outcomes, or Codex's latest plan.
    const ledger = new ExecutionCheckpointFold();
    let checklist: TaskProgressHistoryChecklist | null = null;
    for (const entry of events) {
      const effect = taskProgressEffect(entry.payload);
      if (!effect) continue;
      switch (effect.kind) {
        case "paper_delta":
          if (effect.delta) deltas.push(effect.delta);
          break;
        case "document_citations":
          documentCitations.push(...(effect.citations || []));
          break;
        case "outcomes": {
          const checkpoint = ledger.apply(effect.event);
          if (checkpoint?.tasks?.length) planSeen = true;
          if (checkpoint)
            checklist = taskOutcomesChecklist(runId, checkpoint) ?? checklist;
          break;
        }
        case "plan_seen":
          planSeen = true;
          break;
        case "codex_checklist":
          planSeen = true;
          checklist = { source: "codex", runId, steps: effect.steps };
          break;
        default:
          // Live-only effects (answering, waiting, final) are not replayed.
          break;
      }
    }
    runs.push({
      runId,
      turn: question,
      live: Boolean(message.streaming),
      deltas,
      quoteCitations: message.quoteCitations,
      ...(documentCitations.length ? { documentCitations } : {}),
      checklist,
    });
  }
  const last = messages[messages.length - 1];
  const latest = runs[runs.length - 1];
  return {
    runs,
    questions,
    latestTurn: question,
    settled: settledState(last),
    planSeen,
    checklist:
      latest && latest.turn === question ? latest.checklist || null : null,
    libraryID,
  };
}

type HistoryLoader = (runIds: string[]) => Promise<AgentRunEventRecord[]>;

const defaultLoader: HistoryLoader = (runIds) =>
  listAgentRunEventsForRuns(runIds, TASK_PROGRESS_HISTORY_EVENT_TYPES);

let loader: HistoryLoader = defaultLoader;
const inflight = new Map<number, Promise<void>>();

export function setTaskProgressHistoryLoaderForTests(
  next?: HistoryLoader,
): void {
  loader = next || defaultLoader;
}

export async function waitForTaskProgressHydrationForTests(
  conversationKey: number,
): Promise<void> {
  await inflight.get(conversationKey);
}

/** True while the conversation may not be rebuilt at all. */
function isFenced(conversationKey: number): boolean {
  return (
    isConversationKeyRetiredInMemory(conversationKey) ||
    areConversationWritesFrozen(conversationKey)
  );
}

/**
 * Fold the conversation's persisted history into its Task progress record,
 * once. Waits for the conversation's messages to load; drops the result if
 * the conversation was cleared, deleted or retired while its events loaded.
 */
export function ensureTaskProgressHydrated(
  conversationKey: number,
  libraryID?: number,
  onHydrated?: () => void,
): void {
  const key = Math.floor(Number(conversationKey) || 0);
  if (!(key > 0) || inflight.has(key)) return;
  if (getTaskProgress(key)?.hydrated) return;
  if (!loadedConversationKeys.has(key) || isFenced(key)) return;
  const generation = getConversationWriteGeneration(key);
  const clears = getTaskProgressClearCount(key);
  const stillCurrent = () =>
    !isFenced(key) &&
    getConversationWriteGeneration(key) === generation &&
    getTaskProgressClearCount(key) === clears &&
    loadedConversationKeys.has(key);
  const runIds = Array.from(
    new Set(
      (chatHistory.get(key) || [])
        .map((message) =>
          message.role === "assistant" ? message.agentRunId?.trim() || "" : "",
        )
        .filter(Boolean),
    ),
  );
  const task = (async () => {
    const events = runIds.length ? await loader(runIds) : [];
    if (!stillCurrent()) return;
    const byRun = new Map<string, AgentRunEventRecord[]>();
    for (const event of events) {
      const list = byRun.get(event.runId);
      if (list) list.push(event);
      else byRun.set(event.runId, [event]);
    }
    const changed = hydrateTaskProgress(
      key,
      buildTaskProgressHistory(chatHistory.get(key) || [], byRun, libraryID),
    );
    if (changed) onHydrated?.();
  })()
    .catch(() => undefined)
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, task);
}

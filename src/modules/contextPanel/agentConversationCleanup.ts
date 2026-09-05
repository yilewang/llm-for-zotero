import { clearAllAgentToolCaches } from "../../agent/tools";
import { clearAgentMemory } from "../../agent/store/conversationMemory";
import { clearAgentTranscript } from "../../agent/store/transcriptStore";
import { clearPersistedAgentToolResultHandles } from "../../agent/store/toolResultHandles";
import { clearPersistedAgentEvidence } from "../../agent/context/cacheManagement";
import { clearPersistedAgentCoverage } from "../../agent/context/coverageLedger";
import { clearRememberedLocalDocumentPaths } from "../../agent/privacy/localDocumentPathRedaction";
import {
  clearAgentTraceState,
  queueAgentTraceFileCleanupInTransaction,
  rememberAgentTraceRunIDsForDeletedConversation,
} from "../../agent/store/traceStore";
import {
  JOURNAL_ACTIONS_TABLE,
  LEGACY_JOURNAL_TABLE,
  queueJournalRecoveryBlobCleanupInTransaction,
  sweepJournalRecoveryBlobCleanup,
  JOURNAL_OBSERVATIONS_TABLE,
  JOURNAL_PAYLOADS_TABLE,
  JOURNAL_STEPS_TABLE,
} from "../../agent/store/changeJournal";
import { clearAgentRuntimeTraceState } from "./agentState";

export type AgentConversationCleanupDeps = {
  clearAgentToolCaches?: (conversationKey: number) => void;
  clearAgentConversationState?: (conversationKey: number) => Promise<void>;
  log: (message: string, ...args: unknown[]) => void;
};

const AGENT_MEMORY_TABLE = "llm_for_zotero_agent_memory";
const AGENT_TRANSCRIPT_TABLE = "llm_for_zotero_agent_transcript";
const AGENT_TOOL_RESULT_HANDLES_TABLE =
  "llm_for_zotero_agent_tool_result_handles";
const AGENT_EVIDENCE_TABLE = "llm_for_zotero_agent_evidence";
const AGENT_COVERAGE_TABLE = "llm_for_zotero_agent_coverage";
const AGENT_RUNS_TABLE = "llm_for_zotero_agent_runs";
const AGENT_RUN_EVENTS_TABLE = "llm_for_zotero_agent_run_events";
const AGENT_TRACE_EXPORTS_TABLE = "llm_for_zotero_agent_trace_exports";

function getAgentDb(): {
  queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
} | null {
  const db = (globalThis as { Zotero?: { DB?: { queryAsync?: unknown } } })
    .Zotero?.DB;
  return typeof db?.queryAsync === "function"
    ? (db as {
        queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
      })
    : null;
}

async function deleteIfPresent(
  db: { queryAsync: (sql: string, params?: unknown[]) => Promise<unknown> },
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  try {
    await db.queryAsync(sql, params);
  } catch (error) {
    // These stores are initialized lazily.  An absent table means there are no
    // rows to delete; every other failure must reach the owning transaction so
    // local catalog deletion rolls back instead of leaving a partial purge.
    if (/no such table|no table/i.test(String(error))) return;
    throw error;
  }
}

/**
 * Delete every agent-owned database participant inside the conversation
 * catalog's active transaction.  Runtime caches and trace-export files are
 * cleared after commit, but persistent rows are removed atomically with the
 * catalog, messages, forks, registry, index, tombstone, and provider job.
 */
export async function clearPersistedAgentConversationRowsInTransaction(
  conversationKey: number,
): Promise<void> {
  const key = Math.floor(Number(conversationKey));
  const db = getAgentDb();
  if (!db || !Number.isFinite(key) || key <= 0) return;

  const runRows = (await db
    .queryAsync(
      `SELECT run_id AS runId FROM ${AGENT_RUNS_TABLE} WHERE conversation_key = ?`,
      [key],
    )
    .catch((error) => {
      if (/no such table|no table/i.test(String(error))) return [];
      throw error;
    })) as Array<{ runId?: unknown }>;
  const runIds = (runRows || [])
    .map((row) => (typeof row.runId === "string" ? row.runId.trim() : ""))
    .filter(Boolean);
  const exportRows = (await db
    .queryAsync(
      `SELECT run_id AS runId FROM ${AGENT_TRACE_EXPORTS_TABLE} WHERE conversation_key = ?`,
      [key],
    )
    .catch((error) => {
      if (/no such table|no table/i.test(String(error))) return [];
      throw error;
    })) as Array<{ runId?: unknown }>;
  const exportRunIds = (exportRows || [])
    .map((row) => (typeof row.runId === "string" ? row.runId.trim() : ""))
    .filter(Boolean);
  rememberAgentTraceRunIDsForDeletedConversation(key, [
    ...runIds,
    ...exportRunIds,
  ]);
  await queueAgentTraceFileCleanupInTransaction(key, [
    ...runIds,
    ...exportRunIds,
  ]);
  if (runIds.length) {
    const placeholders = runIds.map(() => "?").join(", ");
    await deleteIfPresent(
      db,
      `DELETE FROM ${AGENT_RUN_EVENTS_TABLE} WHERE run_id IN (${placeholders})`,
      runIds,
    );
  }
  await deleteIfPresent(
    db,
    `DELETE FROM ${AGENT_RUNS_TABLE} WHERE conversation_key = ?`,
    [key],
  );
  await deleteIfPresent(
    db,
    `DELETE FROM ${AGENT_TRACE_EXPORTS_TABLE} WHERE conversation_key = ?`,
    [key],
  );
  await deleteIfPresent(
    db,
    `DELETE FROM ${AGENT_MEMORY_TABLE} WHERE conversation_key = ?`,
    [key],
  );
  await deleteIfPresent(
    db,
    `DELETE FROM ${AGENT_TRANSCRIPT_TABLE} WHERE conversation_key = ?`,
    [key],
  );
  await deleteIfPresent(
    db,
    `DELETE FROM ${AGENT_TOOL_RESULT_HANDLES_TABLE} WHERE conversation_key = ?`,
    [key],
  );
  await deleteIfPresent(
    db,
    `DELETE FROM ${AGENT_EVIDENCE_TABLE} WHERE conversation_key = ?`,
    [key],
  );
  await deleteIfPresent(
    db,
    `DELETE FROM ${AGENT_COVERAGE_TABLE}
     WHERE scope_key = ? OR origin_conversation_key = ?`,
    [`conversation:${key}`, key],
  );
  await queueJournalRecoveryBlobCleanupInTransaction(key).catch((error) => {
    if (/no such table|no table/i.test(String(error))) return;
    throw error;
  });
  for (const table of [
    JOURNAL_OBSERVATIONS_TABLE,
    JOURNAL_PAYLOADS_TABLE,
    JOURNAL_STEPS_TABLE,
  ]) {
    await deleteIfPresent(
      db,
      `DELETE FROM ${table} WHERE action_id IN (
         SELECT action_id FROM ${JOURNAL_ACTIONS_TABLE}
         WHERE conversation_key = ?
       )`,
      [key],
    );
  }
  await deleteIfPresent(
    db,
    `DELETE FROM ${JOURNAL_ACTIONS_TABLE} WHERE conversation_key = ?`,
    [key],
  );
  await deleteIfPresent(
    db,
    `DELETE FROM ${LEGACY_JOURNAL_TABLE} WHERE conversation_key = ?`,
    [key],
  );
}

export async function clearAgentConversationState(
  conversationKey: number,
): Promise<void> {
  clearRememberedLocalDocumentPaths(conversationKey);
  let firstError: unknown;
  const capture = async (task: () => Promise<void>): Promise<void> => {
    try {
      await task();
    } catch (err) {
      firstError ??= err;
    }
  };
  await Promise.all([
    capture(async () => {
      const traceRunIds = await clearAgentTraceState(conversationKey);
      clearAgentRuntimeTraceState(traceRunIds);
    }),
    capture(() => clearAgentMemory(conversationKey)),
    capture(() => clearAgentTranscript(conversationKey)),
    capture(() => clearPersistedAgentToolResultHandles(conversationKey)),
    capture(() => clearPersistedAgentEvidence(conversationKey)),
    capture(() => clearPersistedAgentCoverage(conversationKey)),
    capture(() => sweepJournalRecoveryBlobCleanup(conversationKey)),
  ]);
  if (firstError) throw firstError;
}

export async function clearDeletedAgentConversationState(
  deps: AgentConversationCleanupDeps,
  conversationKey: number,
  kind: "global" | "paper",
): Promise<boolean> {
  let hasError = false;
  try {
    (deps.clearAgentToolCaches || clearAllAgentToolCaches)(conversationKey);
  } catch (err) {
    hasError = true;
    deps.log(`LLM: Failed to clear deleted ${kind} agent tool caches`, err);
  }
  try {
    await (deps.clearAgentConversationState || clearAgentConversationState)(
      conversationKey,
    );
  } catch (err) {
    hasError = true;
    deps.log(
      `LLM: Failed to clear deleted ${kind} agent conversation state`,
      err,
    );
  }
  return hasError;
}

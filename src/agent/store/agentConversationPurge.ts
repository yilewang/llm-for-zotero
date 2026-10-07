import { deleteAgentEvidenceRowsInTransaction } from "../context/cacheManagement";
import { deleteAgentCoverageRowsInTransaction } from "../context/coverageLedger";
import {
  clearPlanDocumentConversationRowsInTransaction,
  clearPlanDocumentTurnRowsInTransaction,
} from "../documents/store";
import {
  deleteJournalRowsForRunsInTransaction,
  deleteJournalRowsInTransaction,
  queueJournalRecoveryBlobCleanupForRunsInTransaction,
  queueJournalRecoveryBlobCleanupInTransaction,
} from "./changeJournal";
import { deleteAgentMemoryRowsInTransaction } from "./conversationMemory";
import { clearDormantPlanRowsInTransaction } from "./dormantPlanTables";
import { clearDormantResearchRowsInTransaction } from "./dormantResearchTables";
import { isMissingTableError, type AgentPurgeDb } from "./inTransactionDelete";
import { deleteAgentToolResultHandleRowsInTransaction } from "./toolResultHandles";
import {
  deleteAgentTraceRowsForRunsInTransaction,
  deleteAgentTraceRowsInTransaction,
  listAgentTraceRunIDsInTransaction,
  queueAgentTraceFileCleanupInTransaction,
  rememberAgentTraceRunIDsForDeletedConversation,
} from "./traceStore";
import { deleteAgentTranscriptRowsInTransaction } from "./transcriptStore";

/** What the purge needs from above the agent layer. */
export type AgentConversationPurgeDeps = {
  /**
   * Drops the conversation's Task progress record (it lives in the panel
   * layer); the view rebuilds it from the rows that remain.
   */
  clearTaskProgress(conversationKey: number): void;
};

function getAgentDb(): AgentPurgeDb | null {
  const db = (globalThis as { Zotero?: { DB?: { queryAsync?: unknown } } })
    .Zotero?.DB;
  return typeof db?.queryAsync === "function" ? (db as AgentPurgeDb) : null;
}

/** Runs one store's purge step, treating an absent table as no rows. */
async function ignoringMissingTable(task: Promise<void>): Promise<void> {
  await task.catch((error) => {
    if (isMissingTableError(error)) return;
    throw error;
  });
}

/**
 * A purge that ran inside a transaction.  The transaction's owner calls
 * `rollback()` when the transaction fails: the rows come back with the
 * rollback, and this undoes what the purge changed outside the database.
 */
export type AgentConversationPurge = {
  rollback(): void;
};

const NOTHING_TO_ROLL_BACK: AgentConversationPurge = { rollback() {} };

/**
 * Delete every agent-owned database participant inside the conversation
 * catalog's active transaction.  Runtime caches and trace-export files are
 * cleared after commit, but persistent rows are removed atomically with the
 * catalog, messages, forks, registry, index, tombstone, and provider job.
 *
 * Every store's whole-conversation row purge (conversation deletion, the
 * WebChat startup sweep) passes here; turn deletion and edit truncation take
 * the turn form, `purgeAgentConversationTurn`.  The order is fixed:
 * Task progress first; the trace run IDs are read and remembered (and their
 * trace files queued) before any row goes; then the trace, memory,
 * transcript, tool-result handle, evidence and coverage rows, the dormant
 * plan and research rows, the plan documents, and the change journal.
 *
 * The remembered run IDs mark the conversation's runs as deleted, so a late
 * run is dropped until the post-commit cleanup clears the mark.  That mark
 * lives outside the database, so a rollback does not undo it: the purge
 * undoes it itself when it fails part-way, and the returned `rollback()`
 * undoes it when the owning transaction fails later.  Without that, every
 * later agent run of a conversation whose deletion rolled back is deleted
 * the moment it starts.  Task progress needs no undo: the panel rebuilds a
 * cleared record from the rows that remain.
 */
export async function purgeAgentConversation(
  conversationKey: number,
  deps: AgentConversationPurgeDeps,
): Promise<AgentConversationPurge> {
  const key = Math.floor(Number(conversationKey));
  if (Number.isFinite(key) && key > 0) deps.clearTaskProgress(key);
  const db = getAgentDb();
  if (!db || !Number.isFinite(key) || key <= 0) return NOTHING_TO_ROLL_BACK;

  const { runIds, exportRunIds } = await listAgentTraceRunIDsInTransaction(
    db,
    key,
  );
  return purgeAgentRows(db, key, [...runIds, ...exportRunIds], {
    deleteTraceRows: () => deleteAgentTraceRowsInTransaction(db, key, runIds),
    deletePlanDocuments: () =>
      clearPlanDocumentConversationRowsInTransaction(key),
    queueJournalBlobCleanup: () =>
      queueJournalRecoveryBlobCleanupInTransaction(key),
    deleteJournalRows: () => deleteJournalRowsInTransaction(db, key),
  });
}

/**
 * The turn form of `purgeAgentConversation`, for turn deletion and edit
 * truncation. Deleting one turn used to delete the trace, plan documents and
 * undo history of every turn in the chat; now only the deleted turn's go:
 *
 * - the trace of the runs the deleted rows named;
 * - the change journal (undo history) recorded under those runs;
 * - the plan documents the deleted rows named and no remaining row names.
 *
 * The memory, transcript, tool-result handle, evidence and coverage rows and
 * the dormant plan and research rows are still purged for the whole
 * conversation, in the same order, so the deleted turn's content cannot
 * reach the next prompt. The post-commit cleanup of the queued runs is
 * `clearQueuedAgentTraceRuns`.
 */
export async function purgeAgentConversationTurn(
  conversationKey: number,
  deleted: { agentRunIds: readonly string[]; documentIds: readonly string[] },
  deps: AgentConversationPurgeDeps,
): Promise<AgentConversationPurge> {
  const key = Math.floor(Number(conversationKey));
  if (Number.isFinite(key) && key > 0) deps.clearTaskProgress(key);
  const db = getAgentDb();
  if (!db || !Number.isFinite(key) || key <= 0) return NOTHING_TO_ROLL_BACK;
  const runIds = uniqueIds(deleted.agentRunIds);
  const documentIds = uniqueIds(deleted.documentIds);
  return purgeAgentRows(db, key, runIds, {
    deleteTraceRows: () =>
      deleteAgentTraceRowsForRunsInTransaction(db, key, runIds),
    deletePlanDocuments: () =>
      clearPlanDocumentTurnRowsInTransaction(key, documentIds),
    queueJournalBlobCleanup: () =>
      queueJournalRecoveryBlobCleanupForRunsInTransaction(key, runIds),
    deleteJournalRows: () =>
      deleteJournalRowsForRunsInTransaction(db, key, runIds),
  });
}

function uniqueIds(ids: readonly string[]): string[] {
  return Array.from(
    new Set(
      ids
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter(Boolean),
    ),
  );
}

/**
 * The shared body of both purges: remember and queue `traceRunIds`, then
 * delete the agent rows in the fixed order. The trace, the plan documents and
 * the change journal are deleted as `scoped` scopes them; every other row is
 * deleted for the whole conversation.
 */
async function purgeAgentRows(
  db: AgentPurgeDb,
  key: number,
  traceRunIds: readonly string[],
  scoped: {
    deleteTraceRows: () => Promise<void>;
    deletePlanDocuments: () => Promise<void>;
    queueJournalBlobCleanup: () => Promise<void>;
    deleteJournalRows: () => Promise<void>;
  },
): Promise<AgentConversationPurge> {
  const forgetDeletedRuns = rememberAgentTraceRunIDsForDeletedConversation(
    key,
    traceRunIds,
  );
  try {
    await queueAgentTraceFileCleanupInTransaction(key, traceRunIds);
    await scoped.deleteTraceRows();
    await deleteAgentMemoryRowsInTransaction(db, key);
    await deleteAgentTranscriptRowsInTransaction(db, key);
    await deleteAgentToolResultHandleRowsInTransaction(db, key);
    await deleteAgentEvidenceRowsInTransaction(db, key);
    await deleteAgentCoverageRowsInTransaction(db, key);
    await ignoringMissingTable(clearDormantPlanRowsInTransaction(key));
    await ignoringMissingTable(clearDormantResearchRowsInTransaction(key));
    await ignoringMissingTable(scoped.deletePlanDocuments());
    await ignoringMissingTable(scoped.queueJournalBlobCleanup());
    await scoped.deleteJournalRows();
  } catch (error) {
    forgetDeletedRuns();
    throw error;
  }
  return { rollback: forgetDeletedRuns };
}

import { deleteAgentEvidenceRowsInTransaction } from "../context/cacheManagement";
import { deleteAgentCoverageRowsInTransaction } from "../context/coverageLedger";
import { clearPlanDocumentConversationRowsInTransaction } from "../documents/store";
import {
  deleteJournalRowsInTransaction,
  queueJournalRecoveryBlobCleanupInTransaction,
} from "./changeJournal";
import { deleteAgentMemoryRowsInTransaction } from "./conversationMemory";
import { clearDormantPlanRowsInTransaction } from "./dormantPlanTables";
import { clearDormantResearchRowsInTransaction } from "./dormantResearchTables";
import { isMissingTableError, type AgentPurgeDb } from "./inTransactionDelete";
import { deleteAgentToolResultHandleRowsInTransaction } from "./toolResultHandles";
import {
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
 * Every store's local row purge (conversation and turn deletion, edit
 * truncation, the WebChat startup sweep) passes here.  The order is fixed:
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
  const forgetDeletedRuns = rememberAgentTraceRunIDsForDeletedConversation(
    key,
    [...runIds, ...exportRunIds],
  );
  try {
    await queueAgentTraceFileCleanupInTransaction(key, [
      ...runIds,
      ...exportRunIds,
    ]);
    await deleteAgentTraceRowsInTransaction(db, key, runIds);
    await deleteAgentMemoryRowsInTransaction(db, key);
    await deleteAgentTranscriptRowsInTransaction(db, key);
    await deleteAgentToolResultHandleRowsInTransaction(db, key);
    await deleteAgentEvidenceRowsInTransaction(db, key);
    await deleteAgentCoverageRowsInTransaction(db, key);
    await ignoringMissingTable(clearDormantPlanRowsInTransaction(key));
    await ignoringMissingTable(clearDormantResearchRowsInTransaction(key));
    await ignoringMissingTable(
      clearPlanDocumentConversationRowsInTransaction(key),
    );
    await ignoringMissingTable(
      queueJournalRecoveryBlobCleanupInTransaction(key),
    );
    await deleteJournalRowsInTransaction(db, key);
  } catch (error) {
    forgetDeletedRuns();
    throw error;
  }
  return { rollback: forgetDeletedRuns };
}

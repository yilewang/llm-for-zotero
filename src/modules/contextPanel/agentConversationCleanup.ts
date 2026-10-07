import { clearAllAgentToolCaches } from "../../agent/tools";
import { clearAgentMemory } from "../../agent/store/conversationMemory";
import { clearAgentTranscript } from "../../agent/store/transcriptStore";
import { clearPersistedAgentToolResultHandles } from "../../agent/store/toolResultHandles";
import { clearPersistedAgentEvidence } from "../../agent/context/cacheManagement";
import { clearPersistedAgentCoverage } from "../../agent/context/coverageLedger";
import { clearRememberedLocalDocumentPaths } from "../../agent/privacy/localDocumentPathRedaction";
import {
  clearAgentTraceState,
  clearQueuedAgentTraceRuns,
} from "../../agent/store/traceStore";
import { sweepJournalRecoveryBlobCleanup } from "../../agent/store/changeJournal";
import {
  purgeAgentConversation,
  purgeAgentConversationTurn,
  type AgentConversationPurge,
} from "../../agent/store/agentConversationPurge";
import type { TurnDeletionBeforeCommit } from "../../shared/conversationStore/localRowDeletion";
import { clearAgentRuntimeTraceState } from "./agentState";
import { clearTaskProgress } from "./taskProgress/store";

export type AgentConversationCleanupDeps = {
  clearAgentToolCaches?: (conversationKey: number) => void;
  clearAgentConversationState?: (conversationKey: number) => Promise<void>;
  log: (message: string, ...args: unknown[]) => void;
};

/**
 * Delete every agent-owned database participant inside the conversation
 * catalog's active transaction (see purgeAgentConversation).  The purge lives
 * in the agent store layer; this binds the panel's Task progress store to it,
 * so every store's local row purge drops the Task progress built from these
 * rows, and the view rebuilds it from what remains.
 */
export async function clearPersistedAgentConversationRowsInTransaction(
  conversationKey: number,
): Promise<AgentConversationPurge> {
  return purgeAgentConversation(conversationKey, { clearTaskProgress });
}

/**
 * Run a turn-row deletion whose transaction purges the turn's agent rows in
 * its onBeforeCommit (turn deletion, edit truncation): the trace of the runs
 * the deleted rows named, and the conversation's other agent rows (see
 * purgeAgentConversationTurn).  When that transaction fails, the purge's
 * in-memory part is rolled back with it.
 */
export async function withAgentTurnPurge(
  conversationKey: number,
  deleteRows: (onBeforeCommit: TurnDeletionBeforeCommit) => Promise<void>,
): Promise<void> {
  let purge: AgentConversationPurge | undefined;
  try {
    await deleteRows(async ({ agentRunIds }) => {
      purge = await purgeAgentConversationTurn(conversationKey, agentRunIds, {
        clearTaskProgress,
      });
    });
  } catch (error) {
    purge?.rollback();
    throw error;
  }
}

/** Clears a deleted conversation's agent state outside the database. */
export async function clearAgentConversationState(
  conversationKey: number,
): Promise<void> {
  await clearAgentStateAfterCommit(conversationKey, clearAgentTraceState);
}

/**
 * Clears the agent state outside the database after a turn deletion or edit
 * truncation committed: the runs that deletion queued (their trace files and
 * cached traces) and nothing of the remaining turns' runs, then the
 * conversation's other agent state, as for a whole conversation.
 */
export async function clearAgentTurnState(
  conversationKey: number,
): Promise<void> {
  await clearAgentStateAfterCommit(conversationKey, clearQueuedAgentTraceRuns);
}

async function clearAgentStateAfterCommit(
  conversationKey: number,
  clearTraceRuns: (conversationKey: number) => Promise<string[]>,
): Promise<void> {
  clearRememberedLocalDocumentPaths(conversationKey);
  clearTaskProgress(conversationKey);
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
      const traceRunIds = await clearTraceRuns(conversationKey);
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

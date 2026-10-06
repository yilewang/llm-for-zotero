import { appLogger } from "../../core/logging";
import { conversationRepository } from "../../core/conversations/repository";
import {
  areConversationWritesFrozen,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../../shared/conversationWriteFence";
import { resolveConversationStorageSystem } from "../../shared/conversationStorageRouting";
import type { ConversationSystem } from "../../shared/types";
import {
  clearAgentConversationState,
  withAgentConversationPurge,
} from "./agentConversationCleanup";

/** A stored turn after the edited one: its user and assistant timestamps. */
export type TrailingTurnPair = { userTs: number; assistantTs: number };

type TrailingTurnTarget = {
  conversationKey: number;
  conversationGeneration: number;
  conversationSystem: ConversationSystem;
};

/**
 * Delete the stored turns after an edited turn (edit and retry).
 *
 * Each pair goes in its own transaction under the conversation write lock,
 * and that transaction also purges the conversation's agent rows (agent
 * state is keyed by the conversation, not by the message rows).  The loop
 * stops at the first pair it cannot delete: the conversation changed (write
 * generation), its writes are frozen, it has no storage system, or the
 * delete failed.  Returns true when every pair was deleted.
 *
 * Once any pair has committed, the agent state outside the database is
 * cleared too (caches, trace files, the purge's mark on the deleted runs),
 * even when a later pair failed: the committed purge already removed every
 * agent row, and the mark left behind would drop every later agent run of
 * the conversation.
 */
export async function deleteTrailingTurnPairs(
  params: TrailingTurnTarget & { pairs: readonly TrailingTurnPair[] },
): Promise<boolean> {
  let committedPairs = 0;
  try {
    for (const pair of params.pairs) {
      if (!(await deleteTrailingTurnPair(params, pair))) return false;
      committedPairs += 1;
    }
    return true;
  } finally {
    if (committedPairs > 0) {
      try {
        await clearAgentConversationState(params.conversationKey);
      } catch (err) {
        appLogger.warn(
          "LLM: Failed to clear agent state after edit truncation",
          err,
        );
      }
    }
  }
}

async function deleteTrailingTurnPair(
  target: TrailingTurnTarget,
  pair: TrailingTurnPair,
): Promise<boolean> {
  const { conversationKey, conversationGeneration } = target;
  try {
    return await withConversationWriteLock(conversationKey, async () => {
      if (
        !isConversationWriteGenerationCurrent(
          conversationKey,
          conversationGeneration,
        ) ||
        areConversationWritesFrozen(conversationKey)
      ) {
        return false;
      }
      const storageSystem = resolveConversationStorageSystem({
        conversationKey,
        conversationSystem: target.conversationSystem,
      });
      if (!storageSystem) return false;
      await withAgentConversationPurge(conversationKey, (onBeforeCommit) =>
        conversationRepository.deleteTurnMessages({
          system: storageSystem,
          conversationKey,
          userTimestamp: pair.userTs,
          assistantTimestamp: pair.assistantTs,
          onBeforeCommit,
        }),
      );
      return true;
    });
  } catch (err) {
    appLogger.warn("LLM: Failed to delete subsequent stored turn", err);
    return false;
  }
}

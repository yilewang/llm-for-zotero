import { appLogger } from "../../core/logging";
import { conversationRepository } from "../../core/conversations/repository";
import {
  areConversationWritesFrozen,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../../shared/conversationWriteFence";
import { resolveConversationStorageSystem } from "../../shared/conversationStorageRouting";
import type { ConversationSystem } from "../../shared/types";
import { withAgentConversationPurge } from "./agentConversationCleanup";

/** A stored turn after the edited one: its user and assistant timestamps. */
export type TrailingTurnPair = { userTs: number; assistantTs: number };

/**
 * Delete the stored turns after an edited turn (edit and retry).
 *
 * Each pair goes in its own transaction under the conversation write lock,
 * and that transaction also purges the conversation's agent rows (agent
 * state is keyed by the conversation, not by the message rows).  The loop
 * stops at the first pair it cannot delete: the conversation changed (write
 * generation), its writes are frozen, it has no storage system, or the
 * delete failed.  Returns true when every pair was deleted.
 */
export async function deleteTrailingTurnPairs(params: {
  conversationKey: number;
  pairs: readonly TrailingTurnPair[];
  conversationGeneration: number;
  conversationSystem: ConversationSystem;
}): Promise<boolean> {
  const { conversationKey, conversationGeneration } = params;
  for (const p of params.pairs) {
    try {
      const deleted = await withConversationWriteLock(
        conversationKey,
        async () => {
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
            conversationSystem: params.conversationSystem,
          });
          if (!storageSystem) return false;
          await withAgentConversationPurge(conversationKey, (onBeforeCommit) =>
            conversationRepository.deleteTurnMessages({
              system: storageSystem,
              conversationKey,
              userTimestamp: p.userTs,
              assistantTimestamp: p.assistantTs,
              onBeforeCommit,
            }),
          );
          return true;
        },
      );
      if (!deleted) return false;
    } catch (err) {
      appLogger.warn("LLM: Failed to delete subsequent stored turn", err);
      return false;
    }
  }
  return true;
}

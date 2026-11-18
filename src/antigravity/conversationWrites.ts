import { antigravityConversationStore } from "./store";
import type { StoredChatMessage } from "../utils/chatStore";
import {
  areConversationWritesFrozen,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
} from "../shared/conversationWriteFence";

/**
 * Antigravity message writes made while the caller holds the conversation
 * write lock, modelled on the Claude Code ones in src/claudeCode/runtime.ts:
 * each write also touches the catalog row (activity time and model).
 */

type Store = typeof antigravityConversationStore;

/** Caller must already hold the conversation write lock. */
async function touchAntigravityConversationWithinWriteLock(
  conversationKey: number,
  updates: { updatedAt?: number; model?: string | null; instanceID?: string },
): Promise<void> {
  if (
    areConversationWritesFrozen(conversationKey) ||
    !isConversationWriteGenerationCurrent(
      conversationKey,
      getConversationWriteGeneration(conversationKey),
    )
  ) {
    return;
  }
  const summary =
    await antigravityConversationStore.getSummary(conversationKey);
  if (!summary) return;
  if (
    updates.instanceID &&
    summary.instanceID &&
    updates.instanceID !== summary.instanceID
  ) {
    return;
  }
  const hasModel = Object.prototype.hasOwnProperty.call(updates, "model");
  await antigravityConversationStore.upsertSummary({
    conversationKey: summary.conversationKey,
    instanceID: summary.instanceID,
    libraryID: summary.libraryID,
    kind: summary.kind,
    paperItemID: summary.paperItemID,
    createdAt: summary.createdAt,
    updatedAt: updates.updatedAt || Date.now(),
    title: summary.title,
    providerSessionId: summary.providerSessionId,
    scopedConversationKey: summary.scopedConversationKey,
    scopeType: summary.scopeType,
    scopeId: summary.scopeId,
    scopeLabel: summary.scopeLabel,
    cwd: summary.cwd,
    model: hasModel ? updates.model || undefined : summary.model,
    effort: summary.effort,
  });
}

/** Caller must already hold the conversation write lock. */
export async function appendAntigravityConversationMessageWithinWriteLock(
  conversationKey: number,
  message: StoredChatMessage,
  instanceID?: string,
): Promise<void> {
  await antigravityConversationStore.appendMessage(
    conversationKey,
    message,
    instanceID,
  );
  await antigravityConversationStore.pruneConversation(conversationKey);
  await touchAntigravityConversationWithinWriteLock(conversationKey, {
    updatedAt: message.timestamp,
    model: message.modelName,
    instanceID,
  });
}

/**
 * Caller must already hold the conversation write lock. With
 * `options.expectedTimestamp` the write targets that user row only. Returns
 * whether the row was written.
 */
export async function updateLatestAntigravityConversationUserMessageWithinWriteLock(
  conversationKey: number,
  message: Parameters<Store["updateLatestUserMessage"]>[1],
  options?: Parameters<Store["updateLatestUserMessage"]>[2],
): Promise<boolean> {
  const written = await antigravityConversationStore.updateLatestUserMessage(
    conversationKey,
    message,
    options,
  );
  if (!written) return false;
  await touchAntigravityConversationWithinWriteLock(conversationKey, {
    updatedAt: message.timestamp,
  });
  return true;
}

/**
 * Caller must already hold the conversation write lock. With
 * `options.expectedTimestamp` the write targets that assistant row only.
 * Returns whether the row was written.
 */
export async function updateLatestAntigravityConversationAssistantMessageWithinWriteLock(
  conversationKey: number,
  message: Parameters<Store["updateLatestAssistantMessage"]>[1],
  options?: Parameters<Store["updateLatestAssistantMessage"]>[2],
): Promise<boolean> {
  const written =
    await antigravityConversationStore.updateLatestAssistantMessage(
      conversationKey,
      message,
      options,
    );
  if (!written && options?.expectedTimestamp !== undefined) return false;
  await touchAntigravityConversationWithinWriteLock(conversationKey, {
    updatedAt: message.timestamp,
    model: message.modelName,
  });
  return written;
}

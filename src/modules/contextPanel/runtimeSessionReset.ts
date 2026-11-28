/**
 * Detaches a conversation's runtime session (the Claude Code session, the
 * Codex thread, the agy session) before the plugin re-sends a turn the
 * session already holds.
 *
 * A runtime keeps every turn it has seen. When the user edits an earlier
 * message, or retries or edits the latest one, the turns being replaced are
 * still in that session; re-sending on it shows the model the answer the user
 * is replacing (a retry asking for a new random number sees the old one).
 * The original agent rebuilds its transcript from the chat on every turn, so
 * it never has this problem. Detaching makes the next turn start a session
 * that never saw those turns; the chat's remaining history reaches it as
 * each runtime's fresh-session history (agent/context/runtimeHistory.ts).
 *
 * The cleanup obligation is persisted before the provider call, so an outage
 * cannot turn the reset into an untracked provider leak.
 */

import { conversationRepository } from "../../core/conversations/repository";
import {
  enqueueConversationCleanupJob,
  performConversationCleanupJobAttempt,
} from "../../core/conversations/conversationCleanupJobs";
import {
  assertNeverConversationSystem,
  type ConversationSystem,
} from "../../core/conversations/conversationSystems";
import { clearCodexConversationSessionMetadata } from "../../codexAppServer/store";
import { archiveCodexAppServerThread } from "../../codexAppServer/nativeClient";
import { isProviderNotFoundError } from "./conversationDeletion";
import { clearCodexNativeReadLedgerForConversation } from "../../codexAppServer/nativeContextLedger";
import { antigravityConversationStore } from "../../antigravity/store";
import {
  buildClaudeScope,
  invalidateClaudeConversationSessionWithinWriteLock,
} from "../../claudeCode/runtime";
import { initAgentSubsystem } from "../../agent/index";
import {
  areConversationWritesFrozen,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../../shared/conversationWriteFence";

/**
 * A reset runs because the user retried or edited a turn, so it attempts
 * the provider cleanup now, even after an earlier attempt failed.
 */
const USER_ATTEMPT = { ignoreRetryDelay: true } as const;

async function detachRuntimeProviderSession(
  conversationKey: number,
  catalog: Awaited<ReturnType<typeof conversationRepository.getCatalogEntry>>,
): Promise<boolean> {
  if (!catalog) return false;
  const providerSessionId = String(catalog.providerSessionId || "").trim();
  switch (catalog.system) {
    case "codex": {
      if (!providerSessionId) return true;
      const job = await enqueueConversationCleanupJob({
        operation: "codex_archive",
        system: "codex",
        conversationKey,
        instanceID: catalog.instanceID,
        conversationKind: catalog.kind,
        libraryID: catalog.libraryID,
        paperItemID: catalog.paperItemID,
        providerSessionId,
      });
      if (!job) return false;
      const attempt = await performConversationCleanupJobAttempt(
        job,
        async () => {
          try {
            await archiveCodexAppServerThread({ threadId: providerSessionId });
          } catch (error) {
            // A thread Codex no longer has is already detached.
            if (!isProviderNotFoundError(error)) throw error;
          }
        },
        USER_ATTEMPT,
      );
      if (!attempt.ok) return false;
      await clearCodexConversationSessionMetadata(
        conversationKey,
        providerSessionId,
        catalog.instanceID,
      );
      return true;
    }
    case "claude_code": {
      const scope = buildClaudeScope({
        libraryID: catalog.libraryID,
        kind: catalog.kind,
        paperItemID: catalog.paperItemID,
      });
      if (!catalog.instanceID || (!providerSessionId && !scope.scopeId)) {
        return !providerSessionId;
      }
      const job = await enqueueConversationCleanupJob({
        operation: "claude_invalidate",
        system: "claude_code",
        conversationKey,
        instanceID: catalog.instanceID,
        conversationKind: catalog.kind,
        libraryID: catalog.libraryID,
        paperItemID: catalog.paperItemID,
        providerScope: scope,
        providerSessionId,
      });
      if (!job) return false;
      const attempt = await performConversationCleanupJobAttempt(
        job,
        async () =>
          invalidateClaudeConversationSessionWithinWriteLock(
            await initAgentSubsystem(),
            {
              conversationKey,
              scope,
              metadata: {
                ...(providerSessionId ? { providerSessionId } : {}),
                instanceID: catalog.instanceID,
              },
            },
          ),
        USER_ATTEMPT,
      );
      if (!attempt.ok) return false;
      return true;
    }
    case "antigravity": {
      // ACP cannot delete a session or its turns, so there is no provider
      // job; detaching the catalog from the session makes the next turn
      // start a fresh session that never saw the truncated turns.
      if (!providerSessionId) return true;
      await antigravityConversationStore.clearConversationSessionMetadata(
        conversationKey,
        providerSessionId,
        catalog.instanceID,
      );
      return true;
    }
    case "upstream":
      return true;
    default:
      return assertNeverConversationSystem(catalog.system);
  }
}

/**
 * Detaches the conversation's runtime session under its write lock, if the
 * conversation is still the one the caller started from. False when the
 * conversation moved on or the session could not be detached: the caller
 * must not re-send then.
 */
export async function detachRuntimeSessionForResend(params: {
  conversationKey: number;
  conversationGeneration: number;
  storageSystem: ConversationSystem;
  kind: "paper" | "global";
}): Promise<boolean> {
  const { conversationKey, conversationGeneration } = params;
  return withConversationWriteLock(conversationKey, async () => {
    if (
      areConversationWritesFrozen(conversationKey) ||
      !isConversationWriteGenerationCurrent(
        conversationKey,
        conversationGeneration,
      )
    ) {
      return false;
    }
    const catalog = await conversationRepository.getCatalogEntry({
      system: params.storageSystem,
      kind: params.kind,
      conversationKey,
    });
    if (!(await detachRuntimeProviderSession(conversationKey, catalog))) {
      return false;
    }
    if (params.storageSystem === "codex") {
      clearCodexNativeReadLedgerForConversation({
        conversationKey,
        instanceID: catalog?.instanceID,
      });
    }
    return isConversationWriteGenerationCurrent(
      conversationKey,
      conversationGeneration,
    );
  });
}

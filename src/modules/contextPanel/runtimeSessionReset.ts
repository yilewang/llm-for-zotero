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
  listPendingSessionCleanupJobs,
  performConversationCleanupJobAttempt,
  type ConversationCleanupJob,
} from "../../core/conversations/conversationCleanupJobs";
import {
  assertNeverConversationSystem,
  type ConversationSystem,
} from "../../core/conversations/conversationSystems";
import { forgetArchivedCodexThread } from "../../codexAppServer/store";
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

/**
 * Runs one session cleanup job now: the Codex thread archive or the Claude
 * Code session invalidation, then forgets the session on the chat. False
 * when the provider could not be reached; the job stays for the next try.
 */
async function attemptSessionCleanup(
  job: ConversationCleanupJob,
): Promise<boolean> {
  const { conversationKey, instanceID, providerSessionId } = job;
  if (job.operation === "codex_archive") {
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
    await forgetArchivedCodexThread({
      conversationKey,
      threadId: providerSessionId,
      instanceID,
    });
    return true;
  }
  const attempt = await performConversationCleanupJobAttempt(
    job,
    async () =>
      invalidateClaudeConversationSessionWithinWriteLock(
        await initAgentSubsystem(),
        {
          conversationKey,
          scope: job.providerScope,
          metadata: {
            ...(providerSessionId ? { providerSessionId } : {}),
            instanceID,
          },
        },
      ),
    USER_ATTEMPT,
  );
  return attempt.ok;
}

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
        purpose: "resend_reset",
      });
      return job ? attemptSessionCleanup(job) : false;
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
        purpose: "resend_reset",
      });
      return job ? attemptSessionCleanup(job) : false;
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

/** Shown when a send waits for a reset the runtime still cannot take. */
export const PENDING_RESET_REFUSAL =
  "Could not reset this chat's earlier session: the runtime did not answer. Try again when it is available.";

/**
 * Finishes a reset a Retry or Edit started on this conversation but could
 * not complete (the provider was unreachable), before its next turn starts.
 * Until then the runtime still holds the session with the replaced turns,
 * and the chat still names it, so the turn would resume it. Only a reset of
 * the session the chat names is this turn's: others (an old thread a
 * replacement superseded) are the background worker's. Runs under the
 * conversation's write lock, as a reset does. True when the turn may start;
 * false when the runtime still cannot be reached.
 */
export async function finishPendingRuntimeSessionResets(params: {
  conversationKey: number;
  storageSystem: ConversationSystem;
}): Promise<boolean> {
  const { conversationKey, storageSystem } = params;
  const operation =
    storageSystem === "codex"
      ? "codex_archive"
      : storageSystem === "claude_code"
        ? "claude_invalidate"
        : null;
  if (!operation) return true;
  return withConversationWriteLock(conversationKey, async () => {
    const catalog = await conversationRepository.getCatalogEntry({
      system: storageSystem,
      conversationKey,
    });
    const sessionId = String(catalog?.providerSessionId || "").trim();
    if (!sessionId) return true;
    const jobs = await listPendingSessionCleanupJobs({
      conversationKey,
      operation,
    });
    for (const job of jobs) {
      if (job.providerSessionId !== sessionId) continue;
      if (!(await attemptSessionCleanup(job))) return false;
    }
    return true;
  });
}

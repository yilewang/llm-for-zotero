import {
  configurePendingDeletionFinalizers,
  setPendingDeletionStoreLogger,
} from "../../core/conversations/pendingDeletionStore";
import {
  finalizeQueuedConversationDeletion,
  finalizeQueuedTurnDeletion,
  isProviderNotFoundError,
  processPendingConversationCleanupJobs,
} from "./conversationDeletion";
import {
  completeConversationCleanupJob,
  enqueueConversationCleanupJob,
  failConversationCleanupJob,
} from "../../core/conversations/conversationCleanupJobs";
import { initAgentSubsystem } from "../../agent";
import {
  ATTACHMENT_GC_MIN_AGE_MS,
  collectAndDeleteUnreferencedBlobs,
} from "../../utils/attachmentRefStore";
import { initRecentlyDeletedConversationTombstones } from "../../core/conversations/recentlyDeletedConversations";
import { clearCodexConversationSessionMetadata } from "../../codexAppServer/store";
import { archiveCodexAppServerThread } from "../../codexAppServer/nativeClient";
import {
  buildClaudeScope,
  invalidateClaudeConversationSessionWithinWriteLock,
} from "../../claudeCode/runtime";
import { clearConversationOwnedRuntimeState } from "./state";
import { sweepOrphanedAgentTraceExports } from "../../agent/store/traceStore";

let configured = false;
let forcedTurnFinalizeFailures = 0;
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

// Test-only: make the next N queued-turn finalize attempts fail so workflow
// tests can drive the failed-finalize path through the real runtime.
export function forcePendingTurnFinalizeFailuresForTests(count: number): void {
  forcedTurnFinalizeFailures = Math.max(0, Math.floor(count));
}

// ztoolkit is an ambient plugin global; outside the plugin runtime (unit
// tests) it does not exist, so logging stays best-effort.
function safeLog(message: string, ...args: unknown[]): void {
  try {
    ztoolkit.log(message, ...args);
  } catch {
    /* logging is best-effort outside plugin runtime */
  }
}

export function configurePendingDeletionSubsystem(): void {
  if (configured) return;
  configured = true;
  void initRecentlyDeletedConversationTombstones().catch((err) =>
    safeLog("LLM: durable deletion tombstone load failed", err),
  );
  // The store's default logger is a no-op, so in production every queue
  // failure, retry and give-up was silent while the UI told the user to
  // "Check logs". Only the logger is replaced — the store keeps its default
  // main-window-bound timers.
  setPendingDeletionStoreLogger(safeLog);
  const scheduleAttachmentGc = () => {
    void collectAndDeleteUnreferencedBlobs(ATTACHMENT_GC_MIN_AGE_MS).catch(
      (err) => safeLog("LLM: attachment GC after queued deletion failed", err),
    );
  };
  configurePendingDeletionFinalizers({
    finalizeConversation: (entry) =>
      finalizeQueuedConversationDeletion(entry, {
        log: safeLog,
        getCoreAgentRuntime: initAgentSubsystem,
        scheduleAttachmentGc,
        clearConversationOwnedRuntimeState,
      }),
    finalizeTurn: async (entry) => {
      if (forcedTurnFinalizeFailures > 0) {
        forcedTurnFinalizeFailures -= 1;
        safeLog("LLM: workflow-test forced turn finalize failure", entry.id);
        return false;
      }
      return finalizeQueuedTurnDeletion(entry, {
        log: safeLog,
        scheduleAttachmentGc,
        detachProviderSession: async (turn) => {
          if (turn.system === "codex") {
            const providerSessionId = String(
              turn.providerSessionId || "",
            ).trim();
            if (providerSessionId) {
              const job = await enqueueConversationCleanupJob({
                operation: "codex_archive",
                system: "codex",
                conversationKey: turn.conversationKey,
                instanceID: turn.instanceID,
                conversationKind: turn.conversationKind,
                libraryID: turn.libraryID,
                paperItemID: turn.paperItemID,
                providerSessionId,
              });
              if (!job) {
                throw new Error(
                  "Codex turn deletion could not persist its provider cleanup obligation",
                );
              }
              try {
                await archiveCodexAppServerThread({
                  threadId: providerSessionId,
                });
              } catch (error) {
                if (!isProviderNotFoundError(error)) {
                  await failConversationCleanupJob(job, error);
                  throw error;
                }
              }
              await completeConversationCleanupJob(job.id);
            }
            await clearCodexConversationSessionMetadata(
              turn.conversationKey,
              providerSessionId || undefined,
              turn.instanceID,
            );
            return;
          }
          if (turn.system === "claude_code") {
            const providerSessionId = String(
              turn.providerSessionId || "",
            ).trim();
            const scope =
              turn.libraryID && turn.conversationKind
                ? buildClaudeScope({
                    libraryID: turn.libraryID,
                    kind: turn.conversationKind,
                    paperItemID: turn.paperItemID,
                  })
                : undefined;
            // A turn can be selected before captureClaudeSessionInfo has
            // written provider_session_id.  Scope + immutable instance is
            // still an exact provider witness; persist the invalidation job
            // before attempting the bridge so an outage is retryable.
            const job =
              scope && turn.instanceID
                ? await enqueueConversationCleanupJob({
                    operation: "claude_invalidate",
                    system: "claude_code",
                    conversationKey: turn.conversationKey,
                    instanceID: turn.instanceID,
                    conversationKind: turn.conversationKind,
                    libraryID: turn.libraryID,
                    paperItemID: turn.paperItemID,
                    providerScope: scope,
                    providerSessionId,
                  })
                : null;
            if (scope && turn.instanceID && !job) {
              throw new Error(
                "Claude turn deletion could not persist its provider cleanup obligation",
              );
            }
            try {
              await invalidateClaudeConversationSessionWithinWriteLock(
                await initAgentSubsystem(),
                {
                  conversationKey: turn.conversationKey,
                  scope,
                  metadata: {
                    ...(providerSessionId ? { providerSessionId } : {}),
                    ...(turn.instanceID ? { instanceID: turn.instanceID } : {}),
                  },
                },
              );
            } catch (error) {
              if (job) await failConversationCleanupJob(job, error);
              throw error;
            }
            if (job) await completeConversationCleanupJob(job.id);
          }
        },
      });
    },
  });
  void processPendingConversationCleanupJobs({
    getCoreAgentRuntime: initAgentSubsystem,
    log: safeLog,
    includeAttentionRequired: true,
  }).catch((err) => safeLog("LLM: provider cleanup sweep failed", err));
  void sweepOrphanedAgentTraceExports().catch((err) =>
    safeLog("LLM: agent trace cleanup sweep failed", err),
  );
  const scheduleCleanupSweep = () => {
    cleanupTimer = setTimeout(() => {
      void collectAndDeleteUnreferencedBlobs(ATTACHMENT_GC_MIN_AGE_MS).catch(
        (err) => safeLog("LLM: attachment GC sweep failed", err),
      );
      void sweepOrphanedAgentTraceExports().catch((err) =>
        safeLog("LLM: agent trace cleanup sweep failed", err),
      );
      void processPendingConversationCleanupJobs({
        getCoreAgentRuntime: initAgentSubsystem,
        log: safeLog,
        includeAttentionRequired: true,
      })
        .catch((err) => safeLog("LLM: provider cleanup sweep failed", err))
        .finally(scheduleCleanupSweep);
    }, 5_000);
    const maybeUnref = cleanupTimer as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    maybeUnref.unref?.();
  };
  scheduleCleanupSweep();
}

export function resetPendingDeletionSubsystemForTests(): void {
  configured = false;
  if (cleanupTimer) clearTimeout(cleanupTimer);
  cleanupTimer = null;
}

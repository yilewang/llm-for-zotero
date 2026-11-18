import { appLogger } from "../../core/logging";
import {
  configurePendingDeletionFinalizers,
  pendingDeletionStore,
  setPendingDeletionStoreLogger,
  type PendingDeletionEvent,
} from "../../core/conversations/pendingDeletionStore";
import {
  finalizeQueuedConversationDeletion,
  finalizeQueuedTurnDeletion,
  isProviderNotFoundError,
  processPendingConversationCleanupJobs,
} from "./conversationDeletion";
import {
  enqueueConversationCleanupJob,
  getNextConversationCleanupJobDueAt,
  onConversationCleanupJobsChanged,
  performConversationCleanupJobAttempt,
} from "../../core/conversations/conversationCleanupJobs";
import { initAgentSubsystem } from "../../agent";
import {
  ATTACHMENT_GC_MIN_AGE_MS,
  collectAndDeleteUnreferencedBlobs,
} from "../../utils/attachmentRefStore";
import { initRecentlyDeletedConversationTombstones } from "../../core/conversations/recentlyDeletedConversations";
import { clearCodexConversationSessionMetadata } from "../../codexAppServer/store";
import { antigravityConversationStore } from "../../antigravity/store";
import { archiveCodexAppServerThread } from "../../codexAppServer/nativeClient";
import {
  buildClaudeScope,
  invalidateClaudeConversationSessionWithinWriteLock,
} from "../../claudeCode/runtime";
import { clearConversationOwnedRuntimeState } from "./state";
import { clearTaskProgress } from "./taskProgress/store";
import { sweepOrphanedAgentTraceExports } from "../../agent/store/traceStore";
import { onBackgroundCleanupNeeded } from "../../core/maintenance/backgroundCleanupSignals";

let configured = false;
let forcedTurnFinalizeFailures = 0;

const SLOW_MAINTENANCE_INTERVAL_MS = 30 * 60 * 1000;
const EVENT_MAINTENANCE_DELAY_MS = 5_000;
const PROVIDER_DISCOVERY_RETRY_MIN_MS = 5_000;
const PROVIDER_DISCOVERY_RETRY_MAX_MS = 5 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

type MaintenanceTimer = ReturnType<typeof setTimeout>;
type PendingDeletionMaintenanceEnv = {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => MaintenanceTimer;
  clearTimer: (timer: MaintenanceTimer) => void;
  getNextProviderCleanupAt: () => Promise<number | null>;
  processProviderCleanup: () => Promise<void>;
  collectAttachments: () => Promise<void>;
  sweepTraces: () => Promise<void>;
};

const defaultMaintenanceEnv: PendingDeletionMaintenanceEnv = {
  now: Date.now,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
  getNextProviderCleanupAt: () =>
    getNextConversationCleanupJobDueAt({ includeAttentionRequired: true }),
  processProviderCleanup: () =>
    processPendingConversationCleanupJobs({
      getCoreAgentRuntime: initAgentSubsystem,
      log: safeLog,
      includeAttentionRequired: true,
    }),
  collectAttachments: () =>
    collectAndDeleteUnreferencedBlobs(ATTACHMENT_GC_MIN_AGE_MS),
  sweepTraces: sweepOrphanedAgentTraceExports,
};

let maintenanceEnv = defaultMaintenanceEnv;
let lifecycleGeneration = 0;
let providerTimer: MaintenanceTimer | null = null;
let providerLoop: Promise<void> | null = null;
let providerWakePending = false;
let providerFailureDelayMs = PROVIDER_DISCOVERY_RETRY_MIN_MS;
let slowTimer: MaintenanceTimer | null = null;
let slowTimerDueAt: number | null = null;
let slowSweep: Promise<void> | null = null;
let slowRequestedDelayMs: number | null = null;
let unsubscribeProviderChanges: (() => void) | null = null;
let unsubscribeBackgroundCleanup: (() => void) | null = null;

// Test-only: make the next N queued-turn finalize attempts fail so workflow
// tests can drive the failed-finalize path through the real runtime.
export function forcePendingTurnFinalizeFailuresForTests(count: number): void {
  forcedTurnFinalizeFailures = Math.max(0, Math.floor(count));
}

// Cleanup retries use the diagnostic channel; failures in the scheduler and
// durable-store plumbing use safeWarn below so the default still exposes them.
function safeLog(message: string, ...args: unknown[]): void {
  try {
    appLogger.debug(message, ...args);
  } catch {
    /* logging is best-effort outside plugin runtime */
  }
}

function safeWarn(message: string, ...args: unknown[]): void {
  try {
    appLogger.warn(message, ...args);
  } catch {
    /* logging is best-effort outside plugin runtime */
  }
}

function unrefTimer(timer: MaintenanceTimer): void {
  const maybeUnref = timer as MaintenanceTimer & { unref?: () => void };
  maybeUnref.unref?.();
}

function isActive(generation: number): boolean {
  return configured && generation === lifecycleGeneration;
}

function clearProviderTimer(): void {
  if (providerTimer === null) return;
  maintenanceEnv.clearTimer(providerTimer);
  providerTimer = null;
}

function scheduleProviderTimer(delayMs: number, generation: number): void {
  if (!isActive(generation)) return;
  clearProviderTimer();
  providerTimer = maintenanceEnv.setTimer(
    () => {
      if (!isActive(generation)) return;
      providerTimer = null;
      requestProviderCleanupWake();
    },
    Math.min(MAX_TIMER_DELAY_MS, Math.max(0, Math.floor(delayMs))),
  );
  unrefTimer(providerTimer);
}

async function runProviderCleanupLoop(generation: number): Promise<void> {
  let processedDueWork = false;
  while (isActive(generation) && providerWakePending) {
    providerWakePending = false;
    let nextAttemptAt: number | null;
    try {
      nextAttemptAt = await maintenanceEnv.getNextProviderCleanupAt();
    } catch (error) {
      safeWarn("LLM: provider cleanup discovery failed", error);
      if (isActive(generation)) {
        scheduleProviderTimer(providerFailureDelayMs, generation);
        providerFailureDelayMs = Math.min(
          PROVIDER_DISCOVERY_RETRY_MAX_MS,
          providerFailureDelayMs * 2,
        );
      }
      return;
    }
    if (!isActive(generation)) return;
    providerFailureDelayMs = PROVIDER_DISCOVERY_RETRY_MIN_MS;
    if (providerWakePending) continue;
    if (nextAttemptAt === null) return;
    const delayMs = nextAttemptAt - maintenanceEnv.now();
    if (delayMs > 0) {
      scheduleProviderTimer(delayMs, generation);
      return;
    }
    if (processedDueWork) {
      // A valid due job should either be removed or receive a future retry
      // deadline. Bound an unexpected no-progress row instead of replacing the
      // old five-second poll with a tight asynchronous loop.
      scheduleProviderTimer(PROVIDER_DISCOVERY_RETRY_MIN_MS, generation);
      return;
    }
    try {
      await maintenanceEnv.processProviderCleanup();
    } catch (error) {
      safeWarn("LLM: provider cleanup sweep failed", error);
      if (isActive(generation)) {
        scheduleProviderTimer(providerFailureDelayMs, generation);
        providerFailureDelayMs = Math.min(
          PROVIDER_DISCOVERY_RETRY_MAX_MS,
          providerFailureDelayMs * 2,
        );
      }
      return;
    }
    processedDueWork = true;
    // Mutations normally signal while the sweep is running. Re-query even if
    // a boundary failed to signal so the durable queue remains authoritative.
    providerWakePending = true;
  }
}

function requestProviderCleanupWake(): void {
  if (!configured) return;
  providerWakePending = true;
  clearProviderTimer();
  if (providerLoop) return;
  const generation = lifecycleGeneration;
  const task = runProviderCleanupLoop(generation).finally(() => {
    if (providerLoop === task) {
      providerLoop = null;
    }
    if (configured && providerWakePending) {
      requestProviderCleanupWake();
    }
  });
  providerLoop = task;
}

function clearSlowTimer(): void {
  if (slowTimer !== null) maintenanceEnv.clearTimer(slowTimer);
  slowTimer = null;
  slowTimerDueAt = null;
}

async function runSlowMaintenanceSweep(generation: number): Promise<void> {
  try {
    await maintenanceEnv.collectAttachments();
  } catch (error) {
    safeWarn("LLM: attachment GC sweep failed", error);
  }
  if (!isActive(generation)) return;
  try {
    await maintenanceEnv.sweepTraces();
  } catch (error) {
    safeWarn("LLM: agent trace cleanup sweep failed", error);
  }
}

function startSlowMaintenanceSweep(generation: number): void {
  if (!isActive(generation)) return;
  if (slowSweep) {
    slowRequestedDelayMs = 0;
    return;
  }
  const task = runSlowMaintenanceSweep(generation).finally(() => {
    if (slowSweep === task) {
      slowSweep = null;
    }
    if (!configured) return;
    const nextDelay = slowRequestedDelayMs;
    slowRequestedDelayMs = null;
    if (nextDelay !== null) {
      scheduleSlowMaintenance(nextDelay);
    } else if (isActive(generation)) {
      scheduleSlowMaintenance(SLOW_MAINTENANCE_INTERVAL_MS);
    }
  });
  slowSweep = task;
}

function scheduleSlowMaintenance(delayMs = EVENT_MAINTENANCE_DELAY_MS): void {
  if (!configured) return;
  const normalizedDelay = Math.max(0, Math.floor(delayMs));
  if (slowSweep) {
    slowRequestedDelayMs =
      slowRequestedDelayMs === null
        ? normalizedDelay
        : Math.min(slowRequestedDelayMs, normalizedDelay);
    return;
  }
  const dueAt = maintenanceEnv.now() + normalizedDelay;
  if (slowTimer !== null && slowTimerDueAt !== null && slowTimerDueAt <= dueAt)
    return;
  clearSlowTimer();
  const generation = lifecycleGeneration;
  slowTimerDueAt = dueAt;
  slowTimer = maintenanceEnv.setTimer(
    () => {
      if (!isActive(generation)) return;
      slowTimer = null;
      slowTimerDueAt = null;
      startSlowMaintenanceSweep(generation);
    },
    Math.min(MAX_TIMER_DELAY_MS, normalizedDelay),
  );
  unrefTimer(slowTimer);
}

export function configurePendingDeletionMaintenanceEnvForTests(
  overrides: Partial<PendingDeletionMaintenanceEnv>,
): void {
  maintenanceEnv = { ...defaultMaintenanceEnv, ...overrides };
}

export async function flushPendingDeletionMaintenanceForTests(): Promise<void> {
  await providerLoop;
  await slowSweep;
}

/**
 * A queued deletion (conversation or turn) hides the conversation now, so
 * its Task progress record goes now too; Undo rebuilds it from history.
 * A dropped intent leaves the conversation alive and its record alone.
 */
export function clearTaskProgressOnPendingDeletion(
  event: PendingDeletionEvent,
): void {
  if (event.dropped) return;
  if (
    event.type !== "queued" &&
    event.type !== "committing" &&
    event.type !== "local-deleted" &&
    event.type !== "quarantined"
  ) {
    return;
  }
  clearTaskProgress(event.entry.conversationKey);
}

export function configurePendingDeletionSubsystem(): void {
  if (configured) return;
  configured = true;
  pendingDeletionStore.subscribe(clearTaskProgressOnPendingDeletion);
  void initRecentlyDeletedConversationTombstones().catch((err) =>
    safeWarn("LLM: durable deletion tombstone load failed", err),
  );
  // The store's default logger is a no-op, so in production every queue
  // failure, retry and give-up was silent while the UI told the user to
  // "Check logs". Only the logger is replaced — the store keeps its default
  // main-window-bound timers.
  setPendingDeletionStoreLogger(safeLog, safeWarn);
  const scheduleAttachmentGc = () => scheduleSlowMaintenance();
  configurePendingDeletionFinalizers({
    finalizeConversation: (entry) =>
      finalizeQueuedConversationDeletion(entry, {
        log: safeLog,
        warn: safeWarn,
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
        warn: safeWarn,
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
              const attempt = await performConversationCleanupJobAttempt(
                job,
                async () => {
                  try {
                    await archiveCodexAppServerThread({
                      threadId: providerSessionId,
                    });
                  } catch (error) {
                    if (!isProviderNotFoundError(error)) throw error;
                  }
                },
              );
              if (!attempt.ok) {
                throw attempt.error;
              }
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
            if (job) {
              const attempt = await performConversationCleanupJobAttempt(
                job,
                async () => {
                  await invalidateClaudeConversationSessionWithinWriteLock(
                    await initAgentSubsystem(),
                    {
                      conversationKey: turn.conversationKey,
                      scope,
                      metadata: {
                        ...(providerSessionId ? { providerSessionId } : {}),
                        ...(turn.instanceID
                          ? { instanceID: turn.instanceID }
                          : {}),
                      },
                    },
                  );
                },
              );
              if (!attempt.ok) throw attempt.error;
            } else {
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
            }
            return;
          }
          if (turn.system === "antigravity") {
            // ACP cannot delete a session or its turns, so there is no
            // provider job.  Detach the catalog from the session instead, so
            // the next turn starts a fresh ACP session that never saw the
            // deleted turn.
            const providerSessionId = String(
              turn.providerSessionId || "",
            ).trim();
            await antigravityConversationStore.clearConversationSessionMetadata(
              turn.conversationKey,
              providerSessionId || undefined,
              turn.instanceID,
            );
            return;
          }
          // The built-in runtime has no provider session to detach.  The
          // check is compile-time only: queued rows are read back from disk
          // unvalidated, and an unknown system must stay a silent no-op.
          if (turn.system === "upstream") return;
          turn.system satisfies never;
        },
      });
    },
  });
  unsubscribeProviderChanges = onConversationCleanupJobsChanged(
    requestProviderCleanupWake,
  );
  unsubscribeBackgroundCleanup = onBackgroundCleanupNeeded(() =>
    scheduleSlowMaintenance(),
  );
  requestProviderCleanupWake();
  // Startup attachment reconciliation and agent trace initialization each run
  // once in their owning subsystem. This timer is the crash/age-eligibility
  // backstop after that initial pass.
  scheduleSlowMaintenance(SLOW_MAINTENANCE_INTERVAL_MS);
}

export function disposePendingDeletionSubsystem(): void {
  if (!configured) return;
  configured = false;
  lifecycleGeneration += 1;
  providerWakePending = false;
  slowRequestedDelayMs = null;
  clearProviderTimer();
  clearSlowTimer();
  unsubscribeProviderChanges?.();
  unsubscribeProviderChanges = null;
  unsubscribeBackgroundCleanup?.();
  unsubscribeBackgroundCleanup = null;
}

export function resetPendingDeletionSubsystemForTests(): void {
  disposePendingDeletionSubsystem();
  forcedTurnFinalizeFailures = 0;
  providerFailureDelayMs = PROVIDER_DISCOVERY_RETRY_MIN_MS;
  maintenanceEnv = defaultMaintenanceEnv;
}

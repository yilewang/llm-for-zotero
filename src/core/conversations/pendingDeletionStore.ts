import type { ConversationSystem } from "../../shared/types";
import {
  conversationInstanceIdentityDigest,
  isConversationRecentlyDeleted,
} from "./recentlyDeletedConversations";
import {
  bumpConversationWriteGeneration,
  freezeConversationWrites,
  resetConversationWriteFenceForTests,
  unfreezeConversationWrites,
} from "../../shared/conversationWriteFence";

export const PENDING_DELETIONS_TABLE = "llm_for_zotero_pending_deletions";
export const DELETION_UNDO_WINDOW_MS = 6_000;
// Kept as a compatibility export for callers that imported the old retry cap.
// A failed deletion is never allowed to restore visibility: retries are now
// durable and indefinite, with the backoff below providing the only pacing.
export const MAX_FINALIZE_ATTEMPTS = Number.POSITIVE_INFINITY;
export const FINALIZE_RETRY_DELAY_MS = 6_000;
const FINALIZE_RETRY_MAX_DELAY_MS = 15 * 60 * 1_000;
// Keys belonging to a durable manifest that could not be decoded are kept
// hidden until an explicit identity-repair pass can reconstruct the intent.
// Quarantine is deliberately conservative: exposing the conversation would
// allow the user's delete decision to be silently lost.
const quarantinedConversationKeys = new Set<number>();
// Whether the durable intents have been reloaded into the process-local
// freeze set. Until they have, the fence is incomplete and conversation
// writes must not proceed.
let persistedFenceLoaded = false;

export type DeletionState =
  | "undoable"
  | "committing"
  | "retrying_local"
  | "quarantined_identity"
  | "cleanup_pending"
  | "complete";

export type ProviderCleanupState =
  | "not_required"
  | "pending"
  | "attention_required"
  | "complete";

export type PendingConversationDeletionEntry = {
  id: string;
  kind: "conversation";
  conversationKind: "paper" | "global";
  /** Immutable identity captured from the registry before the row is hidden. */
  instanceID?: string;
  conversationID?: string;
  // Immutable identity witness captured at queue time: the catalog row's
  // createdAt. The permanent key ledger and instance ID are authoritative;
  // createdAt remains a migration witness for rows written by older builds.
  // 0 means "no witness" and must fail closed.
  catalogCreatedAt: number;
  conversationKey: number;
  libraryID: number;
  system: ConversationSystem;
  paperItemID?: number;
  providerSessionId?: string;
  title: string;
  wasActive: boolean;
  queuedAt: number;
  expiresAt: number;
  attempts: number;
  state?: DeletionState;
  providerCleanupState?: ProviderCleanupState;
  identityDigest?: string;
  nextRetryAt?: number;
  lastErrorCode?: string;
};

export type PendingTurnDeletionEntry = {
  id: string;
  kind: "turn";
  conversationKey: number;
  system: ConversationSystem;
  instanceID?: string;
  conversationKind?: "global" | "paper";
  libraryID?: number;
  paperItemID?: number;
  userTimestamp: number;
  assistantTimestamp: number;
  /** Immutable database row IDs; timestamps remain legacy display metadata. */
  userMessageID?: number;
  assistantMessageID?: number;
  /** Exact native provider session captured before the turn is removed. */
  providerSessionId?: string;
  queuedAt: number;
  expiresAt: number;
  attempts: number;
  /** Durable destructive boundary for turn finalization across restart. */
  state?: DeletionState;
  providerCleanupState?: ProviderCleanupState;
};

export type PendingDeletionEntry =
  | PendingConversationDeletionEntry
  | PendingTurnDeletionEntry;

export type PendingDeletionEvent = {
  type:
    | "queued"
    | "undone"
    | "committing"
    | "quarantined"
    | "local-deleted"
    | "cleanup-pending"
    | "completed"
    | "finalized"
    | "finalize-failed";
  entry: PendingDeletionEntry;
  // True when the intent was DROPPED rather than applied — the conversation
  // still exists (a stale intent, or a row from a build with no identity
  // witness). Surfaces must not treat this as a deletion: leaving the chat and
  // tombstoning its key would evict the user from a conversation that is very
  // much alive.
  dropped?: boolean;
};

export type PendingFinalizeOutcome = {
  ok: boolean;
  dropped?: boolean;
  quarantined?: boolean;
  cleanupPending?: boolean;
  /** Local rows were committed, so Undo must not claim restoration. */
  localDeleted?: boolean;
};

export type PendingDeletionFinalizers = {
  finalizeConversation: (
    entry: PendingConversationDeletionEntry,
  ) => Promise<boolean | PendingFinalizeOutcome>;
  finalizeTurn: (
    entry: PendingTurnDeletionEntry,
  ) => Promise<boolean | PendingFinalizeOutcome>;
};

export type PendingDeletionStoreEnv = {
  now?: () => number;
  setTimer?: (fn: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (message: string, ...args: unknown[]) => void;
};

type ZoteroDbLike = {
  queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
};

function isAlreadyExistingColumnError(error: unknown): boolean {
  return /duplicate column|already exists/i.test(
    String(error instanceof Error ? error.message : error || ""),
  );
}

function getZoteroDb(): ZoteroDbLike | null {
  const db = (globalThis as { Zotero?: { DB?: ZoteroDbLike } }).Zotero?.DB;
  return db?.queryAsync ? db : null;
}

function getMainWindow(): Window | null {
  return (
    (
      globalThis as {
        Zotero?: { getMainWindow?: () => Window | null };
      }
    ).Zotero?.getMainWindow?.() || null
  );
}

// The default timer binds its clearing host at ARM time. Resolving the host
// again at clear time could target a different window (main window closed and
// reopened mid-window) and cancel an unrelated timer there while leaking ours.
type BoundTimerHandle = { cancel: () => void };

function isBoundTimerHandle(handle: unknown): handle is BoundTimerHandle {
  return (
    typeof handle === "object" &&
    handle !== null &&
    typeof (handle as BoundTimerHandle).cancel === "function"
  );
}

function defaultSetTimer(fn: () => void, delayMs: number): unknown {
  const win = getMainWindow();
  if (win?.setTimeout) {
    const id = win.setTimeout(fn, delayMs);
    return {
      cancel: () => {
        try {
          win.clearTimeout(id);
        } catch {
          /* window already gone — its timers died with it */
        }
      },
    } satisfies BoundTimerHandle;
  }
  const id = setTimeout(fn, delayMs);
  return { cancel: () => clearTimeout(id) } satisfies BoundTimerHandle;
}

function defaultClearTimer(handle: unknown): void {
  if (handle === null || handle === undefined) return;
  if (isBoundTimerHandle(handle)) {
    handle.cancel();
    return;
  }
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function defaultEnv(): Required<PendingDeletionStoreEnv> {
  return {
    now: () => Date.now(),
    setTimer: defaultSetTimer,
    clearTimer: defaultClearTimer,
    log: () => {},
  };
}

let finalizers: PendingDeletionFinalizers | null = null;
let env: Required<PendingDeletionStoreEnv> = defaultEnv();

const entries = new Map<string, PendingDeletionEntry>();
const timers = new Map<string, unknown>();
// When each entry's own timer is next due. Session-local and deliberately NOT
// persisted: a restart is meant to re-attempt every leftover row at once.
const retryNotBefore = new Map<string, number>();
const listeners = new Set<(event: PendingDeletionEvent) => void>();
let queueOrder: string[] = [];
let initialized = false;
let opChain: Promise<unknown> = Promise.resolve();
type RestoreRequest = { committed: boolean };

// The coordinator owns one serial lane per immutable conversation instance.
// Provider cleanup/finalization for chat A must never hold chat B's queue,
// send, Undo, or turn-deletion operation hostage.
const conversationOpChains = new Map<number, Promise<unknown>>();
const scheduledFinalizations = new Map<string, Promise<boolean>>();

// Restores are user actions that must not wait behind an unrelated provider
// finalizer. They have their own per-conversation lane, while the global chain
// continues to serialize operations that intentionally span conversations.
const restoreOpChains = new Map<number, Promise<unknown>>();
const pendingRestoreRequests = new Map<number, Set<RestoreRequest>>();
const activeFinalizationIds = new Set<string>();
const destructivelyFinalizedIds = new Set<string>();
let idCounter = 0;
// Queue intents that have been REQUESTED but are not yet visible in `entries`,
// counted per conversation key. The short-circuits below read `entries`
// synchronously; without this a restore/finalize could answer "nothing to do"
// while a queue op for that key was still pending, and the caller would write
// into a chat that is about to be hidden. Keyed (not global) so an unrelated
// conversation's queue op cannot force every send onto the shared chain, and
// released only once the intent is recorded — or has definitively failed.
const unrecordedQueueIntents = new Map<number, number>();
const unrecordedConversationQueueIntents = new Map<number, number>();

function retainQueueIntent(
  conversationKey: number,
  kind: PendingDeletionEntry["kind"],
): void {
  unrecordedQueueIntents.set(
    conversationKey,
    (unrecordedQueueIntents.get(conversationKey) || 0) + 1,
  );
  if (kind === "conversation") {
    unrecordedConversationQueueIntents.set(
      conversationKey,
      (unrecordedConversationQueueIntents.get(conversationKey) || 0) + 1,
    );
  }
}

function releaseQueueIntent(
  conversationKey: number,
  kind: PendingDeletionEntry["kind"],
): void {
  const next = (unrecordedQueueIntents.get(conversationKey) || 0) - 1;
  if (next > 0) unrecordedQueueIntents.set(conversationKey, next);
  else unrecordedQueueIntents.delete(conversationKey);
  if (kind === "conversation") {
    const conversationNext =
      (unrecordedConversationQueueIntents.get(conversationKey) || 0) - 1;
    if (conversationNext > 0) {
      unrecordedConversationQueueIntents.set(conversationKey, conversationNext);
    } else {
      unrecordedConversationQueueIntents.delete(conversationKey);
    }
  }
}

function hasUnrecordedQueueIntent(conversationKey: number): boolean {
  return (unrecordedQueueIntents.get(conversationKey) || 0) > 0;
}

function hasUnrecordedConversationQueueIntent(
  conversationKey: number,
): boolean {
  return (unrecordedConversationQueueIntents.get(conversationKey) || 0) > 0;
}

function hasConversationEntriesForConversation(
  conversationKey: number,
): boolean {
  for (const entry of entries.values()) {
    if (
      entry.kind === "conversation" &&
      entry.conversationKey === conversationKey
    ) {
      return true;
    }
  }
  return false;
}

function registerRestoreRequest(conversationKey: number): RestoreRequest {
  const request: RestoreRequest = { committed: false };
  const requests = pendingRestoreRequests.get(conversationKey) || new Set();
  requests.add(request);
  pendingRestoreRequests.set(conversationKey, requests);
  return request;
}

function unregisterRestoreRequest(
  conversationKey: number,
  request: RestoreRequest,
): void {
  const requests = pendingRestoreRequests.get(conversationKey);
  if (!requests) return;
  requests.delete(request);
  if (requests.size === 0) pendingRestoreRequests.delete(conversationKey);
}

function hasPendingRestoreRequest(conversationKey: number): boolean {
  return (pendingRestoreRequests.get(conversationKey)?.size || 0) > 0;
}

function markRestoreRequestsCommitted(conversationKey: number): void {
  for (const request of pendingRestoreRequests.get(conversationKey) || []) {
    request.committed = true;
  }
}

function enqueueRestoreOp<T>(
  conversationKey: number,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = restoreOpChains.get(conversationKey) || Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.catch(() => undefined);
  restoreOpChains.set(conversationKey, settled);
  void settled.then(() => {
    if (restoreOpChains.get(conversationKey) === settled) {
      restoreOpChains.delete(conversationKey);
    }
  });
  return run;
}

export function configurePendingDeletionFinalizers(
  next: PendingDeletionFinalizers,
): void {
  finalizers = next;
}

export function configurePendingDeletionStoreEnv(
  next: PendingDeletionStoreEnv,
): void {
  const defaults = defaultEnv();
  env = {
    now: next.now || defaults.now,
    setTimer: next.setTimer || defaults.setTimer,
    clearTimer: next.clearTimer || defaults.clearTimer,
    log: next.log || defaults.log,
  };
}

// Production wires only the logger: the plugin runtime must keep the default
// main-window-bound timers while still leaving a diagnostic trail. Without this
// the store's log is a no-op in the shipping plugin, and every toast that says
// "Check logs" points at nothing.
export function setPendingDeletionStoreLogger(
  log: (message: string, ...args: unknown[]) => void,
): void {
  env.log = log;
}

export function resetPendingDeletionStoreForTests(): void {
  for (const handle of timers.values()) env.clearTimer(handle);
  timers.clear();
  retryNotBefore.clear();
  entries.clear();
  listeners.clear();
  queueOrder = [];
  initialized = false;
  finalizers = null;
  opChain = Promise.resolve();
  conversationOpChains.clear();
  scheduledFinalizations.clear();
  restoreOpChains.clear();
  pendingRestoreRequests.clear();
  activeFinalizationIds.clear();
  destructivelyFinalizedIds.clear();
  quarantinedConversationKeys.clear();
  persistedFenceLoaded = false;
  unrecordedQueueIntents.clear();
  unrecordedConversationQueueIntents.clear();
  resetConversationWriteFenceForTests();
  env = defaultEnv();
}

function enqueueOp<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.catch(() => undefined);
  return run;
}

function enqueueConversationOp<T>(
  conversationKey: number,
  fn: () => Promise<T>,
): Promise<T> {
  const previous =
    conversationOpChains.get(conversationKey) || Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.catch(() => undefined);
  conversationOpChains.set(conversationKey, settled);
  void settled.then(() => {
    if (conversationOpChains.get(conversationKey) === settled) {
      conversationOpChains.delete(conversationKey);
    }
  });
  return run;
}

function notify(event: PendingDeletionEvent): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(event);
    } catch (err) {
      env.log("LLM: pending deletion listener failed", err);
    }
  }
}

function generateId(): string {
  idCounter += 1;
  return `pd-${env.now().toString(36)}-${idCounter.toString(36)}`;
}

function identityDigest(
  entry: Pick<
    PendingConversationDeletionEntry,
    "instanceID" | "conversationKey" | "conversationID"
  >,
): string {
  if (!entry.instanceID) return "id-legacy";
  // Keep the manifest synchronous and content-free. The immutable random
  // instance ID is the authoritative identity; the digest is only a compact
  // durable lookup key (and avoids the old numeric-key tombstone).
  return conversationInstanceIdentityDigest({
    conversationKey: entry.conversationKey,
    instanceID: entry.instanceID,
    conversationID: entry.conversationID,
  });
}

function clearEntryTimer(id: string): void {
  const handle = timers.get(id);
  if (handle !== undefined) {
    env.clearTimer(handle);
    timers.delete(id);
  }
  retryNotBefore.delete(id);
}

function armTimer(id: string, delayMs: number): void {
  clearEntryTimer(id);
  const delay = Math.max(0, delayMs);
  retryNotBefore.set(id, env.now() + delay);
  timers.set(
    id,
    env.setTimer(() => {
      timers.delete(id);
      void pendingDeletionStore.finalize(id, "timeout");
    }, delay),
  );
}

/**
 * Local deletion failures are durable obligations, so retry pacing must not
 * turn repeated database faults into a tight loop. The first retry retains
 * the historical six-second delay for compatibility; later retries double
 * until the fifteen-minute ceiling. Unlike provider cleanup, the local lane
 * intentionally has no jitter: tests and restart sweeps can deterministically
 * wake an outstanding deletion at its recorded deadline.
 */
function getFinalizeRetryDelayMs(attempts: number): number {
  const normalizedAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
  return Math.min(
    FINALIZE_RETRY_MAX_DELAY_MS,
    FINALIZE_RETRY_DELAY_MS * 2 ** Math.min(normalizedAttempts - 1, 8),
  );
}

function removeEntry(id: string): void {
  clearEntryTimer(id);
  entries.delete(id);
  destructivelyFinalizedIds.delete(id);
  queueOrder = queueOrder.filter((entryId) => entryId !== id);
}

// A failed finalize schedules its own retry; incidental sweeps must respect
// that schedule instead of racing it. Panels sweep on every mount and panels
// remount whenever the user browses items, so without this guard ordinary
// browsing burned the whole MAX_FINALIZE_ATTEMPTS budget in seconds instead of
// over the intended retry window. Entries with no schedule (rows loaded by the
// startup sweep) are never held back.
function isInRetryBackoff(id: string, now: number): boolean {
  const notBefore = retryNotBefore.get(id);
  return notBefore !== undefined && notBefore > now;
}

function serializePayload(entry: PendingDeletionEntry): string {
  if (entry.kind === "conversation") {
    return JSON.stringify({
      conversationKind: entry.conversationKind,
      instanceID: entry.instanceID,
      identityDigest: entry.identityDigest || identityDigest(entry),
      catalogCreatedAt: entry.catalogCreatedAt,
      libraryID: entry.libraryID,
      paperItemID: entry.paperItemID,
      providerSessionId: entry.providerSessionId,
      title: entry.title,
      wasActive: entry.wasActive,
      state: entry.state || "undoable",
      providerCleanupState: entry.providerCleanupState || "not_required",
      nextRetryAt: entry.nextRetryAt,
      lastErrorCode: entry.lastErrorCode,
    });
  }
  return JSON.stringify({
    instanceID: entry.instanceID,
    conversationKind: entry.conversationKind,
    libraryID: entry.libraryID,
    paperItemID: entry.paperItemID,
    userTimestamp: entry.userTimestamp,
    assistantTimestamp: entry.assistantTimestamp,
    userMessageID: entry.userMessageID,
    assistantMessageID: entry.assistantMessageID,
    providerSessionId: entry.providerSessionId,
    state: entry.state || "undoable",
    providerCleanupState: entry.providerCleanupState || "not_required",
  });
}

/**
 * Once local rows have committed, a retrying write-ahead row is no longer a
 * user-facing conversation record.  Keep only the immutable identity and
 * provider-operation fields needed to withdraw the intent safely; titles,
 * library/paper metadata, and active-surface hints must not survive in the
 * durable deletion manifest.
 */
function scrubCommittedConversationManifest(
  entry: PendingConversationDeletionEntry,
): void {
  entry.title = "";
  entry.libraryID = 0;
  entry.paperItemID = undefined;
  entry.wasActive = false;
}

async function insertRow(entry: PendingDeletionEntry): Promise<void> {
  const db = getZoteroDb();
  if (!db) throw new Error("Zotero DB unavailable");
  await pendingDeletionStore.init();
  await db.queryAsync(
    `INSERT INTO ${PENDING_DELETIONS_TABLE}
      (id, kind, conversation_id, conversation_key, system, payload, queued_at, expires_at, attempts, state, provider_cleanup_state, identity_digest, next_retry_at, last_error_code, manifest_version, user_message_id, assistant_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id,
      entry.kind,
      entry.kind === "conversation" ? entry.conversationID || null : null,
      entry.conversationKey,
      entry.system,
      serializePayload(entry),
      entry.queuedAt,
      entry.expiresAt,
      entry.attempts,
      entry.state || "undoable",
      entry.providerCleanupState || "not_required",
      entry.kind === "conversation"
        ? entry.identityDigest || identityDigest(entry)
        : null,
      entry.kind === "conversation" ? entry.nextRetryAt || null : null,
      entry.kind === "conversation" ? entry.lastErrorCode || null : null,
      1,
      entry.kind === "turn" ? entry.userMessageID || null : null,
      entry.kind === "turn" ? entry.assistantMessageID || null : null,
    ],
  );
}

async function deleteRow(id: string): Promise<void> {
  const db = getZoteroDb();
  if (!db) return;
  try {
    await db.queryAsync(`DELETE FROM ${PENDING_DELETIONS_TABLE} WHERE id = ?`, [
      id,
    ]);
  } catch (err) {
    env.log("LLM: failed to delete pending-deletion row", { id, err });
  }
}

// Undo must never LOOK successful while the write-ahead row survives — the
// next startup sweep would finalize the row and destroy the "restored" chat.
async function deleteRowStrict(id: string): Promise<void> {
  const db = getZoteroDb();
  if (!db) throw new Error("Zotero DB unavailable");
  await db.queryAsync(`DELETE FROM ${PENDING_DELETIONS_TABLE} WHERE id = ?`, [
    id,
  ]);
}

async function persistAttempts(entry: PendingDeletionEntry): Promise<void> {
  const db = getZoteroDb();
  if (!db) return;
  try {
    await db.queryAsync(
      `UPDATE ${PENDING_DELETIONS_TABLE} SET attempts = ? WHERE id = ?`,
      [entry.attempts, entry.id],
    );
  } catch (err) {
    env.log("LLM: failed to persist pending-deletion attempts", {
      id: entry.id,
      err,
    });
  }
}

async function persistConversationState(
  entry: PendingDeletionEntry,
): Promise<boolean> {
  const db = getZoteroDb();
  if (!db) return false;
  try {
    await db.queryAsync(
      `UPDATE ${PENDING_DELETIONS_TABLE}
       SET state = ?, provider_cleanup_state = ?, identity_digest = ?,
           next_retry_at = ?, last_error_code = ?, payload = ?
       WHERE id = ?`,
      [
        entry.state || "undoable",
        entry.providerCleanupState || "not_required",
        entry.kind === "conversation"
          ? entry.identityDigest || identityDigest(entry)
          : null,
        entry.kind === "conversation" ? entry.nextRetryAt || null : null,
        entry.kind === "conversation" ? entry.lastErrorCode || null : null,
        serializePayload(entry),
        entry.id,
      ],
    );
    return true;
  } catch (err) {
    env.log("LLM: failed to persist pending conversation deletion state", {
      id: entry.id,
      err,
    });
    return false;
  }
}

// Kept as a single writer for both conversation and turn manifests.  Turn
// entries historically stored only attempts, but their local-delete boundary
// must survive a process restart just like a whole-conversation manifest.
const persistDeletionState = persistConversationState;

// Key-scoped ops answer from these synchronous reads when nothing matches, so
// they never join the single shared op chain — an unrelated conversation's slow
// finalize (a codex thread archive can hold the chain for up to its 60s request
// timeout) must not stall a send in a different chat.
function hasEntriesForConversation(conversationKey: number): boolean {
  for (const entry of entries.values()) {
    if (entry.conversationKey === conversationKey) return true;
  }
  return false;
}

function hasTurnEntriesForConversation(conversationKey: number): boolean {
  for (const entry of entries.values()) {
    if (entry.kind === "turn" && entry.conversationKey === conversationKey) {
      return true;
    }
  }
  return false;
}

// Supersede is deliberately KIND-SCOPED. A second conversation deletion commits
// the first (one conversation undo slot), and a second turn deletion commits the
// first, but a turn deletion must never commit a pending CONVERSATION deletion:
// they are independent user intents over disjoint data, and the conversation is
// still inside its undo window. Same rule as finalizeTurnsForConversation.
async function supersedeOthers(
  kind: PendingDeletionEntry["kind"],
  keepId: string | null,
): Promise<void> {
  const others = queueOrder.filter(
    (id) => id !== keepId && entries.get(id)?.kind === kind,
  );
  for (const id of others) {
    await finalizeInternal(id, "superseded");
  }
}

async function undoInternal(id: string): Promise<PendingDeletionEntry | null> {
  const entry = entries.get(id);
  if (!entry) return null;
  // The six-second window is a hard authorization boundary. A stale button,
  // duplicate surface, or late IPC callback cannot turn post-expiry activity
  // into an implicit Undo.
  if (
    env.now() >= entry.expiresAt ||
    (entry.state !== undefined && entry.state !== "undoable")
  ) {
    return null;
  }
  if (activeFinalizationIds.has(id) || destructivelyFinalizedIds.has(id)) {
    // Once destructive finalization has started, deleting the write-ahead row
    // would falsely restore visibility over data that may already be gone.
    return null;
  }
  try {
    await deleteRowStrict(id);
  } catch (err) {
    // The durable intent could not be withdrawn; leave the entry (and its
    // timer) in place so state stays consistent, and let the caller
    // surface the failure instead of claiming "restored".
    env.log("LLM: undo failed to withdraw pending-deletion row", {
      id,
      err,
    });
    return null;
  }
  removeEntry(id);
  if (entry.kind === "conversation" || entry.kind === "turn") {
    // Explicit Undo is the only operation allowed to reopen a queued delete.
    // Advance the generation so callbacks from before the deletion decision
    // cannot write into the restored instance or the surviving turn set.
    bumpConversationWriteGeneration(entry.conversationKey);
    if (
      !hasUnrecordedQueueIntent(entry.conversationKey) &&
      !hasEntriesForConversation(entry.conversationKey)
    ) {
      unfreezeConversationWrites(entry.conversationKey);
    }
  }
  notify({ type: "undone", entry });
  return entry;
}

/** Remove turn intents owned by a conversation after its whole-instance delete commits. */
async function purgePendingTurnEntriesForConversation(
  conversationKey: number,
): Promise<boolean> {
  const turnEntries = Array.from(entries.values()).filter(
    (entry): entry is PendingTurnDeletionEntry =>
      entry.kind === "turn" && entry.conversationKey === conversationKey,
  );
  for (const turnEntry of turnEntries) {
    try {
      await deleteRowStrict(turnEntry.id);
    } catch (error) {
      env.log(
        "LLM: failed to remove pending turn intent after conversation deletion",
        {
          conversationKey,
          id: turnEntry.id,
          error,
        },
      );
      return false;
    }
    removeEntry(turnEntry.id);
    notify({ type: "completed", entry: turnEntry });
    notify({ type: "finalized", entry: turnEntry });
  }
  return true;
}

async function finalizeInternal(id: string, reason: string): Promise<boolean> {
  const entry = entries.get(id);
  if (!entry) return true;
  if (
    entry.kind === "conversation" &&
    hasPendingRestoreRequest(entry.conversationKey)
  ) {
    // A user action has already asked to withdraw this conversation's delete
    // intent. Let the keyed restore lane win instead of starting destructive
    // work behind it.
    env.log("LLM: deferring conversation finalize for pending restore", {
      id,
      conversationKey: entry.conversationKey,
      reason,
    });
    armTimer(id, getFinalizeRetryDelayMs(entry.attempts + 1));
    return false;
  }
  activeFinalizationIds.add(id);
  try {
    return await finalizeInternalUnsafe(id, reason);
  } finally {
    activeFinalizationIds.delete(id);
  }
}

async function finalizeInternalUnsafe(
  id: string,
  reason: string,
): Promise<boolean> {
  const entry = entries.get(id);
  if (!entry) return true;
  clearEntryTimer(id);
  if (!finalizers) {
    env.log("LLM: pending deletion finalizers not configured", { id, reason });
    // Keep the retry heartbeat alive — without it the entry would sit hidden
    // forever with a dead undo window until the next sweep.
    armTimer(id, getFinalizeRetryDelayMs(entry.attempts + 1));
    return false;
  }
  if (entry.kind === "conversation") {
    entry.state = "committing";
    entry.nextRetryAt = undefined;
    entry.lastErrorCode = undefined;
    await persistConversationState(entry);
    notify({ type: "committing", entry });
  } else if (entry.state === undefined || entry.state === "undoable") {
    // Establish a durable non-undoable boundary before turn rows are deleted.
    // If this marker cannot be persisted, abort before the destructive
    // transaction; a restart must never see an undoable manifest for rows that
    // were already purged.
    entry.state = "committing";
    entry.providerCleanupState = "pending";
    if (!(await persistDeletionState(entry))) {
      armTimer(id, getFinalizeRetryDelayMs(entry.attempts + 1));
      return false;
    }
  }
  let ok = false;
  let dropped = false;
  let quarantined = false;
  let cleanupPending = false;
  let localDeleted = false;
  try {
    const outcome =
      entry.kind === "conversation"
        ? await finalizers.finalizeConversation(entry)
        : await finalizers.finalizeTurn(entry);
    if (typeof outcome === "boolean") {
      ok = outcome;
    } else {
      ok = Boolean(outcome?.ok);
      dropped = Boolean(outcome?.dropped);
      quarantined = Boolean(outcome?.quarantined);
      cleanupPending = Boolean(outcome?.cleanupPending);
      localDeleted = Boolean(outcome?.localDeleted);
    }
  } catch (err) {
    env.log("LLM: pending deletion finalize threw", { id, reason, err });
    ok = false;
  }
  if (quarantined && entry.kind === "conversation") {
    entry.state = "quarantined_identity";
    entry.nextRetryAt = env.now() + FINALIZE_RETRY_DELAY_MS;
    entry.lastErrorCode = "identity_verification_required";
    await persistConversationState(entry);
    armTimer(id, FINALIZE_RETRY_DELAY_MS);
    notify({ type: "quarantined", entry });
    return false;
  }
  if (!ok && localDeleted) {
    // Turn finalization can commit its local rows before provider/runtime
    // cleanup completes.  Treat that boundary as destructive immediately:
    // Undo must not withdraw the intent and present a pair that no longer
    // exists durably.  The same entry remains retryable for cleanup.
    destructivelyFinalizedIds.add(id);
    markRestoreRequestsCommitted(entry.conversationKey);
    entry.state = "cleanup_pending";
    entry.providerCleanupState = "pending";
    // The in-memory marker above is not enough: a restart must not expose an
    // Undo affordance for rows that were already deleted transactionally.
    await persistDeletionState(entry);
  }
  if (ok) {
    if (entry.kind === "conversation" && dropped) {
      // The captured instance was already absent or the key is owned by a
      // different witness.  Preserve that live owner: release only this
      // process-local freeze and advance the generation for stale callbacks.
      bumpConversationWriteGeneration(entry.conversationKey);
      unfreezeConversationWrites(entry.conversationKey);
    }
    if (entry.kind === "conversation") {
      // Whole-conversation deletion owns all of its pending turn intents.
      // Clear them only after the conversation finalizer reports success, so
      // an Undo or a failed local preflight never discards an independent turn
      // decision.
      if (
        !(await purgePendingTurnEntriesForConversation(entry.conversationKey))
      ) {
        ok = false;
      }
    }
  }
  if (ok) {
    if (!dropped) {
      // Mark this before withdrawing the write-ahead row. A restore request
      // racing an already-completed destructive finalizer must fail closed,
      // even if the entry disappears before the restore lane runs.
      destructivelyFinalizedIds.add(id);
      markRestoreRequestsCommitted(entry.conversationKey);
    }
    if (!dropped && entry.kind === "conversation") {
      // Local rows are gone.  If withdrawing this write-ahead row fails, it
      // may remain durable across a restart, but it must no longer retain the
      // user's title or library/paper metadata.  Persist the scrubbed
      // manifest before attempting the row withdrawal; a DB failure keeps the
      // obligation retryable without leaking the content-bearing payload.
      entry.state = cleanupPending ? "cleanup_pending" : "complete";
      entry.providerCleanupState = cleanupPending
        ? "pending"
        : entry.providerCleanupState === "not_required"
          ? "not_required"
          : "complete";
      scrubCommittedConversationManifest(entry);
      if (!(await persistConversationState(entry))) {
        ok = false;
      }
    }
    if (!ok) {
      // The local deletion already committed, but the durable manifest could
      // not be scrubbed.  Keep the row and retry; the generic failure path
      // below never withdraws an unsanitized intent.
    } else {
      // The destructive work is done; a surviving write-ahead row is a live
      // delete intent that the next startup sweep would replay against whatever
      // conversation owns the key by then. Same invariant as undo and give-up:
      // never report completion while the row survives. Attempts are NOT
      // incremented here — hitting the give-up cap would restore visibility of a
      // conversation whose rows are already gone, so this retries until the row
      // is really removed. Any replay is non-destructive: the catalog row is
      // gone, so the staleness check classifies the entry as stale.
      try {
        await deleteRowStrict(id);
      } catch (err) {
        env.log(
          "LLM: failed to withdraw pending-deletion row after finalize; retrying",
          { id, reason, err },
        );
        armTimer(id, getFinalizeRetryDelayMs(entry.attempts + 1));
        // Carry `dropped` through: for an intent that was dropped (the chat is
        // alive), surfaces must not react to this retry by evicting the user.
        notify({ type: "finalize-failed", entry, dropped });
        return false;
      }
      if (entry.kind === "conversation") {
        notify({ type: "local-deleted", entry, dropped });
        if (cleanupPending) {
          notify({ type: "cleanup-pending", entry, dropped });
        }
      }
      removeEntry(id);
      if (
        entry.kind === "turn" &&
        !hasUnrecordedQueueIntent(entry.conversationKey) &&
        !hasEntriesForConversation(entry.conversationKey)
      ) {
        bumpConversationWriteGeneration(entry.conversationKey);
        unfreezeConversationWrites(entry.conversationKey);
      }
      notify({ type: "completed", entry, dropped });
      notify({ type: "finalized", entry, dropped });
      return true;
    }
  }
  entry.attempts += 1;
  // There is intentionally no give-up branch.  The user has already made a
  // destructive decision; withdrawing the write-ahead intent here would make
  // the conversation visible again and allow a later startup sweep or stale
  // surface to resurrect it.  Keep the row durable until the exact target is
  // deleted (or proven already absent) and retry indefinitely.
  if (entry.attempts > Number.MAX_SAFE_INTEGER - 1) {
    entry.attempts = Number.MAX_SAFE_INTEGER - 1;
  }
  env.log("LLM: pending deletion finalize failed; scheduling retry", {
    id,
    reason,
    attempts: entry.attempts,
    maxAttempts: MAX_FINALIZE_ATTEMPTS,
    retryInMs: getFinalizeRetryDelayMs(entry.attempts),
  });
  if (entry.kind === "conversation") {
    entry.state = "retrying_local";
    entry.nextRetryAt = env.now() + getFinalizeRetryDelayMs(entry.attempts);
    entry.lastErrorCode = "local_finalize_failed";
    await persistConversationState(entry);
  }
  await persistAttempts(entry);
  armTimer(id, getFinalizeRetryDelayMs(entry.attempts));
  notify({ type: "finalize-failed", entry });
  return false;
}

function rowToEntry(row: Record<string, unknown>): PendingDeletionEntry | null {
  const id = typeof row.id === "string" ? row.id : "";
  const kind = row.kind === "turn" ? "turn" : "conversation";
  const conversationKey = Math.floor(Number(row.conversation_key || 0));
  const system = String(row.system || "") as ConversationSystem;
  if (!id || !conversationKey || !system) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(String(row.payload || "{}")) as Record<
      string,
      unknown
    >;
  } catch {
    payload = {};
  }
  const queuedAt = Math.floor(Number(row.queued_at || 0));
  const expiresAt = Math.floor(Number(row.expires_at || 0));
  const attempts = Math.floor(Number(row.attempts || 0));
  if (kind === "turn") {
    const userTimestamp = Math.floor(Number(payload.userTimestamp || 0));
    const assistantTimestamp = Math.floor(
      Number(payload.assistantTimestamp || 0),
    );
    if (!userTimestamp || !assistantTimestamp) return null;
    return {
      id,
      kind,
      conversationKey,
      system,
      instanceID:
        typeof payload.instanceID === "string" && payload.instanceID.trim()
          ? payload.instanceID.trim()
          : undefined,
      conversationKind:
        payload.conversationKind === "paper" ? "paper" : "global",
      libraryID: Math.floor(Number(payload.libraryID || 0)) || undefined,
      paperItemID: Math.floor(Number(payload.paperItemID || 0)) || undefined,
      userTimestamp,
      assistantTimestamp,
      userMessageID:
        Math.floor(Number(payload.userMessageID || row.user_message_id || 0)) ||
        undefined,
      assistantMessageID:
        Math.floor(
          Number(payload.assistantMessageID || row.assistant_message_id || 0),
        ) || undefined,
      providerSessionId:
        typeof payload.providerSessionId === "string" &&
        payload.providerSessionId.trim()
          ? payload.providerSessionId.trim()
          : undefined,
      queuedAt,
      expiresAt,
      attempts,
      state:
        payload.state === "committing" ||
        payload.state === "retrying_local" ||
        payload.state === "cleanup_pending" ||
        payload.state === "complete"
          ? payload.state
          : row.state === "committing" ||
              row.state === "retrying_local" ||
              row.state === "cleanup_pending" ||
              row.state === "complete"
            ? (row.state as DeletionState)
            : "undoable",
      providerCleanupState:
        payload.providerCleanupState === "pending" ||
        payload.providerCleanupState === "attention_required" ||
        payload.providerCleanupState === "complete"
          ? payload.providerCleanupState
          : row.provider_cleanup_state === "pending" ||
              row.provider_cleanup_state === "attention_required" ||
              row.provider_cleanup_state === "complete"
            ? (row.provider_cleanup_state as ProviderCleanupState)
            : "not_required",
    };
  }
  return {
    id,
    kind,
    conversationKind: payload.conversationKind === "paper" ? "paper" : "global",
    instanceID:
      typeof payload.instanceID === "string" && payload.instanceID.trim()
        ? payload.instanceID.trim()
        : undefined,
    identityDigest:
      typeof payload.identityDigest === "string" && payload.identityDigest
        ? payload.identityDigest
        : typeof row.identity_digest === "string" && row.identity_digest
          ? row.identity_digest
          : undefined,
    // Absent for rows persisted before the witness existed; 0 makes the
    // finalize-time check fail closed instead of trusting the numeric key.
    catalogCreatedAt: Math.floor(Number(payload.catalogCreatedAt || 0)) || 0,
    conversationID:
      typeof row.conversation_id === "string" && row.conversation_id
        ? row.conversation_id
        : undefined,
    conversationKey,
    libraryID: Math.floor(Number(payload.libraryID || 0)) || 0,
    system,
    paperItemID: Math.floor(Number(payload.paperItemID || 0)) || undefined,
    providerSessionId:
      typeof payload.providerSessionId === "string" && payload.providerSessionId
        ? payload.providerSessionId
        : undefined,
    title: typeof payload.title === "string" ? payload.title : "",
    wasActive: Boolean(payload.wasActive),
    queuedAt,
    expiresAt,
    attempts,
    state:
      payload.state === "committing" ||
      payload.state === "retrying_local" ||
      payload.state === "quarantined_identity" ||
      payload.state === "cleanup_pending" ||
      payload.state === "complete"
        ? payload.state
        : row.state === "committing" ||
            row.state === "retrying_local" ||
            row.state === "quarantined_identity" ||
            row.state === "cleanup_pending" ||
            row.state === "complete"
          ? (row.state as DeletionState)
          : "undoable",
    providerCleanupState:
      payload.providerCleanupState === "pending" ||
      payload.providerCleanupState === "attention_required" ||
      payload.providerCleanupState === "complete"
        ? payload.providerCleanupState
        : row.provider_cleanup_state === "pending" ||
            row.provider_cleanup_state === "attention_required" ||
            row.provider_cleanup_state === "complete"
          ? (row.provider_cleanup_state as ProviderCleanupState)
          : "not_required",
    nextRetryAt:
      Math.floor(Number(payload.nextRetryAt || row.next_retry_at || 0)) ||
      undefined,
    lastErrorCode:
      typeof payload.lastErrorCode === "string"
        ? payload.lastErrorCode
        : typeof row.last_error_code === "string"
          ? row.last_error_code
          : undefined,
  };
}

export const pendingDeletionStore = {
  async init(): Promise<void> {
    if (initialized) return;
    const db = getZoteroDb();
    if (!db) return;
    await db.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PENDING_DELETIONS_TABLE} (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('conversation', 'turn')),
        conversation_id TEXT,
        conversation_key INTEGER NOT NULL,
        system TEXT NOT NULL,
        payload TEXT NOT NULL,
        queued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'undoable',
        provider_cleanup_state TEXT NOT NULL DEFAULT 'not_required',
        identity_digest TEXT,
        next_retry_at INTEGER,
        last_error_code TEXT,
        manifest_version INTEGER NOT NULL DEFAULT 1
      )`,
    );
    for (const definition of [
      "state TEXT NOT NULL DEFAULT 'undoable'",
      "provider_cleanup_state TEXT NOT NULL DEFAULT 'not_required'",
      "identity_digest TEXT",
      "next_retry_at INTEGER",
      "last_error_code TEXT",
      "manifest_version INTEGER NOT NULL DEFAULT 1",
      "user_message_id INTEGER",
      "assistant_message_id INTEGER",
    ]) {
      try {
        await db.queryAsync(
          `ALTER TABLE ${PENDING_DELETIONS_TABLE} ADD COLUMN ${definition}`,
        );
      } catch (error) {
        if (!isAlreadyExistingColumnError(error)) throw error;
        // Existing installations already have the column.
      }
    }
    initialized = true;
  },

  queueConversationDeletion(
    input: Omit<
      PendingConversationDeletionEntry,
      "id" | "kind" | "queuedAt" | "expiresAt" | "attempts"
    >,
  ): Promise<PendingConversationDeletionEntry | null> {
    const conversationKey = Math.floor(Number(input.conversationKey || 0));
    const hadExistingIntent =
      hasUnrecordedConversationQueueIntent(conversationKey) ||
      hasConversationEntriesForConversation(conversationKey);
    // Freeze synchronously at the user's decision boundary, before the
    // write-ahead INSERT and before the six-second Undo timer starts.  A late
    // provider callback that already passed a UI guard must not reach a write
    // while the intent is still being persisted.
    if (conversationKey > 0) {
      freezeConversationWrites(conversationKey);
      if (!hadExistingIntent) bumpConversationWriteGeneration(conversationKey);
    }
    let intentPersisted = false;
    // Retained synchronously at CALL time and released only once the op has
    // FINISHED. Releasing when the op merely started still left a window as
    // wide as the DB insert during which the intent was invisible to the
    // synchronous short-circuits below.
    retainQueueIntent(input.conversationKey, "conversation");
    return enqueueConversationOp(input.conversationKey, async () => {
      try {
        const catalogCreatedAt = Math.floor(
          Number(input.catalogCreatedAt || 0),
        );
        const instanceID = String(input.instanceID || "").trim();
        const existing = Array.from(entries.values()).find(
          (entry) =>
            entry.kind === "conversation" &&
            entry.conversationKey === input.conversationKey,
        ) as PendingConversationDeletionEntry | undefined;
        if (existing) return existing;
        if (!(catalogCreatedAt > 0) || !instanceID) {
          // The delete decision itself is still durable even when the identity
          // witness cannot be captured.  Keep the six-second explicit Undo
          // window; after expiry the finalizer moves this row to durable
          // quarantined_identity and retries only after a deterministic repair.
          // Numeric-key deletion is never a fallback.
          env.log(
            "LLM: queueing conversation deletion without a complete catalog identity witness; finalizer will quarantine",
            {
              conversationKey: input.conversationKey,
              conversationID: input.conversationID,
              hasInstanceID: Boolean(instanceID),
              hasCatalogCreatedAt: catalogCreatedAt > 0,
            },
          );
        }
        const queuedAt = env.now();
        const entry: PendingConversationDeletionEntry = {
          ...input,
          instanceID,
          catalogCreatedAt,
          state: "undoable",
          providerCleanupState:
            (input.system === "codex" &&
              Boolean(input.providerSessionId?.trim())) ||
            (input.system === "claude_code" &&
              (Boolean(input.providerSessionId?.trim()) ||
                Number(input.libraryID || 0) > 0))
              ? "pending"
              : "not_required",
          identityDigest: identityDigest(input),
          id: generateId(),
          kind: "conversation",
          queuedAt,
          expiresAt: queuedAt + DELETION_UNDO_WINDOW_MS,
          attempts: 0,
        };
        // Write-ahead FIRST. Superseding before the insert destroyed the prior
        // pending deletion even when this queue attempt then failed; a failed
        // queue must leave every existing pending entry exactly as it was.
        try {
          await insertRow(entry);
        } catch (err) {
          env.log("LLM: failed to persist pending conversation deletion", err);
          return null;
        }
        intentPersisted = true;
        entries.set(entry.id, entry);
        queueOrder.push(entry.id);
        armTimer(entry.id, entry.expiresAt - env.now());
        notify({ type: "queued", entry });
        return entry;
      } finally {
        // Drop this call's unrecorded intent before deciding whether the
        // write fence can be reopened. Checking first sees our own retained
        // intent and would leave the conversation frozen forever after a
        // failed write-ahead insert.
        releaseQueueIntent(input.conversationKey, "conversation");
        if (
          !intentPersisted &&
          conversationKey > 0 &&
          !hasUnrecordedConversationQueueIntent(conversationKey) &&
          !hasConversationEntriesForConversation(conversationKey)
        ) {
          // A failed write-ahead insert did not establish a deletion intent;
          // restore the live conversation's write boundary.  The generation
          // remains advanced so callbacks from the failed decision stay
          // invalidated.
          unfreezeConversationWrites(conversationKey);
        }
      }
    });
  },

  queueTurnDeletion(
    input: Omit<
      PendingTurnDeletionEntry,
      "id" | "kind" | "queuedAt" | "expiresAt" | "attempts"
    >,
  ): Promise<PendingTurnDeletionEntry | null> {
    // Same contract as queueConversationDeletion: a turn intent must be visible
    // to finalizeTurnsForConversation's short-circuit from the moment it is
    // requested, not merely from when its op starts.
    const conversationKey = Math.floor(Number(input.conversationKey || 0));
    if (conversationKey > 0) {
      // A turn deletion has the same six-second authorization boundary as a
      // whole-conversation deletion. Freeze the owning conversation while the
      // intent is undoable/finalizing so late session capture, sends, edits,
      // and provider callbacks cannot cross the turn boundary.
      freezeConversationWrites(conversationKey);
      bumpConversationWriteGeneration(conversationKey);
    }
    retainQueueIntent(input.conversationKey, "turn");
    return enqueueConversationOp(input.conversationKey, async () => {
      try {
        const existing = Array.from(entries.values()).find(
          (entry) =>
            entry.kind === "turn" &&
            entry.conversationKey === input.conversationKey &&
            entry.userTimestamp === Math.floor(input.userTimestamp) &&
            entry.assistantTimestamp === Math.floor(input.assistantTimestamp),
        ) as PendingTurnDeletionEntry | undefined;
        if (existing) return existing;
        const queuedAt = env.now();
        const entry: PendingTurnDeletionEntry = {
          ...input,
          userTimestamp: Math.floor(input.userTimestamp),
          assistantTimestamp: Math.floor(input.assistantTimestamp),
          id: generateId(),
          kind: "turn",
          queuedAt,
          expiresAt: queuedAt + DELETION_UNDO_WINDOW_MS,
          attempts: 0,
        };
        // Write-ahead FIRST (see queueConversationDeletion), and supersede only
        // other TURN entries — a turn deletion must never commit a conversation
        // deletion that is still undoable.
        try {
          await insertRow(entry);
        } catch (err) {
          env.log("LLM: failed to persist pending turn deletion", err);
          return null;
        }
        entries.set(entry.id, entry);
        queueOrder.push(entry.id);
        armTimer(entry.id, entry.expiresAt - env.now());
        notify({ type: "queued", entry });
        return entry;
      } finally {
        releaseQueueIntent(input.conversationKey, "turn");
        if (
          !hasEntriesForConversation(input.conversationKey) &&
          !hasUnrecordedQueueIntent(input.conversationKey)
        ) {
          unfreezeConversationWrites(input.conversationKey);
        }
      }
    });
  },

  undo(id: string): Promise<PendingDeletionEntry | null> {
    const entry = entries.get(id);
    return entry
      ? enqueueConversationOp(entry.conversationKey, () => undoInternal(id))
      : Promise.resolve(null);
  },

  finalize(id: string, reason: string): Promise<boolean> {
    const entry = entries.get(id);
    if (!entry) return Promise.resolve(true);
    const scheduled = scheduledFinalizations.get(id);
    if (scheduled) return scheduled;
    const run = enqueueConversationOp(entry.conversationKey, () =>
      finalizeInternal(id, reason),
    );
    scheduledFinalizations.set(id, run);
    void run.then(
      () => {
        if (scheduledFinalizations.get(id) === run) {
          scheduledFinalizations.delete(id);
        }
      },
      () => {
        if (scheduledFinalizations.get(id) === run) {
          scheduledFinalizations.delete(id);
        }
      },
    );
    return run;
  },

  finalizeForConversation(
    conversationKey: number,
    reason: string,
  ): Promise<boolean> {
    // Nothing queued for this key: answer without joining the shared chain.
    // Same answer the queued path gives ("no matching entries counts as
    // finalized"), without inheriting an unrelated conversation's latency.
    if (
      !hasUnrecordedQueueIntent(conversationKey) &&
      !hasEntriesForConversation(conversationKey)
    ) {
      return Promise.resolve(true);
    }
    return enqueueConversationOp(conversationKey, async () => {
      const matching = Array.from(entries.values()).filter(
        (entry) => entry.conversationKey === conversationKey,
      );
      let allFinalized = true;
      for (const entry of matching) {
        if (!(await finalizeInternal(entry.id, reason))) {
          allFinalized = false;
        }
      }
      return allFinalized;
    });
  },

  // Turn-only variant for user-action paths (send/retry/edit). Those actions
  // commit hidden-turn removals, but must never commit a pending CONVERSATION
  // deletion: the same chat can still be mounted elsewhere while its deletion
  // is undoable, and the action would otherwise destroy it as a side effect.
  finalizeTurnsForConversation(
    conversationKey: number,
    reason: string,
  ): Promise<boolean> {
    // See finalizeForConversation: no pending turns means no work, and the user
    // path must not queue behind another conversation's finalize.
    if (
      !hasUnrecordedQueueIntent(conversationKey) &&
      !hasTurnEntriesForConversation(conversationKey)
    ) {
      return Promise.resolve(true);
    }
    return enqueueConversationOp(conversationKey, async () => {
      const matching = Array.from(entries.values()).filter(
        (entry) =>
          entry.kind === "turn" && entry.conversationKey === conversationKey,
      );
      let allFinalized = true;
      for (const entry of matching) {
        if (!(await finalizeInternal(entry.id, reason))) {
          allFinalized = false;
        }
      }
      return allFinalized;
    });
  },

  // A user action inside a conversation whose deletion is still undoable means
  // the surface is stale. User activity is never an implicit Undo: only the
  // visible Undo action may call undo(id). Returns false while an intent exists
  // so callers abort rather than writing into a frozen conversation.
  restoreConversationDeletionsFor(conversationKey: number): Promise<boolean> {
    const hasUnrecordedConversationIntent =
      hasUnrecordedConversationQueueIntent(conversationKey);
    // Nothing to withdraw AND no deletion intent still waiting to be recorded:
    // answer without joining the shared chain. The counter is what makes this
    // safe — a queue op that has been requested but not yet run would not be
    // visible in `entries`, and skipping the chain would let the caller write
    // into a chat that is about to be hidden.
    if (
      !hasUnrecordedConversationIntent &&
      !hasConversationEntriesForConversation(conversationKey)
    ) {
      // A surface can still be mounted on a key after the store has emitted
      // `finalized` and removed its entry. Its tombstone means this is not an
      // ordinary no-op restore: the conversation is already gone, so callers
      // must abort instead of writing into the stale item.
      return Promise.resolve(!isConversationRecentlyDeleted(conversationKey));
    }

    return Promise.resolve(false);
  },

  getLatestPending(): PendingDeletionEntry | null {
    const lastId = queueOrder[queueOrder.length - 1];
    return (lastId && entries.get(lastId)) || null;
  },

  // Conversation and turn deletions can now be pending at the same time. A
  // surface that renders only one of them (the standalone window's conversation
  // toast) must fall back to the newest entry of THAT kind rather than going
  // blank because a turn deletion happens to be newer.
  getLatestPendingOfKind<K extends PendingDeletionEntry["kind"]>(
    kind: K,
  ): Extract<PendingDeletionEntry, { kind: K }> | null {
    for (let i = queueOrder.length - 1; i >= 0; i--) {
      const entry = entries.get(queueOrder[i]);
      if (entry && entry.kind === kind) {
        return entry as Extract<PendingDeletionEntry, { kind: K }>;
      }
    }
    return null;
  },

  // Includes intents that have been REQUESTED but are not yet recorded, so
  // callers guarding destructive/adopting behaviour (fresh-draft reuse, the
  // created_at touch) cannot act inside the insert window.
  isConversationPendingDeletion(conversationKey: number): boolean {
    if (quarantinedConversationKeys.has(conversationKey)) return true;
    if (hasUnrecordedQueueIntent(conversationKey)) return true;
    for (const entry of entries.values()) {
      if (
        entry.kind === "conversation" &&
        entry.conversationKey === conversationKey
      ) {
        return true;
      }
    }
    return false;
  },

  getPendingConversationKeys(): Set<number> {
    const keys = new Set<number>();
    for (const key of quarantinedConversationKeys) keys.add(key);
    for (const entry of entries.values()) {
      if (entry.kind === "conversation") keys.add(entry.conversationKey);
    }
    return keys;
  },

  isMessageInPendingTurn(
    conversationKey: number,
    timestamp: number,
    role?: "user" | "assistant",
    messageID?: number,
  ): boolean {
    const normalized = Math.floor(timestamp);
    const normalizedMessageID = Number.isFinite(Number(messageID))
      ? Math.floor(Number(messageID))
      : 0;
    for (const entry of entries.values()) {
      if (entry.kind !== "turn") continue;
      if (entry.conversationKey !== conversationKey) continue;
      if (normalizedMessageID > 0) {
        const expectedMessageID =
          role === "user"
            ? entry.userMessageID
            : role === "assistant"
              ? entry.assistantMessageID
              : undefined;
        if (expectedMessageID !== undefined && expectedMessageID > 0) {
          // Once an intent captured an immutable row ID, it is authoritative:
          // a different row that happens to share its timestamp is not part of
          // the deletion. Legacy/timestamp-only intents have no such witness,
          // so they intentionally fall through to the timestamp match below.
          return expectedMessageID === normalizedMessageID;
        }
      }
      const matchesUser =
        entry.userTimestamp === normalized && role !== "assistant";
      const matchesAssistant =
        entry.assistantTimestamp === normalized && role !== "user";
      if (matchesUser || matchesAssistant) {
        return true;
      }
    }
    return false;
  },

  getPendingTurnsForConversation(
    conversationKey: number,
  ): PendingTurnDeletionEntry[] {
    const matching: PendingTurnDeletionEntry[] = [];
    for (const entry of entries.values()) {
      if (entry.kind === "turn" && entry.conversationKey === conversationKey) {
        matching.push(entry);
      }
    }
    return matching;
  },

  /** Persist a repaired legacy identity before a quarantined intent retries. */
  async repairConversationIdentity(
    entry: PendingConversationDeletionEntry,
    identity: {
      instanceID: string;
      conversationID?: string;
      catalogCreatedAt: number;
    },
  ): Promise<boolean> {
    entry.instanceID = identity.instanceID;
    entry.conversationID = identity.conversationID || entry.conversationID;
    entry.catalogCreatedAt = Math.floor(identity.catalogCreatedAt);
    entry.identityDigest = undefined;
    return persistConversationState(entry);
  },

  findPendingTurn(
    conversationKey: number,
    userTimestamp: number,
    assistantTimestamp: number,
  ): PendingTurnDeletionEntry | null {
    for (const entry of entries.values()) {
      if (
        entry.kind === "turn" &&
        entry.conversationKey === conversationKey &&
        entry.userTimestamp === Math.floor(userTimestamp) &&
        entry.assistantTimestamp === Math.floor(assistantTimestamp)
      ) {
        return entry;
      }
    }
    return null;
  },

  subscribe(listener: (event: PendingDeletionEvent) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  sweepExpired(reason: string): Promise<void> {
    return enqueueOp(async () => {
      const now = env.now();
      const expired = Array.from(entries.values()).filter(
        (entry) => entry.expiresAt <= now && !isInRetryBackoff(entry.id, now),
      );
      // Route each sweep item through its own conversation lane. A timer
      // callback and a remount sweep can observe the same row concurrently,
      // while an unrelated provider timeout must not hold every other chat's
      // deletion behind it.
      await Promise.all(
        expired.map((entry) => pendingDeletionStore.finalize(entry.id, reason)),
      );
    });
  },

  /**
   * Reload every durable deletion intent and re-establish the process-local
   * half of the write-ahead boundary, without finalizing anything.
   *
   * This is the part startup genuinely cannot proceed without: until these
   * rows are loaded, a conversation the user already deleted is not frozen and
   * a send could write into it.  Finalization -- which does destructive local
   * work and provider cleanup -- is deliberately NOT part of it, so a slow or
   * failing provider cannot delay mounting the UI.
   */
  loadPersistedFence(): Promise<void> {
    return enqueueOp(async () => {
      const loaded = await loadPersistedIntentsUnlocked({
        forceExpired: false,
      });
      if (loaded) persistedFenceLoaded = true;
    });
  },

  /**
   * True once the durable intents have been reloaded in this process. Until
   * then the process-local freeze set is incomplete, so a conversation the
   * user deleted in an earlier session may not be frozen yet.
   */
  isPersistedFenceLoaded(): boolean {
    return persistedFenceLoaded;
  },

  /**
   * Retry the fence load if startup could not complete it. Callers about to
   * perform a conversation write use this so a transient database error at
   * launch self-heals on first use instead of either silently dropping the
   * fence or permanently disabling sending.
   *
   * Returns false only when the intents still cannot be read, in which case
   * the caller must refuse the write.
   */
  async ensurePersistedFenceLoaded(): Promise<boolean> {
    if (persistedFenceLoaded) return true;
    try {
      await pendingDeletionStore.loadPersistedFence();
    } catch (error) {
      env.log("LLM: pending deletion fence reload failed", { error });
    }
    return persistedFenceLoaded;
  },

  sweepAllPersisted(
    reason: string,
    options: { forceExpired?: boolean } = {},
  ): Promise<void> {
    return enqueueOp(async () => {
      const eligible = await loadPersistedIntentsUnlocked(options);
      if (!eligible) return;
      persistedFenceLoaded = true;
      // finalize() serializes per conversation, not on the global op chain,
      // so awaiting it from inside enqueueOp cannot deadlock.
      await Promise.all(
        eligible.map((id) => pendingDeletionStore.finalize(id, reason)),
      );
    });
  },
};

/**
 * Shared loader for both the blocking fence load and the deferred sweep.
 * Deliberately not wrapped in enqueueOp: both callers already hold the global
 * op chain, and re-entering it here would deadlock.
 *
 * Returns the IDs whose Undo window has elapsed, i.e. those the sweep should
 * finalize, or null when there is no database to read -- which callers must
 * NOT treat as "no intents exist". A transiently absent handle during startup
 * would otherwise mark the fence complete while real deletions stayed
 * unapplied, which is the exact failure the fence exists to prevent.
 */
async function loadPersistedIntentsUnlocked(
  options: { forceExpired?: boolean } = {},
): Promise<string[] | null> {
  const db = getZoteroDb();
  if (!db) return null;
  await pendingDeletionStore.init();
  const now = options.forceExpired ? Number.MAX_SAFE_INTEGER : env.now();
  const rows = (await db.queryAsync(
    `SELECT id, kind, conversation_id, conversation_key, system, payload, queued_at, expires_at, attempts,
            state, provider_cleanup_state, identity_digest, next_retry_at,
            last_error_code, manifest_version, user_message_id, assistant_message_id
     FROM ${PENDING_DELETIONS_TABLE}`,
  )) as Array<Record<string, unknown>> | undefined;
  const eligibleForFinalize: string[] = [];
  for (const row of rows || []) {
    const entry = rowToEntry(row);
    if (!entry) {
      const rowId = typeof row.id === "string" ? row.id : "";
      const quarantinedKey = Math.floor(Number(row.conversation_key || 0));
      if (quarantinedKey > 0) {
        quarantinedConversationKeys.add(quarantinedKey);
        freezeConversationWrites(quarantinedKey);
        bumpConversationWriteGeneration(quarantinedKey);
      }
      env.log("LLM: quarantining unreadable pending-deletion row", {
        rowId,
      });
      // Never drop a durable user deletion because an old manifest cannot
      // be decoded. Persist the quarantine marker for a repair/migration
      // pass rather than allowing the row to become visible again.
      if (rowId) {
        try {
          await db.queryAsync(
            `UPDATE ${PENDING_DELETIONS_TABLE}
             SET state = 'quarantined_identity',
                 provider_cleanup_state = 'attention_required',
                 last_error_code = 'manifest_unreadable'
             WHERE id = ?`,
            [rowId],
          );
        } catch (error) {
          env.log("LLM: failed to mark unreadable deletion as quarantined", {
            rowId,
            error,
          });
        }
      }
      continue;
    }
    const alreadyLoaded = entries.has(entry.id);
    if (!alreadyLoaded) {
      entries.set(entry.id, entry);
      queueOrder.push(entry.id);
      // Re-establish the process-local half of the durable write-ahead
      // boundary after a restart for BOTH whole-conversation and turn
      // intents.  A turn row is independently undoable, so allowing writes
      // during its six-second window would let a late callback recreate the
      // very turn that the durable intent is about to remove.
      freezeConversationWrites(entry.conversationKey);
      bumpConversationWriteGeneration(entry.conversationKey);
    }
    // A real restart must preserve an unexpired Undo authorization. The
    // durable row is reloaded and its own timer is re-armed; only an
    // expired intent (or an already-committing/retrying state) is eligible
    // for the startup finalizer. Test harnesses that explicitly model an
    // exhausted six-second window may opt into forceExpired.
    if (
      !options.forceExpired &&
      entry.expiresAt > now &&
      (entry.state === undefined || entry.state === "undoable")
    ) {
      armTimer(entry.id, entry.expiresAt - now);
      continue;
    }
    eligibleForFinalize.push(entry.id);
  }
  return eligibleForFinalize;
}

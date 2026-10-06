declare const Zotero: any;

import type { ConversationSystem } from "../../shared/types";
import { getMaintenanceQueryOptions } from "../logging";

export type ConversationCleanupProviderScope = {
  scopeType: "paper" | "open";
  scopeId: string;
  scopeLabel?: string;
};

/**
 * Provider cleanup is deliberately persisted separately from the local
 * deletion intent.  Local deletion is authoritative; a provider outage must
 * never keep the conversation row alive or make it visible again.
 */
export const CONVERSATION_CLEANUP_JOBS_TABLE =
  "llm_for_zotero_conversation_cleanup_jobs";

export type ConversationCleanupJob = {
  id: string;
  operation: "codex_archive" | "claude_invalidate";
  system: ConversationSystem;
  conversationKey: number;
  instanceID: string;
  conversationKind: "global" | "paper";
  libraryID: number;
  paperItemID?: number;
  providerScope?: ConversationCleanupProviderScope;
  providerSessionId: string;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  providerCleanupState: "pending" | "attention_required";
};

type CleanupJobRow = Record<string, unknown>;

type ConversationCleanupJobsChangedListener = () => void;

const cleanupJobsChangedListeners =
  new Set<ConversationCleanupJobsChangedListener>();
const cleanupJobAttempts = new Map<
  string,
  Promise<ConversationCleanupJobAttemptResult>
>();
let cleanupJobsChangedNotificationScheduled = false;

export type ConversationCleanupJobAttemptResult =
  | { ok: true }
  | { ok: false; error: unknown; deferred?: boolean };

/**
 * Observe committed changes to the durable cleanup queue. Transactional
 * inserts deliberately do not emit here: their caller must notify only after
 * the owning transaction commits.
 */
export function onConversationCleanupJobsChanged(
  listener: ConversationCleanupJobsChangedListener,
): () => void {
  cleanupJobsChangedListeners.add(listener);
  return () => cleanupJobsChangedListeners.delete(listener);
}

export function notifyConversationCleanupJobsChanged(): void {
  for (const listener of [...cleanupJobsChangedListeners]) {
    try {
      listener();
    } catch {
      // Queue persistence must never fail because a process-local observer did.
    }
  }
}

export function scheduleConversationCleanupJobsChangedNotification(): void {
  if (cleanupJobsChangedNotificationScheduled) return;
  cleanupJobsChangedNotificationScheduled = true;
  const timer = setTimeout(() => {
    cleanupJobsChangedNotificationScheduled = false;
    notifyConversationCleanupJobsChanged();
  }, 0);
  const maybeUnref = timer as ReturnType<typeof setTimeout> & {
    unref?: () => void;
  };
  maybeUnref.unref?.();
}

type CleanupDb = {
  queryAsync: (
    sql: string,
    params?: unknown[],
    options?: { debug?: boolean },
  ) => Promise<unknown>;
};

function getDb(): CleanupDb | null {
  const db = (globalThis as { Zotero?: { DB?: { queryAsync?: unknown } } })
    .Zotero?.DB;
  return typeof db?.queryAsync === "function" ? (db as CleanupDb) : null;
}

function queryCleanupDb(
  db: CleanupDb,
  sql: string,
  params?: unknown[],
): Promise<unknown> {
  return db.queryAsync(sql, params, getMaintenanceQueryOptions());
}

function normalizePositiveInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalizeOperation(
  value: unknown,
): ConversationCleanupJob["operation"] | null {
  return value === "codex_archive" || value === "claude_invalidate"
    ? value
    : null;
}

function normalizeSystem(value: unknown): ConversationSystem | null {
  return value === "upstream" || value === "claude_code" || value === "codex"
    ? value
    : null;
}

function rowToJob(row: CleanupJobRow): ConversationCleanupJob | null {
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const operation = normalizeOperation(row.operation);
  const system = normalizeSystem(row.system);
  const conversationKey = normalizePositiveInt(row.conversation_key);
  const instanceID =
    typeof row.instance_id === "string" ? row.instance_id.trim() : "";
  const conversationKind =
    row.conversation_kind === "paper" ? "paper" : "global";
  const libraryID = normalizePositiveInt(row.library_id);
  const providerSessionId =
    typeof row.provider_session_id === "string"
      ? row.provider_session_id.trim()
      : "";
  // Claude invalidation is scope/instance-bound even when the catalog has not
  // captured a provider session yet.  Keep an empty provider ID as a durable
  // obligation in that case; Codex archive jobs still require an exact
  // provider thread witness.
  if (
    !id ||
    !operation ||
    !system ||
    !conversationKey ||
    (!providerSessionId && operation !== "claude_invalidate") ||
    (!providerSessionId && !instanceID)
  ) {
    return null;
  }
  const providerScopeType =
    row.provider_scope_type === "paper" || row.provider_scope_type === "open"
      ? row.provider_scope_type
      : null;
  const providerScopeId =
    typeof row.provider_scope_id === "string"
      ? row.provider_scope_id.trim()
      : "";
  return {
    id,
    operation,
    system,
    conversationKey,
    instanceID,
    conversationKind,
    libraryID,
    paperItemID: normalizePositiveInt(row.paper_item_id) || undefined,
    providerScope:
      providerScopeType && providerScopeId
        ? {
            scopeType: providerScopeType,
            scopeId: providerScopeId,
            scopeLabel:
              typeof row.provider_scope_label === "string" &&
              row.provider_scope_label.trim()
                ? row.provider_scope_label.trim()
                : undefined,
          }
        : undefined,
    providerSessionId,
    attempts: Math.max(0, Math.floor(Number(row.attempts) || 0)),
    nextAttemptAt: Math.max(0, Math.floor(Number(row.next_attempt_at) || 0)),
    lastError:
      typeof row.last_error === "string" && row.last_error.trim()
        ? row.last_error.trim()
        : undefined,
    providerCleanupState:
      row.provider_cleanup_state === "attention_required"
        ? "attention_required"
        : "pending",
  };
}

let initPromise: Promise<void> | null = null;

/** Forget the cached table init, for a test that swaps in a fresh database. */
export function resetConversationCleanupJobsInitForTests(): void {
  initPromise = null;
}

function isAlreadyExistingColumnError(error: unknown): boolean {
  return /duplicate column|already exists/i.test(
    String(error instanceof Error ? error.message : error || ""),
  );
}

export async function initConversationCleanupJobs(): Promise<void> {
  if (initPromise) return initPromise;
  const db = getDb();
  if (!db) return;
  initPromise = queryCleanupDb(
    db,
    `CREATE TABLE IF NOT EXISTS ${CONVERSATION_CLEANUP_JOBS_TABLE} (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL CHECK(operation IN ('codex_archive', 'claude_invalidate')),
        system TEXT NOT NULL,
        conversation_key INTEGER NOT NULL,
        instance_id TEXT NOT NULL DEFAULT '',
        conversation_kind TEXT NOT NULL DEFAULT 'global',
        library_id INTEGER NOT NULL DEFAULT 0,
        paper_item_id INTEGER,
        provider_scope_type TEXT,
        provider_scope_id TEXT,
        provider_scope_label TEXT,
        provider_session_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        provider_cleanup_state TEXT NOT NULL DEFAULT 'pending'
      )`,
  )
    .then(async () => {
      for (const definition of [
        "conversation_kind TEXT NOT NULL DEFAULT 'global'",
        "instance_id TEXT NOT NULL DEFAULT ''",
        "library_id INTEGER NOT NULL DEFAULT 0",
        "paper_item_id INTEGER",
        "provider_scope_type TEXT",
        "provider_scope_id TEXT",
        "provider_scope_label TEXT",
        "provider_cleanup_state TEXT NOT NULL DEFAULT 'pending'",
      ]) {
        try {
          await queryCleanupDb(
            db,
            `ALTER TABLE ${CONVERSATION_CLEANUP_JOBS_TABLE} ADD COLUMN ${definition}`,
          );
        } catch (error) {
          if (!isAlreadyExistingColumnError(error)) throw error;
          // Existing installations already have the column.
        }
      }
      // Older builds used a SELECT-then-INSERT dedupe without a database
      // uniqueness fence. Collapse any legacy duplicates before installing
      // the composite identity index; concurrent callers are then serialized
      // by SQLite rather than creating duplicate provider obligations.
      await queryCleanupDb(
        db,
        `DELETE FROM ${CONVERSATION_CLEANUP_JOBS_TABLE}
         WHERE rowid IN (
           SELECT newer.rowid
           FROM ${CONVERSATION_CLEANUP_JOBS_TABLE} newer
           JOIN ${CONVERSATION_CLEANUP_JOBS_TABLE} older
             ON older.operation = newer.operation
            AND older.system = newer.system
            AND older.conversation_key = newer.conversation_key
            AND older.instance_id = newer.instance_id
            AND older.provider_session_id = newer.provider_session_id
            AND older.rowid < newer.rowid
         )`,
      );
      await queryCleanupDb(
        db,
        `CREATE UNIQUE INDEX IF NOT EXISTS
          llm_for_zotero_conversation_cleanup_jobs_identity
         ON ${CONVERSATION_CLEANUP_JOBS_TABLE}
           (operation, system, conversation_key, instance_id, provider_session_id)`,
      );
    })
    .catch((error) => {
      initPromise = null;
      throw error;
    });
  return initPromise;
}

function generateJobID(): string {
  const randomUUID = (globalThis.crypto as Crypto | undefined)?.randomUUID;
  if (typeof randomUUID === "function")
    return `cleanup-${randomUUID.call(globalThis.crypto)}`;
  return `cleanup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function enqueueConversationCleanupJob(params: {
  operation: ConversationCleanupJob["operation"];
  system: ConversationSystem;
  conversationKey: number;
  instanceID?: string;
  conversationKind?: "global" | "paper";
  libraryID?: number;
  paperItemID?: number;
  providerScope?: ConversationCleanupProviderScope;
  providerSessionId: string;
}): Promise<ConversationCleanupJob | null> {
  const db = getDb();
  const conversationKey = normalizePositiveInt(params.conversationKey);
  const providerSessionId = String(params.providerSessionId || "").trim();
  const providerScope = params.providerScope;
  if (
    !db ||
    !conversationKey ||
    (!providerSessionId &&
      (params.operation !== "claude_invalidate" ||
        !providerScope?.scopeType ||
        !providerScope.scopeId ||
        !String(params.instanceID || "").trim()))
  ) {
    return null;
  }
  await initConversationCleanupJobs();
  const job = await enqueueConversationCleanupJobInTransaction(params);
  // Give an enqueueing foreground flow one turn to register its coalesced
  // immediate provider attempt. Otherwise a background wake can acquire the
  // same job while that flow still holds the conversation write lock and then
  // deadlock when the foreground joins an invalidation waiting on that lock.
  if (job) scheduleConversationCleanupJobsChangedNotification();
  return job;
}

/**
 * Insert a provider cleanup job using the caller's active transaction. The
 * cleanup-jobs table must already have been initialized before the outer
 * transaction starts; this helper deliberately performs no DDL and opens no
 * nested transaction. If the insert fails, the caller's local deletion can
 * roll back instead of committing a deletion that cannot be retried after a
 * crash.
 */
export async function enqueueConversationCleanupJobInTransaction(params: {
  operation: ConversationCleanupJob["operation"];
  system: ConversationSystem;
  conversationKey: number;
  instanceID?: string;
  conversationKind?: "global" | "paper";
  libraryID?: number;
  paperItemID?: number;
  providerScope?: ConversationCleanupProviderScope;
  providerSessionId: string;
}): Promise<ConversationCleanupJob | null> {
  const db = getDb();
  const conversationKey = normalizePositiveInt(params.conversationKey);
  const providerSessionId = String(params.providerSessionId || "").trim();
  const providerScope = params.providerScope;
  if (
    !db ||
    !conversationKey ||
    (!providerSessionId &&
      (params.operation !== "claude_invalidate" ||
        !providerScope?.scopeType ||
        !providerScope.scopeId ||
        !String(params.instanceID || "").trim()))
  ) {
    return null;
  }
  const existing = (await queryCleanupDb(
    db,
    `SELECT id, operation, system, conversation_key, instance_id, provider_session_id,
            conversation_kind, library_id, paper_item_id,
            provider_scope_type, provider_scope_id, provider_scope_label,
            attempts, next_attempt_at, last_error, provider_cleanup_state
     FROM ${CONVERSATION_CLEANUP_JOBS_TABLE}
     WHERE operation = ? AND system = ? AND conversation_key = ?
       AND provider_session_id = ? AND instance_id = ?
     LIMIT 1`,
    [
      params.operation,
      params.system,
      conversationKey,
      providerSessionId,
      String(params.instanceID || "").trim(),
    ],
  )) as CleanupJobRow[] | undefined;
  const current = existing?.[0] ? rowToJob(existing[0]) : null;
  if (current) {
    const requestedInstanceID = String(params.instanceID || "").trim();
    if (requestedInstanceID && requestedInstanceID !== current.instanceID) {
      throw new Error("Provider cleanup job identity mismatch");
    }
    if (!requestedInstanceID && current.instanceID) {
      throw new Error("Provider cleanup job identity is required");
    }
    return current;
  }
  const job: ConversationCleanupJob = {
    id: generateJobID(),
    operation: params.operation,
    system: params.system,
    conversationKey,
    instanceID: String(params.instanceID || "").trim(),
    conversationKind: params.conversationKind || "global",
    libraryID: normalizePositiveInt(params.libraryID) || 0,
    paperItemID: normalizePositiveInt(params.paperItemID) || undefined,
    providerScope: params.providerScope,
    providerSessionId,
    attempts: 0,
    nextAttemptAt: Date.now(),
    providerCleanupState: "pending",
  };
  try {
    await queryCleanupDb(
      db,
      `INSERT INTO ${CONVERSATION_CLEANUP_JOBS_TABLE}
        (id, operation, system, conversation_key, instance_id, conversation_kind, library_id, paper_item_id,
         provider_scope_type, provider_scope_id, provider_scope_label,
         provider_session_id, attempts, next_attempt_at, last_error, provider_cleanup_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending')`,
      [
        job.id,
        job.operation,
        job.system,
        job.conversationKey,
        job.instanceID,
        job.conversationKind,
        job.libraryID,
        job.paperItemID || null,
        job.providerScope?.scopeType || null,
        job.providerScope?.scopeId || null,
        job.providerScope?.scopeLabel || null,
        job.providerSessionId,
        job.attempts,
        job.nextAttemptAt,
      ],
    );
  } catch (error) {
    if (!/unique|constraint/i.test(String(error))) throw error;
    const raced = (await queryCleanupDb(
      db,
      `SELECT id, operation, system, conversation_key, instance_id, provider_session_id,
              conversation_kind, library_id, paper_item_id,
              provider_scope_type, provider_scope_id, provider_scope_label,
              attempts, next_attempt_at, last_error, provider_cleanup_state
       FROM ${CONVERSATION_CLEANUP_JOBS_TABLE}
       WHERE operation = ? AND system = ? AND conversation_key = ?
         AND provider_session_id = ? AND instance_id = ?
       LIMIT 1`,
      [
        params.operation,
        params.system,
        conversationKey,
        providerSessionId,
        String(params.instanceID || "").trim(),
      ],
    )) as CleanupJobRow[] | undefined;
    if (!raced?.[0]) throw error;
    return rowToJob(raced[0]);
  }
  return job;
}

/**
 * Empty-session Claude jobs are intentionally a lifecycle barrier. A new
 * turn on the preserved catalog must force a fresh provider session before it
 * can reuse a mapping that Clear was unable to invalidate inline.
 */
export async function hasPendingEmptyClaudeCleanupJob(params: {
  conversationKey: number;
  instanceID?: string;
}): Promise<boolean> {
  const db = getDb();
  const conversationKey = normalizePositiveInt(params.conversationKey);
  const instanceID = String(params.instanceID || "").trim();
  if (!db || !conversationKey) return false;
  try {
    await initConversationCleanupJobs();
    const instancePredicate = instanceID ? "AND instance_id = ?" : "";
    const rows = (await queryCleanupDb(
      db,
      `SELECT 1
       FROM ${CONVERSATION_CLEANUP_JOBS_TABLE}
       WHERE operation = 'claude_invalidate'
         AND system = 'claude_code'
         AND conversation_key = ?
         ${instancePredicate}
         AND provider_session_id = ''
         AND (provider_cleanup_state = 'pending'
              OR provider_cleanup_state = 'attention_required')
       LIMIT 1`,
      instanceID ? [conversationKey, instanceID] : [conversationKey],
    )) as unknown[] | undefined;
    return Boolean(rows?.length);
  } catch (error) {
    // A missing/temporarily unavailable cleanup table must not make a normal
    // turn fail; the durable deletion worker remains responsible for retry.
    if (/no such table|no table/i.test(String(error))) return false;
    throw error;
  }
}

export async function listDueConversationCleanupJobs(
  now = Date.now(),
  options: { includeAttentionRequired?: boolean } = {},
): Promise<ConversationCleanupJob[]> {
  const db = getDb();
  if (!db) return [];
  await initConversationCleanupJobs();
  const rows = (await queryCleanupDb(
    db,
    `SELECT id, operation, system, conversation_key, instance_id, provider_session_id,
            conversation_kind, library_id, paper_item_id,
            provider_scope_type, provider_scope_id, provider_scope_label,
            attempts, next_attempt_at, last_error, provider_cleanup_state
     FROM ${CONVERSATION_CLEANUP_JOBS_TABLE}
     WHERE next_attempt_at <= ?
       AND (provider_cleanup_state = 'pending'
            OR (? = 1 AND provider_cleanup_state = 'attention_required'))
     ORDER BY next_attempt_at ASC, id ASC`,
    [now, options.includeAttentionRequired ? 1 : 0],
  )) as CleanupJobRow[] | undefined;
  return (rows || [])
    .map(rowToJob)
    .filter((job): job is ConversationCleanupJob => Boolean(job));
}

export async function getNextConversationCleanupJobDueAt(
  options: { includeAttentionRequired?: boolean } = {},
): Promise<number | null> {
  const db = getDb();
  if (!db) return null;
  await initConversationCleanupJobs();
  const rows = (await queryCleanupDb(
    db,
    `SELECT MIN(next_attempt_at) AS next_attempt_at
     FROM ${CONVERSATION_CLEANUP_JOBS_TABLE}
     WHERE (provider_cleanup_state = 'pending'
            OR (? = 1 AND provider_cleanup_state = 'attention_required'))
       AND id <> ''
       AND operation IN ('codex_archive', 'claude_invalidate')
       AND system IN ('upstream', 'claude_code', 'codex')
       AND conversation_key > 0
       AND (provider_session_id <> ''
            OR (operation = 'claude_invalidate' AND instance_id <> ''))`,
    [options.includeAttentionRequired ? 1 : 0],
  )) as CleanupJobRow[] | undefined;
  const raw = rows?.[0]?.next_attempt_at;
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

async function getConversationCleanupJobByID(
  id: string,
): Promise<ConversationCleanupJob | null> {
  const db = getDb();
  if (!db || !id) return null;
  await initConversationCleanupJobs();
  const rows = (await queryCleanupDb(
    db,
    `SELECT id, operation, system, conversation_key, instance_id, provider_session_id,
            conversation_kind, library_id, paper_item_id,
            provider_scope_type, provider_scope_id, provider_scope_label,
            attempts, next_attempt_at, last_error, provider_cleanup_state
     FROM ${CONVERSATION_CLEANUP_JOBS_TABLE}
     WHERE id = ?
     LIMIT 1`,
    [id],
  )) as CleanupJobRow[] | undefined;
  return rows?.[0] ? rowToJob(rows[0]) : null;
}

export async function completeConversationCleanupJob(
  id: string,
): Promise<void> {
  const db = getDb();
  if (!db || !id) return;
  await initConversationCleanupJobs();
  await queryCleanupDb(
    db,
    `DELETE FROM ${CONVERSATION_CLEANUP_JOBS_TABLE} WHERE id = ?`,
    [id],
  );
  notifyConversationCleanupJobsChanged();
}

export async function failConversationCleanupJob(
  job: ConversationCleanupJob,
  error: unknown,
  now = Date.now(),
): Promise<void> {
  const db = getDb();
  if (!db) return;
  await initConversationCleanupJobs();
  const attempts = Math.min(Number.MAX_SAFE_INTEGER - 1, job.attempts + 1);
  const delay = Math.min(15 * 60 * 1000, 5_000 * 2 ** Math.min(attempts, 8));
  const jitteredDelay = Math.max(
    1_000,
    Math.floor(delay * (0.8 + Math.random() * 0.4)),
  );
  const message = String(
    error instanceof Error ? error.message : error || "provider cleanup failed",
  ).slice(0, 512);
  await queryCleanupDb(
    db,
    `UPDATE ${CONVERSATION_CLEANUP_JOBS_TABLE}
     SET attempts = ?, next_attempt_at = ?, last_error = ?, provider_cleanup_state = ?
     WHERE id = ?`,
    [
      attempts,
      now + jitteredDelay,
      message,
      /authentication|unauthori[sz]ed|configuration|api key/i.test(message)
        ? "attention_required"
        : "pending",
      job.id,
    ],
  );
  notifyConversationCleanupJobsChanged();
}

/**
 * Coalesce provider work for one durable job inside this plugin process.
 * Deletion paths normally attempt cleanup immediately after persisting the
 * job, while the background scheduler wakes from the same insert. Sharing the
 * full attempt prevents the scheduler from concurrently archiving or
 * invalidating the same provider session and ensures every waiter observes the
 * retry deadline written by the attempt owner.
 */
export function performConversationCleanupJobAttempt(
  job: ConversationCleanupJob,
  operation: () => Promise<void>,
): Promise<ConversationCleanupJobAttemptResult> {
  const existing = cleanupJobAttempts.get(job.id);
  if (existing) return existing;
  const attempt = (async (): Promise<ConversationCleanupJobAttemptResult> => {
    // A jobs list can be overtaken by an inline deletion attempt. Re-read the
    // authoritative row after acquiring the process-local attempt slot so a
    // late list cannot repeat a completed operation or bypass a newly written
    // retry deadline with stale attempts/nextAttemptAt values.
    const current = await getConversationCleanupJobByID(job.id);
    if (!current) return { ok: true };
    if (current.nextAttemptAt > Date.now()) {
      return {
        ok: false,
        deferred: true,
        error: new Error(
          `Provider cleanup retry is deferred until ${current.nextAttemptAt}`,
        ),
      };
    }
    try {
      await operation();
      await completeConversationCleanupJob(current.id);
      return { ok: true };
    } catch (error) {
      await failConversationCleanupJob(current, error);
      return { ok: false, error };
    }
  })().finally(() => {
    if (cleanupJobAttempts.get(job.id) === attempt) {
      cleanupJobAttempts.delete(job.id);
    }
  });
  cleanupJobAttempts.set(job.id, attempt);
  return attempt;
}

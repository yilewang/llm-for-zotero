/**
 * Durable action journal for every agent-owned write.
 *
 * An action is one user-visible tool invocation. Its ordered steps are the
 * individual Zotero/file mutations. A reversible step is persisted before
 * its forward operation starts, so a process exit cannot erase the only
 * recovery description. The v1 flat table is intentionally retained and is
 * migrated idempotently into one-action/one-step v2 records.
 */

import { sweepOrphanRecoveryBlobs } from "./journalRecoveryBlobStore";

export const LEGACY_JOURNAL_TABLE = "llm_for_zotero_agent_change_journal";
export const JOURNAL_ACTIONS_TABLE = "llm_for_zotero_agent_journal_actions_v2";
export const JOURNAL_STEPS_TABLE = "llm_for_zotero_agent_journal_steps_v2";
export const JOURNAL_PAYLOADS_TABLE =
  "llm_for_zotero_agent_journal_payloads_v2";
export const JOURNAL_OBSERVATIONS_TABLE =
  "llm_for_zotero_agent_journal_observations_v2";
export const JOURNAL_BLOB_CLEANUP_TABLE =
  "llm_for_zotero_agent_journal_blob_cleanup_v2";

export type JournalEffect = "none" | "write";
export type JournalReversibility = "full" | "partial" | "none";
export type JournalStatus =
  | "prepared"
  | "applying"
  | "applied"
  | "partially_applied"
  | "no_effect"
  | "irreversible"
  | "reverting"
  | "reverted"
  | "revert_failed"
  | "failed"
  | "uncertain";

export type JournalAction = {
  actionId: string;
  runId: string;
  conversationKey: number;
  toolName: string;
  description: string;
  effect: JournalEffect;
  reversibility: JournalReversibility;
  status: JournalStatus;
  affectedCount: number;
  error?: string;
  recovery?: string;
  createdAt: number;
  updatedAt: number;
  appliedAt?: number;
  revertedAt?: number;
};

export type JournalStep = {
  stepId: string;
  actionId: string;
  sequence: number;
  operation: string;
  forwardJson: string;
  inverseJson?: string;
  preconditionJson?: string;
  expectedPostconditionJson?: string;
  resultJson?: string;
  reversibility: JournalReversibility;
  status: JournalStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type JournalActionWithSteps = JournalAction & {
  steps: JournalStep[];
};

export type JournalUndoSelection = {
  action?: JournalActionWithSteps;
  newerIrreversible: JournalAction[];
};

type DbLike = {
  queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
  executeTransaction?: (task: () => Promise<void>) => Promise<void>;
};

let initializedDb: DbLike | null = null;

function getDb(): DbLike | null {
  try {
    const db = (Zotero as unknown as { DB?: DbLike }).DB;
    return typeof db?.queryAsync === "function" ? db : null;
  } catch {
    return null;
  }
}

export function isAgentChangeJournalAvailable(): boolean {
  const db = getDb();
  return db !== null && db === initializedDb;
}

async function inTransaction(task: () => Promise<void>): Promise<void> {
  const db = getDb();
  if (!db) return;
  if (typeof db.executeTransaction === "function") {
    await db.executeTransaction(task);
  } else {
    await task();
  }
}

function stringify(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function normalizeStatus(value: unknown): JournalStatus {
  const allowed: JournalStatus[] = [
    "prepared",
    "applying",
    "applied",
    "partially_applied",
    "no_effect",
    "irreversible",
    "reverting",
    "reverted",
    "revert_failed",
    "failed",
    "uncertain",
  ];
  return allowed.includes(value as JournalStatus)
    ? (value as JournalStatus)
    : "uncertain";
}

function normalizeReversibility(
  value: unknown,
  fallback: JournalReversibility = "none",
): JournalReversibility {
  return value === "full" || value === "partial" || value === "none"
    ? value
    : fallback;
}

function toAction(row: Record<string, unknown>): JournalAction {
  return {
    actionId: String(row.action_id || ""),
    runId: String(row.run_id || ""),
    conversationKey: Number(row.conversation_key) || 0,
    toolName: String(row.tool_name || ""),
    description: String(row.description || ""),
    effect: row.effect === "none" ? "none" : "write",
    reversibility: normalizeReversibility(row.reversibility),
    status: normalizeStatus(row.status),
    affectedCount: Number(row.affected_count) || 0,
    error: parseOptionalText(row.error_text),
    recovery: parseOptionalText(row.recovery_text),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    appliedAt:
      row.applied_at === null || row.applied_at === undefined
        ? undefined
        : Number(row.applied_at) || undefined,
    revertedAt:
      row.reverted_at === null || row.reverted_at === undefined
        ? undefined
        : Number(row.reverted_at) || undefined,
  };
}

function toStep(row: Record<string, unknown>): JournalStep {
  return {
    stepId: String(row.step_id || ""),
    actionId: String(row.action_id || ""),
    sequence: Number(row.sequence_no) || 0,
    operation: String(row.operation || ""),
    forwardJson: String(row.forward_json || "null"),
    inverseJson: parseOptionalText(row.inverse_json),
    preconditionJson: parseOptionalText(row.precondition_json),
    expectedPostconditionJson: parseOptionalText(
      row.expected_postcondition_json,
    ),
    resultJson: parseOptionalText(row.result_json),
    reversibility: normalizeReversibility(
      row.reversibility,
      row.status === "failed" || row.status === "no_effect"
        ? "full"
        : row.inverse_json != null
          ? "full"
          : "none",
    ),
    status: normalizeStatus(row.status),
    error: parseOptionalText(row.error_text),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

export async function initAgentChangeJournal(): Promise<void> {
  const db = getDb();
  initializedDb = null;
  if (!db) return;
  await inTransaction(async () => {
    await db.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${JOURNAL_ACTIONS_TABLE} (
        action_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        conversation_key INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        description TEXT NOT NULL,
        effect TEXT NOT NULL CHECK(effect IN ('none','write')),
        reversibility TEXT NOT NULL CHECK(reversibility IN ('full','partial','none')),
        status TEXT NOT NULL,
        affected_count INTEGER NOT NULL DEFAULT 0,
        error_text TEXT,
        recovery_text TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        applied_at INTEGER,
        reverted_at INTEGER
      )`,
    );
    await db.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${JOURNAL_ACTIONS_TABLE}_conversation_idx
       ON ${JOURNAL_ACTIONS_TABLE} (conversation_key, created_at DESC)`,
    );
    await db.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${JOURNAL_ACTIONS_TABLE}_run_idx
       ON ${JOURNAL_ACTIONS_TABLE} (run_id, created_at ASC)`,
    );
    await db.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${JOURNAL_STEPS_TABLE} (
        step_id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL,
        sequence_no INTEGER NOT NULL,
        operation TEXT NOT NULL,
        forward_json TEXT NOT NULL,
        inverse_json TEXT,
        precondition_json TEXT,
        expected_postcondition_json TEXT,
        result_json TEXT,
        reversibility TEXT NOT NULL CHECK(reversibility IN ('full','partial','none')),
        status TEXT NOT NULL,
        error_text TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(action_id, sequence_no)
      )`,
    );
    try {
      await db.queryAsync(
        `ALTER TABLE ${JOURNAL_STEPS_TABLE} ADD COLUMN reversibility TEXT`,
      );
    } catch (error) {
      if (!/duplicate column|already exists/i.test(String(error))) throw error;
    }
    // Older development snapshots predate step-level outcome durability.
    // Normalize them once so restart reconciliation has a conservative value.
    await db.queryAsync(
      `UPDATE ${JOURNAL_STEPS_TABLE}
       SET reversibility = CASE
         WHEN status IN ('failed','no_effect') THEN 'full'
         WHEN status = 'irreversible' THEN 'none'
         WHEN inverse_json IS NOT NULL AND error_text IS NOT NULL THEN 'partial'
         WHEN inverse_json IS NOT NULL THEN 'full'
         ELSE 'none' END
       WHERE reversibility IS NULL
          OR reversibility NOT IN ('full','partial','none')`,
    );
    await db.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${JOURNAL_STEPS_TABLE}_action_idx
       ON ${JOURNAL_STEPS_TABLE} (action_id, sequence_no ASC)`,
    );
    await db.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${JOURNAL_PAYLOADS_TABLE} (
        payload_id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL,
        step_id TEXT,
        kind TEXT NOT NULL,
        storage_kind TEXT NOT NULL CHECK(storage_kind IN ('inline','blob')),
        inline_json TEXT,
        blob_path TEXT,
        checksum TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
    );
    await db.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${JOURNAL_OBSERVATIONS_TABLE} (
        observation_id TEXT PRIMARY KEY,
        action_id TEXT,
        event TEXT NOT NULL,
        object_type TEXT NOT NULL,
        object_ids_json TEXT NOT NULL,
        extra_json TEXT,
        created_at INTEGER NOT NULL
      )`,
    );
    await db.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${JOURNAL_BLOB_CLEANUP_TABLE} (
        cleanup_id TEXT PRIMARY KEY,
        conversation_key INTEGER NOT NULL,
        blob_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );

    try {
      await db.queryAsync(
        `INSERT OR IGNORE INTO ${JOURNAL_ACTIONS_TABLE}
          (action_id, run_id, conversation_key, tool_name, description, effect,
           reversibility, status, affected_count, error_text, recovery_text,
           created_at, updated_at, applied_at, reverted_at)
         SELECT entry_id, run_id, conversation_key, operation, description,
           'write',
           CASE WHEN inverse_json IS NOT NULL THEN 'partial' ELSE 'none' END,
           CASE status WHEN 'reverted' THEN 'reverted'
             WHEN 'irreversible' THEN 'irreversible' ELSE 'applied' END,
           item_count, NULL,
           CASE WHEN inverse_json IS NOT NULL
             THEN COALESCE(irreversible_reason, 'Legacy inverse retained for audit; automatic replay requires a verifiable v2 post-image')
             ELSE irreversible_reason END,
           created_at, created_at,
           CASE WHEN status = 'reverted' THEN NULL ELSE created_at END,
           CASE WHEN status = 'reverted' THEN created_at ELSE NULL END
         FROM ${LEGACY_JOURNAL_TABLE}`,
      );
      await db.queryAsync(
        `INSERT OR IGNORE INTO ${JOURNAL_STEPS_TABLE}
          (step_id, action_id, sequence_no, operation, forward_json,
           inverse_json, precondition_json, expected_postcondition_json,
           result_json, reversibility, status, error_text, created_at, updated_at)
         SELECT entry_id || ':1', entry_id, 1, operation, '{}', inverse_json,
           NULL, NULL, NULL,
           CASE WHEN inverse_json IS NOT NULL THEN 'partial' ELSE 'none' END,
           CASE status WHEN 'reverted' THEN 'reverted'
             WHEN 'irreversible' THEN 'irreversible' ELSE 'applied' END,
           irreversible_reason, created_at, created_at
         FROM ${LEGACY_JOURNAL_TABLE}`,
      );
    } catch (error) {
      if (!/no such table|no table/i.test(String(error))) throw error;
    }

    // A process that vanished after claiming a step cannot prove whether
    // Zotero committed it. Preserve that ambiguity explicitly for recovery.
    const startupTime = Date.now();
    // A crashed inverse is different from a crashed forward write: some or all
    // of the inverse may already have landed. Keep it visible and claimable for
    // guarded retry/manual recovery instead of leaving an eternal `reverting`
    // row that neither undo tool can select again.
    await db.queryAsync(
      `UPDATE ${JOURNAL_STEPS_TABLE}
       SET status = 'revert_failed',
           error_text = COALESCE(error_text, 'Interrupted while reverting; verify the current object state before retrying'),
           updated_at = ?
       WHERE status = 'reverting'`,
      [startupTime],
    );
    await db.queryAsync(
      `UPDATE ${JOURNAL_ACTIONS_TABLE}
       SET status = 'revert_failed',
           recovery_text = COALESCE(recovery_text, 'The process stopped during undo. Guarded retry will verify the current post-image before applying another inverse.'),
           updated_at = ?
       WHERE status = 'reverting'`,
      [startupTime],
    );
    await db.queryAsync(
      `UPDATE ${JOURNAL_STEPS_TABLE}
       SET status = 'uncertain', updated_at = ? WHERE status = 'applying'`,
      [startupTime],
    );
    await db.queryAsync(
      `UPDATE ${JOURNAL_ACTIONS_TABLE}
       SET status = 'uncertain', updated_at = ? WHERE status IN ('prepared','applying')
         AND action_id IN (
           SELECT action_id FROM ${JOURNAL_STEPS_TABLE}
           WHERE status = 'uncertain'
         )`,
      [startupTime],
    );
    // A prepared step was never claimed, so its forward write did not start.
    // Close these orphan plans instead of presenting them as undoable work.
    await db.queryAsync(
      `UPDATE ${JOURNAL_STEPS_TABLE}
       SET status = 'failed', error_text = COALESCE(error_text, 'Interrupted before the write started'),
           updated_at = ?
       WHERE status = 'prepared'`,
      [startupTime],
    );
    // Recompute from durable step outcomes, not the original plan. A planned
    // partial/irreversible step that never started must not make a completely
    // restored action report a residual after restart.
    await db.queryAsync(
      `UPDATE ${JOURNAL_ACTIONS_TABLE}
       SET status = 'partially_applied',
           reversibility = CASE
             WHEN NOT EXISTS (
               SELECT 1 FROM ${JOURNAL_STEPS_TABLE} s
               WHERE s.action_id = ${JOURNAL_ACTIONS_TABLE}.action_id
                 AND s.status IN ('applied','irreversible')
                 AND s.reversibility <> 'full'
             ) THEN 'full'
             WHEN NOT EXISTS (
               SELECT 1 FROM ${JOURNAL_STEPS_TABLE} s
               WHERE s.action_id = ${JOURNAL_ACTIONS_TABLE}.action_id
                 AND s.status IN ('applied','irreversible')
                 AND s.reversibility <> 'none'
             ) THEN 'none'
             ELSE 'partial' END,
           recovery_text = (
             SELECT GROUP_CONCAT(s.error_text, ' ')
             FROM ${JOURNAL_STEPS_TABLE} s
             WHERE s.action_id = ${JOURNAL_ACTIONS_TABLE}.action_id
               AND s.status IN ('applied','irreversible')
               AND s.reversibility <> 'full'
               AND s.error_text IS NOT NULL
           ),
           updated_at = ?
       WHERE status IN ('prepared','applying')
         AND EXISTS (
           SELECT 1 FROM ${JOURNAL_STEPS_TABLE} s
           WHERE s.action_id = ${JOURNAL_ACTIONS_TABLE}.action_id
             AND s.status IN ('applied','irreversible')
         )`,
      [startupTime],
    );
    // A completed no-effect step (possibly followed by plans that never
    // started) must not remain pending and block undo of an older action.
    await db.queryAsync(
      `UPDATE ${JOURNAL_ACTIONS_TABLE}
       SET status = 'no_effect', reversibility = 'full', affected_count = 0,
           error_text = NULL, recovery_text = NULL,
           applied_at = COALESCE(applied_at, ?), updated_at = ?
       WHERE status IN ('prepared','applying')
         AND EXISTS (
           SELECT 1 FROM ${JOURNAL_STEPS_TABLE} s
           WHERE s.action_id = ${JOURNAL_ACTIONS_TABLE}.action_id
             AND s.status IN ('no_effect','reverted')
         )`,
      [startupTime, startupTime],
    );
    await db.queryAsync(
      `UPDATE ${JOURNAL_ACTIONS_TABLE}
       SET status = 'failed', reversibility = 'full', affected_count = 0,
           error_text = COALESCE(error_text, 'Interrupted before the write started'),
           recovery_text = NULL,
           updated_at = ?
       WHERE status IN ('prepared','applying')`,
      [startupTime],
    );
  });
  await retireTerminalJournalRecoveryPayloads().catch((error) => {
    // These actions have no recoverable effect. Retention is safe, and the
    // next startup retries retirement if maintenance is temporarily blocked.
    globalThis.Zotero?.debug?.(
      `[llm-for-zotero] Could not retire terminal journal recovery payloads: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  await sweepOrphanRecoveryBlobs(await listRecoveryBlobPaths()).catch(
    (error) => {
      Zotero.debug?.(
        `[llm-for-zotero] Could not sweep orphaned journal recovery blobs: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  );
  await sweepJournalRecoveryBlobCleanup().catch(() => undefined);
  initializedDb = db;
}

let idSequence = 0;
export function createJournalId(prefix: string): string {
  idSequence += 1;
  return `${prefix}-${Date.now()}-${idSequence}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export async function prepareJournalAction(input: {
  actionId?: string;
  runId: string;
  conversationKey: number;
  toolName: string;
  description: string;
  effect: JournalEffect;
  reversibility: JournalReversibility;
  recovery?: string;
  now?: number;
}): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  const now = input.now ?? Date.now();
  const actionId = input.actionId || createJournalId("action");
  await db.queryAsync(
    `INSERT INTO ${JOURNAL_ACTIONS_TABLE}
      (action_id, run_id, conversation_key, tool_name, description, effect,
       reversibility, status, affected_count, error_text, recovery_text,
       created_at, updated_at, applied_at, reverted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', 0, NULL, ?, ?, ?, NULL, NULL)`,
    [
      actionId,
      input.runId,
      input.conversationKey,
      input.toolName,
      input.description,
      input.effect,
      input.reversibility,
      input.recovery ?? null,
      now,
      now,
    ],
  );
  return actionId;
}

export async function prepareJournalStep(input: {
  stepId?: string;
  actionId: string;
  sequence: number;
  operation: string;
  forward: unknown;
  inverse?: unknown;
  precondition?: unknown;
  reversibility?: JournalReversibility;
  status?: "prepared" | "irreversible" | "uncertain";
  error?: string;
  now?: number;
}): Promise<string> {
  const db = getDb();
  if (!db) throw new Error("The durable change journal is unavailable");
  const now = input.now ?? Date.now();
  const stepId = input.stepId || `${input.actionId}:${input.sequence}`;
  await db.queryAsync(
    `INSERT INTO ${JOURNAL_STEPS_TABLE}
      (step_id, action_id, sequence_no, operation, forward_json, inverse_json,
       precondition_json, expected_postcondition_json, result_json,
       reversibility, status, error_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
    [
      stepId,
      input.actionId,
      input.sequence,
      input.operation,
      JSON.stringify(input.forward),
      stringify(input.inverse),
      stringify(input.precondition),
      input.reversibility ||
        (input.status === "irreversible"
          ? "none"
          : input.inverse === undefined
            ? "none"
            : "full"),
      input.status || "prepared",
      input.error ?? null,
      now,
      now,
    ],
  );
  return stepId;
}

export async function updateJournalStep(input: {
  stepId: string;
  status: JournalStatus;
  inverse?: unknown;
  expectedPostcondition?: unknown;
  result?: unknown;
  reversibility?: JournalReversibility;
  error?: string;
  now?: number;
}): Promise<void> {
  const db = getDb();
  if (!db) return;
  const now = input.now ?? Date.now();
  await db.queryAsync(
    `UPDATE ${JOURNAL_STEPS_TABLE}
     SET status = ?, inverse_json = COALESCE(?, inverse_json),
         expected_postcondition_json = COALESCE(?, expected_postcondition_json),
         result_json = COALESCE(?, result_json),
         reversibility = COALESCE(?, reversibility),
         error_text = ?, updated_at = ?
     WHERE step_id = ?`,
    [
      input.status,
      stringify(input.inverse),
      stringify(input.expectedPostcondition),
      stringify(input.result),
      input.reversibility ?? null,
      input.error ?? null,
      now,
      input.stepId,
    ],
  );
}

export async function updateJournalAction(input: {
  actionId: string;
  status: JournalStatus;
  reversibility?: JournalReversibility;
  affectedCount?: number;
  error?: string;
  recovery?: string;
  now?: number;
}): Promise<void> {
  const db = getDb();
  if (!db) return;
  const now = input.now ?? Date.now();
  await db.queryAsync(
    `UPDATE ${JOURNAL_ACTIONS_TABLE}
     SET status = ?, reversibility = COALESCE(?, reversibility),
         affected_count = COALESCE(?, affected_count), error_text = ?,
         recovery_text = COALESCE(?, recovery_text), updated_at = ?,
         applied_at = CASE WHEN ? IN ('applied','partially_applied','irreversible','no_effect')
                           THEN COALESCE(applied_at, ?) ELSE applied_at END,
         reverted_at = CASE WHEN ? = 'reverted' THEN ? ELSE reverted_at END
     WHERE action_id = ?`,
    [
      input.status,
      input.reversibility ?? null,
      input.affectedCount ?? null,
      input.error ?? null,
      input.recovery ?? null,
      now,
      input.status,
      now,
      input.status,
      now,
      input.actionId,
    ],
  );
}

export async function claimJournalStep(input: {
  stepId: string;
  from: JournalStatus[];
  to: JournalStatus;
  now?: number;
}): Promise<boolean> {
  const db = getDb();
  if (!db || !input.from.length) return false;
  let claimed = false;
  await inTransaction(async () => {
    const rows = (await db.queryAsync(
      `SELECT status FROM ${JOURNAL_STEPS_TABLE} WHERE step_id = ?`,
      [input.stepId],
    )) as Array<Record<string, unknown>> | null;
    const status = Array.isArray(rows) ? String(rows[0]?.status || "") : "";
    if (!input.from.includes(status as JournalStatus)) return;
    const placeholders = input.from.map(() => "?").join(", ");
    await db.queryAsync(
      `UPDATE ${JOURNAL_STEPS_TABLE} SET status = ?, updated_at = ?
       WHERE step_id = ? AND status IN (${placeholders})`,
      [input.to, input.now ?? Date.now(), input.stepId, ...input.from],
    );
    claimed = true;
  });
  return claimed;
}

export async function claimJournalAction(input: {
  actionId: string;
  from: JournalStatus[];
  to: JournalStatus;
  now?: number;
}): Promise<boolean> {
  const db = getDb();
  if (!db || !input.from.length) return false;
  let claimed = false;
  await inTransaction(async () => {
    const rows = (await db.queryAsync(
      `SELECT status FROM ${JOURNAL_ACTIONS_TABLE} WHERE action_id = ?`,
      [input.actionId],
    )) as Array<Record<string, unknown>> | null;
    const status = Array.isArray(rows) ? String(rows[0]?.status || "") : "";
    if (!input.from.includes(status as JournalStatus)) return;
    const placeholders = input.from.map(() => "?").join(", ");
    await db.queryAsync(
      `UPDATE ${JOURNAL_ACTIONS_TABLE} SET status = ?, updated_at = ?
       WHERE action_id = ? AND status IN (${placeholders})`,
      [input.to, input.now ?? Date.now(), input.actionId, ...input.from],
    );
    claimed = true;
  });
  return claimed;
}

export async function recordJournalObservation(input: {
  observationId?: string;
  actionId?: string;
  event: string;
  objectType: string;
  objectIds: Array<string | number>;
  extra?: unknown;
  now?: number;
}): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db.queryAsync(
    `INSERT INTO ${JOURNAL_OBSERVATIONS_TABLE}
      (observation_id, action_id, event, object_type, object_ids_json,
       extra_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.observationId || createJournalId("observation"),
      input.actionId ?? null,
      input.event,
      input.objectType,
      JSON.stringify(input.objectIds),
      stringify(input.extra),
      input.now ?? Date.now(),
    ],
  );
}

type RecoveryPayloadLike = {
  storage: "inline" | "blob";
  content?: string;
  blobPath?: string;
  checksum: string;
  sizeBytes: number;
};

function findRecoveryPayloads(value: unknown): RecoveryPayloadLike[] {
  const found: RecoveryPayloadLike[] = [];
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    if (
      depth > 12 ||
      !candidate ||
      typeof candidate !== "object" ||
      seen.has(candidate as object)
    ) {
      return;
    }
    seen.add(candidate as object);
    const record = candidate as Record<string, unknown>;
    if (
      (record.storage === "inline" || record.storage === "blob") &&
      typeof record.checksum === "string" &&
      Number.isFinite(record.sizeBytes)
    ) {
      found.push(record as RecoveryPayloadLike);
      return;
    }
    for (const nested of Object.values(record)) visit(nested, depth + 1);
  };
  visit(value, 0);
  return found;
}

export async function registerJournalRecoveryPayloads(input: {
  actionId: string;
  stepId?: string;
  value: unknown;
}): Promise<void> {
  const db = getDb();
  if (!db) return;
  for (const payload of findRecoveryPayloads(input.value)) {
    await db.queryAsync(
      `INSERT INTO ${JOURNAL_PAYLOADS_TABLE}
        (payload_id, action_id, step_id, kind, storage_kind, inline_json,
         blob_path, checksum, size_bytes, created_at)
       VALUES (?, ?, ?, 'recovery_preimage', ?, ?, ?, ?, ?, ?)`,
      [
        createJournalId("payload-row"),
        input.actionId,
        input.stepId ?? null,
        payload.storage,
        payload.storage === "inline"
          ? JSON.stringify(payload.content || "")
          : null,
        payload.storage === "blob" ? payload.blobPath || null : null,
        payload.checksum,
        Math.max(0, Math.floor(payload.sizeBytes)),
        Date.now(),
      ],
    );
  }
}

async function removeRecoveryBlobPaths(paths: string[]): Promise<void> {
  const io = (globalThis as { IOUtils?: any }).IOUtils;
  if (typeof io?.remove !== "function") return;
  for (const path of new Set(paths.filter(Boolean))) {
    await io.remove(path, { ignoreAbsent: true }).catch((error: unknown) => {
      Zotero.debug?.(
        `[llm-for-zotero] Could not remove journal recovery blob ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
}

export async function queueJournalRecoveryBlobCleanupInTransaction(
  conversationKey: number,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db.queryAsync(
    `INSERT OR IGNORE INTO ${JOURNAL_BLOB_CLEANUP_TABLE}
      (cleanup_id, conversation_key, blob_path, created_at)
     SELECT payload_id, ?, blob_path, ? FROM ${JOURNAL_PAYLOADS_TABLE}
     WHERE storage_kind = 'blob' AND blob_path IS NOT NULL
       AND action_id IN (
         SELECT action_id FROM ${JOURNAL_ACTIONS_TABLE}
         WHERE conversation_key = ?
       )`,
    [conversationKey, Date.now(), conversationKey],
  );
}

export async function sweepJournalRecoveryBlobCleanup(
  conversationKey?: number,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  const params: unknown[] = [];
  const where =
    Number.isFinite(conversationKey) && Number(conversationKey) > 0
      ? (params.push(Math.floor(Number(conversationKey))),
        "WHERE conversation_key = ?")
      : "";
  const rows = (await db.queryAsync(
    `SELECT cleanup_id, blob_path FROM ${JOURNAL_BLOB_CLEANUP_TABLE} ${where}`,
    params,
  )) as Array<Record<string, unknown>> | null;
  const io = (globalThis as { IOUtils?: any }).IOUtils;
  if (typeof io?.remove !== "function") return;
  for (const row of Array.isArray(rows) ? rows : []) {
    const path = String(row.blob_path || "");
    if (!path) continue;
    try {
      await io.remove(path, { ignoreAbsent: true });
      await db.queryAsync(
        `DELETE FROM ${JOURNAL_BLOB_CLEANUP_TABLE} WHERE cleanup_id = ?`,
        [String(row.cleanup_id || "")],
      );
    } catch (error) {
      Zotero.debug?.(
        `[llm-for-zotero] Deferred journal blob cleanup failed for ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function listRecoveryBlobPaths(
  whereSql = "",
  params: unknown[] = [],
): Promise<string[]> {
  const db = getDb();
  if (!db) return [];
  const rows = (await db.queryAsync(
    `SELECT blob_path FROM ${JOURNAL_PAYLOADS_TABLE}
     WHERE storage_kind = 'blob' AND blob_path IS NOT NULL ${whereSql}`,
    params,
  )) as Array<Record<string, unknown>> | null;
  return (Array.isArray(rows) ? rows : [])
    .map((row) => String(row.blob_path || ""))
    .filter(Boolean);
}

export async function listJournalObservationObjectIds(
  actionId: string,
): Promise<number[]> {
  const db = getDb();
  if (!db) return [];
  const rows = (await db.queryAsync(
    `SELECT object_ids_json FROM ${JOURNAL_OBSERVATIONS_TABLE}
     WHERE action_id = ? ORDER BY created_at ASC`,
    [actionId],
  )) as Array<Record<string, unknown>> | null;
  const ids = new Set<number>();
  for (const row of Array.isArray(rows) ? rows : []) {
    try {
      const values = JSON.parse(String(row.object_ids_json || "[]"));
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        const id = Math.floor(Number(value));
        if (Number.isFinite(id) && id > 0) ids.add(id);
      }
    } catch {
      // Malformed audit observations do not make recovery itself fail.
    }
  }
  return [...ids];
}

export async function listJournalSteps(
  actionId: string,
): Promise<JournalStep[]> {
  const db = getDb();
  if (!db) return [];
  const rows = (await db.queryAsync(
    `SELECT * FROM ${JOURNAL_STEPS_TABLE}
     WHERE action_id = ? ORDER BY sequence_no ASC`,
    [actionId],
  )) as Array<Record<string, unknown>> | null;
  return Array.isArray(rows) ? rows.map(toStep) : [];
}

async function retireTerminalJournalRecoveryPayloads(): Promise<void> {
  const db = getDb();
  if (!db) return;
  const now = Date.now();
  await inTransaction(async () => {
    await db.queryAsync(
      `INSERT OR IGNORE INTO ${JOURNAL_BLOB_CLEANUP_TABLE}
        (cleanup_id, conversation_key, blob_path, created_at)
       SELECT p.payload_id, a.conversation_key, p.blob_path, ?
       FROM ${JOURNAL_PAYLOADS_TABLE} p
       JOIN ${JOURNAL_ACTIONS_TABLE} a ON a.action_id = p.action_id
       LEFT JOIN ${JOURNAL_STEPS_TABLE} s ON s.step_id = p.step_id
       WHERE p.storage_kind = 'blob' AND p.blob_path IS NOT NULL
         AND (a.status IN ('failed','no_effect','irreversible')
           OR s.status IN ('failed','no_effect','irreversible'))`,
      [now],
    );
    await db.queryAsync(
      `UPDATE ${JOURNAL_STEPS_TABLE}
       SET forward_json = '{}', inverse_json = NULL,
           precondition_json = NULL, expected_postcondition_json = NULL,
           result_json = NULL
       WHERE (status IN ('failed','no_effect','irreversible')
         OR action_id IN (
           SELECT action_id FROM ${JOURNAL_ACTIONS_TABLE}
           WHERE status IN ('failed','no_effect','irreversible')
         )) AND (forward_json <> '{}' OR inverse_json IS NOT NULL
         OR precondition_json IS NOT NULL
         OR expected_postcondition_json IS NOT NULL
         OR result_json IS NOT NULL)`,
    );
    await db.queryAsync(
      `DELETE FROM ${JOURNAL_PAYLOADS_TABLE}
       WHERE action_id IN (
           SELECT action_id FROM ${JOURNAL_ACTIONS_TABLE}
           WHERE status IN ('failed','no_effect','irreversible')
         ) OR step_id IN (
           SELECT step_id FROM ${JOURNAL_STEPS_TABLE}
           WHERE status IN ('failed','no_effect','irreversible')
         )`,
    );
  });
}

async function journalActionState(actionId: string): Promise<{
  status: JournalStatus;
  conversationKey: number;
} | null> {
  const db = getDb();
  if (!db || !actionId) return null;
  const rows = (await db.queryAsync(
    `SELECT status, conversation_key FROM ${JOURNAL_ACTIONS_TABLE}
     WHERE action_id = ?`,
    [actionId],
  )) as Array<Record<string, unknown>> | null;
  if (!Array.isArray(rows) || !rows[0]) return null;
  const conversationKey = Math.floor(Number(rows[0].conversation_key));
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) {
    throw new Error(`Journal action ${actionId} has no valid conversation key`);
  }
  return {
    status: normalizeStatus(rows[0].status),
    conversationKey,
  };
}

async function compactJournalActionPayloadsInTransaction(input: {
  db: DbLike;
  actionId: string;
  conversationKey: number;
  now: number;
}): Promise<void> {
  // Persist filesystem cleanup intent in the same transaction that drops the
  // payload rows. A crash after commit can then finish blob deletion on
  // startup instead of leaking an unreferenced recovery file.
  await input.db.queryAsync(
    `INSERT OR IGNORE INTO ${JOURNAL_BLOB_CLEANUP_TABLE}
      (cleanup_id, conversation_key, blob_path, created_at)
     SELECT payload_id, ?, blob_path, ? FROM ${JOURNAL_PAYLOADS_TABLE}
     WHERE storage_kind = 'blob' AND blob_path IS NOT NULL
       AND action_id = ?`,
    [input.conversationKey, input.now, input.actionId],
  );
  await input.db.queryAsync(
    `UPDATE ${JOURNAL_STEPS_TABLE}
     SET forward_json = '{}', inverse_json = NULL,
         precondition_json = NULL, expected_postcondition_json = NULL,
         result_json = NULL
     WHERE action_id = ?`,
    [input.actionId],
  );
  await input.db.queryAsync(
    `DELETE FROM ${JOURNAL_PAYLOADS_TABLE} WHERE action_id = ?`,
    [input.actionId],
  );
}

async function sweepActionBlobCleanupBestEffort(
  actionId: string,
  conversationKey: number,
): Promise<void> {
  await sweepJournalRecoveryBlobCleanup(conversationKey).catch((error) => {
    // Cleanup intent is already durable. A later startup sweep can finish it,
    // so a transient maintenance failure must not reopen a committed undo.
    globalThis.Zotero?.debug?.(
      `[llm-for-zotero] Deferred blob cleanup remains for reverted action ${actionId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

/**
 * Commit an undo and retire its recovery authority atomically.
 *
 * If this transaction fails, the action remains retryable and every inverse
 * stays intact. If it commits before the process exits, blob cleanup intent is
 * durable and startup can finish the filesystem deletion.
 */
export async function finalizeRevertedJournalAction(input: {
  actionId: string;
  now?: number;
}): Promise<boolean> {
  const db = getDb();
  if (!db || !input.actionId) return false;
  const state = await journalActionState(input.actionId);
  if (!state || state.status !== "reverting") return false;
  const now = input.now ?? Date.now();
  await inTransaction(async () => {
    await updateJournalAction({
      actionId: input.actionId,
      status: "reverted",
      now,
    });
    await compactJournalActionPayloadsInTransaction({
      db,
      actionId: input.actionId,
      conversationKey: state.conversationKey,
      now,
    });
  });
  await sweepActionBlobCleanupBestEffort(input.actionId, state.conversationKey);
  return true;
}

/**
 * Drop heavy recovery material from historical reverted actions while
 * retaining the lightweight action and step metadata used by audit surfaces.
 */
export async function compactRevertedJournalAction(
  actionId: string,
): Promise<boolean> {
  const db = getDb();
  if (!db || !actionId) return false;
  const state = await journalActionState(actionId);
  if (!state || state.status !== "reverted") return false;
  const now = Date.now();
  await inTransaction(async () => {
    await compactJournalActionPayloadsInTransaction({
      db,
      actionId,
      conversationKey: state.conversationKey,
      now,
    });
  });
  await sweepActionBlobCleanupBestEffort(actionId, state.conversationKey);
  return true;
}

export async function listJournalActions(input: {
  actionId?: string;
  conversationKey?: number;
  runId?: string;
  limit?: number;
  pendingOnly?: boolean;
}): Promise<JournalActionWithSteps[]> {
  const db = getDb();
  if (!db) return [];
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.actionId) {
    clauses.push("action_id = ?");
    params.push(input.actionId);
  }
  if (input.conversationKey !== undefined) {
    clauses.push("conversation_key = ?");
    params.push(input.conversationKey);
  }
  if (input.runId) {
    clauses.push("run_id = ?");
    params.push(input.runId);
  }
  if (input.pendingOnly) {
    clauses.push("status NOT IN ('reverted','no_effect','failed')");
  }
  const limit =
    Number.isFinite(input.limit) && Number(input.limit) > 0
      ? Math.floor(Number(input.limit))
      : 50;
  params.push(limit);
  const rows = (await db.queryAsync(
    `SELECT * FROM ${JOURNAL_ACTIONS_TABLE}
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    params,
  )) as Array<Record<string, unknown>> | null;
  const actions = Array.isArray(rows) ? rows.map(toAction) : [];
  return Promise.all(
    actions.map(async (action) => ({
      ...action,
      steps: await listJournalSteps(action.actionId),
    })),
  );
}

export async function selectUndoJournalAction(input: {
  conversationKey: number;
}): Promise<JournalUndoSelection> {
  const db = getDb();
  if (!db) return { newerIrreversible: [] };
  const rows = (await db.queryAsync(
    `SELECT * FROM ${JOURNAL_ACTIONS_TABLE}
     WHERE conversation_key = ?
       AND status NOT IN ('reverted','no_effect','failed')
     ORDER BY created_at DESC, rowid DESC`,
    [input.conversationKey],
  )) as Array<Record<string, unknown>> | null;
  const pending = Array.isArray(rows) ? rows.map(toAction) : [];
  const targetIndex = pending.findIndex(
    (action) => action.reversibility !== "none",
  );
  if (targetIndex < 0) {
    return { newerIrreversible: pending };
  }
  const target = pending[targetIndex];
  return {
    action: {
      ...target,
      steps: await listJournalSteps(target.actionId),
    },
    newerIrreversible: pending.slice(0, targetIndex),
  };
}

export type JournalRevertSelection = {
  actions: JournalActionWithSteps[];
  /** Newer irreversible actions that were skipped over to reach the targets. */
  skippedIrreversible: JournalAction[];
};

/**
 * Select the newest `count` REVERSIBLE pending actions, the same semantics
 * selectUndoJournalAction applies for a single target: irreversible actions
 * never consume the budget, they are surfaced for disclosure instead.
 */
export async function selectRevertJournalActions(input: {
  conversationKey: number;
  count: number;
}): Promise<JournalRevertSelection> {
  const db = getDb();
  const count = Math.max(0, Math.floor(input.count));
  if (!db || !count) return { actions: [], skippedIrreversible: [] };
  const rows = (await db.queryAsync(
    `SELECT * FROM ${JOURNAL_ACTIONS_TABLE}
     WHERE conversation_key = ?
       AND status NOT IN ('reverted','no_effect','failed')
     ORDER BY created_at DESC, rowid DESC`,
    [input.conversationKey],
  )) as Array<Record<string, unknown>> | null;
  const pending = Array.isArray(rows) ? rows.map(toAction) : [];
  const targets: JournalAction[] = [];
  const skippedIrreversible: JournalAction[] = [];
  for (const action of pending) {
    if (targets.length >= count) break;
    if (action.reversibility === "none") {
      skippedIrreversible.push(action);
    } else {
      targets.push(action);
    }
  }
  return {
    actions: await Promise.all(
      targets.map(async (action) => ({
        ...action,
        steps: await listJournalSteps(action.actionId),
      })),
    ),
    skippedIrreversible,
  };
}

export async function deleteConversationJournal(
  conversationKey: number,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  const actions = await listJournalActions({
    conversationKey,
    limit: 100000,
  });
  const ids = actions.map((action) => action.actionId);
  const blobPaths = ids.length
    ? await listRecoveryBlobPaths(
        `AND action_id IN (${ids.map(() => "?").join(", ")})`,
        ids,
      )
    : [];
  await inTransaction(async () => {
    for (const actionId of ids) {
      await db.queryAsync(
        `DELETE FROM ${JOURNAL_OBSERVATIONS_TABLE} WHERE action_id = ?`,
        [actionId],
      );
      await db.queryAsync(
        `DELETE FROM ${JOURNAL_PAYLOADS_TABLE} WHERE action_id = ?`,
        [actionId],
      );
      await db.queryAsync(
        `DELETE FROM ${JOURNAL_STEPS_TABLE} WHERE action_id = ?`,
        [actionId],
      );
    }
    await db.queryAsync(
      `DELETE FROM ${JOURNAL_ACTIONS_TABLE} WHERE conversation_key = ?`,
      [conversationKey],
    );
    try {
      await db.queryAsync(
        `DELETE FROM ${LEGACY_JOURNAL_TABLE} WHERE conversation_key = ?`,
        [conversationKey],
      );
    } catch (error) {
      if (!/no such table|no table/i.test(String(error))) throw error;
    }
  });
  await removeRecoveryBlobPaths(blobPaths);
}

export async function clearAgentChangeJournal(): Promise<void> {
  const db = getDb();
  if (!db) return;
  const blobPaths = await listRecoveryBlobPaths();
  await inTransaction(async () => {
    await db.queryAsync(`DELETE FROM ${JOURNAL_OBSERVATIONS_TABLE}`);
    await db.queryAsync(`DELETE FROM ${JOURNAL_PAYLOADS_TABLE}`);
    await db.queryAsync(`DELETE FROM ${JOURNAL_STEPS_TABLE}`);
    await db.queryAsync(`DELETE FROM ${JOURNAL_ACTIONS_TABLE}`);
    try {
      await db.queryAsync(`DELETE FROM ${LEGACY_JOURNAL_TABLE}`);
    } catch (error) {
      if (!/no such table|no table/i.test(String(error))) throw error;
    }
  });
  await removeRecoveryBlobPaths(blobPaths);
}

/**
 * Durable progress for long-running batch jobs.
 *
 * Everything a paged action knew — page cursor, target list, taxonomy — lived
 * in local variables inside one `execute()` frame. `startOffset` was in every
 * paged schema and documented as a resume offset, but nothing ever wrote or
 * read it across a process boundary. So a restart at page 7 of 30 lost
 * everything except the pages already committed to Zotero: the user's library
 * was half-reorganised and the job had no memory of it.
 *
 * Schema and lifecycle follow the plugin's existing durable stores.
 */

const BATCH_JOBS_TABLE = "llm_for_zotero_agent_batch_jobs";

export type BatchJobStatus = "running" | "completed" | "cancelled" | "failed";

export type BatchJobRecord = {
  jobId: string;
  conversationKey: number;
  action: string;
  /** The tool arguments the job was started with, so a resume replays them. */
  inputJson: string;
  /** Frozen decisions the job must not re-derive on resume (e.g. a tag set). */
  planJson?: string;
  cursor: number;
  appliedCount: number;
  totalCount?: number;
  status: BatchJobStatus;
  createdAt: number;
  updatedAt: number;
};

type JobRow = {
  job_id: string;
  conversation_key: number;
  action: string;
  input_json: string;
  plan_json: string | null;
  cursor: number;
  applied_count: number;
  total_count: number | null;
  status: string;
  created_at: number;
  updated_at: number;
};

function hasDb(): boolean {
  try {
    return Boolean(
      (Zotero as unknown as { DB?: { queryAsync?: unknown } }).DB?.queryAsync,
    );
  } catch {
    return false;
  }
}

function normalizeStatus(value: unknown): BatchJobStatus {
  return value === "completed" || value === "cancelled" || value === "failed"
    ? value
    : "running";
}

function toRecord(row: JobRow): BatchJobRecord {
  return {
    jobId: row.job_id,
    conversationKey: Number(row.conversation_key) || 0,
    action: row.action,
    inputJson: row.input_json,
    planJson: row.plan_json ?? undefined,
    cursor: Number(row.cursor) || 0,
    appliedCount: Number(row.applied_count) || 0,
    totalCount:
      row.total_count === null || row.total_count === undefined
        ? undefined
        : Number(row.total_count),
    status: normalizeStatus(row.status),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

export async function initAgentBatchJobStore(): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${BATCH_JOBS_TABLE} (
        job_id TEXT PRIMARY KEY,
        conversation_key INTEGER NOT NULL,
        action TEXT NOT NULL,
        input_json TEXT NOT NULL,
        plan_json TEXT,
        cursor INTEGER NOT NULL,
        applied_count INTEGER NOT NULL,
        total_count INTEGER,
        status TEXT NOT NULL CHECK(status IN ('running','completed','cancelled','failed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${BATCH_JOBS_TABLE}_conv_idx
       ON ${BATCH_JOBS_TABLE} (conversation_key, status, updated_at)`,
    );
  });
}

export async function createBatchJob(params: {
  jobId: string;
  conversationKey: number;
  action: string;
  input: unknown;
  plan?: unknown;
  totalCount?: number;
  now: number;
}): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${BATCH_JOBS_TABLE}
     (job_id, conversation_key, action, input_json, plan_json, cursor, applied_count, total_count, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, 'running', ?, ?)`,
    [
      params.jobId,
      params.conversationKey,
      params.action,
      JSON.stringify(params.input ?? {}),
      params.plan === undefined ? null : JSON.stringify(params.plan),
      params.totalCount ?? null,
      params.now,
      params.now,
    ],
  );
}

/**
 * Records progress after a page is applied.
 *
 * Called after the write lands, never before: a cursor ahead of the library
 * would skip work on resume, which is worse than repeating a page.
 */
export async function advanceBatchJob(params: {
  jobId: string;
  cursor: number;
  appliedCount: number;
  plan?: unknown;
  totalCount?: number;
  now: number;
}): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${BATCH_JOBS_TABLE}
     SET cursor = ?, applied_count = ?,
         plan_json = COALESCE(?, plan_json),
         total_count = COALESCE(?, total_count),
         updated_at = ?
     WHERE job_id = ?`,
    [
      params.cursor,
      params.appliedCount,
      params.plan === undefined ? null : JSON.stringify(params.plan),
      params.totalCount ?? null,
      params.now,
      params.jobId,
    ],
  );
}

/** Reopens an interrupted row only after an explicit resume confirmation. */
export async function markBatchJobRunning(params: {
  jobId: string;
  now: number;
}): Promise<boolean> {
  if (!hasDb()) return true;
  let claimed = false;
  await Zotero.DB.executeTransaction(async () => {
    const rows = (await Zotero.DB.queryAsync(
      `SELECT status FROM ${BATCH_JOBS_TABLE} WHERE job_id = ?`,
      [params.jobId],
    )) as unknown as Array<{ status?: unknown }> | null;
    if (!Array.isArray(rows) || rows[0]?.status !== "failed") return;
    await Zotero.DB.queryAsync(
      `UPDATE ${BATCH_JOBS_TABLE}
       SET status = 'running', updated_at = ?
       WHERE job_id = ? AND status = 'failed'`,
      [params.now, params.jobId],
    );
    claimed = true;
  });
  return claimed;
}

export async function finishBatchJob(params: {
  jobId: string;
  status: Exclude<BatchJobStatus, "running">;
  now: number;
}): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${BATCH_JOBS_TABLE} SET status = ?, updated_at = ? WHERE job_id = ?`,
    [params.status, params.now, params.jobId],
  );
}

export async function getBatchJob(
  jobId: string,
): Promise<BatchJobRecord | null> {
  if (!hasDb()) return null;
  const rows = (await Zotero.DB.queryAsync(
    `SELECT * FROM ${BATCH_JOBS_TABLE} WHERE job_id = ?`,
    [jobId],
  )) as unknown as JobRow[] | null;
  const row = Array.isArray(rows) ? rows[0] : null;
  return row ? toRecord(row) : null;
}

/**
 * Jobs left running by a crash or a quit. The batch tool offers to resume
 * these rather than silently restarting from zero and repaying for pages the
 * user already approved.
 */
export async function listResumableBatchJobs(
  conversationKey: number,
): Promise<BatchJobRecord[]> {
  if (!hasDb()) return [];
  const rows = (await Zotero.DB.queryAsync(
    `SELECT * FROM ${BATCH_JOBS_TABLE}
     WHERE conversation_key = ? AND status = 'running'
     ORDER BY updated_at DESC`,
    [conversationKey],
  )) as unknown as JobRow[] | null;
  return Array.isArray(rows) ? rows.map(toRecord) : [];
}

/**
 * Marks jobs abandoned by a crash or a quit.
 *
 * Nothing ever ran at startup, so a job interrupted mid-run stayed
 * `status:'running'` for ever: `listResumableBatchJobs` would keep offering
 * it, and the row implied work was still in progress when no process was
 * doing it. Sweeping at startup is what makes "running" mean running.
 *
 * The rows are kept, not deleted -- the cursor is the only record of how far
 * the job got, and the user may want to resume from it.
 */
export async function sweepInterruptedBatchJobs(params: {
  now: number;
}): Promise<{ sweptCount: number; jobs: BatchJobRecord[] }> {
  if (!hasDb()) return { sweptCount: 0, jobs: [] };
  const rows = (await Zotero.DB.queryAsync(
    `SELECT * FROM ${BATCH_JOBS_TABLE} WHERE status = 'running'`,
  )) as unknown as JobRow[] | null;
  const jobs = Array.isArray(rows) ? rows.map(toRecord) : [];
  if (!jobs.length) return { sweptCount: 0, jobs: [] };
  await Zotero.DB.queryAsync(
    `UPDATE ${BATCH_JOBS_TABLE} SET status = 'failed', updated_at = ? WHERE status = 'running'`,
    [params.now],
  );
  return { sweptCount: jobs.length, jobs };
}

/**
 * Jobs that stopped before the action reached its terminal commit.
 *
 * Used to tell the user what an interrupted run had already applied. This
 * includes a row whose cursor equals total_count: the process may have exited
 * after the final page checkpoint but before the completed status was
 * committed.
 */
export async function listInterruptedBatchJobs(
  conversationKey?: number,
): Promise<BatchJobRecord[]> {
  if (!hasDb()) return [];
  const scoped =
    Number.isFinite(conversationKey) && Number(conversationKey) > 0;
  const rows = (await Zotero.DB.queryAsync(
    `SELECT * FROM ${BATCH_JOBS_TABLE}
     WHERE status = 'failed'
       ${scoped ? "AND conversation_key = ?" : ""}
     ORDER BY updated_at DESC`,
    scoped ? [Math.floor(Number(conversationKey))] : [],
  )) as unknown as JobRow[] | null;
  return Array.isArray(rows) ? rows.map(toRecord) : [];
}

export async function clearAgentBatchJobs(): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.queryAsync(`DELETE FROM ${BATCH_JOBS_TABLE}`);
}

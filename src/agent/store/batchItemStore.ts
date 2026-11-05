/**
 * Durable per-item state for a batch of notes.
 *
 * `batch_jobs` remembers how far a paged job got; it cannot say which of
 * fifty notes were written, because a page is not an item. A note batch needs
 * the finer record: each note has its own finalized material, its own journal
 * step, its own note ID and its own failure. Without a row per item, a crash
 * halfway through left nothing that distinguished a written note from an
 * unwritten one, so the only safe resume was to regenerate and rewrite all
 * fifty.
 *
 * One row per item, written as each note lands, is what makes "continue where
 * it stopped" answerable from storage instead of from the model's memory.
 */
import type { MaterialRef } from "../documents/materialRef";
import { BATCH_JOBS_TABLE } from "./batchJobStore";

export const BATCH_ITEMS_TABLE = "llm_for_zotero_agent_batch_items";

export type BatchItemStatus = "pending" | "saved" | "failed";

export type BatchItemRecord = {
  batchId: string;
  itemKey: string;
  position: number;
  /**
   * The finalized note body this item writes, frozen before the first write.
   * Absent only when that body could not be finalized, which is exactly what
   * makes the row `failed`.
   */
  materialRef?: MaterialRef;
  /** The journal action and step that wrote the note, once one did. */
  actionId?: string;
  stepSequence?: number;
  noteId?: number;
  status: BatchItemStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type NewBatchItem = {
  itemKey: string;
  position: number;
  materialRef?: MaterialRef;
  /**
   * State to open the row in. An item whose body could not be finalized is
   * seeded `failed`: a `pending` row promises a resume material it does not
   * have, and a crash before the write would leave that promise standing.
   */
  status?: BatchItemStatus;
  error?: string;
};

/** A batch with at least one item still unwritten. */
export type ResumableBatch = {
  batchId: string;
  conversationKey: number;
  total: number;
  saved: number;
  failed: number;
  pending: number;
  /** When the batch's rows were seeded; the newest batch over a set of items wins. */
  createdAt: number;
  updatedAt: number;
};

type ItemRow = {
  batch_id: string;
  item_key: string;
  position: number;
  material_document_id: string | null;
  material_version: number | null;
  material_content_hash: string | null;
  action_id: string | null;
  step_sequence: number | null;
  note_id: number | null;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};

type DbLike = { queryAsync: (sql: string, params?: unknown[]) => unknown };

let initializedDb: DbLike | null = null;

function getDb(): DbLike | null {
  try {
    const db = (Zotero as unknown as { DB?: DbLike }).DB;
    return typeof db?.queryAsync === "function" ? db : null;
  } catch {
    return null;
  }
}

/**
 * Whether these rows can be read or written at all.
 *
 * The table itself has to exist, not merely a database: the agent runtime
 * asks for resumable batches at the start of every turn, and a query against
 * a table that was never created would throw there and cost the user the
 * whole turn. The change journal guards its own reads the same way.
 */
function hasDb(): boolean {
  const db = getDb();
  return db !== null && db === initializedDb;
}

function normalizeStatus(value: unknown): BatchItemStatus {
  return value === "saved" || value === "failed" ? value : "pending";
}

function optionalNumber(value: number | null): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function toRecord(row: ItemRow): BatchItemRecord {
  return {
    batchId: row.batch_id,
    itemKey: row.item_key,
    position: Number(row.position) || 0,
    materialRef: row.material_document_id
      ? {
          documentId: row.material_document_id,
          documentVersion: Number(row.material_version) || 1,
          contentHash: String(row.material_content_hash || ""),
        }
      : undefined,
    actionId: row.action_id ?? undefined,
    stepSequence: optionalNumber(row.step_sequence),
    noteId: optionalNumber(row.note_id),
    status: normalizeStatus(row.status),
    error: row.error ?? undefined,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

export async function initAgentBatchItemStore(): Promise<void> {
  const db = getDb();
  initializedDb = null;
  if (!db) return;
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${BATCH_ITEMS_TABLE} (
        batch_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        position INTEGER NOT NULL,
        material_document_id TEXT,
        material_version INTEGER,
        material_content_hash TEXT,
        action_id TEXT,
        step_sequence INTEGER,
        note_id INTEGER,
        status TEXT NOT NULL CHECK(status IN ('pending','saved','failed')),
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(batch_id, item_key)
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${BATCH_ITEMS_TABLE}_position_idx
       ON ${BATCH_ITEMS_TABLE} (batch_id, position)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${BATCH_ITEMS_TABLE}_status_idx
       ON ${BATCH_ITEMS_TABLE} (status, batch_id)`,
    );
  });
  initializedDb = db;
}

/**
 * Seeds the batch before its first write.
 *
 * An item that already has a row keeps it: the stored row is the record of
 * what happened to that note, and a repeated call — a retry of the same tool
 * call — must never reset a written note back to `pending`.
 */
export async function createBatchItems(
  batchId: string,
  rows: readonly NewBatchItem[],
  now: number = Date.now(),
): Promise<void> {
  if (!hasDb() || !rows.length) return;
  await Zotero.DB.executeTransaction(async () => {
    for (const row of rows) {
      await Zotero.DB.queryAsync(
        `INSERT OR IGNORE INTO ${BATCH_ITEMS_TABLE}
         (batch_id, item_key, position, material_document_id, material_version,
          material_content_hash, action_id, step_sequence, note_id, status,
          error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
        [
          batchId,
          row.itemKey,
          row.position,
          row.materialRef?.documentId ?? null,
          row.materialRef?.documentVersion ?? null,
          row.materialRef?.contentHash ?? null,
          row.status ?? "pending",
          row.error ?? null,
          now,
          now,
        ],
      );
    }
  });
}

/** Records the note a step actually wrote, after the native write landed. */
export async function markBatchItemSaved(
  batchId: string,
  itemKey: string,
  params: {
    actionId?: string;
    stepSequence?: number;
    noteId: number;
    now?: number;
  },
): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${BATCH_ITEMS_TABLE}
     SET status = 'saved', action_id = ?, step_sequence = ?, note_id = ?,
         error = NULL, updated_at = ?
     WHERE batch_id = ? AND item_key = ?`,
    [
      params.actionId ?? null,
      params.stepSequence ?? null,
      params.noteId,
      params.now ?? Date.now(),
      batchId,
      itemKey,
    ],
  );
}

/** Records why one item did not land, leaving its material available to retry. */
export async function markBatchItemFailed(
  batchId: string,
  itemKey: string,
  params: {
    actionId?: string;
    stepSequence?: number;
    error: string;
    now?: number;
  },
): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${BATCH_ITEMS_TABLE}
     SET status = 'failed', action_id = ?, step_sequence = ?, error = ?,
         updated_at = ?
     WHERE batch_id = ? AND item_key = ?`,
    [
      params.actionId ?? null,
      params.stepSequence ?? null,
      params.error,
      params.now ?? Date.now(),
      batchId,
      itemKey,
    ],
  );
}

/**
 * Records that another batch now holds this item's note.
 *
 * A later batch over the same paper wrote its note, or found one already
 * saved, so this row's work is done: left `pending`, a resume of this batch
 * would write the paper a second time. The row's own journal action and step
 * are kept, because they are the record of what this batch itself did.
 */
export async function markBatchItemSettled(
  batchId: string,
  itemKey: string,
  params: { noteId: number; now?: number },
): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${BATCH_ITEMS_TABLE}
     SET status = 'saved', note_id = ?, error = NULL, updated_at = ?
     WHERE batch_id = ? AND item_key = ?`,
    [params.noteId, params.now ?? Date.now(), batchId, itemKey],
  );
}

export async function listBatchItems(
  batchId: string,
): Promise<BatchItemRecord[]> {
  if (!hasDb()) return [];
  const rows = (await Zotero.DB.queryAsync(
    `SELECT * FROM ${BATCH_ITEMS_TABLE}
     WHERE batch_id = ? ORDER BY position ASC`,
    [batchId],
  )) as unknown as ItemRow[] | null;
  return Array.isArray(rows) ? rows.map(toRecord) : [];
}

/**
 * The set of items a batch covers, order-independent.
 *
 * The separator is NUL because no Zotero item key can contain it, so two
 * different item sets can never join to the same string. It is spelled as an
 * escape: a literal NUL byte in the source renders as a space in editors and
 * makes tooling treat this module as a binary file.
 */
export function itemSetSignature(itemKeys: string): string {
  return itemKeys.split(",").sort().join("\u0000");
}

/**
 * Batches of this conversation that still have an item to write.
 *
 * The rows are the authority, not the job status: a batch whose items are all
 * `saved` has nothing to continue even while its job row is still open, and a
 * batch with one failed item is resumable even after the process restarted.
 *
 * Only the newest batch over a given set of items is offered. A batch's
 * identity is derived from its frozen material, so writing the same papers
 * again with edited bodies mints a second batch while the first keeps its
 * unwritten rows. Offering both would invite the same paper to be written
 * twice, once from text the user already replaced -- and a superseded batch
 * has to disappear even when the batch that replaced it finished, which is
 * why the comparison runs over every batch of the conversation rather than
 * over the resumable ones alone.
 */
export async function listResumableBatches(
  conversationKey: number,
): Promise<ResumableBatch[]> {
  if (!hasDb()) return [];
  const rows = (await Zotero.DB.queryAsync(
    `SELECT items.batch_id AS batchId,
            jobs.conversation_key AS conversationKey,
            COUNT(*) AS total,
            SUM(CASE WHEN items.status = 'saved' THEN 1 ELSE 0 END) AS saved,
            SUM(CASE WHEN items.status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN items.status = 'pending' THEN 1 ELSE 0 END) AS pending,
            MIN(items.created_at) AS createdAt,
            MAX(items.updated_at) AS updatedAt,
            GROUP_CONCAT(items.item_key) AS itemKeys
     FROM ${BATCH_ITEMS_TABLE} items
     JOIN ${BATCH_JOBS_TABLE} jobs ON jobs.job_id = items.batch_id
     WHERE jobs.conversation_key = ?
     GROUP BY items.batch_id, jobs.conversation_key
     ORDER BY MAX(items.updated_at) DESC`,
    [conversationKey],
  )) as unknown as Array<Record<string, unknown>> | null;
  const batches = (Array.isArray(rows) ? rows : []).map((row) => ({
    batch: {
      batchId: String(row.batchId),
      conversationKey: Number(row.conversationKey) || 0,
      total: Number(row.total) || 0,
      saved: Number(row.saved) || 0,
      failed: Number(row.failed) || 0,
      pending: Number(row.pending) || 0,
      createdAt: Number(row.createdAt) || 0,
      updatedAt: Number(row.updatedAt) || 0,
    },
    signature: itemSetSignature(String(row.itemKeys || "")),
  }));
  const newestPerItemSet = new Map<string, ResumableBatch>();
  for (const { batch, signature } of batches) {
    const current = newestPerItemSet.get(signature);
    // Ties are broken on the id so two batches seeded in the same
    // millisecond still resolve to one live batch, never to both.
    if (
      !current ||
      batch.createdAt > current.createdAt ||
      (batch.createdAt === current.createdAt && batch.batchId > current.batchId)
    )
      newestPerItemSet.set(signature, batch);
  }
  const live = new Set(
    [...newestPerItemSet.values()].map((batch) => batch.batchId),
  );
  return batches
    .map(({ batch }) => batch)
    .filter(
      (batch) => live.has(batch.batchId) && batch.pending + batch.failed > 0,
    );
}

export async function clearAgentBatchItems(): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.queryAsync(`DELETE FROM ${BATCH_ITEMS_TABLE}`);
}

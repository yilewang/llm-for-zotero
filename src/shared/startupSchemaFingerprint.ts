import { CONVERSATION_FENCE_VERSION } from "./conversationKeyLedger";
import {
  CONVERSATION_SCHEMA_MIGRATIONS_TABLE,
  markConversationSchemaMigrationApplied,
} from "./conversationSchemaMigrations";

/**
 * Startup schema passes and the Zotero transaction queue.
 *
 * Each conversation store re-issues its whole schema on every launch (tables,
 * columns, indexes, marker reads, self-heal passes, fence triggers).  Inside
 * `Zotero.DB.executeTransaction` that was harmful: the passes share Zotero's
 * single storage thread with its own library load, so each awaited statement
 * queues behind Zotero's work and the transaction stayed open for minutes.
 * Everything else in Zotero that calls `executeTransaction` (sync, repository
 * updates, bundled-file updates) waits on an open transaction and times out
 * after 30 s.  A statement issued outside a transaction does not block those
 * callers.
 *
 * So the transaction is only needed while the store's schema is not yet
 * current: a first run, an upgrade that adds a migration or a fence version, or
 * a database whose markers are missing.  Once the transactional pass commits it
 * records a fingerprint of what it applied, in the same database as the schema
 * it describes (never a pref: prefs are per profile and the database can be
 * swapped underneath them).  A later launch that finds the same fingerprint and
 * every declared migration marker runs the unchanged, idempotent pass without
 * the transaction.
 */

export type StartupSchemaStoreID =
  | "upstream"
  | "claude-code"
  | "codex"
  | "antigravity";

export type StartupSchemaPass = {
  /**
   * Run a multi-statement repair that must commit as a unit.  On the cold
   * path the whole pass is already one transaction, so this runs the task
   * inline (Zotero transactions do not nest: an inner `executeTransaction`
   * would wait on the outer one until it times out).  On the warm path it
   * opens a short transaction for just that task.  Repairs call it only when
   * they actually found something to repair, so a clean warm start still
   * holds no transaction.
   */
  atomically: <T>(task: () => Promise<T>) => Promise<T>;
};

const STARTUP_SCHEMA_FINGERPRINT_ID_PREFIX = "startup-schema-fingerprint:";

type ZoteroDb = {
  queryAsync?: (sql: string, params?: unknown[]) => Promise<unknown>;
  executeTransaction?: <T>(task: () => Promise<T>) => Promise<T>;
};

function getZoteroDb(): ZoteroDb | null {
  return (
    (globalThis as typeof globalThis & { Zotero?: { DB?: ZoteroDb } }).Zotero
      ?.DB || null
  );
}

export function startupSchemaFingerprintID(storeID: string): string {
  return `${STARTUP_SCHEMA_FINGERPRINT_ID_PREFIX}${storeID}`;
}

/**
 * Everything whose change must send the next launch back through the
 * transactional pass: the fence version, the store's own schema revision, and
 * the ordered list of migrations the pass guards with markers.
 */
export function buildStartupSchemaFingerprint(params: {
  schemaRevision: number;
  migrationIDs: readonly string[];
}): string {
  return [
    `fence-v${CONVERSATION_FENCE_VERSION}`,
    `schema-r${params.schemaRevision}`,
    ...params.migrationIDs,
  ].join("|");
}

/**
 * One read, outside any transaction: true only when the stored fingerprint
 * matches and every declared migration marker is present.  Any failure (no
 * migrations table yet, a test double without SQL) means "not current".
 */
async function hasStartupSchemaFingerprint(
  storeID: StartupSchemaStoreID,
  fingerprint: string,
  migrationIDs: readonly string[],
): Promise<boolean> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return false;
  const fingerprintID = startupSchemaFingerprintID(storeID);
  const ids = [fingerprintID, ...migrationIDs];
  let rows: Array<{ id?: unknown; description?: unknown }> | undefined;
  try {
    rows = (await db.queryAsync(
      `SELECT id, description
       FROM ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE}
       WHERE id IN (${ids.map(() => "?").join(", ")})`,
      ids,
    )) as Array<{ id?: unknown; description?: unknown }> | undefined;
  } catch {
    return false;
  }
  const present = new Map<string, unknown>();
  for (const row of rows || []) {
    if (typeof row.id === "string") present.set(row.id, row.description);
  }
  if (present.get(fingerprintID) !== fingerprint) return false;
  return migrationIDs.every((id) => present.has(id));
}

/**
 * Run a store's startup schema pass.  `body` is the whole pass and must stay
 * idempotent: on a warm start it runs statement by statement with no
 * transaction held, and on a cold start or upgrade it runs inside one
 * transaction that also records the fingerprint, so a pass that fails midway
 * leaves no fingerprint behind and the next launch retries transactionally.
 */
export async function runConversationStoreStartupSchema(params: {
  storeID: StartupSchemaStoreID;
  schemaRevision: number;
  migrationIDs: readonly string[];
  body: (pass: StartupSchemaPass) => Promise<void>;
}): Promise<void> {
  const fingerprint = buildStartupSchemaFingerprint(params);
  if (
    await hasStartupSchemaFingerprint(
      params.storeID,
      fingerprint,
      params.migrationIDs,
    )
  ) {
    await params.body({
      atomically: (task) => Zotero.DB.executeTransaction(task),
    });
    return;
  }
  await Zotero.DB.executeTransaction(async () => {
    await params.body({ atomically: (task) => task() });
    await markConversationSchemaMigrationApplied(
      startupSchemaFingerprintID(params.storeID),
      fingerprint,
    );
  });
}

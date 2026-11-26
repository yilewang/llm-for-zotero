/**
 * Removes the `CHECK(system IN ('upstream', 'claude_code', 'codex'))`
 * constraint from the shared conversation tables, so they can hold a
 * conversation system added after those tables were created.
 *
 * Databases created before Antigravity declared the constraint on the
 * conversation registry, the key ledger, and the search index. SQLite cannot
 * alter a constraint, so each of those tables is rebuilt from its stored
 * definition with only that clause removed. New databases never declare it;
 * the system name is validated in code against the conversation-system
 * registry instead.
 *
 * The rebuild runs only when a runtime that needs it is turned on, so a
 * profile that never uses one keeps its schema. It runs in one transaction,
 * finds its work by reading the schema (so it is idempotent and needs no
 * marker to decide), and records a schema-migration row when it rebuilds.
 *
 * The table is never renamed: triggers on other tables name these tables, and
 * SQLite refuses to rename a table while a trigger elsewhere names a table
 * that does not exist. The rows go to a backup table, the original is dropped
 * and recreated under its own name, and the rows come back.
 */

import { CONVERSATION_KEY_LEDGER_TABLE } from "./conversationKeyLedger";
import { CONVERSATION_REGISTRY_TABLE } from "./conversationRegistry";
import { markConversationSchemaMigrationApplied } from "./conversationSchemaMigrations";
import { CONVERSATION_SEARCH_INDEX_TABLE } from "./conversationSearchIndex";
import { getZoteroDb, type ZoteroDb } from "../core/zoteroDb";

export const CONVERSATION_SYSTEM_CHECK_MIGRATION_ID =
  "conversation-system-check-v1:removed";

const MIGRATION_DESCRIPTION =
  "Rebuild the conversation registry, key ledger, and search index without the conversation-system CHECK constraint.";

/** The tables that declared the system CHECK, in rebuild order. */
export const CONVERSATION_SYSTEM_CHECK_TABLES: readonly string[] = [
  CONVERSATION_REGISTRY_TABLE,
  CONVERSATION_KEY_LEDGER_TABLE,
  CONVERSATION_SEARCH_INDEX_TABLE,
];

/** The clause, with the whitespace before it, as SQLite stores it. */
const SYSTEM_CHECK_CLAUSE =
  /\s*CHECK\s*\(\s*system\s+IN\s*\(\s*'[^']*'(?:\s*,\s*'[^']*')*\s*\)\s*\)/i;

async function query<T = Record<string, unknown>>(
  db: ZoteroDb,
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  if (!db.queryAsync) throw new Error("Zotero DB is unavailable");
  return ((await db.queryAsync(sql, params)) as T[] | undefined) || [];
}

async function readTableSql(db: ZoteroDb, table: string): Promise<string> {
  const rows = await query<{ sql?: unknown }>(
    db,
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [table],
  );
  return typeof rows[0]?.sql === "string" ? rows[0].sql : "";
}

/** The tables that still declare the system CHECK. */
export async function findTablesWithConversationSystemCheck(): Promise<
  string[]
> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return [];
  const tables: string[] = [];
  for (const table of CONVERSATION_SYSTEM_CHECK_TABLES) {
    if (SYSTEM_CHECK_CLAUSE.test(await readTableSql(db, table))) {
      tables.push(table);
    }
  }
  return tables;
}

async function countRows(db: ZoteroDb, table: string): Promise<number> {
  const rows = await query<{ n?: unknown }>(
    db,
    `SELECT COUNT(*) AS n FROM ${table}`,
  );
  return Number(rows[0]?.n) || 0;
}

async function rebuildWithoutSystemCheck(
  db: ZoteroDb,
  table: string,
): Promise<boolean> {
  const tableSql = await readTableSql(db, table);
  if (!SYSTEM_CHECK_CLAUSE.test(tableSql)) return false;
  const rebuiltSql = tableSql.replace(SYSTEM_CHECK_CLAUSE, "");
  if (SYSTEM_CHECK_CLAUSE.test(rebuiltSql)) {
    throw new Error(`${table} declares the system CHECK more than once`);
  }
  // Indexes and triggers on the table go with DROP TABLE; the ones SQLite
  // creates for constraints (sql IS NULL) come back with the table itself.
  const dependents = await query<{ sql?: unknown }>(
    db,
    `SELECT sql FROM sqlite_master
     WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL
     ORDER BY CASE type WHEN 'index' THEN 0 ELSE 1 END, name`,
    [table],
  );
  const columns = (
    await query<{ name?: unknown }>(db, `PRAGMA table_info(${table})`)
  )
    .map((column) => String(column.name || ""))
    .filter(Boolean);
  if (!columns.length) throw new Error(`${table} has no columns`);
  const columnList = columns.join(", ");
  const backup = `${table}__system_check_backup`;
  const before = await countRows(db, table);

  await query(db, `DROP TABLE IF EXISTS ${backup}`);
  await query(
    db,
    `CREATE TABLE ${backup} AS SELECT ${columnList} FROM ${table}`,
  );
  await query(db, `DROP TABLE ${table}`);
  await query(db, rebuiltSql);
  await query(
    db,
    `INSERT INTO ${table} (${columnList}) SELECT ${columnList} FROM ${backup}`,
  );
  const after = await countRows(db, table);
  if (after !== before) {
    throw new Error(`${table} rebuild kept ${after} of ${before} rows`);
  }
  await query(db, `DROP TABLE ${backup}`);
  for (const dependent of dependents) {
    if (typeof dependent.sql === "string") await query(db, dependent.sql);
  }
  return true;
}

export type ConversationSystemCheckRemoval = {
  /** The tables rebuilt by this call; empty when there was nothing to do. */
  rebuilt: string[];
};

/**
 * Rebuilds every shared conversation table that still declares the system
 * CHECK, in one transaction. Must not be called inside another transaction
 * (Zotero transactions do not nest).
 *
 * `beforeCommit` is a test seam: it runs inside the transaction after the
 * rebuild, so a test can fail it and prove the rollback.
 */
export async function removeConversationSystemChecks(
  options: { beforeCommit?: () => Promise<void> } = {},
): Promise<ConversationSystemCheckRemoval> {
  const db = getZoteroDb();
  if (!db?.queryAsync || !db.executeTransaction) {
    throw new Error("Zotero DB is unavailable");
  }
  if (!(await findTablesWithConversationSystemCheck()).length) {
    return { rebuilt: [] };
  }
  const rebuilt: string[] = [];
  await db.executeTransaction(async () => {
    for (const table of CONVERSATION_SYSTEM_CHECK_TABLES) {
      if (await rebuildWithoutSystemCheck(db, table)) rebuilt.push(table);
    }
    await markConversationSchemaMigrationApplied(
      CONVERSATION_SYSTEM_CHECK_MIGRATION_ID,
      MIGRATION_DESCRIPTION,
    );
    await options.beforeCommit?.();
  });
  return { rebuilt };
}

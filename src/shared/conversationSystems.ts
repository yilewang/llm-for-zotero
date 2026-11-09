import type { ConversationSystem } from "./types";

/** Every conversation system, in store order. */
export const CONVERSATION_SYSTEMS: readonly ConversationSystem[] = [
  "upstream",
  "claude_code",
  "codex",
  "antigravity",
];

export function isConversationSystem(
  value: unknown,
): value is ConversationSystem {
  return (CONVERSATION_SYSTEMS as readonly unknown[]).includes(value);
}

/**
 * The `CHECK(system IN (...))` value list for tables that store a system.
 * Tables created before a system existed keep their old constraint, so each
 * owner runs `rebuildTableForCurrentSystemCheck` before using its table.
 */
export const CONVERSATION_SYSTEM_SQL_VALUES = CONVERSATION_SYSTEMS.map(
  (system) => `'${system}'`,
).join(", ");

type SchemaDb = {
  queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
  executeTransaction?: (task: () => Promise<unknown>) => Promise<unknown>;
  inTransaction?: () => boolean;
};

const SYSTEM_CHECK_PATTERN = /CHECK\s*\(\s*system\s+IN\s*\(([^)]*)\)\s*\)/i;

/** True when the table's stored CHECK(system IN ...) omits a current system. */
export function isSystemCheckOutdated(createSql: string): boolean {
  const match = SYSTEM_CHECK_PATTERN.exec(createSql);
  if (!match) return false;
  const allowed = new Set(
    match[1]
      .split(",")
      .map((value) => value.trim().replace(/^'|'$/g, ""))
      .filter(Boolean),
  );
  return CONVERSATION_SYSTEMS.some((system) => !allowed.has(system));
}

/**
 * SQLite cannot widen a CHECK constraint in place. When `table` was created
 * with an older system list, copy it into a table built by `createTable`
 * (which must use CREATE TABLE IF NOT EXISTS with the current list) and swap
 * it in. Indexes on the old table go with it; callers recreate theirs after
 * this returns, as their init already does with IF NOT EXISTS.
 *
 * Triggers on other tables may reference `table` by name (the key ledger
 * fence does), so the swap runs with legacy_alter_table on: the rename then
 * leaves those trigger bodies untouched and they resolve to the new table.
 */
export async function rebuildTableForCurrentSystemCheck(
  db: SchemaDb,
  table: string,
  createTable: () => Promise<void>,
): Promise<boolean> {
  const rows = (await db.queryAsync(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [table],
  )) as Array<{ sql?: unknown }> | undefined;
  const createSql = typeof rows?.[0]?.sql === "string" ? rows[0].sql : "";
  if (!createSql || !isSystemCheckOutdated(createSql)) return false;

  const staleTable = `${table}_stale_system_check`;
  const columnRows = (await db.queryAsync(`PRAGMA table_info(${table})`)) as
    | Array<{ name?: unknown }>
    | undefined;
  const oldColumns = (columnRows || [])
    .map((row) => (typeof row.name === "string" ? row.name : ""))
    .filter(Boolean);

  const swap = async () => {
    await db.queryAsync(`DROP TABLE IF EXISTS ${staleTable}`);
    await db.queryAsync(`PRAGMA legacy_alter_table = ON`);
    try {
      await db.queryAsync(`ALTER TABLE ${table} RENAME TO ${staleTable}`);
    } finally {
      await db.queryAsync(`PRAGMA legacy_alter_table = OFF`);
    }
    await createTable();
    const newColumnRows = (await db.queryAsync(
      `PRAGMA table_info(${table})`,
    )) as Array<{ name?: unknown }> | undefined;
    const newColumns = new Set(
      (newColumnRows || []).map((row) =>
        typeof row.name === "string" ? row.name : "",
      ),
    );
    const shared = oldColumns.filter((column) => newColumns.has(column));
    if (shared.length) {
      const list = shared.join(", ");
      await db.queryAsync(
        `INSERT INTO ${table} (${list}) SELECT ${list} FROM ${staleTable}`,
      );
    }
    await db.queryAsync(`DROP TABLE ${staleTable}`);
  };

  // Zotero transactions do not nest: inside a caller's transaction (a cold
  // startup schema pass) the swap is already atomic, so it runs inline.
  if (
    typeof db.executeTransaction === "function" &&
    !(typeof db.inTransaction === "function" && db.inTransaction())
  ) {
    await db.executeTransaction(swap);
  } else {
    await swap();
  }
  return true;
}

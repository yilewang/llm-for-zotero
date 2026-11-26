/**
 * Access to Zotero's own SQLite database, where the plugin keeps its tables.
 */

/** The parts of `Zotero.DB` the plugin uses. */
export type ZoteroDb = {
  queryAsync: (
    sql: string,
    params?: unknown[],
    options?: { debug?: boolean },
  ) => Promise<unknown>;
  executeTransaction: <T>(task: () => Promise<T>) => Promise<T>;
};

/** Zotero's database, or null where there is none (outside Zotero). */
export function getZoteroDb(): ZoteroDb | null {
  const db = (globalThis as { Zotero?: { DB?: { queryAsync?: unknown } } })
    .Zotero?.DB;
  return typeof db?.queryAsync === "function" ? (db as ZoteroDb) : null;
}

/** Whether the database has a table of this name. */
export async function tableExists(
  db: ZoteroDb,
  tableName: string,
): Promise<boolean> {
  const rows = (await db.queryAsync?.(
    `SELECT name
     FROM sqlite_master
     WHERE type = 'table'
       AND name = ?
     LIMIT 1`,
    [tableName],
  )) as Array<{ name?: unknown }> | undefined;
  return Boolean(rows?.length);
}

/**
 * Whether an error from adding a column means the column is already there,
 * which a migration that may run twice treats as success.
 */
export function isAlreadyExistingColumnError(error: unknown): boolean {
  return /duplicate column|already exists/i.test(
    String(error instanceof Error ? error.message : error || ""),
  );
}

/**
 * The query surface the agent row purge runs on: the Zotero DB inside the
 * conversation catalog's deletion transaction.
 */
export type AgentPurgeDb = {
  queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
};

/** True for the error SQLite raises on a table that was never created. */
export function isMissingTableError(error: unknown): boolean {
  return /no such table|no table/i.test(String(error));
}

/**
 * Run one delete statement of the purge, treating an absent table as no rows.
 * The agent stores are initialized lazily.  An absent table means there are no
 * rows to delete; every other failure must reach the owning transaction so
 * local catalog deletion rolls back instead of leaving a partial purge.
 */
export async function deleteIfPresent(
  db: AgentPurgeDb,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  try {
    await db.queryAsync(sql, params);
  } catch (error) {
    if (isMissingTableError(error)) return;
    throw error;
  }
}

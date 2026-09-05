import { rekeyScopedConversationKey } from "./conversationScopedKey";

type ZoteroDb = {
  queryAsync?: (sql: string, params?: unknown[]) => Promise<unknown>;
};

export const CONVERSATION_SCHEMA_MIGRATIONS_TABLE =
  "llm_for_zotero_conversation_schema_migrations";

export const CONVERSATION_ID_TRANSITION_MIGRATION_ID =
  "conversation-id-transition-v1";
export const CONVERSATION_INSTANCE_ID_MIGRATION_IDS = {
  upstream: "conversation-instance-id-v1:upstream",
  claudeCode: "conversation-instance-id-v1:claude-code",
  codex: "conversation-instance-id-v1:codex",
} as const;
export const CONVERSATION_KEY_LEDGER_MIGRATION_ID =
  "conversation-key-ledger-v1:permanent-non-reuse";

const CONVERSATION_ID_TRANSITION_DESCRIPTION =
  "Conversation history stores use canonical conversation_id with legacy numeric keys as compatibility aliases.";

function getZoteroDb(): ZoteroDb | null {
  return (
    (globalThis as typeof globalThis & { Zotero?: { DB?: ZoteroDb } }).Zotero
      ?.DB || null
  );
}

function normalizeMigrationID(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 160) : "";
}

function normalizeMigrationDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, 512) : null;
}

/**
 * Move a legacy catalog row onto its new numeric key.
 *
 * Both runtime catalogs store a `scoped_conversation_key` whose leading token
 * is the conversation key (see ./conversationScopedKey). Only that token may
 * change here: the scope tail encodes the profile signature, library id, and
 * paper item id, and those digits frequently repeat the conversation key. The
 * value is therefore recomputed in TypeScript rather than patched with SQL
 * `REPLACE()`, which rewrites every occurrence.
 *
 * `conversation_key` is `INTEGER PRIMARY KEY` in both catalogs, so this touches
 * exactly one row. Intended to run inside the caller's migration transaction.
 */
export async function rekeyConversationCatalogKeyInTransaction(params: {
  table: string;
  legacyKey: number;
  targetKey: number;
}): Promise<void> {
  const db = getZoteroDb();
  const table = String(params.table || "").replace(/[^A-Za-z0-9_]/g, "");
  const legacyKey = Math.floor(Number(params.legacyKey));
  const targetKey = Math.floor(Number(params.targetKey));
  if (
    !db?.queryAsync ||
    !table ||
    !Number.isFinite(legacyKey) ||
    !Number.isFinite(targetKey) ||
    legacyKey <= 0 ||
    targetKey <= 0 ||
    legacyKey === targetKey
  )
    return;
  let storedScopedKey: string | null = null;
  try {
    const rows = (await db.queryAsync(
      `SELECT scoped_conversation_key AS scopedConversationKey
       FROM ${table}
       WHERE conversation_key = ?`,
      [legacyKey],
    )) as Array<{ scopedConversationKey?: unknown }> | undefined;
    const stored = rows?.[0]?.scopedConversationKey;
    storedScopedKey = typeof stored === "string" ? stored : null;
  } catch (error) {
    if (!/no such column|unknown column/i.test(String(error))) throw error;
    // Catalogs predating the scoped-key column still need their numeric key
    // moved; there is simply no scope binding to carry across.
    await db.queryAsync(
      `UPDATE ${table} SET conversation_key = ? WHERE conversation_key = ?`,
      [targetKey, legacyKey],
    );
    return;
  }
  await db.queryAsync(
    `UPDATE ${table}
       SET conversation_key = ?,
           scoped_conversation_key = ?
     WHERE conversation_key = ?`,
    [
      targetKey,
      rekeyScopedConversationKey(storedScopedKey, legacyKey, targetKey),
      legacyKey,
    ],
  );
}

/**
 * Move every conversation-owned numeric-key witness when a legacy catalog row
 * is rekeyed.  Older migrations moved only catalog/messages, leaving agent
 * state, attachments, traces, and search rows orphaned under the old key.
 * This helper is DML-only and is intended to run inside the caller's owning
 * migration transaction; absent optional stores are ignored so startup can
 * precede deferred agent-store initialization.
 */
export async function rekeyConversationOwnedRowsInTransaction(
  legacyKey: number,
  targetKey: number,
): Promise<void> {
  const db = getZoteroDb();
  if (
    !db?.queryAsync ||
    legacyKey <= 0 ||
    targetKey <= 0 ||
    legacyKey === targetKey
  )
    return;
  const updates: Array<[string, string]> = [
    ["llm_for_zotero_conversation_registry", "legacy_conversation_key"],
    ["llm_for_zotero_agent_memory", "conversation_key"],
    ["llm_for_zotero_agent_transcript", "conversation_key"],
    ["llm_for_zotero_agent_tool_result_handles", "conversation_key"],
    ["llm_for_zotero_agent_evidence", "conversation_key"],
    ["llm_for_zotero_agent_runs", "conversation_key"],
    ["llm_for_zotero_agent_coverage", "origin_conversation_key"],
    ["llm_for_zotero_attachment_refs", "owner_id"],
    ["llm_for_zotero_agent_trace_exports", "conversation_key"],
    ["llm_for_zotero_agent_trace_file_cleanup", "conversation_key"],
    ["llm_for_zotero_conversation_search_index", "legacy_conversation_key"],
    ["llm_for_zotero_conversation_cleanup_jobs", "conversation_key"],
    ["llm_for_zotero_pending_deletions", "conversation_key"],
  ];
  for (const [table, column] of updates) {
    const predicate =
      table === "llm_for_zotero_attachment_refs"
        ? `owner_type = 'conversation' AND ${column} = ?`
        : `${column} = ?`;
    try {
      await db.queryAsync(
        `UPDATE ${table} SET ${column} = ? WHERE ${predicate}`,
        [targetKey, legacyKey],
      );
    } catch (error) {
      if (/no such table|no table/i.test(String(error))) continue;
      throw error;
    }
  }
  try {
    await db.queryAsync(
      `UPDATE llm_for_zotero_conversation_fork_links
       SET source_conversation_key = CASE WHEN source_conversation_key = ? THEN ? ELSE source_conversation_key END,
           target_conversation_key = CASE WHEN target_conversation_key = ? THEN ? ELSE target_conversation_key END
       WHERE source_conversation_key = ? OR target_conversation_key = ?`,
      [legacyKey, targetKey, legacyKey, targetKey, legacyKey, legacyKey],
    );
  } catch (error) {
    if (!/no such table|no table/i.test(String(error))) throw error;
  }
  try {
    // IDs generated by the conversation registry end in a `:legacy-<key>`
    // segment (buildConversationID). Keep provenance rows deletable by the new
    // catalog identity when a legacy key is remapped.
    //
    // The match must cover the COMPLETE final segment. `legacy-12` is a prefix
    // of `legacy-123`, so an unanchored `LIKE '%legacy-12%'` also selects an
    // unrelated conversation's row, and a substring REPLACE then rewrites it to
    // `legacy-<target>3` — a syntactically valid identity that disagrees with
    // the numeric key column beside it. Anchor to the end of the string and
    // rebuild by length instead, and rewrite each column only when that column
    // is the one that matched.
    const legacySuffix = `:legacy-${legacyKey}`;
    const targetSuffix = `:legacy-${targetKey}`;
    const legacySuffixPattern = `%${legacySuffix}`;
    await db.queryAsync(
      `UPDATE llm_for_zotero_conversation_fork_links
       SET source_conversation_id =
             CASE WHEN source_conversation_id LIKE ?
                  THEN substr(source_conversation_id, 1,
                              length(source_conversation_id) - ?) || ?
                  ELSE source_conversation_id END,
           target_conversation_id =
             CASE WHEN target_conversation_id LIKE ?
                  THEN substr(target_conversation_id, 1,
                              length(target_conversation_id) - ?) || ?
                  ELSE target_conversation_id END
       WHERE source_conversation_id LIKE ? OR target_conversation_id LIKE ?`,
      [
        legacySuffixPattern,
        legacySuffix.length,
        targetSuffix,
        legacySuffixPattern,
        legacySuffix.length,
        targetSuffix,
        legacySuffixPattern,
        legacySuffixPattern,
      ],
    );
  } catch (error) {
    if (
      !/no such table|no table|no such column|unknown column/i.test(
        String(error),
      )
    )
      throw error;
  }
}

export async function initConversationSchemaMigrationLedger(): Promise<boolean> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return false;
  await db.queryAsync(
    `CREATE TABLE IF NOT EXISTS ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE} (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      description TEXT
    )`,
  );
  return true;
}

export async function hasConversationSchemaMigration(
  migrationID: string,
): Promise<boolean> {
  const id = normalizeMigrationID(migrationID);
  if (!id) return false;
  const initialized = await initConversationSchemaMigrationLedger();
  if (!initialized) return false;
  const db = getZoteroDb();
  const rows = (await db?.queryAsync?.(
    `SELECT id
     FROM ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE}
     WHERE id = ?
     LIMIT 1`,
    [id],
  )) as Array<{ id?: unknown }> | undefined;
  return Boolean(rows?.length);
}

export async function markConversationSchemaMigrationApplied(
  migrationID: string,
  description?: string,
): Promise<boolean> {
  const id = normalizeMigrationID(migrationID);
  if (!id) return false;
  const initialized = await initConversationSchemaMigrationLedger();
  if (!initialized) return false;
  const db = getZoteroDb();
  if (!db?.queryAsync) return false;
  await db.queryAsync(
    `INSERT INTO ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE}
      (id, applied_at, description)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       description = COALESCE(excluded.description, ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE}.description)`,
    [id, Date.now(), normalizeMigrationDescription(description)],
  );
  return true;
}

export async function runConversationSchemaMigrationOnce(
  migrationID: string,
  description: string,
  migrate: () => Promise<void> | void,
): Promise<boolean> {
  const id = normalizeMigrationID(migrationID);
  if (!id) return false;
  const initialized = await initConversationSchemaMigrationLedger();
  if (!initialized) return false;
  if (await hasConversationSchemaMigration(id)) return false;
  await migrate();
  await markConversationSchemaMigrationApplied(id, description);
  return true;
}

export async function markConversationIDTransitionMigrationApplied(): Promise<boolean> {
  return markConversationSchemaMigrationApplied(
    CONVERSATION_ID_TRANSITION_MIGRATION_ID,
    CONVERSATION_ID_TRANSITION_DESCRIPTION,
  );
}

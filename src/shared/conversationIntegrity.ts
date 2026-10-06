import type { ConversationSystem } from "./types";
import {
  CONVERSATION_CATALOG_TABLES,
  CONVERSATION_STORE_TABLES,
} from "./conversationStore/storeTables";

type ZoteroDb = {
  queryAsync?: (sql: string, params?: unknown[]) => Promise<unknown>;
};

export type ConversationIntegrityIssueCode =
  | "registry_blank_conversation_id"
  | "registry_invalid_scope"
  | "catalog_blank_conversation_id"
  | "catalog_missing_registry_row"
  | "catalog_summary_first_user_title_mismatch"
  | "catalog_summary_last_activity_mismatch"
  | "catalog_summary_user_turn_count_mismatch"
  | "message_blank_conversation_id"
  | "message_missing_catalog_row";

export type ConversationIntegrityIssue = {
  code: ConversationIntegrityIssueCode;
  tableName: string;
  system?: ConversationSystem;
  rowCount: number;
};

export type ConversationIntegrityReport = {
  ok: boolean;
  issues: ConversationIntegrityIssue[];
};

const CONVERSATION_REGISTRY_TABLE = "llm_for_zotero_conversation_registry";

/** Every messages table, in store order, with the catalogs its rows belong to. */
const MESSAGE_TABLES: Array<{
  system: ConversationSystem;
  messageTable: string;
  catalogTables: string[];
}> = CONVERSATION_STORE_TABLES.map((store) => ({
  system: store.system,
  messageTable: store.messageTable,
  catalogTables: Array.from(
    new Set([store.catalogTables.global, store.catalogTables.paper]),
  ),
}));

/**
 * Every catalog, in store order, with the activity fallback its summary uses:
 * a runtime catalog falls back to updated_at, an upstream one has only
 * created_at.
 */
const SUMMARY_TABLES: Array<{
  system: ConversationSystem;
  catalogTable: string;
  messageTable: string;
  activityFallbackSql: string;
}> = CONVERSATION_CATALOG_TABLES.map((catalog) => ({
  system: catalog.system,
  catalogTable: catalog.catalogTable,
  messageTable: catalog.messageTable,
  activityFallbackSql:
    catalog.system === "upstream"
      ? "c.created_at"
      : "c.updated_at, c.created_at",
}));

function getZoteroDb(): ZoteroDb | null {
  return (
    (globalThis as typeof globalThis & { Zotero?: { DB?: ZoteroDb } }).Zotero
      ?.DB || null
  );
}

async function tableExists(db: ZoteroDb, tableName: string): Promise<boolean> {
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

function messageJoinCondition(
  messageAlias: string,
  conversationAlias: string,
): string {
  return (
    `(${messageAlias}.conversation_id = ${conversationAlias}.conversation_id OR ((` +
    `${messageAlias}.conversation_id IS NULL OR TRIM(${messageAlias}.conversation_id) = '') AND ` +
    `${messageAlias}.conversation_key = ${conversationAlias}.conversation_key))`
  );
}

function firstUserTitleSql(messageTable: string): string {
  return `(SELECT m0.text
           FROM ${messageTable} m0
           WHERE ${messageJoinCondition("m0", "c")}
             AND m0.role = 'user'
           ORDER BY m0.timestamp ASC, m0.id ASC
           LIMIT 1)`;
}

function lastActivitySql(
  messageTable: string,
  activityFallbackSql: string,
): string {
  return `COALESCE(
           (
             SELECT MAX(m.timestamp)
             FROM ${messageTable} m
             WHERE ${messageJoinCondition("m", "c")}
           ),
           ${activityFallbackSql}
         )`;
}

function userTurnCountSql(messageTable: string): string {
  return `COALESCE(
           (
             SELECT SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END)
             FROM ${messageTable} m
             WHERE ${messageJoinCondition("m", "c")}
           ),
           0
         )`;
}

async function countRows(
  db: ZoteroDb,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const rows = (await db.queryAsync?.(sql, params)) as
    | Array<{ rowCount?: unknown }>
    | undefined;
  const rowCount = Number(rows?.[0]?.rowCount);
  return Number.isFinite(rowCount) ? Math.max(0, Math.floor(rowCount)) : 0;
}

function addIssue(
  issues: ConversationIntegrityIssue[],
  issue: ConversationIntegrityIssue,
): void {
  if (issue.rowCount <= 0) return;
  issues.push(issue);
}

export async function auditConversationIntegrity(): Promise<ConversationIntegrityReport> {
  const db = getZoteroDb();
  if (!db?.queryAsync) {
    return { ok: true, issues: [] };
  }

  const issues: ConversationIntegrityIssue[] = [];
  const registryExists = await tableExists(db, CONVERSATION_REGISTRY_TABLE);

  if (registryExists) {
    addIssue(issues, {
      code: "registry_blank_conversation_id",
      tableName: CONVERSATION_REGISTRY_TABLE,
      rowCount: await countRows(
        db,
        `SELECT COUNT(*) AS rowCount
         FROM ${CONVERSATION_REGISTRY_TABLE}
         WHERE conversation_id IS NULL
            OR TRIM(conversation_id) = ''`,
      ),
    });
    addIssue(issues, {
      code: "registry_invalid_scope",
      tableName: CONVERSATION_REGISTRY_TABLE,
      rowCount: await countRows(
        db,
        `SELECT COUNT(*) AS rowCount
         FROM ${CONVERSATION_REGISTRY_TABLE}
         WHERE valid = 0`,
      ),
    });
  }

  for (const store of CONVERSATION_CATALOG_TABLES) {
    const catalogExists = await tableExists(db, store.catalogTable);

    if (catalogExists) {
      addIssue(issues, {
        code: "catalog_blank_conversation_id",
        tableName: store.catalogTable,
        system: store.system,
        rowCount: await countRows(
          db,
          `SELECT COUNT(*) AS rowCount
           FROM ${store.catalogTable}
           WHERE conversation_id IS NULL
              OR TRIM(conversation_id) = ''`,
        ),
      });

      if (registryExists) {
        addIssue(issues, {
          code: "catalog_missing_registry_row",
          tableName: store.catalogTable,
          system: store.system,
          rowCount: await countRows(
            db,
            `SELECT COUNT(*) AS rowCount
             FROM ${store.catalogTable} c
             LEFT JOIN ${CONVERSATION_REGISTRY_TABLE} r
               ON r.conversation_id = c.conversation_id
             WHERE c.conversation_id IS NOT NULL
               AND TRIM(c.conversation_id) <> ''
               AND r.conversation_id IS NULL`,
          ),
        });
      }
    }
  }

  for (const store of SUMMARY_TABLES) {
    const catalogExists = await tableExists(db, store.catalogTable);
    const messageExists = await tableExists(db, store.messageTable);
    if (!catalogExists || !messageExists) continue;
    addIssue(issues, {
      code: "catalog_summary_first_user_title_mismatch",
      tableName: store.catalogTable,
      system: store.system,
      rowCount: await countRows(
        db,
        `SELECT COUNT(*) AS rowCount
         FROM ${store.catalogTable} c
         WHERE COALESCE(c.first_user_title, '') <> COALESCE(${firstUserTitleSql(
           store.messageTable,
         )}, '')`,
      ),
    });
    addIssue(issues, {
      code: "catalog_summary_last_activity_mismatch",
      tableName: store.catalogTable,
      system: store.system,
      rowCount: await countRows(
        db,
        `SELECT COUNT(*) AS rowCount
         FROM ${store.catalogTable} c
         WHERE COALESCE(c.last_activity_at, 0) <> COALESCE(${lastActivitySql(
           store.messageTable,
           store.activityFallbackSql,
         )}, 0)`,
      ),
    });
    addIssue(issues, {
      code: "catalog_summary_user_turn_count_mismatch",
      tableName: store.catalogTable,
      system: store.system,
      rowCount: await countRows(
        db,
        `SELECT COUNT(*) AS rowCount
         FROM ${store.catalogTable} c
         WHERE COALESCE(c.user_turn_count, 0) <> ${userTurnCountSql(
           store.messageTable,
         )}`,
      ),
    });
  }

  for (const store of MESSAGE_TABLES) {
    const messageExists = await tableExists(db, store.messageTable);
    if (!messageExists) continue;

    addIssue(issues, {
      code: "message_blank_conversation_id",
      tableName: store.messageTable,
      system: store.system,
      rowCount: await countRows(
        db,
        `SELECT COUNT(*) AS rowCount
         FROM ${store.messageTable}
         WHERE conversation_id IS NULL
            OR TRIM(conversation_id) = ''`,
      ),
    });

    const existingCatalogs = [];
    for (const catalogTable of store.catalogTables) {
      if (await tableExists(db, catalogTable))
        existingCatalogs.push(catalogTable);
    }
    if (existingCatalogs.length) {
      const joins = existingCatalogs
        .map(
          (catalogTable, index) =>
            `LEFT JOIN ${catalogTable} c${index}
             ON c${index}.conversation_id = m.conversation_id`,
        )
        .join("\n");
      const missingPredicates = existingCatalogs
        .map((_, index) => `c${index}.conversation_id IS NULL`)
        .join("\n               AND ");
      addIssue(issues, {
        code: "message_missing_catalog_row",
        tableName: store.messageTable,
        system: store.system,
        rowCount: await countRows(
          db,
          `SELECT COUNT(*) AS rowCount
           FROM ${store.messageTable} m
           ${joins}
           WHERE m.conversation_id IS NOT NULL
             AND TRIM(m.conversation_id) <> ''
             AND ${missingPredicates}`,
        ),
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

export async function repairConversationCatalogSummaries(
  system?: ConversationSystem,
): Promise<void> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return;
  for (const store of SUMMARY_TABLES) {
    if (system && store.system !== system) continue;
    const catalogExists = await tableExists(db, store.catalogTable);
    const messageExists = await tableExists(db, store.messageTable);
    if (!catalogExists || !messageExists) continue;
    await db.queryAsync(
      `UPDATE ${store.catalogTable} AS c
       SET first_user_title = ${firstUserTitleSql(store.messageTable)},
           last_activity_at = ${lastActivitySql(
             store.messageTable,
             store.activityFallbackSql,
           )},
           user_turn_count = ${userTurnCountSql(store.messageTable)}`,
    );
  }
}

import {
  CLAUDE_GLOBAL_CONVERSATION_KEY_BASE,
  CLAUDE_PAPER_CONVERSATION_KEY_BASE,
  CODEX_GLOBAL_CONVERSATION_KEY_BASE,
  CODEX_PAPER_CONVERSATION_KEY_BASE,
  RUNTIME_CONVERSATION_KEY_END,
  UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
  UPSTREAM_RUNTIME_CONVERSATION_KEY_END,
  isConversationKeyForKind,
} from "./conversationKeySpace";
import {
  buildConversationID,
  getConversationScopeValidationDetails,
  getCurrentProfileSignature,
} from "./conversationRegistry";
import type { ConversationSystem } from "./types";

type ZoteroDb = {
  queryAsync?: (sql: string, params?: unknown[]) => Promise<unknown>;
};

export const CONVERSATION_SEARCH_INDEX_TABLE =
  "llm_for_zotero_conversation_search_index";

export const CONVERSATION_SEARCH_BODY_CHAR_LIMIT = 200_000;

const SEARCH_INDEX_LIBRARY_INDEX =
  "llm_for_zotero_conversation_search_index_library_idx";
const SEARCH_INDEX_LEGACY_KEY_INDEX =
  "llm_for_zotero_conversation_search_index_legacy_key_idx";

const MESSAGE_JOIN_CONDITION =
  "(m.conversation_key = c.conversation_key OR m.conversation_id = c.conversation_id)";

const FIRST_USER_MESSAGE_SQL = `(SELECT m0.text
  FROM {messageTable} m0
  WHERE (m0.conversation_key = c.conversation_key OR m0.conversation_id = c.conversation_id)
    AND m0.role = 'user'
  ORDER BY m0.timestamp ASC, m0.id ASC
  LIMIT 1)`;

export type ConversationSearchIndexMatch = {
  conversationID: string;
  conversationKey: number;
  system: ConversationSystem;
  kind: "global" | "paper";
  libraryID: number;
  paperItemID?: number;
  title: string;
  bodyText: string;
  lastActivityAt: number;
  userTurnCount: number;
  bodyTruncated?: boolean;
};

export type ConversationSearchIndexStatus =
  | "ready"
  | "empty"
  | "stale"
  | "truncated"
  | "unavailable";

export type ConversationSearchIndexResult = {
  matches: ConversationSearchIndexMatch[];
  status: ConversationSearchIndexStatus;
  indexedRowCount: number;
  catalogRowCount: number;
  staleIndexedRowCount: number;
  truncatedRowCount: number;
};

function getZoteroDb(): ZoteroDb | null {
  return (
    (globalThis as typeof globalThis & { Zotero?: { DB?: ZoteroDb } }).Zotero
      ?.DB || null
  );
}

function normalizePositiveInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function normalizeText(value: unknown, maxLength = 2_000_000): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeSystem(value: unknown): ConversationSystem | null {
  return value === "upstream" || value === "claude_code" || value === "codex"
    ? value
    : null;
}

function normalizeKind(value: unknown): "global" | "paper" | null {
  return value === "global" || value === "paper" ? value : null;
}

function normalizeOptionalLimit(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.min(500, Math.floor(parsed)));
}

function normalizeSearchQuery(value: unknown): string {
  return normalizeText(value, 512).replace(/\s+/g, " ").toLocaleLowerCase();
}

function tokenizeSearchQuery(value: unknown): string[] {
  const normalized = normalizeSearchQuery(value);
  if (!normalized) return [];
  return Array.from(
    new Set(
      normalized
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  );
}

function escapeLikeToken(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

type ParsedCanonicalConversationID = {
  profileSignature: string;
  system: ConversationSystem;
  kind: "global" | "paper";
  libraryID: number;
  paperItemID: number;
  conversationKey: number;
};

function parseCanonicalConversationID(
  conversationID: string,
): ParsedCanonicalConversationID | null {
  const match =
    /^lfz:([^:]+):(upstream|claude_code|codex):(global|paper):lib-(\d+):paper-(\d+):legacy-(\d+)$/.exec(
      conversationID,
    );
  if (!match) return null;
  const [
    ,
    profileSignature,
    system,
    kind,
    libraryID,
    paperItemID,
    conversationKey,
  ] = match;
  return {
    profileSignature,
    system: system as ConversationSystem,
    kind: kind as "global" | "paper",
    libraryID: Number(libraryID),
    paperItemID: Number(paperItemID),
    conversationKey: Number(conversationKey),
  };
}

function canonicalConversationIDConflictsWithScope(params: {
  conversationID: string;
  system: ConversationSystem;
  kind: "global" | "paper";
  libraryID: number;
  paperItemID?: number;
  conversationKey: number;
}): boolean {
  const parsed = parseCanonicalConversationID(params.conversationID);
  if (!parsed) return false;
  return (
    parsed.profileSignature !== getCurrentProfileSignature() ||
    parsed.system !== params.system ||
    parsed.kind !== params.kind ||
    parsed.libraryID !== params.libraryID ||
    parsed.paperItemID !==
      (params.kind === "paper" ? params.paperItemID || 0 : 0) ||
    parsed.conversationKey !== params.conversationKey
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

async function getTableInfo(
  db: ZoteroDb,
  tableName: string,
): Promise<Array<{ name?: unknown; pk?: unknown }>> {
  return ((await db.queryAsync?.(`PRAGMA table_info(${tableName})`)) ||
    []) as Array<{ name?: unknown; pk?: unknown }>;
}

async function dropSearchIndexCache(db: ZoteroDb): Promise<void> {
  await db.queryAsync?.(
    `DROP TABLE IF EXISTS ${CONVERSATION_SEARCH_INDEX_TABLE}`,
  );
}

async function ensureSearchIndexSchema(db: ZoteroDb): Promise<void> {
  if (!(await tableExists(db, CONVERSATION_SEARCH_INDEX_TABLE))) return;
  const columns = await getTableInfo(db, CONVERSATION_SEARCH_INDEX_TABLE);
  const searchKeyColumn = columns.find(
    (column) => column.name === "search_key",
  );
  const conversationIDColumn = columns.find(
    (column) => column.name === "conversation_id",
  );
  if (!searchKeyColumn || Number(searchKeyColumn.pk || 0) <= 0) {
    await dropSearchIndexCache(db);
    return;
  }
  if (Number(conversationIDColumn?.pk || 0) > 0) {
    await dropSearchIndexCache(db);
  }
}

export async function initConversationSearchIndexStore(): Promise<boolean> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return false;
  await ensureSearchIndexSchema(db);
  await db.queryAsync(
    `CREATE TABLE IF NOT EXISTS ${CONVERSATION_SEARCH_INDEX_TABLE} (
      search_key TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      legacy_conversation_key INTEGER NOT NULL,
      system TEXT NOT NULL CHECK(system IN ('upstream', 'claude_code', 'codex')),
      kind TEXT NOT NULL CHECK(kind IN ('global', 'paper')),
      library_id INTEGER NOT NULL,
      paper_item_id INTEGER,
      title TEXT,
      body_text TEXT NOT NULL,
      last_activity_at INTEGER NOT NULL,
      user_turn_count INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL
    )`,
  );
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS ${SEARCH_INDEX_LIBRARY_INDEX}
     ON ${CONVERSATION_SEARCH_INDEX_TABLE}
       (system, library_id, user_turn_count, last_activity_at DESC)`,
  );
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS ${SEARCH_INDEX_LEGACY_KEY_INDEX}
     ON ${CONVERSATION_SEARCH_INDEX_TABLE}
       (system, legacy_conversation_key)`,
  );
  return true;
}

async function refreshCatalogIntoSearchIndex(params: {
  system: ConversationSystem;
  catalogTable: string;
  messageTable: string;
  kindSql: string;
  paperItemIDSql: string;
  activitySql: string;
  groupBySql: string;
  validitySql?: string;
  filterSql?: string;
  filterParams?: unknown[];
}): Promise<void> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return;
  if (
    !(await tableExists(db, params.catalogTable)) ||
    !(await tableExists(db, params.messageTable))
  ) {
    return;
  }
  const firstUserMessageSql = FIRST_USER_MESSAGE_SQL.replace(
    /\{messageTable\}/g,
    params.messageTable,
  );
  await db.queryAsync(
    `INSERT OR REPLACE INTO ${CONVERSATION_SEARCH_INDEX_TABLE}
      (search_key, conversation_id, legacy_conversation_key, system, kind, library_id, paper_item_id, title, body_text, last_activity_at, user_turn_count, indexed_at)
     SELECT ? || ':' || c.conversation_key,
            c.conversation_id,
            c.conversation_key,
            ?,
            ${params.kindSql},
            c.library_id,
            ${params.paperItemIDSql},
            COALESCE(NULLIF(TRIM(c.title), ''), ${firstUserMessageSql}, ''),
            SUBSTR(COALESCE(GROUP_CONCAT(SUBSTR(m.text, 1, ?), char(10)), ''), 1, ?),
            ${params.activitySql},
            COALESCE(SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END), 0),
            ?
     FROM ${params.catalogTable} c
     LEFT JOIN ${params.messageTable} m
       ON ${MESSAGE_JOIN_CONDITION}
     WHERE c.conversation_id IS NOT NULL
       AND TRIM(c.conversation_id) <> ''
       AND c.library_id > 0
       ${params.validitySql ? `AND (${params.validitySql})` : ""}
       ${params.filterSql ? `AND (${params.filterSql})` : ""}
     GROUP BY ${params.groupBySql}`,
    [
      params.system,
      params.system,
      CONVERSATION_SEARCH_BODY_CHAR_LIMIT,
      CONVERSATION_SEARCH_BODY_CHAR_LIMIT,
      Date.now(),
      ...(params.filterParams || []),
    ],
  );
}

function buildCatalogConversationFilter(params: {
  conversationID?: string;
  conversationKey?: number;
}): { filterSql?: string; filterParams?: unknown[] } {
  const conversationID =
    typeof params.conversationID === "string"
      ? normalizeText(params.conversationID, 512)
      : "";
  if (conversationID) {
    return {
      filterSql: "c.conversation_id = ?",
      filterParams: [conversationID],
    };
  }
  const conversationKey = normalizePositiveInt(params.conversationKey);
  if (conversationKey) {
    return {
      filterSql: "c.conversation_key = ?",
      filterParams: [conversationKey],
    };
  }
  return {};
}

type SearchIndexCatalogDescriptor = {
  tableName: string;
  validitySql: string;
};

const UPSTREAM_GLOBAL_VALIDITY_SQL = [
  `c.conversation_key >= ${UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE}`,
  `c.conversation_key < ${UPSTREAM_RUNTIME_CONVERSATION_KEY_END}`,
  // Ephemeral webchat sessions never belong in history search.
  "COALESCE(c.webchat_session, 0) = 0",
].join(" AND ");

const UPSTREAM_PAPER_VALIDITY_SQL = [
  "c.conversation_key > 0",
  `c.conversation_key < ${UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE}`,
  "c.paper_item_id IS NOT NULL",
  "c.paper_item_id > 0",
  "c.session_version IS NOT NULL",
  "c.session_version > 0",
  // Ephemeral webchat sessions never belong in history search.
  "COALESCE(c.webchat_session, 0) = 0",
].join(" AND ");

const CLAUDE_VALIDITY_SQL = [
  "(",
  "  (",
  "    c.kind = 'global'",
  `    AND c.conversation_key >= ${CLAUDE_GLOBAL_CONVERSATION_KEY_BASE}`,
  `    AND c.conversation_key < ${CLAUDE_PAPER_CONVERSATION_KEY_BASE}`,
  "  )",
  "  OR",
  "  (",
  "    c.kind = 'paper'",
  `    AND c.conversation_key >= ${CLAUDE_PAPER_CONVERSATION_KEY_BASE}`,
  `    AND c.conversation_key < ${CODEX_GLOBAL_CONVERSATION_KEY_BASE}`,
  "    AND c.paper_item_id IS NOT NULL",
  "    AND c.paper_item_id > 0",
  "  )",
  ")",
].join("\n");

const CODEX_VALIDITY_SQL = [
  "(",
  "  (",
  "    c.kind = 'global'",
  `    AND c.conversation_key >= ${CODEX_GLOBAL_CONVERSATION_KEY_BASE}`,
  `    AND c.conversation_key < ${CODEX_PAPER_CONVERSATION_KEY_BASE}`,
  "  )",
  "  OR",
  "  (",
  "    c.kind = 'paper'",
  `    AND c.conversation_key >= ${CODEX_PAPER_CONVERSATION_KEY_BASE}`,
  `    AND c.conversation_key < ${RUNTIME_CONVERSATION_KEY_END}`,
  "    AND c.paper_item_id IS NOT NULL",
  "    AND c.paper_item_id > 0",
  "  )",
  ")",
].join("\n");

function getCoverageCatalogDescriptors(
  system: ConversationSystem,
): SearchIndexCatalogDescriptor[] {
  if (system === "upstream") {
    return [
      {
        tableName: "llm_for_zotero_global_conversations",
        validitySql: UPSTREAM_GLOBAL_VALIDITY_SQL,
      },
      {
        tableName: "llm_for_zotero_paper_conversations",
        validitySql: UPSTREAM_PAPER_VALIDITY_SQL,
      },
    ];
  }
  if (system === "claude_code") {
    return [
      {
        tableName: "llm_for_zotero_claude_conversations",
        validitySql: CLAUDE_VALIDITY_SQL,
      },
    ];
  }
  return [
    {
      tableName: "llm_for_zotero_codex_conversations",
      validitySql: CODEX_VALIDITY_SQL,
    },
  ];
}

async function getExistingCatalogDescriptors(
  db: ZoteroDb,
  system: ConversationSystem,
): Promise<SearchIndexCatalogDescriptor[]> {
  const existingCatalogs: SearchIndexCatalogDescriptor[] = [];
  for (const catalog of getCoverageCatalogDescriptors(system)) {
    if (await tableExists(db, catalog.tableName))
      existingCatalogs.push(catalog);
  }
  return existingCatalogs;
}

function buildLiveCatalogUnionSql(
  catalogs: SearchIndexCatalogDescriptor[],
  params: { libraryScoped: boolean; requireUserTurns: boolean },
): string {
  return catalogs
    .map(
      (catalog) =>
        `SELECT c.conversation_key AS conversation_key,
                c.library_id AS library_id
         FROM ${catalog.tableName} c
         WHERE ${params.libraryScoped ? "c.library_id = ?" : "c.library_id > 0"}
           AND c.conversation_id IS NOT NULL
           AND TRIM(c.conversation_id) <> ''
           ${params.requireUserTurns ? "AND COALESCE(c.user_turn_count, 0) > 0" : ""}
           AND (${catalog.validitySql})`,
    )
    .join("\nUNION ALL\n");
}

async function getLiveCatalogSearchFilter(params: {
  db: ZoteroDb;
  system: ConversationSystem;
  libraryID: number;
  indexAlias: string;
}): Promise<{ sql: string; params: unknown[] } | null> {
  const existingCatalogs = await getExistingCatalogDescriptors(
    params.db,
    params.system,
  );
  if (!existingCatalogs.length) return null;
  const catalogUnion = buildLiveCatalogUnionSql(existingCatalogs, {
    libraryScoped: true,
    requireUserTurns: true,
  });
  return {
    sql: `EXISTS (
         SELECT 1
         FROM (${catalogUnion}) live_catalog
         WHERE live_catalog.conversation_key = ${params.indexAlias}.legacy_conversation_key
           AND live_catalog.library_id = ${params.indexAlias}.library_id
       )`,
    params: existingCatalogs.map(() => params.libraryID),
  };
}

async function pruneStaleSearchRows(params: {
  system: ConversationSystem;
  catalogs: SearchIndexCatalogDescriptor[];
}): Promise<void> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return;
  const existingCatalogs: SearchIndexCatalogDescriptor[] = [];
  for (const catalog of params.catalogs) {
    if (await tableExists(db, catalog.tableName))
      existingCatalogs.push(catalog);
  }
  if (!existingCatalogs.length) {
    await db.queryAsync(
      `DELETE FROM ${CONVERSATION_SEARCH_INDEX_TABLE}
       WHERE system = ?`,
      [params.system],
    );
    return;
  }
  const keepSql = buildLiveCatalogUnionSql(existingCatalogs, {
    libraryScoped: false,
    requireUserTurns: false,
  });
  await db.queryAsync(
    `DELETE FROM ${CONVERSATION_SEARCH_INDEX_TABLE}
     WHERE system = ?
       AND NOT EXISTS (
         SELECT 1
         FROM (${keepSql}) live_catalog
         WHERE live_catalog.conversation_key = ${CONVERSATION_SEARCH_INDEX_TABLE}.legacy_conversation_key
           AND live_catalog.library_id = ${CONVERSATION_SEARCH_INDEX_TABLE}.library_id
       )`,
    [params.system],
  );
}

export async function refreshConversationSearchIndexForSystem(
  system: ConversationSystem,
): Promise<boolean> {
  const initialized = await initConversationSearchIndexStore();
  if (!initialized) return false;
  if (system === "upstream") {
    await refreshCatalogIntoSearchIndex({
      system,
      catalogTable: "llm_for_zotero_global_conversations",
      messageTable: "llm_for_zotero_chat_messages",
      kindSql: "'global'",
      paperItemIDSql: "NULL",
      activitySql: "COALESCE(MAX(m.timestamp), c.created_at)",
      groupBySql:
        "c.conversation_id, c.conversation_key, c.library_id, c.created_at, c.title",
      validitySql: UPSTREAM_GLOBAL_VALIDITY_SQL,
    });
    await refreshCatalogIntoSearchIndex({
      system,
      catalogTable: "llm_for_zotero_paper_conversations",
      messageTable: "llm_for_zotero_chat_messages",
      kindSql: "'paper'",
      paperItemIDSql: "c.paper_item_id",
      activitySql: "COALESCE(MAX(m.timestamp), c.created_at)",
      groupBySql:
        "c.conversation_id, c.conversation_key, c.library_id, c.paper_item_id, c.created_at, c.title",
      validitySql: UPSTREAM_PAPER_VALIDITY_SQL,
    });
    await pruneStaleSearchRows({
      system,
      catalogs: getCoverageCatalogDescriptors(system),
    });
    return true;
  }
  const catalogTable =
    system === "claude_code"
      ? "llm_for_zotero_claude_conversations"
      : "llm_for_zotero_codex_conversations";
  const messageTable =
    system === "claude_code"
      ? "llm_for_zotero_claude_messages"
      : "llm_for_zotero_codex_messages";
  await refreshCatalogIntoSearchIndex({
    system,
    catalogTable,
    messageTable,
    kindSql: "c.kind",
    paperItemIDSql: "c.paper_item_id",
    activitySql: "COALESCE(MAX(m.timestamp), c.updated_at, c.created_at)",
    groupBySql:
      "c.conversation_id, c.conversation_key, c.library_id, c.kind, c.paper_item_id, c.created_at, c.updated_at, c.title",
    validitySql:
      system === "claude_code" ? CLAUDE_VALIDITY_SQL : CODEX_VALIDITY_SQL,
  });
  await pruneStaleSearchRows({
    system,
    catalogs: getCoverageCatalogDescriptors(system),
  });
  return true;
}

export async function refreshConversationSearchIndexForConversation(params: {
  system: ConversationSystem;
  conversationID?: string;
  conversationKey?: number;
}): Promise<boolean> {
  const system = normalizeSystem(params.system);
  if (!system) return false;
  const filter = buildCatalogConversationFilter(params);
  if (!filter.filterSql) return false;
  const initialized = await initConversationSearchIndexStore();
  if (!initialized) return false;
  if (system === "upstream") {
    await refreshCatalogIntoSearchIndex({
      system,
      catalogTable: "llm_for_zotero_global_conversations",
      messageTable: "llm_for_zotero_chat_messages",
      kindSql: "'global'",
      paperItemIDSql: "NULL",
      activitySql: "COALESCE(MAX(m.timestamp), c.created_at)",
      groupBySql:
        "c.conversation_id, c.conversation_key, c.library_id, c.created_at, c.title",
      validitySql: UPSTREAM_GLOBAL_VALIDITY_SQL,
      ...filter,
    });
    await refreshCatalogIntoSearchIndex({
      system,
      catalogTable: "llm_for_zotero_paper_conversations",
      messageTable: "llm_for_zotero_chat_messages",
      kindSql: "'paper'",
      paperItemIDSql: "c.paper_item_id",
      activitySql: "COALESCE(MAX(m.timestamp), c.created_at)",
      groupBySql:
        "c.conversation_id, c.conversation_key, c.library_id, c.paper_item_id, c.created_at, c.title",
      validitySql: UPSTREAM_PAPER_VALIDITY_SQL,
      ...filter,
    });
    return true;
  }
  const catalogTable =
    system === "claude_code"
      ? "llm_for_zotero_claude_conversations"
      : "llm_for_zotero_codex_conversations";
  const messageTable =
    system === "claude_code"
      ? "llm_for_zotero_claude_messages"
      : "llm_for_zotero_codex_messages";
  await refreshCatalogIntoSearchIndex({
    system,
    catalogTable,
    messageTable,
    kindSql: "c.kind",
    paperItemIDSql: "c.paper_item_id",
    activitySql: "COALESCE(MAX(m.timestamp), c.updated_at, c.created_at)",
    groupBySql:
      "c.conversation_id, c.conversation_key, c.library_id, c.kind, c.paper_item_id, c.created_at, c.updated_at, c.title",
    validitySql:
      system === "claude_code" ? CLAUDE_VALIDITY_SQL : CODEX_VALIDITY_SQL,
    ...filter,
  });
  return true;
}

export async function deleteConversationSearchIndexRowInTransaction(params: {
  conversationID?: string;
  system?: ConversationSystem;
  conversationKey?: number;
}): Promise<boolean> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return false;
  const conversationID =
    typeof params.conversationID === "string"
      ? normalizeText(params.conversationID, 512)
      : "";
  if (conversationID) {
    await db.queryAsync(
      `DELETE FROM ${CONVERSATION_SEARCH_INDEX_TABLE}
       WHERE conversation_id = ?`,
      [conversationID],
    );
    return true;
  }
  const system = normalizeSystem(params.system);
  const conversationKey = normalizePositiveInt(params.conversationKey);
  if (!conversationKey) return false;
  if (system) {
    await db.queryAsync(
      `DELETE FROM ${CONVERSATION_SEARCH_INDEX_TABLE}
       WHERE system = ?
         AND legacy_conversation_key = ?`,
      [system, conversationKey],
    );
    return true;
  }
  await db.queryAsync(
    `DELETE FROM ${CONVERSATION_SEARCH_INDEX_TABLE}
     WHERE legacy_conversation_key = ?`,
    [conversationKey],
  );
  return true;
}

/**
 * Delete a search-index row outside a caller-owned transaction.
 *
 * Schema initialization is intentionally kept here. Destructive conversation
 * transactions must call `deleteConversationSearchIndexRowInTransaction`
 * instead after initializing the index, so a DDL statement can never be
 * nested inside the atomic local deletion.
 */
export async function deleteConversationSearchIndexRow(params: {
  conversationID?: string;
  system?: ConversationSystem;
  conversationKey?: number;
}): Promise<boolean> {
  const initialized = await initConversationSearchIndexStore();
  if (!initialized) return false;
  return deleteConversationSearchIndexRowInTransaction(params);
}

export async function refreshConversationSearchIndex(): Promise<boolean> {
  const initialized = await initConversationSearchIndexStore();
  if (!initialized) return false;
  await refreshConversationSearchIndexForSystem("upstream");
  await refreshConversationSearchIndexForSystem("claude_code");
  await refreshConversationSearchIndexForSystem("codex");
  return true;
}

async function getIndexedSearchCoverage(params: {
  system: ConversationSystem;
  libraryID: number;
}): Promise<{
  indexedRowCount: number;
  catalogRowCount: number;
  missingIndexedRowCount: number;
  staleIndexedRowCount: number;
  truncatedRowCount: number;
}> {
  const db = getZoteroDb();
  if (!db?.queryAsync) {
    return {
      indexedRowCount: 0,
      catalogRowCount: 0,
      missingIndexedRowCount: 0,
      staleIndexedRowCount: 0,
      truncatedRowCount: 0,
    };
  }
  const indexedRows = (await db.queryAsync(
    `SELECT COUNT(*) AS indexedRowCount,
            SUM(CASE WHEN LENGTH(COALESCE(body_text, '')) >= ? THEN 1 ELSE 0 END) AS truncatedRowCount
     FROM ${CONVERSATION_SEARCH_INDEX_TABLE}
     WHERE system = ?
       AND library_id = ?
       AND user_turn_count > 0`,
    [CONVERSATION_SEARCH_BODY_CHAR_LIMIT, params.system, params.libraryID],
  )) as
    | Array<{
        indexedRowCount?: unknown;
        truncatedRowCount?: unknown;
      }>
    | undefined;
  const indexedRowCount = normalizePositiveInt(
    indexedRows?.[0]?.indexedRowCount,
  );
  const truncatedRowCount = normalizePositiveInt(
    indexedRows?.[0]?.truncatedRowCount,
  );

  const existingCatalogs = await getExistingCatalogDescriptors(
    db,
    params.system,
  );
  if (!existingCatalogs.length) {
    return {
      indexedRowCount,
      catalogRowCount: 0,
      missingIndexedRowCount: 0,
      staleIndexedRowCount: indexedRowCount,
      truncatedRowCount,
    };
  }
  const catalogUnion = buildLiveCatalogUnionSql(existingCatalogs, {
    libraryScoped: true,
    requireUserTurns: true,
  });
  const catalogParams = existingCatalogs.map(() => params.libraryID);
  const catalogRows = (await db.queryAsync(
    `SELECT COUNT(*) AS catalogRowCount,
            SUM(CASE WHEN si.search_key IS NULL THEN 1 ELSE 0 END) AS missingIndexedRowCount
     FROM (${catalogUnion}) c
     LEFT JOIN ${CONVERSATION_SEARCH_INDEX_TABLE} si
       ON si.legacy_conversation_key = c.conversation_key
      AND si.library_id = c.library_id
      AND si.system = ?
      AND si.user_turn_count > 0`,
    [...catalogParams, params.system],
  )) as
    | Array<{
        catalogRowCount?: unknown;
        missingIndexedRowCount?: unknown;
      }>
    | undefined;
  const staleRows = (await db.queryAsync(
    `SELECT COUNT(*) AS staleIndexedRowCount
     FROM ${CONVERSATION_SEARCH_INDEX_TABLE} si
     WHERE si.system = ?
       AND si.library_id = ?
       AND si.user_turn_count > 0
       AND NOT EXISTS (
         SELECT 1
         FROM (${catalogUnion}) live_catalog
         WHERE live_catalog.conversation_key = si.legacy_conversation_key
           AND live_catalog.library_id = si.library_id
       )`,
    [params.system, params.libraryID, ...catalogParams],
  )) as
    | Array<{
        staleIndexedRowCount?: unknown;
      }>
    | undefined;
  return {
    indexedRowCount,
    catalogRowCount: normalizePositiveInt(catalogRows?.[0]?.catalogRowCount),
    missingIndexedRowCount: normalizePositiveInt(
      catalogRows?.[0]?.missingIndexedRowCount,
    ),
    staleIndexedRowCount: normalizePositiveInt(
      staleRows?.[0]?.staleIndexedRowCount,
    ),
    truncatedRowCount,
  };
}

async function normalizeMatch(
  row: Record<string, unknown>,
): Promise<ConversationSearchIndexMatch | null> {
  const conversationID = normalizeText(row.conversationID, 512);
  const conversationKey = normalizePositiveInt(row.conversationKey);
  const system = normalizeSystem(row.system);
  const kind = normalizeKind(row.kind);
  const libraryID = normalizePositiveInt(row.libraryID);
  const paperItemID = normalizePositiveInt(row.paperItemID);
  const lastActivityAt = Number(row.lastActivityAt);
  const userTurnCount = Number(row.userTurnCount);
  const bodyTruncated = Boolean(Number(row.bodyTruncated || 0));
  if (!conversationID || !conversationKey || !system || !kind || !libraryID) {
    return null;
  }
  if (kind === "paper" && !paperItemID) return null;
  if (!isConversationKeyForKind(system, kind, conversationKey)) return null;
  if (
    canonicalConversationIDConflictsWithScope({
      conversationID,
      conversationKey,
      system,
      kind,
      libraryID,
      paperItemID,
    })
  ) {
    return null;
  }
  const validation = await getConversationScopeValidationDetails({
    conversationKey,
    system,
    kind,
    libraryID,
    paperItemID: kind === "paper" ? paperItemID : undefined,
  });
  if (!validation.valid) return null;
  const canonicalConversationID =
    validation.registered?.conversationID ||
    validation.target?.conversationID ||
    buildConversationID({
      conversationKey,
      system,
      kind,
      libraryID,
      paperItemID: kind === "paper" ? paperItemID : undefined,
    });
  return {
    conversationID: canonicalConversationID,
    conversationKey,
    system,
    kind,
    libraryID,
    paperItemID: kind === "paper" ? paperItemID : undefined,
    title: normalizeText(row.title, 512),
    bodyText: normalizeText(row.bodyText),
    lastActivityAt: Number.isFinite(lastActivityAt)
      ? Math.max(0, Math.floor(lastActivityAt))
      : 0,
    userTurnCount: Number.isFinite(userTurnCount)
      ? Math.max(0, Math.floor(userTurnCount))
      : 0,
    ...(bodyTruncated ? { bodyTruncated: true } : {}),
  };
}

async function normalizeMatches(
  rows: Array<Record<string, unknown>> | undefined,
): Promise<ConversationSearchIndexMatch[]> {
  const matches: ConversationSearchIndexMatch[] = [];
  for (const row of rows || []) {
    const normalized = await normalizeMatch(row);
    if (normalized) matches.push(normalized);
  }
  return matches;
}

export async function searchConversationIndex(params: {
  system: ConversationSystem;
  libraryID: number;
  query: string;
  limit?: number;
  refresh?: boolean;
}): Promise<ConversationSearchIndexMatch[]> {
  return (await searchConversationIndexWithStatus(params)).matches;
}

export async function searchConversationIndexWithStatus(params: {
  system: ConversationSystem;
  libraryID: number;
  query: string;
  limit?: number;
  refresh?: boolean;
}): Promise<ConversationSearchIndexResult> {
  const system = normalizeSystem(params.system);
  const libraryID = normalizePositiveInt(params.libraryID);
  const tokens = tokenizeSearchQuery(params.query);
  if (!system || !libraryID || !tokens.length) {
    return {
      matches: [],
      status: "unavailable",
      indexedRowCount: 0,
      catalogRowCount: 0,
      staleIndexedRowCount: 0,
      truncatedRowCount: 0,
    };
  }
  const initialized = await initConversationSearchIndexStore();
  if (!initialized) {
    return {
      matches: [],
      status: "unavailable",
      indexedRowCount: 0,
      catalogRowCount: 0,
      staleIndexedRowCount: 0,
      truncatedRowCount: 0,
    };
  }
  if (params.refresh === true) {
    await refreshConversationSearchIndexForSystem(system);
  }
  const db = getZoteroDb();
  if (!db?.queryAsync) {
    return {
      matches: [],
      status: "unavailable",
      indexedRowCount: 0,
      catalogRowCount: 0,
      staleIndexedRowCount: 0,
      truncatedRowCount: 0,
    };
  }
  const coverage = await getIndexedSearchCoverage({ system, libraryID });
  const tokenClauses: string[] = [];
  const queryParams: unknown[] = [system, libraryID];
  for (const token of tokens) {
    const pattern = `%${escapeLikeToken(token)}%`;
    tokenClauses.push(
      "(LOWER(COALESCE(si.title, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(si.body_text, '')) LIKE ? ESCAPE '\\' OR LOWER(CASE WHEN si.kind = 'global' THEN 'library chat' ELSE 'paper chat' END) LIKE ? ESCAPE '\\')",
    );
    queryParams.push(pattern, pattern, pattern);
  }
  const limit = normalizeOptionalLimit(params.limit);
  const tokenFilterSql = tokenClauses.join("\n        OR ");
  const liveCatalogFilter = await getLiveCatalogSearchFilter({
    db,
    system,
    libraryID,
    indexAlias: "si",
  });
  const rows = liveCatalogFilter
    ? ((await db.queryAsync(
        `SELECT si.conversation_id AS conversationID,
            si.legacy_conversation_key AS conversationKey,
            si.system,
            si.kind,
            si.library_id AS libraryID,
            si.paper_item_id AS paperItemID,
            si.title,
            si.body_text AS bodyText,
            si.last_activity_at AS lastActivityAt,
            si.user_turn_count AS userTurnCount,
            CASE WHEN LENGTH(COALESCE(si.body_text, '')) >= ? THEN 1 ELSE 0 END AS bodyTruncated
     FROM ${CONVERSATION_SEARCH_INDEX_TABLE} si
     WHERE si.system = ?
       AND si.library_id = ?
       AND si.user_turn_count > 0
       AND (${tokenFilterSql})
       AND ${liveCatalogFilter.sql}
     ORDER BY si.last_activity_at DESC, si.legacy_conversation_key DESC
     ${limit ? "LIMIT ?" : ""}`,
        [
          CONVERSATION_SEARCH_BODY_CHAR_LIMIT,
          ...queryParams,
          ...liveCatalogFilter.params,
          ...(limit ? [limit] : []),
        ],
      )) as Array<Record<string, unknown>> | undefined)
    : [];
  const matches = await normalizeMatches(rows);
  const hasMissingIndexedRows =
    coverage.catalogRowCount > coverage.indexedRowCount ||
    coverage.missingIndexedRowCount > 0;
  const hasStaleIndexedRows = coverage.staleIndexedRowCount > 0;
  const status: ConversationSearchIndexStatus =
    coverage.indexedRowCount <= 0 && coverage.catalogRowCount > 0
      ? "empty"
      : hasMissingIndexedRows || hasStaleIndexedRows
        ? "stale"
        : coverage.truncatedRowCount > 0
          ? "truncated"
          : "ready";
  return {
    matches,
    status,
    indexedRowCount: coverage.indexedRowCount,
    catalogRowCount: coverage.catalogRowCount,
    staleIndexedRowCount: coverage.staleIndexedRowCount,
    truncatedRowCount: coverage.truncatedRowCount,
  };
}

export async function loadTruncatedConversationIndexMatches(params: {
  system: ConversationSystem;
  libraryID: number;
  limit?: number;
}): Promise<ConversationSearchIndexMatch[]> {
  const system = normalizeSystem(params.system);
  const libraryID = normalizePositiveInt(params.libraryID);
  if (!system || !libraryID) return [];
  const initialized = await initConversationSearchIndexStore();
  if (!initialized) return [];
  const db = getZoteroDb();
  if (!db?.queryAsync) return [];
  const limit = normalizeOptionalLimit(params.limit);
  const liveCatalogFilter = await getLiveCatalogSearchFilter({
    db,
    system,
    libraryID,
    indexAlias: "si",
  });
  if (!liveCatalogFilter) return [];
  const queryParams: unknown[] = [
    system,
    libraryID,
    CONVERSATION_SEARCH_BODY_CHAR_LIMIT,
    ...liveCatalogFilter.params,
  ];
  if (limit) queryParams.push(limit);
  const rows = (await db.queryAsync(
    `SELECT si.conversation_id AS conversationID,
            si.legacy_conversation_key AS conversationKey,
            si.system,
            si.kind,
            si.library_id AS libraryID,
            si.paper_item_id AS paperItemID,
            si.title,
            si.body_text AS bodyText,
            si.last_activity_at AS lastActivityAt,
            si.user_turn_count AS userTurnCount,
            1 AS bodyTruncated
     FROM ${CONVERSATION_SEARCH_INDEX_TABLE} si
     WHERE si.system = ?
       AND si.library_id = ?
       AND si.user_turn_count > 0
       AND LENGTH(COALESCE(si.body_text, '')) >= ?
       AND ${liveCatalogFilter.sql}
     ORDER BY si.last_activity_at DESC, si.legacy_conversation_key DESC
     ${limit ? "LIMIT ?" : ""}`,
    queryParams,
  )) as Array<Record<string, unknown>> | undefined;
  return await normalizeMatches(rows);
}

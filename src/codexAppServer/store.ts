declare const Zotero: any;

import {
  CODEX_GLOBAL_CONVERSATION_KEY_BASE,
  RUNTIME_CONVERSATION_KEY_END,
} from "../shared/conversationKeySpace";
import { cleanupRememberedConversationKeyPrefs } from "../shared/conversationKeyPrefCleanup";
import {
  CODEX_HISTORY_LIMIT,
  buildDefaultCodexGlobalConversationKey,
  buildDefaultCodexPaperConversationKey,
  getCodexProfileSignature,
  getCodexAllocatedConversationKeyRange,
} from "./constants";
import {
  getLastAllocatedCodexGlobalConversationKey,
  getLastAllocatedCodexPaperConversationKey,
  isConversationKeyInRange,
  setLastAllocatedCodexGlobalConversationKey,
  setLastAllocatedCodexPaperConversationKey,
  setLastUsedCodexConversationMode,
  setLastUsedCodexGlobalConversationKey,
  setLastUsedCodexPaperConversationKey,
} from "./prefs";
import { CONVERSATION_INSTANCE_ID_MIGRATION_IDS } from "../shared/conversationSchemaMigrations";
import { pendingDeletionStore } from "../core/conversations/pendingDeletionStore";
import {
  normalizeCatalogTimestamp,
  normalizeConversationKey,
} from "../shared/conversationStore/keyNormalization";
import { logConversationStoreWarning } from "../shared/conversationStore/diagnostics";
import { clearPersistedAgentConversationRowsInTransaction } from "../modules/contextPanel/agentConversationCleanup";
import {
  createRuntimeConversationStore,
  ensureColumn,
} from "../services/providers/runtimeConversationStore";

/**
 * The Codex conversation store: the shared runtime store over the Codex
 * tables.  Every behaviour difference from the Claude Code store is in this
 * config (see RuntimeStoreConfig): the D1 activity SQL, the D2 turn count,
 * the D3/D4 provider columns, the D5 activity touch, the D6 misroute repair,
 * the D7 prefs cleanup and the D8 fork.  The exports keep their Codex names.
 */

const CODEX_MESSAGES_TABLE = "llm_for_zotero_codex_messages";
const CODEX_MESSAGES_INDEX = "llm_for_zotero_codex_messages_conversation_idx";
const CODEX_MESSAGES_ID_INDEX =
  "llm_for_zotero_codex_messages_conversation_id_idx";
const CODEX_CONVERSATIONS_TABLE = "llm_for_zotero_codex_conversations";
const CODEX_CONVERSATIONS_KIND_INDEX =
  "llm_for_zotero_codex_conversations_kind_idx";
const CODEX_CONVERSATIONS_ACTIVITY_INDEX =
  "llm_for_zotero_codex_conversations_activity_idx";
const CODEX_CONVERSATIONS_ID_INDEX =
  "llm_for_zotero_codex_conversations_id_idx";

const CODEX_CONVERSATION_ACTIVITY_TIMESTAMP_SQL_FOR_ALIAS_C = `MAX(
  COALESCE(c.last_activity_at, 0),
  COALESCE(c.updated_at, 0),
  COALESCE(c.created_at, 0)
)`;

const CODEX_MESSAGE_COPY_COLUMNS = [
  "role",
  "text",
  "timestamp",
  "run_mode",
  "agent_run_id",
  "document_id",
  "selected_text",
  "selected_text_contexts_json",
  "selected_texts_json",
  "selected_text_sources_json",
  "selected_text_paper_contexts_json",
  "selected_text_note_contexts_json",
  "forced_skill_ids_json",
  "paper_contexts_json",
  "pdf_paper_contexts_json",
  "full_text_paper_contexts_json",
  "citation_paper_contexts_json",
  "quote_citations_json",
  "collection_contexts_json",
  "tag_contexts_json",
  "screenshot_images",
  "attachments_json",
  "generated_images_json",
  "model_name",
  "model_entry_id",
  "model_provider_label",
  "interrupted",
  "webchat_run_state",
  "webchat_completion_reason",
  "reasoning_summary",
  "reasoning_details",
  "compact_marker",
  "context_tokens",
  "context_window",
] as const;

const CODEX_REGISTRY_REPAIR_USER_TURN_COUNT_SQL = `(
              SELECT COUNT(*)
              FROM ${CODEX_MESSAGES_TABLE} m
              WHERE (m.conversation_id = c.conversation_id OR ((m.conversation_id IS NULL OR TRIM(m.conversation_id) = '') AND m.conversation_key = c.conversation_key))
                AND m.role = 'user'
            )`;

const store = createRuntimeConversationStore({
  system: "codex",
  storeLabel: "Codex",
  startupStoreID: "codex",
  instanceIdMigrationID: CONVERSATION_INSTANCE_ID_MIGRATION_IDS.codex,
  schemaRevision: 1,
  tables: {
    messages: CODEX_MESSAGES_TABLE,
    messagesIndex: CODEX_MESSAGES_INDEX,
    messagesIdIndex: CODEX_MESSAGES_ID_INDEX,
    catalog: CODEX_CONVERSATIONS_TABLE,
    kindIndex: CODEX_CONVERSATIONS_KIND_INDEX,
    activityIndex: CODEX_CONVERSATIONS_ACTIVITY_INDEX,
    idIndex: CODEX_CONVERSATIONS_ID_INDEX,
  },
  historyLimit: CODEX_HISTORY_LIMIT,
  activityTimestampSqlForAliasC:
    CODEX_CONVERSATION_ACTIVITY_TIMESTAMP_SQL_FOR_ALIAS_C,
  extraCatalogColumns: [
    ["provider_permission_state", "provider_permission_state TEXT"],
    ["provider_session_path_state", "provider_session_path_state TEXT"],
  ],
  registryRepairUserTurnCountSql: CODEX_REGISTRY_REPAIR_USER_TURN_COUNT_SQL,
  summaryExtraColumns: [
    { sql: "c.provider_permission_state", alias: "providerPermissionState" },
  ],
  hooks: {
    afterMessageWriteInTransaction: touchCodexConversationActivity,
    beforeLegacyKeyMigration: repairMisroutedCodexConversationRows,
    afterStartupSchema: cleanupRememberedConversationKeyPrefs,
  },
  clearAgentConversationRowsInTransaction:
    clearPersistedAgentConversationRowsInTransaction,
  upsertExtraColumns: [
    {
      column: "provider_permission_state",
      param: "providerPermissionState",
    },
  ],
  profileSignature: getCodexProfileSignature,
  fork: { copyColumns: CODEX_MESSAGE_COPY_COLUMNS },
  sessionResetColumns: [
    "provider_permission_state",
    "provider_session_path_state",
  ],
  keys: {
    buildDefaultGlobalKey: buildDefaultCodexGlobalConversationKey,
    buildDefaultPaperKey: buildDefaultCodexPaperConversationKey,
    isInRange: isConversationKeyInRange,
    allocatedRange: getCodexAllocatedConversationKeyRange,
  },
  prefs: {
    getLastAllocatedGlobal: getLastAllocatedCodexGlobalConversationKey,
    getLastAllocatedPaper: getLastAllocatedCodexPaperConversationKey,
    setLastUsedMode: setLastUsedCodexConversationMode,
    setLastUsedGlobal: setLastUsedCodexGlobalConversationKey,
    setLastAllocatedGlobal: setLastAllocatedCodexGlobalConversationKey,
    setLastAllocatedPaper: setLastAllocatedCodexPaperConversationKey,
    setLastUsedPaper: setLastUsedCodexPaperConversationKey,
  },
});
const isCodexStoreConversationKey = store.isStoreConversationKey;

const CLAUDE_MESSAGES_TABLE = "llm_for_zotero_claude_messages";
const CLAUDE_CONVERSATIONS_TABLE = "llm_for_zotero_claude_conversations";

/**
 * D5: inside the write transaction, merge the activity timestamps by maximum
 * and refuse a conversation that a pending deletion has frozen.
 */
async function touchCodexConversationActivity(
  conversationKey: number,
  timestamp?: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return;
  if (pendingDeletionStore.isConversationPendingDeletion(normalizedKey)) {
    throw new Error(
      `Conversation ${normalizedKey} is frozen by a pending deletion`,
    );
  }
  const normalizedTimestamp = normalizeCatalogTimestamp(timestamp);
  await Zotero.DB.queryAsync(
    `UPDATE ${CODEX_CONVERSATIONS_TABLE}
     SET updated_at = CASE
       WHEN COALESCE(updated_at, 0) > ? THEN updated_at
       ELSE ?
     END,
         last_activity_at = CASE
       WHEN COALESCE(last_activity_at, 0) > ? THEN last_activity_at
       ELSE ?
     END
     WHERE conversation_key = ?`,
    [
      normalizedTimestamp,
      normalizedTimestamp,
      normalizedTimestamp,
      normalizedTimestamp,
      normalizedKey,
    ],
  );
}

const CONVERSATION_TRANSFER_COLUMNS = [
  "conversation_key",
  "library_id",
  "kind",
  "paper_item_id",
  "created_at",
  "updated_at",
  "title",
  "provider_session_id",
  "provider_permission_state",
  "scoped_conversation_key",
  "scope_type",
  "scope_id",
  "scope_label",
  "cwd",
  "model_name",
  "effort",
] as const;

/** The message columns a misrouted row moves with: its key, then the copy set. */
const MESSAGE_TRANSFER_COLUMNS = [
  "conversation_key",
  ...CODEX_MESSAGE_COPY_COLUMNS,
] as const;

function transferColumnSql(columns: readonly string[]): string {
  return columns.join(", ");
}

function transferSelectColumnSql(
  columns: readonly string[],
  sourceColumns: Array<{ name?: unknown }> | undefined,
): string {
  const present = new Set(
    (sourceColumns || []).map((column) => String(column?.name || "")),
  );
  return columns
    .map((column) => (present.has(column) ? column : `NULL AS ${column}`))
    .join(", ");
}

async function tableExists(tableName: string): Promise<boolean> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT name
     FROM sqlite_master
     WHERE type = 'table'
       AND name = ?
     LIMIT 1`,
    [tableName],
  )) as unknown[] | undefined;
  return Boolean(rows?.length);
}

async function countRowsForConversationKey(
  tableName: string,
  conversationKey: number,
): Promise<number> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT COUNT(*) AS rowCount
     FROM ${tableName}
     WHERE conversation_key = ?`,
    [conversationKey],
  )) as Array<{ rowCount?: unknown }> | undefined;
  const rowCount = Number(rows?.[0]?.rowCount);
  return Number.isFinite(rowCount) ? Math.max(0, Math.floor(rowCount)) : 0;
}

async function findMisroutedCodexConversationKeys(): Promise<number[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT DISTINCT conversation_key AS conversationKey
     FROM (
       SELECT conversation_key
       FROM ${CLAUDE_CONVERSATIONS_TABLE}
       WHERE conversation_key >= ?
         AND conversation_key < ?
       UNION
       SELECT conversation_key
       FROM ${CLAUDE_MESSAGES_TABLE}
       WHERE conversation_key >= ?
         AND conversation_key < ?
     )
     ORDER BY conversation_key ASC`,
    [
      CODEX_GLOBAL_CONVERSATION_KEY_BASE,
      RUNTIME_CONVERSATION_KEY_END,
      CODEX_GLOBAL_CONVERSATION_KEY_BASE,
      RUNTIME_CONVERSATION_KEY_END,
    ],
  )) as Array<{ conversationKey?: unknown }> | undefined;
  return (rows || [])
    .map((row) => normalizeConversationKey(Number(row.conversationKey)))
    .filter(
      (conversationKey): conversationKey is number =>
        conversationKey !== null &&
        isCodexStoreConversationKey(conversationKey),
    );
}

async function moveConversationRowsIfSafe(
  conversationKey: number,
): Promise<void> {
  const sourceCount = await countRowsForConversationKey(
    CLAUDE_CONVERSATIONS_TABLE,
    conversationKey,
  );
  if (sourceCount <= 0) return;
  const targetCount = await countRowsForConversationKey(
    CODEX_CONVERSATIONS_TABLE,
    conversationKey,
  );
  if (targetCount > 0) {
    logConversationStoreWarning(
      `Skipped moving Claude conversation row ${conversationKey} to Codex because Codex already has that key.`,
    );
    return;
  }
  // The Claude catalog has no Codex-only columns (provider_permission_state),
  // so select only the columns the source has and write NULL for the rest.
  const sourceColumns = (await Zotero.DB.queryAsync(
    `PRAGMA table_info(${CLAUDE_CONVERSATIONS_TABLE})`,
  )) as Array<{ name?: unknown }> | undefined;
  const columns = transferColumnSql(CONVERSATION_TRANSFER_COLUMNS);
  const selectColumns = transferSelectColumnSql(
    CONVERSATION_TRANSFER_COLUMNS,
    sourceColumns,
  );
  await Zotero.DB.queryAsync(
    `INSERT INTO ${CODEX_CONVERSATIONS_TABLE} (${columns})
     SELECT ${selectColumns}
     FROM ${CLAUDE_CONVERSATIONS_TABLE}
     WHERE conversation_key = ?`,
    [conversationKey],
  );
  await Zotero.DB.queryAsync(
    `DELETE FROM ${CLAUDE_CONVERSATIONS_TABLE}
     WHERE conversation_key = ?`,
    [conversationKey],
  );
}

async function moveMessageRowsIfSafe(conversationKey: number): Promise<void> {
  const sourceCount = await countRowsForConversationKey(
    CLAUDE_MESSAGES_TABLE,
    conversationKey,
  );
  if (sourceCount <= 0) return;
  const targetCount = await countRowsForConversationKey(
    CODEX_MESSAGES_TABLE,
    conversationKey,
  );
  if (targetCount > 0) {
    logConversationStoreWarning(
      `Skipped moving Claude message rows for ${conversationKey} to Codex because Codex already has messages for that key.`,
    );
    return;
  }
  const columns = transferColumnSql(MESSAGE_TRANSFER_COLUMNS);
  await Zotero.DB.queryAsync(
    `INSERT INTO ${CODEX_MESSAGES_TABLE} (${columns})
     SELECT ${columns}
     FROM ${CLAUDE_MESSAGES_TABLE}
     WHERE conversation_key = ?`,
    [conversationKey],
  );
  await Zotero.DB.queryAsync(
    `DELETE FROM ${CLAUDE_MESSAGES_TABLE}
     WHERE conversation_key = ?`,
    [conversationKey],
  );
}

/**
 * D6: move Codex-range rows that an older build wrote into the Claude tables.
 * Runs in Codex init before the legacy key migration, so Claude init must run
 * first.
 */
export async function repairMisroutedCodexConversationRows(): Promise<void> {
  const hasSourceTables =
    (await tableExists(CLAUDE_CONVERSATIONS_TABLE)) &&
    (await tableExists(CLAUDE_MESSAGES_TABLE));
  const hasTargetTables =
    (await tableExists(CODEX_CONVERSATIONS_TABLE)) &&
    (await tableExists(CODEX_MESSAGES_TABLE));
  if (!hasSourceTables || !hasTargetTables) return;

  await ensureColumn(
    CLAUDE_MESSAGES_TABLE,
    (await Zotero.DB.queryAsync(
      `PRAGMA table_info(${CLAUDE_MESSAGES_TABLE})`,
    )) as Array<{ name?: unknown }> | undefined,
    "forced_skill_ids_json",
    "forced_skill_ids_json TEXT",
  );
  await ensureColumn(
    CODEX_MESSAGES_TABLE,
    (await Zotero.DB.queryAsync(
      `PRAGMA table_info(${CODEX_MESSAGES_TABLE})`,
    )) as Array<{ name?: unknown }> | undefined,
    "forced_skill_ids_json",
    "forced_skill_ids_json TEXT",
  );
  await ensureColumn(
    CLAUDE_MESSAGES_TABLE,
    (await Zotero.DB.queryAsync(
      `PRAGMA table_info(${CLAUDE_MESSAGES_TABLE})`,
    )) as Array<{ name?: unknown }> | undefined,
    "selected_text_contexts_json",
    "selected_text_contexts_json TEXT",
  );
  for (const tableName of [CLAUDE_MESSAGES_TABLE, CODEX_MESSAGES_TABLE]) {
    const columns = (await Zotero.DB.queryAsync(
      `PRAGMA table_info(${tableName})`,
    )) as Array<{ name?: unknown }> | undefined;
    await ensureColumn(
      tableName,
      columns,
      "collection_contexts_json",
      "collection_contexts_json TEXT",
    );
    await ensureColumn(
      tableName,
      columns,
      "tag_contexts_json",
      "tag_contexts_json TEXT",
    );
  }
  await ensureColumn(
    CODEX_MESSAGES_TABLE,
    (await Zotero.DB.queryAsync(
      `PRAGMA table_info(${CODEX_MESSAGES_TABLE})`,
    )) as Array<{ name?: unknown }> | undefined,
    "selected_text_contexts_json",
    "selected_text_contexts_json TEXT",
  );

  const conversationKeys = await findMisroutedCodexConversationKeys();
  for (const conversationKey of conversationKeys) {
    await moveConversationRowsIfSafe(conversationKey);
    await moveMessageRowsIfSafe(conversationKey);
  }
}

export async function repairCodexConversationIdentityRegistry(
  ...args: Parameters<typeof store.repairConversationIdentityRegistry>
) {
  return store.repairConversationIdentityRegistry(...args);
}

export const CODEX_STORE_STARTUP_MIGRATION_IDS = store.startupMigrationIDs;

export async function initCodexAppServerStore(
  ...args: Parameters<typeof store.initStore>
) {
  return store.initStore(...args);
}

export const initCodexCodeStore = initCodexAppServerStore;

export async function appendCodexMessage(
  ...args: Parameters<typeof store.appendMessage>
) {
  return store.appendMessage(...args);
}

export async function forkCodexConversationMessages(
  ...args: Parameters<typeof store.forkConversationMessages>
) {
  return store.forkConversationMessages(...args);
}

export async function getLatestCodexForkableAssistantTimestamp(
  ...args: Parameters<typeof store.getLatestForkableAssistantTimestamp>
) {
  return store.getLatestForkableAssistantTimestamp(...args);
}

export async function loadCodexConversation(
  ...args: Parameters<typeof store.loadConversation>
) {
  return store.loadConversation(...args);
}

export async function clearCodexConversation(
  ...args: Parameters<typeof store.clearConversation>
) {
  return store.clearConversation(...args);
}

export async function deleteCodexTurnMessages(
  ...args: Parameters<typeof store.deleteTurnMessages>
) {
  return store.deleteTurnMessages(...args);
}

export async function pruneCodexConversation(
  ...args: Parameters<typeof store.pruneConversation>
) {
  return store.pruneConversation(...args);
}

export async function updateLatestCodexUserMessage(
  ...args: Parameters<typeof store.updateLatestUserMessage>
) {
  return store.updateLatestUserMessage(...args);
}

export async function updateLatestCodexAssistantMessage(
  ...args: Parameters<typeof store.updateLatestAssistantMessage>
) {
  return store.updateLatestAssistantMessage(...args);
}

export async function getCodexConversationSummary(
  ...args: Parameters<typeof store.getSummary>
) {
  return store.getSummary(...args);
}

export async function upsertCodexConversationSummary(
  ...args: Parameters<typeof store.upsertSummary>
) {
  return store.upsertSummary(...args);
}

export async function listCodexGlobalConversations(
  ...args: Parameters<typeof store.listGlobalConversations>
) {
  return store.listGlobalConversations(...args);
}

export async function listCodexPaperConversations(
  ...args: Parameters<typeof store.listPaperConversations>
) {
  return store.listPaperConversations(...args);
}

export async function listAllCodexPaperConversationsByLibrary(
  ...args: Parameters<typeof store.listAllPaperConversationsByLibrary>
) {
  return store.listAllPaperConversationsByLibrary(...args);
}

export async function ensureCodexGlobalConversation(
  ...args: Parameters<typeof store.ensureGlobalConversation>
) {
  return store.ensureGlobalConversation(...args);
}

export async function ensureCodexPaperConversation(
  ...args: Parameters<typeof store.ensurePaperConversation>
) {
  return store.ensurePaperConversation(...args);
}

export async function createCodexGlobalConversation(
  ...args: Parameters<typeof store.createGlobalConversation>
) {
  return store.createGlobalConversation(...args);
}

export async function createCodexPaperConversation(
  ...args: Parameters<typeof store.createPaperConversation>
) {
  return store.createPaperConversation(...args);
}

export async function touchCodexConversationTitle(
  ...args: Parameters<typeof store.touchConversationTitle>
) {
  return store.touchConversationTitle(...args);
}

export async function clearCodexConversationSessionMetadata(
  ...args: Parameters<typeof store.clearConversationSessionMetadata>
) {
  return store.clearConversationSessionMetadata(...args);
}

export async function setCodexConversationTitle(
  ...args: Parameters<typeof store.setConversationTitle>
) {
  return store.setConversationTitle(...args);
}

export async function deleteCodexConversation(
  ...args: Parameters<typeof store.deleteConversation>
) {
  return store.deleteConversation(...args);
}

export async function preflightDeleteCodexConversationLocalRows(
  ...args: Parameters<typeof store.preflightDeleteConversationLocalRows>
) {
  return store.preflightDeleteConversationLocalRows(...args);
}

export async function deleteCodexConversationLocalRows(
  ...args: Parameters<typeof store.deleteConversationLocalRows>
) {
  return store.deleteConversationLocalRows(...args);
}

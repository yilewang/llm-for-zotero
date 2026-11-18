import {
  ANTIGRAVITY_HISTORY_LIMIT,
  buildDefaultAntigravityGlobalConversationKey,
  buildDefaultAntigravityPaperConversationKey,
  getAntigravityAllocatedConversationKeyRange,
  getAntigravityProfileSignature,
  isAntigravityConversationKeyInRange,
} from "./conversationKeys";
import {
  getLastAllocatedAntigravityGlobalConversationKey,
  getLastAllocatedAntigravityPaperConversationKey,
  setLastAllocatedAntigravityGlobalConversationKey,
  setLastAllocatedAntigravityPaperConversationKey,
  setLastUsedAntigravityConversationMode,
  setLastUsedAntigravityGlobalConversationKey,
  setLastUsedAntigravityPaperConversationKey,
} from "./prefs";
import { CONVERSATION_INSTANCE_ID_MIGRATION_IDS } from "../shared/conversationSchemaMigrations";
import { CONVERSATION_STORE_TABLES_BY_SYSTEM } from "../shared/conversationStore/storeTables";
import { clearPersistedAgentConversationRowsInTransaction } from "../modules/contextPanel/agentConversationCleanup";
import { createRuntimeConversationStore } from "../services/providers/runtimeConversationStore";

/**
 * The Antigravity conversation store: the shared runtime store over the
 * Antigravity tables, configured like the Claude Code store (no extra catalog
 * columns, no fork). The ACP session id is kept in provider_session_id and
 * the working directory the agent process runs in is kept in cwd.
 */

const TABLES = CONVERSATION_STORE_TABLES_BY_SYSTEM.antigravity;

export const antigravityConversationStore = createRuntimeConversationStore({
  system: "antigravity",
  storeLabel: "Antigravity",
  startupStoreID: "antigravity",
  instanceIdMigrationID: CONVERSATION_INSTANCE_ID_MIGRATION_IDS.antigravity,
  schemaRevision: 1,
  tables: {
    messages: TABLES.messageTable,
    messagesIndex: "llm_for_zotero_antigravity_messages_conversation_idx",
    messagesIdIndex: "llm_for_zotero_antigravity_messages_conversation_id_idx",
    catalog: TABLES.catalogTables.global,
    kindIndex: "llm_for_zotero_antigravity_conversations_kind_idx",
    activityIndex: "llm_for_zotero_antigravity_conversations_activity_idx",
    idIndex: "llm_for_zotero_antigravity_conversations_id_idx",
  },
  historyLimit: ANTIGRAVITY_HISTORY_LIMIT,
  activityTimestampSqlForAliasC:
    "COALESCE(c.last_activity_at, c.updated_at, c.created_at)",
  extraCatalogColumns: [],
  registryRepairUserTurnCountSql: "COALESCE(c.user_turn_count, 0)",
  summaryExtraColumns: [],
  clearAgentConversationRowsInTransaction:
    clearPersistedAgentConversationRowsInTransaction,
  upsertExtraColumns: [],
  profileSignature: getAntigravityProfileSignature,
  sessionResetColumns: [],
  keys: {
    buildDefaultGlobalKey: buildDefaultAntigravityGlobalConversationKey,
    buildDefaultPaperKey: buildDefaultAntigravityPaperConversationKey,
    isInRange: isAntigravityConversationKeyInRange,
    allocatedRange: getAntigravityAllocatedConversationKeyRange,
  },
  prefs: {
    getLastAllocatedGlobal: getLastAllocatedAntigravityGlobalConversationKey,
    getLastAllocatedPaper: getLastAllocatedAntigravityPaperConversationKey,
    setLastUsedMode: setLastUsedAntigravityConversationMode,
    setLastUsedGlobal: setLastUsedAntigravityGlobalConversationKey,
    setLastAllocatedGlobal: setLastAllocatedAntigravityGlobalConversationKey,
    setLastAllocatedPaper: setLastAllocatedAntigravityPaperConversationKey,
    setLastUsedPaper: setLastUsedAntigravityPaperConversationKey,
  },
});

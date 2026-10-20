import {
  ANTIGRAVITY_HISTORY_LIMIT,
  buildDefaultAntigravityGlobalConversationKey,
  buildDefaultAntigravityPaperConversationKey,
  getAntigravityAllocatedConversationKeyRange,
  getAntigravityProfileSignature,
} from "./constants";
import {
  getLastAllocatedAntigravityGlobalConversationKey,
  getLastAllocatedAntigravityPaperConversationKey,
  isConversationKeyInRange,
  setLastAllocatedAntigravityGlobalConversationKey,
  setLastAllocatedAntigravityPaperConversationKey,
  setLastUsedAntigravityConversationMode,
  setLastUsedAntigravityGlobalConversationKey,
  setLastUsedAntigravityPaperConversationKey,
} from "./prefs";
import { CONVERSATION_INSTANCE_ID_MIGRATION_IDS } from "../shared/conversationSchemaMigrations";
import { clearPersistedAgentConversationRowsInTransaction } from "../modules/contextPanel/agentConversationCleanup";
import { createRuntimeConversationStore } from "../services/providers/runtimeConversationStore";

/**
 * The Antigravity conversation store: the shared runtime store over the
 * Antigravity tables, configured like the Claude Code store (no extra
 * provider columns). agy keeps the conversation itself; the plugin keeps the
 * transcript it renders and the agy conversation ID in provider_session_id.
 */

const ANTIGRAVITY_MESSAGES_TABLE = "llm_for_zotero_antigravity_messages";
const ANTIGRAVITY_MESSAGES_INDEX =
  "llm_for_zotero_antigravity_messages_conversation_idx";
const ANTIGRAVITY_MESSAGES_ID_INDEX =
  "llm_for_zotero_antigravity_messages_conversation_id_idx";
const ANTIGRAVITY_CONVERSATIONS_TABLE =
  "llm_for_zotero_antigravity_conversations";
const ANTIGRAVITY_CONVERSATIONS_KIND_INDEX =
  "llm_for_zotero_antigravity_conversations_kind_idx";
const ANTIGRAVITY_CONVERSATIONS_ACTIVITY_INDEX =
  "llm_for_zotero_antigravity_conversations_activity_idx";
const ANTIGRAVITY_CONVERSATIONS_ID_INDEX =
  "llm_for_zotero_antigravity_conversations_id_idx";

const store = createRuntimeConversationStore({
  system: "antigravity",
  storeLabel: "Antigravity",
  startupStoreID: "antigravity",
  instanceIdMigrationID: CONVERSATION_INSTANCE_ID_MIGRATION_IDS.antigravity,
  schemaRevision: 1,
  tables: {
    messages: ANTIGRAVITY_MESSAGES_TABLE,
    messagesIndex: ANTIGRAVITY_MESSAGES_INDEX,
    messagesIdIndex: ANTIGRAVITY_MESSAGES_ID_INDEX,
    catalog: ANTIGRAVITY_CONVERSATIONS_TABLE,
    kindIndex: ANTIGRAVITY_CONVERSATIONS_KIND_INDEX,
    activityIndex: ANTIGRAVITY_CONVERSATIONS_ACTIVITY_INDEX,
    idIndex: ANTIGRAVITY_CONVERSATIONS_ID_INDEX,
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
    isInRange: isConversationKeyInRange,
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

export async function repairAntigravityConversationIdentityRegistry(
  ...args: Parameters<typeof store.repairConversationIdentityRegistry>
) {
  return store.repairConversationIdentityRegistry(...args);
}

export const ANTIGRAVITY_STORE_STARTUP_MIGRATION_IDS =
  store.startupMigrationIDs;

export async function initAntigravityStore(
  ...args: Parameters<typeof store.initStore>
) {
  return store.initStore(...args);
}

export async function appendAntigravityMessage(
  ...args: Parameters<typeof store.appendMessage>
) {
  return store.appendMessage(...args);
}

export async function loadAntigravityConversation(
  ...args: Parameters<typeof store.loadConversation>
) {
  return store.loadConversation(...args);
}

export async function clearAntigravityConversation(
  ...args: Parameters<typeof store.clearConversation>
) {
  return store.clearConversation(...args);
}

export async function deleteAntigravityTurnMessages(
  ...args: Parameters<typeof store.deleteTurnMessages>
) {
  return store.deleteTurnMessages(...args);
}

export async function pruneAntigravityConversation(
  ...args: Parameters<typeof store.pruneConversation>
) {
  return store.pruneConversation(...args);
}

export async function updateLatestAntigravityUserMessage(
  ...args: Parameters<typeof store.updateLatestUserMessage>
) {
  return store.updateLatestUserMessage(...args);
}

export async function updateLatestAntigravityAssistantMessage(
  ...args: Parameters<typeof store.updateLatestAssistantMessage>
) {
  return store.updateLatestAssistantMessage(...args);
}

export async function updateAntigravityAssistantMessageQuoteLocations(
  ...args: Parameters<typeof store.updateAssistantMessageQuoteLocations>
) {
  return store.updateAssistantMessageQuoteLocations(...args);
}

export async function getAntigravityConversationSummary(
  ...args: Parameters<typeof store.getSummary>
) {
  return store.getSummary(...args);
}

export async function upsertAntigravityConversationSummary(
  ...args: Parameters<typeof store.upsertSummary>
) {
  return store.upsertSummary(...args);
}

export async function listAntigravityGlobalConversations(
  ...args: Parameters<typeof store.listGlobalConversations>
) {
  return store.listGlobalConversations(...args);
}

export async function listAntigravityPaperConversations(
  ...args: Parameters<typeof store.listPaperConversations>
) {
  return store.listPaperConversations(...args);
}

export async function listAllAntigravityPaperConversationsByLibrary(
  ...args: Parameters<typeof store.listAllPaperConversationsByLibrary>
) {
  return store.listAllPaperConversationsByLibrary(...args);
}

export async function ensureAntigravityGlobalConversation(
  ...args: Parameters<typeof store.ensureGlobalConversation>
) {
  return store.ensureGlobalConversation(...args);
}

export async function ensureAntigravityPaperConversation(
  ...args: Parameters<typeof store.ensurePaperConversation>
) {
  return store.ensurePaperConversation(...args);
}

export async function createAntigravityGlobalConversation(
  ...args: Parameters<typeof store.createGlobalConversation>
) {
  return store.createGlobalConversation(...args);
}

export async function createAntigravityPaperConversation(
  ...args: Parameters<typeof store.createPaperConversation>
) {
  return store.createPaperConversation(...args);
}

export async function touchAntigravityConversationTitle(
  ...args: Parameters<typeof store.touchConversationTitle>
) {
  return store.touchConversationTitle(...args);
}

export async function clearAntigravityConversationSessionMetadata(
  ...args: Parameters<typeof store.clearConversationSessionMetadata>
) {
  return store.clearConversationSessionMetadata(...args);
}

export async function setAntigravityConversationTitle(
  ...args: Parameters<typeof store.setConversationTitle>
) {
  return store.setConversationTitle(...args);
}

export async function deleteAntigravityConversation(
  ...args: Parameters<typeof store.deleteConversation>
) {
  return store.deleteConversation(...args);
}

export async function preflightDeleteAntigravityConversationLocalRows(
  ...args: Parameters<typeof store.preflightDeleteConversationLocalRows>
) {
  return store.preflightDeleteConversationLocalRows(...args);
}

export async function deleteAntigravityConversationLocalRows(
  ...args: Parameters<typeof store.deleteConversationLocalRows>
) {
  return store.deleteConversationLocalRows(...args);
}

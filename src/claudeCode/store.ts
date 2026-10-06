import {
  CLAUDE_HISTORY_LIMIT,
  buildDefaultClaudeGlobalConversationKey,
  buildDefaultClaudePaperConversationKey,
  getClaudeAllocatedConversationKeyRange,
} from "./constants";
import {
  getLastAllocatedClaudeGlobalConversationKey,
  getLastAllocatedClaudePaperConversationKey,
  isConversationKeyInRange,
  setLastAllocatedClaudeGlobalConversationKey,
  setLastAllocatedClaudePaperConversationKey,
  setLastUsedClaudeConversationMode,
  setLastUsedClaudeGlobalConversationKey,
  setLastUsedClaudePaperConversationKey,
} from "./prefs";
import { getClaudeProfileSignature } from "./projectSkills";
import { CONVERSATION_INSTANCE_ID_MIGRATION_IDS } from "../shared/conversationSchemaMigrations";
import { clearPersistedAgentConversationRowsInTransaction } from "../modules/contextPanel/agentConversationCleanup";
import { createRuntimeConversationStore } from "../services/providers/runtimeConversationStore";

/**
 * The Claude Code conversation store: the shared runtime store over the Claude
 * tables.  Every behaviour difference from the Codex store is in this config
 * (see RuntimeStoreConfig); the exports keep their Claude names.
 */

const CLAUDE_MESSAGES_TABLE = "llm_for_zotero_claude_messages";
const CLAUDE_MESSAGES_INDEX = "llm_for_zotero_claude_messages_conversation_idx";
const CLAUDE_MESSAGES_ID_INDEX =
  "llm_for_zotero_claude_messages_conversation_id_idx";
const CLAUDE_CONVERSATIONS_TABLE = "llm_for_zotero_claude_conversations";
const CLAUDE_CONVERSATIONS_KIND_INDEX =
  "llm_for_zotero_claude_conversations_kind_idx";
const CLAUDE_CONVERSATIONS_ACTIVITY_INDEX =
  "llm_for_zotero_claude_conversations_activity_idx";
const CLAUDE_CONVERSATIONS_ID_INDEX =
  "llm_for_zotero_claude_conversations_id_idx";

const store = createRuntimeConversationStore({
  system: "claude_code",
  storeLabel: "Claude",
  startupStoreID: "claude-code",
  instanceIdMigrationID: CONVERSATION_INSTANCE_ID_MIGRATION_IDS.claudeCode,
  schemaRevision: 1,
  tables: {
    messages: CLAUDE_MESSAGES_TABLE,
    messagesIndex: CLAUDE_MESSAGES_INDEX,
    messagesIdIndex: CLAUDE_MESSAGES_ID_INDEX,
    catalog: CLAUDE_CONVERSATIONS_TABLE,
    kindIndex: CLAUDE_CONVERSATIONS_KIND_INDEX,
    activityIndex: CLAUDE_CONVERSATIONS_ACTIVITY_INDEX,
    idIndex: CLAUDE_CONVERSATIONS_ID_INDEX,
  },
  historyLimit: CLAUDE_HISTORY_LIMIT,
  activityTimestampSqlForAliasC:
    "COALESCE(c.last_activity_at, c.updated_at, c.created_at)",
  extraCatalogColumns: [],
  registryRepairUserTurnCountSql: "COALESCE(c.user_turn_count, 0)",
  summaryExtraColumns: [],
  clearAgentConversationRowsInTransaction:
    clearPersistedAgentConversationRowsInTransaction,
  upsertExtraColumns: [],
  profileSignature: getClaudeProfileSignature,
  sessionResetColumns: [],
  keys: {
    buildDefaultGlobalKey: buildDefaultClaudeGlobalConversationKey,
    buildDefaultPaperKey: buildDefaultClaudePaperConversationKey,
    isInRange: isConversationKeyInRange,
    allocatedRange: getClaudeAllocatedConversationKeyRange,
  },
  prefs: {
    getLastAllocatedGlobal: getLastAllocatedClaudeGlobalConversationKey,
    getLastAllocatedPaper: getLastAllocatedClaudePaperConversationKey,
    setLastUsedMode: setLastUsedClaudeConversationMode,
    setLastUsedGlobal: setLastUsedClaudeGlobalConversationKey,
    setLastAllocatedGlobal: setLastAllocatedClaudeGlobalConversationKey,
    setLastAllocatedPaper: setLastAllocatedClaudePaperConversationKey,
    setLastUsedPaper: setLastUsedClaudePaperConversationKey,
  },
});

export async function repairClaudeConversationIdentityRegistry(
  ...args: Parameters<typeof store.repairConversationIdentityRegistry>
) {
  return store.repairConversationIdentityRegistry(...args);
}

export const CLAUDE_STORE_STARTUP_MIGRATION_IDS = store.startupMigrationIDs;

export async function initClaudeCodeStore(
  ...args: Parameters<typeof store.initStore>
) {
  return store.initStore(...args);
}

export async function appendClaudeMessage(
  ...args: Parameters<typeof store.appendMessage>
) {
  return store.appendMessage(...args);
}

export async function loadClaudeConversation(
  ...args: Parameters<typeof store.loadConversation>
) {
  return store.loadConversation(...args);
}

export async function clearClaudeConversation(
  ...args: Parameters<typeof store.clearConversation>
) {
  return store.clearConversation(...args);
}

export async function deleteClaudeTurnMessages(
  ...args: Parameters<typeof store.deleteTurnMessages>
) {
  return store.deleteTurnMessages(...args);
}

export async function pruneClaudeConversation(
  ...args: Parameters<typeof store.pruneConversation>
) {
  return store.pruneConversation(...args);
}

export async function updateLatestClaudeUserMessage(
  ...args: Parameters<typeof store.updateLatestUserMessage>
) {
  return store.updateLatestUserMessage(...args);
}

export async function updateLatestClaudeAssistantMessage(
  ...args: Parameters<typeof store.updateLatestAssistantMessage>
) {
  return store.updateLatestAssistantMessage(...args);
}

export async function getClaudeConversationSummary(
  ...args: Parameters<typeof store.getSummary>
) {
  return store.getSummary(...args);
}

export async function upsertClaudeConversationSummary(
  ...args: Parameters<typeof store.upsertSummary>
) {
  return store.upsertSummary(...args);
}

export async function listClaudeGlobalConversations(
  ...args: Parameters<typeof store.listGlobalConversations>
) {
  return store.listGlobalConversations(...args);
}

export async function listClaudePaperConversations(
  ...args: Parameters<typeof store.listPaperConversations>
) {
  return store.listPaperConversations(...args);
}

export async function listAllClaudePaperConversationsByLibrary(
  ...args: Parameters<typeof store.listAllPaperConversationsByLibrary>
) {
  return store.listAllPaperConversationsByLibrary(...args);
}

export async function ensureClaudeGlobalConversation(
  ...args: Parameters<typeof store.ensureGlobalConversation>
) {
  return store.ensureGlobalConversation(...args);
}

export async function ensureClaudePaperConversation(
  ...args: Parameters<typeof store.ensurePaperConversation>
) {
  return store.ensurePaperConversation(...args);
}

export async function createClaudeGlobalConversation(
  ...args: Parameters<typeof store.createGlobalConversation>
) {
  return store.createGlobalConversation(...args);
}

export async function createClaudePaperConversation(
  ...args: Parameters<typeof store.createPaperConversation>
) {
  return store.createPaperConversation(...args);
}

export async function touchClaudeConversationTitle(
  ...args: Parameters<typeof store.touchConversationTitle>
) {
  return store.touchConversationTitle(...args);
}

export async function clearClaudeConversationSessionMetadata(
  ...args: Parameters<typeof store.clearConversationSessionMetadata>
) {
  return store.clearConversationSessionMetadata(...args);
}

export async function setClaudeConversationTitle(
  ...args: Parameters<typeof store.setConversationTitle>
) {
  return store.setConversationTitle(...args);
}

export async function deleteClaudeConversation(
  ...args: Parameters<typeof store.deleteConversation>
) {
  return store.deleteConversation(...args);
}

export async function preflightDeleteClaudeConversationLocalRows(
  ...args: Parameters<typeof store.preflightDeleteConversationLocalRows>
) {
  return store.preflightDeleteConversationLocalRows(...args);
}

export async function deleteClaudeConversationLocalRows(
  ...args: Parameters<typeof store.deleteConversationLocalRows>
) {
  return store.deleteConversationLocalRows(...args);
}

declare const Zotero: any;

import type { CodexConversationKind } from "../shared/types";
import {
  copyConversationMessagesThroughAssistantAnchor,
  type ForkConversationMessagesResult,
} from "../shared/conversationMessageForkCopy";
import {
  CODEX_GLOBAL_CONVERSATION_KEY_BASE,
  RUNTIME_CONVERSATION_KEY_END,
  getConversationKeyRange,
} from "../shared/conversationKeySpace";
import { storedMessageDisplayOrderSql } from "../shared/conversationMessageSql";
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
import {
  AMBIGUOUS_PAPER_CONTEXT_INVALID_REASON,
  canMigrateLegacyAmbiguousPaperRegistryScope,
  getPaperContextOwnershipEvidenceFromRows,
  getRegisteredConversationScope,
  initConversationRegistryStore,
  deleteRegisteredConversationScopeInTransaction,
  registerConversationScope,
  repairRegisteredConversationScope,
} from "../shared/conversationRegistry";
import { stagePaperRestoreTargetForStartup } from "../shared/paperConversationRestore";
import {
  deleteConversationSearchIndexRowInTransaction,
  initConversationSearchIndexStore,
} from "../shared/conversationSearchIndex";
import {
  CONVERSATION_INSTANCE_ID_MIGRATION_IDS,
  CONVERSATION_ID_TRANSITION_MIGRATION_ID,
  CONVERSATION_KEY_LEDGER_MIGRATION_ID,
  hasConversationSchemaMigration,
  rekeyConversationCatalogKeyInTransaction,
  rekeyConversationOwnedRowsInTransaction,
  runConversationSchemaMigrationOnce,
} from "../shared/conversationSchemaMigrations";
import {
  runConversationStoreStartupSchema,
  type StartupSchemaPass,
} from "../shared/startupSchemaFingerprint";
import {
  nextUnissuedConversationKeyInRange,
  ConversationRetiredError,
  getConversationKeyLedgerEntry,
  initializeConversationKeyCounterInTransaction,
  initConversationKeyLedgerStore,
  refreshConversationKeyLedgerStore,
  isConversationKeyLedgerStoreInitialized,
  installConversationKeyLedgerCatalogTriggers,
  installConversationKeyLedgerMessageTriggers,
  retireConversationKeyInTransaction,
  seedConversationKeyLedgerFromCatalogs,
  reserveOrphanConversationMessageKeys,
  seedConversationKeyLedgerFromTombstones,
  retireOrphanedConversationLedgerEntries,
  rememberConversationKeyRetired,
} from "../shared/conversationKeyLedger";
import { pendingDeletionStore } from "../core/conversations/pendingDeletionStore";
import {
  initRecentlyDeletedConversationTombstones,
  persistConversationInstanceTombstoneInTransaction,
} from "../core/conversations/recentlyDeletedConversations";
import {
  deleteConversationForkLinksForInstanceInTransaction,
  initConversationForkLinksStore,
} from "../shared/conversationForkLinks";
import {
  normalizeCatalogTimestamp,
  normalizeConversationKey,
  normalizeLibraryID,
  normalizePaperItemID,
} from "../shared/conversationStore/keyNormalization";
import { logConversationStoreWarning } from "../shared/conversationStore/diagnostics";
import { clearPersistedAgentConversationRowsInTransaction } from "../modules/contextPanel/agentConversationCleanup";
import { deleteUsageEventsForConversationInTransaction } from "../utils/usageStore";
import { clearOwnerAttachmentRefsInTransaction } from "../utils/attachmentRefStore";
import {
  createRuntimeConversationStore,
  ensureColumn,
} from "../services/providers/runtimeConversationStore";

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

const store = createRuntimeConversationStore({
  system: "codex",
  storeLabel: "Codex",
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
  summaryExtraColumns: [
    { sql: "c.provider_permission_state", alias: "providerPermissionState" },
  ],
  hooks: {
    afterMessageWriteInTransaction: touchCodexConversationActivity,
  },
  upsertExtraColumns: [
    {
      column: "provider_permission_state",
      param: "providerPermissionState",
    },
  ],
  profileSignature: getCodexProfileSignature,
  sessionResetColumns: [
    "provider_permission_state",
    "provider_session_path_state",
  ],
  keys: {
    allocatedRange: getCodexAllocatedConversationKeyRange,
  },
  prefs: {
    setLastAllocatedGlobal: setLastAllocatedCodexGlobalConversationKey,
    setLastAllocatedPaper: setLastAllocatedCodexPaperConversationKey,
    setLastUsedPaper: setLastUsedCodexPaperConversationKey,
  },
});
const isCodexStoreConversationKey = store.isStoreConversationKey;
const buildCodexConversationID = store.buildConversationID;
const resolveRegisteredConversationID = store.resolveRegisteredConversationID;
const resolveRepairingMessageConversationSelector =
  store.resolveRepairingMessageConversationSelector;
const refreshCodexConversationSearchIndex = store.refreshSearchIndex;
const backfillCodexConversationTimestamps =
  store.backfillConversationTimestamps;
const refreshCodexConversationCatalogSummary = store.refreshCatalogSummary;
const getCodexMessagePaperContextRows = store.getMessagePaperContextRows;
const repairRecoverableCodexCatalogMessageConversationIDs =
  store.repairRecoverableCatalogMessageConversationIDs;
const backfillCodexConversationIDs = store.backfillConversationIDs;
const backfillCodexConversationInstanceIDs =
  store.backfillConversationInstanceIDs;
const CLAUDE_MESSAGES_TABLE = "llm_for_zotero_claude_messages";
const CLAUDE_CONVERSATIONS_TABLE = "llm_for_zotero_claude_conversations";

async function resolveRegisteredConversationInstanceID(
  conversationKey: number,
): Promise<string | null> {
  const registered = await getRegisteredConversationScope(conversationKey);
  if (registered?.instanceID) return registered.instanceID;
  const ledger = await getConversationKeyLedgerEntry(conversationKey);
  return ledger?.instanceID || null;
}

async function assertCodexForkSourceLive(params: {
  conversationKey: number;
  instanceID?: string;
  conversationID?: string;
}): Promise<void> {
  const key = normalizeConversationKey(params.conversationKey);
  if (!key) throw new ConversationRetiredError(0, params.instanceID || "");
  const ledger = await getConversationKeyLedgerEntry(key);
  if (!ledger && !params.instanceID) return;
  const instanceID = params.instanceID?.trim() || ledger?.instanceID || "";
  if (!ledger || ledger.retiredAt || ledger.instanceID !== instanceID) {
    throw new ConversationRetiredError(key, instanceID);
  }
  const rows = (await Zotero.DB.queryAsync(
    `SELECT conversation_id AS conversationID
     FROM ${CODEX_CONVERSATIONS_TABLE}
     WHERE conversation_key = ?
       AND conversation_instance_id = ?
       AND (? = '' OR conversation_id = ?)
     LIMIT 1`,
    [
      key,
      instanceID,
      params.conversationID?.trim() || "",
      params.conversationID?.trim() || "",
    ],
  )) as Array<{ conversationID?: unknown }> | undefined;
  if (!rows?.length) throw new ConversationRetiredError(key, instanceID);
}

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

function remapLegacyConversationKey(
  legacyConversationKey: number,
  kind: CodexConversationKind,
  libraryID: number,
  paperItemID?: number,
): number | null {
  const normalizedLegacyKey = normalizeConversationKey(legacyConversationKey);
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  if (!normalizedLegacyKey || !normalizedLibraryID) return null;
  if (isConversationKeyInRange(normalizedLegacyKey, kind))
    return normalizedLegacyKey;
  if (kind === "paper") {
    const normalizedPaperItemID = normalizePaperItemID(paperItemID || 0);
    if (!normalizedPaperItemID) return null;
    return buildDefaultCodexPaperConversationKey(normalizedPaperItemID);
  }
  return buildDefaultCodexGlobalConversationKey(normalizedLibraryID);
}

type CodexConversationKeyRemap = {
  legacyKey: number;
  targetKey: number;
  /** A retired key may contain an older owner's rows; never adopt them. */
  preserveLegacyRows?: boolean;
};

async function migrateLegacyCodexConversationKeys(): Promise<
  CodexConversationKeyRemap[]
> {
  const remaps: CodexConversationKeyRemap[] = [];
  const rows = (await Zotero.DB.queryAsync(
    `SELECT conversation_key AS conversationKey,
            library_id AS libraryID,
            kind AS kind,
            paper_item_id AS paperItemID,
            updated_at AS updatedAt
     FROM ${CODEX_CONVERSATIONS_TABLE}
     ORDER BY updated_at DESC, conversation_key DESC`,
  )) as
    | Array<{
        conversationKey?: unknown;
        libraryID?: unknown;
        kind?: unknown;
        paperItemID?: unknown;
        updatedAt?: unknown;
      }>
    | undefined;
  if (!rows?.length) return remaps;

  const claimedKeys = new Set<number>(
    rows
      .map((row) => {
        const kind =
          row.kind === "paper"
            ? "paper"
            : row.kind === "global"
              ? "global"
              : null;
        const conversationKey = normalizeConversationKey(
          Number(row.conversationKey),
        );
        return kind &&
          conversationKey &&
          isConversationKeyInRange(conversationKey, kind)
          ? conversationKey
          : null;
      })
      .filter((value): value is number => Number.isFinite(value)),
  );
  const latestModeByLibrary = new Set<number>();
  const latestGlobalByLibrary = new Set<number>();
  const latestPaperByState = new Set<string>();
  const isUnavailable = async (key: number): Promise<boolean> =>
    Boolean(await getConversationKeyLedgerEntry(key));
  const isRetired = async (key: number): Promise<boolean> =>
    Boolean((await getConversationKeyLedgerEntry(key))?.retiredAt);
  for (const row of rows) {
    const kind =
      row.kind === "paper" ? "paper" : row.kind === "global" ? "global" : null;
    const legacyConversationKey = normalizeConversationKey(
      Number(row.conversationKey),
    );
    const libraryID = normalizeLibraryID(Number(row.libraryID));
    const paperItemID = normalizePaperItemID(Number(row.paperItemID));
    if (!kind || !legacyConversationKey || !libraryID) continue;

    // A tombstone/retired ledger witness means this numeric key belonged to a
    // prior immutable instance. If an old catalog row was later reused before
    // the permanent-key migration ran, its key-only messages and agent rows
    // are ambiguous and must remain quarantined rather than being moved into
    // the replacement catalog below.
    const legacyKeyWasRetired = Boolean(
      (await getConversationKeyLedgerEntry(legacyConversationKey))?.retiredAt,
    );

    let targetConversationKey = remapLegacyConversationKey(
      legacyConversationKey,
      kind,
      libraryID,
      paperItemID || undefined,
    );
    if (!targetConversationKey) continue;
    if (await isRetired(targetConversationKey)) {
      targetConversationKey = null;
    }
    if (targetConversationKey === null) {
      // Fall through to the monotonic fallback below.
    }
    if (
      targetConversationKey !== null &&
      claimedKeys.has(targetConversationKey) &&
      targetConversationKey !== legacyConversationKey
    ) {
      targetConversationKey = null;
    }
    if (!targetConversationKey) {
      targetConversationKey = Math.max(
        ((kind === "paper"
          ? getLastAllocatedCodexPaperConversationKey()
          : getLastAllocatedCodexGlobalConversationKey()) || 0) + 1,
        (await getMaxCodexConversationKey(kind)) + 1,
      );
      const range = getConversationKeyRange("codex", kind);
      targetConversationKey = await nextUnissuedConversationKeyInRange({
        start: range.start,
        endExclusive: range.endExclusive,
        atLeast: targetConversationKey,
      });
    }

    claimedKeys.add(targetConversationKey);
    if (targetConversationKey !== legacyConversationKey) {
      await rekeyConversationCatalogKeyInTransaction({
        table: CODEX_CONVERSATIONS_TABLE,
        legacyKey: legacyConversationKey,
        targetKey: targetConversationKey,
      });
      if (!legacyKeyWasRetired) {
        await Zotero.DB.queryAsync(
          `UPDATE ${CODEX_MESSAGES_TABLE}
           SET conversation_key = ?
           WHERE conversation_key = ?`,
          [targetConversationKey, legacyConversationKey],
        );
      }
      remaps.push({
        legacyKey: legacyConversationKey,
        targetKey: targetConversationKey,
        preserveLegacyRows: legacyKeyWasRetired,
      });
    }

    if (!latestModeByLibrary.has(libraryID)) {
      setLastUsedCodexConversationMode(
        libraryID,
        kind === "paper" ? "paper" : "global",
      );
      latestModeByLibrary.add(libraryID);
    }
    if (kind === "paper" && paperItemID) {
      const paperStateKey = `${libraryID}:${paperItemID}`;
      if (!latestPaperByState.has(paperStateKey)) {
        stagePaperRestoreTargetForStartup(
          { system: "codex", libraryID, paperItemID },
          targetConversationKey,
        );
        latestPaperByState.add(paperStateKey);
      }
      setLastAllocatedCodexPaperConversationKey(targetConversationKey);
      continue;
    }
    if (!latestGlobalByLibrary.has(libraryID)) {
      setLastUsedCodexGlobalConversationKey(libraryID, targetConversationKey);
      latestGlobalByLibrary.add(libraryID);
    }
    setLastAllocatedCodexGlobalConversationKey(targetConversationKey);
  }
  return remaps;
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

const MESSAGE_TRANSFER_COLUMNS = [
  "conversation_key",
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

async function ensureCodexConversationCatalogColumns(
  columns: Array<{ name?: unknown }> | undefined,
): Promise<void> {
  const requiredColumns: Array<[string, string]> = [
    ["conversation_id", "conversation_id TEXT"],
    ["conversation_instance_id", "conversation_instance_id TEXT"],
    ["library_id", "library_id INTEGER"],
    ["kind", "kind TEXT"],
    ["paper_item_id", "paper_item_id INTEGER"],
    ["created_at", "created_at INTEGER"],
    ["updated_at", "updated_at INTEGER"],
    ["last_activity_at", "last_activity_at INTEGER"],
    ["user_turn_count", "user_turn_count INTEGER NOT NULL DEFAULT 0"],
    ["first_user_title", "first_user_title TEXT"],
    ["title", "title TEXT"],
    ["provider_session_id", "provider_session_id TEXT"],
    ["provider_permission_state", "provider_permission_state TEXT"],
    ["provider_session_path_state", "provider_session_path_state TEXT"],
    ["scoped_conversation_key", "scoped_conversation_key TEXT"],
    ["scope_type", "scope_type TEXT"],
    ["scope_id", "scope_id TEXT"],
    ["scope_label", "scope_label TEXT"],
    ["cwd", "cwd TEXT"],
    ["model_name", "model_name TEXT"],
    ["effort", "effort TEXT"],
  ];
  for (const [columnName, definition] of requiredColumns) {
    await ensureColumn(
      CODEX_CONVERSATIONS_TABLE,
      columns,
      columnName,
      definition,
    );
  }
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
  options: { inTransaction?: boolean } = {},
): Promise<void> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT c.conversation_id AS conversationID,
            c.conversation_key AS conversationKey,
            c.library_id AS libraryID,
            c.kind AS kind,
            c.paper_item_id AS paperItemID,
            c.created_at AS createdAt,
            ${CODEX_CONVERSATION_ACTIVITY_TIMESTAMP_SQL_FOR_ALIAS_C} AS updatedAt,
            COALESCE(NULLIF(TRIM(c.title), ''), NULLIF(TRIM(c.first_user_title), '')) AS title,
            c.provider_session_id AS providerSessionId,
            c.provider_permission_state AS providerPermissionState,
            c.scoped_conversation_key AS scopedConversationKey,
            c.scope_type AS scopeType,
            c.scope_id AS scopeId,
            c.scope_label AS scopeLabel,
            c.cwd AS cwd,
            c.model_name AS modelName,
            c.effort AS effort,
            (
              SELECT COUNT(*)
              FROM ${CODEX_MESSAGES_TABLE} m
              WHERE (m.conversation_id = c.conversation_id OR ((m.conversation_id IS NULL OR TRIM(m.conversation_id) = '') AND m.conversation_key = c.conversation_key))
                AND m.role = 'user'
            ) AS userTurnCount
     FROM ${CODEX_CONVERSATIONS_TABLE} c
     ORDER BY updatedAt DESC, c.conversation_key DESC`,
  )) as CodexConversationRow[] | undefined;
  for (const row of rows || []) {
    const summary = toCodexConversationSummary(row);
    if (!summary) continue;
    if (summary.kind === "paper") {
      const registered = await getRegisteredConversationScope(
        summary.conversationKey,
      );
      if (
        canMigrateLegacyAmbiguousPaperRegistryScope(registered, {
          system: "codex",
          kind: summary.kind,
          libraryID: summary.libraryID,
          paperItemID: summary.paperItemID,
        })
      ) {
        await repairRegisteredConversationScope(
          {
            conversationID: summary.conversationID,
            conversationKey: summary.conversationKey,
            system: "codex",
            kind: "paper",
            libraryID: summary.libraryID,
            paperItemID: summary.paperItemID,
            createdAt: summary.createdAt,
            updatedAt: summary.updatedAt,
            title: summary.title,
          },
          options,
        );
        logConversationStoreWarning(
          `Migrated Codex conversation ${summary.conversationKey} from legacy ${AMBIGUOUS_PAPER_CONTEXT_INVALID_REASON} invalidation to primary paper ${summary.paperItemID}.`,
        );
        continue;
      }
      if (!summary.paperItemID) {
        const evidence = getPaperContextOwnershipEvidenceFromRows(
          await getCodexMessagePaperContextRows(summary.conversationKey),
        );
        const inferredPaperItemID = evidence.singlePaperItemID;
        if (!inferredPaperItemID) continue;
        const repairedConversationID = buildCodexConversationID({
          conversationKey: summary.conversationKey,
          kind: "paper",
          libraryID: summary.libraryID,
          paperItemID: inferredPaperItemID,
        });
        await Zotero.DB.queryAsync(
          `UPDATE ${CODEX_CONVERSATIONS_TABLE}
           SET conversation_id = ?,
               paper_item_id = ?
           WHERE conversation_key = ?`,
          [
            repairedConversationID,
            inferredPaperItemID,
            summary.conversationKey,
          ],
        );
        await Zotero.DB.queryAsync(
          `UPDATE ${CODEX_MESSAGES_TABLE}
          SET conversation_id = ?
           WHERE conversation_key = ?`,
          [repairedConversationID, summary.conversationKey],
        );
        await repairRegisteredConversationScope(
          {
            conversationKey: summary.conversationKey,
            system: "codex",
            kind: "paper",
            libraryID: summary.libraryID,
            paperItemID: inferredPaperItemID,
            createdAt: summary.createdAt,
            updatedAt: summary.updatedAt,
            title: summary.title,
          },
          options,
        );
        logConversationStoreWarning(
          `Repaired Codex conversation ${summary.conversationKey} to paper ${inferredPaperItemID} based on stored paper contexts.`,
        );
        continue;
      }
    }
    await registerConversationScope(
      {
        conversationID: summary.conversationID,
        conversationKey: summary.conversationKey,
        system: "codex",
        kind: summary.kind,
        libraryID: summary.libraryID,
        paperItemID: summary.paperItemID,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        title: summary.title,
      },
      options,
    );
  }
}

/**
 * Migrations the startup schema pass guards with markers.  Their IDs are part
 * of the startup fingerprint, so declaring a new one here forces the next
 * launch back through the transactional pass (see startupSchemaFingerprint).
 */
export const CODEX_STORE_STARTUP_MIGRATION_IDS = [
  CONVERSATION_ID_TRANSITION_MIGRATION_ID,
  CONVERSATION_INSTANCE_ID_MIGRATION_IDS.codex,
  CONVERSATION_KEY_LEDGER_MIGRATION_ID,
] as const;

/**
 * Bump when the startup schema pass changes in a way that must run inside a
 * transaction once (a new multi-statement repair, a table rebuild).
 */
const CODEX_STORE_STARTUP_SCHEMA_REVISION = 1;

export async function initCodexAppServerStore(): Promise<void> {
  const conversationIDTransitionAlreadyApplied =
    await hasConversationSchemaMigration(
      CONVERSATION_ID_TRANSITION_MIGRATION_ID,
    );
  const applyStartupSchema = async ({
    atomically,
  }: StartupSchemaPass): Promise<void> => {
    await initConversationRegistryStore();
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${CODEX_MESSAGES_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT,
        conversation_instance_id TEXT,
        conversation_key INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        run_mode TEXT CHECK(run_mode IN ('chat', 'agent')),
        agent_run_id TEXT,
        document_id TEXT,
        selected_text TEXT,
        selected_text_contexts_json TEXT,
        selected_texts_json TEXT,
        selected_text_sources_json TEXT,
        selected_text_paper_contexts_json TEXT,
        selected_text_note_contexts_json TEXT,
        forced_skill_ids_json TEXT,
        paper_contexts_json TEXT,
        pdf_paper_contexts_json TEXT,
        full_text_paper_contexts_json TEXT,
        citation_paper_contexts_json TEXT,
        quote_citations_json TEXT,
        collection_contexts_json TEXT,
        tag_contexts_json TEXT,
        screenshot_images TEXT,
        attachments_json TEXT,
        generated_images_json TEXT,
        model_name TEXT,
        model_entry_id TEXT,
        model_provider_label TEXT,
        interrupted INTEGER,
        webchat_run_state TEXT,
        webchat_completion_reason TEXT,
        reasoning_summary TEXT,
        reasoning_details TEXT,
        compact_marker INTEGER,
        context_tokens INTEGER,
        context_window INTEGER
      )`,
    );
    const columns = (await Zotero.DB.queryAsync(
      `PRAGMA table_info(${CODEX_MESSAGES_TABLE})`,
    )) as Array<{ name?: unknown }> | undefined;
    await ensureColumn(
      CODEX_MESSAGES_TABLE,
      columns,
      "conversation_id",
      "conversation_id TEXT",
    );
    await ensureColumn(
      CODEX_MESSAGES_TABLE,
      columns,
      "conversation_instance_id",
      "conversation_instance_id TEXT",
    );
    await ensureColumn(
      CODEX_MESSAGES_TABLE,
      columns,
      "document_id",
      "document_id TEXT",
    );
    await ensureColumn(
      CODEX_MESSAGES_TABLE,
      columns,
      "selected_text_contexts_json",
      "selected_text_contexts_json TEXT",
    );
    const hasCompactMarkerColumn = Boolean(
      columns?.some((column) => column?.name === "compact_marker"),
    );
    if (!hasCompactMarkerColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CODEX_MESSAGES_TABLE}
         ADD COLUMN compact_marker INTEGER`,
      );
    }
    const hasContextTokensColumn = Boolean(
      columns?.some((column) => column?.name === "context_tokens"),
    );
    if (!hasContextTokensColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CODEX_MESSAGES_TABLE}
         ADD COLUMN context_tokens INTEGER`,
      );
    }
    const hasContextWindowColumn = Boolean(
      columns?.some((column) => column?.name === "context_window"),
    );
    if (!hasContextWindowColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CODEX_MESSAGES_TABLE}
         ADD COLUMN context_window INTEGER`,
      );
    }
    const hasCitationPaperContextsJsonColumn = Boolean(
      columns?.some(
        (column) => column?.name === "citation_paper_contexts_json",
      ),
    );
    const hasPdfPaperContextsJsonColumn = Boolean(
      columns?.some((column) => column?.name === "pdf_paper_contexts_json"),
    );
    if (!hasPdfPaperContextsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CODEX_MESSAGES_TABLE}
         ADD COLUMN pdf_paper_contexts_json TEXT`,
      );
    }
    if (!hasCitationPaperContextsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CODEX_MESSAGES_TABLE}
         ADD COLUMN citation_paper_contexts_json TEXT`,
      );
    }
    const hasQuoteCitationsJsonColumn = Boolean(
      columns?.some((column) => column?.name === "quote_citations_json"),
    );
    if (!hasQuoteCitationsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CODEX_MESSAGES_TABLE}
         ADD COLUMN quote_citations_json TEXT`,
      );
    }
    await ensureColumn(
      CODEX_MESSAGES_TABLE,
      columns,
      "collection_contexts_json",
      "collection_contexts_json TEXT",
    );
    await ensureColumn(
      CODEX_MESSAGES_TABLE,
      columns,
      "tag_contexts_json",
      "tag_contexts_json TEXT",
    );
    await ensureColumn(
      CODEX_MESSAGES_TABLE,
      columns,
      "forced_skill_ids_json",
      "forced_skill_ids_json TEXT",
    );
    await ensureColumn(
      CODEX_MESSAGES_TABLE,
      columns,
      "generated_images_json",
      "generated_images_json TEXT",
    );
    await ensureColumn(
      CODEX_MESSAGES_TABLE,
      columns,
      "interrupted",
      "interrupted INTEGER",
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${CODEX_MESSAGES_INDEX}
       ON ${CODEX_MESSAGES_TABLE} (conversation_key, timestamp, id)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${CODEX_MESSAGES_ID_INDEX}
       ON ${CODEX_MESSAGES_TABLE} (conversation_id, timestamp, id)`,
    );

    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${CODEX_CONVERSATIONS_TABLE} (
        conversation_id TEXT,
        conversation_instance_id TEXT,
        conversation_key INTEGER PRIMARY KEY,
        library_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('global', 'paper')),
        paper_item_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_activity_at INTEGER,
        user_turn_count INTEGER NOT NULL DEFAULT 0,
        first_user_title TEXT,
        title TEXT,
        provider_session_id TEXT,
        provider_permission_state TEXT,
        provider_session_path_state TEXT,
        scoped_conversation_key TEXT,
        scope_type TEXT,
        scope_id TEXT,
        scope_label TEXT,
        cwd TEXT,
        model_name TEXT,
        effort TEXT
      )`,
    );
    const conversationColumns = (await Zotero.DB.queryAsync(
      `PRAGMA table_info(${CODEX_CONVERSATIONS_TABLE})`,
    )) as Array<{ name?: unknown }> | undefined;
    await ensureCodexConversationCatalogColumns(conversationColumns);
    let migratedKeyRemaps: CodexConversationKeyRemap[] = [];
    if (!conversationIDTransitionAlreadyApplied) {
      await backfillCodexConversationTimestamps();
    }
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${CODEX_CONVERSATIONS_KIND_INDEX}
       ON ${CODEX_CONVERSATIONS_TABLE} (library_id, kind, paper_item_id, updated_at DESC, conversation_key DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${CODEX_CONVERSATIONS_ACTIVITY_INDEX}
       ON ${CODEX_CONVERSATIONS_TABLE} (library_id, kind, paper_item_id, last_activity_at DESC, updated_at DESC, conversation_key DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${CODEX_CONVERSATIONS_ID_INDEX}
       ON ${CODEX_CONVERSATIONS_TABLE} (conversation_id)`,
    );
    if (!conversationIDTransitionAlreadyApplied) {
      await initConversationKeyLedgerStore();
      await initRecentlyDeletedConversationTombstones();
      await seedConversationKeyLedgerFromTombstones();
      await reserveOrphanConversationMessageKeys({
        messageTable: CODEX_MESSAGES_TABLE,
        catalogTables: [CODEX_CONVERSATIONS_TABLE],
        system: "codex",
        sourceTables: [
          { table: "llm_for_zotero_agent_memory" },
          { table: "llm_for_zotero_agent_transcript" },
          { table: "llm_for_zotero_agent_tool_result_handles" },
          { table: "llm_for_zotero_agent_evidence" },
          { table: "llm_for_zotero_agent_runs" },
          {
            table: "llm_for_zotero_agent_coverage",
            column: "origin_conversation_key",
          },
          {
            table: "llm_for_zotero_attachment_refs",
            column: "owner_id",
            whereSql: "s.owner_type = 'conversation'",
          },
        ],
      });
      await repairMisroutedCodexConversationRows();
      migratedKeyRemaps = await migrateLegacyCodexConversationKeys();
      await backfillCodexConversationIDs();
      await repairCodexConversationIdentityRegistry({ inTransaction: true });
      await refreshCodexConversationCatalogSummary();
    }
    await runConversationSchemaMigrationOnce(
      CONVERSATION_INSTANCE_ID_MIGRATION_IDS.codex,
      "Backfill immutable conversation instance identities for Codex catalogs and registry rows.",
      async () => {
        await backfillCodexConversationIDs();
        await backfillCodexConversationInstanceIDs();
        await repairCodexConversationIdentityRegistry({ inTransaction: true });
      },
    );
    await refreshConversationKeyLedgerStore();
    await initRecentlyDeletedConversationTombstones();
    await runConversationSchemaMigrationOnce(
      CONVERSATION_KEY_LEDGER_MIGRATION_ID,
      "Reserve every existing Codex conversation key permanently and initialize the monotonic allocator.",
      async () => {
        await seedConversationKeyLedgerFromCatalogs([
          {
            table: CODEX_CONVERSATIONS_TABLE,
            system: "codex",
            kind: "global",
            kindColumn: true,
          },
          {
            table: CODEX_CONVERSATIONS_TABLE,
            system: "codex",
            kind: "paper",
            kindColumn: true,
          },
        ]);
      },
    );
    await seedConversationKeyLedgerFromCatalogs([
      {
        table: CODEX_CONVERSATIONS_TABLE,
        system: "codex",
        kind: "global",
        kindColumn: true,
      },
      {
        table: CODEX_CONVERSATIONS_TABLE,
        system: "codex",
        kind: "paper",
        kindColumn: true,
      },
    ]);
    for (const remap of migratedKeyRemaps) {
      if (remap.preserveLegacyRows) continue;
      await rekeyConversationOwnedRowsInTransaction(
        remap.legacyKey,
        remap.targetKey,
      );
    }
    await seedConversationKeyLedgerFromTombstones();
    await reserveOrphanConversationMessageKeys({
      messageTable: CODEX_MESSAGES_TABLE,
      catalogTables: [CODEX_CONVERSATIONS_TABLE],
      system: "codex",
      sourceTables: [
        { table: "llm_for_zotero_agent_memory" },
        { table: "llm_for_zotero_agent_transcript" },
        { table: "llm_for_zotero_agent_tool_result_handles" },
        { table: "llm_for_zotero_agent_evidence" },
        { table: "llm_for_zotero_agent_runs" },
        {
          table: "llm_for_zotero_agent_coverage",
          column: "origin_conversation_key",
        },
        {
          table: "llm_for_zotero_attachment_refs",
          column: "owner_id",
          whereSql: "s.owner_type = 'conversation'",
        },
        {
          table: "llm_for_zotero_conversation_registry",
          column: "legacy_conversation_key",
        },
        {
          table: "llm_for_zotero_conversation_search_index",
          column: "legacy_conversation_key",
        },
        { table: "llm_for_zotero_conversation_cleanup_jobs" },
        { table: "llm_for_zotero_pending_deletions" },
        { table: "llm_for_zotero_agent_trace_exports" },
        { table: "llm_for_zotero_agent_trace_file_cleanup" },
        {
          table: "llm_for_zotero_conversation_fork_links",
          column: "source_conversation_key",
        },
        {
          table: "llm_for_zotero_conversation_fork_links",
          column: "target_conversation_key",
        },
      ],
    });
    await retireOrphanedConversationLedgerEntries({
      system: "codex",
      kind: "global",
      catalogTables: [CODEX_CONVERSATIONS_TABLE],
      atomically,
    });
    await retireOrphanedConversationLedgerEntries({
      system: "codex",
      kind: "paper",
      catalogTables: [CODEX_CONVERSATIONS_TABLE],
      atomically,
    });
    const codexGlobalRange = getCodexAllocatedConversationKeyRange("global");
    const codexPaperRange = getCodexAllocatedConversationKeyRange("paper");
    await initializeConversationKeyCounterInTransaction({
      system: "codex",
      kind: "global",
      start: codexGlobalRange.start,
      endExclusive: codexGlobalRange.endExclusive,
      profileSignature: getCodexProfileSignature(),
    });
    await initializeConversationKeyCounterInTransaction({
      system: "codex",
      kind: "paper",
      start: codexPaperRange.start,
      endExclusive: codexPaperRange.endExclusive,
      profileSignature: getCodexProfileSignature(),
    });
    await Zotero.DB.queryAsync(
      `UPDATE ${CODEX_MESSAGES_TABLE}
       SET conversation_instance_id = (
         SELECT c.conversation_instance_id
         FROM ${CODEX_CONVERSATIONS_TABLE} c
         WHERE c.conversation_key = ${CODEX_MESSAGES_TABLE}.conversation_key
       )
       WHERE conversation_instance_id IS NULL
          OR TRIM(conversation_instance_id) = ''`,
    );
    await installConversationKeyLedgerCatalogTriggers([
      CODEX_CONVERSATIONS_TABLE,
    ]);
    await installConversationKeyLedgerMessageTriggers({
      messageTable: CODEX_MESSAGES_TABLE,
    });
  };
  await runConversationStoreStartupSchema({
    storeID: "codex",
    schemaRevision: CODEX_STORE_STARTUP_SCHEMA_REVISION,
    migrationIDs: CODEX_STORE_STARTUP_MIGRATION_IDS,
    body: applyStartupSchema,
  });
  cleanupRememberedConversationKeyPrefs();
}

export const initCodexCodeStore = initCodexAppServerStore;

export async function appendCodexMessage(
  ...args: Parameters<typeof store.appendMessage>
) {
  return store.appendMessage(...args);
}

export async function forkCodexConversationMessages(params: {
  sourceConversationKey: number;
  sourceInstanceID?: string;
  sourceConversationID?: string;
  targetConversationKey: number;
  throughAssistantTimestamp: number;
  timestampBase?: number;
}): Promise<ForkConversationMessagesResult> {
  return copyConversationMessagesThroughAssistantAnchor(
    {
      tableName: CODEX_MESSAGES_TABLE,
      copyColumns: CODEX_MESSAGE_COPY_COLUMNS,
      isValidConversationKey: isCodexStoreConversationKey,
      resolveSourceSelector: resolveRepairingMessageConversationSelector,
      resolveTargetConversationID: resolveRegisteredConversationID,
      resolveTargetInstanceID: resolveRegisteredConversationInstanceID,
      assertSourceConversationLive: assertCodexForkSourceLive,
      refreshCatalogSummary: refreshCodexConversationCatalogSummary,
      refreshSearchIndex: refreshCodexConversationSearchIndex,
      afterCopy: touchCodexConversationActivity,
    },
    params,
  );
}

export async function getLatestCodexForkableAssistantTimestamp(
  conversationKey: number,
): Promise<number> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return 0;
  const selector =
    await resolveRepairingMessageConversationSelector(normalizedKey);
  const rows = (await Zotero.DB.queryAsync(
    `SELECT timestamp
     FROM ${CODEX_MESSAGES_TABLE}
     WHERE ${selector.whereSql}
       AND role = 'assistant'
       AND COALESCE(compact_marker, 0) = 0
       AND NULLIF(TRIM(COALESCE(webchat_run_state, '')), '') IS NULL
       AND NULLIF(TRIM(COALESCE(webchat_completion_reason, '')), '') IS NULL
     ORDER BY ${storedMessageDisplayOrderSql({ direction: "desc" })}
     LIMIT 1`,
    selector.params,
  )) as Array<{ timestamp?: unknown }> | undefined;
  const timestamp = Number(rows?.[0]?.timestamp || 0);
  return Number.isFinite(timestamp) && timestamp > 0
    ? Math.floor(timestamp)
    : 0;
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

type CodexConversationRow = Parameters<typeof store.toSummary>[0];

const toCodexConversationSummary = store.toSummary;

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

const getMaxCodexConversationKey = store.getMaxConversationKey;

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
  conversationKey: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return;
  const repair =
    await repairRecoverableCodexCatalogMessageConversationIDs(normalizedKey);
  if (repair.refused > 0) {
    throw new Error(
      `Refused to delete Codex conversation ${normalizedKey}: ambiguous stale message ids found.`,
    );
  }
  await resolveRepairingMessageConversationSelector(normalizedKey, {
    destructive: true,
  });
}

export async function deleteCodexConversationLocalRows(
  conversationKey: number,
  identity?: {
    instanceID?: string;
    conversationID?: string;
    onBeforeCommit?: () => Promise<void>;
    onCommit?: () => Promise<void>;
  },
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return;
  let ledgerAvailable = isConversationKeyLedgerStoreInitialized();
  let ledgerEntry;
  if (ledgerAvailable) {
    try {
      ledgerEntry = await getConversationKeyLedgerEntry(normalizedKey);
    } catch (error) {
      if (!/no such table|no table/i.test(String(error))) throw error;
      ledgerAvailable = false;
    }
  }
  if (ledgerAvailable && !ledgerEntry) {
    throw new ConversationRetiredError(
      normalizedKey,
      identity?.instanceID || "",
    );
  }
  if (
    ledgerEntry?.retiredAt &&
    identity?.instanceID !== ledgerEntry.instanceID
  ) {
    throw new ConversationRetiredError(
      normalizedKey,
      identity?.instanceID || "",
    );
  }
  if (
    ledgerEntry &&
    identity?.instanceID &&
    identity.instanceID !== ledgerEntry.instanceID
  ) {
    throw new Error(
      `Refused to delete Codex conversation ${normalizedKey}: identity mismatch`,
    );
  }
  const deletionIdentity = ledgerEntry
    ? { ...(identity || {}), instanceID: ledgerEntry.instanceID }
    : identity;
  await preflightDeleteCodexConversationLocalRows(normalizedKey);
  const selector = await resolveRepairingMessageConversationSelector(
    normalizedKey,
    {
      destructive: true,
    },
  );
  const catalogIdentityClause = deletionIdentity?.instanceID
    ? `AND conversation_instance_id = ?`
    : "";
  const catalogIdentityParams = deletionIdentity?.instanceID
    ? [deletionIdentity.instanceID]
    : [];
  const messageIdentityClause = deletionIdentity?.instanceID
    ? `AND EXISTS (
         SELECT 1
         FROM ${CODEX_CONVERSATIONS_TABLE} c
         WHERE c.conversation_key = ?
           AND c.conversation_instance_id = ?
       )`
    : "";
  const messageIdentityParams = deletionIdentity?.instanceID
    ? [normalizedKey, deletionIdentity.instanceID]
    : [];
  await initConversationForkLinksStore();
  await initConversationRegistryStore();
  await initConversationSearchIndexStore();
  await initRecentlyDeletedConversationTombstones();
  await Zotero.DB.executeTransaction(async () => {
    if (deletionIdentity?.instanceID) {
      const witnessRows = (await Zotero.DB.queryAsync(
        `SELECT 1 AS present
         FROM ${CODEX_CONVERSATIONS_TABLE}
         WHERE conversation_key = ?
           ${catalogIdentityClause}
         LIMIT 1`,
        [normalizedKey, ...catalogIdentityParams],
      )) as Array<{ present?: unknown }> | undefined;
      if (!witnessRows?.length) {
        throw new Error(
          `Refused to delete Codex conversation ${normalizedKey}: catalog identity changed`,
        );
      }
    }
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CODEX_MESSAGES_TABLE}
       WHERE ${selector.whereSql}
         ${messageIdentityClause}
         ${deletionIdentity?.conversationID ? "AND conversation_id = ?" : ""}`,
      deletionIdentity?.conversationID
        ? [
            ...selector.params,
            ...messageIdentityParams,
            deletionIdentity.conversationID,
          ]
        : [...selector.params, ...messageIdentityParams],
    );
    await clearPersistedAgentConversationRowsInTransaction(normalizedKey);
    await clearOwnerAttachmentRefsInTransaction("conversation", normalizedKey);
    // A deleted conversation leaves no usage rows behind: the local usage
    // ledger is scoped to conversations the user can still see.
    await deleteUsageEventsForConversationInTransaction(normalizedKey);
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CODEX_CONVERSATIONS_TABLE}
       WHERE conversation_key = ?
         ${catalogIdentityClause}`,
      [normalizedKey, ...catalogIdentityParams],
    );
    await deleteConversationForkLinksForInstanceInTransaction({
      conversationKey: normalizedKey,
      conversationID: deletionIdentity?.conversationID,
      system: "codex",
    });
    if (deletionIdentity?.instanceID) {
      await deleteRegisteredConversationScopeInTransaction(
        deletionIdentity.instanceID,
        normalizedKey,
        deletionIdentity.conversationID,
        "codex",
      );
    }
    if (deletionIdentity?.instanceID) {
      await persistConversationInstanceTombstoneInTransaction({
        conversationKey: normalizedKey,
        instanceID: deletionIdentity.instanceID,
        conversationID: deletionIdentity.conversationID,
      });
    }
    await deleteConversationSearchIndexRowInTransaction({
      system: "codex",
      conversationKey: normalizedKey,
    });
    if (ledgerAvailable && deletionIdentity?.instanceID) {
      await retireConversationKeyInTransaction({
        conversationKey: normalizedKey,
        instanceID: deletionIdentity.instanceID,
      });
    }
    await deletionIdentity?.onBeforeCommit?.();
    await deletionIdentity?.onCommit?.();
  });
  if (deletionIdentity?.instanceID) {
    rememberConversationKeyRetired(normalizedKey);
  }
}

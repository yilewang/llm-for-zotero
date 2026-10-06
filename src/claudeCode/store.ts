declare const Zotero: any;

import type {
  ClaudeConversationSummary,
  ClaudeConversationKind,
} from "../shared/types";
import { normalizeGeneratedChatImages } from "../shared/generatedImages";
import {
  synthesizeSelectedTextContexts,
  normalizePaperContextRefs,
  normalizeCollectionContextRefs,
  normalizeTagContextRefs,
} from "../services/context/normalizers";
import { normalizeQuoteCitations } from "../services/quotes/quoteCitations";
import type { StoredChatMessage } from "../utils/chatStore";
import { serializeForcedSkillIds } from "../shared/skillIds";
import {
  isConversationKeyForKind,
  getConversationKeyRange,
} from "../shared/conversationKeySpace";
import { storedMessageDisplayOrderSql } from "../shared/conversationMessageSql";
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
import {
  AMBIGUOUS_PAPER_CONTEXT_INVALID_REASON,
  canMigrateLegacyAmbiguousPaperRegistryScope,
  getPaperContextOwnershipEvidenceFromRows,
  getRegisteredConversationScope,
  generateConversationInstanceID,
  initConversationRegistryStore,
  deleteRegisteredConversationScopeInTransaction,
  registerConversationScope,
  repairRegisteredConversationScope,
  syncCatalogInstanceID,
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
  allocateConversationKeyInTransaction,
  withRetiredKeyErrorMapping,
  nextUnissuedConversationKeyInRange,
  ConversationRetiredError,
  ensureConversationKeyLedgerEntry,
  ensureConversationKeyLedgerEntryInTransaction,
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
  updateConversationKeyLedgerConversationIDInTransaction,
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
  normalizeLimit,
  normalizePaperItemID,
} from "../shared/conversationStore/keyNormalization";
import { logConversationStoreWarning } from "../shared/conversationStore/diagnostics";
import { clearPersistedAgentConversationRowsInTransaction } from "../modules/contextPanel/agentConversationCleanup";
import { deleteUsageEventsForConversationInTransaction } from "../utils/usageStore";
import { clearOwnerAttachmentRefsInTransaction } from "../utils/attachmentRefStore";
import {
  createRuntimeConversationStore,
  ensureColumn,
  normalizeConversationTitleSeed,
} from "../services/providers/runtimeConversationStore";

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
  summaryExtraColumns: [],
  sessionResetColumns: [],
  keys: {
    allocatedRange: getClaudeAllocatedConversationKeyRange,
  },
  prefs: {
    setLastUsedPaper: setLastUsedClaudePaperConversationKey,
  },
});
const isClaudeStoreConversationKey = store.isStoreConversationKey;
const isClaudeStoreConversationKeyForKind = store.isStoreConversationKeyForKind;
const buildClaudeConversationID = store.buildConversationID;
const resolveClaudeAppendIdentity = store.resolveAppendIdentity;
const resolveRepairingMessageConversationSelector =
  store.resolveRepairingMessageConversationSelector;
const refreshClaudeConversationSearchIndex = store.refreshSearchIndex;
const backfillClaudeConversationTimestamps =
  store.backfillConversationTimestamps;
const refreshClaudeConversationCatalogSummary = store.refreshCatalogSummary;
const getClaudeMessagePaperContextRows = store.getMessagePaperContextRows;
const repairRecoverableClaudeCatalogMessageConversationIDs =
  store.repairRecoverableCatalogMessageConversationIDs;
const backfillClaudeConversationIDs = store.backfillConversationIDs;
const backfillClaudeConversationInstanceIDs =
  store.backfillConversationInstanceIDs;
const sameClaudeCatalogScope = store.sameCatalogScope;
function remapLegacyConversationKey(
  legacyConversationKey: number,
  kind: ClaudeConversationKind,
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
    return buildDefaultClaudePaperConversationKey(normalizedPaperItemID);
  }
  return buildDefaultClaudeGlobalConversationKey(normalizedLibraryID);
}

type ClaudeConversationKeyRemap = {
  legacyKey: number;
  targetKey: number;
  /** A retired key may contain an older owner's rows; never adopt them. */
  preserveLegacyRows?: boolean;
};

async function migrateLegacyClaudeConversationKeys(): Promise<
  ClaudeConversationKeyRemap[]
> {
  const remaps: ClaudeConversationKeyRemap[] = [];
  const rows = (await Zotero.DB.queryAsync(
    `SELECT conversation_key AS conversationKey,
            library_id AS libraryID,
            kind AS kind,
            paper_item_id AS paperItemID,
            updated_at AS updatedAt
     FROM ${CLAUDE_CONVERSATIONS_TABLE}
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
          ? getLastAllocatedClaudePaperConversationKey()
          : getLastAllocatedClaudeGlobalConversationKey()) || 0) + 1,
        (await getMaxClaudeConversationKey(kind)) + 1,
      );
      const range = getConversationKeyRange("claude_code", kind);
      targetConversationKey = await nextUnissuedConversationKeyInRange({
        start: range.start,
        endExclusive: range.endExclusive,
        atLeast: targetConversationKey,
      });
    }

    claimedKeys.add(targetConversationKey);
    if (targetConversationKey !== legacyConversationKey) {
      await rekeyConversationCatalogKeyInTransaction({
        table: CLAUDE_CONVERSATIONS_TABLE,
        legacyKey: legacyConversationKey,
        targetKey: targetConversationKey,
      });
      if (!legacyKeyWasRetired) {
        await Zotero.DB.queryAsync(
          `UPDATE ${CLAUDE_MESSAGES_TABLE}
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
      setLastUsedClaudeConversationMode(
        libraryID,
        kind === "paper" ? "paper" : "global",
      );
      latestModeByLibrary.add(libraryID);
    }
    if (kind === "paper" && paperItemID) {
      const paperStateKey = `${libraryID}:${paperItemID}`;
      if (!latestPaperByState.has(paperStateKey)) {
        stagePaperRestoreTargetForStartup(
          { system: "claude_code", libraryID, paperItemID },
          targetConversationKey,
        );
        latestPaperByState.add(paperStateKey);
      }
      setLastAllocatedClaudePaperConversationKey(targetConversationKey);
      continue;
    }
    if (!latestGlobalByLibrary.has(libraryID)) {
      setLastUsedClaudeGlobalConversationKey(libraryID, targetConversationKey);
      latestGlobalByLibrary.add(libraryID);
    }
    setLastAllocatedClaudeGlobalConversationKey(targetConversationKey);
  }
  return remaps;
}

async function ensureClaudeConversationCatalogColumns(
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
      CLAUDE_CONVERSATIONS_TABLE,
      columns,
      columnName,
      definition,
    );
  }
}

export async function repairClaudeConversationIdentityRegistry(
  options: { inTransaction?: boolean } = {},
): Promise<void> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT c.conversation_id AS conversationID,
            c.conversation_key AS conversationKey,
            c.library_id AS libraryID,
            c.kind AS kind,
            c.paper_item_id AS paperItemID,
            c.created_at AS createdAt,
            COALESCE(c.last_activity_at, c.updated_at, c.created_at) AS updatedAt,
            COALESCE(NULLIF(TRIM(c.title), ''), NULLIF(TRIM(c.first_user_title), '')) AS title,
            c.provider_session_id AS providerSessionId,
            c.scoped_conversation_key AS scopedConversationKey,
            c.scope_type AS scopeType,
            c.scope_id AS scopeId,
            c.scope_label AS scopeLabel,
            c.cwd AS cwd,
            c.model_name AS modelName,
            c.effort AS effort,
            COALESCE(c.user_turn_count, 0) AS userTurnCount
     FROM ${CLAUDE_CONVERSATIONS_TABLE} c
     ORDER BY updatedAt DESC, c.conversation_key DESC`,
  )) as ClaudeConversationRow[] | undefined;
  for (const row of rows || []) {
    const summary = toClaudeConversationSummary(row);
    if (!summary) continue;
    if (summary.kind === "paper") {
      const registered = await getRegisteredConversationScope(
        summary.conversationKey,
      );
      if (
        canMigrateLegacyAmbiguousPaperRegistryScope(registered, {
          system: "claude_code",
          kind: summary.kind,
          libraryID: summary.libraryID,
          paperItemID: summary.paperItemID,
        })
      ) {
        await repairRegisteredConversationScope(
          {
            conversationID: summary.conversationID,
            conversationKey: summary.conversationKey,
            system: "claude_code",
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
          `Migrated Claude conversation ${summary.conversationKey} from legacy ${AMBIGUOUS_PAPER_CONTEXT_INVALID_REASON} invalidation to primary paper ${summary.paperItemID}.`,
        );
        continue;
      }
      if (!summary.paperItemID) {
        const evidence = getPaperContextOwnershipEvidenceFromRows(
          await getClaudeMessagePaperContextRows(summary.conversationKey),
        );
        const inferredPaperItemID = evidence.singlePaperItemID;
        if (!inferredPaperItemID) continue;
        const repairedConversationID = buildClaudeConversationID({
          conversationKey: summary.conversationKey,
          kind: "paper",
          libraryID: summary.libraryID,
          paperItemID: inferredPaperItemID,
        });
        await Zotero.DB.queryAsync(
          `UPDATE ${CLAUDE_CONVERSATIONS_TABLE}
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
          `UPDATE ${CLAUDE_MESSAGES_TABLE}
           SET conversation_id = ?
           WHERE conversation_key = ?`,
          [repairedConversationID, summary.conversationKey],
        );
        await repairRegisteredConversationScope(
          {
            conversationKey: summary.conversationKey,
            system: "claude_code",
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
          `Repaired Claude conversation ${summary.conversationKey} to paper ${inferredPaperItemID} based on stored paper contexts.`,
        );
        continue;
      }
    }
    await registerConversationScope(
      {
        conversationID: summary.conversationID,
        conversationKey: summary.conversationKey,
        system: "claude_code",
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
export const CLAUDE_STORE_STARTUP_MIGRATION_IDS = [
  CONVERSATION_ID_TRANSITION_MIGRATION_ID,
  CONVERSATION_INSTANCE_ID_MIGRATION_IDS.claudeCode,
  CONVERSATION_KEY_LEDGER_MIGRATION_ID,
] as const;

/**
 * Bump when the startup schema pass changes in a way that must run inside a
 * transaction once (a new multi-statement repair, a table rebuild).
 */
const CLAUDE_STORE_STARTUP_SCHEMA_REVISION = 1;

export async function initClaudeCodeStore(): Promise<void> {
  const conversationIDTransitionAlreadyApplied =
    await hasConversationSchemaMigration(
      CONVERSATION_ID_TRANSITION_MIGRATION_ID,
    );
  const applyStartupSchema = async ({
    atomically,
  }: StartupSchemaPass): Promise<void> => {
    await initConversationRegistryStore();
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${CLAUDE_MESSAGES_TABLE} (
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
      `PRAGMA table_info(${CLAUDE_MESSAGES_TABLE})`,
    )) as Array<{ name?: unknown }> | undefined;
    await ensureColumn(
      CLAUDE_MESSAGES_TABLE,
      columns,
      "conversation_id",
      "conversation_id TEXT",
    );
    await ensureColumn(
      CLAUDE_MESSAGES_TABLE,
      columns,
      "conversation_instance_id",
      "conversation_instance_id TEXT",
    );
    await ensureColumn(
      CLAUDE_MESSAGES_TABLE,
      columns,
      "document_id",
      "document_id TEXT",
    );
    await ensureColumn(
      CLAUDE_MESSAGES_TABLE,
      columns,
      "selected_text_contexts_json",
      "selected_text_contexts_json TEXT",
    );
    const hasCompactMarkerColumn = Boolean(
      columns?.some((column) => column?.name === "compact_marker"),
    );
    if (!hasCompactMarkerColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CLAUDE_MESSAGES_TABLE}
         ADD COLUMN compact_marker INTEGER`,
      );
    }
    const hasContextTokensColumn = Boolean(
      columns?.some((column) => column?.name === "context_tokens"),
    );
    if (!hasContextTokensColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CLAUDE_MESSAGES_TABLE}
         ADD COLUMN context_tokens INTEGER`,
      );
    }
    const hasContextWindowColumn = Boolean(
      columns?.some((column) => column?.name === "context_window"),
    );
    if (!hasContextWindowColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CLAUDE_MESSAGES_TABLE}
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
        `ALTER TABLE ${CLAUDE_MESSAGES_TABLE}
         ADD COLUMN pdf_paper_contexts_json TEXT`,
      );
    }
    if (!hasCitationPaperContextsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CLAUDE_MESSAGES_TABLE}
         ADD COLUMN citation_paper_contexts_json TEXT`,
      );
    }
    const hasQuoteCitationsJsonColumn = Boolean(
      columns?.some((column) => column?.name === "quote_citations_json"),
    );
    if (!hasQuoteCitationsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CLAUDE_MESSAGES_TABLE}
         ADD COLUMN quote_citations_json TEXT`,
      );
    }
    await ensureColumn(
      CLAUDE_MESSAGES_TABLE,
      columns,
      "collection_contexts_json",
      "collection_contexts_json TEXT",
    );
    await ensureColumn(
      CLAUDE_MESSAGES_TABLE,
      columns,
      "tag_contexts_json",
      "tag_contexts_json TEXT",
    );
    await ensureColumn(
      CLAUDE_MESSAGES_TABLE,
      columns,
      "forced_skill_ids_json",
      "forced_skill_ids_json TEXT",
    );
    await ensureColumn(
      CLAUDE_MESSAGES_TABLE,
      columns,
      "generated_images_json",
      "generated_images_json TEXT",
    );
    await ensureColumn(
      CLAUDE_MESSAGES_TABLE,
      columns,
      "interrupted",
      "interrupted INTEGER",
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${CLAUDE_MESSAGES_INDEX}
       ON ${CLAUDE_MESSAGES_TABLE} (conversation_key, timestamp, id)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${CLAUDE_MESSAGES_ID_INDEX}
       ON ${CLAUDE_MESSAGES_TABLE} (conversation_id, timestamp, id)`,
    );

    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${CLAUDE_CONVERSATIONS_TABLE} (
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
      `PRAGMA table_info(${CLAUDE_CONVERSATIONS_TABLE})`,
    )) as Array<{ name?: unknown }> | undefined;
    await ensureClaudeConversationCatalogColumns(conversationColumns);
    let migratedKeyRemaps: ClaudeConversationKeyRemap[] = [];
    if (!conversationIDTransitionAlreadyApplied) {
      await backfillClaudeConversationTimestamps();
    }
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${CLAUDE_CONVERSATIONS_KIND_INDEX}
       ON ${CLAUDE_CONVERSATIONS_TABLE} (library_id, kind, paper_item_id, updated_at DESC, conversation_key DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${CLAUDE_CONVERSATIONS_ACTIVITY_INDEX}
       ON ${CLAUDE_CONVERSATIONS_TABLE} (library_id, kind, paper_item_id, last_activity_at DESC, updated_at DESC, conversation_key DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${CLAUDE_CONVERSATIONS_ID_INDEX}
       ON ${CLAUDE_CONVERSATIONS_TABLE} (conversation_id)`,
    );
    if (!conversationIDTransitionAlreadyApplied) {
      await initConversationKeyLedgerStore();
      await initRecentlyDeletedConversationTombstones();
      await seedConversationKeyLedgerFromTombstones();
      await reserveOrphanConversationMessageKeys({
        messageTable: CLAUDE_MESSAGES_TABLE,
        catalogTables: [CLAUDE_CONVERSATIONS_TABLE],
        system: "claude_code",
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
      migratedKeyRemaps = await migrateLegacyClaudeConversationKeys();
      await backfillClaudeConversationIDs();
      await repairClaudeConversationIdentityRegistry({ inTransaction: true });
      await refreshClaudeConversationCatalogSummary();
    }
    await runConversationSchemaMigrationOnce(
      CONVERSATION_INSTANCE_ID_MIGRATION_IDS.claudeCode,
      "Backfill immutable conversation instance identities for Claude catalogs and registry rows.",
      async () => {
        await backfillClaudeConversationIDs();
        await backfillClaudeConversationInstanceIDs();
        await repairClaudeConversationIdentityRegistry({ inTransaction: true });
      },
    );
    await refreshConversationKeyLedgerStore();
    await initRecentlyDeletedConversationTombstones();
    await runConversationSchemaMigrationOnce(
      CONVERSATION_KEY_LEDGER_MIGRATION_ID,
      "Reserve every existing Claude conversation key permanently and initialize the monotonic allocator.",
      async () => {
        await seedConversationKeyLedgerFromCatalogs([
          {
            table: CLAUDE_CONVERSATIONS_TABLE,
            system: "claude_code",
            kind: "global",
            kindColumn: true,
          },
          {
            table: CLAUDE_CONVERSATIONS_TABLE,
            system: "claude_code",
            kind: "paper",
            kindColumn: true,
          },
        ]);
      },
    );
    await seedConversationKeyLedgerFromCatalogs([
      {
        table: CLAUDE_CONVERSATIONS_TABLE,
        system: "claude_code",
        kind: "global",
        kindColumn: true,
      },
      {
        table: CLAUDE_CONVERSATIONS_TABLE,
        system: "claude_code",
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
      messageTable: CLAUDE_MESSAGES_TABLE,
      catalogTables: [CLAUDE_CONVERSATIONS_TABLE],
      system: "claude_code",
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
      system: "claude_code",
      kind: "global",
      catalogTables: [CLAUDE_CONVERSATIONS_TABLE],
      atomically,
    });
    await retireOrphanedConversationLedgerEntries({
      system: "claude_code",
      kind: "paper",
      catalogTables: [CLAUDE_CONVERSATIONS_TABLE],
      atomically,
    });
    const claudeGlobalRange = getClaudeAllocatedConversationKeyRange("global");
    const claudePaperRange = getClaudeAllocatedConversationKeyRange("paper");
    await initializeConversationKeyCounterInTransaction({
      system: "claude_code",
      kind: "global",
      start: claudeGlobalRange.start,
      endExclusive: claudeGlobalRange.endExclusive,
      profileSignature: getClaudeProfileSignature(),
    });
    await initializeConversationKeyCounterInTransaction({
      system: "claude_code",
      kind: "paper",
      start: claudePaperRange.start,
      endExclusive: claudePaperRange.endExclusive,
      profileSignature: getClaudeProfileSignature(),
    });
    await Zotero.DB.queryAsync(
      `UPDATE ${CLAUDE_MESSAGES_TABLE}
       SET conversation_instance_id = (
         SELECT c.conversation_instance_id
         FROM ${CLAUDE_CONVERSATIONS_TABLE} c
         WHERE c.conversation_key = ${CLAUDE_MESSAGES_TABLE}.conversation_key
       )
       WHERE conversation_instance_id IS NULL
          OR TRIM(conversation_instance_id) = ''`,
    );
    await installConversationKeyLedgerCatalogTriggers([
      CLAUDE_CONVERSATIONS_TABLE,
    ]);
    await installConversationKeyLedgerMessageTriggers({
      messageTable: CLAUDE_MESSAGES_TABLE,
    });
  };
  await runConversationStoreStartupSchema({
    storeID: "claude-code",
    schemaRevision: CLAUDE_STORE_STARTUP_SCHEMA_REVISION,
    migrationIDs: CLAUDE_STORE_STARTUP_MIGRATION_IDS,
    body: applyStartupSchema,
  });
}

export async function appendClaudeMessage(
  conversationKey: number,
  message: StoredChatMessage,
  instanceID?: string,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isClaudeStoreConversationKey(normalizedKey)) return;
  if (pendingDeletionStore.isConversationPendingDeletion(normalizedKey)) {
    throw new Error(
      `Conversation ${normalizedKey} is frozen by a pending deletion`,
    );
  }

  const selectedTextContexts = synthesizeSelectedTextContexts({
    selectedTextContexts: message.selectedTextContexts,
    selectedTexts: message.selectedTexts,
    legacySelectedText: message.selectedText,
    selectedTextSources: message.selectedTextSources,
    selectedTextPaperContexts: message.selectedTextPaperContexts,
    selectedTextNoteContexts: message.selectedTextNoteContexts,
  });
  const selectedTexts = selectedTextContexts.map((context) => context.text);
  const selectedTextSources = selectedTextContexts.map(
    (context) => context.source,
  );
  const selectedTextPaperContexts = selectedTextContexts.map(
    (context) => context.paperContext,
  );
  const selectedTextNoteContexts = selectedTextContexts.map(
    (context) => context.noteContext,
  );
  const paperContexts = normalizePaperContextRefs(message.paperContexts);
  const pdfPaperContexts = normalizePaperContextRefs(
    message.pdfPaperContexts,
  ).map((context) => ({ ...context, contentSourceMode: "pdf" as const }));
  const fullTextPaperContexts = normalizePaperContextRefs(
    message.fullTextPaperContexts,
  );
  const citationPaperContexts = normalizePaperContextRefs(
    message.citationPaperContexts,
  );
  const quoteCitations = normalizeQuoteCitations(message.quoteCitations);
  const selectedCollectionContexts = normalizeCollectionContextRefs(
    message.selectedCollectionContexts,
  );
  const selectedTagContexts = normalizeTagContextRefs(
    message.selectedTagContexts,
  );
  const screenshotImages = Array.isArray(message.screenshotImages)
    ? message.screenshotImages.filter(
        (entry): entry is string =>
          typeof entry === "string" && Boolean(entry.trim()),
      )
    : [];
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.filter(
        (entry) => entry && typeof entry.id === "string" && entry.id.trim(),
      )
    : [];
  const generatedImages = normalizeGeneratedChatImages(message.generatedImages);
  const appendIdentity = await resolveClaudeAppendIdentity(
    normalizedKey,
    instanceID,
  );
  const conversationID = appendIdentity.conversationID;

  // The database fence is the authority on retirement; translate its abort
  // so callers keep the typed error the removed pre-check used to raise.
  await withRetiredKeyErrorMapping(
    normalizedKey,
    appendIdentity.instanceID || "",
    () =>
      Zotero.DB.executeTransaction(async () => {
        if (appendIdentity.ledgerAvailable) {
          const catalogRows = (await Zotero.DB.queryAsync(
            `SELECT conversation_id AS conversationID
         FROM ${CLAUDE_CONVERSATIONS_TABLE}
         WHERE conversation_key = ?
           AND conversation_instance_id = ?
         LIMIT 1`,
            [normalizedKey, appendIdentity.instanceID],
          )) as Array<{ conversationID?: unknown }> | undefined;
          if (!catalogRows?.length) {
            throw new ConversationRetiredError(
              normalizedKey,
              appendIdentity.instanceID || "",
            );
          }
        }
        const identityAvailable =
          appendIdentity.ledgerAvailable || Boolean(appendIdentity.instanceID);
        const identityColumn = identityAvailable
          ? ", conversation_instance_id"
          : "";
        const identityPlaceholder = identityAvailable ? ", ?" : "";
        await Zotero.DB.queryAsync(
          `INSERT INTO ${CLAUDE_MESSAGES_TABLE}
        (conversation_id, conversation_key, role, text, timestamp, run_mode, agent_run_id, selected_text, selected_text_contexts_json, selected_texts_json, selected_text_sources_json, selected_text_paper_contexts_json, selected_text_note_contexts_json, forced_skill_ids_json, paper_contexts_json, pdf_paper_contexts_json, full_text_paper_contexts_json, citation_paper_contexts_json, quote_citations_json, collection_contexts_json, tag_contexts_json, screenshot_images, attachments_json, generated_images_json, model_name, model_entry_id, model_provider_label, interrupted, webchat_run_state, webchat_completion_reason, reasoning_summary, reasoning_details, compact_marker, context_tokens, context_window, document_id${identityColumn})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${identityPlaceholder})`,
          [
            conversationID,
            normalizedKey,
            message.role,
            message.text || "",
            Number.isFinite(message.timestamp)
              ? Math.floor(message.timestamp)
              : Date.now(),
            message.runMode || null,
            message.agentRunId || null,
            selectedTexts[0] || message.selectedText || null,
            selectedTextContexts.length
              ? JSON.stringify(selectedTextContexts)
              : null,
            selectedTexts.length ? JSON.stringify(selectedTexts) : null,
            selectedTextSources.length
              ? JSON.stringify(selectedTextSources)
              : null,
            selectedTextPaperContexts.some((entry) => Boolean(entry))
              ? JSON.stringify(selectedTextPaperContexts)
              : null,
            selectedTextNoteContexts.some((entry) => Boolean(entry))
              ? JSON.stringify(selectedTextNoteContexts)
              : null,
            message.role === "user"
              ? serializeForcedSkillIds(message.forcedSkillIds)
              : null,
            paperContexts.length ? JSON.stringify(paperContexts) : null,
            pdfPaperContexts.length ? JSON.stringify(pdfPaperContexts) : null,
            fullTextPaperContexts.length
              ? JSON.stringify(fullTextPaperContexts)
              : null,
            citationPaperContexts.length
              ? JSON.stringify(citationPaperContexts)
              : null,
            quoteCitations.length ? JSON.stringify(quoteCitations) : null,
            selectedCollectionContexts.length
              ? JSON.stringify(selectedCollectionContexts)
              : null,
            selectedTagContexts.length
              ? JSON.stringify(selectedTagContexts)
              : null,
            screenshotImages.length ? JSON.stringify(screenshotImages) : null,
            attachments.length ? JSON.stringify(attachments) : null,
            generatedImages.length ? JSON.stringify(generatedImages) : null,
            message.modelName || null,
            message.modelEntryId || null,
            message.modelProviderLabel || null,
            message.interrupted ? 1 : null,
            message.webchatRunState || null,
            message.webchatCompletionReason || null,
            message.reasoningSummary || null,
            message.reasoningDetails || null,
            message.compactMarker ? 1 : 0,
            Number.isFinite(Number(message.contextTokens))
              ? Math.floor(Number(message.contextTokens))
              : null,
            Number.isFinite(Number(message.contextWindow))
              ? Math.floor(Number(message.contextWindow))
              : null,
            message.documentId || message.planDocumentId || null,
            ...(identityAvailable ? [appendIdentity.instanceID] : []),
          ],
        );
        await refreshClaudeConversationCatalogSummary(normalizedKey);
      }),
  );
  await refreshClaudeConversationSearchIndex(normalizedKey);
}

export async function loadClaudeConversation(
  ...args: Parameters<typeof store.loadConversation>
) {
  return store.loadConversation(...args);
}

export async function clearClaudeConversation(
  conversationKey: number,
  identity?: { instanceID?: string; conversationID?: string },
  onBeforeCommit?: () => Promise<void>,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isClaudeStoreConversationKey(normalizedKey)) return;
  const catalogIdentityClause = identity?.instanceID
    ? `AND conversation_instance_id = ?`
    : "";
  const catalogIdentityParams = identity?.instanceID
    ? [identity.instanceID]
    : [];
  const messageIdentityClause = identity?.instanceID
    ? `AND EXISTS (
         SELECT 1
         FROM ${CLAUDE_CONVERSATIONS_TABLE} c
         WHERE c.conversation_key = ?
           ${catalogIdentityClause.replaceAll(
             "conversation_instance_id",
             "c.conversation_instance_id",
           )}
       )`
    : "";
  const messageIdentityParams = identity?.instanceID
    ? [normalizedKey, ...catalogIdentityParams]
    : [];
  const selector = await resolveRepairingMessageConversationSelector(
    normalizedKey,
    {
      destructive: true,
    },
  );
  // Remove the old indexed body in the same transaction as pruning.  The
  // post-commit refresh is best-effort, but it must never leave deleted text
  // searchable if that refresh is interrupted or the database is transiently
  // unavailable.
  const searchIndexReady = await initConversationSearchIndexStore();
  await Zotero.DB.executeTransaction(async () => {
    if (identity?.instanceID) {
      const witnessRows = (await Zotero.DB.queryAsync(
        `SELECT 1 AS present
         FROM ${CLAUDE_CONVERSATIONS_TABLE}
         WHERE conversation_key = ?
           ${catalogIdentityClause}
         LIMIT 1`,
        [normalizedKey, ...catalogIdentityParams],
      )) as Array<{ present?: unknown }> | undefined;
      if (!witnessRows?.length) {
        throw new Error(
          `Refused to clear Claude conversation ${normalizedKey}: catalog identity changed`,
        );
      }
    }
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CLAUDE_MESSAGES_TABLE}
       WHERE ${selector.whereSql}
         ${messageIdentityClause}`,
      [...selector.params, ...messageIdentityParams],
    );
    await refreshClaudeConversationCatalogSummary(normalizedKey);
    // Clear is content-authoritative.  Detach the exact native session in the
    // same transaction so a provider-resume path cannot reintroduce the
    // cleared turns if the adapter is unavailable after commit.
    await Zotero.DB.queryAsync(
      `UPDATE ${CLAUDE_CONVERSATIONS_TABLE}
       SET provider_session_id = NULL,
           scoped_conversation_key = NULL,
           scope_type = NULL,
           scope_id = NULL,
           scope_label = NULL,
           cwd = NULL,
           updated_at = ?
       WHERE conversation_key = ?
         ${catalogIdentityClause}`,
      [Date.now(), normalizedKey, ...catalogIdentityParams],
    );
    await onBeforeCommit?.();
  });
  await refreshClaudeConversationSearchIndex(normalizedKey);
}

export async function deleteClaudeTurnMessages(
  conversationKey: number,
  userTimestamp: number,
  assistantTimestamp: number,
  userMessageID?: number,
  assistantMessageID?: number,
  onBeforeCommit?: () => Promise<void>,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isClaudeStoreConversationKey(normalizedKey)) return;
  const normalizedUserTimestamp = Number.isFinite(userTimestamp)
    ? Math.floor(userTimestamp)
    : 0;
  const normalizedAssistantTimestamp = Number.isFinite(assistantTimestamp)
    ? Math.floor(assistantTimestamp)
    : 0;
  if (normalizedUserTimestamp <= 0 || normalizedAssistantTimestamp <= 0) return;
  const normalizedUserMessageID =
    Number.isFinite(Number(userMessageID)) && Number(userMessageID) > 0
      ? Math.floor(Number(userMessageID))
      : 0;
  const normalizedAssistantMessageID =
    Number.isFinite(Number(assistantMessageID)) &&
    Number(assistantMessageID) > 0
      ? Math.floor(Number(assistantMessageID))
      : 0;

  const selector = await resolveRepairingMessageConversationSelector(
    normalizedKey,
    {
      destructive: true,
    },
  );
  const searchIndexReady = await initConversationSearchIndexStore();
  await Zotero.DB.executeTransaction(async () => {
    if (normalizedUserMessageID > 0) {
      await Zotero.DB.queryAsync(
        `DELETE FROM ${CLAUDE_MESSAGES_TABLE}
         WHERE id = ? AND ${selector.whereSql} AND role = 'user'`,
        [normalizedUserMessageID, ...selector.params],
      );
    } else {
      await Zotero.DB.queryAsync(
        `DELETE FROM ${CLAUDE_MESSAGES_TABLE}
         WHERE id = (
           SELECT id
           FROM ${CLAUDE_MESSAGES_TABLE}
           WHERE ${selector.whereSql}
             AND role = 'user'
             AND timestamp = ?
           ORDER BY id DESC
           LIMIT 1
         )`,
        [...selector.params, normalizedUserTimestamp],
      );
    }
    if (normalizedAssistantMessageID > 0) {
      await Zotero.DB.queryAsync(
        `DELETE FROM ${CLAUDE_MESSAGES_TABLE}
         WHERE id = ? AND ${selector.whereSql} AND role = 'assistant'`,
        [normalizedAssistantMessageID, ...selector.params],
      );
    } else {
      await Zotero.DB.queryAsync(
        `DELETE FROM ${CLAUDE_MESSAGES_TABLE}
         WHERE id = (
           SELECT id
           FROM ${CLAUDE_MESSAGES_TABLE}
           WHERE ${selector.whereSql}
             AND role = 'assistant'
             AND timestamp = ?
           ORDER BY id DESC
           LIMIT 1
         )`,
        [...selector.params, normalizedAssistantTimestamp],
      );
    }
    await refreshClaudeConversationCatalogSummary(normalizedKey);
    if (searchIndexReady) {
      await deleteConversationSearchIndexRowInTransaction({
        system: "claude_code",
        conversationKey: normalizedKey,
      });
    }
    await onBeforeCommit?.();
  });
  await refreshClaudeConversationSearchIndex(normalizedKey);
}

export async function pruneClaudeConversation(
  conversationKey: number,
  keep = CLAUDE_HISTORY_LIMIT,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isClaudeStoreConversationKey(normalizedKey)) return;
  const selector = await resolveRepairingMessageConversationSelector(
    normalizedKey,
    {
      destructive: true,
    },
  );
  const searchIndexReady = await initConversationSearchIndexStore();
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CLAUDE_MESSAGES_TABLE}
       WHERE id IN (
         SELECT id
         FROM ${CLAUDE_MESSAGES_TABLE}
         WHERE ${selector.whereSql}
         ORDER BY ${storedMessageDisplayOrderSql({ direction: "desc" })}
         LIMIT -1 OFFSET ?
      )`,
      [...selector.params, normalizeLimit(keep, CLAUDE_HISTORY_LIMIT)],
    );
    await refreshClaudeConversationCatalogSummary(normalizedKey);
    if (searchIndexReady) {
      await deleteConversationSearchIndexRowInTransaction({
        system: "claude_code",
        conversationKey: normalizedKey,
      });
    }
  });
  await refreshClaudeConversationSearchIndex(normalizedKey);
}

export async function updateLatestClaudeUserMessage(
  conversationKey: number,
  message: Pick<
    StoredChatMessage,
    | "text"
    | "timestamp"
    | "runMode"
    | "agentRunId"
    | "documentId"
    | "planDocumentId"
    | "selectedText"
    | "selectedTextContexts"
    | "selectedTexts"
    | "selectedTextSources"
    | "selectedTextPaperContexts"
    | "selectedTextNoteContexts"
    | "forcedSkillIds"
    | "paperContexts"
    | "pdfPaperContexts"
    | "fullTextPaperContexts"
    | "citationPaperContexts"
    | "selectedCollectionContexts"
    | "selectedTagContexts"
    | "screenshotImages"
    | "attachments"
  >,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isClaudeStoreConversationKey(normalizedKey)) return;
  const selectedTextContexts = synthesizeSelectedTextContexts({
    selectedTextContexts: message.selectedTextContexts,
    selectedTexts: message.selectedTexts,
    legacySelectedText: message.selectedText,
    selectedTextSources: message.selectedTextSources,
    selectedTextPaperContexts: message.selectedTextPaperContexts,
    selectedTextNoteContexts: message.selectedTextNoteContexts,
  });
  const selectedTexts = selectedTextContexts.map((context) => context.text);
  const selectedTextSources = selectedTextContexts.map(
    (context) => context.source,
  );
  const selectedTextPaperContexts = selectedTextContexts.map(
    (context) => context.paperContext,
  );
  const selectedTextNoteContexts = selectedTextContexts.map(
    (context) => context.noteContext,
  );
  const selectedCollectionContexts = normalizeCollectionContextRefs(
    message.selectedCollectionContexts,
  );
  const selectedTagContexts = normalizeTagContextRefs(
    message.selectedTagContexts,
  );
  const selector =
    await resolveRepairingMessageConversationSelector(normalizedKey);
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `UPDATE ${CLAUDE_MESSAGES_TABLE}
       SET text = ?,
           timestamp = ?,
           run_mode = ?,
           agent_run_id = ?,
           document_id = ?,
           selected_text = ?,
           selected_text_contexts_json = ?,
           selected_texts_json = ?,
           selected_text_sources_json = ?,
           selected_text_paper_contexts_json = ?,
           selected_text_note_contexts_json = ?,
           forced_skill_ids_json = ?,
           paper_contexts_json = ?,
           pdf_paper_contexts_json = ?,
           full_text_paper_contexts_json = ?,
           citation_paper_contexts_json = ?,
           collection_contexts_json = ?,
           tag_contexts_json = ?,
           screenshot_images = ?,
           attachments_json = ?
       WHERE id = (
         SELECT id
         FROM ${CLAUDE_MESSAGES_TABLE}
         WHERE ${selector.whereSql} AND role = 'user'
         ORDER BY timestamp DESC, id DESC
         LIMIT 1
       )`,
      [
        message.text || "",
        Number.isFinite(message.timestamp)
          ? Math.floor(message.timestamp)
          : Date.now(),
        message.runMode || null,
        message.agentRunId || null,
        message.documentId || message.planDocumentId || null,
        selectedTexts[0] || null,
        selectedTextContexts.length
          ? JSON.stringify(selectedTextContexts)
          : null,
        selectedTexts.length ? JSON.stringify(selectedTexts) : null,
        selectedTextSources.length ? JSON.stringify(selectedTextSources) : null,
        selectedTextPaperContexts.some((entry) => Boolean(entry))
          ? JSON.stringify(selectedTextPaperContexts)
          : null,
        selectedTextNoteContexts.some((entry) => Boolean(entry))
          ? JSON.stringify(selectedTextNoteContexts)
          : null,
        serializeForcedSkillIds(message.forcedSkillIds),
        message.paperContexts?.length
          ? JSON.stringify(normalizePaperContextRefs(message.paperContexts))
          : null,
        message.pdfPaperContexts?.length
          ? JSON.stringify(
              normalizePaperContextRefs(message.pdfPaperContexts).map(
                (context) => ({
                  ...context,
                  contentSourceMode: "pdf" as const,
                }),
              ),
            )
          : null,
        message.fullTextPaperContexts?.length
          ? JSON.stringify(
              normalizePaperContextRefs(message.fullTextPaperContexts),
            )
          : null,
        message.citationPaperContexts?.length
          ? JSON.stringify(
              normalizePaperContextRefs(message.citationPaperContexts),
            )
          : null,
        selectedCollectionContexts.length
          ? JSON.stringify(selectedCollectionContexts)
          : null,
        selectedTagContexts.length ? JSON.stringify(selectedTagContexts) : null,
        message.screenshotImages?.length
          ? JSON.stringify(message.screenshotImages)
          : null,
        message.attachments?.length
          ? JSON.stringify(message.attachments)
          : null,
        ...selector.params,
      ],
    );
    await refreshClaudeConversationCatalogSummary(normalizedKey);
  });
  await refreshClaudeConversationSearchIndex(normalizedKey);
}

export async function updateLatestClaudeAssistantMessage(
  conversationKey: number,
  message: Pick<
    StoredChatMessage,
    | "text"
    | "timestamp"
    | "runMode"
    | "agentRunId"
    | "documentId"
    | "planDocumentId"
    | "modelName"
    | "modelEntryId"
    | "modelProviderLabel"
    | "interrupted"
    | "webchatRunState"
    | "webchatCompletionReason"
    | "reasoningSummary"
    | "reasoningDetails"
    | "compactMarker"
    | "contextTokens"
    | "contextWindow"
    | "quoteCitations"
    | "generatedImages"
  >,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isClaudeStoreConversationKey(normalizedKey)) return;
  const quoteCitations = normalizeQuoteCitations(message.quoteCitations);
  const generatedImages = normalizeGeneratedChatImages(message.generatedImages);
  const selector =
    await resolveRepairingMessageConversationSelector(normalizedKey);
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `UPDATE ${CLAUDE_MESSAGES_TABLE}
       SET text = ?,
           timestamp = ?,
           run_mode = ?,
           agent_run_id = ?,
           document_id = ?,
           model_name = ?,
           model_entry_id = ?,
           model_provider_label = ?,
           interrupted = ?,
           webchat_run_state = ?,
           webchat_completion_reason = ?,
           reasoning_summary = ?,
           reasoning_details = ?,
           compact_marker = ?,
           quote_citations_json = ?,
           generated_images_json = ?,
           context_tokens = COALESCE(?, context_tokens),
           context_window = COALESCE(?, context_window)
       WHERE id = (
         SELECT id
         FROM ${CLAUDE_MESSAGES_TABLE}
         WHERE ${selector.whereSql} AND role = 'assistant'
         ORDER BY timestamp DESC, id DESC
         LIMIT 1
       )`,
      [
        message.text || "",
        Number.isFinite(message.timestamp)
          ? Math.floor(message.timestamp)
          : Date.now(),
        message.runMode || null,
        message.agentRunId || null,
        message.documentId || message.planDocumentId || null,
        message.modelName || null,
        message.modelEntryId || null,
        message.modelProviderLabel || null,
        message.interrupted ? 1 : null,
        message.webchatRunState || null,
        message.webchatCompletionReason || null,
        message.reasoningSummary || null,
        message.reasoningDetails || null,
        message.compactMarker ? 1 : 0,
        quoteCitations.length ? JSON.stringify(quoteCitations) : null,
        generatedImages.length ? JSON.stringify(generatedImages) : null,
        Number.isFinite(Number(message.contextTokens)) &&
        Number(message.contextTokens) > 0
          ? Math.floor(Number(message.contextTokens))
          : null,
        Number.isFinite(Number(message.contextWindow)) &&
        Number(message.contextWindow) > 0
          ? Math.floor(Number(message.contextWindow))
          : null,
        ...selector.params,
      ],
    );
    await refreshClaudeConversationCatalogSummary(normalizedKey);
  });
  await refreshClaudeConversationSearchIndex(normalizedKey);
}

type ClaudeConversationRow = Parameters<typeof store.toSummary>[0];

const toClaudeConversationSummary = store.toSummary;

export async function getClaudeConversationSummary(
  ...args: Parameters<typeof store.getSummary>
) {
  return store.getSummary(...args);
}

export async function upsertClaudeConversationSummary(params: {
  conversationKey: number;
  instanceID?: string;
  conversationID?: string;
  libraryID: number;
  kind: ClaudeConversationKind;
  paperItemID?: number;
  createdAt?: number;
  updatedAt?: number;
  title?: string;
  providerSessionId?: string;
  scopedConversationKey?: string;
  scopeType?: string;
  scopeId?: string;
  scopeLabel?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  inTransaction?: boolean;
}): Promise<boolean> {
  const conversationKey = normalizeConversationKey(params.conversationKey);
  const libraryID = normalizeLibraryID(params.libraryID);
  if (
    !conversationKey ||
    !libraryID ||
    !isClaudeStoreConversationKeyForKind(conversationKey, params.kind)
  ) {
    return false;
  }
  const createdAt = normalizeCatalogTimestamp(params.createdAt);
  const updatedAt = normalizeCatalogTimestamp(params.updatedAt);
  const paperItemID = normalizePaperItemID(Number(params.paperItemID));
  const title = normalizeConversationTitleSeed(params.title || "") || null;
  const conversationID =
    params.conversationID?.trim() ||
    buildClaudeConversationID({
      conversationKey,
      kind: params.kind,
      libraryID,
      paperItemID,
    });
  const existing = await getClaudeConversationSummary(conversationKey);
  if (
    existing &&
    !sameClaudeCatalogScope(existing, {
      libraryID,
      kind: params.kind,
      paperItemID,
    })
  ) {
    logConversationStoreWarning(
      `Refused to reassign Claude conversation ${conversationKey} from ${existing.kind}/${existing.libraryID}/${existing.paperItemID || ""} to ${params.kind}/${libraryID}/${paperItemID || ""}.`,
    );
    return false;
  }
  let instanceID = params.instanceID?.trim() || "";
  if (!instanceID) {
    const registered = await getRegisteredConversationScope(conversationKey);
    instanceID = registered?.instanceID || "";
  }
  if (!instanceID) instanceID = generateConversationInstanceID();
  try {
    const ensureLedgerEntry = params.inTransaction
      ? ensureConversationKeyLedgerEntryInTransaction
      : ensureConversationKeyLedgerEntry;
    await ensureLedgerEntry({
      conversationKey,
      instanceID,
      conversationID,
      system: "claude_code",
      kind: params.kind,
      profileSignature: getClaudeProfileSignature(),
      libraryID,
      paperItemID: paperItemID || undefined,
      issuedAt: createdAt,
    });
  } catch (error) {
    logConversationStoreWarning(String(error));
    return false;
  }
  const registryOk = await registerConversationScope(
    {
      conversationID,
      instanceID,
      conversationKey,
      system: "claude_code",
      kind: params.kind,
      libraryID,
      paperItemID,
      createdAt,
      updatedAt,
      title,
    },
    { inTransaction: params.inTransaction },
  );
  if (!registryOk) return false;
  const writeCatalog = async () => {
    await Zotero.DB.queryAsync(
      `INSERT INTO ${CLAUDE_CONVERSATIONS_TABLE}
        (conversation_id, conversation_instance_id, conversation_key, library_id, kind, paper_item_id, created_at, updated_at, last_activity_at, user_turn_count, first_user_title, title, provider_session_id, scoped_conversation_key, scope_type, scope_id, scope_label, cwd, model_name, effort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_key) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         library_id = excluded.library_id,
         kind = excluded.kind,
         paper_item_id = excluded.paper_item_id,
         created_at = COALESCE(${CLAUDE_CONVERSATIONS_TABLE}.created_at, excluded.created_at),
         updated_at = excluded.updated_at,
         last_activity_at = COALESCE(excluded.last_activity_at, ${CLAUDE_CONVERSATIONS_TABLE}.last_activity_at, excluded.updated_at),
         title = COALESCE(excluded.title, ${CLAUDE_CONVERSATIONS_TABLE}.title),
         provider_session_id = COALESCE(excluded.provider_session_id, ${CLAUDE_CONVERSATIONS_TABLE}.provider_session_id),
         scoped_conversation_key = COALESCE(excluded.scoped_conversation_key, ${CLAUDE_CONVERSATIONS_TABLE}.scoped_conversation_key),
         scope_type = COALESCE(excluded.scope_type, ${CLAUDE_CONVERSATIONS_TABLE}.scope_type),
         scope_id = COALESCE(excluded.scope_id, ${CLAUDE_CONVERSATIONS_TABLE}.scope_id),
         scope_label = COALESCE(excluded.scope_label, ${CLAUDE_CONVERSATIONS_TABLE}.scope_label),
         cwd = COALESCE(excluded.cwd, ${CLAUDE_CONVERSATIONS_TABLE}.cwd),
         model_name = COALESCE(excluded.model_name, ${CLAUDE_CONVERSATIONS_TABLE}.model_name),
         effort = COALESCE(excluded.effort, ${CLAUDE_CONVERSATIONS_TABLE}.effort)`,
      [
        conversationID,
        instanceID,
        conversationKey,
        libraryID,
        params.kind,
        paperItemID || null,
        createdAt,
        updatedAt,
        updatedAt,
        title,
        params.providerSessionId?.trim() || null,
        params.scopedConversationKey?.trim() || null,
        params.scopeType?.trim() || null,
        params.scopeId?.trim() || null,
        params.scopeLabel?.trim() || null,
        params.cwd?.trim() || null,
        params.model?.trim() || null,
        params.effort?.trim() || null,
      ],
    );
    await refreshClaudeConversationCatalogSummary(conversationKey);
  };
  if (params.inTransaction) {
    await writeCatalog();
  } else {
    await Zotero.DB.executeTransaction(writeCatalog);
  }
  if (!params.inTransaction) {
    const registered = await getRegisteredConversationScope(conversationKey);
    if (registered) await syncCatalogInstanceID(registered);
    await refreshClaudeConversationSearchIndex(conversationKey);
  }
  return true;
}

const listClaudeConversations = store.listConversations;

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
  libraryID: number,
  preferredConversationKey?: number,
): Promise<ClaudeConversationSummary | null> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  if (!normalizedLibraryID) return null;
  const existing = await listClaudeConversations({
    libraryID: normalizedLibraryID,
    kind: "global",
    limit: 1,
  });
  return (
    existing[0] ||
    createClaudeGlobalConversation(normalizedLibraryID, {
      conversationKey: preferredConversationKey,
    })
  );
}

export async function ensureClaudePaperConversation(
  libraryID: number,
  paperItemID: number,
  preferredConversationKey?: number,
): Promise<ClaudeConversationSummary | null> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  const normalizedPaperItemID = normalizePaperItemID(paperItemID);
  if (!normalizedLibraryID || !normalizedPaperItemID) return null;
  const existing = await listClaudeConversations({
    libraryID: normalizedLibraryID,
    kind: "paper",
    paperItemID: normalizedPaperItemID,
    limit: 1,
  });
  return (
    existing[0] ||
    createClaudePaperConversation(normalizedLibraryID, normalizedPaperItemID, {
      conversationKey: preferredConversationKey,
    })
  );
}

const getMaxClaudeConversationKey = store.getMaxConversationKey;

async function allocateClaudeConversationKey(params: {
  libraryID: number;
  kind: ClaudeConversationKind;
  paperItemID?: number;
  issuedAt: number;
  preferredConversationKey?: number;
  inTransaction?: boolean;
}): Promise<{
  conversationKey: number;
  instanceID: string;
  conversationID: string;
}> {
  await initConversationKeyLedgerStore();
  const preferredKey = normalizeConversationKey(
    params.preferredConversationKey || 0,
  );
  if (
    preferredKey &&
    !isConversationKeyForKind("claude_code", params.kind, preferredKey)
  ) {
    throw new Error("Preferred Claude conversation key is outside its range");
  }
  const allocate = async () => {
    if (preferredKey) {
      const instanceID = generateConversationInstanceID();
      const conversationID = buildClaudeConversationID({
        conversationKey: preferredKey,
        kind: params.kind,
        libraryID: params.libraryID,
        paperItemID: params.paperItemID,
      });
      await ensureConversationKeyLedgerEntryInTransaction({
        conversationKey: preferredKey,
        instanceID,
        conversationID,
        system: "claude_code",
        kind: params.kind,
        profileSignature: getClaudeProfileSignature(),
        libraryID: params.libraryID,
        paperItemID: params.paperItemID,
        issuedAt: params.issuedAt,
      });
      return { conversationKey: preferredKey, instanceID, conversationID };
    }
    const issued = await allocateConversationKeyInTransaction({
      range: {
        system: "claude_code",
        kind: params.kind,
        start: getClaudeAllocatedConversationKeyRange(params.kind).start,
        endExclusive: getClaudeAllocatedConversationKeyRange(params.kind)
          .endExclusive,
        profileSignature: getClaudeProfileSignature(),
      },
      libraryID: params.libraryID,
      paperItemID: params.paperItemID,
      issuedAt: params.issuedAt,
    });
    const conversationID = buildClaudeConversationID({
      conversationKey: issued.conversationKey,
      kind: params.kind,
      libraryID: params.libraryID,
      paperItemID: params.paperItemID,
    });
    await updateConversationKeyLedgerConversationIDInTransaction({
      conversationKey: issued.conversationKey,
      instanceID: issued.instanceID,
      conversationID,
    });
    return {
      conversationKey: issued.conversationKey,
      instanceID: issued.instanceID,
      conversationID,
    };
  };
  const allocated = params.inTransaction
    ? await allocate()
    : await Zotero.DB.executeTransaction(allocate);
  return {
    conversationKey: allocated.conversationKey,
    instanceID: allocated.instanceID,
    conversationID: allocated.conversationID,
  };
}

async function retireClaudeAllocationAfterCreateFailure(params: {
  conversationKey: number;
  instanceID: string;
  conversationID: string;
}): Promise<void> {
  await Zotero.DB.executeTransaction(async () => {
    await deleteRegisteredConversationScopeInTransaction(
      params.instanceID,
      params.conversationKey,
      params.conversationID,
      "claude_code",
    );
    await retireConversationKeyInTransaction({
      conversationKey: params.conversationKey,
      instanceID: params.instanceID,
      reason: "conversation-create-failed",
    });
  });
  rememberConversationKeyRetired(params.conversationKey);
}

export async function createClaudeGlobalConversation(
  libraryID: number,
  options: { conversationKey?: number } = {},
): Promise<ClaudeConversationSummary | null> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  if (!normalizedLibraryID) return null;
  const allocated = await Zotero.DB.executeTransaction(async () => {
    const issued = await allocateClaudeConversationKey({
      libraryID: normalizedLibraryID,
      kind: "global",
      issuedAt: Date.now(),
      preferredConversationKey: options.conversationKey,
      inTransaction: true,
    });
    const stored = await upsertClaudeConversationSummary({
      conversationKey: issued.conversationKey,
      instanceID: issued.instanceID,
      conversationID: issued.conversationID,
      libraryID: normalizedLibraryID,
      kind: "global",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      inTransaction: true,
    });
    if (!stored) throw new Error("Claude conversation creation was refused");
    return issued;
  });
  await refreshClaudeConversationSearchIndex(allocated.conversationKey);
  setLastAllocatedClaudeGlobalConversationKey(allocated.conversationKey);
  return getClaudeConversationSummary(allocated.conversationKey);
}

export async function createClaudePaperConversation(
  libraryID: number,
  paperItemID: number,
  options: { conversationKey?: number } = {},
): Promise<ClaudeConversationSummary | null> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  const normalizedPaperItemID = normalizePaperItemID(paperItemID);
  if (!normalizedLibraryID || !normalizedPaperItemID) return null;
  const allocated = await Zotero.DB.executeTransaction(async () => {
    const issued = await allocateClaudeConversationKey({
      libraryID: normalizedLibraryID,
      kind: "paper",
      paperItemID: normalizedPaperItemID,
      issuedAt: Date.now(),
      preferredConversationKey: options.conversationKey,
      inTransaction: true,
    });
    const stored = await upsertClaudeConversationSummary({
      conversationKey: issued.conversationKey,
      instanceID: issued.instanceID,
      conversationID: issued.conversationID,
      libraryID: normalizedLibraryID,
      kind: "paper",
      paperItemID: normalizedPaperItemID,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      inTransaction: true,
    });
    if (!stored) throw new Error("Claude conversation creation was refused");
    return issued;
  });
  await refreshClaudeConversationSearchIndex(allocated.conversationKey);
  setLastAllocatedClaudePaperConversationKey(allocated.conversationKey);
  return getClaudeConversationSummary(allocated.conversationKey);
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
  conversationKey: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isClaudeStoreConversationKey(normalizedKey)) return;
  const repair =
    await repairRecoverableClaudeCatalogMessageConversationIDs(normalizedKey);
  if (repair.refused > 0) {
    throw new Error(
      `Refused to delete Claude conversation ${normalizedKey}: ambiguous stale message ids found.`,
    );
  }
  await resolveRepairingMessageConversationSelector(normalizedKey, {
    destructive: true,
  });
}

export async function deleteClaudeConversationLocalRows(
  conversationKey: number,
  identity?: {
    instanceID?: string;
    conversationID?: string;
    onBeforeCommit?: () => Promise<void>;
    onCommit?: () => Promise<void>;
  },
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isClaudeStoreConversationKey(normalizedKey)) return;
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
      `Refused to delete Claude conversation ${normalizedKey}: identity mismatch`,
    );
  }
  const deletionIdentity = ledgerEntry
    ? { ...(identity || {}), instanceID: ledgerEntry.instanceID }
    : identity;
  await preflightDeleteClaudeConversationLocalRows(normalizedKey);
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
         FROM ${CLAUDE_CONVERSATIONS_TABLE} c
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
         FROM ${CLAUDE_CONVERSATIONS_TABLE}
         WHERE conversation_key = ?
           ${catalogIdentityClause}
         LIMIT 1`,
        [normalizedKey, ...catalogIdentityParams],
      )) as Array<{ present?: unknown }> | undefined;
      if (!witnessRows?.length) {
        throw new Error(
          `Refused to delete Claude conversation ${normalizedKey}: catalog identity changed`,
        );
      }
    }
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CLAUDE_MESSAGES_TABLE}
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
      `DELETE FROM ${CLAUDE_CONVERSATIONS_TABLE}
       WHERE conversation_key = ?
         ${catalogIdentityClause}`,
      [normalizedKey, ...catalogIdentityParams],
    );
    await deleteConversationForkLinksForInstanceInTransaction({
      conversationKey: normalizedKey,
      conversationID: deletionIdentity?.conversationID,
      system: "claude_code",
    });
    if (deletionIdentity?.instanceID) {
      await deleteRegisteredConversationScopeInTransaction(
        deletionIdentity.instanceID,
        normalizedKey,
        deletionIdentity.conversationID,
        "claude_code",
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
      system: "claude_code",
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

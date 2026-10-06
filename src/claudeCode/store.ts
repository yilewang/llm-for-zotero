declare const Zotero: any;

import type { ClaudeConversationKind } from "../shared/types";
import { getConversationKeyRange } from "../shared/conversationKeySpace";
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
  initConversationRegistryStore,
  registerConversationScope,
  repairRegisteredConversationScope,
} from "../shared/conversationRegistry";
import { stagePaperRestoreTargetForStartup } from "../shared/paperConversationRestore";
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
  getConversationKeyLedgerEntry,
  initializeConversationKeyCounterInTransaction,
  initConversationKeyLedgerStore,
  refreshConversationKeyLedgerStore,
  installConversationKeyLedgerCatalogTriggers,
  installConversationKeyLedgerMessageTriggers,
  seedConversationKeyLedgerFromCatalogs,
  reserveOrphanConversationMessageKeys,
  seedConversationKeyLedgerFromTombstones,
  retireOrphanedConversationLedgerEntries,
} from "../shared/conversationKeyLedger";
import { initRecentlyDeletedConversationTombstones } from "../core/conversations/recentlyDeletedConversations";
import {
  normalizeConversationKey,
  normalizeLibraryID,
  normalizePaperItemID,
} from "../shared/conversationStore/keyNormalization";
import { logConversationStoreWarning } from "../shared/conversationStore/diagnostics";
import { clearPersistedAgentConversationRowsInTransaction } from "../modules/contextPanel/agentConversationCleanup";
import {
  createRuntimeConversationStore,
  ensureColumn,
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
  clearAgentConversationRowsInTransaction:
    clearPersistedAgentConversationRowsInTransaction,
  upsertExtraColumns: [],
  profileSignature: getClaudeProfileSignature,
  sessionResetColumns: [],
  keys: {
    allocatedRange: getClaudeAllocatedConversationKeyRange,
  },
  prefs: {
    setLastAllocatedGlobal: setLastAllocatedClaudeGlobalConversationKey,
    setLastAllocatedPaper: setLastAllocatedClaudePaperConversationKey,
    setLastUsedPaper: setLastUsedClaudePaperConversationKey,
  },
});
const buildClaudeConversationID = store.buildConversationID;
const backfillClaudeConversationTimestamps =
  store.backfillConversationTimestamps;
const refreshClaudeConversationCatalogSummary = store.refreshCatalogSummary;
const getClaudeMessagePaperContextRows = store.getMessagePaperContextRows;
const backfillClaudeConversationIDs = store.backfillConversationIDs;
const backfillClaudeConversationInstanceIDs =
  store.backfillConversationInstanceIDs;
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

type ClaudeConversationRow = Parameters<typeof store.toSummary>[0];

const toClaudeConversationSummary = store.toSummary;

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

const getMaxClaudeConversationKey = store.getMaxConversationKey;

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

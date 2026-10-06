declare const Zotero: any;

import type { CodexConversationSummary } from "../../shared/types";
import type { StoredChatMessage } from "../../utils/chatStore";
import { normalizeGeneratedChatImages } from "../../shared/generatedImages";
import {
  synthesizeSelectedTextContexts,
  normalizePaperContextRefs,
  normalizeCollectionContextRefs,
  normalizeTagContextRefs,
} from "../context/normalizers";
import { normalizeQuoteCitations } from "../quotes/quoteCitations";
import { serializeForcedSkillIds } from "../../shared/skillIds";
import {
  buildUserRowExistsQuery,
  latestUserRowFilter,
  storedMessageDisplayOrderSql,
  type UpdateLatestUserMessageOptions,
} from "../../shared/conversationMessageSql";
import {
  copyConversationMessagesThroughAssistantAnchor,
  type ForkConversationMessagesResult,
} from "../../shared/conversationMessageForkCopy";
import {
  getConversationKeyRange,
  isConversationKeyFor,
  isConversationKeyForKind,
} from "../../shared/conversationKeySpace";
import {
  AMBIGUOUS_PAPER_CONTEXT_INVALID_REASON,
  buildConversationID as buildSharedConversationID,
  canMigrateLegacyAmbiguousPaperRegistryScope,
  getPaperContextOwnershipEvidenceFromRows,
  repairRegisteredConversationScope,
  generateConversationInstanceID,
  getRegisteredConversationScope,
  initConversationRegistryStore,
  registerConversationScope,
  syncCatalogInstanceID,
  type PaperContextJsonColumns,
} from "../../shared/conversationRegistry";
import { stagePaperRestoreTargetForStartup } from "../../shared/paperConversationRestore";
import {
  CONVERSATION_ID_TRANSITION_MIGRATION_ID,
  CONVERSATION_KEY_LEDGER_MIGRATION_ID,
  hasConversationSchemaMigration,
  rekeyConversationCatalogKeyInTransaction,
  rekeyConversationOwnedRowsInTransaction,
  runConversationSchemaMigrationOnce,
} from "../../shared/conversationSchemaMigrations";
import {
  runConversationStoreStartupSchema,
  type StartupSchemaPass,
} from "../../shared/startupSchemaFingerprint";
import {
  allocateConversationKeyInTransaction,
  initializeConversationKeyCounterInTransaction,
  installConversationKeyLedgerCatalogTriggers,
  installConversationKeyLedgerMessageTriggers,
  nextUnissuedConversationKeyInRange,
  refreshConversationKeyLedgerStore,
  reserveOrphanConversationMessageKeys,
  retireOrphanedConversationLedgerEntries,
  seedConversationKeyLedgerFromCatalogs,
  seedConversationKeyLedgerFromTombstones,
  ConversationRetiredError,
  ensureConversationKeyLedgerEntry,
  ensureConversationKeyLedgerEntryInTransaction,
  getConversationKeyLedgerEntry,
  initConversationKeyLedgerStore,
  updateConversationKeyLedgerConversationIDInTransaction,
  isConversationKeyLedgerStoreInitialized,
  withRetiredKeyErrorMapping,
} from "../../shared/conversationKeyLedger";
import {
  deleteConversationSearchIndexRowInTransaction,
  initConversationSearchIndexStore,
} from "../../shared/conversationSearchIndex";
import { pendingDeletionStore } from "../../core/conversations/pendingDeletionStore";
import { notifyConversationCatalogChanged } from "../../core/conversations/conversationCatalogEvents";
import { logConversationStoreWarning } from "../../shared/conversationStore/diagnostics";
import {
  normalizeCatalogTimestamp,
  normalizeConversationKey,
  normalizeLibraryID,
  normalizeLimit,
  normalizeOptionalLimit,
  normalizePaperItemID,
} from "../../shared/conversationStore/keyNormalization";
import {
  areConversationWritesFrozen,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../../shared/conversationWriteFence";
import { deleteUsageEventsForConversation } from "../../utils/usageStore";
import { initRecentlyDeletedConversationTombstones } from "../../core/conversations/recentlyDeletedConversations";
import {
  resolveRepairingMessageConversationSelector as resolveSharedRepairingMessageConversationSelector,
  type MessageConversationSelector,
} from "../../shared/conversationStore/messageConversationSelector";
import { getMessagePaperContextRows as getSharedMessagePaperContextRows } from "../../shared/conversationStore/messagePaperContextRows";
import {
  deleteStoreConversationSearchIndex,
  refreshStoreConversationSearchIndex,
} from "../../shared/conversationStore/searchIndex";
import {
  backfillStoreCatalogConversationIDs,
  backfillStoreCatalogConversationInstanceIDs,
  backfillStoreCatalogConversationTimestamps,
  repairRecoverableStoreCatalogMessageConversationIDs,
} from "./conversationStoreIdentityRepair";
import {
  filterValidStoreConversationSummaries,
  refreshStoreConversationCatalogSummary,
  sameStoreCatalogScope,
  type ConversationStoreCatalogConfig,
} from "./conversationStoreCatalogSummary";
import { loadStoredConversationMessages } from "./conversationStoreMessageMapping";
import {
  deleteConversationLocalRows as deleteSharedConversationLocalRows,
  deleteConversationTurnMessages,
  preflightDeleteConversationLocalRows as preflightDeleteSharedConversationLocalRows,
  type ConversationAgentPurge,
  type ConversationLocalRowDeletionIdentity,
  type ConversationLocalRowStore,
} from "../../shared/conversationStore/localRowDeletion";

/**
 * One conversation store for the two runtime backends (Claude Code and Codex).
 *
 * Both backends keep a messages table and one catalog table with the same
 * shape, and run the same statements against them.  Each backend module builds
 * its store from a `RuntimeStoreConfig` and re-exports the store's methods
 * under its own names.  Everything that differs between the two lives in the
 * config: the table names, the identity data, the extra Codex columns and the
 * hooks.  The SQL text is the same for both; only table and index names are
 * templated, so persisted names (tables, indexes, triggers) never change.
 */

export type RuntimeConversationSystem = "claude_code" | "codex";
export type RuntimeConversationKind = "global" | "paper";
/** The Codex summary is the superset; Claude never sets the extra field. */
export type RuntimeConversationSummary = CodexConversationSummary;

export type RuntimeStoreTables = {
  messages: string;
  messagesIndex: string;
  messagesIdIndex: string;
  catalog: string;
  kindIndex: string;
  activityIndex: string;
  idIndex: string;
};

export type RuntimeStoreConfig = {
  system: RuntimeConversationSystem;
  /** The store name in warnings and error messages. */
  storeLabel: "Claude" | "Codex";
  /** Persisted: names the store's startup fingerprint row. */
  startupStoreID: "claude-code" | "codex";
  /** Persisted: the store's instance-identity backfill migration. */
  instanceIdMigrationID: string;
  /**
   * Bump when the startup schema pass changes in a way that must run inside a
   * transaction once (a new multi-statement repair, a table rebuild).
   */
  schemaRevision: number;
  tables: RuntimeStoreTables;
  /** Default and fallback row limit for loading a conversation. */
  historyLimit: number;
  /**
   * D1: the activity timestamp of catalog alias `c`, reported as `updatedAt`
   * and used to order every summary and list query.
   */
  activityTimestampSqlForAliasC: string;
  /**
   * D3: extra catalog columns (name, column definition), created after
   * provider_session_id and added to an older catalog (Codex only).
   */
  extraCatalogColumns: ReadonlyArray<readonly [name: string, ddl: string]>;
  /**
   * D2: the user turn count the identity-registry repair reports.  Claude
   * reads the cached catalog column; Codex counts its user messages.
   */
  registryRepairUserTurnCountSql: string;
  /** D3: extra catalog columns read into the summary (Codex only). */
  summaryExtraColumns: ReadonlyArray<{
    sql: string;
    alias: "providerPermissionState";
  }>;
  /** D3: extra catalog columns that the summary upsert writes and merges. */
  upsertExtraColumns: ReadonlyArray<{
    column: string;
    param: "providerPermissionState";
  }>;
  /**
   * Deletes the agent rows of a conversation inside the deletion transaction.
   * Injected because the agent purge lives above this layer.  The deletion
   * kernel rolls the returned purge back when its transaction fails.
   */
  clearAgentConversationRowsInTransaction(
    conversationKey: number,
  ): Promise<ConversationAgentPurge>;
  /** The profile signature recorded on every key the store issues. */
  profileSignature(): string;
  /**
   * D4: extra catalog columns that clearing a conversation or its session
   * metadata resets to NULL with the provider session (Codex only).
   */
  sessionResetColumns: readonly string[];
  hooks?: {
    /**
     * D5: runs inside the transaction of append, updateLatestUserMessage,
     * updateLatestAssistantMessage and the fork copy, after the row write and
     * before the catalog summary refresh.  Codex merges the activity
     * timestamps there and throws on a pending deletion; Claude has none.
     */
    afterMessageWriteInTransaction?(
      conversationKey: number,
      timestamp: number,
    ): Promise<void>;
    /**
     * D6: runs in the first startup pass, before the legacy key migration
     * (Codex moves its misrouted rows out of the Claude tables).
     */
    beforeLegacyKeyMigration?(): Promise<void>;
    /** D7: runs after the startup schema pass (Codex cleans key prefs). */
    afterStartupSchema?(): void;
  };
  /** D8: the message columns a fork copies (Codex only; Claude cannot fork). */
  fork?: { copyColumns: readonly string[] };
  keys: {
    allocatedRange(kind: RuntimeConversationKind): {
      start: number;
      endExclusive: number;
    };
    buildDefaultGlobalKey(libraryID: number): number;
    buildDefaultPaperKey(paperItemID: number): number;
    isInRange(conversationKey: number, kind: RuntimeConversationKind): boolean;
  };
  prefs: {
    getLastAllocatedGlobal(): number | null;
    getLastAllocatedPaper(): number | null;
    setLastUsedMode(libraryID: number, mode: RuntimeConversationKind): void;
    setLastUsedGlobal(libraryID: number, conversationKey: number): void;
    setLastAllocatedGlobal(conversationKey: number): void;
    setLastAllocatedPaper(conversationKey: number): void;
    setLastUsedPaper(
      libraryID: number,
      paperItemID: number,
      conversationKey: number,
    ): void;
  };
};

export const RUNTIME_MESSAGE_SELECT_COLUMNS_SQL = `id,
            role,
            text,
            timestamp,
            run_mode AS runMode,
            agent_run_id AS agentRunId,
            document_id AS documentId,
            selected_text AS selectedText,
            selected_text_contexts_json AS selectedTextContextsJson,
            selected_texts_json AS selectedTextsJson,
            selected_text_sources_json AS selectedTextSourcesJson,
            selected_text_paper_contexts_json AS selectedTextPaperContextsJson,
            selected_text_note_contexts_json AS selectedTextNoteContextsJson,
            forced_skill_ids_json AS forcedSkillIdsJson,
            paper_contexts_json AS paperContextsJson,
            pdf_paper_contexts_json AS pdfPaperContextsJson,
            full_text_paper_contexts_json AS fullTextPaperContextsJson,
            citation_paper_contexts_json AS citationPaperContextsJson,
            quote_citations_json AS quoteCitationsJson,
            collection_contexts_json AS collectionContextsJson,
            tag_contexts_json AS tagContextsJson,
            screenshot_images AS screenshotImages,
            attachments_json AS attachmentsJson,
            generated_images_json AS generatedImagesJson,
            model_name AS modelName,
            model_entry_id AS modelEntryId,
            model_provider_label AS modelProviderLabel,
            interrupted,
            webchat_run_state AS webchatRunState,
            webchat_completion_reason AS webchatCompletionReason,
            reasoning_summary AS reasoningSummary,
            reasoning_details AS reasoningDetails,
            compact_marker AS compactMarker,
            context_tokens AS contextTokens,
            context_window AS contextWindow`;

export function normalizeConversationTitleSeed(value: string): string {
  if (typeof value !== "string") return "";
  const normalized = value

    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized.slice(0, 96);
}

export async function ensureColumn(
  tableName: string,
  columns: Array<{ name?: unknown }> | undefined,
  columnName: string,
  definition: string,
): Promise<void> {
  if (columns?.some((column) => column?.name === columnName)) return;
  await Zotero.DB.queryAsync(
    `ALTER TABLE ${tableName}
     ADD COLUMN ${definition}`,
  );
}

type RuntimeConversationRow = {
  instanceID?: unknown;
  conversationID?: unknown;
  conversationKey?: unknown;
  libraryID?: unknown;
  kind?: unknown;
  paperItemID?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  title?: unknown;
  providerSessionId?: unknown;
  providerPermissionState?: unknown;
  scopedConversationKey?: unknown;
  scopeType?: unknown;
  scopeId?: unknown;
  scopeLabel?: unknown;
  cwd?: unknown;
  modelName?: unknown;
  effort?: unknown;
  userTurnCount?: unknown;
};

type RuntimeConversationKeyRemap = {
  legacyKey: number;
  targetKey: number;
  /** A retired key may contain an older owner's rows; never adopt them. */
  preserveLegacyRows?: boolean;
};

export function createRuntimeConversationStore(config: RuntimeStoreConfig) {
  const { system, storeLabel, tables } = config;
  const historyLimit = config.historyLimit;
  const activitySql = config.activityTimestampSqlForAliasC;

  /**
   * D3: the extra summary columns as SELECT lines, each on its own line after
   * the provider session line.  Empty for Claude, so its SQL is unchanged.
   */
  function summaryExtraSelectSql(indent: string): string {
    return config.summaryExtraColumns
      .map((column) => `\n${indent}${column.sql} AS ${column.alias},`)
      .join("");
  }

  /**
   * Migrations the startup schema pass guards with markers.  Their IDs are part
   * of the startup fingerprint, so declaring a new one here forces the next
   * launch back through the transactional pass (see startupSchemaFingerprint).
   */
  const startupMigrationIDs = [
    CONVERSATION_ID_TRANSITION_MIGRATION_ID,
    config.instanceIdMigrationID,
    CONVERSATION_KEY_LEDGER_MIGRATION_ID,
  ] as const;

  /** D3: the extra catalog columns as CREATE TABLE lines. */
  const extraCatalogCreateSql = config.extraCatalogColumns
    .map(([, definition]) => `\n        ${definition},`)
    .join("");

  /** D3: the extra upsert columns, their placeholders and merge lines. */
  const upsertExtraColumnListSql = config.upsertExtraColumns
    .map((column) => `, ${column.column}`)
    .join("");
  const upsertExtraPlaceholderSql = config.upsertExtraColumns
    .map(() => ", ?")
    .join("");
  const upsertExtraMergeSql = config.upsertExtraColumns
    .map(
      (column) =>
        `\n         ${column.column} = COALESCE(excluded.${column.column}, ${tables.catalog}.${column.column}),`,
    )
    .join("");

  /** D4: the extra reset columns as SET lines after the provider session. */
  function sessionResetSql(indent: string): string {
    return config.sessionResetColumns
      .map((column) => `\n${indent}${column} = NULL,`)
      .join("");
  }

  /**
   * Zotero rows throw on a column the query did not select, so only the
   * configured extra columns are read.
   */
  function readSummaryExtraColumns(
    row: RuntimeConversationRow,
  ): Partial<Pick<RuntimeConversationSummary, "providerPermissionState">> {
    const extra: Partial<
      Pick<RuntimeConversationSummary, "providerPermissionState">
    > = {};
    for (const column of config.summaryExtraColumns) {
      const value = row[column.alias];
      extra[column.alias] =
        typeof value === "string" && value.trim() ? value.trim() : undefined;
    }
    return extra;
  }

  function isStoreConversationKey(conversationKey: number): boolean {
    return isConversationKeyFor(system, conversationKey);
  }

  function isStoreConversationKeyForKind(
    conversationKey: number,
    kind: RuntimeConversationKind,
  ): boolean {
    return isConversationKeyForKind(system, kind, conversationKey);
  }

  function buildConversationID(params: {
    conversationKey: number;
    kind: RuntimeConversationKind;
    libraryID: number;
    paperItemID?: number | null;
  }): string {
    return buildSharedConversationID({
      conversationKey: params.conversationKey,
      system,
      kind: params.kind,
      libraryID: params.libraryID,
      paperItemID: params.paperItemID,
    });
  }

  async function resolveRegisteredConversationID(
    conversationKey: number,
  ): Promise<string | null> {
    const registered = await getRegisteredConversationScope(conversationKey);
    return registered?.conversationID || null;
  }

  async function resolveAppendIdentity(
    conversationKey: number,
    requestedInstanceID?: string,
  ): Promise<{
    instanceID: string | null;
    conversationID: string | null;
    ledgerAvailable: boolean;
  }> {
    const registered = await getRegisteredConversationScope(conversationKey);
    let ledger;
    const ledgerAvailable = isConversationKeyLedgerStoreInitialized();
    if (ledgerAvailable) {
      ledger = await getConversationKeyLedgerEntry(conversationKey);
    }
    if (ledgerAvailable) {
      if (!ledger || ledger.retiredAt) {
        throw new ConversationRetiredError(
          conversationKey,
          requestedInstanceID || registered?.instanceID || "",
        );
      }
      if (requestedInstanceID && requestedInstanceID !== ledger.instanceID) {
        throw new Error(
          `Conversation ${conversationKey} instance identity mismatch`,
        );
      }
    }
    return {
      instanceID:
        ledger?.instanceID ||
        requestedInstanceID ||
        registered?.instanceID ||
        null,
      conversationID:
        ledger?.conversationID || registered?.conversationID || null,
      ledgerAvailable,
    };
  }

  async function getMessagePaperContextRows(
    conversationKey: number,
  ): Promise<PaperContextJsonColumns[]> {
    return await getSharedMessagePaperContextRows(
      tables.messages,
      conversationKey,
    );
  }

  const messageSelectorConfig = {
    messagesTable: tables.messages,
    storeLabel,
    getPaperContextRows: getMessagePaperContextRows,
    log: logConversationStoreWarning,
  };

  async function resolveRepairingMessageConversationSelector(
    conversationKey: number,
    options: { destructive?: boolean } = {},
  ): Promise<MessageConversationSelector> {
    return await resolveSharedRepairingMessageConversationSelector(
      messageSelectorConfig,
      conversationKey,
      options,
    );
  }

  async function refreshSearchIndex(conversationKey: number): Promise<void> {
    await refreshStoreConversationSearchIndex({
      system,
      storeLabel,
      conversationKey,
    });
  }

  async function deleteSearchIndex(conversationKey: number): Promise<void> {
    await deleteStoreConversationSearchIndex({
      system,
      conversationKey,
    });
  }

  const catalogConfig: ConversationStoreCatalogConfig = {
    system,
    storeLabel,
    catalogTable: tables.catalog,
    messagesTable: tables.messages,
    buildConversationID,
    getPaperContextRows: getMessagePaperContextRows,
    rememberPaperConversationKey: config.prefs.setLastUsedPaper,
  };

  async function backfillConversationTimestamps(): Promise<void> {
    await backfillStoreCatalogConversationTimestamps(catalogConfig);
  }

  async function refreshCatalogSummary(
    conversationKey?: number,
  ): Promise<void> {
    await refreshStoreConversationCatalogSummary(
      catalogConfig,
      conversationKey,
    );
  }

  async function repairRecoverableCatalogMessageConversationIDs(
    conversationKey?: number,
  ): Promise<{
    checked: number;
    repaired: number;
    refused: number;
  }> {
    return await repairRecoverableStoreCatalogMessageConversationIDs(
      catalogConfig,
      conversationKey,
    );
  }

  /** The store as the shared deletion kernel sees it. */
  const localRowStore: ConversationLocalRowStore = {
    system,
    storeLabel,
    messagesTable: tables.messages,
    isStoreConversationKey,
    repairRecoverableCatalogMessageConversationIDs,
    resolveRepairingMessageConversationSelector,
    clearAgentConversationRowsInTransaction: (conversationKey) =>
      config.clearAgentConversationRowsInTransaction(conversationKey),
    refreshCatalogSummary,
    refreshSearchIndex,
  };

  async function backfillConversationIDs(): Promise<void> {
    await backfillStoreCatalogConversationIDs(catalogConfig);
  }

  async function backfillConversationInstanceIDs(): Promise<void> {
    await backfillStoreCatalogConversationInstanceIDs(tables.catalog);
  }

  function sameCatalogScope(
    existing: RuntimeConversationSummary,
    params: {
      libraryID: number;
      kind: RuntimeConversationKind;
      paperItemID?: number | null;
    },
  ): boolean {
    return sameStoreCatalogScope(existing, params);
  }

  async function filterValidSummaries(
    summaries: RuntimeConversationSummary[],
    expectedPaperItemID?: number | null,
  ): Promise<RuntimeConversationSummary[]> {
    return await filterValidStoreConversationSummaries(
      catalogConfig,
      summaries,
      expectedPaperItemID,
    );
  }

  async function loadConversation(
    conversationKey: number,
    limit = historyLimit,
  ): Promise<StoredChatMessage[]> {
    const normalizedKey = normalizeConversationKey(conversationKey);
    if (!normalizedKey || !isStoreConversationKey(normalizedKey)) return [];
    const selector =
      await resolveRepairingMessageConversationSelector(normalizedKey);
    const normalizedLimit = normalizeLimit(limit, historyLimit);
    return await loadStoredConversationMessages({
      messagesTable: tables.messages,
      selectColumnsSql: RUNTIME_MESSAGE_SELECT_COLUMNS_SQL,
      whereSql: selector.whereSql,
      params: selector.params,
      limit: normalizedLimit,
    });
  }

  function toSummary(
    row: RuntimeConversationRow,
  ): RuntimeConversationSummary | null {
    const conversationKey = normalizeConversationKey(
      Number(row.conversationKey),
    );
    const libraryID = normalizeLibraryID(Number(row.libraryID));
    const createdAt = normalizeCatalogTimestamp(row.createdAt);
    const updatedAt = normalizeCatalogTimestamp(row.updatedAt);
    const kind =
      row.kind === "paper" ? "paper" : row.kind === "global" ? "global" : null;
    if (
      !conversationKey ||
      !libraryID ||
      !kind ||
      !isStoreConversationKeyForKind(conversationKey, kind)
    ) {
      return null;
    }
    const paperItemID = normalizePaperItemID(Number(row.paperItemID));
    const userTurnCount = Number(row.userTurnCount);
    let instanceID: string | undefined;
    try {
      instanceID =
        typeof row.instanceID === "string" && row.instanceID.trim()
          ? row.instanceID.trim()
          : undefined;
    } catch {
      // Legacy test/upgrade rows may not expose the new identity column.
    }
    return {
      instanceID,
      conversationID:
        typeof row.conversationID === "string" && row.conversationID.trim()
          ? row.conversationID.trim()
          : buildConversationID({
              conversationKey,
              kind,
              libraryID,
              paperItemID,
            }),
      conversationKey,
      libraryID,
      kind,
      paperItemID: paperItemID || undefined,
      createdAt,
      updatedAt,
      title:
        typeof row.title === "string" && row.title.trim()
          ? row.title.trim()
          : undefined,
      providerSessionId:
        typeof row.providerSessionId === "string" &&
        row.providerSessionId.trim()
          ? row.providerSessionId.trim()
          : undefined,
      ...readSummaryExtraColumns(row),
      scopedConversationKey:
        typeof row.scopedConversationKey === "string" &&
        row.scopedConversationKey.trim()
          ? row.scopedConversationKey.trim()
          : undefined,
      scopeType:
        typeof row.scopeType === "string" && row.scopeType.trim()
          ? row.scopeType.trim()
          : undefined,
      scopeId:
        typeof row.scopeId === "string" && row.scopeId.trim()
          ? row.scopeId.trim()
          : undefined,
      scopeLabel:
        typeof row.scopeLabel === "string" && row.scopeLabel.trim()
          ? row.scopeLabel.trim()
          : undefined,
      cwd:
        typeof row.cwd === "string" && row.cwd.trim()
          ? row.cwd.trim()
          : undefined,
      model:
        typeof row.modelName === "string" && row.modelName.trim()
          ? row.modelName.trim()
          : undefined,
      effort:
        typeof row.effort === "string" && row.effort.trim()
          ? row.effort.trim()
          : undefined,
      userTurnCount: Number.isFinite(userTurnCount)
        ? Math.max(0, Math.floor(userTurnCount))
        : 0,
    };
  }

  async function getSummary(
    conversationKey: number,
  ): Promise<RuntimeConversationSummary | null> {
    const normalizedKey = normalizeConversationKey(conversationKey);
    if (!normalizedKey || !isStoreConversationKey(normalizedKey)) return null;
    const rows = (await Zotero.DB.queryAsync(
      `SELECT c.conversation_id AS conversationID,
            c.conversation_instance_id AS instanceID,
            c.conversation_key AS conversationKey,
            c.library_id AS libraryID,
            c.kind AS kind,
            c.paper_item_id AS paperItemID,
            c.created_at AS createdAt,
            ${activitySql} AS updatedAt,
            COALESCE(NULLIF(TRIM(c.title), ''), NULLIF(TRIM(c.first_user_title), '')) AS title,
            c.provider_session_id AS providerSessionId,${summaryExtraSelectSql("            ")}
            c.scoped_conversation_key AS scopedConversationKey,
            c.scope_type AS scopeType,
            c.scope_id AS scopeId,
            c.scope_label AS scopeLabel,
            c.cwd AS cwd,
            c.model_name AS modelName,
            c.effort AS effort,
            COALESCE(c.user_turn_count, 0) AS userTurnCount
     FROM ${tables.catalog} c
     WHERE c.conversation_key = ?
     LIMIT 1`,
      [normalizedKey],
    )) as RuntimeConversationRow[] | undefined;
    return rows?.length ? toSummary(rows[0]) : null;
  }

  async function listConversations(params: {
    libraryID: number;
    kind: RuntimeConversationKind;
    paperItemID?: number;
    limit?: number | null;
  }): Promise<RuntimeConversationSummary[]> {
    const libraryID = normalizeLibraryID(params.libraryID);
    if (!libraryID) return [];
    const limit =
      params.limit === null ? null : normalizeLimit(params.limit ?? 50, 50);
    const sql =
      params.kind === "paper"
        ? `SELECT c.conversation_id AS conversationID,
              c.conversation_key AS conversationKey,
              c.library_id AS libraryID,
              c.kind AS kind,
              c.paper_item_id AS paperItemID,
              c.created_at AS createdAt,
              ${activitySql} AS updatedAt,
              COALESCE(NULLIF(TRIM(c.title), ''), NULLIF(TRIM(c.first_user_title), '')) AS title,
              c.provider_session_id AS providerSessionId,${summaryExtraSelectSql("              ")}
              c.scoped_conversation_key AS scopedConversationKey,
              c.scope_type AS scopeType,
              c.scope_id AS scopeId,
              c.scope_label AS scopeLabel,
              c.cwd AS cwd,
              c.model_name AS modelName,
              c.effort AS effort,
              COALESCE(c.user_turn_count, 0) AS userTurnCount
       FROM ${tables.catalog} c
       WHERE c.library_id = ?
         AND c.kind = 'paper'
         AND c.paper_item_id = ?
       ORDER BY updatedAt DESC, c.conversation_key DESC
       ${limit ? "LIMIT ?" : ""}`
        : `SELECT c.conversation_id AS conversationID,
              c.conversation_key AS conversationKey,
              c.library_id AS libraryID,
              c.kind AS kind,
              c.paper_item_id AS paperItemID,
              c.created_at AS createdAt,
              ${activitySql} AS updatedAt,
              COALESCE(NULLIF(TRIM(c.title), ''), NULLIF(TRIM(c.first_user_title), '')) AS title,
              c.provider_session_id AS providerSessionId,${summaryExtraSelectSql("              ")}
              c.scoped_conversation_key AS scopedConversationKey,
              c.scope_type AS scopeType,
              c.scope_id AS scopeId,
              c.scope_label AS scopeLabel,
              c.cwd AS cwd,
              c.model_name AS modelName,
              c.effort AS effort,
              COALESCE(c.user_turn_count, 0) AS userTurnCount
       FROM ${tables.catalog} c
       WHERE c.library_id = ?
         AND c.kind = 'global'
       ORDER BY updatedAt DESC, c.conversation_key DESC
       ${limit ? "LIMIT ?" : ""}`;
    const queryParams =
      params.kind === "paper"
        ? [
            libraryID,
            normalizePaperItemID(Number(params.paperItemID)) || 0,
            ...(limit ? [limit] : []),
          ]
        : [libraryID, ...(limit ? [limit] : [])];
    const rows = (await Zotero.DB.queryAsync(sql, queryParams)) as
      | RuntimeConversationRow[]
      | undefined;
    if (!rows?.length) return [];
    const summaries = rows
      .map((row) => toSummary(row))
      .filter((row): row is RuntimeConversationSummary => Boolean(row));
    return filterValidSummaries(
      summaries,
      params.kind === "paper"
        ? normalizePaperItemID(Number(params.paperItemID))
        : null,
    );
  }

  async function listGlobalConversations(
    libraryID: number,
    limit: number | null = 50,
  ): Promise<RuntimeConversationSummary[]> {
    return listConversations({ libraryID, kind: "global", limit });
  }

  async function listPaperConversations(
    libraryID: number,
    paperItemID: number,
    limit = 50,
  ): Promise<RuntimeConversationSummary[]> {
    return listConversations({
      libraryID,
      kind: "paper",
      paperItemID,
      limit,
    });
  }

  async function listAllPaperConversationsByLibrary(
    libraryID: number,
    limit: number | null = 100,
  ): Promise<RuntimeConversationSummary[]> {
    const normalizedLibraryID = normalizeLibraryID(libraryID);
    if (!normalizedLibraryID) return [];
    const normalizedLimit = normalizeOptionalLimit(limit);
    const queryParams: unknown[] = [normalizedLibraryID];
    if (normalizedLimit) queryParams.push(normalizedLimit);
    const rows = (await Zotero.DB.queryAsync(
      `SELECT c.conversation_id AS conversationID,
            c.conversation_key AS conversationKey,
            c.library_id AS libraryID,
            c.kind AS kind,
            c.paper_item_id AS paperItemID,
            c.created_at AS createdAt,
            ${activitySql} AS updatedAt,
            COALESCE(NULLIF(TRIM(c.title), ''), NULLIF(TRIM(c.first_user_title), '')) AS title,
            c.provider_session_id AS providerSessionId,${summaryExtraSelectSql("            ")}
            c.scoped_conversation_key AS scopedConversationKey,
            c.scope_type AS scopeType,
            c.scope_id AS scopeId,
            c.scope_label AS scopeLabel,
            c.cwd AS cwd,
            c.model_name AS modelName,
            c.effort AS effort,
            COALESCE(c.user_turn_count, 0) AS userTurnCount
     FROM ${tables.catalog} c
     WHERE c.library_id = ?
       AND c.kind = 'paper'
       AND COALESCE(c.user_turn_count, 0) > 0
     ORDER BY updatedAt DESC, c.conversation_key DESC
     ${normalizedLimit ? "LIMIT ?" : ""}`,
      queryParams,
    )) as RuntimeConversationRow[] | undefined;
    if (!rows?.length) return [];
    const summaries = rows
      .map((row) => toSummary(row))
      .filter((row): row is RuntimeConversationSummary => Boolean(row));
    return filterValidSummaries(summaries);
  }

  async function getMaxConversationKey(
    kind: RuntimeConversationKind,
  ): Promise<number> {
    const range = config.keys.allocatedRange(kind);
    const rows = (await Zotero.DB.queryAsync(
      `SELECT MAX(conversation_key) AS maxConversationKey
     FROM ${tables.catalog}
     WHERE kind = ?
       AND conversation_key >= ?
       AND conversation_key < ?`,
      [kind, range.start, range.endExclusive],
    )) as Array<{ maxConversationKey?: unknown }> | undefined;
    const maxConversationKey = Number(rows?.[0]?.maxConversationKey);
    if (!Number.isFinite(maxConversationKey) || maxConversationKey <= 0) {
      return range.start - 1;
    }
    return Math.floor(maxConversationKey);
  }

  async function touchConversationTitle(
    conversationKey: number,
    titleSeed: string,
    expectedGeneration?: number,
  ): Promise<void> {
    const normalizedKey = normalizeConversationKey(conversationKey);
    if (!normalizedKey || !isStoreConversationKey(normalizedKey)) return;
    const title = normalizeConversationTitleSeed(titleSeed);
    if (!title) return;
    await withConversationWriteLock(normalizedKey, async () => {
      if (
        areConversationWritesFrozen(normalizedKey) ||
        (expectedGeneration !== undefined &&
          !isConversationWriteGenerationCurrent(
            normalizedKey,
            expectedGeneration,
          ))
      )
        return;
      await Zotero.DB.queryAsync(
        `UPDATE ${tables.catalog}
     SET title = ?
     WHERE conversation_key = ?
       AND (title IS NULL OR TRIM(title) = '')`,
        [title, normalizedKey],
      );
    });
    await refreshSearchIndex(normalizedKey);
    notifyConversationCatalogChanged("renamed", normalizedKey);
  }

  async function clearConversationSessionMetadata(
    conversationKey: number,
    expectedProviderSessionId?: string,
    expectedInstanceID?: string,
  ): Promise<void> {
    const normalizedKey = normalizeConversationKey(conversationKey);
    if (!normalizedKey || !isStoreConversationKey(normalizedKey)) return;
    const normalizedSessionId = String(expectedProviderSessionId || "").trim();
    const sessionPredicate = normalizedSessionId
      ? "AND provider_session_id = ?"
      : "";
    const instancePredicate = expectedInstanceID?.trim()
      ? "AND conversation_instance_id = ?"
      : "";
    await Zotero.DB.queryAsync(
      `UPDATE ${tables.catalog}
     SET provider_session_id = NULL,${sessionResetSql("         ")}
         scoped_conversation_key = NULL,
         scope_type = NULL,
         scope_id = NULL,
         scope_label = NULL,
         cwd = NULL,
         updated_at = ?
     WHERE conversation_key = ?
       ${sessionPredicate}
       ${instancePredicate}`,
      [
        Date.now(),
        normalizedKey,
        ...(normalizedSessionId ? [normalizedSessionId] : []),
        ...(expectedInstanceID?.trim() ? [expectedInstanceID.trim()] : []),
      ],
    );
    await refreshSearchIndex(normalizedKey);
  }

  async function setConversationTitle(
    conversationKey: number,
    titleSeed: string,
    identity?: {
      instanceID?: string;
      conversationID?: string;
      inTransaction?: boolean;
    },
  ): Promise<void> {
    const normalizedKey = normalizeConversationKey(conversationKey);
    if (!normalizedKey || !isStoreConversationKey(normalizedKey)) return;
    const identityClause = identity?.instanceID
      ? `AND conversation_instance_id = ?`
      : "";
    const identityParams = identity?.instanceID ? [identity.instanceID] : [];
    await Zotero.DB.queryAsync(
      `UPDATE ${tables.catalog}
     SET title = ?
     WHERE conversation_key = ?
       ${identityClause}`,
      [
        normalizeConversationTitleSeed(titleSeed) || null,
        normalizedKey,
        ...identityParams,
      ],
    );
    if (!identity?.inTransaction) {
      await refreshSearchIndex(normalizedKey);
    }
    notifyConversationCatalogChanged("renamed", normalizedKey);
  }

  async function deleteConversation(conversationKey: number): Promise<void> {
    const normalizedKey = normalizeConversationKey(conversationKey);
    if (!normalizedKey || !isStoreConversationKey(normalizedKey)) return;
    await Zotero.DB.queryAsync(
      `DELETE FROM ${tables.catalog}
     WHERE conversation_key = ?`,
      [normalizedKey],
    );
    await deleteSearchIndex(normalizedKey);
    // Legacy pre-ledger deletion path: cascade the usage ledger here too, so no
    // entry point can leave usage rows for a conversation the user deleted.
    await deleteUsageEventsForConversation(normalizedKey);
    notifyConversationCatalogChanged("deleted", normalizedKey);
  }

  async function appendMessage(
    conversationKey: number,
    message: StoredChatMessage,
    instanceID?: string,
  ): Promise<void> {
    const normalizedKey = normalizeConversationKey(conversationKey);
    if (!normalizedKey || !isStoreConversationKey(normalizedKey)) return;
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
    const generatedImages = normalizeGeneratedChatImages(
      message.generatedImages,
    );
    const messageTimestamp = Number.isFinite(message.timestamp)
      ? Math.floor(message.timestamp)
      : Date.now();
    const appendIdentity = await resolveAppendIdentity(
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
         FROM ${tables.catalog}
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
            appendIdentity.ledgerAvailable ||
            Boolean(appendIdentity.instanceID);
          const identityColumn = identityAvailable
            ? ", conversation_instance_id"
            : "";
          const identityPlaceholder = identityAvailable ? ", ?" : "";
          await Zotero.DB.queryAsync(
            `INSERT INTO ${tables.messages}
        (conversation_id, conversation_key, role, text, timestamp, run_mode, agent_run_id, selected_text, selected_text_contexts_json, selected_texts_json, selected_text_sources_json, selected_text_paper_contexts_json, selected_text_note_contexts_json, forced_skill_ids_json, paper_contexts_json, pdf_paper_contexts_json, full_text_paper_contexts_json, citation_paper_contexts_json, quote_citations_json, collection_contexts_json, tag_contexts_json, screenshot_images, attachments_json, generated_images_json, model_name, model_entry_id, model_provider_label, interrupted, webchat_run_state, webchat_completion_reason, reasoning_summary, reasoning_details, compact_marker, context_tokens, context_window, document_id${identityColumn})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${identityPlaceholder})`,
            [
              conversationID,
              normalizedKey,
              message.role,
              message.text || "",
              messageTimestamp,
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
          await config.hooks?.afterMessageWriteInTransaction?.(
            normalizedKey,
            messageTimestamp,
          );
          await refreshCatalogSummary(normalizedKey);
        }),
    );
    await refreshSearchIndex(normalizedKey);
    notifyConversationCatalogChanged("turns", normalizedKey);
  }

  async function clearConversation(
    conversationKey: number,
    identity?: { instanceID?: string; conversationID?: string },
    onBeforeCommit?: () => Promise<void>,
  ): Promise<void> {
    const normalizedKey = normalizeConversationKey(conversationKey);
    if (!normalizedKey || !isStoreConversationKey(normalizedKey)) return;
    const catalogIdentityClause = identity?.instanceID
      ? `AND conversation_instance_id = ?`
      : "";
    const catalogIdentityParams = identity?.instanceID
      ? [identity.instanceID]
      : [];
    const messageIdentityClause = identity?.instanceID
      ? `AND EXISTS (
         SELECT 1
         FROM ${tables.catalog} c
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
    // Remove the old indexed body in the same transaction as the clear.  The
    // post-commit refresh is best-effort, but it must never leave cleared text
    // searchable if that refresh is interrupted or the database is transiently
    // unavailable.
    const searchIndexReady = await initConversationSearchIndexStore();
    await Zotero.DB.executeTransaction(async () => {
      if (identity?.instanceID) {
        const witnessRows = (await Zotero.DB.queryAsync(
          `SELECT 1 AS present
         FROM ${tables.catalog}
         WHERE conversation_key = ?
           ${catalogIdentityClause}
         LIMIT 1`,
          [normalizedKey, ...catalogIdentityParams],
        )) as Array<{ present?: unknown }> | undefined;
        if (!witnessRows?.length) {
          throw new Error(
            `Refused to clear ${storeLabel} conversation ${normalizedKey}: catalog identity changed`,
          );
        }
      }
      await Zotero.DB.queryAsync(
        `DELETE FROM ${tables.messages}
       WHERE ${selector.whereSql}
         ${messageIdentityClause}`,
        [...selector.params, ...messageIdentityParams],
      );
      await refreshCatalogSummary(normalizedKey);
      if (searchIndexReady) {
        await deleteConversationSearchIndexRowInTransaction({
          system,
          conversationKey: normalizedKey,
        });
      }
      // Clear is content-authoritative.  Detach the exact native session in the
      // same transaction so a provider-resume path cannot reintroduce the
      // cleared turns if the adapter is unavailable after commit.
      await Zotero.DB.queryAsync(
        `UPDATE ${tables.catalog}
       SET provider_session_id = NULL,${sessionResetSql("           ")}
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
    await refreshSearchIndex(normalizedKey);
    notifyConversationCatalogChanged("turns", normalizedKey);
  }

  async function deleteTurnMessages(
    conversationKey: number,
    userTimestamp: number,
    assistantTimestamp: number,
    userMessageID?: number,
    assistantMessageID?: number,
    onBeforeCommit?: () => Promise<void>,
  ): Promise<void> {
    await deleteConversationTurnMessages(
      localRowStore,
      conversationKey,
      userTimestamp,
      assistantTimestamp,
      userMessageID,
      assistantMessageID,
      onBeforeCommit,
    );
    notifyConversationCatalogChanged("turns", conversationKey);
  }

  async function pruneConversation(
    conversationKey: number,
    keep = historyLimit,
  ): Promise<void> {
    const normalizedKey = normalizeConversationKey(conversationKey);
    if (!normalizedKey || !isStoreConversationKey(normalizedKey)) return;
    const selector = await resolveRepairingMessageConversationSelector(
      normalizedKey,
      {
        destructive: true,
      },
    );
    const searchIndexReady = await initConversationSearchIndexStore();
    await Zotero.DB.executeTransaction(async () => {
      await Zotero.DB.queryAsync(
        `DELETE FROM ${tables.messages}
       WHERE id IN (
         SELECT id
         FROM ${tables.messages}
         WHERE ${selector.whereSql}
         ORDER BY ${storedMessageDisplayOrderSql({ direction: "desc" })}
         LIMIT -1 OFFSET ?
      )`,
        [...selector.params, normalizeLimit(keep, historyLimit)],
      );
      await refreshCatalogSummary(normalizedKey);
      if (searchIndexReady) {
        await deleteConversationSearchIndexRowInTransaction({
          system,
          conversationKey: normalizedKey,
        });
      }
    });
    await refreshSearchIndex(normalizedKey);
    notifyConversationCatalogChanged("turns", normalizedKey);
  }

  /**
   * Rewrite the conversation's latest user row, or, with
   * `options.expectedTimestamp`, the user row stored at that timestamp.
   * Returns false when nothing was written: the key is not this store's, or
   * no user row has the expected timestamp.
   */
  async function updateLatestUserMessage(
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
    options: UpdateLatestUserMessageOptions = {},
  ): Promise<boolean> {
    const normalizedKey = normalizeConversationKey(conversationKey);
    if (!normalizedKey || !isStoreConversationKey(normalizedKey)) return false;
    const userRowFilter = latestUserRowFilter(options);
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
    const messageTimestamp = Number.isFinite(message.timestamp)
      ? Math.floor(message.timestamp)
      : Date.now();
    const selector =
      await resolveRepairingMessageConversationSelector(normalizedKey);
    let matched = true;
    await Zotero.DB.executeTransaction(async () => {
      if (userRowFilter.exact) {
        const rows = (await Zotero.DB.queryAsync(
          buildUserRowExistsQuery({
            tableName: tables.messages,
            whereSql: selector.whereSql,
            filterSql: userRowFilter.sql,
          }),
          [...selector.params, ...userRowFilter.params],
        )) as unknown[] | undefined;
        matched = Boolean(rows?.length);
        if (!matched) return;
      }
      await Zotero.DB.queryAsync(
        `UPDATE ${tables.messages}
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
         FROM ${tables.messages}
         WHERE ${selector.whereSql} AND role = 'user'${userRowFilter.sql}
         ORDER BY timestamp DESC, id DESC
         LIMIT 1
       )`,
        [
          message.text || "",
          messageTimestamp,
          message.runMode || null,
          message.agentRunId || null,
          message.documentId || message.planDocumentId || null,
          selectedTexts[0] || null,
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
          selectedTagContexts.length
            ? JSON.stringify(selectedTagContexts)
            : null,
          message.screenshotImages?.length
            ? JSON.stringify(message.screenshotImages)
            : null,
          message.attachments?.length
            ? JSON.stringify(message.attachments)
            : null,
          ...selector.params,
          ...userRowFilter.params,
        ],
      );
      await config.hooks?.afterMessageWriteInTransaction?.(
        normalizedKey,
        messageTimestamp,
      );
      await refreshCatalogSummary(normalizedKey);
    });
    if (!matched) return false;
    await refreshSearchIndex(normalizedKey);
    notifyConversationCatalogChanged("turns", normalizedKey);
    return true;
  }

  async function updateLatestAssistantMessage(
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
    if (!normalizedKey || !isStoreConversationKey(normalizedKey)) return;
    const messageTimestamp = Number.isFinite(message.timestamp)
      ? Math.floor(message.timestamp)
      : Date.now();
    const quoteCitations = normalizeQuoteCitations(message.quoteCitations);
    const generatedImages = normalizeGeneratedChatImages(
      message.generatedImages,
    );
    const selector =
      await resolveRepairingMessageConversationSelector(normalizedKey);
    await Zotero.DB.executeTransaction(async () => {
      await Zotero.DB.queryAsync(
        `UPDATE ${tables.messages}
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
         FROM ${tables.messages}
         WHERE ${selector.whereSql} AND role = 'assistant'
         ORDER BY timestamp DESC, id DESC
         LIMIT 1
       )`,
        [
          message.text || "",
          messageTimestamp,
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
      await config.hooks?.afterMessageWriteInTransaction?.(
        normalizedKey,
        messageTimestamp,
      );
      await refreshCatalogSummary(normalizedKey);
    });
    await refreshSearchIndex(normalizedKey);
    notifyConversationCatalogChanged("turns", normalizedKey);
  }

  async function upsertSummary(params: {
    conversationKey: number;
    instanceID?: string;
    conversationID?: string;
    libraryID: number;
    kind: RuntimeConversationKind;
    paperItemID?: number;
    createdAt?: number;
    updatedAt?: number;
    title?: string;
    providerSessionId?: string;
    providerPermissionState?: string;
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
      !isStoreConversationKeyForKind(conversationKey, params.kind)
    ) {
      return false;
    }
    const createdAt = normalizeCatalogTimestamp(params.createdAt);
    const updatedAt = normalizeCatalogTimestamp(params.updatedAt);
    const paperItemID = normalizePaperItemID(Number(params.paperItemID));
    const title = normalizeConversationTitleSeed(params.title || "") || null;
    const conversationID =
      params.conversationID?.trim() ||
      buildConversationID({
        conversationKey,
        kind: params.kind,
        libraryID,
        paperItemID,
      });
    const existing = await getSummary(conversationKey);
    if (
      existing &&
      !sameCatalogScope(existing, {
        libraryID,
        kind: params.kind,
        paperItemID,
      })
    ) {
      logConversationStoreWarning(
        `Refused to reassign ${storeLabel} conversation ${conversationKey} from ${existing.kind}/${existing.libraryID}/${existing.paperItemID || ""} to ${params.kind}/${libraryID}/${paperItemID || ""}.`,
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
        system,
        kind: params.kind,
        profileSignature: config.profileSignature(),
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
        system,
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
        `INSERT INTO ${tables.catalog}
        (conversation_id, conversation_instance_id, conversation_key, library_id, kind, paper_item_id, created_at, updated_at, last_activity_at, user_turn_count, first_user_title, title, provider_session_id${upsertExtraColumnListSql}, scoped_conversation_key, scope_type, scope_id, scope_label, cwd, model_name, effort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?${upsertExtraPlaceholderSql})
       ON CONFLICT(conversation_key) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         library_id = excluded.library_id,
         kind = excluded.kind,
         paper_item_id = excluded.paper_item_id,
         created_at = COALESCE(${tables.catalog}.created_at, excluded.created_at),
         updated_at = excluded.updated_at,
         last_activity_at = COALESCE(excluded.last_activity_at, ${tables.catalog}.last_activity_at, excluded.updated_at),
         title = COALESCE(excluded.title, ${tables.catalog}.title),
         provider_session_id = COALESCE(excluded.provider_session_id, ${tables.catalog}.provider_session_id),${upsertExtraMergeSql}
         scoped_conversation_key = COALESCE(excluded.scoped_conversation_key, ${tables.catalog}.scoped_conversation_key),
         scope_type = COALESCE(excluded.scope_type, ${tables.catalog}.scope_type),
         scope_id = COALESCE(excluded.scope_id, ${tables.catalog}.scope_id),
         scope_label = COALESCE(excluded.scope_label, ${tables.catalog}.scope_label),
         cwd = COALESCE(excluded.cwd, ${tables.catalog}.cwd),
         model_name = COALESCE(excluded.model_name, ${tables.catalog}.model_name),
         effort = COALESCE(excluded.effort, ${tables.catalog}.effort)`,
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
          ...config.upsertExtraColumns.map(
            (column) => params[column.param]?.trim() || null,
          ),
          params.scopedConversationKey?.trim() || null,
          params.scopeType?.trim() || null,
          params.scopeId?.trim() || null,
          params.scopeLabel?.trim() || null,
          params.cwd?.trim() || null,
          params.model?.trim() || null,
          params.effort?.trim() || null,
        ],
      );
      await refreshCatalogSummary(conversationKey);
    };
    if (params.inTransaction) {
      await writeCatalog();
    } else {
      await Zotero.DB.executeTransaction(writeCatalog);
    }
    if (!params.inTransaction) {
      const registered = await getRegisteredConversationScope(conversationKey);
      if (registered) await syncCatalogInstanceID(registered);
      await refreshSearchIndex(conversationKey);
    }
    notifyConversationCatalogChanged("turns", conversationKey);
    return true;
  }

  async function ensureGlobalConversation(
    libraryID: number,
    preferredConversationKey?: number,
  ): Promise<RuntimeConversationSummary | null> {
    const normalizedLibraryID = normalizeLibraryID(libraryID);
    if (!normalizedLibraryID) return null;
    const existing = await listConversations({
      libraryID: normalizedLibraryID,
      kind: "global",
      limit: 1,
    });
    return (
      existing[0] ||
      createGlobalConversation(normalizedLibraryID, {
        conversationKey: preferredConversationKey,
      })
    );
  }

  async function ensurePaperConversation(
    libraryID: number,
    paperItemID: number,
    preferredConversationKey?: number,
  ): Promise<RuntimeConversationSummary | null> {
    const normalizedLibraryID = normalizeLibraryID(libraryID);
    const normalizedPaperItemID = normalizePaperItemID(paperItemID);
    if (!normalizedLibraryID || !normalizedPaperItemID) return null;
    const existing = await listConversations({
      libraryID: normalizedLibraryID,
      kind: "paper",
      paperItemID: normalizedPaperItemID,
      limit: 1,
    });
    return (
      existing[0] ||
      createPaperConversation(normalizedLibraryID, normalizedPaperItemID, {
        conversationKey: preferredConversationKey,
      })
    );
  }

  async function allocateConversationKey(params: {
    libraryID: number;
    kind: RuntimeConversationKind;
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
      !isConversationKeyForKind(system, params.kind, preferredKey)
    ) {
      throw new Error(
        `Preferred ${storeLabel} conversation key is outside its range`,
      );
    }
    const allocate = async () => {
      if (preferredKey) {
        const instanceID = generateConversationInstanceID();
        const conversationID = buildConversationID({
          conversationKey: preferredKey,
          kind: params.kind,
          libraryID: params.libraryID,
          paperItemID: params.paperItemID,
        });
        await ensureConversationKeyLedgerEntryInTransaction({
          conversationKey: preferredKey,
          instanceID,
          conversationID,
          system,
          kind: params.kind,
          profileSignature: config.profileSignature(),
          libraryID: params.libraryID,
          paperItemID: params.paperItemID,
          issuedAt: params.issuedAt,
        });
        return { conversationKey: preferredKey, instanceID, conversationID };
      }
      const issued = await allocateConversationKeyInTransaction({
        range: {
          system,
          kind: params.kind,
          start: config.keys.allocatedRange(params.kind).start,
          endExclusive: config.keys.allocatedRange(params.kind).endExclusive,
          profileSignature: config.profileSignature(),
        },
        libraryID: params.libraryID,
        paperItemID: params.paperItemID,
        issuedAt: params.issuedAt,
      });
      const conversationID = buildConversationID({
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

  async function createGlobalConversation(
    libraryID: number,
    options: { conversationKey?: number } = {},
  ): Promise<RuntimeConversationSummary | null> {
    const normalizedLibraryID = normalizeLibraryID(libraryID);
    if (!normalizedLibraryID) return null;
    const allocated = await Zotero.DB.executeTransaction(async () => {
      const issued = await allocateConversationKey({
        libraryID: normalizedLibraryID,
        kind: "global",
        issuedAt: Date.now(),
        preferredConversationKey: options.conversationKey,
        inTransaction: true,
      });
      const stored = await upsertSummary({
        conversationKey: issued.conversationKey,
        instanceID: issued.instanceID,
        conversationID: issued.conversationID,
        libraryID: normalizedLibraryID,
        kind: "global",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        inTransaction: true,
      });
      if (!stored)
        throw new Error(`${storeLabel} conversation creation was refused`);
      return issued;
    });
    await refreshSearchIndex(allocated.conversationKey);
    config.prefs.setLastAllocatedGlobal(allocated.conversationKey);
    notifyConversationCatalogChanged("created", allocated.conversationKey);
    return getSummary(allocated.conversationKey);
  }

  async function createPaperConversation(
    libraryID: number,
    paperItemID: number,
    options: { conversationKey?: number } = {},
  ): Promise<RuntimeConversationSummary | null> {
    const normalizedLibraryID = normalizeLibraryID(libraryID);
    const normalizedPaperItemID = normalizePaperItemID(paperItemID);
    if (!normalizedLibraryID || !normalizedPaperItemID) return null;
    const allocated = await Zotero.DB.executeTransaction(async () => {
      const issued = await allocateConversationKey({
        libraryID: normalizedLibraryID,
        kind: "paper",
        paperItemID: normalizedPaperItemID,
        issuedAt: Date.now(),
        preferredConversationKey: options.conversationKey,
        inTransaction: true,
      });
      const stored = await upsertSummary({
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
      if (!stored)
        throw new Error(`${storeLabel} conversation creation was refused`);
      return issued;
    });
    await refreshSearchIndex(allocated.conversationKey);
    config.prefs.setLastAllocatedPaper(allocated.conversationKey);
    notifyConversationCatalogChanged("created", allocated.conversationKey);
    return getSummary(allocated.conversationKey);
  }

  async function preflightDeleteConversationLocalRows(
    conversationKey: number,
  ): Promise<void> {
    await preflightDeleteSharedConversationLocalRows(
      localRowStore,
      conversationKey,
    );
  }

  async function deleteConversationLocalRows(
    conversationKey: number,
    identity?: ConversationLocalRowDeletionIdentity,
  ): Promise<void> {
    await deleteSharedConversationLocalRows(
      localRowStore,
      conversationKey,
      () => tables.catalog,
      identity,
    );
    notifyConversationCatalogChanged("deleted", conversationKey);
  }

  function remapLegacyConversationKey(
    legacyConversationKey: number,
    kind: RuntimeConversationKind,
    libraryID: number,
    paperItemID?: number,
  ): number | null {
    const normalizedLegacyKey = normalizeConversationKey(legacyConversationKey);
    const normalizedLibraryID = normalizeLibraryID(libraryID);
    if (!normalizedLegacyKey || !normalizedLibraryID) return null;
    if (config.keys.isInRange(normalizedLegacyKey, kind))
      return normalizedLegacyKey;
    if (kind === "paper") {
      const normalizedPaperItemID = normalizePaperItemID(paperItemID || 0);
      if (!normalizedPaperItemID) return null;
      return config.keys.buildDefaultPaperKey(normalizedPaperItemID);
    }
    return config.keys.buildDefaultGlobalKey(normalizedLibraryID);
  }

  async function migrateLegacyConversationKeys(): Promise<
    RuntimeConversationKeyRemap[]
  > {
    const remaps: RuntimeConversationKeyRemap[] = [];
    const rows = (await Zotero.DB.queryAsync(
      `SELECT conversation_key AS conversationKey,
            library_id AS libraryID,
            kind AS kind,
            paper_item_id AS paperItemID,
            updated_at AS updatedAt
     FROM ${tables.catalog}
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
            config.keys.isInRange(conversationKey, kind)
            ? conversationKey
            : null;
        })
        .filter((value): value is number => Number.isFinite(value)),
    );
    const latestModeByLibrary = new Set<number>();
    const latestGlobalByLibrary = new Set<number>();
    const latestPaperByState = new Set<string>();
    const isRetired = async (key: number): Promise<boolean> =>
      Boolean((await getConversationKeyLedgerEntry(key))?.retiredAt);
    for (const row of rows) {
      const kind =
        row.kind === "paper"
          ? "paper"
          : row.kind === "global"
            ? "global"
            : null;
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
        // Fall through to the monotonic fallback below.
        targetConversationKey = null;
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
            ? config.prefs.getLastAllocatedPaper()
            : config.prefs.getLastAllocatedGlobal()) || 0) + 1,
          (await getMaxConversationKey(kind)) + 1,
        );
        const range = getConversationKeyRange(system, kind);
        targetConversationKey = await nextUnissuedConversationKeyInRange({
          start: range.start,
          endExclusive: range.endExclusive,
          atLeast: targetConversationKey,
        });
      }

      claimedKeys.add(targetConversationKey);
      if (targetConversationKey !== legacyConversationKey) {
        await rekeyConversationCatalogKeyInTransaction({
          table: tables.catalog,
          legacyKey: legacyConversationKey,
          targetKey: targetConversationKey,
        });
        if (!legacyKeyWasRetired) {
          await Zotero.DB.queryAsync(
            `UPDATE ${tables.messages}
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
        config.prefs.setLastUsedMode(
          libraryID,
          kind === "paper" ? "paper" : "global",
        );
        latestModeByLibrary.add(libraryID);
      }
      if (kind === "paper" && paperItemID) {
        const paperStateKey = `${libraryID}:${paperItemID}`;
        if (!latestPaperByState.has(paperStateKey)) {
          stagePaperRestoreTargetForStartup(
            { system, libraryID, paperItemID },
            targetConversationKey,
          );
          latestPaperByState.add(paperStateKey);
        }
        config.prefs.setLastAllocatedPaper(targetConversationKey);
        continue;
      }
      if (!latestGlobalByLibrary.has(libraryID)) {
        config.prefs.setLastUsedGlobal(libraryID, targetConversationKey);
        latestGlobalByLibrary.add(libraryID);
      }
      config.prefs.setLastAllocatedGlobal(targetConversationKey);
    }
    return remaps;
  }

  async function ensureCatalogColumns(
    columns: Array<{ name?: unknown }> | undefined,
  ): Promise<void> {
    const requiredColumns: Array<readonly [string, string]> = [
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
      ...config.extraCatalogColumns,
      ["scoped_conversation_key", "scoped_conversation_key TEXT"],
      ["scope_type", "scope_type TEXT"],
      ["scope_id", "scope_id TEXT"],
      ["scope_label", "scope_label TEXT"],
      ["cwd", "cwd TEXT"],
      ["model_name", "model_name TEXT"],
      ["effort", "effort TEXT"],
    ];
    for (const [columnName, definition] of requiredColumns) {
      await ensureColumn(tables.catalog, columns, columnName, definition);
    }
  }

  async function repairConversationIdentityRegistry(
    options: { inTransaction?: boolean } = {},
  ): Promise<void> {
    const rows = (await Zotero.DB.queryAsync(
      `SELECT c.conversation_id AS conversationID,
            c.conversation_key AS conversationKey,
            c.library_id AS libraryID,
            c.kind AS kind,
            c.paper_item_id AS paperItemID,
            c.created_at AS createdAt,
            ${activitySql} AS updatedAt,
            COALESCE(NULLIF(TRIM(c.title), ''), NULLIF(TRIM(c.first_user_title), '')) AS title,
            c.provider_session_id AS providerSessionId,${summaryExtraSelectSql("            ")}
            c.scoped_conversation_key AS scopedConversationKey,
            c.scope_type AS scopeType,
            c.scope_id AS scopeId,
            c.scope_label AS scopeLabel,
            c.cwd AS cwd,
            c.model_name AS modelName,
            c.effort AS effort,
            ${config.registryRepairUserTurnCountSql} AS userTurnCount
     FROM ${tables.catalog} c
     ORDER BY updatedAt DESC, c.conversation_key DESC`,
    )) as RuntimeConversationRow[] | undefined;
    for (const row of rows || []) {
      const summary = toSummary(row);
      if (!summary) continue;
      if (summary.kind === "paper") {
        const registered = await getRegisteredConversationScope(
          summary.conversationKey,
        );
        if (
          canMigrateLegacyAmbiguousPaperRegistryScope(registered, {
            system,
            kind: summary.kind,
            libraryID: summary.libraryID,
            paperItemID: summary.paperItemID,
          })
        ) {
          await repairRegisteredConversationScope(
            {
              conversationID: summary.conversationID,
              conversationKey: summary.conversationKey,
              system,
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
            `Migrated ${storeLabel} conversation ${summary.conversationKey} from legacy ${AMBIGUOUS_PAPER_CONTEXT_INVALID_REASON} invalidation to primary paper ${summary.paperItemID}.`,
          );
          continue;
        }
        if (!summary.paperItemID) {
          const evidence = getPaperContextOwnershipEvidenceFromRows(
            await getMessagePaperContextRows(summary.conversationKey),
          );
          const inferredPaperItemID = evidence.singlePaperItemID;
          if (!inferredPaperItemID) continue;
          const repairedConversationID = buildConversationID({
            conversationKey: summary.conversationKey,
            kind: "paper",
            libraryID: summary.libraryID,
            paperItemID: inferredPaperItemID,
          });
          await Zotero.DB.queryAsync(
            `UPDATE ${tables.catalog}
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
            `UPDATE ${tables.messages}
           SET conversation_id = ?
           WHERE conversation_key = ?`,
            [repairedConversationID, summary.conversationKey],
          );
          await repairRegisteredConversationScope(
            {
              conversationKey: summary.conversationKey,
              system,
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
            `Repaired ${storeLabel} conversation ${summary.conversationKey} to paper ${inferredPaperItemID} based on stored paper contexts.`,
          );
          continue;
        }
      }
      await registerConversationScope(
        {
          conversationID: summary.conversationID,
          conversationKey: summary.conversationKey,
          system,
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

  async function initStore(): Promise<void> {
    const conversationIDTransitionAlreadyApplied =
      await hasConversationSchemaMigration(
        CONVERSATION_ID_TRANSITION_MIGRATION_ID,
      );
    const applyStartupSchema = async ({
      atomically,
    }: StartupSchemaPass): Promise<void> => {
      await initConversationRegistryStore();
      await Zotero.DB.queryAsync(
        `CREATE TABLE IF NOT EXISTS ${tables.messages} (
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
        `PRAGMA table_info(${tables.messages})`,
      )) as Array<{ name?: unknown }> | undefined;
      await ensureColumn(
        tables.messages,
        columns,
        "conversation_id",
        "conversation_id TEXT",
      );
      await ensureColumn(
        tables.messages,
        columns,
        "conversation_instance_id",
        "conversation_instance_id TEXT",
      );
      await ensureColumn(
        tables.messages,
        columns,
        "document_id",
        "document_id TEXT",
      );
      await ensureColumn(
        tables.messages,
        columns,
        "selected_text_contexts_json",
        "selected_text_contexts_json TEXT",
      );
      const hasCompactMarkerColumn = Boolean(
        columns?.some((column) => column?.name === "compact_marker"),
      );
      if (!hasCompactMarkerColumn) {
        await Zotero.DB.queryAsync(
          `ALTER TABLE ${tables.messages}
         ADD COLUMN compact_marker INTEGER`,
        );
      }
      const hasContextTokensColumn = Boolean(
        columns?.some((column) => column?.name === "context_tokens"),
      );
      if (!hasContextTokensColumn) {
        await Zotero.DB.queryAsync(
          `ALTER TABLE ${tables.messages}
         ADD COLUMN context_tokens INTEGER`,
        );
      }
      const hasContextWindowColumn = Boolean(
        columns?.some((column) => column?.name === "context_window"),
      );
      if (!hasContextWindowColumn) {
        await Zotero.DB.queryAsync(
          `ALTER TABLE ${tables.messages}
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
          `ALTER TABLE ${tables.messages}
         ADD COLUMN pdf_paper_contexts_json TEXT`,
        );
      }
      if (!hasCitationPaperContextsJsonColumn) {
        await Zotero.DB.queryAsync(
          `ALTER TABLE ${tables.messages}
         ADD COLUMN citation_paper_contexts_json TEXT`,
        );
      }
      const hasQuoteCitationsJsonColumn = Boolean(
        columns?.some((column) => column?.name === "quote_citations_json"),
      );
      if (!hasQuoteCitationsJsonColumn) {
        await Zotero.DB.queryAsync(
          `ALTER TABLE ${tables.messages}
         ADD COLUMN quote_citations_json TEXT`,
        );
      }
      await ensureColumn(
        tables.messages,
        columns,
        "collection_contexts_json",
        "collection_contexts_json TEXT",
      );
      await ensureColumn(
        tables.messages,
        columns,
        "tag_contexts_json",
        "tag_contexts_json TEXT",
      );
      await ensureColumn(
        tables.messages,
        columns,
        "forced_skill_ids_json",
        "forced_skill_ids_json TEXT",
      );
      await ensureColumn(
        tables.messages,
        columns,
        "generated_images_json",
        "generated_images_json TEXT",
      );
      await ensureColumn(
        tables.messages,
        columns,
        "interrupted",
        "interrupted INTEGER",
      );
      await Zotero.DB.queryAsync(
        `CREATE INDEX IF NOT EXISTS ${tables.messagesIndex}
       ON ${tables.messages} (conversation_key, timestamp, id)`,
      );
      await Zotero.DB.queryAsync(
        `CREATE INDEX IF NOT EXISTS ${tables.messagesIdIndex}
       ON ${tables.messages} (conversation_id, timestamp, id)`,
      );

      await Zotero.DB.queryAsync(
        `CREATE TABLE IF NOT EXISTS ${tables.catalog} (
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
        provider_session_id TEXT,${extraCatalogCreateSql}
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
        `PRAGMA table_info(${tables.catalog})`,
      )) as Array<{ name?: unknown }> | undefined;
      await ensureCatalogColumns(conversationColumns);
      let migratedKeyRemaps: RuntimeConversationKeyRemap[] = [];
      if (!conversationIDTransitionAlreadyApplied) {
        await backfillConversationTimestamps();
      }
      await Zotero.DB.queryAsync(
        `CREATE INDEX IF NOT EXISTS ${tables.kindIndex}
       ON ${tables.catalog} (library_id, kind, paper_item_id, updated_at DESC, conversation_key DESC)`,
      );
      await Zotero.DB.queryAsync(
        `CREATE INDEX IF NOT EXISTS ${tables.activityIndex}
       ON ${tables.catalog} (library_id, kind, paper_item_id, last_activity_at DESC, updated_at DESC, conversation_key DESC)`,
      );
      await Zotero.DB.queryAsync(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${tables.idIndex}
       ON ${tables.catalog} (conversation_id)`,
      );
      if (!conversationIDTransitionAlreadyApplied) {
        await initConversationKeyLedgerStore();
        await initRecentlyDeletedConversationTombstones();
        await seedConversationKeyLedgerFromTombstones();
        await reserveOrphanConversationMessageKeys({
          messageTable: tables.messages,
          catalogTables: [tables.catalog],
          system,
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
        await config.hooks?.beforeLegacyKeyMigration?.();
        migratedKeyRemaps = await migrateLegacyConversationKeys();
        await backfillConversationIDs();
        await repairConversationIdentityRegistry({ inTransaction: true });
        await refreshCatalogSummary();
      }
      await runConversationSchemaMigrationOnce(
        config.instanceIdMigrationID,
        `Backfill immutable conversation instance identities for ${storeLabel} catalogs and registry rows.`,
        async () => {
          await backfillConversationIDs();
          await backfillConversationInstanceIDs();
          await repairConversationIdentityRegistry({ inTransaction: true });
        },
      );
      await refreshConversationKeyLedgerStore();
      await initRecentlyDeletedConversationTombstones();
      await runConversationSchemaMigrationOnce(
        CONVERSATION_KEY_LEDGER_MIGRATION_ID,
        `Reserve every existing ${storeLabel} conversation key permanently and initialize the monotonic allocator.`,
        async () => {
          await seedConversationKeyLedgerFromCatalogs([
            {
              table: tables.catalog,
              system,
              kind: "global",
              kindColumn: true,
            },
            {
              table: tables.catalog,
              system,
              kind: "paper",
              kindColumn: true,
            },
          ]);
        },
      );
      await seedConversationKeyLedgerFromCatalogs([
        {
          table: tables.catalog,
          system,
          kind: "global",
          kindColumn: true,
        },
        {
          table: tables.catalog,
          system,
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
        messageTable: tables.messages,
        catalogTables: [tables.catalog],
        system,
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
        system,
        kind: "global",
        catalogTables: [tables.catalog],
        atomically,
      });
      await retireOrphanedConversationLedgerEntries({
        system,
        kind: "paper",
        catalogTables: [tables.catalog],
        atomically,
      });
      const globalRange = config.keys.allocatedRange("global");
      const paperRange = config.keys.allocatedRange("paper");
      await initializeConversationKeyCounterInTransaction({
        system,
        kind: "global",
        start: globalRange.start,
        endExclusive: globalRange.endExclusive,
        profileSignature: config.profileSignature(),
      });
      await initializeConversationKeyCounterInTransaction({
        system,
        kind: "paper",
        start: paperRange.start,
        endExclusive: paperRange.endExclusive,
        profileSignature: config.profileSignature(),
      });
      await Zotero.DB.queryAsync(
        `UPDATE ${tables.messages}
       SET conversation_instance_id = (
         SELECT c.conversation_instance_id
         FROM ${tables.catalog} c
         WHERE c.conversation_key = ${tables.messages}.conversation_key
       )
       WHERE conversation_instance_id IS NULL
          OR TRIM(conversation_instance_id) = ''`,
      );
      await installConversationKeyLedgerCatalogTriggers([tables.catalog]);
      await installConversationKeyLedgerMessageTriggers({
        messageTable: tables.messages,
      });
    };
    await runConversationStoreStartupSchema({
      storeID: config.startupStoreID,
      schemaRevision: config.schemaRevision,
      migrationIDs: startupMigrationIDs,
      body: applyStartupSchema,
    });
    config.hooks?.afterStartupSchema?.();
  }

  async function resolveRegisteredConversationInstanceID(
    conversationKey: number,
  ): Promise<string | null> {
    const registered = await getRegisteredConversationScope(conversationKey);
    if (registered?.instanceID) return registered.instanceID;
    const ledger = await getConversationKeyLedgerEntry(conversationKey);
    return ledger?.instanceID || null;
  }

  async function assertForkSourceLive(params: {
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
     FROM ${tables.catalog}
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

  /** D8: only a store configured with `fork` (Codex) can fork. */
  function requireForkConfig(): NonNullable<RuntimeStoreConfig["fork"]> {
    if (!config.fork) {
      throw new Error(`${storeLabel} conversations cannot be forked`);
    }
    return config.fork;
  }

  async function forkConversationMessages(params: {
    sourceConversationKey: number;
    sourceInstanceID?: string;
    sourceConversationID?: string;
    targetConversationKey: number;
    throughAssistantTimestamp: number;
    timestampBase?: number;
  }): Promise<ForkConversationMessagesResult> {
    const fork = requireForkConfig();
    const result = await copyConversationMessagesThroughAssistantAnchor(
      {
        tableName: tables.messages,
        copyColumns: fork.copyColumns,
        isValidConversationKey: isStoreConversationKey,
        resolveSourceSelector: resolveRepairingMessageConversationSelector,
        resolveTargetConversationID: resolveRegisteredConversationID,
        resolveTargetInstanceID: resolveRegisteredConversationInstanceID,
        assertSourceConversationLive: assertForkSourceLive,
        refreshCatalogSummary,
        refreshSearchIndex,
        afterCopy: config.hooks?.afterMessageWriteInTransaction,
      },
      params,
    );
    notifyConversationCatalogChanged("turns", params.targetConversationKey);
    return result;
  }

  async function getLatestForkableAssistantTimestamp(
    conversationKey: number,
  ): Promise<number> {
    requireForkConfig();
    const normalizedKey = normalizeConversationKey(conversationKey);
    if (!normalizedKey || !isStoreConversationKey(normalizedKey)) return 0;
    const selector =
      await resolveRepairingMessageConversationSelector(normalizedKey);
    const rows = (await Zotero.DB.queryAsync(
      `SELECT timestamp
     FROM ${tables.messages}
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

  return {
    isStoreConversationKey,
    startupMigrationIDs,
    initStore,
    repairConversationIdentityRegistry,
    appendMessage,
    loadConversation,
    clearConversation,
    deleteTurnMessages,
    pruneConversation,
    updateLatestUserMessage,
    updateLatestAssistantMessage,
    getSummary,
    upsertSummary,
    listGlobalConversations,
    listPaperConversations,
    listAllPaperConversationsByLibrary,
    ensureGlobalConversation,
    ensurePaperConversation,
    createGlobalConversation,
    createPaperConversation,
    touchConversationTitle,
    clearConversationSessionMetadata,
    setConversationTitle,
    deleteConversation,
    preflightDeleteConversationLocalRows,
    deleteConversationLocalRows,
    forkConversationMessages,
    getLatestForkableAssistantTimestamp,
  };
}

export type RuntimeConversationStore = ReturnType<
  typeof createRuntimeConversationStore
>;

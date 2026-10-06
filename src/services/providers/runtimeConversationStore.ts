declare const Zotero: any;

import type { CodexConversationSummary } from "../../shared/types";
import type { StoredChatMessage } from "../../utils/chatStore";
import {
  isConversationKeyFor,
  isConversationKeyForKind,
} from "../../shared/conversationKeySpace";
import {
  buildConversationID as buildSharedConversationID,
  getRegisteredConversationScope,
  type PaperContextJsonColumns,
} from "../../shared/conversationRegistry";
import {
  ConversationRetiredError,
  getConversationKeyLedgerEntry,
  isConversationKeyLedgerStoreInitialized,
} from "../../shared/conversationKeyLedger";
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
  tables: RuntimeStoreTables;
  /** Default and fallback row limit for loading a conversation. */
  historyLimit: number;
  /**
   * D1: the activity timestamp of catalog alias `c`, reported as `updatedAt`
   * and used to order every summary and list query.
   */
  activityTimestampSqlForAliasC: string;
  /** D3: extra catalog columns read into the summary (Codex only). */
  summaryExtraColumns: ReadonlyArray<{
    sql: string;
    alias: "providerPermissionState";
  }>;
  keys: {
    allocatedRange(kind: RuntimeConversationKind): {
      start: number;
      endExclusive: number;
    };
  };
  prefs: {
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

  return {
    isStoreConversationKey,
    isStoreConversationKeyForKind,
    buildConversationID,
    resolveRegisteredConversationID,
    resolveAppendIdentity,
    getMessagePaperContextRows,
    resolveRepairingMessageConversationSelector,
    refreshSearchIndex,
    deleteSearchIndex,
    backfillConversationTimestamps,
    refreshCatalogSummary,
    repairRecoverableCatalogMessageConversationIDs,
    backfillConversationIDs,
    backfillConversationInstanceIDs,
    sameCatalogScope,
    filterValidSummaries,
    loadConversation,
    toSummary,
    getSummary,
    listConversations,
    listGlobalConversations,
    listPaperConversations,
    listAllPaperConversationsByLibrary,
    getMaxConversationKey,
  };
}

export type RuntimeConversationStore = ReturnType<
  typeof createRuntimeConversationStore
>;

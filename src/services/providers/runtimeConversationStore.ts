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
import { storedMessageDisplayOrderSql } from "../../shared/conversationMessageSql";
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
  withRetiredKeyErrorMapping,
} from "../../shared/conversationKeyLedger";
import {
  deleteConversationSearchIndexRowInTransaction,
  initConversationSearchIndexStore,
} from "../../shared/conversationSearchIndex";
import { pendingDeletionStore } from "../../core/conversations/pendingDeletionStore";
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
  };
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
    // Remove the old indexed body in the same transaction as pruning.  The
    // post-commit refresh is best-effort, but it must never leave deleted text
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
  }

  async function deleteTurnMessages(
    conversationKey: number,
    userTimestamp: number,
    assistantTimestamp: number,
    userMessageID?: number,
    assistantMessageID?: number,
    onBeforeCommit?: () => Promise<void>,
  ): Promise<void> {
    const normalizedKey = normalizeConversationKey(conversationKey);
    if (!normalizedKey || !isStoreConversationKey(normalizedKey)) return;
    const normalizedUserTimestamp = Number.isFinite(userTimestamp)
      ? Math.floor(userTimestamp)
      : 0;
    const normalizedAssistantTimestamp = Number.isFinite(assistantTimestamp)
      ? Math.floor(assistantTimestamp)
      : 0;
    if (normalizedUserTimestamp <= 0 || normalizedAssistantTimestamp <= 0)
      return;
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
          `DELETE FROM ${tables.messages}
         WHERE id = ? AND ${selector.whereSql} AND role = 'user'`,
          [normalizedUserMessageID, ...selector.params],
        );
      } else {
        await Zotero.DB.queryAsync(
          `DELETE FROM ${tables.messages}
         WHERE id = (
           SELECT id
           FROM ${tables.messages}
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
          `DELETE FROM ${tables.messages}
         WHERE id = ? AND ${selector.whereSql} AND role = 'assistant'`,
          [normalizedAssistantMessageID, ...selector.params],
        );
      } else {
        await Zotero.DB.queryAsync(
          `DELETE FROM ${tables.messages}
         WHERE id = (
           SELECT id
           FROM ${tables.messages}
           WHERE ${selector.whereSql}
             AND role = 'assistant'
             AND timestamp = ?
           ORDER BY id DESC
           LIMIT 1
         )`,
          [...selector.params, normalizedAssistantTimestamp],
        );
      }
      await refreshCatalogSummary(normalizedKey);
      if (searchIndexReady) {
        await deleteConversationSearchIndexRowInTransaction({
          system: system,
          conversationKey: normalizedKey,
        });
      }
      await onBeforeCommit?.();
    });
    await refreshSearchIndex(normalizedKey);
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
          system: system,
          conversationKey: normalizedKey,
        });
      }
    });
    await refreshSearchIndex(normalizedKey);
  }

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
  ): Promise<void> {
    const normalizedKey = normalizeConversationKey(conversationKey);
    if (!normalizedKey || !isStoreConversationKey(normalizedKey)) return;
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
    await Zotero.DB.executeTransaction(async () => {
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
         WHERE ${selector.whereSql} AND role = 'user'
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
        ],
      );
      await config.hooks?.afterMessageWriteInTransaction?.(
        normalizedKey,
        messageTimestamp,
      );
      await refreshCatalogSummary(normalizedKey);
    });
    await refreshSearchIndex(normalizedKey);
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
    touchConversationTitle,
    clearConversationSessionMetadata,
    setConversationTitle,
    deleteConversation,
    appendMessage,
    clearConversation,
    deleteTurnMessages,
    pruneConversation,
    updateLatestUserMessage,
    updateLatestAssistantMessage,
  };
}

export type RuntimeConversationStore = ReturnType<
  typeof createRuntimeConversationStore
>;

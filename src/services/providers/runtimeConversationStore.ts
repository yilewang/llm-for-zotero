declare const Zotero: any;

import type { CodexConversationSummary } from "../../shared/types";
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

export function createRuntimeConversationStore(config: RuntimeStoreConfig) {
  const { system, storeLabel, tables } = config;

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
  };
}

export type RuntimeConversationStore = ReturnType<
  typeof createRuntimeConversationStore
>;

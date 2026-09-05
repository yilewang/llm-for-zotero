declare const Zotero: any;

import type {
  ClaudeConversationSummary,
  ClaudeConversationKind,
  GeneratedChatImage,
  QuoteCitation,
} from "../shared/types";
import { normalizeGeneratedChatImages } from "../shared/generatedImages";
import {
  normalizeSelectedTextNoteContexts,
  normalizeSelectedTextPaperContexts,
  normalizeSelectedTextSource,
  synthesizeSelectedTextContexts,
  normalizePaperContextRefs,
  normalizeCollectionContextRefs,
  normalizeTagContextRefs,
} from "../modules/contextPanel/normalizers";
import { normalizeQuoteCitations } from "../modules/contextPanel/quoteCitations";
import type { StoredChatMessage } from "../utils/chatStore";
import {
  parseForcedSkillIdsJson,
  serializeForcedSkillIds,
} from "../shared/skillIds";
import {
  isConversationKeyFor,
  isConversationKeyForKind,
  getConversationKeyRange,
} from "../shared/conversationKeySpace";
import {
  buildLatestStoredMessagesQuery,
  storedMessageDisplayOrderSql,
} from "../shared/conversationMessageSql";
import {
  CLAUDE_HISTORY_LIMIT,
  buildDefaultClaudeGlobalConversationKey,
  buildDefaultClaudePaperConversationKey,
  getClaudeAllocatedConversationKeyRange,
  getClaudeGlobalConversationKeyRange,
  getClaudePaperConversationKeyRange,
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
  buildConversationID,
  canMigrateLegacyAmbiguousPaperRegistryScope,
  getConversationScopeValidationDetails,
  getPaperContextOwnershipEvidenceFromRows,
  getRegisteredConversationScope,
  generateConversationInstanceID,
  initConversationRegistryStore,
  deleteRegisteredConversationScopeInTransaction,
  registerConversationScope,
  repairRegisteredConversationScope,
  syncCatalogInstanceID,
  type ConversationRegistryRow,
  type PaperContextJsonColumns,
} from "../shared/conversationRegistry";
import { stagePaperRestoreTargetForStartup } from "../shared/paperConversationRestore";
import {
  repairRecoverableCatalogMessageConversationIDs,
  repairRecoverableMessageConversationIDs,
} from "../shared/conversationMessageIdentityRepair";
import {
  deleteConversationSearchIndexRow,
  deleteConversationSearchIndexRowInTransaction,
  initConversationSearchIndexStore,
  refreshConversationSearchIndexForConversation,
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
  areConversationWritesFrozen,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../shared/conversationWriteFence";
import { clearPersistedAgentConversationRowsInTransaction } from "../modules/contextPanel/agentConversationCleanup";
import { clearOwnerAttachmentRefsInTransaction } from "../utils/attachmentRefStore";

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
const CLAUDE_MESSAGE_SELECT_COLUMNS_SQL = `id,
            role,
            text,
            timestamp,
            run_mode AS runMode,
            agent_run_id AS agentRunId,
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

function normalizeConversationKey(conversationKey: number): number | null {
  if (!Number.isFinite(conversationKey)) return null;
  const normalized = Math.floor(conversationKey);
  return normalized > 0 ? normalized : null;
}

function normalizeLibraryID(libraryID: number): number | null {
  if (!Number.isFinite(libraryID)) return null;
  const normalized = Math.floor(libraryID);
  return normalized > 0 ? normalized : null;
}

function normalizePaperItemID(paperItemID: number): number | null {
  if (!Number.isFinite(paperItemID)) return null;
  const normalized = Math.floor(paperItemID);
  return normalized > 0 ? normalized : null;
}

function normalizeLimit(limit: number, fallback: number): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.floor(limit));
}

function normalizeOptionalLimit(
  limit: number | null | undefined,
): number | null {
  if (limit === null) return null;
  if (!Number.isFinite(Number(limit))) return null;
  const normalized = Math.floor(Number(limit));
  return normalized > 0 ? normalized : null;
}

function isClaudeStoreConversationKey(conversationKey: number): boolean {
  return isConversationKeyFor("claude_code", conversationKey);
}

function isClaudeStoreConversationKeyForKind(
  conversationKey: number,
  kind: ClaudeConversationKind,
): boolean {
  return isConversationKeyForKind("claude_code", kind, conversationKey);
}

function normalizeConversationTitleSeed(value: string): string {
  if (typeof value !== "string") return "";
  const normalized = value

    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized.slice(0, 96);
}

function normalizeCatalogTimestamp(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return Date.now();
  return Math.floor(parsed);
}

function buildClaudeConversationID(params: {
  conversationKey: number;
  kind: ClaudeConversationKind;
  libraryID: number;
  paperItemID?: number | null;
}): string {
  return buildConversationID({
    conversationKey: params.conversationKey,
    system: "claude_code",
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

async function resolveClaudeAppendIdentity(
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

type MessageConversationSelector = {
  whereSql: string;
  params: unknown[];
  registered?: ConversationRegistryRow | null;
};

async function resolveMessageConversationSelector(
  conversationKey: number,
): Promise<MessageConversationSelector> {
  const registered = await getRegisteredConversationScope(conversationKey);
  const conversationID = registered?.conversationID || null;
  return conversationID
    ? {
        whereSql:
          "(conversation_id = ? OR ((conversation_id IS NULL OR TRIM(conversation_id) = '') AND conversation_key = ?))",
        params: [conversationID, conversationKey],
        registered,
      }
    : {
        whereSql: "1 = 0",
        params: [],
        registered,
      };
}

function messageJoinCondition(
  messageAlias: string,
  conversationAlias: string,
): string {
  return (
    `(${messageAlias}.conversation_id = ${conversationAlias}.conversation_id OR ((` +
    `${messageAlias}.conversation_id IS NULL OR TRIM(${messageAlias}.conversation_id) = '') AND ` +
    `${messageAlias}.conversation_key = ${conversationAlias}.conversation_key))`
  );
}

function canonicalMessageConversationSelector(
  registered: ConversationRegistryRow,
): MessageConversationSelector {
  return {
    whereSql: "conversation_id = ?",
    params: [registered.conversationID],
    registered,
  };
}

async function resolveRepairingMessageConversationSelector(
  conversationKey: number,
  options: { destructive?: boolean } = {},
): Promise<MessageConversationSelector> {
  let selector = await resolveMessageConversationSelector(conversationKey);
  if (!selector.registered?.conversationID) return selector;
  const repair = await repairRecoverableMessageConversationIDs({
    queryAsync: Zotero.DB.queryAsync.bind(Zotero.DB),
    tableName: CLAUDE_MESSAGES_TABLE,
    registered: selector.registered,
    getPaperContextRows: getClaudeMessagePaperContextRows,
    storeLabel: "Claude",
    log: logClaudeScopeWarning,
  });
  if (repair.status === "refused") {
    if (options.destructive) {
      throw new Error(
        `Refused destructive Claude conversation operation for ${conversationKey}: ${repair.reason || "ambiguous stale message ids found"}.`,
      );
    }
    selector = canonicalMessageConversationSelector(selector.registered);
  }
  return selector;
}

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

function logClaudeScopeWarning(message: string): void {
  const debug = (
    globalThis as typeof globalThis & {
      Zotero?: { debug?: (message: string) => void };
    }
  ).Zotero?.debug;
  debug?.(`LLM: ${message}`);
}

function formatSearchIndexError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function refreshClaudeConversationSearchIndex(
  conversationKey: number,
): Promise<void> {
  try {
    await refreshConversationSearchIndexForConversation({
      system: "claude_code",
      conversationKey,
    });
  } catch (error) {
    logClaudeScopeWarning(
      `Failed to refresh Claude conversation search index for ${conversationKey}: ${formatSearchIndexError(error)}`,
    );
  }
}

async function deleteClaudeConversationSearchIndex(
  conversationKey: number,
): Promise<void> {
  await deleteConversationSearchIndexRow({
    system: "claude_code",
    conversationKey,
  });
}

async function ensureColumn(
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

async function backfillClaudeConversationTimestamps(): Promise<void> {
  const now = Date.now();
  await Zotero.DB.queryAsync(
    `UPDATE ${CLAUDE_CONVERSATIONS_TABLE}
     SET created_at = COALESCE(
       created_at,
       (SELECT MIN(m.timestamp)
        FROM ${CLAUDE_MESSAGES_TABLE} m
        WHERE m.conversation_key = ${CLAUDE_CONVERSATIONS_TABLE}.conversation_key),
       ?
     )
     WHERE created_at IS NULL`,
    [now],
  );
  await Zotero.DB.queryAsync(
    `UPDATE ${CLAUDE_CONVERSATIONS_TABLE}
     SET updated_at = COALESCE(
       updated_at,
       (SELECT MAX(m.timestamp)
        FROM ${CLAUDE_MESSAGES_TABLE} m
        WHERE m.conversation_key = ${CLAUDE_CONVERSATIONS_TABLE}.conversation_key),
       created_at,
       ?
     )
     WHERE updated_at IS NULL`,
    [now],
  );
}

async function refreshClaudeConversationCatalogSummary(
  conversationKey?: number,
): Promise<void> {
  const normalizedKey =
    conversationKey === undefined
      ? null
      : normalizeConversationKey(conversationKey);
  if (conversationKey !== undefined && !normalizedKey) return;
  await repairRecoverableClaudeCatalogMessageConversationIDs(
    normalizedKey || undefined,
  );
  const whereSql = normalizedKey ? "WHERE conversation_key = ?" : "";
  const params = normalizedKey ? [normalizedKey] : [];
  await Zotero.DB.queryAsync(
    `UPDATE ${CLAUDE_CONVERSATIONS_TABLE}
     SET first_user_title = (
           SELECT m0.text
           FROM ${CLAUDE_MESSAGES_TABLE} m0
           WHERE ${messageJoinCondition("m0", CLAUDE_CONVERSATIONS_TABLE)}
             AND m0.role = 'user'
           ORDER BY m0.timestamp ASC, m0.id ASC
           LIMIT 1
         ),
         last_activity_at = COALESCE(
           (
             SELECT MAX(m.timestamp)
             FROM ${CLAUDE_MESSAGES_TABLE} m
             WHERE ${messageJoinCondition("m", CLAUDE_CONVERSATIONS_TABLE)}
           ),
           updated_at,
           created_at
         ),
         user_turn_count = COALESCE(
           (
             SELECT SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END)
             FROM ${CLAUDE_MESSAGES_TABLE} m
             WHERE ${messageJoinCondition("m", CLAUDE_CONVERSATIONS_TABLE)}
           ),
           0
         )
     ${whereSql}`,
    params,
  );
}

async function getClaudeMessagePaperContextRows(
  conversationKey: number,
): Promise<PaperContextJsonColumns[]> {
  return ((await Zotero.DB.queryAsync(
    `SELECT paper_contexts_json AS paperContextsJson,
            pdf_paper_contexts_json AS pdfPaperContextsJson,
            full_text_paper_contexts_json AS fullTextPaperContextsJson,
            selected_text_paper_contexts_json AS selectedTextPaperContextsJson,
            citation_paper_contexts_json AS citationPaperContextsJson
     FROM ${CLAUDE_MESSAGES_TABLE}
     WHERE conversation_key = ?
       AND (
         paper_contexts_json IS NOT NULL OR
         pdf_paper_contexts_json IS NOT NULL OR
         full_text_paper_contexts_json IS NOT NULL OR
         selected_text_paper_contexts_json IS NOT NULL OR
         citation_paper_contexts_json IS NOT NULL
       )`,
    [conversationKey],
  )) || []) as PaperContextJsonColumns[];
}

async function repairRecoverableClaudeCatalogMessageConversationIDs(
  conversationKey?: number,
): Promise<{
  checked: number;
  repaired: number;
  refused: number;
}> {
  const normalizedKey =
    conversationKey === undefined
      ? null
      : normalizeConversationKey(conversationKey);
  if (conversationKey !== undefined && !normalizedKey) {
    return { checked: 0, repaired: 0, refused: 0 };
  }
  return await repairRecoverableCatalogMessageConversationIDs({
    queryAsync: Zotero.DB.queryAsync.bind(Zotero.DB),
    catalogTable: CLAUDE_CONVERSATIONS_TABLE,
    messageTable: CLAUDE_MESSAGES_TABLE,
    system: "claude_code",
    kindSql: "c.kind",
    paperItemIDSql: "c.paper_item_id",
    getPaperContextRows: getClaudeMessagePaperContextRows,
    storeLabel: "Claude",
    log: logClaudeScopeWarning,
    ...(normalizedKey
      ? { filterSql: "c.conversation_key = ?", filterParams: [normalizedKey] }
      : {}),
  });
}

async function backfillClaudeConversationIDs(): Promise<void> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT conversation_key AS conversationKey,
            library_id AS libraryID,
            kind AS kind,
            paper_item_id AS paperItemID
     FROM ${CLAUDE_CONVERSATIONS_TABLE}`,
  )) as
    | Array<{
        conversationKey?: unknown;
        libraryID?: unknown;
        kind?: unknown;
        paperItemID?: unknown;
      }>
    | undefined;
  for (const row of rows || []) {
    const conversationKey = normalizeConversationKey(
      Number(row.conversationKey),
    );
    const libraryID = normalizeLibraryID(Number(row.libraryID));
    const kind =
      row.kind === "paper" ? "paper" : row.kind === "global" ? "global" : null;
    if (!conversationKey || !libraryID || !kind) continue;
    const paperItemID = normalizePaperItemID(Number(row.paperItemID));
    const conversationID = buildClaudeConversationID({
      conversationKey,
      kind,
      libraryID,
      paperItemID,
    });
    await Zotero.DB.queryAsync(
      `UPDATE ${CLAUDE_CONVERSATIONS_TABLE}
       SET conversation_id = ?
       WHERE conversation_key = ?
         AND (conversation_id IS NULL OR TRIM(conversation_id) = '')`,
      [conversationID, conversationKey],
    );
    await Zotero.DB.queryAsync(
      `UPDATE ${CLAUDE_MESSAGES_TABLE}
       SET conversation_id = ?
       WHERE conversation_key = ?
         AND (conversation_id IS NULL OR TRIM(conversation_id) = '')`,
      [conversationID, conversationKey],
    );
  }
}

async function backfillClaudeConversationInstanceIDs(): Promise<void> {
  await Zotero.DB.queryAsync(
    `UPDATE ${CLAUDE_CONVERSATIONS_TABLE}
     SET conversation_instance_id = (
       SELECT r.instance_id
       FROM llm_for_zotero_conversation_registry r
       WHERE r.conversation_id = ${CLAUDE_CONVERSATIONS_TABLE}.conversation_id
         AND r.instance_id IS NOT NULL
         AND TRIM(r.instance_id) <> ''
       LIMIT 1
     )
     WHERE (conversation_instance_id IS NULL OR TRIM(conversation_instance_id) = '')
       AND conversation_id IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM llm_for_zotero_conversation_registry r
         WHERE r.conversation_id = ${CLAUDE_CONVERSATIONS_TABLE}.conversation_id
           AND r.instance_id IS NOT NULL
           AND TRIM(r.instance_id) <> ''
       )`,
  );
  const rows = (await Zotero.DB.queryAsync(
    `SELECT conversation_key AS conversationKey
     FROM ${CLAUDE_CONVERSATIONS_TABLE}
     WHERE conversation_instance_id IS NULL
        OR TRIM(conversation_instance_id) = ''`,
  )) as Array<{ conversationKey?: unknown }> | undefined;
  for (const row of rows || []) {
    const conversationKey = normalizeConversationKey(
      Number(row.conversationKey),
    );
    if (!conversationKey) continue;
    await Zotero.DB.queryAsync(
      `UPDATE ${CLAUDE_CONVERSATIONS_TABLE}
       SET conversation_instance_id = ?
       WHERE conversation_key = ?
         AND (conversation_instance_id IS NULL OR TRIM(conversation_instance_id) = '')`,
      [generateConversationInstanceID(), conversationKey],
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
        logClaudeScopeWarning(
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
        logClaudeScopeWarning(
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

export async function initClaudeCodeStore(): Promise<void> {
  const conversationIDTransitionAlreadyApplied =
    await hasConversationSchemaMigration(
      CONVERSATION_ID_TRANSITION_MIGRATION_ID,
    );
  await Zotero.DB.executeTransaction(async () => {
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
    });
    await retireOrphanedConversationLedgerEntries({
      system: "claude_code",
      kind: "paper",
      catalogTables: [CLAUDE_CONVERSATIONS_TABLE],
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
        (conversation_id, conversation_key, role, text, timestamp, run_mode, agent_run_id, selected_text, selected_text_contexts_json, selected_texts_json, selected_text_sources_json, selected_text_paper_contexts_json, selected_text_note_contexts_json, forced_skill_ids_json, paper_contexts_json, pdf_paper_contexts_json, full_text_paper_contexts_json, citation_paper_contexts_json, quote_citations_json, collection_contexts_json, tag_contexts_json, screenshot_images, attachments_json, generated_images_json, model_name, model_entry_id, model_provider_label, interrupted, webchat_run_state, webchat_completion_reason, reasoning_summary, reasoning_details, compact_marker, context_tokens, context_window${identityColumn})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${identityPlaceholder})`,
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
            ...(identityAvailable ? [appendIdentity.instanceID] : []),
          ],
        );
        await refreshClaudeConversationCatalogSummary(normalizedKey);
      }),
  );
  await refreshClaudeConversationSearchIndex(normalizedKey);
}

export async function loadClaudeConversation(
  conversationKey: number,
  limit = CLAUDE_HISTORY_LIMIT,
): Promise<StoredChatMessage[]> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isClaudeStoreConversationKey(normalizedKey)) return [];
  const selector =
    await resolveRepairingMessageConversationSelector(normalizedKey);
  const normalizedLimit = normalizeLimit(limit, CLAUDE_HISTORY_LIMIT);
  const rows = (await Zotero.DB.queryAsync(
    buildLatestStoredMessagesQuery({
      tableName: CLAUDE_MESSAGES_TABLE,
      selectColumnsSql: CLAUDE_MESSAGE_SELECT_COLUMNS_SQL,
      whereSql: selector.whereSql,
    }),
    [...selector.params, normalizedLimit],
  )) as Array<Record<string, unknown>> | undefined;

  if (!rows?.length) return [];

  const messages: StoredChatMessage[] = [];
  for (const row of rows) {
    const role =
      row.role === "assistant"
        ? "assistant"
        : row.role === "user"
          ? "user"
          : null;
    if (!role) continue;
    const selectedTexts = (() => {
      if (typeof row.selectedTextsJson !== "string" || !row.selectedTextsJson) {
        return typeof row.selectedText === "string" && row.selectedText.trim()
          ? [row.selectedText.trim()]
          : [];
      }
      try {
        const parsed = JSON.parse(row.selectedTextsJson) as unknown;
        return Array.isArray(parsed)
          ? parsed.filter(
              (entry): entry is string =>
                typeof entry === "string" && Boolean(entry.trim()),
            )
          : [];
      } catch {
        return [];
      }
    })();
    const selectedTextSources = (() => {
      if (
        typeof row.selectedTextSourcesJson !== "string" ||
        !row.selectedTextSourcesJson
      ) {
        return undefined;
      }
      try {
        const parsed = JSON.parse(row.selectedTextSourcesJson) as unknown;
        return Array.isArray(parsed)
          ? parsed.map((entry) => normalizeSelectedTextSource(entry))
          : undefined;
      } catch {
        return undefined;
      }
    })();
    const selectedTextPaperContexts = (() => {
      if (
        typeof row.selectedTextPaperContextsJson !== "string" ||
        !row.selectedTextPaperContextsJson
      ) {
        return undefined;
      }
      try {
        const parsed = JSON.parse(row.selectedTextPaperContextsJson) as unknown;
        const normalized = normalizeSelectedTextPaperContexts(
          parsed,
          selectedTexts.length,
        );
        return normalized.some((entry) => Boolean(entry))
          ? normalized
          : undefined;
      } catch {
        return undefined;
      }
    })();
    const selectedTextNoteContexts = (() => {
      if (
        typeof row.selectedTextNoteContextsJson !== "string" ||
        !row.selectedTextNoteContextsJson
      ) {
        return undefined;
      }
      try {
        const parsed = JSON.parse(row.selectedTextNoteContextsJson) as unknown;
        const normalized = normalizeSelectedTextNoteContexts(
          parsed,
          selectedTexts.length,
        );
        return normalized.some((entry) => Boolean(entry))
          ? normalized
          : undefined;
      } catch {
        return undefined;
      }
    })();
    const selectedTextContexts = synthesizeSelectedTextContexts({
      selectedTextContexts: (() => {
        if (
          typeof row.selectedTextContextsJson !== "string" ||
          !row.selectedTextContextsJson
        ) {
          return undefined;
        }
        try {
          return JSON.parse(row.selectedTextContextsJson) as unknown;
        } catch {
          return undefined;
        }
      })(),
      selectedTexts,
      legacySelectedText: row.selectedText,
      selectedTextSources,
      selectedTextPaperContexts,
      selectedTextNoteContexts,
    });
    const paperContexts = (() => {
      if (typeof row.paperContextsJson !== "string" || !row.paperContextsJson)
        return undefined;
      try {
        const parsed = JSON.parse(row.paperContextsJson) as unknown;
        const normalized = normalizePaperContextRefs(parsed);
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const pdfPaperContexts = (() => {
      if (
        typeof row.pdfPaperContextsJson !== "string" ||
        !row.pdfPaperContextsJson
      )
        return undefined;
      try {
        const normalized = normalizePaperContextRefs(
          JSON.parse(row.pdfPaperContextsJson) as unknown,
        ).map((context) => ({
          ...context,
          contentSourceMode: "pdf" as const,
        }));
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const fullTextPaperContexts = (() => {
      if (
        typeof row.fullTextPaperContextsJson !== "string" ||
        !row.fullTextPaperContextsJson
      )
        return undefined;
      try {
        const parsed = JSON.parse(row.fullTextPaperContextsJson) as unknown;
        const normalized = normalizePaperContextRefs(parsed);
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const citationPaperContexts = (() => {
      if (
        typeof row.citationPaperContextsJson !== "string" ||
        !row.citationPaperContextsJson
      )
        return undefined;
      try {
        const parsed = JSON.parse(row.citationPaperContextsJson) as unknown;
        const normalized = normalizePaperContextRefs(parsed);
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const quoteCitations: QuoteCitation[] | undefined = (() => {
      if (typeof row.quoteCitationsJson !== "string" || !row.quoteCitationsJson)
        return undefined;
      try {
        const parsed = JSON.parse(row.quoteCitationsJson) as unknown;
        const normalized = normalizeQuoteCitations(parsed);
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const selectedCollectionContexts = (() => {
      if (
        typeof row.collectionContextsJson !== "string" ||
        !row.collectionContextsJson
      )
        return undefined;
      try {
        const normalized = normalizeCollectionContextRefs(
          JSON.parse(row.collectionContextsJson) as unknown,
        );
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const selectedTagContexts = (() => {
      if (typeof row.tagContextsJson !== "string" || !row.tagContextsJson)
        return undefined;
      try {
        const normalized = normalizeTagContextRefs(
          JSON.parse(row.tagContextsJson) as unknown,
        );
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const screenshotImages = (() => {
      if (typeof row.screenshotImages !== "string" || !row.screenshotImages)
        return undefined;
      try {
        const parsed = JSON.parse(row.screenshotImages) as unknown;
        const normalized = Array.isArray(parsed)
          ? parsed.filter(
              (entry): entry is string =>
                typeof entry === "string" && Boolean(entry.trim()),
            )
          : [];
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const attachments = (() => {
      if (typeof row.attachmentsJson !== "string" || !row.attachmentsJson)
        return undefined;
      try {
        const parsed = JSON.parse(row.attachmentsJson) as unknown;
        const normalized = Array.isArray(parsed)
          ? parsed.filter(
              (
                entry,
              ): entry is NonNullable<
                StoredChatMessage["attachments"]
              >[number] =>
                Boolean(entry) &&
                typeof entry === "object" &&
                typeof (entry as { id?: unknown }).id === "string" &&
                Boolean(String((entry as { id?: string }).id || "").trim()),
            )
          : [];
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const generatedImages: GeneratedChatImage[] | undefined = (() => {
      if (
        typeof row.generatedImagesJson !== "string" ||
        !row.generatedImagesJson
      )
        return undefined;
      try {
        const normalized = normalizeGeneratedChatImages(
          JSON.parse(row.generatedImagesJson) as unknown,
        );
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const forcedSkillIds = parseForcedSkillIdsJson(row.forcedSkillIdsJson);

    messages.push({
      id:
        Number.isFinite(Number(row.id)) && Number(row.id) > 0
          ? Math.floor(Number(row.id))
          : undefined,
      role,
      text: typeof row.text === "string" ? row.text : "",
      timestamp: Number.isFinite(Number(row.timestamp))
        ? Math.floor(Number(row.timestamp))
        : Date.now(),
      runMode:
        row.runMode === "agent"
          ? "agent"
          : row.runMode === "chat"
            ? "chat"
            : undefined,
      agentRunId:
        typeof row.agentRunId === "string" ? row.agentRunId : undefined,
      selectedText: selectedTextContexts[0]?.text,
      selectedTextContexts: selectedTextContexts.length
        ? selectedTextContexts
        : undefined,
      selectedTexts: selectedTextContexts.length
        ? selectedTextContexts.map((context) => context.text)
        : undefined,
      selectedTextSources: selectedTextContexts.length
        ? selectedTextContexts.map((context) => context.source)
        : undefined,
      selectedTextPaperContexts: selectedTextContexts.length
        ? selectedTextContexts.map((context) => context.paperContext)
        : undefined,
      selectedTextNoteContexts: selectedTextContexts.length
        ? selectedTextContexts.map((context) => context.noteContext)
        : undefined,
      forcedSkillIds:
        role === "user" && forcedSkillIds.length ? forcedSkillIds : undefined,
      paperContexts,
      pdfPaperContexts,
      fullTextPaperContexts,
      citationPaperContexts,
      quoteCitations,
      selectedCollectionContexts,
      selectedTagContexts,
      screenshotImages,
      attachments,
      generatedImages,
      modelName: typeof row.modelName === "string" ? row.modelName : undefined,
      modelEntryId:
        typeof row.modelEntryId === "string" ? row.modelEntryId : undefined,
      modelProviderLabel:
        typeof row.modelProviderLabel === "string"
          ? row.modelProviderLabel
          : undefined,
      interrupted: Number(row.interrupted) === 1 ? true : undefined,
      webchatRunState:
        row.webchatRunState === "done" ||
        row.webchatRunState === "incomplete" ||
        row.webchatRunState === "error"
          ? row.webchatRunState
          : undefined,
      webchatCompletionReason:
        row.webchatCompletionReason === "settled" ||
        row.webchatCompletionReason === "forced_cancel" ||
        row.webchatCompletionReason === "timeout" ||
        row.webchatCompletionReason === "error"
          ? row.webchatCompletionReason
          : null,
      reasoningSummary:
        typeof row.reasoningSummary === "string"
          ? row.reasoningSummary
          : undefined,
      reasoningDetails:
        typeof row.reasoningDetails === "string"
          ? row.reasoningDetails
          : undefined,
      compactMarker: Boolean(row.compactMarker),
      contextTokens:
        Number.isFinite(Number(row.contextTokens)) &&
        Number(row.contextTokens) > 0
          ? Math.floor(Number(row.contextTokens))
          : undefined,
      contextWindow:
        Number.isFinite(Number(row.contextWindow)) &&
        Number(row.contextWindow) > 0
          ? Math.floor(Number(row.contextWindow))
          : undefined,
    });
  }
  return messages;
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

type ClaudeConversationRow = {
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
  scopedConversationKey?: unknown;
  scopeType?: unknown;
  scopeId?: unknown;
  scopeLabel?: unknown;
  cwd?: unknown;
  modelName?: unknown;
  effort?: unknown;
  userTurnCount?: unknown;
};

function toClaudeConversationSummary(
  row: ClaudeConversationRow,
): ClaudeConversationSummary | null {
  const conversationKey = normalizeConversationKey(Number(row.conversationKey));
  const libraryID = normalizeLibraryID(Number(row.libraryID));
  const createdAt = normalizeCatalogTimestamp(row.createdAt);
  const updatedAt = normalizeCatalogTimestamp(row.updatedAt);
  const kind =
    row.kind === "paper" ? "paper" : row.kind === "global" ? "global" : null;
  if (
    !conversationKey ||
    !libraryID ||
    !kind ||
    !isClaudeStoreConversationKeyForKind(conversationKey, kind)
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
        : buildClaudeConversationID({
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
      typeof row.providerSessionId === "string" && row.providerSessionId.trim()
        ? row.providerSessionId.trim()
        : undefined,
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

function sameClaudeCatalogScope(
  existing: ClaudeConversationSummary,
  params: {
    libraryID: number;
    kind: ClaudeConversationKind;
    paperItemID?: number | null;
  },
): boolean {
  const requestedPaperItemID =
    params.kind === "paper"
      ? normalizePaperItemID(Number(params.paperItemID))
      : null;
  return (
    existing.libraryID === params.libraryID &&
    existing.kind === params.kind &&
    (existing.paperItemID || null) === (requestedPaperItemID || null)
  );
}

async function filterValidClaudeConversationSummaries(
  summaries: ClaudeConversationSummary[],
  expectedPaperItemID?: number | null,
): Promise<ClaudeConversationSummary[]> {
  const filtered: ClaudeConversationSummary[] = [];
  for (const summary of summaries) {
    const validSummary =
      await validateOrRepairClaudeConversationSummary(summary);
    if (!validSummary) continue;
    const normalizedExpectedPaperItemID = normalizePaperItemID(
      Number(expectedPaperItemID),
    );
    if (
      normalizedExpectedPaperItemID &&
      validSummary.kind === "paper" &&
      validSummary.paperItemID !== normalizedExpectedPaperItemID
    ) {
      continue;
    }
    filtered.push(validSummary);
  }
  return filtered;
}

async function validateOrRepairClaudeConversationSummary(
  summary: ClaudeConversationSummary,
): Promise<ClaudeConversationSummary | null> {
  const validation = await getConversationScopeValidationDetails({
    conversationID: summary.conversationID,
    conversationKey: summary.conversationKey,
    system: "claude_code",
    kind: summary.kind,
    libraryID: summary.libraryID,
    paperItemID: summary.paperItemID,
  });
  if (validation.valid) return summary;

  const registered =
    validation.registered ||
    (await getRegisteredConversationScope(summary.conversationKey));
  if (
    canMigrateLegacyAmbiguousPaperRegistryScope(registered, {
      system: "claude_code",
      kind: summary.kind,
      libraryID: summary.libraryID,
      paperItemID: summary.paperItemID,
    })
  ) {
    await repairRegisteredConversationScope({
      conversationID: summary.conversationID,
      conversationKey: summary.conversationKey,
      system: "claude_code",
      kind: "paper",
      libraryID: summary.libraryID,
      paperItemID: summary.paperItemID,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      title: summary.title,
    });
    logClaudeScopeWarning(
      `Migrated Claude conversation ${summary.conversationKey} from legacy ${AMBIGUOUS_PAPER_CONTEXT_INVALID_REASON} invalidation to primary paper ${summary.paperItemID}.`,
    );
    return summary;
  }
  if (registered) return null;

  if (summary.kind === "global") {
    const registeredMissingGlobal = await registerConversationScope({
      conversationID: summary.conversationID,
      conversationKey: summary.conversationKey,
      system: "claude_code",
      kind: summary.kind,
      libraryID: summary.libraryID,
      paperItemID: summary.paperItemID,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      title: summary.title,
    });
    return registeredMissingGlobal ? summary : null;
  }

  if (summary.paperItemID) {
    const registeredMissingPaper = await registerConversationScope({
      conversationID: summary.conversationID,
      conversationKey: summary.conversationKey,
      system: "claude_code",
      kind: "paper",
      libraryID: summary.libraryID,
      paperItemID: summary.paperItemID,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      title: summary.title,
    });
    return registeredMissingPaper ? summary : null;
  }

  const evidence = getPaperContextOwnershipEvidenceFromRows(
    await getClaudeMessagePaperContextRows(summary.conversationKey),
  );
  const inferredPaperItemID = evidence.singlePaperItemID;
  if (inferredPaperItemID) {
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
      [repairedConversationID, inferredPaperItemID, summary.conversationKey],
    );
    await Zotero.DB.queryAsync(
      `UPDATE ${CLAUDE_MESSAGES_TABLE}
       SET conversation_id = ?
       WHERE conversation_key = ?`,
      [repairedConversationID, summary.conversationKey],
    );
    setLastUsedClaudePaperConversationKey(
      summary.libraryID,
      inferredPaperItemID,
      summary.conversationKey,
    );
    await repairRegisteredConversationScope({
      conversationKey: summary.conversationKey,
      system: "claude_code",
      kind: "paper",
      libraryID: summary.libraryID,
      paperItemID: inferredPaperItemID,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      title: summary.title,
    });
    logClaudeScopeWarning(
      `Repaired Claude conversation ${summary.conversationKey} to paper ${inferredPaperItemID} while loading history.`,
    );
    return {
      ...summary,
      conversationID: repairedConversationID,
      paperItemID: inferredPaperItemID,
    };
  }

  return null;
}

export async function getClaudeConversationSummary(
  conversationKey: number,
): Promise<ClaudeConversationSummary | null> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isClaudeStoreConversationKey(normalizedKey))
    return null;
  const rows = (await Zotero.DB.queryAsync(
    `SELECT c.conversation_id AS conversationID,
            c.conversation_instance_id AS instanceID,
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
     WHERE c.conversation_key = ?
     LIMIT 1`,
    [normalizedKey],
  )) as ClaudeConversationRow[] | undefined;
  return rows?.length ? toClaudeConversationSummary(rows[0]) : null;
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
    logClaudeScopeWarning(
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
    logClaudeScopeWarning(String(error));
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

async function listClaudeConversations(params: {
  libraryID: number;
  kind: ClaudeConversationKind;
  paperItemID?: number;
  limit?: number | null;
}): Promise<ClaudeConversationSummary[]> {
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
    | ClaudeConversationRow[]
    | undefined;
  if (!rows?.length) return [];
  const summaries = rows
    .map((row) => toClaudeConversationSummary(row))
    .filter((row): row is ClaudeConversationSummary => Boolean(row));
  return filterValidClaudeConversationSummaries(
    summaries,
    params.kind === "paper"
      ? normalizePaperItemID(Number(params.paperItemID))
      : null,
  );
}

export async function listClaudeGlobalConversations(
  libraryID: number,
  limit: number | null = 50,
): Promise<ClaudeConversationSummary[]> {
  return listClaudeConversations({ libraryID, kind: "global", limit });
}

export async function listClaudePaperConversations(
  libraryID: number,
  paperItemID: number,
  limit = 50,
): Promise<ClaudeConversationSummary[]> {
  return listClaudeConversations({
    libraryID,
    kind: "paper",
    paperItemID,
    limit,
  });
}

export async function listAllClaudePaperConversationsByLibrary(
  libraryID: number,
  limit: number | null = 100,
): Promise<ClaudeConversationSummary[]> {
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
     WHERE c.library_id = ?
       AND c.kind = 'paper'
       AND COALESCE(c.user_turn_count, 0) > 0
     ORDER BY updatedAt DESC, c.conversation_key DESC
     ${normalizedLimit ? "LIMIT ?" : ""}`,
    queryParams,
  )) as ClaudeConversationRow[] | undefined;
  if (!rows?.length) return [];
  const summaries = rows
    .map((row) => toClaudeConversationSummary(row))
    .filter((row): row is ClaudeConversationSummary => Boolean(row));
  return filterValidClaudeConversationSummaries(summaries);
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

async function getMaxClaudeConversationKey(
  kind: ClaudeConversationKind,
): Promise<number> {
  const range = getClaudeAllocatedConversationKeyRange(kind);
  const rows = (await Zotero.DB.queryAsync(
    `SELECT MAX(conversation_key) AS maxConversationKey
     FROM ${CLAUDE_CONVERSATIONS_TABLE}
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
  conversationKey: number,
  titleSeed: string,
  expectedGeneration?: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isClaudeStoreConversationKey(normalizedKey)) return;
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
      `UPDATE ${CLAUDE_CONVERSATIONS_TABLE}
     SET title = ?
     WHERE conversation_key = ?
       AND (title IS NULL OR TRIM(title) = '')`,
      [title, normalizedKey],
    );
  });
  await refreshClaudeConversationSearchIndex(normalizedKey);
}

export async function clearClaudeConversationSessionMetadata(
  conversationKey: number,
  expectedProviderSessionId?: string,
  expectedInstanceID?: string,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isClaudeStoreConversationKey(normalizedKey)) return;
  const normalizedSessionId = String(expectedProviderSessionId || "").trim();
  const sessionPredicate = normalizedSessionId
    ? "AND provider_session_id = ?"
    : "";
  const instancePredicate = expectedInstanceID?.trim()
    ? "AND conversation_instance_id = ?"
    : "";
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
       ${sessionPredicate}
       ${instancePredicate}`,
    [
      Date.now(),
      normalizedKey,
      ...(normalizedSessionId ? [normalizedSessionId] : []),
      ...(expectedInstanceID?.trim() ? [expectedInstanceID.trim()] : []),
    ],
  );
  await refreshClaudeConversationSearchIndex(normalizedKey);
}

export async function setClaudeConversationTitle(
  conversationKey: number,
  titleSeed: string,
  identity?: {
    instanceID?: string;
    conversationID?: string;
    inTransaction?: boolean;
  },
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isClaudeStoreConversationKey(normalizedKey)) return;
  const identityClause = identity?.instanceID
    ? `AND conversation_instance_id = ?`
    : "";
  const identityParams = identity?.instanceID ? [identity.instanceID] : [];
  await Zotero.DB.queryAsync(
    `UPDATE ${CLAUDE_CONVERSATIONS_TABLE}
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
    await refreshClaudeConversationSearchIndex(normalizedKey);
  }
}

export async function deleteClaudeConversation(
  conversationKey: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isClaudeStoreConversationKey(normalizedKey)) return;
  await Zotero.DB.queryAsync(
    `DELETE FROM ${CLAUDE_CONVERSATIONS_TABLE}
     WHERE conversation_key = ?`,
    [normalizedKey],
  );
  await deleteClaudeConversationSearchIndex(normalizedKey);
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

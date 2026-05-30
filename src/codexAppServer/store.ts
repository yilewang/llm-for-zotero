declare const Zotero: any;

import type {
  CodexConversationSummary,
  CodexConversationKind,
  GeneratedChatImage,
  NoteContextRef,
  QuoteCitation,
  SelectedTextSource,
} from "../shared/types";
import { normalizeGeneratedChatImages } from "../shared/generatedImages";
import {
  normalizeSelectedTextNoteContexts,
  normalizeSelectedTextPaperContexts,
  normalizeSelectedTextSource,
  normalizePaperContextRefs,
} from "../modules/contextPanel/normalizers";
import { normalizeQuoteCitations } from "../modules/contextPanel/quoteCitations";
import type { StoredChatMessage } from "../utils/chatStore";
import {
  CODEX_GLOBAL_CONVERSATION_KEY_BASE,
  RUNTIME_CONVERSATION_KEY_END,
  isConversationKeyFor,
  isConversationKeyForKind,
} from "../shared/conversationKeySpace";
import {
  buildLatestStoredMessagesQuery,
  storedMessageDisplayOrderSql,
} from "../shared/conversationMessageSql";
import { cleanupRememberedConversationKeyPrefs } from "../shared/conversationKeyPrefCleanup";
import {
  CODEX_HISTORY_LIMIT,
  buildDefaultCodexGlobalConversationKey,
  buildDefaultCodexPaperConversationKey,
  getCodexAllocatedConversationKeyRange,
  getCodexGlobalConversationKeyRange,
  getCodexPaperConversationKeyRange,
} from "./constants";
import {
  getLastAllocatedCodexGlobalConversationKey,
  getLastAllocatedCodexPaperConversationKey,
  isConversationKeyInRange,
  removeLastUsedCodexPaperConversationKey,
  setLastAllocatedCodexGlobalConversationKey,
  setLastAllocatedCodexPaperConversationKey,
  setLastUsedCodexConversationMode,
  setLastUsedCodexGlobalConversationKey,
  setLastUsedCodexPaperConversationKey,
} from "./prefs";
import {
  buildConversationID,
  getRegisteredConversationScope,
  inferSinglePaperItemIdFromContextRows,
  initConversationRegistryStore,
  invalidateRegisteredConversationScope,
  registerConversationScope,
  repairRegisteredConversationScope,
  validateConversationScope,
  type ConversationRegistryRow,
  type PaperContextJsonColumns,
} from "../shared/conversationRegistry";
import {
  repairRecoverableCatalogMessageConversationIDs,
  repairRecoverableMessageConversationIDs,
} from "../shared/conversationMessageIdentityRepair";
import {
  deleteConversationSearchIndexRow,
  refreshConversationSearchIndexForConversation,
} from "../shared/conversationSearchIndex";
import {
  CONVERSATION_ID_TRANSITION_MIGRATION_ID,
  hasConversationSchemaMigration,
} from "../shared/conversationSchemaMigrations";

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
const CLAUDE_MESSAGES_TABLE = "llm_for_zotero_claude_messages";
const CLAUDE_CONVERSATIONS_TABLE = "llm_for_zotero_claude_conversations";
const CODEX_MESSAGE_SELECT_COLUMNS_SQL = `id,
            role,
            text,
            timestamp,
            run_mode AS runMode,
            agent_run_id AS agentRunId,
            selected_text AS selectedText,
            selected_texts_json AS selectedTextsJson,
            selected_text_sources_json AS selectedTextSourcesJson,
            selected_text_paper_contexts_json AS selectedTextPaperContextsJson,
            selected_text_note_contexts_json AS selectedTextNoteContextsJson,
            paper_contexts_json AS paperContextsJson,
            full_text_paper_contexts_json AS fullTextPaperContextsJson,
            citation_paper_contexts_json AS citationPaperContextsJson,
            quote_citations_json AS quoteCitationsJson,
            screenshot_images AS screenshotImages,
            attachments_json AS attachmentsJson,
            generated_images_json AS generatedImagesJson,
            model_name AS modelName,
            model_entry_id AS modelEntryId,
            model_provider_label AS modelProviderLabel,
            webchat_run_state AS webchatRunState,
            webchat_completion_reason AS webchatCompletionReason,
            reasoning_summary AS reasoningSummary,
            reasoning_details AS reasoningDetails,
            compact_marker AS compactMarker,
            context_tokens AS contextTokens,
            context_window AS contextWindow`;
const CODEX_CONVERSATION_ACTIVITY_TIMESTAMP_SQL_FOR_ALIAS_C = `MAX(
  COALESCE(c.last_activity_at, 0),
  COALESCE(c.updated_at, 0),
  COALESCE(c.created_at, 0)
)`;

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

function isCodexStoreConversationKey(conversationKey: number): boolean {
  return isConversationKeyFor("codex", conversationKey);
}

function isCodexStoreConversationKeyForKind(
  conversationKey: number,
  kind: CodexConversationKind,
): boolean {
  return isConversationKeyForKind("codex", kind, conversationKey);
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

function buildCodexConversationID(params: {
  conversationKey: number;
  kind: CodexConversationKind;
  libraryID: number;
  paperItemID?: number | null;
}): string {
  return buildConversationID({
    conversationKey: params.conversationKey,
    system: "codex",
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
    : { whereSql: "conversation_key = ?", params: [conversationKey], registered };
}

function messageJoinCondition(
  messageAlias: string,
  conversationAlias: string,
): string {
  return `(${messageAlias}.conversation_id = ${conversationAlias}.conversation_id OR ((` +
    `${messageAlias}.conversation_id IS NULL OR TRIM(${messageAlias}.conversation_id) = '') AND ` +
    `${messageAlias}.conversation_key = ${conversationAlias}.conversation_key))`;
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
    tableName: CODEX_MESSAGES_TABLE,
    registered: selector.registered,
    getPaperContextRows: getCodexMessagePaperContextRows,
    storeLabel: "Codex",
    log: logCodexScopeWarning,
  });
  if (repair.status === "refused") {
    if (options.destructive) {
      throw new Error(
        `Refused destructive Codex conversation operation for ${conversationKey}: ${repair.reason || "ambiguous stale message ids found"}.`,
      );
    }
    selector = canonicalMessageConversationSelector(selector.registered);
  }
  return selector;
}

async function touchCodexConversationActivity(
  conversationKey: number,
  timestamp?: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return;
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
  if (isConversationKeyInRange(normalizedLegacyKey, kind)) return normalizedLegacyKey;
  if (kind === "paper") {
    const normalizedPaperItemID = normalizePaperItemID(paperItemID || 0);
    if (!normalizedPaperItemID) return null;
    return buildDefaultCodexPaperConversationKey(normalizedPaperItemID);
  }
  return buildDefaultCodexGlobalConversationKey(normalizedLibraryID);
}

async function migrateLegacyCodexConversationKeys(): Promise<void> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT conversation_key AS conversationKey,
            library_id AS libraryID,
            kind AS kind,
            paper_item_id AS paperItemID,
            updated_at AS updatedAt
     FROM ${CODEX_CONVERSATIONS_TABLE}
     ORDER BY updated_at DESC, conversation_key DESC`,
  )) as Array<{
    conversationKey?: unknown;
    libraryID?: unknown;
    kind?: unknown;
    paperItemID?: unknown;
    updatedAt?: unknown;
  }> | undefined;
  if (!rows?.length) return;

  const claimedKeys = new Set<number>(
    rows
      .map((row) => {
        const kind = row.kind === "paper" ? "paper" : row.kind === "global" ? "global" : null;
        const conversationKey = normalizeConversationKey(Number(row.conversationKey));
        return kind && conversationKey && isConversationKeyInRange(conversationKey, kind)
          ? conversationKey
          : null;
      })
      .filter((value): value is number => Number.isFinite(value)),
  );
  const latestModeByLibrary = new Set<number>();
  const latestGlobalByLibrary = new Set<number>();
  const latestPaperByState = new Set<string>();
  for (const row of rows) {
    const kind = row.kind === "paper" ? "paper" : row.kind === "global" ? "global" : null;
    const legacyConversationKey = normalizeConversationKey(Number(row.conversationKey));
    const libraryID = normalizeLibraryID(Number(row.libraryID));
    const paperItemID = normalizePaperItemID(Number(row.paperItemID));
    if (!kind || !legacyConversationKey || !libraryID) continue;

    let targetConversationKey = remapLegacyConversationKey(
      legacyConversationKey,
      kind,
      libraryID,
      paperItemID || undefined,
    );
    if (!targetConversationKey) continue;
    if (claimedKeys.has(targetConversationKey) && targetConversationKey !== legacyConversationKey) {
      targetConversationKey = null;
    }
    if (!targetConversationKey) {
      targetConversationKey = Math.max(
        ((kind === "paper"
          ? getLastAllocatedCodexPaperConversationKey()
          : getLastAllocatedCodexGlobalConversationKey()) || 0) + 1,
        (await getMaxCodexConversationKey(kind)) + 1,
      );
    }

    claimedKeys.add(targetConversationKey);
    if (targetConversationKey !== legacyConversationKey) {
      await Zotero.DB.queryAsync(
        `UPDATE ${CODEX_CONVERSATIONS_TABLE}
         SET conversation_key = ?,
             provider_session_id = NULL,
             scoped_conversation_key = NULL,
             scope_type = NULL,
             scope_id = NULL,
             scope_label = NULL,
             cwd = NULL
         WHERE conversation_key = ?`,
        [targetConversationKey, legacyConversationKey],
      );
      await Zotero.DB.queryAsync(
        `UPDATE ${CODEX_MESSAGES_TABLE}
         SET conversation_key = ?
         WHERE conversation_key = ?`,
        [targetConversationKey, legacyConversationKey],
      );
    }

    if (!latestModeByLibrary.has(libraryID)) {
      setLastUsedCodexConversationMode(libraryID, kind === "paper" ? "paper" : "global");
      latestModeByLibrary.add(libraryID);
    }
    if (kind === "paper" && paperItemID) {
      const paperStateKey = `${libraryID}:${paperItemID}`;
      if (!latestPaperByState.has(paperStateKey)) {
        setLastUsedCodexPaperConversationKey(libraryID, paperItemID, targetConversationKey);
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
  "selected_text",
  "selected_texts_json",
  "selected_text_sources_json",
  "selected_text_paper_contexts_json",
  "selected_text_note_contexts_json",
  "paper_contexts_json",
  "full_text_paper_contexts_json",
  "citation_paper_contexts_json",
  "quote_citations_json",
  "screenshot_images",
  "attachments_json",
  "generated_images_json",
  "model_name",
  "model_entry_id",
  "model_provider_label",
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

function logCodexRepairWarning(message: string): void {
  const debug = (globalThis as typeof globalThis & {
    Zotero?: { debug?: (message: string) => void };
  }).Zotero?.debug;
  debug?.(`LLM: ${message}`);
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

async function ensureCodexConversationCatalogColumns(
  columns: Array<{ name?: unknown }> | undefined,
): Promise<void> {
  const requiredColumns: Array<[string, string]> = [
    ["conversation_id", "conversation_id TEXT"],
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
      CODEX_CONVERSATIONS_TABLE,
      columns,
      columnName,
      definition,
    );
  }
}

async function backfillCodexConversationTimestamps(): Promise<void> {
  const now = Date.now();
  await Zotero.DB.queryAsync(
    `UPDATE ${CODEX_CONVERSATIONS_TABLE}
     SET created_at = COALESCE(
       created_at,
       (SELECT MIN(m.timestamp)
        FROM ${CODEX_MESSAGES_TABLE} m
        WHERE m.conversation_key = ${CODEX_CONVERSATIONS_TABLE}.conversation_key),
       ?
     )
     WHERE created_at IS NULL`,
    [now],
  );
  await Zotero.DB.queryAsync(
    `UPDATE ${CODEX_CONVERSATIONS_TABLE}
     SET updated_at = COALESCE(
       updated_at,
       (SELECT MAX(m.timestamp)
        FROM ${CODEX_MESSAGES_TABLE} m
        WHERE m.conversation_key = ${CODEX_CONVERSATIONS_TABLE}.conversation_key),
       created_at,
       ?
     )
     WHERE updated_at IS NULL`,
    [now],
  );
}

async function refreshCodexConversationCatalogSummary(
  conversationKey?: number,
): Promise<void> {
  const normalizedKey =
    conversationKey === undefined
      ? null
      : normalizeConversationKey(conversationKey);
  if (conversationKey !== undefined && !normalizedKey) return;
  await repairRecoverableCodexCatalogMessageConversationIDs(
    normalizedKey || undefined,
  );
  const whereSql = normalizedKey ? "WHERE conversation_key = ?" : "";
  const params = normalizedKey ? [normalizedKey] : [];
  await Zotero.DB.queryAsync(
    `UPDATE ${CODEX_CONVERSATIONS_TABLE}
     SET first_user_title = (
           SELECT m0.text
           FROM ${CODEX_MESSAGES_TABLE} m0
           WHERE ${messageJoinCondition("m0", CODEX_CONVERSATIONS_TABLE)}
             AND m0.role = 'user'
           ORDER BY m0.timestamp ASC, m0.id ASC
           LIMIT 1
         ),
         last_activity_at = COALESCE(
           (
             SELECT MAX(m.timestamp)
             FROM ${CODEX_MESSAGES_TABLE} m
             WHERE ${messageJoinCondition("m", CODEX_CONVERSATIONS_TABLE)}
           ),
           updated_at,
           created_at
         ),
         user_turn_count = COALESCE(
           (
             SELECT SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END)
             FROM ${CODEX_MESSAGES_TABLE} m
             WHERE ${messageJoinCondition("m", CODEX_CONVERSATIONS_TABLE)}
           ),
           0
         )
     ${whereSql}`,
    params,
  );
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
        conversationKey !== null && isCodexStoreConversationKey(conversationKey),
    );
}

async function moveConversationRowsIfSafe(conversationKey: number): Promise<void> {
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
    logCodexRepairWarning(
      `Skipped moving Claude conversation row ${conversationKey} to Codex because Codex already has that key.`,
    );
    return;
  }
  const columns = transferColumnSql(CONVERSATION_TRANSFER_COLUMNS);
  await Zotero.DB.queryAsync(
    `INSERT INTO ${CODEX_CONVERSATIONS_TABLE} (${columns})
     SELECT ${columns}
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
    logCodexRepairWarning(
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

  const conversationKeys = await findMisroutedCodexConversationKeys();
  for (const conversationKey of conversationKeys) {
    await moveConversationRowsIfSafe(conversationKey);
    await moveMessageRowsIfSafe(conversationKey);
  }
}

async function getCodexMessagePaperContextRows(
  conversationKey: number,
): Promise<PaperContextJsonColumns[]> {
  return ((await Zotero.DB.queryAsync(
    `SELECT paper_contexts_json AS paperContextsJson,
            full_text_paper_contexts_json AS fullTextPaperContextsJson,
            selected_text_paper_contexts_json AS selectedTextPaperContextsJson,
            citation_paper_contexts_json AS citationPaperContextsJson
     FROM ${CODEX_MESSAGES_TABLE}
     WHERE conversation_key = ?
       AND (
         paper_contexts_json IS NOT NULL OR
         full_text_paper_contexts_json IS NOT NULL OR
         selected_text_paper_contexts_json IS NOT NULL OR
         citation_paper_contexts_json IS NOT NULL
       )`,
    [conversationKey],
  )) || []) as PaperContextJsonColumns[];
}

async function repairRecoverableCodexCatalogMessageConversationIDs(
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
    catalogTable: CODEX_CONVERSATIONS_TABLE,
    messageTable: CODEX_MESSAGES_TABLE,
    system: "codex",
    kindSql: "c.kind",
    paperItemIDSql: "c.paper_item_id",
    getPaperContextRows: getCodexMessagePaperContextRows,
    storeLabel: "Codex",
    log: logCodexScopeWarning,
    ...(normalizedKey
      ? { filterSql: "c.conversation_key = ?", filterParams: [normalizedKey] }
      : {}),
  });
}

async function backfillCodexConversationIDs(): Promise<void> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT conversation_key AS conversationKey,
            library_id AS libraryID,
            kind AS kind,
            paper_item_id AS paperItemID
     FROM ${CODEX_CONVERSATIONS_TABLE}`,
  )) as Array<{
    conversationKey?: unknown;
    libraryID?: unknown;
    kind?: unknown;
    paperItemID?: unknown;
  }> | undefined;
  for (const row of rows || []) {
    const conversationKey = normalizeConversationKey(Number(row.conversationKey));
    const libraryID = normalizeLibraryID(Number(row.libraryID));
    const kind =
      row.kind === "paper" ? "paper" : row.kind === "global" ? "global" : null;
    if (!conversationKey || !libraryID || !kind) continue;
    const paperItemID = normalizePaperItemID(Number(row.paperItemID));
    const conversationID = buildCodexConversationID({
      conversationKey,
      kind,
      libraryID,
      paperItemID,
    });
    await Zotero.DB.queryAsync(
      `UPDATE ${CODEX_CONVERSATIONS_TABLE}
       SET conversation_id = ?
       WHERE conversation_key = ?
         AND (conversation_id IS NULL OR TRIM(conversation_id) = '')`,
      [conversationID, conversationKey],
    );
    await Zotero.DB.queryAsync(
      `UPDATE ${CODEX_MESSAGES_TABLE}
       SET conversation_id = ?
       WHERE conversation_key = ?
         AND (conversation_id IS NULL OR TRIM(conversation_id) = '')`,
      [conversationID, conversationKey],
    );
  }
}

export async function repairCodexConversationIdentityRegistry(): Promise<void> {
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
      const contextRows = await getCodexMessagePaperContextRows(
        summary.conversationKey,
      );
      const inferredPaperItemID =
        inferSinglePaperItemIdFromContextRows(contextRows);
      if (inferredPaperItemID === "ambiguous") {
        await repairRegisteredConversationScope({
          conversationID: summary.conversationID,
          conversationKey: summary.conversationKey,
          system: "codex",
          kind: "paper",
          libraryID: summary.libraryID,
          paperItemID: summary.paperItemID,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          title: summary.title,
        });
        await invalidateRegisteredConversationScope(
          summary.conversationKey,
          "ambiguous paper context evidence",
        );
        continue;
      }
      if (
        inferredPaperItemID &&
        summary.paperItemID &&
        inferredPaperItemID !== summary.paperItemID
      ) {
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
          [repairedConversationID, inferredPaperItemID, summary.conversationKey],
        );
        await Zotero.DB.queryAsync(
          `UPDATE ${CODEX_MESSAGES_TABLE}
           SET conversation_id = ?
           WHERE conversation_key = ?`,
          [repairedConversationID, summary.conversationKey],
        );
        removeLastUsedCodexPaperConversationKey(
          summary.libraryID,
          summary.paperItemID,
        );
        setLastUsedCodexPaperConversationKey(
          summary.libraryID,
          inferredPaperItemID,
          summary.conversationKey,
        );
        await repairRegisteredConversationScope({
          conversationKey: summary.conversationKey,
          system: "codex",
          kind: "paper",
          libraryID: summary.libraryID,
          paperItemID: inferredPaperItemID,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          title: summary.title,
        });
        logCodexScopeWarning(
          `Repaired Codex conversation ${summary.conversationKey} from paper ${summary.paperItemID} to paper ${inferredPaperItemID} based on stored paper contexts.`,
        );
        continue;
      }
    }
    await registerConversationScope({
      conversationID: summary.conversationID,
      conversationKey: summary.conversationKey,
      system: "codex",
      kind: summary.kind,
      libraryID: summary.libraryID,
      paperItemID: summary.paperItemID,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      title: summary.title,
    });
  }
}

export async function initCodexAppServerStore(): Promise<void> {
  const conversationIDTransitionAlreadyApplied =
    await hasConversationSchemaMigration(CONVERSATION_ID_TRANSITION_MIGRATION_ID);
  await Zotero.DB.executeTransaction(async () => {
    await initConversationRegistryStore();
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${CODEX_MESSAGES_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT,
        conversation_key INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        run_mode TEXT CHECK(run_mode IN ('chat', 'agent')),
        agent_run_id TEXT,
        selected_text TEXT,
        selected_texts_json TEXT,
        selected_text_sources_json TEXT,
        selected_text_paper_contexts_json TEXT,
        selected_text_note_contexts_json TEXT,
        paper_contexts_json TEXT,
        full_text_paper_contexts_json TEXT,
        citation_paper_contexts_json TEXT,
        quote_citations_json TEXT,
        screenshot_images TEXT,
        attachments_json TEXT,
        generated_images_json TEXT,
        model_name TEXT,
        model_entry_id TEXT,
        model_provider_label TEXT,
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
      columns?.some((column) => column?.name === "citation_paper_contexts_json"),
    );
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
      "generated_images_json",
      "generated_images_json TEXT",
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
      `PRAGMA table_info(${CODEX_CONVERSATIONS_TABLE})`,
    )) as Array<{ name?: unknown }> | undefined;
    await ensureCodexConversationCatalogColumns(conversationColumns);
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
      await repairMisroutedCodexConversationRows();
      await migrateLegacyCodexConversationKeys();
      await backfillCodexConversationIDs();
      await repairCodexConversationIdentityRegistry();
      await refreshCodexConversationCatalogSummary();
    }
  });
  cleanupRememberedConversationKeyPrefs();
}

export const initCodexCodeStore = initCodexAppServerStore;

function serializeSelectedTextSources(
  selectedTextSources: SelectedTextSource[] | undefined,
  count: number,
): string | null {
  if (!Array.isArray(selectedTextSources) || count <= 0) return null;
  const normalized = Array.from({ length: count }, (_, index) =>
    normalizeSelectedTextSource(selectedTextSources[index]),
  );
  return normalized.length ? JSON.stringify(normalized) : null;
}

export async function appendCodexMessage(
  conversationKey: number,
  message: StoredChatMessage,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return;

  const selectedTexts = Array.isArray(message.selectedTexts)
    ? message.selectedTexts
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : typeof message.selectedText === "string" && message.selectedText.trim()
      ? [message.selectedText.trim()]
      : [];
  const selectedTextSources = serializeSelectedTextSources(
    message.selectedTextSources,
    selectedTexts.length,
  );
  const selectedTextPaperContexts = normalizeSelectedTextPaperContexts(
    message.selectedTextPaperContexts,
    selectedTexts.length,
  );
  const selectedTextNoteContexts = normalizeSelectedTextNoteContexts(
    (message as StoredChatMessage & { selectedTextNoteContexts?: (NoteContextRef | undefined)[] })
      .selectedTextNoteContexts,
    selectedTexts.length,
  );
  const paperContexts = normalizePaperContextRefs(message.paperContexts);
  const fullTextPaperContexts = normalizePaperContextRefs(
    message.fullTextPaperContexts,
  );
  const citationPaperContexts = normalizePaperContextRefs(
    message.citationPaperContexts,
  );
  const quoteCitations = normalizeQuoteCitations(message.quoteCitations);
  const screenshotImages = Array.isArray(message.screenshotImages)
    ? message.screenshotImages.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    : [];
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.filter(
        (entry) => entry && typeof entry.id === "string" && entry.id.trim(),
      )
    : [];
  const generatedImages = normalizeGeneratedChatImages(message.generatedImages);
  const messageTimestamp = Number.isFinite(message.timestamp)
    ? Math.floor(message.timestamp)
    : Date.now();
  const conversationID = await resolveRegisteredConversationID(normalizedKey);

  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `INSERT INTO ${CODEX_MESSAGES_TABLE}
        (conversation_id, conversation_key, role, text, timestamp, run_mode, agent_run_id, selected_text, selected_texts_json, selected_text_sources_json, selected_text_paper_contexts_json, selected_text_note_contexts_json, paper_contexts_json, full_text_paper_contexts_json, citation_paper_contexts_json, quote_citations_json, screenshot_images, attachments_json, generated_images_json, model_name, model_entry_id, model_provider_label, webchat_run_state, webchat_completion_reason, reasoning_summary, reasoning_details, compact_marker, context_tokens, context_window)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        conversationID,
        normalizedKey,
        message.role,
        message.text || "",
        messageTimestamp,
        message.runMode || null,
        message.agentRunId || null,
        selectedTexts[0] || message.selectedText || null,
        selectedTexts.length ? JSON.stringify(selectedTexts) : null,
        selectedTextSources,
        selectedTextPaperContexts.some((entry) => Boolean(entry))
          ? JSON.stringify(selectedTextPaperContexts)
          : null,
        selectedTextNoteContexts.some((entry) => Boolean(entry))
          ? JSON.stringify(selectedTextNoteContexts)
          : null,
        paperContexts.length ? JSON.stringify(paperContexts) : null,
        fullTextPaperContexts.length ? JSON.stringify(fullTextPaperContexts) : null,
        citationPaperContexts.length ? JSON.stringify(citationPaperContexts) : null,
        quoteCitations.length ? JSON.stringify(quoteCitations) : null,
        screenshotImages.length ? JSON.stringify(screenshotImages) : null,
        attachments.length ? JSON.stringify(attachments) : null,
        generatedImages.length ? JSON.stringify(generatedImages) : null,
        message.modelName || null,
        message.modelEntryId || null,
        message.modelProviderLabel || null,
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
      ],
    );
    await touchCodexConversationActivity(normalizedKey, messageTimestamp);
    await refreshCodexConversationCatalogSummary(normalizedKey);
  });
  await refreshCodexConversationSearchIndex(normalizedKey);
}

export async function loadCodexConversation(
  conversationKey: number,
  limit = CODEX_HISTORY_LIMIT,
): Promise<StoredChatMessage[]> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return [];
  const selector = await resolveRepairingMessageConversationSelector(normalizedKey);
  const normalizedLimit = normalizeLimit(limit, CODEX_HISTORY_LIMIT);
  let rows = (await Zotero.DB.queryAsync(
    buildLatestStoredMessagesQuery({
      tableName: CODEX_MESSAGES_TABLE,
      selectColumnsSql: CODEX_MESSAGE_SELECT_COLUMNS_SQL,
      whereSql: selector.whereSql,
    }),
    [...selector.params, normalizedLimit],
  )) as Array<Record<string, unknown>> | undefined;

  if (!rows?.length) return [];

  const messages: StoredChatMessage[] = [];
  for (const row of rows) {
    const role = row.role === "assistant" ? "assistant" : row.role === "user" ? "user" : null;
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
          ? parsed.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
          : [];
      } catch {
        return [];
      }
    })();
    const selectedTextSources = (() => {
      if (typeof row.selectedTextSourcesJson !== "string" || !row.selectedTextSourcesJson) {
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
      if (typeof row.selectedTextPaperContextsJson !== "string" || !row.selectedTextPaperContextsJson) {
        return undefined;
      }
      try {
        const parsed = JSON.parse(row.selectedTextPaperContextsJson) as unknown;
        const normalized = normalizeSelectedTextPaperContexts(parsed, selectedTexts.length);
        return normalized.some((entry) => Boolean(entry)) ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const selectedTextNoteContexts = (() => {
      if (typeof row.selectedTextNoteContextsJson !== "string" || !row.selectedTextNoteContextsJson) {
        return undefined;
      }
      try {
        const parsed = JSON.parse(row.selectedTextNoteContextsJson) as unknown;
        const normalized = normalizeSelectedTextNoteContexts(parsed, selectedTexts.length);
        return normalized.some((entry) => Boolean(entry)) ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const paperContexts = (() => {
      if (typeof row.paperContextsJson !== "string" || !row.paperContextsJson) return undefined;
      try {
        const parsed = JSON.parse(row.paperContextsJson) as unknown;
        const normalized = normalizePaperContextRefs(parsed);
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const fullTextPaperContexts = (() => {
      if (typeof row.fullTextPaperContextsJson !== "string" || !row.fullTextPaperContextsJson) return undefined;
      try {
        const parsed = JSON.parse(row.fullTextPaperContextsJson) as unknown;
        const normalized = normalizePaperContextRefs(parsed);
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const citationPaperContexts = (() => {
      if (typeof row.citationPaperContextsJson !== "string" || !row.citationPaperContextsJson) return undefined;
      try {
        const parsed = JSON.parse(row.citationPaperContextsJson) as unknown;
        const normalized = normalizePaperContextRefs(parsed);
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const quoteCitations: QuoteCitation[] | undefined = (() => {
      if (typeof row.quoteCitationsJson !== "string" || !row.quoteCitationsJson) return undefined;
      try {
        const parsed = JSON.parse(row.quoteCitationsJson) as unknown;
        const normalized = normalizeQuoteCitations(parsed);
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const screenshotImages = (() => {
      if (typeof row.screenshotImages !== "string" || !row.screenshotImages) return undefined;
      try {
        const parsed = JSON.parse(row.screenshotImages) as unknown;
        const normalized = Array.isArray(parsed)
          ? parsed.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
          : [];
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();
    const attachments = (() => {
      if (typeof row.attachmentsJson !== "string" || !row.attachmentsJson) return undefined;
      try {
        const parsed = JSON.parse(row.attachmentsJson) as unknown;
        const normalized = Array.isArray(parsed)
          ? parsed.filter(
              (entry): entry is NonNullable<StoredChatMessage["attachments"]>[number] =>
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
      if (typeof row.generatedImagesJson !== "string" || !row.generatedImagesJson) return undefined;
      try {
        const normalized = normalizeGeneratedChatImages(
          JSON.parse(row.generatedImagesJson) as unknown,
        );
        return normalized.length ? normalized : undefined;
      } catch {
        return undefined;
      }
    })();

    messages.push({
      role,
      text: typeof row.text === "string" ? row.text : "",
      timestamp: Number.isFinite(Number(row.timestamp)) ? Math.floor(Number(row.timestamp)) : Date.now(),
      runMode: row.runMode === "agent" ? "agent" : row.runMode === "chat" ? "chat" : undefined,
      agentRunId: typeof row.agentRunId === "string" ? row.agentRunId : undefined,
      selectedText: selectedTexts[0],
      selectedTexts: selectedTexts.length ? selectedTexts : undefined,
      selectedTextSources,
      selectedTextPaperContexts,
      selectedTextNoteContexts,
      paperContexts,
      fullTextPaperContexts,
      citationPaperContexts,
      quoteCitations,
      screenshotImages,
      attachments,
      generatedImages,
      modelName: typeof row.modelName === "string" ? row.modelName : undefined,
      modelEntryId: typeof row.modelEntryId === "string" ? row.modelEntryId : undefined,
      modelProviderLabel:
        typeof row.modelProviderLabel === "string"
          ? row.modelProviderLabel
          : undefined,
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
        typeof row.reasoningSummary === "string" ? row.reasoningSummary : undefined,
      reasoningDetails:
        typeof row.reasoningDetails === "string" ? row.reasoningDetails : undefined,
      compactMarker: Boolean(row.compactMarker),
      contextTokens:
        Number.isFinite(Number(row.contextTokens)) && Number(row.contextTokens) > 0
          ? Math.floor(Number(row.contextTokens))
          : undefined,
      contextWindow:
        Number.isFinite(Number(row.contextWindow)) && Number(row.contextWindow) > 0
          ? Math.floor(Number(row.contextWindow))
          : undefined,
    });
  }
  return messages;
}

export async function clearCodexConversation(conversationKey: number): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return;
  const selector = await resolveRepairingMessageConversationSelector(normalizedKey, {
    destructive: true,
  });
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CODEX_MESSAGES_TABLE} WHERE ${selector.whereSql}`,
      selector.params,
    );
    await refreshCodexConversationCatalogSummary(normalizedKey);
  });
  await refreshCodexConversationSearchIndex(normalizedKey);
}

export async function deleteCodexTurnMessages(
  conversationKey: number,
  userTimestamp: number,
  assistantTimestamp: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return;
  const normalizedUserTimestamp = Number.isFinite(userTimestamp)
    ? Math.floor(userTimestamp)
    : 0;
  const normalizedAssistantTimestamp = Number.isFinite(assistantTimestamp)
    ? Math.floor(assistantTimestamp)
    : 0;
  if (normalizedUserTimestamp <= 0 || normalizedAssistantTimestamp <= 0) return;

  const selector = await resolveRepairingMessageConversationSelector(normalizedKey, {
    destructive: true,
  });
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CODEX_MESSAGES_TABLE}
       WHERE id = (
         SELECT id
         FROM ${CODEX_MESSAGES_TABLE}
         WHERE ${selector.whereSql}
           AND role = 'user'
           AND timestamp = ?
         ORDER BY id DESC
         LIMIT 1
       )`,
      [...selector.params, normalizedUserTimestamp],
    );
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CODEX_MESSAGES_TABLE}
       WHERE id = (
         SELECT id
         FROM ${CODEX_MESSAGES_TABLE}
         WHERE ${selector.whereSql}
           AND role = 'assistant'
           AND timestamp = ?
         ORDER BY id DESC
         LIMIT 1
       )`,
      [...selector.params, normalizedAssistantTimestamp],
    );
    await refreshCodexConversationCatalogSummary(normalizedKey);
  });
  await refreshCodexConversationSearchIndex(normalizedKey);
}

export async function pruneCodexConversation(
  conversationKey: number,
  keep = CODEX_HISTORY_LIMIT,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return;
  const selector = await resolveRepairingMessageConversationSelector(normalizedKey, {
    destructive: true,
  });
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CODEX_MESSAGES_TABLE}
       WHERE id IN (
         SELECT id
         FROM ${CODEX_MESSAGES_TABLE}
         WHERE ${selector.whereSql}
         ORDER BY ${storedMessageDisplayOrderSql({ direction: "desc" })}
         LIMIT -1 OFFSET ?
      )`,
      [...selector.params, normalizeLimit(keep, CODEX_HISTORY_LIMIT)],
    );
    await refreshCodexConversationCatalogSummary(normalizedKey);
  });
  await refreshCodexConversationSearchIndex(normalizedKey);
}

export async function updateLatestCodexUserMessage(
  conversationKey: number,
  message: Pick<
    StoredChatMessage,
    | "text"
    | "timestamp"
    | "runMode"
    | "agentRunId"
    | "selectedText"
    | "selectedTexts"
    | "selectedTextSources"
    | "selectedTextPaperContexts"
    | "selectedTextNoteContexts"
    | "paperContexts"
    | "fullTextPaperContexts"
    | "citationPaperContexts"
    | "screenshotImages"
    | "attachments"
  >,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return;
  const selectedTexts = Array.isArray(message.selectedTexts)
    ? message.selectedTexts
    : typeof message.selectedText === "string" && message.selectedText.trim()
      ? [message.selectedText.trim()]
      : [];
  const selectedTextPaperContexts = normalizeSelectedTextPaperContexts(
    message.selectedTextPaperContexts,
    selectedTexts.length,
  );
  const selectedTextNoteContexts = normalizeSelectedTextNoteContexts(
    message.selectedTextNoteContexts,
    selectedTexts.length,
  );
  const messageTimestamp = Number.isFinite(message.timestamp)
    ? Math.floor(message.timestamp)
    : Date.now();
  const selector = await resolveRepairingMessageConversationSelector(normalizedKey);
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `UPDATE ${CODEX_MESSAGES_TABLE}
       SET text = ?,
           timestamp = ?,
           run_mode = ?,
           agent_run_id = ?,
           selected_text = ?,
           selected_texts_json = ?,
           selected_text_sources_json = ?,
           selected_text_paper_contexts_json = ?,
           selected_text_note_contexts_json = ?,
           paper_contexts_json = ?,
           full_text_paper_contexts_json = ?,
           citation_paper_contexts_json = ?,
           screenshot_images = ?,
           attachments_json = ?
       WHERE id = (
         SELECT id
         FROM ${CODEX_MESSAGES_TABLE}
         WHERE ${selector.whereSql} AND role = 'user'
         ORDER BY timestamp DESC, id DESC
         LIMIT 1
       )`,
      [
        message.text || "",
        messageTimestamp,
        message.runMode || null,
        message.agentRunId || null,
        selectedTexts[0] || null,
        selectedTexts.length ? JSON.stringify(selectedTexts) : null,
        serializeSelectedTextSources(message.selectedTextSources, selectedTexts.length),
        selectedTextPaperContexts.some((entry) => Boolean(entry))
          ? JSON.stringify(selectedTextPaperContexts)
          : null,
        selectedTextNoteContexts.some((entry) => Boolean(entry))
          ? JSON.stringify(selectedTextNoteContexts)
          : null,
        message.paperContexts?.length ? JSON.stringify(normalizePaperContextRefs(message.paperContexts)) : null,
        message.fullTextPaperContexts?.length
          ? JSON.stringify(normalizePaperContextRefs(message.fullTextPaperContexts))
          : null,
        message.citationPaperContexts?.length
          ? JSON.stringify(normalizePaperContextRefs(message.citationPaperContexts))
          : null,
        message.screenshotImages?.length ? JSON.stringify(message.screenshotImages) : null,
        message.attachments?.length ? JSON.stringify(message.attachments) : null,
        ...selector.params,
      ],
    );
    await touchCodexConversationActivity(normalizedKey, messageTimestamp);
    await refreshCodexConversationCatalogSummary(normalizedKey);
  });
  await refreshCodexConversationSearchIndex(normalizedKey);
}

export async function updateLatestCodexAssistantMessage(
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
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return;
  const messageTimestamp = Number.isFinite(message.timestamp)
    ? Math.floor(message.timestamp)
    : Date.now();
  const quoteCitations = normalizeQuoteCitations(message.quoteCitations);
  const generatedImages = normalizeGeneratedChatImages(message.generatedImages);
  const selector = await resolveRepairingMessageConversationSelector(normalizedKey);
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `UPDATE ${CODEX_MESSAGES_TABLE}
       SET text = ?,
           timestamp = ?,
           run_mode = ?,
           agent_run_id = ?,
           model_name = ?,
           model_entry_id = ?,
           model_provider_label = ?,
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
         FROM ${CODEX_MESSAGES_TABLE}
         WHERE ${selector.whereSql} AND role = 'assistant'
         ORDER BY timestamp DESC, id DESC
         LIMIT 1
       )`,
      [
        message.text || "",
        messageTimestamp,
        message.runMode || null,
        message.agentRunId || null,
        message.modelName || null,
        message.modelEntryId || null,
        message.modelProviderLabel || null,
        message.webchatRunState || null,
        message.webchatCompletionReason || null,
        message.reasoningSummary || null,
        message.reasoningDetails || null,
        message.compactMarker ? 1 : 0,
        quoteCitations.length ? JSON.stringify(quoteCitations) : null,
        generatedImages.length ? JSON.stringify(generatedImages) : null,
        Number.isFinite(Number(message.contextTokens)) && Number(message.contextTokens) > 0
          ? Math.floor(Number(message.contextTokens))
          : null,
        Number.isFinite(Number(message.contextWindow)) && Number(message.contextWindow) > 0
          ? Math.floor(Number(message.contextWindow))
          : null,
        ...selector.params,
      ],
    );
    await touchCodexConversationActivity(normalizedKey, messageTimestamp);
    await refreshCodexConversationCatalogSummary(normalizedKey);
  });
  await refreshCodexConversationSearchIndex(normalizedKey);
}

type CodexConversationRow = {
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

function toCodexConversationSummary(
  row: CodexConversationRow,
): CodexConversationSummary | null {
  const conversationKey = normalizeConversationKey(Number(row.conversationKey));
  const libraryID = normalizeLibraryID(Number(row.libraryID));
  const createdAt = normalizeCatalogTimestamp(row.createdAt);
  const updatedAt = normalizeCatalogTimestamp(row.updatedAt);
  const kind = row.kind === "paper" ? "paper" : row.kind === "global" ? "global" : null;
  if (
    !conversationKey ||
    !libraryID ||
    !kind ||
    !isCodexStoreConversationKeyForKind(conversationKey, kind)
  ) {
    return null;
  }
  const paperItemID = normalizePaperItemID(Number(row.paperItemID));
  const userTurnCount = Number(row.userTurnCount);
  return {
    conversationID:
      typeof row.conversationID === "string" && row.conversationID.trim()
        ? row.conversationID.trim()
        : buildCodexConversationID({
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
      typeof row.scopedConversationKey === "string" && row.scopedConversationKey.trim()
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
    cwd: typeof row.cwd === "string" && row.cwd.trim() ? row.cwd.trim() : undefined,
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

function sameCodexCatalogScope(
  existing: CodexConversationSummary,
  params: {
    libraryID: number;
    kind: CodexConversationKind;
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

function logCodexScopeWarning(message: string): void {
  const debug = (globalThis as typeof globalThis & {
    Zotero?: { debug?: (message: string) => void };
  }).Zotero?.debug;
  debug?.(`LLM: ${message}`);
}

function formatSearchIndexError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function refreshCodexConversationSearchIndex(
  conversationKey: number,
): Promise<void> {
  try {
    await refreshConversationSearchIndexForConversation({
      system: "codex",
      conversationKey,
    });
  } catch (error) {
    logCodexScopeWarning(
      `Failed to refresh Codex conversation search index for ${conversationKey}: ${formatSearchIndexError(error)}`,
    );
  }
}

async function deleteCodexConversationSearchIndex(
  conversationKey: number,
): Promise<void> {
  try {
    await deleteConversationSearchIndexRow({
      system: "codex",
      conversationKey,
    });
  } catch (error) {
    logCodexScopeWarning(
      `Failed to delete Codex conversation search index row for ${conversationKey}: ${formatSearchIndexError(error)}`,
    );
  }
}

async function filterValidCodexConversationSummaries(
  summaries: CodexConversationSummary[],
  expectedPaperItemID?: number | null,
): Promise<CodexConversationSummary[]> {
  const filtered: CodexConversationSummary[] = [];
  for (const summary of summaries) {
    const validSummary = await validateOrRepairCodexConversationSummary(summary);
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

async function validateOrRepairCodexConversationSummary(
  summary: CodexConversationSummary,
): Promise<CodexConversationSummary | null> {
  const valid = await validateConversationScope({
    conversationID: summary.conversationID,
    conversationKey: summary.conversationKey,
    system: "codex",
    kind: summary.kind,
    libraryID: summary.libraryID,
    paperItemID: summary.paperItemID,
  });
  if (valid) return summary;

  const registered = await getRegisteredConversationScope(
    summary.conversationKey,
  );
  if (registered) return null;

  if (summary.kind === "global") {
    const registeredMissingGlobal = await registerConversationScope({
      conversationID: summary.conversationID,
      conversationKey: summary.conversationKey,
      system: "codex",
      kind: summary.kind,
      libraryID: summary.libraryID,
      paperItemID: summary.paperItemID,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      title: summary.title,
    });
    return registeredMissingGlobal ? summary : null;
  }

  const contextRows = await getCodexMessagePaperContextRows(
    summary.conversationKey,
  );
  const inferredPaperItemID = inferSinglePaperItemIdFromContextRows(contextRows);
  if (inferredPaperItemID === "ambiguous") {
    await repairRegisteredConversationScope({
      conversationID: summary.conversationID,
      conversationKey: summary.conversationKey,
      system: "codex",
      kind: "paper",
      libraryID: summary.libraryID,
      paperItemID: summary.paperItemID,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      title: summary.title,
    });
    await invalidateRegisteredConversationScope(
      summary.conversationKey,
      "ambiguous paper context evidence",
    );
    return null;
  }

  if (
    inferredPaperItemID &&
    summary.paperItemID &&
    inferredPaperItemID !== summary.paperItemID
  ) {
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
      [repairedConversationID, inferredPaperItemID, summary.conversationKey],
    );
    await Zotero.DB.queryAsync(
      `UPDATE ${CODEX_MESSAGES_TABLE}
       SET conversation_id = ?
       WHERE conversation_key = ?`,
      [repairedConversationID, summary.conversationKey],
    );
    removeLastUsedCodexPaperConversationKey(
      summary.libraryID,
      summary.paperItemID,
    );
    setLastUsedCodexPaperConversationKey(
      summary.libraryID,
      inferredPaperItemID,
      summary.conversationKey,
    );
    await repairRegisteredConversationScope({
      conversationKey: summary.conversationKey,
      system: "codex",
      kind: "paper",
      libraryID: summary.libraryID,
      paperItemID: inferredPaperItemID,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      title: summary.title,
    });
    logCodexScopeWarning(
      `Repaired Codex conversation ${summary.conversationKey} from paper ${summary.paperItemID} to paper ${inferredPaperItemID} while loading history.`,
    );
    return {
      ...summary,
      conversationID: repairedConversationID,
      paperItemID: inferredPaperItemID,
    };
  }

  const registeredMissingPaper = await registerConversationScope({
    conversationID: summary.conversationID,
    conversationKey: summary.conversationKey,
    system: "codex",
    kind: "paper",
    libraryID: summary.libraryID,
    paperItemID: summary.paperItemID,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    title: summary.title,
  });
  return registeredMissingPaper ? summary : null;
}

export async function getCodexConversationSummary(
  conversationKey: number,
): Promise<CodexConversationSummary | null> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return null;
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
            c.scoped_conversation_key AS scopedConversationKey,
            c.scope_type AS scopeType,
            c.scope_id AS scopeId,
            c.scope_label AS scopeLabel,
            c.cwd AS cwd,
            c.model_name AS modelName,
            c.effort AS effort,
            COALESCE(c.user_turn_count, 0) AS userTurnCount
     FROM ${CODEX_CONVERSATIONS_TABLE} c
     WHERE c.conversation_key = ?
     LIMIT 1`,
    [normalizedKey],
  )) as CodexConversationRow[] | undefined;
  return rows?.length ? toCodexConversationSummary(rows[0]) : null;
}

export async function upsertCodexConversationSummary(params: {
  conversationKey: number;
  libraryID: number;
  kind: CodexConversationKind;
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
}): Promise<boolean> {
  const conversationKey = normalizeConversationKey(params.conversationKey);
  const libraryID = normalizeLibraryID(params.libraryID);
  if (
    !conversationKey ||
    !libraryID ||
    !isCodexStoreConversationKeyForKind(conversationKey, params.kind)
  ) {
    return false;
  }
  const createdAt = normalizeCatalogTimestamp(params.createdAt);
  const updatedAt = normalizeCatalogTimestamp(params.updatedAt);
  const paperItemID = normalizePaperItemID(Number(params.paperItemID));
  const title = normalizeConversationTitleSeed(params.title || "") || null;
  const conversationID = buildCodexConversationID({
    conversationKey,
    kind: params.kind,
    libraryID,
    paperItemID,
  });
  const existing = await getCodexConversationSummary(conversationKey);
  if (
    existing &&
    !sameCodexCatalogScope(existing, {
      libraryID,
      kind: params.kind,
      paperItemID,
    })
  ) {
    logCodexScopeWarning(
      `Refused to reassign Codex conversation ${conversationKey} from ${existing.kind}/${existing.libraryID}/${existing.paperItemID || ""} to ${params.kind}/${libraryID}/${paperItemID || ""}.`,
    );
    return false;
  }
  const registryOk = await registerConversationScope({
    conversationID,
    conversationKey,
    system: "codex",
    kind: params.kind,
    libraryID,
    paperItemID,
    createdAt,
    updatedAt,
    title,
  });
  if (!registryOk) return false;
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `INSERT INTO ${CODEX_CONVERSATIONS_TABLE}
        (conversation_id, conversation_key, library_id, kind, paper_item_id, created_at, updated_at, last_activity_at, user_turn_count, first_user_title, title, provider_session_id, scoped_conversation_key, scope_type, scope_id, scope_label, cwd, model_name, effort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_key) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         library_id = excluded.library_id,
         kind = excluded.kind,
         paper_item_id = excluded.paper_item_id,
         created_at = COALESCE(${CODEX_CONVERSATIONS_TABLE}.created_at, excluded.created_at),
         updated_at = excluded.updated_at,
         last_activity_at = COALESCE(excluded.last_activity_at, ${CODEX_CONVERSATIONS_TABLE}.last_activity_at, excluded.updated_at),
         title = COALESCE(excluded.title, ${CODEX_CONVERSATIONS_TABLE}.title),
         provider_session_id = COALESCE(excluded.provider_session_id, ${CODEX_CONVERSATIONS_TABLE}.provider_session_id),
         scoped_conversation_key = COALESCE(excluded.scoped_conversation_key, ${CODEX_CONVERSATIONS_TABLE}.scoped_conversation_key),
         scope_type = COALESCE(excluded.scope_type, ${CODEX_CONVERSATIONS_TABLE}.scope_type),
         scope_id = COALESCE(excluded.scope_id, ${CODEX_CONVERSATIONS_TABLE}.scope_id),
         scope_label = COALESCE(excluded.scope_label, ${CODEX_CONVERSATIONS_TABLE}.scope_label),
         cwd = COALESCE(excluded.cwd, ${CODEX_CONVERSATIONS_TABLE}.cwd),
         model_name = COALESCE(excluded.model_name, ${CODEX_CONVERSATIONS_TABLE}.model_name),
         effort = COALESCE(excluded.effort, ${CODEX_CONVERSATIONS_TABLE}.effort)`,
      [
        conversationID,
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
    await refreshCodexConversationCatalogSummary(conversationKey);
  });
  await refreshCodexConversationSearchIndex(conversationKey);
  return true;
}

async function listCodexConversations(params: {
  libraryID: number;
  kind: CodexConversationKind;
  paperItemID?: number;
  limit?: number;
}): Promise<CodexConversationSummary[]> {
  const libraryID = normalizeLibraryID(params.libraryID);
  if (!libraryID) return [];
  const limit = normalizeLimit(params.limit ?? 50, 50);
  const sql = params.kind === "paper"
    ? `SELECT c.conversation_id AS conversationID,
              c.conversation_key AS conversationKey,
              c.library_id AS libraryID,
              c.kind AS kind,
              c.paper_item_id AS paperItemID,
              c.created_at AS createdAt,
              ${CODEX_CONVERSATION_ACTIVITY_TIMESTAMP_SQL_FOR_ALIAS_C} AS updatedAt,
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
       FROM ${CODEX_CONVERSATIONS_TABLE} c
       WHERE c.library_id = ?
         AND c.kind = 'paper'
         AND c.paper_item_id = ?
       ORDER BY updatedAt DESC, c.conversation_key DESC
       LIMIT ?`
    : `SELECT c.conversation_id AS conversationID,
              c.conversation_key AS conversationKey,
              c.library_id AS libraryID,
              c.kind AS kind,
              c.paper_item_id AS paperItemID,
              c.created_at AS createdAt,
              ${CODEX_CONVERSATION_ACTIVITY_TIMESTAMP_SQL_FOR_ALIAS_C} AS updatedAt,
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
       FROM ${CODEX_CONVERSATIONS_TABLE} c
       WHERE c.library_id = ?
         AND c.kind = 'global'
       ORDER BY updatedAt DESC, c.conversation_key DESC
       LIMIT ?`;
  const rows = (await Zotero.DB.queryAsync(
    sql,
    params.kind === "paper"
      ? [libraryID, normalizePaperItemID(Number(params.paperItemID)) || 0, limit]
      : [libraryID, limit],
  )) as CodexConversationRow[] | undefined;
  if (!rows?.length) return [];
  const summaries = rows
    .map((row) => toCodexConversationSummary(row))
    .filter((row): row is CodexConversationSummary => Boolean(row));
  return filterValidCodexConversationSummaries(
    summaries,
    params.kind === "paper" ? normalizePaperItemID(Number(params.paperItemID)) : null,
  );
}

export async function listCodexGlobalConversations(
  libraryID: number,
  limit = 50,
): Promise<CodexConversationSummary[]> {
  return listCodexConversations({ libraryID, kind: "global", limit });
}

export async function listCodexPaperConversations(
  libraryID: number,
  paperItemID: number,
  limit = 50,
): Promise<CodexConversationSummary[]> {
  return listCodexConversations({ libraryID, kind: "paper", paperItemID, limit });
}

export async function listAllCodexPaperConversationsByLibrary(
  libraryID: number,
  limit = 100,
): Promise<CodexConversationSummary[]> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  if (!normalizedLibraryID) return [];
  const normalizedLimit = normalizeLimit(limit, 100);
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
            c.scoped_conversation_key AS scopedConversationKey,
            c.scope_type AS scopeType,
            c.scope_id AS scopeId,
            c.scope_label AS scopeLabel,
            c.cwd AS cwd,
            c.model_name AS modelName,
            c.effort AS effort,
            COALESCE(c.user_turn_count, 0) AS userTurnCount
     FROM ${CODEX_CONVERSATIONS_TABLE} c
     WHERE c.library_id = ?
       AND c.kind = 'paper'
       AND COALESCE(c.user_turn_count, 0) > 0
     ORDER BY updatedAt DESC, c.conversation_key DESC
     LIMIT ?`,
    [normalizedLibraryID, normalizedLimit],
  )) as CodexConversationRow[] | undefined;
  if (!rows?.length) return [];
  const summaries = rows
    .map((row) => toCodexConversationSummary(row))
    .filter((row): row is CodexConversationSummary => Boolean(row));
  return filterValidCodexConversationSummaries(summaries);
}

export async function ensureCodexGlobalConversation(
  libraryID: number,
): Promise<CodexConversationSummary | null> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  if (!normalizedLibraryID) return null;
  const conversationKey = buildDefaultCodexGlobalConversationKey(normalizedLibraryID);
  const stored = await upsertCodexConversationSummary({
    conversationKey,
    libraryID: normalizedLibraryID,
    kind: "global",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  if (!stored) {
    return createCodexGlobalConversation(normalizedLibraryID);
  }
  return getCodexConversationSummary(conversationKey);
}

export async function ensureCodexPaperConversation(
  libraryID: number,
  paperItemID: number,
): Promise<CodexConversationSummary | null> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  const normalizedPaperItemID = normalizePaperItemID(paperItemID);
  if (!normalizedLibraryID || !normalizedPaperItemID) return null;
  const conversationKey = buildDefaultCodexPaperConversationKey(normalizedPaperItemID);
  const stored = await upsertCodexConversationSummary({
    conversationKey,
    libraryID: normalizedLibraryID,
    kind: "paper",
    paperItemID: normalizedPaperItemID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  if (!stored) {
    return createCodexPaperConversation(normalizedLibraryID, normalizedPaperItemID);
  }
  return getCodexConversationSummary(conversationKey);
}

async function getMaxCodexConversationKey(kind: CodexConversationKind): Promise<number> {
  const range = getCodexAllocatedConversationKeyRange(kind);
  const rows = (await Zotero.DB.queryAsync(
    `SELECT MAX(conversation_key) AS maxConversationKey
     FROM ${CODEX_CONVERSATIONS_TABLE}
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

export async function createCodexGlobalConversation(
  libraryID: number,
): Promise<CodexConversationSummary | null> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  if (!normalizedLibraryID) return null;
  const nextKey = Math.max(
    getCodexAllocatedConversationKeyRange("global").start,
    (getLastAllocatedCodexGlobalConversationKey() || 0) + 1,
    (await getMaxCodexConversationKey("global")) + 1,
  );
  const stored = await upsertCodexConversationSummary({
    conversationKey: nextKey,
    libraryID: normalizedLibraryID,
    kind: "global",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  if (!stored) return null;
  setLastAllocatedCodexGlobalConversationKey(nextKey);
  return getCodexConversationSummary(nextKey);
}

export async function createCodexPaperConversation(
  libraryID: number,
  paperItemID: number,
): Promise<CodexConversationSummary | null> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  const normalizedPaperItemID = normalizePaperItemID(paperItemID);
  if (!normalizedLibraryID || !normalizedPaperItemID) return null;
  const nextKey = Math.max(
    getCodexAllocatedConversationKeyRange("paper").start,
    (getLastAllocatedCodexPaperConversationKey() || 0) + 1,
    (await getMaxCodexConversationKey("paper")) + 1,
  );
  const stored = await upsertCodexConversationSummary({
    conversationKey: nextKey,
    libraryID: normalizedLibraryID,
    kind: "paper",
    paperItemID: normalizedPaperItemID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  if (!stored) return null;
  setLastAllocatedCodexPaperConversationKey(nextKey);
  return getCodexConversationSummary(nextKey);
}

export async function touchCodexConversationTitle(
  conversationKey: number,
  titleSeed: string,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return;
  const title = normalizeConversationTitleSeed(titleSeed);
  if (!title) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${CODEX_CONVERSATIONS_TABLE}
     SET title = ?
     WHERE conversation_key = ?
       AND (title IS NULL OR TRIM(title) = '')`,
    [title, normalizedKey],
  );
  await refreshCodexConversationSearchIndex(normalizedKey);
}

export async function clearCodexConversationSessionMetadata(
  conversationKey: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${CODEX_CONVERSATIONS_TABLE}
     SET provider_session_id = NULL,
         scoped_conversation_key = NULL,
         scope_type = NULL,
         scope_id = NULL,
         scope_label = NULL,
         cwd = NULL,
         updated_at = ?
     WHERE conversation_key = ?`,
    [Date.now(), normalizedKey],
  );
  await refreshCodexConversationSearchIndex(normalizedKey);
}

export async function setCodexConversationTitle(
  conversationKey: number,
  titleSeed: string,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${CODEX_CONVERSATIONS_TABLE}
     SET title = ?
     WHERE conversation_key = ?`,
    [normalizeConversationTitleSeed(titleSeed) || null, normalizedKey],
  );
  await refreshCodexConversationSearchIndex(normalizedKey);
}

export async function deleteCodexConversation(
  conversationKey: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return;
  await Zotero.DB.queryAsync(
    `DELETE FROM ${CODEX_CONVERSATIONS_TABLE}
     WHERE conversation_key = ?`,
    [normalizedKey],
  );
  await deleteCodexConversationSearchIndex(normalizedKey);
}

export async function preflightDeleteCodexConversationLocalRows(
  conversationKey: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return;
  const repair = await repairRecoverableCodexCatalogMessageConversationIDs(
    normalizedKey,
  );
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
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isCodexStoreConversationKey(normalizedKey)) return;
  await preflightDeleteCodexConversationLocalRows(normalizedKey);
  const selector = await resolveRepairingMessageConversationSelector(normalizedKey, {
    destructive: true,
  });
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CODEX_MESSAGES_TABLE}
       WHERE ${selector.whereSql}`,
      selector.params,
    );
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CODEX_CONVERSATIONS_TABLE}
       WHERE conversation_key = ?`,
      [normalizedKey],
    );
  });
  await deleteCodexConversationSearchIndex(normalizedKey);
}

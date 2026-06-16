import type {
  CollectionContextRef,
  NoteContextRef,
  SelectedTextSource,
  PaperContextRef,
  QuoteCitation,
  TagContextRef,
  GeneratedChatImage,
  GlobalConversationSummary,
  PaperConversationSummary,
} from "../shared/types";
import { normalizeGeneratedChatImages } from "../shared/generatedImages";
import {
  GLOBAL_CONVERSATION_KEY_BASE,
  PAPER_CONVERSATION_KEY_BASE,
} from "../modules/contextPanel/constants";
import {
  buildDefaultUpstreamGlobalConversationKey,
  isConversationKeyFor,
  isConversationKeyForKind,
  UPSTREAM_GLOBAL_ALLOCATED_CONVERSATION_KEY_BASE,
  UPSTREAM_RUNTIME_CONVERSATION_KEY_END,
} from "../shared/conversationKeySpace";
import {
  buildLatestStoredMessagesQuery,
  storedMessageDisplayOrderSql,
} from "../shared/conversationMessageSql";
import {
  buildConversationID,
  getRegisteredConversationScope,
  initConversationRegistryStore,
  repairRegisteredConversationScope,
  registerConversationScope,
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
import {
  parseForcedSkillIdsJson,
  serializeForcedSkillIds,
} from "../shared/skillIds";
import {
  normalizeSelectedTextNoteContexts,
  normalizeSelectedTextPaperContexts,
  normalizeSelectedTextSource,
  normalizePaperContextRefs,
  normalizeCollectionContextRefs,
  normalizeTagContextRefs,
} from "../modules/contextPanel/normalizers";
import { normalizeQuoteCitations } from "../modules/contextPanel/quoteCitations";

export type StoredChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  category: "image" | "pdf" | "markdown" | "code" | "text" | "file";
  imageDataUrl?: string;
  textContent?: string;
  storedPath?: string;
  contentHash?: string;
};

export type StoredChatMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  runMode?: "chat" | "agent";
  agentRunId?: string;
  selectedText?: string;
  selectedTexts?: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  selectedTextNoteContexts?: (NoteContextRef | undefined)[];
  forcedSkillIds?: string[];
  paperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  citationPaperContexts?: PaperContextRef[];
  quoteCitations?: QuoteCitation[];
  selectedCollectionContexts?: CollectionContextRef[];
  selectedTagContexts?: TagContextRef[];
  screenshotImages?: string[];
  attachments?: StoredChatAttachment[];
  modelAttachments?: StoredChatAttachment[];
  generatedImages?: GeneratedChatImage[];
  modelName?: string;
  modelEntryId?: string;
  modelProviderLabel?: string;
  webchatRunState?: "done" | "incomplete" | "error";
  webchatCompletionReason?:
    | "settled"
    | "forced_cancel"
    | "timeout"
    | "error"
    | null;
  webchatChatUrl?: string;
  webchatChatId?: string;
  reasoningSummary?: string;
  reasoningDetails?: string;
  compactMarker?: boolean;
  contextTokens?: number;
  contextWindow?: number;
  runtimeMarkerText?: string;
  modelSwitchMarkerText?: string;
};

const CHAT_MESSAGES_TABLE = "llm_for_zotero_chat_messages";
const CHAT_MESSAGES_INDEX = "llm_for_zotero_chat_messages_conversation_idx";
const CHAT_MESSAGES_ID_INDEX =
  "llm_for_zotero_chat_messages_conversation_id_idx";
const GLOBAL_CONVERSATIONS_TABLE = "llm_for_zotero_global_conversations";
const GLOBAL_CONVERSATIONS_LIBRARY_INDEX =
  "llm_for_zotero_global_conversations_library_idx";
const GLOBAL_CONVERSATIONS_ACTIVITY_INDEX =
  "llm_for_zotero_global_conversations_activity_idx";
const GLOBAL_CONVERSATIONS_ID_INDEX =
  "llm_for_zotero_global_conversations_id_idx";
const PAPER_CONVERSATIONS_TABLE = "llm_for_zotero_paper_conversations";
const PAPER_CONVERSATIONS_PAPER_INDEX =
  "llm_for_zotero_paper_conversations_paper_idx";
const PAPER_CONVERSATIONS_PAPER_ACTIVITY_INDEX =
  "llm_for_zotero_paper_conversations_paper_activity_idx";
const PAPER_CONVERSATIONS_LIBRARY_ACTIVITY_INDEX =
  "llm_for_zotero_paper_conversations_library_activity_idx";
const PAPER_CONVERSATIONS_CONVERSATION_INDEX =
  "llm_for_zotero_paper_conversations_conversation_idx";
const PAPER_CONVERSATIONS_ID_INDEX =
  "llm_for_zotero_paper_conversations_id_idx";
const LEGACY_CHAT_MESSAGES_TABLE = "zoterollm_chat_messages";
const LEGACY_CHAT_MESSAGES_INDEX = "zoterollm_chat_messages_conversation_idx";
const CHAT_MESSAGE_SELECT_COLUMNS_SQL = `id,
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
            forced_skill_ids_json AS forcedSkillIdsJson,
            paper_contexts_json AS paperContextsJson,
            full_text_paper_contexts_json AS fullTextPaperContextsJson,
            citation_paper_contexts_json AS citationPaperContextsJson,
            quote_citations_json AS quoteCitationsJson,
            collection_contexts_json AS collectionContextsJson,
            tag_contexts_json AS tagContextsJson,
            screenshot_images AS screenshotImages,
            attachments_json AS attachmentsJson,
            model_attachments_json AS modelAttachmentsJson,
            generated_images_json AS generatedImagesJson,
            model_name AS modelName,
            model_entry_id AS modelEntryId,
            model_provider_label AS modelProviderLabel,
            webchat_run_state AS webchatRunState,
            webchat_completion_reason AS webchatCompletionReason,
            reasoning_summary AS reasoningSummary,
            reasoning_details AS reasoningDetails,
            context_tokens AS contextTokens,
            context_window AS contextWindow`;

async function tableExists(tableName: string): Promise<boolean> {
  let rows = (await Zotero.DB.queryAsync(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName],
  )) as Array<{ name?: unknown }> | undefined;
  return Boolean(rows?.length);
}

async function countRows(tableName: string): Promise<number> {
  let rows = (await Zotero.DB.queryAsync(
    `SELECT COUNT(*) AS count FROM ${tableName}`,
  )) as Array<{ count?: unknown }> | undefined;
  const count = Number(rows?.[0]?.count);
  return Number.isFinite(count) ? count : 0;
}

async function migrateLegacyChatStore(): Promise<void> {
  const hasLegacyTable = await tableExists(LEGACY_CHAT_MESSAGES_TABLE);
  if (!hasLegacyTable) return;

  const hasCurrentTable = await tableExists(CHAT_MESSAGES_TABLE);
  if (!hasCurrentTable) {
    await Zotero.DB.queryAsync(
      `ALTER TABLE ${LEGACY_CHAT_MESSAGES_TABLE}
       RENAME TO ${CHAT_MESSAGES_TABLE}`,
    );
  } else {
    const currentRows = await countRows(CHAT_MESSAGES_TABLE);
    if (currentRows === 0) {
      await Zotero.DB.queryAsync(
        `INSERT INTO ${CHAT_MESSAGES_TABLE}
          (conversation_key, role, text, timestamp, selected_text, screenshot_images, model_name, reasoning_summary, reasoning_details)
         SELECT
           conversation_key,
           role,
           text,
           timestamp,
           selected_text,
           screenshot_images,
           model_name,
           reasoning_summary,
           reasoning_details
         FROM ${LEGACY_CHAT_MESSAGES_TABLE}`,
      );
    }
  }

  await Zotero.DB.queryAsync(
    `DROP INDEX IF EXISTS ${LEGACY_CHAT_MESSAGES_INDEX}`,
  );
}

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

function normalizeSessionVersion(sessionVersion: number): number | null {
  if (!Number.isFinite(sessionVersion)) return null;
  const normalized = Math.floor(sessionVersion);
  return normalized > 0 ? normalized : null;
}

function normalizeConversationTitleSeed(value: string): string {
  if (typeof value !== "string") return "";
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized.slice(0, 64);
}

function normalizeLimit(limit: number, fallback: number): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.floor(limit));
}

function normalizeOptionalLimit(limit: number | null | undefined): number | null {
  if (limit === null) return null;
  if (!Number.isFinite(Number(limit))) return null;
  const normalized = Math.floor(Number(limit));
  return normalized > 0 ? normalized : null;
}

function normalizeStoredAttachments(
  attachments?: StoredChatAttachment[],
): StoredChatAttachment[] {
  return Array.isArray(attachments)
    ? attachments
        .filter(
          (entry) => entry && typeof entry.id === "string" && entry.id.trim(),
        )
        .map((entry) => ({
          ...entry,
          id: entry.id.trim(),
          name:
            typeof entry.name === "string" && entry.name.trim()
              ? entry.name.trim()
              : "Attachment",
          mimeType:
            typeof entry.mimeType === "string" && entry.mimeType.trim()
              ? entry.mimeType.trim()
              : "application/octet-stream",
          sizeBytes: Number.isFinite(Number(entry.sizeBytes))
            ? Math.max(0, Math.floor(Number(entry.sizeBytes)))
            : 0,
          storedPath:
            typeof entry.storedPath === "string" && entry.storedPath.trim()
              ? entry.storedPath.trim()
              : undefined,
          contentHash:
            typeof entry.contentHash === "string" &&
            /^[a-f0-9]{64}$/i.test(entry.contentHash.trim())
              ? entry.contentHash.trim().toLowerCase()
              : undefined,
        }))
    : [];
}

function parseStoredAttachmentsJson(
  value: unknown,
  options: { preserveEmpty?: boolean } = {},
): StoredChatAttachment[] | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const normalized = parsed.reduce<StoredChatAttachment[]>((out, entry) => {
      if (!entry || typeof entry !== "object") return out;
      const typed = entry as Record<string, unknown>;
      const id =
        typeof typed.id === "string" && typed.id.trim()
          ? typed.id.trim()
          : null;
      const name =
        typeof typed.name === "string" && typed.name.trim()
          ? typed.name.trim()
          : null;
      const mimeType =
        typeof typed.mimeType === "string" && typed.mimeType.trim()
          ? typed.mimeType.trim()
          : "application/octet-stream";
      const sizeBytes = Number(typed.sizeBytes);
      const category = typed.category;
      const validCategory =
        category === "image" ||
        category === "pdf" ||
        category === "markdown" ||
        category === "code" ||
        category === "text" ||
        category === "file";
      if (!id || !name || !validCategory) return out;
      out.push({
        id,
        name,
        mimeType,
        sizeBytes: Number.isFinite(sizeBytes) ? Math.max(0, sizeBytes) : 0,
        category,
        imageDataUrl:
          typeof typed.imageDataUrl === "string" && typed.imageDataUrl.trim()
            ? typed.imageDataUrl
            : undefined,
        textContent:
          typeof typed.textContent === "string" && typed.textContent
            ? typed.textContent
            : undefined,
        storedPath:
          typeof typed.storedPath === "string" && typed.storedPath.trim()
            ? typed.storedPath.trim()
            : undefined,
        contentHash:
          typeof typed.contentHash === "string" &&
          /^[a-f0-9]{64}$/i.test(typed.contentHash.trim())
            ? typed.contentHash.trim().toLowerCase()
            : undefined,
      });
      return out;
    }, []);
    return normalized.length || options.preserveEmpty ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function resolveUserLibraryID(): number {
  const normalized = normalizeLibraryID(
    Number(
      (Zotero as unknown as { Libraries?: { userLibraryID?: unknown } })
        .Libraries?.userLibraryID,
    ),
  );
  return normalized || 1;
}

type ConversationCatalogSeedRow = {
  conversationKey?: unknown;
  createdAt?: unknown;
  title?: unknown;
};

function normalizeCatalogTimestamp(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return Date.now();
  return Math.floor(parsed);
}

function buildUpstreamConversationID(params: {
  conversationKey: number;
  kind: "global" | "paper";
  libraryID: number;
  paperItemID?: number | null;
}): string {
  return buildConversationID({
    conversationKey: params.conversationKey,
    system: "upstream",
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
    : {
        whereSql: "conversation_key = ?",
        params: [conversationKey],
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
    tableName: CHAT_MESSAGES_TABLE,
    registered: selector.registered,
    getPaperContextRows: getUpstreamMessagePaperContextRows,
    storeLabel: "upstream",
    log: logChatStoreWarning,
  });
  if (repair.status === "refused") {
    if (options.destructive) {
      throw new Error(
        `Refused destructive upstream conversation operation for ${conversationKey}: ${repair.reason || "ambiguous stale message ids found"}.`,
      );
    }
    selector = canonicalMessageConversationSelector(selector.registered);
  }
  return selector;
}

function logChatStoreWarning(message: string): void {
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

async function refreshUpstreamConversationSearchIndex(
  conversationKey: number,
): Promise<void> {
  try {
    await refreshConversationSearchIndexForConversation({
      system: "upstream",
      conversationKey,
    });
  } catch (error) {
    logChatStoreWarning(
      `Failed to refresh upstream conversation search index for ${conversationKey}: ${formatSearchIndexError(error)}`,
    );
  }
}

async function deleteUpstreamConversationSearchIndex(
  conversationKey: number,
): Promise<void> {
  try {
    await deleteConversationSearchIndexRow({
      system: "upstream",
      conversationKey,
    });
  } catch (error) {
    logChatStoreWarning(
      `Failed to delete upstream conversation search index row for ${conversationKey}: ${formatSearchIndexError(error)}`,
    );
  }
}

async function getUpstreamMessagePaperContextRows(
  conversationKey: number,
): Promise<PaperContextJsonColumns[]> {
  return ((await Zotero.DB.queryAsync(
    `SELECT paper_contexts_json AS paperContextsJson,
            full_text_paper_contexts_json AS fullTextPaperContextsJson,
            selected_text_paper_contexts_json AS selectedTextPaperContextsJson,
            citation_paper_contexts_json AS citationPaperContextsJson
     FROM ${CHAT_MESSAGES_TABLE}
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

async function repairRecoverableUpstreamCatalogMessageConversationIDs(
  conversationKey?: number,
): Promise<{
  checked: number;
  repaired: number;
  refused: number;
}> {
  const queryAsync = Zotero.DB.queryAsync.bind(Zotero.DB);
  const normalizedKey =
    conversationKey === undefined
      ? null
      : normalizeConversationKey(conversationKey);
  if (conversationKey !== undefined && !normalizedKey) {
    return { checked: 0, repaired: 0, refused: 0 };
  }
  const filter = normalizedKey
    ? { filterSql: "c.conversation_key = ?", filterParams: [normalizedKey] }
    : {};
  const globalRepair = await repairRecoverableCatalogMessageConversationIDs({
    queryAsync,
    catalogTable: GLOBAL_CONVERSATIONS_TABLE,
    messageTable: CHAT_MESSAGES_TABLE,
    system: "upstream",
    kindSql: "'global'",
    paperItemIDSql: "NULL",
    getPaperContextRows: getUpstreamMessagePaperContextRows,
    storeLabel: "upstream",
    log: logChatStoreWarning,
    ...filter,
  });
  const paperRepair = await repairRecoverableCatalogMessageConversationIDs({
    queryAsync,
    catalogTable: PAPER_CONVERSATIONS_TABLE,
    messageTable: CHAT_MESSAGES_TABLE,
    system: "upstream",
    kindSql: "'paper'",
    paperItemIDSql: "c.paper_item_id",
    getPaperContextRows: getUpstreamMessagePaperContextRows,
    storeLabel: "upstream",
    log: logChatStoreWarning,
    ...filter,
  });
  return {
    checked: globalRepair.checked + paperRepair.checked,
    repaired: globalRepair.repaired + paperRepair.repaired,
    refused: globalRepair.refused + paperRepair.refused,
  };
}

async function refreshUpstreamCatalogSummaryTable(
  tableName: string,
  conversationKey?: number,
): Promise<void> {
  const normalizedKey =
    conversationKey === undefined
      ? null
      : normalizeConversationKey(conversationKey);
  if (conversationKey !== undefined && !normalizedKey) return;
  const whereSql = normalizedKey ? "WHERE conversation_key = ?" : "";
  const params = normalizedKey ? [normalizedKey] : [];
  await Zotero.DB.queryAsync(
    `UPDATE ${tableName}
     SET first_user_title = (
           SELECT m0.text
           FROM ${CHAT_MESSAGES_TABLE} m0
           WHERE ${messageJoinCondition("m0", tableName)}
             AND m0.role = 'user'
           ORDER BY m0.timestamp ASC, m0.id ASC
           LIMIT 1
         ),
         last_activity_at = COALESCE(
           (
             SELECT MAX(m.timestamp)
             FROM ${CHAT_MESSAGES_TABLE} m
             WHERE ${messageJoinCondition("m", tableName)}
           ),
           created_at
         ),
         user_turn_count = COALESCE(
           (
             SELECT SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END)
             FROM ${CHAT_MESSAGES_TABLE} m
             WHERE ${messageJoinCondition("m", tableName)}
           ),
           0
         )
     ${whereSql}`,
    params,
  );
}

async function refreshUpstreamConversationCatalogSummary(
  conversationKey?: number,
): Promise<void> {
  await repairRecoverableUpstreamCatalogMessageConversationIDs(conversationKey);
  await refreshUpstreamCatalogSummaryTable(
    GLOBAL_CONVERSATIONS_TABLE,
    conversationKey,
  );
  await refreshUpstreamCatalogSummaryTable(
    PAPER_CONVERSATIONS_TABLE,
    conversationKey,
  );
}

async function getTableColumns(tableName: string): Promise<Set<string>> {
  const rows = (await Zotero.DB.queryAsync(
    `PRAGMA table_info(${tableName})`,
  )) as Array<{ name?: unknown }> | undefined;
  return new Set(
    (rows || [])
      .map((row) => (typeof row.name === "string" ? row.name : ""))
      .filter(Boolean),
  );
}

async function ensureColumn(
  tableName: string,
  columns: Set<string>,
  columnName: string,
  definition: string,
): Promise<void> {
  if (columns.has(columnName)) return;
  await Zotero.DB.queryAsync(
    `ALTER TABLE ${tableName}
     ADD COLUMN ${definition}`,
  );
  columns.add(columnName);
}

function isUpstreamGlobalConversationKey(conversationKey: number): boolean {
  return isConversationKeyForKind("upstream", "global", conversationKey);
}

function isUpstreamPaperConversationKey(conversationKey: number): boolean {
  return isConversationKeyForKind("upstream", "paper", conversationKey);
}

function isUpstreamStoreConversationKey(conversationKey: number): boolean {
  return isConversationKeyFor("upstream", conversationKey);
}

async function purgeInvalidGlobalConversationCatalog(): Promise<void> {
  await Zotero.DB.queryAsync(
    `DELETE FROM ${GLOBAL_CONVERSATIONS_TABLE}
     WHERE conversation_key < ?
        OR conversation_key >= ?`,
    [GLOBAL_CONVERSATION_KEY_BASE, UPSTREAM_RUNTIME_CONVERSATION_KEY_END],
  );
}

async function reconcileGlobalConversationCatalog(): Promise<void> {
  const libraryID = resolveUserLibraryID();
  const rows = (await Zotero.DB.queryAsync(
    `SELECT m.conversation_key AS conversationKey,
            MIN(m.timestamp) AS createdAt,
            (
              SELECT m0.text
              FROM ${CHAT_MESSAGES_TABLE} m0
              WHERE m0.conversation_key = m.conversation_key
                AND m0.role = 'user'
              ORDER BY m0.timestamp ASC, m0.id ASC
              LIMIT 1
            ) AS title
     FROM ${CHAT_MESSAGES_TABLE} m
     LEFT JOIN ${GLOBAL_CONVERSATIONS_TABLE} gc
       ON gc.conversation_key = m.conversation_key
     WHERE m.conversation_key >= ?
       AND m.conversation_key < ?
       AND gc.conversation_key IS NULL
     GROUP BY m.conversation_key
     ORDER BY m.conversation_key ASC`,
    [GLOBAL_CONVERSATION_KEY_BASE, UPSTREAM_RUNTIME_CONVERSATION_KEY_END],
  )) as ConversationCatalogSeedRow[] | undefined;

  for (const row of rows || []) {
    const conversationKey = normalizeConversationKey(
      Number(row.conversationKey),
    );
    if (!conversationKey) continue;
    const title =
      typeof row.title === "string" && row.title.trim()
        ? normalizeConversationTitleSeed(row.title)
        : "";
    await Zotero.DB.queryAsync(
      `INSERT OR IGNORE INTO ${GLOBAL_CONVERSATIONS_TABLE}
        (conversation_id, conversation_key, library_id, created_at, title)
       VALUES (?, ?, ?, ?, ?)`,
      [
        buildUpstreamConversationID({
          conversationKey,
          kind: "global",
          libraryID,
        }),
        conversationKey,
        libraryID,
        normalizeCatalogTimestamp(row.createdAt),
        title || null,
      ],
    );
  }
}

async function reconcileLegacyPaperV1ConversationCatalog(): Promise<void> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT m.conversation_key AS conversationKey,
            MIN(m.timestamp) AS createdAt,
            (
              SELECT m0.text
              FROM ${CHAT_MESSAGES_TABLE} m0
              WHERE m0.conversation_key = m.conversation_key
                AND m0.role = 'user'
              ORDER BY m0.timestamp ASC, m0.id ASC
              LIMIT 1
            ) AS title
     FROM ${CHAT_MESSAGES_TABLE} m
     LEFT JOIN ${PAPER_CONVERSATIONS_TABLE} pc
       ON pc.conversation_key = m.conversation_key
     WHERE m.conversation_key > 0
       AND m.conversation_key < ?
       AND pc.conversation_key IS NULL
     GROUP BY m.conversation_key
     ORDER BY m.conversation_key ASC`,
    [PAPER_CONVERSATION_KEY_BASE],
  )) as ConversationCatalogSeedRow[] | undefined;

  for (const row of rows || []) {
    const conversationKey = normalizeConversationKey(
      Number(row.conversationKey),
    );
    if (!conversationKey) continue;
    const paperItem = Zotero.Items.get(conversationKey) || null;
    if (!paperItem?.isRegularItem?.()) continue;
    const libraryID =
      normalizeLibraryID(Number(paperItem.libraryID)) || resolveUserLibraryID();
    const title =
      typeof row.title === "string" && row.title.trim()
        ? normalizeConversationTitleSeed(row.title)
        : "";
    await Zotero.DB.queryAsync(
      `INSERT OR IGNORE INTO ${PAPER_CONVERSATIONS_TABLE}
        (conversation_id, conversation_key, library_id, paper_item_id, session_version, created_at, title)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [
        buildUpstreamConversationID({
          conversationKey,
          kind: "paper",
          libraryID,
          paperItemID: conversationKey,
        }),
        conversationKey,
        libraryID,
        conversationKey,
        normalizeCatalogTimestamp(row.createdAt),
        title || null,
      ],
    );
  }
}

export async function reconcileConversationCatalogs(): Promise<void> {
  await purgeInvalidGlobalConversationCatalog();
  await reconcileGlobalConversationCatalog();
  await reconcileLegacyPaperV1ConversationCatalog();
}

async function getGlobalConversationKeyInUse(
  conversationKey: number,
): Promise<boolean> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT conversation_key AS conversationKey
     FROM ${GLOBAL_CONVERSATIONS_TABLE}
     WHERE conversation_key = ?
     LIMIT 1`,
    [conversationKey],
  )) as Array<{ conversationKey?: unknown }> | undefined;
  return Boolean(rows?.length);
}

async function getNextAvailableGlobalConversationKey(
  preferredKey: number,
  currentKey?: number,
): Promise<number> {
  const normalizedPreferred = normalizeConversationKey(preferredKey);
  if (
    normalizedPreferred &&
    normalizedPreferred !== currentKey &&
    isUpstreamGlobalConversationKey(normalizedPreferred) &&
    !(await getGlobalConversationKeyInUse(normalizedPreferred))
  ) {
    return normalizedPreferred;
  }
  const rows = (await Zotero.DB.queryAsync(
    `SELECT MAX(conversation_key) AS maxConversationKey
     FROM ${GLOBAL_CONVERSATIONS_TABLE}
     WHERE conversation_key >= ?
       AND conversation_key < ?`,
    [
      UPSTREAM_GLOBAL_ALLOCATED_CONVERSATION_KEY_BASE,
      UPSTREAM_RUNTIME_CONVERSATION_KEY_END,
    ],
  )) as Array<{ maxConversationKey?: unknown }> | undefined;
  const maxConversationKey = Number(rows?.[0]?.maxConversationKey);
  return Number.isFinite(maxConversationKey)
    ? Math.max(
        UPSTREAM_GLOBAL_ALLOCATED_CONVERSATION_KEY_BASE,
        Math.floor(maxConversationKey) + 1,
      )
    : UPSTREAM_GLOBAL_ALLOCATED_CONVERSATION_KEY_BASE;
}

async function migrateSharedGlobalDefaultConversationKey(): Promise<void> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT conversation_key AS conversationKey,
            library_id AS libraryID
     FROM ${GLOBAL_CONVERSATIONS_TABLE}
     WHERE conversation_key = ?`,
    [GLOBAL_CONVERSATION_KEY_BASE],
  )) as Array<{ conversationKey?: unknown; libraryID?: unknown }> | undefined;
  const row = rows?.[0];
  if (!row) return;
  const libraryID = normalizeLibraryID(Number(row.libraryID));
  if (!libraryID) return;
  const targetKey = await getNextAvailableGlobalConversationKey(
    buildDefaultUpstreamGlobalConversationKey(libraryID),
    GLOBAL_CONVERSATION_KEY_BASE,
  );
  if (targetKey === GLOBAL_CONVERSATION_KEY_BASE) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${GLOBAL_CONVERSATIONS_TABLE}
     SET conversation_key = ?
     WHERE conversation_key = ?`,
    [targetKey, GLOBAL_CONVERSATION_KEY_BASE],
  );
  await Zotero.DB.queryAsync(
    `UPDATE ${CHAT_MESSAGES_TABLE}
     SET conversation_key = ?
     WHERE conversation_key = ?`,
    [targetKey, GLOBAL_CONVERSATION_KEY_BASE],
  );
}

async function backfillUpstreamConversationIDs(): Promise<void> {
  const globalRows = (await Zotero.DB.queryAsync(
    `SELECT conversation_key AS conversationKey,
            library_id AS libraryID
     FROM ${GLOBAL_CONVERSATIONS_TABLE}`,
  )) as Array<{ conversationKey?: unknown; libraryID?: unknown }> | undefined;
  for (const row of globalRows || []) {
    const conversationKey = normalizeConversationKey(
      Number(row.conversationKey),
    );
    const libraryID = normalizeLibraryID(Number(row.libraryID));
    if (!conversationKey || !libraryID) continue;
    const conversationID = buildUpstreamConversationID({
      conversationKey,
      kind: "global",
      libraryID,
    });
    await Zotero.DB.queryAsync(
      `UPDATE ${GLOBAL_CONVERSATIONS_TABLE}
       SET conversation_id = ?
       WHERE conversation_key = ?
         AND (conversation_id IS NULL OR TRIM(conversation_id) = '')`,
      [conversationID, conversationKey],
    );
    await Zotero.DB.queryAsync(
      `UPDATE ${CHAT_MESSAGES_TABLE}
       SET conversation_id = ?
       WHERE conversation_key = ?
         AND (conversation_id IS NULL OR TRIM(conversation_id) = '')`,
      [conversationID, conversationKey],
    );
  }

  const paperRows = (await Zotero.DB.queryAsync(
    `SELECT conversation_key AS conversationKey,
            library_id AS libraryID,
            paper_item_id AS paperItemID
     FROM ${PAPER_CONVERSATIONS_TABLE}`,
  )) as
    | Array<{
        conversationKey?: unknown;
        libraryID?: unknown;
        paperItemID?: unknown;
      }>
    | undefined;
  for (const row of paperRows || []) {
    const conversationKey = normalizeConversationKey(
      Number(row.conversationKey),
    );
    const libraryID = normalizeLibraryID(Number(row.libraryID));
    const paperItemID = normalizePaperItemID(Number(row.paperItemID));
    if (!conversationKey || !libraryID || !paperItemID) continue;
    const conversationID = buildUpstreamConversationID({
      conversationKey,
      kind: "paper",
      libraryID,
      paperItemID,
    });
    await Zotero.DB.queryAsync(
      `UPDATE ${PAPER_CONVERSATIONS_TABLE}
       SET conversation_id = ?
       WHERE conversation_key = ?
         AND (conversation_id IS NULL OR TRIM(conversation_id) = '')`,
      [conversationID, conversationKey],
    );
    await Zotero.DB.queryAsync(
      `UPDATE ${CHAT_MESSAGES_TABLE}
       SET conversation_id = ?
       WHERE conversation_key = ?
         AND (conversation_id IS NULL OR TRIM(conversation_id) = '')`,
      [conversationID, conversationKey],
    );
  }
}

async function backfillUpstreamConversationRegistry(): Promise<void> {
  const globalRows = (await Zotero.DB.queryAsync(
    `SELECT conversation_id AS conversationID,
            conversation_key AS conversationKey,
            library_id AS libraryID,
            created_at AS createdAt,
            title AS title
     FROM ${GLOBAL_CONVERSATIONS_TABLE}`,
  )) as
    | Array<{
        conversationID?: unknown;
        conversationKey?: unknown;
        libraryID?: unknown;
        createdAt?: unknown;
        title?: unknown;
      }>
    | undefined;
  for (const row of globalRows || []) {
    const conversationKey = normalizeConversationKey(
      Number(row.conversationKey),
    );
    const libraryID = normalizeLibraryID(Number(row.libraryID));
    if (!conversationKey || !libraryID) continue;
    await registerConversationScope({
      conversationID:
        typeof row.conversationID === "string" ? row.conversationID : undefined,
      conversationKey,
      system: "upstream",
      kind: "global",
      libraryID,
      createdAt: normalizeCatalogTimestamp(row.createdAt),
      updatedAt: normalizeCatalogTimestamp(row.createdAt),
      title: typeof row.title === "string" ? row.title : undefined,
    });
  }

  const paperRows = (await Zotero.DB.queryAsync(
    `SELECT conversation_id AS conversationID,
            conversation_key AS conversationKey,
            library_id AS libraryID,
            paper_item_id AS paperItemID,
            created_at AS createdAt,
            title AS title
     FROM ${PAPER_CONVERSATIONS_TABLE}`,
  )) as
    | Array<{
        conversationID?: unknown;
        conversationKey?: unknown;
        libraryID?: unknown;
        paperItemID?: unknown;
        createdAt?: unknown;
        title?: unknown;
      }>
    | undefined;
  for (const row of paperRows || []) {
    const conversationKey = normalizeConversationKey(
      Number(row.conversationKey),
    );
    const libraryID = normalizeLibraryID(Number(row.libraryID));
    const paperItemID = normalizePaperItemID(Number(row.paperItemID));
    if (!conversationKey || !libraryID || !paperItemID) continue;
    await registerConversationScope({
      conversationID:
        typeof row.conversationID === "string" ? row.conversationID : undefined,
      conversationKey,
      system: "upstream",
      kind: "paper",
      libraryID,
      paperItemID,
      createdAt: normalizeCatalogTimestamp(row.createdAt),
      updatedAt: normalizeCatalogTimestamp(row.createdAt),
      title: typeof row.title === "string" ? row.title : undefined,
    });
  }
}

export async function initChatStore(): Promise<void> {
  const conversationIDTransitionAlreadyApplied =
    await hasConversationSchemaMigration(
      CONVERSATION_ID_TRANSITION_MIGRATION_ID,
    );
  await Zotero.DB.executeTransaction(async () => {
    await initConversationRegistryStore();
    await migrateLegacyChatStore();

    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${CHAT_MESSAGES_TABLE} (
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
        forced_skill_ids_json TEXT,
        paper_contexts_json TEXT,
        full_text_paper_contexts_json TEXT,
        citation_paper_contexts_json TEXT,
        quote_citations_json TEXT,
        collection_contexts_json TEXT,
        tag_contexts_json TEXT,
        screenshot_images TEXT,
        attachments_json TEXT,
        model_attachments_json TEXT,
        generated_images_json TEXT,
        model_name TEXT,
        model_entry_id TEXT,
        model_provider_label TEXT,
        webchat_run_state TEXT,
        webchat_completion_reason TEXT,
        reasoning_summary TEXT,
        reasoning_details TEXT,
        context_tokens INTEGER,
        context_window INTEGER
      )`,
    );

    const columns = (await Zotero.DB.queryAsync(
      `PRAGMA table_info(${CHAT_MESSAGES_TABLE})`,
    )) as Array<{ name?: unknown }> | undefined;
    const messageColumns = new Set(
      (columns || [])
        .map((column) => (typeof column?.name === "string" ? column.name : ""))
        .filter(Boolean),
    );
    await ensureColumn(
      CHAT_MESSAGES_TABLE,
      messageColumns,
      "generated_images_json",
      "generated_images_json TEXT",
    );
    await ensureColumn(
      CHAT_MESSAGES_TABLE,
      messageColumns,
      "conversation_id",
      "conversation_id TEXT",
    );
    const hasModelNameColumn = Boolean(
      columns?.some((column) => column?.name === "model_name"),
    );
    if (!hasModelNameColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN model_name TEXT`,
      );
    }
    const hasModelEntryIdColumn = Boolean(
      columns?.some((column) => column?.name === "model_entry_id"),
    );
    if (!hasModelEntryIdColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN model_entry_id TEXT`,
      );
    }
    const hasModelProviderLabelColumn = Boolean(
      columns?.some((column) => column?.name === "model_provider_label"),
    );
    if (!hasModelProviderLabelColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN model_provider_label TEXT`,
      );
    }
    const hasWebchatRunStateColumn = Boolean(
      columns?.some((column) => column?.name === "webchat_run_state"),
    );
    if (!hasWebchatRunStateColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN webchat_run_state TEXT`,
      );
    }
    const hasWebchatCompletionReasonColumn = Boolean(
      columns?.some((column) => column?.name === "webchat_completion_reason"),
    );
    if (!hasWebchatCompletionReasonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN webchat_completion_reason TEXT`,
      );
    }
    const hasContextTokensColumn = Boolean(
      columns?.some((column) => column?.name === "context_tokens"),
    );
    if (!hasContextTokensColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN context_tokens INTEGER`,
      );
    }
    const hasContextWindowColumn = Boolean(
      columns?.some((column) => column?.name === "context_window"),
    );
    if (!hasContextWindowColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN context_window INTEGER`,
      );
    }
    const hasRunModeColumn = Boolean(
      columns?.some((column) => column?.name === "run_mode"),
    );
    if (!hasRunModeColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN run_mode TEXT`,
      );
    }
    const hasAgentRunIdColumn = Boolean(
      columns?.some((column) => column?.name === "agent_run_id"),
    );
    if (!hasAgentRunIdColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN agent_run_id TEXT`,
      );
    }
    const hasSelectedTextColumn = Boolean(
      columns?.some((column) => column?.name === "selected_text"),
    );
    if (!hasSelectedTextColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN selected_text TEXT`,
      );
    }
    const hasSelectedTextsJsonColumn = Boolean(
      columns?.some((column) => column?.name === "selected_texts_json"),
    );
    if (!hasSelectedTextsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN selected_texts_json TEXT`,
      );
    }
    const hasSelectedTextSourcesJsonColumn = Boolean(
      columns?.some((column) => column?.name === "selected_text_sources_json"),
    );
    if (!hasSelectedTextSourcesJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN selected_text_sources_json TEXT`,
      );
    }
    const hasSelectedTextPaperContextsJsonColumn = Boolean(
      columns?.some(
        (column) => column?.name === "selected_text_paper_contexts_json",
      ),
    );
    if (!hasSelectedTextPaperContextsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN selected_text_paper_contexts_json TEXT`,
      );
    }
    const hasSelectedTextNoteContextsJsonColumn = Boolean(
      columns?.some(
        (column) => column?.name === "selected_text_note_contexts_json",
      ),
    );
    if (!hasSelectedTextNoteContextsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN selected_text_note_contexts_json TEXT`,
      );
    }
    const hasPaperContextsJsonColumn = Boolean(
      columns?.some((column) => column?.name === "paper_contexts_json"),
    );
    await ensureColumn(
      CHAT_MESSAGES_TABLE,
      messageColumns,
      "forced_skill_ids_json",
      "forced_skill_ids_json TEXT",
    );
    if (!hasPaperContextsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN paper_contexts_json TEXT`,
      );
    }
    const hasFullTextPaperContextsJsonColumn = Boolean(
      columns?.some(
        (column) => column?.name === "full_text_paper_contexts_json",
      ),
    );
    if (!hasFullTextPaperContextsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN full_text_paper_contexts_json TEXT`,
      );
    }
    const hasCitationPaperContextsJsonColumn = Boolean(
      columns?.some(
        (column) => column?.name === "citation_paper_contexts_json",
      ),
    );
    if (!hasCitationPaperContextsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN citation_paper_contexts_json TEXT`,
      );
    }
    const hasCollectionContextsJsonColumn = Boolean(
      columns?.some((column) => column?.name === "collection_contexts_json"),
    );
    const hasQuoteCitationsJsonColumn = Boolean(
      columns?.some((column) => column?.name === "quote_citations_json"),
    );
    if (!hasQuoteCitationsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN quote_citations_json TEXT`,
      );
    }
    if (!hasCollectionContextsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN collection_contexts_json TEXT`,
      );
    }
    await ensureColumn(
      CHAT_MESSAGES_TABLE,
      messageColumns,
      "tag_contexts_json",
      "tag_contexts_json TEXT",
    );
    const hasScreenshotImagesColumn = Boolean(
      columns?.some((column) => column?.name === "screenshot_images"),
    );
    if (!hasScreenshotImagesColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN screenshot_images TEXT`,
      );
    }
    const hasAttachmentsJsonColumn = Boolean(
      columns?.some((column) => column?.name === "attachments_json"),
    );
    if (!hasAttachmentsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN attachments_json TEXT`,
      );
    }
    const hasModelAttachmentsJsonColumn = Boolean(
      columns?.some((column) => column?.name === "model_attachments_json"),
    );
    if (!hasModelAttachmentsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN model_attachments_json TEXT`,
      );
    }

    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${CHAT_MESSAGES_INDEX}
       ON ${CHAT_MESSAGES_TABLE} (conversation_key, timestamp, id)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${CHAT_MESSAGES_ID_INDEX}
       ON ${CHAT_MESSAGES_TABLE} (conversation_id, timestamp, id)`,
    );

    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${GLOBAL_CONVERSATIONS_TABLE} (
        conversation_id TEXT,
        conversation_key INTEGER PRIMARY KEY,
        library_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER,
        user_turn_count INTEGER NOT NULL DEFAULT 0,
        first_user_title TEXT,
        title TEXT
      )`,
    );

    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${GLOBAL_CONVERSATIONS_LIBRARY_INDEX}
       ON ${GLOBAL_CONVERSATIONS_TABLE} (library_id, created_at DESC, conversation_key DESC)`,
    );
    const globalColumns = await getTableColumns(GLOBAL_CONVERSATIONS_TABLE);
    await ensureColumn(
      GLOBAL_CONVERSATIONS_TABLE,
      globalColumns,
      "conversation_id",
      "conversation_id TEXT",
    );
    await ensureColumn(
      GLOBAL_CONVERSATIONS_TABLE,
      globalColumns,
      "last_activity_at",
      "last_activity_at INTEGER",
    );
    await ensureColumn(
      GLOBAL_CONVERSATIONS_TABLE,
      globalColumns,
      "user_turn_count",
      "user_turn_count INTEGER NOT NULL DEFAULT 0",
    );
    await ensureColumn(
      GLOBAL_CONVERSATIONS_TABLE,
      globalColumns,
      "first_user_title",
      "first_user_title TEXT",
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${GLOBAL_CONVERSATIONS_ACTIVITY_INDEX}
       ON ${GLOBAL_CONVERSATIONS_TABLE} (library_id, last_activity_at DESC, conversation_key DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${GLOBAL_CONVERSATIONS_ID_INDEX}
       ON ${GLOBAL_CONVERSATIONS_TABLE} (conversation_id)`,
    );

    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PAPER_CONVERSATIONS_TABLE} (
        conversation_id TEXT,
        conversation_key INTEGER PRIMARY KEY,
        library_id INTEGER NOT NULL,
        paper_item_id INTEGER NOT NULL,
        session_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER,
        user_turn_count INTEGER NOT NULL DEFAULT 0,
        first_user_title TEXT,
        title TEXT,
        UNIQUE(paper_item_id, session_version)
      )`,
    );

    const paperColumns = (await Zotero.DB.queryAsync(
      `PRAGMA table_info(${PAPER_CONVERSATIONS_TABLE})`,
    )) as Array<{ name?: unknown }> | undefined;
    const hasPaperTitleColumn = Boolean(
      paperColumns?.some((column) => column?.name === "title"),
    );
    if (!hasPaperTitleColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${PAPER_CONVERSATIONS_TABLE}
         ADD COLUMN title TEXT`,
      );
    }

    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${PAPER_CONVERSATIONS_PAPER_INDEX}
       ON ${PAPER_CONVERSATIONS_TABLE} (paper_item_id, library_id, session_version, created_at DESC, conversation_key DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${PAPER_CONVERSATIONS_CONVERSATION_INDEX}
       ON ${PAPER_CONVERSATIONS_TABLE} (conversation_key, paper_item_id, session_version)`,
    );
    const paperColumnSet = await getTableColumns(PAPER_CONVERSATIONS_TABLE);
    await ensureColumn(
      PAPER_CONVERSATIONS_TABLE,
      paperColumnSet,
      "conversation_id",
      "conversation_id TEXT",
    );
    await ensureColumn(
      PAPER_CONVERSATIONS_TABLE,
      paperColumnSet,
      "last_activity_at",
      "last_activity_at INTEGER",
    );
    await ensureColumn(
      PAPER_CONVERSATIONS_TABLE,
      paperColumnSet,
      "user_turn_count",
      "user_turn_count INTEGER NOT NULL DEFAULT 0",
    );
    await ensureColumn(
      PAPER_CONVERSATIONS_TABLE,
      paperColumnSet,
      "first_user_title",
      "first_user_title TEXT",
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${PAPER_CONVERSATIONS_PAPER_ACTIVITY_INDEX}
       ON ${PAPER_CONVERSATIONS_TABLE} (library_id, paper_item_id, last_activity_at DESC, conversation_key DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${PAPER_CONVERSATIONS_LIBRARY_ACTIVITY_INDEX}
       ON ${PAPER_CONVERSATIONS_TABLE} (library_id, last_activity_at DESC, conversation_key DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${PAPER_CONVERSATIONS_ID_INDEX}
       ON ${PAPER_CONVERSATIONS_TABLE} (conversation_id)`,
    );

    if (!conversationIDTransitionAlreadyApplied) {
      await reconcileConversationCatalogs();
      await migrateSharedGlobalDefaultConversationKey();
      await backfillUpstreamConversationIDs();
      await backfillUpstreamConversationRegistry();
      await refreshUpstreamConversationCatalogSummary();
    }
  });
}

export async function loadConversation(
  conversationKey: number,
  limit: number,
): Promise<StoredChatMessage[]> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamStoreConversationKey(normalizedKey))
    return [];

  const normalizedLimit = normalizeLimit(limit, 200);
  const selector =
    await resolveRepairingMessageConversationSelector(normalizedKey);
  let rows = (await Zotero.DB.queryAsync(
    buildLatestStoredMessagesQuery({
      tableName: CHAT_MESSAGES_TABLE,
      selectColumnsSql: CHAT_MESSAGE_SELECT_COLUMNS_SQL,
      whereSql: selector.whereSql,
    }),
    [...selector.params, normalizedLimit],
  )) as
    | Array<{
        role: unknown;
        text: unknown;
        timestamp: unknown;
        selectedText?: unknown;
        runMode?: unknown;
        agentRunId?: unknown;
        selectedTextsJson?: unknown;
        selectedTextSourcesJson?: unknown;
        selectedTextPaperContextsJson?: unknown;
        selectedTextNoteContextsJson?: unknown;
        forcedSkillIdsJson?: unknown;
        paperContextsJson?: unknown;
        fullTextPaperContextsJson?: unknown;
        citationPaperContextsJson?: unknown;
        quoteCitationsJson?: unknown;
        collectionContextsJson?: unknown;
        tagContextsJson?: unknown;
        screenshotImages?: unknown;
        attachmentsJson?: unknown;
        modelAttachmentsJson?: unknown;
        generatedImagesJson?: unknown;
        modelName?: unknown;
        modelEntryId?: unknown;
        modelProviderLabel?: unknown;
        webchatRunState?: unknown;
        webchatCompletionReason?: unknown;
        reasoningSummary?: unknown;
        reasoningDetails?: unknown;
        contextTokens?: unknown;
        contextWindow?: unknown;
      }>
    | undefined;

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

    const timestamp = Number(row.timestamp);
    let selectedTexts: string[] | undefined;
    if (typeof row.selectedTextsJson === "string" && row.selectedTextsJson) {
      try {
        const parsed = JSON.parse(row.selectedTextsJson) as unknown;
        if (Array.isArray(parsed)) {
          const normalized = parsed.filter(
            (entry): entry is string =>
              typeof entry === "string" && Boolean(entry.trim()),
          );
          if (normalized.length) {
            selectedTexts = normalized;
          }
        }
      } catch (_err) {
        selectedTexts = undefined;
      }
    }
    let selectedTextSources: SelectedTextSource[] | undefined;
    if (
      typeof row.selectedTextSourcesJson === "string" &&
      row.selectedTextSourcesJson
    ) {
      try {
        const parsed = JSON.parse(row.selectedTextSourcesJson) as unknown;
        if (Array.isArray(parsed)) {
          selectedTextSources = parsed.map((entry) =>
            normalizeSelectedTextSource(entry),
          );
        }
      } catch (_err) {
        selectedTextSources = undefined;
      }
    }
    const normalizedTexts = selectedTexts?.length
      ? selectedTexts
      : typeof row.selectedText === "string" && row.selectedText.trim()
        ? [row.selectedText]
        : [];
    let selectedTextPaperContexts: (PaperContextRef | undefined)[] | undefined;
    if (
      typeof row.selectedTextPaperContextsJson === "string" &&
      row.selectedTextPaperContextsJson
    ) {
      try {
        const parsed = JSON.parse(row.selectedTextPaperContextsJson) as unknown;
        const normalized = normalizeSelectedTextPaperContexts(
          parsed,
          normalizedTexts.length,
        );
        if (normalized.some((entry) => Boolean(entry))) {
          selectedTextPaperContexts = normalized;
        }
      } catch (_err) {
        selectedTextPaperContexts = undefined;
      }
    }
    let selectedTextNoteContexts: (NoteContextRef | undefined)[] | undefined;
    if (
      typeof row.selectedTextNoteContextsJson === "string" &&
      row.selectedTextNoteContextsJson
    ) {
      try {
        const parsed = JSON.parse(row.selectedTextNoteContextsJson) as unknown;
        const normalized = normalizeSelectedTextNoteContexts(
          parsed,
          normalizedTexts.length,
        );
        if (normalized.some((entry) => Boolean(entry))) {
          selectedTextNoteContexts = normalized;
        }
      } catch (_err) {
        selectedTextNoteContexts = undefined;
      }
    }
    let paperContexts: PaperContextRef[] | undefined;
    if (typeof row.paperContextsJson === "string" && row.paperContextsJson) {
      try {
        const parsed = JSON.parse(row.paperContextsJson) as unknown;
        const normalized = normalizePaperContextRefs(parsed);
        if (normalized.length) {
          paperContexts = normalized;
        }
      } catch (_err) {
        paperContexts = undefined;
      }
    }
    let fullTextPaperContexts: PaperContextRef[] | undefined;
    if (
      typeof row.fullTextPaperContextsJson === "string" &&
      row.fullTextPaperContextsJson
    ) {
      try {
        const parsed = JSON.parse(row.fullTextPaperContextsJson) as unknown;
        const normalized = normalizePaperContextRefs(parsed);
        if (normalized.length) {
          fullTextPaperContexts = normalized;
        }
      } catch (_err) {
        fullTextPaperContexts = undefined;
      }
    }
    let citationPaperContexts: PaperContextRef[] | undefined;
    if (
      typeof row.citationPaperContextsJson === "string" &&
      row.citationPaperContextsJson
    ) {
      try {
        const parsed = JSON.parse(row.citationPaperContextsJson) as unknown;
        const normalized = normalizePaperContextRefs(parsed);
        if (normalized.length) {
          citationPaperContexts = normalized;
        }
      } catch (_err) {
        citationPaperContexts = undefined;
      }
    }
    let quoteCitations: QuoteCitation[] | undefined;
    if (typeof row.quoteCitationsJson === "string" && row.quoteCitationsJson) {
      try {
        const parsed = JSON.parse(row.quoteCitationsJson) as unknown;
        const normalized = normalizeQuoteCitations(parsed);
        if (normalized.length) {
          quoteCitations = normalized;
        }
      } catch (_err) {
        quoteCitations = undefined;
      }
    }
    let selectedCollectionContexts: CollectionContextRef[] | undefined;
    if (
      typeof row.collectionContextsJson === "string" &&
      row.collectionContextsJson
    ) {
      try {
        const parsed = JSON.parse(row.collectionContextsJson) as unknown;
        const normalized = normalizeCollectionContextRefs(parsed);
        if (normalized.length) {
          selectedCollectionContexts = normalized;
        }
      } catch (_err) {
        selectedCollectionContexts = undefined;
      }
    }
    let selectedTagContexts: TagContextRef[] | undefined;
    if (typeof row.tagContextsJson === "string" && row.tagContextsJson) {
      try {
        const parsed = JSON.parse(row.tagContextsJson) as unknown;
        const normalized = normalizeTagContextRefs(parsed);
        if (normalized.length) {
          selectedTagContexts = normalized;
        }
      } catch (_err) {
        selectedTagContexts = undefined;
      }
    }
    let screenshotImages: string[] | undefined;
    if (typeof row.screenshotImages === "string" && row.screenshotImages) {
      try {
        const parsed = JSON.parse(row.screenshotImages) as unknown;
        if (Array.isArray(parsed)) {
          const normalized = parsed.filter(
            (entry): entry is string =>
              typeof entry === "string" && Boolean(entry.trim()),
          );
          if (normalized.length) {
            screenshotImages = normalized;
          }
        }
      } catch (_err) {
        screenshotImages = undefined;
      }
    }
    let attachments = parseStoredAttachmentsJson(row.attachmentsJson);
    const modelAttachments = parseStoredAttachmentsJson(
      row.modelAttachmentsJson,
      { preserveEmpty: true },
    );
    let generatedImages: GeneratedChatImage[] | undefined;
    if (
      typeof row.generatedImagesJson === "string" &&
      row.generatedImagesJson
    ) {
      try {
        const normalized = normalizeGeneratedChatImages(
          JSON.parse(row.generatedImagesJson) as unknown,
        );
        if (normalized.length) generatedImages = normalized;
      } catch (_err) {
        generatedImages = undefined;
      }
    }
    if (!attachments?.length && screenshotImages?.length) {
      attachments = screenshotImages.map((url, index) => ({
        id: `legacy-screenshot-${index + 1}`,
        name: `Screenshot ${index + 1}.png`,
        mimeType: "image/png",
        sizeBytes: 0,
        category: "image" as const,
        imageDataUrl: url,
      }));
    }
    const forcedSkillIds = parseForcedSkillIdsJson(row.forcedSkillIdsJson);
    messages.push({
      role,
      text: typeof row.text === "string" ? row.text : "",
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      runMode:
        row.runMode === "agent"
          ? "agent"
          : row.runMode === "chat"
            ? "chat"
            : undefined,
      agentRunId:
        typeof row.agentRunId === "string" && row.agentRunId.trim()
          ? row.agentRunId.trim()
          : undefined,
      selectedText:
        typeof row.selectedText === "string" ? row.selectedText : undefined,
      selectedTexts: normalizedTexts.length ? normalizedTexts : undefined,
      selectedTextSources: (() => {
        if (!normalizedTexts.length) return undefined;
        return normalizedTexts.map((_, index) =>
          normalizeSelectedTextSource(selectedTextSources?.[index]),
        );
      })(),
      selectedTextPaperContexts,
      selectedTextNoteContexts,
      forcedSkillIds:
        role === "user" && forcedSkillIds.length ? forcedSkillIds : undefined,
      paperContexts,
      fullTextPaperContexts,
      citationPaperContexts,
      quoteCitations,
      selectedCollectionContexts,
      selectedTagContexts,
      screenshotImages,
      attachments,
      modelAttachments,
      generatedImages,
      modelName: typeof row.modelName === "string" ? row.modelName : undefined,
      modelEntryId:
        typeof row.modelEntryId === "string" ? row.modelEntryId : undefined,
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
          : undefined,
      reasoningSummary:
        typeof row.reasoningSummary === "string"
          ? row.reasoningSummary
          : undefined,
      reasoningDetails:
        typeof row.reasoningDetails === "string"
          ? row.reasoningDetails
          : undefined,
      contextTokens: Number.isFinite(Number(row.contextTokens))
        ? Math.floor(Number(row.contextTokens))
        : undefined,
      contextWindow: Number.isFinite(Number(row.contextWindow))
        ? Math.floor(Number(row.contextWindow))
        : undefined,
    });
  }

  return messages;
}

export async function appendMessage(
  conversationKey: number,
  message: StoredChatMessage,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamStoreConversationKey(normalizedKey)) return;

  const timestamp = Number(message.timestamp);
  const selectedTexts = Array.isArray(message.selectedTexts)
    ? message.selectedTexts
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : typeof message.selectedText === "string" && message.selectedText.trim()
      ? [message.selectedText.trim()]
      : [];
  const selectedTextSources = selectedTexts.map((_, index) =>
    normalizeSelectedTextSource(message.selectedTextSources?.[index]),
  );
  const selectedTextPaperContexts = normalizeSelectedTextPaperContexts(
    message.selectedTextPaperContexts,
    selectedTexts.length,
  );
  const selectedTextNoteContexts = normalizeSelectedTextNoteContexts(
    message.selectedTextNoteContexts,
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
  const selectedCollectionContexts = normalizeCollectionContextRefs(
    message.selectedCollectionContexts,
  );
  const selectedTagContexts = normalizeTagContextRefs(
    message.selectedTagContexts,
  );
  const screenshotImages = Array.isArray(message.screenshotImages)
    ? message.screenshotImages.filter((entry) => Boolean(entry))
    : [];
  const attachments = normalizeStoredAttachments(message.attachments);
  const hasExplicitModelAttachments = Object.prototype.hasOwnProperty.call(
    message,
    "modelAttachments",
  );
  const modelAttachments = normalizeStoredAttachments(message.modelAttachments);
  const generatedImages = normalizeGeneratedChatImages(message.generatedImages);
  const conversationID = await resolveRegisteredConversationID(normalizedKey);
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `INSERT INTO ${CHAT_MESSAGES_TABLE}
        (conversation_id, conversation_key, role, text, timestamp, run_mode, agent_run_id, selected_text, selected_texts_json, selected_text_sources_json, selected_text_paper_contexts_json, selected_text_note_contexts_json, forced_skill_ids_json, paper_contexts_json, full_text_paper_contexts_json, citation_paper_contexts_json, quote_citations_json, collection_contexts_json, tag_contexts_json, screenshot_images, attachments_json, model_attachments_json, generated_images_json, model_name, model_entry_id, model_provider_label, webchat_run_state, webchat_completion_reason, reasoning_summary, reasoning_details, context_tokens, context_window)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        conversationID,
        normalizedKey,
        message.role,
        message.text,
        Number.isFinite(timestamp) ? Math.floor(timestamp) : Date.now(),
        message.runMode || null,
        message.agentRunId || null,
        selectedTexts[0] || message.selectedText || null,
        selectedTexts.length ? JSON.stringify(selectedTexts) : null,
        selectedTextSources.length ? JSON.stringify(selectedTextSources) : null,
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
        selectedTagContexts.length ? JSON.stringify(selectedTagContexts) : null,
        screenshotImages.length ? JSON.stringify(screenshotImages) : null,
        attachments.length ? JSON.stringify(attachments) : null,
        hasExplicitModelAttachments ? JSON.stringify(modelAttachments) : null,
        generatedImages.length ? JSON.stringify(generatedImages) : null,
        message.modelName || null,
        message.modelEntryId || null,
        message.modelProviderLabel || null,
        message.webchatRunState || null,
        message.webchatCompletionReason || null,
        message.reasoningSummary || null,
        message.reasoningDetails || null,
        Number.isFinite(Number(message.contextTokens))
          ? Math.floor(Number(message.contextTokens))
          : null,
        Number.isFinite(Number(message.contextWindow))
          ? Math.floor(Number(message.contextWindow))
          : null,
      ],
    );
    await refreshUpstreamConversationCatalogSummary(normalizedKey);
  });
  await refreshUpstreamConversationSearchIndex(normalizedKey);
}

export async function updateLatestUserMessage(
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
    | "forcedSkillIds"
    | "paperContexts"
    | "fullTextPaperContexts"
    | "citationPaperContexts"
    | "selectedCollectionContexts"
    | "selectedTagContexts"
    | "screenshotImages"
    | "attachments"
    | "modelAttachments"
    | "generatedImages"
    | "modelName"
    | "modelEntryId"
    | "modelProviderLabel"
  >,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamStoreConversationKey(normalizedKey)) return;

  const timestamp = Number(message.timestamp);
  const selectedTexts = Array.isArray(message.selectedTexts)
    ? message.selectedTexts
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : typeof message.selectedText === "string" && message.selectedText.trim()
      ? [message.selectedText.trim()]
      : [];
  const selectedTextSources = selectedTexts.map((_, index) =>
    normalizeSelectedTextSource(message.selectedTextSources?.[index]),
  );
  const selectedTextPaperContexts = normalizeSelectedTextPaperContexts(
    message.selectedTextPaperContexts,
    selectedTexts.length,
  );
  const selectedTextNoteContexts = normalizeSelectedTextNoteContexts(
    message.selectedTextNoteContexts,
    selectedTexts.length,
  );
  const paperContexts = normalizePaperContextRefs(message.paperContexts);
  const fullTextPaperContexts = normalizePaperContextRefs(
    message.fullTextPaperContexts,
  );
  const citationPaperContexts = normalizePaperContextRefs(
    message.citationPaperContexts,
  );
  const selectedCollectionContexts = normalizeCollectionContextRefs(
    message.selectedCollectionContexts,
  );
  const selectedTagContexts = normalizeTagContextRefs(
    message.selectedTagContexts,
  );
  const screenshotImages = Array.isArray(message.screenshotImages)
    ? message.screenshotImages.filter((entry) => Boolean(entry))
    : [];
  const attachments = normalizeStoredAttachments(message.attachments);
  const hasExplicitModelAttachments = Object.prototype.hasOwnProperty.call(
    message,
    "modelAttachments",
  );
  const modelAttachments = normalizeStoredAttachments(message.modelAttachments);
  const generatedImages = normalizeGeneratedChatImages(message.generatedImages);
  const selector =
    await resolveRepairingMessageConversationSelector(normalizedKey);

  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `UPDATE ${CHAT_MESSAGES_TABLE}
       SET text = ?,
           timestamp = ?,
           run_mode = ?,
           agent_run_id = ?,
           selected_text = ?,
           selected_texts_json = ?,
           selected_text_sources_json = ?,
           selected_text_paper_contexts_json = ?,
           selected_text_note_contexts_json = ?,
           forced_skill_ids_json = ?,
           paper_contexts_json = ?,
           full_text_paper_contexts_json = ?,
           citation_paper_contexts_json = ?,
           collection_contexts_json = ?,
           tag_contexts_json = ?,
           screenshot_images = ?,
           attachments_json = ?,
           model_attachments_json = ?,
           generated_images_json = ?,
           model_name = ?,
           model_entry_id = ?,
           model_provider_label = ?
       WHERE id = (
         SELECT id
         FROM ${CHAT_MESSAGES_TABLE}
         WHERE ${selector.whereSql} AND role = 'user'
         ORDER BY timestamp DESC, id DESC
         LIMIT 1
       )`,
      [
        message.text || "",
        Number.isFinite(timestamp) ? Math.floor(timestamp) : Date.now(),
        message.runMode || null,
        message.agentRunId || null,
        selectedTexts[0] || message.selectedText || null,
        selectedTexts.length ? JSON.stringify(selectedTexts) : null,
        selectedTextSources.length ? JSON.stringify(selectedTextSources) : null,
        selectedTextPaperContexts.some((entry) => Boolean(entry))
          ? JSON.stringify(selectedTextPaperContexts)
          : null,
        selectedTextNoteContexts.some((entry) => Boolean(entry))
          ? JSON.stringify(selectedTextNoteContexts)
          : null,
        serializeForcedSkillIds(message.forcedSkillIds),
        paperContexts.length ? JSON.stringify(paperContexts) : null,
        fullTextPaperContexts.length
          ? JSON.stringify(fullTextPaperContexts)
          : null,
        citationPaperContexts.length
          ? JSON.stringify(citationPaperContexts)
          : null,
        selectedCollectionContexts.length
          ? JSON.stringify(selectedCollectionContexts)
          : null,
        selectedTagContexts.length ? JSON.stringify(selectedTagContexts) : null,
        screenshotImages.length ? JSON.stringify(screenshotImages) : null,
        attachments.length ? JSON.stringify(attachments) : null,
        hasExplicitModelAttachments ? JSON.stringify(modelAttachments) : null,
        generatedImages.length ? JSON.stringify(generatedImages) : null,
        message.modelName || null,
        message.modelEntryId || null,
        message.modelProviderLabel || null,
        ...selector.params,
      ],
    );
    await refreshUpstreamConversationCatalogSummary(normalizedKey);
  });
  await refreshUpstreamConversationSearchIndex(normalizedKey);
}

export async function updateLatestAssistantMessage(
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
  if (!normalizedKey || !isUpstreamStoreConversationKey(normalizedKey)) return;

  const timestamp = Number(message.timestamp);
  const quoteCitations = normalizeQuoteCitations(message.quoteCitations);
  const generatedImages = normalizeGeneratedChatImages(message.generatedImages);
  const selector =
    await resolveRepairingMessageConversationSelector(normalizedKey);
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `UPDATE ${CHAT_MESSAGES_TABLE}
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
           quote_citations_json = ?,
           generated_images_json = ?,
           context_tokens = ?,
           context_window = ?
       WHERE id = (
         SELECT id
         FROM ${CHAT_MESSAGES_TABLE}
         WHERE ${selector.whereSql} AND role = 'assistant'
         ORDER BY timestamp DESC, id DESC
         LIMIT 1
       )`,
      [
        message.text || "",
        Number.isFinite(timestamp) ? Math.floor(timestamp) : Date.now(),
        message.runMode || null,
        message.agentRunId || null,
        message.modelName || null,
        message.modelEntryId || null,
        message.modelProviderLabel || null,
        message.webchatRunState || null,
        message.webchatCompletionReason || null,
        message.reasoningSummary || null,
        message.reasoningDetails || null,
        quoteCitations.length ? JSON.stringify(quoteCitations) : null,
        generatedImages.length ? JSON.stringify(generatedImages) : null,
        Number.isFinite(Number(message.contextTokens))
          ? Math.floor(Number(message.contextTokens))
          : null,
        Number.isFinite(Number(message.contextWindow))
          ? Math.floor(Number(message.contextWindow))
          : null,
        ...selector.params,
      ],
    );
    await refreshUpstreamConversationCatalogSummary(normalizedKey);
  });
  await refreshUpstreamConversationSearchIndex(normalizedKey);
}

export async function clearConversation(
  conversationKey: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamStoreConversationKey(normalizedKey)) return;

  const selector = await resolveRepairingMessageConversationSelector(
    normalizedKey,
    {
      destructive: true,
    },
  );
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CHAT_MESSAGES_TABLE}
       WHERE ${selector.whereSql}`,
      selector.params,
    );
    await refreshUpstreamConversationCatalogSummary(normalizedKey);
  });
  await refreshUpstreamConversationSearchIndex(normalizedKey);
}

export async function deleteTurnMessages(
  conversationKey: number,
  userTimestamp: number,
  assistantTimestamp: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamStoreConversationKey(normalizedKey)) return;
  const normalizedUserTimestamp = Number.isFinite(userTimestamp)
    ? Math.floor(userTimestamp)
    : 0;
  const normalizedAssistantTimestamp = Number.isFinite(assistantTimestamp)
    ? Math.floor(assistantTimestamp)
    : 0;
  if (normalizedUserTimestamp <= 0 || normalizedAssistantTimestamp <= 0) return;

  const selector = await resolveRepairingMessageConversationSelector(
    normalizedKey,
    {
      destructive: true,
    },
  );
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CHAT_MESSAGES_TABLE}
       WHERE id = (
         SELECT id
         FROM ${CHAT_MESSAGES_TABLE}
         WHERE ${selector.whereSql}
           AND role = 'user'
           AND timestamp = ?
         ORDER BY id DESC
         LIMIT 1
       )`,
      [...selector.params, normalizedUserTimestamp],
    );
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CHAT_MESSAGES_TABLE}
       WHERE id = (
         SELECT id
         FROM ${CHAT_MESSAGES_TABLE}
         WHERE ${selector.whereSql}
           AND role = 'assistant'
           AND timestamp = ?
         ORDER BY id DESC
         LIMIT 1
       )`,
      [...selector.params, normalizedAssistantTimestamp],
    );
    await refreshUpstreamConversationCatalogSummary(normalizedKey);
  });
  await refreshUpstreamConversationSearchIndex(normalizedKey);
}

export async function pruneConversation(
  conversationKey: number,
  keep: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamStoreConversationKey(normalizedKey)) return;

  const normalizedKeep = Number.isFinite(keep) ? Math.floor(keep) : 200;
  if (normalizedKeep <= 0) {
    await clearConversation(normalizedKey);
    return;
  }

  const selector = await resolveRepairingMessageConversationSelector(
    normalizedKey,
    {
      destructive: true,
    },
  );
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CHAT_MESSAGES_TABLE}
       WHERE id IN (
         SELECT id
         FROM ${CHAT_MESSAGES_TABLE}
         WHERE ${selector.whereSql}
         ORDER BY ${storedMessageDisplayOrderSql({ direction: "desc" })}
         LIMIT -1 OFFSET ?
      )`,
      [...selector.params, normalizedKeep],
    );
    await refreshUpstreamConversationCatalogSummary(normalizedKey);
  });
  await refreshUpstreamConversationSearchIndex(normalizedKey);
}

type GlobalConversationSummaryRow = {
  conversationID?: unknown;
  conversationKey?: unknown;
  libraryID?: unknown;
  createdAt?: unknown;
  title?: unknown;
  lastActivityAt?: unknown;
  userTurnCount?: unknown;
};

function toGlobalConversationSummary(
  row: GlobalConversationSummaryRow,
): GlobalConversationSummary | null {
  const conversationKey = normalizeConversationKey(Number(row.conversationKey));
  const libraryID = normalizeLibraryID(Number(row.libraryID));
  const createdAt = Number(row.createdAt);
  const lastActivityAt = Number(row.lastActivityAt);
  const userTurnCount = Number(row.userTurnCount);
  if (!conversationKey || !libraryID || !Number.isFinite(createdAt)) {
    return null;
  }
  return {
    conversationID:
      typeof row.conversationID === "string" && row.conversationID.trim()
        ? row.conversationID.trim()
        : buildUpstreamConversationID({
            conversationKey,
            kind: "global",
            libraryID,
          }),
    conversationKey,
    libraryID,
    createdAt: Math.floor(createdAt),
    title:
      typeof row.title === "string" && row.title.trim()
        ? row.title.trim()
        : undefined,
    lastActivityAt: Number.isFinite(lastActivityAt)
      ? Math.floor(lastActivityAt)
      : Math.floor(createdAt),
    userTurnCount: Number.isFinite(userTurnCount)
      ? Math.max(0, Math.floor(userTurnCount))
      : 0,
  };
}

type PaperConversationSummaryRow = {
  conversationID?: unknown;
  conversationKey?: unknown;
  libraryID?: unknown;
  paperItemID?: unknown;
  sessionVersion?: unknown;
  createdAt?: unknown;
  title?: unknown;
  lastActivityAt?: unknown;
  userTurnCount?: unknown;
};

function toPaperConversationSummary(
  row: PaperConversationSummaryRow,
): PaperConversationSummary | null {
  const conversationKey = normalizeConversationKey(Number(row.conversationKey));
  const libraryID = normalizeLibraryID(Number(row.libraryID));
  const paperItemID = normalizePaperItemID(Number(row.paperItemID));
  const sessionVersion = normalizeSessionVersion(Number(row.sessionVersion));
  const createdAt = Number(row.createdAt);
  const lastActivityAt = Number(row.lastActivityAt);
  const userTurnCount = Number(row.userTurnCount);
  if (
    !conversationKey ||
    !libraryID ||
    !paperItemID ||
    !sessionVersion ||
    !Number.isFinite(createdAt)
  ) {
    return null;
  }
  return {
    conversationID:
      typeof row.conversationID === "string" && row.conversationID.trim()
        ? row.conversationID.trim()
        : buildUpstreamConversationID({
            conversationKey,
            kind: "paper",
            libraryID,
            paperItemID,
          }),
    conversationKey,
    libraryID,
    paperItemID,
    sessionVersion,
    createdAt: Math.floor(createdAt),
    title:
      typeof row.title === "string" && row.title.trim()
        ? row.title.trim()
        : undefined,
    lastActivityAt: Number.isFinite(lastActivityAt)
      ? Math.floor(lastActivityAt)
      : Math.floor(createdAt),
    userTurnCount: Number.isFinite(userTurnCount)
      ? Math.max(0, Math.floor(userTurnCount))
      : 0,
  };
}

async function resolveNextPaperConversationKey(): Promise<number> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT MAX(conversation_key) AS maxConversationKey
     FROM ${PAPER_CONVERSATIONS_TABLE}
     WHERE conversation_key >= ?
       AND conversation_key < ?`,
    [PAPER_CONVERSATION_KEY_BASE, GLOBAL_CONVERSATION_KEY_BASE],
  )) as Array<{ maxConversationKey?: unknown }> | undefined;
  const maxConversationKey = Number(rows?.[0]?.maxConversationKey);
  const next = Number.isFinite(maxConversationKey)
    ? Math.max(PAPER_CONVERSATION_KEY_BASE, Math.floor(maxConversationKey) + 1)
    : PAPER_CONVERSATION_KEY_BASE;
  return next;
}

async function findLowestMissingPaperSessionVersion(
  paperItemID: number,
): Promise<number> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT session_version AS sessionVersion
     FROM ${PAPER_CONVERSATIONS_TABLE}
     WHERE paper_item_id = ?
     ORDER BY session_version ASC`,
    [paperItemID],
  )) as Array<{ sessionVersion?: unknown }> | undefined;
  const used = new Set<number>();
  for (const row of rows || []) {
    const normalized = normalizeSessionVersion(Number(row.sessionVersion));
    if (!normalized) continue;
    used.add(normalized);
  }
  let candidate = 1;
  while (used.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

export async function ensurePaperV1Conversation(
  libraryID: number,
  paperItemID: number,
): Promise<PaperConversationSummary | null> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  const normalizedPaperItemID = normalizePaperItemID(paperItemID);
  if (!normalizedLibraryID || !normalizedPaperItemID) return null;
  const createdAt = Date.now();
  const conversationID = buildUpstreamConversationID({
    conversationKey: normalizedPaperItemID,
    kind: "paper",
    libraryID: normalizedLibraryID,
    paperItemID: normalizedPaperItemID,
  });
  await Zotero.DB.queryAsync(
    `INSERT OR IGNORE INTO ${PAPER_CONVERSATIONS_TABLE}
      (conversation_id, conversation_key, library_id, paper_item_id, session_version, created_at, last_activity_at, user_turn_count, first_user_title, title)
     VALUES (?, ?, ?, ?, 1, ?, ?, 0, NULL, NULL)`,
    [
      conversationID,
      normalizedPaperItemID,
      normalizedLibraryID,
      normalizedPaperItemID,
      createdAt,
      createdAt,
    ],
  );
  await registerConversationScope({
    conversationID,
    conversationKey: normalizedPaperItemID,
    system: "upstream",
    kind: "paper",
    libraryID: normalizedLibraryID,
    paperItemID: normalizedPaperItemID,
    createdAt,
    updatedAt: createdAt,
  });
  return await getPaperConversation(normalizedPaperItemID);
}

export async function createPaperConversation(
  libraryID: number,
  paperItemID: number,
): Promise<PaperConversationSummary | null> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  const normalizedPaperItemID = normalizePaperItemID(paperItemID);
  if (!normalizedLibraryID || !normalizedPaperItemID) return null;
  return await Zotero.DB.executeTransaction(async () => {
    const nextVersion = await findLowestMissingPaperSessionVersion(
      normalizedPaperItemID,
    );
    const createdAt = Date.now();
    const nextConversationKey =
      nextVersion === 1
        ? normalizedPaperItemID
        : await resolveNextPaperConversationKey();
    const conversationID = buildUpstreamConversationID({
      conversationKey: nextConversationKey,
      kind: "paper",
      libraryID: normalizedLibraryID,
      paperItemID: normalizedPaperItemID,
    });
    await Zotero.DB.queryAsync(
      `INSERT INTO ${PAPER_CONVERSATIONS_TABLE}
        (conversation_id, conversation_key, library_id, paper_item_id, session_version, created_at, last_activity_at, user_turn_count, first_user_title, title)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)`,
      [
        conversationID,
        nextConversationKey,
        normalizedLibraryID,
        normalizedPaperItemID,
        nextVersion,
        createdAt,
        createdAt,
      ],
    );
    await registerConversationScope({
      conversationID,
      conversationKey: nextConversationKey,
      system: "upstream",
      kind: "paper",
      libraryID: normalizedLibraryID,
      paperItemID: normalizedPaperItemID,
      createdAt,
      updatedAt: createdAt,
    });
    return await getPaperConversation(nextConversationKey);
  });
}

export async function listPaperConversations(
  libraryID: number,
  paperItemID: number,
  limit: number,
  includeEmpty = true,
): Promise<PaperConversationSummary[]> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  const normalizedPaperItemID = normalizePaperItemID(paperItemID);
  if (!normalizedLibraryID || !normalizedPaperItemID) return [];
  const normalizedLimit = normalizeLimit(limit, 50);

  const rows = (await Zotero.DB.queryAsync(
    `SELECT pc.conversation_id AS conversationID,
            pc.conversation_key AS conversationKey,
            pc.library_id AS libraryID,
            pc.paper_item_id AS paperItemID,
            pc.session_version AS sessionVersion,
            pc.created_at AS createdAt,
            COALESCE(NULLIF(TRIM(pc.title), ''), NULLIF(TRIM(pc.first_user_title), '')) AS title,
            COALESCE(pc.last_activity_at, pc.created_at) AS lastActivityAt,
            COALESCE(pc.user_turn_count, 0) AS userTurnCount
     FROM ${PAPER_CONVERSATIONS_TABLE} pc
     WHERE pc.library_id = ?
       AND pc.paper_item_id = ?
       ${includeEmpty ? "" : "AND COALESCE(pc.user_turn_count, 0) > 0"}
     ORDER BY lastActivityAt DESC, pc.conversation_key DESC
     LIMIT ?`,
    [normalizedLibraryID, normalizedPaperItemID, normalizedLimit],
  )) as PaperConversationSummaryRow[] | undefined;

  if (!rows?.length) return [];
  const out: PaperConversationSummary[] = [];
  for (const row of rows) {
    const normalized = toPaperConversationSummary(row);
    if (!normalized) continue;
    out.push(normalized);
  }
  return out;
}

/**
 * List all paper conversations across all papers for a given library.
 * Unlike listPaperConversations, this does NOT filter by paperItemID.
 */
export async function listAllPaperConversationsByLibrary(
  libraryID: number,
  limit: number | null,
): Promise<PaperConversationSummary[]> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  if (!normalizedLibraryID) return [];
  const normalizedLimit = normalizeOptionalLimit(limit);
  const params: unknown[] = [normalizedLibraryID];
  if (normalizedLimit) params.push(normalizedLimit);

  const rows = (await Zotero.DB.queryAsync(
    `SELECT pc.conversation_id AS conversationID,
            pc.conversation_key AS conversationKey,
            pc.library_id AS libraryID,
            pc.paper_item_id AS paperItemID,
            pc.session_version AS sessionVersion,
            pc.created_at AS createdAt,
            COALESCE(NULLIF(TRIM(pc.title), ''), NULLIF(TRIM(pc.first_user_title), '')) AS title,
            COALESCE(pc.last_activity_at, pc.created_at) AS lastActivityAt,
            COALESCE(pc.user_turn_count, 0) AS userTurnCount
     FROM ${PAPER_CONVERSATIONS_TABLE} pc
     WHERE pc.library_id = ?
       AND COALESCE(pc.user_turn_count, 0) > 0
     ORDER BY lastActivityAt DESC, pc.conversation_key DESC
     ${normalizedLimit ? "LIMIT ?" : ""}`,
    params,
  )) as PaperConversationSummaryRow[] | undefined;

  if (!rows?.length) return [];
  const out: PaperConversationSummary[] = [];
  for (const row of rows) {
    const normalized = toPaperConversationSummary(row);
    if (!normalized) continue;
    out.push(normalized);
  }
  return out;
}

export async function getPaperConversation(
  conversationKey: number,
): Promise<PaperConversationSummary | null> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamPaperConversationKey(normalizedKey))
    return null;
  const rows = (await Zotero.DB.queryAsync(
    `SELECT pc.conversation_id AS conversationID,
            pc.conversation_key AS conversationKey,
            pc.library_id AS libraryID,
            pc.paper_item_id AS paperItemID,
            pc.session_version AS sessionVersion,
            pc.created_at AS createdAt,
            COALESCE(NULLIF(TRIM(pc.title), ''), NULLIF(TRIM(pc.first_user_title), '')) AS title,
            COALESCE(pc.last_activity_at, pc.created_at) AS lastActivityAt,
            COALESCE(pc.user_turn_count, 0) AS userTurnCount
     FROM ${PAPER_CONVERSATIONS_TABLE} pc
     WHERE pc.conversation_key = ?
     LIMIT 1`,
    [normalizedKey],
  )) as PaperConversationSummaryRow[] | undefined;
  if (!rows?.length) return null;
  return toPaperConversationSummary(rows[0]);
}

export async function deletePaperConversation(
  conversationKey: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamPaperConversationKey(normalizedKey)) return;
  await Zotero.DB.queryAsync(
    `DELETE FROM ${PAPER_CONVERSATIONS_TABLE}
     WHERE conversation_key = ?`,
    [normalizedKey],
  );
  await deleteUpstreamConversationSearchIndex(normalizedKey);
}

export async function touchEmptyPaperConversation(
  conversationKey: number,
  timestamp = Date.now(),
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamPaperConversationKey(normalizedKey)) return;
  const normalizedTimestamp = Number.isFinite(timestamp)
    ? Math.floor(timestamp)
    : Date.now();
  const selector = await resolveRepairingMessageConversationSelector(
    normalizedKey,
    {
      destructive: true,
    },
  );
  await Zotero.DB.queryAsync(
    `UPDATE ${PAPER_CONVERSATIONS_TABLE}
     SET created_at = ?,
         last_activity_at = ?
     WHERE conversation_key = ?
       AND NOT EXISTS (
         SELECT 1
         FROM ${CHAT_MESSAGES_TABLE}
         WHERE ${selector.whereSql}
           AND role = 'user'
    )`,
    [
      normalizedTimestamp,
      normalizedTimestamp,
      normalizedKey,
      ...selector.params,
    ],
  );
  await refreshUpstreamConversationSearchIndex(normalizedKey);
}

/**
 * Ensure a global conversation row exists in the DB for the given key.
 * Uses INSERT OR IGNORE so it's safe to call repeatedly.
 */
export async function ensureGlobalConversationExists(
  libraryID: number,
  conversationKey: number,
): Promise<boolean> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (
    !normalizedLibraryID ||
    !normalizedKey ||
    !isUpstreamGlobalConversationKey(normalizedKey)
  ) {
    return false;
  }
  const existing = await getGlobalConversation(normalizedKey);
  if (existing) {
    if (normalizeLibraryID(existing.libraryID) !== normalizedLibraryID) {
      logChatStoreWarning(
        `Refused to ensure global conversation ${normalizedKey} for library ${normalizedLibraryID}; catalog row belongs to library ${existing.libraryID}.`,
      );
      return false;
    }
    return await repairRegisteredConversationScope({
      conversationID: existing.conversationID,
      conversationKey: normalizedKey,
      system: "upstream",
      kind: "global",
      libraryID: normalizedLibraryID,
      createdAt: existing.createdAt,
      updatedAt: existing.lastActivityAt,
      title: existing.title,
    });
  }
  const conversationID = buildUpstreamConversationID({
    conversationKey: normalizedKey,
    kind: "global",
    libraryID: normalizedLibraryID,
  });
  const createdAt = Date.now();
  await Zotero.DB.queryAsync(
    `INSERT OR IGNORE INTO ${GLOBAL_CONVERSATIONS_TABLE}
      (conversation_id, conversation_key, library_id, created_at, last_activity_at, user_turn_count, first_user_title, title)
     VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)`,
    [conversationID, normalizedKey, normalizedLibraryID, createdAt, createdAt],
  );
  return await registerConversationScope({
    conversationID,
    conversationKey: normalizedKey,
    system: "upstream",
    kind: "global",
    libraryID: normalizedLibraryID,
    createdAt,
    updatedAt: createdAt,
  });
}

export async function createGlobalConversation(
  libraryID: number,
): Promise<number> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  if (!normalizedLibraryID) return 0;

  const createdAt = Date.now();
  return await Zotero.DB.executeTransaction(async () => {
    const nextConversationKey = await getNextAvailableGlobalConversationKey(
      buildDefaultUpstreamGlobalConversationKey(normalizedLibraryID),
    );
    const conversationID = buildUpstreamConversationID({
      conversationKey: nextConversationKey,
      kind: "global",
      libraryID: normalizedLibraryID,
    });
    await Zotero.DB.queryAsync(
      `INSERT INTO ${GLOBAL_CONVERSATIONS_TABLE}
        (conversation_id, conversation_key, library_id, created_at, last_activity_at, user_turn_count, first_user_title, title)
       VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)`,
      [
        conversationID,
        nextConversationKey,
        normalizedLibraryID,
        createdAt,
        createdAt,
      ],
    );
    await registerConversationScope({
      conversationID,
      conversationKey: nextConversationKey,
      system: "upstream",
      kind: "global",
      libraryID: normalizedLibraryID,
      createdAt,
      updatedAt: createdAt,
    });
    return nextConversationKey;
  });
}

export async function listGlobalConversations(
  libraryID: number,
  limit: number | null,
  includeEmpty = false,
): Promise<GlobalConversationSummary[]> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  if (!normalizedLibraryID) return [];
  const normalizedLimit = normalizeOptionalLimit(limit);
  const params: unknown[] = [
    normalizedLibraryID,
    GLOBAL_CONVERSATION_KEY_BASE,
    UPSTREAM_RUNTIME_CONVERSATION_KEY_END,
  ];
  if (normalizedLimit) params.push(normalizedLimit);

  const rows = (await Zotero.DB.queryAsync(
    `SELECT gc.conversation_id AS conversationID,
            gc.conversation_key AS conversationKey,
            gc.library_id AS libraryID,
            gc.created_at AS createdAt,
            COALESCE(NULLIF(TRIM(gc.title), ''), NULLIF(TRIM(gc.first_user_title), '')) AS title,
            COALESCE(gc.last_activity_at, gc.created_at) AS lastActivityAt,
            COALESCE(gc.user_turn_count, 0) AS userTurnCount
     FROM ${GLOBAL_CONVERSATIONS_TABLE} gc
     WHERE gc.library_id = ?
       AND gc.conversation_key >= ?
       AND gc.conversation_key < ?
       ${includeEmpty ? "" : "AND COALESCE(gc.user_turn_count, 0) > 0"}
     ORDER BY lastActivityAt DESC, gc.conversation_key DESC
     ${normalizedLimit ? "LIMIT ?" : ""}`,
    params,
  )) as GlobalConversationSummaryRow[] | undefined;

  if (!rows?.length) return [];
  const out: GlobalConversationSummary[] = [];
  for (const row of rows) {
    const normalized = toGlobalConversationSummary(row);
    if (!normalized) continue;
    out.push(normalized);
  }
  return out;
}

export async function getGlobalConversationUserTurnCount(
  conversationKey: number,
): Promise<number> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamGlobalConversationKey(normalizedKey))
    return 0;
  const rows = (await Zotero.DB.queryAsync(
    `SELECT COALESCE(user_turn_count, 0) AS userTurnCount
     FROM ${GLOBAL_CONVERSATIONS_TABLE}
     WHERE conversation_key = ?
     LIMIT 1`,
    [normalizedKey],
  )) as Array<{ userTurnCount?: unknown }> | undefined;
  const count = Number(rows?.[0]?.userTurnCount);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

export async function touchEmptyGlobalConversation(
  conversationKey: number,
  timestamp = Date.now(),
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamGlobalConversationKey(normalizedKey)) return;
  const normalizedTimestamp = Number.isFinite(timestamp)
    ? Math.floor(timestamp)
    : Date.now();
  const selector = await resolveRepairingMessageConversationSelector(
    normalizedKey,
    {
      destructive: true,
    },
  );
  await Zotero.DB.queryAsync(
    `UPDATE ${GLOBAL_CONVERSATIONS_TABLE}
     SET created_at = ?,
         last_activity_at = ?
     WHERE conversation_key = ?
       AND NOT EXISTS (
         SELECT 1
         FROM ${CHAT_MESSAGES_TABLE}
         WHERE ${selector.whereSql}
           AND role = 'user'
       )`,
    [
      normalizedTimestamp,
      normalizedTimestamp,
      normalizedKey,
      ...selector.params,
    ],
  );
  await refreshUpstreamConversationSearchIndex(normalizedKey);
}

export async function getLatestEmptyGlobalConversation(
  libraryID: number,
): Promise<GlobalConversationSummary | null> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  if (!normalizedLibraryID) return null;
  const rows = (await Zotero.DB.queryAsync(
    `SELECT gc.conversation_id AS conversationID,
            gc.conversation_key AS conversationKey,
            gc.library_id AS libraryID,
            gc.created_at AS createdAt,
            COALESCE(NULLIF(TRIM(gc.title), ''), NULLIF(TRIM(gc.first_user_title), '')) AS title,
            COALESCE(gc.last_activity_at, gc.created_at) AS lastActivityAt,
            COALESCE(gc.user_turn_count, 0) AS userTurnCount
     FROM ${GLOBAL_CONVERSATIONS_TABLE} gc
     WHERE gc.library_id = ?
       AND gc.conversation_key >= ?
       AND gc.conversation_key < ?
       AND COALESCE(gc.user_turn_count, 0) = 0
     ORDER BY gc.created_at DESC, gc.conversation_key DESC
     LIMIT 1`,
    [
      normalizedLibraryID,
      GLOBAL_CONVERSATION_KEY_BASE,
      UPSTREAM_RUNTIME_CONVERSATION_KEY_END,
    ],
  )) as GlobalConversationSummaryRow[] | undefined;
  if (!rows?.length) return null;
  return toGlobalConversationSummary(rows[0]);
}

export async function getGlobalConversation(
  conversationKey: number,
): Promise<GlobalConversationSummary | null> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamGlobalConversationKey(normalizedKey))
    return null;
  const rows = (await Zotero.DB.queryAsync(
    `SELECT gc.conversation_id AS conversationID,
            gc.conversation_key AS conversationKey,
            gc.library_id AS libraryID,
            gc.created_at AS createdAt,
            COALESCE(NULLIF(TRIM(gc.title), ''), NULLIF(TRIM(gc.first_user_title), '')) AS title,
            COALESCE(gc.last_activity_at, gc.created_at) AS lastActivityAt,
            COALESCE(gc.user_turn_count, 0) AS userTurnCount
     FROM ${GLOBAL_CONVERSATIONS_TABLE} gc
     WHERE gc.conversation_key = ?
     LIMIT 1`,
    [normalizedKey],
  )) as GlobalConversationSummaryRow[] | undefined;
  if (!rows?.length) return null;
  return toGlobalConversationSummary(rows[0]);
}

export async function touchGlobalConversationTitle(
  conversationKey: number,
  titleSeed: string,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamGlobalConversationKey(normalizedKey)) return;
  const title = normalizeConversationTitleSeed(titleSeed);
  if (!title) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${GLOBAL_CONVERSATIONS_TABLE}
     SET title = ?
     WHERE conversation_key = ?
       AND (title IS NULL OR TRIM(title) = '')`,
    [title, normalizedKey],
  );
  await refreshUpstreamConversationSearchIndex(normalizedKey);
}

export async function setGlobalConversationTitle(
  conversationKey: number,
  titleSeed: string,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamGlobalConversationKey(normalizedKey)) return;
  const title = normalizeConversationTitleSeed(titleSeed);
  if (!title) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${GLOBAL_CONVERSATIONS_TABLE}
     SET title = ?
     WHERE conversation_key = ?`,
    [title, normalizedKey],
  );
  await refreshUpstreamConversationSearchIndex(normalizedKey);
}

export async function touchPaperConversationTitle(
  conversationKey: number,
  titleSeed: string,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamPaperConversationKey(normalizedKey)) return;
  const title = normalizeConversationTitleSeed(titleSeed);
  if (!title) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${PAPER_CONVERSATIONS_TABLE}
     SET title = ?
     WHERE conversation_key = ?
       AND (title IS NULL OR TRIM(title) = '')`,
    [title, normalizedKey],
  );
  await refreshUpstreamConversationSearchIndex(normalizedKey);
}

export async function setPaperConversationTitle(
  conversationKey: number,
  titleSeed: string,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamPaperConversationKey(normalizedKey)) return;
  const title = normalizeConversationTitleSeed(titleSeed);
  if (!title) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${PAPER_CONVERSATIONS_TABLE}
     SET title = ?
     WHERE conversation_key = ?`,
    [title, normalizedKey],
  );
  await refreshUpstreamConversationSearchIndex(normalizedKey);
}

export async function clearConversationTitle(
  conversationKey: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamStoreConversationKey(normalizedKey)) return;
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `UPDATE ${GLOBAL_CONVERSATIONS_TABLE}
       SET title = NULL
       WHERE conversation_key = ?`,
      [normalizedKey],
    );
    await Zotero.DB.queryAsync(
      `UPDATE ${PAPER_CONVERSATIONS_TABLE}
       SET title = NULL
       WHERE conversation_key = ?`,
      [normalizedKey],
    );
  });
  await refreshUpstreamConversationSearchIndex(normalizedKey);
}

export async function deleteGlobalConversation(
  conversationKey: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamGlobalConversationKey(normalizedKey)) return;
  await Zotero.DB.queryAsync(
    `DELETE FROM ${GLOBAL_CONVERSATIONS_TABLE}
     WHERE conversation_key = ?`,
    [normalizedKey],
  );
  await deleteUpstreamConversationSearchIndex(normalizedKey);
}

export async function preflightDeleteUpstreamConversationLocalRows(
  conversationKey: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamStoreConversationKey(normalizedKey)) return;
  const repair =
    await repairRecoverableUpstreamCatalogMessageConversationIDs(normalizedKey);
  if (repair.refused > 0) {
    throw new Error(
      `Refused to delete upstream conversation ${normalizedKey}: ambiguous stale message ids found.`,
    );
  }
  await resolveRepairingMessageConversationSelector(normalizedKey, {
    destructive: true,
  });
}

export async function deleteUpstreamConversationLocalRows(
  conversationKey: number,
  kind?: "global" | "paper",
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamStoreConversationKey(normalizedKey)) return;
  await preflightDeleteUpstreamConversationLocalRows(normalizedKey);
  const catalogKind =
    kind === "paper" || isUpstreamPaperConversationKey(normalizedKey)
      ? "paper"
      : "global";
  const catalogTable =
    catalogKind === "paper"
      ? PAPER_CONVERSATIONS_TABLE
      : GLOBAL_CONVERSATIONS_TABLE;
  const selector = await resolveRepairingMessageConversationSelector(
    normalizedKey,
    {
      destructive: true,
    },
  );
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CHAT_MESSAGES_TABLE}
       WHERE ${selector.whereSql}`,
      selector.params,
    );
    await Zotero.DB.queryAsync(
      `DELETE FROM ${catalogTable}
       WHERE conversation_key = ?`,
      [normalizedKey],
    );
  });
  await deleteUpstreamConversationSearchIndex(normalizedKey);
}

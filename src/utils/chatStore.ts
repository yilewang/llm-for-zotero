import type {
  CollectionContextRef,
  NoteContextRef,
  SelectedTextSource,
  PaperContextRef,
  GlobalConversationSummary,
  PaperConversationSummary,
} from "../shared/types";
import {
  GLOBAL_CONVERSATION_KEY_BASE,
  PAPER_CONVERSATION_KEY_BASE,
} from "../modules/contextPanel/constants";
import {
  normalizeSelectedTextNoteContexts,
  normalizeSelectedTextPaperContexts,
  normalizeSelectedTextSource,
  normalizePaperContextRefs,
  normalizeCollectionContextRefs,
} from "../modules/contextPanel/normalizers";

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
  paperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  citationPaperContexts?: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  screenshotImages?: string[];
  attachments?: StoredChatAttachment[];
  modelAttachments?: StoredChatAttachment[];
  modelName?: string;
  modelEntryId?: string;
  modelProviderLabel?: string;
  webchatRunState?: "done" | "incomplete" | "error";
  webchatCompletionReason?: "settled" | "forced_cancel" | "timeout" | "error" | null;
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
const GLOBAL_CONVERSATIONS_TABLE = "llm_for_zotero_global_conversations";
const GLOBAL_CONVERSATIONS_LIBRARY_INDEX =
  "llm_for_zotero_global_conversations_library_idx";
const PAPER_CONVERSATIONS_TABLE = "llm_for_zotero_paper_conversations";
const PAPER_CONVERSATIONS_PAPER_INDEX =
  "llm_for_zotero_paper_conversations_paper_idx";
const PAPER_CONVERSATIONS_CONVERSATION_INDEX =
  "llm_for_zotero_paper_conversations_conversation_idx";
const LEGACY_CHAT_MESSAGES_TABLE = "zoterollm_chat_messages";
const LEGACY_CHAT_MESSAGES_INDEX = "zoterollm_chat_messages_conversation_idx";

async function tableExists(tableName: string): Promise<boolean> {
  const rows = (await Zotero.DB.queryAsync(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName],
  )) as Array<{ name?: unknown }> | undefined;
  return Boolean(rows?.length);
}

async function countRows(tableName: string): Promise<number> {
  const rows = (await Zotero.DB.queryAsync(
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
      (
        Zotero as unknown as { Libraries?: { userLibraryID?: unknown } }
      ).Libraries?.userLibraryID,
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

function isUpstreamGlobalConversationKey(conversationKey: number): boolean {
  return Number.isFinite(conversationKey) && conversationKey >= GLOBAL_CONVERSATION_KEY_BASE && conversationKey < 3_000_000_000;
}

async function purgeInvalidGlobalConversationCatalog(): Promise<void> {
  await Zotero.DB.queryAsync(
    `DELETE FROM ${GLOBAL_CONVERSATIONS_TABLE}
     WHERE conversation_key < ?
        OR conversation_key >= ?`,
    [GLOBAL_CONVERSATION_KEY_BASE, 3_000_000_000],
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
    [GLOBAL_CONVERSATION_KEY_BASE, 3_000_000_000],
  )) as ConversationCatalogSeedRow[] | undefined;

  for (const row of rows || []) {
    const conversationKey = normalizeConversationKey(Number(row.conversationKey));
    if (!conversationKey) continue;
    const title =
      typeof row.title === "string" && row.title.trim()
        ? normalizeConversationTitleSeed(row.title)
        : "";
    await Zotero.DB.queryAsync(
      `INSERT OR IGNORE INTO ${GLOBAL_CONVERSATIONS_TABLE}
        (conversation_key, library_id, created_at, title)
       VALUES (?, ?, ?, ?)`,
      [
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
    const conversationKey = normalizeConversationKey(Number(row.conversationKey));
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
        (conversation_key, library_id, paper_item_id, session_version, created_at, title)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [
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

export async function initChatStore(): Promise<void> {
  await Zotero.DB.executeTransaction(async () => {
    await migrateLegacyChatStore();

    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${CHAT_MESSAGES_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        collection_contexts_json TEXT,
        screenshot_images TEXT,
        attachments_json TEXT,
        model_attachments_json TEXT,
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
    if (!hasPaperContextsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN paper_contexts_json TEXT`,
      );
    }
    const hasFullTextPaperContextsJsonColumn = Boolean(
      columns?.some((column) => column?.name === "full_text_paper_contexts_json"),
    );
    if (!hasFullTextPaperContextsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN full_text_paper_contexts_json TEXT`,
      );
    }
    const hasCitationPaperContextsJsonColumn = Boolean(
      columns?.some((column) => column?.name === "citation_paper_contexts_json"),
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
    if (!hasCollectionContextsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN collection_contexts_json TEXT`,
      );
    }
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
      `CREATE TABLE IF NOT EXISTS ${GLOBAL_CONVERSATIONS_TABLE} (
        conversation_key INTEGER PRIMARY KEY,
        library_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        title TEXT
      )`,
    );

    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${GLOBAL_CONVERSATIONS_LIBRARY_INDEX}
       ON ${GLOBAL_CONVERSATIONS_TABLE} (library_id, created_at DESC, conversation_key DESC)`,
    );

    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PAPER_CONVERSATIONS_TABLE} (
        conversation_key INTEGER PRIMARY KEY,
        library_id INTEGER NOT NULL,
        paper_item_id INTEGER NOT NULL,
        session_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
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

    await reconcileConversationCatalogs();
  });
}

export async function loadConversation(
  conversationKey: number,
  limit: number,
): Promise<StoredChatMessage[]> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return [];

  const normalizedLimit = normalizeLimit(limit, 200);
  const rows = (await Zotero.DB.queryAsync(
    `SELECT role,
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
            collection_contexts_json AS collectionContextsJson,
            screenshot_images AS screenshotImages,
            attachments_json AS attachmentsJson,
            model_attachments_json AS modelAttachmentsJson,
            model_name AS modelName,
            model_entry_id AS modelEntryId,
            model_provider_label AS modelProviderLabel,
            webchat_run_state AS webchatRunState,
            webchat_completion_reason AS webchatCompletionReason,
            reasoning_summary AS reasoningSummary,
            reasoning_details AS reasoningDetails,
            context_tokens AS contextTokens,
            context_window AS contextWindow
     FROM ${CHAT_MESSAGES_TABLE}
     WHERE conversation_key = ?
     ORDER BY timestamp ASC, id ASC
     LIMIT ?`,
    [normalizedKey, normalizedLimit],
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
        paperContextsJson?: unknown;
        fullTextPaperContextsJson?: unknown;
        citationPaperContextsJson?: unknown;
        collectionContextsJson?: unknown;
        screenshotImages?: unknown;
        attachmentsJson?: unknown;
        modelAttachmentsJson?: unknown;
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
      paperContexts,
      fullTextPaperContexts,
      citationPaperContexts,
      selectedCollectionContexts,
      screenshotImages,
      attachments,
      modelAttachments,
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
      contextTokens:
        Number.isFinite(Number(row.contextTokens))
          ? Math.floor(Number(row.contextTokens))
          : undefined,
      contextWindow:
        Number.isFinite(Number(row.contextWindow))
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
  if (!normalizedKey) return;

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
  const screenshotImages = Array.isArray(message.screenshotImages)
    ? message.screenshotImages.filter((entry) => Boolean(entry))
    : [];
  const attachments = normalizeStoredAttachments(message.attachments);
  const hasExplicitModelAttachments = Object.prototype.hasOwnProperty.call(
    message,
    "modelAttachments",
  );
  const modelAttachments = normalizeStoredAttachments(message.modelAttachments);
  await Zotero.DB.queryAsync(
    `INSERT INTO ${CHAT_MESSAGES_TABLE}
      (conversation_key, role, text, timestamp, run_mode, agent_run_id, selected_text, selected_texts_json, selected_text_sources_json, selected_text_paper_contexts_json, selected_text_note_contexts_json, paper_contexts_json, full_text_paper_contexts_json, citation_paper_contexts_json, collection_contexts_json, screenshot_images, attachments_json, model_attachments_json, model_name, model_entry_id, model_provider_label, webchat_run_state, webchat_completion_reason, reasoning_summary, reasoning_details, context_tokens, context_window)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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
      screenshotImages.length ? JSON.stringify(screenshotImages) : null,
      attachments.length ? JSON.stringify(attachments) : null,
      hasExplicitModelAttachments ? JSON.stringify(modelAttachments) : null,
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
    | "paperContexts"
    | "fullTextPaperContexts"
    | "citationPaperContexts"
    | "selectedCollectionContexts"
    | "screenshotImages"
    | "attachments"
    | "modelAttachments"
    | "modelName"
    | "modelEntryId"
    | "modelProviderLabel"
  >,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return;

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
  const screenshotImages = Array.isArray(message.screenshotImages)
    ? message.screenshotImages.filter((entry) => Boolean(entry))
    : [];
  const attachments = normalizeStoredAttachments(message.attachments);
  const hasExplicitModelAttachments = Object.prototype.hasOwnProperty.call(
    message,
    "modelAttachments",
  );
  const modelAttachments = normalizeStoredAttachments(message.modelAttachments);

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
         paper_contexts_json = ?,
         full_text_paper_contexts_json = ?,
         citation_paper_contexts_json = ?,
         collection_contexts_json = ?,
         screenshot_images = ?,
         attachments_json = ?,
         model_attachments_json = ?,
         model_name = ?,
         model_entry_id = ?,
         model_provider_label = ?
     WHERE id = (
       SELECT id
       FROM ${CHAT_MESSAGES_TABLE}
       WHERE conversation_key = ? AND role = 'user'
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
      screenshotImages.length ? JSON.stringify(screenshotImages) : null,
      attachments.length ? JSON.stringify(attachments) : null,
      hasExplicitModelAttachments ? JSON.stringify(modelAttachments) : null,
      message.modelName || null,
      message.modelEntryId || null,
      message.modelProviderLabel || null,
      normalizedKey,
    ],
  );
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
  >,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return;

  const timestamp = Number(message.timestamp);
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
         context_tokens = ?,
         context_window = ?
     WHERE id = (
       SELECT id
       FROM ${CHAT_MESSAGES_TABLE}
       WHERE conversation_key = ? AND role = 'assistant'
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
      Number.isFinite(Number(message.contextTokens))
        ? Math.floor(Number(message.contextTokens))
        : null,
      Number.isFinite(Number(message.contextWindow))
        ? Math.floor(Number(message.contextWindow))
        : null,
      normalizedKey,
    ],
  );
}

export async function clearConversation(
  conversationKey: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return;

  await Zotero.DB.queryAsync(
    `DELETE FROM ${CHAT_MESSAGES_TABLE}
     WHERE conversation_key = ?`,
    [normalizedKey],
  );
}

export async function deleteTurnMessages(
  conversationKey: number,
  userTimestamp: number,
  assistantTimestamp: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return;
  const normalizedUserTimestamp = Number.isFinite(userTimestamp)
    ? Math.floor(userTimestamp)
    : 0;
  const normalizedAssistantTimestamp = Number.isFinite(assistantTimestamp)
    ? Math.floor(assistantTimestamp)
    : 0;
  if (normalizedUserTimestamp <= 0 || normalizedAssistantTimestamp <= 0) return;

  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CHAT_MESSAGES_TABLE}
       WHERE id = (
         SELECT id
         FROM ${CHAT_MESSAGES_TABLE}
         WHERE conversation_key = ?
           AND role = 'user'
           AND timestamp = ?
         ORDER BY id DESC
         LIMIT 1
       )`,
      [normalizedKey, normalizedUserTimestamp],
    );
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CHAT_MESSAGES_TABLE}
       WHERE id = (
         SELECT id
         FROM ${CHAT_MESSAGES_TABLE}
         WHERE conversation_key = ?
           AND role = 'assistant'
           AND timestamp = ?
         ORDER BY id DESC
         LIMIT 1
       )`,
      [normalizedKey, normalizedAssistantTimestamp],
    );
  });
}

export async function pruneConversation(
  conversationKey: number,
  keep: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return;

  const normalizedKeep = Number.isFinite(keep) ? Math.floor(keep) : 200;
  if (normalizedKeep <= 0) {
    await clearConversation(normalizedKey);
    return;
  }

  await Zotero.DB.queryAsync(
    `DELETE FROM ${CHAT_MESSAGES_TABLE}
     WHERE id IN (
       SELECT id
       FROM ${CHAT_MESSAGES_TABLE}
       WHERE conversation_key = ?
       ORDER BY timestamp DESC, id DESC
       LIMIT -1 OFFSET ?
     )`,
    [normalizedKey, normalizedKeep],
  );
}

type GlobalConversationSummaryRow = {
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
  await Zotero.DB.queryAsync(
    `INSERT OR IGNORE INTO ${PAPER_CONVERSATIONS_TABLE}
      (conversation_key, library_id, paper_item_id, session_version, created_at, title)
     VALUES (?, ?, ?, 1, ?, NULL)`,
    [
      normalizedPaperItemID,
      normalizedLibraryID,
      normalizedPaperItemID,
      createdAt,
    ],
  );
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
    await Zotero.DB.queryAsync(
      `INSERT INTO ${PAPER_CONVERSATIONS_TABLE}
        (conversation_key, library_id, paper_item_id, session_version, created_at, title)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      [
        nextConversationKey,
        normalizedLibraryID,
        normalizedPaperItemID,
        nextVersion,
        createdAt,
      ],
    );
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
    `SELECT pc.conversation_key AS conversationKey,
            pc.library_id AS libraryID,
            pc.paper_item_id AS paperItemID,
            pc.session_version AS sessionVersion,
            pc.created_at AS createdAt,
            COALESCE(
              NULLIF(TRIM(pc.title), ''),
              (
                SELECT m0.text
                FROM ${CHAT_MESSAGES_TABLE} m0
                WHERE m0.conversation_key = pc.conversation_key
                  AND m0.role = 'user'
                ORDER BY m0.timestamp ASC, m0.id ASC
                LIMIT 1
              )
            ) AS title,
            COALESCE(MAX(m.timestamp), pc.created_at) AS lastActivityAt,
            SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) AS userTurnCount
     FROM ${PAPER_CONVERSATIONS_TABLE} pc
     LEFT JOIN ${CHAT_MESSAGES_TABLE} m
       ON m.conversation_key = pc.conversation_key
     WHERE pc.library_id = ?
       AND pc.paper_item_id = ?
     GROUP BY pc.conversation_key, pc.library_id, pc.paper_item_id, pc.session_version, pc.created_at, pc.title
     ${includeEmpty ? "" : "HAVING SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) > 0"}
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
  limit: number,
): Promise<PaperConversationSummary[]> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  if (!normalizedLibraryID) return [];
  const normalizedLimit = normalizeLimit(limit, 100);

  const rows = (await Zotero.DB.queryAsync(
    `SELECT pc.conversation_key AS conversationKey,
            pc.library_id AS libraryID,
            pc.paper_item_id AS paperItemID,
            pc.session_version AS sessionVersion,
            pc.created_at AS createdAt,
            COALESCE(
              NULLIF(TRIM(pc.title), ''),
              (
                SELECT m0.text
                FROM ${CHAT_MESSAGES_TABLE} m0
                WHERE m0.conversation_key = pc.conversation_key
                  AND m0.role = 'user'
                ORDER BY m0.timestamp ASC, m0.id ASC
                LIMIT 1
              )
            ) AS title,
            COALESCE(MAX(m.timestamp), pc.created_at) AS lastActivityAt,
            SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) AS userTurnCount
     FROM ${PAPER_CONVERSATIONS_TABLE} pc
     LEFT JOIN ${CHAT_MESSAGES_TABLE} m
       ON m.conversation_key = pc.conversation_key
     WHERE pc.library_id = ?
     GROUP BY pc.conversation_key, pc.library_id, pc.paper_item_id, pc.session_version, pc.created_at, pc.title
     HAVING SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) > 0
     ORDER BY lastActivityAt DESC, pc.conversation_key DESC
     LIMIT ?`,
    [normalizedLibraryID, normalizedLimit],
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
  if (!normalizedKey) return null;
  const rows = (await Zotero.DB.queryAsync(
    `SELECT pc.conversation_key AS conversationKey,
            pc.library_id AS libraryID,
            pc.paper_item_id AS paperItemID,
            pc.session_version AS sessionVersion,
            pc.created_at AS createdAt,
            COALESCE(
              NULLIF(TRIM(pc.title), ''),
              (
                SELECT m0.text
                FROM ${CHAT_MESSAGES_TABLE} m0
                WHERE m0.conversation_key = pc.conversation_key
                  AND m0.role = 'user'
                ORDER BY m0.timestamp ASC, m0.id ASC
                LIMIT 1
              )
            ) AS title,
            COALESCE(MAX(m.timestamp), pc.created_at) AS lastActivityAt,
            SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) AS userTurnCount
     FROM ${PAPER_CONVERSATIONS_TABLE} pc
     LEFT JOIN ${CHAT_MESSAGES_TABLE} m
       ON m.conversation_key = pc.conversation_key
     WHERE pc.conversation_key = ?
     GROUP BY pc.conversation_key, pc.library_id, pc.paper_item_id, pc.session_version, pc.created_at, pc.title
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
  if (!normalizedKey) return;
  await Zotero.DB.queryAsync(
    `DELETE FROM ${PAPER_CONVERSATIONS_TABLE}
     WHERE conversation_key = ?`,
    [normalizedKey],
  );
}

/**
 * Ensure a global conversation row exists in the DB for the given key.
 * Uses INSERT OR IGNORE so it's safe to call repeatedly.
 */
export async function ensureGlobalConversationExists(
  libraryID: number,
  conversationKey: number,
): Promise<void> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedLibraryID || !normalizedKey || !isUpstreamGlobalConversationKey(normalizedKey)) return;
  await Zotero.DB.queryAsync(
    `INSERT OR IGNORE INTO ${GLOBAL_CONVERSATIONS_TABLE}
      (conversation_key, library_id, created_at, title)
     VALUES (?, ?, ?, NULL)`,
    [normalizedKey, normalizedLibraryID, Date.now()],
  );
}

export async function createGlobalConversation(
  libraryID: number,
): Promise<number> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  if (!normalizedLibraryID) return 0;

  const createdAt = Date.now();
  return await Zotero.DB.executeTransaction(async () => {
    const rows = (await Zotero.DB.queryAsync(
      `SELECT MAX(conversation_key) AS maxConversationKey
       FROM ${GLOBAL_CONVERSATIONS_TABLE}
       WHERE conversation_key >= ?
         AND conversation_key < ?`,
      [GLOBAL_CONVERSATION_KEY_BASE, 3_000_000_000],
    )) as Array<{ maxConversationKey?: unknown }> | undefined;
    const maxConversationKey = Number(rows?.[0]?.maxConversationKey);
    const nextConversationKey = Number.isFinite(maxConversationKey)
      ? Math.max(
          GLOBAL_CONVERSATION_KEY_BASE,
          Math.floor(maxConversationKey) + 1,
        )
      : GLOBAL_CONVERSATION_KEY_BASE;
    await Zotero.DB.queryAsync(
      `INSERT INTO ${GLOBAL_CONVERSATIONS_TABLE}
        (conversation_key, library_id, created_at, title)
       VALUES (?, ?, ?, NULL)`,
      [nextConversationKey, normalizedLibraryID, createdAt],
    );
    return nextConversationKey;
  });
}

export async function listGlobalConversations(
  libraryID: number,
  limit: number,
  includeEmpty = false,
): Promise<GlobalConversationSummary[]> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  if (!normalizedLibraryID) return [];
  const normalizedLimit = normalizeLimit(limit, 50);

  const rows = (await Zotero.DB.queryAsync(
    `SELECT gc.conversation_key AS conversationKey,
            gc.library_id AS libraryID,
            gc.created_at AS createdAt,
            gc.title AS title,
            COALESCE(MAX(m.timestamp), gc.created_at) AS lastActivityAt,
            SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) AS userTurnCount
     FROM ${GLOBAL_CONVERSATIONS_TABLE} gc
     LEFT JOIN ${CHAT_MESSAGES_TABLE} m
       ON m.conversation_key = gc.conversation_key
     WHERE gc.library_id = ?
       AND gc.conversation_key >= ?
       AND gc.conversation_key < ?
     GROUP BY gc.conversation_key, gc.library_id, gc.created_at, gc.title
     ${includeEmpty ? "" : "HAVING SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) > 0"}
     ORDER BY lastActivityAt DESC, gc.conversation_key DESC
     LIMIT ?`,
    [normalizedLibraryID, GLOBAL_CONVERSATION_KEY_BASE, 3_000_000_000, normalizedLimit],
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
  if (!normalizedKey || !isUpstreamGlobalConversationKey(normalizedKey)) return 0;
  const rows = (await Zotero.DB.queryAsync(
    `SELECT SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS userTurnCount
     FROM ${CHAT_MESSAGES_TABLE}
     WHERE conversation_key = ?`,
    [normalizedKey],
  )) as Array<{ userTurnCount?: unknown }> | undefined;
  const count = Number(rows?.[0]?.userTurnCount);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

export async function getLatestEmptyGlobalConversation(
  libraryID: number,
): Promise<GlobalConversationSummary | null> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  if (!normalizedLibraryID) return null;
  const rows = (await Zotero.DB.queryAsync(
    `SELECT gc.conversation_key AS conversationKey,
            gc.library_id AS libraryID,
            gc.created_at AS createdAt,
            gc.title AS title,
            gc.created_at AS lastActivityAt,
            SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) AS userTurnCount
     FROM ${GLOBAL_CONVERSATIONS_TABLE} gc
     LEFT JOIN ${CHAT_MESSAGES_TABLE} m
       ON m.conversation_key = gc.conversation_key
     WHERE gc.library_id = ?
       AND gc.conversation_key >= ?
       AND gc.conversation_key < ?
     GROUP BY gc.conversation_key, gc.library_id, gc.created_at, gc.title
     HAVING SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) = 0
     ORDER BY gc.created_at DESC, gc.conversation_key DESC
     LIMIT 1`,
    [normalizedLibraryID, GLOBAL_CONVERSATION_KEY_BASE, 3_000_000_000],
  )) as GlobalConversationSummaryRow[] | undefined;
  if (!rows?.length) return null;
  return toGlobalConversationSummary(rows[0]);
}

export async function getGlobalConversation(
  conversationKey: number,
): Promise<GlobalConversationSummary | null> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !isUpstreamGlobalConversationKey(normalizedKey)) return null;
  const rows = (await Zotero.DB.queryAsync(
    `SELECT gc.conversation_key AS conversationKey,
            gc.library_id AS libraryID,
            gc.created_at AS createdAt,
            gc.title AS title,
            COALESCE(MAX(m.timestamp), gc.created_at) AS lastActivityAt,
            SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) AS userTurnCount
     FROM ${GLOBAL_CONVERSATIONS_TABLE} gc
     LEFT JOIN ${CHAT_MESSAGES_TABLE} m
       ON m.conversation_key = gc.conversation_key
     WHERE gc.conversation_key = ?
     GROUP BY gc.conversation_key, gc.library_id, gc.created_at, gc.title
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
  if (!normalizedKey) return;
  const title = normalizeConversationTitleSeed(titleSeed);
  if (!title) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${GLOBAL_CONVERSATIONS_TABLE}
     SET title = ?
     WHERE conversation_key = ?
       AND (title IS NULL OR TRIM(title) = '')`,
    [title, normalizedKey],
  );
}

export async function setGlobalConversationTitle(
  conversationKey: number,
  titleSeed: string,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return;
  const title = normalizeConversationTitleSeed(titleSeed);
  if (!title) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${GLOBAL_CONVERSATIONS_TABLE}
     SET title = ?
     WHERE conversation_key = ?`,
    [title, normalizedKey],
  );
}

export async function touchPaperConversationTitle(
  conversationKey: number,
  titleSeed: string,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return;
  const title = normalizeConversationTitleSeed(titleSeed);
  if (!title) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${PAPER_CONVERSATIONS_TABLE}
     SET title = ?
     WHERE conversation_key = ?
       AND (title IS NULL OR TRIM(title) = '')`,
    [title, normalizedKey],
  );
}

export async function setPaperConversationTitle(
  conversationKey: number,
  titleSeed: string,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return;
  const title = normalizeConversationTitleSeed(titleSeed);
  if (!title) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${PAPER_CONVERSATIONS_TABLE}
     SET title = ?
     WHERE conversation_key = ?`,
    [title, normalizedKey],
  );
}

export async function clearConversationTitle(
  conversationKey: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return;
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
}

export async function deleteGlobalConversation(
  conversationKey: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return;
  await Zotero.DB.queryAsync(
    `DELETE FROM ${GLOBAL_CONVERSATIONS_TABLE}
     WHERE conversation_key = ?`,
    [normalizedKey],
  );
}

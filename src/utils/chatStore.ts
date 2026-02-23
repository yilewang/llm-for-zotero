import type {
  SelectedTextSource,
  PaperContextRef,
  GlobalConversationSummary,
} from "../modules/contextPanel/types";
import { GLOBAL_CONVERSATION_KEY_BASE } from "../modules/contextPanel/constants";

export type StoredChatMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  selectedText?: string;
  selectedTexts?: string[];
  selectedTextSources?: SelectedTextSource[];
  paperContexts?: PaperContextRef[];
  screenshotImages?: string[];
  attachments?: Array<{
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    category: "image" | "pdf" | "markdown" | "code" | "text" | "file";
    imageDataUrl?: string;
    textContent?: string;
    storedPath?: string;
    contentHash?: string;
  }>;
  modelName?: string;
  reasoningSummary?: string;
  reasoningDetails?: string;
};

const CHAT_MESSAGES_TABLE = "llm_for_zotero_chat_messages";
const CHAT_MESSAGES_INDEX = "llm_for_zotero_chat_messages_conversation_idx";
const GLOBAL_CONVERSATIONS_TABLE = "llm_for_zotero_global_conversations";
const GLOBAL_CONVERSATIONS_LIBRARY_INDEX =
  "llm_for_zotero_global_conversations_library_idx";
const LEGACY_CHAT_MESSAGES_TABLE = "zoterollm_chat_messages";
const LEGACY_CHAT_MESSAGES_INDEX = "zoterollm_chat_messages_conversation_idx";

function normalizeSelectedTextSource(value: unknown): SelectedTextSource {
  return value === "model" ? "model" : "pdf";
}

function normalizePaperContextRefs(value: unknown): PaperContextRef[] {
  if (!Array.isArray(value)) return [];
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const typed = entry as Record<string, unknown>;
    const itemId = Number(typed.itemId);
    const contextItemId = Number(typed.contextItemId);
    if (!Number.isFinite(itemId) || !Number.isFinite(contextItemId)) continue;
    const normalizedItemId = Math.floor(itemId);
    const normalizedContextItemId = Math.floor(contextItemId);
    if (normalizedItemId <= 0 || normalizedContextItemId <= 0) continue;
    const title =
      typeof typed.title === "string" && typed.title.trim()
        ? typed.title.trim()
        : "";
    if (!title) continue;
    const citationKey =
      typeof typed.citationKey === "string" && typed.citationKey.trim()
        ? typed.citationKey.trim()
        : undefined;
    const firstCreator =
      typeof typed.firstCreator === "string" && typed.firstCreator.trim()
        ? typed.firstCreator.trim()
        : undefined;
    const year =
      typeof typed.year === "string" && typed.year.trim()
        ? typed.year.trim()
        : undefined;
    const dedupeKey = `${normalizedItemId}:${normalizedContextItemId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      itemId: normalizedItemId,
      contextItemId: normalizedContextItemId,
      title,
      citationKey,
      firstCreator,
      year,
    });
  }
  return out;
}

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
        selected_text TEXT,
        selected_texts_json TEXT,
        selected_text_sources_json TEXT,
        paper_contexts_json TEXT,
        screenshot_images TEXT,
        attachments_json TEXT,
        model_name TEXT,
        reasoning_summary TEXT,
        reasoning_details TEXT
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
    const hasPaperContextsJsonColumn = Boolean(
      columns?.some((column) => column?.name === "paper_contexts_json"),
    );
    if (!hasPaperContextsJsonColumn) {
      await Zotero.DB.queryAsync(
        `ALTER TABLE ${CHAT_MESSAGES_TABLE}
         ADD COLUMN paper_contexts_json TEXT`,
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
            selected_text AS selectedText,
            selected_texts_json AS selectedTextsJson,
            selected_text_sources_json AS selectedTextSourcesJson,
            paper_contexts_json AS paperContextsJson,
            screenshot_images AS screenshotImages,
            attachments_json AS attachmentsJson,
            model_name AS modelName,
            reasoning_summary AS reasoningSummary,
            reasoning_details AS reasoningDetails
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
        selectedTextsJson?: unknown;
        selectedTextSourcesJson?: unknown;
        paperContextsJson?: unknown;
        screenshotImages?: unknown;
        attachmentsJson?: unknown;
        modelName?: unknown;
        reasoningSummary?: unknown;
        reasoningDetails?: unknown;
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
    let attachments: StoredChatMessage["attachments"] | undefined;
    if (typeof row.attachmentsJson === "string" && row.attachmentsJson) {
      try {
        const parsed = JSON.parse(row.attachmentsJson) as unknown;
        if (Array.isArray(parsed)) {
          const normalized = parsed.reduce<
            NonNullable<StoredChatMessage["attachments"]>
          >((out, entry) => {
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
              sizeBytes: Number.isFinite(sizeBytes)
                ? Math.max(0, sizeBytes)
                : 0,
              category,
              imageDataUrl:
                typeof typed.imageDataUrl === "string" &&
                typed.imageDataUrl.trim()
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
          if (normalized.length) {
            attachments = normalized;
          }
        }
      } catch (_err) {
        attachments = undefined;
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
    messages.push({
      role,
      text: typeof row.text === "string" ? row.text : "",
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      selectedText:
        typeof row.selectedText === "string" ? row.selectedText : undefined,
      selectedTexts: (() => {
        const normalizedTexts = selectedTexts?.length
          ? selectedTexts
          : typeof row.selectedText === "string" && row.selectedText.trim()
            ? [row.selectedText]
            : [];
        return normalizedTexts.length ? normalizedTexts : undefined;
      })(),
      selectedTextSources: (() => {
        const normalizedTexts = selectedTexts?.length
          ? selectedTexts
          : typeof row.selectedText === "string" && row.selectedText.trim()
            ? [row.selectedText]
            : [];
        if (!normalizedTexts.length) return undefined;
        return normalizedTexts.map((_, index) =>
          normalizeSelectedTextSource(selectedTextSources?.[index]),
        );
      })(),
      paperContexts,
      screenshotImages,
      attachments,
      modelName: typeof row.modelName === "string" ? row.modelName : undefined,
      reasoningSummary:
        typeof row.reasoningSummary === "string"
          ? row.reasoningSummary
          : undefined,
      reasoningDetails:
        typeof row.reasoningDetails === "string"
          ? row.reasoningDetails
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
  const paperContexts = normalizePaperContextRefs(message.paperContexts);
  const screenshotImages = Array.isArray(message.screenshotImages)
    ? message.screenshotImages.filter((entry) => Boolean(entry))
    : [];
  const attachments = Array.isArray(message.attachments)
    ? message.attachments
        .filter(
          (entry) => entry && typeof entry.id === "string" && entry.id.trim(),
        )
        .map((entry) => ({
          ...entry,
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
  await Zotero.DB.queryAsync(
    `INSERT INTO ${CHAT_MESSAGES_TABLE}
      (conversation_key, role, text, timestamp, selected_text, selected_texts_json, selected_text_sources_json, paper_contexts_json, screenshot_images, attachments_json, model_name, reasoning_summary, reasoning_details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      normalizedKey,
      message.role,
      message.text,
      Number.isFinite(timestamp) ? Math.floor(timestamp) : Date.now(),
      selectedTexts[0] || message.selectedText || null,
      selectedTexts.length ? JSON.stringify(selectedTexts) : null,
      selectedTextSources.length ? JSON.stringify(selectedTextSources) : null,
      paperContexts.length ? JSON.stringify(paperContexts) : null,
      screenshotImages.length ? JSON.stringify(screenshotImages) : null,
      attachments.length ? JSON.stringify(attachments) : null,
      message.modelName || null,
      message.reasoningSummary || null,
      message.reasoningDetails || null,
    ],
  );
}

export async function updateLatestUserMessage(
  conversationKey: number,
  message: Pick<
    StoredChatMessage,
    | "text"
    | "timestamp"
    | "selectedText"
    | "selectedTexts"
    | "selectedTextSources"
    | "paperContexts"
    | "screenshotImages"
    | "attachments"
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
  const paperContexts = normalizePaperContextRefs(message.paperContexts);
  const screenshotImages = Array.isArray(message.screenshotImages)
    ? message.screenshotImages.filter((entry) => Boolean(entry))
    : [];
  const attachments = Array.isArray(message.attachments)
    ? message.attachments
        .filter(
          (entry) => entry && typeof entry.id === "string" && entry.id.trim(),
        )
        .map((entry) => ({
          ...entry,
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

  await Zotero.DB.queryAsync(
    `UPDATE ${CHAT_MESSAGES_TABLE}
     SET text = ?,
         timestamp = ?,
         selected_text = ?,
         selected_texts_json = ?,
         selected_text_sources_json = ?,
         paper_contexts_json = ?,
         screenshot_images = ?,
         attachments_json = ?
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
      selectedTexts[0] || message.selectedText || null,
      selectedTexts.length ? JSON.stringify(selectedTexts) : null,
      selectedTextSources.length ? JSON.stringify(selectedTextSources) : null,
      paperContexts.length ? JSON.stringify(paperContexts) : null,
      screenshotImages.length ? JSON.stringify(screenshotImages) : null,
      attachments.length ? JSON.stringify(attachments) : null,
      normalizedKey,
    ],
  );
}

export async function updateLatestAssistantMessage(
  conversationKey: number,
  message: Pick<
    StoredChatMessage,
    "text" | "timestamp" | "modelName" | "reasoningSummary" | "reasoningDetails"
  >,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return;

  const timestamp = Number(message.timestamp);
  await Zotero.DB.queryAsync(
    `UPDATE ${CHAT_MESSAGES_TABLE}
     SET text = ?,
         timestamp = ?,
         model_name = ?,
         reasoning_summary = ?,
         reasoning_details = ?
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
      message.modelName || null,
      message.reasoningSummary || null,
      message.reasoningDetails || null,
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

export async function createGlobalConversation(
  libraryID: number,
): Promise<number> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  if (!normalizedLibraryID) return 0;

  const createdAt = Date.now();
  return await Zotero.DB.executeTransaction(async () => {
    const rows = (await Zotero.DB.queryAsync(
      `SELECT MAX(conversation_key) AS maxConversationKey
       FROM ${GLOBAL_CONVERSATIONS_TABLE}`,
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
     GROUP BY gc.conversation_key, gc.library_id, gc.created_at, gc.title
     ${includeEmpty ? "" : "HAVING SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) > 0"}
     ORDER BY lastActivityAt DESC, gc.conversation_key DESC
     LIMIT ?`,
    [normalizedLibraryID, normalizedLimit],
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
  if (!normalizedKey) return 0;
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
     GROUP BY gc.conversation_key, gc.library_id, gc.created_at, gc.title
     HAVING SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) = 0
     ORDER BY gc.created_at DESC, gc.conversation_key DESC
     LIMIT 1`,
    [normalizedLibraryID],
  )) as GlobalConversationSummaryRow[] | undefined;
  if (!rows?.length) return null;
  return toGlobalConversationSummary(rows[0]);
}

export async function getGlobalConversation(
  conversationKey: number,
): Promise<GlobalConversationSummary | null> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return null;
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

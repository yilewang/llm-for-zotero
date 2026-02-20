export type StoredChatMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  selectedText?: string;
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
  }>;
  modelName?: string;
  reasoningSummary?: string;
  reasoningDetails?: string;
};

const CHAT_MESSAGES_TABLE = "llm_for_zotero_chat_messages";
const CHAT_MESSAGES_INDEX = "llm_for_zotero_chat_messages_conversation_idx";
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
  const screenshotImages = Array.isArray(message.screenshotImages)
    ? message.screenshotImages.filter((entry) => Boolean(entry))
    : [];
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.filter(
        (entry) => entry && typeof entry.id === "string" && entry.id.trim(),
      )
    : [];
  await Zotero.DB.queryAsync(
    `INSERT INTO ${CHAT_MESSAGES_TABLE}
      (conversation_key, role, text, timestamp, selected_text, screenshot_images, attachments_json, model_name, reasoning_summary, reasoning_details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      normalizedKey,
      message.role,
      message.text,
      Number.isFinite(timestamp) ? Math.floor(timestamp) : Date.now(),
      message.selectedText || null,
      screenshotImages.length ? JSON.stringify(screenshotImages) : null,
      attachments.length ? JSON.stringify(attachments) : null,
      message.modelName || null,
      message.reasoningSummary || null,
      message.reasoningDetails || null,
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

export type StoredChatMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  modelName?: string;
  reasoningSummary?: string;
  reasoningDetails?: string;
};

const CHAT_MESSAGES_TABLE = "zoterollm_chat_messages";

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
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${CHAT_MESSAGES_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_key INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
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

    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS zoterollm_chat_messages_conversation_idx
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
    messages.push({
      role,
      text: typeof row.text === "string" ? row.text : "",
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
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
  await Zotero.DB.queryAsync(
    `INSERT INTO ${CHAT_MESSAGES_TABLE}
      (conversation_key, role, text, timestamp, model_name, reasoning_summary, reasoning_details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      normalizedKey,
      message.role,
      message.text,
      Number.isFinite(timestamp) ? Math.floor(timestamp) : Date.now(),
      message.modelName || null,
      message.reasoningSummary || null,
      message.reasoningDetails || null,
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

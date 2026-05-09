declare const Zotero: any;

import type {
  CodexConversationSummary,
  CodexConversationKind,
  NoteContextRef,
  SelectedTextSource,
} from "../shared/types";
import {
  normalizeSelectedTextNoteContexts,
  normalizeSelectedTextPaperContexts,
  normalizeSelectedTextSource,
  normalizePaperContextRefs,
} from "../modules/contextPanel/normalizers";
import type { StoredChatMessage } from "../utils/chatStore";
import {
  CODEX_HISTORY_LIMIT,
  buildDefaultCodexGlobalConversationKey,
  buildDefaultCodexPaperConversationKey,
  getCodexGlobalConversationKeyRange,
  getCodexPaperConversationKeyRange,
} from "./constants";
import {
  getLastAllocatedCodexGlobalConversationKey,
  getLastAllocatedCodexPaperConversationKey,
  isConversationKeyInRange,
  setLastAllocatedCodexGlobalConversationKey,
  setLastAllocatedCodexPaperConversationKey,
  setLastUsedCodexConversationMode,
  setLastUsedCodexGlobalConversationKey,
  setLastUsedCodexPaperConversationKey,
} from "./prefs";

const CODEX_MESSAGES_TABLE = "llm_for_zotero_codex_messages";
const CODEX_MESSAGES_INDEX = "llm_for_zotero_codex_messages_conversation_idx";
const CODEX_CONVERSATIONS_TABLE = "llm_for_zotero_codex_conversations";
const CODEX_CONVERSATIONS_KIND_INDEX =
  "llm_for_zotero_codex_conversations_kind_idx";
const CODEX_CONVERSATION_ACTIVITY_TIMESTAMP_SQL = `MAX(
  COALESCE(c.updated_at, 0),
  COALESCE(
    (SELECT MAX(m.timestamp)
     FROM ${CODEX_MESSAGES_TABLE} m
     WHERE m.conversation_key = c.conversation_key),
    0
  ),
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

async function touchCodexConversationActivity(
  conversationKey: number,
  timestamp?: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return;
  const normalizedTimestamp = normalizeCatalogTimestamp(timestamp);
  await Zotero.DB.queryAsync(
    `UPDATE ${CODEX_CONVERSATIONS_TABLE}
     SET updated_at = CASE
       WHEN COALESCE(updated_at, 0) > ? THEN updated_at
       ELSE ?
     END
     WHERE conversation_key = ?`,
    [normalizedTimestamp, normalizedTimestamp, normalizedKey],
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
        kind === "paper"
          ? buildDefaultCodexPaperConversationKey(paperItemID || 1)
          : buildDefaultCodexGlobalConversationKey(libraryID),
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

export async function initCodexAppServerStore(): Promise<void> {
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${CODEX_MESSAGES_TABLE} (
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
        screenshot_images TEXT,
        attachments_json TEXT,
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
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${CODEX_MESSAGES_INDEX}
       ON ${CODEX_MESSAGES_TABLE} (conversation_key, timestamp, id)`,
    );

    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${CODEX_CONVERSATIONS_TABLE} (
        conversation_key INTEGER PRIMARY KEY,
        library_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('global', 'paper')),
        paper_item_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
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
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${CODEX_CONVERSATIONS_KIND_INDEX}
       ON ${CODEX_CONVERSATIONS_TABLE} (library_id, kind, paper_item_id, updated_at DESC, conversation_key DESC)`,
    );
    await migrateLegacyCodexConversationKeys();
  });
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
  if (!normalizedKey) return;

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
  const screenshotImages = Array.isArray(message.screenshotImages)
    ? message.screenshotImages.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    : [];
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.filter(
        (entry) => entry && typeof entry.id === "string" && entry.id.trim(),
      )
    : [];
  const messageTimestamp = Number.isFinite(message.timestamp)
    ? Math.floor(message.timestamp)
    : Date.now();

  await Zotero.DB.queryAsync(
    `INSERT INTO ${CODEX_MESSAGES_TABLE}
      (conversation_key, role, text, timestamp, run_mode, agent_run_id, selected_text, selected_texts_json, selected_text_sources_json, selected_text_paper_contexts_json, selected_text_note_contexts_json, paper_contexts_json, full_text_paper_contexts_json, citation_paper_contexts_json, screenshot_images, attachments_json, model_name, model_entry_id, model_provider_label, webchat_run_state, webchat_completion_reason, reasoning_summary, reasoning_details, compact_marker, context_tokens, context_window)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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
      screenshotImages.length ? JSON.stringify(screenshotImages) : null,
      attachments.length ? JSON.stringify(attachments) : null,
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
}

export async function loadCodexConversation(
  conversationKey: number,
  limit = CODEX_HISTORY_LIMIT,
): Promise<StoredChatMessage[]> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return [];
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
            screenshot_images AS screenshotImages,
            attachments_json AS attachmentsJson,
            model_name AS modelName,
            model_entry_id AS modelEntryId,
            model_provider_label AS modelProviderLabel,
            webchat_run_state AS webchatRunState,
            webchat_completion_reason AS webchatCompletionReason,
            reasoning_summary AS reasoningSummary,
            reasoning_details AS reasoningDetails,
            compact_marker AS compactMarker,
            context_tokens AS contextTokens,
            context_window AS contextWindow
     FROM ${CODEX_MESSAGES_TABLE}
     WHERE conversation_key = ?
     ORDER BY timestamp ASC, id ASC
     LIMIT ?`,
    [normalizedKey, normalizeLimit(limit, CODEX_HISTORY_LIMIT)],
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
      screenshotImages,
      attachments,
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
  if (!normalizedKey) return;
  await Zotero.DB.queryAsync(
    `DELETE FROM ${CODEX_MESSAGES_TABLE} WHERE conversation_key = ?`,
    [normalizedKey],
  );
}

export async function deleteCodexTurnMessages(
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
      `DELETE FROM ${CODEX_MESSAGES_TABLE}
       WHERE id = (
         SELECT id
         FROM ${CODEX_MESSAGES_TABLE}
         WHERE conversation_key = ?
           AND role = 'user'
           AND timestamp = ?
         ORDER BY id DESC
         LIMIT 1
       )`,
      [normalizedKey, normalizedUserTimestamp],
    );
    await Zotero.DB.queryAsync(
      `DELETE FROM ${CODEX_MESSAGES_TABLE}
       WHERE id = (
         SELECT id
         FROM ${CODEX_MESSAGES_TABLE}
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

export async function pruneCodexConversation(
  conversationKey: number,
  keep = CODEX_HISTORY_LIMIT,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return;
  await Zotero.DB.queryAsync(
    `DELETE FROM ${CODEX_MESSAGES_TABLE}
     WHERE id IN (
       SELECT id
       FROM ${CODEX_MESSAGES_TABLE}
       WHERE conversation_key = ?
       ORDER BY timestamp DESC, id DESC
       LIMIT -1 OFFSET ?
     )`,
    [normalizedKey, normalizeLimit(keep, CODEX_HISTORY_LIMIT)],
  );
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
  if (!normalizedKey) return;
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
       WHERE conversation_key = ? AND role = 'user'
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
      normalizedKey,
    ],
  );
  await touchCodexConversationActivity(normalizedKey, messageTimestamp);
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
  >,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return;
  const messageTimestamp = Number.isFinite(message.timestamp)
    ? Math.floor(message.timestamp)
    : Date.now();
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
         context_tokens = COALESCE(?, context_tokens),
         context_window = COALESCE(?, context_window)
     WHERE id = (
       SELECT id
       FROM ${CODEX_MESSAGES_TABLE}
       WHERE conversation_key = ? AND role = 'assistant'
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
      Number.isFinite(Number(message.contextTokens)) && Number(message.contextTokens) > 0
        ? Math.floor(Number(message.contextTokens))
        : null,
      Number.isFinite(Number(message.contextWindow)) && Number(message.contextWindow) > 0
        ? Math.floor(Number(message.contextWindow))
        : null,
      normalizedKey,
    ],
  );
  await touchCodexConversationActivity(normalizedKey, messageTimestamp);
}

type CodexConversationRow = {
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
  if (!conversationKey || !libraryID || !kind) return null;
  const paperItemID = normalizePaperItemID(Number(row.paperItemID));
  const userTurnCount = Number(row.userTurnCount);
  return {
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

export async function getCodexConversationSummary(
  conversationKey: number,
): Promise<CodexConversationSummary | null> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return null;
  const rows = (await Zotero.DB.queryAsync(
    `SELECT c.conversation_key AS conversationKey,
            c.library_id AS libraryID,
            c.kind AS kind,
            c.paper_item_id AS paperItemID,
            c.created_at AS createdAt,
            ${CODEX_CONVERSATION_ACTIVITY_TIMESTAMP_SQL} AS updatedAt,
            c.title AS title,
            c.provider_session_id AS providerSessionId,
            c.scoped_conversation_key AS scopedConversationKey,
            c.scope_type AS scopeType,
            c.scope_id AS scopeId,
            c.scope_label AS scopeLabel,
            c.cwd AS cwd,
            c.model_name AS modelName,
            c.effort AS effort,
            COALESCE(
              (SELECT COUNT(*)
               FROM ${CODEX_MESSAGES_TABLE} m
               WHERE m.conversation_key = c.conversation_key
                 AND m.role = 'user'),
              0
            ) AS userTurnCount
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
}): Promise<void> {
  const conversationKey = normalizeConversationKey(params.conversationKey);
  const libraryID = normalizeLibraryID(params.libraryID);
  if (!conversationKey || !libraryID) return;
  const createdAt = normalizeCatalogTimestamp(params.createdAt);
  const updatedAt = normalizeCatalogTimestamp(params.updatedAt);
  await Zotero.DB.queryAsync(
    `INSERT INTO ${CODEX_CONVERSATIONS_TABLE}
      (conversation_key, library_id, kind, paper_item_id, created_at, updated_at, title, provider_session_id, scoped_conversation_key, scope_type, scope_id, scope_label, cwd, model_name, effort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_key) DO UPDATE SET
       library_id = excluded.library_id,
       kind = excluded.kind,
       paper_item_id = excluded.paper_item_id,
       created_at = COALESCE(${CODEX_CONVERSATIONS_TABLE}.created_at, excluded.created_at),
       updated_at = excluded.updated_at,
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
      conversationKey,
      libraryID,
      params.kind,
      normalizePaperItemID(Number(params.paperItemID)) || null,
      createdAt,
      updatedAt,
      normalizeConversationTitleSeed(params.title || "") || null,
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
    ? `SELECT c.conversation_key AS conversationKey,
              c.library_id AS libraryID,
              c.kind AS kind,
              c.paper_item_id AS paperItemID,
              c.created_at AS createdAt,
              ${CODEX_CONVERSATION_ACTIVITY_TIMESTAMP_SQL} AS updatedAt,
              c.title AS title,
              c.provider_session_id AS providerSessionId,
              c.scoped_conversation_key AS scopedConversationKey,
              c.scope_type AS scopeType,
              c.scope_id AS scopeId,
              c.scope_label AS scopeLabel,
              c.cwd AS cwd,
              c.model_name AS modelName,
              c.effort AS effort,
              COALESCE(
                (SELECT COUNT(*)
                 FROM ${CODEX_MESSAGES_TABLE} m
                 WHERE m.conversation_key = c.conversation_key
                   AND m.role = 'user'),
                0
              ) AS userTurnCount
       FROM ${CODEX_CONVERSATIONS_TABLE} c
       WHERE c.library_id = ?
         AND c.kind = 'paper'
         AND c.paper_item_id = ?
       ORDER BY updatedAt DESC, c.conversation_key DESC
       LIMIT ?`
    : `SELECT c.conversation_key AS conversationKey,
              c.library_id AS libraryID,
              c.kind AS kind,
              c.paper_item_id AS paperItemID,
              c.created_at AS createdAt,
              ${CODEX_CONVERSATION_ACTIVITY_TIMESTAMP_SQL} AS updatedAt,
              c.title AS title,
              c.provider_session_id AS providerSessionId,
              c.scoped_conversation_key AS scopedConversationKey,
              c.scope_type AS scopeType,
              c.scope_id AS scopeId,
              c.scope_label AS scopeLabel,
              c.cwd AS cwd,
              c.model_name AS modelName,
              c.effort AS effort,
              COALESCE(
                (SELECT COUNT(*)
                 FROM ${CODEX_MESSAGES_TABLE} m
                 WHERE m.conversation_key = c.conversation_key
                   AND m.role = 'user'),
                0
              ) AS userTurnCount
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
  return rows
    .map((row) => toCodexConversationSummary(row))
    .filter((row): row is CodexConversationSummary => Boolean(row));
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
    `SELECT c.conversation_key AS conversationKey,
            c.library_id AS libraryID,
            c.kind AS kind,
            c.paper_item_id AS paperItemID,
            c.created_at AS createdAt,
            ${CODEX_CONVERSATION_ACTIVITY_TIMESTAMP_SQL} AS updatedAt,
            c.title AS title,
            c.provider_session_id AS providerSessionId,
            c.scoped_conversation_key AS scopedConversationKey,
            c.scope_type AS scopeType,
            c.scope_id AS scopeId,
            c.scope_label AS scopeLabel,
            c.cwd AS cwd,
            c.model_name AS modelName,
            c.effort AS effort,
            COALESCE(
              (SELECT COUNT(*)
               FROM ${CODEX_MESSAGES_TABLE} m
               WHERE m.conversation_key = c.conversation_key
                 AND m.role = 'user'),
              0
            ) AS userTurnCount
     FROM ${CODEX_CONVERSATIONS_TABLE} c
     WHERE c.library_id = ?
       AND c.kind = 'paper'
       AND COALESCE(
         (SELECT COUNT(*)
          FROM ${CODEX_MESSAGES_TABLE} m
          WHERE m.conversation_key = c.conversation_key
            AND m.role = 'user'),
         0
       ) > 0
     ORDER BY updatedAt DESC, c.conversation_key DESC
     LIMIT ?`,
    [normalizedLibraryID, normalizedLimit],
  )) as CodexConversationRow[] | undefined;
  if (!rows?.length) return [];
  return rows
    .map((row) => toCodexConversationSummary(row))
    .filter((row): row is CodexConversationSummary => Boolean(row));
}

export async function ensureCodexGlobalConversation(
  libraryID: number,
): Promise<CodexConversationSummary | null> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  if (!normalizedLibraryID) return null;
  const conversationKey = buildDefaultCodexGlobalConversationKey(normalizedLibraryID);
  await upsertCodexConversationSummary({
    conversationKey,
    libraryID: normalizedLibraryID,
    kind: "global",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
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
  await upsertCodexConversationSummary({
    conversationKey,
    libraryID: normalizedLibraryID,
    kind: "paper",
    paperItemID: normalizedPaperItemID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return getCodexConversationSummary(conversationKey);
}

async function getMaxCodexConversationKey(kind: CodexConversationKind): Promise<number> {
  const range = kind === "global"
    ? getCodexGlobalConversationKeyRange()
    : getCodexPaperConversationKeyRange();
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
    return range.start;
  }
  return Math.floor(maxConversationKey);
}

export async function createCodexGlobalConversation(
  libraryID: number,
): Promise<CodexConversationSummary | null> {
  const normalizedLibraryID = normalizeLibraryID(libraryID);
  if (!normalizedLibraryID) return null;
  const nextKey = Math.max(
    buildDefaultCodexGlobalConversationKey(normalizedLibraryID),
    (getLastAllocatedCodexGlobalConversationKey() || 0) + 1,
    (await getMaxCodexConversationKey("global")) + 1,
  );
  await upsertCodexConversationSummary({
    conversationKey: nextKey,
    libraryID: normalizedLibraryID,
    kind: "global",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
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
    buildDefaultCodexPaperConversationKey(normalizedPaperItemID),
    (getLastAllocatedCodexPaperConversationKey() || 0) + 1,
    (await getMaxCodexConversationKey("paper")) + 1,
  );
  await upsertCodexConversationSummary({
    conversationKey: nextKey,
    libraryID: normalizedLibraryID,
    kind: "paper",
    paperItemID: normalizedPaperItemID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  setLastAllocatedCodexPaperConversationKey(nextKey);
  return getCodexConversationSummary(nextKey);
}

export async function touchCodexConversationTitle(
  conversationKey: number,
  titleSeed: string,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return;
  const title = normalizeConversationTitleSeed(titleSeed);
  if (!title) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${CODEX_CONVERSATIONS_TABLE}
     SET title = ?
     WHERE conversation_key = ?
       AND (title IS NULL OR TRIM(title) = '')`,
    [title, normalizedKey],
  );
}

export async function clearCodexConversationSessionMetadata(
  conversationKey: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return;
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
}

export async function setCodexConversationTitle(
  conversationKey: number,
  titleSeed: string,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${CODEX_CONVERSATIONS_TABLE}
     SET title = ?
     WHERE conversation_key = ?`,
    [normalizeConversationTitleSeed(titleSeed) || null, normalizedKey],
  );
}

export async function deleteCodexConversation(
  conversationKey: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey) return;
  await Zotero.DB.queryAsync(
    `DELETE FROM ${CODEX_CONVERSATIONS_TABLE}
     WHERE conversation_key = ?`,
    [normalizedKey],
  );
}

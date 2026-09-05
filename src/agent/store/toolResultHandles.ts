import {
  installConversationKeyLedgerAgentTriggers,
  isConversationKeyRetiredInMemory,
} from "../../shared/conversationKeyLedger";
import {
  areConversationWritesFrozen,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
} from "../../shared/conversationWriteFence";

export type AgentToolResultHandleRecord = {
  handle: string;
  conversationKey: number;
  toolName: string;
  toolCallId: string;
  inputDigest?: string;
  resourceSignature?: string;
  content: unknown;
  createdAt: number;
};

export type AgentToolResultHandleSeed = {
  conversationKey?: number;
  toolName: string;
  toolCallId: string;
  inputDigest?: string;
  resourceSignature?: string;
  content: unknown;
  createdAt?: number;
};

type ZoteroDb = {
  queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
};

const TOOL_RESULT_HANDLE_TABLE = "llm_for_zotero_agent_tool_result_handles";
const TOOL_RESULT_HANDLE_INDEX =
  "llm_for_zotero_agent_tool_result_handles_conversation_idx";

const handleStore = new Map<string, AgentToolResultHandleRecord>();
const hydratedConversations = new Set<number>();
let initPromise: Promise<boolean> | null = null;

function getDb(): ZoteroDb | null {
  const zotero = (
    globalThis as typeof globalThis & {
      Zotero?: { DB?: ZoteroDb };
      ztoolkit?: { log?: (...args: unknown[]) => void };
    }
  ).Zotero;
  return zotero?.DB || null;
}

function logHandleStoreError(message: string, error: unknown): void {
  const toolkit = (
    globalThis as typeof globalThis & {
      ztoolkit?: { log?: (...args: unknown[]) => void };
    }
  ).ztoolkit;
  toolkit?.log?.(message, error);
}

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function normalizeText(value: unknown, maxChars = 4096): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length > maxChars
    ? normalized.slice(0, maxChars)
    : normalized;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stabilizeForJson(value));
}

function stabilizeForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stabilizeForJson);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const child = record[key];
    if (child === undefined) continue;
    out[key] = stabilizeForJson(child);
  }
  return out;
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function storeKey(conversationKey: number, handle: string): string {
  return `${conversationKey}:${handle}`;
}

function parseStoredContent(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

function normalizeRecord(value: unknown): AgentToolResultHandleRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const conversationKey = normalizePositiveInt(record.conversationKey);
  const handle = normalizeText(record.handle, 160);
  const toolName = normalizeText(record.toolName, 100);
  const toolCallId = normalizeText(record.toolCallId, 160);
  if (!conversationKey || !handle || !toolName || !toolCallId) return null;
  const createdAt = Number(record.createdAt);
  return {
    handle,
    conversationKey,
    toolName,
    toolCallId,
    inputDigest: normalizeText(record.inputDigest, 160),
    resourceSignature: normalizeText(record.resourceSignature, 4096),
    content: parseStoredContent(record.contentJson ?? record.content),
    createdAt: Number.isFinite(createdAt) ? Math.floor(createdAt) : Date.now(),
  };
}

async function ensureAgentToolResultHandleStore(): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      await db.queryAsync(
        `CREATE TABLE IF NOT EXISTS ${TOOL_RESULT_HANDLE_TABLE} (
          conversation_key INTEGER NOT NULL,
          handle TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          input_digest TEXT,
          resource_signature TEXT,
          content_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(conversation_key, handle)
        )`,
      );
      await db.queryAsync(
        `CREATE INDEX IF NOT EXISTS ${TOOL_RESULT_HANDLE_INDEX}
         ON ${TOOL_RESULT_HANDLE_TABLE} (conversation_key, created_at DESC)`,
      );
      await installConversationKeyLedgerAgentTriggers();
      return true;
    } catch (error) {
      logHandleStoreError(
        "LLM Agent: Failed to initialize tool-result handle store",
        error,
      );
      initPromise = null;
      return false;
    }
  })();
  return initPromise;
}

export async function initAgentToolResultHandleStore(): Promise<boolean> {
  return ensureAgentToolResultHandleStore();
}

export function createAgentToolResultHandleRecord(
  seed: AgentToolResultHandleSeed,
): AgentToolResultHandleRecord | null {
  const conversationKey = normalizePositiveInt(seed.conversationKey);
  const toolName = normalizeText(seed.toolName, 100);
  const toolCallId = normalizeText(seed.toolCallId, 160);
  if (!conversationKey || !toolName || !toolCallId) return null;
  const inputDigest = normalizeText(seed.inputDigest, 160);
  const resourceSignature = normalizeText(seed.resourceSignature, 4096);
  const contentDigest = hashText(stableJson(seed.content));
  const handle = `trh_${hashText(
    [
      conversationKey,
      toolName,
      toolCallId,
      inputDigest || "",
      resourceSignature || "",
      contentDigest,
    ].join("\n"),
  )}`;
  return {
    handle,
    conversationKey,
    toolName,
    toolCallId,
    inputDigest,
    resourceSignature,
    content: seed.content,
    createdAt: normalizePositiveInt(seed.createdAt) || Date.now(),
  };
}

export async function hydrateAgentToolResultHandles(
  conversationKeyValue: number,
): Promise<void> {
  const conversationKey = normalizePositiveInt(conversationKeyValue);
  if (!conversationKey || hydratedConversations.has(conversationKey)) return;
  const expectedGeneration = getConversationWriteGeneration(conversationKey);
  const dbReady = await ensureAgentToolResultHandleStore();
  const db = getDb();
  if (!dbReady || !db) {
    hydratedConversations.add(conversationKey);
    return;
  }
  try {
    const rows = (await db.queryAsync(
      `SELECT conversation_key AS conversationKey,
              handle,
              tool_name AS toolName,
              tool_call_id AS toolCallId,
              input_digest AS inputDigest,
              resource_signature AS resourceSignature,
              content_json AS contentJson,
              created_at AS createdAt
       FROM ${TOOL_RESULT_HANDLE_TABLE}
       WHERE conversation_key = ?`,
      [conversationKey],
    )) as unknown[] | undefined;
    if (
      isConversationKeyRetiredInMemory(conversationKey) ||
      areConversationWritesFrozen(conversationKey) ||
      !isConversationWriteGenerationCurrent(conversationKey, expectedGeneration)
    ) {
      return;
    }
    for (const row of rows || []) {
      const record = normalizeRecord(row);
      if (!record) continue;
      handleStore.set(storeKey(record.conversationKey, record.handle), record);
    }
  } catch (error) {
    logHandleStoreError(
      "LLM Agent: Failed to hydrate tool-result handles",
      error,
    );
  }
  hydratedConversations.add(conversationKey);
}

export async function upsertAgentToolResultHandles(
  records: AgentToolResultHandleRecord[],
): Promise<void> {
  const normalized = records
    .map((record) => normalizeRecord(record))
    .filter((record): record is AgentToolResultHandleRecord => Boolean(record));
  if (!normalized.length) return;
  for (const record of normalized) {
    if (isConversationKeyRetiredInMemory(record.conversationKey)) continue;
    handleStore.set(storeKey(record.conversationKey, record.handle), record);
  }
  const dbReady = await ensureAgentToolResultHandleStore();
  const db = getDb();
  if (!dbReady || !db) return;
  try {
    for (const record of normalized) {
      if (isConversationKeyRetiredInMemory(record.conversationKey)) continue;
      await db.queryAsync(
        `INSERT OR REPLACE INTO ${TOOL_RESULT_HANDLE_TABLE}
          (conversation_key, handle, tool_name, tool_call_id, input_digest, resource_signature, content_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.conversationKey,
          record.handle,
          record.toolName,
          record.toolCallId,
          record.inputDigest || null,
          record.resourceSignature || null,
          JSON.stringify(record.content),
          record.createdAt,
        ],
      );
    }
  } catch (error) {
    for (const record of normalized) {
      if (isConversationKeyRetiredInMemory(record.conversationKey)) {
        const prefix = `${record.conversationKey}:`;
        for (const key of Array.from(handleStore.keys())) {
          if (key.startsWith(prefix)) handleStore.delete(key);
        }
      }
    }
    logHandleStoreError(
      "LLM Agent: Failed to persist tool-result handles",
      error,
    );
  }
}

export async function getAgentToolResultHandle(params: {
  conversationKey: number;
  handle: string;
}): Promise<AgentToolResultHandleRecord | null> {
  const conversationKey = normalizePositiveInt(params.conversationKey);
  const handle = normalizeText(params.handle, 160);
  if (!conversationKey || !handle) return null;
  await hydrateAgentToolResultHandles(conversationKey);
  return handleStore.get(storeKey(conversationKey, handle)) || null;
}

export function hasAgentToolResultHandles(
  conversationKeyValue: number,
): boolean {
  const conversationKey = normalizePositiveInt(conversationKeyValue);
  if (!conversationKey) return false;
  const prefix = `${conversationKey}:`;
  return Array.from(handleStore.keys()).some((key) => key.startsWith(prefix));
}

export function clearAgentToolResultHandleStore(): void {
  handleStore.clear();
  hydratedConversations.clear();
}

export async function clearPersistedAgentToolResultHandles(
  conversationKeyValue?: number,
): Promise<void> {
  if (conversationKeyValue === undefined) {
    handleStore.clear();
    hydratedConversations.clear();
  } else {
    const conversationKey = normalizePositiveInt(conversationKeyValue);
    if (conversationKey) {
      const prefix = `${conversationKey}:`;
      for (const key of Array.from(handleStore.keys())) {
        if (key.startsWith(prefix)) handleStore.delete(key);
      }
      hydratedConversations.delete(conversationKey);
    }
  }
  const dbReady = await ensureAgentToolResultHandleStore();
  const db = getDb();
  if (!dbReady || !db) return;
  try {
    if (conversationKeyValue === undefined) {
      await db.queryAsync(`DELETE FROM ${TOOL_RESULT_HANDLE_TABLE}`);
      return;
    }
    const conversationKey = normalizePositiveInt(conversationKeyValue);
    if (!conversationKey) return;
    await db.queryAsync(
      `DELETE FROM ${TOOL_RESULT_HANDLE_TABLE}
       WHERE conversation_key = ?`,
      [conversationKey],
    );
  } catch (error) {
    logHandleStoreError(
      "LLM Agent: Failed to clear tool-result handles",
      error,
    );
  }
}

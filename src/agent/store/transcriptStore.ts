import type {
  AgentModelContentPart,
  AgentModelMessage,
  AgentRuntimeRequest,
  ToolSpec,
} from "../types";
import {
  installConversationKeyLedgerAgentTriggers,
  isConversationKeyRetiredInMemory,
} from "../../shared/conversationKeyLedger";
import {
  areConversationWritesFrozen,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
} from "../../shared/conversationWriteFence";

type ZoteroDb = {
  queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
  executeTransaction: <T>(task: () => Promise<T>) => Promise<T>;
};

export type AgentTranscriptSegment = {
  conversationKey: number;
  compatibilityKey: string;
  messages: AgentModelMessage[];
  compactedAt?: number;
};

export type AgentTranscriptWriteResult =
  | "persisted"
  | "memory_only"
  | "failed"
  | "skipped";

export type AgentTranscriptCompatibilityInput = {
  request: AgentRuntimeRequest;
  resourceSignature: string;
  stableContextBlock: string;
  tools: ToolSpec[];
};

const TRANSCRIPT_TABLE = "llm_for_zotero_agent_transcript";
const TRANSCRIPT_INDEX = "llm_for_zotero_agent_transcript_key_idx";
const TRANSCRIPT_SCHEMA_VERSION = 1;

const transcriptByKey = new Map<string, AgentTranscriptSegment>();
const hydratedKeys = new Set<string>();
let initPromise: Promise<boolean> | null = null;

function getDb(): ZoteroDb | null {
  const zotero = (
    globalThis as typeof globalThis & {
      Zotero?: { DB?: ZoteroDb };
    }
  ).Zotero;
  return zotero?.DB || null;
}

function logTranscriptStoreError(message: string, error: unknown): void {
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

function segmentKey(conversationKey: number, compatibilityKey: string): string {
  return `${normalizePositiveInt(conversationKey) || 0}:${compatibilityKey}`;
}

function normalizeMessage(value: unknown): AgentModelMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as AgentModelMessage;
  if (
    record.role !== "user" &&
    record.role !== "assistant" &&
    record.role !== "tool"
  ) {
    return null;
  }
  return sanitizeMessageForTranscript(record);
}

function sanitizeContentForTranscript(
  content: AgentModelMessage["content"],
): AgentModelMessage["content"] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: AgentModelContentPart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push(part);
      continue;
    }
    if (part.type === "image_url") {
      parts.push({
        type: "text",
        text: "[Image artifact omitted from reusable transcript.]",
      });
      continue;
    }
    parts.push({
      type: "text",
      text: `[Prepared file omitted from reusable transcript: ${part.file_ref.name}]`,
    });
  }
  return parts;
}

function stringifyTranscriptContent(
  content: AgentModelMessage["content"],
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const sanitized = sanitizeContentForTranscript(content);
  if (typeof sanitized === "string") return sanitized;
  return sanitized
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function sanitizeMessageForTranscript(
  message: AgentModelMessage,
): AgentModelMessage {
  if (message.role === "tool") {
    return {
      ...message,
      content: stringifyTranscriptContent(message.content),
    };
  }
  return {
    ...message,
    content: sanitizeContentForTranscript(message.content),
  };
}

/**
 * Drops assistant `tool_calls` that no `role:"tool"` reply ever answered.
 *
 * An assistant message carrying a round's whole `tool_calls` list is recorded
 * before the per-call loop runs, and that loop can bail mid-list — a denial
 * that ends the run, an error breaker, a review card the user declines. The
 * unanswered calls then sit in the persisted transcript forever, and
 * OpenAI-compatible providers reject the next request outright with a 400,
 * breaking the conversation until the compatibility key changes.
 *
 * The Anthropic and Gemini adapters already filter orphans at render time,
 * which is the tell that this invariant is known and that the OpenAI path was
 * relying on the producer never emitting one. Enforcing it in the store fixes
 * every producer at once, including the pre-existing declined-review-card
 * path that could already do this on a *completed* run.
 */
function dropOrphanToolCalls(
  messages: readonly AgentModelMessage[],
): AgentModelMessage[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message?.role !== "tool") continue;
    const id = (message as { tool_call_id?: unknown }).tool_call_id;
    if (typeof id === "string" && id) answered.add(id);
  }

  const result: AgentModelMessage[] = [];
  for (const message of messages) {
    const calls = (message as { tool_calls?: unknown }).tool_calls;
    if (
      message?.role !== "assistant" ||
      !Array.isArray(calls) ||
      !calls.length
    ) {
      result.push(message);
      continue;
    }
    const kept = calls.filter((call) => {
      const id = (call as { id?: unknown })?.id;
      return typeof id === "string" && answered.has(id);
    });
    if (kept.length === calls.length) {
      result.push(message);
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (!kept.length && !String(content ?? "").trim()) {
      // Nothing left worth keeping: an assistant turn that only announced
      // calls, none of which were answered.
      continue;
    }
    result.push({ ...message, tool_calls: kept } as AgentModelMessage);
  }
  return result;
}

function normalizeMessages(
  messages: readonly AgentModelMessage[],
): AgentModelMessage[] {
  return dropOrphanToolCalls(
    messages
      .map((message) => normalizeMessage(message))
      .filter((message): message is AgentModelMessage => Boolean(message)),
  );
}

async function ensureAgentTranscriptStore(): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      await db.queryAsync(
        `CREATE TABLE IF NOT EXISTS ${TRANSCRIPT_TABLE} (
          conversation_key INTEGER NOT NULL,
          compatibility_key TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          message_json TEXT NOT NULL,
          compacted_at INTEGER,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(conversation_key, compatibility_key, sequence)
        )`,
      );
      await db.queryAsync(
        `CREATE INDEX IF NOT EXISTS ${TRANSCRIPT_INDEX}
         ON ${TRANSCRIPT_TABLE} (conversation_key, compatibility_key, sequence)`,
      );
      await installConversationKeyLedgerAgentTriggers();
      return true;
    } catch (error) {
      initPromise = null;
      logTranscriptStoreError(
        "LLM Agent: Failed to initialize transcript store",
        error,
      );
      return false;
    }
  })();
  return initPromise;
}

export async function initAgentTranscriptStore(): Promise<boolean> {
  return ensureAgentTranscriptStore();
}

export function buildAgentTranscriptCompatibilityKey(
  params: AgentTranscriptCompatibilityInput,
): string {
  const request = params.request;
  const toolShape = params.tools.map((tool) => ({
    name: tool.name,
    inputSchema: tool.inputSchema,
  }));
  return hashText(
    stableJson({
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      providerProtocol: request.providerProtocol || "",
      authMode: request.authMode || "",
      apiBase: request.apiBase || "",
      model: request.model || "",
      systemPrompt: request.systemPrompt || "",
      customInstructions: request.customInstructions || "",
      resourceSignature: params.resourceSignature,
      stableContextHash: hashText(params.stableContextBlock || ""),
      toolShape,
    }),
  );
}

async function hydrateTranscriptSegment(params: {
  conversationKey: number;
  compatibilityKey: string;
}): Promise<void> {
  const conversationKey = normalizePositiveInt(params.conversationKey);
  if (!conversationKey) return;
  const expectedGeneration = getConversationWriteGeneration(conversationKey);
  const key = segmentKey(conversationKey, params.compatibilityKey);
  if (hydratedKeys.has(key)) return;
  const dbReady = await ensureAgentTranscriptStore();
  const db = getDb();
  if (!dbReady || !db) return;
  try {
    const rows = (await db.queryAsync(
      `SELECT message_json AS messageJson,
              compacted_at AS compactedAt
       FROM ${TRANSCRIPT_TABLE}
       WHERE conversation_key = ?
         AND compatibility_key = ?
       ORDER BY sequence ASC`,
      [conversationKey, params.compatibilityKey],
    )) as
      | Array<{
          messageJson?: unknown;
          compactedAt?: unknown;
        }>
      | undefined;
    if (
      isConversationKeyRetiredInMemory(conversationKey) ||
      areConversationWritesFrozen(conversationKey) ||
      !isConversationWriteGenerationCurrent(conversationKey, expectedGeneration)
    ) {
      return;
    }
    if (!rows?.length) {
      hydratedKeys.add(key);
      return;
    }
    const messages: AgentModelMessage[] = [];
    let compactedAt: number | undefined;
    for (const row of rows) {
      if (compactedAt === undefined) {
        compactedAt = normalizePositiveInt(row.compactedAt);
      }
      const raw = typeof row.messageJson === "string" ? row.messageJson : "";
      if (!raw) continue;
      try {
        const message = normalizeMessage(JSON.parse(raw) as unknown);
        if (message) messages.push(message);
      } catch {
        // Ignore malformed transcript rows; future successful runs replace them.
      }
    }
    transcriptByKey.set(key, {
      conversationKey,
      compatibilityKey: params.compatibilityKey,
      messages,
      compactedAt,
    });
    hydratedKeys.add(key);
  } catch (error) {
    logTranscriptStoreError("LLM Agent: Failed to hydrate transcript", error);
  }
}

export async function loadAgentTranscriptSegment(params: {
  conversationKey: number;
  compatibilityKey: string;
}): Promise<AgentTranscriptSegment> {
  const conversationKey = normalizePositiveInt(params.conversationKey) || 0;
  const key = segmentKey(conversationKey, params.compatibilityKey);
  await hydrateTranscriptSegment({
    conversationKey,
    compatibilityKey: params.compatibilityKey,
  });
  return (
    transcriptByKey.get(key) || {
      conversationKey,
      compatibilityKey: params.compatibilityKey,
      messages: [],
    }
  );
}

export async function loadLatestAgentTranscriptSegment(
  conversationKeyValue: number,
): Promise<AgentTranscriptSegment | null> {
  const conversationKey = normalizePositiveInt(conversationKeyValue);
  if (!conversationKey) return null;
  const dbReady = await ensureAgentTranscriptStore();
  const db = getDb();
  if (!dbReady || !db) return null;
  try {
    const rows = (await db.queryAsync(
      `SELECT compatibility_key AS compatibilityKey
       FROM ${TRANSCRIPT_TABLE}
       WHERE conversation_key = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
      [conversationKey],
    )) as Array<{ compatibilityKey?: unknown }> | undefined;
    const compatibilityKey = rows?.[0]?.compatibilityKey;
    if (typeof compatibilityKey !== "string" || !compatibilityKey) return null;
    return loadAgentTranscriptSegment({ conversationKey, compatibilityKey });
  } catch (error) {
    logTranscriptStoreError(
      "LLM Agent: Failed to load latest transcript segment",
      error,
    );
    return null;
  }
}

async function persistTranscriptSegment(
  segment: AgentTranscriptSegment,
): Promise<"persisted" | "unavailable" | "failed"> {
  const dbReady = await ensureAgentTranscriptStore();
  const db = getDb();
  if (!dbReady || !db) return "unavailable";
  try {
    await db.executeTransaction(async () => {
      await db.queryAsync(
        `DELETE FROM ${TRANSCRIPT_TABLE}
         WHERE conversation_key = ?
           AND compatibility_key = ?`,
        [segment.conversationKey, segment.compatibilityKey],
      );
      const createdAt = Date.now();
      for (let index = 0; index < segment.messages.length; index += 1) {
        await db.queryAsync(
          `INSERT INTO ${TRANSCRIPT_TABLE}
            (conversation_key, compatibility_key, sequence, message_json, compacted_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            segment.conversationKey,
            segment.compatibilityKey,
            index,
            stableJson(segment.messages[index]),
            segment.compactedAt || null,
            createdAt,
          ],
        );
      }
    });
    return "persisted";
  } catch (error) {
    logTranscriptStoreError("LLM Agent: Failed to persist transcript", error);
    return "failed";
  }
}

export async function replaceAgentTranscriptSegment(
  segment: AgentTranscriptSegment,
): Promise<AgentTranscriptWriteResult> {
  if (isConversationKeyRetiredInMemory(segment.conversationKey)) {
    return "skipped";
  }
  const normalized: AgentTranscriptSegment = {
    ...segment,
    messages: normalizeMessages(segment.messages),
  };
  const persistence = await persistTranscriptSegment(normalized);
  if (persistence === "failed") return "failed";
  const key = segmentKey(
    normalized.conversationKey,
    normalized.compatibilityKey,
  );
  transcriptByKey.set(key, normalized);
  hydratedKeys.add(key);
  return persistence === "persisted" ? "persisted" : "memory_only";
}

export async function appendAgentTranscriptMessages(params: {
  conversationKey: number;
  compatibilityKey: string;
  messages: AgentModelMessage[];
}): Promise<void> {
  const current = await loadAgentTranscriptSegment({
    conversationKey: params.conversationKey,
    compatibilityKey: params.compatibilityKey,
  });
  await replaceAgentTranscriptSegment({
    ...current,
    messages: [...current.messages, ...normalizeMessages(params.messages)],
  });
}

export function clearAgentTranscriptStore(): void {
  transcriptByKey.clear();
  hydratedKeys.clear();
}

export async function clearAgentTranscript(
  conversationKeyValue?: number,
): Promise<void> {
  if (conversationKeyValue === undefined) {
    transcriptByKey.clear();
    hydratedKeys.clear();
  } else {
    const conversationKey = normalizePositiveInt(conversationKeyValue);
    if (conversationKey) {
      const prefix = `${conversationKey}:`;
      for (const key of Array.from(transcriptByKey.keys())) {
        if (key.startsWith(prefix)) transcriptByKey.delete(key);
      }
      for (const key of Array.from(hydratedKeys.keys())) {
        if (key.startsWith(prefix)) hydratedKeys.delete(key);
      }
    }
  }
  const dbReady = await ensureAgentTranscriptStore();
  const db = getDb();
  if (!dbReady || !db) return;
  try {
    if (conversationKeyValue === undefined) {
      await db.queryAsync(`DELETE FROM ${TRANSCRIPT_TABLE}`);
      return;
    }
    const conversationKey = normalizePositiveInt(conversationKeyValue);
    if (!conversationKey) return;
    await db.queryAsync(
      `DELETE FROM ${TRANSCRIPT_TABLE} WHERE conversation_key = ?`,
      [conversationKey],
    );
  } catch (error) {
    logTranscriptStoreError("LLM Agent: Failed to clear transcript", error);
  }
}

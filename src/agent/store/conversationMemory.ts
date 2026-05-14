/**
 * Per-conversation agent turn memory.
 *
 * The runtime stores a compact summary of recent completed turns so future
 * turns can reuse prior findings without re-running the same tools. The store
 * keeps an in-memory cache and mirrors entries to SQLite when Zotero.DB is
 * available, so memory survives UI reloads.
 */

type TurnMemory = {
  question: string;
  toolsUsed: string[];
  answerExcerpt: string;
};

type ZoteroDb = {
  queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
};

const MEMORY_TABLE = "llm_for_zotero_agent_memory";
const MAX_MEMORY_TURNS = 6;
const QUESTION_EXCERPT_LEN = 200;
const ANSWER_EXCERPT_LEN = 350;

const store = new Map<number, TurnMemory[]>();
let initPromise: Promise<boolean> | null = null;

function getDb(): ZoteroDb | null {
  const zotero = (
    globalThis as typeof globalThis & {
      Zotero?: { DB?: ZoteroDb };
    }
  ).Zotero;
  return zotero?.DB || null;
}

async function ensureConversationMemoryStore(): Promise<boolean> {
  if (initPromise) {
    return initPromise;
  }
  initPromise = (async () => {
    const db = getDb();
    if (!db) return false;
    try {
      await db.queryAsync(
        `CREATE TABLE IF NOT EXISTS ${MEMORY_TABLE} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_key INTEGER NOT NULL,
          question_excerpt TEXT NOT NULL,
          tools_used_json TEXT NOT NULL,
          answer_excerpt TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`,
      );
      return true;
    } catch (error) {
      ztoolkit.log(
        "LLM Agent: Failed to initialize conversation memory store",
        error,
      );
      return false;
    }
  })();
  return initPromise;
}

export async function initConversationMemoryStore(): Promise<boolean> {
  return ensureConversationMemoryStore();
}

function normalizeConversationKey(conversationKey: number): number | null {
  const key = Math.floor(conversationKey);
  if (!Number.isFinite(key) || key <= 0) return null;
  return key;
}

function clipTurnMemory(
  question: string,
  toolsUsed: string[],
  finalAnswer: string,
): TurnMemory {
  return {
    question: question.trim().slice(0, QUESTION_EXCERPT_LEN),
    toolsUsed: [...new Set(toolsUsed)],
    answerExcerpt: finalAnswer.trim().slice(0, ANSWER_EXCERPT_LEN),
  };
}

function formatMemoryBlock(turns: TurnMemory[]): string {
  if (!turns.length) return "";
  const lines: string[] = [
    "Conversation continuity notes (not a substitute for preserved evidence):",
  ];
  for (const turn of turns) {
    lines.push(
      `- User asked: "${turn.question}${turn.question.length >= QUESTION_EXCERPT_LEN ? "…" : ""}"`,
    );
    if (turn.toolsUsed.length) {
      lines.push(`  Tools used: ${turn.toolsUsed.join(", ")}`);
    }
    lines.push(
      `  Finding: ${turn.answerExcerpt}${turn.answerExcerpt.length >= ANSWER_EXCERPT_LEN ? "…" : ""}`,
    );
  }
  return lines.join("\n");
}

async function loadConversationMemory(
  conversationKey: number,
): Promise<TurnMemory[]> {
  const dbReady = await ensureConversationMemoryStore();
  const db = getDb();
  if (!dbReady || !db) return [];
  try {
    const rows = (await db.queryAsync(
      `SELECT question_excerpt AS questionExcerpt,
              tools_used_json AS toolsUsedJson,
              answer_excerpt AS answerExcerpt
       FROM ${MEMORY_TABLE}
       WHERE conversation_key = ?
       ORDER BY id DESC
       LIMIT ?`,
      [conversationKey, MAX_MEMORY_TURNS],
    )) as
      | Array<{
          questionExcerpt?: unknown;
          toolsUsedJson?: unknown;
          answerExcerpt?: unknown;
        }>
      | undefined;
    if (!rows?.length) return [];
    return rows
      .reverse()
      .map((row) => {
        let toolsUsed: string[] = [];
        try {
          toolsUsed = JSON.parse(String(row.toolsUsedJson || "[]")) as string[];
        } catch {
          toolsUsed = [];
        }
        return {
          question:
            typeof row.questionExcerpt === "string" ? row.questionExcerpt : "",
          toolsUsed: Array.isArray(toolsUsed)
            ? toolsUsed.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : [],
          answerExcerpt:
            typeof row.answerExcerpt === "string" ? row.answerExcerpt : "",
        };
      })
      .filter((entry) => entry.question || entry.answerExcerpt);
  } catch (error) {
    ztoolkit.log("LLM Agent: Failed to load conversation memory", error);
    return [];
  }
}

export async function recordAgentTurn(
  conversationKey: number,
  question: string,
  toolsUsed: string[],
  finalAnswer: string,
): Promise<void> {
  const key = normalizeConversationKey(conversationKey);
  if (!key) return;
  const entry = clipTurnMemory(question, toolsUsed, finalAnswer);
  const existing = store.get(key) ?? [];
  existing.push(entry);
  store.set(key, existing.slice(-MAX_MEMORY_TURNS));

  const dbReady = await ensureConversationMemoryStore();
  const db = getDb();
  if (!dbReady || !db) return;
  try {
    await db.queryAsync(
      `INSERT INTO ${MEMORY_TABLE}
        (conversation_key, question_excerpt, tools_used_json, answer_excerpt, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        key,
        entry.question,
        JSON.stringify(entry.toolsUsed),
        entry.answerExcerpt,
        Date.now(),
      ],
    );
    await db.queryAsync(
      `DELETE FROM ${MEMORY_TABLE}
       WHERE conversation_key = ?
         AND id NOT IN (
           SELECT id
           FROM ${MEMORY_TABLE}
           WHERE conversation_key = ?
           ORDER BY id DESC
           LIMIT ?
         )`,
      [key, key, MAX_MEMORY_TURNS],
    );
  } catch (error) {
    ztoolkit.log("LLM Agent: Failed to persist conversation memory", error);
  }
}

/**
 * Returns a formatted block summarising what the agent found in prior turns,
 * or an empty string when no memory exists for the conversation.
 */
export async function buildAgentMemoryBlock(
  conversationKey: number,
): Promise<string> {
  const key = normalizeConversationKey(conversationKey);
  if (!key) return "";
  let turns = store.get(key);
  if (!turns?.length) {
    turns = await loadConversationMemory(key);
    if (turns.length) {
      store.set(key, turns);
    }
  }
  return formatMemoryBlock(turns || []);
}

export async function clearAgentMemory(conversationKey: number): Promise<void> {
  const key = normalizeConversationKey(conversationKey);
  if (!key) return;
  store.delete(key);
  const dbReady = await ensureConversationMemoryStore();
  const db = getDb();
  if (!dbReady || !db) return;
  try {
    await db.queryAsync(
      `DELETE FROM ${MEMORY_TABLE}
       WHERE conversation_key = ?`,
      [key],
    );
  } catch (error) {
    ztoolkit.log("LLM Agent: Failed to clear conversation memory", error);
  }
}

/**
 * Local usage ledger: one row per completed user turn.
 *
 * Everything here is local-only.  No telemetry, no network, no account: the
 * rows exist so the user can read their own numbers back out of their own
 * database.
 *
 * Schema fencing note: SQLite tables live in `zotero.sqlite` and survive a
 * plugin downgrade, so this store fences on `conversation_key` -- the identity
 * every plugin version has always understood -- and never on a column a newer
 * version introduced.  `initUsageStore` is idempotent and re-entrant: it uses
 * `CREATE TABLE IF NOT EXISTS`, adds any column a downgrade/upgrade cycle left
 * missing, and shares one in-flight promise between concurrent callers.  It
 * holds no transaction, so it never contends with Zotero's startup
 * transactions (issue #485).
 */

import { appLogger } from "../core/logging";
import {
  classifyConversationKey,
  isEphemeralConversationKey,
  type ConversationKeyKind,
} from "../shared/conversationKeySpace";
import { getRegisteredConversationScope } from "../shared/conversationRegistry";

export const USAGE_EVENTS_TABLE = "llm_for_zotero_usage_events";

/** Paper chat vs library chat: the split the Usage view is built around. */
export type UsageEventMode = "paper" | "library";

/** Which runtime produced the turn, as honestly as the call site can report. */
export type UsageEventRuntime = "chat" | "agent" | "codex" | "claude-code";

/**
 * Where a row's token numbers came from.
 *
 * Without this a turn the provider never billed back reads exactly like a
 * genuinely free turn: both are zeros. The three values are deliberately
 * open-ended text rather than a CHECK constraint, because the column lives in
 * `zotero.sqlite` and must survive a build that knows one more value than the
 * build that created it.
 *
 *   - `provider`: the provider reported these numbers. Trust them.
 *   - `unreported`: the turn was dispatched and billed, but no usage payload
 *     ever arrived. The tokens are UNKNOWN, not zero.
 *   - `history-estimate`: reconstructed locally from stored messages for turns
 *     that predate the ledger. Nothing in this module writes it yet; the
 *     backfill that will is a separate change.
 */
export type UsageTokenSource = "provider" | "unreported" | "history-estimate";

export const DEFAULT_USAGE_TOKEN_SOURCE: UsageTokenSource = "provider";

function normalizeTokenSource(value: unknown): UsageTokenSource {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? (text as UsageTokenSource) : DEFAULT_USAGE_TOKEN_SOURCE;
}

export type UsageEventInput = {
  /** Epoch milliseconds. Defaults to now. */
  timestamp?: number;
  mode: UsageEventMode;
  conversationKey: number;
  conversationInstanceID?: string | null;
  libraryID?: number | null;
  paperItemID?: number | null;
  model?: string | null;
  provider?: string | null;
  runtime?: UsageEventRuntime | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Defaults to `provider`: a caller that says nothing measured its numbers. */
  tokenSource?: UsageTokenSource;
  /**
   * False for a retry of an already-counted turn. The tokens a retry burns are
   * real and are still recorded; only the question tally must not move twice.
   */
  countsAsQuestion?: boolean;
};

export type StoredUsageEvent = {
  id: number;
  timestamp: number;
  localDate: string;
  mode: UsageEventMode;
  conversationKey: number;
  conversationInstanceID: string | null;
  libraryID: number | null;
  paperItemID: number | null;
  model: string | null;
  provider: string | null;
  runtime: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  countsAsQuestion: boolean;
  tokenSource: UsageTokenSource;
};

type UsageDb = {
  queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
};

const USAGE_COLUMNS: Array<{ name: string; definition: string }> = [
  { name: "timestamp", definition: "timestamp INTEGER NOT NULL DEFAULT 0" },
  { name: "local_date", definition: "local_date TEXT NOT NULL DEFAULT ''" },
  { name: "mode", definition: "mode TEXT NOT NULL DEFAULT 'library'" },
  {
    name: "conversation_key",
    definition: "conversation_key INTEGER NOT NULL DEFAULT 0",
  },
  {
    name: "conversation_instance_id",
    definition: "conversation_instance_id TEXT",
  },
  { name: "library_id", definition: "library_id INTEGER" },
  { name: "paper_item_id", definition: "paper_item_id INTEGER" },
  { name: "model", definition: "model TEXT" },
  { name: "provider", definition: "provider TEXT" },
  { name: "runtime", definition: "runtime TEXT" },
  {
    name: "prompt_tokens",
    definition: "prompt_tokens INTEGER NOT NULL DEFAULT 0",
  },
  {
    name: "completion_tokens",
    definition: "completion_tokens INTEGER NOT NULL DEFAULT 0",
  },
  {
    name: "total_tokens",
    definition: "total_tokens INTEGER NOT NULL DEFAULT 0",
  },
  {
    name: "cache_read_tokens",
    definition: "cache_read_tokens INTEGER NOT NULL DEFAULT 0",
  },
  {
    name: "cache_write_tokens",
    definition: "cache_write_tokens INTEGER NOT NULL DEFAULT 0",
  },
  {
    name: "counts_as_question",
    definition: "counts_as_question INTEGER NOT NULL DEFAULT 1",
  },
  {
    name: "token_source",
    definition: `token_source TEXT NOT NULL DEFAULT '${DEFAULT_USAGE_TOKEN_SOURCE}'`,
  },
];

/**
 * The rows the healing pass below owns: all-zero tokens still claiming to be
 * provider-measured. Written once and used BOTH as the index predicate and as
 * the UPDATE's WHERE clause, because SQLite only uses a partial index when the
 * statement's condition matches the index's -- if these two ever drifted apart
 * the healing pass would silently go back to scanning the whole ledger.
 */
const UNREPORTED_HEAL_PREDICATE = `total_tokens = 0
        AND prompt_tokens = 0
        AND completion_tokens = 0
        AND token_source = '${DEFAULT_USAGE_TOKEN_SOURCE}'`;

/** Named so a test can prove the healing pass really uses it. */
export const USAGE_UNREPORTED_HEAL_INDEX =
  "llm_for_zotero_usage_events_unreported_heal";

/**
 * Rows written before `token_source` existed -- and rows an older build wrote
 * after a downgrade, which take the column DEFAULT -- claim to be
 * provider-measured. A provider that reports usage never reports a zero total,
 * so `provider` with zero tokens can only mean the payload never arrived.
 *
 * Exported so the schema pass and its test name the same statement.
 */
export const USAGE_UNREPORTED_HEAL_SQL = `UPDATE ${USAGE_EVENTS_TABLE}
        SET token_source = 'unreported'
      WHERE ${UNREPORTED_HEAL_PREDICATE}`;

const USAGE_INDEXES: Array<{ name: string; columns: string }> = [
  { name: "llm_for_zotero_usage_events_local_date", columns: "(local_date)" },
  {
    name: "llm_for_zotero_usage_events_conversation",
    columns: "(conversation_key)",
  },
  {
    name: "llm_for_zotero_usage_events_mode_date",
    columns: "(mode, local_date)",
  },
  { name: "llm_for_zotero_usage_events_paper", columns: "(paper_item_id)" },
  {
    // PARTIAL: it indexes only the rows that still need healing, which on a
    // healthy ledger is none of them. That keeps the every-startup healing
    // UPDATE an index lookup on an empty index instead of a full scan of a
    // year of usage rows -- measured at 100k rows: 6.9 ms scan vs 0.02 ms
    // lookup -- and costs an index entry only for a row that is actually
    // waiting to be healed.
    name: USAGE_UNREPORTED_HEAL_INDEX,
    columns: `(token_source) WHERE ${UNREPORTED_HEAL_PREDICATE}`,
  },
];

let initPromise: Promise<void> | null = null;

function getUsageDb(): UsageDb | null {
  const db = (globalThis as { Zotero?: { DB?: { queryAsync?: unknown } } })
    .Zotero?.DB;
  return typeof db?.queryAsync === "function" ? (db as UsageDb) : null;
}

function logUsageStoreWarning(message: string, error?: unknown): void {
  appLogger.warn(`LLM: ${message}`, error);
}

function normalizePositiveInt(value: unknown): number | null {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeTokenCount(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * The heatmap must line up with the user's own days, so the calendar day is
 * computed once, at write time, from the local clock. A UTC date would move a
 * late-evening question into tomorrow for most of the world.
 */
export function toLocalDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Paper chat vs library chat, derived from the conversation key space so the
 * answer is the same for upstream, Codex, and Claude Code conversations.
 */
export function resolveUsageModeForConversationKey(
  conversationKey: number,
): UsageEventMode {
  const kind: ConversationKeyKind | undefined =
    classifyConversationKey(conversationKey)?.kind;
  return kind === "paper" ? "paper" : "library";
}

async function createUsageSchema(db: UsageDb): Promise<void> {
  await db.queryAsync(
    `CREATE TABLE IF NOT EXISTS ${USAGE_EVENTS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      local_date TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('paper','library')),
      conversation_key INTEGER NOT NULL,
      conversation_instance_id TEXT,
      library_id INTEGER,
      paper_item_id INTEGER,
      model TEXT,
      provider TEXT,
      runtime TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      counts_as_question INTEGER NOT NULL DEFAULT 1,
      token_source TEXT NOT NULL DEFAULT '${DEFAULT_USAGE_TOKEN_SOURCE}'
    )`,
  );
  const columnRows = (await db.queryAsync(
    `PRAGMA table_info(${USAGE_EVENTS_TABLE})`,
  )) as Array<{ name?: unknown }> | undefined;
  const present = new Set(
    (columnRows || [])
      .map((row) => (typeof row?.name === "string" ? row.name : ""))
      .filter(Boolean),
  );
  // A database written by a newer build and then reopened by an older one can
  // come back missing a column this build expects. Add what is absent instead
  // of failing every write from then on.
  for (const column of USAGE_COLUMNS) {
    if (present.has(column.name)) continue;
    await db.queryAsync(
      `ALTER TABLE ${USAGE_EVENTS_TABLE} ADD COLUMN ${column.definition}`,
    );
  }
  for (const index of USAGE_INDEXES) {
    await db.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${index.name}
       ON ${USAGE_EVENTS_TABLE} ${index.columns}`,
    );
  }
  // Heal any row that still claims a provenance it cannot have (see
  // USAGE_UNREPORTED_HEAL_SQL). Re-run every pass so a downgrade/upgrade cycle
  // heals itself; it touches nothing that already carries an honest
  // provenance, and the partial index above keeps that promise cheap -- the
  // statement must run AFTER the index loop for the planner to use it.
  await db.queryAsync(USAGE_UNREPORTED_HEAL_SQL);
}

/**
 * Idempotent and re-entrant: concurrent callers share one schema pass.
 *
 * No transaction is held: every statement is idempotent and individually
 * atomic, and a startup `executeTransaction` would occupy Zotero's single
 * transaction slot while its library load runs (issue #485).
 */
export async function initUsageStore(): Promise<void> {
  if (initPromise) return initPromise;
  const db = getUsageDb();
  if (!db) return;
  initPromise = createUsageSchema(db);
  try {
    await initPromise;
  } catch (error) {
    initPromise = null;
    throw error;
  }
}

/**
 * Append one usage row. Callers are chat turns: this must never throw into a
 * streaming path, so failures are logged and swallowed and the return value
 * says whether a row landed.
 */
export async function recordUsageEvent(
  input: UsageEventInput,
): Promise<boolean> {
  try {
    const db = getUsageDb();
    if (!db) return false;
    const conversationKey = normalizePositiveInt(input.conversationKey);
    if (!conversationKey) return false;
    // A temporary side chat's key (reserved band) is never persisted.
    if (isEphemeralConversationKey(conversationKey)) return false;
    await initUsageStore();
    const timestamp = Number.isFinite(input.timestamp)
      ? Math.floor(Number(input.timestamp))
      : Date.now();
    const mode: UsageEventMode = input.mode === "paper" ? "paper" : "library";
    await db.queryAsync(
      `INSERT INTO ${USAGE_EVENTS_TABLE} (
         timestamp,
         local_date,
         mode,
         conversation_key,
         conversation_instance_id,
         library_id,
         paper_item_id,
         model,
         provider,
         runtime,
         prompt_tokens,
         completion_tokens,
         total_tokens,
         cache_read_tokens,
         cache_write_tokens,
         counts_as_question,
         token_source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        timestamp,
        toLocalDateKey(timestamp),
        mode,
        conversationKey,
        normalizeText(input.conversationInstanceID),
        normalizePositiveInt(input.libraryID),
        normalizePositiveInt(input.paperItemID),
        normalizeText(input.model),
        normalizeText(input.provider),
        normalizeText(input.runtime),
        normalizeTokenCount(input.promptTokens),
        normalizeTokenCount(input.completionTokens),
        normalizeTokenCount(input.totalTokens),
        normalizeTokenCount(input.cacheReadTokens),
        normalizeTokenCount(input.cacheWriteTokens),
        input.countsAsQuestion === false ? 0 : 1,
        normalizeTokenSource(input.tokenSource),
      ],
    );
    return true;
  } catch (error) {
    logUsageStoreWarning("Failed to record a usage event", error);
    return false;
  }
}

/**
 * Resolve the scope columns for a conversation. Best effort: a missing or
 * unreadable registry must not stop the row from being written, so the mode
 * always falls back to the conversation key space.
 */
export async function resolveUsageScope(conversationKey: number): Promise<{
  mode: UsageEventMode;
  conversationInstanceID: string | null;
  libraryID: number | null;
  paperItemID: number | null;
}> {
  const fallback = {
    mode: resolveUsageModeForConversationKey(conversationKey),
    conversationInstanceID: null,
    libraryID: null,
    paperItemID: null,
  };
  try {
    const scope = await getRegisteredConversationScope(conversationKey);
    if (!scope) return fallback;
    return {
      mode: scope.kind === "paper" ? "paper" : fallback.mode,
      conversationInstanceID: normalizeText(scope.instanceID),
      libraryID: normalizePositiveInt(scope.libraryID),
      paperItemID: normalizePositiveInt(scope.paperItemID),
    };
  } catch (error) {
    logUsageStoreWarning("Failed to resolve usage scope", error);
    return fallback;
  }
}

function isMissingUsageTableError(error: unknown): boolean {
  return /no such table|no table/i.test(String(error));
}

/**
 * Cascade: a deleted conversation leaves no usage rows behind. Runs inside the
 * caller's transaction so the rows disappear atomically with the catalog.
 */
export async function deleteUsageEventsForConversationInTransaction(
  conversationKey: number,
): Promise<void> {
  const db = getUsageDb();
  const key = normalizePositiveInt(conversationKey);
  if (!db || !key) return;
  try {
    await db.queryAsync(
      `DELETE FROM ${USAGE_EVENTS_TABLE} WHERE conversation_key = ?`,
      [key],
    );
  } catch (error) {
    // The table is created lazily; absent means there is nothing to cascade.
    if (isMissingUsageTableError(error)) return;
    throw error;
  }
}

/**
 * Standalone cascade for deletion paths that own no transaction. A usage
 * failure must never fail the conversation deletion that owns it, so this
 * logs and returns; the transactional variant still throws so the catalog
 * rolls back with it.
 */
export async function deleteUsageEventsForConversation(
  conversationKey: number,
): Promise<void> {
  try {
    await deleteUsageEventsForConversationInTransaction(conversationKey);
  } catch (error) {
    logUsageStoreWarning("Failed to delete usage events", error);
  }
}

/** Read helper for tests; Milestone 2 owns the aggregation queries. */
export async function loadUsageEventsForConversation(
  conversationKey: number,
): Promise<StoredUsageEvent[]> {
  const db = getUsageDb();
  const key = normalizePositiveInt(conversationKey);
  if (!db || !key) return [];
  await initUsageStore();
  const rows = (await db.queryAsync(
    `SELECT id AS id,
            timestamp AS timestamp,
            local_date AS localDate,
            mode AS mode,
            conversation_key AS conversationKey,
            conversation_instance_id AS conversationInstanceID,
            library_id AS libraryID,
            paper_item_id AS paperItemID,
            model AS model,
            provider AS provider,
            runtime AS runtime,
            prompt_tokens AS promptTokens,
            completion_tokens AS completionTokens,
            total_tokens AS totalTokens,
            cache_read_tokens AS cacheReadTokens,
            cache_write_tokens AS cacheWriteTokens,
            counts_as_question AS countsAsQuestion,
            token_source AS tokenSource
     FROM ${USAGE_EVENTS_TABLE}
     WHERE conversation_key = ?
     ORDER BY id ASC`,
    [key],
  )) as Array<Record<string, unknown>> | undefined;
  return (rows || []).map((row) => ({
    id: Number(row.id),
    timestamp: Number(row.timestamp),
    localDate: String(row.localDate),
    mode: row.mode === "paper" ? "paper" : "library",
    conversationKey: Number(row.conversationKey),
    conversationInstanceID: normalizeText(row.conversationInstanceID),
    libraryID: normalizePositiveInt(row.libraryID),
    paperItemID: normalizePositiveInt(row.paperItemID),
    model: normalizeText(row.model),
    provider: normalizeText(row.provider),
    runtime: normalizeText(row.runtime),
    promptTokens: normalizeTokenCount(row.promptTokens),
    completionTokens: normalizeTokenCount(row.completionTokens),
    totalTokens: normalizeTokenCount(row.totalTokens),
    cacheReadTokens: normalizeTokenCount(row.cacheReadTokens),
    cacheWriteTokens: normalizeTokenCount(row.cacheWriteTokens),
    countsAsQuestion: Number(row.countsAsQuestion) !== 0,
    tokenSource: normalizeTokenSource(row.tokenSource),
  }));
}

/**
 * How many rows the one-time history backfill wrote.
 *
 * The reset confirmation needs this to warn that a reset also erases the
 * history reconstructed from past conversations, which is not rebuilt: the
 * backfill is marked done per profile and never runs a second time. It is a
 * COUNT in the database, not a number carried over from whatever the Usage tab
 * last painted, so the warning is right even when that view is stale. A ledger
 * that was never created has nothing reconstructed in it.
 */
export async function countHistoryEstimateUsageEvents(): Promise<number> {
  const db = getUsageDb();
  if (!db) return 0;
  try {
    const rows = (await db.queryAsync(
      `SELECT COUNT(*) AS estimateRows
       FROM ${USAGE_EVENTS_TABLE}
       WHERE token_source = 'history-estimate'`,
    )) as Array<Record<string, unknown>> | undefined;
    return normalizePositiveInt(rows?.[0]?.estimateRows) || 0;
  } catch (error) {
    if (isMissingUsageTableError(error)) return 0;
    logUsageStoreWarning("Failed to count reconstructed usage rows", error);
    return 0;
  }
}

/**
 * Delete every usage row the user has ever recorded.
 *
 * "Reset statistics" is the user erasing their own ledger, so the rows go and
 * the table stays: the next turn must be able to record without a schema pass
 * first. A ledger that was never created is already reset, which is a success,
 * not a failure.
 */
export async function clearAllUsageEvents(): Promise<boolean> {
  const db = getUsageDb();
  if (!db) return false;
  try {
    await db.queryAsync(`DELETE FROM ${USAGE_EVENTS_TABLE}`);
    return true;
  } catch (error) {
    if (isMissingUsageTableError(error)) return true;
    logUsageStoreWarning("Failed to clear the usage ledger", error);
    return false;
  }
}

export function resetUsageStoreForTests(): void {
  initPromise = null;
}

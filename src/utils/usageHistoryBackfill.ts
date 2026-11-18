/**
 * One-time reconstruction of the usage ledger from stored chat history.
 *
 * The ledger (`./usageStore.ts`) only started recording when it shipped, so a
 * user who has been asking questions for a year would open the Usage tab and
 * see an empty panel. This rebuilds the part of that history the database can
 * still prove, and marks every row it writes as an estimate.
 *
 * WHAT IS RECONSTRUCTED, AND WHAT IS NOT
 *
 *   - One row per stored USER message, so the question count equals the
 *     questions actually asked. An agent turn that produced several assistant
 *     messages is still ONE question, exactly as the live path counts it.
 *   - `counts_as_question = 1` for every row. The old schema records no retry
 *     marker, so a historical retry is indistinguishable from a first ask and
 *     is counted once. Live rows keep their honest retry flag.
 *   - INPUT tokens come from the paired assistant message's `context_tokens`,
 *     which is the size of the prompt the plugin assembled -- an estimate, not
 *     a billed count. When no assistant message in the turn recorded one, the
 *     row stays at zero: nothing here invents a number.
 *   - OUTPUT tokens were never stored, but the ANSWER TEXT was, so they are
 *     estimated from it (`./usageTokenEstimate.ts`) over every assistant
 *     message in the turn -- INCLUDING the stored reasoning summary and
 *     reasoning details, because a thinking model bills its hidden reasoning
 *     as output. That is a heuristic, not a billed count, and a turn that
 *     stored no text and no reasoning still scores zero.
 *
 * Everything it writes carries `token_source = 'history-estimate'` so the read
 * layer can say plainly that pre-cutover tokens are estimates on both sides.
 *
 * TWO MIGRATIONS
 *
 * `usage-history-backfill-v1` is the original reconstruction, which wrote an
 * input estimate and a hard zero for output. `usage-history-backfill-output-v2`
 * is the output estimate (`backfillUsageHistoryOutputTokens`), and it RECOMPUTES
 * every `history-estimate` row from the stored text rather than only the ones
 * still sitting at zero.
 *
 * Recompute, not repair, because an earlier build of this pass shipped a
 * text-only estimate under `usage-history-backfill-output-v1`: profiles that
 * ran it hold a non-zero output count that silently omits reasoning, and a
 * "only fill in the zeros" selection would step straight past them. That makes
 * the new number a REPLACEMENT of the old one, so the rule "never lower a
 * non-zero count" does not apply here and must not be re-added: what is being
 * replaced is an estimate this same code wrote from the same unchanged stored
 * text, never a count a provider reported -- `token_source` keeps those out of
 * the selection entirely. A row whose turn can no longer be found, or whose
 * turn stored nothing at all, is left exactly as it was.
 *
 * A fresh install writes both numbers in one pass and marks BOTH markers, so
 * the upgrade never walks a year of history to discover it has nothing to do.
 * The superseded `...-output-v1` marker is never read again and is left in the
 * ledger where it is: it records something that really happened.
 *
 * WHAT IS EXCLUDED
 *
 *   - WebChat turns, by the `webchat_session` catalog flag AND by the
 *     per-message `webchat_run_state` witness (an adopted WebChat turn can sit
 *     inside an ordinary conversation). The live path records nothing for
 *     WebChat, so including them historically would make the two halves of the
 *     ledger disagree.
 *   - Messages whose conversation has no catalog row. Without a catalog there
 *     is no way to check the WebChat flag or attribute a library/paper scope.
 *
 * SAFETY
 *
 * Running this twice would double a year of history, so it is guarded three
 * ways: the conversation-schema-migration marker (once per profile), a
 * module-level in-flight promise, and a per-conversation cutoff that keeps it
 * strictly behind anything the live recorder already wrote. It is wired as a
 * deferred startup task, catches its own failures, and never throws into
 * startup.
 */

import { classifyConversationKey } from "../shared/conversationKeySpace";
import { appLogger } from "../core/logging";
import {
  hasConversationSchemaMigration,
  markConversationSchemaMigrationApplied,
} from "../shared/conversationSchemaMigrations";
import {
  collectAssistantOutputTexts,
  estimateTokensFromTexts,
} from "./usageTokenEstimate";
import {
  USAGE_EVENTS_TABLE,
  initUsageStore,
  resolveUsageScope,
  toLocalDateKey,
  type UsageEventMode,
  type UsageEventRuntime,
} from "./usageStore";
import {
  isRuntimeConversationSystem,
  RUNTIME_CONVERSATION_SYSTEM_DESCRIPTORS,
} from "../core/conversations/conversationSystems";

export const USAGE_HISTORY_BACKFILL_MIGRATION_ID = "usage-history-backfill-v1";

/**
 * The output estimate. `v2` because `...-output-v1` wrote a text-only number
 * that left a reasoning model's hidden output uncounted; this pass recomputes
 * every history row, including the ones that marker already touched.
 */
export const USAGE_HISTORY_OUTPUT_BACKFILL_MIGRATION_ID =
  "usage-history-backfill-output-v2";

const USAGE_HISTORY_BACKFILL_DESCRIPTION =
  "Reconstruct usage ledger rows from stored chat history: one estimated row " +
  "per historical user message, tokens estimated from the stored text and " +
  "reasoning, WebChat excluded.";

const USAGE_HISTORY_OUTPUT_BACKFILL_DESCRIPTION =
  "Recompute output tokens for every backfilled history row from the stored " +
  "assistant text and reasoning; provider and unreported rows untouched.";

/**
 * Rows per INSERT. Kept well under the 999-parameter limit an older SQLite
 * build enforces (17 columns x 50 rows = 850), so the batch size never becomes
 * the reason a backfill fails on someone's machine.
 */
const INSERT_BATCH_ROWS = 50;

/**
 * Rows per UPDATE in the output upgrade. Each row costs five parameters (two
 * `CASE` arms twice, plus the id in the `IN` list), so 40 rows is 200 -- again
 * far below the 999-parameter limit.
 */
const UPDATE_BATCH_ROWS = 40;

export type UsageHistoryBackfillResult = {
  /** True when this call is the one that wrote the rows and the marker. */
  applied: boolean;
  rows: number;
  conversations: number;
  /** Rows that carry a non-zero input-token estimate. */
  rowsWithTokenEstimate: number;
  batches: number;
};

const EMPTY_RESULT: UsageHistoryBackfillResult = {
  applied: false,
  rows: 0,
  conversations: 0,
  rowsWithTokenEstimate: 0,
  batches: 0,
};

type BackfillDb = {
  queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
};

type HistoryConversation = {
  conversationKey: number;
  messagesTable: string;
  /** From the catalog; the registry still gets the final word below. */
  catalogMode: UsageEventMode;
  libraryID: number | null;
  paperItemID: number | null;
  conversationInstanceID: string | null;
};

type HistoryMessage = {
  role: "user" | "assistant";
  timestamp: number;
  runMode: string | null;
  modelName: string | null;
  providerLabel: string | null;
  contextTokens: number;
  webchatRunState: string | null;
  /** The stored answer; the only evidence of what the model produced. */
  text: string;
  /** Stored reasoning. Hidden from the user, but billed as output. */
  reasoningSummary: string;
  reasoningDetails: string;
};

type HistoryTurn = {
  timestamp: number;
  promptTokens: number;
  /**
   * Estimated from the turn's assistant text AND reasoning; see
   * ./usageTokenEstimate.ts.
   */
  completionTokens: number;
  model: string | null;
  provider: string | null;
  runMode: string | null;
  isWebChat: boolean;
};

type PendingRow = {
  timestamp: number;
  localDate: string;
  mode: UsageEventMode;
  conversationKey: number;
  conversationInstanceID: string | null;
  libraryID: number | null;
  paperItemID: number | null;
  model: string | null;
  provider: string | null;
  runtime: UsageEventRuntime | null;
  promptTokens: number;
  completionTokens: number;
};

const CHAT_MESSAGES_TABLE = "llm_for_zotero_chat_messages";
const CLAUDE_MESSAGES_TABLE = "llm_for_zotero_claude_messages";
const CODEX_MESSAGES_TABLE = "llm_for_zotero_codex_messages";

let backfillTask: Promise<UsageHistoryBackfillResult> | null = null;

function getDb(): BackfillDb | null {
  const db = (globalThis as { Zotero?: { DB?: { queryAsync?: unknown } } })
    .Zotero?.DB;
  return typeof db?.queryAsync === "function" ? (db as BackfillDb) : null;
}

function log(message: string, error?: unknown): void {
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

/** Column names a table actually has; empty means the table is not there. */
async function readTableColumns(
  db: BackfillDb,
  table: string,
): Promise<Set<string>> {
  try {
    const rows = (await db.queryAsync(`PRAGMA table_info(${table})`)) as
      | Array<{ name?: unknown }>
      | undefined;
    return new Set(
      (rows || [])
        .map((row) => (typeof row?.name === "string" ? row.name : ""))
        .filter(Boolean),
    );
  } catch (error) {
    if (/no such table|no table/i.test(String(error))) return new Set<string>();
    throw error;
  }
}

/**
 * A SELECT list that tolerates a column an older schema never created.
 *
 * A downgrade/upgrade cycle, or simply a profile that predates a column, would
 * otherwise turn the whole backfill into one "no such column" failure.
 */
function selectList(
  columns: Set<string>,
  wanted: Array<[string, string]>,
): string {
  return wanted
    .map(([column, alias]) =>
      columns.has(column) ? `${column} AS ${alias}` : `NULL AS ${alias}`,
    )
    .join(", ");
}

async function loadConversationsFromCatalog(
  db: BackfillDb,
  params: {
    catalogTable: string;
    messagesTable: string;
    /** Fixed mode for the upstream catalogs, which are split by table. */
    fixedMode?: UsageEventMode;
  },
): Promise<HistoryConversation[]> {
  const columns = await readTableColumns(db, params.catalogTable);
  if (!columns.size || !columns.has("conversation_key")) return [];
  const fields = selectList(columns, [
    ["conversation_key", "conversationKey"],
    ["library_id", "libraryID"],
    ["paper_item_id", "paperItemID"],
    ["conversation_instance_id", "conversationInstanceID"],
    ["kind", "kind"],
  ]);
  // A WebChat conversation is not part of the ledger at all: the live path
  // records nothing for it, so neither may history.
  const where = columns.has("webchat_session")
    ? "WHERE COALESCE(webchat_session, 0) = 0"
    : "";
  const rows = (await db.queryAsync(
    `SELECT ${fields} FROM ${params.catalogTable} ${where}`,
  )) as Array<Record<string, unknown>> | undefined;
  const conversations: HistoryConversation[] = [];
  for (const row of rows || []) {
    const conversationKey = normalizePositiveInt(row.conversationKey);
    if (!conversationKey) continue;
    const kind = normalizeText(row.kind);
    conversations.push({
      conversationKey,
      messagesTable: params.messagesTable,
      catalogMode: params.fixedMode ?? (kind === "paper" ? "paper" : "library"),
      libraryID: normalizePositiveInt(row.libraryID),
      paperItemID: normalizePositiveInt(row.paperItemID),
      conversationInstanceID: normalizeText(row.conversationInstanceID),
    });
  }
  return conversations;
}

async function loadHistoryConversations(
  db: BackfillDb,
): Promise<HistoryConversation[]> {
  const sources: Array<{
    catalogTable: string;
    messagesTable: string;
    fixedMode?: UsageEventMode;
  }> = [
    {
      catalogTable: "llm_for_zotero_paper_conversations",
      messagesTable: CHAT_MESSAGES_TABLE,
      fixedMode: "paper",
    },
    {
      catalogTable: "llm_for_zotero_global_conversations",
      messagesTable: CHAT_MESSAGES_TABLE,
      fixedMode: "library",
    },
    {
      catalogTable: "llm_for_zotero_claude_conversations",
      messagesTable: CLAUDE_MESSAGES_TABLE,
    },
    {
      catalogTable: "llm_for_zotero_codex_conversations",
      messagesTable: CODEX_MESSAGES_TABLE,
    },
  ];
  const conversations: HistoryConversation[] = [];
  for (const source of sources) {
    conversations.push(...(await loadConversationsFromCatalog(db, source)));
  }
  return conversations;
}

/** Earliest live row per conversation: the line history may not cross. */
async function loadLiveCutoffs(db: BackfillDb): Promise<Map<number, number>> {
  const cutoffs = new Map<number, number>();
  const rows = (await db.queryAsync(
    `SELECT conversation_key AS conversationKey,
            MIN(timestamp) AS earliest
     FROM ${USAGE_EVENTS_TABLE}
     GROUP BY conversation_key`,
  )) as Array<Record<string, unknown>> | undefined;
  for (const row of rows || []) {
    const key = normalizePositiveInt(row.conversationKey);
    const earliest = Math.floor(Number(row.earliest));
    if (!key || !Number.isFinite(earliest)) continue;
    cutoffs.set(key, earliest);
  }
  return cutoffs;
}

async function loadMessages(
  db: BackfillDb,
  messagesTable: string,
  columns: Set<string>,
  conversationKey: number,
): Promise<HistoryMessage[]> {
  const fields = selectList(columns, [
    ["role", "role"],
    ["timestamp", "timestamp"],
    ["run_mode", "runMode"],
    ["model_name", "modelName"],
    ["model_provider_label", "providerLabel"],
    ["context_tokens", "contextTokens"],
    ["webchat_run_state", "webchatRunState"],
    ["text", "text"],
    ["reasoning_summary", "reasoningSummary"],
    ["reasoning_details", "reasoningDetails"],
  ]);
  const rows = (await db.queryAsync(
    `SELECT ${fields}
     FROM ${messagesTable}
     WHERE conversation_key = ?
     ORDER BY timestamp ASC, id ASC`,
    [conversationKey],
  )) as Array<Record<string, unknown>> | undefined;
  const messages: HistoryMessage[] = [];
  for (const row of rows || []) {
    const role = normalizeText(row.role);
    const timestamp = Math.floor(Number(row.timestamp));
    if (
      (role !== "user" && role !== "assistant") ||
      !Number.isFinite(timestamp)
    )
      continue;
    messages.push({
      role,
      timestamp,
      runMode: normalizeText(row.runMode),
      modelName: normalizeText(row.modelName),
      providerLabel: normalizeText(row.providerLabel),
      contextTokens: normalizeTokenCount(row.contextTokens),
      webchatRunState: normalizeText(row.webchatRunState),
      text: typeof row.text === "string" ? row.text : "",
      reasoningSummary:
        typeof row.reasoningSummary === "string" ? row.reasoningSummary : "",
      reasoningDetails:
        typeof row.reasoningDetails === "string" ? row.reasoningDetails : "",
    });
  }
  return messages;
}

/**
 * Group a conversation's messages into turns: one per user message, carrying
 * every assistant message that followed it before the next question.
 */
export function buildHistoryTurns(messages: HistoryMessage[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  const answersByTurn = new Map<HistoryTurn, string[]>();
  let current: HistoryTurn | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      current = {
        timestamp: message.timestamp,
        promptTokens: 0,
        completionTokens: 0,
        model: message.modelName,
        provider: message.providerLabel,
        runMode: message.runMode,
        isWebChat: Boolean(message.webchatRunState),
      };
      turns.push(current);
      answersByTurn.set(current, []);
      continue;
    }
    // An assistant message before any question belongs to no turn.
    if (!current) continue;
    if (message.webchatRunState) current.isWebChat = true;
    // One agent turn can answer several times; every answer cost output
    // tokens, and so did the reasoning behind it, so the estimate covers all
    // of them as separate generations.
    answersByTurn.get(current)?.push(
      ...collectAssistantOutputTexts({
        text: message.text,
        reasoningSummary: message.reasoningSummary,
        reasoningDetails: message.reasoningDetails,
      }),
    );
    // The first recorded context size is the prompt the question was sent
    // with. Later rounds of an agent turn grow it, and summing or maximizing
    // them would claim a number nobody measured.
    if (!current.promptTokens) current.promptTokens = message.contextTokens;
    if (!current.model) current.model = message.modelName;
    if (!current.provider) current.provider = message.providerLabel;
    if (!current.runMode) current.runMode = message.runMode;
  }
  for (const turn of turns) {
    turn.completionTokens = estimateTokensFromTexts(
      answersByTurn.get(turn) || [],
    );
  }
  return turns;
}

/**
 * Drop every turn the live ledger might already describe.
 *
 * A live row is written DURING its turn, so its timestamp sits AFTER that
 * turn's user message. Taking everything strictly before the cutoff would
 * therefore re-describe the very turn that produced the earliest live row, so
 * the newest surviving turn is dropped as well. Costing at most one turn is
 * the right trade against counting one twice.
 */
export function selectBackfillableTurns(
  turns: HistoryTurn[],
  liveCutoff: number | undefined,
): HistoryTurn[] {
  if (liveCutoff === undefined) return turns;
  const older = turns.filter((turn) => turn.timestamp < liveCutoff);
  return older.slice(0, Math.max(0, older.length - 1));
}

/** The runtime label the live path would have written for this turn. */
export function resolveHistoryRuntime(
  conversationKey: number,
  runMode: string | null,
): UsageEventRuntime | null {
  const system = classifyConversationKey(conversationKey)?.system;
  if (isRuntimeConversationSystem(system)) {
    return RUNTIME_CONVERSATION_SYSTEM_DESCRIPTORS[system].usageSource;
  }
  if (runMode === "agent") return "agent";
  if (runMode === "chat") return "chat";
  // A row written before `run_mode` existed says nothing about its runtime,
  // and guessing one would put questions under a label they never ran in.
  return null;
}

const INSERT_COLUMNS = [
  "timestamp",
  "local_date",
  "mode",
  "conversation_key",
  "conversation_instance_id",
  "library_id",
  "paper_item_id",
  "model",
  "provider",
  "runtime",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "counts_as_question",
  "token_source",
] as const;

function rowParams(row: PendingRow): unknown[] {
  return [
    row.timestamp,
    row.localDate,
    row.mode,
    row.conversationKey,
    row.conversationInstanceID,
    row.libraryID,
    row.paperItemID,
    row.model,
    row.provider,
    row.runtime,
    row.promptTokens,
    // Output was never counted, but the answer text was kept: this is the
    // estimate taken from that text, never a billed count.
    row.completionTokens,
    row.promptTokens + row.completionTokens,
    0,
    0,
    1,
    "history-estimate",
  ];
}

async function insertRows(db: BackfillDb, rows: PendingRow[]): Promise<number> {
  let batches = 0;
  for (let start = 0; start < rows.length; start += INSERT_BATCH_ROWS) {
    const batch = rows.slice(start, start + INSERT_BATCH_ROWS);
    const placeholders = batch
      .map(() => `(${INSERT_COLUMNS.map(() => "?").join(", ")})`)
      .join(", ");
    const params: unknown[] = [];
    for (const row of batch) params.push(...rowParams(row));
    await db.queryAsync(
      `INSERT INTO ${USAGE_EVENTS_TABLE} (${INSERT_COLUMNS.join(", ")})
       VALUES ${placeholders}`,
      params,
    );
    batches += 1;
  }
  return batches;
}

async function collectRows(db: BackfillDb): Promise<PendingRow[]> {
  const conversations = await loadHistoryConversations(db);
  if (!conversations.length) return [];
  const cutoffs = await loadLiveCutoffs(db);
  const columnsByTable = new Map<string, Set<string>>();
  const rows: PendingRow[] = [];
  for (const conversation of conversations) {
    let columns = columnsByTable.get(conversation.messagesTable);
    if (!columns) {
      columns = await readTableColumns(db, conversation.messagesTable);
      columnsByTable.set(conversation.messagesTable, columns);
    }
    if (!columns.size || !columns.has("conversation_key")) continue;
    const messages = await loadMessages(
      db,
      conversation.messagesTable,
      columns,
      conversation.conversationKey,
    );
    if (!messages.length) continue;
    const turns = selectBackfillableTurns(
      buildHistoryTurns(messages),
      cutoffs.get(conversation.conversationKey),
    ).filter((turn) => !turn.isWebChat);
    if (!turns.length) continue;
    // Attribute exactly as the live path does, then let the catalog fill what
    // the registry does not know: the two must agree row for row or the panel
    // would split one paper across two identities.
    const scope = await resolveUsageScope(conversation.conversationKey);
    const mode: UsageEventMode =
      scope.mode === "paper" || conversation.catalogMode === "paper"
        ? "paper"
        : "library";
    const libraryID = scope.libraryID ?? conversation.libraryID;
    const paperItemID =
      mode === "paper" ? (scope.paperItemID ?? conversation.paperItemID) : null;
    const conversationInstanceID =
      scope.conversationInstanceID ?? conversation.conversationInstanceID;
    for (const turn of turns) {
      rows.push({
        timestamp: turn.timestamp,
        localDate: toLocalDateKey(turn.timestamp),
        mode,
        conversationKey: conversation.conversationKey,
        conversationInstanceID,
        libraryID,
        paperItemID,
        model: turn.model,
        provider: turn.provider,
        runtime: resolveHistoryRuntime(
          conversation.conversationKey,
          turn.runMode,
        ),
        promptTokens: turn.promptTokens,
        completionTokens: turn.completionTokens,
      });
    }
  }
  return rows;
}

async function runBackfill(): Promise<UsageHistoryBackfillResult> {
  const db = getDb();
  if (!db) return EMPTY_RESULT;
  await initUsageStore();
  if (await hasConversationSchemaMigration(USAGE_HISTORY_BACKFILL_MIGRATION_ID))
    return EMPTY_RESULT;
  const rows = await collectRows(db);
  const conversations = new Set(rows.map((row) => row.conversationKey)).size;
  const rowsWithTokenEstimate = rows.filter(
    (row) => row.promptTokens > 0,
  ).length;
  let batches = 0;
  // Zotero.DB.executeTransaction reads `this._callbacks`, so it must be called
  // AS A METHOD of the connection.
  const connection = (
    globalThis as {
      Zotero?: {
        DB?: { executeTransaction?: (task: () => Promise<void>) => unknown };
      };
    }
  ).Zotero?.DB;
  let applied = false;
  const apply = async (): Promise<void> => {
    // Re-check inside the transaction: a concurrent pass must not be able to
    // write the same year of history twice.
    if (
      await hasConversationSchemaMigration(USAGE_HISTORY_BACKFILL_MIGRATION_ID)
    ) {
      return;
    }
    batches = await insertRows(db, rows);
    await markConversationSchemaMigrationApplied(
      USAGE_HISTORY_BACKFILL_MIGRATION_ID,
      USAGE_HISTORY_BACKFILL_DESCRIPTION,
    );
    // These rows already carry their output estimate, so the upgrade below
    // has nothing to add: mark it done in the same transaction rather than
    // letting it walk a year of history to discover that.
    await markConversationSchemaMigrationApplied(
      USAGE_HISTORY_OUTPUT_BACKFILL_MIGRATION_ID,
      USAGE_HISTORY_OUTPUT_BACKFILL_DESCRIPTION,
    );
    applied = true;
  };
  if (typeof connection?.executeTransaction === "function") {
    await connection.executeTransaction(apply);
  } else {
    await apply();
  }
  if (!applied) return EMPTY_RESULT;
  return {
    applied: true,
    rows: rows.length,
    conversations,
    rowsWithTokenEstimate,
    batches,
  };
}

/**
 * ONE ALREADY-BACKFILLED ROW that needs its output estimate.
 *
 * Identified by `id` rather than by conversation and timestamp: the update
 * has to name exactly the row it measured, even in the pathological case of
 * two questions asked in the same millisecond of the same conversation.
 */
type OutputUpdate = {
  id: number;
  conversationKey: number;
  completionTokens: number;
};

export type UsageHistoryOutputBackfillResult = {
  /** True when this call is the one that wrote the rows and the marker. */
  applied: boolean;
  rowsUpdated: number;
  conversations: number;
  /** Output tokens this pass estimated, summed over the rows it wrote. */
  completionTokens: number;
  batches: number;
};

const EMPTY_OUTPUT_RESULT: UsageHistoryOutputBackfillResult = {
  applied: false,
  rowsUpdated: 0,
  conversations: 0,
  completionTokens: 0,
  batches: 0,
};

let outputBackfillTask: Promise<UsageHistoryOutputBackfillResult> | null = null;

type EstimateRow = {
  id: number;
  conversationKey: number;
  timestamp: number;
  /** What the row says today, so an unchanged recompute writes nothing. */
  completionTokens: number;
};

/**
 * EVERY history-estimate row, not only the ones still sitting at zero.
 *
 * Selecting on `completion_tokens = 0` was the old rule, and it is exactly
 * what would miss the rows the superseded text-only upgrade already filled in:
 * they hold a non-zero number that omits reasoning. `token_source` is the whole
 * selection rule now, which keeps provider and unreported rows out, and the
 * pass stays safe to repeat a different way -- it RECOMPUTES each row from
 * unchanged stored text and writes that number in place of whatever is there,
 * so running it again lands on the same value instead of adding to itself.
 */
async function loadHistoryEstimateRows(db: BackfillDb): Promise<EstimateRow[]> {
  const rows = (await db.queryAsync(
    `SELECT id AS id,
            conversation_key AS conversationKey,
            timestamp AS timestamp,
            completion_tokens AS completionTokens
     FROM ${USAGE_EVENTS_TABLE}
     WHERE token_source = 'history-estimate'
     ORDER BY conversation_key ASC, timestamp ASC, id ASC`,
  )) as Array<Record<string, unknown>> | undefined;
  const estimates: EstimateRow[] = [];
  for (const row of rows || []) {
    const id = normalizePositiveInt(row.id);
    const conversationKey = normalizePositiveInt(row.conversationKey);
    const timestamp = Math.floor(Number(row.timestamp));
    if (!id || !conversationKey || !Number.isFinite(timestamp)) continue;
    estimates.push({
      id,
      conversationKey,
      timestamp,
      completionTokens: normalizeTokenCount(row.completionTokens),
    });
  }
  return estimates;
}

/**
 * Pair each history row with the turn that produced it and estimate its output.
 *
 * The pairing key is (conversation, user-message timestamp), which is exactly
 * what the v1 backfill wrote into `timestamp`. Turn grouping is NOT re-derived
 * here: `buildHistoryTurns` is the same function the insert path uses, so both
 * halves of the ledger can never disagree about where a turn begins.
 */
async function collectOutputUpdates(db: BackfillDb): Promise<OutputUpdate[]> {
  const estimates = await loadHistoryEstimateRows(db);
  if (!estimates.length) return [];
  const estimatesByConversation = new Map<number, EstimateRow[]>();
  for (const row of estimates) {
    const bucket = estimatesByConversation.get(row.conversationKey);
    if (bucket) bucket.push(row);
    else estimatesByConversation.set(row.conversationKey, [row]);
  }
  const conversations = await loadHistoryConversations(db);
  const columnsByTable = new Map<string, Set<string>>();
  const updates: OutputUpdate[] = [];
  for (const conversation of conversations) {
    const rows = estimatesByConversation.get(conversation.conversationKey);
    if (!rows?.length) continue;
    let columns = columnsByTable.get(conversation.messagesTable);
    if (!columns) {
      columns = await readTableColumns(db, conversation.messagesTable);
      columnsByTable.set(conversation.messagesTable, columns);
    }
    if (!columns.size || !columns.has("conversation_key")) continue;
    const messages = await loadMessages(
      db,
      conversation.messagesTable,
      columns,
      conversation.conversationKey,
    );
    if (!messages.length) continue;
    // Turns that share a timestamp keep their order on both sides, so the
    // n-th row of that millisecond gets the n-th turn's answer. WebChat turns
    // never got a row, so they must not occupy a place in that order.
    const turnsByTimestamp = new Map<number, HistoryTurn[]>();
    for (const turn of buildHistoryTurns(messages).filter(
      (candidate) => !candidate.isWebChat,
    )) {
      const bucket = turnsByTimestamp.get(turn.timestamp);
      if (bucket) bucket.push(turn);
      else turnsByTimestamp.set(turn.timestamp, [turn]);
    }
    const consumed = new Map<number, number>();
    for (const row of rows) {
      const candidates = turnsByTimestamp.get(row.timestamp);
      if (!candidates?.length) continue;
      const index = consumed.get(row.timestamp) || 0;
      consumed.set(row.timestamp, index + 1);
      const turn = candidates[index];
      // No matching turn, or a turn that stored neither answer nor reasoning:
      // leave the row exactly as the first backfill wrote it rather than
      // recomputing it down to nothing on evidence that is no longer there.
      if (!turn || turn.completionTokens <= 0) continue;
      // Already carries this exact estimate: writing it again would be a
      // no-op, and skipping keeps the batch count honest.
      if (turn.completionTokens === row.completionTokens) continue;
      updates.push({
        id: row.id,
        conversationKey: row.conversationKey,
        completionTokens: turn.completionTokens,
      });
    }
  }
  return updates;
}

/**
 * Write the estimates in batches.
 *
 * `total_tokens` is recomputed as input + output from the row's own
 * `prompt_tokens`, which is what the live recorder totals. The guard lives in
 * the WHERE clause, not only in the caller: this statement can only ever touch
 * a `history-estimate` row, so no provider count can be overwritten even if a
 * caller handed it the wrong id. The old `completion_tokens = 0` guard is
 * deliberately gone -- it is exactly what would refuse to correct a text-only
 * estimate -- and the value written is a full replacement, never an addition.
 */
async function applyOutputUpdates(
  db: BackfillDb,
  updates: OutputUpdate[],
): Promise<number> {
  let batches = 0;
  for (let start = 0; start < updates.length; start += UPDATE_BATCH_ROWS) {
    const batch = updates.slice(start, start + UPDATE_BATCH_ROWS);
    const cases = batch.map(() => "WHEN ? THEN ?").join(" ");
    const caseParams: unknown[] = [];
    for (const update of batch)
      caseParams.push(update.id, update.completionTokens);
    const ids = batch.map((update) => update.id);
    await db.queryAsync(
      `UPDATE ${USAGE_EVENTS_TABLE}
          SET completion_tokens = CASE id ${cases} END,
              total_tokens = prompt_tokens + CASE id ${cases} END
        WHERE token_source = 'history-estimate'
          AND id IN (${ids.map(() => "?").join(", ")})`,
      [...caseParams, ...caseParams, ...ids],
    );
    batches += 1;
  }
  return batches;
}

async function runOutputBackfill(): Promise<UsageHistoryOutputBackfillResult> {
  const db = getDb();
  if (!db) return EMPTY_OUTPUT_RESULT;
  // Ordering, not a side effect: on a fresh profile the v1 pass writes these
  // rows complete and marks this migration with them, so running first means
  // this pass correctly finds nothing to do instead of racing it.
  await backfillUsageHistory();
  await initUsageStore();
  if (
    await hasConversationSchemaMigration(
      USAGE_HISTORY_OUTPUT_BACKFILL_MIGRATION_ID,
    )
  )
    return EMPTY_OUTPUT_RESULT;
  const updates = await collectOutputUpdates(db);
  let batches = 0;
  let applied = false;
  const connection = (
    globalThis as {
      Zotero?: {
        DB?: { executeTransaction?: (task: () => Promise<void>) => unknown };
      };
    }
  ).Zotero?.DB;
  const apply = async (): Promise<void> => {
    if (
      await hasConversationSchemaMigration(
        USAGE_HISTORY_OUTPUT_BACKFILL_MIGRATION_ID,
      )
    )
      return;
    batches = await applyOutputUpdates(db, updates);
    await markConversationSchemaMigrationApplied(
      USAGE_HISTORY_OUTPUT_BACKFILL_MIGRATION_ID,
      USAGE_HISTORY_OUTPUT_BACKFILL_DESCRIPTION,
    );
    applied = true;
  };
  if (typeof connection?.executeTransaction === "function") {
    await connection.executeTransaction(apply);
  } else {
    await apply();
  }
  if (!applied) return EMPTY_OUTPUT_RESULT;
  let completionTokens = 0;
  for (const update of updates) completionTokens += update.completionTokens;
  return {
    applied: true,
    rowsUpdated: updates.length,
    conversations: new Set(updates.map((update) => update.conversationKey))
      .size,
    completionTokens,
    batches,
  };
}

/**
 * Give every already-backfilled history row the output estimate this build
 * computes: answer text plus the reasoning a thinking model was billed for.
 *
 * Once per profile, and idempotent even without its marker: every number it
 * writes is recomputed from unchanged stored text and REPLACES what the row
 * held, so a second run reaches the same value instead of doubling it.
 *
 * Never throws: a reporting surface may not be the reason a startup fails.
 */
export async function backfillUsageHistoryOutputTokens(): Promise<UsageHistoryOutputBackfillResult> {
  if (outputBackfillTask) return outputBackfillTask;
  outputBackfillTask = (async () => {
    try {
      return await runOutputBackfill();
    } catch (error) {
      log("Failed to estimate output tokens for backfilled usage rows", error);
      return EMPTY_OUTPUT_RESULT;
    }
  })();
  return outputBackfillTask;
}

/**
 * Rebuild the ledger from history, once per profile.
 *
 * Never throws: a reporting surface may not be the reason a startup fails.
 */
export async function backfillUsageHistory(): Promise<UsageHistoryBackfillResult> {
  if (backfillTask) return backfillTask;
  backfillTask = (async () => {
    try {
      return await runBackfill();
    } catch (error) {
      log("Failed to backfill the usage ledger from chat history", error);
      return EMPTY_RESULT;
    }
  })();
  return backfillTask;
}

export function resetUsageHistoryBackfillForTests(): void {
  backfillTask = null;
  outputBackfillTask = null;
}

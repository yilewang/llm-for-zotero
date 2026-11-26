/**
 * Read layer over the local usage ledger (`src/utils/usageStore.ts`).
 *
 * Every number the Usage view shows is computed here, in SQL. The ledger can
 * hold tens of thousands of rows, so nothing in this module loads rows into
 * JavaScript to count them: the database groups, sums, and counts distincts,
 * and only the already-aggregated buckets come back.
 *
 * Two rules the arithmetic must keep:
 *
 *   - A retry (`counts_as_question = 0`) burned real tokens, so its tokens
 *     count everywhere, but it is not a second question.
 *   - "Distinct papers" over a range is a GLOBAL distinct, never a sum of the
 *     daily distincts: one paper read on 30 days is one paper, not thirty.
 *
 * Nothing here may throw at a caller. The usage table is created lazily by the
 * write path, so a user who has never sent a turn has no table at all; a read
 * against that must return an empty result, not an error dialog.
 */

import { appLogger } from "../core/logging";
import {
  buildPaperDisplayLabels,
  type PaperDisplayMetadata,
} from "../shared/paperDisplayLabels";
import {
  DEFAULT_USAGE_TOKEN_SOURCE,
  USAGE_EVENTS_TABLE,
  toLocalDateKey,
  type StoredUsageEvent,
  type UsageTokenSource,
  normalizePositiveInt,
} from "./usageStore";
import { positiveIntOrZero, trimmedStringOrNull } from "../core/values";
import { getZoteroDb } from "../core/zoteroDb";

/** Catalog tables a library conversation's title can live in. */
const CONVERSATION_CATALOG_TABLES = [
  "llm_for_zotero_global_conversations",
  "llm_for_zotero_claude_conversations",
  "llm_for_zotero_codex_conversations",
] as const;

/**
 * Separator inside the composite `model` + `provider` grouping key.
 *
 * NUL cannot occur in a model or provider name, so it cannot collide the way
 * a punctuation separator could. It is written as an escape on purpose: a
 * literal NUL byte in the source makes git, grep and diff treat this whole
 * file as binary, which makes it unreviewable.
 */
const MODEL_KEY_SEPARATOR = "\u0000";

/** Shown when a conversation has neither a title nor a first-question title. */
export const UNTITLED_CONVERSATION_LABEL = "Untitled conversation";

/** Shown when the Zotero item a paper row points at no longer exists. */
export const MISSING_PAPER_LABEL = "Paper no longer in your library";

const HEATMAP_DAYS = 365;
const DEFAULT_TOP_LIMIT = 10;
const MAX_TOP_LIMIT = 200;

export type UsageRangeKey = "last7" | "last30" | "all";

export type UsageDateRange = {
  /** Inclusive local `YYYY-MM-DD` lower bound, or null for all time. */
  startDate: string | null;
  /** Inclusive local `YYYY-MM-DD` upper bound, or null for all time. */
  endDate: string | null;
};

export type UsageQueryOptions = {
  range?: UsageRangeKey;
  /** Epoch milliseconds standing in for "now"; tests pin it. */
  now?: number;
};

/** Restrict a report to one chat mode, for the per-mode sub-tabs. */
export type UsageModeFilter = { mode?: "paper" | "library" };

export type UsageModeSummary = {
  mode: "paper" | "library";
  questions: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  distinctPapers: number;
  distinctConversations: number;
};

export type UsageModeTotals = {
  paper: UsageModeSummary;
  library: UsageModeSummary;
};

export type UsageDailyTokens = {
  localDate: string;
  paperTokens: number;
  libraryTokens: number;
  totalTokens: number;
};

export type UsageHeatmapDay = {
  localDate: string;
  questions: number;
  distinctPapers: number;
  /** Every token recorded that day, retries included. */
  totalTokens: number;
  /** Rows whose provider reported the tokens above. */
  providerRows: number;
  /** Rows whose provider never reported usage; their tokens are unknown. */
  unreportedRows: number;
  /** Rows rebuilt from stored chat history: both numbers are estimates. */
  estimateRows: number;
};

export type UsageHeatmap = {
  startDate: string;
  endDate: string;
  /** One entry per local day in the window, ascending, zero-filled. */
  days: UsageHeatmapDay[];
  totalQuestions: number;
  /** Days that carry at least one counted question. */
  activeDays: number;
  /** Distinct papers across the whole window, not a sum of daily distincts. */
  distinctPapers: number;
};

export type UsageModelUsage = {
  /** Null when the turn recorded no model name. */
  model: string | null;
  provider: string | null;
  paperQuestions: number;
  libraryQuestions: number;
  questions: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  /**
   * Distinct runtimes that produced these tokens, sorted. The same model can
   * appear twice -- once from the API, once from a runtime like Claude Code --
   * and this is what tells the two rows apart.
   */
  runtimes: string[];
  /**
   * Turns whose provider never reported usage (`token_source = 'unreported'`).
   * Their tokens are UNKNOWN, not zero, so a caller that sees a small total
   * next to a large turn count can say so instead of implying a cheap model.
   */
  unreportedTurns: number;
  /**
   * Turns whose tokens were reconstructed from stored history
   * (`token_source = 'history-estimate'`). Their input is estimated from the
   * recorded context size and their output from the stored answer text, so a
   * range that contains them must say so rather than let the split read like
   * a measured bill.
   */
  estimatedTurns: number;
};

export type UsagePaperUsage = {
  paperItemID: number;
  /** Display label from the shared paper-label helper, or an honest fallback. */
  title: string;
  /**
   * The paper's own title, when Zotero still holds one.
   *
   * `title` is the shared citation-style display identity — right for prose
   * that cites a paper, wrong as the primary text of a list called "Papers you
   * asked about most", where a user is looking for the title they know. Null
   * when the item is gone or carries no title, so a caller falls back to
   * `title` rather than printing nothing.
   */
  paperTitle: string | null;
  /** False when the Zotero item is gone or unreadable. */
  inLibrary: boolean;
  questions: number;
  totalTokens: number;
};

export type UsageConversationUsage = {
  conversationKey: number;
  title: string;
  questions: number;
  totalTokens: number;
};

type Row = Record<string, unknown>;

function logUsageStatsWarning(message: string, error?: unknown): void {
  appLogger.warn(`LLM: ${message}`, error);
}

/**
 * Run one aggregation query. A missing table, a closed database, or any other
 * read failure yields no rows: the Usage view shows zeros rather than an error.
 */
async function readRows(sql: string, params: unknown[] = []): Promise<Row[]> {
  const db = getZoteroDb();
  if (!db) return [];
  try {
    const rows = await db.queryAsync(sql, params);
    return Array.isArray(rows) ? (rows as Row[]) : [];
  } catch (error) {
    logUsageStatsWarning("Failed to read usage statistics", error);
    return [];
  }
}

/** Local calendar day `offset` days before the day `timestamp` falls in. */
function localDayKey(timestamp: number, offset: number): string {
  const date = new Date(timestamp);
  // Calendar arithmetic, not millisecond arithmetic: a DST change makes a day
  // 23 or 25 hours long, and the heatmap must still line up with the user's
  // own days.
  return toLocalDateKey(
    new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() - offset,
      12,
      0,
      0,
      0,
    ).getTime(),
  );
}

/** Ascending list of the local day keys in a trailing window ending today. */
function trailingDayKeys(days: number, now: number): string[] {
  const span = Math.max(1, Math.floor(days));
  const keys: string[] = [];
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    keys.push(localDayKey(now, offset));
  }
  return keys;
}

/**
 * The range filter every report shares, computed in LOCAL dates so it lines up
 * with the `local_date` column the write path stores.
 */
export function resolveUsageDateRange(
  range: UsageRangeKey,
  now: number = Date.now(),
): UsageDateRange {
  if (range === "last7" || range === "last30") {
    const span = range === "last7" ? 7 : 30;
    return {
      startDate: localDayKey(now, span - 1),
      endDate: localDayKey(now, 0),
    };
  }
  return { startDate: null, endDate: null };
}

function rangeFilter(
  options: UsageQueryOptions | undefined,
  extra: string[] = [],
): { where: string; params: unknown[] } {
  const now = Number.isFinite(options?.now) ? Number(options?.now) : Date.now();
  const range = resolveUsageDateRange(options?.range || "all", now);
  const clauses = [...extra];
  const params: unknown[] = [];
  if (range.startDate) {
    clauses.push("local_date >= ?");
    params.push(range.startDate);
  }
  if (range.endDate) {
    clauses.push("local_date <= ?");
    params.push(range.endDate);
  }
  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function emptyModeSummary(mode: "paper" | "library"): UsageModeSummary {
  return {
    mode,
    questions: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    distinctPapers: 0,
    distinctConversations: 0,
  };
}

/**
 * Paper chat vs library chat for a range: questions (retries excluded), token
 * split, distinct papers, and distinct conversations.
 */
export async function loadUsageModeTotals(
  options: UsageQueryOptions = {},
): Promise<UsageModeTotals> {
  const { where, params } = rangeFilter(options);
  const rows = await readRows(
    `SELECT mode AS mode,
            SUM(CASE WHEN counts_as_question = 1 THEN 1 ELSE 0 END) AS questions,
            SUM(prompt_tokens) AS promptTokens,
            SUM(completion_tokens) AS completionTokens,
            SUM(total_tokens) AS totalTokens,
            COUNT(DISTINCT CASE WHEN mode = 'paper' THEN paper_item_id END) AS distinctPapers,
            COUNT(DISTINCT conversation_key) AS distinctConversations
     FROM ${USAGE_EVENTS_TABLE}
     ${where}
     GROUP BY mode`,
    params,
  );
  const totals: UsageModeTotals = {
    paper: emptyModeSummary("paper"),
    library: emptyModeSummary("library"),
  };
  for (const row of rows) {
    const mode = row.mode === "paper" ? "paper" : "library";
    totals[mode] = {
      mode,
      questions: positiveIntOrZero(row.questions),
      promptTokens: positiveIntOrZero(row.promptTokens),
      completionTokens: positiveIntOrZero(row.completionTokens),
      totalTokens: positiveIntOrZero(row.totalTokens),
      distinctPapers: positiveIntOrZero(row.distinctPapers),
      distinctConversations: positiveIntOrZero(row.distinctConversations),
    };
  }
  return totals;
}

/**
 * Tokens per local day for the token chart, paper against library, over a
 * trailing window of `days` days ending today. Days with no usage are present
 * with zeros so the chart keeps a continuous x axis.
 */
export async function loadUsageDailyTokens(
  options: { days: number } & Pick<UsageQueryOptions, "now">,
): Promise<UsageDailyTokens[]> {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const keys = trailingDayKeys(options.days, now);
  const rows = await readRows(
    `SELECT local_date AS localDate,
            SUM(CASE WHEN mode = 'paper' THEN total_tokens ELSE 0 END) AS paperTokens,
            SUM(CASE WHEN mode = 'library' THEN total_tokens ELSE 0 END) AS libraryTokens
     FROM ${USAGE_EVENTS_TABLE}
     WHERE local_date >= ? AND local_date <= ?
     GROUP BY local_date`,
    [keys[0], keys[keys.length - 1]],
  );
  const byDate = new Map<string, Row>();
  for (const row of rows) {
    const key = trimmedStringOrNull(row.localDate);
    if (key) byDate.set(key, row);
  }
  return keys.map((localDate) => {
    const row = byDate.get(localDate);
    const paperTokens = positiveIntOrZero(row?.paperTokens);
    const libraryTokens = positiveIntOrZero(row?.libraryTokens);
    return {
      localDate,
      paperTokens,
      libraryTokens,
      totalTokens: paperTokens + libraryTokens,
    };
  });
}

/**
 * The heatmap series: a full trailing year keyed by local day, carrying both
 * metrics the view can colour by, the tokens and token provenance the hover
 * popover words its third line from, plus the summary line's totals.
 *
 * The popover's numbers come from these same rows and the same `local_date`
 * bucketing as the cell the pointer is over, so what the tooltip says can
 * never disagree with the colour under it.
 *
 * `distinctPapers` is computed by a second query over the whole window rather
 * than by summing `days[].distinctPapers`, because the same paper appearing on
 * several days must be counted once.
 */
export async function loadUsageHeatmap(
  options: { days?: number } & Pick<UsageQueryOptions, "now"> = {},
): Promise<UsageHeatmap> {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const keys = trailingDayKeys(options.days ?? HEATMAP_DAYS, now);
  const startDate = keys[0]!;
  const endDate = keys[keys.length - 1]!;
  const params = [startDate, endDate];
  const dayRows = await readRows(
    `SELECT local_date AS localDate,
            SUM(CASE WHEN counts_as_question = 1 THEN 1 ELSE 0 END) AS questions,
            COUNT(DISTINCT CASE WHEN mode = 'paper' THEN paper_item_id END) AS distinctPapers,
            SUM(total_tokens) AS totalTokens,
            SUM(CASE WHEN token_source = 'provider' THEN 1 ELSE 0 END) AS providerRows,
            SUM(CASE WHEN token_source = 'unreported' THEN 1 ELSE 0 END) AS unreportedRows,
            SUM(CASE WHEN token_source = 'history-estimate' THEN 1 ELSE 0 END) AS estimateRows
     FROM ${USAGE_EVENTS_TABLE}
     WHERE local_date >= ? AND local_date <= ?
     GROUP BY local_date`,
    params,
  );
  const summaryRows = await readRows(
    `SELECT SUM(CASE WHEN counts_as_question = 1 THEN 1 ELSE 0 END) AS totalQuestions,
            COUNT(DISTINCT CASE WHEN counts_as_question = 1 THEN local_date END) AS activeDays,
            COUNT(DISTINCT CASE WHEN mode = 'paper' THEN paper_item_id END) AS distinctPapers
     FROM ${USAGE_EVENTS_TABLE}
     WHERE local_date >= ? AND local_date <= ?`,
    params,
  );
  const byDate = new Map<string, Row>();
  for (const row of dayRows) {
    const key = trimmedStringOrNull(row.localDate);
    if (key) byDate.set(key, row);
  }
  const summary = summaryRows[0];
  return {
    startDate,
    endDate,
    days: keys.map((localDate) => {
      const row = byDate.get(localDate);
      return {
        localDate,
        questions: positiveIntOrZero(row?.questions),
        distinctPapers: positiveIntOrZero(row?.distinctPapers),
        totalTokens: positiveIntOrZero(row?.totalTokens),
        providerRows: positiveIntOrZero(row?.providerRows),
        unreportedRows: positiveIntOrZero(row?.unreportedRows),
        estimateRows: positiveIntOrZero(row?.estimateRows),
      };
    }),
    totalQuestions: positiveIntOrZero(summary?.totalQuestions),
    activeDays: positiveIntOrZero(summary?.activeDays),
    distinctPapers: positiveIntOrZero(summary?.distinctPapers),
  };
}

/**
 * Per-model totals for the model table.
 *
 * The database groups by model, provider, runtime, and mode — a handful of
 * buckets even for a huge ledger — and those buckets are folded into one row
 * per model here, keeping the runtime split the model table names.
 */
export async function loadUsageModelBreakdown(
  options: UsageQueryOptions & UsageModeFilter = {},
): Promise<UsageModelUsage[]> {
  // The mode is a closed enum, never user text, so it goes in as a literal:
  // rangeFilter's extra clauses carry no parameters of their own.
  const modeClause =
    options.mode === "paper"
      ? ["mode = 'paper'"]
      : options.mode === "library"
        ? ["mode = 'library'"]
        : [];
  const { where, params } = rangeFilter(options, modeClause);
  const rows = await readRows(
    `SELECT model AS model,
            provider AS provider,
            runtime AS runtime,
            mode AS mode,
            SUM(CASE WHEN counts_as_question = 1 THEN 1 ELSE 0 END) AS questions,
            SUM(prompt_tokens) AS promptTokens,
            SUM(completion_tokens) AS completionTokens,
            SUM(total_tokens) AS totalTokens,
            SUM(cache_read_tokens) AS cacheReadTokens,
            SUM(CASE WHEN token_source = 'unreported' THEN 1 ELSE 0 END) AS unreportedTurns,
            SUM(CASE WHEN token_source = 'history-estimate' THEN 1 ELSE 0 END) AS estimatedTurns
     FROM ${USAGE_EVENTS_TABLE}
     ${where}
     GROUP BY model, provider, runtime, mode`,
    params,
  );
  const byModel = new Map<string, UsageModelUsage>();
  const runtimesByModel = new Map<string, Set<string>>();
  for (const row of rows) {
    const model = trimmedStringOrNull(row.model);
    const provider = trimmedStringOrNull(row.provider);
    const runtime = trimmedStringOrNull(row.runtime);
    const key = `${model ?? ""}${MODEL_KEY_SEPARATOR}${provider ?? ""}`;
    let entry = byModel.get(key);
    if (!entry) {
      entry = {
        model,
        provider,
        paperQuestions: 0,
        libraryQuestions: 0,
        questions: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        runtimes: [],
        unreportedTurns: 0,
        estimatedTurns: 0,
      };
      byModel.set(key, entry);
      runtimesByModel.set(key, new Set<string>());
    }
    const questions = positiveIntOrZero(row.questions);
    const promptTokens = positiveIntOrZero(row.promptTokens);
    const completionTokens = positiveIntOrZero(row.completionTokens);
    const totalTokens = positiveIntOrZero(row.totalTokens);
    const cacheReadTokens = positiveIntOrZero(row.cacheReadTokens);
    if (row.mode === "paper") entry.paperQuestions += questions;
    else entry.libraryQuestions += questions;
    entry.questions += questions;
    entry.promptTokens += promptTokens;
    entry.completionTokens += completionTokens;
    entry.totalTokens += totalTokens;
    entry.cacheReadTokens += cacheReadTokens;
    entry.unreportedTurns += positiveIntOrZero(row.unreportedTurns);
    entry.estimatedTurns += positiveIntOrZero(row.estimatedTurns);
    if (runtime) runtimesByModel.get(key)!.add(runtime);
  }
  for (const [key, entry] of byModel) {
    entry.runtimes = [...(runtimesByModel.get(key) || [])].sort();
  }
  return [...byModel.values()].sort(
    (left, right) =>
      right.totalTokens - left.totalTokens ||
      right.questions - left.questions ||
      (left.model || "").localeCompare(right.model || ""),
  );
}

function clampLimit(limit: unknown): number {
  const parsed = Math.floor(Number(limit));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TOP_LIMIT;
  return Math.min(parsed, MAX_TOP_LIMIT);
}

type ZoteroItemLike = {
  getField?: (field: string) => unknown;
  getDisplayTitle?: () => unknown;
};

function readPaperMetadata(paperItemID: number): PaperDisplayMetadata | null {
  try {
    const items = (
      globalThis as { Zotero?: { Items?: { get?: (id: number) => unknown } } }
    ).Zotero?.Items;
    const item = items?.get?.(paperItemID) as ZoteroItemLike | null | false;
    if (!item || typeof item !== "object") return null;
    const field = (name: string) => String(item.getField?.(name) || "").trim();
    const title =
      field("title") || String(item.getDisplayTitle?.() || "").trim();
    const metadata: PaperDisplayMetadata = {
      title: title || undefined,
      firstCreator: field("firstCreator") || undefined,
      year: field("date").match(/\b\d{4}\b/)?.[0],
    };
    if (!metadata.title && !metadata.firstCreator && !metadata.year) {
      // An item that answers nothing is indistinguishable from a missing one.
      return null;
    }
    return metadata;
  } catch (error) {
    // A library that cannot be read must not take the whole view down.
    logUsageStatsWarning("Failed to read a paper's metadata", error);
    return null;
  }
}

/**
 * The papers a user asked the most about, paper chat only.
 *
 * Ranked by questions first (the panel's headline number), tokens second.
 */
export async function loadTopUsagePapers(
  options: UsageQueryOptions & { limit?: number } = {},
): Promise<UsagePaperUsage[]> {
  const { where, params } = rangeFilter(options, [
    "mode = 'paper'",
    "paper_item_id IS NOT NULL",
  ]);
  const limit = clampLimit(options.limit);
  const rows = await readRows(
    `SELECT paper_item_id AS paperItemID,
            SUM(CASE WHEN counts_as_question = 1 THEN 1 ELSE 0 END) AS questions,
            SUM(total_tokens) AS totalTokens
     FROM ${USAGE_EVENTS_TABLE}
     ${where}
     GROUP BY paper_item_id
     ORDER BY questions DESC, totalTokens DESC, paper_item_id ASC
     LIMIT ?`,
    [...params, limit],
  );
  const ranked = rows
    .map((row) => ({
      paperItemID: positiveIntOrZero(row.paperItemID),
      questions: positiveIntOrZero(row.questions),
      totalTokens: positiveIntOrZero(row.totalTokens),
    }))
    .filter((row) => row.paperItemID > 0);
  const metadata = new Map<number, PaperDisplayMetadata | null>(
    ranked.map((row) => [row.paperItemID, readPaperMetadata(row.paperItemID)]),
  );
  // The shared helper owns display identity, including disambiguating two
  // papers that would otherwise read identically.
  const labels = buildPaperDisplayLabels(
    ranked
      .filter((row) => metadata.get(row.paperItemID))
      .map((row) => ({
        ...metadata.get(row.paperItemID)!,
        identity: String(row.paperItemID),
      })),
  );
  return ranked.map((row) => {
    const label = labels.get(String(row.paperItemID));
    const paperTitle = metadata.get(row.paperItemID)?.title?.trim();
    return {
      paperItemID: row.paperItemID,
      title: label || MISSING_PAPER_LABEL,
      paperTitle: label && paperTitle ? paperTitle : null,
      inLibrary: Boolean(label),
      questions: row.questions,
      totalTokens: row.totalTokens,
    };
  });
}

/** Titles for the given conversation keys, from whichever catalog owns them. */
async function loadConversationTitles(
  conversationKeys: readonly number[],
): Promise<Map<number, string>> {
  const titles = new Map<number, string>();
  if (!conversationKeys.length) return titles;
  const placeholders = conversationKeys.map(() => "?").join(", ");
  for (const table of CONVERSATION_CATALOG_TABLES) {
    const rows = await readRows(
      `SELECT conversation_key AS conversationKey,
              COALESCE(NULLIF(TRIM(title), ''), NULLIF(TRIM(first_user_title), '')) AS title
       FROM ${table}
       WHERE conversation_key IN (${placeholders})`,
      [...conversationKeys],
    );
    for (const row of rows) {
      const key = positiveIntOrZero(row.conversationKey);
      const title = trimmedStringOrNull(row.title);
      if (key && title && !titles.has(key)) titles.set(key, title);
    }
  }
  return titles;
}

/**
 * The library-chat conversations that burned the most tokens.
 *
 * Ranked by tokens, as the panel labels it. A conversation whose catalog row
 * is gone still reports its usage under an honest placeholder title.
 */
export async function loadHeaviestUsageConversations(
  options: UsageQueryOptions & { limit?: number } = {},
): Promise<UsageConversationUsage[]> {
  const { where, params } = rangeFilter(options, ["mode = 'library'"]);
  const limit = clampLimit(options.limit);
  const rows = await readRows(
    `SELECT conversation_key AS conversationKey,
            SUM(CASE WHEN counts_as_question = 1 THEN 1 ELSE 0 END) AS questions,
            SUM(total_tokens) AS totalTokens
     FROM ${USAGE_EVENTS_TABLE}
     ${where}
     GROUP BY conversation_key
     ORDER BY totalTokens DESC, questions DESC, conversation_key ASC
     LIMIT ?`,
    [...params, limit],
  );
  const ranked = rows
    .map((row) => ({
      conversationKey: positiveIntOrZero(row.conversationKey),
      questions: positiveIntOrZero(row.questions),
      totalTokens: positiveIntOrZero(row.totalTokens),
    }))
    .filter((row) => row.conversationKey > 0);
  const titles = await loadConversationTitles(
    ranked.map((row) => row.conversationKey),
  );
  return ranked.map((row) => ({
    ...row,
    title: titles.get(row.conversationKey) || UNTITLED_CONVERSATION_LABEL,
  }));
}

export type UsageHistoryBounds = {
  /** Earliest local day carrying a row, or null when the ledger is empty. */
  firstDate: string | null;
  /** Latest local day carrying a row, or null when the ledger is empty. */
  lastDate: string | null;
  /** Rows on file, retries included; what a reset would delete. */
  events: number;
};

/**
 * How much history exists at all.
 *
 * The view needs this before it draws anything: a heatmap sized for a year is
 * wrong for a user two weeks in, and "Reset statistics" cannot say what it is
 * about to delete without a count.
 */
export async function loadUsageHistoryBounds(): Promise<UsageHistoryBounds> {
  const rows = await readRows(
    `SELECT MIN(local_date) AS firstDate,
            MAX(local_date) AS lastDate,
            COUNT(*) AS events
     FROM ${USAGE_EVENTS_TABLE}`,
  );
  const row = rows[0];
  return {
    firstDate: trimmedStringOrNull(row?.firstDate),
    lastDate: trimmedStringOrNull(row?.lastDate),
    events: positiveIntOrZero(row?.events),
  };
}

/**
 * The user's own rows, for the CSV export.
 *
 * This is the one reader that does load rows into JavaScript, because the
 * export is exactly a copy of the rows. It is a deliberate, user-initiated
 * act, not something the view does while painting.
 */
export async function loadUsageEventsForExport(
  options: UsageQueryOptions = {},
): Promise<StoredUsageEvent[]> {
  const { where, params } = rangeFilter(options);
  const rows = await readRows(
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
     ${where}
     ORDER BY timestamp ASC, id ASC`,
    params,
  );
  return rows.map((row) => ({
    id: positiveIntOrZero(row.id),
    timestamp: Math.floor(Number(row.timestamp)) || 0,
    localDate: trimmedStringOrNull(row.localDate) || "",
    mode: row.mode === "paper" ? "paper" : "library",
    conversationKey: positiveIntOrZero(row.conversationKey),
    conversationInstanceID: trimmedStringOrNull(row.conversationInstanceID),
    libraryID: normalizePositiveInt(row.libraryID),
    paperItemID: normalizePositiveInt(row.paperItemID),
    model: trimmedStringOrNull(row.model),
    provider: trimmedStringOrNull(row.provider),
    runtime: trimmedStringOrNull(row.runtime),
    promptTokens: positiveIntOrZero(row.promptTokens),
    completionTokens: positiveIntOrZero(row.completionTokens),
    totalTokens: positiveIntOrZero(row.totalTokens),
    cacheReadTokens: positiveIntOrZero(row.cacheReadTokens),
    cacheWriteTokens: positiveIntOrZero(row.cacheWriteTokens),
    countsAsQuestion: Number(row.countsAsQuestion) !== 0,
    tokenSource:
      (trimmedStringOrNull(row.tokenSource) as UsageTokenSource | null) ??
      DEFAULT_USAGE_TOKEN_SOURCE,
  }));
}

import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import { resetConversationForkLinksStoreInitForTests } from "../../src/shared/conversationForkLinks";
import { resetConversationRegistryStoreInitForTests } from "../../src/shared/conversationRegistry";
import { resetConversationWriteFenceForTests } from "../../src/shared/conversationWriteFence";
import { resetPendingDeletionStoreForTests } from "../../src/core/conversations/pendingDeletionStore";
import { resetRecentlyDeletedConversationsForTests } from "../../src/core/conversations/recentlyDeletedConversations";
import { resetUsageStoreForTests } from "../../src/utils/usageStore";

/**
 * An in-memory SQLite database (node:sqlite) installed as `Zotero.DB`, for
 * tests that drive the conversation stores against real SQL.
 *
 * Zotero 7's queryAsync wraps rows in a proxy that THROWS when code reads a
 * column the SELECT did not include (node:sqlite returns undefined). The
 * harness mimics that, or a suite silently passes on exactly the row-access
 * bugs that break the real plugin.
 */
export type SqliteHarness = {
  db: DatabaseSync;
  all: (sql: string, params?: unknown[]) => Record<string, unknown>[];
  run: (sql: string, params?: unknown[]) => void;
  transactions: () => number;
  statements: Array<{ sql: string; params: unknown[]; inTransaction: boolean }>;
  prefs: Map<string, unknown>;
};

export type SqliteHarnessOptions = {
  /**
   * The object the installed `Zotero` global is spread over. Defaults to the
   * `Zotero` global at call time.
   */
  baseZotero?: Record<string, unknown>;
  /**
   * When true, `executeTransaction` issues BEGIN/COMMIT/ROLLBACK, so a task
   * that throws rolls back every statement it ran. A nested call throws,
   * because Zotero's would wait on the outer transaction until it times out;
   * concurrent calls queue. When false (the default), the task runs without a
   * database transaction and only the counters change.
   */
  realTransactions?: boolean;
};

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};

export function installSqliteZotero(
  options: SqliteHarnessOptions = {},
): SqliteHarness {
  const baseZotero =
    "baseZotero" in options ? options.baseZotero : globalScope.Zotero;
  const db = new DatabaseSync(":memory:");
  const bindable = (params: unknown[] | undefined) =>
    (Array.isArray(params) ? params : params === undefined ? [] : [params]).map(
      (value) => (value === undefined ? null : value),
    ) as never[];
  const toZoteroRow = (row: Record<string, unknown>) =>
    new Proxy(row, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && !(prop in target)) {
          throw new Error(`Column '${prop}' not present in this row`);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  const statements: SqliteHarness["statements"] = [];
  let openTransactions = 0;
  const queryAsync = async (sql: string, params?: unknown[]) => {
    statements.push({
      sql,
      params: Array.isArray(params) ? params : [],
      inTransaction: openTransactions > 0,
    });
    const head = sql.trimStart().slice(0, 8).toUpperCase();
    const stmt = db.prepare(sql);
    if (
      head.startsWith("SELECT") ||
      head.startsWith("PRAGMA") ||
      head.startsWith("WITH")
    ) {
      return (stmt.all(...bindable(params)) as Record<string, unknown>[]).map(
        toZoteroRow,
      );
    }
    stmt.run(...bindable(params));
    return [];
  };
  const prefs = new Map<string, unknown>();
  let transactions = 0;
  const transactionScope = new AsyncLocalStorage<{ open: boolean }>();
  let transactionQueue: Promise<void> = Promise.resolve();
  const mark = (sql: string) =>
    statements.push({ sql, params: [], inTransaction: true });
  const executeTransaction = options.realTransactions
    ? async (task: () => Promise<unknown>) => {
        // Zotero transactions do not nest: an inner executeTransaction
        // waits on the outer one until it times out. Fail fast instead.
        // The scope closes when its transaction ends, so background work
        // that outlives the transaction queues behind it instead.
        if (transactionScope.getStore()?.open) {
          throw new Error("Nested Zotero.DB.executeTransaction would deadlock");
        }
        // Concurrent (not nested) transactions queue, as in Zotero.
        const previous = transactionQueue;
        let release!: () => void;
        transactionQueue = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        transactions += 1;
        try {
          db.exec("BEGIN IMMEDIATE");
        } catch (error) {
          // A failed BEGIN must still free the queue for the next caller.
          release();
          throw error;
        }
        openTransactions += 1;
        mark("BEGIN");
        const scope = { open: true };
        try {
          const result = await transactionScope.run(scope, task);
          mark("COMMIT");
          openTransactions -= 1;
          db.exec("COMMIT");
          return result;
        } catch (error) {
          mark("ROLLBACK");
          openTransactions -= 1;
          db.exec("ROLLBACK");
          throw error;
        } finally {
          scope.open = false;
          release();
        }
      }
    : async (task: () => Promise<unknown>) => {
        transactions += 1;
        openTransactions += 1;
        try {
          return await task();
        } finally {
          openTransactions -= 1;
        }
      };
  globalScope.Zotero = {
    ...(baseZotero || {}),
    Libraries: { userLibraryID: 1 },
    Items: { get: () => null },
    Prefs: {
      get: (key: string) => prefs.get(key),
      set: (key: string, value: unknown) => prefs.set(key, value),
      clear: (key: string) => prefs.delete(key),
    },
    Profile: { dir: "/tmp/llm-for-zotero-store-mechanics" },
    debug: () => undefined,
    DB: {
      queryAsync,
      executeTransaction,
    },
  };
  return {
    db,
    all: (sql, params) =>
      db.prepare(sql).all(...((params || []) as never[])) as Record<
        string,
        unknown
      >[],
    run: (sql, params) => {
      db.prepare(sql).run(...((params || []) as never[]));
    },
    transactions: () => transactions,
    statements,
    prefs,
  };
}

/**
 * Drop every process-local cache the conversation stores keep across calls
 * (init promises, tombstone maps, write fences, the pending-deletion fence),
 * so a test that swaps in a fresh database starts from a cold process.
 */
export function resetConversationStoreProcessStateForTests(): void {
  resetConversationRegistryStoreInitForTests();
  resetConversationForkLinksStoreInitForTests();
  resetRecentlyDeletedConversationsForTests();
  resetPendingDeletionStoreForTests();
  resetConversationWriteFenceForTests();
  resetUsageStoreForTests();
}

/**
 * A fixed wall clock for store tests. The stores read `Date.now()` for
 * catalog timestamps; a constant value keeps every such write deterministic
 * and independent of how many times a refactored store reads the clock.
 * The value is far from real time, so a real-time leak shows up in a diff.
 */
export const FIXED_STORE_CLOCK_MS = 4_102_444_800_000;

export function installFixedClock(now = FIXED_STORE_CLOCK_MS): () => void {
  const originalNow = Date.now;
  Date.now = () => now;
  return () => {
    Date.now = originalNow;
  };
}

export type DatabaseDump = Record<string, Array<Record<string, unknown>>>;

const RANDOM_ID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|instance-[0-9a-f]{32}|\bid-[0-9a-f]{1,8}-[0-9a-f]{1,8}-[0-9a-f]{1,8}\b/g;
const CLOCK_WINDOW_MS = 10_000_000_000;
const EMBEDDED_CLOCK_PATTERN = /\b\d{13}\b/g;

function clockToken(value: number, now: number): string | null {
  if (!Number.isInteger(value)) return null;
  const delta = value - now;
  if (Math.abs(delta) > CLOCK_WINDOW_MS) return null;
  if (delta === 0) return "<now>";
  return delta > 0 ? `<now+${delta}>` : `<now${delta}>`;
}

/**
 * Masks the values a store derives from randomness or the clock, in any JSON
 * structure:
 * - integers near the fixed clock become `<now>` / `<now+N>` / `<now-N>`,
 *   also when they appear inside a string;
 * - random instance IDs (UUIDs, `instance-<hex>`) and the tombstone digests
 *   derived from them become `<id-N>`, numbered by first appearance in a
 *   depth-first walk, so one ID keeps one token across tables, results and
 *   larger strings.
 * With `placeholder` set every random ID becomes `<id>`; that form is only
 * used to sort rows before numbering.
 */
export function createDeterministicMasker(
  options: { now?: number; placeholder?: boolean } = {},
): (value: unknown) => unknown {
  const now = options.now ?? FIXED_STORE_CLOCK_MS;
  const ids = new Map<string, string>();
  const maskString = (text: string): string =>
    text
      .replace(RANDOM_ID_PATTERN, (match) => {
        if (options.placeholder) return "<id>";
        let token = ids.get(match);
        if (!token) {
          token = `<id-${ids.size + 1}>`;
          ids.set(match, token);
        }
        return token;
      })
      .replace(
        EMBEDDED_CLOCK_PATTERN,
        (match) => clockToken(Number(match), now) ?? match,
      );
  const mask = (value: unknown): unknown => {
    if (typeof value === "bigint") return mask(Number(value));
    if (typeof value === "number") return clockToken(value, now) ?? value;
    if (typeof value === "string") return maskString(value);
    if (Array.isArray(value)) return value.map(mask);
    if (value instanceof Error) {
      return { error: value.name, message: maskString(value.message) };
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined) continue;
        out[key] = mask(entry);
      }
      return out;
    }
    return value;
  };
  return mask;
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function compareKeys(left: unknown[], right: unknown[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a) < String(b) ? -1 : 1;
  }
  return 0;
}

/**
 * Every table except `sqlite_*`, rows in primary-key order, values NOT yet
 * masked. Rows are sorted by their primary key with random IDs replaced by a
 * placeholder, then by the whole placeholder-masked row, then by rowid, so a
 * table keyed by a random ID still dumps in a stable order.
 */
export function dumpDatabase(
  db: DatabaseSync,
  options: { now?: number } = {},
): DatabaseDump {
  const tableNames = (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  const placeholderMask = createDeterministicMasker({
    now: options.now,
    placeholder: true,
  });
  const dump: DatabaseDump = {};
  for (const table of tableNames) {
    const columns = db
      .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all() as Array<{ name: string; pk: number }>;
    const pkColumns = columns
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    const rows = db
      .prepare(`SELECT rowid AS "__rowid", * FROM ${quoteIdentifier(table)}`)
      .all() as Array<Record<string, unknown>>;
    const sortable = rows.map((row) => {
      const { __rowid: rowid, ...rest } = row;
      const masked = placeholderMask(rest) as Record<string, unknown>;
      return {
        row: rest,
        sortKey: [
          ...pkColumns.map((column) => masked[column]),
          JSON.stringify(masked),
          Number(rowid),
        ],
      };
    });
    sortable.sort((a, b) => compareKeys(a.sortKey, b.sortKey));
    dump[table] = sortable.map((entry) => entry.row);
  }
  return dump;
}

export function sortedPrefs(
  prefs: Map<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    [...prefs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/**
 * The schema half of a snapshot: every table, index and trigger with its
 * creating SQL, in name order. Pins DDL text, index columns and the trigger
 * set at once.
 */
export function snapshotSchema(
  db: DatabaseSync,
): Array<{ type: string; name: string; tbl_name: string; sql: string | null }> {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all() as Array<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }>;
}

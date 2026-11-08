import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
  UPSTREAM_PAPER_CONVERSATION_KEY_BASE,
} from "../src/shared/conversationKeySpace";
import {
  bumpConversationWriteGeneration,
  freezeConversationWrites,
  getConversationWriteGeneration,
  resetConversationWriteFenceForTests,
} from "../src/shared/conversationWriteFence";
import {
  USAGE_EVENTS_TABLE,
  USAGE_UNREPORTED_HEAL_INDEX,
  clearAllUsageEvents,
  countHistoryEstimateUsageEvents,
  deleteUsageEventsForConversation,
  initUsageStore,
  loadUsageEventsForConversation,
  recordUsageEvent,
  resetUsageStoreForTests,
  toLocalDateKey,
} from "../src/utils/usageStore";
import { createTurnUsageRecorder } from "../src/utils/usageTurnRecorder";
import { resetConversationStoreProcessStateForTests } from "./helpers/conversationStoreDb";
import {
  appendMessage,
  createGlobalConversation,
  deleteUpstreamConversationLocalRows,
  initChatStore,
} from "../src/utils/chatStore";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

type SqliteHarness = {
  db: DatabaseSync;
  all: (sql: string, params?: unknown[]) => Record<string, unknown>[];
  failNextWrites: (count: number) => void;
  failWritesMatching: (pattern: RegExp | null) => void;
};

function installSqliteZotero(): SqliteHarness {
  const db = new DatabaseSync(":memory:");
  let failingWrites = 0;
  let failingWritePattern: RegExp | null = null;
  const bindable = (params: unknown[] | undefined) =>
    (Array.isArray(params) ? params : params === undefined ? [] : [params]).map(
      (value) => (value === undefined ? null : value),
    ) as never[];
  // Zotero's queryAsync hands back rows that THROW when code reads a column the
  // SELECT did not include (node:sqlite would quietly return undefined). Mimic
  // that or the suite passes on exactly the row-access bugs that break the
  // real plugin.
  const toZoteroRow = (row: Record<string, unknown>) =>
    new Proxy(row, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && !(prop in target)) {
          throw new Error(`Column '${prop}' not present in this row`);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  const queryAsync = async (sql: string, params?: unknown[]) => {
    const head = sql.trimStart().slice(0, 8).toUpperCase();
    const isRead =
      head.startsWith("SELECT") ||
      head.startsWith("PRAGMA") ||
      head.startsWith("WITH");
    if (!isRead && failingWritePattern?.test(sql)) {
      throw new Error("simulated database failure");
    }
    if (!isRead && failingWrites > 0) {
      failingWrites -= 1;
      throw new Error("simulated database failure");
    }
    const stmt = db.prepare(sql);
    if (isRead) {
      return (stmt.all(...bindable(params)) as Record<string, unknown>[]).map(
        toZoteroRow,
      );
    }
    stmt.run(...bindable(params));
    return [];
  };
  globalScope.Zotero = {
    ...(originalZotero || {}),
    Libraries: { userLibraryID: 1 },
    debug: () => undefined,
    DB: {
      queryAsync,
      executeTransaction: async (task: () => Promise<unknown>) => await task(),
    },
  };
  return {
    db,
    all: (sql, params) =>
      db.prepare(sql).all(...((params || []) as never[])) as Record<
        string,
        unknown
      >[],
    failNextWrites: (count: number) => {
      failingWrites = count;
    },
    failWritesMatching: (pattern: RegExp | null) => {
      failingWritePattern = pattern;
    },
  };
}

const LIBRARY_KEY = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 11;
const PAPER_KEY = UPSTREAM_PAPER_CONVERSATION_KEY_BASE + 7;

describe("usage store", function () {
  let harness: SqliteHarness;

  beforeEach(function () {
    resetUsageStoreForTests();
    resetConversationWriteFenceForTests();
    harness = installSqliteZotero();
  });

  afterEach(function () {
    harness.db.close();
    resetUsageStoreForTests();
    resetConversationWriteFenceForTests();
    globalScope.Zotero = originalZotero;
  });

  it("creates the table and its query indexes, and init is re-entrant", async function () {
    await Promise.all([initUsageStore(), initUsageStore()]);
    await initUsageStore();
    const tables = harness.all(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [USAGE_EVENTS_TABLE],
    );
    assert.lengthOf(tables, 1);
    const indexes = harness
      .all(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`,
        [USAGE_EVENTS_TABLE],
      )
      .map((row) => String(row.name));
    for (const expected of [
      "llm_for_zotero_usage_events_local_date",
      "llm_for_zotero_usage_events_conversation",
      "llm_for_zotero_usage_events_mode_date",
      "llm_for_zotero_usage_events_paper",
    ]) {
      assert.include(indexes, expected);
    }
  });

  it("stores the local calendar day, not the UTC day", async function () {
    const lateEvening = new Date(2026, 8, 19, 23, 30, 0).getTime();
    await recordUsageEvent({
      mode: "library",
      conversationKey: LIBRARY_KEY,
      timestamp: lateEvening,
      totalTokens: 10,
    });
    const rows = await loadUsageEventsForConversation(LIBRARY_KEY);
    assert.lengthOf(rows, 1);
    assert.strictEqual(rows[0]!.localDate, "2026-09-19");
    assert.strictEqual(rows[0]!.localDate, toLocalDateKey(lateEvening));
  });

  it("deletes every usage row for a conversation", async function () {
    await recordUsageEvent({
      mode: "library",
      conversationKey: LIBRARY_KEY,
      totalTokens: 5,
    });
    await recordUsageEvent({
      mode: "paper",
      conversationKey: PAPER_KEY,
      totalTokens: 5,
    });
    await deleteUsageEventsForConversation(LIBRARY_KEY);
    assert.lengthOf(await loadUsageEventsForConversation(LIBRARY_KEY), 0);
    assert.lengthOf(await loadUsageEventsForConversation(PAPER_KEY), 1);
  });

  it("keeps a failing cascade from breaking the conversation deletion", async function () {
    await recordUsageEvent({
      mode: "library",
      conversationKey: LIBRARY_KEY,
      totalTokens: 7,
    });
    harness.failWritesMatching(/DELETE FROM llm_for_zotero_usage_events/i);
    let threw: unknown;
    try {
      await deleteUsageEventsForConversation(LIBRARY_KEY);
    } catch (error) {
      threw = error;
    }
    harness.failWritesMatching(null);
    assert.isUndefined(threw);
  });

  it("swallows a write failure instead of throwing at the caller", async function () {
    await initUsageStore();
    harness.failNextWrites(1);
    const written = await recordUsageEvent({
      mode: "library",
      conversationKey: LIBRARY_KEY,
      totalTokens: 100,
    });
    assert.isFalse(written);
    assert.lengthOf(await loadUsageEventsForConversation(LIBRARY_KEY), 0);
  });
});

describe("per-turn usage recorder", function () {
  let harness: SqliteHarness;

  beforeEach(function () {
    resetUsageStoreForTests();
    resetConversationWriteFenceForTests();
    harness = installSqliteZotero();
  });

  afterEach(function () {
    harness.db.close();
    resetUsageStoreForTests();
    resetConversationWriteFenceForTests();
    globalScope.Zotero = originalZotero;
  });

  it("collapses a cumulative Anthropic-style stream into one row of maxima", async function () {
    const recorder = createTurnUsageRecorder({
      conversationKey: LIBRARY_KEY,
      runtime: "chat",
      model: "claude-sonnet",
      provider: "Anthropic",
    });
    recorder.markDispatched();
    // message_start: input tokens, a first output token count.
    recorder.record({
      promptTokens: 1200,
      completionTokens: 2,
      totalTokens: 1202,
      cacheReadTokens: 900,
      cacheWriteTokens: 300,
    });
    // message_delta: CUMULATIVE output tokens, prompt reported as zero.
    recorder.record({ promptTokens: 0, completionTokens: 40, totalTokens: 40 });
    recorder.record({
      promptTokens: 0,
      completionTokens: 180,
      totalTokens: 180,
    });
    recorder.record({
      promptTokens: 0,
      completionTokens: 512,
      totalTokens: 512,
    });
    assert.isTrue(await recorder.flush("complete"));

    const rows = await loadUsageEventsForConversation(LIBRARY_KEY);
    assert.lengthOf(rows, 1, "one turn must produce exactly one row");
    assert.strictEqual(rows[0]!.promptTokens, 1200);
    assert.strictEqual(rows[0]!.completionTokens, 512);
    assert.strictEqual(rows[0]!.totalTokens, 1712);
    assert.strictEqual(rows[0]!.cacheReadTokens, 900);
    assert.strictEqual(rows[0]!.cacheWriteTokens, 300);
    assert.strictEqual(rows[0]!.model, "claude-sonnet");
    assert.strictEqual(rows[0]!.provider, "Anthropic");
    assert.strictEqual(rows[0]!.runtime, "chat");
    assert.isTrue(rows[0]!.countsAsQuestion);
  });

  it("keeps the maximum of a cumulative Gemini-style reporter, never the sum", async function () {
    const recorder = createTurnUsageRecorder({
      conversationKey: LIBRARY_KEY,
      runtime: "chat",
    });
    recorder.markDispatched();
    recorder.record({
      promptTokens: 800,
      completionTokens: 20,
      totalTokens: 820,
    });
    recorder.record({
      promptTokens: 800,
      completionTokens: 120,
      totalTokens: 920,
    });
    recorder.record({
      promptTokens: 800,
      completionTokens: 300,
      totalTokens: 1100,
    });
    await recorder.flush("complete");
    const rows = await loadUsageEventsForConversation(LIBRARY_KEY);
    assert.lengthOf(rows, 1);
    assert.strictEqual(rows[0]!.promptTokens, 800);
    assert.strictEqual(rows[0]!.completionTokens, 300);
    assert.strictEqual(rows[0]!.totalTokens, 1100);
  });

  it("sums across agent rounds while maxing within each round", async function () {
    const recorder = createTurnUsageRecorder({
      conversationKey: LIBRARY_KEY,
      runtime: "agent",
    });
    recorder.markDispatched();
    recorder.record(
      { promptTokens: 1000, completionTokens: 10, totalTokens: 1010 },
      { segment: 1 },
    );
    recorder.record(
      { promptTokens: 1000, completionTokens: 90, totalTokens: 1090 },
      { segment: 1 },
    );
    recorder.record(
      { promptTokens: 1500, completionTokens: 25, totalTokens: 1525 },
      { segment: 2 },
    );
    recorder.record(
      { promptTokens: 1500, completionTokens: 200, totalTokens: 1700 },
      { segment: 2 },
    );
    await recorder.flush("complete");
    const rows = await loadUsageEventsForConversation(LIBRARY_KEY);
    assert.lengthOf(rows, 1);
    assert.strictEqual(rows[0]!.promptTokens, 2500);
    assert.strictEqual(rows[0]!.completionTokens, 290);
    assert.strictEqual(rows[0]!.totalTokens, 2790);
  });

  it("treats a drop in a cumulative counter as a new provider request", async function () {
    const recorder = createTurnUsageRecorder({
      conversationKey: LIBRARY_KEY,
      runtime: "chat",
    });
    recorder.markDispatched();
    recorder.record({
      promptTokens: 600,
      completionTokens: 250,
      totalTokens: 850,
    });
    // A recovery retry inside the same turn starts the counters over.
    recorder.record({
      promptTokens: 640,
      completionTokens: 30,
      totalTokens: 670,
    });
    recorder.record({
      promptTokens: 640,
      completionTokens: 410,
      totalTokens: 1050,
    });
    await recorder.flush("complete");
    const rows = await loadUsageEventsForConversation(LIBRARY_KEY);
    assert.lengthOf(rows, 1);
    assert.strictEqual(rows[0]!.promptTokens, 1240);
    assert.strictEqual(rows[0]!.completionTokens, 660);
    assert.strictEqual(rows[0]!.totalTokens, 1900);
  });

  it("records the tokens an aborted turn already burned", async function () {
    const recorder = createTurnUsageRecorder({
      conversationKey: LIBRARY_KEY,
      runtime: "chat",
    });
    recorder.markDispatched();
    recorder.record({
      promptTokens: 900,
      completionTokens: 15,
      totalTokens: 915,
    });
    recorder.record({ promptTokens: 0, completionTokens: 77, totalTokens: 77 });
    assert.isTrue(await recorder.flush("abort"));
    const rows = await loadUsageEventsForConversation(LIBRARY_KEY);
    assert.lengthOf(rows, 1);
    assert.strictEqual(rows[0]!.promptTokens, 900);
    assert.strictEqual(rows[0]!.completionTokens, 77);
  });

  it("flushes exactly once even when the settle point runs twice", async function () {
    const recorder = createTurnUsageRecorder({
      conversationKey: LIBRARY_KEY,
      runtime: "chat",
    });
    recorder.markDispatched();
    recorder.record({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    assert.isTrue(await recorder.flush("error"));
    assert.isFalse(await recorder.flush("complete"));
    assert.lengthOf(await loadUsageEventsForConversation(LIBRARY_KEY), 1);
  });

  it("records a retry's tokens without counting a second question", async function () {
    const ask = createTurnUsageRecorder({
      conversationKey: LIBRARY_KEY,
      runtime: "chat",
    });
    ask.markDispatched();
    ask.record({ promptTokens: 500, completionTokens: 100, totalTokens: 600 });
    await ask.flush("complete");

    const retry = createTurnUsageRecorder({
      conversationKey: LIBRARY_KEY,
      runtime: "chat",
      countsAsQuestion: false,
    });
    retry.markDispatched();
    retry.record({
      promptTokens: 520,
      completionTokens: 140,
      totalTokens: 660,
    });
    await retry.flush("complete");

    const rows = await loadUsageEventsForConversation(LIBRARY_KEY);
    assert.lengthOf(rows, 2, "a retry's tokens are real and must be recorded");
    assert.deepStrictEqual(
      rows.map((row) => row.countsAsQuestion),
      [true, false],
    );
    assert.strictEqual(
      rows.filter((row) => row.countsAsQuestion).length,
      1,
      "a retry must not count as a second question",
    );
    assert.strictEqual(
      rows.reduce((sum, row) => sum + row.totalTokens, 0),
      1260,
    );
  });

  it("attributes paper chat and library chat from the conversation key", async function () {
    const paper = createTurnUsageRecorder({
      conversationKey: PAPER_KEY,
      runtime: "chat",
    });
    paper.markDispatched();
    paper.record({ promptTokens: 30, completionTokens: 3, totalTokens: 33 });
    await paper.flush("complete");

    const library = createTurnUsageRecorder({
      conversationKey: LIBRARY_KEY,
      runtime: "chat",
    });
    library.markDispatched();
    library.record({ promptTokens: 40, completionTokens: 4, totalTokens: 44 });
    await library.flush("complete");

    assert.strictEqual(
      (await loadUsageEventsForConversation(PAPER_KEY))[0]!.mode,
      "paper",
    );
    assert.strictEqual(
      (await loadUsageEventsForConversation(LIBRARY_KEY))[0]!.mode,
      "library",
    );
  });

  it("refuses to write when the conversation's writes are frozen", async function () {
    const recorder = createTurnUsageRecorder({
      conversationKey: LIBRARY_KEY,
      runtime: "chat",
    });
    recorder.markDispatched();
    recorder.record({
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
    });
    freezeConversationWrites(LIBRARY_KEY);
    assert.isFalse(await recorder.flush("complete"));
    assert.lengthOf(await loadUsageEventsForConversation(LIBRARY_KEY), 0);
  });

  it("refuses to write for a stale write generation", async function () {
    const generation = getConversationWriteGeneration(LIBRARY_KEY);
    const recorder = createTurnUsageRecorder({
      conversationKey: LIBRARY_KEY,
      conversationGeneration: generation,
      runtime: "chat",
    });
    recorder.markDispatched();
    recorder.record({
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
    });
    bumpConversationWriteGeneration(LIBRARY_KEY);
    assert.isFalse(await recorder.flush("complete"));
    assert.lengthOf(await loadUsageEventsForConversation(LIBRARY_KEY), 0);
    // A sample arriving after the generation moved is dropped too.
    recorder.record({
      promptTokens: 999,
      completionTokens: 999,
      totalTokens: 1998,
    });
    assert.strictEqual(recorder.snapshot().promptTokens, 100);
  });

  it("writes nothing for a turn that never dispatched and saw no usage", async function () {
    const recorder = createTurnUsageRecorder({
      conversationKey: LIBRARY_KEY,
      runtime: "chat",
    });
    assert.isFalse(await recorder.flush("error"));
    assert.lengthOf(await loadUsageEventsForConversation(LIBRARY_KEY), 0);
  });

  it("records a dispatched turn the provider never reported usage for", async function () {
    const recorder = createTurnUsageRecorder({
      conversationKey: LIBRARY_KEY,
      runtime: "codex",
    });
    recorder.markDispatched();
    assert.isTrue(await recorder.flush("complete"));
    const rows = await loadUsageEventsForConversation(LIBRARY_KEY);
    assert.lengthOf(rows, 1);
    assert.strictEqual(rows[0]!.totalTokens, 0);
    assert.isTrue(rows[0]!.countsAsQuestion);
  });

  it("never lets a database failure escape into the turn", async function () {
    const recorder = createTurnUsageRecorder({
      conversationKey: LIBRARY_KEY,
      runtime: "chat",
    });
    recorder.markDispatched();
    recorder.record({
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
    });
    await initUsageStore();
    harness.failWritesMatching(/INSERT INTO llm_for_zotero_usage_events/i);
    let threw: unknown;
    let flushed = true;
    try {
      flushed = await recorder.flush("complete");
    } catch (error) {
      threw = error;
    }
    assert.isUndefined(threw, "flush must not throw into the streaming path");
    assert.isFalse(flushed);
    harness.failWritesMatching(null);
    assert.lengthOf(await loadUsageEventsForConversation(LIBRARY_KEY), 0);
  });

  it("ignores nonsense usage payloads without throwing", async function () {
    const recorder = createTurnUsageRecorder({
      conversationKey: LIBRARY_KEY,
      runtime: "chat",
    });
    recorder.markDispatched();
    recorder.record({
      promptTokens: Number.NaN,
      completionTokens: -50,
      totalTokens: Number.POSITIVE_INFINITY,
    });
    recorder.record({
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
    });
    await recorder.flush("complete");
    const rows = await loadUsageEventsForConversation(LIBRARY_KEY);
    assert.lengthOf(rows, 1);
    assert.strictEqual(rows[0]!.promptTokens, 120);
    assert.strictEqual(rows[0]!.completionTokens, 30);
    assert.strictEqual(rows[0]!.totalTokens, 150);
  });
});

describe("usage rows cascade with conversation deletion", function () {
  let db: DatabaseSync;
  const prefs = new Map<string, unknown>();

  beforeEach(function () {
    // Other suites already ran the one-shot schema passes against their own
    // database; this suite installs a fresh one and needs the tables created.
    resetConversationStoreProcessStateForTests();
    db = new DatabaseSync(":memory:");
    const bindable = (params: unknown[] | undefined) =>
      (Array.isArray(params)
        ? params
        : params === undefined
          ? []
          : [params]
      ).map((value) => (value === undefined ? null : value)) as never[];
    const toZoteroRow = (row: Record<string, unknown>) =>
      new Proxy(row, {
        get(target, prop, receiver) {
          if (typeof prop === "string" && !(prop in target)) {
            throw new Error(`Column '${prop}' not present in this row`);
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Libraries: { userLibraryID: 1 },
      Items: { get: () => null },
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
        clear: (key: string) => prefs.delete(key),
      },
      Profile: { dir: "/tmp/llm-for-zotero-usage-cascade" },
      debug: () => undefined,
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          const head = sql.trimStart().slice(0, 8).toUpperCase();
          const stmt = db.prepare(sql);
          if (
            head.startsWith("SELECT") ||
            head.startsWith("PRAGMA") ||
            head.startsWith("WITH")
          ) {
            return (
              stmt.all(...bindable(params)) as Record<string, unknown>[]
            ).map(toZoteroRow);
          }
          stmt.run(...bindable(params));
          return [];
        },
        executeTransaction: async (task: () => Promise<unknown>) =>
          await task(),
      },
    };
  });

  afterEach(function () {
    db.close();
    prefs.clear();
    resetUsageStoreForTests();
    resetConversationWriteFenceForTests();
    globalScope.Zotero = originalZotero;
  });

  it("removes a deleted conversation's usage rows through the real delete path", async function () {
    await initChatStore();
    const deletedKey = await createGlobalConversation(1);
    const survivorKey = await createGlobalConversation(1);
    assert.isAbove(deletedKey, 0);
    assert.isAbove(survivorKey, 0);
    await appendMessage(deletedKey, {
      role: "user",
      text: "how does this paper define plasticity?",
      timestamp: Date.now(),
    });

    const recorder = createTurnUsageRecorder({
      conversationKey: deletedKey,
      runtime: "chat",
    });
    recorder.markDispatched();
    recorder.record({
      promptTokens: 400,
      completionTokens: 60,
      totalTokens: 460,
    });
    assert.isTrue(await recorder.flush("complete"));
    await recordUsageEvent({
      mode: "library",
      conversationKey: survivorKey,
      totalTokens: 12,
    });
    assert.lengthOf(await loadUsageEventsForConversation(deletedKey), 1);

    await deleteUpstreamConversationLocalRows(deletedKey, "global");

    assert.lengthOf(
      await loadUsageEventsForConversation(deletedKey),
      0,
      "a deleted conversation must leave no usage rows behind",
    );
    assert.lengthOf(
      await loadUsageEventsForConversation(survivorKey),
      1,
      "only the deleted conversation's rows may be removed",
    );
  });
});

describe("resetting the usage ledger", function () {
  let harness: SqliteHarness;

  beforeEach(function () {
    resetUsageStoreForTests();
    resetConversationWriteFenceForTests();
    harness = installSqliteZotero();
  });

  afterEach(function () {
    harness.db.close();
    resetUsageStoreForTests();
    resetConversationWriteFenceForTests();
    globalScope.Zotero = originalZotero;
  });

  it("deletes every usage row and leaves the table in place", async function () {
    await initUsageStore();
    await recordUsageEvent({
      mode: "library",
      conversationKey: LIBRARY_KEY,
      totalTokens: 10,
    });
    await recordUsageEvent({
      mode: "paper",
      conversationKey: PAPER_KEY,
      paperItemID: 4,
      totalTokens: 20,
    });
    assert.isTrue(await clearAllUsageEvents());
    assert.lengthOf(await loadUsageEventsForConversation(LIBRARY_KEY), 0);
    assert.lengthOf(await loadUsageEventsForConversation(PAPER_KEY), 0);
    assert.lengthOf(
      harness.all(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [USAGE_EVENTS_TABLE],
      ),
      1,
      "the reset clears rows, it does not drop the ledger",
    );
    // Recording must still work straight after a reset.
    await recordUsageEvent({
      mode: "library",
      conversationKey: LIBRARY_KEY,
      totalTokens: 5,
    });
    assert.lengthOf(await loadUsageEventsForConversation(LIBRARY_KEY), 1);
  });

  it("succeeds when there is no ledger to clear", async function () {
    assert.isTrue(await clearAllUsageEvents());
  });

  it("counts the reconstructed rows the reset warning has to name", async function () {
    await initUsageStore();
    await recordUsageEvent({
      mode: "library",
      conversationKey: LIBRARY_KEY,
      totalTokens: 10,
    });
    assert.equal(
      await countHistoryEstimateUsageEvents(),
      0,
      "a provider-reported turn is not reconstructed history",
    );
    for (let index = 0; index < 3; index += 1) {
      await recordUsageEvent({
        mode: "paper",
        conversationKey: PAPER_KEY,
        paperItemID: 4,
        promptTokens: 900,
        totalTokens: 900,
        tokenSource: "history-estimate",
      });
    }
    await recordUsageEvent({
      mode: "library",
      conversationKey: LIBRARY_KEY,
      tokenSource: "unreported",
    });
    assert.equal(await countHistoryEstimateUsageEvents(), 3);
    assert.isTrue(await clearAllUsageEvents());
    assert.equal(await countHistoryEstimateUsageEvents(), 0);
  });

  it("counts nothing when the ledger was never created", async function () {
    assert.equal(await countHistoryEstimateUsageEvents(), 0);
    assert.lengthOf(
      harness.all(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [USAGE_EVENTS_TABLE],
      ),
      0,
      "counting must not create the ledger it is asking about",
    );
  });
});

describe("schema creation against a Zotero-shaped connection", function () {
  let db: DatabaseSync;

  beforeEach(function () {
    resetUsageStoreForTests();
    db = new DatabaseSync(":memory:");
  });

  afterEach(function () {
    db.close();
    resetUsageStoreForTests();
    globalScope.Zotero = originalZotero;
  });

  function zoteroShapedConnection(options: {
    withTransaction: boolean;
    onTransaction?: () => void;
  }): Record<string, unknown> {
    const connection: Record<string, unknown> = {
      async queryAsync(sql: string, params?: unknown[]) {
        const head = sql.trimStart().slice(0, 6).toUpperCase();
        const stmt = db.prepare(sql);
        const bound = (params || []).map((value) =>
          value === undefined ? null : value,
        ) as never[];
        if (head === "SELECT" || head === "PRAGMA") return stmt.all(...bound);
        stmt.run(...bound);
        return [];
      },
    };
    if (options.withTransaction) {
      connection.executeTransaction = async (task: () => Promise<void>) => {
        options.onTransaction?.();
        await task();
      };
    }
    return connection;
  }

  function installConnection(connection: Record<string, unknown>): void {
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Libraries: { userLibraryID: 1 },
      debug: () => undefined,
      DB: connection,
    } as unknown as Record<string, unknown>;
  }

  const EXPECTED_INDEXES = [
    "llm_for_zotero_usage_events_local_date",
    "llm_for_zotero_usage_events_conversation",
    "llm_for_zotero_usage_events_mode_date",
    "llm_for_zotero_usage_events_paper",
    USAGE_UNREPORTED_HEAL_INDEX,
  ];

  function assertSchemaCreated(): void {
    assert.lengthOf(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        )
        .all(USAGE_EVENTS_TABLE),
      1,
      "the ledger table must exist after init",
    );
    const indexes = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`,
        )
        .all(USAGE_EVENTS_TABLE) as Array<{ name: string }>
    ).map((row) => row.name);
    assert.includeMembers(indexes, EXPECTED_INDEXES);
  }

  it("builds the schema without holding a Zotero transaction", async function () {
    // Issue #485: a startup executeTransaction occupies Zotero's single
    // transaction slot while the library loads, blocking sync and updates on
    // large libraries. Every schema statement is idempotent and individually
    // atomic, so the pass must never open one.
    let transactions = 0;
    installConnection(
      zoteroShapedConnection({
        withTransaction: true,
        onTransaction: () => {
          transactions += 1;
        },
      }),
    );

    await initUsageStore();

    assert.equal(
      transactions,
      0,
      "the schema pass must not open a transaction",
    );
    assertSchemaCreated();
    assert.isTrue(
      await recordUsageEvent({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        totalTokens: 12,
      }),
      "a turn recorded straight after init must land",
    );
  });

  it("builds the schema on a connection with no executeTransaction", async function () {
    installConnection(zoteroShapedConnection({ withTransaction: false }));

    await initUsageStore();

    assertSchemaCreated();
  });
});

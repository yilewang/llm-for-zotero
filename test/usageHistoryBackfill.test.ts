import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  CLAUDE_PAPER_CONVERSATION_KEY_BASE,
  UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
  UPSTREAM_PAPER_CONVERSATION_KEY_BASE,
} from "../src/shared/conversationKeySpace";
import {
  appendClaudeMessage,
  initClaudeCodeStore,
  upsertClaudeConversationSummary,
} from "../src/claudeCode/store";
import { resetConversationWriteFenceForTests } from "../src/shared/conversationWriteFence";
import {
  USAGE_EVENTS_TABLE,
  initUsageStore,
  loadUsageEventsForConversation,
  recordUsageEvent,
  resetUsageStoreForTests,
} from "../src/utils/usageStore";
import {
  USAGE_HISTORY_BACKFILL_MIGRATION_ID,
  USAGE_HISTORY_OUTPUT_BACKFILL_MIGRATION_ID,
  backfillUsageHistory,
  backfillUsageHistoryOutputTokens,
  resetUsageHistoryBackfillForTests,
} from "../src/utils/usageHistoryBackfill";
import { CONVERSATION_SCHEMA_MIGRATIONS_TABLE } from "../src/shared/conversationSchemaMigrations";
import { resetConversationForkLinksStoreInitForTests } from "../src/shared/conversationForkLinks";
import { resetRecentlyDeletedConversationsForTests } from "../src/core/conversations/recentlyDeletedConversations";
import { resetConversationRegistryStoreInitForTests } from "../src/shared/conversationRegistry";
import {
  appendMessage,
  createGlobalConversation,
  createPaperConversation,
  deleteUpstreamConversationLocalRows,
  initChatStore,
  type StoredChatMessage,
} from "../src/utils/chatStore";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

type SqliteHarness = {
  db: DatabaseSync;
  all: (sql: string, params?: unknown[]) => Record<string, unknown>[];
  statements: string[];
};

/**
 * Zotero's `queryAsync` hands back rows that THROW when code reads a column the
 * SELECT did not include. node:sqlite would quietly return undefined, so the
 * fake proxies every row to reproduce the real failure.
 */
function installSqliteZotero(): SqliteHarness {
  const db = new DatabaseSync(":memory:");
  const prefs = new Map<string, unknown>();
  const statements: string[] = [];
  let transactionDepth = 0;
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
  const queryAsync = async (sql: string, params?: unknown[]) => {
    const head = sql.trimStart().slice(0, 8).toUpperCase();
    const isRead =
      head.startsWith("SELECT") ||
      head.startsWith("PRAGMA") ||
      head.startsWith("WITH");
    if (!isRead) {
      statements.push(
        `${transactionDepth > 0 ? "tx:" : "auto:"}${sql.trimStart().slice(0, 64)}`,
      );
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
    Items: { get: () => null },
    Prefs: {
      get: (key: string) => prefs.get(key),
      set: (key: string, value: unknown) => prefs.set(key, value),
      clear: (key: string) => prefs.delete(key),
    },
    Profile: { dir: "/tmp/llm-for-zotero-usage-backfill" },
    debug: () => undefined,
    DB: {
      queryAsync,
      executeTransaction: async (task: () => Promise<unknown>) => {
        transactionDepth += 1;
        try {
          return await task();
        } finally {
          transactionDepth -= 1;
        }
      },
    },
  };
  return {
    db,
    all: (sql, params) =>
      db.prepare(sql).all(...((params || []) as never[])) as Record<
        string,
        unknown
      >[],
    statements,
  };
}

const LIBRARY_ID = 1;
const DAY = 24 * 60 * 60 * 1000;
const BASE_TIME = new Date(2026, 0, 5, 10, 0, 0).getTime();

function userMessage(
  timestamp: number,
  overrides: Partial<StoredChatMessage> = {},
): StoredChatMessage {
  return {
    role: "user",
    text: "question",
    timestamp,
    ...overrides,
  } as StoredChatMessage;
}

function assistantMessage(
  timestamp: number,
  overrides: Partial<StoredChatMessage> = {},
): StoredChatMessage {
  return {
    role: "assistant",
    text: "answer",
    timestamp,
    ...overrides,
  } as StoredChatMessage;
}

async function allUsageRows(harness: SqliteHarness) {
  return harness.all(
    `SELECT conversation_key AS conversationKey,
            mode,
            timestamp,
            local_date AS localDate,
            paper_item_id AS paperItemID,
            library_id AS libraryID,
            model,
            provider,
            runtime,
            prompt_tokens AS promptTokens,
            completion_tokens AS completionTokens,
            total_tokens AS totalTokens,
            counts_as_question AS countsAsQuestion,
            token_source AS tokenSource
     FROM ${USAGE_EVENTS_TABLE}
     ORDER BY timestamp ASC, id ASC`,
  );
}

describe("usage history backfill", function () {
  let harness: SqliteHarness;

  beforeEach(async function () {
    resetUsageStoreForTests();
    resetUsageHistoryBackfillForTests();
    resetConversationWriteFenceForTests();
    resetConversationForkLinksStoreInitForTests();
    resetConversationRegistryStoreInitForTests();
    resetRecentlyDeletedConversationsForTests();
    harness = installSqliteZotero();
    await initChatStore();
    await initUsageStore();
  });

  afterEach(function () {
    harness.db.close();
    resetUsageStoreForTests();
    resetUsageHistoryBackfillForTests();
    resetConversationWriteFenceForTests();
    resetConversationForkLinksStoreInitForTests();
    resetConversationRegistryStoreInitForTests();
    resetRecentlyDeletedConversationsForTests();
    globalScope.Zotero = originalZotero;
  });

  it("writes one estimated row per historical user message, with estimated tokens both ways", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(
      conversationKey,
      userMessage(BASE_TIME, { modelName: "deepseek-chat" }),
    );
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, {
        modelName: "deepseek-chat",
        modelProviderLabel: "DeepSeek",
        contextTokens: 4200,
      }),
    );
    await appendMessage(conversationKey, userMessage(BASE_TIME + DAY));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + DAY + 1000, { contextTokens: 5100 }),
    );

    const result = await backfillUsageHistory();
    assert.strictEqual(result.applied, true);
    assert.strictEqual(result.rows, 2);

    const rows = await allUsageRows(harness);
    assert.lengthOf(rows, 2);
    assert.deepStrictEqual(
      rows.map((row) => Number(row.promptTokens)),
      [4200, 5100],
    );
    for (const row of rows) {
      assert.strictEqual(row.tokenSource, "history-estimate");
      // "answer" is six characters: six quarters of a token, rounded to 2.
      assert.strictEqual(Number(row.completionTokens), 2);
      assert.strictEqual(Number(row.countsAsQuestion), 1);
      assert.strictEqual(row.mode, "library");
      assert.strictEqual(Number(row.conversationKey), conversationKey);
    }
    assert.strictEqual(Number(rows[0]!.totalTokens), 4200 + 2);
    assert.strictEqual(rows[0]!.model, "deepseek-chat");
    assert.strictEqual(rows[0]!.provider, "DeepSeek");
    assert.strictEqual(Number(rows[0]!.timestamp), BASE_TIME);
  });

  it("counts an agent turn with several assistant messages as one question", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(
      conversationKey,
      userMessage(BASE_TIME, {
        runMode: "agent",
      } as Partial<StoredChatMessage>),
    );
    for (const offset of [1000, 2000, 3000]) {
      await appendMessage(
        conversationKey,
        assistantMessage(BASE_TIME + offset, {
          contextTokens: 1000 + offset,
          runMode: "agent",
        } as Partial<StoredChatMessage>),
      );
    }

    await backfillUsageHistory();
    const rows = await allUsageRows(harness);
    assert.lengthOf(rows, 1);
    assert.strictEqual(Number(rows[0]!.promptTokens), 2000);
    assert.strictEqual(rows[0]!.runtime, "agent");
    // One question, but three answers: the output estimate sums all of them.
    assert.strictEqual(Number(rows[0]!.completionTokens), 3 * 2);
    assert.strictEqual(Number(rows[0]!.totalTokens), 2000 + 6);
  });

  it("estimates output tokens from the text of every assistant message in the turn", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, {
        contextTokens: 900,
        text: "x".repeat(400),
      }),
    );
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 2000, { text: "神经科学研究" }),
    );

    await backfillUsageHistory();
    const rows = await allUsageRows(harness);
    assert.lengthOf(rows, 1);
    // 400 non-CJK characters => 100 tokens; 6 Han characters => 6 tokens.
    assert.strictEqual(Number(rows[0]!.completionTokens), 106);
    assert.strictEqual(Number(rows[0]!.promptTokens), 900);
    assert.strictEqual(Number(rows[0]!.totalTokens), 1006);
    assert.strictEqual(rows[0]!.tokenSource, "history-estimate");
  });

  it("counts hidden reasoning as output, not just the visible answer", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, {
        contextTokens: 900,
        text: "x".repeat(400),
        reasoningSummary: "s".repeat(40),
        reasoningDetails: "d".repeat(80),
      }),
    );

    await backfillUsageHistory();
    const rows = await allUsageRows(harness);
    assert.lengthOf(rows, 1);
    // 400/4 answer + 40/4 summary + 80/4 details, summed per generation.
    assert.strictEqual(Number(rows[0]!.completionTokens), 100 + 10 + 20);
    assert.strictEqual(Number(rows[0]!.totalTokens), 900 + 130);
  });

  it("counts a summary the details repeat only once", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    const summary = "w".repeat(40);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, {
        text: "x".repeat(400),
        reasoningSummary: summary,
        reasoningDetails: `${summary} ${"d".repeat(39)}`,
      }),
    );

    await backfillUsageHistory();
    const rows = await allUsageRows(harness);
    // Only the longer field is counted: 100 for the answer plus 80/4 for the
    // details, and nothing for the summary they already contain.
    assert.strictEqual(Number(rows[0]!.completionTokens), 100 + 20);
  });

  it("estimates a turn that produced reasoning but no answer text", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, {
        text: "",
        reasoningDetails: "t".repeat(120),
      }),
    );

    await backfillUsageHistory();
    const rows = await allUsageRows(harness);
    assert.strictEqual(Number(rows[0]!.completionTokens), 30);
  });

  it("leaves input at zero when no assistant message recorded a context size", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(conversationKey, assistantMessage(BASE_TIME + 1000));

    await backfillUsageHistory();
    const rows = await allUsageRows(harness);
    assert.lengthOf(rows, 1);
    // Nothing invents an input estimate, but the answer text is still there.
    assert.strictEqual(Number(rows[0]!.promptTokens), 0);
    assert.strictEqual(Number(rows[0]!.completionTokens), 2);
    assert.strictEqual(Number(rows[0]!.totalTokens), 2);
    assert.strictEqual(rows[0]!.tokenSource, "history-estimate");
  });

  it("attributes a paper conversation exactly as the live path does", async function () {
    const paper = await createPaperConversation(LIBRARY_ID, 4242);
    assert.isOk(paper);
    const conversationKey = paper!.conversationKey;
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, { contextTokens: 300 }),
    );

    await backfillUsageHistory();
    const rows = await loadUsageEventsForConversation(conversationKey);
    assert.lengthOf(rows, 1);
    assert.strictEqual(rows[0]!.mode, "paper");
    assert.strictEqual(rows[0]!.paperItemID, 4242);
    assert.strictEqual(rows[0]!.libraryID, LIBRARY_ID);
    assert.isTrue(
      conversationKey < UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE &&
        conversationKey >= UPSTREAM_PAPER_CONVERSATION_KEY_BASE,
    );
  });

  it("never runs twice: a second pass adds no rows", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, { contextTokens: 900 }),
    );

    const first = await backfillUsageHistory();
    const firstRows = await allUsageRows(harness);
    resetUsageHistoryBackfillForTests();
    const second = await backfillUsageHistory();
    const secondRows = await allUsageRows(harness);

    assert.strictEqual(first.applied, true);
    assert.strictEqual(second.applied, false);
    assert.strictEqual(second.rows, 0);
    assert.deepStrictEqual(secondRows, firstRows);
    const markers = harness.all(
      `SELECT id FROM ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
      [USAGE_HISTORY_BACKFILL_MIGRATION_ID],
    );
    assert.lengthOf(markers, 1);
  });

  it("re-running initUsageStore does not re-add backfilled rows", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, { contextTokens: 900 }),
    );
    await backfillUsageHistory();

    resetUsageStoreForTests();
    await initUsageStore();
    const rows = await allUsageRows(harness);
    assert.lengthOf(rows, 1);
    assert.strictEqual(rows[0]!.tokenSource, "history-estimate");
  });

  it("keeps the healing pass from re-labelling an estimate with zero tokens", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    // An aborted turn that stored no answer text and no context size: the one
    // shape that still produces an all-zero estimate row.
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, { text: "" }),
    );
    await backfillUsageHistory();

    resetUsageStoreForTests();
    await initUsageStore();
    const rows = await allUsageRows(harness);
    assert.lengthOf(rows, 1);
    assert.strictEqual(Number(rows[0]!.totalTokens), 0);
    assert.strictEqual(rows[0]!.tokenSource, "history-estimate");
  });

  it("never describes a turn the live ledger already recorded", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    // Three historical turns; the live ledger already owns the last one.
    for (const index of [0, 1, 2]) {
      await appendMessage(
        conversationKey,
        userMessage(BASE_TIME + index * DAY),
      );
      await appendMessage(
        conversationKey,
        assistantMessage(BASE_TIME + index * DAY + 1000, {
          contextTokens: 100 + index,
        }),
      );
    }
    // A live row is written DURING its turn, so its timestamp sits after that
    // turn's user message: the boundary turn must still be left alone.
    await recordUsageEvent({
      mode: "library",
      conversationKey,
      timestamp: BASE_TIME + 2 * DAY + 500,
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });

    await backfillUsageHistory();
    const rows = await allUsageRows(harness);
    assert.lengthOf(rows, 3);
    const estimates = rows.filter(
      (row) => row.tokenSource === "history-estimate",
    );
    assert.lengthOf(estimates, 2);
    assert.deepStrictEqual(
      estimates.map((row) => Number(row.timestamp)),
      [BASE_TIME, BASE_TIME + DAY],
    );
  });

  it("backfills a conversation that has no live rows at all", async function () {
    const untouched = await createGlobalConversation(LIBRARY_ID);
    const live = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(untouched, userMessage(BASE_TIME + 10 * DAY));
    await appendMessage(
      untouched,
      assistantMessage(BASE_TIME + 10 * DAY + 1000, { contextTokens: 77 }),
    );
    await appendMessage(live, userMessage(BASE_TIME));
    await appendMessage(
      live,
      assistantMessage(BASE_TIME + 1000, { contextTokens: 88 }),
    );
    await recordUsageEvent({
      mode: "library",
      conversationKey: live,
      timestamp: BASE_TIME + 500,
      totalTokens: 5,
    });

    await backfillUsageHistory();
    const estimates = (await allUsageRows(harness)).filter(
      (row) => row.tokenSource === "history-estimate",
    );
    assert.lengthOf(estimates, 1);
    assert.strictEqual(Number(estimates[0]!.conversationKey), untouched);
    assert.strictEqual(Number(estimates[0]!.promptTokens), 77);
  });

  it("excludes WebChat conversations, which the live path never records", async function () {
    const webchat = await createGlobalConversation(LIBRARY_ID, {
      webchatSession: true,
    });
    const webchatPaper = await createPaperConversation(LIBRARY_ID, 99, {
      webchatSession: true,
    });
    // Written straight to the table: appendMessage ADOPTS a webchat-flagged
    // row (it clears the flag), which would quietly turn this into a test of
    // an ordinary conversation.
    for (const key of [webchat, webchatPaper!.conversationKey]) {
      harness.db
        .prepare(
          `INSERT INTO llm_for_zotero_chat_messages
             (conversation_key, role, text, timestamp, context_tokens)
           VALUES (?, 'user', 'question', ?, NULL),
                  (?, 'assistant', 'answer', ?, 1200)`,
        )
        .run(key, BASE_TIME, key, BASE_TIME + 1000);
    }

    await backfillUsageHistory();
    assert.lengthOf(await allUsageRows(harness), 0);
  });

  it("excludes a WebChat turn adopted into an ordinary conversation", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, {
        contextTokens: 1200,
        webchatRunState: "done",
      }),
    );
    await appendMessage(conversationKey, userMessage(BASE_TIME + DAY));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + DAY + 1000, { contextTokens: 50 }),
    );

    await backfillUsageHistory();
    const rows = await allUsageRows(harness);
    assert.lengthOf(rows, 1);
    assert.strictEqual(Number(rows[0]!.promptTokens), 50);
  });

  it("attributes Claude Code history to its own runtime", async function () {
    await initClaudeCodeStore();
    const conversationKey = CLAUDE_PAPER_CONVERSATION_KEY_BASE + 17;
    await upsertClaudeConversationSummary({
      conversationKey,
      libraryID: LIBRARY_ID,
      kind: "paper",
      paperItemID: 808,
    });
    await appendClaudeMessage(conversationKey, userMessage(BASE_TIME));
    await appendClaudeMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, { contextTokens: 1500 }),
    );

    await backfillUsageHistory();
    const rows = await loadUsageEventsForConversation(conversationKey);
    assert.lengthOf(rows, 1);
    assert.strictEqual(rows[0]!.runtime, "claude-code");
    assert.strictEqual(rows[0]!.mode, "paper");
    assert.strictEqual(rows[0]!.paperItemID, 808);
    assert.strictEqual(rows[0]!.promptTokens, 1500);
    assert.strictEqual(rows[0]!.tokenSource, "history-estimate");
  });

  it("lets the deletion cascade remove backfilled rows", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, { contextTokens: 640 }),
    );
    await backfillUsageHistory();
    assert.lengthOf(await loadUsageEventsForConversation(conversationKey), 1);

    await deleteUpstreamConversationLocalRows(conversationKey, "global");
    assert.lengthOf(await loadUsageEventsForConversation(conversationKey), 0);
  });

  it("marks the output-estimate migration too, so a fresh install never repeats it", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, { contextTokens: 900 }),
    );

    const result = await backfillUsageHistory();
    assert.strictEqual(result.applied, true);
    const markers = harness
      .all(`SELECT id FROM ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE}`)
      .map((row) => row.id);
    assert.include(markers, USAGE_HISTORY_BACKFILL_MIGRATION_ID);
    assert.include(markers, USAGE_HISTORY_OUTPUT_BACKFILL_MIGRATION_ID);

    // The upgrade pass therefore has nothing to do and changes nothing.
    const before = await allUsageRows(harness);
    const upgrade = await backfillUsageHistoryOutputTokens();
    assert.strictEqual(upgrade.applied, false);
    assert.strictEqual(upgrade.rowsUpdated, 0);
    assert.deepStrictEqual(await allUsageRows(harness), before);
  });

  it("inserts a large history in batches inside one transaction", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    for (let index = 0; index < 120; index += 1) {
      await appendMessage(
        conversationKey,
        userMessage(BASE_TIME + index * 60_000),
      );
      await appendMessage(
        conversationKey,
        assistantMessage(BASE_TIME + index * 60_000 + 1000, {
          contextTokens: 100 + index,
        }),
      );
    }
    harness.statements.length = 0;

    const result = await backfillUsageHistory();
    assert.strictEqual(result.rows, 120);
    const inserts = harness.statements.filter((statement) =>
      statement.includes(`INSERT INTO ${USAGE_EVENTS_TABLE}`),
    );
    // Batched: far fewer statements than rows, and every one inside the
    // transaction so a failure cannot leave half a year of history behind.
    assert.isAtMost(inserts.length, 12);
    assert.isAtLeast(inserts.length, 1);
    for (const statement of inserts) {
      assert.isTrue(
        statement.startsWith("tx:"),
        `insert ran outside a transaction: ${statement}`,
      );
    }
    assert.lengthOf(await allUsageRows(harness), 120);
  });
});

/**
 * The profile that already ran the v1 backfill.
 *
 * Those rows carry an input estimate and a hard zero for output, because the
 * first pass had no output estimate to write. The upgrade recomputes output
 * for exactly those rows and must leave everything else alone.
 */
describe("usage history output-token upgrade", function () {
  let harness: SqliteHarness;

  beforeEach(async function () {
    resetUsageStoreForTests();
    resetUsageHistoryBackfillForTests();
    resetConversationWriteFenceForTests();
    resetConversationForkLinksStoreInitForTests();
    resetConversationRegistryStoreInitForTests();
    resetRecentlyDeletedConversationsForTests();
    harness = installSqliteZotero();
    await initChatStore();
    await initUsageStore();
  });

  afterEach(function () {
    harness.db.close();
    resetUsageStoreForTests();
    resetUsageHistoryBackfillForTests();
    resetConversationWriteFenceForTests();
    resetConversationForkLinksStoreInitForTests();
    resetConversationRegistryStoreInitForTests();
    resetRecentlyDeletedConversationsForTests();
    globalScope.Zotero = originalZotero;
  });

  /** Put the ledger back into the state v1 left it in. */
  function rewindToV1State(): void {
    harness.db.exec(
      `UPDATE ${USAGE_EVENTS_TABLE}
          SET completion_tokens = 0, total_tokens = prompt_tokens
        WHERE token_source = 'history-estimate'`,
    );
    harness.db
      .prepare(
        `DELETE FROM ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
      )
      .run(USAGE_HISTORY_OUTPUT_BACKFILL_MIGRATION_ID);
    resetUsageHistoryBackfillForTests();
  }

  function liveRows() {
    return harness.all(
      `SELECT * FROM ${USAGE_EVENTS_TABLE}
        WHERE token_source <> 'history-estimate' ORDER BY id ASC`,
    );
  }

  it("recomputes output tokens for rows the first backfill left at zero", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, {
        contextTokens: 900,
        text: "y".repeat(800),
      }),
    );
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 2000, { text: "研究方法" }),
    );
    await appendMessage(conversationKey, userMessage(BASE_TIME + DAY));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + DAY + 1000, {
        contextTokens: 5100,
        text: "z".repeat(40),
      }),
    );
    await backfillUsageHistory();
    rewindToV1State();

    const stale = await allUsageRows(harness);
    assert.deepStrictEqual(
      stale.map((row) => Number(row.completionTokens)),
      [0, 0],
    );

    const result = await backfillUsageHistoryOutputTokens();
    assert.strictEqual(result.applied, true);
    assert.strictEqual(result.rowsUpdated, 2);
    assert.strictEqual(result.conversations, 1);
    assert.strictEqual(result.completionTokens, 204 + 10);

    const rows = await allUsageRows(harness);
    assert.deepStrictEqual(
      rows.map((row) => Number(row.completionTokens)),
      // 800 non-CJK characters => 200 tokens, plus 4 Han characters; and 10.
      [204, 10],
    );
    assert.deepStrictEqual(
      rows.map((row) => Number(row.totalTokens)),
      [900 + 204, 5100 + 10],
    );
    for (const row of rows)
      assert.strictEqual(row.tokenSource, "history-estimate");
  });

  it("never touches a provider or unreported row", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, {
        contextTokens: 900,
        text: "w".repeat(120),
      }),
    );
    await backfillUsageHistory();
    // Live rows, written after the estimated one, exactly as a real profile
    // has them: one the provider measured and one it never reported.
    await recordUsageEvent({
      mode: "library",
      conversationKey,
      timestamp: BASE_TIME + 5 * DAY,
      promptTokens: 11,
      completionTokens: 22,
      totalTokens: 33,
    });
    await recordUsageEvent({
      mode: "library",
      conversationKey,
      timestamp: BASE_TIME + 6 * DAY,
      tokenSource: "unreported",
    });
    rewindToV1State();
    const liveBefore = liveRows();
    assert.lengthOf(liveBefore, 2);

    const result = await backfillUsageHistoryOutputTokens();
    assert.strictEqual(result.applied, true);
    assert.strictEqual(result.rowsUpdated, 1);
    assert.deepStrictEqual(liveRows(), liveBefore);
    const estimates = (await allUsageRows(harness)).filter(
      (row) => row.tokenSource === "history-estimate",
    );
    assert.lengthOf(estimates, 1);
    assert.strictEqual(Number(estimates[0]!.completionTokens), 30);
  });

  it("is a no-op on the second run", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, {
        contextTokens: 900,
        text: "q".repeat(64),
      }),
    );
    await backfillUsageHistory();
    rewindToV1State();

    const first = await backfillUsageHistoryOutputTokens();
    const afterFirst = await allUsageRows(harness);
    resetUsageHistoryBackfillForTests();
    const second = await backfillUsageHistoryOutputTokens();
    const afterSecond = await allUsageRows(harness);

    assert.strictEqual(first.applied, true);
    assert.strictEqual(first.rowsUpdated, 1);
    assert.strictEqual(second.applied, false);
    assert.strictEqual(second.rowsUpdated, 0);
    assert.deepStrictEqual(afterSecond, afterFirst);
    const markers = harness.all(
      `SELECT id FROM ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
      [USAGE_HISTORY_OUTPUT_BACKFILL_MIGRATION_ID],
    );
    assert.lengthOf(markers, 1);
  });

  it("recomputes the same numbers when the marker is missing, without doubling", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, {
        contextTokens: 900,
        text: "q".repeat(64),
      }),
    );
    await backfillUsageHistory();
    rewindToV1State();
    const first = await backfillUsageHistoryOutputTokens();
    const afterFirst = await allUsageRows(harness);

    // Marker gone but the rows already upgraded: the pass must find nothing
    // left to do rather than adding the estimate on top of itself.
    harness.db
      .prepare(
        `DELETE FROM ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
      )
      .run(USAGE_HISTORY_OUTPUT_BACKFILL_MIGRATION_ID);
    resetUsageHistoryBackfillForTests();
    const again = await backfillUsageHistoryOutputTokens();

    assert.strictEqual(first.rowsUpdated, 1);
    assert.strictEqual(again.rowsUpdated, 0);
    assert.deepStrictEqual(await allUsageRows(harness), afterFirst);
  });

  it("replaces an estimate it wrote before, rather than refusing to lower it", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, {
        contextTokens: 900,
        text: "short",
      }),
    );
    await backfillUsageHistory();
    rewindToV1State();
    // A number only an earlier estimate pass could have written. The recompute
    // is a REPLACEMENT of one estimate by a better one from the same stored
    // text, so it is allowed to move down; `token_source` keeps it away from
    // anything a provider measured.
    harness.db.exec(
      `UPDATE ${USAGE_EVENTS_TABLE}
          SET completion_tokens = 99999, total_tokens = prompt_tokens + 99999
        WHERE token_source = 'history-estimate'`,
    );

    const result = await backfillUsageHistoryOutputTokens();
    assert.strictEqual(result.rowsUpdated, 1);
    const rows = await allUsageRows(harness);
    assert.strictEqual(Number(rows[0]!.completionTokens), 1);
    assert.strictEqual(Number(rows[0]!.totalTokens), 900 + 1);
  });

  it("adds the reasoning a text-only estimate missed, without doubling the text", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, {
        contextTokens: 900,
        text: "x".repeat(400),
        reasoningSummary: "s".repeat(40),
        reasoningDetails: "d".repeat(80),
      }),
    );
    await backfillUsageHistory();
    // Exactly what a profile that already ran the text-only upgrade holds.
    harness.db.exec(
      `UPDATE ${USAGE_EVENTS_TABLE}
          SET completion_tokens = 100, total_tokens = prompt_tokens + 100
        WHERE token_source = 'history-estimate'`,
    );
    harness.db
      .prepare(
        `DELETE FROM ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
      )
      .run(USAGE_HISTORY_OUTPUT_BACKFILL_MIGRATION_ID);
    resetUsageHistoryBackfillForTests();

    const result = await backfillUsageHistoryOutputTokens();
    assert.strictEqual(result.rowsUpdated, 1);
    const rows = await allUsageRows(harness);
    assert.strictEqual(Number(rows[0]!.completionTokens), 130);
    assert.strictEqual(Number(rows[0]!.totalTokens), 900 + 130);
  });

  it("recomputes reasoning for rows the first backfill left at zero", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, {
        contextTokens: 900,
        text: "x".repeat(40),
        reasoningDetails: "d".repeat(160),
      }),
    );
    await backfillUsageHistory();
    rewindToV1State();

    const result = await backfillUsageHistoryOutputTokens();
    assert.strictEqual(result.rowsUpdated, 1);
    assert.strictEqual(result.completionTokens, 10 + 40);
    const rows = await allUsageRows(harness);
    assert.strictEqual(Number(rows[0]!.completionTokens), 50);
  });

  it("updates a long history in batches inside one transaction", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    for (let index = 0; index < 120; index += 1) {
      await appendMessage(
        conversationKey,
        userMessage(BASE_TIME + index * 60_000),
      );
      await appendMessage(
        conversationKey,
        assistantMessage(BASE_TIME + index * 60_000 + 1000, {
          contextTokens: 100 + index,
          text: "a".repeat(40),
        }),
      );
    }
    await backfillUsageHistory();
    rewindToV1State();
    harness.statements.length = 0;

    const result = await backfillUsageHistoryOutputTokens();
    assert.strictEqual(result.rowsUpdated, 120);
    const updates = harness.statements.filter((statement) =>
      statement.includes(`UPDATE ${USAGE_EVENTS_TABLE}`),
    );
    assert.isAtMost(updates.length, 12);
    assert.isAtLeast(updates.length, 1);
    for (const statement of updates) {
      assert.isTrue(
        statement.startsWith("tx:"),
        `update ran outside a transaction: ${statement}`,
      );
    }
    const rows = await allUsageRows(harness);
    assert.lengthOf(rows, 120);
    for (const row of rows)
      assert.strictEqual(Number(row.completionTokens), 10);
  });

  it("leaves an estimate alone when its conversation kept no assistant text", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, { contextTokens: 900, text: "" }),
    );
    await backfillUsageHistory();
    rewindToV1State();

    const result = await backfillUsageHistoryOutputTokens();
    assert.strictEqual(result.applied, true);
    assert.strictEqual(result.rowsUpdated, 0);
    const rows = await allUsageRows(harness);
    assert.strictEqual(Number(rows[0]!.completionTokens), 0);
    assert.strictEqual(Number(rows[0]!.totalTokens), 900);
  });
});

/**
 * THE FOUR STATES A PROFILE CAN BE IN WHEN THIS BUILD FIRST STARTS.
 *
 * The estimate has been written by three different passes over its life: the
 * original v1 insert (input only), a text-only output upgrade, and this build,
 * which counts reasoning as output too. Whatever a profile has already run, one
 * startup must leave every history row carrying exactly ONE estimate worth
 * text + reasoning, leave live rows alone, and run nothing twice.
 */
describe("usage history estimate startup states", function () {
  let harness: SqliteHarness;

  /** The superseded text-only upgrade. Only this test still names it. */
  const LEGACY_OUTPUT_MIGRATION_ID = "usage-history-backfill-output-v1";

  beforeEach(async function () {
    resetUsageStoreForTests();
    resetUsageHistoryBackfillForTests();
    resetConversationWriteFenceForTests();
    resetConversationForkLinksStoreInitForTests();
    resetConversationRegistryStoreInitForTests();
    resetRecentlyDeletedConversationsForTests();
    harness = installSqliteZotero();
    await initChatStore();
    await initUsageStore();
  });

  afterEach(function () {
    harness.db.close();
    resetUsageStoreForTests();
    resetUsageHistoryBackfillForTests();
    resetConversationWriteFenceForTests();
    resetConversationForkLinksStoreInitForTests();
    resetConversationRegistryStoreInitForTests();
    resetRecentlyDeletedConversationsForTests();
    globalScope.Zotero = originalZotero;
  });

  /**
   * Two historical turns -- one with reasoning, one without -- plus a live
   * provider row in a conversation of its own, so a pass that reached beyond
   * the estimates would show up.
   */
  async function seedProfile(): Promise<{ history: number; live: number }> {
    const history = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(history, userMessage(BASE_TIME));
    await appendMessage(
      history,
      assistantMessage(BASE_TIME + 1000, {
        contextTokens: 900,
        text: "x".repeat(400),
        reasoningSummary: "s".repeat(40),
        reasoningDetails: "d".repeat(80),
      }),
    );
    await appendMessage(history, userMessage(BASE_TIME + DAY));
    await appendMessage(
      history,
      assistantMessage(BASE_TIME + DAY + 1000, {
        contextTokens: 100,
        text: "y".repeat(40),
      }),
    );
    const live = await createGlobalConversation(LIBRARY_ID);
    await recordUsageEvent({
      mode: "library",
      conversationKey: live,
      timestamp: BASE_TIME + 30 * DAY,
      promptTokens: 11,
      completionTokens: 22,
      totalTokens: 33,
    });
    return { history, live };
  }

  /** The two deferred tasks hooks.ts schedules, in that order, once. */
  async function runStartup(): Promise<void> {
    resetUsageHistoryBackfillForTests();
    await backfillUsageHistory();
    await backfillUsageHistoryOutputTokens();
  }

  function estimateRows() {
    return harness.all(
      `SELECT prompt_tokens AS promptTokens,
              completion_tokens AS completionTokens,
              total_tokens AS totalTokens
         FROM ${USAGE_EVENTS_TABLE}
        WHERE token_source = 'history-estimate'
        ORDER BY timestamp ASC, id ASC`,
    );
  }

  function liveRows() {
    return harness.all(
      `SELECT * FROM ${USAGE_EVENTS_TABLE}
        WHERE token_source <> 'history-estimate' ORDER BY id ASC`,
    );
  }

  function markerCount(id: string): number {
    return harness.all(
      `SELECT id FROM ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
      [id],
    ).length;
  }

  /** The one answer every state has to reach: text + reasoning, once. */
  function assertSettled(live: Record<string, unknown>[]): void {
    assert.deepStrictEqual(
      estimateRows().map((row) => [
        Number(row.promptTokens),
        Number(row.completionTokens),
        Number(row.totalTokens),
      ]),
      [
        [900, 130, 1030],
        [100, 10, 110],
      ],
    );
    assert.deepStrictEqual(liveRows(), live);
    assert.strictEqual(markerCount(USAGE_HISTORY_BACKFILL_MIGRATION_ID), 1);
    assert.strictEqual(
      markerCount(USAGE_HISTORY_OUTPUT_BACKFILL_MIGRATION_ID),
      1,
    );
  }

  /** A second startup must be able to find nothing left to do. */
  async function assertSecondStartupChangesNothing(): Promise<void> {
    const before = estimateRows();
    const live = liveRows();
    await runStartup();
    assert.deepStrictEqual(estimateRows(), before);
    assertSettled(live);
  }

  it("state 1: a profile that never ran any backfill", async function () {
    await seedProfile();
    const live = liveRows();

    await runStartup();

    assertSettled(live);
    await assertSecondStartupChangesNothing();
  });

  it("state 2: a profile that ran only the original input-only backfill", async function () {
    await seedProfile();
    const live = liveRows();
    await runStartup();
    // Rewind to what v1 left behind: an input estimate and a hard zero.
    harness.db.exec(
      `UPDATE ${USAGE_EVENTS_TABLE}
          SET completion_tokens = 0, total_tokens = prompt_tokens
        WHERE token_source = 'history-estimate'`,
    );
    harness.db
      .prepare(
        `DELETE FROM ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
      )
      .run(USAGE_HISTORY_OUTPUT_BACKFILL_MIGRATION_ID);

    await runStartup();

    assertSettled(live);
    await assertSecondStartupChangesNothing();
  });

  it("state 3: a profile that ran the superseded text-only output upgrade", async function () {
    await seedProfile();
    const live = liveRows();
    await runStartup();
    // Text-only estimates: the reasoning-bearing turn lost its hidden tokens.
    harness.db.exec(
      `UPDATE ${USAGE_EVENTS_TABLE}
          SET completion_tokens = 100, total_tokens = prompt_tokens + 100
        WHERE token_source = 'history-estimate' AND prompt_tokens = 900`,
    );
    harness.db
      .prepare(
        `DELETE FROM ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
      )
      .run(USAGE_HISTORY_OUTPUT_BACKFILL_MIGRATION_ID);
    harness.db
      .prepare(
        `INSERT INTO ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE}
           (id, applied_at, description) VALUES (?, ?, NULL)`,
      )
      .run(LEGACY_OUTPUT_MIGRATION_ID, BASE_TIME);

    await runStartup();

    assertSettled(live);
    // The superseded marker stays where it is: it records something that did
    // happen, and this build never reads it.
    assert.strictEqual(markerCount(LEGACY_OUTPUT_MIGRATION_ID), 1);
    await assertSecondStartupChangesNothing();
  });
});

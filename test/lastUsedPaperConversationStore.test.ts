import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { config } from "../package.json";
import {
  deleteLastUsedPaperConversationKey,
  flushLastUsedPaperConversationWritesForTests,
  initLastUsedPaperConversationStore,
  LAST_USED_PAPER_CONVERSATIONS_TABLE,
  readLastUsedPaperConversationKey,
  resetLastUsedPaperConversationStoreForTests,
  writeLastUsedPaperConversationKey,
} from "../src/utils/lastUsedPaperConversationStore";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;
const legacyPrefKey = `${config.prefsPrefix}.lastUsedPaperConversationMap`;

describe("last-used paper conversation store", function () {
  let db: DatabaseSync;
  let prefs: Map<string, unknown>;
  let prefWrites: number;

  beforeEach(function () {
    resetLastUsedPaperConversationStoreForTests();
    db = new DatabaseSync(":memory:");
    prefs = new Map<string, unknown>();
    prefWrites = 0;
    const bindable = (params: unknown[] | undefined) =>
      (Array.isArray(params) ? params : []).map((value) =>
        value === undefined ? null : value,
      ) as never[];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => {
          prefWrites += 1;
          prefs.set(key, value);
        },
        clear: (key: string) => {
          prefs.delete(key);
        },
      },
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          const statement = db.prepare(sql);
          const normalizedSql = sql.trimStart().toUpperCase();
          if (
            normalizedSql.startsWith("SELECT") ||
            normalizedSql.startsWith("PRAGMA") ||
            normalizedSql.startsWith("WITH")
          ) {
            return statement.all(...bindable(params));
          }
          statement.run(...bindable(params));
          return [];
        },
        executeTransaction: async (task: () => Promise<unknown>) => task(),
      },
    };
  });

  afterEach(async function () {
    await flushLastUsedPaperConversationWritesForTests();
    resetLastUsedPaperConversationStoreForTests();
    db.close();
    globalScope.Zotero = originalZotero;
  });

  it("migrates the legacy preference into SQLite and clears it", async function () {
    prefs.set(
      legacyPrefKey,
      JSON.stringify({
        "1:10": 101,
        "2:20": 1_500_000_020,
        invalid: 202,
        "3:30": 2_000_000_030,
      }),
    );

    await initLastUsedPaperConversationStore();

    assert.equal(readLastUsedPaperConversationKey(1, 10), 101);
    assert.equal(readLastUsedPaperConversationKey(2, 20), 1_500_000_020);
    assert.isNull(readLastUsedPaperConversationKey(3, 30));
    assert.isFalse(prefs.has(legacyPrefKey));
    assert.equal(prefWrites, 0);
    const rows = db
      .prepare(
        `SELECT library_id, paper_item_id, conversation_key
         FROM ${LAST_USED_PAPER_CONVERSATIONS_TABLE}
         ORDER BY library_id`,
      )
      .all();
    assert.deepEqual(rows, [
      { library_id: 1, paper_item_id: 10, conversation_key: 101 },
      {
        library_id: 2,
        paper_item_id: 20,
        conversation_key: 1_500_000_020,
      },
    ]);
  });

  it("keeps an existing database selection when migration is retried", async function () {
    db.exec(
      `CREATE TABLE ${LAST_USED_PAPER_CONVERSATIONS_TABLE} (
         library_id INTEGER NOT NULL,
         paper_item_id INTEGER NOT NULL,
         conversation_key INTEGER NOT NULL,
         PRIMARY KEY (library_id, paper_item_id)
       );
       INSERT INTO ${LAST_USED_PAPER_CONVERSATIONS_TABLE}
         (library_id, paper_item_id, conversation_key)
       VALUES (1, 10, 202);`,
    );
    prefs.set(legacyPrefKey, JSON.stringify({ "1:10": 101 }));

    await initLastUsedPaperConversationStore();

    assert.equal(readLastUsedPaperConversationKey(1, 10), 202);
    assert.isFalse(prefs.has(legacyPrefKey));
  });

  it("persists ordered updates without writing the preference", async function () {
    await initLastUsedPaperConversationStore();

    writeLastUsedPaperConversationKey(7, 42, 1101);
    deleteLastUsedPaperConversationKey(7, 42);
    writeLastUsedPaperConversationKey(7, 42, 2201);
    await flushLastUsedPaperConversationWritesForTests();

    assert.equal(readLastUsedPaperConversationKey(7, 42), 2201);
    assert.equal(prefWrites, 0);
    assert.isFalse(prefs.has(legacyPrefKey));
    assert.deepEqual(
      db
        .prepare(
          `SELECT library_id, paper_item_id, conversation_key
           FROM ${LAST_USED_PAPER_CONVERSATIONS_TABLE}`,
        )
        .all(),
      [{ library_id: 7, paper_item_id: 42, conversation_key: 2201 }],
    );

    resetLastUsedPaperConversationStoreForTests();
    await initLastUsedPaperConversationStore();
    assert.equal(readLastUsedPaperConversationKey(7, 42), 2201);
  });
});

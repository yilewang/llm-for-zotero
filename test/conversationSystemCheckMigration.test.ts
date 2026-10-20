import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  CONVERSATION_SYSTEM_SQL_VALUES,
  isSystemCheckOutdated,
  rebuildTableForCurrentSystemCheck,
} from "../src/shared/conversationSystems";

function createDb(database: DatabaseSync) {
  const bindable = (params: unknown[] | undefined) =>
    (Array.isArray(params) ? params : []).map((value) =>
      value === undefined ? null : value,
    ) as never[];
  return {
    queryAsync: async (sql: string, params?: unknown[]) => {
      const statement = database.prepare(sql);
      const normalized = sql.trimStart().toUpperCase();
      if (normalized.startsWith("SELECT") || normalized.startsWith("PRAGMA")) {
        return statement.all(...bindable(params));
      }
      statement.run(...bindable(params));
      return [];
    },
  };
}

describe("conversation system CHECK migration", function () {
  it("treats a CHECK that lists every current system as current", function () {
    assert.isFalse(
      isSystemCheckOutdated(
        `CREATE TABLE t (system TEXT NOT NULL CHECK(system IN (${CONVERSATION_SYSTEM_SQL_VALUES})))`,
      ),
    );
    assert.isTrue(
      isSystemCheckOutdated(
        "CREATE TABLE t (system TEXT NOT NULL CHECK(system IN ('upstream', 'claude_code', 'codex')))",
      ),
    );
    assert.isFalse(isSystemCheckOutdated("CREATE TABLE t (system TEXT)"));
  });

  it("widens an old CHECK, keeps rows, and leaves triggers that read the table working", async function () {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE ledger (
        conversation_key INTEGER PRIMARY KEY,
        system TEXT NOT NULL CHECK(system IN ('upstream', 'claude_code', 'codex')),
        retired_at INTEGER
      );
      CREATE INDEX ledger_system ON ledger (system);
      INSERT INTO ledger VALUES (1, 'codex', NULL), (2, 'upstream', 5);
      CREATE TABLE messages (conversation_key INTEGER NOT NULL);
      CREATE TRIGGER messages_fence BEFORE INSERT ON messages
      WHEN EXISTS (
        SELECT 1 FROM ledger l
        WHERE l.conversation_key = NEW.conversation_key
          AND l.retired_at IS NOT NULL
      )
      BEGIN SELECT RAISE(ABORT, 'retired'); END;
    `);
    const db = createDb(database);
    const createLedger = async () => {
      await db.queryAsync(
        `CREATE TABLE IF NOT EXISTS ledger (
          conversation_key INTEGER PRIMARY KEY,
          system TEXT NOT NULL CHECK(system IN (${CONVERSATION_SYSTEM_SQL_VALUES})),
          retired_at INTEGER
        )`,
      );
    };

    assert.isTrue(
      await rebuildTableForCurrentSystemCheck(db, "ledger", createLedger),
    );
    assert.isFalse(
      await rebuildTableForCurrentSystemCheck(db, "ledger", createLedger),
    );

    const rows = database
      .prepare("SELECT conversation_key, system FROM ledger ORDER BY 1")
      .all();
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        { conversation_key: 1, system: "codex" },
        { conversation_key: 2, system: "upstream" },
      ],
    );
    database
      .prepare("INSERT INTO ledger VALUES (3, 'antigravity', NULL)")
      .run();
    assert.throws(
      () =>
        database.prepare("INSERT INTO ledger VALUES (4, 'other', NULL)").run(),
      /CHECK/,
    );

    database.prepare("INSERT INTO messages VALUES (1)").run();
    assert.throws(
      () => database.prepare("INSERT INTO messages VALUES (2)").run(),
      /retired/,
    );
    const leftovers = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE name LIKE '%stale_system_check%'",
      )
      .all();
    assert.lengthOf(leftovers, 0);
  });
});

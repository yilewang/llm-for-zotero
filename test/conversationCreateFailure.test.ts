import { assert } from "chai";
import * as upstream from "../src/utils/chatStore";
import * as claude from "../src/claudeCode/store";
import * as codex from "../src/codexAppServer/store";
import { isConversationKeyRetiredInMemory } from "../src/shared/conversationKeyLedger";
import {
  installSqliteZotero,
  resetConversationStoreProcessStateForTests,
  type SqliteHarness,
} from "./helpers/conversationStoreDb";

/**
 * A conversation create allocates its key and writes its catalog row in one
 * transaction.  When the create fails, the allocation rolls back with it:
 * the key was never issued, nothing refers to it, and the next create may
 * issue the same number to a new conversation with its own identity.  So a
 * failed create needs no separate retirement of its key.
 */
describe("a failed conversation create leaves no allocated key", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;
  let harness: SqliteHarness;

  beforeEach(function () {
    resetConversationStoreProcessStateForTests();
    harness = installSqliteZotero({
      baseZotero: originalZotero,
      realTransactions: true,
    });
  });

  afterEach(function () {
    harness.db.close();
    globalScope.Zotero = originalZotero;
    resetConversationStoreProcessStateForTests();
  });

  /** Every row that names the key, in every table that has the column. */
  function rowsNaming(key: number): Record<string, number> {
    const found: Record<string, number> = {};
    const tables = harness
      .all(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .map((row) => String(row.name));
    for (const table of tables) {
      const columns = harness
        .all(`PRAGMA table_info(${table})`)
        .map((row) => String(row.name));
      for (const column of [
        "conversation_key",
        "legacy_conversation_key",
        "owner_id",
      ]) {
        if (!columns.includes(column)) continue;
        const [row] = harness.all(
          `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`,
          [key],
        );
        if (Number(row.n) > 0) found[`${table}.${column}`] = Number(row.n);
      }
    }
    return found;
  }

  function counters(): Array<Record<string, unknown>> {
    return harness.all(
      `SELECT * FROM llm_for_zotero_conversation_key_counters ORDER BY 1`,
    );
  }

  /** Make the next INSERT into `table` fail, as a write error would. */
  function failNextInsertInto(table: string): void {
    const db = globalScope.Zotero!.DB as {
      queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
    };
    const real = db.queryAsync;
    db.queryAsync = async (sql, params) => {
      if (sql.trimStart().startsWith(`INSERT INTO ${table}`)) {
        db.queryAsync = real;
        throw new Error("simulated write failure");
      }
      return real(sql, params);
    };
  }

  const stores = [
    {
      name: "upstream",
      init: () => upstream.initChatStore(),
      catalog: "llm_for_zotero_global_conversations",
      create: async () => upstream.createGlobalConversation(1),
    },
    {
      name: "claude_code",
      init: () => claude.initClaudeCodeStore(),
      catalog: "llm_for_zotero_claude_conversations",
      create: async () =>
        (await claude.createClaudeGlobalConversation(1))?.conversationKey ?? 0,
    },
    {
      name: "codex",
      init: () => codex.initCodexAppServerStore(),
      catalog: "llm_for_zotero_codex_conversations",
      create: async () =>
        (await codex.createCodexGlobalConversation(1))?.conversationKey ?? 0,
    },
  ];

  for (const store of stores) {
    it(`${store.name}: the key rolls back and a later create owns it alone`, async function () {
      await store.init();
      const first = await store.create();
      const countersBefore = counters();
      failNextInsertInto(store.catalog);
      let failure = "";
      await store.create().catch((error) => {
        failure = String(error);
      });
      assert.include(failure, "simulated write failure");
      assert.deepEqual(counters(), countersBefore, "no key was issued");

      const next = await store.create();
      assert.isAbove(next, first);
      assert.isFalse(isConversationKeyRetiredInMemory(next));
      // The reissued number belongs to the new conversation only: one
      // ledger entry, one registry scope, one catalog row, and the same
      // instance in all three.
      const ledger = harness.all(
        `SELECT instance_id AS instanceID, retired_at AS retiredAt
         FROM llm_for_zotero_conversation_key_ledger WHERE conversation_key = ?`,
        [next],
      );
      const registry = harness.all(
        `SELECT instance_id AS instanceID
         FROM llm_for_zotero_conversation_registry WHERE legacy_conversation_key = ?`,
        [next],
      );
      const catalog = harness.all(
        `SELECT conversation_instance_id AS instanceID
         FROM ${store.catalog} WHERE conversation_key = ?`,
        [next],
      );
      assert.lengthOf(ledger, 1);
      assert.isNull(ledger[0].retiredAt);
      assert.lengthOf(registry, 1);
      assert.lengthOf(catalog, 1);
      assert.equal(registry[0].instanceID, ledger[0].instanceID);
      assert.equal(catalog[0].instanceID, ledger[0].instanceID);
      const naming = rowsNaming(next);
      for (const table of Object.keys(naming)) {
        assert.equal(naming[table], 1, `${table} holds one row for the key`);
      }
    });
  }
});

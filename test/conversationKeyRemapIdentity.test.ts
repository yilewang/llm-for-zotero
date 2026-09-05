import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { buildConversationID } from "../src/shared/conversationRegistry";
import {
  rekeyConversationCatalogKeyInTransaction,
  rekeyConversationOwnedRowsInTransaction,
} from "../src/shared/conversationSchemaMigrations";
import {
  buildScopedConversationKey,
  rekeyScopedConversationKey,
} from "../src/shared/conversationScopedKey";

const FORK_LINKS_TABLE = "llm_for_zotero_conversation_fork_links";
const CLAUDE_CATALOG_TABLE = "llm_for_zotero_claude_conversations";
const CODEX_CATALOG_TABLE = "llm_for_zotero_codex_conversations";

const PROFILE_SIGNATURE = "profile-1f2";
const LIBRARY_ID = 1;
// Chosen so the paper item id repeats the legacy conversation key's digits —
// that overlap is the whole point of these tests.
const PAPER_ITEM_ID = 12345;
const SCOPE_TYPE = "paper";
const SCOPE_ID = `${PROFILE_SIGNATURE}:${LIBRARY_ID}:${PAPER_ITEM_ID}`;

// 12 is a digit prefix of 123, 124 and 1234.  Every assertion in this file
// depends on that overlap, so the fixtures below are deliberately chosen to
// collide; `guards` re-checks the overlap so a future fixture edit cannot make
// the suite pass by no longer exercising the bug.
const LEGACY_KEY = 12;
const TARGET_KEY = 4001;

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

type SqliteHarness = {
  db: DatabaseSync;
  all: (sql: string, params?: unknown[]) => Record<string, unknown>[];
  run: (sql: string, params?: unknown[]) => void;
};

function installSqliteZotero(): SqliteHarness {
  const db = new DatabaseSync(":memory:");
  const bindable = (params: unknown[] | undefined) =>
    (Array.isArray(params) ? params : params === undefined ? [] : [params]).map(
      (value) => (value === undefined ? null : value),
    ) as never[];
  // Zotero 7's queryAsync wraps rows in a proxy that THROWS when code reads a
  // column the SELECT did not include (node:sqlite returns undefined). Mimic
  // that here or the suite silently passes on exactly the row-access bugs
  // that break the real plugin.
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
  globalScope.Zotero = {
    ...(originalZotero || {}),
    Libraries: { userLibraryID: LIBRARY_ID },
    DB: {
      queryAsync,
      executeTransaction: async (task: () => Promise<unknown>) => task(),
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
  };
}

function conversationIDFor(conversationKey: number): string {
  return buildConversationID({
    conversationKey,
    system: "claude_code",
    kind: "paper",
    libraryID: LIBRARY_ID,
    paperItemID: PAPER_ITEM_ID,
    profileSignature: PROFILE_SIGNATURE,
  });
}

// Copied verbatim from initConversationForkLinksStore
// (src/shared/conversationForkLinks.ts).  Inlined rather than calling the store
// initializer because that helper memoizes its init promise at module scope,
// which would leak across the in-memory databases this suite creates.
function createForkLinksTable(harness: SqliteHarness): void {
  harness.run(
    `CREATE TABLE IF NOT EXISTS ${FORK_LINKS_TABLE} (
      target_conversation_key INTEGER PRIMARY KEY,
      target_instance_id TEXT,
      target_conversation_id TEXT,
      target_system TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      source_conversation_key INTEGER NOT NULL,
      source_instance_id TEXT,
      source_conversation_id TEXT,
      source_system TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_library_id INTEGER NOT NULL,
      source_paper_item_id INTEGER,
      source_assistant_timestamp INTEGER NOT NULL,
      target_anchor_assistant_timestamp INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  );
}

function insertForkLink(
  harness: SqliteHarness,
  targetKey: number,
  sourceKey: number,
): void {
  harness.run(
    `INSERT INTO ${FORK_LINKS_TABLE}
      (target_conversation_key, target_conversation_id, target_system, target_kind,
       source_conversation_key, source_conversation_id, source_system, source_kind,
       source_library_id, source_paper_item_id,
       source_assistant_timestamp, target_anchor_assistant_timestamp, created_at)
     VALUES (?, ?, 'claude_code', 'paper', ?, ?, 'claude_code', 'paper', ?, ?, 1, 1, 1)`,
    [
      targetKey,
      conversationIDFor(targetKey),
      sourceKey,
      conversationIDFor(sourceKey),
      LIBRARY_ID,
      PAPER_ITEM_ID,
    ],
  );
}

// The columns `rekeyConversationCatalogKeyInTransaction` reads and writes,
// with the same types and the same `INTEGER PRIMARY KEY` on conversation_key
// as both runtime catalogs declare. scope_type/scope_id are carried so the
// tests can prove the authoritative scope columns are never touched.
function createCatalogTable(harness: SqliteHarness, table: string): void {
  harness.run(
    `CREATE TABLE IF NOT EXISTS ${table} (
      conversation_key INTEGER PRIMARY KEY,
      library_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      paper_item_id INTEGER,
      scoped_conversation_key TEXT,
      scope_type TEXT,
      scope_id TEXT
    )`,
  );
}

function insertCatalogRow(
  harness: SqliteHarness,
  table: string,
  conversationKey: number,
  scopedConversationKey: string | null,
): void {
  harness.run(
    `INSERT INTO ${table}
      (conversation_key, library_id, kind, paper_item_id,
       scoped_conversation_key, scope_type, scope_id)
     VALUES (?, ?, 'paper', ?, ?, ?, ?)`,
    [
      conversationKey,
      LIBRARY_ID,
      PAPER_ITEM_ID,
      scopedConversationKey,
      SCOPE_TYPE,
      SCOPE_ID,
    ],
  );
}

function catalogRow(
  harness: SqliteHarness,
  table: string,
  conversationKey: number,
) {
  return harness.all(
    `SELECT conversation_key AS conversationKey,
            scoped_conversation_key AS scopedConversationKey,
            scope_type AS scopeType,
            scope_id AS scopeId
     FROM ${table}
     WHERE conversation_key = ?`,
    [conversationKey],
  )[0];
}

function forkLinkRow(harness: SqliteHarness, targetKey: number) {
  return harness.all(
    `SELECT target_conversation_key AS targetKey,
            target_conversation_id AS targetID,
            source_conversation_key AS sourceKey,
            source_conversation_id AS sourceID
     FROM ${FORK_LINKS_TABLE}
     WHERE target_conversation_key = ?`,
    [targetKey],
  )[0];
}

describe("conversation key remap identity", function () {
  let harness: SqliteHarness;

  beforeEach(function () {
    harness = installSqliteZotero();
  });

  afterEach(function () {
    harness.db.close();
    globalScope.Zotero = originalZotero;
  });

  describe("fixture guards", function () {
    it("uses fixtures that actually encode the digit-prefix collision", function () {
      // If these stop holding, the assertions below no longer reproduce the
      // bug and would pass against the broken implementation.
      assert.isTrue(String(123).startsWith(String(LEGACY_KEY)));
      assert.isTrue(String(1234).startsWith(String(LEGACY_KEY)));
      assert.include(conversationIDFor(123), `legacy-${LEGACY_KEY}`);
      assert.include(conversationIDFor(1234), `legacy-${LEGACY_KEY}`);
      assert.isTrue(conversationIDFor(LEGACY_KEY).endsWith(`:legacy-12`));
    });

    it("uses a scope id that repeats the legacy key's digits", function () {
      // Without this overlap a global REPLACE would be indistinguishable from
      // a correct field-scoped rewrite.
      assert.include(SCOPE_ID, String(LEGACY_KEY));
      const scoped = buildScopedConversationKey(LEGACY_KEY, {
        scopeType: SCOPE_TYPE,
        scopeId: SCOPE_ID,
      });
      assert.equal(scoped, "12::paper:profile-1f2:1:12345");
      assert.isAbove(
        scoped.split(String(LEGACY_KEY)).length - 1,
        1,
        "fixture must contain the legacy key more than once",
      );
    });
  });

  describe("rekeyScopedConversationKey", function () {
    it("rewrites the bare key when there is no scope binding", function () {
      assert.equal(
        rekeyScopedConversationKey("12", LEGACY_KEY, TARGET_KEY),
        "4001",
      );
    });

    it("rewrites only the leading key token and preserves the scope tail", function () {
      // The old SQL REPLACE produced `4001::paper:profile-1f2:1:4001345`,
      // silently renumbering the paper item id.
      assert.equal(
        rekeyScopedConversationKey(
          "12::paper:profile-1f2:1:12345",
          LEGACY_KEY,
          TARGET_KEY,
        ),
        "4001::paper:profile-1f2:1:12345",
      );
    });

    it("survives a key whose digits saturate the scope id", function () {
      assert.equal(
        rekeyScopedConversationKey(
          "1::open:profile-111:1",
          1,
          3_000_000_000_000_001,
        ),
        "3000000000000001::open:profile-111:1",
      );
    });

    it("returns null for missing or blank values", function () {
      assert.isNull(rekeyScopedConversationKey(null, LEGACY_KEY, TARGET_KEY));
      assert.isNull(
        rekeyScopedConversationKey(undefined, LEGACY_KEY, TARGET_KEY),
      );
      assert.isNull(rekeyScopedConversationKey("   ", LEGACY_KEY, TARGET_KEY));
    });

    it("leaves a scoped key that does not lead with the legacy key unchanged", function () {
      // Neither a prefix match nor ours to rewrite. Overwriting it would swap
      // one wrong value for another.
      assert.equal(
        rekeyScopedConversationKey(
          "123::paper:profile-1f2:1:12345",
          LEGACY_KEY,
          TARGET_KEY,
        ),
        "123::paper:profile-1f2:1:12345",
      );
    });

    it("round-trips against the builder the session-hint check compares with", function () {
      // resolveClaudeProviderSessionHint rebuilds the scoped key and declines
      // the provider session on any mismatch, so these two must agree exactly.
      const scope = { scopeType: SCOPE_TYPE, scopeId: SCOPE_ID };
      assert.equal(
        rekeyScopedConversationKey(
          buildScopedConversationKey(LEGACY_KEY, scope),
          LEGACY_KEY,
          TARGET_KEY,
        ),
        buildScopedConversationKey(TARGET_KEY, scope),
      );
    });
  });

  describe("rekeyConversationCatalogKeyInTransaction", function () {
    for (const table of [CLAUDE_CATALOG_TABLE, CODEX_CATALOG_TABLE]) {
      describe(table, function () {
        beforeEach(function () {
          createCatalogTable(harness, table);
          insertCatalogRow(
            harness,
            table,
            LEGACY_KEY,
            buildScopedConversationKey(LEGACY_KEY, {
              scopeType: SCOPE_TYPE,
              scopeId: SCOPE_ID,
            }),
          );
          insertCatalogRow(
            harness,
            table,
            123,
            buildScopedConversationKey(123, {
              scopeType: SCOPE_TYPE,
              scopeId: SCOPE_ID,
            }),
          );
        });

        it("moves the numeric key and rewrites only the scoped key's leading token", async function () {
          await rekeyConversationCatalogKeyInTransaction({
            table,
            legacyKey: LEGACY_KEY,
            targetKey: TARGET_KEY,
          });

          const row = catalogRow(harness, table, TARGET_KEY);
          assert.equal(row.conversationKey, TARGET_KEY);
          assert.equal(
            row.scopedConversationKey,
            "4001::paper:profile-1f2:1:12345",
          );
          assert.isUndefined(catalogRow(harness, table, LEGACY_KEY));
        });

        it("never touches the authoritative scope columns", async function () {
          await rekeyConversationCatalogKeyInTransaction({
            table,
            legacyKey: LEGACY_KEY,
            targetKey: TARGET_KEY,
          });

          const row = catalogRow(harness, table, TARGET_KEY);
          assert.equal(row.scopeType, SCOPE_TYPE);
          assert.equal(row.scopeId, SCOPE_ID);
          assert.equal(
            row.scopedConversationKey,
            buildScopedConversationKey(TARGET_KEY, {
              scopeType: String(row.scopeType),
              scopeId: String(row.scopeId),
            }),
            "scoped key must stay derivable from the scope columns",
          );
        });

        it("leaves a row whose key is merely digit-prefixed by the legacy key alone", async function () {
          await rekeyConversationCatalogKeyInTransaction({
            table,
            legacyKey: LEGACY_KEY,
            targetKey: TARGET_KEY,
          });

          const row = catalogRow(harness, table, 123);
          assert.equal(row.conversationKey, 123);
          assert.equal(
            row.scopedConversationKey,
            "123::paper:profile-1f2:1:12345",
          );
        });

        it("keeps an absent scope binding absent", async function () {
          insertCatalogRow(harness, table, 55, null);

          await rekeyConversationCatalogKeyInTransaction({
            table,
            legacyKey: 55,
            targetKey: 66,
          });

          const row = catalogRow(harness, table, 66);
          assert.equal(row.conversationKey, 66);
          assert.isNull(row.scopedConversationKey);
        });

        it("does nothing when the key is unchanged or invalid", async function () {
          const before = catalogRow(harness, table, LEGACY_KEY);

          await rekeyConversationCatalogKeyInTransaction({
            table,
            legacyKey: LEGACY_KEY,
            targetKey: LEGACY_KEY,
          });
          await rekeyConversationCatalogKeyInTransaction({
            table,
            legacyKey: LEGACY_KEY,
            targetKey: 0,
          });

          assert.deepEqual(
            { ...catalogRow(harness, table, LEGACY_KEY) },
            { ...before },
          );
        });
      });
    }
  });

  describe("rekeyConversationOwnedRowsInTransaction — fork link identities", function () {
    beforeEach(function () {
      createForkLinksTable(harness);
      // Row A: the remapped conversation is the fork target.
      insertForkLink(harness, LEGACY_KEY, 500);
      // Row B: the remapped conversation is the fork source, and the target
      // key (123) is digit-prefixed by it.
      insertForkLink(harness, 123, LEGACY_KEY);
      // Row C: neither key is being remapped, but both IDs contain the
      // remapped key as a digit prefix.
      insertForkLink(harness, 124, 1234);
    });

    it("moves the remapped conversation's own identity to the new key", async function () {
      await rekeyConversationOwnedRowsInTransaction(LEGACY_KEY, TARGET_KEY);

      const rowA = forkLinkRow(harness, TARGET_KEY);
      assert.equal(rowA.targetKey, TARGET_KEY);
      assert.equal(rowA.targetID, conversationIDFor(TARGET_KEY));
      assert.equal(rowA.sourceKey, 500);
      assert.equal(rowA.sourceID, conversationIDFor(500));

      const rowB = forkLinkRow(harness, 123);
      assert.equal(rowB.sourceKey, TARGET_KEY);
      assert.equal(rowB.sourceID, conversationIDFor(TARGET_KEY));
    });

    it("leaves identities whose key is merely digit-prefixed by the remapped key untouched", async function () {
      await rekeyConversationOwnedRowsInTransaction(LEGACY_KEY, TARGET_KEY);

      // Old behaviour rewrote these to `legacy-40013` / `legacy-400134`, so
      // the string claimed one conversation while the numeric column still
      // named another.
      const rowB = forkLinkRow(harness, 123);
      assert.equal(rowB.targetKey, 123);
      assert.equal(rowB.targetID, conversationIDFor(123));

      const rowC = forkLinkRow(harness, 124);
      assert.equal(rowC.targetKey, 124);
      assert.equal(rowC.targetID, conversationIDFor(124));
      assert.equal(rowC.sourceKey, 1234);
      assert.equal(rowC.sourceID, conversationIDFor(1234));
    });

    it("keeps every numeric key and its identity string in agreement", async function () {
      await rekeyConversationOwnedRowsInTransaction(LEGACY_KEY, TARGET_KEY);

      const rows = harness.all(
        `SELECT target_conversation_key AS targetKey,
                target_conversation_id AS targetID,
                source_conversation_key AS sourceKey,
                source_conversation_id AS sourceID
         FROM ${FORK_LINKS_TABLE}`,
      );
      assert.lengthOf(rows, 3);
      for (const row of rows) {
        assert.equal(
          row.targetID,
          conversationIDFor(Number(row.targetKey)),
          `target identity disagrees with key ${row.targetKey}`,
        );
        assert.equal(
          row.sourceID,
          conversationIDFor(Number(row.sourceKey)),
          `source identity disagrees with key ${row.sourceKey}`,
        );
      }
    });
  });
});

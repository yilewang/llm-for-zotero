import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  allocateConversationKeyInTransaction,
  assertConversationKeyLiveInTransaction,
  ensureConversationKeyLedgerEntryInTransaction,
  getConversationKeyLedgerEntry,
  initConversationKeyLedgerStore,
  isConversationKeyRetiredInMemory,
  installConversationKeyLedgerCatalogTriggers,
  installConversationKeyLedgerAgentTriggers,
  installConversationKeyLedgerMessageTriggers,
  retireConversationKeyInTransaction,
  seedConversationKeyLedgerFromTombstones,
  reserveOrphanConversationMessageKeys,
  seedConversationKeyLedgerFromCatalogs,
  nextUnissuedConversationKeyInRange,
  getConversationKeyQuarantineEntries,
  logConversationKeyQuarantineSummary,
  retireOrphanedConversationLedgerEntries,
  refreshConversationKeyLedgerStore,
  unretireConversationKeyInTransaction,
  updateConversationKeyLedgerConversationIDInTransaction,
  ConversationRetiredError,
} from "../src/shared/conversationKeyLedger";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

describe("permanent conversation key ledger", function () {
  let db: DatabaseSync;

  beforeEach(function () {
    db = new DatabaseSync(":memory:");
    const bindable = (params: unknown[] | undefined) =>
      (Array.isArray(params) ? params : []).map((value) =>
        value === undefined ? null : value,
      ) as never[];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Profile: { dir: "/tmp/permanent-key-ledger-test" },
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

  afterEach(function () {
    db.close();
    globalScope.Zotero = originalZotero;
  });

  it("coalesces and caches initialization for the same database", async function () {
    const zotero = globalScope.Zotero as any;
    const queryAsync = zotero.DB.queryAsync;
    let ledgerTableCreates = 0;
    zotero.DB.queryAsync = async (sql: string, params?: unknown[]) => {
      if (
        sql.includes(
          "CREATE TABLE IF NOT EXISTS llm_for_zotero_conversation_key_ledger",
        )
      ) {
        ledgerTableCreates += 1;
      }
      return queryAsync(sql, params);
    };

    await Promise.all([
      initConversationKeyLedgerStore(),
      initConversationKeyLedgerStore(),
    ]);
    await initConversationKeyLedgerStore();

    assert.equal(
      ledgerTableCreates,
      1,
      "ordinary callers must share and reuse one initialization",
    );

    await zotero.DB.queryAsync(
      `INSERT INTO llm_for_zotero_conversation_key_ledger
        (conversation_key, instance_id, conversation_id, system, kind,
         profile_signature, library_id, paper_item_id, issued_at, retired_at,
         retirement_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        9900,
        "instance-refresh",
        "conversation-refresh",
        "upstream",
        "global",
        "profile-test",
        1,
        null,
        1,
        2,
        "test-refresh",
      ],
    );
    assert.isFalse(isConversationKeyRetiredInMemory(9900));

    await refreshConversationKeyLedgerStore();

    assert.isTrue(isConversationKeyRetiredInMemory(9900));
    assert.equal(
      ledgerTableCreates,
      2,
      "an explicit refresh must rebuild durable retirement state once",
    );
  });

  it("retires a key permanently and allocates the next high-water key", async function () {
    await initConversationKeyLedgerStore();
    const first = (globalScope.Zotero as any).DB;
    const allocated = await first.executeTransaction(() =>
      allocateConversationKeyInTransaction({
        range: {
          system: "upstream",
          kind: "global",
          start: 1000,
          endExclusive: 1100,
        },
        libraryID: 1,
      }),
    );
    await first.executeTransaction(() =>
      updateConversationKeyLedgerConversationIDInTransaction({
        conversationKey: allocated.conversationKey,
        instanceID: allocated.instanceID,
        conversationID: "conversation-a",
      }),
    );
    await first.executeTransaction(() =>
      retireConversationKeyInTransaction({
        conversationKey: allocated.conversationKey,
        instanceID: allocated.instanceID,
      }),
    );

    try {
      await first.executeTransaction(() =>
        assertConversationKeyLiveInTransaction({
          conversationKey: allocated.conversationKey,
          instanceID: allocated.instanceID,
        }),
      );
      assert.fail("expected ConversationRetiredError");
    } catch (error) {
      assert.instanceOf(error, ConversationRetiredError);
    }

    const next = await first.executeTransaction(() =>
      allocateConversationKeyInTransaction({
        range: {
          system: "upstream",
          kind: "global",
          start: 1000,
          endExclusive: 1100,
        },
        libraryID: 1,
      }),
    );
    assert.equal(allocated.conversationKey, 1000);
    assert.equal(next.conversationKey, 1001);
  });

  it("rejects raw catalog and message writes for a retired identity", async function () {
    await initConversationKeyLedgerStore();
    const zotero = globalScope.Zotero as any;
    await zotero.DB.queryAsync(
      `CREATE TABLE test_catalog (
        conversation_key INTEGER PRIMARY KEY,
        conversation_instance_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL
      )`,
    );
    await zotero.DB.queryAsync(
      `CREATE TABLE test_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_key INTEGER NOT NULL,
        conversation_instance_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        text TEXT NOT NULL
      )`,
    );
    await installConversationKeyLedgerCatalogTriggers(["test_catalog"]);
    await installConversationKeyLedgerMessageTriggers({
      messageTable: "test_messages",
    });
    const instanceID = "instance-a";
    await zotero.DB.executeTransaction(() =>
      ensureConversationKeyLedgerEntryInTransaction({
        conversationKey: 2000,
        instanceID,
        conversationID: "conversation-a",
        system: "upstream",
        kind: "global",
        profileSignature: "profile-test",
        libraryID: 1,
        issuedAt: 1,
      }),
    );
    await zotero.DB.queryAsync(
      `INSERT INTO test_catalog
       (conversation_key, conversation_instance_id, conversation_id)
       VALUES (?, ?, ?)`,
      [2000, instanceID, "conversation-a"],
    );
    await zotero.DB.queryAsync(
      `INSERT INTO test_messages
       (conversation_key, conversation_instance_id, conversation_id, text)
       VALUES (?, ?, ?, ?)`,
      [2000, instanceID, "conversation-a", "before"],
    );
    await zotero.DB.executeTransaction(() =>
      retireConversationKeyInTransaction({
        conversationKey: 2000,
        instanceID,
      }),
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO test_catalog
           (conversation_key, conversation_instance_id, conversation_id)
           VALUES (?, ?, ?)`,
          )
          .run(2000, instanceID, "conversation-a"),
      /conversation key is permanently retired/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO test_messages
           (conversation_key, conversation_instance_id, conversation_id, text)
           VALUES (?, ?, ?, ?)`,
          )
          .run(2000, instanceID, "conversation-a", "after"),
      /conversation key is permanently retired/,
    );
  });

  // The database fence outlives the plugin: triggers live in zotero.sqlite and
  // no version removes them.  If it required conversation_instance_id, every
  // build predating that column -- i.e. every earlier release -- would have its
  // writes rejected forever, with no in-app recovery.  Exact identity matching
  // belongs in application code; the fence only guards retirement.
  it("accepts writes that omit the instance fingerprint while the key is live", async function () {
    await initConversationKeyLedgerStore();
    const zotero = globalScope.Zotero as any;
    await zotero.DB.queryAsync(
      `CREATE TABLE legacy_catalog (
        conversation_key INTEGER PRIMARY KEY,
        conversation_instance_id TEXT,
        conversation_id TEXT NOT NULL
      )`,
    );
    await zotero.DB.queryAsync(
      `CREATE TABLE legacy_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_key INTEGER NOT NULL,
        conversation_instance_id TEXT,
        conversation_id TEXT NOT NULL,
        text TEXT NOT NULL
      )`,
    );
    await installConversationKeyLedgerCatalogTriggers(["legacy_catalog"]);
    await installConversationKeyLedgerMessageTriggers({
      messageTable: "legacy_messages",
    });
    await zotero.DB.executeTransaction(() =>
      ensureConversationKeyLedgerEntryInTransaction({
        conversationKey: 2100,
        instanceID: "instance-live",
        conversationID: "conversation-live",
        system: "upstream",
        kind: "global",
        profileSignature: "profile-test",
        libraryID: 1,
        issuedAt: 1,
      }),
    );

    // An older build writes neither the fingerprint nor a matching ledger
    // lookup key; both must still succeed while the conversation is live.
    db.prepare(
      `INSERT INTO legacy_catalog (conversation_key, conversation_id)
       VALUES (?, ?)`,
    ).run(2100, "conversation-live");
    db.prepare(
      `INSERT INTO legacy_messages (conversation_key, conversation_id, text)
       VALUES (?, ?, ?)`,
    ).run(2100, "conversation-live", "written by an older build");
    assert.equal(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM legacy_messages`).get() as {
          n: number;
        }
      ).n,
      1,
    );

    // Retirement still closes the door, fingerprint or not.
    await zotero.DB.executeTransaction(() =>
      retireConversationKeyInTransaction({
        conversationKey: 2100,
        instanceID: "instance-live",
      }),
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO legacy_messages (conversation_key, conversation_id, text)
             VALUES (?, ?, ?)`,
          )
          .run(2100, "conversation-live", "after retirement"),
      /conversation key is permanently retired/,
    );
  });

  it("removes superseded fence triggers so the fence stays repairable", async function () {
    await initConversationKeyLedgerStore();
    const zotero = globalScope.Zotero as any;
    await zotero.DB.queryAsync(
      `CREATE TABLE upgrade_catalog (
        conversation_key INTEGER PRIMARY KEY,
        conversation_instance_id TEXT,
        conversation_id TEXT NOT NULL
      )`,
    );
    // Simulate a profile that already ran the superseded fence.
    await zotero.DB.queryAsync(
      `CREATE TRIGGER upgrade_catalog_conversation_key_ledger_insert
       BEFORE INSERT ON upgrade_catalog
       BEGIN SELECT RAISE(ABORT, 'conversation key is not issued and live'); END`,
    );
    await installConversationKeyLedgerCatalogTriggers(["upgrade_catalog"]);
    const triggers = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
      .all() as Array<{ name: string }>;
    const names = triggers.map((row) => row.name);
    assert.notInclude(names, "upgrade_catalog_conversation_key_ledger_insert");
    assert.include(names, "upgrade_catalog_conversation_fence_v2_insert");
    // The superseded rule aborted unconditionally; a live write must now pass.
    db.prepare(
      `INSERT INTO upgrade_catalog (conversation_key, conversation_id)
       VALUES (?, ?)`,
    ).run(2200, "conversation-upgraded");
  });

  it("restarts cleanly when a tombstone already has a real ledger witness", async function () {
    await initConversationKeyLedgerStore();
    const zotero = globalScope.Zotero as any;
    const instanceID = "instance-restarted";
    await zotero.DB.executeTransaction(() =>
      ensureConversationKeyLedgerEntryInTransaction({
        conversationKey: 3000,
        instanceID,
        conversationID: "conversation-real-id",
        system: "upstream",
        kind: "global",
        profileSignature: "profile-test",
        libraryID: 1,
        issuedAt: 1,
      }),
    );
    await zotero.DB.queryAsync(
      `CREATE TABLE llm_for_zotero_conversation_deletion_tombstones (
        identity_digest TEXT PRIMARY KEY,
        conversation_key INTEGER NOT NULL,
        instance_id TEXT NOT NULL,
        deleted_at INTEGER NOT NULL
      )`,
    );
    await zotero.DB.queryAsync(
      `INSERT INTO llm_for_zotero_conversation_deletion_tombstones
        (identity_digest, conversation_key, instance_id, deleted_at)
       VALUES (?, ?, ?, ?)`,
      ["digest", 3000, instanceID, 2],
    );

    await seedConversationKeyLedgerFromTombstones();

    const entry = await getConversationKeyLedgerEntry(3000);
    assert.equal(entry?.conversationID, "conversation-real-id");
    assert.equal(entry?.instanceID, instanceID);
    assert.isNumber(entry?.retiredAt);
  });

  it("rejects late agent, coverage, and attachment writes for a retired key", async function () {
    await initConversationKeyLedgerStore();
    const zotero = globalScope.Zotero as any;
    await zotero.DB.queryAsync(
      `CREATE TABLE llm_for_zotero_agent_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_key INTEGER NOT NULL,
        question_excerpt TEXT NOT NULL,
        tools_used_json TEXT NOT NULL,
        answer_excerpt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await zotero.DB.queryAsync(
      `CREATE TABLE llm_for_zotero_agent_coverage (
        scope_key TEXT NOT NULL,
        coverage_key TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        durable INTEGER NOT NULL,
        origin_conversation_key INTEGER,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(scope_key, coverage_key)
      )`,
    );
    await zotero.DB.queryAsync(
      `CREATE TABLE llm_for_zotero_attachment_refs (
        owner_type TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        blob_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(owner_type, owner_id, blob_hash)
      )`,
    );
    await installConversationKeyLedgerAgentTriggers();
    await zotero.DB.executeTransaction(() =>
      ensureConversationKeyLedgerEntryInTransaction({
        conversationKey: 4000,
        instanceID: "instance-agent",
        conversationID: "conversation-agent",
        system: "upstream",
        kind: "global",
        profileSignature: "profile-test",
        libraryID: 1,
        issuedAt: 1,
      }),
    );
    await zotero.DB.executeTransaction(() =>
      retireConversationKeyInTransaction({
        conversationKey: 4000,
        instanceID: "instance-agent",
      }),
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO llm_for_zotero_agent_memory
             (conversation_key, question_excerpt, tools_used_json, answer_excerpt, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(4000, "late", "[]", "late", 1),
      /conversation key is permanently retired/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO llm_for_zotero_agent_coverage
             (scope_key, coverage_key, resource_key, durable, origin_conversation_key, entry_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("paper:x", "coverage", "paper:x", 1, 4000, "{}", 1),
      /conversation key is permanently retired/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO llm_for_zotero_attachment_refs
             (owner_type, owner_id, blob_hash, updated_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run("conversation", 4000, "a".repeat(64), 1),
      /conversation key is permanently retired/,
    );
    // An owner the ledger has never seen is NOT rejected. Requiring the owner
    // to be issued turned an ordinary ordering race -- a lazily-initialized
    // attachment store running before the ledger seeding pass -- into an
    // unrecoverable SQL abort. Retirement is the boundary that matters, and
    // application code skips unknown owners on its own.
    db.prepare(
      `INSERT INTO llm_for_zotero_attachment_refs
       (owner_type, owner_id, blob_hash, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run("conversation", 4999, "b".repeat(64), 1);
    assert.equal(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM llm_for_zotero_attachment_refs
             WHERE owner_id = 4999`,
          )
          .get() as { n: number }
      ).n,
      1,
    );
  });

  it("burns legacy message-only keys before allocation can adopt them", async function () {
    await initConversationKeyLedgerStore();
    const zotero = globalScope.Zotero as any;
    await zotero.DB.queryAsync(
      `CREATE TABLE orphan_catalog (
        conversation_key INTEGER PRIMARY KEY,
        conversation_instance_id TEXT,
        conversation_id TEXT,
        library_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await zotero.DB.queryAsync(
      `CREATE TABLE orphan_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_key INTEGER NOT NULL,
        text TEXT NOT NULL
      )`,
    );
    await zotero.DB.queryAsync(
      `INSERT INTO orphan_messages (conversation_key, text)
       VALUES (?, ?)`,
      [5000, "legacy transcript"],
    );
    await reserveOrphanConversationMessageKeys({
      messageTable: "orphan_messages",
      catalogTables: ["orphan_catalog"],
      system: "upstream",
    });
    const entry = await getConversationKeyLedgerEntry(5000);
    assert.equal(entry?.retiredAt, entry?.issuedAt);
    assert.equal(entry?.retirementReason, "orphan-message-row-without-catalog");
    const next = await zotero.DB.executeTransaction(() =>
      allocateConversationKeyInTransaction({
        range: {
          system: "upstream",
          kind: "global",
          start: 5000,
          endExclusive: 5003,
        },
        libraryID: 1,
      }),
    );
    assert.equal(next.conversationKey, 5001);
  });

  it("burns orphan owner rows that use a nonstandard conversation-key column", async function () {
    await initConversationKeyLedgerStore();
    const zotero = globalScope.Zotero as any;
    await zotero.DB.queryAsync(
      `CREATE TABLE orphan_catalog (
        conversation_key INTEGER PRIMARY KEY
      )`,
    );
    await zotero.DB.queryAsync(
      `CREATE TABLE orphan_coverage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        origin_conversation_key INTEGER NOT NULL
      )`,
    );
    await zotero.DB.queryAsync(
      `INSERT INTO orphan_coverage (origin_conversation_key) VALUES (?)`,
      [6000],
    );

    await reserveOrphanConversationMessageKeys({
      catalogTables: ["orphan_catalog"],
      sourceTables: [
        { table: "orphan_coverage", column: "origin_conversation_key" },
      ],
      system: "upstream",
    });

    const entry = await getConversationKeyLedgerEntry(6000);
    assert.equal(entry?.retiredAt, entry?.issuedAt);
    assert.equal(entry?.retirementReason, "orphan-message-row-without-catalog");
  });

  // Seeding only visits catalog rows the ledger has not already recorded. That
  // filter must match the (key, instance) PAIR, not the key alone: a catalog
  // row whose key is known but whose identity differs is precisely the conflict
  // the quarantine table exists to record, and filtering on the key would skip
  // it silently.
  it("still quarantines a catalog row that claims a known key with a different identity", async function () {
    await initConversationKeyLedgerStore();
    const zotero = globalScope.Zotero as any;
    await zotero.DB.queryAsync(
      `CREATE TABLE conflict_catalog (
        conversation_key INTEGER PRIMARY KEY,
        conversation_instance_id TEXT,
        conversation_id TEXT,
        library_id INTEGER NOT NULL,
        created_at INTEGER
      )`,
    );
    await zotero.DB.executeTransaction(() =>
      ensureConversationKeyLedgerEntryInTransaction({
        conversationKey: 8000,
        instanceID: "instance-original",
        conversationID: "conversation-original",
        system: "upstream",
        kind: "global",
        profileSignature: "profile-test",
        libraryID: 1,
        issuedAt: 1,
      }),
    );
    await zotero.DB.queryAsync(
      `INSERT INTO conflict_catalog
        (conversation_key, conversation_instance_id, conversation_id, library_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [8000, "instance-conflicting", "conversation-conflicting", 1, 5],
    );

    await seedConversationKeyLedgerFromCatalogs([
      { table: "conflict_catalog", system: "upstream", kind: "global" },
    ]);

    const quarantined = db
      .prepare(
        `SELECT conversation_key AS conversationKey, instance_id AS instanceID, reason
         FROM llm_for_zotero_conversation_key_identity_quarantine`,
      )
      .all() as Array<Record<string, unknown>>;
    assert.lengthOf(quarantined, 1);
    assert.equal(quarantined[0]!.conversationKey, 8000);
    assert.equal(quarantined[0]!.instanceID, "instance-conflicting");
    // The original owner is untouched: seeding never picks a winner.
    const entry = await getConversationKeyLedgerEntry(8000);
    assert.equal(entry?.instanceID, "instance-original");
  });

  it("skips catalog rows the ledger already records", async function () {
    await initConversationKeyLedgerStore();
    const zotero = globalScope.Zotero as any;
    await zotero.DB.queryAsync(
      `CREATE TABLE seeded_catalog (
        conversation_key INTEGER PRIMARY KEY,
        conversation_instance_id TEXT,
        conversation_id TEXT,
        library_id INTEGER NOT NULL,
        created_at INTEGER
      )`,
    );
    await zotero.DB.queryAsync(
      `INSERT INTO seeded_catalog
        (conversation_key, conversation_instance_id, conversation_id, library_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [8100, "instance-seeded", "conversation-seeded", 1, 5],
    );
    const catalogs = [
      {
        table: "seeded_catalog",
        system: "upstream" as const,
        kind: "global" as const,
      },
    ];

    await seedConversationKeyLedgerFromCatalogs(catalogs);
    // A second pass must be a no-op, not a re-quarantine.
    await seedConversationKeyLedgerFromCatalogs(catalogs);

    assert.equal(
      (await getConversationKeyLedgerEntry(8100))?.instanceID,
      "instance-seeded",
    );
    const quarantined = db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM llm_for_zotero_conversation_key_identity_quarantine`,
      )
      .get() as { n: number };
    assert.equal(quarantined.n, 0);
  });

  // Same defect class as the attachment fence: requiring an ISSUED conversation
  // meant an agent run on a key the ledger had not yet seen failed hard at the
  // database rather than being skipped. Retirement is the boundary.
  it("blocks agent run events only for a retired conversation", async function () {
    await initConversationKeyLedgerStore();
    const zotero = globalScope.Zotero as any;
    await zotero.DB.queryAsync(
      `CREATE TABLE llm_for_zotero_agent_runs (
        run_id TEXT PRIMARY KEY,
        conversation_key INTEGER NOT NULL
      )`,
    );
    await zotero.DB.queryAsync(
      `CREATE TABLE llm_for_zotero_agent_run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        payload TEXT
      )`,
    );
    await installConversationKeyLedgerAgentTriggers();

    // A run on a conversation the ledger has never seen must still record.
    await zotero.DB.queryAsync(
      `INSERT INTO llm_for_zotero_agent_runs (run_id, conversation_key)
       VALUES (?, ?)`,
      ["run-unissued", 9100],
    );
    db.prepare(
      `INSERT INTO llm_for_zotero_agent_run_events (run_id, payload)
       VALUES (?, ?)`,
    ).run("run-unissued", "{}");

    // A run on a retired conversation must not.
    await zotero.DB.executeTransaction(() =>
      ensureConversationKeyLedgerEntryInTransaction({
        conversationKey: 9200,
        instanceID: "instance-retired-run",
        conversationID: "conversation-retired-run",
        system: "upstream",
        kind: "global",
        profileSignature: "profile-test",
        libraryID: 1,
        issuedAt: 1,
      }),
    );
    await zotero.DB.queryAsync(
      `INSERT INTO llm_for_zotero_agent_runs (run_id, conversation_key)
       VALUES (?, ?)`,
      ["run-retired", 9200],
    );
    await zotero.DB.executeTransaction(() =>
      retireConversationKeyInTransaction({
        conversationKey: 9200,
        instanceID: "instance-retired-run",
      }),
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO llm_for_zotero_agent_run_events (run_id, payload)
             VALUES (?, ?)`,
          )
          .run("run-retired", "{}"),
      /conversation key is permanently retired/,
    );
  });

  it("exposes quarantined identities instead of leaving them invisible", async function () {
    await initConversationKeyLedgerStore();
    const zotero = globalScope.Zotero as any;
    assert.deepEqual(await getConversationKeyQuarantineEntries(), []);
    assert.equal(await logConversationKeyQuarantineSummary(), 0);

    await zotero.DB.queryAsync(
      `CREATE TABLE visible_catalog (
        conversation_key INTEGER PRIMARY KEY,
        conversation_instance_id TEXT,
        conversation_id TEXT,
        library_id INTEGER NOT NULL,
        created_at INTEGER
      )`,
    );
    await zotero.DB.executeTransaction(() =>
      ensureConversationKeyLedgerEntryInTransaction({
        conversationKey: 8200,
        instanceID: "instance-owner",
        conversationID: "conversation-owner",
        system: "upstream",
        kind: "global",
        profileSignature: "profile-test",
        libraryID: 1,
        issuedAt: 1,
      }),
    );
    await zotero.DB.queryAsync(
      `INSERT INTO visible_catalog
        (conversation_key, conversation_instance_id, conversation_id, library_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [8200, "instance-intruder", "conversation-intruder", 1, 5],
    );
    await seedConversationKeyLedgerFromCatalogs([
      { table: "visible_catalog", system: "upstream", kind: "global" },
    ]);

    const entries = await getConversationKeyQuarantineEntries();
    assert.lengthOf(entries, 1);
    assert.equal(entries[0]!.conversationKey, 8200);
    assert.include(entries[0]!.reason, "conflicting-legacy-identity");
    assert.equal(await logConversationKeyQuarantineSummary(), 1);
  });

  describe("range allocation is monotonic and terminates", function () {
    it("returns the next key above the range maximum, never a gap", async function () {
      await initConversationKeyLedgerStore();
      const zotero = globalScope.Zotero as any;
      for (const key of [1000, 1001, 1005]) {
        await zotero.DB.executeTransaction(() =>
          ensureConversationKeyLedgerEntryInTransaction({
            conversationKey: key,
            instanceID: `instance-${key}`,
            conversationID: `conversation-${key}`,
            system: "upstream",
            kind: "global",
            profileSignature: "profile-test",
            libraryID: 1,
            issuedAt: 1,
          }),
        );
      }
      // 1002-1004 are gaps. Reusing them would contradict permanent non-reuse,
      // so allocation continues above the maximum.
      assert.equal(
        await nextUnissuedConversationKeyInRange({
          start: 1000,
          endExclusive: 1100,
        }),
        1006,
      );
      // A caller-supplied floor is respected when it is higher.
      assert.equal(
        await nextUnissuedConversationKeyInRange({
          start: 1000,
          endExclusive: 1100,
          atLeast: 1050,
        }),
        1050,
      );
    });

    it("fails closed when the range is exhausted", async function () {
      await initConversationKeyLedgerStore();
      const zotero = globalScope.Zotero as any;
      await zotero.DB.executeTransaction(() =>
        ensureConversationKeyLedgerEntryInTransaction({
          conversationKey: 1099,
          instanceID: "instance-last",
          conversationID: "conversation-last",
          system: "upstream",
          kind: "global",
          profileSignature: "profile-test",
          libraryID: 1,
          issuedAt: 1,
        }),
      );
      try {
        await nextUnissuedConversationKeyInRange({
          start: 1000,
          endExclusive: 1100,
        });
        assert.fail("expected the exhausted range to throw");
      } catch (error) {
        assert.match(String(error), /exhausted/i);
      }
    });

    // The superseded implementation walked keys with one query per occupied
    // key and no ceiling. Against a stub that answers every SELECT the same
    // way -- which several test doubles in this repo do -- it never
    // terminated, spinning a core indefinitely.
    it("terminates against a stub that answers every query identically", async function () {
      await initConversationKeyLedgerStore();
      const zotero = globalScope.Zotero as any;
      const realQuery = zotero.DB.queryAsync;
      zotero.DB.queryAsync = async (sql: string, params?: unknown[]) => {
        if (sql.trimStart().toUpperCase().startsWith("SELECT")) {
          return [{ conversationKey: 1, instanceID: "x", maxKey: undefined }];
        }
        return realQuery(sql, params);
      };
      const key = await nextUnissuedConversationKeyInRange({
        start: 2000,
        endExclusive: 2100,
      });
      assert.equal(key, 2000);
    });
  });

  describe("orphan retirement requires evidence", function () {
    async function seedLiveEntry(conversationKey: number, instanceID: string) {
      const zotero = globalScope.Zotero as any;
      await zotero.DB.executeTransaction(() =>
        ensureConversationKeyLedgerEntryInTransaction({
          conversationKey,
          instanceID,
          conversationID: `conversation-${conversationKey}`,
          system: "upstream",
          kind: "global",
          profileSignature: "profile-test",
          libraryID: 1,
          issuedAt: 1,
        }),
      );
    }

    it("retires a ledger entry whose catalog row really is gone", async function () {
      await initConversationKeyLedgerStore();
      const zotero = globalScope.Zotero as any;
      await zotero.DB.queryAsync(
        `CREATE TABLE live_catalog (
          conversation_key INTEGER PRIMARY KEY,
          conversation_instance_id TEXT,
          conversation_id TEXT
        )`,
      );
      await seedLiveEntry(7000, "instance-orphan");

      await retireOrphanedConversationLedgerEntries({
        system: "upstream",
        kind: "global",
        catalogTables: ["live_catalog"],
      });

      const entry = await getConversationKeyLedgerEntry(7000);
      assert.isOk(entry?.retiredAt);
      assert.equal(
        entry?.retirementReason,
        "orphaned-ledger-allocation-after-crash",
      );
    });

    // Retirement is permanent and has no automatic reversal, so a probe that
    // could not run must never be read as "the conversation is gone". Before
    // this guard, a missing or renamed catalog table meant every live key in
    // that range was silently and irreversibly destroyed at startup.
    it("does not retire when no catalog could be read", async function () {
      await initConversationKeyLedgerStore();
      await seedLiveEntry(7100, "instance-unprobed");

      await retireOrphanedConversationLedgerEntries({
        system: "upstream",
        kind: "global",
        catalogTables: ["catalog_that_does_not_exist"],
      });

      const entry = await getConversationKeyLedgerEntry(7100);
      assert.isUndefined(
        entry?.retiredAt,
        "an unreadable catalog is not evidence the conversation is gone",
      );
    });

    // A crash-abandoned allocation has no messages. One that does is real user
    // content, and retiring it would strand it behind a permanently closed key.
    it("does not retire an orphan that still has messages", async function () {
      await initConversationKeyLedgerStore();
      const zotero = globalScope.Zotero as any;
      await zotero.DB.queryAsync(
        `CREATE TABLE live_catalog (
          conversation_key INTEGER PRIMARY KEY,
          conversation_instance_id TEXT,
          conversation_id TEXT
        )`,
      );
      await zotero.DB.queryAsync(
        `CREATE TABLE llm_for_zotero_chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_key INTEGER NOT NULL,
          text TEXT
        )`,
      );
      await zotero.DB.queryAsync(
        `INSERT INTO llm_for_zotero_chat_messages (conversation_key, text)
         VALUES (?, ?)`,
        [7200, "real user content"],
      );
      await seedLiveEntry(7200, "instance-has-messages");

      await retireOrphanedConversationLedgerEntries({
        system: "upstream",
        kind: "global",
        catalogTables: ["live_catalog"],
      });

      const entry = await getConversationKeyLedgerEntry(7200);
      assert.isUndefined(entry?.retiredAt);
    });

    it("can reverse a crash retirement but not a real deletion", async function () {
      await initConversationKeyLedgerStore();
      const zotero = globalScope.Zotero as any;
      await zotero.DB.queryAsync(
        `CREATE TABLE live_catalog (
          conversation_key INTEGER PRIMARY KEY,
          conversation_instance_id TEXT,
          conversation_id TEXT
        )`,
      );
      await seedLiveEntry(7300, "instance-crash");
      await seedLiveEntry(7400, "instance-deleted");

      // 7400 is retired the way a user deletion retires it. This must happen
      // before the orphan pass: retirement records its FIRST cause (the reason
      // column is COALESCEd), and that first cause is what decides whether the
      // retirement is reversible.
      await zotero.DB.executeTransaction(() =>
        retireConversationKeyInTransaction({
          conversationKey: 7400,
          instanceID: "instance-deleted",
          reason: "conversation-deleted",
        }),
      );
      await retireOrphanedConversationLedgerEntries({
        system: "upstream",
        kind: "global",
        catalogTables: ["live_catalog"],
      });

      assert.isTrue(
        await zotero.DB.executeTransaction(() =>
          unretireConversationKeyInTransaction({
            conversationKey: 7300,
            instanceID: "instance-crash",
          }),
        ),
      );
      assert.isUndefined(
        (await getConversationKeyLedgerEntry(7300))?.retiredAt,
      );

      assert.isFalse(
        await zotero.DB.executeTransaction(() =>
          unretireConversationKeyInTransaction({
            conversationKey: 7400,
            instanceID: "instance-deleted",
          }),
        ),
        "a deliberate deletion must stay retired",
      );
      assert.isOk((await getConversationKeyLedgerEntry(7400))?.retiredAt);
    });
  });
});

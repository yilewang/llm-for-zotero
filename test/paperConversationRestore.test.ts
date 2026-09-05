import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { config } from "../package.json";
import {
  getCurrentProfileSignature,
  initConversationRegistryStore,
  invalidateRegisteredConversationScope,
  resetConversationRegistryStoreInitForTests,
} from "../src/shared/conversationRegistry";
import {
  beginPaperRestoreSelectionShutdown,
  flushPaperRestoreSelectionWrites,
  forgetPaperRestoreTargetsForItem,
  getPaperRestoreTarget,
  initializePaperRestoreSelections,
  invalidatePaperRestoreTargetCache,
  rememberPaperRestoreTarget,
  resetPaperRestoreSelectionStateForTests,
  stagePaperRestoreTargetForStartup,
} from "../src/shared/paperConversationRestore";
import {
  getLastUsedPaperConversationKey,
  setLastUsedPaperConversationKey,
} from "../src/modules/contextPanel/prefHelpers";
import {
  getLastUsedClaudePaperConversationKey,
  setLastUsedClaudePaperConversationKey,
} from "../src/claudeCode/prefs";
import { getClaudePaperConversationKeyRange } from "../src/claudeCode/constants";
import {
  getLastUsedCodexPaperConversationKey,
  setLastUsedCodexPaperConversationKey,
} from "../src/codexAppServer/prefs";
import { getCodexPaperConversationKeyRange } from "../src/codexAppServer/constants";
import {
  registerPaperConversationRestoreNotifications,
  unregisterPaperConversationRestoreNotifications,
} from "../src/services/paperConversationRestoreNotifications";
import { zoteroChangeDispatcher } from "../src/services/zoteroChangeDispatcher";
import type { ConversationSystem } from "../src/shared/types";

const REGISTRY_TABLE = "llm_for_zotero_conversation_registry";
const MIGRATION_TABLE = "llm_for_zotero_conversation_schema_migrations";
const PROFILE_DIR = "/tmp/llm-for-zotero-paper-restore-test";

type Harness = {
  db: DatabaseSync;
  prefs: Map<string, unknown>;
  prefWrites: Array<{ key: string; value: unknown }>;
  debug: string[];
  queryLog: string[];
  transactionCount: number;
  failNextTransaction: boolean;
  failPreferenceClear: boolean;
  shutdownBlocker: (() => Promise<void>) | null;
};

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
  ChromeUtils?: unknown;
};
const originalZotero = globalScope.Zotero;
const originalChromeUtils = globalScope.ChromeUtils;

function prefKey(name: string): string {
  return `${config.prefsPrefix}.${name}`;
}

function bindable(params?: unknown[]): never[] {
  return (params || []).map((value) =>
    value === undefined ? null : value,
  ) as never[];
}

async function installHarness(options?: {
  withShutdownBlocker?: boolean;
}): Promise<Harness> {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE items (itemID INTEGER PRIMARY KEY, libraryID INTEGER NOT NULL)`,
  );
  db.exec(`CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY)`);
  db.exec(`CREATE TABLE llm_for_zotero_paper_conversations (
    conversation_key INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL,
    paper_item_id INTEGER NOT NULL,
    webchat_session INTEGER NOT NULL DEFAULT 0
  )`);
  const harness: Harness = {
    db,
    prefs: new Map(),
    prefWrites: [],
    debug: [],
    queryLog: [],
    transactionCount: 0,
    failNextTransaction: false,
    failPreferenceClear: false,
    shutdownBlocker: null,
  };
  const queryAsync = async (sql: string, params?: unknown[]) => {
    harness.queryLog.push(sql);
    const statement = db.prepare(sql);
    const head = sql.trimStart().slice(0, 8).toUpperCase();
    if (
      head.startsWith("SELECT") ||
      head.startsWith("PRAGMA") ||
      head.startsWith("WITH")
    ) {
      return statement.all(...bindable(params)) as Record<string, unknown>[];
    }
    statement.run(...bindable(params));
    return [];
  };
  globalScope.Zotero = {
    Profile: { dir: PROFILE_DIR },
    Items: {
      get: () => {
        throw new Error("Paper restore startup must not load items one-by-one");
      },
    },
    Prefs: {
      get: (key: string) => harness.prefs.get(key),
      set: (key: string, value: unknown) => {
        harness.prefWrites.push({ key, value });
        harness.prefs.set(key, value);
      },
      clear: (key: string) => {
        if (harness.failPreferenceClear) {
          throw new Error("forced preference clear failure");
        }
        harness.prefs.delete(key);
      },
    },
    DB: {
      queryAsync,
      executeTransaction: async <T>(task: () => Promise<T>): Promise<T> => {
        harness.transactionCount += 1;
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await task();
          if (harness.failNextTransaction) {
            harness.failNextTransaction = false;
            throw new Error("forced transaction failure");
          }
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
    debug: (message: string) => harness.debug.push(String(message)),
  };
  if (options?.withShutdownBlocker) {
    globalScope.ChromeUtils = {
      importESModule: () => ({
        AsyncShutdown: {
          profileBeforeChange: {
            addBlocker: (_name: string, blocker: () => Promise<void>) => {
              harness.shutdownBlocker = blocker;
            },
            removeBlocker: (blocker: () => Promise<void>) => {
              if (harness.shutdownBlocker === blocker) {
                harness.shutdownBlocker = null;
              }
            },
          },
        },
      }),
    };
  } else {
    globalScope.ChromeUtils = undefined;
  }
  resetConversationRegistryStoreInitForTests();
  resetPaperRestoreSelectionStateForTests();
  await initConversationRegistryStore();
  return harness;
}

function addConversation(
  harness: Harness,
  system: ConversationSystem,
  conversationKey: number,
  libraryID: number,
  paperItemID: number,
  options?: { marker?: boolean; webchat?: boolean },
): string {
  const instanceID = `instance-${system}-${conversationKey}`;
  const profileSignature = getCurrentProfileSignature();
  harness.db
    .prepare(`INSERT OR IGNORE INTO items (itemID, libraryID) VALUES (?, ?)`)
    .run(paperItemID, libraryID);
  if (system === "upstream") {
    harness.db
      .prepare(
        `INSERT INTO llm_for_zotero_paper_conversations
          (conversation_key, library_id, paper_item_id, webchat_session)
         VALUES (?, ?, ?, ?)`,
      )
      .run(conversationKey, libraryID, paperItemID, options?.webchat ? 1 : 0);
  }
  harness.db
    .prepare(
      `INSERT INTO ${REGISTRY_TABLE}
        (instance_id, conversation_id, legacy_conversation_key, system, kind,
         profile_signature, library_id, paper_item_id, created_at, updated_at,
         title, valid, invalid_reason, is_paper_restore_target)
       VALUES (?, ?, ?, ?, 'paper', ?, ?, ?, 1, 1, NULL, 1, NULL, ?)`,
    )
    .run(
      instanceID,
      `conversation-${system}-${conversationKey}`,
      conversationKey,
      system,
      profileSignature,
      libraryID,
      paperItemID,
      options?.marker ? 1 : 0,
    );
  return instanceID;
}

function markerKeys(harness: Harness): number[] {
  return (
    harness.db
      .prepare(
        `SELECT legacy_conversation_key AS conversationKey
         FROM ${REGISTRY_TABLE}
         WHERE is_paper_restore_target = 1
         ORDER BY legacy_conversation_key`,
      )
      .all() as Array<{ conversationKey: number }>
  ).map((row) => Number(row.conversationKey));
}

function readiness(
  ready: Partial<{
    upstream: boolean;
    claude: boolean;
    codex: boolean;
  }> = {},
) {
  return {
    chatStoreReady: Boolean(ready.upstream),
    claudeStoreReady: Boolean(ready.claude),
    codexStoreReady: Boolean(ready.codex),
  };
}

describe("paper conversation restore selections", function () {
  let harness: Harness;

  afterEach(async function () {
    unregisterPaperConversationRestoreNotifications();
    await flushPaperRestoreSelectionWrites();
    resetPaperRestoreSelectionStateForTests();
    resetConversationRegistryStoreInitForTests();
    harness?.db.close();
    globalScope.Zotero = originalZotero;
    globalScope.ChromeUtils = originalChromeUtils;
  });

  it("adds the constrained marker and exact partial unique index", async function () {
    harness = await installHarness();
    const columns = harness.db
      .prepare(`PRAGMA table_info(${REGISTRY_TABLE})`)
      .all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
    const marker = columns.find(
      (column) => column.name === "is_paper_restore_target",
    );
    assert.equal(marker?.notnull, 1);
    assert.equal(Number(marker?.dflt_value), 0);

    const index = harness.db
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index'
           AND name = 'llm_for_zotero_unique_paper_restore_target'`,
      )
      .get() as { sql?: string } | undefined;
    assert.include(index?.sql || "", "CREATE UNIQUE INDEX");
    assert.include(index?.sql || "", "WHERE kind = 'paper'");
    assert.include(index?.sql || "", "is_paper_restore_target = 1");

    addConversation(harness, "upstream", 101, 1, 10, { marker: true });
    addConversation(harness, "upstream", 102, 1, 10);
    assert.throws(() => {
      harness.db
        .prepare(
          `UPDATE ${REGISTRY_TABLE}
           SET is_paper_restore_target = 1
           WHERE legacy_conversation_key = 102`,
        )
        .run();
    }, /UNIQUE constraint failed/);
  });

  it("migrates and restores all three runtimes without writing their preferences", async function () {
    harness = await installHarness();
    const profile = getCurrentProfileSignature();
    addConversation(harness, "upstream", 1101, 1, 11);
    addConversation(harness, "claude_code", 4101, 1, 12);
    addConversation(harness, "codex", 6101, 1, 13);
    harness.prefs.set(
      prefKey("lastUsedPaperConversationMap"),
      JSON.stringify({ "1:11": 1101 }),
    );
    harness.prefs.set(
      prefKey("claudeCodePaperConversationMap"),
      JSON.stringify({ [`${profile}:1:12`]: 4101 }),
    );
    harness.prefs.set(
      prefKey("codexAppServerPaperConversationMap"),
      JSON.stringify({ [`${profile}:1:13`]: 6101 }),
    );

    await initializePaperRestoreSelections(
      readiness({ upstream: true, claude: true, codex: true }),
    );

    assert.equal(getLastUsedPaperConversationKey(1, 11), 1101);
    assert.equal(getLastUsedClaudePaperConversationKey(1, 12), 4101);
    assert.equal(getLastUsedCodexPaperConversationKey(1, 13), 6101);
    assert.deepEqual(markerKeys(harness), [1101, 4101, 6101]);
    assert.isFalse(harness.prefs.has(prefKey("lastUsedPaperConversationMap")));
    assert.isFalse(
      harness.prefs.has(prefKey("claudeCodePaperConversationMap")),
    );
    assert.isFalse(
      harness.prefs.has(prefKey("codexAppServerPaperConversationMap")),
    );
    assert.deepEqual(harness.prefWrites, []);

    resetPaperRestoreSelectionStateForTests();
    await initializePaperRestoreSelections(
      readiness({ upstream: true, claude: true, codex: true }),
    );
    assert.equal(getLastUsedPaperConversationKey(1, 11), 1101);
    assert.equal(getLastUsedClaudePaperConversationKey(1, 12), 4101);
    assert.equal(getLastUsedCodexPaperConversationKey(1, 13), 6101);
  });

  it("migrates ready runtimes independently and retains unavailable preferences", async function () {
    harness = await installHarness();
    const profile = getCurrentProfileSignature();
    addConversation(harness, "upstream", 1201, 1, 21);
    addConversation(harness, "codex", 6201, 1, 22);
    harness.prefs.set(
      prefKey("lastUsedPaperConversationMap"),
      JSON.stringify({ "1:21": 1201 }),
    );
    harness.prefs.set(
      prefKey("codexAppServerPaperConversationMap"),
      JSON.stringify({ [`${profile}:1:22`]: 6201 }),
    );

    await initializePaperRestoreSelections(readiness({ upstream: true }));

    assert.equal(getLastUsedPaperConversationKey(1, 21), 1201);
    assert.isNull(getLastUsedCodexPaperConversationKey(1, 22));
    assert.isFalse(harness.prefs.has(prefKey("lastUsedPaperConversationMap")));
    assert.isTrue(
      harness.prefs.has(prefKey("codexAppServerPaperConversationMap")),
    );
    const migrations = harness.db
      .prepare(`SELECT id FROM ${MIGRATION_TABLE} ORDER BY id`)
      .all() as Array<{ id: string }>;
    assert.deepEqual(
      migrations.map((row) => row.id),
      ["paper-restore-selection-v1:upstream"],
    );
  });

  it("imports store-migration candidates without recreating a preference", async function () {
    harness = await installHarness();
    addConversation(harness, "claude_code", 4201, 1, 23);
    stagePaperRestoreTargetForStartup(
      { system: "claude_code", libraryID: 1, paperItemID: 23 },
      4201,
    );

    await initializePaperRestoreSelections(readiness({ claude: true }));

    assert.equal(getLastUsedClaudePaperConversationKey(1, 23), 4201);
    assert.deepEqual(markerKeys(harness), [4201]);
    assert.isFalse(
      harness.prefs.has(prefKey("claudeCodePaperConversationMap")),
    );
    assert.deepEqual(harness.prefWrites, []);
  });

  it("prunes deleted, library-mismatched, and WebChat markers in one startup transaction", async function () {
    harness = await installHarness();
    addConversation(harness, "upstream", 1251, 1, 24, { marker: true });
    addConversation(harness, "upstream", 1252, 1, 25, { marker: true });
    addConversation(harness, "upstream", 1253, 1, 26, {
      marker: true,
      webchat: true,
    });
    harness.db.prepare(`INSERT INTO deletedItems (itemID) VALUES (?)`).run(24);
    harness.db
      .prepare(`UPDATE items SET libraryID = 2 WHERE itemID = ?`)
      .run(25);
    const transactionBaseline = harness.transactionCount;

    await initializePaperRestoreSelections(readiness({ upstream: true }));

    assert.deepEqual(markerKeys(harness), []);
    assert.isNull(getLastUsedPaperConversationKey(1, 24));
    assert.isNull(getLastUsedPaperConversationKey(1, 25));
    assert.isNull(getLastUsedPaperConversationKey(1, 26));
    assert.equal(harness.transactionCount - transactionBaseline, 1);
  });

  it("uses one global queue, preserves write order, and ignores duplicate assignments", async function () {
    harness = await installHarness();
    addConversation(harness, "upstream", 1301, 1, 31);
    addConversation(harness, "upstream", 1302, 1, 31);
    addConversation(harness, "upstream", 1303, 1, 31);
    await initializePaperRestoreSelections(readiness({ upstream: true }));
    const afterInitialization = harness.transactionCount;

    setLastUsedPaperConversationKey(1, 31, 1301);
    setLastUsedPaperConversationKey(1, 31, 1302);
    setLastUsedPaperConversationKey(1, 31, 1303);
    setLastUsedPaperConversationKey(1, 31, 1303);
    assert.equal(getLastUsedPaperConversationKey(1, 31), 1303);
    await flushPaperRestoreSelectionWrites();

    assert.deepEqual(markerKeys(harness), [1303]);
    assert.equal(
      harness.transactionCount - afterInitialization,
      3,
      "A -> B -> C must serialize, while duplicate C is a no-op",
    );
    const afterCommit = harness.transactionCount;
    setLastUsedPaperConversationKey(1, 31, 1303);
    await flushPaperRestoreSelectionWrites();
    assert.equal(harness.transactionCount, afterCommit);
  });

  it("does not let a rejected write poison or roll back a newer selection", async function () {
    harness = await installHarness();
    addConversation(harness, "upstream", 1401, 1, 41);
    addConversation(harness, "upstream", 1402, 1, 41);
    await initializePaperRestoreSelections(readiness({ upstream: true }));
    rememberPaperRestoreTarget(
      { system: "upstream", libraryID: 1, paperItemID: 41 },
      1401,
    );
    await flushPaperRestoreSelectionWrites();

    rememberPaperRestoreTarget(
      { system: "upstream", libraryID: 1, paperItemID: 41 },
      999999,
    );
    rememberPaperRestoreTarget(
      { system: "upstream", libraryID: 1, paperItemID: 41 },
      1402,
    );
    await flushPaperRestoreSelectionWrites();

    assert.equal(
      getPaperRestoreTarget({
        system: "upstream",
        libraryID: 1,
        paperItemID: 41,
      }),
      1402,
    );
    assert.deepEqual(markerKeys(harness), [1402]);
    assert.isTrue(
      harness.debug.some((message) =>
        message.includes("Could not persist paper restore selection"),
      ),
    );
  });

  it("rejects WebChat rows at the database boundary and never recreates the preference", async function () {
    harness = await installHarness();
    addConversation(harness, "upstream", 1501, 1, 51, { webchat: true });
    addConversation(harness, "upstream", 1502, 1, 51);
    await initializePaperRestoreSelections(readiness({ upstream: true }));

    setLastUsedPaperConversationKey(1, 51, 1501);
    await flushPaperRestoreSelectionWrites();
    assert.isNull(getLastUsedPaperConversationKey(1, 51));

    setLastUsedPaperConversationKey(1, 51, 1502);
    await flushPaperRestoreSelectionWrites();
    assert.equal(getLastUsedPaperConversationKey(1, 51), 1502);
    assert.deepEqual(markerKeys(harness), [1502]);
    assert.deepEqual(
      harness.prefWrites.filter((write) =>
        write.key.endsWith("lastUsedPaperConversationMap"),
      ),
      [],
    );
  });

  it("clears invalidated targets after commit and preserves newer identities", async function () {
    harness = await installHarness();
    const instanceID = addConversation(harness, "upstream", 1601, 1, 61);
    await initializePaperRestoreSelections(readiness({ upstream: true }));
    rememberPaperRestoreTarget(
      { system: "upstream", libraryID: 1, paperItemID: 61 },
      1601,
    );
    await flushPaperRestoreSelectionWrites();

    invalidatePaperRestoreTargetCache(
      { system: "upstream", libraryID: 1, paperItemID: 61 },
      1601,
      "different-instance",
    );
    assert.equal(getLastUsedPaperConversationKey(1, 61), 1601);

    await invalidateRegisteredConversationScope(1601, "test invalidation");
    assert.isNull(getLastUsedPaperConversationKey(1, 61));
    const row = harness.db
      .prepare(
        `SELECT valid, is_paper_restore_target AS marker
         FROM ${REGISTRY_TABLE}
         WHERE instance_id = ?`,
      )
      .get(instanceID) as { valid: number; marker: number };
    assert.equal(row.valid, 0);
    assert.equal(row.marker, 0);
  });

  it("clears removed papers through the item notification path", async function () {
    harness = await installHarness();
    addConversation(harness, "upstream", 1701, 1, 71);
    await initializePaperRestoreSelections(readiness({ upstream: true }));
    registerPaperConversationRestoreNotifications();
    setLastUsedPaperConversationKey(1, 71, 1701);
    await flushPaperRestoreSelectionWrites();

    await zoteroChangeDispatcher.dispatch({
      event: "trash",
      type: "item",
      ids: [71],
    });
    assert.isNull(getLastUsedPaperConversationKey(1, 71));
    await flushPaperRestoreSelectionWrites();
    assert.deepEqual(markerKeys(harness), []);
  });

  it("retains and retries a runtime migration after a transaction failure", async function () {
    harness = await installHarness();
    addConversation(harness, "upstream", 1801, 1, 81);
    harness.prefs.set(
      prefKey("lastUsedPaperConversationMap"),
      JSON.stringify({ "1:81": 1801 }),
    );
    harness.failNextTransaction = true;

    await initializePaperRestoreSelections(readiness({ upstream: true }));
    assert.equal(getLastUsedPaperConversationKey(1, 81), 1801);
    assert.isTrue(harness.prefs.has(prefKey("lastUsedPaperConversationMap")));
    assert.deepEqual(markerKeys(harness), []);

    setLastUsedPaperConversationKey(1, 81, 1801);
    await flushPaperRestoreSelectionWrites();
    assert.deepEqual(markerKeys(harness), []);

    resetPaperRestoreSelectionStateForTests();
    await initializePaperRestoreSelections(readiness({ upstream: true }));
    assert.equal(getLastUsedPaperConversationKey(1, 81), 1801);
    assert.deepEqual(markerKeys(harness), [1801]);
    assert.isFalse(harness.prefs.has(prefKey("lastUsedPaperConversationMap")));
  });

  it("retries only preference removal after a committed migration", async function () {
    harness = await installHarness();
    addConversation(harness, "upstream", 1901, 1, 91);
    harness.prefs.set(
      prefKey("lastUsedPaperConversationMap"),
      JSON.stringify({ "1:91": 1901 }),
    );
    harness.failPreferenceClear = true;
    await initializePaperRestoreSelections(readiness({ upstream: true }));
    assert.deepEqual(markerKeys(harness), [1901]);
    assert.isTrue(harness.prefs.has(prefKey("lastUsedPaperConversationMap")));

    harness.failPreferenceClear = false;
    resetPaperRestoreSelectionStateForTests();
    await initializePaperRestoreSelections(readiness({ upstream: true }));
    assert.deepEqual(markerKeys(harness), [1901]);
    assert.isFalse(harness.prefs.has(prefKey("lastUsedPaperConversationMap")));
  });

  it("flushes through profileBeforeChange and refuses later writes", async function () {
    harness = await installHarness({ withShutdownBlocker: true });
    addConversation(harness, "upstream", 2001, 1, 101);
    addConversation(harness, "upstream", 2002, 1, 101);
    await initializePaperRestoreSelections(readiness({ upstream: true }));
    assert.isFunction(harness.shutdownBlocker);

    setLastUsedPaperConversationKey(1, 101, 2001);
    await harness.shutdownBlocker?.();
    assert.deepEqual(markerKeys(harness), [2001]);

    setLastUsedPaperConversationKey(1, 101, 2002);
    await flushPaperRestoreSelectionWrites();
    assert.deepEqual(markerKeys(harness), [2001]);
    assert.equal(getLastUsedPaperConversationKey(1, 101), 2001);
    beginPaperRestoreSelectionShutdown();
  });

  it("migrates an issue-sized map with one scan and one transaction", async function () {
    this.timeout(15_000);
    harness = await installHarness();
    const entries: Record<string, number> = {};
    harness.db.exec("BEGIN");
    for (let paperItemID = 1; paperItemID <= 3000; paperItemID += 1) {
      const conversationKey = 1_500_000_000 + paperItemID;
      addConversation(harness, "upstream", conversationKey, 1, paperItemID);
      entries[`1:${paperItemID}`] = conversationKey;
    }
    harness.db.exec("COMMIT");
    const raw = JSON.stringify(entries);
    assert.isAbove(Buffer.byteLength(raw, "utf8"), 56_000);
    harness.prefs.set(prefKey("lastUsedPaperConversationMap"), raw);
    const transactionBaseline = harness.transactionCount;
    const queryBaseline = harness.queryLog.length;

    await initializePaperRestoreSelections(readiness({ upstream: true }));

    const runtimeQueries = harness.queryLog.slice(queryBaseline);
    assert.equal(
      runtimeQueries.filter(
        (sql) =>
          sql.includes(`FROM ${REGISTRY_TABLE} r`) &&
          sql.includes("JOIN items i"),
      ).length,
      1,
    );
    assert.equal(harness.transactionCount - transactionBaseline, 1);
    assert.equal(getLastUsedPaperConversationKey(1, 1777), 1_500_001_777);
    assert.equal(markerKeys(harness).length, 3000);
    assert.isFalse(harness.prefs.has(prefKey("lastUsedPaperConversationMap")));
  });

  it("exposes the same synchronous contract through every runtime helper", async function () {
    harness = await installHarness();
    const claudeKey = getClaudePaperConversationKeyRange().start + 1;
    const codexKey = getCodexPaperConversationKeyRange().start + 1;
    addConversation(harness, "claude_code", claudeKey, 1, 111);
    addConversation(harness, "codex", codexKey, 1, 112);
    await initializePaperRestoreSelections(
      readiness({ claude: true, codex: true }),
    );

    setLastUsedClaudePaperConversationKey(1, 111, claudeKey);
    setLastUsedCodexPaperConversationKey(1, 112, codexKey);
    assert.equal(getLastUsedClaudePaperConversationKey(1, 111), claudeKey);
    assert.equal(getLastUsedCodexPaperConversationKey(1, 112), codexKey);
    await flushPaperRestoreSelectionWrites();
    assert.deepEqual(
      markerKeys(harness),
      [claudeKey, codexKey].sort((a, b) => a - b),
    );

    forgetPaperRestoreTargetsForItem(1, 111);
    assert.isNull(getLastUsedClaudePaperConversationKey(1, 111));
    await flushPaperRestoreSelectionWrites();
    assert.deepEqual(markerKeys(harness), [codexKey]);
  });
});

import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  initChatStore,
  createPaperConversation,
  createGlobalConversation,
  findWebchatSessionPaperConversationKey,
  getPaperConversation,
  listPaperConversations,
  listAllPaperConversationsByLibrary,
  listGlobalConversations,
  touchPaperConversationTitle,
  setPaperConversationTitle,
  appendMessage,
} from "../src/utils/chatStore";
import { resolveWebChatSessionConversation } from "../src/modules/contextPanel/webchatSessionConversation";
import { conversationRepository } from "../src/core/conversations/repository";

const PAPER_TABLE = "llm_for_zotero_paper_conversations";
const GLOBAL_TABLE = "llm_for_zotero_global_conversations";
const MESSAGES_TABLE = "llm_for_zotero_chat_messages";

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
    Libraries: { userLibraryID: 1 },
    Items: { get: () => null },
    DB: {
      queryAsync,
      executeTransaction: async (fn: () => Promise<unknown>) => await fn(),
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

function paperRow(harness: SqliteHarness, conversationKey: number) {
  return harness.all(
    `SELECT conversation_key AS conversationKey,
            COALESCE(webchat_session, 0) AS webchatSession,
            title,
            user_turn_count AS userTurnCount
     FROM ${PAPER_TABLE}
     WHERE conversation_key = ?`,
    [conversationKey],
  )[0];
}

describe("webchat session catalog isolation", function () {
  let harness: SqliteHarness;

  beforeEach(async function () {
    harness = installSqliteZotero();
    await initChatStore();
  });

  afterEach(function () {
    harness.db.close();
    globalScope.Zotero = originalZotero;
  });

  it("flags webchat-created sessions and hides them from every catalog listing", async function () {
    const normal = await createPaperConversation(5, 300);
    assert.ok(normal, "expected normal paper conversation");
    const webchat = await createPaperConversation(5, 300, {
      webchatSession: true,
    });
    assert.ok(webchat, "expected webchat paper conversation");
    assert.notStrictEqual(webchat!.conversationKey, normal!.conversationKey);

    const flagged = paperRow(harness, webchat!.conversationKey);
    assert.strictEqual(flagged.webchatSession, 1);
    assert.strictEqual(
      paperRow(harness, normal!.conversationKey).webchatSession,
      0,
    );

    const perPaper = await listPaperConversations(5, 300, 50, true);
    assert.deepEqual(
      perPaper.map((row) => row.conversationKey),
      [normal!.conversationKey],
      "per-paper listing must exclude the webchat session",
    );

    const perLibrary = await listAllPaperConversationsByLibrary(5, null);
    assert.isFalse(
      perLibrary.some(
        (row) => row.conversationKey === webchat!.conversationKey,
      ),
      "library-wide listing must exclude the webchat session",
    );

    const byKey = await getPaperConversation(webchat!.conversationKey);
    assert.ok(
      byKey,
      "direct lookup by key must still resolve the webchat session row",
    );
  });

  it("flags webchat-created global sessions and hides them from the global listing", async function () {
    const normalKey = await createGlobalConversation(7);
    assert.isAbove(normalKey, 0);
    const webchatKey = await createGlobalConversation(7, {
      webchatSession: true,
    });
    assert.isAbove(webchatKey, 0);

    const listed = await listGlobalConversations(7, null, true);
    const listedKeys = listed.map((row) => row.conversationKey);
    assert.include(listedKeys, normalKey);
    assert.notInclude(
      listedKeys,
      webchatKey,
      "global listing must exclude the webchat session",
    );
  });

  it("never lets automatic title touches claim a webchat session row", async function () {
    const webchat = await createPaperConversation(5, 300, {
      webchatSession: true,
    });
    await touchPaperConversationTitle(
      webchat!.conversationKey,
      "Return exactly ISSUE_7_E2E_BASELINE_20260809.",
    );
    assert.isNull(
      paperRow(harness, webchat!.conversationKey).title,
      "webchat session row must not receive an automatic title",
    );

    const normal = await createPaperConversation(5, 300);
    await touchPaperConversationTitle(normal!.conversationKey, "Real question");
    assert.strictEqual(
      paperRow(harness, normal!.conversationKey).title,
      "Real question",
    );
  });

  it("clears the webchat flag when a real message is persisted into the row", async function () {
    const webchat = await createPaperConversation(5, 300, {
      webchatSession: true,
    });
    await appendMessage(webchat!.conversationKey, {
      role: "user",
      text: "adopted as a normal conversation",
      timestamp: Date.now(),
    });
    assert.strictEqual(
      paperRow(harness, webchat!.conversationKey).webchatSession,
      0,
      "persisting a message must adopt the row as a normal conversation",
    );
    const perPaper = await listPaperConversations(5, 300, 50, true);
    assert.include(
      perPaper.map((row) => row.conversationKey),
      webchat!.conversationKey,
      "adopted row must become visible in listings",
    );
  });

  it("sweeps unadopted webchat session rows at startup and spares adopted ones", async function () {
    const stale = await createPaperConversation(5, 300, {
      webchatSession: true,
    });
    const adopted = await createPaperConversation(5, 300, {
      webchatSession: true,
    });
    await appendMessage(adopted!.conversationKey, {
      role: "user",
      text: "kept",
      timestamp: Date.now(),
    });
    // Simulate an inconsistent row: flagged but carrying persisted messages.
    harness.run(
      `UPDATE ${PAPER_TABLE} SET webchat_session = 1 WHERE conversation_key = ?`,
      [adopted!.conversationKey],
    );
    const staleGlobalKey = await createGlobalConversation(7, {
      webchatSession: true,
    });

    await initChatStore();

    assert.isUndefined(
      paperRow(harness, stale!.conversationKey),
      "unadopted webchat paper session must be deleted at startup",
    );
    const keptRow = paperRow(harness, adopted!.conversationKey);
    assert.ok(keptRow, "adopted conversation must survive the sweep");
    assert.strictEqual(
      keptRow.webchatSession,
      0,
      "sweep must clear the flag on rows that own persisted messages",
    );
    const globalRows = harness.all(
      `SELECT conversation_key FROM ${GLOBAL_TABLE} WHERE conversation_key = ?`,
      [staleGlobalKey],
    );
    assert.lengthOf(
      globalRows,
      0,
      "unadopted webchat global session must be deleted at startup",
    );
  });

  it("clears leaked webchat titles from existing ghost rows exactly once", async function () {
    const ghost = await createPaperConversation(5, 300);
    harness.run(
      `UPDATE ${PAPER_TABLE} SET title = ? WHERE conversation_key = ?`,
      ["Return exactly ISSUE_7_E2E_BASELINE_20260809.", ghost!.conversationKey],
    );
    const real = await createPaperConversation(5, 300);
    await appendMessage(real!.conversationKey, {
      role: "user",
      text: "genuine conversation",
      timestamp: Date.now(),
    });
    await touchPaperConversationTitle(real!.conversationKey, "Kept title");

    // The ghosts in real profiles predate this migration; simulate a store
    // that has never run it.
    harness.run(
      `DELETE FROM llm_for_zotero_conversation_schema_migrations
       WHERE id = 'webchat-ghost-title-cleanup-v1'`,
    );
    await initChatStore();

    assert.isNull(
      paperRow(harness, ghost!.conversationKey).title,
      "message-less titled ghost must lose its leaked title",
    );
    assert.ok(
      paperRow(harness, ghost!.conversationKey),
      "ghost row itself must survive as a blank draft",
    );
    assert.strictEqual(
      paperRow(harness, real!.conversationKey).title,
      "Kept title",
      "conversations with persisted messages keep their titles",
    );

    // One-time semantics: a titled empty draft created after the migration ran
    // (e.g. the user renames a draft) must not be stripped by later startups.
    const renamedDraft = await createPaperConversation(5, 300);
    harness.run(
      `UPDATE ${PAPER_TABLE} SET title = ? WHERE conversation_key = ?`,
      ["My renamed draft", renamedDraft!.conversationKey],
    );
    await initChatStore();
    assert.strictEqual(
      paperRow(harness, renamedDraft!.conversationKey).title,
      "My renamed draft",
      "ghost-title cleanup must run exactly once",
    );
  });

  it("resolves webchat sessions by reusing the paper's flagged row and never claims user drafts", async function () {
    const userDraft = await createPaperConversation(5, 300);

    const first = await resolveWebChatSessionConversation({
      libraryID: 5,
      paperItemID: 300,
    });
    assert.isAbove(first.conversationKey, 0);
    assert.isFalse(first.reused, "first webchat entry creates a fresh row");
    assert.notStrictEqual(
      first.conversationKey,
      userDraft!.conversationKey,
      "webchat entry must never claim the user's blank draft",
    );
    assert.strictEqual(
      paperRow(harness, first.conversationKey).webchatSession,
      1,
    );

    const second = await resolveWebChatSessionConversation({
      libraryID: 5,
      paperItemID: 300,
    });
    assert.strictEqual(
      second.conversationKey,
      first.conversationKey,
      "re-entering webchat mode reuses the existing flagged row",
    );
    assert.isTrue(second.reused);

    assert.strictEqual(
      await findWebchatSessionPaperConversationKey(5, 300),
      first.conversationKey,
    );
    assert.strictEqual(
      paperRow(harness, userDraft!.conversationKey).webchatSession,
      0,
      "user draft stays a normal draft",
    );
  });

  it("coalesces concurrent webchat session resolutions into one row", async function () {
    const [first, second] = await Promise.all([
      resolveWebChatSessionConversation({ libraryID: 5, paperItemID: 300 }),
      resolveWebChatSessionConversation({ libraryID: 5, paperItemID: 300 }),
    ]);
    assert.ok(first && second);
    assert.strictEqual(
      first!.conversationKey,
      second!.conversationKey,
      "racing mode entries must share one session row",
    );
    const flaggedRows = harness.all(
      `SELECT conversation_key FROM ${PAPER_TABLE}
       WHERE paper_item_id = 300 AND COALESCE(webchat_session, 0) = 1`,
    );
    assert.lengthOf(flaggedRows, 1, "exactly one flagged row may exist");
  });

  it("blocks explicit renames from titling a webchat session row", async function () {
    const webchat = await createPaperConversation(5, 300, {
      webchatSession: true,
    });
    await setPaperConversationTitle(webchat!.conversationKey, "Renamed");
    assert.isNull(
      paperRow(harness, webchat!.conversationKey).title,
      "rename path must not title a hidden webchat row",
    );
  });

  it("excludes flagged rows from the library-wide paper listing even with a corrupted turn count", async function () {
    const webchat = await createPaperConversation(5, 300, {
      webchatSession: true,
    });
    harness.run(
      `UPDATE ${PAPER_TABLE} SET user_turn_count = 3 WHERE conversation_key = ?`,
      [webchat!.conversationKey],
    );
    const listed = await listAllPaperConversationsByLibrary(5, null);
    assert.isFalse(
      listed.some((row) => row.conversationKey === webchat!.conversationKey),
      "flag exclusion must not depend on the turn-count coupling",
    );
  });

  it("exposes the webchat flag on by-key summaries for switch-time guards", async function () {
    const webchat = await createPaperConversation(5, 300, {
      webchatSession: true,
    });
    const normal = await createPaperConversation(5, 300);
    assert.isTrue(
      (await getPaperConversation(webchat!.conversationKey))?.webchatSession ===
        true,
    );
    assert.notOk(
      (await getPaperConversation(normal!.conversationKey))?.webchatSession,
    );
  });

  it("keeps webchat sessions out of repository catalog listings used by draft reuse", async function () {
    const webchat = await createPaperConversation(5, 300, {
      webchatSession: true,
    });
    const entries = await conversationRepository.listCatalogEntries({
      system: "upstream",
      kind: "paper",
      libraryID: 5,
      paperItemID: 300,
      limit: 50,
      includeEmpty: true,
    });
    assert.isFalse(
      entries.some(
        (entry) => entry.conversationKey === webchat!.conversationKey,
      ),
      "repository listings feeding draft reuse must exclude webchat sessions",
    );
  });
});

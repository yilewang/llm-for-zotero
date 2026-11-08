import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  initPlanDocumentStore,
  loadDocumentIdForMessageOwner,
  loadDocumentIdsForMessageOwners,
  PLAN_DOCUMENT_OWNERS_TABLE,
} from "../src/agent/documents/store";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

describe("loadDocumentIdsForMessageOwners", function () {
  let originalZotero: unknown;
  let db: DatabaseSync;

  beforeEach(async function () {
    originalZotero = globalScope.Zotero;
    db = new DatabaseSync(":memory:");
    const bindable = (params: unknown[] | undefined) =>
      (params || []).map((value) => (value === undefined ? null : value));
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          const statement = db.prepare(sql);
          const head = sql.trimStart().toUpperCase();
          if (
            head.startsWith("SELECT") ||
            head.startsWith("PRAGMA") ||
            head.startsWith("WITH")
          ) {
            return statement.all(...(bindable(params) as never[]));
          }
          statement.run(...(bindable(params) as never[]));
          return [];
        },
        executeTransaction: async (task: () => Promise<unknown>) => task(),
      },
    } as unknown as typeof Zotero;
    await initPlanDocumentStore();
  });

  afterEach(function () {
    globalScope.Zotero = originalZotero;
    db.close();
  });

  it("returns what the single lookup returns for every timestamp", async function () {
    const insert = db.prepare(
      `INSERT INTO ${PLAN_DOCUMENT_OWNERS_TABLE} VALUES (?, ?, ?)`,
    );
    insert.run("doc-a", 7, 100);
    insert.run("doc-c", 7, 100);
    insert.run("doc-b", 7, 100);
    insert.run("doc-d", 7, 200);
    insert.run("doc-z", 8, 300);
    insert.run("doc-y", 7, 400);

    const timestamps = [100, 200, 300, 400, 500];
    const batch = await loadDocumentIdsForMessageOwners({
      conversationKey: 7,
      sourceMessageTimestamps: timestamps,
    });
    for (const timestamp of timestamps) {
      const single = await loadDocumentIdForMessageOwner({
        conversationKey: 7,
        sourceMessageTimestamp: timestamp,
      });
      assert.equal(batch.get(timestamp) ?? null, single, `at ${timestamp}`);
    }
    assert.deepEqual(Array.from(batch.entries()).sort(), [
      [100, "doc-c"],
      [200, "doc-d"],
      [400, "doc-y"],
    ]);
  });

  it("does not query when no timestamp is asked for", async function () {
    globalScope.Zotero = {
      DB: {
        queryAsync: async () => {
          throw new Error("no query expected");
        },
      },
    } as unknown as typeof Zotero;
    const batch = await loadDocumentIdsForMessageOwners({
      conversationKey: 7,
      sourceMessageTimestamps: [],
    });
    assert.equal(batch.size, 0);
  });
});

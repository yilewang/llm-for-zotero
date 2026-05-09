import { assert } from "chai";
import { reconcileConversationCatalogs } from "../src/utils/chatStore";

describe("chatStore conversation catalog reconciliation", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  it("backfills missing global and legacy paper conversation rows", async function () {
    const inserts: Array<{ sql: string; params: unknown[] }> = [];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Libraries: {
        userLibraryID: 1,
      },
      Items: {
        get: (itemID: number) => {
          if (itemID === 321) {
            return {
              id: 321,
              libraryID: 5,
              isRegularItem: () => true,
            };
          }
          return null;
        },
      },
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          const normalizedParams = Array.isArray(params) ? params : [];
          if (
            sql.includes("FROM llm_for_zotero_chat_messages m") &&
            sql.includes("LEFT JOIN llm_for_zotero_global_conversations gc")
          ) {
            return [
              {
                conversationKey: 2_000_000_123,
                createdAt: 1000,
                title: "Recovered global title",
              },
            ];
          }
          if (
            sql.includes("FROM llm_for_zotero_chat_messages m") &&
            sql.includes("LEFT JOIN llm_for_zotero_paper_conversations pc")
          ) {
            return [
              {
                conversationKey: 321,
                createdAt: 2000,
                title: "Recovered paper title",
              },
            ];
          }
          if (
            sql.includes(
              "INSERT OR IGNORE INTO llm_for_zotero_global_conversations",
            )
          ) {
            inserts.push({ sql, params: normalizedParams });
            return [];
          }
          if (
            sql.includes(
              "INSERT OR IGNORE INTO llm_for_zotero_paper_conversations",
            )
          ) {
            inserts.push({ sql, params: normalizedParams });
            return [];
          }
          return [];
        },
      },
    };

    await reconcileConversationCatalogs();

    assert.lengthOf(inserts, 2);
    assert.deepInclude(inserts, {
      sql: inserts[0]!.sql,
      params: [2_000_000_123, 1, 1000, "Recovered global title"],
    });
    assert.deepInclude(inserts, {
      sql: inserts[1]!.sql,
      params: [321, 5, 321, 2000, "Recovered paper title"],
    });
  });
});

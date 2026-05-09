import { assert } from "chai";
import { loadConversationHistoryScope } from "../src/modules/contextPanel/historyLoader";

describe("historyLoader", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  it("loads normalized open-chat history rows including drafts", async function () {
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string) => {
          if (sql.includes("FROM llm_for_zotero_global_conversations gc")) {
            return [
              {
                conversationKey: 2_000_000_001,
                libraryID: 1,
                createdAt: 100,
                title: "First chat",
                lastActivityAt: 300,
                userTurnCount: 2,
              },
              {
                conversationKey: 2_000_000_002,
                libraryID: 1,
                createdAt: 400,
                title: "",
                lastActivityAt: 400,
                userTurnCount: 0,
              },
            ];
          }
          return [];
        },
      },
    };

    const rows = await loadConversationHistoryScope({
      mode: "open",
      libraryID: 1,
      limit: 20,
    });

    assert.deepEqual(rows, [
      {
        mode: "open",
        conversationKey: 2_000_000_001,
        title: "First chat",
        createdAt: 100,
        lastActivityAt: 300,
        userTurnCount: 2,
        isDraft: false,
      },
      {
        mode: "open",
        conversationKey: 2_000_000_002,
        title: "New chat",
        createdAt: 400,
        lastActivityAt: 400,
        userTurnCount: 0,
        isDraft: true,
      },
    ]);
  });

  it("loads normalized paper-chat history rows", async function () {
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          const normalizedParams = Array.isArray(params) ? params : [];
          if (
            sql.includes(
              "INSERT OR IGNORE INTO llm_for_zotero_paper_conversations",
            )
          ) {
            return [];
          }
          if (
            sql.includes("FROM llm_for_zotero_paper_conversations pc") &&
            sql.includes("WHERE pc.conversation_key = ?")
          ) {
            return [
              {
                conversationKey: 321,
                libraryID: normalizedParams[0] === 321 ? 3 : 0,
                paperItemID: 321,
                sessionVersion: 1,
                createdAt: 200,
                title: "",
                lastActivityAt: 200,
                userTurnCount: 0,
              },
            ];
          }
          if (
            sql.includes("FROM llm_for_zotero_paper_conversations pc") &&
            sql.includes("WHERE pc.library_id = ?")
          ) {
            return [
              {
                conversationKey: 321,
                libraryID: 3,
                paperItemID: 321,
                sessionVersion: 1,
                createdAt: 200,
                title: "Paper thread",
                lastActivityAt: 250,
                userTurnCount: 1,
              },
            ];
          }
          return [];
        },
      },
    };

    const rows = await loadConversationHistoryScope({
      mode: "paper",
      libraryID: 3,
      paperItemID: 321,
      limit: 20,
    });

    assert.deepEqual(rows, [
      {
        mode: "paper",
        conversationKey: 321,
        title: "Paper thread",
        createdAt: 200,
        lastActivityAt: 250,
        userTurnCount: 1,
        isDraft: false,
        sessionVersion: 1,
        paperItemID: 321,
      },
    ]);
  });
});

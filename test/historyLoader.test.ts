import { assert } from "chai";
import { loadConversationHistoryScope } from "../src/modules/contextPanel/historyLoader";
import {
  createGlobalConversation,
  getLatestEmptyGlobalConversation,
  listGlobalConversations,
} from "../src/utils/chatStore";

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

  it("creates a fresh global draft instead of reusing an older empty draft", async function () {
    const conversations = [
      {
        conversationKey: 2_000_000_001,
        libraryID: 1,
        createdAt: 100,
        title: "",
      },
    ];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        executeTransaction: async (fn: () => Promise<number>) => fn(),
        queryAsync: async (sql: string, params?: unknown[]) => {
          const normalizedParams = Array.isArray(params) ? params : [];
          if (
            sql.includes("SELECT MAX(conversation_key)") &&
            sql.includes("FROM llm_for_zotero_global_conversations")
          ) {
            return [
              {
                maxConversationKey: Math.max(
                  ...conversations.map((row) => row.conversationKey),
                ),
              },
            ];
          }
          if (
            sql.includes("INSERT INTO llm_for_zotero_global_conversations")
          ) {
            conversations.push({
              conversationKey: Number(normalizedParams[0]),
              libraryID: Number(normalizedParams[1]),
              createdAt: Number(normalizedParams[2]),
              title: "",
            });
            return [];
          }
          if (
            sql.includes("FROM llm_for_zotero_global_conversations gc") &&
            sql.includes("HAVING SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) = 0")
          ) {
            return conversations
              .filter((row) => row.libraryID === Number(normalizedParams[0]))
              .sort((a, b) => b.createdAt - a.createdAt)
              .slice(0, 1)
              .map((row) => ({
                conversationKey: row.conversationKey,
                libraryID: row.libraryID,
                createdAt: row.createdAt,
                title: row.title,
                lastActivityAt: row.createdAt,
                userTurnCount: 0,
              }));
          }
          if (sql.includes("FROM llm_for_zotero_global_conversations gc")) {
            return conversations
              .filter((row) => row.libraryID === Number(normalizedParams[0]))
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((row) => ({
                conversationKey: row.conversationKey,
                libraryID: row.libraryID,
                createdAt: row.createdAt,
                title: row.title,
                lastActivityAt: row.createdAt,
                userTurnCount: 0,
              }));
          }
          return [];
        },
      },
    };

    const oldDraft = await getLatestEmptyGlobalConversation(1);
    const newKey = await createGlobalConversation(1);
    const rows = await listGlobalConversations(1, 10, true);

    assert.equal(oldDraft?.conversationKey, 2_000_000_001);
    assert.isAbove(newKey, 2_000_000_001);
    assert.equal(rows[0]?.conversationKey, newKey);
  });
});

import { assert } from "chai";
import * as upstream from "../src/utils/chatStore";
import * as claude from "../src/claudeCode/store";
import * as codex from "../src/codexAppServer/store";
import type { StoredChatMessage } from "../src/utils/chatStore";
import {
  installSqliteZotero,
  resetConversationStoreProcessStateForTests,
  type SqliteHarness,
} from "./helpers/conversationStoreDb";

/**
 * Clearing a conversation drops its indexed body inside the clear
 * transaction.  The refresh after the commit is best-effort (it logs and
 * swallows a failure), so it alone cannot keep cleared text out of history
 * search.
 */
describe("clearing a conversation removes its text from the search index", function () {
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

  function indexedBodies(system: string, key: number): string[] {
    return harness
      .all(
        `SELECT body_text AS body FROM llm_for_zotero_conversation_search_index
         WHERE system = ? AND legacy_conversation_key = ?`,
        [system, key],
      )
      .map((row) => String(row.body));
  }

  /** Make every later search-index write fail, as a busy database would. */
  function failSearchIndexWrites(): void {
    const db = globalScope.Zotero!.DB as {
      queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
    };
    const real = db.queryAsync;
    db.queryAsync = async (sql, params) => {
      if (
        /^INSERT OR REPLACE INTO llm_for_zotero_conversation_search_index/.test(
          sql.trimStart(),
        )
      ) {
        throw new Error("simulated search-index failure");
      }
      return real(sql, params);
    };
  }

  const stores = [
    {
      system: "upstream",
      init: () => upstream.initChatStore(),
      create: async () => upstream.createGlobalConversation(1),
      append: (key: number, message: StoredChatMessage) =>
        upstream.appendMessage(key, message),
      clear: (key: number) => upstream.clearConversation(key),
    },
    {
      system: "claude_code",
      init: () => claude.initClaudeCodeStore(),
      create: async () =>
        (await claude.createClaudeGlobalConversation(1))!.conversationKey,
      append: (key: number, message: StoredChatMessage) =>
        claude.appendClaudeMessage(key, message),
      clear: (key: number) => claude.clearClaudeConversation(key),
    },
    {
      system: "codex",
      init: () => codex.initCodexAppServerStore(),
      create: async () =>
        (await codex.createCodexGlobalConversation(1))!.conversationKey,
      append: (key: number, message: StoredChatMessage) =>
        codex.appendCodexMessage(key, message),
      clear: (key: number) => codex.clearCodexConversation(key),
    },
  ];

  for (const store of stores) {
    it(`${store.system}: a failed refresh after the clear leaves no cleared text`, async function () {
      await store.init();
      const key = await store.create();
      await store.append(key, {
        role: "user",
        text: "zebra-secret question",
        timestamp: 1_000,
      } as StoredChatMessage);
      await store.append(key, {
        role: "assistant",
        text: "zebra-secret answer",
        timestamp: 2_000,
      } as StoredChatMessage);
      assert.isTrue(
        indexedBodies(store.system, key).some((body) =>
          body.includes("zebra-secret"),
        ),
        "the text is searchable before the clear",
      );
      failSearchIndexWrites();
      await store.clear(key);
      assert.lengthOf(
        harness.all(
          `SELECT 1 FROM ${
            store.system === "upstream"
              ? "llm_for_zotero_chat_messages"
              : store.system === "claude_code"
                ? "llm_for_zotero_claude_messages"
                : "llm_for_zotero_codex_messages"
          } WHERE conversation_key = ?`,
          [key],
        ),
        0,
        "the clear deleted the messages",
      );
      assert.isFalse(
        indexedBodies(store.system, key).some((body) =>
          body.includes("zebra-secret"),
        ),
        "the cleared text is no longer searchable",
      );
    });
  }
});

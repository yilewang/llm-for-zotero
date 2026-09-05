import { assert } from "chai";

import {
  appendMessage,
  loadConversation,
  updateLatestAssistantMessage,
} from "../src/utils/chatStore";
import {
  appendCodexMessage,
  updateLatestCodexAssistantMessage,
} from "../src/codexAppServer/store";
import {
  appendClaudeMessage,
  updateLatestClaudeAssistantMessage,
} from "../src/claudeCode/store";
import {
  CLAUDE_GLOBAL_CONVERSATION_KEY_BASE,
  CODEX_GLOBAL_CONVERSATION_KEY_BASE,
} from "../src/shared/conversationKeySpace";

/**
 * A streamed reply cut off mid-flight keeps its partial text and an
 * `interrupted` marker. The marker must survive a Zotero restart in every
 * storage system, or the partial answer reads as a complete one after reload.
 */
describe("interrupted flag persistence", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  let originalZotero: Record<string, unknown> | undefined;

  before(function () {
    originalZotero = globalScope.Zotero;
  });

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  function installDbFixture(
    rowsForSelect?: Array<Record<string, unknown>>,
  ): Array<{ sql: string; params: unknown[] }> {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params: Array.isArray(params) ? params : [] });
          // The stored-message projection is the only query aliasing this
          // column; return the fixture rows for it and nothing else.
          if (rowsForSelect && sql.includes("webchat_run_state AS")) {
            return rowsForSelect;
          }
          return [];
        },
        executeTransaction: async (callback: () => Promise<unknown>) =>
          callback(),
      },
    };
    return queries;
  }

  function findQuery(
    queries: Array<{ sql: string; params: unknown[] }>,
    fragment: string,
  ): { sql: string; params: unknown[] } {
    const query = queries.find(({ sql }) => sql.includes(fragment));
    assert.isOk(query, `expected query containing ${fragment}`);
    return query as { sql: string; params: unknown[] };
  }

  it("appendMessage stores interrupted=1 for an interrupted assistant reply", async function () {
    const queries = installDbFixture();

    await appendMessage(42, {
      role: "assistant",
      text: "Partial answer that streamed before the drop.",
      timestamp: 100,
      interrupted: true,
    });

    const insert = findQuery(
      queries,
      "INSERT INTO llm_for_zotero_chat_messages",
    );
    assert.include(insert.sql, "interrupted");
    assert.include(insert.params, 1);
  });

  it("updateLatestAssistantMessage writes the flag and clears it when absent", async function () {
    const queries = installDbFixture();

    await updateLatestAssistantMessage(42, {
      text: "Partial answer.",
      timestamp: 200,
      interrupted: true,
    });
    await updateLatestAssistantMessage(42, {
      text: "Full answer.",
      timestamp: 300,
    });

    const updates = queries.filter(
      ({ sql }) =>
        sql.includes("UPDATE llm_for_zotero_chat_messages") &&
        sql.includes("interrupted = ?"),
    );
    assert.lengthOf(updates, 2);
    assert.include(updates[0]!.params, 1);
    assert.notInclude(updates[1]!.params, 1);
  });

  it("loadConversation hydrates interrupted back as a boolean", async function () {
    installDbFixture([
      {
        role: "assistant",
        text: "Partial answer.",
        timestamp: 100,
        interrupted: 1,
      },
      {
        role: "assistant",
        text: "Complete answer.",
        timestamp: 200,
        interrupted: null,
      },
    ]);

    const messages = await loadConversation(42);

    assert.lengthOf(messages, 2);
    const interrupted = messages.find((m) => m.text === "Partial answer.");
    const complete = messages.find((m) => m.text === "Complete answer.");
    assert.isTrue(interrupted?.interrupted);
    assert.isUndefined(complete?.interrupted);
  });

  it("claude store round-trips the flag through insert and update", async function () {
    const queries = installDbFixture();
    const key = CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 1;

    await appendClaudeMessage(key, {
      role: "assistant",
      text: "Partial.",
      timestamp: 100,
      interrupted: true,
    });
    await updateLatestClaudeAssistantMessage(key, {
      text: "Partial.",
      timestamp: 100,
      interrupted: true,
    });

    const insert = findQuery(queries, "INSERT INTO");
    assert.include(insert.sql, "interrupted");
    assert.include(insert.params, 1);
    const update = findQuery(queries, "interrupted = ?");
    assert.include(update.params, 1);
  });

  it("codex store round-trips the flag through insert and update", async function () {
    const queries = installDbFixture();
    const key = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 1;

    await appendCodexMessage(key, {
      role: "assistant",
      text: "Partial.",
      timestamp: 100,
      interrupted: true,
    });
    await updateLatestCodexAssistantMessage(key, {
      text: "Partial.",
      timestamp: 100,
      interrupted: true,
    });

    const insert = findQuery(queries, "INSERT INTO");
    assert.include(insert.sql, "interrupted");
    assert.include(insert.params, 1);
    const update = findQuery(queries, "interrupted = ?");
    assert.include(update.params, 1);
  });
});

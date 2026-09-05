import { assert } from "chai";
import {
  appendMessage,
  loadConversation,
  updateLatestUserMessage,
} from "../src/utils/chatStore";
import {
  appendClaudeMessage,
  loadClaudeConversation,
  updateLatestClaudeUserMessage,
} from "../src/claudeCode/store";
import {
  appendCodexMessage,
  loadCodexConversation,
  updateLatestCodexUserMessage,
} from "../src/codexAppServer/store";
import {
  CLAUDE_GLOBAL_CONVERSATION_KEY_BASE,
  CODEX_GLOBAL_CONVERSATION_KEY_BASE,
} from "../src/shared/conversationKeySpace";
import type {
  CollectionContextRef,
  SelectedTextContext,
  TagContextRef,
} from "../src/shared/types";

type RecordedQuery = { sql: string; params: unknown[] };

const canonicalContext: SelectedTextContext = {
  text: "Stable highlighted quote",
  source: "pdf",
  contextItemId: 902,
  pageIndex: 587,
  pageLabel: "588",
};
const collectionContext: CollectionContextRef = {
  collectionId: 55,
  libraryID: 1,
  name: "Methods",
};
const tagContext: TagContextRef = {
  libraryID: 1,
  name: "Stability",
  normalizedName: "stability",
  includeAutomatic: false,
};
const storedCollectionContext: CollectionContextRef = {
  collectionId: 55,
  name: "Methods",
  libraryID: 1,
};
const storedTagContext: TagContextRef = {
  name: "Stability",
  libraryID: 1,
  normalizedName: "stability",
  scope: undefined,
  includeAutomatic: false,
};

function installRecordingDb(
  rowForTable?: (sql: string) => Record<string, unknown>[] | undefined,
): RecordedQuery[] {
  const queries: RecordedQuery[] = [];
  (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
    DB: {
      queryAsync: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params: Array.isArray(params) ? params : [] });
        return rowForTable?.(sql) || [];
      },
      executeTransaction: async (callback: () => Promise<unknown>) =>
        callback(),
    },
  } as unknown as typeof Zotero;
  return queries;
}

function findQuery(queries: RecordedQuery[], text: string): RecordedQuery {
  const query = queries.find((entry) => entry.sql.includes(text));
  assert.isOk(query, `expected query containing ${text}`);
  return query as RecordedQuery;
}

describe("selected text context message stores", function () {
  let originalZotero: unknown;

  before(function () {
    originalZotero = (globalThis as typeof globalThis & { Zotero?: unknown })
      .Zotero;
  });

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  it("writes canonical JSON in the standard, Claude, and Codex stores", async function () {
    const queries = installRecordingDb();
    const message = {
      role: "user" as const,
      text: "Explain this",
      timestamp: 100,
      selectedTextContexts: [canonicalContext],
      // Compatibility fields deliberately conflict; canonical wins.
      selectedTexts: ["Legacy quote"],
      selectedTextSources: ["note" as const],
    };

    await appendMessage(42, message);
    await appendClaudeMessage(CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 1, message);
    await appendCodexMessage(CODEX_GLOBAL_CONVERSATION_KEY_BASE + 1, message);

    for (const table of [
      "llm_for_zotero_chat_messages",
      "llm_for_zotero_claude_messages",
      "llm_for_zotero_codex_messages",
    ]) {
      const insert = findQuery(queries, `INSERT INTO ${table}`);
      assert.include(insert.sql, "selected_text_contexts_json");
      assert.include(insert.params, JSON.stringify([canonicalContext]));
      assert.include(insert.params, JSON.stringify([canonicalContext.text]));
      assert.notInclude(insert.params, JSON.stringify(["Legacy quote"]));
    }
  });

  it("writes collection and tag context in every message store", async function () {
    const queries = installRecordingDb();
    const message = {
      role: "user" as const,
      text: "Compare this scope",
      timestamp: 100,
      selectedCollectionContexts: [collectionContext],
      selectedTagContexts: [tagContext],
    };

    await appendMessage(42, message);
    await appendClaudeMessage(CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 1, message);
    await appendCodexMessage(CODEX_GLOBAL_CONVERSATION_KEY_BASE + 1, message);

    for (const table of [
      "llm_for_zotero_chat_messages",
      "llm_for_zotero_claude_messages",
      "llm_for_zotero_codex_messages",
    ]) {
      const insert = findQuery(queries, `INSERT INTO ${table}`);
      assert.include(insert.sql, "collection_contexts_json");
      assert.include(insert.sql, "tag_contexts_json");
      assert.equal(insert.sql.match(/\?/g)?.length || 0, insert.params.length);
      assert.include(insert.params, JSON.stringify([storedCollectionContext]));
      assert.include(insert.params, JSON.stringify([storedTagContext]));
    }
  });

  it("loads canonical JSON as the source of truth in every store", async function () {
    installRecordingDb((sql) => {
      if (!sql.includes("ORDER BY timestamp ASC")) return undefined;
      return [
        {
          role: "user",
          text: "Explain this",
          timestamp: 100,
          selectedText: "Legacy quote",
          selectedTextContextsJson: JSON.stringify([canonicalContext]),
          selectedTextsJson: JSON.stringify(["Legacy quote"]),
          selectedTextSourcesJson: JSON.stringify(["note"]),
        },
      ];
    });

    const standard = await loadConversation(42, 20);
    const claude = await loadClaudeConversation(
      CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 1,
      20,
    );
    const codex = await loadCodexConversation(
      CODEX_GLOBAL_CONVERSATION_KEY_BASE + 1,
      20,
    );

    for (const messages of [standard, claude, codex]) {
      assert.deepInclude(
        messages[0]?.selectedTextContexts?.[0] || {},
        canonicalContext,
      );
      assert.deepEqual(messages[0]?.selectedTexts, [canonicalContext.text]);
      assert.deepEqual(messages[0]?.selectedTextSources, ["pdf"]);
    }
  });

  it("loads collection and tag context from every message store", async function () {
    installRecordingDb((sql) => {
      if (!sql.includes("ORDER BY timestamp ASC")) return undefined;
      return [
        {
          role: "user",
          text: "Compare this scope",
          timestamp: 100,
          collectionContextsJson: JSON.stringify([collectionContext]),
          tagContextsJson: JSON.stringify([tagContext]),
        },
      ];
    });

    const standard = await loadConversation(42, 20);
    const claude = await loadClaudeConversation(
      CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 1,
      20,
    );
    const codex = await loadCodexConversation(
      CODEX_GLOBAL_CONVERSATION_KEY_BASE + 1,
      20,
    );

    for (const messages of [standard, claude, codex]) {
      assert.deepEqual(messages[0]?.selectedCollectionContexts, [
        storedCollectionContext,
      ]);
      assert.deepEqual(messages[0]?.selectedTagContexts, [storedTagContext]);
    }
  });

  it("reconstructs canonical contexts from legacy rows", async function () {
    installRecordingDb((sql) => {
      if (
        !sql.includes("llm_for_zotero_chat_messages") ||
        !sql.includes("ORDER BY timestamp ASC")
      ) {
        return undefined;
      }
      return [
        {
          role: "user",
          text: "Explain this",
          timestamp: 100,
          selectedTextsJson: JSON.stringify(["Legacy PDF quote"]),
          selectedTextSourcesJson: JSON.stringify(["pdf"]),
          selectedTextPaperContextsJson: JSON.stringify([
            { itemId: 9, contextItemId: 10, title: "Legacy paper" },
          ]),
        },
      ];
    });

    const messages = await loadConversation(42, 20);

    const context = messages[0]?.selectedTextContexts?.[0];
    assert.equal(context?.text, "Legacy PDF quote");
    assert.equal(context?.source, "pdf");
    assert.equal(context?.contextItemId, 10);
    assert.deepInclude(context?.paperContext || {}, {
      itemId: 9,
      contextItemId: 10,
      title: "Legacy paper",
    });
  });

  it("updates canonical JSON in all three stores", async function () {
    const queries = installRecordingDb();
    const update = {
      text: "Edited question",
      timestamp: 200,
      selectedTextContexts: [canonicalContext],
    };

    await updateLatestUserMessage(42, update);
    await updateLatestClaudeUserMessage(
      CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 1,
      update,
    );
    await updateLatestCodexUserMessage(
      CODEX_GLOBAL_CONVERSATION_KEY_BASE + 1,
      update,
    );

    for (const table of [
      "llm_for_zotero_chat_messages",
      "llm_for_zotero_claude_messages",
      "llm_for_zotero_codex_messages",
    ]) {
      const query = findQuery(queries, `UPDATE ${table}`);
      assert.include(query.sql, "selected_text_contexts_json = ?");
      assert.include(query.params, JSON.stringify([canonicalContext]));
    }
  });

  it("updates collection and tag context in every message store", async function () {
    const queries = installRecordingDb();
    const update = {
      text: "Edited scope",
      timestamp: 200,
      selectedCollectionContexts: [collectionContext],
      selectedTagContexts: [tagContext],
    };

    await updateLatestUserMessage(42, update);
    await updateLatestClaudeUserMessage(
      CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 1,
      update,
    );
    await updateLatestCodexUserMessage(
      CODEX_GLOBAL_CONVERSATION_KEY_BASE + 1,
      update,
    );

    for (const table of [
      "llm_for_zotero_chat_messages",
      "llm_for_zotero_claude_messages",
      "llm_for_zotero_codex_messages",
    ]) {
      const query = findQuery(queries, `UPDATE ${table}`);
      assert.include(query.sql, "collection_contexts_json = ?");
      assert.include(query.sql, "tag_contexts_json = ?");
      assert.include(query.params, JSON.stringify([storedCollectionContext]));
      assert.include(query.params, JSON.stringify([storedTagContext]));
    }
  });
});

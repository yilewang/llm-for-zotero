import { assert } from "chai";
import { appendMessage, loadConversation } from "../src/utils/chatStore";
import {
  appendCodexMessage,
  loadCodexConversation,
} from "../src/codexAppServer/store";
import { CODEX_GLOBAL_CONVERSATION_KEY_BASE } from "../src/shared/conversationKeySpace";
import { buildConversationID } from "../src/shared/conversationRegistry";

describe("chatStore note contexts", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  function findChatMessageInsert(
    queries: Array<{ sql: string; params: unknown[] }>,
  ): { sql: string; params: unknown[] } {
    const query = queries.find(({ sql }) =>
      sql.includes("INSERT INTO llm_for_zotero_chat_messages"),
    );
    assert.isOk(query, "expected chat message insert query");
    return query as { sql: string; params: unknown[] };
  }

  function installAppendMessageDbFixture(): Array<{
    sql: string;
    params: unknown[];
  }> {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params: Array.isArray(params) ? params : [] });
          return [];
        },
        executeTransaction: async (callback: () => Promise<unknown>) =>
          callback(),
      },
    };
    return queries;
  }

  it("persists selectedTextNoteContexts when appending a message", async function () {
    const queries = installAppendMessageDbFixture();

    await appendMessage(42, {
      role: "user",
      text: "Summarize this note",
      timestamp: 100,
      selectedTexts: ["Updated note body"],
      selectedTextSources: ["note"],
      selectedTextNoteContexts: [
        {
          libraryID: 1,
          noteItemKey: "ABCD1234",
          noteKind: "standalone",
          title: "Context note",
        },
      ],
    });

    const insert = findChatMessageInsert(queries);
    assert.include(insert.sql, "selected_text_note_contexts_json");
    assert.include(
      insert.params,
      JSON.stringify([
        {
          libraryID: 1,
          noteItemKey: "ABCD1234",
          noteKind: "standalone",
          title: "Context note",
        },
      ]),
    );
  });

  it("persists context usage fields when appending a message", async function () {
    const queries = installAppendMessageDbFixture();

    await appendMessage(42, {
      role: "assistant",
      text: "Here is the answer",
      timestamp: 100,
      contextTokens: 1234,
      contextWindow: 200000,
    });

    const insert = findChatMessageInsert(queries);
    assert.lengthOf(insert.params, 31);
    assert.equal(insert.params[29], 1234);
    assert.equal(insert.params[30], 200000);
  });

  it("persists an explicit empty model attachment split", async function () {
    const queries = installAppendMessageDbFixture();

    await appendMessage(42, {
      role: "user",
      text: "Read the PDF",
      timestamp: 100,
      attachments: [
        {
          id: "pdf-paper-123-1",
          name: "paper.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
          category: "pdf",
          storedPath: "/tmp/paper.pdf",
        },
      ],
      modelAttachments: [],
    });

    const insert = findChatMessageInsert(queries);
    assert.include(insert.sql, "model_attachments_json");
    assert.include(insert.params, JSON.stringify([]));
  });

  it("persists generated assistant images separately from screenshots", async function () {
    const queries = installAppendMessageDbFixture();

    await appendMessage(42, {
      role: "assistant",
      text: "",
      timestamp: 100,
      generatedImages: [
        {
          id: "img-1",
          label: "result.png",
          path: "/tmp/result.png",
          revisedPrompt: "A concise chart",
        },
      ],
      screenshotImages: ["data:image/png;base64,user-input"],
    });

    const insert = findChatMessageInsert(queries);
    assert.include(insert.sql, "generated_images_json");
    assert.equal(
      insert.params[21],
      JSON.stringify([
        {
          id: "img-1",
          label: "result.png",
          path: "/tmp/result.png",
          revisedPrompt: "A concise chart",
        },
      ]),
    );
    assert.equal(
      insert.params[18],
      JSON.stringify(["data:image/png;base64,user-input"]),
    );
  });

  it("persists and loads Codex generated assistant images", async function () {
    const queries = installAppendMessageDbFixture();
    const conversationKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 1;

    await appendCodexMessage(conversationKey, {
      role: "assistant",
      text: "",
      timestamp: 100,
      generatedImages: [
        {
          id: "codex-img-1",
          path: "/tmp/codex-result.png",
        },
      ],
    });

    const insert = queries.find(({ sql }) =>
      sql.includes("INSERT INTO llm_for_zotero_codex_messages"),
    );
    assert.isOk(insert, "expected Codex message insert query");
    assert.include(insert?.sql || "", "generated_images_json");
    assert.include(
      insert?.params || [],
      JSON.stringify([
        {
          id: "codex-img-1",
          path: "/tmp/codex-result.png",
        },
      ]),
    );

    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string) => {
          if (
            sql.includes("FROM llm_for_zotero_codex_messages") &&
            sql.includes("ORDER BY timestamp ASC")
          ) {
            return [
              {
                role: "assistant",
                text: "",
                timestamp: 100,
                generatedImagesJson: JSON.stringify([
                  {
                    id: "codex-img-1",
                    path: "/tmp/codex-result.png",
                  },
                ]),
              },
            ];
          }
          return [];
        },
      },
    };

    const messages = await loadCodexConversation(conversationKey, 20);

    assert.deepEqual(messages[0]?.generatedImages, [
      {
        id: "codex-img-1",
        path: "/tmp/codex-result.png",
      },
    ]);
  });

  it("persists selected collection and tag contexts when appending a message", async function () {
    const queries = installAppendMessageDbFixture();

    await appendMessage(42, {
      role: "user",
      text: "Compare this folder",
      timestamp: 100,
      selectedCollectionContexts: [
        {
          collectionId: 55,
          name: "Methods",
          libraryID: 1,
        },
      ],
      selectedTagContexts: [
        {
          name: "Stability",
          libraryID: 1,
          normalizedName: "stability",
        },
      ],
    });

    const insert = findChatMessageInsert(queries);
    assert.include(insert.sql, "collection_contexts_json");
    assert.include(insert.sql, "tag_contexts_json");
    assert.equal(
      insert.params[16],
      JSON.stringify([
        {
          collectionId: 55,
          name: "Methods",
          libraryID: 1,
        },
      ]),
    );
    assert.equal(
      insert.params[17],
      JSON.stringify([
        {
          name: "Stability",
          libraryID: 1,
          normalizedName: "stability",
          includeAutomatic: false,
        },
      ]),
    );
  });

  it("loads selectedTextNoteContexts from stored chat rows", async function () {
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async () => [
          {
            role: "user",
            text: "Summarize this note",
            timestamp: 100,
            selectedTextsJson: JSON.stringify(["Updated note body"]),
            selectedTextSourcesJson: JSON.stringify(["note"]),
            selectedTextNoteContextsJson: JSON.stringify([
              {
                libraryID: 1,
                noteItemKey: "ABCD1234",
                noteKind: "standalone",
                title: "Context note",
              },
            ]),
            collectionContextsJson: JSON.stringify([
              {
                collectionId: 55,
                name: "Methods",
                libraryID: 1,
              },
            ]),
            tagContextsJson: JSON.stringify([
              {
                name: "Stability",
                libraryID: 1,
                normalizedName: "stability",
              },
            ]),
            modelAttachmentsJson: JSON.stringify([]),
            generatedImagesJson: JSON.stringify([
              {
                id: "img-1",
                label: "result.png",
                path: "/tmp/result.png",
              },
            ]),
            contextTokens: 321,
            contextWindow: 64000,
          },
        ],
      },
    };

    const messages = await loadConversation(42, 20);

    assert.lengthOf(messages, 1);
    assert.deepEqual(messages[0]?.selectedTextNoteContexts, [
      {
        libraryID: 1,
        noteItemKey: "ABCD1234",
        noteItemId: undefined,
        parentItemId: undefined,
        parentItemKey: undefined,
        noteKind: "standalone",
        title: "Context note",
      },
    ]);
    assert.deepEqual(messages[0]?.selectedCollectionContexts, [
      {
        collectionId: 55,
        name: "Methods",
        libraryID: 1,
      },
    ]);
    assert.deepEqual(messages[0]?.selectedTagContexts, [
      {
        name: "Stability",
        libraryID: 1,
        normalizedName: "stability",
        scope: undefined,
        includeAutomatic: false,
      },
    ]);
    assert.deepEqual(messages[0]?.modelAttachments, []);
    assert.deepEqual(messages[0]?.generatedImages, [
      {
        id: "img-1",
        label: "result.png",
        path: "/tmp/result.png",
      },
    ]);
    assert.equal(messages[0]?.contextTokens, 321);
    assert.equal(messages[0]?.contextWindow, 64000);
  });

  it("loads registered conversations whose legacy message rows are not backfilled yet", async function () {
    const conversationKey = 42;
    const conversationID = buildConversationID({
      conversationKey,
      system: "upstream",
      kind: "paper",
      libraryID: 1,
      paperItemID: conversationKey,
      profileSignature: "profile-dev",
    });
    let messageQuery = "";
    let messageParams: unknown[] = [];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Profile: {
        dir: "/tmp/llm-for-zotero-test-profile",
      },
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          const queryParams = Array.isArray(params) ? params : [];
          if (
            sql.includes("FROM llm_for_zotero_conversation_registry") &&
            sql.includes("WHERE legacy_conversation_key = ?")
          ) {
            return [
              {
                conversationID,
                conversationKey,
                system: "upstream",
                kind: "paper",
                profileSignature: "profile-dev",
                libraryID: 1,
                paperItemID: conversationKey,
                valid: 1,
              },
            ];
          }
          if (
            sql.includes("FROM llm_for_zotero_chat_messages") &&
            sql.includes("ORDER BY timestamp ASC")
          ) {
            messageQuery = sql;
            messageParams = queryParams;
            return [
              {
                role: "user",
                text: "Legacy body",
                timestamp: 100,
              },
            ];
          }
          return [];
        },
      },
    };

    const messages = await loadConversation(conversationKey, 20);

    assert.lengthOf(messages, 1);
    assert.equal(messages[0]?.text, "Legacy body");
    assert.include(messageQuery, "conversation_id = ?");
    assert.include(messageQuery, "conversation_key = ?");
    assert.deepEqual(messageParams, [conversationID, conversationKey, 20]);
  });

  it("repairs safe stale conversation ids before loading registered conversations", async function () {
    const conversationKey = 42;
    const conversationID = buildConversationID({
      conversationKey,
      system: "upstream",
      kind: "paper",
      libraryID: 1,
      paperItemID: conversationKey,
      profileSignature: "profile-dev",
    });
    const staleConversationID = buildConversationID({
      conversationKey,
      system: "upstream",
      kind: "paper",
      libraryID: 1,
      paperItemID: conversationKey,
      profileSignature: "profile-old",
    });
    let repaired = false;
    let updateParams: unknown[] = [];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Profile: {
        dir: "/tmp/llm-for-zotero-test-profile",
      },
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          const queryParams = Array.isArray(params) ? params : [];
          if (
            sql.includes("FROM llm_for_zotero_conversation_registry") &&
            sql.includes("WHERE legacy_conversation_key = ?")
          ) {
            return [
              {
                conversationID,
                conversationKey,
                system: "upstream",
                kind: "paper",
                profileSignature: "profile-dev",
                libraryID: 1,
                paperItemID: conversationKey,
                valid: 1,
              },
            ];
          }
          if (
            sql.includes("SELECT DISTINCT conversation_id AS conversationID") &&
            sql.includes("FROM llm_for_zotero_chat_messages")
          ) {
            return [{ conversationID: staleConversationID }];
          }
          if (
            sql.includes("paper_contexts_json AS paperContextsJson") &&
            sql.includes("FROM llm_for_zotero_chat_messages") &&
            !sql.includes("ORDER BY timestamp ASC")
          ) {
            return [
              {
                paperContextsJson: JSON.stringify([{ itemId: conversationKey }]),
              },
            ];
          }
          if (
            sql.includes("UPDATE llm_for_zotero_chat_messages") &&
            sql.includes("SET conversation_id = ?")
          ) {
            repaired = true;
            updateParams = queryParams;
            return [];
          }
          if (
            sql.includes("FROM llm_for_zotero_chat_messages") &&
            sql.includes("ORDER BY timestamp ASC")
          ) {
            return repaired
              ? [{ role: "user", text: "Recovered body", timestamp: 100 }]
              : [];
          }
          return [];
        },
      },
    };

    const messages = await loadConversation(conversationKey, 20);

    assert.lengthOf(messages, 1);
    assert.equal(messages[0]?.text, "Recovered body");
    assert.deepEqual(updateParams, [
      conversationID,
      conversationKey,
      staleConversationID,
    ]);
  });
});

import { assert } from "chai";
import { appendMessage, loadConversation } from "../src/utils/chatStore";

describe("chatStore note contexts", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  it("persists selectedTextNoteContexts when appending a message", async function () {
    let capturedQuery = "";
    let capturedParams: unknown[] = [];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          capturedQuery = sql;
          capturedParams = Array.isArray(params) ? params : [];
          return [];
        },
      },
    };

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

    assert.include(capturedQuery, "selected_text_note_contexts_json");
    assert.include(
      capturedParams,
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
  });
});

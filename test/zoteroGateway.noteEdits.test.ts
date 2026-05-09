import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";

describe("ZoteroGateway current note edits", function () {
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  it("accepts note apply when the stored HTML is reserialized but the text is unchanged", async function () {
    let noteHtml = "<div><p>Original body</p></div>";
    let savedHtml = "";
    const noteItem = {
      id: 55,
      libraryID: 1,
      parentID: undefined,
      isNote: () => true,
      getNote: () => noteHtml,
      getDisplayTitle: () => "Draft Note",
      setNote: (html: string) => {
        savedHtml = html;
        noteHtml = html;
      },
      saveTx: async () => {},
    };

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: {
        get: (itemId: number) => (itemId === 55 ? noteItem : null),
      },
    };

    const gateway = new ZoteroGateway();
    const result = await gateway.replaceCurrentNote({
      request: {
        conversationKey: 7,
        mode: "agent",
        userText: "Update the note",
        activeNoteContext: {
          noteId: 55,
          title: "Draft Note",
          noteKind: "standalone",
          noteText: "Original body",
        },
      },
      content: "Updated body",
      expectedOriginalHtml: "<p>Original body</p>",
    });

    assert.equal(result.noteId, 55);
    assert.equal(result.nextText, "Updated body");
    assert.include(savedHtml, "Updated body");
  });
});

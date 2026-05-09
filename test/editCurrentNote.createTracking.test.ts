import { assert } from "chai";
import { createEditCurrentNoteTool } from "../src/agent/tools/write/editCurrentNote";
import { getTrackedAssistantNoteForParent } from "../src/modules/contextPanel/prefHelpers";
import type { AgentToolContext } from "../src/agent/types";

describe("editCurrentNote create tracking", function () {
  const baseContext: AgentToolContext = {
    request: {
      conversationKey: 91,
      mode: "agent",
      userText: "save this note",
      activeItemId: 9,
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
  };

  const globalScope = globalThis as typeof globalThis & {
    Zotero?: {
      Prefs?: {
        get?: (key: string, global?: boolean) => unknown;
        set?: (key: string, value: unknown, global?: boolean) => void;
      };
      Items?: {
        get?: (id: number) => Zotero.Item | null;
      };
      Item?: new (itemType: string) => Zotero.Item;
    };
  };
  const originalZotero = globalScope.Zotero;
  const prefStore = new Map<string, unknown>();
  const savedItems = new Map<number, Zotero.Item>();

  class MockNoteItem {
    id = 0;
    libraryID = 0;
    parentID?: number;
    deleted = false;
    private noteHtml = "";

    constructor(itemType: string) {
      assert.equal(itemType, "note");
    }

    isNote() {
      return true;
    }

    setNote(html: string) {
      this.noteHtml = html;
    }

    getNote() {
      return this.noteHtml;
    }

    getField(_field: string) {
      return "";
    }

    async saveTx() {
      if (!this.id) {
        this.id = 100;
      }
      savedItems.set(this.id, this as unknown as Zotero.Item);
      return this.id;
    }
  }

  beforeEach(function () {
    prefStore.clear();
    savedItems.clear();
    const parentItem = {
      id: 9,
      libraryID: 1,
      isRegularItem: () => true,
    } as unknown as Zotero.Item;
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Prefs: {
        get: (key: string) => prefStore.get(key),
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
      Items: {
        get: (id: number) =>
          savedItems.get(id) || (id === 9 ? parentItem : null),
      },
      Item: MockNoteItem as unknown as new (itemType: string) => Zotero.Item,
    };
  });

  afterEach(function () {
    if (originalZotero) {
      globalScope.Zotero = originalZotero;
      return;
    }
    delete globalScope.Zotero;
  });

  it("remembers manually created HTML notes for future appends", async function () {
    const tool = createEditCurrentNoteTool({
      getItem: (id: number) =>
        id === 9
          ? ({
              id: 9,
              libraryID: 1,
              isRegularItem: () => true,
            } as unknown as Zotero.Item)
          : null,
    } as never);

    const result = await tool.execute(
      {
        mode: "create",
        content: '<div style="color: red">Styled note</div>',
        _isHtml: true,
        target: "item",
      },
      baseContext,
    );
    assert.deepEqual(result, {
      status: "created",
      noteId: 100,
      title: "",
    });

    const tracked = getTrackedAssistantNoteForParent(9);
    assert.equal(tracked?.id, 100);
  });
});

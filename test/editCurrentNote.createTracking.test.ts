import { assert } from "chai";
import { createEditCurrentNoteTool } from "../src/agent/tools/write/editCurrentNote";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { createNoteFromAssistantText } from "../src/modules/contextPanel/notes";
import {
  getTrackedAssistantNoteForParent,
  rememberAssistantNoteForParent,
} from "../src/modules/contextPanel/prefHelpers";
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
    ztoolkit?: {
      log?: (...args: unknown[]) => void;
    };
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
  const originalZtoolkit = globalScope.ztoolkit;
  const prefStore = new Map<string, unknown>();
  const savedItems = new Map<number, Zotero.Item>();
  const parentNoteIds: number[] = [];
  let nextNoteId = 100;
  let parentItem: Zotero.Item;

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
        this.id = nextNoteId++;
      }
      savedItems.set(this.id, this as unknown as Zotero.Item);
      if (this.parentID && !parentNoteIds.includes(this.id)) {
        parentNoteIds.push(this.id);
      }
      return this.id;
    }
  }

  function childNotes(parentId = 9): MockNoteItem[] {
    return Array.from(savedItems.values()).filter(
      (item) => (item as any).isNote?.() && item.parentID === parentId,
    ) as unknown as MockNoteItem[];
  }

  function saveExistingNote(
    id: number,
    parentID: number | undefined,
    html: string,
  ): MockNoteItem {
    const note = new MockNoteItem("note");
    note.id = id;
    note.libraryID = 1;
    note.parentID = parentID;
    note.setNote(html);
    savedItems.set(id, note as unknown as Zotero.Item);
    if (parentID && !parentNoteIds.includes(id)) {
      parentNoteIds.push(id);
    }
    nextNoteId = Math.max(nextNoteId, id + 1);
    return note;
  }

  beforeEach(function () {
    prefStore.clear();
    savedItems.clear();
    parentNoteIds.splice(0);
    nextNoteId = 100;
    parentItem = {
      id: 9,
      libraryID: 1,
      isRegularItem: () => true,
      isAttachment: () => false,
      getNotes: () => [...parentNoteIds],
      getDisplayTitle: () => "Parent Paper",
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
    globalScope.ztoolkit = {
      ...(originalZtoolkit || {}),
      log: () => {},
    };
  });

  afterEach(function () {
    if (originalZtoolkit) {
      globalScope.ztoolkit = originalZtoolkit;
    } else {
      delete globalScope.ztoolkit;
    }
    if (originalZotero) {
      globalScope.Zotero = originalZotero;
      return;
    }
    delete globalScope.Zotero;
  });

  it("does not remember agent-created HTML notes for response-menu appends", async function () {
    const tool = createEditCurrentNoteTool({
      getItem: (id: number) =>
        id === 9
          ? ({
              id: 9,
              libraryID: 1,
              isRegularItem: () => true,
              isAttachment: () => false,
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
    assert.isNull(tracked);
  });

  it("agent create makes a new item note even when a response-save note is tracked", async function () {
    const trackedNote = saveExistingNote(50, 9, "<p>Tracked response save</p>");
    rememberAssistantNoteForParent(9, 50);

    const tool = createEditCurrentNoteTool(new ZoteroGateway());
    const result = await tool.execute(
      {
        mode: "create",
        content: "Agent-created note",
        target: "item",
      },
      baseContext,
    );

    assert.equal((result as any).result.status, "created");
    assert.equal(trackedNote.getNote(), "<p>Tracked response save</p>");
    assert.equal(getTrackedAssistantNoteForParent(9)?.id, 50);
    assert.lengthOf(childNotes(9), 2);
    assert.include(childNotes(9)[1].getNote(), "Agent-created note");
  });

  it("agent create attaches to the only selected paper when no active item exists", async function () {
    const tool = createEditCurrentNoteTool(new ZoteroGateway());
    const result = await tool.execute(
      {
        mode: "create",
        content: "Selected-paper note",
        target: "item",
      },
      {
        ...baseContext,
        request: {
          ...baseContext.request,
          activeItemId: undefined,
          selectedPaperContexts: [
            {
              itemId: 9,
              contextItemId: 9,
              title: "Parent Paper",
            },
          ],
        },
      },
    );

    assert.equal((result as any).result.status, "created");
    assert.lengthOf(childNotes(9), 1);
    assert.include(childNotes(9)[0].getNote(), "Selected-paper note");
  });

  it("append mode appends to an explicit note ID", async function () {
    const existing = saveExistingNote(60, 9, "<p>Existing body</p>");
    const tool = createEditCurrentNoteTool(new ZoteroGateway());

    const result = await tool.execute(
      {
        mode: "append",
        targetNoteId: 60,
        content: "Appended body",
      },
      baseContext,
    );

    assert.equal((result as any).status, "appended");
    assert.equal((result as any).noteId, 60);
    assert.include(existing.getNote(), "Existing body");
    assert.include(existing.getNote(), "<hr/>");
    assert.include(existing.getNote(), "Appended body");
  });

  it("append mode refuses ambiguous child-note targets", async function () {
    saveExistingNote(61, 9, "<p>First note</p>");
    saveExistingNote(62, 9, "<p>Second note</p>");
    const tool = createEditCurrentNoteTool(new ZoteroGateway());

    let error: unknown;
    try {
      await tool.execute(
        {
          mode: "append",
          content: "Ambiguous append",
          targetItemId: 9,
        },
        baseContext,
      );
    } catch (err) {
      error = err;
    }

    assert.instanceOf(error, Error);
    assert.match(String((error as Error).message), /multiple child notes/);
  });

  it("response-menu note saves still opt into the tracked append chain", async function () {
    const first = await createNoteFromAssistantText(
      parentItem,
      "First response",
      "gpt-5.4",
      undefined,
      {
        appendToTrackedNote: true,
        rememberCreatedNote: true,
      },
    );
    const second = await createNoteFromAssistantText(
      parentItem,
      "Second response",
      "gpt-5.4",
      undefined,
      {
        appendToTrackedNote: true,
        rememberCreatedNote: true,
      },
    );

    assert.equal(first, "created");
    assert.equal(second, "appended");
    assert.lengthOf(childNotes(9), 1);
    assert.equal(getTrackedAssistantNoteForParent(9)?.id, childNotes(9)[0].id);
    assert.include(childNotes(9)[0].getNote(), "First response");
    assert.include(childNotes(9)[0].getNote(), "Second response");
  });
});

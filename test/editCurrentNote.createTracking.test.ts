import { assert } from "chai";
import { createEditCurrentNoteTool } from "../src/agent/tools/write/editCurrentNote";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import {
  createAssistantResponseNote,
  createNoteFromChatHistory,
} from "../src/modules/contextPanel/notes";
import {
  getTrackedAssistantNoteForParent,
  rememberAssistantNoteForParent,
} from "../src/modules/contextPanel/prefHelpers";
import { resolveSvgFigureRasterSize } from "../src/modules/contextPanel/figureExport";
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
      Attachments?: {
        importEmbeddedImage?: (params: {
          blob: Blob;
          parentItemID: number;
        }) => Promise<{ key: string } | null>;
      };
    };
    IOUtils?: {
      read?: (path: string) => Promise<Uint8Array>;
    };
  };
  const originalZotero = globalScope.Zotero;
  const originalZtoolkit = globalScope.ztoolkit;
  const originalIOUtils = globalScope.IOUtils;
  const prefStore = new Map<string, unknown>();
  const savedItems = new Map<number, Zotero.Item>();
  const parentNoteIds: number[] = [];
  const importedImageParents: number[] = [];
  const importedImagePaths: string[] = [];
  const importedImageMimeTypes: string[] = [];
  const importedImageByteSizes: number[] = [];
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
    importedImageParents.splice(0);
    importedImagePaths.splice(0);
    importedImageMimeTypes.splice(0);
    importedImageByteSizes.splice(0);
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
      Attachments: {
        importEmbeddedImage: async ({ blob, parentItemID }) => {
          importedImageParents.push(parentItemID);
          importedImageMimeTypes.push(blob.type);
          importedImageByteSizes.push(blob.size);
          return { key: `IMG${parentItemID}_${importedImageParents.length}` };
        },
      },
    };
    globalScope.IOUtils = {
      read: async (path: string) => {
        importedImagePaths.push(path);
        return new Uint8Array([1, 2, 3, 4]);
      },
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
    } else {
      delete globalScope.Zotero;
    }
    if (originalIOUtils) {
      globalScope.IOUtils = originalIOUtils;
    } else {
      delete globalScope.IOUtils;
    }
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

  it("assistant response note saves create fresh item notes", async function () {
    const first = await createAssistantResponseNote({
      destination: { kind: "item", item: parentItem },
      queryText: "First question",
      contentText: "First response",
      modelName: "gpt-5.4",
    });
    const second = await createAssistantResponseNote({
      destination: { kind: "item", item: parentItem },
      queryText: "Second question",
      contentText: "Second response",
      modelName: "gpt-5.4",
    });

    assert.equal(first.status, "created");
    assert.equal(second.status, "created");
    assert.lengthOf(childNotes(9), 2);
    assert.isNull(getTrackedAssistantNoteForParent(9));
    assert.include(childNotes(9)[0].getNote(), "First question");
    assert.include(childNotes(9)[0].getNote(), "First response");
    assert.include(childNotes(9)[1].getNote(), "Second question");
    assert.include(childNotes(9)[1].getNote(), "Second response");
  });

  it("response-menu note creation embeds generated images as Zotero note attachments", async function () {
    const result = await createAssistantResponseNote({
      destination: { kind: "item", item: parentItem },
      queryText: "Generate a spine figure.",
      contentText: "Generated a figure.",
      modelName: "Codex",
      generatedImages: [
        {
          id: "img-1",
          label: "spine.png",
          path: "/tmp/spine.png",
        },
      ],
    });

    assert.equal(result.status, "created");
    assert.lengthOf(childNotes(9), 1);
    const note = childNotes(9)[0];
    assert.include(note.getNote(), "Generate a spine figure.");
    assert.include(note.getNote(), "Generated a figure.");
    assert.include(note.getNote(), 'data-attachment-key="IMG100_1"');
    assert.notInclude(note.getNote(), "Generated image embedded");
    assert.notInclude(note.getNote(), "spine.png</p>");
    assert.deepEqual(importedImageParents, [100]);
    assert.deepEqual(importedImagePaths, ["/tmp/spine.png"]);
  });

  it("response-menu generated images attach to the newly created item note", async function () {
    await createAssistantResponseNote({
      destination: { kind: "item", item: parentItem },
      queryText: "First question",
      contentText: "First response",
      modelName: "Codex",
    });

    const result = await createAssistantResponseNote({
      destination: { kind: "item", item: parentItem },
      queryText: "Second question",
      contentText: "Second response",
      modelName: "Codex",
      generatedImages: [
        {
          id: "img-2",
          label: "diagram.png",
          path: "/tmp/diagram.png",
        },
      ],
    });

    assert.equal(result.status, "created");
    assert.lengthOf(childNotes(9), 2);
    const note = childNotes(9)[1];
    assert.notInclude(note.getNote(), "First response");
    assert.include(note.getNote(), "Second question");
    assert.include(note.getNote(), "Second response");
    assert.include(note.getNote(), 'data-attachment-key="IMG101_1"');
    assert.deepEqual(importedImageParents, [101]);
  });

  it("response-menu note creation converts SVG fences into PNG note attachments", async function () {
    let rasterizedSvg = "";
    const pngBytes = new Uint8Array([137, 80, 78, 71, 1]);

    const result = await createAssistantResponseNote({
      destination: { kind: "item", item: parentItem },
      queryText: "Render this SVG.",
      contentText: [
        "Before.",
        "",
        "```svg",
        '<svg width="10" height="10"/>',
        "```",
        "",
        "After.",
      ].join("\n"),
      modelName: "Codex",
      figureRender: {
        doc: {} as Document,
        rasterizeSvgToPngBytes: async (_doc, svgMarkup) => {
          rasterizedSvg = svgMarkup;
          return pngBytes;
        },
      },
    });

    assert.equal(result.status, "created");
    assert.lengthOf(childNotes(9), 1);
    const note = childNotes(9)[0];
    assert.include(note.getNote(), "Before.");
    assert.include(note.getNote(), "After.");
    assert.include(note.getNote(), 'data-attachment-key="IMG100_1"');
    assert.notInclude(note.getNote(), '<pre class="lang-svg">');
    assert.notInclude(note.getNote(), "&lt;svg");
    assert.include(rasterizedSvg, '<svg xmlns="http://www.w3.org/2000/svg"');
    assert.deepEqual(importedImageParents, [100]);
    assert.deepEqual(importedImageMimeTypes, ["image/png"]);
    assert.deepEqual(importedImageByteSizes, [pngBytes.length]);
    assert.deepEqual(importedImagePaths, []);
  });

  it("rasterizes tiny SVG figures at readable note-export dimensions", function () {
    assert.deepEqual(
      resolveSvgFigureRasterSize('<svg width="12" height="8"></svg>'),
      { width: 1600, height: 1067 },
    );
    assert.deepEqual(
      resolveSvgFigureRasterSize(
        '<svg width="100%" height="100%" viewBox="0 0 12 8"></svg>',
      ),
      { width: 1600, height: 1067 },
    );
    assert.deepEqual(
      resolveSvgFigureRasterSize('<svg width="800" height="480"></svg>'),
      { width: 1600, height: 960 },
    );
  });

  it("response-menu note creation converts Mermaid fences into PNG note attachments", async function () {
    let renderedMermaidSource = "";
    let rasterizedSvg = "";

    await createAssistantResponseNote({
      destination: { kind: "item", item: parentItem },
      queryText: "Render this diagram.",
      contentText: ["```mermaid", "flowchart TD", "  A --> B", "```"].join(
        "\n",
      ),
      modelName: "Codex",
      figureRender: {
        doc: {} as Document,
        renderMermaidSvg: async (source) => {
          renderedMermaidSource = source;
          return '<svg width="12" height="8"><rect width="12" height="8"/></svg>';
        },
        rasterizeSvgToPngBytes: async (_doc, svgMarkup) => {
          rasterizedSvg = svgMarkup;
          return new Uint8Array([137, 80, 78, 71, 2]);
        },
      },
    });

    assert.lengthOf(childNotes(9), 1);
    const note = childNotes(9)[0];
    assert.include(note.getNote(), 'data-attachment-key="IMG100_1"');
    assert.notInclude(note.getNote(), '<pre class="lang-mermaid">');
    assert.notInclude(note.getNote(), "flowchart TD");
    assert.equal(renderedMermaidSource, "flowchart TD\n  A --> B");
    assert.include(rasterizedSvg, "<svg");
    assert.deepEqual(importedImageParents, [100]);
    assert.deepEqual(importedImageMimeTypes, ["image/png"]);
  });

  it("standalone response notes embed generated images", async function () {
    await createAssistantResponseNote({
      destination: { kind: "standalone", libraryID: 1 },
      queryText: "Generate a standalone figure.",
      contentText: "Standalone generated figure.",
      modelName: "Codex",
      generatedImages: [
        {
          id: "img-standalone",
          label: "standalone.png",
          path: "/tmp/standalone.png",
        },
      ],
    });

    const note = Array.from(savedItems.values()).find(
      (item) => (item as any).isNote?.() && !item.parentID,
    ) as unknown as MockNoteItem | undefined;
    assert.isOk(note);
    assert.include(note!.getNote(), "Generate a standalone figure.");
    assert.include(note!.getNote(), "Standalone generated figure.");
    assert.include(note!.getNote(), 'data-attachment-key="IMG100_1"');
    assert.deepEqual(importedImageParents, [100]);
  });

  it("chat-history note export embeds assistant generated images and keeps user screenshots", async function () {
    await createNoteFromChatHistory(parentItem, [
      {
        role: "user",
        text: "Please make a diagram.",
        timestamp: 1,
        screenshotImages: ["data:image/png;base64,USERINPUT"],
      },
      {
        role: "assistant",
        text: "",
        timestamp: 2,
        modelName: "Codex",
        generatedImages: [
          {
            id: "img-history",
            label: "history.png",
            src: "file:///tmp/history.png",
          },
        ],
      },
    ]);

    assert.lengthOf(childNotes(9), 1);
    const note = childNotes(9)[0];
    assert.include(note.getNote(), "Please make a diagram.");
    assert.include(note.getNote(), 'src="data:image/png;base64,USERINPUT"');
    assert.include(note.getNote(), 'data-attachment-key="IMG100_1"');
    assert.notInclude(note.getNote(), "Generated image embedded");
    assert.notInclude(note.getNote(), "history.png</p>");
    assert.deepEqual(importedImageParents, [100]);
    assert.deepEqual(importedImagePaths, ["/tmp/history.png"]);
  });

  it("chat-history note export converts visual fences into PNG note attachments", async function () {
    let renderedMermaidSource = "";

    await createNoteFromChatHistory(
      parentItem,
      [
        {
          role: "user",
          text: "Please show a flowchart.",
          timestamp: 1,
        },
        {
          role: "assistant",
          text: ["```mermaid", "flowchart LR", "  A --> B", "```"].join("\n"),
          timestamp: 2,
          modelName: "Codex",
        },
      ],
      {
        figureRender: {
          doc: {} as Document,
          renderMermaidSvg: async (source) => {
            renderedMermaidSource = source;
            return '<svg width="12" height="8"><rect width="12" height="8"/></svg>';
          },
          rasterizeSvgToPngBytes: async () =>
            new Uint8Array([137, 80, 78, 71, 3]),
        },
      },
    );

    assert.lengthOf(childNotes(9), 1);
    const note = childNotes(9)[0];
    assert.include(note.getNote(), "Please show a flowchart.");
    assert.include(note.getNote(), 'data-attachment-key="IMG100_1"');
    assert.notInclude(note.getNote(), '<pre class="lang-mermaid">');
    assert.notInclude(note.getNote(), "flowchart LR");
    assert.equal(renderedMermaidSource, "flowchart LR\n  A --> B");
    assert.deepEqual(importedImageParents, [100]);
  });
});

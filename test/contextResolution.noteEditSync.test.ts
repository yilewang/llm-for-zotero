import { assert } from "chai";
import {
  getSelectedTextContextEntries,
  resolveContextSourceItemIdAsync,
  setSelectedTextContextEntries,
  syncSelectedTextContextForSource,
} from "../src/modules/contextPanel/contextResolution";
import { resolvePaperContextRefFromAttachment } from "../src/modules/contextPanel/paperAttribution";

describe("contextResolution note-edit sync", function () {
  const itemId = 777;
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;

  afterEach(function () {
    setSelectedTextContextEntries(itemId, []);
    globalScope.Zotero = originalZotero;
  });

  it("adds and removes transient note-edit context without dropping manual contexts", function () {
    setSelectedTextContextEntries(itemId, [
      { text: "PDF snippet", source: "pdf", pageIndex: 1, pageLabel: "2" },
      { text: "Model snippet", source: "model" },
    ]);

    assert.isTrue(
      syncSelectedTextContextForSource(itemId, "Edit this sentence", "note-edit"),
    );
    assert.deepEqual(
      getSelectedTextContextEntries(itemId).map((entry) => ({
        text: entry.text,
        source: entry.source,
      })),
      [
        { text: "Edit this sentence", source: "note-edit" },
        { text: "PDF snippet", source: "pdf" },
        { text: "Model snippet", source: "model" },
      ],
    );

    assert.isTrue(syncSelectedTextContextForSource(itemId, "", "note-edit"));
    assert.deepEqual(
      getSelectedTextContextEntries(itemId).map((entry) => ({
        text: entry.text,
        source: entry.source,
      })),
      [
        { text: "PDF snippet", source: "pdf" },
        { text: "Model snippet", source: "model" },
      ],
    );
  });

  it("does not rewrite state when the note-edit focus is unchanged", function () {
    assert.isTrue(
      syncSelectedTextContextForSource(itemId, "Tighten this wording", "note-edit"),
    );
    assert.isFalse(
      syncSelectedTextContextForSource(itemId, "Tighten this wording", "note-edit"),
    );
  });

  it("resolves parent-item context source by Zotero best attachment", async function () {
    const parentItem = {
      id: 100,
      isAttachment: () => false,
      isRegularItem: () => true,
      getAttachments: () => [101, 102],
      getField: () => "Parent Paper",
      getBestAttachment: async () => supplementPdf,
    };
    const mainPdf = {
      id: 101,
      parentID: 100,
      attachmentContentType: "application/pdf",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: () => "Main PDF",
    };
    const supplementPdf = {
      id: 102,
      parentID: 100,
      attachmentContentType: "application/pdf",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: () => "Supplement PDF",
    };
    const items = new Map<number, unknown>([
      [100, parentItem],
      [101, mainPdf],
      [102, supplementPdf],
    ]);
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Items: {
        get: (id: number) => items.get(id) || null,
      },
      Tabs: {
        selectedType: "library",
        selectedID: "library",
        _tabs: [],
      },
    };

    assert.equal(
      await resolveContextSourceItemIdAsync(mainPdf as unknown as Zotero.Item),
      101,
    );
    assert.equal(
      await resolveContextSourceItemIdAsync(
        supplementPdf as unknown as Zotero.Item,
      ),
      102,
    );
    assert.equal(
      await resolveContextSourceItemIdAsync(parentItem as unknown as Zotero.Item),
      102,
    );
  });

  it("uses the library-pane selected child PDF before Zotero best attachment", async function () {
    const parentItem = {
      id: 150,
      isAttachment: () => false,
      isRegularItem: () => true,
      getAttachments: () => [151, 152],
      getField: () => "Parent Paper",
      getBestAttachment: async () => mainPdf,
    };
    const mainPdf = {
      id: 151,
      parentID: 150,
      attachmentContentType: "application/pdf",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: () => "Main PDF",
    };
    const selectedPdf = {
      id: 152,
      parentID: 150,
      attachmentContentType: "application/pdf",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: () => "PDF",
    };
    const items = new Map<number, unknown>([
      [150, parentItem],
      [151, mainPdf],
      [152, selectedPdf],
    ]);
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Items: {
        get: (id: number) => items.get(id) || null,
      },
      Tabs: {
        selectedType: "library",
        selectedID: "library",
        _tabs: [],
      },
      getActiveZoteroPane: () => ({
        getSelectedItems: () => [selectedPdf],
      }),
    };

    assert.equal(
      await resolveContextSourceItemIdAsync(parentItem as unknown as Zotero.Item),
      152,
    );
  });

  it("uses the library-pane selected child Markdown before Zotero best attachment", async function () {
    const parentItem = {
      id: 170,
      isAttachment: () => false,
      isRegularItem: () => true,
      getAttachments: () => [171, 172],
      getField: (field: string) =>
        field === "firstCreator"
          ? "Chandra et al."
          : field === "year"
            ? "2025"
            : "Parent Paper",
      getBestAttachment: async () => mainPdf,
    };
    const mainPdf = {
      id: 171,
      parentID: 170,
      attachmentContentType: "application/pdf",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: () => "Main PDF",
    };
    const selectedMarkdown = {
      id: 172,
      parentID: 170,
      attachmentContentType: "text/markdown",
      attachmentFilename: "test.md",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: () => "test",
    };
    const items = new Map<number, unknown>([
      [170, parentItem],
      [171, mainPdf],
      [172, selectedMarkdown],
    ]);
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Items: {
        get: (id: number) => items.get(id) || null,
      },
      Tabs: {
        selectedType: "library",
        selectedID: "library",
        _tabs: [],
      },
      getActiveZoteroPane: () => ({
        getSelectedItems: () => [selectedMarkdown],
      }),
    };

    assert.equal(
      await resolveContextSourceItemIdAsync(
        parentItem as unknown as Zotero.Item,
      ),
      172,
    );
    const paperContext = resolvePaperContextRefFromAttachment(
      selectedMarkdown as unknown as Zotero.Item,
    );
    assert.equal(paperContext?.itemId, 170);
    assert.equal(paperContext?.contextItemId, 172);
    assert.equal(paperContext?.contentSourceMode, "markdown");
  });

  it("uses a supported selected DOCX attachment directly", async function () {
    const parentItem = {
      id: 180,
      isAttachment: () => false,
      isRegularItem: () => true,
      getAttachments: () => [181, 182],
      getField: () => "Parent Paper",
      getBestAttachment: async () => mainPdf,
    };
    const mainPdf = {
      id: 181,
      parentID: 180,
      attachmentContentType: "application/pdf",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: () => "Main PDF",
    };
    const selectedDocx = {
      id: 182,
      parentID: 180,
      attachmentContentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      attachmentFilename: "notes.docx",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: () => "notes",
    };
    const items = new Map<number, unknown>([
      [180, parentItem],
      [181, mainPdf],
      [182, selectedDocx],
    ]);
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Items: {
        get: (id: number) => items.get(id) || null,
      },
      Tabs: {
        selectedType: "library",
        selectedID: "library",
        _tabs: [],
      },
    };

    assert.equal(
      await resolveContextSourceItemIdAsync(
        selectedDocx as unknown as Zotero.Item,
      ),
      182,
    );
    const paperContext = resolvePaperContextRefFromAttachment(
      selectedDocx as unknown as Zotero.Item,
    );
    assert.equal(paperContext?.itemId, 180);
    assert.equal(paperContext?.contextItemId, 182);
    assert.equal(paperContext?.contentSourceMode, "docx");
  });

  it("uses the active reader attachment over the parent item source", async function () {
    const parentItem = {
      id: 200,
      isAttachment: () => false,
      isRegularItem: () => true,
      getAttachments: () => [201],
      getField: () => "Parent Paper",
      getBestAttachment: async () => mainPdf,
    };
    const mainPdf = {
      id: 201,
      parentID: 200,
      attachmentContentType: "application/pdf",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: () => "Main PDF",
    };
    const activeReaderPdf = {
      id: 202,
      parentID: 200,
      attachmentContentType: "application/pdf",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: () => "Active Reader PDF",
    };
    const items = new Map<number, unknown>([
      [200, parentItem],
      [201, mainPdf],
      [202, activeReaderPdf],
    ]);
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Items: {
        get: (id: number) => items.get(id) || null,
      },
      Tabs: {
        selectedType: "reader",
        selectedID: "reader-tab",
        _tabs: [
          {
            id: "reader-tab",
            type: "reader",
            data: { itemID: 202 },
          },
        ],
      },
    };

    assert.equal(
      await resolveContextSourceItemIdAsync(parentItem as unknown as Zotero.Item),
      202,
    );
  });

  it("does not preload parent context when Zotero best attachment is not a PDF", async function () {
    const parentItem = {
      id: 250,
      isAttachment: () => false,
      isRegularItem: () => true,
      getAttachments: () => [251],
      getField: () => "Parent Paper",
      getBestAttachment: async () => snapshot,
    };
    const snapshot = {
      id: 251,
      parentID: 250,
      attachmentContentType: "text/html",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: () => "Snapshot",
    };
    const items = new Map<number, unknown>([
      [250, parentItem],
      [251, snapshot],
    ]);
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Items: {
        get: (id: number) => items.get(id) || null,
      },
      Tabs: {
        selectedType: "library",
        selectedID: "library",
        _tabs: [],
      },
    };

    assert.equal(
      await resolveContextSourceItemIdAsync(parentItem as unknown as Zotero.Item),
      0,
    );
  });

  it("does not preload parent context when Zotero has no best attachment", async function () {
    const parentItem = {
      id: 260,
      isAttachment: () => false,
      isRegularItem: () => true,
      getAttachments: () => [],
      getField: () => "Parent Paper",
      getBestAttachment: async () => false,
    };
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Items: {
        get: (id: number) => (id === 260 ? parentItem : null),
      },
      Tabs: {
        selectedType: "library",
        selectedID: "library",
        _tabs: [],
      },
    };

    assert.equal(
      await resolveContextSourceItemIdAsync(parentItem as unknown as Zotero.Item),
      0,
    );
  });

  it("refreshes note-backed text contexts from the current note snapshot", function () {
    const noteItem = {
      id: 501,
      key: "ABCD1234",
      libraryID: 1,
      isNote: () => true,
      getNote: () => "<p>Updated note body</p>",
      getDisplayTitle: () => "Context note",
    };
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Items: {
        get: (id: number) => (id === 501 ? noteItem : null),
        getByLibraryAndKey: (libraryID: number, key: string) =>
          libraryID === 1 && key === "ABCD1234" ? noteItem : null,
      },
    };

    setSelectedTextContextEntries(itemId, [
      {
        text: "Stale note body",
        source: "note",
        noteContext: {
          libraryID: 1,
          noteItemKey: "ABCD1234",
          noteKind: "standalone",
          title: "Old title",
        },
      },
    ]);

    const entries = getSelectedTextContextEntries(itemId);
    assert.deepEqual(entries, [
      {
        text: "Updated note body",
        source: "note",
        noteContext: {
          libraryID: 1,
          noteItemKey: "ABCD1234",
          noteItemId: 501,
          parentItemId: undefined,
          parentItemKey: undefined,
          noteKind: "standalone",
          title: "Context note",
        },
        paperContext: undefined,
        contextItemId: undefined,
        pageIndex: undefined,
        pageLabel: undefined,
      },
    ]);
  });
});

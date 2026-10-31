import { assert } from "chai";
import { libraryIndexService } from "../src/services/libraryIndexService";
import { configureAssistantNoteWriter } from "../src/services/notes/assistantNoteWriterBridge";
import {
  NoteCapability,
  type NoteCapabilityDeps,
} from "../src/agent/services/zotero/noteCapability";
import { composeRetrievalCandidateInvalidation } from "./helpers/hostSurfaces";

/**
 * The note paths used to live on `ZoteroGateway` and reached the item lookup
 * through `this`. They now take that lookup as a dependency, so this file
 * drives the capability on its own — the same behaviour
 * `zoteroGateway.noteEdits.test.ts` pins through the facade, asserted here
 * against the seam the facade fills in.
 */
describe("note capability", function () {
  type FakeNote = {
    id: number;
    libraryID: number;
    parentID?: number;
    html: string;
    title?: string;
    saves: number;
  };

  let notes: Map<number, FakeNote>;
  let items: Map<number, Record<string, unknown>>;
  let restoreRetrievalInvalidator: (() => void) | null = null;

  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;

  before(function () {
    // Note edits invalidate cached paper context, which reaches the panel's
    // retrieval cache through a host surface bridge the plugin composes at
    // startup.
    restoreRetrievalInvalidator = composeRetrievalCandidateInvalidation();
  });

  after(function () {
    restoreRetrievalInvalidator?.();
    restoreRetrievalInvalidator = null;
  });

  beforeEach(function () {
    notes = new Map();
    items = new Map();
    libraryIndexService.clearForTests();
  });

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
    libraryIndexService.clearForTests();
  });

  /** A note item with the surface `persistVerifiedNoteHtml` writes through. */
  function makeNote(seed: {
    id: number;
    html: string;
    title?: string;
    libraryID?: number;
    parentID?: number;
  }) {
    const state: FakeNote = {
      id: seed.id,
      libraryID: seed.libraryID ?? 1,
      parentID: seed.parentID,
      html: seed.html,
      title: seed.title,
      saves: 0,
    };
    notes.set(seed.id, state);
    let pending = seed.html;
    const item = {
      id: state.id,
      libraryID: state.libraryID,
      parentID: state.parentID,
      isNote: () => true,
      isRegularItem: () => false,
      isAttachment: () => false,
      getNote: () => state.html,
      getNoteTitle: () => state.title ?? "",
      getDisplayTitle: () => state.title ?? "",
      getCollections: () => [] as number[],
      getTags: () => [] as Array<{ tag: string }>,
      setNote: (html: string) => {
        pending = html;
      },
      saveTx: async () => {
        state.html = pending;
        state.saves += 1;
      },
      reload: async () => {
        pending = state.html;
      },
    };
    items.set(seed.id, item as unknown as Record<string, unknown>);
    return { state, item };
  }

  function installZotero(extra: Record<string, unknown> = {}) {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: {
        get: (id: number) => items.get(id) || null,
      },
      Libraries: { userLibraryID: 1 },
      debug: () => undefined,
      ...extra,
    };
  }

  /** The capability under test, with every dependency answered explicitly. */
  function capability(deps: Partial<NoteCapabilityDeps> = {}) {
    return new NoteCapability({
      getItem: (itemId) =>
        (items.get(Number(itemId)) as unknown as Zotero.Item) || null,
      resolveBibliographicItem: (item) => item ?? null,
      ...deps,
    });
  }

  describe("which note an edit applies to", function () {
    it("prefers the named note over the one the user has open", function () {
      makeNote({ id: 5, html: "<p>open note</p>", title: "Open" });
      makeNote({ id: 9, html: "<p>other note</p>", title: "Other" });
      installZotero();

      const resolved = capability().resolveActiveNoteItem({
        request: { activeNoteContext: { noteId: 5 } } as never,
        noteId: 9,
      });

      assert.equal(resolved?.id, 9);
    });

    it("falls back to the item the request has active", function () {
      makeNote({ id: 7, html: "<p>active</p>", title: "Active" });
      installZotero();

      const resolved = capability().resolveActiveNoteItem({
        request: { activeItemId: 7 } as never,
      });

      assert.equal(resolved?.id, 7);
    });

    it("reads the snapshot of whatever it resolved", function () {
      makeNote({ id: 5, html: "<p>Body text</p>", title: "Draft" });
      installZotero();

      const snapshot = capability().getActiveNoteSnapshot({ noteId: 5 });

      assert.equal(snapshot?.noteId, 5);
      assert.equal(snapshot?.title, "Draft");
      assert.equal(snapshot?.text, "Body text");
      assert.equal(snapshot?.noteKind, "standalone");
    });
  });

  describe("rewriting a note", function () {
    it("stores the rendered HTML and reports what the note used to say", async function () {
      const { state } = makeNote({
        id: 5,
        html: "<p>Original body</p>",
        title: "Draft",
      });
      installZotero();

      const result = await capability().replaceCurrentNote({
        noteId: 5,
        content: "Updated body",
      });

      assert.equal(result.noteId, 5);
      assert.equal(result.previousText, "Original body");
      assert.equal(result.nextText, "Updated body");
      assert.include(state.html, "Updated body");
      assert.notInclude(state.html, "Original body");
    });

    it("refuses the edit when the note changed under it", async function () {
      const { state } = makeNote({ id: 5, html: "<p>Someone else wrote</p>" });
      installZotero();

      let message = "";
      try {
        await capability().replaceCurrentNote({
          noteId: 5,
          content: "Updated body",
          expectedOriginalHtml: "<p>Original body</p>",
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      assert.include(message, "changed before this edit");
      // The stale write must not have landed.
      assert.equal(state.html, "<p>Someone else wrote</p>");
      assert.equal(state.saves, 0);
    });

    it("writes pre-patched HTML verbatim rather than re-rendering the text", async function () {
      const { state } = makeNote({ id: 5, html: "<p>Original</p>" });
      installZotero();

      // The plain-text roundtrip would destroy the image and the list.
      const patched =
        '<div><ol><li>One</li></ol><img data-attachment-key="ABCD"/></div>';
      const result = await capability().replaceCurrentNote({
        noteId: 5,
        content: "One",
        preRenderedHtml: patched,
      });

      assert.equal(state.html, patched);
      assert.equal(result.nextText, "One");
    });

    it("refuses to edit when nothing resolves to a note", async function () {
      installZotero();

      let message = "";
      try {
        await capability().replaceCurrentNote({ noteId: 404, content: "x" });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      assert.include(message, "No active note");
    });

    it("puts back the exact HTML an undo carries", async function () {
      const { state } = makeNote({ id: 5, html: "<p>Edited</p>" });
      installZotero();

      await capability().restoreNoteHtml({
        noteId: 5,
        html: "<p>Original</p>",
      });

      assert.equal(state.html, "<p>Original</p>");
    });

    it("refuses an undo aimed at something that is not a note", async function () {
      items.set(6, {
        id: 6,
        isNote: () => false,
      } as unknown as Record<string, unknown>);
      installZotero();

      let message = "";
      try {
        await capability().restoreNoteHtml({ noteId: 6, html: "<p>x</p>" });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      assert.include(message, "Note not found");
    });
  });

  describe("reading a standalone note", function () {
    it("reports the text and its word count", function () {
      makeNote({ id: 5, html: "<p>Three little words</p>", title: "Draft" });
      installZotero();

      const record = capability().getStandaloneNoteContent({ noteId: 5 });

      assert.equal(record?.noteId, 5);
      assert.equal(record?.title, "Draft");
      assert.equal(record?.noteText, "Three little words");
      assert.equal(record?.wordCount, 3);
    });

    it("names an untitled note after its id", function () {
      makeNote({ id: 5, html: "<p>Body</p>" });
      installZotero();

      assert.equal(
        capability().getStandaloneNoteContent({ noteId: 5 })?.title,
        "Note 5",
      );
    });

    it("returns nothing for an empty note and for a non-note", function () {
      makeNote({ id: 5, html: "<p>   </p>" });
      items.set(6, {
        id: 6,
        isNote: () => false,
      } as unknown as Record<string, unknown>);
      installZotero();

      assert.isNull(capability().getStandaloneNoteContent({ noteId: 5 }));
      assert.isNull(capability().getStandaloneNoteContent({ noteId: 6 }));
    });
  });

  describe("a paper's notes and annotations", function () {
    /** A regular item that owns child notes. */
    function makePaper(seed: {
      id: number;
      title: string;
      noteIds?: number[];
      attachmentIds?: number[];
    }) {
      const item = {
        id: seed.id,
        libraryID: 1,
        isNote: () => false,
        isRegularItem: () => true,
        isAttachment: () => false,
        getNotes: () => seed.noteIds || [],
        getAttachments: () => seed.attachmentIds || [],
        getCollections: () => [] as number[],
        getTags: () => [] as Array<{ tag: string }>,
        getDisplayTitle: () => seed.title,
        getField: (name: string) => (name === "title" ? seed.title : ""),
      };
      items.set(seed.id, item as unknown as Record<string, unknown>);
      return item;
    }

    it("reads through a child attachment to the paper that owns the notes", function () {
      const paper = makePaper({ id: 1, title: "Paper", noteIds: [2] });
      makeNote({ id: 2, html: "<p>Child note</p>", title: "N", parentID: 1 });
      const attachment = {
        id: 3,
        parentID: 1,
        isNote: () => false,
        isRegularItem: () => false,
        isAttachment: () => true,
        parentItem: paper,
      };
      items.set(3, attachment as unknown as Record<string, unknown>);
      installZotero();

      const records = capability().getPaperNotes({
        item: attachment as unknown as Zotero.Item,
      });

      assert.deepEqual(
        records.map((record) => record.noteId),
        [2],
      );
      assert.equal(records[0].noteText, "Child note");
    });

    it("truncates a very long note rather than returning the whole thing", function () {
      makePaper({ id: 1, title: "Paper", noteIds: [2] });
      makeNote({ id: 2, html: `<p>${"word ".repeat(4000)}</p>`, parentID: 1 });
      installZotero();

      const records = capability().getPaperNotes({
        item: items.get(1) as unknown as Zotero.Item,
      });

      assert.lengthOf(records[0].noteText, 10001);
      assert.isTrue(records[0].noteText.endsWith("…"));
    });

    it("stops at the requested number of notes", function () {
      makePaper({ id: 1, title: "Paper", noteIds: [2, 3, 4] });
      makeNote({ id: 2, html: "<p>One</p>", parentID: 1 });
      makeNote({ id: 3, html: "<p>Two</p>", parentID: 1 });
      makeNote({ id: 4, html: "<p>Three</p>", parentID: 1 });
      installZotero();

      const records = capability().getPaperNotes({
        item: items.get(1) as unknown as Zotero.Item,
        maxNotes: 2,
      });

      assert.deepEqual(
        records.map((record) => record.noteText),
        ["One", "Two"],
      );
    });

    it("collects highlight text and comments, and skips annotations with neither", function () {
      makePaper({ id: 1, title: "Paper", attachmentIds: [2] });
      items.set(2, {
        id: 2,
        parentID: 1,
        isNote: () => false,
        isRegularItem: () => false,
        isAttachment: () => true,
        isPDFAttachment: () => true,
        attachmentContentType: "application/pdf",
        getAnnotations: () => [10, 11, 12].map((id) => items.get(id)),
      } as unknown as Record<string, unknown>);
      items.set(10, {
        id: 10,
        isAnnotation: () => true,
        annotationType: "highlight",
        annotationText: "A quoted line",
        annotationColor: "#ffd400",
        annotationPageLabel: "4",
      } as unknown as Record<string, unknown>);
      items.set(11, {
        id: 11,
        isAnnotation: () => true,
        annotationType: "note",
        annotationComment: "A reader's aside",
      } as unknown as Record<string, unknown>);
      items.set(12, {
        id: 12,
        isAnnotation: () => true,
        annotationType: "highlight",
      } as unknown as Record<string, unknown>);
      installZotero();

      const records = capability().getPaperAnnotations({
        item: items.get(1) as unknown as Zotero.Item,
      });

      assert.deepEqual(
        records.map((record) => record.annotationId),
        [10, 11],
      );
      assert.equal(records[0].text, "A quoted line");
      assert.equal(records[0].pageLabel, "4");
      assert.equal(records[1].comment, "A reader's aside");
      assert.equal(records[1].text, "");
    });

    it("truncates an over-long highlight", function () {
      makePaper({ id: 1, title: "Paper", attachmentIds: [2] });
      items.set(2, {
        id: 2,
        parentID: 1,
        isNote: () => false,
        isRegularItem: () => false,
        isAttachment: () => true,
        isPDFAttachment: () => true,
        attachmentContentType: "application/pdf",
        getAnnotations: () => [items.get(10)],
      } as unknown as Record<string, unknown>);
      items.set(10, {
        id: 10,
        isAnnotation: () => true,
        annotationType: "highlight",
        annotationText: "x".repeat(900),
      } as unknown as Record<string, unknown>);
      installZotero();

      const records = capability().getPaperAnnotations({
        item: items.get(1) as unknown as Zotero.Item,
      });

      assert.lengthOf(records[0].text, 501);
      assert.isTrue(records[0].text.endsWith("…"));
    });
  });

  describe("searching notes", function () {
    function installSearch(
      result: number[] | "throws",
      topLevel: Array<Record<string, unknown>> = [],
    ) {
      class FakeSearch {
        constructor(_params: { libraryID: number }) {
          void _params;
          if (result === "throws") throw new Error("Search unavailable");
        }
        addCondition() {}
        async search() {
          return result as number[];
        }
      }
      installZotero({
        Search: FakeSearch,
        Items: {
          get: (id: number) => items.get(id) || null,
          getAll: async () => topLevel,
        },
        Collections: { get: () => null },
      });
    }

    it("marks a child note with the paper it hangs from", async function () {
      items.set(1, {
        id: 1,
        libraryID: 1,
        isNote: () => false,
        isRegularItem: () => true,
        isAttachment: () => false,
        getDisplayTitle: () => "Host paper",
        getCollections: () => [7],
        getTags: () => [],
      } as unknown as Record<string, unknown>);
      makeNote({ id: 2, html: "<p>needle</p>", title: "Child", parentID: 1 });
      installSearch([2]);

      const { notes: results } = await capability().searchAllNotes({
        libraryID: 1,
        query: "needle",
      });

      assert.lengthOf(results, 1);
      assert.equal(results[0].itemId, 2);
      assert.equal(results[0].noteKind, "item");
      assert.equal(results[0].parentItemId, 1);
      assert.equal(results[0].parentItemTitle, "Host paper");
    });

    it("keeps a standalone note as a standalone result", async function () {
      makeNote({ id: 3, html: "<p>needle</p>", title: "Loose note" });
      installSearch([3]);

      const { notes: results } = await capability().searchAllNotes({
        libraryID: 1,
        query: "needle",
      });

      assert.lengthOf(results, 1);
      assert.equal(results[0].noteKind, "standalone");
      assert.isUndefined(results[0].parentItemId);
    });

    it("drops notes whose owner is outside the requested collection", async function () {
      items.set(1, {
        id: 1,
        libraryID: 1,
        isNote: () => false,
        isRegularItem: () => true,
        isAttachment: () => false,
        getDisplayTitle: () => "Host paper",
        getCollections: () => [7],
        getTags: () => [],
      } as unknown as Record<string, unknown>);
      makeNote({ id: 2, html: "<p>needle</p>", parentID: 1 });
      installSearch([2]);

      const { notes: results } = await capability().searchAllNotes({
        libraryID: 1,
        collectionId: 99,
        query: "needle",
      });

      assert.lengthOf(results, 0);
    });

    it("scans the index in memory when Zotero's search is unavailable", async function () {
      const { item: standalone } = makeNote({
        id: 3,
        html: "<p>needle in here</p>",
        title: "Loose note",
      });
      makeNote({ id: 4, html: "<p>nothing to see</p>", title: "Other" });
      installSearch("throws", [
        standalone as unknown as Record<string, unknown>,
        items.get(4) as unknown as Record<string, unknown>,
      ]);

      const { notes: results } = await capability().searchAllNotes({
        libraryID: 1,
        query: "needle",
      });

      assert.deepEqual(
        results.map((result) => result.itemId),
        [3],
      );
      assert.equal(results[0].noteKind, "standalone");
    });

    it("refuses a search with no library rather than returning nothing", async function () {
      installSearch([]);
      let message = "";
      try {
        await capability().searchAllNotes({ libraryID: 0, query: "needle" });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.include(message, "No active library");
    });

    it("answers an empty query without touching the library", async function () {
      let searches = 0;
      let enumerations = 0;
      installZotero({
        Search: class {
          constructor() {
            searches += 1;
            throw new Error("Unexpected search");
          }
        },
        Items: {
          getAll: async () => {
            enumerations += 1;
            return [];
          },
        },
      });
      const { notes: results } = await capability().searchAllNotes({
        libraryID: 1,
        query: "   ",
      });
      assert.deepEqual(results, []);
      assert.equal(searches, 0);
      assert.equal(enumerations, 0);
    });

    it("reports the true total past the limit and pages with offset", async function () {
      const ids = [21, 22, 23, 24, 25];
      for (const id of ids) {
        makeNote({ id, html: "<p>needle</p>", title: `Note ${id}` });
      }
      installSearch(ids);

      const pages = [];
      for (const offset of [0, 2, 4]) {
        pages.push(
          await capability().searchAllNotes({
            libraryID: 1,
            query: "needle",
            limit: 2,
            offset,
          }),
        );
      }

      assert.deepEqual(
        pages.map((page) => page.totalCount),
        [5, 5, 5],
      );
      assert.deepEqual(
        pages.map((page) => page.notes.map((note) => note.itemId)),
        [[21, 22], [23, 24], [25]],
      );
    });

    it("counts only in-collection notes toward the total", async function () {
      items.set(1, {
        id: 1,
        libraryID: 1,
        isNote: () => false,
        isRegularItem: () => true,
        isAttachment: () => false,
        getDisplayTitle: () => "Host paper",
        getCollections: () => [7],
        getTags: () => [],
      } as unknown as Record<string, unknown>);
      makeNote({ id: 2, html: "<p>needle</p>", parentID: 1 });
      makeNote({ id: 3, html: "<p>needle</p>", parentID: 1 });
      makeNote({ id: 4, html: "<p>needle</p>", title: "Unfiled" });
      installSearch([2, 3, 4]);

      const result = await capability().searchAllNotes({
        libraryID: 1,
        collectionId: 7,
        query: "needle",
        limit: 1,
      });

      assert.equal(result.totalCount, 2);
      assert.deepEqual(
        result.notes.map((note) => note.itemId),
        [2],
      );
    });

    it("reports the true total and pages in the in-memory fallback", async function () {
      const topLevel = [31, 32, 33].map(
        (id) =>
          makeNote({ id, html: "<p>needle</p>", title: `Note ${id}` })
            .item as unknown as Record<string, unknown>,
      );
      installSearch("throws", topLevel);

      const result = await capability().searchAllNotes({
        libraryID: 1,
        query: "needle",
        limit: 1,
        offset: 1,
      });

      assert.equal(result.totalCount, 3);
      assert.lengthOf(result.notes, 1);
      assert.include([31, 32, 33], result.notes[0].itemId);
    });
  });

  describe("listing standalone notes", function () {
    it("returns only standalone notes and reports the unpaged total", async function () {
      const { item: first } = makeNote({
        id: 3,
        html: "<p>first</p>",
        title: "First",
      });
      const { item: second } = makeNote({
        id: 4,
        html: "<p>second</p>",
        title: "Second",
      });
      const { item: child } = makeNote({
        id: 5,
        parentID: 1,
        html: "<p>child</p>",
        title: "Child",
      });
      const paper = {
        id: 1,
        libraryID: 1,
        isNote: () => false,
        isRegularItem: () => true,
        isAttachment: () => false,
        getAttachments: () => [],
        getNotes: () => [5],
        getDisplayTitle: () => "A paper",
        getField: (name: string) => (name === "title" ? "A paper" : ""),
        getCollections: () => [],
        getTags: () => [],
      };
      items.set(1, paper as unknown as Record<string, unknown>);
      installZotero({
        Items: {
          get: (id: number) => items.get(id) || null,
          getAll: async () => [
            paper as unknown as Record<string, unknown>,
            child as unknown as Record<string, unknown>,
            first as unknown as Record<string, unknown>,
            second as unknown as Record<string, unknown>,
          ],
        },
        Collections: { get: () => null },
      });

      const listed = await capability().listStandaloneNotes({
        libraryID: 1,
        limit: 1,
      });

      assert.equal(listed.totalCount, 2, "the total ignores the page limit");
      assert.lengthOf(listed.notes, 1);
      assert.equal(listed.notes[0].itemType, "note");
      assert.equal(listed.notes[0].itemId, 3);

      // The second page holds the other note, so offset reaches every one.
      const next = await capability().listStandaloneNotes({
        libraryID: 1,
        limit: 1,
        offset: 1,
      });
      assert.equal(next.totalCount, 2);
      assert.deepEqual(
        next.notes.map((note) => note.itemId),
        [4],
      );
    });

    it("refuses a listing with no library", async function () {
      installZotero();
      let message = "";
      try {
        await capability().listStandaloneNotes({ libraryID: 0 });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.include(message, "No active library");
    });
  });

  describe("saving an answer as a note", function () {
    let itemWrites: Array<{ itemId: number; content: string }>;
    let standaloneWrites: Array<{ libraryID: number; collections?: number[] }>;
    let restoreWriter: (() => void) | null = null;

    beforeEach(function () {
      itemWrites = [];
      standaloneWrites = [];
      restoreWriter = configureAssistantNoteWriter({
        writeItemNote: async (params) => {
          itemWrites.push({
            itemId: params.item.id,
            content: params.content,
          });
          return { status: "created", noteId: 100 };
        },
        writeStandaloneNote: async (params) => {
          standaloneWrites.push({
            libraryID: params.libraryID,
            collections: params.collections,
          });
          return { status: "standalone_created", noteId: 200 };
        },
      });
    });

    afterEach(function () {
      restoreWriter?.();
      restoreWriter = null;
    });

    it("files a standalone note into the library and collections it was given", async function () {
      installZotero();

      const result = await capability().saveAnswerToNote({
        item: null,
        libraryID: 4,
        content: "Answer",
        modelName: "test-model",
        target: "standalone",
        collections: [7, 8],
      });

      assert.equal(result.status, "standalone_created");
      assert.equal(result.noteId, 200);
      assert.deepEqual(standaloneWrites, [
        { libraryID: 4, collections: [7, 8] },
      ]);
      assert.lengthOf(itemWrites, 0);
    });

    it("falls back to the active item's library for a standalone note", async function () {
      installZotero();

      await capability().saveAnswerToNote({
        item: { id: 1, libraryID: 9 } as unknown as Zotero.Item,
        content: "Answer",
        modelName: "test-model",
        target: "standalone",
      });

      assert.equal(standaloneWrites[0].libraryID, 9);
    });

    it("writes a child note on the active item", async function () {
      installZotero();

      const result = await capability().saveAnswerToNote({
        item: { id: 1, libraryID: 1 } as unknown as Zotero.Item,
        content: "Answer",
        modelName: "test-model",
      });

      assert.equal(result.status, "created");
      assert.deepEqual(itemWrites, [{ itemId: 1, content: "Answer" }]);
      assert.lengthOf(standaloneWrites, 0);
    });

    it("refuses a child note when no item is active", async function () {
      installZotero();

      let message = "";
      try {
        await capability().saveAnswerToNote({
          item: null,
          content: "Answer",
          modelName: "test-model",
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      assert.include(message, "No Zotero item is active");
      assert.lengthOf(itemWrites, 0);
    });
  });
});

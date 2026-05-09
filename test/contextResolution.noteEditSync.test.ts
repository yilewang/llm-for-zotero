import { assert } from "chai";
import {
  getSelectedTextContextEntries,
  setSelectedTextContextEntries,
  syncSelectedTextContextForSource,
} from "../src/modules/contextPanel/contextResolution";

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
      syncSelectedTextContextForSource(
        itemId,
        "Edit this sentence",
        "note-edit",
      ),
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
      syncSelectedTextContextForSource(
        itemId,
        "Tighten this wording",
        "note-edit",
      ),
    );
    assert.isFalse(
      syncSelectedTextContextForSource(
        itemId,
        "Tighten this wording",
        "note-edit",
      ),
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

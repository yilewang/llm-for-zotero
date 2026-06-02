import { assert } from "chai";
import { buildInlineEditRetryContextSnapshot } from "../src/modules/contextPanel/setupHandlers/controllers/inlineEditRetryController";
import type {
  CollectionContextRef,
  PaperContextRef,
  SelectedTextContext,
  TagContextRef,
} from "../src/modules/contextPanel/types";

describe("inlineEditRetryController", function () {
  it("carries selected collection and tag contexts through inline edit retry", function () {
    const paperContext: PaperContextRef = {
      itemId: 12,
      contextItemId: 34,
      title: "Pinned paper",
    };
    const selectedContexts: SelectedTextContext[] = [
      {
        text: "quoted passage",
        source: "pdf",
        paperContext,
      },
    ];
    const selectedCollectionContexts: CollectionContextRef[] = [
      {
        collectionId: 55,
        libraryID: 1,
        name: "Computational_Psychiatry",
      },
    ];
    const selectedTagContexts: TagContextRef[] = [
      {
        name: "Stable",
        normalizedName: "stable",
        libraryID: 1,
      },
    ];

    const snapshot = buildInlineEditRetryContextSnapshot({
      selectedContexts,
      selectedCollectionContexts,
      selectedTagContexts,
    });

    assert.deepEqual(snapshot.selectedTexts, ["quoted passage"]);
    assert.deepEqual(snapshot.selectedTextPaperContexts, [paperContext]);
    assert.deepEqual(
      snapshot.selectedCollectionContexts,
      selectedCollectionContexts,
    );
    assert.notStrictEqual(
      snapshot.selectedCollectionContexts,
      selectedCollectionContexts,
    );
    assert.deepEqual(snapshot.selectedTagContexts, selectedTagContexts);
    assert.notStrictEqual(snapshot.selectedTagContexts, selectedTagContexts);
  });
});

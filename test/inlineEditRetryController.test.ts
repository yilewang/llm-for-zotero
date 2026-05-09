import { assert } from "chai";
import { buildInlineEditRetryContextSnapshot } from "../src/modules/contextPanel/setupHandlers/controllers/inlineEditRetryController";
import type {
  CollectionContextRef,
  PaperContextRef,
  SelectedTextContext,
} from "../src/modules/contextPanel/types";

describe("inlineEditRetryController", function () {
  it("carries selected collection contexts through inline edit retry", function () {
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

    const snapshot = buildInlineEditRetryContextSnapshot({
      selectedContexts,
      selectedCollectionContexts,
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
  });
});

import { assert } from "chai";
import { buildMetadataInverse } from "../src/agent/services/libraryMutation/forwardExecutionSupport";
import type { EditableArticleMetadataSnapshot } from "../src/agent/services/libraryMutation/valueTypes";

describe("metadata edit undo", function () {
  const snapshot = {
    itemId: 7,
    itemType: "journalArticle",
    title: "A paper",
    fields: { title: "A paper", extra: "before", date: "2020" },
    creators: [{ creatorType: "author", firstName: "Ada", lastName: "L" }],
  } as unknown as EditableArticleMetadataSnapshot;

  // The undo re-reads the fields its inverse names and compares them with
  // the edit's post-image, which holds only the fields the edit set. An
  // inverse naming every field never matched, so no metadata edit undid.
  it("restores only the fields the edit set", function () {
    const inverse = buildMetadataInverse(snapshot, { extra: "after" });
    assert.deepEqual(inverse.inverseOperations, [
      { type: "update_metadata", itemId: 7, metadata: { extra: "before" } },
    ]);
  });

  it("restores the creators when the edit set them", function () {
    const inverse = buildMetadataInverse(snapshot, {
      date: "2021",
      creators: [],
    });
    assert.deepEqual(inverse.inverseOperations, [
      {
        type: "update_metadata",
        itemId: 7,
        metadata: { date: "2020", creators: snapshot.creators },
      },
    ]);
  });
});

import { assert } from "chai";
import {
  CHECKPOINT_THRESHOLD,
  checkpointedParts,
  describeCheckpointedBatch,
  remainingOperations,
} from "../src/agent/services/checkpointedBatch";
import type { LibraryMutationOperation } from "../src/agent/services/libraryMutationService";

const ids = (count: number) =>
  Array.from({ length: count }, (_, index) => index + 1);

describe("checkpointed bulk edits", function () {
  it("leaves an edit of 50 items alone and splits one of 51 into one part per item", function () {
    const tags = (count: number): LibraryMutationOperation => ({
      type: "apply_tags",
      itemIds: ids(count),
      tags: ["x"],
    });
    assert.isNull(checkpointedParts([tags(CHECKPOINT_THRESHOLD)]));
    const parts = checkpointedParts([tags(CHECKPOINT_THRESHOLD + 1)]);
    assert.lengthOf(parts || [], 51);
    assert.deepEqual(parts?.[3], {
      source: 0,
      operation: { type: "apply_tags", itemIds: [4], tags: ["x"] },
    });
  });

  it("counts items across a call's operations and keeps each part's source", function () {
    const operations = ids(60).map(
      (itemId): LibraryMutationOperation => ({
        type: "update_metadata",
        itemId,
        metadata: { extra: "e" },
      }),
    );
    const parts = checkpointedParts(operations);
    assert.lengthOf(parts || [], 60);
    assert.equal(parts?.[59].source, 59);
  });

  it("leaves operations outside the checkpointed edits alone", function () {
    assert.isNull(
      checkpointedParts([{ type: "trash_items", itemIds: ids(80) }]),
    );
  });

  it("owes the frozen operations no done step accounts for, once each", function () {
    const frozen: LibraryMutationOperation[] = [1, 2, 2, 3].map((itemId) => ({
      type: "apply_tags",
      itemIds: [itemId],
      tags: ["x"],
    }));
    const step = (status: string, itemId: number) => ({
      status: status as never,
      // Key order differs from the frozen list's; the match is canonical.
      forwardJson: JSON.stringify({
        tags: ["x"],
        itemIds: [itemId],
        type: "apply_tags",
      }),
    });
    assert.deepEqual(
      remainingOperations(frozen, [
        step("applied", 1),
        step("applied", 2),
        step("failed", 3),
        step("uncertain", 3),
      ]),
      frozen.slice(2),
    );
  });

  it("names what was done and what remains", function () {
    const report = {
      batchId: "action-1",
      total: 120,
      done: 59,
      changed: 59,
      failed: [{ itemIds: [7], error: "Item 7 could not be resolved" }],
      notStarted: 60,
      stopped: true,
      resumable: true,
    };
    assert.equal(
      describeCheckpointedBatch(report),
      "Changed 59 items; 59 of 120 done. Stopped by the user; 60 items not started. Failed: item 7: Item 7 could not be resolved. 61 remain. To continue, call library_update with kind and resumeBatchId only: resumeBatchId:'action-1'. Done items are skipped.",
    );
    assert.include(
      describeCheckpointedBatch({ ...report, changed: 0, resumable: false }),
      "No item was changed, so send the same call again.",
    );
  });
});

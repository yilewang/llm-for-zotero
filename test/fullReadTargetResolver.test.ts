import { assert } from "chai";
import {
  resolveFullReadPaperTargets,
  FullReadTargetResolutionError,
} from "../src/shared/fullReadTargetResolver";
import type { PaperContextRef } from "../src/shared/types";
const papers = [
  { itemId: 1, contextItemId: 11, title: "Paper one" },
  { itemId: 2, contextItemId: 22, title: "Paper two" },
] as PaperContextRef[];
const context = {
  availablePapers: papers,
  selectedPapers: [papers[1]],
  activePaper: papers[0],
};

describe("structured full-read target resolution", function () {
  it("resolves active, selected and available sets exactly", function () {
    assert.deepEqual(
      resolveFullReadPaperTargets({ ...context, selection: { kind: "active" } })
        .papers,
      [papers[0]],
    );
    assert.deepEqual(
      resolveFullReadPaperTargets({
        ...context,
        selection: { kind: "selected" },
      }).papers,
      [papers[1]],
    );
    assert.deepEqual(
      resolveFullReadPaperTargets({
        ...context,
        selection: { kind: "available" },
      }).papers,
      papers,
    );
  });
  it("resolves exact IDs without broadening to another visible paper", function () {
    assert.deepEqual(
      resolveFullReadPaperTargets({
        ...context,
        selection: { kind: "item_ids", itemIds: [2, 2] },
      }).papers,
      [papers[1]],
    );
  });
  for (const itemIds of [[], [3], [1, 3], [NaN]]) {
    it(`rejects unresolved selection ${JSON.stringify(itemIds)}`, function () {
      assert.throws(
        () =>
          resolveFullReadPaperTargets({
            ...context,
            selection: { kind: "item_ids", itemIds },
          }),
        FullReadTargetResolutionError,
      );
    });
  }
});

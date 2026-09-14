import { assert } from "chai";
import {
  captureBatchInteraction,
  restoreBatchInteraction,
} from "../src/agent/actions/batchInteraction";

describe("durable action interaction", function () {
  it("preserves separate review choices for two actions of the same operation", function () {
    const request = {
      actionContract: {
        obligations: [
          {
            id: "edit-a",
            operation: "note_edit",
            reviewPreference: "review",
            parameters: { targetNoteId: 1 },
          },
          {
            id: "edit-b",
            operation: "note_edit",
            reviewPreference: "direct",
            parameters: { targetNoteId: 2 },
          },
        ],
      },
    } as any;
    const stored = captureBatchInteraction(request);
    const resumed = JSON.parse(JSON.stringify(request));
    resumed.actionContract.obligations.forEach(
      (entry: any) => (entry.reviewPreference = "default"),
    );
    assert.deepEqual(
      restoreBatchInteraction(resumed, stored).actionContract?.obligations.map(
        (entry) => entry.reviewPreference,
      ),
      ["review", "direct"],
    );
  });
  it("keeps untrusted legacy checkpoints under review", function () {
    const request = {
      actionContract: {
        obligations: [
          { id: "a", operation: "apply_tags", reviewPreference: "default" },
        ],
      },
    } as any;
    assert.equal(
      restoreBatchInteraction(request, undefined).actionContract?.obligations[0]
        .reviewPreference,
      "review",
    );
  });
});

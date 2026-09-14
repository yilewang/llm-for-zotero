import { assert } from "chai";
import { resolveActionInteraction } from "../src/agent/authorization/interaction";

describe("interaction compatibility", function () {
  it("treats an executing-plan obligation without a stated preference as default", function () {
    const request = {
      planContext: { phase: "executing" },
      actionContract: {
        obligations: [
          { operation: "note_edit", parameters: { targetNoteId: 1 } },
        ],
      },
    } as any;
    const proposals = [
      { operation: "note_edit", requestedTargets: ["item:1"] },
    ] as any;
    assert.equal(
      resolveActionInteraction(request, proposals).reviewPreference,
      "default",
    );
    request.actionContract.obligations[0].reviewPreference = "review";
    assert.equal(
      resolveActionInteraction(request, proposals).reviewPreference,
      "review",
    );
  });
  it("does not pause another note action because review was requested for a different note", function () {
    const request = {
      actionContract: {
        obligations: [
          {
            operation: "note_edit",
            parameters: { targetNoteId: 1 },
            reviewPreference: "review",
          },
          {
            operation: "note_edit",
            parameters: { targetNoteId: 2 },
            reviewPreference: "default",
          },
        ],
      },
    } as any;
    assert.equal(
      resolveActionInteraction(request, [
        { operation: "note_edit", requestedTargets: ["item:2"] },
      ] as any).reviewPreference,
      "default",
    );
  });
});

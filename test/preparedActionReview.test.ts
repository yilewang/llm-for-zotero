import { assert } from "chai";
import { resolvePreparedActionReview } from "../src/agent/tools/execution/review";

describe("shared prepared-action review", function () {
  it("returns navigation and edited-field selections to the built-in action without inventing approval", async function () {
    let confirmations = 0,
      executions = 0;
    const resolution = {
      approved: false,
      actionId: "next",
      data: { pageSize: "20" },
    };
    const prepared = {
      kind: "confirmation",
      requestId: "review-1",
      action: { title: "Tags" },
      execute: async (value: unknown) => {
        assert.deepEqual(value, resolution);
        executions++;
        return {
          kind: "result",
          execution: { result: { ok: true, content: { updatedCount: 0 } } },
        };
      },
    } as any;
    const result = await resolvePreparedActionReview(prepared, async () => {
      confirmations++;
      return resolution;
    });
    assert.equal(confirmations, 1);
    assert.equal(executions, 1);
    assert.deepInclude(result.result.content, {
      confirmationActionId: "next",
      confirmationData: { pageSize: "20" },
    });
  });
});

import { assert } from "chai";
import { parseRouterDecision } from "../src/modules/contextPanel/Agent/router";

describe("agent router", function () {
  it("parses a stop decision", function () {
    const decision = parseRouterDecision(
      JSON.stringify({
        decision: "stop",
        trace: "Enough context already.",
        stopReason: "sufficient_context",
      }),
    );

    assert.equal(decision.decision, "stop");
    assert.equal(decision.trace, "Enough context already.");
    if (decision.decision === "stop") {
      assert.equal(decision.stopReason, "sufficient_context");
    }
  });

  it("parses a valid tool call decision", function () {
    const decision = parseRouterDecision(
      JSON.stringify({
        decision: "tool_call",
        trace: "Read library metadata first.",
        call: {
          name: "list_papers",
          query: "hippocampus",
          limit: 6,
          depth: "metadata",
        },
      }),
    );

    assert.equal(decision.decision, "tool_call");
    if (decision.decision !== "tool_call") return;
    assert.equal(decision.call.name, "list_papers");
    assert.equal(decision.call.depth, "metadata");
  });

  it("falls back to stop when call is invalid", function () {
    const decision = parseRouterDecision(
      JSON.stringify({
        decision: "tool_call",
        trace: "Malformed call",
        call: {
          name: "list_papers",
          query: "hippocampus",
          depth: "fulltext",
        },
      }),
    );

    assert.equal(decision.decision, "stop");
    if (decision.decision === "stop") {
      assert.match(
        decision.stopReason || "",
        /(validation|shape)/i,
      );
    }
  });
});

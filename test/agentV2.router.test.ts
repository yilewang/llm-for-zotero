import { assert } from "chai";
import { parseRouterDecision } from "../src/modules/contextPanel/Agent/V2/router";

describe("agentV2 router", function () {
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
        trace: "Read method section first.",
        call: {
          name: "get_paper_sections",
          target: { scope: "active-paper" },
        },
      }),
    );

    assert.equal(decision.decision, "tool_call");
    if (decision.decision !== "tool_call") return;
    assert.equal(decision.call.name, "get_paper_sections");
    assert.deepEqual(decision.call.target, { scope: "active-paper" });
  });

  it("falls back to stop when call is invalid", function () {
    const decision = parseRouterDecision(
      JSON.stringify({
        decision: "tool_call",
        trace: "Malformed call",
        call: {
          name: "search_paper_content",
          target: { scope: "active-paper" },
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

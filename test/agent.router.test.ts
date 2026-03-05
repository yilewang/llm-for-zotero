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

  it("recovers a top-level tool call shape when decision key is missing", function () {
    const decision = parseRouterDecision(
      JSON.stringify({
        trace: "Search paper content",
        name: "search_paper_content",
        target: { scope: "active-paper" },
        query: "olfactory stimulus",
      }),
    );

    assert.equal(decision.decision, "tool_call");
    if (decision.decision !== "tool_call") return;
    assert.equal(decision.call.name, "search_paper_content");
    assert.equal(decision.call.query, "olfactory stimulus");
  });

  it("recovers wrapped tool call shapes under tool/action keys", function () {
    const decision = parseRouterDecision(
      JSON.stringify({
        decision: "call",
        trace: "Use wrapper",
        tool: {
          name: "list_papers",
          query: "hippocampus",
          depth: "metadata",
          limit: 6,
        },
      }),
    );

    assert.equal(decision.decision, "tool_call");
    if (decision.decision !== "tool_call") return;
    assert.equal(decision.call.name, "list_papers");
    assert.equal(decision.call.depth, "metadata");
  });

  it("preserves optional query for find_claim_evidence calls", function () {
    const decision = parseRouterDecision(
      JSON.stringify({
        decision: "tool_call",
        trace: "Find focused evidence",
        call: {
          name: "find_claim_evidence",
          target: { scope: "active-paper" },
          query: "olfactory stimulus use in mice",
        },
      }),
    );

    assert.equal(decision.decision, "tool_call");
    if (decision.decision !== "tool_call") return;
    assert.equal(decision.call.name, "find_claim_evidence");
    assert.equal(decision.call.query, "olfactory stimulus use in mice");
  });
});

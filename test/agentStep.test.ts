import { assert } from "chai";
import {
  findAgentPlanJsonObject,
  parseAgentStepDecision,
} from "../src/modules/contextPanel/Agent/step";

describe("agentStep", function () {
  describe("findAgentPlanJsonObject", function () {
    it("extracts the first top-level JSON object", function () {
      const raw =
        'Here is the plan:\n{"decision":"tool","call":{"name":"list_papers"},"traceLines":["Search."]}\nDone.';
      const jsonText = findAgentPlanJsonObject(raw);
      assert.include(jsonText, '"decision":"tool"');
    });

    it("returns empty string when no JSON object is present", function () {
      assert.equal(findAgentPlanJsonObject("No JSON here."), "");
    });

    it("ignores a { inside a string value", function () {
      const raw = '{"decision":"stop","traceLines":["brace { test"]}'
      const jsonText = findAgentPlanJsonObject(raw);
      assert.include(jsonText, '"decision":"stop"');
    });

    it("handles nested JSON objects", function () {
      const raw = '{"decision":"tool","call":{"name":"read_paper_text","target":{"scope":"active-paper"}},"traceLines":[]}';
      const jsonText = findAgentPlanJsonObject(raw);
      assert.include(jsonText, '"name":"read_paper_text"');
    });
  });

  describe("parseAgentStepDecision", function () {
    it("parses a stop decision", function () {
      const decision = parseAgentStepDecision(
        JSON.stringify({
          decision: "stop",
          traceLines: ["I have enough context."],
          call: null,
        }),
      );
      assert.equal(decision.type, "stop");
      assert.deepEqual(decision.traceLines, ["I have enough context."]);
    });

    it("parses a list_papers tool decision", function () {
      const decision = parseAgentStepDecision(
        JSON.stringify({
          decision: "tool",
          traceLines: ["Searching the library."],
          call: { name: "list_papers", query: "memory consolidation", limit: 5 },
        }),
      );
      assert.equal(decision.type, "tool");
      if (decision.type !== "tool") return;
      assert.equal(decision.call.name, "list_papers");
      assert.equal(decision.call.query, "memory consolidation");
      assert.equal(decision.call.limit, 5);
    });

    it("parses a read_paper_text tool decision with indexed target", function () {
      const decision = parseAgentStepDecision(
        JSON.stringify({
          decision: "tool",
          traceLines: ["Read the top paper."],
          call: { name: "read_paper_text", target: { scope: "retrieved-paper", index: 1 } },
        }),
      );
      assert.equal(decision.type, "tool");
      if (decision.type !== "tool") return;
      assert.equal(decision.call.name, "read_paper_text");
      assert.deepEqual(decision.call.target, { scope: "retrieved-paper", index: 1 });
    });

    it("parses an active-paper scoped target", function () {
      const decision = parseAgentStepDecision(
        JSON.stringify({
          decision: "tool",
          traceLines: [],
          call: { name: "read_paper_text", target: { scope: "active-paper" } },
        }),
      );
      assert.equal(decision.type, "tool");
      if (decision.type !== "tool") return;
      assert.deepEqual(decision.call.target, { scope: "active-paper" });
    });

    it("falls back to stop on invalid JSON", function () {
      const decision = parseAgentStepDecision("{not-valid-json");
      assert.equal(decision.type, "stop");
      assert.isArray(decision.traceLines);
    });

    it("falls back to stop on unknown decision field", function () {
      const decision = parseAgentStepDecision(
        JSON.stringify({ decision: "fly", traceLines: [] }),
      );
      assert.equal(decision.type, "stop");
    });

    it("falls back to stop when tool decision lacks a valid call", function () {
      const decision = parseAgentStepDecision(
        JSON.stringify({
          decision: "tool",
          traceLines: [],
          call: { name: "unknown_tool", target: { scope: "active-paper" } },
        }),
      );
      assert.equal(decision.type, "stop");
    });

    it("falls back to stop when indexed target has index < 1", function () {
      const decision = parseAgentStepDecision(
        JSON.stringify({
          decision: "tool",
          traceLines: [],
          call: { name: "read_paper_text", target: { scope: "retrieved-paper", index: 0 } },
        }),
      );
      assert.equal(decision.type, "stop");
    });

    it("clamps trace lines to at most 4 items", function () {
      const decision = parseAgentStepDecision(
        JSON.stringify({
          decision: "stop",
          traceLines: ["a", "b", "c", "d", "e", "f"],
        }),
      );
      assert.isAtMost(decision.traceLines.length, 4);
    });

    it("defaults list_papers limit to 6 when not provided", function () {
      const decision = parseAgentStepDecision(
        JSON.stringify({
          decision: "tool",
          traceLines: [],
          call: { name: "list_papers" },
        }),
      );
      assert.equal(decision.type, "tool");
      if (decision.type !== "tool") return;
      assert.equal(decision.call.limit, 6);
    });
  });
});

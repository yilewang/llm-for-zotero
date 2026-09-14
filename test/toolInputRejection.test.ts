import { assert } from "chai";
import { ToolInputRejection } from "../src/agent/tools/execution/failure";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type { AgentToolContext } from "../src/agent/types";
import { classifiedFixture } from "./helpers/semanticIntent";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

describe("tool input rejections raised during execution", function () {
  const context: AgentToolContext = {
    request: resolvedAgentRequest({
      classifiedIntent: classifiedFixture(),
      conversationKey: 91,
      mode: "agent",
      userText: "record",
      libraryID: 1,
    }),
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  };

  it("marks a refused payload as an input rejection, not a failing tool", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "research_update",
        description: "persist understanding",
        inputSchema: { type: "object" },
        executionClass: "control",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args }),
      execute: async (input: { phaseError?: boolean }) => {
        if (input.phaseError)
          throw new ToolInputRejection(
            "record_edges is available in the links phase; the loop is in the nodes phase",
          );
        throw new Error("the research store is unavailable");
      },
    });
    const rejected = await registry.prepareExecution(
      { id: "c1", name: "research_update", arguments: { phaseError: true } },
      context,
    );
    assert.equal(rejected.kind, "result");
    if (rejected.kind !== "result") return;
    assert.isFalse(rejected.execution.result.ok);
    assert.isTrue(rejected.execution.result.inputRejected);
    assert.match(
      String((rejected.execution.result.content as { error: string }).error),
      /links phase/,
    );
    const failed = await registry.prepareExecution(
      { id: "c2", name: "research_update", arguments: {} },
      context,
    );
    assert.equal(failed.kind, "result");
    if (failed.kind !== "result") return;
    assert.isFalse(failed.execution.result.ok);
    assert.isUndefined(failed.execution.result.inputRejected);
  });
});

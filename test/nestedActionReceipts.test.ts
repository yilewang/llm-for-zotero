import { assert } from "chai";
import { AgentToolRegistry } from "../src/agent/tools/registry";

describe("shared action execution results", function () {
  it("preserves exact child receipts for a control workflow and its Plan task", async function () {
    const registry = new AgentToolRegistry();
    const receipt = {
      id: "verified-child",
      obligationId: "tag-paper",
      verification: "verified",
      operation: "apply_tags",
      proofDomain: "zotero_state",
      completedTargets: ["item:1"],
    } as any;
    registry.register({
      spec: {
        name: "prepared_workflow",
        description: "fixture",
        executionClass: "control",
        requiresConfirmation: false,
        inputSchema: { type: "object" },
      },
      validate: (args) => ({ ok: true, value: args }),
      execute: async (_input, context) => {
        context.recordChildExecution?.({
          callId: "child-call",
          name: "apply_tags",
          ok: true,
          effect: "applied",
          actionReceipts: [receipt],
          content: {},
        });
        return { prepared: true };
      },
    });
    const prepared = await registry.prepareExecution(
      { id: "parent", name: "prepared_workflow", arguments: {} },
      {
        request: {
          conversationKey: 1,
          mode: "agent",
          userText: "Tag this paper",
        },
        item: null,
        currentAnswerText: "",
        modelName: "fixture",
      } as any,
    );
    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") throw new Error("Unexpected review");
    assert.deepEqual(prepared.execution.result.actionReceipts, [receipt]);
    assert.equal(prepared.execution.result.effect, "applied");
  });
});

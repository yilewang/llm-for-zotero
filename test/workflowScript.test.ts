import { AgentToolRegistry } from "../src/agent/tools/registry";
import { assert } from "chai";
import { createWorkflowScriptTool } from "../src/agent/tools/control/workflowScript";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

const specs = [
  {
    name: "collection_update",
    description: "Manage collections",
    inputSchema: { type: "object" },
    executionClass: "external_effect" as const,
  },
  {
    name: "library_update",
    description: "Update papers",
    inputSchema: { type: "object" },
    executionClass: "external_effect" as const,
  },
];

describe("registered-operation scripting", function () {
  let originalZotero: unknown;
  beforeEach(function () {
    originalZotero = globalThis.Zotero;
    globalThis.Zotero = { debug: () => undefined } as any;
  });
  afterEach(function () {
    globalThis.Zotero = originalZotero as any;
  });
  it("carries returned native identities through a loop and returns ordinary operation receipts", async function () {
    const calls: any[] = [];
    const tool = createWorkflowScriptTool(() => specs, {
      allowUnsandboxedTestExecution: true,
    });
    const validated = tool.validate({
      description: "Create a collection and file papers",
      script:
        'const folder = await env.invoke("collection_update", {action:"create",name:"Destination"}); for (const id of [42,43]) { const result = await env.invoke("library_update", {kind:"collections",action:"add",itemIds:[id],targetCollectionId:folder.content.collectionId}); if (!result.ok) return result; } return folder.content.collectionId;',
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const result: any = await tool.execute(validated.value, {
      request: resolvedAgentRequest({
        conversationKey: 42,
        mode: "agent",
        userText: "Create Destination and file papers 42 and 43",
        libraryID: 1,
      }),
      item: null,
      currentAnswerText: "",
      modelName: "test",
      invokeRegisteredOperation: async (name: string, args: unknown) => {
        calls.push({ name, args });
        return {
          callId: `op:${calls.length}`,
          name,
          ok: true,
          content: { collectionId: 91 },
          actionReceipts: [
            { id: `receipt:${calls.length}`, verification: "verified" },
          ],
        };
      },
    } as any);
    assert.equal(
      result.content.returnValue,
      91,
      JSON.stringify(result.content),
    );
    assert.lengthOf(calls, 3);
    assert.deepEqual(calls[1].args.itemIds, [42]);
    assert.equal(calls[2].args.targetCollectionId, 91);
    assert.lengthOf(result.content.operations, 3);
    assert.equal(
      result.content.operations[2].actionReceipts[0].id,
      "receipt:3",
    );
  });
  it("rejects unknown operations and unchanged rejected proposals without executing them", async function () {
    let invoked = 0;
    const tool = createWorkflowScriptTool(() => specs, {
      allowUnsandboxedTestExecution: true,
    });
    const validated = tool.validate({
      description: "Handle an invalid operation",
      script:
        'await env.invoke("library_update",{bad:true}); await env.invoke("library_update",{bad:true}); return await env.invoke("missing_tool",{});',
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    let failure = "";
    try {
      await tool.execute(validated.value, {
        request: resolvedAgentRequest({
          conversationKey: 42,
          mode: "agent",
          userText: "Update paper",
          libraryID: 1,
        }),
        item: null,
        currentAnswerText: "",
        modelName: "test",
        invokeRegisteredOperation: async (name: string) => {
          invoked++;
          return {
            callId: "rejected",
            name,
            ok: false,
            content: { error: "Invalid argument", code: "invalid_argument" },
            actionReceipts: [],
          };
        },
      } as any);
    } catch (error) {
      failure = String(error);
    }
    assert.equal(invoked, 1);
    assert.include(failure, "unchanged rejected");
  });
  it("reports a script exception as a failed tool result through the registry", async function () {
    const tool = createWorkflowScriptTool(() => specs, {
      allowUnsandboxedTestExecution: true,
    });
    const registry = new AgentToolRegistry();
    registry.register(tool);
    const execution = await registry.prepareExecution(
      {
        id: "script-failure",
        name: "workflow_script",
        arguments: {
          description: "Resolve a conditional workflow",
          script: 'throw new Error("Missing conditional input");',
        },
      },
      {
        request: resolvedAgentRequest({
          conversationKey: 42,
          mode: "agent",
          userText: "File paper",
          libraryID: 1,
        }),
        item: null,
        currentAnswerText: "",
        modelName: "test",
        invokeRegisteredOperation: async () => {
          throw new Error("Must not execute");
        },
      },
    );
    assert.equal(execution.kind, "result");
    if (execution.kind !== "result") return;
    assert.isFalse(
      execution.execution.result.ok,
      "The runner must see a failed script, not a successful progress step",
    );
    assert.include(
      String((execution.execution.result.content as any).error),
      "Missing conditional input",
    );
  });
  it("fails closed without the registered execution bridge", async function () {
    const tool = createWorkflowScriptTool(() => specs, {
      allowUnsandboxedTestExecution: true,
    });
    const validated = tool.validate({
      description: "File papers",
      script: 'return await env.invoke("library_update",{});',
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    let error = "";
    try {
      await tool.execute(validated.value, {
        request: resolvedAgentRequest({
          conversationKey: 42,
          mode: "agent",
          userText: "File papers",
          libraryID: 1,
        }),
        item: null,
        currentAnswerText: "",
        modelName: "test",
      });
    } catch (e) {
      error = String(e);
    }
    assert.include(error, "registered operation execution");
  });
});

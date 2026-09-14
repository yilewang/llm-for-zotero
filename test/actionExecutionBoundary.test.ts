import { assert } from "chai";
import { buildActionExecutionContext } from "../src/agent/actions/toolContextBridge";
import { callTool } from "../src/agent/actions/executor";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

describe("conversational built-in action boundary", function () {
  it("retains Plan preparation, cancellation, and durable grant checkpointing through child writes", async function () {
    const abort = new AbortController();
    const checkpoint = async () => undefined;
    const original = {
      request: resolvedAgentRequest({
        conversationKey: 41,
        mode: "agent",
        userText: "Prepare a plan to tag papers",
        planContext: { phase: "planning" } as any,
      }),
      runId: "current-turn",
      signal: abort.signal,
      checkpointActionProgress: checkpoint,
    } as any;
    let received: any, options: any;
    const registry = {
      prepareExecution: async (_call: any, context: any, opts: any) => {
        received = context;
        options = opts;
        return {
          kind: "result",
          execution: { result: { ok: true, content: {} } },
        };
      },
    } as any;
    const ctx = buildActionExecutionContext({
      context: original,
      registry,
      zoteroGateway: {} as any,
      confirmationMode: "automatic",
    });
    await callTool("apply_tags", { itemId: 1 }, ctx);
    assert.deepEqual(
      received.request.planContext,
      original.request.planContext,
      "Child writes must see the read-only Plan preparation boundary",
    );
    assert.equal(received.signal, abort.signal);
    assert.equal(received.checkpointActionProgress, checkpoint);
    assert.equal(received.runId, "current-turn");
    assert.equal(
      options.callerKind,
      "model",
      "Natural-language actions retain automatic authority rather than claiming a UI invocation",
    );
    assert.isFunction(options.executeWithLock);
  });
});

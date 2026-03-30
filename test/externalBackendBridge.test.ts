import { assert } from "chai";
import { createExternalBackendBridgeRuntime } from "../src/agent/externalBackendBridge";
import type { AgentRuntimeOutcome } from "../src/agent/types";

function makeCoreRuntime() {
  const outcome: AgentRuntimeOutcome = {
    kind: "completed",
    runId: "core-run",
    text: "core-text",
    usedFallback: false,
  };

  return {
    listTools: () => [],
    getToolDefinition: () => undefined,
    unregisterTool: () => false,
    registerTool: () => undefined,
    registerPendingConfirmation: () => undefined,
    resolveConfirmation: async () => false,
    getRunTrace: async () => undefined,
    getCapabilities: () => ({
      streaming: true,
      toolCalls: false,
      multimodal: false,
      fileInputs: false,
      reasoning: false,
    }),
    runTurn: async () => outcome,
  };
}

describe("external backend bridge runtime", function () {
  it("delegates to core runtime when bridge url is empty", async function () {
    const core = makeCoreRuntime();
    const runtime = createExternalBackendBridgeRuntime({
      coreRuntime: core as any,
      getBridgeUrl: () => "",
    });

    const outcome = await runtime.runTurn({
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "hello",
      } as any,
    });

    assert.equal(outcome.kind, "completed");
    assert.equal((outcome as any).runId, "core-run");
    assert.isFalse(runtime.getCapabilities({} as any).toolCalls);
  });

  it("streams runTurn events from bridge endpoint when url is set", async function () {
    const core = makeCoreRuntime();
    const lines = [
      JSON.stringify({ type: "start", runId: "bridge-run" }),
      JSON.stringify({ type: "event", event: { type: "status", text: "running" } }),
      JSON.stringify({
        type: "outcome",
        outcome: {
          kind: "completed",
          runId: "bridge-run",
          text: "bridge-text",
          usedFallback: false,
        },
      }),
    ].join("\n");

    const fetchBackup = (globalThis as any).fetch;
    (globalThis as any).fetch = async () =>
      new Response(lines, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });

    try {
      const runtime = createExternalBackendBridgeRuntime({
        coreRuntime: core as any,
        getBridgeUrl: () => "http://127.0.0.1:9999",
      });

      const seen: string[] = [];
      const outcome = await runtime.runTurn({
        request: {
          conversationKey: 2,
          mode: "agent",
          userText: "hi",
        } as any,
        onStart: (runId) => {
          seen.push(`start:${runId}`);
        },
        onEvent: (event) => {
          seen.push(`event:${event.type}`);
        },
      });

      assert.equal(outcome.kind, "completed");
      assert.equal((outcome as any).runId, "bridge-run");
      assert.deepEqual(seen, ["start:bridge-run", "event:status"]);
      assert.isTrue(runtime.getCapabilities({} as any).toolCalls);
    } finally {
      (globalThis as any).fetch = fetchBackup;
    }
  });
});

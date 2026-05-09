import { assert } from "chai";
import { describe, it } from "mocha";
import { createExternalBackendBridgeRuntime } from "../src/agent/externalBackendBridge";

describe("external bridge action approval handling", function () {
  it("shows native confirmation even when cached tool metadata is absent", async function () {
    const originalFetch = globalThis.fetch;
    const originalZotero = (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero;
    const progressEvents: Array<{ type: string; requestId?: string }> = [];

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Prefs: {
        get(key: string) {
          if (key.endsWith("enableClaudeCodeMode")) return true;
          if (key.endsWith("agentClaudeConfigSource")) return "default";
          if (key.endsWith("agentPermissionMode")) return "safe";
          if (key.endsWith("conversationSystem")) return "claude_code";
          return "";
        },
      },
      Profile: {
        dir: "/tmp/llm-for-zotero-test-profile",
      },
    };

    globalThis.fetch = (async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              '{"type":"outcome","outcome":{"kind":"fallback","runId":"r1","reason":"approval_required","usedFallback":true}}\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200 }) as Response;
    }) as typeof fetch;

    try {
      const runtime = createExternalBackendBridgeRuntime({
        coreRuntime: {
          listTools: () => [],
          getToolDefinition: () => null,
          unregisterTool: () => undefined,
          registerTool: () => undefined,
          registerPendingConfirmation: () => undefined,
          resolveConfirmation: () => false,
          getRunTrace: () => [],
          getCapabilities: () => ({
            streaming: true,
            toolCalls: true,
            multimodal: true,
            fileInputs: true,
            reasoning: true,
          }),
          runTurn: async () => ({
            kind: "fallback",
            runId: "unused",
            reason: "unused",
            usedFallback: true,
          }),
        } as any,
        getBridgeUrl: () => "http://127.0.0.1:19787",
      });

      await runtime.runExternalAction("cc_tool::Read", { file_path: "README.md" }, {
        confirmationMode: "native_ui",
        onProgress: (event) => progressEvents.push(event as any),
        requestConfirmation: async () => ({ approved: false }),
      });

      assert.isTrue(progressEvents.some((event) => event.type === "confirmation_required"));
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = originalZotero;
    }
  });
});

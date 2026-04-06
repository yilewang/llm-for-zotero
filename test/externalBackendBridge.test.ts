import { assert } from "chai";
import {
  createExternalBackendBridgeRuntime,
  fetchExternalBridgeSessionInfo,
} from "../src/agent/externalBackendBridge";
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
      assert.deepEqual(seen, ["event:status", "start:bridge-run", "event:status"]);
      assert.isTrue(runtime.getCapabilities({} as any).toolCalls);
    } finally {
      (globalThis as any).fetch = fetchBackup;
    }
  });

  it("falls back to local runtime when bridge request fails", async function () {
    const core = makeCoreRuntime();
    const fetchBackup = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };

    try {
      const runtime = createExternalBackendBridgeRuntime({
        coreRuntime: core as any,
        getBridgeUrl: () => "http://127.0.0.1:18787",
      });
      const seen: string[] = [];
      const outcome = await runtime.runTurn({
        request: {
          conversationKey: 3,
          mode: "agent",
          userText: "fallback please",
        } as any,
        onEvent: (event) => {
          seen.push(event.type === "status" ? `status:${(event as any).text}` : event.type);
        },
      });

      assert.equal(outcome.kind, "completed");
      assert.equal((outcome as any).runId, "core-run");
      assert.isTrue(
        seen.some(
          (entry) =>
            entry.includes("External agent backend unavailable; fell back to local runtime") ||
            entry.includes("外部 Agent 后端不可用，已自动回退到本地模式"),
        ),
      );
    } finally {
      (globalThis as any).fetch = fetchBackup;
    }
  });

  it("loads backend tools and exposes them as external actions", async function () {
    const core = makeCoreRuntime();
    const fetchBackup = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes("/tools")) {
        return new Response(
          JSON.stringify({
            tools: [
              {
                name: "Read",
                description: "Read files",
                inputSchema: { type: "object", properties: { file_path: { type: "string" } } },
                mutability: "read",
                riskLevel: "low",
                requiresConfirmation: false,
                source: "claude-runtime",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    };

    try {
      const runtime = createExternalBackendBridgeRuntime({
        coreRuntime: core as any,
        getBridgeUrl: () => "http://127.0.0.1:9999",
      });
      await runtime.refreshExternalActions(true);
      const actions = runtime.listExternalActionsSync();
      assert.equal(actions.length, 1);
      assert.equal(actions[0].name, "cc_tool::Read");
      assert.equal(actions[0].source, "backend");
    } finally {
      (globalThis as any).fetch = fetchBackup;
    }
  });

  it("refreshes slash commands from /commands and exposes cached results", async function () {
    const core = makeCoreRuntime();
    const fetchBackup = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes("/commands")) {
        return new Response(
          JSON.stringify({
            commands: [
              {
                name: "debug",
                description: "Enable debug logging",
                argumentHint: "[issue]",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    };

    try {
      const runtime = createExternalBackendBridgeRuntime({
        coreRuntime: core as any,
        getBridgeUrl: () => "http://127.0.0.1:9999",
      });
      await runtime.refreshSlashCommands(true);
      const commands = runtime.listSlashCommandsSync();
      assert.equal(commands.length, 1);
      assert.equal(commands[0].name, "debug");
      assert.equal(commands[0].argumentHint, "[issue]");
    } finally {
      (globalThis as any).fetch = fetchBackup;
    }
  });

  it("prefers last run scope snapshot when querying session info", async function () {
    const core = makeCoreRuntime();
    const requests: string[] = [];
    const fetchBackup = (globalThis as any).fetch;
    (globalThis as any).fetch = async (input: string, init?: { method?: string }) => {
      requests.push(input);
      if (input.endsWith("/run-turn")) {
        const lines = [
          JSON.stringify({ type: "start", runId: "bridge-run-scope" }),
          JSON.stringify({
            type: "outcome",
            outcome: {
              kind: "completed",
              runId: "bridge-run-scope",
              text: "ok",
              usedFallback: false,
            },
          }),
        ].join("\n");
        return new Response(lines, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      if (input.includes("/session-info?")) {
        const url = new URL(input);
        const scopeType = url.searchParams.get("scopeType");
        const scopeId = url.searchParams.get("scopeId");
        if (scopeType === "paper" && scopeId === "1:42") {
          return new Response(
            JSON.stringify({
              session: {
                originalConversationKey: "42",
                scopedConversationKey: "42::paper:1:42",
                providerSessionId: "sess-from-paper",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            session: {
              originalConversationKey: "42",
              scopedConversationKey: "42::open:1",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    };

    try {
      const runtime = createExternalBackendBridgeRuntime({
        coreRuntime: core as any,
        getBridgeUrl: () => "http://127.0.0.1:9999",
      });
      await runtime.runTurn({
        request: {
          conversationKey: 42,
          mode: "agent",
          userText: "remember scope",
          scopeType: "paper",
          scopeId: "1:42",
          scopeLabel: "Paper 42",
        } as any,
      });

      const info = await fetchExternalBridgeSessionInfo({
        baseUrl: "http://127.0.0.1:9999",
        conversationKey: 42,
        scopeType: "open" as any,
        scopeId: "1",
        scopeLabel: "Open Chat",
      });

      assert.equal(info?.providerSessionId, "sess-from-paper");
      const sessionRequests = requests.filter((entry) => entry.includes("/session-info?"));
      assert.isTrue(sessionRequests.length >= 1);
      assert.isTrue(sessionRequests[0].includes("scopeType=paper"));
      assert.isTrue(sessionRequests[0].includes("scopeId=1%3A42"));
    } finally {
      (globalThis as any).fetch = fetchBackup;
    }
  });

  it("falls back to conversation-only session-info query when scoped query misses", async function () {
    const requests: string[] = [];
    const fetchBackup = (globalThis as any).fetch;
    (globalThis as any).fetch = async (input: string) => {
      requests.push(input);
      if (input.includes("/session-info?")) {
        const url = new URL(input);
        const hasScopeType = url.searchParams.has("scopeType");
        if (hasScopeType) {
          return new Response(
            JSON.stringify({
              session: {
                originalConversationKey: "77",
                scopedConversationKey: "77::paper:1:77",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            session: {
              originalConversationKey: "77",
              scopedConversationKey: "77",
              providerSessionId: "sess-from-conversation-only",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    };
    try {
      const info = await fetchExternalBridgeSessionInfo({
        baseUrl: "http://127.0.0.1:9999",
        conversationKey: 77,
        scopeType: "paper" as any,
        scopeId: "1:77",
        scopeLabel: "Paper 77",
      });
      assert.equal(info?.providerSessionId, "sess-from-conversation-only");
      const sessionRequests = requests.filter((entry) => entry.includes("/session-info?"));
      assert.isAtLeast(sessionRequests.length, 2);
      assert.isTrue(sessionRequests[0].includes("scopeType=paper"));
      assert.isFalse(sessionRequests[sessionRequests.length - 1].includes("scopeType="));
    } finally {
      (globalThis as any).fetch = fetchBackup;
    }
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeRuntimeAdapter } from "../src/bridge/claude-code-runtime-adapter.js";
import { Llm4ZoteroAgentBackendAdapter } from "../src/bridge/llm4zotero-agent-backend-adapter.js";
import {
  StructuredCompletionError,
  type ClaudeCodeRuntimeClient,
  type ProviderEvent,
} from "../src/runtime.js";
import { InMemorySessionMapper } from "../src/session-link/session-mapper.js";
import { startHttpBridgeServer } from "../src/server/http-bridge.js";

function providerEvents(events: ProviderEvent[]): AsyncIterable<ProviderEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

/** A runtime folder with one project slash command, so tool lists do not depend on ~/.claude. */
function createRuntimeWithCommand(): string {
  const runtimeCwd = mkdtempSync(join(tmpdir(), "bridge-tools-"));
  mkdirSync(join(runtimeCwd, ".claude", "commands"), { recursive: true });
  writeFileSync(
    join(runtimeCwd, ".claude", "commands", "summarize.md"),
    "---\ndescription: Summarize a paper\n---\nSummarize $ARGUMENTS\n",
  );
  return runtimeCwd;
}

async function readNdjsonLines(
  response: Response,
): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("http bridge server", () => {
  it("honors the host semantic deadline within the bounded completion limit", async () => {
    const deadlines: number[] = [];
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return { runId: "fixture", events: providerEvents([]) };
      },
      async completeStructured(request) {
        deadlines.push(request.timeoutMs);
        return { text: "{}" };
      },
    };
    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });
    const server = await startHttpBridgeServer({
      adapter: new Llm4ZoteroAgentBackendAdapter({ adapter: base }),
    });
    try {
      for (const timeoutMs of [180000, 300000, 900000]) {
        const response = await fetch(
          `http://${server.host}:${server.port}/structured-completion`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: "Interpret", timeoutMs }),
          },
        );
        expect(response.status).toBe(200);
      }
      expect(deadlines).toEqual([180000, 300000, 300000]);
    } finally {
      await server.close();
    }
  });

  it("answers a provider rate limit with 429 and other failures with 500, and passes usage through", async () => {
    let mode: "usage" | "rate" | "fail" = "usage";
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return { runId: "fixture", events: providerEvents([]) };
      },
      async completeStructured() {
        if (mode === "rate")
          throw new StructuredCompletionError("Rate limit exceeded", 429);
        if (mode === "fail") throw new Error("Semantic completion failed");
        return {
          text: "{}",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 4,
          },
        };
      },
    };
    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });
    const server = await startHttpBridgeServer({
      adapter: new Llm4ZoteroAgentBackendAdapter({ adapter: base }),
    });
    const post = () =>
      fetch(`http://${server.host}:${server.port}/structured-completion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Read" }),
      });
    try {
      const ok = await post();
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({
        text: "{}",
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 4,
        },
      });
      mode = "rate";
      const limited = await post();
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: "Rate limit exceeded" });
      mode = "fail";
      const failed = await post();
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({
        error: "Semantic completion failed",
      });
    } finally {
      await server.close();
    }
  });

  it("advertises local PDF path protocol support", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return { runId: "run-health", events: providerEvents([]) };
      },
    };
    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });
    const server = await startHttpBridgeServer({
      adapter: new Llm4ZoteroAgentBackendAdapter({ adapter: base }),
    });

    try {
      const response = await fetch(
        `http://${server.host}:${server.port}/healthz`,
      );
      expect(await response.json()).toMatchObject({
        ok: true,
        protocolVersion: 2,
        capabilities: [
          "local_pdf_paths",
          "model_catalog_v1",
          "permission_modes_v1",
        ],
      });
    } finally {
      await server.close();
    }
  });

  it("requires the auth token path prefix when one is configured", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return { runId: "run-auth", events: providerEvents([]) };
      },
    };
    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });
    const server = await startHttpBridgeServer({
      adapter: new Llm4ZoteroAgentBackendAdapter({ adapter: base }),
      authToken: "secret-token",
      bridgeVersion: "9.9.9",
      managedBy: "llm-for-zotero",
    });
    const origin = `http://${server.host}:${server.port}`;

    try {
      expect((await fetch(`${origin}/healthz`)).status).toBe(401);
      expect((await fetch(`${origin}/wrong-token/healthz`)).status).toBe(401);
      expect((await fetch(`${origin}/secret-tokenx/healthz`)).status).toBe(401);
      const response = await fetch(`${origin}/secret-token/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        bridgeVersion: "9.9.9",
        managedBy: "llm-for-zotero",
      });
      const tools = await fetch(
        `${origin}/secret-token/tools?settingSources=user`,
      );
      expect(tools.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("leaves the token-free health payload unchanged", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return { runId: "run-plain", events: providerEvents([]) };
      },
    };
    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });
    const server = await startHttpBridgeServer({
      adapter: new Llm4ZoteroAgentBackendAdapter({ adapter: base }),
    });
    try {
      const payload = (await (
        await fetch(`http://${server.host}:${server.port}/healthz`)
      ).json()) as Record<string, unknown>;
      expect(payload.managedBy).toBeUndefined();
      expect(payload.bridgeVersion).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("returns the Claude Code permission mode catalog", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return { runId: "run-permissions", events: providerEvents([]) };
      },
      async listPermissionModes() {
        return {
          configuredDefaultMode: "plan",
          modes: [
            {
              id: "default",
              description: "Use standard prompting.",
              available: true,
            },
            {
              id: "bypassPermissions",
              description: "Bypass permission checks.",
              available: false,
              disabledReason: "Disabled by policy.",
            },
          ],
        };
      },
    };
    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });
    const server = await startHttpBridgeServer({
      adapter: new Llm4ZoteroAgentBackendAdapter({ adapter: base }),
    });

    try {
      const response = await fetch(
        `http://${server.host}:${server.port}/permission-modes?settingSources=project,local`,
      );
      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual({
        configuredDefaultMode: "plan",
        modes: [
          {
            id: "default",
            description: "Use standard prompting.",
            available: true,
          },
          {
            id: "bypassPermissions",
            description: "Bypass permission checks.",
            available: false,
            disabledReason: "Disabled by policy.",
          },
        ],
      });
    } finally {
      await server.close();
    }
  });

  it("returns structured model metadata alongside the legacy string list", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-http-models",
          events: providerEvents([]),
        };
      },
      async listModels() {
        return [
          {
            value: "default",
            resolvedModel: "claude-opus-5[1m]",
            displayName: "Default",
            description: "Current account default",
            supportsEffort: true,
            supportedEffortLevels: ["low", "high", "max"],
            supportsAdaptiveThinking: true,
            supportsFastMode: false,
            supportsAutoMode: true,
          },
          {
            value: "claude-fable-5[1m]",
            displayName: "Fable",
          },
          "LegacyProvider/Model-X",
        ];
      },
    };
    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });
    const server = await startHttpBridgeServer({
      adapter: new Llm4ZoteroAgentBackendAdapter({ adapter: base }),
    });

    try {
      const response = await fetch(
        `http://${server.host}:${server.port}/models`,
      );
      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual({
        models: ["default", "claude-fable-5[1m]", "LegacyProvider/Model-X"],
        modelInfos: [
          {
            value: "default",
            resolvedModel: "claude-opus-5[1m]",
            displayName: "Default",
            description: "Current account default",
            supportsEffort: true,
            supportedEffortLevels: ["low", "high", "max"],
            supportsAdaptiveThinking: true,
            supportsFastMode: false,
            supportsAutoMode: true,
          },
          {
            value: "claude-fable-5[1m]",
            displayName: "Fable",
          },
          {
            value: "LegacyProvider/Model-X",
          },
        ],
      });
    } finally {
      await server.close();
    }
  });

  it("discovers models in the same derived scoped directory as the turn", async () => {
    let seenOptions:
      | {
          settingSources?: Array<"user" | "project" | "local">;
          runtimeCwdRelative?: string;
        }
      | undefined;
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-http-scoped-models",
          events: providerEvents([]),
        };
      },
      async listModels(options) {
        seenOptions = options;
        return [{ value: "ScopedModel" }];
      },
    };
    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });
    const server = await startHttpBridgeServer({
      adapter: new Llm4ZoteroAgentBackendAdapter({ adapter: base }),
    });

    try {
      const params = new URLSearchParams({
        settingSources: "project,local",
        conversationKey: "0042",
        scopeType: "paper",
        scopeId: "profile-test:1:42",
        scopeLabel: "Paper 42",
        refresh: "1",
      });
      const response = await fetch(
        `http://${server.host}:${server.port}/models?${params}`,
      );

      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual({
        models: ["ScopedModel"],
        modelInfos: [{ value: "ScopedModel" }],
      });
      expect(seenOptions).toEqual({
        settingSources: ["project", "local"],
        runtimeCwdRelative:
          "profile-test/scopes/paper/profile-test:1:42/conversations/0042",
        forceRefresh: true,
      });
    } finally {
      await server.close();
    }
  });

  it("discovers efforts in the same derived scoped directory as the models", async () => {
    let seenOptions:
      | {
          model?: string;
          settingSources?: Array<"user" | "project" | "local">;
          runtimeCwdRelative?: string;
        }
      | undefined;
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-http-scoped-efforts",
          events: providerEvents([]),
        };
      },
      async listEfforts(options) {
        seenOptions = options;
        return ["low", "high"];
      },
    };
    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });
    const server = await startHttpBridgeServer({
      adapter: new Llm4ZoteroAgentBackendAdapter({ adapter: base }),
    });

    try {
      const params = new URLSearchParams({
        settingSources: "project,local",
        conversationKey: "0042",
        scopeType: "paper",
        scopeId: "profile-test:1:42",
        scopeLabel: "Paper 42",
        model: "ScopedModel",
      });
      const response = await fetch(
        `http://${server.host}:${server.port}/efforts?${params}`,
      );

      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual({
        efforts: ["default", "low", "high"],
      });
      expect(seenOptions).toEqual({
        model: "ScopedModel",
        settingSources: ["project", "local"],
        runtimeCwdRelative:
          "profile-test/scopes/paper/profile-test:1:42/conversations/0042",
      });
    } finally {
      await server.close();
    }
  });

  it("reports model catalog discovery failures instead of returning an authoritative empty catalog", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-http-model-error",
          events: providerEvents([]),
        };
      },
      async listModels() {
        throw new Error("catalog probe failed");
      },
    };
    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });
    const server = await startHttpBridgeServer({
      adapter: new Llm4ZoteroAgentBackendAdapter({ adapter: base }),
    });

    try {
      const response = await fetch(
        `http://${server.host}:${server.port}/models`,
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "catalog probe failed",
      });
    } finally {
      await server.close();
    }
  });

  it("returns tool catalog from /tools", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-http-tools",
          events: providerEvents([]),
        };
      },
    };
    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });
    const compat = new Llm4ZoteroAgentBackendAdapter({
      adapter: base,
      runtimeCwd: createRuntimeWithCommand(),
    });
    const server = await startHttpBridgeServer({ adapter: compat });

    try {
      const response = await fetch(
        `http://${server.host}:${server.port}/tools?settingSources=project`,
      );
      expect(response.ok).toBe(true);
      const payload = (await response.json()) as {
        tools?: Array<{ name: string }>;
      };
      expect(Array.isArray(payload.tools)).toBe(true);
      expect((payload.tools || []).map((tool) => tool.name)).toContain(
        "summarize",
      );
    } finally {
      await server.close();
    }
  });

  it("merges connected MCP tools into /tools", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-http-mcp-tools",
          events: providerEvents([]),
        };
      },
      async listMcpServers() {
        return [
          {
            name: "grok-search",
            status: "connected",
            scope: "user",
            tools: [
              { name: "web_search", description: "Search with Grok" },
              { name: "switch_model", annotations: { destructive: true } },
            ],
          },
          {
            name: "broken-mcp",
            status: "failed",
            tools: [{ name: "should_not_show" }],
          },
        ];
      },
    };
    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });
    const compat = new Llm4ZoteroAgentBackendAdapter({ adapter: base });
    const server = await startHttpBridgeServer({ adapter: compat });

    try {
      const response = await fetch(
        `http://${server.host}:${server.port}/tools?settingSources=user`,
      );
      expect(response.ok).toBe(true);
      const payload = (await response.json()) as {
        tools?: Array<{
          name: string;
          source: string;
          mutability: string;
          requiresConfirmation: boolean;
        }>;
      };
      const tools = payload.tools || [];
      expect(
        tools.some(
          (tool) =>
            tool.name === "grok-search.web_search" && tool.source === "mcp",
        ),
      ).toBe(true);
      expect(
        tools.some((tool) => tool.name === "broken-mcp.should_not_show"),
      ).toBe(false);
      expect(
        tools.find((tool) => tool.name === "grok-search.switch_model"),
      ).toMatchObject({
        mutability: "write",
        requiresConfirmation: true,
      });
    } finally {
      await server.close();
    }
  });

  it("streams a single start line with the runtime runId", async () => {
    const seenResumes: Array<string | undefined> = [];
    const seenMcpServers: Array<unknown> = [];
    const seenAllowedTools: Array<unknown> = [];
    const mcpServers = {
      llm_for_zotero: {
        type: "http",
        url: "http://127.0.0.1:23119/llm-for-zotero/mcp",
        headers: { Authorization: "Bearer token-1" },
      },
    };
    const allowedTools = ["mcp__llm_for_zotero__library_search"];
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn(request) {
        seenResumes.push(request.providerSessionId);
        seenMcpServers.push(request.mcpServers);
        seenAllowedTools.push(request.allowedTools);
        return {
          runId: "run-http-1",
          providerSessionId: request.providerSessionId,
          events: providerEvents([
            { type: "message_delta", payload: { delta: "hello" } },
            { type: "final", payload: { output: "hello" } },
          ]),
        };
      },
    };

    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });
    const compat = new Llm4ZoteroAgentBackendAdapter({ adapter: base });
    const server = await startHttpBridgeServer({ adapter: compat });

    try {
      const response = await fetch(
        `http://${server.host}:${server.port}/run-turn`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationKey: "conv-1",
            userText: "hello",
            providerSessionId: "sess-http-resume",
            allowedTools,
            mcpServers,
          }),
        },
      );

      expect(response.ok).toBe(true);
      const lines = await readNdjsonLines(response);
      expect(seenResumes).toEqual(["sess-http-resume"]);
      expect(seenMcpServers).toEqual([mcpServers]);
      expect(seenAllowedTools).toEqual([allowedTools]);
      const starts = lines.filter((line) => line.type === "start");
      expect(starts).toEqual([{ type: "start", runId: "run-http-1" }]);
      expect(lines.at(-1)).toEqual({
        type: "outcome",
        outcome: {
          kind: "completed",
          runId: "run-http-1",
          text: "hello",
          usedFallback: false,
        },
      });
    } finally {
      await server.close();
    }
  });

  it("returns 400 for invalid payload", async () => {
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn() {
        return {
          runId: "run-http-2",
          events: providerEvents([]),
        };
      },
    };

    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });
    const compat = new Llm4ZoteroAgentBackendAdapter({ adapter: base });
    const server = await startHttpBridgeServer({ adapter: compat });

    try {
      const response = await fetch(
        `http://${server.host}:${server.port}/run-turn`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userText: "missing conversation key" }),
        },
      );

      expect(response.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("preserves string conversationKey and scoped session info contract", async () => {
    const seenKeys: string[] = [];
    const runtimeClient: ClaudeCodeRuntimeClient = {
      async startTurn(request) {
        seenKeys.push(request.conversationKey);
        return {
          runId: "run-http-string-key",
          providerSessionId: "sess-http-string-key",
          events: providerEvents([
            { type: "final", payload: { output: "ok" } },
          ]),
        };
      },
    };

    const base = new ClaudeCodeRuntimeAdapter({
      runtimeClient,
      sessionMapper: new InMemorySessionMapper(),
    });
    const compat = new Llm4ZoteroAgentBackendAdapter({
      adapter: base,
      runtimeCwd: "/tmp/adapter-runtime",
    });
    const server = await startHttpBridgeServer({ adapter: compat });

    try {
      const runResponse = await fetch(
        `http://${server.host}:${server.port}/run-turn`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationKey: "0042",
            userText: "hello",
            scopeType: "paper",
            scopeId: "profile-test:1:42",
            scopeLabel: "Paper 42",
          }),
        },
      );
      expect(runResponse.ok).toBe(true);
      await readNdjsonLines(runResponse);

      const sessionInfoResponse = await fetch(
        `http://${server.host}:${server.port}/session-info?conversationKey=0042&scopeType=paper&scopeId=profile-test%3A1%3A42&scopeLabel=Paper%2042`,
      );
      expect(sessionInfoResponse.ok).toBe(true);
      const payload = (await sessionInfoResponse.json()) as {
        session?: {
          originalConversationKey: string;
          scopedConversationKey: string;
          providerSessionId?: string;
          runtimeCwdRelative?: string;
          cwd?: string;
        };
      };
      expect(seenKeys).toEqual(["0042::paper:profile-test:1:42"]);
      expect(payload.session).toEqual({
        originalConversationKey: "0042",
        scopedConversationKey: "0042::paper:profile-test:1:42",
        providerSessionId: "sess-http-string-key",
        scopeType: "paper",
        scopeId: "profile-test:1:42",
        scopeLabel: "Paper 42",
        runtimeCwdRelative:
          "profile-test/scopes/paper/profile-test:1:42/conversations/0042",
        cwd: "/tmp/adapter-runtime/profile-test/scopes/paper/profile-test:1:42/conversations/0042",
      });
    } finally {
      await server.close();
    }
  });

  it("streams run-action endpoint with a single start line", async () => {
    const compat = {
      listTools() {
        return [];
      },
      async listCommands() {
        return [];
      },
      async listModels() {
        return [];
      },
      async listEfforts() {
        return [];
      },
      async getSessionInfo() {
        return {
          originalConversationKey: "conv-action-1",
          scopedConversationKey: "conv-action-1",
        };
      },
      resolveExternalConfirmation() {
        return {
          accepted: false,
          source: "none" as const,
          pendingPermissionCount: 0,
          recentPendingRequestIds: [],
        };
      },
      async runTurn() {
        throw new Error("runTurn should not be called in this test");
      },
      async runAction(params: {
        request: { conversationKey: string; toolName: string; args?: unknown };
        onStart?: (runId: string) => void | Promise<void>;
        onEvent?: (event: Record<string, unknown>) => void | Promise<void>;
      }) {
        expect(params.request.conversationKey).toBe("conv-action-1");
        expect(params.request.toolName).toBe("Read");
        expect(params.request.args).toEqual({ file_path: "README.md" });
        await params.onStart?.("run-http-action");
        await params.onEvent?.({
          type: "tool_call",
          callId: "call_1",
          name: "Read",
          args: { file_path: "README.md" },
        });
        return {
          kind: "completed" as const,
          runId: "run-http-action",
          text: "done",
          usedFallback: false as const,
        };
      },
    } as unknown as Llm4ZoteroAgentBackendAdapter;
    const server = await startHttpBridgeServer({ adapter: compat });

    try {
      const response = await fetch(
        `http://${server.host}:${server.port}/run-action`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationKey: "conv-action-1",
            toolName: "Read",
            args: { file_path: "README.md" },
            approved: true,
          }),
        },
      );

      expect(response.ok).toBe(true);
      const lines = await readNdjsonLines(response);
      const starts = lines.filter((line) => line.type === "start");
      expect(starts).toEqual([{ type: "start", runId: "run-http-action" }]);
      expect(lines.at(-1)).toEqual({
        type: "outcome",
        outcome: {
          kind: "completed",
          runId: "run-http-action",
          text: "done",
          usedFallback: false,
        },
      });
    } finally {
      await server.close();
    }
  });
});

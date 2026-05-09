import { assert } from "chai";
import {
  assertRequiredCodexZoteroMcpToolsReady,
  buildCodexZoteroMcpThreadConfig,
  clearCodexZoteroMcpPreflightCache,
  installOrUpdateCodexZoteroMcpConfig,
  preflightCodexZoteroMcpServer,
  readCodexNativeMcpSetupStatus,
} from "../src/codexAppServer/mcpSetup";
import {
  getZoteroMcpAllowedToolNames,
  registerMcpServer,
  unregisterMcpServer,
} from "../src/agent/mcp/server";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type { AgentToolDefinition } from "../src/agent/types";
import type { CodexAppServerProcess } from "../src/utils/codexAppServerProcess";

function createReadTool(name: string): AgentToolDefinition<unknown, unknown> {
  return {
    spec: {
      name,
      description: `Read tool ${name}`,
      inputSchema: { type: "object", additionalProperties: true },
      mutability: "read",
      requiresConfirmation: false,
    },
    validate: (args) => ({ ok: true, value: args ?? {} }),
    execute: async (input) => ({ name, input }),
  };
}

describe("Codex app-server MCP setup", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (globalThis as typeof globalThis & { ztoolkit?: any })
    .ztoolkit;
  const originalFetch = (
    globalThis as typeof globalThis & { fetch?: typeof fetch }
  ).fetch;
  const prefStore = new Map<string, unknown>();

  beforeEach(function () {
    prefStore.clear();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => {
          if (key === "httpServer.port") return 24680;
          return prefStore.get(key);
        },
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as unknown as typeof Zotero;
    (
      globalThis as typeof globalThis & { ztoolkit: { log: () => void } }
    ).ztoolkit = {
      log: () => {},
    };
  });

  afterEach(function () {
    clearCodexZoteroMcpPreflightCache();
    try {
      if (
        (
          globalThis as typeof globalThis & {
            Zotero?: { Server?: { Endpoints?: unknown } };
          }
        ).Zotero?.Server?.Endpoints
      ) {
        unregisterMcpServer();
      }
    } catch {
      /* test cleanup should not mask the assertion failure */
    }
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      originalFetch;
  });

  it("writes the Zotero MCP server config and reloads Codex MCP servers", async function () {
    const calls: Array<{ method: string; params: unknown }> = [];
    const proc = {
      sendRequest: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === "config/value/write") return {};
        if (method === "config/mcpServer/reload") return {};
        if (method === "config/read") {
          return {
            mcp_servers: {
              llm_for_zotero: {
                url: "http://127.0.0.1:24680/llm-for-zotero/mcp",
              },
            },
          };
        }
        if (method === "mcpServerStatus/list") {
          return {
            servers: [
              {
                name: "llm_for_zotero",
                status: "ready",
                tools: [{ name: "query_library" }],
              },
            ],
          };
        }
        if (method === "skills/list") return { skills: [] };
        if (method === "plugin/list") return { plugins: [] };
        throw new Error(`unexpected method ${method}`);
      },
    } as unknown as CodexAppServerProcess;

    const status = await installOrUpdateCodexZoteroMcpConfig({ proc });

    const writeCall = calls.find(
      (call) => call.method === "config/value/write",
    );
    assert.isOk(writeCall);
    assert.deepInclude(writeCall?.params as Record<string, unknown>, {
      keyPath: "mcp_servers.llm_for_zotero",
      mergeStrategy: "upsert",
    });
    const value = (writeCall?.params as { value?: Record<string, unknown> })
      .value;
    assert.equal(value?.url, "http://127.0.0.1:24680/llm-for-zotero/mcp");
    assert.equal(value?.default_tools_approval_mode, "approve");
    assert.deepEqual(value?.enabled_tools, getZoteroMcpAllowedToolNames());
    assert.include(value?.enabled_tools as string[], "edit_current_note");
    assert.include(value?.enabled_tools as string[], "run_command");
    assert.notInclude(value?.enabled_tools as string[], "zotero_confirm_action");
    const toolApprovals = value?.tools as Record<
      string,
      { approval_mode?: string }
    >;
    assert.equal(toolApprovals.query_library.approval_mode, "approve");
    assert.equal(toolApprovals.edit_current_note.approval_mode, "approve");
    assert.equal(toolApprovals.run_command.approval_mode, "approve");
    assert.notProperty(toolApprovals, "zotero_confirm_action");
    assert.deepEqual(value?.http_headers, {
      Authorization: `Bearer ${prefStore.get(
        "extensions.zotero.llmforzotero.codexZoteroMcpBearerToken",
      )}`,
    });
    assert.include(
      calls.map((call) => call.method),
      "config/mcpServer/reload",
    );
    assert.equal(status.configured, true);
    assert.equal(status.connected, true);
    assert.deepEqual(status.toolNames, ["query_library"]);
  });

  it("falls back to legacy config write shapes when dotted keyPath is unsupported", async function () {
    const calls: Array<{ method: string; params: unknown }> = [];
    const proc = {
      sendRequest: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === "config/value/write") {
          const record = params as Record<string, unknown>;
          if (record.key === "mcp_servers.llm_for_zotero") return {};
          throw new Error("legacy server does not support dotted keyPath");
        }
        if (method === "config/mcpServer/reload") return {};
        if (method === "config/read") {
          return {
            mcp_servers: {
              llm_for_zotero: {
                url: "http://127.0.0.1:24680/llm-for-zotero/mcp",
              },
            },
          };
        }
        if (method === "mcpServerStatus/list") {
          return {
            servers: [
              {
                name: "llm_for_zotero",
                status: "ready",
                tools: [{ name: "query_library" }],
              },
            ],
          };
        }
        if (method === "skills/list") return { skills: [] };
        if (method === "plugin/list") return { plugins: [] };
        throw new Error(`unexpected method ${method}`);
      },
    } as unknown as CodexAppServerProcess;

    const status = await installOrUpdateCodexZoteroMcpConfig({ proc });

    const writeCalls = calls.filter(
      (call) => call.method === "config/value/write",
    );
    assert.deepEqual(
      writeCalls.map((call) => Object.keys(call.params as Record<string, unknown>)[0]),
      ["keyPath", "keyPath", "keyPath", "key"],
    );
    assert.equal(status.configured, true);
  });

  it("reports setup status without requiring config write", async function () {
    const proc = {
      sendRequest: async (method: string) => {
        if (method === "config/read") {
          return {
            mcp_servers: {
              llm_for_zotero: {
                url: "http://127.0.0.1:24680/llm-for-zotero/mcp",
              },
            },
          };
        }
        if (method === "mcpServerStatus/list") {
          return {
            servers: [
              {
                name: "llm_for_zotero",
                status: "ready",
                tools: [
                  { name: "query_library" },
                  { name: "not_a_zotero_tool" },
                ],
              },
            ],
          };
        }
        if (method === "skills/list") return { skills: [{ name: "skill-a" }] };
        if (method === "plugin/list") return { plugins: [] };
        throw new Error(`unexpected method ${method}`);
      },
    } as unknown as CodexAppServerProcess;

    const status = await readCodexNativeMcpSetupStatus({ proc });

    assert.equal(status.configured, true);
    assert.equal(status.connected, true);
    assert.deepEqual(status.toolNames, ["query_library"]);
    assert.deepEqual(status.errors, []);
  });

  it("preflights the registered Zotero MCP endpoint in-process when available", async function () {
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      ...globalThis.Zotero,
      Server: { Endpoints: {} },
    } as unknown as typeof Zotero;
    const registry = new AgentToolRegistry();
    registry.register(createReadTool("query_library"));
    registry.register(createReadTool("read_library"));
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async () => {
      throw new Error("preflight should not self-fetch Zotero's HTTP server");
    }) as typeof fetch;

    const status = await preflightCodexZoteroMcpServer({
      scopeToken: "scope-direct",
      required: true,
    });

    assert.equal(status.connected, true);
    assert.deepEqual(status.toolNames, ["query_library", "read_library"]);
  });

  it("caches successful local MCP preflight across per-turn scope tokens", async function () {
    const methods: string[] = [];
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const payload = JSON.parse(String(init?.body || "{}")) as {
        id?: string | number;
        method?: string;
      };
      methods.push(payload.method || "");
      if (payload.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: { protocolVersion: "2025-06-18", capabilities: {} },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (payload.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      if (payload.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              tools: [{ name: "query_library" }, { name: "read_library" }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected request", { status: 500 });
    }) as typeof fetch;

    const first = await preflightCodexZoteroMcpServer({
      scopeToken: "scope-a",
      required: true,
    });
    const second = await preflightCodexZoteroMcpServer({
      scopeToken: "scope-b",
      required: true,
    });

    assert.deepEqual(first.toolNames, ["query_library", "read_library"]);
    assert.deepEqual(second.toolNames, ["query_library", "read_library"]);
    assert.deepEqual(methods, [
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    const config = second.config as {
      mcp_servers?: Record<string, { http_headers?: Record<string, string> }>;
    };
    assert.equal(
      config.mcp_servers?.llm_for_zotero.http_headers?.[
        "X-LLM-For-Zotero-Scope"
      ],
      "scope-b",
    );
  });

  it("builds profile-scoped required MCP config for native threads", function () {
    const scoped = buildCodexZoteroMcpThreadConfig({
      profileSignature: "profile-dev one",
      scopeToken: "scope-token-123",
      required: true,
    });
    const otherScoped = buildCodexZoteroMcpThreadConfig({
      profileSignature: "profile-main two",
      scopeToken: "scope-token-456",
      required: true,
    });

    assert.equal(scoped.serverName, "llm_for_zotero_profile_dev_one");
    assert.equal(otherScoped.serverName, "llm_for_zotero_profile_main_two");
    assert.notEqual(scoped.serverName, otherScoped.serverName);
    assert.deepEqual(scoped.config.features, { shell_tool: false });
    const servers = scoped.config.mcp_servers as Record<string, any>;
    assert.containsAllKeys(servers, [scoped.serverName]);
    assert.equal(
      servers[scoped.serverName].url,
      "http://127.0.0.1:24680/llm-for-zotero/mcp",
    );
    assert.equal(servers[scoped.serverName].required, true);
    assert.equal(
      servers[scoped.serverName].http_headers["X-LLM-For-Zotero-Scope"],
      "scope-token-123",
    );
    assert.equal(
      servers[scoped.serverName].default_tools_approval_mode,
      "approve",
    );
    assert.include(servers[scoped.serverName].enabled_tools, "query_library");
    assert.include(servers[scoped.serverName].enabled_tools, "read_library");
    assert.include(
      servers[scoped.serverName].enabled_tools,
      "edit_current_note",
    );
    assert.equal(
      servers[scoped.serverName].tools.edit_current_note.approval_mode,
      "approve",
    );
    assert.equal(
      servers[scoped.serverName].tools.run_command.approval_mode,
      "approve",
    );
    assert.notInclude(
      servers[scoped.serverName].enabled_tools,
      "zotero_confirm_action",
    );
    assert.notProperty(
      servers[scoped.serverName].tools,
      "zotero_confirm_action",
    );
  });

  it("rejects native turns when required Zotero MCP tools are missing", function () {
    assert.throws(
      () =>
        assertRequiredCodexZoteroMcpToolsReady({
          enabled: true,
          serverName: "llm_for_zotero_profile_a",
          serverUrl: "http://127.0.0.1:24680/llm-for-zotero/mcp",
          configured: true,
          connected: true,
          toolNames: ["query_library"],
          errors: [],
        }),
      /missing required tools: read_library/,
    );
  });
});

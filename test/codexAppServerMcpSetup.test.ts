import { assert } from "chai";
import {
  assertRequiredCodexZoteroMcpToolsReady,
  buildClaudeZoteroMcpServerConfig,
  buildCodexZoteroMcpThreadConfig,
  clearCodexZoteroMcpPreflightCache,
  installOrUpdateCodexZoteroMcpConfig,
  preflightCodexZoteroMcpServer,
  probeCodexZoteroMcpThroughAppServer,
  readCodexNativeMcpSetupStatus,
} from "../src/codexAppServer/mcpSetup";
import {
  getZoteroMcpAllowedToolNames,
  registerMcpServer,
  registerScopedZoteroMcpScope,
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
        if (method === "thread/start") {
          return { thread: { id: "mcp-probe-thread" } };
        }
        if (method === "thread/archive") return {};
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
                tools: [{ name: "library_search" }],
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
    assert.include(value?.enabled_tools as string[], "note_write");
    assert.include(value?.enabled_tools as string[], "run_command");
    assert.notInclude(
      value?.enabled_tools as string[],
      "zotero_confirm_action",
    );
    const toolApprovals = value?.tools as Record<
      string,
      { approval_mode?: string }
    >;
    assert.equal(toolApprovals.library_search.approval_mode, "approve");
    assert.equal(toolApprovals.note_write.approval_mode, "approve");
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
    const probeCall = calls.find((call) => call.method === "thread/start");
    const probeServers = (
      probeCall?.params as {
        config?: { mcp_servers?: Record<string, { required?: boolean }> };
      }
    ).config?.mcp_servers;
    assert.lengthOf(Object.keys(probeServers || {}), 1);
    assert.match(
      Object.keys(probeServers || {})[0] || "",
      /^llm_for_zotero_connection_probe_/,
    );
    assert.isTrue(Object.values(probeServers || {})[0]?.required);
    assert.deepInclude(
      calls.find((call) => call.method === "thread/archive")?.params as Record<
        string,
        unknown
      >,
      { threadId: "mcp-probe-thread" },
    );
    assert.equal(status.configured, true);
    assert.equal(status.connected, true);
    assert.deepEqual(status.toolNames, ["library_search"]);
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
        if (method === "thread/start") {
          return { thread: { id: "mcp-probe-thread-legacy" } };
        }
        if (method === "thread/archive") return {};
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
                tools: [{ name: "library_search" }],
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
      writeCalls.map(
        (call) => Object.keys(call.params as Record<string, unknown>)[0],
      ),
      ["keyPath", "keyPath", "keyPath", "key"],
    );
    assert.equal(status.configured, true);
  });

  it("probes a required profile-scoped MCP server without sending a model turn", async function () {
    const calls: Array<{ method: string; params: unknown }> = [];
    const proc = {
      sendRequest: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === "thread/start") {
          return { thread: { id: "disposable-probe-thread" } };
        }
        if (method === "thread/archive") return {};
        throw new Error(`unexpected method ${method}`);
      },
    } as unknown as CodexAppServerProcess;

    await probeCodexZoteroMcpThroughAppServer({ proc });

    assert.deepEqual(
      calls.map((call) => call.method),
      ["thread/start", "thread/archive"],
    );
    const startParams = calls[0]?.params as {
      ephemeral?: boolean;
      config?: { mcp_servers?: Record<string, { required?: boolean }> };
    };
    assert.notProperty(startParams, "model");
    assert.isTrue(startParams.ephemeral);
    const servers = startParams.config?.mcp_servers || {};
    const serverName = Object.keys(servers)[0] || "";
    assert.match(serverName, /^llm_for_zotero_connection_probe_/);
    assert.isTrue(servers[serverName]?.required);
    assert.deepEqual(calls[1]?.params, {
      threadId: "disposable-probe-thread",
    });
    assert.notInclude(
      calls.map((call) => call.method),
      "turn/start",
    );
  });

  it("fails setup when the in-process preflight passes but Codex receives HTTP 502", async function () {
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      ...globalThis.Zotero,
      Server: { Endpoints: {} },
    } as unknown as typeof Zotero;
    const registry = new AgentToolRegistry();
    registry.register(createReadTool("library_search"));
    registry.register(createReadTool("library_read"));
    registry.register(createReadTool("library_retrieve"));
    registry.register(createReadTool("paper_read"));
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const localStatus = await preflightCodexZoteroMcpServer({
      required: true,
    });
    assert.isTrue(localStatus.connected);

    const proc = {
      sendRequest: async (method: string) => {
        if (method === "config/value/write") return {};
        if (method === "config/mcpServer/reload") return {};
        if (method === "thread/start") {
          throw new Error(
            "MCP server llm_for_zotero_connection_probe failed for http://127.0.0.1:24680/llm-for-zotero/mcp: HTTP 502 Bad Gateway",
          );
        }
        throw new Error(`unexpected method ${method}`);
      },
    } as unknown as CodexAppServerProcess;

    let thrown: unknown;
    try {
      await installOrUpdateCodexZoteroMcpConfig({ proc });
    } catch (error) {
      thrown = error;
    }
    assert.instanceOf(thrown, Error);
    assert.include((thrown as Error).message, "HTTP 502");
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
                  { name: "library_search" },
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
    assert.deepEqual(status.toolNames, ["library_search"]);
    assert.deepEqual(status.errors, []);
  });

  it("preflights the registered Zotero MCP endpoint in-process when available", async function () {
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      ...globalThis.Zotero,
      Server: { Endpoints: {} },
    } as unknown as typeof Zotero;
    const registry = new AgentToolRegistry();
    registry.register(createReadTool("library_search"));
    registry.register(createReadTool("library_read"));
    registry.register(createReadTool("library_retrieve"));
    registry.register(createReadTool("paper_read"));
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch =
      (async () => {
        throw new Error("preflight should not self-fetch Zotero's HTTP server");
      }) as typeof fetch;

    const scoped = registerScopedZoteroMcpScope(
      { conversationKey: 7_950_001, libraryID: 1, kind: "global" },
      { token: "scope-direct" },
    );
    try {
      const status = await preflightCodexZoteroMcpServer({
        scopeToken: scoped.token,
        required: true,
      });

      assert.equal(status.connected, true);
      assert.deepEqual(status.toolNames, [
        "library_search",
        "library_read",
        "library_retrieve",
        "paper_read",
      ]);
    } finally {
      scoped.clear();
    }
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
              tools: [
                { name: "library_search" },
                { name: "library_read" },
                { name: "library_retrieve" },
                { name: "paper_read" },
              ],
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

    assert.deepEqual(first.toolNames, [
      "library_search",
      "library_read",
      "library_retrieve",
      "paper_read",
    ]);
    assert.deepEqual(second.toolNames, [
      "library_search",
      "library_read",
      "library_retrieve",
      "paper_read",
    ]);
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
    assert.include(servers[scoped.serverName].enabled_tools, "library_search");
    assert.include(servers[scoped.serverName].enabled_tools, "library_read");
    assert.include(
      servers[scoped.serverName].enabled_tools,
      "library_retrieve",
    );
    assert.include(servers[scoped.serverName].enabled_tools, "note_write");
    assert.equal(
      servers[scoped.serverName].tools.note_write.approval_mode,
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

  it("builds Claude SDK MCP server config with scoped Zotero headers", function () {
    const config = buildClaudeZoteroMcpServerConfig({
      profileSignature: "profile-dev one",
      scopeToken: "scope-token-claude",
      required: true,
    });

    assert.equal(config.serverName, "llm_for_zotero_profile_dev_one");
    const server = config.mcpServers[config.serverName] as {
      type?: string;
      url?: string;
      headers?: Record<string, string>;
      http_headers?: Record<string, string>;
      enabled_tools?: string[];
    };
    assert.equal(server.type, "http");
    assert.equal(server.url, "http://127.0.0.1:24680/llm-for-zotero/mcp");
    assert.equal(
      server.headers?.["X-LLM-For-Zotero-Scope"],
      "scope-token-claude",
    );
    assert.match(String(server.headers?.Authorization || ""), /^Bearer /);
    assert.isUndefined(server.http_headers);
    assert.isUndefined(server.enabled_tools);
    assert.include(
      config.allowedTools,
      "mcp__llm_for_zotero_profile_dev_one__library_retrieve",
    );
    assert.include(
      config.allowedTools,
      "mcp__llm_for_zotero_profile_dev_one__zotero_script",
    );
  });

  it("keeps Claude raw local-path turns on an identity-gated MCP surface", function () {
    const config = buildClaudeZoteroMcpServerConfig({
      profileSignature: "profile-claude-raw",
      scopeToken: "scope-token-claude-raw",
      required: true,
      rawPdfMode: true,
    });
    const prefix = "mcp__llm_for_zotero_profile_claude_raw__";

    assert.include(config.allowedTools, `${prefix}library_search`);
    assert.include(config.allowedTools, `${prefix}note_write`);
    assert.include(config.allowedTools, `${prefix}paper_read`);
    assert.include(config.allowedTools, `${prefix}library_read`);
    assert.include(config.allowedTools, `${prefix}library_retrieve`);
    assert.notInclude(config.allowedTools, `${prefix}raw_pdf_read`);
    assert.notInclude(config.allowedTools, `${prefix}literature_search`);
    assert.notInclude(config.allowedTools, `${prefix}run_command`);
    assert.notInclude(config.allowedTools, `${prefix}file_io`);
    assert.notInclude(config.allowedTools, `${prefix}zotero_script`);
  });

  it("enables the native shell only when a local PDF turn requests it", function () {
    const withPdf = buildCodexZoteroMcpThreadConfig({
      profileSignature: "profile-pdf",
      scopeToken: "scope-token",
      enableShellTool: true,
      rawPdfMode: true,
    });

    assert.deepEqual(withPdf.config.features, { shell_tool: true });
    const pdfServer = (
      withPdf.config.mcp_servers as Record<string, { enabled_tools?: string[] }>
    )[withPdf.serverName];
    const enabledTools = pdfServer.enabled_tools || [];
    assert.include(enabledTools, "library_search");
    assert.include(enabledTools, "note_write");
    assert.include(enabledTools, "paper_read");
    assert.include(enabledTools, "library_read");
    assert.include(enabledTools, "library_retrieve");
    assert.notInclude(enabledTools, "raw_pdf_read");
    assert.notInclude(enabledTools, "literature_search");
    assert.notInclude(enabledTools, "run_command");
    assert.notInclude(enabledTools, "file_io");
    assert.notInclude(enabledTools, "zotero_script");

    const withoutPdf = buildCodexZoteroMcpThreadConfig({
      profileSignature: "profile-text",
      scopeToken: "scope-token",
    });
    assert.deepEqual(withoutPdf.config.features, { shell_tool: false });
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
          toolNames: ["library_search"],
          errors: [],
        }),
      /missing required tools: library_read, paper_read/,
    );
  });

  it("rejects native turns when paper_read is missing from Zotero MCP", function () {
    assert.throws(
      () =>
        assertRequiredCodexZoteroMcpToolsReady({
          enabled: true,
          serverName: "llm_for_zotero_profile_a",
          serverUrl: "http://127.0.0.1:24680/llm-for-zotero/mcp",
          configured: true,
          connected: true,
          toolNames: ["library_search", "library_read"],
          errors: [],
        }),
      /missing required tools: paper_read/,
    );
  });
});

import { assert } from "chai";
import {
  resolveCodexNativeApprovalRequest,
  resolveSafeCodexNativeApprovalRequest,
  runCodexAppServerNativeTurn,
} from "../src/codexAppServer/nativeClient";
import { destroyCachedCodexAppServerProcess } from "../src/utils/codexAppServerProcess";
import { ZOTERO_MCP_SCOPE_HEADER } from "../src/agent/mcp/server";
import { setUserSkills } from "../src/agent/skills";
import type { AgentSkill } from "../src/agent/skills/skillLoader";
import { clearCodexZoteroMcpPreflightCache } from "../src/codexAppServer/mcpSetup";
import { clearCodexNativeSkillClassifierCache } from "../src/codexAppServer/nativeSkills";

describe("Codex app-server native client", function () {
  const originalChromeUtils = (
    globalThis as typeof globalThis & {
      ChromeUtils?: unknown;
    }
  ).ChromeUtils;
  const originalToolkit = (
    globalThis as typeof globalThis & {
      ztoolkit?: unknown;
    }
  ).ztoolkit;
  const originalFetch = (
    globalThis as typeof globalThis & {
      fetch?: typeof fetch;
    }
  ).fetch;
  const originalCodexPath = globalThis.process?.env?.CODEX_PATH;
  const originalZotero = globalThis.Zotero;

  class MockStdout {
    private pending: Array<(value: string) => void> = [];
    private queue: string[] = [];

    readString(): Promise<string> {
      if (this.queue.length) {
        return Promise.resolve(this.queue.shift() || "");
      }
      return new Promise((resolve) => {
        this.pending.push(resolve);
      });
    }

    push(value: string) {
      const next = this.pending.shift();
      if (next) {
        next(value);
        return;
      }
      this.queue.push(value);
    }
  }

  function installMcpPreflightFetch(
    toolNames = ["query_library", "read_library"],
  ) {
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const payload = JSON.parse(String(init?.body || "{}")) as {
        id?: string | number;
        method?: string;
      };
      if (payload.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              protocolVersion: "2025-06-18",
              serverInfo: { name: "llm-for-zotero", version: "1.0.0" },
              capabilities: { tools: {} },
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
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
              tools: toolNames.map((name) => ({
                name,
                description: name,
                inputSchema: { type: "object" },
              })),
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response("unexpected MCP preflight request", { status: 500 });
    }) as typeof fetch;
  }

  function makeSkill(id: string, instruction: string): AgentSkill {
    return {
      id,
      description: `${id} description`,
      version: 1,
      patterns: [/native skill/i],
      instruction,
      source: "system",
    };
  }

  beforeEach(function () {
    (
      globalThis as typeof globalThis & { ztoolkit: { log: () => void } }
    ).ztoolkit = { log: () => undefined };
    installMcpPreflightFetch();
  });

  afterEach(function () {
    if (globalThis.process?.env) {
      if (typeof originalCodexPath === "string") {
        globalThis.process.env.CODEX_PATH = originalCodexPath;
      } else {
        delete globalThis.process.env.CODEX_PATH;
      }
    }
    (globalThis as typeof globalThis & { ChromeUtils?: unknown }).ChromeUtils =
      originalChromeUtils;
    (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
      originalToolkit;
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      originalFetch;
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    setUserSkills([]);
    clearCodexNativeSkillClassifierCache();
    clearCodexZoteroMcpPreflightCache();
    const mockCodexPath = { codexPath: "/mock/codex" };
    destroyCachedCodexAppServerProcess(
      "native-client-test",
      undefined,
      mockCodexPath,
    );
    destroyCachedCodexAppServerProcess(
      "native-client-resume-test",
      undefined,
      mockCodexPath,
    );
    destroyCachedCodexAppServerProcess(
      "native-client-approval-request-test",
      undefined,
      mockCodexPath,
    );
    destroyCachedCodexAppServerProcess(
      "native-client-guardian-review-test",
      undefined,
      mockCodexPath,
    );
    destroyCachedCodexAppServerProcess(
      "native-client-thread-reuse-test",
      undefined,
      mockCodexPath,
    );
    destroyCachedCodexAppServerProcess(
      "native-client-skills-test",
      undefined,
      mockCodexPath,
    );
    destroyCachedCodexAppServerProcess(
      "native-client-skills-fallback-test",
      undefined,
      mockCodexPath,
    );
    destroyCachedCodexAppServerProcess(
      "codex_app_server_chat",
      undefined,
      mockCodexPath,
    );
  });

  it("auto-approves trusted Zotero MCP approval prompts except self-confirmation", function () {
    const legacyReadDecision = resolveSafeCodexNativeApprovalRequest({
      method: "tool/requestUserInput",
      params: {
        serverName: "llm_for_zotero_profile_1234",
        toolName: "query_library",
        questions: [{ header: "Allow", question: "Use query_library?" }],
      },
    });
    assert.equal(legacyReadDecision?.approved, true);
    assert.deepEqual(legacyReadDecision?.response, { approved: true });

    const legacyWriteDecision = resolveSafeCodexNativeApprovalRequest({
      method: "tool/requestUserInput",
      params: {
        serverName: "llm_for_zotero_profile_1234",
        toolName: "edit_current_note",
        questions: [{ header: "Allow", question: "Use edit_current_note?" }],
      },
    });
    assert.equal(legacyWriteDecision?.approved, true);
    assert.deepEqual(legacyWriteDecision?.response, { approved: true });

    const currentWriteDecision = resolveCodexNativeApprovalRequest({
      method: "item/tool/requestUserInput",
      params: {
        serverName: "llm_for_zotero_profile_1234",
        toolName: "edit_current_note",
        questions: [
          {
            id: "allow",
            header: "Allow",
            question: "Allow llm_for_zotero to use edit_current_note?",
            options: [
              { label: "Allow", description: "Allow trusted access." },
              { label: "Deny", description: "Deny access." },
            ],
          },
        ],
      },
    });
    assert.equal(currentWriteDecision.approved, true);
    assert.deepEqual(currentWriteDecision.response, {
      answers: { allow: { answers: ["Allow"] } },
    });

    const suffixedApprovalDecision = resolveCodexNativeApprovalRequest({
      method: "item/tool/requestUserInput",
      params: {
        serverName: "llm_for_zotero_profile_1234",
        toolName: "edit_current_note",
        questions: [
          {
            id: "mcp_access",
            header: "Allow",
            question: "Allow llm_for_zotero to use edit_current_note?",
            options: [
              { label: "Reject" },
              { label: "Allow once (Recommended)" },
            ],
          },
        ],
      },
    });
    assert.equal(suffixedApprovalDecision.approved, true);
    assert.deepEqual(suffixedApprovalDecision.response, {
      answers: { mcp_access: { answers: ["Allow once (Recommended)"] } },
    });

    const turnApprovalDecision = resolveSafeCodexNativeApprovalRequest({
      method: "turn/approval/request",
      params: {
        serverName: "llm_for_zotero_profile_1234",
        toolName: "edit_current_note",
        message: "Allow llm_for_zotero to use edit_current_note?",
      },
    });
    assert.equal(turnApprovalDecision?.approved, true);
    assert.deepEqual(turnApprovalDecision?.response, { approved: true });

    assert.isNull(
      resolveSafeCodexNativeApprovalRequest({
        method: "tool/requestUserInput",
        params: {
          serverName: "llm_for_zotero_profile_1234",
          toolName: "zotero_confirm_action",
        },
      }),
    );
    const disallowedSelfConfirm = resolveCodexNativeApprovalRequest({
      method: "tool/requestUserInput",
      params: {
        serverName: "llm_for_zotero_profile_1234",
        toolName: "zotero_confirm_action",
      },
    });
    assert.equal(disallowedSelfConfirm.approved, false);
    assert.deepEqual(disallowedSelfConfirm.response, {
      approved: false,
      error:
        "Zotero only auto-approves trusted llm_for_zotero MCP access. " +
        "Built-in Codex approvals are disabled.",
    });
    assert.isNull(
      resolveSafeCodexNativeApprovalRequest({
        method: "tool/requestUserInput",
        params: {
          serverName: "unrelated_mcp",
          toolName: "query_library",
        },
      }),
    );
  });

  it("returns schema-valid denials for current native approval request methods", function () {
    assert.deepEqual(
      resolveCodexNativeApprovalRequest({
        method: "item/commandExecution/requestApproval",
        params: { command: "date" },
      }).response,
      { decision: "decline" },
    );
    assert.deepEqual(
      resolveCodexNativeApprovalRequest({
        method: "item/fileChange/requestApproval",
        params: { path: "/tmp/example.txt" },
      }).response,
      { decision: "decline" },
    );
    assert.deepEqual(
      resolveCodexNativeApprovalRequest({
        method: "item/permissions/requestApproval",
        params: { permissions: ["filesystem.write"] },
      }).response,
      { permissions: {}, scope: "turn" },
    );
    assert.deepEqual(
      resolveCodexNativeApprovalRequest({
        method: "mcpServer/elicitation/request",
        params: { serverName: "other_server", message: "Need input" },
      }).response,
      { action: "decline", content: null, _meta: null },
    );
  });

  it("starts persistent native threads and injects legacy UI history once", async function () {
    const stdout = new MockStdout();
    const methods: string[] = [];
    let threadStartParams: Record<string, unknown> | null = null;
    let mcpServerName = "";
    let injectedItems: unknown = null;
    let turnStartParams: Record<string, unknown> | null = null;
    let turnInput: unknown = null;
    let persistedThreadId = "";
    const prefStore = new Map<string, unknown>();

    if (globalThis.process?.env) {
      globalThis.process.env.CODEX_PATH = "/mock/codex";
    }
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      ...(originalZotero || {}),
      isWin: true,
      Profile: { dir: "/tmp/zotero-native-client-profile-a" },
      Prefs: {
        get: (key: string) => {
          if (key === "httpServer.port") return 23119;
          return prefStore.get(key);
        },
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
    (
      globalThis as typeof globalThis & { ztoolkit: { log: () => void } }
    ).ztoolkit = { log: () => undefined };
    (
      globalThis as typeof globalThis & {
        ChromeUtils?: {
          importESModule: (path: string) => {
            Subprocess: { call: () => Promise<unknown> };
          };
        };
      }
    ).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async () => ({
            stdout,
            stdin: {
              write: (chunk: string) => {
                for (const line of chunk.split("\n")) {
                  if (!line.trim()) continue;
                  const message = JSON.parse(line) as {
                    id?: number;
                    method?: string;
                    params?: Record<string, unknown> & { input?: unknown };
                  };
                  if (!message.method || message.method === "initialized") {
                    continue;
                  }
                  methods.push(message.method);
                  if (message.method === "initialize") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "config/value/write") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "config/mcpServer/reload") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "config/read") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { mcp_servers: mcpServerName ? { [mcpServerName]: { url: "http://127.0.0.1:23119/llm-for-zotero/mcp" } } : {} } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "mcpServerStatus/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { servers: [{ name: mcpServerName, status: "ready", tools: [{ name: "query_library" }, { name: "read_library" }] }] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "skills/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { skills: [] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "plugin/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { plugins: [] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/start") {
                    threadStartParams = message.params || null;
                    const config = (threadStartParams?.config || {}) as {
                      mcp_servers?: Record<string, unknown>;
                    };
                    mcpServerName =
                      Object.keys(config.mcp_servers || {})[0] || "";
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-native-1", source: "appServer" } } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/name/set") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/inject_items") {
                    injectedItems = message.params?.items ?? null;
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "turn/start") {
                    turnStartParams = message.params || null;
                    turnInput = message.params?.input ?? null;
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { turn: { id: "turn-1" } } })}\n`,
                    );
                    queueMicrotask(() => {
                      stdout.push(
                        `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-1", delta: "Hello native" } })}\n`,
                      );
                      stdout.push(
                        `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-1", status: "completed" } })}\n`,
                      );
                    });
                  }
                  if (message.method === "thread/read") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-native-1" }, turns: [{ id: "turn-1" }] } })}\n`,
                    );
                    continue;
                  }
                }
              },
            },
            kill: () => undefined,
          }),
        },
      }),
    };

    const result = await runCodexAppServerNativeTurn({
      processKey: "native-client-test",
      codexPath: "/mock/codex",
      scope: {
        conversationKey: 6_000_000_001,
        libraryID: 1,
        kind: "global",
        title: "Latest question",
      },
      model: "gpt-5.4",
      messages: [
        {
          role: "system",
          content: "Document Context:\nImportant paper context.",
        },
        { role: "user", content: "Earlier question." },
        { role: "assistant", content: "Earlier answer." },
        { role: "user", content: "Latest question." },
      ],
      hooks: {
        loadProviderSessionId: async () => undefined,
        persistProviderSessionId: async (threadId) => {
          persistedThreadId = threadId;
        },
      },
    });

    assert.equal(result.text, "Hello native");
    assert.equal(result.threadId, "thread-native-1");
    assert.equal(persistedThreadId, "thread-native-1");
    assert.includeMembers(methods, [
      "initialize",
      "thread/start",
      "thread/name/set",
      "thread/inject_items",
      "turn/start",
      "thread/read",
    ]);
    assert.notInclude(methods, "config/value/write");
    assert.notInclude(methods, "config/mcpServer/reload");
    assert.notInclude(methods, "mcpServerStatus/list");
    assert.notInclude(methods, "skills/list");
    assert.notInclude(methods, "plugin/list");
    assert.equal(threadStartParams?.ephemeral, false);
    assert.equal(threadStartParams?.persistExtendedHistory, true);
    assert.equal(threadStartParams?.approvalPolicy, "on-request");
    assert.equal(threadStartParams?.approvalsReviewer, "user");
    assert.equal(threadStartParams?.serviceName, "llm_for_zotero");
    assert.notProperty(threadStartParams || {}, "dynamicTools");
    assert.isString(threadStartParams?.developerInstructions);
    assert.include(
      String(threadStartParams?.developerInstructions || ""),
      "Zotero environment for this turn",
    );
    assert.include(
      String(threadStartParams?.developerInstructions || ""),
      "Important paper context.",
    );
    assert.include(
      String(threadStartParams?.developerInstructions || ""),
      "Do not inspect local Zotero profile folders",
    );
    const threadConfig = threadStartParams?.config as Record<string, any>;
    assert.deepEqual(threadConfig.features, { shell_tool: false });
    const servers = threadConfig.mcp_servers as Record<string, any>;
    assert.lengthOf(Object.keys(servers), 1);
    assert.match(Object.keys(servers)[0], /^llm_for_zotero_profile_/);
    const serverConfig = servers[Object.keys(servers)[0]];
    assert.equal(serverConfig.required, true);
    assert.equal(serverConfig.url, "http://127.0.0.1:23119/llm-for-zotero/mcp");
    assert.equal(serverConfig.default_tools_approval_mode, "approve");
    assert.include(serverConfig.http_headers.Authorization, "Bearer ");
    assert.isString(serverConfig.http_headers[ZOTERO_MCP_SCOPE_HEADER]);
    assert.include(serverConfig.enabled_tools, "query_library");
    assert.include(serverConfig.enabled_tools, "read_library");
    assert.include(serverConfig.enabled_tools, "edit_current_note");
    assert.notInclude(serverConfig.enabled_tools, "zotero_confirm_action");
    assert.equal(serverConfig.tools.edit_current_note.approval_mode, "approve");
    assert.equal(serverConfig.tools.query_library.approval_mode, "approve");
    assert.notProperty(serverConfig.tools, "zotero_confirm_action");
    assert.deepEqual(injectedItems, [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Earlier question." }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Earlier answer." }],
      },
    ]);
    assert.isArray(turnInput);
    assert.equal(turnStartParams?.approvalPolicy, "on-request");
    assert.equal(turnStartParams?.approvalsReviewer, "user");
    const textInput = (turnInput as Array<Record<string, unknown>>).find(
      (part) => part.type === "text",
    );
    assert.equal(String(textInput?.text || ""), "Latest question.");
    assert.notInclude(
      String(textInput?.text || ""),
      "Zotero context for this turn",
    );
    assert.notInclude(
      String(textInput?.text || ""),
      "Zotero environment for this turn",
    );
    assert.equal(result.diagnostics?.mcpReady, true);
    assert.equal(result.diagnostics?.historyVerified, true);
    assert.equal(result.diagnostics?.mcpServerName, Object.keys(servers)[0]);
  });

  it("injects matched LLM-for-Zotero skills into native developer instructions", async function () {
    let nativeThreadStartParams: Record<string, unknown> | null = null;
    let mcpServerName = "";
    const activatedSkillIds: string[] = [];
    const prefStore = new Map<string, unknown>();
    setUserSkills([makeSkill("write-note", "Use the write-note workflow.")]);
    prefStore.set(
      "extensions.zotero.llmforzotero.obsidianVaultPath",
      "/tmp/obsidian-vault",
    );
    prefStore.set(
      "extensions.zotero.llmforzotero.obsidianTargetFolder",
      "Logs",
    );
    prefStore.set(
      "extensions.zotero.llmforzotero.obsidianAttachmentsFolder",
      "Logs/imgs",
    );
    prefStore.set(
      "extensions.zotero.llmforzotero.notesDirectoryNickname",
      "Obsidian",
    );

    if (globalThis.process?.env) {
      globalThis.process.env.CODEX_PATH = "/mock/codex";
    }
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      ...(originalZotero || {}),
      isWin: true,
      Profile: { dir: "/tmp/zotero-native-client-profile-skills" },
      Prefs: {
        get: (key: string) => {
          if (key === "httpServer.port") return 23119;
          return prefStore.get(key);
        },
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
    (
      globalThis as typeof globalThis & {
        ChromeUtils?: {
          importESModule: (path: string) => {
            Subprocess: { call: () => Promise<unknown> };
          };
        };
      }
    ).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async () => {
            const stdout = new MockStdout();
            return {
              stdout,
              stdin: {
                write: (chunk: string) => {
                  for (const line of chunk.split("\n")) {
                    if (!line.trim()) continue;
                    const message = JSON.parse(line) as {
                      id?: number;
                      method?: string;
                      params?: Record<string, unknown> & { input?: unknown };
                    };
                    if (!message.method || message.method === "initialized") {
                      continue;
                    }
                    if (message.method === "initialize") {
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: {} })}\n`,
                      );
                      continue;
                    }
                    if (message.method === "thread/start") {
                      if (message.params?.ephemeral === true) {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "thread-classifier" } })}\n`,
                        );
                        continue;
                      }
                      nativeThreadStartParams = message.params || null;
                      const config = (nativeThreadStartParams?.config ||
                        {}) as {
                        mcp_servers?: Record<string, unknown>;
                      };
                      mcpServerName =
                        Object.keys(config.mcp_servers || {})[0] || "";
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-skills", source: "appServer" } } })}\n`,
                      );
                      continue;
                    }
                    if (message.method === "thread/name/set") {
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: {} })}\n`,
                      );
                      continue;
                    }
                    if (message.method === "turn/start") {
                      if (message.params?.threadId === "thread-classifier") {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "turn-classifier" } })}\n`,
                        );
                        queueMicrotask(() => {
                          stdout.push(
                            `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-classifier", delta: '{"skillIds":["write-note"]}' } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-classifier", status: "completed" } })}\n`,
                          );
                        });
                        continue;
                      }
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: { turn: { id: "turn-skills" } } })}\n`,
                      );
                      queueMicrotask(() => {
                        stdout.push(
                          `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-skills", delta: "Done." } })}\n`,
                        );
                        stdout.push(
                          `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-skills", status: "completed" } })}\n`,
                        );
                      });
                      continue;
                    }
                    if (message.method === "thread/inject_items") {
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: {} })}\n`,
                      );
                      continue;
                    }
                    if (message.method === "config/read") {
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: { mcp_servers: mcpServerName ? { [mcpServerName]: { url: "http://127.0.0.1:23119/llm-for-zotero/mcp" } } : {} } })}\n`,
                      );
                      continue;
                    }
                    if (message.method === "mcpServerStatus/list") {
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: { servers: [{ name: mcpServerName, status: "ready", tools: [{ name: "query_library" }, { name: "read_library" }] }] } })}\n`,
                      );
                      continue;
                    }
                    if (message.method === "skills/list") {
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: { skills: [] } })}\n`,
                      );
                      continue;
                    }
                    if (message.method === "plugin/list") {
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: { plugins: [] } })}\n`,
                      );
                      continue;
                    }
                    if (message.method === "thread/read") {
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-skills" }, turns: [{ id: "turn-skills" }] } })}\n`,
                      );
                      continue;
                    }
                    throw new Error(`unexpected method ${message.method}`);
                  }
                },
              },
              kill: () => undefined,
            };
          },
        },
      }),
    };

    const result = await runCodexAppServerNativeTurn({
      processKey: "native-client-skills-test",
      codexPath: "/mock/codex",
      scope: {
        conversationKey: 6_000_000_010,
        libraryID: 1,
        kind: "global",
        title: "Write note",
      },
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Use native skill guidance." }],
      hooks: {
        loadProviderSessionId: async () => undefined,
        persistProviderSessionId: async () => undefined,
      },
      onSkillActivated: (skillId) => {
        activatedSkillIds.push(skillId);
      },
    });

    const developerInstructions = String(
      nativeThreadStartParams?.developerInstructions || "",
    );
    assert.equal(result.text, "Done.");
    assert.deepEqual(activatedSkillIds, ["write-note"]);
    assert.deepEqual(result.diagnostics?.skillIds, ["write-note"]);
    assert.include(developerInstructions, "Zotero environment for this turn");
    assert.include(
      developerInstructions,
      "LLM-for-Zotero skills active for this turn",
    );
    assert.include(
      developerInstructions,
      "Notes directory configuration (user-configured):",
    );
    assert.include(developerInstructions, "- Nickname: Obsidian");
    assert.include(
      developerInstructions,
      "- Default target path: /tmp/obsidian-vault/Logs",
    );
    assert.include(
      developerInstructions,
      "- Attachments path: /tmp/obsidian-vault/Logs/imgs",
    );
    assert.include(developerInstructions, "Skill: write-note");
    assert.include(developerInstructions, "Use the write-note workflow.");
  });

  it("keeps skill guidance in visible context when developer instructions are unsupported", async function () {
    let rejectedDeveloperInstructions = false;
    let nativeTurnInput: unknown = null;
    let mcpServerName = "";
    const prefStore = new Map<string, unknown>();
    setUserSkills([makeSkill("write-note", "Use the write-note workflow.")]);

    if (globalThis.process?.env) {
      globalThis.process.env.CODEX_PATH = "/mock/codex";
    }
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      ...(originalZotero || {}),
      isWin: true,
      Profile: { dir: "/tmp/zotero-native-client-profile-skills-fallback" },
      Prefs: {
        get: (key: string) => {
          if (key === "httpServer.port") return 23119;
          return prefStore.get(key);
        },
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
    (
      globalThis as typeof globalThis & {
        ChromeUtils?: {
          importESModule: (path: string) => {
            Subprocess: { call: () => Promise<unknown> };
          };
        };
      }
    ).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async () => {
            const stdout = new MockStdout();
            return {
              stdout,
              stdin: {
                write: (chunk: string) => {
                  for (const line of chunk.split("\n")) {
                    if (!line.trim()) continue;
                    const message = JSON.parse(line) as {
                      id?: number;
                      method?: string;
                      params?: Record<string, unknown> & { input?: unknown };
                    };
                    if (!message.method || message.method === "initialized") {
                      continue;
                    }
                    if (message.method === "initialize") {
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: {} })}\n`,
                      );
                      continue;
                    }
                    if (message.method === "thread/start") {
                      if (message.params?.ephemeral === true) {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "thread-classifier-fallback" } })}\n`,
                        );
                        continue;
                      }
                      if (
                        message.params?.developerInstructions &&
                        !rejectedDeveloperInstructions
                      ) {
                        rejectedDeveloperInstructions = true;
                        stdout.push(
                          `${JSON.stringify({ id: message.id, error: { code: -32602, message: "Invalid params: unknown field developerInstructions" } })}\n`,
                        );
                        continue;
                      }
                      const config = (message.params?.config || {}) as {
                        mcp_servers?: Record<string, unknown>;
                      };
                      mcpServerName =
                        Object.keys(config.mcp_servers || {})[0] || "";
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-skills-fallback", source: "appServer" } } })}\n`,
                      );
                      continue;
                    }
                    if (message.method === "thread/name/set") {
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: {} })}\n`,
                      );
                      continue;
                    }
                    if (message.method === "turn/start") {
                      if (
                        message.params?.threadId ===
                        "thread-classifier-fallback"
                      ) {
                        stdout.push(
                          `${JSON.stringify({ id: message.id, result: { id: "turn-classifier-fallback" } })}\n`,
                        );
                        queueMicrotask(() => {
                          stdout.push(
                            `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-classifier-fallback", delta: '{"skillIds":["write-note"]}' } })}\n`,
                          );
                          stdout.push(
                            `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-classifier-fallback", status: "completed" } })}\n`,
                          );
                        });
                        continue;
                      }
                      nativeTurnInput = message.params?.input ?? null;
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: { turn: { id: "turn-skills-fallback" } } })}\n`,
                      );
                      queueMicrotask(() => {
                        stdout.push(
                          `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-skills-fallback", delta: "Done." } })}\n`,
                        );
                        stdout.push(
                          `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-skills-fallback", status: "completed" } })}\n`,
                        );
                      });
                      continue;
                    }
                    if (message.method === "thread/inject_items") {
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: {} })}\n`,
                      );
                      continue;
                    }
                    if (message.method === "config/read") {
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: { mcp_servers: mcpServerName ? { [mcpServerName]: { url: "http://127.0.0.1:23119/llm-for-zotero/mcp" } } : {} } })}\n`,
                      );
                      continue;
                    }
                    if (message.method === "mcpServerStatus/list") {
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: { servers: [{ name: mcpServerName, status: "ready", tools: [{ name: "query_library" }, { name: "read_library" }] }] } })}\n`,
                      );
                      continue;
                    }
                    if (message.method === "skills/list") {
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: { skills: [] } })}\n`,
                      );
                      continue;
                    }
                    if (message.method === "plugin/list") {
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: { plugins: [] } })}\n`,
                      );
                      continue;
                    }
                    if (message.method === "thread/read") {
                      stdout.push(
                        `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-skills-fallback" }, turns: [{ id: "turn-skills-fallback" }] } })}\n`,
                      );
                      continue;
                    }
                    throw new Error(`unexpected method ${message.method}`);
                  }
                },
              },
              kill: () => undefined,
            };
          },
        },
      }),
    };

    const result = await runCodexAppServerNativeTurn({
      processKey: "native-client-skills-fallback-test",
      codexPath: "/mock/codex",
      scope: {
        conversationKey: 6_000_000_011,
        libraryID: 1,
        kind: "global",
        title: "Write note",
      },
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Use native skill guidance." }],
      hooks: {
        loadProviderSessionId: async () => undefined,
        persistProviderSessionId: async () => undefined,
      },
    });

    const textInput = (nativeTurnInput as Array<Record<string, unknown>>).find(
      (part) => part.type === "text",
    );
    const text = String(textInput?.text || "");
    assert.equal(result.text, "Done.");
    assert.isTrue(rejectedDeveloperInstructions);
    assert.include(text, "Zotero context for this turn");
    assert.include(text, "LLM-for-Zotero skills active for this turn");
    assert.include(text, "Skill: write-note");
    assert.include(text, "Use the write-note workflow.");
    assert.include(text, "User request:");
  });

  it("resumes stored native threads without reinjecting mirrored history", async function () {
    const stdout = new MockStdout();
    const methods: string[] = [];
    let resumeParams: Record<string, unknown> | null = null;
    let mcpServerName = "";
    let turnStartParams: Record<string, unknown> | null = null;
    let turnInput: unknown = null;
    let injectCalled = false;
    const prefStore = new Map<string, unknown>();

    if (globalThis.process?.env) {
      globalThis.process.env.CODEX_PATH = "/mock/codex";
    }
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      ...(originalZotero || {}),
      isWin: true,
      Profile: { dir: "/tmp/zotero-native-client-profile-b" },
      Prefs: {
        get: (key: string) => {
          if (key === "httpServer.port") return 23119;
          return prefStore.get(key);
        },
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
    (
      globalThis as typeof globalThis & {
        ChromeUtils?: {
          importESModule: (path: string) => {
            Subprocess: { call: () => Promise<unknown> };
          };
        };
      }
    ).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async () => ({
            stdout,
            stdin: {
              write: (chunk: string) => {
                for (const line of chunk.split("\n")) {
                  if (!line.trim()) continue;
                  const message = JSON.parse(line) as {
                    id?: number;
                    method?: string;
                    params?: Record<string, unknown> & { input?: unknown };
                  };
                  if (!message.method || message.method === "initialized") {
                    continue;
                  }
                  methods.push(message.method);
                  if (message.method === "initialize") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "config/value/write") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "config/mcpServer/reload") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "config/read") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { mcp_servers: mcpServerName ? { [mcpServerName]: { url: "http://127.0.0.1:23119/llm-for-zotero/mcp" } } : {} } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "mcpServerStatus/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { servers: [{ name: mcpServerName, status: "ready", tools: [{ name: "query_library" }, { name: "read_library" }] }] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "skills/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { skills: [] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "plugin/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { plugins: [] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/resume") {
                    resumeParams = message.params || null;
                    const config = (resumeParams?.config || {}) as {
                      mcp_servers?: Record<string, unknown>;
                    };
                    mcpServerName =
                      Object.keys(config.mcp_servers || {})[0] || "";
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-native-1", source: "appServer" } } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/inject_items") {
                    injectCalled = true;
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "turn/start") {
                    turnStartParams = message.params || null;
                    turnInput = message.params?.input ?? null;
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { turn: { id: "turn-2" } } })}\n`,
                    );
                    queueMicrotask(() => {
                      stdout.push(
                        `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-2", delta: "Resumed" } })}\n`,
                      );
                      stdout.push(
                        `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-2", status: "completed" } })}\n`,
                      );
                    });
                  }
                  if (message.method === "thread/read") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-native-1" }, turns: [{ id: "turn-2" }] } })}\n`,
                    );
                    continue;
                  }
                }
              },
            },
            kill: () => undefined,
          }),
        },
      }),
    };

    const result = await runCodexAppServerNativeTurn({
      processKey: "native-client-resume-test",
      codexPath: "/mock/codex",
      scope: {
        conversationKey: 6_000_000_001,
        libraryID: 1,
        kind: "global",
      },
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "Document Context:\nFresh context." },
        { role: "user", content: "Earlier question." },
        { role: "assistant", content: "Earlier answer." },
        { role: "user", content: "Follow-up question." },
      ],
      hooks: {
        loadProviderSessionId: async () => "thread-native-1",
        persistProviderSessionId: async () => {
          assert.fail("resume should not persist a new thread id");
        },
      },
    });

    assert.equal(result.text, "Resumed");
    assert.equal(result.resumed, true);
    assert.equal(resumeParams?.threadId, "thread-native-1");
    assert.equal(resumeParams?.model, "gpt-5.4");
    assert.equal(resumeParams?.persistExtendedHistory, true);
    assert.equal(resumeParams?.approvalPolicy, "on-request");
    assert.equal(resumeParams?.approvalsReviewer, "user");
    assert.notProperty(resumeParams || {}, "serviceName");
    assert.isString(resumeParams?.developerInstructions);
    assert.include(
      String(resumeParams?.developerInstructions || ""),
      "Zotero environment for this turn",
    );
    assert.include(
      String(resumeParams?.developerInstructions || ""),
      "Fresh context.",
    );
    const resumeConfig = resumeParams?.config as Record<string, any>;
    assert.deepEqual(resumeConfig.features, { shell_tool: false });
    const servers = resumeConfig.mcp_servers as Record<string, any>;
    assert.lengthOf(Object.keys(servers), 1);
    assert.equal(servers[Object.keys(servers)[0]].required, true);
    assert.include(
      servers[Object.keys(servers)[0]].enabled_tools,
      "edit_current_note",
    );
    assert.notInclude(
      servers[Object.keys(servers)[0]].enabled_tools,
      "zotero_confirm_action",
    );
    assert.includeMembers(methods, [
      "initialize",
      "thread/resume",
      "turn/start",
      "thread/read",
    ]);
    assert.notInclude(methods, "config/value/write");
    assert.notInclude(methods, "config/mcpServer/reload");
    assert.notInclude(methods, "mcpServerStatus/list");
    assert.notInclude(methods, "skills/list");
    assert.notInclude(methods, "plugin/list");
    assert.notInclude(methods, "thread/start");
    assert.isFalse(injectCalled);
    assert.equal(turnStartParams?.approvalPolicy, "on-request");
    assert.equal(turnStartParams?.approvalsReviewer, "user");
    const textInput = (turnInput as Array<Record<string, unknown>>).find(
      (part) => part.type === "text",
    );
    const text = String(textInput?.text || "");
    assert.equal(text, "Follow-up question.");
    assert.notInclude(text, "Zotero environment for this turn");
    assert.notInclude(text, "Fresh context.");
    assert.notInclude(text, "Earlier question.");
    assert.equal(result.diagnostics?.historyVerified, true);
  });

  it("handles current tool user-input requests before native MCP write calls", async function () {
    const stdout = new MockStdout();
    const methods: string[] = [];
    let mcpServerName = "";
    let approvalResponse: Record<string, unknown> | null = null;
    const prefStore = new Map<string, unknown>();

    if (globalThis.process?.env) {
      globalThis.process.env.CODEX_PATH = "/mock/codex";
    }
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      ...(originalZotero || {}),
      isWin: true,
      Profile: { dir: "/tmp/zotero-native-client-profile-approval" },
      Prefs: {
        get: (key: string) => {
          if (key === "httpServer.port") return 23119;
          return prefStore.get(key);
        },
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
    (
      globalThis as typeof globalThis & {
        ChromeUtils?: {
          importESModule: (path: string) => {
            Subprocess: { call: () => Promise<unknown> };
          };
        };
      }
    ).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async () => ({
            stdout,
            stdin: {
              write: (chunk: string) => {
                for (const line of chunk.split("\n")) {
                  if (!line.trim()) continue;
                  const message = JSON.parse(line) as {
                    id?: number;
                    method?: string;
                    params?: Record<string, unknown> & { input?: unknown };
                    result?: unknown;
                    error?: unknown;
                  };
                  if (!message.method) {
                    if (message.id === 900) {
                      approvalResponse = message as Record<string, unknown>;
                      queueMicrotask(() => {
                        stdout.push(
                          `${JSON.stringify({ method: "item/started", params: { turnId: "turn-approval", item: { id: "tool-1", type: "mcp_tool_call", toolName: "edit_current_note", serverName: mcpServerName, arguments: { mode: "create", target: "standalone" } } } })}\n`,
                        );
                        stdout.push(
                          `${JSON.stringify({ method: "item/completed", params: { turnId: "turn-approval", item: { id: "tool-1", type: "mcp_tool_call", toolName: "edit_current_note", serverName: mcpServerName, summary: "Created standalone note." } } })}\n`,
                        );
                        stdout.push(
                          `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-approval", delta: "Created the standalone note." } })}\n`,
                        );
                        stdout.push(
                          `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-approval", status: "completed" } })}\n`,
                        );
                      });
                    }
                    continue;
                  }
                  if (message.method === "initialized") continue;
                  methods.push(message.method);
                  if (message.method === "initialize") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "config/read") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { mcp_servers: mcpServerName ? { [mcpServerName]: { url: "http://127.0.0.1:23119/llm-for-zotero/mcp" } } : {} } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "mcpServerStatus/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { servers: [{ name: mcpServerName, status: "ready", tools: [{ name: "query_library" }, { name: "read_library" }, { name: "edit_current_note" }] }] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "skills/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { skills: [] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "plugin/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { plugins: [] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/start") {
                    const config = (message.params?.config || {}) as {
                      mcp_servers?: Record<string, unknown>;
                    };
                    mcpServerName =
                      Object.keys(config.mcp_servers || {})[0] || "";
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-approval", source: "appServer" } } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/name/set") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "turn/start") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { turn: { id: "turn-approval" } } })}\n`,
                    );
                    queueMicrotask(() => {
                      stdout.push(
                        `${JSON.stringify({
                          id: 900,
                          method: "item/tool/requestUserInput",
                          params: {
                            turnId: "turn-approval",
                            itemId: "tool-approval-1",
                            serverName: mcpServerName,
                            toolName: "edit_current_note",
                            questions: [
                              {
                                id: "allow",
                                header: "Allow",
                                question:
                                  "Allow llm_for_zotero to use edit_current_note?",
                                options: [
                                  {
                                    label: "Allow",
                                    description: "Allow trusted access.",
                                  },
                                  {
                                    label: "Deny",
                                    description: "Deny access.",
                                  },
                                ],
                              },
                            ],
                          },
                        })}\n`,
                      );
                    });
                    continue;
                  }
                  if (message.method === "thread/read") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-approval" }, turns: [{ id: "turn-approval" }] } })}\n`,
                    );
                    continue;
                  }
                  throw new Error(`unexpected method ${message.method}`);
                }
              },
            },
            kill: () => undefined,
          }),
        },
      }),
    };

    const result = await runCodexAppServerNativeTurn({
      processKey: "native-client-approval-request-test",
      codexPath: "/mock/codex",
      scope: {
        conversationKey: 6_000_000_003,
        libraryID: 1,
        kind: "global",
        title: "Write note",
      },
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Create a standalone note." }],
      hooks: {
        loadProviderSessionId: async () => undefined,
        persistProviderSessionId: async () => undefined,
      },
    });

    assert.equal(result.text, "Created the standalone note.");
    assert.include(methods, "turn/start");
    assert.isNotNull(approvalResponse);
    assert.notProperty(approvalResponse || {}, "error");
    assert.deepEqual(approvalResponse?.result, {
      answers: { allow: { answers: ["Allow"] } },
    });
  });

  it("approves trusted Zotero MCP guardian denials before the tool is rejected", async function () {
    const stdout = new MockStdout();
    const methods: string[] = [];
    let mcpServerName = "";
    let guardianApprovalParams: Record<string, unknown> | null = null;
    const prefStore = new Map<string, unknown>();

    if (globalThis.process?.env) {
      globalThis.process.env.CODEX_PATH = "/mock/codex";
    }
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      ...(originalZotero || {}),
      isWin: true,
      Profile: { dir: "/tmp/zotero-native-client-profile-guardian" },
      Prefs: {
        get: (key: string) => {
          if (key === "httpServer.port") return 23119;
          return prefStore.get(key);
        },
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
    (
      globalThis as typeof globalThis & {
        ChromeUtils?: {
          importESModule: (path: string) => {
            Subprocess: { call: () => Promise<unknown> };
          };
        };
      }
    ).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async () => ({
            stdout,
            stdin: {
              write: (chunk: string) => {
                for (const line of chunk.split("\n")) {
                  if (!line.trim()) continue;
                  const message = JSON.parse(line) as {
                    id?: number;
                    method?: string;
                    params?: Record<string, unknown>;
                  };
                  if (!message.method || message.method === "initialized") {
                    continue;
                  }
                  methods.push(message.method);
                  if (message.method === "initialize") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "config/read") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { mcp_servers: mcpServerName ? { [mcpServerName]: { url: "http://127.0.0.1:23119/llm-for-zotero/mcp" } } : {} } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "mcpServerStatus/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { servers: [{ name: mcpServerName, status: "ready", tools: [{ name: "query_library" }, { name: "read_library" }, { name: "edit_current_note" }] }] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "skills/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { skills: [] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "plugin/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { plugins: [] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/start") {
                    const config = (message.params?.config || {}) as {
                      mcp_servers?: Record<string, unknown>;
                    };
                    mcpServerName =
                      Object.keys(config.mcp_servers || {})[0] || "";
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-guardian", source: "appServer" } } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/name/set") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "turn/start") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { turn: { id: "turn-guardian" } } })}\n`,
                    );
                    queueMicrotask(() => {
                      stdout.push(
                        `${JSON.stringify({ method: "item/autoApprovalReview/completed", params: { threadId: "thread-guardian", turnId: "turn-guardian", reviewId: "review-1", targetItemId: "tool-1", decisionSource: "agent", review: { status: "denied", riskLevel: "medium", userAuthorization: "low", rationale: "MCP write tool requires approval." }, action: { type: "mcpToolCall", server: mcpServerName, toolName: "edit_current_note", connectorId: null, connectorName: null, toolTitle: "Edit Current Note" } } })}\n`,
                      );
                    });
                    continue;
                  }
                  if (message.method === "thread/approveGuardianDeniedAction") {
                    guardianApprovalParams = message.params || null;
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    queueMicrotask(() => {
                      stdout.push(
                        `${JSON.stringify({ method: "item/started", params: { turnId: "turn-guardian", item: { id: "tool-1", type: "mcp_tool_call", toolName: "edit_current_note", serverName: mcpServerName } } })}\n`,
                      );
                      stdout.push(
                        `${JSON.stringify({ method: "item/completed", params: { turnId: "turn-guardian", item: { id: "tool-1", type: "mcp_tool_call", toolName: "edit_current_note", serverName: mcpServerName, summary: "Created attached note." } } })}\n`,
                      );
                      stdout.push(
                        `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-guardian", delta: "Created the item note." } })}\n`,
                      );
                      stdout.push(
                        `${JSON.stringify({ method: "turn/completed", params: { turnId: "turn-guardian", status: "completed" } })}\n`,
                      );
                    });
                    continue;
                  }
                  if (message.method === "thread/read") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-guardian" }, turns: [{ id: "turn-guardian" }] } })}\n`,
                    );
                    continue;
                  }
                  throw new Error(`unexpected method ${message.method}`);
                }
              },
            },
            kill: () => undefined,
          }),
        },
      }),
    };

    const result = await runCodexAppServerNativeTurn({
      processKey: "native-client-guardian-review-test",
      codexPath: "/mock/codex",
      scope: {
        conversationKey: 6_000_000_005,
        libraryID: 1,
        kind: "global",
        title: "Write note",
      },
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Create an item note." }],
      hooks: {
        loadProviderSessionId: async () => undefined,
        persistProviderSessionId: async () => undefined,
      },
    });

    assert.equal(result.text, "Created the item note.");
    assert.include(methods, "thread/approveGuardianDeniedAction");
    assert.equal(guardianApprovalParams?.threadId, "thread-guardian");
    assert.deepInclude(
      guardianApprovalParams?.event as Record<string, unknown>,
      {
        target_item_id: "tool-1",
        risk_level: "medium",
        user_authorization: "low",
        rationale: "MCP write tool requires approval.",
        decision_source: "agent",
      },
    );
    assert.deepEqual(
      (guardianApprovalParams?.event as { action?: unknown }).action,
      {
        type: "mcp_tool_call",
        server: mcpServerName,
        tool_name: "edit_current_note",
        connector_id: null,
        connector_name: null,
        tool_title: "Edit Current Note",
      },
    );
  });

  it("reuses the stored native thread for normal sends with the same conversation", async function () {
    const stdout = new MockStdout();
    const methods: string[] = [];
    let mcpServerName = "";
    let storedThreadId = "";
    let turnCount = 0;
    const prefStore = new Map<string, unknown>();

    if (globalThis.process?.env) {
      globalThis.process.env.CODEX_PATH = "/mock/codex";
    }
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      ...(originalZotero || {}),
      isWin: true,
      Profile: { dir: "/tmp/zotero-native-client-profile-thread-reuse" },
      Prefs: {
        get: (key: string) => {
          if (key === "httpServer.port") return 23119;
          return prefStore.get(key);
        },
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
    (
      globalThis as typeof globalThis & {
        ChromeUtils?: {
          importESModule: (path: string) => {
            Subprocess: { call: () => Promise<unknown> };
          };
        };
      }
    ).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async () => ({
            stdout,
            stdin: {
              write: (chunk: string) => {
                for (const line of chunk.split("\n")) {
                  if (!line.trim()) continue;
                  const message = JSON.parse(line) as {
                    id?: number;
                    method?: string;
                    params?: Record<string, unknown>;
                  };
                  if (!message.method || message.method === "initialized") {
                    continue;
                  }
                  methods.push(message.method);
                  if (message.method === "initialize") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "config/read") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { mcp_servers: mcpServerName ? { [mcpServerName]: { url: "http://127.0.0.1:23119/llm-for-zotero/mcp" } } : {} } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "mcpServerStatus/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { servers: [{ name: mcpServerName, status: "ready", tools: [{ name: "query_library" }, { name: "read_library" }] }] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "skills/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { skills: [] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "plugin/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { plugins: [] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/start") {
                    const config = (message.params?.config || {}) as {
                      mcp_servers?: Record<string, unknown>;
                    };
                    mcpServerName =
                      Object.keys(config.mcp_servers || {})[0] || "";
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-reuse", source: "appServer" } } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/resume") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-reuse", source: "appServer" } } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/name/set") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "turn/start") {
                    turnCount += 1;
                    const turnId = `turn-reuse-${turnCount}`;
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { turn: { id: turnId } } })}\n`,
                    );
                    queueMicrotask(() => {
                      stdout.push(
                        `${JSON.stringify({ method: "item/agentMessage/delta", params: { turnId, delta: `Answer ${turnCount}` } })}\n`,
                      );
                      stdout.push(
                        `${JSON.stringify({ method: "turn/completed", params: { turnId, status: "completed" } })}\n`,
                      );
                    });
                    continue;
                  }
                  if (message.method === "thread/read") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-reuse" }, turns: [{ id: `turn-reuse-${turnCount}` }] } })}\n`,
                    );
                    continue;
                  }
                  throw new Error(`unexpected method ${message.method}`);
                }
              },
            },
            kill: () => undefined,
          }),
        },
      }),
    };

    const common = {
      processKey: "native-client-thread-reuse-test",
      codexPath: "/mock/codex",
      scope: {
        conversationKey: 6_000_000_004,
        libraryID: 1,
        kind: "global" as const,
        title: "Thread reuse",
      },
      model: "gpt-5.4",
      hooks: {
        loadProviderSessionId: async () => storedThreadId || undefined,
        persistProviderSessionId: async (threadId: string) => {
          storedThreadId = threadId;
        },
      },
    };

    const first = await runCodexAppServerNativeTurn({
      ...common,
      messages: [{ role: "user", content: "First question." }],
    });
    const second = await runCodexAppServerNativeTurn({
      ...common,
      messages: [{ role: "user", content: "Second question." }],
    });

    assert.equal(first.threadId, "thread-reuse");
    assert.equal(second.threadId, "thread-reuse");
    assert.equal(first.resumed, false);
    assert.equal(second.resumed, true);
    assert.equal(
      methods.filter((method) => method === "thread/start").length,
      1,
    );
    assert.equal(
      methods.filter((method) => method === "thread/resume").length,
      1,
    );
  });

  it("aborts native turns before model generation when required MCP tools are missing", async function () {
    const stdout = new MockStdout();
    const methods: string[] = [];
    let mcpServerName = "";
    const prefStore = new Map<string, unknown>();
    installMcpPreflightFetch(["query_library"]);

    if (globalThis.process?.env) {
      globalThis.process.env.CODEX_PATH = "/mock/codex";
    }
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      ...(originalZotero || {}),
      isWin: true,
      Profile: { dir: "/tmp/zotero-native-client-profile-missing-mcp" },
      Prefs: {
        get: (key: string) => {
          if (key === "httpServer.port") return 23119;
          return prefStore.get(key);
        },
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
    (
      globalThis as typeof globalThis & {
        ChromeUtils?: {
          importESModule: (path: string) => {
            Subprocess: { call: () => Promise<unknown> };
          };
        };
      }
    ).ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async () => ({
            stdout,
            stdin: {
              write: (chunk: string) => {
                for (const line of chunk.split("\n")) {
                  if (!line.trim()) continue;
                  const message = JSON.parse(line) as {
                    id?: number;
                    method?: string;
                    params?: Record<string, unknown>;
                  };
                  if (!message.method || message.method === "initialized") {
                    continue;
                  }
                  methods.push(message.method);
                  if (message.method === "initialize") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/start") {
                    const config = (message.params?.config || {}) as {
                      mcp_servers?: Record<string, unknown>;
                    };
                    mcpServerName =
                      Object.keys(config.mcp_servers || {})[0] || "";
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-native-missing", source: "appServer" } } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "thread/name/set") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: {} })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "config/read") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { mcp_servers: { [mcpServerName]: { url: "http://127.0.0.1:23119/llm-for-zotero/mcp" } } } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "mcpServerStatus/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { servers: [{ name: mcpServerName, status: "ready", tools: [{ name: "query_library" }] }] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "skills/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { skills: [] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "plugin/list") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, result: { plugins: [] } })}\n`,
                    );
                    continue;
                  }
                  if (message.method === "turn/start") {
                    stdout.push(
                      `${JSON.stringify({ id: message.id, error: { code: -32000, message: "turn/start should not run" } })}\n`,
                    );
                    continue;
                  }
                  throw new Error(`unexpected method ${message.method}`);
                }
              },
            },
            kill: () => undefined,
          }),
        },
      }),
    };

    let errorMessage = "";
    try {
      await runCodexAppServerNativeTurn({
        processKey: "native-client-missing-mcp-test",
        codexPath: "/mock/codex",
        scope: {
          conversationKey: 6_000_000_002,
          libraryID: 1,
          kind: "global",
          title: "Count papers",
        },
        model: "gpt-5.4",
        messages: [{ role: "user", content: "How many papers?" }],
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => undefined,
        },
      });
      assert.fail("expected missing MCP tools to abort the turn");
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      destroyCachedCodexAppServerProcess("native-client-missing-mcp-test");
    }

    assert.include(errorMessage, "Zotero MCP setup failed");
    assert.include(errorMessage, "missing required tools: read_library");
    assert.notInclude(methods, "turn/start");
  });
});

import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import {
  freezeConversationWrites,
  getConversationWriteGeneration,
  unfreezeConversationWrites,
} from "../src/shared/conversationWriteFence";
import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import {
  CLAUDE_BRIDGE_SEARCH_TOOL_ROUTES,
  createExternalBackendBridgeRuntime,
  describeClaudeRuntimeToolEffect,
} from "../src/agent/externalBackendBridge";
import {
  AGENT_ACTION_CONTRACT,
  CORE_RESEARCH_CONTRACT,
  PAPER_CITATION_CONTRACT,
  RUNTIME_CAPABILITY_CONTEXT,
  SEARCH_ROUTING_CONTRACT,
} from "../src/shared/instructionContracts";
import { AGENT_SEARCH_TOOL_ROUTES } from "../src/agent/model/agentPersona";

describe("external bridge action approval handling", function () {
  function createRuntime(onPrepare?: () => void) {
    const runtime = createExternalBackendBridgeRuntime({
      coreRuntime: {
        prepareExecutionRequest: async (input: any) => {
          onPrepare?.();
          const request =
            "turnPaperScope" in input
              ? input
              : resolveAgentRuntimeRequest(input);
          request.conversationGeneration = getConversationWriteGeneration(
            request.conversationKey,
          );
          request.skillRoutingReceipt = undefined;
          request.executionContext = {
            version: 1,
            executionId: "external-test-execution",
            conversationKey: request.conversationKey,
            conversationGeneration: request.conversationGeneration,
            chatLibraryID: request.libraryID,
            permissionOwner: "external_runtime",
            workspaceSnapshot: {
              selectedPapers: [],
              selectedCollections: [],
            },
            configuredAccess: {
              libraryIDs: request.libraryID ? [request.libraryID] : [],
              outputDirectories: [],
            },
          };
          return request;
        },
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
    const runTurn = runtime.runTurn.bind(runtime);
    runtime.runTurn = async (params) => {
      const request = resolveAgentRuntimeRequest(params.request);
      request.conversationGeneration = getConversationWriteGeneration(
        request.conversationKey,
      );
      return runTurn({ ...params, request });
    };
    return runtime;
  }

  it("hands an ordinary request directly to Claude without semantic preparation", async function () {
    const originalFetch = globalThis.fetch;
    const originalZotero = (
      globalThis as typeof globalThis & {
        Zotero?: unknown;
      }
    ).Zotero;
    const urls: string[] = [];
    let bridgePayload: Record<string, any> | undefined;
    let prepareCalls = 0;

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Prefs: {
        get(key: string) {
          if (key.endsWith("enableClaudeCodeMode")) return true;
          if (key.endsWith("agentClaudeConfigSource")) return "default";
          if (key.endsWith("claudeCodePermissionMode")) return "default";
          if (key.endsWith("conversationSystem")) return "claude_code";
          if (key.endsWith("codexAppServerZoteroMcpToolsEnabled")) return false;
          return "";
        },
      },
      Profile: { dir: "/tmp/llm-for-zotero-direct-bridge-test" },
      DB: { queryAsync: async () => [] },
    };
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      urls.push(url);
      if (!url.endsWith("/run-turn")) {
        throw new Error(`Unexpected preliminary request: ${url}`);
      }
      bridgePayload = JSON.parse(String(init?.body || "{}"));
      return new Response(
        '{"type":"outcome","outcome":{"kind":"completed","runId":"direct-1","text":"ok","usedFallback":false}}\n',
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const outcome = await createRuntime(() => prepareCalls++).runTurn({
        request: {
          conversationKey: 445,
          mode: "agent",
          userText: "Move the paper to Learning and summarize it",
          model: "claude-sonnet",
          libraryID: 1,
        },
      });

      assert.equal(outcome.kind, "completed");
      if (outcome.kind === "completed") assert.equal(outcome.text, "ok");
      assert.equal(prepareCalls, 1);
      assert.deepEqual(urls, ["http://127.0.0.1:19787/run-turn"]);
      assert.equal(
        bridgePayload?.runtimeRequest?.executionContext?.executionId,
        "external-test-execution",
      );
      assert.equal(
        bridgePayload?.runtimeRequest?.executionContext?.permissionOwner,
        "external_runtime",
      );
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
    }
  });
  it("fails closed to a fresh session when cleanup readiness cannot be read", async function () {
    const originalFetch = globalThis.fetch;
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    let capturedBody: Record<string, any> | null = null;

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Prefs: {
        get(key: string) {
          if (key.endsWith("enableClaudeCodeMode")) return true;
          if (key.endsWith("agentClaudeConfigSource")) return "default";
          if (key.endsWith("claudeCodePermissionMode")) return "default";
          if (key.endsWith("conversationSystem")) return "claude_code";
          if (key.endsWith("codexAppServerZoteroMcpToolsEnabled")) return false;
          return "";
        },
      },
      Profile: { dir: "/tmp/llm-for-zotero-test-profile" },
      DB: {
        queryAsync: async (sql: string) => {
          if (sql.includes("conversation_cleanup_jobs")) {
            throw new Error("database is temporarily locked");
          }
          return [];
        },
      },
    };

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      capturedBody = JSON.parse(String(init?.body || "{}"));
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              '{"type":"outcome","outcome":{"kind":"completed","runId":"r1","text":"ok","usedFallback":false}}\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200 }) as Response;
    }) as typeof fetch;

    try {
      const runtime = createRuntime();
      await runtime.runTurn({
        request: {
          conversationKey: 99,
          metadata: { conversationInstanceID: "instance-99" },
          mode: "agent",
          userText: "hello",
          model: "claude-sonnet",
          authMode: "api_key",
          apiBase: "",
          apiKey: "",
          libraryID: 1,
        },
      });

      assert.equal(capturedBody?.metadata?.forceFreshSession, true);
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
    }
  });

  it("checks an empty cleanup witness by permanent key when the registry instance is unavailable", async function () {
    const originalFetch = globalThis.fetch;
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    let capturedBody: Record<string, any> | null = null;

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Prefs: {
        get(key: string) {
          if (key.endsWith("enableClaudeCodeMode")) return true;
          if (key.endsWith("agentClaudeConfigSource")) return "default";
          if (key.endsWith("claudeCodePermissionMode")) return "default";
          if (key.endsWith("conversationSystem")) return "claude_code";
          if (key.endsWith("codexAppServerZoteroMcpToolsEnabled")) return false;
          return "";
        },
      },
      Profile: { dir: "/tmp/llm-for-zotero-test-profile" },
      DB: {
        queryAsync: async (sql: string) =>
          sql.includes("SELECT 1") && sql.includes("conversation_cleanup_jobs")
            ? [{ exists: 1 }]
            : [],
      },
    };

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      capturedBody = JSON.parse(String(init?.body || "{}"));
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              '{"type":"outcome","outcome":{"kind":"completed","runId":"r2","text":"ok","usedFallback":false}}\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200 }) as Response;
    }) as typeof fetch;

    try {
      const runtime = createRuntime();
      await runtime.runTurn({
        request: {
          conversationKey: 100,
          mode: "agent",
          userText: "hello",
          model: "claude-sonnet",
          authMode: "api_key",
          apiBase: "",
          apiKey: "",
          libraryID: 1,
        },
      });

      assert.equal(capturedBody?.metadata?.forceFreshSession, true);
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
    }
  });

  it("shows native confirmation even when cached tool metadata is absent", async function () {
    const originalFetch = globalThis.fetch;
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    const progressEvents: Array<{ type: string; requestId?: string }> = [];

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Prefs: {
        get(key: string) {
          if (key.endsWith("enableClaudeCodeMode")) return true;
          if (key.endsWith("agentClaudeConfigSource")) return "default";
          if (key.endsWith("claudeCodePermissionMode")) return "default";
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
      const runtime = createRuntime();

      await runtime.runExternalAction(
        "cc_tool::Read",
        { file_path: "README.md" },
        {
          confirmationMode: "native_ui",
          onProgress: (event) => progressEvents.push(event as any),
          requestConfirmation: async () => ({ approved: false }),
        },
      );

      assert.isTrue(
        progressEvents.some((event) => event.type === "confirmation_required"),
      );
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
    }
  });

  it("sends Claude dangerous skip acknowledgement only for bypassPermissions", async function () {
    const originalFetch = globalThis.fetch;
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    let capturedBody: Record<string, any> | null = null;

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Prefs: {
        get(key: string) {
          if (key.endsWith("enableClaudeCodeMode")) return true;
          if (key.endsWith("agentClaudeConfigSource")) return "default";
          if (key.endsWith("claudeCodePermissionMode")) {
            return "bypassPermissions";
          }
          if (key.endsWith("conversationSystem")) return "claude_code";
          return "";
        },
      },
      Profile: {
        dir: "/tmp/llm-for-zotero-test-profile",
      },
    };

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      capturedBody = JSON.parse(String(init?.body || "{}"));
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              '{"type":"outcome","outcome":{"kind":"completed","runId":"r1","text":"ok","usedFallback":false}}\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200 }) as Response;
    }) as typeof fetch;

    try {
      const runtime = createRuntime();

      await runtime.runExternalAction("cc_tool::Write", {
        file_path: "note.md",
      });

      assert.equal(capturedBody?.metadata?.permissionMode, "bypassPermissions");
      assert.equal(
        capturedBody?.metadata?.allowDangerouslySkipPermissions,
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
    }
  });

  it("passes notes-directory guidance to Claude bridge turns", async function () {
    const originalFetch = globalThis.fetch;
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    let capturedBody: Record<string, any> | null = null;
    const prefStore = new Map<string, unknown>();

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Prefs: {
        get(key: string) {
          if (key === "httpServer.port") return 24680;
          if (prefStore.has(key)) return prefStore.get(key);
          if (key.endsWith("enableClaudeCodeMode")) return true;
          if (key.endsWith("agentClaudeConfigSource")) return "default";
          if (key.endsWith("claudeCodePermissionMode")) return "default";
          if (key.endsWith("conversationSystem")) return "claude_code";
          if (key.endsWith("codexAppServerZoteroMcpToolsEnabled")) return true;
          if (key.endsWith("obsidianVaultPath")) return "/tmp/obsidian-vault";
          if (key.endsWith("obsidianTargetFolder")) return "Zotero Notes";
          if (key.endsWith("obsidianAttachmentsFolder"))
            return "Zotero Notes/imgs";
          if (key.endsWith("notesDirectoryNickname")) return "Obsidian";
          return "";
        },
        set(key: string, value: unknown) {
          prefStore.set(key, value);
        },
      },
      Profile: {
        dir: "/tmp/llm-for-zotero-test-profile",
      },
      Items: {
        get: () => null,
      },
      DB: {
        queryAsync: async () => [],
      },
    };

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("/llm-for-zotero/mcp")) {
        const payload = JSON.parse(String(init?.body || "{}")) as {
          id?: string | number;
          method?: string;
        };
        if (payload.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id,
              result: { protocolVersion: "2025-06-18", capabilities: {} },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ) as Response;
        }
        if (payload.method === "notifications/initialized") {
          return new Response("", { status: 202 }) as Response;
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
                  { name: "file_io" },
                  { name: "run_command" },
                ],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ) as Response;
        }
        return new Response("unexpected MCP request", {
          status: 500,
        }) as Response;
      }
      capturedBody = JSON.parse(String(init?.body || "{}"));
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              '{"type":"start","runId":"r1"}\n' +
                '{"type":"outcome","outcome":{"kind":"completed","runId":"r1","text":"ok","usedFallback":false}}\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200 }) as Response;
    }) as typeof fetch;

    try {
      const runtime = createRuntime();
      const selectedPaper = {
        itemId: 11,
        contextItemId: 12,
        title: "Selected Bridge Paper",
        attachmentTitle: "Selected Bridge PDF",
        citationKey: "ngSelected2026",
        firstCreator: "Ng",
        year: "2026",
        contentSourceMode: "mineru" as const,
        mineruCacheDir: "/tmp/mineru-cache/selected-bridge",
      };
      const fullTextPaper = {
        itemId: 21,
        contextItemId: 22,
        title: "Full Text Bridge Paper",
        attachmentTitle: "Full Text Bridge PDF",
        firstCreator: "Lee",
        year: "2025",
        contentSourceMode: "markdown" as const,
        mineruCacheDir: "/tmp/mineru-cache/full-text-bridge",
      };
      const pinnedPaper = {
        itemId: 31,
        contextItemId: 32,
        title: "Pinned Bridge Paper",
        attachmentTitle: "Pinned Bridge PDF",
        firstCreator: "Chen",
        year: "2024",
        contentSourceMode: "text" as const,
        mineruCacheDir: "/tmp/mineru-cache/pinned-bridge",
      };

      await runtime.runTurn({
        request: {
          conversationKey: 77,
          mode: "agent",
          userText: "write this to my Obsidian",
          model: "claude-sonnet",
          authMode: "api_key",
          apiBase: "",
          apiKey: "",
          libraryID: 1,
          selectedPaperContexts: [selectedPaper],
          fullTextPaperContexts: [fullTextPaper],
          pinnedPaperContexts: [pinnedPaper],
          selectedTagContexts: [
            { name: "Drift", normalizedName: "drift", libraryID: 1 },
          ],
        },
      });

      const customInstruction = String(
        capturedBody?.metadata?.customInstruction || "",
      );
      assert.include(
        customInstruction,
        "Default target path: /tmp/obsidian-vault/Zotero Notes",
      );
      assert.include(
        customInstruction,
        "Default target path is the default destination, not a constraint",
      );
      assert.include(
        customInstruction,
        "do not append Default folder to Default target path again",
      );
      assert.include(
        customInstruction,
        "Do not use Bash, Glob, Find, LS, or Read to rediscover the vault path",
      );
      assert.include(
        customInstruction,
        "Do not create a Papers, papers, Notes, or other alternate subfolder",
      );
      // A Markdown note written with Claude Code's own Write tool bypasses the
      // shared finalized-document exporter and its file receipts.
      assert.notInclude(
        customInstruction,
        "If using Claude Code's Write tool for a Markdown note",
      );
      assert.include(
        customInstruction,
        "use the Zotero note_write tool, not Claude Code's Write tool",
      );
      assert.include(customInstruction, "Zotero MCP file_io tool");
      assert.include(customInstruction, "without native shell or Write access");
      assert.include(customInstruction, "Original agent-mode Zotero behavior");
      assert.include(customInstruction, "(creator, year)");
      assert.include(
        customInstruction,
        "Keep exact Zotero keys and numeric IDs in structured target fields/internal records",
      );
      assert.include(
        customInstruction,
        "a prose plan or unwritten note body is not completion",
      );
      assert.include(customInstruction, "library_retrieve");
      assert.include(customInstruction, "zotero_script");
      assert.include(customInstruction, '"this folder"');
      assert.include(customInstruction, "selected Zotero scopes");
      assert.equal(
        customInstruction.split(PAPER_CITATION_CONTRACT).length - 1,
        1,
      );
      for (const contract of [
        CORE_RESEARCH_CONTRACT,
        AGENT_ACTION_CONTRACT,
        RUNTIME_CAPABILITY_CONTEXT,
      ]) {
        assert.include(customInstruction, contract);
      }
      // Search routing reaches the bridge once; the plugin-only selection
      // card rule does not (the bridge has no literature_review card).
      assert.equal(
        customInstruction.split(SEARCH_ROUTING_CONTRACT).length - 1,
        1,
      );
      assert.notInclude(customInstruction, AGENT_SEARCH_TOOL_ROUTES);
      // Its own search-tool line maps the web family to WebSearch/WebFetch.
      assert.equal(
        customInstruction.split(CLAUDE_BRIDGE_SEARCH_TOOL_ROUTES).length - 1,
        1,
      );
      const mcpServers = capturedBody?.mcpServers as
        | Record<
            string,
            { type?: string; url?: string; headers?: Record<string, string> }
          >
        | undefined;
      assert.isObject(mcpServers);
      const [serverName] = Object.keys(mcpServers || {});
      assert.match(serverName, /^llm_for_zotero_profile_/);
      assert.include(
        capturedBody?.allowedTools,
        `mcp__${serverName}__library_retrieve`,
      );
      assert.notInclude(
        capturedBody?.allowedTools,
        `mcp__${serverName}__zotero_script`,
      );
      assert.notInclude(
        capturedBody?.allowedTools,
        `mcp__${serverName}__file_io`,
      );
      assert.notInclude(
        capturedBody?.allowedTools,
        `mcp__${serverName}__run_command`,
      );
      // The paper-reader subagent gets only the four Zotero read tools.
      assert.sameMembers(
        capturedBody?.metadata?.paperReaderTools as string[],
        [
          "library_search",
          "library_read",
          "library_retrieve",
          "paper_read",
        ].map((name) => `mcp__${serverName}__${name}`),
      );
      assert.equal(mcpServers?.[serverName].type, "http");
      assert.equal(
        mcpServers?.[serverName].url,
        "http://127.0.0.1:24680/llm-for-zotero/mcp",
      );
      assert.match(
        String(mcpServers?.[serverName].headers?.Authorization || ""),
        /^Bearer /,
      );
      assert.isString(
        mcpServers?.[serverName].headers?.["X-LLM-For-Zotero-Scope"],
      );
      assert.deepInclude(
        capturedBody?.runtimeRequest?.selectedPaperContexts?.[0],
        {
          ...selectedPaper,
          mineruFullMdPath: "/tmp/mineru-cache/selected-bridge/full.md",
        },
      );
      assert.deepInclude(
        capturedBody?.runtimeRequest?.fullTextPaperContexts?.[0],
        {
          ...fullTextPaper,
          mineruFullMdPath: "/tmp/mineru-cache/full-text-bridge/full.md",
        },
      );
      assert.deepInclude(
        capturedBody?.runtimeRequest?.pinnedPaperContexts?.[0],
        {
          ...pinnedPaper,
          mineruFullMdPath: "/tmp/mineru-cache/pinned-bridge/full.md",
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
    }
  });

  it("routes notes to note_write even when no notes directory is configured", async function () {
    // The note_write routing is a property of Zotero, not of whether this user
    // has a vault: gating it on the notes-directory block would leave a user
    // without one with no instruction about where notes belong at all.
    const originalFetch = globalThis.fetch;
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    let capturedBody: Record<string, any> | null = null;

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Prefs: {
        get(key: string) {
          if (key.endsWith("enableClaudeCodeMode")) return true;
          if (key.endsWith("agentClaudeConfigSource")) return "default";
          if (key.endsWith("claudeCodePermissionMode")) return "default";
          if (key.endsWith("conversationSystem")) return "claude_code";
          if (key.endsWith("codexAppServerZoteroMcpToolsEnabled")) return false;
          return "";
        },
        set() {},
      },
      Profile: { dir: "/tmp/llm-for-zotero-test-profile" },
      Items: { get: () => null },
      DB: { queryAsync: async () => [] },
    };

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      capturedBody = JSON.parse(String(init?.body || "{}"));
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              '{"type":"outcome","outcome":{"kind":"completed","runId":"r1","text":"ok","usedFallback":false}}\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200 }) as Response;
    }) as typeof fetch;

    try {
      const runtime = createRuntime();
      await runtime.runTurn({
        request: {
          userText: "Write a note about drift",
          conversationKey: 7_200_000_001,
          mode: "library",
          model: "claude-sonnet-4-5",
          apiKey: "",
          libraryID: 1,
        },
      });
      const customInstruction = String(
        capturedBody?.metadata?.customInstruction || "",
      );
      assert.notInclude(customInstruction, "Notes directory configuration");
      assert.include(
        customInstruction,
        "use the Zotero note_write tool, not Claude Code's Write tool",
      );
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
    }
  });

  it("omits Zotero MCP config for Claude bridge turns when native MCP tools are disabled", async function () {
    const originalFetch = globalThis.fetch;
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    let capturedBody: Record<string, any> | null = null;
    let mcpPreflightRequests = 0;

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Prefs: {
        get(key: string) {
          if (key === "httpServer.port") return 24680;
          if (key.endsWith("enableClaudeCodeMode")) return true;
          if (key.endsWith("agentClaudeConfigSource")) return "default";
          if (key.endsWith("claudeCodePermissionMode")) return "default";
          if (key.endsWith("conversationSystem")) return "claude_code";
          if (key.endsWith("codexAppServerZoteroMcpToolsEnabled")) return false;
          return "";
        },
      },
      Profile: {
        dir: "/tmp/llm-for-zotero-test-profile",
      },
      DB: {
        queryAsync: async () => [],
      },
    };

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("/llm-for-zotero/mcp")) {
        mcpPreflightRequests += 1;
        return new Response("unexpected MCP request", {
          status: 500,
        }) as Response;
      }
      capturedBody = JSON.parse(String(init?.body || "{}"));
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              '{"type":"start","runId":"r1"}\n' +
                '{"type":"outcome","outcome":{"kind":"completed","runId":"r1","text":"ok","usedFallback":false}}\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200 }) as Response;
    }) as typeof fetch;

    try {
      const runtime = createRuntime();

      await runtime.runTurn({
        request: {
          conversationKey: 88,
          mode: "agent",
          userText: "hello",
          model: "claude-sonnet",
          authMode: "api_key",
          apiBase: "",
          apiKey: "",
          libraryID: 1,
        },
      });

      assert.equal(mcpPreflightRequests, 0);
      assert.notProperty(capturedBody || {}, "mcpServers");
      assert.notProperty(capturedBody || {}, "allowedTools");
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
    }
  });

  it("keeps raw PDF paths in the model request while redacting callbacks and persisted traces", async function () {
    const originalFetch = globalThis.fetch;
    const originalZotero = (
      globalThis as typeof globalThis & { Zotero?: unknown }
    ).Zotero;
    const rawPath = "C:\\Private Papers\\Alice\\Selected File.pdf";
    const jsonEscapedPath = JSON.stringify(rawPath).slice(1, -1);
    const forwardCaseVariant = "c:/private papers/ALICE/selected file.pdf";
    const fileUrlVariant =
      "FILE:///c:/private%20papers/alice/selected%20file.pdf";
    const parentPath = "C:\\Private Papers\\Alice";
    const parentFileUrlVariant = "file:///c:/private%20papers/alice";
    const unrelatedPath = "/private/other/reference.pdf";
    const dbWrites: Array<{ sql: string; params: unknown[] }> = [];
    const callbackEvents: unknown[] = [];
    let capturedBody: Record<string, any> | null = null;

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Prefs: {
        get(key: string) {
          if (key.endsWith("enableClaudeCodeMode")) return true;
          if (key.endsWith("agentClaudeConfigSource")) return "default";
          if (key.endsWith("claudeCodePermissionMode")) return "default";
          if (key.endsWith("conversationSystem")) return "claude_code";
          if (key.endsWith("codexAppServerZoteroMcpToolsEnabled")) return false;
          if (key.endsWith("agentTraceExportEnabled")) return false;
          return "";
        },
      },
      Profile: {
        dir: "/tmp/llm-for-zotero-test-profile",
      },
      DB: {
        queryAsync: async (sql: string, params: unknown[] = []) => {
          dbWrites.push({ sql, params });
          return [];
        },
      },
    };

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith("/healthz")) {
        return new Response(
          JSON.stringify({
            ok: true,
            protocolVersion: 2,
            capabilities: ["local_pdf_paths"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ) as Response;
      }
      capturedBody = JSON.parse(String(init?.body || "{}"));
      const eventText = [
        `raw=${rawPath}`,
        `escaped=${jsonEscapedPath}`,
        `forward=${forwardCaseVariant}`,
        `fileUrl=${fileUrlVariant}`,
        `parent=${parentPath}`,
        `parentUrl=${parentFileUrlVariant}`,
        `unrelated=${unrelatedPath}`,
      ].join(" ");
      const rawSplit = Math.floor(rawPath.length / 2);
      const urlSplit = Math.floor(fileUrlVariant.length / 2);
      const lines = [
        { type: "start", runId: "run-redaction-seam" },
        { type: "event", event: { type: "status", text: eventText } },
        {
          type: "event",
          event: {
            type: "message_delta",
            text: rawPath.slice(0, rawSplit),
          },
        },
        {
          type: "event",
          event: {
            type: "message_delta",
            text: rawPath.slice(rawSplit),
          },
        },
        {
          type: "event",
          event: {
            type: "message_delta",
            text: " complete",
          },
        },
        {
          type: "event",
          event: {
            type: "reasoning",
            round: 1,
            stepId: "split-path-reasoning",
            summary: fileUrlVariant.slice(0, urlSplit),
          },
        },
        {
          type: "event",
          event: {
            type: "reasoning",
            round: 1,
            stepId: "split-path-reasoning",
            summary: fileUrlVariant.slice(urlSplit),
          },
        },
        {
          type: "outcome",
          outcome: {
            kind: "completed",
            runId: "run-redaction-seam",
            text: eventText,
            usedFallback: false,
          },
        },
      ];
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200 }) as Response;
    }) as typeof fetch;

    try {
      const runtime = createRuntime();
      const outcome = await runtime.runTurn({
        request: {
          conversationKey: 8901,
          mode: "agent",
          userText: "Read the selected PDF.",
          model: "claude-sonnet",
          authMode: "api_key",
          apiBase: "",
          apiKey: "",
          libraryID: 1,
          pdfPaperContexts: [
            {
              itemId: 10,
              contextItemId: 11,
              title: "Selected PDF",
              contentSourceMode: "pdf",
            },
          ],
          localDocuments: [
            {
              kind: "local_pdf",
              sourceKey: "zotero-pdf:10:11",
              itemId: 10,
              contextItemId: 11,
              title: "Selected PDF",
              name: "selected.pdf",
              mimeType: "application/pdf",
              absolutePath: rawPath,
            },
          ],
        },
        onEvent: (event) => callbackEvents.push(event),
      });

      assert.equal(
        capturedBody?.runtimeRequest?.localDocuments?.[0]?.absolutePath,
        rawPath,
      );
      const persistedAndVisible = JSON.stringify({
        callbackEvents,
        outcome,
        dbWrites,
      });
      for (const sensitiveVariant of [
        rawPath,
        jsonEscapedPath,
        forwardCaseVariant,
        fileUrlVariant,
        parentPath,
        parentFileUrlVariant,
      ]) {
        assert.notInclude(
          persistedAndVisible,
          JSON.stringify(sensitiveVariant).slice(1, -1),
        );
      }
      assert.include(persistedAndVisible, unrelatedPath);
      assert.include(persistedAndVisible, "[raw_pdf_path:zotero-pdf:10:11]");
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
    }
  });

  /**
   * What the host records when Claude Code runs one of its own tools.
   *
   * A `cc_tool::` action is Claude Code's own Write/Edit/Bash, executed inside
   * the connected runtime rather than by a registered Zotero tool. The host never
   * sees a post-state for it, so the receipt claims `execution_only` and says
   * whose runtime ran it; a denied card claims nothing at all.
   */
  describe("Claude provider action effect receipts", function () {
    const originalZotero = globalThis.Zotero;
    const originalFetch = globalThis.fetch;
    let db: ChangeJournalTestDb;

    beforeEach(async function () {
      db = new ChangeJournalTestDb();
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
        Prefs: {
          get(key: string) {
            if (key.endsWith("enableClaudeCodeMode")) return true;
            if (key.endsWith("agentClaudeConfigSource")) return "default";
            if (key.endsWith("claudeCodePermissionMode")) return "default";
            if (key.endsWith("conversationSystem")) return "claude_code";
            return "";
          },
        },
        Profile: { dir: "/tmp/llm-for-zotero-test-profile" },
        DB: db,
        debug: () => undefined,
      };
      await initAgentChangeJournal();
    });

    afterEach(function () {
      globalThis.fetch = originalFetch;
      globalThis.Zotero = originalZotero;
    });

    function respondWith(line: string): void {
      globalThis.fetch = (async () => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(line));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 }) as Response;
      }) as typeof fetch;
    }

    function observedReceipts(): any[] {
      return [...db.observations.values()]
        .filter((row) => row.event === "external_runtime_effect_observed")
        .map((row) => JSON.parse(String(row.extra_json)));
    }

    it("classifies each of Claude Code's own tools by what it changes", function () {
      const operations = Object.fromEntries(
        [
          "Write",
          "Edit",
          "MultiEdit",
          "NotebookEdit",
          "Bash",
          "Read",
          "Glob",
          "Grep",
          "WebFetch",
          "constructor",
        ].map((toolName) => [
          toolName,
          describeClaudeRuntimeToolEffect(toolName, {})?.operation ?? null,
        ]),
      );
      assert.deepEqual(operations, {
        Write: "file_write",
        Edit: "file_write",
        MultiEdit: "file_write",
        NotebookEdit: "file_write",
        Bash: "command_execute",
        Read: null,
        Glob: null,
        Grep: null,
        WebFetch: null,
        // A tool name that collides with an inherited object property must not
        // be read as an effect this table never declared.
        constructor: null,
      });
      assert.deepEqual(
        describeClaudeRuntimeToolEffect("NotebookEdit", {
          notebook_path: "/vault/analysis.ipynb",
        })?.requestedTargets,
        ["file:/vault/analysis.ipynb"],
      );
    });

    it("receipts a Claude Code file write as an execution_only effect", async function () {
      respondWith(
        '{"type":"outcome","outcome":{"kind":"completed","runId":"r1","text":"ok","usedFallback":false}}\n',
      );
      const runtime = createRuntime();
      await runtime.runExternalAction("cc_tool::Write", {
        file_path: "/vault/Zotero Notes/drift.md",
        content: "# Drift",
      });
      const [observed] = observedReceipts();
      assert.equal(observed?.source, "claude_code");
      assert.equal(observed?.receipt.operation, "file_write");
      assert.equal(observed?.receipt.proofDomain, "file_state");
      assert.equal(observed?.receipt.verification, "execution_only");
      assert.equal(observed?.receipt.status, "observed");
      assert.equal(observed?.receipt.executionAuthority, "external_runtime");
      assert.deepEqual(observed?.receipt.requestedTargets, [
        "file:/vault/Zotero Notes/drift.md",
      ]);
    });

    it("receipts a Claude Code shell command by fingerprint, not by its text", async function () {
      respondWith(
        '{"type":"outcome","outcome":{"kind":"completed","runId":"r1","text":"ok","usedFallback":false}}\n',
      );
      const runtime = createRuntime();
      await runtime.runExternalAction("cc_tool::Bash", {
        command: "pandoc note.md -o note.docx",
      });
      const [observed] = observedReceipts();
      assert.equal(observed?.receipt.operation, "command_execute");
      assert.equal(observed?.receipt.proofDomain, "execution");
      assert.equal(observed?.receipt.verification, "execution_only");
      assert.match(
        String(observed?.receipt.requestedTargets[0]),
        /^command:fnv1a32:[0-9a-f]{8}$/,
      );
      assert.notInclude(JSON.stringify(observed), "pandoc");
    });

    it("receipts a denied Claude Code effect as cancelled", async function () {
      respondWith(
        '{"type":"outcome","outcome":{"kind":"fallback","runId":"r1","reason":"approval_required","usedFallback":true}}\n',
      );
      const runtime = createRuntime();
      await runtime.runExternalAction(
        "cc_tool::Write",
        { file_path: "/vault/denied.md" },
        {
          confirmationMode: "native_ui",
          requestConfirmation: async () => ({ approved: false }),
        },
      );
      const [observed] = observedReceipts();
      assert.equal(observed?.receipt.status, "cancelled");
      assert.equal(observed?.receipt.verification, "not_applicable");
      assert.deepEqual(observed?.receipt.appliedTargets, []);
      assert.deepEqual(observed?.receipt.rejectedTargets, [
        "file:/vault/denied.md",
      ]);
    });

    it("records an action the host never dispatched as cancelled, not failed", async function () {
      respondWith(
        '{"type":"outcome","outcome":{"kind":"completed","runId":"r1","text":"ok","usedFallback":false}}\n',
      );
      const runtime = createRuntime();
      const conversationKey = 7_100_000_001;
      freezeConversationWrites(conversationKey);
      try {
        await runtime.runExternalAction(
          "cc_tool::Bash",
          { command: "echo frozen" },
          { conversationKey },
        );
      } finally {
        unfreezeConversationWrites(conversationKey);
      }
      const [observed] = observedReceipts();
      assert.equal(observed?.receipt.status, "cancelled");
      assert.equal(observed?.receipt.verification, "not_applicable");
    });

    it("records nothing for a Claude Code tool that changes no state", async function () {
      respondWith(
        '{"type":"outcome","outcome":{"kind":"completed","runId":"r1","text":"ok","usedFallback":false}}\n',
      );
      const runtime = createRuntime();
      await runtime.runExternalAction("cc_tool::Read", {
        file_path: "/vault/drift.md",
      });
      assert.deepEqual(observedReceipts(), []);
    });
  });
});

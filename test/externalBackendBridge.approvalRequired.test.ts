import { assert } from "chai";
import { describe, it } from "mocha";
import { createExternalBackendBridgeRuntime } from "../src/agent/externalBackendBridge";

describe("external bridge action approval handling", function () {
  function createRuntime() {
    return createExternalBackendBridgeRuntime({
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
  }

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

  it("sends Claude dangerous skip acknowledgement when permission mode is yolo", async function () {
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
          if (key.endsWith("agentPermissionMode")) return "yolo";
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

      assert.equal(capturedBody?.metadata?.permissionMode, "yolo");
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
          if (key.endsWith("agentPermissionMode")) return "safe";
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
        "Do not append Default folder to Default target path again",
      );
      assert.include(
        customInstruction,
        "Do not use Bash, Glob, Find, LS, or Read to rediscover the vault path",
      );
      assert.include(
        customInstruction,
        "Do not create a Papers, papers, Notes, or other alternate subfolder",
      );
      assert.include(customInstruction, "Original agent-mode Zotero behavior");
      assert.include(customInstruction, "NEVER output rewritten");
      assert.include(customInstruction, "library_retrieve");
      assert.include(customInstruction, "zotero_script");
      assert.include(customInstruction, '"this folder"');
      assert.include(customInstruction, "selected Zotero scopes");
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
      assert.include(
        capturedBody?.allowedTools,
        `mcp__${serverName}__zotero_script`,
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
          if (key.endsWith("agentPermissionMode")) return "safe";
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
});

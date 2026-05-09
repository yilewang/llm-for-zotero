import { assert } from "chai";
import {
  addZoteroMcpConfirmationHandler,
  addZoteroMcpToolActivityObserver,
  getOrCreateZoteroMcpBearerToken,
  getZoteroMcpServerUrl,
  registerScopedZoteroMcpScope,
  registerMcpServer,
  setActiveZoteroMcpScope,
  unregisterMcpServer,
  ZOTERO_MCP_ENDPOINT_PATH,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../src/agent/mcp/server";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type { AgentToolContext, AgentToolDefinition } from "../src/agent/types";

type EndpointReply = [number, string, string];

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

function createWriteTool(name: string): AgentToolDefinition<unknown, unknown> {
  return {
    spec: {
      name,
      description: `Write tool ${name}`,
      inputSchema: { type: "object", additionalProperties: true },
      mutability: "write",
      requiresConfirmation: true,
    },
    validate: (args) => ({ ok: true, value: args ?? {} }),
    execute: async () => ({ ok: true }),
  };
}

async function invokeMcpEndpoint(params: {
  body: Record<string, unknown>;
  token?: string;
  headers?: Record<string, string>;
}): Promise<EndpointReply> {
  const EndpointClass = (
    globalThis.Zotero.Server.Endpoints as Record<string, any>
  )[ZOTERO_MCP_ENDPOINT_PATH];
  assert.isFunction(EndpointClass);
  const endpoint = new EndpointClass();
  return endpoint.init({
    method: "POST",
    data: params.body,
    headers: {
      ...(params.token ? { Authorization: `Bearer ${params.token}` } : {}),
      ...(params.headers || {}),
    },
  });
}

describe("Zotero MCP server", function () {
  const originalZotero = globalThis.Zotero;
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
      Libraries: {
        userLibraryID: 1,
      },
      Items: {
        get: () => null,
      },
      Server: {
        Endpoints: {},
      },
    } as unknown as typeof Zotero;
  });

  afterEach(function () {
    unregisterMcpServer();
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("uses Zotero's configured HTTP port and rejects unauthenticated calls", async function () {
    const registry = new AgentToolRegistry();
    registry.register(createReadTool("query_library"));
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });

    assert.equal(
      getZoteroMcpServerUrl(),
      "http://127.0.0.1:24680/llm-for-zotero/mcp",
    );

    const unauthorized = await invokeMcpEndpoint({
      body: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });
    assert.equal(unauthorized[0], 401);

    const token = getOrCreateZoteroMcpBearerToken();
    const authorized = await invokeMcpEndpoint({
      token,
      body: { jsonrpc: "2.0", id: 2, method: "initialize" },
    });
    assert.equal(authorized[0], 200);
    const payload = JSON.parse(authorized[2]);
    assert.equal(payload.result.serverInfo.name, "llm-for-zotero");
    assert.equal(payload.result.protocolVersion, "2025-06-18");
  });

  it("lists curated read tools and built-in write tools without self-confirmation", async function () {
    const registry = new AgentToolRegistry();
    registry.register(createReadTool("query_library"));
    registry.register(createWriteTool("apply_tags"));
    registry.register(createWriteTool("file_io"));
    registry.register(createWriteTool("trash_items"));
    registry.register(createReadTool("not_curated_read_tool"));
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });

    const response = await invokeMcpEndpoint({
      token: getOrCreateZoteroMcpBearerToken(),
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    const payload = JSON.parse(response[2]);
    const names = payload.result.tools.map(
      (tool: { name: string }) => tool.name,
    );
    assert.deepEqual(names.sort(), [
      "apply_tags",
      "file_io",
      "query_library",
      "trash_items",
    ]);
    const queryTool = payload.result.tools.find(
      (tool: { name: string }) => tool.name === "query_library",
    );
    assert.deepEqual(queryTool.annotations, {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    });
    assert.equal(queryTool.inputSchema.properties.libraryID.type, "number");
    assert.equal(queryTool.inputSchema.properties.activeItemId.type, "number");
    assert.equal(
      queryTool.inputSchema.properties.activeContextItemId.type,
      "number",
    );
    const writeTool = payload.result.tools.find(
      (tool: { name: string }) => tool.name === "apply_tags",
    );
    assert.deepEqual(writeTool.annotations, {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    });
    assert.include(
      writeTool.description,
      "Write operations pause in Zotero for user review",
    );
    const fileIoTool = payload.result.tools.find(
      (tool: { name: string }) => tool.name === "file_io",
    );
    assert.deepEqual(fileIoTool.annotations, {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    });
    const trashTool = payload.result.tools.find(
      (tool: { name: string }) => tool.name === "trash_items",
    );
    assert.deepEqual(trashTool.annotations, {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
    });
  });

  it("accepts the MCP initialized notification without a JSON-RPC response", async function () {
    const registry = new AgentToolRegistry();
    registry.register(createReadTool("query_library"));
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });

    const response = await invokeMcpEndpoint({
      token: getOrCreateZoteroMcpBearerToken(),
      body: {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
    });

    assert.equal(response[0], 202);
    assert.equal(response[2], "");
  });

  it("executes curated read tools through the tool registry", async function () {
    const registry = new AgentToolRegistry();
    registry.register(createReadTool("query_library"));
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });

    const response = await invokeMcpEndpoint({
      token: getOrCreateZoteroMcpBearerToken(),
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "query_library",
          arguments: { entity: "items" },
        },
      },
    });
    const payload = JSON.parse(response[2]);
    const content = JSON.parse(payload.result.content[0].text);
    assert.equal(content.ok, true);
    assert.deepEqual(content.result, {
      name: "query_library",
      input: { entity: "items" },
    });
  });

  it("emits exact MCP tool activity for native Codex trace fallback", async function () {
    const registry = new AgentToolRegistry();
    registry.register(createReadTool("read_library"));
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const scoped = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-dev",
        conversationKey: 789,
        libraryID: 7,
        kind: "paper",
        activeItemId: 77,
      },
      { token: "activity-scope-token" },
    );
    const events: Array<{
      requestId: string;
      phase: "started" | "completed";
      toolName: string;
      arguments?: unknown;
      conversationKey?: number;
      libraryID?: number;
    }> = [];
    const unregister = addZoteroMcpToolActivityObserver((event) => {
      events.push(event);
    });

    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id: "tool-call-1",
          method: "tools/call",
          params: {
            name: "read_library",
            arguments: { sections: ["metadata"], libraryID: 999 },
          },
        },
      });
      assert.equal(response[0], 200);
    } finally {
      unregister();
      scoped.clear();
    }

    assert.deepEqual(
      events.map((event) => ({
        requestId: event.requestId,
        phase: event.phase,
        toolName: event.toolName,
        arguments: event.arguments,
        conversationKey: event.conversationKey,
        libraryID: event.libraryID,
      })),
      [
        {
          requestId: "jsonrpc:tool-call-1",
          phase: "started",
          toolName: "read_library",
          arguments: { sections: ["metadata"] },
          conversationKey: 789,
          libraryID: 7,
        },
        {
          requestId: "jsonrpc:tool-call-1",
          phase: "completed",
          toolName: "read_library",
          arguments: { sections: ["metadata"] },
          conversationKey: 789,
          libraryID: 7,
        },
      ],
    );
  });

  it("uses explicit MCP scope args as context defaults without passing them to validators", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "query_library",
        description: "Query library",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async (input, context: AgentToolContext) => ({
        input,
        request: {
          libraryID: context.request.libraryID,
          activeItemId: context.request.activeItemId,
        },
      }),
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });

    const response = await invokeMcpEndpoint({
      token: getOrCreateZoteroMcpBearerToken(),
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "query_library",
          arguments: {
            entity: "items",
            mode: "list",
            libraryID: 42,
            activeItemId: 99,
          },
        },
      },
    });
    const payload = JSON.parse(response[2]);
    const content = JSON.parse(payload.result.content[0].text);
    assert.equal(content.ok, true);
    assert.deepEqual(content.result.input, {
      entity: "items",
      mode: "list",
    });
    assert.deepEqual(content.result.request, {
      libraryID: 42,
      activeItemId: 99,
    });
  });

  it("defaults MCP tool context to the active Codex Zotero scope", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "read_paper",
        description: "Read paper",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async (_input, context: AgentToolContext) => ({
        request: {
          conversationKey: context.request.conversationKey,
          libraryID: context.request.libraryID,
          activeItemId: context.request.activeItemId,
          selectedPaperContexts: context.request.selectedPaperContexts,
        },
      }),
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });

    const clearScope = setActiveZoteroMcpScope({
      conversationKey: 123,
      libraryID: 7,
      kind: "paper",
      paperItemID: 55,
      activeItemId: 55,
      activeContextItemId: 66,
      paperContext: {
        itemId: 55,
        contextItemId: 66,
        title: "Scoped Paper",
        firstCreator: "Ng",
        year: "2026",
      },
    });
    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "read_paper",
            arguments: {},
          },
        },
      });
      const payload = JSON.parse(response[2]);
      const content = JSON.parse(payload.result.content[0].text);
      assert.equal(content.ok, true);
      assert.deepEqual(content.result.request, {
        conversationKey: 123,
        libraryID: 7,
        activeItemId: 55,
        selectedPaperContexts: [
          {
            itemId: 55,
            contextItemId: 66,
            title: "Scoped Paper",
            firstCreator: "Ng",
            year: "2026",
          },
        ],
      });
    } finally {
      clearScope();
    }
  });

  it("binds MCP tool context from the scoped header before the legacy active scope", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "query_library",
        description: "Query library",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async (_input, context: AgentToolContext) => ({
        request: {
          conversationKey: context.request.conversationKey,
          libraryID: context.request.libraryID,
          activeItemId: context.request.activeItemId,
        },
      }),
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });

    const clearLegacyScope = setActiveZoteroMcpScope({
      profileSignature: "profile-main",
      conversationKey: 1,
      libraryID: 999,
      kind: "global",
      activeItemId: 999,
    });
    const scoped = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-dev",
        conversationKey: 456,
        libraryID: 7,
        kind: "global",
        activeItemId: 77,
        libraryName: "Development Library",
      },
      { token: "scoped-test-token" },
    );
    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "query_library",
            arguments: { entity: "items", mode: "list" },
          },
        },
      });
      const payload = JSON.parse(response[2]);
      const content = JSON.parse(payload.result.content[0].text);
      assert.equal(content.ok, true);
      assert.deepEqual(content.result.request, {
        conversationKey: 456,
        libraryID: 7,
        activeItemId: 77,
      });
    } finally {
      scoped.clear();
      clearLegacyScope();
    }
  });

  it("routes pending MCP confirmations through the registered Zotero UI handler", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "read_attachment",
        description: "Read attachment",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "read",
        requiresConfirmation: true,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      createPendingAction: async () => ({
        toolName: "read_attachment",
        title: "Attachment",
        confirmLabel: "Send",
        cancelLabel: "Cancel",
        fields: [],
      }),
      execute: async (input) => ({ delivered: true, input }),
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const scoped = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-dev",
        conversationKey: 123,
        libraryID: 1,
        kind: "global",
      },
      { token: "confirm-scope-token" },
    );
    const requests: Array<{ requestId: string; toolName: string }> = [];
    const clearHandler = addZoteroMcpConfirmationHandler(
      {
        profileSignature: "profile-dev",
        conversationKey: 123,
      },
      async (request) => {
        requests.push({
          requestId: request.requestId,
          toolName: request.toolName,
        });
        return { approved: true };
      },
    );

    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "read_attachment",
            arguments: { attachFile: true },
          },
        },
      });
      const payload = JSON.parse(response[2]);
      const content = JSON.parse(payload.result.content[0].text);
      assert.equal(content.ok, true);
      assert.deepEqual(content.result, {
        delivered: true,
        input: { attachFile: true },
      });
      assert.deepEqual(
        requests.map((entry) => entry.toolName),
        ["read_attachment"],
      );
    } finally {
      clearHandler();
      scoped.clear();
    }
  });

  it("forces write tools through Zotero UI approval and does not execute denied writes", async function () {
    let executeCount = 0;
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "apply_tags",
        description: "Apply tags",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      createPendingAction: async () => ({
        toolName: "apply_tags",
        title: "Apply Tags",
        confirmLabel: "Apply",
        cancelLabel: "Cancel",
        fields: [],
      }),
      execute: async () => {
        executeCount += 1;
        return { applied: true };
      },
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const scoped = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-dev",
        conversationKey: 456,
        libraryID: 1,
        kind: "global",
      },
      { token: "deny-scope-token" },
    );
    const clearHandler = addZoteroMcpConfirmationHandler(
      {
        profileSignature: "profile-dev",
        conversationKey: 456,
      },
      async () => ({ approved: false }),
    );

    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "apply_tags",
            arguments: { itemIds: [1], tags: ["memory"] },
          },
        },
      });
      const payload = JSON.parse(response[2]);
      const content = JSON.parse(payload.result.content[0].text);
      assert.equal(payload.result.isError, true);
      assert.equal(content.ok, false);
      assert.equal(content.result.error, "User denied action");
      assert.equal(executeCount, 0);
    } finally {
      clearHandler();
      scoped.clear();
    }
  });

  it("lets run_command and file_io use their own confirmation policy in native MCP mode", async function () {
    const executed: string[] = [];
    const registry = new AgentToolRegistry();
    for (const name of ["run_command", "file_io"]) {
      registry.register({
        spec: {
          name,
          description: `Policy-controlled tool ${name}`,
          inputSchema: { type: "object", additionalProperties: true },
          mutability: "write",
          requiresConfirmation: true,
        },
        validate: (args) => ({ ok: true, value: args ?? {} }),
        shouldRequireConfirmation: async () => false,
        createPendingAction: async () => ({
          toolName: name,
          title: `Confirm ${name}`,
          confirmLabel: "Confirm",
          cancelLabel: "Cancel",
          fields: [],
        }),
        execute: async () => {
          executed.push(name);
          return { direct: true, name };
        },
      });
    }
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const scoped = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-dev",
        conversationKey: 457,
        libraryID: 1,
        kind: "global",
      },
      { token: "policy-scope-token" },
    );

    try {
      for (const name of ["run_command", "file_io"]) {
        const response = await invokeMcpEndpoint({
          token: getOrCreateZoteroMcpBearerToken(),
          headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
          body: {
            jsonrpc: "2.0",
            id: name,
            method: "tools/call",
            params: {
              name,
              arguments:
                name === "run_command"
                  ? { command: 'rg "notes" src' }
                  : { action: "read", filePath: "/tmp/source.md" },
            },
          },
        });
        const payload = JSON.parse(response[2]);
        const content = JSON.parse(payload.result.content[0].text);
        assert.isUndefined(payload.result.isError);
        assert.equal(content.ok, true);
        assert.deepEqual(content.result, { direct: true, name });
      }
      assert.deepEqual(executed, ["run_command", "file_io"]);
    } finally {
      scoped.clear();
    }
  });

  it("creates standalone notes through the edit_current_note review card path", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "edit_current_note",
        description: "Edit or create notes",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      createPendingAction: async (input) => {
        const record = input as Record<string, unknown>;
        return {
          toolName: "edit_current_note",
          mode: "review",
          title: "Review new note",
          description:
            "Review the note content before creating a standalone note.",
          confirmLabel: "Create note",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "textarea",
              id: "content",
              label: "Final note content",
              value: String(record.content || ""),
            },
          ],
        };
      },
      execute: async (input) => ({
        status: "created",
        noteId: 99,
        target: (input as { target?: unknown }).target,
        noteContent: (input as { content?: unknown }).content,
      }),
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const scoped = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-dev",
        conversationKey: 789,
        libraryID: 1,
        kind: "global",
      },
      { token: "note-scope-token" },
    );
    const clearHandler = addZoteroMcpConfirmationHandler(
      {
        profileSignature: "profile-dev",
        conversationKey: 789,
      },
      async (request) => {
        assert.equal(request.action.title, "Review new note");
        return {
          approved: true,
          data: {
            content: "Approved standalone note",
          },
        };
      },
    );

    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "edit_current_note",
            arguments: {
              mode: "create",
              target: "standalone",
              content: "Draft standalone note",
            },
          },
        },
      });
      const payload = JSON.parse(response[2]);
      const content = JSON.parse(payload.result.content[0].text);
      assert.equal(content.ok, true);
      assert.deepEqual(content.result, {
        status: "created",
        noteId: 99,
        target: "standalone",
        noteContent: "Draft standalone note",
      });
    } finally {
      clearHandler();
      scoped.clear();
    }
  });

  it("binds scoped active notes to edit_current_note diff review cards", async function () {
    const noteItem = {
      id: 501,
      key: "NOTE501",
      libraryID: 1,
      parentID: undefined,
      isNote: () => true,
      getNote: () => "<p>Original active note</p>",
      getDisplayTitle: () => "Active Note",
    };
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      ...globalThis.Zotero,
      Items: {
        get: (id: number) => (id === 501 ? noteItem : null),
      },
    } as unknown as typeof Zotero;
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "edit_current_note",
        description: "Edit active note",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      createPendingAction: async (_input, context) => {
        assert.equal(context.request.activeNoteContext?.noteId, 501);
        assert.equal(
          context.request.activeNoteContext?.noteText,
          "Original active note",
        );
        return {
          toolName: "edit_current_note",
          mode: "review",
          title: "Review note update",
          description: "Review the active note edit.",
          confirmLabel: "Apply edit",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "diff_preview" as const,
              id: "noteDiff",
              label: "Note changes",
              before: context.request.activeNoteContext?.noteText || "",
              after: "Updated active note",
            },
          ],
        };
      },
      execute: async (_input, context) => ({
        status: "updated",
        noteId: context.request.activeNoteContext?.noteId,
      }),
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const scoped = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-note",
        conversationKey: 5010,
        libraryID: 1,
        kind: "global",
        activeNoteId: 501,
        activeNoteKind: "standalone",
        activeNoteTitle: "Active Note",
      },
      { token: "active-note-scope-token" },
    );
    const clearHandler = addZoteroMcpConfirmationHandler(
      {
        profileSignature: "profile-note",
        conversationKey: 5010,
      },
      async (request) => {
        assert.equal(request.action.title, "Review note update");
        const diffField = request.action.fields[0] as {
          type?: string;
          before?: string;
          after?: string;
        };
        assert.equal(diffField.type, "diff_preview");
        assert.equal(diffField.before, "Original active note");
        assert.equal(diffField.after, "Updated active note");
        return { approved: true };
      },
    );

    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "edit_current_note",
            arguments: {
              mode: "edit",
              content: "Updated active note",
            },
          },
        },
      });
      const payload = JSON.parse(response[2]);
      const content = JSON.parse(payload.result.content[0].text);
      assert.equal(content.ok, true);
      assert.deepEqual(content.result, {
        status: "updated",
        noteId: 501,
      });
    } finally {
      clearHandler();
      scoped.clear();
    }
  });

  it("falls back to the active turn scope for stale cached MCP write headers", async function () {
    let pendingConversationKey: number | undefined;
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "apply_tags",
        description: "Apply tags",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      createPendingAction: async (_input, context: AgentToolContext) => {
        pendingConversationKey = context.request.conversationKey;
        return {
          toolName: "apply_tags",
          title: "Apply Tags",
          confirmLabel: "Apply",
          cancelLabel: "Cancel",
          fields: [],
        };
      },
      execute: async (_input, context: AgentToolContext) => ({
        request: {
          conversationKey: context.request.conversationKey,
          libraryID: context.request.libraryID,
          activeItemId: context.request.activeItemId,
        },
      }),
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const staleScoped = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-stale",
        conversationKey: 100,
        libraryID: 1,
        kind: "global",
        activeItemId: 10,
      },
      { token: "stale-cached-scope-token" },
    );
    staleScoped.clear();
    const clearActiveScope = setActiveZoteroMcpScope({
      profileSignature: "profile-stale",
      conversationKey: 200,
      libraryID: 2,
      kind: "global",
      activeItemId: 20,
    });
    const clearHandler = addZoteroMcpConfirmationHandler(
      {
        profileSignature: "profile-stale",
        conversationKey: 200,
      },
      async (request) => {
        assert.equal(request.action.title, "Apply Tags");
        return { approved: true };
      },
    );

    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: staleScoped.token },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "apply_tags",
            arguments: { itemIds: [1], tags: ["memory"] },
          },
        },
      });
      const payload = JSON.parse(response[2]);
      const content = JSON.parse(payload.result.content[0].text);
      assert.equal(content.ok, true);
      assert.equal(pendingConversationKey, 200);
      assert.deepEqual(content.result.request, {
        conversationKey: 200,
        libraryID: 2,
        activeItemId: 20,
      });
    } finally {
      clearHandler();
      clearActiveScope();
    }
  });

  it("runs zotero_script through MCP without forcing a confirmation", async function () {
    let executed = false;
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "zotero_script",
        description: "Run Zotero script",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      createPendingAction: async () => {
        throw new Error("zotero_script should not request confirmation");
      },
      execute: async () => {
        executed = true;
        return { status: "ran" };
      },
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const scoped = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-script",
        conversationKey: 5020,
        libraryID: 1,
        kind: "global",
      },
      { token: "script-scope-token" },
    );

    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "zotero_script",
            arguments: {
              mode: "write",
              description: "Run directly",
              script: "env.addUndoStep(async () => {});",
            },
          },
        },
      });
      const payload = JSON.parse(response[2]);
      const content = JSON.parse(payload.result.content[0].text);
      assert.equal(content.ok, true);
      assert.deepEqual(content.result, { status: "ran" });
      assert.isTrue(executed);
    } finally {
      scoped.clear();
    }
  });
});

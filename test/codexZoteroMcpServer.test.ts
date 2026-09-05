import { assert } from "chai";
import {
  addZoteroMcpConfirmationHandler,
  addZoteroMcpToolActivityObserver,
  getOrCreateZoteroMcpBearerToken,
  getZoteroMcpServerUrl,
  registerScopedZoteroMcpScope,
  registerMcpServer,
  releaseConversationScopeToken,
  resolveConversationScopeToken,
  setActiveZoteroMcpScope,
  unregisterMcpServer,
  ZOTERO_MCP_ENDPOINT_PATH,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../src/agent/mcp/server";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import type { AgentToolContext, AgentToolDefinition } from "../src/agent/types";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

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
    execute: async () => ({ content: { ok: true }, effect: "applied" }),
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

  beforeEach(async function () {
    prefStore.clear();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      DB: new ChangeJournalTestDb(),
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
    await initAgentChangeJournal();
  });

  afterEach(function () {
    unregisterMcpServer();
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("uses Zotero's configured HTTP port and rejects unauthenticated calls", async function () {
    const registry = new AgentToolRegistry();
    registry.register(createReadTool("library_search"));
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
    registry.register(createReadTool("library_search"));
    registry.register(createWriteTool("library_update"));
    registry.register(createWriteTool("file_io"));
    registry.register(createWriteTool("library_delete"));
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
      "file_io",
      "library_delete",
      "library_search",
      "library_update",
    ]);
    const queryTool = payload.result.tools.find(
      (tool: { name: string }) => tool.name === "library_search",
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
      (tool: { name: string }) => tool.name === "library_update",
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
      (tool: { name: string }) => tool.name === "library_delete",
    );
    assert.deepEqual(trashTool.annotations, {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
    });
  });

  it("keeps Codex direct-path PDF turns on the metadata/write MCP surface", async function () {
    let executionCount = 0;
    const registry = new AgentToolRegistry();
    for (const tool of [
      createReadTool("library_search"),
      createReadTool("literature_search"),
      createWriteTool("note_write"),
      createWriteTool("library_update"),
      createReadTool("library_read"),
      createReadTool("library_retrieve"),
      createReadTool("paper_read"),
      createWriteTool("run_command"),
      createWriteTool("file_io"),
      createWriteTool("zotero_script"),
    ]) {
      tool.execute = async () => {
        executionCount += 1;
        return { ok: true };
      };
      registry.register(tool);
    }
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const scoped = registerScopedZoteroMcpScope({
      conversationKey: 7_940_001,
      libraryID: 1,
      kind: "paper",
      pdfPaperContexts: [
        {
          itemId: 42,
          contextItemId: 99,
          title: "Raw PDF",
          contentSourceMode: "pdf",
        },
      ],
    });
    const token = getOrCreateZoteroMcpBearerToken();
    const headers = { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token };

    try {
      const listed = await invokeMcpEndpoint({
        token,
        headers,
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      const listPayload = JSON.parse(listed[2]);
      assert.deepEqual(
        listPayload.result.tools.map((tool: { name: string }) => tool.name),
        [
          "library_search",
          "note_write",
          "library_update",
          "library_read",
          "library_retrieve",
          "paper_read",
        ],
      );

      for (const [index, name] of ["library_search"].entries()) {
        const response = await invokeMcpEndpoint({
          token,
          headers,
          body: {
            jsonrpc: "2.0",
            id: index + 2,
            method: "tools/call",
            params: { name, arguments: {} },
          },
        });
        const payload = JSON.parse(response[2]);
        assert.isNotTrue(payload.result.isError, name);
      }
      assert.equal(executionCount, 1);

      const externalRetrieval = await invokeMcpEndpoint({
        token,
        headers,
        body: {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "literature_search", arguments: {} },
        },
      });
      const externalRetrievalPayload = JSON.parse(externalRetrieval[2]);
      assert.equal(externalRetrievalPayload.result.isError, true);
      assert.include(
        externalRetrievalPayload.result.content[0].text,
        "unavailable for direct-path PDF identities",
      );
      assert.equal(executionCount, 1);

      const rawReader = await invokeMcpEndpoint({
        token,
        headers,
        body: {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "raw_pdf_read", arguments: {} },
        },
      });
      const rawReaderPayload = JSON.parse(rawReader[2]);
      assert.equal(rawReaderPayload.result.isError, true);
      assert.include(
        rawReaderPayload.result.content[0].text,
        "not available in Codex native mode",
      );

      for (const method of ["resources/list", "resources/templates/list"]) {
        const response = await invokeMcpEndpoint({
          token,
          headers,
          body: { jsonrpc: "2.0", id: method, method },
        });
        const payload = JSON.parse(response[2]);
        assert.equal(payload.error.code, -32601);
        assert.notProperty(payload, "result");
      }
    } finally {
      scoped.clear();
    }
  });

  it("accepts the MCP initialized notification without a JSON-RPC response", async function () {
    const registry = new AgentToolRegistry();
    registry.register(createReadTool("library_search"));
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
    registry.register(createReadTool("library_search"));
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
          name: "library_search",
          arguments: { entity: "items" },
        },
      },
    });
    const payload = JSON.parse(response[2]);
    const content = JSON.parse(payload.result.content[0].text);
    assert.equal(content.ok, true);
    assert.deepEqual(content.result, {
      name: "library_search",
      input: { entity: "items" },
    });
  });

  it("blocks exact, implicit, and same-parent sibling reads for a raw PDF", async function () {
    let executionCount = 0;
    const registry = new AgentToolRegistry();
    const paperRead = createReadTool("paper_read");
    paperRead.execute = async (input) => {
      executionCount += 1;
      return { input };
    };
    registry.register(paperRead);
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const scoped = registerScopedZoteroMcpScope({
      profileSignature: "profile-dev",
      conversationKey: 789,
      libraryID: 7,
      kind: "paper",
      activeItemId: 42,
      activeContextItemId: 99,
      pdfPaperContexts: [
        {
          itemId: 42,
          contextItemId: 99,
          title: "Raw PDF",
          contentSourceMode: "pdf",
        },
      ],
    });
    globalThis.Zotero.Items.get = (itemId: number) => ({
      isAttachment: () => itemId === 99 || itemId === 100 || itemId === 101,
      parentID:
        itemId === 99 || itemId === 100 ? 42 : itemId === 101 ? 43 : undefined,
    });

    try {
      const blocked = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "paper_read",
            arguments: {
              target: { paperContext: { itemId: 42, contextItemId: 99 } },
            },
          },
        },
      });
      const blockedPayload = JSON.parse(blocked[2]);
      const blockedContent = JSON.parse(blockedPayload.result.content[0].text);
      assert.equal(blockedPayload.result.isError, true);
      assert.include(blockedContent.error, "raw PDF mode");
      assert.equal(executionCount, 0);

      const implicitBlocked = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "paper_read", arguments: {} },
        },
      });
      const implicitBlockedPayload = JSON.parse(implicitBlocked[2]);
      assert.equal(implicitBlockedPayload.result.isError, true);
      assert.equal(executionCount, 0);

      const siblingBlocked = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "paper_read",
            arguments: {
              target: { paperContext: { itemId: 42, contextItemId: 100 } },
            },
          },
        },
      });
      const siblingBlockedPayload = JSON.parse(siblingBlocked[2]);
      assert.equal(siblingBlockedPayload.result.isError, true);
      assert.equal(executionCount, 0);

      for (const [id, itemId] of [
        [4, 99],
        [5, 100],
      ] as const) {
        const aliasBlocked = await invokeMcpEndpoint({
          token: getOrCreateZoteroMcpBearerToken(),
          headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
          body: {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: {
              name: "paper_read",
              arguments: { target: { itemId } },
            },
          },
        });
        assert.equal(JSON.parse(aliasBlocked[2]).result.isError, true);
      }
      assert.equal(executionCount, 0);

      const otherParent = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: {
            name: "paper_read",
            arguments: {
              target: { paperContext: { itemId: 43, contextItemId: 101 } },
            },
          },
        },
      });
      const otherParentPayload = JSON.parse(otherParent[2]);
      assert.equal(otherParentPayload.result.isError, true);
      assert.equal(executionCount, 0);
    } finally {
      scoped.clear();
    }
  });

  it("keeps exact Text retrieval available in a mixed direct-PDF scope", async function () {
    let executedInput: unknown;
    const registry = new AgentToolRegistry();
    const paperRead = createReadTool("paper_read");
    paperRead.execute = async (input) => {
      executedInput = input;
      return { input };
    };
    registry.register(paperRead);
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const scoped = registerScopedZoteroMcpScope({
      conversationKey: 790,
      libraryID: 7,
      kind: "paper",
      pdfPaperContexts: [
        {
          itemId: 42,
          contextItemId: 99,
          title: "PDF_A_SENTINEL",
          contentSourceMode: "pdf",
        },
      ],
      selectedPaperContexts: [
        {
          itemId: 42,
          contextItemId: 100,
          title: "PDF_B_SENTINEL",
          contentSourceMode: "text",
        },
      ],
    });
    globalThis.Zotero.Items.get = (itemId: number) => ({
      isAttachment: () => itemId === 99 || itemId === 100,
      parentID: itemId === 99 || itemId === 100 ? 42 : undefined,
    });

    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "paper_read",
            arguments: {
              target: { paperContext: { itemId: 42, contextItemId: 100 } },
            },
          },
        },
      });
      const payload = JSON.parse(response[2]);
      assert.isNotTrue(payload.result.isError);
      assert.deepEqual(executedInput, {
        target: { paperContext: { itemId: 42, contextItemId: 100 } },
      });

      const rawResponse = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: {
            name: "paper_read",
            arguments: {
              target: { paperContext: { itemId: 42, contextItemId: 99 } },
            },
          },
        },
      });
      assert.equal(JSON.parse(rawResponse[2]).result.isError, true);
      assert.deepEqual(executedInput, {
        target: { paperContext: { itemId: 42, contextItemId: 100 } },
      });
    } finally {
      scoped.clear();
    }
  });

  it("fails closed for global library retrieval and recognizes scope.itemIds", async function () {
    let executionCount = 0;
    const registry = new AgentToolRegistry();
    const libraryRetrieve = createReadTool("library_retrieve");
    libraryRetrieve.execute = async (input) => {
      executionCount += 1;
      return { input };
    };
    registry.register(libraryRetrieve);
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const scoped = registerScopedZoteroMcpScope({
      conversationKey: 791,
      libraryID: 7,
      kind: "global",
      pdfPaperContexts: [
        {
          itemId: 42,
          contextItemId: 99,
          title: "PDF_A_SENTINEL",
          contentSourceMode: "pdf",
        },
      ],
    });
    globalThis.Zotero.Items.get = (itemId: number) => ({
      isAttachment: () => itemId === 99 || itemId === 100,
      parentID: itemId === 99 || itemId === 100 ? 42 : undefined,
    });
    const call = async (id: number, args: Record<string, unknown>) => {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "library_retrieve", arguments: args },
        },
      });
      return JSON.parse(response[2]);
    };

    try {
      assert.equal((await call(6, { query: "sentinel" })).result.isError, true);
      assert.equal(
        (
          await call(7, {
            query: "sentinel",
            scope: { itemIds: [42] },
          })
        ).result.isError,
        true,
      );
      assert.equal(
        (
          await call(8, {
            query: "sentinel",
            scope: { itemIds: [99] },
          })
        ).result.isError,
        true,
      );
      assert.equal(
        (
          await call(9, {
            query: "sentinel",
            scope: { itemIds: [100] },
          })
        ).result.isError,
        true,
      );
      assert.equal(executionCount, 0);
      const otherParent = await call(10, {
        query: "sentinel",
        scope: { itemIds: [43] },
      });
      assert.equal(otherParent.result.isError, true);
      assert.equal(executionCount, 0);
    } finally {
      scoped.clear();
    }
  });

  it("blocks library attachment enumeration for raw parents without suppressing metadata and notes", async function () {
    const executed: unknown[] = [];
    const registry = new AgentToolRegistry();
    const libraryRead = createReadTool("library_read");
    libraryRead.execute = async (input) => {
      executed.push(input);
      return {
        input,
        attachments: [
          {
            contextItemId: 99,
            mineruCacheDir: "/private/wrong/full.md",
          },
        ],
      };
    };
    registry.register(libraryRead);
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const scoped = registerScopedZoteroMcpScope({
      conversationKey: 7_915,
      libraryID: 7,
      kind: "paper",
      pdfPaperContexts: [
        {
          itemId: 42,
          contextItemId: 99,
          title: "Raw PDF",
          contentSourceMode: "pdf",
        },
      ],
      selectedPaperContexts: [
        {
          itemId: 42,
          contextItemId: 100,
          title: "Explicit Text sibling",
          contentSourceMode: "text",
        },
      ],
    });
    globalThis.Zotero.Items.get = (itemId: number) => ({
      isAttachment: () => itemId === 99 || itemId === 100,
      parentID: itemId === 99 || itemId === 100 ? 42 : undefined,
    });
    const headers = { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token };
    const call = async (id: number, args: Record<string, unknown>) => {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers,
        body: {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "library_read", arguments: args },
        },
      });
      return JSON.parse(response[2]);
    };

    try {
      const safe = await call(1, {
        itemIds: [42],
        sections: ["metadata", "notes"],
      });
      assert.isNotTrue(safe.result.isError);

      const rawParentAttachments = await call(2, {
        itemIds: [42],
        sections: ["attachments"],
      });
      assert.equal(rawParentAttachments.result.isError, true);

      const rawContextMetadata = await call(5, {
        itemIds: [99],
        sections: ["metadata", "notes"],
      });
      assert.equal(rawContextMetadata.result.isError, true);

      const rawContextAttachments = await call(6, {
        itemIds: [99],
        sections: ["attachments"],
      });
      assert.equal(rawContextAttachments.result.isError, true);

      const siblingAttachmentAlias = await call(7, {
        itemIds: [100],
        sections: ["attachments"],
      });
      assert.equal(siblingAttachmentAlias.result.isError, true);

      const siblingStillEnumeratesRawParent = await call(3, {
        paperContexts: [
          {
            itemId: 42,
            contextItemId: 100,
            title: "Explicit Text sibling",
          },
        ],
        sections: ["attachments"],
      });
      assert.equal(siblingStillEnumeratesRawParent.result.isError, true);

      const otherParent = await call(4, {
        itemIds: [43],
        sections: ["attachments"],
      });
      assert.equal(otherParent.result.isError, true);
      assert.deepEqual(executed, [
        { itemIds: [42], sections: ["metadata", "notes"] },
      ]);
    } finally {
      scoped.clear();
    }
  });

  for (const backend of ["unavailable", "codex_responses"] as const) {
    const modeLabel = backend === "codex_responses" ? "Codex" : "Claude Code";
    it(`prevents native filesystem and Zotero-script PDF bypasses in ${modeLabel} raw-PDF scope`, async function () {
      const executed: Array<{ name: string; input: unknown }> = [];
      const registry = new AgentToolRegistry();
      for (const name of ["run_command", "file_io", "zotero_script"]) {
        registry.register({
          spec: {
            name,
            description: `Native access tool ${name}`,
            inputSchema:
              name === "file_io"
                ? {
                    type: "object",
                    additionalProperties: false,
                    required: ["action", "filePath"],
                    properties: {
                      action: {
                        type: "string",
                        enum: ["read", "write"],
                      },
                      filePath: { type: "string" },
                      content: { type: "string" },
                      offset: { type: "number" },
                      length: { type: "number" },
                    },
                  }
                : { type: "object", additionalProperties: true },
            mutability: "write",
            requiresConfirmation: false,
          },
          validate: (args) => ({ ok: true, value: args ?? {} }),
          execute: async (input) => {
            executed.push({ name, input });
            return { content: { name, input }, effect: "applied" };
          },
        });
      }
      registerMcpServer({
        toolRegistry: registry,
        zoteroGateway: {} as never,
      });
      const rawScope = registerScopedZoteroMcpScope({
        profileSignature: `profile-${modeLabel}`,
        conversationKey: backend === "codex_responses" ? 7_920_001 : 7_920_002,
        libraryID: 7,
        kind: "paper",
        exhaustiveReadBackend: backend,
        pdfPaperContexts: [
          {
            itemId: 42,
            contextItemId: 99,
            title: "PDF_B_SENTINEL",
            contentSourceMode: "pdf",
          },
        ],
      });
      const headers = { [ZOTERO_MCP_SCOPE_HEADER]: rawScope.token };
      const call = async (id: number, name: string, args: unknown) => {
        const response = await invokeMcpEndpoint({
          token: getOrCreateZoteroMcpBearerToken(),
          headers,
          body: {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          },
        });
        return JSON.parse(response[2]);
      };

      try {
        const listResponse = await invokeMcpEndpoint({
          token: getOrCreateZoteroMcpBearerToken(),
          headers,
          body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        });
        const tools = JSON.parse(listResponse[2]).result.tools as Array<{
          name: string;
          description: string;
          inputSchema: {
            properties?: Record<string, { enum?: string[] }>;
          };
        }>;
        assert.notInclude(
          tools.map((tool) => tool.name),
          "run_command",
        );
        assert.notInclude(
          tools.map((tool) => tool.name),
          "zotero_script",
        );
        const fileIo = tools.find((tool) => tool.name === "file_io");
        assert.isUndefined(fileIo);

        const blockedCalls: Array<[string, unknown]> = [
          ["run_command", { command: "cat /papers/wrong-sibling.pdf" }],
          [
            "file_io",
            { action: "read", filePath: "/papers/wrong-sibling.pdf" },
          ],
          [
            "file_io",
            { action: "stat", filePath: "/papers/wrong-sibling.pdf" },
          ],
          ["file_io", { operation: "list", path: "/papers/wrong-sibling" }],
          [
            "zotero_script",
            {
              mode: "read",
              code: "return Zotero.Items.get(99).getFilePath();",
            },
          ],
        ];
        for (let index = 0; index < blockedCalls.length; index += 1) {
          const [name, args] = blockedCalls[index];
          const payload = await call(index + 2, name, args);
          assert.equal(
            payload.result.isError,
            true,
            `${name} must fail closed`,
          );
        }
        assert.deepEqual(executed, []);

        const writePayload = await call(20, "file_io", {
          action: "write",
          filePath: "/tmp/user-authorized-analysis.md",
          content: "Safe derived output",
        });
        assert.equal(writePayload.result.isError, true);
        assert.deepEqual(executed, []);
      } finally {
        rawScope.clear();
      }
    });
  }

  it("keeps native filesystem and Zotero-script tools unchanged outside raw-PDF scope", async function () {
    const executed: string[] = [];
    const registry = new AgentToolRegistry();
    for (const name of ["run_command", "file_io", "zotero_script"]) {
      registry.register({
        spec: {
          name,
          description: `Native access tool ${name}`,
          inputSchema: { type: "object", additionalProperties: true },
          mutability: "write",
          requiresConfirmation: false,
        },
        validate: (args) => ({ ok: true, value: args ?? {} }),
        planMutation: async () => ({
          effect: "none",
          reversibility: "none",
        }),
        execute: async () => {
          executed.push(name);
          return { content: { name }, effect: "none" };
        },
      });
    }
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const scope = registerScopedZoteroMcpScope({
      conversationKey: 7_920_003,
      libraryID: 7,
      kind: "global",
    });
    const headers = { [ZOTERO_MCP_SCOPE_HEADER]: scope.token };

    try {
      const listResponse = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers,
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      const names = JSON.parse(listResponse[2]).result.tools.map(
        (tool: { name: string }) => tool.name,
      );
      assert.includeMembers(names, ["run_command", "file_io", "zotero_script"]);

      for (const [index, [name, args]] of [
        ["run_command", { command: "pwd" }],
        ["file_io", { action: "read", filePath: "/tmp/source.md" }],
        ["zotero_script", { mode: "read", code: "return 1" }],
      ].entries()) {
        const response = await invokeMcpEndpoint({
          token: getOrCreateZoteroMcpBearerToken(),
          headers,
          body: {
            jsonrpc: "2.0",
            id: index + 2,
            method: "tools/call",
            params: { name, arguments: args },
          },
        });
        assert.isNotTrue(JSON.parse(response[2]).result.isError);
      }
      assert.deepEqual(executed, ["run_command", "file_io", "zotero_script"]);
    } finally {
      scope.clear();
    }
  });

  it("emits exact MCP tool activity for native Codex trace fallback", async function () {
    const registry = new AgentToolRegistry();
    registry.register(createReadTool("library_read"));
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
            name: "library_read",
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
          toolName: "library_read",
          arguments: { sections: ["metadata"] },
          conversationKey: 789,
          libraryID: 7,
        },
        {
          requestId: "jsonrpc:tool-call-1",
          phase: "completed",
          toolName: "library_read",
          arguments: { sections: ["metadata"] },
          conversationKey: 789,
          libraryID: 7,
        },
      ],
    );
  });

  it("includes paper_read quote citations in completed MCP activity", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "paper_read",
        description: "Read paper",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async () => ({
        quoteCitations: [
          {
            id: "Q_test",
            quoteText: "A quoted passage.",
            citationLabel: "(Smith, 2024)",
            contextItemId: 23,
          },
        ],
      }),
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const events: Array<{ phase: string; quoteCitations?: unknown[] }> = [];
    const unregister = addZoteroMcpToolActivityObserver((event) => {
      events.push({
        phase: event.phase,
        quoteCitations: event.quoteCitations,
      });
    });

    try {
      await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        body: {
          jsonrpc: "2.0",
          id: "quote-call",
          method: "tools/call",
          params: {
            name: "paper_read",
            arguments: { mode: "targeted" },
          },
        },
      });
    } finally {
      unregister();
    }

    const completed = events.find((event) => event.phase === "completed");
    assert.deepInclude(completed?.quoteCitations?.[0] as object, {
      id: "Q_test",
      quoteText: "A quoted passage.",
      citationLabel: "(Smith, 2024)",
      contextItemId: 23,
    });
  });

  it("uses explicit MCP scope args as context defaults without passing them to validators", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "library_search",
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
          name: "library_search",
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
        name: "paper_read",
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
          turnPaperScope: context.request.turnPaperScope,
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
        attachmentTitle: "Scoped PDF",
        firstCreator: "Ng",
        year: "2026",
        contentSourceMode: "mineru",
        mineruCacheDir: "/tmp/mineru-cache/scoped-paper",
      },
      selectedCollectionContexts: [
        {
          collectionId: 9,
          libraryID: 7,
          name: "Scoped Collection",
        },
      ],
      selectedTagContexts: [
        {
          name: "Stable",
          normalizedName: "stable",
          libraryID: 7,
        },
      ],
    });
    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "paper_read",
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
        turnPaperScope: {
          libraryID: 7,
          conversationKind: "paper",
          papers: [
            {
              paper: {
                libraryID: 7,
                itemId: 55,
                contextItemId: 66,
                title: "Scoped Paper",
                attachmentTitle: "Scoped PDF",
                firstCreator: "Ng",
                year: "2026",
                contentSourceMode: "mineru",
                mineruCacheDir: "/tmp/mineru-cache/scoped-paper",
              },
              roles: ["active", "full_text"],
            },
          ],
          collections: [
            {
              collectionId: 9,
              libraryID: 7,
              name: "Scoped Collection",
            },
          ],
          tags: [
            {
              name: "Stable",
              normalizedName: "stable",
              libraryID: 7,
            },
          ],
          selectedPassagePaperRefs: [],
        },
      });
    } finally {
      clearScope();
    }
  });

  it("passes scoped selected, full-text, and pinned paper contexts with source metadata", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "paper_read",
        description: "Read paper",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async (_input, context: AgentToolContext) => ({
        request: { turnPaperScope: context.request.turnPaperScope },
      }),
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });

    const selectedPaper = {
      itemId: 56,
      contextItemId: 67,
      title: "Selected Scoped Paper",
      attachmentTitle: "Selected PDF",
      citationKey: "ngSelected2026",
      firstCreator: "Ng",
      year: "2026",
      contentSourceMode: "mineru" as const,
      mineruCacheDir: "/tmp/mineru-cache/selected",
    };
    const fullTextPaper = {
      itemId: 57,
      contextItemId: 68,
      title: "Full Text Scoped Paper",
      attachmentTitle: "Full Text PDF",
      firstCreator: "Lee",
      year: "2025",
      contentSourceMode: "markdown" as const,
      mineruCacheDir: "/tmp/mineru-cache/full-text",
    };
    const pinnedPaper = {
      itemId: 58,
      contextItemId: 69,
      title: "Pinned Scoped Paper",
      attachmentTitle: "Pinned PDF",
      firstCreator: "Chen",
      year: "2024",
      contentSourceMode: "text" as const,
      mineruCacheDir: "/tmp/mineru-cache/pinned",
    };

    const scoped = registerScopedZoteroMcpScope({
      conversationKey: 321,
      libraryID: 7,
      kind: "global",
      paperContext: {
        itemId: 55,
        contextItemId: 66,
        title: "Fallback Paper",
      },
      selectedPaperContexts: [selectedPaper],
      fullTextPaperContexts: [fullTextPaper],
      pinnedPaperContexts: [pinnedPaper],
    });
    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: {
          [ZOTERO_MCP_SCOPE_HEADER]: scoped.token,
        },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "paper_read",
            arguments: {},
          },
        },
      });
      const payload = JSON.parse(response[2]);
      const content = JSON.parse(payload.result.content[0].text);
      assert.equal(content.ok, true);
      assert.deepEqual(
        content.result.request.turnPaperScope.papers.map(
          (entry: { paper: unknown; roles: string[] }) => ({
            paper: entry.paper,
            roles: entry.roles,
          }),
        ),
        [
          { paper: { ...selectedPaper, libraryID: 7 }, roles: ["selected"] },
          { paper: { ...fullTextPaper, libraryID: 7 }, roles: ["full_text"] },
          { paper: { ...pinnedPaper, libraryID: 7 }, roles: ["pinned"] },
        ],
      );
    } finally {
      scoped.clear();
    }
  });

  it("passes selected tags to omitted-scope library_retrieve MCP calls", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "library_retrieve",
        description: "Retrieve from library",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async (input, context: AgentToolContext) => ({
        input,
        selectedTagContexts: context.request.turnPaperScope.tags,
      }),
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });

    const clearScope = setActiveZoteroMcpScope({
      conversationKey: 456,
      libraryID: 7,
      kind: "global",
      selectedTagContexts: [
        {
          name: "Stable",
          normalizedName: "stable",
          libraryID: 7,
        },
      ],
    });
    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "library_retrieve",
            arguments: {
              query: "what papers are here?",
              intent: "enumerate",
            },
          },
        },
      });
      const payload = JSON.parse(response[2]);
      const content = JSON.parse(payload.result.content[0].text);
      assert.equal(content.ok, true);
      assert.deepEqual(content.result.input, {
        query: "what papers are here?",
        intent: "enumerate",
      });
      assert.deepEqual(content.result.selectedTagContexts, [
        {
          name: "Stable",
          normalizedName: "stable",
          libraryID: 7,
        },
      ]);
    } finally {
      clearScope();
    }
  });

  it("rejects mixed canonical and legacy MCP paper scope representations", function () {
    assert.throws(
      () =>
        setActiveZoteroMcpScope({
          conversationKey: 457,
          libraryID: 1,
          kind: "paper",
          turnPaperScope: {
            libraryID: 1,
            conversationKind: "paper",
            papers: [],
            collections: [],
            tags: [],
            selectedPassagePaperRefs: [],
          },
          selectedPaperContexts: [
            { itemId: 1, contextItemId: 2, title: "Legacy" },
          ],
        }),
      /conflicting_paper_scope/,
    );
    assert.throws(
      () =>
        setActiveZoteroMcpScope({
          conversationKey: 457,
          libraryID: 1,
          kind: "paper",
          turnPaperScope: {
            libraryID: 1,
            conversationKind: "paper",
            papers: [],
            collections: [],
            tags: [],
            selectedPassagePaperRefs: [],
          },
          selectedPaperContexts: [],
        } as never),
      /conflicting_paper_scope/,
    );
  });

  it("accepts raw target empty object through MCP semantic validation", async function () {
    const paper = {
      libraryID: 1,
      itemId: 71,
      contextItemId: 72,
      title: "Issue 393 paper",
    };
    let ensuredPaper: unknown;
    const gateway = {
      listPaperContexts: () => [paper],
      resolvePaperContextTarget: () => paper,
    } as never;
    const registry = new AgentToolRegistry();
    registry.register(
      createPaperReadTool(
        {
          ensurePaperContext: async (paperContext: unknown) => {
            ensuredPaper = paperContext;
          },
        } as never,
        {
          retrieveEvidence: async () => [
            {
              itemId: paper.itemId,
              contextItemId: paper.contextItemId,
              title: paper.title,
              text: "method evidence",
            },
          ],
        } as never,
        {} as never,
        gateway,
      ),
    );
    registerMcpServer({ toolRegistry: registry, zoteroGateway: gateway });
    const scoped = registerScopedZoteroMcpScope({
      conversationKey: 458,
      libraryID: 1,
      kind: "paper",
      activeItemId: paper.itemId,
      activeContextItemId: paper.contextItemId,
      userText: "Use the actual PDF/full text to explain the method.",
      turnPaperScope: {
        libraryID: 1,
        conversationKind: "paper",
        papers: [{ paper, roles: ["active"] }],
        collections: [],
        tags: [],
        selectedPassagePaperRefs: [],
      },
    });
    try {
      const listResponse = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      const listedPaperRead = JSON.parse(listResponse[2]).result.tools.find(
        (tool: { name: string }) => tool.name === "paper_read",
      );
      assert.isArray(listedPaperRead.inputSchema.properties.target.anyOf);

      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "paper_read",
            arguments: {
              mode: "targeted",
              target: {},
              query: "Use the actual PDF/full text to explain the method.",
            },
          },
        },
      });
      const payload = JSON.parse(response[2]);
      assert.isNotTrue(payload.result.isError);
      assert.deepEqual(ensuredPaper, paper);
    } finally {
      scoped.clear();
    }
  });

  it("deduplicates repeated same-turn semantic read calls", async function () {
    let executeCount = 0;
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "paper_read",
        description: "Read paper",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async (input) => {
        executeCount += 1;
        return { executeCount, input };
      },
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const scoped = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-dedupe",
        conversationKey: 789,
        libraryID: 1,
        kind: "paper",
        userText: "compare methods",
      },
      { token: "dedupe-scope-token" },
    );

    try {
      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "paper_read",
          arguments: { mode: "targeted", query: "methods" },
        },
      };
      const firstResponse = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body,
      });
      const secondResponse = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: { ...body, id: 2 },
      });

      const firstPayload = JSON.parse(firstResponse[2]);
      const firstContent = JSON.parse(firstPayload.result.content[0].text);
      const secondPayload = JSON.parse(secondResponse[2]);
      const secondContent = JSON.parse(secondPayload.result.content[0].text);
      assert.equal(firstContent.ok, true);
      assert.equal(firstContent.result.executeCount, 1);
      assert.equal(secondContent.ok, true);
      assert.equal(secondContent.duplicate, true);
      assert.equal(secondContent.result.executeCount, 1);
      assert.equal(executeCount, 1);
    } finally {
      scoped.clear();
    }
  });

  it("does not deduplicate semantic reads without a scoped MCP token", async function () {
    let executeCount = 0;
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "paper_read",
        description: "Read paper",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async (input) => {
        executeCount += 1;
        return { executeCount, input };
      },
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const clearActiveScope = setActiveZoteroMcpScope({
      profileSignature: "profile-active-dedupe",
      conversationKey: 791,
      libraryID: 1,
      kind: "paper",
      userText: "compare methods",
    });

    try {
      const token = getOrCreateZoteroMcpBearerToken();
      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "paper_read",
          arguments: { mode: "targeted", query: "methods" },
        },
      };
      const firstResponse = await invokeMcpEndpoint({ token, body });
      const secondResponse = await invokeMcpEndpoint({
        token,
        body: { ...body, id: 2 },
      });

      const firstPayload = JSON.parse(firstResponse[2]);
      const firstContent = JSON.parse(firstPayload.result.content[0].text);
      const secondPayload = JSON.parse(secondResponse[2]);
      const secondContent = JSON.parse(secondPayload.result.content[0].text);
      assert.equal(firstContent.result.executeCount, 1);
      assert.notProperty(secondContent, "duplicate");
      assert.equal(secondContent.result.executeCount, 2);
      assert.equal(executeCount, 2);
    } finally {
      clearActiveScope();
    }
  });

  it("clears semantic read dedupe when the scoped MCP turn is cleared", async function () {
    let executeCount = 0;
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "paper_read",
        description: "Read paper",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async (input) => {
        executeCount += 1;
        return { executeCount, input };
      },
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const scoped = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-dedupe-clear",
        conversationKey: 792,
        libraryID: 1,
        kind: "paper",
        userText: "compare methods",
      },
      { token: "dedupe-clear-scope-token" },
    );
    const token = getOrCreateZoteroMcpBearerToken();
    const headers = { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token };
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "paper_read",
        arguments: { mode: "targeted", query: "methods" },
      },
    };

    const firstResponse = await invokeMcpEndpoint({ token, headers, body });
    scoped.clear();
    const nextScoped = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-dedupe-clear",
        conversationKey: 793,
        libraryID: 1,
        kind: "paper",
        userText: "compare methods",
      },
      { token: scoped.token },
    );

    try {
      const secondResponse = await invokeMcpEndpoint({
        token,
        headers,
        body: { ...body, id: 2 },
      });

      const firstPayload = JSON.parse(firstResponse[2]);
      const firstContent = JSON.parse(firstPayload.result.content[0].text);
      const secondPayload = JSON.parse(secondResponse[2]);
      const secondContent = JSON.parse(secondPayload.result.content[0].text);
      assert.equal(firstContent.result.executeCount, 1);
      assert.notProperty(secondContent, "duplicate");
      assert.equal(secondContent.result.executeCount, 2);
      assert.equal(executeCount, 2);
    } finally {
      nextScoped.clear();
    }
  });

  it("invalidates semantic read dedupe after successful writes", async function () {
    let readExecuteCount = 0;
    let writeExecuteCount = 0;
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "library_search",
        description: "Search library",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async (input) => {
        readExecuteCount += 1;
        return { readExecuteCount, input };
      },
    });
    registry.register({
      spec: {
        name: "library_update",
        description: "Update library",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      planMutation: async () => ({
        effect: "write",
        reversibility: "full",
      }),
      execute: async () => {
        writeExecuteCount += 1;
        return {
          content: { writeExecuteCount },
          effect: "applied",
        };
      },
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const scoped = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-dedupe-write",
        conversationKey: 790,
        libraryID: 1,
        kind: "global",
        userText: "move and verify",
      },
      { token: "dedupe-write-scope-token" },
    );

    const token = getOrCreateZoteroMcpBearerToken();
    const headers = { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token };
    const readBody = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "library_search",
        arguments: {
          entity: "items",
          mode: "list",
          filters: { unfiled: true },
        },
      },
    });
    const parseContent = (reply: EndpointReply) => {
      const payload = JSON.parse(reply[2]);
      return JSON.parse(payload.result.content[0].text);
    };

    try {
      const firstContent = parseContent(
        await invokeMcpEndpoint({ token, headers, body: readBody(1) }),
      );
      const secondContent = parseContent(
        await invokeMcpEndpoint({ token, headers, body: readBody(2) }),
      );
      await invokeMcpEndpoint({
        token,
        headers,
        body: {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "library_update",
            arguments: { kind: "collections", itemIds: [1] },
          },
        },
      });
      const thirdContent = parseContent(
        await invokeMcpEndpoint({ token, headers, body: readBody(4) }),
      );

      assert.equal(firstContent.result.readExecuteCount, 1);
      assert.equal(secondContent.duplicate, true);
      assert.equal(secondContent.result.readExecuteCount, 1);
      assert.equal(writeExecuteCount, 1);
      assert.notProperty(thirdContent, "duplicate");
      assert.equal(thirdContent.result.readExecuteCount, 2);
    } finally {
      scoped.clear();
    }
  });

  it("binds MCP tool context from the scoped header before the legacy active scope", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "library_search",
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
          model: context.request.model,
          apiBase: context.request.apiBase,
          authMode: context.request.authMode,
          reasoning: context.request.reasoning,
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
        model: "gpt-5.5",
        codexPath: "/tmp/codex-native",
        exhaustiveReadBackend: "codex_responses",
        reasoning: { provider: "openai", level: "high" },
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
            name: "library_search",
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
        model: "gpt-5.5",
        apiBase: "/tmp/codex-native",
        authMode: "codex_app_server",
        reasoning: { provider: "openai", level: "high" },
      });
    } finally {
      scoped.clear();
      clearLegacyScope();
    }
  });

  it("keeps an overlapping raw-PDF token authoritative over a same-profile ordinary active turn", async function () {
    let executionCount = 0;
    const registry = new AgentToolRegistry();
    const paperRead = createReadTool("paper_read");
    paperRead.execute = async (input) => {
      executionCount += 1;
      return { input };
    };
    registry.register(paperRead);
    registry.register(createWriteTool("run_command"));
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });

    const rawScope = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-overlap",
        conversationKey: 8_001,
        libraryID: 1,
        kind: "paper",
        pdfPaperContexts: [
          {
            itemId: 42,
            contextItemId: 99,
            title: "Raw turn A",
            contentSourceMode: "pdf",
          },
        ],
      },
      { token: "raw-overlap-token" },
    );
    const clearActiveScope = setActiveZoteroMcpScope({
      profileSignature: "profile-overlap",
      conversationKey: 8_002,
      libraryID: 1,
      kind: "global",
    });
    const rawHeaders = { [ZOTERO_MCP_SCOPE_HEADER]: rawScope.token };
    const exactRawArgs = {
      target: { paperContext: { itemId: 42, contextItemId: 99 } },
    };

    try {
      const listResponse = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: rawHeaders,
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      const listedNames = JSON.parse(listResponse[2]).result.tools.map(
        (tool: { name: string }) => tool.name,
      );
      assert.notInclude(listedNames, "run_command");

      const rawResponse = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: rawHeaders,
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "paper_read", arguments: exactRawArgs },
        },
      });
      assert.equal(JSON.parse(rawResponse[2]).result.isError, true);
      assert.equal(executionCount, 0);

      const activeOrdinaryResponse = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        body: {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "paper_read", arguments: exactRawArgs },
        },
      });
      assert.isNotTrue(JSON.parse(activeOrdinaryResponse[2]).result.isError);
      assert.equal(executionCount, 1);
    } finally {
      clearActiveScope();
      rawScope.clear();
    }
  });

  it("rejects full reads from Claude-only MCP scopes before loading the PDF", async function () {
    const paperContext = {
      itemId: 91,
      contextItemId: 92,
      title: "Claude-only paper",
    };
    let ensurePaperContextCount = 0;
    const registry = new AgentToolRegistry();
    registry.register(
      createPaperReadTool(
        {
          ensurePaperContext: async () => {
            ensurePaperContextCount += 1;
            throw new Error("the PDF must not be loaded");
          },
        } as never,
        {} as never,
        {} as never,
        {
          resolvePaperContextTarget: () => paperContext,
          listPaperContexts: () => [paperContext],
        } as never,
      ),
    );
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const scoped = registerScopedZoteroMcpScope(
      {
        profileSignature: "claude-profile",
        conversationKey: 457,
        libraryID: 1,
        kind: "paper",
        paperContext,
        selectedPaperContexts: [paperContext],
      },
      { token: "claude-only-full-read" },
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
            name: "paper_read",
            arguments: {
              mode: "full",
              target: {
                itemId: paperContext.itemId,
                contextItemId: paperContext.contextItemId,
              },
              query: "Read the complete paper.",
            },
          },
        },
      });
      const payload = JSON.parse(response[2]);
      const content = JSON.parse(payload.result.content[0].text);

      assert.equal(payload.result.isError, true);
      assert.equal(content.ok, false);
      assert.include(
        content.result.error,
        "tool-free full-read backend is unavailable",
      );
      assert.equal(ensurePaperContextCount, 0);
    } finally {
      scoped.clear();
    }
  });

  it("routes pending MCP confirmations through the registered Zotero UI handler", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "paper_read",
        description: "Read attachment",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "read",
        requiresConfirmation: true,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      createPendingAction: async () => ({
        toolName: "paper_read",
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
            name: "paper_read",
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
        ["paper_read"],
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
        name: "library_update",
        description: "Apply tags",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      createPendingAction: async () => ({
        toolName: "library_update",
        title: "Apply Tags",
        confirmLabel: "Apply",
        cancelLabel: "Cancel",
        fields: [],
      }),
      execute: async () => {
        executeCount += 1;
        return { content: { applied: true }, effect: "applied" };
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
            name: "library_update",
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
        planMutation: async () => ({
          effect: "none",
          reversibility: "none",
        }),
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
          return { content: { direct: true, name }, effect: "none" };
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

  it("creates standalone notes through the note_write review card path", async function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "note_write",
        description: "Edit or create notes",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      createPendingAction: async (input) => {
        const record = input as Record<string, unknown>;
        return {
          toolName: "note_write",
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
        content: {
          status: "created",
          noteId: 99,
          target: (input as { target?: unknown }).target,
          noteContent: (input as { content?: unknown }).content,
        },
        effect: "applied",
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
            name: "note_write",
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

  it("binds scoped active notes to note_write diff review cards", async function () {
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
        name: "note_write",
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
          toolName: "note_write",
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
        content: {
          status: "updated",
          noteId: context.request.activeNoteContext?.noteId,
        },
        effect: "applied",
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
            name: "note_write",
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

  it("keeps a conversation scope token usable across turns and rebinds it to the newest turn", async function () {
    let seenActiveItemId: number | undefined;
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "library_read",
        description: "Read an item",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async (_input, context: AgentToolContext) => {
        seenActiveItemId = context.request.activeItemId;
        return { activeItemId: context.request.activeItemId };
      },
    });
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const registerTurn = (activeItemId: number) =>
      registerScopedZoteroMcpScope(
        {
          profileSignature: "profile-conv",
          conversationKey: 501,
          libraryID: 1,
          kind: "global",
          activeItemId,
        },
        {
          token: resolveConversationScopeToken({
            profileSignature: "profile-conv",
            conversationKey: 501,
          }),
        },
      );
    const firstTurn = registerTurn(10);
    // Turn teardown releases the scope; only the token stays registered.
    firstTurn.clear();
    const secondTurn = registerTurn(20);
    try {
      assert.equal(secondTurn.token, firstTurn.token);

      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: firstTurn.token },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "library_read", arguments: {} },
        },
      });
      assert.isUndefined(JSON.parse(response[2]).error);
      assert.equal(seenActiveItemId, 20);
    } finally {
      secondTurn.clear();
    }
  });

  it("keeps a conversation scope token stable across MCP endpoint restarts", function () {
    const firstToken = resolveConversationScopeToken({
      profileSignature: "profile-restart",
      conversationKey: 503,
    });

    unregisterMcpServer();

    assert.equal(
      resolveConversationScopeToken({
        profileSignature: "profile-restart",
        conversationKey: 503,
      }),
      firstToken,
    );
  });

  it("releases only the deleted conversation's stable scope token", async function () {
    registerMcpServer({
      toolRegistry: new AgentToolRegistry(),
      zoteroGateway: {} as never,
    });
    const firstToken = resolveConversationScopeToken({
      profileSignature: "profile-cleanup-a",
      conversationKey: 502,
    });
    const otherProfileToken = resolveConversationScopeToken({
      profileSignature: "profile-cleanup-b",
      conversationKey: 502,
    });
    const activeScope = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-cleanup-a",
        conversationKey: 502,
        libraryID: 1,
        kind: "global",
      },
      { token: firstToken },
    );

    releaseConversationScopeToken({
      profileSignature: "profile-cleanup-a",
      conversationKey: 502,
    });

    assert.notEqual(
      resolveConversationScopeToken({
        profileSignature: "profile-cleanup-a",
        conversationKey: 502,
      }),
      firstToken,
    );
    assert.equal(
      resolveConversationScopeToken({
        profileSignature: "profile-cleanup-b",
        conversationKey: 502,
      }),
      otherProfileToken,
    );
    const staleResponse = await invokeMcpEndpoint({
      token: getOrCreateZoteroMcpBearerToken(),
      headers: { [ZOTERO_MCP_SCOPE_HEADER]: firstToken },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      },
    });
    assert.match(
      JSON.parse(staleResponse[2]).error.message,
      /scope token is invalid or expired/i,
    );
    activeScope.clear();
  });

  it("rejects stale cached MCP write headers instead of rebinding them", async function () {
    let pendingConversationKey: number | undefined;
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "library_update",
        description: "Apply tags",
        inputSchema: { type: "object", additionalProperties: true },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      createPendingAction: async (_input, context: AgentToolContext) => {
        pendingConversationKey = context.request.conversationKey;
        return {
          toolName: "library_update",
          title: "Apply Tags",
          confirmLabel: "Apply",
          cancelLabel: "Cancel",
          fields: [],
        };
      },
      execute: async (_input, context: AgentToolContext) => ({
        content: {
          request: {
            conversationKey: context.request.conversationKey,
            libraryID: context.request.libraryID,
            activeItemId: context.request.activeItemId,
          },
        },
        effect: "applied",
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
            name: "library_update",
            arguments: { itemIds: [1], tags: ["memory"] },
          },
        },
      });
      const payload = JSON.parse(response[2]);
      assert.include(payload.error.message, "invalid or expired");
      assert.isUndefined(pendingConversationKey);
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
      planMutation: async () => ({
        effect: "write",
        reversibility: "full",
      }),
      createPendingAction: async () => {
        throw new Error("zotero_script should not request confirmation");
      },
      execute: async () => {
        executed = true;
        return { content: { status: "ran" }, effect: "applied" };
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
              script:
                "env.addInverse({ version: 1, kind: 'library_operations', operations: [] });",
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

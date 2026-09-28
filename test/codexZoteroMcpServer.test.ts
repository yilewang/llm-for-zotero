import { ActionContractService } from "../src/agent/contracts/actionContract";
import { actionContractFixture } from "./helpers/semanticIntent";
import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { createSubmitDocumentTool } from "../src/agent/tools/plan/submitPlanDocument";
import { initPlanDocumentStore } from "../src/agent/documents/store";
import {
  addZoteroMcpToolActivityObserver,
  getOrCreateZoteroMcpBearerToken,
  getZoteroMcpServerUrl,
  registerScopedZoteroMcpScope,
  registerMcpServer,
  releaseConversationScopeToken,
  resolveConversationScopeToken,
  unregisterMcpServer,
  ZOTERO_MCP_ENDPOINT_PATH,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../src/agent/mcp/server";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import type {
  AgentActionOperation,
  AgentToolContext,
  AgentToolDefinition,
} from "../src/agent/types";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import { createFileIOTool } from "../src/agent/tools/write/fileIO";
import { createResearchUpdateTool } from "../src/agent/tools/plan/researchUpdate";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import {
  readOnlyInvocationPlan,
  stateChangeInvocationPlan,
} from "../src/agent/authorization/invocationPlan";
import { withImageRetrieval } from "./helpers/retrievalMocks";

type EndpointReply = [number, string, string];

function testWriteDescriptor(name: string) {
  return [
    name === "zotero_script"
      ? {
          id: "zotero-script:test",
          proofDomain: "execution" as const,
          capability: "zotero.script" as const,
          operation: "zotero_script_execute" as const,
          source: "zotero_script" as const,
          requestedTargets: [],
          destinationCollectionIds: [],
        }
      : {
          id: `settings:${name}`,
          proofDomain: "zotero_state" as const,
          capability: "zotero.settings" as const,
          operation: "settings_update" as const,
          source: "zotero_native" as const,
          requestedTargets: [],
          destinationCollectionIds: [],
        },
  ];
}

/** The operations testWriteDescriptor can produce for a given fixture name. */
function testWriteOperations(name: string): AgentActionOperation[] {
  return name === "zotero_script"
    ? ["zotero_script_execute"]
    : ["settings_update"];
}

function createReadTool(name: string): AgentToolDefinition<unknown, unknown> {
  return {
    spec: {
      name,
      description: `Read tool ${name}`,
      inputSchema: { type: "object", additionalProperties: true },
      executionClass: "read",
      workCategory: "retrieval",
      requiresConfirmation: false,
    },
    validate: (args) => ({ ok: true, value: args ?? {} }),
    execute: async (input) => ({ name, input }),
  };
}

function createWriteTool(name: string): AgentToolDefinition<unknown, unknown> {
  return {
    effectOperations: testWriteOperations(name),
    spec: {
      name,
      description: `Write tool ${name}`,
      inputSchema: { type: "object", additionalProperties: true },
      executionClass: "external_effect",
      workCategory: "zotero_action",
      requiresConfirmation: true,
    },
    validate: (args) => ({ ok: true, value: args ?? {} }),
    planInvocation: async () =>
      stateChangeInvocationPlan({
        domains: ["zotero_library"],
        effects: ["modify"],
        reversibility: "full",
        reason: `The ${name} fixture mutates Zotero state.`,
      }),
    describeAction: () => testWriteDescriptor(name),
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
  it("exposes only the owning live scope revision to host finalization", function () {
    const old = registerScopedZoteroMcpScope(
      { conversationKey: 7001, libraryID: 1, kind: "global" },
      { token: "scope-finalization-fixture" },
    );
    const current = registerScopedZoteroMcpScope(
      { conversationKey: 7001, libraryID: 1, kind: "global", runId: "current" },
      { token: "scope-finalization-fixture" },
    );
    assert.isNull(old.getState());
    old.clear();
    assert.equal(current.getState()?.runId, "current");
    current.clear();
    assert.isNull(current.getState());
  });

  const originalZotero = globalThis.Zotero;
  const prefStore = new Map<string, unknown>();
  let selectedLibraryID: number | undefined;

  beforeEach(async function () {
    prefStore.clear();
    selectedLibraryID = undefined;
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
      getActiveZoteroPane: () =>
        selectedLibraryID
          ? {
              getSelectedLibraryID: () => selectedLibraryID,
              getSelectedItems: () => [],
            }
          : undefined,
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

  it("carries the host execution context into scoped MCP tool calls", async function () {
    const executionContext = {
      version: 1 as const,
      executionId: "codex-execution-445",
      conversationKey: 445,
      conversationGeneration: 0,
      chatLibraryID: 1,
      permissionOwner: "external_runtime" as const,
      workspaceSnapshot: {
        selectedPapers: [],
        selectedCollections: [],
      },
      configuredAccess: { libraryIDs: [1], outputDirectories: [] },
    };
    let observed: AgentToolContext["request"]["executionContext"];
    const registry = new AgentToolRegistry();
    const tool = createReadTool("library_read");
    tool.execute = async (_input, context) => {
      observed = context.request.executionContext;
      return { ok: true };
    };
    registry.register(tool);
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const scope = registerScopedZoteroMcpScope({
      conversationKey: 445,
      conversationGeneration: 0,
      libraryID: 1,
      kind: "global",
      runtimeAuthority: "codex",
      executionContext,
    });

    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scope.token },
        body: {
          jsonrpc: "2.0",
          id: 445,
          method: "tools/call",
          params: { name: "library_read", arguments: {} },
        },
      });
      const payload = JSON.parse(response[2]);
      assert.equal(payload.result.isError, undefined, JSON.stringify(payload));
      assert.equal(observed?.executionId, executionContext.executionId);
      assert.deepEqual(observed?.configuredAccess.fileAccess, {
        readFiles: [],
        writeFiles: [],
        readDirectories: [],
        writeDirectories: [],
      });
      assert.isTrue(observed?.configuredAccess.hostCommandExecution);
    } finally {
      scope.clear();
    }
  });

  it("retains native-runtime document evidence across scoped MCP calls", async function () {
    const items = new Map<number, Record<string, unknown>>([
      [11, { id: 11, key: "PAPER001", libraryID: 1 }],
      [
        22,
        {
          id: 22,
          key: "ATTACH01",
          libraryID: 1,
          parentID: 11,
        },
      ],
    ]);
    (
      globalThis.Zotero.Items as unknown as { get: (id: number) => unknown }
    ).get = (id: number) => items.get(id) || null;

    const artifact = {
      kind: "image" as const,
      mimeType: "image/png",
      storedPath: "/cache/figure-1.png",
      contentHash: `sha256:${"a".repeat(64)}`,
      pageIndex: 2,
      pageLabel: "3",
    };
    const registry = new AgentToolRegistry();
    const paperRead = createReadTool("paper_read");
    paperRead.execute = async () => ({
      content: {
        mode: "figures",
        figures: [
          {
            cropPath: artifact.storedPath,
            pageIndex: artifact.pageIndex,
            sourceFingerprint: `sha256:${"b".repeat(64)}`,
            paperContext: { itemId: 11, contextItemId: 22 },
          },
        ],
      },
      artifacts: [artifact],
    });
    let observedReadEvidence: AgentToolContext["request"]["documentReadObservations"];
    let observedArtifacts: AgentToolContext["request"]["documentArtifactObservations"];
    const probe = createReadTool("library_read");
    probe.execute = async (_input, context) => {
      observedReadEvidence = context.request.documentReadObservations;
      observedArtifacts = context.request.documentArtifactObservations;
      return { observed: true };
    };
    registry.register(paperRead);
    registry.register(probe);
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const scoped = registerScopedZoteroMcpScope({
      conversationKey: 446,
      conversationGeneration: 0,
      libraryID: 1,
      kind: "global",
      runtimeAuthority: "codex",
    });
    const call = async (
      id: number,
      name: string,
      args: Record<string, unknown>,
    ) => {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        },
      });
      const payload = JSON.parse(response[2]);
      assert.isUndefined(payload.result?.isError, response[2]);
    };

    try {
      await call(1, "paper_read", {
        mode: "figures",
        target: { itemId: 11, contextItemId: 22 },
      });
      await call(2, "library_read", {});
      assert.equal(observedReadEvidence?.length, 1);
      assert.include(observedReadEvidence?.[0].capabilities || [], "figure");
      assert.equal(observedArtifacts?.length, 1);
      assert.include(observedArtifacts?.[0] || {}, artifact);
    } finally {
      scoped.clear();
    }
  });

  it("reads scoped task files and writes verified exports through shared file_io", async function () {
    const originalIO = (globalThis as any).IOUtils;
    const files = new Map<string, Uint8Array>([
      ["/cache/paper/full.md", new TextEncoder().encode("Paper evidence")],
      ["/vault/note.md", new TextEncoder().encode("Existing note")],
    ]);
    (globalThis as any).IOUtils = {
      exists: async (path: string) =>
        files.has(path) ||
        ["/", "/cache", "/cache/paper", "/vault", "/other"].includes(path),
      read: async (path: string) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error("File not found");
        return bytes;
      },
      write: async (path: string, bytes: Uint8Array) => {
        files.set(path, new Uint8Array(bytes));
      },
      makeDirectory: async () => undefined,
    };
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register(createFileIOTool());
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    let reviews = 0;
    const scoped = registerScopedZoteroMcpScope({
      runtimeAuthority: "codex",
      conversationKey: 450,
      libraryID: 1,
      kind: "global",
      executionContext: {
        version: 1,
        executionId: "file-io-450",
        conversationKey: 450,
        conversationGeneration: 0,
        chatLibraryID: 1,
        permissionOwner: "external_runtime",
        workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
        configuredAccess: {
          libraryIDs: [1],
          outputDirectories: ["/vault"],
          fileAccess: {
            readFiles: ["/cache/paper/full.md"],
            writeFiles: [],
            readDirectories: ["/vault"],
            writeDirectories: ["/vault"],
          },
          hostCommandExecution: false,
        },
      },
      requestInteraction: async () => {
        reviews++;
        return { approved: true };
      },
    });
    const call = async (id: number, args: Record<string, unknown>) => {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "file_io", arguments: args },
        },
      });
      return JSON.parse(response[2]).result;
    };
    try {
      const read = await call(1, {
        action: "read",
        filePath: "/cache/paper/full.md",
      });
      assert.isUndefined(read.isError, JSON.stringify(read));
      assert.equal(
        JSON.parse(read.content[0].text).result.text,
        "Paper evidence",
      );

      const write = await call(2, {
        action: "write",
        filePath: "/vault/note.md",
        content: "Verified note",
      });
      assert.isUndefined(write.isError, JSON.stringify(write));
      const written = JSON.parse(write.content[0].text);
      assert.equal(written.actionReceipts[0].verification, "verified");
      assert.equal(
        new TextDecoder().decode(files.get("/vault/note.md")),
        "Verified note",
      );
      assert.equal(reviews, 0, "granted access must not add a host review");

      const expanded = await call(3, {
        action: "write",
        filePath: "/other/approved-once.md",
        content: "Expanded",
      });
      assert.isUndefined(expanded.isError, JSON.stringify(expanded));
      const repeatedExpansion = await call(4, {
        action: "write",
        filePath: "/other/approved-once.md",
        content: "Expanded again",
      });
      assert.isUndefined(
        repeatedExpansion.isError,
        JSON.stringify(repeatedExpansion),
      );
      assert.equal(reviews, 0, "the calling agent owns path approval");
    } finally {
      scoped.clear();
      (globalThis as any).IOUtils = originalIO;
    }
  });

  it("allows standalone reads and verified writes without any Zotero permission opt-in", async function () {
    prefStore.set(
      "extensions.zotero.llmforzotero.externalMcpFilesEnabled",
      false,
    );
    prefStore.set(
      "extensions.zotero.llmforzotero.externalMcpReadDirectories",
      JSON.stringify(["/legacy-only"]),
    );
    const originalIO = (globalThis as any).IOUtils;
    const files = new Map<string, Uint8Array>([
      ["/allowed/source.md", new TextEncoder().encode("Standalone evidence")],
    ]);
    (globalThis as any).IOUtils = {
      exists: async (path: string) =>
        files.has(path) || ["/", "/allowed"].includes(path),
      read: async (path: string) => files.get(path),
      write: async (path: string, bytes: Uint8Array) =>
        files.set(path, new Uint8Array(bytes)),
      makeDirectory: async () => undefined,
    };
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register(createFileIOTool());
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const call = async (id: number, args: Record<string, unknown>) => {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        body: {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "file_io", arguments: args },
        },
      });
      return JSON.parse(response[2]).result;
    };
    try {
      const read = await call(1, {
        action: "read",
        filePath: "/allowed/source.md",
      });
      assert.isUndefined(read.isError, JSON.stringify(read));
      assert.equal(
        JSON.parse(read.content[0].text).result.text,
        "Standalone evidence",
      );
      const write = await call(2, {
        action: "write",
        filePath: "/allowed/output.md",
        content: "Agent approved",
      });
      assert.isUndefined(write.isError, JSON.stringify(write));
      assert.equal(
        JSON.parse(write.content[0].text).actionReceipts[0].verification,
        "verified",
      );
      assert.equal(
        new TextDecoder().decode(files.get("/allowed/output.md")),
        "Agent approved",
      );
    } finally {
      (globalThis as any).IOUtils = originalIO;
    }
  });

  it("allows a read-only standalone command with command access but writes disabled", async function () {
    prefStore.set(
      "extensions.zotero.llmforzotero.externalMcpCommandsEnabled",
      false,
    );
    let executed = 0;
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    const tool = createWriteTool("run_command");
    tool.planInvocation = async () =>
      readOnlyInvocationPlan({
        mechanism: "shell",
        domains: ["local_execution"],
        reason: "The command only inspects host state.",
      });
    tool.execute = async () => {
      executed++;
      return { content: { stdout: "evidence" }, effect: "none" };
    };
    registry.register(tool);
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });

    const response = await invokeMcpEndpoint({
      token: getOrCreateZoteroMcpBearerToken(),
      body: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "run_command",
          arguments: { command: "pwd" },
        },
      },
    });
    const result = JSON.parse(response[2]).result;
    assert.isUndefined(result.isError, JSON.stringify(result));
    assert.equal(executed, 1);
  });

  it("delegates integrated Codex commands without a Zotero opt-in", async function () {
    let executed = 0;
    let reviews = 0;
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    const tool = createWriteTool("run_command");
    tool.planInvocation = async () =>
      readOnlyInvocationPlan({
        mechanism: "shell",
        domains: ["local_execution"],
        reason: "The command only inspects host state.",
      });
    tool.execute = async () => {
      executed++;
      return { content: { stdout: "evidence" }, effect: "none" };
    };
    registry.register(tool);
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const scoped = registerScopedZoteroMcpScope({
      runtimeAuthority: "codex",
      conversationKey: 451,
      libraryID: 1,
      kind: "global",
      requestInteraction: async () => {
        reviews++;
        return { approved: true };
      },
    });

    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
        body: {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "run_command",
            arguments: { command: "pwd" },
          },
        },
      });
      const result = JSON.parse(response[2]).result;
      assert.isUndefined(result.isError, JSON.stringify(result));
      assert.equal(executed, 1);
      assert.equal(reviews, 0);
    } finally {
      scoped.clear();
    }
  });

  it("ignores obsolete command permissions changed during preparation", async function () {
    const commandPref =
      "extensions.zotero.llmforzotero.externalMcpCommandsEnabled";
    prefStore.set(commandPref, true);
    let executed = 0;
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    const tool = createWriteTool("run_command");
    tool.planInvocation = async () => {
      prefStore.set(commandPref, false);
      return readOnlyInvocationPlan({
        mechanism: "shell",
        domains: ["local_execution"],
        reason: "The command only inspects host state.",
      });
    };
    tool.execute = async () => {
      executed++;
      return { content: { stdout: "evidence" }, effect: "none" };
    };
    registry.register(tool);
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const scoped = registerScopedZoteroMcpScope({
      runtimeAuthority: "codex",
      conversationKey: 452,
      libraryID: 1,
      kind: "global",
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
            name: "run_command",
            arguments: { command: "pwd" },
          },
        },
      });
      const result = JSON.parse(response[2]).result;
      assert.isUndefined(result.isError, JSON.stringify(result));
      assert.equal(executed, 1);
    } finally {
      scoped.clear();
    }
  });

  for (const mode of ["safe", "auto", "yolo"]) {
    for (const integrated of [false, true]) {
      for (const name of [
        "collection_update",
        "library_import",
        "library_update",
        "note_write",
        "attachment_update",
        "library_delete",
        "zotero_script",
      ]) {
        it(`delegates ${name} approval in ${mode} (${integrated ? "integrated" : "standalone"})`, async function () {
          prefStore.set(
            "extensions.zotero.llmforzotero.originalAgentPermissionMode",
            mode,
          );
          prefStore.set(
            "extensions.zotero.llmforzotero.externalMcpWritesEnabled",
            false,
          );
          let executed = 0;
          const registry = new AgentToolRegistry(
            new ActionContractService({ getItem: () => null } as never),
          );
          const tool = createWriteTool(name);
          tool.createPendingAction = async () => {
            throw new Error("Duplicate permission review");
          };
          tool.execute = async (_input, context) => {
            executed++;
            assert.equal(context.executionAuthority, "external_runtime");
            assert.isNotEmpty(context.runId);
            assert.equal(context.request.libraryID, 1);
            assert.equal(
              context.request.executionContext?.permissionOwner,
              "external_runtime",
            );
            assert.equal(context.request.executionContext?.chatLibraryID, 1);
            return { content: { applied: true }, effect: "applied" };
          };
          registry.register(tool);
          registerMcpServer({
            toolRegistry: registry,
            zoteroGateway: {} as never,
          });
          const scope = integrated
            ? registerScopedZoteroMcpScope({
                conversationKey: 430,
                libraryID: 1,
                kind: "global",
                runtimeAuthority: "codex",
                requestInteraction: async () => {
                  throw new Error("Duplicate host approval");
                },
              })
            : undefined;
          try {
            const response = await invokeMcpEndpoint({
              token: getOrCreateZoteroMcpBearerToken(),
              headers: scope
                ? { [ZOTERO_MCP_SCOPE_HEADER]: scope.token }
                : undefined,
              body: {
                jsonrpc: "2.0",
                id: 430,
                method: "tools/call",
                params: {
                  name,
                  arguments: {
                    libraryID: 1,
                    action: "create",
                    name: "Issue 430",
                  },
                },
              },
            });
            const payload = JSON.parse(response[2]);
            assert.isUndefined(payload.result.isError, JSON.stringify(payload));
            assert.equal(executed, 1);
          } finally {
            scope?.clear();
          }
        });
      }
    }
  }

  for (const scenario of [
    "audit failure",
    "changed payload",
    "planning turn",
    "aborted turn",
    "partial effect",
    "completion audit failure",
    "native read-only error",
  ]) {
    it(`preserves delegated execution integrity: ${scenario}`, async function () {
      prefStore.set(
        "extensions.zotero.llmforzotero.externalMcpWritesEnabled",
        true,
      );
      let executed = 0;
      let assessments = 0;
      const registry = new AgentToolRegistry(
        new ActionContractService({ getItem: () => null } as never),
      );
      const tool = createWriteTool("collection_update");
      tool.planInvocation = async () => {
        assessments++;
        if (scenario === "aborted turn") scoped?.clear();
        return stateChangeInvocationPlan({
          domains: ["zotero_library"],
          effects: ["create"],
          targets: [
            scenario === "changed payload" && assessments > 1
              ? "collection:2"
              : "collection:1",
          ],
          reversibility: "full",
          reason: "Concrete collection change",
        });
      };
      tool.execute = async () => {
        executed++;
        if (scenario === "native read-only error")
          throw new Error("Library is read-only");
        return {
          content: { applied: true },
          effect: scenario === "partial effect" ? "partial" : "applied",
        };
      };
      registry.register(tool);
      registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
      const db = Zotero.DB as unknown as ChangeJournalTestDb;
      db.failWhen = (_sql, params) =>
        params.includes(
          scenario === "completion audit failure"
            ? "external_execution_completed"
            : scenario === "audit failure"
              ? "external_authorization_prepared"
              : "never-fail",
        )
          ? new Error("Audit disk failure")
          : null;
      const controller = new AbortController();
      const scoped =
        scenario === "planning turn" || scenario === "aborted turn"
          ? registerScopedZoteroMcpScope({
              runtimeAuthority: "claude",
              conversationKey: 430,
              kind: "global",
              libraryID: 1,
              ...(scenario === "planning turn"
                ? { planContext: { phase: "planning" } as never }
                : {}),
              signal: controller.signal,
            })
          : undefined;

      try {
        const response = await invokeMcpEndpoint({
          token: getOrCreateZoteroMcpBearerToken(),
          headers: scoped
            ? { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token }
            : undefined,
          body: {
            jsonrpc: "2.0",
            id: 430,
            method: "tools/call",
            params: { name: "collection_update", arguments: { libraryID: 1 } },
          },
        });
        const result = JSON.parse(response[2]).result;
        const success =
          scenario === "partial effect" ||
          scenario === "completion audit failure";
        assert.equal(Boolean(result.isError), !success, JSON.stringify(result));
        assert.equal(
          executed,
          success || scenario === "native read-only error" ? 1 : 0,
        );
        if (scenario === "partial effect")
          assert.equal(JSON.parse(result.content[0].text).effect, "partial");
      } finally {
        scoped?.clear();
      }
    });
  }

  it("retains delegated authority through nested registry execution", async function () {
    prefStore.set(
      "extensions.zotero.llmforzotero.externalMcpWritesEnabled",
      true,
    );
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    const child = createWriteTool("child_write");
    child.createPendingAction = async () => {
      throw new Error("Nested duplicate approval");
    };
    child.execute = async (_input, context) => {
      assert.equal(context.executionAuthority, "external_runtime");
      return { content: { childApplied: true }, effect: "applied" };
    };
    registry.register(child);
    const outer = createWriteTool("collection_update");
    outer.execute = async (_input, context) => {
      const childResult = await registry.prepareExecution(
        { id: "child", name: "child_write", arguments: {} },
        context,
        {
          callerKind: "model",
          forceConfirmation: true,
          ...context.nestedExecutionOptions,
        },
      );
      assert.equal(childResult.kind, "result");
      if (childResult.kind !== "result")
        throw new Error("Unexpected child review");
      assert.isTrue(
        childResult.execution.result.ok,
        JSON.stringify(childResult),
      );
      return {
        content: childResult.execution.result.content,
        effect: "applied",
      };
    };
    registry.register(outer);
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const response = await invokeMcpEndpoint({
      token: getOrCreateZoteroMcpBearerToken(),
      body: {
        jsonrpc: "2.0",
        id: 430,
        method: "tools/call",
        params: { name: "collection_update", arguments: {} },
      },
    });
    const payload = JSON.parse(response[2]);
    assert.isUndefined(payload.result.isError, JSON.stringify(payload));
  });

  it("isolates concurrent standalone writes and freezes each library", async function () {
    prefStore.set(
      "extensions.zotero.llmforzotero.externalMcpWritesEnabled",
      true,
    );
    const contexts: Array<{
      runId?: string;
      libraryID: number;
      conversationKey: number;
      userText: string;
    }> = [];
    let entered!: () => void;
    let release!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const writesMayFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    const tool = createWriteTool("collection_update");
    tool.execute = async (_input, context) => {
      contexts.push({
        runId: context.runId,
        libraryID: context.request.libraryID,
        conversationKey: context.request.conversationKey,
        userText: context.request.userText,
      });
      if (contexts.length === 1) entered();
      else release();
      await writesMayFinish;
      return {
        content: { libraryID: context.request.libraryID },
        effect: "applied",
      };
    };
    registry.register(tool);
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const unrelated = registerScopedZoteroMcpScope({
      runtimeAuthority: "codex",
      libraryID: 99,
      conversationKey: 999,
      kind: "global",
      userText: "Unrelated private turn",
    });
    const call = () =>
      invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        body: {
          jsonrpc: "2.0",
          id: 430,
          method: "tools/call",
          params: { name: "collection_update", arguments: {} },
        },
      });
    try {
      selectedLibraryID = 1;
      const first = call();
      await firstEntered;
      selectedLibraryID = 2;
      const second = call();
      const results = await Promise.all([first, second]);
      for (const response of results)
        assert.isUndefined(JSON.parse(response[2]).result.isError);
      assert.deepEqual(
        contexts.map((value) => value.libraryID),
        [1, 2],
      );
      assert.equal(
        contexts[0].runId,
        contexts[1].runId,
        "Both writes belong to the same scope-less session",
      );
      assert.isTrue(
        contexts.every(
          (value) => value.conversationKey === 0 && value.userText === "",
        ),
      );
    } finally {
      release();
      unrelated.clear();
    }
  });

  it("gives a scope-less client one run identity for the server's lifetime", async function () {
    const observed: Array<string | undefined> = [];
    const registry = new AgentToolRegistry();
    const tool = createReadTool("library_read");
    tool.execute = async (_input, context) => {
      observed.push(context.runId);
      return { ok: true };
    };
    registry.register(tool);
    const call = (id: number, scopeToken?: string) =>
      invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: scopeToken
          ? { [ZOTERO_MCP_SCOPE_HEADER]: scopeToken }
          : undefined,
        // Distinct arguments keep the read-dedupe cache out of the way.
        body: {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "library_read", arguments: { call: id } },
        },
      });

    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    for (const response of [await call(1), await call(2)])
      assert.isUndefined(JSON.parse(response[2]).result.isError, response[2]);
    assert.isNotEmpty(observed[0]);
    assert.equal(
      observed[1],
      observed[0],
      "A document finalized in one call must still be owned by the run that saves it in the next",
    );

    const scope = registerScopedZoteroMcpScope({
      conversationKey: 4460,
      libraryID: 1,
      kind: "global",
      runtimeAuthority: "codex",
      runId: "scoped-run",
    });
    try {
      await call(3, scope.token);
      assert.equal(observed[2], "scoped-run");
    } finally {
      scope.clear();
    }

    unregisterMcpServer();
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    await call(4);
    assert.notEqual(
      observed[3],
      observed[0],
      "A new server instance starts a new scope-less run",
    );
  });

  it("lets a scope-less client finalize more than one document", async function () {
    const zotero = globalThis.Zotero as unknown as { DB: unknown };
    const journalDb = zotero.DB;
    const db = new DatabaseSync(":memory:");
    zotero.DB = {
      queryAsync: async (sql: string, params: unknown[] = []) => {
        const statement = db.prepare(sql);
        const values = params.map((value) =>
          value === undefined ? null : value,
        ) as never[];
        if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql))
          return statement.all(...values);
        statement.run(...values);
        return [];
      },
      executeTransaction: async (task: () => Promise<unknown>) => {
        db.exec("BEGIN");
        try {
          const result = await task();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    };
    try {
      await initPlanDocumentStore();
      const registry = new AgentToolRegistry();
      registry.register(createSubmitDocumentTool({} as never));
      registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
      const submit = async (id: number, title: string, markdown: string) => {
        const response = await invokeMcpEndpoint({
          token: getOrCreateZoteroMcpBearerToken(),
          body: {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: {
              name: "submit_document",
              arguments: {
                title,
                markdown,
                citations: [],
                quotes: [],
                assets: [],
                groundingReviewed: "passed",
                groundingIssues: [],
              },
            },
          },
        });
        const payload = JSON.parse(response[2]);
        assert.isUndefined(payload.result?.isError, response[2]);
        const body = JSON.parse(payload.result.content[0].text);
        assert.isTrue(body.ok, response[2]);
        return body.result as {
          documentId: string;
          contentHash: string;
          visibleMarkdown: string;
        };
      };

      const first = await submit(1, "First", "# First\n\nThe first document.");
      const second = await submit(
        2,
        "Second",
        "# Second\n\nThe second document.",
      );

      assert.notEqual(
        second.documentId,
        first.documentId,
        "A second submission must not hand back the first document",
      );
      assert.notEqual(second.contentHash, first.contentHash);
      assert.include(second.visibleMarkdown, "The second document.");
    } finally {
      zotero.DB = journalDb;
      db.close();
    }
  });

  it("executes standalone writes without an opt-in", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    let executed = 0;
    const tool = createWriteTool("collection_update");
    tool.execute = async () => {
      executed++;
      return { content: { applied: true }, effect: "applied" };
    };
    registry.register(tool);
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const response = await invokeMcpEndpoint({
      token: getOrCreateZoteroMcpBearerToken(),
      body: {
        jsonrpc: "2.0",
        id: 430,
        method: "tools/call",
        params: {
          name: "collection_update",
          arguments: { libraryID: 1, action: "create", name: "Denied" },
        },
      },
    });
    assert.isUndefined(JSON.parse(response[2]).result.isError, response[2]);
    assert.equal(executed, 1);
  });

  it("uses Zotero's configured HTTP port and rejects unauthenticated calls", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
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
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
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
    assert.include(writeTool.description, "native runtime permission profile");
    const fileTool = payload.result.tools.find(
      (tool: { name: string }) => tool.name === "file_io",
    );
    assert.include(fileTool.description, "all paths accessible to Zotero");
    assert.include(fileTool.description, "calling agent owns approval");
    const trashTool = payload.result.tools.find(
      (tool: { name: string }) => tool.name === "library_delete",
    );
    assert.deepEqual(trashTool.annotations, {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
    });
  });

  it("shows ordinary collaboration tools without a predicted outcome", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register(createReadTool("library_search"));
    registry.register(createReadTool("submit_document"));
    registry.register(createReadTool("request_user_input"));
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const ordinary = registerScopedZoteroMcpScope({
      conversationKey: 7001,
      libraryID: 1,
      kind: "global",
      requestInteraction: async () => ({ approved: false }),
    });
    const required = registerScopedZoteroMcpScope({
      conversationKey: 7002,
      libraryID: 1,
      kind: "global",
      documentOutcomePolicy: {
        required: true,
        documentKind: "literature_review",
        integrityPolicy: "research_grounded",
        trigger: "literature_review_skill",
      },
    });
    const token = getOrCreateZoteroMcpBearerToken();
    try {
      const listedNames = async (scopeToken: string) => {
        const response = await invokeMcpEndpoint({
          token,
          headers: { [ZOTERO_MCP_SCOPE_HEADER]: scopeToken },
          body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        });
        return JSON.parse(response[2]).result.tools.map(
          (tool: { name: string }) => tool.name,
        );
      };
      assert.include(await listedNames(ordinary.token), "submit_document");
      assert.include(await listedNames(ordinary.token), "request_user_input");
      assert.include(await listedNames(required.token), "submit_document");
    } finally {
      ordinary.clear();
      required.clear();
    }
  });

  it("preserves workflow continuation instructions and host progress across MCP", async function () {
    const registry = new AgentToolRegistry();
    const tool = createReadTool("library_read");
    const checkpoint = {
      reason: "research_batch_durable" as const,
      instruction: "Record the remaining manifest, then verify coverage.",
    };
    const event = {
      type: "plan_execution_updated",
      ledger: { executionId: "progress" },
    } as any;
    const published: unknown[] = [];
    tool.execute = async (_input, context) => {
      await context.publishPlanEvent?.(event);
      return {
        content: { durablePapers: 1 },
        continuationCheckpoint: checkpoint,
      };
    };
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    registry.register(tool);
    const scope = registerScopedZoteroMcpScope({
      conversationKey: 7003,
      libraryID: 1,
      kind: "global",
      publishHostEvent: async (value) => {
        published.push(value);
      },
    });
    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scope.token },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "library_read", arguments: {} },
        },
      });
      const payload = JSON.parse(
        JSON.parse(response[2]).result.content[0].text,
      );
      assert.deepEqual(payload.continuationCheckpoint, checkpoint);
      assert.deepEqual(published, [event]);
    } finally {
      scope.clear();
    }
  });

  it("gives native Plan the same research procedure as the local agent", async function () {
    const registry = new AgentToolRegistry();
    const research = createResearchUpdateTool({} as never);
    registry.register(research);
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const scope = registerScopedZoteroMcpScope({
      conversationKey: 7004,
      libraryID: 1,
      kind: "global",
      planContext: {
        phase: "planning",
        planId: "procedure",
        revision: 1,
        nativePlanning: { attemptId: "attempt" },
      } as any,
    });
    try {
      const response = await invokeMcpEndpoint({
        token: getOrCreateZoteroMcpBearerToken(),
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scope.token },
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      const tool = JSON.parse(response[2]).result.tools.find(
        (entry: any) => entry.name === "research_update",
      );
      assert.include(tool.description, research.guidance!.instruction);
      // Codex code-mode declarations can collapse deep nested objects to
      // `unknown`. The discoverable description must retain their contract.
      assert.include(tool.description, JSON.stringify(tool.inputSchema));
    } finally {
      scope.clear();
    }
  });

  it("keeps Codex direct-path PDF turns on the metadata/write MCP surface", async function () {
    let executionCount = 0;
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
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
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
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
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
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
    assert.equal(content.ok, true, JSON.stringify(content));
    assert.deepEqual(content.result, {
      name: "library_search",
      input: { entity: "items" },
    });
  });

  it("blocks exact, implicit, and same-parent sibling reads for a raw PDF", async function () {
    let executionCount = 0;
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
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
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
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
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
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
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
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
      const registry = new AgentToolRegistry(
        new ActionContractService({ getItem: () => null } as never),
      );
      for (const name of ["run_command", "file_io", "zotero_script"]) {
        registry.register({
          effectOperations: testWriteOperations(name),
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
            executionClass: "external_effect",
            requiresConfirmation: false,
          },
          validate: (args) => ({ ok: true, value: args ?? {} }),
          describeAction: () => testWriteDescriptor(name),
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
              access: "library",
              effect: "read",
              script: "return Zotero.Items.get(99).getFilePath();",
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

  it("advertises shared filesystem tools while retaining Zotero scripts", async function () {
    const executed: string[] = [];
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    for (const name of ["run_command", "file_io", "zotero_script"]) {
      registry.register({
        effectOperations: testWriteOperations(name),
        spec: {
          name,
          description: `Native access tool ${name}`,
          inputSchema: { type: "object", additionalProperties: true },
          executionClass: "external_effect",
          requiresConfirmation: false,
        },
        validate: (args) => ({ ok: true, value: args ?? {} }),
        describeAction: () => testWriteDescriptor(name),
        planInvocation: async () =>
          readOnlyInvocationPlan({
            reason: `${name} is read-only in this MCP boundary fixture.`,
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
      runtimeAuthority: "codex",
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
      assert.include(names, "run_command");
      assert.include(names, "file_io");
      assert.include(names, "zotero_script");

      for (const [index, [name, args]] of [
        [
          "zotero_script",
          {
            access: "library",
            effect: "read",
            script: "return 1",
          },
        ],
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
      assert.deepEqual(executed, ["zotero_script"]);
    } finally {
      scope.clear();
    }
  });

  it("emits exact MCP tool activity for native Codex trace fallback", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
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
      workCategory?: string;
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
        workCategory: event.workCategory,
      })),
      [
        {
          requestId: "jsonrpc:tool-call-1",
          phase: "started",
          toolName: "library_read",
          arguments: { sections: ["metadata"] },
          conversationKey: 789,
          libraryID: 999,
          workCategory: "retrieval",
        },
        {
          requestId: "jsonrpc:tool-call-1",
          phase: "completed",
          toolName: "library_read",
          arguments: { sections: ["metadata"] },
          conversationKey: 789,
          libraryID: 999,
          workCategory: "retrieval",
        },
      ],
    );
  });

  it("carries a declared research job onto the completed activity", async function () {
    // The panel used to notice research progress by recognising one tool's
    // name. The tool now declares the job its result advanced, and the row
    // carries it, so the reader of the row needs no list of names.
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      spec: {
        name: "research_update",
        description: "Persist research decisions",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "control",
        workCategory: "planning",
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async () => ({
        content: { ok: true },
        researchJobId: "research-77",
      }),
    } as AgentToolDefinition<unknown, unknown>);
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const scoped = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-dev",
        conversationKey: 790,
        libraryID: 7,
        kind: "paper",
      },
      { token: "research-scope-token" },
    );
    const events: Array<{
      phase: "started" | "completed";
      researchJobId?: string;
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
          id: "research-call-1",
          method: "tools/call",
          params: { name: "research_update", arguments: { operation: "x" } },
        },
      });
      assert.equal(response[0], 200);
    } finally {
      unregister();
      scoped.clear();
    }
    assert.deepEqual(
      events.map((event) => ({
        phase: event.phase,
        researchJobId: event.researchJobId,
      })),
      [
        { phase: "started", researchJobId: undefined },
        { phase: "completed", researchJobId: "research-77" },
      ],
    );
  });

  it("includes paper_read quote citations in completed MCP activity", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      spec: {
        name: "paper_read",
        description: "Read paper",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "read",
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
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      spec: {
        name: "library_search",
        description: "Query library",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "read",
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
    assert.equal(content.ok, true, JSON.stringify(content));
    assert.deepEqual(content.result.input, {
      entity: "items",
      mode: "list",
    });
    assert.deepEqual(content.result.request, {
      libraryID: 42,
      activeItemId: 99,
    });
  });

  it("snapshots the selected Zotero library for headerless MCP reads", async function () {
    selectedLibraryID = 7;
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      spec: {
        name: "library_search",
        description: "Query library",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async (_input, context: AgentToolContext) => ({
        libraryID: context.request.libraryID,
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
          arguments: { entity: "collections", mode: "list", view: "tree" },
        },
      },
    });
    const payload = JSON.parse(response[2]);
    const content = JSON.parse(payload.result.content[0].text);
    assert.equal(content.ok, true, JSON.stringify(content));
    assert.equal(content.result.libraryID, 7);
  });

  it("binds MCP tool context to the exact scoped token", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      spec: {
        name: "paper_read",
        description: "Read paper",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "read",
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

    const scoped = registerScopedZoteroMcpScope({
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
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
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
      assert.equal(content.ok, true, JSON.stringify(content));
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
      scoped.clear();
    }
  });

  it("passes scoped selected, full-text, and pinned paper contexts with source metadata", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      spec: {
        name: "paper_read",
        description: "Read paper",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async (_input, context: AgentToolContext) => ({
        request: {
          turnPaperScope: context.request.turnPaperScope,
          readDirectories:
            context.request.executionContext?.configuredAccess.fileAccess
              ?.readDirectories,
        },
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
      runtimeAuthority: "codex",
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
      assert.equal(content.ok, true, JSON.stringify(content));
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
      assert.deepEqual(content.result.request.readDirectories, [
        "/tmp/mineru-cache/selected",
        "/tmp/mineru-cache/full-text",
        "/tmp/mineru-cache/pinned",
      ]);
    } finally {
      scoped.clear();
    }
  });

  it("passes selected tags to scoped library_retrieve MCP calls", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      spec: {
        name: "library_retrieve",
        description: "Retrieve from library",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "read",
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

    const scoped = registerScopedZoteroMcpScope({
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
        headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
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
      assert.equal(content.ok, true, JSON.stringify(content));
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
      scoped.clear();
    }
  });

  it("rejects mixed canonical and legacy MCP paper scope representations", function () {
    assert.throws(
      () =>
        registerScopedZoteroMcpScope({
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
        registerScopedZoteroMcpScope({
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

  it("uses the active paper when an empty target normalizes to omitted", async function () {
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
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register(
      createPaperReadTool(
        {
          ensurePaperContext: async (paperContext: unknown) => {
            ensuredPaper = paperContext;
          },
        } as never,
        withImageRetrieval({
          retrieveEvidence: async () => [
            {
              itemId: paper.itemId,
              contextItemId: paper.contextItemId,
              title: paper.title,
              text: "method evidence",
            },
          ],
        }) as never,
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
      const listedSchema = listedPaperRead.inputSchema as Record<
        string,
        unknown
      >;
      assert.equal(listedSchema.type, "object");
      for (const keyword of ["oneOf", "allOf", "anyOf"]) {
        assert.notProperty(listedSchema, keyword);
      }
      const listedProperties = listedSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      assert.isArray(listedProperties.target.anyOf);
      assert.deepEqual(
        (listedProperties.targets.items as Record<string, unknown>).required,
        ["itemId"],
      );

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
      assert.isNotTrue(payload.result.isError, JSON.stringify(payload.result));
      assert.deepEqual(ensuredPaper, paper);
    } finally {
      scoped.clear();
    }
  });

  it("deduplicates repeated same-turn semantic read calls", async function () {
    let executeCount = 0;
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      spec: {
        name: "paper_read",
        description: "Read paper",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "read",
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

  it("keeps explicit library IDs distinct in scoped read deduplication", async function () {
    let executeCount = 0;
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      spec: {
        name: "library_search",
        description: "Query library",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async (_input, context: AgentToolContext) => {
        executeCount += 1;
        return { executeCount, libraryID: context.request.libraryID };
      },
    });
    registerMcpServer({
      toolRegistry: registry,
      zoteroGateway: {} as never,
    });
    const scoped = registerScopedZoteroMcpScope(
      {
        profileSignature: "profile-library-dedupe",
        conversationKey: 790,
        libraryID: 1,
        kind: "global",
      },
      { token: "library-dedupe-scope-token" },
    );

    try {
      const invokeForLibrary = (libraryID: number, id: number) =>
        invokeMcpEndpoint({
          token: getOrCreateZoteroMcpBearerToken(),
          headers: { [ZOTERO_MCP_SCOPE_HEADER]: scoped.token },
          body: {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: {
              name: "library_search",
              arguments: { entity: "items", mode: "list", libraryID },
            },
          },
        });
      const firstContent = JSON.parse(
        JSON.parse((await invokeForLibrary(1, 1))[2]).result.content[0].text,
      );
      const secondContent = JSON.parse(
        JSON.parse((await invokeForLibrary(2, 2))[2]).result.content[0].text,
      );

      assert.deepEqual(firstContent.result, {
        executeCount: 1,
        libraryID: 1,
      });
      assert.deepEqual(secondContent.result, {
        executeCount: 2,
        libraryID: 2,
      });
      assert.notProperty(secondContent, "duplicate");
      assert.equal(executeCount, 2);
    } finally {
      scoped.clear();
    }
  });

  it("rejects conflicting top-level and library_retrieve scope IDs", async function () {
    let executed = false;
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      spec: {
        name: "library_retrieve",
        description: "Retrieve from library",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async () => {
        executed = true;
        return { ok: true };
      },
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
          name: "library_retrieve",
          arguments: {
            query: "methods",
            libraryID: 7,
            scope: { libraryID: 8 },
          },
        },
      },
    });
    const payload = JSON.parse(response[2]);
    assert.match(payload.error.message, /conflicting.*library/i);
    assert.isFalse(executed);
  });

  it("does not deduplicate semantic reads without a scoped MCP token", async function () {
    let executeCount = 0;
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      spec: {
        name: "paper_read",
        description: "Read paper",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "read",
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
  });

  it("clears semantic read dedupe when the scoped MCP turn is cleared", async function () {
    let executeCount = 0;
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      spec: {
        name: "paper_read",
        description: "Read paper",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "read",
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
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      spec: {
        name: "library_search",
        description: "Search library",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      execute: async (input) => {
        readExecuteCount += 1;
        return { readExecuteCount, input };
      },
    });
    registry.register({
      effectOperations: ["settings_update"],
      spec: {
        name: "library_update",
        description: "Update library",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      describeAction: () => testWriteDescriptor("library_update"),
      planInvocation: async () =>
        stateChangeInvocationPlan({
          domains: ["zotero_library"],
          effects: ["modify"],
          reversibility: "full",
          reason: "The library update mutates Zotero state.",
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
        actionContract: actionContractFixture("settings_update"),
        runtimeAuthority: "codex",
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

  it("binds MCP tool context from the scoped header", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      spec: {
        name: "library_search",
        description: "Query library",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "read",
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
      assert.equal(content.ok, true, JSON.stringify(content));
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
    }
  });

  it("keeps raw-PDF restrictions token-local for headerless standalone reads", async function () {
    let executionCount = 0;
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    const paperRead = createReadTool("paper_read");
    paperRead.execute = async (input, context) => {
      executionCount += 1;
      return { input, conversationKey: context.request.conversationKey };
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
      const standalonePayload = JSON.parse(activeOrdinaryResponse[2]);
      assert.isNotTrue(standalonePayload.result.isError);
      assert.equal(
        JSON.parse(standalonePayload.result.content[0].text).result
          .conversationKey,
        0,
      );
      assert.equal(executionCount, 1);
    } finally {
      rawScope.clear();
    }
  });

  it("rejects full reads from Claude-only MCP scopes before loading the PDF", async function () {
    const paperContext = {
      itemId: 91,
      contextItemId: 92,
      title: "Claude-only paper",
      libraryID: 1,
    };
    let ensurePaperContextCount = 0;
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
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

  it("does not add a plugin-side prompt to a native MCP read", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      spec: {
        name: "paper_read",
        description: "Read attachment",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "read",
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
      assert.equal(content.ok, true, JSON.stringify(content));
      assert.deepEqual(content.result, {
        delivered: true,
        input: { attachFile: true },
      });
    } finally {
      scoped.clear();
    }
  });

  it("accepts native-runtime authorization without a duplicate Zotero prompt", async function () {
    let executeCount = 0;
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      effectOperations: ["settings_update"],
      spec: {
        name: "library_update",
        description: "Apply tags",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      describeAction: () => testWriteDescriptor("library_update"),
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
        actionContract: actionContractFixture("settings_update"),
        runtimeAuthority: "codex",
      },
      { token: "deny-scope-token" },
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
      assert.isUndefined(payload.result.isError);
      assert.equal(content.ok, true, JSON.stringify(content));
      assert.deepEqual(content.result, { applied: true });
      assert.equal(executeCount, 1);
      assert.isNotEmpty(content.actionReceipts);
      assert.isString(
        content.actionReceipts[0].obligationId,
        "Integrated receipts must still update the host workflow progress",
      );
    } finally {
      scoped.clear();
    }
  });

  it("executes standalone host tools without a Zotero grant", async function () {
    const executed: string[] = [];
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    for (const name of ["run_command", "file_io"]) {
      registry.register({
        effectOperations: testWriteOperations(name),
        spec: {
          name,
          description: `Policy-controlled tool ${name}`,
          inputSchema: { type: "object", additionalProperties: true },
          executionClass: "external_effect",
          requiresConfirmation: true,
        },
        validate: (args) => ({ ok: true, value: args ?? {} }),
        describeAction: () => testWriteDescriptor(name),
        planInvocation: async () =>
          readOnlyInvocationPlan({
            mechanism: name === "run_command" ? "shell" : "none",
            domains: ["local_execution"],
            reason: `${name} is a read-only native-boundary fixture.`,
          }),
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
        assert.equal(response[0], 200);
        const payload = JSON.parse(response[2]);
        assert.isUndefined(payload.result.isError, JSON.stringify(payload));
      }
      assert.deepEqual(executed, ["run_command", "file_io"]);
    } finally {
      scoped.clear();
    }
  });

  it("creates standalone notes through the note_write review card path", async function () {
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      effectOperations: ["settings_update"],
      spec: {
        name: "note_write",
        description: "Edit or create notes",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      describeAction: () => testWriteDescriptor("note_write"),
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
        actionContract: actionContractFixture("settings_update"),
        requestInteraction: async (action) => {
          assert.equal(action.title, "Review new note");
          return { approved: true };
        },
        runtimeAuthority: "codex",
      },
      { token: "note-scope-token" },
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
      assert.equal(content.ok, true, JSON.stringify(content));
      assert.deepEqual(content.result, {
        status: "created",
        noteId: 99,
        target: "standalone",
        noteContent: "Draft standalone note",
      });
    } finally {
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
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      effectOperations: ["settings_update"],
      spec: {
        name: "note_write",
        description: "Edit active note",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      describeAction: () => testWriteDescriptor("note_write"),
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
        actionContract: actionContractFixture("settings_update"),
        requestInteraction: async (action) => {
          assert.equal(action.fields[0].type, "diff_preview");
          return { approved: true };
        },
        runtimeAuthority: "codex",
      },
      { token: "active-note-scope-token" },
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
      assert.equal(content.ok, true, JSON.stringify(content));
      assert.deepEqual(content.result, {
        status: "updated",
        noteId: 501,
      });
    } finally {
      scoped.clear();
    }
  });

  it("keeps a conversation scope token usable across turns and rebinds it to the newest turn", async function () {
    let seenActiveItemId: number | undefined;
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      spec: {
        name: "library_read",
        description: "Read an item",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "read",
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
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      effectOperations: ["settings_update"],
      spec: {
        name: "library_update",
        description: "Apply tags",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      describeAction: () => testWriteDescriptor("library_update"),
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
  });

  it("runs zotero_script through MCP without forcing a confirmation", async function () {
    let executed = false;
    const registry = new AgentToolRegistry(
      new ActionContractService({ getItem: () => null } as never),
    );
    registry.register({
      effectOperations: ["zotero_script_execute"],
      spec: {
        name: "zotero_script",
        description: "Run Zotero script",
        inputSchema: { type: "object", additionalProperties: true },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args ?? {} }),
      describeAction: () => testWriteDescriptor("zotero_script"),
      planInvocation: async () =>
        stateChangeInvocationPlan({
          mechanism: "zotero_script",
          domains: ["privileged_zotero"],
          effects: ["modify"],
          reversibility: "full",
          reason: "The Zotero script fixture mutates Zotero state.",
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
        actionContract: actionContractFixture("zotero_script_execute"),
        conversationKey: 5020,
        libraryID: 1,
        kind: "global",
        runtimeAuthority: "codex",
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
              access: "privileged",
              effect: "write",
              description: "Run directly",
              script:
                "env.addInverse({ version: 1, kind: 'library_operations', operations: [] });",
            },
          },
        },
      });
      const payload = JSON.parse(response[2]);
      const content = JSON.parse(payload.result.content[0].text);
      assert.equal(content.ok, true, JSON.stringify(content));
      assert.deepEqual(content.result, { status: "ran" });
      assert.isTrue(executed);
    } finally {
      scoped.clear();
    }
  });
});

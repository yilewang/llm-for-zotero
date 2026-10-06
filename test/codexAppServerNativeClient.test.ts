import { runCodexAppServerNativeTurn } from "./helpers/preparedNativeTurn";
import {
  createNativeLifecycleTestProcess,
  installDirectPathTestPrefs,
} from "./helpers/codexNativeLifecycle";
import { buildCodexNativeSkillRequest } from "../src/codexAppServer/nativeSkills";
import type { AgentRuntimeRequest } from "../src/agent/types";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { CONNECTED_RUNTIME_EFFECT_WORK_CATEGORY } from "../src/agent/workCategory";
import {
  buildCodexNativeApprovalPendingAction,
  buildCodexNativeApprovalResponseFromResolution,
  buildCodexNativeScopedMcpScopeForTests,
  describeCodexNativeApprovalEffect,
  buildCodexNativeVisibleTurnContextBlockForTests,
  buildZoteroEnvironmentManifest,
  compactCodexAppServerConversation,
  compactCodexAppServerThread,
  forkCodexAppServerThread,
  isDeniedTrustedZoteroMcpGuardianReviewForTests,
  registerNativeApprovalRequestHandlersForTests,
  registerNativeGuardianReviewHandlersForTests,
  listCodexAppServerModels,
  NO_CODEX_APP_SERVER_THREAD_TO_COMPACT_MESSAGE,
  resolveCodexNativeApprovalRequest,
  resolveSafeCodexNativeApprovalRequest,
  buildCodexMcpToolActivityEvent,
  buildCodexNativeEffectActivityEvent,
  createCodexNativeMcpCallCorrelatorForTests,
  resetCodexNativePathSafetyStateForTests,
  runCodexAppServerNativeTurn as runPreparedNativeTurn,
} from "../src/codexAppServer/nativeClient";
import {
  buildCodexNativePriorReadContextBlock,
  clearCodexNativeReadLedger,
  recordCodexNativeReadActivity,
} from "../src/codexAppServer/nativeContextLedger";
import {
  CodexAppServerProcess,
  destroyCachedCodexAppServerProcess,
} from "../src/utils/codexAppServerProcess";
import {
  invokeRegisteredZoteroMcpEndpoint,
  registerMcpServer,
  registerScopedZoteroMcpScope,
  getZoteroMcpServerName,
  ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
  resolveConversationScopeToken,
  unregisterMcpServer,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../src/agent/mcp/server";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createFileIOTool } from "../src/agent/tools/write/fileIO";
import { createRunCommandTool } from "../src/agent/tools/write/runCommand";
import { getCodexProfileSignature } from "../src/codexAppServer/constants";
import { getUserSkillsRuntimeRootDir } from "../src/agent/skills/userSkills";
import { PAPER_CITATION_CONTRACT } from "../src/shared/instructionContracts";
import {
  BUILTIN_SKILL_FILES,
  parseSkill,
  setUserSkills,
} from "../src/agent/skills";

const here = dirname(fileURLToPath(import.meta.url));

function createDirectPdfSelection(params: {
  itemId: number;
  contextItemId: number;
  title: string;
  name: string;
  absolutePath: string;
}) {
  return {
    paper: {
      itemId: params.itemId,
      contextItemId: params.contextItemId,
      title: params.title,
      attachmentTitle: params.name,
      contentSourceMode: "pdf" as const,
    },
    document: {
      kind: "local_pdf" as const,
      sourceKey: `zotero-pdf:${params.itemId}:${params.contextItemId}` as const,
      itemId: params.itemId,
      contextItemId: params.contextItemId,
      title: params.title,
      name: params.name,
      mimeType: "application/pdf" as const,
      absolutePath: params.absolutePath,
    },
  };
}

describe("Codex app-server native client", function () {
  it("sends an ordinary turn with no Zotero plan context", async function () {
    const requests: Array<{ method: string; params: Record<string, any> }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["ordinary-thread"],
      requests,
      permissionProfilesResult: {
        data: [{ id: ":danger-full-access", description: "Full access" }],
      },
      deltaForTurn: () => "An ordinary answer",
    });
    const restorePrefs = installDirectPathTestPrefs(
      "off",
      ":danger-full-access",
    );
    const originalDB = (globalThis as any).Zotero.DB;
    (globalThis as any).Zotero.DB = { queryAsync: async () => [] };
    const originalSpawn = CodexAppServerProcess.spawn;
    CodexAppServerProcess.spawn = async () => proc;
    const processKey = "native-ordinary-no-plan";
    try {
      await runCodexAppServerNativeTurn({
        scope: {
          conversationKey: 6_000_000_898,
          libraryID: 1,
          kind: "global" as const,
        },
        model: "gpt-5.6",
        messages: [{ role: "user" as const, content: "Explain drift" }],
        processKey,
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => {},
        },
      });
      const [turn] = requests.filter(
        (request) => request.method === "turn/start",
      );
      assert.exists(turn);
      assert.equal(turn.params.collaborationMode.mode, "default");
      assert.isUndefined(
        turn.params.additionalContext?.zotero_plan,
        "plan mode is retired: an ordinary turn names no plan, not even to say none is active",
      );
    } finally {
      destroyCachedCodexAppServerProcess(processKey, proc);
      CodexAppServerProcess.spawn = originalSpawn;
      (globalThis as any).Zotero.DB = originalDB;
      restorePrefs();
    }
  });
  it("does not lose a completed MCP evidence persistence failure before provider finalization", async function () {
    const restorePrefs = installDirectPathTestPrefs();
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = (globalThis as any).Zotero;
    const conversationKey = 6_000_000_191;
    let observed = false;
    let finished: unknown;
    let response: any;
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "library_read",
        description: "Read fixture",
        inputSchema: { type: "object" },
        executionClass: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args }),
      execute: async () => ({ content: { title: "Fixture" } }),
    });
    (globalThis as any).Zotero = {
      ...originalZotero,
      Server: { Endpoints: {} },
      Prefs: {
        ...originalZotero.Prefs,
        get: (key: string) =>
          key.endsWith("codexZoteroMcpBearerToken")
            ? "evidence-test-bearer-0123456789abcdef"
            : originalZotero.Prefs.get(key),
      },
    };
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const processKey = "native-evidence-failure";
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["evidence-thread"],
      requests: [],
      beforeTurnCompleted: async (turnId) => {
        const scope = registerScopedZoteroMcpScope({
          conversationKey,
          runId: turnId,
          conversationGeneration: 0,
          profileSignature: getCodexProfileSignature(),
          libraryID: 1,
          kind: "global",
          model: "gpt-5.6",
        } as any);
        try {
          response = await invokeRegisteredZoteroMcpEndpoint({
            method: "POST",
            data: {
              jsonrpc: "2.0",
              id: 100,
              method: "tools/call",
              params: { name: "library_read", arguments: {} },
            },
            headers: {
              [ZOTERO_MCP_SCOPE_HEADER]: scope.token,
              Authorization: "Bearer evidence-test-bearer-0123456789abcdef",
            },
          });
          await new Promise((resolve) => setTimeout(resolve, 10));
        } finally {
          scope.clear();
        }
      },
    });
    CodexAppServerProcess.spawn = async () => proc;
    let failure = "";
    try {
      await runCodexAppServerNativeTurn({
        scope: {
          conversationKey,
          libraryID: 1,
          kind: "global",
          title: "Read fixture",
        },
        model: "gpt-5.6",
        messages: [{ role: "user", content: "Read fixture" }],
        processKey,
        eventJournal: {
          runId: "host-evidence-run",
          append: async (event) => {
            if (event.type === "codex_tool_activity") {
              observed = true;
              throw new Error("Evidence storage unavailable");
            }
          },
          finish: async (status) => {
            finished = status;
          },
        },
        hooks: {
          loadProviderSessionId: async () => null,
          persistProviderSession: async () => {},
        },
      });
    } catch (error) {
      failure = String(error);
    } finally {
      unregisterMcpServer();
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }
    assert.isTrue(
      observed,
      `MCP activity was not exercised: ${JSON.stringify(response)}`,
    );
    assert.include(failure, "Evidence storage unavailable");
    assert.notEqual(finished, "completed");
  });
  /**
   * Drive one real native turn with Zotero MCP enabled, making one MCP call
   * and announcing the same call as an app-server item, in the given order.
   */
  async function runCorrelatedNativeTurn(order: "mcp_first" | "item_first") {
    const restorePrefs = installDirectPathTestPrefs();
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = (globalThis as never as { Zotero: any }).Zotero;
    const conversationKey =
      order === "mcp_first" ? 6_000_000_310 : 6_000_000_311;
    const bearer = "correlation-test-bearer-0123456789abcdef";
    const registry = new AgentToolRegistry();
    for (const name of ZOTERO_MCP_SAFE_READ_TOOL_NAMES) {
      registry.register({
        spec: {
          name,
          description: `Read fixture ${name}`,
          inputSchema: { type: "object", additionalProperties: true },
          executionClass: "read",
          workCategory: "retrieval",
          requiresConfirmation: false,
        },
        validate: (args) => ({ ok: true, value: args ?? {} }),
        execute: async () => ({ content: { title: "Fixture" } }),
      } as never);
    }
    registry.register(createFileIOTool());
    registry.register(createRunCommandTool());
    (globalThis as never as { Zotero: any }).Zotero = {
      ...originalZotero,
      Server: { Endpoints: {} },
      Libraries: { userLibraryID: 1 },
      Items: { get: () => null },
      Prefs: {
        ...originalZotero.Prefs,
        get: (key: string) => {
          if (key.endsWith(".codexAppServerZoteroMcpToolsEnabled")) return true;
          if (key.endsWith("codexZoteroMcpBearerToken")) return bearer;
          return originalZotero.Prefs.get(key);
        },
      },
    };
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    const serverName = getZoteroMcpServerName(getCodexProfileSignature());
    const scopeToken = resolveConversationScopeToken({
      profileSignature: getCodexProfileSignature(),
      conversationKey,
    });
    const journal: any[] = [];
    const mcpRows: any[] = [];
    const items: any[] = [];
    const processKey = `native-correlation-${order}`;
    const callMcpTool = async () => {
      await invokeRegisteredZoteroMcpEndpoint({
        method: "POST",
        data: {
          jsonrpc: "2.0",
          id: "correlated-call",
          method: "tools/call",
          params: { name: "library_read", arguments: {} },
        },
        headers: {
          [ZOTERO_MCP_SCOPE_HEADER]: scopeToken,
          Authorization: `Bearer ${bearer}`,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: [`correlation-thread-${order}`],
      requests: [],
      onTurn: ({ threadId, turnId, emit }) => {
        void (async () => {
          const emitItem = () =>
            emit({
              method: "item/completed",
              params: {
                threadId,
                turnId,
                item: {
                  type: "mcp_tool_call",
                  id: "call_A",
                  server: serverName,
                  tool: "library_read",
                  arguments: {},
                  status: "completed",
                },
              },
            });
          if (order === "mcp_first") {
            await callMcpTool();
            emitItem();
          } else {
            emitItem();
            await new Promise((resolve) => setTimeout(resolve, 5));
            await callMcpTool();
          }
          emit({
            method: "turn/completed",
            params: { threadId, turn: { id: turnId, status: "completed" } },
          });
        })();
      },
    });
    CodexAppServerProcess.spawn = async () => proc;
    try {
      await runCodexAppServerNativeTurn({
        scope: { conversationKey, libraryID: 1, kind: "global" },
        model: "gpt-5.6",
        messages: [{ role: "user", content: "Read fixture" }],
        processKey,
        eventJournal: {
          runId: "host-correlation-run",
          append: async (event: any) => {
            journal.push(event);
          },
          finish: async () => {},
        },
        onMcpToolActivity: (event) => mcpRows.push(event),
        onItemCompleted: (event) => items.push(event),
        hooks: {
          loadProviderSessionId: async () => null,
          persistProviderSession: async () => {},
        },
      } as never);
    } finally {
      unregisterMcpServer();
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      (globalThis as never as { Zotero: any }).Zotero = originalZotero;
      restorePrefs();
    }
    return { journal, mcpRows, items };
  }

  for (const order of ["mcp_first", "item_first"] as const) {
    it(`stamps one key on both rows of a native Zotero MCP call (${order})`, async function () {
      this.timeout(15000);
      const { journal, mcpRows, items } = await runCorrelatedNativeTurn(order);
      assert.isAtLeast(mcpRows.length, 1, "the MCP observer never fired");
      const item = items.find(
        (entry) => entry.type === "mcp_tool_call" && entry.id === "call_A",
      );
      assert.isDefined(item, "the app-server item never reached the host");
      const key = item.correlationId;
      assert.isString(key, "the item carries no call key");
      for (const row of mcpRows) {
        assert.equal(
          row.correlationId,
          key,
          "both phases of the request carry the item's key",
        );
      }
      const activities = journal.filter(
        (event) => event.type === "codex_tool_activity",
      );
      assert.isAtLeast(activities.length, 1);
      for (const activity of activities) {
        assert.equal(
          activity.itemId,
          key,
          "the journalled row is keyed by the call, not the transport request",
        );
      }
    });
  }
  it("renders exact original PDF paths and identities in selection order", function () {
    const first = createDirectPdfSelection({
      itemId: 10,
      contextItemId: 12,
      title: 'First "quoted" paper',
      name: "first.pdf",
      absolutePath: '/Users/example/Papers/First "quoted" paper.pdf',
    });
    const second = createDirectPdfSelection({
      itemId: 20,
      contextItemId: 22,
      title: "Second paper",
      name: "second.pdf",
      absolutePath: "C:\\\\Research\\\\论文\\\\second.pdf",
    });
    const third = createDirectPdfSelection({
      itemId: 30,
      contextItemId: 32,
      title: "UNC paper",
      name: "third.pdf",
      absolutePath: "\\\\server\\share\\third.pdf",
    });

    const context = buildCodexNativeVisibleTurnContextBlockForTests({
      scope: {
        conversationKey: 6_000_000_040,
        libraryID: 1,
        kind: "global",
      },
      skillContext: {
        pdfPaperContexts: [first.paper, second.paper, third.paper],
        localDocuments: [first.document, second.document, third.document],
      },
    });

    const firstLine = `1. paperKey=1:10:12, sourceKey=${first.document.sourceKey}, title=${JSON.stringify(first.document.title)}, name=${JSON.stringify(first.document.name)}, path=${JSON.stringify(first.document.absolutePath)}`;
    const secondLine = `2. paperKey=1:20:22, sourceKey=${second.document.sourceKey}, title=${JSON.stringify(second.document.title)}, name=${JSON.stringify(second.document.name)}, path=${JSON.stringify(second.document.absolutePath)}`;
    const thirdLine = `3. paperKey=1:30:32, sourceKey=${third.document.sourceKey}, title=${JSON.stringify(third.document.title)}, name=${JSON.stringify(third.document.name)}, path=${JSON.stringify(third.document.absolutePath)}`;
    assert.include(context, firstLine);
    assert.include(context, secondLine);
    assert.include(context, thirdLine);
    assert.isBelow(context.indexOf(firstLine), context.indexOf(secondLine));
    assert.isBelow(context.indexOf(secondLine), context.indexOf(thirdLine));
    assert.include(context, "Read exactly these paths");
    assert.notInclude(context, "raw_pdf_read");
  });

  it("uses exact direct paths on an ephemeral PDF thread and rebuilds a clean thread", async function () {
    const processKey = "native-direct-pdf-clean-rebuild";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-pdf-ephemeral", "thread-clean-persistent"],
      requests,
      deltaForTurn: (turn) => (turn === 1 ? "pdf answer" : "clean answer"),
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("native");
    let storedThreadId: string | undefined = "thread-prior-persistent";
    const persistedThreadIds: string[] = [];
    let clearCount = 0;
    CodexAppServerProcess.spawn = async () => proc;
    const first = createDirectPdfSelection({
      itemId: 10,
      contextItemId: 11,
      title: "PDF A",
      name: "paper-a.pdf",
      absolutePath: "/Users/example/Papers/PDF A/paper-a.pdf",
    });
    const second = createDirectPdfSelection({
      itemId: 20,
      contextItemId: 21,
      title: "PDF B",
      name: "paper-b.pdf",
      absolutePath: "/Users/example/Papers/PDF B/paper-b.pdf",
    });

    try {
      const pdfResult = await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-direct-pdf-clean-rebuild",
          conversationKey: 6_000_000_041,
          libraryID: 1,
          kind: "global",
          title: "Direct PDF test",
        },
        model: "gpt-5.6",
        messages: [
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: "Compare the selected PDFs" },
        ],
        processKey,
        hooks: {
          loadProviderSessionId: async () => storedThreadId,
          clearProviderSessionId: async () => {
            clearCount += 1;
            storedThreadId = undefined;
          },
          persistProviderSessionId: async (threadId) => {
            persistedThreadIds.push(threadId);
            storedThreadId = threadId;
          },
        },
        skillContext: {
          pdfPaperContexts: [first.paper, second.paper],
          localDocuments: [first.document, second.document],
        },
      });
      assert.equal(pdfResult.threadId, "thread-pdf-ephemeral");
      assert.isFalse(pdfResult.resumed);
      assert.equal(clearCount, 1);
      assert.deepEqual(persistedThreadIds, []);

      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-direct-pdf-clean-rebuild",
          conversationKey: 6_000_000_041,
          libraryID: 1,
          kind: "global",
          title: "Direct PDF test",
        },
        model: "gpt-5.6",
        messages: [
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: "Compare the selected PDFs" },
          { role: "assistant", content: "The comparison is complete." },
          { role: "user", content: "Now answer without a PDF" },
        ],
        processKey,
        hooks: {
          loadProviderSessionId: async () => storedThreadId,
          clearProviderSessionId: async () => {
            clearCount += 1;
            storedThreadId = undefined;
          },
          persistProviderSessionId: async (threadId) => {
            persistedThreadIds.push(threadId);
            storedThreadId = threadId;
          },
        },
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    const threadStarts = requests.filter(
      (request) => request.method === "thread/start",
    );
    assert.lengthOf(threadStarts, 2);
    assert.equal(threadStarts[0].params.ephemeral, true);
    assert.equal(threadStarts[0].params.sandbox, "read-only");
    assert.equal(threadStarts[0].params.config?.features?.shell_tool, true);
    assert.notProperty(threadStarts[0].params, "runtimeWorkspaceRoots");
    assert.include(
      threadStarts[0].params.developerInstructions,
      JSON.stringify(first.document.absolutePath),
    );
    assert.include(
      threadStarts[0].params.developerInstructions,
      JSON.stringify(second.document.absolutePath),
    );
    assert.isBelow(
      threadStarts[0].params.developerInstructions.indexOf(
        JSON.stringify(first.document.absolutePath),
      ),
      threadStarts[0].params.developerInstructions.indexOf(
        JSON.stringify(second.document.absolutePath),
      ),
    );
    assert.include(
      threadStarts[0].params.developerInstructions,
      "Raw PDF transport policy",
    );
    assert.notInclude(
      threadStarts[0].params.developerInstructions,
      "raw_pdf_read",
    );
    assert.equal(threadStarts[1].params.ephemeral, false);
    assert.equal(threadStarts[1].params.sandbox, "read-only");
    assert.equal(threadStarts[1].params.config?.features?.shell_tool, false);
    assert.notInclude(
      threadStarts[1].params.developerInstructions,
      first.document.absolutePath,
    );
    assert.notInclude(
      threadStarts[1].params.developerInstructions,
      second.document.absolutePath,
    );
    assert.deepEqual(persistedThreadIds, ["thread-clean-persistent"]);
    assert.isFalse(
      requests.some((request) => request.method === "skills/list"),
    );
    assert.isFalse(
      requests.some((request) => request.method === "thread/resume"),
    );
    const injectedHistory = requests.filter(
      (request) => request.method === "thread/inject_items",
    );
    assert.lengthOf(injectedHistory, 2);
    assert.include(
      JSON.stringify(injectedHistory[0].params.items),
      "Earlier question",
    );
    assert.include(
      JSON.stringify(injectedHistory[0].params.items),
      "Earlier answer",
    );
    assert.notInclude(
      JSON.stringify(injectedHistory[1].params.items),
      first.document.absolutePath,
    );
    assert.notInclude(
      JSON.stringify(injectedHistory[1].params.items),
      second.document.absolutePath,
    );
    assert.deepEqual(
      requests
        .filter((request) => request.method === "turn/start")
        .map((request) => request.params.sandboxPolicy),
      [
        { type: "readOnly", networkAccess: false },
        { type: "readOnly", networkAccess: false },
      ],
    );
    assert.isTrue(
      requests.some(
        (request) =>
          request.method === "thread/archive" &&
          request.params.threadId === "thread-prior-persistent",
      ),
    );
  });

  it("keeps A and B paths isolated across consecutive PDF turns", async function () {
    const processKey = "native-direct-pdf-a-b-isolation";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-pdf-a", "thread-pdf-b"],
      requests,
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs();
    CodexAppServerProcess.spawn = async () => proc;
    const pdfA = createDirectPdfSelection({
      itemId: 100,
      contextItemId: 101,
      title: "PDF A",
      name: "same.pdf",
      absolutePath: "/Users/example/A/same.pdf",
    });
    const pdfB = createDirectPdfSelection({
      itemId: 200,
      contextItemId: 201,
      title: "PDF B",
      name: "same.pdf",
      absolutePath: "/Users/example/B/same.pdf",
    });
    const hooks = {
      loadProviderSessionId: async () => undefined,
      persistProviderSessionId: async () => {
        throw new Error("An ephemeral PDF thread must not be persisted");
      },
    };

    try {
      const resultA = await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-direct-pdf-a-b-isolation",
          conversationKey: 6_000_000_042,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.6",
        messages: [{ role: "user", content: "Read A" }],
        processKey,
        hooks,
        skillContext: {
          pdfPaperContexts: [pdfA.paper],
          localDocuments: [pdfA.document],
        },
      });
      const resultB = await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-direct-pdf-a-b-isolation",
          conversationKey: 6_000_000_042,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.6",
        messages: [
          { role: "user", content: "Read A" },
          { role: "assistant", content: "A read is complete." },
          { role: "user", content: "Read B" },
        ],
        processKey,
        hooks,
        skillContext: {
          pdfPaperContexts: [pdfB.paper],
          localDocuments: [pdfB.document],
        },
      });
      assert.equal(resultA.threadId, "thread-pdf-a");
      assert.equal(resultB.threadId, "thread-pdf-b");
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    const starts = requests.filter(
      (request) => request.method === "thread/start",
    );
    assert.lengthOf(starts, 2);
    assert.equal(starts[0].params.ephemeral, true);
    assert.equal(starts[1].params.ephemeral, true);
    assert.include(
      starts[0].params.developerInstructions,
      JSON.stringify(pdfA.document.absolutePath),
    );
    assert.notInclude(
      starts[0].params.developerInstructions,
      pdfB.document.absolutePath,
    );
    assert.include(
      starts[1].params.developerInstructions,
      JSON.stringify(pdfB.document.absolutePath),
    );
    assert.notInclude(
      starts[1].params.developerInstructions,
      pdfA.document.absolutePath,
    );
    assert.isTrue(
      starts.every(
        (request) => request.params.config?.features?.shell_tool === true,
      ),
    );
    assert.isTrue(
      starts.every((request) => !("runtimeWorkspaceRoots" in request.params)),
    );
  });

  it("keeps automatic skill routing off on a PDF turn without an explicit skill", async function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["evidence-based-qa.md"])]);
    const processKey = "native-direct-pdf-no-automatic-skill";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-pdf-no-automatic-skill"],
      requests,
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("native");
    const expectedRuntimeCwd = getUserSkillsRuntimeRootDir();
    const activatedSkills: string[] = [];
    CodexAppServerProcess.spawn = async () => proc;
    const pdf = createDirectPdfSelection({
      itemId: 290,
      contextItemId: 291,
      title: "Automatic skill candidate",
      name: "paper.pdf",
      absolutePath: "/Users/example/Papers/Automatic Candidate/paper.pdf",
    });

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-direct-pdf-no-automatic-skill",
          conversationKey: 6_000_000_042,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.6",
        messages: [
          {
            role: "user",
            content: "Summarize the selected paper.",
          },
        ],
        processKey,
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => {
            throw new Error("An ephemeral PDF thread must not be persisted");
          },
        },
        skillContext: {
          pdfPaperContexts: [pdf.paper],
          localDocuments: [pdf.document],
        },
        onSkillActivated: (skillId) => activatedSkills.push(skillId),
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    assert.isFalse(
      requests.some((request) => request.method === "skills/list"),
    );
    const threadStart = requests.find(
      (request) => request.method === "thread/start",
    );
    assert.equal(threadStart?.params.cwd, expectedRuntimeCwd);
    const turnStart = requests.find(
      (request) => request.method === "turn/start",
    );
    assert.equal(turnStart?.params.cwd, expectedRuntimeCwd);
    const turnInput = turnStart?.params.input as Record<string, unknown>[];
    assert.isFalse(turnInput.some((input) => input.type === "skill"));
    assert.deepEqual(activatedSkills, []);
  });

  it("activates only an explicitly selected skill on a PDF turn", async function () {
    setUserSkills([
      parseSkill(BUILTIN_SKILL_FILES["write-note.md"]),
      parseSkill(BUILTIN_SKILL_FILES["evidence-based-qa.md"]),
    ]);
    const processKey = "native-direct-pdf-explicit-skill";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("native");
    const expectedCwd = getUserSkillsRuntimeRootDir();
    const writeNoteSkillPath = `${expectedCwd}/.agents/skills/write-note/SKILL.md`;
    const listedWriteNoteSkillPath =
      process.platform === "darwin"
        ? writeNoteSkillPath.replace(/^\/tmp\//, "/private/tmp/")
        : writeNoteSkillPath;
    const evidenceSkillPath = `${expectedCwd}/.agents/skills/evidence-based-qa/SKILL.md`;
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-pdf-explicit-skill"],
      requests,
      skillsListResult: {
        data: [
          {
            cwd: expectedCwd,
            errors: [],
            skills: [
              {
                name: "write-note",
                path: "/tmp/unrelated-skills/write-note/SKILL.md",
                enabled: true,
              },
              {
                name: "write-note",
                path: listedWriteNoteSkillPath,
                enabled: true,
              },
              {
                name: "evidence-based-qa",
                path: evidenceSkillPath,
                enabled: true,
              },
            ],
          },
        ],
      },
    });
    const activatedSkills: string[] = [];
    let diagnostics: { skillIds: string[] } | undefined;
    CodexAppServerProcess.spawn = async () => proc;
    const pdf = createDirectPdfSelection({
      itemId: 300,
      contextItemId: 301,
      title: "Explicit skill PDF",
      name: "paper.pdf",
      absolutePath: "/Users/example/Papers/Explicit Skill/paper.pdf",
    });

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-direct-pdf-explicit-skill",
          conversationKey: 6_000_000_043,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.6",
        messages: [
          {
            role: "user",
            content: "Summarize the selected raw PDF and write a note.",
          },
        ],
        processKey,
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => {
            throw new Error("An ephemeral PDF thread must not be persisted");
          },
        },
        skillContext: {
          forcedSkillIds: ["write-note"],
          pdfPaperContexts: [pdf.paper],
          localDocuments: [pdf.document],
        },
        onSkillActivated: (skillId) => activatedSkills.push(skillId),
        onDiagnostics: (value) => {
          diagnostics = value;
        },
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    const skillsListRequests = requests.filter(
      (request) => request.method === "skills/list",
    );
    assert.lengthOf(skillsListRequests, 1);
    assert.deepEqual(skillsListRequests[0].params.cwds, [expectedCwd]);
    const threadStart = requests.find(
      (request) => request.method === "thread/start",
    );
    assert.equal(threadStart?.params.ephemeral, true);
    assert.equal(threadStart?.params.cwd, expectedCwd);
    const turnStart = requests.find(
      (request) => request.method === "turn/start",
    );
    assert.equal(turnStart?.params.cwd, expectedCwd);
    const turnInput = turnStart?.params.input as Record<string, unknown>[];
    assert.include(JSON.stringify(turnInput), "$write-note");
    assert.deepEqual(turnInput[0], {
      type: "skill",
      name: "write-note",
      path: listedWriteNoteSkillPath,
    });
    assert.isFalse(
      turnInput.some(
        (input) => input.type === "skill" && input.name === "evidence-based-qa",
      ),
    );
    assert.deepEqual(activatedSkills, ["write-note"]);
    assert.deepEqual(diagnostics?.skillIds, ["write-note"]);
  });

  it("fails a PDF turn when an explicitly selected native skill cannot be loaded", async function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["write-note.md"])]);
    const processKey = "native-direct-pdf-missing-explicit-skill";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-must-not-start"],
      requests,
      skillsListResult: { data: [] },
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("native");
    CodexAppServerProcess.spawn = async () => proc;
    const pdf = createDirectPdfSelection({
      itemId: 310,
      contextItemId: 311,
      title: "Missing explicit skill PDF",
      name: "paper.pdf",
      absolutePath: "/Users/example/Papers/Missing Skill/paper.pdf",
    });
    let error: unknown;

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-direct-pdf-missing-explicit-skill",
          conversationKey: 6_000_000_044,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.6",
        messages: [
          {
            role: "user",
            content: "$write-note\n\nAnalyze the selected raw PDF.",
          },
        ],
        processKey,
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => {
            throw new Error("An ephemeral PDF thread must not be persisted");
          },
        },
        skillContext: {
          forcedSkillIds: ["write-note"],
          pdfPaperContexts: [pdf.paper],
          localDocuments: [pdf.document],
        },
      });
    } catch (caught) {
      error = caught;
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    assert.instanceOf(error, Error);
    assert.include((error as Error).message, "write-note");
    assert.isTrue(requests.some((request) => request.method === "skills/list"));
    assert.isFalse(
      requests.some((request) => request.method === "thread/start"),
    );
  });

  it("fails a PDF turn when a persisted explicit skill selection is stale", async function () {
    setUserSkills([]);
    const processKey = "native-direct-pdf-stale-explicit-skill";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-must-not-start"],
      requests,
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("native");
    CodexAppServerProcess.spawn = async () => proc;
    const pdf = createDirectPdfSelection({
      itemId: 320,
      contextItemId: 321,
      title: "Stale explicit skill PDF",
      name: "paper.pdf",
      absolutePath: "/Users/example/Papers/Stale Skill/paper.pdf",
    });
    let error: unknown;

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-direct-pdf-stale-explicit-skill",
          conversationKey: 6_000_000_045,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.6",
        messages: [
          {
            role: "user",
            content: "Analyze the selected raw PDF.",
          },
        ],
        processKey,
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => {
            throw new Error("An ephemeral PDF thread must not be persisted");
          },
        },
        skillContext: {
          forcedSkillIds: ["removed-custom-skill"],
          pdfPaperContexts: [pdf.paper],
          localDocuments: [pdf.document],
        },
      });
    } catch (caught) {
      error = caught;
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    assert.instanceOf(error, Error);
    assert.include((error as Error).message, "removed-custom-skill");
    assert.isFalse(
      requests.some((request) => request.method === "skills/list"),
    );
    assert.isFalse(
      requests.some((request) => request.method === "thread/start"),
    );
  });

  it("preserves a free-form skill marker on a PDF turn without fabricating a skill path", async function () {
    const processKey = "native-direct-pdf-free-form-skill-marker";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-pdf-free-form-skill-marker"],
      requests,
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("native");
    CodexAppServerProcess.spawn = async () => proc;
    const pdf = createDirectPdfSelection({
      itemId: 330,
      contextItemId: 331,
      title: "Free-form skill marker PDF",
      name: "paper.pdf",
      absolutePath: "/Users/example/Papers/Free Marker/paper.pdf",
    });

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-direct-pdf-free-form-skill-marker",
          conversationKey: 6_000_000_046,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.6",
        messages: [
          {
            role: "user",
            content: "$external-pdf-workflow\n\nAnalyze the raw PDF.",
          },
        ],
        processKey,
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => {
            throw new Error("An ephemeral PDF thread must not be persisted");
          },
        },
        skillContext: {
          pdfPaperContexts: [pdf.paper],
          localDocuments: [pdf.document],
        },
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    assert.isFalse(
      requests.some((request) => request.method === "skills/list"),
    );
    const turnStart = requests.find(
      (request) => request.method === "turn/start",
    );
    const turnInput = turnStart?.params.input as Record<string, unknown>[];
    assert.include(JSON.stringify(turnInput), "$external-pdf-workflow");
    assert.isFalse(turnInput.some((input) => input.type === "skill"));
  });

  it("uses named permission profiles without composing legacy sandbox fields", async function () {
    const processKey = "native-permission-profile";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-permission-profile"],
      requests,
      permissionProfilesResult: {
        data: [
          { id: ":read-only", description: "Read", allowed: true },
          { id: ":workspace", description: "Workspace", allowed: true },
        ],
      },
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("off", ":workspace");
    let storedThreadId: string | undefined;
    CodexAppServerProcess.spawn = async () => proc;
    try {
      const turnParams = {
        scope: {
          conversationKey: 6_000_000_046,
          libraryID: 1,
          kind: "global",
          title: "Permission profile",
        },
        model: "gpt-5.6",
        messages: [{ role: "user", content: "Inspect the project." }],
        processKey,
        hooks: {
          loadProviderSessionId: async () => storedThreadId,
          persistProviderSessionId: async (threadId: string) => {
            storedThreadId = threadId;
          },
        },
      };
      await runCodexAppServerNativeTurn(turnParams);
      await runCodexAppServerNativeTurn(turnParams);
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    const profileList = requests.find(
      (request) => request.method === "permissionProfile/list",
    );
    assert.isString(profileList?.params.cwd);
    const threadStart = requests.find(
      (request) => request.method === "thread/start",
    );
    assert.equal(threadStart?.params.permissions, ":workspace");
    assert.notProperty(threadStart?.params || {}, "sandbox");
    const threadResume = requests.find(
      (request) => request.method === "thread/resume",
    );
    assert.equal(threadResume?.params.permissions, ":workspace");
    assert.notProperty(threadResume?.params || {}, "sandbox");
    const turnStart = requests.find(
      (request) => request.method === "turn/start",
    );
    assert.notProperty(turnStart?.params || {}, "sandboxPolicy");
  });

  it("confirms an explicit settings update before starting the resumed turn", async function () {
    const processKey = "native-permission-settings-update";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: [],
      requests,
      permissionProfilesResult: {
        data: [
          { id: ":workspace", description: "Workspace", allowed: true },
          {
            id: ":danger-full-access",
            description: "Full",
            allowed: true,
          },
        ],
      },
      resumeEffectiveSettings: {
        permissions: ":danger-full-access",
        approvalPolicy: "never",
        approvalsReviewer: "user",
      },
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("off", ":workspace");
    let persistedPermissionState = "";
    CodexAppServerProcess.spawn = async () => proc;
    try {
      await runCodexAppServerNativeTurn({
        scope: {
          conversationKey: 6_000_000_047,
          libraryID: 1,
          kind: "global",
          title: "Settings update",
        },
        model: "gpt-5.6",
        messages: [{ role: "user", content: "Inspect safely." }],
        processKey,
        hooks: {
          loadProviderSessionId: async () => "thread-existing",
          loadProviderPermissionState: async () =>
            JSON.stringify({
              boundary: {
                kind: "profile",
                profileId: ":danger-full-access",
              },
              approvalOverride: { policy: "never", reviewer: "user" },
            }),
          persistProviderSession: async (value) => {
            persistedPermissionState = value.permissionState || "";
          },
        },
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    const updateIndex = requests.findIndex(
      (request) => request.method === "thread/settings/update",
    );
    const turnIndex = requests.findIndex(
      (request) => request.method === "turn/start",
    );
    assert.isAtLeast(updateIndex, 0);
    assert.isAbove(turnIndex, updateIndex);
    assert.deepInclude(requests[updateIndex].params, {
      threadId: "thread-existing",
      permissions: ":workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
    assert.notProperty(requests[turnIndex].params, "permissions");
    assert.notProperty(requests[turnIndex].params, "sandboxPolicy");
    assert.equal(
      persistedPermissionState,
      JSON.stringify({
        boundary: { kind: "profile", profileId: ":workspace" },
        approvalOverride: { policy: "on-request", reviewer: "user" },
      }),
    );
  });

  it("replaces the provider thread when settings update is unsupported", async function () {
    const processKey = "native-permission-settings-update-unsupported";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-settings-replacement"],
      requests,
      permissionProfilesResult: {
        data: [
          { id: ":workspace", description: "Workspace", allowed: true },
          {
            id: ":danger-full-access",
            description: "Full",
            allowed: true,
          },
        ],
      },
      resumeEffectiveSettings: {
        permissions: ":danger-full-access",
        approvalPolicy: "never",
        approvalsReviewer: "user",
      },
      settingsUpdateMethodNotFound: true,
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("off", ":workspace");
    let storedThreadId = "thread-settings-old";
    CodexAppServerProcess.spawn = async () => proc;
    try {
      await runCodexAppServerNativeTurn({
        scope: {
          conversationKey: 6_000_000_049,
          libraryID: 1,
          kind: "global",
          title: "Unsupported settings update",
        },
        model: "gpt-5.6",
        messages: [
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: "Continue safely." },
        ],
        processKey,
        hooks: {
          loadProviderSessionId: async () => storedThreadId,
          loadProviderPermissionState: async () =>
            JSON.stringify({
              boundary: {
                kind: "profile",
                profileId: ":danger-full-access",
              },
              approvalOverride: { policy: "never", reviewer: "user" },
            }),
          persistProviderSession: async (value) => {
            storedThreadId = value.threadId;
          },
        },
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    assert.isTrue(
      requests.some((request) => request.method === "thread/settings/update"),
    );
    const replacementStart = requests.find(
      (request) => request.method === "thread/start",
    )!;
    assert.equal(replacementStart.params.permissions, ":workspace");
    assert.equal(replacementStart.params.approvalPolicy, "on-request");
    assert.equal(replacementStart.params.approvalsReviewer, "user");
    assert.equal(storedThreadId, "thread-settings-replacement");
    assert.isTrue(
      requests.some(
        (request) =>
          request.method === "thread/archive" &&
          request.params.threadId === "thread-settings-old",
      ),
    );
  });

  it("replaces a sticky Ask thread before Custom, injects history, then swaps durably", async function () {
    const processKey = "native-permission-custom-replacement";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-custom-replacement"],
      requests,
      permissionProfilesResult: {
        data: [
          { id: ":workspace", description: "Workspace", allowed: true },
          {
            id: ":danger-full-access",
            description: "Full",
            allowed: true,
          },
        ],
      },
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = globalThis.Zotero;
    let persistedAtRequestCount = -1;
    let persistedThreadId = "thread-sticky-ask";
    let persistedPermissionState = "";
    (globalThis as any).Zotero = {
      ...(originalZotero || {}),
      debug: () => undefined,
      DataDirectory: { dir: "/tmp/lfz-custom-replacement-data" },
      Profile: { dir: "/tmp/lfz-custom-replacement-profile" },
      Prefs: {
        get: (key: string) => {
          if (key.endsWith(".codexAppServerZoteroMcpToolsEnabled")) {
            return false;
          }
          if (key.endsWith(".codexNativeSkillMode")) return "off";
          if (key.endsWith(".codexAppServerPermissionState")) {
            return JSON.stringify({
              boundary: { kind: "config" },
              approvalOverride: null,
            });
          }
          return undefined;
        },
        prefHasUserValue: (key: string) =>
          key.endsWith(".codexAppServerPermissionState"),
      },
    };
    CodexAppServerProcess.spawn = async () => proc;
    try {
      await runCodexAppServerNativeTurn({
        scope: {
          conversationKey: 6_000_000_048,
          libraryID: 1,
          kind: "global",
          title: "Custom replacement",
        },
        model: "gpt-5.6",
        messages: [
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: "Continue under Codex config." },
        ],
        processKey,
        hooks: {
          loadProviderSessionId: async () => persistedThreadId,
          loadProviderPermissionState: async () =>
            JSON.stringify({
              boundary: { kind: "profile", profileId: ":workspace" },
              approvalOverride: {
                policy: "on-request",
                reviewer: "user",
              },
            }),
          persistProviderSession: async (value) => {
            persistedAtRequestCount = requests.length;
            persistedThreadId = value.threadId;
            persistedPermissionState = value.permissionState || "";
          },
        },
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      (globalThis as any).Zotero = originalZotero;
      destroyCachedCodexAppServerProcess(processKey, proc);
    }

    assert.isFalse(
      requests.some((request) => request.method === "thread/resume"),
    );
    const start = requests.find(
      (request) => request.method === "thread/start",
    )!;
    assert.notProperty(start.params, "permissions");
    assert.notProperty(start.params, "approvalPolicy");
    assert.notProperty(start.params, "approvalsReviewer");
    assert.notProperty(start.params, "sandbox");
    const injectIndex = requests.findIndex(
      (request) => request.method === "thread/inject_items",
    );
    const turnIndex = requests.findIndex(
      (request) => request.method === "turn/start",
    );
    assert.isAtLeast(injectIndex, 0);
    assert.include(
      JSON.stringify(requests[injectIndex].params),
      "Earlier question",
    );
    assert.isAbove(persistedAtRequestCount, injectIndex);
    assert.isAtMost(persistedAtRequestCount, turnIndex);
    assert.equal(persistedThreadId, "thread-custom-replacement");
    assert.equal(
      persistedPermissionState,
      JSON.stringify({ boundary: { kind: "config" }, approvalOverride: null }),
    );
    assert.isTrue(
      requests.some(
        (request) =>
          request.method === "thread/archive" &&
          request.params.threadId === "thread-sticky-ask",
      ),
    );
  });

  afterEach(function () {
    resetCodexNativePathSafetyStateForTests();
    clearCodexNativeReadLedger();
    setUserSkills([]);
  });

  it("sends native thread compact requests and waits for completion", async function () {
    const processKey = "native-compact-thread-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const writes: string[] = [];
    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          writes.push(chunk);
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
          };
          if (request.method === "thread/compact/start") {
            setTimeout(() => {
              (
                proc as unknown as {
                  handleMessage: (msg: Record<string, unknown>) => void;
                }
              ).handleMessage({ id: request.id, result: {} });
            }, 0);
            setTimeout(() => {
              (
                proc as unknown as {
                  handleMessage: (msg: Record<string, unknown>) => void;
                }
              ).handleMessage({
                method: "thread/compacted",
                params: { thread: { id: "thread-compact" } },
              });
            }, 0);
          }
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;

    try {
      await compactCodexAppServerThread({
        threadId: "thread-compact",
        processKey,
        timeoutMs: 100,
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
    }

    const compactRequest = writes
      .map((chunk) => JSON.parse(chunk) as { method: string; params: unknown })
      .find((entry) => entry.method === "thread/compact/start");
    assert.deepEqual(compactRequest?.params, { threadId: "thread-compact" });
  });

  it("fails conversation compaction clearly when no stored thread exists", async function () {
    let caught: unknown;
    try {
      await compactCodexAppServerConversation({
        conversationKey: 6_000_000_020,
        hooks: { loadProviderSessionId: async () => "" },
        processKey: "native-compact-missing-thread-test",
        timeoutMs: 10,
      });
    } catch (error) {
      caught = error;
    }

    assert.instanceOf(caught, Error);
    assert.equal(
      (caught as Error).message,
      NO_CODEX_APP_SERVER_THREAD_TO_COMPACT_MESSAGE,
    );
  });

  it("requests paged Codex app-server models", async function () {
    const processKey = "native-model-list-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const writes: string[] = [];
    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          writes.push(chunk);
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
          };
          if (request.method === "model/list") {
            setTimeout(() => {
              (
                proc as unknown as {
                  handleMessage: (msg: Record<string, unknown>) => void;
                }
              ).handleMessage({
                id: request.id,
                result: { data: [], nextCursor: null },
              });
            }, 0);
          }
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;

    try {
      const result = await listCodexAppServerModels({
        processKey,
        codexPath: "codex",
        includeHidden: true,
        cursor: "cursor-1",
        limit: 50,
      });
      assert.deepEqual(result, { data: [], nextCursor: null });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc, {
        codexPath: "codex",
      });
    }

    const modelListRequest = writes
      .map((chunk) => JSON.parse(chunk) as { method: string; params: unknown })
      .find((entry) => entry.method === "model/list");
    assert.deepEqual(modelListRequest?.params, {
      includeHidden: true,
      cursor: "cursor-1",
      limit: 50,
    });
  });

  it("forks a thread with the target conversation's scope header, not the source's", async function () {
    const processKey = "native-fork-scope-header";
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
    const prefStore = new Map<string, unknown>();
    const writes: string[] = [];
    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          writes.push(chunk);
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
            params?: Record<string, any>;
          };
          if (request.method !== "thread/fork") return;
          void (async () => {
            const servers = request.params?.config?.mcp_servers as Record<
              string,
              { http_headers?: Record<string, string> }
            >;
            const serverConfig = Object.values(servers || {})[0];
            const response = await invokeRegisteredZoteroMcpEndpoint({
              method: "POST",
              data: {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
                params: {},
              },
              headers: serverConfig?.http_headers,
            });
            const responseBody = JSON.parse(response?.[2] || "{}");
            const handleMessage = (
              proc as unknown as {
                handleMessage: (msg: Record<string, unknown>) => void;
              }
            ).handleMessage.bind(proc);
            if (responseBody.error) {
              handleMessage({ id: request.id, error: responseBody.error });
              return;
            }
            handleMessage({
              id: request.id,
              result: { thread: { id: "thread-forked" } },
            });
          })();
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key),
        set: (key: string, value: unknown) => prefStore.set(key, value),
      },
      Profile: { dir: "/tmp/lfz-fork-scope-profile" },
      DataDirectory: { dir: "/tmp/lfz-fork-scope-data" },
      Server: { Endpoints: {} },
    };
    registerMcpServer({
      toolRegistry: new AgentToolRegistry(),
      zoteroGateway: {} as never,
    });

    try {
      const threadId = await forkCodexAppServerThread({
        threadId: "thread-source",
        targetConversationKey: 6_000_000_311,
        processKey,
        codexPath: "codex",
      });
      assert.equal(threadId, "thread-forked");

      const forkRequest = writes
        .map(
          (chunk) =>
            JSON.parse(chunk) as {
              method: string;
              params: Record<string, any>;
            },
        )
        .find((entry) => entry.method === "thread/fork");
      assert.equal(forkRequest?.params.threadId, "thread-source");

      const servers = forkRequest?.params.config?.mcp_servers as Record<
        string,
        { http_headers?: Record<string, string> }
      >;
      const serverConfig = Object.values(servers || {})[0];
      const sentScopeToken =
        serverConfig?.http_headers?.[ZOTERO_MCP_SCOPE_HEADER];
      const profileSignature = getCodexProfileSignature();
      assert.equal(
        sentScopeToken,
        resolveConversationScopeToken({
          profileSignature,
          conversationKey: 6_000_000_311,
        }),
      );
      assert.notEqual(
        sentScopeToken,
        resolveConversationScopeToken({
          profileSignature,
          conversationKey: 6_000_000_310,
        }),
      );
    } finally {
      unregisterMcpServer();
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc, {
        codexPath: "codex",
      });
      (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
    }
  });

  it("overrides the inherited MCP server while tools are disabled", async function () {
    const processKey = "native-fork-disabled-scope-header";
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
    const prefStore = new Map<string, unknown>();
    const writes: string[] = [];
    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          writes.push(chunk);
          const request = JSON.parse(chunk) as { id: number; method: string };
          if (request.method !== "thread/fork") return;
          setTimeout(() => {
            (
              proc as unknown as {
                handleMessage: (msg: Record<string, unknown>) => void;
              }
            ).handleMessage({
              id: request.id,
              result: { thread: { id: "thread-forked-disabled" } },
            });
          }, 0);
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Prefs: {
        get: (key: string) =>
          key.endsWith(".codexAppServerZoteroMcpToolsEnabled")
            ? false
            : prefStore.get(key),
        set: (key: string, value: unknown) => prefStore.set(key, value),
      },
      Profile: { dir: "/tmp/lfz-fork-disabled-scope-profile" },
      DataDirectory: { dir: "/tmp/lfz-fork-disabled-scope-data" },
      Server: { Endpoints: {} },
    };

    try {
      const threadId = await forkCodexAppServerThread({
        threadId: "thread-source",
        targetConversationKey: 6_000_000_313,
        processKey,
        codexPath: "codex",
      });
      assert.equal(threadId, "thread-forked-disabled");

      const forkRequest = writes
        .map(
          (chunk) =>
            JSON.parse(chunk) as {
              method: string;
              params: Record<string, any>;
            },
        )
        .find((entry) => entry.method === "thread/fork");
      const servers = forkRequest?.params.config?.mcp_servers as Record<
        string,
        {
          enabled?: boolean;
          required?: boolean;
          http_headers?: Record<string, string>;
        }
      >;
      const serverConfig = Object.values(servers || {})[0];
      assert.equal(serverConfig?.enabled, false);
      assert.notProperty(serverConfig || {}, "required");
      assert.equal(
        serverConfig?.http_headers?.[ZOTERO_MCP_SCOPE_HEADER],
        resolveConversationScopeToken({
          profileSignature: getCodexProfileSignature(),
          conversationKey: 6_000_000_313,
        }),
      );
    } finally {
      unregisterMcpServer();
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc, {
        codexPath: "codex",
      });
      (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
    }
  });

  it("auto-approves only safe Zotero MCP reads", function () {
    const legacyReadDecision = resolveSafeCodexNativeApprovalRequest({
      method: "tool/requestUserInput",
      params: {
        serverName: "llm_for_zotero_profile_1234",
        toolName: "library_search",
        questions: [{ header: "Allow", question: "Use library_search?" }],
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
    assert.isNull(legacyWriteDecision);

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
    assert.isFalse(currentWriteDecision.approved);

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
    assert.isFalse(suffixedApprovalDecision.approved);

    const turnApprovalDecision = resolveSafeCodexNativeApprovalRequest({
      method: "turn/approval/request",
      params: {
        serverName: "llm_for_zotero_profile_1234",
        toolName: "edit_current_note",
        message: "Allow llm_for_zotero to use edit_current_note?",
      },
    });
    assert.isNull(turnApprovalDecision);

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

  it("rejects spoofed Zotero MCP approval payloads", function () {
    assert.isNull(
      resolveSafeCodexNativeApprovalRequest({
        method: "tool/requestUserInput",
        params: {
          serverName: "evil_mcp",
          toolName: "library_search",
          message: "Allow llm_for_zotero to use library_search?",
        },
      }),
    );
    assert.isNull(
      resolveSafeCodexNativeApprovalRequest({
        method: "tool/requestUserInput",
        params: {
          message:
            "This string mentions llm_for_zotero and library_search but has no structured server.",
        },
      }),
    );
    assert.isNull(
      resolveSafeCodexNativeApprovalRequest({
        method: "tool/requestUserInput",
        params: {
          serverName: "llm_for_zotero_profile_1234",
          toolName: "unknown_tool",
        },
      }),
    );
    assert.isNull(
      resolveSafeCodexNativeApprovalRequest({
        method: "item/tool/requestUserInput",
        params: {
          serverName: "llm_for_zotero_profile_1234",
          toolName: "library_search",
          questions: [
            {
              id: "allow",
              question: "Allow library_search?",
              options: [{ label: "Reject" }, { label: "Deny" }],
            },
          ],
        },
      }),
    );

    const scopedDecision = resolveSafeCodexNativeApprovalRequest({
      method: "tool/requestUserInput",
      params: {
        serverName: "llm_for_zotero_profile_1234",
        toolName: "library_search",
        scopeToken: "scope-token-123",
      },
    });
    assert.equal(scopedDecision?.approved, true);
    assert.equal(
      scopedDecision?.target,
      "llm_for_zotero_profile_1234/library_search",
    );
  });

  it("does not override guardian denials with spoofed Zotero MCP markers", function () {
    assert.isFalse(
      isDeniedTrustedZoteroMcpGuardianReviewForTests({
        review: { status: "denied" },
        action: {
          type: "mcp_tool_call",
          server: "evil_mcp",
          tool_name: "library_search",
          rationale: "mentions llm_for_zotero",
        },
      }),
    );
    assert.isTrue(
      isDeniedTrustedZoteroMcpGuardianReviewForTests({
        review: { status: "denied" },
        action: {
          type: "mcp_tool_call",
          server: "llm_for_zotero_profile_1234",
          tool_name: "library_search",
        },
      }),
    );
    assert.isFalse(
      isDeniedTrustedZoteroMcpGuardianReviewForTests({
        review: { status: "denied" },
        action: {
          type: "mcp_tool_call",
          server: "llm_for_zotero_profile_1234",
          tool_name: "run_command",
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

  it("builds native Codex approval cards and turn-scoped approval responses", function () {
    const commandRequest = {
      method: "item/commandExecution/requestApproval",
      params: {
        command: "npm test",
        cwd: "/repo/example",
      },
    };

    const commandAction = buildCodexNativeApprovalPendingAction(commandRequest);

    assert.equal(commandAction.toolName, "codex_native_approval");
    assert.equal(commandAction.mode, "approval");
    assert.equal(commandAction.confirmLabel, "Approve once");
    assert.equal(commandAction.cancelLabel, "Deny");
    assert.include(commandAction.title, "command");
    assert.include(JSON.stringify(commandAction.fields), "npm test");
    assert.include(JSON.stringify(commandAction.fields), "/repo/example");
    assert.deepEqual(
      buildCodexNativeApprovalResponseFromResolution(commandRequest, {
        approved: true,
        actionId: "approve",
      }),
      { decision: "accept" },
    );
    assert.deepEqual(
      buildCodexNativeApprovalResponseFromResolution(commandRequest, {
        approved: false,
        actionId: "deny",
      }),
      { decision: "decline" },
    );

    const permissionRequest = {
      method: "item/permissions/requestApproval",
      params: {
        cwd: "/repo/example",
        reason: "Need to read a sibling package.",
        permissions: {
          fileSystem: {
            read: ["/repo/shared"],
            write: null,
          },
          network: null,
        },
      },
    };

    assert.deepEqual(
      buildCodexNativeApprovalResponseFromResolution(permissionRequest, {
        approved: true,
        actionId: "approve",
      }),
      {
        permissions: {
          fileSystem: {
            read: ["/repo/shared"],
            write: null,
          },
        },
        scope: "turn",
      },
    );
    assert.deepEqual(
      buildCodexNativeApprovalResponseFromResolution(permissionRequest, {
        approved: false,
        actionId: "deny",
      }),
      { permissions: {}, scope: "turn" },
    );
  });

  it("uses a light Codex-native Zotero resource contract", function () {
    const manifest = buildZoteroEnvironmentManifest({
      scope: {
        profileSignature: "profile-visible-test",
        conversationKey: 1,
        libraryID: 1,
        kind: "paper",
        paperItemID: 42,
        activeItemId: 42,
        activeContextItemId: 43,
        paperTitle: "Native Paper",
      },
      mcpEnabled: true,
      mcpReady: true,
    });
    assert.include(manifest, "Zotero MCP is ready");
    assert.include(
      manifest,
      "The connected Codex runtime owns ordinary invocation approval",
    );
    assert.notInclude(
      manifest,
      "Semantic action authority is unavailable. Do not execute effects.",
    );
    assert.include(
      manifest,
      "tools.mcp__llm_for_zotero_profile_visible_test__file_io",
    );
    assert.include(
      manifest,
      "tools.mcp__llm_for_zotero_profile_visible_test__run_command",
    );
    assert.include(manifest, "all paths accessible to Zotero");
    assert.notInclude(
      manifest,
      "Zotero reviews only an exact access expansion",
    );
    assert.include(
      manifest,
      "Apply your own approval and command-permission policy",
    );
    assert.include(manifest, "facts or actions absent from context");
    assert.include(manifest, PAPER_CITATION_CONTRACT);
    assert.equal(manifest.split(PAPER_CITATION_CONTRACT).length - 1, 1);
    assert.include(
      manifest,
      "cite supporting passages at paragraph ends with [[cite:Q_x7a2]]",
    );
    assert.include(
      manifest,
      "Do not call additional tools solely to discover quotes or page numbers",
    );
    assert.notInclude(manifest, "page N");
    assert.notInclude(manifest, "use shell creatively");
  });
  it("replaces ordinary paper retrieval guidance for raw PDF turns", function () {
    const manifest = buildZoteroEnvironmentManifest({
      scope: {
        conversationKey: 1,
        libraryID: 1,
        kind: "paper",
        paperItemID: 42,
        activeItemId: 42,
        activeContextItemId: 43,
        paperTitle: "Native Paper",
      },
      mcpEnabled: true,
      mcpReady: true,
      rawPdfMode: true,
      skillInstructionBlock:
        "Skill: simple-paper-qa\nCall paper_read overview.",
    });

    assert.notInclude(
      manifest,
      "Paper content: use paper_read overview for broad single-paper summaries",
    );
    assert.include(manifest, "Skill: simple-paper-qa");
    assert.match(
      manifest,
      /Raw PDF transport policy[\s\S]*Do not use `paper_read`[\s\S]*$/,
    );
  });

  it("renders selected tag resources in Codex native visible context", function () {
    const block = buildCodexNativeVisibleTurnContextBlockForTests({
      scope: {
        conversationKey: 1,
        libraryID: 1,
        libraryName: "My Library",
        kind: "global",
      },
      skillContext: {
        selectedTagContexts: [
          {
            name: "Stable",
            normalizedName: "stable",
            libraryID: 1,
          },
          {
            name: "Untagged",
            libraryID: 1,
            scope: "untagged",
          },
        ],
      },
    });

    assert.include(block, "Zotero context for this turn");
    assert.include(block, "Library scope");
    assert.include(block, "Tag 1");
    assert.include(block, "Tag 2");
    assert.include(block, 'name="Stable"');
    assert.include(block, 'scope="untagged"');
    assert.include(block, 'source="selected resource pool"');
    assert.notInclude(block, "Collection 1");
  });

  it("renders selected note-edit resources in Codex native visible context", function () {
    const block = buildCodexNativeVisibleTurnContextBlockForTests({
      scope: {
        conversationKey: 3703,
        libraryID: 1,
        libraryName: "My Library",
        kind: "paper",
        paperItemID: 3612,
        activeItemId: 3612,
        paperTitle: "Ajemian et al., 2013",
        activeNoteId: 3703,
        activeNoteTitle: "Ajemian et al., 2013 - MD",
        activeNoteKind: "item",
        activeNoteParentItemId: 3612,
      },
      skillContext: {
        selectedTexts: ["Panel A illustrates the stability problem."],
        selectedTextSources: ["note-edit"],
        selectedTextNoteContexts: [
          {
            libraryID: 1,
            noteItemKey: "NOTEKEY",
            noteItemId: 3703,
            parentItemId: 3612,
            noteKind: "item",
            title: "Ajemian et al., 2013 - MD",
          },
        ],
      },
    });

    assert.include(block, 'scope="paper"');
    assert.include(block, "Selected text notes:");
    assert.include(block, "noteId=3703");
    assert.include(block, 'noteKind="item"');
    assert.include(block, "parentItemId=3612");
  });

  it("renders pinned papers and selected collections in visible context", function () {
    const block = buildCodexNativeVisibleTurnContextBlockForTests({
      scope: {
        conversationKey: 1,
        libraryID: 1,
        libraryName: "My Library",
        kind: "paper",
        paperTitle: "Active Drift Paper",
        paperContext: {
          itemId: 10,
          contextItemId: 11,
          title: "Active Drift Paper",
          firstCreator: "Micou",
          year: "2026",
        },
      },
      skillContext: {
        selectedPaperContexts: [
          {
            itemId: 10,
            contextItemId: 11,
            title: "Active Drift Paper",
            firstCreator: "Micou",
            year: "2026",
          },
        ],
        pinnedPaperContexts: [
          {
            itemId: 20,
            contextItemId: 21,
            title: "Self-healing codes",
            firstCreator: "Rule",
            year: "2022",
          },
        ],
        selectedCollectionContexts: [
          { collectionId: 8, libraryID: 1, name: "Representation Drift" },
        ],
        selectedTagContexts: [
          {
            name: "Learning",
            normalizedName: "learning",
            libraryID: 1,
          },
        ],
      },
    });

    assert.include(block, "Paper 1");
    assert.include(block, 'title="Active Drift Paper"');
    assert.include(block, "Paper 2");
    assert.include(block, 'title="Self-healing codes"');
    assert.include(block, "Collection 1");
    assert.include(block, 'name="Representation Drift"');
    assert.include(block, "Tag 1");
    assert.include(block, 'name="Learning"');
    assert.include(block, '"these papers"');
  });

  it("puts current two-paper context in developer instructions without user-prefix duplication", async function () {
    const processKey = "native-visible-context-turn-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = globalThis.Zotero;
    let threadResumeParams: Record<string, unknown> | undefined;
    let turnStartParams: Record<string, unknown> | undefined;

    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
            params?: Record<string, unknown>;
          };
          const handleMessage = (
            proc as unknown as {
              handleMessage: (msg: Record<string, unknown>) => void;
            }
          ).handleMessage.bind(proc);
          if (request.method === "thread/resume") {
            threadResumeParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { thread: { id: "thread-visible" } },
                }),
              0,
            );
            return;
          }
          if (request.method === "turn/start") {
            turnStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { turn: { id: "turn-visible" } },
                }),
              0,
            );
            setTimeout(
              () =>
                handleMessage({
                  method: "turn/completed",
                  params: {
                    turn: { id: "turn-visible", status: "completed" },
                  },
                }),
              5,
            );
            return;
          }
          if (request.method === "thread/read") {
            setTimeout(
              () => handleMessage({ id: request.id, result: { turns: [] } }),
              0,
            );
          }
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Prefs: {
        get: (key: string) =>
          key.endsWith(".codexAppServerZoteroMcpToolsEnabled")
            ? false
            : undefined,
      },
    };

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-visible-test",
          conversationKey: 6_000_000_030,
          libraryID: 1,
          libraryName: "My Library",
          kind: "paper",
          paperItemID: 10,
          paperTitle:
            "Statistics of cortical representational drift can enable robust readout",
        },
        model: "gpt-5.5",
        messages: [
          {
            role: "system",
            content: "SECRET SYSTEM PROMPT: do not show in chat trace.",
          },
          {
            role: "user",
            content: "does it make the two papers connected to each other?",
          },
        ],
        skillContext: {
          selectedPaperContexts: [
            {
              itemId: 10,
              contextItemId: 11,
              title:
                "Statistics of cortical representational drift can enable robust readout",
              firstCreator: "Micou",
              year: "2026",
            },
          ],
          pinnedPaperContexts: [
            {
              itemId: 20,
              contextItemId: 21,
              title:
                "Self-healing codes: How stable neural populations can track continually reconfiguring neural representations",
              firstCreator: "Rule",
              year: "2022",
            },
          ],
        },
        hooks: {
          loadProviderSessionId: async () => "thread-visible",
          persistProviderSessionId: async () => undefined,
        },
        processKey,
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      destroyCachedCodexAppServerProcess(processKey, proc);
    }

    assert.isOk(turnStartParams);
    assert.equal(threadResumeParams?.sandbox, "read-only");
    assert.notProperty(threadResumeParams || {}, "persistExtendedHistory");
    assert.notProperty(threadResumeParams || {}, "permissions");
    assert.notProperty(threadResumeParams || {}, "runtimeWorkspaceRoots");
    assert.deepEqual(turnStartParams?.sandboxPolicy, {
      type: "readOnly",
      networkAccess: false,
    });
    assert.notProperty(turnStartParams || {}, "persistExtendedHistory");
    assert.notProperty(turnStartParams || {}, "permissions");
    assert.notProperty(turnStartParams || {}, "runtimeWorkspaceRoots");
    const developerInstructions = String(
      threadResumeParams?.developerInstructions || "",
    );
    const inputText = JSON.stringify(turnStartParams?.input);
    assert.include(developerInstructions, "Zotero context for this turn");
    assert.include(developerInstructions, "Paper 1", developerInstructions);
    assert.include(
      developerInstructions,
      "Statistics of cortical representational drift can enable robust readout",
    );
    assert.include(developerInstructions, "Paper 2");
    assert.include(developerInstructions, "Self-healing codes");
    assert.include(
      inputText,
      "does it make the two papers connected to each other?",
    );
    assert.notInclude(inputText, "Zotero context for this turn");
    assert.notInclude(inputText, "Paper 1");
    assert.notInclude(inputText, "Paper 2");
    assert.notInclude(inputText, "SECRET SYSTEM PROMPT");
    assert.notInclude(inputText, "Zotero environment for this turn");
    assert.notInclude(inputText, "Notes directory configuration");
  });

  it("prefixes visible context only when developer instructions are unsupported", async function () {
    const processKey = "native-visible-context-fallback-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = globalThis.Zotero;
    const originalToolkit = (
      globalThis as typeof globalThis & { ztoolkit?: unknown }
    ).ztoolkit;
    const threadResumeParams: Record<string, unknown>[] = [];
    let turnStartParams: Record<string, unknown> | undefined;

    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
            params?: Record<string, unknown>;
          };
          const handleMessage = (
            proc as unknown as {
              handleMessage: (msg: Record<string, unknown>) => void;
            }
          ).handleMessage.bind(proc);
          if (request.method === "thread/resume") {
            threadResumeParams.push(request.params || {});
            if (threadResumeParams.length === 1) {
              setTimeout(
                () =>
                  handleMessage({
                    id: request.id,
                    error: {
                      message:
                        "invalid params: unknown field developerInstructions",
                    },
                  }),
                0,
              );
              return;
            }
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { thread: { id: "thread-visible-fallback" } },
                }),
              0,
            );
            return;
          }
          if (request.method === "turn/start") {
            turnStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { turn: { id: "turn-visible-fallback" } },
                }),
              0,
            );
            setTimeout(
              () =>
                handleMessage({
                  method: "turn/completed",
                  params: {
                    turn: {
                      id: "turn-visible-fallback",
                      status: "completed",
                    },
                  },
                }),
              5,
            );
            return;
          }
          if (request.method === "thread/read") {
            setTimeout(
              () => handleMessage({ id: request.id, result: { turns: [] } }),
              0,
            );
          }
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Prefs: {
        get: (key: string) =>
          key.endsWith(".codexAppServerZoteroMcpToolsEnabled")
            ? false
            : undefined,
      },
    };
    (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit = {
      log: () => undefined,
    };

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-visible-fallback-test",
          conversationKey: 6_000_000_031,
          libraryID: 1,
          kind: "paper",
          paperItemID: 10,
          paperTitle: "Fallback Context Paper",
        },
        model: "gpt-5.5",
        messages: [{ role: "user", content: "summarize the context" }],
        skillContext: {
          selectedPaperContexts: [
            {
              itemId: 10,
              contextItemId: 11,
              title: "Fallback Context Paper",
              firstCreator: "Micou",
              year: "2026",
            },
          ],
        },
        hooks: {
          loadProviderSessionId: async () => "thread-visible-fallback",
          persistProviderSessionId: async () => undefined,
        },
        processKey,
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      (globalThis as typeof globalThis & { ztoolkit?: unknown }).ztoolkit =
        originalToolkit;
      destroyCachedCodexAppServerProcess(processKey, proc);
    }

    assert.lengthOf(threadResumeParams, 2);
    assert.isString(threadResumeParams[0].developerInstructions);
    assert.notProperty(threadResumeParams[1], "developerInstructions");
    const inputText = JSON.stringify(turnStartParams?.input);
    assert.include(inputText, "Zotero context for this turn");
    assert.include(inputText, "Fallback Context Paper");
    assert.equal(inputText.split("Zotero context for this turn").length - 1, 1);
  });

  it("applies the canonical Approve preset at thread level only", async function () {
    const processKey = "native-approvals-reviewer-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = globalThis.Zotero;
    let threadStartParams: Record<string, unknown> | undefined;
    let turnStartParams: Record<string, unknown> | undefined;

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DataDirectory: { dir: "/tmp/lfz-native-reviewer-data" },
      Profile: { dir: "/tmp/lfz-native-reviewer-profile" },
      Prefs: {
        get: (key: string) => {
          if (key.endsWith(".codexAppServerZoteroMcpToolsEnabled"))
            return false;
          if (key.endsWith(".codexAppServerPermissionState")) {
            return JSON.stringify({
              boundary: { kind: "profile", profileId: ":workspace" },
              approvalOverride: {
                policy: "on-request",
                reviewer: "auto_review",
              },
            });
          }
          return undefined;
        },
        prefHasUserValue: (key: string) =>
          key.endsWith(".codexAppServerPermissionState"),
      },
    };

    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
            params?: Record<string, unknown>;
          };
          const handleMessage = (
            proc as unknown as {
              handleMessage: (msg: Record<string, unknown>) => void;
            }
          ).handleMessage.bind(proc);
          if (request.method === "permissionProfile/list") {
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: {
                    data: [
                      {
                        id: ":workspace",
                        description: "Workspace",
                        allowed: true,
                      },
                    ],
                  },
                }),
              0,
            );
            return;
          }
          if (request.method === "experimentalFeature/list") {
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: {
                    data: [{ name: "guardian_approval", enabled: true }],
                  },
                }),
              0,
            );
            return;
          }
          if (request.method === "configRequirements/read") {
            setTimeout(() => handleMessage({ id: request.id, result: {} }), 0);
            return;
          }
          if (request.method === "thread/start") {
            threadStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { thread: { id: "thread-reviewer" } },
                }),
              0,
            );
            return;
          }
          if (request.method === "turn/start") {
            turnStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { turn: { id: "turn-reviewer" } },
                }),
              0,
            );
            setTimeout(
              () =>
                handleMessage({
                  method: "turn/completed",
                  params: {
                    turn: { id: "turn-reviewer", status: "completed" },
                  },
                }),
              5,
            );
            return;
          }
          if (request.method === "thread/read") {
            setTimeout(
              () => handleMessage({ id: request.id, result: { turns: [] } }),
              0,
            );
          }
        },
      },
      kill: () => {},
    });
    proc.isProtocolInitialized = () => true;
    CodexAppServerProcess.spawn = async () => proc;

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-native-reviewer-test",
          conversationKey: 6_000_000_034,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Run a safe check." }],
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => undefined,
        },
        processKey,
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      destroyCachedCodexAppServerProcess(processKey, proc);
    }

    assert.equal(threadStartParams?.approvalPolicy, "on-request");
    assert.equal(threadStartParams?.approvalsReviewer, "auto_review");
    assert.notProperty(turnStartParams || {}, "approvalPolicy");
    assert.notProperty(turnStartParams || {}, "approvalsReviewer");
  });

  it("submits explicit skill selections as structured native Codex skill inputs", async function () {
    setUserSkills([
      parseSkill(BUILTIN_SKILL_FILES["analyze-figures.md"]),
      parseSkill(BUILTIN_SKILL_FILES["evidence-based-qa.md"]),
    ]);
    const processKey = "native-auto-skill-input-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = globalThis.Zotero;
    let skillsListParams: Record<string, unknown> | undefined;
    let threadStartParams: Record<string, unknown> | undefined;
    let turnStartParams: Record<string, unknown> | undefined;
    const activatedSkills: string[] = [];

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DataDirectory: { dir: "/tmp/lfz-native-auto-skill-data" },
      Profile: { dir: "/tmp/lfz-native-auto-skill-profile" },
      Prefs: {
        get: (key: string) =>
          key.endsWith(".codexAppServerZoteroMcpToolsEnabled")
            ? false
            : undefined,
      },
    };
    const expectedCwd = getUserSkillsRuntimeRootDir();
    const skillPath = `${expectedCwd}/.agents/skills/evidence-based-qa/SKILL.md`;

    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
            params?: Record<string, unknown>;
          };
          const handleMessage = (
            proc as unknown as {
              handleMessage: (msg: Record<string, unknown>) => void;
            }
          ).handleMessage.bind(proc);
          if (request.method === "skills/list") {
            skillsListParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: {
                    data: [
                      {
                        cwd: expectedCwd,
                        errors: [],
                        skills: [
                          {
                            name: "evidence-based-qa",
                            path: skillPath,
                            enabled: true,
                            description: "",
                            scope: "local",
                          },
                        ],
                      },
                    ],
                  },
                }),
              0,
            );
            return;
          }
          if (request.method === "thread/start") {
            threadStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { thread: { id: "thread-auto-skill" } },
                }),
              0,
            );
            return;
          }
          if (request.method === "turn/start") {
            turnStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { turn: { id: "turn-auto-skill" } },
                }),
              0,
            );
            setTimeout(
              () =>
                handleMessage({
                  method: "turn/completed",
                  params: {
                    turn: { id: "turn-auto-skill", status: "completed" },
                  },
                }),
              5,
            );
            return;
          }
          if (request.method === "thread/read") {
            setTimeout(
              () => handleMessage({ id: request.id, result: { turns: [] } }),
              0,
            );
          }
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-native-auto-skill-test",
          conversationKey: 6_000_000_032,
          libraryID: 1,
          kind: "paper",
          paperItemID: 10,
          activeContextItemId: 11,
          paperTitle: "Native Skills Paper",
        },
        model: "gpt-5.5",
        messages: [
          {
            role: "user",
            content: "what method did they use in this paper",
          },
        ],
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => undefined,
        },
        onSkillActivated: (skillId) => activatedSkills.push(skillId),
        processKey,
        skillContext: { forcedSkillIds: ["evidence-based-qa"] },
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      destroyCachedCodexAppServerProcess(processKey, proc);
    }

    assert.deepEqual(skillsListParams?.cwds, [expectedCwd]);
    const input = turnStartParams?.input as Record<string, unknown>[];
    assert.deepEqual(input[0], {
      type: "skill",
      name: "evidence-based-qa",
      path: skillPath,
    });
    const turnStartText = JSON.stringify(turnStartParams);
    assert.include(turnStartText, "what method did they use in this paper");
    assert.notInclude(turnStartText, "$evidence-based-qa");
    assert.notInclude(turnStartText, "$analyze-figures");
    assert.notInclude(
      JSON.stringify(threadStartParams),
      "LLM-for-Zotero skills active for this turn",
    );
    assert.notInclude(
      turnStartText,
      "LLM-for-Zotero skills active for this turn",
    );
    assert.deepEqual(activatedSkills, ["evidence-based-qa"]);
  });

  it("preserves explicit native skill text alongside structured skill input", async function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["write-note.md"])]);
    const processKey = "native-explicit-skill-input-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = globalThis.Zotero;
    let turnStartParams: Record<string, unknown> | undefined;

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DataDirectory: { dir: "/tmp/lfz-native-explicit-skill-data" },
      Profile: { dir: "/tmp/lfz-native-explicit-skill-profile" },
      Prefs: {
        get: (key: string) =>
          key.endsWith(".codexAppServerZoteroMcpToolsEnabled")
            ? false
            : undefined,
      },
    };
    const expectedCwd = getUserSkillsRuntimeRootDir();
    const skillPath = `${expectedCwd}/.agents/skills/write-note/SKILL.md`;

    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
            params?: Record<string, unknown>;
          };
          const handleMessage = (
            proc as unknown as {
              handleMessage: (msg: Record<string, unknown>) => void;
            }
          ).handleMessage.bind(proc);
          if (request.method === "skills/list") {
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: {
                    data: [
                      {
                        cwd: expectedCwd,
                        errors: [],
                        skills: [
                          {
                            name: "write-note",
                            path: skillPath,
                            enabled: true,
                            description: "",
                            scope: "local",
                          },
                        ],
                      },
                    ],
                  },
                }),
              0,
            );
            return;
          }
          if (request.method === "thread/start") {
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { thread: { id: "thread-explicit-skill" } },
                }),
              0,
            );
            return;
          }
          if (request.method === "turn/start") {
            turnStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { turn: { id: "turn-explicit-skill" } },
                }),
              0,
            );
            setTimeout(
              () =>
                handleMessage({
                  method: "turn/completed",
                  params: {
                    turn: { id: "turn-explicit-skill", status: "completed" },
                  },
                }),
              5,
            );
            return;
          }
          if (request.method === "thread/read") {
            setTimeout(
              () => handleMessage({ id: request.id, result: { turns: [] } }),
              0,
            );
          }
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-native-explicit-skill-test",
          conversationKey: 6_000_000_033,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.5",
        messages: [{ role: "user", content: "$write-note\n\nDraft a note." }],
        skillContext: { forcedSkillIds: ["write-note"] },
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => undefined,
        },
        processKey,
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      destroyCachedCodexAppServerProcess(processKey, proc);
    }

    const input = turnStartParams?.input as Record<string, unknown>[];
    assert.deepEqual(input[0], {
      type: "skill",
      name: "write-note",
      path: skillPath,
    });
    const turnStartText = JSON.stringify(turnStartParams);
    assert.include(turnStartText, "Draft a note.");
    assert.include(turnStartText, "$write-note");
  });

  it("does not duplicate an explicit skill marker when structured resolution falls back", async function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["write-note.md"])]);
    const processKey = "native-explicit-skill-fallback-dedupe";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-explicit-skill-fallback"],
      requests,
      skillsListResult: { data: [] },
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("native");
    CodexAppServerProcess.spawn = async () => proc;

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-native-explicit-skill-fallback",
          conversationKey: 6_000_000_034,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.5",
        messages: [{ role: "user", content: "$write-note\n\nDraft a note." }],
        skillContext: { forcedSkillIds: ["write-note"] },
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => undefined,
        },
        processKey,
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    assert.isTrue(requests.some((request) => request.method === "skills/list"));
    const turnStart = requests.find(
      (request) => request.method === "turn/start",
    );
    const turnStartText = JSON.stringify(turnStart?.params.input);
    assert.equal(turnStartText.split("$write-note").length - 1, 1);
  });

  it("applies a fallback skill marker to the current turn when legacy history contains an older marker", async function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["write-note.md"])]);
    const processKey = "native-explicit-skill-fallback-current-turn";
    const requests: Array<{
      method: string;
      params: Record<string, any>;
    }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["thread-explicit-skill-fallback-current-turn"],
      requests,
      skillsListResult: { data: [] },
    });
    proc.setInjectItemsSupport("unsupported");
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("native");
    CodexAppServerProcess.spawn = async () => proc;

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-native-explicit-skill-fallback-history",
          conversationKey: 6_000_000_035,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.5",
        messages: [
          { role: "user", content: "$write-note\n\nEarlier request." },
          { role: "assistant", content: "Earlier response." },
          { role: "user", content: "Current request." },
        ],
        skillContext: { forcedSkillIds: ["write-note"] },
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => undefined,
        },
        processKey,
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }

    const turnStart = requests.find(
      (request) => request.method === "turn/start",
    );
    const textInputs = (turnStart?.params.input || []).filter(
      (entry: Record<string, unknown>) => entry.type === "text",
    );
    const currentUserInput = textInputs.at(-1)?.text as string;
    assert.include(currentUserInput, "User:\nCurrent request.");
    assert.equal(currentUserInput.split("$write-note").length - 1, 1);
  });

  it("starts native Codex turns from the profile-scoped skills workspace and omits legacy skill injection", async function () {
    const processKey = "native-skills-cwd-turn-test";
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalZotero = globalThis.Zotero;
    let threadStartParams: Record<string, unknown> | undefined;
    let turnStartParams: Record<string, unknown> | undefined;

    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DataDirectory: { dir: "/tmp/lfz-native-skills-data" },
      Profile: { dir: "/tmp/lfz-native-skills-profile" },
      Prefs: {
        get: (key: string) =>
          key.endsWith(".codexAppServerZoteroMcpToolsEnabled")
            ? false
            : undefined,
      },
    };
    const expectedCwd = getUserSkillsRuntimeRootDir();

    const proc = CodexAppServerProcess.forTest({
      stdin: {
        write: (chunk: string) => {
          const request = JSON.parse(chunk) as {
            id: number;
            method: string;
            params?: Record<string, unknown>;
          };
          const handleMessage = (
            proc as unknown as {
              handleMessage: (msg: Record<string, unknown>) => void;
            }
          ).handleMessage.bind(proc);
          if (request.method === "thread/start") {
            threadStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { thread: { id: "thread-skills-cwd" } },
                }),
              0,
            );
            return;
          }
          if (request.method === "turn/start") {
            turnStartParams = request.params;
            setTimeout(
              () =>
                handleMessage({
                  id: request.id,
                  result: { turn: { id: "turn-skills-cwd" } },
                }),
              0,
            );
            setTimeout(
              () =>
                handleMessage({
                  method: "turn/completed",
                  params: {
                    turn: { id: "turn-skills-cwd", status: "completed" },
                  },
                }),
              5,
            );
            return;
          }
          if (request.method === "thread/read") {
            setTimeout(
              () => handleMessage({ id: request.id, result: { turns: [] } }),
              0,
            );
          }
        },
      },
      kill: () => {},
    });
    CodexAppServerProcess.spawn = async () => proc;

    try {
      await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-native-skills-cwd-test",
          conversationKey: 6_000_000_031,
          libraryID: 1,
          kind: "global",
        },
        model: "gpt-5.5",
        messages: [{ role: "user", content: "$write-note\n\nDraft a note." }],
        hooks: {
          loadProviderSessionId: async () => undefined,
          persistProviderSessionId: async () => undefined,
        },
        processKey,
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
        originalZotero;
      destroyCachedCodexAppServerProcess(processKey, proc);
    }

    assert.equal(threadStartParams?.cwd, expectedCwd);
    assert.equal(turnStartParams?.cwd, expectedCwd);
    assert.include(String(threadStartParams?.cwd), "/agent-runtime/");
    const threadStartText = JSON.stringify(threadStartParams);
    const turnStartText = JSON.stringify(turnStartParams);
    assert.notInclude(
      threadStartText,
      "LLM-for-Zotero skills active for this turn",
    );
    assert.notInclude(
      turnStartText,
      "LLM-for-Zotero skills active for this turn",
    );
  });

  it("does not contain the removed Codex native resource lifecycle states", function () {
    const source = readFileSync(
      resolve(here, "../src/codexAppServer/nativeClient.ts"),
      "utf8",
    );

    assert.notInclude(source, "thin-followup");
    assert.notInclude(source, "resources-delta");
    assert.notInclude(source, "resources-changed");
    assert.notInclude(source, "CodexNativeLifecycle");
    assert.notInclude(source, "runtimeWorkspaceRoots");
  });

  it("builds Codex native scoped MCP payload with canonical paper contexts", function () {
    const selectedPaper = {
      itemId: 11,
      contextItemId: 12,
      title: "Selected Native Paper",
      attachmentTitle: "Selected Native PDF",
      citationKey: "nativeSelected2026",
      firstCreator: "Ng",
      year: "2026",
      contentSourceMode: "mineru" as const,
      mineruCacheDir: "/tmp/mineru-cache/native-selected",
    };
    const fullTextPaper = {
      itemId: 21,
      contextItemId: 22,
      title: "Full Text Native Paper",
      attachmentTitle: "Full Text Native PDF",
      firstCreator: "Lee",
      year: "2025",
      contentSourceMode: "markdown" as const,
      mineruCacheDir: "/tmp/mineru-cache/native-full-text",
    };
    const pinnedPaper = {
      itemId: 31,
      contextItemId: 32,
      title: "Pinned Native Paper",
      attachmentTitle: "Pinned Native PDF",
      firstCreator: "Chen",
      year: "2024",
      contentSourceMode: "text" as const,
      mineruCacheDir: "/tmp/mineru-cache/native-pinned",
    };

    const executionContext = {
      version: 1 as const,
      executionId: "codex-native-context",
      conversationKey: 1,
      conversationGeneration: 0,
      chatLibraryID: 1,
      permissionOwner: "external_runtime" as const,
      workspaceSnapshot: {
        selectedPapers: [],
        selectedCollections: [],
      },
      configuredAccess: { libraryIDs: [1], outputDirectories: [] },
    };
    const scope = buildCodexNativeScopedMcpScopeForTests({
      executionContext,
      scope: {
        conversationKey: 1,
        libraryID: 1,
        kind: "global",
      },
      profileSignature: "profile-native-paper-scope",
      userText: "read these papers",
      model: "gpt-5.5",
      codexPath: "/tmp/codex-native",
      reasoning: { provider: "openai", level: "high" },
      skillContext: {
        selectedPaperContexts: [selectedPaper],
        fullTextPaperContexts: [fullTextPaper],
        pinnedPaperContexts: [pinnedPaper],
        selectedCollectionContexts: [
          { collectionId: 9, libraryID: 1, name: "Native Collection" },
        ],
        selectedTagContexts: [
          { name: "Stable", normalizedName: "stable", libraryID: 1 },
        ],
      },
    });

    assert.deepEqual(scope.turnPaperScope?.papers, [
      {
        paper: { ...selectedPaper, libraryID: 1 },
        roles: ["selected"],
      },
      {
        paper: { ...fullTextPaper, libraryID: 1, citationKey: undefined },
        roles: ["full_text"],
      },
      {
        paper: { ...pinnedPaper, libraryID: 1, citationKey: undefined },
        roles: ["pinned"],
      },
    ]);
    assert.deepEqual(scope.turnPaperScope?.collections, [
      { collectionId: 9, libraryID: 1, name: "Native Collection" },
    ]);
    assert.deepEqual(scope.turnPaperScope?.tags, [
      {
        name: "Stable",
        normalizedName: "stable",
        libraryID: 1,
        scope: undefined,
        includeAutomatic: undefined,
      },
    ]);
    assert.equal(scope.model, "gpt-5.5");
    assert.equal(scope.codexPath, "/tmp/codex-native");
    assert.equal(scope.exhaustiveReadBackend, "codex_responses");
    assert.deepEqual(scope.executionContext, executionContext);
    assert.deepEqual(scope.reasoning, {
      provider: "openai",
      level: "high",
    });
  });

  it("records successful native paper reads for context reuse hints", function () {
    const scope = {
      profileSignature: "profile-ledger-test",
      conversationKey: 6_000_000_010,
      libraryID: 1,
      kind: "paper" as const,
      paperItemID: 42,
      activeContextItemId: 99,
      paperTitle: "Ledger Paper",
    };
    const baseEvent = {
      requestId: "read-1",
      phase: "completed" as const,
      serverName: "llm_for_zotero",
      profileSignature: "profile-ledger-test",
      conversationKey: 6_000_000_010,
      timestamp: 1000,
    };

    recordCodexNativeReadActivity({
      threadId: "thread-ledger",
      scope,
      event: {
        ...baseEvent,
        toolName: "paper_read",
        toolLabel: "Read Paper",
        arguments: { mode: "targeted", query: "method" },
        ok: true,
      },
    });
    recordCodexNativeReadActivity({
      threadId: "thread-ledger",
      scope,
      event: {
        ...baseEvent,
        requestId: "read-2",
        toolName: "paper_read",
        toolLabel: "Read Paper",
        arguments: { mode: "targeted", query: "method" },
        ok: true,
        timestamp: 1100,
      },
    });
    // MCP never exposes a retired primitive, so a retired name is not a read.
    recordCodexNativeReadActivity({
      threadId: "thread-ledger",
      scope,
      event: {
        ...baseEvent,
        requestId: "retired-read",
        toolName: "view_pdf_pages",
        toolLabel: "Retired View",
        arguments: { pages: [3] },
        ok: true,
        timestamp: 1150,
      },
    });
    recordCodexNativeReadActivity({
      threadId: "thread-ledger",
      scope,
      event: {
        ...baseEvent,
        requestId: "search-failed",
        toolName: "search_paper",
        toolLabel: "Search Paper",
        arguments: { question: "failed search" },
        ok: false,
        timestamp: 1200,
      },
    });
    recordCodexNativeReadActivity({
      threadId: "thread-ledger",
      scope,
      event: {
        ...baseEvent,
        requestId: "write-file",
        toolName: "file_io",
        toolLabel: "File I/O",
        arguments: {
          action: "write",
          filePath: "/tmp/llm-for-zotero-mineru/paper/full.md",
        },
        ok: true,
        timestamp: 1300,
      },
    });
    recordCodexNativeReadActivity({
      threadId: "thread-ledger",
      scope,
      event: {
        ...baseEvent,
        requestId: "read-mineru",
        toolName: "file_io",
        toolLabel: "File I/O",
        arguments: {
          action: "read",
          filePath: "/tmp/llm-for-zotero-mineru/paper/full.md",
          offset: 25,
          length: 500,
        },
        ok: true,
        timestamp: 1400,
      },
    });

    const block = buildCodexNativePriorReadContextBlock({
      profileSignature: "profile-ledger-test",
      conversationKey: 6_000_000_010,
      threadId: "thread-ledger",
    });
    assert.include(block, "Already inspected in this Codex thread");
    assert.include(block, "Ledger Paper");
    assert.include(block, "Read Paper");
    assert.include(block, "mode=targeted");
    assert.include(block, 'query="method"');
    assert.include(block, "2x");
    assert.notInclude(block, "Retired View");
    assert.include(block, "Read MinerU full.md");
    assert.include(block, "offset=25");
    assert.notInclude(block, "failed search");
    assert.notInclude(block, "write-file");
  });
});

/**
 * What a Codex turn records about the effects Codex ran itself.
 *
 * Codex executes its own shell commands and file changes; the host only
 * answers the approval card. Before Phase 3 that decision left no receipt, so a
 * Codex turn's audit trail was silently shorter than an in-app one. These tests
 * pin the receipt each decision mints and the trace row that carries it.
 */
describe("Codex native approval effect receipts", function () {
  it("describes a command approval as a fingerprinted command effect", function () {
    const effect = describeCodexNativeApprovalEffect({
      method: "item/commandExecution/requestApproval",
      params: { command: "npm test", cwd: "/repo/example" },
    });
    assert.equal(effect?.source, "codex_native");
    assert.equal(effect?.operation, "command_execute");
    assert.match(
      String(effect?.requestedTargets[0]),
      /^command:fnv1a32:[0-9a-f]{8}$/,
    );
  });

  it("describes a file-change approval by the paths the card showed", function () {
    const effect = describeCodexNativeApprovalEffect({
      method: "item/fileChange/requestApproval",
      params: {
        changes: {
          "/repo/example/notes.md": { kind: "update" },
          "/repo/example/new.md": { kind: "add" },
        },
      },
    });
    assert.equal(effect?.operation, "file_write");
    assert.deepEqual(effect?.requestedTargets, [
      "file:/repo/example/notes.md",
      "file:/repo/example/new.md",
    ]);
  });

  it("describes the legacy approval methods as the same two effects", function () {
    assert.equal(
      describeCodexNativeApprovalEffect({
        method: "execCommandApproval",
        params: { command: "ls" },
      })?.operation,
      "command_execute",
    );
    assert.equal(
      describeCodexNativeApprovalEffect({
        method: "applyPatchApproval",
        params: { path: "/repo/patched.md" },
      })?.operation,
      "file_write",
    );
  });

  it("describes no effect for requests that change nothing by themselves", function () {
    assert.isNull(
      describeCodexNativeApprovalEffect({
        method: "item/permissions/requestApproval",
        params: { permissions: { fileSystem: { write: ["/repo"] } } },
      }),
      "granting a permission is not itself a file change or a command",
    );
    assert.isNull(
      describeCodexNativeApprovalEffect({
        method: "item/tool/requestUserInput",
        params: { questions: [{ id: "q", question: "Which?" }] },
      }),
    );
  });

  async function runApprovedCommandTurn(approved: boolean): Promise<{
    events: any[];
    responses: any[];
  }> {
    const events: any[] = [];
    const responses: any[] = [];
    const requests: Array<{ method: string; params: Record<string, any> }> = [];
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["approval-receipt-thread"],
      requests,
      onServerResponse: (message) => responses.push(message),
      onTurn: ({ threadId, turnId, emit }) => {
        emit({
          id: 9101,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId,
            turnId,
            itemId: "cmd-1",
            command: "npm test",
            cwd: "/repo/example",
          },
        });
        setTimeout(
          () =>
            emit({
              method: "turn/completed",
              params: { turn: { id: turnId, status: "completed" } },
            }),
          20,
        );
      },
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs();
    const processKey = "codex-approval-receipt";
    const globalScope = globalThis as typeof globalThis & {
      ztoolkit?: { log: (...args: unknown[]) => void };
    };
    const originalZtoolkit = globalScope.ztoolkit;
    globalScope.ztoolkit = { log: () => undefined };
    CodexAppServerProcess.spawn = async () => proc;
    try {
      await runCodexAppServerNativeTurn({
        scope: {
          conversationKey: 6_000_000_400,
          libraryID: 1,
          kind: "global",
          title: "Approval receipts",
        },
        model: "gpt-5.6",
        messages: [{ role: "user", content: "Run the tests" }],
        processKey,
        eventJournal: {
          runId: "codex-approval-run",
          append: async (event) => {
            events.push(event);
          },
          finish: async () => {},
        },
        onApprovalRequest: async () =>
          approved ? { decision: "accept" } : { decision: "decline" },
        hooks: {
          loadProviderSessionId: async () => null,
          persistProviderSession: async () => {},
        },
      });
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
      globalScope.ztoolkit = originalZtoolkit;
    }
    return { events, responses };
  }

  it("records an approved Codex command as an execution_only receipt on the run", async function () {
    const { events, responses } = await runApprovedCommandTurn(true);
    assert.deepEqual(
      responses.find((entry) => entry.id === 9101)?.result,
      { decision: "accept" },
      JSON.stringify(responses),
    );
    const activity = events.find(
      (event) =>
        event.type === "codex_tool_activity" && event.actionReceipts?.length,
    );
    assert.isObject(
      activity,
      `no receipt activity in ${JSON.stringify(events)}`,
    );
    const receipt = activity.actionReceipts[0];
    assert.equal(receipt.operation, "command_execute");
    assert.equal(receipt.proofDomain, "execution");
    assert.equal(receipt.verification, "execution_only");
    assert.equal(receipt.status, "observed");
    assert.equal(receipt.executionAuthority, "external_runtime");
    assert.match(
      String(receipt.requestedTargets[0]),
      /^command:fnv1a32:[0-9a-f]{8}$/,
    );
  });

  it("records a denied Codex command as cancelled with no proof claimed", async function () {
    const { events } = await runApprovedCommandTurn(false);
    const activity = events.find(
      (event) =>
        event.type === "codex_tool_activity" && event.actionReceipts?.length,
    );
    assert.isObject(
      activity,
      `no receipt activity in ${JSON.stringify(events)}`,
    );
    const receipt = activity.actionReceipts[0];
    assert.equal(receipt.status, "cancelled");
    assert.equal(receipt.verification, "not_applicable");
    assert.deepEqual(receipt.appliedTargets, []);
  });
});

describe("Codex MCP tool activity bridge", function () {
  it("stamps the server and mutability onto every MCP row it forwards", function () {
    // Without these the trace has to guess which server ran a call from its
    // tool name, which is exactly the shadow taxonomy the stage model removes.
    const event = buildCodexMcpToolActivityEvent({
      requestId: "jsonrpc:7",
      phase: "completed",
      toolName: "note_write",
      toolLabel: "Write note",
      serverName: "llm_for_zotero",
      mutability: "write",
      workCategory: "zotero_action",
      arguments: { text: "hello" },
      ok: true,
      timestamp: 3,
    });
    assert.equal(event.type, "codex_tool_activity");
    if (event.type !== "codex_tool_activity") return;
    assert.equal(event.itemId, "jsonrpc:7");
    assert.equal(event.serverName, "llm_for_zotero");
    assert.equal(event.mutability, "write");
    assert.equal(event.toolLabel, "Write note");
    assert.equal(event.workCategory, "zotero_action");
    assert.deepEqual(event.args, { text: "hello" });
  });

  it("joins an MCP request to the native item the model called it from", function () {
    // The app server names a tool call by the model's own call id; the Zotero
    // MCP server names the same call by the JSON-RPC id it was asked with.
    // Only this client sees both, so it is the one that pairs them.
    const correlation = createCodexNativeMcpCallCorrelatorForTests(
      "llm_for_zotero_profile_abc",
    );
    const item = (id: string) =>
      correlation.correlateItem({
        id,
        type: "mcp_tool_call",
        serverName: "llm_for_zotero_profile_abc",
        toolName: "query_library",
      });
    const request = (requestId: string) =>
      correlation.correlateRequest({ requestId, toolName: "query_library" });

    const first = request("jsonrpc:1");
    assert.isString(first);
    assert.equal(
      request("jsonrpc:1"),
      first,
      "the completed phase resolves to the same call as the started phase",
    );
    assert.equal(item("call_A"), first);
    assert.equal(item("call_A"), first, "an item keeps the key it was given");

    // The next call of the same tool starts only once that one closed.
    const second = request("jsonrpc:2");
    assert.isString(second);
    assert.notEqual(second, first);
    assert.equal(item("call_B"), second, "two calls keep the model's order");
  });

  it("pairs the two streams whichever of them speaks first", function () {
    // The app server is not promised to announce a tool call before the call
    // reaches the Zotero server, so neither order may be assumed.
    const correlation = createCodexNativeMcpCallCorrelatorForTests(
      "llm_for_zotero_profile_abc",
    );
    const fromItem = correlation.correlateItem({
      id: "call_A",
      type: "mcp_tool_call",
      serverName: "llm_for_zotero_profile_abc",
      toolName: "query_library",
    });
    assert.equal(
      correlation.correlateRequest({
        requestId: "jsonrpc:1",
        toolName: "query_library",
      }),
      fromItem,
    );
  });

  it("pairs nothing it cannot pair, rather than guessing", function () {
    const correlation = createCodexNativeMcpCallCorrelatorForTests(
      "llm_for_zotero_profile_abc",
    );
    assert.isUndefined(
      correlation.correlateItem({
        id: "call_other",
        type: "mcp_tool_call",
        serverName: "some_other_server",
        toolName: "query_library",
      }),
      "another server's item is not this server's call",
    );
    assert.isUndefined(
      correlation.correlateItem({
        id: "call_cmd",
        type: "command_execution",
        toolName: "query_library",
      }),
      "work Codex ran itself never reached the Zotero server",
    );
    assert.isUndefined(
      createCodexNativeMcpCallCorrelatorForTests(undefined).correlateRequest({
        requestId: "jsonrpc:1",
        toolName: "query_library",
      }),
      "a turn with no Zotero server configured has nothing to pair",
    );
    const paired = correlation.correlateRequest({
      requestId: "jsonrpc:1",
      toolName: "query_library",
    });
    assert.notEqual(
      correlation.correlateRequest({
        requestId: "jsonrpc:2",
        toolName: "write_note",
      }),
      paired,
      "a different tool is a different call",
    );
  });

  it("refuses to pair two calls of one tool that are open at the same time", function () {
    // The item stream and the MCP observer are delivered independently, so
    // two concurrent calls of one tool cannot be ordered against each other.
    // Pairing them by arrival order would put one call's arguments in the
    // same row as the other call's receipts, which is worse than two rows.
    const correlation = createCodexNativeMcpCallCorrelatorForTests(
      "llm_for_zotero_profile_abc",
    );
    const first = correlation.correlateRequest({
      requestId: "jsonrpc:1",
      toolName: "query_library",
    });
    const second = correlation.correlateRequest({
      requestId: "jsonrpc:2",
      toolName: "query_library",
    });
    assert.isString(first);
    assert.isUndefined(
      second,
      "a second call opening while the first is unpaired is ambiguous",
    );

    const item = (id: string) =>
      correlation.correlateItem({
        id,
        type: "mcp_tool_call",
        serverName: "llm_for_zotero_profile_abc",
        toolName: "query_library",
      });
    const firstItem = item("call_A");
    assert.notEqual(
      firstItem,
      first,
      "an item must not claim a call the turn could not order it against",
    );
    assert.isUndefined(item("call_B"));
    assert.notEqual(firstItem, item("call_B"));

    // The turn recovers: a later call of the same tool pairs normally.
    const later = correlation.correlateRequest({
      requestId: "jsonrpc:3",
      toolName: "query_library",
    });
    assert.isString(later);
    assert.equal(item("call_C"), later);
  });

  it("carries the paired call onto the row the panel merges by", function () {
    const event = buildCodexMcpToolActivityEvent(
      {
        requestId: "jsonrpc:7",
        phase: "started",
        toolName: "query_library",
        serverName: "llm_for_zotero",
        timestamp: 3,
      } as never,
      "codex-call:1",
    );
    assert.equal(event.type, "codex_tool_activity");
    if (event.type !== "codex_tool_activity") return;
    assert.equal(
      event.itemId,
      "codex-call:1",
      "the row is keyed by the call, not by the transport request",
    );
  });

  it("labels a connected-runtime effect from the shared category table", function () {
    const event = buildCodexNativeEffectActivityEvent({
      effect: {
        runtime: "codex_native",
        kind: "command",
        command: "npm test",
        requestedTargets: [],
      } as never,
      outcome: "executed",
      callId: "cmd-9",
      receipt: { id: "receipt-cmd-9" } as never,
    });
    assert.equal(event.type, "codex_tool_activity");
    if (event.type !== "codex_tool_activity") return;
    assert.equal(event.workCategory, CONNECTED_RUNTIME_EFFECT_WORK_CATEGORY);
  });
});

describe("Codex native requests of two conversations on one process", function () {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  type TestProcess = CodexAppServerProcess & {
    handleMessage: (msg: Record<string, unknown>) => void;
  };
  function createRoutingProcess(writes: Array<Record<string, any>>) {
    return CodexAppServerProcess.forTest({
      stdin: { write: (line: string) => writes.push(JSON.parse(line)) },
      kill: () => {},
    }) as TestProcess;
  }

  it("answers each approval from the turn that owns its thread", async function () {
    const writes: Array<Record<string, any>> = [];
    const proc = createRoutingProcess(writes);
    const asked: string[] = [];
    const register = (threadId: string, decision: string) =>
      registerNativeApprovalRequestHandlersForTests({
        proc,
        onApprovalRequest: async (request) => {
          asked.push(`${threadId}:${(request.params as any).threadId}`);
          return { decision };
        },
        getTurnIdentity: async () => ({ threadId, turnId: `turn-${threadId}` }),
        getActiveThreadId: () => threadId,
      });
    register("thread-A", "accept");
    register("thread-B", "decline");
    proc.handleMessage({
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-B", turnId: "turn-thread-B", itemId: "b" },
    });
    proc.handleMessage({
      id: 2,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-A", turnId: "turn-thread-A", itemId: "a" },
    });
    await tick();
    await tick();
    assert.sameMembers(asked, ["thread-A:thread-A", "thread-B:thread-B"]);
    assert.deepEqual(writes.find((message) => message.id === 1)?.result, {
      decision: "decline",
    });
    assert.deepEqual(writes.find((message) => message.id === 2)?.result, {
      decision: "accept",
    });
  });

  it("keeps another conversation's pending approval when one turn ends", async function () {
    const writes: Array<Record<string, any>> = [];
    const proc = createRoutingProcess(writes);
    const signals: Record<string, AbortSignal> = {};
    const register = (threadId: string) =>
      registerNativeApprovalRequestHandlersForTests({
        proc,
        onApprovalRequest: (request) => {
          signals[threadId] = request.signal!;
          return new Promise(() => {});
        },
        getTurnIdentity: async () => ({ threadId, turnId: `turn-${threadId}` }),
        getActiveThreadId: () => threadId,
      });
    const disposeA = register("thread-A");
    register("thread-B");
    for (const threadId of ["thread-A", "thread-B"]) {
      proc.handleMessage({
        id: `question-${threadId}`,
        method: "item/fileChange/requestApproval",
        params: { threadId, turnId: `turn-${threadId}`, itemId: threadId },
      });
    }
    await tick();
    await tick();
    disposeA();
    assert.isTrue(signals["thread-A"]?.aborted);
    assert.isFalse(signals["thread-B"]?.aborted);
    assert.isTrue(proc.hasPendingUserInput("thread-B"));
    proc.destroy();
  });

  it("overrides a guardian denial only for its own thread", async function () {
    const writes: Array<Record<string, any>> = [];
    const proc = createRoutingProcess(writes);
    registerNativeGuardianReviewHandlersForTests({
      proc,
      threadId: "thread-A",
    });
    const deniedReview = (threadId: string) => ({
      method: "item/autoApprovalReview/completed",
      params: {
        threadId,
        turnId: `turn-${threadId}`,
        review: { status: "denied" },
        action: {
          type: "mcp_tool_call",
          server: "llm_for_zotero_profile_1234",
          tool_name: "library_search",
        },
      },
    });
    proc.handleMessage(deniedReview("thread-B"));
    await tick();
    assert.notExists(
      writes.find(
        (message) => message.method === "thread/approveGuardianDeniedAction",
      ),
    );
    proc.handleMessage(deniedReview("thread-A"));
    await tick();
    const approvals = writes.filter(
      (message) => message.method === "thread/approveGuardianDeniedAction",
    );
    assert.lengthOf(approvals, 1);
    assert.equal(approvals[0].params.threadId, "thread-A");
    proc.handleMessage({ id: approvals[0].id, result: {} });
  });
});

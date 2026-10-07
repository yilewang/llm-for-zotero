/**
 * How a native Codex turn settles at its end: the action contract the turn's
 * receipts prove, the document it submitted, the event that reports an
 * unverified completion, the raw-PDF thread archive, and the journal finish.
 *
 * These pin the observable sequence through the real native client, so the
 * shared settlement rule can move without changing what is stored.
 */
import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import { runCodexAppServerNativeTurn } from "./helpers/preparedNativeTurn";
import {
  createNativeLifecycleTestProcess,
  installDirectPathTestPrefs,
} from "./helpers/codexNativeLifecycle";
import { resetCodexNativePathSafetyStateForTests } from "../src/codexAppServer/nativeClient";
import { clearCodexNativeReadLedger } from "../src/codexAppServer/nativeContextLedger";
import {
  CodexAppServerProcess,
  destroyCachedCodexAppServerProcess,
} from "../src/utils/codexAppServerProcess";
import {
  invokeRegisteredZoteroMcpEndpoint,
  registerMcpServer,
  resolveConversationScopeToken,
  unregisterMcpServer,
  ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../src/agent/mcp/server";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createFileIOTool } from "../src/agent/tools/write/fileIO";
import { getCodexProfileSignature } from "../src/codexAppServer/constants";
import type { AgentEvent } from "../src/agent/types";

const RAW_ANSWER = "The provider's own answer.";
const DOCUMENT_MARKDOWN = "# Report\n\nThe submitted document.";

function storedDocumentPayload(documentId: string, conversationKey: number) {
  return JSON.stringify({
    version: 2,
    documentId,
    documentVersion: 1,
    documentKind: "report",
    integrityPolicy: "authored",
    origin: {
      kind: "direct",
      runId: "turn-lifecycle-1",
      sourceMessageTimestamp: 10,
    },
    conversationKey,
    title: "Report",
    visibleMarkdown: DOCUMENT_MARKDOWN,
    visibleHtml: "<h1>Report</h1><p>The submitted document.</p>",
    citationBundle: {
      clusters: [],
      bibliographyEntries: [],
      style: { id: "apa", title: "APA" },
      locale: "en-US",
    },
    verifiedQuotes: [],
    assets: [],
    coverageItems: [],
    validation: {
      integrityValidated: true,
      groundingReviewed: "not_run",
      quoteVerified: "not_applicable",
      issues: [],
    },
    contentHash: "sha256:document",
    createdAt: 10,
  });
}

const unverifiedEvents = (events: AgentEvent[]) =>
  events.filter(
    (event) =>
      event.type === "provider_event" &&
      event.providerType === "agent_completion_unverified",
  );

type SettlementRun = {
  journal: AgentEvent[];
  hostEvents: AgentEvent[];
  finished: Array<{ status: string; text?: string }>;
  /** Journal appends of the unverified report, and the finish, in order. */
  sequence: string[];
  documentLookups: unknown[];
  result: Awaited<ReturnType<typeof runCodexAppServerNativeTurn>>;
};

/**
 * One native turn with Zotero MCP enabled. The client streams RAW_ANSWER,
 * then calls each named MCP tool, then completes the turn.
 */
async function runSettlementTurn(params: {
  conversationKey: number;
  calls: Array<"submit_document" | "run_command" | "library_read">;
  documentStored: boolean;
}): Promise<SettlementRun> {
  const restorePrefs = installDirectPathTestPrefs();
  const originalSpawn = CodexAppServerProcess.spawn;
  const originalZotero = (globalThis as never as { Zotero: any }).Zotero;
  const bearer = "settlement-test-bearer-0123456789abcdef";
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
  registry.register({
    spec: {
      name: "submit_document",
      description: "Submit fixture",
      inputSchema: { type: "object", additionalProperties: true },
      executionClass: "control",
      requiresConfirmation: false,
    },
    validate: (args) => ({ ok: true, value: args ?? {} }),
    execute: async () => ({ content: { documentId: "codex-document-1" } }),
  } as never);
  // Registered for MCP readiness only; no turn here calls it.
  registry.register(createFileIOTool());
  // A host command that fails: its receipt is a failed delegated effect, so
  // the turn's action contract is not satisfied.
  registry.register({
    describeAction: () => [
      {
        id: "command_execute:settlement",
        proofDomain: "execution",
        capability: "command.execute",
        operation: "command_execute",
        source: "command",
        parameters: { commandFingerprint: "settlement" },
        requestedTargets: [],
        destinationCollectionIds: [],
      },
    ],
    effectOperations: ["command_execute"],
    spec: {
      name: "run_command",
      description: "Command fixture",
      inputSchema: { type: "object", additionalProperties: true },
      executionClass: "external_effect",
      requiresConfirmation: false,
    },
    validate: (args) => ({ ok: true, value: args ?? {} }),
    execute: async () => {
      throw new Error("command fixture failed");
    },
  } as never);
  const documentLookups: unknown[] = [];
  (globalThis as never as { Zotero: any }).Zotero = {
    ...originalZotero,
    Server: { Endpoints: {} },
    Libraries: { userLibraryID: 1 },
    Items: { get: () => null },
    DB: {
      queryAsync: async (sql: string, args: unknown[] = []) => {
        if (/WHERE run_id = \? ORDER BY created_at DESC/.test(sql)) {
          documentLookups.push(args[0]);
          return params.documentStored
            ? [
                {
                  documentId: "codex-document-1",
                  payloadJson: storedDocumentPayload(
                    "codex-document-1",
                    params.conversationKey,
                  ),
                },
              ]
            : [];
        }
        if (/WHERE document_id = \? LIMIT 1/.test(sql)) {
          return [
            {
              payloadJson: storedDocumentPayload(
                String(args[0]),
                params.conversationKey,
              ),
            },
          ];
        }
        return [];
      },
    },
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
  const scopeToken = resolveConversationScopeToken({
    profileSignature: getCodexProfileSignature(),
    conversationKey: params.conversationKey,
  });
  const callTool = async (name: string, id: number) => {
    await invokeRegisteredZoteroMcpEndpoint({
      method: "POST",
      data: {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      },
      headers: {
        [ZOTERO_MCP_SCOPE_HEADER]: scopeToken,
        Authorization: `Bearer ${bearer}`,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const journal: AgentEvent[] = [];
  const hostEvents: AgentEvent[] = [];
  const finished: Array<{ status: string; text?: string }> = [];
  const sequence: string[] = [];
  const processKey = `native-settlement-${params.conversationKey}`;
  const proc = createNativeLifecycleTestProcess({
    newThreadIds: [`settlement-thread-${params.conversationKey}`],
    requests: [],
    onTurn: ({ threadId, turnId, emit }) => {
      void (async () => {
        emit({
          method: "item/agentMessage/delta",
          params: { threadId, turnId, delta: RAW_ANSWER },
        });
        let id = 1;
        for (const name of params.calls) await callTool(name, id++);
        emit({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed" } },
        });
      })();
    },
  });
  CodexAppServerProcess.spawn = async () => proc;
  try {
    const result = await runCodexAppServerNativeTurn({
      scope: {
        conversationKey: params.conversationKey,
        libraryID: 1,
        kind: "global",
      },
      model: "gpt-5.6",
      messages: [{ role: "user", content: "Write the report" }],
      processKey,
      eventJournal: {
        runId: "host-settlement-run",
        append: async (event: AgentEvent) => {
          journal.push(event);
          if (unverifiedEvents([event]).length) sequence.push("unverified");
        },
        finish: async (status: string, text?: string) => {
          finished.push({ status, text });
          sequence.push(`finish:${status}`);
        },
      },
      onHostEvent: (event: AgentEvent) => {
        hostEvents.push(event);
      },
      hooks: {
        loadProviderSessionId: async () => null,
        persistProviderSession: async () => {},
      },
    } as never);
    return {
      journal,
      hostEvents,
      finished,
      sequence,
      documentLookups,
      result,
    };
  } finally {
    unregisterMcpServer();
    CodexAppServerProcess.spawn = originalSpawn;
    destroyCachedCodexAppServerProcess(processKey, proc);
    (globalThis as never as { Zotero: any }).Zotero = originalZotero;
    restorePrefs();
  }
}

describe("Codex native turn settlement", function () {
  this.timeout(15000);

  afterEach(function () {
    resetCodexNativePathSafetyStateForTests();
    clearCodexNativeReadLedger();
  });

  it("finishes a satisfied turn as completed with the provider's text", async function () {
    const run = await runSettlementTurn({
      conversationKey: 6_000_000_901,
      calls: ["library_read"],
      documentStored: true,
    });
    assert.equal(run.result.text, RAW_ANSWER);
    assert.isUndefined(run.result.documentId);
    assert.isUndefined(run.result.verificationFailure);
    assert.isEmpty(unverifiedEvents(run.journal));
    assert.isEmpty(
      run.documentLookups,
      "no submit_document call, so no document is loaded",
    );
    assert.deepEqual(run.finished, [{ status: "completed", text: RAW_ANSWER }]);
    assert.equal(run.result.agentRunId, "host-settlement-run");
  });

  it("speaks the submitted document, loaded by the Codex turn id", async function () {
    const run = await runSettlementTurn({
      conversationKey: 6_000_000_902,
      calls: ["submit_document"],
      documentStored: true,
    });
    assert.deepEqual(run.documentLookups, ["turn-lifecycle-1"]);
    assert.equal(run.result.text, DOCUMENT_MARKDOWN);
    assert.equal(run.result.documentId, "codex-document-1");
    assert.isEmpty(unverifiedEvents(run.journal));
    assert.deepEqual(run.finished, [
      { status: "completed", text: DOCUMENT_MARKDOWN },
    ]);
  });

  it("keeps the provider's text when the submitted document is not stored", async function () {
    const run = await runSettlementTurn({
      conversationKey: 6_000_000_903,
      calls: ["submit_document"],
      documentStored: false,
    });
    assert.deepEqual(run.documentLookups, ["turn-lifecycle-1"]);
    assert.equal(run.result.text, RAW_ANSWER);
    assert.isUndefined(run.result.documentId);
    assert.deepEqual(run.finished, [{ status: "completed", text: RAW_ANSWER }]);
  });

  it("replaces the answer with the failure and finishes failed when the action is unverified", async function () {
    const run = await runSettlementTurn({
      conversationKey: 6_000_000_904,
      calls: ["run_command"],
      documentStored: true,
    });
    const [event] = unverifiedEvents(run.journal);
    assert.exists(event, "the unverified completion was not journaled");
    const failure = (event as { payload: { failure: string } }).payload.failure;
    assert.match(
      failure,
      /^Delegated action results:\n\[Action status: command_execute — failed/,
    );
    assert.deepEqual(
      Object.keys((event as { payload: object }).payload),
      ["failure"],
      "Codex reports the failure under its own payload key",
    );
    assert.deepEqual(unverifiedEvents(run.hostEvents), [event]);
    assert.equal(run.result.text, failure);
    assert.equal(run.result.verificationFailure, failure);
    assert.isUndefined(run.result.documentId);
    assert.isEmpty(run.documentLookups);
    assert.deepEqual(run.finished, [{ status: "failed", text: failure }]);
    assert.deepEqual(run.sequence, ["unverified", "finish:failed"]);
  });

  it("appends the failure to the submitted document when the action is unverified", async function () {
    const run = await runSettlementTurn({
      conversationKey: 6_000_000_905,
      calls: ["submit_document", "run_command"],
      documentStored: true,
    });
    const [event] = unverifiedEvents(run.journal);
    const failure = (event as { payload: { failure: string } }).payload.failure;
    const expected = `${DOCUMENT_MARKDOWN}\n\n${failure}`;
    assert.equal(run.result.text, expected);
    assert.equal(run.result.documentId, "codex-document-1");
    assert.equal(run.result.verificationFailure, failure);
    assert.deepEqual(run.finished, [{ status: "failed", text: expected }]);
  });

  it("archives the prior persistent thread before it finishes a raw-PDF turn", async function () {
    const processKey = "native-settlement-raw-pdf-archive";
    const requests: Array<{ method: string; params: Record<string, any> }> = [];
    const order: string[] = [];
    requests.push = (...entries) => {
      for (const entry of entries)
        if (entry.method === "thread/archive")
          order.push(`archive:${entry.params.threadId}`);
      return Array.prototype.push.apply(requests, entries);
    };
    const proc = createNativeLifecycleTestProcess({
      newThreadIds: ["settlement-pdf-ephemeral"],
      requests,
      deltaForTurn: () => "pdf answer",
    });
    const originalSpawn = CodexAppServerProcess.spawn;
    const restorePrefs = installDirectPathTestPrefs("native");
    CodexAppServerProcess.spawn = async () => proc;
    const finished: Array<{ status: string; text?: string }> = [];
    try {
      const result = await runCodexAppServerNativeTurn({
        scope: {
          profileSignature: "profile-settlement-raw-pdf",
          conversationKey: 6_000_000_906,
          libraryID: 1,
          kind: "global",
          title: "Raw PDF settlement",
        },
        model: "gpt-5.6",
        messages: [{ role: "user", content: "Summarize the selected PDF" }],
        processKey,
        eventJournal: {
          runId: "host-settlement-pdf-run",
          append: async () => {},
          finish: async (status: string, text?: string) => {
            order.push(`finish:${status}`);
            finished.push({ status, text });
          },
        },
        hooks: {
          loadProviderSessionId: async () => "settlement-prior-thread",
          clearProviderSessionId: async () => {
            order.push("clear");
          },
          persistProviderSessionId: async () => {},
        },
        skillContext: {
          pdfPaperContexts: [
            {
              itemId: 10,
              contextItemId: 11,
              title: "PDF A",
              attachmentTitle: "paper-a.pdf",
              contentSourceMode: "pdf" as const,
            },
          ],
          localDocuments: [
            {
              kind: "local_pdf" as const,
              sourceKey: "zotero-pdf:10:11" as const,
              itemId: 10,
              contextItemId: 11,
              title: "PDF A",
              name: "paper-a.pdf",
              mimeType: "application/pdf" as const,
              absolutePath: "/Users/example/Papers/PDF A/paper-a.pdf",
            },
          ],
        },
      } as never);
      assert.equal(result.text, "pdf answer");
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      destroyCachedCodexAppServerProcess(processKey, proc);
      restorePrefs();
    }
    assert.deepEqual(order, [
      "archive:settlement-prior-thread",
      "clear",
      "finish:completed",
    ]);
    assert.deepEqual(finished, [{ status: "completed", text: "pdf answer" }]);
  });
});

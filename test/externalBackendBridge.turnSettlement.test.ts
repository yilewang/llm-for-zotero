/**
 * How a Claude bridge turn settles at its end: the finalized document of the
 * persisted run, the action contract the turn's MCP receipts prove, the event
 * that reports an unverified completion, terminal-text redaction, and the
 * stored run status.
 *
 * These pin the observable sequence through the real bridge runtime, so the
 * shared settlement rule can move without changing what is stored.
 */
import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { getConversationWriteGeneration } from "../src/shared/conversationWriteFence";
import { createExternalBackendBridgeRuntime } from "../src/agent/externalBackendBridge";
import {
  invokeRegisteredZoteroMcpEndpoint,
  registerMcpServer,
  unregisterMcpServer,
  ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../src/agent/mcp/server";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createFileIOTool } from "../src/agent/tools/write/fileIO";
import type { AgentEvent, AgentRuntimeOutcome } from "../src/agent/types";

const RUN_ID = "bridge-settlement-run";
const RAW_ANSWER = "Claude's own answer.";
const DOCUMENT_MARKDOWN = "# Report\n\nThe finalized document.";

function storedDocumentPayload(documentId: string, conversationKey: number) {
  return JSON.stringify({
    version: 2,
    documentId,
    documentVersion: 1,
    documentKind: "report",
    integrityPolicy: "authored",
    origin: { kind: "direct", runId: RUN_ID, sourceMessageTimestamp: 10 },
    conversationKey,
    title: "Report",
    visibleMarkdown: DOCUMENT_MARKDOWN,
    visibleHtml: "<h1>Report</h1><p>The finalized document.</p>",
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

function createRuntime() {
  const runtime = createExternalBackendBridgeRuntime({
    coreRuntime: {
      prepareExecutionRequest: async (input: any) => {
        const request =
          "turnPaperScope" in input ? input : resolveAgentRuntimeRequest(input);
        request.conversationGeneration = getConversationWriteGeneration(
          request.conversationKey,
        );
        request.skillRoutingReceipt = undefined;
        request.executionContext = {
          version: 1,
          executionId: "bridge-settlement-execution",
          conversationKey: request.conversationKey,
          conversationGeneration: request.conversationGeneration,
          chatLibraryID: request.libraryID,
          permissionOwner: "external_runtime",
          workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
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

type DbCall = { sql: string; params: unknown[] };

type SettlementRun = {
  outcome: AgentRuntimeOutcome;
  /** What the turn threw, when it threw. */
  error?: unknown;
  liveEvents: AgentEvent[];
  dbCalls: DbCall[];
  documentLookups: unknown[];
};

const originalFetch = globalThis.fetch;
const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;

/**
 * One bridge turn. The bridge streams a start line, optionally lets the turn
 * call a failing host command over Zotero MCP, then streams `outcome`.
 */
async function runSettlementTurn(params: {
  conversationKey: number;
  outcome: Record<string, unknown>;
  failingCommand: boolean;
  documentStored: boolean;
  localPdfPath?: string;
  /** The bridge streams this error line in place of the outcome. */
  streamError?: string;
  /** Pressed before the error line arrives. */
  stop?: AbortController;
}): Promise<SettlementRun> {
  const dbCalls: DbCall[] = [];
  const documentLookups: unknown[] = [];
  const liveEvents: AgentEvent[] = [];
  const prefStore = new Map<string, unknown>();
  const mcpEnabled = params.failingCommand;
  (globalThis as { Zotero?: unknown }).Zotero = {
    Prefs: {
      get(key: string) {
        if (key === "httpServer.port") return 24680;
        if (prefStore.has(key)) return prefStore.get(key);
        if (key.endsWith("enableClaudeCodeMode")) return true;
        if (key.endsWith("agentClaudeConfigSource")) return "default";
        if (key.endsWith("claudeCodePermissionMode")) return "default";
        if (key.endsWith("conversationSystem")) return "claude_code";
        if (key.endsWith("codexAppServerZoteroMcpToolsEnabled"))
          return mcpEnabled;
        if (key.endsWith("agentTraceExportEnabled")) return false;
        return "";
      },
      set(key: string, value: unknown) {
        prefStore.set(key, value);
      },
    },
    Profile: { dir: "/tmp/llm-for-zotero-settlement-profile" },
    Server: { Endpoints: {} },
    Libraries: { userLibraryID: 1 },
    Items: { get: () => null },
    DB: {
      queryAsync: async (sql: string, args: unknown[] = []) => {
        dbCalls.push({ sql, params: args });
        if (/WHERE run_id = \? ORDER BY created_at DESC/.test(sql)) {
          documentLookups.push(args[0]);
          return params.documentStored
            ? [
                {
                  documentId: "bridge-document-1",
                  payloadJson: storedDocumentPayload(
                    "bridge-document-1",
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
  };
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
  // Registered for the in-process MCP readiness check only; no turn here
  // calls it.
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
  registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });

  const runCreated = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (
        dbCalls.some(
          (call) =>
            /INSERT OR REPLACE INTO/.test(call.sql) &&
            call.params[0] === RUN_ID,
        )
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("the bridge never created its run");
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/healthz")) {
      return new Response(
        JSON.stringify({
          ok: true,
          protocolVersion: 2,
          capabilities: ["local_pdf_paths"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    const body = JSON.parse(String(init?.body || "{}")) as {
      mcpServers?: Record<string, { headers?: Record<string, string> }>;
    };
    const serverHeaders = Object.values(body.mcpServers || {})[0]?.headers;
    let step = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async pull(controller) {
        step += 1;
        if (step === 1) {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ type: "start", runId: RUN_ID })}\n`,
            ),
          );
          return;
        }
        if (step === 2) {
          if (params.failingCommand) {
            await runCreated();
            await invokeRegisteredZoteroMcpEndpoint({
              method: "POST",
              data: {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "run_command", arguments: {} },
              },
              headers: {
                [ZOTERO_MCP_SCOPE_HEADER]: String(
                  serverHeaders?.[ZOTERO_MCP_SCOPE_HEADER] || "",
                ),
                Authorization: String(serverHeaders?.Authorization || ""),
              },
            });
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (params.streamError !== undefined) {
            params.stop?.abort();
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify({ type: "error", error: params.streamError })}\n`,
              ),
            );
            return;
          }
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ type: "outcome", outcome: params.outcome })}\n`,
            ),
          );
          return;
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  let outcome!: AgentRuntimeOutcome;
  let error: unknown;
  try {
    outcome = await createRuntime().runTurn({
      ...(params.stop ? { signal: params.stop.signal } : {}),
      request: {
        conversationKey: params.conversationKey,
        mode: "agent",
        userText: "Write the report and run the command.",
        model: "claude-sonnet",
        authMode: "api_key",
        apiBase: "",
        apiKey: "",
        libraryID: 1,
        ...(params.localPdfPath
          ? {
              pdfPaperContexts: [
                {
                  itemId: 10,
                  contextItemId: 11,
                  title: "Selected PDF",
                  contentSourceMode: "pdf" as const,
                },
              ],
              localDocuments: [
                {
                  kind: "local_pdf" as const,
                  sourceKey: "zotero-pdf:10:11" as const,
                  itemId: 10,
                  contextItemId: 11,
                  title: "Selected PDF",
                  name: "selected.pdf",
                  mimeType: "application/pdf" as const,
                  absolutePath: params.localPdfPath,
                },
              ],
            }
          : {}),
      },
      onEvent: (event) => {
        liveEvents.push(event);
      },
    });
  } catch (caught) {
    error = caught;
  }
  return { outcome, error, liveEvents, dbCalls, documentLookups };
}

const finishCalls = (run: SettlementRun) =>
  run.dbCalls
    .filter((call) => /SET status = \?/.test(call.sql))
    .map((call) => ({
      status: call.params[0],
      text: call.params[2],
      runId: call.params[3],
    }));

const unverifiedEvents = (events: AgentEvent[]) =>
  events.filter(
    (event) =>
      event.type === "provider_event" &&
      event.providerType === "agent_completion_unverified",
  );

const persistedUnverifiedIndex = (run: SettlementRun) =>
  run.dbCalls.findIndex(
    (call) =>
      /INSERT INTO/.test(call.sql) &&
      String(call.params[3] || "").includes("agent_completion_unverified"),
  );

const completed = (text: string) => ({
  kind: "completed",
  runId: RUN_ID,
  text,
  usedFallback: false,
});

describe("Claude bridge turn settlement", function () {
  this.timeout(15000);

  afterEach(function () {
    // Unregister while the fixture Zotero, which owns the endpoint, is live.
    unregisterMcpServer();
    globalThis.fetch = originalFetch;
    (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
  });

  it("finishes a satisfied turn as completed with Claude's text", async function () {
    const run = await runSettlementTurn({
      conversationKey: 9101,
      outcome: completed(RAW_ANSWER),
      failingCommand: false,
      documentStored: false,
    });
    assert.deepEqual(run.documentLookups, [RUN_ID]);
    assert.deepEqual(run.outcome, completed(RAW_ANSWER) as never);
    assert.isEmpty(unverifiedEvents(run.liveEvents));
    assert.deepEqual(finishCalls(run), [
      { status: "completed", text: RAW_ANSWER, runId: RUN_ID },
    ]);
  });

  it("speaks the persisted run's finalized document", async function () {
    const run = await runSettlementTurn({
      conversationKey: 9102,
      outcome: { ...completed(RAW_ANSWER), planDocumentId: "plan-doc" },
      failingCommand: false,
      documentStored: true,
    });
    assert.deepEqual(run.documentLookups, [RUN_ID]);
    assert.deepEqual(run.outcome, {
      ...completed(DOCUMENT_MARKDOWN),
      planDocumentId: "plan-doc",
      documentId: "bridge-document-1",
    } as never);
    assert.deepEqual(finishCalls(run), [
      { status: "completed", text: DOCUMENT_MARKDOWN, runId: RUN_ID },
    ]);
  });

  it("loads no document and stores failed for a fallback outcome", async function () {
    const run = await runSettlementTurn({
      conversationKey: 9103,
      outcome: {
        kind: "fallback",
        runId: RUN_ID,
        reason: "bridge fell back",
        usedFallback: true,
      },
      failingCommand: false,
      documentStored: true,
    });
    assert.isEmpty(run.documentLookups);
    assert.deepEqual(run.outcome, {
      kind: "fallback",
      runId: RUN_ID,
      reason: "bridge fell back",
      usedFallback: true,
    });
    assert.deepEqual(finishCalls(run), [
      { status: "failed", text: "bridge fell back", runId: RUN_ID },
    ]);
  });

  it("replaces the answer with the failure and stores failed when the action is unverified", async function () {
    const run = await runSettlementTurn({
      conversationKey: 9104,
      outcome: { ...completed(RAW_ANSWER), planDocumentId: "plan-doc" },
      failingCommand: true,
      documentStored: false,
    });
    const [event] = unverifiedEvents(run.liveEvents);
    assert.exists(event, "the unverified completion was not reported");
    const payload = (event as { payload: Record<string, string> }).payload;
    assert.deepEqual(
      Object.keys(payload),
      ["reason"],
      "the bridge reports the failure under its own payload key",
    );
    const failure = payload.reason;
    assert.match(
      failure,
      /^Delegated action results:\n\[Action status: command_execute — failed/,
    );
    // The outcome is rebuilt: other completed fields are dropped and the
    // document id is present but undefined.
    assert.deepEqual(run.outcome, {
      kind: "completed",
      runId: RUN_ID,
      text: failure,
      documentId: undefined,
      usedFallback: false,
      runStatus: "failed",
    });
    assert.property(run.outcome, "documentId");
    const persistedAt = persistedUnverifiedIndex(run);
    assert.isAtLeast(persistedAt, 0, "the unverified event was not persisted");
    const finishAt = run.dbCalls.findIndex((call) =>
      /SET status = \?/.test(call.sql),
    );
    assert.isBelow(persistedAt, finishAt);
    assert.deepEqual(finishCalls(run), [
      { status: "failed", text: failure, runId: RUN_ID },
    ]);
  });

  it("appends the failure to the finalized document when the action is unverified", async function () {
    const run = await runSettlementTurn({
      conversationKey: 9105,
      outcome: completed(RAW_ANSWER),
      failingCommand: true,
      documentStored: true,
    });
    const [event] = unverifiedEvents(run.liveEvents);
    const failure = (event as { payload: { reason: string } }).payload.reason;
    const expected = `${DOCUMENT_MARKDOWN}\n\n${failure}`;
    assert.deepEqual(run.outcome, {
      kind: "completed",
      runId: RUN_ID,
      text: expected,
      documentId: "bridge-document-1",
      usedFallback: false,
      runStatus: "failed",
    });
    assert.deepEqual(finishCalls(run), [
      { status: "failed", text: expected, runId: RUN_ID },
    ]);
  });

  it("turns a fallback outcome into a completed failure report when the action is unverified", async function () {
    const run = await runSettlementTurn({
      conversationKey: 9106,
      outcome: {
        kind: "fallback",
        runId: RUN_ID,
        reason: "bridge fell back",
        usedFallback: true,
      },
      failingCommand: true,
      documentStored: true,
    });
    assert.isEmpty(run.documentLookups);
    const [event] = unverifiedEvents(run.liveEvents);
    const failure = (event as { payload: { reason: string } }).payload.reason;
    assert.deepEqual(run.outcome, {
      kind: "completed",
      runId: RUN_ID,
      text: failure,
      documentId: undefined,
      usedFallback: false,
      runStatus: "failed",
    });
    assert.deepEqual(finishCalls(run), [
      { status: "failed", text: failure, runId: RUN_ID },
    ]);
  });

  it("redacts the local PDF path from the returned and stored final text", async function () {
    const rawPath = "/Users/alice/Private Papers/selected.pdf";
    const run = await runSettlementTurn({
      conversationKey: 9107,
      outcome: completed(`Read ${rawPath} fully.`),
      failingCommand: false,
      documentStored: false,
      localPdfPath: rawPath,
    });
    assert.equal(run.outcome.kind, "completed");
    const text = run.outcome.kind === "completed" ? run.outcome.text : "";
    assert.notInclude(text, rawPath);
    assert.include(text, "[raw_pdf_path:zotero-pdf:10:11]");
    assert.deepEqual(finishCalls(run), [
      { status: "completed", text, runId: RUN_ID },
    ]);
  });
  const persistedEventTypes = (run: SettlementRun) =>
    run.dbCalls
      .filter(
        (call) => /INSERT INTO/.test(call.sql) && call.params[0] === RUN_ID,
      )
      .map((call) => JSON.parse(String(call.params[3] || "{}")))
      .filter((event) => event.type === "status" || event.type === "fallback")
      .map((event) => ({ type: event.type, text: event.text ?? event.reason }));

  const liveEndingEvents = (run: SettlementRun) =>
    run.liveEvents
      .filter((event) => event.type === "status" || event.type === "fallback")
      .map((event) => ({
        type: event.type,
        text:
          event.type === "status"
            ? event.text
            : event.type === "fallback"
              ? event.reason
              : "",
      }));

  const BRIDGE_FAILURE =
    "External agent backend unavailable: bridge exploded. ";

  it("reports a bridge stream error as a status and a fallback, stores failed twice, and returns the report as a failed outcome", async function () {
    const run = await runSettlementTurn({
      conversationKey: 9108,
      outcome: completed(RAW_ANSWER),
      failingCommand: false,
      documentStored: false,
      streamError: "bridge exploded",
    });
    assert.isUndefined(run.error, "the bridge returns the failure");
    assert.equal(run.outcome.kind, "failed");
    if (run.outcome.kind !== "failed") return;
    const report = run.outcome.message;
    assert.isTrue(report.startsWith(BRIDGE_FAILURE), report);
    assert.deepInclude(run.outcome, {
      runId: RUN_ID,
      interrupted: false,
    });
    // The throwing public runTurn rethrows the report as before.
    assert.instanceOf(run.outcome.cause, Error);
    assert.equal((run.outcome.cause as Error).message, report);
    const ending = [
      { type: "status", text: report },
      { type: "fallback", text: report },
    ];
    assert.deepEqual(liveEndingEvents(run), ending);
    assert.deepEqual(persistedEventTypes(run), ending);
    assert.deepEqual(finishCalls(run), [
      { status: "failed", text: "bridge exploded", runId: RUN_ID },
      { status: "failed", text: report, runId: RUN_ID },
    ]);
  });

  it("stores cancelled and returns cancelled when the user stopped the turn before the bridge stream failed", async function () {
    const stop = new AbortController();
    const run = await runSettlementTurn({
      conversationKey: 9109,
      outcome: completed(RAW_ANSWER),
      failingCommand: false,
      documentStored: false,
      streamError: "bridge exploded",
      stop,
    });
    assert.isUndefined(run.error, "the bridge returns the cancellation");
    assert.equal(run.outcome.kind, "cancelled");
    if (run.outcome.kind !== "cancelled") return;
    assert.equal(run.outcome.runId, RUN_ID);
    const report = (run.outcome.cause as Error).message;
    assert.isTrue(report.startsWith(BRIDGE_FAILURE), report);
    assert.deepEqual(liveEndingEvents(run), [
      { type: "status", text: report },
      { type: "fallback", text: report },
    ]);
    assert.deepEqual(finishCalls(run), [
      { status: "cancelled", text: "bridge exploded", runId: RUN_ID },
      { status: "cancelled", text: report, runId: RUN_ID },
    ]);
  });
});

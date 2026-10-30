import { assert } from "chai";
import { ActionContractRunSession } from "../src/agent/contracts/actionContractRunSession";
import { formatReceiptStatus } from "../src/agent/contracts/actionEvaluation";
import type { AgentActionReceipt } from "../src/agent/contracts/types";
import { PaperEvidenceFrontier } from "../src/agent/context/paperEvidenceFrontier";
import { buildAgentResourceContextPlan } from "../src/agent/context/resourceContextPlan";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { createAgentExecutionContext } from "../src/agent/execution/context";
import {
  createToolExecution,
  type ToolExecutionDeps,
  type ToolExecutionRecord,
} from "../src/agent/execution/toolExecution";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { stateChangeInvocationPlan } from "../src/agent/authorization/invocationPlan";
import type { AgentPendingReadActivity } from "../src/agent/context/resourceContextPlan";
import type { MaterialRef } from "../src/agent/documents/materialRef";
import type { AgentToolResultHandleRecord } from "../src/agent/store/toolResultHandles";
import type { OutcomeEffect } from "../src/agent/execution/types";
import {
  applyOutcomeEvidence,
  declareOutcomes,
  OUTCOME_REASONS,
  type OutcomeEvidence,
} from "../src/agent/loop/outcomes";
import { createEmptyExecutionCheckpoint } from "../src/agent/execution/checkpoint";
import type {
  AgentEvent,
  AgentModelCapabilities,
  AgentRuntimeRequest,
  AgentToolContext,
  ExecutionCheckpoint,
  ExecutionTaskStatus,
} from "../src/agent/types";
import { createSubmitDocumentTool } from "../src/agent/tools/control/submitDocument";
import { paperSourceId } from "../src/webAccess/paperSources";
import { setOutsidePaperPrefetchLookup } from "../src/agent/context/outsidePaperRecords";
import {
  initPlanDocumentStore,
  loadPlanDocument,
} from "../src/agent/documents/store";
import type { PlanDocumentAsset } from "../src/agent/documents/types";
import { sha256Bytes } from "../src/agent/store/journalRecoveryBlobStore";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import {
  installAgentStoreSqlite,
  installMockDb,
} from "./helpers/agentRuntimeMockDb";
import { createTestActionContractService } from "./helpers/actionContractService";
import { createLibraryRetrieveTool } from "../src/agent/tools/read/libraryRetrieve";
import { createLibrarySearchTool } from "../src/agent/tools/read/librarySearch";
import { createContextReadTool } from "../src/agent/tools/read/contextRead";
import {
  clearAgentToolResultHandleStore,
  upsertAgentToolResultHandles,
} from "../src/agent/store/toolResultHandles";
import type {
  LibraryRetrieveResult,
  LibraryRetrieveSnippet,
} from "../src/agent/services/libraryRetrieveService";

const CAPABILITIES: AgentModelCapabilities = {
  streaming: false,
  toolCalls: true,
  multimodal: false,
};

function registerReadTool(registry: AgentToolRegistry): void {
  registry.register({
    spec: {
      name: "library_search",
      description: "search",
      inputSchema: { type: "object" },
      executionClass: "read",
      workCategory: "retrieval",
    },
    presentation: { label: "Search library" },
    validate: (args: unknown) => ({ ok: true, value: args as never }),
    execute: async () => ({ content: { hits: ["paper-1"] } }),
  } as never);
}

function registerWriteTool(registry: AgentToolRegistry): void {
  registry.register({
    effectOperations: ["note_create"],
    spec: {
      name: "note_write",
      description: "write a note",
      inputSchema: { type: "object" },
      executionClass: "external_effect",
      workCategory: "zotero_action",
      requiresConfirmation: false,
    },
    presentation: { label: "Write note" },
    validate: (args: unknown) => ({ ok: true, value: args as never }),
    planInvocation: async () =>
      stateChangeInvocationPlan({
        reversibility: "full",
        reason: "Test note write.",
      }),
    describeAction: () => [
      {
        id: "note_create:collaborator-test",
        proofDomain: "zotero_state",
        capability: "zotero.notes",
        operation: "note_create",
        source: "zotero_native",
        requestedTargets: [],
        destinationCollectionIds: [],
      },
    ],
    execute: async () => ({
      content: { status: "created", noteId: 700 },
      effect: "applied",
    }),
  } as never);
}

function registerDocumentTool(registry: AgentToolRegistry): void {
  registry.register({
    spec: {
      name: "submit_document",
      description: "submit",
      inputSchema: { type: "object" },
      executionClass: "read",
      workCategory: "generation",
    },
    validate: (args: unknown) => ({ ok: true, value: args as never }),
    execute: async () => ({ content: { documentId: "doc-1" } }),
    resolveTerminalResult: async () => ({
      finalText: "The document is ready.",
      documentId: "doc-1",
      providerTranscript: "tool_only",
    }),
  } as never);
}

/** A 1x1 PNG: the bytes of a host-cropped figure. */
const CROP_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/aYAAAAASUVORK5CYII=",
    "base64",
  ),
);
const CROP_PATH = "/tmp/figure-crops/figure-1-p2.png";
const FIGURE_CAPTION = "Figure 1. Assemblies drift across days.";

/**
 * The PDF a figure turn reads, with the native identity its figure asset
 * names: a paper's child PDF, or a standalone PDF (an attachment without a
 * parent item, so it is its own bibliographic item).
 */
type FigureSource = {
  paperContext: { itemId: number; contextItemId: number };
  itemKey: string;
  attachmentItemKey: string;
};
const PARENTED_PDF: FigureSource = {
  paperContext: { itemId: 11, contextItemId: 22 },
  itemKey: "PAPER001",
  attachmentItemKey: "PDF00001",
};
const STANDALONE_PDF: FigureSource = {
  paperContext: { itemId: 33, contextItemId: 33 },
  itemKey: "PDF00033",
  attachmentItemKey: "PDF00033",
};

/**
 * The paper, its PDF, and a standalone PDF as Zotero knows them, and the
 * files a figure document reads (the crop) and writes (its durable asset
 * copy).
 */
function installFigureLibrary(): {
  files: Map<string, Uint8Array>;
} & (() => void) {
  const zotero = (globalThis as unknown as { Zotero: Record<string, unknown> })
    .Zotero;
  const items = new Map<number, Record<string, unknown>>([
    [11, { id: 11, key: "PAPER001", libraryID: 1 }],
    [
      22,
      {
        id: 22,
        key: "PDF00001",
        libraryID: 1,
        parentID: 11,
        isAttachment: () => true,
      },
    ],
    [33, { id: 33, key: "PDF00033", libraryID: 1, isAttachment: () => true }],
  ]);
  zotero.Items = { get: (id: number) => items.get(id) || null };
  zotero.DataDirectory = { dir: "/tmp/zotero-data" };
  const globalScope = globalThis as unknown as { IOUtils?: unknown };
  const originalIOUtils = globalScope.IOUtils;
  const files = new Map<string, Uint8Array>([[CROP_PATH, CROP_BYTES]]);
  globalScope.IOUtils = {
    read: async (path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`missing ${path}`);
      return bytes;
    },
    write: async (path: string, bytes: Uint8Array) => {
      files.set(path, new Uint8Array(bytes));
    },
    makeDirectory: async () => undefined,
  };
  const restore = () => {
    if (originalIOUtils === undefined) delete globalScope.IOUtils;
    else globalScope.IOUtils = originalIOUtils;
  };
  return Object.assign(restore, { files });
}

/**
 * An ordinary in-plugin turn that has read one figure from `source`, with the
 * real submit_document registered. paper_read answers in the shape the figure
 * extraction service returns: the crop row with the asset a document may
 * carry, and the artifact the host records for it.
 */
async function startFigureTurn(source: FigureSource = PARENTED_PDF) {
  const restoreDb = installMockDb();
  const restoreDocuments = installAgentStoreSqlite();
  const library = installFigureLibrary();
  const restore = () => {
    library();
    restoreDocuments();
    restoreDb();
  };
  try {
    await initPlanDocumentStore();
    const contentHash = `sha256:${await sha256Bytes(CROP_BYTES)}`;
    const sourceFingerprint = `sha256:${"b".repeat(64)}`;
    const asset: PlanDocumentAsset = {
      assetId: `${source.attachmentItemKey}-figure-1-p2`,
      contentHash,
      mimeType: "image/png",
      byteLength: CROP_BYTES.byteLength,
      width: 1,
      height: 1,
      caption: FIGURE_CAPTION,
      durablePath: CROP_PATH,
      provenance: {
        origin: "extracted",
        libraryID: 1,
        itemKey: source.itemKey,
        attachmentItemKey: source.attachmentItemKey,
        sourceFingerprint,
        pageIndex: 1,
        extractionToolVersion: "pdf-figure-crop:test",
      },
    };
    const registry = new AgentToolRegistry(createTestActionContractService());
    registry.register({
      spec: {
        name: "paper_read",
        description: "read a paper",
        inputSchema: { type: "object" },
        executionClass: "read",
        workCategory: "retrieval",
      },
      validate: (args: unknown) => ({ ok: true, value: args as never }),
      execute: async () => ({
        content: {
          mode: "figures",
          status: "ok",
          figures: [
            {
              label: "Figure 1",
              cropPath: CROP_PATH,
              captionText: FIGURE_CAPTION,
              pageIndex: 1,
              sourceFingerprint,
              paperContext: source.paperContext,
              documentAsset: asset,
            },
          ],
        },
        artifacts: [
          {
            kind: "image",
            mimeType: "image/png",
            storedPath: CROP_PATH,
            contentHash,
            title: "Figure 1",
            pageIndex: 1,
            pageLabel: "2",
          },
        ],
      }),
    } as never);
    // A document without citations formats none.
    registry.register(
      createSubmitDocumentTool({
        formatStructuredCitations: () => ({
          styleId: "apa",
          styleTitle: "APA",
          locale: "en-US",
          clusters: [],
          bibliographyEntries: [],
        }),
      } as unknown as ZoteroGateway),
    );
    const harness = await createHarness(registry);
    const toolExecution = createToolExecution(harness.deps);
    await toolExecution.executeToolWorkflow(
      {
        id: "call-figure",
        name: "paper_read",
        arguments: {
          mode: "figures",
          target: source.paperContext,
        },
      },
      1,
      { modelCallId: "call-figure" },
    );
    const submit = (assets: PlanDocumentAsset[]) =>
      toolExecution.executeToolWorkflow(
        {
          id: "call-submit",
          name: "submit_document",
          arguments: {
            documentKind: "report",
            integrityPolicy: "authored",
            title: "Drift figure",
            markdown: "# Drift figure\n\nThe figure shows the drift.",
            citations: [],
            quotes: [],
            assets,
            groundingReviewed: "passed",
            groundingIssues: [],
          },
        },
        2,
        { modelCallId: "call-submit" },
      );
    return { asset, harness, files: library.files, submit, restore };
  } catch (error) {
    restore();
    throw error;
  }
}

/** An ordinary-turn checkpoint holding one declared part per entry. */
function checkpointWith(
  tasks: Array<
    [description: string, status: ExecutionTaskStatus, effect: OutcomeEffect]
  >,
): ExecutionCheckpoint {
  return {
    version: 1,
    executionId: "run-collaborator",
    conversationKey: 970_001,
    conversationGeneration: 0,
    tasks: tasks.map(([description, status, effect], index) => ({
      taskId: `task-${index + 1}`,
      description,
      dependencies: [],
      status,
      effect,
      origin: "model" as const,
      journalActionIds: [],
      verifiedReceiptIds: [],
      readEvidenceIds: [],
      materialRefs: [],
      createdAt: 1,
      updatedAt: 1,
    })),
    createdAt: 1,
    updatedAt: 1,
  };
}

type Harness = {
  deps: ToolExecutionDeps;
  events: AgentEvent[];
  request: AgentRuntimeRequest;
  records: ToolExecutionRecord[];
  reads: AgentPendingReadActivity[];
  answerText: { value: string };
  finalizedMaterial: {
    value: { documentId: string; finalText: string } | null;
  };
  toolResultReadAvailable: { value: boolean };
};

async function createHarness(registry: AgentToolRegistry): Promise<Harness> {
  const events: AgentEvent[] = [];
  const emit = async (event: AgentEvent) => {
    events.push(event);
  };
  const request = resolveAgentRuntimeRequest(
    {
      conversationKey: 970_001,
      mode: "agent",
      libraryID: 1,
      userText: "Find it and note it",
      model: "test",
      apiKey: "test",
      apiBase: "https://example.invalid",
    },
    {},
  ) as AgentRuntimeRequest;
  // A turn stamps its execution context before anything runs; it is what
  // authorizes the in-plugin agent's own effects.
  request.executionContext ||= createAgentExecutionContext(
    request,
    "run-collaborator",
  );
  const answerText = { value: "streamed so far" };
  const finalizedMaterial: Harness["finalizedMaterial"] = { value: null };
  const toolResultReadAvailable = { value: false };
  const records: ToolExecutionRecord[] = [];
  const reads: AgentPendingReadActivity[] = [];
  const handles: AgentToolResultHandleRecord[] = [];
  const context = {
    request,
    runId: "run-collaborator",
    item: null,
    currentAnswerText: "",
    modelName: "test",
    signal: undefined,
    publishPlanEvent: async () => undefined,
    updateExecutionCheckpoint: async (
      apply: (checkpoint: ExecutionCheckpoint) => ExecutionCheckpoint,
    ) => apply(request.executionCheckpoint!),
  } as unknown as AgentToolContext;
  const deps: ToolExecutionDeps = {
    registry,
    now: () => 1_700_000_000_000,
    signal: undefined,
    emit,
    request,
    runId: "run-collaborator",
    context,
    writeAllowed: () => true,
    adapterCapabilities: CAPABILITIES,
    actionContractSession: new ActionContractRunSession(),
    paperEvidenceFrontier: new PaperEvidenceFrontier(),
    resourceContextPlan: buildAgentResourceContextPlan(request),
    persistToolResultHandles: async (written) => {
      handles.push(...written);
    },
    requestActionResolution: async () => {
      throw new Error("no confirmation is expected in this test");
    },
    finalizedMaterialRefs: new Map<string, MaterialRef>(),
    pendingReadActivities: reads,
    preservedTurnHandleRecords: handles,
    toolExecutionRecords: records,
    toolsUsedThisTurn: [],
    getCurrentAnswerText: () => answerText.value,
    setFinalizedMaterial: (material) => {
      finalizedMaterial.value = material;
    },
    setToolResultReadAvailable: (available) => {
      toolResultReadAvailable.value = available;
    },
  } as ToolExecutionDeps;
  // Only what the collaborator itself publishes is under test here.
  events.length = 0;
  return {
    deps,
    events,
    request,
    records,
    reads,
    answerText,
    finalizedMaterial,
    toolResultReadAvailable,
  };
}

describe("agent tool execution collaborator", function () {
  it("publishes a read call's stages, events and delivery", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registerReadTool(registry);
      const harness = await createHarness(registry);
      const toolExecution = createToolExecution(harness.deps);

      const outcome = await toolExecution.executeToolWorkflow(
        { id: "call-read", name: "library_search", arguments: { q: "brain" } },
        1,
        { modelCallId: "call-read" },
      );

      assert.deepEqual(
        harness.events.map((event) => [
          event.type,
          event.type === "agent_stage" ? event.status : "",
        ]),
        [
          ["agent_stage", "started"],
          ["tool_call", ""],
          ["agent_stage", "completed"],
          ["tool_result", ""],
        ],
        "a read opens its stage, publishes the call, closes the stage, then publishes the result",
      );
      const [started, call, completed, result] = harness.events as [
        Extract<AgentEvent, { type: "agent_stage" }>,
        Extract<AgentEvent, { type: "tool_call" }>,
        Extract<AgentEvent, { type: "agent_stage" }>,
        Extract<AgentEvent, { type: "tool_result" }>,
      ];
      assert.deepEqual(
        [started.stage, started.callId, started.toolLabel],
        ["retrieval", "call-read", "Search library"],
      );
      assert.deepEqual(
        [call.name, call.callId, call.toolLabel, call.workCategory],
        ["library_search", "call-read", "Search library", "retrieval"],
      );
      assert.deepEqual(call.args, { q: "brain" });
      assert.isUndefined(
        completed.receiptIds,
        "a read produces no receipts to carry",
      );
      assert.deepEqual(
        [result.name, result.ok, result.callId],
        ["library_search", true, "call-read"],
      );

      assert.isTrue(outcome.toolResult.ok);
      assert.deepEqual(outcome.toolResult.content, { hits: ["paper-1"] });
      assert.isUndefined(outcome.stopRun);
      assert.deepEqual(outcome.delivery, {
        callId: "call-read",
        name: "library_search",
        content: { hits: ["paper-1"], actionReceipts: [] },
        followupMessages: [],
      });

      assert.deepEqual(
        harness.records.map((record) => [
          record.name,
          record.ok,
          record.mutability,
        ]),
        [["library_search", true, "read"]],
      );
      assert.deepEqual(
        harness.reads.map((read) => [read.toolName, read.toolLabel]),
        [["library_search", "Search library"]],
        "a successful read is queued for the turn's read ledger",
      );
      assert.isNull(
        harness.finalizedMaterial.value,
        "a read finalizes no material",
      );
    } finally {
      restoreDb();
    }
  });

  it("records the outside papers literature_search and literature_read return on the run's request", async function () {
    const restoreDb = installMockDb();
    const prefetched: string[] = [];
    setOutsidePaperPrefetchLookup(async (doi) => {
      prefetched.push(doi);
      return { volume: "7" };
    });
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      const register = (name: string, content: unknown) =>
        registry.register({
          spec: {
            name,
            description: name,
            inputSchema: { type: "object" },
            executionClass: "read",
            workCategory: "retrieval",
          },
          validate: (args: unknown) => ({ ok: true, value: args as never }),
          execute: async () => ({ content }),
        } as never);
      register("literature_search", {
        mode: "search",
        results: [
          {
            title: "Drift",
            authors: ["Ada Lovelace"],
            year: 2021,
            doi: "10.1000/drift",
          },
          { title: "Stable", authors: [], arxivId: "2101.00001" },
        ],
      });
      register("literature_read", {
        paper: {
          title: "Drift",
          authors: ["Ada Lovelace"],
          doi: "10.1000/drift",
        },
        fullText: { status: "open_access" },
        passages: [{ section: "1 Results", text: "Tuning drifts." }],
      });
      register("web_search", {
        results: [{ title: "A blog", url: "https://example.com/blog" }],
      });
      const harness = await createHarness(registry);
      const toolExecution = createToolExecution(harness.deps);
      for (const [index, name] of [
        "literature_search",
        "literature_read",
        "web_search",
      ].entries()) {
        await toolExecution.executeToolWorkflow(
          { id: `call-${index}`, name, arguments: {} },
          index + 1,
          { modelCallId: `call-${index}` },
        );
      }
      assert.deepEqual(
        harness.request.outsidePaperRecords?.map((paper) => [
          paper.paperId,
          paper.depth,
        ]),
        [
          [paperSourceId("doi:10.1000/drift"), "body"],
          [paperSourceId("arxiv:2101.00001"), "metadata"],
        ],
        "one record per paper at its deepest read; web pages are never recorded",
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(
        prefetched,
        ["10.1000/drift"],
        "the paper read in full is looked up in the background; search rows are not",
      );
      assert.deepEqual(harness.request.outsidePaperLookupCache, {
        "10.1000/drift": { volume: "7" },
      });
    } finally {
      setOutsidePaperPrefetchLookup(null);
      restoreDb();
    }
  });

  it("attests a re-read the paper evidence cache answers with its first read's evidence", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
        spec: {
          name: "paper_read",
          description: "Read one paper",
          inputSchema: { type: "object" },
          executionClass: "read",
          workCategory: "retrieval",
        },
        validate: (args: unknown) => ({ ok: true, value: args as never }),
        execute: async () => ({
          mode: "targeted",
          results: [],
          papers: [
            {
              paperContext: { itemId: 11, contextItemId: 1011, libraryID: 1 },
              passages: [
                { text: "Place cells drift.", sectionLabel: "Results" },
              ],
            },
          ],
        }),
      } as never);
      const harness = await createHarness(registry);
      const recorded: OutcomeEvidence[] = [];
      harness.deps.recordOutcomeEvidence = async (evidence) => {
        recorded.push(evidence);
      };
      const toolExecution = createToolExecution(harness.deps);
      const read = (id: string) =>
        toolExecution.executeToolWorkflow(
          {
            id,
            name: "paper_read",
            arguments: {
              mode: "targeted",
              query: "drift",
              target: { itemId: 11, contextItemId: 1011, libraryID: 1 },
            },
          },
          1,
          { modelCallId: id },
        );
      await read("read-1");
      const reread = await read("read-2");
      assert.equal(
        (reread.toolResult.content as { cacheStatus?: string }).cacheStatus,
        "identical_call_reused",
        "the cache answered the re-read",
      );
      const reads = recorded.filter((entry) => entry.kind === "read");
      assert.lengthOf(reads, 2);
      assert.deepEqual(reads[0], {
        kind: "read",
        targets: ["item:11"],
        observationIds: (reads[0] as { observationIds: string[] })
          .observationIds,
      });
      assert.deepEqual(
        reads[1],
        reads[0],
        "the re-read attests its papers again",
      );
    } finally {
      restoreDb();
    }
  });

  it("publishes a write call's stages, receipts and delivery", async function () {
    const restoreDb = installMockDb();
    try {
      await initAgentChangeJournal();
      const registry = new AgentToolRegistry(createTestActionContractService());
      registerWriteTool(registry);
      const harness = await createHarness(registry);
      const toolExecution = createToolExecution(harness.deps);

      const outcome = await toolExecution.executeToolWorkflow(
        { id: "call-write", name: "note_write", arguments: { text: "body" } },
        2,
        { modelCallId: "provider-write" },
      );

      assert.deepEqual(
        harness.events.map((event) => [
          event.type,
          event.type === "agent_stage" ? event.status : "",
        ]),
        [
          ["agent_stage", "started"],
          ["tool_call", ""],
          ["agent_stage", "completed"],
          ["tool_result", ""],
        ],
        "a write publishes the same sequence as a read",
      );
      const closing = harness.events[2] as Extract<
        AgentEvent,
        { type: "agent_stage" }
      >;
      const result = harness.events[3] as Extract<
        AgentEvent,
        { type: "tool_result" }
      >;
      assert.equal(closing.stage, "zotero_action");
      assert.isNotEmpty(
        result.actionReceipts || [],
        "a write publishes the receipts it produced",
      );
      assert.deepEqual(
        closing.receiptIds,
        (result.actionReceipts || []).map((receipt) => receipt.id),
        "the closing stage carries the receipts of its own call",
      );
      assert.equal(result.effect, "applied");

      assert.isTrue(outcome.toolResult.ok);
      assert.equal(
        outcome.delivery?.callId,
        "provider-write",
        "the delivery answers the provider's call id, not the host's",
      );
      assert.deepEqual(outcome.delivery?.content, {
        status: "created",
        noteId: 700,
        actionReceipts: outcome.toolResult.actionReceipts,
      });
      assert.deepEqual(outcome.delivery?.followupMessages, []);

      assert.deepEqual(
        harness.records.map((record) => [
          record.name,
          record.ok,
          record.mutability,
        ]),
        [["note_write", true, "write"]],
      );
      assert.deepEqual(
        harness.reads.map((read) => [read.toolName, read.toolLabel]),
        [["note_write", "Write note"]],
        "every successful call, write included, is queued for the turn's activity ledger",
      );
    } finally {
      restoreDb();
    }
  });

  it("publishes a failing call's error and closes its stage as failed", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
        spec: {
          name: "library_search",
          description: "search",
          inputSchema: { type: "object" },
          executionClass: "read",
          workCategory: "retrieval",
        },
        presentation: { label: "Search library" },
        validate: (args: unknown) => ({ ok: true, value: args as never }),
        execute: async () => {
          throw new Error("index unavailable");
        },
      } as never);
      const harness = await createHarness(registry);
      const toolExecution = createToolExecution(harness.deps);

      const executed = await toolExecution.executePreparedToolCall(
        { id: "call-fail", name: "library_search", arguments: {} },
        1,
      );

      assert.deepEqual(
        harness.events.map((event) => [
          event.type,
          event.type === "agent_stage" ? event.status : "",
        ]),
        [
          ["agent_stage", "started"],
          ["tool_call", ""],
          ["tool_error", ""],
          ["agent_stage", "failed"],
          ["tool_result", ""],
        ],
        "the error is published before the stage closes as failed",
      );
      const error = harness.events[2] as Extract<
        AgentEvent,
        { type: "tool_error" }
      >;
      assert.equal(error.callId, "call-fail");
      assert.equal(error.round, 1);
      assert.include(String(error.error), "index unavailable");
      assert.isFalse(executed.toolResult.ok);
      assert.deepEqual(
        harness.reads,
        [],
        "a failed read is never queued for the read ledger",
      );
    } finally {
      restoreDb();
    }
  });

  it("carries the live answer text and the tool's own follow-up message into a delivery", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      const seenAnswerText: string[] = [];
      registry.register({
        spec: {
          name: "library_search",
          description: "search",
          inputSchema: { type: "object" },
          executionClass: "read",
          workCategory: "retrieval",
        },
        validate: (args: unknown) => ({ ok: true, value: args as never }),
        execute: async () => ({ content: { hits: [] } }),
        buildFollowupMessage: async (
          _result: unknown,
          context: AgentToolContext,
        ) => {
          seenAnswerText.push(context.currentAnswerText || "");
          return { role: "user", content: "tool-followup" };
        },
      } as never);
      const harness = await createHarness(registry);
      const toolExecution = createToolExecution(harness.deps);
      harness.answerText.value = "the answer as it stands now";

      const delivery = await toolExecution.buildToolDelivery(
        {
          callId: "call-delivery",
          name: "library_search",
          ok: true,
          actionReceipts: [],
          content: { hits: [] },
        },
        "provider-delivery",
        registry.getTool("library_search"),
        { replaced: true },
        [{ role: "user", content: "extra-followup" }],
      );

      assert.deepEqual(
        seenAnswerText,
        ["the answer as it stands now"],
        "the tool reads the answer text as it is now, not as it was at build time",
      );
      assert.deepEqual(delivery, {
        callId: "provider-delivery",
        name: "library_search",
        content: { replaced: true, actionReceipts: [] },
        followupMessages: [
          { role: "user", content: "extra-followup" },
          { role: "user", content: "tool-followup" },
        ],
      });
    } finally {
      restoreDb();
    }
  });

  it("records the material a terminal result finalized and reports the remaining work", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registerDocumentTool(registry);
      const harness = await createHarness(registry);
      // An earlier write this turn applied but could not be verified, so the
      // final evaluation cannot accept: the material is kept and the model is
      // told what is left rather than the run stopping here.
      const unverified: AgentActionReceipt[] = [
        {
          version: 2,
          id: "proposal:apply_tags:unmatched:result",
          proposalId: "proposal:apply_tags",
          proofDomain: "zotero_state",
          capability: "zotero.tags",
          operation: "apply_tags",
          verification: "unverified",
          status: "applied",
          requestedTargets: ["item:41"],
          appliedTargets: ["item:41"],
          alreadySatisfiedTargets: [],
          rejectedTargets: [],
          reasons: [],
          verifiedFacts: [],
        },
      ];
      harness.deps.actionContractSession.recordToolReceipts(unverified);
      const toolExecution = createToolExecution(harness.deps);

      const outcome = await toolExecution.executeToolWorkflow(
        { id: "call-submit", name: "submit_document", arguments: {} },
        1,
        { modelCallId: "provider-submit" },
      );

      assert.deepEqual(
        harness.finalizedMaterial.value,
        { documentId: "doc-1", finalText: "The document is ready." },
        "the turn is told which material this call finalized, through the setter",
      );
      assert.isUndefined(outcome.stopRun);
      assert.isUndefined(outcome.finalText);
      assert.equal(outcome.delivery?.callId, "provider-submit");
      assert.deepEqual(outcome.delivery?.content, {
        content: { documentId: "doc-1" },
        remainingWork: `Concrete action results could not be verified:\n${formatReceiptStatus(unverified)}`,
        finalizedDocumentId: "doc-1",
        instruction:
          "The material is finalized and preserved. Complete the remaining authorized actions using this finalized payload; do not regenerate the document.",
        actionReceipts: [],
      });
    } finally {
      restoreDb();
    }
  });

  it("announces the sources a finalized document cites on material_finalized", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      const citedSources = [
        {
          citationId: "c1",
          libraryID: 1,
          itemKey: "PAPER001",
          itemId: 11,
          sectionLabel: "Discussion",
        },
      ];
      registry.register({
        spec: {
          name: "submit_document",
          description: "submit",
          inputSchema: { type: "object" },
          executionClass: "read",
          workCategory: "generation",
        },
        validate: (args: unknown) => ({ ok: true, value: args as never }),
        execute: async () => ({
          content: { documentId: "doc-1" },
          materialRef: {
            documentId: "doc-1",
            documentVersion: 1,
            contentHash: "hash-1",
          },
          materialKind: "document",
          materialTitle: "Review",
          materialCitedSources: citedSources,
        }),
      } as never);
      const harness = await createHarness(registry);
      const toolExecution = createToolExecution(harness.deps);
      await toolExecution.executeToolWorkflow(
        { id: "call-submit", name: "submit_document", arguments: {} },
        1,
        { modelCallId: "provider-submit" },
      );
      const finalized = harness.events.find(
        (event) => event.type === "material_finalized",
      ) as Extract<AgentEvent, { type: "material_finalized" }> | undefined;
      assert.exists(finalized);
      assert.deepEqual(finalized!.citedSources, citedSources);
    } finally {
      restoreDb();
    }
  });

  it("records the part a document names, its kind and the papers it cites on the material evidence", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
        spec: {
          name: "submit_document",
          description: "submit",
          inputSchema: { type: "object" },
          executionClass: "read",
          workCategory: "generation",
        },
        validate: (args: unknown) => ({ ok: true, value: args as never }),
        execute: async () => ({
          content: { documentId: "doc-1" },
          materialRef: {
            documentId: "doc-1",
            documentVersion: 1,
            contentHash: "hash-1",
          },
          materialKind: "literature_review",
          materialTitle: "Review",
          materialCitedSources: [
            { citationId: "c1", libraryID: 1, itemKey: "A", itemId: 11 },
            { citationId: "c2", libraryID: 1, itemKey: "B", itemId: 12 },
            { citationId: "c3", libraryID: 1, itemKey: "A", itemId: 11 },
            { citationId: "c4", libraryID: 1, itemKey: "GONE" },
          ],
        }),
      } as never);
      const harness = await createHarness(registry);
      const recorded: OutcomeEvidence[] = [];
      harness.deps.recordOutcomeEvidence = async (evidence) => {
        recorded.push(evidence);
      };
      const toolExecution = createToolExecution(harness.deps);
      await toolExecution.executeToolWorkflow(
        {
          id: "call-submit",
          name: "submit_document",
          arguments: { taskId: "review" },
        },
        1,
        { modelCallId: "provider-submit" },
      );
      const materials = recorded.filter((entry) => entry.kind === "material");
      assert.deepEqual(materials, [
        {
          kind: "material",
          materialRef: {
            documentId: "doc-1",
            documentVersion: 1,
            contentHash: "hash-1",
          },
          taskId: "review",
          documentKind: "literature_review",
          citedTargets: ["item:11", "item:12"],
        },
      ]);
    } finally {
      restoreDb();
    }
  });

  it("lands the papers a submitted document leaves out on the part it names, and echoes them to the model", async function () {
    const restoreDb = installMockDb();
    const restoreDocuments = installAgentStoreSqlite();
    try {
      await initPlanDocumentStore();
      const registry = new AgentToolRegistry(createTestActionContractService());
      // A document without citations formats none.
      registry.register(
        createSubmitDocumentTool({
          formatStructuredCitations: () => ({
            styleId: "apa",
            styleTitle: "APA",
            locale: "en-US",
            clusters: [],
            bibliographyEntries: [],
          }),
        } as unknown as ZoteroGateway),
      );
      const harness = await createHarness(registry);
      harness.request.executionCheckpoint = declareOutcomes(
        createEmptyExecutionCheckpoint(harness.request.executionContext!, 1),
        [
          {
            taskId: "review",
            description: "Write the review",
            effect: "artifact",
            targets: ["item:5", "item:6", "item:7"],
          },
        ],
        2,
      );
      harness.deps.recordOutcomeEvidence = async (evidence) => {
        harness.request.executionCheckpoint = applyOutcomeEvidence(
          harness.request.executionCheckpoint!,
          evidence,
          3,
        ).checkpoint;
      };
      const reason = "An economics paper; it does not address drift";
      const toolExecution = createToolExecution(harness.deps);
      await toolExecution.executeToolWorkflow(
        {
          id: "call-submit",
          name: "submit_document",
          arguments: {
            taskId: "review",
            excluded: [{ targetIds: ["7"], reason }],
            documentKind: "report",
            integrityPolicy: "authored",
            title: "Drift",
            markdown: "# Drift\n\nOne paper is left out.",
            citations: [],
            quotes: [],
            assets: [],
            groundingReviewed: "passed",
            groundingIssues: [],
          },
        },
        1,
        { modelCallId: "call-submit" },
      );
      const result = harness.events.find(
        (event) => event.type === "tool_result",
      ) as Extract<AgentEvent, { type: "tool_result" }> | undefined;
      assert.isTrue(result?.ok, JSON.stringify(result?.content));
      assert.deepEqual(
        (result!.content as { excluded?: unknown }).excluded,
        [{ targetIds: ["item:7"], reason }],
        "the model reads back what the host records",
      );
      const [part] = harness.request.executionCheckpoint!.tasks;
      assert.equal(part.taskId, "run-collaborator:task:review");
      assert.equal(part.status, "completed");
      assert.lengthOf(part.materialRefs, 1);
      assert.deepEqual(part.excludedTargets, [{ targets: ["item:7"], reason }]);
      assert.deepEqual(part.exceptions, [
        { targets: ["item:5", "item:6"], reason: OUTCOME_REASONS.notCovered },
      ]);
    } finally {
      restoreDocuments();
      restoreDb();
    }
  });

  it("hands an accepted document back while declared parts beyond the answer remain open, naming only those", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registerDocumentTool(registry);
      const harness = await createHarness(registry);
      harness.request.executionCheckpoint = checkpointWith([
        ["Summarize the paper", "pending", "answer"],
        ["Save the summary as a note", "pending", "mutation"],
        ["Tag the paper", "pending", "mutation"],
        ["Read the paper", "completed", "read"],
        ["Ask which collection to use", "blocked", "mutation"],
        ["Check the citation style", "skipped", "artifact"],
      ]);
      const toolExecution = createToolExecution(harness.deps);

      const open = await toolExecution.executeToolWorkflow(
        { id: "call-submit", name: "submit_document", arguments: {} },
        1,
        { modelCallId: "provider-submit" },
      );

      assert.isUndefined(open.stopRun, "open work keeps the turn running");
      assert.deepEqual(open.delivery?.content, {
        content: { documentId: "doc-1" },
        remainingWork: "Save the summary as a note; Tag the paper",
        finalizedDocumentId: "doc-1",
        instruction:
          "The document is finalized and preserved. Complete any remaining requested work with this finalized document, passing its documentId where a tool accepts one; do not regenerate it.",
        actionReceipts: [],
      });

      // The document itself answers a declared reasoning part.
      harness.request.executionCheckpoint = checkpointWith([
        ["Summarize the paper", "pending", "answer"],
        ["Read the paper", "completed", "read"],
        ["Ask which collection to use", "blocked", "mutation"],
      ]);
      const closed = await toolExecution.executeToolWorkflow(
        { id: "call-submit-2", name: "submit_document", arguments: {} },
        1,
        { modelCallId: "provider-submit-2", followingCallCount: 0 },
      );

      assert.isTrue(closed.stopRun, "with nothing open the document ends it");
      assert.equal(closed.finalText, "The document is ready.");
      assert.equal(closed.documentId, "doc-1");
    } finally {
      restoreDb();
    }
  });

  it("refuses to execute once the conversation stops accepting writes", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registerReadTool(registry);
      const harness = await createHarness(registry);
      const deps = { ...harness.deps, writeAllowed: () => false };
      const toolExecution = createToolExecution(deps);

      const outcome = await toolExecution.executeToolWorkflow(
        { id: "call-late", name: "library_search", arguments: {} },
        1,
      );

      assert.deepEqual(harness.events, [], "a refused call publishes nothing");
      assert.isTrue(outcome.failed);
      assert.isTrue(outcome.stopRun);
      assert.isFalse(outcome.toolResult.ok);
      assert.equal(
        outcome.finalText,
        "Conversation lifecycle changed before execution.",
      );
      assert.deepEqual(
        (outcome.toolResult.actionReceipts || []).map(
          (receipt) => receipt.verification,
        ),
        ["unverified"],
      );
    } finally {
      restoreDb();
    }
  });

  it("answers a call Stop kept from starting as not started: nothing runs, nothing is published, no receipt", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registerWriteTool(registry);
      let executed = 0;
      const tool = registry.getTool("note_write")!;
      const execute = tool.execute.bind(tool);
      tool.execute = (async (...args: Parameters<typeof execute>) => {
        executed += 1;
        return execute(...args);
      }) as typeof tool.execute;
      const harness = await createHarness(registry);
      const stop = new AbortController();
      stop.abort();
      const evidence: OutcomeEvidence[] = [];
      const toolExecution = createToolExecution({
        ...harness.deps,
        signal: stop.signal,
        recordOutcomeEvidence: async (entry) => {
          evidence.push(entry);
        },
      });

      const outcome = await toolExecution.executeToolWorkflow(
        { id: "call-after-stop", name: "note_write", arguments: {} },
        1,
        { modelCallId: "call-after-stop" },
      );

      assert.equal(executed, 0, "the tool never ran");
      assert.deepEqual(
        harness.events,
        [],
        "a call that never ran says nothing",
      );
      assert.deepEqual(
        harness.records,
        [],
        "nor is it one of the turn's calls",
      );
      assert.deepEqual(evidence, [], "it is no evidence for the ledger");
      assert.isTrue(outcome.notStarted);
      assert.isUndefined(outcome.stopRun, "the next model step ends the run");
      assert.deepEqual(outcome.toolResult, {
        callId: "call-after-stop",
        name: "note_write",
        ok: false,
        effect: "none",
        actionReceipts: [],
        content: {
          status: "not_started",
          error:
            "Stopped before it started: the user pressed Stop, so this call did not run and changed nothing.",
        },
      });
      assert.deepEqual(outcome.delivery, {
        callId: "call-after-stop",
        name: "note_write",
        content: {
          status: "not_started",
          error:
            "Stopped before it started: the user pressed Stop, so this call did not run and changed nothing.",
          actionReceipts: [],
        },
        followupMessages: [],
      });
    } finally {
      restoreDb();
    }
  });

  it("lets an ordinary turn's document include a figure its own figure read returned", async function () {
    const turn = await startFigureTurn();
    try {
      assert.deepEqual(
        (turn.harness.request.documentArtifactObservations || []).map(
          (artifact) => [artifact.storedPath, artifact.contentHash],
        ),
        [[CROP_PATH, turn.asset.contentHash]],
        "the turn records the figure read's artifact",
      );

      const submitted = await turn.submit([turn.asset]);

      assert.isTrue(
        submitted.toolResult.ok,
        JSON.stringify(submitted.toolResult.content),
      );
      const { documentId } = submitted.toolResult.content as {
        documentId: string;
      };
      const published = (await loadPlanDocument(documentId))?.assets || [];
      assert.lengthOf(published, 1, "the published document has the figure");
      assert.include(published[0], {
        assetId: turn.asset.assetId,
        caption: FIGURE_CAPTION,
        contentHash: turn.asset.contentHash,
      });
      assert.notEqual(
        published[0].durablePath,
        CROP_PATH,
        "the document keeps its own copy of the crop",
      );
      assert.deepEqual(turn.files.get(published[0].durablePath), CROP_BYTES);
    } finally {
      turn.restore();
    }
  });

  it("still refuses a document asset no tool call emitted", async function () {
    const turn = await startFigureTurn();
    try {
      // A crop on disk that no call in this turn returned.
      const unrecordedPath = "/tmp/figure-crops/figure-2-p4.png";
      turn.files.set(unrecordedPath, CROP_BYTES);

      const refused = await turn.submit([
        {
          ...turn.asset,
          assetId: "PDF00001-figure-2-p4",
          durablePath: unrecordedPath,
        },
      ]);

      assert.isFalse(refused.toolResult.ok);
      assert.deepEqual(refused.toolResult.content, {
        error:
          "Document asset PDF00001-figure-2-p4 was not emitted by a successful host tool call",
      });
      assert.isNull(
        turn.harness.finalizedMaterial.value,
        "nothing is published",
      );
    } finally {
      turn.restore();
    }
  });

  it("lets a document include a figure read from a standalone PDF", async function () {
    const turn = await startFigureTurn(STANDALONE_PDF);
    try {
      const submitted = await turn.submit([turn.asset]);

      assert.isTrue(
        submitted.toolResult.ok,
        JSON.stringify(submitted.toolResult.content),
      );
      const { documentId } = submitted.toolResult.content as {
        documentId: string;
      };
      const published = (await loadPlanDocument(documentId))?.assets || [];
      assert.lengthOf(published, 1, "the published document has the figure");
      assert.include(published[0], {
        assetId: "PDF00033-figure-1-p2",
        contentHash: turn.asset.contentHash,
      });
    } finally {
      turn.restore();
    }
  });

  it("still refuses a standalone PDF's figure asset that names another attachment", async function () {
    const turn = await startFigureTurn(STANDALONE_PDF);
    try {
      const refused = await turn.submit([
        {
          ...turn.asset,
          provenance: {
            ...turn.asset.provenance,
            attachmentItemKey: "PDF00001",
          },
        } as PlanDocumentAsset,
      ]);

      assert.isFalse(refused.toolResult.ok);
      assert.deepEqual(refused.toolResult.content, {
        error:
          "Extracted asset PDF00033-figure-1-p2 is not backed by a host-verified figure observation",
      });
      assert.isNull(
        turn.harness.finalizedMaterial.value,
        "nothing is published",
      );
    } finally {
      turn.restore();
    }
  });
});

/**
 * A library_retrieve result over 40 papers, as the service ranks it: 20
 * matched with three passages each, 10 matched in the index but never read,
 * and 10 fallback leads that matched nothing.
 */
function rankedRetrieveResult(): LibraryRetrieveResult {
  const papers = [
    ...Array.from({ length: 20 }, () => ({ status: "strong", passages: 3 })),
    ...Array.from({ length: 10 }, () => ({
      status: "mentions_only",
      passages: 0,
    })),
    ...Array.from({ length: 10 }, () => ({
      status: "not_enough_evidence",
      passages: 1,
      lead: true,
    })),
  ] as Array<{ status: string; passages: number; lead?: boolean }>;
  const snippets: LibraryRetrieveSnippet[] = papers.flatMap((paper, i) =>
    Array.from({ length: paper.passages }, (_, k) => ({
      snippetId: `lr_${i + 1}_${101 + i}_${k}_bm25`,
      itemId: String(i + 1),
      contextItemId: String(101 + i),
      chunkIndex: k,
      title: `Paper ${i + 1}`,
      citationLabel: `Author${i + 1}, 2020`,
      sourceKind: "mineru" as const,
      matchMethod: "bm25" as const,
      sectionLabel: "Results",
      snippet: `Passage ${k} of paper ${i + 1}. ${"drift ".repeat(40)}`,
      surroundingText: `Chunk ${k}. ${"context ".repeat(120)}`,
      score: 100 - i - k / 10,
      whyMatched: "Library index BM25 ranked this passage highly",
      ...(paper.lead ? { leadingPassage: true as const } : {}),
    })),
  );
  return {
    queryPlan: { originalQuery: "drift" } as never,
    resourcePool: {
      type: "collection",
      scope: { libraryID: 1, collectionIds: [6] },
      totalItems: papers.length,
      states: {} as never,
      queryCoverage: {} as never,
    },
    intent: "enumerate",
    depth: "evidence",
    methodsUsed: ["metadata", "fts"],
    candidates: papers.map((_, i) => ({
      itemId: String(i + 1),
      title: `Paper ${i + 1}`,
      resourceState: ["available"],
      queryState: ["shortlisted"],
      score: 50 - i,
      whyMatched: "library index: 3 matching passage(s)",
    })),
    paperMatches: papers.map((paper, i) => ({
      itemId: String(i + 1),
      title: `Paper ${i + 1}`,
      matchStatus: paper.status as never,
      basis: paper.lead ? [] : ["indexed_text"],
      returnedSnippetCount: paper.passages,
      confidence: "high",
      whyMatched: "library index: 3 matching passage(s)",
    })),
    frontier: {
      needsSnippetExpansion: [],
      needsCloseRead: [],
      suggestedNextQueries: [],
      stopReason: "budget_limit",
    },
    answerContract: {
      resolvedStrategy: "evidence_overview",
      metadataCoverage: "complete",
      indexedTextCoverage: "complete",
      snippetCoverage: "sampled",
      safeClaims: [],
      unsafeClaims: [],
    } as never,
    coverageReceipt: { text: "receipt" } as never,
    synthesisDigest: "Paper synthesis digest:",
    snippets,
    warnings: [],
  };
}

/** Zotero items behind the result, so its reads issue evidence refs. */
function installRetrievedItems(count: number): () => void {
  const zotero = (globalThis as unknown as { Zotero: Record<string, unknown> })
    .Zotero;
  const original = zotero.Items;
  const items = new Map<number, Record<string, unknown>>();
  for (let i = 1; i <= count; i += 1) {
    items.set(i, { id: i, key: `ITEM${i}`, libraryID: 1 });
    items.set(100 + i, {
      id: 100 + i,
      key: `PDF${i}`,
      libraryID: 1,
      parentID: i,
      isAttachment: () => true,
    });
  }
  zotero.Items = { get: (id: number) => items.get(id) || null };
  return () => {
    zotero.Items = original;
  };
}

describe("library_retrieve model view delivery", function () {
  it("sends the model a view sized to the intent and keeps the whole result behind a handle that context_read pages", async function () {
    const restoreDb = installMockDb();
    const restoreItems = installRetrievedItems(40);
    clearAgentToolResultHandleStore();
    try {
      const full = rankedRetrieveResult();
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register(
        createLibraryRetrieveTool({ retrieve: async () => full } as never),
      );
      const harness = await createHarness(registry);
      const stored: AgentToolResultHandleRecord[] = [];
      harness.deps.persistToolResultHandles = async (records) => {
        stored.push(...records);
        await upsertAgentToolResultHandles(records);
      };
      const toolExecution = createToolExecution(harness.deps);
      const outcome = await toolExecution.executeToolWorkflow(
        {
          id: "call-retrieve",
          name: "library_retrieve",
          arguments: { query: "drift", intent: "enumerate" },
        },
        1,
        { modelCallId: "call-retrieve" },
      );

      const view = outcome.delivery!.content as Record<string, any>;
      assert.lengthOf(
        view.paperMatches,
        30,
        "every matching paper, no fallback lead",
      );
      assert.lengthOf(view.snippets, 20, "one passage per matched paper");
      assert.match(view.toolResultHandle, /^trh_/);
      assert.include(view.omitted, { paperMatches: 10, snippets: 50 });
      assert.isAbove(view.omitted.documentEvidenceRefs, 0);
      const refKeys = (view.documentEvidenceRefs as Array<any>).map(
        (ref) => `${ref.itemKey}:${ref.attachmentItemKey || ""}`,
      );
      assert.include(refKeys, "ITEM1:PDF1", "a shown passage keeps its ref");
      assert.match(
        view.documentEvidenceRefs[0].evidenceRef,
        /^[0-9a-f]{12}:\d+$/,
        "the model sees the short ref",
      );
      assert.notInclude(
        refKeys,
        "ITEM31:PDF31",
        "a lead the view leaves out takes its ref with it",
      );

      const event = harness.events.find(
        (entry) => entry.type === "tool_result",
      ) as Extract<AgentEvent, { type: "tool_result" }>;
      assert.lengthOf(
        (event.content as LibraryRetrieveResult).snippets,
        70,
        "the UI, ledger and citations still read the whole result",
      );
      assert.lengthOf(stored, 1);
      assert.equal(stored[0].handle, view.toolResultHandle);
      assert.lengthOf((stored[0].content as any).snippets, 70);
      assert.isTrue(harness.toolResultReadAvailable.value);

      const contextRead = createContextReadTool();
      const input = contextRead.validate({
        source: "tool_result",
        handle: view.toolResultHandle,
        path: "snippets",
        offset: view.snippets.length,
        limit: 200,
        maxTokens: 24_000,
      });
      assert.isTrue(input.ok);
      const page = (await contextRead.execute(
        (input as { value: never }).value,
        harness.deps.context,
      )) as Record<string, any>;
      assert.equal(page.totalCount, 70);
      const shown = new Set(view.snippets.map((row: any) => row.snippetId));
      assert.isNotEmpty(page.items);
      assert.isTrue(
        page.items.every((row: any) => !shown.has(row.snippetId)),
        "paging from the number shown reads only what the view left out",
      );
      assert.property(page.items[0], "surroundingText", "whole rows");
    } finally {
      clearAgentToolResultHandleStore();
      restoreItems();
      restoreDb();
    }
  });

  it("sends the whole result when no handle can hold it", async function () {
    const restoreDb = installMockDb();
    try {
      const full = rankedRetrieveResult();
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register(
        createLibraryRetrieveTool({ retrieve: async () => full } as never),
      );
      const harness = await createHarness(registry);
      // A conversation key the handle store refuses.
      harness.request.conversationKey = 0 as never;
      const outcome = await createToolExecution(
        harness.deps,
      ).executeToolWorkflow(
        {
          id: "call-retrieve",
          name: "library_retrieve",
          arguments: { query: "drift", intent: "enumerate" },
        },
        1,
        { modelCallId: "call-retrieve" },
      );
      const delivered = outcome.delivery!.content as Record<string, any>;
      assert.lengthOf(delivered.snippets, 70);
      assert.notProperty(delivered, "toolResultHandle");
    } finally {
      restoreDb();
    }
  });
});

describe("library_search list model view delivery", function () {
  /** A collection of `count` papers as the gateway lists and reads them. */
  function listGateway(count: number) {
    const fields = (index: number) => ({
      title: `Paper ${index}`,
      abstractNote: "",
      publicationTitle: "Journal of Drift",
      date: "2020",
      volume: "",
      issue: "",
      pages: "",
      DOI: "",
      url: "",
      extra: "",
    });
    return {
      resolveLibraryID: () => 1,
      getItem: (id: number) => ({ id, key: `ITEM${id}` }),
      getEditableArticleMetadata: (item: { id: number } | null) =>
        item
          ? {
              itemId: item.id,
              itemType: "journalArticle",
              title: `Paper ${item.id}`,
              fields: fields(item.id),
              creators: [
                { creatorType: "author", lastName: `Author${item.id}` },
              ],
            }
          : null,
      listItemsByFilters: async () => ({
        items: Array.from({ length: count }, (_, i) => ({
          itemId: i + 1,
          itemType: "journalArticle",
          title: `Paper ${i + 1}`,
          firstCreator: `Author${i + 1}`,
          year: "2020",
          attachments: [],
          tags: [],
          collectionIds: [6],
        })),
        totalCount: count,
      }),
    };
  }

  it("sends the model every listed item briefly, the top rows whole, and keeps the whole list behind a handle", async function () {
    const restoreDb = installMockDb();
    const restoreItems = installRetrievedItems(100);
    clearAgentToolResultHandleStore();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register(createLibrarySearchTool(listGateway(100) as never));
      const harness = await createHarness(registry);
      harness.deps.persistToolResultHandles = async (records) => {
        await upsertAgentToolResultHandles(records);
      };
      const outcome = await createToolExecution(
        harness.deps,
      ).executeToolWorkflow(
        {
          id: "call-list",
          name: "library_search",
          arguments: {
            entity: "items",
            mode: "list",
            filters: { collectionId: 6 },
            include: ["metadata"],
            limit: 100,
          },
        },
        1,
        { modelCallId: "call-list" },
      );
      const view = outcome.delivery!.content as Record<string, any>;
      assert.lengthOf(view.results, 25);
      assert.lengthOf(view.moreResults, 75);
      assert.equal(view.omitted.results, 75);
      assert.lengthOf(
        view.documentEvidenceRefs,
        100,
        "a paper listed briefly keeps its evidence ref, so a document can cite it",
      );
      assert.match(view.toolResultHandle, /^trh_/);
      const event = harness.events.find(
        (entry) => entry.type === "tool_result",
      ) as Extract<AgentEvent, { type: "tool_result" }>;
      assert.lengthOf(
        (event.content as { results: unknown[] }).results,
        100,
        "the UI and ledgers read the whole list",
      );

      const contextRead = createContextReadTool();
      const input = contextRead.validate({
        source: "tool_result",
        handle: view.toolResultHandle,
        path: "results",
        offset: view.results.length,
      });
      assert.isTrue(input.ok);
      const page = (await contextRead.execute(
        (input as { value: never }).value,
        harness.deps.context,
      )) as Record<string, any>;
      assert.equal(page.items[0].itemId, 26, "from the first row shown brief");
      assert.property(page.items[0], "metadata", "whole rows");
    } finally {
      clearAgentToolResultHandleStore();
      restoreItems();
      restoreDb();
    }
  });

  it("leaves other library_search modes whole", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register(
        createLibrarySearchTool({
          ...listGateway(40),
          listCollectionSummaries: () => [],
        } as never),
      );
      const harness = await createHarness(registry);
      const outcome = await createToolExecution(
        harness.deps,
      ).executeToolWorkflow(
        {
          id: "call-collections",
          name: "library_search",
          arguments: { entity: "collections", mode: "list" },
        },
        1,
        { modelCallId: "call-collections" },
      );
      assert.notProperty(
        outcome.delivery!.content as Record<string, unknown>,
        "toolResultHandle",
      );
    } finally {
      restoreDb();
    }
  });
});

describe("a big result's trace handle", function () {
  function bigReadRegistry(): AgentToolRegistry {
    const registry = new AgentToolRegistry(createTestActionContractService());
    registry.register({
      spec: {
        name: "paper_read",
        description: "read papers",
        inputSchema: { type: "object" },
        executionClass: "read",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args }),
      execute: async () => ({ text: "p".repeat(40_000) }),
    });
    return registry;
  }

  async function runBigRead(written: boolean | void) {
    const harness = await createHarness(bigReadRegistry());
    const stored: AgentToolResultHandleRecord[] = [];
    harness.deps.persistToolResultHandles = async (records) => {
      stored.push(...records);
      return written;
    };
    await createToolExecution(harness.deps).executeToolWorkflow(
      { id: "call-big", name: "paper_read", arguments: {} },
      1,
      { modelCallId: "call-big" },
    );
    const event = harness.events.find(
      (entry) => entry.type === "tool_result",
    ) as Extract<AgentEvent, { type: "tool_result" }>;
    return { event, stored };
  }

  it("names the handle once its write is confirmed", async function () {
    const restoreDb = installMockDb();
    try {
      const { event, stored } = await runBigRead(true);
      assert.lengthOf(stored, 1);
      assert.equal(event.toolResultHandle, stored[0].handle);
    } finally {
      restoreDb();
    }
  });

  it("names no handle when the write did not reach the database, so the trace keeps the result whole", async function () {
    const restoreDb = installMockDb();
    try {
      const { event, stored } = await runBigRead(false);
      assert.lengthOf(stored, 1, "the write was attempted");
      assert.notProperty(event, "toolResultHandle");
      assert.lengthOf((event.content as { text: string }).text, 40_000);
    } finally {
      restoreDb();
    }
  });
});

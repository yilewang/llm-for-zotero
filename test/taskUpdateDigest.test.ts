import { assert } from "chai";
import { ActionContractRunSession } from "../src/agent/contracts/actionContractRunSession";
import { PaperEvidenceFrontier } from "../src/agent/context/paperEvidenceFrontier";
import { buildAgentResourceContextPlan } from "../src/agent/context/resourceContextPlan";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { createAgentExecutionContext } from "../src/agent/execution/context";
import { createEmptyExecutionCheckpoint } from "../src/agent/execution/checkpoint";
import {
  createToolExecution,
  type ToolExecutionDeps,
} from "../src/agent/execution/toolExecution";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import {
  createTaskUpdateTool,
  type TaskUpdateToolDeps,
} from "../src/agent/tools/control/taskUpdate";
import {
  PAPER_DIGEST_HANDLE_TOOL,
  createDigestReadObservation,
  createHandleStorePaperDigestCache,
  createZoteroPaperDigestSources,
} from "../src/agent/digests/digestJobHost";
import {
  digestSourceLabel,
  type HostPaperDigest,
} from "../src/agent/digests/paperDigestWorker";
import { SECTIONS_NOT_FOUND_RULE } from "../src/agent/digests/readScope";
import { PassageCitationCollector } from "../src/agent/context/passageCitationCollector";
import { selectUsedQuoteCitations } from "../src/services/quotes/quoteCitations";
import type { QuoteCitation } from "../src/shared/types";
import type { MaterialRef } from "../src/agent/documents/materialRef";
import type { TaskPaperLedgerDelta } from "../src/agent/context/taskPaperLedger";
import {
  clearAgentToolResultHandleStore,
  createAgentToolResultHandleRecord,
  getAgentToolResultHandle,
  upsertAgentToolResultHandles,
  type AgentToolResultHandleRecord,
} from "../src/agent/store/toolResultHandles";
import type {
  AgentEvent,
  AgentModelCapabilities,
  AgentRuntimeRequest,
  AgentToolContext,
  ExecutionCheckpoint,
} from "../src/agent/types";
import type { PaperContextRef } from "../src/shared/types";
import type { ChatParams } from "../src/utils/llmClient";
import {
  installAgentStoreSqlite,
  installMockDb,
} from "./helpers/agentRuntimeMockDb";
import { createSubmitDocumentTool } from "../src/agent/tools/control/submitDocument";
import { createContextReadTool } from "../src/agent/tools/read/contextRead";
import { initPlanDocumentStore } from "../src/agent/documents/store";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { createTestActionContractService } from "./helpers/actionContractService";

/**
 * A declared digest part, run by the host inside `task_update`.
 *
 * The real tool runs through the real tool-execution collaborator; only the
 * paper resolver, the text reader and the model call are scripted.
 */

const CAPABILITIES: AgentModelCapabilities = {
  streaming: false,
  toolCalls: true,
  multimodal: false,
};

/** A paper long enough to summarize (the host refuses under 1,500 characters). */
const TEXT = `# Introduction\nPlace cells drift slowly across days.\n\n## Methods\nWe recorded forty cells over ten days.\n\n## Appendix\n${"The appendix restates the recording protocol in detail. ".repeat(30)}`;

/** A schema 2 reply: the answer, one verified quote, and summary facets. */
const reply = (answer: string, extra: Record<string, unknown> = {}) => ({
  text: JSON.stringify({
    answer,
    evidence: [
      { section: "Methods", quote: "We recorded forty cells over ten days." },
    ],
    facets: [
      { label: "Contributions", content: "Drift is slow." },
      { label: "Methods", content: "Two-photon imaging." },
    ],
    ...extra,
  }),
  completion: { status: "complete" as const },
});

const PAPERS: Record<number, PaperContextRef> = {
  5: {
    libraryID: 1,
    itemId: 5,
    contextItemId: 105,
    title: "Drift A",
    year: "2021",
    firstCreator: "Ziv",
  },
  6: { libraryID: 1, itemId: 6, contextItemId: 106, title: "Drift B" },
  7: { libraryID: 1, itemId: 7, contextItemId: 107, title: "Drift C" },
};

type Harness = {
  deps: ToolExecutionDeps;
  events: AgentEvent[];
  request: AgentRuntimeRequest;
  /** The ledger after each change the tool published. */
  published: ExecutionCheckpoint[];
  handles: AgentToolResultHandleRecord[];
  context: AgentToolContext;
};

const SUMMARIZE = {
  taskId: "summaries",
  description: "Summarize each selected paper",
  expectedEffect: "digest",
  scope: true,
};

let conversationKey = 975_000;

function createHarness(
  digestDeps: TaskUpdateToolDeps["digests"],
  itemIds: number[] = [5, 6, 7],
  register?: (registry: AgentToolRegistry) => void,
): Harness {
  conversationKey += 1;
  const registry = new AgentToolRegistry(createTestActionContractService());
  registry.register(createTaskUpdateTool({ digests: digestDeps }));
  register?.(registry);
  const events: AgentEvent[] = [];
  const published: ExecutionCheckpoint[] = [];
  const handles: AgentToolResultHandleRecord[] = [];
  const request = resolveAgentRuntimeRequest(
    {
      conversationKey,
      mode: "agent",
      libraryID: 1,
      userText: "Summarize all papers for me and write a literature review",
      model: "test-model",
      apiKey: "test-key",
      apiBase: "https://example.invalid/v1",
    },
    {},
  ) as AgentRuntimeRequest;
  request.executionContext = createAgentExecutionContext(request, "run-digest");
  request.turnScopePapers = {
    wholeLibrary: false,
    itemIds,
    withText: itemIds.length - 1,
    papers: Object.fromEntries(
      itemIds.map((itemId) => [
        itemId,
        {
          title: PAPERS[itemId]?.title || `Paper ${itemId}`,
          text: itemId === 7 ? "none" : "mineru",
        },
      ]),
    ) as never,
  };
  const emit = async (event: AgentEvent) => {
    events.push(event);
  };
  // The runtime's one ledger writer, reduced to its contract: serialized,
  // and each change that moves the ledger published once.
  let writes: Promise<unknown> = Promise.resolve();
  const context = {
    request,
    runId: "run-digest",
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
    resourceSignature: "scope-1",
    signal: undefined,
    updateExecutionCheckpoint: (
      apply: (checkpoint: ExecutionCheckpoint) => ExecutionCheckpoint,
    ) => {
      const write = writes.then(async () => {
        const current =
          request.executionCheckpoint ||
          createEmptyExecutionCheckpoint(request.executionContext!, 10);
        const next = apply(current);
        if (next !== current) {
          request.executionCheckpoint = next;
          published.push(structuredClone(next));
          await emit({ type: "status", text: "ledger" });
        }
        return next;
      });
      writes = write.catch(() => undefined);
      return write;
    },
  } as unknown as AgentToolContext;
  const deps = {
    registry,
    now: () => 1_700_000_000_000,
    signal: undefined,
    emit,
    request,
    runId: "run-digest",
    context,
    writeAllowed: () => true,
    adapterCapabilities: CAPABILITIES,
    actionContractSession: new ActionContractRunSession(),
    paperEvidenceFrontier: new PaperEvidenceFrontier(),
    resourceContextPlan: buildAgentResourceContextPlan(request),
    persistToolResultHandles: async (
      written: AgentToolResultHandleRecord[],
    ) => {
      handles.push(...written);
      await upsertAgentToolResultHandles(written);
    },
    requestActionResolution: async () => {
      throw new Error("no confirmation is expected in this test");
    },
    finalizedMaterialRefs: new Map<string, MaterialRef>(),
    pendingReadActivities: [],
    preservedTurnHandleRecords: [],
    toolExecutionRecords: [],
    toolsUsedThisTurn: [],
    getCurrentAnswerText: () => "",
    setFinalizedMaterial: () => undefined,
    setToolResultReadAvailable: () => undefined,
  } as unknown as ToolExecutionDeps;
  return { deps, events, request, published, handles, context };
}

/** Scripted resolver and reader: paper 7 has no text. */
function scriptedDigests(
  llmCall: (chat: ChatParams) => Promise<ReturnType<typeof reply>>,
): NonNullable<TaskUpdateToolDeps["digests"]> {
  return {
    resolvePaper: async (_request, itemId) => PAPERS[itemId] || null,
    readText: async (paper) =>
      paper.itemId === 7
        ? null
        : { backend: "mineru", text: TEXT, totalCharacters: TEXT.length },
    llmCall: llmCall as never,
  };
}

async function runCall(
  harness: Harness,
  id: string,
  args: Record<string, unknown>,
) {
  const execution = createToolExecution(harness.deps);
  return execution.executeToolWorkflow(
    { id, name: "task_update", arguments: args },
    1,
    { modelCallId: id },
  );
}

function ledgerDeltas(harness: Harness): TaskPaperLedgerDelta[] {
  return harness.events.flatMap((event) =>
    event.type === "paper_ledger_update"
      ? [(event as { delta: TaskPaperLedgerDelta }).delta]
      : [],
  );
}

describe("task_update runs a declared digest part", function () {
  let restoreDb: () => void;

  beforeEach(function () {
    restoreDb = installMockDb();
    clearAgentToolResultHandleStore();
  });

  afterEach(function () {
    clearAgentToolResultHandleStore();
    restoreDb();
  });

  it("digests each paper with the turn's model, ticking the ledger and the paper rows paper by paper", async function () {
    const chats: ChatParams[] = [];
    const harness = createHarness(
      scriptedDigests(async (chat) => {
        chats.push(chat);
        return reply("Cells drift slowly.");
      }),
    );
    harness.request.runtimeContextBudget = {
      contextWindowTokens: 64_000,
      usedContextTokens: 1_000,
    };

    const outcome = await runCall(harness, "call-digest", {
      tasks: [SUMMARIZE],
    });

    assert.isTrue(outcome.toolResult.ok);
    const answer = outcome.toolResult.content as Record<string, any>;
    assert.deepEqual(answer.parts, [
      {
        taskId: "summaries",
        status: "completed",
        done: 2,
        total: 3,
        exceptions: 1,
        reasons: ["No readable text"],
        scope: true,
      },
    ]);
    assert.isUndefined(answer.note, "a digest declaration is never a no-op");
    assert.include(answer.digests, "### Drift A (item:5)");
    assert.include(answer.digests, "Answer: Cells drift slowly.");
    assert.include(answer.digests, "- Contributions: Drift is slow.");
    assert.include(answer.digests, "Not analyzed:");
    assert.deepEqual(answer.digestFailures, [
      { itemId: 7, title: "Drift C", reason: "No readable text" },
    ]);
    assert.isUndefined(answer.digestPending);

    // The chat turn's own model and endpoint, never its reasoning setting.
    assert.lengthOf(chats, 2);
    for (const chat of chats) {
      assert.equal(chat.model, "test-model");
      assert.equal(chat.apiBase, "https://example.invalid/v1");
      assert.equal(chat.apiKey, "test-key");
    }

    // One ledger change per paper after the declaration.
    assert.lengthOf(
      harness.published,
      4,
      "the declaration, then one per paper",
    );
    const last = harness.published[3].tasks[0];
    assert.sameMembers(last.doneTargets || [], ["item:5", "item:6"]);

    // One paper-row update per paper, each with its own call id.
    const deltas = ledgerDeltas(harness);
    assert.sameDeepMembers(
      deltas.map((delta) => [
        delta.papers[0].itemId,
        delta.toolName,
        delta.reads[0].granularity,
        Boolean(delta.reads[0].snippet),
      ]),
      [
        [5, "task_update", "digest", true],
        [6, "task_update", "digest", true],
        [7, "task_update", "digest", false],
      ],
    );
    assert.sameMembers(
      deltas.map((delta) => delta.callId),
      [
        "call-digest:digest:5",
        "call-digest:digest:6",
        "call-digest:digest:7:failed",
      ],
    );
    // Every paper's digest read, and the failure's, names its part by its
    // full task id, which carries its run.
    const executionId = harness.request.executionCheckpoint!.executionId;
    for (const delta of deltas)
      assert.include(delta.reads[0], {
        partId: `${executionId}:task:summaries`,
        label: "Summarize each selected paper",
      });
    const paper5 = deltas.find((delta) => delta.papers[0].itemId === 5)!;
    assert.include(paper5.papers[0], {
      libraryID: 1,
      contextItemId: 105,
      title: "Drift A",
      year: "2021",
      creator: "Ziv",
    });
    assert.equal(paper5.runId, "run-digest");
    // The rows are updated while the call runs, before its result.
    const resultIndex = harness.events.findIndex(
      (event) => event.type === "tool_result",
    );
    const lastDeltaIndex = harness.events.reduce(
      (at, event, index) => (event.type === "paper_ledger_update" ? index : at),
      -1,
    );
    assert.isAbove(resultIndex, lastDeltaIndex);

    // One part renders as it did before parts were grouped: no part heading.
    assert.notInclude(answer.digests, "## Part");
    assert.isTrue(
      (answer.digests as string).startsWith("### Drift A (item:5)"),
    );
    // Each digest is stored for context_read and named by its handle.
    assert.lengthOf(answer.digestHandles, 2);
    assert.deepEqual(
      answer.digestHandles.map((entry: { taskId: string }) => entry.taskId),
      ["summaries", "summaries"],
    );
    assert.sameMembers(
      answer.digestHandles.map((entry: { itemId: number }) => entry.itemId),
      [5, 6],
    );
    const digestRecords = harness.handles.filter(
      (record) => record.toolName === PAPER_DIGEST_HANDLE_TOOL,
    );
    assert.sameMembers(
      digestRecords.map((record) => record.handle),
      answer.digestHandles.map((entry: { handle: string }) => entry.handle),
    );
    assert.isTrue(
      harness.request.metadata?.agentToolResultReadAvailable === true,
      "context_read is offered once a digest is stored",
    );
  });

  it("serves a repeated digest from the handle-store cache without a model call", async function () {
    let calls = 0;
    const digests = scriptedDigests(async () => {
      calls += 1;
      return reply("Cells drift slowly.");
    });
    const first = createHarness(digests, [5]);
    await runCall(first, "call-1", { tasks: [SUMMARIZE] });
    assert.equal(calls, 1);

    // A later turn in the same conversation digests the same paper again.
    const second = createHarness(digests, [5]);
    second.request.conversationKey = first.request.conversationKey;
    const outcome = await runCall(second, "call-2", { tasks: [SUMMARIZE] });
    const answer = outcome.toolResult.content as Record<string, any>;
    assert.equal(calls, 1, "the cached digest is reused");
    assert.include(answer.digests, "Cells drift slowly.");
    assert.lengthOf(answer.digestHandles, 1);
    assert.deepEqual(answer.parts[0].done, 1);
  });

  it("gives each verified Evidence quote a Q_ id that the run collects and a chat answer cites; an evidence ref cites none", async function () {
    const harness = createHarness(
      scriptedDigests(async () => reply("Cells drift slowly.")),
      [5, 6],
    );
    const outcome = await runCall(harness, "call-quotes", {
      tasks: [SUMMARIZE],
    });
    const answer = outcome.toolResult.content as Record<string, any>;
    const citations = answer.quoteCitations as QuoteCitation[];
    assert.lengthOf(citations, 2, "one per paper's verified quote");
    const byItem = new Map(citations.map((c) => [c.itemId, c]));
    assert.deepInclude(byItem.get(5)!, {
      quoteText: "We recorded forty cells over ten days.",
      citationLabel: "(Ziv, 2021)",
      contextItemId: 105,
      itemId: 5,
      sourceMatchKind: "exact",
      sourceMatchSource: "context-text",
    });
    // A paper with no creator or year still has a canonical label.
    assert.equal(byItem.get(6)!.citationLabel, "(Drift B, n.d.)");
    const id5 = byItem.get(5)!.id;
    assert.match(id5, /^Q_/);
    assert.include(
      answer.digests,
      `"We recorded forty cells over ten days." (quoteCitationId: ${id5})`,
    );
    // The model reads each id beside its quote, never the citation records:
    // the host keeps those for the run's collector and the panel.
    const delivered = JSON.stringify(outcome.delivery?.content);
    assert.include(delivered, `(quoteCitationId: ${id5})`);
    assert.notInclude(delivered, "quoteCitations");
    assert.notInclude(delivered, '"quoteText"');

    // The runtime's collector reads the ids off the tool result event.
    const event = harness.events.find(
      (entry) => entry.type === "tool_result" && entry.name === "task_update",
    );
    assert.exists(event);
    if (event?.type !== "tool_result") return;
    const collector = new PassageCitationCollector();
    collector.collect(event.content, event.artifacts);
    assert.sameMembers(
      collector.quoteCitations.map((c) => c.id),
      citations.map((c) => c.id),
    );
    // An answer citing the id gets its citation; the final event carries
    // what this selects.
    assert.deepEqual(
      selectUsedQuoteCitations({
        text: `Place cells drift slowly [[cite:${id5}]].`,
        quoteCitations: collector.quoteCitations,
      }).map((c) => c.id),
      [id5],
    );
    // An evidence ref is a document's source, never a chat mark.
    assert.isEmpty(
      selectUsedQuoteCitations({
        text: "Place cells drift slowly [[cite:2b4cd8c1feb5:1]].",
        quoteCitations: collector.quoteCitations,
      }),
    );
  });

  it("context_read shows a stored digest's quotes with their ids and keeps its citation records from the model, which the run still collects", async function () {
    const harness = createHarness(
      scriptedDigests(async () => reply("Cells drift slowly.")),
      [5],
      (registry) => registry.register(createContextReadTool()),
    );
    const digestCall = await runCall(harness, "call-quotes", {
      tasks: [SUMMARIZE],
    });
    const answer = digestCall.toolResult.content as Record<string, any>;
    const [citation] = answer.quoteCitations as QuoteCitation[];
    const handle = answer.digestHandles[0].handle as string;
    assert.include(
      answer.digests,
      `context_read source:'tool_result' handle:'${handle}'`,
    );
    const execution = createToolExecution(harness.deps);
    for (const path of ["digest", "rendered"]) {
      const read = await execution.executeToolWorkflow(
        {
          id: `read-${path}`,
          name: "context_read",
          arguments: { source: "tool_result", handle, path },
        },
        2,
        { modelCallId: `read-${path}` },
      );
      assert.isTrue(read.toolResult.ok, path);
      // The model sees each Evidence quote with its id, and no record.
      const delivered = JSON.stringify(read.delivery?.content);
      assert.include(delivered, "We recorded forty cells over ten days.", path);
      assert.include(delivered, citation.id, path);
      assert.notInclude(delivered, "quoteCitations", path);
      // The full result still carries them, for the run and the panel.
      const event = harness.events.findLast(
        (entry) =>
          entry.type === "tool_result" && entry.callId === `read-${path}`,
      );
      assert.exists(event, path);
      if (event?.type !== "tool_result") return;
      const collector = new PassageCitationCollector();
      collector.collect(event.content, event.artifacts);
      assert.deepEqual(
        collector.quoteCitations.map((entry) => entry.id),
        [citation.id],
        path,
      );
    }
  });

  it("context_read of a task_update result the trace stored keeps its citation records from the model, which the run still collects", async function () {
    const harness = createHarness(
      scriptedDigests(async () => reply("Cells drift slowly.")),
      [5],
      (registry) => registry.register(createContextReadTool()),
    );
    const digestCall = await runCall(harness, "call-stored", {
      tasks: [SUMMARIZE],
    });
    const answer = digestCall.toolResult.content as Record<string, any>;
    const [citation] = answer.quoteCitations as QuoteCitation[];
    assert.exists(citation);
    // The trace keeps an oversized task_update result whole behind a handle.
    const stored = createAgentToolResultHandleRecord({
      conversationKey: harness.request.conversationKey,
      toolName: "task_update",
      toolCallId: "call-stored",
      content: answer,
      createdAt: 5,
    })!;
    await upsertAgentToolResultHandles([stored]);
    harness.request.metadata = {
      ...harness.request.metadata,
      agentToolResultReadAvailable: true,
    };
    const execution = createToolExecution(harness.deps);
    // A root read only lists the paths; a page of `digests` is what the model
    // reads quotes from.
    for (const path of ["digests"]) {
      const id = `read-stored-${path}`;
      const read = await execution.executeToolWorkflow(
        {
          id,
          name: "context_read",
          arguments: {
            source: "tool_result",
            handle: stored.handle,
            path,
          },
        },
        2,
        { modelCallId: id },
      );
      assert.isTrue(read.toolResult.ok, id);
      const delivered = JSON.stringify(read.delivery?.content);
      assert.include(delivered, citation.id, id);
      assert.notInclude(delivered, "quoteCitations", id);
      const event = harness.events.findLast(
        (entry) => entry.type === "tool_result" && entry.callId === id,
      );
      assert.exists(event, id);
      if (event?.type !== "tool_result") return;
      const collector = new PassageCitationCollector();
      collector.collect(event.content, event.artifacts);
      assert.deepEqual(
        collector.quoteCitations.map((entry) => entry.id),
        [citation.id],
        id,
      );
    }
  });

  it("mints ids for a digest cached before digest quotes had them, the same ids, and stores the record again", async function () {
    let calls = 0;
    const digests = scriptedDigests(async () => {
      calls += 1;
      return reply("Cells drift slowly.");
    });
    const first = createHarness(digests, [5]);
    const fresh = (await runCall(first, "call-fresh", { tasks: [SUMMARIZE] }))
      .toolResult.content as Record<string, any>;
    assert.equal(calls, 1);
    const stored = first.handles.find(
      (record) => record.toolName === PAPER_DIGEST_HANDLE_TOOL,
    )!;
    const content = stored.content as {
      cacheKey: string;
      digest: HostPaperDigest;
    };
    // The record as v3.9.15 stored it: schema 2, no ids anywhere.
    const { quoteCitations: _ids, ...digest } = content.digest;
    const old = {
      ...digest,
      evidence: digest.evidence.map(
        ({ quoteCitationId: _id, ...entry }) => entry,
      ),
    };
    assert.notInclude(JSON.stringify(old), "Q_");
    const second = createHarness(digests, [5]);
    await upsertAgentToolResultHandles([
      createAgentToolResultHandleRecord({
        conversationKey: second.request.conversationKey,
        toolName: PAPER_DIGEST_HANDLE_TOOL,
        toolCallId: content.cacheKey,
        resourceSignature: "scope-1",
        content: {
          cacheKey: content.cacheKey,
          digest: old,
          rendered: "stored without ids",
        },
        // Listed after the record stored again below (in 2096, after any
        // clock this test runs under), so the newer listing cannot be what
        // makes the minted one win.
        createdAt: 4_000_000_000_000,
      })!,
    ]);
    const reused = (
      await runCall(second, "call-reused", { tasks: [SUMMARIZE] })
    ).toolResult.content as Record<string, any>;
    assert.equal(calls, 1, "the old record is reused, not read again");
    assert.deepEqual(
      (reused.quoteCitations as QuoteCitation[]).map((c) => c.id),
      (fresh.quoteCitations as QuoteCitation[]).map((c) => c.id),
    );
    // The record is stored again with its ids, for context_read.
    const again = second.handles.find(
      (record) => record.toolName === PAPER_DIGEST_HANDLE_TOOL,
    );
    assert.exists(again);
    const againContent = again!.content as {
      digest: HostPaperDigest;
      rendered: string;
    };
    assert.deepEqual(
      againContent.digest.quoteCitations,
      content.digest.quoteCitations,
    );
    assert.include(againContent.rendered, "quoteCitationId: Q_");
    assert.include(
      reused.digests,
      again!.handle,
      "the result names the record that has the ids",
    );

    // A later turn is served the minted record and stores nothing again.
    const third = createHarness(digests, [5]);
    third.request.conversationKey = second.request.conversationKey;
    const later = (await runCall(third, "call-later", { tasks: [SUMMARIZE] }))
      .toolResult.content as Record<string, any>;
    assert.equal(calls, 1);
    assert.isEmpty(
      third.handles.filter(
        (record) => record.toolName === PAPER_DIGEST_HANDLE_TOOL,
      ),
    );
    assert.include(later.digests, again!.handle);
  });

  it("labels a digest's quotes with the paper's canonical source label", function () {
    const paper = (extra: Partial<PaperContextRef>): PaperContextRef => ({
      itemId: 6,
      contextItemId: 106,
      title: "Drift B",
      ...extra,
    });
    assert.equal(
      digestSourceLabel(paper({ firstCreator: "Ziv", year: "2021" })),
      "(Ziv, 2021)",
    );
    assert.equal(digestSourceLabel(paper({})), "(Drift B, n.d.)");
    // An undated creator the citation contract cannot read as a source.
    assert.equal(
      digestSourceLabel(paper({ firstCreator: "van der Berg" })),
      "(van der Berg, n.d.)",
    );
  });

  it("never caches a failure", async function () {
    const harness = createHarness(
      scriptedDigests(async () => reply("unused")),
      [7],
    );
    await runCall(harness, "call-fail", { tasks: [SUMMARIZE] });
    assert.isEmpty(
      harness.handles.filter(
        (record) => record.toolName === PAPER_DIGEST_HANDLE_TOOL,
      ),
    );
  });

  it("on Stop keeps the finished digests, names the papers left, and a repeat continues only those", async function () {
    const controller = new AbortController();
    const asked: string[] = [];
    let resuming = false;
    const harness = createHarness(
      scriptedDigests(async (chat) => {
        const prompt = chat.prompt;
        const title = /Title: (Drift [A-D])/.exec(prompt)?.[1] || "?";
        asked.push(title);
        if (resuming) return reply(`${title} drifts.`);
        if (title === "Drift A") {
          controller.abort();
          return reply("Cells drift slowly.");
        }
        if (!controller.signal.aborted)
          await new Promise((resolve) =>
            controller.signal.addEventListener("abort", resolve),
          );
        throw new Error("The operation was aborted");
      }),
      [5, 6, 8],
    );
    PAPERS[8] = {
      libraryID: 1,
      itemId: 8,
      contextItemId: 108,
      title: "Drift D",
    };
    harness.context.signal = controller.signal;

    const stopped = await runCall(harness, "call-stop", { tasks: [SUMMARIZE] });
    const answer = stopped.toolResult.content as Record<string, any>;
    assert.include(answer.digests, "Cells drift slowly.");
    assert.sameMembers(answer.digestPending, ["item:6", "item:8"]);
    assert.isUndefined(answer.digestFailures);
    assert.deepEqual(answer.parts[0], {
      taskId: "summaries",
      status: "pending",
      done: 1,
      total: 3,
      scope: true,
    });
    assert.deepEqual(
      ledgerDeltas(harness).map((delta) => delta.papers[0].itemId),
      [5],
      "a paper Stop left unfinished gets no row update",
    );

    // Continue: the same part again, without a description.
    harness.context.signal = undefined;
    asked.length = 0;
    resuming = true;
    const resumed = await runCall(harness, "call-resume", {
      tasks: [{ taskId: "summaries" }],
    });
    const again = resumed.toolResult.content as Record<string, any>;
    assert.sameMembers(asked, ["Drift B", "Drift D"]);
    assert.isUndefined(again.note);
    assert.include(again.parts[0], { status: "completed", done: 3, total: 3 });
    assert.isUndefined(again.digestPending);
    delete PAPERS[8];
  });

  it("keeps a large digest result behind a trace handle like any big result", async function () {
    const itemIds = Array.from({ length: 30 }, (_, index) => 200 + index);
    for (const itemId of itemIds)
      PAPERS[itemId] = {
        libraryID: 1,
        itemId,
        contextItemId: itemId + 1000,
        title: `Long paper ${itemId} ${"on representational drift ".repeat(20)}`,
      };
    try {
      const harness = createHarness(
        scriptedDigests(async () => reply("Long summary. ".repeat(120))),
        itemIds,
      );
      await runCall(harness, "call-big", { tasks: [SUMMARIZE] });
      const result = harness.events.find(
        (event) => event.type === "tool_result",
      ) as Extract<AgentEvent, { type: "tool_result" }>;
      assert.match(String(result.toolResultHandle), /^trh_/);
    } finally {
      for (const itemId of itemIds) delete PAPERS[itemId];
    }
  });

  /** Papers `from`, `from + 1`, … each resolvable, removed after `run`. */
  async function withPapers(
    count: number,
    from: number,
    run: (itemIds: number[]) => Promise<void>,
  ) {
    const itemIds = Array.from({ length: count }, (_, index) => from + index);
    for (const itemId of itemIds)
      PAPERS[itemId] = {
        libraryID: 1,
        itemId,
        contextItemId: itemId + 1000,
        title: `Paper ${itemId}`,
      };
    try {
      await run(itemIds);
    } finally {
      for (const itemId of itemIds) delete PAPERS[itemId];
    }
  }

  it("digests at most 30 papers in one call; the rest are pending until the part is declared again", async function () {
    await withPapers(31, 300, async (itemIds) => {
      const asked: string[] = [];
      const harness = createHarness(
        scriptedDigests(async (chat) => {
          asked.push(/Title: (Paper \d+)/.exec(chat.prompt)?.[1] || "?");
          return reply("Cells drift slowly.");
        }),
        itemIds,
      );
      const first = await runCall(harness, "call-batch-1", {
        tasks: [SUMMARIZE],
      });
      const answer = first.toolResult.content as Record<string, any>;
      assert.lengthOf(asked, 30);
      assert.notInclude(asked, "Paper 330");
      assert.deepEqual(answer.digestPending, ["item:330"]);
      assert.deepEqual(answer.parts[0], {
        taskId: "summaries",
        status: "pending",
        done: 30,
        total: 31,
        scope: true,
      });
      assert.include(answer.digestNote, "30 papers");
      assert.include(answer.digestNote, "same taskId and no description");

      asked.length = 0;
      const second = await runCall(harness, "call-batch-2", {
        tasks: [{ taskId: "summaries" }],
      });
      const next = second.toolResult.content as Record<string, any>;
      assert.deepEqual(asked, ["Paper 330"]);
      assert.include(next.parts[0], { status: "completed", done: 31 });
      assert.isUndefined(next.digestPending);
      assert.isUndefined(next.digestNote);
    });
  });

  it("refuses a digest part over more than 200 papers and asks to narrow the scope", async function () {
    const itemIds = Array.from({ length: 201 }, (_, index) => 1_000 + index);
    let calls = 0;
    const harness = createHarness(
      scriptedDigests(async () => {
        calls += 1;
        return reply("x");
      }),
      itemIds,
    );
    const outcome = await runCall(harness, "call-huge", {
      tasks: [SUMMARIZE],
    });
    assert.isFalse(outcome.toolResult.ok);
    const text = JSON.stringify(outcome.toolResult.content);
    assert.include(text, "201 papers");
    assert.match(text, /narrow the scope/i);
    assert.include(text, "confirm");
    assert.equal(calls, 0);
    assert.lengthOf(harness.published, 0, "nothing is declared");
  });

  it("with nothing attached, refuses scope:true before any paper is read, and digests the papers targetIds name", async function () {
    let calls = 0;
    const harness = createHarness(
      scriptedDigests(async () => {
        calls += 1;
        return reply("Cells drift slowly.");
      }),
    );
    harness.request.turnScopePapers = {
      ...harness.request.turnScopePapers!,
      wholeLibrary: true,
    };
    const refused = await runCall(harness, "call-scope", {
      tasks: [
        {
          taskId: "tags",
          description: "Tag every paper",
          expectedEffect: "mutation",
          expectedCapability: "zotero.tags",
          scope: true,
        },
        SUMMARIZE,
      ],
    });
    assert.isFalse(refused.toolResult.ok);
    const text = JSON.stringify(refused.toolResult.content);
    assert.include(text, "whole library (3 papers)");
    assert.include(text, "library_retrieve");
    assert.equal(calls, 0);
    assert.lengthOf(harness.published, 0, "the write part is not declared");
    assert.isEmpty(ledgerDeltas(harness));

    const outcome = await runCall(harness, "call-chosen", {
      tasks: [{ ...SUMMARIZE, scope: undefined, targetIds: ["5", "6"] }],
    });
    assert.isTrue(outcome.toolResult.ok);
    const answer = outcome.toolResult.content as Record<string, any>;
    assert.deepEqual(answer.parts, [
      { taskId: "summaries", status: "completed", done: 2, total: 2 },
    ]);
    assert.equal(calls, 2);
    assert.sameMembers(
      ledgerDeltas(harness).map((delta) => delta.papers[0].itemId),
      [5, 6],
    );
  });

  it("renders more than twelve digests compactly, each naming its handle for the full digest", async function () {
    await withPapers(13, 400, async (itemIds) => {
      const long = `${"Drift is slow and steady across days. ".repeat(20)}END-OF-SUMMARY`;
      const harness = createHarness(
        scriptedDigests(async () => reply(long)),
        itemIds,
      );
      const outcome = await runCall(harness, "call-13", {
        tasks: [SUMMARIZE],
      });
      const answer = outcome.toolResult.content as Record<string, any>;
      assert.lengthOf(answer.digestHandles, 13);
      for (const itemId of itemIds) {
        assert.include(answer.digests, `### Paper ${itemId} (item:${itemId})`);
        const handle = answer.digestHandles.find(
          (entry: { itemId: number }) => entry.itemId === itemId,
        ).handle;
        assert.include(answer.digests, handle);
      }
      assert.include(answer.digests, long.slice(0, 400));
      assert.notInclude(answer.digests, "END-OF-SUMMARY");
      assert.notInclude(answer.digests, "Contributions:");
      assert.notInclude(answer.digests, "Facets:");
      // The stored digest is whole.
      const stored = harness.handles.find(
        (record) => record.toolName === PAPER_DIGEST_HANDLE_TOOL,
      );
      assert.include(JSON.stringify(stored?.content), "END-OF-SUMMARY");
    });
  });

  it("runs a failed paper again on at most two re-declarations, then keeps its failure final and says so", async function () {
    let reads7 = 0;
    const digests = scriptedDigests(async () => reply("Cells drift slowly."));
    const readText = digests.readText;
    const harness = createHarness(
      {
        ...digests,
        readText: async (paper, maxChars) => {
          if (paper.itemId === 7) reads7 += 1;
          return readText(paper, maxChars);
        },
      },
      [5, 7],
    );
    await runCall(harness, "call-0", { tasks: [SUMMARIZE] });
    assert.equal(reads7, 1);
    for (const [index, id] of ["call-1", "call-2"].entries()) {
      const again = await runCall(harness, id, {
        tasks: [{ taskId: "summaries" }],
      });
      const answer = again.toolResult.content as Record<string, any>;
      assert.equal(reads7, index + 2, `re-declaration ${index + 1} runs it`);
      // A paper with no text is named as not read, never retried or read.
      assert.include(answer.digestNote, "No readable text: Drift C (item:7).");
      assert.include(answer.digestNote, "do not declare it again");
    }
    const last = await runCall(harness, "call-3", {
      tasks: [{ taskId: "summaries", targetIds: ["7"] }],
    });
    const answer = last.toolResult.content as Record<string, any>;
    assert.equal(reads7, 3, "a third re-declaration does not run it again");
    assert.deepEqual(answer.digestFailures, [
      { itemId: 7, title: "Drift C", reason: "No readable text", final: true },
    ]);
    assert.include(answer.digestNote, "Drift C");
    // No text: no overview read is offered, and the note is task-neutral.
    assert.include(answer.digestNote, "Name it as not read");
    assert.notInclude(answer.digestNote, "paper_read mode:'overview'");
    assert.notInclude(answer.digestNote, "summar");
    const part = harness.request.executionCheckpoint!.tasks[0];
    assert.deepEqual(part.exceptions, [
      { targets: ["item:7"], reason: "No readable text" },
    ]);
  });

  it("keeps the overview-read note for a paper that failed for another reason", async function () {
    const harness = createHarness(
      scriptedDigests(async (chat) =>
        chat.prompt.includes("Title: Drift A") ? reply("") : reply("Fine."),
      ),
      [5, 6],
    );
    await runCall(harness, "call-a", { tasks: [SUMMARIZE] });
    for (const id of ["call-b", "call-c"])
      await runCall(harness, id, { tasks: [{ taskId: "summaries" }] });
    const last = await runCall(harness, "call-d", {
      tasks: [{ taskId: "summaries", targetIds: ["5"] }],
    });
    const note = (last.toolResult.content as Record<string, any>)
      .digestNote as string;
    assert.include(note, "Not run again: Drift A (item:5).");
    assert.include(note, "paper_read mode:'overview'");
    assert.notInclude(note, "No readable text");
  });

  it("issues a body-depth read for a long or complete digest and an abstract-depth one for a short excerpt", async function () {
    const zotero = (globalThis as unknown as { Zotero: any }).Zotero;
    const originalItems = zotero.Items;
    zotero.Items = {
      ...(originalItems || {}),
      get: (id: number) => ({ id, key: `KEY${id}`, libraryID: 1 }),
    };
    try {
      const digest = (source: HostPaperDigest["source"]): HostPaperDigest => ({
        schema: 2,
        itemId: 5,
        contextItemId: 105,
        answer: "s",
        evidence: [],
        facets: [],
        gaps: [],
        source,
        model: "m",
        producedAt: 0,
        cacheKey: "k",
      });
      const capabilities = async (source: HostPaperDigest["source"]) =>
        (
          await createDigestReadObservation({
            callId: "c",
            digest: digest(source),
          })
        )?.capabilities;
      assert.deepEqual(
        await capabilities({
          backend: "mineru",
          readCharacters: 3_000,
          totalCharacters: 3_000,
          complete: true,
        }),
        ["body"],
      );
      assert.deepEqual(
        await capabilities({
          backend: "pdf",
          readCharacters: 5_000,
          totalCharacters: 90_000,
          totalEstimated: true,
          complete: false,
        }),
        ["body"],
      );
      // The depth is what the worker read, never the paper's length.
      assert.deepEqual(
        await capabilities({
          backend: "pdf",
          readCharacters: 4_999,
          totalCharacters: 90_000,
          totalEstimated: true,
          complete: false,
        }),
        ["abstract"],
      );
    } finally {
      zotero.Items = originalItems;
    }
  });

  it("hashes the answer, relevance and stance into the read observation", async function () {
    const zotero = (globalThis as unknown as { Zotero: any }).Zotero;
    const originalItems = zotero.Items;
    zotero.Items = {
      ...(originalItems || {}),
      get: (id: number) => ({ id, key: `KEY${id}`, libraryID: 1 }),
    };
    try {
      const base: HostPaperDigest = {
        schema: 2,
        itemId: 5,
        contextItemId: 105,
        answer: "Relevant.",
        evidence: [],
        facets: [],
        gaps: [],
        source: {
          backend: "mineru",
          readCharacters: 3_000,
          totalCharacters: 3_000,
          complete: true,
        },
        model: "m",
        producedAt: 0,
        cacheKey: "k",
      };
      const resultOf = async (digest: HostPaperDigest) =>
        (await createDigestReadObservation({ callId: "c", digest }))
          ?.resultDigest;
      const plain = await resultOf(base);
      assert.notEqual(await resultOf({ ...base, answer: "Other." }), plain);
      assert.notEqual(
        await resultOf({
          ...base,
          relevance: { level: "direct", reason: "On topic." },
        }),
        plain,
      );
      assert.notEqual(
        await resultOf({
          ...base,
          stance: { position: "supports", reason: "Agrees." },
        }),
        plain,
      );
    } finally {
      zotero.Items = originalItems;
    }
  });

  it("gives the worker the part's saved question, which a resumed part keeps after continue", async function () {
    const prompts: string[] = [];
    let stop = true;
    const controller = new AbortController();
    const harness = createHarness(
      scriptedDigests(async (chat) => {
        prompts.push(chat.prompt);
        if (stop) controller.abort();
        return reply("Cells drift slowly.");
      }),
      [5, 6],
    );
    harness.context.signal = controller.signal;
    await runCall(harness, "call-first", {
      tasks: [{ ...SUMMARIZE, scope: undefined, targetIds: ["5", "6"] }],
    });
    // The run's saved progress restores the part with the question it was
    // declared under; the new run's own text is only "continue".
    const saved = harness.request.executionCheckpoint!;
    harness.request.executionCheckpoint = {
      ...saved,
      tasks: saved.tasks.map((task) => ({
        ...task,
        question: "Which papers show representational drift?",
      })),
    };
    harness.request.userText = "continue";
    harness.context.signal = undefined;
    stop = false;
    prompts.length = 0;
    const resumed = await runCall(harness, "call-resume", {
      tasks: [{ taskId: "summaries" }],
    });
    assert.isTrue(resumed.toolResult.ok);
    assert.lengthOf(prompts, 1, "only the paper Stop left");
    assert.include(
      prompts[0],
      "The user's request (context): Which papers show representational drift?",
    );
    assert.notInclude(prompts[0], "The user's request (context): continue");
  });

  it("gives the worker the user's request when the part is declared", async function () {
    const prompts: string[] = [];
    const harness = createHarness(
      scriptedDigests(async (chat) => {
        prompts.push(chat.prompt);
        return reply("Cells drift slowly.");
      }),
      [5],
    );
    await runCall(harness, "call-question", { tasks: [SUMMARIZE] });
    assert.include(
      prompts[0],
      "The user's request (context): Summarize all papers for me and write a literature review",
    );
    assert.include(
      prompts[0],
      "Task for this paper: Summarize each selected paper",
    );
  });

  it("runs two parts over one paper as two results, each with its part on the paper's row and its own handle", async function () {
    const zotero = (globalThis as unknown as { Zotero: any }).Zotero;
    const originalItems = zotero.Items;
    zotero.Items = {
      ...(originalItems || {}),
      get: (id: number) => ({ id, key: `KEY${id}`, libraryID: 1 }),
    };
    try {
      const harness = createHarness(
        scriptedDigests(async (chat) =>
          chat.prompt.includes("Task for this paper: Judge")
            ? reply("Directly about drift.", {
                facets: [],
                relevance: { level: "direct", reason: "It measures drift." },
              })
            : reply("Cells drift slowly."),
        ),
        [5],
      );
      const outcome = await runCall(harness, "call-two", {
        tasks: [
          { ...SUMMARIZE, scope: undefined, targetIds: ["5"] },
          {
            taskId: "relevance",
            description:
              "Judge whether each paper bears on representational drift. Give one reason.",
            expectedEffect: "digest",
            targetIds: ["5"],
          },
        ],
      });
      const answer = outcome.toolResult.content as Record<string, any>;
      const digestReads = ledgerDeltas(harness).map((delta) => delta.reads[0]);
      const executionId = harness.request.executionCheckpoint!.executionId;
      assert.sameDeepMembers(
        digestReads.map((read) => [
          read.partId,
          read.label,
          read.relevance?.level,
        ]),
        [
          [
            `${executionId}:task:summaries`,
            "Summarize each selected paper",
            undefined,
          ],
          [
            `${executionId}:task:relevance`,
            "Judge whether each paper bears on representational drift",
            "direct",
          ],
        ],
      );
      assert.sameMembers(
        ledgerDeltas(harness).map((delta) => delta.callId),
        ["call-two:summaries:digest:5", "call-two:relevance:digest:5"],
      );
      // Two stored results, each block naming its own.
      const handles = (answer.digestHandles as Array<{ handle: string }>).map(
        (entry) => entry.handle,
      );
      assert.lengthOf(new Set(handles), 2);
      // Each handle names the part it answers, as the model names the part.
      assert.sameDeepMembers(
        (answer.digestHandles as Array<{ itemId: number; taskId: string }>).map(
          (entry) => [entry.itemId, entry.taskId],
        ),
        [
          [5, "summaries"],
          [5, "relevance"],
        ],
      );
      const blocks = (answer.digests as string)
        .split("\n\n")
        .filter((block) => block.startsWith("### "));
      assert.lengthOf(blocks, 2);
      const summaryBlock = blocks.find((block) =>
        block.includes("Cells drift slowly."),
      )!;
      const verdictBlock = blocks.find((block) =>
        block.includes("Directly about drift."),
      )!;
      const [summaryHandle, verdictHandle] = [summaryBlock, verdictBlock].map(
        (block) => /handle:'(trh_[^']+)'/.exec(block)?.[1],
      );
      assert.notEqual(summaryHandle, verdictHandle);
      assert.sameMembers([summaryHandle, verdictHandle], handles);
      assert.include(verdictBlock, "Relevance: direct — It measures drift.");
      // The result groups by part: a heading, then that part's own relevance
      // count line and blocks, so the model knows which block answers which.
      const rendered = answer.digests as string;
      const summaryHeading = "## Part summaries: Summarize each selected paper";
      const verdictHeading =
        "## Part relevance: Judge whether each paper bears on representational drift";
      assert.isTrue(rendered.startsWith(`${summaryHeading}\n\n### Drift A`));
      assert.include(
        rendered,
        `${verdictHeading}\n\nRelevance: 1 direct\n\n### Drift A`,
      );
      assert.lengthOf(
        rendered.match(/^Relevance: \d/gm) || [],
        1,
        "the count line sits under the part that judged",
      );
      const [summarySection, verdictSection] = rendered.split(verdictHeading);
      assert.include(summarySection, "Cells drift slowly.");
      assert.notInclude(summarySection, "Directly about drift.");
      assert.include(verdictSection, "Directly about drift.");
      assert.notInclude(verdictSection, "Cells drift slowly.");
    } finally {
      zotero.Items = originalItems;
    }
  });

  it("names the papers judged unrelated and how to leave them out, and says nothing when none is", async function () {
    const harness = createHarness(
      scriptedDigests(async (chat) =>
        chat.prompt.includes("Title: Drift A")
          ? reply("It measures household income, not drift.", {
              facets: [],
              relevance: { level: "none", reason: "An economics paper." },
            })
          : reply("Cells drift slowly.", {
              facets: [],
              relevance: { level: "direct", reason: "It measures drift." },
            }),
      ),
      [5, 6],
    );
    const outcome = await runCall(harness, "call-unrelated", {
      tasks: [SUMMARIZE],
    });
    const note = (outcome.toolResult.content as Record<string, any>)
      .digestNote as string;
    assert.include(note, "Judged unrelated to the request: Drift A (item:5).");
    assert.notInclude(note, "item:6");
    // A relevance of none is a signal: the model decides, and says so by title.
    assert.include(
      note,
      "If its content does not bear on the request, leave it out with excluded:[{ targetIds:['item:N'], reason:'<one sentence>' }] in submit_document, or in task_update with the answer part's taskId,",
    );
    assert.include(
      note,
      "name it by title with that reason in the output, without a citation.",
    );
    assert.notInclude(note, "Leave each such paper out");
    assert.include(note, "never stretch one in by analogy");
    assert.include(note, "When the user asked for every paper");

    const related = createHarness(
      scriptedDigests(async () =>
        reply("Cells drift slowly.", {
          facets: [],
          relevance: { level: "partial", reason: "It touches drift." },
        }),
      ),
      [5],
    );
    const quiet = await runCall(related, "call-related", {
      tasks: [SUMMARIZE],
    });
    assert.isUndefined(
      (quiet.toolResult.content as Record<string, any>).digestNote,
    );
  });

  it("treats a schema 1 record in the handle store as a miss and leaves it untouched", async function () {
    const conversation = 975_800;
    const oldDigest = {
      itemId: 5,
      contextItemId: 105,
      summary: "An old summary.",
      contributions: [],
      methods: "",
      limitations: "",
      evidence: [],
      source: { backend: "mineru", characters: 4_000, complete: true },
      model: "test-model",
      producedAt: 1,
      cacheKey: "digest:v2:shared-key",
    };
    const schema2 = {
      schema: 2,
      itemId: 6,
      contextItemId: 106,
      answer: "A new answer.",
      evidence: [],
      facets: [],
      gaps: [],
      source: {
        backend: "mineru",
        readCharacters: 4_000,
        totalCharacters: 4_000,
        complete: true,
      },
      model: "test-model",
      producedAt: 1,
      cacheKey: "digest:v2:new-key",
    };
    const records = [oldDigest, schema2].map(
      (digest) =>
        createAgentToolResultHandleRecord({
          conversationKey: conversation,
          toolName: PAPER_DIGEST_HANDLE_TOOL,
          toolCallId: digest.cacheKey,
          content: {
            cacheKey: digest.cacheKey,
            digest,
            rendered: `stored ${digest.cacheKey}`,
          },
          createdAt: 1,
        })!,
    );
    await upsertAgentToolResultHandles(records);
    const cache = createHandleStorePaperDigestCache({
      conversationKey: conversation,
    });
    assert.isNull(
      await cache.get("digest:v2:shared-key"),
      "a record without schema 2 is never served, even under a matching key",
    );
    assert.equal(
      (await cache.get("digest:v2:new-key"))?.answer,
      "A new answer.",
    );
    // The schema 1 record stays readable by its handle, as it was stored.
    const kept = await getAgentToolResultHandle({
      conversationKey: conversation,
      handle: records[0].handle,
    });
    assert.deepEqual(kept?.content, records[0].content);
  });

  it("serves a digest the other scope re-minted with a handle that holds the served digest", async function () {
    const conversation = 975_900;
    const cacheKey = "digest:v2:relabel";
    const minted = (id: string): HostPaperDigest =>
      ({
        schema: 2,
        itemId: 5,
        contextItemId: 105,
        title: "Drift A",
        answer: "Cells drift slowly.",
        evidence: [
          {
            quote: "We recorded forty cells over ten days.",
            quoteCitationId: id,
          },
        ],
        facets: [],
        gaps: [],
        source: {
          backend: "mineru",
          readCharacters: 4_000,
          totalCharacters: 4_000,
          complete: true,
        },
        model: "test-model",
        producedAt: 1,
        cacheKey,
        quoteCitations: [{ id }],
      }) as unknown as HostPaperDigest;
    const cacheIn = (resourceSignature: string, at: number) =>
      createHandleStorePaperDigestCache({
        conversationKey: conversation,
        resourceSignature,
        now: () => at,
      });
    // Scope S1 stores the digest under the old label's id.
    await cacheIn("S1", 1).set(minted("Q_old"));
    // The user fixes the year and switches to S2, which re-mints it.
    await cacheIn("S2", 2).set(minted("Q_new"));
    // Back in S1, the store serves the newer record.
    const back = cacheIn("S1", 3);
    const served = await back.get(cacheKey);
    assert.equal(served?.evidence[0].quoteCitationId, "Q_new");
    const handle = await back.handleOf(served!);
    const record = await getAgentToolResultHandle({
      conversationKey: conversation,
      handle: handle!,
    });
    const content = record?.content as {
      digest: HostPaperDigest;
      rendered: string;
    };
    assert.equal(
      content.digest.evidence[0].quoteCitationId,
      "Q_new",
      "the handle holds the digest the model was told about",
    );
    assert.include(content.rendered, "Q_new");
    assert.notInclude(content.rendered, "Q_old");
  });

  it("leaves a part of any other effect exactly as before", async function () {
    let calls = 0;
    const harness = createHarness(
      scriptedDigests(async () => {
        calls += 1;
        return reply("x");
      }),
    );
    const outcome = await runCall(harness, "call-read", {
      tasks: [
        {
          taskId: "read-all",
          description: "Read each paper",
          expectedEffect: "read",
          scope: true,
        },
      ],
    });
    const answer = outcome.toolResult.content as Record<string, any>;
    assert.equal(calls, 0);
    assert.deepEqual(Object.keys(answer), ["parts"]);
    assert.isEmpty(ledgerDeltas(harness));
  });
});

describe("Zotero paper sources for a digest", function () {
  it("adds the MinerU directory the gateway's paper ref lacks, from the paper's attachments", async function () {
    const request = resolveAgentRuntimeRequest(
      { conversationKey: 975_900, mode: "agent", libraryID: 1, userText: "x" },
      {},
    ) as AgentRuntimeRequest;
    const sources = createZoteroPaperDigestSources({
      zoteroGateway: {
        resolvePaperContextTarget: ({ itemId }: { itemId?: number }) =>
          itemId === 5 ? { ...PAPERS[5] } : null,
        getAllChildAttachmentInfos: async () => [
          { contextItemId: 999, mineruCacheDir: "/cache/other" },
          { contextItemId: 105, mineruCacheDir: "/cache/105" },
        ],
      } as never,
      pdfService: { getOverviewExcerpt: async () => ({}) } as never,
    });
    const paper = await sources.resolvePaper(request, 5);
    assert.equal(paper?.mineruCacheDir, "/cache/105");
    assert.equal(paper?.contextItemId, 105);
    assert.isNull(await sources.resolvePaper(request, 404));
  });
});

describe("a digested paper as document evidence", function () {
  let restore: () => void;

  beforeEach(async function () {
    const restoreDb = installMockDb();
    const restoreDocuments = installAgentStoreSqlite();
    clearAgentToolResultHandleStore();
    const zotero = (globalThis as unknown as { Zotero: any }).Zotero;
    const items = new Map<number, Record<string, unknown>>([
      [5, { id: 5, key: "PAPER005", libraryID: 1 }],
      [
        105,
        {
          id: 105,
          key: "PDF00105",
          libraryID: 1,
          parentID: 5,
          isAttachment: () => true,
        },
      ],
    ]);
    const originalItems = zotero.Items;
    const originalLibraries = zotero.Libraries;
    zotero.Libraries = { userLibraryID: 1, get: () => undefined };
    zotero.Items = {
      ...(originalItems || {}),
      get: (id: number) => items.get(id) || null,
      getByLibraryAndKey: (libraryID: number, key: string) =>
        libraryID === 1 && key === "PAPER005"
          ? {
              id: 5,
              key: "PAPER005",
              libraryID: 1,
              isNote: () => false,
              getField: (field: string) => (field === "title" ? "Drift A" : ""),
            }
          : false,
    };
    await initPlanDocumentStore();
    restore = () => {
      zotero.Items = originalItems;
      zotero.Libraries = originalLibraries;
      clearAgentToolResultHandleStore();
      restoreDocuments();
      restoreDb();
    };
  });

  afterEach(function () {
    restore();
  });

  it("lets a literature review cite a paper the host digested and the model never read", async function () {
    const harness = createHarness(
      scriptedDigests(async () => reply("Cells drift slowly.")),
      [5],
      (registry) =>
        registry.register(
          createSubmitDocumentTool({
            formatStructuredCitations: (params: {
              clusters: Array<{ citationId: string }>;
            }) => ({
              styleId: "apa",
              styleTitle: "APA",
              locale: "en-US",
              clusters: params.clusters.map((cluster) => ({
                citationId: cluster.citationId,
                text: "(Ziv, 2021)",
                html: "(Ziv, 2021)",
              })),
              bibliographyEntries: [
                { itemId: 5, text: "Ziv. (2021). Drift A.", html: "Ziv." },
              ],
            }),
          } as unknown as ZoteroGateway),
        ),
    );
    const digested = await runCall(harness, "call-digest", {
      tasks: [SUMMARIZE],
    });
    const answer = digested.toolResult.content as Record<string, any>;
    const [entry] = answer.digestHandles as Array<{
      itemId: number;
      evidenceRefs: string[];
    }>;
    assert.equal(entry.itemId, 5);
    assert.lengthOf(entry.evidenceRefs, 1);
    const ref = entry.evidenceRefs[0];
    assert.match(ref, /^[0-9a-f]{12}:\d+$/);
    // The model reads the ref and the paper's key beside the summary.
    assert.include(answer.digests, ref);
    assert.include(answer.digests, "PAPER005");
    assert.deepEqual(
      (answer.documentEvidenceRefs as Array<Record<string, unknown>>).map(
        (row) => [row.evidenceRef, row.libraryID, row.itemKey],
      ),
      [[ref, 1, "PAPER005"]],
    );

    const execution = createToolExecution(harness.deps);
    const submitted = await execution.executeToolWorkflow(
      {
        id: "call-submit",
        name: "submit_document",
        arguments: {
          documentKind: "literature_review",
          integrityPolicy: "research_grounded",
          title: "Representational drift",
          markdown:
            "# Representational drift\n\nCells drift slowly. [[cite:C1]]\n\n## Scope and limitations\n\nOne paper.",
          citations: [
            {
              citationId: "C1",
              sources: [
                { libraryID: 1, itemKey: "PAPER005", evidenceRefs: [ref] },
              ],
            },
          ],
          quotes: [],
          assets: [],
          groundingReviewed: "passed",
          groundingIssues: [],
        },
      },
      2,
      { modelCallId: "call-submit" },
    );
    const errors = harness.events.filter(
      (event) => event.type === "tool_error",
    );
    assert.isEmpty(errors, JSON.stringify(errors));
    assert.isTrue(
      submitted.toolResult.ok,
      JSON.stringify(submitted.toolResult.content),
    );
  });
});

describe("a digest part reads what its read scope names", function () {
  let restoreDb: () => void;

  beforeEach(function () {
    restoreDb = installMockDb();
    clearAgentToolResultHandleStore();
  });

  afterEach(function () {
    clearAgentToolResultHandleStore();
    restoreDb();
  });

  const ABSTRACTS: Record<number, string> = {
    5: "Place cells drift slowly, yet decoding of position stays above chance across days.",
    6: "We show that drift follows a random walk in the population vector space.",
  };

  /** Scripted papers: each read for the scope the part gives it. */
  function scopedDigests(
    reads: Array<{ itemId: number; scope?: string }>,
    llmCall: (chat: ChatParams) => Promise<ReturnType<typeof reply>>,
  ): NonNullable<TaskUpdateToolDeps["digests"]> {
    return {
      resolvePaper: async (_request, itemId) => PAPERS[itemId] || null,
      readText: async (paper, _maxChars, scope) => {
        reads.push({ itemId: paper.itemId, scope: scope?.source });
        if (scope?.source === "abstract") {
          const abstract = ABSTRACTS[paper.itemId];
          return abstract
            ? {
                backend: "text",
                text: abstract,
                totalCharacters: abstract.length,
                covered: ["Abstract"],
                bounds: "exact",
                textSource: "Zotero abstract field",
              }
            : {
                backend: "text",
                text: "",
                totalCharacters: 0,
                covered: [],
                unmatched: ["abstract"],
              };
        }
        return { backend: "mineru", text: TEXT, totalCharacters: TEXT.length };
      },
      llmCall: llmCall as never,
    };
  }

  it("completes an abstract part on the abstracts, with ids and no model call", async function () {
    const reads: Array<{ itemId: number; scope?: string }> = [];
    let calls = 0;
    const harness = createHarness(
      scopedDigests(reads, async () => {
        calls += 1;
        return reply("unused");
      }),
      [5, 6],
    );
    const outcome = await runCall(harness, "call-abstracts", {
      tasks: [
        {
          taskId: "abstracts",
          description: "Using only the abstracts, give an overview",
          expectedEffect: "digest",
          scope: true,
          read: { source: "abstract" },
        },
      ],
    });
    assert.isTrue(outcome.toolResult.ok, JSON.stringify(outcome.toolResult));
    assert.equal(calls, 0, "no model reads an abstract");
    assert.deepEqual(reads, [
      { itemId: 5, scope: "abstract" },
      { itemId: 6, scope: "abstract" },
    ]);
    const answer = outcome.toolResult.content as Record<string, any>;
    assert.deepEqual(answer.parts, [
      {
        taskId: "abstracts",
        status: "completed",
        done: 2,
        total: 2,
        scope: true,
      },
    ]);
    const task = harness.request.executionCheckpoint!.tasks[0];
    assert.deepEqual(task.readScope, { source: "abstract" });
    assert.lengthOf(answer.quoteCitations, 2);
    for (const citation of answer.quoteCitations as QuoteCitation[]) {
      assert.match(citation.id, /^Q_/);
      assert.include(answer.digests, `(quoteCitationId: ${citation.id})`);
    }
    assert.include(answer.digests, ABSTRACTS[5]);
    assert.include(
      answer.digests,
      "text: the abstract only; read Abstract (Zotero abstract field)",
    );
    // The model view keeps the ids, not the citation records.
    const modelView = createTaskUpdateTool().modelContent!(
      answer as never,
    ) as Record<string, unknown>;
    assert.notProperty(modelView, "quoteCitations");
    // The paper rows record abstracts, never a full read.
    const rows = ledgerDeltas(harness);
    assert.isNotEmpty(rows);
    for (const delta of rows) {
      assert.equal(delta.papers[0].state, "skimmed");
      assert.notInclude(
        delta.reads.map((read) => read.granularity),
        "full",
      );
    }
  });

  it("names a paper with no abstract and reads nothing else for it", async function () {
    const reads: Array<{ itemId: number; scope?: string }> = [];
    const harness = createHarness(
      scopedDigests(reads, async () => reply("unused")),
      [5, 7],
    );
    const outcome = await runCall(harness, "call-abstracts", {
      tasks: [
        {
          taskId: "abstracts",
          description: "Using only the abstracts, give an overview",
          expectedEffect: "digest",
          targetIds: ["5", "7"],
          read: { source: "abstract" },
        },
      ],
    });
    const answer = outcome.toolResult.content as Record<string, any>;
    assert.deepEqual(answer.digestFailures, [
      {
        itemId: 7,
        title: "Drift C",
        reason: "No abstract in the Zotero record or the PDF",
      },
    ]);
    assert.include(answer.digestNote, "Nothing read for Drift C (item:7");
    assert.deepEqual(reads, [
      { itemId: 5, scope: "abstract" },
      { itemId: 7, scope: "abstract" },
    ]);
  });

  it("names a paper with none of the named sections, limits the read, and reads nothing else for it", async function () {
    const reads: Array<{ itemId: number; scope?: string }> = [];
    const harness = createHarness(
      {
        ...scopedDigests(reads, async () => reply("unused")),
        readText: async (paper, _maxChars, scope) => {
          reads.push({ itemId: paper.itemId, scope: scope?.source });
          return {
            backend: "pdf",
            text: "",
            totalCharacters: 0,
            covered: [],
            unmatched: ["abstract", "results"],
          };
        },
      },
      [7],
    );
    const outcome = await runCall(harness, "call-sections", {
      tasks: [
        {
          taskId: "findings",
          description: "Summarize the findings",
          expectedEffect: "digest",
          targetIds: ["7"],
          read: { source: "sections", sections: ["abstract", "results"] },
        },
      ],
    });
    const answer = outcome.toolResult.content as Record<string, any>;
    assert.equal(
      answer.digestFailures[0]?.reason,
      "None of the named sections were found",
    );
    assert.include(answer.digestNote, "Nothing read for Drift C (item:7");
    assert.include(answer.digestNote, "abstract, results");
    assert.include(answer.digestNote, SECTIONS_NOT_FOUND_RULE);
    assert.deepEqual(reads, [{ itemId: 7, scope: "sections" }]);
  });

  it("states the not-found rule once for several papers that lack a named section, and not twice beside a paper with none", async function () {
    const reads: Array<{ itemId: number; scope?: string }> = [];
    const harness = createHarness(
      {
        ...scopedDigests(reads, async () => reply("A reading of the results.")),
        readText: async (paper, _maxChars, scope) => {
          reads.push({ itemId: paper.itemId, scope: scope?.source });
          if (paper.itemId === 7)
            return {
              backend: "pdf",
              text: "",
              totalCharacters: 0,
              covered: [],
              unmatched: ["abstract", "results"],
            };
          return {
            backend: "mineru",
            text: TEXT,
            totalCharacters: TEXT.length,
            covered: ["Abstract"],
            unmatched: ["results"],
            bounds: "exact",
            textSource: "MinerU sections",
          };
        },
      },
      [5, 6, 7],
    );
    const outcome = await runCall(harness, "call-partial", {
      tasks: [
        {
          taskId: "findings",
          description: "Summarize the findings",
          expectedEffect: "digest",
          targetIds: ["5", "6", "7"],
          read: { source: "sections", sections: ["abstract", "results"] },
        },
      ],
    });
    const answer = outcome.toolResult.content as Record<string, any>;
    const countOf = (text: string) =>
      text.split(SECTIONS_NOT_FOUND_RULE).length - 1;
    // Each partial-match paper keeps its short line; the rule is not in it.
    assert.equal(
      (answer.digests.match(/not in this paper: results/g) || []).length,
      2,
    );
    assert.equal(countOf(answer.digests), 0);
    // A paper with none of the names and two with some: one rule.
    assert.equal(countOf(answer.digestNote), 1);
    // Two partial-match papers alone: one rule.
    const partialOnly = createHarness(
      {
        ...scopedDigests(reads, async () => reply("A reading of the results.")),
        readText: async () => ({
          backend: "mineru",
          text: TEXT,
          totalCharacters: TEXT.length,
          covered: ["Abstract"],
          unmatched: ["results"],
          bounds: "exact",
          textSource: "MinerU sections",
        }),
      },
      [5, 6],
    );
    const second = await runCall(partialOnly, "call-partial-only", {
      tasks: [
        {
          taskId: "findings",
          description: "Summarize the findings",
          expectedEffect: "digest",
          targetIds: ["5", "6"],
          read: { source: "sections", sections: ["abstract", "results"] },
        },
      ],
    });
    const only = second.toolResult.content as Record<string, any>;
    assert.equal(countOf(only.digestNote || ""), 1);
    assert.equal(countOf(only.digests), 0);
  });

  it("reads a paper an override names for its own scope", async function () {
    const reads: Array<{ itemId: number; scope?: string }> = [];
    let calls = 0;
    const harness = createHarness(
      scopedDigests(reads, async () => {
        calls += 1;
        return reply("Cells drift slowly.");
      }),
      [5, 6],
    );
    const outcome = await runCall(harness, "call-mixed", {
      tasks: [
        {
          taskId: "papers",
          description: "Summarize each paper",
          expectedEffect: "digest",
          targetIds: ["5", "6"],
          read: { source: "abstract" },
          overrides: [{ itemId: "item:6", read: { source: "full" } }],
        },
      ],
    });
    assert.isTrue(outcome.toolResult.ok, JSON.stringify(outcome.toolResult));
    assert.deepEqual(reads, [
      { itemId: 5, scope: "abstract" },
      { itemId: 6, scope: undefined },
    ]);
    assert.equal(calls, 1, "only the full read calls the model");
    const task = harness.request.executionCheckpoint!.tasks[0];
    assert.deepEqual(task.readOverrides, [
      { target: "item:6", read: { source: "full" } },
    ]);
  });

  it("refuses a read scope on a part that is not a digest, and overrides for papers it does not name", async function () {
    const harness = createHarness(
      scopedDigests([], async () => reply("unused")),
      [5, 6],
    );
    const notDigest = await runCall(harness, "call-read", {
      tasks: [
        {
          taskId: "read",
          description: "Read the papers",
          expectedEffect: "read",
          targetIds: ["5"],
          read: { source: "abstract" },
        },
      ],
    });
    assert.isFalse(notDigest.toolResult.ok);
    assert.include(
      JSON.stringify(notDigest.toolResult.content),
      "expectedEffect:'digest'",
    );
    const outside = await runCall(harness, "call-outside", {
      tasks: [
        {
          taskId: "papers",
          description: "Summarize each paper",
          expectedEffect: "digest",
          targetIds: ["5"],
          overrides: [{ itemId: 6, read: { source: "abstract" } }],
        },
      ],
    });
    assert.isFalse(outside.toolResult.ok);
    assert.include(JSON.stringify(outside.toolResult.content), "item:6");
  });

  it("keeps a part's scope on a repeat, and a new scope on a part with progress needs a new part", async function () {
    const reads: Array<{ itemId: number; scope?: string }> = [];
    const harness = createHarness(
      scopedDigests(reads, async () => reply("unused")),
      [5, 6],
    );
    const declaration = {
      taskId: "abstracts",
      description: "Using only the abstracts, give an overview",
      expectedEffect: "digest",
      targetIds: ["5", "6"],
      read: { source: "abstract" },
    };
    await runCall(harness, "call-1", { tasks: [declaration] });
    const { read: _read, ...withoutRead } = declaration;
    await runCall(harness, "call-2", { tasks: [withoutRead] });
    assert.deepEqual(harness.request.executionCheckpoint!.tasks[0].readScope, {
      source: "abstract",
    });
    const widened = await runCall(harness, "call-3", {
      tasks: [{ ...declaration, read: { source: "full" } }],
    });
    assert.isFalse(widened.toolResult.ok);
    assert.include(
      JSON.stringify(widened.toolResult.content),
      "Task abstracts is completed",
    );
  });
});

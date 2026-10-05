import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createSubmitDocumentTool } from "../src/agent/tools/control/submitDocument";
import {
  createTaskUpdateTool,
  type TaskUpdateToolDeps,
} from "../src/agent/tools/control/taskUpdate";
import { createNoteWriteTool } from "../src/agent/tools/write/noteWrite";
import { OUTCOME_REASONS } from "../src/agent/loop/outcomes";
import { PAPER_RECORD_PRIOR_TOKENS } from "../src/agent/loop/longJob";
import { ExecutionCheckpointFold } from "../src/agent/execution/checkpointEvents";
import { estimateContextMessagesTokens } from "../src/utils/modelInputCap";
import {
  clearAgentTranscriptStore,
  loadAgentTranscriptSegment,
  PORTABLE_TRANSCRIPT_KEY,
  replaceAgentTranscriptSegment,
} from "../src/agent/store/transcriptStore";
import { initAgentTraceStore } from "../src/agent/store/traceStore";
import { listAgentToolResultHandles } from "../src/agent/store/toolResultHandles";

const estimatePrompt = (messages: AgentModelMessage[]) =>
  estimateContextMessagesTokens(messages);
import type { TaskPaperScopeSet } from "../src/agent/context/taskPaperScopeListing";
import { createTestActionContractService } from "./helpers/actionContractService";
import {
  DISCOVER_IMPORT,
  RENAME_DELETE_FOLDER,
} from "./helpers/liveLedgerRuns";
import {
  PAPER_IDS,
  PARENT_ITEM_ID,
  createBatchJourneyRegistry,
  finalStep,
  installBatchJourneyEnvironment,
  installDirectJourneyEnvironment,
  runJourneyTurn,
  toolCallStep,
  type BatchJourneyEnvironment,
  type DirectJourneyEnvironment,
} from "./helpers/materialJourneys";
import type { AgentStepParams } from "../src/agent/model/adapter";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type {
  AgentActionReceipt,
  AgentEvent,
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeOutcome,
  AgentRuntimeRequest,
  AgentRuntimeRequestInput,
  AgentToolCall,
  AgentToolContext,
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
} from "../src/agent/types";

/**
 * The outcome ledger inside real turns.
 *
 * Each case scripts the model's steps against the runtime, the note tool and
 * the action-contract service, and reads what the run published: the
 * `execution_checkpoint` events, the settled end state, and how many model
 * requests the turn cost.
 */

const SAVE = "Save the summary as a note on the paper";
const SUMMARY = "# Summary\n\nA complete summary of the paper.";
const TEN_ITEMS = Array.from({ length: 10 }, (_, index) => `item:${index + 1}`);

const submitDocumentGateway = {
  formatStructuredCitations: () => ({
    styleId: "apa",
    styleTitle: "APA",
    locale: "en-US",
    clusters: [],
    bibliographyEntries: [],
  }),
} as unknown as ZoteroGateway;

type ScriptStep =
  | AgentModelStep
  | ((
      messages: AgentModelMessage[],
    ) => AgentModelStep | Promise<AgentModelStep>);

type Turn = {
  outcome?: AgentRuntimeOutcome;
  error?: unknown;
  /** Zotero quit during the turn: it never finished. */
  quit?: true;
  events: AgentEvent[];
  prompts: AgentModelMessage[][];
  request?: AgentRuntimeRequest;
  /** Model requests the turn made. */
  requests: number;
  /** The ledger the turn held when its first model request was sent. */
  initialCheckpoint?: ExecutionCheckpoint;
};

/** The receipt the scripted `library_update` call is finalized with. */
let libraryUpdateReceipt: AgentActionReceipt | undefined;

/** Receipts the scripted library writes return in turn, before the above. */
let liveReceipts: AgentActionReceipt[] = [];

/**
 * A step during which Zotero quits: the request never returns, and the run
 * is left running, as a quit leaves it.
 */
const ZOTERO_QUITS = { kind: "zotero_quits" } as unknown as AgentModelStep;

/** A promise, and the function that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Zotero starting again: its startup marks every run left running as
 * interrupted, and the transcript is read back from the database.
 */
async function restartZotero(): Promise<void> {
  await initAgentTraceStore();
  clearAgentTranscriptStore();
}

/** The digest host task_update runs, when a case scripts one. */
let taskUpdateDeps: TaskUpdateToolDeps | undefined;

/** What the scripted `paper_read` returns, when a case scripts it. */
let scriptedPaperRead:
  | ((input: Record<string, unknown>, context: AgentToolContext) => unknown)
  | undefined;

function stepOf(...calls: AgentToolCall[]): AgentModelStep {
  return {
    kind: "tool_calls",
    calls,
    assistantMessage: { role: "assistant", content: "", tool_calls: calls },
  };
}

function declare(id: string, tasks: Record<string, unknown>[]): AgentToolCall {
  return { id, name: "task_update", arguments: { tasks } };
}

const saveDeclaration = {
  taskId: "save",
  description: SAVE,
  expectedEffect: "mutation",
  expectedCapability: "zotero.notes",
  targetIds: [String(PARENT_ITEM_ID)],
};

function noteWrite(id: string): AgentToolCall {
  return {
    id,
    name: "note_write",
    arguments: {
      mode: "create",
      content: SUMMARY,
      targetItemId: PARENT_ITEM_ID,
    },
  };
}

function paperRead(id: string): AgentToolCall {
  return { id, name: "paper_read", arguments: { itemId: PARENT_ITEM_ID } };
}

function registry(): AgentToolRegistry {
  const service = createTestActionContractService(
    (itemId) => (globalThis.Zotero as any).Items.get(itemId) || null,
  );
  const finalize = service.finalize.bind(service);
  service.finalize = (async (prepared, params) => {
    if (
      prepared.proposals.some((proposal) => proposal.id === "library-update")
    ) {
      const next = liveReceipts.shift() || libraryUpdateReceipt;
      if (next) return [next];
    }
    return finalize(prepared, params);
  }) as typeof service.finalize;
  const tools = new AgentToolRegistry(service);
  tools.register(createSubmitDocumentTool(submitDocumentGateway));
  tools.register(
    createNoteWriteTool({
      getItem: (itemId: number) => (globalThis.Zotero as any).Items.get(itemId),
      getCollectionSummary: () => null,
    } as unknown as ZoteroGateway),
  );
  tools.register(createTaskUpdateTool(taskUpdateDeps));
  tools.register({
    spec: {
      name: "paper_read",
      description: "Read one paper",
      inputSchema: { type: "object" },
      executionClass: "read",
      workCategory: "retrieval",
    },
    validate: (args: unknown) => ({ ok: true, value: args as never }),
    execute: async (
      input: Record<string, unknown>,
      context: AgentToolContext,
    ) =>
      scriptedPaperRead?.(input, context) ?? {
        mode: "targeted",
        results: [],
        papers: [
          {
            paperContext: {
              itemId: PARENT_ITEM_ID,
              contextItemId: PARENT_ITEM_ID,
              libraryID: 1,
            },
            passages: [{ text: "Place cells drift.", sectionLabel: "Results" }],
          },
        ],
      },
  } as never);
  tools.register({
    spec: {
      name: "run_command",
      description: "Run a shell command",
      inputSchema: { type: "object" },
      executionClass: "external_effect",
    },
    describeAction: () => [
      {
        id: "command_execute:fnv1a32:00000001",
        proofDomain: "execution",
        capability: "command.execute",
        operation: "command_execute",
        source: "command",
        requestedTargets: [],
        destinationCollectionIds: [],
      },
    ],
    effectOperations: ["command_execute"],
    validate: (args: unknown) => ({ ok: true, value: args as never }),
    execute: async () => ({
      content: { stdout: "converted", exitCode: 0 },
      effect: "applied",
    }),
  } as never);
  tools.register({
    spec: {
      name: "library_update",
      description: "Update Zotero items",
      inputSchema: { type: "object" },
      executionClass: "external_effect",
    },
    describeAction: () => [
      {
        id: "library-update",
        proofDomain: "zotero_state",
        capability: "zotero.metadata",
        operation: "update_metadata",
        source: "library_mutation",
        requestedTargets: TEN_ITEMS,
        destinationCollectionIds: [],
      },
    ],
    effectOperations: ["update_metadata"],
    validate: (args: unknown) => ({ ok: true, value: args as never }),
    execute: async () => ({
      content: { updated: 8, failed: 2 },
      effect: "partial",
    }),
  } as never);
  tools.register({
    spec: {
      name: "library_import",
      description: "Import papers into Zotero",
      inputSchema: { type: "object" },
      executionClass: "external_effect",
    },
    describeAction: () => [
      {
        id: "library-update",
        proofDomain: "zotero_state",
        capability: "zotero.import",
        operation: "import_identifiers",
        source: "library_mutation",
        requestedTargets: [],
        destinationCollectionIds: [],
      },
    ],
    effectOperations: ["import_identifiers"],
    validate: (args: unknown) => ({ ok: true, value: args as never }),
    execute: async () => ({ content: { succeeded: 2 }, effect: "applied" }),
  } as never);
  return tools;
}

function libraryReceipt(
  overrides: Partial<AgentActionReceipt>,
): AgentActionReceipt {
  return {
    version: 2,
    id: "library-update:receipt",
    proposalId: "library-update",
    proofDomain: "zotero_state",
    capability: "zotero.metadata",
    operation: "update_metadata",
    verification: "verified",
    status: "partial",
    requestedTargets: TEN_ITEMS,
    appliedTargets: TEN_ITEMS.slice(0, 8),
    alreadySatisfiedTargets: [],
    rejectedTargets: TEN_ITEMS.slice(8),
    reasons: ["In a group library you cannot edit"],
    verifiedFacts: [],
    ...overrides,
  };
}

let timestamp = 0;

async function runTurn(params: {
  conversationKey: number;
  userText: string;
  steps: ScriptStep[];
  approve?: boolean;
  signal?: AbortSignal;
  /** The papers the host resolves for the turn's scope. */
  scope?: TaskPaperScopeSet;
  /** Counts each time the host resolves the scope. */
  onResolveScope?: () => void;
  /** Contexts the user attached to the question, and other request fields. */
  attached?: Partial<AgentRuntimeRequestInput>;
  /**
   * How long the turn waits for a stopped turn before it to settle; 0 starts
   * at once, as when the wait's bound has run out.
   */
  stoppedRunWaitMs?: number;
}): Promise<Turn> {
  const events: AgentEvent[] = [];
  const prompts: AgentModelMessage[][] = [];
  let request: AgentRuntimeRequest | undefined;
  let initialCheckpoint: ExecutionCheckpoint | undefined;
  let requests = 0;
  let quit: () => void = () => undefined;
  const quitting = new Promise<typeof ZOTERO_QUITS>((resolve) => {
    quit = () => resolve(ZOTERO_QUITS);
  });
  const runtime = new AgentRuntime({
    ...(params.stoppedRunWaitMs !== undefined
      ? { stoppedRunWaitMs: params.stoppedRunWaitMs }
      : {}),
    ...(params.scope
      ? {
          resolveTurnScopePapers: async () => {
            params.onResolveScope?.();
            return params.scope;
          },
        }
      : {}),
    registry: registry(),
    adapterFactory: (resolved) => ({
      getCapabilities: () => ({
        streaming: false,
        toolCalls: true,
        multimodal: false,
      }),
      supportsTools: () => true,
      async runStep(stepParams: AgentStepParams): Promise<AgentModelStep> {
        request = resolved;
        if (requests === 0 && resolved.executionCheckpoint)
          initialCheckpoint = structuredClone(resolved.executionCheckpoint);
        // The session restarts and appends in place: keep each step's view.
        prompts.push([...stepParams.messages]);
        const step = params.steps[requests];
        requests += 1;
        if (!step)
          throw new Error(
            `The script ends at ${params.steps.length} steps; the model was asked for step ${requests}.`,
          );
        const next =
          typeof step === "function" ? await step(stepParams.messages) : step;
        if (next !== ZOTERO_QUITS) return next;
        quit();
        return new Promise<AgentModelStep>(() => undefined);
      },
    }),
  });
  let outcome: AgentRuntimeOutcome | undefined;
  let error: unknown;
  let quitDuring = false;
  timestamp += 100;
  try {
    const running = runtime.runTurn({
      request: {
        conversationKey: params.conversationKey,
        mode: "agent",
        userText: params.userText,
        libraryID: 1,
        model: "test",
        apiKey: "test",
        apiBase: "https://example.invalid",
        metadata: { sourceMessageTimestamp: timestamp },
        ...params.attached,
      },
      signal: params.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "confirmation_required")
          runtime.resolveConfirmation(
            event.requestId,
            params.approve !== false,
          );
      },
    });
    const ended = await Promise.race([running, quitting]);
    if (ended === ZOTERO_QUITS) quitDuring = true;
    else outcome = ended as AgentRuntimeOutcome;
  } catch (caught) {
    error = caught;
  }
  return {
    outcome,
    error,
    ...(quitDuring ? { quit: true as const } : {}),
    events,
    prompts,
    request,
    requests,
    initialCheckpoint,
  };
}

/** The ledger after each of the run's ledger events, whole or delta. */
function checkpoints(turn: Turn): ExecutionCheckpoint[] {
  const fold = new ExecutionCheckpointFold();
  return turn.events.flatMap((event) => {
    if (
      event.type !== "execution_checkpoint" &&
      event.type !== "execution_checkpoint_delta"
    )
      return [];
    const checkpoint = fold.apply(event);
    assert.exists(checkpoint, "every ledger event folds onto the one before");
    return [checkpoint!];
  });
}

function settled(turn: Turn): ExecutionCheckpoint {
  const all = checkpoints(turn);
  assert.isNotEmpty(all, "the run published its ledger");
  const last = all[all.length - 1];
  assert.exists(last.end, "the last checkpoint carries the end state");
  return last;
}

function outcome(
  checkpoint: ExecutionCheckpoint | undefined,
  local: string,
): ExecutionCheckpointTask {
  const task = checkpoint?.tasks.find(
    (entry) => entry.taskId === `${checkpoint.executionId}:task:${local}`,
  );
  assert.exists(task, `outcome ${local}`);
  return task!;
}

function stopIndex(turn: Turn): number {
  return turn.events.findIndex(
    (event) =>
      event.type === "provider_event" &&
      event.providerType === "agent_run_stop",
  );
}

function stopStatus(turn: Turn): unknown {
  const stop = turn.events[stopIndex(turn)];
  return stop?.type === "provider_event" ? stop.payload?.status : undefined;
}

function receiptIdsOf(turn: Turn, toolName: string): string[] {
  return turn.events.flatMap((event) =>
    event.type === "tool_result" && event.name === toolName
      ? (event.actionReceipts || []).map((receipt) => receipt.id)
      : [],
  );
}

function promptText(messages: AgentModelMessage[]): string {
  return messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    )
    .join("\n");
}

describe("outcome ledger in runtime turns", function () {
  let environment: DirectJourneyEnvironment;
  let conversationKey = 993_000;

  beforeEach(async function () {
    environment = await installDirectJourneyEnvironment();
    libraryUpdateReceipt = undefined;
    scriptedPaperRead = undefined;
    conversationKey += 10;
  });

  afterEach(function () {
    environment.restore();
  });

  it("summarize-and-save: the declared save completes from the note's receipt, in three requests", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Summarize this paper and save it as a note",
      steps: [
        stepOf(declare("declare-1", [saveDeclaration]), paperRead("read-1")),
        stepOf(noteWrite("note-1")),
        finalStep("I summarized the paper and saved it as a note."),
      ],
    });

    assert.equal(turn.outcome?.kind, "completed");
    assert.equal(turn.requests, 3);
    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "completed" });
    const save = outcome(ledger, "save");
    assert.equal(save.status, "completed");
    assert.deepEqual(save.verifiedReceiptIds, receiptIdsOf(turn, "note_write"));
    const lastCheckpoint = turn.events.findLastIndex(
      (event) => event.type === "execution_checkpoint",
    );
    assert.isAbove(lastCheckpoint, -1);
    assert.isAbove(
      stopIndex(turn),
      lastCheckpoint,
      "the settled ledger is published before the stop rule",
    );
  });

  it("a declared reasoning part completes when the final answer is accepted", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Explain how drift was measured in this paper",
      steps: [
        stepOf(
          declare("declare-1", [
            {
              taskId: "explain",
              description: "Explain how drift was measured",
              expectedEffect: "reasoning",
            },
          ]),
          paperRead("read-1"),
        ),
        finalStep("Drift was measured as the change in place-field centres."),
      ],
    });

    assert.equal(turn.requests, 2, "no correction: the answer is the part");
    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "completed" });
    assert.equal(outcome(ledger, "explain").status, "completed");
  });

  it("false save claim: one correction names the open save, then the run ends completed with exceptions", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Summarize this paper and save it as a note",
      steps: [
        stepOf(declare("declare-1", [saveDeclaration])),
        finalStep("Saved."),
        finalStep("Saved."),
      ],
    });

    assert.equal(turn.outcome?.kind, "completed");
    assert.equal(turn.requests, 3);
    assert.include(
      promptText(turn.prompts[2]),
      `Before answering, finish the parts of this request you declared that are still open: “${SAVE}”.`,
    );
    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "completed_with_exceptions" });
    assert.deepEqual(
      [outcome(ledger, "save").status, outcome(ledger, "save").reason],
      ["skipped", OUTCOME_REASONS.notDone],
    );
  });

  it("a skip claiming delivery is refused and the part stays open; the answer that follows delivers it, with no correction", async function () {
    const REVIEW = "Write the literature review";
    const turn = await runTurn({
      conversationKey,
      userText: "Write a literature review of these papers",
      steps: [
        stepOf(
          declare("declare-1", [
            {
              taskId: "review",
              description: REVIEW,
              expectedEffect: "artifact",
            },
          ]),
        ),
        stepOf({
          id: "skip-1",
          name: "task_update",
          arguments: {
            skipped: [
              {
                taskId: "review",
                reason: "Already delivered in this conversation",
              },
            ],
          },
        }),
        finalStep("# Review\n\nThe papers agree on drift."),
      ],
    });

    assert.equal(turn.outcome?.kind, "completed");
    assert.equal(turn.requests, 3, "the answer can deliver the review itself");
    const refusal = promptText(turn.prompts[2]);
    assert.include(
      refusal,
      "Skip refused for review: nothing was delivered for it in this run",
    );
    assert.include(
      refusal,
      "Produce it with the tools, or, if it truly cannot be done, list it under blocked with the concrete obstacle.",
    );
    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "completed" });
    assert.equal(outcome(ledger, "review").status, "completed");
  });

  it("a skip of a save with a delivery-worded reason is accepted, as a write is not content", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Summarize this paper and save it as a note",
      steps: [
        stepOf(declare("declare-1", [saveDeclaration])),
        stepOf({
          id: "skip-1",
          name: "task_update",
          arguments: {
            skipped: [
              {
                taskId: "save",
                reason: "The note was previously created in an earlier session",
              },
            ],
          },
        }),
        finalStep("The note already exists."),
      ],
    });

    assert.equal(turn.requests, 3, "no correction: the save is settled");
    assert.notInclude(promptText(turn.prompts[2]), "Skip refused");
    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "completed_with_exceptions" });
    assert.equal(outcome(ledger, "save").status, "skipped");
  });

  it("does not repeat the correction when no new evidence arrived; it accepts and settles instead", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Summarize this paper and save it as a note",
      steps: [
        stepOf(declare("declare-1", [saveDeclaration])),
        finalStep("Saved."),
        stepOf(paperRead("read-1")),
        finalStep("Saved."),
      ],
    });

    // A second correction would ask for a fifth step the script does not have.
    assert.equal(turn.outcome?.kind, "completed");
    assert.equal(turn.requests, 4);
    assert.equal(
      promptText(turn.prompts[3]).split("Before answering, finish the parts")
        .length - 1,
      1,
      "the correction was sent once",
    );
    assert.deepEqual(settled(turn).end, { state: "completed_with_exceptions" });
    assert.lengthOf(
      checkpoints(turn),
      2,
      "one event per change: the declaration and the settled end, not the read or the answer that moved nothing",
    );
  });

  it("partial batch without a declaration: a host outcome with one exception ends completed with exceptions", async function () {
    libraryUpdateReceipt = libraryReceipt({});
    const turn = await runTurn({
      conversationKey,
      userText: "Set the year on these ten papers",
      steps: [
        stepOf({ id: "update-1", name: "library_update", arguments: {} }),
        finalStep("Updated eight of the ten papers."),
      ],
    });

    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "completed_with_exceptions" });
    assert.lengthOf(ledger.tasks, 1);
    const [host] = ledger.tasks;
    assert.equal(host.origin, "host");
    assert.equal(host.status, "completed");
    assert.lengthOf(host.doneTargets!, 8);
    assert.deepEqual(host.exceptions, [
      {
        targets: ["item:9", "item:10"],
        reason: "In a group library you cannot edit",
      },
    ]);
  });

  it("an unverified receipt ends the run blocked", async function () {
    libraryUpdateReceipt = libraryReceipt({
      verification: "unverified",
      status: "unverified",
      appliedTargets: [],
      rejectedTargets: TEN_ITEMS,
      reasons: ["The captured post-state could not be read back."],
    });
    const turn = await runTurn({
      conversationKey,
      userText: "Set the year on these ten papers",
      steps: [
        stepOf({ id: "update-1", name: "library_update", arguments: {} }),
        finalStep("Updated the papers."),
      ],
    });

    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "blocked" });
    assert.equal(ledger.tasks[0].status, "blocked");
    assert.equal(ledger.tasks[0].reason, OUTCOME_REASONS.unverified);
  });

  it("a run the user stops ends cancelled and keeps its open outcome pending", async function () {
    const controller = new AbortController();
    const turn = await runTurn({
      conversationKey,
      userText: "Summarize this paper and save it as a note",
      signal: controller.signal,
      steps: [
        stepOf(declare("declare-1", [saveDeclaration])),
        () => {
          controller.abort();
          throw new Error("The request was aborted.");
        },
      ],
    });

    assert.equal(stopStatus(turn), "cancelled");
    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "cancelled" });
    assert.equal(outcome(ledger, "save").status, "pending");
  });

  it("a provider error after progress ends interrupted; 'continue' resumes the ledger and saves the note", async function () {
    const interrupted = await runTurn({
      conversationKey,
      userText: "Read this paper and save a summary as a note",
      steps: [
        stepOf(
          declare("declare-1", [
            {
              taskId: "read",
              description: "Read the paper",
              expectedEffect: "read",
              targetIds: [String(PARENT_ITEM_ID)],
            },
            saveDeclaration,
          ]),
          paperRead("read-1"),
        ),
        () => {
          throw new Error("provider interrupted");
        },
      ],
    });
    assert.equal(stopStatus(interrupted), "failed");
    const before = settled(interrupted);
    assert.deepEqual(before.end, { state: "interrupted" });
    assert.equal(outcome(before, "read").status, "completed");
    assert.equal(outcome(before, "save").status, "pending");

    const resumed = await runTurn({
      conversationKey,
      userText: "continue",
      steps: [stepOf(noteWrite("note-1")), finalStep("Saved the summary.")],
    });
    const adopted = resumed.initialCheckpoint;
    assert.exists(adopted, "the interrupted ledger was adopted");
    assert.equal(adopted!.executionId, before.executionId);
    assert.notProperty(adopted!, "end");
    assert.deepEqual(
      adopted!.tasks.map((task) => task.status),
      ["completed", "pending"],
    );
    assert.include(
      promptText(resumed.prompts[0]),
      outcome(before, "save").taskId,
      "the model sees the open parts",
    );
    const after = settled(resumed);
    assert.deepEqual(after.end, { state: "completed" });
    assert.equal(outcome(after, "save").status, "completed");
  });

  it("any other message after an interrupted run starts with no ledger", async function () {
    await runTurn({
      conversationKey,
      userText: "Read this paper and save a summary as a note",
      steps: [
        stepOf(
          declare("declare-1", [
            {
              taskId: "read",
              description: "Read the paper",
              expectedEffect: "read",
              targetIds: [String(PARENT_ITEM_ID)],
            },
            saveDeclaration,
          ]),
          paperRead("read-1"),
        ),
        () => {
          throw new Error("provider interrupted");
        },
      ],
    });
    const fresh = await runTurn({
      conversationKey,
      userText: "What is drift?",
      steps: [finalStep("Drift is a gradual change in a representation.")],
    });
    assert.isUndefined(fresh.initialCheckpoint);
    assert.notInclude(
      promptText(fresh.prompts[0]),
      "HOST-PERSISTED ORDINARY WORK CHECKPOINT",
    );
    assert.isEmpty(checkpoints(fresh));
    assert.equal(fresh.requests, 1);
  });

  it("continue after a run that settled any other way starts with no ledger", async function () {
    await runTurn({
      conversationKey,
      userText: "Summarize this paper and save it as a note",
      steps: [
        stepOf(declare("declare-1", [saveDeclaration])),
        finalStep("Saved."),
        finalStep("Saved."),
      ],
    });
    const next = await runTurn({
      conversationKey,
      userText: "continue",
      steps: [finalStep("There is nothing left to continue.")],
    });
    assert.isUndefined(next.initialCheckpoint);
    assert.isEmpty(checkpoints(next));
  });

  it("a plain question publishes no ledger at all, in one request", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "What is representational drift?",
      steps: [finalStep("A gradual change in a neural representation.")],
    });
    assert.equal(turn.outcome?.kind, "completed");
    assert.equal(turn.requests, 1);
    assert.isEmpty(checkpoints(turn));
  });

  it("a verified retry after a failed note write completes the declared save", async function () {
    environment.library.failNextNativeSave(true);
    const turn = await runTurn({
      conversationKey,
      userText: "Summarize this paper and save it as a note",
      steps: [
        stepOf(declare("declare-1", [saveDeclaration]), noteWrite("note-1")),
        () => {
          environment.library.failNextNativeSave(false);
          return stepOf(noteWrite("note-2"));
        },
        finalStep("Saved the summary on the second try."),
      ],
    });

    assert.equal(turn.requests, 3);
    assert.equal(environment.library.nativeSaves(), 1);
    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "completed" });
    const save = outcome(ledger, "save");
    assert.equal(save.status, "completed");
    assert.notProperty(save, "reason");
  });

  it("a command's execution-only receipt completes its host outcome", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Convert the exported file",
      steps: [
        stepOf({ id: "command-1", name: "run_command", arguments: {} }),
        finalStep("Converted the file."),
      ],
    });

    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "completed" });
    assert.lengthOf(ledger.tasks, 1);
    assert.equal(ledger.tasks[0].description, "Ran command");
    assert.equal(ledger.tasks[0].status, "completed");
    assert.deepEqual(ledger.tasks[0].verifiedReceiptIds, []);
  });

  it("a write the user declines ends the run blocked", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Summarize this paper and save it as a note",
      approve: false,
      steps: [
        stepOf(declare("declare-1", [saveDeclaration])),
        stepOf(noteWrite("note-1")),
        finalStep("I did not save the note."),
      ],
    });

    assert.equal(turn.requests, 3);
    assert.equal(environment.library.nativeSaves(), 0);
    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "blocked" });
    const save = outcome(ledger, "save");
    assert.equal(save.status, "blocked");
    assert.equal(save.reason, OUTCOME_REASONS.declined);
    assert.include(save.receiptIds, "declined:note-1");
  });
});

/** The Plan tables on a real in-memory SQLite, beside the mock run store. */
function installPlanSqlite(): () => void {
  const zotero = globalThis as typeof globalThis & { Zotero: typeof Zotero };
  const base = zotero.Zotero.DB;
  const db = new DatabaseSync(":memory:");
  zotero.Zotero.DB = {
    ...base,
    queryAsync: async (sql: string, params: unknown[] = []) => {
      if (
        !sql.includes("llm_for_zotero_plan_") &&
        !sql.includes("llm_for_zotero_research")
      )
        return base.queryAsync(sql, params);
      const statement = db.prepare(sql);
      const values = params.map((value) =>
        value === undefined ? null : value,
      ) as never[];
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql))
        return statement.all(...values);
      statement.run(...values);
      return [];
    },
  } as unknown as typeof Zotero.DB;
  return () => {
    zotero.Zotero.DB = base;
    db.close();
  };
}

describe("parts over the turn's paper scope in runtime turns", function () {
  let environment: DirectJourneyEnvironment;
  let conversationKey = 994_000;
  const READ_ALL = "Read each paper in Drift";

  /** A paper's context, as paper_read rows name it. */
  const paperOf = (itemId: number) => ({
    itemId,
    contextItemId: itemId + 1000,
    libraryID: 1,
  });

  /** Body passages for a targeted read, an outline, or no text at all. */
  function paperReadPayload(input: Record<string, unknown>): unknown {
    const itemId = Number((input.target as { itemId?: number })?.itemId);
    if (input.mode === "outline")
      return {
        mode: "outline",
        papers: [
          {
            paperContext: paperOf(itemId),
            outline: { sections: [{ title: "Introduction" }] },
          },
        ],
      };
    if (input.mode === "overview")
      return {
        mode: "overview",
        results: [
          {
            backend: "zotero_metadata",
            sourceKind: "zotero_metadata",
            coverage: "metadata_only",
            text: "Title: A paper without a PDF",
            paperContext: paperOf(itemId),
          },
        ],
      };
    return {
      mode: "targeted",
      results: [],
      papers: [
        {
          paperContext: paperOf(itemId),
          passages: [{ text: "Place cells drift.", sectionLabel: "Results" }],
        },
      ],
    };
  }

  function read(id: string, itemId: number, mode?: string): AgentToolCall {
    return {
      id,
      name: "paper_read",
      arguments: { target: paperOf(itemId), ...(mode ? { mode } : {}) },
    };
  }

  const readAll = {
    taskId: "read-all",
    description: READ_ALL,
    expectedEffect: "read",
    scope: true,
  };

  /**
   * The papers of an attached folder. With nothing attached the agent names
   * its papers itself (scope:true covers only a write part there), so a part
   * over the scope is a part over what the user attached.
   */
  function scope(itemIds: number[], withText: number): TaskPaperScopeSet {
    return { wholeLibrary: false, itemIds, withText };
  }
  const drift = {
    selectedCollectionContexts: [
      { collectionId: 9, name: "Drift", libraryID: 1 },
    ],
  };

  beforeEach(async function () {
    environment = await installDirectJourneyEnvironment();
    libraryUpdateReceipt = undefined;
    scriptedPaperRead = paperReadPayload;
    conversationKey += 10;
  });

  afterEach(function () {
    environment.restore();
    scriptedPaperRead = undefined;
  });

  it("states the scope, freezes it at declaration, and ticks only papers whose text was read", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift and summarize each",
      scope: scope([101, 102, 103], 2),
      attached: drift,
      steps: [
        stepOf(
          declare("declare-1", [readAll]),
          read("read-101", 101),
          read("read-102", 102, "outline"),
          read("read-103", 103, "overview"),
        ),
        finalStep("I read the papers."),
        stepOf(read("read-102-text", 102)),
        finalStep("Each paper, summarized."),
      ],
    });

    assert.include(
      promptText(turn.prompts[0]),
      "\nPaper scope: Drift — 3 papers, 2 with full text\n",
    );
    const declared = checkpoints(turn)[0];
    assert.deepEqual(outcome(declared, "read-all").targets, [
      "item:101",
      "item:102",
      "item:103",
    ]);
    assert.isTrue(outcome(declared, "read-all").scope);
    // The model reads the part back as counts; the papers stay with the host.
    assert.include(
      promptText(turn.prompts[1]),
      '"parts":[{"taskId":"read-all","status":"pending","done":0,"total":3,"scope":true}]',
    );
    assert.notInclude(promptText(turn.prompts[1]), '"item:10');
    // The ledger is published whole once, then as deltas.
    const ledgerEvents = turn.events.filter(
      (event) =>
        event.type === "execution_checkpoint" ||
        event.type === "execution_checkpoint_delta",
    );
    assert.deepEqual(
      ledgerEvents.map((event) => event.type),
      [
        "execution_checkpoint",
        ...Array(ledgerEvents.length - 1).fill("execution_checkpoint_delta"),
      ],
    );
    // Each change is published once; the outline read changed nothing.
    assert.deepEqual(
      checkpoints(turn).map((checkpoint) => {
        const part = outcome(checkpoint, "read-all");
        return [
          part.status,
          part.doneTargets ?? [],
          (part.exceptions ?? []).flatMap((entry) => entry.targets),
        ];
      }),
      [
        ["pending", [], []],
        ["pending", ["item:101"], []],
        ["pending", ["item:101"], ["item:103"]],
        ["completed", ["item:101", "item:102"], ["item:103"]],
        ["completed", ["item:101", "item:102"], ["item:103"]],
      ],
    );
    assert.include(
      promptText(turn.prompts[2]),
      `Before answering, finish the parts of this request you declared that are still open: “${READ_ALL}”.`,
    );
    const ledger = settled(turn);
    const task = outcome(ledger, "read-all");
    assert.equal(task.status, "completed");
    assert.deepEqual(task.doneTargets, ["item:101", "item:102"]);
    assert.deepEqual(task.exceptions, [
      { targets: ["item:103"], reason: OUTCOME_REASONS.noText },
    ]);
    assert.deepEqual(ledger.end, { state: "completed_with_exceptions" });
  });

  it("states and resolves no scope for one paper, and does for two", async function () {
    const paper = (itemId: number) => ({
      itemId,
      contextItemId: itemId + 1000,
      title: `Paper ${itemId}`,
      libraryID: 1,
    });
    let resolved = 0;
    const one = await runTurn({
      conversationKey,
      userText: "Summarize this paper",
      scope: scope([101], 1),
      onResolveScope: () => (resolved += 1),
      attached: { selectedPaperContexts: [paper(101)] },
      steps: [finalStep("A summary.")],
    });
    assert.equal(resolved, 0, "a one-paper chat waits for no snapshot");
    assert.notInclude(promptText(one.prompts[0]), "Paper scope:");
    assert.isUndefined(one.request?.turnScopePapers);

    const two = await runTurn({
      conversationKey: conversationKey + 1,
      userText: "Compare these papers",
      scope: { wholeLibrary: false, itemIds: [101, 102], withText: 2 },
      onResolveScope: () => (resolved += 1),
      attached: { selectedPaperContexts: [paper(101), paper(102)] },
      steps: [finalStep("A comparison.")],
    });
    assert.equal(resolved, 1);
    assert.include(
      promptText(two.prompts[0]),
      "\nPaper scope: listed papers — 2 papers, 2 with full text\n",
    );
  });

  it("with nothing attached, refuses a first-step read part over the whole library, and the model is told to search and name its papers", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "What do my papers say about place-cell drift?",
      scope: { wholeLibrary: true, itemIds: [101, 102, 103], withText: 2 },
      steps: [
        stepOf(declare("declare-1", [readAll])),
        (messages) => {
          const text = promptText(messages);
          assert.include(
            text,
            "Nothing is attached, so scope:true on task read-all would cover the whole library (3 papers).",
          );
          assert.include(text, "Search with library_retrieve first");
          return stepOf(
            declare("declare-2", [
              { ...readAll, scope: undefined, targetIds: ["101"] },
            ]),
            read("read-101", 101),
          );
        },
        finalStep("Paper 101 finds that drift is slow."),
      ],
    });
    assert.include(
      promptText(turn.prompts[0]),
      "\nPaper scope: whole library — 3 papers, 2 with full text\n",
    );
    const first = checkpoints(turn)[0];
    assert.deepEqual(
      outcome(first, "read-all").targets,
      ["item:101"],
      "the refused declaration left no part behind",
    );
    const ledger = settled(turn);
    assert.equal(outcome(ledger, "read-all").status, "completed");
    assert.deepEqual(ledger.end, { state: "completed" });
  });

  it("a part declared after its papers were read takes those reads", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift",
      scope: scope([101, 102], 2),
      attached: drift,
      steps: [
        stepOf(read("read-101", 101)),
        stepOf(declare("declare-1", [readAll]), read("read-102", 102)),
        finalStep("Both papers are read."),
      ],
    });
    assert.deepEqual(
      outcome(checkpoints(turn)[0], "read-all").doneTargets,
      ["item:101"],
      "the read before the declaration ticks its paper at once",
    );
    const ledger = settled(turn);
    assert.equal(outcome(ledger, "read-all").status, "completed");
    assert.deepEqual(ledger.end, { state: "completed" });
  });

  it("an abstract-depth read alone leaves the part open and the answer is corrected once", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift",
      scope: scope([101], 1),
      attached: drift,
      steps: [
        stepOf(declare("declare-1", [readAll]), read("read-1", 101, "outline")),
        finalStep("I read it."),
        finalStep("I read it."),
      ],
    });
    const ledger = settled(turn);
    assert.equal(turn.requests, 3, "one correction for the open part");
    assert.isUndefined(outcome(ledger, "read-all").doneTargets);
    assert.deepEqual(ledger.end, { state: "completed_with_exceptions" });
  });

  it("a scope that changes later keeps the frozen papers, through an interruption and 'continue'", async function () {
    const interrupted = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift and summarize each",
      scope: scope([101, 102], 2),
      attached: drift,
      steps: [
        stepOf(declare("declare-1", [readAll]), read("read-101", 101)),
        () => {
          throw new Error("provider interrupted");
        },
      ],
    });
    const before = settled(interrupted);
    assert.deepEqual(before.end, { state: "interrupted" });
    assert.deepEqual(outcome(before, "read-all").doneTargets, ["item:101"]);

    const resumed = await runTurn({
      conversationKey,
      userText: "continue",
      // A paper joined the folder since the part was declared.
      scope: scope([101, 102, 104], 3),
      attached: drift,
      steps: [
        stepOf(declare("declare-2", [readAll]), read("read-102", 102)),
        finalStep("Every paper is summarized."),
      ],
    });
    assert.include(
      promptText(resumed.prompts[0]),
      "\nPaper scope: Drift — 3 papers, 3 with full text\n",
    );
    assert.deepEqual(outcome(resumed.initialCheckpoint, "read-all").targets, [
      "item:101",
      "item:102",
    ]);
    const after = settled(resumed);
    const task = outcome(after, "read-all");
    assert.deepEqual(task.targets, ["item:101", "item:102"]);
    assert.equal(task.status, "completed");
    assert.deepEqual(after.end, { state: "completed" });
  });
});

describe("long jobs in runtime turns", function () {
  let environment: DirectJourneyEnvironment;
  let conversationKey = 995_000;
  const PAPERS = Array.from({ length: 30 }, (_, index) => 2001 + index);
  const READ_ALL = "Read each paper in Drift";

  /** A paper's read: its finding first, sized like its text. */
  function paperText(itemId: number): string {
    const size = itemId <= 2010 ? 4_000 : 10_000;
    const text = `Finding ${itemId}: drift was measured in this paper. `;
    return text + "Representational drift details. ".repeat(size / 31);
  }

  beforeEach(async function () {
    environment = await installDirectJourneyEnvironment();
    libraryUpdateReceipt = undefined;
    conversationKey += 10;
    scriptedPaperRead = (input) => {
      const itemId = Number((input.target as { itemId?: number })?.itemId);
      return {
        mode: "targeted",
        results: [],
        papers: [
          {
            paperContext: {
              itemId,
              contextItemId: itemId + 1000,
              libraryID: 1,
            },
            passages: [
              {
                text: paperText(itemId),
                sectionLabel: "Results",
                pageLabel: "3",
              },
            ],
          },
        ],
      };
    };
  });

  afterEach(function () {
    environment.restore();
    scriptedPaperRead = undefined;
  });

  /** The model: declare the part, then read each page the host names. */
  function pagedModel(): ScriptStep {
    let declared = false;
    const asked = new Set<number>();
    return (messages: AgentModelMessage[]) => {
      if (!declared) {
        declared = true;
        return stepOf(
          declare("declare-1", [
            {
              taskId: "read-all",
              description: READ_ALL,
              expectedEffect: "read",
              scope: true,
            },
          ]),
        );
      }
      const host = [...messages]
        .reverse()
        .map((message) => promptText([message]))
        .find((text) => text.startsWith("Long job"));
      if (!host || host.startsWith("Long job complete"))
        return finalStep("Every paper is summarized from its results.");
      const page = [...host.matchAll(/^- itemId=(\d+)/gm)]
        .map((match) => Number(match[1]))
        .filter((itemId) => !asked.has(itemId))
        .slice(0, 8);
      for (const itemId of page) asked.add(itemId);
      return stepOf(
        ...page.map((itemId) => ({
          id: `read-${itemId}`,
          name: "paper_read",
          arguments: {
            target: { itemId, contextItemId: itemId + 1000, libraryID: 1 },
          },
        })),
      );
    };
  }

  function pageEvents(turn: Turn): Record<string, unknown>[] {
    return turn.events.flatMap((event) =>
      event.type === "provider_event" &&
      event.providerType === "agent_long_job_page"
        ? [event.payload || {}]
        : [],
    );
  }

  /** What the model was sent at the first request of page `number`. */
  function pageStart(turn: Turn, number: number): AgentModelMessage[] {
    const start = turn.prompts.find((messages) =>
      promptText(messages).includes(`Page ${number}:`),
    );
    assert.exists(start, `page ${number} was sent`);
    return start!;
  }

  it("pages a 30-paper job in pages sized from the measured cost, and answers from every paper's digest", async function () {
    const model = pagedModel();
    const turn = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift and summarize each",
      scope: {
        wholeLibrary: false,
        itemIds: PAPERS,
        withText: PAPERS.length,
        papers: Object.fromEntries(
          PAPERS.map((itemId) => [
            itemId,
            { title: `Paper ${itemId}`, text: "pdf" as const },
          ]),
        ),
      },
      attached: {
        selectedCollectionContexts: [
          { collectionId: 9, name: "Drift", libraryID: 1 },
        ],
        advanced: { inputTokenCap: 30_000 },
      },
      steps: Array.from({ length: 40 }, () => model),
    });

    assert.equal(turn.outcome?.kind, "completed", String(turn.error || ""));
    const ledger = settled(turn);
    const part = outcome(ledger, "read-all");
    assert.equal(part.status, "completed");
    assert.lengthOf(part.doneTargets!, 30);

    const pages = pageEvents(turn);
    const sized = pages.filter((page) => typeof page.page === "number");
    assert.isAtLeast(sized.length, 3, JSON.stringify(pages));
    assert.deepEqual(pages[pages.length - 1], {
      complete: true,
      papers: 30,
      digested: (pages[pages.length - 1] as { digested: number }).digested,
    });
    // The first page is sized from the priors, the rest from what the
    // papers measurably cost and how the model read them. Every page holds
    // the smaller of what the room allows and what keeps the job's input
    // least, and is planned from the prompt it starts from.
    assert.include(sized[0], {
      page: 1,
      left: 30,
      measured: false,
      costPerPaper: 12_000,
      papersPerRequest: 3,
      requestsPerPage: 1,
    });
    for (const page of sized) {
      const room = page.room as number;
      const cost = page.costPerPaper as number;
      const R = page.promptTokens as number;
      assert.equal(page.fitBound, Math.floor(room / cost) - 1);
      // Whole requests of m papers, r* = sqrt(2·o·R / (m·c)) of them.
      const m = page.papersPerRequest as number;
      const r = page.readsPerPage as number;
      const best = Math.sqrt(
        (2 * (page.requestsPerPage as number) * R) / (m * cost),
      );
      assert.isAtMost(Math.abs(r - Math.max(1, best)), 0.51);
      assert.isAtMost(
        Math.abs((page.costBound as number) - Math.max(1, m * r)),
        0.51 + 0.01 * r,
      );
      assert.equal(
        page.papers,
        Math.min(
          page.left as number,
          Math.max(
            1,
            Math.min(page.fitBound as number, page.costBound as number),
          ),
        ),
        JSON.stringify(page),
      );
      assert.isBelow(R, page.budgetTokens as number);
      const sent = estimatePrompt(pageStart(turn, page.page as number));
      assert.isAtMost(
        Math.abs(sent - R),
        200,
        `page ${page.page} is planned from the prompt it starts from: ${sent} vs ${R}`,
      );
    }
    assert.isTrue(
      sized.some((page) => page.papers === page.fitBound),
      "on this small window the room decides some pages",
    );
    const measuredCosts = sized
      .filter((page) => page.measured)
      .map((page) => page.costPerPaper as number);
    assert.isAtLeast(measuredCosts.length, 2);
    assert.isAbove(
      Math.max(...measuredCosts),
      Math.min(...measuredCosts),
      "the larger papers raise the measured cost, and the pages shrink",
    );

    // The context stays bounded: what the model saw at the start of the
    // third page differs from the first by no more than the digests.
    const first = estimatePrompt(pageStart(turn, 1));
    const third = estimatePrompt(pageStart(turn, 3));
    const digests = 30 * (sized[2].digestShare as number);
    assert.isBelow(third, 20_250);
    assert.isAtMost(
      Math.abs(third - first),
      digests + 2_400,
      "no more than the digests (at most half the room) and one checkpoint",
    );

    // The final step sees every paper's digest, with its id and anchors.
    const finalPrompt = promptText(turn.prompts[turn.prompts.length - 1]);
    assert.include(finalPrompt, "Long job complete");
    for (const itemId of PAPERS) {
      assert.include(finalPrompt, `itemId=${itemId}`);
      assert.include(finalPrompt, `Finding ${itemId}`);
    }
    assert.include(finalPrompt, "Results, p. 3");

    // Each page's results are persisted with the transcript, each batch
    // with a handle: they outlive the turn, as after Stop or a restart.
    const stored = await loadAgentTranscriptSegment({
      conversationKey,
      compatibilityKey: PORTABLE_TRANSCRIPT_KEY,
    });
    const records = stored.messages.filter(
      (message) =>
        message.role === "user" &&
        message.retainedTool?.name === "long_job_results",
    );
    assert.isAtLeast(records.length, sized.length - 1);
    const recorded = records.map((message) => promptText([message])).join("\n");
    for (const itemId of PAPERS) {
      assert.include(recorded, `itemId=${itemId}`);
      assert.include(recorded, `Finding ${itemId}`);
    }
    const handles = records.map(
      (message) =>
        (message as { retainedTool?: { handle?: string } }).retainedTool
          ?.handle,
    );
    assert.isTrue(handles.every(Boolean), "every batch keeps a handle");
    // The next question sees each batch inline, or by its handle once the
    // older history is compacted.
    const next = await runTurn({
      conversationKey,
      userText: "Which paper measured drift first?",
      steps: [finalStep("Paper 2001 did.")],
    });
    const history = promptText(next.prompts[0]);
    for (const [index, handle] of handles.entries()) {
      assert.isTrue(
        history.includes(handle!) ||
          history.includes(`for this job, batch ${index + 1} `),
        `batch ${index + 1}`,
      );
    }
  });

  /**
   * A job whose page 1 the budget compacts mid-page. The model declares the
   * part beside an outline of a paper outside the job (`outsideSections`
   * long: page 1 starts from a larger prompt), outlines page 1's paper
   * (`pageSections` long: the prompt passes the budget before the paper
   * settles, so the next request compacts it), then reads each page the
   * host names. A read takes no more than the page share the host set.
   */
  async function compactedMidPage(params: {
    outsideSections: number;
    pageSections: number;
    textOf?: (itemId: number) => string;
  }): Promise<Turn> {
    const OUTSIDE = 9001;
    const paperOf = (itemId: number) => ({
      itemId,
      contextItemId: itemId + 1000,
      libraryID: 1,
    });
    const outlineOf = (itemId: number, sections: number) => ({
      mode: "outline",
      papers: [
        {
          paperContext: paperOf(itemId),
          outline: {
            sections: Array.from({ length: sections }, (_, index) => ({
              title: `Section ${index + 1} of paper ${itemId}: a long heading on representational drift`,
            })),
          },
        },
      ],
    });
    scriptedPaperRead = (input, context) => {
      const itemId = Number((input.target as { itemId?: number })?.itemId);
      if (input.mode === "outline")
        return outlineOf(
          itemId,
          itemId === OUTSIDE ? params.outsideSections : params.pageSections,
        );
      const share = context.request.runtimeContextBudget?.maxTokensPerPaper;
      const text = (params.textOf || paperText)(itemId);
      return {
        mode: "targeted",
        results: [],
        papers: [
          {
            paperContext: paperOf(itemId),
            passages: [
              {
                text: share ? text.slice(0, share * 4) : text,
                sectionLabel: "Results",
                pageLabel: "3",
              },
            ],
          },
        ],
      };
    };
    const outline = (id: string, itemId: number): AgentToolCall => ({
      id,
      name: "paper_read",
      arguments: { target: paperOf(itemId), mode: "outline" },
    });
    let declared = false;
    let outlined = false;
    const asked = new Set<number>();
    const model: ScriptStep = (messages) => {
      if (!declared) {
        declared = true;
        return stepOf(
          declare("declare-1", [
            {
              taskId: "read-all",
              description: READ_ALL,
              expectedEffect: "read",
              scope: true,
            },
          ]),
          outline("outline-outside", OUTSIDE),
        );
      }
      const host = [...messages]
        .reverse()
        .map((message) => promptText([message]))
        .find((text) => text.startsWith("Long job"));
      if (!host || host.startsWith("Long job complete"))
        return finalStep("Every paper is summarized from its results.");
      const page = [...host.matchAll(/^- itemId=(\d+)/gm)]
        .map((match) => Number(match[1]))
        .filter((itemId) => !asked.has(itemId));
      if (!outlined) {
        outlined = true;
        return stepOf(outline("outline-page", page[0]));
      }
      const batch = page.slice(0, 8);
      for (const itemId of batch) asked.add(itemId);
      return stepOf(
        ...batch.map((itemId) => ({
          id: `read-${itemId}`,
          name: "paper_read",
          arguments: { target: paperOf(itemId) },
        })),
      );
    };
    const turn = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift and summarize each",
      scope: {
        wholeLibrary: false,
        itemIds: PAPERS,
        withText: PAPERS.length,
        papers: Object.fromEntries(
          PAPERS.map((itemId) => [
            itemId,
            { title: `Paper ${itemId}`, text: "pdf" as const },
          ]),
        ),
      },
      attached: {
        selectedCollectionContexts: [
          { collectionId: 9, name: "Drift", libraryID: 1 },
        ],
        advanced: { inputTokenCap: 30_000 },
      },
      steps: Array.from({ length: 60 }, () => model),
    });
    assert.equal(turn.outcome?.kind, "completed", String(turn.error || ""));
    assert.lengthOf(outcome(settled(turn), "read-all").doneTargets!, 30);
    // The budget compacted the prompt while page 1 was open.
    const events = turn.events.flatMap((event) =>
      event.type === "provider_event" ? [event] : [],
    );
    const pageAt = (number: number) =>
      events.findIndex(
        (event) =>
          event.providerType === "agent_long_job_page" &&
          event.payload?.page === number,
      );
    const compactedAt = events.findIndex(
      (event) =>
        event.providerType === "agent_context_budget" &&
        event.payload?.action === "compacted_model_prompt",
    );
    assert.isAbove(compactedAt, pageAt(1));
    assert.isBelow(compactedAt, pageAt(2));
    return turn;
  }

  it("measures a page again from a prompt the budget compacted under it: later reads get a real share, and no paper's digest is empty", async function () {
    const turn = await compactedMidPage({
      outsideSections: 400,
      pageSections: 500,
    });
    const sized = pageEvents(turn).filter(
      (page) => typeof page.page === "number",
    );
    // The request after the compaction (the third) starts far under page 1.
    assert.isBelow(
      estimatePrompt(turn.prompts[2]) + 2_000,
      sized[0].promptTokens as number,
    );
    // Every later page is priced and read at what reading a paper costs
    // (each paper's text is some 1,000 tokens or more), not at the one
    // token a prompt measured under its start would leave.
    assert.isAtLeast(sized.length, 3, JSON.stringify(sized));
    for (const page of sized.slice(1)) {
      assert.isTrue(page.measured, JSON.stringify(page));
      assert.isAtLeast(
        page.costPerPaper as number,
        1_000,
        JSON.stringify(page),
      );
      assert.isAtLeast(page.readShare as number, 1_000, JSON.stringify(page));
      assert.isAtLeast(
        page.digestShare as number,
        Math.min(
          PAPER_RECORD_PRIOR_TOKENS,
          Math.floor(
            ((page.budgetTokens as number) - (page.promptTokens as number)) /
              (2 * 30),
          ),
        ),
        JSON.stringify(page),
      );
    }
    // Every paper's digest keeps its finding.
    const finalPrompt = promptText(turn.prompts[turn.prompts.length - 1]);
    assert.include(finalPrompt, "Long job complete");
    for (const itemId of PAPERS)
      assert.include(finalPrompt, `Finding ${itemId}:`, `paper ${itemId}`);
  });

  it("measures a page's papers from the prompt a compaction left, even once their reads take it back past where the page started", async function () {
    // Page 1's one paper reads some 7,000 tokens, more than the compaction
    // took the prompt under page 1's start.
    const turn = await compactedMidPage({
      outsideSections: 150,
      pageSections: 800,
      textOf: (itemId) =>
        itemId === PAPERS[0]
          ? `Finding ${itemId}: drift was measured in this paper. ${"Representational drift details. ".repeat(1_000)}`
          : paperText(itemId),
    });
    const [first, second] = pageEvents(turn).filter(
      (page) => typeof page.page === "number",
    );
    // The request after the compaction (the third) starts under page 1's
    // prompt, and the paper's read takes it back past it.
    const compacted = estimatePrompt(turn.prompts[2]);
    assert.isBelow(compacted, first.promptTokens as number);
    assert.isAbove(
      compacted + (second.costPerPaper as number),
      first.promptTokens as number,
    );
    // Page 2 is priced at what the paper cost from the compacted prompt: at
    // least its read, which filled page 1's share, not that read less what
    // the compaction took under page 1's start.
    assert.include(second, { page: 2, measured: true });
    assert.isAtLeast(
      second.costPerPaper as number,
      first.readShare as number,
      JSON.stringify(second),
    );
  });

  it("leaves a job that fits one pass to the model, with no host page", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Read these papers",
      scope: {
        wholeLibrary: false,
        itemIds: PAPERS.slice(0, 2),
        withText: 2,
      },
      steps: [
        stepOf(
          declare("declare-1", [
            {
              taskId: "read-all",
              description: READ_ALL,
              expectedEffect: "read",
              scope: true,
            },
          ]),
          ...PAPERS.slice(0, 2).map((itemId) => ({
            id: `read-${itemId}`,
            name: "paper_read",
            arguments: {
              target: { itemId, contextItemId: itemId + 1000, libraryID: 1 },
            },
          })),
        ),
        finalStep("Both papers are read."),
      ],
    });
    assert.deepEqual(pageEvents(turn), []);
    assert.notInclude(promptText(turn.prompts[1]), "Long job");
    assert.deepEqual(settled(turn).end, { state: "completed" });
  });

  describe("how deep a job reads, from each part's declared effect", function () {
    const SORT = "File each paper into its topic folder";
    const TAG = "Tag each paper by its method";
    const NOTE = "Save a note on each paper";

    /** A library chat over `count` papers, each with a PDF. */
    function library(count: number): TaskPaperScopeSet {
      const ids = Array.from({ length: count }, (_, index) => 3001 + index);
      return {
        wholeLibrary: true,
        itemIds: ids,
        withText: ids.length,
        papers: Object.fromEntries(
          ids.map((itemId) => [
            itemId,
            { title: `Paper ${itemId}`, text: "pdf" as const },
          ]),
        ),
      };
    }

    /** The long job's host messages the turn sent, each once. */
    const hostMessages = (turn: Turn) => [
      ...new Set(
        turn.prompts.flatMap((messages) =>
          messages
            .map((message) => promptText([message]))
            .filter((text) => text.startsWith("Long job")),
        ),
      ),
    ];

    const firstPage = (turn: Turn) =>
      pageEvents(turn).find((page) => typeof page.page === "number");

    /**
     * A model that changes papers: it declares one part over the scope, then
     * makes each page's change in one library_update call, whose receipt
     * names the page's papers.
     */
    function changeModel(part: {
      taskId: string;
      description: string;
      capability: "zotero.collections" | "zotero.tags";
      operation: "move_to_collection" | "apply_tags";
    }): ScriptStep {
      const changed = new Set<number>();
      let declared = false;
      return (messages: AgentModelMessage[]) => {
        if (!declared) {
          declared = true;
          return stepOf(
            declare("declare-1", [
              {
                taskId: part.taskId,
                description: part.description,
                expectedEffect: "mutation",
                expectedCapability: part.capability,
                scope: true,
              },
            ]),
          );
        }
        const host = [...messages]
          .reverse()
          .map((message) => promptText([message]))
          .find((text) => text.startsWith("Long job"));
        if (!host || host.startsWith("Long job complete"))
          return finalStep("Every paper is changed as asked.");
        const page = [...host.matchAll(/^- itemId=(\d+)/gm)]
          .map((match) => Number(match[1]))
          .filter((itemId) => !changed.has(itemId));
        for (const itemId of page) changed.add(itemId);
        const targets = page.map((itemId) => `item:${itemId}`);
        liveReceipts.push({
          version: 2,
          id: `${part.operation}:${changed.size}`,
          proposalId: `${part.operation}:0`,
          proofDomain: "zotero_state",
          capability: part.capability,
          operation: part.operation,
          verification: "verified",
          status: "applied",
          requestedTargets: targets,
          appliedTargets: targets,
          alreadySatisfiedTargets: [],
          rejectedTargets: [],
          reasons: [],
          verifiedFacts: [],
        });
        return stepOf({
          id: `${part.taskId}-${changed.size}`,
          name: "library_update",
          arguments: { assignments: page.map((itemId) => ({ itemId })) },
        });
      };
    }

    /** The model declares parts over the scope, then answers at once. */
    const declaredOnly = (parts: Record<string, unknown>[]): ScriptStep[] => [
      stepOf(declare("declare-1", parts)),
      ...Array.from({ length: 4 }, () =>
        finalStep("I stopped before the papers."),
      ),
    ];

    it("sorts sixty papers into folders, then tags the same sixty, from their metadata: priced at their records, never told to read", async function () {
      liveReceipts = [];
      try {
        const scope = library(60);
        const sorting = changeModel({
          taskId: "sort",
          description: SORT,
          capability: "zotero.collections",
          operation: "move_to_collection",
        });
        const sorted = await runTurn({
          conversationKey,
          userText: "Sort my library into topic folders",
          scope,
          attached: { advanced: { inputTokenCap: 30_000 } as never },
          steps: Array.from({ length: 30 }, () => sorting),
        });
        const tagging = changeModel({
          taskId: "tag",
          description: TAG,
          capability: "zotero.tags",
          operation: "apply_tags",
        });
        const tagged = await runTurn({
          conversationKey,
          userText: "Now tag each of them by its method",
          scope,
          attached: { advanced: { inputTokenCap: 30_000 } as never },
          steps: Array.from({ length: 30 }, () => tagging),
        });
        for (const [turn, taskId, description] of [
          [sorted, "sort", SORT],
          [tagged, "tag", TAG],
        ] as const) {
          assert.equal(
            turn.outcome?.kind,
            "completed",
            String(turn.error || ""),
          );
          const part = outcome(settled(turn), taskId);
          assert.equal(part.status, "completed");
          assert.lengthOf(part.doneTargets!, 60);
          assert.deepEqual(settled(turn).end, { state: "completed" });
          // Paged at what a paper's record costs, not its text.
          assert.include(firstPage(turn), {
            page: 1,
            left: 60,
            measured: false,
            costPerPaper: 600,
          });
          const pages = hostMessages(turn).filter((text) =>
            text.includes("in this order:"),
          );
          assert.isAtLeast(pages.length, 2, JSON.stringify(pageEvents(turn)));
          for (const text of pages) {
            assert.include(
              text,
              `Make the change “${description}” for these papers now`,
            );
            assert.include(text, "library_search with include:['abstract']");
          }
          for (const text of hostMessages(turn)) {
            assert.notInclude(text, "paper_read");
            assert.notMatch(text, /\bread\b/i, text);
          }
        }
        assert.include(
          promptText(sorted.prompts[0]),
          "\nPaper scope: whole library — 60 papers, 60 with full text\n",
        );
      } finally {
        liveReceipts = [];
      }
    });

    it("reads for a note on each of fifty papers: priced at their text and told to read", async function () {
      const turn = await runTurn({
        conversationKey,
        userText: "Read each of these papers and save a note on each",
        scope: library(50),
        attached: { advanced: { inputTokenCap: 30_000 } as never },
        steps: declaredOnly([
          {
            taskId: "note-all",
            description: NOTE,
            expectedEffect: "mutation",
            expectedCapability: "zotero.notes",
            scope: true,
          },
        ]),
      });
      assert.include(firstPage(turn), {
        page: 1,
        left: 50,
        measured: false,
        costPerPaper: 12_000,
      });
      const [page] = hostMessages(turn);
      assert.include(page, "Read them with paper_read mode:'overview'");
      assert.include(page, "use mode:'full' only if the user asked");
      assert.include(page, `Then make the change “${NOTE}” for each of them.`);
    });

    it("prices a mixed job, reading each paper and tagging it by its method, as reading", async function () {
      const turn = await runTurn({
        conversationKey,
        userText: "Read each paper in Drift and tag it by its method",
        // A read part covers the scope only when the user attached it.
        scope: { ...library(60), wholeLibrary: false },
        attached: {
          advanced: { inputTokenCap: 30_000 } as never,
          selectedCollectionContexts: [
            { collectionId: 9, name: "Drift", libraryID: 1 },
          ],
        },
        steps: declaredOnly([
          {
            taskId: "read-all",
            description: READ_ALL,
            expectedEffect: "read",
            scope: true,
          },
          {
            taskId: "tag",
            description: TAG,
            expectedEffect: "mutation",
            expectedCapability: "zotero.tags",
            scope: true,
          },
        ]),
      });
      assert.include(firstPage(turn), {
        page: 1,
        left: 60,
        measured: false,
        costPerPaper: 12_000,
      });
      const [page] = hostMessages(turn);
      assert.include(page, "Read them with paper_read mode:'overview'");
      assert.include(page, `Then make the change “${TAG}” for each of them.`);
      assert.notInclude(page, "library_search");
    });
  });
});

describe("resuming a long job in runtime turns", function () {
  let environment: DirectJourneyEnvironment;
  let conversationKey = 999_000;
  const PAPERS = Array.from({ length: 30 }, (_, index) => 5001 + index);
  const READ_ALL = "Read each paper in Drift";
  const scope: TaskPaperScopeSet = {
    wholeLibrary: false,
    itemIds: PAPERS,
    withText: PAPERS.length,
    papers: Object.fromEntries(
      PAPERS.map((itemId) => [
        itemId,
        { title: `Paper ${itemId}`, text: "pdf" as const },
      ]),
    ),
  };
  const attached = {
    selectedCollectionContexts: [
      { collectionId: 9, name: "Drift", libraryID: 1 },
    ],
    advanced: { inputTokenCap: 30_000 },
  } as Partial<AgentRuntimeRequestInput>;

  beforeEach(async function () {
    environment = await installDirectJourneyEnvironment();
    libraryUpdateReceipt = undefined;
    conversationKey += 10;
    scriptedPaperRead = (input) => {
      const itemId = Number((input.target as { itemId?: number })?.itemId);
      return {
        mode: "targeted",
        results: [],
        papers: [
          {
            paperContext: {
              itemId,
              contextItemId: itemId + 1000,
              libraryID: 1,
            },
            passages: [
              {
                text: `Finding ${itemId}: drift was measured in this paper. ${"Representational drift details. ".repeat(120)}`,
                sectionLabel: "Results",
                pageLabel: "3",
              },
            ],
          },
        ],
      };
    };
  });

  afterEach(function () {
    environment.restore();
    scriptedPaperRead = undefined;
  });

  /** The latest message the host sent about the job, if any. */
  const hostText = (messages: AgentModelMessage[]) =>
    [...messages]
      .reverse()
      .map((message) => promptText([message]))
      .find((text) => text.startsWith("Long job"));

  const pageOf = (host: string) =>
    [...host.matchAll(/^- itemId=(\d+)/gm)].map((match) => Number(match[1]));

  let calls = 0;
  const readCall = (itemId: number): AgentToolCall => ({
    id: `read-${itemId}-${(calls += 1)}`,
    name: "paper_read",
    arguments: {
      target: { itemId, contextItemId: itemId + 1000, libraryID: 1 },
    },
  });

  it("goes on after Stop from the first paper not settled, and its last step sees every paper's results", async function () {
    // The first turn reads each page the host names, and the user stops it
    // after a dozen papers.
    const controller = new AbortController();
    const asked = new Set<number>();
    let declared = false;
    const reader = (messages: AgentModelMessage[]) => {
      if (!declared) {
        declared = true;
        return stepOf(
          declare("declare-1", [
            {
              taskId: "read-all",
              description: READ_ALL,
              expectedEffect: "read",
              scope: true,
            },
          ]),
        );
      }
      if (asked.size >= 12) {
        controller.abort();
        throw new Error("The request was aborted.");
      }
      const host = hostText(messages);
      const page = (host ? pageOf(host) : [])
        .filter((itemId) => !asked.has(itemId))
        .slice(0, 8);
      for (const itemId of page) asked.add(itemId);
      return stepOf(...page.map(readCall));
    };
    const stopped = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift and summarize each",
      scope,
      attached,
      signal: controller.signal,
      steps: Array.from({ length: 20 }, () => reader),
    });
    assert.equal(stopStatus(stopped), "cancelled");
    const before = settled(stopped);
    assert.deepEqual(before.end, { state: "cancelled" });
    const doneBefore = outcome(before, "read-all").doneTargets || [];
    assert.isAtLeast(doneBefore.length, 12);
    assert.isBelow(doneBefore.length, 30);
    const left = PAPERS.filter(
      (itemId) => !doneBefore.includes(`item:${itemId}`),
    );

    // "continue": the stopped ledger is picked back up, with the papers
    // left; the model works from the resume note, then from the pages.
    const resumedAsked: number[] = [];
    const resumer = (messages: AgentModelMessage[]) => {
      const host = hostText(messages);
      if (host?.startsWith("Long job complete"))
        return finalStep("Every paper is summarized from its results.");
      const named = host
        ? pageOf(host)
        : (/papers? left, in order: ([\d, ]+)\./
            .exec(promptText(messages))?.[1]
            ?.split(", ")
            .map(Number) ?? []);
      const page = named
        .filter((itemId) => !resumedAsked.includes(itemId))
        .slice(0, 3);
      if (!page.length) return finalStep("Every paper is summarized.");
      resumedAsked.push(...page);
      return stepOf(...page.map(readCall));
    };
    const resumed = await runTurn({
      conversationKey,
      userText: "continue",
      scope,
      attached,
      steps: Array.from({ length: 30 }, () => resumer),
    });
    assert.equal(resumed.outcome?.kind, "completed", String(resumed.error));
    const adopted = resumed.initialCheckpoint;
    assert.exists(adopted, "the stopped ledger was picked back up");
    assert.equal(adopted!.executionId, before.executionId);
    assert.notProperty(adopted!, "end");
    assert.include(
      promptText(resumed.prompts[0]),
      `Long job to resume: “${READ_ALL}” ${doneBefore.length} of 30 done. The ${left.length} papers left, in order: ${left.join(", ")}.`,
    );
    assert.deepEqual(
      [...resumedAsked].sort(),
      [...left].sort(),
      "only the papers left are read, each once",
    );
    assert.equal(resumedAsked[0], left[0], "from the first paper not settled");
    const after = settled(resumed);
    assert.deepEqual(after.end, { state: "completed" });
    assert.lengthOf(outcome(after, "read-all").doneTargets!, 30);
    // The earlier turn's per-paper results carry forward to the last step.
    const last = promptText(resumed.prompts[resumed.prompts.length - 1]);
    assert.include(last, "Long job complete");
    for (const itemId of PAPERS) assert.include(last, `Finding ${itemId}`);
    // Each paper's results are recorded once: a carried paper is not
    // recorded again by the turn that resumed the job.
    const stored = await loadAgentTranscriptSegment({
      conversationKey,
      compatibilityKey: PORTABLE_TRANSCRIPT_KEY,
    });
    const recorded = stored.messages
      .filter(
        (message) =>
          message.role === "user" &&
          message.retainedTool?.name === "long_job_results",
      )
      .flatMap((message) =>
        [...promptText([message]).matchAll(/^itemId=(\d+)/gm)].map((match) =>
          Number(match[1]),
        ),
      );
    assert.deepEqual([...recorded].sort(), [...PAPERS].sort());
  });

  it("records the results of the papers a stopped page had read, so continue need not read them again", async function () {
    const TAG = "Tag each paper by its method";
    const tag = (id: string, papers: number[]) => {
      const targets = papers.map((itemId) => `item:${itemId}`);
      liveReceipts.push({
        version: 2,
        id: `apply_tags:${id}`,
        proposalId: "apply_tags:0",
        proofDomain: "zotero_state",
        capability: "zotero.tags",
        operation: "apply_tags",
        verification: "verified",
        status: "applied",
        requestedTargets: targets,
        appliedTargets: targets,
        alreadySatisfiedTargets: [],
        rejectedTargets: [],
        reasons: [],
        verifiedFacts: [],
      });
      return stepOf({
        id,
        name: "library_update",
        arguments: { assignments: papers.map((itemId) => ({ itemId })) },
      });
    };
    // Each page is read in one step and tagged in the next; the user stops
    // the job right after a page was read, before its papers are tagged.
    const controller = new AbortController();
    const read = new Set<number>();
    const tagged = new Set<number>();
    let declared = false;
    const worker = (messages: AgentModelMessage[]) => {
      if (!declared) {
        declared = true;
        return stepOf(
          declare("declare-1", [
            {
              taskId: "read-all",
              description: READ_ALL,
              expectedEffect: "read",
              scope: true,
            },
            {
              taskId: "tag-all",
              description: TAG,
              expectedEffect: "mutation",
              expectedCapability: "zotero.tags",
              scope: true,
            },
          ]),
        );
      }
      if (tagged.size >= 5 && read.size > tagged.size) {
        controller.abort();
        throw new Error("The request was aborted.");
      }
      const host = hostText(messages);
      const page = host ? pageOf(host) : [];
      const toRead = page.filter((itemId) => !read.has(itemId));
      if (toRead.length) {
        for (const itemId of toRead) read.add(itemId);
        return stepOf(...toRead.map(readCall));
      }
      const toTag = page.filter((itemId) => !tagged.has(itemId));
      for (const itemId of toTag) tagged.add(itemId);
      return toTag.length
        ? tag(`tag-${tagged.size}`, toTag)
        : finalStep("Every paper is tagged.");
    };
    liveReceipts = [];
    try {
      const stopped = await runTurn({
        conversationKey,
        userText: "Read each paper in Drift and tag it by its method",
        scope,
        attached,
        signal: controller.signal,
        steps: Array.from({ length: 40 }, () => worker),
      });
      assert.equal(stopStatus(stopped), "cancelled");
      const unfinished = [...read].filter((itemId) => !tagged.has(itemId));
      assert.isNotEmpty(unfinished, "stopped inside a page");
      // The stopped page's reads were recorded, though the page never ended.
      const stored = await loadAgentTranscriptSegment({
        conversationKey,
        compatibilityKey: PORTABLE_TRANSCRIPT_KEY,
      });
      const records = stored.messages
        .filter(
          (message) =>
            message.role === "user" &&
            message.retainedTool?.name === "long_job_results",
        )
        .map((message) => promptText([message]))
        .join("\n");
      for (const itemId of read)
        assert.include(records, `Finding ${itemId}`, `paper ${itemId}`);

      // "continue": a paper whose results the conversation holds is tagged
      // without being read again.
      const reread: number[] = [];
      const resumedTagged = new Set<number>();
      const resumer = (messages: AgentModelMessage[]) => {
        const host = hostText(messages);
        if (host?.startsWith("Long job complete"))
          return finalStep("Every paper is tagged.");
        const named = host
          ? pageOf(host)
          : (/papers? left, in order: ([\d, ]+)\./
              .exec(promptText(messages))?.[1]
              ?.split(", ")
              .map(Number) ?? []);
        const known = promptText(messages);
        const page = named.filter((itemId) => !resumedTagged.has(itemId));
        const toRead = page
          .filter(
            (itemId) =>
              !known.includes(`Finding ${itemId}`) && !reread.includes(itemId),
          )
          .slice(0, 3);
        if (toRead.length) {
          reread.push(...toRead);
          return stepOf(...toRead.map(readCall));
        }
        const toTag = page.slice(0, 3);
        for (const itemId of toTag) resumedTagged.add(itemId);
        return toTag.length
          ? tag(`resumed-tag-${resumedTagged.size}`, toTag)
          : finalStep("Every paper is tagged.");
      };
      const resumed = await runTurn({
        conversationKey,
        userText: "continue",
        scope,
        attached,
        steps: Array.from({ length: 60 }, () => resumer),
      });
      assert.equal(resumed.outcome?.kind, "completed", String(resumed.error));
      for (const itemId of unfinished)
        assert.notInclude(reread, itemId, `paper ${itemId} was read before`);
      const after = settled(resumed);
      assert.deepEqual(after.end, { state: "completed" });
      assert.lengthOf(outcome(after, "tag-all").doneTargets!, 30);
      const last = promptText(resumed.prompts[resumed.prompts.length - 1]);
      for (const itemId of PAPERS) assert.include(last, `Finding ${itemId}`);
    } finally {
      liveReceipts = [];
    }
  });

  it("resumes a job after Zotero quit twice, the second time before the resumed run recorded anything, with every paper's results", async function () {
    // Run A reads pages of the job; Zotero quits after a dozen papers.
    const asked = new Set<number>();
    let declared = false;
    const reader = (messages: AgentModelMessage[]) => {
      if (!declared) {
        declared = true;
        return stepOf(
          declare("declare-1", [
            {
              taskId: "read-all",
              description: READ_ALL,
              expectedEffect: "read",
              scope: true,
            },
          ]),
        );
      }
      if (asked.size >= 12) return ZOTERO_QUITS;
      const host = hostText(messages);
      const page = (host ? pageOf(host) : [])
        .filter((itemId) => !asked.has(itemId))
        .slice(0, 8);
      for (const itemId of page) asked.add(itemId);
      return stepOf(...page.map(readCall));
    };
    const first = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift and summarize each",
      scope,
      attached,
      steps: Array.from({ length: 20 }, () => reader),
    });
    assert.isTrue(first.quit, String(first.error || ""));
    const left = checkpoints(first).at(-1)!;
    assert.notProperty(left, "end", "a quit settles nothing");
    const doneBefore = outcome(left, "read-all").doneTargets || [];
    assert.isAtLeast(doneBefore.length, 12);
    await restartZotero();

    // Run B picks the job back up, and Zotero quits again before B's first
    // request returns: B has recorded nothing of its own.
    const second = await runTurn({
      conversationKey,
      userText: "continue",
      scope,
      attached,
      steps: [ZOTERO_QUITS],
    });
    assert.isTrue(second.quit, String(second.error || ""));
    assert.equal(second.initialCheckpoint?.executionId, left.executionId);
    // B published the ledger it resumed, whole, once.
    const published = second.events.filter(
      (event) =>
        event.type === "execution_checkpoint" ||
        event.type === "execution_checkpoint_delta",
    );
    assert.lengthOf(published, 1);
    assert.equal(published[0].type, "execution_checkpoint");
    assert.equal(checkpoints(second)[0].executionId, left.executionId);
    assert.deepEqual(
      outcome(checkpoints(second)[0], "read-all").doneTargets,
      doneBefore,
    );
    await restartZotero();

    // "continue" once more: A's job, from the first paper not settled.
    const leftPapers = PAPERS.filter(
      (itemId) => !doneBefore.includes(`item:${itemId}`),
    );
    const resumedAsked: number[] = [];
    const resumer = (messages: AgentModelMessage[]) => {
      const host = hostText(messages);
      if (host?.startsWith("Long job complete"))
        return finalStep("Every paper is summarized from its results.");
      const named = host
        ? pageOf(host)
        : (/papers? left, in order: ([\d, ]+)\./
            .exec(promptText(messages))?.[1]
            ?.split(", ")
            .map(Number) ?? []);
      const page = named
        .filter((itemId) => !resumedAsked.includes(itemId))
        .slice(0, 3);
      if (!page.length) return finalStep("Every paper is summarized.");
      resumedAsked.push(...page);
      return stepOf(...page.map(readCall));
    };
    const third = await runTurn({
      conversationKey,
      userText: "continue",
      scope,
      attached,
      steps: Array.from({ length: 30 }, () => resumer),
    });
    assert.equal(third.outcome?.kind, "completed", String(third.error || ""));
    assert.equal(third.initialCheckpoint?.executionId, left.executionId);
    assert.include(
      promptText(third.prompts[0]),
      `Long job to resume: “${READ_ALL}” ${doneBefore.length} of 30 done. The ${leftPapers.length} papers left, in order: ${leftPapers.join(", ")}.`,
    );
    assert.deepEqual(
      [...resumedAsked].sort(),
      [...leftPapers].sort(),
      "only the papers left are read, each once",
    );
    const after = settled(third);
    assert.deepEqual(after.end, { state: "completed" });
    assert.lengthOf(outcome(after, "read-all").doneTargets!, 30);
    // Run A's per-paper results carry forward to the last step.
    const last = promptText(third.prompts[third.prompts.length - 1]);
    assert.include(last, "Long job complete");
    for (const itemId of PAPERS) assert.include(last, `Finding ${itemId}`);
  });

  describe("Stop with a question queued behind it", function () {
    const QUESTION = "What is representational drift?";
    const ANSWER = "A gradual change in a neural representation.";

    /** What the conversation's transcript holds now. */
    const storedTranscript = async () =>
      promptText(
        (
          await loadAgentTranscriptSegment({
            conversationKey,
            compatibilityKey: PORTABLE_TRANSCRIPT_KEY,
          })
        ).messages,
      );

    /**
     * A job the user stops while one of its reads is running, with a
     * question queued behind it. Stop releases the conversation at once, so
     * the question runs, and writes its request into the transcript, while
     * the stopped run still finishes that read and records its open page;
     * `order` says which of the two ends first. With `readAfter`, another
     * read follows the running one in its
     * step, so Stop keeps the step from finishing; with `endsPage`, the
     * running read is the last its page had. `read` names the papers whose
     * reads came back into the run, and `afterStop` the transcript as the
     * stopped run left it.
     */
    async function stopWithQueuedQuestion(params: {
      order: "question first" | "stopped run first";
      readAfter?: boolean;
      endsPage?: boolean;
    }): Promise<{
      stopped: Turn;
      question: Turn;
      read: number[];
      running: number;
      afterStop: string;
    }> {
      const reading = deferred();
      const finishRead = deferred();
      let running: number | undefined;
      let following: number | undefined;
      const read = scriptedPaperRead!;
      scriptedPaperRead = async (input, context) => {
        const itemId = Number((input.target as { itemId?: number })?.itemId);
        if (itemId === running) {
          reading.resolve();
          await finishRead.promise;
        }
        return read(input, context);
      };
      // The job reads its first pages, then a paper of the next page alone
      // (with `endsPage`, every paper of it but the last), then the paper
      // that is running when the user stops it.
      const controller = new AbortController();
      const asked: number[] = [];
      let declared = false;
      let alone = 0;
      const worker = (messages: AgentModelMessage[]) => {
        if (!declared) {
          declared = true;
          return stepOf(
            declare("declare-1", [
              {
                taskId: "read-all",
                description: READ_ALL,
                expectedEffect: "read",
                scope: true,
              },
            ]),
          );
        }
        const host = hostText(messages);
        const page = (host ? pageOf(host) : []).filter(
          (itemId) => !asked.includes(itemId),
        );
        if (asked.length < 6 || (params.endsPage && page.length > 1)) {
          const batch = page.slice(0, asked.length < 6 ? 8 : -1);
          asked.push(...batch);
          return stepOf(...batch.map(readCall));
        }
        const [next, after] = page;
        asked.push(next);
        if (!params.endsPage && alone++ === 0) return stepOf(readCall(next));
        running = next;
        if (!params.readAfter) return stepOf(readCall(next));
        following = after;
        asked.push(after);
        return stepOf(readCall(next), readCall(after));
      };
      const stoppedRun = runTurn({
        conversationKey,
        userText: "Read every paper in Drift and summarize each",
        scope,
        attached,
        signal: controller.signal,
        steps: Array.from({ length: 20 }, () => worker),
      });
      await reading.promise;
      controller.abort();
      const asking = deferred();
      const answering = deferred();
      const questionRun = runTurn({
        conversationKey,
        userText: QUESTION,
        scope,
        attached,
        // A turn waits for the stopped turn before it to settle
        // (continueAfterStop.test.ts); these cases are the ones that wait
        // does not cover, where its bound has run out and both turns write.
        stoppedRunWaitMs: 0,
        steps: [
          async () => {
            asking.resolve();
            if (params.order === "stopped run first") await answering.promise;
            return finalStep(ANSWER);
          },
        ],
      });
      let question: Turn | undefined;
      if (params.order === "question first") question = await questionRun;
      else await asking.promise;
      finishRead.resolve();
      const stopped = await stoppedRun;
      const afterStop = await storedTranscript();
      answering.resolve();
      question ??= await questionRun;
      // The stopped run ends as the user stopped it, whatever the question
      // wrote meanwhile.
      assert.equal(stopStatus(stopped), "cancelled");
      assert.equal(stopped.outcome?.kind, "cancelled", String(stopped.error));
      assert.equal(question.outcome?.kind, "completed");
      return {
        stopped,
        question,
        afterStop,
        running: running!,
        // Stop keeps the read after the running one from starting, and the
        // step from taking the running one's result.
        read: params.readAfter
          ? asked.filter((itemId) => itemId !== running && itemId !== following)
          : asked,
      };
    }

    /** The papers whose results the job's records hold, by its ledger. */
    const recordedResults = async (stopped: Turn) => {
      const executionId = settled(stopped).executionId;
      const records = await listAgentToolResultHandles({
        conversationKey,
        toolName: "long_job_results",
      });
      return records.flatMap((record) => {
        const content = record.content as {
          executionId?: string;
          digests?: Array<{ itemId: number; excerpts: { text: string }[] }>;
        };
        return content.executionId === executionId
          ? (content.digests || []).filter((digest) =>
              digest.excerpts.some((excerpt) =>
                excerpt.text.startsWith(`Finding ${digest.itemId}:`),
              ),
            )
          : [];
      });
    };

    for (const readAfter of [false, true])
      it(`keeps the question's messages when the question ends before the stopped run${
        readAfter ? ", the running read followed by another" : ""
      }, and the stopped page's results`, async function () {
        const { stopped, read } = await stopWithQueuedQuestion({
          order: "question first",
          readAfter,
        });
        const transcript = await storedTranscript();
        assert.include(transcript, QUESTION);
        assert.include(transcript, ANSWER);
        const recorded = (await recordedResults(stopped)).map(
          (digest) => digest.itemId,
        );
        for (const itemId of read)
          assert.include(recorded, itemId, `paper ${itemId}`);
      });

    it("ends a run stopped during the read that ends its page as stopped, planning no page, and keeps the question's messages and the page's results", async function () {
      const { stopped, read, running } = await stopWithQueuedQuestion({
        order: "question first",
        endsPage: true,
      });
      const ranAt = stopped.events.findIndex(
        (event) =>
          event.type === "tool_result" &&
          event.callId.startsWith(`read-${running}-`),
      );
      assert.isAbove(ranAt, 0);
      assert.isEmpty(
        stopped.events
          .slice(ranAt)
          .filter(
            (event) =>
              event.type === "provider_event" &&
              event.providerType === "agent_long_job_page",
          ),
      );
      const transcript = await storedTranscript();
      assert.include(transcript, QUESTION);
      assert.include(transcript, ANSWER);
      const recorded = (await recordedResults(stopped)).map(
        (digest) => digest.itemId,
      );
      for (const itemId of read)
        assert.include(recorded, itemId, `paper ${itemId}`);
    });

    it("keeps the question's messages when the stopped run ends while the question is still running, and the stopped page's results", async function () {
      const { stopped, read, afterStop } = await stopWithQueuedQuestion({
        order: "stopped run first",
      });
      assert.include(
        afterStop,
        QUESTION,
        "the stopped run left the question's request where it was written",
      );
      const transcript = await storedTranscript();
      assert.include(transcript, QUESTION);
      assert.include(transcript, ANSWER);
      const recorded = (await recordedResults(stopped)).map(
        (digest) => digest.itemId,
      );
      for (const itemId of read)
        assert.include(recorded, itemId, `paper ${itemId}`);
    });
  });

  it("carries a stopped job's per-paper results on continue from where they are stored, though the transcript lost their records", async function () {
    const controller = new AbortController();
    const asked = new Set<number>();
    let declared = false;
    const reader = (messages: AgentModelMessage[]) => {
      if (!declared) {
        declared = true;
        return stepOf(
          declare("declare-1", [
            {
              taskId: "read-all",
              description: READ_ALL,
              expectedEffect: "read",
              scope: true,
            },
          ]),
        );
      }
      if (asked.size >= 12) {
        controller.abort();
        throw new Error("The request was aborted.");
      }
      const host = hostText(messages);
      const page = (host ? pageOf(host) : [])
        .filter((itemId) => !asked.has(itemId))
        .slice(0, 8);
      for (const itemId of page) asked.add(itemId);
      return stepOf(...page.map(readCall));
    };
    const stopped = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift and summarize each",
      scope,
      attached,
      signal: controller.signal,
      steps: Array.from({ length: 20 }, () => reader),
    });
    assert.equal(stopStatus(stopped), "cancelled");
    // A write that dropped the job's records from the transcript.
    const stored = await loadAgentTranscriptSegment({
      conversationKey,
      compatibilityKey: PORTABLE_TRANSCRIPT_KEY,
    });
    const kept = stored.messages.filter(
      (message) =>
        !(
          message.role === "user" &&
          message.retainedTool?.name === "long_job_results"
        ),
    );
    assert.isBelow(kept.length, stored.messages.length);
    await replaceAgentTranscriptSegment({ ...stored, messages: kept });
    // "continue": every paper's results reach the job's last step.
    const resumedAsked: number[] = [];
    const resumer = (messages: AgentModelMessage[]) => {
      const host = hostText(messages);
      if (host?.startsWith("Long job complete"))
        return finalStep("Every paper is summarized from its results.");
      const named = host
        ? pageOf(host)
        : (/papers? left, in order: ([\d, ]+)\./
            .exec(promptText(messages))?.[1]
            ?.split(", ")
            .map(Number) ?? []);
      const page = named
        .filter((itemId) => !resumedAsked.includes(itemId))
        .slice(0, 3);
      if (!page.length) return finalStep("Every paper is summarized.");
      resumedAsked.push(...page);
      return stepOf(...page.map(readCall));
    };
    const resumed = await runTurn({
      conversationKey,
      userText: "continue",
      scope,
      attached,
      steps: Array.from({ length: 30 }, () => resumer),
    });
    assert.equal(resumed.outcome?.kind, "completed", String(resumed.error));
    for (const itemId of asked)
      assert.notInclude(resumedAsked, itemId, `paper ${itemId} was read`);
    const last = promptText(resumed.prompts[resumed.prompts.length - 1]);
    assert.include(last, "Long job complete");
    for (const itemId of PAPERS) assert.include(last, `Finding ${itemId}`);
  });

  it("runs any other message after Stop as an ordinary turn, with no ledger", async function () {
    const controller = new AbortController();
    const stopped = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift and summarize each",
      scope,
      attached,
      signal: controller.signal,
      steps: [
        stepOf(
          declare("declare-1", [
            {
              taskId: "read-all",
              description: READ_ALL,
              expectedEffect: "read",
              scope: true,
            },
          ]),
          readCall(PAPERS[0]),
        ),
        () => {
          controller.abort();
          throw new Error("The request was aborted.");
        },
      ],
    });
    assert.deepEqual(settled(stopped).end, { state: "cancelled" });
    const question = await runTurn({
      conversationKey,
      userText: "What is representational drift?",
      scope,
      attached,
      steps: [finalStep("A gradual change in a neural representation.")],
    });
    assert.isUndefined(question.initialCheckpoint);
    assert.notInclude(promptText(question.prompts[0]), "Long job to resume");
    assert.isEmpty(checkpoints(question));
    assert.equal(question.requests, 1);
  });

  it("skips a note on a paper the job already wrote, with a note to the model, and writes none twice", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Summarize this paper and save it as a note",
      steps: [
        stepOf(declare("declare-1", [saveDeclaration]), noteWrite("note-1")),
        // A model that starts its page over writes the paper's note again,
        // in other words: a second note, were it run.
        stepOf({
          id: "note-2",
          name: "note_write",
          arguments: {
            mode: "create",
            content: "# Summary\n\nThe paper, summarized once more.",
            targetItemId: PARENT_ITEM_ID,
          },
        }),
        finalStep("Saved the summary as a note."),
      ],
    });
    assert.equal(turn.outcome?.kind, "completed", String(turn.error || ""));
    assert.equal(environment.library.nativeSaves(), 1, "one note was written");
    assert.lengthOf(receiptIdsOf(turn, "note_write"), 1);
    const second = turn.events.find(
      (event) => event.type === "tool_result" && event.callId === "note-2",
    );
    assert.exists(second);
    if (second?.type === "tool_result") {
      assert.isTrue(second.ok);
      assert.equal(second.effect, "none");
      assert.include(
        JSON.stringify(second.content),
        `Skipped by the host: item ${PARENT_ITEM_ID} already has the note`,
      );
    }
    assert.lengthOf(
      turn.events.filter((event) => event.type === "confirmation_required"),
      1,
      "the skipped write asked for no review",
    );
    const ledger = settled(turn);
    assert.equal(outcome(ledger, "save").status, "completed");
    assert.deepEqual(ledger.end, { state: "completed" });
  });
});

describe("a note batch over papers a job already wrote", function () {
  let environment: BatchJourneyEnvironment;
  let conversationKey = 999_500;

  beforeEach(async function () {
    environment = await installBatchJourneyEnvironment();
    conversationKey += 10;
  });

  afterEach(function () {
    environment.restore();
  });

  const batchOf = (id: string, ...papers: number[]): AgentModelStep =>
    toolCallStep(id, "note_write_batch", {
      notes: papers.map((paper) => ({
        targetItemId: paper,
        content: `# Paper ${paper}\n\nSummary of paper ${paper}.`,
      })),
    });

  it("is refused while it names one, and the batch sent again without it writes the rest, each paper once", async function () {
    const registry = createBatchJourneyRegistry(environment.library);
    registry.register(createTaskUpdateTool());
    const turn = await runJourneyTurn({
      registry,
      conversationKey,
      userText: "Save a summary note on each of these three papers",
      sourceMessageTimestamp: conversationKey,
      steps: [
        stepOf(
          declare("declare-1", [
            {
              taskId: "note-all",
              description: "Save a note on each paper",
              expectedEffect: "mutation",
              expectedCapability: "zotero.notes",
              targetIds: PAPER_IDS.map(String),
            },
          ]),
        ),
        batchOf("batch-1", 1, 2),
        // Paper 2 again, beside paper 3.
        batchOf("batch-2", 2, 3),
        batchOf("batch-3", 3),
        finalStep("A note is saved on each paper."),
      ],
    });
    assert.equal(turn.outcome?.kind, "completed");
    assert.equal(environment.library.nativeSaves(), 3, "one note a paper");
    const refused = turn.events.find(
      (event) => event.type === "tool_result" && event.callId === "batch-2",
    );
    assert.exists(refused);
    if (refused?.type === "tool_result") {
      assert.isFalse(refused.ok);
      assert.include(
        JSON.stringify(refused.content),
        "Not run: item 2 already has the note this job writes (“Save a note on each paper”)",
      );
      assert.include(
        JSON.stringify(refused.content),
        "only the papers left: 3.",
      );
    }
    const checkpoint = checkpoints({ events: turn.events } as Turn);
    const part = outcome(checkpoint[checkpoint.length - 1], "note-all");
    assert.equal(part.status, "completed");
    assert.deepEqual(part.doneTargets, ["item:1", "item:2", "item:3"]);
  });
});

describe("a job that writes two notes on each paper", function () {
  let environment: BatchJourneyEnvironment;
  let conversationKey = 999_700;
  const SUMMARY_ALL = "Save a summary note on each paper";
  const METHODS_ALL = "Save a methods note on each paper";
  const PAPERS = PAPER_IDS.map((paper) => `item:${paper}`);
  const ASK =
    "For each of the 3 papers in Drift, save a summary note and a separate methods note";

  beforeEach(async function () {
    environment = await installBatchJourneyEnvironment();
    conversationKey += 10;
  });

  afterEach(function () {
    environment.restore();
  });

  function jobRegistry(): AgentToolRegistry {
    const tools = createBatchJourneyRegistry(environment.library);
    tools.register(createTaskUpdateTool());
    tools.register(
      createNoteWriteTool({
        getItem: (itemId: number) =>
          (globalThis.Zotero as any).Items.get(itemId),
        getCollectionSummary: () => null,
      } as unknown as ZoteroGateway),
    );
    return tools;
  }

  const part = (taskId: string, description: string) => ({
    taskId,
    description,
    expectedEffect: "mutation",
    expectedCapability: "zotero.notes",
    targetIds: PAPER_IDS.map(String),
  });

  const body = (kind: "summary" | "methods", paper: number) =>
    kind === "summary"
      ? `# Summary of paper ${paper}\n\nWhat paper ${paper} found.`
      : `# Methods of paper ${paper}\n\nHow paper ${paper} measured it.`;

  const note = (
    kind: "summary" | "methods",
    paper: number,
    id = `${kind}-${paper}`,
  ): AgentToolCall => ({
    id,
    name: "note_write",
    arguments: {
      mode: "create",
      targetItemId: paper,
      content: body(kind, paper),
    },
  });

  const batch = (kind: "summary" | "methods"): AgentToolCall => ({
    id: `${kind}-batch`,
    name: "note_write_batch",
    arguments: {
      notes: PAPER_IDS.map((paper) => ({
        targetItemId: paper,
        content: body(kind, paper),
      })),
    },
  });

  /** Live notes on each paper, by paper. */
  const notesPerPaper = () =>
    PAPER_IDS.map(
      (paper) =>
        [...environment.library.notes.values()].filter(
          (entry) => entry.parentID === paper && !entry.deleted,
        ).length,
    );

  const skipped = (events: AgentEvent[]) =>
    events.filter(
      (event) =>
        event.type === "tool_result" &&
        ((event.content as { skipped?: unknown })?.skipped === true ||
          event.inputRejected),
    );

  function assertEveryPartDone(events: AgentEvent[], parts: string[]) {
    const ledger = settled({ events } as Turn);
    for (const local of parts) {
      const task = outcome(ledger, local);
      assert.equal(task.status, "completed", local);
      assert.deepEqual(task.doneTargets, PAPERS, local);
    }
    assert.deepEqual(ledger.end, { state: "completed" });
  }

  it("writes a summary note and a methods note on each of three papers: six notes, and the run ends completed", async function () {
    const turn = await runJourneyTurn({
      registry: jobRegistry(),
      conversationKey,
      userText: ASK,
      sourceMessageTimestamp: conversationKey,
      steps: [
        stepOf(
          declare("declare-1", [
            part("summary-all", SUMMARY_ALL),
            part("methods-all", METHODS_ALL),
          ]),
        ),
        ...PAPER_IDS.map((paper) =>
          stepOf(note("summary", paper), note("methods", paper)),
        ),
        finalStep("Each paper has its summary note and its methods note."),
      ],
    });
    assert.equal(turn.outcome?.kind, "completed");
    assert.isEmpty(skipped(turn.events), "no note was skipped or refused");
    assert.equal(environment.library.nativeSaves(), 6);
    assert.deepEqual(notesPerPaper(), [2, 2, 2]);
    assertEveryPartDone(turn.events, ["summary-all", "methods-all"]);
  });

  it("writes them in two batches, the summaries and then the methods", async function () {
    const turn = await runJourneyTurn({
      registry: jobRegistry(),
      conversationKey,
      userText: ASK,
      sourceMessageTimestamp: conversationKey,
      steps: [
        stepOf(
          declare("declare-1", [
            part("summary-all", SUMMARY_ALL),
            part("methods-all", METHODS_ALL),
          ]),
        ),
        stepOf(batch("summary")),
        stepOf(batch("methods")),
        finalStep("Each paper has its summary note and its methods note."),
      ],
    });
    assert.equal(turn.outcome?.kind, "completed");
    assert.isEmpty(skipped(turn.events), "no batch was skipped or refused");
    assert.deepEqual(notesPerPaper(), [2, 2, 2]);
    assertEveryPartDone(turn.events, ["summary-all", "methods-all"]);
  });

  it("tells a one-part job how to ask for a second note on a paper, then writes all six", async function () {
    const turn = await runJourneyTurn({
      registry: jobRegistry(),
      conversationKey,
      userText: ASK,
      sourceMessageTimestamp: conversationKey,
      steps: [
        // Both notes declared as one part: it holds one done flag a paper.
        stepOf(
          declare("declare-1", [
            part(
              "notes-all",
              "Save a summary and a methods note on each paper",
            ),
          ]),
          note("summary", 1),
        ),
        stepOf(note("methods", 1, "methods-1-refused")),
        // The model asks for the second note with a part of its own.
        stepOf(
          declare("declare-2", [part("methods-all", METHODS_ALL)]),
          note("methods", 1),
        ),
        ...[2, 3].map((paper) =>
          stepOf(note("summary", paper), note("methods", paper)),
        ),
        finalStep("Each paper has its summary note and its methods note."),
      ],
    });
    assert.equal(turn.outcome?.kind, "completed");
    const [first, ...others] = skipped(turn.events);
    assert.isEmpty(others, "only the note sent before its part was skipped");
    assert.equal(
      first?.type === "tool_result" ? first.callId : undefined,
      "methods-1-refused",
    );
    assert.include(
      JSON.stringify(first?.type === "tool_result" ? first.content : null),
      "declare it as a part of its own with task_update",
    );
    assert.deepEqual(notesPerPaper(), [2, 2, 2]);
    assertEveryPartDone(turn.events, ["notes-all", "methods-all"]);
  });
});

describe("derived limits in runtime turns", function () {
  let environment: DirectJourneyEnvironment;
  let conversationKey = 998_000;
  const BROKEN = "The PDF could not be opened";

  function papers(count: number, from = 4001): number[] {
    return Array.from({ length: count }, (_, index) => from + index);
  }

  function scopeOf(itemIds: number[]): TaskPaperScopeSet {
    return {
      wholeLibrary: false,
      itemIds,
      withText: itemIds.length,
      papers: Object.fromEntries(
        itemIds.map((itemId) => [
          itemId,
          { title: `Paper ${itemId}`, text: "pdf" as const },
        ]),
      ),
    };
  }

  function readCall(itemId: number, id = `read-${itemId}`): AgentToolCall {
    return {
      id,
      name: "paper_read",
      arguments: {
        target: { itemId, contextItemId: itemId + 1000, libraryID: 1 },
      },
    };
  }

  const declareScope = () =>
    stepOf(
      declare("declare-1", [
        {
          taskId: "read-all",
          description: "Read each paper in Drift",
          expectedEffect: "read",
          scope: true,
        },
      ]),
    );

  /** Reads fail for `failing` papers, and return a short text otherwise. */
  function readsFailingFor(failing: ReadonlySet<number>) {
    scriptedPaperRead = (input) => {
      const itemId = Number((input.target as { itemId?: number })?.itemId);
      if (failing.has(itemId)) throw new Error(BROKEN);
      return {
        mode: "targeted",
        results: [],
        papers: [
          {
            paperContext: {
              itemId,
              contextItemId: itemId + 1000,
              libraryID: 1,
            },
            passages: [
              {
                text: `Finding ${itemId}: drift was measured.`,
                sectionLabel: "Results",
              },
            ],
          },
        ],
      };
    };
  }

  function statuses(turn: Turn): string[] {
    return turn.events.flatMap((event) =>
      event.type === "status" ? [event.text] : [],
    );
  }

  beforeEach(async function () {
    environment = await installDirectJourneyEnvironment();
    libraryUpdateReceipt = undefined;
    conversationKey += 10;
  });

  afterEach(function () {
    environment.restore();
    scriptedPaperRead = undefined;
  });

  it("names the round in its status, or the job's page, never a cap", async function () {
    readsFailingFor(new Set());
    const ordinary = await runTurn({
      conversationKey,
      userText: "Read the paper twice",
      steps: [
        stepOf(paperRead("read-1")),
        stepOf(paperRead("read-2")),
        finalStep("Read."),
      ],
    });
    assert.deepEqual(statuses(ordinary), [
      "Running agent",
      "Continuing agent (round 2)",
      "Continuing agent (round 3)",
    ]);

    conversationKey += 10;
    const ids = papers(4);
    let page: number[] = [];
    const job = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift",
      scope: scopeOf(ids),
      attached: { advanced: { inputTokenCap: 30_000 } as never },
      steps: [
        declareScope(),
        ...Array.from({ length: 12 }, () => (messages: AgentModelMessage[]) => {
          const host = [...messages]
            .reverse()
            .map((message) => promptText([message]))
            .find((text) => text.startsWith("Long job"));
          if (!host || host.startsWith("Long job complete"))
            return finalStep("Every paper is read.");
          page = [...host.matchAll(/^- itemId=(\d+)/gm)].map((match) =>
            Number(match[1]),
          );
          return stepOf(...page.map((itemId) => readCall(itemId)));
        }),
      ],
    });
    assert.equal(job.outcome?.kind, "completed", String(job.error || ""));
    const texts = statuses(job);
    assert.include(texts, "Continuing agent (page 1 · 0 of 4)");
    assert.isTrue(
      texts.every((text) => !/\d+\/\d+\)$/.test(text)),
      JSON.stringify(texts),
    );
  });

  it("lets a step read every paper of a job at once, past eight calls", async function () {
    readsFailingFor(new Set());
    const ids = papers(20);
    const turn = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift",
      scope: scopeOf(ids),
      // A window the twenty papers fit in one pass: no page bounds the step.
      attached: { advanced: { inputTokenCap: 1_000_000 } as never },
      steps: [
        declareScope(),
        stepOf(...ids.map((itemId) => readCall(itemId))),
        finalStep("Every paper is read."),
      ],
    });
    assert.equal(turn.outcome?.kind, "completed", String(turn.error || ""));
    assert.isFalse(
      turn.events.some(
        (event) =>
          event.type === "provider_event" &&
          event.providerType === "agent_tool_call_overflow",
      ),
      "twenty reads for twenty papers are one step",
    );
    assert.lengthOf(outcome(settled(turn), "read-all").doneTargets!, 20);
    assert.deepEqual(settled(turn).end, { state: "completed" });
  });

  it("gives up on a paper that fails the same way twice and goes on, even through a segment of only failures", async function () {
    const ids = papers(50);
    // Papers 24 to 35 fail: a whole segment of rounds with no new result.
    const failing = new Set(ids.slice(23, 35));
    readsFailingFor(failing);
    let next = 0;
    let retried = false;
    const model = (messages: AgentModelMessage[]) => {
      const last = messages[messages.length - 1];
      const failed =
        last?.role === "tool" && String(last.content).includes(BROKEN);
      if (failed && !retried) {
        retried = true;
        return stepOf(readCall(ids[next - 1], `retry-${ids[next - 1]}`));
      }
      retried = false;
      if (next >= ids.length) return finalStep("Every paper is read.");
      return stepOf(readCall(ids[next++]));
    };
    const turn = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift",
      scope: scopeOf(ids),
      attached: { advanced: { inputTokenCap: 1_000_000 } as never },
      steps: [declareScope(), ...Array.from({ length: 80 }, () => model)],
    });
    assert.equal(turn.outcome?.kind, "completed", String(turn.error || ""));
    assert.equal(turn.requests, 1 + 23 + 2 * 12 + 15 + 1);
    const part = outcome(settled(turn), "read-all");
    assert.lengthOf(part.doneTargets!, 38);
    assert.deepEqual(part.exceptions, [
      {
        targets: [...failing].map((itemId) => `item:${itemId}`),
        reason: BROKEN,
      },
    ]);
    assert.deepEqual(settled(turn).end, {
      state: "completed_with_exceptions",
    });
  });

  it("stops a job as interrupted when a page's worth of papers fail in a row", async function () {
    const ids = papers(6);
    readsFailingFor(new Set(ids));
    const asked = new Map<number, number>();
    const model = (messages: AgentModelMessage[]) => {
      const host = [...messages]
        .reverse()
        .map((message) => promptText([message]))
        .find((text) => text.startsWith("Long job"));
      const page = host
        ? [...host.matchAll(/^- itemId=(\d+)/gm)].map((match) =>
            Number(match[1]),
          )
        : [];
      const itemId = page.find((id) => (asked.get(id) || 0) < 2);
      if (itemId === undefined) return finalStep("Nothing could be read.");
      asked.set(itemId, (asked.get(itemId) || 0) + 1);
      return stepOf(readCall(itemId, `read-${itemId}-${asked.get(itemId)}`));
    };
    const turn = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift",
      scope: scopeOf(ids),
      attached: { advanced: { inputTokenCap: 30_000 } as never },
      steps: [declareScope(), ...Array.from({ length: 20 }, () => model)],
    });
    assert.equal(turn.outcome?.kind, "completed", String(turn.error || ""));
    assert.equal(stopStatus(turn), "failed");
    const stop = turn.events.find(
      (event) =>
        event.type === "provider_event" &&
        event.providerType === "agent_run_stop",
    );
    assert.equal(
      (stop as { payload?: { rule?: string } }).payload?.rule,
      "page_failed",
    );
    assert.deepEqual(settled(turn).end, { state: "interrupted" });
    if (turn.outcome?.kind === "completed")
      assert.include(turn.outcome.text, "continue");
    // Two papers, each failing twice: a page's worth, and more than one.
    assert.equal(turn.requests, 1 + 4);
  });
});

describe("live runs that made every change, as runtime turns (2026-10-01)", function () {
  let environment: DirectJourneyEnvironment;
  let conversationKey = 996_000;

  beforeEach(async function () {
    environment = await installDirectJourneyEnvironment();
    libraryUpdateReceipt = undefined;
    liveReceipts = [];
    conversationKey += 10;
  });

  afterEach(function () {
    environment.restore();
    liveReceipts = [];
  });

  function call(
    id: string,
    name: string,
    args: Record<string, unknown>,
  ): AgentToolCall {
    return { id, name, arguments: args };
  }

  /** Each outcome as [local id, origin, status]. */
  function parts(ledger: ExecutionCheckpoint): string[][] {
    return ledger.tasks.map((task) => [
      task.taskId.slice(task.taskId.indexOf(":task:") + 6),
      String(task.origin),
      task.status,
    ]);
  }

  it("library.rename_delete_folder ends completed, each folder change closing its own part", async function () {
    liveReceipts = [...RENAME_DELETE_FOLDER.receipts];
    const turn = await runTurn({
      conversationKey,
      userText: RENAME_DELETE_FOLDER.userText,
      steps: [
        stepOf(
          call("declare-1", "task_update", RENAME_DELETE_FOLDER.taskUpdate),
        ),
        stepOf(
          call("rename-1", "library_update", {
            kind: "collection",
            action: "rename",
            collectionId: 11,
            newName: "New name loopmupsn7f0",
          }),
          call("delete-1", "library_update", {
            kind: "collection",
            action: "delete",
            collectionId: 12,
            deleteItems: false,
          }),
        ),
        finalStep("Renamed the folder and deleted the empty one."),
      ],
    });
    assert.equal(turn.outcome?.kind, "completed", String(turn.error || ""));
    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "completed" });
    assert.deepEqual(parts(ledger), [
      ["rename", "model", "completed"],
      ["delete", "model", "completed"],
    ]);
    const [rename, remove] = RENAME_DELETE_FOLDER.receipts;
    assert.deepEqual(outcome(ledger, "rename").verifiedReceiptIds, [rename.id]);
    assert.deepEqual(outcome(ledger, "delete").verifiedReceiptIds, [remove.id]);
  });

  it("library.discover_import ends completed, the import closing the part that asked for it", async function () {
    liveReceipts = [...DISCOVER_IMPORT.receipts];
    const turn = await runTurn({
      conversationKey,
      userText: DISCOVER_IMPORT.userText,
      steps: [
        stepOf(call("declare-1", "task_update", DISCOVER_IMPORT.taskUpdate)),
        // The literature search stands as one read.
        stepOf(
          paperRead("search-1"),
          call("create-1", "library_update", {
            kind: "collection",
            action: "create",
            name: "Drift new loopmupsn7f0",
          }),
        ),
        stepOf(
          call("import-1", "library_import", {
            kind: "identifiers",
            identifiers: [
              "10.1101/2025.02.04.636428",
              "10.1101/2025.10.21.683686",
            ],
            targetCollectionId: 9,
          }),
        ),
        finalStep("Both papers are in the new folder."),
      ],
    });
    assert.equal(turn.outcome?.kind, "completed", String(turn.error || ""));
    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "completed" });
    assert.deepEqual(parts(ledger), [
      ["search", "model", "completed"],
      ["collection", "model", "completed"],
      ["import", "model", "completed"],
    ]);
    const [create, imported] = DISCOVER_IMPORT.receipts;
    assert.deepEqual(outcome(ledger, "collection").verifiedReceiptIds, [
      create.id,
    ]);
    assert.deepEqual(outcome(ledger, "import").verifiedReceiptIds, [
      imported.id,
    ]);
  });
});

describe("a digest part in runtime turns", function () {
  let environment: DirectJourneyEnvironment;
  let conversationKey = 996_000;
  const SUMMARIZE = "Summarize each selected paper";
  const TEXT = `# Introduction\nPlace cells drift slowly across days.\n\n## Methods\nWe recorded forty cells over ten days.\n\n## Appendix\n${"The appendix restates the recording protocol in detail. ".repeat(30)}`;

  beforeEach(async function () {
    environment = await installDirectJourneyEnvironment();
    libraryUpdateReceipt = undefined;
    conversationKey += 10;
    taskUpdateDeps = {
      digests: {
        resolvePaper: async (_request, itemId) => ({
          libraryID: 1,
          itemId,
          contextItemId: itemId + 1000,
          title: `Paper ${itemId}`,
        }),
        // Paper 103 has no text.
        readText: async (paper) =>
          paper.itemId === 103
            ? null
            : { backend: "mineru", text: TEXT, totalCharacters: TEXT.length },
        llmCall: async (chat) => ({
          text: JSON.stringify({
            answer: `Summary of ${/Title: (Paper \d+)/.exec(chat.prompt)?.[1]}.`,
            evidence: [{ quote: "We recorded forty cells over ten days." }],
            facets: [
              { label: "Contributions", content: "Drift is slow." },
              { label: "Methods", content: "Imaging." },
              { label: "Limitations", content: "Not stated" },
            ],
          }),
          completion: { status: "complete" },
        }),
      },
    };
  });

  afterEach(function () {
    environment.restore();
    taskUpdateDeps = undefined;
  });

  it("the host digests each paper, the model writes the review, and the run ends with the part at 2 of 3", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Summarize all papers for me and write a literature review",
      scope: { wholeLibrary: false, itemIds: [101, 102, 103], withText: 2 },
      attached: {
        selectedCollectionContexts: [
          { collectionId: 9, name: "Drift", libraryID: 1 },
        ],
      },
      steps: [
        stepOf(
          declare("declare-digest", [
            {
              taskId: "summaries",
              description: SUMMARIZE,
              expectedEffect: "digest",
              scope: true,
            },
          ]),
        ),
        (messages) => {
          // The model reads every summary from the tool result.
          const text = promptText(messages);
          assert.include(text, "Summary of Paper 101.");
          assert.include(text, "Summary of Paper 102.");
          assert.include(text, "No readable text");
          return finalStep(
            "## Literature review\n\nPaper 101 and Paper 102 agree that drift is slow.",
          );
        },
      ],
    });

    assert.equal(turn.outcome?.kind, "completed", String(turn.error || ""));
    assert.equal(turn.requests, 2, "the digests cost the turn no model step");
    // The part rises paper by paper while the call runs.
    const counts = checkpoints(turn).map((checkpoint) => {
      const part = outcome(checkpoint, "summaries");
      return (
        (part.doneTargets?.length || 0) +
        (part.exceptions || []).flatMap((entry) => entry.targets).length
      );
    });
    assert.deepEqual(counts.slice(0, 4), [0, 1, 2, 3]);
    // Each paper's row is updated once, from the host's digest.
    const rows = turn.events.flatMap((event) =>
      event.type === "paper_ledger_update" &&
      (event as { delta: { toolName: string } }).delta.toolName ===
        "task_update"
        ? [(event as { delta: { papers: Array<{ itemId: number }> } }).delta]
        : [],
    );
    assert.sameMembers(
      rows.map((delta) => delta.papers[0].itemId),
      [101, 102, 103],
    );
    const ledger = settled(turn);
    const part = outcome(ledger, "summaries");
    assert.equal(part.status, "completed");
    assert.sameMembers(part.doneTargets || [], ["item:101", "item:102"]);
    assert.deepEqual(part.exceptions, [
      { targets: ["item:103"], reason: "No readable text" },
    ]);
    assert.deepEqual(ledger.end, { state: "completed_with_exceptions" });
  });

  it("a prose review over the digests, with no citation markup, completes the review part whole, with no correction", async function () {
    const REVIEW = "Write the literature review";
    const turn = await runTurn({
      conversationKey,
      userText: "Summarize all papers for me and write a literature review",
      scope: { wholeLibrary: false, itemIds: [101, 102, 103], withText: 2 },
      attached: {
        selectedCollectionContexts: [
          { collectionId: 9, name: "Drift", libraryID: 1 },
        ],
      },
      steps: [
        stepOf(
          declare("declare-digest", [
            {
              taskId: "summaries",
              description: SUMMARIZE,
              expectedEffect: "digest",
              scope: true,
            },
            {
              taskId: "review",
              description: REVIEW,
              expectedEffect: "artifact",
              scope: true,
            },
          ]),
        ),
        finalStep(
          "## Literature review\n\nPaper 101 and Paper 102 agree that drift is slow.",
        ),
      ],
    });

    assert.equal(turn.outcome?.kind, "completed", String(turn.error || ""));
    assert.equal(turn.requests, 2, "no correction for the review part");
    const ledger = settled(turn);
    const review = outcome(ledger, "review");
    assert.equal(review.status, "completed");
    assert.notProperty(review, "exceptions", "not 0 of 3 covered");
    assert.equal(outcome(ledger, "summaries").status, "completed");
  });
});

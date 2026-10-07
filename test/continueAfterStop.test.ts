import { assert } from "chai";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createTaskUpdateTool } from "../src/agent/tools/control/taskUpdate";
import { ExecutionCheckpointFold } from "../src/agent/execution/checkpointEvents";
import {
  appendAgentRunEvent,
  createAgentRun,
} from "../src/agent/store/traceStore";
import {
  loadAgentTranscriptSegment,
  PORTABLE_TRANSCRIPT_KEY,
} from "../src/agent/store/transcriptStore";
import type { TaskPaperScopeSet } from "../src/agent/context/taskPaperScopeListing";
import type { AgentStepParams } from "../src/agent/model/adapter";
import type {
  AgentEvent,
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeOutcome,
  AgentToolCall,
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
} from "../src/agent/types";
import {
  installDirectJourneyEnvironment,
  type DirectJourneyEnvironment,
} from "./helpers/materialJourneys";

/**
 * "continue" sent while the run the user stopped is still finishing.
 *
 * Stop releases the composer at once, but a tool already running when it
 * landed runs to its end, and only then does the run record its page and
 * settle its ledger. A turn started in that window must wait for the run,
 * then pick its ledger back up, and the two turns' transcripts must both
 * survive.
 */

const PAPERS = [7001, 7002, 7003, 7004, 7005, 7006];
const READ_ALL = "Read each paper in Drift";
const WAITING = "Waiting for the stopped run to finish";

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

type Turn = {
  outcome?: AgentRuntimeOutcome;
  error?: unknown;
  events: AgentEvent[];
  /** What the turn said it waited for, before its run started. */
  waits: string[];
  /** The callbacks in the order the turn made them: wait, start, event. */
  calls: Array<"wait" | "start" | "event">;
  prompts: AgentModelMessage[][];
  /** The ledger the turn held when its first model request was sent. */
  initialCheckpoint?: ExecutionCheckpoint;
  /** The papers the turn's reads asked for, in order. */
  reads: number[];
};

type Step = (messages: AgentModelMessage[]) => AgentModelStep;

/** What a paper read returns; a case may hold one back. */
let readPaper: (itemId: number) => Promise<void> = async () => undefined;

function stepOf(...calls: AgentToolCall[]): AgentModelStep {
  return {
    kind: "tool_calls",
    calls,
    assistantMessage: { role: "assistant", content: "", tool_calls: calls },
  };
}

function finalStep(text: string): AgentModelStep {
  return {
    kind: "final",
    text,
    assistantMessage: { role: "assistant", content: text },
  };
}

const declareAll: AgentToolCall = {
  id: "declare-1",
  name: "task_update",
  arguments: {
    tasks: [
      {
        taskId: "read-all",
        description: READ_ALL,
        expectedEffect: "read",
        scope: true,
      },
    ],
  },
};

const readCall = (itemId: number): AgentToolCall => ({
  id: `read-${itemId}`,
  name: "paper_read",
  arguments: {
    target: { itemId, contextItemId: itemId + 1000, libraryID: 1 },
  },
});

function registry(reads: number[]): AgentToolRegistry {
  const tools = new AgentToolRegistry();
  tools.register(createTaskUpdateTool());
  tools.register({
    spec: {
      name: "paper_read",
      description: "Read one paper",
      inputSchema: { type: "object" },
      executionClass: "read",
      workCategory: "retrieval",
    },
    validate: (args: unknown) => ({ ok: true, value: args as never }),
    execute: async (input: Record<string, unknown>) => {
      const itemId = Number((input.target as { itemId?: number })?.itemId);
      reads.push(itemId);
      await readPaper(itemId);
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
                text: `Finding ${itemId}: drift was measured in this paper.`,
                sectionLabel: "Results",
                pageLabel: "3",
              },
            ],
          },
        ],
      };
    },
  } as never);
  return tools;
}

let timestamp = 0;

/** One turn; the caller may start the next before this one settles. */
async function runTurn(params: {
  conversationKey: number;
  userText: string;
  steps: Step[];
  signal?: AbortSignal;
  onWaiting?: (text: string) => void;
  stoppedRunWaitMs?: number;
}): Promise<Turn> {
  const turn: Turn = {
    events: [],
    waits: [],
    calls: [],
    prompts: [],
    reads: [],
  };
  let requests = 0;
  const runtime = new AgentRuntime({
    registry: registry(turn.reads),
    resolveTurnScopePapers: async () => scope,
    ...(params.stoppedRunWaitMs !== undefined
      ? { stoppedRunWaitMs: params.stoppedRunWaitMs }
      : {}),
    adapterFactory: () => ({
      getCapabilities: () => ({
        streaming: false,
        toolCalls: true,
        multimodal: false,
      }),
      supportsTools: () => true,
      async runStep(stepParams: AgentStepParams): Promise<AgentModelStep> {
        if (requests === 0 && stepParams.request.executionCheckpoint)
          turn.initialCheckpoint = structuredClone(
            stepParams.request.executionCheckpoint,
          );
        turn.prompts.push([...stepParams.messages]);
        const step = params.steps[requests];
        requests += 1;
        if (!step)
          throw new Error(
            `The script ends at ${params.steps.length} steps; the model was asked for step ${requests}.`,
          );
        return step(stepParams.messages);
      },
    }),
  });
  timestamp += 100;
  try {
    turn.outcome = await runtime.runTurn({
      request: {
        conversationKey: params.conversationKey,
        mode: "agent",
        userText: params.userText,
        libraryID: 1,
        model: "test",
        apiKey: "test",
        apiBase: "https://example.invalid",
        metadata: { sourceMessageTimestamp: timestamp },
        selectedCollectionContexts: [
          { collectionId: 9, name: "Drift", libraryID: 1 },
        ],
      },
      signal: params.signal,
      onStart: () => {
        turn.calls.push("start");
      },
      onEvent: (event) => {
        turn.events.push(event);
        turn.calls.push("event");
      },
      onWaiting: (text) => {
        turn.waits.push(text);
        turn.calls.push("wait");
        params.onWaiting?.(text);
      },
    });
  } catch (caught) {
    turn.error = caught;
  }
  return turn;
}

function promptText(messages: readonly AgentModelMessage[]): string {
  return messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    )
    .join("\n");
}

/** The turn's ledger as its last ledger event left it. */
function lastLedger(turn: Turn): ExecutionCheckpoint {
  const fold = new ExecutionCheckpointFold();
  let last: ExecutionCheckpoint | undefined;
  for (const event of turn.events) {
    if (
      event.type !== "execution_checkpoint" &&
      event.type !== "execution_checkpoint_delta"
    )
      continue;
    last = fold.apply(event) || undefined;
    assert.exists(last, "every ledger event folds onto the one before");
  }
  assert.exists(last, "the turn published its ledger");
  return last!;
}

function readAll(checkpoint: ExecutionCheckpoint): ExecutionCheckpointTask {
  const task = checkpoint.tasks.find(
    (entry) => entry.taskId === `${checkpoint.executionId}:task:read-all`,
  );
  assert.exists(task, "the declared read part");
  return task!;
}

function stopStatus(turn: Turn): unknown {
  const stop = turn.events.find(
    (event) =>
      event.type === "provider_event" &&
      event.providerType === "agent_run_stop",
  );
  return stop?.type === "provider_event" ? stop.payload?.status : undefined;
}

/** The user requests the stored transcript holds, in order. */
function requestsIn(messages: readonly AgentModelMessage[]): string[] {
  return messages.flatMap((message) =>
    message.role === "user" &&
    !message.retainedTool &&
    typeof message.content === "string" &&
    message.content.startsWith("User request:\n")
      ? [message.content.slice("User request:\n".length)]
      : [],
  );
}

/** Whether the turn said it waited; the wait is never one of its run's events. */
function waited(turn: Turn): boolean {
  assert.isFalse(
    turn.events.some(
      (event) => event.type === "status" && event.text === WAITING,
    ),
    "the wait is not an event of the turn's run",
  );
  return turn.waits.includes(WAITING);
}

/** "continue": read the papers the resume note names, then answer. */
function resumer(): Step[] {
  return [
    (messages) => {
      const left = /papers? left, in order: ([\d, ]+)\./
        .exec(promptText(messages))?.[1]
        ?.split(", ")
        .map(Number);
      return left?.length
        ? stepOf(...left.map(readCall))
        : finalStep("There is nothing to resume.");
    },
    () => finalStep("Every paper is summarized."),
  ];
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("continue while the stopped run is still finishing", function () {
  let environment: DirectJourneyEnvironment;
  let conversationKey = 996_000;

  beforeEach(async function () {
    environment = await installDirectJourneyEnvironment();
    conversationKey += 10;
  });

  afterEach(function () {
    readPaper = async () => undefined;
    environment.restore();
  });

  it("waits for the stopped run, resumes its ledger from the first paper not settled, and keeps both turns' transcripts", async function () {
    // The user presses Stop while the third paper's read is running.
    const stop = new AbortController();
    const inFlight = deferred();
    const finishRead = deferred();
    readPaper = async (itemId) => {
      if (itemId !== 7003) return;
      stop.abort();
      inFlight.resolve();
      await finishRead.promise;
    };
    const first = runTurn({
      conversationKey,
      userText: "Read every paper in Drift and summarize each",
      signal: stop.signal,
      steps: [
        () => stepOf(declareAll, readCall(7001), readCall(7002)),
        () => stepOf(readCall(7003)),
      ],
    });
    await inFlight.promise;

    // Stop released the composer: "continue" is sent while the read runs.
    const waiting = deferred();
    const second = runTurn({
      conversationKey,
      userText: "continue",
      steps: resumer(),
      onWaiting: (text) => {
        if (text === WAITING) waiting.resolve();
      },
    });
    await Promise.race([waiting.promise, second]);
    finishRead.resolve();
    const [stopped, resumed] = await Promise.all([first, second]);

    // The stopped run kept the read Stop let finish, and settled cancelled.
    assert.equal(stopped.outcome?.kind, "cancelled", String(stopped.error));
    assert.equal(stopStatus(stopped), "cancelled");
    const before = lastLedger(stopped);
    assert.deepEqual(before.end, { state: "cancelled" });
    assert.deepEqual(readAll(before).doneTargets, [
      "item:7001",
      "item:7002",
      "item:7003",
    ]);

    // "continue" picked its ledger back up.
    assert.equal(resumed.outcome?.kind, "completed", String(resumed.error));
    const adopted = resumed.initialCheckpoint;
    assert.exists(adopted, "the stopped ledger was picked back up");
    assert.equal(adopted!.executionId, before.executionId);
    assert.notProperty(adopted!, "end");
    assert.deepEqual(
      readAll(adopted!).doneTargets,
      readAll(before).doneTargets,
    );
    assert.deepEqual(
      resumed.reads,
      [7004, 7005, 7006],
      "it goes on from the first paper not settled, and reads none twice",
    );
    const after = lastLedger(resumed);
    assert.deepEqual(after.end, { state: "completed" });
    assert.lengthOf(readAll(after).doneTargets || [], PAPERS.length);

    // Neither turn's transcript overwrote the other's.
    const stored = await loadAgentTranscriptSegment({
      conversationKey,
      compatibilityKey: PORTABLE_TRANSCRIPT_KEY,
    });
    assert.deepEqual(
      requestsIn(stored.messages),
      ["Read every paper in Drift and summarize each", "continue"],
      "both turns' requests, in order",
    );
    const keptResults = stored.messages.flatMap((message) =>
      message.role === "user" && message.retainedTool
        ? [message.retainedTool.callId]
        : [],
    );
    for (const itemId of PAPERS)
      assert.include(keptResults, `read-${itemId}`, `paper ${itemId}'s read`);
    assert.isTrue(
      stored.messages.some(
        (message) =>
          message.role === "assistant" &&
          promptText([message]) === "Every paper is summarized.",
      ),
      "the continue turn's answer",
    );
    // While it waited, the turn said what for, before its run started; the
    // run's events all come after its start.
    assert.isTrue(waited(resumed), "the turn said what it was waiting for");
    assert.deepEqual(resumed.calls.slice(0, 2), ["wait", "start"]);
    assert.notInclude(resumed.calls.slice(2), "start");
    assert.notInclude(resumed.calls.slice(2), "wait");
  });

  it("a second continue, sent after Stop was pressed again during the wait, waits its turn behind both", async function () {
    const stop = new AbortController();
    const inFlight = deferred();
    const finishRead = deferred();
    readPaper = async (itemId) => {
      if (itemId !== 7002) return;
      stop.abort();
      inFlight.resolve();
      await finishRead.promise;
    };
    const first = runTurn({
      conversationKey,
      userText: "Read every paper in Drift and summarize each",
      signal: stop.signal,
      steps: [
        () => stepOf(declareAll, readCall(7001)),
        () => stepOf(readCall(7002)),
      ],
    });
    await inFlight.promise;
    // "continue" waits; the user presses Stop on it, and sends it again.
    const stopAgain = new AbortController();
    const firstWait = deferred();
    const second = runTurn({
      conversationKey,
      userText: "continue",
      signal: stopAgain.signal,
      steps: resumer(),
      onWaiting: (text) => {
        if (text === WAITING) firstWait.resolve();
      },
    });
    await Promise.race([firstWait.promise, second]);
    stopAgain.abort();
    const secondWait = deferred();
    const third = runTurn({
      conversationKey,
      userText: "continue",
      steps: resumer(),
      onWaiting: (text) => {
        if (text === WAITING) secondWait.resolve();
      },
    });
    await Promise.race([secondWait.promise, third]);
    finishRead.resolve();
    const [stopped, cancelled, resumed] = await Promise.all([
      first,
      second,
      third,
    ]);

    assert.equal(stopStatus(stopped), "cancelled");
    assert.equal(stopStatus(cancelled), "cancelled");
    const before = lastLedger(stopped);
    assert.equal(resumed.outcome?.kind, "completed", String(resumed.error));
    const adopted = resumed.initialCheckpoint;
    assert.exists(adopted, "the stopped job was picked back up");
    assert.equal(adopted!.executionId, before.executionId);
    assert.deepEqual(resumed.reads, [7003, 7004, 7005, 7006]);
    assert.deepEqual(lastLedger(resumed).end, { state: "completed" });
    const stored = await loadAgentTranscriptSegment({
      conversationKey,
      compatibilityKey: PORTABLE_TRANSCRIPT_KEY,
    });
    assert.deepEqual(
      requestsIn(stored.messages),
      ["Read every paper in Drift and summarize each", "continue", "continue"],
      "every turn's request is kept, in order",
    );
    assert.isTrue(waited(cancelled) && waited(resumed));
  });

  it("gives up on no paper for calls Stop kept from starting, so continue still reads it", async function () {
    const stop = new AbortController();
    readPaper = async (itemId) => {
      if (itemId === 7002) stop.abort();
    };
    // Two reads of the same paper wait behind the one Stop lands in.
    const section = (itemId: number, query: string): AgentToolCall => ({
      ...readCall(itemId),
      id: `read-${itemId}-${query}`,
      arguments: { ...readCall(itemId).arguments, query },
    });
    const stopped = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift and summarize each",
      signal: stop.signal,
      steps: [
        () => stepOf(declareAll, readCall(7001)),
        () =>
          stepOf(
            readCall(7002),
            section(7003, "methods"),
            section(7003, "results"),
          ),
      ],
    });
    assert.deepEqual(stopped.reads, [7001, 7002]);
    assert.equal(stopStatus(stopped), "cancelled");
    const part = readAll(lastLedger(stopped));
    assert.deepEqual(part.doneTargets, ["item:7001", "item:7002"]);
    assert.notProperty(part, "exceptions", "no paper was given up on");

    const resumed = await runTurn({
      conversationKey,
      userText: "continue",
      steps: resumer(),
    });
    assert.deepEqual(resumed.reads, [7003, 7004, 7005, 7006]);
  });

  it("does not wait for a run left running by a crash: no run of this process is settling it", async function () {
    // What a crash leaves before the startup sweep: a run still marked
    // running, its ledger as last published, and nothing in memory.
    await createAgentRun({
      runId: "run-crashed-1",
      conversationKey,
      mode: "agent",
      model: "test",
      status: "running",
      createdAt: 1,
    });
    await appendAgentRunEvent("run-crashed-1", 1, {
      type: "status",
      text: "Running agent",
    });
    const turn = await runTurn({
      conversationKey,
      userText: "continue",
      steps: [() => finalStep("There is nothing to resume.")],
    });
    assert.equal(turn.outcome?.kind, "completed", String(turn.error));
    assert.isFalse(waited(turn));
  });

  it("goes on as before once the stopped run has not settled within the bound", async function () {
    const stop = new AbortController();
    const inFlight = deferred();
    const finishRead = deferred();
    readPaper = async (itemId) => {
      if (itemId !== 7001) return;
      stop.abort();
      inFlight.resolve();
      await finishRead.promise;
    };
    const first = runTurn({
      conversationKey,
      userText: "Read every paper in Drift and summarize each",
      signal: stop.signal,
      steps: [() => stepOf(declareAll, readCall(7001))],
    });
    await inFlight.promise;
    try {
      const second = await runTurn({
        conversationKey,
        userText: "What is representational drift?",
        stoppedRunWaitMs: 20,
        steps: [() => finalStep("A gradual change in a representation.")],
      });
      assert.isTrue(waited(second), "it waited");
      assert.equal(second.outcome?.kind, "completed", String(second.error));
      assert.isUndefined(second.initialCheckpoint);
    } finally {
      // The stopped run's tool comes back after all; it settles as before.
      finishRead.resolve();
      const stopped = await first;
      assert.equal(stopStatus(stopped), "cancelled");
    }
  });
});

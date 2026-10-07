/**
 * Rebuilding a conversation's Task progress from what it persisted: the
 * `paper_ledger_update` events of every run, the citations each answer kept,
 * whether a plan or a Codex plan ran, and the question numbering. Never for
 * a conversation that is being deleted or is retired.
 */
import { assert } from "chai";
import type { AgentRunEventRecord } from "../src/agent/types";
import {
  applyTaskPaperLedgerDelta,
  createTaskPaperLedger,
} from "../src/agent/context/taskPaperLedger";
import { executionCheckpointEvent } from "../src/agent/execution/checkpointEvents";
import { rememberConversationKeyRetired } from "../src/shared/conversationKeyLedger";
import {
  bumpConversationWriteGeneration,
  freezeConversationWrites,
  unfreezeConversationWrites,
} from "../src/shared/conversationWriteFence";
import {
  chatHistory,
  loadedConversationKeys,
} from "../src/modules/contextPanel/state";
import {
  TASK_PROGRESS_HISTORY_EVENT_TYPES,
  buildTaskProgressHistory,
  ensureTaskProgressHydrated,
  setTaskProgressHistoryLoaderForTests,
  waitForTaskProgressHydrationForTests,
} from "../src/modules/contextPanel/taskProgress/history";
import {
  clearAllTaskProgress,
  clearTaskProgress,
  displayedTaskRunState,
  getTaskProgress,
} from "../src/modules/contextPanel/taskProgress/store";
import type { Message } from "../src/modules/contextPanel/types";
import {
  digestLedgerDelta,
  ledgerDelta,
  outcomeCheckpoint,
  outcomeTask,
  quoteCitation,
} from "./helpers/taskProgressFixtures";

function record(
  runId: string,
  seq: number,
  payload: AgentRunEventRecord["payload"],
): AgentRunEventRecord {
  return { runId, seq, eventType: payload.type, payload, createdAt: seq };
}

function conversation(): Message[] {
  return [
    { role: "user", text: "Which papers measure drift?", timestamp: 1 },
    {
      role: "assistant",
      text: "Two do.",
      timestamp: 2,
      runMode: "agent",
      agentRunId: "run-1",
      quoteCitations: [quoteCitation("q1", 2)],
    },
    { role: "user", text: "Compare their methods", timestamp: 3 },
    {
      role: "assistant",
      text: "Codex compared them.",
      timestamp: 4,
      runMode: "agent",
      agentRunId: "run-2",
    },
  ];
}

const EVENTS: AgentRunEventRecord[] = [
  record("run-1", 1, {
    type: "paper_ledger_update",
    callId: "c1",
    delta: ledgerDelta(
      "c1",
      [
        [1, "read", "Drift grows with time."],
        [2, "read", "Drift scales with experience."],
        [3, "matched"],
      ],
      "run-1",
    ),
  }),
  record("run-2", 1, {
    type: "paper_ledger_update",
    callId: "m1",
    delta: ledgerDelta("m1", [[3, "read", "Methods differ."]], "run-2"),
  }),
  record("run-2", 2, {
    type: "codex_progress",
    itemId: "codex-plan-checklist",
    text: "✓ Inspect\n• Compare",
    steps: [
      { content: "Inspect", status: "completed" },
      { content: "Compare", status: "in_progress" },
    ],
  }),
];

describe("task progress history rebuild", function () {
  const KEY = 640021;
  let loads: string[][] = [];

  beforeEach(function () {
    loads = [];
    setTaskProgressHistoryLoaderForTests(async (runIds) => {
      loads.push([...runIds]);
      return EVENTS.filter((event) => runIds.includes(event.runId));
    });
    chatHistory.set(KEY, conversation());
    loadedConversationKeys.add(KEY);
  });

  afterEach(function () {
    setTaskProgressHistoryLoaderForTests();
    chatHistory.delete(KEY);
    loadedConversationKeys.delete(KEY);
    unfreezeConversationWrites(KEY);
    clearAllTaskProgress();
  });

  it("builds runs by question, keeps the latest Codex plan, and settles", function () {
    const byRun = new Map<string, AgentRunEventRecord[]>();
    for (const event of EVENTS) {
      byRun.set(event.runId, [...(byRun.get(event.runId) || []), event]);
    }
    const history = buildTaskProgressHistory(conversation(), byRun, 1);
    assert.deepEqual(
      history.runs.map((run) => [run.runId, run.turn, run.deltas.length]),
      [
        ["run-1", 1, 1],
        ["run-2", 2, 1],
      ],
    );
    assert.equal(history.latestTurn, 2);
    assert.equal(history.settled, "completed");
    assert.isTrue(history.planSeen, "a Codex plan counts as a plan");
    assert.deepEqual(history.checklist?.steps, [
      { label: "Inspect", status: "completed" },
      { label: "Compare", status: "in_progress" },
    ]);
    const cancelled = conversation();
    cancelled[3].text = "[Cancelled]";
    assert.equal(
      buildTaskProgressHistory(cancelled, byRun, 1).settled,
      "cancelled",
    );
    const failed = conversation();
    failed[3].text = "Error: offline";
    assert.equal(buildTaskProgressHistory(failed, byRun, 1).settled, "failed");
    const waiting = conversation().slice(0, 3);
    assert.isNull(buildTaskProgressHistory(waiting, byRun, 1).settled);
  });

  it("returns every run's own steps and every question's words and ending", function () {
    const byRun = new Map<string, AgentRunEventRecord[]>([
      [
        "run-1",
        [
          ...EVENTS.filter((event) => event.runId === "run-1"),
          record("run-1", 2, {
            type: "execution_checkpoint",
            checkpoint: outcomeCheckpoint(
              [
                outcomeTask("read", {
                  description: "Read the drift papers",
                  effect: "read",
                  status: "completed",
                }),
              ],
              "completed",
            ),
          }),
        ],
      ],
      ["run-2", EVENTS.filter((event) => event.runId === "run-2")],
    ]);
    const messages = conversation();
    messages[3].text = "Error: offline";
    const history = buildTaskProgressHistory(messages, byRun, 1);
    assert.deepEqual(
      history.runs.map((run) => [
        run.runId,
        run.checklist?.source,
        run.checklist?.steps.map((step) => step.label),
      ]),
      [
        ["run-1", "outcomes", ["Read the drift papers"]],
        ["run-2", "codex", ["Inspect", "Compare"]],
      ],
    );
    assert.equal(history.runs[0].checklist?.end, "completed");
    assert.deepEqual(history.questions, [
      { turn: 1, text: "Which papers measure drift?", settled: "completed" },
      { turn: 2, text: "Compare their methods", settled: "failed" },
    ]);
    assert.equal(
      history.checklist,
      history.runs[1].checklist,
      "the latest run's steps are the conversation's",
    );
  });

  it("rebuilds every question after a restart, newest last", async function () {
    ensureTaskProgressHydrated(KEY, 1);
    await waitForTaskProgressHydrationForTests(KEY);
    const rebuilt = getTaskProgress(KEY)!;
    assert.deepEqual(
      rebuilt.questions.map((question) => [
        question.turn,
        question.runId,
        question.text,
        question.checklist?.source ?? null,
      ]),
      [
        [1, "run-1", "Which papers measure drift?", null],
        [2, "run-2", "Compare their methods", "codex"],
      ],
    );
  });

  it("restores counts, states and steps after a restart (store cleared)", async function () {
    ensureTaskProgressHydrated(KEY, 1);
    await waitForTaskProgressHydrationForTests(KEY);
    const record = getTaskProgress(KEY)!;
    assert.isTrue(record.hydrated);
    assert.equal(record.runState, "completed");
    assert.equal(record.turnIndex, 2, "the latest question");
    assert.equal(record.ledger.papers["1:1"].state, "read");
    assert.equal(record.ledger.papers["1:2"].state, "cited");
    assert.equal(record.ledger.papers["1:3"].state, "read");
    assert.equal(record.ledger.papers["1:3"].turns[1].state, "matched");
    assert.equal(record.ledger.papers["1:3"].turns[2].state, "read");
    assert.isTrue(record.planSeen);
    assert.equal(record.checklist?.source, "codex");
    assert.deepEqual(loads, [["run-1", "run-2"]]);
    // Hydrated once: a later sync reads nothing again.
    ensureTaskProgressHydrated(KEY, 1);
    await waitForTaskProgressHydrationForTests(KEY);
    assert.lengthOf(loads, 1);
    // A restart empties the store; the next sync rebuilds it.
    clearTaskProgress(KEY);
    ensureTaskProgressHydrated(KEY, 1);
    await waitForTaskProgressHydrationForTests(KEY);
    assert.lengthOf(loads, 2);
    assert.equal(getTaskProgress(KEY)!.ledger.papers["1:2"].state, "cited");
  });

  it("rehydrates the papers a submitted document cited, with their sections", async function () {
    const finalized = (
      seq: number,
      documentId: string,
      citedSources: Array<{
        citationId: string;
        libraryID: number;
        itemKey: string;
        itemId?: number;
        sectionLabel?: string;
      }>,
    ) =>
      record("run-2", seq, {
        type: "material_finalized",
        materialRef: { documentId, documentVersion: 1, contentHash: "h" },
        materialKind: "document",
        callId: `submit-${documentId}`,
        citedSources,
      });
    assert.include(
      TASK_PROGRESS_HISTORY_EVENT_TYPES as readonly string[],
      "material_finalized",
    );
    const events = [
      ...EVENTS,
      finalized(3, "summaries", [
        {
          citationId: "c1",
          libraryID: 1,
          itemKey: "PAPER001",
          itemId: 1,
          sectionLabel: "Summaries",
        },
      ]),
      finalized(4, "review", [
        {
          citationId: "c1",
          libraryID: 1,
          itemKey: "PAPER003",
          itemId: 3,
          sectionLabel: "Discussion",
        },
      ]),
    ];
    setTaskProgressHistoryLoaderForTests(async (runIds) =>
      events.filter((event) => runIds.includes(event.runId)),
    );
    ensureTaskProgressHydrated(KEY, 1);
    await waitForTaskProgressHydrationForTests(KEY);
    const ledger = getTaskProgress(KEY)!.ledger;
    assert.equal(ledger.papers["1:3"].state, "cited");
    assert.deepEqual(ledger.papers["1:3"].turns[2].citations, [
      {
        citationId: "c1",
        turnIndex: 2,
        source: "document",
        sectionLabel: "Discussion",
      },
    ]);
    assert.equal(
      ledger.papers["1:1"].turns[2].state,
      "cited",
      "both documents of the run count",
    );
    assert.equal(ledger.papers["1:1"].itemKey, "PAPER001");
  });

  it("reads exactly the stored event kinds that carry Task progress", function () {
    assert.deepEqual(
      [...TASK_PROGRESS_HISTORY_EVENT_TYPES],
      [
        "paper_ledger_update",
        "material_finalized",
        "codex_progress",
        "plan_updated",
        "plan_ready",
        "plan_execution_updated",
        "execution_checkpoint",
        "execution_checkpoint_delta",
      ],
    );
  });

  it("skips events that carry no Task progress", function () {
    const events = [
      record("run-1", 1, {
        type: "paper_ledger_update",
        callId: "c0",
      } as unknown as AgentRunEventRecord["payload"]),
      record("run-1", 2, {
        type: "codex_progress",
        itemId: "codex-reasoning",
        text: "✓ Not a plan",
      } as AgentRunEventRecord["payload"]),
      record("run-1", 3, {
        type: "codex_progress",
        itemId: "codex-plan-checklist",
        text: "",
      } as AgentRunEventRecord["payload"]),
      record("run-1", 4, {
        type: "material_finalized",
        materialRef: { documentId: "d", documentVersion: 1, contentHash: "h" },
      } as AgentRunEventRecord["payload"]),
      record("run-1", 5, { type: "message_delta", text: "Two" }),
      record("run-1", 6, { type: "final", text: "Two do." }),
    ];
    const history = buildTaskProgressHistory(
      conversation().slice(0, 2),
      new Map([["run-1", events]]),
      1,
    );
    assert.deepEqual(history.runs, [
      {
        runId: "run-1",
        turn: 1,
        live: false,
        deltas: [],
        quoteCitations: [quoteCitation("q1", 2)],
        checklist: null,
      },
    ]);
    assert.isFalse(history.planSeen);
    assert.isNull(history.checklist);
  });

  it("waits for the conversation's history to load", async function () {
    loadedConversationKeys.delete(KEY);
    ensureTaskProgressHydrated(KEY, 1);
    await waitForTaskProgressHydrationForTests(KEY);
    assert.isNull(getTaskProgress(KEY));
    assert.lengthOf(loads, 0);
  });

  it("never rebuilds a conversation being deleted", async function () {
    freezeConversationWrites(KEY);
    ensureTaskProgressHydrated(KEY, 1);
    await waitForTaskProgressHydrationForTests(KEY);
    assert.isNull(getTaskProgress(KEY), "frozen: nothing is rebuilt");
    assert.lengthOf(loads, 0);
  });

  it("drops a rebuild the conversation was deleted under", async function () {
    let release: () => void = () => undefined;
    setTaskProgressHistoryLoaderForTests(async (runIds) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return EVENTS.filter((event) => runIds.includes(event.runId));
    });
    ensureTaskProgressHydrated(KEY, 1);
    // Deletion lands while the events load: generation bump + store clear.
    bumpConversationWriteGeneration(KEY);
    clearTaskProgress(KEY);
    release();
    await waitForTaskProgressHydrationForTests(KEY);
    assert.isNull(getTaskProgress(KEY));
  });

  it("never rebuilds a retired conversation key", async function () {
    const zotero = globalThis as { Zotero?: unknown };
    const previous = zotero.Zotero;
    zotero.Zotero = { DB: {} };
    try {
      rememberConversationKeyRetired(KEY);
      ensureTaskProgressHydrated(KEY, 1);
      await waitForTaskProgressHydrationForTests(KEY);
      assert.isNull(getTaskProgress(KEY));
      assert.lengthOf(loads, 0);
    } finally {
      zotero.Zotero = previous;
    }
  });
});

describe("task progress history rebuild of outcome ledgers", function () {
  const KEY = 640077;
  const live = outcomeCheckpoint([
    outcomeTask("save", { description: "Save the summary as a note" }),
  ]);
  const settledLedger = outcomeCheckpoint(
    [
      outcomeTask("save", {
        description: "Save the summary as a note",
        status: "completed",
      }),
      outcomeTask("host-receipt-tags", {
        description: "Added tags",
        origin: "host",
        status: "completed",
        targets: ["item:3", "item:4"],
        doneTargets: ["item:3"],
        exceptions: [
          { targets: ["item:4"], reason: "In a group library you cannot edit" },
        ],
      }),
    ],
    "completed_with_exceptions",
    5,
  );

  function stored(): Message[] {
    return [
      { role: "user", text: "Tag them and save a summary", timestamp: 1 },
      {
        role: "assistant",
        text: "Done, with one exception.",
        timestamp: 2,
        runMode: "agent",
        agentRunId: "run-outcomes",
      },
    ];
  }

  const events = [
    record("run-outcomes", 1, {
      type: "execution_checkpoint",
      checkpoint: live,
    }),
    record("run-outcomes", 2, {
      type: "execution_checkpoint",
      checkpoint: settledLedger,
    }),
  ];

  afterEach(function () {
    setTaskProgressHistoryLoaderForTests();
    chatHistory.delete(KEY);
    loadedConversationKeys.delete(KEY);
    clearAllTaskProgress();
  });

  it("reads outcome ledgers from the stored events", function () {
    assert.include(
      TASK_PROGRESS_HISTORY_EVENT_TYPES as readonly string[],
      "execution_checkpoint",
    );
  });

  it("rebuilds the latest run's outcome steps and end state after a restart", async function () {
    const history = buildTaskProgressHistory(
      stored(),
      new Map([["run-outcomes", events]]),
      1,
    );
    assert.equal(history.checklist?.source, "outcomes");
    assert.equal(history.checklist?.end, "completed_with_exceptions");
    assert.deepEqual(
      history.checklist?.steps.map((step) => [step.label, step.status]),
      [
        ["Save the summary as a note", "completed"],
        ["Added tags", "completed"],
      ],
      "the latest checkpoint wins",
    );
    assert.isTrue(history.planSeen);

    setTaskProgressHistoryLoaderForTests(async () => events);
    chatHistory.set(KEY, stored());
    loadedConversationKeys.add(KEY);
    ensureTaskProgressHydrated(KEY, 1);
    await waitForTaskProgressHydrationForTests(KEY);
    const record = getTaskProgress(KEY)!;
    assert.equal(record.runState, "completed");
    assert.equal(record.checklist?.source, "outcomes");
    assert.isTrue(record.planSeen);
    assert.equal(displayedTaskRunState(record), "completed_with_exceptions");
  });

  it("folds a run's whole ledger and the deltas after it", function () {
    const folded = [
      record("run-outcomes", 1, executionCheckpointEvent(undefined, live)),
      record("run-outcomes", 2, executionCheckpointEvent(live, settledLedger)),
    ];
    assert.equal(folded[1].payload.type, "execution_checkpoint_delta");
    assert.include(
      TASK_PROGRESS_HISTORY_EVENT_TYPES as readonly string[],
      "execution_checkpoint_delta",
    );
    const history = buildTaskProgressHistory(
      stored(),
      new Map([["run-outcomes", folded]]),
      1,
    );
    assert.equal(history.checklist?.end, "completed_with_exceptions");
    assert.deepEqual(
      history.checklist?.steps.map((step) => [
        step.label,
        step.status,
        step.outcome?.doneTargets,
      ]),
      [
        ["Save the summary as a note", "completed", 0],
        ["Added tags", "completed", 1],
      ],
    );
    assert.isTrue(history.planSeen);
  });

  it("replays a digest part: its count, each paper's summary and evidence, and a failure's reason", async function () {
    const part = (done: string[]) =>
      outcomeTask("summaries", {
        description: "Summarize each selected paper",
        effect: "digest",
        targets: ["item:1", "item:2", "item:3"],
        doneTargets: done,
      });
    const first = outcomeCheckpoint([part(["item:1"])]);
    const second = outcomeCheckpoint(
      [part(["item:1", "item:2"])],
      undefined,
      3,
    );
    const deltas = [
      digestLedgerDelta("call-s", 1, {
        runId: "run-outcomes",
        summary: "Paper one in brief.",
        evidence: [{ section: "Methods", quote: "We recorded cells." }],
      }),
      digestLedgerDelta("call-s", 2, {
        runId: "run-outcomes",
        summary: "Paper two in brief.",
      }),
      digestLedgerDelta("call-s", 3, {
        runId: "run-outcomes",
        failure: "No readable text",
      }),
    ];
    const digestEvents = [
      record("run-outcomes", 1, executionCheckpointEvent(undefined, first)),
      ...deltas.map((delta, index) =>
        record("run-outcomes", 2 + index, {
          type: "paper_ledger_update",
          callId: delta.callId,
          delta,
        }),
      ),
      record("run-outcomes", 5, executionCheckpointEvent(first, second)),
    ];
    assert.equal(digestEvents[4].payload.type, "execution_checkpoint_delta");
    const history = buildTaskProgressHistory(
      stored(),
      new Map([["run-outcomes", digestEvents]]),
      1,
    );
    assert.deepEqual(
      history.checklist?.steps.map((step) => [
        step.label,
        step.outcome?.digest,
        step.outcome?.doneTargets,
        step.outcome?.targets,
      ]),
      [["Summarize each selected paper", true, 2, 3]],
    );

    setTaskProgressHistoryLoaderForTests(async () => digestEvents);
    chatHistory.set(KEY, stored());
    loadedConversationKeys.add(KEY);
    ensureTaskProgressHydrated(KEY, 1);
    await waitForTaskProgressHydrationForTests(KEY);
    const rebuilt = getTaskProgress(KEY)!;
    const live = createTaskPaperLedger();
    for (const delta of deltas) applyTaskPaperLedgerDelta(live, delta, 1);
    assert.deepEqual(
      rebuilt.ledger.papers,
      live.papers,
      "the rebuilt rows equal the live ones",
    );
    assert.equal(
      rebuilt.ledger.papers["1:3"].turns[1].reads[0].whyMatched,
      "No readable text",
    );
  });

  it("replays two digest parts on one paper, a part's excluded papers and a replaced part", async function () {
    const digest = (local: string, description: string, done: string[]) =>
      outcomeTask(local, {
        description,
        effect: "digest",
        status: done.length ? "completed" : "pending",
        targets: ["item:1"],
        doneTargets: done,
      });
    const review = (excluded: boolean) =>
      outcomeTask("review", {
        description: "Write the review",
        effect: "artifact",
        targets: ["item:1", "item:2"],
        ...(excluded
          ? {
              status: "completed" as const,
              doneTargets: ["item:1"],
              excludedTargets: [
                { targets: ["item:2"], reason: "Off the question" },
              ],
            }
          : {}),
      });
    const oldPart = (replaced: boolean) =>
      outcomeTask("old", {
        description: "Read each paper",
        effect: "read",
        ...(replaced
          ? {
              status: "cancelled" as const,
              reason: "The user narrowed the question",
              supersededBy: "execution-1:task:review",
            }
          : {}),
      });
    const first = outcomeCheckpoint([
      oldPart(false),
      digest("brief", "Summarize each paper", []),
      digest("path", "Evidence for path integration", []),
      review(false),
    ]);
    const second = outcomeCheckpoint(
      [
        oldPart(true),
        digest("brief", "Summarize each paper", ["item:1"]),
        digest("path", "Evidence for path integration", ["item:1"]),
        review(true),
      ],
      "completed",
      4,
    );
    const deltas = [
      digestLedgerDelta("call-a", 1, {
        runId: "run-outcomes",
        partId: "brief",
        label: "Summarize each paper",
        summary: "In brief.",
      }),
      digestLedgerDelta("call-b", 1, {
        runId: "run-outcomes",
        partId: "path",
        label: "Evidence for path integration",
        summary: "Gaze tracks the belief.",
        relevance: { level: "direct", reason: "It measures belief." },
      }),
    ];
    const replay = [
      record("run-outcomes", 1, executionCheckpointEvent(undefined, first)),
      ...deltas.map((delta, index) =>
        record("run-outcomes", 2 + index, {
          type: "paper_ledger_update",
          callId: delta.callId,
          delta,
        }),
      ),
      record("run-outcomes", 4, executionCheckpointEvent(first, second)),
    ];
    assert.equal(replay[3].payload.type, "execution_checkpoint_delta");
    const history = buildTaskProgressHistory(
      stored(),
      new Map([["run-outcomes", replay]]),
      1,
    );
    assert.deepEqual(
      history.checklist?.steps.map((step) => [
        step.label,
        step.status,
        step.detail,
        step.outcome?.replaced,
        step.outcome?.excluded,
      ]),
      [
        [
          "Read each paper",
          "cancelled",
          "The user narrowed the question",
          true,
          [],
        ],
        ["Summarize each paper", "completed", undefined, false, []],
        ["Evidence for path integration", "completed", undefined, false, []],
        [
          "Write the review",
          "completed",
          undefined,
          false,
          [{ targets: ["item:2"], reason: "Off the question" }],
        ],
      ],
    );

    setTaskProgressHistoryLoaderForTests(async () => replay);
    chatHistory.set(KEY, stored());
    loadedConversationKeys.add(KEY);
    ensureTaskProgressHydrated(KEY, 1);
    await waitForTaskProgressHydrationForTests(KEY);
    const rebuilt = getTaskProgress(KEY)!;
    assert.equal(displayedTaskRunState(rebuilt), "completed");
    assert.equal(rebuilt.checklist?.done, 3);
    assert.equal(rebuilt.checklist?.total, 3, "the replaced part is left out");
    assert.deepEqual(
      rebuilt.ledger.papers["1:1"].turns[1].reads
        .filter((read) => read.granularity === "digest")
        .map((read) => [read.partId, read.label, read.relevance?.level]),
      [
        ["brief", "Summarize each paper", undefined],
        ["path", "Evidence for path integration", "direct"],
      ],
    );
  });

  it("keeps an ending with no outcome off the steps, and an earlier run's outcomes to the row", async function () {
    const endOnly = [
      record("run-outcomes", 1, {
        type: "execution_checkpoint",
        checkpoint: outcomeCheckpoint([], "blocked"),
      }),
    ];
    const history = buildTaskProgressHistory(
      stored(),
      new Map([["run-outcomes", endOnly]]),
      1,
    );
    assert.isFalse(history.planSeen);
    assert.deepEqual(history.checklist?.steps, []);
    assert.equal(history.checklist?.end, "blocked");
    setTaskProgressHistoryLoaderForTests(async () => endOnly);
    chatHistory.set(KEY, stored());
    loadedConversationKeys.add(KEY);
    ensureTaskProgressHydrated(KEY, 1);
    await waitForTaskProgressHydrationForTests(KEY);
    const hydrated = getTaskProgress(KEY)!;
    assert.isFalse(hydrated.planSeen);
    assert.equal(displayedTaskRunState(hydrated), "blocked");

    const later: Message[] = [
      ...stored(),
      { role: "user", text: "What is drift?", timestamp: 3 },
      {
        role: "assistant",
        text: "Drift is…",
        timestamp: 4,
        runMode: "agent",
        agentRunId: "run-plain",
      },
    ];
    const next = buildTaskProgressHistory(
      later,
      new Map([["run-outcomes", events]]),
      1,
    );
    assert.isTrue(next.planSeen, "an earlier run's outcomes keep the row");
    assert.isNull(next.checklist, "the latest run had no outcomes");
  });

  it("replays a stream-interrupted answer as interrupted", function () {
    const messages = stored();
    messages[1].interrupted = true;
    assert.equal(
      buildTaskProgressHistory(messages, new Map(), 1).settled,
      "interrupted",
    );
    messages[1].interrupted = false;
    messages[1].text = "Error: offline";
    assert.equal(
      buildTaskProgressHistory(messages, new Map(), 1).settled,
      "failed",
    );
  });
});

describe("task progress history rebuild of an old plan conversation", function () {
  const KEY = 640093;
  const step = (index: number, status: string) => ({
    version: 2,
    taskId: `execution-old:task-${index}`,
    executionId: "execution-old",
    planStepId: `step-${index}`,
    kind: "required_step",
    content: `Step ${index}`,
    activeForm: `Doing step ${index}`,
    acceptanceCriteria: [],
    expectedEffect: "reasoning",
    obligationIds: [],
    status,
    attemptCount: 1,
    evidenceIds: [],
    failureReasons: [],
    createdAt: 1,
    updatedAt: 2,
  });
  const artifact = {
    version: 2,
    planId: "plan-old",
    revision: 1,
    conversationKey: KEY,
    provider: "original",
    status: "approved",
    explanation: "Read the papers, then compare them.",
    steps: [
      { id: "step-1", content: "Step 1", status: "pending" },
      { id: "step-2", content: "Step 2", status: "pending" },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
  const ledger = {
    version: 2,
    executionId: "execution-old",
    planId: "plan-old",
    revision: 1,
    planDigest: "sha256:plan",
    conversationKey: KEY,
    attempt: 1,
    provider: "original",
    status: "running",
    activeTaskId: "execution-old:task-2",
    tasks: [step(1, "completed"), step(2, "in_progress")],
    createdAt: 1,
    updatedAt: 2,
  };
  // Stored before plan mode was removed: the types no longer name them.
  const planEvent = (seq: number, payload: Record<string, unknown>) =>
    record(
      "run-plan",
      seq,
      payload as unknown as AgentRunEventRecord["payload"],
    );
  const events = [
    planEvent(1, { type: "plan_updated", artifact }),
    planEvent(2, { type: "plan_ready", artifact }),
    planEvent(3, { type: "plan_execution_updated", ledger }),
    planEvent(4, {
      type: "plan_research_progress",
      progress: { stage: "reading", papers: 3 },
    }),
    planEvent(5, {
      type: "plan_scope_amended",
      amendmentId: "amendment-1",
      executionId: "execution-old",
      mode: "safe",
      rationale: "One more paper",
      previousItemCount: 2,
      newItemCount: 3,
      authority: "user",
    }),
    record("run-plan", 6, {
      type: "paper_ledger_update",
      callId: "p1",
      delta: ledgerDelta("p1", [[1, "read", "Read in the plan."]], "run-plan"),
    }),
  ];

  function stored(): Message[] {
    return [
      { role: "user", text: "Compare the three papers", timestamp: 1 },
      {
        role: "assistant",
        text: "Compared.",
        timestamp: 2,
        runMode: "agent",
        agentRunId: "run-plan",
      },
    ];
  }

  afterEach(function () {
    setTaskProgressHistoryLoaderForTests();
    chatHistory.delete(KEY);
    loadedConversationKeys.delete(KEY);
    clearAllTaskProgress();
  });

  it("rebuilds without steps, keeps its row, and never throws on plan events", async function () {
    const history = buildTaskProgressHistory(
      stored(),
      new Map([["run-plan", events]]),
      1,
    );
    assert.deepEqual(
      history.runs.map((run) => [run.runId, run.turn, run.deltas.length]),
      [["run-plan", 1, 1]],
    );
    assert.isTrue(history.planSeen, "a plan that ran keeps the row");
    assert.isNull(history.checklist, "a plan is no Task progress steps source");

    setTaskProgressHistoryLoaderForTests(async () => events);
    chatHistory.set(KEY, stored());
    loadedConversationKeys.add(KEY);
    ensureTaskProgressHydrated(KEY, 1);
    await waitForTaskProgressHydrationForTests(KEY);
    const rebuilt = getTaskProgress(KEY)!;
    assert.isTrue(rebuilt.hydrated, "the rebuild ran to the end");
    assert.equal(rebuilt.runState, "completed");
    assert.equal(rebuilt.ledger.papers["1:1"].state, "read");
    assert.isNull(rebuilt.checklist);
    assert.isTrue(rebuilt.planSeen);
  });
});

import { assert } from "chai";
import {
  TASK_PROGRESS_MAX_CONVERSATIONS,
  TASK_PROGRESS_MAX_QUESTIONS,
  applyTaskDocumentCitations,
  applyTaskOutsideEvent,
  applyTaskPaperUpdate,
  beginTaskRun,
  clearAllTaskProgress,
  clearTaskProgress,
  completeTaskRun,
  getTaskProgressViewMemo,
  rememberTaskProgressView,
  endTaskRun,
  beginTaskAction,
  endTaskAction,
  getTaskProgress,
  hydrateTaskProgress,
  listTaskProgressConversations,
  setTaskActionStep,
  setTaskActionSummary,
  setTaskChecklist,
  markTaskAnswering,
  setTaskScope,
  subscribeTaskProgress,
  syncTaskAnswerCitations,
  taskTurnIndexFor,
  displayedTaskRunState,
  markTaskWaiting,
  setTaskOutcomes,
  noteTaskQuestion,
  taskQuestionChecklist,
  taskQuestionState,
  taskReadInDepth,
  isInDepthRead,
} from "../src/modules/contextPanel/taskProgress/store";
import {
  digestLedgerDelta,
  ledgerDelta,
  outcomeCheckpoint,
  outcomeTask,
  quoteCitation,
} from "./helpers/taskProgressFixtures";

describe("task progress store", function () {
  afterEach(function () {
    clearAllTaskProgress();
  });

  it("knows when a paper was read in depth, not when it was only found", function () {
    beginTaskRun(7, { runId: "run-a" });
    // Search hits and their snippets are not reads in depth.
    applyTaskPaperUpdate(
      7,
      ledgerDelta("search", [
        [1, "read", "Drift grows."],
        [2, "matched"],
      ]),
      "run-a",
    );
    assert.isFalse(taskReadInDepth(getTaskProgress(7)));
    // A targeted passage is not either.
    applyTaskPaperUpdate(
      7,
      {
        ...ledgerDelta("targeted", [[1, "read"]]),
        toolName: "paper_read",
        reads: [
          {
            key: "1:1",
            callId: "targeted",
            toolName: "paper_read",
            granularity: "passage",
            method: "targeted",
            snippet: "A passage.",
          },
        ],
      },
      "run-a",
    );
    assert.isFalse(taskReadInDepth(getTaskProgress(7)));
    // An overview read of the paper is.
    applyTaskPaperUpdate(
      7,
      {
        ...ledgerDelta("overview", [[2, "read"]]),
        toolName: "paper_read",
        reads: [
          {
            key: "1:2",
            callId: "overview",
            toolName: "paper_read",
            granularity: "passage",
            method: "overview",
            snippet: "The paper's body.",
          },
        ],
      },
      "run-a",
    );
    assert.isTrue(taskReadInDepth(getTaskProgress(7)));
    assert.isFalse(taskReadInDepth(null));
  });

  it("counts a scoped digest as in depth only when it covered body text", function () {
    const digest = (depth?: "abstract" | "notes" | "section" | "full") => ({
      key: "1:1",
      callId: "digest",
      toolName: "task_update",
      granularity: "digest" as const,
      snippet: "The digest's answer.",
      ...(depth ? { depth } : {}),
    });
    // A digest of the whole text (no scope recorded) reads in depth.
    assert.isTrue(isInDepthRead(digest()));
    assert.isTrue(isInDepthRead(digest("full")));
    assert.isTrue(isInDepthRead(digest("section")));
    // A summary of the abstract or the notes does not.
    assert.isFalse(isInDepthRead(digest("abstract")));
    assert.isFalse(isInDepthRead(digest("notes")));
  });

  it("applies ledger deltas once, however often they replay", function () {
    let notified = 0;
    const unsubscribe = subscribeTaskProgress(() => notified++);
    try {
      beginTaskRun(7, { runId: "run-a" });
      const delta = ledgerDelta("c1", [
        [1, "matched"],
        [2, "read", "Drift grows with time."],
      ]);
      applyTaskPaperUpdate(7, delta, "run-a");
      const version = getTaskProgress(7)!.version;
      applyTaskPaperUpdate(7, delta, "run-a");
      applyTaskPaperUpdate(7, JSON.parse(JSON.stringify(delta)), "run-a");
      const record = getTaskProgress(7)!;
      assert.equal(record.version, version, "a replay changes nothing");
      assert.equal(record.ledger.papers["1:2"].turns[1].reads.length, 1);
      assert.equal(record.ledger.papers["1:1"].state, "matched");
      assert.equal(notified, 2, "one start and one delta");
    } finally {
      unsubscribe();
    }
  });

  it("numbers turns by run order and files late deltas under their own run", function () {
    beginTaskRun(7);
    assert.equal(getTaskProgress(7)!.turnIndex, 1);
    assert.equal(getTaskProgress(7)!.runState, "working");
    beginTaskRun(7, { runId: "run-a" });
    assert.equal(getTaskProgress(7)!.runId, "run-a", "the runtime names it");
    assert.equal(getTaskProgress(7)!.turnIndex, 1);
    completeTaskRun(7, { runId: "run-a" });
    beginTaskRun(7, { runId: "run-b" });
    assert.equal(getTaskProgress(7)!.turnIndex, 2);
    applyTaskPaperUpdate(7, ledgerDelta("late", [[3, "read"]]), "run-a");
    applyTaskPaperUpdate(7, ledgerDelta("now", [[4, "read"]]), "run-b");
    const ledger = getTaskProgress(7)!.ledger;
    assert.deepEqual(Object.keys(ledger.papers["1:3"].turns), ["1"]);
    assert.deepEqual(Object.keys(ledger.papers["1:4"].turns), ["2"]);
    // A replayed start of an earlier run never restarts it.
    beginTaskRun(7, { runId: "run-a" });
    assert.equal(getTaskProgress(7)!.runId, "run-b");
  });

  it("takes the question number from the conversation when given", function () {
    beginTaskRun(9, { runId: "retry", turnIndex: 4 });
    applyTaskPaperUpdate(9, ledgerDelta("c", [[1, "read"]]));
    assert.deepEqual(
      Object.keys(getTaskProgress(9)!.ledger.papers["1:1"].turns),
      ["4"],
    );
    const user = { role: "user" };
    const history = [
      { role: "user" },
      { role: "assistant" },
      { role: "user", compactMarker: true },
      user,
      { role: "assistant" },
    ];
    assert.equal(taskTurnIndexFor(history, user), 2);
    assert.equal(taskTurnIndexFor(history), 2);
    assert.equal(taskTurnIndexFor([], user), 0);
  });

  it("moves working → answering once and asks overlays to collapse", function () {
    beginTaskRun(7, { runId: "run-a" });
    assert.isTrue(markTaskAnswering(7, "run-a"));
    assert.isFalse(markTaskAnswering(7, "run-a"));
    assert.isFalse(markTaskAnswering(7, "other-run"));
    const record = getTaskProgress(7)!;
    assert.equal(record.runState, "answering");
    assert.equal(record.collapseSeq, 1);
  });

  it("marks final citations and completes the run idempotently", function () {
    beginTaskRun(7, { runId: "run-a" });
    applyTaskPaperUpdate(
      7,
      ledgerDelta("c1", [
        [1, "read", "One"],
        [2, "read", "Two"],
      ]),
      "run-a",
    );
    const citations = [quoteCitation("q1", 1)];
    completeTaskRun(7, { runId: "run-a", quoteCitations: citations });
    completeTaskRun(7, { runId: "run-a", quoteCitations: citations });
    const record = getTaskProgress(7)!;
    assert.equal(record.runState, "completed");
    assert.equal(record.ledger.papers["1:1"].state, "cited");
    assert.equal(record.ledger.papers["1:2"].state, "read");
    assert.lengthOf(record.ledger.papers["1:1"].turns[1].citations, 1);
  });

  it("marks a document's sources under the run's question, idempotently, beside the answer's", function () {
    beginTaskRun(7, { runId: "run-a" });
    applyTaskPaperUpdate(
      7,
      ledgerDelta("c1", [
        [1, "read", "One"],
        [2, "read", "Two"],
      ]),
      "run-a",
    );
    let notified = 0;
    const unsubscribe = subscribeTaskProgress(() => {
      notified += 1;
    });
    try {
      const review = [
        {
          citationId: "d1",
          libraryID: 1,
          itemKey: "PAPER002",
          itemId: 2,
          sectionLabel: "Discussion",
        },
      ];
      applyTaskDocumentCitations(7, "run-a", review);
      assert.equal(notified, 1);
      applyTaskDocumentCitations(7, "run-a", review);
      assert.equal(notified, 1, "a replay changes nothing");
      // A second document of the same run adds its own sources.
      applyTaskDocumentCitations(7, "run-a", [
        { citationId: "d1", libraryID: 1, itemKey: "PAPER001", itemId: 1 },
      ]);
      completeTaskRun(7, {
        runId: "run-a",
        quoteCitations: [quoteCitation("q1", 2)],
      });
    } finally {
      unsubscribe();
    }
    const record = getTaskProgress(7)!;
    assert.equal(record.ledger.papers["1:1"].state, "cited");
    assert.deepEqual(
      record.ledger.papers["1:2"].turns[1].citations.map((c) => [
        c.citationId,
        c.source,
        c.sectionLabel,
      ]),
      [
        ["q1", undefined, undefined],
        ["d1", "document", "Discussion"],
      ],
    );
    applyTaskDocumentCitations(7, "run-unknown", [
      { citationId: "x", libraryID: 1, itemKey: "K", itemId: 3 },
    ]);
    assert.isUndefined(
      record.ledger.papers["1:3"],
      "an unknown run's sources are not filed under a guessed question",
    );
  });

  it("replaces a question's document sources when the question re-runs under a new run", function () {
    beginTaskRun(7, { runId: "run-a", turnIndex: 1 });
    applyTaskPaperUpdate(
      7,
      ledgerDelta("c1", [
        [1, "read", "One"],
        [2, "read", "Two"],
      ]),
      "run-a",
    );
    applyTaskDocumentCitations(7, "run-a", [
      { citationId: "d1", libraryID: 1, itemKey: "PAPER001", itemId: 1 },
    ]);
    completeTaskRun(7, { runId: "run-a" });
    beginTaskRun(7, { runId: "run-b", turnIndex: 1 });
    applyTaskDocumentCitations(7, "run-b", [
      { citationId: "d1", libraryID: 1, itemKey: "PAPER002", itemId: 2 },
    ]);
    const live = getTaskProgress(7)!;
    assert.equal(
      live.ledger.papers["1:1"].state,
      "read",
      "run-a's source is gone",
    );
    assert.equal(live.ledger.papers["1:2"].state, "cited");
    const papers = JSON.stringify(live.ledger.papers);
    // Replaying both runs of the question gives the same rows.
    clearTaskProgress(7);
    hydrateTaskProgress(7, {
      runs: [
        {
          runId: "run-a",
          turn: 1,
          deltas: [
            ledgerDelta("c1", [
              [1, "read", "One"],
              [2, "read", "Two"],
            ]),
          ],
          documentCitations: [
            { citationId: "d1", libraryID: 1, itemKey: "PAPER001", itemId: 1 },
          ],
        },
        {
          runId: "run-b",
          turn: 1,
          deltas: [],
          documentCitations: [
            { citationId: "d1", libraryID: 1, itemKey: "PAPER002", itemId: 2 },
          ],
        },
      ],
      latestTurn: 1,
      settled: null,
      planSeen: false,
      checklist: null,
      libraryID: 1,
    });
    const replayed = getTaskProgress(7)!;
    assert.equal(replayed.ledger.papers["1:1"].state, "read");
    assert.equal(replayed.ledger.papers["1:2"].state, "cited");
    assert.equal(
      JSON.stringify(replayed.ledger.papers["1:2"].turns[1].citations),
      JSON.stringify(JSON.parse(papers)["1:2"].turns[1].citations),
    );
  });

  it("replaces a paper's reads for a question when the question re-runs under a new run", function () {
    const evidence = (run: string) =>
      Array.from({ length: 6 }, (_, index) => ({
        section: "Results",
        quote: `Quote ${index} from ${run} that is long enough.`,
      }));
    const digest = (run: string) =>
      digestLedgerDelta("tu", 10, {
        runId: run,
        summary: `Summary from ${run}.`,
        evidence: evidence(run),
      });
    beginTaskRun(7, { runId: "run-a", turnIndex: 1 });
    applyTaskPaperUpdate(7, digest("run-a"), "run-a");
    completeTaskRun(7, { runId: "run-a" });
    beginTaskRun(7, { runId: "run-b", turnIndex: 1 });
    applyTaskPaperUpdate(7, digest("run-b"), "run-b");
    const turn = getTaskProgress(7)!.ledger.papers["1:10"].turns[1];
    const snippets = turn.reads.map((read) => read.snippet || "");
    assert.include(snippets, "Summary from run-b.");
    assert.notInclude(snippets, "Summary from run-a.");
    assert.isFalse(
      snippets.some((snippet) => snippet.includes("run-a")),
      "the earlier run's reads are gone",
    );
    assert.equal(turn.reads.length, 7);
    assert.equal(turn.droppedReads, 0);
    // A late delta of the earlier run does not take the question back.
    applyTaskPaperUpdate(
      7,
      digestLedgerDelta("late", 10, {
        runId: "run-a",
        summary: "Late from run-a.",
      }),
      "run-a",
    );
    assert.notInclude(
      getTaskProgress(7)!.ledger.papers["1:10"].turns[1].reads.map(
        (read) => read.snippet,
      ),
      "Late from run-a.",
    );
    const live = JSON.stringify(
      getTaskProgress(7)!.ledger.papers["1:10"].turns[1].reads,
    );
    // Replaying both runs of the question from history keeps the later one.
    clearTaskProgress(7);
    hydrateTaskProgress(7, {
      runs: [
        { runId: "run-a", turn: 1, deltas: [digest("run-a")] },
        { runId: "run-b", turn: 1, deltas: [digest("run-b")] },
      ],
      latestTurn: 1,
      settled: "completed",
      planSeen: false,
      checklist: null,
      libraryID: 1,
    });
    assert.equal(
      JSON.stringify(getTaskProgress(7)!.ledger.papers["1:10"].turns[1].reads),
      live,
    );
    // History that arrives after the session already ran the retry keeps it.
    clearTaskProgress(7);
    beginTaskRun(7, { runId: "run-b", turnIndex: 1 });
    applyTaskPaperUpdate(7, digest("run-b"), "run-b");
    hydrateTaskProgress(7, {
      runs: [{ runId: "run-a", turn: 1, deltas: [digest("run-a")] }],
      latestTurn: 1,
      settled: null,
      planSeen: false,
      checklist: null,
      libraryID: 1,
    });
    assert.equal(
      JSON.stringify(getTaskProgress(7)!.ledger.papers["1:10"].turns[1].reads),
      live,
    );
  });

  it("keeps the partial ledger when a run fails or is cancelled", function () {
    beginTaskRun(7, { runId: "run-a" });
    applyTaskPaperUpdate(7, ledgerDelta("c1", [[1, "read"]]), "run-a");
    endTaskRun(7, "failed", "run-a");
    assert.equal(getTaskProgress(7)!.runState, "failed");
    assert.equal(getTaskProgress(7)!.ledger.papers["1:1"].state, "read");
    endTaskRun(7, "cancelled", "run-a");
    assert.equal(getTaskProgress(7)!.runState, "failed", "only live runs end");
    beginTaskRun(8, { runId: "run-b" });
    endTaskRun(8, "cancelled");
    assert.equal(getTaskProgress(8)!.runState, "cancelled");
    completeTaskRun(9, { runId: "x" });
    endTaskRun(9, "failed", "x");
    assert.equal(getTaskProgress(9)!.runState, "completed");
  });

  it("keeps at most six idle conversations, oldest out, and every live one", function () {
    beginTaskRun(1, { runId: "live" });
    for (let key = 2; key <= TASK_PROGRESS_MAX_CONVERSATIONS + 3; key++) {
      completeTaskRun(key, { runId: `r${key}` });
    }
    const kept = listTaskProgressConversations();
    assert.lengthOf(kept, TASK_PROGRESS_MAX_CONVERSATIONS + 1);
    assert.include(kept, 1, "a live run is kept and not counted");
    assert.notInclude(kept, 2);
    assert.notInclude(kept, 3);
    assert.include(kept, TASK_PROGRESS_MAX_CONVERSATIONS + 3);
    clearTaskProgress(1);
    assert.isNull(getTaskProgress(1));
  });

  it("keeps conversations being opened beside many live runs", function () {
    // Five live runs used to leave room for one idle record, so two
    // conversations being opened evicted each other on every write.
    for (let key = 1; key <= TASK_PROGRESS_MAX_CONVERSATIONS - 1; key++) {
      beginTaskRun(key, { runId: `live${key}` });
    }
    const first = TASK_PROGRESS_MAX_CONVERSATIONS;
    const second = TASK_PROGRESS_MAX_CONVERSATIONS + 1;
    for (let pass = 0; pass < 3; pass++) {
      completeTaskRun(first, { runId: "first" });
      completeTaskRun(second, { runId: "second" });
    }
    assert.isNotNull(getTaskProgress(first));
    assert.isNotNull(getTaskProgress(second));
    const kept = listTaskProgressConversations();
    for (let key = 1; key <= TASK_PROGRESS_MAX_CONVERSATIONS - 1; key++) {
      assert.include(kept, key, "live runs are kept");
    }
  });
  it("keeps a scope listing until the attached scope changes", function () {
    const listing = {
      libraryID: 1,
      wholeLibrary: false,
      entries: [],
      totalItems: 0,
      listedItems: 0,
      truncated: false,
    };
    setTaskScope(7, {
      signature: "a",
      libraryID: 1,
      contexts: {},
      label: "Drift",
      listing,
    });
    setTaskScope(7, {
      signature: "a",
      libraryID: 1,
      contexts: {},
      label: "Drift",
    });
    assert.strictEqual(getTaskProgress(7)!.scope!.listing, listing);
    setTaskScope(7, { signature: "b", libraryID: 1, contexts: {}, label: "" });
    assert.isNull(getTaskProgress(7)!.scope!.listing);
  });

  it("runs an action as the conversation's steps without renumbering questions", function () {
    beginTaskRun(7, { runId: "q1", turnIndex: 1 });
    completeTaskRun(7, { runId: "q1" });
    beginTaskAction(7, { runId: "action-1", title: "Auto Tag" });
    let record = getTaskProgress(7)!;
    assert.equal(record.runState, "working");
    assert.equal(record.turnIndex, 1, "an action is not a question");
    assert.isTrue(record.planSeen, "the row stays once an action ran");
    assert.equal(record.checklist?.source, "action");
    setTaskActionStep(7, "action-1", {
      step: "Reading papers",
      index: 1,
      total: 3,
    });
    setTaskActionSummary(7, "action-1", "Read 4 papers");
    setTaskActionStep(7, "action-1", {
      step: "Proposing tags",
      index: 2,
      total: 3,
    });
    record = getTaskProgress(7)!;
    assert.deepEqual(
      record.checklist!.steps.map((step) => [step.label, step.status]),
      [
        ["Reading papers", "completed"],
        ["Proposing tags", "in_progress"],
      ],
    );
    assert.equal(record.checklist!.total, 3);
    assert.equal(
      record.checklist!.summary,
      "",
      "a new step clears the summary",
    );
    endTaskAction(7, "action-1", "failed", "Auto Tag failed: offline");
    record = getTaskProgress(7)!;
    assert.equal(record.runState, "failed");
    assert.equal(record.checklist!.outcome, "failed");
    assert.equal(record.checklist!.detail, "Auto Tag failed: offline");
    // A later question starts fresh steps.
    beginTaskRun(7, { runId: "q2", turnIndex: 2 });
    assert.isNull(getTaskProgress(7)!.checklist);
    assert.isTrue(getTaskProgress(7)!.planSeen);
  });

  it("never takes over a live question with an action", function () {
    beginTaskRun(7, { runId: "q1", turnIndex: 1 });
    beginTaskAction(7, { runId: "action-1", title: "Auto Tag" });
    assert.equal(getTaskProgress(7)!.runId, "q1");
    endTaskAction(7, "action-1", "completed", "Done");
    assert.equal(
      getTaskProgress(7)!.runState,
      "working",
      "the question runs on",
    );
    assert.equal(getTaskProgress(7)!.checklist!.outcome, "completed");
  });

  it("keeps a Codex plan as the run's steps", function () {
    beginTaskRun(7, { runId: "codex-1", turnIndex: 1 });
    setTaskChecklist(7, {
      source: "codex",
      runId: "codex-1",
      steps: [
        { label: "Inspect the scope", status: "completed" },
        { label: "Read the methods", status: "in_progress" },
      ],
    });
    const version = getTaskProgress(7)!.version;
    setTaskChecklist(7, {
      source: "codex",
      runId: "codex-1",
      steps: [
        { label: "Inspect the scope", status: "completed" },
        { label: "Read the methods", status: "in_progress" },
      ],
    });
    assert.equal(getTaskProgress(7)!.version, version, "same steps, no work");
    assert.isTrue(getTaskProgress(7)!.planSeen);
    assert.equal(getTaskProgress(7)!.checklist!.total, 2);
    assert.equal(getTaskProgress(7)!.checklist!.done, 1);
  });

  it("hydrates from history without disturbing a live run", function () {
    hydrateTaskProgress(7, {
      runs: [
        {
          runId: "r1",
          turn: 1,
          deltas: [ledgerDelta("c1", [[1, "read", "One"]], "r1")],
          quoteCitations: [quoteCitation("q1", 1)],
        },
        {
          runId: "r2",
          turn: 2,
          deltas: [ledgerDelta("c2", [[2, "skimmed"]], "r2")],
        },
      ],
      latestTurn: 2,
      settled: "completed",
      planSeen: true,
      checklist: null,
      libraryID: 1,
    });
    let record = getTaskProgress(7)!;
    assert.isTrue(record.hydrated);
    assert.equal(record.runState, "completed");
    assert.equal(record.turnIndex, 2);
    assert.equal(record.runId, "r2");
    assert.equal(record.ledger.papers["1:1"].state, "cited");
    assert.equal(record.ledger.papers["1:2"].turns[2].state, "skimmed");
    assert.isTrue(record.planSeen);
    // Hydrating again (a reopened panel) changes nothing.
    const snapshot = JSON.stringify(record.ledger);
    hydrateTaskProgress(7, {
      runs: [
        {
          runId: "r1",
          turn: 1,
          deltas: [ledgerDelta("c1", [[1, "read", "One"]], "r1")],
          quoteCitations: [quoteCitation("q1", 1)],
        },
      ],
      latestTurn: 2,
      settled: "completed",
      planSeen: false,
      checklist: null,
      libraryID: 1,
    });
    assert.equal(JSON.stringify(getTaskProgress(7)!.ledger), snapshot);
    // A live run keeps its state; its own turn's citations wait for final.
    beginTaskRun(8, { runId: "live", turnIndex: 3 });
    hydrateTaskProgress(8, {
      runs: [
        {
          runId: "live",
          turn: 3,
          live: true,
          deltas: [ledgerDelta("c3", [[3, "read"]], "live")],
          quoteCitations: [quoteCitation("q3", 3)],
        },
      ],
      latestTurn: 3,
      settled: "completed",
      planSeen: false,
      checklist: null,
      libraryID: 1,
    });
    record = getTaskProgress(8)!;
    assert.equal(record.runState, "working");
    assert.equal(record.ledger.papers["1:3"].state, "read");
  });

  it("repaints nothing when history adds nothing to a live run", function () {
    beginTaskRun(7, { runId: "live", turnIndex: 2 });
    const version = getTaskProgress(7)!.version;
    const changed = hydrateTaskProgress(7, {
      runs: [{ runId: "live", turn: 2, live: true, deltas: [] }],
      latestTurn: 2,
      settled: null,
      planSeen: false,
      checklist: null,
    });
    assert.isFalse(changed);
    assert.equal(getTaskProgress(7)!.version, version);
    assert.isTrue(getTaskProgress(7)!.hydrated);
  });

  it("clearing a conversation forgets its hydration", function () {
    hydrateTaskProgress(7, {
      runs: [],
      latestTurn: 1,
      settled: "completed",
      planSeen: false,
      checklist: null,
    });
    const epoch = getTaskProgress(7)!.epoch;
    clearTaskProgress(7);
    assert.isNull(getTaskProgress(7));
    beginTaskRun(7);
    assert.isFalse(getTaskProgress(7)!.hydrated);
    assert.notEqual(getTaskProgress(7)!.epoch, epoch);
  });

  describe("questions", function () {
    const steps = (runId: string, label: string) =>
      outcomeCheckpoint([
        outcomeTask(`${runId}-${label}`, {
          description: label,
          status: "completed",
          effect: "read",
        }),
      ]);
    const summary = (key: number) =>
      getTaskProgress(key)!.questions.map((question) => [
        question.turn,
        question.runId,
        question.text,
      ]);

    it("keeps each question's steps when the next question starts", function () {
      beginTaskRun(7, {
        runId: "q1",
        turnIndex: 1,
        text: "Find papers about drift",
      });
      setTaskOutcomes(7, "q1", steps("q1", "Read the papers"));
      completeTaskRun(7, { runId: "q1" });
      beginTaskRun(7, { runId: "q2", turnIndex: 2, text: "Compare them" });
      const record = getTaskProgress(7)!;
      assert.isNull(record.checklist, "the new question starts fresh steps");
      assert.deepEqual(summary(7), [
        [1, "q1", "Find papers about drift"],
        [2, "q2", "Compare them"],
      ]);
      const [first, second] = record.questions;
      assert.equal(first.checklist?.runId, "q1");
      assert.deepEqual(
        first.checklist?.steps.map((step) => step.label),
        ["Read the papers"],
      );
      assert.equal(taskQuestionState(record, first), "completed");
      assert.equal(taskQuestionChecklist(record, first), first.checklist);
      assert.isNull(taskQuestionChecklist(record, second));
      setTaskOutcomes(7, "q2", steps("q2", "Compare the methods"));
      const now = getTaskProgress(7)!;
      assert.equal(
        taskQuestionChecklist(now, now.questions[1]),
        now.checklist,
        "the current question's steps are the conversation's",
      );
      assert.equal(taskQuestionChecklist(now, now.questions[0])?.runId, "q1");
    });

    it("never takes a question's steps when the request starts before the question is in the history", function () {
      beginTaskRun(7, { runId: "q1", turnIndex: 1, text: "First" });
      setTaskOutcomes(7, "q1", steps("q1", "Read"));
      completeTaskRun(7, { runId: "q1" });
      // The request lifecycle counts the questions before the new one is
      // added: it names the previous question's number.
      beginTaskRun(7, { turnIndex: 1 });
      let record = getTaskProgress(7)!;
      assert.deepEqual(summary(7), [[1, "q1", "First"]]);
      assert.equal(record.questions[0].checklist?.runId, "q1");
      // The runtime names the run and its question.
      beginTaskRun(7, { runId: "q2", turnIndex: 2, text: "Second" });
      record = getTaskProgress(7)!;
      assert.deepEqual(summary(7), [
        [1, "q1", "First"],
        [2, "q2", "Second"],
      ]);
      assert.equal(record.questions[0].checklist?.runId, "q1");
      assert.equal(taskQuestionState(record, record.questions[0]), "completed");
      // Replayed starts change nothing.
      const version = record.version;
      beginTaskRun(7, { runId: "q1" });
      beginTaskRun(7, { runId: "q2", turnIndex: 2 });
      assert.equal(getTaskProgress(7)!.version, version);
      assert.lengthOf(getTaskProgress(7)!.questions, 2);
    });

    it("replaces a question's steps when it runs again", function () {
      beginTaskRun(7, { runId: "q1", turnIndex: 1, text: "First" });
      setTaskOutcomes(7, "q1", steps("q1", "Read"));
      completeTaskRun(7, { runId: "q1" });
      beginTaskRun(7, { runId: "q1-retry", turnIndex: 1 });
      const record = getTaskProgress(7)!;
      assert.deepEqual(summary(7), [[1, "q1-retry", "First"]]);
      assert.isNull(record.questions[0].checklist);
      assert.isNull(record.checklist);
    });

    it("gives each action its own entry, titled, and keeps the question's steps beside it", function () {
      beginTaskRun(7, { runId: "q1", turnIndex: 1, text: "First" });
      setTaskOutcomes(7, "q1", steps("q1", "Read"));
      completeTaskRun(7, { runId: "q1" });
      beginTaskAction(7, {
        runId: "action-1",
        title: "Auto Tag",
        text: "tag the drift papers",
      });
      setTaskActionStep(7, "action-1", { step: "Tagging", index: 1, total: 1 });
      endTaskAction(7, "action-1", "failed", "offline");
      beginTaskRun(7, { runId: "q2", turnIndex: 2, text: "Second" });
      const record = getTaskProgress(7)!;
      assert.deepEqual(summary(7), [
        [1, "q1", "First"],
        [0, "action-1", "tag the drift papers"],
        [2, "q2", "Second"],
      ]);
      const [question, action] = record.questions;
      assert.equal(action.title, "Auto Tag");
      assert.equal(action.checklist?.source, "action");
      assert.equal(taskQuestionState(record, action), "failed");
      assert.equal(question.checklist?.runId, "q1");
      assert.equal(
        taskQuestionState(record, question),
        "completed",
        "the action never takes the question's ending",
      );
    });

    it("files an action started during a question before it, and the question stays current", function () {
      beginTaskRun(7, { runId: "q1", turnIndex: 1, text: "First" });
      beginTaskAction(7, { runId: "action-1", title: "Auto Tag" });
      const record = getTaskProgress(7)!;
      assert.deepEqual(summary(7), [
        [0, "action-1", undefined],
        [1, "q1", "First"],
      ]);
      // The question's own outcomes take the steps back; the action's stay
      // with the action.
      setTaskOutcomes(7, "q1", steps("q1", "Read"));
      const now = getTaskProgress(7)!;
      assert.equal(now.checklist?.runId, "q1");
      assert.equal(now.questions[0].checklist?.source, "action");
      assert.equal(taskQuestionChecklist(now, now.questions[1])?.runId, "q1");
      assert.equal(record.runId, "q1");
    });

    it(`keeps the last ${TASK_PROGRESS_MAX_QUESTIONS} questions`, function () {
      for (let turn = 1; turn <= TASK_PROGRESS_MAX_QUESTIONS + 5; turn++) {
        beginTaskRun(7, { runId: `q${turn}`, turnIndex: turn });
        completeTaskRun(7, { runId: `q${turn}` });
      }
      const questions = getTaskProgress(7)!.questions;
      assert.lengthOf(questions, TASK_PROGRESS_MAX_QUESTIONS);
      assert.equal(questions[0].turn, 6);
      assert.equal(questions[questions.length - 1].turn, 25);
    });

    it("names the question a request asked once the history holds it", function () {
      beginTaskRun(7, { runId: "q1", turnIndex: 1 });
      completeTaskRun(7, { runId: "q1" });
      noteTaskQuestion(7, { turnIndex: 1, text: "First" });
      assert.deepEqual(summary(7), [[1, "q1", "First"]]);
      // Plain chat: no runtime names the run; the request started under the
      // previous question's number.
      beginTaskRun(7, { turnIndex: 1 });
      noteTaskQuestion(7, { turnIndex: 2, text: "Second" });
      const record = getTaskProgress(7)!;
      assert.equal(record.turnIndex, 2);
      assert.deepEqual(summary(7), [
        [1, "q1", "First"],
        [2, undefined, "Second"],
      ]);
      assert.equal(taskQuestionState(record, record.questions[0]), "completed");
      // A named run keeps its number; the words fill in only once.
      beginTaskRun(7, { runId: "q3", turnIndex: 3 });
      noteTaskQuestion(7, { turnIndex: 3, text: "Third" });
      noteTaskQuestion(7, { turnIndex: 3, text: "Other words" });
      assert.equal(getTaskProgress(7)!.questions[2].text, "Third");
      const version = getTaskProgress(7)!.version;
      noteTaskQuestion(7, { turnIndex: 2, text: "Second" });
      assert.equal(getTaskProgress(7)!.version, version, "nothing new");
    });

    it("hydrates every question's words, steps and ending, once", function () {
      const history = {
        runs: [
          {
            runId: "r1",
            turn: 1,
            deltas: [ledgerDelta("c1", [[1, "read", "One"]], "r1")],
            checklist: {
              source: "outcomes" as const,
              runId: "r1",
              steps: [{ label: "Read", status: "completed" as const }],
              end: "completed" as const,
            },
          },
          {
            runId: "r2",
            turn: 3,
            deltas: [],
            checklist: {
              source: "codex" as const,
              runId: "r2",
              steps: [{ label: "Compare", status: "in_progress" as const }],
            },
          },
        ],
        questions: [
          {
            turn: 1,
            text: "Which papers measure drift?",
            settled: "completed",
          },
          { turn: 2, text: "Thanks", settled: "completed" },
          { turn: 3, text: "Compare them", settled: "failed" },
        ],
        latestTurn: 3,
        settled: "failed",
        planSeen: true,
        checklist: {
          source: "codex" as const,
          runId: "r2",
          steps: [{ label: "Compare", status: "in_progress" as const }],
        },
        libraryID: 1,
      } as const;
      hydrateTaskProgress(7, history as never);
      let record = getTaskProgress(7)!;
      assert.deepEqual(summary(7), [
        [1, "r1", "Which papers measure drift?"],
        [2, undefined, "Thanks"],
        [3, "r2", "Compare them"],
      ]);
      assert.equal(record.questions[0].checklist?.source, "outcomes");
      assert.equal(record.questions[0].checklist?.done, 1);
      assert.equal(record.questions[0].checklist?.total, 1);
      assert.equal(taskQuestionState(record, record.questions[1]), "completed");
      assert.equal(record.checklist?.runId, "r2");
      const version = record.version;
      assert.isFalse(hydrateTaskProgress(7, history as never));
      assert.equal(getTaskProgress(7)!.version, version);
      assert.lengthOf(getTaskProgress(7)!.questions, 3);

      // A run live in this session stays the current question; the earlier
      // ones go before it.
      beginTaskRun(8, { runId: "live", turnIndex: 3, text: "Compare them" });
      hydrateTaskProgress(8, {
        ...history,
        runs: [
          history.runs[0],
          { runId: "live", turn: 3, live: true, deltas: [] },
        ],
        questions: [
          history.questions[0],
          history.questions[1],
          { turn: 3, text: "Compare them", settled: null },
        ],
        settled: null,
        checklist: null,
      } as never);
      record = getTaskProgress(8)!;
      assert.deepEqual(summary(8), [
        [1, "r1", "Which papers measure drift?"],
        [2, undefined, "Thanks"],
        [3, "live", "Compare them"],
      ]);
      assert.equal(record.runState, "working");
      assert.equal(record.questions[0].checklist?.runId, "r1");
    });
  });

  describe("answer citations", function () {
    const cites = (key: number, turn: number) =>
      getTaskProgress(key)!
        .questions.find((question) => question.turn === turn)
        ?.answerCitations?.map((entry) => [entry.id, entry.number]);

    it("replaces a question's cited passages whole, each time its answer shows anew", function () {
      beginTaskRun(7, { runId: "run-a", turnIndex: 1 });
      const quoteCitations = [quoteCitation("Q_a", 1), quoteCitation("Q_b", 1)];
      let notified = 0;
      const stop = subscribeTaskProgress(() => notified++);
      syncTaskAnswerCitations(
        7,
        { runId: "run-a" },
        { text: "One [[cite:Q_a]]. Two [[cite:Q_b]].", quoteCitations },
      );
      assert.deepEqual(cites(7, 1), [
        ["Q_a", 1],
        ["Q_b", 2],
      ]);
      // Validation drops a passage: the list is replaced, not merged.
      syncTaskAnswerCitations(
        7,
        { runId: "run-a" },
        {
          text: "One [[cite:Q_a]]. Two [[cite:Q_b]].",
          quoteCitations,
          quoteDisplayOverride: {
            markdown: "Two [[cite:Q_b]].",
            quoteCitations,
          },
        },
      );
      assert.deepEqual(cites(7, 1), [["Q_b", 1]]);
      const seen = notified;
      syncTaskAnswerCitations(
        7,
        { runId: "run-a" },
        {
          text: "One [[cite:Q_a]]. Two [[cite:Q_b]].",
          quoteCitations,
          quoteDisplayOverride: {
            markdown: "Two [[cite:Q_b]].",
            quoteCitations,
          },
        },
      );
      assert.equal(notified, seen, "the same list again changes nothing");
      syncTaskAnswerCitations(7, { runId: "run-a" }, null);
      assert.deepEqual(cites(7, 1), []);
      stop();
    });

    it("reads a web-attributed answer from its own text, as the chat renders it", function () {
      beginTaskRun(7, { runId: "run-a", turnIndex: 1 });
      const quoteCitations = [quoteCitation("Q_a", 1), quoteCitation("Q_b", 1)];
      const answer = {
        text: "Old [[cite:Q_a]].",
        quoteCitations,
        quoteDisplayOverride: {
          markdown: "New [[cite:Q_b]]. Old [[cite:Q_a]].",
          quoteCitations,
        },
      };
      // Synced before the run's final event: the shown text.
      syncTaskAnswerCitations(7, { runId: "run-a" }, answer);
      assert.deepEqual(cites(7, 1), [
        ["Q_b", 1],
        ["Q_a", 2],
      ]);
      // The final event has web markers: read again from the answer's text.
      applyTaskOutsideEvent(7, "run-a", {
        type: "final",
        text: answer.text,
        webSourceAnchors: [
          {
            offset: answer.text.length,
            sources: [
              {
                sourceId: "web_1",
                url: "https://example.org/a",
                hostname: "example.org",
                title: "A page",
              },
            ],
          },
        ],
      } as never);
      assert.deepEqual(cites(7, 1), [["Q_a", 1]]);
      // Later syncs keep to it; a caller that knows says so itself.
      syncTaskAnswerCitations(7, { runId: "run-a" }, answer);
      assert.deepEqual(cites(7, 1), [["Q_a", 1]]);
      syncTaskAnswerCitations(7, { runId: "run-a" }, answer, {
        hasWebSources: false,
      });
      assert.deepEqual(cites(7, 1), [
        ["Q_b", 1],
        ["Q_a", 2],
      ]);
    });

    it("lists the answer a cancelled retry brings back, by its question's number", function () {
      beginTaskRun(7, { runId: "run-a", turnIndex: 1 });
      const quoteCitations = [quoteCitation("Q_a", 1)];
      const answer = { text: "Old [[cite:Q_a]].", quoteCitations };
      syncTaskAnswerCitations(7, { runId: "run-a" }, answer);
      // The retry starts the question afresh, without the old list.
      beginTaskRun(7, { runId: "run-b", turnIndex: 1 });
      assert.isUndefined(cites(7, 1));
      // Cancelled: the old answer is back, and so is its list.
      syncTaskAnswerCitations(7, { turn: 1 }, answer);
      assert.deepEqual(cites(7, 1), [["Q_a", 1]]);
    });

    it("never lets an earlier run of a question asked again take its list", function () {
      beginTaskRun(7, { runId: "run-a", turnIndex: 1 });
      beginTaskRun(7, { runId: "run-b", turnIndex: 1 });
      const quoteCitations = [quoteCitation("Q_a", 1), quoteCitation("Q_b", 1)];
      syncTaskAnswerCitations(
        7,
        { runId: "run-b" },
        { text: "New [[cite:Q_b]].", quoteCitations },
      );
      syncTaskAnswerCitations(
        7,
        { runId: "run-a", turn: 1 },
        { text: "Old [[cite:Q_a]].", quoteCitations },
      );
      assert.deepEqual(cites(7, 1), [["Q_b", 1]]);
      // A run the record never saw finds its question by number.
      syncTaskAnswerCitations(
        7,
        { runId: "journal-run", turn: 1 },
        { text: "Late [[cite:Q_a]].", quoteCitations },
      );
      assert.deepEqual(cites(7, 1), [["Q_a", 1]]);
      // Nothing for a conversation or question the store does not hold.
      syncTaskAnswerCitations(99, { runId: "run-a" }, { text: "" });
      assert.isNull(getTaskProgress(99));
    });

    it("takes each question's list from its stored answer on hydrate, unless this session asked it again", function () {
      const listed = [
        {
          id: "Q_a",
          number: 1,
          sentences: ["One."],
          quote: "Quoted",
          kind: "cite" as const,
        },
      ];
      const history = {
        runs: [
          { runId: "r1", turn: 1, deltas: [], answerCitations: listed },
          { runId: "r2", turn: 2, deltas: [], answerCitations: listed },
        ],
        questions: [
          { turn: 1, text: "One?", settled: "completed" },
          { turn: 2, text: "Two?", settled: "completed" },
        ],
        latestTurn: 2,
        settled: "completed",
        planSeen: false,
        checklist: null,
      } as const;
      beginTaskRun(8, { runId: "again", turnIndex: 2 });
      assert.isTrue(hydrateTaskProgress(8, history as never));
      assert.deepEqual(cites(8, 1), [["Q_a", 1]]);
      assert.isUndefined(cites(8, 2), "asked again here: its own run lists it");
      assert.isFalse(
        hydrateTaskProgress(8, history as never),
        "the same history again changes nothing",
      );
    });
  });

  it("remembers the opened folds for a fresh view of the conversation", function () {
    beginTaskRun(5, { runId: "run-fold" });
    rememberTaskProgressView(5, { openFolds: ["q1:fold:library"] });
    rememberTaskProgressView(5, { open: true });
    const memo = getTaskProgressViewMemo(5)!;
    assert.deepEqual(memo.openFolds, ["q1:fold:library"]);
    memo.openFolds.push("q1:fold:other");
    assert.deepEqual(
      getTaskProgressViewMemo(5)!.openFolds,
      ["q1:fold:library"],
      "a copy",
    );
  });

  it("keeps a conversation's card state only as long as its record", function () {
    rememberTaskProgressView(3, { open: true });
    assert.isNull(getTaskProgressViewMemo(3), "no record, nothing to remember");
    beginTaskRun(3, { runId: "run-a" });
    rememberTaskProgressView(3, { open: true, expanded: ["1:2"] });
    rememberTaskProgressView(3, { scrollTop: 120 });
    assert.deepInclude(getTaskProgressViewMemo(3), {
      open: true,
      expanded: ["1:2"],
      scrollTop: 120,
    });
    const copy = getTaskProgressViewMemo(3)!;
    copy.expanded.push("1:9");
    assert.deepEqual(getTaskProgressViewMemo(3)!.expanded, ["1:2"], "a copy");
    clearTaskProgress(3);
    assert.isNull(getTaskProgressViewMemo(3), "cleared with its record");
    beginTaskRun(4, { runId: "run-b" });
    rememberTaskProgressView(4, { open: true });
    clearAllTaskProgress();
    assert.isNull(getTaskProgressViewMemo(4), "cleared with every record");
    // An evicted record takes its card state with it.
    beginTaskRun(100, { runId: "run-evicted" });
    completeTaskRun(100, { runId: "run-evicted" });
    rememberTaskProgressView(100, { open: true });
    // Idle records push it out; live ones no longer count against the limit.
    for (let key = 101; key <= 100 + TASK_PROGRESS_MAX_CONVERSATIONS; key++) {
      completeTaskRun(key, { runId: `run-${key}` });
    }
    assert.isNull(getTaskProgress(100));
    assert.isNull(getTaskProgressViewMemo(100), "evicted with its record");
  });
});

describe("task progress outcome ledger", function () {
  afterEach(function () {
    clearAllTaskProgress();
  });

  const save = outcomeTask("save", {
    description: "Save the summary as a note",
    capability: "zotero.notes",
    targets: ["item:7"],
  });
  const read = outcomeTask("read", {
    description: "Read the paper",
    effect: "read",
    status: "completed",
    doneTargets: ["item:7"],
  });

  it("shows a run's outcomes as its steps, and keeps the row for the conversation", function () {
    beginTaskRun(20, { runId: "run-a" });
    setTaskOutcomes(20, "run-a", outcomeCheckpoint([read, save]));
    const record = getTaskProgress(20)!;
    assert.equal(record.checklist?.source, "outcomes");
    assert.equal(record.checklist?.runId, "run-a");
    assert.deepEqual(
      record.checklist?.steps.map((step) => [step.label, step.status]),
      [
        ["Read the paper", "completed"],
        ["Save the summary as a note", "pending"],
      ],
    );
    assert.equal(record.checklist?.done, 1);
    assert.equal(record.checklist?.total, 2);
    assert.isTrue(record.planSeen, "the row applies, even in a one-paper chat");
    assert.equal(displayedTaskRunState(record), "working");
  });

  it("sizes the scope its scope-wide parts froze, once per paper, and says nothing without one", function () {
    beginTaskRun(29, { runId: "run-a" });
    setTaskOutcomes(
      29,
      "run-a",
      outcomeCheckpoint([
        outcomeTask("read-all", {
          effect: "read",
          scope: true,
          targets: ["item:1", "item:2", "item:3"],
        }),
        outcomeTask("note-all", {
          scope: true,
          targets: ["item:2", "item:3", "item:4"],
        }),
        save,
      ]),
    );
    assert.equal(getTaskProgress(29)!.checklist?.scopePapers, 4);
    setTaskOutcomes(29, "run-a", outcomeCheckpoint([read, save]));
    assert.notProperty(getTaskProgress(29)!.checklist!, "scopePapers");
  });

  it("marks a digest part's step so its row counts the papers summarized", function () {
    beginTaskRun(30, { runId: "run-a" });
    setTaskOutcomes(
      30,
      "run-a",
      outcomeCheckpoint([
        outcomeTask("summaries", {
          description: "Summarize each selected paper",
          effect: "digest",
          targets: ["item:1", "item:2"],
          doneTargets: ["item:1"],
        }),
        read,
        save,
      ]),
    );
    assert.deepEqual(
      getTaskProgress(30)!.checklist?.steps.map((step) => [
        step.outcome?.digest,
        step.outcome?.read,
        step.outcome?.write,
        step.outcome?.targets,
        step.outcome?.doneTargets,
      ]),
      [
        [true, false, false, 2, 1],
        [false, true, false, 0, 1],
        [false, false, true, 1, 0],
      ],
    );
  });

  it("carries a part's excluded papers and its replacement to its step, and counts the steps without a replaced part", function () {
    beginTaskRun(31, { runId: "run-a" });
    const excludedTargets = [
      { targets: ["item:2", "item:3"], reason: "Off the question" },
    ];
    setTaskOutcomes(
      31,
      "run-a",
      outcomeCheckpoint([
        outcomeTask("old", {
          description: "Read each paper on drift",
          effect: "read",
          status: "cancelled",
          reason: "The user narrowed the question",
          supersededBy: "execution-1:task:review",
        }),
        outcomeTask("review", {
          description: "Write the review",
          effect: "artifact",
          status: "completed",
          targets: ["item:1", "item:2", "item:3"],
          doneTargets: ["item:1"],
          excludedTargets,
        }),
      ]),
    );
    const checklist = getTaskProgress(31)!.checklist!;
    assert.deepEqual(
      checklist.steps.map((step) => [
        step.detail,
        step.outcome?.replaced,
        step.outcome?.excluded,
        step.outcome?.exceptions,
      ]),
      [
        ["The user narrowed the question", true, [], []],
        [undefined, false, excludedTargets, []],
      ],
    );
    assert.equal(checklist.done, 1);
    assert.equal(checklist.total, 1, "a replaced part is not a step to do");
  });

  it("changes nothing for a checkpoint with no outcome and no end", function () {
    beginTaskRun(21, { runId: "run-a" });
    const version = getTaskProgress(21)!.version;
    setTaskOutcomes(21, "run-a", outcomeCheckpoint([]));
    assert.equal(getTaskProgress(21)!.version, version);
    assert.isNull(getTaskProgress(21)!.checklist);
    assert.isFalse(getTaskProgress(21)!.planSeen);
  });

  it("is idempotent, and does not repaint when the steps it shows did not change", function () {
    beginTaskRun(22, { runId: "run-a" });
    setTaskOutcomes(22, "run-a", outcomeCheckpoint([read, save]));
    let notified = 0;
    const unsubscribe = subscribeTaskProgress(() => {
      notified += 1;
    });
    try {
      const version = getTaskProgress(22)!.version;
      setTaskOutcomes(22, "run-a", outcomeCheckpoint([read, save]));
      setTaskOutcomes(
        22,
        "run-a",
        outcomeCheckpoint(
          [read, { ...save, receiptIds: ["receipt-failed"], updatedAt: 9 }],
          undefined,
          9,
        ),
      );
      assert.equal(getTaskProgress(22)!.version, version);
      assert.equal(notified, 0);
      setTaskOutcomes(
        22,
        "run-a",
        outcomeCheckpoint([read, { ...save, status: "completed" }]),
      );
      assert.equal(notified, 1, "a step that moved repaints once");
    } finally {
      unsubscribe();
    }
  });

  it("records an end with no outcome without showing steps", function () {
    beginTaskRun(23, { runId: "run-a" });
    setTaskOutcomes(23, "run-a", outcomeCheckpoint([], "blocked"));
    const record = getTaskProgress(23)!;
    assert.deepEqual(record.checklist?.steps, []);
    assert.isFalse(record.planSeen);
    assert.equal(displayedTaskRunState(record), "blocked");
  });

  it("shows the settled end state of its own run, and completeTaskRun does not hide it", function () {
    beginTaskRun(24, { runId: "run-a" });
    setTaskOutcomes(
      24,
      "run-a",
      outcomeCheckpoint(
        [{ ...save, status: "skipped" }],
        "completed_with_exceptions",
      ),
    );
    assert.equal(
      displayedTaskRunState(getTaskProgress(24)),
      "completed_with_exceptions",
    );
    completeTaskRun(24, { runId: "run-a" });
    const record = getTaskProgress(24)!;
    assert.equal(record.runState, "completed");
    assert.equal(displayedTaskRunState(record), "completed_with_exceptions");
    beginTaskRun(24, { runId: "run-b" });
    assert.equal(
      displayedTaskRunState(getTaskProgress(24)),
      "working",
      "a new question starts without the last run's ending",
    );
  });

  it("waits on the user while a decision card is open, and counts as live", function () {
    beginTaskRun(1, { runId: "waiting" });
    markTaskWaiting(1, "waiting", true);
    assert.equal(getTaskProgress(1)!.runState, "waiting");
    for (let key = 2; key <= TASK_PROGRESS_MAX_CONVERSATIONS + 3; key++) {
      completeTaskRun(key, { runId: `r${key}` });
    }
    assert.include(
      listTaskProgressConversations(),
      1,
      "a waiting run is live: never evicted",
    );
    markTaskWaiting(1, "other-run", false);
    assert.equal(getTaskProgress(1)!.runState, "waiting");
    markTaskWaiting(1, "waiting", false);
    assert.equal(getTaskProgress(1)!.runState, "working");
    markTaskWaiting(1, "waiting", true);
    endTaskRun(1, "cancelled", "waiting");
    assert.equal(getTaskProgress(1)!.runState, "cancelled");
    markTaskWaiting(1, "waiting", false);
    markTaskWaiting(1, "waiting", true);
    assert.equal(
      getTaskProgress(1)!.runState,
      "cancelled",
      "a settled run neither works nor waits again",
    );
  });

  it("ignores another run's ledger, and shows an ending only for the run it names", function () {
    beginTaskRun(26, { runId: "run-b" });
    const version = getTaskProgress(26)!.version;
    setTaskOutcomes(26, "run-a", outcomeCheckpoint([save], "blocked"));
    assert.isNull(
      getTaskProgress(26)!.checklist,
      "another run's steps stay out",
    );
    assert.equal(getTaskProgress(26)!.version, version);
    assert.equal(displayedTaskRunState(getTaskProgress(26)), "working");
    // A run the record cannot name yet shows the ledger's steps, but not an
    // ending it cannot tell is its own.
    beginTaskRun(27);
    setTaskOutcomes(27, "run-a", outcomeCheckpoint([save], "blocked"));
    assert.equal(getTaskProgress(27)!.checklist?.runId, "run-a");
    assert.equal(displayedTaskRunState(getTaskProgress(27)), "working");
  });

  it("ends a stream-interrupted run as interrupted", function () {
    beginTaskRun(25, { runId: "run-a" });
    endTaskRun(25, "interrupted", "run-a");
    assert.equal(getTaskProgress(25)!.runState, "interrupted");
  });
});

import { assert } from "chai";
import type { AgentEvent, AgentRunEventRecord } from "../src/agent/types";
import {
  buildTaskPaperCoverage,
  foldTaskPaperLedgerFromRuns,
  type TaskPaperCoverageRun,
} from "../src/agent/context/taskPaperCoverage";
import {
  TASK_PAPER_READ_GRANULARITY_RANK,
  buildDecisionLedgerDelta,
  createTaskPaperLedger,
  applyTaskPaperLedgerDelta,
  type TaskPaperLedgerDelta,
  type TaskPaperReadGranularity,
  type TaskPaperState,
} from "../src/agent/context/taskPaperLedger";
import { buildTaskProgressHistory } from "../src/modules/contextPanel/taskProgress/history";
import {
  clearAllTaskProgress,
  getTaskProgress,
  hydrateTaskProgress,
} from "../src/modules/contextPanel/taskProgress/store";
import type { Message } from "../src/modules/contextPanel/types";

/** A delta that lists `itemId` and reads it once at `granularity`. */
function readDelta(
  runId: string,
  callId: string,
  itemId: number,
  state: TaskPaperState,
  granularity: TaskPaperReadGranularity = "passage",
): TaskPaperLedgerDelta {
  return {
    version: 1,
    callId,
    runId,
    toolName: "paper_read",
    papers: [
      {
        key: `1:${itemId}`,
        libraryID: 1,
        itemId,
        title: `Paper ${itemId}`,
        year: "2021",
        creator: "Smith",
        itemKey: `KEY${itemId}`,
        state,
      },
    ],
    reads: [
      {
        key: `1:${itemId}`,
        callId,
        toolName: "paper_read",
        granularity,
        snippet: `snippet ${itemId}`,
      },
    ],
  };
}

function decideDelta(
  runId: string,
  callId: string,
  itemId: number,
  value: "include" | "exclude" | "defer",
  reason = `because ${value}`,
): TaskPaperLedgerDelta {
  const delta = buildDecisionLedgerDelta({
    runId,
    callId,
    toolName: "record_paper_decisions",
    decisions: [
      {
        paper: { libraryID: 1, itemId, title: `Paper ${itemId}` },
        value,
        reason,
        relevance: "high",
        subquestions: ["methods"],
      },
    ],
  });
  assert.isNotNull(delta);
  return delta!;
}

function ledgerEvent(delta: TaskPaperLedgerDelta): AgentEvent {
  return { type: "paper_ledger_update", callId: delta.callId, delta };
}

function run(
  runId: string,
  turn: number,
  ...deltas: TaskPaperLedgerDelta[]
): TaskPaperCoverageRun {
  return { runId, turn, events: deltas.map(ledgerEvent) };
}

/** A ledger of `count` papers, 1..count, all listed. */
function bigLedger(count: number) {
  const deltas = Array.from({ length: count }, (_, index) =>
    readDelta("run-1", `c${index + 1}`, index + 1, "listed", "metadata"),
  );
  return foldTaskPaperLedgerFromRuns([run("run-1", 1, ...deltas)]);
}

describe("task paper coverage", function () {
  describe("foldTaskPaperLedgerFromRuns", function () {
    it("folds two questions into states, strongest read, latest decision and counts", function () {
      const ledger = foldTaskPaperLedgerFromRuns([
        run(
          "run-1",
          1,
          readDelta("run-1", "c1", 1, "read", "passage"),
          readDelta("run-1", "c2", 2, "matched", "metadata"),
          decideDelta("run-1", "d1", 1, "include"),
        ),
        run(
          "run-2",
          2,
          readDelta("run-2", "c3", 1, "read", "full"),
          readDelta("run-2", "c4", 3, "skimmed", "abstract"),
          decideDelta("run-2", "d2", 1, "exclude"),
          decideDelta("run-2", "d3", 3, "defer"),
        ),
      ]);
      const coverage = buildTaskPaperCoverage(ledger);
      assert.deepEqual(
        coverage.papers.map((row) => row.key),
        ["1:1", "1:2", "1:3"],
      );
      const [one, two, three] = coverage.papers;
      assert.equal(one.state, "read");
      assert.equal(one.strongestGranularity, "full");
      assert.equal(one.readCount, 2);
      assert.equal(one.decision?.value, "exclude");
      assert.equal(one.decision?.turnIndex, 2);
      assert.equal(one.title, "Paper 1");
      assert.equal(one.itemKey, "KEY1");
      assert.equal(two.state, "matched");
      assert.equal(two.strongestGranularity, "metadata");
      assert.isUndefined(two.decision);
      assert.equal(three.state, "skimmed");
      assert.equal(three.decision?.value, "defer");
      assert.deepEqual(coverage.counts, {
        total: 3,
        byState: { listed: 0, matched: 1, skimmed: 1, read: 1, cited: 0 },
        byDecision: { include: 0, exclude: 1, defer: 1 },
        noDecision: 1,
      });
    });

    it("lets a re-run of the same question replace the earlier run's reads and decisions", function () {
      const ledger = foldTaskPaperLedgerFromRuns([
        run(
          "run-a",
          1,
          readDelta("run-a", "c1", 1, "read", "full"),
          decideDelta("run-a", "d1", 1, "include"),
        ),
        run(
          "run-b",
          1,
          readDelta("run-b", "c1", 1, "skimmed", "abstract"),
          decideDelta("run-b", "d1", 1, "exclude"),
        ),
      ]);
      const turn = ledger.papers["1:1"].turns[1];
      assert.equal(turn.readsRunId, "run-b");
      assert.deepEqual(turn.supersededRunIds, ["run-a"]);
      assert.lengthOf(turn.reads, 1);
      assert.equal(turn.reads[0].granularity, "abstract");
      const row = buildTaskPaperCoverage(ledger).papers[0];
      assert.equal(row.strongestGranularity, "abstract");
      assert.equal(row.readCount, 1);
      assert.equal(row.decision?.value, "exclude");
      // The paper's state stays the strongest it ever reached.
      assert.equal(row.state, "read");
    });

    it("keeps a run's own reads when the earlier run of the question comes first in the input", function () {
      // The later run's deltas never make the earlier run take its place back.
      const ledger = foldTaskPaperLedgerFromRuns([
        run("run-a", 1, readDelta("run-a", "c1", 1, "read")),
        run("run-b", 1, readDelta("run-b", "c1", 1, "read", "section")),
        run("run-c", 2, readDelta("run-c", "c1", 1, "read", "page")),
      ]);
      assert.equal(ledger.papers["1:1"].turns[1].readsRunId, "run-b");
      assert.equal(ledger.papers["1:1"].turns[2].readsRunId, "run-c");
      assert.equal(
        buildTaskPaperCoverage(ledger).papers[0].strongestGranularity,
        "section",
      );
    });

    it("matches the panel's history rebuild on the same stored runs", function () {
      const KEY = 640077;
      const runs: TaskPaperCoverageRun[] = [
        run(
          "run-a",
          1,
          readDelta("run-a", "c1", 1, "read", "full"),
          readDelta("run-a", "c2", 2, "matched", "metadata"),
          decideDelta("run-a", "d1", 1, "include"),
        ),
        // Re-run of question 1.
        run(
          "run-b",
          1,
          readDelta("run-b", "c1", 1, "skimmed", "abstract"),
          readDelta("run-b", "c2", 3, "read", "section"),
          decideDelta("run-b", "d1", 3, "defer"),
        ),
        run(
          "run-c",
          2,
          readDelta("run-c", "c1", 1, "read", "passage"),
          readDelta("run-c", "c2", 4, "listed", "metadata"),
          decideDelta("run-c", "d1", 1, "exclude"),
          // A replayed delta.
          readDelta("run-c", "c1", 1, "read", "passage"),
        ),
      ];
      const messages: Message[] = [
        { role: "user", text: "Q1", timestamp: 1 },
        {
          role: "assistant",
          text: "A1",
          timestamp: 2,
          runMode: "agent",
          agentRunId: "run-a",
        },
        {
          role: "assistant",
          text: "A1 again",
          timestamp: 3,
          runMode: "agent",
          agentRunId: "run-b",
        },
        { role: "user", text: "Q2", timestamp: 4 },
        {
          role: "assistant",
          text: "A2",
          timestamp: 5,
          runMode: "agent",
          agentRunId: "run-c",
        },
      ];
      const eventsByRun = new Map<string, AgentRunEventRecord[]>(
        runs.map((entry) => [
          entry.runId,
          entry.events.map((payload, index) => ({
            runId: entry.runId,
            seq: index + 1,
            eventType: payload.type,
            payload,
            createdAt: index + 1,
          })),
        ]),
      );
      try {
        hydrateTaskProgress(
          KEY,
          buildTaskProgressHistory(messages, eventsByRun, 1),
        );
        const panel = getTaskProgress(KEY)!.ledger;
        const folded = foldTaskPaperLedgerFromRuns(runs);
        assert.deepEqual(folded.order, panel.order);
        assert.deepEqual(folded.papers, panel.papers);
        assert.deepEqual(folded.appliedCalls, panel.appliedCalls);
        assert.equal(folded.droppedPapers, panel.droppedPapers);
        assert.equal(folded.lastLibraryID, panel.lastLibraryID);
      } finally {
        clearAllTaskProgress();
      }
    });

    it("folds an old event without a decision as before", function () {
      const old = readDelta("run-1", "c1", 1, "read");
      assert.isUndefined(old.papers[0].decision);
      const folded = foldTaskPaperLedgerFromRuns([run("run-1", 1, old)]);
      const direct = applyTaskPaperLedgerDelta(
        createTaskPaperLedger(),
        old,
        1,
        { runId: "run-1", newerRunIds: [] },
      );
      assert.deepEqual(folded, direct);
      const row = buildTaskPaperCoverage(folded).papers[0];
      assert.isUndefined(row.decision);
      assert.equal(row.readCount, 1);
    });

    it("ignores events that are not ledger events and runs without a question", function () {
      const folded = foldTaskPaperLedgerFromRuns([
        {
          runId: "run-1",
          turn: 1,
          events: [
            { type: "message_delta", text: "hello" },
            { type: "status", text: "working" },
            ledgerEvent(readDelta("run-1", "c1", 1, "read")),
            {
              type: "tool_result",
              callId: "c1",
              name: "paper_read",
              ok: true,
              content: { papers: [{ itemId: 9 }] },
            } as unknown as AgentEvent,
          ],
        },
        // No question number: skipped, as the panel skips it.
        run("run-0", 0, readDelta("run-0", "c9", 7, "read")),
      ]);
      assert.deepEqual(folded.order, ["1:1"]);
      assert.deepEqual(foldTaskPaperLedgerFromRuns([]).order, []);
    });

    it("applies a duplicate delta once", function () {
      const delta = readDelta("run-1", "c1", 1, "read");
      const ledger = foldTaskPaperLedgerFromRuns([
        run("run-1", 1, delta, delta),
      ]);
      assert.lengthOf(ledger.papers["1:1"].turns[1].reads, 1);
      assert.deepEqual(Object.keys(ledger.appliedCalls), ["run-1:c1"]);
    });
  });

  describe("buildTaskPaperCoverage", function () {
    it("returns an empty page for an empty ledger", function () {
      const coverage = buildTaskPaperCoverage(foldTaskPaperLedgerFromRuns([]));
      assert.deepEqual(coverage, {
        papers: [],
        counts: {
          total: 0,
          byState: { listed: 0, matched: 0, skimmed: 0, read: 0, cited: 0 },
          byDecision: { include: 0, exclude: 0, defer: 0 },
          noDecision: 0,
        },
        matched: 0,
        offset: 0,
        limit: 50,
        remaining: 0,
      });
      assert.notProperty(coverage, "nextOffset");
    });

    it("pages with the default limit and reports where the next page starts", function () {
      const ledger = bigLedger(120);
      const first = buildTaskPaperCoverage(ledger);
      assert.equal(first.limit, 50);
      assert.equal(first.offset, 0);
      assert.lengthOf(first.papers, 50);
      assert.equal(first.papers[0].key, "1:1");
      assert.equal(first.nextOffset, 50);
      assert.equal(first.remaining, 70);
      assert.equal(first.counts.total, 120);

      const second = buildTaskPaperCoverage(ledger, { offset: 50 });
      assert.equal(second.papers[0].key, "1:51");
      assert.equal(second.nextOffset, 100);
      assert.equal(second.remaining, 20);

      const last = buildTaskPaperCoverage(ledger, { offset: 100 });
      assert.lengthOf(last.papers, 20);
      assert.equal(last.papers[19].key, "1:120");
      assert.notProperty(last, "nextOffset");
      assert.equal(last.remaining, 0);

      const past = buildTaskPaperCoverage(ledger, { offset: 500 });
      assert.isEmpty(past.papers);
      assert.notProperty(past, "nextOffset");
      assert.equal(past.remaining, 0);
    });

    it("ends exactly at the last row without a next page", function () {
      const coverage = buildTaskPaperCoverage(bigLedger(50));
      assert.lengthOf(coverage.papers, 50);
      assert.notProperty(coverage, "nextOffset");
      assert.equal(coverage.remaining, 0);
    });

    it("clamps invalid limit and offset", function () {
      const ledger = bigLedger(260);
      assert.equal(buildTaskPaperCoverage(ledger, { limit: 1000 }).limit, 200);
      assert.lengthOf(
        buildTaskPaperCoverage(ledger, { limit: 1000 }).papers,
        200,
      );
      assert.equal(buildTaskPaperCoverage(ledger, { limit: 0 }).limit, 1);
      assert.equal(buildTaskPaperCoverage(ledger, { limit: -5 }).limit, 1);
      assert.equal(buildTaskPaperCoverage(ledger, { limit: 2.9 }).limit, 2);
      assert.equal(buildTaskPaperCoverage(ledger, { limit: NaN }).limit, 50);
      assert.equal(
        buildTaskPaperCoverage(ledger, {
          limit: "abc" as unknown as number,
        }).limit,
        50,
      );
      assert.equal(buildTaskPaperCoverage(ledger, { offset: -3 }).offset, 0);
      assert.equal(buildTaskPaperCoverage(ledger, { offset: NaN }).offset, 0);
      assert.equal(buildTaskPaperCoverage(ledger, { offset: 7.8 }).offset, 7);
    });

    describe("filters", function () {
      const ledger = foldTaskPaperLedgerFromRuns([
        run(
          "run-1",
          1,
          readDelta("run-1", "c1", 1, "read", "full"),
          readDelta("run-1", "c2", 2, "matched", "metadata"),
          readDelta("run-1", "c3", 3, "skimmed", "abstract"),
          readDelta("run-1", "c4", 4, "read", "section"),
          decideDelta("run-1", "d1", 1, "include"),
          decideDelta("run-1", "d2", 3, "exclude"),
          decideDelta("run-1", "d3", 4, "include"),
        ),
      ]);

      it("filters by state before paging", function () {
        const coverage = buildTaskPaperCoverage(ledger, {
          filter: { states: ["read", "matched"] },
          limit: 2,
        });
        assert.deepEqual(
          coverage.papers.map((row) => row.key),
          ["1:1", "1:2"],
        );
        assert.equal(coverage.matched, 3);
        assert.equal(coverage.nextOffset, 2);
        assert.equal(coverage.remaining, 1);
        const next = buildTaskPaperCoverage(ledger, {
          filter: { states: ["read", "matched"] },
          offset: 2,
          limit: 2,
        });
        assert.deepEqual(
          next.papers.map((row) => row.key),
          ["1:4"],
        );
        assert.notProperty(next, "nextOffset");
      });

      it("filters by decision value and by no decision", function () {
        const include = buildTaskPaperCoverage(ledger, {
          filter: { decision: "include" },
        });
        assert.deepEqual(
          include.papers.map((row) => row.key),
          ["1:1", "1:4"],
        );
        const none = buildTaskPaperCoverage(ledger, {
          filter: { decision: "none" },
        });
        assert.deepEqual(
          none.papers.map((row) => row.key),
          ["1:2"],
        );
        const both = buildTaskPaperCoverage(ledger, {
          filter: { states: ["read"], decision: "include" },
        });
        assert.lengthOf(both.papers, 2);
        const empty = buildTaskPaperCoverage(ledger, {
          filter: { decision: "defer" },
        });
        assert.isEmpty(empty.papers);
        assert.equal(empty.matched, 0);
      });

      it("keeps the counts on the whole ledger whatever the filter", function () {
        const whole = buildTaskPaperCoverage(ledger).counts;
        for (const filter of [
          { states: ["cited" as const] },
          { decision: "none" as const },
          { states: ["read" as const], decision: "exclude" as const },
        ]) {
          assert.deepEqual(buildTaskPaperCoverage(ledger, { filter }).counts, {
            ...whole,
          });
        }
        assert.deepEqual(whole, {
          total: 4,
          byState: { listed: 0, matched: 1, skimmed: 1, read: 2, cited: 0 },
          byDecision: { include: 2, exclude: 1, defer: 0 },
          noDecision: 1,
        });
      });

      it("treats an empty states list as no state filter", function () {
        assert.equal(
          buildTaskPaperCoverage(ledger, { filter: { states: [] } }).matched,
          4,
        );
      });
    });

    it("keeps rows small: no snippets or read text", function () {
      const row = buildTaskPaperCoverage(
        foldTaskPaperLedgerFromRuns([
          run(
            "run-1",
            1,
            readDelta("run-1", "c1", 1, "read", "passage"),
            decideDelta("run-1", "d1", 1, "include"),
          ),
        ]),
      ).papers[0];
      assert.sameMembers(Object.keys(row), [
        "key",
        "libraryID",
        "itemId",
        "itemKey",
        "title",
        "year",
        "creator",
        "state",
        "strongestGranularity",
        "readCount",
        "decision",
      ]);
      assert.deepEqual(row.decision, {
        value: "include",
        relevance: "high",
        subquestions: ["methods"],
        reason: "because include",
        turnIndex: 1,
      });
      assert.notInclude(JSON.stringify(row), "snippet");
    });

    it("ranks every read granularity", function () {
      const ranks = Object.values(TASK_PAPER_READ_GRANULARITY_RANK);
      assert.lengthOf(new Set(ranks), ranks.length);
      assert.isAbove(
        TASK_PAPER_READ_GRANULARITY_RANK.full,
        TASK_PAPER_READ_GRANULARITY_RANK.section,
      );
      assert.isAbove(
        TASK_PAPER_READ_GRANULARITY_RANK.passage,
        TASK_PAPER_READ_GRANULARITY_RANK.digest,
      );
      assert.isAbove(
        TASK_PAPER_READ_GRANULARITY_RANK.digest,
        TASK_PAPER_READ_GRANULARITY_RANK.outline,
      );
    });
  });
});

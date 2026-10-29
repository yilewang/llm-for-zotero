/**
 * The paper decision tools through real storage.
 *
 * The plugin's own Agent records decisions with record_paper_decisions in
 * one turn (only the model is scripted): the decisions show on the Task
 * progress paper rows, are saved as the run's `paper_ledger_update` event,
 * survive reopening the conversation as after a restart, and review_coverage
 * over the plugin's MCP endpoint (the plugin's own Agent does not list it)
 * returns them with the right counts. Then the same round
 * trip over the plugin's MCP endpoint: a scoped record_paper_decisions call
 * carries its delta on the activity, which is stored as a connected
 * runtime's observer stores it, and review_coverage over MCP counts it.
 */
import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
  WorkflowTestStandaloneNoteFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const SCREEN = "Screen these papers for a review of drift mechanisms.";
const SCREEN_ANSWER = "One paper is in scope, one is not.";

describe("workflow: paper decision tools", function () {
  this.timeout(180000);
  const prefs: Array<[string, unknown]> = [
    ["extensions.zotero.llmforzotero.enableAgentMode", true],
    ["extensions.zotero.llmforzotero.lastUsedRuntimeMode", "agent"],
  ];
  const saved = new Map<string, unknown>();
  let api: WorkflowTestApi;
  let libraryID: number;
  let included: WorkflowTestFixture;
  let excluded: WorkflowTestFixture;
  let deferred: WorkflowTestFixture;
  let note: WorkflowTestStandaloneNoteFixture;

  const keyOf = (fixture: WorkflowTestFixture) =>
    `${libraryID}:${fixture.parentItemId}`;

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    for (const [name, value] of prefs) {
      saved.set(name, Zotero.Prefs.get(name, true));
      Zotero.Prefs.set(name, value as never, true);
    }
    libraryID = Zotero.Libraries.userLibraryID;
    included = await api.createPaperWithPdfFixture({
      title: "Drift from excitability",
      pdfTitle: "Drift from excitability",
      pages: ["Drift from excitability. Abstract. Drift over days."],
    });
    excluded = await api.createPaperWithPdfFixture({
      title: "Motor learning in birds",
      pdfTitle: "Motor learning in birds",
      pages: ["Motor learning in birds. Abstract. Song over weeks."],
    });
    deferred = await api.createPaperWithPdfFixture({
      title: "Place fields over months",
      pdfTitle: "Place fields over months",
      pages: ["Place fields over months. Abstract. Remapping."],
    });
    note = await api.createStandaloneNoteFixture({
      noteHtml: "<p>A reading note, not a paper.</p>",
    });
  });

  after(async function () {
    await api.reset();
    for (const fixture of [included, excluded, deferred, note]) {
      if (fixture) await api.cleanupFixture(fixture);
    }
    for (const [name, value] of saved) {
      if (value === undefined) Zotero.Prefs.clear(name, true);
      else Zotero.Prefs.set(name, value as never, true);
    }
  });

  it("records the Agent's decisions, keeps them through a reopen, and review_coverage counts them", async function () {
    const panel = await api.renderPanelForItem(included.parentItemId);
    const screen = await api.exercisePaperDecisionsTurn({
      panelId: panel.panelId,
      question: SCREEN,
      answer: SCREEN_ANSWER,
      calls: [
        {
          id: "decide-1",
          name: "record_paper_decisions",
          arguments: {
            decisions: [
              {
                target: `item:${included.parentItemId}`,
                decision: "include",
                relevance: "high",
                subquestions: ["mechanisms"],
                reason: "Proposes excitability as a drift mechanism.",
              },
              {
                // Its PDF stands for the paper.
                target: String(excluded.pdfAttachmentId),
                decision: "exclude",
                relevance: "none",
                reason: "Motor learning, not drift.",
              },
              {
                target: String(note.noteItemId),
                decision: "include",
                reason: "A note.",
              },
            ],
          },
        },
      ],
    });
    assert.equal(screen.runStatus, "completed");
    assert.deepEqual(screen.results["decide-1"], {
      ok: true,
      recorded: 2,
      decisions: { include: 1, exclude: 1, defer: 0 },
      rejected: [
        {
          row: 3,
          target: String(note.noteItemId),
          reason: "This item is not a paper.",
        },
      ],
    });
    // Stored in the real run-event table, right after the call's result.
    const stored = screen.events.filter(
      (event) => event.type === "paper_ledger_update",
    ) as Array<
      Extract<(typeof screen.events)[number], { type: "paper_ledger_update" }>
    >;
    assert.lengthOf(stored, 1);
    assert.equal(stored[0].delta.callId, "decide-1");
    assert.equal(stored[0].delta.runId, screen.runId);
    assert.deepEqual(stored[0].delta.reads, []);

    const check = (label: string) => {
      const snapshot = api.getTaskProgressSnapshot(screen.conversationKey);
      assert.isOk(snapshot, `the ledger exists (${label})`);
      const kept = snapshot!.paperRows[keyOf(included)];
      const dropped = snapshot!.paperRows[keyOf(excluded)];
      assert.isOk(kept && dropped, `both papers have rows (${label})`);
      assert.notProperty(
        snapshot!.paperRows,
        keyOf(deferred),
        `an undecided, unread paper has no row (${label})`,
      );
      for (const row of [kept, dropped]) {
        assert.equal(row.state, "listed", "a decision never moves a state");
        assert.deepEqual(row.reads, [], "a decision is not a read");
      }
      assert.deepInclude(kept.decision!, {
        value: "include",
        relevance: "high",
        subquestions: ["mechanisms"],
        reason: "Proposes excitability as a drift mechanism.",
        origin: "agent",
        callId: "decide-1",
        turnIndex: 1,
      });
      assert.deepInclude(dropped.decision!, {
        value: "exclude",
        relevance: "none",
        reason: "Motor learning, not drift.",
        callId: "decide-1",
        turnIndex: 1,
      });
    };
    check("live");
    await api.reopenTaskProgressConversation({ panelId: panel.panelId });
    assert.isTrue(
      api.getTaskProgressSnapshot(screen.conversationKey)!.hydrated,
      "history replayed",
    );
    check("reopened");

    // review_coverage is for Codex and Claude Code over MCP: the plugin's own
    // Agent does not list it. Read the same stored decisions through the MCP
    // endpoint, under a scope for this conversation.
    const resumed = await api.callScopedMcpToolForConversation({
      panelId: panel.panelId,
      runId: `mcp-coverage-${Date.now()}`,
      name: "review_coverage",
      arguments: {},
    });
    const coverage = resumed.result as Record<string, any>;
    assert.isTrue(coverage.ok, JSON.stringify(coverage));
    assert.deepEqual(coverage.counts, {
      total: 2,
      byState: { listed: 2, matched: 0, skimmed: 0, read: 0, cited: 0 },
      byDecision: { include: 1, exclude: 1, defer: 0 },
      noDecision: 0,
    });
    assert.deepEqual(
      coverage.papers.map((row: Record<string, any>) => [
        row.itemId,
        row.title,
        row.decision.value,
        row.decision.turnIndex,
      ]),
      [
        [included.parentItemId, "Drift from excitability", "include", 1],
        [excluded.parentItemId, "Motor learning in birds", "exclude", 1],
      ],
    );
  });

  it("round-trips decisions over the plugin's MCP endpoint", async function () {
    const panel = await api.renderPanelForItem(deferred.parentItemId);
    const runId = `mcp-decisions-${Date.now()}`;
    const decided = await api.callScopedMcpToolForConversation({
      panelId: panel.panelId,
      runId,
      name: "record_paper_decisions",
      arguments: {
        decisions: [
          {
            target: String(deferred.parentItemId),
            decision: "defer",
            reason: "Abstract only so far.",
          },
        ],
      },
    });
    assert.deepEqual(decided.result, {
      ok: true,
      recorded: 1,
      decisions: { include: 0, exclude: 0, defer: 1 },
    });
    const delta = decided.activity?.paperLedgerDelta;
    assert.isOk(delta, "the completed activity carries the call's delta");
    assert.equal(delta!.runId, runId);
    assert.deepEqual(
      delta!.papers.map((paper) => [paper.key, paper.state, paper.decision]),
      [
        [
          keyOf(deferred),
          "listed",
          { value: "defer", reason: "Abstract only so far.", origin: "agent" },
        ],
      ],
    );

    // Stored as a connected runtime's observer stores it: the activity's
    // delta as the run's `paper_ledger_update` event.
    const { conversationKey } = await api.seedTaskProgressConversation({
      panelId: panel.panelId,
      turns: [
        {
          runId,
          user: { text: SCREEN },
          answer: SCREEN_ANSWER,
          events: [
            {
              type: "paper_ledger_update",
              callId: delta!.callId,
              delta: delta!,
            },
            { type: "final", text: SCREEN_ANSWER },
          ],
        },
      ],
    });
    await api.reopenTaskProgressConversation({ panelId: panel.panelId });
    const row =
      api.getTaskProgressSnapshot(conversationKey)!.paperRows[keyOf(deferred)];
    assert.isOk(row, "the stored decision replays on the paper's row");
    assert.equal(row.decision?.value, "defer");

    const reviewed = await api.callScopedMcpToolForConversation({
      panelId: panel.panelId,
      runId: `mcp-review-${Date.now()}`,
      name: "review_coverage",
      arguments: { decision: "defer" },
    });
    const coverage = reviewed.result as Record<string, any>;
    assert.isTrue(coverage.ok, JSON.stringify(coverage));
    assert.equal(coverage.counts.byDecision.defer, 1);
    assert.deepEqual(
      coverage.papers.map((paper: Record<string, any>) => paper.itemId),
      [deferred.parentItemId],
    );
    assert.notProperty(
      reviewed.activity || {},
      "paperLedgerDelta",
      "a coverage read records nothing",
    );
  });
});

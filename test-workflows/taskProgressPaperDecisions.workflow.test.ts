/**
 * The agent's paper decisions in the Task progress ledger survive storage:
 * a run's `paper_ledger_update` events that carry decisions are saved in the
 * real run-event table, the conversation is reopened as after a restart, and
 * the rebuilt ledger holds each question's latest decision without moving a
 * paper's state. An event saved before decisions existed replays as before.
 */
import { assert } from "chai";
import { buildDecisionLedgerDelta } from "../src/agent/context/taskPaperLedger";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const FIRST = "Which papers in this folder measure drift?";
const FIRST_ANSWER = "Both papers measure it.";
const SECOND = "Screen the folder for a review of drift mechanisms.";
const SECOND_ANSWER = "One paper is in scope; the other is not.";

describe("workflow: task progress paper decisions", function () {
  this.timeout(120000);
  const prefs: Array<[string, unknown]> = [
    ["extensions.zotero.llmforzotero.enableAgentMode", true],
    ["extensions.zotero.llmforzotero.lastUsedRuntimeMode", "agent"],
  ];
  const saved = new Map<string, unknown>();
  let api: WorkflowTestApi;
  let libraryID: number;
  let included: WorkflowTestFixture;
  let excluded: WorkflowTestFixture;
  let collection: Zotero.Collection;

  const keyOf = (fixture: WorkflowTestFixture) =>
    `${libraryID}:${fixture.parentItemId}`;

  /** A read event as stored before decisions existed: no `decision` field. */
  function oldShapeRead(callId: string, runId: string) {
    const papers = [included, excluded];
    return {
      type: "paper_ledger_update" as const,
      callId,
      delta: {
        version: 1 as const,
        callId,
        runId,
        toolName: "library_retrieve",
        papers: papers.map((fixture) => ({
          key: keyOf(fixture),
          libraryID,
          itemId: fixture.parentItemId,
          contextItemId: fixture.pdfAttachmentId,
          text: "pdf_text" as const,
          state: "read" as const,
        })),
        reads: papers.map((fixture) => ({
          key: keyOf(fixture),
          callId,
          toolName: "library_retrieve",
          granularity: "passage" as const,
          method: "bm25",
          label: "Abstract",
          snippet: "Drift over days.",
        })),
      },
    };
  }

  function decisions(
    callId: string,
    runId: string,
    rows: Parameters<typeof buildDecisionLedgerDelta>[0]["decisions"],
  ) {
    const delta = buildDecisionLedgerDelta({
      callId,
      runId,
      toolName: "record_paper_decisions",
      decisions: rows,
    });
    assert.isNotNull(delta, "the decisions build a delta");
    return { type: "paper_ledger_update" as const, callId, delta: delta! };
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    for (const [name, value] of prefs) {
      saved.set(name, Zotero.Prefs.get(name, true));
      Zotero.Prefs.set(name, value as never, true);
    }
    libraryID = Zotero.Libraries.userLibraryID;
    collection = new Zotero.Collection();
    (collection as { libraryID: number }).libraryID = libraryID;
    collection.name = `Paper decisions ${Date.now()}`;
    await collection.saveTx();
    included = await api.createPaperWithPdfFixture({
      title: "Drift from excitability",
      pdfTitle: "Drift from excitability",
      pages: ["Drift from excitability. Abstract. Drift over days."],
    });
    excluded = await api.createPaperWithPdfFixture({
      title: "Motor learning in birds",
      pdfTitle: "Motor learning in birds",
      pages: ["Motor learning in birds. Abstract. Drift over days."],
    });
  });

  after(async function () {
    await api.reset();
    if (included) await api.cleanupFixture(included);
    if (excluded) await api.cleanupFixture(excluded);
    await collection?.eraseTx().catch(() => undefined);
    for (const [name, value] of saved) {
      if (value === undefined) Zotero.Prefs.clear(name, true);
      else Zotero.Prefs.set(name, value as never, true);
    }
  });

  it("keeps each question's decisions through a restart and replays old events unchanged", async function () {
    const panel = await api.renderPanelForItem(included.parentItemId);
    const scope = {
      selectedCollectionContexts: [
        { collectionId: collection.id, name: collection.name, libraryID },
      ],
    };
    const first = `tp-decisions-1-${Date.now()}`;
    const second = `tp-decisions-2-${Date.now()}`;
    const paperOf = (fixture: WorkflowTestFixture) => ({
      libraryID,
      itemId: fixture.parentItemId,
    });
    const { conversationKey } = await api.seedTaskProgressConversation({
      panelId: panel.panelId,
      turns: [
        {
          runId: first,
          user: { text: FIRST, ...scope },
          answer: FIRST_ANSWER,
          events: [
            oldShapeRead("c1", first),
            { type: "final", text: FIRST_ANSWER },
          ],
        },
        {
          runId: second,
          user: { text: SECOND, ...scope },
          answer: SECOND_ANSWER,
          events: [
            decisions("d1", second, [
              {
                paper: paperOf(included),
                value: "defer",
                reason: "Abstract only so far.",
              },
              {
                paper: paperOf(excluded),
                value: "exclude",
                relevance: "none",
                reason: "Motor learning, not drift mechanisms.",
              },
            ]),
            // A later call of the same run replaces the paper's decision.
            decisions("d2", second, [
              {
                paper: paperOf(included),
                value: "include",
                relevance: "high",
                subquestions: ["mechanisms"],
                reason: "Proposes excitability as a drift mechanism.",
              },
            ]),
            { type: "final", text: SECOND_ANSWER },
          ],
        },
      ],
    });

    // Twice: the second reopen replays the same stored events again.
    for (const pass of [1, 2]) {
      await api.reopenTaskProgressConversation({ panelId: panel.panelId });
      const snapshot = api.getTaskProgressSnapshot(conversationKey);
      assert.isOk(snapshot, `the ledger is rebuilt (pass ${pass})`);
      assert.isTrue(snapshot!.hydrated, `history replayed (pass ${pass})`);
      const kept = snapshot!.paperRows[keyOf(included)];
      const dropped = snapshot!.paperRows[keyOf(excluded)];
      assert.isOk(kept && dropped, `both papers have rows (pass ${pass})`);

      // The old-shape event replays as before: its reads and state.
      for (const row of [kept, dropped]) {
        assert.equal(row.state, "read", "a decision never moves a state");
        assert.deepEqual(
          row.reads.map((read) => [read.turnIndex, read.granularity]),
          [[1, "passage"]],
          "the stored read replays, apart from any decision",
        );
      }

      // Only the second question decided; its last call won.
      assert.lengthOf(kept.decisions, 1);
      assert.deepInclude(kept.decision!, {
        value: "include",
        relevance: "high",
        subquestions: ["mechanisms"],
        reason: "Proposes excitability as a drift mechanism.",
        origin: "agent",
        callId: "d2",
        runId: second,
        turnIndex: 2,
      });
      assert.lengthOf(dropped.decisions, 1);
      assert.deepInclude(dropped.decision!, {
        value: "exclude",
        relevance: "none",
        reason: "Motor learning, not drift mechanisms.",
        origin: "agent",
        callId: "d1",
        runId: second,
        turnIndex: 2,
      });
    }
  });
});

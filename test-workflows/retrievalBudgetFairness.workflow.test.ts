/**
 * A passage budget smaller than the matching papers: every matching paper
 * either gets a passage or is marked `not_returned_budget`, never "no
 * evidence", and the budget goes one passage per paper before any paper gets
 * a second. A paper_read of several papers with topK 1 reads each of them.
 * Real Zotero items with real PDFs, read through the installed plugin's tools.
 */
import { assert } from "chai";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import { normalizeExecutionOutput } from "../src/agent/tools/execution/results";
import type { AgentToolContext } from "../src/agent/types";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const PAPER_COUNT = 8;
/** Below the paper count, and below the unindexed-paper fallback cap (5). */
const SNIPPET_CAP = 4;

type PaperMatchRow = {
  itemId: string;
  matchStatus: string;
  returnedSnippetCount: number;
  passageStatus?: string;
};

describe("workflow: retrieval budget fairness", function () {
  this.timeout(180000);
  let api: WorkflowTestApi;
  let libraryID: number;
  let collection: Zotero.Collection;
  const fixtures: WorkflowTestFixture[] = [];

  function toolContext(userText: string): AgentToolContext {
    return {
      item: null,
      currentAnswerText: "",
      modelName: "workflow",
      request: resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        userText,
        libraryID,
      }),
      runId: `retrieval-budget:${Date.now()}`,
    };
  }

  async function runTool(
    name: string,
    args: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<{ tool: any; input: unknown; content: any }> {
    const tool = (Zotero as any).LLMForZotero.api.agent.getToolDefinition(name);
    const validated = tool.validate(args);
    assert.isTrue(validated.ok, JSON.stringify(validated));
    const content = normalizeExecutionOutput(
      await tool.execute(validated.value, context),
    ).content;
    return { tool, input: validated.value, content };
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    libraryID = Zotero.Libraries.userLibraryID;
    collection = new Zotero.Collection();
    (collection as { libraryID: number }).libraryID = libraryID;
    collection.name = `Retrieval budget ${Date.now()}`;
    await collection.saveTx();
    for (let index = 0; index < PAPER_COUNT; index += 1) {
      const title = `Representational drift in place cells, study ${index + 1}`;
      const fixture = await api.createPaperWithPdfFixture({
        title,
        pdfTitle: title,
        pages: [
          `Introduction. Representational drift changes hippocampal place cell maps over days in cohort ${index + 1}.`,
          `Results. Representational drift rate ${index + 1} was measured across sessions; the population readout stayed stable while single place fields drifted.`,
          `Discussion. Representational drift may reflect continual learning in cohort ${index + 1}.`,
        ],
      });
      fixtures.push(fixture);
      const item = Zotero.Items.get(fixture.parentItemId);
      item.setCollections([collection.id]);
      await item.saveTx();
    }
  });

  after(async function () {
    for (const fixture of fixtures) await api.cleanupFixture(fixture);
    await collection?.eraseTx().catch(() => undefined);
    await api.reset();
  });

  it("gives every matching paper a passage or marks it cut by the budget", async function () {
    const { tool, input, content } = await runTool(
      "library_retrieve",
      {
        scope: { collectionIds: [collection.id] },
        query: "representational drift",
        intent: "enumerate",
        depth: "evidence",
        perPaperTopK: 3,
        maxTotalSnippets: SNIPPET_CAP,
      },
      toolContext("Which papers measure representational drift?"),
    );
    const ours = new Set(
      fixtures.map((fixture) => String(fixture.parentItemId)),
    );
    const rows = (content.paperMatches as PaperMatchRow[]).filter((row) =>
      ours.has(row.itemId),
    );
    assert.lengthOf(rows, PAPER_COUNT, "every paper in the folder matches");
    const snippets = content.snippets as Array<{ itemId: string }>;
    assert.isAtMost(snippets.length, SNIPPET_CAP);
    const snippetPapers = new Set(snippets.map((snippet) => snippet.itemId));
    assert.equal(
      snippetPapers.size,
      snippets.length,
      "one passage per paper before any paper gets a second",
    );
    for (const row of rows) {
      assert.isTrue(
        row.returnedSnippetCount > 0 ||
          row.passageStatus === "not_returned_budget",
        `paper ${row.itemId} has a passage or the budget status: ${JSON.stringify(row)}`,
      );
      if (row.passageStatus === "not_returned_budget") {
        assert.equal(row.returnedSnippetCount, 0, row.itemId);
        assert.isFalse(snippetPapers.has(row.itemId), row.itemId);
      }
    }
    assert.isAtLeast(
      rows.filter((row) => row.passageStatus === "not_returned_budget").length,
      PAPER_COUNT - SNIPPET_CAP,
      "the papers past the cap are marked, not dropped",
    );
    assert.equal(content.frontier.stopReason, "budget_limit");

    // What the model reads keeps the budget status on each cut paper's row.
    const view = tool.buildModelView(
      input,
      content,
      toolContext("Which papers measure representational drift?"),
    );
    const viewRows = (view.content.paperMatches as PaperMatchRow[]).filter(
      (row) => ours.has(row.itemId),
    );
    for (const row of rows.filter(
      (entry) => entry.passageStatus === "not_returned_budget",
    )) {
      assert.equal(
        viewRows.find((entry) => entry.itemId === row.itemId)?.passageStatus,
        "not_returned_budget",
        `the model view keeps the status of paper ${row.itemId}`,
      );
    }
  });

  it("reads every target of a several-paper paper_read with topK 1", async function () {
    const targets = fixtures.slice(0, 4).map((fixture) => ({
      itemId: fixture.parentItemId,
      contextItemId: fixture.pdfAttachmentId,
    }));
    const { content } = await runTool(
      "paper_read",
      {
        mode: "targeted",
        query: "representational drift rate across sessions",
        topK: 1,
        targets,
      },
      toolContext("Compare the drift rates of these papers."),
    );
    const papers = content.papers as Array<{
      paperContext: { itemId: number };
      status: string;
      passages: unknown[];
    }>;
    assert.sameMembers(
      papers.map((paper) => paper.paperContext.itemId),
      targets.map((target) => target.itemId),
    );
    for (const paper of papers) {
      assert.notEqual(
        paper.status,
        "no_matches",
        `paper ${paper.paperContext.itemId} is read`,
      );
      assert.isAtLeast(
        paper.passages.length,
        1,
        `${paper.paperContext.itemId}`,
      );
    }
  });
});

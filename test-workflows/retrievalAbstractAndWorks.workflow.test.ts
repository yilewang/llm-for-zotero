/**
 * A paper with no PDF answers from its abstract: library_retrieve returns one
 * passage marked `sourceKind: "abstract"`, with no quote anchor. A preprint
 * and its journal version (different DOIs, same title before the subtitle,
 * same first author, close years) are marked as one work: both rows share a
 * workGroupId and keep their own passages. Real Zotero items, read through
 * the installed plugin's tools.
 */
import { assert } from "chai";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import { normalizeExecutionOutput } from "../src/agent/tools/execution/results";
import type { AgentToolContext } from "../src/agent/types";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const PHRASE = "hexagonal lattice map";

type PaperMatchRow = {
  itemId: string;
  title: string;
  returnedSnippetCount: number;
  passageStatus?: string;
  workGroupId?: string;
};

type SnippetRow = {
  itemId: string;
  contextItemId?: string;
  sourceKind: string;
  chunkKind?: string;
  quoteCitationId?: string;
  snippet: string;
};

describe("workflow: abstract-only papers and same-work marking", function () {
  this.timeout(180000);
  let api: WorkflowTestApi;
  let libraryID: number;
  let collection: Zotero.Collection;
  let abstractOnly: Zotero.Item;
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
      runId: `retrieval-abstract-works:${Date.now()}`,
    };
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    libraryID = Zotero.Libraries.userLibraryID;
    const stamp = Date.now();
    collection = new Zotero.Collection();
    (collection as { libraryID: number }).libraryID = libraryID;
    collection.name = `Abstract and works ${stamp}`;
    await collection.saveTx();

    abstractOnly = new Zotero.Item("journalArticle");
    abstractOnly.libraryID = libraryID;
    abstractOnly.setField("title", `Grid cell coding of space ${stamp}`);
    abstractOnly.setField(
      "abstractNote",
      `Grid cells in entorhinal cortex form a ${PHRASE} that supports path integration.`,
    );
    abstractOnly.setField("date", "2021");
    abstractOnly.setCreators([
      { firstName: "Lena", lastName: "Okafor", creatorType: "author" },
    ]);
    abstractOnly.setCollections([collection.id]);
    await abstractOnly.saveTx();

    const title = `Hexagonal lattice maps support path integration in rodents ${stamp}`;
    const versions = [
      {
        title,
        doi: `10.48550/arXiv.2301.${String(stamp % 100000).padStart(5, "0")}`,
        date: "2023",
      },
      {
        title: `${title}: evidence from tetrode recordings`,
        doi: `10.1016/j.workflow.${stamp}`,
        date: "2024",
      },
    ];
    for (const version of versions) {
      const fixture = await api.createPaperWithPdfFixture({
        title: version.title,
        pdfTitle: version.title,
        pages: [
          `Introduction. Grid cells were recorded in rodents (${version.date}).`,
          `Results. Grid cells form a ${PHRASE} during navigation in the ${version.date} cohort.`,
        ],
      });
      fixtures.push(fixture);
      const item = Zotero.Items.get(fixture.parentItemId);
      item.setField("DOI", version.doi);
      item.setField("date", version.date);
      item.setCreators([
        { firstName: "Ada", lastName: "Moser", creatorType: "author" },
      ]);
      item.setCollections([collection.id]);
      await item.saveTx();
    }
  });

  after(async function () {
    for (const fixture of fixtures) await api.cleanupFixture(fixture);
    await abstractOnly?.eraseTx().catch(() => undefined);
    await collection?.eraseTx().catch(() => undefined);
    await api.reset();
  });

  it("returns the no-PDF paper's abstract as a passage and marks the two versions as one work", async function () {
    const context = toolContext(`Which papers report a ${PHRASE}?`);
    const tool = (Zotero as any).LLMForZotero.api.agent.getToolDefinition(
      "library_retrieve",
    );
    const validated = tool.validate({
      scope: { collectionIds: [collection.id] },
      query: PHRASE,
      intent: "verify",
      depth: "verify",
    });
    assert.isTrue(validated.ok, JSON.stringify(validated));
    const content = normalizeExecutionOutput(
      await tool.execute(validated.value, context),
    ).content as any;

    // The abstract-only paper: one abstract passage, no quote anchor.
    const abstractId = String(abstractOnly.id);
    const abstractPassages = (content.snippets as SnippetRow[]).filter(
      (snippet) => snippet.itemId === abstractId,
    );
    assert.lengthOf(abstractPassages, 1, JSON.stringify(content.snippets));
    assert.equal(abstractPassages[0].sourceKind, "abstract");
    assert.equal(abstractPassages[0].chunkKind, "abstract");
    assert.include(abstractPassages[0].snippet, PHRASE);
    assert.isUndefined(abstractPassages[0].contextItemId);
    assert.isUndefined(abstractPassages[0].quoteCitationId);
    assert.notInclude(
      ((content.quoteCitations || []) as Array<{ itemId?: number }>).map(
        (citation) => String(citation.itemId),
      ),
      abstractId,
    );

    // The two versions: one work, two rows, each with its own passage.
    const rows = content.paperMatches as PaperMatchRow[];
    const versionRows = fixtures.map((fixture) =>
      rows.find((row) => row.itemId === String(fixture.parentItemId)),
    );
    for (const row of versionRows) {
      assert.isDefined(row, JSON.stringify(rows));
      assert.isString(row!.workGroupId, JSON.stringify(row));
      assert.isAtLeast(row!.returnedSnippetCount, 1, JSON.stringify(row));
    }
    assert.equal(versionRows[0]!.workGroupId, versionRows[1]!.workGroupId);
    assert.isUndefined(
      rows.find((row) => row.itemId === abstractId)?.workGroupId,
      "a paper with no other version gets no work group",
    );
    const coverage = content.resourcePool.queryCoverage;
    assert.equal(coverage.evidencePapers, 3);
    assert.equal(coverage.evidenceWorks, 2, "the two versions count once");

    // What the model reads keeps the abstract passage and the work group.
    const view = tool.buildModelView(validated.value, content, context);
    const viewPassage = (view.content.snippets as SnippetRow[]).find(
      (snippet) => snippet.itemId === abstractId,
    );
    assert.equal(viewPassage?.sourceKind, "abstract");
    const viewRows = view.content.paperMatches as PaperMatchRow[];
    for (const row of versionRows) {
      assert.equal(
        viewRows.find((entry) => entry.itemId === row!.itemId)?.workGroupId,
        row!.workGroupId,
      );
    }
  });
});

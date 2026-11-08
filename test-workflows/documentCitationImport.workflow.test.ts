import "./hostSurfaceBootstrap";
import { assert } from "chai";
import type { OutsidePaperRecord } from "../src/agent/context/outsidePaperRecords";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import {
  finalizeDocument,
  persistFinalizedDocument,
} from "../src/agent/documents/finalizer";
import { buildOutsidePaperSnapshots } from "../src/agent/documents/outsidePaperCitations";
import { deliverPendingPlanDocumentMessage } from "../src/agent/documents/publication";
import {
  clearPlanDocumentConversationRowsInTransaction,
  loadPlanDocument,
} from "../src/agent/documents/store";
import {
  isOutsideBibliographyEntry,
  type DocumentArtifactV2,
  type PlanCitationCluster,
} from "../src/agent/documents/types";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type { AgentToolContext } from "../src/agent/types";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";

/**
 * A later import of a review's outside papers (library_import
 * kind:'document_citations') against the live library: one cited paper is
 * already an item (found by its DOI, not imported again), one is imported
 * through Zotero's real ItemSaver with only the network translator
 * substituted, and a URL-only paper stays outside. The new version's card
 * links the two papers to their items, keeps the third outside with its
 * "Not in library" marker, records the version it revises, and the stored
 * document is unchanged.
 */
describe("workflow: later import of a document's outside papers", function () {
  this.timeout(60000);
  const native = Zotero as any;
  const suffix = String(Date.now()).slice(-5);
  const alphaDoi = `10.1000/later-import-alpha-${suffix}`;
  const betaArxiv = `2101.${suffix}`;
  const gammaUrl = `https://lab.example/later-import-${suffix}`;
  let api: WorkflowTestApi;
  let paper: Zotero.Item;
  let existing: Zotero.Item;
  const created: number[] = [];
  let originalSearch: unknown;
  let originalMode: ReturnType<typeof getOriginalAgentPermissionMode>;

  beforeEach(async function () {
    api = native.LLMForZotero.api.workflowTest;
    await api.reset();
    originalMode = getOriginalAgentPermissionMode();
    originalSearch = native.Translate.Search;
    paper = new Zotero.Item("journalArticle");
    paper.libraryID = Zotero.Libraries.userLibraryID;
    paper.setField("title", "Library paper on drift");
    paper.setField("date", "2020");
    paper.setCreators([
      { creatorType: "author", firstName: "Mary", lastName: "Mid" },
    ]);
    await paper.saveTx();
    existing = new Zotero.Item("journalArticle");
    existing.libraryID = Zotero.Libraries.userLibraryID;
    existing.setField("title", "Alpha drift in cortex");
    existing.setField("date", "2021");
    // Stored in another case than the review cites it.
    existing.setField("DOI", alphaDoi.toUpperCase());
    existing.setCreators([
      { creatorType: "author", firstName: "Ada", lastName: "Able" },
    ]);
    await existing.saveTx();
  });

  afterEach(async function () {
    native.Translate.Search = originalSearch;
    setOriginalAgentPermissionMode(originalMode);
    await api.reset();
    await Zotero.DB.executeTransaction(() =>
      clearPlanDocumentConversationRowsInTransaction(paper.id),
    );
    for (const id of created.splice(0)) await Zotero.Items.get(id)?.eraseTx();
    await existing.eraseTx();
    await paper.eraseTx();
  });

  async function waitFor<T>(
    read: () => T | null | false,
    describe?: () => string,
  ): Promise<T> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const result = read();
      if (result) return result;
      await Zotero.Promise.delay(25);
    }
    throw new Error(
      `The document card did not settle${describe ? `: ${describe()}` : ""}`,
    );
  }

  it("cites the found and imported items in a new version and leaves the stored one", async function () {
    const records: OutsidePaperRecord[] = [
      {
        paperId: "paper_alpha",
        doi: alphaDoi,
        title: "Alpha drift in cortex",
        authors: ["Ada Able"],
        year: 2021,
        depth: "abstract",
      },
      {
        paperId: "paper_beta",
        arxivId: betaArxiv,
        title: "Beta preprint on stable readout",
        authors: ["Ben Beta"],
        year: 2022,
        depth: "abstract",
      },
      {
        paperId: "paper_gamma",
        url: gammaUrl,
        title: "Gamma lab notes",
        authors: ["Gil Gamma"],
        year: 2023,
        depth: "metadata",
      },
    ];
    const outsidePapers = await buildOutsidePaperSnapshots({ papers: records });
    const citations: PlanCitationCluster[] = [
      {
        citationId: "C1",
        sources: [
          { libraryID: paper.libraryID, itemKey: paper.key, evidenceRefs: [] },
        ],
      },
      ...records.map((record, index) => ({
        citationId: `C${index + 2}`,
        sources: [
          {
            kind: "outside" as const,
            paperId: record.paperId,
            evidenceRefs: [],
          },
        ],
      })),
    ];
    const markdown =
      "# Drift review\n\nDrift is common [[cite:C1]], also in cortex [[cite:C2]].\n\nReadouts stay stable [[cite:C3]], as lab notes show [[cite:C4]].";
    const now = Date.now();
    const finalized = await finalizeDocument({
      gateway: new ZoteroGateway(),
      now,
      input: {
        title: "Drift review",
        documentKind: "literature_review",
        markdown,
        citations,
        quotes: [],
        assets: [],
        groundingReviewed: "passed",
        groundingIssues: [],
      },
      context: {
        documentId: `later-import-review:${paper.key}:document:1`,
        documentVersion: 1,
        conversationKey: paper.id,
        integrityPolicy: "authored",
        origin: {
          kind: "direct",
          runId: `later-import-review:${paper.key}`,
          sourceMessageTimestamp: now,
        },
        coverageItems: [],
        spec: {
          kind: "literature_review",
          title: "Drift review",
          requiredSections: [],
          requiresReferences: true,
          requiresCoverageSection: false,
          allowFigures: false,
          citationStyle: {
            styleId: "http://www.zotero.org/styles/apa",
            styleTitle: "APA",
            locale: "en-US",
          },
        },
        corpus: citations.flatMap((cluster) => cluster.sources),
        evidence: [],
        quoteCorpusKeys: new Set(),
        outsidePapers,
        validateAssetProvenance: () => undefined,
      },
    });
    await persistFinalizedDocument(finalized);
    const original = (await loadPlanDocument(
      finalized.document.documentId,
    )) as DocumentArtifactV2;
    assert.lengthOf(original.citationBundle.outsidePapers || [], 3);

    // Only the network translator is substituted: the real ItemSaver saves
    // what it returns, and only the arXiv paper may reach it.
    const translated: string[] = [];
    native.Translate.Search = class {
      private identifier: Record<string, string> = {};
      setIdentifier(identifier: Record<string, string>) {
        this.identifier = identifier;
      }
      async getTranslators() {
        return [{}];
      }
      setTranslator() {}
      async translate() {
        translated.push(JSON.stringify(this.identifier));
        return [
          {
            itemType: "journalArticle",
            title: "Beta preprint on stable readout",
            date: "2022",
            url: `http://arxiv.org/abs/${betaArxiv}`,
            creators: [
              { creatorType: "author", firstName: "Ben", lastName: "Beta" },
            ],
            attachments: [],
          },
        ];
      }
    };

    await initAgentChangeJournal();
    setOriginalAgentPermissionMode("safe");
    const registry = new AgentToolRegistry(
      new ActionContractService(new ZoteroGateway()),
    );
    registry.register(
      native.LLMForZotero.api.agent.getToolDefinition("library_import"),
    );
    const runId = `later-import-run:${paper.key}`;
    const context: AgentToolContext = {
      request: resolvedAgentRequest({
        conversationKey: paper.id,
        mode: "agent",
        userText: "Import the papers this review cites.",
        libraryID: paper.libraryID,
        executionContext: {
          version: 1,
          executionId: runId,
          conversationKey: paper.id,
          conversationGeneration: 0,
          chatLibraryID: paper.libraryID,
          permissionOwner: "original_agent",
          workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
          configuredAccess: {
            libraryIDs: [paper.libraryID],
            outputDirectories: [],
          },
        },
      }),
      item: null,
      modelName: "workflow",
      currentAnswerText: "",
      runId,
    };
    let execution = await registry.prepareExecution(
      {
        id: "import-later",
        name: "library_import",
        arguments: {
          kind: "document_citations",
          documentId: original.documentId,
        },
      },
      context,
      { callerKind: "model" },
    );
    assert.equal(execution.kind, "confirmation", "Safe confirms the import");
    if (execution.kind !== "confirmation") throw new Error("unreachable");
    assert.include(
      String(execution.action.description),
      '1 paper that "Drift review" cites',
    );
    execution = await execution.execute({ approved: true });
    if (execution.kind !== "result") throw new Error("No result");
    const result = execution.execution.result;
    assert.isTrue(result.ok, JSON.stringify(result.content));
    assert.lengthOf(translated, 1, "the DOI-matched paper is not imported");
    assert.include(translated[0], betaArxiv);
    const content = result.content as {
      documentId: string;
      papers: Array<{ paperId: string; outcome: string; itemId?: number }>;
    };
    assert.deepEqual(
      content.papers.map((entry) => [entry.paperId, entry.outcome]),
      [
        ["paper_alpha", "found_existing"],
        ["paper_beta", "imported"],
        ["paper_gamma", "not_importable"],
      ],
    );
    assert.equal(content.papers[0].itemId, existing.id);
    const imported = Zotero.Items.get(content.papers[1].itemId!) as Zotero.Item;
    created.push(imported.id);

    const version = (await loadPlanDocument(
      content.documentId,
    )) as DocumentArtifactV2;
    assert.equal(version.documentVersion, 2);
    assert.deepEqual(version.revisionOf, {
      documentId: original.documentId,
      documentVersion: 1,
    });
    assert.equal(
      version.citationDraft?.markdown,
      original.citationDraft?.markdown,
    );
    // The two papers are their items; the URL-only one stays outside.
    const alphaUri = `zotero://select/library/items/${existing.key}`;
    const betaUri = `zotero://select/library/items/${imported.key}`;
    assert.include(version.visibleMarkdown, `](${alphaUri})`);
    assert.include(version.visibleMarkdown, `](${betaUri})`);
    assert.include(version.visibleMarkdown, `](${gammaUrl})`);
    assert.deepEqual(
      version.citationBundle.outsidePapers?.map((entry) => entry.paperId),
      ["paper_gamma"],
    );
    // One APA References list: three library entries and one outside entry.
    assert.deepEqual(
      version.citationBundle.bibliographyEntries.map((entry) =>
        isOutsideBibliographyEntry(entry) ? entry.paperId : entry.itemKey,
      ),
      [existing.key, imported.key, "paper_gamma", paper.key],
    );
    const references = version.visibleMarkdown.split("## References\n\n")[1];
    const lines = references.trim().split("\n");
    assert.lengthOf(lines, 4);
    assert.match(lines[0], /^- \[Able, A\. \(2021\)/);
    assert.isTrue(lines[0].endsWith(`(${alphaUri})`));
    assert.isTrue(lines[1].endsWith(`(${betaUri})`));
    assert.isTrue(lines[2].endsWith(`(${gammaUrl})`));
    // The stored document is unchanged.
    assert.deepEqual(await loadPlanDocument(original.documentId), original);

    // The new version's card: links to the items, one outside marker.
    // Deliver the outbox entry the way chat does, so the card can paint.
    await deliverPendingPlanDocumentMessage({
      conversationKey: paper.id,
      documentId: content.documentId,
      visibleMarkdown: version.visibleMarkdown,
      messageTimestamp: Date.now(),
    });
    const panel = await api.renderPanelForItem(paper.id);
    const trace = api.renderToolResultForPanel(panel.panelId, result, {
      documentId: content.documentId,
    })!;
    const card = await waitFor(
      () => trace.querySelector<HTMLElement>(".llm-plan-document-content a"),
      () =>
        trace.querySelector("[data-llm-plan-document-id]")?.textContent ||
        trace.textContent ||
        "no card",
    ).then(
      () => trace.querySelector<HTMLElement>(".llm-plan-document-content")!,
    );
    const hrefs = (
      Array.from(card.querySelectorAll("a")) as HTMLAnchorElement[]
    ).map((link) => link.getAttribute("href"));
    assert.include(hrefs, alphaUri);
    assert.include(hrefs, betaUri);
    assert.notInclude(hrefs, `https://doi.org/${alphaDoi}`);
    const markers = Array.from(
      card.querySelectorAll(".llm-plan-document-outside-marker"),
    ) as HTMLElement[];
    assert.lengthOf(markers, 1);
    assert.equal(
      (markers[0].previousElementSibling as HTMLAnchorElement).getAttribute(
        "href",
      ),
      gammaUrl,
    );
  });
});

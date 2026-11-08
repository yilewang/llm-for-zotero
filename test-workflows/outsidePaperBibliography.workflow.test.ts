import { assert } from "chai";
import type { OutsidePaperRecord } from "../src/agent/context/outsidePaperRecords";
import {
  finalizeDocument,
  persistFinalizedDocument,
} from "../src/agent/documents/finalizer";
import {
  buildOutsidePaperSnapshots,
  outsidePaperUri,
} from "../src/agent/documents/outsidePaperCitations";
import {
  clearPlanDocumentConversationRowsInTransaction,
  loadDocumentActionState,
  loadPlanDocument,
} from "../src/agent/documents/store";
import { exportPlanDocumentMarkdown } from "../src/agent/documents/actions";
import { deliverPendingPlanDocumentMessage } from "../src/agent/documents/publication";
import {
  isOutsideBibliographyEntry,
  type PlanCitationCluster,
} from "../src/agent/documents/types";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

/**
 * A literature review citing one Zotero item and two outside papers, through
 * Zotero's real citeproc engine: one APA bibliography for both kinds, entries
 * paired by their CSL ids, outside entries linked at doi.org (a DOI with
 * parentheses) or their arXiv page, the document card's "Not in library"
 * marker on outside References entries only, and a saved note and an export
 * that keep the links and never the marker.
 */
describe("workflow: outside-paper bibliography", function () {
  this.timeout(60000);
  const PAREN_DOI =
    "10.1002/(SICI)1097-4636(199702)34:2<123::AID-JBM1>3.0.CO;2-G";
  let api: WorkflowTestApi;
  let paper: Zotero.Item;
  let documentId = "";
  let originalLaunch: unknown;
  const temporaryPaths: string[] = [];

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    paper = new Zotero.Item("journalArticle");
    paper.libraryID = Zotero.Libraries.userLibraryID;
    paper.setField("title", "Middle library paper on drift");
    paper.setField("date", "2020");
    paper.setCreators([
      { creatorType: "author", firstName: "Mary", lastName: "Mid" },
    ]);
    await paper.saveTx();
    originalLaunch = (Zotero as any).launchURL;
  });

  afterEach(async function () {
    (Zotero as any).launchURL = originalLaunch;
    await api.reset();
    if (documentId) {
      const state = await loadDocumentActionState(documentId);
      const binding = state?.savedNote || state?.pendingNote;
      const saved =
        binding &&
        Zotero.Items.getByLibraryAndKey(binding.libraryID, binding.itemKey);
      if (saved) await saved.eraseTx();
    }
    await Zotero.DB.executeTransaction(() =>
      clearPlanDocumentConversationRowsInTransaction(paper.id),
    );
    await paper.eraseTx();
    for (const path of temporaryPaths.splice(0))
      await (globalThis as any).IOUtils.remove(path, { ignoreAbsent: true });
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

  it("formats one APA bibliography for library and outside papers and keeps outside links everywhere", async function () {
    const able: OutsidePaperRecord = {
      paperId: "paper_able",
      doi: PAREN_DOI,
      title: "Able drift in cortex",
      authors: ["Ada Able"],
      year: 2021,
      depth: "abstract",
    };
    const zulu: OutsidePaperRecord = {
      paperId: "paper_zulu",
      arxivId: "2101.00001",
      title: "Zulu preprint on stable readout",
      authors: ["Zed Zulu", "Yan Young"],
      year: 2022,
      depth: "abstract",
    };
    const ableUri = outsidePaperUri({ doi: PAREN_DOI })!;
    const zuluUri = "https://arxiv.org/abs/2101.00001";
    assert.notMatch(ableUri, /[()<>]/);
    // No lookup: the thin records are formatted, without the network.
    const outsidePapers = await buildOutsidePaperSnapshots({
      papers: [able, zulu],
    });
    // Zulu is cited first (ext-1), the mixed group second (Able is ext-2),
    // and APA orders Able, Mid, Zulu: neither the citation nor the id order.
    const citations: PlanCitationCluster[] = [
      {
        citationId: "C1",
        sources: [{ kind: "outside", paperId: "paper_zulu", evidenceRefs: [] }],
      },
      {
        citationId: "C2",
        sources: [
          {
            libraryID: paper.libraryID,
            itemKey: paper.key,
            evidenceRefs: [],
          },
          { kind: "outside", paperId: "paper_able", evidenceRefs: [] },
        ],
      },
    ];
    const now = Date.now();
    documentId = `outside-bibliography:${paper.key}`;
    const finalized = await finalizeDocument({
      gateway: new ZoteroGateway(),
      now,
      input: {
        title: "Outside bibliography",
        markdown:
          "# Outside bibliography\n\nA preprint reports stable readout [[cite:C1]].\n\nDrift is common [[cite:C2]].",
        citations,
        quotes: [],
        assets: [],
        groundingReviewed: "passed",
        groundingIssues: [],
      },
      context: {
        documentId,
        documentVersion: 1,
        conversationKey: paper.id,
        integrityPolicy: "authored",
        origin: {
          kind: "direct",
          runId: `outside-bibliography:${paper.key}`,
          sourceMessageTimestamp: now,
        },
        coverageItems: [],
        spec: {
          kind: "literature_review",
          title: "Outside bibliography",
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
    const document = (await loadPlanDocument(documentId))!;
    assert.isOk(document, "the store decodes and keeps the document");
    const bundle = document.citationBundle;

    // One list in APA order, each entry paired with its own work.
    assert.deepEqual(
      bundle.bibliographyEntries.map((entry) =>
        isOutsideBibliographyEntry(entry) ? entry.paperId : entry.itemKey,
      ),
      ["paper_able", paper.key, "paper_zulu"],
    );
    assert.match(bundle.bibliographyEntries[0].text, /^Able, A\. \(2021\)/);
    assert.match(bundle.bibliographyEntries[1].text, /^Mid, M\. \(2020\)/);
    assert.match(bundle.bibliographyEntries[2].text, /^Zulu, Z\., & Young/);
    assert.deepEqual(
      bundle.outsidePapers?.map((entry) => [entry.paperId, entry.csl.id]),
      [
        ["paper_zulu", "ext-1"],
        ["paper_able", "ext-2"],
      ],
    );
    assert.equal(
      (document as Extract<typeof document, { version: 2 }>).citationDraft
        ?.markdown,
      "# Outside bibliography\n\nA preprint reports stable readout [[cite:C1]].\n\nDrift is common [[cite:C2]].",
    );

    // Each name of the mixed group links to its own work.
    assert.include(
      document.visibleMarkdown,
      `([Able, 2021](${ableUri}); [Mid, 2020](zotero://select/library/items/${paper.key}))`,
    );
    assert.include(
      document.visibleMarkdown,
      `[(Zulu & Young, 2022)](${zuluUri})`,
    );
    const references = document.visibleMarkdown.split("## References\n\n")[1];
    const lines = references.trim().split("\n");
    assert.lengthOf(lines, 3);
    assert.match(lines[0], new RegExp(`\\]\\(${escapeRegExp(ableUri)}\\)$`));
    assert.match(
      lines[1],
      new RegExp(`\\]\\(zotero://select/library/items/${paper.key}\\)$`),
    );
    assert.match(lines[2], new RegExp(`\\]\\(${escapeRegExp(zuluUri)}\\)$`));
    assert.notInclude(document.visibleMarkdown, "Not in library");

    // The card: outside links open in the browser, outside entries marked.
    const launched: string[] = [];
    (Zotero as any).launchURL = (url: string) => void launched.push(url);
    // Deliver the outbox entry the way chat does, so the card can paint.
    await deliverPendingPlanDocumentMessage({
      conversationKey: paper.id,
      documentId,
      visibleMarkdown: document.visibleMarkdown,
      messageTimestamp: Date.now(),
    });
    const panel = await api.renderPanelForItem(paper.id);
    const trace = api.renderToolResultForPanel(
      panel.panelId,
      {
        callId: `submit:${paper.key}`,
        name: "submit_document",
        ok: true,
        content: { documentId },
        actionReceipts: [],
      },
      { documentId },
    )!;
    const content = await waitFor(
      () => trace.querySelector<HTMLElement>(".llm-plan-document-content a"),
      () =>
        trace.querySelector("[data-llm-plan-document-id]")?.textContent ||
        trace.textContent ||
        "no card",
    ).then(
      () => trace.querySelector<HTMLElement>(".llm-plan-document-content")!,
    );
    const outsideLinks = Array.from(
      content.querySelectorAll('a[data-llm-plan-citation-source="outside"]'),
    ) as HTMLAnchorElement[];
    assert.isAtLeast(outsideLinks.length, 4);
    const ableLink = outsideLinks.find(
      (link) => link.getAttribute("href") === ableUri,
    )!;
    assert.equal(ableLink.title, "Open at doi.org");
    assert.equal(
      outsideLinks.find((link) => link.getAttribute("href") === zuluUri)!.title,
      "Open paper page",
    );
    ableLink.click();
    assert.deepEqual(launched, [ableUri]);
    const markers = Array.from(
      content.querySelectorAll(".llm-plan-document-outside-marker"),
    ) as HTMLElement[];
    assert.lengthOf(markers, 2);
    for (const marker of markers) {
      assert.equal(marker.textContent, " · Not in library");
      const entry = marker.previousElementSibling as HTMLAnchorElement;
      assert.oneOf(entry.getAttribute("href"), [ableUri, zuluUri]);
      assert.equal(entry.closest("li")?.lastElementChild, marker);
    }
    const zoteroEntry = (
      Array.from(content.querySelectorAll("li a")) as HTMLAnchorElement[]
    ).find(
      (link) =>
        link.getAttribute("href") ===
        `zotero://select/library/items/${paper.key}`,
    );
    assert.isOk(zoteroEntry);
    assert.isNull(
      zoteroEntry!
        .closest("li")!
        .querySelector(".llm-plan-document-outside-marker"),
    );
    // Muted in either theme: its own secondary text color, not the entry's.
    const marker = markers[0];
    const style = (element: Element) =>
      String(
        marker.ownerDocument.defaultView?.getComputedStyle(element)?.color,
      );
    assert.notEqual(style(marker), style(marker.closest("li")!));

    // Save Note keeps the links and never the marker.
    const note = trace.querySelector<HTMLButtonElement>(
      ".llm-plan-document-action-note",
    )!;
    const status = trace.querySelector<HTMLElement>(
      ".llm-plan-document-action-status",
    )!;
    note.click();
    await waitFor(() => !note.disabled && Boolean(status.textContent));
    const binding = (await loadDocumentActionState(documentId))!.savedNote!;
    assert.isOk(binding, status.textContent || "note not saved");
    const saved = Zotero.Items.getByLibraryAndKey(
      binding.libraryID,
      binding.itemKey,
    ) as Zotero.Item;
    await saved.reload(["note"], true);
    const html = saved.getNote();
    assert.include(html, `href="${ableUri}"`);
    assert.include(html, `href="${zuluUri}"`);
    assert.notInclude(html, "Not in library");

    // The Markdown export keeps the links and never the marker.
    const path = `${Zotero.getTempDirectory().path}/outside-bibliography-${paper.key}.md`;
    temporaryPaths.push(path);
    await exportPlanDocumentMarkdown(documentId, path);
    const exported: string = await (globalThis as any).IOUtils.readUTF8(path);
    assert.include(exported, `(${ableUri})`);
    assert.include(exported, `(${zuluUri})`);
    assert.notInclude(exported, "Not in library");
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

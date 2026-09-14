import { assert } from "chai";
import type { PlanDocument } from "../src/agent/documents/types";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { collectReaderSelectionDocuments } from "../src/modules/contextPanel/readerSelection";
import {
  buildQuoteCitation,
  buildQuoteSourceIndex,
  finalizeAssistantQuoteCitationsCooperatively,
} from "../src/modules/contextPanel/quoteCitations";

describe("workflow: document and chat quote parity", function () {
  this.timeout(120000);

  it("renders a persisted multi-paper CSL group once with exact source links", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const a = await api.createPaperWithPdfFixture({
      title: "Group source A",
      pages: ["Alpha evidence."],
    });
    const b = await api.createPaperWithPdfFixture({
      title: "Group source B",
      pages: ["Beta evidence."],
    });
    try {
      const items = [
        Zotero.Items.get(a.parentItemId),
        Zotero.Items.get(b.parentItemId),
      ];
      for (const [index, item] of items.entries()) {
        item.setCreators([
          {
            creatorType: "author",
            firstName: "Test",
            lastName: index ? "Beta" : "Alpha",
          },
        ]);
        item.setField("date", index ? "2021" : "2020");
        await item.saveTx();
      }
      const sources = items.map((item) => ({
        libraryID: item.libraryID,
        itemKey: item.key,
        evidenceRefs: [],
      }));
      const links = items
        .map(
          (item, i) => `[${i + 1}](zotero://select/library/items/${item.key})`,
        )
        .join(" ");
      const markdown = `Evidence (Alpha, 2020; Beta, 2021) ${links}.`;
      const document: PlanDocument = {
        version: 2,
        documentId: "group-parity",
        documentVersion: 1,
        documentKind: "custom",
        integrityPolicy: "authored",
        origin: {
          kind: "direct",
          runId: "group-parity",
          sourceMessageTimestamp: 1,
        },
        conversationKey: items[0].id,
        title: "Group citation",
        visibleMarkdown: markdown,
        visibleHtml: "",
        citationBundle: {
          clusters: [
            {
              citationId: "C1",
              text: "(Alpha, 2020; Beta, 2021)",
              html: "",
              sources,
            },
          ],
          bibliographyEntries: [],
          style: { id: "http://www.zotero.org/styles/apa", title: "APA" },
          locale: "en-US",
        },
        verifiedQuotes: [],
        assets: [],
        coverageItems: [],
        validation: {
          integrityValidated: true,
          groundingReviewed: "not_run",
          quoteVerified: "not_applicable",
          issues: [],
        },
        contentHash: "original",
        createdAt: 1,
      };
      const panel = await api.renderPanelForItem(items[0].id);
      assert.isTrue(api.renderDocumentForPanel(panel.panelId, document, false));
      const root = Zotero.getMainWindow().document.querySelector(
        `[data-workflow-panel-id="${panel.panelId}"] .llm-plan-document-content`,
      )!;
      assert.equal(
        root.textContent?.trim(),
        "Evidence (Alpha, 2020; Beta, 2021).",
      );
      const anchors = Array.from(root.querySelectorAll("a"));
      assert.deepEqual(
        anchors.map((node) => node.textContent),
        ["Alpha, 2020", "Beta, 2021"],
      );
      assert.deepEqual(
        anchors.map((node) => node.getAttribute("href")),
        items.map((item) => `zotero://select/library/items/${item.key}`),
      );
      const navigation = await api.observeCitationNavigationFocus(anchors[1], {
        linkTargetItemId: items[1].id,
      });
      assert.isTrue(navigation.finished);
      assert.isAbove(
        navigation.focusRequests,
        0,
        "the source window must be brought in front of the document",
      );
      assert.deepEqual(
        Zotero.getActiveZoteroPane()
          .getSelectedItems()
          .map((item) => item.id),
        [items[1].id],
        "the group label navigates to its exact native source",
      );
      assert.equal(
        document.visibleMarkdown,
        markdown,
        "display repair preserves immutable document bytes",
      );
    } finally {
      await api.reset();
      await api.cleanupFixture(a);
      await api.cleanupFixture(b);
    }
  });

  it("shows one quote card for the live manual-subspan plus adjacent-token layout", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const visible =
      "Hypothesis: stable readout can coexist with representational drift.";
    const source = `SYNTHETIC TEST PAPER. ${visible}`;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Adjacent quote source",
      pages: [source],
    });
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const citation = buildQuoteCitation({
        quoteText: source,
        citationLabel: "(Fixture, 2024)",
        itemId: fixture.parentItemId,
        contextItemId: fixture.pdfAttachmentId,
        sourceMatchKind: "exact",
        sourceMatchSource: "context-text",
      })!;
      const hydrated = await finalizeAssistantQuoteCitationsCooperatively(
        {
          markdown: `## Hypothesis\n\n> ${visible}\n[[quote:${citation.id}]]\n\nThe hypothesis is named amber-readout.`,
          quoteCitations: [citation],
          sourceIndex: buildQuoteSourceIndex({
            quoteCitations: [citation],
            sourceTexts: [
              {
                sourceText: source,
                sourceLabel: "(Fixture, 2024)",
                itemId: fixture.parentItemId,
                contextItemId: fixture.pdfAttachmentId,
                sourceMatchSource: "context-text",
              },
            ],
          }),
          quoteSourceReview: { sourceEvidenceComplete: true },
        },
        { yieldToMain: () => Zotero.Promise.delay(0) },
      );
      assert.isNotNull(hydrated);
      const result = await api.renderAssistantForPanel(panel.panelId, {
        text: hydrated!.markdown,
        quoteCitations: hydrated!.quoteCitations,
      });
      assert.lengthOf(
        result.quoteCardCitationTexts,
        1,
        "the visible quotation and its adjacent citation token share one card",
      );
      const body = Zotero.getMainWindow().document.querySelector(
        `[data-workflow-panel-id="${panel.panelId}"]`,
      )!;
      const quoteCards = body.querySelectorAll(".llm-quote-card");
      assert.lengthOf(quoteCards, 1);
      assert.include(quoteCards[0].textContent || "", visible);
      assert.notInclude(
        quoteCards[0].textContent || "",
        "SYNTHETIC TEST PAPER.",
      );
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });

  it("keeps authored document quotes interactive in the larger view, like regular chat", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const quote =
      "Stable readout can coexist with representational drift across ten recording sessions.";
    const fixture = await api.createPaperWithPdfFixture({
      title: "Document citation parity fixture",
      pdfTitle: "Document citation parity source",
      pages: [quote],
    });
    let win: Window | null = null;
    let reader: any;
    try {
      const item = Zotero.Items.get(fixture.parentItemId);
      item.setCreators([
        { creatorType: "author", firstName: "Test", lastName: "Fixture" },
      ]);
      item.setField("date", "2024");
      await item.saveTx();
      reader = await Zotero.Reader.open(fixture.pdfAttachmentId);
      await reader._initPromise;
      await reader._waitForReader();
      const pageTextReady = () =>
        collectReaderSelectionDocuments(reader).some((doc) =>
          doc
            .querySelector('.page[data-page-number="1"] .textLayer')
            ?.textContent?.includes("Stable readout"),
        );
      const pageTextDeadline = Date.now() + 15000;
      while (!pageTextReady() && Date.now() < pageTextDeadline)
        await Zotero.Promise.delay(25);
      assert.isTrue(
        pageTextReady(),
        "native PDF text is ready before citation navigation",
      );
      const markdown = `## Finding\n\n> ${quote}\n(Fixture, 2024)`;
      const panel = await api.renderPanelForItem(item.id);
      const chat = await api.renderAssistantForPanel(panel.panelId, {
        text: markdown,
      });
      assert.lengthOf(
        chat.quoteCardCitationTexts,
        1,
        "regular chat renders the source-backed quote",
      );
      const document: PlanDocument = {
        version: 2,
        documentId: `quote-parity-${Date.now()}`,
        documentVersion: 1,
        documentKind: "custom",
        integrityPolicy: "authored",
        origin: {
          kind: "direct",
          runId: "quote-parity",
          sourceMessageTimestamp: Date.now(),
        },
        conversationKey: item.id,
        title: "Citation parity document",
        visibleMarkdown: markdown,
        visibleHtml: "",
        citationBundle: {
          clusters: [],
          bibliographyEntries: [],
          style: { id: "apa", title: "APA" },
          locale: "en-US",
        },
        verifiedQuotes: [],
        assets: [],
        coverageItems: [],
        validation: {
          integrityValidated: true,
          groundingReviewed: "not_run",
          quoteVerified: "not_applicable",
          issues: [],
        },
        contentHash: "fixture",
        createdAt: Date.now(),
      };
      assert.isTrue(api.renderDocumentForPanel(panel.panelId, document, false));
      const inline = Zotero.getMainWindow().document.querySelector(
        `[data-workflow-panel-id="${panel.panelId}"] .llm-plan-document-content`,
      )!;
      assert.lengthOf(
        inline.querySelectorAll(".llm-quote-card"),
        1,
        "inline document shares chat quote cards",
      );
      assert.isTrue(api.renderDocumentForPanel(panel.panelId, document, true));
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const windows = (Services as any).wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
          const candidate = windows.getNext() as Window;
          if (
            candidate.document.getElementById(
              "llmforzotero-standalone-plan-document-root",
            )
          )
            win = candidate;
        }
        if (win?.document.querySelector(".llm-plan-document-window-content"))
          break;
        await Zotero.Promise.delay(25);
      }
      assert.isOk(win, "standalone document opens");
      const article = win!.document.querySelector(
        ".llm-plan-document-window-content",
      )!;
      assert.equal(
        article.firstElementChild?.textContent,
        "Finding",
        "the authored opening heading is the visible title, even when document metadata differs",
      );
      assert.lengthOf(
        article.querySelectorAll("h1, h2, h3, h4, h5, h6"),
        1,
        "the larger view does not prepend a duplicate opening title",
      );
      const cards =
        win!.document.querySelectorAll<HTMLElement>(".llm-quote-card");
      assert.lengthOf(
        cards,
        1,
        "document must not flatten source quotes into plain blockquotes",
      );
      assert.include(
        cards[0].querySelector(".llm-quote-card-citation")?.textContent || "",
        "Fixture",
      );
      assert.isOk(
        cards[0].querySelector(".llm-citation-icon"),
        "same jump-to-source control as chat",
      );
      const toggle = cards[0].querySelector<HTMLElement>(
        ".llm-quote-card-content",
      )!;
      const wasExpanded = cards[0].dataset.expanded;
      toggle.click();
      assert.notEqual(
        cards[0].dataset.expanded,
        wasExpanded,
        "quote text expands or collapses without navigation",
      );
      assert.isTrue(
        document.verifiedQuotes.length === 0,
        "rendering must not manufacture certificates",
      );
      assert.equal(
        document.visibleMarkdown,
        markdown,
        "display must not mutate stored document text",
      );
      const sourceButton =
        cards[0].querySelector<HTMLElement>(".llm-citation-icon")!;
      // Citations activate on mousedown (and Enter), not click. A bare .click()
      // can falsely pass if background warming happened to open the same PDF.
      const navigationStatus = win!.document.createElement("p");
      navigationStatus.id = "llm-status";
      article.appendChild(navigationStatus);
      const firstNavigation = await api.observeCitationNavigationFocus(
        sourceButton,
        { forceViewerFallbackForItemId: fixture.pdfAttachmentId },
      );
      assert.isTrue(
        firstNavigation.started,
        "the citation interaction actually starts navigation",
      );
      assert.isTrue(
        firstNavigation.finished,
        `source navigation finishes; status: ${navigationStatus.textContent}; diagnostics: ${JSON.stringify(firstNavigation)}`,
      );
      const repeatButton =
        win!.document.querySelector<HTMLElement>(".llm-citation-icon")!;
      assert.isTrue(repeatButton.isConnected);
      // Observe in the installed plugin realm: a test-realm window expando
      // cannot intercept native focus through Firefox's cross-realm wrappers.
      const repeated = await api.observeCitationNavigationFocus(repeatButton);
      assert.isTrue(
        repeated.started,
        "the repeated source action actually starts",
      );
      assert.isTrue(
        repeated.finished,
        `repeat navigation finishes within the reader search deadline; status: ${navigationStatus.textContent}; diagnostics: ${JSON.stringify(repeated)}`,
      );
      assert.isAbove(
        repeated.focusRequests,
        0,
        `jumping to an already active reader requests its window in front of the document; status: ${navigationStatus.textContent}`,
      );
    } finally {
      await reader?.close();
      win?.close();
      await api.cleanupFixture(fixture);
      await api.reset();
    }
  });
});

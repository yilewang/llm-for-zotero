import { assert } from "chai";
import { loadPlanDocument } from "../src/agent/documents/store";
import { collectReaderSelectionDocuments } from "../src/modules/contextPanel/readerSelection";
import { createTrustedReadObservations } from "../src/agent/plans/readObservation";
import type { AgentToolContext } from "../src/agent/types";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: direct document quote publication", function () {
  this.timeout(60000);

  it("publishes a quote token from a real open PDF with a durable source certificate", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const quote =
      "Stable readout can coexist with representational drift across ten recording sessions.";
    const fixture = await api.createPaperWithPdfFixture({
      title: "Direct document quote source",
      pdfTitle: "Direct document quote PDF",
      pages: [quote],
    });
    let reader: any;
    try {
      const paper = Zotero.Items.get(fixture.parentItemId);
      const attachment = Zotero.Items.get(fixture.pdfAttachmentId);
      paper.setCreators([
        { creatorType: "author", firstName: "Test", lastName: "Fixture" },
      ]);
      paper.setField("date", "2024");
      await paper.saveTx();
      reader = await Zotero.Reader.open(attachment.id);
      await reader._initPromise;
      await reader._waitForReader();
      // Reader initialization precedes PDF.js loading its actual page text.
      // Observe that text before submitting once; do not retry rejected drafts.
      const pageTextReady = () =>
        collectReaderSelectionDocuments(reader).some((doc) =>
          doc
            .querySelector('.page[data-page-number="1"] .textLayer')
            ?.textContent?.includes("Stable readout"),
        );
      const deadline = Date.now() + 15000;
      while (!pageTextReady() && Date.now() < deadline)
        await Zotero.Promise.delay(50);
      assert.isTrue(
        pageTextReady(),
        "the real PDF text is loaded before document submission",
      );
      const context: AgentToolContext = {
        item: paper,
        currentAnswerText: "",
        modelName: "workflow",
        request: {
          conversationKey: paper.id,
          mode: "agent",
          userText: "Publish a research document with an exact source quote.",
          libraryID: paper.libraryID,
          documentOutcomePolicy: {
            required: true,
            documentKind: "custom",
            integrityPolicy: "authored",
            trigger: "document_intent",
          },
        },
        runId: `native-direct-quote:${paper.key}`,
      };
      // Exercise the actual paper-read output and host attestation, including
      // extracted text without page locators. Do not fabricate a PDF-page receipt.
      const readTool = (Zotero as any).LLMForZotero.api.agent.getToolDefinition(
        "paper_read",
      );
      const readInput = readTool.validate({
        mode: "overview",
        target: { itemId: paper.id, contextItemId: attachment.id },
      });
      assert.isTrue(readInput.ok, JSON.stringify(readInput));
      const readResult = await readTool.execute(readInput.value, context);
      const observations = await createTrustedReadObservations({
        toolName: "paper_read",
        callId: `native-read:${paper.key}`,
        input: readInput.value,
        result: readResult.content || readResult,
      });
      const observedBody = observations.find((value) =>
        value.capabilities.includes("body"),
      );
      assert.isOk(observedBody, JSON.stringify(readResult));
      if (!observedBody) return;
      assert.equal(observedBody.attachmentItemKey, attachment.key);
      context.request.documentReadObservations = observations;
      const observationId = observedBody.observationId;
      const input = {
        title: "A verified finding",
        markdown: `# Finding\n\n> ${quote} [[quote:Q1]]\n>\n> (Fixture, 2024)\n\nA parenthetical reference (Fixture [[cite:C1]]).`,
        citations: [
          {
            citationId: "C1",
            sources: [
              {
                libraryID: paper.libraryID,
                itemKey: paper.key,
                evidenceRefs: [observationId],
              },
            ],
          },
        ],
        quotes: [
          {
            quoteId: "Q1",
            text: quote,
            libraryID: paper.libraryID,
            itemKey: paper.key,
            attachmentItemKey: attachment.key,
            evidenceRefs: [observationId],
          },
        ],
        assets: [],
        groundingReviewed: "passed",
        groundingIssues: [],
      };
      // Execute in the installed plugin's realm, with its real verifier and
      // Zotero services, rather than a second bundled copy with missing globals.
      const tool = (Zotero as any).LLMForZotero.api.agent.getToolDefinition(
        "submit_document",
      );
      const validated = tool.validate(input);
      assert.isTrue(validated.ok, JSON.stringify(validated));
      const result = await tool.execute(validated.value, context);
      const document = await loadPlanDocument(result.documentId);
      assert.isOk(document, "the tool publishes a durable document");
      if (!document) return;
      assert.equal(document.validation.quoteVerified, "verified");
      assert.lengthOf(document.verifiedQuotes, 1);
      assert.equal(
        document.verifiedQuotes[0].certificate.contextItemId,
        attachment.id,
      );
      assert.equal(document.verifiedQuotes[0].certificate.pageIndex, 0);
      assert.include(document.visibleMarkdown, `> ${quote}`);
      assert.equal(document.visibleMarkdown.split(quote).length - 1, 1);
      assert.notInclude(document.visibleMarkdown, "[[quote:");
      assert.include(
        document.visibleMarkdown,
        "A parenthetical reference ([Fixture, 2024](zotero://",
      );
      assert.include(
        document.citationBundle.bibliographyEntries[0].text,
        "Fixture",
      );
      const panel = await api.renderPanelForItem(paper.id);
      assert.isTrue(api.renderDocumentForPanel(panel.panelId, document, false));
      const card = Zotero.getMainWindow().document.querySelector(
        `[data-workflow-panel-id="${panel.panelId}"] .llm-plan-document-content .llm-quote-card`,
      );
      assert.isOk(
        card,
        "verified document quotes use the same interactive card as chat",
      );
      assert.include(card!.textContent || "", "Fixture");
    } finally {
      await reader?.close();
      await api.cleanupFixture(fixture);
      await api.reset();
    }
  });
});

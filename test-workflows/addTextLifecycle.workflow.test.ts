import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

describe("workflow: Add Text lifecycle", function () {
  this.timeout(45000);

  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;
  const additionalFixtures: WorkflowTestFixture[] = [];

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
  });

  afterEach(async function () {
    if (fixture) {
      await api.cleanupFixture(fixture);
      fixture = null;
    }
    while (additionalFixtures.length) {
      await api.cleanupFixture(additionalFixtures.pop()!);
    }
    await api.reset();
  });

  it("repairs a listener lost after plugin startup", async function () {
    const diagnostics = await api.exerciseReaderSelectionTrackingRecovery();

    assert.equal(diagnostics.before, 1, JSON.stringify(diagnostics));
    assert.equal(diagnostics.afterDrop, 0, JSON.stringify(diagnostics));
    assert.equal(diagnostics.afterHealthCheck, 1, JSON.stringify(diagnostics));
    assert.isTrue(diagnostics.markerPresent, JSON.stringify(diagnostics));
    assert.isTrue(diagnostics.markerLive, JSON.stringify(diagnostics));
    assert.isBelow(diagnostics.elapsedMs, 2000, JSON.stringify(diagnostics));
  });

  it("recovers the listener and routes popup text only to the active reader tab", async function () {
    const recovery = await api.exerciseReaderSelectionTrackingRecovery();
    assert.equal(recovery.afterDrop, 0, JSON.stringify(recovery));
    assert.equal(recovery.afterHealthCheck, 1, JSON.stringify(recovery));

    const selectedText = "ACTIVE_READER_TAB_ONLY_SELECTION";
    fixture = await api.createPaperWithPdfFixture({
      title: "Workflow Inactive Reader",
      pdfTitle: "Workflow Inactive Reader PDF",
      pages: ["This text belongs to the inactive reader tab."],
    });
    const activeFixture = await api.createPaperWithPdfFixture({
      title: "Workflow Active Reader",
      pdfTitle: "Workflow Active Reader PDF",
      pages: [`The active reader contains ${selectedText} for routing.`],
    });
    additionalFixtures.push(activeFixture);
    const firstPanel = await api.renderPanelForItem(fixture.parentItemId);
    const secondPanel = await api.renderPanelForItem(
      activeFixture.parentItemId,
    );

    const diagnostics = await api.exerciseReaderPopupActiveTabRouting({
      firstPanelId: firstPanel.panelId,
      firstAttachmentItemId: fixture.pdfAttachmentId,
      secondPanelId: secondPanel.panelId,
      secondAttachmentItemId: activeFixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText,
    });
    const message = JSON.stringify(diagnostics);

    assert.isNotEmpty(diagnostics.firstReaderTabId, message);
    assert.isNotEmpty(diagnostics.secondReaderTabId, message);
    assert.notEqual(
      diagnostics.firstReaderTabId,
      diagnostics.secondReaderTabId,
      message,
    );
    assert.equal(diagnostics.addTextButtonLabel, "Add Text", message);
    assert.isFalse(diagnostics.firstConversationHasText, message);
    assert.isTrue(diagnostics.secondConversationHasText, message);
  });

  it("routes popup text to the reader's own panel while the standalone window is open", async function () {
    const selectedText = "STANDALONE_READER_POPUP_SELECTION";
    fixture = await api.createPaperWithPdfFixture({
      title: "Workflow Standalone Add Text",
      pdfTitle: "Workflow Standalone Add Text PDF",
      pages: [`The standalone reader contains ${selectedText} for routing.`],
    });
    const readerPanel = await api.renderPanelForItem(fixture.parentItemId);
    await api.openStandaloneForItem(fixture.parentItemId);
    // Library chat in the window, so the window and the reader's panel hold
    // different conversations and the routing is observable.
    const standalone = await api.clickStandaloneTab("open");
    assert.equal(standalone.activeTab, "open", JSON.stringify(standalone));

    const diagnostics = await api.exerciseReaderPopupStandaloneRouting({
      panelId: readerPanel.panelId,
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText,
    });
    const message = JSON.stringify({ standalone, diagnostics });

    assert.isNotEmpty(diagnostics.readerTabId, message);
    assert.equal(diagnostics.addTextButtonLabel, "Add Text", message);
    assert.equal(
      diagnostics.standaloneConversationKey,
      standalone.conversationKey,
      message,
    );
    assert.notEqual(
      diagnostics.readerConversationKey,
      diagnostics.standaloneConversationKey,
      message,
    );
    assert.isTrue(diagnostics.readerConversationHasText, message);
    assert.isTrue(diagnostics.readerPreviewHasText, message);
    assert.isFalse(diagnostics.standaloneConversationHasText, message);
    assert.isFalse(diagnostics.standalonePreviewHasText, message);
  });

  for (const trigger of ["popup", "action-bar"] as const) {
    it(`shows ${trigger} text immediately and preserves its page through the final request`, async function () {
      const filler = (label: string, count: number) =>
        Array.from(
          { length: count },
          (_, index) =>
            `${label} evidence sentence ${index + 1} describes stable local context for retrieval.`,
        ).join(" ");
      const selectedText = "HIGHLIGHT_PAGE_TWO_ANCHOR_RESULT";
      const precedingMarker = "PRECEDING_LOCKED_CHUNK_MARKER";
      const followingMarker = "FOLLOWING_LOCKED_CHUNK_MARKER";
      fixture = await api.createPaperWithPdfFixture({
        title: "Workflow Highlight-Aware Retrieval",
        pdfTitle: "Workflow Highlight-Aware Retrieval PDF",
        pages: [
          `${filler("page one", 38)} ${precedingMarker}`,
          `${filler("page two before", 20)} ${selectedText} ${filler(
            "page two after",
            20,
          )}`,
          `${followingMarker} ${filler("page three", 38)}`,
        ],
      });
      const panel = await api.renderPanelForItem(fixture.parentItemId);

      const diagnostics = await api.exerciseHighlightAwareContextRetrieval({
        panelId: panel.panelId,
        attachmentItemId: fixture.pdfAttachmentId,
        pageIndex: 1,
        selectedText,
        question: "Explain the highlighted result.",
        trigger,
      });
      const diagnosticMessage = JSON.stringify({
        trigger: diagnostics.trigger,
        readerItemId: diagnostics.readerItemId,
        addTextButtonLabel: diagnostics.addTextButtonLabel,
        immediatePreviewText: diagnostics.immediatePreviewText,
        clickToSelectedContextMs: diagnostics.clickToSelectedContextMs,
        selectedContext: diagnostics.selectedContext,
        resolvedAnchor: {
          contextItemId: diagnostics.resolvedAnchor.contextItemId,
          pageIndex: diagnostics.resolvedAnchor.pageIndex,
          pageLabel: diagnostics.resolvedAnchor.pageLabel,
          resolution: diagnostics.resolvedAnchor.resolution,
          primaryChunkIndex: diagnostics.resolvedAnchor.primaryChunkIndex,
          preferredChunkIndexes:
            diagnostics.resolvedAnchor.preferredChunkIndexes,
          injectedChars: diagnostics.resolvedAnchor.injectedChars,
        },
        finalPrompt: diagnostics.lastFinalRequest.prompt,
        finalStrategy: diagnostics.lastFinalRequest.strategy,
        finalContextHasSelectedText:
          diagnostics.lastFinalRequest.combinedContext.includes(selectedText),
        finalContextHasPrecedingMarker:
          diagnostics.lastFinalRequest.combinedContext.includes(
            precedingMarker,
          ),
        finalContextHasFollowingMarker:
          diagnostics.lastFinalRequest.combinedContext.includes(
            followingMarker,
          ),
      });

      assert.equal(
        diagnostics.readerItemId,
        fixture.pdfAttachmentId,
        diagnosticMessage,
      );
      assert.equal(diagnostics.trigger, trigger, diagnosticMessage);
      assert.equal(
        diagnostics.addTextButtonLabel,
        "Add Text",
        diagnosticMessage,
      );
      assert.include(
        diagnostics.immediatePreviewText,
        selectedText,
        diagnosticMessage,
      );
      assert.isBelow(
        diagnostics.clickToSelectedContextMs,
        250,
        diagnosticMessage,
      );
      assert.equal(
        diagnostics.selectedContext.contextItemId,
        fixture.pdfAttachmentId,
        diagnosticMessage,
      );
      assert.equal(diagnostics.selectedContext.pageIndex, 1, diagnosticMessage);
      // The fixture PDF has no printed labels, so the selection stores none;
      // the prompt still numbers the page for the model.
      assert.isUndefined(
        diagnostics.selectedContext.pageLabel,
        diagnosticMessage,
      );
      assert.include(
        diagnostics.lastFinalRequest.prompt,
        "page_label=2, page_index=1",
        diagnosticMessage,
      );
      assert.equal(
        diagnostics.resolvedAnchor.resolution,
        "chunks",
        diagnosticMessage,
      );
      assert.lengthOf(
        diagnostics.resolvedAnchor.preferredChunkIndexes,
        3,
        diagnosticMessage,
      );
      assert.include(
        diagnostics.resolvedAnchor.contextText,
        selectedText,
        diagnosticMessage,
      );
      assert.include(
        diagnostics.resolvedAnchor.contextText,
        precedingMarker,
        diagnosticMessage,
      );
      assert.include(
        diagnostics.resolvedAnchor.contextText,
        "[following local context]",
        diagnosticMessage,
      );
      assert.include(
        diagnostics.lastFinalRequest.prompt,
        `attachment_id=${fixture.pdfAttachmentId}`,
        diagnosticMessage,
      );
      assert.include(
        diagnostics.lastFinalRequest.prompt,
        "page_label=2",
        diagnosticMessage,
      );
      assert.include(
        diagnostics.lastFinalRequest.prompt,
        "page_index=1",
        diagnosticMessage,
      );
      assert.include(
        diagnostics.lastFinalRequest.prompt,
        "location_resolution=chunks",
        diagnosticMessage,
      );
      assert.include(
        diagnostics.lastFinalRequest.combinedContext,
        selectedText,
        diagnosticMessage,
      );
      assert.include(
        diagnostics.lastFinalRequest.combinedContext,
        precedingMarker,
        diagnosticMessage,
      );
      assert.include(
        diagnostics.lastFinalRequest.combinedContext,
        followingMarker,
        diagnosticMessage,
      );
    });
  }
});

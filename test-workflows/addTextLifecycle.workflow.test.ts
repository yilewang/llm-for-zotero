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

  it("opens the Add Text question box in place of Zotero's selection popup, which closes", async function () {
    const TOL = 0.5;
    const selectedText = "ADD_TEXT_BOX_PLACEMENT_PASSAGE";
    fixture = await api.createPaperWithPdfFixture({
      title: "Workflow Add Text box placement",
      pdfTitle: "Workflow Add Text box placement PDF",
      pages: [`The paper reports ${selectedText} as a slow drift.`],
    });
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const opened = await api.openNativeReaderInlineAsk({
      button: "Add Text",
      panelId: panel.panelId,
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText,
    });
    const m = JSON.stringify(opened);
    assert.isUndefined(opened.error, m);
    assert.isTrue(opened.cardMounted, `box mounted; ${m}`);
    assert.isFalse(opened.popupOpenAfterPress!.open, `popup after press; ${m}`);
    const popup = opened.popup!;
    const box = opened.card!;
    assert.isAtMost(
      Math.abs(box.left - popup.left),
      TOL,
      `box left ${box.left} vs popup left ${popup.left}; ${m}`,
    );
    assert.isAtMost(
      Math.abs(box.top - popup.top),
      TOL,
      `box top ${box.top} vs popup top ${popup.top}; ${m}`,
    );
    assert.isFalse(opened.popupOpenLater, `popup while box open; ${m}`);
    assert.lengthOf(opened.chipTexts!, 1, m);
    assert.include(opened.chipTexts![0], selectedText, m);
    assert.isTrue(opened.cardClosed, m);
    assert.isFalse(opened.popupOpenAfterCardClose, `popup after close; ${m}`);
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

  it("opens an inline prompt after Add Text that attaches a question to the chip", async function () {
    const selectedText = "INLINE_PROMPT_SELECTION";
    const prompt = "What does this passage mean?";
    fixture = await api.createPaperWithPdfFixture({
      title: "Workflow Inline Prompt",
      pdfTitle: "Workflow Inline Prompt PDF",
      pages: [`This page contains ${selectedText} for the prompt.`],
    });
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const result = await api.exerciseReaderPopupInlinePrompt({
      panelId: panel.panelId,
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText,
      prompt,
    });
    const message = JSON.stringify(result);
    assert.isTrue(result.chipAddedBeforeEnter, message);
    assert.isTrue(result.overlayMounted, message);
    // Production mounts the box in the reader UI document, where Zotero's
    // reader keyboard shortcuts listen.
    assert.match(result.overlayDocumentUrl, /reader\.html/, message);
    // The box shows the selection it asks about.
    assert.equal(result.quoteText, selectedText, message);
    assert.equal(result.quoteLabel, "Selected text", message);
    assert.equal(result.buttonLabel, "Add", message);
    assert.deepEqual(
      result.editorKeys,
      ["Mod+A", "Backspace", "ArrowRight", "h"].map((key) => ({
        key,
        defaultPrevented: false,
      })),
      message,
    );
    // The state must be readable, or the comparison below proves nothing.
    assert.notInclude(
      result.readerKeyStateBefore,
      '"selectedAnnotationCount":-1',
      message,
    );
    assert.equal(
      result.readerKeyStateAfter,
      result.readerKeyStateBefore,
      message,
    );
    // Enter attaches; it never sends.
    assert.isFalse(result.sentOnEnter, message);
    assert.equal(result.attachedQuestion, prompt, message);
    assert.equal(result.chipCount, 1, message);
    assert.equal(result.previewQuestionText, prompt, message);
    assert.deepEqual(
      result.previewLabels,
      ["Selected text", "Your question"],
      message,
    );
    assert.isTrue(result.overlayRemovedAfterEnter, message);
    assert.equal(result.composerAfterEnter, "keep this draft", message);
    assert.equal(
      result.statusAfterEnter,
      "Question attached to the selected text",
      message,
    );
    // The main Send with an empty composer carries the chip question.
    assert.include(
      result.sentQuestion,
      `Question about this text:\n${prompt}`,
      message,
    );
    assert.equal(result.sentDisplayQuestion, prompt, message);
    assert.include(result.sentSelectedTexts, selectedText, message);
    // The sent bubble shows the question under its own selection only.
    assert.equal(result.sentBubbleBodyText, "", message);
    assert.deepEqual(result.sentBubbleChipQuestions, [prompt], message);
    // The chip with a question is one card; no bar repeats the selection.
    assert.strictEqual(result.sentBubbleBarCount, 0, message);
  });

  it("reopens the inline prompt for a duplicate Add Text and updates the same chip", async function () {
    const selectedText = "DUPLICATE_PROMPT_SELECTION";
    fixture = await api.createPaperWithPdfFixture({
      title: "Workflow Inline Prompt Duplicate",
      pdfTitle: "Workflow Inline Prompt Duplicate PDF",
      pages: [`This page contains ${selectedText} twice over.`],
    });
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const result = await api.exerciseReaderPopupDuplicateAttach({
      panelId: panel.panelId,
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText,
      firstPrompt: "First question?",
      secondPrompt: "Second question?",
    });
    const message = JSON.stringify(result);
    assert.isTrue(result.firstMounted, message);
    assert.equal(result.firstQuestion, "First question?", message);
    assert.isTrue(result.secondMounted, message);
    assert.equal(result.secondQuoteText, selectedText, message);
    assert.equal(
      result.statusBeforeSecondEnter,
      "Selected text already included",
      message,
    );
    assert.isTrue(result.secondOverlayRemovedAfterEnter, message);
    assert.equal(result.chipCount, 1, message);
    assert.equal(result.finalQuestion, "Second question?", message);
    assert.isFalse(result.sent, message);
  });

  it("closes the inline prompt on Escape or a click on the PDF page and keeps the chip", async function () {
    const firstSelectedText = "DISMISS_FIRST_SELECTION";
    const secondSelectedText = "DISMISS_SECOND_SELECTION";
    fixture = await api.createPaperWithPdfFixture({
      title: "Workflow Inline Prompt Dismissal",
      pdfTitle: "Workflow Inline Prompt Dismissal PDF",
      pages: [
        `First ${firstSelectedText} then ${secondSelectedText} on one page.`,
      ],
    });
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const result = await api.exerciseReaderPopupPromptDismissal({
      panelId: panel.panelId,
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      firstSelectedText,
      secondSelectedText,
    });
    const message = JSON.stringify(result);
    assert.isTrue(result.firstMounted, message);
    assert.isTrue(result.escapeClosed, message);
    assert.equal(result.firstChipsAfterEscape, 1, message);
    assert.isTrue(result.secondMounted, message);
    assert.isTrue(result.overlayAndPageInDifferentDocuments, message);
    assert.isTrue(result.pageClickClosed, message);
    assert.equal(result.secondChipsAfterPageClick, 1, message);
    assert.equal(result.chipsWithQuestion, 0, message);
    assert.isFalse(result.sent, message);
  });
});

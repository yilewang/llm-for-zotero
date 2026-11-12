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

describe("workflow: assistant selection inline prompt", function () {
  this.timeout(45000);

  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
  });

  afterEach(async function () {
    if (fixture) {
      await api.cleanupFixture(fixture);
      fixture = null;
    }
    await api.reset();
  });

  it("quotes assistant text, then attaches the inline question to the chip without sending", async function () {
    fixture = await api.createPaperWithPdfFixture({
      title: "Inline Prompt Paper",
      pdfTitle: "Inline Prompt PDF",
      pages: ["Inline prompt page."],
    });
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const prompt = "Explain this claim in one sentence.";
    const result = await api.exerciseAssistantSelectionInlinePrompt({
      panelId: panel.panelId,
      assistantText: "The mitochondria is the powerhouse of the cell.",
      selectedText: "powerhouse of the cell",
      prompt,
    });
    const message = JSON.stringify(result);
    assert.isTrue(result.popupVisible, message);
    assert.isTrue(result.promptExpandedAfterQuote, message);
    assert.isTrue(result.chipAddedBeforeAttach, message);
    // The box shows the selection above the input.
    assert.equal(result.boxSelectedTextLabel, "Selected text", message);
    assert.equal(result.boxSelectedText, "powerhouse of the cell", message);
    assert.equal(
      result.hintText,
      "Enter to add · Shift+Enter for a new line · Esc to close",
      message,
    );
    // Enter attaches; nothing is sent.
    assert.isFalse(result.sentWithinOneSecond, message);
    assert.equal(result.attachedQuestion, prompt, message);
    assert.equal(result.chipCount, 1, message);
    assert.equal(result.previewQuestionText, prompt, message);
    assert.deepEqual(
      result.previewLabels,
      ["Selected text", "Your question"],
      message,
    );
    assert.isTrue(result.popupHiddenAfterAttach, message);
    assert.equal(result.composerAfterAttach, "keep this draft", message);
    assert.equal(
      result.statusAfterAttach,
      "Question attached to the selected text",
      message,
    );
    assert.isTrue(result.composerFocusedAfterAttach, message);
    // The main Send with an empty composer sends the chip's question.
    assert.include(
      result.sentQuestion,
      `Question about this text:\n${prompt}`,
      message,
    );
    assert.equal(result.sentDisplayQuestion, prompt, message);
    assert.include(result.sentSelectedTexts, "powerhouse of the cell", message);
    // The sent bubble shows the question under its own selection only.
    assert.equal(result.sentBubbleBodyText, "", message);
    assert.deepEqual(result.sentBubbleChipQuestions, [prompt], message);
    // The chip with a question is one card; no bar repeats the selection.
    assert.strictEqual(result.sentBubbleBarCount, 0, message);
  });

  it("Escape and an empty Enter keep the chip without a question, and a duplicate quote reopens the box for the same chip", async function () {
    fixture = await api.createPaperWithPdfFixture({
      title: "Inline Prompt Dismissal Paper",
      pdfTitle: "Inline Prompt Dismissal PDF",
      pages: ["Inline prompt dismissal page."],
    });
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const duplicatePrompt = "What counts as a burst?";
    const result = await api.exerciseAssistantSelectionPromptDismissal({
      panelId: panel.panelId,
      assistantText: "Neurons fire in bursts. Synapses adapt over time.",
      firstSelectedText: "Neurons fire in bursts",
      secondSelectedText: "Synapses adapt over time",
      duplicatePrompt,
    });
    const message = JSON.stringify(result);
    assert.isTrue(result.firstExpanded, message);
    assert.isTrue(result.escapeClosed, message);
    assert.equal(result.firstChipsAfterEscape, 1, message);
    assert.equal(result.firstQuestionAfterEscape, "", message);
    // Quoting the same text again opens the box against the existing chip.
    assert.isTrue(result.duplicateExpanded, message);
    assert.equal(
      result.duplicateStatus,
      "Selected text already included",
      message,
    );
    assert.equal(result.firstChipsAfterDuplicate, 1, message);
    assert.isTrue(result.duplicateAttachClosed, message);
    assert.equal(result.firstChipsAfterDuplicateAttach, 1, message);
    assert.equal(
      result.firstQuestionAfterDuplicateAttach,
      duplicatePrompt,
      message,
    );
    assert.isTrue(result.secondExpanded, message);
    assert.isTrue(result.emptyEnterClosed, message);
    assert.equal(result.secondChipsAfterEmptyEnter, 1, message);
    assert.equal(result.secondQuestionAfterEmptyEnter, "", message);
    assert.isFalse(result.sent, message);
  });
});

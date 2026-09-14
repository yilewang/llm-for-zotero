import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import {
  buildNativeQuestionAction,
  nativeQuestionAnswers,
} from "../src/codexAppServer/nativeQuestions";

describe("workflow: native Codex proposal review", function () {
  this.timeout(30000);
  it("enters native planning from the composer shortcut and slash menu", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const pref = "extensions.zotero.llmforzotero.enableCodexAppServerMode";
    const previous = Zotero.Prefs.get(pref, true);
    Zotero.Prefs.set(pref, true, true);
    const fixture = await api.createPaperWithPdfFixture({
      title: "Native planning entry fixture",
      pages: ["Disposable planning entry fixture."],
    });
    try {
      await api.reset();
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      await api.clickPanelSystemToggle(panel.panelId, "codex");
      const doc = Zotero.getMainWindow().document;
      const root = doc.querySelector<HTMLElement>(
        `[data-workflow-panel-id="${panel.panelId}"]`,
      )!;
      const input = root.querySelector<HTMLTextAreaElement>("#llm-input")!;
      const chip = root.querySelector<HTMLElement>("#llm-plan-mode-chip")!;
      input.dispatchEvent(
        new (doc.defaultView as any).KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      assert.notEqual(
        chip.style.display,
        "none",
        "Codex must expose the Plan shortcut despite using the chat transport",
      );
      input.dispatchEvent(
        new (doc.defaultView as any).KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      assert.equal(chip.style.display, "none");
      input.value = "/plan";
      input.dispatchEvent(
        new (doc.defaultView as any).Event("input", { bubbles: true }),
      );
      await Zotero.Promise.delay(50);
      const button = Array.from(
        root.querySelectorAll<HTMLButtonElement>(".llm-action-picker-item"),
      ).find(
        (entry) =>
          entry.querySelector(".llm-action-picker-title")?.textContent ===
          "/plan",
      );
      assert.exists(button, "Codex slash menu should include /plan");
      button!.click();
      assert.notEqual(chip.style.display, "none");
      assert.equal(
        (await api.getDiagnostics(panel.panelId)).runtimeMode,
        "chat",
        "Planning must preserve the native transport",
      );
      const feedback =
        'Add the tag "native-review" to exactly Zotero item 3900.';
      root.querySelector("#llm-main")!.dispatchEvent(
        new (doc.defaultView as any).CustomEvent("llm-plan-revise", {
          bubbles: true,
          detail: {
            planId: "native-feedback-workflow",
            revision: 1,
            provider: "codex",
            comment: feedback,
          },
        }),
      );
      const deadline = Date.now() + 5000;
      while (!api.getLastSend() && Date.now() < deadline)
        await Zotero.Promise.delay(20);
      assert.equal(
        api.getLastSend()?.question,
        feedback,
        "Native revision instructions must not obscure the user's action request",
      );
      assert.equal(api.getLastSend()?.planContext?.revision, 2);
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
      if (previous === undefined) Zotero.Prefs.clear?.(pref, true);
      else Zotero.Prefs.set(pref, previous, true);
    }
  });
  it("requires explicit choices and free text in the native question card", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Native question fixture",
      pages: ["Disposable question fixture."],
    });
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const bridge = await api.exerciseNativeQuestionReview(panel.panelId);
      assert.equal(
        bridge.cardsWhilePending,
        1,
        "Native confirmation and queued trace rendering must share one question card",
      );
      assert.deepEqual(bridge.answer, {
        answers: { audience: { answers: ["Students"] } },
      });
      assert.equal(bridge.activeControlsAfter, 0);
      const questions = [
        {
          id: "format",
          question: "Which format?",
          options: [{ label: "Explanation" }, { label: "Table" }],
        },
        { id: "focus", question: "Which focus?", options: [] },
      ];
      const pending = api.renderPendingActionForPanel(panel.panelId, {
        requestId: "native-question-workflow",
        action: buildNativeQuestionAction(questions),
      });
      const doc = Zotero.getMainWindow().document;
      const card = doc.querySelector<HTMLElement>(
        '[data-request-id="native-question-workflow"]',
      )!;
      assert.isTrue(card.classList.contains("llm-planning-question-card"));
      const submit = card.querySelector<HTMLButtonElement>(
        ".llm-planning-question-continue",
      )!;
      assert.isTrue(submit.disabled);
      assert.notExists(card.querySelector('[aria-checked="true"]'));
      card
        .querySelector<HTMLButtonElement>('[data-option-id="option-1"]')!
        .click();
      card
        .querySelector<HTMLButtonElement>('[aria-label="Next question"]')!
        .click();
      const input = card.querySelector<HTMLInputElement>(
        '.llm-planning-question-panel[aria-hidden="false"] input',
      )!;
      assert.isTrue(submit.disabled);
      input.value = "Representational drift";
      input.dispatchEvent(
        new (doc.defaultView as any).Event("input", { bubbles: true }),
      );
      submit.click();
      assert.deepEqual(nativeQuestionAnswers(questions, await pending), {
        answers: {
          format: { answers: ["Explanation"] },
          focus: { answers: ["Representational drift"] },
        },
      });
      assert.isTrue(submit.disabled);
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
  it("renders the authoritative native Markdown and binds approval to the saved proposal", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const result = await api.exerciseNativePlanReview();
    assert.equal(result.stagedStatus, "drafting");
    assert.equal(result.heading, "Native proposal");
    assert.equal(result.strong, "representational drift");
    assert.include(result.summary || "", "Library changes: none");
    assert.equal(result.approvedStatus, "approved", result.cardText || "");
    assert.equal(
      result.markdown,
      "# Native proposal\n\nExplain **representational drift** using a concrete example.\n\n- State the assumptions.\n- Explain the result.",
    );
    assert.isTrue(result.digestMatches);
    assert.equal(result.continuationId, "workflow-thread");
    assert.equal(result.nativeTitle, "Native planning workflow fixture");
  });
});

import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import {
  buildNativeQuestionAction,
  nativeQuestionAnswers,
} from "../src/codexAppServer/nativeQuestions";

describe("workflow: native Codex proposal review", function () {
  this.timeout(30000);
  it("offers no Plan entry: no chip, no Shift+Tab toggle, no /plan, and the old plan events send nothing", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const pref = "extensions.zotero.llmforzotero.enableCodexAppServerMode";
    const previous = Zotero.Prefs.get(pref, true);
    Zotero.Prefs.set(pref, true, true);
    const fixture = await api.createPaperWithPdfFixture({
      title: "Retired plan entry fixture",
      pages: ["Disposable plan entry fixture."],
    });
    try {
      await api.reset();
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      await api.togglePanelRuntime(panel.panelId, "codex");
      const doc = Zotero.getMainWindow().document;
      const win = doc.defaultView as any;
      const root = doc.querySelector<HTMLElement>(
        `[data-workflow-panel-id="${panel.panelId}"]`,
      )!;
      assert.notExists(
        root.querySelector("#llm-plan-mode-chip"),
        "no Plan chip",
      );
      const input = root.querySelector<HTMLTextAreaElement>("#llm-input")!;
      const shiftTab = new win.KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(shiftTab);
      assert.isFalse(
        shiftTab.defaultPrevented,
        "Shift+Tab is left to the platform: it no longer toggles Plan mode",
      );
      const slashTitles = async (text: string) => {
        input.value = text;
        input.dispatchEvent(new win.Event("input", { bubbles: true }));
        await Zotero.Promise.delay(50);
        return (
          Array.from(
            root.querySelectorAll(".llm-action-picker-item"),
          ) as HTMLElement[]
        ).map(
          (entry) =>
            entry.querySelector(".llm-action-picker-title")?.textContent || "",
        );
      };
      const everything = await slashTitles("/");
      assert.include(everything, "/compact", "the slash menu rendered");
      assert.notInclude(everything, "/plan");
      assert.notInclude(await slashTitles("/plan"), "/plan");
      input.value = "";
      for (const name of [
        "llm-plan-approved",
        "llm-plan-revise",
        "llm-plan-cancel",
      ]) {
        root.querySelector("#llm-main")!.dispatchEvent(
          new win.CustomEvent(name, {
            bubbles: true,
            detail: {
              planId: "retired-plan",
              revision: 1,
              provider: "codex",
              comment: "Change the plan",
            },
          }),
        );
      }
      await Zotero.Promise.delay(200);
      assert.isNull(
        api.getLastSend(),
        "a stale plan card event starts no turn",
      );
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
      assert.equal(
        bridge.cardsAfterResolution,
        0,
        "the resolved question must leave the active card immediately",
      );
      assert.equal(bridge.activeControlsAfter, 0);
      assert.include(
        bridge.questionHistoryText,
        "Answered 1 planning question",
      );
      assert.include(bridge.questionHistoryText, "Which audience?");
      assert.include(bridge.questionHistoryText, "Students");
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
});

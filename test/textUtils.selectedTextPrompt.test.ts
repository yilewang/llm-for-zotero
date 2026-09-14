import { assert } from "chai";
import {
  buildQuestionWithSelectedTextContexts,
  setTokenUsage,
} from "../src/modules/contextPanel/textUtils";
import { initI18n } from "../src/utils/i18n";

describe("textUtils selected text prompt composition", function () {
  it("includes paper attribution for open-chat prompt composition", function () {
    const prompt = buildQuestionWithSelectedTextContexts(
      ["A selected text snippet."],
      ["pdf"],
      "What does this mean?",
      {
        includePaperAttribution: true,
        selectedTextPaperContexts: [
          {
            itemId: 11,
            contextItemId: 12,
            title: "Paper",
            firstCreator: "Smith et al.",
            year: "2021",
          },
        ],
      },
    );
    assert.include(prompt, "[paper=Smith et al., 2021]");
    assert.include(prompt, "[source_label=(Smith et al., 2021)]");
    assert.include(prompt, "Paper citation data:");
    assert.include(prompt, "User question:\nWhat does this mean?");
  });

  it("keeps legacy single-pdf prompt shape when attribution is not requested", function () {
    const prompt = buildQuestionWithSelectedTextContexts(
      ["A selected text snippet."],
      ["pdf"],
      "What does this mean?",
    );
    assert.include(prompt, "Selected text from the PDF reader:");
    assert.notInclude(prompt, "[paper=");
  });

  it("uses note-edit wording for active note editing focus", function () {
    const prompt = buildQuestionWithSelectedTextContexts(
      ["Revise this paragraph."],
      ["note-edit"],
      "Make it clearer.",
    );
    assert.include(
      prompt,
      "Selected text from the current Zotero note editor (editing focus):",
    );
    assert.include(
      prompt,
      "The user selected this snippet inside the active note and wants help editing it in place.",
    );
    assert.include(prompt, "User question:\nMake it clearer.");
  });

  it("uses note wording for selected Zotero note context", function () {
    const prompt = buildQuestionWithSelectedTextContexts(
      ["Draft note content."],
      ["note"],
      "Use this for context.",
    );
    assert.include(prompt, "Selected text from a Zotero note:");
    assert.notInclude(prompt, "editing focus");
    assert.include(prompt, "User question:\nUse this for context.");
  });

  it("labels token usage as estimated active context pressure", function () {
    const tokenEl = {
      textContent: "",
      title: "",
      dataset: {} as Record<string, string>,
      style: { display: "" },
    } as unknown as HTMLElement;
    const gaugeEl = {
      title: "",
      dataset: {} as Record<string, string>,
      style: { display: "", background: "" },
      setAttribute() {},
    } as unknown as HTMLElement;

    setTokenUsage(tokenEl, 90, 100, gaugeEl, { estimated: true });

    assert.equal(tokenEl.textContent, "90 / 100 (90%)");
    assert.include(tokenEl.title, "Estimated active context window usage");
    assert.equal(tokenEl.dataset.summary, "90% used (10% left)");
    assert.equal(tokenEl.dataset.detail, "90 / 100 tokens used");
    assert.equal(tokenEl.dataset.warning, "true");
    assert.equal(gaugeEl.style.display, "inline-block");
    assert.include(gaugeEl.style.background, "324deg");
    assert.equal(gaugeEl.dataset.warning, "true");
  });

  it("uses one localized unavailable presentation for tooltip and accessibility", function () {
    const priorZotero = (globalThis as { Zotero?: unknown }).Zotero;
    let ariaLabel = "";
    try {
      (globalThis as { Zotero?: unknown }).Zotero = {
        locale: "zh-CN",
        Prefs: { get: () => "auto" },
      };
      initI18n();
      const tokenEl = {
        textContent: "",
        title: "",
        dataset: {} as Record<string, string>,
        style: { display: "" },
      } as unknown as HTMLElement;
      const gaugeEl = {
        title: "",
        dataset: {} as Record<string, string>,
        style: { display: "", background: "" },
        setAttribute(name: string, value: string) {
          if (name === "aria-label") ariaLabel = value;
        },
      } as unknown as HTMLElement;

      setTokenUsage(tokenEl, 0, undefined, gaugeEl);

      assert.equal(tokenEl.title, "上下文窗口使用量不可用");
      assert.equal(gaugeEl.title, tokenEl.title);
      assert.equal(ariaLabel, tokenEl.title);
      assert.equal(tokenEl.dataset.summary, "使用量不可用");
    } finally {
      (globalThis as { Zotero?: unknown }).Zotero = priorZotero;
      initI18n();
    }
  });
});

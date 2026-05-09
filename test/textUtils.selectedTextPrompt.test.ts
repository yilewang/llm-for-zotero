import { assert } from "chai";
import { buildQuestionWithSelectedTextContexts } from "../src/modules/contextPanel/textUtils";

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
    assert.include(
      prompt,
      "Paper-grounded citation format for the final answer:",
    );
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
});

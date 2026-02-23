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
            firstCreator: "Jane Smith",
            year: "2021",
          },
        ],
      },
    );
    assert.include(prompt, "[paper=Smith et al., 2021]");
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
});

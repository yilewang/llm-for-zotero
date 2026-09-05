import { assert } from "chai";
import { resolveNormalChatFigureInputs } from "../src/modules/contextPanel/normalChatFigureInputs";

describe("normalChatFigureInputs", function () {
  const paper = {
    itemId: 1,
    contextItemId: 2,
    title: "Figure Evidence Paper",
  };

  it("keeps explicit text-only mode on caption evidence without visual claims", async function () {
    const result = await resolveNormalChatFigureInputs({
      query: "请解释图1",
      papers: [paper],
      model: "deepseek-chat",
      apiBase: "https://api.deepseek.com/v1/chat/completions",
      advanced: {
        temperature: 0.3,
        maxTokens: 4096,
        inputMode: "text_only",
      },
    });

    assert.deepEqual(result.images, []);
    assert.include(
      result.assistantInstruction || "",
      "cannot inspect figure images",
    );
    assert.include(result.assistantInstruction || "", "captions");
  });

  it("does not invoke figure handling for ordinary semantic questions", async function () {
    const result = await resolveNormalChatFigureInputs({
      query: "What is the main result?",
      papers: [paper],
      model: "gpt-5.5",
    });

    assert.deepEqual(result, { images: [], warnings: [] });
  });
});

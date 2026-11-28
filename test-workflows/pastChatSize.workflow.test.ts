import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

/**
 * An attached past chat goes in full only when its rendered section fits
 * the turn's budget. The size is that of the section as rendered (header,
 * and each message's number and role label), not of the message texts:
 * a chat of many short messages is mostly labels.
 */
describe("workflow: attached past chat size", function () {
  const api = () =>
    (Zotero as any).LLMForZotero.api.workflowTest as WorkflowTestApi;

  it("outlines a chat whose rendered text is over the budget, though its words are under it", async function () {
    const messages = Array.from({ length: 2_400 }, (_value, index) => ({
      role: (index % 2 ? "assistant" : "user") as "user" | "assistant",
      text: "ok",
    }));
    const budget = 12_000;
    const { section, tokens } = await api().renderPastChatSectionForTests({
      messages,
      fullTextBudgetTokens: budget,
    });
    assert.isAtMost(tokens, budget, section.slice(0, 300));
    assert.include(section, "only the user's questions are listed");
  });

  it("sends a short chat in full", async function () {
    const { section } = await api().renderPastChatSectionForTests({
      messages: [
        { role: "user", text: "What was the rat called?" },
        { role: "assistant", text: "BISCUIT." },
      ],
      fullTextBudgetTokens: 12_000,
    });
    assert.include(section, "Full text (2 messages):");
    assert.include(section, "BISCUIT.");
  });
});

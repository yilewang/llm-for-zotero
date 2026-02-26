import { assert } from "chai";
import {
  estimateAvailableContextBudget,
  type ChatMessage,
} from "../src/utils/llmClient";

describe("llmClient context budget", function () {
  it("computes budget from model limits and reserves", function () {
    const history: ChatMessage[] = [
      { role: "user", content: "Previous question" },
      { role: "assistant", content: "Previous answer" },
    ];
    const plan = estimateAvailableContextBudget({
      model: "gemini-2.5-pro",
      prompt: "Summarize three papers and compare them.",
      history,
      maxTokens: 200,
    });
    assert.equal(plan.modelLimitTokens, 1_048_576);
    assert.equal(plan.outputReserveTokens, 512);
    assert.equal(plan.reasoningReserveTokens, 256);
    assert.isAtMost(plan.limitTokens, plan.modelLimitTokens);
    assert.isAtMost(plan.baseInputTokens, plan.softLimitTokens);
    assert.isAtLeast(plan.contextBudgetTokens, 1_024);
  });

  it("respects input cap override and high reasoning reserve", function () {
    const plan = estimateAvailableContextBudget({
      model: "gpt-4o-mini",
      prompt: "Find commonality.",
      inputTokenCap: 32_000,
      maxTokens: 12_000,
      reasoning: {
        provider: "openai",
        level: "high",
      },
    });
    assert.equal(plan.limitTokens, 32_000);
    assert.equal(plan.outputReserveTokens, 8_192);
    assert.equal(plan.reasoningReserveTokens, 4_096);
    assert.isAtLeast(plan.contextBudgetTokens, 1_024);
  });
});

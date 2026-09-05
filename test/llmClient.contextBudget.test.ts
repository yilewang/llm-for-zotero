import { assert } from "chai";
import {
  estimateAvailableContextBudget,
  normalizeMaxTokensForRequest,
  prepareChatRequest,
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
    assert.equal(plan.outputReserveTokens, 200);
    assert.equal(plan.reasoningReserveTokens, 256);
    assert.isAtMost(plan.limitTokens, plan.modelLimitTokens);
    assert.isAtMost(plan.baseInputTokens, plan.softLimitTokens);
    assert.isAtLeast(plan.contextBudgetTokens, 0);
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
    assert.equal(plan.outputReserveTokens, 12_000);
    assert.equal(plan.reasoningReserveTokens, 4_096);
    assert.isAtLeast(plan.contextBudgetTokens, 0);
  });

  it("uses the same matching profile override for input and output budgets", function () {
    const plan = estimateAvailableContextBudget({
      model: "claude-haiku-4-5",
      prompt: "Summarize the paper.",
      maxTokens: 4_000,
      profileOverride: {
        forModel: "claude-haiku-4-5",
        limits: { inputTokens: 20_000, outputTokens: 5_000 },
      },
    });

    assert.equal(plan.modelLimitTokens, 20_000);
    assert.equal(plan.limitTokens, 20_000);
    assert.equal(plan.outputReserveTokens, 4_000);
  });

  it("uses one qwen3.8-max cap in planning and final preparation", function () {
    const previousZotero = globalThis.Zotero;
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: { get: () => "" },
    } as typeof Zotero;
    try {
      const plan = estimateAvailableContextBudget({
        model: "qwen3.8-max",
        prompt: "Summarize the paper.",
        inputTokenCap: 1_000_000,
      });
      const prepared = prepareChatRequest({
        model: "qwen3.8-max",
        prompt: "Summarize the paper.",
        inputTokenCap: 1_000_000,
        apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKey: "test",
        authMode: "api_key",
        providerProtocol: "openai_chat_compat",
      });

      assert.equal(plan.limitTokens, 1_000_000);
      assert.equal(prepared.inputCap.limitTokens, 1_000_000);
      assert.equal(prepared.inputCap.limitSource, "advanced");
    } finally {
      (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
        previousZotero;
    }
  });

  it("keeps explicit output values while bounding untouched defaults", function () {
    assert.equal(
      normalizeMaxTokensForRequest({
        value: 200_000,
        maxTokensExplicit: true,
        model: "claude-haiku-4-5",
      }),
      200_000,
    );
    assert.equal(
      normalizeMaxTokensForRequest({
        value: 200_000,
        model: "claude-haiku-4-5",
      }),
      64_000,
    );
  });
});

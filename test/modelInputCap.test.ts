import { assert } from "chai";
import {
  applyModelInputTokenCap,
  estimateConversationTokens,
  getModelInputTokenLimit,
  type InputCapMessage,
} from "../src/utils/modelInputCap";

describe("modelInputCap", function () {
  describe("getModelInputTokenLimit", function () {
    it("should resolve model-specific input limits", function () {
      assert.equal(getModelInputTokenLimit("gpt-4o-mini"), 128000);
      assert.equal(getModelInputTokenLimit("gpt-5.2"), 400000);
      assert.equal(getModelInputTokenLimit("gpt-4.1-mini"), 1047576);
      assert.equal(getModelInputTokenLimit("openai/gpt-4o-mini"), 128000);
      assert.equal(getModelInputTokenLimit("deepseek-reasoner"), 128000);
      assert.equal(getModelInputTokenLimit("gemini-2.5-pro"), 1048576);
      assert.equal(getModelInputTokenLimit("gemini-3-pro"), 1000000);
      assert.equal(getModelInputTokenLimit("qwen-long-latest"), 10000000);
      assert.equal(getModelInputTokenLimit("unknown-custom-model"), 128000);
    });
  });

  describe("applyModelInputTokenCap", function () {
    it("should keep small payloads unchanged", function () {
      const messages: InputCapMessage[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
      ];
      const result = applyModelInputTokenCap(messages, "gpt-4o-mini");
      assert.isFalse(result.capped);
      assert.deepEqual(result.messages, messages);
    });

    it("should trim document context when it exceeds model budget", function () {
      const hugeContext = "A".repeat(700000);
      const messages: InputCapMessage[] = [
        { role: "system", content: "System prompt" },
        {
          role: "system",
          content: `Document Context:\n${hugeContext}`,
        },
        { role: "user", content: "Summarize the key findings." },
      ];
      const result = applyModelInputTokenCap(messages, "deepseek-chat");
      assert.isTrue(result.capped);
      assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
      const contextMessage = result.messages.find(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.startsWith("Document Context:\n"),
      );
      assert.isOk(contextMessage);
      assert.include(
        contextMessage?.content as string,
        "[Context truncated to fit model input limit]",
      );
    });

    it("should drop oldest history before changing the latest user prompt", function () {
      const largeBlock = "B".repeat(260000);
      const latestPrompt = "Final question";
      const messages: InputCapMessage[] = [
        { role: "system", content: "System prompt" },
        { role: "user", content: largeBlock },
        { role: "assistant", content: largeBlock },
        { role: "user", content: latestPrompt },
      ];
      const estimatedBefore = estimateConversationTokens(messages);
      const result = applyModelInputTokenCap(messages, "gpt-4o-mini");
      assert.isAbove(estimatedBefore, result.softLimitTokens);
      assert.isTrue(result.capped);
      const finalMessage = result.messages[result.messages.length - 1];
      assert.equal(finalMessage.role, "user");
      assert.equal(finalMessage.content, latestPrompt);
      assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
    });

    it("should respect a user-provided input cap override", function () {
      const hugeContext = "C".repeat(100000);
      const messages: InputCapMessage[] = [
        { role: "system", content: "System prompt" },
        {
          role: "system",
          content: `Document Context:\n${hugeContext}`,
        },
        { role: "user", content: "Answer briefly." },
      ];
      const result = applyModelInputTokenCap(messages, "gpt-4o-mini", 2048);
      assert.isTrue(result.capped);
      assert.equal(result.limitTokens, 2048);
      assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
    });
  });
});

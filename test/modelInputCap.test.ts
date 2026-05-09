import { assert } from "chai";
import {
  applyModelInputTokenCap,
  estimateContextMessagesTokens,
  estimateConversationTokens,
  getModelInputTokenLimit,
  resolveContextWindowTokens,
  type InputCapMessage,
} from "../src/utils/modelInputCap";

describe("modelInputCap", function () {
  describe("getModelInputTokenLimit", function () {
    it("should resolve model-specific input limits", function () {
      assert.equal(getModelInputTokenLimit("gpt-4o-mini"), 128000);
      assert.equal(getModelInputTokenLimit("gpt-5.4"), 1050000);
      assert.equal(getModelInputTokenLimit("gpt-5.4-pro"), 1050000);
      assert.equal(getModelInputTokenLimit("gpt-5.2"), 400000);
      assert.equal(getModelInputTokenLimit("gpt-4.1-mini"), 1047576);
      assert.equal(getModelInputTokenLimit("openai/gpt-4o-mini"), 128000);
      assert.equal(getModelInputTokenLimit("deepseek-v4-flash"), 1000000);
      assert.equal(getModelInputTokenLimit("deepseek-v4-pro"), 1000000);
      assert.equal(
        getModelInputTokenLimit("deepseek/deepseek-v4-pro"),
        1000000,
      );
      assert.equal(getModelInputTokenLimit("deepseek-reasoner"), 1000000);
      assert.equal(getModelInputTokenLimit("deepseek-chat"), 1000000);
      assert.equal(getModelInputTokenLimit("deepseek-custom"), 128000);
      assert.equal(getModelInputTokenLimit("gemini-2.5-pro"), 1048576);
      assert.equal(getModelInputTokenLimit("gemini-3-pro"), 1000000);
      assert.equal(getModelInputTokenLimit("qwen-long-latest"), 10000000);
      assert.equal(getModelInputTokenLimit("unknown-custom-model"), 128000);
    });
  });

  describe("active context estimates", function () {
    it("counts tool calls, tool results, images, and file references", function () {
      const textOnly = estimateContextMessagesTokens([
        { role: "user", content: "Summarize this." },
      ]);
      const withAgentParts = estimateContextMessagesTokens([
        { role: "user", content: "Summarize this." },
        {
          role: "assistant",
          content: "I will inspect it.",
          tool_calls: [
            {
              id: "call-1",
              name: "read_paper",
              arguments: { target: "paper-1" },
            },
          ],
        },
        {
          role: "tool",
          name: "read_paper",
          tool_call_id: "call-1",
          content: "Extracted methods and results.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Use this figure too." },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,aaa", detail: "high" },
            },
            {
              type: "file_ref",
              file_ref: {
                name: "supplement.pdf",
                mimeType: "application/pdf",
                storedPath: "/tmp/supplement.pdf",
              },
            },
          ],
        },
      ]);

      assert.isAbove(withAgentParts, textOnly);
      assert.isAtLeast(withAgentParts - textOnly, 1500);
    });

    it("resolves the active context window from model and override", function () {
      assert.equal(resolveContextWindowTokens("gpt-5.4"), 1050000);
      assert.equal(resolveContextWindowTokens("gpt-5.4", 64000), 64000);
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
      assert.deepEqual(result.effects, {
        documentContextTrimmed: false,
        documentContextDropped: false,
        promptTrimmed: false,
        historyDropped: false,
      });
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
      const result = applyModelInputTokenCap(messages, "deepseek-custom");
      assert.isTrue(result.capped);
      assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
      assert.isTrue(result.effects.documentContextTrimmed);
      assert.isFalse(result.effects.documentContextDropped);
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
      assert.isTrue(result.effects.historyDropped);
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

    it("should keep large but budgeted context unchanged on long-context models", function () {
      const context = "D".repeat(300000);
      const messages: InputCapMessage[] = [
        { role: "system", content: "System prompt" },
        {
          role: "system",
          content: `Document Context:\n${context}`,
        },
        { role: "user", content: "Compare these papers." },
      ];
      const result = applyModelInputTokenCap(messages, "gemini-2.5-pro");
      assert.isFalse(result.capped);
      assert.equal(result.estimatedAfterTokens, result.estimatedBeforeTokens);
    });
  });
});

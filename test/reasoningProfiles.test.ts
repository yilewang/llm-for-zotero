import { assert } from "chai";
import {
  getAnthropicReasoningProfileForModel,
  getDeepseekReasoningProfileForModel,
  getOpenAIReasoningProfileForModel,
  getReasoningDefaultLevelForModel,
  getRuntimeReasoningOptionsForModel,
} from "../src/utils/reasoningProfiles";
import { buildReasoningPayload } from "../src/utils/llmClient";

describe("reasoningProfiles", function () {
  describe("OpenAI GPT-5 family profiles", function () {
    it("supports xhigh reasoning for gpt-5.4", function () {
      const options = getRuntimeReasoningOptionsForModel("openai", "gpt-5.4");
      assert.deepEqual(
        options.map((option) => option.level),
        ["default", "low", "medium", "high", "xhigh"],
      );

      const profile = getOpenAIReasoningProfileForModel("gpt-5.4");
      assert.equal(profile.defaultLevel, "default");
      assert.deepEqual(profile.levelToEffort, {
        default: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
      });
    });

    it("limits gpt-5.4-pro to medium/high/xhigh reasoning", function () {
      const options = getRuntimeReasoningOptionsForModel(
        "openai",
        "gpt-5.4-pro",
      );
      assert.deepEqual(
        options.map((option) => option.level),
        ["medium", "high", "xhigh"],
      );
      assert.equal(
        getReasoningDefaultLevelForModel("openai", "gpt-5.4-pro"),
        "medium",
      );
    });

    it("limits gpt-5-pro to high reasoning only", function () {
      const options = getRuntimeReasoningOptionsForModel("openai", "gpt-5-pro");
      assert.deepEqual(
        options.map((option) => option.level),
        ["high"],
      );
      assert.equal(
        getReasoningDefaultLevelForModel("openai", "gpt-5-pro"),
        "high",
      );
    });

    it("supports codex-specific xhigh reasoning on gpt-5.2 and gpt-5.3 codex", function () {
      const gpt52Codex = getRuntimeReasoningOptionsForModel(
        "openai",
        "gpt-5.2-codex",
      );
      const gpt53Codex = getRuntimeReasoningOptionsForModel(
        "openai",
        "gpt-5.3-codex",
      );

      assert.deepEqual(
        gpt52Codex.map((option) => option.level),
        ["low", "medium", "high", "xhigh"],
      );
      assert.deepEqual(
        gpt53Codex.map((option) => option.level),
        ["low", "medium", "high", "xhigh"],
      );
    });
  });

  describe("DeepSeek V4 profiles", function () {
    it("supports disabled, high, and max thinking modes", function () {
      const options = getRuntimeReasoningOptionsForModel(
        "deepseek",
        "deepseek-v4-pro",
      );
      assert.deepEqual(
        options.map((option) => option.level),
        ["default", "minimal", "high", "xhigh"],
      );

      const profile = getDeepseekReasoningProfileForModel(
        "deepseek/deepseek-v4-flash",
      );
      assert.equal(profile.defaultLevel, "default");
      assert.equal(profile.defaultThinkingType, "enabled");
      assert.equal(profile.defaultReasoningEffort, "high");
      assert.isTrue(profile.omitTemperatureWhenThinking);
      assert.equal(profile.levelToThinkingType.minimal, "disabled");
      assert.equal(profile.levelToReasoningEffort.xhigh, "max");
    });

    it("builds documented DeepSeek V4 thinking payloads", function () {
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "deepseek", level: "minimal" },
          false,
          "deepseek-v4-pro",
        ),
        {
          extra: { thinking: { type: "disabled" } },
          omitTemperature: false,
        },
      );
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "deepseek", level: "high" },
          false,
          "deepseek-v4-pro",
        ),
        {
          extra: {
            thinking: { type: "enabled" },
            reasoning_effort: "high",
          },
          omitTemperature: true,
        },
      );
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "deepseek", level: "xhigh" },
          false,
          "deepseek-v4-pro",
        ),
        {
          extra: {
            thinking: { type: "enabled" },
            reasoning_effort: "max",
          },
          omitTemperature: true,
        },
      );
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "deepseek", level: "xhigh" },
          false,
          "deepseek-v4-pro",
          "https://api.deepseek.com/anthropic",
          "anthropic_messages",
        ),
        {
          extra: {
            thinking: { type: "enabled" },
            output_config: { effort: "max" },
          },
          omitTemperature: true,
        },
      );
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "deepseek", level: "default" },
          false,
          "deepseek-reasoner",
        ),
        {
          extra: { thinking: { type: "enabled" } },
          omitTemperature: false,
        },
      );
    });
  });

  describe("Anthropic profiles", function () {
    it("classifies current Opus, Sonnet, and Haiku thinking modes", function () {
      const opus47 = getAnthropicReasoningProfileForModel("claude-opus-4-7");
      assert.isTrue(opus47.supportsAdaptiveThinking);
      assert.isFalse(opus47.supportsManualThinking);
      assert.equal(opus47.preferredMode, "adaptive");
      assert.equal(opus47.levelToEffort.xhigh, "xhigh");

      const sonnet46 =
        getAnthropicReasoningProfileForModel("claude-sonnet-4-6");
      assert.isTrue(sonnet46.supportsAdaptiveThinking);
      assert.isTrue(sonnet46.supportsManualThinking);
      assert.equal(sonnet46.preferredMode, "adaptive");
      assert.equal(sonnet46.levelToEffort.xhigh, "max");

      const haiku45 = getAnthropicReasoningProfileForModel(
        "claude-haiku-4-5-20251001",
      );
      assert.isFalse(haiku45.supportsAdaptiveThinking);
      assert.isTrue(haiku45.supportsManualThinking);
      assert.equal(haiku45.preferredMode, "manual");
    });

    it("does not expose reasoning options for unknown Claude models", function () {
      assert.deepEqual(
        getRuntimeReasoningOptionsForModel("anthropic", "claude-unknown-3"),
        [],
      );
    });

    it("builds Anthropic payloads only for Anthropic Messages protocol", function () {
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "anthropic", level: "high" },
          false,
          "claude-sonnet-4-6",
          "https://api.anthropic.com/v1",
          "openai_chat_compat",
          { maxTokens: 4096 },
        ),
        { extra: {}, omitTemperature: false },
      );

      assert.deepEqual(
        buildReasoningPayload(
          { provider: "anthropic", level: "xhigh" },
          false,
          "claude-sonnet-4-6",
          "https://api.anthropic.com/v1",
          "anthropic_messages",
          { maxTokens: 4096 },
        ),
        {
          extra: {
            thinking: { type: "adaptive" },
            output_config: { effort: "max" },
          },
          omitTemperature: true,
        },
      );

      assert.deepEqual(
        buildReasoningPayload(
          { provider: "anthropic", level: "xhigh" },
          false,
          "claude-opus-4-7",
          "https://api.anthropic.com/v1",
          "anthropic_messages",
          { maxTokens: 4096 },
        ),
        {
          extra: {
            thinking: { type: "adaptive" },
            output_config: { effort: "xhigh" },
          },
          omitTemperature: true,
        },
      );

      assert.deepEqual(
        buildReasoningPayload(
          { provider: "anthropic", level: "high" },
          false,
          "claude-haiku-4-5",
          "https://api.anthropic.com/v1",
          "anthropic_messages",
          { maxTokens: 4096 },
        ),
        {
          extra: {
            thinking: { type: "enabled", budget_tokens: 3072 },
          },
          omitTemperature: true,
        },
      );
    });
  });
});

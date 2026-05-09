import { assert } from "chai";
import {
  getOpenAIReasoningProfileForModel,
  getReasoningDefaultLevelForModel,
  getRuntimeReasoningOptionsForModel,
} from "../src/utils/reasoningProfiles";

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
});

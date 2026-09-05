import { assert } from "chai";
import bundledRegistryJson from "../registry/model-capabilities.v1.json";
import { BUNDLED_MODEL_CAPABILITY_REGISTRY } from "../src/modelCapabilities/bundled";
import {
  getModelOutputTokenLimit,
  resetModelCapabilityStateForTests,
} from "../src/modelCapabilities";
import { getModelInputTokenLimit } from "../src/utils/modelInputCap";

describe("bundled model capability registry parity", function () {
  afterEach(function () {
    resetModelCapabilityStateForTests();
  });

  it("uses the checked-in JSON as the bundled runtime registry", function () {
    assert.deepEqual(BUNDLED_MODEL_CAPABILITY_REGISTRY, bundledRegistryJson);
    assert.equal(BUNDLED_MODEL_CAPABILITY_REGISTRY.revision, 3);
  });

  it("preserves every migrated legacy input-limit pattern", function () {
    const cases: Array<[string, number]> = [
      ["qwen-long-latest", 10_000_000],
      ["qwen-turbo-latest", 1_000_000],
      ["qwen-max-latest", 129_024],
      ["gemini-2.5-pro", 1_048_576],
      ["gemini-2-5-pro", 1_048_576],
      ["gemini-25-pro", 1_048_576],
      ["gemini-3-pro", 1_000_000],
      ["gemini-1.5-pro", 1_000_000],
      ["gemini-1-5-pro", 1_000_000],
      ["gemini-15-pro", 1_000_000],
      ["gpt-4.1-mini", 1_047_576],
      ["gpt-4-1-mini", 1_047_576],
      ["gpt-41-mini", 1_047_576],
      ["gpt-5.4-pro", 1_050_000],
      ["gpt-5.2", 400_000],
      ["o3-mini", 200_000],
      ["o1-pro", 200_000],
      ["o1-mini", 200_000],
      ["gpt-4o-mini", 128_000],
      ["claude-sonnet-4-5", 200_000],
      ["grok-4.1-fast", 2_000_000],
      ["grok-4-1-fast", 2_000_000],
      ["grok-41-fast", 2_000_000],
      ["grok-4-fast", 2_000_000],
      ["grok-code-fast-1", 256_000],
      ["grok-4", 256_000],
      ["grok-3", 131_072],
      ["command-a-reasoning", 256_000],
      ["command-r+", 128_000],
      ["command-r-plus", 128_000],
      ["command-r", 128_000],
      ["mistral-large-3", 256_000],
      ["ministral-3-14b", 256_000],
      ["mistral-medium-3", 128_000],
      ["mistral-small-3", 128_000],
      ["codestral", 128_000],
      ["deepseek-v4-flash", 1_000_000],
      ["deepseek-v4-pro", 1_000_000],
      ["deepseek-chat", 1_000_000],
      ["deepseek-reasoner", 1_000_000],
      ["deepseek-custom", 128_000],
    ];

    for (const [model, expected] of cases) {
      assert.equal(getModelInputTokenLimit(model), expected, model);
    }
  });

  it("preserves migrated output limits and proxy-tail matching", function () {
    const cases: Array<[string, number]> = [
      ["claude-opus-4-7", 128_000],
      ["anthropic.claude-opus-4-6", 128_000],
      ["bedrock:claude-opus-4-7", 128_000],
      ["claude-sonnet-4-6", 64_000],
      ["anthropic.claude-haiku-4-5", 64_000],
      ["proxy.vendor.claude-sonnet-4-6", 64_000],
      ["openrouter/deepseek-v4-flash", 384_000],
      ["deepseek/deepseek-v4-pro", 384_000],
      ["deepseek-chat", 384_000],
      ["deepseek-reasoner", 384_000],
    ];

    for (const [model, expected] of cases) {
      assert.equal(getModelOutputTokenLimit(model), expected, model);
    }
  });
});

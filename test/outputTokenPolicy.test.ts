import { assert } from "chai";
import {
  AUTO_REQUIRED_OUTPUT_TOKEN_SEED,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  INPUT_ESTIMATE_SAFETY_RATIO,
  resolveContextAllocation,
  resolveOutputRequestPolicy,
  resolveOutputReserve,
  resolveTransmittedOutputPolicy,
  type OutputRequestPolicy,
} from "../src/utils/outputTokenPolicy";

describe("output token policy", function () {
  it("omits optional provider caps in Auto mode", function () {
    for (const protocol of [
      "responses_api",
      "openai_chat_compat",
      "gemini_native",
    ] as const) {
      assert.deepEqual(
        resolveOutputRequestPolicy({
          setting: { mode: "auto" },
          model: "unknown-model",
          protocol,
          authMode: "api_key",
        }),
        { mode: "omit", source: "auto_provider" },
      );
    }
  });

  it("sends a registry-known output limit for OpenAI-compatible providers", function () {
    for (const protocol of ["openai_chat_compat", "responses_api"] as const) {
      assert.deepEqual(
        resolveOutputRequestPolicy({
          setting: { mode: "auto" },
          model: "deepseek-chat",
          apiBase: "https://api.deepseek.com/v1",
          protocol,
          authMode: "api_key",
        }),
        { mode: "numeric", tokens: 384_000, source: "auto_capability" },
      );
    }
  });

  it("keeps native harness output limits runtime-managed", function () {
    for (const authMode of ["codex_auth", "codex_app_server"] as const) {
      assert.deepEqual(
        resolveOutputRequestPolicy({
          setting: { mode: "custom", tokens: 123 },
          model: "gpt-5.6-sol",
          protocol: "codex_responses",
          authMode,
        }),
        { mode: "runtime_managed", source: "runtime" },
      );
    }
  });

  it("uses an authoritative capability for required Anthropic max_tokens", function () {
    assert.deepEqual(
      resolveOutputRequestPolicy({
        setting: { mode: "auto" },
        model: "claude-sonnet-4-6",
        protocol: "anthropic_messages",
        authMode: "api_key",
      }),
      { mode: "numeric", tokens: 64_000, source: "auto_capability" },
    );
  });

  it("uses a compatibility seed only when Anthropic capability is unknown", function () {
    assert.deepEqual(
      resolveOutputRequestPolicy({
        setting: { mode: "auto" },
        model: "unknown-anthropic-compatible-model",
        protocol: "anthropic_messages",
        authMode: "api_key",
      }),
      {
        mode: "numeric",
        tokens: AUTO_REQUIRED_OUTPUT_TOKEN_SEED,
        source: "auto_compatibility",
      },
    );
  });

  it("honors and defensively clamps custom limits", function () {
    assert.deepEqual(
      resolveOutputRequestPolicy({
        setting: { mode: "custom", tokens: 200_000 },
        model: "claude-sonnet-4-6",
        protocol: "anthropic_messages",
        authMode: "api_key",
      }),
      { mode: "numeric", tokens: 64_000, source: "custom" },
    );
  });

  it("keeps context reservation separate from the transmitted Auto policy", function () {
    assert.equal(
      resolveOutputReserve({ mode: "auto" }, "deepseek-v4-pro"),
      DEFAULT_OUTPUT_RESERVE_TOKENS,
    );
    assert.equal(
      resolveOutputReserve(
        { mode: "custom", tokens: 2_048 },
        "deepseek-v4-pro",
      ),
      2_048,
    );
  });
});

describe("context allocation", function () {
  const opusPolicy: OutputRequestPolicy = {
    mode: "numeric",
    tokens: 128_000,
    source: "auto_capability",
  };

  it("reserves answer room out of the usable window for a numeric cap", function () {
    const allocation = resolveContextAllocation({
      contextWindow: 200_000,
      policy: opusPolicy,
    });
    assert.equal(allocation.usableTokens, 180_000);
    assert.equal(allocation.answerReserveTokens, DEFAULT_OUTPUT_RESERVE_TOKENS);
    assert.equal(
      allocation.inputBudgetTokens,
      180_000 - DEFAULT_OUTPUT_RESERVE_TOKENS,
    );
  });

  it("never reserves more than the custom cap itself", function () {
    const allocation = resolveContextAllocation({
      contextWindow: 200_000,
      policy: { mode: "numeric", tokens: 2_048, source: "custom" },
    });
    assert.equal(allocation.answerReserveTokens, 2_048);
    assert.equal(allocation.inputBudgetTokens, 180_000 - 2_048);
  });

  it("reserves a custom cap above the default so a full prompt still transmits it", function () {
    const custom: OutputRequestPolicy = {
      mode: "numeric",
      tokens: 32_000,
      source: "custom",
    };
    const allocation = resolveContextAllocation({
      contextWindow: 200_000,
      policy: custom,
    });
    assert.equal(allocation.answerReserveTokens, 32_000);
    assert.equal(allocation.inputBudgetTokens, 180_000 - 32_000);
    // The largest prompt the planner may build must not shrink the user's cap.
    const transmitted = resolveTransmittedOutputPolicy({
      policy: custom,
      contextWindow: 200_000,
      estimatedInputTokens: allocation.inputBudgetTokens,
    });
    assert.equal(transmitted.mode, "numeric");
    if (transmitted.mode !== "numeric") return;
    assert.equal(transmitted.tokens, 32_000);
  });

  it("caps a custom reserve at the answer share of the usable window", function () {
    const allocation = resolveContextAllocation({
      contextWindow: 200_000,
      policy: { mode: "numeric", tokens: 200_000, source: "custom" },
    });
    assert.equal(allocation.answerReserveTokens, 45_000);
    assert.equal(allocation.inputBudgetTokens, 180_000 - 45_000);
  });

  it("scales the reserve down on tiny context windows", function () {
    const allocation = resolveContextAllocation({
      contextWindow: 8_000,
      policy: { mode: "omit", source: "auto_provider" },
    });
    assert.equal(allocation.usableTokens, 7_200);
    assert.equal(allocation.answerReserveTokens, 1_800);
    assert.equal(allocation.inputBudgetTokens, 5_400);
  });

  it("clamps the transmitted cap so input plus cap fits the context window", function () {
    const shortPrompt = resolveTransmittedOutputPolicy({
      policy: opusPolicy,
      contextWindow: 200_000,
      estimatedInputTokens: 1_000,
    });
    assert.deepEqual(shortPrompt, opusPolicy);

    const longPrompt = resolveTransmittedOutputPolicy({
      policy: opusPolicy,
      contextWindow: 200_000,
      estimatedInputTokens: 100_000,
    });
    assert.equal(longPrompt.mode, "numeric");
    if (longPrompt.mode !== "numeric") return;
    assert.equal(
      longPrompt.tokens,
      200_000 - Math.ceil(100_000 * INPUT_ESTIMATE_SAFETY_RATIO),
    );
    assert.isAtMost(
      Math.ceil(100_000 * INPUT_ESTIMATE_SAFETY_RATIO) + longPrompt.tokens,
      200_000,
    );
    assert.equal(longPrompt.source, opusPolicy.source);
  });

  it("floors the transmitted cap at the answer reserve when input is over budget", function () {
    const overBudget = resolveTransmittedOutputPolicy({
      policy: opusPolicy,
      contextWindow: 200_000,
      estimatedInputTokens: 195_000,
    });
    assert.equal(overBudget.mode, "numeric");
    if (overBudget.mode !== "numeric") return;
    assert.equal(overBudget.tokens, DEFAULT_OUTPUT_RESERVE_TOKENS);
  });

  it("leaves non-numeric policies untouched", function () {
    for (const policy of [
      { mode: "omit", source: "auto_provider" },
      { mode: "unlimited", source: "auto_provider" },
      { mode: "runtime_managed", source: "runtime" },
    ] as OutputRequestPolicy[]) {
      assert.deepEqual(
        resolveTransmittedOutputPolicy({
          policy,
          contextWindow: 200_000,
          estimatedInputTokens: 199_000,
        }),
        policy,
      );
    }
  });
});

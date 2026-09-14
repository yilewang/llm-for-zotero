import { assert } from "chai";
import {
  callUtilityLLM,
  resolveUtilityReasoningPlan,
} from "../src/utils/utilityLLM";

const completeOutcome = (text: string) => ({
  text,
  completion: { status: "complete" as const },
});

describe("utility LLM policy", function () {
  it("reports output exhaustion without returning partial structured authority", async function () {
    const result = await callUtilityLLM({
      prompt: "Return JSON",
      model: "deepseek-v4-flash",
      apiBase: "https://api.deepseek.com",
      apiKey: "fixture",
      jsonBudget: 5000,
      timeoutMs: 180000,
      llmCall: async () => ({
        text: '{"actions":[',
        completion: { status: "incomplete", reason: "output_limit" },
      }),
    });
    assert.isFalse(result.ok);
    assert.equal(result.ok ? "" : result.reason, "output_limit");
    assert.notProperty(result, "text");
  });

  it("honors supported configured reasoning for semantic utility work", async function () {
    let captured: any;
    const result = await callUtilityLLM({
      prompt: "Interpret intent",
      model: "deepseek-v4-flash",
      apiBase: "https://api.deepseek.com/anthropic",
      apiKey: "fixture",
      providerProtocol: "anthropic_messages",
      reasoning: { provider: "deepseek", level: "high" },
      jsonBudget: 500,
      timeoutMs: 20000,
      llmCall: async (params) => {
        captured = params;
        return completeOutcome("{}");
      },
    });
    assert.isTrue(result.ok);
    assert.deepEqual(captured.reasoning, {
      provider: "deepseek",
      level: "high",
    });
    assert.isAbove(captured.outputTokenLimit.tokens, 500);
  });

  function capture(params: {
    model: string;
    apiBase: string;
    providerProtocol:
      | "openai_chat_compat"
      | "anthropic_messages"
      | "gemini_native"
      | "ollama_native";
    profileOverride?: Record<string, unknown>;
    jsonBudget?: number;
  }): Promise<{
    result: Awaited<ReturnType<typeof callUtilityLLM>>;
    request: Record<string, unknown>;
  }> {
    let request: Record<string, unknown> = {};
    return callUtilityLLM({
      prompt: "Return JSON.",
      ...params,
      apiKey: "test-key",
      jsonBudget: params.jsonBudget || 200,
      timeoutMs: 10_000,
      llmCall: async (chatParams) => {
        request = chatParams as unknown as Record<string, unknown>;
        return completeOutcome("{}");
      },
    }).then((result) => ({ result, request }));
  }

  it("uses explicit low reasoning for GPT-5.4 instead of inheriting main reasoning", async function () {
    const captured = await capture({
      model: "gpt-5.4",
      apiBase: "https://api.openai.com/v1",
      providerProtocol: "openai_chat_compat",
    });

    assert.isTrue(captured.result.ok);
    assert.deepEqual(captured.request.reasoning, {
      provider: "openai",
      level: "low",
    });
    assert.deepEqual(captured.request.outputTokenLimit, {
      mode: "custom",
      tokens: 1_224,
    });
  });

  it("selects the lowest supported effort for GPT-5 Pro variants with a reserve", async function () {
    const pro = await capture({
      model: "gpt-5.4-pro",
      apiBase: "https://api.openai.com/v1",
      providerProtocol: "openai_chat_compat",
    });
    const highOnly = await capture({
      model: "gpt-5-pro",
      apiBase: "https://api.openai.com/v1",
      providerProtocol: "openai_chat_compat",
    });

    assert.deepEqual(pro.request.reasoning, {
      provider: "openai",
      level: "medium",
    });
    assert.deepEqual(pro.request.outputTokenLimit, {
      mode: "custom",
      tokens: 2_248,
    });
    assert.deepEqual(highOnly.request.reasoning, {
      provider: "openai",
      level: "high",
    });
    assert.deepEqual(highOnly.request.outputTokenLimit, {
      mode: "custom",
      tokens: 4_296,
    });
  });

  it("sends no reasoning and reserves nothing for a pre-reasoning OpenAI model", async function () {
    const captured = await capture({
      model: "gpt-4o",
      apiBase: "https://api.openai.com/v1",
      providerProtocol: "openai_chat_compat",
    });

    assert.isTrue(captured.result.ok);
    // Forcing `low` here would 400 on gpt-4o, cost a recovery round trip, and
    // reserve 1024 tokens the model never spends.
    assert.isUndefined(captured.request.reasoning);
    assert.deepEqual(captured.request.outputTokenLimit, {
      mode: "custom",
      tokens: 200,
    });
    assert.equal(captured.request.temperature, 0);
  });

  it("omits Anthropic thinking for bounded utility calls", async function () {
    const captured = await capture({
      model: "claude-haiku-4-5",
      apiBase: "https://api.anthropic.com",
      providerProtocol: "anthropic_messages",
    });

    assert.isTrue(captured.result.ok);
    assert.isUndefined(captured.request.reasoning);
    assert.deepEqual(captured.request.outputTokenLimit, {
      mode: "custom",
      tokens: 200,
    });
  });

  it("uses disabled Gemini thinking when the model supports it and reserves numeric thinking otherwise", async function () {
    const flash = await capture({
      model: "gemini-2.5-flash",
      apiBase: "https://generativelanguage.googleapis.com",
      providerProtocol: "gemini_native",
    });
    const pro = await capture({
      model: "gemini-2.5-pro",
      apiBase: "https://generativelanguage.googleapis.com",
      providerProtocol: "gemini_native",
    });

    assert.deepEqual(flash.request.reasoning, {
      provider: "gemini",
      level: "minimal",
    });
    assert.deepEqual(flash.request.outputTokenLimit, {
      mode: "custom",
      tokens: 200,
    });
    assert.deepEqual(pro.request.reasoning, {
      provider: "gemini",
      level: "low",
    });
    assert.deepEqual(pro.request.outputTokenLimit, {
      mode: "custom",
      tokens: 328,
    });
  });

  it("does not send a utility request when the matching profile cap cannot fit its reserve", async function () {
    let calls = 0;
    const result = await callUtilityLLM({
      prompt: "Return JSON.",
      model: "gpt-5.4",
      apiBase: "https://api.openai.com/v1",
      apiKey: "test-key",
      providerProtocol: "openai_chat_compat",
      profileOverride: {
        forModel: "gpt-5.4",
        limits: { outputTokens: 300 },
      },
      jsonBudget: 200,
      timeoutMs: 10_000,
      llmCall: async () => {
        calls += 1;
        return completeOutcome("{}");
      },
    });

    assert.isFalse(result.ok);
    assert.equal(result.ok ? "" : result.reason, "budget_unavailable");
    // The cap and the shortfall have to reach the log, or a user who set the
    // override has no way to learn why the feature went quiet.
    assert.include(
      result.ok ? "" : result.detail || "",
      "caps output at 300 tokens",
    );
    assert.equal(calls, 0);
  });

  it("leaves a mismatched profile dormant", async function () {
    const captured = await capture({
      model: "gpt-5.4",
      apiBase: "https://api.openai.com/v1",
      providerProtocol: "openai_chat_compat",
      profileOverride: {
        forModel: "a-different-model",
        limits: { outputTokens: 300 },
      },
    });

    assert.isTrue(captured.result.ok);
    assert.deepEqual(captured.request.outputTokenLimit, {
      mode: "custom",
      tokens: 1_224,
    });
  });

  it("applies a profile-authored disabled control", async function () {
    const plan = resolveUtilityReasoningPlan({
      model: "my-local-model",
      apiBase: "http://127.0.0.1:11434",
      providerProtocol: "ollama_native",
      profileOverride: {
        forModel: "my-local-model",
        reasoning: {
          kind: "select",
          defaultOptionId: "none",
          options: [
            {
              id: "none",
              label: "Disabled",
              controls: { body: { think: false } },
            },
          ],
        },
      },
    });

    assert.deepEqual(plan, {
      reasoning: { provider: "local", level: "none" },
      reserveTokens: 0,
    });
  });

  it("uses a profile-authored Gemini thinking budget as the reserve", function () {
    const plan = resolveUtilityReasoningPlan({
      model: "gemini-custom",
      apiBase: "https://generativelanguage.googleapis.com",
      providerProtocol: "gemini_native",
      profileOverride: {
        forModel: "gemini-custom",
        reasoning: {
          kind: "select",
          defaultOptionId: "low",
          options: [
            {
              id: "low",
              label: "Low",
              controls: { body: { thinking_budget: 2_048 } },
            },
          ],
        },
      },
    });

    assert.deepEqual(plan, {
      reasoning: { provider: "gemini", level: "low" },
      reserveTokens: 2_048,
    });
  });

  it("classifies empty utility responses separately from transport failures", async function () {
    const result = await callUtilityLLM({
      prompt: "Return JSON.",
      model: "gpt-5.4",
      apiBase: "https://api.openai.com/v1",
      apiKey: "test-key",
      providerProtocol: "openai_chat_compat",
      jsonBudget: 200,
      timeoutMs: 10_000,
      llmCall: async () => completeOutcome("   "),
    });

    assert.isFalse(result.ok);
    assert.equal(result.ok ? "" : result.reason, "empty");
  });

  it("carries the provider's status and message on a transport failure", async function () {
    const result = await callUtilityLLM({
      prompt: "Return JSON.",
      model: "gpt-5.4",
      apiBase: "https://api.openai.com/v1",
      apiKey: "test-key",
      providerProtocol: "openai_chat_compat",
      jsonBudget: 200,
      timeoutMs: 10_000,
      llmCall: async () => {
        throw new Error(
          '401 Unauthorized (https://api.openai.com/v1/chat/completions) - {"error":{"message":"Incorrect API key"}}',
        );
      },
    });

    assert.isFalse(result.ok);
    assert.equal(result.ok ? "" : result.reason, "transport");
    assert.equal(result.ok ? 0 : result.status, 401);
    assert.include(result.ok ? "" : result.detail || "", "Incorrect API key");
  });

  it("reports a timeout separately from an ordinary transport failure", async function () {
    const result = await callUtilityLLM({
      prompt: "Return JSON.",
      model: "gpt-5.4",
      apiBase: "https://api.openai.com/v1",
      apiKey: "test-key",
      providerProtocol: "openai_chat_compat",
      jsonBudget: 200,
      timeoutMs: 10_000,
      llmCall: async () => {
        throw new Error("LLM call timed out after 10000ms");
      },
    });

    assert.isFalse(result.ok);
    assert.equal(result.ok ? "" : result.reason, "timeout");
    assert.isUndefined(result.ok ? 0 : result.status);
  });
});

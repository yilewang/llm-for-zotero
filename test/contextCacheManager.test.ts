import { assert } from "chai";
import {
  clearContextCacheTelemetry,
  extractContextCacheUsage,
  getContextCacheTelemetry,
  listContextCacheTelemetry,
  planContextCacheReuse,
  recordContextCacheTelemetry,
  resolvePromptCacheCapability,
  shouldPreferCacheAwareFullContext,
} from "../src/contextCache/manager";

describe("context cache manager", function () {
  beforeEach(function () {
    clearContextCacheTelemetry();
  });

  it("maps documented providers to cache capabilities", function () {
    assert.deepInclude(
      resolvePromptCacheCapability({
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1/responses",
        protocol: "responses_api",
      }),
      {
        kind: "automatic_prefix",
        provider: "openai",
        telemetry: "openai_cached_tokens",
        supportsPromptCacheKey: true,
      },
    );
    assert.deepInclude(
      resolvePromptCacheCapability({
        model: "deepseek-chat",
        apiBase: "https://api.deepseek.com/v1",
        protocol: "openai_chat_compat",
      }),
      {
        kind: "automatic_prefix",
        provider: "deepseek",
        telemetry: "deepseek_hit_miss",
      },
    );
    assert.deepInclude(
      resolvePromptCacheCapability({
        model: "claude-sonnet-4-6",
        apiBase: "https://api.anthropic.com/v1",
        protocol: "anthropic_messages",
      }),
      {
        kind: "explicit_blocks",
        provider: "anthropic",
        telemetry: "anthropic_read_write",
        supportsAnthropicBlockCacheControl: true,
        supportsAnthropicToolCacheControl: true,
        supportsAnthropicRequestCacheControl: true,
      },
    );
    assert.deepInclude(
      resolvePromptCacheCapability({
        model: "minimax-m2",
        apiBase: "https://api.minimax.io/anthropic",
        protocol: "anthropic_messages",
      }),
      {
        kind: "explicit_blocks",
        provider: "minimax",
        telemetry: "anthropic_read_write",
        supportsAnthropicBlockCacheControl: true,
        supportsAnthropicToolCacheControl: true,
      },
    );
    assert.notProperty(
      resolvePromptCacheCapability({
        model: "deepseek-chat",
        apiBase: "https://api.deepseek.com/anthropic",
        protocol: "anthropic_messages",
      }),
      "supportsAnthropicBlockCacheControl",
    );
    assert.notProperty(
      resolvePromptCacheCapability({
        model: "glm-4.6",
        apiBase: "https://open.bigmodel.cn/api/anthropic",
        protocol: "anthropic_messages",
      }),
      "supportsAnthropicBlockCacheControl",
    );
    assert.equal(
      resolvePromptCacheCapability({
        model: "gemini-2.5-pro",
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        protocol: "gemini_native",
      }).provider,
      "gemini",
    );
    assert.equal(
      resolvePromptCacheCapability({
        model: "kimi-k2",
        apiBase: "https://api.moonshot.ai/v1",
        protocol: "openai_chat_compat",
      }).provider,
      "kimi",
    );
    assert.deepInclude(
      resolvePromptCacheCapability({
        model: "gpt-5.4",
        authMode: "codex_app_server",
        protocol: "codex_responses",
      }),
      {
        kind: "opaque",
        provider: "codex",
      },
    );
  });

  it("enables cache plans only for full context above provider cache threshold", function () {
    const contextText = "stable paper text ".repeat(1200);
    const plan = planContextCacheReuse({
      model: "gpt-5.4",
      apiBase: "https://api.openai.com/v1/responses",
      protocol: "responses_api",
      mode: "full",
      strategy: "paper-cache-full",
      contextText,
      paperContexts: [{ itemId: 1, contextItemId: 2, title: "Paper" }],
    });

    assert.isTrue(plan.enabled);
    assert.equal(plan.mode, "stable_prefix");
    assert.isString(plan.requestHints?.promptCacheKey);
    assert.equal(plan.requestHints?.promptCacheRetention, "24h");

    const legacyPlan = planContextCacheReuse({
      model: "gpt-4.1",
      apiBase: "https://api.openai.com/v1/responses",
      protocol: "responses_api",
      mode: "full",
      strategy: "paper-cache-full",
      contextText,
    });
    assert.isUndefined(legacyPlan.requestHints?.promptCacheRetention);

    const oSeriesPlan = planContextCacheReuse({
      model: "o3",
      apiBase: "https://api.openai.com/v1/responses",
      protocol: "responses_api",
      mode: "full",
      strategy: "paper-cache-full",
      contextText,
    });
    assert.equal(oSeriesPlan.requestHints?.promptCacheRetention, "24h");

    const retrievalPlan = planContextCacheReuse({
      model: "gpt-5.4",
      apiBase: "https://api.openai.com/v1/responses",
      protocol: "responses_api",
      mode: "retrieval",
      strategy: "general-retrieval",
      contextText,
    });
    assert.isFalse(retrievalPlan.enabled);
    assert.equal(retrievalPlan.mode, "retrieval_fallback");
  });

  it("normalizes cache telemetry across provider usage payloads", function () {
    assert.deepInclude(
      extractContextCacheUsage({
        prompt_tokens: 2000,
        prompt_tokens_details: { cached_tokens: 1500 },
      }),
      {
        cacheReadTokens: 1500,
        cacheMissTokens: 500,
        cacheProvider: "openai",
      },
    );
    assert.deepInclude(
      extractContextCacheUsage({
        prompt_tokens: 2000,
        prompt_cache_hit_tokens: 1200,
        prompt_cache_miss_tokens: 800,
      }),
      {
        cacheReadTokens: 1200,
        cacheMissTokens: 800,
        cacheProvider: "deepseek",
      },
    );
    assert.deepInclude(
      extractContextCacheUsage({
        input_tokens: 2000,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 900,
      }),
      {
        cacheReadTokens: 1000,
        cacheWriteTokens: 900,
        cacheProvider: "anthropic",
      },
    );
    assert.deepInclude(
      extractContextCacheUsage({
        promptTokenCount: 2000,
        cachedContentTokenCount: 700,
      }),
      {
        cacheReadTokens: 700,
        cacheMissTokens: 1300,
        cacheProvider: "gemini",
      },
    );
    assert.deepInclude(
      extractContextCacheUsage({
        prompt_tokens: 2000,
        cached_tokens: 600,
      }),
      {
        cacheReadTokens: 600,
        cacheMissTokens: 1400,
        cacheProvider: "kimi",
      },
    );
  });

  it("records cache telemetry by stable cache key", function () {
    const plan = planContextCacheReuse({
      model: "gpt-5.4",
      apiBase: "https://api.openai.com/v1/responses",
      protocol: "responses_api",
      mode: "full",
      strategy: "paper-cache-full",
      contextText: "stable paper text ".repeat(1200),
    });
    assert.isTrue(plan.enabled);
    recordContextCacheTelemetry(plan, {
      promptTokens: 2000,
      completionTokens: 100,
      totalTokens: 2100,
      cacheReadTokens: 1600,
      cacheMissTokens: 400,
      cacheHitRatio: 0.8,
    });
    assert.deepInclude(getContextCacheTelemetry(plan.cacheKey), {
      hits: 1,
      reads: 1600,
      misses: 0,
    });
    assert.lengthOf(listContextCacheTelemetry(5), 1);
    assert.isTrue(
      shouldPreferCacheAwareFullContext({
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1/responses",
        protocol: "responses_api",
        candidateContextText: "stable paper text ".repeat(1200),
      }),
    );
  });

  it("uses Anthropic 1h cache TTL only for warm large official contexts", function () {
    const contextText = "stable paper text ".repeat(5000);
    const coldPlan = planContextCacheReuse({
      model: "claude-sonnet-4-6",
      apiBase: "https://api.anthropic.com/v1",
      protocol: "anthropic_messages",
      mode: "full",
      strategy: "agent-stable-resources",
      contextText,
    });
    assert.isTrue(coldPlan.enabled);
    assert.deepEqual(coldPlan.requestHints?.anthropicBlockCacheControl, {
      type: "ephemeral",
    });
    assert.deepEqual(coldPlan.requestHints?.anthropicToolCacheControl, {
      type: "ephemeral",
    });
    assert.deepEqual(coldPlan.requestHints?.anthropicRequestCacheControl, {
      type: "ephemeral",
    });

    recordContextCacheTelemetry(coldPlan, {
      promptTokens: 22000,
      completionTokens: 100,
      totalTokens: 22100,
      cacheReadTokens: 18000,
      cacheWriteTokens: 4000,
      cacheHitRatio: 0.82,
    });
    const warmPlan = planContextCacheReuse({
      model: "claude-sonnet-4-6",
      apiBase: "https://api.anthropic.com/v1",
      protocol: "anthropic_messages",
      mode: "full",
      strategy: "agent-stable-resources",
      contextText,
    });
    assert.deepEqual(warmPlan.requestHints?.anthropicBlockCacheControl, {
      type: "ephemeral",
      ttl: "1h",
    });
    assert.deepEqual(warmPlan.requestHints?.anthropicToolCacheControl, {
      type: "ephemeral",
      ttl: "1h",
    });
    assert.deepEqual(warmPlan.requestHints?.anthropicRequestCacheControl, {
      type: "ephemeral",
      ttl: "1h",
    });
  });

  it("keeps Anthropic 1h TTL off for write-heavy warm contexts", function () {
    const contextText = "stable paper text ".repeat(5000);
    const plan = planContextCacheReuse({
      model: "claude-sonnet-4-6",
      apiBase: "https://api.anthropic.com/v1",
      protocol: "anthropic_messages",
      mode: "full",
      strategy: "agent-stable-resources",
      contextText,
    });
    recordContextCacheTelemetry(plan, {
      promptTokens: 22000,
      completionTokens: 100,
      totalTokens: 22100,
      cacheReadTokens: 2000,
      cacheWriteTokens: 9000,
      cacheHitRatio: 0.7,
    });
    const nextPlan = planContextCacheReuse({
      model: "claude-sonnet-4-6",
      apiBase: "https://api.anthropic.com/v1",
      protocol: "anthropic_messages",
      mode: "full",
      strategy: "agent-stable-resources",
      contextText,
    });
    assert.deepEqual(nextPlan.requestHints?.anthropicBlockCacheControl, {
      type: "ephemeral",
    });
  });
});

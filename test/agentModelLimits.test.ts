import { assert } from "chai";
import { resolveAgentOutputRequestPolicy } from "../src/agent/model/limits";
import type { AgentRuntimeRequest } from "../src/agent/types";

describe("agent model limits", function () {
  function deepSeekRequest(
    overrides: Partial<AgentRuntimeRequest> = {},
  ): AgentRuntimeRequest {
    return {
      conversationKey: 1,
      mode: "agent",
      userText: "Continue the approved plan",
      model: "deepseek-v4-pro",
      apiBase: "https://api.deepseek.com/v1",
      providerProtocol: "openai_chat_compat",
      reasoning: { provider: "deepseek", level: "xhigh" },
      advanced: { outputTokenLimit: { mode: "auto" } },
      ...overrides,
    };
  }

  it("sends the registry-known cap for an Auto thinking model", function () {
    assert.deepEqual(
      resolveAgentOutputRequestPolicy(deepSeekRequest(), "openai_chat_compat"),
      { mode: "numeric", tokens: 384_000, source: "auto_capability" },
    );
  });

  it("omits the optional wire cap when no capability is known", function () {
    assert.deepEqual(
      resolveAgentOutputRequestPolicy(
        deepSeekRequest({ model: "unknown-future-model" }),
        "openai_chat_compat",
      ),
      { mode: "omit", source: "auto_provider" },
    );
  });

  it("preserves an explicit user output limit", function () {
    assert.deepEqual(
      resolveAgentOutputRequestPolicy(
        deepSeekRequest({
          advanced: {
            outputTokenLimit: { mode: "custom", tokens: 8192 },
          },
        }),
        "openai_chat_compat",
      ),
      { mode: "numeric", tokens: 8192, source: "custom" },
    );
  });

  it("keeps Auto independent of reasoning level", function () {
    assert.deepEqual(
      resolveAgentOutputRequestPolicy(
        deepSeekRequest({
          reasoning: { provider: "deepseek", level: "minimal" },
        }),
        "openai_chat_compat",
      ),
      { mode: "numeric", tokens: 384_000, source: "auto_capability" },
    );
  });

  it("uses the compatibility seed only for unknown Anthropic models", function () {
    assert.deepEqual(
      resolveAgentOutputRequestPolicy(
        deepSeekRequest({
          model: "unknown-future-model",
          apiBase: "https://api.anthropic.com/v1",
          providerProtocol: "anthropic_messages",
        }),
        "anthropic_messages",
      ),
      { mode: "numeric", tokens: 8192, source: "auto_compatibility" },
    );
  });
});

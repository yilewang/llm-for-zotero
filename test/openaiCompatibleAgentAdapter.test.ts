import { assert } from "chai";
import { OpenAICompatibleAgentAdapter } from "../src/agent/model/openaiCompatible";
import type { AgentRuntimeRequest } from "../src/agent/types";

describe("OpenAICompatibleAgentAdapter", function () {
  const adapter = new OpenAICompatibleAgentAdapter();

  function makeRequest(
    overrides: Partial<AgentRuntimeRequest> = {},
  ): AgentRuntimeRequest {
    return {
      conversationKey: 1,
      mode: "agent",
      userText: "Test tool use",
      model: "gpt-4o-mini",
      apiBase: "https://api.openai.com/v1/responses",
      apiKey: "test",
      ...overrides,
    };
  }

  it("supports tool calling for responses-style API bases", function () {
    assert.isTrue(adapter.supportsTools(makeRequest()));
    assert.isTrue(
      adapter.supportsTools(
        makeRequest({
          apiBase:
            "https://generativelanguage.googleapis.com/v1beta/openai/responses",
        }),
      ),
    );
    assert.isTrue(
      adapter.supportsTools(
        makeRequest({
          apiBase: "https://api.x.ai/v1/responses",
        }),
      ),
    );
  });

  it("keeps codex auth disabled for now", function () {
    assert.isFalse(
      adapter.supportsTools(
        makeRequest({
          apiBase: "https://chatgpt.com/backend-api/codex/responses",
          authMode: "codex_auth",
        }),
      ),
    );
  });
});

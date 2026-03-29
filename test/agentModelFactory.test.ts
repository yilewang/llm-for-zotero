import { assert } from "chai";
import { createAgentModelAdapter, resolveRequestProviderProtocol } from "../src/agent/model/factory";
import type { AgentRuntimeRequest } from "../src/agent/types";

describe("agent model factory", function () {
  function makeRequest(
    overrides: Partial<AgentRuntimeRequest> = {},
  ): AgentRuntimeRequest {
    return {
      conversationKey: 1,
      mode: "agent",
      userText: "test",
      model: "gpt-4o-mini",
      apiBase: "https://api.openai.com/v1",
      apiKey: "test",
      ...overrides,
    };
  }

  it("prefers the explicit provider protocol", function () {
    const adapter = createAgentModelAdapter(
      makeRequest({
        providerProtocol: "anthropic_messages",
        apiBase: "https://api.anthropic.com/v1",
      }),
    );
    assert.equal(adapter.constructor.name, "AnthropicMessagesAgentAdapter");
  });

  it("routes official Gemini chat-compatible configs through the native adapter", function () {
    const adapter = createAgentModelAdapter(
      makeRequest({
        providerProtocol: "openai_chat_compat",
        apiBase:
          "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      }),
    );
    assert.equal(adapter.constructor.name, "GeminiNativeAgentAdapter");
  });

  it("falls back to legacy protocol inference when protocol is missing", function () {
    assert.equal(
      resolveRequestProviderProtocol(
        makeRequest({
          authMode: "codex_auth",
          apiBase: "https://chatgpt.com/backend-api/codex/responses",
        }),
      ),
      "codex_responses",
    );
    assert.equal(
      resolveRequestProviderProtocol(
        makeRequest({
          apiBase: "https://api.openai.com/v1/responses",
        }),
      ),
      "responses_api",
    );
    assert.equal(
      resolveRequestProviderProtocol(
        makeRequest({
          apiBase: "https://api.deepseek.com/v1",
        }),
      ),
      "openai_chat_compat",
    );
  });

  it("exposes request-aware file-input capability from the provider matrix", function () {
    const responsesAdapter = createAgentModelAdapter(
      makeRequest({
        providerProtocol: "responses_api",
        apiBase: "https://api.openai.com/v1/responses",
      }),
    );
    const chatCompatAdapter = createAgentModelAdapter(
      makeRequest({
        providerProtocol: "openai_chat_compat",
        apiBase: "https://openrouter.ai/api/v1/chat/completions",
      }),
    );
    const anthropicAdapter = createAgentModelAdapter(
      makeRequest({
        providerProtocol: "anthropic_messages",
        apiBase: "https://api.anthropic.com/v1",
      }),
    );
    assert.isTrue(
      responsesAdapter.getCapabilities(
        makeRequest({
          providerProtocol: "responses_api",
          apiBase: "https://api.openai.com/v1/responses",
        }),
      ).fileInputs,
    );
    assert.isTrue(
      chatCompatAdapter.getCapabilities(
        makeRequest({
          providerProtocol: "openai_chat_compat",
          apiBase: "https://openrouter.ai/api/v1/chat/completions",
        }),
      ).fileInputs,
    );
    assert.isFalse(
      createAgentModelAdapter(
        makeRequest({
          authMode: "codex_auth",
          providerProtocol: "codex_responses",
          apiBase: "https://chatgpt.com/backend-api/codex/responses",
        }),
      ).getCapabilities(
        makeRequest({
          authMode: "codex_auth",
          providerProtocol: "codex_responses",
          apiBase: "https://chatgpt.com/backend-api/codex/responses",
        }),
      ).fileInputs,
    );
    assert.isTrue(
      anthropicAdapter.getCapabilities(
        makeRequest({
          providerProtocol: "anthropic_messages",
          apiBase: "https://api.anthropic.com/v1",
        }),
      ).fileInputs,
    );
  });
});

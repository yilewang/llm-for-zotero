import { assert } from "chai";
import {
  createAgentModelAdapter,
  resolveRequestProviderProtocol,
} from "../src/agent/model/factory";
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

  it("does not route Codex app-server requests through the legacy agent adapter", function () {
    const adapter = createAgentModelAdapter(
      makeRequest({
        authMode: "codex_app_server",
        providerProtocol: "codex_responses",
        model: "gpt-5.4",
        apiBase: "",
      }),
    );
    const request = makeRequest({ authMode: "codex_app_server" });
    const capabilities = adapter.getCapabilities(request);

    assert.equal(
      adapter.constructor.name,
      "CodexAppServerNativeOnlyAgentAdapter",
    );
    assert.isFalse(capabilities.toolCalls);
    assert.isFalse(adapter.supportsTools(request));
  });

  it("keeps legacy Codex auth on the Codex Responses adapter", function () {
    const request = makeRequest({
      authMode: "codex_auth",
      apiBase: "https://chatgpt.com/backend-api/codex/responses",
      providerProtocol: undefined,
    });
    const adapter = createAgentModelAdapter(request);

    assert.equal(adapter.constructor.name, "CodexResponsesAgentAdapter");
    assert.isTrue(adapter.getCapabilities(request).toolCalls);
    assert.isTrue(adapter.supportsTools(request));
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

  it("exposes file-input capability only on responses_api", function () {
    const responsesAdapter = createAgentModelAdapter(
      makeRequest({
        providerProtocol: "responses_api",
        apiBase: "https://api.openai.com/v1/responses",
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
    assert.isFalse(
      anthropicAdapter.getCapabilities(
        makeRequest({
          providerProtocol: "anthropic_messages",
          apiBase: "https://api.anthropic.com/v1",
        }),
      ).fileInputs,
    );
  });
});

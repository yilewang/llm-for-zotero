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

  it("exposes content-input capabilities by transport", function () {
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
    const chatCompatAdapter = createAgentModelAdapter(
      makeRequest({
        providerProtocol: "openai_chat_compat",
        apiBase: "https://api.deepseek.com/v1",
        model: "deepseek-v4-pro",
      }),
    );
    const responsesCapabilities = responsesAdapter.getCapabilities(
      makeRequest({
        providerProtocol: "responses_api",
        apiBase: "https://api.openai.com/v1/responses",
      }),
    );
    const anthropicCapabilities = anthropicAdapter.getCapabilities(
      makeRequest({
        providerProtocol: "anthropic_messages",
        apiBase: "https://api.anthropic.com/v1",
      }),
    );
    const chatCompatCapabilities = chatCompatAdapter.getCapabilities(
      makeRequest({
        providerProtocol: "openai_chat_compat",
        apiBase: "https://api.deepseek.com/v1",
        model: "deepseek-v4-pro",
      }),
    );

    assert.deepEqual(responsesCapabilities.contentInputs, {
      images: true,
      pdfDocuments: true,
      nativeFiles: true,
    });
    assert.isTrue(responsesCapabilities.fileInputs);
    assert.deepEqual(anthropicCapabilities.contentInputs, {
      images: true,
      pdfDocuments: true,
      nativeFiles: false,
    });
    assert.isFalse(anthropicCapabilities.fileInputs);
    assert.deepEqual(chatCompatCapabilities.contentInputs, {
      images: false,
      pdfDocuments: false,
      nativeFiles: false,
    });
    assert.isFalse(chatCompatCapabilities.fileInputs);
  });

  it("keeps Gemini PDF document inputs tied to provider capabilities", function () {
    const firstPartyRequest = makeRequest({
      providerProtocol: "gemini_native",
      apiBase: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-pro",
    });
    const thirdPartyRequest = makeRequest({
      providerProtocol: "gemini_native",
      apiBase: "https://third-party.example/gemini",
      model: "gemini-compatible",
    });
    const firstPartyAdapter = createAgentModelAdapter(firstPartyRequest);
    const thirdPartyAdapter = createAgentModelAdapter(thirdPartyRequest);

    assert.equal(firstPartyAdapter.constructor.name, "GeminiNativeAgentAdapter");
    assert.equal(thirdPartyAdapter.constructor.name, "GeminiNativeAgentAdapter");
    assert.deepEqual(
      firstPartyAdapter.getCapabilities(firstPartyRequest).contentInputs,
      {
        images: true,
        pdfDocuments: true,
        nativeFiles: false,
      },
    );
    assert.isFalse(
      firstPartyAdapter.getCapabilities(firstPartyRequest).fileInputs,
    );
    assert.deepEqual(
      thirdPartyAdapter.getCapabilities(thirdPartyRequest).contentInputs,
      {
        images: true,
        pdfDocuments: false,
        nativeFiles: false,
      },
    );
    assert.isFalse(
      thirdPartyAdapter.getCapabilities(thirdPartyRequest).fileInputs,
    );
  });

  it("keeps file-input capability limited to native file transports", function () {
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

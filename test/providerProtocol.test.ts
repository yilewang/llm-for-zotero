import { assert } from "chai";
import {
  describeAgentCapabilityClass,
  getAgentCapabilityClass,
  normalizeProviderProtocolForAuthMode,
} from "../src/utils/providerProtocol";

describe("providerProtocol", function () {
  it("forces codex auth onto codex_responses", function () {
    assert.equal(
      normalizeProviderProtocolForAuthMode({
        protocol: "gemini_native",
        authMode: "codex_auth",
        apiBase: "https://chatgpt.com/backend-api/codex/responses",
      }),
      "codex_responses",
    );
  });

  it("infers legacy responses endpoints without upgrading non-responses URLs", function () {
    assert.equal(
      normalizeProviderProtocolForAuthMode({
        authMode: "api_key",
        apiBase: "https://api.openai.com/v1/responses",
      }),
      "responses_api",
    );
    assert.equal(
      normalizeProviderProtocolForAuthMode({
        authMode: "api_key",
        apiBase: "https://proxy.example.com/responses",
      }),
      "responses_api",
    );
    assert.equal(
      normalizeProviderProtocolForAuthMode({
        authMode: "api_key",
        apiBase: "https://proxy.example.com/v1/response",
      }),
      "openai_chat_compat",
    );
    assert.equal(
      normalizeProviderProtocolForAuthMode({
        authMode: "api_key",
        apiBase: "https://proxy.example.com/response",
      }),
      "openai_chat_compat",
    );
    assert.equal(
      normalizeProviderProtocolForAuthMode({
        authMode: "api_key",
        apiBase: "https://proxy.example.com/response_api",
      }),
      "openai_chat_compat",
    );
    assert.equal(
      normalizeProviderProtocolForAuthMode({
        authMode: "api_key",
        apiBase: "https://proxy.example.com/my-response-service",
      }),
      "openai_chat_compat",
    );
    assert.equal(
      normalizeProviderProtocolForAuthMode({
        authMode: "api_key",
        apiBase: "https://api.openai.com/v1",
      }),
      "openai_chat_compat",
    );
  });

  it("infers Anthropic Messages from canonical message endpoint paths", function () {
    for (const apiBase of [
      "https://proxy.example.com/anthropic",
      "https://proxy.example.com/anthropic/v1",
      "https://proxy.example.com/anthropic/v1/messages",
      "https://proxy.example.com/v1/messages",
      "https://proxy.example.com/messages",
    ]) {
      assert.equal(
        normalizeProviderProtocolForAuthMode({
          authMode: "api_key",
          apiBase,
        }),
        "anthropic_messages",
        apiBase,
      );
    }
  });

  it("keeps explicit protocol overrides over URL inference", function () {
    assert.equal(
      normalizeProviderProtocolForAuthMode({
        protocol: "openai_chat_compat",
        authMode: "api_key",
        apiBase: "https://proxy.example.com/anthropic",
      }),
      "openai_chat_compat",
    );
  });

  it("formats agent capability labels", function () {
    assert.equal(
      describeAgentCapabilityClass(
        getAgentCapabilityClass({ toolCalls: true, fileInputs: true }),
      ),
      "full agent",
    );
    assert.equal(
      describeAgentCapabilityClass(
        getAgentCapabilityClass({ toolCalls: true, fileInputs: false }),
      ),
      "agent without file upload",
    );
    assert.equal(
      describeAgentCapabilityClass(
        getAgentCapabilityClass({ toolCalls: false, fileInputs: false }),
      ),
      "chat-only",
    );
  });
});

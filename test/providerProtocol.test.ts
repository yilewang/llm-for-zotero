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
        apiBase: "https://api.openai.com/v1",
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

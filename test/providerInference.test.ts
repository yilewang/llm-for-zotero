import { assert } from "chai";
import {
  getModelCapabilities,
  resetModelCapabilityStateForTests,
} from "../src/modelCapabilities";
import { detectReasoningProvider } from "../src/modules/contextPanel/chat";

describe("provider inference from model names", function () {
  afterEach(function () {
    resetModelCapabilityStateForTests();
  });

  it("resolves Kimi-for-Coding bare ids on an unrecognized host", function () {
    for (const model of ["k3", "k3-256k", "kimi-for-coding"]) {
      const capabilities = getModelCapabilities({
        model,
        apiBase: "https://api.kimi.com/coding/v1",
        protocol: "openai_chat_compat",
      });
      assert.equal(capabilities.provider, "kimi", model);
      assert.equal(capabilities.reasoning.kind, "select", model);
    }
  });

  it("falls back to model-name inference on relay hosts", function () {
    const relay = "https://relay.example.com/v1";
    assert.equal(
      getModelCapabilities({ model: "kimi-k3", apiBase: relay }).provider,
      "kimi",
    );
    assert.equal(
      getModelCapabilities({ model: "gemini-3.6-flash", apiBase: relay })
        .provider,
      "gemini",
    );
    assert.equal(
      getModelCapabilities({ model: "claude-opus-5", apiBase: relay }).provider,
      "anthropic",
    );
    assert.equal(
      getModelCapabilities({ model: "deepseek-v4-flash", apiBase: relay })
        .provider,
      "deepseek",
    );
  });

  it("keeps explicit provider identities authoritative", function () {
    assert.equal(
      getModelCapabilities({
        provider: "qwen",
        model: "kimi-k3",
        apiBase: "https://relay.example.com/v1",
      }).provider,
      "qwen",
    );
  });

  it("detects the kimi reasoning provider for coding-endpoint model names", function () {
    assert.equal(detectReasoningProvider("k3"), "kimi");
    assert.equal(detectReasoningProvider("k3-256k"), "kimi");
    assert.equal(detectReasoningProvider("kimi-for-coding"), "kimi");
    assert.equal(detectReasoningProvider("kimi-for-coding-highspeed"), "kimi");
  });

  it("does not mistake unrelated ids for the k3 alias", function () {
    assert.equal(detectReasoningProvider("k30"), "unsupported");
    assert.equal(detectReasoningProvider("k3x"), "unsupported");
    assert.equal(detectReasoningProvider("mock3"), "unsupported");
  });
});

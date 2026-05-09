import { assert } from "chai";
import {
  detectProviderPreset,
  getProviderPreset,
  providerSupportsResponsesEndpoint,
} from "../src/utils/providerPresets";

describe("providerPresets", function () {
  it("detects official provider presets from saved URLs", function () {
    assert.equal(
      detectProviderPreset("https://api.openai.com/v1/responses"),
      "openai",
    );
    assert.equal(
      detectProviderPreset(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      ),
      "gemini",
    );
    assert.equal(
      detectProviderPreset("https://api.anthropic.com/v1/chat/completions"),
      "anthropic",
    );
    assert.equal(
      detectProviderPreset("https://api.minimax.io/anthropic/v1/messages"),
      "minimax",
    );
    assert.equal(
      detectProviderPreset(
        "https://open.bigmodel.cn/api/anthropic/v1/messages",
      ),
      "glm",
    );
    assert.equal(
      detectProviderPreset("https://api.deepseek.com/v1/chat/completions"),
      "deepseek",
    );
    assert.equal(
      detectProviderPreset("https://api.deepseek.com/v1"),
      "deepseek",
    );
    assert.equal(detectProviderPreset("https://api.x.ai/v1/responses"), "grok");
    assert.equal(
      detectProviderPreset(
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
      ),
      "qwen",
    );
    assert.equal(
      detectProviderPreset("https://api.moonshot.ai/v1/chat/completions"),
      "kimi",
    );
  });

  it("falls back to customized for unknown URLs", function () {
    assert.equal(
      detectProviderPreset(
        "https://custom.provider.example/v1/chat/completions",
      ),
      "customized",
    );
  });

  it("exposes the official default endpoint for each preset", function () {
    assert.equal(
      getProviderPreset("openai").defaultApiBase,
      "https://api.openai.com/v1/responses",
    );
    assert.equal(
      getProviderPreset("gemini").defaultApiBase,
      "https://generativelanguage.googleapis.com/v1beta",
    );
    assert.equal(
      getProviderPreset("grok").defaultApiBase,
      "https://api.x.ai/v1/responses",
    );
    assert.equal(
      getProviderPreset("minimax").defaultApiBase,
      "https://api.minimax.io/anthropic",
    );
    assert.equal(
      getProviderPreset("glm").defaultApiBase,
      "https://open.bigmodel.cn/api/anthropic",
    );
    assert.equal(
      getProviderPreset("kimi").defaultApiBase,
      "https://api.moonshot.cn/v1",
    );
  });

  it("stores default protocols per preset", function () {
    assert.equal(getProviderPreset("openai").defaultProtocol, "responses_api");
    assert.equal(getProviderPreset("gemini").defaultProtocol, "gemini_native");
    assert.equal(
      getProviderPreset("anthropic").defaultProtocol,
      "anthropic_messages",
    );
    assert.deepEqual(getProviderPreset("minimax").supportedProtocols, [
      "anthropic_messages",
      "openai_chat_compat",
    ]);
    assert.deepEqual(getProviderPreset("glm").supportedProtocols, [
      "anthropic_messages",
      "openai_chat_compat",
    ]);
    assert.deepEqual(getProviderPreset("deepseek").supportedProtocols, [
      "openai_chat_compat",
    ]);
  });

  it("does not advertise Gemini as Responses-capable", function () {
    assert.isFalse(
      providerSupportsResponsesEndpoint(
        "https://generativelanguage.googleapis.com/v1beta/openai",
      ),
    );
    assert.isFalse(
      providerSupportsResponsesEndpoint(
        "https://generativelanguage.googleapis.com/v1beta/openai/responses",
      ),
    );
  });
});

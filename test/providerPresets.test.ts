import { assert } from "chai";
import {
  detectProviderPreset,
  getProviderPreset,
  getProviderPresetProtocolOptions,
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
    assert.equal(
      detectProviderPreset("https://api.deepseek.com/anthropic/v1/messages"),
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
      detectProviderPreset(
        "https://dashscope-us.aliyuncs.com/compatible-mode/v1/responses",
      ),
      "qwen",
    );
    assert.equal(
      detectProviderPreset(
        "https://dashscope-intl.aliyuncs.com/api/v2/apps/protocols/compatible-mode/v1/responses",
      ),
      "qwen",
    );
    assert.equal(
      detectProviderPreset("https://api.moonshot.ai/v1/chat/completions"),
      "kimi",
    );
    assert.equal(
      detectProviderPreset("https://api.xiaomimimo.com/v1/chat/completions"),
      "mimo",
    );
    assert.equal(detectProviderPreset("https://api.xiaomimimo.com/v1"), "mimo");
    assert.equal(detectProviderPreset("http://localhost:4000/v1"), "litellm");
    assert.equal(
      detectProviderPreset("http://127.0.0.1:4000/v1/chat/completions"),
      "litellm",
    );
    assert.equal(
      detectProviderPreset("https://litellm.example.com/v1"),
      "litellm",
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
      getProviderPreset("deepseek").defaultApiBase,
      "https://api.deepseek.com/anthropic",
    );
    assert.equal(
      getProviderPreset("kimi").defaultApiBase,
      "https://api.moonshot.ai/v1",
    );
    assert.equal(
      getProviderPreset("mimo").defaultApiBase,
      "https://api.xiaomimimo.com/v1",
    );
    assert.equal(
      getProviderPreset("litellm").defaultApiBase,
      "http://localhost:4000/v1",
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
    assert.equal(
      getProviderPreset("deepseek").defaultProtocol,
      "anthropic_messages",
    );
    assert.deepEqual(getProviderPreset("deepseek").supportedProtocols, [
      "anthropic_messages",
      "openai_chat_compat",
    ]);
    assert.deepEqual(getProviderPreset("gemini").supportedProtocols, [
      "gemini_native",
      "openai_chat_compat",
    ]);
    assert.deepEqual(getProviderPreset("qwen").supportedProtocols, [
      "openai_chat_compat",
      "responses_api",
    ]);
    assert.deepEqual(getProviderPreset("kimi").supportedProtocols, [
      "openai_chat_compat",
    ]);
    assert.equal(
      getProviderPreset("mimo").defaultProtocol,
      "openai_chat_compat",
    );
    assert.deepEqual(getProviderPreset("mimo").supportedProtocols, [
      "openai_chat_compat",
    ]);
    assert.equal(
      getProviderPreset("litellm").defaultProtocol,
      "openai_chat_compat",
    );
    assert.deepEqual(getProviderPreset("litellm").supportedProtocols, [
      "openai_chat_compat",
      "responses_api",
    ]);
  });

  it("offers advanced protocol options beyond preset defaults", function () {
    assert.deepEqual(getProviderPresetProtocolOptions("kimi"), [
      "openai_chat_compat",
      "responses_api",
      "anthropic_messages",
    ]);
    assert.deepEqual(getProviderPresetProtocolOptions("mimo"), [
      "openai_chat_compat",
      "responses_api",
      "anthropic_messages",
    ]);
    assert.deepEqual(getProviderPresetProtocolOptions("gemini"), [
      "gemini_native",
      "openai_chat_compat",
      "responses_api",
      "anthropic_messages",
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

  it("advertises Qwen as Responses-capable", function () {
    assert.isTrue(
      providerSupportsResponsesEndpoint(
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      ),
    );
  });

  it("does not advertise MiMo as Responses-capable", function () {
    assert.isFalse(
      providerSupportsResponsesEndpoint("https://api.xiaomimimo.com/v1"),
    );
  });
});

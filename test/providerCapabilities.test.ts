import { assert } from "chai";
import {
  isTextOnlyModel,
  resolveProviderCapabilities,
} from "../src/providers";

describe("provider capabilities", function () {
  it("routes first-party PDF providers to native support", function () {
    for (const entry of [
      {
        apiBase: "https://api.openai.com/v1/responses",
        protocol: "responses_api",
      },
      {
        apiBase: "https://api.anthropic.com/v1",
        protocol: "anthropic_messages",
      },
      {
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        protocol: "gemini_native",
      },
      {
        apiBase: "https://api.x.ai/v1/responses",
        protocol: "responses_api",
      },
    ]) {
      assert.deepInclude(
        resolveProviderCapabilities({
          model: "gpt-4o",
          apiBase: entry.apiBase,
          protocol: entry.protocol,
        }),
        {
          pdf: "native",
          images: true,
          multimodal: true,
        },
      );
    }
  });

  it("blocks full-PDF mode for provider-upload endpoints", function () {
    for (const apiBase of [
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "https://api.moonshot.cn/v1",
    ]) {
      assert.deepInclude(
        resolveProviderCapabilities({
          model: "qwen-long",
          apiBase,
          protocol: "openai_chat_compat",
        }),
        {
          pdf: "none",
          images: true,
          multimodal: true,
        },
      );
    }
  });

  it("blocks full-PDF mode for third-party compatible protocols", function () {
    for (const entry of [
      {
        apiBase: "https://openrouter.ai/api/v1",
        protocol: "openai_chat_compat",
      },
      {
        apiBase: "https://api.minimax.io/anthropic",
        protocol: "anthropic_messages",
      },
      {
        apiBase: "https://third-party.example/gemini",
        protocol: "gemini_native",
      },
    ]) {
      assert.deepInclude(
        resolveProviderCapabilities({
          model: "gpt-4o",
          apiBase: entry.apiBase,
          protocol: entry.protocol,
        }),
        {
          pdf: "none",
          images: true,
          multimodal: true,
        },
      );
    }
  });

  it("blocks full-PDF mode for Codex and ChatGPT auth transports", function () {
    for (const entry of [
      {
        authMode: "codex_app_server",
        protocol: "codex_responses",
      },
      {
        authMode: "codex_auth",
        protocol: "codex_responses",
      },
    ]) {
      assert.deepInclude(
        resolveProviderCapabilities({
          model: "gpt-5.4",
          authMode: entry.authMode,
          protocol: entry.protocol,
        }),
        {
          pdf: "none",
          images: true,
          multimodal: true,
        },
      );
    }
  });

  it("treats DeepSeek V4 models as text-only", function () {
    for (const model of [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek/deepseek-v4-pro",
    ]) {
      assert.isTrue(isTextOnlyModel(model), model);
      assert.deepInclude(
        resolveProviderCapabilities({
          model,
          apiBase: "https://api.deepseek.com/v1",
          protocol: "openai_chat_compat",
        }),
        {
          pdf: "none",
          images: false,
          multimodal: false,
        },
      );
    }
  });
});

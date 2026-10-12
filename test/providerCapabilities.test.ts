import { assert } from "chai";
import { isTextOnlyModel, resolveProviderCapabilities } from "../src/providers";
import {
  getModelCapabilities,
  publishModelCapabilityCatalog,
  resetModelCapabilityStateForTests,
  setModelCapabilityRegistryForTests,
} from "../src/modelCapabilities";
import { isScreenshotUnsupportedModel } from "../src/modules/contextPanel/setupHandlers/controllers/modelReasoningController";

describe("provider capabilities", function () {
  afterEach(function () {
    resetModelCapabilityStateForTests();
  });

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

  it("reports prompt-cache capabilities for documented providers", function () {
    assert.deepInclude(
      resolveProviderCapabilities({
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1/responses",
        protocol: "responses_api",
      }).promptCache,
      {
        kind: "automatic_prefix",
        provider: "openai",
      },
    );
    assert.deepInclude(
      resolveProviderCapabilities({
        model: "claude-sonnet-4-6",
        apiBase: "https://api.anthropic.com/v1",
        protocol: "anthropic_messages",
      }).promptCache,
      {
        kind: "explicit_blocks",
        provider: "anthropic",
      },
    );
    assert.deepInclude(
      resolveProviderCapabilities({
        model: "deepseek-chat",
        apiBase: "https://api.deepseek.com/v1",
        protocol: "openai_chat_compat",
      }).promptCache,
      {
        kind: "automatic_prefix",
        provider: "deepseek",
      },
    );
    assert.deepInclude(
      resolveProviderCapabilities({
        model: "gpt-5.4",
        authMode: "codex_app_server",
        protocol: "codex_responses",
      }).promptCache,
      {
        kind: "opaque",
        provider: "codex",
      },
    );
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
        apiBase: "https://api.xiaomimimo.com/v1",
        protocol: "openai_chat_compat",
      },
      {
        apiBase: "https://api.atlascloud.ai/v1",
        protocol: "openai_chat_compat",
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

  it("allows DeepSeek image input by default across model names and endpoints", function () {
    for (const model of [
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash-0731",
      "deepseek/deepseek-v4-pro",
      "deepseek-flash",
      "deepseek-v4.1-flash",
      "deepseek-new-model",
      "deepseek-v4-flash-vision-exp",
      "deepseek-vl2",
    ]) {
      assert.isFalse(isTextOnlyModel(model), model);
      for (const apiBase of [
        "https://api.deepseek.com/v1",
        "https://api.deepseek.com/anthropic",
        "https://openrouter.ai/api/v1",
        "http://localhost:11434/v1",
        undefined,
      ]) {
        assert.deepInclude(
          resolveProviderCapabilities({
            model,
            apiBase,
            protocol: "openai_chat_compat",
          }),
          { pdf: "none", images: true, multimodal: true },
          `${model} at ${apiBase}`,
        );
        assert.deepInclude(
          resolveProviderCapabilities({
            model,
            apiBase,
            protocol: "openai_chat_compat",
            inputMode: "text_only",
          }),
          { pdf: "none", images: false, multimodal: false },
          `Explicit text-only: ${model} at ${apiBase}`,
        );
      }
    }
  });

  it("forces text-only input mode through the resolved capability contract", function () {
    assert.deepInclude(
      resolveProviderCapabilities({
        model: "gpt-5.5",
        apiBase: "https://api.openai.com/v1/responses",
        protocol: "responses_api",
        inputMode: "text_only",
      }),
      {
        pdf: "none",
        images: false,
        multimodal: false,
      },
    );
  });

  it("uses model image metadata consistently in Auto mode and respects manual choices", function () {
    const identity = {
      model: "deepseek-new-model",
      apiBase: "https://api.deepseek.com/anthropic",
      protocol: "anthropic_messages",
      authMode: "api_key",
    };
    const assertImageSupport = (expected: boolean) => {
      assert.equal(getModelCapabilities(identity).inputs.image, expected);
      assert.equal(resolveProviderCapabilities(identity).images, expected);
      assert.equal(
        isScreenshotUnsupportedModel(
          identity.model,
          identity.protocol,
          identity.authMode,
          identity.apiBase,
        ),
        !expected,
      );
    };

    assertImageSupport(true);
    assert.isTrue(
      setModelCapabilityRegistryForTests({
        schemaVersion: 1,
        revision: 100,
        models: [
          { match: { exact: identity.model }, inputs: { image: false } },
        ],
      }),
    );
    assertImageSupport(false);

    // A catalog row without image metadata must not erase a declared value.
    publishModelCapabilityCatalog(identity, [
      { id: identity.model, source: "live" },
    ]);
    assertImageSupport(false);
    publishModelCapabilityCatalog(identity, [
      {
        id: identity.model,
        source: "live",
        inputs: { image: true },
      },
    ]);
    assertImageSupport(true);
    assert.isFalse(
      resolveProviderCapabilities({ ...identity, inputMode: "text_only" })
        .images,
    );

    publishModelCapabilityCatalog(identity, [
      {
        id: identity.model,
        source: "live",
        inputs: { image: false },
      },
    ]);
    assertImageSupport(false);
    assert.isTrue(
      resolveProviderCapabilities({ ...identity, inputMode: "vision_allowed" })
        .images,
    );
  });

  it("allows vision input without forcing PDF support", function () {
    assert.deepInclude(
      resolveProviderCapabilities({
        model: "deepseek-v4-pro",
        apiBase: "https://openrouter.ai/api/v1",
        protocol: "openai_chat_compat",
        inputMode: "vision_allowed",
      }),
      {
        pdf: "none",
        images: true,
        multimodal: true,
      },
    );
  });

  it("lets explicit image metadata override a legacy name-based default", function () {
    const identity = {
      model: "local-reasoner",
      apiBase: "http://localhost:1234/v1",
      protocol: "openai_chat_compat",
    };
    assert.isFalse(resolveProviderCapabilities(identity).images);
    publishModelCapabilityCatalog(identity, [
      {
        id: identity.model,
        source: "live",
        inputs: { image: true },
      },
    ]);
    assert.isTrue(resolveProviderCapabilities(identity).images);
  });

  it("treats missing and invalid input modes as automatic detection", function () {
    assert.deepInclude(
      resolveProviderCapabilities({
        model: "deepseek-v4-pro",
        apiBase: "https://api.deepseek.com/v1",
        protocol: "openai_chat_compat",
      }),
      {
        pdf: "none",
        images: true,
        multimodal: true,
      },
    );
    assert.deepInclude(
      resolveProviderCapabilities({
        model: "deepseek-v4-pro",
        apiBase: "https://api.deepseek.com/v1",
        protocol: "openai_chat_compat",
        inputMode: "invalid",
      }),
      {
        pdf: "none",
        images: true,
        multimodal: true,
      },
    );
  });

  it("keeps explicit text-only and embedding model names blocked", function () {
    for (const model of [
      "local-text-only",
      "local-reasoner",
      "deepseek-embedding",
      "deepseek-vl2-text-only",
    ]) {
      assert.isTrue(isTextOnlyModel(model), model);
    }
  });
});

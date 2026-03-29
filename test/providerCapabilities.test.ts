import { assert } from "chai";
import { resolveProviderCapabilities } from "../src/providers";

describe("provider capabilities", function () {
  it("resolves the canonical PDF matrix by provider family and protocol", function () {
    const nativeOpenAIResponses = resolveProviderCapabilities({
      model: "gpt-5.4",
      protocol: "responses_api",
      apiBase: "https://api.openai.com/v1/responses",
      authMode: "api_key",
    });
    assert.equal(nativeOpenAIResponses.providerFamily, "native_openai");
    assert.equal(nativeOpenAIResponses.pdf, "file_upload");
    assert.isTrue(nativeOpenAIResponses.fileInputs);

    const nativeOpenAIChat = resolveProviderCapabilities({
      model: "gpt-5.4",
      protocol: "openai_chat_compat",
      apiBase: "https://api.openai.com/v1/chat/completions",
      authMode: "api_key",
    });
    assert.equal(nativeOpenAIChat.providerFamily, "native_openai");
    assert.equal(nativeOpenAIChat.pdf, "inline_base64_pdf");

    const nativeGemini = resolveProviderCapabilities({
      model: "gemini-2.5-pro",
      protocol: "gemini_native",
      apiBase: "https://generativelanguage.googleapis.com",
      authMode: "api_key",
    });
    assert.equal(nativeGemini.providerFamily, "native_gemini");
    assert.equal(nativeGemini.pdf, "native_inline_pdf");

    const nativeAnthropic = resolveProviderCapabilities({
      model: "claude-sonnet-4",
      protocol: "anthropic_messages",
      apiBase: "https://api.anthropic.com/v1",
      authMode: "api_key",
    });
    assert.equal(nativeAnthropic.providerFamily, "native_anthropic");
    assert.equal(nativeAnthropic.pdf, "native_inline_pdf");

    const kimiQwen = resolveProviderCapabilities({
      model: "kimi-k2.5",
      protocol: "openai_chat_compat",
      apiBase: "https://api.moonshot.ai/v1",
      authMode: "api_key",
    });
    assert.equal(kimiQwen.providerFamily, "kimi_qwen");
    assert.equal(kimiQwen.pdf, "provider_upload");

    const thirdPartyResponses = resolveProviderCapabilities({
      model: "gpt-5.4",
      protocol: "responses_api",
      apiBase: "https://openrouter.ai/api/v1/responses",
      authMode: "api_key",
    });
    assert.equal(thirdPartyResponses.providerFamily, "third_party");
    assert.equal(thirdPartyResponses.pdf, "inline_base64_pdf");

    const thirdPartyChat = resolveProviderCapabilities({
      model: "gpt-5.4",
      protocol: "openai_chat_compat",
      apiBase: "https://openrouter.ai/api/v1/chat/completions",
      authMode: "api_key",
    });
    assert.equal(thirdPartyChat.providerFamily, "third_party");
    assert.equal(thirdPartyChat.pdf, "inline_base64_pdf");

    const codex = resolveProviderCapabilities({
      model: "gpt-5-codex",
      protocol: "codex_responses",
      apiBase: "https://chatgpt.com/backend-api/codex/responses",
      authMode: "codex_auth",
    });
    assert.equal(codex.providerFamily, "codex");
    assert.equal(codex.pdf, "vision_pages");
    assert.isFalse(codex.fileInputs);

    const copilot = resolveProviderCapabilities({
      model: "gpt-4o",
      protocol: "openai_chat_compat",
      apiBase: "https://api.githubcopilot.com",
      authMode: "copilot_auth",
    });
    assert.equal(copilot.providerFamily, "copilot");
    assert.equal(copilot.pdf, "none");
    assert.isFalse(copilot.fileInputs);
  });
});

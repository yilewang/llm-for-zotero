import { assert } from "chai";
import {
  detectProviderPreset,
  getProviderPreset,
} from "../src/utils/providerPresets";

describe("OpenCode Zen preset", function () {
  it("claims the Zen routes in both URL generations", function () {
    for (const apiBase of [
      "https://opencode.ai/zen/v1",
      "https://opencode.ai/zen/v1/chat/completions",
      "https://opencode.ai/zen/v1/messages",
      "https://opencode.ai/inference/v1",
      "https://opencode.ai/inference/openai/v1/chat/completions",
      "https://opencode.ai/inference/anthropic/v1/messages",
    ]) {
      assert.equal(detectProviderPreset(apiBase), "opencode", apiBase);
    }
  });

  it("leaves the Go routes to the Go preset", function () {
    for (const apiBase of [
      "https://opencode.ai/zen/go/v1",
      "https://opencode.ai/zen/go/v1/chat/completions",
      "https://opencode.ai/inference/go/v1",
      "https://opencode.ai/inference/go/openai/v1/responses",
      "https://opencode.ai/inference/go/anthropic/v1/messages",
    ]) {
      assert.equal(detectProviderPreset(apiBase), "opencode_go", apiBase);
    }
  });

  it("leaves the rest of opencode.ai alone", function () {
    // The docs and the agent's own server live on the same host; only the Zen
    // gateway paths are a model endpoint.
    for (const apiBase of [
      "https://opencode.ai",
      "https://opencode.ai/docs/zen",
      "https://opencode.ai/docs/go",
      "https://opencode.ai/inference/google/v1beta/models/x",
    ]) {
      assert.notEqual(detectProviderPreset(apiBase), "opencode", apiBase);
      assert.notEqual(detectProviderPreset(apiBase), "opencode_go", apiBase);
    }
  });

  it("defaults to the OpenAI-compatible protocol it publishes", function () {
    const preset = getProviderPreset("opencode");
    assert.equal(preset?.defaultApiBase, "https://opencode.ai/zen/v1");
    assert.equal(preset?.defaultProtocol, "openai_chat_compat");
    assert.includeMembers(preset?.supportedProtocols || [], [
      "openai_chat_compat",
      "anthropic_messages",
      "responses_api",
    ]);
  });

  it("defaults the Go preset to its own base and the same protocols", function () {
    const preset = getProviderPreset("opencode_go");
    assert.equal(preset?.defaultApiBase, "https://opencode.ai/zen/go/v1");
    assert.equal(preset?.defaultProtocol, "openai_chat_compat");
    assert.includeMembers(preset?.supportedProtocols || [], [
      "openai_chat_compat",
      "anthropic_messages",
      "responses_api",
    ]);
  });
});

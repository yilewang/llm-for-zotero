import { assert } from "chai";
import {
  API_ENDPOINT,
  RESPONSES_ENDPOINT,
  EMBEDDINGS_ENDPOINT,
  FILES_ENDPOINT,
  resolveEndpoint,
  buildHeaders,
  usesMaxCompletionTokens,
  isResponsesBase,
} from "../src/utils/apiHelpers";

describe("apiHelpers", function () {
  describe("resolveEndpoint", function () {
    it("should keep a chat completions URL when requesting chat endpoint", function () {
      const url = resolveEndpoint("https://api.openai.com/v1/chat/completions", API_ENDPOINT);
      assert.equal(url, "https://api.openai.com/v1/chat/completions");
    });

    it("should switch between chat, responses, embeddings, and files suffixes", function () {
      const base = "https://api.openai.com/v1/chat/completions";
      assert.equal(
        resolveEndpoint(base, RESPONSES_ENDPOINT),
        "https://api.openai.com/v1/responses",
      );
      assert.equal(
        resolveEndpoint(base, EMBEDDINGS_ENDPOINT),
        "https://api.openai.com/v1/embeddings",
      );
      assert.equal(
        resolveEndpoint(base, FILES_ENDPOINT),
        "https://api.openai.com/v1/files",
      );
    });

    it("should avoid duplicating /v1 when base already has a version segment", function () {
      const url = resolveEndpoint(
        "https://generativelanguage.googleapis.com/v1beta/openai",
        API_ENDPOINT,
      );
      assert.equal(
        url,
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      );
    });

    it("should append default path for plain base URLs", function () {
      const url = resolveEndpoint("https://api.openai.com", API_ENDPOINT);
      assert.equal(url, "https://api.openai.com/v1/chat/completions");
    });
  });

  describe("buildHeaders", function () {
    it("should always include content type", function () {
      const headers = buildHeaders("");
      assert.deepEqual(headers, { "Content-Type": "application/json" });
    });

    it("should include Authorization when api key is set", function () {
      const headers = buildHeaders("sk-test");
      assert.equal(headers.Authorization, "Bearer sk-test");
      assert.equal(headers["Content-Type"], "application/json");
    });
  });

  describe("usesMaxCompletionTokens", function () {
    it("should use max_completion_tokens for gpt-5/o-series/reasoning models", function () {
      assert.isTrue(usesMaxCompletionTokens("gpt-5.2"));
      assert.isTrue(usesMaxCompletionTokens("o3-mini"));
      assert.isTrue(usesMaxCompletionTokens("my-reasoning-model"));
    });

    it("should use max_tokens for regular chat models", function () {
      assert.isFalse(usesMaxCompletionTokens("gpt-4o-mini"));
      assert.isFalse(usesMaxCompletionTokens("gemini-2.5-flash"));
    });
  });

  describe("isResponsesBase", function () {
    it("should detect responses endpoint bases", function () {
      assert.isTrue(isResponsesBase("https://api.openai.com/v1/responses"));
      assert.isTrue(
        isResponsesBase(
          "https://generativelanguage.googleapis.com/v1beta/openai/responses",
        ),
      );
    });

    it("should not treat chat endpoint as responses base", function () {
      assert.isFalse(
        isResponsesBase("https://api.openai.com/v1/chat/completions"),
      );
    });
  });
});

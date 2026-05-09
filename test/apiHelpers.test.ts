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
  isGeminiBase,
  normalizeGeminiApiBase,
} from "../src/utils/apiHelpers";

describe("apiHelpers", function () {
  describe("resolveEndpoint", function () {
    it("should keep a chat completions URL when requesting chat endpoint", function () {
      const url = resolveEndpoint(
        "https://api.openai.com/v1/chat/completions",
        API_ENDPOINT,
      );
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

    it("should expand bare Gemini domain to /v1beta/openai/chat/completions (404 fix)", function () {
      assert.equal(
        resolveEndpoint(
          "https://generativelanguage.googleapis.com",
          API_ENDPOINT,
        ),
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      );
    });

    it("should expand bare Gemini /v1beta base to /v1beta/openai/chat/completions", function () {
      assert.equal(
        resolveEndpoint(
          "https://generativelanguage.googleapis.com/v1beta",
          API_ENDPOINT,
        ),
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      );
    });

    it("should expand bare Gemini base to proper responses endpoint for PDF uploads", function () {
      assert.equal(
        resolveEndpoint(
          "https://generativelanguage.googleapis.com",
          RESPONSES_ENDPOINT,
        ),
        "https://generativelanguage.googleapis.com/v1beta/openai/responses",
      );
    });

    it("should resolve files endpoint from bare Gemini domain", function () {
      assert.equal(
        resolveEndpoint(
          "https://generativelanguage.googleapis.com",
          FILES_ENDPOINT,
        ),
        "https://generativelanguage.googleapis.com/v1beta/openai/files",
      );
    });

    it("should switch suffixes correctly from a Gemini responses base", function () {
      const base =
        "https://generativelanguage.googleapis.com/v1beta/openai/responses";
      assert.equal(
        resolveEndpoint(base, API_ENDPOINT),
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      );
      assert.equal(
        resolveEndpoint(base, FILES_ENDPOINT),
        "https://generativelanguage.googleapis.com/v1beta/openai/files",
      );
    });

    it("should append default path for plain base URLs", function () {
      const url = resolveEndpoint("https://api.openai.com", API_ENDPOINT);
      assert.equal(url, "https://api.openai.com/v1/chat/completions");
    });

    it("should keep Codex backend responses endpoint unchanged", function () {
      const base = "https://chatgpt.com/backend-api/codex/responses";
      assert.equal(resolveEndpoint(base, RESPONSES_ENDPOINT), base);
      assert.equal(resolveEndpoint(base, API_ENDPOINT), base);
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
      assert.isTrue(usesMaxCompletionTokens("gpt-5.4"));
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

  describe("isGeminiBase", function () {
    it("should detect generativelanguage.googleapis.com URLs", function () {
      assert.isTrue(isGeminiBase("https://generativelanguage.googleapis.com"));
      assert.isTrue(
        isGeminiBase("https://generativelanguage.googleapis.com/v1beta/openai"),
      );
      assert.isTrue(
        isGeminiBase(
          "https://generativelanguage.googleapis.com/v1beta/openai/responses",
        ),
      );
    });

    it("should return false for non-Gemini URLs", function () {
      assert.isFalse(isGeminiBase("https://api.openai.com"));
      assert.isFalse(isGeminiBase("https://api.anthropic.com"));
    });
  });

  describe("normalizeGeminiApiBase", function () {
    it("should expand bare domain to /v1beta/openai", function () {
      assert.equal(
        normalizeGeminiApiBase("https://generativelanguage.googleapis.com"),
        "https://generativelanguage.googleapis.com/v1beta/openai",
      );
    });

    it("should expand /v1beta base to /v1beta/openai", function () {
      assert.equal(
        normalizeGeminiApiBase(
          "https://generativelanguage.googleapis.com/v1beta",
        ),
        "https://generativelanguage.googleapis.com/v1beta/openai",
      );
    });

    it("should leave already-expanded URLs unchanged", function () {
      const full = "https://generativelanguage.googleapis.com/v1beta/openai";
      assert.equal(normalizeGeminiApiBase(full), full);
      const withChat =
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
      assert.equal(normalizeGeminiApiBase(withChat), withChat);
      const withResponses =
        "https://generativelanguage.googleapis.com/v1beta/openai/responses";
      assert.equal(normalizeGeminiApiBase(withResponses), withResponses);
    });

    it("should leave non-Gemini URLs unchanged", function () {
      assert.equal(
        normalizeGeminiApiBase("https://api.openai.com/v1"),
        "https://api.openai.com/v1",
      );
    });
  });
});

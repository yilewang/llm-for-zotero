import { assert } from "chai";
import {
  normalizeInputTokenCap,
  normalizeMaxTokens,
  normalizeTemperature,
} from "../src/utils/normalization";
import {
  DEFAULT_INPUT_TOKEN_CAP,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  MAX_ALLOWED_INPUT_TOKEN_CAP,
  MAX_ALLOWED_TOKENS,
} from "../src/utils/llmDefaults";

describe("normalization", function () {
  describe("normalizeTemperature", function () {
    it("should use default temperature for invalid input", function () {
      assert.equal(normalizeTemperature(undefined), DEFAULT_TEMPERATURE);
      assert.equal(normalizeTemperature(""), DEFAULT_TEMPERATURE);
      assert.equal(normalizeTemperature("not-a-number"), DEFAULT_TEMPERATURE);
    });

    it("should clamp to [0, 2]", function () {
      assert.equal(normalizeTemperature(-1), 0);
      assert.equal(normalizeTemperature(3), 2);
      assert.equal(normalizeTemperature(1.5), 1.5);
      assert.equal(normalizeTemperature("0.25"), 0.25);
    });
  });

  describe("normalizeMaxTokens", function () {
    it("should use default max tokens for invalid input", function () {
      assert.equal(normalizeMaxTokens(undefined), DEFAULT_MAX_TOKENS);
      assert.equal(normalizeMaxTokens(0), DEFAULT_MAX_TOKENS);
      assert.equal(normalizeMaxTokens(""), DEFAULT_MAX_TOKENS);
      assert.equal(normalizeMaxTokens("abc"), DEFAULT_MAX_TOKENS);
    });

    it("should clamp to [1, MAX_ALLOWED_TOKENS]", function () {
      assert.equal(normalizeMaxTokens(1), 1);
      assert.equal(normalizeMaxTokens("42"), 42);
      assert.equal(
        normalizeMaxTokens(MAX_ALLOWED_TOKENS + 99),
        MAX_ALLOWED_TOKENS,
      );
    });
  });

  describe("normalizeInputTokenCap", function () {
    it("should use default cap for invalid input", function () {
      assert.equal(normalizeInputTokenCap(undefined), DEFAULT_INPUT_TOKEN_CAP);
      assert.equal(normalizeInputTokenCap(0), DEFAULT_INPUT_TOKEN_CAP);
      assert.equal(normalizeInputTokenCap(""), DEFAULT_INPUT_TOKEN_CAP);
      assert.equal(normalizeInputTokenCap("abc"), DEFAULT_INPUT_TOKEN_CAP);
    });

    it("should clamp to [1, MAX_ALLOWED_INPUT_TOKEN_CAP]", function () {
      assert.equal(normalizeInputTokenCap(1), 1);
      assert.equal(normalizeInputTokenCap("2048"), 2048);
      assert.equal(
        normalizeInputTokenCap(MAX_ALLOWED_INPUT_TOKEN_CAP + 99),
        MAX_ALLOWED_INPUT_TOKEN_CAP,
      );
    });

    it("should honor a valid custom fallback", function () {
      assert.equal(normalizeInputTokenCap(undefined, 200000), 200000);
    });
  });
});

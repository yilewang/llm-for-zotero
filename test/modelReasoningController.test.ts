import { assert } from "chai";
import {
  isReasoningDisplayLabelActive,
  isScreenshotUnsupportedModel,
} from "../src/modules/contextPanel/setupHandlers/controllers/modelReasoningController";

describe("modelReasoningController", function () {
  describe("isScreenshotUnsupportedModel", function () {
    it("allows DeepSeek vision variants unless text-only mode is selected", function () {
      const model = "deepseek-v4-flash-vision-exp";
      const protocol = "openai_chat_compat";
      const apiBase = "https://api.deepseek.com/v1";

      assert.isFalse(
        isScreenshotUnsupportedModel(model, protocol, "api_key", apiBase),
      );
      assert.isTrue(
        isScreenshotUnsupportedModel(
          model,
          protocol,
          "api_key",
          apiBase,
          "text_only",
        ),
      );
    });
  });

  describe("isReasoningDisplayLabelActive", function () {
    it("treats off-like labels as inactive", function () {
      assert.isFalse(isReasoningDisplayLabelActive("off"));
      assert.isFalse(isReasoningDisplayLabelActive(" Off "));
      assert.isFalse(isReasoningDisplayLabelActive("disabled"));
    });

    it("keeps active labels active", function () {
      assert.isTrue(isReasoningDisplayLabelActive("dynamic"));
      assert.isTrue(isReasoningDisplayLabelActive("enabled"));
      assert.isTrue(isReasoningDisplayLabelActive("24576"));
    });
  });
});

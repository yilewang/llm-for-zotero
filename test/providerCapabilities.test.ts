import { assert } from "chai";
import {
  isTextOnlyModel,
  resolveProviderCapabilities,
} from "../src/providers";

describe("provider capabilities", function () {
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

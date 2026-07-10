import { assert } from "chai";
import { buildCodexAppServerReasoningConfig } from "../src/codexAppServer/reasoning";

describe("Codex app-server reasoning", function () {
  it("builds a direct effort override without reusing generic provider levels", function () {
    assert.deepEqual(buildCodexAppServerReasoningConfig("ultra"), {
      provider: "openai",
      level: "default",
      effort: "ultra",
    });
    assert.deepEqual(buildCodexAppServerReasoningConfig(" max "), {
      provider: "openai",
      level: "default",
      effort: "max",
    });
  });

  it("omits an explicit override for auto or empty modes", function () {
    assert.isUndefined(buildCodexAppServerReasoningConfig("auto"));
    assert.isUndefined(buildCodexAppServerReasoningConfig("AUTO"));
    assert.isUndefined(buildCodexAppServerReasoningConfig(""));
  });
});

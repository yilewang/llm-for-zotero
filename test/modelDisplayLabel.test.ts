import { assert } from "chai";
import { formatDisplayModelName } from "../src/utils/modelDisplayLabel";

describe("modelDisplayLabel", function () {
  it("keeps codex legacy labels on the codex prefix", function () {
    assert.equal(
      formatDisplayModelName("gpt-5.4", "OpenAI (codex auth, legacy)"),
      "codex/gpt-5.4",
    );
    assert.equal(
      formatDisplayModelName("gpt-5.4", "OpenAI (codex auth)"),
      "codex/gpt-5.4",
    );
  });

  it("keeps app server labels on the codex-app prefix", function () {
    assert.equal(
      formatDisplayModelName("gpt-5.4", "OpenAI (app server)"),
      "codex-app/gpt-5.4",
    );
  });

  it("keeps other provider labels unchanged", function () {
    assert.equal(
      formatDisplayModelName("gpt-4o-mini", "OpenAI"),
      "gpt-4o-mini",
    );
    assert.equal(formatDisplayModelName("", "OpenAI (codex auth, legacy)"), "");
  });

  it("preserves opaque Claude model values when provider prefixes are suppressed", function () {
    assert.equal(
      formatDisplayModelName("FutureModel-V7[2m]", "Claude Code", {
        suppressProviderPrefix: true,
      }),
      "FutureModel-V7[2m]",
    );
    assert.equal(
      formatDisplayModelName("gpt-5.6", "OpenAI (app server)", {
        suppressProviderPrefix: true,
      }),
      "codex-app/gpt-5.6",
    );
  });
});

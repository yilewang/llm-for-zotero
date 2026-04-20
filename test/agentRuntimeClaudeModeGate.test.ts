import { assert } from "chai";
import { describe, it } from "mocha";

describe("agent runtime Claude gate", function () {
  it("only routes to Claude bridge when conversationSystem is claude_code and the mode is enabled", function () {
    const shouldUseBridge = (
      conversationSystem: "upstream" | "claude_code",
      enabled: boolean,
    ) => conversationSystem === "claude_code" && enabled;

    assert.isFalse(shouldUseBridge("upstream", false));
    assert.isFalse(shouldUseBridge("upstream", true));
    assert.isFalse(shouldUseBridge("claude_code", false));
    assert.isTrue(shouldUseBridge("claude_code", true));
  });
});

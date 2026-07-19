import { assert } from "chai";
import { describe, it } from "mocha";
import type { ConversationSystem } from "../src/shared/types";
import { applyCodexAppServerModePreferenceChange } from "../src/codexAppServer/modePreference";

function createPreferenceState(initialSystem: ConversationSystem) {
  let enabled = false;
  let conversationSystem = initialSystem;
  const events: string[] = [];
  return {
    events,
    get enabled() {
      return enabled;
    },
    get conversationSystem() {
      return conversationSystem;
    },
    deps: {
      setCodexAppServerModeEnabled: (value: boolean) => {
        enabled = value;
        events.push(`enabled:${value}`);
      },
      getConversationSystemPref: () => conversationSystem,
      setConversationSystemPref: (value: ConversationSystem) => {
        conversationSystem = value;
        events.push(`system:${value}`);
      },
    },
  };
}

describe("Codex mode preference", function () {
  it("enables Codex availability without changing the active runtime", function () {
    const state = createPreferenceState("claude_code");

    applyCodexAppServerModePreferenceChange(true, state.deps);

    assert.isTrue(state.enabled);
    assert.equal(state.conversationSystem, "claude_code");
    assert.deepEqual(state.events, ["enabled:true"]);
  });

  it("leaves an inactive runtime selected when Codex is disabled", function () {
    const state = createPreferenceState("claude_code");

    applyCodexAppServerModePreferenceChange(false, state.deps);

    assert.isFalse(state.enabled);
    assert.equal(state.conversationSystem, "claude_code");
    assert.deepEqual(state.events, ["enabled:false"]);
  });

  it("returns to upstream when active Codex availability is disabled", function () {
    const state = createPreferenceState("codex");

    applyCodexAppServerModePreferenceChange(false, state.deps);

    assert.isFalse(state.enabled);
    assert.equal(state.conversationSystem, "upstream");
    assert.deepEqual(state.events, ["enabled:false", "system:upstream"]);
  });
});

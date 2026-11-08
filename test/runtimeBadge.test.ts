import { assert } from "chai";
import {
  getRuntimeBadgeLabel,
  resolveRuntimeBadgeState,
  type RuntimeBadgeStateInput,
} from "../src/modules/contextPanel/runtimeBadge";

const base: RuntimeBadgeStateInput = {
  system: "upstream",
  agentEnabled: true,
  codexEnabled: true,
  claudeEnabled: true,
  isWebChat: false,
  isSideChat: false,
};

describe("runtime badge state", function () {
  it("lists Agent, Codex and Claude when all are on", function () {
    const state = resolveRuntimeBadgeState(base);
    assert.isTrue(state.visible);
    assert.isTrue(state.clickable);
    assert.equal(state.label, "Agent");
    assert.deepEqual(
      state.items.map((item) => [item.system, item.label]),
      [
        ["upstream", "Agent"],
        ["codex", "Codex"],
        ["claude_code", "Claude"],
      ],
    );
  });

  it("labels the current runtime", function () {
    assert.equal(
      resolveRuntimeBadgeState({ ...base, system: "codex" }).label,
      "Codex",
    );
    assert.equal(
      resolveRuntimeBadgeState({ ...base, system: "claude_code" }).label,
      "Claude",
    );
  });

  it("lists only the runtimes that are on in Preferences", function () {
    const state = resolveRuntimeBadgeState({ ...base, claudeEnabled: false });
    assert.deepEqual(
      state.items.map((item) => item.system),
      ["upstream", "codex"],
    );
    assert.isTrue(state.clickable);
  });

  it("is a static Agent label when only Agent is on", function () {
    const state = resolveRuntimeBadgeState({
      ...base,
      codexEnabled: false,
      claudeEnabled: false,
    });
    assert.isTrue(state.visible);
    assert.isFalse(state.clickable);
    assert.equal(state.label, "Agent");
    assert.lengthOf(state.items, 1);
  });

  it("names the built-in runtime Chat when the Agent feature is off", function () {
    const state = resolveRuntimeBadgeState({ ...base, agentEnabled: false });
    assert.equal(state.label, "Chat");
    assert.equal(state.items[0]!.label, "Chat");
    assert.isTrue(state.clickable);
    assert.equal(getRuntimeBadgeLabel("upstream", false), "Chat");
  });

  it("hides the badge when Agent, Codex and Claude are all off", function () {
    const state = resolveRuntimeBadgeState({
      ...base,
      agentEnabled: false,
      codexEnabled: false,
      claudeEnabled: false,
    });
    assert.isFalse(state.visible);
    assert.isFalse(state.clickable);
  });

  it("keeps the badge visible when only Codex is on and Agent is off", function () {
    const state = resolveRuntimeBadgeState({
      ...base,
      agentEnabled: false,
      claudeEnabled: false,
    });
    assert.isTrue(state.visible);
    assert.deepEqual(
      state.items.map((item) => item.label),
      ["Chat", "Codex"],
    );
  });

  it("keeps the label of a running Codex panel after Codex is turned off", function () {
    const state = resolveRuntimeBadgeState({
      ...base,
      system: "codex",
      agentEnabled: false,
      codexEnabled: false,
      claudeEnabled: false,
    });
    assert.isTrue(state.visible);
    assert.isFalse(state.clickable);
    assert.equal(state.label, "Codex");
  });

  it("hides the badge in WebChat", function () {
    const state = resolveRuntimeBadgeState({ ...base, isWebChat: true });
    assert.isFalse(state.visible);
    assert.isFalse(state.clickable);
  });

  it("names the held chat's runtime in a torn-off window and switches nothing", function () {
    const state = resolveRuntimeBadgeState({
      ...base,
      system: "codex",
      isTornWindow: true,
    });
    assert.isTrue(state.visible);
    assert.isFalse(state.clickable);
    assert.equal(state.label, "Codex");
    assert.deepEqual(
      state.items.map((item) => item.system),
      ["codex"],
    );
  });

  it("is not clickable in a side chat and offers no Codex or Claude", function () {
    const state = resolveRuntimeBadgeState({ ...base, isSideChat: true });
    assert.isTrue(state.visible);
    assert.isFalse(state.clickable);
    assert.deepEqual(
      state.items.map((item) => item.system),
      ["upstream"],
    );
  });
});

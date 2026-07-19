import { assert } from "chai";
import { describe, it } from "mocha";
import type { ConversationSystem } from "../src/shared/types";
import {
  resolveRuntimeSystemControlsState,
  resolveRuntimeSystemToggleTarget,
} from "../src/modules/contextPanel/runtimeSystemControls";

function visibleSystems(input: {
  activeSystem: ConversationSystem;
  codexEnabled: boolean;
  claudeEnabled: boolean;
  hidden?: boolean;
}): string[] {
  const state = resolveRuntimeSystemControlsState(input);
  return Object.entries(state.buttons)
    .filter(([, button]) => button.visible)
    .map(([system]) => system);
}

function activeSystems(input: {
  activeSystem: ConversationSystem;
  codexEnabled: boolean;
  claudeEnabled: boolean;
  hidden?: boolean;
}): string[] {
  const state = resolveRuntimeSystemControlsState(input);
  return Object.entries(state.buttons)
    .filter(([, button]) => button.active)
    .map(([system]) => system);
}

describe("runtime system controls", function () {
  it("covers the complete availability and active-state matrix", function () {
    const cases: Array<{
      input: {
        activeSystem: ConversationSystem;
        codexEnabled: boolean;
        claudeEnabled: boolean;
      };
      visible: string[];
      active: string[];
    }> = [
      {
        input: {
          activeSystem: "upstream",
          codexEnabled: false,
          claudeEnabled: false,
        },
        visible: [],
        active: [],
      },
      {
        input: {
          activeSystem: "upstream",
          codexEnabled: true,
          claudeEnabled: false,
        },
        visible: ["codex"],
        active: [],
      },
      {
        input: {
          activeSystem: "codex",
          codexEnabled: true,
          claudeEnabled: false,
        },
        visible: ["codex"],
        active: ["codex"],
      },
      {
        input: {
          activeSystem: "upstream",
          codexEnabled: false,
          claudeEnabled: true,
        },
        visible: ["claude_code"],
        active: [],
      },
      {
        input: {
          activeSystem: "claude_code",
          codexEnabled: false,
          claudeEnabled: true,
        },
        visible: ["claude_code"],
        active: ["claude_code"],
      },
      {
        input: {
          activeSystem: "upstream",
          codexEnabled: true,
          claudeEnabled: true,
        },
        visible: ["codex", "claude_code"],
        active: [],
      },
      {
        input: {
          activeSystem: "codex",
          codexEnabled: true,
          claudeEnabled: true,
        },
        visible: ["codex", "claude_code"],
        active: ["codex"],
      },
      {
        input: {
          activeSystem: "claude_code",
          codexEnabled: true,
          claudeEnabled: true,
        },
        visible: ["codex", "claude_code"],
        active: ["claude_code"],
      },
    ];

    for (const testCase of cases) {
      assert.deepEqual(visibleSystems(testCase.input), testCase.visible);
      assert.deepEqual(activeSystems(testCase.input), testCase.active);
      const state = resolveRuntimeSystemControlsState(testCase.input);
      assert.equal(state.groupVisible, testCase.visible.length > 0);
    }
  });

  it("hides the complete group in webchat", function () {
    const input = {
      activeSystem: "codex" as const,
      codexEnabled: true,
      claudeEnabled: true,
      hidden: true,
    };

    assert.deepEqual(visibleSystems(input), []);
    assert.deepEqual(activeSystems(input), []);
    assert.isFalse(resolveRuntimeSystemControlsState(input).groupVisible);
  });

  it("keeps inactive controls selectable and only disables them while busy", function () {
    const idle = resolveRuntimeSystemControlsState({
      activeSystem: "codex",
      codexEnabled: true,
      claudeEnabled: true,
    });
    const busy = resolveRuntimeSystemControlsState({
      activeSystem: "codex",
      codexEnabled: true,
      claudeEnabled: true,
      busy: true,
    });

    assert.isFalse(idle.buttons.codex.disabled);
    assert.isFalse(idle.buttons.claude_code.disabled);
    assert.isTrue(busy.buttons.codex.disabled);
    assert.isTrue(busy.buttons.claude_code.disabled);
  });

  it("selects the clicked runtime or returns an active runtime to upstream", function () {
    assert.equal(
      resolveRuntimeSystemToggleTarget("upstream", "codex"),
      "codex",
    );
    assert.equal(
      resolveRuntimeSystemToggleTarget("upstream", "claude_code"),
      "claude_code",
    );
    assert.equal(
      resolveRuntimeSystemToggleTarget("codex", "claude_code"),
      "claude_code",
    );
    assert.equal(
      resolveRuntimeSystemToggleTarget("claude_code", "codex"),
      "codex",
    );
    assert.equal(
      resolveRuntimeSystemToggleTarget("codex", "codex"),
      "upstream",
    );
    assert.equal(
      resolveRuntimeSystemToggleTarget("claude_code", "claude_code"),
      "upstream",
    );
  });
});

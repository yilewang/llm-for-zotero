import { assert } from "chai";
import { describe, it } from "mocha";
import {
  applyClaudeCodeModePreferenceChange,
  ensureClaudeProjectBootstrapIfEnabled,
} from "../src/claudeCode/bootstrapGate";
import type { ConversationSystem } from "../src/shared/types";

describe("Claude project bootstrap gate", function () {
  it("skips startup bootstrap when Claude Code mode is disabled", async function () {
    let bootstrapCalls = 0;

    const ran = await ensureClaudeProjectBootstrapIfEnabled({
      isClaudeCodeModeEnabled: () => false,
      ensureClaudeProjectBootstrap: async () => {
        bootstrapCalls += 1;
      },
    });

    assert.isFalse(ran);
    assert.equal(bootstrapCalls, 0);
  });

  it("runs startup bootstrap when Claude Code mode is enabled", async function () {
    let bootstrapCalls = 0;

    const ran = await ensureClaudeProjectBootstrapIfEnabled({
      isClaudeCodeModeEnabled: () => true,
      ensureClaudeProjectBootstrap: async () => {
        bootstrapCalls += 1;
      },
    });

    assert.isTrue(ran);
    assert.equal(bootstrapCalls, 1);
  });

  it("bootstraps Claude project files when the preference is enabled", async function () {
    const events: string[] = [];
    let prefEnabled = false;
    let conversationSystem: ConversationSystem = "upstream";

    await applyClaudeCodeModePreferenceChange(
      true,
      (enabled) => {
        events.push(`ui:${enabled}`);
      },
      {
        setClaudeCodeModeEnabled: (enabled) => {
          prefEnabled = enabled;
          events.push(`pref:${enabled}`);
        },
        getConversationSystemPref: () => conversationSystem,
        setConversationSystemPref: (system) => {
          conversationSystem = system;
          events.push(`system:${system}`);
        },
        ensureClaudeProjectBootstrap: async () => {
          events.push("bootstrap");
        },
        log: (...args: unknown[]) => {
          events.push(`log:${String(args[0])}`);
        },
      },
    );

    assert.isTrue(prefEnabled);
    assert.equal(conversationSystem, "upstream");
    assert.deepEqual(events, ["ui:true", "pref:true", "bootstrap"]);
  });

  it("does not bootstrap and falls back to upstream when the preference is disabled", async function () {
    const events: string[] = [];
    let prefEnabled = true;
    let conversationSystem: ConversationSystem = "claude_code";

    await applyClaudeCodeModePreferenceChange(
      false,
      (enabled) => {
        events.push(`ui:${enabled}`);
      },
      {
        setClaudeCodeModeEnabled: (enabled) => {
          prefEnabled = enabled;
          events.push(`pref:${enabled}`);
        },
        getConversationSystemPref: () => conversationSystem,
        setConversationSystemPref: (system) => {
          conversationSystem = system;
          events.push(`system:${system}`);
        },
        ensureClaudeProjectBootstrap: async () => {
          events.push("bootstrap");
        },
        log: (...args: unknown[]) => {
          events.push(`log:${String(args[0])}`);
        },
      },
    );

    assert.isFalse(prefEnabled);
    assert.equal(conversationSystem, "upstream");
    assert.deepEqual(events, ["ui:false", "pref:false", "system:upstream"]);
  });
});

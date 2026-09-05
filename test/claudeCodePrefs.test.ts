import { assert } from "chai";
import { after, beforeEach, describe, it } from "mocha";
import {
  getClaudeRuntimeModelPref,
  setClaudeRuntimeModelPref,
} from "../src/claudeCode/prefs";

describe("Claude Code model preferences", function () {
  const originalZotero = globalThis.Zotero;
  const prefStore = new Map<string, unknown>();

  beforeEach(function () {
    prefStore.clear();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("persists arbitrary model values without lowercasing or stripping suffixes", function () {
    setClaudeRuntimeModelPref("  FutureModel-V7[2m]  ");

    assert.equal(getClaudeRuntimeModelPref(), "FutureModel-V7[2m]");
  });

  it("keeps the previous model when an empty value is submitted", function () {
    setClaudeRuntimeModelPref("claude-fable-5[1m]");
    setClaudeRuntimeModelPref("   ");

    assert.equal(getClaudeRuntimeModelPref(), "claude-fable-5[1m]");
  });

  it("uses sonnet only when no model preference exists", function () {
    assert.equal(getClaudeRuntimeModelPref(), "sonnet");
  });
});

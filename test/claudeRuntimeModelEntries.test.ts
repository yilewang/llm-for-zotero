import { assert } from "chai";
import { afterEach, beforeEach } from "mocha";
import { getClaudeRuntimeModelEntries } from "../src/claudeCode/runtime";

describe("Claude Code runtime model entries", function () {
  const originalZotero = globalThis.Zotero;

  beforeEach(function () {
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get() {
          return "";
        },
      },
    } as typeof Zotero;
  });

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("does not expose manual input mode overrides", function () {
    const entries = getClaudeRuntimeModelEntries();

    assert.isAbove(entries.length, 0);
    for (const entry of entries) {
      assert.equal(entry.providerLabel, "Claude Code");
      assert.isUndefined(entry.advanced.inputMode);
    }
  });
});

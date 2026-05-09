import { assert } from "chai";
import { after, beforeEach, describe, it } from "mocha";
import {
  getConversationSystemPref,
  getStoredConversationSystemPref,
  setConversationSystemPref,
} from "../src/claudeCode/prefs";

describe("conversation system preferences", function () {
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

  it("persists Codex as a first-class conversation system", function () {
    setConversationSystemPref("codex");

    assert.equal(getConversationSystemPref(), "codex");
    assert.equal(getStoredConversationSystemPref(), "codex");
  });

  it("distinguishes unset preference from explicit upstream", function () {
    assert.equal(getConversationSystemPref(), "upstream");
    assert.isNull(getStoredConversationSystemPref());

    setConversationSystemPref("upstream");

    assert.equal(getConversationSystemPref(), "upstream");
    assert.equal(getStoredConversationSystemPref(), "upstream");
  });

  it("normalizes unknown conversation systems back to upstream", function () {
    setConversationSystemPref("codex");
    const prefKey = Array.from(prefStore.keys()).find((key) =>
      key.endsWith("conversationSystem"),
    );
    assert.isString(prefKey);
    prefStore.set(prefKey as string, "future_runtime");

    assert.equal(getConversationSystemPref(), "upstream");
    assert.isNull(getStoredConversationSystemPref());
  });
});

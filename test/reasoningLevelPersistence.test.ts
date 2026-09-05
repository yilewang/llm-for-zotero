import { assert } from "chai";
import {
  getLastUsedReasoningLevel,
  getLastUsedReasoningLevelForProvider,
  setLastUsedReasoningLevel,
  setLastUsedReasoningLevelForProvider,
} from "../src/modules/contextPanel/prefHelpers";

/**
 * A level the user defined in the model parameter editor has to survive a
 * restart. The pref store used to validate against a fixed list of the seven
 * levels the plugin shipped with, so a provider's newly-introduced level —
 * `ultra`, and whatever follows — was selectable for one session and then
 * silently forgotten.
 */
describe("reasoning level persistence", function () {
  const originalZotero = globalThis.Zotero;

  beforeEach(function () {
    const prefStore = new Map<string, unknown>();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
        clear: (key: string) => {
          prefStore.delete(key);
        },
      },
    } as unknown as typeof Zotero;
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("remembers a provider-introduced level", function () {
    setLastUsedReasoningLevel("ultra");
    assert.equal(getLastUsedReasoningLevel(), "ultra");
  });

  it("remembers a per-provider custom level", function () {
    setLastUsedReasoningLevelForProvider("openai", "ultra");
    assert.equal(getLastUsedReasoningLevelForProvider("openai"), "ultra");
  });

  it("still remembers the built-in levels", function () {
    for (const level of [
      "none",
      "default",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ] as const) {
      setLastUsedReasoningLevel(level);
      assert.equal(getLastUsedReasoningLevel(), level);
    }
  });

  it("refuses shapes that could corrupt the pref store", function () {
    for (const bad of [
      "",
      "  ",
      "-leading-dash",
      "has space",
      "has/slash",
      "Has.Dot",
      '{"json":1}',
      "a".repeat(33),
    ]) {
      setLastUsedReasoningLevel("high");
      setLastUsedReasoningLevel(bad as never);
      assert.equal(
        getLastUsedReasoningLevel(),
        "high",
        `"${bad}" must be rejected rather than stored`,
      );
    }
  });

  it("still rejects an unknown provider key", function () {
    setLastUsedReasoningLevelForProvider("not-a-provider", "high");
    assert.isNull(getLastUsedReasoningLevelForProvider("not-a-provider"));
  });
});

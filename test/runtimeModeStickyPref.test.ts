import { assert } from "chai";
import { after, beforeEach, describe, it } from "mocha";
import {
  getLastUsedRuntimeMode,
  setLastUsedRuntimeMode,
} from "../src/modules/contextPanel/prefHelpers";

describe("sticky runtime mode preference", function () {
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

  it("reports no opinion until a mode has been chosen", function () {
    assert.isNull(getLastUsedRuntimeMode());
  });

  it("round-trips both runtime modes", function () {
    setLastUsedRuntimeMode("agent");
    assert.equal(getLastUsedRuntimeMode(), "agent");

    setLastUsedRuntimeMode("chat");
    assert.equal(getLastUsedRuntimeMode(), "chat");
  });

  it("ignores values that are not a runtime mode", function () {
    setLastUsedRuntimeMode("agent");
    setLastUsedRuntimeMode("turbo" as never);

    assert.equal(getLastUsedRuntimeMode(), "agent");
  });

  it("tolerates a stored value that is not a runtime mode", function () {
    prefStore.set("extensions.zotero.llmforzotero.lastUsedRuntimeMode", "nope");

    assert.isNull(getLastUsedRuntimeMode());
  });
});

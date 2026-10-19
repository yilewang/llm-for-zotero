import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { config } from "../package.json";
import {
  isDeepSeekHarnessEnabled,
  setAgentEngineEnabled,
} from "../src/deepseekHarness/prefs";

describe("Agent engine card switches", function () {
  const originalZotero = globalThis.Zotero;
  const values = new Map<string, unknown>();
  const pref = (name: string) => values.get(`${config.prefsPrefix}.${name}`);

  beforeEach(function () {
    values.clear();
    globalThis.Zotero = {
      Prefs: {
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown) => values.set(key, value),
      },
    } as typeof Zotero;
  });
  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  it("selects Harness and enables Agent when its card is switched on", function () {
    setAgentEngineEnabled("deepseek_harness", true);
    assert.isTrue(isDeepSeekHarnessEnabled());
    assert.isTrue(pref("enableAgentMode"));
  });

  it("selects the built-in engine when Original Agent is switched on", function () {
    setAgentEngineEnabled("deepseek_harness", true);
    setAgentEngineEnabled("builtin", true);
    assert.isFalse(isDeepSeekHarnessEnabled());
    assert.isTrue(pref("enableAgentMode"));
  });

  it("disables Agent while retaining the selected engine and worker paths", function () {
    values.set(
      `${config.prefsPrefix}.deepseekHarnessWorkerPath`,
      "/runtime/worker.mjs",
    );
    setAgentEngineEnabled("deepseek_harness", true);
    setAgentEngineEnabled("deepseek_harness", false);
    assert.isFalse(pref("enableAgentMode"));
    assert.isTrue(isDeepSeekHarnessEnabled());
    assert.equal(pref("deepseekHarnessWorkerPath"), "/runtime/worker.mjs");
  });

  it("keeps the active engine enabled when the other card is switched off", function () {
    setAgentEngineEnabled("deepseek_harness", true);
    setAgentEngineEnabled("builtin", false);
    assert.isTrue(isDeepSeekHarnessEnabled());
    assert.isTrue(pref("enableAgentMode"));
  });
});

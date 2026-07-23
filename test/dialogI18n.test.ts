import { assert } from "chai";
import { initI18n, t } from "../src/utils/i18n";

describe("shared dialog localization", function () {
  const globals = globalThis as unknown as { Zotero?: unknown };
  let previousZotero: unknown;

  before(function () {
    previousZotero = globals.Zotero;
    globals.Zotero = {
      Prefs: { get: () => "zh-CN" },
      locale: "zh-CN",
    };
    initI18n();
  });

  after(function () {
    if (previousZotero === undefined) delete globals.Zotero;
    else globals.Zotero = previousZotero;
    initI18n();
  });

  it("translates rename, shortcut editing, and reset dialog strings", function () {
    const strings = [
      "Add Shortcut",
      "Edit Shortcut",
      "Reset Shortcuts",
      "Label",
      "Prompt",
      "Save",
      "Reset all shortcuts to their default labels, prompts, order, and visibility?",
    ];

    for (const value of strings) assert.notEqual(t(value), value, value);
  });
});

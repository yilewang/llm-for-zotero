import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "mocha";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

describe("runtime preference UI", function () {
  it("allows Codex and Claude Code availability to coexist", function () {
    const preferenceScript = source("src/modules/preferenceScript.ts");
    const preferences = source("addon/content/preferences.xhtml");

    assert.notInclude(preferenceScript, "syncModeMutualExclusion");
    assert.notInclude(
      preferenceScript,
      "Disable Codex App Server first to switch on Claude Code.",
    );
    assert.notInclude(
      preferenceScript,
      "Disable Claude Code first to switch on Codex App Server.",
    );
    assert.include(
      preferenceScript,
      "applyCodexAppServerModePreferenceChange(enabled)",
    );
    assert.include(
      preferences,
      "Codex and Claude Code can both be enabled; only the selected",
    );
  });
});

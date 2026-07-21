import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

describe("note focus header layout", function () {
  it("reuses the paper/library header controls for note focus", function () {
    const buildUi = source("src/modules/contextPanel/buildUI.ts");
    const setupHandlers = source("src/modules/contextPanel/setupHandlers.ts");

    assert.include(
      buildUi,
      "historyBar.append(historyNewBtn, historyToggle, headerRuntimeControls)",
      "note focus must keep the same +, history, mode-chip, runtime order as normal chat",
    );
    assert.include(
      buildUi,
      "headerRuntimeControls.append(\n    modeSwitchWrap,\n    runtimeSystemControls.group,",
      "runtime icons must remain immediately after the static mode chip",
    );
    assert.notInclude(
      setupHandlers,
      'historyNewBtn.style.display = noteSession ? "none" : ""',
      "note focus must not hide the normal new-chat button",
    );
    assert.notInclude(
      setupHandlers,
      'historyToggleBtn.style.display = noteSession ? "none" : ""',
      "note focus must not hide the normal history button",
    );
  });
});

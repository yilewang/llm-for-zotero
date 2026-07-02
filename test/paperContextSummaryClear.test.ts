import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

describe("paper context summary clear affordance", function () {
  it("renders the clear-all affordance inside the paper summary chip", function () {
    const setupHandlers = source("src/modules/contextPanel/setupHandlers.ts");
    const css = source("addon/content/zoteroPane.css");

    assert.include(setupHandlers, "llm-paper-context-summary-clear");
    assert.include(setupHandlers, 't("Clear all context")');
    assert.include(css, ".llm-paper-context-summary-clear");
  });

  it("clears all context from the summary chip without the old right-click menu", function () {
    const composeController = source(
      "src/modules/contextPanel/setupHandlers/controllers/composePreviewInteractionController.ts",
    );
    const buildUi = source("src/modules/contextPanel/buildUI.ts");
    const setupHandlers = source("src/modules/contextPanel/setupHandlers.ts");

    assert.include(composeController, ".llm-paper-context-summary-clear");
    assert.include(composeController, "clearAllContext();");
    assert.notInclude(composeController, "attachContextBarClearMenuController");
    assert.notInclude(buildUi, "llm-context-bar-menu");
    assert.notInclude(buildUi, "llm-context-bar-clear");
    assert.notInclude(setupHandlers, "contextBarMenu");
    assert.notInclude(setupHandlers, "contextBarClearBtn");
  });
});

import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTEXT_ICON_NAMES,
  getContextIconClassName,
} from "../src/modules/contextPanel/contextIcons";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

describe("paper context summary chip source", function () {
  it("uses a dedicated multiple-papers context icon for the summary chip", function () {
    const setupHandlers = source("src/modules/contextPanel/setupHandlers.ts");
    const css = source("addon/content/zoteroPane.css");
    const icon = source("addon/content/icons/action-papers.svg");

    assert.include(CONTEXT_ICON_NAMES, "papers");
    assert.equal(getContextIconClassName("papers"), "llm-context-icon-papers");
    assert.include(setupHandlers, "const summaryIcon = createContextIcon(");
    assert.include(setupHandlers, '"papers",');
    assert.include(setupHandlers, '"llm-paper-context-summary-icon"');
    assert.match(css, /\.llm-context-icon-papers\s*\{/);
    assert.include(icon, "M7 2.75H13.25");
    assert.include(icon, "M5.75 8.25H9.75");
  });

  it("keeps the summary chip horizontal and visibly rectangular", function () {
    const css = source("addon/content/zoteroPane.css");

    assert.match(
      css,
      /\.llm-selected-context\.llm-paper-context-summary-chip\s*\{[\s\S]*?flex-direction: row;/,
    );
    assert.match(
      css,
      /\.llm-selected-context\.llm-paper-context-summary-chip\s*\{[\s\S]*?border-radius: 4px;/,
    );
    assert.match(
      css,
      /\.llm-selected-context\.llm-paper-context-summary-chip\s*\{[\s\S]*?border: 1px solid\s+color-mix\(in srgb, var\(--color-accent\) 45%, var\(--stroke-secondary\)\);/,
    );
  });
});

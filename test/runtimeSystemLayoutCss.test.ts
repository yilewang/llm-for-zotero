import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "mocha";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

function extractCssRule(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`))?.[0] || "";
}

describe("runtime system control layout", function () {
  it("keeps the static mode chip and runtime icons in the same left flow", function () {
    const css = source("addon/content/zoteroPane.css");
    const buildUi = source("src/modules/contextPanel/buildUI.ts");
    const headerRule = extractCssRule(css, ".llm-header-top");
    const headerInfoRule = extractCssRule(css, ".llm-header-info");
    const headerActionsRule = extractCssRule(css, ".llm-header-actions");
    const historyRule = extractCssRule(css, ".llm-history-bar");
    const runtimeRule = extractCssRule(css, ".llm-header-runtime-controls");
    const modeSwitchRule = extractCssRule(css, ".llm-mode-switch");
    const modeChipRule = extractCssRule(css, ".llm-mode-chip");

    assert.include(headerRule, "display: grid");
    assert.include(headerRule, "grid-template-columns: minmax(0, 1fr) auto");
    assert.include(headerInfoRule, "min-width: 0");
    assert.notInclude(headerRule, "flex-wrap");
    assert.notInclude(headerActionsRule, "position: absolute");
    assert.include(historyRule, "min-width: 0");
    assert.include(runtimeRule, "min-width: max-content");
    assert.include(modeSwitchRule, "flex: 0 0 auto");
    assert.include(modeSwitchRule, "width: auto");
    assert.include(modeChipRule, "flex: 0 0 auto");
    assert.notInclude(modeChipRule, "overflow: hidden");
    assert.notInclude(modeChipRule, "text-overflow: ellipsis");
    assert.include(
      buildUi,
      "headerRuntimeControls.append(\n    modeSwitchWrap,\n    runtimeSystemControls.group,",
    );
    assert.include(
      buildUi,
      "historyBar.append(historyNewBtn, historyToggle, headerRuntimeControls)",
    );
  });

  it("keeps both runtime buttons fixed at 24px and in normal flow", function () {
    const css = source("addon/content/zoteroPane.css");
    const buttonRule = extractCssRule(css, ".llm-runtime-system-toggle");
    const panelGroupRule = extractCssRule(css, ".llm-header-runtime-controls");
    const dualGroupRule = extractCssRule(
      css,
      '.llm-runtime-system-controls[data-visible-count="2"]',
    );

    assert.include(buttonRule, "width: 24px");
    assert.include(buttonRule, "height: 24px");
    assert.include(buttonRule, "min-width: 24px");
    assert.include(buttonRule, "flex: 0 0 24px");
    assert.include(buttonRule, "margin: 0 !important");
    assert.notInclude(buttonRule, "position: absolute");
    assert.notInclude(panelGroupRule, "position: absolute");
    assert.include(dualGroupRule, "width: 50px");
    assert.include(dualGroupRule, "min-width: 50px");
  });

  it("uses the shared mask assets instead of inline runtime glyph markup", function () {
    const css = source("addon/content/zoteroPane.css");
    const sidebarSource = source("src/modules/contextPanel/buildUI.ts");
    const standaloneSource = source(
      "src/modules/contextPanel/standaloneWindow.ts",
    );

    assert.include(css, 'mask-image: url("icons/claude-code.svg")');
    assert.include(sidebarSource, "createRuntimeSystemControls");
    assert.include(standaloneSource, "createRuntimeSystemControls");
    assert.notInclude(sidebarSource, "<svg");
    assert.notInclude(standaloneSource, "20.998 10.949");
  });

  it("reuses the standalone clear icon for the responsive sidebar button", function () {
    const css = source("addon/content/zoteroPane.css");
    const sidebarSource = source("src/modules/contextPanel/buildUI.ts");
    const handlerSource = source("src/modules/contextPanel/setupHandlers.ts");

    assert.include(sidebarSource, "llm-btn-icon llm-clear-btn");
    assert.include(css, '.llm-clear-btn[data-compact="true"]');
    assert.include(css, "@container (max-width: 380px)");
    assert.equal(
      css.split('url("icons/action-clear.svg")').length - 1,
      4,
      "the sidebar and standalone masks must share the same clear asset",
    );
    assert.include(handlerSource, "syncResponsiveHeaderClearButton");
    assert.include(handlerSource, "shouldCompactHeaderClearButton");
  });
});

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

  it("scales the mode chip label with the plugin font setting at every width", function () {
    const css = source("addon/content/zoteroPane.css");
    const modeChipRule = extractCssRule(css, ".llm-mode-chip");

    // The label follows --llm-font-scale like the rest of the plugin's text.
    // A static chip, or one frozen behind a width breakpoint, is a downgrade at
    // the sidebar widths people actually use — it stops responding to the font
    // size shortcuts.
    assert.include(modeChipRule, "font-size: var(--llm-fs-12)");

    // No width breakpoint may pin it either: the compact header shrinks buttons
    // to icons, but the chip keeps scaling.
    const compactBlock =
      css.match(/@container \(max-width: 380px\) \{[\s\S]*?\n\}/)?.[0] || "";
    assert.notEqual(compactBlock, "", "compact header block must still exist");
    assert.notInclude(compactBlock, ".llm-mode-chip");
  });

  it("tightens the leading gaps in the compact header without resizing the icons", function () {
    const css = source("addon/content/zoteroPane.css");
    const compactBlock =
      css.match(/@container \(max-width: 380px\) \{[\s\S]*?\n\}/)?.[0] || "";
    const historyBarCompactRule = extractCssRule(
      compactBlock,
      ".llm-history-bar",
    );
    // Both selectors appear in a shared rule before their sized ones, so
    // collect every rule that targets them rather than just the first match.
    const historyIconRules = (
      css.match(/\.llm-history-(?:new|toggle)\s*\{[^}]*\}/g) || []
    ).join("\n");

    // The chip is the only element in this row that scales with
    // --llm-font-scale, and it is pinned rigid, so it can only grow into space
    // the fixed chrome gives up. Reclaim that from the spacing, not from the
    // icons — their 20px size is deliberate and must not follow the width.
    assert.include(historyBarCompactRule, "gap: 4px");
    assert.include(historyIconRules, "width: 20px");
    assert.notInclude(historyIconRules, "width: 16px");
    assert.notInclude(compactBlock, ".llm-history-new");
    assert.notInclude(compactBlock, ".llm-history-toggle");
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

  it("uses the existing compact trash icon at every sidebar width", function () {
    const css = source("addon/content/zoteroPane.css");
    const sidebarSource = source("src/modules/contextPanel/buildUI.ts");
    const handlerSource = source("src/modules/contextPanel/setupHandlers.ts");
    const standaloneSource = source(
      "src/modules/contextPanel/standaloneWindow.ts",
    );
    const deleteButtonRule = extractCssRule(css, ".llm-clear-btn");
    const deleteIconRule = extractCssRule(css, ".llm-clear-btn::before");

    assert.include(sidebarSource, "llm-btn-icon llm-clear-btn");
    assert.include(sidebarSource, 'title: t("Delete conversation")');
    assert.include(
      sidebarSource,
      'clearBtn.setAttribute("aria-label", t("Delete conversation"))',
    );
    assert.notInclude(sidebarSource, 'textContent: t("Clear")');
    assert.include(deleteButtonRule, "width: 28px");
    assert.include(deleteButtonRule, "font-size: 0");
    assert.include(deleteIconRule, "display: block");
    assert.notInclude(css, '.llm-clear-btn[data-compact="true"]');
    assert.include(css, "@container (max-width: 380px)");
    assert.equal(
      css.split('url("icons/action-clear.svg")').length - 1,
      4,
      "the sidebar and standalone masks must share the existing trash asset",
    );
    assert.notInclude(handlerSource, "syncResponsiveHeaderClearButton");
    assert.notInclude(handlerSource, "shouldCompactHeaderClearButton");
    assert.include(handlerSource, 'clearBtn.textContent = ""');
    assert.include(handlerSource, 't("Delete conversation")');
    assert.include(
      standaloneSource,
      'iconClear.title = t("Delete conversation")',
    );
    assert.notInclude(standaloneSource, 'iconClear.title = t("Clear")');
  });

  it("keeps the sidebar export icon fixed when plugin text scales", function () {
    const css = source("addon/content/zoteroPane.css");
    const sidebarSource = source("src/modules/contextPanel/buildUI.ts");
    const exportButtonRule = extractCssRule(css, ".llm-export-btn");
    const exportIconRule = extractCssRule(css, ".llm-export-btn::before");
    const standaloneExportIconRule = extractCssRule(
      css,
      ".llm-standalone-icon-export::before",
    );

    assert.include(sidebarSource, '"llm-btn-icon llm-export-btn"');
    assert.notInclude(sidebarSource, 'textContent: "⤓"');
    assert.include(
      sidebarSource,
      'exportBtn.setAttribute("aria-label", t("Export"))',
    );
    assert.include(exportButtonRule, "width: 28px");
    assert.include(exportButtonRule, "height: 28px");
    assert.include(exportButtonRule, "font-size: 0");
    assert.include(exportIconRule, "width: 16px");
    assert.include(exportIconRule, "height: 16px");
    assert.include(exportIconRule, 'url("icons/action-export.svg")');
    assert.include(standaloneExportIconRule, 'url("icons/action-export.svg")');
  });
});

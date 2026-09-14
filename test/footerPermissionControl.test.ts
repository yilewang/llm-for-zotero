import { assert } from "chai";
import { readFileSync } from "node:fs";
import { positionFloatingMenu } from "../src/modules/contextPanel/setupHandlers/controllers/menuController";

describe("footer permission control", function () {
  it("uses the existing designed confirmation dialog for Codex full access", function () {
    const controller = readFileSync(
      "src/modules/contextPanel/footerPermissionControl.ts",
      "utf8",
    );
    const preferences = readFileSync("src/modules/preferenceScript.ts", "utf8");

    assert.include(controller, "showStandaloneConfirmationDialog");
    assert.include(controller, 'title: t("Enable Codex full access?")');
    assert.include(controller, 'confirmLabel: t("Enable full access")');
    assert.include(controller, "destructive: true");
    assert.notInclude(controller, "defaultView?.confirm");

    assert.include(preferences, "confirmCodexFullAccess");
    assert.include(preferences, '.open(t("Enable Codex full access?"))');
    assert.notInclude(preferences, "defaultView?.confirm");
  });

  it("keeps the permission selector and context gauge together on the footer right", function () {
    const buildUi = readFileSync("src/modules/contextPanel/buildUI.ts", "utf8");

    assert.include(
      buildUi,
      "footerControls.append(permissionControl, contextUsageControl)",
    );
    assert.include(buildUi, "statusBar.append(statusLine, footerControls)");
    assert.notInclude(buildUi, "llm-claude-context-gauge");
  });

  it("preserves the committed one-label mode colors without secondary row text", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const buildUi = readFileSync("src/modules/contextPanel/buildUI.ts", "utf8");

    assert.notInclude(css, ".llm-permission-option::before");
    assert.notInclude(css, ".llm-permission-option-selected::before");
    assert.match(
      css,
      /\.llm-permission-option:hover:not\(:disabled\)\s*\{\s*border-color: var\(--stroke-secondary/,
    );
    assert.match(
      css,
      /data-permission-provider="original"\]\[data-selection-key="original:safe"\]:hover:not\([\s\S]{0,40}:disabled[\s\S]{0,40}\)[\s\S]{0,500}#22c55e 14%/,
    );
    assert.match(
      css,
      /data-permission-provider="original"\]\[data-selection-key="original:auto"\]:hover:not\([\s\S]{0,40}:disabled[\s\S]{0,40}\)[\s\S]{0,500}background: var\(--color-accent10/,
    );
    assert.match(
      css,
      /data-permission-provider="original"\]\[data-selection-key="original:yolo"\]:hover:not\([\s\S]{0,40}:disabled[\s\S]{0,40}\)[\s\S]{0,900}#eab308 14%/,
    );
    assert.match(
      css,
      /data-permission-provider="claude"\]\[data-selection-key="claude:acceptEdits"\]:hover:not\([\s\S]{0,40}:disabled[\s\S]{0,40}\)[\s\S]{0,500}#22c55e 14%/,
    );
    assert.match(
      css,
      /data-permission-provider="claude"\]\[data-selection-key="claude:auto"\]:hover:not\([\s\S]{0,40}:disabled[\s\S]{0,40}\)[\s\S]{0,500}background: var\(--color-accent10/,
    );
    assert.match(
      css,
      /data-permission-provider="claude"\]\[data-selection-key="claude:bypassPermissions"\]:hover:not\([\s\S]{0,40}:disabled[\s\S]{0,40}\)[\s\S]{0,500}#eab308 14%/,
    );
    assert.notInclude(css, 'data-selection-key="claude:plan"');
    assert.notInclude(css, 'data-selection-key="claude:dontAsk"');
    assert.notInclude(css, 'data-selection-key="claude:default"');
    assert.notInclude(css, "data-permission-mode");
    assert.notInclude(css, ".llm-permission-option-level");
    const selectedRules = css.match(
      /\.llm-permission-option-selected:not\(:disabled\)\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    assert.notInclude(selectedRules, "background:");
    assert.match(
      css,
      /\.llm-permission-option-selected:not\(:disabled\)\s*\{[\s\S]*?border-color: var\(--color-accent/,
    );
    assert.match(
      css,
      /\.llm-permission-option:focus-visible:not\(:disabled\)\s*\{[\s\S]*?outline: 1px solid var\(--color-accent/,
    );
    assert.match(
      css,
      /\.llm-permission-option:disabled\s*\{[\s\S]*?opacity: 0\.48;[\s\S]*?background: transparent;[\s\S]*?border-color: transparent;/,
    );
    assert.notInclude(css, ".llm-permission-option:disabled::after");
    assert.notInclude(css, 'content: "later"');
    assert.notInclude(
      buildUi,
      'title: option.available ? option.mode : t("Coming later")',
    );
  });

  it("matches the paper picker card geometry with symmetric side spacing", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const controller = readFileSync(
      "src/modules/contextPanel/footerPermissionControl.ts",
      "utf8",
    );

    assert.match(
      css,
      /\.llm-permission-menu\s*\{[\s\S]*?gap: 3px;[\s\S]*?width: max-content;[\s\S]*?min-width: 0;[\s\S]*?padding-block: 6px;[\s\S]*?padding-inline: 6px;[\s\S]*?border-radius: 12px;[\s\S]*?box-shadow: 0 8px 18px rgba\(0, 0, 0, 0\.24\);/,
    );
    assert.match(
      css,
      /\.llm-permission-option\s*\{[\s\S]*?all: unset;[\s\S]*?display: grid;[\s\S]*?grid-template-columns: minmax\(0, 1fr\);[\s\S]*?padding-block: 7px;[\s\S]*?padding-inline: 9px;[\s\S]*?border: 1px solid transparent;[\s\S]*?border-radius: 8px;/,
    );
    assert.match(
      controller,
      /if \(menu\.scrollHeight <= menu\.clientHeight\)\s*(?:\{|)\s*menu\.style\.overflowY = "hidden"/,
    );
  });

  it("centers the menu directly above the permission mode", function () {
    const style: Record<string, string> = {};
    const owner = {
      ownerDocument: {
        defaultView: { innerWidth: 400, innerHeight: 600 },
      },
      getBoundingClientRect: () => ({
        left: 0,
        right: 400,
        top: 0,
        bottom: 600,
        width: 400,
        height: 600,
      }),
    } as unknown as Element;
    const menu = {
      style,
      getBoundingClientRect: () => ({ width: 100, height: 120 }),
    } as unknown as HTMLDivElement;
    const anchor = {
      getBoundingClientRect: () => ({
        left: 260,
        right: 300,
        top: 500,
        bottom: 520,
        width: 40,
        height: 20,
      }),
    } as unknown as HTMLButtonElement;

    positionFloatingMenu(owner, menu, anchor, {
      horizontalAlignment: "center",
      verticalPlacement: "above",
    });

    assert.equal(style.left, "230px");
    assert.equal(style.top, "374px");
  });

  it("pins permission and context controls to the first status line", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");

    assert.match(
      css,
      /\.llm-status-bar\s*\{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto;[\s\S]*?align-items: baseline;/,
    );
    assert.match(
      css,
      /\.llm-status\s*\{[\s\S]*?grid-column: 1;[\s\S]*?grid-row: 1;[\s\S]*?white-space: normal;/,
    );
    assert.match(
      css,
      /\.llm-footer-controls\s*\{[\s\S]*?grid-column: 2;[\s\S]*?grid-row: 1;[\s\S]*?align-self: baseline;/,
    );
  });

  it("keeps the footer visible on a blank conversation and renders a hollow ring", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");

    assert.notInclude(
      css,
      '[data-start-page-active="true"] .llm-status-bar {\n  display: none;',
    );
    assert.match(
      css,
      /\.llm-context-gauge\s*\{[\s\S]*?width: var\(--llm-fs-11\);[\s\S]*?height: var\(--llm-fs-11\);/,
    );
    assert.match(
      css,
      /\.llm-context-gauge::after\s*\{[\s\S]*?inset: calc\(2px \* var\(--llm-font-scale\)\);[\s\S]*?background: var\(--material-sidepane\);/,
    );
    assert.match(
      css,
      /\.llm-status,\s*\.llm-permission-toggle\s*\{[\s\S]*?font-size: var\(--llm-fs-11\);[\s\S]*?line-height: 1\.2;/,
    );
  });
});

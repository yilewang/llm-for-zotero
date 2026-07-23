import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";

const here = dirname(fileURLToPath(import.meta.url));

function readPanelCss(): string {
  return readFileSync(resolve(here, "../addon/content/zoteroPane.css"), "utf8");
}

function readStandaloneWindowSource(): string {
  return readFileSync(
    resolve(here, "../src/modules/contextPanel/standaloneWindow.ts"),
    "utf8",
  );
}

function readBuildUiSource(): string {
  return readFileSync(
    resolve(here, "../src/modules/contextPanel/buildUI.ts"),
    "utf8",
  );
}

function readStandaloneWindowMarkup(): string {
  return readFileSync(
    resolve(here, "../addon/content/standaloneChat.xhtml"),
    "utf8",
  );
}

function readDefaultPrefs(): string {
  return readFileSync(resolve(here, "../addon/prefs.js"), "utf8");
}

function extractCssRule(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`));
  return match?.[0] || "";
}

describe("standalone window layout CSS", function () {
  it("opens standalone chats at the configured default size", function () {
    const markup = readStandaloneWindowMarkup();

    assert.match(markup, /\bwidth="900"/);
    assert.match(markup, /\bheight="900"/);
  });

  it("lets the standalone chat panel widen beyond the default window width", function () {
    const rule = extractCssRule(
      readPanelCss(),
      '[data-standalone="true"].llm-panel',
    );

    assert.isNotEmpty(rule);
    assert.include(rule, "--llm-standalone-chat-max-width");
    assert.include(
      rule,
      "width: min(100%, var(--llm-standalone-chat-max-width))",
    );
    assert.include(
      rule,
      "max-width: min(100%, var(--llm-standalone-chat-max-width))",
    );
    assert.notInclude(rule, "max-width: 820px");
  });

  it("routes standalone chat and typing-box grips through window-aware resizing", function () {
    const css = readPanelCss();
    const buildUi = readBuildUiSource();
    const standaloneWindow = readStandaloneWindowSource();
    const standaloneChatRule = extractCssRule(
      css,
      '[data-standalone="true"] .llm-chat-shell',
    );
    const handleRule = extractCssRule(css, ".llm-standalone-resize-handle");
    const chatHandleRule = extractCssRule(
      css,
      '.llm-standalone-resize-handle[data-resize-target="chat"]',
    );

    assert.include(buildUi, 'chatResizeHandle.dataset.resizeTarget = "chat"');
    assert.include(buildUi, 'inputResizeHandle.dataset.resizeTarget = "input"');
    assert.match(
      standaloneWindow,
      /installStandaloneVerticalResizeBehavior\(\s*newWin,\s*contentArea,/,
    );
    assert.include(handleRule, "position: absolute");
    assert.include(handleRule, "width: 18px");
    assert.include(handleRule, "height: 18px");
    assert.include(standaloneChatRule, "resize: none");
    assert.include(chatHandleRule, "repeating-linear-gradient");
    assert.include(chatHandleRule, "clip-path: polygon");
  });

  it("keeps the standalone content title selectable and copyable", function () {
    const rule = extractCssRule(
      readPanelCss(),
      ".llm-standalone-content-title-text",
    );

    assert.include(rule, "-moz-user-select: text");
    assert.include(rule, "user-select: text");
    assert.include(rule, "cursor: text");
  });

  it("preserves default standalone tab styling and scopes light theme overrides", function () {
    const css = readPanelCss();
    const lightRootRule = extractCssRule(
      css,
      '#llmforzotero-standalone-chat-root[data-standalone-theme="light"]',
    );
    const tabGroupRule = extractCssRule(css, ".llm-standalone-tab-group");
    const activeTabRule = extractCssRule(css, ".llm-standalone-tab.active");

    assert.match(
      lightRootRule,
      /--llm-standalone-tab-track-bg:\s*color-mix\(\s*in srgb,\s*var\(--material-background\) 88%,\s*var\(--fill-primary\) 12%\s*\);/,
    );
    assert.match(
      lightRootRule,
      /--llm-standalone-tab-active-bg:\s*color-mix\(\s*in srgb,\s*var\(--material-background\) 78%,\s*var\(--fill-primary\) 22%\s*\);/,
    );
    assert.include(
      tabGroupRule,
      "background: color-mix(in srgb, var(--material-background) 80%, black 20%)",
    );
    assert.include(activeTabRule, "background: var(--fill-quinary);");
    assert.notInclude(activeTabRule, "background: var(--fill-quaternary);");
    assert.notInclude(activeTabRule, "--fill-quternary");
  });

  it("uses one surface color for the standalone action strip and history pane", function () {
    const css = readPanelCss();
    const rootRule = extractCssRule(css, "#llmforzotero-standalone-chat-root");
    const lightRootRule = extractCssRule(
      css,
      '#llmforzotero-standalone-chat-root[data-standalone-theme="light"]',
    );
    const sidebarRule = extractCssRule(css, ".llm-standalone-sidebar");
    const iconStripRule = extractCssRule(css, ".llm-standalone-icon-strip");
    const historyPanelRule = extractCssRule(
      css,
      ".llm-standalone-sidebar-panel",
    );

    assert.match(
      rootRule,
      /--llm-standalone-sidebar-surface-bg:\s*color-mix\(\s*in srgb,\s*var\(--material-background\) 96%,\s*black 4%\s*\);/,
    );
    assert.match(
      lightRootRule,
      /--llm-standalone-sidebar-surface-bg:\s*color-mix\(\s*in srgb,\s*var\(--material-background\) 90%,\s*var\(--fill-primary\) 10%\s*\);/,
    );
    assert.include(
      sidebarRule,
      "background: var(--llm-standalone-sidebar-surface-bg)",
    );
    assert.include(
      iconStripRule,
      "background: var(--llm-standalone-sidebar-surface-bg)",
    );
    assert.include(
      historyPanelRule,
      "background: var(--llm-standalone-sidebar-surface-bg)",
    );
    assert.notInclude(lightRootRule, "--llm-standalone-sidebar-bg");
    assert.notInclude(lightRootRule, "--llm-standalone-icon-strip-bg");
  });

  it("keeps the full sidebar resize hit target inside the flex layout", function () {
    const css = readPanelCss();
    const handleRule = extractCssRule(css, ".llm-standalone-sidebar-resizer");
    const lineRule = extractCssRule(
      css,
      ".llm-standalone-sidebar-resizer::before",
    );

    assert.include(handleRule, "flex: 0 0 5px");
    assert.include(handleRule, "width: 5px");
    assert.notInclude(handleRule, "margin-left: -2px");
    assert.notInclude(handleRule, "margin-right: -2px");
    assert.include(lineRule, "inset: 0 2px");
  });

  it("makes the standalone History divider adjustable and persistent", function () {
    const css = readPanelCss();
    const source = readStandaloneWindowSource();
    const panelRule = extractCssRule(css, ".llm-standalone-sidebar-panel");
    const resizerRule = extractCssRule(css, ".llm-standalone-sidebar-resizer");
    const activeResizerRule =
      css.match(
        /\.llm-standalone-sidebar-resizer:hover::before,[^{]+\{[^}]*\}/,
      )?.[0] || "";

    assert.include(
      panelRule,
      "width: var(--llm-standalone-sidebar-panel-width, 220px)",
    );
    assert.include(resizerRule, "cursor: col-resize");
    assert.include(
      activeResizerRule,
      "background: var(--stroke-primary, var(--fill-secondary, #7a7a7a))",
    );
    assert.notInclude(activeResizerRule, "--color-accent");
    assert.notInclude(activeResizerRule, "--accent-blue");
    assert.notInclude(activeResizerRule, "box-shadow");
    assert.include(
      source,
      'sidebarResizeHandle.setAttribute("role", "separator")',
    );
    assert.include(
      source,
      'sidebarResizeHandle.setAttribute("aria-orientation", "vertical")',
    );
    assert.include(source, "installStandaloneSidebarResizeBehavior(");
    assert.include(source, "initialWidth: getStandaloneSidebarWidthPref()");
    assert.include(source, "onWidthCommit: setStandaloneSidebarWidthPref");
    assert.include(readDefaultPrefs(), 'pref("standaloneSidebarWidth", 220)');
  });

  it("marks standalone windows with a light or dark theme without changing dark CSS defaults", function () {
    const source = readStandaloneWindowSource();

    assert.include(source, "function isLightStandaloneTheme");
    assert.include(source, "rootEl.dataset.standaloneTheme =");
    assert.include(source, '"light"');
    assert.include(source, '"dark"');
  });

  it("centers tabs in a symmetric grid without overlaying runtime controls", function () {
    const css = readPanelCss();
    const tabRowRule = extractCssRule(css, ".llm-standalone-tab-row");
    const runtimeControlsRule = extractCssRule(
      css,
      ".llm-standalone-runtime-system-controls",
    );
    const tabGroupRule = extractCssRule(css, ".llm-standalone-tab-group");

    assert.include(tabRowRule, "display: grid");
    assert.include(
      tabRowRule,
      "grid-template-columns: 56px minmax(0, 1fr) 56px",
    );
    assert.include(runtimeControlsRule, "grid-column: 1");
    assert.include(runtimeControlsRule, "justify-self: start");
    assert.notInclude(runtimeControlsRule, "position: absolute");
    assert.include(tabGroupRule, "grid-column: 2");
    assert.include(tabGroupRule, "justify-self: center");
    assert.notInclude(css, ".llm-standalone-claude-toggle");
  });
});

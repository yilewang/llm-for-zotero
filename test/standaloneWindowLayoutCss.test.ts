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

function readStandaloneSidebarViewSource(): string {
  return readFileSync(
    resolve(here, "../src/modules/contextPanel/standaloneSidebarView.ts"),
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
  // Anchor on a rule, comment or block boundary. Without it, a selector such
  // as ".llm-standalone-sidebar-header" also matches the tail of a descendant
  // selector that ends with it, and the assertions read the wrong rule.
  const match = css.match(
    new RegExp(`(^|[};/])\\s*${escapedSelector}\\s*\\{[^}]*\\}`),
  );
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

  it("uses one surface color for the unified standalone sidebar", function () {
    const css = readPanelCss();
    const rootRule = extractCssRule(css, "#llmforzotero-standalone-chat-root");
    const lightRootRule = extractCssRule(
      css,
      '#llmforzotero-standalone-chat-root[data-standalone-theme="light"]',
    );
    const sidebarRule = extractCssRule(css, ".llm-standalone-sidebar");
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
      historyPanelRule,
      "background: var(--llm-standalone-sidebar-surface-bg)",
    );
    assert.notInclude(lightRootRule, "--llm-standalone-sidebar-bg");
    assert.notInclude(lightRootRule, "--llm-standalone-icon-strip-bg");
    assert.notInclude(css, ".llm-standalone-icon-strip");
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
    const sidebarViewSource = readStandaloneSidebarViewSource();
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
      sidebarViewSource,
      'resizeHandle.setAttribute("role", "separator")',
    );
    assert.include(
      sidebarViewSource,
      'resizeHandle.setAttribute("aria-orientation", "vertical")',
    );
    assert.include(source, "installStandaloneSidebarResizeBehavior(");
    assert.include(source, "initialWidth: getStandaloneSidebarWidthPref()");
    assert.include(source, "onWidthCommit: setStandaloneSidebarWidthPref");
    assert.include(readDefaultPrefs(), 'pref("standaloneSidebarWidth", 220)');
  });

  it("collapses the unified sidebar out of the layout entirely", function () {
    const css = readPanelCss();
    const sidebarViewSource = readStandaloneSidebarViewSource();
    const collapsedPanelRule =
      css.match(
        /\.llm-standalone-sidebar\[data-sidebar-state="collapsed"\][^{]+\.llm-standalone-sidebar-panel\s*\{[^}]*\}/,
      )?.[0] || "";

    assert.include(collapsedPanelRule, "position: absolute");
    assert.include(css, ".llm-standalone-nav-label");
    assert.notInclude(css, ".llm-standalone-chat-section");
    assert.notInclude(css, ".llm-standalone-chats-header");
    assert.notInclude(sidebarViewSource, '"chats"');
    assert.notInclude(sidebarViewSource, "setStandaloneChatSectionState");
    assert.include(css, "@media (prefers-reduced-motion: reduce)");
    assert.notInclude(css, ".llm-standalone-icon-strip");
    assert.isBelow(
      sidebarViewSource.indexOf('"new-chat"'),
      sidebarViewSource.indexOf('"search-history"'),
    );
    assert.isBelow(
      sidebarViewSource.indexOf('"search-history"'),
      sidebarViewSource.indexOf('"skills"'),
    );
    assert.isBelow(
      sidebarViewSource.indexOf('"skills"'),
      sidebarViewSource.indexOf('"preferences"'),
    );
  });

  it("uses one balanced row grid with narrow Preferences separation", function () {
    const css = readPanelCss();
    const headerRule = extractCssRule(css, ".llm-standalone-sidebar-header");
    const navIconRule = extractCssRule(css, ".llm-standalone-nav-icon");
    const navRowRule = extractCssRule(css, ".llm-standalone-nav-row");
    const footerDividerRule = extractCssRule(
      css,
      ".llm-standalone-footer-divider",
    );
    const preferencesRegionRule = extractCssRule(
      css,
      ".llm-standalone-preferences-region",
    );

    assert.include(headerRule, "padding: 6px 8px");
    assert.include(headerRule, "margin-bottom: 0");
    assert.include(navRowRule, "padding: 0 8px");
    assert.include(navIconRule, "width: 18px");
    assert.include(footerDividerRule, "margin: 2px 12px");
    assert.include(preferencesRegionRule, "padding-bottom: 4px");
  });

  it("drops the library identity styling along with the header label", function () {
    const css = readPanelCss();

    assert.notInclude(css, "llm-standalone-library-identity");
    assert.notInclude(css, "llm-standalone-library-name");
    assert.notInclude(css, "llm-standalone-library-icon");
  });

  it("shares toolbar and title centerlines across the sidebar and content", function () {
    const css = readPanelCss();
    const rootRule = extractCssRule(css, "#llmforzotero-standalone-chat-root");
    const headerRule = extractCssRule(css, ".llm-standalone-sidebar-header");
    const tabRowRule = extractCssRule(css, ".llm-standalone-tab-row");
    const newChatRule = extractCssRule(css, ".llm-standalone-nav-new-chat");
    const titleRule = extractCssRule(css, ".llm-standalone-content-title");

    assert.include(rootRule, "--llm-standalone-toolbar-row-height");
    assert.include(rootRule, "--llm-standalone-title-row-height");
    assert.include(
      headerRule,
      "flex: 0 0 var(--llm-standalone-toolbar-row-height)",
    );
    assert.include(
      tabRowRule,
      "height: var(--llm-standalone-toolbar-row-height)",
    );
    assert.include(headerRule, "box-sizing: border-box");
    assert.include(tabRowRule, "box-sizing: border-box");
    assert.include(
      newChatRule,
      "height: var(--llm-standalone-title-row-height)",
    );
    assert.include(titleRule, "height: var(--llm-standalone-title-row-height)");
  });

  it("aligns control text optically and uses the chat font size throughout the sidebar", function () {
    const css = readPanelCss();
    const rootRule = extractCssRule(css, "#llmforzotero-standalone-chat-root");
    const navRowRule = extractCssRule(css, ".llm-standalone-nav-row");
    const conversationRule = extractCssRule(css, ".llm-standalone-conv-item");
    const tabRule = extractCssRule(css, ".llm-standalone-tab");
    const titleRule = extractCssRule(css, ".llm-standalone-content-title");

    assert.include(rootRule, "--llm-standalone-ui-font-size: var(--llm-fs-12)");
    assert.include(rootRule, "--llm-standalone-ui-line-height");
    for (const rule of [navRowRule, conversationRule, tabRule, titleRule]) {
      assert.include(rule, "font-size: var(--llm-standalone-ui-font-size)");
      assert.include(rule, "line-height: var(--llm-standalone-ui-line-height)");
    }
    assert.include(navRowRule, "padding: 0 8px");
    assert.include(tabRule, "appearance: none");
    assert.include(tabRule, "-moz-appearance: none");
    assert.include(
      tabRule,
      "padding: 0 calc(2px + 2 * var(--llm-standalone-chrome-gap))",
    );
    assert.include(titleRule, "padding: 0 10px 0 16px");
    assert.notInclude(titleRule, "border-bottom");
    assert.include(titleRule, "box-shadow: inset 0 -1px");
  });

  it("keeps Export and Delete in the standalone content title actions", function () {
    const source = readStandaloneWindowSource();

    assert.match(
      source,
      /contentTitleBarSpacer\.append\(iconExport, iconClear\)/,
    );
    assert.include(
      source,
      '"llm-standalone-title-action llm-standalone-icon-export"',
    );
    assert.include(
      source,
      '"llm-standalone-title-action llm-standalone-icon-clear"',
    );
    assert.include(
      source,
      'iconClear.classList.toggle("llm-standalone-icon-exit"',
    );

    const actionsRule = extractCssRule(
      readPanelCss(),
      ".llm-standalone-content-title-actions",
    );
    assert.include(
      actionsRule,
      "gap: calc(var(--llm-standalone-chrome-gap) / 2)",
    );
    assert.match(
      readPanelCss(),
      /\.llm-standalone-title-action\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;/,
    );
  });

  it("keeps conversation rows and their rename and delete actions keyboard accessible", function () {
    const source = readStandaloneWindowSource();

    assert.include(source, 'btn.setAttribute("role", "button")');
    assert.include(source, "btn.tabIndex = 0");
    assert.match(
      source,
      /createElementNS\(\s*HTML_NS,\s*"button",\s*\) as HTMLButtonElement;\s*renameBtn\.className = "llm-standalone-conv-rename"/,
    );
    assert.include(source, 'sidebarList.addEventListener("keydown"');
    assert.include(source, 'event.key !== "Enter" && event.key !== " "');
  });

  it("clips long standalone conversation titles without rendering ellipses", function () {
    const titleRule = extractCssRule(
      readPanelCss(),
      ".llm-standalone-conv-title",
    );

    assert.include(titleRule, "white-space: nowrap");
    assert.include(titleRule, "overflow: hidden");
    assert.include(titleRule, "text-overflow: clip");
    assert.notInclude(titleRule, "text-overflow: ellipsis");
  });

  it("spaces chronological history groups like relaxed sidebar sections", function () {
    const css = readPanelCss();
    const rootRule = extractCssRule(css, "#llmforzotero-standalone-chat-root");
    const dayLabelRule = extractCssRule(css, ".llm-standalone-day-label");
    const conversationRule = extractCssRule(css, ".llm-standalone-conv-item");

    assert.include(
      rootRule,
      "--llm-standalone-item-row-height: max(\n    38px,",
    );
    assert.include(dayLabelRule, "padding: 14px 10px 6px");
    assert.include(conversationRule, "padding: 0 10px");
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
    const leadingRule = extractCssRule(css, ".llm-standalone-tab-row-leading");
    const tabGroupRule = extractCssRule(css, ".llm-standalone-tab-group");

    assert.include(tabRowRule, "display: grid");
    assert.include(
      tabRowRule,
      "grid-template-columns: minmax(max-content, 1fr) max-content minmax(0, 1fr)",
    );
    assert.include(leadingRule, "grid-column: 1");
    assert.include(leadingRule, "justify-self: start");
    assert.notInclude(leadingRule, "position: absolute");
    assert.include(tabGroupRule, "grid-column: 2");
    assert.include(tabGroupRule, "justify-self: center");
    assert.notInclude(css, ".llm-standalone-claude-toggle");
  });

  it("grows the document title row with the font scale instead of clipping descenders", function () {
    const css = readPanelCss();
    const titleRule = extractCssRule(css, ".llm-standalone-content-title");

    // The row and its text both use the shared scale-aware tokens. A fixed
    // line-height would let scaled glyphs outgrow the clipped title span and
    // slice off descenders.
    assert.include(titleRule, "font-size: var(--llm-standalone-ui-font-size)");
    assert.include(
      titleRule,
      "line-height: var(--llm-standalone-ui-line-height)",
    );
    assert.notInclude(titleRule, "line-height: 20px;");
  });
});

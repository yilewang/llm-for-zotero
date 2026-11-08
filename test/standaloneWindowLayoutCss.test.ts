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

function readStandaloneWindowMarkup(): string {
  return readFileSync(
    resolve(here, "../addon/content/standaloneChat.xhtml"),
    "utf8",
  );
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

  it("keeps the standalone content title selectable and copyable", function () {
    const rule = extractCssRule(
      readPanelCss(),
      ".llm-standalone-content-title-text",
    );

    assert.include(rule, "-moz-user-select: text");
    assert.include(rule, "user-select: text");
    assert.include(rule, "cursor: text");
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
    assert.notInclude(sidebarViewSource, '"chats"');
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
    // Prettier wraps the long template; compare it without the wrap spaces.
    // The trailing track keeps its content's width for the side panel toggle.
    assert.include(
      tabRowRule.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")"),
      "grid-template-columns: minmax(max-content, 1fr) max-content minmax(max-content, 1fr)",
    );
    const trailingRule = extractCssRule(
      css,
      ".llm-standalone-tab-row-trailing",
    );
    assert.include(trailingRule, "grid-column: 3");
    assert.include(trailingRule, "justify-self: end");
    assert.include(leadingRule, "grid-column: 1");
    assert.include(leadingRule, "justify-self: start");
    assert.notInclude(leadingRule, "position: absolute");
    assert.include(tabGroupRule, "grid-column: 2");
    assert.include(tabGroupRule, "justify-self: center");
    assert.notInclude(css, ".llm-standalone-claude-toggle");
  });
});

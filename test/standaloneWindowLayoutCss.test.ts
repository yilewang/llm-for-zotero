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

function extractCssRule(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`));
  return match?.[0] || "";
}

describe("standalone window layout CSS", function () {
  it("mounts the standalone transcript with the shared modern chat surface", function () {
    const source = readStandaloneWindowSource();
    const css = readPanelCss();

    assert.include(source, '"llm-standalone-content llm-modern-chat-pane"');
    assert.include(
      css,
      ".llm-standalone-content.llm-modern-chat-pane .llm-header",
    );
    assert.include(
      css,
      ".llm-standalone-content.llm-modern-chat-pane > .llm-panel",
    );
    assert.match(
      css,
      /\.llm-modern-chat-pane \.llm-chat-shell,[\s\S]*?\.llm-modern-chat-pane \.llm-input \{[\s\S]*?resize: none;/,
    );
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

  it("preserves default standalone sidebar styling and scopes light theme overrides", function () {
    const css = readPanelCss();
    const lightRootRule = extractCssRule(
      css,
      '#llmforzotero-standalone-chat-root[data-standalone-theme="light"]',
    );
    const sidebarRule = extractCssRule(css, ".llm-standalone-sidebar");
    const iconStripRule = extractCssRule(css, ".llm-standalone-icon-strip");

    assert.match(
      lightRootRule,
      /--llm-standalone-sidebar-bg:\s*color-mix\(\s*in srgb,\s*var\(--material-background\) 92%,\s*var\(--fill-primary\) 8%\s*\);/,
    );
    assert.match(
      lightRootRule,
      /--llm-standalone-icon-strip-bg:\s*color-mix\(\s*in srgb,\s*var\(--material-background\) 90%,\s*var\(--fill-primary\) 10%\s*\);/,
    );
    assert.include(sidebarRule, "background: var(--llm-standalone-sidebar-bg)");
    assert.include(
      iconStripRule,
      "background: var(--llm-standalone-icon-strip-bg)",
    );
    const activeConversationRule = extractCssRule(
      css,
      ".llm-standalone-conv-item.active",
    );
    assert.include(activeConversationRule, "background: var(--fill-quinary)");
    assert.include(activeConversationRule, "color: var(--fill-primary)");
  });

  it("uses a lighter sidebar surface and a compact document title bar", function () {
    const css = readPanelCss();
    const rootRule = extractCssRule(css, "#llmforzotero-standalone-chat-root");
    const titleRule = extractCssRule(css, ".llm-standalone-content-title");
    const titleIconRule = extractCssRule(
      css,
      ".llm-standalone-content-title-text::before",
    );

    assert.include(rootRule, "--llm-standalone-sidebar-bg: color-mix(");
    assert.include(rootRule, "var(--material-background) 92%");
    assert.include(rootRule, "var(--fill-primary) 8%");
    assert.include(titleRule, "min-height: 32px");
    assert.include(titleRule, "font-size: var(--llm-fs-11)");
    assert.include(titleRule, "color: var(--fill-secondary)");
    assert.include(titleRule, "background: var(--material-background)");
    assert.include(titleIconRule, 'url("icons/action-paper.svg")');
  });

  it("marks standalone windows with a light or dark theme without changing dark CSS defaults", function () {
    const source = readStandaloneWindowSource();

    assert.include(source, "function isLightStandaloneTheme");
    assert.include(source, "rootEl.dataset.standaloneTheme =");
    assert.include(source, '"light"');
    assert.include(source, '"dark"');
  });
});

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

/**
 * Matches a rule by its selector without depending on how Prettier wrapped the
 * selector list across lines.
 */
function extractCssRule(css: string, selector: string): string {
  const flat = css.replace(/\s+/g, " ");
  const escapedSelector = selector
    .replace(/\s+/g, " ")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Anchor on a rule, comment or block boundary so a selector is never matched
  // as the tail of a longer one.
  const match = flat.match(
    new RegExp(`(^|[};/]) ?${escapedSelector} \\{[^}]*\\}`),
  );
  return match?.[0] || "";
}

describe("standalone custom title bar CSS", function () {
  it("hands the native traffic lights their own reserved box", function () {
    const css = readPanelCss();
    const base = extractCssRule(css, ".llm-window-buttons");
    const active = extractCssRule(
      css,
      ":root[customtitlebar] .llm-window-buttons",
    );

    // Without the attribute the placeholder must not reserve any space, so
    // Windows and Linux keep the layout they have today.
    assert.include(base, "display: none");
    assert.include(active, "appearance: -moz-window-button-box");
    assert.include(active, "-moz-appearance: -moz-window-button-box");
    assert.include(active, "width: 52px");
    assert.include(active, "margin-inline-start: 12px");
  });

  it("makes the two top rows drag the window without swallowing their controls", function () {
    const css = readPanelCss();
    const dragRule = extractCssRule(
      css,
      ":root[customtitlebar] .llm-standalone-sidebar-header,\n:root[customtitlebar] .llm-standalone-tab-row",
    );
    const noDragRule = extractCssRule(
      css,
      ":root[customtitlebar] .llm-standalone-nav-toggle,\n:root[customtitlebar] .llm-standalone-tab-group,\n:root[customtitlebar] .llm-standalone-runtime-system-controls",
    );

    assert.include(dragRule, "-moz-window-dragging: drag");
    assert.include(noDragRule, "-moz-window-dragging: no-drag");
  });

  it("floats the sidebar back over the content while the flyout is open", function () {
    const css = readPanelCss();
    const openFlyout = extractCssRule(
      css,
      '.llm-standalone-sidebar[data-sidebar-state="collapsed"][data-sidebar-flyout="open"] .llm-standalone-sidebar-panel',
    );

    assert.include(openFlyout, "transform: translateX(0)");
    assert.include(openFlyout, "pointer-events: auto");
    assert.include(openFlyout, "opacity: 1");
    assert.include(openFlyout, "visibility: visible");
  });

  it("keeps the header space so the flyout surface reaches behind the window controls", function () {
    const css = readPanelCss();
    const collapsedHeader = extractCssRule(
      css,
      '.llm-standalone-sidebar[data-sidebar-state="collapsed"] .llm-standalone-sidebar-header',
    );

    assert.equal(collapsedHeader, "");
    const leading = extractCssRule(css, ".llm-standalone-tab-row-leading");
    assert.include(leading, "position: relative");
    assert.include(leading, "z-index: 21");
  });

  it("keeps expanded content styling in the hover sidebar", function () {
    const css = readPanelCss();
    for (const content of [
      ".llm-standalone-nav-row",
      ".llm-standalone-nav-label",
      ".llm-standalone-history-region",
      ".llm-standalone-primary-action-group",
      ".llm-standalone-nav-aux-action",
    ]) {
      assert.equal(
        extractCssRule(
          css,
          `.llm-standalone-sidebar[data-sidebar-state="collapsed"] ${content}`,
        ),
        "",
        `${content} must use the same layout in the flyout`,
      );
    }
  });

  it("reserves the controls while centering tabs when space permits", function () {
    const css = readPanelCss();
    const tabRow = extractCssRule(css, ".llm-standalone-tab-row");

    // The leading slot holds a different set of controls in each state, so a
    // fixed side column would shift the tabs whenever the sidebar collapses.
    // The trailing track keeps the side panel toggle's width; Prettier
    // wraps the template, so compare it without the wrap spaces.
    assert.include(
      tabRow.replace(/\( /g, "(").replace(/ \)/g, ")"),
      "grid-template-columns: minmax(max-content, 1fr) max-content minmax(max-content, 1fr)",
    );
  });

  it("wires the collapsed chrome host and the hover flyout", function () {
    const source = readStandaloneWindowSource();

    assert.include(source, "setStandaloneSidebarCollapsedChromeHost");
    assert.include(source, "installStandaloneSidebarFlyout");
    assert.notInclude(source, "setStandaloneSidebarLibraryName");
    assert.notInclude(source, "syncStandaloneLibraryName");
  });
});

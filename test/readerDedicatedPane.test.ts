import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { describe, it } from "mocha";

const here = dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(resolve(here, relativePath), "utf8");
}

describe("reader dedicated AI pane", function () {
  it("mounts beside Zotero item and notes decks", function () {
    const source = readSource(
      "../src/modules/contextPanel/readerDedicatedPane.ts",
    );
    assert.include(source, '"zotero-context-pane-deck"');
    assert.include(source, '"zotero-context-pane-item-deck"');
    assert.include(source, '"zotero-context-pane-sidenav"');
    assert.include(source, 'doc.createXULElement("vbox")');
    assert.include(source, "deck.appendChild(createdDeckPanel)");
    assert.include(source, "deckPanel.appendChild(createdHost)");
  });

  it("intercepts the registered section icon and preserves other sidenav routes", function () {
    const source = readSource(
      "../src/modules/contextPanel/readerDedicatedPane.ts",
    );
    assert.include(source, "button.dataset.pane === state.paneID");
    assert.include(source, "activateReaderDedicatedPane(state)");
    assert.include(source, "restoreReaderItemPane(state)");
  });

  it("keeps the library section behavior while redirecting reader rendering", function () {
    const source = readSource("../src/modules/contextPanel/index.ts");
    assert.include(source, "resolveReaderDedicatedPanelBody");
    assert.include(source, "tabType");
    assert.include(source, "registeredReaderContextPaneID");
  });

  it("uses a compact theme-aware AI icon in the Zotero sidenav", function () {
    const source = readSource("../src/modules/contextPanel/index.ts");
    const lightIcon = readSource("../addon/content/icons/sidebar-ai.svg");
    const attribution = readSource("../addon/content/icons/README.md");

    assert.include(source, "content/icons/sidebar-ai.svg");
    assert.notInclude(source, "content/icons/sidebar-ai-dark.svg");
    assert.include(lightIcon, 'viewBox="0 0 16 16"');
    assert.include(lightIcon, 'fill="context-fill"');
    assert.include(attribution, "microsoft/vscode-codicons");
    assert.include(attribution, "CC BY 4.0");
    assert.notInclude(lightIcon.toLowerCase(), "brain");
  });

  it("uses neutral outline and terminal-cutout Codex toggle states", function () {
    const styles = readSource("../addon/content/zoteroPane.css");
    const handlers = readSource("../src/modules/contextPanel/setupHandlers.ts");
    const outlineIcon = readSource(
      "../addon/content/icons/codex-app-server.svg",
    );
    const solidIcon = readSource("../addon/content/icons/codex-logo.svg");
    const attribution = readSource("../addon/content/icons/README.md");

    assert.include(outlineIcon, 'fill="none"');
    assert.include(outlineIcon, 'stroke="#000"');
    assert.include(solidIcon, 'fill-rule="evenodd"');
    assert.include(solidIcon, 'viewBox="0 0 24 24"');
    assert.include(solidIcon, "Codex (OpenAI)");
    assert.notInclude(solidIcon, "linearGradient");
    assert.include(attribution, "glincker/thesvg");
    assert.include(styles, 'mask-image: url("icons/codex-logo.svg")');
    assert.notInclude(styles, 'background-image: url("icons/codex-logo.svg")');
    assert.include(styles, ".llm-runtime-system-toggle--codex");
    assert.include(handlers, "panelRuntimeSystemControls");
    assert.include(handlers, "syncRuntimeSystemControls");
  });

  it("stretches the dedicated reader chat root to the bottom of its host", function () {
    const paneSource = readSource(
      "../src/modules/contextPanel/readerDedicatedPane.ts",
    );
    const buildSource = readSource("../src/modules/contextPanel/buildUI.ts");
    assert.include(paneSource, 'height: "100%"');
    assert.include(paneSource, 'flex: "1 1 auto"');
    assert.include(buildSource, '"llm-dedicated-ai-pane"');
    assert.notInclude(
      buildSource,
      'hostBody.classList.contains("llm-reader-ai-pane")',
    );
  });

  it("records the reader tab that owns the dedicated chat pane", function () {
    const paneSource = readSource(
      "../src/modules/contextPanel/readerDedicatedPane.ts",
    );

    assert.include(
      paneSource,
      "state.host.dataset.llmReaderTabId = sourceTabID || selectedTabID",
    );
  });

  it("uses window-responsive sizing without Reader resize handles", function () {
    const styles = readSource("../addon/content/zoteroPane.css");
    assert.match(
      styles,
      /\.llm-dedicated-ai-pane \.llm-chat-shell \{[\s\S]*?flex: 1 1 0;[\s\S]*?height: auto;[\s\S]*?min-height: 0;[\s\S]*?max-height: none;[\s\S]*?resize: none;/,
    );
    assert.match(
      styles,
      /\.llm-modern-chat-pane \.llm-chat-shell,[\s\S]*?\.llm-modern-chat-pane \.llm-input \{[\s\S]*?resize: none;/,
    );
    assert.match(
      styles,
      /\.llm-modern-chat-pane \.llm-input \{[\s\S]*?max-height: 30vh;/,
    );
  });

  it("matches Zotero Reader toolbar button dimensions and theme states", function () {
    const styles = readSource("../addon/content/zoteroPane.css");
    assert.match(
      styles,
      /\.llm-modern-chat-pane \.llm-header \{[\s\S]*?box-sizing: border-box;[\s\S]*?height: 41px;[\s\S]*?min-height: 41px;[\s\S]*?border-bottom: var\(--material-panedivider\);[\s\S]*?background: var\(--material-toolbar\);/,
    );
    assert.match(
      styles,
      /\.llm-modern-chat-pane \.llm-header-top \{[\s\S]*?height: 40px;[\s\S]*?min-height: 40px;/,
    );
    assert.match(
      styles,
      /\.llm-modern-chat-pane \.llm-header button \{[\s\S]*?height: 28px;[\s\S]*?border-radius: 5px;[\s\S]*?color: var\(--fill-secondary\);/,
    );
    assert.include(styles, "background: var(--fill-quinary);");
    assert.include(styles, "background: var(--fill-quarternary);");
    assert.include(styles, "border: var(--material-border-quinary);");
  });

  it("uses a darker reading surface and native composer controls", function () {
    const styles = readSource("../addon/content/zoteroPane.css");

    assert.match(
      styles,
      /\.llm-modern-chat-pane > \.llm-panel \{[\s\S]*?background: var\(--material-background\);/,
    );
    assert.match(
      styles,
      /\.llm-modern-chat-pane \.llm-input-section \{[\s\S]*?border: var\(--material-border-quinary\);[\s\S]*?background: color-mix\([\s\S]*?var\(--material-toolbar\) 96%,[\s\S]*?var\(--fill-primary\) 4%[\s\S]*?box-shadow: none;/,
    );
    assert.match(
      styles,
      /\.llm-modern-chat-pane \.llm-input:focus,[\s\S]*?outline: none !important;[\s\S]*?box-shadow: none !important;/,
    );
    assert.match(
      styles,
      /\.llm-modern-chat-pane \.llm-actions \{[\s\S]*?--llm-action-height: 28px;[\s\S]*?--llm-action-icon-size: 16px;/,
    );
    assert.match(
      styles,
      /\.llm-modern-chat-pane \.llm-status-ready \{[\s\S]*?color: var\(--fill-tertiary\);/,
    );
  });

  it("keeps composer icon actions square", function () {
    const styles = readSource("../addon/content/zoteroPane.css");

    assert.include(styles, ".llm-select-text-btn.llm-action-icon-only");
    assert.include(styles, ".llm-screenshot-btn.llm-action-icon-only");
    assert.include(styles, "flex: 0 0 28px");
    assert.include(styles, "width: 28px");
    assert.include(styles, "min-width: 28px");
  });

  it("gives the primary send action a high-contrast surface", function () {
    const styles = readSource("../addon/content/zoteroPane.css");

    assert.include(styles, ".llm-send-btn:not(.llm-cancel-btn)");
    assert.include(
      styles,
      "background: color-mix(in srgb, var(--fill-primary) 84%, transparent)",
    );
    assert.include(styles, "color: var(--material-background)");
    assert.include(styles, "opacity: 0.78");
  });

  it("renders the permanent paper source first as a compact format control", function () {
    const handlers = readSource("../src/modules/contextPanel/setupHandlers.ts");
    const contextResolution = readSource(
      "../src/modules/contextPanel/contextResolution.ts",
    );
    const styles = readSource("../addon/content/zoteroPane.css");

    assert.include(
      handlers,
      'getContextSourceModeBadgeLabel(contentSourceMode) || "Text"',
    );
    assert.include(styles, ".llm-paper-context-chip-autoloaded");
    assert.include(styles, "order: -100");
    assert.include(contextResolution, "Quote · ${pageLabel.replace");
    assert.include(styles, "opacity: 0");
    assert.include(styles, ".llm-selected-context-header:hover");
  });

  it("keeps the streaming stop action prominent and uses a square glyph", function () {
    const styles = readSource("../addon/content/zoteroPane.css");
    const actionLayoutSource = readSource(
      "../src/modules/contextPanel/setupHandlers/controllers/actionLayoutController.ts",
    );
    const stopIcon = readSource("../addon/content/icons/action-stop.svg");

    assert.include(styles, ".llm-actions .llm-cancel-btn");
    assert.include(styles, 'mask: url("icons/action-stop.svg")');
    assert.include(stopIcon, '<rect x="4" y="4" width="8" height="8"');
    assert.include(
      actionLayoutSource,
      'setActionButtonLabel(cancelBtn, "Cancel", "", mode)',
    );
    assert.notInclude(
      actionLayoutSource,
      'setActionButtonLabel(cancelBtn, "Cancel", "X", mode)',
    );
  });

  it("uses Codex-style assistant chrome without an avatar or model heading", function () {
    const styles = readSource("../addon/content/zoteroPane.css");
    const traceSource = readSource(
      "../src/modules/contextPanel/agentTrace/render.ts",
    );

    assert.include(styles, ".llm-modern-chat-pane .llm-model-header::before");
    assert.match(
      styles,
      /\.llm-modern-chat-pane \.llm-model-header::before,[\s\S]*?\.llm-modern-chat-pane \.llm-model-name \{[\s\S]*?display: none;/,
    );
    assert.include(styles, ".llm-agent-activity-summary::after");
    assert.include(traceSource, "summary.textContent = working");
    assert.include(traceSource, "Worked for ${formatAgentActivityDuration");
  });

  it("groups Reader actions and input into a cohesive composer dock", function () {
    const buildSource = readSource("../src/modules/contextPanel/buildUI.ts");
    const actionLayoutSource = readSource(
      "../src/modules/contextPanel/setupHandlers/controllers/actionLayoutController.ts",
    );
    const styles = readSource("../addon/content/zoteroPane.css");
    const i18nSource = readSource("../src/utils/i18n.ts");

    assert.include(buildSource, 'container.dataset.uiLayout = "reader-chat"');
    assert.include(buildSource, '"llm-reader-composer-dock"');
    assert.include(
      buildSource,
      "composerDock.append(shortcutsRow, inputSection, statusBar)",
    );
    assert.include(styles, ".llm-modern-chat-pane .llm-reader-composer-dock");
    assert.include(
      styles,
      '#llm-runtime-mode-toggle.llm-runtime-mode-static[data-system="codex"]',
    );
    assert.include(
      actionLayoutSource,
      'body.classList.contains("llm-modern-chat-pane")',
    );
    assert.include(i18nSource, "llm-paper-start-page");
    assert.include(i18nSource, "llm-start-page-mark");
  });

  it("uses an intact neutral surface for inline prompt editing", function () {
    const styles = readSource("../addon/content/zoteroPane.css");

    assert.match(
      styles,
      /\.llm-inline-edit-wrapper \{[\s\S]*?border: var\(--material-border-quinary\);[\s\S]*?border-radius: 8px;/,
    );
    assert.match(
      styles,
      /\.llm-inline-edit-header-label \{[\s\S]*?color: var\(--fill-secondary\);/,
    );
    assert.match(
      styles,
      /\.llm-inline-edit-wrapper > \.llm-input-section \{[\s\S]*?border-radius: 0 0 7px 7px;[\s\S]*?background: transparent;[\s\S]*?background-clip: padding-box;/,
    );
  });

  it("shares the modern chat layout with the My Library item pane", function () {
    const paneSource = readSource(
      "../src/modules/contextPanel/readerDedicatedPane.ts",
    );
    const buildSource = readSource("../src/modules/contextPanel/buildUI.ts");

    assert.include(
      paneSource,
      'const LIBRARY_ITEM_DECK_ID = "zotero-item-pane-content"',
    );
    assert.include(
      paneSource,
      'const LIBRARY_ITEM_DETAILS_ID = "zotero-item-details"',
    );
    assert.include(
      paneSource,
      'const LIBRARY_SIDENAV_ID = "zotero-view-item-sidenav"',
    );
    assert.include(paneSource, "registerLibraryDedicatedPane(win, paneID)");
    assert.include(
      paneSource,
      "return libraryDedicatedPaneStates.get(win)?.host || sectionBody",
    );
    assert.include(
      paneSource,
      '"llm-library-ai-pane llm-dedicated-ai-pane llm-modern-chat-pane"',
    );
    assert.include(
      buildSource,
      'body.classList.contains("llm-modern-chat-pane")',
    );
    assert.include(buildSource, "if (usesModernChatLayout) {");
  });
});

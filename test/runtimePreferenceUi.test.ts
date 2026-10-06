import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "mocha";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

describe("runtime preference UI", function () {
  it("keeps long notes-directory summaries on one line with an ellipsis", function () {
    const css = source("addon/content/preferences.xhtml").replace(/\s+/g, " ");
    const rule =
      css.match(/\[data-llm-row-summary="notes"\] \{([^}]*)\}/)?.[1] || "";
    for (const declaration of [
      "min-width: 0",
      "white-space: nowrap",
      "overflow: hidden",
      "text-overflow: ellipsis",
    ]) {
      assert.include(rule, declaration);
    }
  });

  it("wraps multi-sentence Codex and Zotero MCP connection errors", function () {
    const preferences = source("addon/content/preferences.xhtml");
    for (const id of [
      "__addonRef__-codex-app-server-status",
      "__addonRef__-codex-app-server-mcp-status",
    ]) {
      const statusElement =
        preferences.match(
          new RegExp(`id="${id}"[\\s\\S]*?<\\/html:span>`),
        )?.[0] || "";
      assert.include(statusElement, "overflow-wrap: anywhere");
      assert.include(statusElement, "min-width: 0");
    }
  });

  it("uses the same dynamic Claude catalog path for embedded and standalone panels", function () {
    const setupHandlers = source("src/modules/contextPanel/setupHandlers.ts");
    const embeddedPanel = source("src/modules/contextPanel/index.ts");
    const standalonePanel = source(
      "src/modules/contextPanel/standaloneWindow.ts",
    );

    assert.include(setupHandlers, "buildClaudeRuntimeModelEntries");
    assert.include(setupHandlers, "ensureClaudeModelCatalogLoaded");
    assert.include(
      setupHandlers,
      "listClaudeModels(coreRuntime, force, context)",
    );
    assert.include(setupHandlers, "resolveClaudeModelCatalogContext");
    const openModelMenuBlock =
      setupHandlers.match(
        /\n {2}openModelMenu = \(\) => \{[\s\S]*?\n {2}\};/,
      )?.[0] ?? "";
    assert.include(openModelMenuBlock, "isClaudeConversationSystem()");
    // Force-refresh on user-initiated open: the catalog cache identity cannot
    // see in-place ~/.claude/settings.json profile changes (issue #335), and
    // the call is non-blocking — the menu opens on the cached list and
    // live-updates. (This deliberately reverses an earlier review round that
    // leaned on the 60s TTL alone; see test/claudeModelMenuRefresh.test.ts.)
    assert.include(openModelMenuBlock, "ensureClaudeModelCatalogLoaded(true)");
    // In-flight dedupe must engage for forced opens too: rapid re-opens
    // piggyback on the running forced fetch instead of launching another,
    // while an unforced in-flight load never satisfies a forced request.
    assert.include(setupHandlers, "claudeModelCatalogInFlight &&");
    assert.include(
      setupHandlers,
      "(!force || claudeModelCatalogInFlightForced)",
    );
    assert.include(embeddedPanel, "setupHandlers(body, rawItem)");
    const embeddedRebuild =
      embeddedPanel.match(
        /mountPanelShell\(\{\s*body,[\s\S]*?\n {4}\}\);/,
      )?.[0] ?? "";
    assert.include(embeddedRebuild, "setupItem: rawItem,");
    // The standalone panel mounts through the shared shell, which hands its
    // setup item to the same setupHandlers.
    const standaloneMount =
      standalonePanel.match(
        /mountPanelShell\(\{\s*body: contentArea,[\s\S]*?\n {10}\}\);/,
      )?.[0] ?? "";
    assert.include(standaloneMount, "setupItem: mountedItem,");
    const panelMount = source("src/modules/contextPanel/panelMount.ts");
    assert.include(
      panelMount,
      'import { setupHandlers, type SetupHandlersHooks } from "./setupHandlers";',
    );
    assert.include(
      panelMount,
      "deps.setupHandlers(body, mount.setupItem, mount.hooks);",
    );
  });

  it("keeps an expanded runtime row's border identical to a collapsed one", function () {
    const css = source("addon/content/preferences.xhtml").replace(/\s+/g, " ");

    // The neutral card border is the only border the row ever draws; expanding
    // must not repaint it in the accent colour.
    assert.include(
      css,
      ".llm-pref-panel .llm-pref-row { border: 1px solid var(--llm-pref-stroke);",
    );
    assert.notMatch(
      css,
      /\.llm-pref-row\[data-open="true"\] \{[^}]*border-color/,
    );

    // Guard against a vacuous pass: the chevron rotation is the affordance that
    // still has to signal the open state.
    assert.include(
      css,
      '.llm-pref-row[data-open="true"] .llm-pref-row-chevron { transform: rotate(90deg); }',
    );
  });
});

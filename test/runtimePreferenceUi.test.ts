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
  it("allows Codex and Claude Code availability to coexist", function () {
    const preferenceScript = source("src/modules/preferenceScript.ts");
    const preferences = source("addon/content/preferences.xhtml");

    assert.notInclude(preferenceScript, "syncModeMutualExclusion");
    assert.notInclude(
      preferenceScript,
      "Disable Codex App Server first to switch on Claude Code.",
    );
    assert.notInclude(
      preferenceScript,
      "Disable Claude Code first to switch on Codex App Server.",
    );
    assert.include(
      preferenceScript,
      "applyCodexAppServerModePreferenceChange(enabled)",
    );
    assert.include(
      preferences,
      "Codex and Claude Code can both be enabled; only the selected",
    );
  });

  it("uses a responsive live-catalog model list with a separate Customized value", function () {
    const preferenceScript = source("src/modules/preferenceScript.ts");
    const preferences = source("addon/content/preferences.xhtml");

    assert.include(
      preferences,
      '<html:select\n                      id="__addonRef__-claude-code-model"',
    );
    assert.include(preferences, 'value="customized">Customized');
    assert.include(preferences, 'id="__addonRef__-claude-code-custom-model"');
    assert.include(preferences, 'id="__addonRef__-claude-code-model-refresh"');
    assert.include(preferences, "alias, exact model ID");
    assert.notInclude(preferences, '<html:option value="opus">');
    assert.notInclude(preferences, "claude-code-model-options");
    assert.include(preferences, "minmax(min(220px, 100%), 1fr)");
    assert.include(preferences, "box-sizing: border-box");
    assert.include(preferenceScript, "fetchClaudeModelCatalog");
    assert.include(preferenceScript, "buildClaudeModelPreferenceOptions");
    assert.include(preferenceScript, "CLAUDE_CUSTOMIZED_MODEL_OPTION_KEY");
    assert.include(preferenceScript, "getClaudeSettingSourcesByPref");
    assert.include(
      preferenceScript,
      "setClaudeRuntimeModelPref(selected.model)",
    );
    assert.include(preferenceScript, "setClaudeRuntimeModelPref(model)");
    assert.include(preferenceScript, "refreshClaudeModelSuggestions(true)");
    assert.include(preferenceScript, "shouldPreserveClaudeCustomModelDraft");
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
    assert.include(standalonePanel, "setupHandlers(contentArea, mountedItem");
  });
});

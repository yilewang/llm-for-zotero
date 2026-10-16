import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "mocha";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

/**
 * The Agent tab used to stack three full-height runtime cards, each with its
 * own nesting depth, its own enable widget (one checkbox and two Off/On
 * selects), and its own field order. These assertions pin the shape that
 * replaced it: one collapsible row per subject, one switch idiom, one label
 * column, and detail folded into a per-row advanced drawer.
 */
function agentPanel(): string {
  const markup = source("addon/content/preferences.xhtml");
  const start = markup.indexOf('data-pref-panel="agent"');
  const end = markup.indexOf('data-pref-panel="mineru"');
  assert.isAtLeast(start, 0, "agent panel is present");
  assert.isAbove(end, start, "agent panel precedes the MinerU panel");
  return markup.slice(start, end);
}

function elementById(markup: string, id: string): string {
  const start = markup.indexOf(`id="${id}"`);
  assert.isAtLeast(start, 0, `${id} is present`);
  const openingTag = markup.lastIndexOf("<", start);
  const closingTag = markup.indexOf(">", start);
  assert.isAbove(closingTag, openingTag, `${id} has a complete opening tag`);
  return markup.slice(openingTag, closingTag + 1);
}

describe("Agent preference tab layout", function () {
  it("presents every group as one collapsible row", function () {
    const panel = agentPanel();
    const rows = panel.match(/data-llm-agent-row="[a-z-]+"/g) || [];
    assert.deepEqual(rows, [
      'data-llm-agent-row="original"',
      'data-llm-agent-row="codex"',
      'data-llm-agent-row="acp"',
      'data-llm-agent-row="claude"',
      'data-llm-agent-row="notes"',
    ]);

    // Every row carries a disclosure button and a live summary line, so the
    // tab answers "how is this set up?" without opening anything.
    const toggles = panel.match(/class="llm-pref-row-toggle"/g) || [];
    assert.lengthOf(toggles, rows.length);
    const summaries = panel.match(/data-llm-row-summary/g) || [];
    assert.lengthOf(summaries, rows.length);
    for (const attribute of ["aria-expanded", "aria-controls"]) {
      const seen = panel.match(new RegExp(attribute, "g")) || [];
      assert.isAtLeast(seen.length, rows.length, `${attribute} on every row`);
    }
  });

  it("enables all three runtimes with the same switch idiom", function () {
    const panel = agentPanel();
    for (const id of [
      "__addonRef__-enable-agent-mode",
      "__addonRef__-codex-app-server-enable",
      "__addonRef__-agent-backend-mode",
    ]) {
      assert.include(elementById(panel, id), 'type="checkbox"', id);
    }
    // The Off/On dropdowns are gone; nothing on the tab spells a boolean as a
    // two-option select any more.
    assert.notInclude(panel, '<html:option value="disabled">Off</html:option>');
    assert.notInclude(panel, 'value="claude_bridge"');
  });

  it("keeps shared tools outside runtime rows without duplicate permission controls", function () {
    const panel = agentPanel();
    const claudeCard = panel.indexOf('id="__addonRef__-claude-code-card"');
    const sharedTools = panel.indexOf('id="__addonRef__-shared-runtime-tools"');
    const mcpToggle = panel.indexOf(
      'id="__addonRef__-codex-app-server-mcp-enable"',
    );
    const notesRow = panel.indexOf('data-llm-agent-row="notes"');

    assert.isAtLeast(claudeCard, 0);
    // Zotero MCP tools govern both native runtimes, so the control cannot live
    // inside — and disappear with — the Codex row.
    assert.isAbove(notesRow, claudeCard);
    assert.isAbove(sharedTools, notesRow);
    assert.isAbove(mcpToggle, sharedTools);
    assert.notInclude(panel, 'id="__addonRef__-external-mcp-settings"');
  });

  it("folds runtime detail into a per-row advanced drawer", function () {
    const panel = agentPanel();
    const codexRow = panel.slice(
      panel.indexOf('data-llm-agent-row="codex"'),
      panel.indexOf('data-llm-agent-row="claude"'),
    );
    const claudeRow = panel.slice(
      panel.indexOf('data-llm-agent-row="claude"'),
      panel.indexOf('id="__addonRef__-shared-runtime-tools"'),
    );

    const codexAdvanced = codexRow.slice(
      codexRow.indexOf('class="llm-pref-advanced"'),
    );
    assert.include(codexAdvanced, 'id="__addonRef__-codex-app-server-path"');

    const claudeAdvanced = claudeRow.slice(
      claudeRow.indexOf('class="llm-pref-advanced"'),
    );
    for (const id of [
      "__addonRef__-agent-bridge-url",
      "__addonRef__-agent-claude-config-source",
      "__addonRef__-claude-trace-enabled",
      "__addonRef__-claude-managed-instruction-template",
    ]) {
      assert.include(claudeAdvanced, `id="${id}"`, id);
    }
  });

  it("addresses its icons absolutely, because Zotero inlines this markup", function () {
    const markup = source("addon/content/preferences.xhtml");
    // Zotero copies a preference pane's markup into its own preferences
    // document, so a relative url() resolves against chrome://zotero/content/
    // and renders nothing at all — no error, just an empty box.
    assert.notMatch(markup, /url\("icons\//);
    for (const icon of ["icon", "codex-logo", "claude-code", "folder-open"]) {
      assert.include(
        markup,
        `url("chrome://__addonRef__/content/icons/${icon}.svg")`,
        icon,
      );
    }
  });
});

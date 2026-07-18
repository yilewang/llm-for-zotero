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

  it("stretches the dedicated reader chat root to the bottom of its host", function () {
    const paneSource = readSource(
      "../src/modules/contextPanel/readerDedicatedPane.ts",
    );
    const buildSource = readSource("../src/modules/contextPanel/buildUI.ts");
    assert.include(paneSource, 'height: "100%"');
    assert.include(paneSource, 'flex: "1 1 auto"');
    assert.include(
      buildSource,
      'body.classList.contains("llm-reader-ai-pane")',
    );
    assert.notInclude(
      buildSource,
      'hostBody.classList.contains("llm-reader-ai-pane")',
    );
  });
});

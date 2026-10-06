import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

// Returns the text of one top-level function, from its signature to the next
// blank line followed by a top-level declaration or comment.
function functionBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`);
  assert.isAtLeast(start, 0, `${name} must exist`);
  const end = text.indexOf("\n}\n", start);
  assert.isAtLeast(end, start, `${name} must end with a closing brace`);
  return text.slice(start, end + 3);
}

// The standalone window and the sidebar each remember their own selection;
// only the sidebar writes the conversation restore prefs. The source cannot be
// imported under the node test setup (it pulls in Zotero and DOM modules), so
// these tests pin the exact expressions in the source text.
describe("conversation selection persist policy", function () {
  const standalone = source("src/modules/contextPanel/standaloneWindow.ts");
  const setupHandlers = source("src/modules/contextPanel/setupHandlers.ts");
  const historyLifecycle = source(
    "src/modules/contextPanel/setupHandlers/controllers/historyLifecycleController.ts",
  );

  it("standalone global helper writes the window's own slot and never a pref", function () {
    const body = functionBody(
      standalone,
      "rememberStandaloneGlobalConversation",
    );
    assert.include(body, 'kind: "global"');
    assert.include(body, 'surface: "standalone"');
    assert.notInclude(body, "persist");
  });

  it("standalone paper helper writes the window's own slot and never a pref", function () {
    const body = functionBody(
      standalone,
      "rememberStandalonePaperConversation",
    );
    assert.include(body, 'kind: "paper"');
    assert.include(body, 'surface: "standalone"');
    assert.notInclude(body, "persist");
  });

  it("the window's Paper/Library tab writes the window's own mode only", function () {
    const start = standalone.indexOf("const commitStandaloneMode = ");
    assert.isAtLeast(start, 0, "commitStandaloneMode must exist");
    const body = standalone.slice(start, standalone.indexOf("};", start));
    assert.include(body, 'surface: "standalone"');
    assert.notInclude(body, "active: false");
  });

  it("the window's history navigation primes the window's own selection", function () {
    const primes = standalone.split("primeHistoryNavigationMode({").slice(1);
    assert.isAtLeast(primes.length, 2);
    for (const call of primes) {
      assert.include(
        call.slice(0, call.indexOf("});")),
        'surface: "standalone"',
      );
    }
  });

  it("a new window starts from the sidebar's selection", function () {
    const open = functionBody(standalone, "openStandaloneChat");
    const clearAt = open.indexOf("clearStandaloneSelection();");
    assert.isAtLeast(clearAt, 0);
    assert.isBelow(clearAt, open.indexOf("resolveInitialPanelItemState("));
  });

  it("sidebar identity sync writes Codex and upstream paper chats to the map only", function () {
    for (const system of ["codex", "upstream"]) {
      const marker = `system: "${system}",\n              libraryID,\n              kind: "paper",`;
      const start = setupHandlers.indexOf(marker);
      assert.isAtLeast(start, 0, `${system} paper remember call must exist`);
      const end = setupHandlers.indexOf(");", start);
      const call = setupHandlers.slice(start, end);
      assert.include(call, "{ persist: false }", `${system} paper write`);
      assert.include(call, "surface,", `${system} paper write is per surface`);
    }
  });

  it("panel identity sync remembers the mode on the panel's own surface", function () {
    for (const system of ["claude_code", "codex", "upstream"]) {
      assert.include(
        setupHandlers,
        `rememberMode("${system}", libraryID, mode, { surface });`,
      );
    }
  });

  it("panel history navigation primes the panel's own surface", function () {
    const primes = historyLifecycle
      .split("primeHistoryNavigationMode({")
      .slice(1);
    assert.isAtLeast(primes.length, 5);
    for (const call of primes) {
      assert.include(
        call.slice(0, call.indexOf("});")),
        "surface: selectionSurface()",
      );
    }
  });
});

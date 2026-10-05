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

// The standalone window and the sidebar decide which runtime writes the
// conversation restore pref. The source cannot be imported under the node
// test setup (it pulls in Zotero and DOM modules), so these tests pin the
// exact persist expressions in the source text.
describe("conversation selection persist policy", function () {
  const standalone = source("src/modules/contextPanel/standaloneWindow.ts");
  const setupHandlers = source("src/modules/contextPanel/setupHandlers.ts");

  it("standalone global helper persists for every runtime except Claude Code", function () {
    const body = functionBody(
      standalone,
      "rememberStandaloneGlobalConversation",
    );
    assert.include(body, 'kind: "global"');
    assert.include(body, 'persist: system !== "claude_code"');
  });

  it("standalone paper helper persists only for Codex", function () {
    const body = functionBody(
      standalone,
      "rememberStandalonePaperConversation",
    );
    assert.include(body, 'kind: "paper"');
    assert.include(body, 'persist: system === "codex"');
    assert.notInclude(body, "claude_code");
  });

  it("sidebar identity sync writes Codex and upstream paper chats to the map only", function () {
    for (const system of ["codex", "upstream"]) {
      const marker = `system: "${system}",\n              libraryID,\n              kind: "paper",`;
      const start = setupHandlers.indexOf(marker);
      assert.isAtLeast(start, 0, `${system} paper remember call must exist`);
      const end = setupHandlers.indexOf(");", start);
      const call = setupHandlers.slice(start, end);
      assert.include(call, "{ persist: false }", `${system} paper write`);
    }
  });
});

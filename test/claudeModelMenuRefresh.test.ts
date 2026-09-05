import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));

// The Claude model catalog cache identity (bridge URL, setting-source prefs,
// profile-directory hash, conversation scope) cannot see in-place edits to
// ~/.claude/settings.json — e.g. a cc-switch profile change. A user-initiated
// menu open must therefore force a refresh; the menu still opens instantly on
// the cached list ("Refreshing Claude models…") and live-updates when the
// fresh catalog lands.
describe("Claude model menu refresh on open", function () {
  it("openModelMenu forces a Claude catalog refresh", function () {
    const source = readFileSync(
      resolve(testDir, "../src/modules/contextPanel/setupHandlers.ts"),
      "utf8",
    );
    // lastIndexOf: an earlier `openModelMenu = () => {};` stub declaration
    // precedes the real assignment.
    const open = source.lastIndexOf("openModelMenu = () => {");
    assert.isAtLeast(open, 0, "openModelMenu must exist");
    const close = source.indexOf("closeModelMenu = ", open);
    const block = source.slice(open, close === -1 ? undefined : close);
    assert.match(
      block,
      /ensureClaudeModelCatalogLoaded\(true\)/,
      "a user-initiated open must bypass the TTL cache — the cache identity " +
        "cannot see in-place settings.json profile changes",
    );
  });
});

import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));

function functionBlock(source: string, start: string, end: string): string {
  const open = source.lastIndexOf(start);
  assert.isAtLeast(open, 0, `${start} must exist`);
  const close = source.indexOf(end, open + start.length);
  return source.slice(open, close === -1 ? undefined : close);
}

describe("model menu catalog refresh", function () {
  it("starts provider catalog refreshes when the menu opens, never on a rebuild", function () {
    const source = readFileSync(
      resolve(testDir, "../src/modules/contextPanel/setupHandlers.ts"),
      "utf8",
    );
    // A catalog refresh notifies listeners, which rebuild an open menu; a
    // rebuild that refreshed again fed a fetch loop while the menu was open.
    const rebuild = functionBlock(
      source,
      "const rebuildModelMenu = () => {",
      "\n  };\n",
    );
    assert.notMatch(rebuild, /refreshModelCapabilityRegistry\(/);
    assert.notMatch(rebuild, /refreshConfiguredProviderModelCatalogs\(/);
    const open = functionBlock(
      source,
      "openModelMenu = () => {",
      "closeModelMenu = ",
    );
    assert.match(open, /refreshModelCapabilityRegistry\(\)/);
    assert.match(open, /refreshConfiguredProviderModelCatalogs\(\)/);
    assert.match(open, /ensureCodexModelCatalogLoaded\(true\)/);
  });
});

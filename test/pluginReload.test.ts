import { assert } from "chai";
import { describe, it } from "mocha";
import { config, version } from "../package.json";
import {
  pluginStylesheetHref,
  shouldReplaceAddonInstance,
} from "../src/utils/pluginReload";

describe("plugin reload", function () {
  it("versions plugin stylesheet URLs so an update cannot reuse old CSS", function () {
    assert.equal(
      pluginStylesheetHref("zoteroPane.css"),
      `chrome://${config.addonRef}/content/zoteroPane.css?v=${version}`,
    );
    assert.equal(
      pluginStylesheetHref("vendor/katex/katex.min.css", "4.0.0-beta.1"),
      `chrome://${config.addonRef}/content/vendor/katex/katex.min.css?v=4.0.0-beta.1`,
    );
  });

  it("installs a new addon object unless a live one from this version exists", function () {
    assert.isTrue(shouldReplaceAddonInstance(undefined, "3.9.13"));
    assert.isTrue(shouldReplaceAddonInstance(null, "3.9.13"));
    // A shutdown that threw before deleting the global leaves a dead object.
    assert.isTrue(
      shouldReplaceAddonInstance(
        { data: { alive: false, version: "3.9.13" } },
        "3.9.13",
      ),
    );
    // Versions before this check did not record their version.
    assert.isTrue(
      shouldReplaceAddonInstance({ data: { alive: true } }, "3.9.13"),
    );
    assert.isTrue(
      shouldReplaceAddonInstance(
        { data: { alive: true, version: "3.9.12" } },
        "3.9.13",
      ),
    );
    assert.isFalse(
      shouldReplaceAddonInstance(
        { data: { alive: true, version: "3.9.13" } },
        "3.9.13",
      ),
    );
  });
});

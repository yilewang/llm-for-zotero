import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { assert } from "chai";

const here = dirname(fileURLToPath(import.meta.url));

const FOOTER_ACTION_CLASSES = ["retry", "copy", "note", "fork", "delete"];

function extractCssRule(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`));
  return match?.[0] || "";
}

describe("compact marker CSS", function () {
  it("defines native-style pending and completed divider states", function () {
    const css = readFileSync(
      resolve(here, "../addon/content/zoteroPane.css"),
      "utf8",
    );

    assert.include(css, ".llm-compact-marker-wrapper");
    assert.include(css, ".llm-bubble.llm-compact-marker");
    assert.include(css, ".llm-compact-marker-rule");
    assert.include(css, ".llm-compact-marker-pending");
    assert.include(css, "@keyframes llm-compact-spin");
  });

  it("inlines footer action icon masks for rebuilt chat DOM", function () {
    const css = readFileSync(
      resolve(here, "../addon/content/zoteroPane.css"),
      "utf8",
    );

    for (const actionClass of FOOTER_ACTION_CLASSES) {
      const selector = `.llm-message-action-${actionClass}::before`;
      const rule = extractCssRule(css, selector);
      assert.isNotEmpty(rule, `${selector} should be defined`);
      assert.include(
        rule,
        "data:image/svg+xml",
        `${selector} should use an inline SVG data URI mask`,
      );
      assert.notInclude(
        rule,
        'url("icons/',
        `${selector} should not depend on an external icon URL`,
      );
    }
  });

  it("defines fork provenance marker styles with the branch icon", function () {
    const css = readFileSync(
      resolve(here, "../addon/content/zoteroPane.css"),
      "utf8",
    );
    const forkMarkerRule = extractCssRule(css, ".llm-fork-source-marker-icon");

    assert.isTrue(
      existsSync(resolve(here, "../addon/content/icons/action-fork.svg")),
    );
    assert.include(forkMarkerRule, 'url("icons/action-fork.svg")');
    assert.include(css, ".llm-fork-source-marker-wrapper");
    assert.include(css, ".llm-bubble.llm-fork-source-marker");
    assert.include(css, ".llm-fork-source-marker-button");
    assert.include(css, "color: var(--fill-tertiary)");
    assert.include(css, "background: var(--fill-quinary)");
    assert.notInclude(
      extractCssRule(css, ".llm-bubble.llm-fork-source-marker"),
      "var(--color-accent",
    );
  });
});

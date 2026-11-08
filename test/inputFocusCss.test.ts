import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";

const here = dirname(fileURLToPath(import.meta.url));

function readPanelCss(): string {
  return readFileSync(resolve(here, "../addon/content/zoteroPane.css"), "utf8");
}

function extractCssRule(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`));
  return match?.[0] || "";
}

function extractCssRules(css: string, selector: string): string[] {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Array.from(
    css.matchAll(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`, "g")),
    (match) => match[0],
  );
}

describe("composer input focus CSS", function () {
  it("keeps the shared input borderless while typing", function () {
    const css = readPanelCss();
    const inputRules = extractCssRules(css, ".llm-input");
    const focusRule = extractCssRule(css, ".llm-input:focus");

    // Its right and bottom insets are transparent borders.
    assert.include(inputRules.join("\n"), "border-color: transparent;");
    assert.include(inputRules.join("\n"), "appearance: none;");
    assert.include(focusRule, "outline: none;");
    assert.include(focusRule, "box-shadow: none;");
    assert.notInclude(focusRule, "border-color");
  });

  it("does not paint-contain the message wrapper that hosts inline edit menus", function () {
    const css = readPanelCss();
    const messageWrapperRule = extractCssRule(css, ".llm-message-wrapper");

    assert.notMatch(
      messageWrapperRule,
      /contain\s*:[^;]*(?:layout|paint)/,
      "layout/paint containment traps the inline editor's fixed model and reasoning menus",
    );
  });
});

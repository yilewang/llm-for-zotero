import { readFileSync } from "node:fs";
import { assert } from "chai";

function extractCssRule(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`));
  return match?.[0] || "";
}

describe("math rendering CSS", function () {
  it("keeps KaTeX SVG delimiters transparent", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const svgRule = extractCssRule(css, ".llm-rendered-markdown .katex svg");

    assert.include(svgRule, "background: transparent;");
  });
});

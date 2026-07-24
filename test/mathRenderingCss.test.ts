import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";

const here = dirname(fileURLToPath(import.meta.url));

function extractCssRule(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`));
  return match?.[0] || "";
}

describe("math rendering CSS", function () {
  it("keeps KaTeX SVG delimiters transparent", function () {
    const css = readFileSync(
      resolve(here, "../addon/content/zoteroPane.css"),
      "utf8",
    );
    const svgRule = extractCssRule(css, ".llm-rendered-markdown .katex svg");

    assert.include(svgRule, "background: transparent;");
  });
});

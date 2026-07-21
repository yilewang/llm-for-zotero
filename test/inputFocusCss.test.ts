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
  const match = css.match(
    new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{[^}]*\\}`),
  );
  return match?.[0] || "";
}

function extractCssRules(css: string, selector: string): string[] {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Array.from(
    css.matchAll(new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{[^}]*\\}`, "g")),
    (match) => match[0],
  );
}

describe("composer input focus CSS", function () {
  it("balances compact spacing above and below the typing text", function () {
    const css = readPanelCss();
    const inputSectionRule = extractCssRules(css, ".llm-input-section").find(
      (rule) => rule.includes("--llm-input-section-padding"),
    );
    const composeAreaRule = extractCssRule(css, ".llm-compose-area");
    const inputRule = extractCssRules(css, ".llm-input").find((rule) =>
      rule.includes("max-height: 220px"),
    );

    assert.include(inputSectionRule, "--llm-composer-gap: 6px;");
    assert.include(inputSectionRule, "gap: var(--llm-composer-gap);");
    assert.include(composeAreaRule, "gap: var(--llm-composer-gap, 6px);");
    assert.include(inputRule, "padding: 8px 14px;");
  });

  it("keeps the shared input borderless while typing", function () {
    const css = readPanelCss();
    const inputRules = extractCssRules(css, ".llm-input");
    const focusRule = extractCssRule(css, ".llm-input:focus");

    assert.include(inputRules.join("\n"), "border: none;");
    assert.include(inputRules.join("\n"), "appearance: none;");
    assert.include(focusRule, "outline: none;");
    assert.include(focusRule, "box-shadow: none;");
    assert.notInclude(focusRule, "border-color");
  });

  it("keeps the inline editor on one cohesive surface with matched bottom corners", function () {
    const css = readPanelCss();
    const editWrapperRule = extractCssRule(css, ".llm-inline-edit-wrapper");
    const editInputSectionRule = extractCssRule(
      css,
      ".llm-inline-edit-wrapper > .llm-input-section",
    );

    assert.include(editWrapperRule, "border: var(--material-border-quinary);");
    assert.include(editWrapperRule, "border-radius: 8px;");
    assert.notInclude(editWrapperRule, "var(--color-accent)");
    assert.include(editInputSectionRule, "border-radius: 0 0 7px 7px;");
  });
});

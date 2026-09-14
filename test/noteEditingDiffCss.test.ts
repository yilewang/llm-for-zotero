import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";

const here = dirname(fileURLToPath(import.meta.url));

function readPanelCss(): string {
  return readFileSync(resolve(here, "../addon/content/zoteroPane.css"), "utf8");
}

function extractCssRuleContainingSelector(
  css: string,
  selector: string,
): string {
  const normalizedSelector = selector.replace(/\s+/g, " ").trim();
  for (const chunk of css.split("}")) {
    const bodyStart = chunk.lastIndexOf("{");
    if (bodyStart === -1) continue;
    const selectorText = chunk.slice(0, bodyStart);
    const selectors = selectorText
      .split(",")
      .map((entry) => entry.replace(/\s+/g, " ").trim());
    if (selectors.includes(normalizedSelector)) {
      return `${selectorText.trim()} {${chunk.slice(bodyStart + 1)}}`;
    }
  }
  return "";
}

describe("note editing diff review CSS", function () {
  it("keeps light-theme changed text at the normal diff color through scoped diff variables", function () {
    const css = readPanelCss();

    const diffRule = extractCssRuleContainingSelector(
      css,
      ".llm-agent-hitl-diff",
    );
    const darkDiffRule = extractCssRuleContainingSelector(
      css,
      ".window-is-dark .llm-agent-hitl-diff",
    );
    const addSegmentRule = extractCssRuleContainingSelector(
      css,
      ".llm-agent-hitl-diff-line-add .llm-agent-hitl-diff-segment-add",
    );
    const removeSegmentRule = extractCssRuleContainingSelector(
      css,
      ".llm-agent-hitl-diff-line-remove .llm-agent-hitl-diff-segment-remove",
    );
    const darkAddSegmentRule = extractCssRuleContainingSelector(
      css,
      ".window-is-dark .llm-agent-hitl-diff-line-add .llm-agent-hitl-diff-segment-add",
    );
    const diffLineRule = extractCssRuleContainingSelector(
      css,
      ".llm-agent-hitl-diff-line",
    );
    const diffGutterRule = extractCssRuleContainingSelector(
      css,
      ".llm-agent-hitl-diff-gutter",
    );
    const addLineRule = extractCssRuleContainingSelector(
      css,
      ".llm-agent-hitl-diff-line-add",
    );
    const removeLineRule = extractCssRuleContainingSelector(
      css,
      ".llm-agent-hitl-diff-line-remove",
    );

    assert.match(diffRule, /--llm-agent-hitl-diff-add-text:\s*inherit\s*;/);
    assert.match(diffRule, /--llm-agent-hitl-diff-remove-text:\s*inherit\s*;/);
    assert.include(diffRule, "border-radius: 10px;");
    assert.include(diffRule, "overflow: hidden;");
    assert.include(diffLineRule, "grid-template-columns: 46px minmax(0, 1fr);");
    assert.include(diffGutterRule, "ui-monospace");
    assert.include(addLineRule, "background: rgba(34, 197, 94, 0.14);");
    assert.include(removeLineRule, "background: rgba(239, 68, 68, 0.14);");
    assert.include(darkDiffRule, "--llm-agent-hitl-diff-add-text: #7ce4a1;");
    assert.include(darkDiffRule, "--llm-agent-hitl-diff-remove-text: #ff9f9f;");
    assert.include(
      addSegmentRule,
      "color: var(--llm-agent-hitl-diff-add-text);",
    );
    assert.include(
      removeSegmentRule,
      "color: var(--llm-agent-hitl-diff-remove-text);",
    );
    assert.isEmpty(darkAddSegmentRule);
  });
});

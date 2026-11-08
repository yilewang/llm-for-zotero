import { assert } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Icon classes draw a currentColor ::before box; without a mask-image the box
// shows as a solid square. Every icon added for side panel items needs one.
const ICON_SELECTORS = [
  ".llm-side-move-glyph::before",
  ".llm-plan-document-action-move-side::before",
  ".llm-standalone-side-panel-icon-misc::before",
  ".llm-standalone-side-panel-icon-task-progress::before",
  ".llm-task-progress-move::before",
  ".llm-task-progress-back::before",
  ".llm-standalone-side-panel-icon-copy::before",
  ".llm-standalone-side-panel-icon-note::before",
  ".llm-standalone-side-panel-icon-rerun::before",
  ".llm-standalone-side-panel-icon-show-in-chat::before",
  ".llm-standalone-side-panel-icon-back::before",
  ".llm-standalone-side-panel-icon-web-browser::before",
  ...["mermaid", "svg", "html", "code", "plan"].map(
    (kind) => `.llm-standalone-side-panel-icon-item-${kind}::before`,
  ),
];

function masksBySelector(css: string): Map<string, boolean> {
  const result = new Map<string, boolean>();
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of stripped.split("}")) {
    const open = block.indexOf("{");
    if (open < 0) continue;
    const selectors = block
      .slice(0, open)
      .split(",")
      .map((selector) => selector.trim());
    const hasMask = /(^|[\s;])mask-image\s*:\s*url\(/.test(block.slice(open));
    for (const selector of selectors) {
      result.set(selector, result.get(selector) || false || hasMask);
    }
  }
  return result;
}

describe("side panel item icon masks", function () {
  const css = readFileSync(
    join(__dirname, "..", "addon", "content", "zoteroPane.css"),
    "utf8",
  );
  const masks = masksBySelector(css);
  for (const selector of ICON_SELECTORS) {
    it(`${selector} has a mask-image`, function () {
      assert.isTrue(masks.get(selector) === true, `${selector} has no mask`);
    });
  }
});

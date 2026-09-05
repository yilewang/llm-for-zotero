import { assert } from "chai";
import { renderAssistantMarkdownHtmlForChat } from "../src/modules/contextPanel/chat";

/**
 * Contract between the sync-for-zotero extension's DOM→Markdown converter and
 * this plugin's chat renderer (issue #355).
 *
 * The extension reconstructs Markdown from the provider's rendered DOM. These
 * fixtures are the exact shapes its converter emits (captured live from
 * chatgpt.com after the render-fidelity fix); the plugin must render each one
 * faithfully. If the extension's output format changes, update these fixtures
 * together with `test/html_to_markdown_render_fidelity.test.mjs` over in the
 * sync-for-zotero repo.
 */
describe("webchat markdown render contract", function () {
  it("renders recovered display and inline math", function () {
    const html = renderAssistantMarkdownHtmlForChat(
      "时间变量 $t$ 表示系统演化的时刻。\n\n$$dS_t=\\mu_t S_t\\,dt+\\sigma_t S_t\\,dW_t$$",
    );
    assert.include(html, "math-inline");
    assert.include(html, "math-display");
    assert.include(html, "katex");
    assert.notInclude(html, "math-error");
  });

  it("renders the emoji row untouched", function () {
    const html = renderAssistantMarkdownHtmlForChat("✔️ ✅ ❗ ❓ ⁉️ ⚠️ 💜");
    for (const symbol of ["✔️", "✅", "❗", "❓", "⁉️", "⚠️", "💜"]) {
      assert.include(html, symbol);
    }
  });

  it("renders task-list markers as disabled checkboxes", function () {
    const html = renderAssistantMarkdownHtmlForChat(
      "- [x] 已完成项\n- [ ] 未完成项",
    );
    assert.include(
      html,
      '<input type="checkbox" disabled="disabled" checked="checked" />',
    );
    assert.include(html, '<input type="checkbox" disabled="disabled" />');
    assert.include(html, "已完成项");
    assert.include(html, "未完成项");
  });

  it("renders the extension's two-space nested unordered lists as nested ULs", function () {
    const markdown = [
      "- 第一层 A",
      "  - 第二层 A1",
      "    - 第三层 A1a",
      "    - 第三层 A1b",
      "  - 第二层 A2",
      "- 第一层 B",
    ].join("\n");
    const html = renderAssistantMarkdownHtmlForChat(markdown);
    const nestedDepth = (html.match(/<ul>/g) || []).length;
    assert.equal(nestedDepth, 3, `expected 3 nested <ul> levels in: ${html}`);
    assert.include(html, "<li>第一层 A<ul>");
    assert.include(html, "<li>第二层 A1<ul>");
  });

  it("renders the extension's three-space nesting under ordered items", function () {
    const markdown = [
      "1. 第一项",
      "   - 子项甲",
      "   - 子项乙",
      "2. 第二项",
    ].join("\n");
    const html = renderAssistantMarkdownHtmlForChat(markdown);
    assert.include(html, "<ol>");
    assert.include(html, "<li>第一项<ul>");
    assert.include(html, "<li>子项甲</li>");
  });

  it("renders bold-lead ordered items", function () {
    const html = renderAssistantMarkdownHtmlForChat(
      "1. **第一项** 内容\n2. **第二项** 内容\n3. **第三项** 内容",
    );
    assert.include(html, "<li><strong>第一项</strong> 内容</li>");
  });

  it("renders degraded formula text (no source recovered) as plain text, not markup damage", function () {
    const html = renderAssistantMarkdownHtmlForChat("结果 x+1 成立");
    assert.include(html, "结果 x+1 成立");
  });
});

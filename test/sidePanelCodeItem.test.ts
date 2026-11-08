import { assert } from "chai";
import { renderMarkdown } from "../src/utils/markdown";
import {
  buildItemFenceMarkdown,
  resolveItemTabTitle,
  splitCodeFence,
} from "../src/modules/contextPanel/sidePanelItems";

/** The text a code block body shows, with tags removed and entities decoded. */
function bodyText(html: string): string {
  const start = html.indexOf('class="llm-codeblock-body"');
  const body = html.slice(html.indexOf(">", start) + 1);
  return body
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

describe("side panel code item", function () {
  describe("splitCodeFence", function () {
    it("returns the inner code and language of a backtick fence", function () {
      assert.deepEqual(
        splitCodeFence("```python\ndef greet(name):\n    return 1\n```"),
        { code: "def greet(name):\n    return 1", lang: "python" },
      );
    });

    it("handles a fence with no language", function () {
      assert.deepEqual(splitCodeFence("```\nplain\n```"), {
        code: "plain",
        lang: "",
      });
    });

    it("handles ~~~ fences and longer fences", function () {
      assert.deepEqual(splitCodeFence("~~~js\nlet a = 1;\n~~~"), {
        code: "let a = 1;",
        lang: "js",
      });
      assert.deepEqual(splitCodeFence("````md\n```x```\n````"), {
        code: "```x```",
        lang: "md",
      });
    });

    it("keeps only the language word of an info string", function () {
      assert.deepEqual(splitCodeFence("```python title=x\nx = 1\n```"), {
        code: "x = 1",
        lang: "python",
      });
    });

    it("leaves unfenced text and an unclosed fence's code alone", function () {
      assert.deepEqual(splitCodeFence("x = 1"), { code: "x = 1", lang: "" });
      assert.deepEqual(splitCodeFence("```py\nx = 1"), {
        code: "x = 1",
        lang: "py",
      });
    });
  });

  const cases: Array<{ lang: string; fence: string; code: string }> = [
    {
      lang: "python",
      code: "def greet(name):\n    return f'hello {name}'",
      fence: "```python\ndef greet(name):\n    return f'hello {name}'\n```",
    },
    {
      lang: "javascript",
      code: "function add(a, b) {\n  return a + b;\n}",
      fence: "~~~javascript\nfunction add(a, b) {\n  return a + b;\n}\n~~~",
    },
    {
      lang: "html",
      code: '<div class="box">hi</div>',
      fence: '```html title=page\n<div class="box">hi</div>\n```',
    },
  ];

  for (const { lang, code, fence } of cases) {
    it(`renders a moved ${lang} block like the chat's own block`, function () {
      // The →| button hands over the split fence, as the chat's copy source.
      const split = splitCodeFence(fence);
      const html = renderMarkdown(
        buildItemFenceMarkdown({
          kind: "code",
          source: split.code,
          lang: split.lang,
        }),
      );
      assert.include(html, `data-code-lang="${lang}"`);
      assert.include(html, `<span class="llm-codeblock-lang">${lang}</span>`);
      assert.match(html, /<span class="hljs-[a-z]/);
      assert.notInclude(bodyText(html), "```");
      assert.notInclude(bodyText(html), "~~~");
      assert.equal(bodyText(html).trim(), code);
      // Same shell, label, and highlighting as the chat's block; only the
      // copy source on the outer wrapper differs (inner code, not the fence).
      const shell = (markup: string) =>
        markup.slice(markup.indexOf('<div class="llm-codeblock-shell"'));
      assert.equal(shell(html), shell(renderMarkdown(fence)));
    });

    it(`unwraps a ${lang} source that still carries its fence`, function () {
      const html = renderMarkdown(
        buildItemFenceMarkdown({ kind: "code", source: fence }),
      );
      assert.include(html, `data-code-lang="${lang}"`);
      assert.notInclude(bodyText(html), "```");
      assert.match(html, /<span class="hljs-[a-z]/);
    });
  }

  it("keeps a Markdown block's own inner fence as code", function () {
    const split = splitCodeFence("````md\n```js\nx\n```\n````");
    const html = renderMarkdown(
      buildItemFenceMarkdown({ kind: "code", ...split, source: split.code }),
    );
    assert.include(html, 'data-code-lang="md"');
    assert.include(bodyText(html), "```js");
  });

  it("titles an unlabelled code block Code, not text", function () {
    const split = splitCodeFence("```\nplain\n```");
    assert.equal(
      resolveItemTabTitle({ kind: "code", lang: split.lang }),
      "Code",
    );
  });

  it("renders Mermaid and SVG sources with their own language", function () {
    const mermaid = renderMarkdown(
      buildItemFenceMarkdown({ kind: "mermaid", source: "graph TD\nA-->B" }),
    );
    assert.include(mermaid, 'data-code-lang="mermaid"');
    assert.notInclude(bodyText(mermaid), "```");
    const svg = renderMarkdown(
      buildItemFenceMarkdown({
        kind: "svg",
        source: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
      }),
    );
    assert.include(svg, 'data-code-lang="svg"');
    assert.match(svg, /<span class="hljs-[a-z]/);
  });
});

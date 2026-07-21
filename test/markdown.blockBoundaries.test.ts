import { assert } from "chai";
import {
  __setMarkdownParserDisabledForTest,
  normalizeBlockBoundaries,
  renderMarkdown,
  renderMarkdownForNote,
} from "../src/utils/markdown";

describe("normalizeBlockBoundaries", function () {
  describe("header normalization", function () {
    it("inserts newline before ### after citation-ending parenthesis", function () {
      const input =
        "representational drift. (Zheng et al., 2026) ### 2. In the Introduction";
      const result = normalizeBlockBoundaries(input);
      assert.include(result, "2026)\n\n### 2.");
    });

    it("inserts newline before ### after colon", function () {
      const input = "discussed: ### 1. In the Abstract and Title";
      const result = normalizeBlockBoundaries(input);
      assert.include(result, "discussed:\n\n### 1.");
    });

    it("inserts newline before ## after period", function () {
      const input = "end of sentence. ## Next Section";
      const result = normalizeBlockBoundaries(input);
      assert.include(result, "sentence.\n\n## Next Section");
    });

    it("inserts newline before # after exclamation mark", function () {
      const input = "important! # Title";
      const result = normalizeBlockBoundaries(input);
      assert.include(result, "important!\n\n# Title");
    });

    it("inserts newline before #### after closing bracket", function () {
      const input = "see [1] #### Subsection";
      const result = normalizeBlockBoundaries(input);
      assert.include(result, "[1]\n\n#### Subsection");
    });

    it("preserves header at line start (no extra newline)", function () {
      const input = "### Already at line start";
      const result = normalizeBlockBoundaries(input);
      assert.equal(result, input);
    });

    it("does not split C# or hashtag mid-line without space before hash", function () {
      const input = "I used C# language for this project";
      const result = normalizeBlockBoundaries(input);
      assert.equal(result, input);
    });

    it("splits ### after any word when preceded by whitespace", function () {
      const input = "some context text ### Section Header";
      const result = normalizeBlockBoundaries(input);
      assert.include(result, "text\n\n### Section");
    });

    it("does not split ## inside inline math context without space", function () {
      const input = "The value $x ## y$ is computed";
      const result = normalizeBlockBoundaries(input);
      // No space before ## in "$x ##", but there IS a space after $x
      // The regex matches $x + space + ## — this is acceptable because
      // ## in non-code non-math inline text is almost always a header
      assert.ok(result);
    });

    it("does not split # inside a pipe table cell", function () {
      const input = "| Condition | # of Switches | Description |";
      const result = normalizeBlockBoundaries(input);
      assert.equal(result, input);
    });
  });

  describe("blockquote normalization", function () {
    it("inserts newline before > after period and space", function () {
      const input =
        "olfactory bulb (OB). > How the olfactory bulb maintains stable odor manifolds";
      const result = normalizeBlockBoundaries(input);
      assert.include(result, "(OB).\n\n> How");
    });

    it("inserts newline before > after citation-ending parenthesis", function () {
      const input =
        "(Zheng et al., 2026) > (B) Quantification of subspace rotation";
      const result = normalizeBlockBoundaries(input);
      assert.include(result, "2026)\n\n> (B)");
    });

    it("inserts newline before > after question mark", function () {
      const input = "Is this correct? > The evidence suggests otherwise";
      const result = normalizeBlockBoundaries(input);
      assert.include(result, "correct?\n\n> The evidence");
    });

    it("inserts newline before > after exclamation mark", function () {
      const input = "Notable finding! > We observed a strong correlation";
      const result = normalizeBlockBoundaries(input);
      assert.include(result, "finding!\n\n> We observed");
    });

    it("inserts newline before > after closing double quote", function () {
      const input = 'He said "done" > The next passage begins here';
      const result = normalizeBlockBoundaries(input);
      assert.include(result, '"\n\n> The next');
    });

    it("preserves blockquote at line start", function () {
      const input = "> Already a blockquote";
      const result = normalizeBlockBoundaries(input);
      assert.equal(result, input);
    });

    it("does not split comparison operators mid-line", function () {
      const input = "the value x > 5 means the threshold is exceeded";
      const result = normalizeBlockBoundaries(input);
      assert.equal(result, input);
    });

    it("does not turn a parenthesized function comparison into a blockquote", function () {
      const input =
        "3. **Response reliability**: A stimulus is reliable if S(*p*, *p*) > 0.4 (i.e., trial-to-trial correlations are strong).";
      const result = normalizeBlockBoundaries(input);
      const html = renderMarkdown(input);

      assert.equal(result, input);
      assert.notInclude(html, "<blockquote>");
      assert.include(html, "S(<em>p</em>, <em>p</em>) &gt; 0.4");
    });

    it("does not treat other mathematical closers or threshold colons as quote boundaries", function () {
      const inputs = [
        "The function f(x) > chance defines the accepted region.",
        "Only values[i] > threshold are retained.",
        "The inclusion criterion: > 0.4 on the reliability score.",
      ];

      for (const input of inputs) {
        assert.equal(normalizeBlockBoundaries(input), input);
        assert.notInclude(renderMarkdown(input), "<blockquote>");
      }
    });

    it("does not split > when not preceded by punctuation trigger", function () {
      const input = "something here > not a quote";
      const result = normalizeBlockBoundaries(input);
      assert.equal(result, input);
    });
  });

  describe("ordered-list normalization", function () {
    it("inserts a list boundary after an inline source parenthetical", function () {
      const input =
        '(Methods, "Real-time data processing") 4. **From scalar to avatar movement**';
      const result = normalizeBlockBoundaries(input);
      assert.include(
        result,
        '(Methods, "Real-time data processing")\n\n4. **From',
      );
    });

    it("inserts a list boundary after a standalone source parenthetical", function () {
      const input =
        '(Methods, "Real-time data processing")\n4. **From scalar to avatar movement**';
      const result = normalizeBlockBoundaries(input);
      assert.include(
        result,
        '(Methods, "Real-time data processing")\n\n4. **From',
      );
    });

    it("does not split decimal prose after a parenthetical", function () {
      const input = "(Figure 2) 4.5 mm was the measured offset.";
      const result = normalizeBlockBoundaries(input);
      assert.equal(result, input);
    });
  });

  describe("source-label continuation normalization", function () {
    it("inserts an unordered-list boundary after a source parenthetical", function () {
      const input =
        "(Carrasco et al., 2026) - **Environment Classification:** Classifiers were trained.";
      const result = normalizeBlockBoundaries(input);
      assert.include(result, "(Carrasco et al., 2026)\n\n- **Environment");
    });

    it("inserts a boundary before heading-like emphasized continuation text", function () {
      const input =
        "(Carrasco et al., 2026) *Environment Classification:* Classifiers were trained.";
      const result = normalizeBlockBoundaries(input);
      assert.include(
        result,
        "(Carrasco et al., 2026)\n\n*Environment Classification:*",
      );
    });

    it("inserts an unordered-list boundary after a no-year source parenthetical", function () {
      const input =
        "(Smith) - **Environment Classification:** Classifiers were trained.";
      const result = normalizeBlockBoundaries(input);
      assert.include(result, "(Smith)\n\n- **Environment Classification:**");
    });

    it("inserts an emphasized-heading boundary after a no-year source parenthetical", function () {
      const input =
        "(Smith and Jones) *Environment Classification:* Classifiers were trained.";
      const result = normalizeBlockBoundaries(input);
      assert.include(
        result,
        "(Smith and Jones)\n\n*Environment Classification:*",
      );
    });

    it("does not split statistical emphasis after a source parenthetical", function () {
      const input = "(Carrasco et al., 2026) *p* < 0.05 across sessions.";
      const result = normalizeBlockBoundaries(input);
      assert.equal(result, input);
    });

    it("does not split unordered-looking prose after a non-source parenthetical", function () {
      const input = "(Figure 2) - 4.5 mm was the measured offset.";
      const result = normalizeBlockBoundaries(input);
      assert.equal(result, input);
    });
  });

  describe("mixed normalization", function () {
    it("handles multiple headers and blockquotes on one line", function () {
      const input =
        "intro text. (Smith et al., 2024) ### 1. Abstract. > quote text. (Smith et al., 2024) ### 2. Methods";
      const result = normalizeBlockBoundaries(input);
      assert.include(result, "2024)\n\n### 1.");
      assert.include(result, "Abstract.\n\n> quote");
      assert.include(result, "2024)\n\n### 2.");
    });

    it("preserves already-correct multiline markdown", function () {
      const input =
        "Some intro text.\n\n### Section 1\n\n> A blockquote here\n\n(Smith et al., 2024)";
      const result = normalizeBlockBoundaries(input);
      assert.equal(result, input);
    });
  });
});

describe("renderMarkdown with inline block tokens", function () {
  it("renders inline ### as a proper header element", function () {
    const input = "intro. (Author, 2024) ### Key Finding";
    const html = renderMarkdown(input);
    assert.include(html, "<h4>");
    assert.include(html, "Key Finding");
  });

  it("renders inline > as a proper blockquote element", function () {
    const input =
      "the paper states. > The olfactory bulb maintains stable manifolds";
    const html = renderMarkdown(input);
    assert.include(html, "<blockquote>");
    assert.include(html, "olfactory bulb");
  });

  it("keeps dashed separator lines as horizontal rules, matching the legacy renderer", function () {
    const input = "Paragraph before\n---\nParagraph after";
    const html = renderMarkdown(input);

    assert.include(html, "<p>Paragraph before</p><hr/>");
    assert.include(html, "<p>Paragraph after</p>");
    assert.notInclude(html, "<h2>Paragraph before</h2>");
    assert.notInclude(html, "<h3>Paragraph before</h3>");
  });

  it("emits XHTML-compatible void tags for Zotero chrome documents", function () {
    const html = renderMarkdown(
      ["---", "", "First line  ", "Second line", "", "- [x] done"].join("\n"),
    );

    assert.include(html, "<hr/>");
    assert.notInclude(html, "<hr>");
    assert.include(html, "<br/>");
    assert.include(
      html,
      '<input type="checkbox" disabled="disabled" checked="checked" />',
    );
    assert.notInclude(html, 'type="checkbox">');
  });

  it("renders blockquote + citation combo correctly for decoration", function () {
    const input =
      "discussed:\n\n> How the olfactory bulb maintains stability\n\n(Zheng et al., 2026)";
    const html = renderMarkdown(input);
    assert.include(html, "<blockquote>");
    assert.include(html, "(Zheng et al., 2026)");
  });

  it("renders inline citation after parenthesis as blockquote", function () {
    const input =
      "(Zheng et al., 2026) > By analyzing longitudinal datasets we found a rotation";
    const html = renderMarkdown(input);
    assert.include(html, "<blockquote>");
  });

  it("preserves text-token spacing before inline bold across soft breaks", function () {
    const html = renderMarkdown(
      "[[quote:Q]]\nSo **one component** handles it.",
    );
    assert.include(html, "So <strong>one component</strong>");
    assert.notInclude(html, "So<strong>one component</strong>");
  });

  it("renders ordered-list markers after source labels as list items", function () {
    const html = renderMarkdown(
      '(Methods, "Real-time data processing")\n4. **From scalar to avatar movement**\nThe scalar projection value is scaled.',
    );
    assert.include(html, '<ol start="4">');
    assert.include(
      html,
      "<li><strong>From scalar to avatar movement</strong> The scalar projection value is scaled.</li>",
    );
    assert.notInclude(html, "4.<strong>From scalar");
  });

  it("renders inline ordered-list markers after source labels as list items", function () {
    const html = renderMarkdown(
      '(Methods, "Real-time data processing") 4. **From scalar to avatar movement**\nThe scalar projection value is scaled.',
    );
    assert.include(html, '<ol start="4">');
    assert.notInclude(html, "4.<strong>From scalar");
  });

  it("renders inline unordered-list markers after source labels as list items", function () {
    const html = renderMarkdown(
      "(Carrasco et al., 2026) - **Environment Classification:** Classifiers were trained.",
    );

    assert.include(html, "<ul>");
    assert.include(
      html,
      "<li><strong>Environment Classification:</strong> Classifiers were trained.</li>",
    );
    assert.notInclude(html, "- <strong>Environment");
  });

  it("renders inline unordered-list markers after no-year source labels as list items", function () {
    const html = renderMarkdown(
      "(Smith) - **Environment Classification:** Classifiers were trained.",
    );

    assert.include(html, "<p>(Smith)</p>");
    assert.include(html, "<ul>");
    assert.include(
      html,
      "<li><strong>Environment Classification:</strong> Classifiers were trained.</li>",
    );
    assert.notInclude(html, "(Smith) - <strong>Environment");
  });

  it("renders heading-like emphasized continuation after source labels", function () {
    const html = renderMarkdown(
      "(Carrasco et al., 2026) *Environment Classification:* Classifiers were trained.",
    );

    assert.include(html, "<p>(Carrasco et al., 2026)</p>");
    assert.include(
      html,
      "<p><em>Environment Classification:</em> Classifiers were trained.</p>",
    );
    assert.notInclude(html, "*Environment Classification:*");
  });

  it("renders heading-like emphasized continuation after no-year source labels", function () {
    const html = renderMarkdown(
      "(Smith) *Environment Classification:* Classifiers were trained.",
    );

    assert.include(html, "<p>(Smith)</p>");
    assert.include(
      html,
      "<p><em>Environment Classification:</em> Classifiers were trained.</p>",
    );
    assert.notInclude(html, "(Smith) <em>Environment");
  });

  it("renders source-label continuation boundaries in the legacy renderer", function () {
    __setMarkdownParserDisabledForTest(true);
    try {
      const html = renderMarkdown(
        "(Carrasco et al., 2026) - **Environment Classification:** Classifiers were trained.\n\n(Carrasco et al., 2026) *Decoding:* Models transferred across sessions.",
      );

      assert.include(html, "<ul>");
      assert.include(html, "<strong>Environment Classification:</strong>");
      assert.include(html, "<em>Decoding:</em>");
      assert.notInclude(html, "*Decoding:*");
    } finally {
      __setMarkdownParserDisabledForTest(false);
    }
  });

  it("renders markdown tables without turning divider syntax into plain text", function () {
    const input = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const html = renderMarkdown(input);
    assert.include(html, "<table>");
    assert.include(html, "<th>A</th>");
    assert.include(html, "<td>2</td>");
  });

  it("keeps escaped pipes inside table cells", function () {
    const input = "| A | B |\n| --- | --- |\n| x\\|y | z |";
    const html = renderMarkdown(input);
    assert.include(html, "<td>x|y</td>");
    assert.include(html, "<td>z</td>");
  });

  it("renders pipe tables whose header includes # text", function () {
    const input =
      "| Condition | # of Switches | Description |\n|---|---|---|\n| No Switch | 0 | Baseline |";
    const html = renderMarkdown(input);
    assert.include(html, "<table>");
    assert.include(html, "<th># of Switches</th>");
    assert.notInclude(html, "<h2>");
  });

  it("renders pipe tables with hard-wrapped header and body rows", function () {
    const input =
      "| Condition |\nSwitches | Structure |\n|---|---|---|\n| No Switch | 0 | Same scene all 24 words -- baseline |\n| Medium Switch | 3 | Switches every 6\nwords |";
    const html = renderMarkdown(input);
    assert.include(html, "<table>");
    assert.include(html, "<th>Condition</th>");
    assert.include(html, "<th>Switches</th>");
    assert.include(html, "<th>Structure</th>");
    assert.include(html, "<td>Switches every 6 words</td>");
  });

  it("does not absorb following prose into a hard-wrapped table", function () {
    const input =
      "| A |\nB | C |\n|---|---|---|\n| 1 | 2 | 3 |\nThe core logic: more switches mean more boundaries.";
    const html = renderMarkdown(input);
    assert.include(html, "<table>");
    assert.include(
      html,
      "<p>The core logic: more switches mean more boundaries.</p>",
    );
    assert.notInclude(html, "<td>3 The core logic");
  });

  it("treats hard-wrapped paragraph newlines as soft breaks", function () {
    const input =
      "This paragraph was wrapped by the model\nbefore it reached the panel.";
    const html = renderMarkdown(input);
    assert.include(
      html,
      "<p>This paragraph was wrapped by the model before it reached the panel.</p>",
    );
    assert.notInclude(html, "<br/>");
  });

  it("attaches wrapped punctuation without inserting a space", function () {
    const input = "tools are properly connected\n.";
    const html = renderMarkdown(input);
    assert.include(html, "<p>tools are properly connected.</p>");
  });

  it("renders inline markdown delimiters split across soft breaks", function () {
    const input = "Use the **hard\nwrapped plugin name** inside Zotero.";
    const html = renderMarkdown(input);
    assert.include(html, "<strong>hard wrapped plugin name</strong>");
    assert.notInclude(html, "**hard");
  });

  it("keeps wrapped ordered-list continuations in the same item", function () {
    const input =
      "1. **Keep the note in the markdown file at the path\nabove** --\nyou can copy-paste it manually\n2. **Format it differently**";
    const html = renderMarkdown(input);
    assert.include(
      html,
      "<li><strong>Keep the note in the markdown file at the path above</strong> -- you can copy-paste it manually</li>",
    );
    assert.include(html, "<li><strong>Format it differently</strong></li>");
    assert.notInclude(html, "above**");
  });

  it("preserves explicit hard breaks inside paragraphs", function () {
    const input = "First line  \nSecond line\nThird line";
    const html = renderMarkdown(input);
    assert.include(html, "<p>First line<br/>Second line Third line</p>");
  });

  it("renders numeric-only inline math instead of treating it as currency", function () {
    const input =
      "The x-axis reaches $1$ million.\n\n- $0.001$\n- $0.003$\n- $0.01$";
    const html = renderMarkdown(input);
    assert.include(
      html,
      '<annotation encoding="application/x-tex">1</annotation>',
    );
    assert.include(
      html,
      '<annotation encoding="application/x-tex">0.001</annotation>',
    );
    assert.include(
      html,
      '<annotation encoding="application/x-tex">0.003</annotation>',
    );
    assert.include(
      html,
      '<annotation encoding="application/x-tex">0.01</annotation>',
    );
  });

  it("does not render ordinary adjacent currency amounts as math", function () {
    const input = "The prices are $5 and $10 before tax.";
    const html = renderMarkdown(input);
    assert.include(html, "<p>The prices are $5 and $10 before tax.</p>");
    assert.notInclude(html, "math-inline");
    assert.notInclude(html, "math-error");
  });

  it("renders valid inline math when unrelated currency is present", function () {
    const input = "$x$ costs $5 in the toy example.";
    const html = renderMarkdown(input);
    assert.include(
      html,
      '<annotation encoding="application/x-tex">x</annotation>',
    );
    assert.include(html, " costs $5 in the toy example.");
  });

  it("renders nested lists without flattening child items", function () {
    const html = renderMarkdown("- parent\n  - child\n- next");
    assert.include(html, "<li>parent<ul>");
    assert.include(html, "<li>child</li>");
    assert.include(html, "<li>next</li>");
  });

  it("renders GFM task lists and strikethrough", function () {
    const html = renderMarkdown("- [x] done\n- [ ] todo\n\n~~deleted~~");
    assert.include(html, 'type="checkbox"');
    assert.include(html, "checked");
    assert.include(html, "<del>deleted</del>");
  });

  it("renders autolinks and links containing parentheses", function () {
    const html = renderMarkdown(
      "Visit https://example.com and [paper](https://example.com/a(b)).",
    );
    assert.include(
      html,
      '<a href="https://example.com" target="_blank" rel="noopener">https://example.com</a>',
    );
    assert.include(html, 'href="https://example.com/a(b)"');
  });

  it("does not render unsafe link or image URLs", function () {
    const html = renderMarkdown(
      "[bad](javascript:alert(1)) ![x](vbscript:alert(1)) ![y](data:text/html;base64,AAAA)",
    );
    assert.notInclude(html.toLowerCase(), "javascript:");
    assert.notInclude(html.toLowerCase(), "vbscript:");
    assert.notInclude(html.toLowerCase(), "data:text/html");
    assert.notInclude(html, "<img");
  });

  it("escapes raw unsafe HTML while preserving safe attachment images", function () {
    const unsafe = renderMarkdown('<script>alert("x")</script>');
    assert.include(unsafe, "&lt;script&gt;");
    assert.notInclude(unsafe, "<script>");

    const safeImage = renderMarkdown(
      '<img data-attachment-key="ABC_123" alt="Figure 1" />',
    );
    assert.include(safeImage, 'data-attachment-key="ABC_123"');
    assert.include(safeImage, 'alt="Figure 1"');
  });

  it("renders simple raw HTML formatting tags without allowing attributes", function () {
    const html = renderMarkdown(
      "<strong>Core Method:</strong> The paper introduces <strong>Gamma-VAE</strong> and <em>latent geometry</em>.<br>Done.",
    );

    assert.include(html, "<strong>Core Method:</strong>");
    assert.include(html, "<strong>Gamma-VAE</strong>");
    assert.include(html, "<em>latent geometry</em>");
    assert.include(html, "<br/>Done.");
    assert.notInclude(html, "&lt;strong&gt;");

    const unsafe = renderMarkdown('<strong onclick="alert(1)">Core</strong>');
    assert.include(unsafe, "<strong>Core</strong>");
    assert.notInclude(unsafe, "<strong onclick");
  });

  it("renders escaped safe HTML tags from historical messages", function () {
    const html = renderMarkdown(
      "- &lt;strong&gt;Core Method:&lt;/strong&gt; The paper introduces &lt;strong&gt;Gamma-VAE&lt;/strong&gt;.\n- &lt;em&gt;Still formatted&lt;/em&gt;",
    );

    assert.include(html, "<li><strong>Core Method:</strong>");
    assert.include(html, "<strong>Gamma-VAE</strong>");
    assert.include(html, "<li><em>Still formatted</em></li>");
    assert.notInclude(html, "&lt;strong&gt;");
    assert.notInclude(html, "&amp;lt;strong");
  });

  it("does not leak bold tags in loose lists with quote citations", function () {
    const html = renderMarkdown(
      [
        "*   **Core Method:** The paper introduces **Gamma-VAE**.",
        "> quoted evidence",
        "(Kim et al., 2024)",
        "",
        "*   **Geometric Advantage:** It learns a **smoother** manifold.",
      ].join("\n"),
    );

    assert.include(html, "<strong>Core Method:</strong>");
    assert.include(html, "<strong>Gamma-VAE</strong>");
    assert.include(html, "<strong>Geometric Advantage:</strong>");
    assert.include(html, "<strong>smoother</strong>");
    assert.include(html, "<blockquote>");
    assert.notInclude(html, "&lt;strong&gt;");
  });

  it("does not restore escaped unsafe HTML tags", function () {
    const html = renderMarkdown(
      '&lt;script&gt;alert("x")&lt;/script&gt; &lt;a href=&quot;javascript:alert(1)&quot; onclick=&quot;alert(2)&quot;&gt;link&lt;/a&gt;',
    );

    assert.include(html, "&amp;lt;script&amp;gt;");
    assert.include(html, '<a target="_blank" rel="noopener">link</a>');
    assert.notInclude(html, "<script>");
    assert.notInclude(html, "onclick");
    assert.notInclude(html.toLowerCase(), "javascript:");
  });

  it("renders common safe raw HTML blocks without leaking tags", function () {
    const html = renderMarkdown(
      [
        "<h3>Summary</h3>",
        "<p><strong>Core Method:</strong> The paper introduces <em>Gamma-VAE</em>.</p>",
        "<ul><li><strong>Geometric Advantage:</strong> smoother manifold</li></ul>",
        "<blockquote><p>Quoted evidence</p></blockquote>",
        '<ol start="3"><li>Third item</li></ol>',
        '<a href="https://example.com">safe link</a>',
      ].join(""),
    );

    assert.include(html, "<h3>Summary</h3>");
    assert.include(html, "<p><strong>Core Method:</strong>");
    assert.include(html, "<ul><li><strong>Geometric Advantage:</strong>");
    assert.include(html, "<blockquote><p>Quoted evidence</p></blockquote>");
    assert.include(html, '<ol start="3"><li>Third item</li></ol>');
    assert.include(html, 'href="https://example.com"');
    assert.notInclude(html, "&lt;p&gt;");
    assert.notInclude(html, "&lt;ul&gt;");
    assert.notInclude(html, "&lt;li&gt;");
    assert.notInclude(html, "&lt;a");
  });

  it("strips unsafe raw HTML attributes and keeps unsafe tags escaped", function () {
    const html = renderMarkdown(
      '<p onclick="alert(1)">Safe text</p><script>alert("x")</script><a href="javascript:alert(1)" onclick="alert(2)">link</a>',
    );

    assert.include(html, "<p>Safe text</p>");
    assert.include(html, "&lt;script&gt;");
    assert.include(html, "alert(&quot;x&quot;)");
    assert.include(html, '<a target="_blank" rel="noopener">link</a>');
    assert.notInclude(html, "onclick");
    assert.notInclude(html.toLowerCase(), "javascript:");
    assert.notInclude(html, "<script>");
  });

  it("falls back to the Zotero renderer instead of escaped raw Markdown", function () {
    __setMarkdownParserDisabledForTest(true);
    try {
      const html = renderMarkdown(
        "## Methods\n\nThis is **important**.\n\n- one",
      );
      assert.include(html, "<h3>Methods</h3>");
      assert.include(html, "<strong>important</strong>");
      assert.include(html, "<li>one</li>");
      assert.notInclude(html, "## Methods");
      assert.notInclude(html, "**important**");
      assert.notInclude(html, "render-fallback");
    } finally {
      __setMarkdownParserDisabledForTest(false);
    }
  });
});

describe("renderMarkdown code block presentation", function () {
  it("renders normal fenced code as escaped code inside the polished shell", function () {
    const input = "```ts\nconst label = '<svg>';\n```";
    const html = renderMarkdown(input);
    assert.include(html, "llm-codeblock-shell");
    assert.include(html, "llm-codeblock-header");
    assert.include(html, "llm-codeblock-lang");
    assert.include(html, 'data-code-lang="ts"');
    assert.include(html, "hljs-keyword");
    assert.include(html, "&lt;svg&gt;");
    assert.notInclude(html, "llm-svg-preview");
  });

  it("syntax-highlights known fenced languages without changing copy source", function () {
    const input = [
      "```python",
      "def top_k(nums):",
      "    return sorted(nums)",
      "```",
    ].join("\n");
    const html = renderMarkdown(input);
    assert.include(html, 'data-code-lang="python"');
    assert.include(html, "language-python");
    assert.include(html, "hljs-keyword");
    assert.include(html, 'data-llm-copy-source="```python&#10;');
  });

  it("renders safe fenced SVG as a bounded preview while keeping source code", function () {
    const input = [
      "```svg",
      '<svg width="120" height="80">',
      '  <circle cx="40" cy="40" r="24" fill="red"/>',
      "</svg>",
      "```",
    ].join("\n");
    const html = renderMarkdown(input);
    assert.include(html, "llm-codeblock-shell");
    assert.include(html, 'data-code-lang="svg"');
    assert.include(html, "llm-svg-preview");
    assert.include(html, "data:image/svg+xml;base64,");
    assert.include(html, "data-llm-svg-source=");
    assert.notInclude(html, "data:image/svg+xml;charset=utf-8,");
    assert.include(html, "&lt;circle");
    assert.include(html, 'data-llm-copy-source="```svg&#10;');
  });

  it("renders fenced Mermaid as a hydratable preview while keeping source code", function () {
    const input = [
      "```mermaid",
      "flowchart TD",
      "  A[Continuous experience] --> B[LEC population activity]",
      "```",
    ].join("\n");
    const html = renderMarkdown(input);
    assert.include(html, "llm-codeblock-shell");
    assert.include(html, 'data-code-lang="mermaid"');
    assert.include(html, "llm-mermaid-preview");
    assert.include(html, 'data-mermaid-state="pending"');
    assert.include(html, "flowchart TD");
    assert.include(html, "Rendering diagram...");
    assert.include(html, 'data-llm-copy-source="```mermaid&#10;');
  });

  it("recognizes Mermaid aliases and fence metadata", function () {
    const input = [
      '``` mmd title="example"',
      "flowchart TD",
      '  A["One<br/>Two"] <--> B["Three"]',
      "```",
    ].join("\n");
    const html = renderMarkdown(input);

    assert.include(html, 'data-code-lang="mmd"');
    assert.include(html, "llm-mermaid-preview");
    assert.include(html, 'data-mermaid-state="pending"');
    assert.include(html, "A[&quot;One&lt;br/&gt;Two&quot;]");
    assert.include(
      html,
      'data-llm-copy-source="``` mmd title=&quot;example&quot;&#10;',
    );
  });

  it("falls back to a normal code block for unsafe SVG", function () {
    const input = [
      "```svg",
      '<svg width="120" height="80">',
      '  <script>alert("x")</script>',
      "</svg>",
      "```",
    ].join("\n");
    const html = renderMarkdown(input);
    assert.notInclude(html, "llm-svg-preview");
    assert.notInclude(html, "data:image/svg+xml");
    assert.include(html, "&lt;script&gt;");
  });

  it("keeps raw inline SVG escaped instead of rendering it as HTML", function () {
    const html = renderMarkdown('<svg><circle cx="4" cy="4" r="2"/></svg>');
    assert.include(html, "&lt;svg&gt;");
    assert.notInclude(html, "llm-svg-preview");
    assert.notInclude(html, "<svg><circle");
  });

  it("does not add chat SVG preview chrome for Zotero note rendering", function () {
    const input = [
      "```svg",
      '<svg width="120" height="80"><circle cx="40" cy="40" r="24"/></svg>',
      "```",
    ].join("\n");
    const html = renderMarkdownForNote(input);
    assert.notInclude(html, "llm-codeblock-shell");
    assert.notInclude(html, "llm-svg-preview");
    assert.include(html, '<pre class="lang-svg"><code>');
    assert.include(html, "&lt;svg");
  });

  it("does not add chat Mermaid preview chrome for Zotero note rendering", function () {
    const input = ["```mermaid", "flowchart TD", "  A --> B", "```"].join("\n");
    const html = renderMarkdownForNote(input);
    assert.notInclude(html, "llm-codeblock-shell");
    assert.notInclude(html, "llm-mermaid-preview");
    assert.include(html, '<pre class="lang-mermaid"><code>');
    assert.include(html, "flowchart TD");
  });
});

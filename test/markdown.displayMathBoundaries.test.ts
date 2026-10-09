import { assert } from "chai";
import { renderMarkdown, renderMarkdownForNote } from "../src/utils/markdown";

// The reported message had no blank lines around either display equation.
// The standalone '=' in the second equation made Marked consume both equations
// and the preceding prose as one Setext heading.
const reportedExcerpt = String.raw`The next step explains where quantiles come from. Fix $\alpha$ and focus on one expert’s $\beta_j$:
$$
f_j(\beta_j)
=q\beta_j+
\sum_i\max(0,s_{i,j}-\alpha_i-\beta_j).
$$
Away from the points where a term becomes zero, its slope is
$$
f_j'(\beta_j)
=
q-\#\{i:s_{i,j}-\alpha_i>\beta_j\}.
$$
This sentence should render as ordinary text.`;

describe("display math boundaries", function () {
  for (const [target, render] of [
    ["chat", renderMarkdown],
    ["note", renderMarkdownForNote],
  ] as const) {
    for (const [delimiter, excerpt] of [
      ["dollars", reportedExcerpt],
      [
        "brackets",
        reportedExcerpt.replace(/\$\$\n([\s\S]*?)\n\$\$/g, (_raw, math) => {
          return `\\[\n${math}\n\\]`;
        }),
      ],
    ]) {
      it(`renders the reported ${delimiter} equations next to prose in ${target}`, function () {
        const html = render(excerpt);

        assert.notMatch(html, /<h[1-6]>/);
        assert.include(
          html,
          "The next step explains where quantiles come from.",
        );
        assert.include(
          html,
          "<p>This sentence should render as ordinary text.</p>",
        );
        if (target === "chat") {
          assert.equal((html.match(/class="math-display"/g) || []).length, 2);
          assert.equal((html.match(/<annotation /g) || []).length, 4);
          assert.notInclude(html, "katex-error");
          assert.notInclude(html, "math-error");
        } else {
          assert.equal((html.match(/<pre class="math">/g) || []).length, 2);
          assert.include(html, "f_j&#039;(\\beta_j)\n=\nq-");
        }
      });
    }

    it(`continues to render equations separated by blank lines in ${target}`, function () {
      const html = render(
        reportedExcerpt.replace(/\n\$\$\n/g, () => "\n\n$$\n\n"),
      );

      assert.notMatch(html, /<h[1-6]>/);
      const displayPattern =
        target === "chat" ? /class="math-display"/g : /<pre class="math">/g;
      assert.equal((html.match(displayPattern) || []).length, 2);
      assert.include(
        html,
        "<p>This sentence should render as ordinary text.</p>",
      );
    });
  }

  it("preserves real Setext headings before and after an adjacent equation", function () {
    const html = renderMarkdown(
      "First heading\n===\nProse before the equation:\n$$\nf(x)\n=\nx+1\n$$\nSecond heading\n===",
    );

    assert.include(html, "<h2>First heading</h2>");
    assert.include(html, "<p>Prose before the equation:</p>");
    assert.include(html, "<h2>Second heading</h2>");
    assert.equal((html.match(/<h2>/g) || []).length, 2);
    assert.equal((html.match(/class="math-display"/g) || []).length, 1);
  });

  it("renders adjacent display math inside a blockquote", function () {
    const html = renderMarkdown(
      "> Prose before the equation:\n> $$\n> f(x)\n> =\n> x+1\n> $$\n> Ordinary text afterwards.",
    );

    assert.notMatch(html, /<h[1-6]>/);
    assert.include(html, "<blockquote><p>Prose before the equation:</p>");
    assert.equal((html.match(/class="math-display"/g) || []).length, 1);
    assert.include(html, "<p>Ordinary text afterwards.</p></blockquote>");
  });

  it("leaves equations in fenced code literal", function () {
    const source = "$$\nf(x)\n=\nx+1\n$$";
    const html = renderMarkdown(`\`\`\`text\n${source}\n\`\`\``);

    assert.include(html, `<pre class="lang-text"><code>${source}</code></pre>`);
    assert.notInclude(html, "math-display");
    assert.notMatch(html, /<h[1-6]>/);
  });

  it("preserves headings that mention an unmatched literal math delimiter", function () {
    assert.include(
      renderMarkdown("Literal $$ delimiter\n="),
      "<h2>Literal $$ delimiter</h2>",
    );
  });
});

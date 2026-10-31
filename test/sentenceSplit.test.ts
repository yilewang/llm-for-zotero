import { assert } from "chai";
import {
  findMathSpans,
  flattenText,
  hasHeadingLine,
  splitSentences,
  windowBodyRanges,
} from "../src/services/quotes/sentenceSplit";

/**
 * The shared sentence splitter does not break inside a math span: MinerU
 * writes "1.5" as "1 . 5" inside `$…$`, and a break there cut a cited
 * passage in the middle of its formula.
 */
describe("sentenceSplit math spans", function () {
  it("does not end a sentence inside inline math", function () {
    const text =
      "Mice were anesthetized with isoflurane $1 \\% - 3 \\%$ , plus oxygen at $1 { - } 1 . 5 \\ V \\mathrm { m i n } )$ ) anesthesia. Then they slept.";
    const spans = splitSentences(text);
    assert.deepEqual(
      spans.map((s) => s.text),
      [
        "Mice were anesthetized with isoflurane $1 \\% - 3 \\%$ , plus oxygen at $1 { - } 1 . 5 \\ V \\mathrm { m i n } )$ ) anesthesia.",
        "Then they slept.",
      ],
    );
  });

  it("slices the original text at the offsets it returns", function () {
    const text =
      "A value of $x . y$ was found. Display $$a . b$$ holds. Paren \\(c . d\\) too. End.";
    const spans = splitSentences(text);
    assert.deepEqual(
      spans.map((s) => s.text),
      [
        "A value of $x . y$ was found.",
        "Display $$a . b$$ holds.",
        "Paren \\(c . d\\) too.",
        "End.",
      ],
    );
    for (const span of spans)
      assert.equal(text.slice(span.start, span.end), span.text);
  });

  it("finds paired spans and gives up on unbalanced math", function () {
    assert.deepEqual(findMathSpans("a $x$ b $$y$$ c \\(z\\) d \\[w\\]"), [
      { start: 2, end: 5 },
      { start: 8, end: 13 },
      { start: 16, end: 21 },
      { start: 24, end: 29 },
    ]);
    assert.deepEqual(findMathSpans("price \\$5 only"), []);
    assert.deepEqual(findMathSpans("open $1 { - } 1 . only"), []);
    // Unbalanced math is not masked, so the split falls back to prose rules.
    assert.deepEqual(
      splitSentences("Open $1 . 5 and more. Next one.").map((s) => s.text),
      ["Open $1 .", "5 and more.", "Next one."],
    );
  });

  it("does not read two prices as a formula", function () {
    const text = "It cost $5. Then it rose to $10 per unit. Done.";
    assert.deepEqual(findMathSpans(text), []);
    assert.deepEqual(
      splitSentences(text).map((s) => s.text),
      ["It cost $5.", "Then it rose to $10 per unit.", "Done."],
    );
    // A formula still pairs when a digit sits inside it, not after it.
    assert.deepEqual(findMathSpans("About $x = 5$ here"), [
      { start: 6, end: 13 },
    ]);
  });

  describe("window body ranges", function () {
    const cut = (source: string, quote: string) => {
      const flat = flattenText(source);
      const start = flat.indexOf(quote);
      assert.isAtLeast(start, 0, quote);
      return windowBodyRanges(source, { start, end: start + quote.length }).map(
        (range) => flat.slice(range.start, range.end),
      );
    };
    const source =
      "Steering was predicted well. The fit was strong $( \\rho = 0 . 7 7$ , $p < 0 . 0 1$ ) overall. It held.";

    it("moves an end that fell inside a formula back to a sentence end", function () {
      assert.deepEqual(
        cut(
          source,
          "Steering was predicted well. The fit was strong $( \\rho = 0 . 7 7$ , $p < 0 .",
        ),
        ["Steering was predicted well."],
      );
    });

    it("moves a start that fell inside a formula on to the next sentence", function () {
      // An unclosed "$" here would pair with the next formula's opener.
      assert.deepEqual(
        cut(source, "0 . 7 7$ , $p < 0 . 0 1$ ) overall. It held."),
        ["It held."],
      );
    });

    it("drops a window with no whole sentence outside a formula", function () {
      assert.deepEqual(cut(source, "strong $( \\rho = 0 ."), []);
    });

    it("keeps a window that cut no formula", function () {
      const quote =
        "The fit was strong $( \\rho = 0 . 7 7$ , $p < 0 . 0 1$ ) overall.";
      assert.deepEqual(cut(source, quote), [quote]);
      // Unclear source math (a lone price) gives no span to protect.
      assert.deepEqual(cut("It paid $5 per animal. It held.", "It paid $5"), [
        "It paid $5",
      ]);
    });

    it("keeps body runs and drops heading text", function () {
      const text =
        "# Summary\n\nFirst body.\n\nSecond body.\n## Methods\nThird body.";
      assert.deepEqual(cut(text, flattenText(text)), [
        "First body. Second body.",
        "Third body.",
      ]);
      // A window cut into a heading keeps no part of it.
      assert.deepEqual(cut(text, "mary First body."), ["First body."]);
      assert.deepEqual(cut("# A heading of the paper", "heading of"), []);
    });
  });

  it("finds a Markdown heading line", function () {
    assert.isTrue(hasHeadingLine("# Summary\nBody text."));
    assert.isTrue(hasHeadingLine("Body text.\n## Methods"));
    assert.isFalse(hasHeadingLine("Body text with # inside.\n#hashtag line"));
  });
});

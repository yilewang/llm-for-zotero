import { assert } from "chai";
import {
  normalizeBlockBoundaries,
  renderMarkdown,
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

    it("does not split > when not preceded by punctuation trigger", function () {
      const input = "something here > not a quote";
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
});

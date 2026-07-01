import { assert } from "chai";
import {
  buildFindControllerQuoteQueries,
  buildRawPrefixQueries,
  findUniqueQuoteTextSearchMatch,
  normalizeLocatorText,
  splitQuoteAtEllipsis,
} from "../src/modules/contextPanel/quoteTextSearch";

describe("quoteTextSearch", function () {
  it("splits quotes at internal ellipsis and keeps meaningful segments", function () {
    const result = splitQuoteAtEllipsis(
      "...Preparatory activity is thought to provide top-down signals that enable rapid processing... The neural basis of this preparatory state involves distributed cortical networks...",
    );

    assert.equal(result.length, 2);
    assert.include(result[0], "Preparatory activity");
    assert.include(result[1], "neural basis");
  });

  it("builds raw reader queries from the longest ellipsis segment first", function () {
    const result = buildRawPrefixQueries(
      "Theorem 4.4 (Shell escape). ... evolution candidates have expected log-probability strictly beyond the shell boundary. Moreover, a positive fraction of evolution candidates escape the shell.",
    );

    assert.equal(
      result[0],
      "evolution candidates have expected log-probability strictly beyond the shell boundary. Moreover, a positive fraction of evolution candidates escape the shell.",
    );
    assert.isAbove(result.indexOf("escape the shell"), 0);
  });

  it("builds FindController queries that repair Unicode hyphen variants", function () {
    const result = buildFindControllerQuoteQueries(
      "T\u2011PHATE takes as input multi\u2011voxel activity patterns (that is, a matrix with timepoints/samples as rows and voxels/features as columns) and learns two 'views' among pairs of samples: a PHATE\u2011based affinity matrix and a temporal autocorrelation\u2011based affinity matrix.",
    );

    assert.isTrue(
      result.some((query) => query.includes("T-PHATE takes as input")),
      result.join("\n"),
    );
    assert.isTrue(
      result.some((query) =>
        query.includes("autocorrelation-based affinity matrix"),
      ),
      result.join("\n"),
    );
  });

  it("builds FindController queries from normalized source-match snippets", function () {
    const result = buildFindControllerQuoteQueries(
      "t phate takes as input multi voxel activity patterns that is a matrix with timepoints samples as rows and voxels features as columns and learns two views among pairs of samples a phate based affinity matrix and a temporal autocorrelation based affinity matrix",
    );

    assert.isTrue(
      result.some((query) => query.includes("t phate takes as input")),
      result.join("\n"),
    );
    assert.isTrue(
      result.some((query) =>
        query.includes("temporal autocorrelation based affinity matrix"),
      ),
      result.join("\n"),
    );
    assert.isFalse(
      result.some((query) => query.includes("t-phate takes as input")),
      result.join("\n"),
    );
    assert.isFalse(
      result.some((query) =>
        query.includes("temporal autocorrelation-based affinity matrix"),
      ),
      result.join("\n"),
    );
  });

  it("does not build weak two-token FindController fallbacks from source quotes", function () {
    const result = buildFindControllerQuoteQueries(
      "modulation of firing-rate adaptation strength within a continuous attractor model of place cells gives rise to these distinct forms of replay.",
    );

    assert.notInclude(result, "modulation of");
    assert.isTrue(
      result.some((query) =>
        query.includes("firing-rate adaptation strength within"),
      ),
      result.join("\n"),
    );
  });

  it("preserves non-ASCII locator text during normalization", function () {
    assert.equal(
      normalizeLocatorText("记忆痕迹在巩固过程中具有高度动态性。"),
      "记忆痕迹在巩固过程中具有高度动态性",
    );
  });

  it("does not hard-code English phrase splitting during normalization", function () {
    assert.equal(
      normalizeLocatorText("crossvalidated goodnessof gradientflow"),
      "crossvalidated goodnessof gradientflow",
    );
  });

  it("matches an exact Chinese quote against a unique Chinese source", function () {
    const quote = "记忆痕迹在巩固过程中具有高度动态性。";
    const match = findUniqueQuoteTextSearchMatch(
      [
        {
          id: "paper-a",
          text: quote,
        },
      ],
      quote,
    );

    assert.isNotNull(match);
    assert.equal(match?.entryId, "paper-a");
    assert.equal(match?.matchKind, "exact");
  });

  it("keeps duplicate Chinese snippets across sources unverified", function () {
    const quote = "记忆痕迹在巩固过程中具有高度动态性。";
    const match = findUniqueQuoteTextSearchMatch(
      [
        {
          id: "paper-a",
          text: quote,
        },
        {
          id: "paper-b",
          text: quote,
        },
      ],
      quote,
    );

    assert.isNull(match);
  });

  it("does not match a normalized query that starts inside a source token", function () {
    const match = findUniqueQuoteTextSearchMatch(
      [
        {
          id: "paper-a",
          text: "Neurodynamic states are controlled by training across sessions.",
        },
      ],
      "Dynamic states are controlled by training across sessions.",
      { includeProgressiveQueries: false },
    );

    assert.isNull(match);
  });

  it("does not match a normalized query that ends inside a source token", function () {
    const match = findUniqueQuoteTextSearchMatch(
      [
        {
          id: "paper-a",
          text: "Dynamic states are controlled by training across sessionstable dynamics.",
        },
      ],
      "Dynamic states are controlled by training across sessions.",
      { includeProgressiveQueries: false },
    );

    assert.isNull(match);
  });

  it("matches an incomplete quote when a unique prefix snippet is present", function () {
    const match = findUniqueQuoteTextSearchMatch(
      [
        {
          id: "paper-a",
          text: "We hypothesized that some brain states are easier for people to generate, and that tailoring training to these brain states will facilitate BCI learning.",
        },
      ],
      "We hypothesized that some brain states are easier for people to generate, and that tailoring training to these brain states will facilitate BCI learning. This added explanation was not in the source.",
    );

    assert.isNotNull(match);
    assert.equal(match?.entryId, "paper-a");
    assert.oneOf(match?.matchKind, ["raw-prefix", "progressive"]);
  });

  it("matches quote text when only an interior snippet is source text", function () {
    const match = findUniqueQuoteTextSearchMatch(
      [
        {
          id: "paper-a",
          text: "The encoder learned a nonlinear mapping from brain activity to the manifold in real time.",
        },
      ],
      "The assistant starts with unsupported wording. The encoder learned a nonlinear mapping from brain activity to the manifold in real time. Then it adds unsupported wording.",
    );

    assert.isNotNull(match);
    assert.equal(match?.entryId, "paper-a");
    assert.oneOf(match?.matchKind, ["raw-middle", "progressive"]);
  });

  it("keeps duplicate snippets across sources unverified", function () {
    const match = findUniqueQuoteTextSearchMatch(
      [
        {
          id: "paper-a",
          text: "The same sentence appears in both source documents.",
        },
        {
          id: "paper-b",
          text: "The same sentence appears in both source documents.",
        },
      ],
      "The same sentence appears in both source documents.",
    );

    assert.isNull(match);
  });

  it("rejects short generic snippets even when only one source contains them", function () {
    const match = findUniqueQuoteTextSearchMatch(
      [
        {
          id: "paper-a",
          text: "BCI learning improves when participants can generate reliable neural activity patterns.",
        },
      ],
      "BCI learning",
    );

    assert.isNull(match);
  });
});

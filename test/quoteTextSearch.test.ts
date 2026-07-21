import { assert } from "chai";
import {
  buildFindControllerFullCoverageQueries,
  buildFindControllerHighlightQueries,
  buildFindControllerQuoteQueries,
  findLargestQuoteTextAnchorMatch,
  findLargestUniqueQuoteTextAnchorMatch,
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

  it("keeps a Unicode-hyphen quote as one complete FindController query", function () {
    const quote =
      "T\u2011PHATE takes as input multi\u2011voxel activity patterns (that is, a matrix with timepoints/samples as rows and voxels/features as columns) and learns two 'views' among pairs of samples: a PHATE\u2011based affinity matrix and a temporal autocorrelation\u2011based affinity matrix.";
    const result = buildFindControllerQuoteQueries(quote);

    assert.deepEqual(result, [quote]);
  });

  it("builds only the complete exact quote for PDF reader search", function () {
    const quote =
      "Drift therefore provides a measurable signal that can reveal systems–level properties of biological plasticity mechanisms, such as their precision and effective learning rates.";
    const quoteQueries = buildFindControllerQuoteQueries(quote);
    const highlightQueries = buildFindControllerHighlightQueries(quote);

    assert.deepEqual(quoteQueries, [quote]);
    assert.deepEqual(highlightQueries, [quote]);
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

  it("does not build partial highlight fallbacks for moderate-length quotes", function () {
    const quote = [
      "In this study, we showed that representational similarity is preserved as a generic mathematical consequence of random connectivity.",
      "In random networks, pairwise similarities between inputs are largely reflected in the outputs, independent of the specific connectivity pattern.",
      "Drift merely transitions the network between random instantiations, leaving this similarity intact.",
    ].join(" ");
    const result = buildFindControllerHighlightQueries(quote, {
      maxQueries: 8,
      maxFullQueryLength: 1200,
      maxChunkLength: 900,
    });

    assert.isAbove(quote.length, 220);
    assert.deepEqual(result, [quote]);
  });

  it("builds only canonical full-coverage queries for selected text", function () {
    const selection =
      "The selected passage preserves a systems–level explanation across PDF line breaks, punctuation, and normalized whitespace.";
    const normalizedSelection = normalizeLocatorText(selection);
    const result = buildFindControllerFullCoverageQueries(selection);

    assert.isNotEmpty(result);
    assert.equal(result[0], selection);
    assert.isTrue(
      result.every(
        (query) => normalizeLocatorText(query) === normalizedSelection,
      ),
      result.join("\n"),
    );
  });

  it("preserves literal line breaks and soft hyphens in the sole full query", function () {
    const selection =
      "Complete selec\u00adtion text remains canonically equivalent\nwhen the PDF text layer changes whitespace.";
    const result = buildFindControllerFullCoverageQueries(selection);

    assert.isNotEmpty(result);
    assert.deepEqual(result, [selection]);
  });

  it("keeps complete full-coverage queries above 1,200 and 10,000 characters", function () {
    const selection = `${"complete selected text ".repeat(80)}ending`;
    const veryLongSelection = `${"complete page-native quote ".repeat(450)}ending`;

    assert.isAbove(selection.length, 1200);
    assert.isAbove(veryLongSelection.length, 10_000);
    assert.deepEqual(buildFindControllerFullCoverageQueries(selection), [
      selection,
    ]);
    assert.deepEqual(
      buildFindControllerFullCoverageQueries(veryLongSelection),
      [veryLongSelection],
    );
  });

  it("preserves non-ASCII locator text during normalization", function () {
    assert.equal(
      normalizeLocatorText("记忆痕迹在巩固过程中具有高度动态性。"),
      Array.from("记忆痕迹在巩固过程中具有高度动态性").join(" "),
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

  it("continues to fallback queries after a non-boundary exact occurrence", function () {
    const quote = [
      "Dynamic states are controlled by training across sessions.",
      "This added explanation is not part of the source passage.",
    ].join(" ");
    const match = findUniqueQuoteTextSearchMatch(
      [
        {
          id: "non-boundary",
          text: `prefix${quote}suffix`,
        },
        {
          id: "paper-a",
          text: [
            "Dynamic states are controlled by training across sessions.",
            "A separate source sentence follows.",
          ].join(" "),
        },
      ],
      quote,
    );

    assert.isNotNull(match);
    assert.equal(match?.entryId, "paper-a");
    assert.notEqual(match?.matchKind, "exact");
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

  it("selects the largest unique source span from an irregular ellipsized quote", function () {
    const source = [
      "We modeled the change in feedforward synaptic weights from a cortical layer of presynaptic neurons to a cortical layer of postsynaptic neurons as the sum of H and ξ scaled by a synaptic weight-dependent propensity function.",
      "This propensity function was inspired by experimental results showing that the magnitudes of changes in spine size are proportional to the initial size of the spines.",
    ].join(" ");
    const quote = [
      "We modeled the change in feedforward synaptic weights ... as the sum of H and ξ scaled by a synaptic weight-dependent propensity function.",
      "This propensity function was inspired by experimental results showing that the magnitudes of changes in spine size are proportional to the initial size of the spines.",
    ].join(" ");
    const match = findLargestUniqueQuoteTextAnchorMatch(
      [{ id: "bauer-page", text: source }],
      quote,
    );

    assert.isNotNull(match);
    assert.equal(match?.entryId, "bauer-page");
    assert.equal(match?.matchKind, "ellipsis-segment");
    assert.equal(
      match?.query,
      "as the sum of H and ξ scaled by a synaptic weight-dependent propensity function. This propensity function was inspired by experimental results showing that the magnitudes of changes in spine size are proportional to the initial size of the spines.",
    );
    assert.equal(match?.totalOccurrences, 1);
  });

  it("uses the unique prose prefix when PDF math encoding breaks the remainder", function () {
    const quote =
      "We modeled the propensity function to be weight-dependent ρ(w)=tanh⁡(10w) based on experimental observations.";
    const source =
      "We modeled the propensity function to be weight-dependent ρðwÞ ¼ tanhð10wÞ based on experimental observations.";
    const match = findLargestUniqueQuoteTextAnchorMatch(
      [{ id: "bauer-methods", text: source }],
      quote,
    );

    assert.isNotNull(match);
    assert.equal(match?.entryId, "bauer-methods");
    assert.equal(
      match?.query,
      "We modeled the propensity function to be weight-dependent",
    );
    assert.equal(match?.matchKind, "raw-prefix");
    assert.equal(match?.totalOccurrences, 1);
  });

  it("does not navigate a largest partial anchor that is repeated", function () {
    const quote =
      "We modeled the propensity function to be weight-dependent ρ(w)=tanh(10w).";
    const repeated =
      "We modeled the propensity function to be weight-dependent ρðwÞ ¼ tanhð10wÞ.";
    const entries = [
      { id: "page-1", text: repeated },
      { id: "page-2", text: repeated },
    ];

    assert.isNull(findLargestUniqueQuoteTextAnchorMatch(entries, quote));
    assert.isNotNull(findLargestQuoteTextAnchorMatch(entries, quote));
  });

  it("recovers a unique CJK source span despite two-column line interleaving", function () {
    const quote =
      "有学者将疼痛体验分成痛觉感觉和痛觉情感两个成分，其中痛觉感觉成分加工判断疼痛的不同属性，如位置、强度和持续时间；痛觉情感成分负责加工痛觉中让人不愉悦的方面。";
    const twoColumnExtraction = [
      "有学者将疼痛体验分成痛觉感觉和痛觉情感两 另一栏无关文字",
      "个成分，其中痛觉感觉成分加工判断疼痛的不同属 另一栏继续",
      "性，如位置、强度和持续时间；痛觉情感成分负责 另一栏结束",
      "加工痛觉中让人不愉悦的方面。",
    ].join("\n");
    const match = findLargestUniqueQuoteTextAnchorMatch(
      [{ id: "cjk-page", text: twoColumnExtraction }],
      quote,
    );

    assert.isNotNull(match);
    assert.equal(match?.entryId, "cjk-page");
    assert.include(match?.query || "", "痛觉感觉成分加工");
    assert.notInclude(match?.query || "", "另一栏");
    assert.isAtLeast(match?.matchedTokenCount || 0, 12);
  });
});

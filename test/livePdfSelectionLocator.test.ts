import { assert } from "chai";
import {
  locateQuoteInPageTexts,
  locateSelectionInPageTexts,
  stripBoundaryEllipsis,
  splitQuoteAtEllipsis,
  buildRawPrefixQueries,
  locateQuoteByRawPrefixInPages,
  scrollToExactQuoteInReader,
} from "../src/modules/contextPanel/livePdfSelectionLocator";

describe("livePdfSelectionLocator", function () {
  it("resolves a unique selection to the matching page", function () {
    const result = locateSelectionInPageTexts(
      [
        {
          pageIndex: 0,
          text: "Introduction to the paper.",
        },
        {
          pageIndex: 1,
          text: "Representational drift remained stable across repeated measurements.",
        },
      ],
      "Representational drift remained stable across repeated measurements.",
      1,
    );

    assert.equal(result.status, "resolved");
    assert.equal(result.confidence, "high");
    assert.equal(result.expectedPageIndex, 1);
    assert.equal(result.computedPageIndex, 1);
    assert.deepEqual(result.matchedPageIndexes, [1]);
  });

  it("marks repeated matches as ambiguous", function () {
    const result = locateSelectionInPageTexts(
      [
        {
          pageIndex: 0,
          text: "The baseline improved on this benchmark.",
        },
        {
          pageIndex: 1,
          text: "A replication found that the baseline improved on this benchmark.",
        },
      ],
      "The baseline improved on this benchmark.",
      0,
    );

    assert.equal(result.status, "ambiguous");
    assert.isNull(result.computedPageIndex);
    assert.deepEqual(result.matchedPageIndexes, [0, 1]);
  });

  it("resolves repeated quote matches when they stay on one page", function () {
    const result = locateSelectionInPageTexts(
      [
        {
          pageIndex: 0,
          text: "The baseline improved on this benchmark. Later, the baseline improved on this benchmark.",
        },
      ],
      "The baseline improved on this benchmark.",
      0,
      {
        queryLabel: "Quote",
        resolveSinglePageDuplicates: true,
      },
    );

    assert.equal(result.status, "resolved");
    assert.equal(result.confidence, "low");
    assert.equal(result.computedPageIndex, 0);
    assert.deepEqual(result.matchedPageIndexes, [0]);
  });

  it("uses prefix-suffix fallback for hyphenated page text", function () {
    const result = locateSelectionInPageTexts(
      [
        {
          pageIndex: 0,
          text: "Representational drift was ob-\nserved consistently over time in the population response.",
        },
      ],
      "Representational drift was observed consistently over time in the population response.",
      0,
    );

    assert.equal(result.status, "resolved");
    assert.oneOf(result.confidence, ["high", "medium"]);
    assert.equal(result.computedPageIndex, 0);
  });

  it("rejects very short selections", function () {
    const result = locateSelectionInPageTexts(
      [
        {
          pageIndex: 0,
          text: "Tiny sample page text.",
        },
      ],
      "Tiny",
      0,
    );

    assert.equal(result.status, "selection-too-short");
    assert.isNull(result.computedPageIndex);
  });

  it("resolves a truncated long quote using prefix-suffix matching", function () {
    const pages = [
      {
        pageIndex: 0,
        text: "Background material that does not matter here.",
      },
      {
        pageIndex: 23,
        text: "When each GC samples only a restricted subset of MCs, inhibitory feedback cannot selectively cancel shared components of two odor representations without also affecting their unique components. As a result, learning reduces overlap only approximately, leaving residual responses in the perpendicular to the original representation subspace directions. This residual activity manifests as a rotation of the encoding subspace, or representational drift. Similar ideas have been proposed elsewhere. For example, Kong et al. suggested that differences in structural connectivity sparsity could account for the contrasting levels of drift observed in hippocampal CA1 versus CA3. The existence of structural constraints does not rule out stochastic fluctuations, but our findings suggest that, in the OB, fixed architecture may be a major contributor to drift.",
      },
    ];

    const result = locateQuoteInPageTexts(
      pages,
      "stricted subset of MCs, inhibitory feedback cannot selectively cancel shared components of two odor representations without also affecting their unique components. As a result, learning reduces overlap only approximately, leaving residual responses in the perpendicular to the original representation subspace directions. This residual activity manifests as a rotation of the encoding subspace, or representational drift (Fig. 4C-E). Similar ideas have been proposed elsewhere. For example, Kong et al. (Kong et al., 2024; Zabeh et al., 2025) suggested that differences in structural connectivity sparsity could account for the contrasting levels of drift observed in hippocampal CA1 versus CA3. The existence of structural constraints does not rule out stochastic fluctuations, but our findings suggest that, in the OB, fixed architecture may be a major contributor to drift",
      23,
    );

    assert.equal(result.status, "resolved");
    assert.oneOf(result.confidence, ["medium", "high"]);
    assert.equal(result.computedPageIndex, 23);
  });

  it("keeps quote matches ambiguous when exact text appears on multiple pages", function () {
    const duplicatedPassage =
      "learning reduces overlap only approximately leaving residual responses in the perpendicular to the original representation subspace directions";
    const result = locateQuoteInPageTexts(
      [
        {
          pageIndex: 4,
          text: `Context before. ${duplicatedPassage}. Context after.`,
        },
        {
          pageIndex: 9,
          text: `Another section. ${duplicatedPassage}. Ending text.`,
        },
      ],
      duplicatedPassage,
      4,
    );

    assert.equal(result.status, "ambiguous");
    assert.isNull(result.computedPageIndex);
    assert.deepEqual(result.matchedPageIndexes, [4, 9]);
  });

  it("returns not-found for quotes with math fragments absent from the page text", function () {
    const result = locateQuoteInPageTexts(
      [
        {
          pageIndex: 6,
          text: "The objective includes a regularization term and the model converges to a stable solution after alternating optimization.",
        },
      ],
      "The objective includes a regularization term lambda = 0.5 + beta_t and the model converges to a stable solution after alternating optimization.",
      6,
    );

    // Without anchor-based voting, the search cannot bridge math
    // fragments that the LLM added but are not in the page text.
    assert.equal(result.status, "not-found");
  });

  it("resolves punctuation-heavy truncated classifier quotes", function () {
    const result = locateQuoteInPageTexts(
      [
        {
          pageIndex: 1,
          text: "We used a linear Support Vector Machine with soft margins. Features were standardized (z-scored), and the soft margin parameter C was set to 1. For within-day classification, we used leave-one-out cross-validation, testing classifier prediction on each trial that was left out. Accuracy was reported as the average across all left-out trials. For across-day classification, we trained the SVM on all trials from one day and tested on all trials from another day. Performance on shuffled data was assessed separately.",
        },
      ],
      "ear Support Vector Machine with soft margins. Features were standardized (z-scored), and the soft margin parameter C was set to 1. For within-day classification, we used leave-one-out cross-validation, testing classifier prediction on each trial that was left out. Accuracy was reported as the average across all left-out trials. For across-day classification, we trained the SVM on all trials from one day and tested on all trials from another day. Performance on shuffled data was as",
      1,
    );

    assert.equal(result.status, "resolved");
    assert.equal(result.computedPageIndex, 1);
  });
});

describe("stripBoundaryEllipsis", function () {
  it("strips leading three-dot ellipsis", function () {
    assert.equal(
      stripBoundaryEllipsis(
        "...Preparatory activity is thought to provide top-down signals",
      ),
      "Preparatory activity is thought to provide top-down signals",
    );
  });

  it("strips trailing three-dot ellipsis", function () {
    assert.equal(
      stripBoundaryEllipsis("Preparatory activity is thought to provide..."),
      "Preparatory activity is thought to provide",
    );
  });

  it("strips both leading and trailing ellipsis", function () {
    assert.equal(
      stripBoundaryEllipsis("...Preparatory activity..."),
      "Preparatory activity",
    );
  });

  it("strips unicode ellipsis character", function () {
    assert.equal(
      stripBoundaryEllipsis("\u2026Preparatory activity\u2026"),
      "Preparatory activity",
    );
  });

  it("strips bracketed ellipsis", function () {
    assert.equal(
      stripBoundaryEllipsis("[...] Preparatory activity [...]"),
      "Preparatory activity",
    );
  });

  it("preserves internal ellipsis", function () {
    assert.equal(
      stripBoundaryEllipsis("...first part... second part..."),
      "first part... second part",
    );
  });

  it("returns text unchanged when no boundary ellipsis", function () {
    assert.equal(
      stripBoundaryEllipsis("Preparatory activity is normal text"),
      "Preparatory activity is normal text",
    );
  });
});

describe("splitQuoteAtEllipsis", function () {
  it("returns single-element array for quotes without internal ellipsis", function () {
    const result = splitQuoteAtEllipsis(
      "Preparatory activity is thought to provide top-down signals",
    );
    assert.deepEqual(result, [
      "Preparatory activity is thought to provide top-down signals",
    ]);
  });

  it("splits at internal three-dot ellipsis", function () {
    const result = splitQuoteAtEllipsis(
      "...Preparatory activity is thought to provide top-down signals that enable rapid processing... The neural basis of this preparatory state involves distributed cortical networks...",
    );
    assert.equal(result.length, 2);
    assert.include(result[0], "Preparatory activity");
    assert.include(result[1], "neural basis");
  });

  it("sorts segments by length descending", function () {
    const result = splitQuoteAtEllipsis(
      "Short segment of minimal text length... A much longer segment that contains many more words and provides additional context for the reader",
    );
    assert.isAbove(result[0].length, result[result.length - 1].length);
  });

  it("filters out segments shorter than 30 characters", function () {
    const result = splitQuoteAtEllipsis(
      "tiny... A much longer segment that provides adequate context for search matching purposes",
    );
    assert.equal(result.length, 1);
    assert.include(result[0], "longer segment");
  });

  it("handles unicode ellipsis character", function () {
    const result = splitQuoteAtEllipsis(
      "\u2026Preparatory activity is thought to provide top-down signals\u2026 The neural basis of this preparatory state involves distributed\u2026",
    );
    assert.equal(result.length, 2);
    assert.isTrue(result.some((s) => s.includes("Preparatory activity")));
    assert.isTrue(result.some((s) => s.includes("neural basis")));
  });

  it("strips boundary ellipsis before splitting", function () {
    const result = splitQuoteAtEllipsis(
      "...clean text without any internal ellipsis markers present here...",
    );
    assert.deepEqual(result, [
      "clean text without any internal ellipsis markers present here",
    ]);
  });
});

describe("buildRawPrefixQueries", function () {
  it("returns full text and prefixes for a long quote", function () {
    const quote =
      "Simulation analysis of drift mechanisms using normalized odor velocity in the olfactory bulb context.";
    const result = buildRawPrefixQueries(quote);
    // A boundary-cleaned full phrase comes first, followed by shorter phrase queries.
    assert.isAbove(result.length, 1);
    assert.equal(
      result[0],
      "Simulation analysis of drift mechanisms using normalized odor velocity in the olfactory bulb context",
    );
    // Each prefix should be trimmed to a word boundary
    for (const q of result) {
      assert.isFalse(q.endsWith(" "), "no trailing space");
      assert.isAtLeast(q.length, 12, "each query is at least 12 chars");
    }
  });

  it("returns empty for very short text", function () {
    const result = buildRawPrefixQueries("short");
    assert.deepEqual(result, []);
  });

  it("puts the full text first when short enough", function () {
    const quote =
      "A moderately long sentence that is under two hundred and twenty characters.";
    const result = buildRawPrefixQueries(quote);
    assert.equal(
      result[0],
      "A moderately long sentence that is under two hundred and twenty characters",
    );
  });

  it("trims prefixes to word boundaries", function () {
    const quote =
      "The representational drift observed in neural populations is a fundamental phenomenon worth studying.";
    const result = buildRawPrefixQueries(quote);
    for (const q of result) {
      // Should not end with a partial word (space followed by chars at end)
      assert.match(q, /\S$/, "ends with a non-space");
    }
  });

  it("strips wrapper quotes and includes suffix-style phrase queries", function () {
    const quote =
      "“Pattern separation, pattern completion, and new neuronal codes within a continuous CA3 map”";
    const result = buildRawPrefixQueries(quote);

    assert.equal(
      result[0],
      "Pattern separation, pattern completion, and new neuronal codes within a continuous CA3 map",
    );
    assert.isTrue(
      result.some((query) => query.includes("within a continuous CA3 map")),
    );
    assert.isFalse(result.some((query) => query.startsWith("“")));
  });
});

describe("scrollToExactQuoteInReader", function () {
  function createFindControllerReader(pageMatches: unknown[]) {
    const findController = {
      _rawQuery: "",
      pageMatches: [] as unknown[],
      _pendingFindMatches: new Set<unknown>(),
      _pagesToSearch: 0,
    };
    const eventBus = {
      dispatch: (_eventName: string, params: { query: string }) => {
        findController._rawQuery = params.query;
        findController.pageMatches = pageMatches;
      },
    };
    return {
      _window: {
        PDFViewerApplication: {
          pdfDocument: { numPages: 3 },
          pagesCount: 3,
          page: 2,
          eventBus,
          findController,
        },
      },
    };
  }

  it("reports a matched paragraph jump when FindController hits the target page", async function () {
    const reader = createFindControllerReader([[], [0], []]);
    const result = await scrollToExactQuoteInReader(
      reader,
      "Representational drift remained stable across repeated measurements in the target region.",
      { expectedPageIndex: 1 },
    );

    assert.isTrue(result.matched);
    assert.equal(result.expectedPageIndex, 1);
    assert.equal(result.matchedPageIndex, 1);
    assert.isString(result.queryUsed);
    assert.isAtLeast(result.queries.length, 1);
  });

  it("trusts FindController when it matches a different page than the text-search hint", async function () {
    const reader = createFindControllerReader([[0], [], []]);
    const result = await scrollToExactQuoteInReader(
      reader,
      "Representational drift remained stable across repeated measurements in the target region.",
      { expectedPageIndex: 1 },
    );

    assert.isTrue(result.matched);
    assert.equal(result.expectedPageIndex, 1);
    assert.equal(result.matchedPageIndex, 0);
    assert.include(result.reason, "page 1");
    assert.isAtLeast(result.queries.length, 1);
    assert.isAtLeast(result.debugSummary.length, 1);
  });
});

describe("locateQuoteByRawPrefixInPages", function () {
  const samplePages = [
    {
      pageIndex: 0,
      pageLabel: "1",
      text: "Introduction to neural coding and olfactory perception in the mammalian brain.",
    },
    {
      pageIndex: 1,
      pageLabel: "2",
      text: "We found that, in the bulb, the degradation of linear classifier performance across days was numerically comparable to that reported in the cortex.",
    },
    {
      pageIndex: 2,
      pageLabel: "3",
      text: "Simulation analysis of drift mechanisms using normalized odor velocity in the olfactory bulb context.",
    },
    {
      pageIndex: 3,
      pageLabel: "4",
      text: "Discussion and conclusions about representational drift.",
    },
  ];

  it("finds a quote using the first few words", function () {
    const result = locateQuoteByRawPrefixInPages(
      samplePages,
      "We found that, in the bulb, the degradation of linear classifier performance across days was numerically comparable to that reported in the cortex.",
      null,
    );
    assert.isNotNull(result);
    assert.equal(result!.status, "resolved");
    assert.equal(result!.computedPageIndex, 1);
  });

  it("finds a quote even when only the beginning matches", function () {
    const result = locateQuoteByRawPrefixInPages(
      samplePages,
      "Simulation analysis of drift mechanisms using normalized odor velocity in the olfactory bulb context. This extra text was fabricated by the LLM.",
      null,
    );
    assert.isNotNull(result);
    assert.equal(result!.status, "resolved");
    assert.equal(result!.computedPageIndex, 2);
  });

  it("prefers the longest unique raw-prefix query over a shorter false match", function () {
    const result = locateQuoteByRawPrefixInPages(
      [
        {
          pageIndex: 0,
          pageLabel: "1",
          text: "We choose Hebbian learning, not only for its biological plausibility.",
        },
        {
          pageIndex: 22,
          pageLabel: "23",
          text: "We choose Hebbian learning, not only for its biological plausibility, but to also allow rapid learning when entering a new environment.",
        },
      ],
      "We choose Hebbian learning, not only for its biological plausibility, but to also allow rapid learning when entering a new environment.",
      null,
    );

    assert.isNotNull(result);
    assert.equal(result!.status, "resolved");
    assert.equal(result!.computedPageIndex, 22);
  });

  it("returns null when quote is not in any page", function () {
    const result = locateQuoteByRawPrefixInPages(
      samplePages,
      "This sentence does not appear anywhere in the document at all whatsoever.",
      null,
    );
    assert.isNull(result);
  });

  it("returns null for very short quotes", function () {
    const result = locateQuoteByRawPrefixInPages(samplePages, "short", null);
    assert.isNull(result);
  });

  it("handles quotes with punctuation differences via normalization", function () {
    const result = locateQuoteByRawPrefixInPages(
      samplePages,
      "We found that in the bulb the degradation of linear classifier performance across days",
      null,
    );
    assert.isNotNull(result);
    assert.equal(result!.computedPageIndex, 1);
  });
});

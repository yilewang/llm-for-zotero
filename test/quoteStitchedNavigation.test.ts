import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acceptsOpenedQuoteMatchForTests,
  locatedResultIdentifiesQuoteSourceForTests as identifiesQuoteSource,
} from "../src/modules/contextPanel/assistantCitationLinks";
import { locateQuoteInPageTexts } from "../src/modules/contextPanel/livePdfSelectionLocator";
import { summarizeQuoteTextSupport } from "../src/modules/contextPanel/quoteTextSearch";

/**
 * A quote a model wrote by stitching two passages of one paper together. This
 * is the ordinary case, not an edge case: writers quote by cutting.
 */
const FIRST_PASSAGE =
  "long-timescale changes in population activity occur orthogonally to the representation of context in network space";
const SECOND_PASSAGE =
  "allowing for a consistent readout of contextual information across many weeks of recording";
const STITCHED_QUOTE = `"${FIRST_PASSAGE}… ${SECOND_PASSAGE}."`;

function page(pageIndex: number, text: string) {
  return { pageIndex, pageLabel: `${pageIndex + 1}`, text };
}

const SOURCE_PAPER = [
  page(
    0,
    "Introduction. Representational drift has been reported across many cortical areas and in hippocampus.",
  ),
  page(
    1,
    `Results. We found that ${FIRST_PASSAGE}. Population geometry was preserved throughout. Across sessions this meant ${SECOND_PASSAGE}, which we quantified below.`,
  ),
  page(2, "Discussion. These results constrain models of stable readout."),
];

/** Shares one long phrase with the source, as a citing paper would. */
const DECOY_PAPER = [
  page(
    0,
    `Prior work showed that ${FIRST_PASSAGE}, a result we build on here with a different preparation and a different task.`,
  ),
  page(1, "We instead measured tuning stability under anaesthesia."),
];

describe("stitched quote navigation", function () {
  describe("summarizeQuoteTextSupport", function () {
    it("credits a paper for every piece of a stitched quote, not just the longest", function () {
      const support = summarizeQuoteTextSupport(
        SOURCE_PAPER.map((p) => ({ id: `page-${p.pageIndex}`, text: p.text })),
        STITCHED_QUOTE,
      );

      assert.isAtLeast(
        support.coverage,
        0.8,
        "the source paper accounts for the whole quote",
      );
    });

    it("pools pieces that straddle a page break", function () {
      const split = [
        page(0, `Results. We found that ${FIRST_PASSAGE}.`),
        page(1, `Across sessions this meant ${SECOND_PASSAGE}.`),
      ];

      const support = summarizeQuoteTextSupport(
        split.map((p) => ({ id: `page-${p.pageIndex}`, text: p.text })),
        STITCHED_QUOTE,
      );

      assert.isAtLeast(
        support.coverage,
        0.8,
        "a quote cut across a page break is still fully accounted for",
      );
    });

    it("does not credit a paper that only shares one passage", function () {
      const support = summarizeQuoteTextSupport(
        DECOY_PAPER.map((p) => ({ id: `page-${p.pageIndex}`, text: p.text })),
        STITCHED_QUOTE,
      );

      assert.isBelow(
        support.coverage,
        0.8,
        "sharing one phrase must not make a paper the source",
      );
      assert.isAbove(support.coverage, 0, "the shared phrase is still counted");
    });

    it("reports nothing for a quote no source contains", function () {
      const support = summarizeQuoteTextSupport(
        SOURCE_PAPER.map((p) => ({ id: `page-${p.pageIndex}`, text: p.text })),
        '"the hippocampus maintains a dedicated subspace for grocery lists across decades"',
      );

      assert.equal(support.supportedQuoteTokenCount, 0);
      assert.equal(support.coverage, 0);
    });
  });

  describe("locateQuoteInPageTexts", function () {
    it("locates a stitched quote and reports how much of it the paper holds", function () {
      const result = locateQuoteInPageTexts(SOURCE_PAPER, STITCHED_QUOTE, null);

      assert.equal(result.status, "resolved");
      assert.equal(result.computedPageIndex, 1, "lands on the first piece");
      assert.isAtLeast(
        result.sourceMatchQuoteTokenSupportCoverage ?? 0,
        0.8,
        "the whole-document figure is what identifies the paper",
      );
    });

    it("still reports the weaker single-span figure alongside it", function () {
      const result = locateQuoteInPageTexts(SOURCE_PAPER, STITCHED_QUOTE, null);

      // Judging by this number alone is what wrongly rejected the real quote.
      const span = result.sourceMatchQuoteTokenCoverage;
      assert.isDefined(span);
      assert.isBelow(span as number, 1);
    });

    it("refuses a paper that merely quotes one of the passages", function () {
      const result = locateQuoteInPageTexts(DECOY_PAPER, STITCHED_QUOTE, null);

      assert.isFalse(
        identifiesQuoteSource(result),
        "a shared passage must not authorise a jump",
      );
    });

    it("accepts the paper that actually holds the stitched quote", function () {
      const result = locateQuoteInPageTexts(SOURCE_PAPER, STITCHED_QUOTE, null);

      assert.isTrue(identifiesQuoteSource(result));
    });

    it("refuses a paper credited only by unioning disjoint stock phrases", function () {
      // Coverage alone cannot tell a real passage from several stock phrases
      // stitched together, which is why the longest run has a floor too.
      const quote =
        '"we recorded from hippocampal CA1 across sessions and found that population activity was not stable while behavioural performance remained unchanged over weeks"';
      const sameFieldPaper = [
        page(
          0,
          "Methods. we recorded from hippocampal CA1 across sessions using chronically implanted probes.",
        ),
        page(
          1,
          "Results. In this preparation population activity was not stable across the window.",
        ),
        page(
          2,
          "Discussion. Throughout training behavioural performance remained unchanged over weeks.",
        ),
      ];

      const result = locateQuoteInPageTexts(sameFieldPaper, quote, null);

      assert.isAtLeast(
        result.sourceMatchQuoteTokenSupportCoverage ?? 0,
        0.8,
        "coverage alone would have accepted it",
      );
      assert.isFalse(
        identifiesQuoteSource(result),
        "no single passage is substantial enough to call this the source",
      );
    });

    it("does not claim full coverage merely because the pieces matched", function () {
      // Reporting a hard-coded 1 here would hand the guard a number nobody
      // measured, which is the failure this whole change exists to remove.
      const first = "drift was confined to the null coding space throughout";
      const second =
        "behavioural readout remained accurate over the full recording period";
      const pages = [
        page(0, `Results. We show that ${first}.`),
        page(1, `Discussion. Consequently ${second}.`),
      ];

      const result = locateQuoteInPageTexts(
        pages,
        `"${first}… ${second}… a third piece this paper does not contain at all."`,
        null,
      );

      const pooled = result.sourceMatchQuoteTokenSupportCoverage;
      if (pooled !== undefined) {
        assert.isBelow(
          pooled,
          1,
          "a piece the paper lacks must lower the reported coverage",
        );
      }
    });

    it("verifies an ellipsized quote piece by piece, landing on the first piece", function () {
      const first = "drift was confined to the null coding space throughout";
      const second =
        "behavioural readout remained accurate over the full recording period";
      const pages = [
        page(0, "Abstract. We summarise the main finding below."),
        page(1, `Results. We show that ${first}.`),
        page(2, `Discussion. Consequently ${second}.`),
      ];

      const result = locateQuoteInPageTexts(
        pages,
        `"${first}… ${second}."`,
        null,
      );

      assert.equal(result.status, "resolved");
      assert.include(
        result.reason || "",
        "Every piece of the ellipsized quote",
      );
      assert.equal(
        result.computedPageIndex,
        1,
        "the reader lands where the quote starts",
      );
      assert.deepEqual(result.matchedPageIndexes, [1, 2]);
    });

    it("does not treat pieces found out of order as a verified assembly", function () {
      const first = "drift was confined to the null coding space throughout";
      const second =
        "behavioural readout remained accurate over the full recording period";
      const pages = [
        page(0, `Discussion. Consequently ${second}.`),
        page(1, `Results. We show that ${first}.`),
      ];

      const result = locateQuoteInPageTexts(
        pages,
        `"${first}… ${second}."`,
        null,
      );

      assert.notInclude(
        result.reason || "",
        "Every piece of the ellipsized quote",
      );
    });

    it("does not treat same-page pieces in reverse order as an assembly", function () {
      // Same-page stitching is the common case, so an order rule that only
      // compared page numbers would be vacuous exactly where it matters.
      const first = "drift was confined to the null coding space throughout";
      const second =
        "behavioural readout remained accurate over the full recording period";
      const pages = [
        page(0, `Discussion. Consequently ${second}, even though ${first}.`),
      ];

      const result = locateQuoteInPageTexts(
        pages,
        `"${first}… ${second}."`,
        null,
      );

      assert.notInclude(
        result.reason || "",
        "Every piece of the ellipsized quote",
      );
    });

    it("does not treat an ambiguous piece as a verified assembly", function () {
      const repeated = "drift was confined to the null coding space throughout";
      const tail =
        "behavioural readout remained accurate over the full recording period";
      const pages = [
        page(0, `Abstract. We show that ${repeated}.`),
        page(1, `Results. We show that ${repeated}, and ${tail}.`),
      ];

      const result = locateQuoteInPageTexts(
        pages,
        `"${repeated}… ${tail}."`,
        null,
      );

      assert.notInclude(
        result.reason || "",
        "Every piece of the ellipsized quote",
        "a piece that appears twice cannot pin the assembly",
      );
    });
  });
});

describe("citation navigation contracts", function () {
  const source = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../src/modules/contextPanel/assistantCitationLinks.ts",
    ),
    "utf8",
  );

  it("asks the answer's own run before searching the library", function () {
    const navigateSection = source.slice(
      source.indexOf("async function navigateUntrustedQuoteCitation(params: {"),
      source.indexOf(
        "async function resolveAndNavigateAssistantCitation(params: {",
      ),
    );

    assert.include(navigateSection, "resolveRecordedQuoteSourceCandidates");
    // Recorded papers are used instead of a search, and the search is still
    // there as a fallback when none of them holds the quote.
    assert.include(navigateSection, "recordedCandidates.length");
    assert.include(navigateSection, "searchForCandidates()");
    assert.isBelow(
      navigateSection.indexOf("resolveRecordedQuoteSourceCandidates"),
      navigateSection.indexOf("searchForCandidates"),
    );
  });

  it("checks the chat's own collection before the rest of the library", function () {
    const searchSection = source.slice(
      source.indexOf(
        "async function resolveCitationCandidatesFromLibrarySearch(",
      ),
      source.indexOf("async function buildOrderedCitationCandidates("),
    );

    assert.include(searchSection, "scopeCollectionIds");
    assert.include(searchSection, "group.collectionIds.some(");
    // Scope outranks label agreement in the ordering.
    assert.isBelow(
      searchSection.indexOf("const scopeDelta"),
      searchSection.indexOf("const rankDelta"),
    );
  });

  describe("opening a candidate in the reader", function () {
    // The background verifier refuses a library-search paper that only accounts
    // for part of the quote. The viewer fallback is reached for exactly the
    // papers whose text would not extract in the background, so applying a
    // weaker rule there would let an unextractable decoy walk through the gate
    // the extractable one is held to.
    const decoy = locateQuoteInPageTexts(DECOY_PAPER, STITCHED_QUOTE, null);
    const real = locateQuoteInPageTexts(SOURCE_PAPER, STITCHED_QUOTE, null);

    it("will not move the reader to a searched paper that shares one passage", function () {
      assert.equal(decoy.status, "resolved", "the locator does resolve it");
      assert.isFalse(
        acceptsOpenedQuoteMatchForTests({
          authoritative: false,
          result: decoy,
        }),
      );
    });

    it("still accepts the paper that holds the whole quote", function () {
      assert.isTrue(
        acceptsOpenedQuoteMatchForTests({ authoritative: false, result: real }),
      );
    });

    it("keeps a paper the conversation itself carries eligible", function () {
      // Writers stitch quotes, and a paper the answer actually used is allowed
      // to account for the quote in pieces — the same latitude the background
      // path gives it.
      assert.isTrue(
        acceptsOpenedQuoteMatchForTests({ authoritative: true, result: decoy }),
      );
    });

    it("refuses a hit the locator could not place on a page", function () {
      assert.isFalse(
        acceptsOpenedQuoteMatchForTests({
          authoritative: true,
          result: { ...real, computedPageIndex: null },
        }),
      );
    });
  });

  it("judges a candidate on how much of the quote it accounts for", function () {
    const verifySection = source.slice(
      source.indexOf("function locatedResultIdentifiesQuoteSource("),
      source.indexOf("async function locateQuoteByOpeningCitationCandidates("),
    );

    assert.include(
      verifySection,
      "sourceMatchQuoteTokenSupportCoverage",
      "the pooled figure, not the single longest span",
    );
    assert.include(verifySection, "MIN_NEAR_COMPLETE_QUOTE_SUPPORT_COVERAGE");
    assert.include(verifySection, "MIN_NEAR_COMPLETE_QUOTE_SUPPORTED_TOKENS");
    assert.include(verifySection, "MIN_QUOTE_SOURCE_ANCHOR_TOKENS");
  });
});

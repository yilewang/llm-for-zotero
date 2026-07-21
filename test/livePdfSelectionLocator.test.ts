import { assert } from "chai";
import {
  clearPageTextCache,
  lookupCachedQuoteLocationForAttachment,
  locateQuoteInPageTexts,
  locateQuoteInLivePdfReader,
  locateSelectionInPageTexts,
  resolvePageIndexForLabel,
  stripBoundaryEllipsis,
  splitQuoteAtEllipsis,
  getCachedPageTextForAttachment,
  getCurrentSelectionPageLocationFromReader,
  getPageLabelForIndex,
  hasCompleteSearchablePageTextForAttachment,
  normalizePageNativeFindControllerComparableText,
  resolvePageNativeFindControllerQuery,
  scrollToExactQuoteInReader,
  scrollToSelectedTextInReader,
  verifyQuoteLocationForAttachment,
  warmPageTextCacheForAttachment,
  warmQuoteLocationCacheForAttachment,
  waitForFindControllerPageMatchesForTests,
} from "../src/modules/contextPanel/livePdfSelectionLocator";

function installPdfWorkerStub(
  handler: (
    itemId: number,
  ) => Promise<{ text: string; pageChars?: number[] } | null>,
): () => void {
  const originalZotero = (globalThis as any).Zotero;
  const originalZtoolkit = (globalThis as any).ztoolkit;
  (globalThis as any).Zotero = {
    ...(originalZotero || {}),
    PDFWorker: {
      getFullText: handler,
    },
  };
  (globalThis as any).ztoolkit = {
    ...(originalZtoolkit || {}),
    log: () => undefined,
  };
  return () => {
    if (originalZotero === undefined) {
      delete (globalThis as any).Zotero;
    } else {
      (globalThis as any).Zotero = originalZotero;
    }
    if (originalZtoolkit === undefined) {
      delete (globalThis as any).ztoolkit;
    } else {
      (globalThis as any).ztoolkit = originalZtoolkit;
    }
    clearPageTextCache();
  };
}

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

  it("recovers the largest unique source span from a truncated long quote", function () {
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
    assert.equal(result.computedPageIndex, 23);
    assert.equal(result.sourceMatchKind, "raw-middle");
    assert.include(
      result.sourceMatchText || "",
      "inhibitory feedback cannot selectively cancel shared components",
    );
    assert.isAbove(result.sourceMatchQuoteTokenCoverage || 0, 0.4);
  });

  it("recovers the historical Eppler quote from its unique prose prefix", function () {
    const result = locateQuoteInPageTexts(
      [
        {
          pageIndex: 0,
          text: "The introduction defines signal and noise correlations.",
        },
        {
          pageIndex: 9,
          text: "The prediction index is the change in spread, χpred = S(t+1) − S(t), with positive values indicating that SC at day t predicts a more ordered NC structure at day t + 1.",
        },
      ],
      "The prediction index is the change in spread, $\\chi",
      null,
    );

    assert.equal(result.status, "resolved");
    assert.equal(result.confidence, "high");
    assert.equal(result.computedPageIndex, 9);
    assert.equal(
      result.sourceMatchText,
      "The prediction index is the change in spread",
    );
    assert.equal(result.sourceMatchKind, "raw-prefix");
    assert.equal(result.sourceMatchPageOccurrence, 0);
    assert.closeTo(result.sourceMatchQuoteTokenCoverage || 0, 8 / 9, 0.001);
  });

  it("does not navigate when the same partial prose span repeats in the PDF", function () {
    const repeated =
      "The prediction index is the change in spread, χpred = S(t+1) − S(t).";
    const result = locateQuoteInPageTexts(
      [
        { pageIndex: 2, text: repeated },
        { pageIndex: 9, text: repeated },
      ],
      "The prediction index is the change in spread, $\\chi",
      null,
    );

    assert.equal(result.status, "not-found");
    assert.isNull(result.computedPageIndex);
    assert.isUndefined(result.sourceMatchText);
  });

  it("uses the expected page to resolve exact text repeated on multiple pages", function () {
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

    assert.equal(result.status, "resolved");
    assert.equal(result.confidence, "high");
    assert.equal(result.computedPageIndex, 4);
    assert.deepEqual(result.matchedPageIndexes, [4, 9]);
    assert.equal(result.totalMatches, 2);
  });

  it("uses the first exact page occurrence when no matching page hint exists", function () {
    const duplicatedPassage =
      "learning reduces overlap only approximately leaving residual responses in the perpendicular to the original representation subspace directions";
    const pages = [
      {
        pageIndex: 4,
        text: `Context before. ${duplicatedPassage}. Context after.`,
      },
      {
        pageIndex: 9,
        text: `Another section. ${duplicatedPassage}. Ending text.`,
      },
    ];

    const withoutHint = locateQuoteInPageTexts(pages, duplicatedPassage, null);
    const wrongHint = locateQuoteInPageTexts(pages, duplicatedPassage, 6);

    assert.equal(withoutHint.status, "resolved");
    assert.equal(withoutHint.confidence, "medium");
    assert.equal(withoutHint.computedPageIndex, 4);
    assert.equal(wrongHint.status, "resolved");
    assert.equal(wrongHint.confidence, "medium");
    assert.equal(wrongHint.computedPageIndex, 4);
  });

  it("keeps repeated complete matches on one page ambiguous without an occurrence", function () {
    const quote =
      "The complete quote repeats on one page and needs an occurrence index.";
    const result = locateQuoteInPageTexts(
      [
        {
          pageIndex: 4,
          text: `${quote} Intervening text. ${quote}`,
        },
      ],
      quote,
      4,
    );

    assert.equal(result.status, "ambiguous");
    assert.isNull(result.computedPageIndex);
    assert.deepEqual(result.matchedPageIndexes, [4]);
    assert.equal(result.totalMatches, 2);
  });

  it("selects the first exact page occurrence before FindController verification", async function () {
    clearPageTextCache();
    const quote =
      "evolution candidates have expected log probability strictly beyond the shell boundary";
    const pageOne = `Main text says ${quote}.`;
    const pageTwo = "Appendix setup with unrelated text.";
    const pageThree = `Appendix restatement says ${quote}.`;
    const restore = installPdfWorkerStub(async () => ({
      text: pageOne + pageTwo + pageThree,
      pageChars: [pageOne.length, pageTwo.length, pageThree.length],
    }));
    const reader = {
      _item: { id: 707 },
      itemID: 707,
    };

    try {
      const result = await locateQuoteInLivePdfReader(reader, quote, {
        skipFindController: true,
      });

      assert.equal(result.status, "resolved");
      assert.equal(result.confidence, "medium");
      assert.equal(result.computedPageIndex, 0);
      assert.deepEqual(result.matchedPageIndexes, [0, 2]);
    } finally {
      restore();
    }
  });

  it("rechecks a PDFWorker miss against the loaded PDF.js document", async function () {
    clearPageTextCache();
    const storedQuote = "the prediction index is the change in spread chi";
    const livePageText =
      "The prediction index is the change in spread, 𝜒pred = S(t+1) − S(t), with positive values indicating ordered structure.";
    const restore = installPdfWorkerStub(async () => ({
      text: "The cached indexed text omitted the target methods paragraph.",
      pageChars: [59],
    }));
    const reader = {
      _item: { id: 3097 },
      itemID: 3097,
      _window: {
        PDFViewerApplication: {
          page: 1,
          pdfDocument: {
            numPages: 2,
            fingerprints: ["eppler-test"],
            getPage: async (pageNumber: number) => ({
              getTextContent: async () => ({
                items: [
                  {
                    str:
                      pageNumber === 2
                        ? livePageText
                        : "Unrelated opening page.",
                  },
                ],
              }),
            }),
          },
          pdfViewer: { pageLabels: ["1", "10"] },
        },
      },
    };

    try {
      const result = await locateQuoteInLivePdfReader(reader, storedQuote, {
        skipFindController: true,
      });

      assert.equal(result.status, "resolved");
      assert.equal(result.computedPageIndex, 1);
      assert.equal(
        result.sourceMatchText,
        "The prediction index is the change in spread",
      );
      assert.equal(result.sourceMatchKind, "raw-prefix");
      assert.equal(
        getCachedPageTextForAttachment(3097)?.coverage,
        "full-viewer",
      );
    } finally {
      restore();
    }
  });

  it("unwraps Gecko PDF.js page proxies while refreshing live quote text", async function () {
    clearPageTextCache();
    const storedQuote =
      "The page eleven source passage remains available through the wrapped PDF.js page proxy.";
    const restore = installPdfWorkerStub(async () => ({
      text: "The indexed cache omitted the wrapped page source passage.",
      pageChars: [57],
    }));
    const reader = {
      _item: { id: 3111 },
      itemID: 3111,
      _window: {
        PDFViewerApplication: {
          page: 11,
          pdfDocument: {
            numPages: 11,
            fingerprints: ["wrapped-page-test"],
            getPage: async (pageNumber: number) => ({
              wrappedJSObject: {
                getTextContent: async () => ({
                  items: [
                    {
                      str:
                        pageNumber === 11
                          ? storedQuote
                          : `Unrelated page ${pageNumber}.`,
                    },
                  ],
                }),
              },
            }),
          },
          pdfViewer: {
            pageLabels: Array.from({ length: 11 }, (_, i) => `${i + 1}`),
          },
        },
      },
    };

    try {
      const result = await locateQuoteInLivePdfReader(reader, storedQuote, {
        skipFindController: true,
      });

      assert.equal(result.status, "resolved");
      assert.equal(result.computedPageIndex, 10);
      assert.equal(
        getCachedPageTextForAttachment(3111)?.coverage,
        "full-viewer",
      );
    } finally {
      restore();
    }
  });

  it("keeps a cached miss retryable when loaded PDF.js text is unavailable", async function () {
    clearPageTextCache();
    const restore = installPdfWorkerStub(async () => ({
      text: "The indexed cache does not contain the requested quotation.",
      pageChars: [59],
    }));
    const reader = {
      _item: { id: 3098 },
      itemID: 3098,
    };

    try {
      const result = await locateQuoteInLivePdfReader(
        reader,
        "The prediction index is the change in spread",
        { skipFindController: true },
      );

      assert.equal(result.status, "unavailable");
      assert.equal(result.confidence, "none");
      assert.isNull(result.computedPageIndex);
      assert.include(result.reason || "", "cached result is not conclusive");
    } finally {
      restore();
    }
  });

  it("uses the largest unique prose side when a model math fragment is absent", function () {
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

    assert.equal(result.status, "resolved");
    assert.equal(result.computedPageIndex, 6);
    assert.equal(
      result.sourceMatchText,
      "and the model converges to a stable solution after alternating optimization.",
    );
    assert.equal(result.sourceMatchKind, "raw-suffix");
  });

  it("recovers a punctuation-heavy truncated classifier quote", function () {
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
    assert.include(
      result.sourceMatchText || "",
      "Support Vector Machine with soft margins",
    );
    assert.isAbove(result.sourceMatchQuoteTokenCoverage || 0, 0.8);
  });
});

describe("citation page cache warming", function () {
  const PAGE_TEXT_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

  afterEach(function () {
    clearPageTextCache();
  });

  it("warms page-text cache independently for different attachments", async function () {
    clearPageTextCache();
    const calls: number[] = [];
    const restore = installPdfWorkerStub(async (itemId) => {
      calls.push(itemId);
      if (itemId === 101) {
        return { text: "Attachment one target quote.", pageChars: [28] };
      }
      if (itemId === 202) {
        return { text: "Attachment two different quote.", pageChars: [31] };
      }
      return null;
    });

    try {
      const first = await warmPageTextCacheForAttachment(101);
      const second = await warmPageTextCacheForAttachment(202);

      assert.equal(first?.pages[0]?.text, "Attachment one target quote.");
      assert.equal(second?.pages[0]?.text, "Attachment two different quote.");
      assert.equal(first?.coverage, "full-pdfworker");
      assert.equal(first?.pageCount, 1);
      assert.equal(second?.coverage, "full-pdfworker");
      assert.equal(second?.pageCount, 1);
      assert.deepEqual(calls, [101, 202]);
    } finally {
      restore();
    }
  });

  it("uses only complete searchable page coverage as quote-negative evidence", async function () {
    clearPageTextCache();
    const firstPage = "The first page contains searchable source text.";
    const secondPage = "The second page also contains searchable source text.";
    const restore = installPdfWorkerStub(async (itemId) => {
      if (itemId === 301) {
        return {
          text: `${firstPage}${secondPage}`,
          pageChars: [firstPage.length, secondPage.length],
        };
      }
      if (itemId === 302) {
        return {
          text: firstPage,
          pageChars: [firstPage.length, 0],
        };
      }
      return null;
    });

    try {
      assert.isNull(getCachedPageTextForAttachment(301));
      await warmPageTextCacheForAttachment(301);
      await warmPageTextCacheForAttachment(302);

      assert.isTrue(hasCompleteSearchablePageTextForAttachment(301));
      assert.isFalse(hasCompleteSearchablePageTextForAttachment(302));
      assert.equal(getCachedPageTextForAttachment(301)?.pageCount, 2);
    } finally {
      restore();
    }
  });

  it("falls back to the active full PDF.js viewer when PDFWorker omits page boundaries", async function () {
    clearPageTextCache();
    const restore = installPdfWorkerStub(async () => ({
      text: "The worker returned complete text without page boundary metadata.",
    }));
    const reader = {
      _item: { id: 3097 },
      itemID: 3097,
      _window: {
        PDFViewerApplication: {
          pdfDocument: {
            numPages: 2,
            fingerprints: ["eppler-background-viewer"],
            getPage: async (pageNumber: number) => ({
              getTextContent: async () => ({
                items: [
                  {
                    str:
                      pageNumber === 1
                        ? "The first live viewer page is searchable."
                        : "The second live viewer page is also searchable.",
                  },
                ],
              }),
            }),
          },
          pdfViewer: { pageLabels: ["1", "2"] },
        },
      },
    };

    try {
      const cached = await warmPageTextCacheForAttachment(3097, { reader });

      assert.equal(cached?.coverage, "full-viewer");
      assert.equal(cached?.pageCount, 2);
      assert.lengthOf(cached?.pages || [], 2);
      assert.equal(cached?.sourceFingerprint, "pdfjs:eppler-background-viewer");
      assert.isTrue(hasCompleteSearchablePageTextForAttachment(3097));
    } finally {
      restore();
    }
  });

  it("dedupes repeated attachment warm calls while a PDFWorker read is pending", async function () {
    clearPageTextCache();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const restore = installPdfWorkerStub(async () => {
      calls += 1;
      await pending;
      return { text: "Only one worker call should run.", pageChars: [32] };
    });

    try {
      const first = warmPageTextCacheForAttachment(303);
      const second = warmPageTextCacheForAttachment(303);
      await Promise.resolve();

      assert.equal(calls, 1);
      release();
      await Promise.all([first, second]);
      assert.equal(calls, 1);
    } finally {
      restore();
    }
  });

  it("cooperatively indexes a 500-page attachment and reuses the warm index", async function () {
    clearPageTextCache();
    const pageTexts = Array.from(
      { length: 500 },
      (_value, index) =>
        `Page ${index + 1} contains distinct searchable provenance evidence for the stress test.`,
    );
    let calls = 0;
    let yields = 0;
    const restore = installPdfWorkerStub(async () => {
      calls += 1;
      return {
        text: pageTexts.join(""),
        pageChars: pageTexts.map((page) => page.length),
      };
    });
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => {
      now += 9;
      return now;
    };

    try {
      const first = await warmPageTextCacheForAttachment(7500, {
        yieldToMain: async () => {
          yields += 1;
        },
      });
      const second = await warmPageTextCacheForAttachment(7500, {
        yieldToMain: async () => {
          yields += 1;
        },
      });

      assert.equal(first?.pages.length, 500);
      assert.strictEqual(second, first);
      assert.equal(calls, 1);
      assert.isAtLeast(yields, 100);
    } finally {
      Date.now = originalNow;
      restore();
    }
  });

  it("evicts least-recently-used page-text entries beyond the entry limit", async function () {
    clearPageTextCache();
    const initialIds = Array.from({ length: 50 }, (_value, index) => index + 1);
    const calls: number[] = [];
    const restore = installPdfWorkerStub(async (itemId) => {
      calls.push(itemId);
      return {
        text: `Attachment ${itemId} has enough text for cache testing.`,
        pageChars: [
          `Attachment ${itemId} has enough text for cache testing.`.length,
        ],
      };
    });

    try {
      for (const itemId of initialIds) {
        await warmPageTextCacheForAttachment(itemId);
      }
      await warmPageTextCacheForAttachment(1);
      assert.deepEqual(calls, initialIds);

      await warmPageTextCacheForAttachment(51);
      await warmPageTextCacheForAttachment(2);

      assert.deepEqual(calls, [...initialIds, 51, 2]);
    } finally {
      restore();
    }
  });

  it("expires page-text entries after the cache TTL", async function () {
    clearPageTextCache();
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    let calls = 0;
    const restore = installPdfWorkerStub(async () => {
      calls += 1;
      return {
        text: `TTL cache read ${calls} with enough searchable text.`,
        pageChars: [
          `TTL cache read ${calls} with enough searchable text.`.length,
        ],
      };
    });

    try {
      await warmPageTextCacheForAttachment(707);
      await warmPageTextCacheForAttachment(707);
      now += PAGE_TEXT_CACHE_TTL_MS + 1;
      await warmPageTextCacheForAttachment(707);

      assert.equal(calls, 2);
    } finally {
      Date.now = originalNow;
      restore();
    }
  });

  it("evicts page-text entries when the total text budget is exceeded", async function () {
    this.timeout(10_000);
    clearPageTextCache();
    const calls: number[] = [];
    const largeText = "A".repeat(4_300_000);
    const restore = installPdfWorkerStub(async (itemId) => {
      calls.push(itemId);
      const text = `${largeText}${itemId}`;
      return { text, pageChars: [text.length] };
    });

    try {
      await warmPageTextCacheForAttachment(901);
      await warmPageTextCacheForAttachment(902);
      await warmPageTextCacheForAttachment(901);

      assert.deepEqual(calls, [901, 902, 901]);
    } finally {
      restore();
    }
  });

  it("clears cached page text, promises, and hidden quote locations together", async function () {
    clearPageTextCache();
    let calls = 0;
    const pageOne = "First page.";
    const pageTwo = "The hidden quote lives on the second page.";
    const restore = installPdfWorkerStub(async () => {
      calls += 1;
      return {
        text: pageOne + pageTwo,
        pageChars: [pageOne.length, pageTwo.length],
      };
    });

    try {
      await warmPageTextCacheForAttachment(404);
      const hidden = await warmQuoteLocationCacheForAttachment(
        404,
        "The hidden quote lives on the second page.",
      );
      assert.equal(hidden?.pageIndex, 1);
      assert.isNotNull(
        lookupCachedQuoteLocationForAttachment(
          404,
          "The hidden quote lives on the second page.",
        ),
      );

      clearPageTextCache();
      assert.isNull(
        lookupCachedQuoteLocationForAttachment(
          404,
          "The hidden quote lives on the second page.",
        ),
      );

      await warmPageTextCacheForAttachment(404);
      assert.equal(calls, 2);
    } finally {
      restore();
    }
  });

  it("does not let an in-flight warm repopulate cache after clear", async function () {
    clearPageTextCache();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const restore = installPdfWorkerStub(async () => {
      calls += 1;
      await pending;
      return {
        text: "Delayed worker page text.",
        pageChars: ["Delayed worker page text.".length],
      };
    });

    try {
      const first = warmPageTextCacheForAttachment(606);
      await Promise.resolve();
      clearPageTextCache();
      release();
      assert.isNull(await first);

      await warmPageTextCacheForAttachment(606);
      assert.equal(calls, 2);
    } finally {
      restore();
    }
  });

  it("caches hidden quote locations without storing a visible page label", async function () {
    clearPageTextCache();
    const pageOne = "Opening page text.";
    const pageTwo = "The quote to jump to is here with enough context.";
    const restore = installPdfWorkerStub(async () => ({
      text: pageOne + pageTwo,
      pageChars: [pageOne.length, pageTwo.length],
    }));

    try {
      const location = await warmQuoteLocationCacheForAttachment(
        505,
        "The quote to jump to is here with enough context.",
      );

      assert.equal(location?.pageIndex, 1);
      assert.notProperty(location || {}, "pageLabel");
      assert.equal(
        lookupCachedQuoteLocationForAttachment(
          505,
          "The quote to jump to is here with enough context.",
        )?.pageIndex,
        1,
      );
    } finally {
      restore();
    }
  });

  it("returns complete background quote-verification outcomes without invoking FindController", async function () {
    clearPageTextCache();
    const quote =
      "The background verifier finds this complete source sentence without changing the reader.";
    const restore = installPdfWorkerStub(async () => ({
      text: `${quote} Unrelated trailing text.`,
      pageChars: [`${quote} Unrelated trailing text.`.length],
    }));

    try {
      const resolved = await verifyQuoteLocationForAttachment(506, quote);
      const missing = await verifyQuoteLocationForAttachment(
        506,
        "This generated explanation is absent from the source PDF.",
      );

      assert.equal(resolved.status, "resolved");
      assert.equal(resolved.computedPageIndex, 0);
      assert.equal(missing.status, "not-found");
      assert.equal(missing.computedPageIndex, null);
    } finally {
      restore();
    }
  });

  it("defers background quote verification when complete attachment text is unavailable", async function () {
    clearPageTextCache();
    const restore = installPdfWorkerStub(async () => null);

    try {
      const result = await verifyQuoteLocationForAttachment(
        507,
        "A quote cannot be classified until searchable PDF text is available.",
      );

      assert.equal(result.status, "unavailable");
      assert.match(result.reason || "", /background quote verification/i);
    } finally {
      restore();
    }
  });

  it("caches the historical Eppler quote through its unique partial source span", async function () {
    clearPageTextCache();
    const pageOne = "Opening page with unrelated methods text.";
    const pageTen =
      "The prediction index is the change in spread, χpred = S(t+1) − S(t), with positive values indicating ordered structure.";
    const restore = installPdfWorkerStub(async () => ({
      text: pageOne + pageTen,
      pageChars: [pageOne.length, pageTen.length],
    }));

    try {
      const quote = "The prediction index is the change in spread, $\\chi";
      const location = await warmQuoteLocationCacheForAttachment(3097, quote);

      assert.equal(location?.pageIndex, 1);
      assert.equal(
        location?.sourceMatchText,
        "The prediction index is the change in spread",
      );
      assert.equal(location?.sourceMatchPageOccurrence, 0);
      assert.equal(
        lookupCachedQuoteLocationForAttachment(3097, quote)?.sourceMatchText,
        "The prediction index is the change in spread",
      );
    } finally {
      restore();
    }
  });

  it("expires hidden quote locations after the cache TTL and recomputes them", async function () {
    clearPageTextCache();
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    const quote =
      "The hidden quote location should expire after the same cache ttl.";
    let calls = 0;
    const restore = installPdfWorkerStub(async () => {
      calls += 1;
      return { text: quote, pageChars: [quote.length] };
    });

    try {
      const first = await warmQuoteLocationCacheForAttachment(515, quote);
      assert.equal(first?.pageIndex, 0);

      now += PAGE_TEXT_CACHE_TTL_MS + 1;
      assert.isNull(lookupCachedQuoteLocationForAttachment(515, quote));

      const second = await warmQuoteLocationCacheForAttachment(515, quote);
      assert.equal(second?.pageIndex, 0);
      assert.equal(calls, 2);
    } finally {
      Date.now = originalNow;
      restore();
    }
  });

  it("evicts hidden quote locations by LRU limit without blocking fresh lookup", async function () {
    this.timeout(10_000);
    clearPageTextCache();
    const quotes = Array.from(
      { length: 1001 },
      (_value, index) =>
        `Hidden quote ${index + 1} contains enough unique words for lookup.`,
    );
    const fullText = quotes.join(" ");
    const restore = installPdfWorkerStub(async () => ({
      text: fullText,
      pageChars: [fullText.length],
    }));

    try {
      for (const quote of quotes) {
        const location = await warmQuoteLocationCacheForAttachment(909, quote);
        assert.equal(location?.pageIndex, 0);
      }

      assert.isNull(lookupCachedQuoteLocationForAttachment(909, quotes[0]));
      const fresh = await warmQuoteLocationCacheForAttachment(909, quotes[0]);
      assert.equal(fresh?.pageIndex, 0);
      assert.equal(
        lookupCachedQuoteLocationForAttachment(909, quotes[0])?.pageIndex,
        0,
      );
    } finally {
      restore();
    }
  });

  it("caches the first page when an exact quote is duplicated across pages", async function () {
    clearPageTextCache();
    const quote =
      "evolution candidates have expected log probability strictly beyond the shell boundary";
    const pageOne = `Main text says ${quote}.`;
    const pageTwo = `Appendix restatement says ${quote}.`;
    const restore = installPdfWorkerStub(async () => ({
      text: pageOne + pageTwo,
      pageChars: [pageOne.length, pageTwo.length],
    }));

    try {
      const location = await warmQuoteLocationCacheForAttachment(808, quote);

      assert.equal(location?.pageIndex, 0);
      assert.equal(location?.confidence, "medium");
      assert.deepEqual(location?.matchedPageIndexes, [0, 1]);
      assert.equal(
        lookupCachedQuoteLocationForAttachment(808, quote)?.pageIndex,
        0,
      );
    } finally {
      restore();
    }
  });
});

describe("resolvePageIndexForLabel", function () {
  function createReader(pageLabels?: string[], pagesCount?: number): any {
    return {
      _window: {
        PDFViewerApplication: {
          pdfDocument: { numPages: pagesCount ?? pageLabels?.length ?? 0 },
          pagesCount: pagesCount ?? pageLabels?.length ?? 0,
          pdfViewer: pageLabels ? { pageLabels } : {},
        },
      },
    };
  }

  it("returns null for empty or unknown page labels", function () {
    const reader = createReader(["i", "ii", "1", "2"], 4);

    assert.isNull(resolvePageIndexForLabel(reader, ""));
    assert.isNull(resolvePageIndexForLabel(reader, "S1"));
  });

  it("resolves numeric page labels without defaulting unknown labels to page 1", function () {
    const reader = createReader(undefined, 20);

    assert.equal(resolvePageIndexForLabel(reader, "12"), 11);
    assert.isNull(resolvePageIndexForLabel(reader, "appendix"));
  });

  it("resolves exact custom and roman page labels", function () {
    const reader = createReader(["i", "ii", "1", "2"], 4);

    assert.equal(resolvePageIndexForLabel(reader, "ii"), 1);
    assert.equal(resolvePageIndexForLabel(reader, "2"), 3);
  });
});

describe("live reader page labels", function () {
  function createSelectedPageReader(): any {
    const pageElement = {
      nodeType: 1,
      parentElement: null,
      getAttribute: (name: string) =>
        name === "data-page-number" ? "4" : null,
    };
    const selection = {
      anchorNode: pageElement,
      focusNode: pageElement,
      getRangeAt: () => ({ commonAncestorContainer: pageElement }),
      isCollapsed: false,
      rangeCount: 1,
      toString: () => "Selected place-cell passage",
    };
    const document = {
      defaultView: {
        getSelection: () => selection,
      },
      querySelectorAll: () => [pageElement],
    };
    return {
      itemID: 42,
      _window: {
        document,
        PDFViewerApplication: {
          pdfDocument: { numPages: 21 },
          pdfViewer: {
            _pageLabels: ["428", "429", "430", "431", "432"],
          },
        },
      },
    };
  }

  it("prefers the printed PDF label over data-page-number", function () {
    const reader = createSelectedPageReader();

    assert.equal(getPageLabelForIndex(reader, 3), "431");
  });

  it("captures the printed label with the synchronous selection snapshot", function () {
    const reader = createSelectedPageReader();

    assert.deepEqual(
      getCurrentSelectionPageLocationFromReader(
        reader,
        "Selected place-cell passage",
      ),
      {
        contextItemId: 42,
        pageIndex: 3,
        pageLabel: "431",
        pagesScanned: 1,
      },
    );
  });

  it("reads a printed label from the PDF.js page accessibility label", function () {
    const reader = createSelectedPageReader();
    delete reader._window.PDFViewerApplication.pdfViewer._pageLabels;
    const pageElement = reader._window.document.querySelectorAll()[0];
    pageElement.getAttribute = (name: string) => {
      if (name === "aria-label") return "Page: 431. Index: 4";
      return name === "data-page-number" ? "4" : null;
    };

    assert.equal(getPageLabelForIndex(reader, 3), "431");
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

describe("page-native scrollToExactQuoteInReader", function () {
  function createExactFindControllerReader(params: {
    pageItems: Array<Array<{ str: string; hasEOL?: boolean }>>;
    targetPageIndex: number;
    matchCount?: number;
    shouldMatch?: boolean;
    matchesQuery?: (query: string) => boolean;
    previousQuery?: string;
    delayedAcceptanceMs?: number;
    delayedResultsMs?: number;
    resultPageIndex?: number;
    ignoreFindAgain?: boolean;
    fingerprint?: string;
  }): {
    reader: any;
    dispatched: Array<{ type: string; query: string }>;
    findController: any;
    getListenerCount: () => number;
    setDelayedResultsMs: (delayMs: number | undefined) => void;
  } {
    const dispatched: Array<{ type: string; query: string }> = [];
    const matchCount = params.matchCount ?? 1;
    const findController: any = {
      _rawQuery: params.previousQuery || "",
      _state: {
        query: params.previousQuery || "",
        phraseSearch: true,
      },
      pageMatches: params.pageItems.map(() => []),
      _pendingFindMatches: new Set(),
      _pagesToSearch: 0,
      matchesCount: { total: 0 },
      selected: { pageIdx: 0, matchIdx: 0 },
    };
    const listeners = new Map<string, Set<() => void>>();
    const emit = (eventName: string): void => {
      for (const listener of listeners.get(eventName) || []) listener();
    };
    let delayedResultsMs = params.delayedResultsMs;
    const applySearch = (query: string): void => {
      findController._rawQuery = query;
      findController._state = {
        ...findController._state,
        query,
      };
      findController.pageMatches = params.pageItems.map(() => []);
      findController.matchesCount = { total: 0 };
      findController._pendingFindMatches = new Set([0]);
      findController._pagesToSearch = params.pageItems.length;
      const shouldMatch =
        params.matchesQuery?.(query) ?? params.shouldMatch !== false;
      const finishSearch = (): void => {
        if (findController._rawQuery !== query) return;
        const resultPageIndex =
          params.resultPageIndex ?? params.targetPageIndex;
        if (shouldMatch && query !== params.previousQuery) {
          findController.pageMatches[resultPageIndex] = Array.from(
            { length: matchCount },
            (_value, index) => index,
          );
          findController.matchesCount = { total: matchCount };
          findController.selected = {
            pageIdx: resultPageIndex,
            matchIdx: 0,
          };
        }
        findController._pendingFindMatches = new Set();
        findController._pagesToSearch = 0;
        emit("updatefindmatchescount");
        emit("updatefindcontrolstate");
      };
      if (delayedResultsMs !== undefined) {
        setTimeout(finishSearch, delayedResultsMs);
      } else {
        finishSearch();
      }
    };
    const eventBus = {
      _on: (eventName: string, listener: () => void) => {
        const registered = listeners.get(eventName) || new Set<() => void>();
        registered.add(listener);
        listeners.set(eventName, registered);
      },
      _off: (eventName: string, listener: () => void) => {
        listeners.get(eventName)?.delete(listener);
      },
      dispatch: (
        _eventName: string,
        state: { query?: string; type?: string },
      ) => {
        const type = state.type || "";
        const query = String(state.query || findController._rawQuery || "");
        dispatched.push({ type, query });
        if (type === "again") {
          if (params.ignoreFindAgain) return;
          findController.selected = {
            pageIdx: params.targetPageIndex,
            matchIdx:
              (Number(findController.selected?.matchIdx || 0) + 1) % matchCount,
          };
          return;
        }
        applySearch(query);
      },
    };
    let findBar: any;
    if (params.delayedAcceptanceMs !== undefined) {
      class FakeInputEvent {
        constructor(_type: string, _init?: EventInit) {}
      }
      const findField: any = {
        value: params.previousQuery || "",
        ownerDocument: {
          defaultView: {
            Event: FakeInputEvent,
            InputEvent: FakeInputEvent,
          },
        },
        dispatchEvent: () => {
          const query = findField.value;
          setTimeout(() => applySearch(query), params.delayedAcceptanceMs);
          return true;
        },
      };
      findBar = {
        opened: false,
        open: () => {
          findBar.opened = true;
        },
        close: () => {
          findBar.opened = false;
        },
        findField,
        _findField: findField,
      };
    }
    const app = {
      pdfDocument: {
        numPages: params.pageItems.length,
        fingerprints: [params.fingerprint || "test-pdf"],
        getPage: async (pageNumber: number) => ({
          getTextContent: async (options: {
            disableNormalization?: boolean;
          }) => {
            assert.isTrue(options.disableNormalization);
            return { items: params.pageItems[pageNumber - 1] || [] };
          },
        }),
      },
      pagesCount: params.pageItems.length,
      page: params.targetPageIndex + 1,
      eventBus,
      findBar,
      findController,
    };
    return {
      reader: {
        _window: {
          PDFViewerApplication: app,
        },
      },
      dispatched,
      findController,
      getListenerCount: () =>
        Array.from(listeners.values()).reduce(
          (total, registered) => total + registered.size,
          0,
        ),
      setDelayedResultsMs: (delayMs) => {
        delayedResultsMs = delayMs;
      },
    };
  }

  it("lets a positive final FindController snapshot win at the deadline", async function () {
    const query = "A final positive controller snapshot remains monotonic.";
    let pageMatchReads = 0;
    const listeners = new Map<string, Set<() => void>>();
    const findController = {
      _rawQuery: query,
      _state: { query },
      matchesCount: { total: 0 },
      _pendingFindMatches: new Set([0]),
      _pagesToSearch: 1,
      selected: { pageIdx: 0, matchIdx: 0 },
      get pageMatches() {
        pageMatchReads += 1;
        return pageMatchReads >= 3 ? [[0]] : [[]];
      },
    };
    const eventBus = {
      _on: (eventName: string, listener: () => void) => {
        const registered = listeners.get(eventName) || new Set<() => void>();
        registered.add(listener);
        listeners.set(eventName, registered);
      },
      _off: (eventName: string, listener: () => void) => {
        listeners.get(eventName)?.delete(listener);
      },
    };

    const result = await waitForFindControllerPageMatchesForTests({
      findController,
      eventBus,
      pagesCount: 1,
      expectedQuery: query,
      previousSnapshot: {
        matchCount: 0,
        pageMatches: [[]],
        pageMatchesLength: 1,
        query,
        selectedPageIndex: 0,
        selectedMatchIndex: 0,
      },
      acceptanceMs: 0,
      hardDeadlineAt: 0,
    });

    assert.equal(result.completion, "found");
    assert.equal(result.totalMatches, 1);
    assert.deepEqual(result.matchedPageIndexes, [0]);
    assert.equal(
      Array.from(listeners.values()).reduce(
        (total, registered) => total + registered.size,
        0,
      ),
      0,
    );
  });

  it("reconstructs one literal page-native query including manuscript line numbers", function () {
    const quote =
      "Consistently, pattern identity remained perfectly decodable from population activity throughout the drift period. Together, these results show that local predictive plasticity generates drifting but organized assemblies.";
    const pageText =
      "Consistently, pattern identity remained perfectly decodable\n139 from population activity throughout the drift period.\n140 Together, these results show that local predictive plasticity\n141 generates drifting but organized assemblies.";
    const resolved = resolvePageNativeFindControllerQuery(pageText, quote);

    assert.isNotNull(resolved);
    assert.equal(resolved?.totalOccurrences, 1);
    assert.include(resolved?.query || "", " 139 ");
    assert.include(resolved?.query || "", " 140 ");
    assert.include(resolved?.query || "", " 141 ");
  });

  it("reconstructs the row-604 query with FindController EOL spacing and its complete source suffix", function () {
    const boundary = "\u0003";
    const quote =
      "Neurons undergoing a preference change showed a stereotyped transition in net E/I drive. The net drive associated with the previously preferred pattern was dominant before the change but declined and dropped sharply around reassignment. Concurrently, the net drive associated with the newly preferred pattern began rising before the change and became dominant afterward.";
    const pageText = [
      `Neurons undergoing a preference change showed a stereotyped transition in net E/I drive.${boundary}151${boundary}\n`,
      `${boundary}The net drive associated with the previously preferred pattern was dominant before the${boundary}152${boundary}\n`,
      `${boundary}change but declined and dropped sharply around reassignment. Concurrently, the net drive${boundary}153${boundary}\n`,
      `${boundary}associated with the newly preferred pattern began rising before the change and became${boundary}154${boundary}\n`,
      `${boundary}dominant afterward (Fig. 3B).`,
    ].join("");
    const resolved = resolvePageNativeFindControllerQuery(pageText, quote);

    assert.isNotNull(resolved);
    assert.notInclude(resolved?.query || "", boundary);
    assert.include(resolved?.query || "", "drive.151 The net drive");
    assert.include(resolved?.query || "", "before the152 change");
    assert.include(resolved?.query || "", "became154 dominant afterward");
    assert.match(resolved?.query || "", /\(Fig\. 3B\)\.$/);
  });

  it("reconstructs a complete FindController query through a separate PDF.js citation range", function () {
    const boundary = "\u0003";
    const quote =
      "This propensity function was inspired by experimental results showing that the magnitudes of changes in spine size—commonly considered a proxy for synaptic strength—is proportional to the initial size of the spines.";
    const pageText = [
      "This propensity function was inspired by experimental results showing that the magnitudes of",
      "changes in spine size",
      "—",
      "commonly considered a proxy for synaptic strength",
      "—",
      "is proportional to the initial size of the spines",
      "47,50",
      "–",
      "53",
      ".",
    ].join(boundary);
    const resolved = resolvePageNativeFindControllerQuery(pageText, quote);

    assert.isNotNull(resolved);
    assert.notInclude(resolved?.query || "", boundary);
    assert.match(resolved?.query || "", /spines47,50–53\.$/);
  });

  it("reconstructs FindController's dehyphenated spelling across an EOL item boundary", function () {
    const boundary = "\u0003";
    const quote =
      "They learned to associate the presentation of a sound with a mild foot shock.";
    const pageText = `They learned to associate the presenta-\n${boundary}tion of a sound with a mild foot shock.`;
    const resolved = resolvePageNativeFindControllerQuery(pageText, quote);

    assert.isNotNull(resolved);
    assert.include(resolved?.query || "", "the presentation of a sound");
    assert.notInclude(resolved?.query || "", "presenta- tion");
  });

  it("uses FindController's broken-word normalization when a compound word wraps across PDF lines", function () {
    const boundary = "\u0003";
    const quote =
      "The model used a weight-dependent propensity function throughout training.";
    const pageText = `The model used a weight-\n${boundary}dependent propensity function throughout training.`;
    const resolved = resolvePageNativeFindControllerQuery(pageText, quote);

    assert.isNotNull(resolved);
    assert.include(resolved?.query || "", "weightdependent");
    assert.notInclude(resolved?.query || "", "weight-dependent");
    assert.include(
      normalizePageNativeFindControllerComparableText(pageText),
      normalizePageNativeFindControllerComparableText(resolved?.query || ""),
    );
  });

  it("validates page-native queries after FindController joins adjacent text items", function () {
    const boundary = "\u0003";
    const pageText = `The${boundary}model used a reconfigur-\n${boundary}ing population code.`;
    const query = "Themodel used a reconfiguring population code.";

    assert.equal(
      normalizePageNativeFindControllerComparableText(pageText),
      normalizePageNativeFindControllerComparableText(query),
    );
  });

  it("submits exactly one complete page-native query and stops at FindController", async function () {
    const quote =
      "Consistently, pattern identity remained perfectly decodable from population activity throughout the drift period. Together, these results show that local predictive plasticity generates drifting but organized assemblies.";
    const pageItems = [
      [{ str: "Unrelated cover page." }],
      [
        {
          str: "Consistently, pattern identity remained perfectly decodable",
          hasEOL: true,
        },
        {
          str: "139 from population activity throughout the drift period.",
          hasEOL: true,
        },
        {
          str: "140 Together, these results show that local predictive plasticity",
          hasEOL: true,
        },
        { str: "141 generates drifting but organized assemblies." },
      ],
    ];
    const fixture = createExactFindControllerReader({
      pageItems,
      targetPageIndex: 1,
    });

    const result = await scrollToExactQuoteInReader(fixture.reader, quote, {
      citationId: "Q_primary_db_case",
      expectedPageIndex: 1,
      sourceFingerprint: "pdfjs:test-pdf",
    });

    assert.isTrue(result.matched);
    assert.equal(result.matchedPageIndex, 1);
    assert.lengthOf(result.queries, 1);
    assert.lengthOf(fixture.dispatched, 1);
    assert.equal(fixture.dispatched[0].query, result.queryUsed);
    assert.include(result.queryUsed || "", " 139 ");
    assert.notEqual(result.queryUsed, quote);
  });

  it("tries the complete displayed quote first, then the persisted largest unique locator", async function () {
    const sourceSentence =
      "We modeled the propensity function to be weight-dependent before describing the encoded equation.";
    const displayQuote = `${sourceSentence} The displayed equation uses model-rendered Unicode that native search may reject.`;
    const previousQuery = "previous user search";
    const fixture = createExactFindControllerReader({
      pageItems: [[{ str: displayQuote }]],
      targetPageIndex: 0,
      previousQuery,
      matchesQuery: (query) => query === sourceSentence,
    });

    const result = await scrollToExactQuoteInReader(
      fixture.reader,
      displayQuote,
      {
        expectedPageIndex: 0,
        fallbackQuoteTexts: [sourceSentence],
      },
    );

    assert.isTrue(result.matched);
    assert.equal(result.queryUsed, sourceSentence);
    const dispatchedQueries = fixture.dispatched.map((entry) => entry.query);
    assert.equal(dispatchedQueries[0], displayQuote);
    assert.equal(
      dispatchedQueries[dispatchedQueries.length - 1],
      sourceSentence,
    );
    assert.isAtLeast(
      dispatchedQueries.filter((query) => query === previousQuery).length,
      1,
    );
    assert.isTrue(
      dispatchedQueries.some(
        (query) =>
          query !== displayQuote &&
          query !== previousQuery &&
          query !== sourceSentence,
      ),
    );
  });

  it("navigates the Learning-induced DB quote through its page-backed partial locator", async function () {
    const displayQuote =
      "We acquired a second dataset (10 mice; 74 FOVs; 16,882 neurons) with four imaging time points at a 2-day interval using the same set of sound stimuli as before. On the day between imaging sessions two and three, mice underwent an ACFC paradigm in which they learned to associate the presentation of a sound with the subsequent application of a mild foot shock.";
    const sourceLocator =
      "On the day between imaging sessions two and three, mice underwent an ACFC paradigm in which they learned to associate the presenta- tion of a sound with the subsequent application of a mild foot shock.";
    const pageItems = [
      [
        {
          str: "To this end, we acquired a second dataset (10 mice; 74 FOVs; 16,882",
          hasEOL: true,
        },
        {
          str: "neurons) with four imaging time points at a 2-day interval using",
          hasEOL: true,
        },
        {
          str: "the same set of sound stimuli as before (Figure 6A). On the day",
          hasEOL: true,
        },
        {
          str: "between imaging sessions two and three, mice underwent an",
          hasEOL: true,
        },
        {
          str: "ACFC paradigm in which they learned to associate the presenta-",
          hasEOL: true,
        },
        {
          str: "tion of a sound with the subsequent application of a mild foot",
          hasEOL: true,
        },
        { str: "shock." },
      ],
    ];
    const fixture = createExactFindControllerReader({
      pageItems,
      targetPageIndex: 0,
      matchesQuery: (query) =>
        query.includes("On the day between imaging sessions") &&
        query.includes("presentation of a sound"),
    });

    const result = await scrollToExactQuoteInReader(
      fixture.reader,
      displayQuote,
      {
        expectedPageIndex: 0,
        fallbackQuoteTexts: [sourceLocator],
      },
    );

    assert.isTrue(result.matched);
    assert.include(
      result.queryUsed || "",
      "On the day between imaging sessions",
    );
    assert.include(result.queryUsed || "", "presentation of a sound");
    assert.notInclude(result.queryUsed || "", "presenta- tion");
    assert.notInclude(result.queryUsed || "", "(Figure 6A)");
  });

  it("navigates the historical Eppler quote with one native partial query", async function () {
    const storedQuote = "The prediction index is the change in spread, $\\chi";
    const fixture = createExactFindControllerReader({
      pageItems: [
        [{ str: "Unrelated opening page." }],
        [
          {
            str: "The prediction index is the change in spread, χpred = S(t+1) − S(t), with positive values indicating that SC at day t predicts a more ordered NC structure at day t + 1.",
          },
        ],
      ],
      targetPageIndex: 1,
      matchesQuery: (query) =>
        query === "The prediction index is the change in spread,",
    });

    const result = await scrollToExactQuoteInReader(
      fixture.reader,
      storedQuote,
      {
        citationId: "Q_0gnim02",
        expectedPageIndex: 1,
        sourceFingerprint: "pdfjs:test-pdf",
      },
    );

    assert.isTrue(result.matched);
    assert.equal(result.matchedPageIndex, 1);
    assert.equal(
      result.queryUsed,
      "The prediction index is the change in spread,",
    );
    assert.closeTo(result.highlightCoverage || 0, 8 / 9, 0.001);
    assert.deepEqual(
      fixture.dispatched.map((entry) => entry.query),
      ["The prediction index is the change in spread,"],
    );
  });

  it("retries a full FindController miss with the largest unique prose span", async function () {
    const quote =
      "The prediction index is the change in spread, χpred = S(t+1) − S(t), with positive values indicating that SC at day t predicts a more ordered NC structure at day t + 1.";
    const fixture = createExactFindControllerReader({
      pageItems: [[{ str: quote }]],
      targetPageIndex: 0,
      matchesQuery: (query) =>
        query.startsWith(
          "with positive values indicating that SC at day t predicts",
        ),
    });

    const result = await scrollToExactQuoteInReader(fixture.reader, quote, {
      expectedPageIndex: 0,
    });

    assert.isTrue(
      result.matched,
      JSON.stringify({ result, dispatched: fixture.dispatched }),
    );
    assert.match(
      result.queryUsed || "",
      /^with positive values indicating that SC at day t predicts/u,
    );
    assert.isBelow(result.highlightCoverage || 1, 1);
    assert.equal(result.queries[0]?.query, quote);
    assert.equal(result.queries[0]?.totalMatches, 0);
    assert.equal(result.queries[1]?.query, result.queryUsed);
  });

  it("prefers the unwrapped PDF.js application when Xray hides getPage", async function () {
    const quote =
      "Neurons undergoing a preference change showed a stereotyped transition in net E/I drive.";
    const fixture = createExactFindControllerReader({
      pageItems: [[{ str: quote }]],
      targetPageIndex: 0,
    });
    const app = fixture.reader._window.PDFViewerApplication;
    fixture.reader._window = {
      PDFViewerApplication: {
        pdfDocument: {
          numPages: 1,
          fingerprints: ["test-pdf"],
        },
      },
      wrappedJSObject: {
        PDFViewerApplication: app,
      },
    };

    const result = await scrollToExactQuoteInReader(fixture.reader, quote, {
      citationId: "Q_xray_reader",
      expectedPageIndex: 0,
      sourceFingerprint: "pdfjs:test-pdf",
    });

    assert.isTrue(result.matched);
    assert.equal(result.matchedPageIndex, 0);
    assert.lengthOf(fixture.dispatched, 1);
  });

  it("retries live PDF.js extraction when Gecko rejects cross-realm options", async function () {
    const quote =
      "The complete page-native quote remains searchable across a Gecko compartment boundary.";
    const fixture = createExactFindControllerReader({
      pageItems: [[{ str: quote }]],
      targetPageIndex: 0,
    });
    const app = fixture.reader._window.PDFViewerApplication;
    app.pdfDocument.getPage = async () => ({
      getTextContent: async (options?: { disableNormalization?: boolean }) => {
        if (options) throw new Error("Permission denied to pass options");
        return { items: [{ str: quote }] };
      },
    });

    const result = await scrollToExactQuoteInReader(fixture.reader, quote, {
      citationId: "Q_cross_realm_options",
      expectedPageIndex: 0,
    });

    assert.isTrue(result.matched);
    assert.equal(result.queryUsed, quote);
    assert.lengthOf(fixture.dispatched, 1);
  });

  it("keeps a complete query above 10,000 characters", async function () {
    const quote = `${"complete page-native quote ".repeat(450)}ending`;
    const fixture = createExactFindControllerReader({
      pageItems: [[{ str: quote }]],
      targetPageIndex: 0,
    });

    const result = await scrollToExactQuoteInReader(fixture.reader, quote, {
      expectedPageIndex: 0,
    });

    assert.isAbove(quote.length, 10_000);
    assert.isTrue(result.matched);
    assert.equal(result.queryUsed, quote);
    assert.lengthOf(result.queries, 1);
  });

  it("uses bounded native findagain commands to select a duplicate page occurrence", async function () {
    const quote =
      "The duplicated complete quote remains long enough to identify its intended page occurrence.";
    const fixture = createExactFindControllerReader({
      pageItems: [[{ str: `${quote}\nIntervening text.\n${quote}` }]],
      targetPageIndex: 0,
      matchCount: 2,
    });

    const result = await scrollToExactQuoteInReader(fixture.reader, quote, {
      expectedPageIndex: 0,
      sourceMatchPageOccurrence: 1,
    });

    assert.isTrue(result.matched);
    assert.equal(fixture.findController.selected.matchIdx, 1);
    assert.deepEqual(
      fixture.dispatched.map((entry) => entry.type),
      ["", "again"],
    );
  });

  it("fails closed when a duplicate occurrence is not identified", async function () {
    const quote =
      "The duplicated complete quote remains long enough to require an occurrence.";
    const fixture = createExactFindControllerReader({
      pageItems: [[{ str: `${quote}\nIntervening text.\n${quote}` }]],
      targetPageIndex: 0,
      matchCount: 2,
    });

    const result = await scrollToExactQuoteInReader(fixture.reader, quote, {
      expectedPageIndex: 0,
    });

    assert.isFalse(result.matched);
    assert.equal(result.failureStage, "full-quote-not-on-page");
    assert.isEmpty(fixture.dispatched);
  });

  it("restores the previous FindController query after an exact-match failure", async function () {
    const quote =
      "The complete quote aligns to the page but FindController unexpectedly reports no match.";
    const previousQuery = "user's existing find query";
    const fixture = createExactFindControllerReader({
      pageItems: [[{ str: quote }]],
      targetPageIndex: 0,
      shouldMatch: false,
      previousQuery,
    });

    const result = await scrollToExactQuoteInReader(fixture.reader, quote, {
      expectedPageIndex: 0,
    });

    assert.isFalse(result.matched);
    assert.equal(result.failureStage, "full-match-not-found");
    const dispatchedQueries = fixture.dispatched.map((entry) => entry.query);
    assert.equal(dispatchedQueries[0], quote);
    assert.equal(
      dispatchedQueries[dispatchedQueries.length - 1],
      previousQuery,
    );
    assert.isTrue(
      dispatchedQueries.some(
        (query) => query !== quote && query !== previousQuery,
      ),
    );
    assert.equal(fixture.findController._rawQuery, previousQuery);
    assert.equal(fixture.getListenerCount(), 0);
  });

  it("accepts delayed find-field handling without dispatching a fallback search", async function () {
    const quote =
      "The complete delayed query is accepted by the native find field before the bounded deadline.";
    const fixture = createExactFindControllerReader({
      pageItems: [[{ str: quote }]],
      targetPageIndex: 0,
      delayedAcceptanceMs: 80,
    });

    const result = await scrollToExactQuoteInReader(fixture.reader, quote, {
      expectedPageIndex: 0,
    });

    assert.isTrue(result.matched);
    assert.isEmpty(fixture.dispatched);
    assert.equal(fixture.findController._rawQuery, quote);
  });

  it("keeps a FindController match that arrives after the former 2.5-second deadline", async function () {
    this.timeout(6_000);
    const quote =
      "The page-nine quote is discovered by FindController after its old fixed deadline.";
    const fixture = createExactFindControllerReader({
      pageItems: [[{ str: quote }]],
      targetPageIndex: 0,
      delayedResultsMs: 2_650,
    });

    const startedAt = Date.now();
    const result = await scrollToExactQuoteInReader(fixture.reader, quote, {
      expectedPageIndex: 0,
    });

    assert.isAtLeast(Date.now() - startedAt, 2_500);
    assert.isTrue(result.matched);
    assert.equal(result.matchStatus, "found");
    assert.equal(result.navigationStatus, "paragraph-selected");
    assert.equal(fixture.getListenerCount(), 0);
  });

  it("cancels a superseded citation click without restoring stale search state", async function () {
    const firstQuote =
      "The first citation search is superseded while its native results are still pending.";
    const secondQuote =
      "The second citation search becomes the only active native FindController query.";
    const fixture = createExactFindControllerReader({
      pageItems: [[{ str: `${firstQuote} ${secondQuote}` }]],
      targetPageIndex: 0,
      delayedResultsMs: 350,
    });

    const first = scrollToExactQuoteInReader(fixture.reader, firstQuote, {
      expectedPageIndex: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    fixture.setDelayedResultsMs(undefined);
    const second = await scrollToExactQuoteInReader(
      fixture.reader,
      secondQuote,
      { expectedPageIndex: 0 },
    );
    const superseded = await first;

    assert.isTrue(second.matched);
    assert.equal(second.navigationStatus, "paragraph-selected");
    assert.isFalse(superseded.matched);
    assert.equal(superseded.matchStatus, "deferred");
    assert.equal(superseded.failureStage, "cancelled");
    assert.equal(fixture.findController._rawQuery, secondQuote);
    assert.equal(fixture.getListenerCount(), 0);
  });

  it("keeps a discovered quote successful when paragraph occurrence selection fails", async function () {
    const quote =
      "The repeated source quote remains verified even when native occurrence selection fails.";
    const fixture = createExactFindControllerReader({
      pageItems: [[{ str: `${quote}\nIntervening text.\n${quote}` }]],
      targetPageIndex: 0,
      matchCount: 2,
      ignoreFindAgain: true,
    });

    const result = await scrollToExactQuoteInReader(fixture.reader, quote, {
      expectedPageIndex: 0,
      sourceMatchPageOccurrence: 1,
    });

    assert.isTrue(result.matched);
    assert.equal(result.matchStatus, "found");
    assert.equal(result.navigationStatus, "page-only");
    assert.equal(result.failureStage, "intended-match-not-selected");
  });

  it("accepts a positive match on a different page without revoking success", async function () {
    const quote =
      "The source-backed quote can move pages within the same verified attachment.";
    const fixture = createExactFindControllerReader({
      pageItems: [[{ str: quote }], [{ str: quote }]],
      targetPageIndex: 0,
      resultPageIndex: 1,
    });

    const result = await scrollToExactQuoteInReader(fixture.reader, quote, {
      expectedPageIndex: 0,
    });

    assert.isTrue(result.matched);
    assert.equal(result.matchStatus, "found");
    assert.equal(result.matchedPageIndex, 1);
    assert.equal(result.navigationStatus, "paragraph-selected");
  });

  it("fails before search when the PDF.js fingerprint does not match", async function () {
    const quote =
      "The complete quote belongs to one exact PDF attachment and page.";
    const fixture = createExactFindControllerReader({
      pageItems: [[{ str: quote }]],
      targetPageIndex: 0,
      fingerprint: "loaded-pdf",
    });

    const result = await scrollToExactQuoteInReader(fixture.reader, quote, {
      expectedPageIndex: 0,
      sourceFingerprint: "pdfjs:different-pdf",
    });

    assert.isFalse(result.matched);
    assert.equal(result.failureStage, "source-fingerprint-mismatch");
    assert.isEmpty(fixture.dispatched);
  });
});

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
  buildRawPrefixQueries,
  locateQuoteByRawPrefixInPages,
  scrollToExactQuoteInReader,
  warmPageTextCacheForAttachment,
  warmQuoteLocationCacheForAttachment,
} from "../src/modules/contextPanel/livePdfSelectionLocator";

function installPdfWorkerStub(
  handler: (
    itemId: number,
  ) => Promise<{ text: string; pageChars: number[] } | null>,
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

  it("preserves exact duplicate quote ambiguity without FindController", async function () {
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

      assert.equal(result.status, "ambiguous");
      assert.isNull(result.computedPageIndex);
      assert.deepEqual(result.matchedPageIndexes, [0, 2]);
    } finally {
      restore();
    }
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

describe("citation page cache warming", function () {
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

  it("does not cache hidden quote locations for exact duplicate quotes", async function () {
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

      assert.isNull(location);
      assert.isNull(lookupCachedQuoteLocationForAttachment(808, quote));
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

  it("prefers long ellipsis segments before short suffix queries", function () {
    const result = buildRawPrefixQueries(
      "Theorem 4.4 (Shell escape). ... evolution candidates have expected log-probability strictly beyond the shell boundary. Moreover, a positive fraction of evolution candidates escape the shell.",
    );

    assert.equal(
      result[0],
      "evolution candidates have expected log-probability strictly beyond the shell boundary. Moreover, a positive fraction of evolution candidates escape the shell.",
    );
    assert.isAbove(
      result.indexOf("escape the shell"),
      0,
      "short suffix should come after a meaningful ellipsis segment",
    );
  });
});

describe("scrollToExactQuoteInReader", function () {
  function createFindControllerReader(
    pageMatches: unknown[],
    options?: {
      page?: number;
      dispatchMatchesCountTotal?: number;
      dispatchSelectedPageIdx?: number;
      findBarCountText?: string;
      matchesCountTotal?: number;
      pagesCount?: number;
      dispatchedQueries?: string[];
      pageMatchesByQuery?: Record<string, unknown[]>;
      selectedPageIdx?: number;
    },
  ) {
    const findController = {
      _rawQuery: "",
      pageMatches: [] as unknown[],
      _pendingFindMatches: new Set<unknown>(),
      _pagesToSearch: 0,
      matchesCount:
        options?.matchesCountTotal !== undefined
          ? { total: options.matchesCountTotal }
          : undefined,
      selected:
        options?.selectedPageIdx !== undefined
          ? { pageIdx: options.selectedPageIdx }
          : undefined,
    };
    const findBar = options?.findBarCountText
      ? {
          open: () => undefined,
          findResultsCount: { textContent: options.findBarCountText },
        }
      : undefined;
    const eventBus = {
      dispatch: (_eventName: string, params: { query: string }) => {
        options?.dispatchedQueries?.push(params.query);
        findController._rawQuery = params.query;
        findController.pageMatches =
          options?.pageMatchesByQuery?.[params.query] ?? pageMatches;
        if (options?.dispatchMatchesCountTotal !== undefined) {
          findController.matchesCount = {
            total: options.dispatchMatchesCountTotal,
          };
        }
        if (options?.dispatchSelectedPageIdx !== undefined) {
          findController.selected = {
            pageIdx: options.dispatchSelectedPageIdx,
          };
        }
      },
    };
    return {
      _window: {
        PDFViewerApplication: {
          pdfDocument: { numPages: options?.pagesCount ?? 3 },
          pagesCount: options?.pagesCount ?? 3,
          page: options?.page ?? 2,
          eventBus,
          findBar,
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

  it("treats FindController match counts as hits only with a selected match page", async function () {
    const reader = createFindControllerReader([], {
      dispatchMatchesCountTotal: 1,
      dispatchSelectedPageIdx: 2,
    });
    const result = await scrollToExactQuoteInReader(
      reader,
      "Representational drift remained stable across repeated measurements in the target region.",
      { expectedPageIndex: null },
    );

    assert.isTrue(result.matched);
    assert.equal(result.matchedPageIndex, 2);
    assert.include(result.reason, "page 3");
  });

  it("uses cached page text to skip non-unique FindController queries before paragraph jump", async function () {
    clearPageTextCache();
    const quote =
      "Ambiguous lead phrase connects to unique discriminating phrase for citation navigation.";
    const uniqueQuery = "discriminating phrase for citation navigation";
    const dispatchedQueries: string[] = [];
    const reader: any = createFindControllerReader([], {
      dispatchedQueries,
      pageMatchesByQuery: {
        [uniqueQuery]: [[], [0], []],
      },
    });
    reader._item = { id: 909 };
    reader.itemID = 909;
    const pageOne = "Background page with no useful paragraph text.";
    const pageTwo =
      "The extracted PDF text exposes discriminating phrase for citation navigation here.";
    const pageThree = "Closing page with unrelated text.";
    const restore = installPdfWorkerStub(async () => ({
      text: pageOne + pageTwo + pageThree,
      pageChars: [pageOne.length, pageTwo.length, pageThree.length],
    }));

    try {
      const result = await scrollToExactQuoteInReader(reader, quote, {
        expectedPageIndex: 1,
      });

      assert.isTrue(result.matched);
      assert.equal(result.matchedPageIndex, 1);
      assert.deepEqual(dispatchedQueries, [uniqueQuery]);
    } finally {
      restore();
    }
  });

  it("does not let a partial DOM page-text cache veto FindController search", async function () {
    clearPageTextCache();
    const quote =
      "A globally searchable quote appears only on an unrendered PDF page during citation navigation.";
    const dispatchedQueries: string[] = [];
    const reader: any = createFindControllerReader(
      [[], [], [], [], [], [], [], [0]],
      {
        dispatchedQueries,
        pagesCount: 8,
      },
    );
    reader._window.document = {
      querySelectorAll: () => [
        {
          nodeType: 1,
          parentElement: null,
          textContent: "Rendered first page without the cited quote.",
          getAttribute: (name: string) =>
            name === "data-page-number" ? "1" : null,
          querySelector: () => ({
            children: [
              {
                textContent: "Rendered first page without the cited quote.",
              },
            ],
            textContent: "Rendered first page without the cited quote.",
          }),
        },
        {
          nodeType: 1,
          parentElement: null,
          textContent: "Rendered second page also lacks it.",
          getAttribute: (name: string) =>
            name === "data-page-number" ? "2" : null,
          querySelector: () => ({
            children: [
              {
                textContent: "Rendered second page also lacks it.",
              },
            ],
            textContent: "Rendered second page also lacks it.",
          }),
        },
      ],
    };
    const restore = installPdfWorkerStub(async () => null);

    try {
      const result = await scrollToExactQuoteInReader(reader, quote, {
        expectedPageIndex: null,
      });

      assert.isTrue(result.matched);
      assert.equal(result.matchedPageIndex, 7);
      assert.isAbove(
        dispatchedQueries.length,
        0,
        "FindController should run when only a partial DOM cache was checked",
      );
    } finally {
      restore();
    }
  });

  it("lets a complete page-text cache veto ambiguous FindController searches", async function () {
    clearPageTextCache();
    const quote =
      "Repeated complete-cache quote remains ambiguous across two extracted PDF pages.";
    const dispatchedQueries: string[] = [];
    const reader: any = createFindControllerReader([[], [0], []], {
      dispatchedQueries,
    });
    reader._item = { id: 910 };
    reader.itemID = 910;
    const pageOne = `${quote} First occurrence.`;
    const pageTwo = `Middle page without the quote.`;
    const pageThree = `${quote} Second occurrence.`;
    const restore = installPdfWorkerStub(async () => ({
      text: pageOne + pageTwo + pageThree,
      pageChars: [pageOne.length, pageTwo.length, pageThree.length],
    }));

    try {
      const result = await scrollToExactQuoteInReader(reader, quote, {
        expectedPageIndex: null,
      });

      assert.isFalse(result.matched);
      assert.include(result.reason, "Cached page text found multiple");
      assert.deepEqual(dispatchedQueries, []);
    } finally {
      restore();
    }
  });

  it("does not use stale FindController counts and selected pages as a match", async function () {
    const reader = createFindControllerReader([], {
      matchesCountTotal: 1,
      selectedPageIdx: 2,
    });
    const result = await scrollToExactQuoteInReader(
      reader,
      "Representational drift remained stable across repeated measurements in the target region.",
      { expectedPageIndex: null },
    );

    assert.isFalse(result.matched);
    assert.isUndefined(result.matchedPageIndex);
  });

  it("does not use stale find-bar counts and the current viewport page as a match", async function () {
    const reader = createFindControllerReader([], {
      page: 3,
      findBarCountText: "1 of 1",
    });
    const result = await scrollToExactQuoteInReader(
      reader,
      "Representational drift remained stable across repeated measurements in the target region.",
      { expectedPageIndex: null },
    );

    assert.isFalse(result.matched);
    assert.isUndefined(result.matchedPageIndex);
  });

  it("does not choose an arbitrary page when FindController reports multiple pages", async function () {
    const reader = createFindControllerReader([[0], [], [0]]);
    const result = await scrollToExactQuoteInReader(
      reader,
      "Representational drift remained stable across repeated measurements in the target region.",
      { expectedPageIndex: null },
    );

    assert.isFalse(result.matched);
    assert.isUndefined(result.matchedPageIndex);
    assert.include(result.reason, "multiple pages");
  });

  it("does not treat a selected highlighted result as unique when FindController reports multiple matches", async function () {
    const reader = createFindControllerReader([[0], [], [0]], {
      dispatchSelectedPageIdx: 0,
    });
    const result = await scrollToExactQuoteInReader(
      reader,
      "modulation of firing-rate adaptation strength within a continuous attractor model of place cells gives rise to these distinct forms of replay.",
      { expectedPageIndex: 1 },
    );

    assert.isFalse(result.matched);
    assert.isUndefined(result.matchedPageIndex);
    assert.include(result.reason, "multiple");
  });

  it("rejects the selected highlighted page when FindController reports multiple pages", async function () {
    const reader = createFindControllerReader([[0], [], [0]], {
      dispatchSelectedPageIdx: 2,
    });
    const result = await scrollToExactQuoteInReader(
      reader,
      "Representational drift remained stable across repeated measurements in the target region.",
      { expectedPageIndex: null },
    );

    assert.isFalse(result.matched);
    assert.isUndefined(result.matchedPageIndex);
    assert.include(result.reason, "multiple");
  });

  it("rejects selected count-only FindController matches when the count is not unique", async function () {
    const reader = createFindControllerReader([], {
      dispatchMatchesCountTotal: 2,
      dispatchSelectedPageIdx: 1,
    });
    const result = await scrollToExactQuoteInReader(
      reader,
      "Representational drift remained stable across repeated measurements in the target region.",
      { expectedPageIndex: null },
    );

    assert.isFalse(result.matched);
    assert.isUndefined(result.matchedPageIndex);
    assert.include(result.reason, "multiple");
  });

  it("resolves live quote lookup from FindController count plus selected page", async function () {
    const originalZotero = (globalThis as any).Zotero;
    const originalZtoolkit = (globalThis as any).ztoolkit;
    (globalThis as any).Zotero = {
      PDFWorker: {
        getFullText: async () => null,
      },
    };
    (globalThis as any).ztoolkit = { log: () => undefined };
    const reader = createFindControllerReader([], {
      dispatchMatchesCountTotal: 1,
      dispatchSelectedPageIdx: 1,
    });

    try {
      const result = await locateQuoteInLivePdfReader(
        reader,
        "Representational drift remained stable across repeated measurements in the target region.",
      );

      assert.equal(result.status, "resolved");
      assert.equal(result.computedPageIndex, 1);
      assert.include(result.reason || "", "page 2");
    } finally {
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
    }
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

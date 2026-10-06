import { assert } from "chai";
import {
  buildParagraphJumpSuccessStatus,
  navigateToQuote,
  type QuoteNavigationRequest,
  type QuoteNavigatorDeps,
} from "../src/modules/contextPanel/quoteNavigator";
import type { QuoteTargetVerification } from "../src/modules/contextPanel/quoteCitationTargetResolver";
import type {
  ExactQuoteJumpResult,
  LivePdfSelectionLocateResult,
} from "../src/services/pdf/livePdfSelectionLocator";

type Call = [string, ...unknown[]];

/**
 * Fake steps for `navigateToQuote`. `texts` says which attachment holds which
 * page text in the background (null: unreadable); `viewer` the same for an
 * opened reader. Every call is recorded in order.
 */
function fakeDeps(options: {
  texts: Record<number, string[] | null>;
  viewer?: Record<number, string[]>;
  jumpMatches?: boolean;
  /** A failed jump's failure stage, by the attachment it ran on. */
  jumpFailures?: Record<number, string>;
  openFails?: boolean;
}) {
  const calls: Call[] = [];
  const findPage = (pages: string[] | undefined, quote: string) =>
    (pages || []).findIndex((text) => text.includes(quote));
  const deps: QuoteNavigatorDeps = {
    verifyInBackground: async (
      candidate,
      quoteText,
    ): Promise<QuoteTargetVerification> => {
      calls.push(["verify", candidate.contextItemId, quoteText]);
      const pages = options.texts[candidate.contextItemId];
      if (pages === null) return { status: "unavailable", reason: "unread" };
      const pageIndex = findPage(pages, quoteText);
      return pageIndex < 0
        ? { status: "not-found", reason: `not in ${candidate.contextItemId}` }
        : {
            status: "resolved",
            pageIndex,
            sourceMatchText: `${quoteText}.`,
            sourceMatchPageOccurrence: 0,
          };
    },
    openReader: async (contextItemId, location) => {
      calls.push(["open", contextItemId, location]);
      return options.openFails ? null : { contextItemId };
    },
    locateInReader: async (reader, quoteText) => {
      calls.push(["locate", reader.contextItemId, quoteText]);
      const pageIndex = findPage(
        options.viewer?.[reader.contextItemId],
        quoteText,
      );
      return {
        status: pageIndex < 0 ? "not-found" : "resolved",
        computedPageIndex: pageIndex < 0 ? null : pageIndex,
        sourceMatchText: quoteText,
        sourceMatchPageOccurrence: 0,
        reason: pageIndex < 0 ? "viewer miss" : "",
      } as unknown as LivePdfSelectionLocateResult;
    },
    jump: async (params) => {
      const { reader: _reader, ...rest } = params;
      void _reader;
      calls.push(["jump", rest]);
      const failureStage = options.jumpFailures?.[rest.contextItemId];
      if (failureStage) {
        return {
          matched: false,
          failureStage,
          reason: failureStage,
          queries: [],
        } as unknown as ExactQuoteJumpResult;
      }
      return {
        matched: options.jumpMatches ?? true,
        matchedPageIndex: options.jumpMatches === false ? undefined : 4,
        ...(options.jumpMatches === false
          ? {}
          : { wordingUsed: rest.preferredFullQuoteText || rest.quoteText }),
        queries: [],
      } as unknown as ExactQuoteJumpResult;
    },
    pageLabelFor: (_reader, pageIndex) => `L${pageIndex}`,
    rememberPage: (...args) => {
      calls.push(["remember", ...args]);
      return null;
    },
  };
  return { deps, calls };
}

function request(
  patch: Partial<QuoteNavigationRequest> = {},
): QuoteNavigationRequest {
  return {
    candidates: [
      { contextItemId: 1, authoritative: false, labelRank: 0 },
      { contextItemId: 2, authoritative: false, labelRank: 0 },
    ],
    searchTexts: ["the quote"],
    displayCitationLabel: "Smith, 2020",
    policy: {
      jumpFallbackTexts: false,
      rememberPage: true,
    },
    ...patch,
  };
}

describe("navigateToQuote (verify-first)", function () {
  it("reads every candidate before opening only the one that holds the quote", async function () {
    const { deps, calls } = fakeDeps({
      texts: { 1: ["nothing"], 2: ["intro", "has the quote here"] },
    });

    const outcome = await navigateToQuote(request(), deps);

    assert.deepEqual(
      calls.map((call) => call[0]),
      ["verify", "verify", "open", "jump", "remember"],
    );
    assert.deepEqual(calls[2], [
      "open",
      2,
      { pageIndex: 1, pageLabel: undefined },
    ]);
    assert.deepEqual(calls[3], [
      "jump",
      {
        contextItemId: 2,
        displayCitationLabel: "Smith, 2020",
        quoteText: "the quote",
        pageIndex: 1,
        pageLabel: "L1",
        sourceMatchPageOccurrence: 0,
        verifiedSourceMatchText: "the quote.",
      },
    ]);
    // The page the jump landed on is remembered, with its label.
    assert.deepEqual(calls[4], ["remember", 2, "the quote", 4, "L4"]);
    assert.deepEqual(outcome, {
      kind: "jumped",
      tier: "verified",
      contextItemId: 2,
      pageIndex: 4,
      pageLabel: "L4",
      jump: outcome.kind === "jumped" ? outcome.jump : (null as never),
    });
  });

  it("remembers nothing and passes every search text on when the policy says so", async function () {
    const { deps, calls } = fakeDeps({ texts: { 1: ["the quote"] } });

    await navigateToQuote(
      request({
        candidates: [{ contextItemId: 1, authoritative: true, labelRank: 0 }],
        searchTexts: ["the quote", "the quote, raw"],
        policy: {
          jumpFallbackTexts: true,
          rememberPage: false,
        },
      }),
      deps,
    );

    assert.notInclude(
      calls.map((call) => call[0]),
      "remember",
    );
    const jump = calls.find((call) => call[0] === "jump")![1] as Record<
      string,
      unknown
    >;
    assert.deepEqual(jump.fallbackQuoteTexts, ["the quote", "the quote, raw"]);
  });

  it("reports no candidates without reading anything", async function () {
    const { deps, calls } = fakeDeps({ texts: {} });

    assert.deepEqual(await navigateToQuote(request({ candidates: [] }), deps), {
      kind: "no-candidates",
    });
    assert.deepEqual(
      await navigateToQuote(request({ searchTexts: [] }), deps),
      { kind: "no-candidates" },
    );
    assert.deepEqual(calls, []);
  });

  it("asks for more candidates only after the first ones miss, and reads only new ones", async function () {
    const { deps, calls } = fakeDeps({
      texts: { 1: ["nothing"], 3: ["the quote"] },
    });
    let asked = 0;

    const outcome = await navigateToQuote(
      request({
        candidates: [{ contextItemId: 1, authoritative: true, labelRank: 0 }],
        moreCandidates: async () => {
          asked += 1;
          return [
            { contextItemId: 1, authoritative: false, labelRank: 0 },
            { contextItemId: 3, authoritative: false, labelRank: 0 },
          ];
        },
      }),
      deps,
    );

    assert.equal(asked, 1);
    assert.deepEqual(
      calls.filter((call) => call[0] === "verify").map((call) => call[1]),
      [1, 3],
    );
    assert.equal(outcome.kind, "jumped");
  });

  it("does not ask for more candidates when the first ones resolve", async function () {
    const { deps } = fakeDeps({ texts: { 1: ["the quote"] } });
    let asked = 0;

    await navigateToQuote(
      request({
        moreCandidates: async () => {
          asked += 1;
          return [];
        },
      }),
      deps,
    );

    assert.equal(asked, 0);
  });

  it("opens at most three unreadable papers in the viewer, in verdict order", async function () {
    const { deps, calls } = fakeDeps({
      texts: { 1: null, 2: null, 3: null, 4: null },
      viewer: { 4: ["the quote"] },
    });

    const outcome = await navigateToQuote(
      request({
        candidates: [1, 2, 3, 4].map((contextItemId) => ({
          contextItemId,
          authoritative: true,
          labelRank: 0,
        })),
      }),
      deps,
    );

    assert.deepEqual(
      calls.filter((call) => call[0] === "open").map((call) => call[1]),
      [1, 2, 3],
    );
    assert.deepEqual(outcome, { kind: "unverifiable", reason: "viewer miss" });
  });

  it("skips a paper the caller says cannot be opened in the viewer", async function () {
    const { deps, calls } = fakeDeps({
      texts: { 1: null },
      viewer: { 1: ["the quote"] },
    });

    const outcome = await navigateToQuote(
      request({
        candidates: [{ contextItemId: 1, authoritative: true, labelRank: 0 }],
        openableInViewer: () => false,
      }),
      deps,
    );

    assert.deepEqual(
      calls.map((call) => call[0]),
      ["verify"],
    );
    assert.deepEqual(outcome, { kind: "unverifiable", reason: "unread" });
  });

  it("reports the page when the jump cannot highlight the verified quote", async function () {
    const { deps, calls } = fakeDeps({
      texts: { 1: ["the quote"] },
      jumpMatches: false,
    });

    const outcome = await navigateToQuote(request(), deps);

    assert.equal(outcome.kind, "page-only");
    assert.include(outcome as object, {
      contextItemId: 1,
      pageIndex: 0,
      pageLabel: "L0",
    });
    assert.notInclude(
      calls.map((call) => call[0]),
      "remember",
    );
  });

  it("reports a winner whose reader will not open", async function () {
    const { deps } = fakeDeps({ texts: { 1: ["the quote"] }, openFails: true });

    assert.deepEqual(await navigateToQuote(request(), deps), {
      kind: "open-failed",
      contextItemId: 1,
    });
  });

  it("reports the best-first verdict when no paper holds the quote", async function () {
    const { deps } = fakeDeps({ texts: { 1: ["nothing"], 2: ["nothing"] } });
    const stages: string[] = [];

    const outcome = await navigateToQuote(
      request({ trace: (stage) => stages.push(stage) }),
      deps,
    );

    assert.deepEqual(outcome, { kind: "not-found", reason: "not in 1" });
    assert.deepEqual(stages, ["quote verification"]);
  });
});

describe("navigateToQuote with a trusted quote's record", function () {
  const certificate = {
    citationId: "q1",
    sourceFingerprint: "pdfjs:fp-2",
    verifiedFullSpan: true,
  };

  it("hands the jump the certificate and the fuller passage, after verifying", async function () {
    const { deps, calls } = fakeDeps({ texts: { 1: ["the quote"] } });

    await navigateToQuote(
      request({
        candidates: [{ contextItemId: 1, authoritative: true, labelRank: 0 }],
        certificate: { ...certificate, sourceMatchPageOccurrence: 3 },
        preferredFullQuoteText: "the quote, in full",
      }),
      deps,
    );

    assert.deepEqual(
      calls.map((call) => call[0]),
      ["verify", "open", "jump", "remember"],
    );
    assert.deepEqual(calls[2], [
      "jump",
      {
        contextItemId: 1,
        displayCitationLabel: "Smith, 2020",
        quoteText: "the quote",
        pageIndex: 0,
        pageLabel: "L0",
        citationId: "q1",
        sourceFingerprint: "pdfjs:fp-2",
        // The certificate's occurrence wins over the verified one (0).
        sourceMatchPageOccurrence: 3,
        preferredFullQuoteText: "the quote, in full",
        verifiedSourceMatchText: "the quote.",
        verifiedFullSpan: true,
      },
    ]);
  });

  it("reads a paper with a cached page first, and still verifies it before opening", async function () {
    const { deps, calls } = fakeDeps({
      texts: { 1: ["the quote"], 2: ["the quote"] },
    });

    const outcome = await navigateToQuote(
      request({
        candidates: [
          { contextItemId: 1, authoritative: true, labelRank: 5 },
          {
            contextItemId: 2,
            authoritative: true,
            labelRank: 0,
            cachedPage: true,
          },
        ],
      }),
      deps,
    );

    assert.deepEqual(calls.slice(0, 2), [
      ["verify", 2, "the quote"],
      ["open", 2, { pageIndex: 0, pageLabel: undefined }],
    ]);
    assert.include(outcome as object, { kind: "jumped", contextItemId: 2 });
  });

  it("opens nothing for a quote no candidate holds, cached page or not", async function () {
    const { deps, calls } = fakeDeps({ texts: { 1: ["nothing"] } });

    const outcome = await navigateToQuote(
      request({
        candidates: [
          {
            contextItemId: 1,
            authoritative: true,
            labelRank: 0,
            cachedPage: true,
          },
        ],
        certificate,
      }),
      deps,
    );

    assert.deepEqual(outcome, { kind: "not-found", reason: "not in 1" });
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["verify"],
    );
  });

  it("moves on from a verified paper whose PDF is not the one the certificate names", async function () {
    const { deps, calls } = fakeDeps({
      texts: { 1: ["the quote"], 2: ["the quote"] },
      jumpFailures: { 1: "source-fingerprint-mismatch" },
    });

    const outcome = await navigateToQuote(
      request({
        candidates: [
          { contextItemId: 1, authoritative: true, labelRank: 0 },
          { contextItemId: 2, authoritative: true, labelRank: 0 },
        ],
        certificate,
      }),
      deps,
    );

    assert.deepEqual(
      calls.map((call) => [
        call[0],
        typeof call[1] === "number" ? call[1] : "",
      ]),
      [
        ["verify", 1],
        ["open", 1],
        ["jump", ""],
        // Paper 1 is ruled out; paper 2 is verified before it opens.
        ["verify", 2],
        ["open", 2],
        ["jump", ""],
        ["remember", 2],
      ],
    );
    assert.include(outcome as object, { kind: "jumped", contextItemId: 2 });
  });

  it("stays on the last wrong PDF when no other paper holds the quote", async function () {
    const { deps, calls } = fakeDeps({
      texts: { 1: ["the quote"], 2: ["nothing"] },
      jumpFailures: { 1: "source-fingerprint-mismatch" },
    });

    const outcome = await navigateToQuote(
      request({
        candidates: [
          { contextItemId: 1, authoritative: true, labelRank: 0 },
          { contextItemId: 2, authoritative: true, labelRank: 0 },
        ],
        certificate,
      }),
      deps,
    );

    assert.equal(outcome.kind, "page-only");
    assert.include(outcome as object, { contextItemId: 1, pageIndex: 0 });
    assert.deepEqual(
      calls.filter((call) => call[0] === "open").map((call) => call[1]),
      [1],
    );
  });

  it("does not move on after a jump that fails for any other reason", async function () {
    const { deps, calls } = fakeDeps({
      texts: { 1: ["the quote"], 2: ["the quote"] },
      jumpFailures: { 1: "full-match-not-found" },
    });

    const outcome = await navigateToQuote(
      request({
        candidates: [
          { contextItemId: 1, authoritative: true, labelRank: 0 },
          { contextItemId: 2, authoritative: true, labelRank: 0 },
        ],
        certificate,
      }),
      deps,
    );

    assert.equal(outcome.kind, "page-only");
    assert.deepEqual(
      calls.filter((call) => call[0] === "open").map((call) => call[1]),
      [1],
    );
  });

  it("keeps the viewer fallback to three opened papers across a ruled-out PDF, and never reopens one it read", async function () {
    const { deps, calls } = fakeDeps({
      texts: { 1: null, 2: null, 3: null, 4: null },
      viewer: { 2: ["the quote"], 3: ["the quote"], 4: ["the quote"] },
      jumpFailures: { 2: "source-fingerprint-mismatch" },
    });

    const outcome = await navigateToQuote(
      request({
        candidates: [1, 2, 3, 4].map((contextItemId) => ({
          contextItemId,
          authoritative: true,
          labelRank: 0,
        })),
        certificate,
      }),
      deps,
    );

    // 1 is read in the viewer and holds nothing. 2 holds the quote and opens
    // again as the winner, but its jump finds another PDF. The second pass
    // skips 1 (already read) and 2 (ruled out) and spends the last viewer
    // open on 3, which holds the quote. 4 is never opened.
    assert.deepEqual(
      calls.filter((call) => call[0] === "open").map((call) => call[1]),
      [1, 2, 2, 3, 3],
    );
    assert.include(outcome as object, { kind: "jumped", contextItemId: 3 });
  });

  it("says when a page tie was settled on the first copy, and only then", async function () {
    const { deps, calls } = fakeDeps({ texts: { 1: ["the quote"] } });
    const verify = deps.verifyInBackground;
    deps.verifyInBackground = async (candidate, quoteText, recorded) => ({
      ...(await verify(candidate, quoteText, recorded)),
      samePageCopyCount: 2,
    });

    const outcome = await navigateToQuote(
      request({
        candidates: [{ contextItemId: 1, authoritative: true, labelRank: 0 }],
        certificate: { ...certificate, pageIndex: 0 },
      }),
      deps,
    );

    assert.include(outcome as object, { kind: "jumped", samePageCopyCount: 2 });
    const jump = calls.find((call) => call[0] === "jump")![1] as {
      sourceMatchPageOccurrence?: number;
    };
    assert.equal(jump.sourceMatchPageOccurrence, 0, "the first copy");

    const plain = fakeDeps({ texts: { 1: ["the quote"] } });
    const unique = await navigateToQuote(
      request({
        candidates: [{ contextItemId: 1, authoritative: true, labelRank: 0 }],
        certificate,
      }),
      plain.deps,
    );
    assert.notProperty(unique, "samePageCopyCount");
  });

  it("says nothing about copies when the jump matched the fuller passage", async function () {
    // The fuller passage can occur once and hold the second copy, so the
    // first-copy note would be wrong.
    const { deps } = fakeDeps({ texts: { 1: ["the quote"] } });
    const verify = deps.verifyInBackground;
    deps.verifyInBackground = async (candidate, quoteText, recorded) => ({
      ...(await verify(candidate, quoteText, recorded)),
      samePageCopyCount: 2,
    });

    const outcome = await navigateToQuote(
      request({
        candidates: [{ contextItemId: 1, authoritative: true, labelRank: 0 }],
        certificate: { ...certificate, pageIndex: 0 },
        preferredFullQuoteText: "Replication. the quote",
      }),
      deps,
    );

    assert.equal(outcome.kind, "jumped");
    assert.notProperty(outcome, "samePageCopyCount");
  });
});

describe("navigateToQuote for a reader with no page labels (D5)", function () {
  it("opens and jumps by page index only, remembers no label, and numbers the page for display", async function () {
    const { deps, calls } = fakeDeps({
      texts: { 1: null },
      viewer: { 1: ["x", "the quote"] },
    });
    deps.pageLabelFor = () => undefined;

    const outcome = await navigateToQuote(
      request({
        candidates: [{ contextItemId: 1, authoritative: true, labelRank: 0 }],
      }),
      deps,
    );

    const opens = calls.filter((call) => call[0] === "open");
    assert.deepEqual(opens, [
      ["open", 1, undefined],
      // No label: openReaderForItem drops the empty key.
      ["open", 1, { pageIndex: 1, pageLabel: undefined }],
    ]);
    const jump = calls.find((call) => call[0] === "jump")![1] as object;
    assert.notProperty(jump, "pageLabel");
    // The fake jump lands on page index 4.
    assert.deepEqual(
      calls.find((call) => call[0] === "remember"),
      ["remember", 1, "the quote", 4, undefined],
    );
    assert.include(outcome as object, {
      kind: "jumped",
      pageIndex: 4,
      pageLabel: "5",
    });
  });

  it("reports a page it could not highlight by its number", async function () {
    const { deps } = fakeDeps({
      texts: { 1: ["the quote"] },
      jumpMatches: false,
    });
    deps.pageLabelFor = () => undefined;

    const outcome = await navigateToQuote(
      request({
        candidates: [{ contextItemId: 1, authoritative: true, labelRank: 0 }],
      }),
      deps,
    );

    assert.include(outcome as object, {
      kind: "page-only",
      pageIndex: 0,
      pageLabel: "1",
    });
  });
});

describe("buildParagraphJumpSuccessStatus", function () {
  const selected = {
    matched: true,
    navigationStatus: "paragraph-selected",
  } as unknown as ExactQuoteJumpResult;

  it("adds which copy is highlighted when the page holds the quote more than once", function () {
    assert.equal(
      buildParagraphJumpSuccessStatus("5", selected, 2),
      "Jumped to cited source (page 5, paragraph matched). This quote appears twice on the page; the first copy is highlighted.",
    );
    assert.equal(
      buildParagraphJumpSuccessStatus("5", selected, 3),
      "Jumped to cited source (page 5, paragraph matched). This quote appears 3 times on the page; the first copy is highlighted.",
    );
  });

  it("keeps the plain status otherwise", function () {
    assert.equal(
      buildParagraphJumpSuccessStatus("5", selected),
      "Jumped to cited source (page 5, paragraph matched)",
    );
  });

  it("adds no copy note when the jump selected no occurrence", function () {
    const pageOnly = {
      matched: true,
      navigationStatus: "page-only",
    } as unknown as ExactQuoteJumpResult;

    assert.equal(
      buildParagraphJumpSuccessStatus("5", pageOnly, 2),
      "Jumped to cited source (page 5, quote found; exact occurrence not selected)",
    );
  });
});

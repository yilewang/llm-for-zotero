import { assert } from "chai";
import {
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
      return {
        matched: options.jumpMatches ?? true,
        matchedPageIndex: options.jumpMatches === false ? undefined : 4,
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
      strategy: "verify-first",
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
          strategy: "verify-first",
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

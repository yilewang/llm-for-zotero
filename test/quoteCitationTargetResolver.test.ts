import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_QUOTE_TARGET_VERIFICATION_BUDGET,
  mergeQuoteTargetResolutions,
  resolveVerifiedQuoteTarget,
  type QuoteTargetCandidate,
  type QuoteTargetResolution,
  type QuoteTargetVerification,
} from "../src/modules/contextPanel/quoteCitationTargetResolver";

function candidate(
  contextItemId: number,
  options?: { authoritative?: boolean; labelRank?: number },
): QuoteTargetCandidate {
  return {
    contextItemId,
    authoritative: options?.authoritative ?? false,
    labelRank: options?.labelRank ?? 0,
  };
}

function resolved(pageIndex: number): QuoteTargetVerification {
  return { status: "resolved", pageIndex };
}

const NOT_FOUND: QuoteTargetVerification = {
  status: "not-found",
  reason: "The quote was not found in this PDF.",
};

const UNAVAILABLE: QuoteTargetVerification = {
  status: "unavailable",
  reason: "Could not read PDF text.",
};

function trackingVerifier(
  responses: Record<number, QuoteTargetVerification>,
  attempts: Array<{ contextItemId: number; quoteText: string }>,
): (
  candidate: QuoteTargetCandidate,
  quoteText: string,
) => Promise<QuoteTargetVerification> {
  return async (candidate, quoteText) => {
    attempts.push({ contextItemId: candidate.contextItemId, quoteText });
    return responses[candidate.contextItemId] || NOT_FOUND;
  };
}

describe("quote citation target resolver", function () {
  it("resolves the single candidate whose PDF actually contains the quote", async function () {
    const attempts: Array<{ contextItemId: number; quoteText: string }> = [];
    const resolution = await resolveVerifiedQuoteTarget({
      candidates: [candidate(11), candidate(22)],
      searchTexts: ["drift is orthogonal to context"],
      verify: trackingVerifier({ 22: resolved(4) }, attempts),
    });

    assert.equal(resolution.status, "resolved");
    if (resolution.status !== "resolved") return;
    assert.equal(resolution.contextItemId, 22);
    assert.equal(resolution.pageIndex, 4);
    assert.equal(resolution.quoteText, "drift is orthogonal to context");
    assert.deepEqual(
      attempts.map((attempt) => attempt.contextItemId),
      [11, 22],
    );
  });

  it("never resolves a candidate whose PDF does not contain the quote", async function () {
    const resolution = await resolveVerifiedQuoteTarget({
      candidates: [candidate(11, { labelRank: 5 }), candidate(22)],
      searchTexts: ["a quote nobody has"],
      verify: async () => NOT_FOUND,
    });

    assert.equal(resolution.status, "not-found");
    if (resolution.status !== "not-found") return;
    assert.include(resolution.reason, "not found");
  });

  it("stops reading PDFs as soon as one of them holds the quote", async function () {
    const attempts: Array<{ contextItemId: number; quoteText: string }> = [];
    const candidates = [
      candidate(11, { labelRank: 9 }),
      ...Array.from({ length: 30 }, (_entry, index) => candidate(100 + index)),
    ];
    const resolution = await resolveVerifiedQuoteTarget({
      candidates,
      searchTexts: ["verbatim sentence"],
      verify: trackingVerifier({ 11: resolved(2) }, attempts),
    });

    assert.equal(resolution.status, "resolved");
    if (resolution.status !== "resolved") return;
    assert.equal(resolution.contextItemId, 11);
    assert.equal(resolution.readCount, 1);
    assert.lengthOf(attempts, 1, "a hit must end the search immediately");
  });

  it("checks conversation-context papers before library-search papers", async function () {
    const attempts: Array<{ contextItemId: number; quoteText: string }> = [];
    const resolution = await resolveVerifiedQuoteTarget({
      candidates: [
        candidate(90, { authoritative: false, labelRank: 9 }),
        candidate(7, { authoritative: true, labelRank: 0 }),
      ],
      searchTexts: ["verbatim sentence"],
      verify: trackingVerifier({ 7: resolved(1), 90: resolved(2) }, attempts),
    });

    assert.equal(resolution.status, "resolved");
    if (resolution.status !== "resolved") return;
    assert.equal(resolution.contextItemId, 7);
    assert.isTrue(resolution.authoritative);
    // The library-search candidate must not even be read once an
    // authoritative context paper verifies.
    assert.deepEqual(
      attempts.map((attempt) => attempt.contextItemId),
      [7],
    );
  });

  it("falls back to library-search papers when no context paper contains the quote", async function () {
    const resolution = await resolveVerifiedQuoteTarget({
      candidates: [
        candidate(7, { authoritative: true }),
        candidate(90, { authoritative: false, labelRank: 3 }),
      ],
      searchTexts: ["verbatim sentence"],
      verify: async (candidate) =>
        candidate.contextItemId === 90 ? resolved(6) : NOT_FOUND,
    });

    assert.equal(resolution.status, "resolved");
    if (resolution.status !== "resolved") return;
    assert.equal(resolution.contextItemId, 90);
    assert.isFalse(resolution.authoritative);
  });

  it("prefers the better-labelled paper when several hold the quote", async function () {
    const attempts: Array<{ contextItemId: number; quoteText: string }> = [];
    const resolution = await resolveVerifiedQuoteTarget({
      candidates: [
        candidate(11, { authoritative: true, labelRank: 1 }),
        candidate(22, { authoritative: true, labelRank: 4 }),
      ],
      searchTexts: ["shared sentence"],
      verify: trackingVerifier({ 11: resolved(2), 22: resolved(5) }, attempts),
    });

    assert.equal(resolution.status, "resolved");
    if (resolution.status !== "resolved") return;
    // Best-first ordering makes the label winner the first one read, so the
    // right answer costs one read rather than a full scan.
    assert.equal(resolution.contextItemId, 22);
    assert.lengthOf(attempts, 1);
  });

  it("jumps to a near-duplicate rather than refusing when labels tie", async function () {
    // A preprint and its published version both hold the quote; sending the
    // reader to the first is far better than declining to move at all.
    const resolution = await resolveVerifiedQuoteTarget({
      candidates: [
        candidate(11, { authoritative: true, labelRank: 2 }),
        candidate(22, { authoritative: true, labelRank: 2 }),
      ],
      searchTexts: ["shared sentence"],
      verify: async () => resolved(2),
    });

    assert.equal(resolution.status, "resolved");
    if (resolution.status !== "resolved") return;
    assert.equal(resolution.contextItemId, 11);
  });

  it("reports unverifiable rather than not-found when PDF text cannot be read", async function () {
    const resolution = await resolveVerifiedQuoteTarget({
      candidates: [candidate(11, { authoritative: true }), candidate(22)],
      searchTexts: ["some sentence"],
      verify: async (candidate) =>
        candidate.contextItemId === 11 ? UNAVAILABLE : NOT_FOUND,
    });

    assert.equal(resolution.status, "unverifiable");
    if (resolution.status !== "unverifiable") return;
    assert.deepEqual(resolution.contextItemIds, [11]);
  });

  it("tries every search text for a candidate and keeps the first that lands", async function () {
    const attempts: Array<{ contextItemId: number; quoteText: string }> = [];
    const resolution = await resolveVerifiedQuoteTarget({
      candidates: [candidate(11)],
      searchTexts: ["short span", "the full paragraph span"],
      verify: async (candidate, quoteText) => {
        attempts.push({ contextItemId: candidate.contextItemId, quoteText });
        return quoteText === "the full paragraph span"
          ? resolved(3)
          : NOT_FOUND;
      },
    });

    assert.equal(resolution.status, "resolved");
    if (resolution.status !== "resolved") return;
    assert.equal(resolution.quoteText, "the full paragraph span");
    assert.lengthOf(attempts, 2);
  });

  it("stops reading PDFs once the verification budget is spent", async function () {
    const attempts: Array<{ contextItemId: number; quoteText: string }> = [];
    const candidates = Array.from({ length: 40 }, (_entry, index) =>
      candidate(100 + index),
    );
    const resolution = await resolveVerifiedQuoteTarget({
      candidates,
      searchTexts: ["missing sentence"],
      verify: trackingVerifier({}, attempts),
      verificationBudget: 5,
    });

    assert.equal(resolution.status, "not-found");
    assert.lengthOf(attempts, 5);
  });

  it("defaults to a bounded verification budget", async function () {
    const attempts: Array<{ contextItemId: number; quoteText: string }> = [];
    const candidates = Array.from({ length: 80 }, (_entry, index) =>
      candidate(200 + index),
    );
    await resolveVerifiedQuoteTarget({
      candidates,
      searchTexts: ["missing sentence"],
      verify: trackingVerifier({}, attempts),
    });

    assert.lengthOf(attempts, DEFAULT_QUOTE_TARGET_VERIFICATION_BUDGET);
  });

  it("reads each attachment at most once", async function () {
    const attempts: Array<{ contextItemId: number; quoteText: string }> = [];
    const resolution = await resolveVerifiedQuoteTarget({
      candidates: [
        candidate(11, { authoritative: true }),
        candidate(11, { authoritative: false, labelRank: 9 }),
      ],
      searchTexts: ["only sentence"],
      verify: trackingVerifier({ 11: resolved(0) }, attempts),
    });

    assert.equal(resolution.status, "resolved");
    assert.lengthOf(attempts, 1);
  });

  it("ignores candidates without a usable attachment id", async function () {
    const resolution = await resolveVerifiedQuoteTarget({
      candidates: [candidate(0), candidate(-4), candidate(Number.NaN)],
      searchTexts: ["only sentence"],
      verify: async () => resolved(1),
    });

    assert.equal(resolution.status, "not-found");
  });

  it("does not jump when the locator resolves without a page", async function () {
    const resolution = await resolveVerifiedQuoteTarget({
      candidates: [candidate(11)],
      searchTexts: ["only sentence"],
      verify: async () => ({ status: "resolved", pageIndex: null }),
    });

    assert.notEqual(resolution.status, "resolved");
  });

  it("survives a verifier that throws", async function () {
    const resolution = await resolveVerifiedQuoteTarget({
      candidates: [candidate(11), candidate(22)],
      searchTexts: ["only sentence"],
      verify: async (candidate) => {
        if (candidate.contextItemId === 11)
          throw new Error("pdf worker exploded");
        return resolved(2);
      },
    });

    assert.equal(resolution.status, "resolved");
    if (resolution.status !== "resolved") return;
    assert.equal(resolution.contextItemId, 22);
  });
  it("explains a failure in terms of the most likely paper, not the last one checked", async function () {
    const resolution = await resolveVerifiedQuoteTarget({
      candidates: [
        candidate(11, { authoritative: true, labelRank: 9 }),
        candidate(22, { labelRank: 1 }),
      ],
      searchTexts: ["missing sentence"],
      verify: async (c) => ({
        status: "not-found",
        reason:
          c.contextItemId === 11
            ? "Only part of the cited quote appears in this paper."
            : "The complete quote was not found in the live PDF text.",
      }),
    });

    assert.equal(resolution.status, "not-found");
    if (resolution.status !== "not-found") return;
    assert.include(resolution.reason, "Only part of the cited quote");
  });

  describe("mergeQuoteTargetResolutions", function () {
    const UNVERIFIABLE_RECORDED: QuoteTargetResolution = {
      status: "unverifiable",
      contextItemIds: [11],
      reason: "Could not read the cited paper's PDF text.",
      readCount: 1,
    };
    const NOT_FOUND_SEARCHED: QuoteTargetResolution = {
      status: "not-found",
      reason: "The complete quote was not found in the live PDF text.",
      readCount: 2,
    };

    it("keeps a scanned recorded PDF eligible for the viewer fallback", function () {
      // The recorded paper's text could not be extracted, so opening it in the
      // reader is the one remaining way to find the quote.  A later search that
      // merely fails on other papers must not retire that option.
      const merged = mergeQuoteTargetResolutions({
        recorded: UNVERIFIABLE_RECORDED,
        searched: NOT_FOUND_SEARCHED,
      });

      assert.equal(merged.status, "unverifiable");
      if (merged.status !== "unverifiable") return;
      assert.deepEqual(merged.contextItemIds, [11]);
    });

    it("offers the recorded paper before the searched ones", function () {
      const merged = mergeQuoteTargetResolutions({
        recorded: UNVERIFIABLE_RECORDED,
        searched: {
          status: "unverifiable",
          contextItemIds: [22, 11],
          reason: "Could not read PDF text.",
          readCount: 2,
        },
      });

      assert.equal(merged.status, "unverifiable");
      if (merged.status !== "unverifiable") return;
      assert.deepEqual(
        merged.contextItemIds,
        [11, 22],
        "the paper the answer named is opened first, and never twice",
      );
    });

    it("keeps the recorded paper's hit ahead of a searched one", function () {
      // Both passes found the quote. The paper the answer actually used wins,
      // or a same-label lookalike could take a click away from it.
      const merged = mergeQuoteTargetResolutions({
        recorded: {
          status: "resolved",
          contextItemId: 11,
          pageIndex: 2,
          quoteText: "drift is orthogonal to context",
          authoritative: true,
          readCount: 1,
        },
        searched: {
          status: "resolved",
          contextItemId: 22,
          pageIndex: 3,
          quoteText: "drift is orthogonal to context",
          authoritative: false,
          readCount: 1,
        },
      });

      assert.equal(merged.status, "resolved");
      if (merged.status !== "resolved") return;
      assert.equal(merged.contextItemId, 11);
    });

    it("lets a search that actually found the quote win", function () {
      const merged = mergeQuoteTargetResolutions({
        recorded: UNVERIFIABLE_RECORDED,
        searched: {
          status: "resolved",
          contextItemId: 22,
          pageIndex: 3,
          quoteText: "drift is orthogonal to context",
          authoritative: false,
          readCount: 3,
        },
      });

      assert.equal(merged.status, "resolved");
      if (merged.status !== "resolved") return;
      assert.equal(merged.contextItemId, 22);
      assert.equal(
        merged.readCount,
        4,
        "the click read the recorded PDF too, and the metric exists to say so",
      );
    });

    it("reports both reads when neither side found the quote", function () {
      const merged = mergeQuoteTargetResolutions({
        recorded: {
          status: "not-found",
          reason: "Only part of the cited quote appears in this paper.",
          readCount: 1,
        },
        searched: NOT_FOUND_SEARCHED,
      });

      assert.equal(merged.status, "not-found");
      if (merged.status !== "not-found") return;
      assert.equal(merged.readCount, 3, "both passes read PDFs");
      assert.include(
        merged.reason,
        "Only part of the cited quote",
        "the recorded paper is the one the user asked about",
      );
    });
  });
});

describe("untrusted quote navigation contract", function () {
  const source = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../src/modules/contextPanel/assistantCitationLinks.ts",
    ),
    "utf8",
  );
  const navigateSection = source.slice(
    source.indexOf("type ResolvedQuoteCitationMatch = {"),
    source.indexOf(
      "async function resolveAndNavigateAssistantCitation(params: {",
    ),
  );

  it("never invents a page label for the reader to navigate by", function () {
    // Zotero navigates by printed label when one is given, and printed labels
    // need not track page order.
    assert.notInclude(navigateSection, "pageLabel: `${resolution.pageIndex");
    assert.include(navigateSection, "pageLabel?: string;");
  });

  it("bounds how many papers a single click may open", function () {
    assert.include(navigateSection, "MAX_OPENED_QUOTE_VERIFICATION_CANDIDATES");
    assert.include(
      source,
      "const MAX_OPENED_QUOTE_VERIFICATION_CANDIDATES = 3",
    );
  });
  it("re-verifies through the merge so a fallback cannot bury the first verdict", function () {
    const start = navigateSection.indexOf("const searched = (await");
    assert.isAbove(start, -1, "the fallback search still runs");
    const mergeSection = navigateSection.slice(start);
    assert.include(
      mergeSection,
      "mergeQuoteTargetResolutions({",
      "the fallback verdict must be merged with the first, not assigned over it",
    );
    // Swapping the two sides is silent — same type, and the only symptom is
    // that the recorded paper stops being offered to the viewer first.
    assert.include(mergeSection, "recorded: resolution");
    assert.include(mergeSection, "searched: await verifyCandidates(");
  });

  it("refuses a library-search paper that only holds part of the quote", function () {
    const start = source.indexOf(
      "async function verifyQuoteInCitationCandidate(",
    );
    const end = source.indexOf(
      "async function locateQuoteByOpeningCitationCandidates(",
      start,
    );
    const verifySection = source.slice(start, end);

    // A short shared phrase must not be enough to send the reader to a paper
    // the conversation never used — but the test is how much of the quote the
    // document accounts for in total, not how long its single best span is.
    assert.include(verifySection, "!candidate.authoritative");
    assert.include(
      verifySection,
      "!locatedResultIdentifiesQuoteSource(result)",
    );
    assert.notInclude(verifySection, "sourceMatchQuoteTokenCoverage < 1");
    assert.include(verifySection, 'status: "not-found"');
  });
});

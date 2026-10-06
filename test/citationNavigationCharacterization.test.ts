/**
 * Characterization of citation navigation as it behaves today (step 8, S0).
 *
 * These tests pin current behaviour, not intended behaviour: where a pin looks
 * wrong it says so in a comment, and the refactor that follows must keep it
 * until a separate, deliberate fix changes it. Every path is driven through
 * the real button, locator, caches and paragraph jump; only Zotero and the
 * PDF.js reader are fakes (see helpers/citationNavigationRig.ts).
 *
 * C1 — trusted quotes and inline citations
 *      (resolveAndNavigateAssistantCitation). Since U1, a trusted quote
 *      is verified before the reader moves, like an untrusted one.
 * C2 — the untrusted quote path (navigateUntrustedQuoteCitation).
 * C3 — what each path hands the paragraph jump, and in what query order.
 * C4 — a partial DOM page-text cache read by background verification
 *      (fixed by F18: such a cache is not proof that a quote is absent).
 *
 * "D<n>" refers to the per-path differences listed in the step 8 brief.
 */
import { assert } from "chai";
import { attemptCitationParagraphJumpForTests } from "../src/modules/contextPanel/quoteNavigator";
import {
  lookupCachedCitationPage,
  navigateToTaskPaperPassage,
  rememberCachedCitationPage,
  resolveQuoteCitationCandidatesForTests,
  extractStandalonePaperSourceLabel,
} from "../src/modules/contextPanel/assistantCitationLinks";
import {
  clearPageTextCache,
  hasCompleteSearchablePageTextForAttachment,
  verifyQuoteLocationForAttachment,
  warmPageTextCache,
} from "../src/services/pdf/livePdfSelectionLocator";
import type { QuoteCitation } from "../src/modules/contextPanel/types";
import {
  installCitationNavigationRig,
  type CitationNavigationRig,
  type RigPaper,
} from "./helpers/citationNavigationRig";
import { createExactFindControllerReader } from "./helpers/findControllerReader";

const REVALIDATION_EVENT = "llm-quote-provenance-revalidation-request";

const QUOTE_A =
  "Place cell ensembles gradually reorganized their firing fields across consecutive recording sessions while the animals ran the same linear track";
const QUOTE_A_TAIL = "Other cells in the same field of view stayed stable";
const QUOTE_A_PARAGRAPH = `${QUOTE_A}. ${QUOTE_A_TAIL}`;
const QUOTE_MISSING =
  "Grid cell modules realigned to the new enclosure geometry within minutes of the first exposure session";
const QUOTE_B =
  "Dopamine release in the ventral striatum tracked the reward prediction error on every trial of the reversal task";
/** The first two thirds of QUOTE_B, then different wording. */
const QUOTE_B_PREFIX_PAGE =
  "Results. Dopamine release in the ventral striatum tracked the reward prediction error on most trials, but not during reversal.";

function smith(patch: Partial<RigPaper> = {}): RigPaper {
  return {
    itemId: 10,
    attachmentId: 11,
    title: "Drifting place codes",
    firstCreator: "Smith",
    year: "2020",
    pageLabels: ["101", "102", "103"],
    pages: [
      "Introduction. Neural populations in the hippocampus encode spatial context over many days.",
      `Results. ${QUOTE_A_PARAGRAPH}. ${QUOTE_B_PREFIX_PAGE}`,
      "Discussion. These findings constrain models of memory consolidation.",
    ],
    ...patch,
  };
}

function libraryPaper(
  index: number,
  pages: string[],
  patch: Partial<RigPaper> = {},
): RigPaper {
  return {
    itemId: 100 + index * 2,
    attachmentId: 101 + index * 2,
    title: `Paper ${String.fromCharCode(65 + index)}`,
    firstCreator: "Smith",
    year: "2020",
    pages,
    ...patch,
  };
}

function quoteCitation(patch: Partial<QuoteCitation> = {}): QuoteCitation {
  return {
    id: "q1",
    quoteText: QUOTE_A,
    citationLabel: "Smith, 2020",
    contextItemId: 11,
    itemId: 10,
    ...patch,
  };
}

/**
 * The `failureStage` of every paragraph jump the navigator logged as failed.
 *
 * This reads the navigator's own diagnostics: the "LLM citation paragraph jump
 * failed" warning and its `failureStage` field, written by
 * `logParagraphJumpFailure` (assistantCitationLinks.ts). That log line is a
 * deliberately pinned surface. A refactor that moves or reshapes the logging
 * must keep that message and field, or update this helper in the same change.
 */
function failedJumpStages(rig: CitationNavigationRig): string[] {
  return rig.logs
    .filter((message) => message.includes("LLM citation paragraph jump failed"))
    .map((message) => /"failureStage":"([^"]+)"/.exec(message)?.[1] || "?");
}

function statusTexts(rig: CitationNavigationRig): string[] {
  return rig.statusHistory.map((entry) => `${entry.variant}: ${entry.text}`);
}

describe("citation navigation characterization", function () {
  this.timeout(20000);
  let rig: CitationNavigationRig | null = null;

  afterEach(function () {
    rig?.restore();
    rig = null;
  });

  function install(
    options: Parameters<typeof installCitationNavigationRig>[0],
  ): CitationNavigationRig {
    rig = installCitationNavigationRig(options);
    return rig;
  }

  describe("C1 trusted quotes verify before the reader moves (U1)", function () {
    // U1 (user decision): a trusted quote is read in the background before
    // any reader opens or moves, like an untrusted one. Verified page caches,
    // the hidden location cache, stored page hints and the citation's own page
    // label no longer open a page first. Tests marked "U1 (was: ...)" pinned
    // the old hint ladder (tiers T1-T6) and now pin the verified behaviour.
    function trustedButton(
      target: CitationNavigationRig,
      paper: RigPaper,
      patch: {
        quoteText?: string;
        quoteCitation?: QuoteCitation;
        paragraphQuoteText?: string;
        citationLabel?: string;
      } = {},
    ) {
      return target.makeButton({
        citationLabel: patch.citationLabel || "(Smith, 2020)",
        quoteText: patch.quoteText ?? QUOTE_A,
        candidates: target.messageCandidates([paper]),
        quoteCitation: patch.quoteCitation,
        paragraphQuoteText: patch.paragraphQuoteText,
        navigationMode: "trusted-quote",
      });
    }

    it("T1: a verified page cache no longer opens its page before the quote is read", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      rememberCachedCitationPage(11, QUOTE_A, 1, "102");
      const button = trustedButton(r, paper);

      await r.click(button);

      // U1 (was: opened at the cached { pageIndex: 1, pageLabel: "102" }
      // with no PDF text read, and no "Locating" status).
      assert.deepEqual(r.timeline, ["read 11", "open 11", "navigate 11"]);
      assert.deepEqual(r.opened, [{ itemId: 11, location: { pageIndex: 1 } }]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 102, paragraph matched)",
      ]);
      assert.deepEqual(r.events, [REVALIDATION_EVENT]);
      assert.equal(r.labelOf(button), "Smith, 2020, page 102");
      assert.equal(r.focusCount, 1, "one focus per paragraph jump (D15)");
      assert.isFalse(button.disabled);
      assert.equal(button.dataset.loading, "false");
    });

    it("T1: a stale verified page cache cannot move the reader; the verified page opens", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      // A stale verified page: the quote is on page index 1, not 0.
      rememberCachedCitationPage(11, QUOTE_A, 0, "101");
      const button = trustedButton(r, paper);

      await r.click(button);

      // U1 (was: T1 opened the stale page 0, its jump failed with
      // "full-quote-not-on-page", and T2 then moved the reader to page 1).
      assert.deepEqual(failedJumpStages(r), []);
      assert.deepEqual(r.opened, [{ itemId: 11, location: { pageIndex: 1 } }]);
      assert.deepEqual(r.reader(11)!.navigations, [{ pageIndex: 1 }]);
      assert.deepEqual(r.timeline, ["read 11", "open 11", "navigate 11"]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 102, paragraph matched)",
      ]);
      // The corrected page replaces the stale cache entry (D6).
      assert.equal(lookupCachedCitationPage(11, QUOTE_A), "102");
    });

    it("a verified page cache puts its paper first, and that paper is still read before it opens", async function () {
      const first = smith();
      const second = smith({
        itemId: 20,
        attachmentId: 21,
        title: "Drifting place codes II",
        fingerprint: "fp-21",
      });
      const r = install({ papers: [first, second] });
      // A previous click jumped to the quote in the second paper.
      rememberCachedCitationPage(21, QUOTE_A, 1, "102");
      const button = r.makeButton({
        citationLabel: "(Smith, 2020)",
        quoteText: QUOTE_A,
        candidates: r.messageCandidates([first, second]),
        navigationMode: "trusted-quote",
      });

      await r.click(button);

      assert.deepEqual(r.timeline, ["read 21", "open 21", "navigate 21"]);
      assert.equal(r.status?.variant, "ready");
    });

    it("opens the background-verified page by index and ignores a stored page hint", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, {
        // A wrong page hint: the quote is on page index 1.
        quoteCitation: quoteCitation({
          pageHintIndex: 2,
          pageHintLabel: "103",
        }),
      });

      await r.click(button);

      // U1 (was: the hidden cache answered first, so the same page opened
      // without a "Locating" status).
      assert.deepEqual(r.opened, [{ itemId: 11, location: { pageIndex: 1 } }]);
      assert.deepEqual(r.pdfWorkerReads, [11]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 102, paragraph matched)",
      ]);
      assert.deepEqual(failedJumpStages(r), []);
    });

    it("T3: a stored page hint opens nothing; an unreadable PDF opens in the viewer and moves once the quote is found", async function () {
      const paper = smith({ backgroundText: false });
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, {
        quoteCitation: quoteCitation({
          pageHintIndex: 1,
          pageHintLabel: "102",
        }),
        citationLabel: "(Smith, 2020, page 103)",
      });

      await r.click(button);

      // U1 (was: opened at the hint { pageIndex: 1, pageLabel: "102" } with
      // "Opening cited page hint..." and "Verifying cited quote...").
      assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
      assert.deepEqual(r.reader(11)!.navigations, [
        { pageIndex: 1, pageLabel: "102" },
      ]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 102, paragraph matched)",
      ]);
    });

    it("T3: a wrong stored page hint moves nothing before the quote is found", async function () {
      const paper = smith({ backgroundText: false });
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, {
        quoteCitation: quoteCitation({
          pageHintIndex: 2,
          pageHintLabel: "103",
        }),
      });

      await r.click(button);

      // U1 (was: opened at the wrong hint, failed "full-quote-not-on-page"
      // there, then T6 searched; two focus calls).
      assert.deepEqual(failedJumpStages(r), []);
      assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
      assert.deepEqual(r.reader(11)!.navigations, [
        { pageIndex: 1, pageLabel: "102" },
      ]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 102, paragraph matched)",
      ]);
      assert.equal(r.focusCount, 1, "only the verified jump focuses (D15)");
    });

    it("T4: an explicit page label opens nothing by itself", async function () {
      const paper = smith({ backgroundText: false });
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, {
        citationLabel: "(Smith, 2020, page 102)",
      });

      await r.click(button);

      // U1 (was: no "Locating" status and no navigation; FindController
      // alone scrolled the reader the label tier opened). The viewer
      // fallback now finds the page and moves the reader there.
      assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
      assert.deepEqual(r.reader(11)!.navigations, [
        { pageIndex: 1, pageLabel: "102" },
      ]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 102, paragraph matched)",
      ]);
    });

    it("an absent quote opens nothing, whatever page hint or label it carries (D9)", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      rememberCachedCitationPage(11, QUOTE_MISSING, 2, "103");
      const button = trustedButton(r, paper, {
        quoteText: QUOTE_MISSING,
        quoteCitation: quoteCitation({
          quoteText: QUOTE_MISSING,
          pageHintIndex: 2,
          pageHintLabel: "103",
        }),
        citationLabel: "(Smith, 2020, page 103)",
      });

      await r.click(button);

      assert.deepEqual(r.timeline, ["read 11"]);
      assert.deepEqual(r.opened, []);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "error: The complete quote was not found in the live PDF text.",
      ]);
      assert.deepEqual(r.events, [REVALIDATION_EVENT]);
    });

    it("does not move an open reader to a page hint for a quote it does not hold", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      r.selectReader(11);
      const button = trustedButton(r, paper, {
        quoteText: QUOTE_MISSING,
        quoteCitation: quoteCitation({
          quoteText: QUOTE_MISSING,
          pageHintIndex: 2,
          pageHintLabel: "103",
        }),
      });

      await r.click(button);

      assert.deepEqual(r.opened, []);
      assert.deepEqual(r.reader(11)!.navigations, []);
      assert.deepEqual(r.findQueries(11), []);
      assert.equal(r.status?.variant, "error");
    });

    it("T5: with no candidates at all, the active reader is searched directly", async function () {
      const r = install({
        papers: [],
        // A reader whose item Zotero cannot resolve, so it yields no candidate.
        orphanReaders: [{ itemId: 77, pages: smith().pages }],
      });
      r.selectReader(77);
      const button = r.makeButton({
        citationLabel: "(Smith, 2020)",
        quoteText: QUOTE_A,
        navigationMode: "trusted-quote",
      });

      await r.click(button);

      assert.deepEqual(r.opened, [], "the active reader is used as is");
      // Its text is read, and the reader is never sent to a page; only the
      // jump scrolls it, after the quote was found.
      assert.deepEqual(r.timeline, ["read 77"]);
      assert.deepEqual(r.reader(77)!.navigations, []);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 2, paragraph matched)",
      ]);
      assert.equal(lookupCachedCitationPage(77, QUOTE_A), "2");
    });

    it("T5: the active reader must hold the complete quote; a partial span moves nothing", async function () {
      const r = install({
        papers: [],
        // Page index 1 holds only the first two thirds of QUOTE_B.
        orphanReaders: [{ itemId: 77, pages: smith().pages }],
      });
      r.selectReader(77);
      const button = r.makeButton({
        citationLabel: "(Smith, 2020)",
        quoteText: QUOTE_B,
        navigationMode: "trusted-quote",
      });

      await r.click(button);

      assert.deepEqual(r.findQueries(77), [], "no partial span is searched");
      assert.deepEqual(r.reader(77)!.navigations, []);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "error: The complete quote was not found in the live PDF text.",
      ]);
      assert.isNull(lookupCachedCitationPage(77, QUOTE_B));
    });

    describe("identical copies of the quote", function () {
      const samePage = (patch: Partial<RigPaper> = {}) =>
        smith({
          pages: [
            "Introduction. Neural populations in the hippocampus encode spatial context over many days.",
            `Results. ${QUOTE_A}. Replication. ${QUOTE_A}.`,
            "Discussion. These findings constrain models of memory consolidation.",
          ],
          findMatchCount: 2,
          ...patch,
        });
      const twoPages = (patch: Partial<RigPaper> = {}) =>
        smith({
          pages: [
            `Abstract. ${QUOTE_A}.`,
            "Methods. Unrelated text about the recording rig.",
            `Conclusion. ${QUOTE_A}.`,
          ],
          ...patch,
        });
      const agains = (target: CitationNavigationRig) =>
        target
          .reader(11)!
          .fixture.dispatched.filter((entry) => entry.type === "again").length;

      it("on one page, the recorded occurrence picks the copy after the page is verified", async function () {
        const paper = samePage();
        const r = install({ papers: [paper] });
        const button = trustedButton(r, paper, {
          quoteCitation: quoteCitation({
            pageHintIndex: 1,
            pageHintLabel: "102",
            sourceMatchPageOccurrence: 1,
          }),
        });

        await r.click(button);

        // Background text holds the quote twice on page index 1, so it is
        // "ambiguous" there; the answer's recorded occurrence settles it.
        assert.deepEqual(r.timeline, ["read 11", "open 11", "navigate 11"]);
        assert.deepEqual(r.opened, [
          { itemId: 11, location: { pageIndex: 1 } },
        ]);
        assert.equal(agains(r), 1, "the jump selects the second copy");
        assert.deepEqual(statusTexts(r), [
          "sending: Locating cited quote...",
          "ready: Jumped to cited source (page 102, paragraph matched)",
        ]);
      });

      it("on one page of an unreadable PDF, the viewer applies the same rule", async function () {
        const paper = samePage({ backgroundText: false });
        const r = install({ papers: [paper] });
        const button = trustedButton(r, paper, {
          quoteCitation: quoteCitation({ sourceMatchPageOccurrence: 1 }),
        });

        await r.click(button);

        assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
        assert.deepEqual(r.reader(11)!.navigations, [
          { pageIndex: 1, pageLabel: "102" },
        ]);
        assert.equal(agains(r), 1);
        assert.equal(r.status?.variant, "ready");
      });

      it("on one page, the stored page hint naming that page settles the tie and highlights the first copy", async function () {
        const paper = samePage();
        const r = install({ papers: [paper] });
        const button = trustedButton(r, paper, {
          quoteCitation: quoteCitation({ pageHintIndex: 1 }),
        });

        await r.click(button);

        // No recorded occurrence: the hinted page is verified and opened, and
        // the jump highlights the first copy (D4). The status says that the
        // page holds the quote twice.
        assert.deepEqual(r.timeline, ["read 11", "open 11", "navigate 11"]);
        assert.deepEqual(r.opened, [
          { itemId: 11, location: { pageIndex: 1 } },
        ]);
        assert.deepEqual(failedJumpStages(r), []);
        assert.equal(agains(r), 0, "the jump selects the first copy");
        assert.deepEqual(statusTexts(r), [
          "sending: Locating cited quote...",
          "ready: Jumped to cited source (page 102, paragraph matched). This quote appears twice on the page; the first copy is highlighted.",
        ]);
      });

      it("on one page holding three copies, the hint settles the tie and the status counts them", async function () {
        const paper = smith({
          pages: [
            "Introduction. Neural populations in the hippocampus encode spatial context over many days.",
            `Results. ${QUOTE_A}. Replication. ${QUOTE_A}. Second replication. ${QUOTE_A}.`,
            "Discussion. These findings constrain models of memory consolidation.",
          ],
          findMatchCount: 3,
        });
        const r = install({ papers: [paper] });
        const button = trustedButton(r, paper, {
          quoteCitation: quoteCitation({ pageHintIndex: 1 }),
        });

        await r.click(button);

        assert.deepEqual(failedJumpStages(r), []);
        assert.equal(agains(r), 0, "the jump selects the first copy");
        assert.deepEqual(statusTexts(r), [
          "sending: Locating cited quote...",
          "ready: Jumped to cited source (page 102, paragraph matched). This quote appears 3 times on the page; the first copy is highlighted.",
        ]);
      });

      it("on one page, a fuller passage that occurs once is highlighted without the first-copy note", async function () {
        const paper = samePage();
        const r = install({ papers: [paper] });
        const button = trustedButton(r, paper, {
          quoteCitation: quoteCitation({ pageHintIndex: 1 }),
          // Occurs once on the page, and holds the second copy.
          paragraphQuoteText: `Replication. ${QUOTE_A}`,
        });

        await r.click(button);

        assert.deepEqual(failedJumpStages(r), []);
        assert.deepEqual(statusTexts(r), [
          "sending: Locating cited quote...",
          "ready: Jumped to cited source (page 102, paragraph matched)",
        ]);
      });

      it("on one page, with no page hint and no recorded occurrence, opens nothing", async function () {
        const paper = samePage();
        const r = install({ papers: [paper] });
        const button = trustedButton(r, paper, {
          quoteCitation: quoteCitation(),
        });

        await r.click(button);

        assert.deepEqual(r.opened, []);
        assert.deepEqual(statusTexts(r), [
          "sending: Locating cited quote...",
          "error: The complete quote matched more than one occurrence on the PDF page.",
        ]);
      });

      it("on one page, a stored page hint naming another page settles nothing", async function () {
        const paper = samePage();
        const r = install({ papers: [paper] });
        const button = trustedButton(r, paper, {
          // Page index 0 does not hold the quote.
          quoteCitation: quoteCitation({ pageHintIndex: 0 }),
        });

        await r.click(button);

        assert.deepEqual(r.opened, []);
        assert.equal(r.status?.variant, "error");
      });

      it("on one page of an unreadable PDF, the stored page hint naming that page settles the tie in the viewer", async function () {
        const paper = samePage({ backgroundText: false });
        const r = install({ papers: [paper] });
        const button = trustedButton(r, paper, {
          quoteCitation: quoteCitation({ pageHintIndex: 1 }),
        });

        await r.click(button);

        // The viewer verifies the page and the reader moves there; as above,
        // the jump highlights the first copy (D4).
        assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
        assert.deepEqual(r.reader(11)!.navigations, [
          { pageIndex: 1, pageLabel: "102" },
        ]);
        assert.deepEqual(failedJumpStages(r), []);
        assert.equal(agains(r), 0);
        assert.deepEqual(statusTexts(r), [
          "sending: Locating cited quote...",
          "ready: Jumped to cited source (page 102, paragraph matched). This quote appears twice on the page; the first copy is highlighted.",
        ]);
      });

      it("on two pages, the first copy wins", async function () {
        const paper = twoPages();
        const r = install({ papers: [paper] });
        const button = trustedButton(r, paper, {
          quoteCitation: quoteCitation(),
        });

        await r.click(button);

        assert.deepEqual(r.opened, [
          { itemId: 11, location: { pageIndex: 0 } },
        ]);
      });

      it("on two pages, the stored page hint picks the copy, and the reader opens there only after verification", async function () {
        const paper = twoPages();
        const r = install({ papers: [paper] });
        const button = trustedButton(r, paper, {
          quoteCitation: quoteCitation({
            pageHintIndex: 2,
            pageHintLabel: "103",
          }),
        });

        await r.click(button);

        assert.deepEqual(r.timeline, ["read 11", "open 11", "navigate 11"]);
        assert.deepEqual(r.opened, [
          { itemId: 11, location: { pageIndex: 2 } },
        ]);
      });

      it("on two pages of an unreadable PDF, the stored page hint picks the copy the viewer moves to", async function () {
        const paper = twoPages({ backgroundText: false });
        const r = install({ papers: [paper] });
        const button = trustedButton(r, paper, {
          quoteCitation: quoteCitation({
            pageHintIndex: 2,
            pageHintLabel: "103",
          }),
        });

        await r.click(button);

        assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
        assert.deepEqual(r.reader(11)!.navigations, [
          { pageIndex: 2, pageLabel: "103" },
        ]);
      });
    });

    it("T5: with no candidates and no reader, the click reports that no reader is open", async function () {
      const r = install({ papers: [] });
      const button = r.makeButton({
        citationLabel: "(Smith, 2020)",
        quoteText: QUOTE_A,
        navigationMode: "trusted-quote",
      });

      await r.click(button);

      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "error: No PDF reader is currently open.",
      ]);
      assert.deepEqual(r.events, [REVALIDATION_EVENT]);
    });

    it("T4: a wrong explicit page label moves nothing before the quote is found", async function () {
      const paper = smith({ backgroundText: false });
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, {
        citationLabel: "(Smith, 2020, page 103)",
      });

      await r.click(button);

      // U1 (was: a failed "full-quote-not-on-page" jump on page 103 first).
      assert.deepEqual(failedJumpStages(r), []);
      assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
      assert.deepEqual(r.reader(11)!.navigations, [
        { pageIndex: 1, pageLabel: "102" },
      ]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 102, paragraph matched)",
      ]);
    });

    it("passes over an unreadable candidate whose PDF is not the certificate's (D9)", async function () {
      const first = smith({ backgroundText: false });
      const second = smith({
        itemId: 20,
        attachmentId: 21,
        title: "Drifting place codes II",
        backgroundText: false,
        fingerprint: "fp-21",
      });
      const r = install({ papers: [first, second] });
      const button = r.makeButton({
        citationLabel: "(Smith, 2020)",
        quoteText: QUOTE_A,
        candidates: r.messageCandidates([first, second]),
        // Only the second paper's PDF carries this fingerprint.
        quoteCitation: quoteCitation({ sourceFingerprint: "pdfjs:fp-21" }),
        navigationMode: "trusted-quote",
      });

      await r.click(button);

      // U1 (was: the ladder's full search opened each candidate in turn).
      // Now the viewer fallback opens the first unreadable paper, finds the
      // quote there, and its jump proves it is another PDF; the second paper
      // is then read the same way and holds the cited PDF.
      assert.deepEqual(r.opened, [
        { itemId: 11, location: undefined },
        { itemId: 21, location: undefined },
      ]);
      assert.deepEqual(failedJumpStages(r), ["source-fingerprint-mismatch"]);
      assert.deepEqual(r.reader(21)!.navigations, [
        { pageIndex: 1, pageLabel: "102" },
      ]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 102, paragraph matched)",
      ]);
      assert.isNull(lookupCachedCitationPage(11, QUOTE_A));
      assert.equal(lookupCachedCitationPage(21, QUOTE_A), "102");
    });

    it("a verified page whose highlight fails ends the click there; a stored page hint adds no second try", async function () {
      // Background text finds the page, but the viewer cannot highlight it.
      const paper = smith({ viewerFinds: false });
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, {
        quoteCitation: quoteCitation({
          pageHintIndex: 1,
          pageHintLabel: "102",
        }),
      });

      await r.click(button);

      // U1 (was: the hint tier and the full search each jumped again, three
      // failed jumps in all, with "Opening cited page hint..." and
      // "Verifying cited quote..." on the way).
      assert.deepEqual(r.opened, [{ itemId: 11, location: { pageIndex: 1 } }]);
      assert.deepEqual(r.reader(11)!.navigations, [{ pageIndex: 1 }]);
      assert.deepEqual(failedJumpStages(r), ["full-match-not-found"]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "error: Jumped to page 102. Paragraph jump failed: FindController completed the full-PDF search and found no complete quote match.",
      ]);
      assert.isNull(lookupCachedCitationPage(11, QUOTE_A));
    });

    it("T3: a label-only page hint opens nothing; the verified page is opened by its label", async function () {
      const paper = smith({ backgroundText: false });
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, {
        quoteCitation: quoteCitation({ pageHintLabel: "102" }),
      });

      await r.click(button);

      // U1 (was: the same open and move, after "Opening cited page hint..."
      // and "Verifying cited quote..."; the move came from the hint).
      assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
      assert.deepEqual(r.reader(11)!.navigations, [
        { pageIndex: 1, pageLabel: "102" },
      ]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 102, paragraph matched)",
      ]);
    });

    it("T4: a page label the viewer cannot resolve changes nothing", async function () {
      const paper = smith({ backgroundText: false });
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, {
        citationLabel: "(Smith, 2020, page xx)",
      });

      await r.click(button);

      // U1 (was: no navigation; FindController alone scrolled the reader).
      assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
      assert.deepEqual(r.reader(11)!.navigations, [
        { pageIndex: 1, pageLabel: "102" },
      ]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 102, paragraph matched)",
      ]);
    });

    it("T4: an unreadable PDF without the quote is opened in the viewer, but never moved", async function () {
      const paper = smith({ backgroundText: false });
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, {
        quoteText: QUOTE_MISSING,
        citationLabel: "(Smith, 2020, page xx)",
      });

      await r.click(button);

      // U1: the bounded viewer fallback opens the unreadable PDF to read it
      // (D9), and the page label never moves it.
      assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
      assert.deepEqual(r.reader(11)!.navigations, []);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "error: The complete quote was not found in the live PDF text.",
      ]);
    });

    describe("page occurrence (D4)", function () {
      // Not pinned here: the T5 fallback to the located result's occurrence. This doubled viewer text makes the exact-only live locate report "ambiguous", so it never jumps here. The argument spy in citationNavigationJumpArguments.test.ts pins it.
      // The background worker reads the quote once on page index 1, but the
      // viewer's page text holds it twice and FindController reports two
      // matches. Only a recorded occurrence can pick between them.
      const twice = () =>
        smith({
          pages: [
            "Introduction. Neural populations in the hippocampus encode spatial context over many days.",
            `Results. ${QUOTE_A_PARAGRAPH}.`,
            "Discussion. These findings constrain models of memory consolidation.",
          ],
          viewerPages: [
            "Introduction. Neural populations in the hippocampus encode spatial context over many days.",
            `Results. ${QUOTE_A}. Replication. ${QUOTE_A}.`,
            "Discussion. These findings constrain models of memory consolidation.",
          ],
          findMatchCount: 2,
        });
      const agains = (target: CitationNavigationRig) =>
        target
          .reader(11)!
          .fixture.dispatched.filter((entry) => entry.type === "again").length;

      it("a verified page cache leaves the quote citation's occurrence to the jump", async function () {
        const paper = twice();
        const r = install({ papers: [paper] });
        rememberCachedCitationPage(11, QUOTE_A, 1, "102");
        const button = trustedButton(r, paper, {
          quoteCitation: quoteCitation({ sourceMatchPageOccurrence: 1 }),
        });

        await r.click(button);

        // U1 (was: opened at the cached page and label, no "Locating").
        assert.equal(agains(r), 1);
        assert.deepEqual(failedJumpStages(r), []);
        assert.deepEqual(r.opened, [
          { itemId: 11, location: { pageIndex: 1 } },
        ]);
        assert.deepEqual(statusTexts(r), [
          "sending: Locating cited quote...",
          "ready: Jumped to cited source (page 102, paragraph matched)",
        ]);
      });

      it("hands the jump the quote citation's occurrence over the verified one", async function () {
        const paper = twice();
        const r = install({ papers: [paper] });
        const button = trustedButton(r, paper, {
          quoteCitation: quoteCitation({ sourceMatchPageOccurrence: 1 }),
        });

        await r.click(button);

        assert.equal(agains(r), 1);
        assert.deepEqual(failedJumpStages(r), []);
        assert.deepEqual(r.opened, [
          { itemId: 11, location: { pageIndex: 1 } },
        ]);
        assert.deepEqual(statusTexts(r), [
          "sending: Locating cited quote...",
          "ready: Jumped to cited source (page 102, paragraph matched)",
        ]);
      });

      it("falls back to the verified occurrence when the quote citation has none", async function () {
        const paper = twice();
        const r = install({ papers: [paper] });
        const button = trustedButton(r, paper);

        await r.click(button);

        assert.equal(agains(r), 0);
        assert.deepEqual(failedJumpStages(r), []);
        assert.deepEqual(r.opened, [
          { itemId: 11, location: { pageIndex: 1 } },
        ]);
        assert.deepEqual(statusTexts(r), [
          "sending: Locating cited quote...",
          "ready: Jumped to cited source (page 102, paragraph matched)",
        ]);
      });
    });

    it("a real mousedown warms the PDF text and reaches the same page", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper);

      await r.mousedown(button);

      assert.deepEqual(r.opened, [{ itemId: 11, location: { pageIndex: 1 } }]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 102, paragraph matched)",
      ]);
      assert.deepEqual(failedJumpStages(r), []);
      assert.deepEqual(r.events, [REVALIDATION_EVENT]);
      assert.equal(r.labelOf(button), "Smith, 2020, page 102");
      assert.equal(button.dataset.loading, "false");
      assert.isFalse(button.disabled);
      assert.deepEqual(r.pdfWorkerReads, [11]);
    });

    it("waits for a reader that Reader.open does not return, and still jumps (D16)", async function () {
      const paper = smith({ backgroundText: false });
      const r = install({ papers: [paper] });
      // Zotero's open resolves without a reader; the tab shows up later.
      (globalThis as any).Zotero.Reader.open = async () => {
        setTimeout(() => r.selectReader(11), 100);
        return undefined;
      };
      const button = trustedButton(r, paper);

      await r.click(button);

      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 102, paragraph matched)",
      ]);
      // U1 (was: no navigation). The reader that turned up is moved to the
      // page the viewer found the quote on.
      assert.deepEqual(r.reader(11)!.navigations, [
        { pageIndex: 1, pageLabel: "102" },
      ]);
      assert.equal(r.focusCount, 1);
    });

    it("a partial span verified in the background is rescued by the jump (D14)", async function () {
      // Page index 1 holds only the first two thirds of QUOTE_B. Background
      // verification accepts that span for a conversation paper, and the
      // paragraph jump rescues it.
      const paper = smith();
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, { quoteText: QUOTE_B });

      await r.click(button);

      assert.deepEqual(r.opened, [{ itemId: 11, location: { pageIndex: 1 } }]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 102, paragraph matched)",
      ]);
    });

    it("without background text, the viewer accepts a conversation paper's partial span, as for untrusted quotes (D2)", async function () {
      const paper = smith({ backgroundText: false });
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, { quoteText: QUOTE_B });

      await r.click(button);

      // U1 (was: the exact-only full search refused the span: no search and
      // "The complete quote was not found in the live PDF text."). The
      // viewer fallback gates a partial span by acceptsOpenedQuoteMatch, which
      // lets a paper the conversation carries through.
      assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
      assert.deepEqual(r.findQueries(11), [
        "Dopamine release in the ventral striatum tracked the reward prediction error on",
      ]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 102, paragraph matched)",
      ]);
    });

    it("skips a conversation paper the citation label does not name", async function () {
      const jones = smith({ firstCreator: "Jones", year: "2011" });
      const r = install({ papers: [jones] });
      const button = trustedButton(r, jones);

      await r.click(button);

      // A candidate that is not auto-navigable is never read or opened, and
      // the active-reader last resort only runs when there are no candidates.
      assert.deepEqual(r.opened, []);
      assert.deepEqual(r.pdfWorkerReads, []);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "error: Could not resolve the cited quote to a unique page.",
      ]);
    });

    it("an unreadable PDF opens in the viewer without a location, and moves once the quote is found", async function () {
      const paper = smith({ backgroundText: false });
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper);

      await r.click(button);

      // U1 (was: the full search opened it and FindController alone moved
      // it). The move now comes after the viewer found the quote.
      assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
      const timeline = r.timeline;
      assert.equal(timeline[timeline.length - 1], "navigate 11");
      assert.isBelow(
        timeline.indexOf("open 11"),
        timeline.indexOf("navigate 11"),
      );
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 102, paragraph matched)",
      ]);
      assert.equal(lookupCachedCitationPage(11, QUOTE_A), "102");
    });

    it("reports the background verdict for a quote the paper does not hold, and opens nothing", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, { quoteText: QUOTE_MISSING });

      await r.click(button);

      // U1 (was: the full search opened the paper to search it).
      assert.deepEqual(r.opened, []);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "error: The complete quote was not found in the live PDF text.",
      ]);
      assert.deepEqual(r.events, [REVALIDATION_EVENT]);
      assert.deepEqual(r.findQueries(11), []);
    });

    it("reports a thrown reader open as a preserved citation (D9)", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      (globalThis as any).Zotero.Reader.open = async () => {
        throw new Error("reader exploded");
      };
      const button = trustedButton(r, paper);

      await r.click(button);

      // U1 (was: no "Locating" status before the error).
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "error: Could not open the cited source. The citation was preserved.",
      ]);
      assert.deepEqual(r.events, [REVALIDATION_EVENT]);
      assert.isFalse(button.disabled);
      assert.equal(button.dataset.loading, "false");
    });

    it("ignores a click while the button is already navigating (D17)", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper);
      button.dataset.loading = "true";

      await r.click(button);

      assert.deepEqual(r.opened, []);
      assert.deepEqual(r.statusHistory, []);
      assert.deepEqual(
        r.events,
        [],
        "no finally block runs for an ignored click",
      );
    });

    it("refreshes every citation button from the page cache after a click, even a failed one (D7)", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      const failing = trustedButton(r, paper, { quoteText: QUOTE_MISSING });
      const other = trustedButton(r, paper, {
        quoteText: QUOTE_B,
      });
      // Another quote of the same paper already has a verified page.
      rememberCachedCitationPage(11, QUOTE_B, 1, "102");
      assert.equal(r.labelOf(other), "Smith, 2020");

      await r.click(failing);

      assert.equal(r.status?.variant, "error");
      assert.equal(r.labelOf(other), "Smith, 2020, page 102");
      assert.equal(r.labelOf(failing), "Smith, 2020");
    });

    describe("verifiedFullSpan (D3)", function () {
      // Page index 1 holds only the first two thirds of QUOTE_B, so the
      // paragraph jump can succeed only through the largest-unique-partial
      // span, which verifiedFullSpan switches off. The PDF is unreadable in
      // the background, so the viewer verifies the span before the jump.
      async function clickWithCitation(patch: Partial<QuoteCitation>) {
        const paper = smith({ backgroundText: false });
        const r = install({ papers: [paper] });
        rememberCachedCitationPage(11, QUOTE_B, 1, "102");
        const button = trustedButton(r, paper, {
          quoteText: QUOTE_B,
          quoteCitation: quoteCitation({ quoteText: QUOTE_B, ...patch }),
        });
        await r.click(button);
        return r;
      }

      it("is on for an exact match grounded in a pdfjs: fingerprint", async function () {
        const r = await clickWithCitation({
          sourceMatchKind: "exact",
          sourceFingerprint: "pdfjs:fp-11",
        });
        assert.deepEqual(r.findQueries(11), [], "no partial span is tried");
        assert.include(failedJumpStages(r), "full-quote-not-on-page");
        assert.equal(r.status?.variant, "error");
        // U1: the jump still gets the certificate after verification, on the
        // page the viewer verified (was: the cached page, opened first).
        assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
        assert.deepEqual(r.reader(11)!.navigations, [
          { pageIndex: 1, pageLabel: "102" },
        ]);
      });

      it("is off for an exact match grounded in non-pdf.js text", async function () {
        const r = await clickWithCitation({
          sourceMatchKind: "exact",
          sourceFingerprint: "page-text:abc123",
        });
        assert.lengthOf(r.findQueries(11), 1);
        assert.include(QUOTE_B, r.findQueries(11)[0]);
        assert.notEqual(r.findQueries(11)[0], QUOTE_B);
        assert.deepEqual(statusTexts(r), [
          "sending: Locating cited quote...",
          "ready: Jumped to cited source (page 102, paragraph matched)",
        ]);
      });

      it("is off for a partial match even with a pdfjs: fingerprint", async function () {
        const r = await clickWithCitation({
          sourceMatchKind: "raw-prefix",
          sourceFingerprint: "pdfjs:fp-11",
        });
        assert.lengthOf(r.findQueries(11), 1);
        assert.deepEqual(statusTexts(r), [
          "sending: Locating cited quote...",
          "ready: Jumped to cited source (page 102, paragraph matched)",
        ]);
      });
    });

    it("hands the jump the quote citation's fingerprint, which can rule the paper out (D4)", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      rememberCachedCitationPage(11, QUOTE_A, 1, "102");
      const button = trustedButton(r, paper, {
        quoteCitation: quoteCitation({
          sourceFingerprint: "pdfjs:another-pdf",
        }),
      });

      await r.click(button);

      // U1 (was: three tiers each failed the same way). The one verified
      // paper is opened at its page, its jump fails on the fingerprint, and
      // no other paper is left to try.
      assert.deepEqual(failedJumpStages(r), ["source-fingerprint-mismatch"]);
      assert.deepEqual(r.opened, [{ itemId: 11, location: { pageIndex: 1 } }]);
      assert.deepEqual(r.findQueries(11), []);
      // D3 (was "Jumped to page 102. Paragraph jump failed: The cited source
      // fingerprint does not match the loaded PDF."): the status says the
      // reader stays on another copy of the paper.
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "error: Opened a different copy of this paper; the quote could not be confirmed here.",
      ]);
    });
  });

  describe("C1 inline citations and non-PDF sources", function () {
    it("an inline citation opens the first auto-navigable PDF without searching (E7, D11)", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      const button = r.makeButton({
        citationLabel: "(Smith, 2020)",
        quoteText: "",
        candidates: r.messageCandidates([paper]),
      });
      assert.equal(button.dataset.citationNavigationMode, "inline-citation");

      await r.click(button);

      assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
      assert.equal(r.focusCount, 1);
      assert.deepEqual(statusTexts(r), [
        "ready: Opened cited paper. Paragraph jump skipped: no quote text was available.",
      ]);
      assert.deepEqual(r.events, [], "no revalidation without quote text (D7)");
      assert.equal(r.libraryScans, 0, "a known paper needs no library search");
      assert.deepEqual(r.pdfWorkerReads, []);
    });

    it("an inline citation with nothing at hand finds its paper in the library (D10)", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      const button = r.makeButton({
        citationLabel: "(Smith, 2020)",
        quoteText: "",
      });

      await r.click(button);

      assert.equal(r.libraryScans, 1);
      assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
      assert.deepEqual(statusTexts(r), [
        "ready: Opened cited paper. Paragraph jump skipped: no quote text was available.",
      ]);
    });

    it("an inline citation with no matching paper reports no unique PDF", async function () {
      const r = install({ papers: [smith({ firstCreator: "Jones" })] });
      const button = r.makeButton({
        citationLabel: "(Smith, 2020)",
        quoteText: "",
      });

      await r.click(button);

      assert.deepEqual(r.opened, []);
      assert.deepEqual(statusTexts(r), [
        "error: Could not resolve citation to a unique PDF attachment.",
      ]);
    });

    it("a trusted quote whose paper is not a PDF reports that and opens nothing (D12)", async function () {
      const paper = smith({ contentType: "text/html" });
      const r = install({ papers: [paper] });
      const button = r.makeButton({
        citationLabel: "(Smith, 2020)",
        quoteText: QUOTE_A,
        candidates: r.messageCandidates([paper]),
        navigationMode: "trusted-quote",
      });

      await r.click(button);

      assert.deepEqual(r.opened, []);
      assert.deepEqual(statusTexts(r), [
        "error: The cited source is not a searchable PDF. The citation was preserved, but page navigation is unavailable.",
      ]);
      assert.deepEqual(r.events, [REVALIDATION_EVENT]);
    });

    it("an inline citation whose paper is not a PDF reports that and opens nothing (D12)", async function () {
      const paper = smith({ contentType: "text/html" });
      const r = install({ papers: [paper] });
      const button = r.makeButton({
        citationLabel: "(Smith, 2020)",
        quoteText: "",
        candidates: r.messageCandidates([paper]),
      });

      await r.click(button);

      assert.deepEqual(r.opened, []);
      assert.deepEqual(statusTexts(r), [
        "error: Cited source is not a PDF; page jump is unavailable.",
      ]);
    });
  });

  describe("C2 untrusted quote path", function () {
    function untrustedButton(
      target: CitationNavigationRig,
      patch: {
        quoteText?: string;
        agentRunId?: string;
        candidates?: ReturnType<CitationNavigationRig["messageCandidates"]>;
      } = {},
    ) {
      return target.makeButton({
        citationLabel: "(Smith, 2020)",
        quoteText: patch.quoteText ?? QUOTE_A,
        paragraphQuoteText: patch.quoteText ?? QUOTE_A,
        candidates: patch.candidates,
        navigationMode: "untrusted-quote",
        agentRunId: patch.agentRunId,
      });
    }

    function recordedPassage(paper: RigPaper, text: string) {
      return {
        type: "tool_result",
        callId: "call_1",
        name: "library_retrieve",
        ok: true,
        content: {
          snippets: [
            {
              itemId: String(paper.itemId),
              contextItemId: String(paper.attachmentId),
              snippet: text,
            },
          ],
        },
      };
    }

    it("asks the answer's recorded provenance before any library search", async function () {
      // Two same-label papers hold the quote; the label search would rank
      // "Paper A" first, but the run recorded the quote against "Paper B".
      const paperA = libraryPaper(0, [`Methods. ${QUOTE_A}.`]);
      const paperB = libraryPaper(1, ["Preface.", `Results. ${QUOTE_A}.`]);
      const r = install({
        papers: [paperA, paperB],
        runEvents: [recordedPassage(paperB, `Results. ${QUOTE_A}.`)],
      });
      const button = untrustedButton(r, { agentRunId: "run-1" });

      await r.click(button);

      assert.equal(r.libraryScans, 0, "no library search");
      assert.deepEqual(r.pdfWorkerReads, [paperB.attachmentId]);
      assert.deepEqual(r.opened, [
        { itemId: paperB.attachmentId, location: { pageIndex: 1 } },
      ]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 2, paragraph matched)",
      ]);
      assert.deepEqual(r.events, [REVALIDATION_EVENT]);
      assert.equal(lookupCachedCitationPage(paperB.attachmentId, QUOTE_A), "2");
    });

    it("searches the library when the recorded paper does not hold the quote", async function () {
      const paperA = libraryPaper(0, [`Methods. ${QUOTE_A}.`]);
      const paperB = libraryPaper(1, ["Preface.", "Nothing quoted here."]);
      const r = install({
        papers: [paperA, paperB],
        runEvents: [recordedPassage(paperB, `Results. ${QUOTE_A}.`)],
      });
      const button = untrustedButton(r, { agentRunId: "run-1" });

      await r.click(button);

      assert.equal(r.libraryScans, 1);
      assert.deepEqual(r.pdfWorkerReads, [
        paperB.attachmentId,
        paperA.attachmentId,
      ]);
      assert.deepEqual(r.opened, [
        { itemId: paperA.attachmentId, location: { pageIndex: 0 } },
      ]);
      assert.equal(r.status?.variant, "ready");
    });

    it("verifies every candidate in the background and opens only the winner (D1)", async function () {
      const decoy = libraryPaper(0, ["A paper about something else entirely."]);
      const source = libraryPaper(1, ["Preface.", `Results. ${QUOTE_A}.`]);
      const r = install({ papers: [decoy, source] });
      const button = untrustedButton(r);

      await r.click(button);

      assert.equal(r.libraryScans, 1, "untrusted quotes always search (D10)");
      assert.deepEqual(r.pdfWorkerReads, [
        decoy.attachmentId,
        source.attachmentId,
      ]);
      assert.deepEqual(r.opened, [
        { itemId: source.attachmentId, location: { pageIndex: 1 } },
      ]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 2, paragraph matched)",
      ]);
      assert.equal(r.labelOf(button), "Smith, 2020, page 2");
      assert.equal(r.focusCount, 1, "one focus per jump (D15)");
    });

    it("verifies and opens a same-year paper by another author that the label search proposes (D10)", async function () {
      // The library search scores a year-only agreement above zero, so a
      // paper "(Smith, 2020)" does not name is still read; it holds the
      // quote, so the click lands there.
      const r = install({ papers: [smith({ firstCreator: "Jones" })] });
      const button = untrustedButton(r);

      await r.click(button);

      assert.equal(r.libraryScans, 1);
      assert.deepEqual(r.opened, [{ itemId: 11, location: { pageIndex: 1 } }]);
      assert.equal(r.status?.variant, "ready");
    });

    it("reports a paper it cannot find without opening anything", async function () {
      const r = install({
        papers: [smith({ firstCreator: "Jones", year: "2011" })],
      });
      const button = untrustedButton(r);

      await r.click(button);

      assert.deepEqual(r.opened, []);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "error: Could not find the cited paper in your library.",
      ]);
      assert.deepEqual(r.events, [REVALIDATION_EVENT]);
    });

    it("never falls back to the active reader (D13)", async function () {
      const r = install({
        papers: [],
        orphanReaders: [{ itemId: 77, pages: smith().pages }],
      });
      r.selectReader(77);
      const button = untrustedButton(r);

      await r.click(button);

      assert.deepEqual(r.opened, []);
      assert.deepEqual(r.findQueries(77), []);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "error: Could not find the cited paper in your library.",
      ]);
    });

    it("reports a quote no candidate holds without opening anything", async function () {
      const decoy = libraryPaper(0, ["A paper about something else entirely."]);
      const r = install({ papers: [decoy] });
      const button = untrustedButton(r);

      await r.click(button);

      assert.deepEqual(r.opened, []);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "error: The complete quote was not found in the live PDF text.",
      ]);
      assert.equal(r.labelOf(button), "Smith, 2020");
      assert.isNull(lookupCachedCitationPage(decoy.attachmentId, QUOTE_A));
    });

    it("falls back to opening at most three unreadable PDFs in the viewer", async function () {
      const unreadable = [0, 1, 2, 3].map((index) =>
        libraryPaper(
          index,
          index === 3 ? [`Results. ${QUOTE_A}.`] : ["Unrelated scanned text."],
          { backgroundText: false },
        ),
      );
      const r = install({ papers: unreadable });
      const button = untrustedButton(r);

      await r.click(button);

      // The fourth paper holds the quote but is never opened.
      assert.deepEqual(
        r.opened.map((entry) => entry.itemId),
        unreadable.slice(0, 3).map((paper) => paper.attachmentId),
      );
      assert.deepEqual(
        r.opened.map((entry) => entry.location),
        [undefined, undefined, undefined],
      );
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "error: The complete quote was not found in the live PDF text.",
      ]);
    });

    it("jumps to the first unreadable PDF the viewer finds the quote in", async function () {
      const unreadable = [0, 1].map((index) =>
        libraryPaper(
          index,
          index === 1
            ? ["Preface.", `Results. ${QUOTE_A}.`]
            : ["Unrelated scanned text."],
          { backgroundText: false },
        ),
      );
      const r = install({ papers: unreadable });
      const button = untrustedButton(r);

      await r.click(button);

      assert.deepEqual(r.opened, [
        { itemId: unreadable[0].attachmentId, location: undefined },
        { itemId: unreadable[1].attachmentId, location: undefined },
      ]);
      // The winner is already the active reader, so it is moved, not reopened.
      // FIXED (D5; was { pageIndex: 1, pageLabel: "2" }): a PDF with no
      // printed labels navigates by page index only, with no label guessed
      // from the index. The status line still names page 2 for display.
      assert.deepEqual(r.reader(unreadable[1].attachmentId)!.navigations, [
        { pageIndex: 1 },
      ]);
      assert.equal(
        r.status?.text,
        "Jumped to cited source (page 2, paragraph matched)",
      );
      assert.equal(
        lookupCachedCitationPage(unreadable[1].attachmentId, QUOTE_A),
        "2",
      );
    });

    it("reports a verified quote whose highlight fails without remembering a page (D6, D9)", async function () {
      const source = libraryPaper(0, ["Preface.", `Results. ${QUOTE_A}.`], {
        viewerFinds: false,
      });
      const r = install({ papers: [source] });
      const button = untrustedButton(r);

      await r.click(button);

      assert.deepEqual(r.opened, [{ itemId: 101, location: { pageIndex: 1 } }]);
      assert.deepEqual(failedJumpStages(r), ["full-match-not-found"]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "error: Jumped to page 2. Paragraph jump failed: FindController completed the full-PDF search and found no complete quote match.",
      ]);
      assert.isNull(lookupCachedCitationPage(source.attachmentId, QUOTE_A));
      assert.equal(r.labelOf(button), "Smith, 2020");
    });

    it("reports a winner whose reader will not open (D9)", async function () {
      const source = libraryPaper(0, ["Preface.", `Results. ${QUOTE_A}.`]);
      const r = install({ papers: [source] });
      // Verification reads background text only, so the first reader open is
      // the winner's. It resolves without a reader.
      (globalThis as any).Zotero.Reader.open = async () => undefined;
      const button = untrustedButton(r);

      const startedAt = Date.now();
      await r.click(button);
      assert.isAtLeast(
        Date.now() - startedAt,
        1500,
        "the click waits about 1600 ms for a reader that never appears (D16)",
      );

      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "error: Could not open the cited paper. The citation was preserved.",
      ]);
      assert.isNull(lookupCachedCitationPage(source.attachmentId, QUOTE_A));
      assert.equal(r.labelOf(button), "Smith, 2020");
    });

    it("keeps an unreadable recorded paper for the viewer when the label search finds nothing", async function () {
      // The recorded paper cannot be read in the background, so the first
      // verdict is "unverifiable"; the label search then reads the other paper
      // and finds no quote. The merged verdict still sends the recorded paper
      // to the viewer fallback.
      const paperA = libraryPaper(0, [`Methods. Nothing quoted here.`]);
      const paperB = libraryPaper(1, ["Preface.", `Results. ${QUOTE_A}.`], {
        backgroundText: false,
      });
      const r = install({
        papers: [paperA, paperB],
        runEvents: [recordedPassage(paperB, `Results. ${QUOTE_A}.`)],
      });
      const button = untrustedButton(r, { agentRunId: "run-1" });

      await r.click(button);

      assert.equal(r.libraryScans, 1);
      assert.deepEqual(r.pdfWorkerReads, [
        paperB.attachmentId,
        paperA.attachmentId,
        // PINNED: the viewer fallback reads the recorded paper's text again. Its background read returned no text, which is not cached, so warming the opened reader asks PDFWorker once more (warmPageTextCache, strategy 0).
        paperB.attachmentId,
      ]);
      assert.deepEqual(r.opened, [
        { itemId: paperB.attachmentId, location: undefined },
      ]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 2, paragraph matched)",
      ]);
    });

    describe("partial-coverage decoys", function () {
      // The decoy shares the first two thirds of QUOTE_B and nothing else.
      const decoyPages = [QUOTE_B_PREFIX_PAGE];

      it("background verification refuses a library-search decoy (D2)", async function () {
        const decoy = libraryPaper(0, decoyPages);
        const r = install({ papers: [decoy] });
        const button = untrustedButton(r, { quoteText: QUOTE_B });

        await r.click(button);

        assert.deepEqual(r.opened, []);
        assert.deepEqual(statusTexts(r), [
          "sending: Locating cited quote...",
          "error: Only part of the cited quote appears in this paper.",
        ]);
      });

      it("background verification accepts the same partial match in a conversation paper (D2)", async function () {
        const paper = libraryPaper(0, decoyPages);
        const r = install({ papers: [paper] });
        const button = untrustedButton(r, {
          quoteText: QUOTE_B,
          candidates: r.messageCandidates([paper]),
        });

        await r.click(button);

        assert.deepEqual(r.opened, [
          { itemId: paper.attachmentId, location: { pageIndex: 0 } },
        ]);
        assert.equal(r.status?.variant, "ready");
        // The jump is handed the verified partial wording, so it highlights
        // that span without first trying the whole quote.
        assert.deepEqual(r.findQueries(paper.attachmentId), [
          "Dopamine release in the ventral striatum tracked the reward prediction error on",
        ]);
      });

      it("the viewer fallback refuses an unreadable library-search decoy (acceptsOpenedQuoteMatch)", async function () {
        const decoy = libraryPaper(0, decoyPages, { backgroundText: false });
        const r = install({ papers: [decoy] });
        const button = untrustedButton(r, { quoteText: QUOTE_B });

        await r.click(button);

        // Opened to read its text, but never moved to a page or searched.
        assert.deepEqual(r.opened, [
          { itemId: decoy.attachmentId, location: undefined },
        ]);
        assert.deepEqual(r.reader(decoy.attachmentId)!.navigations, []);
        assert.deepEqual(r.findQueries(decoy.attachmentId), []);
        assert.equal(r.status?.variant, "error");
      });

      it("the viewer fallback accepts the same partial match in an unreadable conversation paper", async function () {
        const paper = libraryPaper(0, decoyPages, { backgroundText: false });
        const r = install({ papers: [paper] });
        const button = untrustedButton(r, {
          quoteText: QUOTE_B,
          candidates: r.messageCandidates([paper]),
        });

        await r.click(button);

        // D5 (was { pageIndex: 0, pageLabel: "1" }): no guessed label.
        assert.deepEqual(r.reader(paper.attachmentId)!.navigations, [
          { pageIndex: 0 },
        ]);
        assert.equal(r.status?.variant, "ready");
      });
    });
  });

  describe("C3 paragraph-jump inputs per path", function () {
    it("tries the displayed wordings in a fixed order (D5)", async function () {
      // Three sentences on one page. FindController only finds the last, so
      // every earlier wording is dispatched and fails first.
      const preferred =
        "Alpha ensembles drifted steadily across every recorded session of the experiment";
      const quote =
        "Beta ensembles drifted steadily across every recorded session of the experiment";
      const sourceMatch =
        "Gamma ensembles drifted steadily across every recorded session of the experiment";
      const fallback =
        "Delta ensembles drifted steadily across every recorded session of the experiment";
      const fixture = createExactFindControllerReader({
        pageItems: [
          [{ str: `${preferred}. ${quote}. ${sourceMatch}. ${fallback}.` }],
        ],
        targetPageIndex: 0,
        matchesQuery: (query) => query.startsWith("Delta"),
      });
      const scope = globalThis as any;
      const originalZotero = scope.Zotero;
      scope.Zotero = { getMainWindow: () => null };
      try {
        const jump = await attemptCitationParagraphJumpForTests({
          reader: fixture.reader,
          contextItemId: 5,
          displayCitationLabel: "Smith, 2020",
          quoteText: quote,
          pageIndex: 0,
          pageLabel: "1",
          preferredFullQuoteText: preferred,
          verifiedSourceMatchText: sourceMatch,
          fallbackQuoteTexts: [quote, fallback],
        });
        assert.isTrue(jump.matched);
        const firstSeen = (prefix: string) =>
          fixture.dispatched.findIndex((entry) =>
            entry.query.startsWith(prefix),
          );
        const order = ["Alpha", "Beta", "Gamma", "Delta"].map(firstSeen);
        assert.isAtLeast(order[0], 0);
        assert.deepEqual(
          order.slice().sort((a, b) => a - b),
          order,
          "preferred full text, quote, verified source match, then fallbacks",
        );
        assert.equal(
          fixture.dispatched.filter(
            (entry) => entry.type === "" && entry.query === `${quote}.`,
          ).length,
          1,
          "a repeated wording is tried once",
        );
      } finally {
        if (originalZotero === undefined) delete scope.Zotero;
        else scope.Zotero = originalZotero;
        clearPageTextCache();
      }
    });

    it("trusted: the paragraph text is searched before the shorter quote", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      rememberCachedCitationPage(11, QUOTE_A, 1, "102");
      const button = r.makeButton({
        citationLabel: "(Smith, 2020)",
        quoteText: QUOTE_A,
        paragraphQuoteText: QUOTE_A_PARAGRAPH,
        candidates: r.messageCandidates([paper]),
        navigationMode: "trusted-quote",
      });

      await r.click(button);

      assert.deepEqual(r.findQueries(11), [`${QUOTE_A_PARAGRAPH}.`]);
      assert.equal(r.status?.variant, "ready");
    });

    it("untrusted: the jump gets the verified wording, page index and no page label", async function () {
      const source = libraryPaper(
        0,
        ["Preface.", `Results. ${QUOTE_A_PARAGRAPH}.`],
        {
          pageLabels: ["x", "y"],
        },
      );
      const r = install({ papers: [source] });
      const button = r.makeButton({
        citationLabel: "(Smith, 2020)",
        quoteText: QUOTE_A,
        paragraphQuoteText: QUOTE_A_PARAGRAPH,
        navigationMode: "untrusted-quote",
      });

      await r.click(button);

      assert.deepEqual(r.opened, [
        { itemId: source.attachmentId, location: { pageIndex: 1 } },
      ]);
      // The quote is verified first, so it is what the jump searches for.
      assert.deepEqual(r.findQueries(source.attachmentId), [`${QUOTE_A}.`]);
      assert.equal(
        r.status?.text,
        "Jumped to cited source (page y, paragraph matched)",
      );
    });

    it("untrusted: the verified wording gives the jump a second attempt after a transient FindController miss", async function () {
      // Page index 0 holds only the first two thirds of QUOTE_B, so the page's partial span and the verified wording are the same text. The gate refuses the first search only, as a transient miss in a just-opened reader would. The pin: verifiedSourceMatchText gives the jump a second attempt (without it there is none).
      const paper = libraryPaper(0, [QUOTE_B_PREFIX_PAGE], {
        viewerAccepts: (searchIndex) => searchIndex >= 1,
      });
      const r = install({ papers: [paper] });
      const button = r.makeButton({
        citationLabel: "(Smith, 2020)",
        quoteText: QUOTE_B,
        paragraphQuoteText: QUOTE_B,
        candidates: r.messageCandidates([paper]),
        navigationMode: "untrusted-quote",
      });

      await r.click(button);

      assert.deepEqual(r.opened, [{ itemId: 101, location: { pageIndex: 0 } }]);
      assert.deepEqual(failedJumpStages(r), []);
      // The same span four times: the refused search, two restore passes that
      // re-send the last query after it (findQueries cannot tell them apart),
      // then the retry with the verified wording that succeeds.
      const span =
        "Dopamine release in the ventral striatum tracked the reward prediction error on";
      assert.deepEqual(r.findQueries(paper.attachmentId), [
        span,
        span,
        span,
        span,
      ]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating cited quote...",
        "ready: Jumped to cited source (page 1, paragraph matched)",
      ]);
    });

    it("Task progress: verifies first, opens the page index, and leaves no trace (D6, D7, D8)", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      const button = { dataset: {} as Record<string, string>, disabled: false };

      const outcome = await navigateToTaskPaperPassage({
        body: r.body,
        target: {
          itemId: 10,
          contextItemId: 11,
          libraryID: 1,
          rawSnippet: QUOTE_A,
          cleanedSnippet: QUOTE_A,
          label: "p. 102",
          granularity: "passage",
        },
        button: button as unknown as HTMLButtonElement,
      });

      assert.equal(outcome, "jumped");
      assert.deepEqual(r.pdfWorkerReads, [11], "verified before opening");
      assert.deepEqual(r.opened, [{ itemId: 11, location: { pageIndex: 1 } }]);
      assert.deepEqual(statusTexts(r), [
        "sending: Locating this passage…",
        "ready: Jumped to the passage (page 102)",
      ]);
      assert.deepEqual(r.events, [], "no revalidation request");
      assert.isNull(
        lookupCachedCitationPage(11, QUOTE_A),
        "no page remembered",
      );
      assert.isFalse(button.disabled);
      assert.equal(r.focusCount, 1, "one focus per paragraph jump (D15)");
    });

    it("Task progress: a second open of the same passage is busy while the first runs (D17)", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      const target = {
        itemId: 10,
        contextItemId: 11,
        libraryID: 1,
        rawSnippet: QUOTE_A,
        cleanedSnippet: QUOTE_A,
        label: "p. 102",
        granularity: "passage" as const,
      };

      // No button: only the in-flight passage key can refuse the second.
      const first = navigateToTaskPaperPassage({ body: r.body, target });
      const second = await navigateToTaskPaperPassage({ body: r.body, target });

      assert.equal(second, "busy");
      assert.equal(await first, "jumped");
      assert.deepEqual(r.opened, [{ itemId: 11, location: { pageIndex: 1 } }]);
    });

    it("Task progress: an unfound passage opens its labelled page with a warning (D8, D9)", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      const outcome = await navigateToTaskPaperPassage({
        body: r.body,
        target: {
          itemId: 10,
          contextItemId: 11,
          libraryID: 1,
          rawSnippet: QUOTE_MISSING,
          cleanedSnippet: QUOTE_MISSING,
          label: "p. 103",
          // D5: a read now records its page index; a label-only read is an
          // old one, whose label is a page number (see below).
          pageIndex: 2,
          granularity: "passage",
        },
      });

      assert.equal(outcome, "page");
      assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
      // The labelled page is searched with the page-native fallback, then
      // shown on its own.
      assert.deepEqual(r.reader(11)!.navigations, [
        { pageIndex: 2, pageLabel: "103" },
        { pageIndex: 2, pageLabel: "103" },
      ]);
      assert.equal(
        r.focusCount,
        2,
        "the open and the jump each raise the window (D15)",
      );
      assert.deepEqual(statusTexts(r), [
        "sending: Locating this passage…",
        "sending: Locating this passage…",
        "warning: Couldn't find this passage in the PDF; opened page 103",
      ]);
    });

    it("Task progress: a read that recorded its page index opens that page, whatever its label says (D5)", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });

      const outcome = await navigateToTaskPaperPassage({
        body: r.body,
        target: {
          itemId: 10,
          contextItemId: 11,
          libraryID: 1,
          rawSnippet: QUOTE_MISSING,
          cleanedSnippet: QUOTE_MISSING,
          // Printed label 101 sits on page index 0; the read recorded index 2.
          label: "p. 101",
          pageIndex: 2,
          granularity: "passage",
        },
      });

      assert.equal(outcome, "page");
      // Was page index 0, found from the label.
      assert.deepEqual(r.reader(11)!.navigations, [
        { pageIndex: 2, pageLabel: "103" },
        { pageIndex: 2, pageLabel: "103" },
      ]);
      assert.equal(
        r.status?.text,
        "Couldn't find this passage in the PDF; opened page 103",
      );
    });

    it("Task progress: a read saved before reads recorded a page index still opens the page its label numbers (D5)", async function () {
      // Every label stored before this change was a page number guessed from
      // the index, so "p. 2" means physical page 2, not printed page 2.
      const paper = smith();
      const r = install({ papers: [paper] });

      const outcome = await navigateToTaskPaperPassage({
        body: r.body,
        target: {
          itemId: 10,
          contextItemId: 11,
          libraryID: 1,
          rawSnippet: QUOTE_MISSING,
          cleanedSnippet: QUOTE_MISSING,
          label: "p. 2",
          granularity: "passage",
        },
      });

      assert.equal(outcome, "page");
      assert.deepEqual(r.reader(11)!.navigations, [
        { pageIndex: 1, pageLabel: "102" },
        { pageIndex: 1, pageLabel: "102" },
      ]);
    });

    it("Task progress: an old read's guessed label is never matched against printed labels (D5)", async function () {
      // Printed labels i…x, then 1…4: printed "4" sits on page index 13.
      const printed = [
        "i",
        "ii",
        "iii",
        "iv",
        "v",
        "vi",
        "vii",
        "viii",
        "ix",
        "x",
        "1",
        "2",
        "3",
        "4",
      ];
      const paper = smith({
        pageLabels: printed,
        pages: printed.map((label) => `Page ${label} body text.`),
      });
      const r = install({ papers: [paper] });

      const outcome = await navigateToTaskPaperPassage({
        body: r.body,
        target: {
          itemId: 10,
          contextItemId: 11,
          libraryID: 1,
          rawSnippet: QUOTE_MISSING,
          cleanedSnippet: QUOTE_MISSING,
          // Saved before reads recorded a page index: a guessed page number.
          label: "p. 4",
          granularity: "passage",
        },
      });

      assert.equal(outcome, "page");
      // Physical page 4 (index 3), printed "iv"; not printed "4" (index 13).
      assert.deepEqual(r.reader(11)!.navigations, [
        { pageIndex: 3, pageLabel: "iv" },
        { pageIndex: 3, pageLabel: "iv" },
      ]);
    });

    describe("Task progress after a failed search (D8, D9)", function () {
      function passage(text: string, label: string) {
        return {
          itemId: 10,
          contextItemId: 11,
          libraryID: 1,
          rawSnippet: text,
          cleanedSnippet: text,
          label,
          granularity: "passage" as const,
        };
      }

      it("a verified passage the viewer cannot highlight opens its page with a warning", async function () {
        const paper = smith({ viewerFinds: false });
        const r = install({ papers: [paper] });

        const outcome = await navigateToTaskPaperPassage({
          body: r.body,
          target: passage(QUOTE_A, "p. 102"),
        });

        assert.equal(outcome, "page");
        assert.deepEqual(statusTexts(r), [
          "sending: Locating this passage…",
          "warning: Opened page 102; couldn't highlight this passage",
        ]);
        assert.deepEqual(r.opened, [
          { itemId: 11, location: { pageIndex: 1 } },
        ]);
      });

      it("an unreadable PDF goes to the viewer fallback and jumps", async function () {
        const paper = smith({ backgroundText: false });
        const r = install({ papers: [paper] });

        const outcome = await navigateToTaskPaperPassage({
          body: r.body,
          target: passage(QUOTE_A, "p. 102"),
        });

        assert.equal(outcome, "jumped");
        assert.deepEqual(statusTexts(r), [
          "sending: Locating this passage…",
          "ready: Jumped to the passage (page 102)",
        ]);
        assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
        assert.deepEqual(r.reader(11)!.navigations, [
          { pageIndex: 1, pageLabel: "102" },
        ]);
      });

      it("an unreadable PDF whose viewer cannot highlight the passage opens its page with a warning", async function () {
        const paper = smith({ backgroundText: false, viewerFinds: false });
        const r = install({ papers: [paper] });

        const outcome = await navigateToTaskPaperPassage({
          body: r.body,
          target: passage(QUOTE_A, "p. 102"),
        });

        assert.equal(outcome, "page");
        assert.deepEqual(statusTexts(r), [
          "sending: Locating this passage…",
          "warning: Opened page 102; couldn't highlight this passage",
        ]);
        assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
      });

      it("a passage with no page label and no match opens the paper", async function () {
        const paper = smith();
        const r = install({ papers: [paper] });

        const outcome = await navigateToTaskPaperPassage({
          body: r.body,
          target: passage(QUOTE_MISSING, "Results"),
        });

        assert.equal(outcome, "opened");
        assert.deepEqual(statusTexts(r), [
          "sending: Locating this passage…",
          "warning: Couldn't find this passage in the PDF; opened the paper",
        ]);
        assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
        assert.deepEqual(r.reader(11)!.navigations, []);
      });

      it("the labelled page's own search can still find a passage the background text lacks", async function () {
        // Background text has no such passage, but the viewer's page 103 does.
        const paper = smith({
          viewerPages: [
            smith().pages[0],
            smith().pages[1],
            `Discussion. ${QUOTE_MISSING}.`,
          ],
        });
        const r = install({ papers: [paper] });

        const outcome = await navigateToTaskPaperPassage({
          body: r.body,
          // D5: a read now records its page index with its label.
          target: { ...passage(QUOTE_MISSING, "p. 103"), pageIndex: 2 },
        });

        assert.equal(outcome, "jumped");
        assert.deepEqual(statusTexts(r), [
          "sending: Locating this passage…",
          "sending: Locating this passage…",
          "ready: Jumped to the passage (page 103)",
        ]);
        assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
        assert.deepEqual(r.reader(11)!.navigations, [
          { pageIndex: 2, pageLabel: "103" },
        ]);
      });
    });
  });

  describe("C4 partial DOM page text read by background verification (F18)", function () {
    function domReader(itemId: number, renderedPages: Record<number, string>) {
      const pages = Object.entries(renderedPages).map(([index, text]) => {
        const textLayer = {
          children: [{ textContent: text }],
          textContent: text,
        };
        return {
          nodeType: 1,
          parentElement: null,
          textContent: text,
          getAttribute: (name: string) =>
            name === "data-page-number" ? String(Number(index) + 1) : null,
          querySelector: (selector: string) =>
            selector === ".textLayer" ? textLayer : null,
        };
      });
      const doc = {
        defaultView: null,
        querySelectorAll: () => pages,
      };
      return { itemID: itemId, _iframeWindow: { document: doc } };
    }

    it("does not let a rendered-pages-only cache vouch for a partial span", async function () {
      const scope = globalThis as any;
      const originalZotero = scope.Zotero;
      scope.Zotero = { PDFWorker: { getFullText: async () => null } };
      clearPageTextCache();
      try {
        // The rendered page holds the first two thirds of QUOTE_B. That span
        // is unique among the rendered pages, but an unrendered page could
        // hold it again, or hold the whole quote.
        const warmed = await warmPageTextCache(
          domReader(42, { 0: QUOTE_B_PREFIX_PAGE }),
        );
        assert.equal(warmed?.coverage, "partial-dom");

        const partial = await verifyQuoteLocationForAttachment(42, QUOTE_B);

        assert.equal(partial.status, "unavailable");
        assert.equal(partial.computedPageIndex, null);
        assert.match(partial.reason || "", /only part of the quote/i);
      } finally {
        if (originalZotero === undefined) delete scope.Zotero;
        else scope.Zotero = originalZotero;
        clearPageTextCache();
      }
    });

    it("lets a rendered-pages-only cache confirm a quote but not rule one out", async function () {
      const scope = globalThis as any;
      const originalZotero = scope.Zotero;
      // PDFWorker cannot read this PDF, and the viewer exposes no PDF.js
      // document: only the rendered page's text layer is readable.
      scope.Zotero = { PDFWorker: { getFullText: async () => null } };
      clearPageTextCache();
      try {
        const reader = domReader(41, {
          0: `Introduction. ${QUOTE_A}.`,
        });
        const warmed = await warmPageTextCache(reader);
        assert.equal(warmed?.coverage, "partial-dom");
        assert.isFalse(hasCompleteSearchablePageTextForAttachment(41));

        const onRenderedPage = await verifyQuoteLocationForAttachment(
          41,
          QUOTE_A,
        );
        // A quote on an unrendered page of the same PDF.
        const offRenderedPages = await verifyQuoteLocationForAttachment(
          41,
          QUOTE_MISSING,
        );

        assert.equal(onRenderedPage.status, "resolved");
        assert.equal(onRenderedPage.computedPageIndex, 0);
        // FIXED (F18; was "not-found"): the cache holds only the rendered
        // page, so a miss there says nothing about the pages never rendered.
        // The verdict is "unavailable", which sends a click to the viewer.
        assert.equal(offRenderedPages.status, "unavailable");
        assert.equal(offRenderedPages.computedPageIndex, null);
      } finally {
        if (originalZotero === undefined) delete scope.Zotero;
        else scope.Zotero = originalZotero;
        clearPageTextCache();
      }
    });

    it("still opens an unreadable PDF in the viewer for an untrusted click once a partial cache exists", async function () {
      // The quote is on page index 1 of a PDF the background worker cannot
      // read. Without a cache the viewer fallback opens it and jumps.
      const scanned = libraryPaper(
        0,
        ["Preface of the scanned paper.", `Results. ${QUOTE_A}.`],
        { backgroundText: false },
      );
      const fresh = install({ papers: [scanned] });
      await fresh.click(
        fresh.makeButton({
          citationLabel: "(Smith, 2020)",
          quoteText: QUOTE_A,
          navigationMode: "untrusted-quote",
        }),
      );
      assert.equal(fresh.status?.variant, "ready");
      const freshNavigations = fresh.reader(scanned.attachmentId)!.navigations;
      fresh.restore();
      rig = null;

      // Same PDF, but an earlier warm saw only its rendered first page.
      const r = install({ papers: [scanned] });
      await warmPageTextCache(
        domReader(scanned.attachmentId, { 0: "Preface of the scanned paper." }),
      );
      await r.click(
        r.makeButton({
          citationLabel: "(Smith, 2020)",
          quoteText: QUOTE_A,
          navigationMode: "untrusted-quote",
        }),
      );

      // FIXED (F18; was: nothing opened and "error: The complete quote was
      // not found in the live PDF text."): the partial cache cannot rule the
      // quote out, so the viewer fallback opens the PDF and jumps, exactly as
      // it does without the cache.
      assert.deepEqual(r.opened, [
        { itemId: scanned.attachmentId, location: undefined },
      ]);
      assert.equal(r.status?.variant, "ready");
      assert.deepEqual(
        r.reader(scanned.attachmentId)!.navigations,
        freshNavigations,
      );
      // D5 (was { pageIndex: 1, pageLabel: "2" }): no guessed label.
      assert.deepEqual(freshNavigations, [{ pageIndex: 1 }]);
    });

    it("still finds a Task progress passage in an unreadable PDF once a partial cache exists", async function () {
      const scanned = smith({ backgroundText: false });
      const r = install({ papers: [scanned] });
      // An earlier warm saw only the PDF's rendered first page.
      await warmPageTextCache(domReader(11, { 0: scanned.pages[0] }));

      const outcome = await navigateToTaskPaperPassage({
        body: r.body,
        target: {
          itemId: 10,
          contextItemId: 11,
          libraryID: 1,
          rawSnippet: QUOTE_A,
          cleanedSnippet: QUOTE_A,
          label: "Results",
          granularity: "passage" as const,
        },
      });

      // Before F18 the partial cache's "not-found" skipped the viewer, and the
      // click only opened the paper with "Couldn't find this passage".
      assert.equal(outcome, "jumped");
      assert.deepEqual(statusTexts(r), [
        "sending: Locating this passage…",
        "ready: Jumped to the passage (page 102)",
      ]);
      assert.deepEqual(r.opened, [{ itemId: 11, location: undefined }]);
    });
  });

  it("resolves a quote citation's own attachment as a quote-citation candidate", function () {
    // Guards the rig: trusted-quote candidates in production come from the
    // quote's own attachment, and these tests use message-context ones.
    const paper = smith();
    const r = install({ papers: [paper] });
    const resolved = resolveQuoteCitationCandidatesForTests(
      quoteCitation(),
      extractStandalonePaperSourceLabel("(Smith, 2020)"),
      r.messageCandidates([paper]),
    );
    assert.deepEqual(
      resolved.map((candidate) => [
        candidate.contextItemId,
        candidate.provenance,
      ]),
      [[11, "quote-citation"]],
    );
  });
});

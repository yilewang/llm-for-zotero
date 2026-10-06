/**
 * What every citation navigation tier hands the paragraph jump (step 8, D4).
 *
 * The characterization suite pins what a user sees after a click. Some jump
 * arguments leave no visible trace in the rig, for example the T5 and T6
 * fallbacks to the located result's page occurrence: the rig's page text
 * makes that occurrence equal to the one the jump would derive on its own.
 * These tests spy on the jump's arguments instead, through
 * `observeCitationParagraphJumpsForTests`, so a refactor of the tiers cannot
 * drop or swap one of them silently.
 *
 * Each observed call is shown without its reader and without keys whose value
 * is undefined: the jump treats an absent and an undefined argument alike.
 */
import { assert } from "chai";
import {
  navigateToTaskPaperPassage,
  rememberCachedCitationPage,
} from "../src/modules/contextPanel/assistantCitationLinks";
import { observeCitationParagraphJumpsForTests } from "../src/modules/contextPanel/quoteNavigator";
import type { QuoteCitation } from "../src/modules/contextPanel/types";
import {
  installCitationNavigationRig,
  type CitationNavigationRig,
  type RigPaper,
} from "./helpers/citationNavigationRig";

const QUOTE_A =
  "Place cell ensembles gradually reorganized their firing fields across consecutive recording sessions while the animals ran the same linear track";
const QUOTE_A_TAIL = "Other cells in the same field of view stayed stable";
const QUOTE_A_PARAGRAPH = `${QUOTE_A}. ${QUOTE_A_TAIL}`;
const QUOTE_MISSING =
  "Grid cell modules realigned to the new enclosure geometry within minutes of the first exposure session";

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
      `Results. ${QUOTE_A_PARAGRAPH}.`,
      "Discussion. These findings constrain models of memory consolidation.",
    ],
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

type ObservedJump = Record<string, unknown>;

function describeJump(params: Record<string, unknown>): ObservedJump {
  const out: ObservedJump = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "reader" || value === undefined) continue;
    out[key] = Array.isArray(value) ? value.slice() : value;
  }
  return out;
}

describe("citation navigation jump arguments per tier (D4)", function () {
  this.timeout(20000);
  let rig: CitationNavigationRig | null = null;
  let jumps: ObservedJump[] = [];

  beforeEach(function () {
    jumps = [];
    observeCitationParagraphJumpsForTests((params) => {
      jumps.push(describeJump(params as unknown as Record<string, unknown>));
    });
  });

  afterEach(function () {
    observeCitationParagraphJumpsForTests(null);
    rig?.restore();
    rig = null;
  });

  function install(
    options: Parameters<typeof installCitationNavigationRig>[0],
  ): CitationNavigationRig {
    rig = installCitationNavigationRig(options);
    return rig;
  }

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

  describe("trusted quote ladder", function () {
    it("T1 hands the jump the cached page and the quote citation's certificate", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      rememberCachedCitationPage(11, QUOTE_A, 1, "102");
      const button = trustedButton(r, paper, {
        paragraphQuoteText: QUOTE_A_PARAGRAPH,
        quoteCitation: quoteCitation({
          sourceFingerprint: "pdfjs:fp-11",
          sourceMatchKind: "exact",
          sourceMatchPageOccurrence: 0,
        }),
      });

      await r.click(button);

      assert.deepEqual(jumps, [
        {
          contextItemId: 11,
          displayCitationLabel: "Smith, 2020",
          quoteText: QUOTE_A,
          pageIndex: 1,
          pageLabel: "102",
          citationId: "q1",
          sourceFingerprint: "pdfjs:fp-11",
          sourceMatchPageOccurrence: 0,
          preferredFullQuoteText: QUOTE_A_PARAGRAPH,
          verifiedFullSpan: true,
        },
      ]);
    });

    it("T2 falls back to the hidden cache's fingerprint, occurrence and wording", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, {
        quoteCitation: quoteCitation(),
      });

      await r.click(button);

      assert.deepEqual(jumps, [
        {
          contextItemId: 11,
          displayCitationLabel: "Smith, 2020",
          quoteText: QUOTE_A,
          pageIndex: 1,
          pageLabel: "102",
          citationId: "q1",
          // The hidden cache's own fingerprint of the background text.
          sourceFingerprint: "page-text:gskcv1",
          sourceMatchPageOccurrence: 0,
          verifiedSourceMatchText: `${QUOTE_A}.`,
          verifiedFullSpan: false,
        },
      ]);
    });

    it("T2 prefers the quote citation's fingerprint and occurrence over the hidden cache's", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, {
        quoteCitation: quoteCitation({
          sourceFingerprint: "pdfjs:fp-11",
          sourceMatchPageOccurrence: 2,
        }),
      });

      await r.click(button);

      assert.deepEqual(jumps[0], {
        contextItemId: 11,
        displayCitationLabel: "Smith, 2020",
        quoteText: QUOTE_A,
        pageIndex: 1,
        pageLabel: "102",
        citationId: "q1",
        sourceFingerprint: "pdfjs:fp-11",
        sourceMatchPageOccurrence: 2,
        verifiedSourceMatchText: `${QUOTE_A}.`,
        verifiedFullSpan: false,
      });
    });

    it("T3 hands the jump the stored page hint and no verified wording", async function () {
      const paper = smith({ backgroundText: false });
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, {
        paragraphQuoteText: QUOTE_A_PARAGRAPH,
        quoteCitation: quoteCitation({
          pageHintIndex: 1,
          pageHintLabel: "102",
          sourceMatchPageOccurrence: 0,
        }),
      });

      await r.click(button);

      assert.deepEqual(jumps, [
        {
          contextItemId: 11,
          displayCitationLabel: "Smith, 2020",
          quoteText: QUOTE_A,
          pageIndex: 1,
          pageLabel: "102",
          citationId: "q1",
          sourceMatchPageOccurrence: 0,
          preferredFullQuoteText: QUOTE_A_PARAGRAPH,
          verifiedFullSpan: false,
        },
      ]);
    });

    it("T3 resolves a label-only hint to its page index", async function () {
      const paper = smith({ backgroundText: false });
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, {
        quoteCitation: quoteCitation({ pageHintLabel: "102" }),
      });

      await r.click(button);

      assert.deepEqual(jumps, [
        {
          contextItemId: 11,
          displayCitationLabel: "Smith, 2020",
          quoteText: QUOTE_A,
          pageIndex: 1,
          pageLabel: "102",
          citationId: "q1",
          verifiedFullSpan: false,
        },
      ]);
    });

    it("T4 hands the jump the explicit label and its resolved index", async function () {
      const paper = smith({ backgroundText: false });
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, {
        citationLabel: "(Smith, 2020, page 102)",
        quoteCitation: quoteCitation({ sourceMatchPageOccurrence: 0 }),
      });

      await r.click(button);

      assert.deepEqual(jumps, [
        {
          contextItemId: 11,
          displayCitationLabel: "Smith, 2020",
          quoteText: QUOTE_A,
          pageIndex: 1,
          pageLabel: "102",
          citationId: "q1",
          sourceMatchPageOccurrence: 0,
          verifiedFullSpan: false,
        },
      ]);
    });

    it("T4 → T6: a failed explicit label is followed by the full search's arguments", async function () {
      const paper = smith({ backgroundText: false });
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, {
        citationLabel: "(Smith, 2020, page 103)",
        quoteCitation: quoteCitation(),
      });

      await r.click(button);

      assert.deepEqual(jumps, [
        {
          contextItemId: 11,
          displayCitationLabel: "Smith, 2020",
          quoteText: QUOTE_A,
          pageIndex: 2,
          pageLabel: "103",
          citationId: "q1",
          verifiedFullSpan: false,
        },
        {
          contextItemId: 11,
          displayCitationLabel: "Smith, 2020",
          quoteText: QUOTE_A,
          pageIndex: 1,
          pageLabel: "102",
          citationId: "q1",
          sourceMatchPageOccurrence: 0,
          verifiedSourceMatchText: `${QUOTE_A}.`,
          verifiedFullSpan: false,
        },
      ]);
    });

    it("T5 falls back to the located result's occurrence and wording on the active reader", async function () {
      const r = install({
        papers: [],
        orphanReaders: [{ itemId: 77, pages: smith().pages }],
      });
      r.selectReader(77);
      const button = r.makeButton({
        citationLabel: "(Smith, 2020)",
        quoteText: QUOTE_A,
        paragraphQuoteText: QUOTE_A_PARAGRAPH,
        quoteCitation: quoteCitation({ id: "q5" }),
        navigationMode: "trusted-quote",
      });

      await r.click(button);

      assert.deepEqual(jumps, [
        {
          contextItemId: 77,
          displayCitationLabel: "Smith, 2020",
          quoteText: QUOTE_A,
          pageIndex: 1,
          pageLabel: "2",
          citationId: "q5",
          sourceMatchPageOccurrence: 0,
          preferredFullQuoteText: QUOTE_A_PARAGRAPH,
          verifiedSourceMatchText: `${QUOTE_A}.`,
          verifiedFullSpan: false,
        },
      ]);
    });

    it("T5 keeps the quote citation's occurrence over the located result's", async function () {
      const r = install({
        papers: [],
        orphanReaders: [{ itemId: 77, pages: smith().pages }],
      });
      r.selectReader(77);
      const button = r.makeButton({
        citationLabel: "(Smith, 2020)",
        quoteText: QUOTE_A,
        quoteCitation: quoteCitation({
          id: "q5",
          sourceMatchPageOccurrence: 3,
        }),
        navigationMode: "trusted-quote",
      });

      await r.click(button);

      assert.equal(jumps[0]?.sourceMatchPageOccurrence, 3);
    });

    it("T6 falls back to the located result's occurrence and wording on each candidate", async function () {
      const paper = smith({ backgroundText: false });
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, {
        paragraphQuoteText: QUOTE_A_PARAGRAPH,
        quoteCitation: quoteCitation({ sourceFingerprint: "pdfjs:fp-11" }),
      });

      await r.click(button);

      assert.deepEqual(jumps, [
        {
          contextItemId: 11,
          displayCitationLabel: "Smith, 2020",
          quoteText: QUOTE_A,
          pageIndex: 1,
          pageLabel: "102",
          citationId: "q1",
          sourceFingerprint: "pdfjs:fp-11",
          sourceMatchPageOccurrence: 0,
          preferredFullQuoteText: QUOTE_A_PARAGRAPH,
          verifiedSourceMatchText: `${QUOTE_A}.`,
          verifiedFullSpan: false,
        },
      ]);
    });

    it("T6 keeps the quote citation's occurrence over the located result's", async function () {
      const paper = smith({ backgroundText: false });
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper, {
        quoteCitation: quoteCitation({ sourceMatchPageOccurrence: 3 }),
      });

      await r.click(button);

      assert.equal(jumps[jumps.length - 1]?.sourceMatchPageOccurrence, 3);
    });

    it("a trusted quote without a quote citation passes no certificate", async function () {
      const paper = smith({ backgroundText: false });
      const r = install({ papers: [paper] });
      const button = trustedButton(r, paper);

      await r.click(button);

      assert.deepEqual(jumps, [
        {
          contextItemId: 11,
          displayCitationLabel: "Smith, 2020",
          quoteText: QUOTE_A,
          pageIndex: 1,
          pageLabel: "102",
          sourceMatchPageOccurrence: 0,
          verifiedSourceMatchText: `${QUOTE_A}.`,
          verifiedFullSpan: false,
        },
      ]);
    });
  });

  describe("untrusted quote path", function () {
    it("hands the jump the verified wording, occurrence and page, and no certificate", async function () {
      const paper = smith();
      const r = install({ papers: [paper] });
      const button = r.makeButton({
        citationLabel: "(Smith, 2020)",
        quoteText: QUOTE_A,
        paragraphQuoteText: QUOTE_A_PARAGRAPH,
        navigationMode: "untrusted-quote",
      });

      await r.click(button);

      assert.deepEqual(jumps, [
        {
          contextItemId: 11,
          displayCitationLabel: "Smith, 2020",
          quoteText: QUOTE_A,
          pageIndex: 1,
          pageLabel: "102",
          sourceMatchPageOccurrence: 0,
          verifiedSourceMatchText: `${QUOTE_A}.`,
        },
      ]);
    });

    it("the viewer fallback hands the jump the reader's own page label", async function () {
      const paper = smith({ backgroundText: false, pageLabels: undefined });
      const r = install({ papers: [paper] });
      const button = r.makeButton({
        citationLabel: "(Smith, 2020)",
        quoteText: QUOTE_A,
        navigationMode: "untrusted-quote",
      });

      await r.click(button);

      assert.deepEqual(jumps, [
        {
          contextItemId: 11,
          displayCitationLabel: "Smith, 2020",
          quoteText: QUOTE_A,
          pageIndex: 1,
          pageLabel: "2",
          sourceMatchPageOccurrence: 0,
          verifiedSourceMatchText: `${QUOTE_A}.`,
        },
      ]);
    });
  });

  describe("Task progress", function () {
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

    it("hands the jump every search text as a fallback wording", async function () {
      const r = install({ papers: [smith()] });

      await navigateToTaskPaperPassage({
        body: r.body,
        target: passage(QUOTE_A, "p. 102"),
      });

      assert.deepEqual(jumps, [
        {
          contextItemId: 11,
          displayCitationLabel: "p. 102",
          quoteText: QUOTE_A,
          pageIndex: 1,
          pageLabel: "102",
          sourceMatchPageOccurrence: 0,
          verifiedSourceMatchText: `${QUOTE_A}.`,
          fallbackQuoteTexts: [QUOTE_A],
        },
      ]);
    });

    it("the viewer fallback for an unreadable PDF hands the jump the same wordings", async function () {
      const r = install({ papers: [smith({ backgroundText: false })] });

      await navigateToTaskPaperPassage({
        body: r.body,
        target: passage(QUOTE_A, "p. 102"),
      });

      assert.deepEqual(jumps, [
        {
          contextItemId: 11,
          displayCitationLabel: "p. 102",
          quoteText: QUOTE_A,
          pageIndex: 1,
          pageLabel: "102",
          sourceMatchPageOccurrence: 0,
          verifiedSourceMatchText: `${QUOTE_A}.`,
          fallbackQuoteTexts: [QUOTE_A],
        },
      ]);
    });

    it("the labelled-page fallback hands the jump the label's page", async function () {
      const r = install({ papers: [smith()] });

      await navigateToTaskPaperPassage({
        body: r.body,
        target: passage(QUOTE_MISSING, "p. 103"),
      });

      assert.deepEqual(jumps, [
        {
          contextItemId: 11,
          displayCitationLabel: "p. 103",
          quoteText: QUOTE_MISSING,
          pageIndex: 2,
          pageLabel: "103",
          fallbackQuoteTexts: [],
        },
      ]);
    });
  });
});

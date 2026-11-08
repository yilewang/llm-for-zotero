import { assert } from "chai";
import {
  bindQuoteCitationToDisplayedText,
  buildQuoteCitation,
  buildQuoteSourceIndex,
  clearParagraphLocateMissCache,
  getParagraphLocateSearchRunCount,
  locateParagraphCitationOnPageText,
  recheckPartialPageLocation,
  hasVerifiedQuoteLocation,
  normalizeQuoteCitations,
  type QuoteSourceText,
} from "../src/services/quotes/quoteCitations";
import { applyAssistantMessageQuoteGate } from "../src/modules/contextPanel/quoteValidation/gate";
import {
  buildQuoteRenderPlan,
  getMessageQuoteDisplay,
} from "../src/modules/contextPanel/quoteRenderPlan";
import {
  assistantMarkdownNeedsBackgroundQuoteSearch,
  assistantMarkdownNeedsQuoteSourceSearch,
  buildCachedQuoteSourceEvidenceForPaperContexts,
} from "../src/modules/contextPanel/quoteValidation/sourceEvidence";
import {
  clearPageTextCache,
  seedPageTextCacheFromFullText,
} from "../src/services/pdf/livePdfSelectionLocator";
import type { QuoteCitation } from "../src/shared/types";
import { withDigestQuoteCitations } from "../src/agent/digests/paperDigestWorker";
import type { Message } from "../src/modules/contextPanel/types";

const LABEL = "(Fixture, 2026)";
const CONTEXT_ITEM_ID = 212;
const OTHER_CONTEXT_ITEM_ID = 213;

/** A host-minted body paragraph, as paper_read hands it to the model. */
const PASSAGE =
  "Across all recording sessions, the population code for the familiar arena drifted steadily even though the behavioural performance of the animals remained unchanged. Individual neurons gained and lost place fields from one day to the next, yet a linear decoder trained on one session still recovered the position of the animal on later sessions with high accuracy.";

const PAGE_FILLER =
  "Mice were trained to run laps on a linear track for water rewards delivered at both ends of the track.";

function pageSource(
  sourceText: string,
  pageHintIndex: number,
  contextItemId = CONTEXT_ITEM_ID,
): QuoteSourceText {
  return {
    sourceText,
    sourceLabel: LABEL,
    contextItemId,
    itemId: contextItemId - 1,
    sourceMatchSource: "pdf-page-text",
    sourceFingerprint: `page-text:fixture-${contextItemId}`,
    requiresPageHint: true,
    pageHintIndex,
    pageHintLabel: String(pageHintIndex + 1),
  };
}

function chunkSource(sourceText: string): QuoteSourceText {
  return {
    sourceText,
    sourceLabel: LABEL,
    contextItemId: CONTEXT_ITEM_ID,
    itemId: CONTEXT_ITEM_ID - 1,
    sourceMatchSource: "context-text",
    sourceFingerprint: "fnv1a32-0badc0de",
    requiresPageHint: true,
  };
}

/** The record paper_read mints: chunk text, MinerU fingerprint, a page hint. */
function paragraphRecord(quoteText = PASSAGE): QuoteCitation {
  return buildQuoteCitation({
    quoteText,
    sourceMatchText: quoteText,
    sourceMatchKind: "exact",
    sourceMatchSource: "context-text",
    citationLabel: LABEL,
    contextItemId: CONTEXT_ITEM_ID,
    itemId: CONTEXT_ITEM_ID - 1,
    sourceFingerprint: "fnv1a32-0badc0de",
    pageHintIndex: 0,
    allowShortQuoteText: true,
  })!;
}

function citeOnlyMessage(citation: QuoteCitation): Message {
  return {
    role: "assistant",
    text: `The code drifts while behaviour holds. [[cite:${citation.id}]]`,
    timestamp: 1,
    quoteCitations: [citation],
  };
}

async function gate(
  message: Message,
  sourceTexts: QuoteSourceText[],
  cooperative = false,
): Promise<void> {
  await applyAssistantMessageQuoteGate(
    message,
    message.text,
    message.quoteCitations,
    { sourceTexts, complete: true },
    {},
    undefined,
    [],
    cooperative ? { yieldToMain: async () => {} } : undefined,
  );
}

function displayedParagraphCitation(
  message: Message,
  id: string,
): QuoteCitation | undefined {
  const display = getMessageQuoteDisplay(message);
  assert.include(display.markdown, `[[cite:${id}]]`, "the token survives");
  const plan = buildQuoteRenderPlan(display);
  return plan.paragraphCitations.flat().find((citation) => citation.id === id);
}

describe("paragraph citation location on PDF page text", function () {
  for (const cooperative of [false, true]) {
    it(`turns an exactly located paragraph green under its own id${cooperative ? " (cooperative)" : ""}`, async function () {
      const record = paragraphRecord();
      assert.isFalse(hasVerifiedQuoteLocation(record));
      const message = citeOnlyMessage(record);
      await gate(
        message,
        [
          pageSource(PAGE_FILLER, 0),
          pageSource(`${PAGE_FILLER} ${PASSAGE} ${PAGE_FILLER}`, 3),
          chunkSource(PASSAGE),
        ],
        cooperative,
      );
      const located = displayedParagraphCitation(message, record.id);
      assert.isDefined(located);
      assert.equal(located!.id, record.id);
      assert.isTrue(hasVerifiedQuoteLocation(located!));
      assert.equal(located!.sourceMatchSource, "pdf-page-text");
      assert.equal(located!.pageHintIndex, 3);
      assert.equal(located!.pageHintLabel, "4");
      assert.equal(located!.sourceMatchPageOccurrence, 0);
      assert.equal(located!.sourceFingerprint, "page-text:fixture-212");
      assert.include(["exact", "normalized-span"], located!.sourceMatchKind);
      assert.equal(located!.quoteText, record.quoteText);
      // The stored history is the model's record; only the display changes.
      assert.isFalse(hasVerifiedQuoteLocation(message.quoteCitations![0]));
    });
  }

  it("turns a near-complete paragraph green with a partial kind the navigator can click", async function () {
    // The page drops one clause of the passage: the whole passage no longer
    // matches, but a unique run of well over 12 tokens and >= 80% of the
    // passage's tokens are on the page.
    const pageText = PASSAGE.replace(
      " from one day to the next",
      " between sessions",
    );
    const record = paragraphRecord();
    const message = citeOnlyMessage(record);
    await gate(message, [pageSource(PAGE_FILLER, 0), pageSource(pageText, 5)]);
    const located = displayedParagraphCitation(message, record.id);
    assert.isDefined(located);
    assert.equal(located!.id, record.id);
    assert.isTrue(hasVerifiedQuoteLocation(located!));
    assert.equal(located!.pageHintIndex, 5);
    assert.include(
      ["raw-prefix", "raw-suffix", "raw-middle", "progressive"],
      located!.sourceMatchKind,
    );
    assert.include(pageText, located!.sourceMatchText!);
    assert.equal(located!.quoteText, record.quoteText);
  });

  it("keeps a paragraph grey when too little of it is on the page", async function () {
    const half = PASSAGE.slice(0, PASSAGE.indexOf(" Individual neurons"));
    const record = paragraphRecord();
    const message = citeOnlyMessage(record);
    await gate(message, [pageSource(`${PAGE_FILLER} ${half}`, 2)]);
    const shown = displayedParagraphCitation(message, record.id);
    assert.isDefined(shown, "the card is kept");
    assert.isFalse(hasVerifiedQuoteLocation(shown!));
  });

  it("keeps an unlocated paragraph grey, never removed or marked not-source", async function () {
    const record = paragraphRecord();
    const message = citeOnlyMessage(record);
    await gate(message, [pageSource(PAGE_FILLER, 0)]);
    const display = getMessageQuoteDisplay(message);
    const plan = buildQuoteRenderPlan(display);
    assert.notInclude(display.markdown, "Not a source quote");
    assert.isEmpty(
      plan.diagnostics.filter((entry) => entry.quoteCitationId === record.id),
    );
    const shown = displayedParagraphCitation(message, record.id);
    assert.isDefined(shown);
    assert.isFalse(hasVerifiedQuoteLocation(shown!));
    assert.deepEqual(shown, normalizeQuoteCitations([record])[0]);
  });

  it("keeps a digest quote with no page hint as a grey mark when the gate cannot locate it, as for paper_read", async function () {
    // A digest mints its quote with no page, fingerprint or chunk kind.
    const digest = withDigestQuoteCitations(
      {
        schema: 2,
        itemId: CONTEXT_ITEM_ID - 1,
        contextItemId: CONTEXT_ITEM_ID,
        title: "Drift fixture",
        answer: "The code drifts while behaviour holds.",
        evidence: [{ section: "Results", quote: PASSAGE }],
        facets: [],
        gaps: [],
        source: {
          backend: "mineru",
          readCharacters: 1,
          totalCharacters: 1,
          complete: true,
        },
        model: "m",
        producedAt: 1,
        cacheKey: "k",
      },
      LABEL,
    );
    const [record] = digest.quoteCitations || [];
    assert.exists(record);
    assert.isUndefined(record.pageHintIndex);
    const message = citeOnlyMessage(record);
    // The PDF's pages do not hold the quote.
    await gate(message, [
      pageSource(PAGE_FILLER, 0),
      pageSource(PAGE_FILLER, 1),
    ]);
    const display = getMessageQuoteDisplay(message);
    const plan = buildQuoteRenderPlan(display);
    assert.notInclude(display.markdown, "Not a source quote");
    assert.isEmpty(
      plan.diagnostics.filter((entry) => entry.quoteCitationId === record.id),
    );
    const shown = displayedParagraphCitation(message, record.id);
    assert.isDefined(shown, "the mark is rendered");
    assert.isFalse(hasVerifiedQuoteLocation(shown!));
  });

  it("never locates a paragraph on another paper's pages", async function () {
    const record = paragraphRecord();
    const message = citeOnlyMessage(record);
    await gate(message, [
      pageSource(PAGE_FILLER, 0),
      pageSource(PASSAGE, 1, OTHER_CONTEXT_ITEM_ID),
    ]);
    const shown = displayedParagraphCitation(message, record.id);
    assert.isDefined(shown);
    assert.isFalse(hasVerifiedQuoteLocation(shown!));
    assert.notEqual(shown!.contextItemId, OTHER_CONTEXT_ITEM_ID);
  });

  it("never locates a paragraph on chunk text that claims a page", async function () {
    const record = paragraphRecord();
    const message = citeOnlyMessage(record);
    await gate(message, [
      {
        ...pageSource(PASSAGE, 4),
        sourceFingerprint: "fnv1a32-0badc0de",
      },
    ]);
    const shown = displayedParagraphCitation(message, record.id);
    assert.isFalse(hasVerifiedQuoteLocation(shown!));
  });
});

describe("paragraph citation validation scheduling", function () {
  it("schedules a message whose only sources are paragraph citations", function () {
    const record = paragraphRecord();
    const message = citeOnlyMessage(record);
    assert.isTrue(assistantMarkdownNeedsQuoteSourceSearch(message.text));
    assert.isTrue(
      assistantMarkdownNeedsBackgroundQuoteSearch(message.text, [record]),
    );
  });

  it("ignores paragraph citation syntax inside code", function () {
    const record = paragraphRecord();
    const markdown = `Write \`[[cite:${record.id}]]\` after a claim.`;
    assert.isFalse(assistantMarkdownNeedsQuoteSourceSearch(markdown));
    assert.isFalse(
      assistantMarkdownNeedsBackgroundQuoteSearch(markdown, [record]),
    );
  });

  it("stops rescheduling once every paragraph citation is verified", async function () {
    const record = paragraphRecord();
    const message = citeOnlyMessage(record);
    await gate(message, [pageSource(PASSAGE, 3)]);
    const display = getMessageQuoteDisplay(message);
    assert.isTrue(hasVerifiedQuoteLocation(display.quoteCitations![0]));
    assert.isFalse(
      assistantMarkdownNeedsBackgroundQuoteSearch(
        display.markdown,
        display.quoteCitations,
      ),
    );
  });

  it("does not schedule ids that have no record", function () {
    assert.isFalse(
      assistantMarkdownNeedsBackgroundQuoteSearch(
        "Claim. [[cite:Q_0000000]]",
        [],
      ),
    );
  });
});

describe("display rebinding needs real page text", function () {
  // paper_read used to mint MinerU chunk text as "pdf-page-text" with the
  // section heading's page; rebinding then added a page occurrence and the
  // card turned green with no PDF check (stored msg 782, Q_1ruxwkt).
  const chunkPageRecord = (sourceFingerprint: string) =>
    buildQuoteCitation({
      quoteText: PASSAGE,
      sourceMatchText: PASSAGE,
      sourceMatchKind: "exact",
      sourceMatchSource: "pdf-page-text",
      citationLabel: LABEL,
      contextItemId: CONTEXT_ITEM_ID,
      itemId: CONTEXT_ITEM_ID - 1,
      sourceFingerprint,
      pageHintIndex: 7,
      allowShortQuoteText: true,
    })!;

  it("does not add a page occurrence to a MinerU-fingerprinted record", function () {
    const record = chunkPageRecord("fnv1a32-ada0ec01");
    const rebound = bindQuoteCitationToDisplayedText(record, PASSAGE);
    assert.isDefined(rebound);
    assert.isUndefined(rebound!.sourceMatchPageOccurrence);
    assert.isFalse(hasVerifiedQuoteLocation(rebound!));
  });

  it("renders a blockquote bound to a MinerU-fingerprinted record grey", function () {
    const record = chunkPageRecord("fnv1a32-ada0ec01");
    const plan = buildQuoteRenderPlan({
      markdown: `> ${PASSAGE}`,
      quoteCitations: [record],
    });
    assert.lengthOf(plan.occurrences, 1);
    assert.equal(plan.occurrences[0].trust, "unverified-source-label");
  });

  it("never treats a chunk-text fingerprint as a verified page location", function () {
    const record = buildQuoteCitation({
      ...chunkPageRecord("fnv1a32-ada0ec01"),
      sourceMatchPageOccurrence: 0,
    })!;
    assert.isFalse(hasVerifiedQuoteLocation(record));
  });

  it("still completes a page-text record that lacks only its occurrence", function () {
    const record = chunkPageRecord("pdfjs:viewer-fingerprint");
    const rebound = bindQuoteCitationToDisplayedText(record, PASSAGE);
    assert.equal(rebound?.sourceMatchPageOccurrence, 0);
    assert.isTrue(hasVerifiedQuoteLocation(rebound!));
  });
});

describe("evidence for attachments named only by citations", function () {
  const globals = globalThis as unknown as { Zotero?: unknown };
  let previousZotero: unknown;

  beforeEach(function () {
    previousZotero = globals.Zotero;
    globals.Zotero = {
      Items: {
        get: (id: number) => ({
          id,
          isAttachment: () => true,
          attachmentContentType: "application/pdf",
        }),
      },
    };
  });

  afterEach(function () {
    globals.Zotero = previousZotero;
    clearPageTextCache();
  });

  async function seedPages(contextItemId: number, pages: string[]) {
    await seedPageTextCacheFromFullText(contextItemId, {
      text: pages.join(""),
      pageChars: pages.map((page) => page.length),
      totalPages: pages.length,
    });
  }

  it("checks a citation against its own attachment when the message stores no paper contexts", async function () {
    await seedPages(CONTEXT_ITEM_ID, [
      PAGE_FILLER,
      `${PAGE_FILLER} ${PASSAGE}`,
    ]);
    const record = paragraphRecord();
    const message = citeOnlyMessage(record);
    const evidence = buildCachedQuoteSourceEvidenceForPaperContexts();
    assert.isEmpty(evidence.sourceTexts, "no paper context supplies evidence");
    await applyAssistantMessageQuoteGate(
      message,
      message.text,
      message.quoteCitations,
      evidence,
      {},
    );
    const located = displayedParagraphCitation(message, record.id);
    assert.isTrue(hasVerifiedQuoteLocation(located!));
    assert.equal(located!.pageHintIndex, 1);
    assert.equal(located!.contextItemId, CONTEXT_ITEM_ID);
    assert.match(located!.sourceFingerprint || "", /^page-text:/);
  });

  it("never checks a citation against another cited attachment's pages", async function () {
    // Paper Y (another citation's attachment) holds the passage; paper X,
    // which the record names, does not.
    await seedPages(CONTEXT_ITEM_ID, [PAGE_FILLER]);
    await seedPages(OTHER_CONTEXT_ITEM_ID, [PAGE_FILLER, PASSAGE]);
    const record = paragraphRecord();
    const otherRecord = buildQuoteCitation({
      quoteText: PAGE_FILLER,
      citationLabel: "(Other, 2024)",
      contextItemId: OTHER_CONTEXT_ITEM_ID,
      itemId: OTHER_CONTEXT_ITEM_ID - 1,
      allowShortQuoteText: true,
    })!;
    const message: Message = {
      role: "assistant",
      text: `The code drifts. [[cite:${record.id}]] Mice ran laps. [[cite:${otherRecord.id}]]`,
      timestamp: 1,
      quoteCitations: [record, otherRecord],
    };
    await applyAssistantMessageQuoteGate(
      message,
      message.text,
      message.quoteCitations,
      buildCachedQuoteSourceEvidenceForPaperContexts(),
      {},
    );
    const shown = displayedParagraphCitation(message, record.id);
    assert.isFalse(hasVerifiedQuoteLocation(shown!));
    assert.equal(shown!.contextItemId, CONTEXT_ITEM_ID);
    const other = displayedParagraphCitation(message, otherRecord.id);
    assert.isTrue(hasVerifiedQuoteLocation(other!), "Y's own card is located");
    assert.equal(other!.contextItemId, OTHER_CONTEXT_ITEM_ID);
  });

  it("does not repeat the search for a miss on unchanged page text", function () {
    clearParagraphLocateMissCache();
    const record = paragraphRecord();
    const sourceIndex = buildQuoteSourceIndex({
      quoteCitations: [],
      sourceTexts: [pageSource(PAGE_FILLER, 0)],
    });
    const before = getParagraphLocateSearchRunCount();
    assert.isUndefined(
      locateParagraphCitationOnPageText({ citation: record, sourceIndex }),
    );
    assert.equal(getParagraphLocateSearchRunCount(), before + 1);
    assert.isUndefined(
      locateParagraphCitationOnPageText({ citation: record, sourceIndex }),
    );
    assert.equal(getParagraphLocateSearchRunCount(), before + 1, "cached");
    // A warm that adds a page changes the fingerprint set key and re-searches.
    const grown = buildQuoteSourceIndex({
      quoteCitations: [],
      sourceTexts: [pageSource(PAGE_FILLER, 0), pageSource(PASSAGE, 1)],
    });
    const found = locateParagraphCitationOnPageText({
      citation: record,
      sourceIndex: grown,
    });
    assert.isDefined(found);
    assert.equal(getParagraphLocateSearchRunCount(), before + 2);
  });

  it("drops a partial location the cached page text does not contain", function () {
    const record = paragraphRecord();
    const forged: QuoteCitation = {
      ...record,
      sourceMatchKind: "raw-prefix",
      sourceMatchSource: "pdf-page-text",
      sourceMatchText: PASSAGE,
      sourceFingerprint: "page-text:fixture-212",
      pageHintIndex: 1,
      sourceMatchPageOccurrence: 0,
    };
    assert.isTrue(hasVerifiedQuoteLocation(forged));
    const sourceIndex = buildQuoteSourceIndex({
      quoteCitations: [],
      sourceTexts: [pageSource(PAGE_FILLER, 0), pageSource(PAGE_FILLER, 1)],
    });
    assert.isFalse(
      hasVerifiedQuoteLocation(recheckPartialPageLocation(forged, sourceIndex)),
    );
    const noPages = buildQuoteSourceIndex({
      quoteCitations: [],
      sourceTexts: [],
    });
    assert.strictEqual(recheckPartialPageLocation(forged, noPages), forged);
  });
});

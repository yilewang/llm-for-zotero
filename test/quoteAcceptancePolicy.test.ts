import { assert } from "chai";
import {
  buildQuoteSourceIndex,
  buildQuoteCitation,
  classifyDisplayedQuoteSource,
  finalizeAssistantQuoteCitations,
} from "../src/services/quotes/quoteCitations";
import { buildQuoteRenderPlan } from "../src/modules/contextPanel/quoteRenderPlan";
import { resolveQuoteCitationLookupText } from "../src/modules/contextPanel/quoteNavigationText";
import { resolvePageNativeFindControllerQuery } from "../src/services/pdf/livePdfSelectionLocator";
import {
  ALTERED_QUOTE_ACCEPTANCE_CASES,
  CITATION_MARKER_QUOTE_CASES,
  COHEN_QUOTE,
  COHEN_READER_TEXT,
  COHEN_WORKER_TEXT,
  GENUINE_QUOTE_ACCEPTANCE_CASES,
} from "./fixtures/quoteAcceptance";

function sourceIndex(text: string, secondSource?: string) {
  return buildQuoteSourceIndex({
    sourceTexts: [text, ...(secondSource ? [secondSource] : [])].map(
      (sourceText, i) => ({
        sourceText,
        sourceLabel: `(Source ${i + 1}, 2026)`,
        sourceMatchSource: "pdf-page-text" as const,
        itemId: 100 + i,
        contextItemId: 200 + i,
        pageHintIndex: 5,
        sourceFingerprint: `pdfjs:acceptance-${i}`,
      }),
    ),
  });
}

describe("quote acceptance from strong passage evidence", function () {
  for (const fixture of CITATION_MARKER_QUOTE_CASES) {
    it(`renders and locates the complete ${fixture.name}`, function () {
      const markdown = `> ${fixture.quote}\n> (Source 1, 2026)`;
      const finalized = finalizeAssistantQuoteCitations({
        markdown,
        sourceIndex: sourceIndex(fixture.source),
        quoteSourceReview: { sourceEvidenceComplete: true },
      });
      const plan = buildQuoteRenderPlan(finalized);
      assert.lengthOf(plan.occurrences, 1);
      assert.equal(plan.occurrences[0].trust, "trusted-anchor");
      assert.equal(plan.occurrences[0].displayText, fixture.quote);
      const query = resolvePageNativeFindControllerQuery(
        fixture.source,
        resolveQuoteCitationLookupText(finalized.quoteCitations[0]),
      );
      assert.isNotNull(query);
      assert.equal(query!.totalOccurrences, 1);
      for (const altered of [
        fixture.quote.replace("will implicitly", "will not implicitly"),
        fixture.quote.replace("two tokens", "three tokens"),
        fixture.quote.replace("relative distance", "relative"),
        fixture.quote.replace("vector computation", "vector computation 138"),
      ]) {
        assert.notEqual(
          classifyDisplayedQuoteSource({
            quoteText: altered,
            sourceIndex: sourceIndex(fixture.source),
            sourceEvidenceComplete: true,
          }).kind,
          "matched",
          altered,
        );
      }
      assert.equal(
        classifyDisplayedQuoteSource({
          quoteText: fixture.quote,
          sourceIndex: sourceIndex(fixture.source, fixture.source),
          sourceEvidenceComplete: true,
        }).kind,
        "defer",
      );
    });
  }

  for (const fixture of GENUINE_QUOTE_ACCEPTANCE_CASES) {
    it(`accepts ${fixture.name} without a second extraction`, function () {
      const result = classifyDisplayedQuoteSource({
        quoteText: fixture.quote,
        sourceIndex: sourceIndex(fixture.source),
        sourceEvidenceComplete: true,
      });
      assert.equal(result.kind, "matched", JSON.stringify(result));
      if (result.kind !== "matched") return;
      assert.equal(result.quoteCitations[0].quoteText, fixture.quote);
      assert.equal(result.quoteCitations[0].contextItemId, 200);
      assert.equal(result.quoteCitations[0].pageHintIndex, 5);
    });
  }

  for (const fixture of ALTERED_QUOTE_ACCEPTANCE_CASES) {
    it(`does not authenticate ${fixture.name} from its shared anchor`, function () {
      const result = classifyDisplayedQuoteSource({
        quoteText: fixture.quote,
        sourceIndex: sourceIndex(fixture.source),
        sourceEvidenceComplete: true,
      });
      assert.notEqual(result.kind, "matched");
    });
  }

  it("keeps two possible source identities unresolved", function () {
    const result = classifyDisplayedQuoteSource({
      quoteText: COHEN_QUOTE,
      sourceIndex: sourceIndex(COHEN_WORKER_TEXT, COHEN_WORKER_TEXT),
      sourceEvidenceComplete: true,
    });
    assert.equal(result.kind, "defer");
  });

  it("does not turn ambiguous same-paper anchors into proof that the quote is absent", function () {
    const index = buildQuoteSourceIndex({
      sourceTexts: [
        COHEN_WORKER_TEXT.replace("9.41", "8.17"),
        COHEN_WORKER_TEXT,
      ].map((sourceText, pageHintIndex) => ({
        sourceText,
        sourceLabel: "(Source, 2026)",
        sourceMatchSource: "pdf-page-text" as const,
        itemId: 100,
        contextItemId: 200,
        pageHintIndex,
      })),
    });
    const result = classifyDisplayedQuoteSource({
      quoteText: COHEN_QUOTE,
      sourceIndex: index,
      sourceEvidenceComplete: true,
    });
    assert.notEqual(result.kind, "absent");
  });

  it("renders a historical quote as one source card with a native searchable locator", function () {
    const markdown = `> ${COHEN_QUOTE}\n\n(Source 1, 2026)`;
    const finalized = finalizeAssistantQuoteCitations({
      markdown,
      sourceIndex: sourceIndex(COHEN_WORKER_TEXT),
      quoteSourceReview: { sourceEvidenceComplete: true },
    });
    const plan = buildQuoteRenderPlan(finalized);
    assert.lengthOf(plan.occurrences, 1);
    assert.equal(plan.occurrences[0].trust, "trusted-anchor");
    assert.equal(plan.occurrences[0].displayText, COHEN_QUOTE);
    assert.lengthOf(finalized.quoteCitations, 1);
    const query = resolvePageNativeFindControllerQuery(
      COHEN_READER_TEXT,
      resolveQuoteCitationLookupText(finalized.quoteCitations[0]),
    );
    assert.isNotNull(query);
    assert.include(query!.query, "reward level by age");
    assert.equal(query!.totalOccurrences, 1);
    assert.equal(markdown, `> ${COHEN_QUOTE}\n\n(Source 1, 2026)`);
  });

  it("repairs a wrong adjacent marker within the same source without adding its unrelated sentence", function () {
    const unrelated =
      "We next examined neural pattern similarity in our primary region of interest, the aHC.";
    const citation = buildQuoteCitation({
      id: "Q_wrong_sentence",
      quoteText: unrelated,
      sourceMatchText: unrelated,
      sourceMatchKind: "exact",
      sourceMatchSource: "context-text",
      sourceFingerprint: "old-extraction",
      citationLabel: "(Source 1, 2026)",
      itemId: 100,
      contextItemId: 200,
    })!;
    const markdown = `> ${COHEN_QUOTE}\n[[quote:${citation.id}]]`;
    const finalized = finalizeAssistantQuoteCitations({
      markdown,
      quoteCitations: [citation],
      sourceIndex: sourceIndex(`${unrelated} ${COHEN_WORKER_TEXT}`),
      quoteSourceReview: { sourceEvidenceComplete: true },
    });
    const plan = buildQuoteRenderPlan(finalized);
    assert.lengthOf(plan.occurrences, 1);
    assert.equal(plan.occurrences[0].displayText, COHEN_QUOTE);
    assert.equal(plan.occurrences[0].trust, "trusted-anchor");
    assert.equal(citation.quoteText, unrelated);
  });
});

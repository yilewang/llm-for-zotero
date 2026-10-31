import { assert } from "chai";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";
import { applyAssistantMessageQuoteGate } from "../src/modules/contextPanel/quoteValidation/gate";
import { getMessageQuoteDisplay } from "../src/modules/contextPanel/quoteRenderPlan";
import { clearPageTextCache } from "../src/services/pdf/livePdfSelectionLocator";
import type { Message } from "../src/modules/contextPanel/types";
import type { QuoteSourceText } from "../src/services/quotes/quoteCitations";

/**
 * An abstract-kind citation names an item: the answer-time quote check reads
 * that item's Zotero abstract field as evidence, natively, so a quote from the
 * abstract keeps its id when the PDF differs from the record or there is no
 * PDF, and a quote the field does not hold is still refused.
 */

const LABEL = "(Example et al., 2024)";
const ITEM_ID = 11;
const CONTEXT_ITEM_ID = 12;
const ABSTRACT =
  "We recorded hippocampal place cells across seven days and found that CA1 representations drifted gradually while CA3 maps stayed stable, suggesting distinct roles for the two subfields in memory consolidation and pattern separation over long time scales.";
const FABRICATED =
  "Across thirty animals we found that dentate gyrus granule cells were silenced by optogenetic stimulation during every learning trial of the task.";
const PAGE =
  "Introduction. The hippocampus supports episodic memory. Place cells fire in specific locations. Here we recorded CA1 and CA3 ensembles for one week using calcium imaging in freely moving mice and quantified drift of spatial tuning.";

function citation(quoteText: string) {
  // The record's own text is the model-facing quote; it is not evidence.
  return buildQuoteCitation({
    quoteText,
    sourceMatchKind: "exact",
    sourceMatchSource: "context-text",
    citationLabel: LABEL,
    sourceSectionLabel: "Abstract",
    sourceChunkKind: "abstract",
    contextItemId: CONTEXT_ITEM_ID,
    itemId: ITEM_ID,
    allowShortQuoteText: true,
  })!;
}

function pageSource(text: string): QuoteSourceText {
  return {
    sourceText: text,
    sourceLabel: LABEL,
    contextItemId: CONTEXT_ITEM_ID,
    itemId: ITEM_ID,
    sourceMatchSource: "pdf-page-text",
    sourceFingerprint: "page-text:fixture-12",
    requiresPageHint: true,
    pageHintIndex: 0,
    pageHintLabel: "1",
  };
}

async function gate(params: {
  quoteText: string;
  sourceTexts: QuoteSourceText[];
  complete?: boolean;
  // Two papers in scope require body evidence, as a collection scope does.
  twoPapers?: boolean;
}) {
  const record = citation(params.quoteText);
  const message: Message = {
    role: "assistant",
    text: `Overview: drift differs. [[quote:${record.id}]]`,
    timestamp: 1,
    quoteCitations: [record],
  };
  const paper = (itemId: number, contextItemId: number) => ({
    itemId,
    contextItemId,
    title: `Paper ${itemId}`,
  });
  await applyAssistantMessageQuoteGate(
    message,
    message.text,
    message.quoteCitations,
    { sourceTexts: params.sourceTexts, complete: params.complete ?? true },
    params.twoPapers === false
      ? {}
      : {
          pairedUserMessage: {
            role: "user",
            text: "Compare the abstracts",
            timestamp: 0,
            paperContexts: [paper(ITEM_ID, CONTEXT_ITEM_ID), paper(21, 22)],
          } as Message,
        },
  );
  const display = getMessageQuoteDisplay(message);
  return {
    kept: (display.quoteCitations || []).some(
      (entry) => entry.id === record.id,
    ),
    markdown: display.markdown,
  };
}

describe("quote check with the Zotero abstract field as evidence", function () {
  const globals = globalThis as unknown as { Zotero?: unknown };
  let previousZotero: unknown;
  let abstractNote = ABSTRACT;

  beforeEach(function () {
    previousZotero = globals.Zotero;
    abstractNote = ABSTRACT;
    globals.Zotero = {
      Items: {
        get: (id: number) =>
          id === ITEM_ID
            ? {
                id,
                isRegularItem: () => true,
                isAttachment: () => false,
                getField: (field: string) =>
                  field === "abstractNote" ? abstractNote : "",
              }
            : { id, isRegularItem: () => true, getField: () => "" },
      },
    };
  });

  afterEach(function () {
    globals.Zotero = previousZotero;
    clearPageTextCache();
  });

  it("keeps an abstract quote when the PDF's page differs from the Zotero abstract", async function () {
    const result = await gate({
      quoteText: ABSTRACT,
      sourceTexts: [pageSource(PAGE)],
    });
    assert.isTrue(result.kept, result.markdown);
    assert.notInclude(result.markdown, "Not a source quote");
  });

  it("keeps an abstract quote of an item with no PDF", async function () {
    const result = await gate({ quoteText: ABSTRACT, sourceTexts: [] });
    assert.isTrue(result.kept, result.markdown);
    assert.notInclude(result.markdown, "Not a source quote");
  });

  it("keeps it when the PDF evidence is incomplete", async function () {
    const result = await gate({
      quoteText: ABSTRACT,
      sourceTexts: [pageSource(PAGE)],
      complete: false,
    });
    assert.isTrue(result.kept, result.markdown);
  });

  it("keeps an abstract quote for a single paper too", async function () {
    const result = await gate({
      quoteText: ABSTRACT,
      sourceTexts: [pageSource(PAGE)],
      twoPapers: false,
    });
    assert.isTrue(result.kept, result.markdown);
  });

  it("still refuses an abstract quote that the Zotero abstract does not hold", async function () {
    const result = await gate({
      quoteText: FABRICATED,
      sourceTexts: [pageSource(PAGE)],
    });
    assert.isFalse(result.kept, result.markdown);
    assert.include(result.markdown, "Not a source quote");
    const noPdf = await gate({ quoteText: FABRICATED, sourceTexts: [] });
    assert.isFalse(noPdf.kept, noPdf.markdown);
  });

  it("refuses the quote when the item has no abstract field to check it against", async function () {
    abstractNote = "";
    const result = await gate({ quoteText: ABSTRACT, sourceTexts: [] });
    assert.isFalse(result.kept, result.markdown);
  });
});

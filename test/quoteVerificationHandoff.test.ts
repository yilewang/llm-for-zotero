import { assert } from "chai";
import { WAGLE_QUOTE_PAGE_ITEMS } from "./fixtures/wagleQuotePage";
import {
  buildQuoteCitation,
  buildQuoteSecondaryEvidenceKey,
  hasVerifiedQuoteLocation,
  type QuoteSourceText,
} from "../src/services/quotes/quoteCitations";
import { applyAssistantMessageQuoteGate } from "../src/modules/contextPanel/quoteValidation/gate";
import {
  buildQuoteRenderPlan,
  getMessageQuoteDisplay,
} from "../src/modules/contextPanel/quoteRenderPlan";
import {
  clearPageTextCache,
  verifyCompleteQuoteInLivePdfJs,
} from "../src/services/pdf/livePdfSelectionLocator";
import { assistantMarkdownNeedsBackgroundQuoteSearch } from "../src/modules/contextPanel/quoteValidation/sourceEvidence";
import type { Message } from "../src/modules/contextPanel/types";

const wagleQuote =
  "A transient increase in the intrinsic excitability of recruited ACC neurons counteracted this instability by promoting repeated reactivation during an early consolidation window, stabilizing cortical ensemble membership without preventing hippocampal drift.";
const wagleWorkerText =
  "11 circuit, hippocampal input recruited ACC neurons but also propagated hippocampal variability into cortex, 12 destabilizing the emerging cortical engram and impairing memory expression. A transient increase in the 13 intrinsic excitability of recruited ACC neurons counteracted this instability by promoting repeated reacti14 vation during an early consolidation window, stabilizing cortical ensemble membership without preventing 15 hippocampal drift. Simulated erasure of learning-induced potentiation further reproduced the early depen16 dence of memory on hippocampal, but not ACC, plasticity.";
const deitchQuote =
  "Gradual changes in both cells' acitivty rates and tuning over minutes-days.";

function source(sourceText: string, pdf = true): QuoteSourceText {
  return {
    sourceText,
    sourceLabel: "(Fixture, 2026)",
    contextItemId: 212,
    itemId: 57,
    sourceMatchSource: pdf ? "pdf-page-text" : "context-text",
    sourceFingerprint: pdf ? "page-text:fixture" : "mineru:fixture",
    requiresPageHint: true,
    pageHintIndex: pdf ? 0 : undefined,
  };
}

function registeredMessage(quoteText: string, manualQuote = false): Message {
  const citation = buildQuoteCitation({
    quoteText,
    citationLabel: "(Fixture, 2026)",
    contextItemId: 212,
    itemId: 57,
    sourceMatchText: quoteText,
    sourceMatchKind: "exact",
    sourceMatchSource: "context-text",
  })!;
  return {
    role: "assistant",
    text: `${manualQuote ? `> ${quoteText}\n\n` : ""}[[quote:${citation.id}]]`,
    timestamp: 1,
    quoteCitations: [citation],
  };
}

function occurrences(message: Message) {
  return buildQuoteRenderPlan(getMessageQuoteDisplay(message)).occurrences;
}

describe("quote verification through display handoff", function () {
  afterEach(function () {
    clearPageTextCache();
  });

  it("does not reuse a location certificate for different displayed wording", function () {
    const citation = buildQuoteCitation({
      quoteText:
        "Population relationships remain stable over time despite representational drift.",
      displayQuoteText:
        "Population relationships collapse completely over time despite representational drift.",
      citationLabel: "(Fixture, 2026)",
      contextItemId: 212,
      sourceMatchText:
        "Population relationships remain stable over time despite representational drift.",
      sourceMatchKind: "exact",
      sourceMatchSource: "pdf-page-text",
      sourceFingerprint: "pdf:fixture",
      pageHintIndex: 0,
      sourceMatchPageOccurrence: 0,
    })!;
    assert.isFalse(hasVerifiedQuoteLocation(citation));
  });

  it("retains a complete normalized PDF match through the Wagle card gate", async function () {
    const reader = {
      _item: { id: 212 },
      _iframeWindow: {
        PDFViewerApplication: {
          pdfDocument: {
            numPages: 1,
            fingerprints: ["wagle-handoff"],
            getPage: async () => ({
              getTextContent: async () => ({
                items: WAGLE_QUOTE_PAGE_ITEMS,
              }),
            }),
          },
        },
      },
    };
    const verification = await verifyCompleteQuoteInLivePdfJs(
      reader,
      212,
      wagleQuote,
    );
    assert.equal(verification.status, "matched");
    if (verification.status !== "matched") throw new Error("PDF did not match");
    assert.equal(verification.certificate.sourceMatchKind, "normalized-span");
    const message: Message = {
      role: "assistant",
      text: `> ${wagleQuote}\n> (Fixture, 2026)`,
      timestamp: 1,
    };
    await applyAssistantMessageQuoteGate(
      message,
      message.text,
      undefined,
      { sourceTexts: [source(wagleWorkerText)], complete: true },
      {},
      undefined,
      [
        {
          quoteKey: buildQuoteSecondaryEvidenceKey(wagleQuote),
          contextItemId: 212,
          ...verification,
        },
      ],
    );
    assert.notInclude(
      getMessageQuoteDisplay(message).markdown,
      "Not a source quote",
    );
    assert.lengthOf(occurrences(message), 1);
    assert.equal(occurrences(message)[0].trust, "trusted-anchor");
    assert.equal(occurrences(message)[0].pageHintIndex, 0);
  });

  for (const manualQuote of [false, true]) {
    it(`keeps Deitch OCR visible but unresolved with ${manualQuote ? "manual text and an" : "a standalone"} anchor`, async function () {
      const message = registeredMessage(deitchQuote, manualQuote);
      const original = JSON.stringify(message);
      assert.equal(occurrences(message)[0].trust, "unverified-source-label");
      assert.isTrue(
        assistantMarkdownNeedsBackgroundQuoteSearch(
          message.text,
          message.quoteCitations,
        ),
      );
      await applyAssistantMessageQuoteGate(
        message,
        message.text,
        message.quoteCitations,
        {
          sourceTexts: [
            source(
              "The visual cortex exhibits representational drift over minutes to days.",
            ),
            source(deitchQuote, false),
          ],
          complete: true,
        },
        {},
        undefined,
        [
          {
            quoteKey: buildQuoteSecondaryEvidenceKey(deitchQuote),
            contextItemId: 212,
            status: "literal-not-found",
            documentFingerprint: "deitch-handoff",
          },
        ],
      );
      assert.notInclude(
        getMessageQuoteDisplay(message).markdown,
        "Not a source quote",
      );
      assert.lengthOf(occurrences(message), 1);
      assert.equal(occurrences(message)[0].displayText, deitchQuote);
      assert.notInclude(
        ["trusted-anchor", "verified-source"],
        occurrences(message)[0].trust,
      );
      const { quoteDisplayOverride: _display, ...stored } = message;
      assert.equal(
        JSON.stringify(stored),
        original,
        "stored history is untouched",
      );
    });
  }

  it("does not let an invented registered quote authenticate itself", async function () {
    const message = registeredMessage(
      "Every neuron was replaced overnight and visual perception immediately vanished.",
    );
    await applyAssistantMessageQuoteGate(
      message,
      message.text,
      message.quoteCitations,
      {
        sourceTexts: [
          source(
            "Population relationships remain stable over time despite representational drift.",
          ),
        ],
        complete: true,
      },
      {},
    );
    assert.equal(occurrences(message)[0].trust, "not-source-quote");
  });

  it("publishes new verification metadata even when the quote marker does not change", async function () {
    const quote =
      "The neuronal population maintained a stable representation across all recording sessions.";
    const message = registeredMessage(quote);
    const changed = await applyAssistantMessageQuoteGate(
      message,
      message.text,
      message.quoteCitations,
      {
        sourceTexts: [source(quote)],
        complete: true,
      },
      {},
    );
    assert.isTrue(changed);
    assert.equal(getMessageQuoteDisplay(message).markdown, message.text);
    assert.equal(occurrences(message)[0].pageHintIndex, 0);
    assert.equal(occurrences(message)[0].trust, "trusted-anchor");
  });

  it("rechecks changed displayed wording instead of reusing a cached decision", async function () {
    const quote =
      "The neuronal population maintained a stable representation across all recording sessions.";
    const message = registeredMessage(quote);
    const evidence = { sourceTexts: [source(quote)], complete: true };
    await applyAssistantMessageQuoteGate(
      message,
      message.text,
      message.quoteCitations,
      evidence,
      {},
    );
    assert.equal(occurrences(message)[0].trust, "trusted-anchor");
    message.quoteCitations![0].displayQuoteText =
      "Every neuron was replaced overnight and visual perception immediately vanished.";
    await applyAssistantMessageQuoteGate(
      message,
      message.text,
      message.quoteCitations,
      evidence,
      {},
    );
    assert.equal(occurrences(message)[0].trust, "not-source-quote");
  });

  for (const scenario of ["locator-only", "other-attachment"] as const) {
    it(`does not use a ${scenario} certificate as full quote proof`, async function () {
      const message: Message = {
        role: "assistant",
        text: `> ${wagleQuote}\n> (Fixture, 2026)`,
        timestamp: 1,
      };
      await applyAssistantMessageQuoteGate(
        message,
        message.text,
        undefined,
        { sourceTexts: [source(wagleWorkerText)], complete: true },
        {},
        undefined,
        [
          {
            quoteKey: buildQuoteSecondaryEvidenceKey(wagleQuote),
            contextItemId: scenario === "other-attachment" ? 213 : 212,
            status: "matched",
            certificate: {
              documentFingerprint: "wagle-scope-control",
              pageIndex: 0,
              sourceMatchText: wagleQuote,
              sourceMatchKind: "normalized-span",
              verificationMode:
                scenario === "locator-only"
                  ? "inline-math-locator"
                  : "complete-quote",
              sourceMatchPageOccurrence: 0,
            },
          },
        ],
      );
      assert.notInclude(
        ["trusted-anchor", "verified-source"],
        occurrences(message)[0].trust,
      );
    });
  }
});

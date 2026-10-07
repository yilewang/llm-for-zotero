import { assert } from "chai";
import {
  SELECTED_TEXT_ANCHOR_MAX_CHARS,
  SELECTED_TEXT_ANCHORS_MAX_TOTAL_CHARS,
  resolveSelectedTextAnchorsFromTextSources,
} from "../src/modules/contextPanel/selectedTextAnchors";
import type { SelectedTextContext } from "../src/shared/types";

function pdfSelection(
  text: string,
  contextItemId: number,
  pageIndex?: number,
  pageLabel?: string,
): SelectedTextContext {
  return {
    text,
    source: "pdf",
    contextItemId,
    pageIndex,
    pageLabel,
  };
}

describe("selected text anchors", function () {
  it("resolves a high-page-number highlight to its chunk and neighbors", function () {
    const quote = "The high page result is uniquely identifiable.";
    const anchors = resolveSelectedTextAnchorsFromTextSources({
      selectedTextContexts: [pdfSelection(quote, 91, 587, "588")],
      sources: {
        91: {
          chunks: [
            "Earlier local context.",
            `Result section. ${quote} More selected evidence.`,
            "Following local context.",
          ],
          pages: [
            {
              pageIndex: 587,
              pageLabel: "588",
              text: `Page heading. ${quote} More selected evidence.`,
            },
          ],
          sourceType: "zotero",
        },
      },
    });

    assert.equal(anchors[0]?.resolution, "chunks");
    assert.equal(anchors[0]?.pageIndex, 587);
    assert.equal(anchors[0]?.pageLabel, "588");
    assert.equal(anchors[0]?.primaryChunkIndex, 1);
    assert.deepEqual(anchors[0]?.preferredChunkIndexes, [0, 1, 2]);
    assert.include(anchors[0]?.contextText || "", "Earlier local context");
    assert.include(anchors[0]?.contextText || "", quote);
    assert.include(anchors[0]?.contextText || "", "Following local context");
  });

  it("leaves the anchor's page label empty when neither the selection nor the page has one (D5)", function () {
    const quote = "The unlabelled page result is uniquely identifiable.";
    const anchors = resolveSelectedTextAnchorsFromTextSources({
      selectedTextContexts: [pdfSelection(quote, 91, 4)],
      sources: {
        91: {
          chunks: [`Result section. ${quote} More selected evidence.`],
          pages: [
            {
              pageIndex: 4,
              text: `Page heading. ${quote} More selected evidence.`,
            },
          ],
          sourceType: "zotero",
        },
      },
    });

    assert.equal(anchors[0]?.pageIndex, 4);
    // Was "5", guessed from the page index.
    assert.isUndefined(anchors[0]?.pageLabel);
  });

  it("disambiguates repeated quotes using the selected page text", function () {
    const quote = "Repeated result sentence.";
    const anchors = resolveSelectedTextAnchorsFromTextSources({
      selectedTextContexts: [pdfSelection(quote, 92, 7, "8")],
      sources: {
        92: {
          chunks: [
            `Introduction vocabulary. ${quote} General motivation.`,
            "Unrelated bridge.",
            `Distinctive selected-page terminology. ${quote} Outcome details.`,
          ],
          pages: [
            {
              pageIndex: 7,
              text: `Distinctive selected-page terminology. ${quote} Outcome details.`,
            },
          ],
        },
      },
    });

    assert.equal(anchors[0]?.primaryChunkIndex, 2);
    assert.deepEqual(anchors[0]?.preferredChunkIndexes, [1, 2]);
  });

  it("keeps both chunks when a quote spans a chunk boundary", function () {
    const quote =
      "boundary phrase begins with alpha beta and continues gamma delta epsilon zeta";
    const anchors = resolveSelectedTextAnchorsFromTextSources({
      selectedTextContexts: [pdfSelection(quote, 93)],
      sources: {
        93: {
          chunks: [
            "Context before the boundary phrase begins with alpha beta and continues",
            "gamma delta epsilon zeta with substantially more gamma delta evidence.",
            "Context after the boundary.",
          ],
        },
      },
    });

    assert.equal(anchors[0]?.resolution, "chunks");
    assert.includeMembers(anchors[0]?.preferredChunkIndexes || [], [0, 1]);
  });

  it("uses verified page text when a short repeated quote cannot map confidently", function () {
    const quote = "short phrase";
    const pageText = `Page-specific lead. ${quote}. Page-specific tail.`;
    const anchors = resolveSelectedTextAnchorsFromTextSources({
      selectedTextContexts: [pdfSelection(quote, 94, 3, "iv")],
      sources: {
        94: {
          chunks: [
            `First occurrence of ${quote}.`,
            "Middle context.",
            `Second occurrence of ${quote}.`,
          ],
          pages: [{ pageIndex: 3, pageLabel: "iv", text: pageText }],
        },
      },
    });

    assert.equal(anchors[0]?.resolution, "page");
    assert.deepEqual(anchors[0]?.preferredChunkIndexes, []);
    assert.include(anchors[0]?.contextText || "", pageText);
  });

  it("uses chunk matching when page text is unavailable", function () {
    const quote = "Unique extraction-only quote with enough detail.";
    const anchors = resolveSelectedTextAnchorsFromTextSources({
      selectedTextContexts: [pdfSelection(quote, 95, 10, "11")],
      sources: {
        95: {
          chunks: [`Before. ${quote} After.`],
        },
      },
    });

    assert.equal(anchors[0]?.resolution, "chunks");
    assert.equal(anchors[0]?.primaryChunkIndex, 0);
  });

  it("emits locator-only metadata when the recorded page contradicts the quote", function () {
    const quote = "Quote found elsewhere in the document.";
    const anchors = resolveSelectedTextAnchorsFromTextSources({
      selectedTextContexts: [pdfSelection(quote, 96, 4, "5")],
      sources: {
        96: {
          chunks: [`Other chunk. ${quote}`],
          pages: [
            {
              pageIndex: 4,
              text: "The recorded page contains unrelated material.",
            },
          ],
        },
      },
    });

    assert.equal(anchors[0]?.resolution, "locator-only");
    assert.isUndefined(anchors[0]?.contextText);
    assert.deepEqual(anchors[0]?.preferredChunkIndexes, []);
  });

  it("recomputes chunk indexes after the source changes", function () {
    const quote = "Stable selected quote across cache revisions.";
    const context = pdfSelection(quote, 97);
    const first = resolveSelectedTextAnchorsFromTextSources({
      selectedTextContexts: [context],
      sources: { 97: { chunks: [`${quote} Old source.`, "Tail."] } },
    });
    const second = resolveSelectedTextAnchorsFromTextSources({
      selectedTextContexts: [context],
      sources: {
        97: { chunks: ["New prefix.", "New middle.", `${quote} New source.`] },
      },
    });

    assert.equal(first[0]?.primaryChunkIndex, 0);
    assert.equal(second[0]?.primaryChunkIndex, 2);
  });

  it("allocates primary chunks fairly and enforces per-anchor and turn caps", function () {
    const quoteA = "PRIMARY-A unique selected quotation";
    const quoteB = "PRIMARY-B unique selected quotation";
    const fill = (label: string) => `${label} ${"detail ".repeat(900)}`;
    const anchors = resolveSelectedTextAnchorsFromTextSources({
      selectedTextContexts: [
        pdfSelection(quoteA, 98),
        pdfSelection(quoteB, 99),
      ],
      sources: {
        98: {
          chunks: [
            fill("A-before"),
            fill(`${quoteA} A-primary`),
            fill("A-after"),
          ],
        },
        99: {
          chunks: [
            fill("B-before"),
            fill(`${quoteB} B-primary`),
            fill("B-after"),
          ],
        },
      },
    });

    assert.lengthOf(anchors, 2);
    assert.include(anchors[0]?.contextText || "", quoteA);
    assert.include(anchors[1]?.contextText || "", quoteB);
    for (const anchor of anchors) {
      assert.isAtMost(anchor.injectedChars, SELECTED_TEXT_ANCHOR_MAX_CHARS);
      assert.isAtMost(anchor.preferredChunkIndexes.length, 3);
    }
    assert.isAtMost(
      anchors.reduce((sum, anchor) => sum + anchor.injectedChars, 0),
      SELECTED_TEXT_ANCHORS_MAX_TOTAL_CHARS,
    );
  });

  it("bounds neighbor promotion at the first and last chunks", function () {
    const firstQuote = "Unique first chunk quote.";
    const lastQuote = "Unique last chunk quote.";
    const anchors = resolveSelectedTextAnchorsFromTextSources({
      selectedTextContexts: [
        pdfSelection(firstQuote, 100),
        pdfSelection(lastQuote, 101),
      ],
      sources: {
        100: { chunks: [firstQuote, "First following context."] },
        101: { chunks: ["Last preceding context.", lastQuote] },
      },
    });

    assert.deepEqual(anchors[0]?.preferredChunkIndexes, [0, 1]);
    assert.deepEqual(anchors[1]?.preferredChunkIndexes, [0, 1]);
  });
});

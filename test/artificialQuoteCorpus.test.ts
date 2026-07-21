import { assert } from "chai";
import {
  buildQuoteSourceIndex,
  finalizeAssistantQuoteCitations,
} from "../src/modules/contextPanel/quoteCitations";
import { buildFindControllerQuoteQueries } from "../src/modules/contextPanel/quoteTextSearch";

const SOURCE_LABEL = "(Synthetic et al., 2026)";
const CONTEXT_ITEM_ID = 1001;
const PAGE_INDEX = 1;
const SYNTHETIC_SOURCE_TEXT = [
  "I have a very good partner as my friend.",
  "He can be modeled as a = alpha + c; the ratio b = B/A stays positive.",
  "He is nice; but not as-good-as my wife.",
  "But he is good.",
  "I want to hang out with him.",
  'The paper includes a nested claim: "friendship can be good without replacing family."',
  "Finally, the T-PHATE style manifold is robust to multi-voxel noise.",
].join(" ");

function syntheticPageSourceIndex() {
  return buildQuoteSourceIndex({
    sourceTexts: [
      {
        sourceText: SYNTHETIC_SOURCE_TEXT,
        sourceLabel: SOURCE_LABEL,
        sourceMatchSource: "pdf-page-text",
        contextItemId: CONTEXT_ITEM_ID,
        itemId: 9001,
        pageHintIndex: PAGE_INDEX,
        sourceFingerprint: "pdfjs:synthetic",
      },
    ],
  });
}

describe("artificial quote corpus exact-grounding behavior", function () {
  it("anchors a complete nested source quote with page provenance", function () {
    const quote =
      'The paper includes a nested claim: "friendship can be good without replacing family."';
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}`,
      sourceIndex: syntheticPageSourceIndex(),
    });

    assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(finalized.quoteCitations[0].quoteText, quote);
    assert.equal(finalized.quoteCitations[0].sourceMatchText, quote);
    assert.equal(finalized.quoteCitations[0].pageHintIndex, PAGE_INDEX);
    assert.equal(finalized.quoteCitations[0].sourceMatchPageOccurrence, 0);
  });

  it("splits ellipsized source text into complete cards in displayed order", function () {
    const first = "I have a very good partner as my friend.";
    const second = "He is nice; but not as-good-as my wife.";
    const third = "But he is good.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${first} [...] ${second} [...] ${third}`,
      sourceIndex: syntheticPageSourceIndex(),
    });

    assert.deepEqual(
      finalized.quoteCitations.map((citation) => citation.quoteText),
      [first, second, third],
    );
    assert.deepEqual(
      finalized.quoteCitations.map((citation) => citation.pageHintIndex),
      [PAGE_INDEX, PAGE_INDEX, PAGE_INDEX],
    );
  });

  it("aligns complete Unicode-hyphen wording without shortening it", function () {
    const quote =
      "Finally, the T‑PHATE style manifold is robust to multi‑voxel noise.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}`,
      sourceIndex: syntheticPageSourceIndex(),
    });

    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(finalized.quoteCitations[0].quoteText, quote);
    assert.equal(finalized.quoteCitations[0].sourceMatchText, quote);
    assert.equal(
      finalized.quoteCitations[0].sourceMatchKind,
      "normalized-span",
    );
  });

  it("repairs a stale author label only when the complete quote is unique", function () {
    const quote = "I have a very good partner as my friend.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}\n\n(Wrong et al., 2026)`,
      sourceIndex: syntheticPageSourceIndex(),
    });

    assert.lengthOf(finalized.quoteCitations, 1);
    assert.equal(finalized.quoteCitations[0].citationLabel, SOURCE_LABEL);
    assert.equal(finalized.quoteCitations[0].quoteText, quote);
  });

  for (const [name, quote] of [
    [
      "invented tail",
      "I have a very good partner as my friend. This sentence was invented by the model.",
    ],
    [
      "unsupported interior wrapper",
      "The assistant starts with unsupported wording. He is nice; but not as-good-as my wife. Then it adds unsupported wording.",
    ],
    ["truncated source word", "I have a very good partner as my frien"],
  ] as const) {
    it(`does not authenticate a quote with an ${name} from a partial source span`, function () {
      const finalized = finalizeAssistantQuoteCitations({
        markdown: `> ${quote}`,
        sourceIndex: syntheticPageSourceIndex(),
      });

      assert.notInclude(finalized.markdown, "[[quote:");
      assert.lengthOf(finalized.quoteCitations, 0);
      assert.include(finalized.markdown, quote);
    });
  }

  it("keeps a complete cross-paper duplicate untrusted", function () {
    const quote = "I have a very good partner as my friend.";
    const finalized = finalizeAssistantQuoteCitations({
      markdown: `> ${quote}`,
      sourceIndex: buildQuoteSourceIndex({
        sourceTexts: [
          {
            sourceText: quote,
            sourceLabel: "(One, 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 1,
            pageHintIndex: 0,
          },
          {
            sourceText: quote,
            sourceLabel: "(Two, 2026)",
            sourceMatchSource: "pdf-page-text",
            contextItemId: 2,
            pageHintIndex: 4,
          },
        ],
      }),
    });

    assert.notInclude(finalized.markdown, "[[quote:");
    assert.isEmpty(finalized.quoteCitations);
  });

  it("builds one complete FindController query from math and list-heavy text", function () {
    const quote =
      "He can be modeled as $a = \\alpha + c$; the ratio $\\mathbf{b} = B/A$ stays positive.";

    assert.deepEqual(buildFindControllerQuoteQueries(quote), [quote]);
  });
});

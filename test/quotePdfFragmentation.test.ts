import { assert } from "chai";
import {
  assessAcademicQuoteAlignment,
  buildQuoteTextIndex,
  findQuoteSourceSpansAllowingLayoutArtifacts,
} from "../src/services/quotes/quoteTextNormalization";
import {
  buildQuoteSourceIndex,
  classifyDisplayedQuoteSource,
} from "../src/services/quotes/quoteCitations";
import { resolvePageNativeFindControllerQuery } from "../src/services/pdf/livePdfSelectionLocator";
import {
  SUMMERFIELD_QUOTE,
  SUMMERFIELD_SOURCE_PREFIX,
  SUMMERFIELD_SIMILARITY_QUOTE,
  SUMMERFIELD_SIMILARITY_READER_TEXT,
} from "./fixtures/quoteAcceptance";

const boundary = "\u0003";

/** Change item segmentation only; preserve every source character and space. */
function fragmentations(text: string): Array<{ name: string; text: string }> {
  const chars = Array.from(text);
  const variants = chars.slice(1).map((_char, index) => ({
    name: `split at character ${index + 1}`,
    text:
      chars.slice(0, index + 1).join("") +
      boundary +
      chars.slice(index + 1).join(""),
  }));
  for (const width of [1, 2, 7, 17]) {
    variants.push({
      name: `items of ${width} characters`,
      text: chars
        .map(
          (char, index) =>
            (index && index % width === 0 ? boundary : "") + char,
        )
        .join(""),
    });
  }
  return variants;
}

function classify(sourceText: string, quoteText: string) {
  return classifyDisplayedQuoteSource({
    quoteText,
    sourceIndex: buildQuoteSourceIndex({
      sourceTexts: [
        {
          sourceText,
          sourceLabel: "(Fixture, 2026)",
          contextItemId: 200,
          itemId: 100,
          sourceMatchSource: "pdf-page-text",
          pageHintIndex: 5,
        },
      ],
    }),
    sourceEvidenceComplete: true,
  }).kind;
}

const proseCases = [
  SUMMERFIELD_SIMILARITY_QUOTE,
  "The neuronal population maintained a stable representation.",
  'The response was described as "stable (across sessions)."',
  "The relation was preserved in every trial ({x →y}).",
  "The relation was preserved in every trial [x →y].",
  "The relation was preserved in every trial (‘x →y’).",
  "The response was measured at 3.14 Hz in 89 neurons.",
  "The stable model predicts $x^{2} + y = z$.",
  "The stable model predicts \\(x^{2} + y = z\\).",
  "The stable model predicts 𝑥 = 𝑦.",
  "The stable model predicts a field of 12 cm².",
  "The ﬁnal analysis confirms a stable repre-\nsentation.",
  "The pneumonoultramicroscopicsilicovolcanoconiosis classification remained stable.",
];

describe("PDF quote matching is invariant to text-item segmentation", function () {
  this.timeout(20000);

  for (const [index, text] of proseCases.entries()) {
    it(`preserves complete matching, literal navigation, and original offsets for passage ${index + 1}`, function () {
      const baseline = resolvePageNativeFindControllerQuery(text, text);
      assert.isNotNull(baseline, "the unfragmented passage matches");
      assert.equal(classify(text, text), "matched");
      for (const variant of fragmentations(text)) {
        const spans = findQuoteSourceSpansAllowingLayoutArtifacts(
          buildQuoteTextIndex(variant.text),
          text,
        );
        assert.lengthOf(spans, 1, variant.name);
        assert.equal(
          spans[0].text.replaceAll(boundary, ""),
          text,
          variant.name,
        );
        assert.equal(
          variant.text.slice(spans[0].sourceStart, spans[0].sourceEnd),
          spans[0].text,
        );
        assert.deepEqual(
          resolvePageNativeFindControllerQuery(variant.text, text),
          baseline,
          variant.name,
        );
        assert.isTrue(
          assessAcademicQuoteAlignment(variant.text, text)
            .allMeaningfulTokensSupported,
          variant.name,
        );
        assert.equal(classify(variant.text, text), "matched", variant.name);
      }
    });
  }

  it("matches the exact native page-6 counterexample through its closing brace and period", function () {
    const query = resolvePageNativeFindControllerQuery(
      SUMMERFIELD_SIMILARITY_READER_TEXT,
      SUMMERFIELD_SIMILARITY_QUOTE,
    );
    assert.isNotNull(query);
    assert.isTrue(query!.query.endsWith("{x →z}."));
    assert.equal(query!.totalOccurrences, 1);
  });

  it("does not replace original PDF positions with a previously sanitized text index", function () {
    const source = fragmentations(proseCases[3]).find(
      (variant) => variant.name === "items of 1 characters",
    )!.text;
    const index = buildQuoteSourceIndex({
      sourceTexts: [
        {
          sourceText: source,
          textIndex: buildQuoteTextIndex(source.replaceAll(boundary, " ")),
          sourceLabel: "(Fixture, 2026)",
        },
      ],
    });
    const spans = findQuoteSourceSpansAllowingLayoutArtifacts(
      index.sources[0].textIndex!,
      proseCases[3],
    );
    assert.lengthOf(spans, 1);
    assert.equal(
      source.slice(spans[0].sourceStart, spans[0].sourceEnd),
      spans[0].text,
    );
    assert.equal(index.sources[0].sourceText, source);
  });

  it("preserves citation-marker tolerance when PDF fragments also split the marker and adjacent words", function () {
    const source =
      SUMMERFIELD_SOURCE_PREFIX +
      SUMMERFIELD_QUOTE.replace("computation and", "computation137 and");
    const baseline = resolvePageNativeFindControllerQuery(
      source,
      SUMMERFIELD_QUOTE,
    );
    assert.isNotNull(baseline);
    for (const variant of fragmentations(source)) {
      assert.deepEqual(
        resolvePageNativeFindControllerQuery(variant.text, SUMMERFIELD_QUOTE),
        baseline,
        variant.name,
      );
      assert.equal(
        classify(variant.text, SUMMERFIELD_QUOTE),
        "matched",
        variant.name,
      );
    }
  });

  it("keeps duplicate occurrences ambiguous under every segmentation", function () {
    const quote = proseCases[3];
    for (const variant of fragmentations(`${quote} ${quote}`)) {
      assert.lengthOf(
        findQuoteSourceSpansAllowingLayoutArtifacts(
          buildQuoteTextIndex(variant.text),
          quote,
        ),
        2,
        variant.name,
      );
      assert.isNull(
        resolvePageNativeFindControllerQuery(variant.text, quote),
        variant.name,
      );
    }
  });

  for (const [source, altered] of [
    [
      "The population did not change after training.",
      "The population did change after training.",
    ],
    [
      "The response was measured at 3.14 Hz in 89 neurons.",
      "The response was measured at 3.14 Hz in 98 neurons.",
    ],
    [
      "The stable model predicts $x^{2} + y = z$.",
      "The stable model predicts $x^{3} + y = z$.",
    ],
    [
      "The stable model predicts $x + y = z$.",
      "The stable model predicts $x - y = z$.",
    ],
    [
      "The response increased during the following trials.",
      "The response increased.",
    ],
  ]) {
    it(`does not authenticate altered wording after segmentation: ${altered}`, function () {
      assert.notEqual(classify(source, altered), "matched");
      for (const variant of fragmentations(source)) {
        assert.notEqual(
          classify(variant.text, altered),
          "matched",
          variant.name,
        );
      }
    });
  }
});

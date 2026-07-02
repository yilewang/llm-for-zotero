import { assert } from "chai";
import {
  buildQuoteSourceIndex,
  finalizeAssistantQuoteCitations,
  replaceQuoteCitationPlaceholdersForMarkdown,
} from "../src/modules/contextPanel/quoteCitations";
import { buildFindControllerQuoteQueries } from "../src/modules/contextPanel/quoteTextSearch";
import { locateQuoteByRawPrefixInPages } from "../src/modules/contextPanel/livePdfSelectionLocator";
import type {
  QuoteCitation,
  QuoteSourceIndex,
} from "../src/modules/contextPanel/types";

const SOURCE_LABEL = "(Synthetic et al., 2026)";
const SYNTHETIC_SOURCE_TEXT = [
  "I have a very good partner as my friend.",
  "He can be modeled as a = alpha + c; the ratio b = B/A stays positive.",
  "He is nice; but not as-good-as my wife.",
  "But he is good.",
  "I want to hang out with him.",
  'The paper includes a nested claim: "friendship can be good without replacing family."',
  "Finally, the T-PHATE style manifold is robust to multi-voxel noise.",
].join(" ");

const SYNTHETIC_PAGES = [
  {
    pageIndex: 0,
    pageLabel: "1",
    text: "Distractor page: partner friend wife. He is good, but there is no source sequence here.",
  },
  {
    pageIndex: 1,
    pageLabel: "2",
    text: SYNTHETIC_SOURCE_TEXT,
  },
  {
    pageIndex: 2,
    pageLabel: "3",
    text: "Math distractor: a = alpha + c and b = B/A, but no partner passage or nested claim.",
  },
];

function syntheticSourceIndex(): QuoteSourceIndex {
  return buildQuoteSourceIndex({
    sourceTexts: [
      {
        sourceText: SYNTHETIC_SOURCE_TEXT,
        sourceLabel: SOURCE_LABEL,
        contextItemId: 1001,
        itemId: 9001,
      },
    ],
  });
}

type AnchoredFixture = {
  name: string;
  markdown: string;
  sourceMatchKinds: NonNullable<QuoteCitation["sourceMatchKind"]>[];
  quoteIncludes: string[];
  quoteExcludes?: string[];
  matchIncludes?: string[];
};

const anchoredFixtures: AnchoredFixture[] = [
  {
    name: "bracketed ellipsis across source fragments",
    markdown:
      "> I have a very good partner as my friend [...] he is nice; but not as-good-as my wife. [...] but he is good.",
    sourceMatchKinds: ["ellipsis-segment"],
    quoteIncludes: [
      "I have a very good partner as my friend",
      "He is nice; but not as-good-as my wife",
    ],
    matchIncludes: ["i have a very good partner"],
  },
  {
    name: "quoted ellipsis fragments with a truncated word",
    markdown:
      '> "I have a very good partner as my friend" ... "he is nice; but not as-good-as my wif" ... "but he is good."',
    sourceMatchKinds: ["ellipsis-segment"],
    quoteIncludes: ["I have a very good partner as my friend"],
    quoteExcludes: ["wif"],
    matchIncludes: ["i have a very good partner"],
  },
  {
    name: "math and ordered-list noise trim to source-backed text",
    markdown:
      "> I have a very good partner as my friend [...] He can be modeled as $a = \\alpha + c$;\n" +
      "> 1. he is nice; but not as-good-as my wife.\n" +
      "> 2. [...] but he is good. $\\mathbf{b} = B/A$\n" +
      "> 3. I want to hangout with him.",
    sourceMatchKinds: ["ellipsis-segment"],
    quoteIncludes: ["I have a very good partner as my friend"],
    quoteExcludes: ["\\mathbf", "hangout"],
    matchIncludes: ["i have a very good partner"],
  },
  {
    name: "noisy acronym prefix still finds an interior source fragment",
    markdown:
      "> T-PHA I have a very good partner as my friend [...] He can be modeled as $a = \\alpha + c$;\n" +
      "> 1. he is nice; but not as-good-as my wife.\n" +
      "> 2. [...] but he is good. $\\mathbf{b} = B/A$\n" +
      "> 3. I want to hangout with him.",
    sourceMatchKinds: ["raw-middle", "progressive"],
    quoteIncludes: ["He is nice; but not as-good-as my wife"],
    quoteExcludes: ["T-PHA", "\\mathbf", "hangout"],
    matchIncludes: ["but not as good as my wife"],
  },
  {
    name: "nested quote inside the paper quote",
    markdown:
      '> The paper includes a nested claim: "friendship can be good without replacing family."',
    sourceMatchKinds: ["exact"],
    quoteIncludes: ['"friendship can be good without replacing family."'],
    matchIncludes: ["nested claim friendship"],
  },
  {
    name: "unicode hyphen and punctuation drift",
    markdown:
      "> Finally, the T‑PHATE style manifold is robust to multi‑voxel noise.",
    sourceMatchKinds: ["exact", "normalized-span"],
    quoteIncludes: ["T-PHATE style manifold"],
    matchIncludes: ["t phate style manifold"],
  },
  {
    name: "invented tail is trimmed before becoming trusted quote text",
    markdown:
      "> I have a very good partner as my friend. He is nice; but not as-good-as my wife. This sentence was invented by the model.",
    sourceMatchKinds: ["raw-prefix", "progressive"],
    quoteIncludes: ["I have a very good partner as my friend"],
    quoteExcludes: ["invented by the model"],
    matchIncludes: ["i have a very good partner"],
  },
  {
    name: "wrong source label repairs to the unique source text",
    markdown:
      "> I have a very good partner as my friend.\n\n(Wrong et al., 2026)",
    sourceMatchKinds: ["exact"],
    quoteIncludes: ["I have a very good partner as my friend"],
    matchIncludes: ["i have a very good partner"],
  },
];

type UnanchoredFixture = {
  name: string;
  markdown: string;
  sourceIndex: QuoteSourceIndex;
};

const unanchoredFixtures: UnanchoredFixture[] = [
  {
    name: "same quote fragment appears in two sources",
    markdown:
      "> I have a very good partner as my friend. He is nice; but not as-good-as my wife.",
    sourceIndex: buildQuoteSourceIndex({
      sourceTexts: [
        {
          sourceText:
            "I have a very good partner as my friend. He is nice; but not as-good-as my wife.",
          sourceLabel: "(One, 2026)",
          contextItemId: 1,
        },
        {
          sourceText:
            "I have a very good partner as my friend. He is nice; but not as-good-as my wife.",
          sourceLabel: "(Two, 2026)",
          contextItemId: 2,
        },
      ],
    }),
  },
  {
    name: "only a tiny snippet matches",
    markdown:
      "> But he is good. The rest of this statement is not in the source text and should not be trusted.",
    sourceIndex: syntheticSourceIndex(),
  },
];

describe("artificial quote corpus two-layer behavior", function () {
  for (const fixture of anchoredFixtures) {
    it(`anchors and resolves: ${fixture.name}`, function () {
      const finalized = finalizeAssistantQuoteCitations({
        markdown: fixture.markdown,
        sourceIndex: syntheticSourceIndex(),
      });

      assert.match(finalized.markdown, /\[\[quote:Q_[a-z0-9]+\]\]/);
      assert.lengthOf(finalized.quoteCitations, 1);

      const citation = finalized.quoteCitations[0];
      assert.equal(citation.citationLabel, SOURCE_LABEL);
      assert.include(
        fixture.sourceMatchKinds,
        citation.sourceMatchKind,
        JSON.stringify(citation, null, 2),
      );

      for (const expected of fixture.quoteIncludes) {
        assert.include(citation.quoteText, expected);
      }
      for (const forbidden of fixture.quoteExcludes || []) {
        assert.notInclude(citation.quoteText, forbidden);
        assert.notInclude(
          replaceQuoteCitationPlaceholdersForMarkdown(
            finalized.markdown,
            finalized.quoteCitations,
          ),
          forbidden,
        );
      }
      for (const expected of fixture.matchIncludes || []) {
        assert.include(citation.sourceMatchText || "", expected);
      }

      const lookupText = citation.sourceMatchText || citation.quoteText;
      const located = locateQuoteByRawPrefixInPages(
        SYNTHETIC_PAGES,
        lookupText,
        null,
      );

      assert.isNotNull(located, lookupText);
      assert.equal(located!.status, "resolved");
      assert.equal(located!.computedPageIndex, 1);
      assert.notEqual(located!.computedPageIndex, 0);
      assert.notEqual(located!.computedPageIndex, 2);
    });
  }

  for (const fixture of unanchoredFixtures) {
    it(`keeps untrusted quote unanchored: ${fixture.name}`, function () {
      const finalized = finalizeAssistantQuoteCitations({
        markdown: fixture.markdown,
        sourceIndex: fixture.sourceIndex,
      });

      assert.notInclude(finalized.markdown, "[[quote:");
      assert.lengthOf(finalized.quoteCitations, 0);
    });
  }

  it("keeps duplicate page matches unresolved in layer two", function () {
    const duplicatedPages = [
      {
        pageIndex: 0,
        pageLabel: "1",
        text: "I have a very good partner as my friend. He is nice; but not as-good-as my wife.",
      },
      {
        pageIndex: 1,
        pageLabel: "2",
        text: "I have a very good partner as my friend. He is nice; but not as-good-as my wife.",
      },
    ];

    const located = locateQuoteByRawPrefixInPages(
      duplicatedPages,
      "I have a very good partner as my friend.",
      null,
    );

    assert.isNull(located);
  });

  it("builds usable reader queries from math and list-heavy quote text", function () {
    const queries = buildFindControllerQuoteQueries(
      "T-PHA I have a very good partner as my friend [...] He can be modeled as $a = \\alpha + c$;\n" +
        "1. he is nice; but not as-good-as my wife.\n" +
        "2. [...] but he is good. $\\mathbf{b} = B/A$\n" +
        "3. I want to hangout with him.",
      { maxQueries: 20 },
    );
    const debug = queries.join("\n");

    assert.isTrue(
      queries.some((query) => query.includes("not as good as my wife")),
      debug,
    );
    assert.isTrue(
      queries.some((query) => query.includes("\\mathbf{b} = B/A")),
      debug,
    );
    assert.isTrue(
      queries.some((query) =>
        query.includes("T-PHA I have a very good partner"),
      ),
      debug,
    );
  });
});

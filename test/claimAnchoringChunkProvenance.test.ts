import { assert } from "chai";
import { reanchorQuoteCitationsToClaims } from "../src/services/quotes/claimAnchoring";
import {
  buildQuoteCitation,
  buildQuoteSourceIndex,
  resolveExactDisplayedQuoteCitation,
} from "../src/services/quotes/quoteCitations";
import { resolveQuoteCitationPageHintForTests } from "../src/modules/contextPanel/assistantCitationLinks";
import type { QuoteCitation } from "../src/shared/types";

const INTRO_SENTENCE =
  "Wetting phenomena have been studied for over two centuries, and the moving contact line remains a canonical difficulty for continuum hydrodynamics.";
const OUTER_SENTENCE =
  "The dissipation integral is evaluated over the outer region of the wedge.";
const SINGULARITY_SENTENCE =
  "The pressure gradient diverges as the contact line is approached, so the viscous dissipation integral is logarithmically singular at alpha equal to three.";
const METHODS_SENTENCE =
  "Samples were prepared under vacuum and annealed for six hours before measurement.";
const ABSENT_SENTENCE =
  "A short-time existence result closes the section on the weak formulation.";
const SHORT_ANCHOR_SENTENCE =
  "Photoluminescence spectroscopy characterisation confirmed superparamagnetism.";
const RECOVERY_SENTENCE = "Recovery was 81% across the later sessions.";
const WASHOUT_SENTENCE =
  "The treatment group recovered after washout to the same level as sham animals in the later sessions.";
const SINGULARITY_CLAIM =
  "The pressure gradient is singular at the contact line because the viscous dissipation integral diverges logarithmically. [[quote:q1]]";
const RECOVERY_CLAIM =
  "After washout recovery was 81% across the later sessions [[quote:q1]].";

function introCitation(id = "q1"): QuoteCitation {
  return buildQuoteCitation({
    id,
    quoteText: INTRO_SENTENCE,
    sourceMatchText: INTRO_SENTENCE,
    sourceMatchKind: "exact",
    sourceMatchSource: "pdf-page-text",
    citationLabel: "Orion, 2025",
    sourceSectionLabel: "Introduction",
    sourceChunkKind: "body",
    contextItemId: 11,
    itemId: 11,
    pageHintIndex: 0,
    pageHintLabel: "1",
  })!;
}

function analysisCitation(
  id = "q2",
  quoteText = OUTER_SENTENCE,
): QuoteCitation {
  return buildQuoteCitation({
    id,
    quoteText,
    sourceMatchText: OUTER_SENTENCE,
    sourceMatchKind: "exact",
    sourceMatchSource: "pdf-page-text",
    citationLabel: "Orion, 2025",
    sourceSectionLabel: "Analysis of the dissipation integral",
    sourceChunkKind: "body",
    contextItemId: 11,
    itemId: 11,
    pageHintIndex: 6,
    pageHintLabel: "7",
  })!;
}

function resultsCitation(quoteText: string): QuoteCitation {
  return buildQuoteCitation({
    id: "q1",
    quoteText,
    sourceMatchText: quoteText,
    sourceMatchKind: "exact",
    sourceMatchSource: "pdf-page-text",
    citationLabel: "Orion, 2025",
    sourceSectionLabel: "Results",
    sourceChunkKind: "body",
    contextItemId: 11,
    itemId: 11,
    pageHintIndex: 4,
    pageHintLabel: "5",
  })!;
}

function absentQuoteCitation(): QuoteCitation {
  return buildQuoteCitation({
    ...introCitation(),
    quoteText: ABSENT_SENTENCE,
    sourceMatchText: ABSENT_SENTENCE,
  })!;
}

const twoChunkPassage = [
  "[chunk 3]",
  "## Introduction",
  INTRO_SENTENCE,
  "",
  "[chunk 7]",
  "## Analysis of the dissipation integral",
  OUTER_SENTENCE,
  SINGULARITY_SENTENCE,
].join("\n");

const shortAnchorPassage = [
  "[chunk 3]",
  "## Introduction",
  INTRO_SENTENCE,
  "",
  "[chunk 7]",
  OUTER_SENTENCE,
  "",
  SHORT_ANCHOR_SENTENCE,
].join("\n");

const threeChunkPassage = [
  "[chunk 3]",
  "## Introduction",
  INTRO_SENTENCE,
  "",
  "[chunk 5]",
  "## Methods",
  METHODS_SENTENCE,
  "",
  "[chunk 7]",
  "## Analysis of the dissipation integral",
  OUTER_SENTENCE,
  SINGULARITY_SENTENCE,
].join("\n");

const quoteAlsoInEarlierChunkPassage = [
  "[chunk 3]",
  "## Introduction",
  OUTER_SENTENCE,
  INTRO_SENTENCE,
  "",
  "[chunk 7]",
  "## Analysis of the dissipation integral",
  OUTER_SENTENCE,
  SINGULARITY_SENTENCE,
].join("\n");

const quoteAlsoInLaterChunkPassage = [
  "[chunk 3]",
  "## Introduction",
  OUTER_SENTENCE,
  SINGULARITY_SENTENCE,
  "",
  "[chunk 7]",
  "## Analysis of the dissipation integral",
  OUTER_SENTENCE,
  METHODS_SENTENCE,
].join("\n");

const quoteInThreeChunksPassage = [
  "[chunk 3]",
  "## Introduction",
  INTRO_SENTENCE,
  SINGULARITY_SENTENCE,
  "",
  "[chunk 5]",
  "## Methods",
  INTRO_SENTENCE,
  METHODS_SENTENCE,
  "",
  "[chunk 7]",
  "## Analysis of the dissipation integral",
  INTRO_SENTENCE,
  OUTER_SENTENCE,
].join("\n");

const quoteDuplicatedAcrossAnchorChunkPassage = [
  "[chunk 3]",
  "## Introduction",
  INTRO_SENTENCE,
  SINGULARITY_SENTENCE,
  "",
  "[chunk 7]",
  "## Analysis of the dissipation integral",
  INTRO_SENTENCE,
  OUTER_SENTENCE,
].join("\n");

const anchorDuplicatedPassage = [
  "[chunk 3]",
  "## Introduction",
  INTRO_SENTENCE,
  SINGULARITY_SENTENCE,
  "",
  "[chunk 7]",
  "## Analysis of the dissipation integral",
  OUTER_SENTENCE,
  SINGULARITY_SENTENCE,
].join("\n");

const wrappedPassage = [
  "[chunk 3]",
  "## Introduction",
  INTRO_SENTENCE,
  "",
  "[chunk 7]",
  "## Analysis of the dissipation integral",
  OUTER_SENTENCE.replace(/ /g, "\n"),
  SINGULARITY_SENTENCE,
].join("\n");

const inlineMarkerPassage = [
  "[chunk 3]",
  "## Introduction",
  `${INTRO_SENTENCE} [chunk 7] ${SINGULARITY_SENTENCE}`,
].join("\n");

const singleChunkPassage = [RECOVERY_SENTENCE, WASHOUT_SENTENCE].join("\n");

const markedSingleChunkPassage = ["[chunk 3]", singleChunkPassage].join("\n");

const blankFirstChunkPassage = [
  "[chunk 3]",
  "   ",
  "[chunk 4]",
  singleChunkPassage,
].join("\n");

const markersOnlyPassage = ["[chunk 3]", "", "[chunk 7]", ""].join("\n");

function reanchor(
  citations: QuoteCitation[],
  passage: string,
  text = SINGULARITY_CLAIM,
) {
  const passageTextByCitationId = new Map<string, string>();
  for (const citation of citations) {
    passageTextByCitationId.set(citation.id, passage);
  }
  return reanchorQuoteCitationsToClaims({
    text,
    quoteCitations: citations,
    passageTextByCitationId,
  });
}

const unprovableSourceCases: {
  name: string;
  citation: QuoteCitation;
  passage: string;
}[] = [
  {
    name: "the quote is in no chunk of the passage",
    citation: absentQuoteCitation(),
    passage: twoChunkPassage,
  },
  {
    name: "the anchor skips a chunk of a three-chunk read",
    citation: introCitation(),
    passage: threeChunkPassage,
  },
  {
    name: "the quote text also occurs in an earlier chunk",
    citation: analysisCitation("q1"),
    passage: quoteAlsoInEarlierChunkPassage,
  },
  {
    name: "the quote text also occurs in a later chunk",
    citation: analysisCitation("q1"),
    passage: quoteAlsoInLaterChunkPassage,
  },
  {
    name: "the quote text occurs in three chunks of the read",
    citation: introCitation(),
    passage: quoteInThreeChunksPassage,
  },
  {
    name: "the quote is duplicated and the anchor stays in its own chunk",
    citation: introCitation(),
    passage: quoteDuplicatedAcrossAnchorChunkPassage,
  },
];

const provenSourceCases: {
  name: string;
  citation: QuoteCitation;
  passage: string;
  claim: string;
  anchor: string;
  pageHintIndex: number;
  pageHintLabel: string;
  sourceSectionLabel: string;
}[] = [
  {
    name: "the anchor stays inside its own chunk",
    citation: analysisCitation("q1"),
    passage: twoChunkPassage,
    claim: SINGULARITY_CLAIM,
    anchor: "logarithmically singular",
    pageHintIndex: 6,
    pageHintLabel: "7",
    sourceSectionLabel: "Analysis of the dissipation integral",
  },
  {
    name: "only the anchor sentence is duplicated",
    citation: introCitation(),
    passage: anchorDuplicatedPassage,
    claim: SINGULARITY_CLAIM,
    anchor: "logarithmically singular",
    pageHintIndex: 0,
    pageHintLabel: "1",
    sourceSectionLabel: "Introduction",
  },
  {
    name: "the quote is line-wrapped and the passage copy is not",
    citation: analysisCitation("q1", OUTER_SENTENCE.replace(/ /g, "\n")),
    passage: twoChunkPassage,
    claim: SINGULARITY_CLAIM,
    anchor: "logarithmically singular",
    pageHintIndex: 6,
    pageHintLabel: "7",
    sourceSectionLabel: "Analysis of the dissipation integral",
  },
  {
    name: "the passage copy of the quote is line-wrapped",
    citation: analysisCitation("q1"),
    passage: wrappedPassage,
    claim: SINGULARITY_CLAIM,
    anchor: "logarithmically singular",
    pageHintIndex: 6,
    pageHintLabel: "7",
    sourceSectionLabel: "Analysis of the dissipation integral",
  },
  {
    name: "a chunk marker is written mid-line",
    citation: introCitation(),
    passage: inlineMarkerPassage,
    claim: SINGULARITY_CLAIM,
    anchor: "logarithmically singular",
    pageHintIndex: 0,
    pageHintLabel: "1",
    sourceSectionLabel: "Introduction",
  },
  {
    name: "the passage carries no chunk marker",
    citation: resultsCitation(WASHOUT_SENTENCE),
    passage: singleChunkPassage,
    claim: RECOVERY_CLAIM,
    anchor: RECOVERY_SENTENCE,
    pageHintIndex: 4,
    pageHintLabel: "5",
    sourceSectionLabel: "Results",
  },
  {
    name: "an unmarked single-chunk snippet does not carry the quote",
    citation: resultsCitation(ABSENT_SENTENCE),
    passage: singleChunkPassage,
    claim: RECOVERY_CLAIM,
    anchor: RECOVERY_SENTENCE,
    pageHintIndex: 4,
    pageHintLabel: "5",
    sourceSectionLabel: "Results",
  },
  {
    name: "a marker-led single-chunk snippet does not carry the quote",
    citation: resultsCitation(ABSENT_SENTENCE),
    passage: markedSingleChunkPassage,
    claim: RECOVERY_CLAIM,
    anchor: RECOVERY_SENTENCE,
    pageHintIndex: 4,
    pageHintLabel: "5",
    sourceSectionLabel: "Results",
  },
  {
    name: "a blank chunk precedes the one that was read",
    citation: resultsCitation(ABSENT_SENTENCE),
    passage: blankFirstChunkPassage,
    claim: RECOVERY_CLAIM,
    anchor: RECOVERY_SENTENCE,
    pageHintIndex: 4,
    pageHintLabel: "5",
    sourceSectionLabel: "Results",
  },
];

describe("claimAnchoring chunk provenance", function () {
  it("drops the page hint and section label when the anchor moves to another chunk", function () {
    const { quoteCitations, decisions } = reanchor(
      [introCitation()],
      twoChunkPassage,
    );

    assert.equal(decisions[0].match, "claim");
    assert.include(quoteCitations[0].quoteText, "logarithmically singular");
    assert.isUndefined(quoteCitations[0].sourceSectionLabel);
    assert.isUndefined(quoteCitations[0].pageHintIndex);
    assert.isUndefined(quoteCitations[0].pageHintLabel);
    assert.isUndefined(quoteCitations[0].sourceChunkKind);

    assert.equal(quoteCitations[0].id, "q1");
    assert.equal(quoteCitations[0].citationLabel, "(Orion, 2025)");
    assert.equal(quoteCitations[0].contextItemId, 11);
    assert.equal(quoteCitations[0].itemId, 11);
    assert.equal(quoteCitations[0].anchorMatch, "claim");
    assert.equal(
      quoteCitations[0].sourceMatchText,
      quoteCitations[0].quoteText,
      "the locator follows the quote it locates",
    );
  });

  it("stops the reader being sent to the page the quote left", function () {
    const { quoteCitations } = reanchor([introCitation()], twoChunkPassage);

    assert.include(quoteCitations[0].quoteText, "logarithmically singular");
    assert.isNull(resolveQuoteCitationPageHintForTests(quoteCitations[0]));
  });

  for (const { name, citation, passage } of unprovableSourceCases) {
    it(`drops the provenance when ${name}`, function () {
      const { quoteCitations } = reanchor([citation], passage);

      assert.include(quoteCitations[0].quoteText, "logarithmically singular");
      assert.isUndefined(quoteCitations[0].pageHintIndex);
      assert.isUndefined(quoteCitations[0].pageHintLabel);
      assert.isUndefined(quoteCitations[0].sourceSectionLabel);
      assert.isUndefined(quoteCitations[0].sourceChunkKind);
    });
  }

  it("drops the provenance of the crossing citation only, whichever order the citations arrive in", function () {
    const answer = [
      SINGULARITY_CLAIM,
      "The same divergence governs the outer wedge region of the flow. [[quote:q2]]",
    ].join("\n");

    const forward = reanchor(
      [introCitation("q1"), analysisCitation("q2")],
      twoChunkPassage,
      answer,
    );
    const reversed = reanchor(
      [analysisCitation("q2"), introCitation("q1")],
      twoChunkPassage,
      answer,
    );

    for (const result of [forward, reversed]) {
      const crossing = result.quoteCitations.find((c) => c.id === "q1")!;
      const staying = result.quoteCitations.find((c) => c.id === "q2")!;
      assert.isUndefined(crossing.pageHintIndex);
      assert.isUndefined(crossing.sourceSectionLabel);
      assert.equal(staying.pageHintIndex, 6);
      assert.equal(
        staying.sourceSectionLabel,
        "Analysis of the dissipation integral",
      );
    }
  });

  for (const {
    name,
    citation,
    passage,
    claim,
    anchor,
    pageHintIndex,
    pageHintLabel,
    sourceSectionLabel,
  } of provenSourceCases) {
    it(`keeps the provenance when ${name}`, function () {
      const { quoteCitations } = reanchor([citation], passage, claim);

      assert.include(quoteCitations[0].quoteText, anchor);
      assert.equal(quoteCitations[0].pageHintIndex, pageHintIndex);
      assert.equal(quoteCitations[0].pageHintLabel, pageHintLabel);
      assert.equal(quoteCitations[0].sourceSectionLabel, sourceSectionLabel);
      assert.equal(quoteCitations[0].sourceMatchSource, "pdf-page-text");
    });
  }

  it("leaves the citation untouched for a passage of chunk markers alone", function () {
    const { quoteCitations, decisions } = reanchor(
      [introCitation()],
      markersOnlyPassage,
    );

    assert.equal(quoteCitations[0].quoteText, INTRO_SENTENCE);
    assert.equal(quoteCitations[0].pageHintIndex, 0);
    assert.equal(quoteCitations[0].pageHintLabel, "1");
    assert.equal(quoteCitations[0].sourceSectionLabel, "Introduction");
    assert.equal(decisions[0].match, "passage");
  });

  it("reaches the same verdict when the same passage is re-anchored twice", function () {
    const first = reanchor([introCitation()], twoChunkPassage);
    const second = reanchor([introCitation()], twoChunkPassage);

    for (const result of [first, second]) {
      const citation = result.quoteCitations[0];
      assert.include(citation.quoteText, "logarithmically singular");
      assert.isUndefined(citation.pageHintIndex);
      assert.isUndefined(citation.pageHintLabel);
      assert.isUndefined(citation.sourceSectionLabel);
      assert.isUndefined(citation.sourceChunkKind);
    }
    assert.equal(
      first.quoteCitations[0].quoteText,
      second.quoteCitations[0].quoteText,
    );
  });

  it("binds the re-anchored quote as context text without a page", function () {
    const { quoteCitations } = reanchor([introCitation()], twoChunkPassage);
    const bound = resolveExactDisplayedQuoteCitation({
      quoteText: SINGULARITY_SENTENCE,
      citationLabel: "Orion, 2025",
      sourceIndex: buildQuoteSourceIndex({ quoteCitations }),
      preferredContextItemId: 11,
    });

    assert.equal(quoteCitations[0].sourceMatchSource, "context-text");
    assert.exists(bound);
    assert.equal(bound!.sourceMatchSource, "context-text");
    assert.isUndefined(bound!.pageHintIndex);
  });

  it("keeps the passage quote when the anchor in another chunk is too short to stand without a page", function () {
    const { quoteCitations, decisions } = reanchor(
      [introCitation()],
      shortAnchorPassage,
      "Photoluminescence characterisation confirmed superparamagnetism in the sample. [[quote:q1]]",
    );

    assert.equal(quoteCitations[0].quoteText, INTRO_SENTENCE);
    assert.equal(quoteCitations[0].pageHintIndex, 0);
    assert.equal(quoteCitations[0].anchorMatch, "passage");
    assert.equal(decisions[0].match, "passage");
  });

  it("re-anchors a citation with no match source to a short anchor in another chunk", function () {
    const citation = buildQuoteCitation({
      id: "q1",
      quoteText: INTRO_SENTENCE,
      citationLabel: "Orion, 2025",
      sourceSectionLabel: "Introduction",
      contextItemId: 11,
      pageHintIndex: 0,
      pageHintLabel: "1",
    })!;
    const { quoteCitations, decisions } = reanchor(
      [citation],
      shortAnchorPassage,
      "Photoluminescence characterisation confirmed superparamagnetism in the sample. [[quote:q1]]",
    );

    assert.equal(quoteCitations[0].quoteText, SHORT_ANCHOR_SENTENCE);
    assert.isUndefined(quoteCitations[0].sourceMatchSource);
    assert.isUndefined(quoteCitations[0].pageHintIndex);
    assert.equal(decisions[0].match, "claim");
  });

  it("keeps a context-text citation as context text when the anchor leaves its chunk", function () {
    const citation = buildQuoteCitation({
      id: "q1",
      quoteText: INTRO_SENTENCE,
      citationLabel: "Orion, 2025",
      sourceMatchKind: "trusted",
      sourceMatchSource: "context-text",
      sourceSectionLabel: "Introduction",
      sourceChunkKind: "body",
      contextItemId: 11,
      itemId: 11,
    })!;
    const { quoteCitations } = reanchor([citation], twoChunkPassage);

    assert.include(quoteCitations[0].quoteText, "logarithmically singular");
    assert.equal(quoteCitations[0].sourceMatchSource, "context-text");
    assert.isUndefined(quoteCitations[0].sourceSectionLabel);
    assert.isUndefined(quoteCitations[0].sourceChunkKind);
  });
});

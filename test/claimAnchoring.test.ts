import { assert } from "chai";
import {
  extractClaimSentences,
  reanchorQuoteCitationsToClaims,
} from "../src/services/quotes/claimAnchoring";
import {
  collectProseLines,
  splitSentences,
} from "../src/services/quotes/sentenceSplit";
import {
  buildQuoteCitation,
  mergeQuoteCitations,
} from "../src/services/quotes/quoteCitations";

const passage = [
  "[chunk 4]",
  "Median animal accuracy was 84% on day 1 and 85% on day 10. The difference is one percentage point, not a one-percent relative improvement.",
  "",
  "The fixed day-1 decoder declined from 80% to 62% accuracy by day 10. An independently retrained daily decoder remained at 81%.",
].join("\n");

function citation(id: string, quoteText: string) {
  return buildQuoteCitation({
    id,
    quoteText,
    sourceMatchText: quoteText,
    sourceMatchKind: "exact",
    sourceMatchSource: "context-text",
    citationLabel: "Orion 2025",
    contextItemId: 11,
    itemId: 10,
    pageHintIndex: 3,
  })!;
}

describe("sentenceSplit", function () {
  it("splits on terminators, keeps decimals and abbreviations together", function () {
    assert.deepEqual(
      splitSentences(
        "Error fell to 0.35 degrees. See Fig. 2 for details! 恢复到81%。Done",
      ).map((s) => s.text),
      [
        "Error fell to 0.35 degrees.",
        "See Fig. 2 for details!",
        "恢复到81%。",
        "Done",
      ],
    );
  });
  it("ends a sentence after a closing quote or bracket", function () {
    assert.deepEqual(
      splitSentences(
        'The authors write that accuracy fell by day 10." [[quote:q1]] A later sentence about mice.',
      ).map((s) => s.text),
      [
        'The authors write that accuracy fell by day 10."',
        "[[quote:q1]] A later sentence about mice.",
      ],
    );
  });

  it("ends a sentence at a standalone No., but not at a numbered one", function () {
    assert.deepEqual(
      splitSentences("Is that correct? No. The paper reports 62%.").map(
        (s) => s.text,
      ),
      ["Is that correct?", "No.", "The paper reports 62%."],
    );
    assert.deepEqual(
      splitSentences("See No. 5 for details.").map((s) => s.text),
      ["See No. 5 for details."],
    );
  });

  it("keeps prose lines only and strips list markers", function () {
    const lines = collectProseLines(
      "# Title\n- first item here\n> quoted\n```\ncode\n```\n| a | b |\nplain line",
    );
    assert.deepEqual(
      lines.map((l) => l.text),
      ["first item here", "plain line"],
    );
  });
});

describe("claimAnchoring", function () {
  it("extracts the sentence around each token, without the token", function () {
    const map = extractClaimSentences(
      "Intro. The decoder declined to 62% by day 10 [[quote:q1]]. Later [[quote:q2]] the animals stayed at 85%.",
    );
    assert.equal(map.get("q1"), "The decoder declined to 62% by day 10.");
    assert.equal(map.get("q2"), "Later the animals stayed at 85%.");
  });

  it("moves the anchor to the passage sentence that matches the claim", function () {
    const original = citation(
      "q1",
      "Median animal accuracy was 84% on day 1 and 85% on day 10.",
    );
    const { quoteCitations, decisions } = reanchorQuoteCitationsToClaims({
      text: "The fixed decoder declined from 80% to 62% by day 10 [[quote:q1]].",
      quoteCitations: [original],
      passageTextByCitationId: new Map([["q1", passage]]),
    });
    assert.equal(decisions[0].match, "claim");
    assert.equal(quoteCitations[0].id, "q1");
    assert.equal(
      quoteCitations[0].quoteText,
      "The fixed day-1 decoder declined from 80% to 62% accuracy by day 10.",
    );
    assert.equal(
      quoteCitations[0].sourceMatchText,
      quoteCitations[0].quoteText,
    );
    assert.equal(quoteCitations[0].anchorMatch, "claim");
    assert.equal(quoteCitations[0].pageHintIndex, 3);
    assert.isUndefined(quoteCitations[0].sourceMatchPageOccurrence);
    assert.equal(mergeQuoteCitations(quoteCitations)[0].anchorMatch, "claim");
  });

  it("drops the page and section of the chunk a re-anchored quote leaves", function () {
    const original = buildQuoteCitation({
      ...citation(
        "q1",
        "Median animal accuracy was 84% on day 1 and 85% on day 10.",
      ),
      sourceMatchSource: "pdf-page-text",
      sourceSectionLabel: "Results",
      sourceChunkKind: "body",
      pageHintLabel: "4",
    })!;
    const twoChunks = [
      "[chunk 4]",
      "Median animal accuracy was 84% on day 1 and 85% on day 10.",
      "",
      "[chunk 9]",
      "The fixed day-1 decoder declined from 80% to 62% accuracy by day 10.",
    ].join("\n");
    const { quoteCitations } = reanchorQuoteCitationsToClaims({
      text: "The fixed decoder declined from 80% to 62% by day 10 [[quote:q1]].",
      quoteCitations: [original],
      passageTextByCitationId: new Map([["q1", twoChunks]]),
    });
    assert.equal(
      quoteCitations[0].quoteText,
      "The fixed day-1 decoder declined from 80% to 62% accuracy by day 10.",
    );
    assert.isUndefined(quoteCitations[0].pageHintIndex);
    assert.isUndefined(quoteCitations[0].pageHintLabel);
    assert.isUndefined(quoteCitations[0].sourceSectionLabel);
    assert.isUndefined(quoteCitations[0].sourceChunkKind);
    assert.equal(quoteCitations[0].sourceMatchSource, "context-text");
  });

  it("keeps the passage anchor and marks it when nothing matches the claim", function () {
    const original = citation(
      "q1",
      "Median animal accuracy was 84% on day 1 and 85% on day 10.",
    );
    const { quoteCitations, decisions } = reanchorQuoteCitationsToClaims({
      text: "Downstream synaptic weights were not measured in this cohort [[quote:q1]].",
      quoteCitations: [original],
      passageTextByCitationId: new Map([["q1", passage]]),
    });
    assert.equal(decisions[0].match, "passage");
    assert.equal(quoteCitations[0].quoteText, original.quoteText);
    assert.equal(quoteCitations[0].anchorMatch, "passage");
    assert.equal(mergeQuoteCitations(quoteCitations)[0].anchorMatch, "passage");
  });

  it("leaves citations without a token and without passage text untouched", function () {
    const unused = citation(
      "q9",
      "An independently retrained daily decoder remained at 81%.",
    );
    const noPassage = citation(
      "q1",
      "Median animal accuracy was 84% on day 1 and 85% on day 10.",
    );
    const { quoteCitations } = reanchorQuoteCitationsToClaims({
      text: "Accuracy was 85% [[quote:q1]].",
      quoteCitations: [unused, noPassage],
      passageTextByCitationId: new Map(),
    });
    assert.isUndefined(quoteCitations[0].anchorMatch);
    assert.equal(quoteCitations[1].quoteText, noPassage.quoteText);
    assert.isUndefined(quoteCitations[1].anchorMatch);
  });

  it("extends a short matching sentence to the minimum length", function () {
    const short =
      "Recovery was 81%. The treatment group recovered after washout to the same level as sham animals in the later sessions.";
    const original = citation(
      "q1",
      "The treatment group recovered after washout to the same level as sham animals in the later sessions.",
    );
    const { quoteCitations } = reanchorQuoteCitationsToClaims({
      text: "After washout recovery was 81% [[quote:q1]].",
      quoteCitations: [original],
      passageTextByCitationId: new Map([["q1", short]]),
    });
    assert.isAtLeast(quoteCitations[0].quoteText.length, 40);
    assert.match(quoteCitations[0].quoteText, /^Recovery was 81%\./);
  });

  it("ignores tokens inside headings and binds a blockquote token to the quoted text", function () {
    const map = extractClaimSentences(
      "> quoted [[quote:q1]]\n## Heading [[quote:q2]]\nBody sentence here [[quote:q3]].",
    );
    assert.deepEqual([...map.keys()], ["q1", "q3"]);
    assert.equal(map.get("q1"), "quoted");
    assert.equal(map.get("q3"), "Body sentence here.");
  });

  it("binds a token in or around a blockquote to the quoted claim", function () {
    const quoted =
      "The fixed day-1 decoder declined from 80% to 62% accuracy by day 10.";
    assert.equal(
      extractClaimSentences(
        `The paper states:\n\n> ${quoted} [[quote:q1]]`,
      ).get("q1"),
      quoted,
    );
    assert.equal(
      extractClaimSentences(
        `The paper states: [[quote:q1]]\n\n> ${quoted}`,
      ).get("q1"),
      quoted,
    );
    assert.equal(
      extractClaimSentences(
        `The paper states:\n\n> ${quoted}\n\n[[quote:q1]]`,
      ).get("q1"),
      quoted,
    );
  });

  it("binds a citation label written under a quoted block to that block", function () {
    const quoted =
      "The fixed day-1 decoder declined from 80% to 62% accuracy by day 10.";
    assert.equal(
      extractClaimSentences(`> ${quoted}\n\n(Orion, 2025) [[quote:q1]]`).get(
        "q1",
      ),
      quoted,
    );
    assert.equal(
      extractClaimSentences(
        `> ${quoted}\n\nSource: (Orion, 2025) [[quote:q1]]`,
      ).get("q1"),
      quoted,
    );
  });

  it("keeps a real sentence under a quoted block as the claim", function () {
    const quoted =
      "> The fixed day-1 decoder declined from 80% to 62% accuracy by day 10.";
    assert.equal(
      extractClaimSentences(
        `${quoted}\n\nThe animals nevertheless kept their accuracy across sessions [[quote:q1]].`,
      ).get("q1"),
      "The animals nevertheless kept their accuracy across sessions.",
    );
    assert.equal(
      extractClaimSentences(
        `${quoted}\n\nAccuracy stayed stable [[quote:q1]].`,
      ).get("q1"),
      "Accuracy stayed stable.",
    );
  });

  it("keeps the lead-in sentence when no blockquote follows it", function () {
    const map = extractClaimSentences(
      "The paper states: [[quote:q1]]\n\nA normal sentence follows here.",
    );
    assert.equal(map.get("q1"), "The paper states:");
  });

  it("binds a token written after the period, and a token on its own line, to the preceding sentence", function () {
    const map = extractClaimSentences(
      "The decoder declined to 62% by day 10. [[quote:q1]] Accuracy stayed at 85%.\n\n[[quote:q2]]",
    );
    assert.equal(map.get("q1"), "The decoder declined to 62% by day 10.");
    assert.equal(map.get("q2"), "Accuracy stayed at 85%.");
  });

  it("binds a token that opens a sentence to the sentence before it", function () {
    const map = extractClaimSentences(
      "A first sentence about decoders here. [[quote:q1]] A second sentence about mice.",
    );
    assert.equal(map.get("q1"), "A first sentence about decoders here.");
  });

  it("keeps a closing quote or bracket with the claim it ends", function () {
    assert.equal(
      extractClaimSentences(
        'The authors write that accuracy fell by day 10." [[quote:q1]] A later sentence about mice.',
      ).get("q1"),
      'The authors write that accuracy fell by day 10."',
    );
    assert.equal(
      extractClaimSentences(
        "Values were (84% and 85%). [[quote:q2]] Next.",
      ).get("q2"),
      "Values were (84% and 85%).",
    );
  });

  it("ends a claim at a quote token written with no space before it", function () {
    assert.deepEqual(
      splitSentences(
        'The count dropped to day 10."[[quote:q1]] Next sentence about mice.',
      ).map((s) => s.text),
      [
        'The count dropped to day 10."',
        "[[quote:q1]] Next sentence about mice.",
      ],
    );
    assert.equal(
      extractClaimSentences(
        'The count dropped to day 10."[[quote:q1]] Next sentence about mice.',
      ).get("q1"),
      'The count dropped to day 10."',
    );
    assert.equal(
      extractClaimSentences("Accuracy stayed at 85%.[[quote:q2]] Next.").get(
        "q2",
      ),
      "Accuracy stayed at 85%.",
    );
  });

  it("strips nested blockquote markers from the quoted claim", function () {
    assert.equal(
      extractClaimSentences("> > deep quote here [[quote:q1]]").get("q1"),
      "deep quote here",
    );
  });

  it("marks an anchor the claim already points at without rebuilding it", function () {
    const original = {
      ...citation(
        "q1",
        "The fixed day-1 decoder declined from 80% to 62% accuracy by day 10.",
      ),
      sourceMatchPageOccurrence: 2,
    };
    const { quoteCitations, decisions } = reanchorQuoteCitationsToClaims({
      text: "The fixed decoder declined from 80% to 62% by day 10 [[quote:q1]].",
      quoteCitations: [original],
      passageTextByCitationId: new Map([["q1", passage]]),
    });
    assert.equal(decisions[0].match, "claim");
    assert.deepEqual(quoteCitations[0], { ...original, anchorMatch: "claim" });
    assert.equal(quoteCitations[0].sourceMatchPageOccurrence, 2);
  });

  it("re-anchors every citation against its own passage", function () {
    const first = citation(
      "q1",
      "Median animal accuracy was 84% on day 1 and 85% on day 10.",
    );
    const second = citation(
      "q2",
      "An independently retrained daily decoder remained at 81%.",
    );
    const { quoteCitations, decisions } = reanchorQuoteCitationsToClaims({
      text: "The fixed decoder declined from 80% to 62% by day 10 [[quote:q1]]. Downstream synaptic weights were not measured in this cohort [[quote:q2]].",
      quoteCitations: [first, second],
      passageTextByCitationId: new Map([
        ["q1", passage],
        [
          "q2",
          "Recovery was 81%. The treatment group recovered after washout to the same level as sham animals in the later sessions.",
        ],
      ]),
    });
    assert.deepEqual(
      decisions.map((d) => [d.id, d.match]),
      [
        ["q1", "claim"],
        ["q2", "passage"],
      ],
    );
    assert.equal(
      quoteCitations[0].quoteText,
      "The fixed day-1 decoder declined from 80% to 62% accuracy by day 10.",
    );
    assert.equal(quoteCitations[0].anchorMatch, "claim");
    assert.equal(quoteCitations[1].quoteText, second.quoteText);
    assert.equal(quoteCitations[1].anchorMatch, "passage");
  });

  it("never re-anchors a claim onto a metadata line", function () {
    const original = citation(
      "q1",
      "An independently retrained daily decoder remained at 81%.",
    );
    const { quoteCitations } = reanchorQuoteCitationsToClaims({
      text: "The paper measures decoder drift in mouse visual cortex across ten recording days [[quote:q1]]",
      quoteCitations: [original],
      passageTextByCitationId: new Map([
        [
          "q1",
          [
            "Title: Measuring decoder drift in mouse visual cortex across ten recording days",
            "",
            "We recorded 200 tracked neurons in visual cortex from 10 adult mice over 10 daily sessions.",
          ].join("\n"),
        ],
      ]),
    });
    assert.notMatch(
      quoteCitations[0].quoteText,
      /^Title:/i,
      "a metadata line states nothing the answer can be quoting",
    );
  });

  it("marks a token that no claim sentence can hold as passage-anchored", function () {
    const inHeading = citation(
      "q1",
      "An independently retrained daily decoder remained at 81%.",
    );
    const uncited = citation(
      "q9",
      "Median animal accuracy was 84% on day 1 and 85% on day 10.",
    );
    const { quoteCitations, decisions } = reanchorQuoteCitationsToClaims({
      text: "## Findings [[quote:q1]]\n\nBody.",
      quoteCitations: [inHeading, uncited],
      passageTextByCitationId: new Map([
        ["q1", passage],
        ["q9", passage],
      ]),
    });
    assert.equal(quoteCitations[0].quoteText, inHeading.quoteText);
    assert.equal(quoteCitations[0].anchorMatch, "passage");
    assert.deepEqual(
      decisions.map((d) => [d.id, d.match]),
      [["q1", "passage"]],
    );
    assert.equal(quoteCitations[1].quoteText, uncited.quoteText);
    assert.isUndefined(
      quoteCitations[1].anchorMatch,
      "a citation the answer never cites makes no anchoring claim",
    );
  });
});

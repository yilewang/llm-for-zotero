import { assert } from "chai";
import {
  chunkKindFromSectionLabel,
  compareEvidenceCandidatesForQuestion,
  isBodyEvidenceSection,
  isFrontMatterSection,
  queryHasExplicitSectionPreference,
  scoreSectionPreference,
} from "../src/shared/libraryChatEvidencePolicy";
import type { PaperContextCandidate } from "../src/modules/contextPanel/types";

function candidate(input: {
  chunkIndex: number;
  sectionLabel: string;
  evidenceScore: number;
}): PaperContextCandidate {
  return {
    paperKey: "1:2",
    itemId: 1,
    contextItemId: 2,
    title: "Policy Paper",
    chunkIndex: input.chunkIndex,
    chunkText: `${input.sectionLabel}\nEvidence text`,
    sectionLabel: input.sectionLabel,
    chunkKind: chunkKindFromSectionLabel(input.sectionLabel),
    estimatedTokens: 8,
    bm25Score: input.evidenceScore,
    embeddingScore: 0,
    hybridScore: input.evidenceScore,
    evidenceScore: input.evidenceScore,
  };
}

describe("libraryChatEvidencePolicy", function () {
  it("classifies front matter and body evidence consistently", function () {
    assert.isTrue(isFrontMatterSection("Abstract"));
    assert.isTrue(isFrontMatterSection("Highlights"));
    assert.isFalse(isFrontMatterSection("Results"));

    assert.isFalse(isBodyEvidenceSection("Abstract", "abstract"));
    assert.isFalse(isBodyEvidenceSection("References", "references"));
    assert.isTrue(isBodyEvidenceSection("Methods", "methods"));
    assert.isTrue(isBodyEvidenceSection("Results", "unknown"));
  });

  it("scores section preferences from the user question", function () {
    assert.equal(scoreSectionPreference("Compare the methods", "Methods"), 2);
    assert.equal(
      scoreSectionPreference("Compare the methods", "Results"),
      0.25,
    );
    assert.equal(
      scoreSectionPreference("What are the findings?", "Results"),
      2,
    );
    assert.equal(
      scoreSectionPreference("What are the limitations?", "Discussion"),
      2,
    );
    assert.isTrue(queryHasExplicitSectionPreference("Compare the methods"));
    assert.isFalse(
      queryHasExplicitSectionPreference("Give me a broad synthesis"),
    );
  });

  it("orders candidates by section preference before base relevance", function () {
    const rows = [
      candidate({ chunkIndex: 1, sectionLabel: "Results", evidenceScore: 0.9 }),
      candidate({ chunkIndex: 2, sectionLabel: "Methods", evidenceScore: 0.2 }),
    ];

    rows.sort(
      compareEvidenceCandidatesForQuestion(
        "Compare the methods",
        (row) => row.evidenceScore,
      ),
    );

    assert.equal(rows[0].sectionLabel, "Methods");
  });
});

describe("wantedSections (classifier-provided, language-independent)", function () {
  it("scores a wanted section for a CJK query with no English cues", function () {
    assert.equal(
      scoreSectionPreference("这些论文的方法", "Methods", ["methods"]),
      2,
    );
    assert.equal(
      scoreSectionPreference("这些论文的方法", "Abstract", ["methods"]),
      0,
    );
  });

  it("treats non-empty wantedSections as an explicit section preference", function () {
    assert.isTrue(
      queryHasExplicitSectionPreference("这些论文的方法", ["methods"]),
    );
    assert.isFalse(queryHasExplicitSectionPreference("这些论文的方法"));
  });

  it("ranks the wanted section first for a non-English query", function () {
    const comparator = compareEvidenceCandidatesForQuestion(
      "这些论文的方法",
      () => 0,
      ["methods"],
    );
    const sorted = [
      { sectionLabel: "Abstract", chunkIndex: 0 },
      { sectionLabel: "Methods", chunkIndex: 5 },
    ].sort(comparator);

    assert.equal(sorted[0].sectionLabel, "Methods");
  });
});

import { assert } from "chai";
import {
  buildVerificationSummary,
  ensureCoverageSection,
} from "../src/agent/documents/coverageSection";
import {
  auditCrossPaperSupport,
  describeUnsupportedParagraphs,
} from "../src/agent/documents/supportAudit";

const clusters = [
  {
    citationId: "C1",
    sources: [{ libraryID: 1, itemKey: "A", evidenceRefs: [] }],
  },
  {
    citationId: "C2",
    sources: [{ libraryID: 1, itemKey: "B", evidenceRefs: [] }],
  },
  {
    citationId: "C3",
    sources: [{ libraryID: 1, itemKey: "C", evidenceRefs: [] }],
  },
  {
    citationId: "C4",
    sources: [
      { libraryID: 1, itemKey: "A", evidenceRefs: [] },
      { libraryID: 1, itemKey: "C", evidenceRefs: [] },
    ],
  },
];

describe("document support audit", function () {
  it("requires every co-cited paper in a synthesis paragraph to be linked by an edge", function () {
    const markdown = [
      "# Review",
      "",
      "## Introduction",
      "",
      "Overview citing everyone [[cite:C1]] [[cite:C2]] [[cite:C3]].",
      "",
      "## Thematic synthesis",
      "",
      "A and B agree on the sign [[cite:C1]] [[cite:C2]].",
      "",
      "C stands alone [[cite:C3]].",
      "",
      "B and C diverge on timing [[cite:C2]] [[cite:C3]].",
      "",
      "- A list item may cite freely [[cite:C1]] [[cite:C3]].",
      "",
      "A grouped citation [[cite:C4]].",
      "",
      "## Scope and limitations",
      "",
      "Everything [[cite:C1]] [[cite:C2]] [[cite:C3]].",
    ].join("\n");
    const result = auditCrossPaperSupport({
      markdown,
      clusters,
      edges: [
        { source: "1:A", target: "1:B", status: "verified" },
        { source: "1:A", target: "1:C", status: "refuted" },
      ],
    });
    assert.equal(result.crossPaperParagraphs, 3);
    assert.equal(result.supported, 1);
    assert.deepEqual(
      result.unsupported.map((entry) => entry.unlinked),
      [
        ["1:B", "1:C"],
        ["1:A", "1:C"],
      ],
    );
    assert.match(
      describeUnsupportedParagraphs(result.unsupported),
      /Under "Thematic synthesis"/,
    );
    assert.match(
      describeUnsupportedParagraphs(result.unsupported),
      /B and C diverge on timing/,
    );
  });

  it("appends the verification summary under the limitations heading", function () {
    const markdown = [
      "# Review",
      "",
      "## Scope and limitations",
      "",
      "Twelve papers were read.",
      "",
      "## References",
    ].join("\n");
    const output = ensureCoverageSection({
      markdown,
      summary: "Coverage: 12 papers.",
    });
    assert.equal(
      output,
      [
        "# Review",
        "",
        "## Scope and limitations",
        "",
        "Twelve papers were read.",
        "",
        "Coverage: 12 papers.",
        "",
        "## References",
      ].join("\n"),
    );
  });

  it("prefers the scope-and-limitations section over an earlier limitations heading", function () {
    const markdown = [
      "# Review",
      "",
      "# Agreements, contradictions, and limitations",
      "",
      "The studies agree on method.",
      "",
      "# Conclusion",
      "",
      "Bounded prior.",
      "",
      "# Scope and limitations",
      "",
      "Three papers were read in full.",
      "",
      "## References",
    ].join("\n");
    const output = ensureCoverageSection({
      markdown,
      summary: "Coverage: 3 papers.",
    });
    assert.equal(
      output,
      [
        "# Review",
        "",
        "# Agreements, contradictions, and limitations",
        "",
        "The studies agree on method.",
        "",
        "# Conclusion",
        "",
        "Bounded prior.",
        "",
        "# Scope and limitations",
        "",
        "Three papers were read in full.",
        "",
        "Coverage: 3 papers.",
        "",
        "## References",
      ].join("\n"),
    );
  });

  it("generates the section before References when the model omitted it", function () {
    const output = ensureCoverageSection({
      markdown: "# Review\n\n## Themes\n\nText.\n\n## References\n",
      summary: "Coverage: 3 papers.",
    });
    assert.equal(
      output,
      "# Review\n\n## Themes\n\nText.\n\n## Scope and limitations\n\nCoverage: 3 papers.\n\n## References\n",
    );
    const appended = ensureCoverageSection({
      markdown: "# Review\n\n## Themes\n\nText.",
      summary: "Coverage: 3 papers.",
    });
    assert.equal(
      appended,
      "# Review\n\n## Themes\n\nText.\n\n## Scope and limitations\n\nCoverage: 3 papers.\n",
    );
  });

  it("summarizes coverage depth and the relationship record", function () {
    const summary = buildVerificationSummary({
      coverageItems: [
        {
          libraryID: 1,
          itemKey: "A",
          status: "included",
          evidenceDepth: "body",
        },
        {
          libraryID: 1,
          itemKey: "B",
          status: "included",
          evidenceDepth: "body",
        },
        {
          libraryID: 1,
          itemKey: "C",
          status: "unresolved",
          evidenceDepth: "abstract",
        },
      ],
      report: {
        version: 1,
        computedAt: 1,
        papers: 3,
        nodes: 3,
        claims: 7,
        claimsWithLocators: 2,
        nodesWithEdges: 3,
        edges: 4,
        edgesVerified: 2,
        edgesTentative: 1,
        edgesRefuted: 1,
        contradictions: 1,
        subquestionClaims: { sq1: 4 },
        themes: 2,
        themesWithEdges: 2,
        openQuestions: 1,
        answeredQuestions: 0,
      },
    });
    assert.equal(
      summary,
      [
        "Coverage: 3 papers in the approved scope (2 at full-text depth, 1 at abstract depth).",
        "Relationships: 4 recorded between papers, 2 verified against source text, 1 tentative, 1 refuted; 1 contradictions surfaced.",
        "Claims: 7 evidence-bound claims across 3 papers, 2 with host-verified locators.",
      ].join("\n"),
    );
  });
});

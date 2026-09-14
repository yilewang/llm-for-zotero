import { assert } from "chai";
import {
  computeResearchQualityReport,
  summarizeQualityReport,
} from "../src/agent/research/rubric";

describe("research quality rubric", function () {
  it("counts nodes, claims, edges, contradictions, subquestion coverage and themes", function () {
    const report = computeResearchQualityReport({
      corpus: [
        { libraryID: 1, itemKey: "A", screeningStatus: "included" },
        { libraryID: 1, itemKey: "B", screeningStatus: "included" },
        { libraryID: 1, itemKey: "M", screeningStatus: "missing" },
      ] as never,
      findings: [
        {
          libraryID: 1,
          itemKey: "A",
          subquestionIds: ["sq1"],
          claims: [
            {
              claimId: "A:c1",
              subquestionIds: ["sq1"],
              evidence: { sourceKind: "body", pageIndex: 3, verified: true },
            },
            {
              claimId: "A:c2",
              subquestionIds: ["sq2"],
              evidence: { sourceKind: "body" },
            },
          ],
        },
        { libraryID: 1, itemKey: "B", subquestionIds: ["sq2"] },
      ] as never,
      edges: [
        {
          source: "1:A",
          target: "1:B",
          type: "contradicts",
          status: "verified",
          lifecycle: "valid",
        },
        {
          source: "1:B",
          target: "1:A",
          type: "extends",
          status: "merged",
          lifecycle: "valid",
        },
        {
          source: "1:A",
          target: "1:B",
          type: "extends",
          status: "tentative",
          lifecycle: "invalidated",
        },
      ] as never,
      questions: [
        { status: "open", lifecycle: "valid" },
        { status: "answered", lifecycle: "valid" },
        { status: "open", lifecycle: "invalidated" },
      ] as never,
      themes: [
        { status: "valid", edgeIds: ["e1"] },
        { status: "valid" },
        { status: "invalidated", edgeIds: ["e1"] },
      ] as never,
      subquestions: [
        { id: "sq1", question: "one" },
        { id: "sq2", question: "two" },
        { id: "sq3", question: "three" },
      ],
      audit: { crossPaperParagraphs: 4, supported: 3 },
      now: 9,
    });
    assert.deepEqual(report, {
      version: 1,
      computedAt: 9,
      papers: 2,
      nodes: 2,
      claims: 2,
      claimsWithLocators: 1,
      nodesWithEdges: 2,
      edges: 1,
      edgesVerified: 1,
      edgesTentative: 0,
      edgesRefuted: 0,
      contradictions: 1,
      subquestionClaims: { sq1: 1, sq2: 2, sq3: 0 },
      themes: 2,
      themesWithEdges: 1,
      openQuestions: 1,
      answeredQuestions: 1,
      crossPaperParagraphs: 4,
      crossPaperParagraphsSupported: 3,
    });
    assert.equal(
      summarizeQualityReport(report),
      "2 nodes; 2 claims (1 with verified locators); 1 relationships (1 verified, 0 tentative, 0 refuted); 1 contradictions surfaced; 2 themes (1 bound to edges); 3/4 cross-paper paragraphs backed by an edge",
    );
  });
});

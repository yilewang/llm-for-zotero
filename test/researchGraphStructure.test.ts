import { assert } from "chai";
import {
  computeChronology,
  computeCommunities,
  computeStructuralGaps,
} from "../src/agent/research/graphStructure";
import type { ResearchEdge } from "../src/agent/research/types";

function edge(
  source: string,
  target: string,
  overrides: Partial<ResearchEdge> = {},
): ResearchEdge {
  return {
    version: 1,
    edgeId: `e:${source}:${target}:${overrides.type || "extends"}`,
    researchJobId: "r",
    executionId: "e",
    parentTaskId: "t",
    source,
    target,
    type: "extends",
    statement: "s",
    sourceClaimIds: [],
    targetClaimIds: [],
    confidence: "medium",
    requiresVerification: false,
    status: "candidate",
    subquestionIds: [],
    lifecycle: "valid",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("research graph structure", function () {
  it("finds communities from connected components and ignores refuted or merged edges", function () {
    const communities = computeCommunities({
      nodes: ["1:A", "1:B", "1:C", "1:D", "1:E"],
      edges: [
        edge("1:A", "1:B"),
        edge("1:B", "1:C"),
        edge("1:D", "1:E", { status: "refuted" }),
        edge("1:C", "1:D", { status: "merged" }),
      ],
    });
    assert.deepEqual(
      communities.map((community) => community.members),
      [["1:A", "1:B", "1:C"], ["1:D"], ["1:E"]],
    );
    assert.deepEqual(communities[0].edgeIds, [
      "e:1:A:1:B:extends",
      "e:1:B:1:C:extends",
    ]);
    assert.equal(communities[0].communityId, "C1");
  });

  it("separates two dense groups joined by a single edge", function () {
    const left = ["1:A", "1:B", "1:C", "1:D", "1:E"];
    const right = ["1:F", "1:G", "1:H", "1:I", "1:J"];
    const clique = (nodes: string[]) =>
      nodes.flatMap((a, i) => nodes.slice(i + 1).map((b) => edge(a, b)));
    const communities = computeCommunities({
      nodes: [...left, ...right],
      edges: [...clique(left), ...clique(right), edge("1:E", "1:F")],
    });
    assert.lengthOf(communities, 2);
    assert.deepEqual(communities[0].members, left);
    assert.deepEqual(communities[1].members, right);
  });

  it("orders the chronology by year with forward edges", function () {
    const chronology = computeChronology({
      nodes: [
        { identity: "1:B", year: "2020" },
        { identity: "1:A", year: "2018" },
        { identity: "1:C" },
      ],
      edges: [edge("1:A", "1:B"), edge("1:B", "1:C")],
    });
    assert.deepEqual(
      chronology.map((entry) => entry.identity),
      ["1:A", "1:B", "1:C"],
    );
    assert.deepEqual(chronology[0].forwardEdgeIds, ["e:1:A:1:B:extends"]);
    assert.deepEqual(chronology[1].forwardEdgeIds, ["e:1:B:1:C:extends"]);
    assert.deepEqual(chronology[2].forwardEdgeIds, []);
  });

  it("names structural gaps: isolated nodes, thin subquestions, unresolved contradictions", function () {
    const gaps = computeStructuralGaps({
      corpus: [
        { libraryID: 1, itemKey: "A", screeningStatus: "included" } as never,
        { libraryID: 1, itemKey: "B", screeningStatus: "included" } as never,
        { libraryID: 1, itemKey: "C", screeningStatus: "included" } as never,
      ],
      findings: [
        {
          libraryID: 1,
          itemKey: "A",
          subquestionIds: ["sq1"],
          claims: [
            { claimId: "A:c1", subquestionIds: ["sq1"] },
            { claimId: "A:c2", subquestionIds: ["sq1"] },
          ],
        } as never,
        {
          libraryID: 1,
          itemKey: "B",
          subquestionIds: ["sq2"],
          claims: [{ claimId: "B:c1", subquestionIds: ["sq2"] }],
        } as never,
        { libraryID: 1, itemKey: "C", subquestionIds: [], claims: [] } as never,
      ],
      edges: [
        edge("1:A", "1:B", {
          type: "contradicts",
          status: "tentative",
          edgeId: "contra",
        }),
      ],
      questions: [
        { questionId: "q1", status: "open", lifecycle: "valid" } as never,
        { questionId: "q2", status: "answered", lifecycle: "valid" } as never,
      ],
      subquestions: [
        { id: "sq1", question: "one" },
        { id: "sq2", question: "two" },
        { id: "sq3", question: "three" },
      ],
    });
    assert.deepEqual(gaps.isolatedNodes, ["1:C"]);
    assert.deepEqual(gaps.thinSubquestions, [
      { subquestionId: "sq2", claims: 1 },
      { subquestionId: "sq3", claims: 0 },
    ]);
    assert.deepEqual(gaps.unresolvedContradictions, ["contra"]);
    assert.deepEqual(gaps.tentativeEdges, ["contra"]);
    assert.deepEqual(gaps.openQuestions, ["q1"]);
  });
});

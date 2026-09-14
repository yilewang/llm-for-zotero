import type {
  PaperFinding,
  ResearchCorpusItem,
  ResearchEdge,
  ResearchOpenQuestion,
  ResearchSubquestion,
} from "./types";

/**
 * Structure the host computes from the network so the model never has to
 * carry it: communities (themes emerge from links), a chronology along edges,
 * and structural gaps (holes the review should name instead of listing
 * per-paper limitations).
 */

export type GraphCommunity = Readonly<{
  communityId: string;
  members: readonly string[];
  edgeIds: readonly string[];
}>;

function structuralEdges(edges: readonly ResearchEdge[]): ResearchEdge[] {
  return edges.filter(
    (edge) =>
      edge.lifecycle === "valid" &&
      edge.status !== "merged" &&
      edge.status !== "refuted",
  );
}

/**
 * One level of modularity-based local moving (the first Louvain phase) in a
 * deterministic node order: each node joins the neighbouring community with
 * the largest modularity gain until nothing moves. Deterministic, dependency
 * free, and adequate for corpora of a few hundred nodes.
 */
export function computeCommunities(params: {
  nodes: readonly string[];
  edges: readonly ResearchEdge[];
}): GraphCommunity[] {
  const edges = structuralEdges(params.edges).filter(
    (edge) =>
      params.nodes.includes(edge.source) && params.nodes.includes(edge.target),
  );
  const nodes = [...params.nodes].sort();
  const neighbours = new Map<string, Map<string, number>>();
  for (const node of nodes) neighbours.set(node, new Map());
  for (const edge of edges) {
    const a = neighbours.get(edge.source)!;
    const b = neighbours.get(edge.target)!;
    a.set(edge.target, (a.get(edge.target) || 0) + 1);
    b.set(edge.source, (b.get(edge.source) || 0) + 1);
  }
  const degree = new Map(
    nodes.map((node) => [
      node,
      [...neighbours.get(node)!.values()].reduce((sum, w) => sum + w, 0),
    ]),
  );
  const m = edges.length;
  const community = new Map(nodes.map((node) => [node, node]));
  const totalDegree = new Map(nodes.map((node) => [node, degree.get(node)!]));
  if (m > 0) {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      let moved = false;
      for (const node of nodes) {
        const k = degree.get(node)!;
        const current = community.get(node)!;
        const linksTo = new Map<string, number>();
        for (const [next, weight] of neighbours.get(node)!) {
          const target = community.get(next)!;
          linksTo.set(target, (linksTo.get(target) || 0) + weight);
        }
        totalDegree.set(current, totalDegree.get(current)! - k);
        const gain = (label: string) =>
          (linksTo.get(label) || 0) - (totalDegree.get(label)! * k) / (2 * m);
        let best = current;
        let bestGain = gain(current);
        for (const label of [...linksTo.keys()].sort()) {
          const candidate = gain(label);
          if (candidate > bestGain + 1e-12) {
            best = label;
            bestGain = candidate;
          }
        }
        totalDegree.set(best, totalDegree.get(best)! + k);
        if (best !== current) {
          community.set(node, best);
          moved = true;
        }
      }
      if (!moved) break;
    }
  }
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const label = community.get(node)!;
    groups.set(label, [...(groups.get(label) || []), node]);
  }
  return [...groups.values()]
    .map((members) => members.sort())
    .sort(
      (left, right) =>
        right.length - left.length || left[0].localeCompare(right[0]),
    )
    .map((members, index) => {
      const set = new Set(members);
      return {
        communityId: `C${index + 1}`,
        members,
        edgeIds: edges
          .filter((edge) => set.has(edge.source) && set.has(edge.target))
          .map((edge) => edge.edgeId),
      };
    });
}

export type ChronologyEntry = Readonly<{
  identity: string;
  year?: string;
  /** Edges that lead forward in time from this paper. */
  forwardEdgeIds: readonly string[];
}>;

export function computeChronology(params: {
  nodes: readonly { identity: string; year?: string }[];
  edges: readonly ResearchEdge[];
}): ChronologyEntry[] {
  const yearOf = new Map(
    params.nodes.map((node) => [node.identity, node.year]),
  );
  const numeric = (identity: string) => {
    const value = Number(yearOf.get(identity));
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  };
  const edges = structuralEdges(params.edges);
  return [...params.nodes]
    .sort(
      (left, right) =>
        numeric(left.identity) - numeric(right.identity) ||
        left.identity.localeCompare(right.identity),
    )
    .map((node) => ({
      identity: node.identity,
      ...(node.year ? { year: node.year } : {}),
      forwardEdgeIds: edges
        .filter((edge) => {
          const ends = [edge.source, edge.target];
          if (!ends.includes(node.identity)) return false;
          const other = ends.find((end) => end !== node.identity)!;
          return numeric(other) > numeric(node.identity);
        })
        .map((edge) => edge.edgeId),
    }));
}

export type StructuralGaps = Readonly<{
  isolatedNodes: readonly string[];
  thinSubquestions: readonly Readonly<{
    subquestionId: string;
    claims: number;
  }>[];
  unresolvedContradictions: readonly string[];
  tentativeEdges: readonly string[];
  openQuestions: readonly string[];
}>;

export function computeStructuralGaps(params: {
  corpus: readonly ResearchCorpusItem[];
  findings: readonly PaperFinding[];
  edges: readonly ResearchEdge[];
  questions: readonly ResearchOpenQuestion[];
  subquestions: readonly ResearchSubquestion[];
}): StructuralGaps {
  const edges = structuralEdges(params.edges);
  const touched = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  const nodes = new Set(
    params.findings.map((finding) => `${finding.libraryID}:${finding.itemKey}`),
  );
  const isolatedNodes = params.corpus
    .filter((item) => item.screeningStatus !== "missing")
    .map((item) => `${item.libraryID}:${item.itemKey}`)
    .filter((identity) => nodes.has(identity) && !touched.has(identity));
  const claimsPerSubquestion = new Map<string, number>();
  for (const finding of params.findings) {
    const claims = finding.claims || [];
    if (claims.length) {
      for (const claim of claims) {
        for (const id of claim.subquestionIds) {
          claimsPerSubquestion.set(id, (claimsPerSubquestion.get(id) || 0) + 1);
        }
      }
    } else {
      for (const id of finding.subquestionIds) {
        claimsPerSubquestion.set(id, (claimsPerSubquestion.get(id) || 0) + 1);
      }
    }
  }
  const thinSubquestions = params.subquestions
    .map((subquestion) => ({
      subquestionId: subquestion.id,
      claims: claimsPerSubquestion.get(subquestion.id) || 0,
    }))
    .filter((entry) => entry.claims < 2);
  return {
    isolatedNodes,
    thinSubquestions,
    unresolvedContradictions: params.edges
      .filter(
        (edge) =>
          edge.lifecycle === "valid" &&
          edge.type === "contradicts" &&
          (edge.status === "candidate" || edge.status === "tentative"),
      )
      .map((edge) => edge.edgeId),
    tentativeEdges: edges
      .filter((edge) => edge.status === "tentative")
      .map((edge) => edge.edgeId),
    openQuestions: params.questions
      .filter(
        (question) =>
          question.lifecycle === "valid" && question.status === "open",
      )
      .map((question) => question.questionId),
  };
}

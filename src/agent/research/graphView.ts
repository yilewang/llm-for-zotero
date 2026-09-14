import {
  computeChronology,
  computeCommunities,
  computeStructuralGaps,
} from "./graphStructure";
import { currentPhase } from "./graphLoop";
import {
  listPaperFindings,
  listResearchEdges,
  listResearchOpenQuestions,
  listThemeFindings,
} from "./store";
import type {
  ResearchContract,
  ResearchCorpusItem,
  ResearchJob,
  ResearchScopeSnapshotItem,
} from "./types";

/**
 * The synthesis view: every node in one line, the edge list, host-computed
 * communities, chronology and structural gaps, open questions and themes.
 * The document is written from this view, so every cross-paper sentence can
 * be traced to an edge and every cited sentence to a claim.
 */
export async function buildGraphView(params: {
  job: ResearchJob;
  corpus: readonly ResearchCorpusItem[];
  investigation: ResearchContract;
  snapshotByKey: ReadonlyMap<string, ResearchScopeSnapshotItem>;
  displayLabels: ReadonlyMap<string, string>;
}) {
  const [findings, edges, questions, themes] = await Promise.all([
    listPaperFindings(params.job.researchJobId),
    listResearchEdges(params.job.researchJobId),
    listResearchOpenQuestions(params.job.researchJobId),
    listThemeFindings(params.job.researchJobId, params.job.scopeLineageDigest),
  ]);
  const tierOf = new Map(
    params.corpus.map((item) => [
      `${item.libraryID}:${item.itemKey}`,
      item.tier,
    ]),
  );
  const nodes = findings.map((finding) => {
    const identity = `${finding.libraryID}:${finding.itemKey}`;
    return {
      identity,
      displayLabel: params.displayLabels.get(identity),
      year: params.snapshotByKey.get(identity)?.year,
      tier: finding.tier || tierOf.get(identity) || "core",
      mainMessage: finding.mainMessage,
      claimIds: (finding.claims || []).map((claim) => claim.claimId),
      hooks: finding.hooks,
    };
  });
  const identities = nodes.map((node) => node.identity);
  const communities = computeCommunities({ nodes: identities, edges });
  const gaps = computeStructuralGaps({
    corpus: params.corpus,
    findings,
    edges,
    questions,
    subquestions: params.investigation.subquestions,
  });
  return {
    phase: currentPhase(params.job),
    frame: params.job.frame,
    nodes,
    edges: edges.map((edge) => ({
      edgeId: edge.edgeId,
      source: edge.source,
      target: edge.target,
      type: edge.type,
      status: edge.status,
      statement: edge.statement,
      confidence: edge.confidence,
      sourceClaimIds: edge.sourceClaimIds,
      targetClaimIds: edge.targetClaimIds,
      subquestionIds: edge.subquestionIds,
      ...(edge.verification?.note ? { note: edge.verification.note } : {}),
    })),
    communities,
    chronology: computeChronology({
      nodes: nodes.map((node) => ({
        identity: node.identity,
        year: node.year,
      })),
      edges,
    }),
    gaps,
    openQuestions: questions
      .filter((question) => question.status === "open")
      .map((question) => ({
        questionId: question.questionId,
        text: question.text,
        scope: question.scope,
        priority: question.priority,
        origin: question.origin,
      })),
    themes: themes.map((theme) => ({
      themeFindingId: theme.themeFindingId,
      title: theme.title,
      paperFindingIds: theme.paperFindingIds,
      edgeIds: theme.edgeIds || [],
      communityId: theme.communityId,
    })),
    instruction:
      "Themes are communities: record each with record_themes naming its edgeIds and communityId, synthesize from the edges (not from juxtaposed summaries), and turn the structural gaps into open questions or the gaps section. Cite verified edges as established relationships and tentative ones with hedged wording.",
  };
}

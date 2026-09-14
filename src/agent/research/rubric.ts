import type {
  PaperFinding,
  ResearchCorpusItem,
  ResearchEdge,
  ResearchOpenQuestion,
  ResearchQualityReport,
  ResearchSubquestion,
  ThemeFinding,
} from "./types";

/**
 * The quality rubric every flight is measured against. It counts what the
 * durable network actually holds (claims with locators, verified edges,
 * contradictions surfaced, subquestion coverage, themes bound to edges) and,
 * when a document exists, how many cross-paper paragraphs an edge supports.
 * Time is not in the rubric on purpose: it is reported separately.
 */
export function computeResearchQualityReport(params: {
  corpus: readonly ResearchCorpusItem[];
  findings: readonly PaperFinding[];
  edges: readonly ResearchEdge[];
  questions: readonly ResearchOpenQuestion[];
  themes: readonly ThemeFinding[];
  subquestions: readonly ResearchSubquestion[];
  audit?: { crossPaperParagraphs: number; supported: number };
  now?: number;
}): ResearchQualityReport {
  const edges = params.edges.filter(
    (edge) => edge.lifecycle === "valid" && edge.status !== "merged",
  );
  const touched = new Set(
    edges
      .filter((edge) => edge.status !== "refuted")
      .flatMap((edge) => [edge.source, edge.target]),
  );
  const claims = params.findings.flatMap((finding) => finding.claims || []);
  const subquestionClaims: Record<string, number> = {};
  for (const subquestion of params.subquestions)
    subquestionClaims[subquestion.id] = 0;
  for (const finding of params.findings) {
    const entries = finding.claims?.length
      ? finding.claims.flatMap((claim) => claim.subquestionIds)
      : finding.subquestionIds;
    for (const id of entries) {
      subquestionClaims[id] = (subquestionClaims[id] || 0) + 1;
    }
  }
  const themes = params.themes.filter(
    (theme) => theme.status !== "invalidated",
  );
  const questions = params.questions.filter(
    (question) => question.lifecycle === "valid",
  );
  return {
    version: 1,
    computedAt: params.now ?? Date.now(),
    papers: params.corpus.filter((item) => item.screeningStatus !== "missing")
      .length,
    nodes: params.findings.length,
    claims: claims.length,
    claimsWithLocators: claims.filter(
      (claim) =>
        claim.evidence.verified === true ||
        (claim.evidence.pageIndex !== undefined && claim.evidence.verified),
    ).length,
    nodesWithEdges: params.findings.filter((finding) =>
      touched.has(`${finding.libraryID}:${finding.itemKey}`),
    ).length,
    edges: edges.length,
    edgesVerified: edges.filter((edge) => edge.status === "verified").length,
    edgesTentative: edges.filter((edge) => edge.status === "tentative").length,
    edgesRefuted: edges.filter((edge) => edge.status === "refuted").length,
    contradictions: edges.filter((edge) => edge.type === "contradicts").length,
    subquestionClaims,
    themes: themes.length,
    themesWithEdges: themes.filter((theme) => (theme.edgeIds || []).length > 0)
      .length,
    openQuestions: questions.filter((question) => question.status === "open")
      .length,
    answeredQuestions: questions.filter(
      (question) => question.status === "answered",
    ).length,
    ...(params.audit
      ? {
          crossPaperParagraphs: params.audit.crossPaperParagraphs,
          crossPaperParagraphsSupported: params.audit.supported,
        }
      : {}),
  };
}

/** One line for evidence summaries and progress text. */
export function summarizeQualityReport(report: ResearchQualityReport): string {
  const parts = [
    `${report.nodes} nodes`,
    `${report.claims} claims (${report.claimsWithLocators} with verified locators)`,
    `${report.edges} relationships (${report.edgesVerified} verified, ${report.edgesTentative} tentative, ${report.edgesRefuted} refuted)`,
    `${report.contradictions} contradictions surfaced`,
    `${report.themes} themes (${report.themesWithEdges} bound to edges)`,
  ];
  if (report.crossPaperParagraphs !== undefined) {
    parts.push(
      `${report.crossPaperParagraphsSupported ?? 0}/${report.crossPaperParagraphs} cross-paper paragraphs backed by an edge`,
    );
  }
  return parts.join("; ");
}

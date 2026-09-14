import { buildPaperDisplayLabels } from "../../shared/paperDisplayLabels";
import type { TaskEvidence } from "../plans/types";
import type { ResearchUpdateInput } from "./commands";
import { selectPreferredVerifiedReads } from "./reading";
import {
  listPaperFindings,
  listResearchEdges,
  listResearchEvidence,
  listThemeFindings,
} from "./store";
import type {
  ResearchJob,
  ResearchContract,
  ResearchCorpusItem,
  ResearchScopeSnapshotItem,
} from "./types";

export async function inspectResearch(params: {
  input: ResearchUpdateInput;
  job: ResearchJob;
  investigation: ResearchContract;
  corpus: ResearchCorpusItem[];
  snapshotByKey: Map<string, ResearchScopeSnapshotItem>;
  taskEvidence: TaskEvidence[];
}) {
  const { input, job, investigation, corpus, snapshotByKey, taskEvidence } =
    params;
  const corpusByKey = new Map(
    corpus.map((entry) => [`${entry.libraryID}:${entry.itemKey}`, entry]),
  );
  if (input.operation === "list_verified_reads") {
    const preferredByPaper = selectPreferredVerifiedReads(
      taskEvidence,
      new Set(corpusByKey.keys()),
    );
    const [recordedFindings, durableEvidence] = await Promise.all([
      listPaperFindings(job.researchJobId),
      listResearchEvidence(job.researchJobId),
    ]);
    const findingByPaper = new Map(
      recordedFindings.map((entry) => [
        `${entry.libraryID}:${entry.itemKey}`,
        entry,
      ]),
    );
    const bodyEvidenceKeys = new Set(
      durableEvidence
        .filter(
          (entry) =>
            entry.version === 2 &&
            Boolean(entry.observationId) &&
            ["body", "figure", "quote"].includes(entry.sourceKind),
        )
        .map((entry) => `${entry.libraryID}:${entry.itemKey}`),
    );
    return {
      researchContract: {
        criteria: investigation.criteria,
        subquestions: investigation.subquestions,
        requiredEvidenceDepth: investigation.requiredEvidenceDepth,
      },
      papers: corpus.map((entry) => {
        const identity = `${entry.libraryID}:${entry.itemKey}`;
        const finding = findingByPaper.get(identity);
        return {
          identity,
          screeningStatus: entry.screeningStatus,
          criterionResults: entry.criterionResults,
          findingRecorded: Boolean(finding),
          findingId: finding?.findingId,
          evidenceRefs: finding?.evidenceRefs || [],
          bodyEvidenceRecorded: bodyEvidenceKeys.has(identity),
        };
      }),
      findingRecovery: {
        operation: "list_findings",
        totalFindings: recordedFindings.length,
        pageSize: 20,
        instruction:
          "Page durable normalized findings before synthesis; do not recover old tool handles or reread PDFs.",
      },
      verifiedReads: [...preferredByPaper.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([identity, entry]) => ({ identity, ...entry })),
    };
  }
  if (input.operation === "list_findings") {
    const findings = await listPaperFindings(job.researchJobId);
    const preferredByPaper = selectPreferredVerifiedReads(
      taskEvidence,
      new Set(corpusByKey.keys()),
    );
    const corpusOrdinal = new Map(
      corpus.map((entry) => [
        `${entry.libraryID}:${entry.itemKey}`,
        entry.ordinal,
      ]),
    );
    findings.sort(
      (left, right) =>
        (corpusOrdinal.get(`${left.libraryID}:${left.itemKey}`) ??
          Number.MAX_SAFE_INTEGER) -
        (corpusOrdinal.get(`${right.libraryID}:${right.itemKey}`) ??
          Number.MAX_SAFE_INTEGER),
    );
    const compact =
      input.view === "compact" ||
      (input.view === undefined && Boolean(job.frame));
    const cursor = input.cursor || 0;
    const limit =
      input.limit ||
      (compact
        ? Math.max(20, job.nodeCapacity?.fullNodeCapacity || 0, findings.length)
        : 20);
    const labels = buildPaperDisplayLabels(
      [...snapshotByKey.values()].map((entry) => ({
        ...entry,
        identity: `${entry.libraryID}:${entry.itemKey}`,
      })),
    );
    if (compact) {
      const edges = await listResearchEdges(job.researchJobId);
      const edgeCount = new Map<string, number>();
      for (const edge of edges) {
        if (edge.status === "merged") continue;
        for (const end of [edge.source, edge.target]) {
          edgeCount.set(end, (edgeCount.get(end) || 0) + 1);
        }
      }
      const tierByIdentity = new Map(
        corpus.map((entry) => [
          `${entry.libraryID}:${entry.itemKey}`,
          entry.tier,
        ]),
      );
      const compactPage = findings
        .slice(cursor, cursor + limit)
        .map((finding) => {
          const identity = `${finding.libraryID}:${finding.itemKey}`;
          return {
            identity,
            displayLabel: labels.get(identity),
            year: snapshotByKey.get(identity)?.year,
            tier: finding.tier || tierByIdentity.get(identity) || "core",
            evidenceDepth:
              preferredByPaper.get(identity)?.evidenceDepth || "metadata",
            mainMessage: finding.mainMessage,
            frameSlots: finding.frameSlots || {},
            claims: (finding.claims || []).map((claim) => ({
              claimId: claim.claimId,
              kind: claim.kind,
              statement: claim.statement.slice(0, 240),
              subquestionIds: claim.subquestionIds,
              evidence: claim.evidence.sourceKind,
              ...(claim.evidence.verified ? { verified: true } : {}),
            })),
            hooks: finding.hooks,
            candidateLinks: finding.candidateLinks,
            noLinkSeen: finding.noLinkSeen,
            questionsRaised: finding.questionsRaised,
            edgeCount: edgeCount.get(identity) || 0,
          };
        });
      const compactNext = cursor + compactPage.length;
      return {
        view: "compact",
        phase: job.synthesisPhase || "nodes",
        frame: job.frame,
        findings: compactPage,
        nextCursor: compactNext < findings.length ? compactNext : null,
        totalFindings: findings.length,
        instruction:
          "Every node is in view. Record the explicit typed edge list with record_edges: for each real relationship name source, target, type, the claim ids it rests on, a one-sentence statement and confidence. Candidate links are suggestions, not edges.",
      };
    }
    const page = findings.slice(cursor, cursor + limit).map((finding) => ({
      displayLabel: labels.get(`${finding.libraryID}:${finding.itemKey}`),
      findingId: finding.findingId,
      identity: `${finding.libraryID}:${finding.itemKey}`,
      title: snapshotByKey.get(`${finding.libraryID}:${finding.itemKey}`)
        ?.title,
      firstCreator: snapshotByKey.get(`${finding.libraryID}:${finding.itemKey}`)
        ?.firstCreator,
      year: snapshotByKey.get(`${finding.libraryID}:${finding.itemKey}`)?.year,
      evidenceDepth:
        preferredByPaper.get(`${finding.libraryID}:${finding.itemKey}`)
          ?.evidenceDepth || "metadata",
      subquestionIds: finding.subquestionIds,
      criterionIds: finding.criterionIds,
      findings: finding.findings,
      contradictions: finding.contradictions,
      negativeEvidence: finding.negativeEvidence,
      limitations: finding.limitations,
      evidenceRefs: finding.evidenceRefs,
      inclusionDecision: finding.inclusionDecision,
      confidence: finding.confidence,
      unresolvedQuestions: finding.unresolvedQuestions,
      roles: finding.roles,
      mainMessage: finding.mainMessage,
      researchQuestion: finding.researchQuestion,
      method: finding.method,
      mechanisms: finding.mechanisms,
      relevance: finding.relevance,
      relationships: finding.relationships,
    }));
    const nextCursor = cursor + page.length;
    return {
      findings: page,
      nextCursor: nextCursor < findings.length ? nextCursor : null,
      totalFindings: findings.length,
    };
  }
  if (input.operation === "list_themes") {
    const themes = await listThemeFindings(
      job.researchJobId,
      job.scopeLineageDigest,
    );
    return {
      themes: themes.map((theme) => ({
        themeFindingId: theme.themeFindingId,
        title: theme.title,
        synthesis: theme.synthesis,
        paperFindingIds: theme.paperFindingIds,
        evidenceRefs: theme.evidenceRefs,
        limitations: theme.limitations,
        ...(theme.edgeIds ? { edgeIds: theme.edgeIds } : {}),
        ...(theme.communityId ? { communityId: theme.communityId } : {}),
      })),
      totalThemes: themes.length,
      instruction: themes.length
        ? "Use these durable theme reductions for the synthesis task and document; do not recover old tool handles or reread papers."
        : "No durable themes are recorded yet; synthesize from list_findings and persist them with record_themes.",
    };
  }
}

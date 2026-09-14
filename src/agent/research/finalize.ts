import { planExecutionCoordinator } from "../plans/coordinator";
import { loadPlanExecutionLedger } from "../plans/store";
import { type ResearchUpdateInput } from "./commands";
import { recomputeJob } from "./progress";
import { isCriterionCompleteScreeningDecision } from "./recordValidation";
import { computeResearchQualityReport, summarizeQualityReport } from "./rubric";
import {
  listPaperFindings,
  listResearchCorpusItems,
  listResearchEdges,
  listResearchEvidence,
  listResearchOpenQuestions,
  listThemeFindings,
} from "./store";
import type { ResearchJob } from "./types";

import type { PlanArtifact } from "../plans/types";
import type { AgentToolContext } from "../types";
import type { ResearchContract } from "./types";

export async function finalizeResearch(params: {
  job: ResearchJob;
  input: Extract<ResearchUpdateInput, { operation: "finalize" }>;
  next: ResearchJob;
  artifact: PlanArtifact;
  investigation: ResearchContract;
  context: AgentToolContext;
  plan: Extract<
    NonNullable<AgentToolContext["request"]["planContext"]>,
    { phase: "executing" }
  >;
}) {
  const { job, input, artifact, investigation, context, plan } = params;
  let { next } = params;

  const allCorpus = await listResearchCorpusItems({
    researchJobId: job.researchJobId,
  });
  const findings = await listPaperFindings(job.researchJobId);
  const themes = await listThemeFindings(
    job.researchJobId,
    job.scopeLineageDigest,
  );
  const allEvidence = await listResearchEvidence(job.researchJobId);
  if (input.outcome === "partial") {
    const grant = next.exceptionGrant;
    const countersMatch =
      grant?.totalItems === next.totalItems &&
      grant.screenedItems === next.screenedItems &&
      grant.candidateItems === next.candidateItems &&
      grant.deepReadCompleted === next.deepReadCompleted;
    if (
      !grant ||
      grant.status !== "authorized" ||
      grant.planDigest !== artifact.digest ||
      grant.executionId !== next.executionId ||
      grant.researchJobId !== next.researchJobId ||
      !countersMatch
    ) {
      throw new Error(
        "Partial research finalization requires a current user-authorized ResearchExceptionGrant from the expansion checkpoint",
      );
    }
  }
  if (input.outcome === "complete") {
    const unfinished = allCorpus.filter(
      (entry) =>
        !entry.inventoryRecorded ||
        ["pending", "candidate"].includes(entry.screeningStatus),
    );
    if (unfinished.length) {
      throw new Error(`${unfinished.length} frozen papers are not terminal`);
    }
    const invalidDecisions = allCorpus.filter(
      (entry) =>
        !isCriterionCompleteScreeningDecision({
          entry,
          criteria: investigation.criteria,
          totalItems: next.totalItems,
          deepReadPlanned: next.deepReadPlanned,
        }),
    );
    if (invalidDecisions.length) {
      throw new Error(
        `${invalidDecisions.length} papers lack criterion-complete screening decisions`,
      );
    }
    const findingKeys = new Set(
      findings.map((entry) => `${entry.libraryID}:${entry.itemKey}`),
    );
    const findingByKey = new Map(
      findings.map((finding) => [
        `${finding.libraryID}:${finding.itemKey}`,
        finding,
      ]),
    );
    const missingFindings = allCorpus.filter(
      (entry) =>
        entry.screeningStatus !== "missing" &&
        !findingKeys.has(`${entry.libraryID}:${entry.itemKey}`),
    );
    if (missingFindings.length) {
      throw new Error(
        `${missingFindings.length} screened papers lack per-paper findings`,
      );
    }
    const mismatchedFindings = allCorpus.filter((entry) => {
      const finding = findingByKey.get(`${entry.libraryID}:${entry.itemKey}`);
      if (!finding) return false;
      const expected =
        entry.screeningStatus === "included"
          ? "include"
          : entry.screeningStatus === "excluded"
            ? "exclude"
            : "unresolved";
      return finding.inclusionDecision !== expected;
    });
    if (mismatchedFindings.length) {
      throw new Error(
        `${mismatchedFindings.length} paper findings conflict with screening decisions`,
      );
    }
    if (investigation.requiredEvidenceDepth === "body") {
      const bodyKeys = new Set(
        allEvidence
          .filter(
            (entry) =>
              entry.version === 2 &&
              Boolean(entry.observationId) &&
              ["body", "quote", "figure"].includes(entry.sourceKind),
          )
          .map((entry) => `${entry.libraryID}:${entry.itemKey}`),
      );
      const shallow = allCorpus.filter(
        (entry) =>
          entry.screeningStatus === "included" &&
          !bodyKeys.has(`${entry.libraryID}:${entry.itemKey}`),
      );
      if (shallow.length) {
        const identities = shallow
          .map((entry) => `${entry.libraryID}:${entry.itemKey}`)
          .join(", ");
        throw new Error(
          `${shallow.length} included papers lack required body evidence: ${identities}. Deep-read them, or if they were screened but not selected for the bounded deep-read subset, record screeningStatus "excluded" with an explicit relative-ranking decisionReason; excluded papers remain in frozen coverage.`,
        );
      }
    }
    if (
      allCorpus.some((entry) => entry.screeningStatus === "included") &&
      !themes.length
    ) {
      throw new Error(
        "Hierarchical synthesis requires at least one durable theme finding",
      );
    }
    const retainedFindingIds = new Set(
      themes.flatMap((theme) => theme.paperFindingIds),
    );
    const unretainedIncluded = findings.filter(
      (finding) =>
        finding.inclusionDecision === "include" &&
        !retainedFindingIds.has(finding.findingId),
    );
    if (unretainedIncluded.length) {
      throw new Error(
        `${unretainedIncluded.length} included paper findings were not retained in hierarchical synthesis`,
      );
    }
  }
  const hasLimitations = allCorpus.some((entry) =>
    ["unresolved", "unreadable", "missing"].includes(entry.screeningStatus),
  );
  const coverageStatus =
    input.outcome === "partial"
      ? "partial"
      : input.outcome === "failed"
        ? "failed"
        : hasLimitations
          ? "complete_with_limitations"
          : "complete";
  const qualityReport = job.frame
    ? computeResearchQualityReport({
        corpus: allCorpus,
        findings,
        edges: await listResearchEdges(job.researchJobId),
        questions: await listResearchOpenQuestions(job.researchJobId),
        themes,
        subquestions: investigation.subquestions,
      })
    : undefined;
  next = await recomputeJob({
    job: {
      ...(input.outcome === "partial" && next.exceptionGrant
        ? {
            ...next,
            exceptionGrant: {
              ...next.exceptionGrant,
              status: "consumed",
              consumedAt: Date.now(),
            },
          }
        : next),
      ...(qualityReport ? { qualityReport } : {}),
      ...(job.frame && input.outcome !== "failed"
        ? { synthesisPhase: "complete" as const }
        : {}),
    },
    conversationKey: context.request.conversationKey,
    activeStage: "hierarchical_synthesis",
    status: input.outcome === "failed" ? "failed" : "completed",
    coverageStatus,
  });
  const ledger = await loadPlanExecutionLedger(plan.executionId);
  const task = ledger?.tasks.find((entry) => entry.taskId === job.parentTaskId);
  const requirement = task?.completionRequirements?.find(
    (entry) => entry.kind === "research_coverage",
  );
  if (!ledger || !task || !requirement) {
    throw new Error("Research coverage requirement is unavailable");
  }
  await planExecutionCoordinator.attachEvidence({
    version: 3,
    evidenceId: `${job.researchJobId}:coverage:${coverageStatus}`,
    executionId: job.executionId,
    taskId: job.parentTaskId,
    kind: "research_coverage",
    verified:
      coverageStatus === "complete" ||
      coverageStatus === "complete_with_limitations",
    requirementId: requirement.requirementId,
    criterionIds: requirement.criterionIds,
    contractDigest: requirement.contractDigest,
    payload: {
      type: "research_coverage",
      researchJobId: job.researchJobId,
      coverageStatus,
      totalItems: next.totalItems,
      screenedItems: next.screenedItems,
      candidateItems: next.candidateItems,
      deepReadCompleted: next.deepReadCompleted,
      scopeLineageDigest: next.scopeLineageDigest,
    },
    reference: job.researchJobId,
    summary: `Coverage ${coverageStatus}: screened ${next.screenedItems}/${next.totalItems}; deep-read ${next.deepReadCompleted}/${next.candidateItems}${
      qualityReport ? `; ${summarizeQualityReport(qualityReport)}` : ""
    }`,
    createdAt: Date.now(),
  });
  if (coverageStatus === "partial") {
    // The user's partial-coverage grant closes every research-owned task that
    // the job could not complete: the scope-bound reading task and coverage.
    const unfinishedReadingTasks = ledger.tasks.filter(
      (entry) =>
        entry.taskId !== job.parentTaskId &&
        !["completed", "skipped", "cancelled"].includes(entry.status) &&
        entry.completionRequirements?.some(
          (requirement) =>
            requirement.kind === "verified_read" &&
            Boolean(requirement.targetBoundary?.scopeDigest),
        ),
    );
    let exceptionLedger = ledger;
    for (const readingTask of unfinishedReadingTasks) {
      exceptionLedger = await planExecutionCoordinator.requestTransition({
        executionId: job.executionId,
        taskId: readingTask.taskId,
        toStatus: "skipped",
        requestedBy: "user",
        reason: next.exceptionGrant?.limitationSummary,
      });
    }
    exceptionLedger = await planExecutionCoordinator.requestTransition({
      executionId: job.executionId,
      taskId: job.parentTaskId,
      toStatus: "skipped",
      requestedBy: "user",
      reason: next.exceptionGrant?.limitationSummary,
    });
    exceptionLedger = await planExecutionCoordinator.startNextTask(
      job.executionId,
    );
    await context.publishPlanEvent?.({
      type: "plan_execution_updated",
      ledger: exceptionLedger,
    });
  } else if (
    coverageStatus === "complete" ||
    coverageStatus === "complete_with_limitations"
  ) {
    const advancedLedger = await planExecutionCoordinator.advanceVerifiedTasks({
      executionId: job.executionId,
      requirementKinds: ["verified_read", "research_coverage"],
    });
    await context.publishPlanEvent?.({
      type: "plan_execution_updated",
      ledger: advancedLedger,
    });
  }

  return next;
}

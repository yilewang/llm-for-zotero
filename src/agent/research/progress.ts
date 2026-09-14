import { type ResearchStage } from "./policy";
import {
  commitResearchRecords,
  recoverableResearchStage,
  storedResearchEligibility,
  validateStoredResearchTransition,
} from "./stages";
import {
  listResearchCorpusItems,
  listResearchEvidence,
  saveResearchJob,
} from "./store";
import type { ResearchJob, ResearchProgress } from "./types";

export function progress(job: ResearchJob): ResearchProgress {
  return {
    researchJobId: job.researchJobId,
    executionId: job.executionId,
    parentTaskId: job.parentTaskId,
    stage: job.activeStage,
    totalItems: job.totalItems,
    screenedItems: job.screenedItems,
    candidateItems: job.candidateItems,
    deepReadCompleted: job.deepReadCompleted,
    deepReadPlanned: job.deepReadPlanned,
    coverageStatus: job.coverageStatus,
    ...(job.synthesisPhase ? { phase: job.synthesisPhase } : {}),
    ...(job.qualityReport ? { quality: job.qualityReport } : {}),
  };
}
export async function recomputeJob(params: {
  job: ResearchJob;
  conversationKey: number;
  activeStage?: ResearchStage;
  status?: ResearchJob["status"];
  coverageStatus?: ResearchJob["coverageStatus"];
  adaptive?: boolean;
}): Promise<ResearchJob> {
  return commitResearchRecords(params.job, async () => {
    const corpus = await listResearchCorpusItems({
      researchJobId: params.job.researchJobId,
    });
    const evidence = await listResearchEvidence(params.job.researchJobId);
    const bodyKeys = new Set(
      evidence
        .filter(
          (entry) =>
            entry.version === 2 &&
            Boolean(entry.observationId) &&
            ["body", "figure", "quote"].includes(entry.sourceKind),
        )
        .map((entry) => `${entry.libraryID}:${entry.itemKey}`),
    );
    const candidateItems = corpus.filter((entry) =>
      ["candidate", "included", "unresolved", "unreadable"].includes(
        entry.screeningStatus,
      ),
    ).length;
    const now = Math.max(Date.now(), params.job.updatedAt + 1);
    const next: ResearchJob = {
      ...params.job,
      status: params.status || "running",
      activeStage: params.activeStage || params.job.activeStage,
      coverageStatus: params.coverageStatus,
      screenedItems: corpus.filter(
        (entry) => entry.screeningStatus !== "pending",
      ).length,
      candidateItems,
      deepReadCompleted: bodyKeys.size,
      deepReadPlanned: params.job.deepReadPlanned,
      updatedAt: now,
      completedAt:
        params.status === "completed" || params.status === "failed"
          ? now
          : undefined,
    };
    if (params.activeStage && !params.status)
      await validateStoredResearchTransition(
        params.job,
        params.activeStage,
        Boolean(params.adaptive),
      );
    await saveResearchJob(next, params.conversationKey);
    return next;
  });
}

/** Recovery repairs only bookkeeping; durable findings and completed work remain intact. */
export async function reconcileResearchStage(
  job: ResearchJob,
  conversationKey: number,
  adaptive: boolean,
): Promise<ResearchJob> {
  return commitResearchRecords(job, async () => {
    const stage = recoverableResearchStage(
      await storedResearchEligibility(job, adaptive),
    );
    if (stage === job.activeStage) return job;
    const recovered = {
      ...job,
      activeStage: stage,
      updatedAt: Math.max(Date.now(), job.updatedAt + 1),
    };
    await saveResearchJob(recovered, conversationKey);
    return recovered;
  });
}

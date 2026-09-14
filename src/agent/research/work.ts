import { type ResearchStage } from "./policy";
import { loadResearchWorkItem, saveResearchWorkItem } from "./store";
import type { ResearchJob } from "./types";
export type CompleteResearchWorkItem = (params: {
  libraryID: number;
  itemKey: string;
  stage: ResearchStage;
  evidenceRefs?: readonly string[];
  subquestionIds?: readonly string[];
}) => Promise<void>;
export async function completeResearchWorkItem(
  job: ResearchJob,
  params: {
    libraryID: number;
    itemKey: string;
    stage: ResearchStage;
    evidenceRefs?: readonly string[];
    subquestionIds?: readonly string[];
  },
) {
  const workItemId = `${job.researchJobId}:work:${params.stage}:${params.libraryID}:${params.itemKey}`;
  const existing = await loadResearchWorkItem(workItemId);
  const now = Date.now();
  await saveResearchWorkItem({
    version: 1,
    workItemId,
    researchJobId: job.researchJobId,
    executionId: job.executionId,
    parentTaskId: job.parentTaskId,
    libraryID: params.libraryID,
    itemKey: params.itemKey,
    stage: params.stage,
    subquestionIds: [...(params.subquestionIds || [])],
    status: "completed",
    attemptCount: Math.max(1, existing?.attemptCount || 0),
    evidenceRefs: [...new Set(params.evidenceRefs || [])],
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  });
}

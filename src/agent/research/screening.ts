import { resolveOutputReserve } from "../../utils/outputTokenPolicy";
import { progress, recomputeJob } from "./progress";
import {
  buildAdaptiveScreeningBatch,
  type ScreeningBatchPaper,
} from "./screeningBatch";
import {
  claimResearchWorkItems,
  listResearchWorkItems,
  loadResearchWorkItem,
  saveResearchWorkItem,
} from "./store";
import type { ResearchCorpusItem, ResearchJob } from "./types";

import type { AgentToolContext } from "../types";
import type { ResearchContract } from "./types";

export async function nextScreenBatch(params: {
  adaptiveReview: boolean;
  job: ResearchJob;
  corpus: ResearchCorpusItem[];
  context: AgentToolContext;
  investigation: ResearchContract;
}) {
  const { adaptiveReview, job, corpus, context, investigation } = params;

  if (adaptiveReview) {
    throw new Error(
      "Adaptive narrative and scoping reviews read the inventory manifest directly; next_screen_batch is only for systematic review",
    );
  }
  if (job.activeStage !== "broad_screening") {
    throw new Error(
      "next_screen_batch is available only during broad screening",
    );
  }
  if (corpus.some((entry) => !entry.inventoryRecorded)) {
    throw new Error(
      "Inventory is incomplete; call inventory_scope before requesting screening work",
    );
  }
  const pendingCorpus = corpus.filter(
    (entry) => entry.screeningStatus === "pending",
  );
  const activeWork = await listResearchWorkItems({
    researchJobId: job.researchJobId,
    stage: "broad_screening",
    statuses: ["in_progress"],
  });
  const activeIdentities = new Set(
    activeWork.map((entry) => `${entry.libraryID}:${entry.itemKey}`),
  );
  const availableCorpus = activeWork.length
    ? pendingCorpus.filter((entry) =>
        activeIdentities.has(`${entry.libraryID}:${entry.itemKey}`),
      )
    : pendingCorpus;
  const materialized: ScreeningBatchPaper[] = availableCorpus.map((entry) => {
    const item = Zotero.Items.getByLibraryAndKey(
      entry.libraryID,
      entry.itemKey,
    );
    const field = (name: string) =>
      String(item && item.getField?.(name) ? item.getField(name) : "").trim();
    return {
      libraryID: entry.libraryID,
      itemKey: entry.itemKey,
      ordinal: entry.ordinal,
      title: field("title") || "Untitled item",
      abstract: field("abstractNote"),
      year: field("year") || field("date") || undefined,
      firstCreator: field("firstCreator") || undefined,
      hasAbstract: entry.hasAbstract,
      readable: entry.readable,
      indexed: entry.indexed,
    };
  });
  const outputTokenBudget = resolveOutputReserve(
    context.request.advanced?.outputTokenLimit,
    context.request.model || context.modelName,
    {
      apiBase: context.request.apiBase,
      protocol: context.request.providerProtocol,
      authMode: context.request.authMode,
      profileOverride: context.request.advanced?.profileOverride,
    },
  );
  const projected = buildAdaptiveScreeningBatch({
    papers: materialized,
    criterionIds: investigation.criteria.map((entry) => entry.id),
    outputTokenBudget,
    maxPapersPerUpdate: Math.max(1, materialized.length),
  });
  let issued = [...projected.papers];
  if (!activeWork.length && issued.length) {
    const createdAt = Date.now();
    for (const paper of issued) {
      const workItemId = `${job.researchJobId}:work:broad_screening:${paper.libraryID}:${paper.itemKey}`;
      if (await loadResearchWorkItem(workItemId)) continue;
      await saveResearchWorkItem({
        version: 1,
        workItemId,
        researchJobId: job.researchJobId,
        executionId: job.executionId,
        parentTaskId: job.parentTaskId,
        libraryID: paper.libraryID,
        itemKey: paper.itemKey,
        stage: "broad_screening",
        subquestionIds: [],
        status: "pending",
        attemptCount: 0,
        evidenceRefs: [],
        createdAt: createdAt + paper.ordinal,
        updatedAt: createdAt,
      });
    }
    const claimed = await claimResearchWorkItems({
      researchJobId: job.researchJobId,
      stage: "broad_screening",
      leaseOwner: context.runId || job.executionId,
      limit: issued.length,
    });
    const claimedIdentities = new Set(
      claimed.map((entry) => `${entry.libraryID}:${entry.itemKey}`),
    );
    issued = issued.filter((paper) =>
      claimedIdentities.has(`${paper.libraryID}:${paper.itemKey}`),
    );
  }
  const next = await recomputeJob({
    job,
    conversationKey: context.request.conversationKey,
  });
  return {
    researchContract: {
      question: investigation.question,
      criteria: investigation.criteria,
      subquestions: investigation.subquestions,
      requiredEvidenceDepth: investigation.requiredEvidenceDepth,
    },
    batch: {
      batchId: issued.length
        ? `${job.researchJobId}:screen:${issued[0].ordinal}-${issued[issued.length - 1].ordinal}`
        : undefined,
      papers: issued,
      pendingPapers: pendingCorpus.length,
      remainingAfterCommit: Math.max(0, pendingCorpus.length - issued.length),
      resumed: activeWork.length > 0,
    },
    instruction: issued.length
      ? "Classify every paper in this batch against every criterion, then immediately call research_update record_papers with exactly these identities. Do not analyze another batch first."
      : "Broad screening is durable for the complete frozen corpus; advance to recall_expansion.",
    progress: progress(next),
  };
}

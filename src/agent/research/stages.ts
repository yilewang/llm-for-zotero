import { ToolInputRejection } from "../tools/execution/failure";
import { RESEARCH_STAGES, type ResearchStage } from "./policy";
import {
  listPaperFindings,
  listResearchCorpusItems,
  loadResearchJobForExecution,
} from "./store";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import type { ResearchCorpusItem } from "./types";
import type { ResearchJob } from "./types";

export function assertResearchTransition(state: {
  current: ResearchStage;
  next: ResearchStage;
  adaptive: boolean;
  inventoryComplete: boolean;
  screeningComplete: boolean;
  findingsComplete: boolean;
}): void {
  if (state.next === state.current) return;
  if (!state.inventoryComplete)
    throw new ToolInputRejection(
      "Inventory is incomplete; call inventory_scope before advancing research.",
    );
  const before = RESEARCH_STAGES.indexOf(state.current);
  const after = RESEARCH_STAGES.indexOf(state.next);
  if (
    state.adaptive &&
    state.next === "hierarchical_synthesis" &&
    state.findingsComplete
  )
    return;
  if (after < before || after > before + 1)
    throw new ToolInputRejection(
      "Research stages must advance in order; adaptive synthesis requires durable findings for every paper.",
    );
  if (
    !state.adaptive &&
    after >= RESEARCH_STAGES.indexOf("recall_expansion") &&
    !state.screeningComplete
  )
    throw new ToolInputRejection(
      "Complete broad screening before advancing research.",
    );
  if (state.next === "hierarchical_synthesis" && !state.findingsComplete)
    throw new ToolInputRejection(
      "Record durable paper findings before hierarchical synthesis.",
    );
}

/** Revalidate the durable revision under the same transaction as the record write. */
export async function commitResearchRecords<T>(
  expected: ResearchJob,
  commit: () => Promise<T>,
): Promise<T> {
  return Zotero.DB.executeTransaction(async () => {
    const current = await loadResearchJobForExecution(expected.executionId);
    if (
      !current ||
      current.researchJobId !== expected.researchJobId ||
      current.scopeLineageDigest !== expected.scopeLineageDigest ||
      current.updatedAt !== expected.updatedAt ||
      current.activeStage !== expected.activeStage ||
      current.status !== expected.status
    )
      throw new Error(
        "Research state changed while this update was prepared. Reload the durable job and resume its remaining work.",
      );
    return commit();
  });
}

type ResearchEligibility = {
  current: ResearchStage;
  adaptive: boolean;
  inventoryComplete: boolean;
  screeningComplete: boolean;
  findingsComplete: boolean;
};

export function recoverableResearchStage(
  state: ResearchEligibility,
): ResearchStage {
  if (!state.inventoryComplete) return "inventory";
  if (state.current === "inventory") return state.current;
  if (!state.adaptive && !state.screeningComplete) return "broad_screening";
  if (state.current === "hierarchical_synthesis" && !state.findingsComplete)
    return state.adaptive ? "broad_screening" : "paper_findings";
  return state.current;
}

export async function storedResearchEligibility(
  job: ResearchJob,
  adaptive: boolean,
): Promise<ResearchEligibility> {
  const [corpus, findings] = await Promise.all([
    listResearchCorpusItems({ researchJobId: job.researchJobId }),
    listPaperFindings(job.researchJobId),
  ]);
  const keys = new Set(
    findings.map((entry) => `${entry.libraryID}:${entry.itemKey}`),
  );
  return {
    current: job.activeStage,
    adaptive,
    inventoryComplete:
      corpus.length === job.totalItems &&
      corpus.every((entry) => entry.inventoryRecorded),
    screeningComplete: corpus.every(
      (entry) => entry.screeningStatus !== "pending",
    ),
    findingsComplete: corpus.every(
      (entry) =>
        entry.screeningStatus === "missing" ||
        (!["pending", "candidate"].includes(entry.screeningStatus) &&
          keys.has(`${entry.libraryID}:${entry.itemKey}`)),
    ),
  };
}

export async function validateStoredResearchTransition(
  job: ResearchJob,
  next: ResearchStage,
  adaptive: boolean,
): Promise<void> {
  assertResearchTransition({
    ...(await storedResearchEligibility(job, adaptive)),
    next,
  });
}

/** Recheck the records used to prepare a batch, under its committing transaction. */
export async function assertResearchCorpusUnchanged(
  job: ResearchJob,
  expected: readonly ResearchCorpusItem[],
): Promise<void> {
  const current = new Map(
    (await listResearchCorpusItems({ researchJobId: job.researchJobId })).map(
      (entry) => [`${entry.libraryID}:${entry.itemKey}`, entry],
    ),
  );
  for (const entry of expected) {
    if (
      canonicalJson(current.get(`${entry.libraryID}:${entry.itemKey}`)) !==
      canonicalJson(entry)
    )
      throw new Error(
        "Research paper records changed while this update was prepared. Reload durable findings and resume remaining work.",
      );
  }
}

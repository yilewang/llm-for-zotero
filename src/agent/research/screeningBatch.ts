import { estimateTextTokens } from "../../utils/modelInputCap";
import type { PaperFinding } from "./types";

export type ScreeningBatchPaper = Readonly<{
  libraryID: number;
  itemKey: string;
  ordinal: number;
  title: string;
  abstract: string;
  year?: string;
  firstCreator?: string;
  hasAbstract: boolean;
  readable: boolean;
  indexed: boolean;
}>;

export type ScreeningBatch = Readonly<{
  papers: readonly ScreeningBatchPaper[];
  estimatedDecisionTokens: number;
}>;

/**
 * Size a screening unit from the provider's actual output allowance and the
 * approved transactional ceiling. Corpus-size labels and wall-clock targets
 * deliberately do not participate: the same queue works for every scope.
 */
export function buildAdaptiveScreeningBatch(params: {
  papers: readonly ScreeningBatchPaper[];
  criterionIds: readonly string[];
  outputTokenBudget: number;
  maxPapersPerUpdate: number;
}): ScreeningBatch {
  const outputTokenBudget = Math.max(1, Math.floor(params.outputTokenBudget));
  const maximum = Math.max(1, Math.floor(params.maxPapersPerUpdate));
  const selected: ScreeningBatchPaper[] = [];
  let estimatedDecisionTokens = estimateTextTokens(
    JSON.stringify({ operation: "record_papers", papers: [] }),
  );

  for (const paper of params.papers) {
    if (selected.length >= maximum) break;
    const projectedDecision = {
      libraryID: paper.libraryID,
      itemKey: paper.itemKey,
      screeningStatus: "unresolved",
      criterionResults: Object.fromEntries(
        params.criterionIds.map((criterionId) => [criterionId, "unknown"]),
      ),
      decisionReason: paper.title,
    };
    const projectedTokens = estimateTextTokens(
      JSON.stringify(projectedDecision),
    );
    // Reasoning-capable providers count private reasoning against the same
    // completion allowance, so reserve one projected unit for each.
    const nextEstimate = estimatedDecisionTokens + projectedTokens * 2;
    if (selected.length && nextEstimate > outputTokenBudget) break;
    selected.push(paper);
    estimatedDecisionTokens = nextEstimate;
  }

  return { papers: selected, estimatedDecisionTokens };
}

export function buildExcludedScreeningFinding(params: {
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  libraryID: number;
  itemKey: string;
  criterionIds: readonly string[];
  decisionReason?: string;
  sourceFingerprint: string;
  createdAt?: number;
}): PaperFinding {
  const reason = params.decisionReason?.trim();
  return {
    version: 1,
    findingId: `${params.researchJobId}:paper:${params.libraryID}:${params.itemKey}`,
    researchJobId: params.researchJobId,
    executionId: params.executionId,
    parentTaskId: params.parentTaskId,
    libraryID: params.libraryID,
    itemKey: params.itemKey,
    subquestionIds: [],
    criterionIds: [...params.criterionIds],
    findings: [],
    contradictions: [],
    negativeEvidence: [],
    limitations: [
      reason
        ? `Excluded during title/abstract screening: ${reason}`
        : "Excluded during title/abstract screening; no detailed reason was recorded.",
    ],
    evidenceRefs: [],
    sourceFingerprint: params.sourceFingerprint,
    inclusionDecision: "exclude",
    confidence: reason ? "medium" : "low",
    unresolvedQuestions: [],
    createdAt: params.createdAt ?? Date.now(),
  };
}

export type ResearchEvaluationCase = Readonly<{
  id: string;
  goldRelevant: boolean;
  goldDecision: "include" | "exclude" | "unresolved";
  predictedRelevant: boolean;
  predictedDecision: "include" | "exclude" | "unresolved";
  expectedSourceRefs?: readonly string[];
  synthesizedSourceRefs?: readonly string[];
  researchSelectedMutationAuthorized?: boolean;
}>;

export type ResearchEvaluationScore = Readonly<{
  itemCount: number;
  inventoryAccounting: number;
  relevantPaperRecall: number;
  falseExclusionRate: number;
  sourceRetention: number;
  unauthorizedMutationCount: number;
  passesInitialReleaseGate: boolean;
}>;

function ratio(numerator: number, denominator: number): number {
  return denominator ? numerator / denominator : 1;
}

export function scoreResearchEvaluation(
  cases: readonly ResearchEvaluationCase[],
): ResearchEvaluationScore {
  const identified = cases.filter((entry) => entry.id.trim()).length;
  const relevant = cases.filter((entry) => entry.goldRelevant);
  const recalled = relevant.filter((entry) => entry.predictedRelevant).length;
  const falseExclusions = relevant.filter(
    (entry) => entry.predictedDecision === "exclude",
  ).length;
  let expectedSources = 0;
  let retainedSources = 0;
  for (const entry of cases) {
    const expected = new Set(entry.expectedSourceRefs || []);
    const retained = new Set(entry.synthesizedSourceRefs || []);
    expectedSources += expected.size;
    retainedSources += [...expected].filter((source) =>
      retained.has(source),
    ).length;
  }
  const score = {
    itemCount: cases.length,
    inventoryAccounting: ratio(identified, cases.length),
    relevantPaperRecall: ratio(recalled, relevant.length),
    falseExclusionRate: ratio(falseExclusions, relevant.length),
    sourceRetention: ratio(retainedSources, expectedSources),
    unauthorizedMutationCount: cases.filter(
      (entry) => entry.researchSelectedMutationAuthorized === false,
    ).length,
  };
  return {
    ...score,
    passesInitialReleaseGate:
      score.inventoryAccounting === 1 &&
      score.relevantPaperRecall >= 0.95 &&
      score.falseExclusionRate <= 0.01 &&
      score.sourceRetention === 1 &&
      score.unauthorizedMutationCount === 0,
  };
}

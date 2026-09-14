export type ResearchPolicyProfile = "chat" | "plan_research";

export type ResearchPolicySnapshot = Readonly<{
  version: 1;
  profile: ResearchPolicyProfile;
  deepSynthesisMaxPapers: number;
  evidenceOverviewMaxPapers: number;
  defaultMetadataItems: number;
  defaultCollectionMetadataItems: number;
  defaultCandidatePapers: number;
  defaultEnumerateCandidatePapers: number;
  defaultFullTextPapers: number;
  defaultSnippetsPerPaper: number;
  defaultTotalSnippets: number;
  maxMetadataItemsPerCall: number;
  maxCandidatePapersPerCall: number;
  maxFullTextPapersPerCall: number;
  maxSnippetsPerPaper: number;
  maxTotalSnippetsPerCall: number;
  materialExpansionMultiplier: number;
  materialExpansionMinimumDelta: number;
  largeDeepReadThreshold: number;
  stages: readonly ResearchStage[];
}>;

export type ResearchStage =
  | "inventory"
  | "broad_screening"
  | "recall_expansion"
  | "deep_evidence"
  | "paper_findings"
  | "hierarchical_synthesis";

export const RESEARCH_POLICY_VERSION = 1 as const;

export const RESEARCH_STAGES: readonly ResearchStage[] = [
  "inventory",
  "broad_screening",
  "recall_expansion",
  "deep_evidence",
  "paper_findings",
  "hierarchical_synthesis",
];

const CHAT_POLICY: ResearchPolicySnapshot = Object.freeze({
  version: RESEARCH_POLICY_VERSION,
  profile: "chat",
  deepSynthesisMaxPapers: 25,
  evidenceOverviewMaxPapers: 80,
  defaultMetadataItems: 500,
  defaultCollectionMetadataItems: 2000,
  defaultCandidatePapers: 80,
  defaultEnumerateCandidatePapers: 200,
  defaultFullTextPapers: 30,
  defaultSnippetsPerPaper: 3,
  defaultTotalSnippets: 80,
  maxMetadataItemsPerCall: 5000,
  maxCandidatePapersPerCall: 200,
  maxFullTextPapersPerCall: 100,
  maxSnippetsPerPaper: 5,
  maxTotalSnippetsPerCall: 200,
  materialExpansionMultiplier: 2,
  materialExpansionMinimumDelta: 20,
  largeDeepReadThreshold: 100,
  stages: RESEARCH_STAGES,
});

const PLAN_RESEARCH_POLICY: ResearchPolicySnapshot = Object.freeze({
  ...CHAT_POLICY,
  profile: "plan_research",
});

export function resolveResearchPolicy(
  profile: ResearchPolicyProfile,
): ResearchPolicySnapshot {
  return profile === "plan_research" ? PLAN_RESEARCH_POLICY : CHAT_POLICY;
}

export function decodeResearchPolicySnapshot(
  value: unknown,
): ResearchPolicySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Research policy snapshot must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.version !== RESEARCH_POLICY_VERSION) {
    throw new Error("Unsupported research policy version");
  }
  if (input.profile !== "chat" && input.profile !== "plan_research") {
    throw new Error("Invalid research policy profile");
  }
  const integer = (key: keyof ResearchPolicySnapshot, minimum = 0) => {
    const entry = input[key];
    if (!Number.isInteger(entry) || Number(entry) < minimum) {
      throw new Error(`Research policy ${String(key)} is invalid`);
    }
    return Number(entry);
  };
  if (
    !Array.isArray(input.stages) ||
    input.stages.length !== RESEARCH_STAGES.length
  ) {
    throw new Error("Research policy stages are invalid");
  }
  const stages = input.stages.map(String) as ResearchStage[];
  if (stages.some((stage, index) => stage !== RESEARCH_STAGES[index])) {
    throw new Error("Research policy stage order is invalid");
  }
  return {
    version: RESEARCH_POLICY_VERSION,
    profile: input.profile,
    deepSynthesisMaxPapers: integer("deepSynthesisMaxPapers", 1),
    evidenceOverviewMaxPapers: integer("evidenceOverviewMaxPapers", 1),
    defaultMetadataItems: integer("defaultMetadataItems", 1),
    defaultCollectionMetadataItems: integer(
      "defaultCollectionMetadataItems",
      1,
    ),
    defaultCandidatePapers: integer("defaultCandidatePapers", 1),
    defaultEnumerateCandidatePapers: integer(
      "defaultEnumerateCandidatePapers",
      1,
    ),
    defaultFullTextPapers: integer("defaultFullTextPapers", 1),
    defaultSnippetsPerPaper: integer("defaultSnippetsPerPaper", 1),
    defaultTotalSnippets: integer("defaultTotalSnippets", 1),
    maxMetadataItemsPerCall: integer("maxMetadataItemsPerCall", 1),
    maxCandidatePapersPerCall: integer("maxCandidatePapersPerCall", 1),
    maxFullTextPapersPerCall: integer("maxFullTextPapersPerCall", 1),
    maxSnippetsPerPaper: integer("maxSnippetsPerPaper", 1),
    maxTotalSnippetsPerCall: integer("maxTotalSnippetsPerCall", 1),
    materialExpansionMultiplier: integer("materialExpansionMultiplier", 1),
    materialExpansionMinimumDelta: integer("materialExpansionMinimumDelta", 1),
    largeDeepReadThreshold: integer("largeDeepReadThreshold", 1),
    stages,
  };
}

export function shouldCheckpointResearchExpansion(params: {
  approvedEstimate: number;
  actualDeepReadCandidates: number;
  approvedLargeCorpus: boolean;
  policy?: ResearchPolicySnapshot;
}): boolean {
  const policy = params.policy || PLAN_RESEARCH_POLICY;
  const estimate = Math.max(0, Math.floor(params.approvedEstimate));
  const actual = Math.max(0, Math.floor(params.actualDeepReadCandidates));
  const materiallyExpanded =
    actual > estimate * policy.materialExpansionMultiplier &&
    actual - estimate >= policy.materialExpansionMinimumDelta;
  const crossedUnapprovedLargeThreshold =
    !params.approvedLargeCorpus && actual > policy.largeDeepReadThreshold;
  return materiallyExpanded || crossedUnapprovedLargeThreshold;
}

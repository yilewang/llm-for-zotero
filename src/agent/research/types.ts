import type { AgentActionContract } from "../contracts/types";
import type { ResearchPolicySnapshot, ResearchStage } from "./policy";

export type ResearchCoverageStatus =
  | "complete"
  | "complete_with_limitations"
  | "partial"
  | "failed";

export type ResearchScopeSpec = Readonly<{
  libraryID: number;
}> &
  (
    | Readonly<{ kind: "library" }>
    | Readonly<{ kind: "collections"; collectionIds: readonly number[] }>
    | Readonly<{
        kind: "tags";
        tagNames: readonly string[];
        includeAutomaticTags?: boolean;
      }>
    | Readonly<{ kind: "items"; itemKeys: readonly string[] }>
    | Readonly<{
        kind: "mixed";
        collectionIds?: readonly number[];
        tagNames?: readonly string[];
        includeAutomaticTags?: boolean;
        itemKeys?: readonly string[];
      }>
  );

export type ResearchCriterion = Readonly<{
  id: string;
  description: string;
  kind: "include" | "exclude";
}>;

export type ResearchSubquestion = Readonly<{
  id: string;
  question: string;
}>;

export type ResearchContract = Readonly<{
  question: string;
  subquestions: readonly ResearchSubquestion[];
  criteria: readonly ResearchCriterion[];
  /** Narrative is the ordinary literature-review default. */
  reviewMode?: "narrative" | "scoping" | "systematic";
  /** Adaptive reads the approved scope to the depth allowed by live capacity. */
  readingStrategy?: "adaptive" | "selected";
  /** Whether execution may add papers proven to remain inside the source. */
  scopeAmendmentPolicy: "fixed" | "within_source";
  scope: ResearchScopeSpec;
  /** Required once the plan is ready for approval. */
  scopeSnapshot?: ResearchScopeSnapshotRef;
  queryVariants?: readonly string[];
  requiredEvidenceDepth: "metadata" | "abstract" | "body";
  estimatedDeepReadPapers: number;
  approvedLargeCorpus: boolean;
}>;

export type ResearchScopeSnapshotRef = Readonly<{
  snapshotId: string;
  digest: string;
  itemCount: number;
  createdAt: number;
  policyVersion: number;
  parentSnapshotId?: string;
  scopeLineageDigest?: string;
}>;

export type ResearchScopeSnapshotItem = Readonly<{
  snapshotId: string;
  libraryID: number;
  itemKey: string;
  localItemId?: number;
  /** Frozen display metadata used by recovery and final coverage reporting. */
  title?: string;
  firstCreator?: string;
  year?: string;
  metadataFingerprint?: string;
  attachmentFingerprint?: string;
  ordinal: number;
}>;

export type ResearchJobStatus =
  | "pending"
  | "running"
  | "waiting_for_user"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

export type ResearchScreeningStatus =
  | "pending"
  | "candidate"
  | "included"
  | "excluded"
  | "unresolved"
  | "unreadable"
  | "missing";

export type ResearchWorkStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "interrupted"
  | "cancelled";

export type ResearchJob = Readonly<{
  version: 1 | 2 | 3;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  contractDigest: string;
  /** The snapshot frozen into the initially approved Plan artifact. */
  baseSnapshotId?: string;
  /** The current immutable effective snapshot for this execution. */
  snapshotId: string;
  /** Digest of the complete base-to-effective snapshot lineage. */
  scopeLineageDigest?: string;
  policy: ResearchPolicySnapshot;
  status: ResearchJobStatus;
  activeStage: ResearchStage;
  coverageStatus?: ResearchCoverageStatus;
  totalItems: number;
  screenedItems: number;
  candidateItems: number;
  deepReadCompleted: number;
  deepReadPlanned: number;
  exceptionGrant?: ResearchExceptionGrant;
  /** Comparison frame every node fills; host default, model-refinable. */
  frame?: ResearchFrame;
  /** Adaptive-review loop phase after inventory (version 3). */
  synthesisPhase?: ResearchSynthesisPhase;
  /** Capacity-derived tiering decision measured at inventory. */
  nodeCapacity?: ResearchNodeCapacity;
  /** Quality rubric computed at finalize and document finalization. */
  qualityReport?: ResearchQualityReport;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}>;

export type ResearchSynthesisPhase =
  | "nodes"
  | "links"
  | "verification"
  | "structure"
  | "writing"
  | "complete";

export type ResearchFrameSlot = Readonly<{
  slotId: string;
  name: string;
  description: string;
  kind: "identity" | "comparison";
}>;

export type ResearchFrame = Readonly<{
  version: 1;
  slots: readonly ResearchFrameSlot[];
  revisedAt: number;
}>;

export type ResearchNodeCapacity = Readonly<{
  fullNodeCapacity: number;
  linkViewTokens: number;
  compactCoreTokens: number;
  compactPeripheralTokens: number;
  mandatoryTiering: boolean;
  measuredAt: number;
}>;

export type ResearchQualityReport = Readonly<{
  version: 1;
  computedAt: number;
  papers: number;
  nodes: number;
  claims: number;
  claimsWithLocators: number;
  nodesWithEdges: number;
  edges: number;
  edgesVerified: number;
  edgesTentative: number;
  edgesRefuted: number;
  contradictions: number;
  subquestionClaims: Readonly<Record<string, number>>;
  themes: number;
  themesWithEdges: number;
  openQuestions: number;
  answeredQuestions: number;
  crossPaperParagraphs?: number;
  crossPaperParagraphsSupported?: number;
}>;

export type ResearchPaperTier = "core" | "supporting" | "peripheral";

export type ResearchEdgeType =
  | "extends"
  | "contradicts"
  | "replicates"
  | "shares_method"
  | "shares_construct"
  | "supplies_theory"
  | "motivates"
  | "applies_to"
  | "refines";

export type ResearchEdgeStatus =
  | "candidate"
  | "verified"
  | "refuted"
  | "tentative"
  | "merged";

export type ResearchEdge = Readonly<{
  version: 1;
  edgeId: string;
  /** Model-supplied idempotency key; the host owns edgeId. */
  edgeKey?: string;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  source: string;
  target: string;
  type: ResearchEdgeType;
  statement: string;
  sourceClaimIds: readonly string[];
  targetClaimIds: readonly string[];
  confidence: ResearchFindingConfidence;
  requiresVerification: boolean;
  status: ResearchEdgeStatus;
  verification?: Readonly<{
    evidenceRefs: readonly string[];
    note?: string;
    decidedAt: number;
  }>;
  mergedInto?: string;
  subquestionIds: readonly string[];
  scopeLineageDigest?: string;
  lifecycle: "valid" | "invalidated";
  invalidatedAt?: number;
  createdAt: number;
  updatedAt: number;
}>;

export type ResearchOpenQuestion = Readonly<{
  version: 1;
  questionId: string;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  text: string;
  scope: Readonly<{
    kind: "subquestion" | "edge" | "node" | "corpus";
    ref?: string;
  }>;
  priority: 1 | 2 | 3;
  origin: "model" | "host_gap";
  status: "open" | "answered" | "abandoned";
  resolution?: Readonly<{ text: string; evidenceRefs: readonly string[] }>;
  scopeLineageDigest?: string;
  lifecycle: "valid" | "invalidated";
  invalidatedAt?: number;
  createdAt: number;
  updatedAt: number;
}>;

export type ResearchClaimKind =
  | "finding"
  | "method"
  | "mechanism"
  | "limitation"
  | "theory"
  | "context";

export type ResearchClaim = Readonly<{
  claimId: string;
  statement: string;
  kind: ResearchClaimKind;
  subquestionIds: readonly string[];
  evidence: Readonly<{
    sourceKind: "body" | "abstract" | "metadata";
    pageIndex?: number;
    quote?: string;
    /** Host-verified: the quote or locator was checked against the source. */
    verified?: boolean;
  }>;
}>;

export type ResearchNodeHooks = Readonly<{
  constructs: readonly string[];
  methods: readonly string[];
  datasets: readonly string[];
  populations: readonly string[];
  keyQuantities: readonly string[];
}>;

export type ResearchCandidateLink = Readonly<{
  target: string;
  type: ResearchEdgeType;
  note: string;
}>;

export type ResearchExceptionGrant = Readonly<{
  version: 1;
  grantId: string;
  planDigest: string;
  executionId: string;
  researchJobId: string;
  totalItems: number;
  screenedItems: number;
  candidateItems: number;
  deepReadCompleted: number;
  limitationSummary: string;
  status: "authorized" | "consumed";
  grantedAt: number;
  consumedAt?: number;
}>;

export type ResearchCorpusItem = Readonly<{
  version: 1 | 2;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  libraryID: number;
  itemKey: string;
  localItemId?: number;
  ordinal: number;
  screeningStatus: ResearchScreeningStatus;
  criterionResults: Readonly<Record<string, "met" | "not_met" | "unknown">>;
  decisionReason?: string;
  inventoryRecorded: boolean;
  hasAbstract: boolean;
  attachmentItemKeys: readonly string[];
  duplicateAttachmentKeys: readonly string[];
  readable: boolean;
  indexed: boolean;
  sourceFingerprint?: string;
  /** Version 2: capacity-derived reading tier and its provenance. */
  tier?: ResearchPaperTier;
  relevanceScore?: number;
  tierSource?: "host" | "model";
  tierReason?: string;
  /** Host-measured size of the readable text, in tokens. */
  textTokens?: number;
  updatedAt: number;
}>;

export type ResearchWorkItem = Readonly<{
  version: 1;
  workItemId: string;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  libraryID: number;
  itemKey: string;
  stage: ResearchStage;
  subquestionIds: readonly string[];
  status: ResearchWorkStatus;
  attemptCount: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  evidenceRefs: readonly string[];
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
}>;

export type ResearchEvidenceRecord = Readonly<{
  version: 1 | 2;
  evidenceRef: string;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  libraryID: number;
  itemKey: string;
  sourceFingerprint: string;
  sourceKind: "metadata" | "abstract" | "body" | "figure" | "quote";
  /** Required on v2 evidence; points to host-issued observation metadata. */
  observationId?: string;
  locator?: Readonly<{
    kind: "pdf_page";
    attachmentItemKey: string;
    pageIndex: number;
    sourceFingerprint: string;
  }>;
  createdAt: number;
}>;

export type ResearchRecallProbe = Readonly<{
  version: 1;
  probeId: string;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  kind:
    | "synonym"
    | "abbreviation"
    | "translation"
    | "semantic"
    | "reformulation";
  query: string;
  addedTargets: readonly Readonly<{ libraryID: number; itemKey: string }>[];
  createdAt: number;
}>;

export type ResearchFindingConfidence = "low" | "medium" | "high";

export type PaperFinding = Readonly<{
  version: 1 | 2;
  findingId: string;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  libraryID: number;
  itemKey: string;
  subquestionIds: readonly string[];
  criterionIds: readonly string[];
  findings: readonly string[];
  contradictions: readonly string[];
  negativeEvidence: readonly string[];
  limitations: readonly string[];
  evidenceRefs: readonly string[];
  sourceFingerprint: string;
  inclusionDecision: "include" | "exclude" | "unresolved";
  confidence: ResearchFindingConfidence;
  unresolvedQuestions: readonly string[];
  /** Descriptive, non-exclusive roles used by narrative evidence synthesis. */
  roles?: readonly (
    | "central_evidence"
    | "supporting_evidence"
    | "contradictory_evidence"
    | "theoretical_foundation"
    | "methodological_contribution"
    | "historical_context"
    | "tangential_context"
    | "unresolved"
  )[];
  mainMessage?: string;
  researchQuestion?: string;
  method?: string;
  mechanisms?: readonly string[];
  relevance?: string;
  relationships?: readonly string[];
  /** Version 2 node fields: the tailored, claim-based understanding. */
  tier?: ResearchPaperTier;
  frameSlots?: Readonly<Record<string, string>>;
  claims?: readonly ResearchClaim[];
  hooks?: ResearchNodeHooks;
  candidateLinks?: readonly ResearchCandidateLink[];
  noLinkSeen?: string;
  questionsRaised?: readonly Readonly<{ text: string; about?: string }>[];
  createdAt: number;
}>;

export type ThemeFinding = Readonly<{
  version: 1 | 2;
  themeFindingId: string;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  title: string;
  synthesis: string;
  paperFindingIds: readonly string[];
  evidenceRefs: readonly string[];
  limitations: readonly string[];
  /** Edges the theme rests on; required once the job has edges. */
  edgeIds?: readonly string[];
  communityId?: string;
  scopeLineageDigest?: string;
  status?: "valid" | "invalidated";
  invalidatedAt?: number;
  createdAt: number;
}>;

export type ResearchProgress = Readonly<{
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  stage: ResearchStage;
  totalItems: number;
  screenedItems: number;
  candidateItems: number;
  deepReadCompleted: number;
  deepReadPlanned: number;
  coverageStatus?: ResearchCoverageStatus;
  phase?: ResearchSynthesisPhase;
  quality?: ResearchQualityReport;
}>;

export type ResearchMutationApprovalGrant = Readonly<{
  version: 1 | 2 | 3;
  authority?: "user" | "auto_policy" | "yolo";
  grantId: string;
  planId: string;
  planRevision: number;
  executionId: string;
  conversationKey: number;
  planDigest: string;
  researchResultDigest: string;
  scopeLineageDigest?: string;
  targetSetDigest: string;
  actionContract: AgentActionContract;
  status: "approved" | "invalidated";
  approvedAt: number;
  invalidatedAt?: number;
}>;

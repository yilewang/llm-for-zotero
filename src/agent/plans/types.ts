import type {
  AgentActionContract,
  AgentActionIntent,
  AgentActionReceipt,
} from "../contracts/types";
import type { PlanSkillRoutingReceipt } from "../skills/routingTypes";
import type { DocumentSpec, PlanDocument } from "../documents/types";
import type { ResearchContract, ResearchProgress } from "../research/types";
import type { ResearchPolicySnapshot } from "../research/policy";

export type PlanProvider = "original" | "codex" | "claude";

export type PlanArtifactStatus =
  | "drafting"
  | "awaiting_approval"
  | "approved"
  | "superseded"
  | "cancelled";

export type PlanStepEffect = "read" | "artifact" | "mutation" | "reasoning";

export type PlanCompletionRequirementKind =
  | "verified_read"
  | "bounded_reasoning"
  | "research_coverage"
  | "material_integrity"
  | "document_integrity"
  | "document_published"
  | "mutation_receipts"
  | "user_decision";

export type PlanAcceptanceCriterion = Readonly<{
  criterionId: string;
  description: string;
  verifier: PlanCompletionRequirementKind;
}>;

export type PlanCompletionRequirement = Readonly<{
  requirementId: string;
  kind: PlanCompletionRequirementKind;
  criterionIds: readonly string[];
  contractDigest: string;
  targetBoundary?: Readonly<{
    targetIds?: readonly string[];
    scopeDigest?: string;
    expectedCount?: number;
  }>;
}>;

export type PlanStep = Readonly<{
  planStepId: string;
  content: string;
  activeForm: string;
  acceptanceCriteria: readonly (string | PlanAcceptanceCriterion)[];
  expectedCapability?: string;
  expectedEffect: PlanStepEffect;
  actionIndexes?: readonly number[];
  materialOutputId?: string;
  /** Authoritative for v3 plans. Legacy plans derive one requirement by effect. */
  completionRequirements?: readonly PlanCompletionRequirement[];
  targetBoundary?: Readonly<{
    kind: "collection" | "library" | "selection" | "conversation";
    targetIds?: readonly string[];
    scopeDigest?: string;
  }>;
}>;

export type ResearchDerivedMutationIntent = Readonly<{
  summary: string;
  intents: readonly AgentActionIntent[];
  targetSelectionDescription: string;
}>;

export type PlanContract = Readonly<{
  investigation?: ResearchContract;
  deliverable:
    | Readonly<{ kind: "answer" }>
    | Readonly<{ kind: "document"; spec: DocumentSpec }>
    | Readonly<{ kind: "completion_report" }>;
  effects?: Readonly<{
    libraryMutation:
      | Readonly<{
          approval: "initial";
          contract: AgentActionContract;
        }>
      | Readonly<{
          approval: "after_research";
          intent: ResearchDerivedMutationIntent;
        }>;
  }>;
  researchPolicy?: ResearchPolicySnapshot;
}>;

export type NativePlanAttempt = Readonly<{
  attemptId: string;
  threadId: string;
  /** Absent only while turn/start has not returned; a finalized proposal requires it. */
  turnId?: string;
  ephemeral: boolean;
}>;
export type NativePlanBinding = NativePlanAttempt &
  Readonly<{
    proposal?: Readonly<{ itemId: string; markdown: string }>;
  }>;

/** A revision is editable only while drafting and is frozen by approval. */
export type PlanArtifact = Readonly<{
  version: 1 | 2 | 3 | 4;
  planId: string;
  conversationKey: number;
  provider: PlanProvider;
  revision: number;
  digest: string;
  status: PlanArtifactStatus;
  explanation?: string;
  actionContractId?: string;
  /** Frozen scope/effect contract that the approval grant authorizes. */
  actionContract?: AgentActionContract;
  sourceRunId?: string;
  nativePlanning?: NativePlanBinding;
  /** Present on v2 artifacts; binds planning-time skill instructions. */
  skillRoutingReceipt?: PlanSkillRoutingReceipt;
  /** Required and centrally validated on v3 artifacts. */
  contract?: PlanContract;
  /** Digest of the approved composable contract, excluding plan presentation. */
  contractDigest?: string;
  steps: readonly PlanStep[];
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
}>;

export type ExecutionTaskStatus =
  | "pending"
  | "in_progress"
  | "waiting_for_user"
  | "interrupted"
  | "completed"
  | "blocked"
  | "failed"
  | "skipped"
  | "cancelled";

export type ExecutionTaskKind = "required_step" | "supporting_child";

export type TaskEvidenceKind =
  | "mutation_receipt"
  | "verified_read"
  | "artifact"
  | "validation"
  | "reasoning_assertion"
  | "research_coverage"
  | "material_integrity"
  | "document_integrity"
  | "document_published"
  | "user_decision";

export type TaskEvidencePayload =
  | Readonly<{
      type: "verified_read";
      reference: string;
      sources?: readonly VerifiedReadSource[];
      observations?: readonly TrustedReadObservation[];
    }>
  | Readonly<{
      /** The research job reports that every manifest paper is durable. */
      type: "research_reading";
      researchJobId: string;
      scopeLineageDigest: string;
      durablePapers: number;
      totalPapers: number;
    }>
  | Readonly<{
      type: "bounded_reasoning";
      assertion: string;
    }>
  | Readonly<{
      type: "tool_artifacts";
      artifacts: readonly Readonly<{
        kind: "image" | "file_ref";
        mimeType: string;
        storedPath: string;
        contentHash?: string;
      }>[];
    }>
  | Readonly<{
      type: "research_coverage";
      researchJobId: string;
      coverageStatus:
        | "complete"
        | "complete_with_limitations"
        | "partial"
        | "failed";
      totalItems: number;
      screenedItems: number;
      candidateItems: number;
      deepReadCompleted: number;
      scopeLineageDigest?: string;
    }>
  | Readonly<{
      type: "material_integrity";
      materialOutputId: string;
      documentId: string;
      contentHash: string;
      integrityValidated: true;
    }>
  | Readonly<{
      type: "document_integrity";
      documentId: string;
      contentHash: string;
      integrityValidated: true;
    }>
  | Readonly<{
      type: "document_published";
      documentId: string;
      contentHash: string;
      messageTimestamp: number;
    }>
  | Readonly<{
      type: "mutation_receipts";
      receiptIds: readonly string[];
    }>
  | Readonly<{
      type: "user_decision";
      actionId: string;
      decidedAt: number;
    }>;

export type VerifiedReadSource = Readonly<{
  libraryID: number;
  itemKey: string;
  attachmentItemKey?: string;
  pageIndex?: number;
  sourceFingerprint?: string;
}>;

export type ReadObservationCapability =
  | "metadata"
  | "abstract"
  | "body"
  | "figure"
  | "quote";

export type TrustedReadObservation = Readonly<{
  version: 1;
  observationId: string;
  issuer: "zotero_host";
  toolName: string;
  callDigest: string;
  inputDigest: string;
  resultDigest: string;
  libraryID: number;
  itemKey: string;
  capabilities: readonly ReadObservationCapability[];
  attachmentItemKey?: string;
  pageIndex?: number;
  sourceFingerprint?: string;
  /** The paper_read mode that issued this observation (overview, targeted, full, ...). */
  readMode?: string;
  quoteCertificate?: string;
  certificateDigest: string;
}>;

export type TaskEvidence = Readonly<{
  version: 1 | 2 | 3;
  evidenceId: string;
  executionId: string;
  taskId: string;
  kind: TaskEvidenceKind;
  verified: boolean;
  requirementId?: string;
  criterionIds?: readonly string[];
  contractDigest?: string;
  receipt?: AgentActionReceipt;
  payload?: TaskEvidencePayload;
  reference?: string;
  summary?: string;
  createdAt: number;
}>;

export type ExecutionTask = Readonly<{
  version: 1 | 2;
  taskId: string;
  executionId: string;
  planStepId: string;
  parentTaskId?: string;
  kind: ExecutionTaskKind;
  content: string;
  activeForm: string;
  acceptanceCriteria: readonly (string | PlanAcceptanceCriterion)[];
  expectedEffect: PlanStepEffect;
  actionIndexes?: readonly number[];
  materialOutputId?: string;
  completionRequirements?: readonly PlanCompletionRequirement[];
  expectedCapability?: string;
  obligationIds: readonly string[];
  status: ExecutionTaskStatus;
  attemptCount: number;
  evidenceIds: readonly string[];
  failureReasons: readonly string[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}>;

export type PlanExecutionStatus =
  | "pending"
  | "running"
  | "waiting_for_user"
  | "interrupted"
  | "completed"
  | "completed_with_exceptions"
  | "blocked"
  | "failed"
  | "cancelled"
  | "superseded";

export type ApprovedPlanGrant = Readonly<{
  version: 1;
  planId: string;
  revision: number;
  planDigest: string;
  conversationKey: number;
  conversationGeneration: number;
  actionContractId?: string;
  authority: "user" | "auto_policy" | "yolo";
  approvedAt: number;
}>;

export type PlanExecutionLedger = Readonly<{
  version: 1 | 2;
  executionId: string;
  planId: string;
  revision: number;
  planDigest: string;
  conversationKey: number;
  attempt: number;
  provider: PlanProvider;
  providerContinuationId?: string;
  actionContractId?: string;
  grant: ApprovedPlanGrant;
  status: PlanExecutionStatus;
  activeTaskId?: string;
  tasks: readonly ExecutionTask[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  predecessorExecutionId?: string;
  supersededByExecutionId?: string;
}>;

export type TaskTransitionRequest = Readonly<{
  executionId: string;
  taskId: string;
  toStatus: ExecutionTaskStatus;
  reason?: string;
  evidenceIds?: readonly string[];
  requestedBy: PlanProvider | "host" | "user";
}>;

export type PlanRuntimeContext =
  | Readonly<{
      phase: "planning";
      nativePlanning?: NativePlanAttempt;
      planId: string;
      revision: number;
      provider: PlanProvider;
    }>
  | Readonly<{
      phase: "executing";
      planId: string;
      revision: number;
      executionId: string;
      approvedDigest: string;
      activeTaskId?: string;
      provider: PlanProvider;
    }>;

export type PlanEvent =
  | {
      type: "plan_updated";
      artifact: PlanArtifact;
    }
  | {
      type: "plan_ready";
      artifact: PlanArtifact;
    }
  | {
      type: "plan_execution_updated";
      ledger: PlanExecutionLedger;
      transition?: Readonly<{
        taskId: string;
        fromStatus: ExecutionTaskStatus;
        toStatus: ExecutionTaskStatus;
        text: string;
      }>;
    }
  | {
      type: "plan_research_progress";
      progress: ResearchProgress;
    }
  | {
      type: "plan_scope_amended";
      amendmentId: string;
      executionId: string;
      mode: "safe" | "auto" | "yolo" | "native";
      rationale: string;
      previousItemCount: number;
      newItemCount: number;
      authority: "user" | "auto_policy" | "yolo";
    }
  | {
      type: "document_ready";
      documentId: string;
      executionId?: string;
      title: string;
      contentHash: string;
    }
  | {
      type: "plan_document_ready";
      documentId: string;
      executionId: string;
      title: string;
      contentHash: string;
    };

import type { ActionConstraint } from "../authorization/types";
import type {
  LibraryMutationOperation,
  LibraryMutationState,
} from "../services/libraryMutation/contracts";

export type AgentActionCapability =
  | "zotero.read"
  | "zotero.tags"
  | "zotero.metadata"
  | "zotero.collections"
  | "zotero.notes"
  | "zotero.import"
  | "zotero.trash"
  | "zotero.attachments"
  | "zotero.annotations"
  | "zotero.settings"
  | "zotero.undo"
  | "file.write"
  | "command.execute"
  | "zotero.script";

export type AgentActionProofDomain =
  | "zotero_state"
  | "file_state"
  | "execution";

export type AgentActionOperation =
  | LibraryMutationOperation["type"]
  | "note_create"
  | "note_edit"
  | "note_append"
  | "annotation_write"
  | "settings_update"
  | "undo"
  | "revert"
  | "file_write"
  | "command_execute"
  | "zotero_script_execute"
  | "read_full";

/** Meaning-changing values shared by intent, proposal, and receipt. */
export type AgentActionParameters = {
  semanticAction?:
    | "add"
    | "remove"
    | "rename"
    | "merge"
    | "delete"
    | "setColor";
  tags?: string[];
  metadataFields?: string[];
  metadataValues?: Record<string, unknown>;
  tag?: string;
  newTag?: string;
  collectionName?: string;
  collectionId?: number;
  collectionIds?: number[];
  savedSearchId?: number;
  savedSearchName?: string;
  sourceCollectionId?: number | "all";
  destinationCollectionId?: number;
  parentCollectionId?: number | null;
  noteMode?: "create" | "edit" | "append";
  targetNoteId?: number;
  targetItemId?: number;
  pageIndex?: number;
  revertCount?: number;
  /** Visible plain text from the prepared native payload, already decoded once. */
  expectedText?: string;
  newName?: string;
  newPath?: string;
  identifiers?: string[];
  filePaths?: string[];
  parentItemIds?: Array<number | null>;
  deleteItems?: boolean;
  permanent?: boolean;
  filePath?: string;
  contentHash?: string;
  documentId?: string;
  commandFingerprint?: string;
  settingsKey?: string;
  settingsValue?: string;
};

export type AgentActionIntent = {
  /** Semantic preference for this action, frozen with its intent revision. */
  reviewPreference?: "default" | "review" | "direct";
  /** Zero-based indexes into the frozen action list. */
  dependsOn?: number[];
  /** Index of the create_collection action that supplies a future destination. */
  destinationFrom?: number;
  /** Identity of authored material from semantic.materialOutputs. */
  contentFrom?: string;
  capability: AgentActionCapability;
  operation: AgentActionOperation;
  proofDomain: AgentActionProofDomain;
  coverage: "one" | "some" | "all";
  targetKind: "papers" | "items";
  parameters?: AgentActionParameters;
  discovery?: {
    description: string;
    source: "context" | "library" | "collection";
    collectionPath?: string;
  };
  /** Literal native identities, resolved and frozen by the host before execution. */
  targetSelectors?: Array<
    | { kind: "item_id"; value: number }
    | { kind: "item_key" | "title"; value: string }
  >;
  scope?: {
    kind: "collection";
    referenceKind?: "literal" | "descriptive";
    path?: string;
    includeDescendants: boolean;
  };
  scopeRole?: "source" | "destination";
  constraints?: {
    tagPrefix?: string;
    readMode?: "full";
    collectionMode?: "move";
  };
};

export type AgentActionObligation = AgentActionIntent & {
  id: string;
  /** Index of the interpreted action, which may expand to several native obligations. */
  sourceActionIndex?: number;
  /** The destination must be created and natively verified by this same contract. */
  destinationCreation?: { obligationId: string; libraryID: number };
  scope?: AgentActionIntent["scope"] & {
    libraryID: number;
    collectionId: number;
    collectionPath: string;
  };
  targetBoundary?: {
    kind: "collection" | "library" | "selection";
    libraryID: number;
    frozenTargetIds: number[];
    scopeDigest: string;
  };
};

/** Immutable interpretation of one user request. */
export type AgentActionContract = {
  version: 2 | 3 | 4;
  id: string;
  /** Only explicit user restrictions are authoritative at execution time. */
  hardConstraints?: Array<
    ActionConstraint | { kind: "no_write"; description: string }
  >;
  writeDisposition: "none" | "required" | "uncertain";
  interpretationSource: "semantic" | "classifier" | "deterministic_fallback";
  intent?: import("../types").ClassifiedTurnIntent;
  obligations: AgentActionObligation[];
  /** Readings the host or interpreter chose on the user's behalf (yolo). */
  assumptions?: string[];
  /**
   * Requested actions the host dropped while building the contract because
   * their reference could not be resolved (yolo only). They carry no
   * obligation, so completion evaluation reports each one as not performed
   * unless a receipt for the same operation shows the agent did it anyway.
   */
  skippedActions?: { actionIndex: number; operation: AgentActionOperation }[];
};

export type AgentActionObligationProgress = {
  obligationId: string;
  status:
    | "open"
    | "partially_fulfilled"
    | "fulfilled"
    | "already_satisfied"
    | "cancelled"
    | "failed";
  verifiedTargetIds: string[];
  unresolvedTargetIds: string[];
  journalStepIds: string[];
  failureReasons: string[];
};

/** Mutable, resumable progress kept separately from the immutable contract. */
export type AgentActionProgressLedger = {
  version: 1;
  contractId: string;
  state:
    | "pending"
    | "satisfied"
    | "partial"
    | "cancelled"
    | "failed"
    | "unverified";
  correctionCount: number;
  obligations: AgentActionObligationProgress[];
  appliedReceiptKeys: string[];
  materialOutputs?: import("./workflowDependencies").MaterialOutputReceipt[];
  authorizationGrants?: Array<{
    version?: 2;
    interaction?: import("../authorization/types").ActionInteraction;
    proposalDigest: string;
    toolName: string;
    authority:
      | "external_runtime"
      | "safe_confirmation"
      | "auto_policy"
      | "yolo"
      | "yolo_judgment"
      | "plan_approval";
    status: "staged" | "executed" | "failed" | "uncertain";
    createdAt: number;
  }>;
  updatedAt: number;
};

export type AgentActionProposal = {
  id: string;
  proofDomain: AgentActionProofDomain;
  capability: AgentActionCapability;
  operation: AgentActionOperation;
  parameters?: AgentActionParameters;
  source:
    | "library_mutation"
    | "zotero_native"
    | "file_io"
    | "command"
    | "zotero_script"
    | "full_read";
  operationValue?: LibraryMutationOperation;
  requestedTargets: string[];
  destinationCollectionIds: number[];
  expectedContentHash?: string;
  /** Host-derived finalized export bundle, bound into the exact proposal digest. */
  expectedFiles?: Array<{
    path: string;
    contentHash: string;
    byteLength: number;
  }>;
};

export type AgentActionReceipt = {
  version: 2;
  /** Stamped by the invocation controller, never supplied by tool arguments. */
  executionAuthority?: "external_runtime";
  id: string;
  obligationId?: string;
  proposalId: string;
  proofDomain: AgentActionProofDomain;
  capability: AgentActionCapability;
  operation: AgentActionOperation;
  verification: "verified" | "execution_only" | "not_applicable" | "unverified";
  status:
    | "applied"
    | "already_satisfied"
    | "partial"
    | "cancelled"
    | "failed"
    | "observed"
    | "unverified";
  requestedTargets: string[];
  appliedTargets: string[];
  alreadySatisfiedTargets: string[];
  rejectedTargets: string[];
  normalizedParameters?: AgentActionParameters;
  reasons: string[];
  verifiedFacts: string[];
  evidenceRef?: string;
};

/** Internal authoritative state captured at a journaled mutation boundary. */
export type AgentActionEvidence = {
  version: 1;
  proofDomain: "zotero_state";
  operationValue: LibraryMutationOperation;
  preState: LibraryMutationState;
  postState: LibraryMutationState;
  journalStepId?: string;
  effect: "applied" | "partial" | "none";
};

/** Concrete proposals returned by a tool's validated action adapter. */
export type AgentToolActionDescriptor = AgentActionProposal;

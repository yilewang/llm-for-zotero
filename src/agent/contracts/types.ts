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
  commandFingerprint?: string;
  settingsKey?: string;
  settingsValue?: string;
};

export type AgentActionIntent = {
  capability: AgentActionCapability;
  operation: AgentActionOperation;
  proofDomain: AgentActionProofDomain;
  coverage: "one" | "some" | "all";
  targetKind: "papers" | "items";
  parameters?: AgentActionParameters;
  scope?: {
    kind: "collection";
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
  version: 2;
  id: string;
  writeDisposition: "none" | "required" | "uncertain";
  interpretationSource: "classifier" | "deterministic_fallback";
  obligations: AgentActionObligation[];
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
};

export type AgentActionReceipt = {
  version: 2;
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

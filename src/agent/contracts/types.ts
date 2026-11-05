import type { MaterialRef } from "../documents/materialRef";
import type {
  LibraryMutationOperation,
  LibraryMutationState,
  NativeNoteWriteEvidence,
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
  annotationComment?: string;
  annotationColor?: string;
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
  /** An attached file is linked where it is rather than copied. */
  linkFile?: boolean;
  /** The web address an attach saves. */
  url?: string;
  /** The kind of PDF annotation a write creates. */
  annotationType?: "highlight" | "underline" | "note";
  contentHash?: string;
  documentId?: string;
  /** Frozen with `documentId` and `contentHash` to name one exact material version. */
  documentVersion?: number;
  /**
   * One material identity per item of a batch, in item order. A batch has no
   * single material, so it never fills the flat trio above.
   */
  materialRefs?: readonly MaterialRef[];
  commandFingerprint?: string;
  settingsKey?: string;
  settingsValue?: string;
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
  /**
   * Where the effect itself ran, which is not the same question as who
   * authorized it.
   *
   * `executionAuthority: "external_runtime"` says a connected client's own
   * decision was accepted as the authorization for a host tool call the host
   * then executed, journaled and verified. `origin: "connected_runtime"` says
   * the host executed nothing: the client performed the effect inside its own
   * process, so there is no journal step and no post-state to re-read, and the
   * verification can never be better than `execution_only`. Only the
   * connected-runtime receipt owner (`contracts/externalRuntimeEffects.ts`)
   * sets it, so readers can key on provenance instead of guessing it from a
   * capability.
   */
  origin?: "connected_runtime";
  id: string;
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
  /**
   * What this action's verification actually proved, one fact per claim.
   *
   * Note-write facts name their evidence strength:
   * - `native_note:<noteId>:html_sha256:<hex>` — a forced native read-back
   *   matched the expected HTML. The digest is taken over the read-back string
   *   that came back with the tool result, which the verifier proved
   *   *canonically* equal to the stored note (whitespace normalized, attributes
   *   sorted, Zotero wrapper divs stripped) — not over the stored bytes. Treat
   *   it as a strength token and as a receipt-to-receipt equality token only;
   *   recomputing it from a live note will not reliably match.
   * - `native_note:<noteId>:text_match` — only the weaker plain-text check ran.
   * - neither — content was not proved at all; the receipt covers identity only.
   */
  verifiedFacts: string[];
  /** The exact material version this action consumed, frozen in the proposal. */
  materialRef?: MaterialRef;
  evidenceRef?: string;
};

/**
 * What re-reading a recorded post-image found.
 *
 * `not_re_readable` is deliberately separate from `mismatched`: a receipt that
 * could not check must never be filed as one that checked and disagreed. The
 * reader that produces it lives in `services/recordedPostImage`.
 */
export type AgentPostImageState = {
  kind: "satisfied" | "mismatched" | "not_re_readable";
  /** How many objects the recorded post-image covers. */
  comparedTargets: number;
  reason?: string;
};

/** Internal authoritative state captured at a journaled mutation boundary. */
export type AgentLibraryMutationEvidence = {
  version: 1;
  source: "library_mutation";
  proofDomain: "zotero_state";
  operationValue: LibraryMutationOperation;
  preState: LibraryMutationState;
  postState: LibraryMutationState;
  journalStepId?: string;
  effect: "applied" | "partial" | "none";
  /**
   * Per-note read-backs, for an operation that created notes in bulk.
   *
   * The captured post-state proves the operation's postcondition, which is a
   * claim about the whole set. It is not per-note content evidence, and a
   * durable note batch owes the same read-back fact per note that a single
   * note write owes. These are the read-backs its executor already forced,
   * one per note the call physically created.
   */
  noteWrites?: readonly NativeNoteWriteEvidence[];
  /**
   * For an operation a checkpointed batch ran one item at a time and did not
   * finish cleanly: each one-item part and how it ended. A part that ran is
   * judged on the states above; one that failed or never started is not.
   */
  checkpointParts?: ReadonlyArray<{
    operationValue: LibraryMutationOperation;
    outcome: "ran" | "failed" | "not_started";
    error?: string;
  }>;
};

/**
 * The same evidence for a write that no library mutation operation describes.
 *
 * A note edit, a preference change, an annotation, a file write, a command and
 * a script all journal a pre-image and a post-image; what they lack is an
 * authorized operation the contract could re-check the post-image against. So
 * the record carries both images verbatim and the receipt owner re-reads live
 * state in the shape of the post-image before it credits anything. A receipt
 * built from this proves the effect is still in the library, not that the tool
 * said it landed.
 *
 * It carries the two images and nothing else of the write. The forward payload
 * and the step result are already durable in the journal step this record
 * names, and a note body or a command's output has no business being copied
 * into a second audit row.
 */
export type AgentExternalMutationEvidence = {
  version: 1;
  source: "external_mutation";
  /** The journalled step operation, e.g. `update_preference`. */
  operation: string;
  /** What the plan recorded as true before the write. */
  preImage?: unknown;
  /** What the write recorded as true immediately after it applied. */
  postImage?: unknown;
  /**
   * What the write was authorized to make true, in the same shape.
   *
   * Built from the validated input the user approved, so a receipt that
   * re-reads against this proves the authorized change rather than proving
   * that whatever the tool chose to write is still in place. When it is
   * absent the post-image is the only thing there is to compare against, and
   * the receipt claims no more than that.
   */
  authorizedPostImage?: unknown;
  journalStepId?: string;
  effect: "applied" | "partial" | "none";
};

export type AgentActionEvidence =
  | AgentLibraryMutationEvidence
  | AgentExternalMutationEvidence;

/** Concrete proposals returned by a tool's validated action adapter. */
export type AgentToolActionDescriptor = AgentActionProposal;

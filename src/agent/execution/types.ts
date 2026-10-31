import type { AgentActionCapability } from "../contracts/types";
import type { MaterialRef } from "../documents/materialRef";
import type { ReadScope } from "../digests/readScope";

/** Where one tracked task stands, in ordinary work and in an approved Plan. */
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

/**
 * What completes an outcome. A `digest` part is one the host does itself: it
 * summarizes each paper the part names and ticks the paper when its summary
 * is complete.
 */
export type OutcomeEffect =
  | "read"
  | "artifact"
  | "mutation"
  | "answer"
  | "digest";

/** Targets a receipt rejected or could not do, with the host's reason. */
export type OutcomeException = Readonly<{
  targets: readonly string[];
  reason: string;
}>;

/** How a run ended, refined beyond its persisted terminal status. */
export type RunEndState =
  | "completed"
  | "completed_with_exceptions"
  | "blocked"
  | "interrupted"
  | "cancelled"
  | "failed";

export type ExecutionCheckpointTask = Readonly<{
  taskId: string;
  description: string;
  dependencies: readonly string[];
  status: ExecutionTaskStatus;
  journalActionIds: readonly string[];
  verifiedReceiptIds: readonly string[];
  readEvidenceIds: readonly string[];
  materialRefs: readonly MaterialRef[];
  createdAt: number;
  updatedAt: number;
  /** Absent on a task from before outcomes, which counts as `"answer"`. */
  effect?: OutcomeEffect;
  /** A mutation's kind of write that completes it; absent means any write. */
  capability?: AgentActionCapability;
  /** Host outcomes only: the receipt's operation, for the label. */
  operation?: string;
  /** Declared by the model, or created by the host from a write. */
  origin?: "model" | "host";
  /** Receipt-form targets (`item:12`); none: whatever the evidence names. */
  targets?: readonly string[];
  /**
   * Declared over every paper of the turn's scope: `targets` are those
   * papers, frozen in scope order when it was declared.
   */
  scope?: true;
  /**
   * Targets a verified receipt applied or found already satisfied, or a read
   * attested (at the depth `outcomes.ts` documents).
   */
  doneTargets?: readonly string[];
  exceptions?: readonly OutcomeException[];
  /**
   * Artifact and reasoning parts only: targets the model chose to leave out
   * of what the part delivers, each with the model's reason. They are not
   * exceptions: a part whose only papers not done are excluded is complete.
   */
  excludedTargets?: readonly OutcomeException[];
  /** Every receipt bound here, verified or not, so none binds twice. */
  receiptIds?: readonly string[];
  /**
   * Why the model marked it skipped or blocked, why the host settled it, or
   * why the model replaced it.
   */
  reason?: string;
  /**
   * The qualified taskId of the part that replaced this one. A replaced part
   * is cancelled with the reason, keeps what it did, and no longer counts
   * toward how the run ended.
   */
  supersededBy?: string;
  /**
   * Digest parts only: the user's request the part serves, as declared (at
   * most 2,000 characters). The per-paper worker reads it as context.
   */
  question?: string;
  /**
   * Digest parts only: what of each paper the part reads (`read`), as
   * declared; absent means the full text, as on every part declared
   * before read scopes.
   */
  readScope?: ReadScope;
  /** Digest parts only: papers read for a scope of their own. */
  readOverrides?: readonly Readonly<{ target: string; read: ReadScope }>[];
}>;

/** Entries a list gained: it had `from` entries and now ends with `add`. */
export type ExecutionCheckpointListDelta<T = unknown> = Readonly<{
  from: number;
  add: readonly T[];
}>;

/** How one outcome changed since the run's previous ledger event. */
export type ExecutionCheckpointTaskDelta = Readonly<{
  taskId: string;
  /** A new outcome, whole: a frozen scope is stored here, once. */
  task?: ExecutionCheckpointTask;
  /** Fields with a new value. */
  set?: Partial<ExecutionCheckpointTask>;
  /** Fields it no longer has. */
  unset?: readonly string[];
  /** Lists that only gained entries, by field. */
  grow?: Readonly<Record<string, ExecutionCheckpointListDelta>>;
  /** Exceptions that only gained targets, and new reasons. */
  exceptions?: Readonly<{
    grow?: readonly (ExecutionCheckpointListDelta<string> & { at: number })[];
    add?: readonly (OutcomeException & { at: number })[];
  }>;
}>;

/**
 * One change to a run's ledger since its previous ledger event; folding a
 * run's events in order gives back each ledger (`checkpointEvents.ts`).
 */
export type ExecutionCheckpointDelta = Readonly<{
  executionId: string;
  updatedAt: number;
  tasks: readonly ExecutionCheckpointTaskDelta[];
  end?: Readonly<{ state: RunEndState }>;
}>;

/**
 * Durable progress for ordinary agent work.
 *
 * The checkpoint contains identities only.
 * Journal payloads, native receipts, read observations, and document bodies remain in their existing stores.
 * Nothing in this record grants permission to execute an effect.
 */
export type ExecutionCheckpoint = Readonly<{
  version: 1;
  executionId: string;
  conversationKey: number;
  conversationGeneration: number;
  tasks: readonly ExecutionCheckpointTask[];
  createdAt: number;
  updatedAt: number;
  /** Set when the run that owns this ledger ended. */
  end?: Readonly<{ state: RunEndState }>;
}>;

/**
 * What happened to one finalized material revision, so far.
 *
 * `finalized` means the material exists and no verified note write has claimed
 * it yet; `write_failed` means a note write for that document failed; `saved`
 * means a verified receipt named this exact `MaterialRef`.
 */
export type MaterialOutcomeStatus = "finalized" | "saved" | "write_failed";

export type MaterialOutcomeEntry = Readonly<{
  materialRef: MaterialRef;
  materialKind?: string;
  materialTitle?: string;
  /** The run that finalized this revision. */
  runId: string;
  status: MaterialOutcomeStatus;
  /** Journal action of the write that closed the entry, when one did. */
  actionId?: string;
  /** Receipt that proved the save, when one did. */
  receiptId?: string;
  /** How many outside papers the stored document cites; absent when none. */
  outsidePaperCount?: number;
}>;

export type DroppedMaterialOutcome = Readonly<{
  documentId: string;
  runId: string;
  reason: string;
}>;

/** Material outcomes for one conversation, newest finalization first. */
export type MaterialOutcomeLedger = Readonly<{
  entries: readonly MaterialOutcomeEntry[];
  dropped: readonly DroppedMaterialOutcome[];
}>;

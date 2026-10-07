import type {
  AgentActionCapability,
  AgentActionProposal,
  AgentActionReceipt,
} from "../contracts/types";
import { receiptOperationLabel } from "../contracts/operationCatalog";
import type { MaterialRef } from "../documents/materialRef";
import {
  materialRefKey,
  ordinaryExecutionTaskId,
} from "../execution/checkpoint";
import type {
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
  ExecutionTaskStatus,
  OutcomeEffect,
  OutcomeException,
  RunEndState,
} from "../execution/types";
import type { PaperDigestFailure } from "../digests/paperDigestWorker";
import type { RunStopRule } from "./stopRules";

/**
 * The outcome ledger of an ordinary Original Agent turn.
 *
 * The model declares the parts of a compound request and may mark one
 * skipped, blocked or cancelled with a reason; only host evidence completes
 * one. Every function returns a new checkpoint, or the same one when nothing
 * changed, and never mutates its input.
 *
 * How deep a read must go. A read part that names papers (its targets, or
 * every paper of the turn's scope) asks for each paper's text: a paper is
 * done when a read returned its text (passages, sections, pages, figures,
 * the full text, or an overview of it, sampled or complete). An abstract, an
 * outline or a metadata row does not tick it. A paper the host reports has
 * no readable text becomes an exception, so the part can still complete with
 * the rest read. A read part that names no papers completes on any read, an
 * abstract included.
 *
 * Digest parts. A digest part asks the host to summarize each paper it names
 * itself (`digests/paperDigestWorker.ts`); the model reads none of their
 * text. Only digest evidence that names the part moves it: each paper whose
 * summary is complete is done, and each paper the host gave up on is an
 * exception with the host's reason. A paper done is never excepted again,
 * and a later digest of an excepted paper clears its exception, even after
 * the part settled. Once every paper is one or the other the part completes
 * when any is done, and is skipped with the first reason when none is. The
 * answer does not complete a digest part, and the long-job pager never pages
 * one.
 *
 * Selection. An artifact or a reasoning part delivers a synthesis from the
 * papers it names, and the model may leave some out with its reason
 * (`excludeOutcomeTargets`). An excluded paper is the model's decision, not
 * an exception: it is never "not covered", so a part whose only papers not
 * done are excluded completes clean. Content that cites an excluded paper
 * after all makes it done, as what the output used wins. A part that names
 * no papers (a review declared without scope) takes any paper as an
 * exclusion, has none to be done, and completes whole; content that cites
 * an excluded paper drops that exclusion there too. Every other part
 * covers every paper it names, and takes no exclusion. A document may name
 * the papers it leaves out as it is submitted: they are recorded on the part
 * it binds to by the same rules, except that the document is final, so a
 * paper it cites, or one the part does not name or has done, is ignored
 * rather than refused.
 *
 * Revision. Declaring a part again with another description, effect,
 * capability or papers changes it in place while it holds no progress
 * (`redeclarable`). A part with progress is replaced instead: a new part
 * names it in `replaces`, with the reason, and the old part is cancelled
 * with `supersededBy`, keeping what it did. A replaced part no longer counts
 * toward how the run ended (`decideRunEnd`), takes no further evidence, and
 * content that names it is its successor's.
 */

export type OutcomeDeclaration = {
  taskId: string;
  description: string;
  effect: OutcomeEffect;
  capability?: AgentActionCapability;
  targets?: readonly string[];
  /** The targets are every paper of the turn's scope, frozen now. */
  scope?: boolean;
  /** A digest part's user request, as `task_update` captured it. */
  question?: string;
  /** The local or qualified taskId of the pending part this one replaces. */
  replaces?: string;
  /** Why it replaces that part; required with `replaces`. */
  reason?: string;
};

/** Papers the model leaves out of an artifact or reasoning part. */
export type OutcomeExclusion = {
  taskId: string;
  /** The papers as the model names them: `12` or `item:12`. */
  targets: readonly string[];
  reason: string;
};

/** Papers a submitted document leaves out of the part it binds to. */
export type OutcomeDocumentExclusion = Omit<OutcomeExclusion, "taskId">;

/** Why an exclusion was refused; a refused call changes nothing. */
export type OutcomeExclusionRefusal =
  /** The part covers every paper it names: digest, read or write. */
  | { taskId: string; kind: "effect"; effect: OutcomeEffect }
  /** The part is settled without papers left to leave out. */
  | { taskId: string; kind: "status"; status: ExecutionTaskStatus }
  /** Papers, as named, that are not its targets, or that it has done. */
  | { taskId: string; kind: "papers"; notTargets: string[]; done: string[] };

export type OutcomeModelMark = {
  taskId: string;
  status: "skipped" | "blocked" | "cancelled";
  reason: string;
};

export type OutcomeEvidence =
  | {
      kind: "read";
      /** Papers whose text the read returned. */
      targets: readonly string[];
      /** Papers it read no deeper than an abstract or an outline. */
      shallow?: readonly string[];
      /** Papers the host reported have no readable text. */
      noText?: readonly string[];
      observationIds: readonly string[];
    }
  | { kind: "receipt"; receipt: AgentActionReceipt }
  | {
      kind: "material";
      materialRef: MaterialRef;
      /** The part the producing call named (its local taskId), if any. */
      taskId?: string;
      /** The document's kind, as submit_document's documentKind names it. */
      documentKind?: string;
      /** `item:ID` of every source the material cites. */
      citedTargets?: readonly string[];
      /** Papers the document leaves out, with the model's reasons. */
      excluded?: readonly OutcomeDocumentExclusion[];
    }
  | {
      kind: "declined";
      /** The declined tool call, which identifies the decline. */
      callId: string;
      proposals: readonly Pick<
        AgentActionProposal,
        "capability" | "operation" | "requestedTargets"
      >[];
      /**
       * The user approved the call without these targets: rows it left
       * untouched in the review card. Only a part that names them records it.
       */
      narrowed?: true;
    }
  | {
      kind: "answer";
      /** `item:ID` of every source the accepted answer cites. */
      citedTargets?: readonly string[];
    }
  | {
      kind: "failed";
      /** Papers a tool failed on twice the same way; the host gives up on them. */
      targets: readonly string[];
      reason: string;
    }
  | {
      kind: "digest";
      /** The digest part, qualified (`<executionId>:task:<local>`). */
      taskId: string;
      /** Papers whose digest is complete, in the part's own target form. */
      done: readonly string[];
      /** Papers whose digest failed for good, with the host's reason. */
      failed: readonly Pick<PaperDigestFailure, "target" | "reason">[];
    };

/** Every reason the host writes into the ledger, for the UI to translate. */
export const OUTCOME_REASONS = Object.freeze({
  markReasonRequired: "A skipped, blocked, or cancelled task needs the reason.",
  unverified:
    "The change could not be verified; check the current state before retrying.",
  declined: "You declined this change.",
  notApplied: "Not applied",
  notDone: "Not done before the answer.",
  writeFailed: "The change was not applied.",
  noText: "No readable text",
  notCovered: "Not covered by the delivered content",
});

/** The refusal of an exclusion without its reason. */
const EXCLUSION_REASON_REQUIRED = "An excluded paper needs the reason.";

type Task = ExecutionCheckpointTask;
type Write = Pick<AgentActionProposal, "capability" | "requestedTargets">;
type EvidenceResult = { checkpoint: ExecutionCheckpoint; changed: boolean };

const OUTCOME_EFFECTS: ReadonlySet<string> = new Set<OutcomeEffect>([
  "read",
  "artifact",
  "mutation",
  "answer",
  "digest",
]);
const MARK_STATUSES: ReadonlySet<string> = new Set([
  "skipped",
  "blocked",
  "cancelled",
]);
const MARKABLE_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "blocked",
]);
/** A digest part takes evidence while open, and a retry after it settled. */
const DIGEST_CANDIDATE_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "completed",
  "skipped",
]);
const RECEIPT_CANDIDATE_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "blocked",
]);
const DECLINE_CANDIDATE_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
]);
/** A part takes an exclusion while open, and once completed with papers left. */
const EXCLUDABLE_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "blocked",
  "completed",
]);
const PROOF_VERIFICATIONS: ReadonlySet<string> = new Set([
  "verified",
  "execution_only",
]);
const DONE_RECEIPT_STATUSES: ReadonlySet<string> = new Set([
  "applied",
  "already_satisfied",
  "partial",
  "observed",
]);
const NOTE_CONTENT_OPERATIONS: ReadonlySet<string> = new Set([
  "note_create",
  "note_edit",
  "note_append",
]);
/** Writes that create a note on a paper: repeating one writes it twice. */
const NOTE_CREATING_OPERATIONS: ReadonlySet<string> = new Set([
  "note_create",
  "save_note",
  "save_notes_batch",
]);
const INTERRUPTING_STOP_RULES: ReadonlySet<RunStopRule> = new Set<RunStopRule>([
  "interrupted_by_error",
  "stream_interrupted_again",
  "incomplete_step_limit",
  "segment_without_progress",
  "repeated_tool_errors",
  "page_failed",
]);
const LOCAL_TASK_ID_LENGTH = 128;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function union(
  base: readonly string[] | undefined,
  added: readonly string[],
): string[] {
  return unique([...(base || []), ...added]);
}

/** A bare Zotero id, as models write one. */
const BARE_ID = /^[1-9]\d*$/;

/** The kinds of target the host's receipts and reads name: `item:5`, … */
const TARGET_KINDS: ReadonlySet<string> = new Set([
  "item",
  "collection",
  "saved-search",
  "attachment",
  "note",
  "file",
  "search",
  "setting",
  "tag",
  "tags",
]);

/**
 * Whether `value` is a target in a form receipts and reads name: a bare
 * Zotero id (`12`) or a kind and id (`item:12`, `collection:3`, …). A paper
 * named any other way ("Smith 2020", a DOI) names nothing the host tracks.
 */
export function isOutcomeTargetId(value: string): boolean {
  const trimmed = String(value).trim();
  if (BARE_ID.test(trimmed)) return true;
  const kind = /^([a-z][a-z-]*):\S/.exec(trimmed)?.[1];
  return Boolean(kind && TARGET_KINDS.has(kind));
}

/**
 * A part's targets in the forms receipts and reads name. A bare id is an
 * item's (`item:<id>`), except under zotero.collections, whose writes name
 * items (filing papers) and folders (renaming one) alike: there it stays
 * bare and matches whichever of the two a receipt names (`resolveTarget`).
 * A target that is no such form, such as "new collection" or a DOI, names
 * nothing a receipt can carry, so it is left out, and a part left with none
 * tracks its capability's writes, as a part without targets does.
 */
function outcomeTargets(
  values: readonly string[] | undefined,
  capability?: AgentActionCapability,
): string[] {
  return unique(
    (values || [])
      .map((value) => String(value).trim())
      .filter(Boolean)
      .flatMap((value) => {
        if (BARE_ID.test(value))
          return [
            capability === "zotero.collections" ? value : `item:${value}`,
          ];
        const kind = /^([a-z][a-z-]*):\S/.exec(value)?.[1];
        return kind && TARGET_KINDS.has(kind) ? [value] : [];
      }),
  );
}

/**
 * The target among `named` that a part's declared target means: itself, or,
 * for a bare id, the one target named with that id. A bare id two targets
 * share (item 5 and folder 5) means neither.
 */
function resolveTarget(
  declared: string,
  named: readonly string[],
): string | undefined {
  if (named.includes(declared)) return declared;
  if (!BARE_ID.test(declared)) return undefined;
  const matches = named.filter(
    (target) => target.slice(target.indexOf(":") + 1) === declared,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Whether one of a part's `values` (its targets, done or excepted) means `target`. */
function namesTarget(
  values: readonly string[] | undefined,
  target: string,
): boolean {
  return (values || []).some(
    (value) => resolveTarget(value, [target]) !== undefined,
  );
}

function covers(task: Task, targets: readonly string[]): boolean {
  return (
    !task.targets?.length ||
    task.targets.some((target) => resolveTarget(target, targets) !== undefined)
  );
}

function acceptsWrite(task: Task, write: Write): boolean {
  return (
    task.effect === "mutation" &&
    (!task.capability || task.capability === write.capability) &&
    covers(task, write.requestedTargets)
  );
}

/** A verified note body: written content the host can point to. */
function isNoteContent(receipt: AgentActionReceipt): boolean {
  return (
    receipt.capability === "zotero.notes" &&
    NOTE_CONTENT_OPERATIONS.has(receipt.operation) &&
    receipt.verification === "verified" &&
    DONE_RECEIPT_STATUSES.has(receipt.status)
  );
}

/** A read is not a write, so it neither closes a mutation nor becomes one. */
function isWrite(write: Pick<Write, "capability">): boolean {
  return write.capability !== "zotero.read";
}

/** A write that creates a note on each paper it names. */
function createsNotes(
  write: Pick<AgentActionProposal, "capability" | "operation">,
): boolean {
  return (
    write.capability === "zotero.notes" &&
    NOTE_CREATING_OPERATIONS.has(write.operation)
  );
}

/**
 * Whether a new note on `paper` would be this part's note on it: a part that
 * takes notes and names the paper without having it done, open to the note's
 * receipt (pending or blocked, or settled with the paper excepted, which a
 * note on it clears). The note's receipt binds such a part
 * (`notePapersByPart`); the duplicate-note guard (`papersAlreadyWritten`)
 * and the resume reconciliation ask whether one is left.
 */
function owesNote(task: Task, paper: string): boolean {
  if (
    task.effect !== "mutation" ||
    (task.capability && task.capability !== "zotero.notes") ||
    !namesTarget(task.targets, paper) ||
    namesTarget(task.doneTargets, paper)
  )
    return false;
  return (
    RECEIPT_CANDIDATE_STATUSES.has(task.status) ||
    ((task.status === "completed" || task.status === "skipped") &&
      namesTarget(
        (task.exceptions || []).flatMap((entry) => entry.targets),
        paper,
      ))
  );
}

/** Whether a receipt or a declined call is already bound to some outcome. */
function isBound(checkpoint: ExecutionCheckpoint, identity: string): boolean {
  return checkpoint.tasks.some(
    (task) =>
      task.receiptIds?.includes(identity) ||
      task.verifiedReceiptIds.includes(identity),
  );
}

function newTask(taskId: string, description: string, now: number): Task {
  return {
    taskId,
    description,
    dependencies: [],
    status: "pending",
    journalActionIds: [],
    verifiedReceiptIds: [],
    readEvidenceIds: [],
    materialRefs: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** The first namespaced id among `local(1)`, `local(2)`, … no task uses. */
function freeTaskId(
  checkpoint: ExecutionCheckpoint,
  local: (attempt: number) => string,
): string {
  const taken = new Set(checkpoint.tasks.map((task) => task.taskId));
  for (let attempt = 1; ; attempt += 1) {
    const taskId = ordinaryExecutionTaskId(
      checkpoint.executionId,
      local(attempt),
    );
    if (!taken.has(taskId)) return taskId;
  }
}

/** `host:<receipt id>` within the task-id alphabet and length. */
function hostReceiptTaskId(
  checkpoint: ExecutionCheckpoint,
  receiptId: string,
): string {
  const base = `host:${receiptId}`.replace(/[^A-Za-z0-9._-]/g, "-");
  return freeTaskId(checkpoint, (attempt) => {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    return `${base.slice(0, LOCAL_TASK_ID_LENGTH - suffix.length)}${suffix}`;
  });
}

function unchanged(checkpoint: ExecutionCheckpoint): EvidenceResult {
  return { checkpoint, changed: false };
}

/** Replace each task `update` returns a new version of. */
function mapTasks(
  checkpoint: ExecutionCheckpoint,
  now: number,
  update: (task: Task, index: number) => Task | undefined,
): EvidenceResult {
  let changed = false;
  const tasks = checkpoint.tasks.map((task, index) => {
    const next = update(task, index);
    if (!next) return task;
    changed = true;
    return next;
  });
  if (!changed) return unchanged(checkpoint);
  return { checkpoint: { ...checkpoint, tasks, updatedAt: now }, changed };
}

function appended(
  checkpoint: ExecutionCheckpoint,
  task: Task,
  now: number,
): EvidenceResult {
  return {
    checkpoint: {
      ...checkpoint,
      tasks: [...checkpoint.tasks, task],
      updatedAt: now,
    },
    changed: true,
  };
}

function withException(
  exceptions: readonly OutcomeException[],
  targets: readonly string[],
  reason: string,
): readonly OutcomeException[] {
  if (!targets.length) return exceptions;
  const index = exceptions.findIndex((entry) => entry.reason === reason);
  if (index < 0) return [...exceptions, { targets, reason }];
  return exceptions.map((entry, at) =>
    at === index ? { targets: union(entry.targets, targets), reason } : entry,
  );
}

function completed(task: Task): Task {
  const { reason, ...rest } = task;
  return { ...rest, status: "completed" };
}

/*
 * Batches. A write that names several papers is accounted paper by paper:
 * the papers a failed batch did not change, the papers of a declined batch,
 * and the rows the user left untouched in a card it approved become
 * exceptions with the reason, and the part stays open for the next batch. A
 * write that names one paper keeps the single-write rules: a failure leaves
 * its part open with the reason, and a decline blocks it. A later success
 * clears a paper's exception, even after its part settled.
 */

/** A write that names several papers. */
function isBatch(targets: readonly string[]): boolean {
  return unique(targets).length > 1;
}

/** Except `targets` with `reason`; a paper already excepted keeps its first reason. */
function exceptTargets(
  exceptions: readonly OutcomeException[],
  targets: readonly string[],
  reason: string,
): readonly OutcomeException[] {
  const excepted = new Set(exceptions.flatMap((entry) => entry.targets));
  return withException(
    exceptions,
    targets.filter((target) => !excepted.has(target)),
    reason,
  );
}

/** The exceptions without the papers since done. */
function withoutDone(
  exceptions: readonly OutcomeException[],
  done: readonly string[],
): readonly OutcomeException[] {
  return exceptions.flatMap((entry) => {
    const left = entry.targets.filter((target) => !done.includes(target));
    return left.length ? [{ ...entry, targets: left }] : [];
  });
}

/** The papers a failed batch named and did not change. */
function failedBatchTargets(receipt: AgentActionReceipt): string[] {
  if (receipt.status !== "failed" || !isBatch(receipt.requestedTargets)) {
    return [];
  }
  const settled = new Set([
    ...receipt.appliedTargets,
    ...receipt.alreadySatisfiedTargets,
    ...receipt.rejectedTargets,
  ]);
  return unique(receipt.requestedTargets).filter(
    (target) => !settled.has(target),
  );
}

/**
 * A part that names papers, once each is done or excepted: completed when
 * any is done; with none done, blocked when the user declined one, as a
 * declined write is, and otherwise skipped with the first reason.
 */
function settleTargets(task: Task): Task {
  const targets = task.targets || [];
  const done = new Set(task.doneTargets || []);
  const exceptions = task.exceptions || [];
  const accounted = new Set([
    ...done,
    ...exceptions.flatMap((entry) => entry.targets),
  ]);
  if (!targets.length || !targets.every((target) => accounted.has(target))) {
    return task;
  }
  if (targets.some((target) => done.has(target))) return completed(task);
  return exceptions.some((entry) => entry.reason === OUTCOME_REASONS.declined)
    ? { ...task, status: "blocked", reason: OUTCOME_REASONS.declined }
    : { ...task, status: "skipped", reason: exceptions[0].reason };
}

/** A settled part takes a receipt that proves one of its excepted papers done. */
function clearsException(task: Task, receipt: AgentActionReceipt): boolean {
  if (task.status !== "completed" && task.status !== "skipped") return false;
  if (
    !PROOF_VERIFICATIONS.has(receipt.verification) ||
    !DONE_RECEIPT_STATUSES.has(receipt.status)
  ) {
    return false;
  }
  const proven = [
    ...receipt.appliedTargets,
    ...receipt.alreadySatisfiedTargets,
  ];
  return (task.exceptions || []).some((entry) =>
    entry.targets.some((target) => resolveTarget(target, proven) !== undefined),
  );
}

/**
 * A declined batch, or rows left untouched in an approved card: each open
 * part that names those papers excepts them. Undefined for a declined
 * one-paper write, or a declined batch no part names, which the single-write
 * rule handles; rows no part names record nothing.
 */
function declineBatch(
  checkpoint: ExecutionCheckpoint,
  evidence: Extract<OutcomeEvidence, { kind: "declined" }>,
  writes: readonly Write[],
  identity: string,
  now: number,
): EvidenceResult | undefined {
  const declined = unique(writes.flatMap((write) => write.requestedTargets));
  if (!evidence.narrowed && !isBatch(declined)) return undefined;
  const chosen = new Set(
    checkpoint.tasks.flatMap((task, index) =>
      task.targets?.length &&
      DECLINE_CANDIDATE_STATUSES.has(task.status) &&
      writes.some((write) => acceptsWrite(task, write))
        ? [index]
        : [],
    ),
  );
  if (!chosen.size)
    return evidence.narrowed ? unchanged(checkpoint) : undefined;
  return mapTasks(checkpoint, now, (task, index) => {
    if (!chosen.has(index)) return undefined;
    const done = new Set(task.doneTargets || []);
    // The part's own papers the call named, in the part's own form.
    const exceptions = exceptTargets(
      task.exceptions || [],
      task.targets!.filter(
        (target) =>
          resolveTarget(target, declined) !== undefined && !done.has(target),
      ),
      OUTCOME_REASONS.declined,
    );
    return settleTargets({
      ...task,
      receiptIds: union(task.receiptIds, [identity]),
      ...(exceptions.length ? { exceptions } : {}),
      updatedAt: now,
    });
  });
}

/**
 * Bind a receipt to one part. `papers`, for a note, are the receipt's
 * targets it gives this part (`notePapersByPart`); the part takes no other.
 */
function bindReceipt(
  task: Task,
  receipt: AgentActionReceipt,
  now: number,
  papers?: readonly string[],
): Task {
  const targets = task.targets || [];
  // The part's own targets a receipt's list names, in the part's own form.
  const own = (values: readonly string[]): string[] => {
    const given = papers
      ? values.filter((value) => papers.includes(value))
      : values;
    return unique(
      targets.length
        ? targets.filter((target) => resolveTarget(target, given) !== undefined)
        : given,
    );
  };
  const proves =
    PROOF_VERIFICATIONS.has(receipt.verification) &&
    DONE_RECEIPT_STATUSES.has(receipt.status);
  const doneTargets = union(
    task.doneTargets,
    proves
      ? own([...receipt.appliedTargets, ...receipt.alreadySatisfiedTargets])
      : [],
  );
  const exceptions = exceptTargets(
    exceptTargets(
      withoutDone(task.exceptions || [], doneTargets),
      own(receipt.rejectedTargets),
      receipt.reasons[0]?.trim() || OUTCOME_REASONS.notApplied,
    ),
    own(failedBatchTargets(receipt)),
    receipt.reasons[0]?.trim() || OUTCOME_REASONS.writeFailed,
  );
  const { exceptions: _previous, ...rest } = task;
  const bound: Task = {
    ...rest,
    verifiedReceiptIds:
      proves && receipt.verification === "verified"
        ? union(task.verifiedReceiptIds, [receipt.id])
        : task.verifiedReceiptIds,
    receiptIds: union(task.receiptIds, [receipt.id]),
    ...(doneTargets.length ? { doneTargets } : {}),
    ...(exceptions.length ? { exceptions } : {}),
    updatedAt: now,
  };
  if (receipt.status === "unverified") {
    return { ...bound, status: "blocked", reason: OUTCOME_REASONS.unverified };
  }
  const settled = settleTargets(bound);
  if (settled !== bound) return settled;
  if (!targets.length && proves) return completed(bound);
  if (
    (receipt.status === "failed" || receipt.status === "cancelled") &&
    !isBatch(receipt.requestedTargets)
  ) {
    return {
      ...bound,
      reason: receipt.reasons[0]?.trim() || OUTCOME_REASONS.writeFailed,
    };
  }
  return bound;
}

/** A read part that names no papers: any read completes it. */
function readAnyInto(
  task: Task,
  read: readonly string[],
  observationIds: readonly string[],
  now: number,
): Task {
  const doneTargets = union(task.doneTargets, read);
  return {
    ...task,
    status: "completed",
    readEvidenceIds: union(task.readEvidenceIds, observationIds),
    ...(doneTargets.length ? { doneTargets } : {}),
    updatedAt: now,
  };
}

/**
 * A read part that names papers takes only its own, at the depth the module
 * doc sets: a paper whose text was read is done, a paper the host found no
 * text for is excepted, and the part settles once every paper is one or the
 * other.
 */
function readTargetsInto(
  task: Task,
  read: readonly string[],
  noText: readonly string[],
  observationIds: readonly string[],
  now: number,
): Task | undefined {
  const targets = task.targets || [];
  const own = (values: readonly string[]) =>
    values.filter((value) => targets.includes(value));
  if (!own(read).length && !own(noText).length) return undefined;
  const doneTargets = union(task.doneTargets, own(read));
  const done = new Set(doneTargets);
  // A paper read after the host found no text for it is done, not excepted.
  const kept = (task.exceptions || []).flatMap((entry) => {
    const left = entry.targets.filter((target) => !done.has(target));
    return left.length ? [{ ...entry, targets: left }] : [];
  });
  const exceptions = withException(
    kept,
    own(noText).filter((target) => !done.has(target)),
    OUTCOME_REASONS.noText,
  );
  const readEvidenceIds = union(task.readEvidenceIds, observationIds);
  if (
    doneTargets.length === (task.doneTargets?.length || 0) &&
    readEvidenceIds.length === task.readEvidenceIds.length &&
    JSON.stringify(exceptions) === JSON.stringify(task.exceptions || [])
  ) {
    return undefined;
  }
  const { exceptions: _previous, ...rest } = task;
  const next: Task = {
    ...rest,
    readEvidenceIds,
    ...(doneTargets.length ? { doneTargets } : {}),
    ...(exceptions.length ? { exceptions } : {}),
    updatedAt: now,
  };
  const accounted = new Set([
    ...doneTargets,
    ...exceptions.flatMap((entry) => entry.targets),
  ]);
  if (!targets.every((target) => accounted.has(target))) return next;
  return doneTargets.length
    ? completed(next)
    : { ...next, status: "skipped", reason: exceptions[0].reason };
}

function applyRead(
  checkpoint: ExecutionCheckpoint,
  evidence: Extract<OutcomeEvidence, { kind: "read" }>,
  now: number,
): EvidenceResult {
  const read = unique(evidence.targets);
  const shallow = unique(evidence.shallow || []);
  const noText = unique(evidence.noText || []);
  const observationIds = unique(evidence.observationIds);
  const anyRead = unique([...read, ...shallow]);
  const bound = new Set(
    checkpoint.tasks.flatMap((task) => task.readEvidenceIds),
  );
  const replayed =
    observationIds.length > 0 && observationIds.every((id) => bound.has(id));
  return mapTasks(checkpoint, now, (task) => {
    if (task.status !== "pending" || task.effect !== "read") return undefined;
    // A read reaches each part that names its papers, once: one another part
    // already holds still ticks a part declared after it (a back-fill, or a
    // re-read the cache answered).
    if (task.targets?.length) {
      return readTargetsInto(task, read, noText, observationIds, now);
    }
    // A part that names no papers completes on a new read only, and finding
    // that a paper has no text reads nothing.
    if (replayed) return undefined;
    return anyRead.length || observationIds.length
      ? readAnyInto(task, anyRead, observationIds, now)
      : undefined;
  });
}

/**
 * The writes one receipt proves, each as the parts see it: the receipt
 * itself, and for an import that files its items in a folder, that
 * membership too: a zotero.collections write over the folder and the items,
 * under the same receipt. The import's postcondition checked that every
 * imported item is in the folder, so a receipt that proves the import
 * proves the membership. The membership goes only to a part that asks for
 * folder writes or names the folder or the items.
 */
function provenWrites(receipt: AgentActionReceipt): AgentActionReceipt[] {
  const folder = receipt.normalizedParameters?.destinationCollectionId;
  if (
    receipt.capability !== "zotero.import" ||
    !Number.isInteger(folder) ||
    Number(folder) <= 0
  )
    return [receipt];
  const membership = `collection:${folder}`;
  const add = (targets: readonly string[]) =>
    targets.length ? unique([membership, ...targets]) : [];
  return [
    receipt,
    {
      ...receipt,
      capability: "zotero.collections",
      requestedTargets: unique([membership, ...receipt.requestedTargets]),
      appliedTargets: add(receipt.appliedTargets),
      alreadySatisfiedTargets: receipt.appliedTargets.length
        ? receipt.alreadySatisfiedTargets
        : add(receipt.alreadySatisfiedTargets),
    },
  ];
}

/**
 * One part per note: the papers a note-creating write gives each of the
 * parts for notes that take it (`candidates`, in declaration order). A
 * paper goes to the first of them that names it and has not got it done, so
 * the next note on the paper goes to the next such part, and two parts that
 * each ask a note of a paper take two. A paper every one of them has done
 * goes to the first that names it, which it ticks no further. A tag, a
 * folder or a field set twice is one state, so those writes bind every part
 * that names their targets instead.
 */
function notePapersByPart(
  tasks: readonly Task[],
  candidates: readonly number[],
  write: AgentActionReceipt,
): Map<number, string[]> {
  const papers = unique([
    ...write.requestedTargets,
    ...write.appliedTargets,
    ...write.alreadySatisfiedTargets,
    ...write.rejectedTargets,
  ]);
  const byPart = new Map<number, string[]>();
  for (const paper of papers) {
    const naming = candidates.filter((index) =>
      namesTarget(tasks[index].targets, paper),
    );
    const index =
      naming.find((at) => !namesTarget(tasks[at].doneTargets, paper)) ??
      naming[0];
    if (index !== undefined)
      byPart.set(index, [...(byPart.get(index) || []), paper]);
  }
  return byPart;
}

function applyReceipt(
  checkpoint: ExecutionCheckpoint,
  receipt: AgentActionReceipt,
  now: number,
): EvidenceResult {
  if (!isWrite(receipt) || isBound(checkpoint, receipt.id)) {
    return unchanged(checkpoint);
  }
  // Each write the receipt proves binds every part that names its targets,
  // else the first part without targets that takes it; a note binds one
  // part for notes on each paper (`notePapersByPart`).
  const chosen = new Map<
    number,
    { write: AgentActionReceipt; papers?: string[] }
  >();
  for (const write of provenWrites(receipt)) {
    const membership = write !== receipt;
    const candidates = checkpoint.tasks.flatMap((task, index) =>
      !chosen.has(index) &&
      (RECEIPT_CANDIDATE_STATUSES.has(task.status) ||
        clearsException(task, write)) &&
      acceptsWrite(task, write) &&
      (!membership ||
        task.capability === "zotero.collections" ||
        Boolean(task.targets?.length))
        ? [index]
        : [],
    );
    const targeted = candidates.filter(
      (index) => checkpoint.tasks[index].targets?.length,
    );
    if (targeted.length && createsNotes(write)) {
      // A part that takes any write may be a tag's or a folder's as well as
      // a note's: it takes every note on its papers, as it takes any write.
      const forNotes = targeted.filter(
        (index) => checkpoint.tasks[index].capability,
      );
      for (const [index, papers] of notePapersByPart(
        checkpoint.tasks,
        forNotes,
        write,
      ))
        chosen.set(index, { write, papers });
      for (const index of targeted)
        if (!checkpoint.tasks[index].capability) chosen.set(index, { write });
      continue;
    }
    for (const index of targeted.length ? targeted : candidates.slice(0, 1))
      chosen.set(index, { write });
  }
  if (chosen.size) {
    return mapTasks(checkpoint, now, (task, index) => {
      const binding = chosen.get(index);
      return binding
        ? bindReceipt(task, binding.write, now, binding.papers)
        : undefined;
    });
  }
  // Written content saved as a note is the artifact a part asked for.
  const artifact = isNoteContent(receipt)
    ? checkpoint.tasks.findIndex(
        (task) => task.status === "pending" && task.effect === "artifact",
      )
    : -1;
  if (artifact >= 0) {
    return mapTasks(checkpoint, now, (task, index) =>
      index === artifact ? bindReceipt(task, receipt, now) : undefined,
    );
  }
  const targets = unique(receipt.requestedTargets);
  const host: Task = {
    ...newTask(
      hostReceiptTaskId(checkpoint, receipt.id),
      receiptOperationLabel(receipt),
      now,
    ),
    effect: "mutation",
    origin: "host",
    capability: receipt.capability,
    operation: receipt.operation,
    ...(targets.length ? { targets } : {}),
  };
  return appended(checkpoint, bindReceipt(host, receipt, now), now);
}

/*
 * Delivered content. A document, or the accepted answer, is the artifact a
 * part asked for. A part that names papers is accounted per paper: the papers
 * the content cites are done, and the rest become exceptions unless the model
 * excluded them, so "12/12" means twelve papers were covered. A part that
 * names none completes.
 */

/** A document kind's words in a part's description, for an unnamed binding. */
const KIND_DESCRIPTION_PATTERNS: Readonly<Record<string, RegExp>> = {
  literature_review: /\b(review|synthesis|synthesi[sz]e)\b/i,
  research_brief: /\bbrief\b/i,
  comparison: /\bcompar/i,
  report: /\breport\b/i,
  guide: /\b(guide|tutorial|how[- ]to)\b/i,
};

function isPendingArtifact(task: Task): boolean {
  return task.status === "pending" && task.effect === "artifact";
}

/**
 * The part at `index` as it stands now: itself, or the part that replaced
 * it, followed to the last replacement. -1 when `index` is -1, or when the
 * ledger does not hold a replacement it names.
 */
function successorOf(checkpoint: ExecutionCheckpoint, index: number): number {
  const seen = new Set<number>();
  let at = index;
  while (at >= 0 && checkpoint.tasks[at].supersededBy && !seen.has(at)) {
    seen.add(at);
    const next = checkpoint.tasks[at].supersededBy;
    at = checkpoint.tasks.findIndex((task) => task.taskId === next);
  }
  return at;
}

/**
 * The part delivered content binds to, and whether it binds as a revision.
 *
 * A call that names a part binds only to it: an open artifact part is
 * covered; a settled artifact part takes the material as a revision of what
 * it already delivered; any other part takes nothing. A call that names no
 * existing part binds to the first pending artifact part whose description
 * names the content's kind; else, as a revision, to an artifact part that
 * already holds a document and whose description names the kind (the
 * ledger keeps no document kind, so a part's description stands for the
 * kind it delivers); else to the first pending artifact part. A revision of
 * a delivered document is never another part's delivery. A named part the
 * model replaced stands for the part that replaced it, and a replaced part
 * takes no revision by its kind. Undefined when nothing takes it.
 */
function artifactPartFor(
  checkpoint: ExecutionCheckpoint,
  named: { taskId?: string; kind?: string },
): { index: number; revision: boolean } | undefined {
  let taskId: string | undefined;
  try {
    taskId = named.taskId
      ? ordinaryExecutionTaskId(checkpoint.executionId, named.taskId)
      : undefined;
  } catch {
    // A malformed id names no part; the content still binds by its kind.
  }
  const own = successorOf(
    checkpoint,
    taskId ? checkpoint.tasks.findIndex((task) => task.taskId === taskId) : -1,
  );
  if (own >= 0) {
    const task = checkpoint.tasks[own];
    if (task.effect !== "artifact") return undefined;
    return { index: own, revision: !MARKABLE_STATUSES.has(task.status) };
  }
  const pattern = named.kind
    ? KIND_DESCRIPTION_PATTERNS[named.kind]
    : undefined;
  const byKind = pattern
    ? checkpoint.tasks.findIndex(
        (task) => isPendingArtifact(task) && pattern.test(task.description),
      )
    : -1;
  if (byKind >= 0) return { index: byKind, revision: false };
  const delivered = pattern
    ? checkpoint.tasks.findIndex(
        (task) =>
          task.effect === "artifact" &&
          !task.supersededBy &&
          task.materialRefs.length > 0 &&
          pattern.test(task.description),
      )
    : -1;
  if (delivered >= 0) return { index: delivered, revision: true };
  const index = checkpoint.tasks.findIndex(isPendingArtifact);
  return index >= 0 ? { index, revision: false } : undefined;
}

/**
 * `task` without the exclusions that content citing `cited` contradicts: a
 * paper the content cites is one it used, so it is no longer left out.
 * Unchanged when what the content cites is unknown.
 */
function withoutCitedExclusions(
  task: Task,
  cited: readonly string[] | undefined,
): Task {
  if (!cited || !task.excludedTargets?.length) return task;
  const { excludedTargets: held, ...rest } = task;
  const left = withoutDone(held!, cited);
  return left.length ? { ...rest, excludedTargets: left } : rest;
}

/**
 * Complete an artifact part from content citing `cited`. With `cited`
 * unknown the part completes whole. Otherwise each of its targets the content
 * cites is done, an excluded one included, and each other target is excepted
 * as not covered unless the model excluded it. A paper done stays done, so a
 * revision only adds the papers it covers.
 */
function coverTargets(
  task: Task,
  cited: readonly string[] | undefined,
  now: number,
): Task {
  const targets = task.targets || [];
  // A part with no papers completes whole; what the content cites is no
  // longer left out.
  if (!targets.length)
    return {
      ...completed(withoutCitedExclusions(task, cited)),
      updatedAt: now,
    };
  if (!cited) return { ...completed(task), updatedAt: now };
  // A folder or tag target is covered by content that cites any paper: the
  // part asked for a synthesis over that scope, and the papers it left out
  // are the model's exclusions.
  const doneTargets = union(
    task.doneTargets,
    targets.filter(
      (target) =>
        cited.includes(target) || (!isPaperTarget(target) && cited.length > 0),
    ),
  );
  const done = new Set(doneTargets);
  const excludedTargets = withoutDone(task.excludedTargets || [], doneTargets);
  const excluded = new Set(excludedTargets.flatMap((entry) => entry.targets));
  const exceptions = exceptTargets(
    withoutDone(task.exceptions || [], doneTargets),
    targets.filter((target) => !done.has(target) && !excluded.has(target)),
    OUTCOME_REASONS.notCovered,
  );
  const {
    exceptions: _previous,
    excludedTargets: _excluded,
    ...rest
  } = completed(task);
  return {
    ...rest,
    doneTargets,
    ...(exceptions.length ? { exceptions } : {}),
    ...(excludedTargets.length ? { excludedTargets } : {}),
    updatedAt: now,
  };
}

/**
 * `task` with the papers a document bound to it leaves out, recorded as
 * `excludeOutcomeTargets` records them but leniently, as the document is
 * final: a paper it cites is one it used, so it is never excluded, and a
 * paper the part does not name, or has done, is ignored, not refused.
 * `task` itself when that records nothing.
 */
function withDocumentExclusions(
  task: Task,
  exclusions: readonly OutcomeDocumentExclusion[] | undefined,
  cited: readonly string[] | undefined,
  now: number,
): Task {
  if (!SELECTING_EFFECTS.has(task.effect || "answer") && !holdsSynthesis(task))
    return task;
  let next = task;
  for (const exclusion of exclusions || []) {
    const reason =
      typeof exclusion.reason === "string" ? exclusion.reason.trim() : "";
    if (!reason) continue;
    const papers = unique(
      exclusion.targets.flatMap((value) => {
        const paper = excludedPaper(next, String(value).trim());
        return paper &&
          !(next.doneTargets || []).includes(paper) &&
          !cited?.includes(paper)
          ? [paper]
          : [];
      }),
    );
    if (papers.length) next = withExcluded(next, papers, reason, now) || next;
  }
  return next;
}

function applyMaterial(
  checkpoint: ExecutionCheckpoint,
  evidence: Extract<OutcomeEvidence, { kind: "material" }>,
  now: number,
): EvidenceResult {
  const key = materialRefKey(evidence.materialRef);
  const bound = checkpoint.tasks.findIndex((task) =>
    task.materialRefs.some((reference) => materialRefKey(reference) === key),
  );
  // The same document again (identical content) binds nowhere new; only the
  // papers it now leaves out are recorded, on the part that holds it.
  if (bound >= 0)
    return mapTasks(checkpoint, now, (task, index) => {
      if (index !== bound) return undefined;
      const next = withDocumentExclusions(
        task,
        evidence.excluded,
        evidence.citedTargets,
        now,
      );
      return next === task ? undefined : next;
    });
  const chosen = artifactPartFor(checkpoint, {
    taskId: evidence.taskId,
    kind: evidence.documentKind,
  });
  if (!chosen) return exclusionsWithoutArtifact(checkpoint, evidence, now);
  const { documentId, documentVersion, contentHash } = evidence.materialRef;
  return mapTasks(checkpoint, now, (task, index) => {
    if (index !== chosen.index) return undefined;
    // What the document leaves out is recorded first, so the papers it
    // excludes are never "not covered".
    const selected = withDocumentExclusions(
      task,
      evidence.excluded,
      evidence.citedTargets,
      now,
    );
    // A revision re-covers its part from what it cites; with what it cites
    // unknown, it leaves the counts as they were.
    const next =
      chosen.revision && !evidence.citedTargets
        ? { ...selected, updatedAt: now }
        : coverTargets(selected, evidence.citedTargets, now);
    return {
      ...next,
      materialRefs: [
        ...task.materialRefs,
        { documentId, documentVersion, contentHash },
      ],
    };
  });
}

/**
 * Whether `task` can stand for a synthesis a document delivered without an
 * artifact part: a reasoning part, or a part that names no papers (the
 * model declared "write the review and save it as a note" as one write
 * part). A digest or read part covers the papers it names, so never.
 */
function holdsSynthesis(task: Task): boolean {
  const effect = task.effect || "answer";
  if (effect === "answer") return true;
  return (
    effect !== "digest" &&
    effect !== "read" &&
    !(task.targets || []).some(isPaperTarget)
  );
}

/**
 * The papers a document leaves out when no artifact part takes it: they are
 * recorded on the part it names when that part can stand for the synthesis
 * (`holdsSynthesis`), or, when it names none, on the one standing part in the
 * ledger that can. Nothing else of the document binds there.
 */
function exclusionsWithoutArtifact(
  checkpoint: ExecutionCheckpoint,
  evidence: Extract<OutcomeEvidence, { kind: "material" }>,
  now: number,
): EvidenceResult {
  if (!evidence.excluded?.length) return unchanged(checkpoint);
  let index = -1;
  if (evidence.taskId) {
    let taskId: string;
    try {
      taskId = ordinaryExecutionTaskId(checkpoint.executionId, evidence.taskId);
    } catch {
      return unchanged(checkpoint);
    }
    index = successorOf(
      checkpoint,
      checkpoint.tasks.findIndex((task) => task.taskId === taskId),
    );
  } else {
    const candidates = checkpoint.tasks.flatMap((task, at) =>
      task.origin === "model" && !task.supersededBy && holdsSynthesis(task)
        ? [at]
        : [],
    );
    if (candidates.length === 1) index = candidates[0];
  }
  return mapTasks(checkpoint, now, (task, at) => {
    if (at !== index || !holdsSynthesis(task)) return undefined;
    const next = withDocumentExclusions(
      task,
      evidence.excluded,
      evidence.citedTargets,
      now,
    );
    return next === task ? undefined : next;
  });
}

function applyDeclined(
  checkpoint: ExecutionCheckpoint,
  evidence: Extract<OutcomeEvidence, { kind: "declined" }>,
  now: number,
): EvidenceResult {
  const writes = evidence.proposals.filter(isWrite);
  const identity = `declined:${evidence.callId}`;
  if (!writes.length || isBound(checkpoint, identity)) {
    return unchanged(checkpoint);
  }
  const batch = declineBatch(checkpoint, evidence, writes, identity, now);
  if (batch) return batch;
  const chosen = checkpoint.tasks.findIndex(
    (task) =>
      DECLINE_CANDIDATE_STATUSES.has(task.status) &&
      writes.some((write) => acceptsWrite(task, write)),
  );
  if (chosen >= 0) {
    return mapTasks(checkpoint, now, (task, index) =>
      index === chosen
        ? {
            ...task,
            status: "blocked",
            reason: OUTCOME_REASONS.declined,
            receiptIds: union(task.receiptIds, [identity]),
            updatedAt: now,
          }
        : undefined,
    );
  }
  const [first] = writes;
  const targets = unique(writes.flatMap((write) => write.requestedTargets));
  return appended(
    checkpoint,
    {
      ...newTask(
        freeTaskId(checkpoint, (attempt) => `host-declined-${attempt}`),
        receiptOperationLabel(first),
        now,
      ),
      status: "blocked",
      effect: "mutation",
      origin: "host",
      capability: first.capability,
      operation: first.operation,
      ...(targets.length ? { targets } : {}),
      receiptIds: [identity],
      reason: OUTCOME_REASONS.declined,
    },
    now,
  );
}

/**
 * Papers the host gave up on after the same failure twice: a pending part
 * that names one and has not done it records the failure as its exception,
 * so the job goes on to the next paper; a part with every paper done or
 * given up on settles, as after any other exception.
 */
function applyFailure(
  checkpoint: ExecutionCheckpoint,
  failure: { targets: readonly string[]; reason: string },
  now: number,
): EvidenceResult {
  const reason = failure.reason.trim() || OUTCOME_REASONS.notApplied;
  return mapTasks(checkpoint, now, (task) => {
    if (
      task.origin !== "model" ||
      !MARKABLE_STATUSES.has(task.status) ||
      (task.effect !== "read" && task.effect !== "mutation")
    )
      return undefined;
    const targets = task.targets || [];
    const done = new Set(task.doneTargets || []);
    const excepted = new Set(
      (task.exceptions || []).flatMap((entry) => entry.targets),
    );
    const given = targets.filter(
      (target) =>
        !done.has(target) &&
        !excepted.has(target) &&
        resolveTarget(target, failure.targets) !== undefined,
    );
    if (!given.length) return undefined;
    const exceptions = withException(task.exceptions || [], given, reason);
    const next: Task = { ...task, exceptions, updatedAt: now };
    const accounted = new Set([
      ...done,
      ...exceptions.flatMap((entry) => entry.targets),
    ]);
    if (!targets.every((target) => accounted.has(target))) return next;
    return done.size
      ? completed(next)
      : { ...next, status: "skipped", reason: exceptions[0].reason };
  });
}

/**
 * Per-paper digests for the part the evidence names, as the module doc sets:
 * the papers it names grow its done papers, its failures become exceptions,
 * and it settles once every paper is one or the other. A settled part that
 * gets a paper done again is open for that retry: it is pending until every
 * paper is accounted for. Nothing moves for evidence it already holds.
 */
function applyDigest(
  checkpoint: ExecutionCheckpoint,
  evidence: Extract<OutcomeEvidence, { kind: "digest" }>,
  now: number,
): EvidenceResult {
  return mapTasks(checkpoint, now, (task) => {
    if (
      task.taskId !== evidence.taskId ||
      task.effect !== "digest" ||
      !DIGEST_CANDIDATE_STATUSES.has(task.status)
    )
      return undefined;
    const targets = task.targets || [];
    const doneTargets = union(
      task.doneTargets,
      unique(evidence.done).filter((target) => targets.includes(target)),
    );
    let exceptions = withoutDone(task.exceptions || [], doneTargets);
    for (const failure of evidence.failed) {
      if (
        !targets.includes(failure.target) ||
        doneTargets.includes(failure.target)
      )
        continue;
      exceptions = exceptTargets(
        exceptions,
        [failure.target],
        failure.reason.trim() || OUTCOME_REASONS.notApplied,
      );
    }
    if (
      doneTargets.length === (task.doneTargets?.length || 0) &&
      JSON.stringify(exceptions) === JSON.stringify(task.exceptions || [])
    )
      return undefined;
    const { exceptions: _previous, reason: _reason, ...rest } = task;
    const next: Task = {
      ...rest,
      status: "pending",
      ...(doneTargets.length ? { doneTargets } : {}),
      ...(exceptions.length ? { exceptions } : {}),
      updatedAt: now,
    };
    return settleTargets(next);
  });
}

function applyAnswer(
  checkpoint: ExecutionCheckpoint,
  evidence: Extract<OutcomeEvidence, { kind: "answer" }>,
  now: number,
): EvidenceResult {
  // Content written in the accepted answer is the artifact a part asked for.
  return mapTasks(checkpoint, now, (task) => {
    if (task.status !== "pending") return undefined;
    // A reasoning part completes whole, and a paper the answer cites is not
    // one it left out.
    if (!task.effect || task.effect === "answer")
      return {
        ...withoutCitedExclusions(task, evidence.citedTargets),
        status: "completed",
        updatedAt: now,
      };
    // The runtime passes the papers the answer cites; unknown (undefined)
    // completes the part whole.
    if (task.effect === "artifact")
      return coverTargets(task, evidence.citedTargets, now);
    return undefined;
  });
}

function hasEvidence(task: Task): boolean {
  return [
    task.journalActionIds,
    task.verifiedReceiptIds,
    task.readEvidenceIds,
    task.materialRefs,
    task.receiptIds || [],
    task.doneTargets || [],
    task.exceptions || [],
  ].some((entries) => entries.length > 0);
}

/**
 * Whether a part may change in place: the model declared it, it is pending,
 * and nothing the host bound is on it (no read, write, document, digested
 * paper or exception). The papers it excluded are a decision, not progress.
 */
export function redeclarable(task: Task): boolean {
  return (
    task.status === "pending" && task.origin !== "host" && !hasEvidence(task)
  );
}

/**
 * Whether a part may be replaced: the model declared it, it is pending, and
 * it is no write part that holds a receipt. Writes stay facts: further
 * writes are a part of their own.
 */
export function replaceable(task: Task): boolean {
  return (
    task.status === "pending" &&
    task.origin !== "host" &&
    !(
      task.effect === "mutation" &&
      ((task.receiptIds?.length || 0) > 0 || task.verifiedReceiptIds.length > 0)
    )
  );
}

/** The effect a part takes from its declaration. */
function declaredEffect(declaration: OutcomeDeclaration): OutcomeEffect {
  // A part that names a write capability is a write, whatever effect it
  // claims: models declare "save it as a note" as an artifact too.
  return declaration.capability &&
    isWrite({ capability: declaration.capability })
    ? "mutation"
    : declaration.effect;
}

/**
 * Whether `declaration` changes the existing part `prior`: another
 * description, effect, capability or set of papers. The same papers in
 * another order, or by the other id form, are the same part, and a part
 * over the scope declared again over the scope names the papers it froze,
 * whatever the scope holds now. A part that no longer changes in place (it
 * has progress, or is settled) keeps its papers, so a repeat that names only
 * some of them, or the scope, restates it and is no change; and a read
 * capability added to it is none either (`capabilityChanges`).
 */
export function declarationChanges(
  prior: Task,
  declaration: OutcomeDeclaration,
): boolean {
  const description =
    typeof declaration.description === "string"
      ? declaration.description.trim()
      : "";
  const targets = outcomeTargets(declaration.targets, declaration.capability);
  const held = new Set(prior.targets || []);
  const ownPapers = targets.every((target) => held.has(target));
  const samePapers =
    (prior.scope && declaration.scope) ||
    (targets.length === held.size && ownPapers) ||
    // A part that no longer changes in place keeps its papers: a repeat that
    // only names some of them, or the scope, restates the part.
    (!redeclarable(prior) && (declaration.scope || ownPapers));
  return (
    description !== prior.description ||
    declaredEffect(declaration) !== (prior.effect || "answer") ||
    capabilityChanges(prior, declaration.capability) ||
    !samePapers
  );
}

/**
 * Whether declaring `capability` for `prior` is a change. Any other
 * capability changes a part with no progress. On a part with progress only a
 * write capability does: a read capability cannot make the part a write, so
 * a repeat that adds one is still a repeat.
 */
export function capabilityChanges(
  prior: Task,
  capability: AgentActionCapability | undefined,
): boolean {
  if (capability === prior.capability) return false;
  return (
    redeclarable(prior) || (capability !== undefined && isWrite({ capability }))
  );
}

/** Effects whose parts deliver a synthesis from a selection of their papers. */
const SELECTING_EFFECTS: ReadonlySet<string> = new Set(["artifact", "answer"]);

/**
 * Add declared parts as pending model outcomes.
 *
 * A part declared again as it is changes nothing. One declared with a change
 * (`declarationChanges`) is rebuilt in place while it holds no progress
 * (`redeclarable`): its id, place and creation time stay, its targets are
 * frozen anew, and the papers it excluded stay while it still names them
 * and still takes exclusions. A part with progress, or settled, does not
 * change. A declaration that `replaces` a pending part adds the new part and
 * cancels the old one with the reason and `supersededBy` (the new part's
 * qualified id); the old part keeps what it did. A digest part keeps the
 * user's `question`: the declaration's, else the one it had.
 */
export function declareOutcomes(
  checkpoint: ExecutionCheckpoint,
  declarations: readonly OutcomeDeclaration[],
  now: number,
): ExecutionCheckpoint {
  const tasks = [...checkpoint.tasks];
  const indexById = new Map(tasks.map((task, index) => [task.taskId, index]));
  const declaredBefore = checkpoint.tasks.length;
  const seen = new Set<string>();
  let changed = false;
  for (const declaration of declarations) {
    const taskId = ordinaryExecutionTaskId(
      checkpoint.executionId,
      declaration.taskId,
    );
    if (seen.has(taskId)) {
      throw new Error(`Task ${taskId} may appear only once in one update`);
    }
    seen.add(taskId);
    const description =
      typeof declaration.description === "string"
        ? declaration.description.trim()
        : "";
    if (!description) {
      throw new Error(`New task ${taskId} requires a description`);
    }
    const index = indexById.get(taskId);
    const prior = index === undefined ? undefined : tasks[index];
    if (prior && declaration.replaces !== undefined) {
      throw new Error(
        `Task ${taskId} already exists; a part that replaces another needs a new taskId`,
      );
    }
    if (prior) {
      if (!declarationChanges(prior, declaration)) continue;
      if (!redeclarable(prior)) {
        throw new Error(
          `Existing task ${taskId} cannot change: it has progress or is settled`,
        );
      }
    }
    if (!OUTCOME_EFFECTS.has(declaration.effect)) {
      throw new Error(
        `New task ${taskId} requires an effect: read, artifact, mutation, answer, or digest`,
      );
    }
    const targets = outcomeTargets(declaration.targets, declaration.capability);
    const effect = declaredEffect(declaration);
    const question =
      effect === "digest"
        ? declaration.question?.trim() || prior?.question
        : undefined;
    // The papers it excluded, of those it still names.
    const excludedTargets =
      prior && SELECTING_EFFECTS.has(effect)
        ? (prior.excludedTargets || []).flatMap((entry) => {
            const left = entry.targets.filter((target) =>
              targets.includes(target),
            );
            return left.length ? [{ ...entry, targets: left }] : [];
          })
        : [];
    const task: Task = {
      ...newTask(taskId, description, now),
      ...(prior ? { createdAt: prior.createdAt } : {}),
      effect,
      origin: "model",
      ...(declaration.capability ? { capability: declaration.capability } : {}),
      ...(targets.length ? { targets } : {}),
      ...(declaration.scope && targets.length ? { scope: true as const } : {}),
      ...(question ? { question } : {}),
      ...(excludedTargets.length ? { excludedTargets } : {}),
    };
    if (declaration.replaces !== undefined) {
      const replaced = ordinaryExecutionTaskId(
        checkpoint.executionId,
        declaration.replaces,
      );
      const reason =
        typeof declaration.reason === "string" ? declaration.reason.trim() : "";
      if (!reason) {
        throw new Error(
          `Task ${taskId} replaces ${replaced} and needs the reason`,
        );
      }
      // Only a part the ledger held before this update is replaced.
      const at = indexById.get(replaced);
      if (at === undefined || at >= declaredBefore) {
        throw new Error(`Unknown task ${replaced}`);
      }
      if (!replaceable(tasks[at])) {
        throw new Error(
          `Task ${replaced} cannot be replaced: it is settled or holds writes`,
        );
      }
      tasks[at] = {
        ...tasks[at],
        status: "cancelled",
        reason,
        supersededBy: taskId,
        updatedAt: now,
      };
    }
    if (index === undefined) {
      indexById.set(taskId, tasks.length);
      tasks.push(task);
    } else {
      tasks[index] = task;
    }
    changed = true;
  }
  return changed ? { ...checkpoint, tasks, updatedAt: now } : checkpoint;
}

/** A paper as `item:<id>`, or undefined for a value that names no paper. */
function itemTarget(value: string): string | undefined {
  const [target] = outcomeTargets([value]);
  return target?.startsWith("item:") ? target : undefined;
}

/**
 * The paper `value` names as an exclusion on `task`: one of its targets, or,
 * on a part that names no papers, any paper (`item:<id>`). Undefined when it
 * names neither.
 */
function excludedPaper(task: Task, value: string): string | undefined {
  const targets = task.targets || [];
  // A part over a folder or tag (no paper among its targets) names its
  // papers only through that scope, so it takes any paper, as a part that
  // names none does.
  return targets.some(isPaperTarget)
    ? resolveTarget(value, targets)
    : itemTarget(value);
}

/** Whether a target names a paper (`item:<id>`), not a folder or a tag. */
function isPaperTarget(target: string): boolean {
  return target.startsWith("item:");
}

/**
 * `task` with `papers` left out for `reason`: a paper excluded already keeps
 * its first reason, and one the delivered content left uncited moves from
 * that exception to the exclusion; other exceptions stay. Undefined when
 * that changes nothing.
 */
function withExcluded(
  task: Task,
  papers: readonly string[],
  reason: string,
  now: number,
): Task | undefined {
  const excludedTargets = exceptTargets(
    task.excludedTargets || [],
    papers,
    reason,
  );
  const exceptions = (task.exceptions || []).flatMap((entry) => {
    if (entry.reason !== OUTCOME_REASONS.notCovered) return [entry];
    const left = entry.targets.filter((target) => !papers.includes(target));
    return left.length ? [{ ...entry, targets: left }] : [];
  });
  if (
    JSON.stringify(excludedTargets) ===
      JSON.stringify(task.excludedTargets || []) &&
    JSON.stringify(exceptions) === JSON.stringify(task.exceptions || [])
  )
    return undefined;
  const { exceptions: _previous, ...rest } = task;
  return {
    ...rest,
    excludedTargets,
    ...(exceptions.length ? { exceptions } : {}),
    updatedAt: now,
  };
}

/**
 * Record papers the model leaves out of an artifact or reasoning part, with
 * its reason, as `excludedTargets`. Only those parts deliver a synthesis
 * from a selection: a digest, read or write part covers every paper it
 * names, so an exclusion on one is refused, as is one on a settled part
 * other than a completed one, and one naming a paper that is not the part's
 * own or that it has done. A part that names no papers takes any paper
 * (`item:<id>`). A paper the delivered content left uncited moves
 * from that exception to the exclusion; other exceptions stay. A paper
 * excluded already keeps its first reason. Any refusal changes nothing, so
 * a call is applied whole or not at all.
 */
export function excludeOutcomeTargets(
  checkpoint: ExecutionCheckpoint,
  exclusions: readonly OutcomeExclusion[],
  now: number,
): { checkpoint: ExecutionCheckpoint; refused: OutcomeExclusionRefusal[] } {
  const indexById = new Map(
    checkpoint.tasks.map((task, index) => [task.taskId, index]),
  );
  const tasks = [...checkpoint.tasks];
  const refused: OutcomeExclusionRefusal[] = [];
  let changed = false;
  for (const exclusion of exclusions) {
    const taskId = ordinaryExecutionTaskId(
      checkpoint.executionId,
      exclusion.taskId,
    );
    const index = indexById.get(taskId);
    if (index === undefined) throw new Error(`Unknown task ${taskId}`);
    const reason =
      typeof exclusion.reason === "string" ? exclusion.reason.trim() : "";
    if (!reason) throw new Error(EXCLUSION_REASON_REQUIRED);
    const task = tasks[index];
    const effect = task.effect || "answer";
    if (!SELECTING_EFFECTS.has(effect)) {
      refused.push({ taskId, kind: "effect", effect });
      continue;
    }
    if (!EXCLUDABLE_STATUSES.has(task.status)) {
      refused.push({ taskId, kind: "status", status: task.status });
      continue;
    }
    const named = unique(
      exclusion.targets.map((value) => String(value).trim()).filter(Boolean),
    );
    // A part that names no papers takes any paper as an exclusion.
    const papers = named.map((value) => excludedPaper(task, value));
    const notTargets = named.filter((_, at) => papers[at] === undefined);
    const done = named.filter(
      (_, at) =>
        papers[at] !== undefined &&
        (task.doneTargets || []).includes(papers[at]!),
    );
    if (notTargets.length || done.length) {
      refused.push({ taskId, kind: "papers", notTargets, done });
      continue;
    }
    const next = withExcluded(task, unique(papers as string[]), reason, now);
    if (!next) continue;
    tasks[index] = next;
    changed = true;
  }
  if (refused.length || !changed) return { checkpoint, refused };
  return { checkpoint: { ...checkpoint, tasks, updatedAt: now }, refused };
}

/**
 * Whether `next` declares a read part over named papers that `previous` did
 * not have: such a part takes the reads its turn already made (a back-fill).
 */
export function declaresReadPart(
  previous: ExecutionCheckpoint,
  next: ExecutionCheckpoint,
): boolean {
  const known = new Set(previous.tasks.map((task) => task.taskId));
  return next.tasks.some(
    (task) =>
      !known.has(task.taskId) &&
      task.effect === "read" &&
      Boolean(task.targets?.length),
  );
}

/**
 * A skip reason claiming the part was delivered. Only host evidence says
 * that, so a part with none keeps open under such a skip.
 */
const DELIVERY_CLAIMS: readonly RegExp[] = [
  /\b(already|previously)\s+(been\s+)?(delivered|done|complete|completed|written|produced|submitted|provided|generated|created|saved|covered|answered)\b/i,
  /\b(delivered|covered|included|provided|written|addressed)\s+(above|below|in|within)\b/i,
  /\bsee\s+(the\s+)?(document|review|answer|above)\b/i,
];

/**
 * Parts whose delivery the host proves, which a skip cannot claim: content
 * (a document or the answer) and the host's own digests.
 */
const CONTENT_EFFECTS: ReadonlySet<string> = new Set([
  "artifact",
  "answer",
  "digest",
]);

/**
 * Apply skipped, blocked or cancelled marks. `ignored` lists marks on parts
 * that cannot take one; `refused` lists skips claiming a delivery the part
 * has no evidence of, with the claimed reason.
 */
export function markOutcomes(
  checkpoint: ExecutionCheckpoint,
  marks: readonly OutcomeModelMark[],
  now: number,
): {
  checkpoint: ExecutionCheckpoint;
  ignored: string[];
  refused: Array<{ taskId: string; reason: string }>;
} {
  const indexById = new Map(
    checkpoint.tasks.map((task, index) => [task.taskId, index]),
  );
  const tasks = [...checkpoint.tasks];
  const seen = new Set<string>();
  const ignored: string[] = [];
  const refused: Array<{ taskId: string; reason: string }> = [];
  let changed = false;
  for (const mark of marks) {
    const taskId = ordinaryExecutionTaskId(checkpoint.executionId, mark.taskId);
    if (seen.has(taskId)) {
      throw new Error(`Task ${taskId} may appear only once in one update`);
    }
    seen.add(taskId);
    const index = indexById.get(taskId);
    if (index === undefined) throw new Error(`Unknown task ${taskId}`);
    if (!MARK_STATUSES.has(mark.status)) {
      ignored.push(taskId);
      continue;
    }
    const reason = typeof mark.reason === "string" ? mark.reason.trim() : "";
    if (!reason) throw new Error(OUTCOME_REASONS.markReasonRequired);
    if (!MARKABLE_STATUSES.has(tasks[index].status)) {
      ignored.push(taskId);
      continue;
    }
    if (
      mark.status === "skipped" &&
      CONTENT_EFFECTS.has(tasks[index].effect || "") &&
      DELIVERY_CLAIMS.some((claim) => claim.test(reason)) &&
      !hasEvidence(tasks[index])
    ) {
      refused.push({ taskId, reason });
      continue;
    }
    tasks[index] = {
      ...tasks[index],
      status: mark.status,
      reason,
      updatedAt: now,
    };
    changed = true;
  }
  return {
    checkpoint: changed ? { ...checkpoint, tasks, updatedAt: now } : checkpoint,
    ignored,
    refused,
  };
}

/** Bind one piece of host evidence; applying it again changes nothing. */
export function applyOutcomeEvidence(
  checkpoint: ExecutionCheckpoint,
  evidence: OutcomeEvidence,
  now: number,
): EvidenceResult {
  switch (evidence.kind) {
    case "read":
      return applyRead(checkpoint, evidence, now);
    case "receipt":
      return applyReceipt(checkpoint, evidence.receipt, now);
    case "material":
      return applyMaterial(checkpoint, evidence, now);
    case "declined":
      return applyDeclined(checkpoint, evidence, now);
    case "answer":
      return applyAnswer(checkpoint, evidence, now);
    case "failed":
      return applyFailure(checkpoint, evidence, now);
    case "digest":
      return applyDigest(checkpoint, evidence, now);
  }
}

/**
 * Receipts read back from the change journal of the run a resumed ledger
 * comes from (`execution/journalReceipts.ts`), applied where the ledger lacks
 * them. A run that ended while a write was running, or a Zotero that quit
 * mid-batch, can leave a write in the journal that no receipt in the ledger
 * speaks for. A receipt is applied only when an open part names one of the
 * papers it proves and no part that takes it holds that paper done already:
 * a write the ledger knows, by whichever receipt, is never applied twice, and
 * a paper no open part asks for gets no part of its own.
 *
 * A note is counted rather than looked up, as it binds one part for notes a
 * paper: the ledger holds as many notes on a paper as it has parts for notes
 * with the paper done, and the journal names the run's notes in the order
 * they were written, so the notes on a paper past that many are the ones the
 * ledger lacks. Each goes to the next part that still owes the paper a note,
 * if one does.
 */
export function reconcileJournaledReceipts(
  checkpoint: ExecutionCheckpoint,
  receipts: readonly AgentActionReceipt[],
  now: number,
): EvidenceResult {
  let current = checkpoint;
  const notesHeld = (paper: string) =>
    checkpoint.tasks.filter(
      (task) =>
        task.effect === "mutation" &&
        task.capability === "zotero.notes" &&
        namesTarget(task.doneTargets, paper),
    ).length;
  const notesJournaled = new Map<string, number>();
  for (const receipt of receipts) {
    if (!isWrite(receipt)) continue;
    const proven = unique([
      ...receipt.appliedTargets,
      ...receipt.alreadySatisfiedTargets,
    ]);
    if (createsNotes(receipt)) {
      const lacked = proven.map((paper) => {
        const count = (notesJournaled.get(paper) || 0) + 1;
        notesJournaled.set(paper, count);
        return count > notesHeld(paper);
      });
      if (
        isBound(current, receipt.id) ||
        !lacked.every(Boolean) ||
        !proven.some((paper) =>
          current.tasks.some((task) => owesNote(task, paper)),
        )
      )
        continue;
      current = applyReceipt(current, receipt, now).checkpoint;
      continue;
    }
    if (isBound(current, receipt.id)) continue;
    const takes = (task: Task) => acceptsWrite(task, receipt);
    const held = current.tasks.some(
      (task) =>
        takes(task) &&
        (task.doneTargets || []).some(
          (target) => resolveTarget(target, proven) !== undefined,
        ),
    );
    const owed = current.tasks.some(
      (task) =>
        RECEIPT_CANDIDATE_STATUSES.has(task.status) &&
        Boolean(task.targets?.length) &&
        takes(task),
    );
    if (held || !owed) continue;
    current = applyReceipt(current, receipt, now).checkpoint;
  }
  return current === checkpoint
    ? unchanged(checkpoint)
    : { checkpoint: current, changed: true };
}

/**
 * The papers a note-creating write names that the job has already written
 * every note it asks for on: a declared part for notes holds each as done,
 * by its receipt, and no part still owes it a note (`owesNote`). Each note
 * binds one part (`notePapersByPart`), so a paper two parts ask a note of
 * takes two notes before a third is refused. Such a write would write the
 * paper twice, so the host does not run it (`toolExecution.ts`); the
 * receipts that ticked the papers stay the proof. `left` are the papers the
 * same write names that are still owed; null when none is written already.
 *
 * A part holds one done flag a paper, so a single part that asks for two
 * notes on each paper cannot count the second; the host's answer asks the
 * model to declare that note as a part of its own, which then owes it. The
 * guard does not tell two notes apart by their text: a note written again
 * in other words, as a model that starts its page over writes it, is the
 * same note twice.
 *
 * Only note creation is held to this: setting a folder, a tag or a field
 * again changes nothing ("already satisfied"), and a second, different one
 * on the same paper is a change of its own.
 */
export function papersAlreadyWritten(
  checkpoint: ExecutionCheckpoint | undefined,
  proposals: readonly Pick<
    AgentActionProposal,
    "capability" | "operation" | "requestedTargets"
  >[],
): { written: string[]; left: string[]; parts: string[] } | null {
  const targets = unique(
    proposals
      .filter(createsNotes)
      .flatMap((proposal) =>
        proposal.requestedTargets.filter((target) =>
          target.startsWith("item:"),
        ),
      ),
  );
  const noteParts = (checkpoint?.tasks || []).filter(
    (task) =>
      task.origin === "model" &&
      task.effect === "mutation" &&
      (!task.capability || task.capability === "zotero.notes") &&
      Boolean(task.targets?.length),
  );
  if (!targets.length || !noteParts.length) return null;
  const written: string[] = [];
  const parts = new Set<string>();
  for (const target of targets) {
    const holders = noteParts.filter(
      (task) =>
        task.capability === "zotero.notes" &&
        namesTarget(task.targets, target) &&
        namesTarget(task.doneTargets, target),
    );
    const owed = noteParts.some((task) => owesNote(task, target));
    if (!holders.length || owed) continue;
    written.push(target);
    for (const task of holders) parts.add(task.description);
  }
  if (!written.length) return null;
  return {
    written,
    left: targets.filter((target) => !written.includes(target)),
    parts: [...parts],
  };
}

/**
 * Whether "continue" picks a settled ledger back up: one its run left
 * interrupted, or one the user stopped while a declared part was still
 * open. Stop is the outer bound of a long job, not its end, so the job goes
 * on from its first paper not yet settled.
 */
export function resumesOnContinue(checkpoint: ExecutionCheckpoint): boolean {
  const state = checkpoint.end?.state;
  return (
    state === "interrupted" ||
    (state === "cancelled" && openDeclaredOutcomes(checkpoint).length > 0)
  );
}

/** The model's declared outcomes that still need work beyond the answer. */
export function openDeclaredOutcomes(
  checkpoint: ExecutionCheckpoint | undefined,
): ExecutionCheckpointTask[] {
  return (checkpoint?.tasks || []).filter(
    (task) =>
      task.origin === "model" &&
      task.effect !== undefined &&
      task.effect !== "answer" &&
      task.status === "pending",
  );
}

/**
 * Outcome progress as a string that moves only with evidence, a mark or an
 * exclusion.
 */
export function outcomeProgressSignature(
  checkpoint: ExecutionCheckpoint | undefined,
): string {
  const count = (entries: readonly OutcomeException[] | undefined) =>
    (entries || []).reduce((sum, entry) => sum + entry.targets.length, 0);
  return JSON.stringify(
    (checkpoint?.tasks || []).map((task) => [
      task.taskId,
      task.status,
      task.doneTargets?.length || 0,
      count(task.exceptions),
      task.verifiedReceiptIds.length,
      task.readEvidenceIds.length,
      task.materialRefs.length,
      count(task.excludedTargets),
    ]),
  );
}

/**
 * The honest end state from the run status, stop rule and ledger. A part
 * the model replaced answers to the part that replaced it: its cancellation
 * neither leaves the run partly done nor blocks it, and only the work it
 * did still counts as the run's progress.
 */
export function decideRunEnd(
  checkpoint: ExecutionCheckpoint | undefined,
  run: { status: "completed" | "failed" | "cancelled"; stopRule: RunStopRule },
): RunEndState {
  const tasks = checkpoint?.tasks || [];
  const standing = tasks.filter((task) => !task.supersededBy);
  if (run.status === "cancelled") return "cancelled";
  if (standing.some((task) => task.status === "blocked")) return "blocked";
  if (run.status === "failed") {
    return INTERRUPTING_STOP_RULES.has(run.stopRule) && tasks.some(hasEvidence)
      ? "interrupted"
      : "failed";
  }
  return standing.some(
    (task) => task.status !== "completed" || task.exceptions?.length,
  )
    ? "completed_with_exceptions"
    : "completed";
}

/** Record the end state; with exceptions, pending outcomes become skipped. */
export function settleOutcomes(
  checkpoint: ExecutionCheckpoint,
  end: RunEndState,
  now: number,
): ExecutionCheckpoint {
  const tasks =
    end === "completed_with_exceptions"
      ? checkpoint.tasks.map(
          (task): Task =>
            task.status === "pending"
              ? {
                  ...task,
                  status: "skipped",
                  reason: task.reason || OUTCOME_REASONS.notDone,
                  updatedAt: now,
                }
              : task,
        )
      : checkpoint.tasks;
  return { ...checkpoint, tasks, end: { state: end }, updatedAt: now };
}

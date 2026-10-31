/**
 * Checkpointed bulk edits: the rules that decide which call runs as one
 * durable step per item, and what a stopped one still owes.
 *
 * A call over more than `CHECKPOINT_THRESHOLD` items is split into per-item
 * operations, and that list is frozen with its journal action before the
 * first write. Each item is then its own journal step, recorded after it
 * runs, so "what is left" is the frozen list minus the steps already done:
 * a resume repeats no verified item and needs nothing from the model.
 */
import type {
  LibraryMutationOperation,
  LibraryMutationState,
} from "./libraryMutation/contracts";
import { canonicalJson } from "./libraryMutation/canonicalJson";
import {
  atomizeMutationOperationFromHandler,
  isRegisteredLibraryMutationOperation,
  mutationPostconditionIsSatisfied,
  targetItemIdsForLibraryMutation,
} from "./libraryMutation/handlerOperations";
import {
  listJournalActions,
  readFrozenJournalActionOperations,
  type JournalStatus,
  type JournalStep,
} from "../store/changeJournal";

/** At more items than this, one edit runs as per-item checkpointed steps. */
export const CHECKPOINT_THRESHOLD = 50;

/**
 * The item edits `library_update` performs, which is where a stopped batch
 * is continued. Each splits into independent one-item operations that set a
 * state, so running one again after an interruption is safe.
 */
export const CHECKPOINTED_OPERATION_TYPES: ReadonlySet<
  LibraryMutationOperation["type"]
> = new Set([
  "apply_tags",
  "remove_tags",
  "set_item_tags",
  "update_metadata",
  "move_to_collection",
  "remove_from_collection",
  "reparent_items",
]);

/** Step states whose item needs no further write. */
const DONE_STEP_STATUSES: ReadonlySet<JournalStatus> = new Set([
  "applied",
  "irreversible",
  "no_effect",
]);

/**
 * Done steps that wrote something. Their recorded post-image must still show
 * the change: an item Zotero stored differently from what was asked (it
 * normalized the value) is not done, even though its write was journalled.
 */
const WRITTEN_STEP_STATUSES: ReadonlySet<JournalStatus> = new Set([
  "applied",
  "irreversible",
]);

/** One per-item operation, and the call's operation it was split from. */
export type CheckpointPart = {
  source: number;
  operation: LibraryMutationOperation;
};

/**
 * The per-item parts of a call that must be checkpointed, or null when the
 * call runs as it always has: at most `CHECKPOINT_THRESHOLD` items, an
 * operation outside the checkpointed edits, or one that cannot be split
 * into one-item parts.
 *
 * A call that mixes checkpointed and other operations is not checkpointed:
 * it runs as one ordinary action, with no per-item steps and no resume.
 */
export function checkpointedParts(
  operations: readonly LibraryMutationOperation[],
): CheckpointPart[] | null {
  if (
    !operations.length ||
    !operations.every((operation) =>
      CHECKPOINTED_OPERATION_TYPES.has(operation.type),
    )
  )
    return null;
  const targets = new Set(operations.flatMap(targetItemIdsForLibraryMutation));
  if (targets.size <= CHECKPOINT_THRESHOLD) return null;
  const parts = operations.flatMap((operation, source) =>
    atomizeMutationOperationFromHandler(operation).map((part) => ({
      source,
      operation: part,
    })),
  );
  return parts.every(
    (part) => targetItemIdsForLibraryMutation(part.operation).length === 1,
  )
    ? parts
    : null;
}

/**
 * The frozen operations no done step accounts for, in their frozen order.
 *
 * Each done step accounts for one frozen operation equal to its forward
 * payload, so an item listed twice is owed twice.
 */
export function remainingOperations(
  frozen: readonly LibraryMutationOperation[],
  steps: readonly (Pick<JournalStep, "status" | "forwardJson"> & {
    expectedPostconditionJson?: string;
  })[],
): LibraryMutationOperation[] {
  const done = new Map<string, number>();
  for (const step of steps) {
    if (!DONE_STEP_STATUSES.has(step.status)) continue;
    let forward: unknown;
    try {
      forward = JSON.parse(step.forwardJson);
    } catch {
      continue;
    }
    if (!stepShowsItsChange(step, forward)) continue;
    const key = canonicalJson(forward);
    done.set(key, (done.get(key) || 0) + 1);
  }
  return frozen.filter((operation) => {
    const key = canonicalJson(operation);
    const count = done.get(key) || 0;
    if (!count) return true;
    done.set(key, count - 1);
    return false;
  });
}

/**
 * Whether a step that wrote something recorded a post-image showing it. A
 * step without a readable post-image, as startup leaves some, stands.
 */
function stepShowsItsChange(
  step: { status: JournalStatus; expectedPostconditionJson?: string },
  forward: unknown,
): boolean {
  if (
    !WRITTEN_STEP_STATUSES.has(step.status) ||
    !step.expectedPostconditionJson ||
    !isRegisteredLibraryMutationOperation(forward)
  )
    return true;
  try {
    const post = JSON.parse(step.expectedPostconditionJson);
    return post && typeof post === "object"
      ? mutationPostconditionIsSatisfied(forward, post)
      : true;
  } catch {
    return true;
  }
}

export type CheckpointedBatch = {
  actionId: string;
  status: JournalStatus;
  /** Every per-item operation of the batch, as frozen before it ran. */
  frozen: LibraryMutationOperation[];
  /** The ones still owed. */
  remaining: LibraryMutationOperation[];
};

/**
 * The checkpointed batch with this id, read from the journal.
 *
 * Refuses every action that is not one: an action journalled before batches
 * froze their operations has no list to continue from, and guessing it from
 * the steps would re-run items the user never asked for again.
 */
export async function readCheckpointedBatch(params: {
  actionId: string;
  conversationKey: number;
}): Promise<CheckpointedBatch> {
  const [action] = await listJournalActions({
    actionId: params.actionId,
    limit: 1,
  });
  if (!action || action.conversationKey !== params.conversationKey)
    throw new Error(
      `Batch ${params.actionId} was not found in this conversation.`,
    );
  const frozen = await readFrozenJournalActionOperations(action.actionId);
  if (!frozen)
    throw new Error(
      `${params.actionId} is not a checkpointed batch, so it cannot be continued. Make the remaining changes with a new library_update call.`,
    );
  if (!frozen.every(isRegisteredLibraryMutationOperation))
    throw new Error(
      `Batch ${params.actionId} holds an operation this version cannot run, so it cannot be continued.`,
    );
  if (
    action.status === "reverted" ||
    action.status === "reverting" ||
    action.status === "revert_failed"
  )
    throw new Error(
      `Batch ${params.actionId} was undone, so it cannot be continued.`,
    );
  return {
    actionId: action.actionId,
    status: action.status,
    frozen,
    remaining: remainingOperations(frozen, action.steps),
  };
}

/** Several per-item states as one, for the whole operation they came from. */
export function mergeMutationStates(
  operation: LibraryMutationOperation["type"],
  states: readonly LibraryMutationState[],
): LibraryMutationState {
  const sections: Record<string, unknown[]> = {};
  for (const state of states) {
    for (const section of [
      "items",
      "collections",
      "savedSearches",
      "libraryTags",
      "relations",
    ] as const) {
      const rows = state[section];
      if (rows?.length)
        sections[section] = [...(sections[section] || []), ...rows];
    }
  }
  return { ...sections, version: 1, operation } as LibraryMutationState;
}

/** What a checkpointed call did, and what its batch still owes. */
export type CheckpointedBatchReport = {
  /** The batch's id: its journal action, which `resumeBatchId` names. */
  batchId: string;
  /** Per-item changes in the whole batch. */
  total: number;
  /** Items done so far, by this call and earlier ones. */
  done: number;
  /** Items this call changed. */
  changed: number;
  /** Items this call tried and could not change, each with why. */
  failed: Array<{ itemIds: number[]; error: string }>;
  /** Items this call never started, because the user stopped it. */
  notStarted: number;
  stopped: boolean;
  /**
   * Whether `resumeBatchId` can continue it: something remains and the batch
   * has changed at least one item. A batch that changed nothing has no undo
   * to keep together, so the call is simply sent again.
   */
  resumable: boolean;
  /**
   * A resume that tried items and finished none: they failed again, so
   * resuming again would only repeat the failure.
   */
  stalled?: boolean;
};

/** The result text: what was done, what failed, and what remains. */
export function describeCheckpointedBatch(
  report: CheckpointedBatchReport,
): string {
  const remaining = report.total - report.done;
  const plural = (count: number) => (count === 1 ? "" : "s");
  const sentences = [
    `Changed ${report.changed} item${plural(report.changed)}; ${report.done} of ${report.total} done.`,
  ];
  if (report.stopped)
    sentences.push(
      `Stopped by the user; ${report.notStarted} item${plural(report.notStarted)} not started.`,
    );
  for (const failure of report.failed)
    sentences.push(
      `${report.stalled ? "Failed again" : "Failed"}: item ${failure.itemIds.join(", ")}: ${failure.error.replace(/[.\s]*$/, "")}.`,
    );
  sentences.push(
    !remaining
      ? "Nothing remains."
      : report.stalled
        ? `${remaining} remain. This call finished no item, so the batch cannot be continued with resumeBatchId. Fix the cause, then make the changes with a new library_update call.`
        : report.resumable
          ? `${remaining} remain. To continue, call library_update with kind and resumeBatchId only: resumeBatchId:'${report.batchId}'. Done items are skipped.`
          : `${remaining} remain. No item was changed, so send the same call again.`,
  );
  return sentences.join(" ");
}

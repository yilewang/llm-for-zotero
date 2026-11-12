import {
  createFinalizedZoteroNote,
  readCreatedNoteReceipt,
  verifyNativeNoteHtml,
  type FinalizedNoteBuildContext,
  type FinalizedNoteBuildResult,
} from "../../services/notePersistence";
import { canonicalNoteHtml, noteHtmlMatches } from "../../utils/noteHtml";
import {
  executeExternalMutation,
  MutationNoEffectError,
} from "./externalMutationCoordinator";
import {
  inJournalTransaction,
  isAgentChangeJournalAvailable,
  listJournalActions,
  listJournalSteps,
  updateJournalStep,
  type JournalActionWithSteps,
  type JournalStep,
} from "../store/changeJournal";
import { listConversationBatchJobs } from "../store/batchJobStore";
import { listBatchItems } from "../store/batchItemStore";
import {
  readRecoveryText,
  sha256Text,
  storeRecoveryText,
  type RecoveryPayload,
} from "../store/journalRecoveryBlobStore";
import type { AgentToolContext } from "../types";

type Creation = {
  context: AgentToolContext;
  /**
   * Durable identity of this intended note creation.
   *
   * A retry reuses it. A separate user request receives a different identity
   * even when its finalized content is byte-for-byte equal.
   */
  logicalActionId?: string;
  libraryID: number;
  parentItemId?: number;
  collections?: number[];
  /**
   * The note batch row this creation writes, when a save_notes_batch action
   * runs it. Recorded in the step so a resume can tell, after a crash, which
   * row the reserved note belongs to without rebuilding its body.
   */
  batchItem?: BatchItemRef;
  html: string;
  finalize?: (
    context: FinalizedNoteBuildContext,
  ) => Promise<string | FinalizedNoteBuildResult>;
};
const pending = new Map<string, Promise<unknown>>();

/** A row of a durable note batch: its batch and its item key. */
export type BatchItemRef = { batchId: string; itemKey: string };

/**
 * Why a batch row is refused when a note an earlier attempt reserved for it
 * is held by an action the current attempt cannot settle, and nothing is at
 * the reserved key to name.
 */
export const UNACCOUNTED_NOTE_REASON =
  "The state of the note an earlier attempt began for this item is unknown, so it was not rewritten";

/**
 * What native Zotero holds at the key a create_note step reserved: nothing,
 * a note in the trash, a note the user moved (to another parent, or out of
 * a collection the step filed it into), or a live note where the step put
 * it. An item at the key that is not a note reads as moved. Whether a live
 * note's content is the intended one is for the caller.
 */
export type ReservedNoteState =
  | { state: "absent"; note: null }
  | { state: "live" | "trashed" | "moved"; note: Zotero.Item };

// The one reader of these native states; `readReservedNote` and every
// refusal wording go through it.
export function reservedNoteState(
  forward: CreateNoteForward,
): ReservedNoteState {
  const note = noteAtReservedKey(forward);
  if (!note) return { state: "absent", note: null };
  if (note.deleted) return { state: "trashed", note };
  const parentItemId =
    typeof forward.parentItemId === "number" ? forward.parentItemId : undefined;
  const collections = Array.isArray(forward.collections)
    ? forward.collections.map(Number)
    : [];
  const filedInto = note.isNote() ? note.getCollections() : [];
  if (
    !note.isNote() ||
    (note.parentID || undefined) !== parentItemId ||
    collections.some((id) => !filedInto.includes(id))
  )
    return { state: "moved", note };
  return { state: "live", note };
}

/**
 * Why a batch row is refused when the note an earlier attempt reserved for
 * it is held back, in one wording per native state of that note. The
 * resume's preparation, the executor's write-time refusal and the settler
 * all refuse through it, so one note reads the same on every path.
 */
export function heldNoteReason(forward: CreateNoteForward): string {
  const found = reservedNoteState(forward);
  switch (found.state) {
    case "absent":
      return UNACCOUNTED_NOTE_REASON;
    case "trashed":
      return `A note from the interrupted attempt (note ${found.note.id}) is in the trash; this item was not rewritten.`;
    case "moved":
      return `Note ${found.note.id} was moved, so I did not touch it.`;
    case "live":
      return `A note from the interrupted attempt (note ${found.note.id}) is still in the library; this item was not rewritten.`;
  }
}

/**
 * Why a batch row is refused when an older step's note could be this row's
 * but cannot be tied to one row. Moving the note to the trash does not end
 * the refusal; erasing it does, so the reason says so.
 */
export function untiedNoteReason(note: Zotero.Item): string {
  return `Note ${note.id} from the interrupted attempt may be this item's note; I cannot tell which item it belongs to, so I did not write this item. If note ${note.id} is not this item's note, delete it permanently and continue.`;
}

/** The note at the key a create_note step reserved, if any is there. */
export function noteAtReservedKey(
  forward: CreateNoteForward,
): Zotero.Item | null {
  if (typeof forward.key !== "string") return null;
  const found = Zotero.Items.getByLibraryAndKey(
    Number(forward.libraryID),
    forward.key,
  );
  return found && found.id ? (found as Zotero.Item) : null;
}

/** The forward payload a create_note step reserved. */
export type CreateNoteForward = {
  key?: unknown;
  libraryID?: unknown;
  parentItemId?: unknown;
  collections?: unknown;
  html?: unknown;
  batchItem?: unknown;
};

function sameCollections(left: unknown, right: readonly number[]): boolean {
  const ids = Array.isArray(left) ? left.map(Number) : [];
  return ids.length === right.length && ids.every((id) => right.includes(id));
}

/** The row of a durable note batch a step is matched against. */
type BatchRowRef = {
  batchId: string;
  itemKey: string;
  targetItemId: number;
  standalone: boolean;
  collections?: readonly number[];
};

function parseForward(step: JournalStep): CreateNoteForward | undefined {
  try {
    const forward = JSON.parse(step.forwardJson) as CreateNoteForward;
    return forward && typeof forward.key === "string" ? forward : undefined;
  } catch {
    return undefined;
  }
}

function isOpenNoteStep(step: JournalStep): boolean {
  return step.operation === "create_note" && step.status === "uncertain";
}

/** Whether a step's forward records the batch row it writes. */
function recordsRow(forward: CreateNoteForward): boolean {
  return Boolean(forward.batchItem && typeof forward.batchItem === "object");
}

/**
 * Whether an older step, which does not record its row, has the shape of
 * this row's note: a child note on the same paper, or a parentless note
 * filed into the same collections.
 */
function fitsRow(forward: CreateNoteForward, row: BatchRowRef): boolean {
  if (!row.standalone) return forward.parentItemId === row.targetItemId;
  return (
    (forward.parentItemId === undefined || forward.parentItemId === null) &&
    sameCollections(forward.collections, row.collections || [])
  );
}

/**
 * The first `uncertain` create_note step among `steps` that reserved the note
 * of this batch row, with its forward payload.
 *
 * A step that records its row (`batchItem`) matches on that alone, so the
 * match does not depend on the parent, the collections or the body. A step
 * written before steps recorded their row matches only when it has the
 * row's shape (its parent, or no parent and the row's collections) and its
 * reserved body equals the row's body rebuilt by `rebuiltHtml`. The parent
 * alone is not enough: a batch can write two notes on one paper, and the
 * step of the second would otherwise be taken as the first's. The body is
 * rebuilt from current metadata, so an older step can fail to match after a
 * cited work changed; with no `rebuiltHtml`, no older step matches. An older
 * step that matches no row is for `findUnattributedNoteStep`.
 *
 * Shared by the resume's preparation, the executor's write-time refusal and
 * the settler, so the three cannot disagree on which step is whose.
 */
export async function findUncertainNoteStepForRow(
  steps: readonly JournalStep[],
  row: BatchRowRef & {
    rebuiltHtml?: () => Promise<string | undefined>;
  },
): Promise<{ step: JournalStep; forward: CreateNoteForward } | undefined> {
  let rebuilt: Promise<string | undefined> | undefined;
  for (const step of steps) {
    if (!isOpenNoteStep(step)) continue;
    const forward = parseForward(step);
    if (!forward) continue;
    if (recordsRow(forward)) {
      const recorded = forward.batchItem as Partial<BatchItemRef>;
      if (recorded.batchId === row.batchId && recorded.itemKey === row.itemKey)
        return { step, forward };
      continue;
    }
    if (!fitsRow(forward, row)) continue;
    if (!row.rebuiltHtml) continue;
    rebuilt ||= row.rebuiltHtml().catch(() => undefined);
    const current = await rebuilt;
    if (current === undefined) continue;
    let intended: string;
    try {
      intended = await readRecoveryText(forward.html as RecoveryPayload);
    } catch {
      continue;
    }
    if (noteHtmlMatches(intended, current)) return { step, forward };
  }
  return undefined;
}

/**
 * An `uncertain` create_note step among `steps` that could hold this row's
 * note but cannot be tied to it: a step written before steps recorded their
 * row, with the row's shape (see `findUncertainNoteStepForRow`), whose body
 * matches no row, and with a note at its reserved key.
 *
 * Such a note is some unwritten row's, and nothing says which, so writing
 * any row it could be would put a second note beside it. Callers refuse
 * those rows instead. A step with nothing at its key had no effect and
 * holds nothing back.
 */
export function findUnattributedNoteStep(
  steps: readonly JournalStep[],
  row: BatchRowRef,
):
  | { step: JournalStep; forward: CreateNoteForward; note: Zotero.Item }
  | undefined {
  for (const step of steps) {
    if (!isOpenNoteStep(step)) continue;
    const forward = parseForward(step);
    if (!forward || recordsRow(forward) || !fitsRow(forward, row)) continue;
    const note = noteAtReservedKey(forward);
    if (note) return { step, forward, note };
  }
  return undefined;
}

/**
 * The `uncertain` create_note steps among `steps` written before steps
 * recorded their row, with nothing at their reserved key: the creation
 * never landed, or its note was erased since, so the step had no effect.
 */
export function oldNoteStepsWithNothingAtKey(
  steps: readonly JournalStep[],
): JournalStep[] {
  return steps.filter((step) => {
    if (!isOpenNoteStep(step)) return false;
    const forward = parseForward(step);
    return Boolean(
      forward && !recordsRow(forward) && !noteAtReservedKey(forward),
    );
  });
}

/**
 * Note-batch actions of this conversation that may hold the note an
 * interrupted attempt of this batch was writing, although no row names them.
 *
 * Before rows named their action while a note was in flight, a row named
 * its action only once its note landed. So a batch that ended during its
 * first note, or a continue that ran under a new action (the first one was
 * undone) and ended during its first note, left that note's step in an
 * action no row of the batch names. Each note_write_batch action created at
 * or after the batch, holding an `uncertain` create_note step that does not
 * record its row, is such a candidate, unless a row of another note batch
 * in this conversation names it (then it is that batch's).
 *
 * A step with nothing at its key holds no note (its creation never landed,
 * or its note was erased), and no live run can hold a pre-upgrade action, so
 * such a step is left out; refusing a row for it would never end.
 *
 * Callers only refuse rows through these actions (`findNoteHeldForRow`);
 * they never reopen or settle them.
 */
export async function listUnnamedNoteBatchActions(params: {
  batchId: string;
  conversationKey: number;
  /** When the batch was created. */
  createdAt: number;
  /** Actions the caller settles or reads already. */
  exclude: ReadonlyArray<string | undefined>;
}): Promise<JournalActionWithSteps[]> {
  const candidates = (
    await listJournalActions({
      conversationKey: params.conversationKey,
      toolName: "note_write_batch",
      createdAtOrAfter: params.createdAt,
      withUncertainStep: "create_note",
      unbounded: true,
    })
  ).filter(
    (action) =>
      !params.exclude.includes(action.actionId) &&
      action.steps.some((step) => {
        if (!isOpenNoteStep(step)) return false;
        const forward = parseForward(step);
        return Boolean(
          forward && !recordsRow(forward) && noteAtReservedKey(forward),
        );
      }),
  );
  if (!candidates.length) return [];
  const namedElsewhere = new Set<string>();
  for (const job of await listConversationBatchJobs(
    params.conversationKey,
    "note_write_batch",
  )) {
    if (job.jobId === params.batchId) continue;
    for (const row of await listBatchItems(job.jobId))
      if (row.actionId) namedElsewhere.add(row.actionId);
  }
  const unlanded = new Set(
    oldNoteStepsWithNothingAtKey(candidates.flatMap((action) => action.steps)),
  );
  return candidates
    .filter((action) => !namedElsewhere.has(action.actionId))
    .map((action) => ({
      ...action,
      steps: action.steps.filter((step) => !unlanded.has(step)),
    }));
}

/**
 * The note an action the current attempt does not settle holds for this
 * row, with the reason the row is refused; undefined when it holds none.
 *
 * The step the row itself names (`actionId` and `stepSequence`, set when a
 * resume refused the row) counts while it is uncertain, then a step matched
 * to the row, then an older step that could be the row's. Shared by the
 * resume's preparation and the executor's write-time refusal, so the two
 * refuse the same rows for the same reason.
 *
 * A step with nothing at its key holds nothing back. An `uncertain` step is
 * never one a live run is writing (that one is `applying`), so an empty key
 * means its creation had no effect; refusing the row for it would never
 * end. The step itself is left for the action that holds it to settle.
 */
export async function findNoteHeldForRow(
  allSteps: readonly JournalStep[],
  row: BatchRowRef & {
    actionId?: string | null;
    stepSequence?: number | null;
    rebuiltHtml?: () => Promise<string | undefined>;
  },
): Promise<{ step: JournalStep; reason: string } | undefined> {
  const steps = allSteps.filter((step) => {
    if (!isOpenNoteStep(step)) return true;
    const forward = parseForward(step);
    return !forward || Boolean(noteAtReservedKey(forward));
  });
  const named =
    row.actionId && row.stepSequence != null
      ? steps.find(
          (step) =>
            step.actionId === row.actionId &&
            step.sequence === row.stepSequence &&
            isOpenNoteStep(step),
        )
      : undefined;
  if (named) {
    const forward = parseForward(named);
    return {
      step: named,
      reason: forward ? heldNoteReason(forward) : UNACCOUNTED_NOTE_REASON,
    };
  }
  const matched = await findUncertainNoteStepForRow(steps, row);
  if (matched)
    return {
      step: matched.step,
      reason: heldNoteReason(matched.forward),
    };
  const unattributed = findUnattributedNoteStep(steps, row);
  return unattributed
    ? {
        step: unattributed.step,
        // A child row's held note sits on its own paper, so it is almost
        // surely this item's; only a standalone note cannot be tied to a row.
        reason: row.standalone
          ? untiedNoteReason(unattributed.note)
          : heldNoteReason(unattributed.forward),
      }
    : undefined;
}

/** Step states in which a create_note step's note landed. */
const LANDED_NOTE_STEP_STATUSES: ReadonlySet<string> = new Set([
  "applied",
  "partially_applied",
  "irreversible",
  // An undo moved the note to the trash; it was still written.
  "reverted",
]);

/** Whether a step's forward records exactly this batch row. */
function namesRow(forward: CreateNoteForward, row: BatchItemRef): boolean {
  if (!recordsRow(forward)) return false;
  const recorded = forward.batchItem as Partial<BatchItemRef>;
  return recorded.batchId === row.batchId && recorded.itemKey === row.itemKey;
}

/**
 * A create_note step among `steps` whose note landed for this batch row,
 * with what is at its key now: the row's note was written, whatever its
 * row says.
 *
 * The step is recorded applied before the row is saved, so a process that
 * ends in between leaves an applied step beside a pending row. Writing the
 * row again would put a second note beside the first. Any note at the key
 * counts, also one the user (or an undo) trashed or moved: a trashed note
 * still counts as written, as for a saved row. A step with nothing at its
 * key does not count: the user erased the note, and the row is written
 * again, as a saved row whose note is gone is.
 */
export function findLandedNoteStepForRow(
  steps: readonly JournalStep[],
  row: BatchItemRef,
):
  | {
      step: JournalStep;
      forward: CreateNoteForward;
      found: Exclude<ReservedNoteState, { state: "absent" }>;
    }
  | undefined {
  for (const step of steps) {
    if (
      step.operation !== "create_note" ||
      !LANDED_NOTE_STEP_STATUSES.has(step.status)
    )
      continue;
    const forward = parseForward(step);
    if (!forward || !namesRow(forward, row)) continue;
    const found = reservedNoteState(forward);
    if (found.state !== "absent") return { step, forward, found };
  }
  return undefined;
}

/** What a related batch holds for a paper this batch is about to write. */
export type RelatedBatchNote =
  | {
      /** An attempt of that batch is still open on a note at its key. */
      kind: "held";
      batchId: string;
      step: JournalStep;
      reason: string;
    }
  | {
      /** That batch wrote the paper's note, and it is live where it was put. */
      kind: "landed";
      batchId: string;
      step: JournalStep;
      note: Zotero.Item;
    };

/**
 * The note a related batch (a retry of this batch, or the batch it
 * retried) holds for this row's paper, read from that batch's own steps.
 *
 * Saved rows of a related batch are read elsewhere (`heldNote` in the
 * tool). This reads what the rows do not say yet: a note in flight when a
 * process ended (`uncertain`, with a note at its key), and a note that
 * landed before its row was saved. Rows of different batches over the same
 * paper share the item key (`item:<paperId>`), so a step that names
 * {that batch, this item key} is that batch's note for the same paper.
 *
 * Steps are looked up in the actions that batch's row for the item names,
 * and in the newest action of that batch. A landed note counts only while
 * it is live where it was put, as a saved row of a related batch does; an
 * open step counts while anything is at its key. Nothing at the key holds
 * nothing back. The other batch's step is only read here: only the action
 * that holds it settles it.
 */
export async function findRelatedBatchNote(
  batches: ReadonlyArray<{
    batchId: string;
    rows: ReadonlyArray<{
      itemKey: string;
      actionId?: string;
      updatedAt: number;
    }>;
  }>,
  itemKey: string,
  stepsOf: (actionId: string) => Promise<readonly JournalStep[]>,
): Promise<RelatedBatchNote | undefined> {
  let held: RelatedBatchNote | undefined;
  for (const batch of batches) {
    const newest = [...batch.rows]
      .filter((row) => row.actionId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.actionId;
    const actionIds = new Set(
      [
        ...batch.rows
          .filter((row) => row.itemKey === itemKey)
          .map((row) => row.actionId),
        newest,
      ].filter((actionId): actionId is string => Boolean(actionId)),
    );
    const row = { batchId: batch.batchId, itemKey };
    for (const actionId of actionIds)
      for (const step of await stepsOf(actionId)) {
        if (step.operation !== "create_note") continue;
        const forward = parseForward(step);
        if (!forward || !namesRow(forward, row)) continue;
        const found = reservedNoteState(forward);
        if (found.state === "absent") continue;
        if (LANDED_NOTE_STEP_STATUSES.has(step.status)) {
          if (found.state === "live")
            return {
              kind: "landed",
              batchId: batch.batchId,
              step,
              note: found.note,
            };
        } else if (step.status === "uncertain")
          held ||= {
            kind: "held",
            batchId: batch.batchId,
            step,
            reason: heldNoteReason(forward),
          };
      }
  }
  return held;
}

/** Reads each journal action's steps once, however often it is asked. */
export function journalStepsReader(): (
  actionId: string,
) => Promise<readonly JournalStep[]> {
  const read = new Map<string, Promise<JournalStep[]>>();
  return (actionId) => {
    let steps = read.get(actionId);
    if (!steps) {
      steps = listJournalSteps(actionId);
      read.set(actionId, steps);
    }
    return steps;
  };
}

/**
 * The note batches in this batch's retry chain, both ways and through
 * every link, as each job recorded when it was opened as a retry
 * (`retryOf` in its input). This batch is not included.
 *
 * The relation is recorded rather than re-derived: after a retry has
 * written, the earlier batch may no longer owe the papers that made it one,
 * and an unrelated later request over the same papers must not join it.
 */
export async function relatedNoteBatchIds(
  batchId: string,
  conversationKey: number,
): Promise<string[]> {
  if (!conversationKey) return [];
  const links = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    if (!links.has(from)) links.set(from, new Set());
    links.get(from)!.add(to);
  };
  for (const job of await listConversationBatchJobs(
    conversationKey,
    "note_write_batch",
  ))
    for (const id of storedRetryOf(job.inputJson)) {
      link(job.jobId, id);
      link(id, job.jobId);
    }
  const ids = new Set<string>([batchId]);
  const queue = [batchId];
  for (let next = queue.shift(); next !== undefined; next = queue.shift())
    for (const id of links.get(next) || [])
      if (!ids.has(id)) {
        ids.add(id);
        queue.push(id);
      }
  ids.delete(batchId);
  return [...ids];
}

function storedRetryOf(inputJson: string | undefined): string[] {
  try {
    const parsed = JSON.parse(inputJson || "{}") as { retryOf?: unknown };
    return Array.isArray(parsed?.retryOf)
      ? parsed.retryOf.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Whether a note batch was opened by a build that names the action on
 * every row before its first note starts (`rowsLinkedInFlight` in its job
 * input). Only a batch without it can have its note in flight under an
 * action no row names, so only such a batch needs the conversation-wide
 * scan of `listUnnamedNoteBatchActions`.
 */
export function batchLinksRowsInFlight(inputJson: string | undefined): boolean {
  try {
    const parsed = JSON.parse(inputJson || "{}") as {
      rowsLinkedInFlight?: unknown;
    };
    return parsed?.rowsLinkedInFlight === true;
  } catch {
    return false;
  }
}

export const RESERVED_NOTE_MISMATCH =
  "The reserved note does not match the finalized content; no new note was created";

/**
 * What native Zotero holds at the key a note creation reserved, read by
 * `reservedNoteState`.
 *
 * `absent` means the creation never landed. `live` is a note at that key,
 * not trashed, on the intended parent and, when `collections` is given, in
 * each of them; whether its content is the intended one is for the caller
 * to verify. A note in the trash, or moved (to another parent, or out of a
 * collection it was filed into), is `changed`: the creation landed and the
 * user changed it since, so no replacement may be written for it, and it is
 * left where it is. An item at the key that is not a note reads as moved.
 * Each caller words the refusal for its own case.
 */
export function readReservedNote(params: {
  libraryID: number;
  key: string;
  parentItemId?: number;
  collections?: readonly number[];
}):
  | { kind: "absent"; note: null }
  | { kind: "live"; note: Zotero.Item }
  | { kind: "changed"; state: "trashed" | "moved"; note: Zotero.Item } {
  const found = reservedNoteState({
    key: params.key,
    libraryID: params.libraryID,
    parentItemId: params.parentItemId,
    collections: [...(params.collections || [])],
  });
  if (found.state === "absent") return { kind: "absent", note: null };
  if (found.state === "live") return { kind: "live", note: found.note };
  return { kind: "changed", state: found.state, note: found.note };
}

/**
 * The journal record of a created note, verified against native state.
 *
 * Shared by a creation that just wrote the note and by a resume that found
 * an interrupted creation's note already in Zotero, so both leave the same
 * result, inverse and postcondition behind for undo and receipts.
 */
export async function createdNoteOutcome(params: {
  note: Zotero.Item;
  expectedHtml: string;
  verification: Awaited<ReturnType<typeof verifyNativeNoteHtml>>;
  parentItemId?: number;
  collections?: number[];
  warnings: string[];
}) {
  const { note } = params;
  return {
    result: {
      preparedHtml: await storeRecoveryText(params.expectedHtml),
      status: "created",
      noteId: note.id,
      title: note.getNoteTitle(),
      collections: params.collections,
      createdNoteReceipt: await readCreatedNoteReceipt(note),
      noteVerification: params.verification,
      warnings: params.warnings,
    },
    inverse: {
      version: 1,
      kind: "library_operations",
      operations: [{ type: "trash_items", itemIds: [note.id] }],
    },
    expectedPostcondition: {
      kind: "created_item",
      itemId: note.id,
      exists: true,
      parentItemId: params.parentItemId || null,
      htmlChecksum: await sha256Text(note.getNote()),
      collections: params.collections || [],
    },
  };
}

/** Reserve native identity before creation, including before any asset finalization. */
export async function executeNoteCreation(params: Creation) {
  const scope = params.context.runId;
  const identity =
    params.logicalActionId ||
    (await sha256Text(
      JSON.stringify([
        params.context.request.conversationKey,
        scope,
        params.libraryID,
        params.parentItemId,
        params.collections || [],
        canonicalNoteHtml(params.html),
      ]),
    ));
  const previous = pending.get(identity) || Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() =>
      create(
        params,
        params.logicalActionId ||
          (scope ? `note-create-${identity}` : undefined),
      ),
    );
  pending.set(identity, operation);
  try {
    return await operation;
  } finally {
    if (pending.get(identity) === operation) pending.delete(identity);
  }
}

async function create(params: Creation, id?: string) {
  const { context, libraryID, parentItemId } = params;
  // Inside a scope this note is a step of the action that owns the scope, so
  // it neither mints nor resumes a journal action of its own.
  const actionId =
    !context.journalActionScope && isAgentChangeJournalAvailable()
      ? id
      : undefined;
  const prior = actionId
    ? (
        await listJournalActions({
          actionId,
          conversationKey: context.request.conversationKey,
          limit: 1,
        })
      )[0]
    : undefined;
  if (
    prior &&
    ["reverted", "reverting", "revert_failed"].includes(prior.status)
  )
    throw new Error("The created note was undone; a new request is required");
  const reserved = prior
    ? JSON.parse(prior.steps[0]?.forwardJson || "null")
    : null;
  if (
    prior &&
    (!reserved?.key ||
      !reserved.html ||
      reserved.libraryID !== libraryID ||
      reserved.parentItemId !== parentItemId)
  )
    throw new Error(
      "The prior creation has no matching reserved identity; inspect it before retrying",
    );
  const checkpoint = prior?.steps[0]?.resultJson
    ? JSON.parse(prior.steps[0].resultJson)
    : null;
  const key = reserved?.key || Zotero.Utilities.generateObjectKey();
  const payload =
    checkpoint?.preparedHtml ||
    reserved?.html ||
    (await storeRecoveryText(params.html));
  const initialHtml = await readRecoveryText(payload);
  const forward = reserved || {
    version: 1,
    key,
    libraryID,
    parentItemId,
    collections: params.collections || [],
    html: payload,
    finalized: !params.finalize,
    ...(params.batchItem ? { batchItem: params.batchItem } : {}),
  };
  const reservedNote = readReservedNote({ libraryID, key, parentItemId });
  const note = reservedNote.note || new Zotero.Item("note");
  const existed = reservedNote.kind !== "absent";
  if (!existed && (checkpoint?.noteId || prior?.status === "applied"))
    throw new Error(
      "The previously created note is unavailable; recovery cannot recreate a removed note",
    );
  // A single note, not a batch row: the reason speaks of that one note.
  if (reservedNote.kind === "changed")
    throw new Error(
      reservedNote.state === "trashed"
        ? `The note from the earlier attempt (note ${reservedNote.note.id}) is in the trash, so I did not create it again.`
        : `The note from the earlier attempt (note ${reservedNote.note.id}) was moved, so I did not create it again.`,
    );
  if (!existed) {
    note.libraryID = libraryID;
    note.key = key;
    await note.loadPrimaryData(false);
    if (parentItemId) note.parentID = parentItemId;
    for (const collectionId of params.collections || [])
      note.addToCollection(collectionId);
  }
  return executeExternalMutation({
    context,
    toolName: "note_write",
    recovery: actionId ? { actionId, resume: Boolean(prior) } : undefined,
    plan: {
      operation: "create_note",
      description: "Create the prepared Zotero note",
      forward,
      reversibility: params.finalize ? "partial" : "full",
      deferredInverse: true,
    },
    execute: async ({ stepId }) => {
      if (existed && !forward.finalized && !checkpoint?.preparedHtml)
        throw new Error(
          "The reserved note has incomplete assets; inspect that note before resuming asset creation",
        );
      let expected = initialHtml;
      let warnings: string[] = [];
      if (!existed) {
        const persisted = await createFinalizedZoteroNote({
          note,
          initialHtml,
          finalize: params.finalize
            ? async (ctx) => {
                const result = await params.finalize!(ctx);
                const html = typeof result === "string" ? result : result.html;
                // Preserve the exact final payload before its native write,
                // in its own transaction so another flow's rollback cannot
                // drop it. The first save has committed and this runs under a
                // notifier queue, not a transaction, after the step's claim.
                if (stepId) {
                  const preparedHtml = await storeRecoveryText(html);
                  await inJournalTransaction(() =>
                    updateJournalStep({
                      stepId,
                      status: "applying",
                      result: { preparedHtml },
                    }),
                  );
                }
                return result;
              }
            : undefined,
        }).catch((error: unknown) => {
          // Nothing exists at the reserved key, so this creation provably had
          // no effect. Saying so keeps the step out of the uncertain barrier
          // and lets the rest of its action stay undoable.
          if (Zotero.Items.getByLibraryAndKey(libraryID, key)) throw error;
          throw new MutationNoEffectError(
            error instanceof Error ? error.message : String(error),
          );
        });
        expected = persisted.html;
        warnings = persisted.warnings;
      }
      const verification = await verifyNativeNoteHtml(note, expected);
      if (!verification.matches) throw new Error(RESERVED_NOTE_MISMATCH);
      return {
        ...(await createdNoteOutcome({
          note,
          expectedHtml: expected,
          verification,
          parentItemId,
          collections: params.collections,
          warnings,
        })),
        effect: "applied" as const,
        affectedCount: 1,
      };
    },
  });
}

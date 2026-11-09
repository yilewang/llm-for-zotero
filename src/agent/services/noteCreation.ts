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
  updateJournalStep,
  type JournalStep,
} from "../store/changeJournal";
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
 * Why a batch row is refused when the note an earlier attempt reserved for
 * it is held back (an action the current attempt cannot settle holds it, or
 * an older step cannot be tied to one row), naming that note when it is in
 * the library.
 */
export function heldNoteReason(note: Zotero.Item | null): string {
  if (!note) return UNACCOUNTED_NOTE_REASON;
  return note.deleted
    ? `A note from the interrupted attempt (note ${note.id}) is in the trash; this item was not rewritten.`
    : `A note from the interrupted attempt (note ${note.id}) is still in the library; this item was not rewritten.`;
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
): { step: JournalStep; note: Zotero.Item } | undefined {
  for (const step of steps) {
    if (!isOpenNoteStep(step)) continue;
    const forward = parseForward(step);
    if (!forward || recordsRow(forward) || !fitsRow(forward, row)) continue;
    const note = noteAtReservedKey(forward);
    if (note) return { step, note };
  }
  return undefined;
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
 */
export async function findNoteHeldForRow(
  steps: readonly JournalStep[],
  row: BatchRowRef & {
    actionId?: string | null;
    stepSequence?: number | null;
    rebuiltHtml?: () => Promise<string | undefined>;
  },
): Promise<{ step: JournalStep; reason: string } | undefined> {
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
      reason: forward
        ? heldNoteReason(noteAtReservedKey(forward))
        : UNACCOUNTED_NOTE_REASON,
    };
  }
  const matched = await findUncertainNoteStepForRow(steps, row);
  if (matched)
    return {
      step: matched.step,
      reason: heldNoteReason(noteAtReservedKey(matched.forward)),
    };
  const unattributed = findUnattributedNoteStep(steps, row);
  return unattributed
    ? {
        step: unattributed.step,
        reason: heldNoteReason(unattributed.note),
      }
    : undefined;
}

export const RESERVED_NOTE_MISMATCH =
  "The reserved note does not match the finalized content; no new note was created";

/**
 * What native Zotero holds at the key a note creation reserved.
 *
 * `absent` means the creation never landed. `live` is a note at that key,
 * not trashed, on the intended parent and, when `collections` is given, in
 * each of them; whether its content is the intended one is for the caller
 * to verify. Anything else at the key is `changed`: the creation landed and
 * was then removed, moved or replaced, and no replacement may be written for
 * it. A note moved to another parent, or out of a collection it was filed
 * into, was moved by the user and is left where it is.
 */
export function readReservedNote(params: {
  libraryID: number;
  key: string;
  parentItemId?: number;
  collections?: readonly number[];
}):
  | { kind: "absent"; note: null }
  | { kind: "live"; note: Zotero.Item }
  | { kind: "changed"; note: Zotero.Item; reason: string } {
  const found = Zotero.Items.getByLibraryAndKey(params.libraryID, params.key);
  const note = found && found.id ? (found as Zotero.Item) : null;
  if (!note) return { kind: "absent", note: null };
  if (note.deleted || !note.isNote())
    return {
      kind: "changed",
      note,
      reason: `The reserved note was removed or changed; recovery cannot create a replacement (note ${note.id})`,
    };
  const filedInto = note.getCollections();
  if (
    (note.parentID || undefined) !== params.parentItemId ||
    (params.collections || []).some((id) => !filedInto.includes(id))
  )
    return {
      kind: "changed",
      note,
      reason: `Note ${note.id} was moved, so I did not touch it.`,
    };
  return { kind: "live", note };
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
  if (reservedNote.kind === "changed") throw new Error(reservedNote.reason);
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

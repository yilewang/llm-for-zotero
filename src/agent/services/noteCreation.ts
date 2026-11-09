import {
  createFinalizedZoteroNote,
  readCreatedNoteReceipt,
  verifyNativeNoteHtml,
  type FinalizedNoteBuildContext,
  type FinalizedNoteBuildResult,
} from "../../services/notePersistence";
import { canonicalNoteHtml } from "../../utils/noteHtml";
import {
  executeExternalMutation,
  MutationNoEffectError,
} from "./externalMutationCoordinator";
import {
  inJournalTransaction,
  isAgentChangeJournalAvailable,
  listJournalActions,
  updateJournalStep,
} from "../store/changeJournal";
import {
  readRecoveryText,
  sha256Text,
  storeRecoveryText,
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
  html: string;
  finalize?: (
    context: FinalizedNoteBuildContext,
  ) => Promise<string | FinalizedNoteBuildResult>;
};
const pending = new Map<string, Promise<unknown>>();

export const RESERVED_NOTE_MISMATCH =
  "The reserved note does not match the finalized content; no new note was created";

/**
 * What native Zotero holds at the key a note creation reserved.
 *
 * `absent` means the creation never landed. `live` is a note at that key,
 * not trashed, on the intended parent; whether its content is the intended
 * one is for the caller to verify. Anything else at the key is `changed`:
 * the creation landed and was then removed, moved or replaced, and no
 * replacement may be written for it.
 */
export function readReservedNote(params: {
  libraryID: number;
  key: string;
  parentItemId?: number;
}):
  | { kind: "absent"; note: null }
  | { kind: "live"; note: Zotero.Item }
  | { kind: "changed"; note: Zotero.Item; reason: string } {
  const found = Zotero.Items.getByLibraryAndKey(params.libraryID, params.key);
  const note = found && found.id ? (found as Zotero.Item) : null;
  if (!note) return { kind: "absent", note: null };
  if (
    note.deleted ||
    !note.isNote() ||
    (note.parentID || undefined) !== params.parentItemId
  )
    return {
      kind: "changed",
      note,
      reason:
        "The reserved note was removed or changed; recovery cannot create a replacement",
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

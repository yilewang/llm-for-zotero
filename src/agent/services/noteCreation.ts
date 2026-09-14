import {
  createFinalizedZoteroNote,
  readCreatedNoteReceipt,
  verifyNativeNoteHtml,
  type FinalizedNoteBuildContext,
  type FinalizedNoteBuildResult,
} from "../../modules/contextPanel/notePersistence";
import { canonicalNoteHtml } from "../../utils/noteHtml";
import { executeExternalMutation } from "./externalMutationCoordinator";
import {
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
  libraryID: number;
  parentItemId?: number;
  collections?: number[];
  html: string;
  finalize?: (
    context: FinalizedNoteBuildContext,
  ) => Promise<string | FinalizedNoteBuildResult>;
};
const pending = new Map<string, Promise<unknown>>();

/** Reserve native identity before creation, including before any asset finalization. */
export async function executeNoteCreation(params: Creation) {
  const scope =
    params.context.request.actionContract?.id || params.context.runId;
  const identity = await sha256Text(
    JSON.stringify([
      params.context.request.conversationKey,
      scope,
      params.libraryID,
      params.parentItemId,
      params.collections || [],
      canonicalNoteHtml(params.html),
    ]),
  );
  const previous = pending.get(identity) || Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() => create(params, scope ? `note-create-${identity}` : undefined));
  pending.set(identity, operation);
  try {
    return await operation;
  } finally {
    if (pending.get(identity) === operation) pending.delete(identity);
  }
}

async function create(params: Creation, id?: string) {
  const { context, libraryID, parentItemId } = params;
  const actionId = isAgentChangeJournalAvailable() ? id : undefined;
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
  const note =
    Zotero.Items.getByLibraryAndKey(libraryID, key) || new Zotero.Item("note");
  const existed = Boolean(note.id);
  if (!existed && (checkpoint?.noteId || prior?.status === "applied"))
    throw new Error(
      "The previously created note is unavailable; recovery cannot recreate a removed note",
    );
  if (
    existed &&
    (note.deleted ||
      !note.isNote() ||
      (note.parentID || undefined) !== parentItemId)
  )
    throw new Error(
      "The reserved note was removed or changed; recovery cannot create a replacement",
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
    // This note keeps its own stable recovery identity even inside a batch.
    context: { ...context, journalActionScope: undefined },
    toolName: "note_write",
    recovery: actionId ? { actionId, resume: Boolean(prior) } : undefined,
    plan: {
      operation: "create_note",
      description: "Create the prepared Zotero note",
      forward,
      reversibility: params.finalize ? "partial" : "full",
      deferredInverse: true,
    },
    execute: async () => {
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
                // Preserve the exact final payload before its native write.
                if (actionId)
                  await updateJournalStep({
                    stepId: `${actionId}:1`,
                    status: "applying",
                    result: { preparedHtml: await storeRecoveryText(html) },
                  });
                return result;
              }
            : undefined,
        });
        expected = persisted.html;
        warnings = persisted.warnings;
      }
      const verification = await verifyNativeNoteHtml(note, expected);
      if (!verification.matches)
        throw new Error(
          "The reserved note does not match the finalized content; no new note was created",
        );
      return {
        result: {
          preparedHtml: await storeRecoveryText(expected),
          status: "created",
          noteId: note.id,
          title: note.getNoteTitle(),
          collections: params.collections,
          createdNoteReceipt: await readCreatedNoteReceipt(note),
          noteVerification: verification,
          warnings,
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
          parentItemId: parentItemId || null,
          htmlChecksum: await sha256Text(note.getNote()),
          collections: params.collections || [],
        },
        effect: "applied" as const,
        affectedCount: 1,
      };
    },
  });
}

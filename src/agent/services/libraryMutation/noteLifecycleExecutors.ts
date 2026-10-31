import { executeNoteCreation } from "../noteCreation";
import { MutationNoEffectError } from "../externalMutationCoordinator";
import { renderRawNoteHtml } from "../../../services/notes/noteRendering";
import type { ForwardExecutorRegistry } from "./forwardExecutionContracts";
import type { NativeNoteWriteEvidence } from "./contracts";
import { buildSaveNoteInverse } from "./forwardExecutionSupport";
import type { AgentBatchBinding } from "../../types";
import { loadPlanDocument } from "../../documents/store";
import { documentNoteHtml } from "../../documents/actions";
import { assertMaterialRefMatches } from "../../documents/workflowMaterial";
import { advanceBatchJob } from "../../store/batchJobStore";
import {
  listBatchItems,
  markBatchItemFailed,
  markBatchItemSaved,
} from "../../store/batchItemStore";

/**
 * The exact HTML one batch item writes.
 *
 * A finalized item writes its stored document, re-checked against the frozen
 * reference, so a retry after a crash cannot write text that drifted from the
 * material the user approved. Without material — the operation executed
 * outside a durable batch — the supplied body is rendered as before.
 *
 * Either way the HTML is the one a single finalized document would store:
 * each `{{cite item=…}}` becomes a citation chip registered in the note
 * root, and a request that cannot be cited throws, so it becomes this
 * item's failure before anything is written.
 */
async function noteHtmlForBatchItem(params: {
  bound?: AgentBatchBinding["items"][number];
  content: string;
  libraryID: number;
}): Promise<string> {
  if (!params.bound)
    return documentNoteHtml(
      renderRawNoteHtml(params.content),
      params.libraryID,
    );
  // A bound item whose body could not be finalized has nothing the user
  // approved, so it is recorded as this item's failure instead of falling
  // back to the unfinalized text.
  if (!params.bound.material)
    throw new Error(params.bound.failure || "The note body was not finalized");
  const document = await loadPlanDocument(params.bound.material.documentId);
  if (!document)
    throw new Error(
      `The finalized note material ${params.bound.material.documentId} is no longer stored`,
    );
  assertMaterialRefMatches(document, params.bound.material);
  return documentNoteHtml(document.visibleHtml, params.libraryID);
}

/**
 * The batch rows this operation's notes belong to, position by position.
 *
 * A binding that does not line up with the notes would write one paper's
 * approved material onto another paper, durably, so a mismatch stops the
 * batch before its first write rather than being repaired per item.
 */
function batchBindingFor(
  binding: AgentBatchBinding | undefined,
  notes: ReadonlyArray<{ targetItemId: number }>,
): AgentBatchBinding | undefined {
  if (!binding) return undefined;
  const alignedToNotes =
    binding.items.length === notes.length &&
    binding.items.every(
      (item, index) => item.targetItemId === notes[index].targetItemId,
    );
  if (!alignedToNotes)
    throw new Error("The batch rows do not describe these notes");
  return binding;
}

type DomainOperation =
  | "save_notes_batch"
  | "create_items"
  | "save_note"
  | "trash_items"
  | "restore_from_trash"
  | "merge_items";

export const noteLifecycleExecutors = {
  save_notes_batch: async (operation, context, zoteroGateway) => {
    const rows: Array<{
      targetItemId: number;
      /** The durable row this note belongs to, when it runs inside a batch. */
      itemKey?: string;
      noteId?: number;
      actionId?: string;
      title: string;
      status: "created" | "already_saved" | "error";
      reason?: string;
    }> = [];
    // The read-back each creation already forced, kept for the receipt owner.
    // Only a note this call physically created contributes one: an item the
    // batch skipped as already saved was written by an earlier call and is
    // that call's receipt to prove, not this one's.
    const noteWrites: NativeNoteWriteEvidence[] = [];
    const binding = batchBindingFor(context.batchBinding, operation.notes);
    const batchId = binding?.batchId;
    // What this batch has already written. A note is written once: inside a
    // batch action `executeNoteCreation` has no journal action of its own to
    // recover, so nothing downstream would recognise the second attempt.
    const priorRows = new Map(
      (batchId ? await listBatchItems(batchId) : []).map((row) => [
        row.itemKey,
        row,
      ]),
    );
    let appliedCount = [...priorRows.values()].filter(
      (row) => row.status === "saved",
    ).length;
    // Progress is written after each note lands, never before: a cursor ahead
    // of the library would skip an unwritten note on resume.
    const recordProgress = async (params: {
      itemKey?: string;
      position: number;
      journalStep?: { actionId: string; sequence: number };
      noteId?: number;
      error?: string;
      alreadySaved?: boolean;
    }) => {
      if (!batchId || !params.itemKey) return;
      const now = Date.now();
      if (params.alreadySaved) {
        // The row already names the note this item wrote; rewriting it would
        // replace that note's id with a second note's.
      } else if (params.noteId !== undefined) {
        appliedCount += 1;
        await markBatchItemSaved(batchId, params.itemKey, {
          actionId: params.journalStep?.actionId,
          stepSequence: params.journalStep?.sequence,
          noteId: params.noteId,
          now,
        });
      } else {
        await markBatchItemFailed(batchId, params.itemKey, {
          actionId: params.journalStep?.actionId,
          stepSequence: params.journalStep?.sequence,
          error: params.error || "The note was not written",
          now,
        });
      }
      await advanceBatchJob({
        jobId: batchId,
        cursor: params.position,
        appliedCount,
        now,
      });
    };
    // Where the user's Stop ended the batch: the notes before this index
    // were reached, the rest were never started.
    let stoppedAt: number | undefined;
    for (const [index, entry] of operation.notes.entries()) {
      // Stop takes effect between notes. The note in flight has landed, or
      // failed, on its own terms; no further note starts, and each one left
      // keeps its pending row for a resume.
      if (context.signal?.aborted) {
        stoppedAt = index;
        break;
      }
      const bound = binding?.items[index];
      // The durable row's own place in the batch, not this call's: a resume
      // writes a subset, and a cursor renumbered from it would report the
      // batch as further behind than it is.
      const position = bound?.position ?? index + 1;
      const target = zoteroGateway.getItem(entry.targetItemId);
      const title = target
        ? String(target.getDisplayTitle?.() || `Item ${entry.targetItemId}`)
        : `Item ${entry.targetItemId}`;
      const prior = bound ? priorRows.get(bound.itemKey) : undefined;
      if (prior?.status === "saved") {
        rows.push({
          targetItemId: entry.targetItemId,
          itemKey: bound?.itemKey,
          noteId: prior.noteId,
          title,
          status: "already_saved",
        });
        await recordProgress({
          itemKey: bound?.itemKey,
          position,
          alreadySaved: true,
        });
        continue;
      }
      if (!target) {
        const reason = `No item with ID ${entry.targetItemId} exists in this library`;
        rows.push({
          targetItemId: entry.targetItemId,
          itemKey: bound?.itemKey,
          title,
          status: "error",
          reason,
        });
        await recordProgress({
          itemKey: bound?.itemKey,
          position,
          error: reason,
        });
        continue;
      }
      try {
        const execution = await executeNoteCreation({
          context,
          libraryID: target.libraryID,
          parentItemId:
            operation.target === "standalone" ? undefined : target.id,
          collections:
            operation.target === "standalone" ? entry.collections : undefined,
          html: await noteHtmlForBatchItem({
            bound,
            content: entry.content,
            libraryID: target.libraryID,
          }),
        });
        const saved = execution.content;
        // A standalone note has no parent to check the read-back against, so
        // the verifier is told which collections it was filed into instead;
        // a child note is checked against the paper it was written onto.
        const standalone = operation.target === "standalone";
        // Unconditional on purpose: `executeNoteCreation` throws unless the
        // note it created read back as the finalized content, so a success
        // always carries both the id and that read-back. Guarding here would
        // turn a future divergence into a silently missing receipt fact; this
        // way the verifier sees the write and rejects it out loud.
        noteWrites.push({
          noteId: saved.noteId,
          ...(standalone ? {} : { parentItemId: target.id }),
          ...(standalone && entry.collections?.length
            ? { collections: entry.collections }
            : {}),
          verification: saved.noteVerification,
        });
        const childActionId = (
          execution.content as unknown as { actionId?: unknown }
        ).actionId;
        rows.push({
          targetItemId: entry.targetItemId,
          itemKey: bound?.itemKey,
          noteId: saved.noteId,
          actionId:
            typeof childActionId === "string" ? childActionId : undefined,
          title,
          status: "created",
        });
        await recordProgress({
          itemKey: bound?.itemKey,
          position,
          journalStep: execution.journalStep,
          noteId: saved.noteId,
        });
      } catch (error) {
        // One bad target must not lose the other forty-nine notes.
        const reason = error instanceof Error ? error.message : String(error);
        rows.push({
          targetItemId: entry.targetItemId,
          itemKey: bound?.itemKey,
          title,
          status: "error",
          reason,
        });
        await recordProgress({
          itemKey: bound?.itemKey,
          position,
          error: reason,
        });
      }
    }
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result: {
          createdCount: rows.filter((row) => row.status === "created").length,
          alreadySavedCount: rows.filter(
            (row) => row.status === "already_saved",
          ).length,
          failedCount: rows.filter((row) => row.status === "error").length,
          actionIds: [
            ...new Set(
              rows.flatMap((row) => (row.actionId ? [row.actionId] : [])),
            ),
          ],
          notes: rows,
          // The notes it reached, of all it was given; the receipt owner
          // judges a stopped batch on those alone.
          ...(stoppedAt === undefined
            ? {}
            : { stopped: { after: stoppedAt, of: operation.notes.length } }),
        },
      },
      // Each note is a durable step of the owning action and records its own
      // `trash_items` inverse. A whole-batch inverse here would trash the
      // same notes a second time during an undo.
      inverse: null,
      noteWrites,
    };
  },
  create_items: async (operation, context, zoteroGateway) => {
    const libraryID = zoteroGateway.resolveLibraryID({
      request: context.request,
      item: context.item,
      libraryID: operation.libraryID,
    });
    if (!libraryID) {
      throw new Error("No active library available for item creation");
    }
    const result = await zoteroGateway.createItems({
      libraryID,
      items: operation.items as never,
    });
    const createdIds = result.items
      .filter((row) => row.status === "created" && row.itemId)
      .map((row) => row.itemId as number);
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      // Trash rather than erase, matching every other delete here: the
      // user may want the item back after undoing by mistake.
      inverse: createdIds.length
        ? {
            inverseOperations: [{ type: "trash_items", itemIds: createdIds }],
            description: `Trash ${createdIds.length} newly created item${
              createdIds.length === 1 ? "" : "s"
            }`,
          }
        : null,
    };
  },
  save_note: async (operation, context, zoteroGateway) => {
    const item =
      (operation.targetItemId
        ? zoteroGateway.getItem(operation.targetItemId)
        : null) ||
      zoteroGateway.getItem(context.request.activeItemId) ||
      context.item;
    const saved = await zoteroGateway.saveAnswerToNote({
      item,
      libraryID: context.request.libraryID,
      content: operation.content,
      modelName: operation.modelName || context.modelName,
      target: operation.target,
      appendToTrackedNote: operation.appendToTrackedNote,
      generatedImages: operation.generatedImages,
      collections: operation.collections,
    });
    // The note id and the collections it landed in are returned so the
    // caller can verify and follow up; previously only a status string
    // came back and any next step was impossible to express.
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result: {
          status: saved.status,
          noteId: saved.noteId,
          collections: saved.collections,
          ...(saved.createdNoteReceipt
            ? { createdNoteReceipt: saved.createdNoteReceipt }
            : {}),
        },
      },
      inverse:
        saved.noteId && saved.noteId > 0
          ? buildSaveNoteInverse(saved.noteId)
          : undefined,
    };
  },
  trash_items: async (operation, context, zoteroGateway) => {
    const result = await zoteroGateway.trashItems({
      itemIds: operation.itemIds,
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      inverse:
        result.trashedCount > 0
          ? {
              inverseOperations: [
                {
                  type: "restore_from_trash" as const,
                  itemIds: result.items
                    .filter((item) => item.status === "trashed")
                    .map((item) => item.itemId),
                },
              ],
              description: `Restore ${result.trashedCount} trashed item${
                result.trashedCount === 1 ? "" : "s"
              }`,
            }
          : null,
    };
  },
  restore_from_trash: async (operation, context, zoteroGateway) => {
    const itemIds = operation.itemIds || [];
    const collectionIds = operation.collectionIds || [];
    const savedSearchIds = operation.savedSearchIds || [];
    const restoredItems = itemIds.length
      ? await zoteroGateway.restoreItems({ itemIds })
      : { restoredCount: 0, itemIds: [] as number[] };
    const restoredCollections = collectionIds.length
      ? await zoteroGateway.restoreCollections({ collectionIds })
      : { restoredCount: 0, collectionIds: [] as number[] };
    const restoredSearches = savedSearchIds.length
      ? await zoteroGateway.restoreSavedSearches({ savedSearchIds })
      : { restoredCount: 0, savedSearchIds: [] as number[] };
    const restoredCollectionIds = Array.isArray(
      restoredCollections.collectionIds,
    )
      ? restoredCollections.collectionIds
      : [];
    const restoredSavedSearchIds = Array.isArray(
      restoredSearches.savedSearchIds,
    )
      ? restoredSearches.savedSearchIds
      : [];
    const incompleteRestoreIdentity =
      restoredCollectionIds.length < restoredCollections.restoredCount ||
      restoredSavedSearchIds.length < restoredSearches.restoredCount;
    const total =
      restoredItems.restoredCount +
      restoredCollections.restoredCount +
      restoredSearches.restoredCount;
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result: {
          restoredItemCount: restoredItems.restoredCount,
          restoredCollectionCount: restoredCollections.restoredCount,
          restoredSavedSearchCount: restoredSearches.restoredCount,
          restoredCollectionIds,
          restoredSavedSearchIds,
          restoredCount: total,
        },
      },
      // The inverse re-trashes only what this call actually restored, so
      // undoing a partial restore cannot sweep up untouched siblings.
      inverse: total
        ? {
            inverseOperations: [
              ...(restoredItems.itemIds.length
                ? [
                    {
                      type: "trash_items" as const,
                      itemIds: restoredItems.itemIds,
                    },
                  ]
                : []),
              ...restoredCollectionIds.map((collectionId) => ({
                type: "delete_collection" as const,
                collectionId,
              })),
              ...restoredSavedSearchIds.map((savedSearchId) => ({
                type: "delete_saved_search" as const,
                savedSearchId,
              })),
            ],
            description: `Move ${total} restored object${total === 1 ? "" : "s"} back to the trash`,
            ...(incompleteRestoreIdentity
              ? {
                  irreversibleReason:
                    "Some restored collection or saved-search IDs were not reported by Zotero, so only the identified objects can be returned to the trash safely.",
                }
              : {}),
          }
        : null,
    };
  },
  merge_items: async (operation, context, zoteroGateway) => {
    // Re-checked at the group's own turn: in a batch of groups an earlier
    // merge, or the user, may have trashed or erased one of these items since
    // the card. Nothing has been written, so the refusal is proof of no effect.
    const refusal = zoteroGateway.mergeRefusal([operation]);
    if (refusal) throw new MutationNoEffectError(refusal);
    const result = await zoteroGateway.mergeItems({
      masterItemId: operation.masterItemId,
      otherItemIds: operation.otherItemIds,
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      // A merge is not fully reversible: Zotero moves children onto the
      // survivor and deduplicates identical attachments by hash, so the
      // originals no longer exist to give back. Bringing the duplicates
      // out of the trash returns records stripped of their attachments,
      // notes and tags -- so the description says exactly that rather
      // than promising a restore it cannot perform.
      inverse:
        result.mergedCount > 0
          ? {
              description: `Bring ${result.mergedCount} merged item${
                result.mergedCount === 1 ? "" : "s"
              } back from the trash (their attachments, notes and tags stay with the surviving item, so this does not fully un-merge them)`,
              irreversibleReason:
                "A Zotero merge cannot be safely undone because child records may be deduplicated or moved onto the surviving item.",
            }
          : null,
    };
  },
} satisfies Pick<ForwardExecutorRegistry, DomainOperation>;

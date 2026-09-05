import type { ForwardExecutorRegistry } from "./forwardExecutionContracts";
import { buildSaveNoteInverse } from "./forwardExecutionSupport";

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
      noteId?: number;
      title: string;
      status: "created" | "error";
      reason?: string;
    }> = [];
    const createdNoteIds: number[] = [];
    for (const entry of operation.notes) {
      const target = zoteroGateway.getItem(entry.targetItemId);
      const title = target
        ? String(target.getDisplayTitle?.() || `Item ${entry.targetItemId}`)
        : `Item ${entry.targetItemId}`;
      if (!target) {
        rows.push({
          targetItemId: entry.targetItemId,
          title,
          status: "error",
          reason: `No item with ID ${entry.targetItemId} exists in this library`,
        });
        continue;
      }
      try {
        const saved = await zoteroGateway.saveAnswerToNote({
          item: target,
          libraryID: context.request.libraryID,
          content: entry.content,
          modelName: operation.modelName || context.modelName,
          target: operation.target || "item",
          collections: entry.collections,
        });
        if (saved.noteId) createdNoteIds.push(saved.noteId);
        rows.push({
          targetItemId: entry.targetItemId,
          noteId: saved.noteId,
          title,
          status: "created",
        });
      } catch (error) {
        // One bad target must not lose the other forty-nine notes.
        rows.push({
          targetItemId: entry.targetItemId,
          title,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result: {
          createdCount: rows.filter((row) => row.status === "created").length,
          failedCount: rows.filter((row) => row.status === "error").length,
          notes: rows,
        },
      },
      inverse: createdNoteIds.length
        ? {
            inverseOperations: [
              { type: "trash_items", itemIds: createdNoteIds },
            ],
            description: `Trash ${createdNoteIds.length} note${
              createdNoteIds.length === 1 ? "" : "s"
            } that were just written`,
          }
        : null,
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

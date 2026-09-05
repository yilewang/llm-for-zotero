import type { ForwardExecutorRegistry } from "./forwardExecutionContracts";
import {
  buildCollectionAddInverse,
  buildCollectionSetInverse,
  buildCollectionRemoveInverse,
  buildCreateCollectionInverse,
  buildDeleteCollectionInverse,
  directMoveAssignments,
} from "./forwardExecutionSupport";

type DomainOperation =
  | "move_to_collection"
  | "remove_from_collection"
  | "set_item_collections"
  | "create_collection"
  | "delete_collection"
  | "save_saved_search"
  | "delete_saved_search"
  | "update_collection"
  | "update_library_tag";

export const collectionSearchExecutors = {
  move_to_collection: async (operation, context, zoteroGateway) => {
    const assignments = directMoveAssignments(operation);
    if (!assignments.length) {
      throw new Error("No paper-to-collection assignments were selected");
    }
    const result = await zoteroGateway.addItemsToCollections({
      assignments,
      mode: operation.mode,
      from: operation.from,
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      // A move's inverse has to restore the whole prior membership set.
      // The add-undo below only removes the destination, which for a move
      // would leave the item unfiled from wherever it came.
      inverse:
        operation.mode === "move" && result.priorCollections?.length
          ? buildCollectionSetInverse(result.priorCollections)
          : buildCollectionAddInverse(
              result.items
                .filter(
                  (item) => item.status === "moved" && item.targetCollectionId,
                )
                .map((item) => ({
                  itemId: item.itemId,
                  collectionId: item.targetCollectionId as number,
                })),
            ),
    };
  },
  save_saved_search: async (operation, context, zoteroGateway) => {
    const libraryID = zoteroGateway.resolveLibraryID({
      request: context.request,
      item: context.item,
      libraryID: operation.libraryID,
    });
    const result = await zoteroGateway.saveSavedSearch({
      libraryID,
      name: operation.name,
      conditions: operation.conditions,
      joinMode: operation.joinMode,
      savedSearchId: operation.savedSearchId,
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      // Only a newly created search has a clean inverse; replacing an
      // existing one's conditions discards what they were.
      inverse:
        result.status === "created"
          ? {
              inverseOperations: [
                {
                  type: "delete_saved_search" as const,
                  savedSearchId: result.savedSearchId,
                  permanent: true,
                },
              ],
              description: `Delete the saved search "${result.name}"`,
            }
          : null,
    };
  },
  delete_saved_search: async (operation, context, zoteroGateway) => {
    const result = await zoteroGateway.deleteSavedSearch({
      savedSearchId: operation.savedSearchId,
      ...(operation.permanent ? { permanent: true } : {}),
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      inverse:
        result.status === "trashed"
          ? {
              inverseOperations: [
                {
                  type: "restore_from_trash" as const,
                  savedSearchIds: [operation.savedSearchId],
                },
              ],
              description: `Restore the saved search from the trash`,
            }
          : null,
    };
  },
  update_collection: async (operation, context, zoteroGateway) => {
    const result = await zoteroGateway.updateCollection({
      collectionId: operation.collectionId,
      name: operation.name,
      parentCollectionId: operation.parentCollectionId,
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      inverse:
        result.status === "updated"
          ? {
              inverseOperations: [
                {
                  type: "update_collection" as const,
                  collectionId: operation.collectionId,
                  name: result.previousName,
                  parentCollectionId: result.previousParentCollectionId,
                },
              ],
              description: `Rename "${result.name}" back to "${result.previousName}"`,
            }
          : null,
    };
  },
  update_library_tag: async (operation, context, zoteroGateway) => {
    const libraryID = zoteroGateway.resolveLibraryID({
      request: context.request,
      item: context.item,
      libraryID: operation.libraryID,
    });
    const result = await zoteroGateway.updateLibraryTag({
      libraryID,
      action: operation.action,
      tag: operation.tag,
      newTag: operation.newTag,
      color: operation.color,
      position: operation.position,
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      // Only a rename is reversible by renaming back. A merge destroys
      // the source/destination distinction, while a delete destroys the
      // membership set; neither may advertise a lossy "undo".
      inverse:
        result.status === "applied" &&
        operation.action === "rename" &&
        result.newTag &&
        result.destinationExisted === false
          ? {
              inverseOperations: [
                {
                  type: "update_library_tag" as const,
                  action: "rename" as const,
                  tag: result.newTag,
                  newTag: operation.tag,
                  libraryID,
                },
              ],
              description: `Rename tag "${result.newTag}" back to "${operation.tag}"`,
            }
          : result.status === "applied" &&
              (operation.action === "delete" ||
                operation.action === "merge" ||
                (operation.action === "rename" &&
                  result.destinationExisted !== false))
            ? {
                irreversibleReason:
                  operation.action === "delete"
                    ? `Deleting the tag "${operation.tag}" library-wide also discards which items carried it, so it cannot be restored.`
                    : `Combining the tag "${operation.tag}" with the existing tag "${operation.newTag || "another tag"}" destroys which items originally carried each tag, so it cannot be separated safely.`,
                description:
                  operation.action === "delete"
                    ? `Delete tag "${operation.tag}"`
                    : `Merge tag "${operation.tag}"`,
              }
            : null,
    };
  },
  set_item_collections: async (operation, context, zoteroGateway) => {
    const result = await zoteroGateway.setItemCollections({
      assignments: operation.assignments,
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      inverse: result.priorCollections.length
        ? buildCollectionSetInverse(result.priorCollections)
        : null,
    };
  },
  remove_from_collection: async (operation, context, zoteroGateway) => {
    const removedItems: Array<{ itemId: number; collectionId: number }> = [];
    const rows: Array<{
      itemId: number;
      status: string;
      reason?: string;
    }> = [];
    for (const itemId of operation.itemIds) {
      const outcome = await zoteroGateway.removeItemFromCollection({
        itemId,
        collectionId: operation.collectionId,
      });
      if (outcome.removed) {
        removedItems.push({ itemId, collectionId: operation.collectionId });
        rows.push({ itemId, status: "removed" });
      } else {
        rows.push({
          itemId,
          status: "skipped",
          reason: outcome.reason,
        });
      }
    }
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result: {
          itemIds: operation.itemIds,
          collectionId: operation.collectionId,
          // Counted from what actually happened, not from the request.
          removedCount: removedItems.length,
          items: rows,
        },
      },
      inverse: removedItems.length
        ? buildCollectionRemoveInverse(removedItems)
        : undefined,
    };
  },
  create_collection: async (operation, context, zoteroGateway) => {
    const libraryID = zoteroGateway.resolveLibraryID({
      request: context.request,
      item: context.item,
      libraryID: operation.libraryID,
    });
    if (!libraryID) {
      throw new Error("No active library available for collection creation");
    }
    const collection = await zoteroGateway.createCollection({
      name: operation.name,
      parentCollectionId: operation.parentCollectionId,
      libraryID,
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result: { collection },
      },
      inverse: buildCreateCollectionInverse(collection),
    };
  },
  delete_collection: async (operation, context, zoteroGateway) => {
    // Deleting trashes the collection, exactly as Zotero's own "Delete
    // Collection" does, so subcollections travel with it and the inverse
    // is a restore by id rather than a rebuild. That is why the old
    // refusal of collections with subcollections is gone: a flat snapshot
    // could not restore a subtree, but the trash restores it intact.
    const snapshot = zoteroGateway.snapshotCollectionForDelete({
      collectionId: operation.collectionId,
    });
    await zoteroGateway.deleteCollection({
      collectionId: operation.collectionId,
      ...(operation.deleteItems ? { deleteItems: true } : {}),
      ...(operation.permanent ? { permanent: true } : {}),
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result: {
          collectionId: operation.collectionId,
          status: operation.permanent ? "erased" : "trashed",
          childCollectionCount: snapshot?.childCollectionCount ?? 0,
          itemCount: snapshot?.itemIds.length ?? 0,
          itemsTrashed: !!operation.deleteItems,
        },
      },
      // A permanent erase has no inverse, so it deliberately records no
      // undo rather than promising one it cannot honour.
      inverse:
        snapshot && !operation.permanent
          ? buildDeleteCollectionInverse({
              ...snapshot,
              collectionId: operation.collectionId,
              deleteItems: !!operation.deleteItems,
            })
          : undefined,
    };
  },
} satisfies Pick<ForwardExecutorRegistry, DomainOperation>;

import type { AgentToolContext } from "../../types";
import type {
  BatchMoveAssignment,
  BatchTagAssignment,
  CollectionSummary,
  EditableArticleMetadataSnapshot,
  ZoteroGateway,
} from "../zoteroGateway";
import type {
  ApplyTagsOperation,
  LibraryMutationInverse,
  MoveToCollectionOperation,
} from "./contracts";

export function buildMetadataInverse(
  snapshot: EditableArticleMetadataSnapshot,
): LibraryMutationInverse {
  const { itemId, fields, creators, title } = snapshot;
  return {
    description: `Undo metadata edit for "${title}"`,
    inverseOperations: [
      {
        type: "update_metadata",
        itemId,
        metadata: { ...fields, creators },
      },
    ],
  };
}

export function buildTagInverse(
  itemIdsByTag: Array<{ itemId: number; addedTags: string[] }>,
): LibraryMutationInverse | null {
  if (!itemIdsByTag.length) return null;
  return {
    inverseOperations: itemIdsByTag.map(({ itemId, addedTags }) => ({
      type: "remove_tags" as const,
      itemIds: [itemId],
      tags: addedTags,
    })),
    description: `Undo tags applied to ${itemIdsByTag.length} paper${
      itemIdsByTag.length === 1 ? "" : "s"
    }`,
  };
}

export function buildRemoveTagsInverse(
  restored: Array<{ itemId: number; tags: string[] }>,
): LibraryMutationInverse | null {
  if (!restored.length) return null;
  return {
    inverseOperations: restored.map((entry) => ({
      type: "apply_tags" as const,
      itemIds: [entry.itemId],
      tags: entry.tags,
    })),
    description: `Restore removed tags on ${restored.length} paper${
      restored.length === 1 ? "" : "s"
    }`,
  };
}

export function buildCollectionAddInverse(
  movedItems: Array<{ itemId: number; collectionId: number }>,
): LibraryMutationInverse | null {
  if (!movedItems.length) return null;
  const byCollection = new Map<number, number[]>();
  for (const { itemId, collectionId } of movedItems) {
    const list = byCollection.get(collectionId) || [];
    list.push(itemId);
    byCollection.set(collectionId, list);
  }
  return {
    inverseOperations: Array.from(byCollection.entries()).map(
      ([collectionId, itemIds]) => ({
        type: "remove_from_collection" as const,
        itemIds,
        collectionId,
      }),
    ),
    description: `Undo collection moves for ${movedItems.length} paper${
      movedItems.length === 1 ? "" : "s"
    }`,
  };
}

/**
 * Puts items back into exactly the collections they were in.
 *
 * The inverse of a move is a *set*, not a removal. `buildCollectionAddInverse`
 * emits `remove_from_collection`, so using it to undo a move would take the
 * item out of its destination and never restore the collections it was moved
 * out of — silently unfiling it.
 */
export function buildCollectionSetInverse(
  priorCollections: Array<{ itemId: number; collectionIds: number[] }>,
): LibraryMutationInverse | null {
  if (!priorCollections.length) return null;
  return {
    inverseOperations: [
      { type: "set_item_collections" as const, assignments: priorCollections },
    ],
    description: `Restore the previous collections of ${priorCollections.length} item${
      priorCollections.length === 1 ? "" : "s"
    }`,
  };
}

export function buildCollectionRemoveInverse(
  removedItems: Array<{ itemId: number; collectionId: number }>,
): LibraryMutationInverse | null {
  if (!removedItems.length) return null;
  return {
    inverseOperations: removedItems.map(({ itemId, collectionId }) => ({
      type: "move_to_collection" as const,
      itemIds: [itemId],
      targetCollectionId: collectionId,
    })),
    description: `Restore ${removedItems.length} paper${
      removedItems.length === 1 ? "" : "s"
    } to their collection`,
  };
}

export function buildCreateCollectionInverse(
  collection: CollectionSummary,
): LibraryMutationInverse {
  return {
    inverseOperations: [
      {
        type: "delete_collection",
        collectionId: collection.collectionId,
        permanent: true,
      },
    ],
    description: `Undo creation of collection "${collection.name}"`,
  };
}

/**
 * Restores a collection that `delete_collection` moved to the trash.
 *
 * This used to rebuild the collection from a flat snapshot, which minted a
 * new id — so anything holding the old id silently stopped following it, and
 * subcollections could not come back at all (which is why deleting a
 * collection with subcollections was refused outright).
 *
 * Now that deleting trashes rather than erases, the inverse is simply to
 * clear the `deleted` flag: every id survives, and descendants are restored
 * with their parent. Items trashed alongside the collection are restored too,
 * but only when the delete actually took them.
 */
export function buildDeleteCollectionInverse(snapshot: {
  collectionId: number;
  name: string;
  itemIds: number[];
  childCollectionCount: number;
  deleteItems: boolean;
}): LibraryMutationInverse {
  const parts: string[] = [];
  if (snapshot.childCollectionCount > 0) {
    parts.push(
      `${snapshot.childCollectionCount} subcollection${snapshot.childCollectionCount === 1 ? "" : "s"}`,
    );
  }
  if (snapshot.deleteItems && snapshot.itemIds.length) {
    parts.push(
      `${snapshot.itemIds.length} item${snapshot.itemIds.length === 1 ? "" : "s"}`,
    );
  }
  return {
    description: `Restore collection "${snapshot.name}"${
      parts.length ? ` with its ${parts.join(" and ")}` : ""
    }`,
    inverseOperations: [
      {
        type: "restore_from_trash",
        collectionIds: [snapshot.collectionId],
        ...(snapshot.deleteItems && snapshot.itemIds.length
          ? { itemIds: snapshot.itemIds }
          : {}),
      },
    ],
  };
}

/**
 * Trashes a note the agent just created. `save_note` previously recorded no
 * inverse at all, so "undo that" after writing a note popped an unrelated
 * earlier entry instead.
 */
export function buildSaveNoteInverse(noteId: number): LibraryMutationInverse {
  return {
    inverseOperations: [{ type: "trash_items", itemIds: [noteId] }],
    description: "Trash the note that was just created",
  };
}

export function directTagAssignments(
  operation: ApplyTagsOperation,
): BatchTagAssignment[] {
  if (operation.assignments?.length) return operation.assignments;
  if (!operation.itemIds?.length || !operation.tags?.length) return [];
  return operation.itemIds.map((itemId) => ({
    itemId,
    tags: operation.tags as string[],
  }));
}

export function directMoveAssignments(
  operation: MoveToCollectionOperation,
): BatchMoveAssignment[] {
  if (operation.assignments?.length) {
    return operation.assignments
      .filter((assignment): assignment is BatchMoveAssignment =>
        Boolean(assignment.targetCollectionId),
      )
      .map((assignment) => ({
        itemId: assignment.itemId,
        targetCollectionId: assignment.targetCollectionId as number,
      }));
  }
  if (!operation.itemIds?.length || !operation.targetCollectionId) return [];
  return operation.itemIds.map((itemId) => ({
    itemId,
    targetCollectionId: operation.targetCollectionId as number,
  }));
}

export function normalizeLibraryID(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

export function assertItemInActiveLibrary(
  item: Zotero.Item | null | undefined,
  context: AgentToolContext,
  operationLabel: string,
): void {
  const requestLibraryID = normalizeLibraryID(context.request.libraryID);
  const itemLibraryID = normalizeLibraryID(item?.libraryID);
  if (
    !requestLibraryID ||
    !itemLibraryID ||
    requestLibraryID === itemLibraryID
  ) {
    return;
  }
  const itemId = Number((item as { id?: unknown } | null | undefined)?.id);
  const itemLabel =
    Number.isFinite(itemId) && itemId > 0 ? `item ${itemId}` : "item";
  throw new Error(
    `Refusing ${operationLabel} for ${itemLabel} in library ${itemLibraryID}; active library is ${requestLibraryID}.`,
  );
}

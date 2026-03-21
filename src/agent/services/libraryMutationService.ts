import type { PaperContextRef } from "../../shared/types";
import type { AgentToolContext } from "../types";
import type {
  BatchMoveAssignment,
  BatchTagAssignment,
  CollectionSummary,
  EditableArticleMetadataPatch,
  EditableArticleMetadataSnapshot,
  ZoteroGateway,
} from "./zoteroGateway";

export type NoteSaveTarget = "item" | "standalone";

export type UpdateMetadataOperation = {
  id?: string;
  type: "update_metadata";
  itemId?: number;
  paperContext?: PaperContextRef;
  metadata: EditableArticleMetadataPatch;
};

export type ApplyTagsOperation = {
  id?: string;
  type: "apply_tags";
  assignments?: BatchTagAssignment[];
  itemIds?: number[];
  tags?: string[];
};

export type RemoveTagsOperation = {
  id?: string;
  type: "remove_tags";
  itemIds: number[];
  tags: string[];
};

export type MoveToCollectionAssignment = {
  itemId: number;
  targetCollectionId?: number;
  targetCollectionName?: string;
  targetCollectionPath?: string;
};

export type MoveToCollectionOperation = {
  id?: string;
  type: "move_to_collection";
  assignments?: MoveToCollectionAssignment[];
  itemIds?: number[];
  targetCollectionId?: number;
  targetCollectionName?: string;
  targetCollectionPath?: string;
};

export type RemoveFromCollectionOperation = {
  id?: string;
  type: "remove_from_collection";
  itemIds: number[];
  collectionId: number;
};

export type CreateCollectionOperation = {
  id?: string;
  type: "create_collection";
  name: string;
  parentCollectionId?: number;
  libraryID?: number;
};

export type DeleteCollectionOperation = {
  id?: string;
  type: "delete_collection";
  collectionId: number;
};

export type SaveNoteOperation = {
  id?: string;
  type: "save_note";
  content: string;
  target?: NoteSaveTarget;
  targetItemId?: number;
  modelName?: string;
};

export type TrashItemsOperation = {
  id?: string;
  type: "trash_items";
  itemIds: number[];
};

export type MergeItemsOperation = {
  id?: string;
  type: "merge_items";
  masterItemId: number;
  otherItemIds: number[];
};

export type DeleteAttachmentOperation = {
  id?: string;
  type: "delete_attachment";
  attachmentId: number;
};

export type RenameAttachmentOperation = {
  id?: string;
  type: "rename_attachment";
  attachmentId: number;
  newName: string;
};

export type RelinkAttachmentOperation = {
  id?: string;
  type: "relink_attachment";
  attachmentId: number;
  newPath: string;
};

export type ImportLocalFilesOperation = {
  id?: string;
  type: "import_local_files";
  filePaths: string[];
  libraryID?: number;
  targetCollectionId?: number;
};

export type ImportIdentifiersOperation = {
  id?: string;
  type: "import_identifiers";
  identifiers: string[];
  libraryID?: number;
  targetCollectionId?: number;
};

export type LibraryMutationOperation =
  | UpdateMetadataOperation
  | ApplyTagsOperation
  | RemoveTagsOperation
  | MoveToCollectionOperation
  | RemoveFromCollectionOperation
  | CreateCollectionOperation
  | DeleteCollectionOperation
  | SaveNoteOperation
  | ImportIdentifiersOperation
  | TrashItemsOperation
  | MergeItemsOperation
  | DeleteAttachmentOperation
  | RenameAttachmentOperation
  | RelinkAttachmentOperation
  | ImportLocalFilesOperation;

export type LibraryMutationUndo = {
  toolName: string;
  description: string;
  revert: () => Promise<void>;
};

export type LibraryMutationExecutionResult = {
  operation: LibraryMutationOperation["type"];
  operationId?: string;
  result: unknown;
};

function buildMetadataUndo(
  zoteroGateway: ZoteroGateway,
  snapshot: EditableArticleMetadataSnapshot,
): LibraryMutationUndo {
  const { itemId, fields, creators, title } = snapshot;
  return {
    toolName: "library_mutation",
    description: `Undo metadata edit for "${title}"`,
    revert: async () => {
      const item = zoteroGateway.getItem(itemId);
      if (!item) return;
      await zoteroGateway.updateArticleMetadata({
        item,
        metadata: { ...fields, creators },
      });
    },
  };
}

function buildTagUndo(
  zoteroGateway: ZoteroGateway,
  itemIdsByTag: Array<{ itemId: number; addedTags: string[] }>,
): LibraryMutationUndo | null {
  if (!itemIdsByTag.length) return null;
  return {
    toolName: "library_mutation",
    description: `Undo tags applied to ${itemIdsByTag.length} paper${
      itemIdsByTag.length === 1 ? "" : "s"
    }`,
    revert: async () => {
      for (const { itemId, addedTags } of itemIdsByTag) {
        await zoteroGateway.removeTagsFromItem({ itemId, tags: addedTags });
      }
    },
  };
}

function buildRemoveTagsUndo(
  zoteroGateway: ZoteroGateway,
  restored: Array<{ itemId: number; tags: string[] }>,
): LibraryMutationUndo | null {
  if (!restored.length) return null;
  return {
    toolName: "library_mutation",
    description: `Restore removed tags on ${restored.length} paper${
      restored.length === 1 ? "" : "s"
    }`,
    revert: async () => {
      for (const entry of restored) {
        await zoteroGateway.applyTagsToItems({
          itemIds: [entry.itemId],
          tags: entry.tags,
        });
      }
    },
  };
}

function buildCollectionAddUndo(
  zoteroGateway: ZoteroGateway,
  movedItems: Array<{ itemId: number; collectionId: number }>,
): LibraryMutationUndo | null {
  if (!movedItems.length) return null;
  return {
    toolName: "library_mutation",
    description: `Undo collection moves for ${movedItems.length} paper${
      movedItems.length === 1 ? "" : "s"
    }`,
    revert: async () => {
      for (const { itemId, collectionId } of movedItems) {
        await zoteroGateway.removeItemFromCollection({
          itemId,
          collectionId,
        });
      }
    },
  };
}

function buildCollectionRemoveUndo(
  zoteroGateway: ZoteroGateway,
  removedItems: Array<{ itemId: number; collectionId: number }>,
): LibraryMutationUndo | null {
  if (!removedItems.length) return null;
  return {
    toolName: "library_mutation",
    description: `Restore ${removedItems.length} paper${
      removedItems.length === 1 ? "" : "s"
    } to their collection`,
    revert: async () => {
      for (const { itemId, collectionId } of removedItems) {
        await zoteroGateway.addItemsToCollection({
          itemIds: [itemId],
          targetCollectionId: collectionId,
        });
      }
    },
  };
}

function buildCreateCollectionUndo(
  zoteroGateway: ZoteroGateway,
  collection: CollectionSummary,
): LibraryMutationUndo {
  return {
    toolName: "library_mutation",
    description: `Undo creation of collection "${collection.name}"`,
    revert: async () => {
      await zoteroGateway.deleteCollection({
        collectionId: collection.collectionId,
      });
    },
  };
}

function directTagAssignments(operation: ApplyTagsOperation): BatchTagAssignment[] {
  if (operation.assignments?.length) return operation.assignments;
  if (!operation.itemIds?.length || !operation.tags?.length) return [];
  return operation.itemIds.map((itemId) => ({
    itemId,
    tags: operation.tags as string[],
  }));
}

function directMoveAssignments(
  operation: MoveToCollectionOperation,
): BatchMoveAssignment[] {
  if (operation.assignments?.length) {
    return operation.assignments
      .filter(
        (assignment): assignment is BatchMoveAssignment =>
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

export class LibraryMutationService {
  constructor(private readonly zoteroGateway: ZoteroGateway) {}

  async executeOperation(
    operation: LibraryMutationOperation,
    context: AgentToolContext,
  ): Promise<{
    result: LibraryMutationExecutionResult;
    undo?: LibraryMutationUndo | null;
  }> {
    switch (operation.type) {
      case "update_metadata": {
        const targetItem = this.zoteroGateway.resolveMetadataItem({
          request: context.request,
          item: context.item,
          itemId: operation.itemId,
          paperContext: operation.paperContext,
        });
        const previousSnapshot =
          this.zoteroGateway.getEditableArticleMetadata(targetItem);
        const result = await this.zoteroGateway.updateArticleMetadata({
          item: targetItem,
          metadata: operation.metadata,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          undo: previousSnapshot
            ? buildMetadataUndo(this.zoteroGateway, previousSnapshot)
            : null,
        };
      }
      case "apply_tags": {
        const assignments = directTagAssignments(operation);
        if (!assignments.length) {
          throw new Error("No tag assignments were selected");
        }
        const result = await this.zoteroGateway.applyTagAssignments({
          assignments,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          undo: buildTagUndo(
            this.zoteroGateway,
            result.items
              .filter(
                (item) => item.status === "updated" && item.addedTags.length > 0,
              )
              .map((item) => ({
                itemId: item.itemId,
                addedTags: item.addedTags,
              })),
          ),
        };
      }
      case "remove_tags": {
        const targetMap = new Map(
          this.zoteroGateway
            .getPaperTargetsByItemIds(operation.itemIds)
            .map((target) => [target.itemId, target] as const),
        );
        const removed: Array<{ itemId: number; tags: string[] }> = [];
        for (const itemId of operation.itemIds) {
          const existing = (targetMap.get(itemId)?.tags || []).filter((tag) =>
            operation.tags.includes(tag),
          );
          await this.zoteroGateway.removeTagsFromItem({
            itemId,
            tags: operation.tags,
          });
          if (existing.length) {
            removed.push({ itemId, tags: existing });
          }
        }
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result: {
              itemIds: operation.itemIds,
              removedCount: removed.length,
              tags: operation.tags,
            },
          },
          undo: buildRemoveTagsUndo(this.zoteroGateway, removed),
        };
      }
      case "move_to_collection": {
        const assignments = directMoveAssignments(operation);
        if (!assignments.length) {
          throw new Error("No paper-to-collection assignments were selected");
        }
        const result = await this.zoteroGateway.addItemsToCollections({
          assignments,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          undo: buildCollectionAddUndo(
            this.zoteroGateway,
            result.items
              .filter((item) => item.status === "moved" && item.targetCollectionId)
              .map((item) => ({
                itemId: item.itemId,
                collectionId: item.targetCollectionId as number,
              })),
          ),
        };
      }
      case "remove_from_collection": {
        const removedItems: Array<{ itemId: number; collectionId: number }> = [];
        for (const itemId of operation.itemIds) {
          await this.zoteroGateway.removeItemFromCollection({
            itemId,
            collectionId: operation.collectionId,
          });
          removedItems.push({
            itemId,
            collectionId: operation.collectionId,
          });
        }
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result: {
              itemIds: operation.itemIds,
              collectionId: operation.collectionId,
              removedCount: operation.itemIds.length,
            },
          },
          undo: buildCollectionRemoveUndo(this.zoteroGateway, removedItems),
        };
      }
      case "create_collection": {
        const libraryID = this.zoteroGateway.resolveLibraryID({
          request: context.request,
          item: context.item,
          libraryID: operation.libraryID,
        });
        if (!libraryID) {
          throw new Error("No active library available for collection creation");
        }
        const collection = await this.zoteroGateway.createCollection({
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
          undo: buildCreateCollectionUndo(this.zoteroGateway, collection),
        };
      }
      case "delete_collection": {
        await this.zoteroGateway.deleteCollection({
          collectionId: operation.collectionId,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result: {
              collectionId: operation.collectionId,
              status: "deleted",
            },
          },
        };
      }
      case "save_note": {
        const item =
          (operation.targetItemId
            ? this.zoteroGateway.getItem(operation.targetItemId)
            : null) ||
          this.zoteroGateway.getItem(context.request.activeItemId) ||
          context.item;
        const status = await this.zoteroGateway.saveAnswerToNote({
          item,
          libraryID: context.request.libraryID,
          content: operation.content,
          modelName: operation.modelName || context.modelName,
          target: operation.target,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result: { status },
          },
        };
      }
      case "import_identifiers": {
        const result = await this.zoteroGateway.importPapersByIdentifiers(
          operation.identifiers,
          operation.libraryID,
          operation.targetCollectionId,
        );
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
        };
      }
      case "trash_items": {
        const result = await this.zoteroGateway.trashItems({
          itemIds: operation.itemIds,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          undo:
            result.trashedCount > 0
              ? {
                  toolName: "library_mutation",
                  description: `Restore ${result.trashedCount} trashed item${
                    result.trashedCount === 1 ? "" : "s"
                  }`,
                  revert: async () => {
                    await this.zoteroGateway.restoreItems({
                      itemIds: result.items
                        .filter((item) => item.status === "trashed")
                        .map((item) => item.itemId),
                    });
                  },
                }
              : null,
        };
      }
      case "merge_items": {
        const result = await this.zoteroGateway.mergeItems({
          masterItemId: operation.masterItemId,
          otherItemIds: operation.otherItemIds,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          undo:
            result.mergedCount > 0
              ? {
                  toolName: "merge_items",
                  description: `Restore ${result.mergedCount} merged item${
                    result.mergedCount === 1 ? "" : "s"
                  }`,
                  revert: async () => {
                    await this.zoteroGateway.restoreItems({
                      itemIds: result.trashedIds,
                    });
                  },
                }
              : null,
        };
      }
      case "delete_attachment": {
        const result = await this.zoteroGateway.deleteAttachment({
          attachmentId: operation.attachmentId,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          undo:
            result.status === "deleted"
              ? {
                  toolName: "manage_attachments",
                  description: `Restore deleted attachment: ${result.title}`,
                  revert: async () => {
                    await this.zoteroGateway.restoreItems({
                      itemIds: [operation.attachmentId],
                    });
                  },
                }
              : null,
        };
      }
      case "rename_attachment": {
        const result = await this.zoteroGateway.renameAttachment({
          attachmentId: operation.attachmentId,
          newName: operation.newName,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
        };
      }
      case "relink_attachment": {
        const result = await this.zoteroGateway.relinkAttachment({
          attachmentId: operation.attachmentId,
          newPath: operation.newPath,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
        };
      }
      case "import_local_files": {
        const result = await this.zoteroGateway.importLocalFiles({
          filePaths: operation.filePaths,
          libraryID: operation.libraryID,
          targetCollectionId: operation.targetCollectionId,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          undo:
            result.succeeded > 0
              ? {
                  toolName: "import_local_files",
                  description: `Trash ${result.succeeded} imported item${
                    result.succeeded === 1 ? "" : "s"
                  }`,
                  revert: async () => {
                    const importedIds = result.items
                      .filter((i) => i.status === "imported" && i.itemId)
                      .map((i) => i.itemId!);
                    if (importedIds.length) {
                      await this.zoteroGateway.trashItems({ itemIds: importedIds });
                    }
                  },
                }
              : null,
        };
      }
    }
  }
}

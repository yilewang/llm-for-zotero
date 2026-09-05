import type { ForwardExecutorRegistry } from "./forwardExecutionContracts";

type DomainOperation =
  | "import_identifiers"
  | "delete_attachment"
  | "rename_attachment"
  | "relink_attachment"
  | "import_local_files";

export const attachmentImportExecutors = {
  import_identifiers: async (operation, context, zoteroGateway) => {
    const result = await zoteroGateway.importPapersByIdentifiers(
      operation.identifiers,
      operation.libraryID,
      operation.targetCollectionId,
    );
    const importedIds = result.itemIds || [];
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      // Previously no undo at all — so after "create a collection, import
      // 50 papers into it", the top of the undo stack was the *collection
      // creation*. "Undo that" deleted the folder and left all 50 items
      // behind, which is worse than a no-op.
      inverse: importedIds.length
        ? {
            inverseOperations: [
              { type: "trash_items" as const, itemIds: importedIds },
            ],
            description: `Trash the ${importedIds.length} imported item${
              importedIds.length === 1 ? "" : "s"
            }`,
          }
        : undefined,
    };
  },
  delete_attachment: async (operation, context, zoteroGateway) => {
    const result = await zoteroGateway.deleteAttachment({
      attachmentId: operation.attachmentId,
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      inverse:
        result.status === "deleted"
          ? {
              inverseOperations: [
                {
                  type: "restore_from_trash" as const,
                  itemIds: [operation.attachmentId],
                },
              ],
              description: `Restore deleted attachment: ${result.title}`,
            }
          : null,
    };
  },
  rename_attachment: async (operation, context, zoteroGateway) => {
    const result = await zoteroGateway.renameAttachment({
      attachmentId: operation.attachmentId,
      newName: operation.newName,
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      // Renaming recorded no inverse at all, so "undo that" after a
      // rename popped an unrelated earlier entry. Only a rename that
      // actually moved the file is reversible.
      inverse:
        result.status === "renamed" && result.previousName
          ? {
              inverseOperations: [
                {
                  type: "rename_attachment" as const,
                  attachmentId: operation.attachmentId,
                  newName: result.previousName,
                },
              ],
              description: `Rename attachment back to "${result.previousName}"`,
            }
          : null,
    };
  },
  relink_attachment: async (operation, context, zoteroGateway) => {
    const result = await zoteroGateway.relinkAttachment({
      attachmentId: operation.attachmentId,
      newPath: operation.newPath,
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      // Only offer to undo when there was a resolvable file to go back
      // to; re-linking an attachment whose file was already missing has
      // no previous path to restore.
      inverse:
        result.status === "relinked" && result.previousPath
          ? {
              inverseOperations: [
                {
                  type: "relink_attachment" as const,
                  attachmentId: operation.attachmentId,
                  newPath: result.previousPath,
                },
              ],
              description: `Re-link attachment back to ${result.previousPath}`,
            }
          : null,
    };
  },
  import_local_files: async (operation, context, zoteroGateway) => {
    const result = await zoteroGateway.importLocalFiles({
      filePaths: operation.filePaths,
      libraryID: operation.libraryID,
      targetCollectionId: operation.targetCollectionId,
      mode: operation.mode,
      recognize: operation.recognize,
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      inverse:
        result.succeeded > 0
          ? {
              inverseOperations: [
                {
                  type: "trash_items" as const,
                  itemIds: result.items
                    .filter((item) => item.status === "imported" && item.itemId)
                    .map((item) => item.itemId as number),
                },
              ],
              description: `Trash ${result.succeeded} imported item${
                result.succeeded === 1 ? "" : "s"
              }`,
            }
          : null,
    };
  },
} satisfies Pick<ForwardExecutorRegistry, DomainOperation>;

import type { AgentToolContext } from "../../types";
import type { ZoteroGateway } from "../zoteroGateway";
import { MutationNoEffectError } from "../externalMutationCoordinator";
import type { ForwardExecutorRegistry } from "./forwardExecutionContracts";
import { assertItemInActiveLibrary } from "./forwardExecutionSupport";

type DomainOperation =
  | "import_identifiers"
  | "delete_attachment"
  | "rename_attachment"
  | "relink_attachment"
  | "import_local_files"
  | "attach_file"
  | "attach_url"
  | "find_pdf"
  | "update_annotation";

/**
 * The regular item an attach or a find writes under, refused before anything
 * is written when it is missing, trashed, not a regular item, or in another
 * library than the chat's.
 */
function regularParent(
  itemId: number,
  context: AgentToolContext,
  zoteroGateway: ZoteroGateway,
  operationLabel: string,
): Zotero.Item {
  const item = zoteroGateway.getItem(itemId);
  if (!item) throw new MutationNoEffectError(`Item ${itemId} was not found.`);
  if (item.isRegularItem?.() !== true)
    throw new MutationNoEffectError(
      `Item ${itemId} is not a regular item; attach to the paper itself, not to a note, attachment or annotation.`,
    );
  if (item.deleted)
    throw new MutationNoEffectError(`Item ${itemId} is in the trash.`);
  assertItemInActiveLibrary(item, context, operationLabel);
  return item;
}

/**
 * Whether `path` is a regular file. A directory or a missing path is refused
 * before the write: Zotero would throw midway, which reads as "may have
 * applied".
 */
async function isRegularFile(path: string): Promise<boolean> {
  const io = (
    globalThis as {
      IOUtils?: { stat?: (path: string) => Promise<{ type?: string }> };
    }
  ).IOUtils;
  if (!io?.stat) return true;
  try {
    return (await io.stat(path)).type === "regular";
  } catch {
    return false;
  }
}

function trashCreated(ids: number[], what: string) {
  return {
    inverseOperations: [{ type: "trash_items" as const, itemIds: ids }],
    description: `Trash ${what}`,
  };
}

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
  attach_file: async (operation, context, zoteroGateway) => {
    regularParent(operation.parentItemId, context, zoteroGateway, "attach");
    if (!(await isRegularFile(operation.filePath)))
      throw new MutationNoEffectError(
        `${operation.filePath} is not a file; nothing was attached.`,
      );
    const attached = await zoteroGateway.attachFile({
      parentItemId: operation.parentItemId,
      filePath: operation.filePath,
      link: operation.link,
    });
    if (attached.status === "refused")
      throw new MutationNoEffectError(
        `${attached.reason} Nothing was attached.`,
      );
    const { attachment } = attached;
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result: {
          status: attached.status,
          parentItemId: operation.parentItemId,
          attachmentIds: [attachment.attachmentId],
          attachments: [attachment],
        },
      },
      inverse:
        attached.status === "attached"
          ? trashCreated(
              [attachment.attachmentId],
              `the attached file ${attachment.title || operation.filePath}`,
            )
          : undefined,
    };
  },
  attach_url: async (operation, context, zoteroGateway) => {
    const parent = regularParent(
      operation.parentItemId,
      context,
      zoteroGateway,
      "web page attach",
    );
    const saved = await zoteroGateway.attachUrl({
      parentItemId: operation.parentItemId,
      libraryID: parent.libraryID,
      url: operation.url,
    });
    if (saved.status === "failed")
      throw new MutationNoEffectError(
        `Zotero could not save ${operation.url}: ${saved.reason}. Nothing was attached.`,
      );
    const ids = saved.attachments.map((attachment) => attachment.attachmentId);
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result: {
          status: saved.status,
          parentItemId: operation.parentItemId,
          // Both attachments the item now has for the page; the ones it
          // already had are named again in reusedAttachmentIds.
          attachmentIds: ids,
          attachments: saved.attachments,
          reusedAttachmentIds: ids.filter(
            (id) => !saved.createdIds.includes(id),
          ),
        },
      },
      // Undo trashes only what this call made.
      inverse: saved.createdIds.length
        ? trashCreated(
            saved.createdIds,
            saved.createdIds.length === 2
              ? `the link and snapshot of ${operation.url}`
              : `the attachment saved for ${operation.url}`,
          )
        : undefined,
    };
  },
  find_pdf: async (operation, context, zoteroGateway) => {
    const item = regularParent(
      operation.itemId,
      context,
      zoteroGateway,
      "Find Available PDF",
    );
    const outcome = await zoteroGateway.findAvailablePdf(item);
    if (outcome.status === "not_found")
      return {
        result: {
          operation: operation.type,
          operationId: operation.id,
          result: {
            status: "not_found",
            itemId: operation.itemId,
            reason: outcome.reason,
          },
        },
      };
    const { attachment } = outcome;
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result: {
          status: "found",
          itemId: operation.itemId,
          attachmentIds: [attachment.attachmentId],
          attachments: [attachment],
        },
      },
      inverse: trashCreated(
        [attachment.attachmentId],
        `the found file ${attachment.title}`,
      ),
    };
  },
  update_annotation: async (operation, context, zoteroGateway) => {
    const annotation = zoteroGateway.getItem(operation.annotationId);
    if (!annotation?.isAnnotation?.())
      throw new MutationNoEffectError(
        `Item ${operation.annotationId} is not an annotation.`,
      );
    if (annotation.annotationIsExternal)
      throw new MutationNoEffectError(
        `Annotation ${operation.annotationId} is stored inside the PDF file, and Zotero keeps it read-only.`,
      );
    if (annotation.deleted)
      throw new MutationNoEffectError(
        `Annotation ${operation.annotationId} is in the trash.`,
      );
    assertItemInActiveLibrary(annotation, context, "annotation edit");
    const updated = await zoteroGateway.updateAnnotation({
      annotation,
      comment: operation.comment,
      color: operation.color,
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result: {
          status: updated.status,
          annotationId: operation.annotationId,
          annotationType: String(annotation.annotationType || ""),
          previous: updated.previous,
          comment: updated.comment,
          color: updated.color,
        },
      },
    };
  },
} satisfies Pick<ForwardExecutorRegistry, DomainOperation>;

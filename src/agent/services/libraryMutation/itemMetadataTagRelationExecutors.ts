import type { ForwardExecutorRegistry } from "./forwardExecutionContracts";
import {
  buildMetadataInverse,
  buildTagInverse,
  buildRemoveTagsInverse,
  directTagAssignments,
  assertItemInActiveLibrary,
} from "./forwardExecutionSupport";

type DomainOperation =
  | "update_metadata"
  | "apply_tags"
  | "remove_tags"
  | "set_item_tags"
  | "reparent_items"
  | "relate_items";

export const itemMetadataTagRelationExecutors = {
  update_metadata: async (operation, context, zoteroGateway) => {
    const targetItem = zoteroGateway.resolveMetadataItem({
      request: context.request,
      item: context.item,
      itemId: operation.itemId,
      paperContext: operation.paperContext,
    });
    assertItemInActiveLibrary(targetItem, context, "metadata update");
    const previousSnapshot =
      zoteroGateway.getEditableArticleMetadata(targetItem);
    const result = await zoteroGateway.updateArticleMetadata({
      item: targetItem,
      metadata: operation.metadata,
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      inverse: previousSnapshot ? buildMetadataInverse(previousSnapshot) : null,
    };
  },
  apply_tags: async (operation, context, zoteroGateway) => {
    const assignments = directTagAssignments(operation);
    if (!assignments.length) {
      throw new Error("No tag assignments were selected");
    }
    const result = await zoteroGateway.applyTagAssignments({
      assignments,
    });
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      inverse: buildTagInverse(
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
  },
  remove_tags: async (operation, context, zoteroGateway) => {
    // Counted from what the gateway actually removed. Deriving this from
    // the paper-target map meant a book (or any PDF-less item) reported
    // zero removals and recorded no undo, while the tag really was gone.
    const removed: Array<{ itemId: number; tags: string[] }> = [];
    const rows: Array<{
      itemId: number;
      status: string;
      reason?: string;
    }> = [];
    for (const itemId of operation.itemIds) {
      const outcome = await zoteroGateway.removeTagsFromItem({
        itemId,
        tags: operation.tags,
      });
      if (outcome.removed.length) {
        removed.push({ itemId, tags: outcome.removed });
        rows.push({ itemId, status: "removed" });
      } else {
        rows.push({
          itemId,
          status: "skipped",
          reason: "None of those tags were on this item",
        });
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
          items: rows,
        },
      },
      inverse: buildRemoveTagsInverse(removed),
    };
  },
  set_item_tags: async (operation, context, zoteroGateway) => {
    const result = await zoteroGateway.setItemTags({
      assignments: operation.assignments,
    });
    const changed = result.items.filter((row) => row.status === "updated");
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      // The inverse of replacing a set is the set it had before.
      inverse: changed.length
        ? {
            inverseOperations: [
              {
                type: "set_item_tags" as const,
                assignments: changed.map((row) => ({
                  itemId: row.itemId,
                  tags: row.previousTags || [],
                })),
              },
            ],
            description: `Restore the previous tags on ${changed.length} item${
              changed.length === 1 ? "" : "s"
            }`,
          }
        : null,
    };
  },
  reparent_items: async (operation, context, zoteroGateway) => {
    const result = await zoteroGateway.reparentItems({
      assignments: operation.assignments,
    });
    const moved = result.items.filter((row) => row.status === "reparented");
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      // Each item goes back to its own previous parent, which may be a
      // different item or top level; one blanket inverse cannot express
      // that.
      inverse: moved.length
        ? {
            inverseOperations: [
              {
                type: "reparent_items" as const,
                assignments: moved.map((row) => ({
                  itemId: row.itemId,
                  parentItemId: row.previousParentId ?? null,
                })),
              },
            ],
            description: `Move ${moved.length} item${
              moved.length === 1 ? "" : "s"
            } back to their previous parents`,
          }
        : null,
    };
  },
  relate_items: async (operation, context, zoteroGateway) => {
    const result = await zoteroGateway.relateItems({
      itemId: operation.itemId,
      relatedItemIds: operation.relatedItemIds,
      action: operation.action,
    });
    const affected = result.items
      .filter((row) => row.status === "related" || row.status === "unrelated")
      .map((row) => row.relatedItemId);
    const inverseAction = operation.action === "add" ? "remove" : "add";
    return {
      result: {
        operation: operation.type,
        operationId: operation.id,
        result,
      },
      inverse: affected.length
        ? {
            inverseOperations: [
              {
                type: "relate_items" as const,
                itemId: operation.itemId,
                relatedItemIds: affected,
                action: inverseAction as "add" | "remove",
              },
            ],
            description:
              operation.action === "add"
                ? `Unlink ${affected.length} related item${affected.length === 1 ? "" : "s"}`
                : `Re-link ${affected.length} related item${affected.length === 1 ? "" : "s"}`,
          }
        : null,
    };
  },
} satisfies Pick<ForwardExecutorRegistry, DomainOperation>;

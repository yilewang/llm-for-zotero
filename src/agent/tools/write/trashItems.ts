/**
 * Focused facade tool for moving Zotero items to the trash.
 * Provides a self-describing schema for trashing Zotero items.
 */
import type { AgentToolDefinition } from "../../types";
import {
  LibraryMutationService,
  type TrashItemsOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { ok, fail, validateObject, normalizePositiveIntArray } from "../shared";
import { executeAndRecordUndo } from "./mutateLibraryShared";

type TrashItemsInput = {
  operation: TrashItemsOperation;
};

export function createTrashItemsTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<TrashItemsInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "trash_items",
      description: "Move Zotero items to the trash.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["itemIds"],
        properties: {
          itemIds: {
            type: "array",
            items: { type: "number" },
            description: "Zotero item IDs to trash.",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Trash Items",
      summaries: {
        onCall: "Preparing to trash items",
        onPending: "Waiting for confirmation to trash items",
        onApproved: "Trashing items",
        onDenied: "Trash operation cancelled",
        onSuccess: ({ content }) => {
          const result =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const resultInner =
            result.result && typeof result.result === "object"
              ? (result.result as Record<string, unknown>)
              : {};
          const count = Number(
            resultInner.trashedCount || result.trashedCount || 0,
          );
          return count > 0
            ? `Trashed ${count} item${count === 1 ? "" : "s"}`
            : "Items trashed";
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          "Expected an object with itemIds. Example: { itemIds: [101, 102] }",
        );
      }

      const itemIds = normalizePositiveIntArray(args.itemIds);
      if (!itemIds?.length) {
        return fail(
          "itemIds must be a non-empty array of positive integers. " +
            "Example: { itemIds: [101, 102, 103] }",
        );
      }

      const operation: TrashItemsOperation = {
        type: "trash_items",
        itemIds,
      };

      return ok({ operation });
    },

    createPendingAction(input) {
      const operation = input.operation;
      const titles = operation.itemIds.map((id) => {
        const item = zoteroGateway.getItem(id);
        return item
          ? String(item.getField?.("title") || `Item ${id}`)
          : `Item ${id}`;
      });

      return {
        toolName: "trash_items",
        title: `Trash ${operation.itemIds.length} item${operation.itemIds.length === 1 ? "" : "s"}`,
        description: `Move ${operation.itemIds.length} item${operation.itemIds.length === 1 ? "" : "s"} to the Zotero trash. This can be undone.`,
        confirmLabel: "Trash",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "checklist" as const,
            id: "trashItemsChecklist",
            label: "Items to trash",
            items: operation.itemIds.map((id, index) => ({
              id: `${id}`,
              label: titles[index],
              checked: true,
            })),
          },
        ],
      };
    },

    applyConfirmation(input, _resolutionData) {
      // Checklist is informational; pass through unchanged
      return ok(input);
    },

    async execute(input, context) {
      return executeAndRecordUndo(
        mutationService,
        input.operation,
        context,
        "trash_items",
      );
    },
  };
}

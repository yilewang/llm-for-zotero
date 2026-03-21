/**
 * Tool for merging duplicate Zotero items.
 * Keeps one master item and merges children (attachments, notes, tags,
 * collections, related links) from duplicates into it, then trashes the rest.
 */
import type { AgentToolDefinition } from "../../types";
import {
  LibraryMutationService,
  type MergeItemsOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { ok, fail, validateObject, normalizePositiveInt, normalizePositiveIntArray } from "../shared";
import { executeAndRecordUndo } from "./mutateLibraryShared";

type MergeItemsInput = {
  operation: MergeItemsOperation;
};

export function createMergeItemsTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<MergeItemsInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "merge_items",
      description:
        "Merge duplicate Zotero items. Keeps the master item and moves all attachments, notes, tags, and collections from the other items into it, then trashes the duplicates.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["masterItemId", "otherItemIds"],
        properties: {
          masterItemId: {
            type: "number",
            description:
              "The item ID to keep as the surviving master record.",
          },
          otherItemIds: {
            type: "array",
            items: { type: "number" },
            description:
              "Item IDs of duplicates to merge into the master and then trash.",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    guidance: {
      matches: (request) =>
        /\b(merge|dedupe|dedup|duplicat|combine)\b/i.test(request.userText || ""),
      instruction:
        "To merge duplicates: first use query_library(mode:'duplicates') to find duplicate groups, then use read_library to compare metadata and decide which item is the best master, then call merge_items with the master and the others. The master keeps all children (attachments, notes, tags, collections) from the merged items.",
    },

    presentation: {
      label: "Merge Items",
      summaries: {
        onCall: "Preparing to merge duplicates",
        onPending: "Waiting for confirmation to merge items",
        onApproved: "Merging items",
        onDenied: "Merge cancelled",
        onSuccess: ({ content }) => {
          const r =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const inner =
            r.result && typeof r.result === "object"
              ? (r.result as Record<string, unknown>)
              : {};
          const count = Number(inner.mergedCount || r.mergedCount || 0);
          return count > 0
            ? `Merged ${count} duplicate${count === 1 ? "" : "s"}`
            : "Items merged";
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object with masterItemId and otherItemIds");
      }
      const masterItemId = normalizePositiveInt(args.masterItemId);
      if (!masterItemId) {
        return fail("masterItemId is required: the item ID to keep as the surviving record");
      }
      const otherItemIds = normalizePositiveIntArray(args.otherItemIds);
      if (!otherItemIds?.length) {
        return fail("otherItemIds must be a non-empty array of item IDs to merge and trash");
      }
      const operation: MergeItemsOperation = {
        type: "merge_items",
        masterItemId,
        otherItemIds,
      };
      return ok({ operation });
    },

    createPendingAction(input) {
      const { operation } = input;
      const masterItem = zoteroGateway.getItem(operation.masterItemId);
      const masterTitle = masterItem
        ? String(masterItem.getField?.("title") || `Item ${operation.masterItemId}`)
        : `Item ${operation.masterItemId}`;

      const otherTitles = operation.otherItemIds.map((id) => {
        const item = zoteroGateway.getItem(id);
        return item ? String(item.getField?.("title") || `Item ${id}`) : `Item ${id}`;
      });

      return {
        toolName: "merge_items",
        title: `Merge ${operation.otherItemIds.length + 1} items`,
        description: `Keep "${masterTitle}" as the master and merge ${operation.otherItemIds.length} duplicate${operation.otherItemIds.length === 1 ? "" : "s"} into it. Attachments, notes, tags, and collections will be moved to the master. Duplicates will be trashed.`,
        confirmLabel: "Merge",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text" as const,
            id: "masterInfo",
            label: "Master (kept)",
            value: masterTitle,
          },
          {
            type: "checklist" as const,
            id: "duplicatesChecklist",
            label: "Duplicates to merge & trash",
            items: operation.otherItemIds.map((id, i) => ({
              id: `${id}`,
              label: otherTitles[i],
              checked: true,
            })),
          },
        ],
      };
    },

    applyConfirmation(input, _resolutionData) {
      return ok(input);
    },

    async execute(input, context) {
      return executeAndRecordUndo(
        mutationService,
        input.operation,
        context,
        "merge_items",
      );
    },
  };
}

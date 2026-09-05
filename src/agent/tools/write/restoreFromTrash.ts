/**
 * Focused facade tool for bringing objects back out of the Zotero trash.
 *
 * Restoring used to be reachable only as the inverse of a mutation the agent
 * had just performed, so anything the user trashed themselves — or anything
 * trashed in an earlier session — could not be recovered by asking.
 */
import type { AgentWriteToolDefinition } from "../../types";
import {
  LibraryMutationService,
  type RestoreFromTrashOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { ok, fail, validateObject, normalizePositiveIntArray } from "../shared";
import {
  executeAndRecordUndo,
  planLibraryMutations,
} from "./mutateLibraryShared";

type RestoreFromTrashInput = {
  operation: RestoreFromTrashOperation;
};

function describeTargets(operation: RestoreFromTrashOperation): string {
  const parts: string[] = [];
  const items = operation.itemIds?.length ?? 0;
  const collections = operation.collectionIds?.length ?? 0;
  const searches = operation.savedSearchIds?.length ?? 0;
  if (items) parts.push(`${items} item${items === 1 ? "" : "s"}`);
  if (collections) {
    parts.push(`${collections} collection${collections === 1 ? "" : "s"}`);
  }
  if (searches) {
    parts.push(`${searches} saved search${searches === 1 ? "" : "es"}`);
  }
  return parts.join(" and ");
}

export function createRestoreFromTrashTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<RestoreFromTrashInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "restore_from_trash",
      description:
        "Restore trashed Zotero items, collections, or saved searches back into the library.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          itemIds: {
            type: "array",
            items: { type: "number" },
            description: "Trashed Zotero item IDs to restore.",
          },
          collectionIds: {
            type: "array",
            items: { type: "number" },
            description:
              "Trashed collection IDs to restore. Subcollections are restored with their parent.",
          },
          savedSearchIds: {
            type: "array",
            items: { type: "number" },
            description: "Trashed saved search IDs to restore.",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Restore From Trash",
      summaries: {
        onCall: "Preparing to restore from trash",
        onPending: "Waiting for confirmation to restore from trash",
        onApproved: "Restoring from trash",
        onDenied: "Restore cancelled",
        onSuccess: ({ content }) => {
          const result =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const inner =
            result.result && typeof result.result === "object"
              ? (result.result as Record<string, unknown>)
              : {};
          const count = Number(
            inner.restoredCount || result.restoredCount || 0,
          );
          return count > 0
            ? `Restored ${count} object${count === 1 ? "" : "s"} from the trash`
            : "Nothing needed restoring";
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          "Expected an object with itemIds, collectionIds, or savedSearchIds. " +
            "Example: { itemIds: [101, 102] }",
        );
      }

      const itemIds = normalizePositiveIntArray(args.itemIds) || [];
      const collectionIds = normalizePositiveIntArray(args.collectionIds) || [];
      const savedSearchIds =
        normalizePositiveIntArray(args.savedSearchIds) || [];

      if (!itemIds.length && !collectionIds.length && !savedSearchIds.length) {
        return fail(
          "Provide at least one of itemIds, collectionIds, or savedSearchIds as a " +
            "non-empty array of positive integers. Example: { collectionIds: [42] }",
        );
      }

      const operation: RestoreFromTrashOperation = {
        type: "restore_from_trash",
        itemIds,
        collectionIds,
        savedSearchIds,
      };

      return ok({ operation });
    },

    createPendingAction(input) {
      const operation = input.operation;
      const summary = describeTargets(operation);
      const description = `Restore ${summary} from the Zotero trash back into the library.`;

      return {
        toolName: "restore_from_trash",
        title: `Restore ${summary}`,
        description,
        confirmLabel: "Restore",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text" as const,
            id: "description",
            label: "Action",
            value: description,
          },
        ],
      };
    },

    applyConfirmation(input, _resolutionData) {
      // Text fields are read-only; pass through unchanged.
      return ok(input);
    },

    planMutation: (input, context) =>
      planLibraryMutations(mutationService, [input.operation], context),

    async execute(input, context) {
      return executeAndRecordUndo(
        mutationService,
        input.operation,
        context,
        "restore_from_trash",
      );
    },
  };
}

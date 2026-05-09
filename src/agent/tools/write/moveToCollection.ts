import type { AgentToolDefinition } from "../../types";
import {
  LibraryMutationService,
  type MoveToCollectionOperation,
  type RemoveFromCollectionOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  ok,
  fail,
  validateObject,
  normalizePositiveInt,
  normalizePositiveIntArray,
} from "../shared";
import {
  buildMoveAssignmentField,
  normalizeMoveAssignmentsFromResolution,
  getMoveAssignmentFieldId,
  executeAndRecordUndo,
} from "./mutateLibraryShared";

type MoveToCollectionInput = {
  action: "add" | "remove";
  operation: MoveToCollectionOperation | RemoveFromCollectionOperation;
};

export function createMoveToCollectionTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<MoveToCollectionInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "move_to_collection",
      description: "Add or remove Zotero papers from collections (folders).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: ["add", "remove"],
            default: "add",
            description:
              "Whether to add items to or remove items from a collection.",
          },
          itemIds: {
            type: "array",
            items: { type: "number" },
            description: "Array of Zotero item IDs to move.",
          },
          targetCollectionId: {
            type: "number",
            description: "Target collection ID.",
          },
          targetCollectionName: {
            type: "string",
            description:
              "Target collection name (resolved via the confirmation card).",
          },
          collectionId: {
            type: "number",
            description:
              "Collection ID to remove items from (for action 'remove').",
          },
          assignments: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                itemId: { type: "number" },
                targetCollectionId: { type: "number" },
                targetCollectionName: { type: "string" },
              },
              required: ["itemId"],
            },
            description:
              "Per-item collection assignments. Alternative to itemIds + targetCollectionId.",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Move to Collection",
      summaries: {
        onCall: "Preparing collection changes",
        onPending: "Waiting for confirmation on collection changes",
        onApproved: "Applying collection changes",
        onDenied: "Collection changes cancelled",
        onSuccess: "Collection updated",
      },
    },

    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          "Expected an object with action, itemIds, and collection details.",
        );
      }

      const action =
        args.action === "remove" ? "remove" : ("add" as "add" | "remove");

      if (action === "remove") {
        const itemIds = normalizePositiveIntArray(args.itemIds);
        const collectionId = normalizePositiveInt(args.collectionId);
        if (!itemIds?.length) {
          return fail(
            'action "remove" requires itemIds. Example: { action: "remove", itemIds: [101, 102], collectionId: 5 }',
          );
        }
        if (!collectionId) {
          return fail(
            'action "remove" requires collectionId. Example: { action: "remove", itemIds: [101], collectionId: 5 }',
          );
        }
        const operation: RemoveFromCollectionOperation = {
          type: "remove_from_collection",
          itemIds,
          collectionId,
        };
        return ok({ action, operation });
      }

      // action === "add"
      const assignments = normalizeAssignmentsFromArgs(args);
      const itemIds = normalizePositiveIntArray(args.itemIds);
      if (!assignments?.length && !itemIds?.length) {
        return fail(
          'action "add" requires itemIds or assignments. Example: { action: "add", itemIds: [101, 102], targetCollectionName: "My Folder" }',
        );
      }

      const targetCollectionId = normalizePositiveInt(args.targetCollectionId);
      const targetCollectionName =
        typeof args.targetCollectionName === "string" &&
        args.targetCollectionName.trim()
          ? args.targetCollectionName.trim()
          : undefined;

      const operation: MoveToCollectionOperation = {
        type: "move_to_collection",
        assignments: assignments?.length ? assignments : undefined,
        itemIds: itemIds || undefined,
        targetCollectionId,
        targetCollectionName,
      };
      return ok({ action, operation });
    },

    createPendingAction: (input, context) => {
      if (input.action === "remove") {
        const op = input.operation as RemoveFromCollectionOperation;
        const collection = zoteroGateway.getCollectionSummary(op.collectionId);
        const collectionLabel = collection
          ? collection.path || collection.name
          : `collection ${op.collectionId}`;
        return {
          toolName: "move_to_collection",
          mode: "approval",
          title: "Remove from collection",
          description: `Remove ${op.itemIds.length} item${op.itemIds.length === 1 ? "" : "s"} from "${collectionLabel}".`,
          confirmLabel: "Remove",
          cancelLabel: "Cancel",
          fields: [],
        };
      }

      // action === "add"
      const op = input.operation as MoveToCollectionOperation;
      const field = buildMoveAssignmentField(op, zoteroGateway, context);
      if (!field) {
        return {
          toolName: "move_to_collection",
          mode: "approval",
          title: "Add to collection",
          description: "No items or collections available for assignment.",
          confirmLabel: "Confirm",
          cancelLabel: "Cancel",
          fields: [],
        };
      }
      return {
        toolName: "move_to_collection",
        mode: "review",
        title: "Add to collection",
        description: "Select the destination collection for each paper.",
        confirmLabel: "Move",
        cancelLabel: "Cancel",
        fields: [field],
      };
    },

    applyConfirmation: (input, resolutionData) => {
      if (input.action === "remove") {
        return ok(input);
      }

      // action === "add"
      const op = input.operation as MoveToCollectionOperation;
      const fieldId = getMoveAssignmentFieldId(op);
      const fieldData =
        validateObject<Record<string, unknown>>(resolutionData) &&
        Array.isArray((resolutionData as Record<string, unknown>)[fieldId])
          ? (resolutionData as Record<string, unknown>)[fieldId]
          : resolutionData;

      const resolved = normalizeMoveAssignmentsFromResolution(fieldData);
      if (!resolved?.length) {
        return fail("No collection assignments were selected.");
      }

      const updatedOperation: MoveToCollectionOperation = {
        ...op,
        assignments: resolved.map((entry) => ({
          itemId: entry.itemId,
          targetCollectionId: entry.targetCollectionId,
        })),
      };
      return ok({ action: input.action, operation: updatedOperation });
    },

    execute: async (input, context) => {
      return executeAndRecordUndo(
        mutationService,
        input.operation,
        context,
        "move_to_collection",
      );
    },
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function normalizeAssignmentsFromArgs(args: Record<string, unknown>): Array<{
  itemId: number;
  targetCollectionId?: number;
  targetCollectionName?: string;
}> | null {
  if (!Array.isArray(args.assignments)) return null;
  const entries: Array<{
    itemId: number;
    targetCollectionId?: number;
    targetCollectionName?: string;
  }> = [];
  for (const entry of args.assignments) {
    if (!validateObject<Record<string, unknown>>(entry)) continue;
    const itemId = normalizePositiveInt(entry.itemId);
    if (!itemId) continue;
    entries.push({
      itemId,
      targetCollectionId: normalizePositiveInt(entry.targetCollectionId),
      targetCollectionName:
        typeof entry.targetCollectionName === "string" &&
        entry.targetCollectionName.trim()
          ? entry.targetCollectionName.trim()
          : undefined,
    });
  }
  return entries.length ? entries : null;
}

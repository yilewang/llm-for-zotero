import type { AgentWriteToolDefinition } from "../../types";
import {
  buildPagedReviewActionConfig,
  buildPageSizeSelectField,
  readPagedOperationLabel,
  readPagedOperationMeta,
} from "../../actions/pagedWorkflow";
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
  planLibraryMutations,
} from "./mutateLibraryShared";

type MoveToCollectionInput = {
  action: "add" | "remove";
  operation: MoveToCollectionOperation | RemoveFromCollectionOperation;
};

export function createMoveToCollectionTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<MoveToCollectionInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "move_to_collection",
      description:
        "Add, move, or remove Zotero papers from collections (folders). action:'add' with mode:'move' performs a real move; the default adds, leaving the item in its existing collections as well.",
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
          id: {
            type: "string",
            description:
              "Optional operation ID used by native action workflows.",
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
          mode: {
            type: "string",
            enum: ["add", "move"],
            default: "add",
            description:
              "For action 'add'. 'add' files the item and leaves its other collections untouched. 'move' also removes it from 'from', so it ends up filed only where the user asked.",
          },
          from: {
            description:
              "Required when mode is 'move': the collection ID to take the items out of, or 'all' to replace their collection membership entirely.",
            anyOf: [{ type: "number" }, { type: "string", enum: ["all"] }],
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
        onSuccess: ({ effect }) =>
          effect === "none"
            ? "No papers changed"
            : effect === "partial"
              ? "Some papers filed"
              : "Collection updated",
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
      const id =
        typeof args.id === "string" && args.id.trim()
          ? args.id.trim()
          : undefined;

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
          id,
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

      const mode = args.mode === "move" ? "move" : undefined;
      const from =
        args.from === "all"
          ? ("all" as const)
          : normalizePositiveInt(args.from) || undefined;
      if (mode === "move" && from === undefined) {
        return fail(
          'mode "move" requires from: pass from:<collectionId> to take the items out of one collection, or from:"all" to replace their collection membership entirely. ' +
            'Example: { action: "add", mode: "move", from: 12, itemIds: [101], targetCollectionId: 34 }',
        );
      }

      const operation: MoveToCollectionOperation = {
        id,
        type: "move_to_collection",
        assignments: assignments?.length ? assignments : undefined,
        itemIds: itemIds || undefined,
        targetCollectionId,
        targetCollectionName,
        mode,
        from,
      };
      return ok({ action, operation });
    },

    createPendingAction: (input, context) => {
      if (input.action === "remove") {
        const op = input.operation as RemoveFromCollectionOperation;
        const pageMeta = readPagedOperationMeta(op.id);
        const pageLabel = readPagedOperationLabel(op.id);
        const collection = zoteroGateway.getCollectionSummary(op.collectionId);
        const collectionLabel = collection
          ? collection.path || collection.name
          : `collection ${op.collectionId}`;
        return {
          toolName: "move_to_collection",
          mode: "approval",
          title: `${pageLabel ? `${pageLabel}: ` : ""}Remove from collection`,
          description: `Remove ${op.itemIds.length} item${op.itemIds.length === 1 ? "" : "s"} from "${collectionLabel}".`,
          confirmLabel: "Remove",
          cancelLabel: pageLabel ? "Stop" : "Cancel",
          fields: pageMeta ? [buildPageSizeSelectField(pageMeta.pageSize)] : [],
          ...(pageMeta
            ? buildPagedReviewActionConfig(pageMeta, { includeRefresh: true })
            : {}),
        };
      }

      // action === "add"
      const op = input.operation as MoveToCollectionOperation;
      const pageMeta = readPagedOperationMeta(op.id);
      const pageLabel = readPagedOperationLabel(op.id);
      // The card used to be titled "Add to collection" with a "Move" button,
      // while the code only ever added. Say which one is actually happening.
      const isMove = op.mode === "move";
      const sourceLabel =
        op.from === "all"
          ? "every collection they are currently in"
          : (() => {
              const source =
                typeof op.from === "number"
                  ? zoteroGateway.getCollectionSummary(op.from)
                  : null;
              return source
                ? `"${source.path || source.name}"`
                : `collection ${op.from}`;
            })();
      const cardTitle = isMove ? "Move to collection" : "Add to collection";
      const field = buildMoveAssignmentField(op, zoteroGateway, context);
      if (!field) {
        return {
          toolName: "move_to_collection",
          mode: "approval",
          title: `${pageLabel ? `${pageLabel}: ` : ""}${cardTitle}`,
          description: "No items or collections available for assignment.",
          confirmLabel: "Confirm",
          cancelLabel: pageLabel ? "Stop" : "Cancel",
          fields: pageMeta ? [buildPageSizeSelectField(pageMeta.pageSize)] : [],
          ...(pageMeta
            ? buildPagedReviewActionConfig(pageMeta, { includeRefresh: true })
            : {}),
        };
      }
      return {
        toolName: "move_to_collection",
        mode: "review",
        title: `${pageLabel ? `${pageLabel}: ` : ""}${cardTitle}`,
        description: isMove
          ? `Select the destination collection for each paper. Each paper will also be removed from ${sourceLabel}.`
          : "Select the destination collection for each paper. They will stay in any collections they are already in.",
        confirmLabel: isMove ? "Move" : "Add",
        cancelLabel: pageLabel ? "Stop" : "Cancel",
        fields: [
          field,
          ...(pageMeta ? [buildPageSizeSelectField(pageMeta.pageSize)] : []),
        ],
        ...(pageMeta
          ? buildPagedReviewActionConfig(pageMeta, { includeRefresh: true })
          : {}),
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

    planMutation: (input, context) =>
      planLibraryMutations(mutationService, [input.operation], context),

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

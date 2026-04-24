/**
 * Focused facade tool for adding and removing tags on Zotero papers.
 * Provides a self-describing schema for managing Zotero tags.
 */
import type { AgentToolDefinition } from "../../types";
import {
  LibraryMutationService,
  type ApplyTagsOperation,
  type RemoveTagsOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  ok,
  fail,
  validateObject,
  normalizePositiveIntArray,
  normalizeStringArray,
} from "../shared";
import {
  buildTagAssignmentField,
  normalizeTagAssignmentsFromResolution,
  getTagAssignmentFieldId,
  executeAndRecordUndo,
} from "./mutateLibraryShared";

type ApplyTagsInput = {
  action: "add" | "remove";
  operation: ApplyTagsOperation | RemoveTagsOperation;
};

export function createApplyTagsTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<ApplyTagsInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "apply_tags",
      description: "Add or remove tags on one or more Zotero papers.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "remove"],
            description: "Whether to add or remove tags. Defaults to 'add'.",
          },
          itemIds: {
            type: "array",
            items: { type: "number" },
            description: "Zotero item IDs.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags to add or remove.",
          },
          assignments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                itemId: { type: "number" },
                tags: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["itemId", "tags"],
              additionalProperties: false,
            },
            description:
              "Per-item tag assignments (when different items get different tags). Only used with action 'add'.",
          },
        },
        additionalProperties: false,
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    guidance: {
      matches: () => true,
      instruction:
        "For library write operations, the confirmation card is the deliverable — call the tool directly instead of stopping with a prose summary.",
    },

    presentation: {
      label: "Apply Tags",
      summaries: {
        onCall: "Preparing tag changes",
        onPending: "Waiting for confirmation on tag changes",
        onApproved: "Applying tag changes",
        onDenied: "Tag changes cancelled",
        onSuccess: "Tags updated",
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }

      const action: "add" | "remove" =
        args.action === "remove" ? "remove" : "add";

      if (action === "remove") {
        const itemIds = normalizePositiveIntArray(args.itemIds);
        if (!itemIds) {
          return fail(
            "itemIds is required: provide an array of Zotero item IDs, e.g. { itemIds: [123], tags: ['geometry'] }",
          );
        }
        const tags = normalizeStringArray(args.tags);
        if (!tags) {
          return fail(
            "tags is required: provide a non-empty array of tag strings, e.g. ['machine learning', 'vision']",
          );
        }
        const operation: RemoveTagsOperation = {
          type: "remove_tags",
          itemIds,
          tags,
        };
        return ok({ action, operation });
      }

      // action === "add"
      // Accept either (itemIds + tags) for uniform tagging, or assignments for per-item tagging.
      if (Array.isArray(args.assignments) && args.assignments.length > 0) {
        const assignments: Array<{ itemId: number; tags: string[] }> = [];
        for (const entry of args.assignments) {
          if (!validateObject<Record<string, unknown>>(entry)) {
            return fail(
              "Each assignment must be an object with { itemId: number, tags: string[] }",
            );
          }
          const itemId = Number(entry.itemId);
          if (!Number.isFinite(itemId) || itemId <= 0) {
            return fail(
              "Each assignment must include a valid positive itemId",
            );
          }
          if (!Array.isArray(entry.tags)) {
            return fail(
              "Each assignment must include a tags array",
            );
          }
          assignments.push({
            itemId: Math.floor(itemId),
            tags: normalizeStringArray(entry.tags) || [],
          });
        }
        const operation: ApplyTagsOperation = {
          type: "apply_tags",
          assignments,
        };
        return ok({ action, operation });
      }

      const itemIds = normalizePositiveIntArray(args.itemIds);
      const tags = normalizeStringArray(args.tags);
      if (itemIds && tags) {
        const operation: ApplyTagsOperation = {
          type: "apply_tags",
          itemIds,
          tags,
        };
        return ok({ action, operation });
      }

      return fail(
        "Provide either (itemIds + tags) for uniform tagging or assignments for per-item tagging, " +
          "e.g. { itemIds: [1, 2], tags: ['ml'] } or { assignments: [{ itemId: 1, tags: ['ml'] }] }",
      );
    },

    createPendingAction(input, context) {
      if (input.action === "add") {
        const operation = input.operation as ApplyTagsOperation;
        const tagField = buildTagAssignmentField(operation, zoteroGateway);
        const fields = tagField ? [tagField] : [];

        const assignments = operation.assignments || [];
        const itemCount =
          assignments.length || operation.itemIds?.length || 0;
        const tagSummary = operation.tags?.length
          ? `Tags to add: ${operation.tags.join(", ")}`
          : "Review the suggested per-paper tag additions.";

        return {
          toolName: "apply_tags",
          title: `Add tags to ${itemCount} paper${itemCount === 1 ? "" : "s"}`,
          confirmLabel: "Apply",
          cancelLabel: "Cancel",
          description: tagSummary,
          fields,
        };
      }

      // action === "remove"
      const operation = input.operation as RemoveTagsOperation;
      const targets = zoteroGateway.getPaperTargetsByItemIds(
        operation.itemIds,
      );
      const targetByItemId = new Map(
        targets.map((target) => [target.itemId, target] as const),
      );

      const checklistItems = operation.itemIds.map((itemId) => {
        const target = targetByItemId.get(itemId);
        const title = target?.title || `Item ${itemId}`;
        return {
          id: `${itemId}`,
          label: title,
          description: `Remove: ${operation.tags.join(", ")}`,
          checked: true,
        };
      });

      return {
        toolName: "apply_tags",
        title: `Remove tags from ${operation.itemIds.length} paper${
          operation.itemIds.length === 1 ? "" : "s"
        }`,
        confirmLabel: "Remove",
        cancelLabel: "Cancel",
        description: `Tags to remove: ${operation.tags.join(", ")}`,
        fields: [
          {
            type: "checklist",
            id: "removeTagsChecklist",
            label: "Papers",
            items: checklistItems,
          },
        ],
      };
    },

    applyConfirmation(input, resolutionData) {
      if (input.action === "add") {
        const operation = input.operation as ApplyTagsOperation;
        const fieldId = getTagAssignmentFieldId(operation);
        const data = resolutionData as Record<string, unknown> | undefined;
        const resolved = data?.[fieldId];

        if (resolved !== undefined) {
          const assignments =
            normalizeTagAssignmentsFromResolution(resolved);
          if (assignments && assignments.length > 0) {
            const updatedOperation: ApplyTagsOperation = {
              ...operation,
              assignments,
              // Clear flat fields since assignments take precedence
              itemIds: undefined,
              tags: undefined,
            };
            return ok({ action: input.action, operation: updatedOperation });
          }
          // Resolution was submitted but every row was empty. Without this
          // explicit fail, execute() would throw and the error would be
          // swallowed into a silent "0 items tagged" result.
          return fail(
            "No tags were entered for any paper. Add at least one tag per paper you want to update, or cancel the operation.",
          );
        }

        // No resolution data (auto_approve / non-HITL path). Validate the
        // original operation has something to apply so we don't silently
        // pass through an empty request.
        const hasNonEmptyAssignments = operation.assignments?.some(
          (entry) => Array.isArray(entry.tags) && entry.tags.length > 0,
        );
        const hasFlatOp =
          (operation.itemIds?.length ?? 0) > 0 &&
          (operation.tags?.length ?? 0) > 0;
        if (!hasNonEmptyAssignments && !hasFlatOp) {
          return fail(
            "No tags to apply. Provide either (itemIds + tags) or assignments with non-empty tag arrays.",
          );
        }
        return ok(input);
      }

      // action === "remove" — no editable fields, pass through
      return ok(input);
    },

    async execute(input, context) {
      return executeAndRecordUndo(
        mutationService,
        input.operation,
        context,
        "apply_tags",
      );
    },
  };
}

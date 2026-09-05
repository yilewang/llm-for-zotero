/**
 * The tag as an object, and exact tag sets.
 *
 * The existing tag path only put tags on items or took them off. A *tag* —
 * the thing in Zotero's tag selector — could not be renamed, merged, deleted
 * or coloured, so fixing a typo in a tag used by 500 papers meant 500
 * removals and 500 additions. And because assignment was add-only, "give my
 * library exactly these 20 tags" drifted: each batch added its own and
 * nothing removed a previous batch's choices.
 */
import type { AgentWriteToolDefinition } from "../../types";
import {
  LibraryMutationService,
  type SetItemTagsOperation,
  type UpdateLibraryTagOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";
import {
  executeAndRecordUndo,
  planLibraryMutations,
} from "./mutateLibraryShared";

export function createUpdateLibraryTagTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<{ operation: UpdateLibraryTagOperation }, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "tag_update",
      description:
        "Rename, merge, delete or colour a tag across the whole library. This operates on the tag itself, not on any item's tags — use library_update kind:'tags' for that.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["action", "tag"],
        properties: {
          action: {
            type: "string",
            enum: ["rename", "merge", "delete", "setColor"],
            description:
              "'rename' changes the tag everywhere it is used; 'merge' does the same into a tag that already exists; 'delete' removes it from every item; 'setColor' assigns one of Zotero's coloured tag slots.",
          },
          tag: { type: "string", description: "The existing tag name." },
          newTag: {
            type: "string",
            description: "The new name, for 'rename' and 'merge'.",
          },
          color: {
            type: "string",
            description: "Hex colour for 'setColor', e.g. '#FF6666'.",
          },
          position: {
            type: "number",
            description:
              "Coloured-tag slot for 'setColor', starting at 0. Zotero binds these to number keys.",
          },
          libraryID: { type: "number" },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Update Tag",
      summaries: {
        onCall: "Preparing tag change",
        onPending: "Waiting for confirmation on tag change",
        onApproved: "Updating tag",
        onDenied: "Tag change cancelled",
        onSuccess: "Tag updated",
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          'Expected an object with action and tag. Example: { action: "rename", tag: "ML", newTag: "machine learning" }',
        );
      }
      const action = args.action;
      if (
        action !== "rename" &&
        action !== "merge" &&
        action !== "delete" &&
        action !== "setColor"
      ) {
        return fail("action must be one of: rename, merge, delete, setColor");
      }
      const tag = typeof args.tag === "string" ? args.tag.trim() : "";
      if (!tag) return fail("tag is required.");
      const newTag =
        typeof args.newTag === "string" ? args.newTag.trim() : undefined;
      if ((action === "rename" || action === "merge") && !newTag) {
        return fail(`action "${action}" requires newTag.`);
      }
      if (action === "setColor" && typeof args.color !== "string") {
        return fail(
          'action "setColor" requires a color, e.g. { action: "setColor", tag: "urgent", color: "#FF6666" }',
        );
      }
      return ok({
        operation: {
          type: "update_library_tag" as const,
          action,
          tag,
          newTag,
          color: typeof args.color === "string" ? args.color.trim() : undefined,
          position: normalizePositiveInt(args.position) ?? 0,
          libraryID: normalizePositiveInt(args.libraryID),
        },
      });
    },

    createPendingAction(input) {
      const op = input.operation;
      const description =
        op.action === "delete"
          ? `Remove the tag "${op.tag}" from every item in your library. This cannot be undone — which items carried it is not recorded anywhere.`
          : op.action === "setColor"
            ? `Give the tag "${op.tag}" the colour ${op.color}.`
            : `Rename the tag "${op.tag}" to "${op.newTag}" everywhere it is used.${
                op.action === "merge"
                  ? " Items already carrying the destination tag keep it once."
                  : ""
              }`;
      return {
        toolName: "tag_update",
        title:
          op.action === "delete"
            ? `Delete tag "${op.tag}"`
            : op.action === "setColor"
              ? `Colour tag "${op.tag}"`
              : `Rename tag "${op.tag}"`,
        description,
        confirmLabel: op.action === "delete" ? "Delete" : "Apply",
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

    applyConfirmation(input) {
      return ok(input);
    },

    planMutation: (input, context) =>
      planLibraryMutations(mutationService, [input.operation], context),

    async execute(input, context) {
      return executeAndRecordUndo(
        mutationService,
        input.operation,
        context,
        "tag_update",
      );
    },
  };
}

export function createSetItemTagsTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<{ operation: SetItemTagsOperation }, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "set_item_tags",
      description:
        "Replace each item's tags with exactly the tags given. Use this when the user wants a definite set — 'tag everything with exactly these twenty' — because adding is cumulative and drifts across batches.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["assignments"],
        properties: {
          assignments: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["itemId", "tags"],
              properties: {
                itemId: { type: "number" },
                tags: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "The complete tag list for this item. Any tag not listed is removed.",
                },
              },
            },
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Set Item Tags",
      summaries: {
        onCall: "Preparing tag assignments",
        onPending: "Waiting for confirmation on tag assignments",
        onApproved: "Setting tags",
        onDenied: "Tag assignment cancelled",
        onSuccess: "Tags set",
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          'Expected an object with assignments. Example: { assignments: [{ itemId: 101, tags: ["memory", "review"] }] }',
        );
      }
      if (!Array.isArray(args.assignments) || !args.assignments.length) {
        return fail("assignments must be a non-empty array.");
      }
      const assignments: SetItemTagsOperation["assignments"] = [];
      for (const raw of args.assignments) {
        if (!validateObject<Record<string, unknown>>(raw)) continue;
        const itemId = normalizePositiveInt(raw.itemId);
        if (!itemId || !Array.isArray(raw.tags)) continue;
        assignments.push({
          itemId,
          tags: raw.tags
            .filter((tag): tag is string => typeof tag === "string")
            .map((tag) => tag.trim())
            .filter(Boolean),
        });
      }
      if (!assignments.length) {
        return fail("No valid assignments were provided.");
      }
      return ok({ operation: { type: "set_item_tags" as const, assignments } });
    },

    createPendingAction(input) {
      const assignments = input.operation.assignments;
      const lines = assignments.slice(0, 40).map((entry) => {
        const item = zoteroGateway.getItem(entry.itemId);
        const title = item
          ? String(item.getDisplayTitle?.() || `Item ${entry.itemId}`)
          : `Item ${entry.itemId}`;
        return `${title} → ${entry.tags.join(", ") || "(no tags)"}`;
      });
      if (assignments.length > lines.length) {
        lines.push(`… and ${assignments.length - lines.length} more`);
      }
      return {
        toolName: "set_item_tags",
        title: `Set tags on ${assignments.length} item${assignments.length === 1 ? "" : "s"}`,
        description: `Replace the tags on ${assignments.length} item${assignments.length === 1 ? "" : "s"} with exactly the tags listed. Any tag not listed is removed. This can be undone.`,
        confirmLabel: "Set tags",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text" as const,
            id: "description",
            label: "Assignments",
            value: lines.join("\n"),
          },
        ],
      };
    },

    applyConfirmation(input) {
      return ok(input);
    },

    planMutation: (input, context) =>
      planLibraryMutations(mutationService, [input.operation], context),

    async execute(input, context) {
      return executeAndRecordUndo(
        mutationService,
        input.operation,
        context,
        "set_item_tags",
      );
    },
  };
}

/**
 * Saved searches.
 *
 * These were entirely invisible: the capability matrix declared CRUD allowed,
 * nothing implemented any of it, and no query path enumerated them. A saved
 * search *is* a set of conditions, which is why this had to wait for the
 * condition vocabulary — before that there was nothing to save.
 */
import type { AgentWriteToolDefinition } from "../../types";
import {
  LibraryMutationService,
  type DeleteSavedSearchOperation,
  type SaveSavedSearchOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";
import {
  executeAndRecordUndo,
  planLibraryMutations,
} from "./mutateLibraryShared";

type SavedSearchInput = {
  operation: SaveSavedSearchOperation | DeleteSavedSearchOperation;
};

export function createSavedSearchTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<SavedSearchInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "saved_search_update",
      description:
        "Create, replace or delete a Zotero saved search. A saved search is a named condition set that stays live as the library changes — use library_search({ entity:'savedSearches', mode:'list' }) to see the existing ones.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: {
            type: "string",
            enum: ["save", "delete"],
            description:
              "'save' creates a new saved search, or replaces the conditions of one named by savedSearchId. 'delete' trashes it.",
          },
          name: {
            type: "string",
            description: "The saved search name, for action 'save'.",
          },
          conditions: {
            type: "array",
            description:
              "The conditions to save, in the same shape library_search takes.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["condition", "operator"],
              properties: {
                condition: { type: "string" },
                operator: { type: "string" },
                value: { anyOf: [{ type: "string" }, { type: "number" }] },
                mode: { type: "string" },
                required: { type: "boolean" },
              },
            },
          },
          joinMode: { type: "string", enum: ["all", "any"] },
          savedSearchId: {
            type: "number",
            description:
              "For 'save', the saved search to replace; for 'delete', the one to remove.",
          },
          permanent: {
            type: "boolean",
            description:
              "For 'delete': erase instead of trashing. Cannot be undone.",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Saved Search",
      summaries: {
        onCall: "Preparing saved search",
        onPending: "Waiting for confirmation on saved search",
        onApproved: "Updating saved search",
        onDenied: "Saved search change cancelled",
        onSuccess: "Saved search updated",
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          'Expected an object with action. Example: { action: "save", name: "Unread 2024", conditions: [{ condition: "dateAdded", operator: "isAfter", value: "2024" }] }',
        );
      }
      if (args.action === "delete") {
        const savedSearchId = normalizePositiveInt(args.savedSearchId);
        if (!savedSearchId) {
          return fail(
            'action "delete" requires a savedSearchId. List them with library_search({ entity:"savedSearches", mode:"list" }).',
          );
        }
        return ok({
          operation: {
            type: "delete_saved_search" as const,
            savedSearchId,
            permanent: args.permanent === true,
          },
        });
      }
      if (args.action !== "save") {
        return fail('action must be "save" or "delete".');
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return fail('action "save" requires a name.');
      if (!Array.isArray(args.conditions) || !args.conditions.length) {
        return fail(
          'action "save" requires a non-empty conditions array. Example: [{ condition: "tag", operator: "is", value: "to-read" }]',
        );
      }
      const conditions: SaveSavedSearchOperation["conditions"] = [];
      for (const raw of args.conditions) {
        if (!validateObject<Record<string, unknown>>(raw)) continue;
        const condition =
          typeof raw.condition === "string" ? raw.condition.trim() : "";
        const operator =
          typeof raw.operator === "string" ? raw.operator.trim() : "";
        if (!condition || !operator) continue;
        conditions.push({
          condition,
          operator,
          value:
            typeof raw.value === "string" || typeof raw.value === "number"
              ? raw.value
              : undefined,
          mode: typeof raw.mode === "string" ? raw.mode.trim() : undefined,
          required: raw.required === true ? true : undefined,
        });
      }
      if (!conditions.length) {
        return fail("Every condition needs a condition name and an operator.");
      }
      return ok({
        operation: {
          type: "save_saved_search" as const,
          name,
          conditions,
          joinMode:
            args.joinMode === "any" || args.joinMode === "all"
              ? args.joinMode
              : undefined,
          savedSearchId: normalizePositiveInt(args.savedSearchId),
          libraryID: normalizePositiveInt(args.libraryID),
        },
      });
    },

    createPendingAction(input) {
      const op = input.operation;
      if (op.type === "delete_saved_search") {
        const description = op.permanent
          ? `Permanently erase saved search ${op.savedSearchId}. This cannot be undone.`
          : `Move saved search ${op.savedSearchId} to the trash. Items it matched are not affected.`;
        return {
          toolName: "saved_search_update",
          title: "Delete saved search",
          description,
          confirmLabel: op.permanent ? "Erase permanently" : "Delete",
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
      }
      const clauses = op.conditions
        .map((c) => `${c.condition} ${c.operator} ${c.value ?? ""}`.trim())
        .join(op.joinMode === "any" ? "\n  OR " : "\n  AND ");
      const description = `${op.savedSearchId ? "Replace" : "Create"} the saved search "${op.name}" with:\n  ${clauses}`;
      return {
        toolName: "saved_search_update",
        title: op.savedSearchId
          ? `Update saved search "${op.name}"`
          : `Create saved search "${op.name}"`,
        description,
        confirmLabel: "Save",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text" as const,
            id: "description",
            label: "Conditions",
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
        "saved_search_update",
      );
    },
  };
}

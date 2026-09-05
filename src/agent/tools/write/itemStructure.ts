/**
 * Creating items, moving them between parents, and linking them as related.
 *
 * All three were declared allowed by the capability matrix and implemented by
 * nothing, so ordinary requests — "add this book by hand", "move that note
 * onto the paper", "link these two" — had no path but a raw script.
 */
import type { AgentWriteToolDefinition } from "../../types";
import {
  LibraryMutationService,
  type CreateItemsOperation,
  type RelateItemsOperation,
  type ReparentItemsOperation,
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
  executeAndRecordUndo,
  planLibraryMutations,
} from "./mutateLibraryShared";

const CREATOR_SCHEMA = {
  type: "array" as const,
  items: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      creatorType: {
        type: "string" as const,
        description:
          "e.g. author, editor, bookAuthor. library_search({ entity:'itemTypes', mode:'list', text:'<itemType>' }) lists the ones a type accepts.",
      },
      firstName: { type: "string" as const },
      lastName: { type: "string" as const },
      name: {
        type: "string" as const,
        description:
          "Single-field name, for institutions and anything not split into first/last.",
      },
    },
  },
};

export function createCreateItemsTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<{ operation: CreateItemsOperation }, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "create_items",
      description:
        "Create Zotero items from scratch, of any item type. Use this when the item is not reachable by identifier or file import — a book with no DOI, a thesis, a dataset, a personal communication.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
          items: {
            type: "array",
            description:
              "The items to create. Check the item type's valid fields first with library_search({ entity:'itemTypes', mode:'list', text:'book' }) — a field the type does not have is rejected, not ignored.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["itemType"],
              properties: {
                itemType: {
                  type: "string",
                  description:
                    "A Zotero item type, e.g. book, thesis, dataset, report, manuscript, presentation.",
                },
                fields: {
                  type: "object",
                  additionalProperties: true,
                  description:
                    "Field values, e.g. { title: '...', publisher: '...', date: '2024' }.",
                },
                creators: CREATOR_SCHEMA,
                tags: { type: "array", items: { type: "string" } },
                collections: {
                  type: "array",
                  items: { type: "number" },
                  description: "Collection IDs to file the new item into.",
                },
              },
            },
          },
          libraryID: { type: "number" },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Create Items",
      summaries: {
        onCall: "Preparing new items",
        onPending: "Waiting for confirmation to create items",
        onApproved: "Creating items",
        onDenied: "Item creation cancelled",
        onSuccess: ({ content }) => {
          const inner = readInner(content);
          const count = Number(inner.createdCount || 0);
          return count > 0
            ? `Created ${count} item${count === 1 ? "" : "s"}`
            : "No items created";
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          'Expected an object with items. Example: { items: [{ itemType: "book", fields: { title: "Perceptrons", date: "1969" } }] }',
        );
      }
      if (!Array.isArray(args.items) || !args.items.length) {
        return fail(
          'items must be a non-empty array. Example: { items: [{ itemType: "thesis", fields: { title: "..." } }] }',
        );
      }
      const items: CreateItemsOperation["items"] = [];
      for (const raw of args.items) {
        if (!validateObject<Record<string, unknown>>(raw)) continue;
        const itemType =
          typeof raw.itemType === "string" ? raw.itemType.trim() : "";
        if (!itemType) {
          return fail("Every entry needs an itemType, e.g. itemType:'book'.");
        }
        items.push({
          itemType,
          fields: validateObject<Record<string, string>>(raw.fields)
            ? (raw.fields as Record<string, string>)
            : undefined,
          creators: Array.isArray(raw.creators)
            ? (raw.creators as CreateItemsOperation["items"][number]["creators"])
            : undefined,
          tags: Array.isArray(raw.tags)
            ? raw.tags.filter((tag): tag is string => typeof tag === "string")
            : undefined,
          collections: normalizePositiveIntArray(raw.collections) || undefined,
        });
      }
      if (!items.length) return fail("No valid items were provided.");

      return ok({
        operation: {
          type: "create_items" as const,
          items,
          libraryID: normalizePositiveInt(args.libraryID),
        },
      });
    },

    createPendingAction(input) {
      const items = input.operation.items;
      const lines = items.map((entry) => {
        const title = entry.fields?.title || "(untitled)";
        return `${entry.itemType}: ${title}`;
      });
      const description = `Create ${items.length} new item${items.length === 1 ? "" : "s"} in your library.`;
      return {
        toolName: "create_items",
        title: `Create ${items.length} item${items.length === 1 ? "" : "s"}`,
        description,
        confirmLabel: "Create",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text" as const,
            id: "description",
            label: "Items",
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
        "create_items",
      );
    },
  };
}

export function createReparentItemsTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<{ operation: ReparentItemsOperation }, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "reparent_items",
      description:
        "Move notes or attachments to a different parent item, or detach them to top level.",
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
              required: ["itemId"],
              properties: {
                itemId: {
                  type: "number",
                  description: "The note or attachment to move.",
                },
                parentItemId: {
                  type: ["number", "null"],
                  description:
                    "The regular item it should belong to, or null to detach it to top level.",
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
      label: "Move Between Parents",
      summaries: {
        onCall: "Preparing to move items",
        onPending: "Waiting for confirmation",
        onApproved: "Moving items",
        onDenied: "Move cancelled",
        onSuccess: ({ content }) => {
          const inner = readInner(content);
          const count = Number(inner.changedCount || 0);
          return count > 0
            ? `Moved ${count} item${count === 1 ? "" : "s"}`
            : "Nothing moved";
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          "Expected an object with assignments. Example: { assignments: [{ itemId: 55, parentItemId: 12 }] }",
        );
      }
      if (!Array.isArray(args.assignments) || !args.assignments.length) {
        return fail("assignments must be a non-empty array.");
      }
      const assignments: ReparentItemsOperation["assignments"] = [];
      for (const raw of args.assignments) {
        if (!validateObject<Record<string, unknown>>(raw)) continue;
        const itemId = normalizePositiveInt(raw.itemId);
        if (!itemId) continue;
        assignments.push({
          itemId,
          // null is meaningful here — it means detach — so it must survive
          // normalization rather than being treated as "absent".
          parentItemId:
            raw.parentItemId === null
              ? null
              : normalizePositiveInt(raw.parentItemId) || null,
        });
      }
      if (!assignments.length) {
        return fail("No valid assignments were provided.");
      }
      return ok({
        operation: { type: "reparent_items" as const, assignments },
      });
    },

    createPendingAction(input) {
      const assignments = input.operation.assignments;
      const lines = assignments.map((entry) => {
        const item = zoteroGateway.getItem(entry.itemId);
        const title = item
          ? String(item.getDisplayTitle?.() || `Item ${entry.itemId}`)
          : `Item ${entry.itemId}`;
        if (entry.parentItemId == null) {
          return `${title} → detach to top level`;
        }
        const parent = zoteroGateway.getItem(entry.parentItemId);
        const parentTitle = parent
          ? String(parent.getDisplayTitle?.() || `Item ${entry.parentItemId}`)
          : `Item ${entry.parentItemId}`;
        return `${title} → ${parentTitle}`;
      });
      return {
        toolName: "reparent_items",
        title: `Move ${assignments.length} item${assignments.length === 1 ? "" : "s"}`,
        description: `Change which item ${assignments.length === 1 ? "this note or attachment belongs" : "these notes or attachments belong"} to.`,
        confirmLabel: "Move",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text" as const,
            id: "description",
            label: "Moves",
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
        "reparent_items",
      );
    },
  };
}

export function createRelateItemsTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<{ operation: RelateItemsOperation }, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "relate_items",
      description:
        "Add or remove Zotero's 'Related' links between items. Links are bidirectional.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["itemId", "relatedItemIds"],
        properties: {
          itemId: { type: "number", description: "The item to link from." },
          relatedItemIds: {
            type: "array",
            items: { type: "number" },
            description: "The items to link it to.",
          },
          action: {
            type: "string",
            enum: ["add", "remove"],
            default: "add",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Relate Items",
      summaries: {
        onCall: "Preparing related-item links",
        onPending: "Waiting for confirmation",
        onApproved: "Updating related items",
        onDenied: "Related-item change cancelled",
        onSuccess: ({ content }) => {
          const inner = readInner(content);
          const count = Number(inner.changedCount || 0);
          return count > 0
            ? `Updated ${count} related-item link${count === 1 ? "" : "s"}`
            : "No links changed";
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          "Expected an object with itemId and relatedItemIds. Example: { itemId: 12, relatedItemIds: [34, 56] }",
        );
      }
      const itemId = normalizePositiveInt(args.itemId);
      const relatedItemIds = normalizePositiveIntArray(args.relatedItemIds);
      if (!itemId || !relatedItemIds?.length) {
        return fail(
          "itemId and a non-empty relatedItemIds array are required. Example: { itemId: 12, relatedItemIds: [34] }",
        );
      }
      return ok({
        operation: {
          type: "relate_items" as const,
          itemId,
          relatedItemIds,
          action:
            args.action === "remove" ? ("remove" as const) : ("add" as const),
        },
      });
    },

    createPendingAction(input) {
      const op = input.operation;
      const item = zoteroGateway.getItem(op.itemId);
      const title = item
        ? String(item.getDisplayTitle?.() || `Item ${op.itemId}`)
        : `Item ${op.itemId}`;
      const verb = op.action === "add" ? "Link" : "Unlink";
      return {
        toolName: "relate_items",
        title: `${verb} ${op.relatedItemIds.length} related item${op.relatedItemIds.length === 1 ? "" : "s"}`,
        description: `${verb} ${op.relatedItemIds.length} item${op.relatedItemIds.length === 1 ? "" : "s"} ${op.action === "add" ? "to" : "from"} "${title}". Related links are bidirectional, so both items are updated.`,
        confirmLabel: verb,
        cancelLabel: "Cancel",
        fields: [],
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
        "relate_items",
      );
    },
  };
}

function readInner(content: unknown): Record<string, unknown> {
  const outer =
    content && typeof content === "object"
      ? (content as Record<string, unknown>)
      : {};
  const inner =
    outer.result && typeof outer.result === "object"
      ? (outer.result as Record<string, unknown>)
      : {};
  const innermost =
    inner.result && typeof inner.result === "object"
      ? (inner.result as Record<string, unknown>)
      : {};
  return { ...outer, ...inner, ...innermost };
}

import type { AgentToolDefinition } from "../../types";
import type { CollectionSummary, ZoteroGateway } from "../../services/zoteroGateway";
import { fail, normalizePositiveInt, ok, validateObject } from "../shared";
import {
  pushUndoEntry,
} from "../../store/undoStore";

type CreateCollectionInput = {
  name: string;
  parentCollectionId?: number;
  libraryID?: number;
};

export function createCreateCollectionTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<CreateCollectionInput, unknown> {
  return {
    spec: {
      name: "create_collection",
      description:
        "Create a new Zotero collection (folder) in the library, optionally nested under an existing parent collection. The user must confirm before the collection is created.",
      inputSchema: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: {
          name: {
            type: "string",
            description: "Name for the new collection",
          },
          parentCollectionId: {
            type: "number",
            description:
              "Optional collectionId of the parent collection to nest under",
          },
          libraryID: { type: "number" },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },
    presentation: {
      label: "Create Collection",
      summaries: {
        onCall: "Preparing to create a new collection",
        onPending: "Waiting for your approval to create the collection",
        onApproved: "Approval received - creating the collection",
        onDenied: "Collection creation cancelled",
        onSuccess: ({ content }) => {
          const name =
            content && typeof content === "object"
              ? String(
                  (content as { collection?: { name?: unknown } }).collection
                    ?.name || "",
                )
              : "";
          return name ? `Created collection "${name}"` : "Collection created";
        },
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const name =
        typeof args.name === "string" && args.name.trim()
          ? args.name.trim()
          : "";
      if (!name) {
        return fail("name is required");
      }
      return ok<CreateCollectionInput>({
        name,
        parentCollectionId: normalizePositiveInt(args.parentCollectionId),
        libraryID: normalizePositiveInt(args.libraryID),
      });
    },
    createPendingAction: (input, context) => {
      const libraryID = zoteroGateway.resolveLibraryID({
        request: context.request,
        item: context.item,
        libraryID: input.libraryID,
      });
      const parentSummary = input.parentCollectionId
        ? zoteroGateway.getCollectionSummary(input.parentCollectionId)
        : null;
      const locationLabel = parentSummary
        ? `Inside "${parentSummary.path || parentSummary.name}"`
        : "Top-level collection";
      return {
        toolName: "create_collection",
        title: "Confirm new collection",
        description: `A new collection will be added to your library.`,
        confirmLabel: "Create collection",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text",
            id: "name",
            label: "Collection name",
            value: input.name,
          },
          ...(libraryID
            ? [
                {
                  type: "text" as const,
                  id: "location",
                  label: "Location",
                  value: locationLabel,
                },
              ]
            : []),
        ],
      };
    },
    applyConfirmation: (input, resolutionData) => {
      if (!validateObject<Record<string, unknown>>(resolutionData)) {
        return ok(input);
      }
      const name =
        typeof resolutionData.name === "string" && resolutionData.name.trim()
          ? resolutionData.name.trim()
          : input.name;
      if (!name) {
        return fail("name is required");
      }
      return ok({ ...input, name });
    },
    execute: async (input, context) => {
      const libraryID = zoteroGateway.resolveLibraryID({
        request: context.request,
        item: context.item,
        libraryID: input.libraryID,
      });
      if (!libraryID) {
        throw new Error("No active library available for collection creation");
      }
      const collection: CollectionSummary = await zoteroGateway.createCollection({
        name: input.name,
        parentCollectionId: input.parentCollectionId,
        libraryID,
      });
      pushUndoEntry(context.request.conversationKey, {
        id: `undo-create-collection-${Date.now()}`,
        toolName: "create_collection",
        description: `Undo creation of collection "${collection.name}"`,
        revert: async () => {
          await zoteroGateway.deleteCollection({
            collectionId: collection.collectionId,
          });
        },
      });
      return { collection };
    },
  };
}

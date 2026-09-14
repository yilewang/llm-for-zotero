import { loadWorkflowMaterial } from "../documents/workflowMaterial";
import type { AgentToolRegistry } from "./registry";
import type { ZoteroGateway } from "../services/zoteroGateway";
import type { AgentActionObligation } from "../types";

/** Existing tool owners receive canonical arguments; execution still crosses the registry's authorization and journal. */
export function registerPreparedLibraryActions(
  registry: AgentToolRegistry,
  gateway: ZoteroGateway,
): void {
  const ids = (o: AgentActionObligation) =>
    o.targetBoundary?.frozenTargetIds || [];
  const subjects = (o: AgentActionObligation) =>
    ids(o).length === 1
      ? `“${String(gateway.getItem(ids(o)[0])?.getField("title") || "the item")}”`
      : `${ids(o).length} items`;
  const collection = (id: number) =>
    `“${gateway.getCollectionSummary(id)?.path || gateway.getCollectionSummary(id)?.name || "the collection"}”`;
  registry.registerActionBinding("move_to_collection", {
    toolName: "library_update",
    checkpointPerItem: true,
    bind: (o) => {
      const p = o.parameters;
      if (!ids(o).length || !p?.destinationCollectionId) return null;
      const source = p.sourceCollectionId;
      if (o.constraints?.collectionMode === "move" && source === undefined)
        return null;
      return {
        arguments: {
          kind: "collections",
          action: "add",
          itemIds: ids(o),
          targetCollectionId: p.destinationCollectionId,
          ...(source !== undefined ? { mode: "move", from: source } : {}),
        },
        summary:
          source === undefined
            ? `${subjects(o)} is filed in ${collection(p.destinationCollectionId)}. Existing memberships were preserved.`
            : source === "all"
              ? `Moved ${subjects(o)} exclusively into ${collection(p.destinationCollectionId)}.`
              : `Moved ${subjects(o)} from ${collection(source)} into ${collection(p.destinationCollectionId)}. Other memberships were preserved.`,
      };
    },
  });
  for (const [operation, action] of [
    ["apply_tags", "add"],
    ["remove_tags", "remove"],
    ["set_item_tags", "set"],
  ] as const) {
    registry.registerActionBinding(operation, {
      toolName: "library_update",
      checkpointPerItem: true,
      bind: (o) => {
        if (!ids(o).length || !o.parameters?.tags) return null;
        return {
          arguments: {
            kind: "tags",
            action,
            itemIds: ids(o),
            tags: o.parameters.tags,
          },
          summary: `Updated the requested tags on ${subjects(o)}.`,
        };
      },
    });
  }
  registry.registerActionBinding("update_metadata", {
    toolName: "library_update",
    checkpointPerItem: true,
    bind: (o) => {
      if (
        !ids(o).length ||
        !o.parameters?.metadataValues ||
        !Object.keys(o.parameters.metadataValues).length
      )
        return null;
      return {
        arguments: {
          kind: "metadata",
          operations: ids(o).map((itemId) => ({
            itemId,
            metadata: o.parameters!.metadataValues,
          })),
        },
        summary: `Updated the requested metadata on ${subjects(o)}.`,
      };
    },
  });
  registry.registerActionBinding("file_write", {
    toolName: "file_io",
    bind: async (o, request) => {
      if (!o.contentFrom || !o.parameters?.filePath) return null;
      const material = await loadWorkflowMaterial(request, o.contentFrom);
      if (!material)
        throw new Error(
          "The finalized workflow material is unavailable or changed.",
        );
      return {
        arguments: {
          action: "write",
          filePath: o.parameters.filePath,
          content: material.visibleMarkdown,
        },
        summary: `Saved the finalized material to ${o.parameters.filePath}.`,
      };
    },
  });
  registry.registerActionBinding("note_create", {
    toolName: "note_write",
    bind: (o, request) => {
      if (!o.contentFrom || ids(o).length !== 1) return null;
      const material = request.actionProgress?.materialOutputs?.find(
        (entry) => entry.outputId === o.contentFrom,
      );
      if (!material) return null;
      return {
        arguments: {
          mode: "create",
          targetItemId: ids(o)[0],
          documentId: material.documentId,
        },
        summary: `Saved the finalized material as a note attached to ${subjects(o)}.`,
      };
    },
  });
  registry.registerActionBinding("remove_from_collection", {
    toolName: "library_update",
    checkpointPerItem: true,
    bind: (o) => {
      const source = o.parameters?.sourceCollectionId;
      if (!ids(o).length || typeof source !== "number") return null;
      return {
        arguments: {
          kind: "collections",
          action: "remove",
          itemIds: ids(o),
          collectionId: source,
        },
        summary: `Removed ${subjects(o)} from ${collection(source)}.`,
      };
    },
  });
  registry.registerActionBinding("create_collection", {
    toolName: "collection_update",
    bind: (o, request) => {
      if (!o.parameters?.collectionName) return null;
      return {
        arguments: {
          action: "create",
          name: o.parameters.collectionName,
          libraryID: request.libraryID,
          ...(o.parameters.parentCollectionId != null
            ? { parentCollectionId: o.parameters.parentCollectionId }
            : {}),
        },
        summary: `Created collection “${o.parameters.collectionName}”.`,
      };
    },
  });
  registry.registerActionBinding("delete_collection", {
    toolName: "collection_update",
    bind: (o) => {
      if (!o.parameters?.collectionId) return null;
      return {
        arguments: {
          action: "delete",
          collectionId: o.parameters.collectionId,
          deleteItems: o.parameters.deleteItems === true,
          permanent: o.parameters.permanent === true,
        },
        summary: `Deleted ${collection(o.parameters.collectionId)}${o.parameters.deleteItems ? " and its requested items" : "; its papers were preserved"}.`,
      };
    },
  });
  registry.registerActionBinding("update_collection", {
    toolName: "collection_update",
    bind: (o) => {
      const p = o.parameters;
      if (!p?.collectionId) return null;
      if (p.collectionName)
        return {
          arguments: {
            action: "rename",
            collectionId: p.collectionId,
            newName: p.collectionName,
            ...(p.parentCollectionId !== undefined
              ? { parentCollectionId: p.parentCollectionId }
              : {}),
          },
          summary: `Renamed the collection to “${p.collectionName}”${p.parentCollectionId === undefined ? "" : p.parentCollectionId === null ? " and moved it to the library root" : ` and moved it under ${collection(p.parentCollectionId)}`}.`,
        };
      if (p.parentCollectionId !== undefined)
        return {
          arguments: {
            action: "move",
            collectionId: p.collectionId,
            parentCollectionId: p.parentCollectionId,
          },
          summary: `Moved ${collection(p.collectionId)} to its requested parent.`,
        };
      return null;
    },
  });
}

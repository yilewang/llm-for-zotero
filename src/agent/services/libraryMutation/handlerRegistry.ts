import type { LibraryMutationOperation } from "./contracts";
import { canonicalJsonEqual } from "./canonicalJson";
import {
  defineHandler,
  type LibraryMutationHandlerRegistry,
} from "./handlerDefinition";
import {
  noteContentMatches,
  onePer,
  restoreCollectionState,
  restoreTagState,
  resultCount,
  resultId,
  resultIds,
  resultRowIds,
  resultStatus,
  sameMembers,
} from "./handlerUtilities";

export const libraryMutationHandlers = {
  update_metadata: defineHandler("update_metadata", {
    actionCapability: "zotero.metadata",
    targetScope: "items",
    targetItemIds: (operation) => (operation.itemId ? [operation.itemId] : []),
    actionParameters: (operation) => ({
      metadataFields: Object.keys(operation.metadata),
    }),
    stateSections: ["items"],
    replay: "state-aware",
    planInverse: (_operation, state) => {
      const item = state.items?.[0];
      return item?.exists && item.fields
        ? {
            inverseOperations: [
              {
                type: "update_metadata",
                itemId: item.itemId,
                metadata: {
                  ...item.fields,
                  ...(item.creators ? { creators: item.creators } : {}),
                },
              },
            ],
          }
        : {};
    },
    postconditionSatisfied: (operation, state) => {
      const current = state.item(Number(operation.itemId));
      if (!current?.exists || !current.fields) return false;
      return Object.entries(operation.metadata).every(([field, value]) =>
        field === "creators"
          ? canonicalJsonEqual(current.creators, value)
          : current.fields?.[field] === value,
      );
    },
  }),
  apply_tags: defineHandler("apply_tags", {
    actionCapability: "zotero.tags",
    targetScope: "items",
    targetItemIds: (operation) => [
      ...(operation.itemIds || []),
      ...(operation.assignments || []).map((entry) => entry.itemId),
    ],
    actionParameters: (operation) => ({
      tags: [
        ...(operation.tags || []),
        ...(operation.assignments || []).flatMap((entry) => entry.tags),
      ],
    }),
    stateSections: ["items"],
    replay: "state-aware",
    planInverse: (_operation, state) => restoreTagState(state),
    postconditionSatisfied: (operation, state) => {
      const assignments = operation.assignments?.length
        ? operation.assignments
        : (operation.itemIds || []).map((itemId) => ({
            itemId,
            tags: operation.tags || [],
          }));
      return assignments.every((assignment) => {
        const current = state.item(assignment.itemId);
        const tags = new Set(current?.tags || []);
        return Boolean(
          current?.exists && assignment.tags.every((tag) => tags.has(tag)),
        );
      });
    },
    targetCount: (operation) =>
      new Set(
        operation.assignments?.length
          ? operation.assignments.map((assignment) => assignment.itemId)
          : operation.itemIds || [],
      ).size,
    affectedCount: (_operation, result) => resultCount(result, "updatedCount"),
    atomize: (operation) =>
      operation.assignments?.length
        ? onePer(operation, operation.assignments, (assignment) => ({
            ...operation,
            assignments: [assignment],
          }))
        : onePer(operation, operation.itemIds, (itemId) => ({
            ...operation,
            itemIds: [itemId],
          })),
  }),
  remove_tags: defineHandler("remove_tags", {
    actionCapability: "zotero.tags",
    targetScope: "items",
    targetItemIds: (operation) => operation.itemIds,
    actionParameters: (operation) => ({ tags: operation.tags }),
    stateSections: ["items"],
    replay: "state-aware",
    planInverse: (_operation, state) => restoreTagState(state),
    postconditionSatisfied: (operation, state) =>
      operation.itemIds.every((itemId) => {
        const current = state.item(itemId);
        const tags = new Set(current?.tags || []);
        return Boolean(
          current?.exists && operation.tags.every((tag) => !tags.has(tag)),
        );
      }),
    targetCount: (operation) => operation.itemIds.length,
    affectedCount: (_operation, result) => resultCount(result, "removedCount"),
    atomize: (operation) =>
      onePer(operation, operation.itemIds, (itemId) => ({
        ...operation,
        itemIds: [itemId],
      })),
  }),
  move_to_collection: defineHandler("move_to_collection", {
    actionCapability: "zotero.collections",
    targetScope: "items",
    targetItemIds: (operation) => [
      ...(operation.itemIds || []),
      ...(operation.assignments || []).map((entry) => entry.itemId),
    ],
    destinationCollectionIds: (operation) => [
      Number(operation.targetCollectionId),
      ...(operation.assignments || []).map((entry) =>
        Number(entry.targetCollectionId),
      ),
    ],
    actionParameters: (operation) => ({
      sourceCollectionId: operation.from,
      destinationCollectionId:
        operation.targetCollectionId ||
        operation.assignments?.[0]?.targetCollectionId,
    }),
    stateSections: ["items"],
    replay: "state-aware",
    planInverse: (_operation, state) => restoreCollectionState(state),
    postconditionSatisfied: (operation, state) => {
      const assignments = operation.assignments?.length
        ? operation.assignments
        : (operation.itemIds || []).map((itemId) => ({
            itemId,
            targetCollectionId: operation.targetCollectionId,
          }));
      return assignments.every((assignment) => {
        const targetCollectionId =
          assignment.targetCollectionId || operation.targetCollectionId;
        const current = state.item(assignment.itemId);
        if (
          !current?.exists ||
          !current.collectionIds ||
          !targetCollectionId ||
          !current.collectionIds.includes(targetCollectionId)
        ) {
          return false;
        }
        if (operation.mode !== "move") return true;
        return operation.from === "all"
          ? sameMembers(current.collectionIds, [targetCollectionId])
          : !current.collectionIds.includes(Number(operation.from));
      });
    },
    targetCount: (operation) =>
      new Set(
        operation.assignments?.length
          ? operation.assignments.map((assignment) => assignment.itemId)
          : operation.itemIds || [],
      ).size,
    affectedCount: (_operation, result) => resultCount(result, "movedCount"),
    atomize: (operation) =>
      operation.assignments?.length
        ? onePer(operation, operation.assignments, (assignment) => ({
            ...operation,
            assignments: [assignment],
          }))
        : onePer(operation, operation.itemIds, (itemId) => ({
            ...operation,
            itemIds: [itemId],
          })),
  }),
  remove_from_collection: defineHandler("remove_from_collection", {
    actionCapability: "zotero.collections",
    targetScope: "items",
    targetItemIds: (operation) => operation.itemIds,
    actionParameters: (operation) => ({
      sourceCollectionId: operation.collectionId,
    }),
    stateSections: ["items"],
    replay: "state-aware",
    planInverse: (_operation, state) => restoreCollectionState(state),
    postconditionSatisfied: (operation, state) =>
      operation.itemIds.every((itemId) => {
        const current = state.item(itemId);
        return Boolean(
          current?.exists &&
          current.collectionIds &&
          !current.collectionIds.includes(operation.collectionId),
        );
      }),
    targetCount: (operation) => operation.itemIds.length,
    affectedCount: (_operation, result) => resultCount(result, "removedCount"),
    atomize: (operation) =>
      onePer(operation, operation.itemIds, (itemId) => ({
        ...operation,
        itemIds: [itemId],
      })),
  }),
  create_collection: defineHandler("create_collection", {
    actionCapability: "zotero.collections",
    targetScope: "none",
    actionParameters: (operation) => ({
      collectionName: operation.name,
      parentCollectionId: operation.parentCollectionId ?? null,
    }),
    stateSections: ["collections"],
    deferredInverse: () => true,
    createdCollectionIds: (result) => resultId(result, "collectionId"),
    executionDomain: "collection-search-structure",
    postconditionSatisfied: (operation, state) =>
      Boolean(
        state.collections?.some(
          (collection) =>
            collection.exists &&
            !collection.deleted &&
            collection.name === operation.name &&
            (collection.parentCollectionId ?? null) ===
              (operation.parentCollectionId ?? null),
        ),
      ),
  }),
  set_item_collections: defineHandler("set_item_collections", {
    actionCapability: "zotero.collections",
    targetScope: "items",
    targetItemIds: (operation) =>
      operation.assignments.map((entry) => entry.itemId),
    actionParameters: (operation) => ({
      collectionIds: operation.assignments.flatMap(
        (entry) => entry.collectionIds,
      ),
    }),
    stateSections: ["items"],
    replay: "state-aware",
    planInverse: (_operation, state) => restoreCollectionState(state),
    postconditionSatisfied: (operation, state) =>
      operation.assignments.every((assignment) => {
        const current = state.item(assignment.itemId);
        return Boolean(
          current?.exists &&
          current.collectionIds &&
          sameMembers(current.collectionIds, assignment.collectionIds),
        );
      }),
    targetCount: (operation) => operation.assignments.length,
    affectedCount: (_operation, result) =>
      resultCount(result, "changedCount") ||
      resultCount(result, "createdCount"),
    atomize: (operation) =>
      onePer(operation, operation.assignments, (assignment) => ({
        ...operation,
        assignments: [assignment],
      })),
  }),
  save_notes_batch: defineHandler("save_notes_batch", {
    actionCapability: "zotero.notes",
    targetScope: "items",
    targetItemIds: (operation) =>
      operation.notes.map((entry) => entry.targetItemId),
    destinationCollectionIds: (operation) =>
      operation.notes.flatMap((entry) => entry.collections || []),
    actionParameters: () => ({ noteMode: "create" }),
    stateSections: ["items"],
    deferredInverse: () => true,
    createdItemIds: (result) =>
      resultRowIds({
        result,
        rowsKey: "notes",
        idKey: "noteId",
        status: "created",
      }),
    executionDomain: "notes-lifecycle",
    postconditionSatisfied: (operation, state) => {
      const notes = (state.items || []).filter((item) => item.exists);
      return (
        notes.length >= operation.notes.length &&
        operation.notes.every((expected) =>
          notes.some(
            (actual) =>
              actual.parentItemId === expected.targetItemId &&
              noteContentMatches(actual.noteHtml, expected.content) &&
              (expected.collections || []).every((collectionId) =>
                (actual.collectionIds || []).includes(collectionId),
              ),
          ),
        )
      );
    },
    targetCount: (operation) => operation.notes.length,
    affectedCount: (_operation, result) => resultCount(result, "createdCount"),
    atomize: (operation) =>
      onePer(operation, operation.notes, (note) => ({
        ...operation,
        notes: [note],
      })),
  }),
  save_saved_search: defineHandler("save_saved_search", {
    actionCapability: "zotero.collections",
    targetScope: "none",
    actionParameters: (operation) => ({ savedSearchName: operation.name }),
    stateSections: ["savedSearches"],
    deferredInverse: (operation) => !operation.savedSearchId,
    createdSavedSearchIds: (result) => resultId(result, "savedSearchId"),
    executionDomain: "collection-search-structure",
    planInverse: (operation) => ({
      reason: operation.savedSearchId
        ? "Replacing a saved search requires its complete prior conditions."
        : "The new saved-search ID is assigned only after commit.",
    }),
    postconditionSatisfied: (operation, state) =>
      Boolean(
        state.savedSearches?.some(
          (search) =>
            search.exists &&
            !search.deleted &&
            search.name === operation.name &&
            canonicalJsonEqual(search.conditions || [], operation.conditions),
        ),
      ),
  }),
  delete_saved_search: defineHandler("delete_saved_search", {
    actionCapability: "zotero.collections",
    targetScope: "none",
    actionParameters: (operation) => ({
      savedSearchId: operation.savedSearchId,
      permanent: operation.permanent,
    }),
    additionalActionTargets: (operation) => [
      `saved-search:${operation.savedSearchId}`,
    ],
    stateSections: ["savedSearches"],
    replay: "state-aware",
    executionDomain: "collection-search-structure",
    planInverse: (operation) =>
      operation.permanent
        ? { reason: "A permanently erased saved search cannot be restored." }
        : {
            inverseOperations: [
              {
                type: "restore_from_trash",
                savedSearchIds: [operation.savedSearchId],
              },
            ],
          },
    postconditionSatisfied: (operation, state) => {
      const current = state.savedSearch(operation.savedSearchId);
      return operation.permanent
        ? current?.exists === false
        : Boolean(current?.exists && current.deleted === true);
    },
    affectedCount: (_operation, result) =>
      (result as { status?: unknown } | null)?.status === "not_found" ? 0 : 1,
  }),
  update_collection: defineHandler("update_collection", {
    actionCapability: "zotero.collections",
    targetScope: "none",
    actionParameters: (operation) => ({
      collectionId: operation.collectionId,
      collectionName: operation.name,
      parentCollectionId: operation.parentCollectionId,
    }),
    additionalActionTargets: (operation) => [
      `collection:${operation.collectionId}`,
    ],
    stateSections: ["collections"],
    replay: "state-aware",
    executionDomain: "collection-search-structure",
    planInverse: (_operation, state) => {
      const collection = state.collections?.[0];
      return collection?.exists
        ? {
            inverseOperations: [
              {
                type: "update_collection",
                collectionId: collection.collectionId,
                name: collection.name,
                parentCollectionId: collection.parentCollectionId,
              },
            ],
          }
        : {};
    },
    postconditionSatisfied: (operation, state) => {
      const current = state.collection(operation.collectionId);
      return Boolean(
        current?.exists &&
        (operation.name === undefined || current.name === operation.name) &&
        (operation.parentCollectionId === undefined ||
          (current.parentCollectionId ?? null) ===
            operation.parentCollectionId),
      );
    },
    affectedCount: (_operation, result) => resultStatus(result, "updated"),
  }),
  update_library_tag: defineHandler("update_library_tag", {
    actionCapability: "zotero.tags",
    targetScope: "none",
    actionParameters: (operation) => ({
      semanticAction: operation.action,
      tag: operation.tag,
      ...(operation.newTag ? { newTag: operation.newTag } : {}),
    }),
    stateSections: ["libraryTags"],
    planInverse: (operation, state) => {
      if (operation.action !== "rename" || !operation.newTag) {
        return {
          reason: `Library tag action ${operation.action} does not preserve enough information for a lossless inverse.`,
        };
      }
      const source = state.libraryTags?.find(
        (entry) => entry.name === operation.tag.trim(),
      );
      const destination = state.libraryTags?.find(
        (entry) => entry.name === operation.newTag?.trim(),
      );
      if (
        source?.observable !== true ||
        !source.exists ||
        destination?.observable !== true ||
        destination.exists
      ) {
        return {
          reason: destination?.exists
            ? "The destination tag already exists, so Zotero will merge memberships and cannot later separate them losslessly."
            : "The source and destination tag memberships could not be verified before the rename.",
        };
      }
      return {
        inverseOperations: [
          { ...operation, tag: operation.newTag, newTag: operation.tag },
        ],
      };
    },
    postconditionSatisfied: (operation, state) => {
      const source = state.libraryTags?.find(
        (entry) => entry.name === operation.tag.trim(),
      );
      if (operation.action === "delete") return source?.exists === false;
      if (operation.action === "setColor") {
        return Boolean(
          source?.exists &&
          source.color === (operation.color || "") &&
          (operation.position === undefined ||
            source.position === operation.position),
        );
      }
      const destination = state.libraryTags?.find(
        (entry) => entry.name === operation.newTag?.trim(),
      );
      return Boolean(source?.exists === false && destination?.exists);
    },
    affectedCount: (_operation, result) => resultStatus(result, "applied"),
  }),
  set_item_tags: defineHandler("set_item_tags", {
    actionCapability: "zotero.tags",
    targetScope: "items",
    targetItemIds: (operation) =>
      operation.assignments.map((entry) => entry.itemId),
    actionParameters: (operation) => ({
      tags: operation.assignments.flatMap((entry) => entry.tags),
    }),
    stateSections: ["items"],
    replay: "state-aware",
    planInverse: (_operation, state) => restoreTagState(state),
    postconditionSatisfied: (operation, state) =>
      operation.assignments.every((assignment) => {
        const current = state.item(assignment.itemId);
        return Boolean(
          current?.exists &&
          current.tags &&
          sameMembers(current.tags, assignment.tags),
        );
      }),
    targetCount: (operation) => operation.assignments.length,
    affectedCount: (_operation, result) =>
      resultCount(result, "changedCount") ||
      resultCount(result, "createdCount"),
    atomize: (operation) =>
      onePer(operation, operation.assignments, (assignment) => ({
        ...operation,
        assignments: [assignment],
      })),
  }),
  create_items: defineHandler("create_items", {
    actionCapability: "zotero.import",
    targetScope: "none",
    destinationCollectionIds: (operation) =>
      operation.items.flatMap((entry) => entry.collections || []),
    stateSections: ["items"],
    deferredInverse: () => true,
    createdItemIds: (result) =>
      resultRowIds({
        result,
        rowsKey: "items",
        idKey: "itemId",
        status: "created",
      }),
    postconditionSatisfied: (operation, state) => {
      const items = (state.items || []).filter((item) => item.exists);
      return (
        items.length >= operation.items.length &&
        operation.items.every((expected, index) => {
          const actual = items[index];
          return Boolean(
            actual?.exists &&
            Object.entries(expected.fields || {}).every(
              ([field, value]) => actual.fields?.[field] === value,
            ) &&
            (expected.tags || []).every((tag) =>
              (actual.tags || []).includes(tag),
            ) &&
            (expected.collections || []).every((collectionId) =>
              (actual.collectionIds || []).includes(collectionId),
            ),
          );
        })
      );
    },
    targetCount: (operation) => operation.items.length,
    affectedCount: (_operation, result) =>
      resultCount(result, "changedCount") ||
      resultCount(result, "createdCount"),
    atomize: (operation) =>
      onePer(operation, operation.items, (item) => ({
        ...operation,
        items: [item],
      })),
  }),
  reparent_items: defineHandler("reparent_items", {
    actionCapability: "zotero.metadata",
    targetScope: "items",
    targetItemIds: (operation) =>
      operation.assignments.map((entry) => entry.itemId),
    actionParameters: (operation) => ({
      parentItemIds: operation.assignments.map((entry) => entry.parentItemId),
    }),
    stateSections: ["items"],
    replay: "state-aware",
    planInverse: (_operation, state) => ({
      inverseOperations: [
        {
          type: "reparent_items",
          assignments: (state.items || [])
            .filter((item) => item.exists)
            .map((item) => ({
              itemId: item.itemId,
              parentItemId: item.parentItemId ?? null,
            })),
        },
      ],
    }),
    postconditionSatisfied: (operation, state) =>
      operation.assignments.every((assignment) => {
        const current = state.item(assignment.itemId);
        return Boolean(
          current?.exists &&
          (current.parentItemId ?? null) === assignment.parentItemId,
        );
      }),
    targetCount: (operation) => operation.assignments.length,
    affectedCount: (_operation, result) =>
      resultCount(result, "changedCount") ||
      resultCount(result, "createdCount"),
    atomize: (operation) =>
      onePer(operation, operation.assignments, (assignment) => ({
        ...operation,
        assignments: [assignment],
      })),
  }),
  relate_items: defineHandler("relate_items", {
    actionCapability: "zotero.metadata",
    targetScope: "items",
    targetItemIds: (operation) => [
      operation.itemId,
      ...operation.relatedItemIds,
    ],
    actionParameters: (operation) => ({
      semanticAction: operation.action,
    }),
    stateSections: ["relations"],
    replay: "state-aware",
    planInverse: (operation) => ({
      inverseOperations: [
        { ...operation, action: operation.action === "add" ? "remove" : "add" },
      ],
    }),
    postconditionSatisfied: (operation, state) =>
      (state.relations || []).every((relation) =>
        operation.action === "add"
          ? relation.related && relation.reciprocal
          : !relation.related && !relation.reciprocal,
      ),
    targetCount: (operation) => operation.relatedItemIds.length,
    affectedCount: (_operation, result) =>
      resultCount(result, "changedCount") ||
      resultCount(result, "createdCount"),
    atomize: (operation) =>
      onePer(operation, operation.relatedItemIds, (relatedItemId) => ({
        ...operation,
        relatedItemIds: [relatedItemId],
      })),
  }),
  delete_collection: defineHandler("delete_collection", {
    actionCapability: "zotero.collections",
    targetScope: "none",
    actionParameters: (operation) => ({
      collectionId: operation.collectionId,
      deleteItems: operation.deleteItems,
      permanent: operation.permanent,
    }),
    additionalActionTargets: (operation) => [
      `collection:${operation.collectionId}`,
    ],
    stateSections: ["collections"],
    replay: "state-aware",
    executionDomain: "collection-search-structure",
    planInverse: (operation) =>
      operation.permanent
        ? { reason: "A permanently erased collection cannot be restored." }
        : {
            inverseOperations: [
              {
                type: "restore_from_trash",
                collectionIds: [operation.collectionId],
              },
            ],
          },
    postconditionSatisfied: (operation, state) => {
      const current = state.collection(operation.collectionId);
      return operation.permanent
        ? current?.exists === false
        : Boolean(current?.exists && current.deleted === true);
    },
  }),
  save_note: defineHandler("save_note", {
    actionCapability: "zotero.notes",
    targetScope: "none",
    targetItemIds: (operation) =>
      operation.targetItemId ? [operation.targetItemId] : [],
    destinationCollectionIds: (operation) => operation.collections || [],
    actionParameters: (operation) => ({
      noteMode: "create",
      targetItemId: operation.targetItemId,
      expectedText: operation.content,
    }),
    stateSections: ["items"],
    deferredInverse: () => true,
    createdItemIds: (result) => resultId(result, "noteId"),
    executionDomain: "notes-lifecycle",
    postconditionSatisfied: (operation, state) =>
      Boolean(
        state.items?.some(
          (note) =>
            note.exists &&
            (operation.targetItemId === undefined ||
              note.parentItemId === operation.targetItemId) &&
            noteContentMatches(note.noteHtml, operation.content) &&
            (operation.collections || []).every((collectionId) =>
              (note.collectionIds || []).includes(collectionId),
            ),
        ),
      ),
  }),
  import_identifiers: defineHandler("import_identifiers", {
    actionCapability: "zotero.import",
    targetScope: "none",
    destinationCollectionIds: (operation) =>
      operation.targetCollectionId ? [operation.targetCollectionId] : [],
    actionParameters: (operation) => ({
      identifiers: operation.identifiers,
      destinationCollectionId: operation.targetCollectionId,
    }),
    stateSections: ["items"],
    deferredInverse: () => true,
    createdItemIds: (result) => resultIds(result, "itemIds"),
    executionDomain: "attachments-imports",
    postconditionSatisfied: (operation, state) => {
      const items = (state.items || []).filter((item) => item.exists);
      return (
        items.length >= operation.identifiers.length &&
        (!operation.targetCollectionId ||
          items.every((item) =>
            (item.collectionIds || []).includes(operation.targetCollectionId!),
          ))
      );
    },
    targetCount: (operation) => operation.identifiers.length,
    affectedCount: (_operation, result) => resultCount(result, "succeeded"),
    atomize: (operation) =>
      onePer(operation, operation.identifiers, (identifier) => ({
        ...operation,
        identifiers: [identifier],
      })),
  }),
  trash_items: defineHandler("trash_items", {
    actionCapability: "zotero.trash",
    targetScope: "items",
    targetItemIds: (operation) => operation.itemIds,
    stateSections: ["items"],
    replay: "state-aware",
    executionDomain: "notes-lifecycle",
    planInverse: (_operation, state) => ({
      inverseOperations: [
        {
          type: "restore_from_trash",
          itemIds: (state.items || [])
            .filter((item) => item.exists && !item.deleted)
            .map((item) => item.itemId),
        },
      ],
    }),
    postconditionSatisfied: (operation, state) =>
      operation.itemIds.every((itemId) => {
        const current = state.item(itemId);
        return Boolean(current?.exists && current.deleted === true);
      }),
    targetCount: (operation) => operation.itemIds.length,
    affectedCount: (_operation, result) => resultCount(result, "trashedCount"),
    atomize: (operation) =>
      onePer(operation, operation.itemIds, (itemId) => ({
        ...operation,
        itemIds: [itemId],
      })),
  }),
  restore_from_trash: defineHandler("restore_from_trash", {
    actionCapability: "zotero.trash",
    targetScope: "items",
    targetItemIds: (operation) => operation.itemIds || [],
    stateSections: ["items", "collections", "savedSearches"],
    replay: "state-aware",
    executionDomain: "notes-lifecycle",
    planInverse: (operation) => ({
      inverseOperations: operation.itemIds?.length
        ? [{ type: "trash_items", itemIds: operation.itemIds }]
        : undefined,
      ...(operation.collectionIds?.length || operation.savedSearchIds?.length
        ? {
            reason:
              "The item portion is reversible, but collection/saved-search restore is finalized from Zotero's actual result.",
          }
        : {}),
    }),
    postconditionSatisfied: (operation, state) =>
      (operation.itemIds || []).every((itemId) => {
        const current = state.item(itemId);
        return Boolean(current?.exists && current.deleted === false);
      }) &&
      (operation.collectionIds || []).every((collectionId) => {
        const current = state.collection(collectionId);
        return Boolean(current?.exists && current.deleted === false);
      }) &&
      (operation.savedSearchIds || []).every((savedSearchId) => {
        const current = state.savedSearch(savedSearchId);
        return Boolean(current?.exists && current.deleted === false);
      }),
    targetCount: (operation) =>
      (operation.itemIds?.length || 0) +
      (operation.collectionIds?.length || 0) +
      (operation.savedSearchIds?.length || 0),
    affectedCount: (_operation, result) => resultCount(result, "restoredCount"),
    atomize: (operation) => {
      const units: LibraryMutationOperation[] = [
        ...(operation.itemIds || []).map((itemId) => ({
          ...operation,
          itemIds: [itemId],
          collectionIds: undefined,
          savedSearchIds: undefined,
        })),
        ...(operation.collectionIds || []).map((collectionId) => ({
          ...operation,
          itemIds: undefined,
          collectionIds: [collectionId],
          savedSearchIds: undefined,
        })),
        ...(operation.savedSearchIds || []).map((savedSearchId) => ({
          ...operation,
          itemIds: undefined,
          collectionIds: undefined,
          savedSearchIds: [savedSearchId],
        })),
      ];
      return units.length > 1 ? units : [operation];
    },
  }),
  merge_items: defineHandler("merge_items", {
    actionCapability: "zotero.trash",
    targetScope: "items",
    targetItemIds: (operation) => [
      operation.masterItemId,
      ...operation.otherItemIds,
    ],
    stateSections: ["items"],
    executionDomain: "notes-lifecycle",
    planInverse: () => ({
      reason:
        "Merging can move and deduplicate child objects, so it has no lossless inverse.",
    }),
    postconditionSatisfied: (operation, state) =>
      Boolean(state.item(operation.masterItemId)?.exists) &&
      operation.otherItemIds.every((itemId) => {
        const item = state.item(itemId);
        return !item?.exists || item.deleted === true;
      }),
    targetCount: (operation) => operation.otherItemIds.length,
    affectedCount: (_operation, result) => resultCount(result, "mergedCount"),
  }),
  delete_attachment: defineHandler("delete_attachment", {
    actionCapability: "zotero.attachments",
    targetScope: "items",
    targetItemIds: (operation) => [operation.attachmentId],
    stateSections: ["items"],
    executionDomain: "attachments-imports",
    planInverse: (operation) => ({
      inverseOperations: [
        { type: "restore_from_trash", itemIds: [operation.attachmentId] },
      ],
    }),
    postconditionSatisfied: (operation, state) => {
      const attachment = state.item(operation.attachmentId);
      return !attachment?.exists || attachment.deleted === true;
    },
    affectedCount: (_operation, result) => resultStatus(result, "deleted"),
  }),
  rename_attachment: defineHandler("rename_attachment", {
    actionCapability: "zotero.attachments",
    targetScope: "items",
    targetItemIds: (operation) => [operation.attachmentId],
    actionParameters: (operation) => ({ newName: operation.newName }),
    stateSections: ["items"],
    replay: "state-aware",
    executionDomain: "attachments-imports",
    planInverse: (operation, state) => {
      const previous = state.items?.[0]?.attachmentTitle;
      return previous
        ? {
            inverseOperations: [
              {
                type: "rename_attachment",
                attachmentId: operation.attachmentId,
                newName: previous,
              },
            ],
          }
        : {};
    },
    postconditionSatisfied: (operation, state) => {
      const current = state.item(operation.attachmentId);
      return Boolean(
        current?.exists && current.attachmentTitle === operation.newName,
      );
    },
    affectedCount: (_operation, result) => resultStatus(result, "renamed"),
  }),
  relink_attachment: defineHandler("relink_attachment", {
    actionCapability: "zotero.attachments",
    targetScope: "items",
    targetItemIds: (operation) => [operation.attachmentId],
    actionParameters: (operation) => ({ newPath: operation.newPath }),
    stateSections: ["items"],
    replay: "state-aware",
    executionDomain: "attachments-imports",
    planInverse: (operation, state) => {
      const previous = state.items?.[0]?.attachmentPath;
      return previous
        ? {
            inverseOperations: [
              {
                type: "relink_attachment",
                attachmentId: operation.attachmentId,
                newPath: previous,
              },
            ],
          }
        : { reason: "The attachment had no resolvable previous path." };
    },
    postconditionSatisfied: (operation, state) => {
      const current = state.item(operation.attachmentId);
      return Boolean(
        current?.exists && current.attachmentPath === operation.newPath,
      );
    },
    affectedCount: (_operation, result) => resultStatus(result, "relinked"),
  }),
  import_local_files: defineHandler("import_local_files", {
    actionCapability: "zotero.import",
    targetScope: "none",
    destinationCollectionIds: (operation) =>
      operation.targetCollectionId ? [operation.targetCollectionId] : [],
    actionParameters: (operation) => ({
      filePaths: operation.filePaths,
      destinationCollectionId: operation.targetCollectionId,
    }),
    stateSections: ["items"],
    deferredInverse: () => true,
    createdItemIds: (result) =>
      resultRowIds({
        result,
        rowsKey: "items",
        idKey: "itemId",
        status: "imported",
      }),
    executionDomain: "attachments-imports",
    postconditionSatisfied: (operation, state) => {
      const items = (state.items || []).filter((item) => item.exists);
      return (
        items.length >= operation.filePaths.length &&
        (!operation.targetCollectionId ||
          items.every((item) =>
            (item.collectionIds || []).includes(operation.targetCollectionId!),
          ))
      );
    },
    targetCount: (operation) => operation.filePaths.length,
    affectedCount: (_operation, result) => resultCount(result, "succeeded"),
    atomize: (operation) =>
      onePer(operation, operation.filePaths, (filePath) => ({
        ...operation,
        filePaths: [filePath],
      })),
  }),
} satisfies LibraryMutationHandlerRegistry;

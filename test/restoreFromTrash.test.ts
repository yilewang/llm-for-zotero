import { assert } from "chai";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import { createRestoreFromTrashTool } from "../src/agent/tools/write/restoreFromTrash";
import { replayLibraryInverse } from "./helpers/replayLibraryInverse";

/**
 * Restoring was previously reachable only as the inverse of a mutation the
 * agent had just performed, so anything the *user* trashed — or anything
 * trashed in an earlier session — could not be recovered by asking.
 */
describe("restore_from_trash", function () {
  function makeGateway(overrides: Record<string, unknown> = {}) {
    const calls: {
      items: unknown[];
      collections: unknown[];
      searches: unknown[];
      trashed: unknown[];
      deleted: unknown[];
      deletedSearches: unknown[];
    } = {
      items: [],
      collections: [],
      searches: [],
      trashed: [],
      deleted: [],
      deletedSearches: [],
    };
    const gateway = {
      restoreItems: async (params: { itemIds: number[] }) => {
        calls.items.push(params);
        // Only ids that were actually trashed come back.
        const restored = params.itemIds.filter((id) => id !== 999);
        return { restoredCount: restored.length, itemIds: restored };
      },
      restoreCollections: async (params: { collectionIds: number[] }) => {
        calls.collections.push(params);
        const restored = params.collectionIds.filter((id) => id !== 999);
        return { restoredCount: restored.length, collectionIds: restored };
      },
      restoreSavedSearches: async (params: { savedSearchIds: number[] }) => {
        calls.searches.push(params);
        const restored = params.savedSearchIds.filter((id) => id !== 999);
        return { restoredCount: restored.length, savedSearchIds: restored };
      },
      trashItems: async (params: unknown) => {
        calls.trashed.push(params);
        return { trashedCount: 1, items: [] };
      },
      snapshotCollectionForDelete: ({
        collectionId,
      }: {
        collectionId: number;
      }) => ({
        name: `Collection ${collectionId}`,
        libraryID: 1,
        itemIds: [],
        childCollectionCount: 0,
      }),
      deleteCollection: async (params: unknown) => {
        calls.deleted.push(params);
      },
      deleteSavedSearch: async (params: { savedSearchId: number }) => {
        calls.deletedSearches.push(params);
        return { savedSearchId: params.savedSearchId, status: "trashed" };
      },
      getItem: () => null,
      ...overrides,
    };
    return { gateway, calls };
  }

  const context = { request: { conversationKey: 1, libraryID: 1 } } as never;

  it("restores items, collections and saved searches in one call", async function () {
    const { gateway, calls } = makeGateway();
    const service = new LibraryMutationService(gateway as never);

    const outcome = await service.executeOperation(
      {
        type: "restore_from_trash",
        itemIds: [11, 12],
        collectionIds: [42],
        savedSearchIds: [7],
      },
      context,
    );

    assert.deepEqual(calls.items, [{ itemIds: [11, 12] }]);
    assert.deepEqual(calls.collections, [{ collectionIds: [42] }]);
    assert.deepEqual(calls.searches, [{ savedSearchIds: [7] }]);

    const result = (outcome.result as { result: Record<string, number> })
      .result;
    assert.equal(result.restoredItemCount, 2);
    assert.equal(result.restoredCollectionCount, 1);
    assert.equal(result.restoredSavedSearchCount, 1);
    assert.equal(result.restoredCount, 4);
  });

  it("re-trashes only what it actually restored", async function () {
    const { gateway, calls } = makeGateway();
    const service = new LibraryMutationService(gateway as never);

    // 999 was never in the trash, so restoring is a no-op for it. The inverse
    // must not sweep it up — that would trash an item the user still had.
    const outcome = await service.executeOperation(
      { type: "restore_from_trash", itemIds: [11, 999] },
      context,
    );
    assert.deepEqual(outcome.inverse?.inverseOperations, [
      { type: "trash_items", itemIds: [11] },
    ]);
    await replayLibraryInverse(service, outcome, context);

    assert.deepEqual(calls.trashed, [{ itemIds: [11] }]);
  });

  it("re-trashes only the collections and searches actually restored", async function () {
    const { gateway, calls } = makeGateway();
    const service = new LibraryMutationService(gateway as never);

    const outcome = await service.executeOperation(
      {
        type: "restore_from_trash",
        collectionIds: [42, 999],
        savedSearchIds: [7, 999],
      },
      context,
    );
    assert.deepEqual(outcome.inverse?.inverseOperations, [
      { type: "delete_collection", collectionId: 42 },
      { type: "delete_saved_search", savedSearchId: 7 },
    ]);
    await replayLibraryInverse(service, outcome, context);

    assert.deepEqual(calls.deleted, [{ collectionId: 42 }]);
    assert.deepEqual(calls.deletedSearches, [{ savedSearchId: 7 }]);
  });

  it("records no undo when nothing needed restoring", async function () {
    const { gateway } = makeGateway({
      restoreItems: async () => ({ restoredCount: 0, itemIds: [] }),
    });
    const service = new LibraryMutationService(gateway as never);

    const outcome = await service.executeOperation(
      { type: "restore_from_trash", itemIds: [999] },
      context,
    );

    assert.notExists(outcome.inverse);
  });

  it("rejects a call that names nothing to restore", function () {
    const { gateway } = makeGateway();
    const tool = createRestoreFromTrashTool(gateway as never);

    const empty = tool.validate({});
    assert.isFalse(empty.ok);

    const zeroed = tool.validate({ itemIds: [] });
    assert.isFalse(zeroed.ok);

    const valid = tool.validate({ collectionIds: [42] });
    assert.isTrue(valid.ok);
  });
});

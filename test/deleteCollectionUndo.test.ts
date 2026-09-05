import { assert } from "chai";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import { replayLibraryInverse } from "./helpers/replayLibraryInverse";

/**
 * `delete_collection` used to call `eraseTx`, Zotero's *permanent* erase,
 * on the false premise that "Zotero has no trash for collections". It does:
 * `deletedCollections` has backed the Trash pane for years, and Zotero's own
 * "Delete Collection" sets `deleted = true`.
 *
 * So the agent was more destructive than the UI, and the confirmation card
 * told the user the opposite. Deleting now trashes, which also means the
 * inverse is a restore by id rather than a rebuild that minted a new
 * collection and stranded any subtree.
 */
describe("delete_collection reversibility", function () {
  function makeGateway(overrides: Record<string, unknown> = {}) {
    const calls: {
      deleted: unknown[];
      restoredCollections: unknown[];
      restoredItems: unknown[];
    } = { deleted: [], restoredCollections: [], restoredItems: [] };
    const gateway = {
      snapshotCollectionForDelete: () => ({
        name: "Neuro",
        parentCollectionId: 5,
        libraryID: 1,
        itemIds: [11, 12],
        childCollectionCount: 0,
      }),
      deleteCollection: async (params: unknown) => {
        calls.deleted.push(params);
      },
      restoreCollections: async (params: unknown) => {
        calls.restoredCollections.push(params);
        return { restoredCount: 1 };
      },
      restoreItems: async (params: unknown) => {
        calls.restoredItems.push(params);
        return { restoredCount: 2, itemIds: [11, 12] };
      },
      ...overrides,
    };
    return { gateway, calls };
  }

  const context = { request: { conversationKey: 1, libraryID: 1 } } as never;

  it("trashes the collection rather than erasing it", async function () {
    const { gateway, calls } = makeGateway();
    const service = new LibraryMutationService(gateway as never);

    const outcome = await service.executeOperation(
      { type: "delete_collection", collectionId: 42 },
      context,
    );

    assert.deepEqual(calls.deleted, [{ collectionId: 42 }]);
    const result = (outcome.result as { result: { status: string } }).result;
    assert.equal(result.status, "trashed");
  });

  it("records an undo that restores the original collection by id", async function () {
    const { gateway, calls } = makeGateway();
    const service = new LibraryMutationService(gateway as never);

    const outcome = await service.executeOperation(
      { type: "delete_collection", collectionId: 42 },
      context,
    );
    assert.exists(outcome.inverse, "a delete must record an inverse");
    assert.deepEqual(outcome.inverse?.inverseOperations, [
      { type: "restore_from_trash", collectionIds: [42] },
    ]);

    await replayLibraryInverse(service, outcome, context);

    // The original id comes back, so anything referencing it still resolves.
    // The old undo created a *new* collection with a new id instead.
    assert.deepEqual(calls.restoredCollections, [{ collectionIds: [42] }]);
    // Items were never trashed, so restoring them would be wrong.
    assert.deepEqual(calls.restoredItems, []);
  });

  it("deletes a collection with subcollections instead of refusing", async function () {
    const { gateway, calls } = makeGateway({
      snapshotCollectionForDelete: () => ({
        name: "Parent",
        libraryID: 1,
        itemIds: [],
        childCollectionCount: 2,
      }),
    });
    const service = new LibraryMutationService(gateway as never);

    // Previously this threw: a flat snapshot could not restore a subtree, so
    // the only safe answer was refusal. The trash restores the subtree
    // intact, so the refusal is gone.
    const outcome = await service.executeOperation(
      { type: "delete_collection", collectionId: 7 },
      context,
    );

    assert.lengthOf(calls.deleted, 1);
    const result = (
      outcome.result as {
        result: { status: string; childCollectionCount: number };
      }
    ).result;
    assert.equal(result.status, "trashed");
    assert.equal(result.childCollectionCount, 2);
    assert.exists(outcome.inverse);
  });

  it("restores trashed items too, but only when the delete took them", async function () {
    const { gateway, calls } = makeGateway();
    const service = new LibraryMutationService(gateway as never);

    const outcome = await service.executeOperation(
      { type: "delete_collection", collectionId: 42, deleteItems: true },
      context,
    );
    assert.deepEqual(outcome.inverse?.inverseOperations, [
      {
        type: "restore_from_trash",
        collectionIds: [42],
        itemIds: [11, 12],
      },
    ]);
    await replayLibraryInverse(service, outcome, context);

    assert.deepEqual(calls.restoredCollections, [{ collectionIds: [42] }]);
    assert.deepEqual(calls.restoredItems, [{ itemIds: [11, 12] }]);
  });

  it("records no undo for a permanent erase, which has no inverse", async function () {
    const { gateway, calls } = makeGateway();
    const service = new LibraryMutationService(gateway as never);

    const outcome = await service.executeOperation(
      { type: "delete_collection", collectionId: 42, permanent: true },
      context,
    );

    assert.deepEqual(calls.deleted, [{ collectionId: 42, permanent: true }]);
    const result = (outcome.result as { result: { status: string } }).result;
    assert.equal(result.status, "erased");
    // Promising a revert it cannot honour would be worse than admitting none.
    assert.notExists(outcome.inverse);
  });
});

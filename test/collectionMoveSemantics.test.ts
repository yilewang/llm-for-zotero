import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import { replayLibraryInverse } from "./helpers/replayLibraryInverse";

/**
 * `addItemsToCollections` only ever called `addToCollection`, yet the result
 * field was `movedCount`, every row said `status: "moved"`, and the card's
 * button said "Move". Asking to move a paper left it filed in both the old
 * and the new collection.
 */
describe("collection move semantics", function () {
  type FakeItem = {
    id: number;
    libraryID: number;
    collections: number[];
    saves: number;
    isRegularItem: () => boolean;
    isAttachment: () => boolean;
    isNote: () => boolean;
    isAnnotation: () => boolean;
    parentID: false | number;
    getDisplayTitle: () => string;
    getCollections: () => number[];
    addToCollection: (id: number) => void;
    removeFromCollection: (id: number) => void;
    inCollection: (id: number) => boolean;
    getField: (name: string) => string;
    getCreators: () => unknown[];
    getTags: () => unknown[];
    getAttachments: () => number[];
    saveTx: () => Promise<boolean>;
  };

  let items: Map<number, FakeItem>;

  function makeItem(id: number, collections: number[]): FakeItem {
    const item: FakeItem = {
      id,
      libraryID: 1,
      collections: [...collections],
      saves: 0,
      parentID: false,
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
      isAnnotation: () => false,
      getDisplayTitle: () => `Paper ${id}`,
      getCollections: () => [...item.collections],
      addToCollection: (cid: number) => {
        if (!item.collections.includes(cid)) item.collections.push(cid);
      },
      removeFromCollection: (cid: number) => {
        item.collections = item.collections.filter((c) => c !== cid);
      },
      inCollection: (cid: number) => item.collections.includes(cid),
      getField: (name: string) => (name === "title" ? `Paper ${id}` : ""),
      getCreators: () => [],
      getTags: () => [],
      getAttachments: () => [],
      saveTx: async () => {
        item.saves += 1;
        return true;
      },
    };
    return item;
  }

  function makeGateway() {
    const gateway = new ZoteroGateway();
    (gateway as unknown as { getItem: (id: number) => unknown }).getItem = (
      id: number,
    ) => items.get(id) || null;
    (
      gateway as unknown as {
        getCollectionSummary: (id: number) => unknown;
      }
    ).getCollectionSummary = (id: number) =>
      id > 0
        ? { collectionId: id, name: `C${id}`, libraryID: 1, path: `C${id}` }
        : null;
    return gateway;
  }

  beforeEach(function () {
    items = new Map([
      [101, makeItem(101, [10])],
      [102, makeItem(102, [10, 20])],
    ]);
    (globalThis as Record<string, unknown>).Zotero = {
      Items: { get: (id: number) => items.get(id) || null },
      Collections: {
        get: (id: number) =>
          id > 0 ? { id, name: `C${id}`, libraryID: 1 } : null,
      },
      debug: () => undefined,
    };
  });

  afterEach(function () {
    delete (globalThis as Record<string, unknown>).Zotero;
  });

  it("leaves the item in its old collection when adding (unchanged default)", async function () {
    const gateway = makeGateway();
    await gateway.addItemsToCollections({
      assignments: [{ itemId: 101, targetCollectionId: 30 }],
    });
    assert.deepEqual(items.get(101)?.collections, [10, 30]);
  });

  it("actually removes the source collection when moving", async function () {
    const gateway = makeGateway();
    const result = await gateway.addItemsToCollections({
      assignments: [{ itemId: 101, targetCollectionId: 30 }],
      mode: "move",
      from: 10,
    });
    assert.deepEqual(items.get(101)?.collections, [30]);
    assert.equal(result.movedCount, 1);
  });

  it("from:'all' replaces membership entirely", async function () {
    const gateway = makeGateway();
    await gateway.addItemsToCollections({
      assignments: [{ itemId: 102, targetCollectionId: 30 }],
      mode: "move",
      from: "all",
    });
    assert.deepEqual(items.get(102)?.collections, [30]);
  });

  it("from:<id> leaves the item's other collections alone", async function () {
    const gateway = makeGateway();
    await gateway.addItemsToCollections({
      assignments: [{ itemId: 102, targetCollectionId: 30 }],
      mode: "move",
      from: 10,
    });
    // 20 was never mentioned, so it must survive.
    assert.deepEqual(items.get(102)?.collections.sort(), [20, 30]);
  });

  it("keeps every destination when one item has several in one call", async function () {
    const gateway = makeGateway();
    await gateway.addItemsToCollections({
      assignments: [
        { itemId: 101, targetCollectionId: 30 },
        { itemId: 101, targetCollectionId: 31 },
      ],
      mode: "move",
      from: "all",
    });
    // Applying these pairwise would let the second assignment undo the first.
    assert.deepEqual(items.get(101)?.collections.sort(), [30, 31]);
  });

  it("writes each item in a single transaction", async function () {
    const gateway = makeGateway();
    await gateway.addItemsToCollections({
      assignments: [
        { itemId: 102, targetCollectionId: 30 },
        { itemId: 102, targetCollectionId: 31 },
      ],
      mode: "move",
      from: "all",
    });
    // Two adds and two removes, one saveTx: never observable half-moved.
    assert.equal(items.get(102)?.saves, 1);
  });

  it("refuses a move that does not say what to move out of", async function () {
    const gateway = makeGateway();
    let message = "";
    try {
      await gateway.addItemsToCollections({
        assignments: [{ itemId: 101, targetCollectionId: 30 }],
        mode: "move",
      });
      assert.fail("a move without a source must be refused");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // Inferring the source would unfile items from collections the user
    // never mentioned.
    assert.include(message, "explicit source");
  });

  it("undoes a move by restoring the exact prior membership", async function () {
    const gateway = makeGateway();
    const service = new LibraryMutationService(gateway);

    const outcome = await service.executeOperation(
      {
        type: "move_to_collection",
        itemIds: [102],
        targetCollectionId: 30,
        mode: "move",
        from: "all",
      },
      { request: { conversationKey: 1, libraryID: 1 } } as never,
    );
    assert.deepEqual(items.get(102)?.collections, [30]);

    await replayLibraryInverse(service, outcome);

    // The old inverse emitted remove_from_collection, which would have
    // unfiled the item entirely instead of putting 10 and 20 back.
    assert.deepEqual(items.get(102)?.collections.sort(), [10, 20]);
  });

  it("still undoes a plain add by removing only the destination", async function () {
    const gateway = makeGateway();
    const service = new LibraryMutationService(gateway);

    const outcome = await service.executeOperation(
      { type: "move_to_collection", itemIds: [102], targetCollectionId: 30 },
      { request: { conversationKey: 1, libraryID: 1 } } as never,
    );
    await replayLibraryInverse(service, outcome);

    assert.deepEqual(items.get(102)?.collections.sort(), [10, 20]);
  });
});

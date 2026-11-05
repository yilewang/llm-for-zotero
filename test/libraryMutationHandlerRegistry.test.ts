import { assert } from "chai";
import { libraryMutationHandlers } from "../src/agent/services/libraryMutation/handlerRegistry";
import type { LibraryMutationOperationType } from "../src/agent/services/libraryMutation/handlerDefinition";
import {
  createdObjectIdsForLibraryMutation,
  executeMutationFromHandler,
  isRegisteredLibraryMutationOperation,
  mutationPostconditionIsSatisfied,
} from "../src/agent/services/libraryMutation/handlerOperations";
import { MutationStateView } from "../src/agent/services/libraryMutation/stateView";

describe("library mutation handler registry", function () {
  const operationTypes = [
    "update_metadata",
    "change_item_type",
    "apply_tags",
    "remove_tags",
    "move_to_collection",
    "remove_from_collection",
    "create_collection",
    "set_item_collections",
    "save_notes_batch",
    "save_saved_search",
    "delete_saved_search",
    "update_collection",
    "update_library_tag",
    "set_item_tags",
    "create_items",
    "reparent_items",
    "relate_items",
    "delete_collection",
    "save_note",
    "import_identifiers",
    "trash_items",
    "restore_from_trash",
    "merge_items",
    "delete_attachment",
    "rename_attachment",
    "relink_attachment",
    "import_local_files",
    "attach_file",
    "attach_url",
    "find_pdf",
    "update_annotation",
  ] satisfies LibraryMutationOperationType[];

  it("registers every operation exactly once with its safety capabilities", function () {
    assert.sameMembers(Object.keys(libraryMutationHandlers), operationTypes);
    for (const type of operationTypes) {
      const handler = libraryMutationHandlers[type];
      assert.strictEqual(handler.type, type);
      assert.isFunction(handler.validate);
      assert.isFunction(handler.targetCount);
      assert.isFunction(handler.targetItemIds);
      assert.isFunction(handler.actionParameters);
      assert.isFunction(handler.destinationCollectionIds);
      assert.isFunction(handler.additionalActionTargets);
      assert.isFunction(handler.createdItemIds);
      assert.isFunction(handler.createdCollectionIds);
      assert.isFunction(handler.createdSavedSearchIds);
      assert.isFunction(handler.affectedCount);
      assert.isFunction(handler.atomize);
      assert.isArray(handler.stateSections);
      assert.isFunction(handler.deferredInverse);
      assert.isFunction(handler.planInverse);
      assert.isFunction(handler.postconditionSatisfied);
      assert.isFunction(handler.execute);
      assert.include(["state-aware", "forward-only"], handler.replay);
      assert.include(["items", "none"], handler.targetScope);
      assert.include(
        [
          "item-metadata-tags-relations",
          "collection-search-structure",
          "notes-lifecycle",
          "attachments-imports",
        ],
        handler.executionDomain,
      );
    }
  });

  it("binds created IDs only from each handler's declared result shape", function () {
    assert.deepEqual(
      createdObjectIdsForLibraryMutation(
        { type: "create_collection", name: "Methods" },
        {
          result: {
            collection: { collectionId: 42 },
            unrelated: { itemId: 999, savedSearchId: 888 },
          },
        },
      ),
      { itemIds: [], collectionIds: [42], savedSearchIds: [] },
    );
  });

  it("captures collection identity from the actual forward executor result", async function () {
    const operation = {
      type: "create_collection" as const,
      name: "Methods",
      libraryID: 1,
    };
    const execution = await executeMutationFromHandler(
      operation,
      { request: {}, item: null } as never,
      {
        resolveLibraryID: () => 1,
        createCollection: async () => ({
          collectionId: 42,
          name: "Methods",
          libraryID: 1,
          path: "Methods",
        }),
      } as never,
    );
    assert.deepEqual(
      createdObjectIdsForLibraryMutation(operation, execution.result),
      {
        itemIds: [],
        collectionIds: [42],
        savedSearchIds: [],
      },
    );
  });

  it("rejects inherited and malformed discriminants without throwing", function () {
    for (const value of [
      {},
      { type: 1 },
      { type: "unknown" },
      { type: "toString" },
      { type: "constructor" },
      { type: "__proto__" },
    ]) {
      assert.doesNotThrow(() => isRegisteredLibraryMutationOperation(value));
      assert.isFalse(isRegisteredLibraryMutationOperation(value));
    }
  });

  it("compares creator fields canonically while preserving creator order", function () {
    const state = {
      version: 1 as const,
      operation: "update_metadata" as const,
      items: [
        {
          itemId: 1,
          exists: true,
          fields: { title: "Paper" },
          creators: [
            {
              creatorType: "author",
              lastName: "Lovelace",
              firstName: "Ada",
              fieldMode: undefined,
            },
          ],
        },
      ],
    };
    const operation = {
      type: "update_metadata" as const,
      itemId: 1,
      metadata: {
        creators: [
          {
            firstName: "Ada",
            lastName: "Lovelace",
            creatorType: "author",
          },
        ],
      },
    };

    assert.isTrue(mutationPostconditionIsSatisfied(operation, state));
    assert.isFalse(
      mutationPostconditionIsSatisfied(
        {
          ...operation,
          metadata: {
            creators: [
              { lastName: "Hopper", creatorType: "author" },
              { lastName: "Lovelace", creatorType: "author" },
            ],
          },
        },
        state,
      ),
    );
  });

  it("checks a move that files one item into two folders against both at once", function () {
    // mode:'move' with from:'all' leaves the item in exactly the folders the
    // move names; an item given two of them must be judged by both together.
    const operation = {
      type: "move_to_collection" as const,
      mode: "move" as const,
      from: "all" as const,
      assignments: [
        { itemId: 1, targetCollectionId: 10 },
        { itemId: 1, targetCollectionId: 11 },
        { itemId: 2, targetCollectionId: 10 },
      ],
    };
    const captured = (filed: Record<number, number[]>) => ({
      version: 1 as const,
      operation: "move_to_collection" as const,
      items: Object.entries(filed).map(([itemId, collectionIds]) => ({
        itemId: Number(itemId),
        exists: true,
        collectionIds,
      })),
    });
    assert.isTrue(
      mutationPostconditionIsSatisfied(
        operation,
        captured({ 1: [10, 11], 2: [10] }),
      ),
    );
    assert.isFalse(
      mutationPostconditionIsSatisfied(
        operation,
        captured({ 1: [10], 2: [10] }),
      ),
      "an item missing one of its folders fails",
    );
    assert.isFalse(
      mutationPostconditionIsSatisfied(
        operation,
        captured({ 1: [10, 11, 12], 2: [10] }),
      ),
      "an item still in a folder the move left fails",
    );
  });

  it("checks a metadata update that names no item against the one item the write resolved", function () {
    // The live run's patch, as the state reader captures it: getField reads
    // the entered date back, whatever multipart form Zotero stores.
    const operation = {
      type: "update_metadata" as const,
      metadata: { date: "2024", DOI: "10.1234/abcd.loopmupo0g23" },
    };
    const captured = (fields: Record<string, string>, itemIds = [520]) => ({
      version: 1 as const,
      operation: "update_metadata" as const,
      items: itemIds.map((itemId) => ({ itemId, exists: true, fields })),
    });
    assert.isTrue(
      mutationPostconditionIsSatisfied(
        operation,
        captured({ date: "2024", DOI: "10.1234/abcd.loopmupo0g23" }),
      ),
    );
    assert.isFalse(
      mutationPostconditionIsSatisfied(
        operation,
        captured({ date: "2024", DOI: "" }),
      ),
      "a field Zotero did not keep fails",
    );
    assert.isFalse(
      mutationPostconditionIsSatisfied(
        operation,
        captured(
          { date: "2024", DOI: "10.1234/abcd.loopmupo0g23" },
          [520, 521],
        ),
      ),
      "with no named item, two captured items prove nothing",
    );
  });

  it("indexes captured item, collection, and saved-search state once", function () {
    const view = new MutationStateView({
      version: 1,
      operation: "restore_from_trash",
      items: [
        { itemId: 1, exists: true, deleted: false },
        { itemId: 1, exists: true, deleted: true },
      ],
      collections: [
        { collectionId: 2, exists: true, name: "First" },
        { collectionId: 2, exists: true, name: "Duplicate" },
      ],
      savedSearches: [
        { savedSearchId: 3, exists: true, name: "First" },
        { savedSearchId: 3, exists: true, name: "Duplicate" },
      ],
    });

    assert.equal(view.item(1)?.deleted, false);
    assert.equal(view.collection(2)?.name, "First");
    assert.equal(view.savedSearch(3)?.name, "First");
    assert.isUndefined(view.item(99));
    assert.isUndefined(view.collection(99));
    assert.isUndefined(view.savedSearch(99));
  });

  it("classifies 10k and 50k bulk replay state in linear time @speed", function () {
    this.timeout(10_000);
    const measure = (size: number): number => {
      const state = {
        version: 1 as const,
        operation: "set_item_tags" as const,
        items: Array.from({ length: size }, (_, offset) => ({
          itemId: offset + 1,
          exists: true,
          tags: [`tag-${offset + 1}`],
        })),
      };
      const operation = {
        type: "set_item_tags" as const,
        assignments: Array.from({ length: size }, (_, offset) => ({
          itemId: offset + 1,
          tags: [`tag-${offset + 1}`],
        })),
      };
      const samples: number[] = [];
      for (let run = 0; run < 5; run += 1) {
        const started = performance.now();
        assert.isTrue(mutationPostconditionIsSatisfied(operation, state));
        samples.push(performance.now() - started);
      }
      samples.sort((left, right) => left - right);
      return samples[Math.floor(samples.length / 2)];
    };

    const tenThousandMs = measure(10_000);
    const fiftyThousandMs = measure(50_000);
    assert.isBelow(tenThousandMs, 100);
    assert.isBelow(fiftyThousandMs, 250);
    assert.isBelow(
      fiftyThousandMs / Math.max(tenThousandMs, 0.1),
      8,
      `expected linear replay scaling, got ${tenThousandMs.toFixed(1)}ms → ${fiftyThousandMs.toFixed(1)}ms`,
    );
  });
});

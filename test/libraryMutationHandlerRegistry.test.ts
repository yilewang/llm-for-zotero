import { assert } from "chai";
import { libraryMutationHandlers } from "../src/agent/services/libraryMutation/handlerRegistry";
import type { LibraryMutationOperationType } from "../src/agent/services/libraryMutation/handlerDefinition";
import {
  createdObjectIdsForLibraryMutation,
  isRegisteredLibraryMutationOperation,
  mutationPostconditionIsSatisfied,
} from "../src/agent/services/libraryMutation/handlerOperations";
import { MutationStateView } from "../src/agent/services/libraryMutation/stateView";

describe("library mutation handler registry", function () {
  const operationTypes = [
    "update_metadata",
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
            collectionId: 42,
            unrelated: { itemId: 999, savedSearchId: 888 },
          },
        },
      ),
      { itemIds: [], collectionIds: [42], savedSearchIds: [] },
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

  it("classifies 10k and 50k bulk replay state in linear time", function () {
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

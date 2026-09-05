import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import { replayLibraryInverse } from "./helpers/replayLibraryInverse";

/**
 * Three object kinds the matrix declared operable and nothing implemented:
 * a collection could only be created and deleted (so fixing a typo in a
 * folder name meant deleting it and losing the id every filed item
 * referenced), a *tag* could not be renamed or deleted at all (so a typo in a
 * tag used by 500 papers meant 500 removals and 500 additions), and saved
 * searches were entirely invisible.
 */
describe("collections, tags and saved searches as objects", function () {
  let collections: Map<number, Record<string, unknown>>;
  let tagCalls: Array<[string, unknown[]]>;
  let tagNames: Set<string>;
  let searches: Map<number, Record<string, unknown>>;

  function makeCollection(
    id: number,
    name: string,
    parentID: number | false = false,
  ) {
    const collection: Record<string, unknown> = {
      id,
      name,
      parentID,
      libraryID: 1,
      saves: 0,
      getDescendents: () => [],
      saveTx: async () => {
        collection.saves = (collection.saves as number) + 1;
        return true;
      },
    };
    return collection;
  }

  beforeEach(function () {
    collections = new Map([
      [10, makeCollection(10, "Neuro")],
      [20, makeCollection(20, "Methods")],
      [30, makeCollection(30, "Child", 10)],
    ]);
    tagCalls = [];
    tagNames = new Set(["ML"]);
    searches = new Map();

    (globalThis as Record<string, unknown>).Zotero = {
      Collections: { get: (id: number) => collections.get(id) || null },
      Items: { get: () => null },
      Tags: {
        getID: (name: string) => (tagNames.has(name) ? 7 : false),
        getTagItems: async () => [1, 2, 3],
        rename: async (...args: unknown[]) => {
          tagCalls.push(["rename", args]);
          tagNames.delete(String(args[1] || ""));
          tagNames.add(String(args[2] || ""));
        },
        removeFromLibrary: async (...args: unknown[]) => {
          tagCalls.push(["removeFromLibrary", args]);
        },
        setColor: async (...args: unknown[]) => {
          tagCalls.push(["setColor", args]);
        },
      },
      Searches: {
        get: (id: number) => searches.get(id) || null,
        getByLibrary: () => Array.from(searches.values()),
      },
      Search: class {
        id = 99;
        libraryID = 1;
        name = "";
        conditions: unknown[] = [];
        addCondition(condition: string, operator: string, value: unknown) {
          this.conditions.push({ condition, operator, value });
        }
        removeCondition() {}
        getConditions() {
          return {};
        }
        async saveTx() {
          searches.set(this.id, this as unknown as Record<string, unknown>);
          return true;
        }
      },
      SearchConditions: {
        get: (name: string) =>
          name === "tag" || name === "dateAdded" || name === "joinMode"
            ? { operators: { is: true, isAfter: true, any: true, all: true } }
            : undefined,
      },
      debug: () => undefined,
    };
  });

  afterEach(function () {
    delete (globalThis as Record<string, unknown>).Zotero;
  });

  function gateway() {
    const g = new ZoteroGateway();
    (g as unknown as { getItem: () => unknown }).getItem = () => null;
    (g as unknown as { resolveLibraryID: () => number }).resolveLibraryID =
      () => 1;
    return g;
  }

  describe("collections", function () {
    it("renames without losing the id items reference", async function () {
      const result = await gateway().updateCollection({
        collectionId: 10,
        name: "Neuroscience",
      });
      assert.equal(result.status, "updated");
      assert.equal(collections.get(10)?.name, "Neuroscience");
      assert.equal(result.collectionId, 10, "the id survives a rename");
    });

    it("moves under a new parent, and to top level", async function () {
      const g = gateway();
      await g.updateCollection({ collectionId: 20, parentCollectionId: 10 });
      assert.equal(collections.get(20)?.parentID, 10);

      await g.updateCollection({ collectionId: 20, parentCollectionId: null });
      assert.equal(collections.get(20)?.parentID, false);
    });

    it("refuses a move that would detach the subtree", async function () {
      const parent = collections.get(10) as Record<string, unknown>;
      parent.getDescendents = () => [{ id: 30, type: "collection" }];

      const result = await gateway().updateCollection({
        collectionId: 10,
        parentCollectionId: 30,
      });
      // Zotero would accept this and produce a cycle that no longer appears
      // anywhere in the tree.
      assert.equal(result.status, "not_found");
      assert.include(result.reason || "", "inside this one");
    });

    it("refuses to make a collection its own parent", async function () {
      const result = await gateway().updateCollection({
        collectionId: 10,
        parentCollectionId: 10,
      });
      assert.include(result.reason || "", "its own parent");
    });

    it("restores the previous name and parent on undo", async function () {
      const service = new LibraryMutationService(gateway());
      const outcome = await service.executeOperation(
        {
          type: "update_collection",
          collectionId: 30,
          name: "Renamed",
          parentCollectionId: 20,
        },
        { request: { conversationKey: 1, libraryID: 1 } } as never,
      );
      assert.equal(collections.get(30)?.name, "Renamed");
      await replayLibraryInverse(service, outcome);
      assert.equal(collections.get(30)?.name, "Child");
      assert.equal(collections.get(30)?.parentID, 10);
    });
  });

  describe("tags as objects", function () {
    it("renames a tag library-wide in one call", async function () {
      const result = await gateway().updateLibraryTag({
        libraryID: 1,
        action: "rename",
        tag: "ML",
        newTag: "machine learning",
      });
      assert.equal(result.status, "applied");
      assert.equal(result.itemCount, 3);
      assert.deepEqual(tagCalls[0], ["rename", [1, "ML", "machine learning"]]);
    });

    it("reports a tag that does not exist", async function () {
      const result = await gateway().updateLibraryTag({
        libraryID: 1,
        action: "delete",
        tag: "gone",
      });
      assert.equal(result.status, "not_found");
      assert.deepEqual(tagCalls, []);
    });

    it("admits that deleting a tag cannot be undone", async function () {
      const service = new LibraryMutationService(gateway());
      const outcome = await service.executeOperation(
        { type: "update_library_tag", action: "delete", tag: "ML" },
        { request: { conversationKey: 1, libraryID: 1 } } as never,
      );
      // Which items carried the tag is gone with it, so offering an undo
      // would promise a restore that restores nothing.
      assert.include(
        outcome.inverse?.irreversibleReason || "",
        "cannot be restored",
      );
    });

    it("does not advertise a lossy tag merge as reversible", async function () {
      const service = new LibraryMutationService(gateway());
      const outcome = await service.executeOperation(
        {
          type: "update_library_tag",
          action: "merge",
          tag: "ML",
          newTag: "machine learning",
        },
        { request: { conversationKey: 1, libraryID: 1 } } as never,
      );

      assert.notExists(outcome.inverse?.inverseOperations);
      assert.include(
        outcome.inverse?.irreversibleReason || "",
        "cannot be separated",
      );
    });

    it("uses the same lossless-rename decision for planning and execution", async function () {
      const service = new LibraryMutationService(gateway());
      const operation = {
        type: "update_library_tag" as const,
        action: "rename" as const,
        tag: "ML",
        newTag: "machine learning",
      };
      const reversible = await service.planOperation(operation, {
        request: { conversationKey: 1, libraryID: 1 },
      } as never);
      assert.equal(reversible.reversibility, "full");

      tagNames.add("machine learning");
      const lossy = await service.planOperation(operation, {
        request: { conversationKey: 1, libraryID: 1 },
      } as never);
      const outcome = await service.executeOperation(operation, {
        request: { conversationKey: 1, libraryID: 1 },
      } as never);

      assert.equal(lossy.reversibility, "none");
      assert.notExists(outcome.inverse?.inverseOperations);
      assert.include(
        outcome.inverse?.irreversibleReason || "",
        "cannot be separated",
      );
    });

    it("renames back on undo", async function () {
      const service = new LibraryMutationService(gateway());
      const outcome = await service.executeOperation(
        {
          type: "update_library_tag",
          action: "rename",
          tag: "ML",
          newTag: "machine learning",
        },
        { request: { conversationKey: 1, libraryID: 1 } } as never,
      );
      await replayLibraryInverse(service, outcome);
      assert.deepEqual(tagCalls.at(-1), [
        "rename",
        [1, "machine learning", "ML"],
      ]);
    });
  });

  describe("exact tag sets", function () {
    it("replaces an item's tags rather than adding to them", async function () {
      const item = {
        id: 5,
        libraryID: 1,
        parentID: false,
        isRegularItem: () => true,
        isAttachment: () => false,
        isNote: () => false,
        isAnnotation: () => false,
        getDisplayTitle: () => "Paper",
        getTags: () => [{ tag: "old-one" }, { tag: "old-two" }],
        setTags: (tags: string[]) => {
          item.current = tags;
        },
        saveTx: async () => true,
        current: [] as string[],
      };
      const g = gateway();
      (g as unknown as { getItem: () => unknown }).getItem = () => item;

      const result = await g.setItemTags({
        assignments: [{ itemId: 5, tags: ["new-one"] }],
      });
      // Add-only assignment is why "exactly these 20 tags" drifted.
      assert.deepEqual(item.current, ["new-one"]);
      assert.deepEqual(result.items[0].previousTags, ["old-one", "old-two"]);
    });
  });

  describe("saved searches", function () {
    it("saves a condition set and lists it back", async function () {
      const g = gateway();
      const saved = await g.saveSavedSearch({
        libraryID: 1,
        name: "To read",
        conditions: [{ condition: "tag", operator: "is", value: "to-read" }],
      });
      assert.equal(saved.status, "created");
      assert.equal(saved.name, "To read");

      const listed = g.listSavedSearches(1);
      assert.lengthOf(listed, 1);
    });

    it("validates conditions before saving, like library_search does", async function () {
      let message = "";
      try {
        await gateway().saveSavedSearch({
          libraryID: 1,
          name: "Bad",
          conditions: [{ condition: "notAThing", operator: "is" }],
        });
        assert.fail("expected a rejection");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.include(message, "notAThing");
    });

    it("deletes a newly created search on undo", async function () {
      const service = new LibraryMutationService(gateway());
      const outcome = await service.executeOperation(
        {
          type: "save_saved_search",
          name: "Temp",
          conditions: [{ condition: "tag", operator: "is", value: "x" }],
        },
        { request: { conversationKey: 1, libraryID: 1 } } as never,
      );
      assert.exists(outcome.inverse);
    });
  });
});

import { assert } from "chai";
import {
  TagCapability,
  type TagCapabilityDeps,
} from "../src/agent/services/zotero/tagCapability";

/**
 * The tag paths used to live on `ZoteroGateway` and reached the item lookup
 * through `this`. They now take that lookup as a dependency, so this file
 * drives the capability on its own — the same behaviour
 * `collectionsTagsSavedSearches.test.ts` and
 * `collectionMembershipObjectModel.test.ts` pin through the facade, asserted
 * here against the seam the facade fills in.
 */
describe("tag capability", function () {
  let items: Map<number, FakeItem>;
  let tagCalls: Array<[string, unknown[]]>;
  let tagNames: Map<string, number>;

  const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };
  const originalZotero = globalScope.Zotero;

  type FakeItem = {
    id: number;
    tags: string[];
    saves: number;
    isRegularItem: () => boolean;
    isNote: () => boolean;
    isAttachment: () => boolean;
    isAnnotation: () => boolean;
    parentID: number | false;
    getDisplayTitle: () => string;
    getField: (name: string) => string;
    getCreators: () => unknown[];
    getTags: () => Array<{ tag: string }>;
    getAttachments: () => number[];
    hasTag: (tag: string) => boolean;
    addTag: (tag: string) => void;
    removeTag: (tag: string) => void;
    setTags: (tags: string[]) => void;
    saveTx: () => Promise<boolean>;
  };

  function makeItem(seed: {
    id: number;
    tags?: string[];
    kind?: "regular" | "note" | "attachment";
    parentID?: number | false;
  }): FakeItem {
    const item: FakeItem = {
      id: seed.id,
      tags: [...(seed.tags || [])],
      saves: 0,
      parentID: seed.parentID ?? false,
      isRegularItem: () => (seed.kind || "regular") === "regular",
      isNote: () => seed.kind === "note",
      isAttachment: () => seed.kind === "attachment",
      isAnnotation: () => false,
      getDisplayTitle: () => `Paper ${seed.id}`,
      getField: (name: string) => (name === "title" ? `Paper ${seed.id}` : ""),
      getCreators: () => [],
      getTags: () => item.tags.map((tag) => ({ tag })),
      getAttachments: () => [],
      hasTag: (tag: string) => item.tags.includes(tag),
      addTag: (tag: string) => {
        item.tags.push(tag);
      },
      removeTag: (tag: string) => {
        item.tags = item.tags.filter((entry) => entry !== tag);
      },
      setTags: (tags: string[]) => {
        item.tags = [...tags];
      },
      saveTx: async () => {
        item.saves += 1;
        return true;
      },
    };
    items.set(seed.id, item);
    return item;
  }

  beforeEach(function () {
    items = new Map();
    tagCalls = [];
    tagNames = new Map([["ML", 7]]);
    globalScope.Zotero = {
      Items: { get: (id: number) => items.get(id) || null },
      Tags: {
        getAll: async () => [
          { tag: "Neuroscience", type: 0 },
          { tag: "machine learning", type: 1 },
          { tag: "ML", type: 0 },
        ],
        getID: (name: string) => tagNames.get(name) ?? false,
        getTagItems: async () => [1, 2, 3],
        rename: async (...args: unknown[]) => {
          tagCalls.push(["rename", args]);
        },
        removeFromLibrary: async (...args: unknown[]) => {
          tagCalls.push(["removeFromLibrary", args]);
        },
        setColor: async (...args: unknown[]) => {
          tagCalls.push(["setColor", args]);
        },
      },
      debug: () => undefined,
    };
  });

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  /** The capability under test, with every dependency answered explicitly. */
  function capability(deps: Partial<TagCapabilityDeps> = {}) {
    return new TagCapability({
      getItem: (itemId) =>
        (items.get(Number(itemId)) as unknown as Zotero.Item) || null,
      resolveBibliographicItem: (item) => item ?? null,
      ...deps,
    });
  }

  describe("reading the tags a library holds", function () {
    it("returns every tag with its type", async function () {
      const result = await capability().listLibraryTags({ libraryID: 1 });

      assert.deepEqual(result.tags, [
        { name: "Neuroscience", type: 0 },
        { name: "machine learning", type: 1 },
        { name: "ML", type: 0 },
      ]);
      assert.equal(result.totalCount, 3);
    });

    it("matches a query case-insensitively and honours the limit", async function () {
      const result = await capability().listLibraryTags({
        libraryID: 1,
        query: "M",
        limit: 1,
      });

      assert.deepEqual(result.tags, [{ name: "machine learning", type: 1 }]);
      // The limit caps the page, not the count: two tags contain "m".
      assert.equal(result.totalCount, 2);
    });

    it("pages with offset so every tag is reachable", async function () {
      const first = await capability().listLibraryTags({
        libraryID: 1,
        limit: 2,
      });
      const second = await capability().listLibraryTags({
        libraryID: 1,
        limit: 2,
        offset: 2,
      });

      assert.deepEqual(
        first.tags.map((tag) => tag.name),
        ["Neuroscience", "machine learning"],
      );
      assert.deepEqual(
        second.tags.map((tag) => tag.name),
        ["ML"],
      );
      assert.equal(first.totalCount, 3);
      assert.equal(second.totalCount, 3);
    });

    it("refuses to guess a library", async function () {
      try {
        await capability().listLibraryTags({ libraryID: 0 });
        assert.fail("a missing library must not be treated as library 0");
      } catch (error) {
        assert.include(String(error), "No active library available");
      }
    });
  });

  describe("adding tags to items", function () {
    it("adds what is missing, skips what is already there, and saves once", async function () {
      const item = makeItem({ id: 11, tags: ["ML"] });

      const result = await capability().applyTagAssignments({
        assignments: [{ itemId: 11, tags: ["ML", "Neuroscience"] }],
      });

      assert.deepEqual(item.tags, ["ML", "Neuroscience"]);
      assert.equal(item.saves, 1, "one transaction per item");
      assert.equal(result.updatedCount, 1);
      assert.deepEqual(result.items[0].addedTags, ["Neuroscience"]);
      assert.deepEqual(result.items[0].skippedTags, ["ML"]);
      assert.equal(result.items[0].status, "updated");
    });

    it("reports an item that has every tag already as skipped, with no write", async function () {
      const item = makeItem({ id: 11, tags: ["ML"] });

      const result = await capability().applyTagAssignments({
        assignments: [{ itemId: 11, tags: ["ML"] }],
      });

      assert.equal(item.saves, 0);
      assert.equal(result.updatedCount, 0);
      assert.equal(result.skippedCount, 1);
      assert.equal(result.items[0].status, "skipped");
      assert.equal(result.items[0].reason, "All tags already existed");
    });

    it("tags a standalone note, which the regular-item filter used to reject", async function () {
      const note = makeItem({ id: 12, kind: "note" });

      const result = await capability().applyTagAssignments({
        assignments: [{ itemId: 12, tags: ["ML"] }],
      });

      assert.deepEqual(note.tags, ["ML"]);
      assert.equal(result.items[0].status, "updated");
    });

    it("says which item is missing rather than failing the batch", async function () {
      makeItem({ id: 11 });

      const result = await capability().applyTagAssignments({
        assignments: [
          { itemId: 11, tags: ["ML"] },
          { itemId: 404, tags: ["ML"] },
        ],
      });

      assert.equal(result.selectedCount, 2);
      assert.equal(result.updatedCount, 1);
      assert.equal(result.items[1].status, "missing");
      assert.include(result.items[1].reason || "", "No item with ID 404");
      assert.deepEqual(result.items[1].skippedTags, ["ML"]);
    });

    it("reads every item through the injected lookup", async function () {
      const asked: Array<number | undefined> = [];
      const item = makeItem({ id: 11 });

      await capability({
        getItem: (itemId) => {
          asked.push(itemId);
          return item as unknown as Zotero.Item;
        },
      }).applyTagAssignments({
        assignments: [{ itemId: 11, tags: ["ML"] }],
      });

      assert.deepEqual(asked, [11], "the capability never resolves it itself");
    });

    it("rejects a batch with nothing valid in it", async function () {
      try {
        await capability().applyTagAssignments({
          assignments: [{ itemId: 0, tags: ["ML"] }],
        });
        assert.fail("an empty batch must not report success");
      } catch (error) {
        assert.include(String(error), "No valid tag assignments");
      }
    });
  });

  describe("replacing an item's tag set", function () {
    it("writes exactly the given set and reports the prior one", async function () {
      const item = makeItem({ id: 11, tags: ["old", "keep"] });

      const result = await capability().setItemTags({
        assignments: [{ itemId: 11, tags: ["keep", "new"] }],
      });

      assert.deepEqual(item.tags, ["keep", "new"], "removals happen too");
      assert.equal(result.changedCount, 1);
      assert.deepEqual(
        result.items[0].previousTags,
        ["old", "keep"],
        "the prior set is the only thing an inverse can restore",
      );
    });

    it("leaves an item whose set already matches untouched", async function () {
      const item = makeItem({ id: 11, tags: ["a", "b"] });

      const result = await capability().setItemTags({
        assignments: [{ itemId: 11, tags: ["b", "a"] }],
      });

      assert.equal(item.saves, 0, "order is not a change");
      assert.equal(result.changedCount, 0);
      assert.equal(result.items[0].status, "skipped");
    });

    it("reports a refusal per item instead of throwing", async function () {
      const result = await capability().setItemTags({
        assignments: [{ itemId: 404, tags: ["a"] }],
      });

      assert.equal(result.changedCount, 0);
      assert.equal(result.items[0].status, "error");
      assert.include(result.items[0].reason || "", "No item with ID 404");
    });
  });

  describe("removing tags", function () {
    it("reports only the tags that were actually on the item", async function () {
      const item = makeItem({ id: 11, tags: ["ML", "keep"] });

      const result = await capability().removeTagsFromItem({
        itemId: 11,
        tags: ["ML", "never-there"],
      });

      assert.deepEqual(result.removed, ["ML"]);
      assert.deepEqual(item.tags, ["keep"]);
      assert.equal(item.saves, 1);
    });

    it("writes nothing when no requested tag is present", async function () {
      const item = makeItem({ id: 11, tags: ["keep"] });

      const result = await capability().removeTagsFromItem({
        itemId: 11,
        tags: ["absent"],
      });

      assert.deepEqual(result.removed, []);
      assert.equal(item.saves, 0);
    });
  });

  describe("the tag itself as an object", function () {
    it("renames a tag and reports that the destination was free", async function () {
      const result = await capability().updateLibraryTag({
        libraryID: 1,
        action: "rename",
        tag: "ML",
        newTag: "Machine learning",
      });

      assert.equal(result.status, "applied");
      assert.equal(result.newTag, "Machine learning");
      assert.isFalse(
        result.destinationExisted,
        "nothing is merged away by this rename",
      );
      assert.equal(result.itemCount, 3);
      assert.deepEqual(tagCalls[0], ["rename", [1, "ML", "Machine learning"]]);
    });

    it("warns that a rename onto an existing tag is a merge", async function () {
      tagNames.set("Neuro", 9);

      const result = await capability().updateLibraryTag({
        libraryID: 1,
        action: "rename",
        tag: "ML",
        newTag: "Neuro",
      });

      assert.equal(result.status, "applied");
      assert.isTrue(
        result.destinationExisted,
        "a lossy rename must never be advertised as fully reversible",
      );
    });

    it("deletes a tag across the library", async function () {
      const result = await capability().updateLibraryTag({
        libraryID: 1,
        action: "delete",
        tag: "ML",
      });

      assert.equal(result.status, "applied");
      assert.deepEqual(tagCalls[0], ["removeFromLibrary", [1, [7]]]);
    });

    it("reports a tag that does not exist instead of writing", async function () {
      const result = await capability().updateLibraryTag({
        libraryID: 1,
        action: "delete",
        tag: "absent",
      });

      assert.equal(result.status, "not_found");
      assert.include(result.reason || "", 'No tag named "absent"');
      assert.lengthOf(tagCalls, 0);
    });

    it("colours a tag that does not exist yet", async function () {
      const result = await capability().updateLibraryTag({
        libraryID: 1,
        action: "setColor",
        tag: "brand new",
        color: "#FF6666",
        position: 2,
      });

      assert.equal(result.status, "applied");
      assert.deepEqual(tagCalls[0], [
        "setColor",
        [1, "brand new", "#FF6666", 2],
      ]);
    });

    it("asks for the colour rather than guessing one", async function () {
      const result = await capability().updateLibraryTag({
        libraryID: 1,
        action: "setColor",
        tag: "ML",
      });

      assert.equal(result.status, "error");
      assert.include(result.reason || "", "setColor");
      assert.lengthOf(tagCalls, 0);
    });

    it("reports a build without a tag API instead of throwing", async function () {
      globalScope.Zotero = { Items: { get: () => null } };

      const result = await capability().updateLibraryTag({
        libraryID: 1,
        action: "delete",
        tag: "ML",
      });

      assert.equal(result.status, "error");
      assert.include(result.reason || "", "Zotero.Tags is not available");
    });
  });
});

import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import { replayLibraryInverse } from "./helpers/replayLibraryInverse";

/**
 * Item creation, reparenting and related links were all declared `allowed` by
 * the capability matrix and implemented by nothing — so "add this book by
 * hand", "move that note onto the paper" and "link these two" had no path but
 * a raw script.
 */
describe("item creation, reparenting and relations", function () {
  const FIELD_IDS: Record<string, number> = {
    title: 1,
    publisher: 2,
    date: 3,
    numPages: 4,
  };
  const VALID_FOR_TYPE: Record<number, number[]> = { 1: [1, 2, 3, 4] };

  type FakeItem = {
    id: number;
    libraryID: number;
    itemTypeID: number;
    parentID: number | false;
    fields: Record<string, string>;
    tags: string[];
    collections: number[];
    related: number[];
    saves: number;
    isRegularItem: () => boolean;
    isAttachment: () => boolean;
    isNote: () => boolean;
    isAnnotation: () => boolean;
    getField: (name: string) => string;
    setField: (name: string, value: string) => boolean;
    setCreators: (creators: unknown[]) => void;
    addTag: (tag: string) => void;
    addToCollection: (id: number) => void;
    getDisplayTitle: () => string;
    getCreatorsJSON: () => unknown[];
    addRelatedItem: (other: FakeItem) => boolean;
    removeRelatedItem: (other: FakeItem) => Promise<boolean>;
    save: () => Promise<boolean>;
    saveTx: () => Promise<boolean>;
  };

  let items: Map<number, FakeItem>;
  let nextId: number;
  let created: FakeItem[];

  function makeItem(over: Partial<FakeItem> = {}): FakeItem {
    const item: FakeItem = {
      id: nextId++,
      libraryID: 1,
      itemTypeID: 1,
      parentID: false,
      fields: {},
      tags: [],
      collections: [],
      related: [],
      saves: 0,
      isRegularItem: () => !item.parentID,
      isAttachment: () => false,
      isNote: () => Boolean(item.parentID),
      isAnnotation: () => false,
      getField: (name) => item.fields[name] || "",
      setField: (name, value) => {
        item.fields[name] = value;
        return true;
      },
      setCreators: () => undefined,
      addTag: (tag) => item.tags.push(tag),
      addToCollection: (id) => item.collections.push(id),
      getDisplayTitle: () => item.fields.title || `Item ${item.id}`,
      getCreatorsJSON: () => [],
      addRelatedItem: (other) => {
        if (item.related.includes(other.id)) return false;
        item.related.push(other.id);
        return true;
      },
      removeRelatedItem: async (other) => {
        if (!item.related.includes(other.id)) return false;
        item.related = item.related.filter((id) => id !== other.id);
        return true;
      },
      save: async () => {
        item.saves += 1;
        return true;
      },
      saveTx: async () => {
        item.saves += 1;
        return true;
      },
      ...over,
    };
    return item;
  }

  beforeEach(function () {
    nextId = 100;
    items = new Map();
    created = [];

    class FakeZoteroItem {
      constructor(_type: string) {
        const item = makeItem();
        created.push(item);
        items.set(item.id, item);
        return item as unknown as FakeZoteroItem;
      }
    }

    (globalThis as Record<string, unknown>).Zotero = {
      Item: FakeZoteroItem,
      Items: { get: (id: number) => items.get(id) || null },
      ItemTypes: {
        getID: (name: string) => (name === "book" ? 1 : false),
        getName: () => "book",
        getTypes: () => [{ id: 1, name: "book" }],
        getLocalizedString: () => "Book",
      },
      ItemFields: {
        getID: (name: string) => FIELD_IDS[name] || false,
        getName: (id: number) =>
          Object.keys(FIELD_IDS).find((k) => FIELD_IDS[k] === id) || "",
        isValidForType: (fieldId: number, typeId: number) =>
          (VALID_FOR_TYPE[typeId] || []).includes(fieldId),
        getFieldIDFromTypeAndBase: (_t: number, base: number) => base,
        getItemTypeFields: (typeId: number) => VALID_FOR_TYPE[typeId] || [],
      },
      CreatorTypes: { itemTypeHasCreators: () => true },
      DB: {
        executeTransaction: async (task: () => Promise<void>) => task(),
      },
      debug: () => undefined,
    };
  });

  afterEach(function () {
    delete (globalThis as Record<string, unknown>).Zotero;
  });

  function gateway() {
    const g = new ZoteroGateway();
    (g as unknown as { getItem: (id: number) => unknown }).getItem = (
      id: number,
    ) => items.get(id) || null;
    (
      g as unknown as { getCollectionSummary: (id: number) => unknown }
    ).getCollectionSummary = (id: number) => ({
      collectionId: id,
      name: `C${id}`,
      libraryID: 1,
    });
    return g;
  }

  describe("creating items", function () {
    it("creates an item of any type with fields, tags and collections", async function () {
      const result = await gateway().createItems({
        libraryID: 1,
        items: [
          {
            itemType: "book",
            fields: { title: "Perceptrons", date: "1969" },
            tags: ["classic"],
            collections: [42],
          },
        ],
      });

      assert.equal(result.createdCount, 1);
      const item = created[0];
      assert.equal(item.fields.title, "Perceptrons");
      assert.deepEqual(item.tags, ["classic"]);
      assert.deepEqual(item.collections, [42]);
    });

    it("rejects an unknown item type with a way to find the real ones", async function () {
      const result = await gateway().createItems({
        libraryID: 1,
        items: [{ itemType: "novel" }],
      });
      assert.equal(result.createdCount, 0);
      assert.include(result.items[0].reason || "", "itemTypes");
    });

    it("rejects a field the type does not have rather than dropping it", async function () {
      const result = await gateway().createItems({
        libraryID: 1,
        items: [{ itemType: "book", fields: { issue: "3" } }],
      });
      assert.equal(result.createdCount, 0);
      assert.include(result.items[0].reason || "", "issue");
      assert.include(result.items[0].reason || "", "Valid fields");
    });

    it("undoes creation by trashing, not erasing", async function () {
      const g = gateway();
      const trashed: number[][] = [];
      (
        g as unknown as { trashItems: (p: { itemIds: number[] }) => unknown }
      ).trashItems = async (p) => {
        trashed.push(p.itemIds);
        return { trashedCount: p.itemIds.length, items: [] };
      };
      (g as unknown as { resolveLibraryID: () => number }).resolveLibraryID =
        () => 1;
      const service = new LibraryMutationService(g);

      const outcome = await service.executeOperation(
        { type: "create_items", items: [{ itemType: "book" }] },
        { request: { conversationKey: 1, libraryID: 1 } } as never,
      );
      await replayLibraryInverse(service, outcome);
      assert.deepEqual(trashed, [[created[0].id]]);
    });
  });

  describe("reparenting", function () {
    it("attaches a note to a paper and detaches it again", async function () {
      const paper = makeItem();
      const note = makeItem({ parentID: false });
      note.isNote = () => true;
      note.isRegularItem = () => false;
      items.set(paper.id, paper);
      items.set(note.id, note);

      const g = gateway();
      await g.reparentItems({
        assignments: [{ itemId: note.id, parentItemId: paper.id }],
      });
      assert.equal(note.parentID, paper.id);

      await g.reparentItems({
        assignments: [{ itemId: note.id, parentItemId: null }],
      });
      assert.equal(note.parentID, false);
    });

    it("refuses a parent that cannot hold children", async function () {
      const noteA = makeItem();
      noteA.isNote = () => true;
      noteA.isRegularItem = () => false;
      const noteB = makeItem();
      noteB.isNote = () => true;
      noteB.isRegularItem = () => false;
      items.set(noteA.id, noteA);
      items.set(noteB.id, noteB);

      const result = await gateway().reparentItems({
        assignments: [{ itemId: noteA.id, parentItemId: noteB.id }],
      });
      assert.equal(result.items[0].status, "error");
      assert.include(result.items[0].reason || "", "cannot hold children");
    });

    it("sends each item back to its own previous parent on undo", async function () {
      const p1 = makeItem();
      const p2 = makeItem();
      const noteA = makeItem({ parentID: p1.id });
      noteA.isNote = () => true;
      noteA.isRegularItem = () => false;
      const noteB = makeItem({ parentID: false });
      noteB.isNote = () => true;
      noteB.isRegularItem = () => false;
      for (const item of [p1, p2, noteA, noteB]) items.set(item.id, item);

      const service = new LibraryMutationService(gateway());
      const outcome = await service.executeOperation(
        {
          type: "reparent_items",
          assignments: [
            { itemId: noteA.id, parentItemId: p2.id },
            { itemId: noteB.id, parentItemId: p2.id },
          ],
        },
        { request: { conversationKey: 1, libraryID: 1 } } as never,
      );
      assert.equal(noteA.parentID, p2.id);
      assert.equal(noteB.parentID, p2.id);

      await replayLibraryInverse(service, outcome);
      // One blanket inverse cannot express this: they came from different
      // places, and one of them came from top level.
      assert.equal(noteA.parentID, p1.id);
      assert.equal(noteB.parentID, false);
    });
  });

  describe("related links", function () {
    it("links both sides, because Zotero relations are bidirectional", async function () {
      const a = makeItem();
      const b = makeItem();
      items.set(a.id, a);
      items.set(b.id, b);

      await gateway().relateItems({
        itemId: a.id,
        relatedItemIds: [b.id],
        action: "add",
      });
      assert.deepEqual(a.related, [b.id]);
      assert.deepEqual(b.related, [a.id]);
      assert.equal(a.saves, 1);
      assert.equal(b.saves, 1);
    });

    it("rolls back both in-memory directions when the atomic save fails", async function () {
      const a = makeItem();
      const b = makeItem({
        save: async () => {
          throw new Error("second relation save failed");
        },
      });
      items.set(a.id, a);
      items.set(b.id, b);

      const result = await gateway().relateItems({
        itemId: a.id,
        relatedItemIds: [b.id],
        action: "add",
      });

      assert.equal(result.items[0].status, "error");
      assert.deepEqual(a.related, []);
      assert.deepEqual(b.related, []);
    });

    it("refuses to relate an item to itself", async function () {
      const a = makeItem();
      items.set(a.id, a);
      const result = await gateway().relateItems({
        itemId: a.id,
        relatedItemIds: [a.id],
        action: "add",
      });
      assert.equal(result.items[0].status, "skipped");
      assert.deepEqual(a.related, []);
    });

    it("unlinks on undo, and only what it actually linked", async function () {
      const a = makeItem();
      const b = makeItem();
      const c = makeItem();
      c.addRelatedItem = () => false; // already related
      for (const item of [a, b, c]) items.set(item.id, item);

      const service = new LibraryMutationService(gateway());
      const outcome = await service.executeOperation(
        {
          type: "relate_items",
          itemId: a.id,
          relatedItemIds: [b.id, c.id],
          action: "add",
        },
        { request: { conversationKey: 1, libraryID: 1 } } as never,
      );
      await replayLibraryInverse(service, outcome);
      assert.deepEqual(a.related, []);
      assert.deepEqual(b.related, []);
    });
  });
});

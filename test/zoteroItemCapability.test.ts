import { assert } from "chai";
import { libraryIndexService } from "../src/services/libraryIndexService";
import {
  ItemCapability,
  type ItemCapabilityDeps,
} from "../src/agent/services/zotero/itemCapability";

/**
 * The item paths used to live on `ZoteroGateway` and reached the item and
 * collection-summary lookups through `this`. They now take those lookups as
 * dependencies, so this file drives the capability on its own — the same
 * behaviour `itemStructure.test.ts`, `metadataFieldWidening.test.ts`,
 * `librarySearchConditions.test.ts`, `librarySearchYearFilter.test.ts` and
 * `mergeDelegatesToZotero.test.ts` pin through the facade, asserted here
 * against the seam the facade fills in.
 *
 * The four index-backed `list*ItemTargets` reads are covered here for the
 * first time: they were reachable only through the facade before, and the
 * library index they page over is built from live Zotero objects, so the
 * fixture installs a real library rather than a stubbed snapshot.
 */
describe("item capability", function () {
  // A small but faithful slice of Zotero's field table, with one base field
  // that carries a type-specific name (publicationTitle -> bookTitle).
  const FIELD_IDS: Record<string, number> = {
    title: 1,
    publicationTitle: 2,
    bookTitle: 3,
    publisher: 4,
    accessDate: 5,
    date: 6,
    abstractNote: 7,
    DOI: 8,
  };
  const FIELD_NAMES = Object.fromEntries(
    Object.entries(FIELD_IDS).map(([name, id]) => [id, name]),
  );
  /** itemTypeID 1 = journalArticle, 2 = bookSection. */
  const VALID_FOR_TYPE: Record<number, number[]> = {
    1: [1, 2, 4, 5, 6, 7, 8],
    2: [1, 3, 4, 6, 7, 8],
  };
  const TYPE_NAMES: Record<number, string> = {
    1: "journalArticle",
    2: "bookSection",
  };

  type FakeItem = {
    id: number;
    libraryID: number;
    itemTypeID: number;
    parentID: number | false;
    deleted: boolean;
    fields: Record<string, string>;
    tags: Array<{ tag: string; type?: number }>;
    collections: number[];
    creators: unknown[];
    saves: number;
    setFieldCalls: Array<[string, string]>;
    firstCreator: string;
    dateAdded: string;
    dateModified: string;
    isRegularItem: () => boolean;
    isNote: () => boolean;
    isAttachment: () => boolean;
    isAnnotation: () => boolean;
    getField: (
      name: string,
      unformatted?: boolean,
      baseMapped?: boolean,
    ) => string;
    setField: (name: string, value: string) => boolean;
    setCreators: (creators: unknown[]) => void;
    getCreatorsJSON: () => unknown[];
    getDisplayTitle: () => string;
    getAttachments: () => number[];
    getNotes: () => number[];
    getTags: () => Array<{ tag: string; type?: number }>;
    getCollections: () => number[];
    addTag: (tag: string) => void;
    addToCollection: (collectionId: number) => void;
    saveTx: () => Promise<boolean>;
  };

  type FakeCollection = {
    id: number;
    name: string;
    libraryID: number;
    parentID: number | false;
    deleted: boolean;
    getChildItems: (asIDs: true, includeDeleted?: boolean) => number[];
    getChildCollections: (asIDs: true) => number[];
  };

  let items: Map<number, FakeItem>;
  let collections: Map<number, FakeCollection>;
  let created: FakeItem[];

  const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };
  const originalZotero = globalScope.Zotero;

  function makeItem(seed: {
    id: number;
    itemTypeID?: number;
    title?: string;
    fields?: Record<string, string>;
    tags?: Array<{ tag: string; type?: number }>;
    collections?: number[];
    deleted?: boolean;
    dateAdded?: string;
    firstCreator?: string;
  }): FakeItem {
    const item: FakeItem = {
      id: seed.id,
      libraryID: 1,
      itemTypeID: seed.itemTypeID ?? 1,
      parentID: false,
      deleted: seed.deleted ?? false,
      fields: {
        title: seed.title ?? `Paper ${seed.id}`,
        ...(seed.fields || {}),
      },
      tags: seed.tags || [],
      collections: [...(seed.collections || [])],
      creators: [],
      saves: 0,
      setFieldCalls: [],
      firstCreator: seed.firstCreator ?? "",
      dateAdded: seed.dateAdded ?? `2024-01-0${(seed.id % 9) + 1}`,
      dateModified: "2024-02-01",
      isRegularItem: () => true,
      isNote: () => false,
      isAttachment: () => false,
      isAnnotation: () => false,
      getField: (name, _unformatted, baseMapped) => {
        if (name === "dateAdded") return item.dateAdded;
        if (
          baseMapped &&
          name === "publicationTitle" &&
          item.itemTypeID === 2
        ) {
          return item.fields.bookTitle || "";
        }
        return item.fields[name] || "";
      },
      setField: (name, value) => {
        item.setFieldCalls.push([name, value]);
        // Mirror Zotero: a value it cannot parse is refused, not thrown.
        if (name === "accessDate" && !/^\d{4}/.test(value)) return false;
        item.fields[name] = value;
        return true;
      },
      setCreators: (creators) => {
        item.creators = creators;
      },
      getCreatorsJSON: () => item.creators,
      getDisplayTitle: () => item.fields.title || `Item ${item.id}`,
      getAttachments: () => [],
      getNotes: () => [],
      getTags: () => item.tags,
      getCollections: () => [...item.collections],
      addTag: (tag: string) => {
        item.tags.push({ tag });
      },
      addToCollection: (collectionId: number) => {
        item.collections.push(collectionId);
      },
      saveTx: async () => {
        item.saves += 1;
        return true;
      },
    };
    items.set(seed.id, item);
    return item;
  }

  function makeCollection(seed: {
    id: number;
    name: string;
    childItemIds?: number[];
  }): FakeCollection {
    const collection: FakeCollection = {
      id: seed.id,
      name: seed.name,
      libraryID: 1,
      parentID: false,
      deleted: false,
      getChildItems: () => [...(seed.childItemIds || [])],
      getChildCollections: () => [],
    };
    collections.set(seed.id, collection);
    return collection;
  }

  function installZotero(extra: Record<string, unknown> = {}) {
    globalScope.Zotero = {
      Items: {
        get: (id: number) => items.get(id) || null,
        getAll: async () => [...items.values()],
      },
      Collections: {
        get: (id: number) => collections.get(id) || null,
        getByLibrary: (libraryID: number) =>
          [...collections.values()].filter(
            (collection) => collection.libraryID === libraryID,
          ),
      },
      Libraries: {
        getName: () => "My Library",
        get: () => ({ name: "My Library" }),
      },
      ItemTypes: {
        getName: (id: number) => TYPE_NAMES[id] || "",
        getID: (name: string) =>
          Number(
            Object.entries(TYPE_NAMES).find(
              ([, typeName]) => typeName === name,
            )?.[0] || 0,
          ) || false,
        getTypes: () =>
          Object.entries(TYPE_NAMES).map(([id, name]) => ({
            id: Number(id),
            name,
          })),
        getLocalizedString: (id: number) => `Localized ${TYPE_NAMES[id] || id}`,
      },
      ItemFields: {
        getID: (name: string) => FIELD_IDS[name] || false,
        getName: (id: number) => FIELD_NAMES[id] || "",
        isValidForType: (fieldId: number, typeId: number) =>
          (VALID_FOR_TYPE[typeId] || []).includes(fieldId),
        getFieldIDFromTypeAndBase: (typeId: number, baseId: number) =>
          typeId === 2 && baseId === FIELD_IDS.publicationTitle
            ? FIELD_IDS.bookTitle
            : baseId,
        getItemTypeFields: (typeId: number) => VALID_FOR_TYPE[typeId] || [],
      },
      CreatorTypes: {
        itemTypeHasCreators: (typeId: number) => typeId !== 2,
        getTypesForItemType: () => [{ id: 1, name: "author" }],
      },
      Item: class {
        id = 900 + created.length;
        libraryID = 0;
        itemTypeID = 1;
        private readonly values: Record<string, string> = {};
        private readonly tagNames: string[] = [];
        private readonly collectionIds: number[] = [];
        private readonly creatorList: unknown[] = [];
        constructor(itemType: string) {
          this.itemTypeID = Number(
            Object.entries(TYPE_NAMES).find(
              ([, name]) => name === itemType,
            )?.[0] || 1,
          );
        }
        setField(name: string, value: string) {
          this.values[name] = value;
          return true;
        }
        setCreators(creators: unknown[]) {
          this.creatorList.push(...creators);
        }
        addTag(tag: string) {
          this.tagNames.push(tag);
        }
        addToCollection(collectionId: number) {
          this.collectionIds.push(collectionId);
        }
        getDisplayTitle() {
          return this.values.title || "";
        }
        async saveTx() {
          const item = makeItem({
            id: this.id,
            itemTypeID: this.itemTypeID,
            title: this.values.title,
            tags: this.tagNames.map((tag) => ({ tag })),
            collections: this.collectionIds,
          });
          item.libraryID = this.libraryID;
          item.creators = this.creatorList;
          created.push(item);
          return true;
        }
      },
      debug: () => undefined,
      ...extra,
    };
  }

  beforeEach(function () {
    items = new Map();
    collections = new Map();
    created = [];
    libraryIndexService.clearForTests();
  });

  afterEach(function () {
    globalScope.Zotero = originalZotero;
    libraryIndexService.clearForTests();
  });

  /** The capability under test, with every dependency answered explicitly. */
  function capability(deps: Partial<ItemCapabilityDeps> = {}) {
    return new ItemCapability({
      getItem: (itemId) =>
        (items.get(Number(itemId)) as unknown as Zotero.Item) || null,
      getCollectionSummary: (collectionId) => {
        const collection = collections.get(Number(collectionId));
        return collection
          ? {
              collectionId: collection.id,
              name: collection.name,
              libraryID: collection.libraryID,
              path: collection.name,
            }
          : null;
      },
      resolveBibliographicItem: (item) => item ?? null,
      ...deps,
    });
  }

  describe("index-backed item listings", function () {
    /** Two collections, one filed paper, one unfiled, one untagged. */
    function installLibrary() {
      makeItem({ id: 1, title: "Filed and tagged", collections: [10] });
      makeItem({ id: 2, title: "Unfiled and tagged" });
      makeItem({
        id: 3,
        itemTypeID: 2,
        title: "Filed, untagged chapter",
        collections: [10],
      });
      items.get(1)!.tags = [{ tag: "neuro" }];
      items.get(2)!.tags = [{ tag: "aging" }];
      makeCollection({ id: 10, name: "Neuro", childItemIds: [1, 3] });
      makeCollection({ id: 20, name: "Empty" });
      installZotero();
    }

    it("lists every item type in the library and reports the unpaged total", async function () {
      installLibrary();

      const listed = await capability().listLibraryItemTargets({
        libraryID: 1,
        limit: 2,
      });

      assert.equal(listed.totalCount, 3, "the total ignores the page limit");
      assert.lengthOf(listed.items, 2);
      assert.deepEqual(
        listed.items.map((item) => item.title),
        ["Filed and tagged", "Unfiled and tagged"],
      );
    });

    it("narrows a library listing to one item type", async function () {
      installLibrary();

      const listed = await capability().listLibraryItemTargets({
        libraryID: 1,
        itemType: "bookSection",
      });

      assert.deepEqual(
        listed.items.map((item) => item.itemId),
        [3],
      );
      assert.equal(listed.totalCount, 1);
    });

    it("refuses a library listing with no library", async function () {
      installLibrary();
      let message = "";
      try {
        await capability().listLibraryItemTargets({ libraryID: 0 });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.include(message, "No active library");
    });

    it("lists a collection's direct members with the injected summary", async function () {
      installLibrary();

      const listed = await capability().listCollectionItemTargets({
        libraryID: 1,
        collectionId: 10,
      });

      assert.equal(listed.collection.name, "Neuro");
      assert.deepEqual(
        listed.items.map((item) => item.itemId),
        [1, 3],
      );
      assert.equal(listed.totalCount, 2);
    });

    it("reports an unknown collection rather than listing the library", async function () {
      installLibrary();
      let message = "";
      try {
        await capability().listCollectionItemTargets({
          libraryID: 1,
          collectionId: 404,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.equal(message, "Collection not found");
    });

    it("lists only the items filed in no collection", async function () {
      installLibrary();

      const listed = await capability().listUnfiledItemTargets({
        libraryID: 1,
      });

      assert.deepEqual(
        listed.items.map((item) => item.itemId),
        [2],
      );
      assert.equal(listed.totalCount, 1);
    });

    it("lists only the items carrying no tag at all", async function () {
      installLibrary();

      const listed = await capability().listUntaggedItemTargets({
        libraryID: 1,
      });

      assert.deepEqual(
        listed.items.map((item) => item.itemId),
        [3],
      );
      assert.equal(listed.totalCount, 1);
    });

    it("narrows the unfiled and untagged listings by item type too", async function () {
      installLibrary();

      const unfiled = await capability().listUnfiledItemTargets({
        libraryID: 1,
        itemType: "bookSection",
      });
      const untagged = await capability().listUntaggedItemTargets({
        libraryID: 1,
        itemType: "journalArticle",
      });

      assert.deepEqual(unfiled.items, []);
      assert.equal(unfiled.totalCount, 0);
      assert.deepEqual(untagged.items, []);
      assert.equal(untagged.totalCount, 0);
    });

    it("steers every listing through the injected item lookup", async function () {
      installLibrary();

      const listed = await capability({
        getItem: () => null,
      }).listLibraryItemTargets({ libraryID: 1 });

      assert.deepEqual(
        listed.items,
        [],
        "an override that resolves nothing enriches nothing",
      );
      assert.equal(
        listed.totalCount,
        3,
        "the index still reports what the library holds",
      );
    });
  });

  describe("resolving items by id", function () {
    it("de-duplicates ids and drops the ones that resolve to nothing", function () {
      installZotero();
      makeItem({ id: 1, title: "One" });

      const targets = capability().getBibliographicItemTargetsByItemIds([
        1, 1, 404,
      ]);

      assert.deepEqual(
        targets.map((target) => target.itemId),
        [1],
      );
      assert.equal(targets[0].itemType, "journalArticle");
    });

    it("resolves a metadata target from the id before the active item", function () {
      installZotero();
      makeItem({ id: 1, title: "Named" });
      makeItem({ id: 2, title: "Active" });

      const resolved = capability().resolveMetadataItem({
        itemId: 1,
        request: { activeItemId: 2 } as never,
      });

      assert.equal(resolved?.id, 1);
    });

    it("falls back to the active item when no id is named", function () {
      installZotero();
      makeItem({ id: 2, title: "Active" });

      const resolved = capability().resolveMetadataItem({
        request: { activeItemId: 2 } as never,
      });

      assert.equal(resolved?.id, 2);
    });

    it("still reads a PDF attachment's parent for metadata reads", function () {
      // Read callers (page text, literature search, library_read) want the
      // paper a PDF belongs to; only writes take the named object.
      installZotero();
      const parent = makeItem({ id: 5, title: "Parent paper" });
      const attachment = makeItem({ id: 6, title: "PDF" });
      attachment.parentID = parent.id;
      attachment.isRegularItem = () => false;
      attachment.isAttachment = () => true;

      const resolved = capability().resolveMetadataItem({ itemId: 6 });

      assert.equal(resolved?.id, 5);
    });
  });

  describe("resolving a metadata write target", function () {
    function childAttachment() {
      const parent = makeItem({ id: 5, title: "Parent paper" });
      const attachment = makeItem({ id: 6, title: "PDF" });
      attachment.parentID = parent.id;
      attachment.isRegularItem = () => false;
      attachment.isAttachment = () => true;
      return { parent, attachment };
    }

    it("takes a named child attachment itself, never its parent", function () {
      installZotero();
      childAttachment();
      makeItem({ id: 2, title: "Active" });

      const resolved = capability().resolveMetadataWriteTarget({
        itemId: 6,
        request: { activeItemId: 2 } as never,
      });

      assert.deepEqual(
        "item" in resolved ? resolved.item.id : resolved.refusal,
        6,
      );
    });

    it("refuses a named standalone note, naming note_write, and never falls back to the active item", function () {
      installZotero();
      const note = makeItem({ id: 7, title: "" });
      note.isRegularItem = () => false;
      note.isNote = () => true;
      makeItem({ id: 2, title: "Active" });

      const resolved = capability().resolveMetadataWriteTarget({
        itemId: 7,
        request: { activeItemId: 2 } as never,
      });

      assert.isTrue("refusal" in resolved, JSON.stringify(resolved));
      if (!("refusal" in resolved)) return;
      assert.include(resolved.refusal, "note_write");
      assert.include(resolved.refusal, "7");
    });

    it("refuses a named id that does not exist instead of writing the active item", function () {
      installZotero();
      makeItem({ id: 2, title: "Active" });

      const resolved = capability().resolveMetadataWriteTarget({
        itemId: 404,
        request: { activeItemId: 2 } as never,
      });

      assert.isTrue("refusal" in resolved, JSON.stringify(resolved));
      if (!("refusal" in resolved)) return;
      assert.include(resolved.refusal, "404");
    });

    it("keeps today's paper context, then active item, path when no id is named", function () {
      installZotero();
      childAttachment();
      makeItem({ id: 2, title: "Active" });

      const byActive = capability().resolveMetadataWriteTarget({
        request: { activeItemId: 2 } as never,
      });
      const byPaper = capability().resolveMetadataWriteTarget({
        paperContext: { itemId: 5, contextItemId: 6, title: "Parent" },
        request: { activeItemId: 2 } as never,
      });
      // An open PDF stands for its paper, as it always has.
      const byOpenPdf = capability().resolveMetadataWriteTarget({
        request: { activeItemId: 6 } as never,
      });

      assert.equal("item" in byActive ? byActive.item.id : 0, 2);
      assert.equal("item" in byPaper ? byPaper.item.id : 0, 5);
      assert.equal("item" in byOpenPdf ? byOpenPdf.item.id : 0, 5);
    });

    it("refuses when no id is named and nothing is open", function () {
      installZotero();

      const resolved = capability().resolveMetadataWriteTarget({
        request: {} as never,
      });

      assert.isTrue("refusal" in resolved);
    });
  });

  describe("reading editable metadata", function () {
    it("returns the union of the well-known fields and the item type's own", function () {
      installZotero();
      const item = makeItem({
        id: 5,
        itemTypeID: 2,
        title: "A chapter",
        fields: { bookTitle: "A book", publisher: "Academic" },
      });

      const snapshot = capability().getEditableArticleMetadata(
        item as unknown as Zotero.Item,
      );

      assert.equal(snapshot?.itemType, "bookSection");
      assert.equal(snapshot?.title, "A chapter");
      assert.equal(
        snapshot?.fields.publicationTitle,
        "A book",
        "the base-mapped read reaches bookTitle",
      );
      assert.equal(snapshot?.fields.publisher, "Academic");
    });

    it("reports which fields and creators an item type accepts", function () {
      installZotero();
      const article = makeItem({ id: 6 });
      const chapter = makeItem({ id: 7, itemTypeID: 2 });

      assert.isTrue(
        capability().isEditableArticleMetadataFieldSupported(
          article as unknown as Zotero.Item,
          "publicationTitle" as never,
        ),
      );
      assert.isFalse(
        capability().isEditableArticleMetadataFieldSupported(
          chapter as unknown as Zotero.Item,
          "accessDate" as never,
        ),
      );
      assert.isTrue(
        capability().supportsEditableArticleCreators(
          article as unknown as Zotero.Item,
        ),
      );
      assert.isFalse(
        capability().supportsEditableArticleCreators(
          chapter as unknown as Zotero.Item,
        ),
      );
    });

    it("lists item types with the fields each one accepts", function () {
      installZotero();

      const listed = capability().listItemTypes({ itemType: "bookSection" });

      assert.lengthOf(listed.itemTypes, 1);
      assert.equal(listed.itemTypes[0].localized, "Localized bookSection");
      assert.include(listed.itemTypes[0].fields || [], "bookTitle");
      assert.notInclude(listed.itemTypes[0].fields || [], "publicationTitle");
      assert.deepEqual(listed.itemTypes[0].creatorTypes, ["author"]);
    });
  });

  describe("writing metadata", function () {
    it("writes the patch, saves once and reports what changed", async function () {
      installZotero();
      const item = makeItem({ id: 5, title: "Before" });

      const result = await capability().updateArticleMetadata({
        item: item as unknown as Zotero.Item,
        metadata: { title: "After", publisher: "Academic" } as never,
      });

      assert.equal(result.status, "updated");
      assert.equal(result.itemId, 5);
      assert.equal(
        result.title,
        "After",
        "the title is read back after saving",
      );
      assert.deepEqual(result.changedFields, ["title", "publisher"]);
      assert.equal(item.fields.title, "After");
      assert.equal(item.saves, 1);
    });

    it("refuses a field the item type does not have, naming the ones it does", async function () {
      installZotero();
      const chapter = makeItem({ id: 5, itemTypeID: 2 });

      let message = "";
      try {
        await capability().updateArticleMetadata({
          item: chapter as unknown as Zotero.Item,
          metadata: { accessDate: "2024-01-01" } as never,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      assert.include(message, "Unsupported metadata fields for bookSection");
      assert.include(message, "accessDate");
      assert.include(message, "bookTitle");
      assert.equal(
        chapter.saves,
        0,
        "nothing is written when a field is refused",
      );
    });

    it("refuses a value Zotero itself would not take", async function () {
      installZotero();
      const item = makeItem({ id: 5 });

      let message = "";
      try {
        await capability().updateArticleMetadata({
          item: item as unknown as Zotero.Item,
          metadata: { accessDate: "yesterday" } as never,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      assert.include(message, "Zotero rejected these values: accessDate");
      assert.equal(item.saves, 0);
    });

    it("refuses creators on an item type that has none", async function () {
      installZotero();
      const chapter = makeItem({ id: 5, itemTypeID: 2 });

      let message = "";
      try {
        await capability().updateArticleMetadata({
          item: chapter as unknown as Zotero.Item,
          metadata: {
            creators: [
              { firstName: "A", lastName: "B", creatorType: "author" },
            ],
          } as never,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      assert.include(message, "Creators are not supported for bookSection");
      assert.equal(chapter.saves, 0);
    });

    it("writes to the child attachment the caller named, never its parent", async function () {
      installZotero();
      const parent = makeItem({ id: 5 });
      const attachment = makeItem({ id: 6 });
      attachment.parentID = parent.id;
      attachment.isRegularItem = () => false;
      attachment.isAttachment = () => true;

      const result = await capability().updateArticleMetadata({
        item: attachment as unknown as Zotero.Item,
        metadata: { title: "Renamed" } as never,
      });

      assert.equal(result.itemId, 6, "the named object is the one edited");
      assert.equal(attachment.fields.title, "Renamed");
      assert.equal(attachment.saves, 1);
      assert.equal(
        parent.fields.title,
        "Paper 5",
        "the parent is left alone rather than silently edited in its place",
      );
      assert.equal(parent.saves, 0);
    });
  });

  describe("creating items", function () {
    it("creates an item with its fields, tags and collections", async function () {
      installZotero();

      const result = await capability().createItems({
        libraryID: 1,
        items: [
          {
            itemType: "journalArticle",
            fields: { title: "A new paper" },
            tags: ["neuro"],
            collections: [10],
          },
        ],
      });

      assert.equal(result.createdCount, 1);
      assert.equal(result.items[0].status, "created");
      assert.equal(result.items[0].title, "A new paper");
      assert.lengthOf(created, 1);
      assert.equal(created[0].libraryID, 1);
      assert.deepEqual(
        created[0].tags.map((tag) => tag.tag),
        ["neuro"],
      );
      assert.deepEqual(created[0].collections, [10]);
    });

    it("reports an unknown item type as an error and creates nothing", async function () {
      installZotero();

      const result = await capability().createItems({
        libraryID: 1,
        items: [{ itemType: "notAType", fields: { title: "x" } }],
      });

      assert.equal(result.createdCount, 0);
      assert.equal(result.items[0].status, "error");
      assert.include(result.items[0].reason || "", "not a Zotero item type");
      assert.lengthOf(created, 0);
    });

    it("refuses a field the requested type does not accept", async function () {
      installZotero();

      const result = await capability().createItems({
        libraryID: 1,
        items: [
          {
            itemType: "bookSection",
            fields: { title: "x", accessDate: "2024-01-01" },
          },
        ],
      });

      assert.equal(result.createdCount, 0);
      assert.include(
        result.items[0].reason || "",
        "Fields not valid for bookSection: accessDate",
      );
    });
  });

  describe("trashing and restoring", function () {
    it("trashes what is not already there and reports each id", async function () {
      installZotero();
      const live = makeItem({ id: 1, title: "Live" });
      const alreadyTrashed = makeItem({ id: 2, title: "Gone", deleted: true });

      const result = await capability().trashItems({ itemIds: [1, 2, 404] });

      assert.equal(result.trashedCount, 1);
      assert.deepEqual(
        result.items.map((entry) => entry.status),
        ["trashed", "skipped", "skipped"],
      );
      assert.isTrue(live.deleted);
      assert.equal(live.saves, 1);
      assert.equal(alreadyTrashed.saves, 0);
    });

    it("restores only the ids that were actually in the trash", async function () {
      installZotero();
      const trashed = makeItem({ id: 1, title: "Gone", deleted: true });
      const live = makeItem({ id: 2, title: "Live" });

      const result = await capability().restoreItems({ itemIds: [1, 2, 404] });

      assert.deepEqual(result.itemIds, [1]);
      assert.equal(result.restoredCount, 1);
      assert.isFalse(trashed.deleted);
      assert.equal(live.saves, 0);
    });
  });

  describe("merging duplicates", function () {
    it("hands the master and the others to Zotero's own merge", async function () {
      const mergeCalls: Array<{ master: number; others: number[] }> = [];
      installZotero();
      makeItem({ id: 1, title: "Master" });
      makeItem({ id: 2, title: "Duplicate" });
      (globalScope.Zotero as { Items: Record<string, unknown> }).Items.merge =
        async (master: { id: number }, others: Array<{ id: number }>) => {
          mergeCalls.push({
            master: master.id,
            others: others.map((other) => other.id),
          });
        };

      const result = await capability().mergeItems({
        masterItemId: 1,
        otherItemIds: [1, 2, 404],
      });

      assert.deepEqual(mergeCalls, [{ master: 1, others: [2] }]);
      assert.equal(result.mergedCount, 1);
      assert.equal(result.masterTitle, "Master");
      assert.deepEqual(result.trashedIds, [2]);
    });

    it("refuses rather than hand-rolling a merge Zotero cannot do", async function () {
      installZotero();
      makeItem({ id: 1, title: "Master" });
      makeItem({ id: 2, title: "Duplicate" });

      let message = "";
      try {
        await capability().mergeItems({ masterItemId: 1, otherItemIds: [2] });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      assert.include(message, "does not expose Zotero.Items.merge");
    });
  });

  describe("finding related papers and duplicates", function () {
    /** Papers with a PDF attachment, which is what a paper target requires. */
    function makePaper(seed: {
      id: number;
      title: string;
      doi?: string;
      firstCreator?: string;
      journal?: string;
      tags?: string[];
    }) {
      const item = makeItem({
        id: seed.id,
        title: seed.title,
        fields: {
          title: seed.title,
          DOI: seed.doi || "",
          publicationTitle: seed.journal || "",
        },
        tags: (seed.tags || []).map((tag) => ({ tag })),
        firstCreator: seed.firstCreator,
      });
      const attachment = {
        id: seed.id + 100,
        libraryID: 1,
        parentID: seed.id,
        deleted: false,
        attachmentContentType: "application/pdf",
        isAttachment: () => true,
        isRegularItem: () => false,
        isNote: () => false,
        isAnnotation: () => false,
        getDisplayTitle: () => `PDF ${seed.id}`,
        getField: () => "",
        getTags: () => [],
        getCollections: () => [],
      };
      items.set(attachment.id, attachment as unknown as FakeItem);
      item.getAttachments = () => [attachment.id];
      return item;
    }

    it("scores candidates by author, title words, journal and tags", async function () {
      makePaper({
        id: 1,
        title: "Hippocampal memory consolidation",
        firstCreator: "Wang",
        journal: "Neuron",
        tags: ["memory"],
      });
      makePaper({
        id: 2,
        title: "Hippocampal memory replay",
        firstCreator: "Wang",
        journal: "Neuron",
        tags: ["memory"],
      });
      makePaper({ id: 3, title: "Unrelated volcanology survey" });
      installZotero();

      const related = await capability().findRelatedPapersInLibrary({
        libraryID: 1,
        referenceItemId: 1,
      });

      assert.equal(related.referenceTitle, "Hippocampal memory consolidation");
      assert.deepEqual(
        related.relatedPapers.map((paper) => paper.itemId),
        [2],
      );
      assert.isAbove(related.relatedPapers[0].matchScore, 40);
      assert.include(
        related.relatedPapers[0].matchReasons.join(" | "),
        "Same first author: Wang",
      );
    });

    it("groups duplicates by DOI first and then by normalised title", async function () {
      makePaper({ id: 1, title: "A study of things", doi: "10.1/abc" });
      makePaper({ id: 2, title: "Something else entirely", doi: "10.1/ABC" });
      makePaper({ id: 3, title: "A different long title here" });
      makePaper({ id: 4, title: "A different long title here!" });
      installZotero();

      const found = await capability().detectDuplicatesInLibrary({
        libraryID: 1,
      });

      assert.equal(found.totalGroups, 2);
      assert.equal(found.groups[0].matchReason, "Same DOI: 10.1/abc");
      assert.deepEqual(
        found.groups[0].papers.map((paper) => paper.itemId),
        [1, 2],
      );
      assert.equal(found.groups[1].matchReason, "Same title");
      assert.deepEqual(
        found.groups[1].papers.map((paper) => paper.itemId),
        [3, 4],
      );
    });
  });
});

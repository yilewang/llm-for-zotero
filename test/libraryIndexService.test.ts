import { assert } from "chai";
import {
  LibraryIndexService,
  libraryIndexService,
  normalizeLibraryIndexText,
} from "../src/services/libraryIndexService";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";

type ItemSeed = {
  id: number;
  libraryID?: number;
  kind?: "regular" | "note" | "attachment";
  parentID?: number;
  fields?: Record<string, string>;
  creators?: Array<{ firstName?: string; lastName?: string; name?: string }>;
  tags?: Array<string | { tag: string; type?: number }>;
  collections?: number[];
  attachments?: number[];
  notes?: number[];
  contentType?: string;
  filename?: string;
  dateAdded?: string;
  dateModified?: string;
  deleted?: boolean;
  firstCreator?: string;
  noteHtml?: string;
};

type CollectionSeed = {
  id: number;
  libraryID?: number;
  name: string;
  parentID?: number;
  childItems?: number[];
  childCollections?: number[];
  deleted?: boolean;
};

function makeItem(seed: ItemSeed): Zotero.Item {
  return {
    id: seed.id,
    key: `ITEM-${seed.id}`,
    libraryID: seed.libraryID ?? 1,
    parentID: seed.parentID || false,
    itemType: seed.kind === "note" ? "note" : "journalArticle",
    attachmentContentType: seed.contentType || "",
    attachmentFilename: seed.filename || "",
    dateAdded: seed.dateAdded || "2024-01-01 00:00:00",
    get dateModified() {
      return seed.dateModified || "2024-01-02 00:00:00";
    },
    get deleted() {
      return seed.deleted === true;
    },
    get firstCreator() {
      return seed.firstCreator || "";
    },
    isRegularItem: () => (seed.kind || "regular") === "regular",
    isNote: () => seed.kind === "note",
    isAttachment: () => seed.kind === "attachment",
    getField: (name: string) => seed.fields?.[name] || "",
    getDisplayTitle: () =>
      seed.fields?.title || seed.filename || `Item ${seed.id}`,
    getNoteTitle: () => seed.fields?.title || `Note ${seed.id}`,
    getNote: () => seed.noteHtml || "",
    getCreators: () => seed.creators || [],
    getTags: () => seed.tags || [],
    getCollections: () => seed.collections || [],
    getAttachments: () => seed.attachments || [],
    getNotes: () => seed.notes || [],
  } as unknown as Zotero.Item;
}

function makeCollection(seed: CollectionSeed): Zotero.Collection {
  return {
    id: seed.id,
    libraryID: seed.libraryID ?? 1,
    get name() {
      return seed.name;
    },
    get parentID() {
      return seed.parentID || false;
    },
    get deleted() {
      return seed.deleted === true;
    },
    getChildItems: () => seed.childItems || [],
    getChildCollections: () => seed.childCollections || [],
  } as unknown as Zotero.Collection;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe("LibraryIndexService", function () {
  const originalZotero = globalThis.Zotero;
  const services: LibraryIndexService[] = [];

  afterEach(function () {
    for (const service of services) service.clearForTests();
    services.length = 0;
    libraryIndexService.clearForTests();
    globalThis.Zotero = originalZotero;
  });

  function service(
    yieldEvery = 250,
    reconciliationDelayMs = 100,
  ): LibraryIndexService {
    const value = new LibraryIndexService(yieldEvery, reconciliationDelayMs);
    services.push(value);
    return value;
  }

  async function handleAndGet(
    index: LibraryIndexService,
    change: Parameters<LibraryIndexService["handleChange"]>[0],
    libraryID = 1,
  ): Promise<void> {
    await index.handleChange(change);
    await index.getSnapshot(libraryID);
  }

  function installFixture(params: {
    topLevel: ItemSeed[];
    children?: ItemSeed[];
    collections?: CollectionSeed[];
    tagIds?: Map<string, number>;
    groupLibraryIds?: Map<number, number>;
    getAll?: (libraryID?: number) => Promise<Zotero.Item[]>;
    libraryName?: string;
  }) {
    const allSeeds = [...params.topLevel, ...(params.children || [])];
    const itemById = new Map(
      allSeeds.map((seed) => [seed.id, makeItem(seed)] as const),
    );
    const collectionById = new Map(
      (params.collections || []).map(
        (seed) => [seed.id, makeCollection(seed)] as const,
      ),
    );
    let getAllCalls = 0;
    let libraryName = params.libraryName || "Fixture Library";
    const getAll = params.getAll;
    const tagIds = params.tagIds || new Map<string, number>();
    globalThis.Zotero = {
      Items: {
        getAll: async (libraryID?: number) => {
          getAllCalls += 1;
          return getAll
            ? getAll(libraryID)
            : params.topLevel
                .filter(
                  (seed) => !libraryID || (seed.libraryID ?? 1) === libraryID,
                )
                .map((seed) => itemById.get(seed.id)!);
        },
        get: (id: number) => itemById.get(Number(id)) || null,
      },
      Collections: {
        getByLibrary: (libraryID: number) =>
          [...collectionById.values()].filter(
            (collection) => Number(collection.libraryID) === libraryID,
          ),
        get: (id: number) => collectionById.get(Number(id)) || null,
      },
      Tags: {
        getID: (name: string) => tagIds.get(name) || false,
        getTagItems: async (libraryID: number, tagId: number) => {
          const name = [...tagIds].find(([, id]) => id === tagId)?.[0];
          if (!name) return [];
          return params.topLevel
            .filter((seed) => (seed.libraryID ?? 1) === libraryID)
            .filter((seed) =>
              (seed.tags || []).some(
                (tag) => (typeof tag === "string" ? tag : tag.tag) === name,
              ),
            )
            .map((seed) => seed.id);
        },
      },
      Libraries: {
        getName: () => libraryName,
      },
      Groups: {
        getLibraryIDFromGroupID: (groupID: number) =>
          params.groupLibraryIds?.get(groupID) || false,
      },
      debug: () => undefined,
    } as never;
    return {
      itemById,
      collectionById,
      getAllCalls: () => getAllCalls,
      setLibraryName: (value: string) => {
        libraryName = value;
      },
    };
  }

  it("shares one cold projection and preserves canonical primitive semantics", async function () {
    const regular: ItemSeed = {
      id: 1,
      libraryID: 8,
      fields: {
        title: "Café / 東京",
        shortTitle: "Cafe",
        citationKey: "Lovelace1843",
        DOI: "10.1000/ABC",
        publicationTitle: "Analytical Engine Review",
        date: "1943-07-01",
        abstractNote: "A description",
        extra: "arXiv: 1234.5678",
      },
      creators: [
        { firstName: "Ada", lastName: "Lovelace" },
        { name: "Charles Babbage" },
      ],
      firstCreator: "Lovelace et al.",
      tags: [{ tag: "History" }, { tag: "Imported", type: 1 }],
      collections: [20],
      attachments: [10, 11],
      notes: [12],
    };
    const trashed: ItemSeed = {
      id: 2,
      libraryID: 8,
      fields: { title: "In the trash" },
      tags: ["Hidden"],
      deleted: true,
    };
    const fixture = installFixture({
      topLevel: [regular, trashed, { id: 3, libraryID: 8, kind: "note" }],
      children: [
        {
          id: 10,
          libraryID: 8,
          kind: "attachment",
          parentID: 1,
          fields: { title: "Main PDF" },
          contentType: "application/pdf",
          filename: "main.pdf",
        },
        {
          id: 11,
          libraryID: 8,
          kind: "attachment",
          parentID: 1,
          fields: { title: "[LLM for Zotero] MinerU cache ITEM-10.zip" },
          contentType: "application/pdf",
          filename: "cache.pdf",
        },
        {
          id: 12,
          libraryID: 8,
          kind: "note",
          parentID: 1,
          fields: { title: "Child note" },
        },
      ],
      collections: [
        {
          id: 20,
          libraryID: 8,
          name: "Parent",
          childItems: [1],
          childCollections: [21],
        },
        {
          id: 21,
          libraryID: 8,
          name: "Nested",
          parentID: 20,
        },
      ],
      tagIds: new Map([
        ["History", 101],
        ["Imported", 102],
        ["Hidden", 103],
      ]),
      libraryName: "Research Group",
    });
    const index = service();

    const [first, second] = await Promise.all([
      index.getSnapshot(8),
      index.getSnapshot(8),
    ]);
    const warm = await index.getSnapshot(8);

    assert.strictEqual(first, second);
    assert.strictEqual(first, warm);
    assert.equal(fixture.getAllCalls(), 1);
    assert.equal(first.libraryName, "Research Group");
    assert.deepEqual(first.topLevelItemOrder, [1, 2, 3]);
    assert.equal(first.itemById.get(1)?.year, "1943");
    assert.equal(
      first.searchableFieldsByItemId.get(1)?.title,
      normalizeLibraryIndexText("Café / 東京"),
    );
    assert.deepEqual(first.itemById.get(1)?.creators, [
      "Ada Lovelace",
      "Charles Babbage",
    ]);
    assert.equal(first.itemById.get(1)?.firstCreator, "Lovelace et al.");
    assert.include(
      first.searchableFieldsByItemId.get(1)?.creators || "",
      "lovelace et al",
    );
    assert.deepEqual(first.pdfAttachmentIdsByItemId.get(1), [10]);
    assert.isTrue(first.attachmentById.get(11)?.isPdf);
    assert.isTrue(first.attachmentById.get(11)?.isMineruPackage);
    assert.isFalse(first.attachmentById.get(11)?.isContextEligiblePdf);
    assert.deepEqual(first.childNoteIdsByItemId.get(1), [12]);
    assert.equal(first.childNoteById.get(12)?.title, "Child note");
    assert.equal(first.collectionPathById.get(21), "Parent / Nested");
    assert.deepEqual([...index.tagItemIds(first, "history", false)], [1]);
    assert.deepEqual([...index.tagItemIds(first, "imported", false)], []);
    assert.deepEqual([...index.tagItemIds(first, "imported", true)], [1]);
    assert.isTrue(first.itemById.has(2), "trash remains addressable");
    assert.isFalse(first.unfiledItemIds.has(2));
    assert.isFalse(first.untaggedItemIds.has(2));
    assert.isFalse(first.tagByNormalizedName.has("hidden"));
    assert.deepEqual(index.getMetrics(), {
      fullBuilds: 1,
      itemsGetAllCalls: 1,
      projectedTopLevelItems: 3,
      incrementalItemUpdates: 0,
      incrementalCollectionUpdates: 0,
      coalescedRebuilds: 0,
      staleBuildDiscards: 0,
    });
  });

  it("preserves distinct creator rows that render to the same name", async function () {
    installFixture({
      topLevel: [
        {
          id: 1,
          fields: { title: "Namesake authors" },
          creators: [
            { firstName: "Wei", lastName: "Wang" },
            { firstName: "Wei", lastName: "Wang" },
          ],
        },
      ],
    });
    const index = service();

    const snapshot = await index.getSnapshot(1);

    assert.deepEqual(snapshot.itemById.get(1)?.creators, [
      "Wei Wang",
      "Wei Wang",
    ]);
  });

  it("keeps punctuation-distinct tag identities and scopes separate", async function () {
    installFixture({
      topLevel: [
        { id: 1, fields: { title: "C item" }, tags: ["C"] },
        { id: 2, fields: { title: "C++ item" }, tags: ["C++"] },
        { id: 3, fields: { title: "Hyphen item" }, tags: ["a-b"] },
        { id: 4, fields: { title: "Space item" }, tags: ["a b"] },
      ],
      tagIds: new Map([
        ["C", 1],
        ["C++", 2],
        ["a-b", 3],
        ["a b", 4],
      ]),
    });

    const snapshot = await libraryIndexService.getSnapshot(1);
    assert.deepEqual(
      [...libraryIndexService.tagItemIds(snapshot, "C", true)],
      [1],
    );
    assert.deepEqual(
      [...libraryIndexService.tagItemIds(snapshot, "C++", true)],
      [2],
    );
    assert.deepEqual(
      [...libraryIndexService.tagItemIds(snapshot, "a-b", true)],
      [3],
    );
    assert.deepEqual(
      [...libraryIndexService.tagItemIds(snapshot, "a b", true)],
      [4],
    );

    const scoped = await new ZoteroGateway().listTagItemTargets({
      libraryID: 1,
      tagContext: {
        name: "C++",
        // Simulate a legacy fuzzy key. The display name remains the exact
        // identity authority and must not select the `C` tag.
        normalizedName: "c",
      },
    });
    assert.deepEqual(
      scoped.items.map((item) => item.itemId),
      [2],
    );
  });

  it("retains membership indexes by identity on metadata-only edits", async function () {
    const item: ItemSeed = {
      id: 1,
      fields: { title: "Before" },
      tags: ["Common"],
      collections: [10],
    };
    installFixture({
      topLevel: [item],
      collections: [{ id: 10, name: "Shared", childItems: [1] }],
      tagIds: new Map([["Common", 1]]),
    });
    const index = service();
    const before = await index.getSnapshot(1);
    item.fields!.title = "After";
    await handleAndGet(index, {
      event: "modify",
      type: "item",
      ids: [1],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    const after = index.peekSnapshot(1)!;

    assert.equal(after.itemById.get(1)?.title, "After");
    assert.strictEqual(after.tagByNormalizedName, before.tagByNormalizedName);
    assert.strictEqual(
      after.normalizedTagNameByTagId,
      before.normalizedTagNameByTagId,
    );
    assert.strictEqual(
      after.tagIdsByNormalizedName,
      before.tagIdsByNormalizedName,
    );
    assert.strictEqual(
      after.directItemIdsByCollectionId,
      before.directItemIdsByCollectionId,
    );
    assert.strictEqual(
      after.childAttachmentIdsByItemId,
      before.childAttachmentIdsByItemId,
    );
    assert.strictEqual(
      after.pdfAttachmentIdsByItemId,
      before.pdfAttachmentIdsByItemId,
    );
    assert.strictEqual(after.childNoteIdsByItemId, before.childNoteIdsByItemId);
    assert.strictEqual(after.attachmentById, before.attachmentById);
    assert.strictEqual(after.childNoteById, before.childNoteById);
    assert.notStrictEqual(after.itemById, before.itemById);
    assert.notStrictEqual(
      after.searchableFieldsByItemId,
      before.searchableFieldsByItemId,
    );
  });

  it("discovers members introduced by a tag display-variant rekey", async function () {
    const first: ItemSeed = {
      id: 1,
      fields: { title: "Old variant member" },
      tags: ["Foo"],
    };
    const second: ItemSeed = {
      id: 2,
      fields: { title: "New variant member" },
      tags: [],
    };
    installFixture({
      topLevel: [first, second],
      tagIds: new Map([
        ["Foo", 1],
        ["foo", 2],
      ]),
    });
    const index = service();
    const before = await index.getSnapshot(1);
    assert.deepEqual([...index.tagItemIds(before, "foo", false)], [1]);
    assert.deepEqual(before.tagIdsByNormalizedName.get("foo"), [1]);

    first.tags = [];
    second.tags = ["foo"];
    await handleAndGet(index, {
      event: "modify",
      type: "tag",
      ids: [],
      extraData: { libraryID: 1, tagNames: ["foo"] },
      receivedAt: Date.now(),
    });
    const after = index.peekSnapshot(1)!;

    assert.deepEqual([...index.tagItemIds(before, "foo", false)], [1]);
    assert.deepEqual(before.tagIdsByNormalizedName.get("foo"), [1]);
    assert.deepEqual([...index.tagItemIds(after, "foo", false)], [2]);
    assert.isFalse(after.normalizedTagNameByTagId.has(1));
    assert.equal(after.normalizedTagNameByTagId.get(2), "foo");
    assert.deepEqual(after.tagIdsByNormalizedName.get("foo"), [2]);
  });

  it("patches a renamed group library without rebuilding its projection", async function () {
    const fixture = installFixture({
      topLevel: [{ id: 1, libraryID: 8, fields: { title: "Group paper" } }],
      libraryName: "Before rename",
      groupLibraryIds: new Map([[700, 8]]),
    });
    const index = service();
    const before = await index.getSnapshot(8);

    fixture.setLibraryName("After rename");
    await handleAndGet(
      index,
      {
        event: "modify",
        type: "group",
        ids: [700],
        extraData: {},
        receivedAt: Date.now(),
      },
      8,
    );
    const after = index.peekSnapshot(8)!;

    assert.equal(before.libraryName, "Before rename");
    assert.equal(after.libraryName, "After rename");
    assert.strictEqual(after.itemById, before.itemById);
    assert.strictEqual(after.collectionById, before.collectionById);
    assert.equal(fixture.getAllCalls(), 1);
  });

  it("reconciles a group rename without discarding the cold projection", async function () {
    const firstBuild = deferred<Zotero.Item[]>();
    const item: ItemSeed = {
      id: 1,
      libraryID: 8,
      fields: { title: "Group paper" },
    };
    let buildCalls = 0;
    const fixture = installFixture({
      topLevel: [item],
      libraryName: "Before rename",
      groupLibraryIds: new Map([[700, 8]]),
      getAll: async () => {
        buildCalls += 1;
        return buildCalls === 1 ? firstBuild.promise : [makeItem(item)];
      },
    });
    const index = service();
    const publisher = index as unknown as {
      publishSnapshot: (...args: unknown[]) => void;
    };
    const publishSnapshot = publisher.publishSnapshot.bind(index);
    const publications: Array<{
      libraryName: string;
      itemTitle?: string;
    }> = [];
    publisher.publishSnapshot = (...args: unknown[]) => {
      publishSnapshot(...args);
      const published = index.peekSnapshot(8)!;
      publications.push({
        libraryName: published.libraryName,
        itemTitle: published.itemById.get(1)?.title,
      });
    };
    const loading = index.getSnapshot(8);

    fixture.setLibraryName("After rename");
    await index.handleChange({
      event: "modify",
      type: "group",
      ids: [700],
      extraData: {},
      receivedAt: Date.now(),
    });
    firstBuild.resolve([makeItem(item)]);
    const snapshot = await loading;

    assert.equal(snapshot.libraryName, "After rename");
    assert.deepEqual(publications, [
      { libraryName: "After rename", itemTitle: "Group paper" },
    ]);
    assert.equal(buildCalls, 1);
    assert.equal(index.getMetrics().staleBuildDiscards, 0);
  });

  it("canonicalizes collection membership after a move is fully reversed", async function () {
    const item: ItemSeed = {
      id: 1,
      fields: { title: "Moved and restored" },
      collections: [10],
    };
    installFixture({
      topLevel: [item],
      collections: [
        { id: 10, name: "Original", childItems: [1] },
        { id: 11, name: "Temporary", childItems: [] },
      ],
    });
    const index = service();
    const initial = await index.getSnapshot(1);

    item.collections = [11];
    await handleAndGet(index, {
      event: "modify",
      type: "collection-item",
      ids: [1],
      extraData: { libraryID: 1, itemID: 1 },
      receivedAt: Date.now(),
    });
    item.collections = [10];
    await handleAndGet(index, {
      event: "modify",
      type: "collection-item",
      ids: [1],
      extraData: { libraryID: 1, itemID: 1 },
      receivedAt: Date.now(),
    });

    const restored = index.peekSnapshot(1)!;
    assert.notStrictEqual(
      restored.directItemIdsByCollectionId,
      initial.directItemIdsByCollectionId,
    );
    assert.deepEqual(
      [...(initial.directItemIdsByCollectionId.get(10) || [])],
      [1],
    );
    assert.deepEqual(
      [...(restored.directItemIdsByCollectionId.get(10) || [])],
      [1],
    );
  });

  it("applies bulk top-level additions and deletions in one ordered publication", async function () {
    this.timeout(10_000);
    const fixture = installFixture({ topLevel: [] });
    const index = service();
    await index.getSnapshot(1);
    const itemIds = Array.from({ length: 1_000 }, (_, offset) => offset + 1);
    for (const itemId of itemIds) {
      fixture.itemById.set(
        itemId,
        makeItem({ id: itemId, fields: { title: `Bulk ${itemId}` } }),
      );
    }

    await handleAndGet(index, {
      event: "add",
      type: "item",
      ids: itemIds,
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    assert.deepEqual(index.peekSnapshot(1)?.topLevelItemOrder, itemIds);

    const removed = itemIds.slice(0, 500);
    for (const itemId of removed) fixture.itemById.delete(itemId);
    await handleAndGet(index, {
      event: "delete",
      type: "item",
      ids: removed,
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });

    assert.deepEqual(
      index.peekSnapshot(1)?.topLevelItemOrder,
      itemIds.slice(500),
    );
    assert.equal(fixture.getAllCalls(), 1);
  });

  it("patches 10k distinct tag memberships in linear batch time", async function () {
    this.timeout(15_000);
    const itemCount = 10_000;
    const topLevel: ItemSeed[] = Array.from(
      { length: itemCount },
      (_, offset) => ({
        id: offset + 1,
        fields: { title: `Tagged ${offset + 1}` },
        tags: [],
      }),
    );
    const tagIds = new Map(
      topLevel.map((seed) => [`Tag ${seed.id}`, seed.id] as const),
    );
    const fixture = installFixture({ topLevel, tagIds });
    const index = service(1_000);
    await index.getSnapshot(1);

    for (const seed of topLevel) seed.tags = [`Tag ${seed.id}`];
    const startedAt = Date.now();
    await handleAndGet(index, {
      event: "modify",
      type: "item",
      ids: topLevel.map((seed) => seed.id),
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    const elapsedMs = Date.now() - startedAt;

    const snapshot = index.peekSnapshot(1)!;
    assert.equal(snapshot.tagByNormalizedName.size, itemCount);
    assert.equal(snapshot.normalizedTagNameByTagId.size, itemCount);
    assert.deepEqual(
      [...index.tagItemIds(snapshot, "Tag 9999", false)],
      [9_999],
    );
    assert.equal(fixture.getAllCalls(), 1);
    assert.isBelow(
      elapsedMs,
      5_000,
      "a bulk notifier must not compare every changed item with every tag",
    );
  });

  it("does not rebuild a large unchanged co-tag after a rare-tag edit", async function () {
    this.timeout(15_000);
    const itemCount = 50_000;
    const topLevel: ItemSeed[] = Array.from(
      { length: itemCount },
      (_, offset) => ({
        id: offset + 1,
        fields: { title: `Co-tagged ${offset + 1}` },
        tags: offset === 0 ? ["Common", "Old"] : ["Common"],
      }),
    );
    installFixture({
      topLevel,
      tagIds: new Map([
        ["Common", 1],
        ["Old", 2],
        ["New", 3],
      ]),
    });
    const index = service(1_000);
    const before = await index.getSnapshot(1);
    const commonBefore = before.tagByNormalizedName.get("common");

    topLevel[0].tags = ["Common", "New"];
    await handleAndGet(index, {
      event: "modify",
      type: "item",
      ids: [1],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });

    const after = index.peekSnapshot(1)!;
    assert.strictEqual(
      after.tagByNormalizedName.get("common"),
      commonBefore,
      "an unchanged co-tag must preserve its indexed value without scanning all members",
    );
    assert.isFalse(after.tagByNormalizedName.has("old"));
    assert.deepEqual([...index.tagItemIds(after, "New", false)], [1]);
  });

  it("patches item, relation, tag, and collection events without a full read", async function () {
    const item: ItemSeed = {
      id: 1,
      fields: { title: "Before" },
      tags: ["Alpha"],
      collections: [10],
    };
    const parent: CollectionSeed = {
      id: 10,
      name: "Old parent",
      childItems: [1],
      childCollections: [11],
    };
    const nested: CollectionSeed = {
      id: 11,
      name: "Nested",
      parentID: 10,
    };
    const tagIds = new Map([
      ["Alpha", 1],
      ["Beta", 2],
      ["Gamma", 3],
    ]);
    const fixture = installFixture({
      topLevel: [item],
      collections: [parent, nested],
      tagIds,
    });
    const index = service();
    await index.getSnapshot(1);

    item.fields!.title = "After";
    item.tags = ["Beta"];
    item.collections = [11];
    await handleAndGet(index, {
      event: "modify",
      type: "item",
      ids: [1],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    let snapshot = index.peekSnapshot(1)!;
    assert.equal(snapshot.itemById.get(1)?.title, "After");
    assert.deepEqual([...index.tagItemIds(snapshot, "Alpha", true)], []);
    assert.deepEqual([...index.tagItemIds(snapshot, "Beta", true)], [1]);
    assert.isFalse(snapshot.tagIdsByNormalizedName.has("alpha"));
    assert.deepEqual(snapshot.tagIdsByNormalizedName.get("beta"), [2]);
    assert.equal(snapshot.normalizedTagNameByTagId.get(2), "beta");
    assert.isFalse(snapshot.directItemIdsByCollectionId.get(10)?.has(1));
    assert.isTrue(snapshot.directItemIdsByCollectionId.get(11)?.has(1));

    item.tags = ["Gamma"];
    await handleAndGet(index, {
      event: "modify",
      type: "item-tag",
      ids: ["1-3"],
      extraData: { libraryID: 1, itemID: 1 },
      receivedAt: Date.now(),
    });
    snapshot = index.peekSnapshot(1)!;
    assert.deepEqual([...index.tagItemIds(snapshot, "Gamma", true)], [1]);
    assert.isFalse(snapshot.tagIdsByNormalizedName.has("beta"));
    assert.deepEqual(snapshot.tagIdsByNormalizedName.get("gamma"), [3]);

    item.tags = ["Beta"];
    await handleAndGet(index, {
      event: "modify",
      type: "tag",
      ids: [2],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    snapshot = index.peekSnapshot(1)!;
    assert.deepEqual([...index.tagItemIds(snapshot, "Beta", true)], [1]);

    item.tags = [];
    await handleAndGet(index, {
      event: "modify",
      type: "tag",
      ids: [],
      extraData: { libraryID: 1, tagNames: ["Beta"] },
      receivedAt: Date.now(),
    });
    snapshot = index.peekSnapshot(1)!;
    assert.deepEqual([...index.tagItemIds(snapshot, "Beta", true)], []);

    item.fields!.title = "After relation";
    await handleAndGet(index, {
      event: "modify",
      type: "relation",
      ids: [999],
      extraData: { libraryID: 1, subjectItemID: 1 },
      receivedAt: Date.now(),
    });
    snapshot = index.peekSnapshot(1)!;
    assert.equal(snapshot.itemById.get(1)?.title, "After relation");

    parent.name = "Renamed parent";
    await handleAndGet(index, {
      event: "modify",
      type: "collection",
      ids: [10],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    snapshot = index.peekSnapshot(1)!;
    assert.equal(
      snapshot.collectionPathById.get(11),
      "Renamed parent / Nested",
    );
    assert.equal(fixture.getAllCalls(), 1);
    assert.isAtLeast(index.getMetrics().incrementalItemUpdates, 3);
    assert.isAtLeast(index.getMetrics().incrementalCollectionUpdates, 1);
  });

  it("refreshes item membership across collection trash, restore, and erase", async function () {
    const item: ItemSeed = {
      id: 1,
      fields: { title: "Membership-sensitive paper" },
      collections: [10],
    };
    const collection: CollectionSeed = {
      id: 10,
      name: "Lifecycle collection",
      childItems: [1],
    };
    const fixture = installFixture({
      topLevel: [item],
      collections: [collection],
    });
    const index = service();
    await index.getSnapshot(1);

    collection.deleted = true;
    collection.childItems = [];
    item.collections = [];
    await handleAndGet(index, {
      event: "trash",
      type: "collection",
      ids: [10],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    let snapshot = index.peekSnapshot(1)!;
    assert.deepEqual(snapshot.itemById.get(1)?.collectionIds, []);
    assert.isTrue(snapshot.unfiledItemIds.has(1));
    assert.isFalse(snapshot.directItemIdsByCollectionId.get(10)?.has(1));

    collection.deleted = false;
    collection.childItems = [1];
    item.collections = [10];
    await handleAndGet(index, {
      event: "modify",
      type: "collection",
      ids: [10],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    snapshot = index.peekSnapshot(1)!;
    assert.deepEqual(snapshot.itemById.get(1)?.collectionIds, [10]);
    assert.isFalse(snapshot.unfiledItemIds.has(1));
    assert.isTrue(snapshot.directItemIdsByCollectionId.get(10)?.has(1));

    fixture.collectionById.delete(10);
    item.collections = [];
    await handleAndGet(index, {
      event: "delete",
      type: "collection",
      ids: [10],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    snapshot = index.peekSnapshot(1)!;
    assert.isFalse(snapshot.collectionById.has(10));
    assert.deepEqual(snapshot.itemById.get(1)?.collectionIds, []);
    assert.isTrue(snapshot.unfiledItemIds.has(1));
    assert.equal(fixture.getAllCalls(), 1);
  });

  it("preserves trashed-item membership across collection metadata edits and item restore", async function () {
    const item: ItemSeed = {
      id: 1,
      deleted: true,
      fields: { title: "Trashed but still filed" },
      collections: [10],
    };
    const collection: CollectionSeed = {
      id: 10,
      name: "Before rename",
      // Zotero excludes the trashed item from this collection API call. The
      // item record remains the canonical source for its membership.
      childItems: [],
    };
    const fixture = installFixture({
      topLevel: [item],
      collections: [collection],
    });
    const liveCollection = fixture.collectionById.get(
      10,
    )! as Zotero.Collection & {
      getChildItems: (asIDs: boolean, includeDeleted: boolean) => number[];
    };
    let childReads = 0;
    liveCollection.getChildItems = () => {
      childReads += 1;
      return [];
    };
    const index = service();
    const initial = await index.getSnapshot(1);
    const initialMembers = initial.directItemIdsByCollectionId.get(10)!;
    assert.isTrue(initialMembers.has(1));

    childReads = 0;
    collection.name = "After rename";
    await handleAndGet(index, {
      event: "modify",
      type: "collection",
      ids: [10],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    let snapshot = index.peekSnapshot(1)!;
    assert.equal(childReads, 0);
    assert.strictEqual(
      snapshot.directItemIdsByCollectionId.get(10),
      initialMembers,
    );
    assert.isTrue(snapshot.directItemIdsByCollectionId.get(10)?.has(1));

    item.deleted = false;
    await handleAndGet(index, {
      event: "modify",
      type: "item",
      ids: [1],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    snapshot = index.peekSnapshot(1)!;
    assert.isFalse(snapshot.itemById.get(1)?.deleted);
    assert.isTrue(snapshot.directItemIdsByCollectionId.get(10)?.has(1));
    assert.equal(fixture.getAllCalls(), 1);
  });

  it("recomputes only a renamed leaf collection path", async function () {
    const leaf: CollectionSeed = {
      id: 11,
      name: "Before leaf",
      parentID: 10,
    };
    installFixture({
      topLevel: [],
      collections: [
        { id: 10, name: "Parent", childCollections: [11] },
        leaf,
        { id: 20, name: "Unrelated" },
      ],
    });
    const index = service();
    const before = await index.getSnapshot(1);
    leaf.name = "After leaf";
    await handleAndGet(index, {
      event: "modify",
      type: "collection",
      ids: [11],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    const after = index.peekSnapshot(1)!;

    assert.equal(after.collectionPathById.get(10), "Parent");
    assert.equal(after.collectionPathById.get(11), "Parent / After leaf");
    assert.equal(after.collectionPathById.get(20), "Unrelated");
  });

  it("localizes collection paths across move, create, and erase events", async function () {
    const firstParent: CollectionSeed = {
      id: 10,
      name: "First parent",
      childCollections: [11],
    };
    const branch: CollectionSeed = {
      id: 11,
      name: "Branch",
      parentID: 10,
      childCollections: [12],
    };
    const leaf: CollectionSeed = {
      id: 12,
      name: "Leaf",
      parentID: 11,
    };
    const secondParent: CollectionSeed = {
      id: 20,
      name: "Second parent",
      childCollections: [],
    };
    const fixture = installFixture({
      topLevel: [],
      collections: [
        firstParent,
        branch,
        leaf,
        secondParent,
        { id: 30, name: "Unrelated" },
      ],
    });
    const index = service();
    await index.getSnapshot(1);

    branch.parentID = 20;
    firstParent.childCollections = [];
    secondParent.childCollections = [11];
    await handleAndGet(index, {
      event: "modify",
      type: "collection",
      ids: [11],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    let snapshot = index.peekSnapshot(1)!;
    assert.equal(snapshot.collectionPathById.get(10), "First parent");
    assert.equal(snapshot.collectionPathById.get(11), "Second parent / Branch");
    assert.equal(
      snapshot.collectionPathById.get(12),
      "Second parent / Branch / Leaf",
    );
    assert.equal(snapshot.collectionPathById.get(30), "Unrelated");

    const created: CollectionSeed = {
      id: 13,
      name: "Created",
      parentID: 20,
    };
    fixture.collectionById.set(13, makeCollection(created));
    secondParent.childCollections = [11, 13];
    await handleAndGet(index, {
      event: "add",
      type: "collection",
      ids: [13],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    snapshot = index.peekSnapshot(1)!;
    assert.equal(
      snapshot.collectionPathById.get(13),
      "Second parent / Created",
    );

    fixture.collectionById.delete(11);
    secondParent.childCollections = [13];
    await handleAndGet(index, {
      event: "delete",
      type: "collection",
      ids: [11],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    snapshot = index.peekSnapshot(1)!;
    assert.isFalse(snapshot.collectionPathById.has(11));
    assert.equal(snapshot.collectionPathById.get(12), "Leaf");
    assert.equal(
      snapshot.collectionPathById.get(13),
      "Second parent / Created",
    );
    assert.equal(snapshot.collectionPathById.get(30), "Unrelated");
  });

  it("refreshes both parents and a detached standalone child on reparent", async function () {
    const firstParent: ItemSeed = {
      id: 1,
      fields: { title: "First parent" },
      notes: [3],
    };
    const secondParent: ItemSeed = {
      id: 2,
      fields: { title: "Second parent" },
      notes: [],
    };
    const fixture = installFixture({
      topLevel: [firstParent, secondParent],
      children: [
        {
          id: 3,
          kind: "note",
          parentID: 1,
          fields: { title: "Moved note" },
        },
      ],
    });
    const index = service();
    await index.getSnapshot(1);

    firstParent.notes = [];
    secondParent.notes = [3];
    (
      fixture.itemById.get(3) as Zotero.Item & { parentID: number | false }
    ).parentID = 2;
    await handleAndGet(index, {
      event: "modify",
      type: "item",
      ids: [3],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    let snapshot = index.peekSnapshot(1)!;
    assert.deepEqual(snapshot.childNoteIdsByItemId.get(1), []);
    assert.deepEqual(snapshot.childNoteIdsByItemId.get(2), [3]);
    assert.equal(snapshot.parentItemIdByChildId.get(3), 2);

    secondParent.notes = [];
    (
      fixture.itemById.get(3) as Zotero.Item & { parentID: number | false }
    ).parentID = false;
    await handleAndGet(index, {
      event: "modify",
      type: "item",
      ids: [3],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    snapshot = index.peekSnapshot(1)!;
    assert.deepEqual(snapshot.childNoteIdsByItemId.get(2), []);
    assert.equal(snapshot.itemById.get(3)?.kind, "standalone-note");
    assert.isFalse(snapshot.parentItemIdByChildId.has(3));

    secondParent.notes = [3];
    (
      fixture.itemById.get(3) as Zotero.Item & { parentID: number | false }
    ).parentID = 2;
    await handleAndGet(index, {
      event: "modify",
      type: "item",
      ids: [3],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    snapshot = index.peekSnapshot(1)!;
    assert.deepEqual(snapshot.childNoteIdsByItemId.get(2), [3]);
    assert.isFalse(snapshot.itemById.has(3));
    assert.notInclude([...snapshot.topLevelItemOrder], 3);
    assert.equal(snapshot.parentItemIdByChildId.get(3), 2);
    assert.equal(fixture.getAllCalls(), 1);
  });

  it("routes collection events by collection ownership across libraries", async function () {
    const collidingItem: ItemSeed = {
      id: 17,
      libraryID: 1,
      fields: { title: "Library one item" },
    };
    const libraryTwoItem: ItemSeed = {
      id: 200,
      libraryID: 2,
      fields: { title: "Library two item" },
      collections: [17],
    };
    const collection: CollectionSeed = {
      id: 17,
      libraryID: 2,
      name: "Before",
      childItems: [200],
    };
    installFixture({
      topLevel: [collidingItem, libraryTwoItem],
      collections: [collection],
    });
    const index = service();
    await Promise.all([index.getSnapshot(1), index.getSnapshot(2)]);

    collection.name = "After";
    await handleAndGet(
      index,
      {
        event: "modify",
        type: "collection",
        ids: [17],
        extraData: {},
        receivedAt: Date.now(),
      },
      2,
    );

    assert.equal(index.peekSnapshot(2)?.collectionById.get(17)?.name, "After");
    assert.isFalse(index.peekSnapshot(1)?.collectionById.has(17));
    assert.equal(
      index.peekSnapshot(1)?.itemById.get(17)?.title,
      "Library one item",
    );
  });

  it("routes refresh:trash ids as library ids instead of colliding item ids", async function () {
    const collidingItem: ItemSeed = {
      id: 42,
      libraryID: 1,
      fields: { title: "Item whose ID matches another library" },
    };
    const refreshedItem: ItemSeed = {
      id: 420,
      libraryID: 42,
      fields: { title: "Before refresh" },
    };
    const fixture = installFixture({
      topLevel: [collidingItem, refreshedItem],
    });
    const index = service();
    const [libraryOneBefore, libraryFortyTwoBefore] = await Promise.all([
      index.getSnapshot(1),
      index.getSnapshot(42),
    ]);

    refreshedItem.fields!.title = "After refresh";
    await index.handleChange({
      event: "refresh",
      type: "trash",
      ids: [42],
      extraData: {},
      receivedAt: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 160));

    const libraryFortyTwoAfter = index.peekSnapshot(42)!;
    assert.strictEqual(index.peekSnapshot(1), libraryOneBefore);
    assert.notStrictEqual(libraryFortyTwoAfter, libraryFortyTwoBefore);
    assert.equal(
      libraryFortyTwoAfter.itemById.get(420)?.title,
      "After refresh",
    );
    assert.equal(fixture.getAllCalls(), 3);
  });

  it("removes an erased top-level item using snapshot ownership", async function () {
    const fixture = installFixture({
      topLevel: [
        { id: 1, libraryID: 1, fields: { title: "Library one" } },
        { id: 42, libraryID: 2, fields: { title: "Erased" } },
      ],
    });
    const index = service();
    await Promise.all([index.getSnapshot(1), index.getSnapshot(2)]);

    fixture.itemById.delete(42);
    await handleAndGet(
      index,
      {
        event: "delete",
        type: "item",
        ids: [42],
        extraData: {},
        receivedAt: Date.now(),
      },
      2,
    );

    assert.isFalse(index.peekSnapshot(2)?.itemById.has(42));
    assert.equal(index.peekSnapshot(1)?.itemById.get(1)?.title, "Library one");
  });

  it("coalesces broad invalidations into one rebuild", async function () {
    const fixture = installFixture({
      topLevel: [{ id: 1, fields: { title: "One" } }],
    });
    const index = service();
    await index.getSnapshot(1);

    for (let indexNumber = 0; indexNumber < 4; indexNumber += 1) {
      await index.handleChange({
        event: "refresh",
        type: "refresh",
        ids: [],
        extraData: { libraryID: 1 },
        receivedAt: Date.now(),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 160));

    assert.equal(fixture.getAllCalls(), 2);
    assert.equal(index.getMetrics().coalescedRebuilds, 1);
  });

  it("discards an invalidated in-flight build and installs only the new epoch", async function () {
    const firstBuild = deferred<Zotero.Item[]>();
    const oldSeed: ItemSeed = { id: 1, fields: { title: "Stale" } };
    const newSeed: ItemSeed = { id: 2, fields: { title: "Current" } };
    let calls = 0;
    installFixture({
      topLevel: [],
      getAll: async () => {
        calls += 1;
        return calls === 1 ? firstBuild.promise : [makeItem(newSeed)];
      },
    });
    const index = service();

    const loading = index.getSnapshot(1);
    index.invalidate(1);
    firstBuild.resolve([makeItem(oldSeed)]);
    const snapshot = await loading;

    assert.equal(calls, 2);
    assert.isFalse(snapshot.itemById.has(1));
    assert.equal(snapshot.itemById.get(2)?.title, "Current");
    assert.equal(index.getMetrics().staleBuildDiscards, 1);
  });

  it("reconciles a targeted notifier without restarting a cold build", async function () {
    const firstBuild = deferred<Zotero.Item[]>();
    const stale = makeItem({ id: 1, fields: { title: "Before notifier" } });
    const current = makeItem({ id: 1, fields: { title: "After notifier" } });
    let calls = 0;
    installFixture({
      topLevel: [{ id: 1, fields: { title: "After notifier" } }],
      getAll: async () => {
        calls += 1;
        return calls === 1 ? firstBuild.promise : [current];
      },
    });
    const index = service();

    const loading = index.getSnapshot(1);
    await index.handleChange({
      event: "modify",
      type: "item",
      ids: [1],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    firstBuild.resolve([stale]);
    const snapshot = await loading;

    assert.equal(calls, 1);
    assert.equal(snapshot.itemById.get(1)?.title, "After notifier");
    assert.equal(index.getMetrics().staleBuildDiscards, 0);
  });

  it("reconciles every possible in-flight owner when an erased ID has no library metadata", async function () {
    const firstLibraryOne = deferred<Zotero.Item[]>();
    const firstLibraryTwo = deferred<Zotero.Item[]>();
    const calls = new Map<number, number>();
    const erased = makeItem({
      id: 42,
      libraryID: 1,
      fields: { title: "Erased during build" },
    });
    const retained = makeItem({
      id: 200,
      libraryID: 2,
      fields: { title: "Retained" },
    });
    const fixture = installFixture({
      topLevel: [
        { id: 42, libraryID: 1, fields: { title: "Erased during build" } },
        { id: 200, libraryID: 2, fields: { title: "Retained" } },
      ],
      getAll: async (libraryID = 1) => {
        const call = (calls.get(libraryID) || 0) + 1;
        calls.set(libraryID, call);
        if (call === 1) {
          return libraryID === 1
            ? firstLibraryOne.promise
            : firstLibraryTwo.promise;
        }
        return libraryID === 1 ? [] : [retained];
      },
    });
    const index = service();
    const loadingOne = index.getSnapshot(1);
    const loadingTwo = index.getSnapshot(2);

    fixture.itemById.delete(42);
    await index.handleChange({
      event: "delete",
      type: "item",
      ids: [42],
      extraData: {},
      receivedAt: Date.now(),
    });
    firstLibraryOne.resolve([erased]);
    firstLibraryTwo.resolve([retained]);
    const [libraryOne, libraryTwo] = await Promise.all([
      loadingOne,
      loadingTwo,
    ]);

    assert.isFalse(libraryOne.itemById.has(42));
    assert.equal(libraryTwo.itemById.get(200)?.title, "Retained");
    assert.equal(calls.get(1), 1);
    assert.equal(calls.get(2), 1);
    assert.equal(index.getMetrics().staleBuildDiscards, 0);
  });

  it("keeps a cold read pending until its background refresh covers the latest invalidation", async function () {
    const firstBuild = deferred<Zotero.Item[]>();
    const secondBuild = deferred<Zotero.Item[]>();
    const thirdBuild = deferred<Zotero.Item[]>();
    const secondStarted = deferred<void>();
    const thirdStarted = deferred<void>();
    let calls = 0;
    installFixture({
      topLevel: [],
      getAll: async () => {
        calls += 1;
        if (calls === 1) return firstBuild.promise;
        if (calls === 2) {
          secondStarted.resolve(undefined);
          return secondBuild.promise;
        }
        thirdStarted.resolve(undefined);
        return thirdBuild.promise;
      },
    });
    const index = service();
    const refresh = () =>
      index.handleChange({
        event: "refresh",
        type: "refresh",
        ids: [],
        extraData: { libraryID: 1 },
        receivedAt: Date.now(),
      });

    const loading = index.getSnapshot(1);
    await refresh();
    firstBuild.resolve([makeItem({ id: 1, fields: { title: "First scan" } })]);
    await secondStarted.promise;
    await refresh();
    secondBuild.resolve([
      makeItem({ id: 2, fields: { title: "Second scan" } }),
    ]);

    let loadingResolved = false;
    void loading.then(() => {
      loadingResolved = true;
    });
    await thirdStarted.promise;
    assert.isFalse(loadingResolved);
    assert.equal(index.peekSnapshot(1)?.itemById.get(2)?.title, "Second scan");
    thirdBuild.resolve([
      makeItem({ id: 3, fields: { title: "Background scan" } }),
    ]);
    const available = await loading;

    assert.equal(calls, 3);
    assert.equal(available.itemById.get(3)?.title, "Background scan");
    assert.strictEqual(await index.getSnapshot(1), available);
    assert.equal(index.getMetrics().staleBuildDiscards, 1);
    assert.equal(index.getMetrics().coalescedRebuilds, 1);
  });

  it("clears a failed load task so a later request can retry", async function () {
    let calls = 0;
    installFixture({
      topLevel: [],
      getAll: async () => {
        calls += 1;
        if (calls === 1) throw new Error("temporary database failure");
        return [makeItem({ id: 9, fields: { title: "Recovered" } })];
      },
    });
    const index = service();

    let firstError = "";
    try {
      await index.getSnapshot(1);
    } catch (error) {
      firstError = error instanceof Error ? error.message : String(error);
    }
    const snapshot = await index.getSnapshot(1);

    assert.include(firstError, "temporary database failure");
    assert.equal(calls, 2);
    assert.equal(snapshot.itemById.get(9)?.title, "Recovered");
  });

  it("drops the snapshot after a failed background rebuild so readers cannot keep consuming stale data", async function () {
    let calls = 0;
    installFixture({
      topLevel: [],
      getAll: async () => {
        calls += 1;
        if (calls === 1) {
          return [makeItem({ id: 1, fields: { title: "Available" } })];
        }
        if (calls === 2) throw new Error("temporary background failure");
        return [makeItem({ id: 2, fields: { title: "Recovered" } })];
      },
    });
    const index = service();
    await index.getSnapshot(1);

    await index.handleChange({
      event: "refresh",
      type: "refresh",
      ids: [],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 160));

    // A snapshot the service failed to refresh must not keep serving
    // peek-only consumers pre-failure data; they fall back to live Zotero
    // reads until the next getSnapshot rebuilds.
    assert.strictEqual(index.peekSnapshot(1), undefined);
    assert.equal(calls, 2);

    const recovered = await index.getSnapshot(1);
    assert.equal(recovered.itemById.get(2)?.title, "Recovered");
    assert.isAtLeast(calls, 3);
    assert.equal(index.peekSnapshot(1)?.itemById.get(2)?.title, "Recovered");
  });

  it("applies repeated patches without rebuilding or mutating old snapshots", async function () {
    this.timeout(10_000);
    const fixture = installFixture({ topLevel: [] });
    const index = service();
    await index.getSnapshot(1);

    const firstSeed: ItemSeed = {
      id: 1,
      fields: { title: "First version" },
    };
    fixture.itemById.set(1, makeItem(firstSeed));
    await handleAndGet(index, {
      event: "add",
      type: "item",
      ids: [1],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    const beforeEdit = index.peekSnapshot(1)!;
    firstSeed.fields!.title = "Second version";
    await handleAndGet(index, {
      event: "modify",
      type: "item",
      ids: [1],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    assert.notStrictEqual(
      beforeEdit.itemById,
      index.peekSnapshot(1)?.itemById,
      "a changed structure must receive a new immutable identity",
    );
    assert.equal(beforeEdit.itemById.get(1)?.title, "First version");
    assert.equal(
      index.peekSnapshot(1)?.itemById.get(1)?.title,
      "Second version",
    );

    fixture.itemById.delete(1);
    await index.handleChange({
      event: "delete",
      type: "item",
      ids: [1],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });

    for (let itemId = 2; itemId <= 1_000; itemId += 1) {
      fixture.itemById.set(
        itemId,
        makeItem({ id: itemId, fields: { title: `Item ${itemId}` } }),
      );
      await index.handleChange({
        event: "add",
        type: "item",
        ids: [itemId],
        extraData: { libraryID: 1 },
        receivedAt: Date.now(),
      });
      fixture.itemById.delete(itemId);
      await index.handleChange({
        event: "delete",
        type: "item",
        ids: [itemId],
        extraData: { libraryID: 1 },
        receivedAt: Date.now(),
      });
    }

    await index.getSnapshot(1);

    const finalSnapshot = index.peekSnapshot(1)!;
    assert.equal(finalSnapshot.itemById.size, 0);
    assert.deepEqual(finalSnapshot.topLevelItemOrder, []);
    assert.isUndefined(
      (finalSnapshot.itemById as { set?: unknown }).set,
      "consumers must not receive the mutable map",
    );
    assert.isUndefined(
      (finalSnapshot.unfiledItemIds as { add?: unknown }).add,
      "consumers must not receive the mutable set",
    );
    assert.equal(fixture.getAllCalls(), 1);
  });

  it("keeps peek reads consistent while a fresh get waits for the queued batch", async function () {
    const item: ItemSeed = { id: 1, fields: { title: "Before" } };
    installFixture({ topLevel: [item] });
    const index = service();
    const before = await index.getSnapshot(1);

    item.fields!.title = "After";
    await index.handleChange({
      event: "modify",
      type: "item",
      ids: [1],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });

    assert.strictEqual(index.peekSnapshot(1), before);
    assert.equal(index.peekSnapshot(1)?.itemById.get(1)?.title, "Before");
    let resolved = false;
    const freshTask = index.getSnapshot(1).then((snapshot) => {
      resolved = true;
      return snapshot;
    });
    await Promise.resolve();
    assert.isFalse(resolved);

    const fresh = await freshTask;
    assert.equal(fresh.itemById.get(1)?.title, "After");
    assert.notStrictEqual(fresh, before);
    assert.equal(before.itemById.get(1)?.title, "Before");
  });

  it("invalidates a failed targeted reconciliation and rebuilds for a fresh read", async function () {
    const item: ItemSeed = { id: 1, fields: { title: "Before" } };
    const fixture = installFixture({ topLevel: [item] });
    const index = service(250, 0);
    const before = await index.getSnapshot(1);
    const itemsApi = Zotero.Items as unknown as {
      get: (id: number) => Zotero.Item | undefined;
    };
    const getItem = itemsApi.get;

    item.fields!.title = "Recovered from live state";
    let itemReads = 0;
    itemsApi.get = (id) => {
      itemReads += 1;
      if (itemReads === 1) return getItem(id);
      throw new Error("targeted projection failed");
    };
    try {
      await index.handleChange({
        event: "modify",
        type: "item",
        ids: [1],
        extraData: { libraryID: 1 },
        receivedAt: Date.now(),
      });
      const fresh = await index.getSnapshot(1);

      assert.equal(fresh.itemById.get(1)?.title, "Recovered from live state");
      assert.equal(fixture.getAllCalls(), 2);
      assert.equal(before.itemById.get(1)?.title, "Before");
    } finally {
      itemsApi.get = getItem;
    }
  });

  it("batches 50k-index updates into one fast atomic publication", async function () {
    this.timeout(15_000);
    const itemCount = 50_000;
    const topLevel = Array.from({ length: itemCount }, (_, offset) => ({
      id: offset + 1,
      fields: { title: `Item ${offset + 1}` },
    }));
    installFixture({ topLevel });
    const index = service(100_000, 0);
    const original = await index.getSnapshot(1);
    const publisher = index as unknown as {
      publishSnapshot: (...args: unknown[]) => void;
    };
    const publishSnapshot = publisher.publishSnapshot.bind(index);
    let publicationCount = 0;
    let atomicPublication = true;
    let expectedBurstIds: number[] = [];
    publisher.publishSnapshot = (...args: unknown[]) => {
      publishSnapshot(...args);
      publicationCount += 1;
      const published = index.peekSnapshot(1)!;
      atomicPublication &&= expectedBurstIds.every(
        (itemId) => published.itemById.get(itemId)?.title === `Burst ${itemId}`,
      );
    };

    topLevel[0].fields.title = "Isolated update";
    const isolatedStartedAt = performance.now();
    await handleAndGet(index, {
      event: "modify",
      type: "item",
      ids: [1],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    const isolatedElapsedMs = performance.now() - isolatedStartedAt;
    const afterIsolated = index.peekSnapshot(1)!;

    assert.equal(publicationCount, 1);
    assert.isBelow(isolatedElapsedMs, 75);
    assert.equal(afterIsolated.itemById.get(1)?.title, "Isolated update");
    assert.equal(original.itemById.get(1)?.title, "Item 1");
    assert.notStrictEqual(afterIsolated.itemById, original.itemById);
    assert.strictEqual(afterIsolated.collectionById, original.collectionById);

    publicationCount = 0;
    expectedBurstIds = Array.from({ length: 100 }, (_, offset) => offset + 2);
    for (const itemId of expectedBurstIds) {
      topLevel[itemId - 1].fields.title = `Burst ${itemId}`;
      await index.handleChange({
        event: "modify",
        type: "item",
        ids: [itemId],
        extraData: { libraryID: 1 },
        receivedAt: Date.now(),
      });
    }
    const burstStartedAt = performance.now();
    const afterBurst = await index.getSnapshot(1);
    const burstElapsedMs = performance.now() - burstStartedAt;

    assert.equal(publicationCount, 1);
    assert.isTrue(atomicPublication);
    assert.isBelow(burstElapsedMs, 250);
    assert.notStrictEqual(afterBurst.itemById, afterIsolated.itemById);
    assert.strictEqual(afterBurst.collectionById, afterIsolated.collectionById);
    assert.equal(afterIsolated.itemById.get(2)?.title, "Item 2");
    assert.equal(original.itemById.get(2)?.title, "Item 2");
  });

  it("does not expose mutable backing stores from published snapshots", async function () {
    const item: ItemSeed = {
      id: 1,
      fields: { title: "Immutable" },
      tags: ["Stable"],
      collections: [10],
    };
    installFixture({
      topLevel: [item],
      collections: [{ id: 10, name: "Collection", childItems: [1] }],
      tagIds: new Map([["Stable", 1]]),
    });
    const index = service(250, 0);
    const before = await index.getSnapshot(1);
    const itemMap = before.itemById as unknown as {
      cloneSource: () => Map<number, unknown>;
      source?: Map<number, unknown>;
    };
    const collectionMembers = before.directItemIdsByCollectionId.get(
      10,
    ) as unknown as {
      cloneSource: () => Set<number>;
      source?: Set<number>;
    };

    assert.isTrue(Object.isFrozen(before));
    assert.isTrue(Object.isFrozen(before.itemById));
    assert.isTrue(Object.isFrozen(collectionMembers));
    assert.isTrue(Object.isFrozen(before.itemById.get(1)));
    assert.isTrue(Object.isFrozen(before.itemById.get(1)?.tags));
    assert.isTrue(
      Object.isFrozen(before.childCollectionIdsByCollectionId.get(10)),
    );
    assert.notInclude(Reflect.ownKeys(before.itemById), "source");
    assert.notInclude(Reflect.ownKeys(collectionMembers), "source");
    assert.isUndefined(itemMap.source);
    assert.isUndefined(collectionMembers.source);
    assert.isUndefined((before.itemById as { set?: unknown }).set);
    assert.isUndefined((collectionMembers as { add?: unknown }).add);
    assert.isFalse(
      Reflect.set(before.itemById as object, "set", () => undefined),
    );
    assert.isFalse(
      Reflect.set(collectionMembers as object, "add", () => undefined),
    );
    assert.isFalse(
      Reflect.set(before.itemById.get(1)?.tags as object, "0", "Injected"),
    );

    const mapCopy = itemMap.cloneSource();
    mapCopy.delete(1);
    mapCopy.set(999, { title: "Injected" });
    const memberCopy = collectionMembers.cloneSource();
    memberCopy.clear();
    memberCopy.add(999);
    assert.isTrue(before.itemById.has(1));
    assert.isFalse(before.itemById.has(999));
    assert.deepEqual(
      [...(before.directItemIdsByCollectionId.get(10) || [])],
      [1],
    );

    item.fields!.title = "Published later";
    await handleAndGet(index, {
      event: "modify",
      type: "item",
      ids: [1],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    const after = index.peekSnapshot(1)!;

    assert.equal(after.itemById.get(1)?.title, "Published later");
    assert.isFalse(after.itemById.has(999));
    assert.deepEqual(
      [...(after.directItemIdsByCollectionId.get(10) || [])],
      [1],
    );
    assert.equal(before.itemById.get(1)?.title, "Immutable");
  });

  it("preserves filename-only PDFs in gateway paper listings", async function () {
    const fixture = installFixture({
      topLevel: [
        {
          id: 1,
          fields: { title: "Linked PDF" },
          attachments: [10],
        },
      ],
      children: [
        {
          id: 10,
          kind: "attachment",
          parentID: 1,
          fields: { title: "Filename-only PDF" },
          contentType: "application/octet-stream",
          filename: "linked-paper.pdf",
        },
      ],
    });

    const result = await new ZoteroGateway().listLibraryPaperTargets({
      libraryID: 1,
    });

    assert.deepEqual(
      result.papers.map((paper) => paper.itemId),
      [1],
    );
    assert.equal(fixture.getAllCalls(), 1);
  });

  it("honors automatic-tag visibility in aggregate listing and retrieval scopes", async function () {
    installFixture({
      topLevel: [
        { id: 1, fields: { title: "Manual" }, tags: ["Manual"] },
        {
          id: 2,
          fields: { title: "Automatic only" },
          tags: [{ tag: "Automatic", type: 1 }],
        },
        { id: 3, fields: { title: "No tags" }, tags: [] },
      ],
      tagIds: new Map([
        ["Manual", 1],
        ["Automatic", 2],
      ]),
    });
    const gateway = new ZoteroGateway();
    const list = async (
      scope: "allTagged" | "untagged",
      includeAutomatic: boolean,
    ) =>
      gateway.listTagItemTargets({
        libraryID: 1,
        tagContext: { name: scope, scope, includeAutomatic },
      });

    assert.deepEqual(
      (await list("allTagged", false)).items.map((item) => item.itemId),
      [1],
    );
    assert.deepEqual(
      (await list("untagged", false)).items.map((item) => item.itemId),
      [2, 3],
    );
    assert.deepEqual(
      (await list("allTagged", true)).items.map((item) => item.itemId),
      [1, 2],
    );
    assert.deepEqual(
      (await list("untagged", true)).items.map((item) => item.itemId),
      [3],
    );

    const scoped = await gateway.resolveLibraryScopeItemIds({
      libraryID: 1,
      tagContexts: [
        { name: "untagged", scope: "untagged", includeAutomatic: false },
      ],
    });
    assert.deepEqual(scoped.itemIds, [2, 3]);
  });

  it("excludes trashed standalone and child notes from fallback search", async function () {
    installFixture({
      topLevel: [
        {
          id: 1,
          kind: "note",
          fields: { title: "Active match" },
          noteHtml: "needle",
        },
        {
          id: 2,
          kind: "note",
          fields: { title: "Trashed match" },
          noteHtml: "needle",
          deleted: true,
        },
        {
          id: 3,
          fields: { title: "Trashed parent" },
          notes: [4],
          deleted: true,
        },
      ],
      children: [
        {
          id: 4,
          kind: "note",
          parentID: 3,
          fields: { title: "Child match" },
          noteHtml: "needle",
        },
      ],
    });

    const results = await new ZoteroGateway().searchAllNotes({
      libraryID: 1,
      query: "needle",
    });

    assert.deepEqual(
      results.map((result) => result.itemId),
      [1],
    );
  });

  it("projects synthetic 1k, 10k, and 50k libraries once and serves warm reads without I/O", async function () {
    this.timeout(20_000);
    for (const size of [1_000, 10_000, 50_000]) {
      const topLevel = Array.from({ length: size }, (_, offset) => ({
        id: offset + 1,
        fields: { title: `Synthetic ${offset + 1}` },
        tags: offset % 2 ? ["Odd"] : [],
        collections: offset % 3 ? [] : [10],
      }));
      const fixture = installFixture({
        topLevel,
        collections: [{ id: 10, name: "Every third item" }],
        tagIds: new Map([["Odd", 1]]),
      });
      const index = service(1_000);

      const snapshot = await index.getSnapshot(1);
      for (let request = 0; request < 3; request += 1) {
        const warm = await index.getSnapshot(1);
        assert.strictEqual(warm, snapshot);
        assert.equal(index.orderedItemIds(warm).length, size);
        assert.equal(index.tagItemIds(warm, "odd", false).size, size / 2);
      }

      assert.equal(fixture.getAllCalls(), 1);
      assert.equal(index.getMetrics().projectedTopLevelItems, size);
      index.clearForTests();
    }
  });
});

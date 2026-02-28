import { assert } from "chai";
import {
  browsePaperCollectionCandidates,
  invalidatePaperSearchCache,
  searchPaperCandidates,
} from "../src/modules/contextPanel/paperSearch";

type MockCreator = _ZoteroTypes.Item.Creator;

type MockRegularItemOptions = {
  id: number;
  libraryID?: number;
  title: string;
  shortTitle?: string;
  citationKey?: string;
  doi?: string;
  firstCreator?: string;
  creators?: MockCreator[];
  date?: string;
  publicationTitle?: string;
  journalAbbreviation?: string;
  proceedingsTitle?: string;
  conferenceName?: string;
  dateModified?: string;
  attachmentIDs?: number[];
  collectionIDs?: number[];
};

type MockAttachmentOptions = {
  id: number;
  title?: string;
  filename?: string;
};

type MockCollectionOptions = {
  id: number;
  name: string;
  parentID?: number;
  childCollectionIDs?: number[];
  childItemIDs?: number[];
};

type MockItem = Zotero.Item & {
  attachmentFilename?: string;
};

type MockCollection = Zotero.Collection;

function makeCreator(firstName: string, lastName: string): MockCreator {
  return {
    firstName,
    lastName,
    fieldMode: 0,
    creatorTypeID: 8 as keyof _ZoteroTypes.Item.CreatorTypeMapping,
  };
}

function makeRegularItem(options: MockRegularItemOptions): MockItem {
  const {
    id,
    libraryID = 1,
    title,
    shortTitle,
    citationKey,
    doi,
    firstCreator,
    creators = [],
    date,
    publicationTitle,
    journalAbbreviation,
    proceedingsTitle,
    conferenceName,
    dateModified = "2025-01-01T00:00:00Z",
    attachmentIDs = [],
    collectionIDs = [],
  } = options;
  const fields = {
    title,
    shortTitle: shortTitle || "",
    citationKey: citationKey || "",
    DOI: doi || "",
    firstCreator: firstCreator || "",
    date: date || "",
    publicationTitle: publicationTitle || "",
    journalAbbreviation: journalAbbreviation || "",
    proceedingsTitle: proceedingsTitle || "",
    conferenceName: conferenceName || "",
  };
  return {
    id,
    key: `ITEM-${id}`,
    libraryID,
    dateModified,
    firstCreator: firstCreator || "",
    parentID: undefined,
    attachmentContentType: "",
    isAttachment: () => false,
    isRegularItem: () => true,
    getAttachments: () => attachmentIDs,
    getCollections: () => collectionIDs,
    getField: (field: string) => fields[field as keyof typeof fields] || "",
    getCreators: () => creators,
  } as unknown as MockItem;
}

function makeAttachment(options: MockAttachmentOptions): MockItem {
  const { id, title = "", filename = "" } = options;
  return {
    id,
    key: `ATTACH-${id}`,
    libraryID: 1,
    dateModified: "2025-01-01T00:00:00Z",
    attachmentContentType: "application/pdf",
    attachmentFilename: filename,
    isAttachment: () => true,
    isRegularItem: () => false,
    getAttachments: () => [],
    getCollections: () => [],
    getField: (field: string) => (field === "title" ? title : ""),
    getCreators: () => [],
  } as unknown as MockItem;
}

function makeCollection(options: MockCollectionOptions): MockCollection {
  const {
    id,
    name,
    parentID = 0,
    childCollectionIDs = [],
    childItemIDs = [],
  } = options;
  return {
    id,
    name,
    parentID,
    getChildCollections: () => childCollectionIDs,
    getChildItems: () => childItemIDs,
  } as unknown as MockCollection;
}

describe("paperSearch", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (globalThis as typeof globalThis & { ztoolkit?: any })
    .ztoolkit;

  let itemsById: Map<number, MockItem>;
  let collectionsById: Map<number, MockCollection>;
  let getAllCount = 0;

  const installMockZotero = () => {
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Items: {
        getAll: async () => {
          getAllCount += 1;
          return Array.from(itemsById.values()) as Zotero.Item[];
        },
        get: (id: number) => itemsById.get(id) || null,
      },
      Collections: {
        getByLibrary: () => Array.from(collectionsById.values()),
      },
      Libraries: {
        getName: () => "My Library",
      },
    } as typeof Zotero;
    (globalThis as typeof globalThis & { ztoolkit: { log: () => void } })
      .ztoolkit = {
      log: () => {},
    };
  };

  beforeEach(function () {
    itemsById = new Map<number, MockItem>();
    collectionsById = new Map<number, MockCollection>();
    getAllCount = 0;
    invalidatePaperSearchCache();
    installMockZotero();
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  it("finds multi-token queries by title, year, and any author", async function () {
    itemsById.set(
      1,
      makeRegularItem({
        id: 1,
        title: "Attention Is All You Need",
        citationKey: "Vaswani2017",
        firstCreator: "Ashish Vaswani",
        creators: [makeCreator("Ashish", "Vaswani"), makeCreator("Noam", "Shazeer")],
        date: "2017-06-01",
        publicationTitle: "NeurIPS",
        attachmentIDs: [101],
      }),
    );
    itemsById.set(101, makeAttachment({ id: 101, title: "Main PDF" }));
    itemsById.set(
      2,
      makeRegularItem({
        id: 2,
        title: "Transformers in Vision",
        firstCreator: "Ada Lovelace",
        creators: [makeCreator("Ada", "Lovelace")],
        date: "2021-03-02",
        attachmentIDs: [102],
      }),
    );
    itemsById.set(102, makeAttachment({ id: 102, title: "Vision Transformer" }));

    const results = await searchPaperCandidates(1, "transformer 2017 shazeer");

    assert.isAtLeast(results.length, 1);
    assert.equal(results[0].itemId, 1);
    assert.lengthOf(results[0].attachments, 1);
  });

  it("normalizes punctuation and diacritics for search", async function () {
    itemsById.set(
      3,
      makeRegularItem({
        id: 3,
        title: "Graph-Neural Networks: A Survey",
        firstCreator: "Jose Garcia Marquez",
        creators: [makeCreator("José", "García Márquez")],
        date: "2022",
        attachmentIDs: [103],
      }),
    );
    itemsById.set(103, makeAttachment({ id: 103, title: "Survey PDF" }));

    const punctuationResults = await searchPaperCandidates(
      1,
      "graph neural networks",
    );
    const diacriticResults = await searchPaperCandidates(1, "garcia marquez");

    assert.equal(punctuationResults[0]?.itemId, 3);
    assert.equal(diacriticResults[0]?.itemId, 3);
  });

  it("matches compact slash-style queries against spaced titles", async function () {
    itemsById.set(
      31,
      makeRegularItem({
        id: 31,
        title: "Working Memory Dynamics",
        firstCreator: "Ava Example",
        attachmentIDs: [131],
      }),
    );
    itemsById.set(131, makeAttachment({ id: 131, title: "Working Memory PDF" }));

    const results = await searchPaperCandidates(1, "workingmemory");

    assert.equal(results[0]?.itemId, 31);
  });

  it("supports DOI lookup while excluding papers without PDFs", async function () {
    itemsById.set(
      4,
      makeRegularItem({
        id: 4,
        title: "Retrieval-Augmented Generation",
        doi: "10.1000/example-doi",
        attachmentIDs: [104],
      }),
    );
    itemsById.set(104, makeAttachment({ id: 104, title: "RAG PDF" }));
    itemsById.set(
      5,
      makeRegularItem({
        id: 5,
        title: "Retrieval-Augmented Generation",
        doi: "10.1000/example-doi",
      }),
    );

    const results = await searchPaperCandidates(1, "10.1000/example-doi");

    assert.lengthOf(results, 1);
    assert.equal(results[0].itemId, 4);
  });

  it("builds collection browse results with nested folders and unfiled papers", async function () {
    itemsById.set(
      6,
      makeRegularItem({
        id: 6,
        title: "Folder Paper",
        firstCreator: "Folder Author",
        attachmentIDs: [106],
        collectionIDs: [11],
      }),
    );
    itemsById.set(106, makeAttachment({ id: 106, title: "Folder PDF" }));
    itemsById.set(
      7,
      makeRegularItem({
        id: 7,
        title: "Loose Paper",
        firstCreator: "Loose Author",
        attachmentIDs: [107],
      }),
    );
    itemsById.set(107, makeAttachment({ id: 107, title: "Loose PDF" }));

    collectionsById.set(
      10,
      makeCollection({
        id: 10,
        name: "Neural",
        childCollectionIDs: [11],
      }),
    );
    collectionsById.set(
      11,
      makeCollection({
        id: 11,
        name: "Transformers",
        parentID: 10,
        childItemIDs: [6],
      }),
    );
    collectionsById.set(
      12,
      makeCollection({
        id: 12,
        name: "Reinforcement Learning",
      }),
    );

    const results = await browsePaperCollectionCandidates(1);
    const neural = results.find((collection) => collection.collectionId === 10);
    const unfiled = results.find((collection) => collection.collectionId === 0);

    assert.deepEqual(
      results.map((collection) => collection.name),
      ["Neural", "Reinforcement Learning", "My Library"],
    );
    assert.isDefined(neural);
    assert.deepEqual(
      neural?.childCollections.map((collection) => collection.name),
      ["Transformers"],
    );
    assert.equal(neural?.childCollections[0]?.papers[0]?.itemId, 6);
    assert.isDefined(unfiled);
    assert.equal(unfiled?.papers[0]?.itemId, 7);
  });

  it("reuses the library index until the cache is invalidated", async function () {
    itemsById.set(
      8,
      makeRegularItem({
        id: 8,
        title: "Cache Me If You Can",
        firstCreator: "Cache Author",
        attachmentIDs: [108],
      }),
    );
    itemsById.set(108, makeAttachment({ id: 108, title: "Cache PDF" }));

    await searchPaperCandidates(1, "cache author");
    await browsePaperCollectionCandidates(1);
    assert.equal(getAllCount, 1);

    invalidatePaperSearchCache(1);
    await searchPaperCandidates(1, "cache");
    assert.equal(getAllCount, 2);
  });
});

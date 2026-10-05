import { assert } from "chai";
import {
  indexItemMatchesAggregateTagScope,
  isPaperScopeItem,
  libraryIndexTagItemIds,
  resolvePaperScope,
  type PaperScopeSnapshot,
} from "../src/services/libraryIndex/paperScope";
import type {
  LibraryIndexItem,
  LibraryIndexTag,
} from "../src/services/libraryIndex/contracts";

function item(
  seed: Partial<LibraryIndexItem> & { itemId: number },
): LibraryIndexItem {
  return {
    libraryID: 1,
    itemType: "journalArticle",
    kind: "regular",
    title: `Paper ${seed.itemId}`,
    shortTitle: "",
    citationKey: "",
    doi: "",
    creators: [],
    firstCreator: "",
    publicationTitle: "",
    venue: "",
    date: "",
    year: "",
    abstractNote: "",
    extra: "",
    tags: [],
    automaticTags: [],
    collectionIds: [],
    attachmentIds: [],
    childNoteIds: [],
    dateAdded: "",
    dateModified: "",
    addedAt: 0,
    modifiedAt: 0,
    deleted: false,
    ...seed,
  };
}

function tag(
  normalizedName: string,
  manual: number[],
  automatic: number[] = [],
): [string, LibraryIndexTag] {
  return [
    normalizedName,
    {
      normalizedName,
      displayVariants: [normalizedName],
      manualItemIds: new Set(manual),
      automaticItemIds: new Set(automatic),
    },
  ];
}

/**
 * Folder 10 (library 1) holds 1, 2, a trashed 3 and a note 4; its child
 * folder 11 holds 5; folder 20 sits in library 2. Tag "a" is manual on 1 and
 * 3 and automatic on 5; "b" is manual on 2.
 */
function snapshot(): PaperScopeSnapshot {
  const items = [
    item({ itemId: 1, tags: ["a"] }),
    item({ itemId: 2, tags: ["b"] }),
    item({ itemId: 3, tags: ["a"], deleted: true }),
    item({ itemId: 4, kind: "standalone-note" }),
    item({ itemId: 5, automaticTags: ["a"] }),
    item({ itemId: 6 }),
  ];
  return {
    itemById: new Map(items.map((entry) => [entry.itemId, entry])),
    topLevelItemOrder: items.map((entry) => entry.itemId),
    collectionById: new Map([
      [
        10,
        {
          collectionId: 10,
          libraryID: 1,
          name: "Folder",
          parentCollectionId: 0,
          deleted: false,
        },
      ],
      [
        11,
        {
          collectionId: 11,
          libraryID: 1,
          name: "Child",
          parentCollectionId: 10,
          deleted: false,
        },
      ],
      [
        20,
        {
          collectionId: 20,
          libraryID: 2,
          name: "Other library",
          parentCollectionId: 0,
          deleted: false,
        },
      ],
    ]),
    directItemIdsByCollectionId: new Map([
      [10, new Set([1, 2, 3, 4])],
      [11, new Set([5])],
      [20, new Set([6])],
    ]),
    // Folder 11 has no path, so its own name is used.
    collectionPathById: new Map([[10, "Folder"]]),
    tagByNormalizedName: new Map([tag("a", [1, 3], [5]), tag("b", [2])]),
  } as PaperScopeSnapshot;
}

describe("libraryIndex paperScope", function () {
  it("counts only live regular items as papers", function () {
    const items = snapshot().itemById;
    assert.isTrue(isPaperScopeItem(items.get(1)));
    assert.isFalse(isPaperScopeItem(items.get(3)));
    assert.isFalse(isPaperScopeItem(items.get(4)));
    assert.isFalse(isPaperScopeItem(undefined));
  });

  it("matches aggregate tag scopes with and without automatic tags", function () {
    const automaticOnly = snapshot().itemById.get(5)!;
    assert.isFalse(
      indexItemMatchesAggregateTagScope(automaticOnly, "allTagged", false),
    );
    assert.isTrue(
      indexItemMatchesAggregateTagScope(automaticOnly, "allTagged", true),
    );
    assert.isTrue(
      indexItemMatchesAggregateTagScope(automaticOnly, "untagged", false),
    );
    assert.isFalse(
      indexItemMatchesAggregateTagScope(automaticOnly, "untagged", true),
    );
  });

  it("looks a tag up by its normalized identity", function () {
    assert.deepEqual(
      [...libraryIndexTagItemIds(snapshot(), "A", false)],
      [1, 3],
    );
    assert.deepEqual(
      [...libraryIndexTagItemIds(snapshot(), "a", true)],
      [1, 3, 5],
    );
    assert.deepEqual([...libraryIndexTagItemIds(snapshot(), "zz", true)], []);
  });

  it("unions papers, then folders, then tags, each paper once", function () {
    assert.deepEqual(
      resolvePaperScope(snapshot(), {
        libraryID: 1,
        itemIds: [6, 4, 3],
        collectionIds: [20, 11, 10, 99],
        tagContexts: [
          { name: "a", includeAutomatic: true },
          { name: "", normalizedName: "B" },
        ],
        excludedItemIds: [2],
      }),
      {
        itemIds: [6, 5, 1],
        // Excluded 2 and trashed 3 are not tag papers of the scope.
        tagItemIds: [1, 5],
        collectionNames: ["Child", "Folder"],
        tagNames: ["a", ""],
        // Child adds 5; Folder adds 1; tag "a" counts 1 and 5 again.
        summedScopeCount: 4,
      },
    );
  });

  it("reads aggregate tag scopes in top-level order", function () {
    const scope = resolvePaperScope(snapshot(), {
      libraryID: 1,
      tagContexts: [
        { name: "Untagged", scope: "untagged" },
        { name: "All Tagged", scope: "allTagged", includeAutomatic: true },
      ],
    });
    assert.deepEqual(scope.itemIds, [5, 6, 1, 2]);
    assert.deepEqual(scope.tagItemIds, [5, 6, 1, 2]);
    assert.equal(scope.summedScopeCount, 5);
  });

  it("skips the folders of other libraries by the requested library", function () {
    assert.deepEqual(
      resolvePaperScope(snapshot(), { libraryID: 2, collectionIds: [20, 10] })
        .itemIds,
      [6],
    );
  });

  it("is empty when nothing is requested", function () {
    assert.deepEqual(resolvePaperScope(snapshot(), { libraryID: 1 }), {
      itemIds: [],
      tagItemIds: [],
      collectionNames: [],
      tagNames: [],
      summedScopeCount: 0,
    });
  });
});

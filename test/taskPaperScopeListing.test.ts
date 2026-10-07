import { assert } from "chai";
import {
  TASK_PAPER_SCOPE_MAX_TAGS,
  TASK_PAPER_SCOPE_WHOLE_LIBRARY_CAP,
  listTaskPaperScope,
  resolveTaskPaperScopeItemIds,
  resolveTaskPaperScopeSet,
  statesTurnPaperScope,
  taskPaperScopeContextsOf,
  type TaskPaperScopeContexts,
} from "../src/agent/context/taskPaperScopeListing";
import { buildTurnPaperScope } from "../src/agent/context/turnPaperScope";
import { resolveTaskProgressTurnScope } from "../src/modules/contextPanel/taskProgress/visibility";
import type {
  LibraryIndexItem,
  LibraryIndexSnapshot,
  LibraryIndexTag,
} from "../src/services/libraryIndex/contracts";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { libraryIndexService } from "../src/services/libraryIndexService";

type ItemSeed = Partial<LibraryIndexItem> & { itemId: number };

function item(seed: ItemSeed): LibraryIndexItem {
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

/**
 * Two collections (Drift, and its child Drift/Rodents), a manual and an
 * automatic tag, a trashed paper, a standalone note, and a paper without PDF.
 */
function fakeSnapshot(): LibraryIndexSnapshot {
  const items = [
    item({
      itemId: 1,
      title: "Drift in CA1",
      year: "2021",
      firstCreator: "Smith",
      collectionIds: [10],
      tags: ["drift", "place cells", "a", "b", "c", "d", "e"],
    }),
    item({ itemId: 2, collectionIds: [10, 11], tags: ["learning"] }),
    item({ itemId: 3, collectionIds: [11], automaticTags: ["learning"] }),
    item({ itemId: 4, collectionIds: [10], deleted: true, tags: ["drift"] }),
    item({ itemId: 5, kind: "standalone-note", collectionIds: [10] }),
    item({ itemId: 6, tags: ["Learning"] }),
    item({ itemId: 7 }),
  ];
  const tag = (
    normalizedName: string,
    manual: number[],
    automatic: number[] = [],
  ): [string, LibraryIndexTag] => [
    normalizedName,
    {
      normalizedName,
      displayVariants: [normalizedName],
      manualItemIds: new Set(manual),
      automaticItemIds: new Set(automatic),
    },
  ];
  return {
    libraryID: 1,
    libraryName: "My Library",
    epoch: 1,
    builtAt: 0,
    itemById: new Map(items.map((entry) => [entry.itemId, entry])),
    topLevelItemOrder: items.map((entry) => entry.itemId),
    attachmentById: new Map([
      [
        101,
        {
          attachmentId: 101,
          libraryID: 1,
          parentItemId: 1,
          title: "PDF",
          filename: "a.pdf",
          contentType: "application/pdf",
          isStandalone: false,
          hasPdfMime: true,
          hasPdfFilename: true,
          isPdf: true,
          isContextEligiblePdf: true,
          isMineruPackage: false,
        },
      ],
    ]),
    childAttachmentIdsByItemId: new Map([[1, [101]]]),
    pdfAttachmentIdsByItemId: new Map([[1, [101]]]),
    childNoteIdsByItemId: new Map(),
    childNoteById: new Map(),
    parentItemIdByChildId: new Map([[101, 1]]),
    collectionById: new Map([
      [
        10,
        {
          collectionId: 10,
          libraryID: 1,
          name: "Drift",
          parentCollectionId: 0,
          deleted: false,
        },
      ],
      [
        11,
        {
          collectionId: 11,
          libraryID: 1,
          name: "Rodents",
          parentCollectionId: 10,
          deleted: false,
        },
      ],
    ]),
    directItemIdsByCollectionId: new Map([
      [10, new Set([1, 2, 4, 5])],
      [11, new Set([2, 3])],
    ]),
    childCollectionIdsByCollectionId: new Map([[10, [11]]]),
    collectionPathById: new Map([
      [10, "Drift"],
      [11, "Drift/Rodents"],
    ]),
    tagByNormalizedName: new Map([
      tag("drift", [1, 4]),
      tag("learning", [2, 6], [3]),
      tag("place cells", [1]),
    ]),
    normalizedTagNameByTagId: new Map(),
    tagIdsByNormalizedName: new Map(),
    unfiledItemIds: new Set([6, 7]),
    untaggedItemIds: new Set([7]),
    pdfCapableItemIds: new Set([1]),
    searchableFieldsByItemId: new Map(),
  } as LibraryIndexSnapshot;
}

describe("taskPaperScopeListing", function () {
  it("lists attached papers, folders and tags in retrieval's union order", function () {
    const snapshot = fakeSnapshot();
    const listing = listTaskPaperScope(snapshot, {
      papers: [{ itemId: 7 }],
      collections: [{ collectionId: 10 }],
      tags: [{ name: "Learning" }],
    });
    assert.deepEqual(
      listing.entries.map((entry) => entry.itemId),
      [7, 1, 2, 6],
      "trashed items, notes and automatic-only tag hits are excluded",
    );
    assert.equal(listing.totalItems, 4);
    assert.equal(listing.listedItems, 4);
    assert.isFalse(listing.truncated);
    assert.isFalse(listing.wholeLibrary);
    assert.deepEqual(listing.entries[1], {
      key: "1:1",
      libraryID: 1,
      itemId: 1,
      title: "Drift in CA1",
      year: "2021",
      firstCreator: "Smith",
      collectionPaths: ["Drift"],
      tags: ["drift", "place cells", "a", "b", "c", "d"],
      text: "pdf",
    });
    assert.lengthOf(listing.entries[1].tags, TASK_PAPER_SCOPE_MAX_TAGS);
    assert.deepEqual(listing.entries[2].collectionPaths, [
      "Drift",
      "Drift/Rodents",
    ]);
    assert.equal(listing.entries[2].text, "none");
  });

  it("leaves out papers the user removed from the task", function () {
    const listing = listTaskPaperScope(fakeSnapshot(), {
      collections: [{ collectionId: 10 }],
      excludedItemIds: [2],
    });
    assert.deepEqual(
      listing.entries.map((entry) => entry.itemId),
      [1],
      "the folder's other paper stays; the removed one is gone",
    );
    assert.equal(listing.totalItems, 1);
  });

  it("does not expand subcollections, as retrieval does not", function () {
    const listing = listTaskPaperScope(fakeSnapshot(), {
      collections: [{ collectionId: 10 }],
    });
    assert.deepEqual(
      listing.entries.map((entry) => entry.itemId),
      [1, 2],
    );
  });

  it("honours automatic tags and aggregate tag scopes", function () {
    const snapshot = fakeSnapshot();
    assert.deepEqual(
      resolveTaskPaperScopeItemIds(snapshot, {
        tags: [{ name: "learning", includeAutomatic: true }],
      }),
      [2, 6, 3],
    );
    assert.deepEqual(
      resolveTaskPaperScopeItemIds(snapshot, {
        tags: [{ name: "Untagged", scope: "untagged" }],
      }),
      [3, 7],
    );
  });

  it("lists the whole library, capped, when nothing is attached", function () {
    const listing = listTaskPaperScope(
      fakeSnapshot(),
      {},
      {
        wholeLibraryCap: 3,
      },
    );
    assert.isTrue(listing.wholeLibrary);
    assert.deepEqual(
      listing.entries.map((entry) => entry.itemId),
      [1, 2, 3],
    );
    assert.equal(listing.totalItems, 5);
    assert.equal(listing.listedItems, 3);
    assert.isTrue(listing.truncated);
  });

  describe("the set a turn's scope covers", function () {
    it("is every paper of the scope, uncapped, with how many have a PDF", function () {
      assert.deepEqual(
        resolveTaskPaperScopeSet(fakeSnapshot(), {
          collections: [{ collectionId: 10 }],
          tags: [{ name: "Learning" }],
          excludedItemIds: [6],
        }),
        {
          wholeLibrary: false,
          itemIds: [1, 2],
          withText: 1,
          papers: {
            1: { title: "Drift in CA1", text: "pdf" },
            2: { title: "Paper 2", text: "none" },
          },
        },
      );
    });

    it("is the whole library, past the listing's cap, when nothing is attached", function () {
      const snapshot = fakeSnapshot();
      const extra = TASK_PAPER_SCOPE_WHOLE_LIBRARY_CAP + 5;
      const ids = Array.from({ length: extra }, (_, index) => 1000 + index);
      const itemById = new Map(snapshot.itemById);
      for (const itemId of ids) itemById.set(itemId, item({ itemId }));
      const large = {
        ...snapshot,
        itemById,
        topLevelItemOrder: [...snapshot.topLevelItemOrder, ...ids],
      } as LibraryIndexSnapshot;
      const set = resolveTaskPaperScopeSet(large, {});
      assert.isTrue(set.wholeLibrary);
      assert.deepEqual(set.itemIds.slice(0, 5), [1, 2, 3, 6, 7]);
      assert.lengthOf(set.itemIds, 5 + extra);
      assert.equal(set.withText, 1);
    });

    it("is stated for a folder, a tag, the whole library or two papers, never for one paper", function () {
      const paper = (itemId: number) => ({
        itemId,
        contextItemId: itemId + 100,
        title: `Paper ${itemId}`,
        libraryID: 1,
      });
      const scopeOf = (input: Parameters<typeof buildTurnPaperScope>[0]) => {
        const built = buildTurnPaperScope({ libraryID: 1, ...input });
        assert.isTrue(built.ok);
        return (built as Extract<typeof built, { ok: true }>).scope;
      };
      const cases: Array<
        [string, Parameters<typeof buildTurnPaperScope>[0], boolean]
      > = [
        ["the whole library", {}, true],
        ["one paper", { selectedPaperContexts: [paper(1)] }, false],
        [
          "a paper chat's own paper",
          { conversationKind: "paper", activePaperContext: paper(1) },
          false,
        ],
        ["two papers", { selectedPaperContexts: [paper(1), paper(2)] }, true],
        [
          "one paper and a folder",
          {
            selectedPaperContexts: [paper(1)],
            selectedCollectionContexts: [
              { collectionId: 10, name: "Drift", libraryID: 1 },
            ],
          },
          true,
        ],
        [
          "a tag",
          { selectedTagContexts: [{ name: "drift", libraryID: 1 }] },
          true,
        ],
      ];
      for (const [label, input, stated] of cases) {
        assert.equal(statesTurnPaperScope(scopeOf(input)), stated, label);
      }
    });

    it("reads a turn's papers, folders, tags and removals as Task progress does", function () {
      const paper = (itemId: number) => ({
        itemId,
        contextItemId: itemId + 100,
        title: `Paper ${itemId}`,
        libraryID: 1,
      });
      const collections = [
        {
          collectionId: 11,
          name: "Rodents",
          libraryID: 1,
          excludedItemIds: [3],
        },
      ];
      const tags = [{ name: "Learning", libraryID: 1 }];
      const built = buildTurnPaperScope({
        libraryID: 1,
        conversationKind: "paper",
        activeItemId: 7,
        activePaperContext: paper(7),
        selectedPaperContexts: [paper(1)],
        selectedCollectionContexts: collections,
        selectedTagContexts: tags,
      });
      assert.isTrue(built.ok);
      if (!built.ok) return;
      const contexts = taskPaperScopeContextsOf(built.scope);
      const shown = resolveTaskProgressTurnScope({
        message: {
          paperContexts: [paper(1)],
          selectedCollectionContexts: collections,
          selectedTagContexts: tags,
        },
        conversationKind: "paper",
        libraryID: 1,
        basePaperItemId: 7,
      });
      const snapshot = fakeSnapshot();
      assert.deepEqual(
        resolveTaskPaperScopeItemIds(snapshot, contexts),
        [7, 1, 2, 6],
      );
      assert.deepEqual(
        resolveTaskPaperScopeItemIds(snapshot, contexts),
        resolveTaskPaperScopeItemIds(snapshot, shown.contexts),
      );
      assert.deepEqual(contexts.excludedItemIds, [3]);
    });
  });

  describe("agrees with ZoteroGateway.resolveLibraryScopeItemIds", function () {
    const originalGetSnapshot = libraryIndexService.getSnapshot;

    before(function () {
      const snapshot = fakeSnapshot();
      (
        libraryIndexService as unknown as {
          getSnapshot: (libraryID: number) => Promise<LibraryIndexSnapshot>;
        }
      ).getSnapshot = async () => snapshot;
    });

    after(function () {
      (libraryIndexService as unknown as { getSnapshot: unknown }).getSnapshot =
        originalGetSnapshot;
    });

    const cases: Array<[string, TaskPaperScopeContexts]> = [
      ["papers", { papers: [{ itemId: 7 }, { itemId: 4 }, { itemId: 5 }] }],
      ["one folder", { collections: [{ collectionId: 10 }] }],
      [
        "overlapping folders",
        { collections: [{ collectionId: 11 }, { collectionId: 10 }] },
      ],
      ["unknown folder", { collections: [{ collectionId: 99 }] }],
      ["manual tag", { tags: [{ name: "Learning" }] }],
      [
        "automatic tag",
        { tags: [{ name: "learning", includeAutomatic: true }] },
      ],
      [
        "aggregate scopes",
        {
          tags: [
            { name: "All Tagged", scope: "allTagged", includeAutomatic: true },
            { name: "Untagged", scope: "untagged" },
          ],
        },
      ],
      [
        "everything",
        {
          papers: [{ itemId: 6 }],
          collections: [{ collectionId: 11 }],
          tags: [{ name: "drift" }, { name: "place cells" }],
        },
      ],
      [
        "papers removed in Task progress",
        {
          collections: [{ collectionId: 10 }],
          tags: [{ name: "Learning" }],
          excludedItemIds: [2, 4],
        },
      ],
    ];

    for (const [label, contexts] of cases) {
      it(`matches for ${label}`, async function () {
        const resolved = await new ZoteroGateway().resolveLibraryScopeItemIds({
          libraryID: 1,
          itemIds: (contexts.papers || []).map((paper) => paper.itemId),
          collectionIds: (contexts.collections || []).map(
            (collection) => collection.collectionId,
          ),
          tagContexts: (contexts.tags || []).map((tag) => ({
            name: tag.name,
            normalizedName: tag.normalizedName,
            scope: tag.scope,
            includeAutomatic: tag.includeAutomatic,
          })),
          excludedItemIds: contexts.excludedItemIds,
        });
        assert.deepEqual(
          resolveTaskPaperScopeItemIds(fakeSnapshot(), contexts),
          resolved.itemIds,
        );
        assert.deepEqual(
          listTaskPaperScope(fakeSnapshot(), contexts).entries.map(
            (entry) => entry.itemId,
          ),
          resolved.itemIds,
        );
      });
    }
  });

  describe("characterizes the shared scope union", function () {
    const originalGetSnapshot = libraryIndexService.getSnapshot;

    /**
     * The shared fixture plus a folder from another library, a tag whose
     * members include a trashed paper, a standalone note and an automatic
     * tagging, and a tag held only by a standalone note.
     */
    function characterizationSnapshot(): LibraryIndexSnapshot {
      const snapshot = fakeSnapshot();
      const collectionById = new Map(snapshot.collectionById);
      collectionById.set(12, {
        collectionId: 12,
        libraryID: 2,
        name: "Elsewhere",
        parentCollectionId: 0,
        deleted: false,
      });
      const directItemIdsByCollectionId = new Map(
        snapshot.directItemIdsByCollectionId,
      );
      directItemIdsByCollectionId.set(12, new Set([7]));
      const tagByNormalizedName = new Map(snapshot.tagByNormalizedName);
      tagByNormalizedName.set("mixed", {
        normalizedName: "mixed",
        displayVariants: ["Mixed"],
        manualItemIds: new Set([5, 4, 7, 99]),
        automaticItemIds: new Set([3, 7]),
      });
      tagByNormalizedName.set("notes only", {
        normalizedName: "notes only",
        displayVariants: ["Notes only"],
        manualItemIds: new Set([5]),
        automaticItemIds: new Set(),
      });
      return {
        ...snapshot,
        collectionById,
        directItemIdsByCollectionId,
        tagByNormalizedName,
      } as LibraryIndexSnapshot;
    }

    before(function () {
      const snapshot = characterizationSnapshot();
      (
        libraryIndexService as unknown as {
          getSnapshot: (libraryID: number) => Promise<LibraryIndexSnapshot>;
        }
      ).getSnapshot = async () => snapshot;
    });

    after(function () {
      (libraryIndexService as unknown as { getSnapshot: unknown }).getSnapshot =
        originalGetSnapshot;
    });

    type Expected = {
      itemIds: number[];
      tagItemIds: number[];
      collectionNames: string[];
      tagNames: string[];
      summedScopeCount: number;
    };
    const cases: Array<[string, TaskPaperScopeContexts, Expected]> = [
      [
        "papers keep their order, once each, live regular only",
        {
          papers: [
            { itemId: 7 },
            { itemId: 2 },
            { itemId: 7 },
            { itemId: 4 },
            { itemId: 5 },
            { itemId: 404 },
          ],
        },
        {
          itemIds: [7, 2],
          tagItemIds: [],
          collectionNames: [],
          tagNames: [],
          summedScopeCount: 0,
        },
      ],
      [
        "folders in the given order, direct items only, paths as names",
        { collections: [{ collectionId: 11 }, { collectionId: 10 }] },
        {
          itemIds: [2, 3, 1],
          tagItemIds: [],
          collectionNames: ["Drift/Rodents", "Drift"],
          tagNames: [],
          // Rodents adds 2 and 3; Drift counts 1 and 2 again.
          summedScopeCount: 4,
        },
      ],
      [
        "a folder of another library and an unknown folder are skipped",
        {
          collections: [
            { collectionId: 12 },
            { collectionId: 99 },
            { collectionId: 10 },
          ],
        },
        {
          itemIds: [1, 2],
          tagItemIds: [],
          collectionNames: ["Drift"],
          tagNames: [],
          summedScopeCount: 2,
        },
      ],
      [
        "a tag's name wins over its normalized name",
        { tags: [{ name: "Learning", normalizedName: "drift" }] },
        {
          itemIds: [2, 6],
          tagItemIds: [2, 6],
          collectionNames: [],
          tagNames: ["Learning"],
          summedScopeCount: 2,
        },
      ],
      [
        "a tag without a name falls back to its normalized name",
        { tags: [{ name: "", normalizedName: "Drift" }] },
        {
          itemIds: [1],
          tagItemIds: [1],
          collectionNames: [],
          tagNames: [""],
          summedScopeCount: 1,
        },
      ],
      [
        "a tag drops trashed, non-regular and unknown members",
        { tags: [{ name: "MIXED", includeAutomatic: true }] },
        {
          itemIds: [7, 3],
          tagItemIds: [7, 3],
          collectionNames: [],
          tagNames: ["MIXED"],
          summedScopeCount: 2,
        },
      ],
      [
        "a tag held only by a note adds nothing",
        { tags: [{ name: "notes only" }, { name: "unknown tag" }] },
        {
          itemIds: [],
          tagItemIds: [],
          collectionNames: [],
          tagNames: ["notes only", "unknown tag"],
          summedScopeCount: 0,
        },
      ],
      [
        "aggregate scopes read top-level order",
        {
          tags: [
            { name: "Untagged", scope: "untagged", includeAutomatic: true },
            { name: "All Tagged", scope: "allTagged" },
          ],
        },
        {
          itemIds: [7, 1, 2, 6],
          tagItemIds: [7, 1, 2, 6],
          collectionNames: [],
          tagNames: ["Untagged", "All Tagged"],
          summedScopeCount: 4,
        },
      ],
      [
        "papers, then folders, then tags; removed papers are left out",
        {
          papers: [{ itemId: 6 }, { itemId: 3 }],
          collections: [{ collectionId: 10 }],
          tags: [{ name: "learning", includeAutomatic: true }],
          excludedItemIds: [3, 1],
        },
        {
          itemIds: [6, 2],
          tagItemIds: [2, 6],
          collectionNames: ["Drift"],
          tagNames: ["learning"],
          // Drift adds 2; the tag counts 2 and 6 again.
          summedScopeCount: 3,
        },
      ],
    ];

    for (const [label, contexts, expected] of cases) {
      it(label, async function () {
        const resolved = await new ZoteroGateway().resolveLibraryScopeItemIds({
          libraryID: 1,
          itemIds: (contexts.papers || []).map((paper) => paper.itemId),
          collectionIds: (contexts.collections || []).map(
            (collection) => collection.collectionId,
          ),
          tagContexts: (contexts.tags || []).map((tag) => ({
            name: tag.name,
            libraryID: 1,
            normalizedName: tag.normalizedName,
            scope: tag.scope,
            includeAutomatic: tag.includeAutomatic,
          })),
          excludedItemIds: contexts.excludedItemIds,
        });
        assert.deepEqual(resolved, expected);
        assert.deepEqual(
          resolveTaskPaperScopeItemIds(characterizationSnapshot(), contexts),
          expected.itemIds,
        );
      });
    }
  });
});

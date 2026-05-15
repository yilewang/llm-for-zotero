import { assert } from "chai";
import {
  buildMineruTagIndex,
  computeMineruTagAvailability,
  filterMineruItemsForFolderAndTagView,
  filterMineruItemsForTagView,
  type MineruFolderTagIndexItem,
  type MineruTagIndexItem,
} from "../src/modules/mineruTagIndex";

const items: MineruTagIndexItem[] = [
  { attachmentId: 1, tags: ["ACC", "Data"], tagsAuto: ["AutoOnly"] },
  { attachmentId: 2, tags: ["ACC", "Algorithm"], tagsAuto: [] },
  { attachmentId: 3, tags: ["Data", "Learning"], tagsAuto: ["AutoOnly"] },
  { attachmentId: 4, tags: [], tagsAuto: ["AutoOnly"] },
  { attachmentId: 5, tags: [], tagsAuto: [] },
];

const folderItems: MineruFolderTagIndexItem[] = [
  { attachmentId: 1, collectionIds: [10], tags: ["ACC", "Data"], tagsAuto: [] },
  { attachmentId: 2, collectionIds: [10], tags: ["ACC"], tagsAuto: [] },
  { attachmentId: 3, collectionIds: [20], tags: ["ACC", "Data"], tagsAuto: [] },
  { attachmentId: 4, collectionIds: [], tags: ["Data"], tagsAuto: [] },
];

describe("mineruTagIndex", function () {
  it("builds counts, colors, and manual-vs-automatic classification", function () {
    const index = buildMineruTagIndex(items, {
      includeAutomatic: true,
      getColor: (name) => (name === "ACC" ? "#ff0000" : null),
    });

    assert.equal(index.get("ACC")?.count, 2);
    assert.equal(index.get("Data")?.count, 2);
    assert.equal(index.get("AutoOnly")?.count, 3);
    assert.equal(index.get("ACC")?.color, "#ff0000");
    assert.equal(index.get("ACC")?.isAutomatic, false);
    assert.equal(index.get("AutoOnly")?.isAutomatic, true);
  });

  it("skips empty names and hides automatic tags by default", function () {
    const index = buildMineruTagIndex([
      { attachmentId: 1, tags: ["", "  ", "ACC"], tagsAuto: ["AutoOnly"] },
    ]);

    assert.deepEqual([...index.keys()], ["ACC"]);
  });

  it("filters tag view with AND semantics and scope pills", function () {
    assert.sameMembers(
      filterMineruItemsForTagView(items).map((item) => item.attachmentId),
      [1, 2, 3, 4, 5],
    );
    assert.sameMembers(
      filterMineruItemsForTagView(items, { scope: "allTagged" }).map(
        (item) => item.attachmentId,
      ),
      [1, 2, 3],
    );
    assert.sameMembers(
      filterMineruItemsForTagView(items, { scope: "untagged" }).map(
        (item) => item.attachmentId,
      ),
      [4, 5],
    );
    assert.sameMembers(
      filterMineruItemsForTagView(items, { selectedTags: ["ACC", "Data"] }).map(
        (item) => item.attachmentId,
      ),
      [1],
    );
    assert.sameMembers(
      filterMineruItemsForTagView(items, {
        selectedTags: ["AutoOnly"],
        includeAutomatic: true,
      }).map((item) => item.attachmentId),
      [1, 3, 4],
    );
  });

  it("filters tag view with OR semantics when requested", function () {
    assert.sameMembers(
      filterMineruItemsForTagView(items, {
        selectedTags: ["ACC", "Data"],
        matchMode: "or",
      }).map((item) => item.attachmentId),
      [1, 2, 3],
    );
    assert.sameMembers(
      filterMineruItemsForTagView(items, {
        selectedTags: ["Algorithm", "AutoOnly"],
        includeAutomatic: true,
        matchMode: "or",
      }).map((item) => item.attachmentId),
      [1, 2, 3, 4],
    );
  });

  it("marks incompatible tags unavailable while keeping selected tags active", function () {
    const index = buildMineruTagIndex(items);
    const tagInfos = [...index.values()];
    const filtered = filterMineruItemsForTagView(items, {
      selectedTags: ["ACC", "Data"],
    });
    const availability = computeMineruTagAvailability(
      tagInfos,
      filtered,
      ["ACC", "Data"],
      false,
    );

    assert.equal(availability.get("ACC")?.selected, true);
    assert.equal(availability.get("ACC")?.available, true);
    assert.equal(availability.get("Data")?.selected, true);
    assert.equal(availability.get("Learning")?.available, false);
    assert.equal(availability.get("Algorithm")?.available, false);
  });

  it("combines folder scope with tag facets", function () {
    assert.sameMembers(
      filterMineruItemsForFolderAndTagView(folderItems).map(
        (item) => item.attachmentId,
      ),
      [1, 2, 3, 4],
    );
    assert.sameMembers(
      filterMineruItemsForFolderAndTagView(folderItems, {
        folderScope: 10,
        selectedTags: ["ACC"],
      }).map((item) => item.attachmentId),
      [1, 2],
    );
    assert.sameMembers(
      filterMineruItemsForFolderAndTagView(folderItems, {
        folderScope: 10,
        selectedTags: ["ACC", "Data"],
      }).map((item) => item.attachmentId),
      [1],
    );
    assert.sameMembers(
      filterMineruItemsForFolderAndTagView(folderItems, {
        folderScope: 10,
        selectedTags: ["ACC", "Data"],
        tagMatchMode: "or",
      }).map((item) => item.attachmentId),
      [1, 2],
    );
    assert.sameMembers(
      filterMineruItemsForFolderAndTagView(folderItems, {
        folderScope: "unfiled",
        selectedTags: ["Data"],
      }).map((item) => item.attachmentId),
      [4],
    );
    assert.sameMembers(
      filterMineruItemsForFolderAndTagView(folderItems, {
        folderScope: 10,
        folderItemIds: new Set([1, 2, 3]),
        selectedTags: ["Data"],
      }).map((item) => item.attachmentId),
      [1, 3],
    );
  });
});

import { assert } from "chai";
import {
  filterMineruItemsForSearch,
  getMineruManagerActionLabels,
  getMineruParentDisplayStatus,
  shouldShowMineruManagerItem,
  type MineruParentStatusChild,
} from "../src/modules/mineruManagerScript";
import type { MineruItemEntry } from "../src/modules/mineruBatchProcessor";

type Availability = MineruParentStatusChild["availability"];
type Status = MineruParentStatusChild["status"];

function child(
  status: Status,
  availability: Availability = status === "cached" ? "local" : "missing",
  excluded = false,
): MineruParentStatusChild {
  return { status, availability, excluded };
}

function item(
  attachmentId: number,
  values: Partial<MineruItemEntry>,
): MineruItemEntry {
  return {
    parentItemId: attachmentId,
    attachmentId,
    title: "",
    pdfTitle: "",
    firstCreator: "",
    year: "",
    dateAdded: "",
    cached: false,
    localCached: false,
    syncedPackage: false,
    availability: "missing",
    excluded: false,
    exclusionReason: null,
    exclusionLabel: "",
    pageCount: null,
    collectionIds: [],
    tags: [],
    tagsAuto: [],
    ...values,
  };
}

describe("mineruManagerScript", function () {
  describe("filterMineruItemsForSearch", function () {
    const items = [
      item(1, {
        title: "Brain-inspired replay for continual learning",
        pdfTitle: "replay-paper.pdf",
        firstCreator: "van de Ven et al.",
        year: "2020",
        dateAdded: "2026-06-19T10:30:00Z",
        tags: ["stable"],
      }),
      item(2, {
        title: "Random network structure stabilizes neural manifolds",
        pdfTitle: "manifold.pdf",
        firstCreator: "Eppler et al.",
        year: "2026",
        dateAdded: "2026-06-09T10:30:00Z",
        tagsAuto: ["Replay"],
      }),
    ];

    it("matches title, attachment title, author, year, and added date", function () {
      assert.deepEqual(
        filterMineruItemsForSearch(items, "brain replay").map(
          (entry) => entry.attachmentId,
        ),
        [1],
      );
      assert.deepEqual(
        filterMineruItemsForSearch(items, "manifold.pdf").map(
          (entry) => entry.attachmentId,
        ),
        [2],
      );
      assert.deepEqual(
        filterMineruItemsForSearch(items, "eppler 2026").map(
          (entry) => entry.attachmentId,
        ),
        [2],
      );
      assert.deepEqual(
        filterMineruItemsForSearch(items, "2026-06-19").map(
          (entry) => entry.attachmentId,
        ),
        [1],
      );
    });

    it("does not match manual or automatic tags", function () {
      assert.deepEqual(filterMineruItemsForSearch(items, "stable"), []);
      assert.deepEqual(filterMineruItemsForSearch(items, "Replay"), [items[0]]);
    });
  });

  describe("shouldShowMineruManagerItem", function () {
    it("shows uncached rows skipped by parsing filters", function () {
      assert.isTrue(
        shouldShowMineruManagerItem({
          excluded: true,
          availability: "missing",
        }),
      );
    });

    it("keeps cached skipped rows visible for cache management", function () {
      assert.isTrue(
        shouldShowMineruManagerItem({
          excluded: true,
          availability: "local",
        }),
      );
    });

    it("keeps normal uncached rows visible", function () {
      assert.isTrue(
        shouldShowMineruManagerItem({
          excluded: false,
          availability: "missing",
        }),
      );
    });
  });

  describe("getMineruManagerActionLabels", function () {
    it("shows filtered labels for folder or tag scopes", function () {
      const labels = getMineruManagerActionLabels({
        batchRunning: false,
        batchPaused: false,
        autoProcessing: false,
        autoPaused: false,
        selectedCount: 0,
        filteredCount: 18,
        filterActive: true,
      });

      assert.equal(labels.startLabel, "Start Filtered (18)");
      assert.equal(labels.deleteLabel, "Delete Filtered Cache (18)");
    });

    it("lets selected rows override filtered labels", function () {
      const labels = getMineruManagerActionLabels({
        batchRunning: false,
        batchPaused: false,
        autoProcessing: false,
        autoPaused: false,
        selectedCount: 3,
        filteredCount: 18,
        filterActive: true,
      });

      assert.equal(labels.startLabel, "Start Selected (3)");
      assert.equal(labels.deleteLabel, "Delete Cache (3)");
    });

    it("keeps pause label while processing", function () {
      const labels = getMineruManagerActionLabels({
        batchRunning: true,
        batchPaused: false,
        autoProcessing: false,
        autoPaused: false,
        selectedCount: 0,
        filteredCount: 18,
        filterActive: true,
      });

      assert.equal(labels.startLabel, "Pause");
    });
  });

  describe("getMineruParentDisplayStatus", function () {
    it("shows processing when one child is processing", function () {
      assert.equal(
        getMineruParentDisplayStatus([child("processing")]),
        "processing",
      );
    });

    it("lets processing win over cached siblings", function () {
      assert.equal(
        getMineruParentDisplayStatus([child("cached"), child("processing")]),
        "processing",
      );
    });

    it("shows failed when no child is processing but at least one failed", function () {
      assert.equal(
        getMineruParentDisplayStatus([child("cached"), child("failed")]),
        "failed",
      );
    });

    it("shows cached when all actionable children are cached or available", function () {
      assert.equal(
        getMineruParentDisplayStatus([
          child("cached"),
          child("idle", "synced"),
        ]),
        "cached",
      );
    });

    it("still shows cached when every excluded child is already available", function () {
      assert.equal(
        getMineruParentDisplayStatus([
          child("cached", "local", true),
          child("idle", "synced", true),
        ]),
        "cached",
      );
    });

    it("shows idle when any actionable child is missing and idle", function () {
      assert.equal(
        getMineruParentDisplayStatus([child("cached"), child("idle")]),
        "idle",
      );
    });
  });
});

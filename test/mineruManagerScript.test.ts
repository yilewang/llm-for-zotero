import { assert } from "chai";
import {
  getMineruManagerActionLabels,
  getMineruParentDisplayStatus,
  type MineruParentStatusChild,
} from "../src/modules/mineruManagerScript";

type Availability = MineruParentStatusChild["availability"];
type Status = MineruParentStatusChild["status"];

function child(
  status: Status,
  availability: Availability = status === "cached" ? "local" : "missing",
  excluded = false,
): MineruParentStatusChild {
  return { status, availability, excluded };
}

describe("mineruManagerScript", function () {
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

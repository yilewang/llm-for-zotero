import { assert } from "chai";
import {
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

    it("shows idle when any actionable child is missing and idle", function () {
      assert.equal(
        getMineruParentDisplayStatus([child("cached"), child("idle")]),
        "idle",
      );
    });
  });
});

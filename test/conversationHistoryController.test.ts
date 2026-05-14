import { assert } from "chai";
import {
  getHistoryDayGroupLabel,
  groupHistoryEntriesByDay,
  maybeSelectPaperHistoryTarget,
  normalizeHistoryPaperItemID,
  resolveHistoryEntryPaperItem,
  resolvePaperHistoryNavigationDecision,
} from "../src/modules/contextPanel/setupHandlers/controllers/conversationHistoryController";

describe("conversationHistoryController", function () {
  const noon = new Date(2026, 3, 30, 12).getTime();
  const todayStart = new Date(2026, 3, 30).getTime();

  it("labels history timestamps by relative day buckets", function () {
    assert.equal(getHistoryDayGroupLabel(todayStart, { now: noon }), "Today");
    assert.equal(
      getHistoryDayGroupLabel(todayStart - 86_400_000, { now: noon }),
      "Yesterday",
    );
    assert.equal(
      getHistoryDayGroupLabel(todayStart - 3 * 86_400_000, { now: noon }),
      "Last 7 days",
    );
    assert.equal(
      getHistoryDayGroupLabel(todayStart - 10 * 86_400_000, { now: noon }),
      "Last 30 days",
    );
    assert.equal(
      getHistoryDayGroupLabel(todayStart - 40 * 86_400_000, { now: noon }),
      "Older",
    );
  });

  it("groups sorted history entries with translated labels", function () {
    const entries = [
      { id: 1, lastActivityAt: todayStart + 1 },
      { id: 2, lastActivityAt: todayStart + 2 },
      { id: 3, lastActivityAt: todayStart - 86_400_000 },
    ];
    const groups = groupHistoryEntriesByDay(entries, {
      now: noon,
      translate: (label) => `t:${label}`,
    });
    assert.deepEqual(
      groups.map((group) => ({
        label: group.label,
        ids: group.items.map((item) => item.id),
      })),
      [
        { label: "t:Today", ids: [1, 2] },
        { label: "t:Yesterday", ids: [3] },
      ],
    );
  });

  it("resolves a paper history entry by item id without requiring Zotero pane selection", function () {
    const calls: number[] = [];
    const resolved = resolveHistoryEntryPaperItem(
      { paperItemID: 42.9 },
      (paperItemID) => {
        calls.push(paperItemID);
        return { id: paperItemID, title: "Paper" };
      },
    );

    assert.deepEqual(calls, [42]);
    assert.deepEqual(resolved, { id: 42, title: "Paper" });
    assert.equal(resolveHistoryEntryPaperItem({}, () => ({ id: 1 })), null);
    assert.equal(normalizeHistoryPaperItemID("not-a-number"), 0);
  });

  it("decides whether paper history should load in place or select the target paper", function () {
    assert.equal(
      resolvePaperHistoryNavigationDecision({
        entryPaperItemID: 101,
        currentPaperItemID: 101,
      }),
      "load-in-place",
    );
    assert.equal(
      resolvePaperHistoryNavigationDecision({
        entryPaperItemID: 202,
        currentPaperItemID: 101,
      }),
      "select-target-paper",
    );
    assert.equal(
      resolvePaperHistoryNavigationDecision({
        currentPaperItemID: 101,
      }),
      "missing-target-paper",
    );
  });

  it("does not touch Zotero pane selection for same-paper history targets", async function () {
    let paneRequested = false;
    const selected = await maybeSelectPaperHistoryTarget({
      decision: "load-in-place",
      paperItemID: 101,
      getPane: () => {
        paneRequested = true;
        return {
          selectItems: () => {
            throw new Error("selectItems should not be called");
          },
        };
      },
    });

    assert.isTrue(selected);
    assert.isFalse(paneRequested);
  });

  it("selects the target paper for different-paper history targets", async function () {
    const calls: Array<{ ids: number[]; selectInLibrary?: boolean }> = [];
    const selected = await maybeSelectPaperHistoryTarget({
      decision: "select-target-paper",
      paperItemID: 202,
      getPane: () => ({
        selectItems: (ids, selectInLibrary) => {
          calls.push({ ids, selectInLibrary });
        },
      }),
    });

    assert.isTrue(selected);
    assert.deepEqual(calls, [{ ids: [202], selectInLibrary: true }]);
  });

  it("does not select a paper for missing paper history metadata", async function () {
    let paneRequested = false;
    const selected = await maybeSelectPaperHistoryTarget({
      decision: "missing-target-paper",
      getPane: () => {
        paneRequested = true;
        return {};
      },
    });

    assert.isFalse(selected);
    assert.isFalse(paneRequested);
  });
});

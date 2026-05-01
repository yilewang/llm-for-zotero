import { assert } from "chai";
import {
  getHistoryDayGroupLabel,
  groupHistoryEntriesByDay,
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
});

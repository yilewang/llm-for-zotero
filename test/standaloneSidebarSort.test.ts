import { assert } from "chai";
import {
  formatStandaloneSidebarShortDate,
  groupStandaloneSidebarEntries,
  moveStandaloneSidebarGroup,
  parseStandaloneSidebarGroupKeys,
  parseStandaloneSidebarSectionOptions,
  serializeStandaloneSidebarSectionOptions,
  parseStandaloneSidebarGroupOrder,
  getStandaloneSidebarEntryTime,
  parseStandaloneSidebarSortOrder,
  sortStandaloneSidebarEntries,
} from "../src/modules/contextPanel/standaloneSidebarSort";

describe("standaloneSidebarSort", function () {
  const DAY = 86_400_000;
  const now = new Date(2026, 9, 26, 12).getTime();
  const entries = [
    { title: "beta", lastActivityAt: now - 1 * DAY, createdAt: now - 9 * DAY },
    { title: "Alpha", lastActivityAt: now - 5 * DAY, createdAt: now - 6 * DAY },
    {
      title: "chat 10",
      lastActivityAt: now - 2 * DAY,
      createdAt: now - 2 * DAY,
    },
    { title: "chat 9", lastActivityAt: now - 3 * DAY },
  ];

  it("falls back to recent activity for unknown sort values", function () {
    assert.equal(parseStandaloneSidebarSortOrder("title"), "title");
    assert.equal(parseStandaloneSidebarSortOrder("created"), "created");
    assert.equal(parseStandaloneSidebarSortOrder("bogus"), "recent");
    assert.equal(parseStandaloneSidebarSortOrder(undefined), "recent");
  });

  it("sorts by last activity, newest first", function () {
    assert.deepEqual(
      sortStandaloneSidebarEntries(entries, "recent").map((e) => e.title),
      ["beta", "chat 10", "chat 9", "Alpha"],
    );
  });

  it("sorts by creation date, using last activity when it is missing", function () {
    assert.deepEqual(
      sortStandaloneSidebarEntries(entries, "created").map((e) => e.title),
      ["chat 10", "chat 9", "Alpha", "beta"],
    );
  });

  it("sorts titles A to Z ignoring case, with numbers in number order", function () {
    assert.deepEqual(
      sortStandaloneSidebarEntries(entries, "title").map((e) => e.title),
      ["Alpha", "beta", "chat 9", "chat 10"],
    );
  });

  it("does not change the list it was given", function () {
    const before = entries.map((e) => e.title);
    sortStandaloneSidebarEntries(entries, "title");
    assert.deepEqual(
      entries.map((e) => e.title),
      before,
    );
  });

  it("shows the creation time only in creation order", function () {
    assert.equal(
      getStandaloneSidebarEntryTime(entries[0], "created"),
      now - 9 * DAY,
    );
    assert.equal(
      getStandaloneSidebarEntryTime(entries[0], "recent"),
      now - DAY,
    );
    assert.equal(
      getStandaloneSidebarEntryTime(entries[3], "created"),
      now - 3 * DAY,
    );
  });

  it("formats short dates", function () {
    assert.equal(
      formatStandaloneSidebarShortDate(now - 60_000, { now }),
      "now",
    );
    assert.equal(
      formatStandaloneSidebarShortDate(now - 5 * 3_600_000, { now }),
      "5h",
    );
    assert.equal(
      formatStandaloneSidebarShortDate(now - 3 * DAY, { now }),
      "3d",
    );
    assert.equal(
      formatStandaloneSidebarShortDate(new Date(2025, 2, 1).getTime(), { now }),
      "2025",
    );
    assert.include(
      formatStandaloneSidebarShortDate(new Date(2026, 1, 2).getTime(), { now }),
      "2",
    );
    assert.equal(formatStandaloneSidebarShortDate(0, { now }), "");
  });

  it("reads a saved section order, dropping unknown names and adding missing ones", function () {
    assert.deepEqual(parseStandaloneSidebarGroupOrder("codex,upstream"), [
      "codex",
      "upstream",
      "claude_code",
      "antigravity",
    ]);
    assert.deepEqual(parseStandaloneSidebarGroupOrder("x, codex ,codex"), [
      "codex",
      "upstream",
      "claude_code",
      "antigravity",
    ]);
    assert.deepEqual(parseStandaloneSidebarGroupOrder(undefined), [
      "upstream",
      "codex",
      "claude_code",
      "antigravity",
    ]);
  });

  it("groups entries by runtime in the saved order, leaving out empty sections", function () {
    const rows = [
      { id: 1, conversationSystem: "codex" },
      { id: 2 },
      { id: 3, conversationSystem: "codex" },
      { id: 4, conversationSystem: "upstream" },
    ];
    const groups = groupStandaloneSidebarEntries(rows, [
      "codex",
      "claude_code",
      "upstream",
    ]);
    assert.deepEqual(
      groups.map((g) => [g.key, g.items.map((r) => r.id)]),
      [
        ["codex", [1, 3]],
        ["upstream", [2, 4]],
      ],
    );
  });

  it("moves a section to its drop place among the shown sections", function () {
    const order = ["upstream", "codex", "claude_code"] as const;
    assert.deepEqual(moveStandaloneSidebarGroup(order, "claude_code", 0), [
      "claude_code",
      "upstream",
      "codex",
    ]);
    assert.deepEqual(moveStandaloneSidebarGroup(order, "upstream", 2), [
      "codex",
      "claude_code",
      "upstream",
    ]);
    // Codex hidden (no chats): Claude dropped first among the shown ones
    // takes Agent's slot, and Codex keeps its own.
    assert.deepEqual(
      moveStandaloneSidebarGroup(order, "claude_code", 0, [
        "upstream",
        "claude_code",
      ]),
      ["claude_code", "codex", "upstream"],
    );
  });

  it("reads the folded sections, keeping only known names once", function () {
    assert.deepEqual(parseStandaloneSidebarGroupKeys("codex, x,codex"), [
      "codex",
    ]);
    assert.deepEqual(parseStandaloneSidebarGroupKeys(""), []);
    assert.deepEqual(parseStandaloneSidebarGroupKeys(undefined), []);
  });

  it("saves each section's sort and dates separately", function () {
    const options = parseStandaloneSidebarSectionOptions(
      "codex=title+dates,upstream=created,bogus=title,claude_code=oops",
    );
    assert.deepEqual(options.get("codex"), { sort: "title", showDates: true });
    assert.deepEqual(options.get("upstream"), {
      sort: "created",
      showDates: false,
    });
    assert.deepEqual(options.get("claude_code"), {
      sort: "recent",
      showDates: false,
    });
    assert.equal(
      serializeStandaloneSidebarSectionOptions(options),
      "upstream=created,codex=title+dates,claude_code=recent",
    );
    assert.equal(parseStandaloneSidebarSectionOptions(undefined).size, 0);
  });
});

import { assert } from "chai";
import {
  getHistoryEntryLabelType,
  type ConversationHistoryEntry,
} from "../src/modules/contextPanel/setupHandlers/controllers/conversationHistoryController";
import type { HistorySearchResult } from "../src/modules/contextPanel/setupHandlers/controllers/historySearchController";
import {
  filterHistorySearchPopupVisibleEntries,
  HISTORY_SEARCH_POPUP_DELETE_CLASS,
  HISTORY_SEARCH_POPUP_ITEM_TAG,
  limitHistorySearchListEntries,
  mapHistorySearchPopupResults,
  mergeHistorySearchHiddenKeys,
  resolveHistorySearchPopupThemeFromColors,
  shouldCloseHistorySearchPopupAfterSelection,
  sortHistorySearchPopupEntries,
} from "../src/modules/contextPanel/setupHandlers/controllers/historySearchPopupController";

function historyEntry(
  conversationKey: number,
  lastActivityAt: number,
  kind: "global" | "paper" = "global",
): ConversationHistoryEntry {
  return {
    kind,
    sourceState: "active",
    section: kind === "paper" ? "paper" : "open",
    sectionTitle: kind === "paper" ? "Paper" : "Library chat",
    conversationKey,
    title: `Chat ${conversationKey}`,
    timestampText: "",
    deletable: true,
    isDraft: false,
    isPendingDelete: false,
    lastActivityAt,
    paperItemID: kind === "paper" ? 42 : undefined,
  };
}

function searchResult(
  entry: ConversationHistoryEntry,
  matchCount: number,
): HistorySearchResult {
  return {
    entry,
    matchCount,
    titleRanges: [],
    previewText: "",
    previewRanges: [],
  };
}

describe("historySearchPopupController helpers", function () {
  it("uses div rows instead of Gecko button rows", function () {
    assert.equal(HISTORY_SEARCH_POPUP_ITEM_TAG, "div");
  });

  it("exposes a stable delete control class for popup rows", function () {
    assert.equal(
      HISTORY_SEARCH_POPUP_DELETE_CLASS,
      "llm-standalone-search-delete",
    );
  });

  it("keeps the popup open only when selection returns false", function () {
    assert.equal(shouldCloseHistorySearchPopupAfterSelection(false), false);
    assert.equal(shouldCloseHistorySearchPopupAfterSelection(true), true);
    assert.equal(shouldCloseHistorySearchPopupAfterSelection(undefined), true);
  });

  it("sorts empty-query popup entries newest first", function () {
    const older = historyEntry(101, 100);
    const newest = historyEntry(102, 300);
    const tiedNewerKey = historyEntry(103, 300);

    const sorted = sortHistorySearchPopupEntries([older, newest, tiedNewerKey]);

    assert.deepEqual(
      sorted.map((entry) => entry.conversationKey),
      [103, 102, 101],
    );
  });

  it("maps ranked search results back to the loaded popup entries", function () {
    const first = historyEntry(201, 100, "paper");
    const second = historyEntry(202, 200, "global");
    const missing = historyEntry(999, 300, "paper");

    const mapped = mapHistorySearchPopupResults(
      [first, second],
      [
        searchResult(second, 3),
        searchResult(missing, 2),
        searchResult(first, 1),
      ],
    );

    assert.deepEqual(
      mapped.entries.map((entry) => entry.conversationKey),
      [202, 201],
    );
    assert.equal(mapped.resultsByKey.get(202)?.matchCount, 3);
    assert.isFalse(mapped.resultsByKey.has(999));
  });

  it("filters pending and locally hidden popup entries", function () {
    const visible = historyEntry(207, 700, "paper");
    const pending = {
      ...historyEntry(208, 800, "global"),
      isPendingDelete: true,
    };
    const hidden = historyEntry(209, 900, "paper");

    const filtered = filterHistorySearchPopupVisibleEntries(
      [visible, pending, hidden],
      new Set([hidden.conversationKey]),
    );

    assert.deepEqual(
      filtered.map((entry) => entry.conversationKey),
      [207],
    );
  });

  it("uses the orphan label type for orphan paper entries", function () {
    const orphan = {
      ...historyEntry(204, 400, "paper"),
      sourceState: "orphan" as const,
      sectionTitle: "Orphan",
    };

    assert.equal(getHistoryEntryLabelType(orphan), "orphan");
    assert.equal(
      getHistoryEntryLabelType(historyEntry(205, 500, "paper")),
      "paper",
    );
    assert.equal(
      getHistoryEntryLabelType(historyEntry(206, 600, "global")),
      "library",
    );
  });

  it("resolves popup chip theme from rendered surface color", function () {
    assert.equal(
      resolveHistorySearchPopupThemeFromColors(["rgb(42, 42, 42)"]),
      "dark",
    );
    assert.equal(
      resolveHistorySearchPopupThemeFromColors(["rgb(232, 232, 232)"]),
      "light",
    );
  });
  it("reads color-mix() surfaces, which compute to color(srgb ...)", function () {
    assert.equal(
      resolveHistorySearchPopupThemeFromColors(["color(srgb 0.18 0.18 0.18)"]),
      "dark",
    );
    assert.equal(
      resolveHistorySearchPopupThemeFromColors([
        "color(srgb 0.95 0.95 0.96 / 0.9)",
      ]),
      "light",
    );
    assert.equal(
      resolveHistorySearchPopupThemeFromColors([
        "color(srgb 1 1 1 / 0)",
        "rgb(30, 30, 30)",
      ]),
      "dark",
      "a fully transparent surface is skipped",
    );
  });
  it("merges optimistic deletes with caller-excluded keys", function () {
    const hidden = new Set([1]);
    assert.strictEqual(mergeHistorySearchHiddenKeys(hidden), hidden);
    assert.strictEqual(mergeHistorySearchHiddenKeys(hidden, new Set()), hidden);
    assert.strictEqual(mergeHistorySearchHiddenKeys(hidden, null), hidden);
    const excluded = new Set([7]);
    assert.strictEqual(
      mergeHistorySearchHiddenKeys(new Set(), excluded),
      excluded,
    );
    const merged = mergeHistorySearchHiddenKeys(hidden, new Set([2, 1]));
    assert.deepEqual(Array.from(merged).sort(), [1, 2]);
    assert.deepEqual(Array.from(hidden), [1], "inputs stay unchanged");
  });

  it("hides excluded keys through the visible-entry filter", function () {
    const entries = [
      historyEntry(1, 30),
      historyEntry(2, 20),
      historyEntry(3, 10),
    ];
    const visible = filterHistorySearchPopupVisibleEntries(
      entries,
      mergeHistorySearchHiddenKeys(new Set([1]), new Set([3])),
    );
    assert.deepEqual(
      visible.map((entry) => entry.conversationKey),
      [2],
    );
  });

  it("limits list entries to the first N", function () {
    const entries = [1, 2, 3, 4, 5];
    assert.deepEqual(limitHistorySearchListEntries(entries, 3), [1, 2, 3]);
    assert.deepEqual(limitHistorySearchListEntries(entries, 2.7), [1, 2]);
    assert.deepEqual(limitHistorySearchListEntries(entries, 10), entries);
    assert.notStrictEqual(limitHistorySearchListEntries(entries), entries);
    for (const limit of [undefined, 0, -1, Number.NaN, Infinity]) {
      assert.deepEqual(limitHistorySearchListEntries(entries, limit), entries);
    }
  });
});

import { assert } from "chai";
import type { ConversationHistoryEntry } from "../src/modules/contextPanel/setupHandlers/controllers/conversationHistoryController";
import type { HistorySearchResult } from "../src/modules/contextPanel/setupHandlers/controllers/historySearchController";
import {
  HISTORY_SEARCH_POPUP_ITEM_TAG,
  mapHistorySearchPopupResults,
  resolveHistorySearchPopupThemeFromColors,
  sortHistorySearchPopupEntries,
} from "../src/modules/contextPanel/setupHandlers/controllers/historySearchPopupController";

function historyEntry(
  conversationKey: number,
  lastActivityAt: number,
  kind: "global" | "paper" = "global",
): ConversationHistoryEntry {
  return {
    kind,
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

  it("sorts empty-query popup entries newest first", function () {
    const older = historyEntry(101, 100);
    const newest = historyEntry(102, 300);
    const tiedNewerKey = historyEntry(103, 300);

    const sorted = sortHistorySearchPopupEntries([
      older,
      newest,
      tiedNewerKey,
    ]);

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
      [searchResult(second, 3), searchResult(missing, 2), searchResult(first, 1)],
    );

    assert.deepEqual(
      mapped.entries.map((entry) => entry.conversationKey),
      [202, 201],
    );
    assert.equal(mapped.resultsByKey.get(202)?.matchCount, 3);
    assert.isFalse(mapped.resultsByKey.has(999));
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
});

import { assert } from "chai";
import type { ConversationHistoryEntry } from "../src/modules/contextPanel/setupHandlers/controllers/conversationHistoryController";
import {
  buildHistorySearchResults,
  collectHistorySearchRanges,
  createHistorySearchDocumentFingerprint,
  createHistorySearchDocument,
  normalizeHistorySearchQuery,
  tokenizeHistorySearchQuery,
} from "../src/modules/contextPanel/setupHandlers/controllers/historySearchController";

function historyEntry(
  conversationKey: number,
  title: string,
  lastActivityAt: number,
  kind: "global" | "paper" = "global",
): ConversationHistoryEntry {
  return {
    kind,
    section: kind === "paper" ? "paper" : "open",
    sectionTitle: kind === "paper" ? "Paper" : "Open",
    conversationKey,
    title,
    timestampText: "",
    deletable: true,
    isDraft: false,
    isPendingDelete: false,
    lastActivityAt,
    paperItemID: kind === "paper" ? 42 : undefined,
  };
}

describe("historySearchController", function () {
  it("normalizes and deduplicates query tokens", function () {
    const normalized = normalizeHistorySearchQuery("  Zotero\tZotero  AI ");
    assert.equal(normalized, "zotero\tzotero  ai");
    assert.deepEqual(tokenizeHistorySearchQuery(normalized), ["zotero", "ai"]);
  });

  it("merges overlapping highlight ranges", function () {
    assert.deepEqual(collectHistorySearchRanges("Paper", ["paper", "pap"]), [
      { start: 0, end: 5 },
    ]);
  });

  it("fingerprints documents by key, kind, title, and activity", function () {
    const base = historyEntry(101, "Methods chat", 100);
    const baseFingerprint = createHistorySearchDocumentFingerprint(base);

    assert.equal(
      createHistorySearchDocumentFingerprint({ ...base }),
      baseFingerprint,
    );
    assert.notEqual(
      createHistorySearchDocumentFingerprint({
        ...base,
        title: "Updated methods",
      }),
      baseFingerprint,
    );
    assert.notEqual(
      createHistorySearchDocumentFingerprint({
        ...base,
        lastActivityAt: 101,
      }),
      baseFingerprint,
    );
    assert.notEqual(
      createHistorySearchDocumentFingerprint({
        ...base,
        kind: "paper",
        section: "paper",
      }),
      baseFingerprint,
    );
  });

  it("builds ranked search results from indexed titles and messages", function () {
    const first = historyEntry(101, "Methods chat", 100);
    const second = historyEntry(102, "Zotero setup", 200);
    const documents = new Map([
      [
        first.conversationKey,
        createHistorySearchDocument(first, [
          { text: "Zotero search with Zotero metadata and Zotero notes." },
        ]),
      ],
      [
        second.conversationKey,
        createHistorySearchDocument(second, [{ text: "Zotero once." }]),
      ],
    ]);

    const results = buildHistorySearchResults(
      [first, second],
      "zotero",
      documents,
    );

    assert.deepEqual(
      results.map((result) => result.entry.conversationKey),
      [101, 102],
    );
    assert.equal(results[0].matchCount, 3);
    assert.include(results[0].previewText.toLowerCase(), "zotero");
    assert.deepEqual(results[1].titleRanges, [{ start: 0, end: 6 }]);
  });

  it("searches mixed paper and global conversations with message previews", function () {
    const paper = historyEntry(201, "Decoder margin", 300, "paper");
    const global = historyEntry(202, "Library setup", 200, "global");
    const documents = new Map([
      [
        paper.conversationKey,
        createHistorySearchDocument(paper, [
          { text: "The paper chat mentions global drift evidence twice: drift drift." },
        ]),
      ],
      [
        global.conversationKey,
        createHistorySearchDocument(global, [
          { text: "A library chat mentions drift once." },
        ]),
      ],
    ]);

    const results = buildHistorySearchResults(
      [global, paper],
      "drift",
      documents,
    );

    assert.deepEqual(
      results.map((result) => ({
        key: result.entry.conversationKey,
        kind: result.entry.kind,
      })),
      [
        { key: 201, kind: "paper" },
        { key: 202, kind: "global" },
      ],
    );
    assert.include(results[0].previewText.toLowerCase(), "drift");
    assert.isAtLeast(results[0].matchCount, 2);
  });
});

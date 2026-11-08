import { assert } from "chai";
import {
  MAX_PINNED_PAPERS,
  parsePinnedPaperIDs,
  resolvePinnedPaperDot,
  serializePinnedPaperIDs,
  togglePinnedPaper,
  updateReadyPinnedPapers,
} from "../src/modules/contextPanel/standalonePinnedPapers";
import {
  resolveSidePanelWorkspaceKey,
  resolveSidePanelWorkspacePaperID,
} from "../src/modules/contextPanel/standaloneSidePanelState";

describe("standalone pinned papers", function () {
  it("reads the saved list and ignores bad entries", function () {
    assert.deepEqual(
      parsePinnedPaperIDs('[3, 5, 3, -1, "7", null]'),
      [3, 5, 7],
    );
    assert.deepEqual(parsePinnedPaperIDs(""), []);
    assert.deepEqual(parsePinnedPaperIDs("not json"), []);
    assert.deepEqual(parsePinnedPaperIDs('{"a":1}'), []);
    assert.deepEqual(parsePinnedPaperIDs(undefined), []);
  });

  it("saves the list it reads back", function () {
    const saved = serializePinnedPaperIDs([4, 9, 4]);
    assert.deepEqual(parsePinnedPaperIDs(saved), [4, 9]);
  });

  it("pins at the end and unpins in place", function () {
    assert.deepEqual(togglePinnedPaper([1, 2], 3), [1, 2, 3]);
    assert.deepEqual(togglePinnedPaper([1, 2, 3], 2), [1, 3]);
    assert.deepEqual(togglePinnedPaper([1, 2], 0), [1, 2]);
  });

  it("drops the oldest pin past the limit", function () {
    const full = Array.from({ length: MAX_PINNED_PAPERS }, (_, i) => i + 1);
    const next = togglePinnedPaper(full, 999);
    assert.lengthOf(next, MAX_PINNED_PAPERS);
    assert.notInclude(next, 1);
    assert.equal(next[next.length - 1], 999);
  });

  it("shows writing first, then a waiting answer", function () {
    assert.equal(
      resolvePinnedPaperDot({ writing: true, readyUnseen: true }),
      "writing",
    );
    assert.equal(
      resolvePinnedPaperDot({ writing: false, readyUnseen: true }),
      "ready",
    );
    assert.isNull(
      resolvePinnedPaperDot({ writing: false, readyUnseen: false }),
    );
  });

  it("keeps an answer waiting only while its paper is not on screen", function () {
    const ended = updateReadyPinnedPapers(new Set(), {
      paperID: 7,
      pending: false,
      shownPaperID: 3,
    });
    assert.isTrue(ended.has(7));
    const shown = updateReadyPinnedPapers(new Set(), {
      paperID: 7,
      pending: false,
      shownPaperID: 7,
    });
    assert.isFalse(shown.has(7));
    const restarted = updateReadyPinnedPapers(ended, {
      paperID: 7,
      pending: true,
      shownPaperID: 3,
    });
    assert.isFalse(restarted.has(7));
  });
});

describe("side panel tabs per paper", function () {
  it("names one set of tabs per paper and one per library", function () {
    assert.equal(
      resolveSidePanelWorkspaceKey({
        mode: "paper",
        basePaperItemID: 12,
        libraryID: 1,
      }),
      "paper:12",
    );
    assert.equal(
      resolveSidePanelWorkspaceKey({
        mode: "open",
        basePaperItemID: 12,
        libraryID: 2,
      }),
      "library:2",
    );
    // Paper chat without a paper shows the library chat's tabs.
    assert.equal(
      resolveSidePanelWorkspaceKey({
        mode: "paper",
        basePaperItemID: 0,
        libraryID: 1,
      }),
      "library:1",
    );
  });

  it("reads the paper back from a key", function () {
    assert.equal(resolveSidePanelWorkspacePaperID("paper:12"), 12);
    assert.equal(resolveSidePanelWorkspacePaperID("library:1"), 0);
    assert.equal(resolveSidePanelWorkspacePaperID(""), 0);
  });
});

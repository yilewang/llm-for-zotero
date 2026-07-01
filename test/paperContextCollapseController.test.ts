import { assert } from "chai";
import {
  PAPER_CONTEXT_COLLAPSE_THRESHOLD,
  getPaperContextCollapseState,
  togglePaperContextCollapseState,
} from "../src/modules/contextPanel/setupHandlers/controllers/paperContextCollapseController";

describe("paper context collapse controller", function () {
  it("shows normal paper chips without a summary at the threshold", function () {
    const expandedByItem = new Map<number, boolean>([[42, true]]);

    const state = getPaperContextCollapseState({
      itemId: 42,
      paperCount: PAPER_CONTEXT_COLLAPSE_THRESHOLD,
      expandedByItem,
    });

    assert.isFalse(state.showSummaryChip);
    assert.isTrue(state.showPaperChips);
    assert.isFalse(state.expanded);
    assert.equal(state.summaryLabel, "");
  });

  it("defaults to a collapsed summary when paper count exceeds the threshold", function () {
    const state = getPaperContextCollapseState({
      itemId: 42,
      paperCount: PAPER_CONTEXT_COLLAPSE_THRESHOLD + 1,
      expandedByItem: new Map(),
    });

    assert.isTrue(state.showSummaryChip);
    assert.isFalse(state.showPaperChips);
    assert.isFalse(state.expanded);
    assert.equal(state.summaryLabel, "6 items");
  });

  it("toggles from collapsed to expanded while keeping the summary chip visible", function () {
    const expandedByItem = new Map<number, boolean>();

    const nextExpanded = togglePaperContextCollapseState({
      itemId: 42,
      paperCount: 6,
      expandedByItem,
    });
    const state = getPaperContextCollapseState({
      itemId: 42,
      paperCount: 6,
      expandedByItem,
    });

    assert.isTrue(nextExpanded);
    assert.isTrue(state.showSummaryChip);
    assert.isTrue(state.showPaperChips);
    assert.isTrue(state.expanded);
    assert.equal(state.summaryLabel, "6 items");
  });

  it("toggles from expanded back to a collapsed summary", function () {
    const expandedByItem = new Map<number, boolean>([[42, true]]);

    const nextExpanded = togglePaperContextCollapseState({
      itemId: 42,
      paperCount: 6,
      expandedByItem,
    });
    const state = getPaperContextCollapseState({
      itemId: 42,
      paperCount: 6,
      expandedByItem,
    });

    assert.isFalse(nextExpanded);
    assert.isTrue(state.showSummaryChip);
    assert.isFalse(state.showPaperChips);
    assert.isFalse(state.expanded);
  });

  it("clears stale expanded state once paper count returns to the threshold", function () {
    const expandedByItem = new Map<number, boolean>([[42, true]]);

    const state = getPaperContextCollapseState({
      itemId: 42,
      paperCount: 5,
      expandedByItem,
    });

    assert.isFalse(expandedByItem.has(42));
    assert.isFalse(state.showSummaryChip);
    assert.isTrue(state.showPaperChips);
  });
});

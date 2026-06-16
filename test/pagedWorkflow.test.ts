import { assert } from "chai";
import {
  DEFAULT_ACTION_PAGE_SIZE,
  DEFAULT_TAGS_PER_PAPER,
  MAX_ACTION_PAGE_SIZE,
  MAX_TAGS_PER_PAPER,
  buildPagedReviewActionConfig,
  getPagedActionPages,
  getPagedOperationId,
  normalizeActionPageSize,
  normalizeActionLimit,
  normalizeActionStartOffset,
  normalizeTagsPerPaper,
  readPagedOperationMeta,
} from "../src/agent/actions/pagedWorkflow";

describe("paged action workflow helpers", function () {
  it("normalizes page sizes to supported review options", function () {
    assert.equal(normalizeActionPageSize(undefined), DEFAULT_ACTION_PAGE_SIZE);
    assert.equal(normalizeActionPageSize(10), 10);
    assert.equal(normalizeActionPageSize(11), 20);
    assert.equal(normalizeActionPageSize(51), 100);
    assert.equal(normalizeActionPageSize(500), MAX_ACTION_PAGE_SIZE);
  });

  it("normalizes numeric-string limit and start offset", function () {
    assert.equal(normalizeActionLimit("12"), 12);
    assert.equal(normalizeActionLimit("12.9"), 12);
    assert.isUndefined(normalizeActionLimit("0"));
    assert.equal(normalizeActionStartOffset("7"), 7);
    assert.equal(normalizeActionStartOffset("7.9"), 7);
    assert.equal(normalizeActionStartOffset("-1"), 0);
  });

  it("normalizes tags per paper with a hard cap", function () {
    assert.equal(normalizeTagsPerPaper(undefined), DEFAULT_TAGS_PER_PAPER);
    assert.equal(normalizeTagsPerPaper(1), 1);
    assert.equal(normalizeTagsPerPaper(7), MAX_TAGS_PER_PAPER);
    assert.equal(normalizeTagsPerPaper(0), DEFAULT_TAGS_PER_PAPER);
  });

  it("splits review items into default-sized pages", function () {
    const pages = getPagedActionPages(
      Array.from({ length: 45 }, (_, index) => index + 1),
      { pageSize: 20, startOffset: 0 },
    );

    assert.deepEqual(
      pages.map((page) => page.items.length),
      [20, 20, 5],
    );
    assert.deepEqual(
      pages.map((page) => page.pageIndex),
      [1, 2, 3],
    );
    assert.deepEqual(
      pages.map((page) => page.totalPages),
      [3, 3, 3],
    );
  });

  it("round-trips page metadata and exposes paged review controls", function () {
    const operationId = getPagedOperationId(
      "auto_tag",
      { pageIndex: 2, totalPages: 3 },
      { pageSize: 50, tagsPerPaper: 6 },
    );

    assert.deepEqual(readPagedOperationMeta(operationId), {
      actionName: "auto_tag",
      pageIndex: 2,
      totalPages: 3,
      pageSize: 50,
      tagsPerPaper: 6,
    });

    const actionConfig = buildPagedReviewActionConfig({
      actionName: "auto_tag",
      pageIndex: 2,
      totalPages: 3,
      pageSize: 50,
      tagsPerPaper: 6,
    });

    assert.equal(actionConfig.defaultActionId, "next");
    assert.equal(actionConfig.mode, "review");
    assert.deepEqual(
      actionConfig.actions.map((action) => action.id),
      ["previous", "confirm", "cancel", "next"],
    );
    assert.equal(
      actionConfig.actions.find((action) => action.id === "next")?.label,
      "Next page",
    );
    assert.equal(
      actionConfig.actions.find((action) => action.id === "next")?.approved,
      false,
    );
  });
});

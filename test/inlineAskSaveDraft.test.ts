import { assert } from "chai";
import { describe, it } from "mocha";
import {
  checkInlineAskSave,
  readInlineAskSelectionDraft,
} from "../src/modules/contextPanel/selectionPrompt/inlineAskSnapshot";

/** Zotero's popup draft (event.params.annotation), as the card copies it. */
const draft = {
  type: "highlight",
  sortIndex: "00002|000120|00311",
  pageLabel: "17",
  position: {
    pageIndex: 2,
    rects: [
      [71.94, 470.123, 290.5, 481.4],
      [71.94, 456.123, 180.25, 467.4],
    ],
  },
  text: "Drift is slow",
};

describe("readInlineAskSelectionDraft", function () {
  it("keeps Zotero's draft values as they are", function () {
    const read = readInlineAskSelectionDraft(draft, "Drift is slow");
    assert.deepEqual(read, {
      ok: true,
      selection: {
        pageIndex: 2,
        rects: draft.position.rects,
        sortIndex: draft.sortIndex,
        pageLabel: "17",
        text: "Drift is slow",
      },
    });
  });

  it("falls back to the page label the card computed", function () {
    const read = readInlineAskSelectionDraft(
      { ...draft, pageLabel: undefined },
      "Drift is slow",
      "iii",
    );
    assert.isTrue(read.ok);
    if (read.ok) assert.equal(read.selection.pageLabel, "iii");
  });

  it("refuses a selection that continues on the next page", function () {
    assert.deepEqual(
      readInlineAskSelectionDraft(
        {
          ...draft,
          position: { ...draft.position, nextPageRects: [[1, 2, 3, 4]] },
        },
        "Drift is slow",
      ),
      { ok: false, block: "cross_page" },
    );
  });

  it("refuses a draft without rects, sort index or page", function () {
    for (const broken of [
      null,
      { ...draft, sortIndex: undefined },
      { ...draft, position: { pageIndex: 2, rects: [] } },
      { ...draft, position: { pageIndex: 2 } },
      { ...draft, position: { rects: draft.position.rects } },
      { ...draft, position: { pageIndex: 2, rects: [[1, 2, 3]] } },
    ])
      assert.deepEqual(
        readInlineAskSelectionDraft(broken, "Drift is slow"),
        { ok: false, block: "no_position" },
        JSON.stringify(broken),
      );
  });
});

describe("checkInlineAskSave", function () {
  const ready = {
    isPdf: true,
    trashed: false,
    editable: true,
    conversationKey: 42,
    draft: readInlineAskSelectionDraft(draft, "Drift is slow"),
  };

  it("allows a PDF selection in an editable library with a conversation", function () {
    assert.isNull(checkInlineAskSave(ready));
  });

  it("names the first reason Save cannot run", function () {
    assert.equal(checkInlineAskSave({ ...ready, isPdf: false }), "not_pdf");
    assert.equal(checkInlineAskSave({ ...ready, trashed: true }), "trashed");
    assert.equal(
      checkInlineAskSave({ ...ready, editable: false }),
      "read_only",
    );
    assert.equal(
      checkInlineAskSave({
        ...ready,
        draft: { ok: false, block: "cross_page" },
      }),
      "cross_page",
    );
    assert.equal(
      checkInlineAskSave({
        ...ready,
        draft: { ok: false, block: "no_position" },
      }),
      "no_position",
    );
    for (const conversationKey of [0, -3, NaN, null])
      assert.equal(
        checkInlineAskSave({ ...ready, conversationKey }),
        "no_conversation",
        String(conversationKey),
      );
  });
});

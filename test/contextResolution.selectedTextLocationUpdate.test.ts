import { assert } from "chai";
import {
  appendSelectedTextContextForItem,
  getSelectedTextContextEntries,
  setSelectedTextContextEntries,
  updateSelectedTextContextLocationForItem,
} from "../src/modules/contextPanel/contextResolution";

describe("selected text location enrichment", function () {
  const conversationKey = 919191;

  beforeEach(function () {
    setSelectedTextContextEntries(conversationKey, []);
  });

  afterEach(function () {
    setSelectedTextContextEntries(conversationKey, []);
  });

  it("adds page metadata after an immediate text-only capture", function () {
    assert.isTrue(
      appendSelectedTextContextForItem(
        conversationKey,
        "captured reader text",
        "pdf",
        null,
        { contextItemId: 42 },
      ),
    );

    assert.isTrue(
      updateSelectedTextContextLocationForItem(
        conversationKey,
        "captured reader text",
        "pdf",
        null,
        { contextItemId: 42, pageIndex: 3, pageLabel: "431" },
      ),
    );
    assert.deepInclude(getSelectedTextContextEntries(conversationKey)[0], {
      text: "captured reader text",
      source: "pdf",
      contextItemId: 42,
      pageIndex: 3,
      pageLabel: "431",
    });
  });

  it("keeps the page label empty when the reader reported none (D5)", function () {
    appendSelectedTextContextForItem(
      conversationKey,
      "unlabelled appended text",
      "pdf",
      null,
      { contextItemId: 42, pageIndex: 3 },
    );
    appendSelectedTextContextForItem(
      conversationKey,
      "unlabelled located text",
      "pdf",
      null,
      { contextItemId: 42 },
    );
    assert.isTrue(
      updateSelectedTextContextLocationForItem(
        conversationKey,
        "unlabelled located text",
        "pdf",
        null,
        { contextItemId: 42, pageIndex: 5 },
      ),
    );

    const [appended, located] = getSelectedTextContextEntries(conversationKey);
    assert.equal(appended?.pageIndex, 3);
    assert.isUndefined(appended?.pageLabel);
    assert.equal(located?.pageIndex, 5);
    assert.isUndefined(located?.pageLabel);
  });

  it("does not overwrite an already located context", function () {
    appendSelectedTextContextForItem(
      conversationKey,
      "located reader text",
      "pdf",
      null,
      { contextItemId: 42, pageIndex: 1, pageLabel: "429" },
    );

    assert.isFalse(
      updateSelectedTextContextLocationForItem(
        conversationKey,
        "located reader text",
        "pdf",
        null,
        { contextItemId: 42, pageIndex: 4, pageLabel: "432" },
      ),
    );
    assert.deepInclude(getSelectedTextContextEntries(conversationKey)[0], {
      pageIndex: 1,
      pageLabel: "429",
    });
  });

  it("does not attach a page from a different PDF", function () {
    appendSelectedTextContextForItem(
      conversationKey,
      "attachment-specific reader text",
      "pdf",
      null,
      { contextItemId: 42 },
    );

    assert.isFalse(
      updateSelectedTextContextLocationForItem(
        conversationKey,
        "attachment-specific reader text",
        "pdf",
        null,
        { contextItemId: 99, pageIndex: 2, pageLabel: "431" },
      ),
    );
    assert.deepInclude(getSelectedTextContextEntries(conversationKey)[0], {
      text: "attachment-specific reader text",
      source: "pdf",
      contextItemId: 42,
    });
  });
});

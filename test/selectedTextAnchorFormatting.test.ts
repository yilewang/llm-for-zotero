import { assert } from "chai";
import {
  formatSelectedTextLocator,
  renderSelectedTextPageFallbackContext,
} from "../src/services/context/selectedTextAnchorFormatting";
import type { ResolvedSelectedTextAnchor } from "../src/shared/types";

function pageAnchor(
  patch: Partial<ResolvedSelectedTextAnchor> = {},
): ResolvedSelectedTextAnchor {
  return {
    contextIndex: 0,
    contextItemId: 91,
    pageIndex: 4,
    resolution: "page",
    preferredChunkIndexes: [],
    contextText: "Verified page text around the selection.",
    injectedChars: 0,
    ...patch,
  };
}

describe("selected text anchor formatting (D5)", function () {
  it("numbers a page with no printed label for display in the locator", function () {
    assert.equal(
      formatSelectedTextLocator(
        { text: "quote", source: "pdf", contextItemId: 91, pageIndex: 4 },
        pageAnchor(),
      ),
      "[attachment_id=91, page_label=5, page_index=4, location_resolution=page]",
    );
  });

  it("numbers a page with no printed label in the page fallback block", function () {
    const rendered = renderSelectedTextPageFallbackContext({
      anchors: [pageAnchor()],
    });

    assert.include(
      rendered,
      "[attachment_id=91, page_label=5, page_index=4, location_resolution=page]",
    );
  });

  it("shows a printed label as it is", function () {
    const rendered = renderSelectedTextPageFallbackContext({
      anchors: [pageAnchor({ pageLabel: "431" })],
    });

    assert.include(rendered, "page_label=431, page_index=4");
  });
});

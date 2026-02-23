import { assert } from "chai";
import {
  formatOpenChatTextContextLabel,
  formatPaperCitationLabel,
} from "../src/modules/contextPanel/paperAttribution";

describe("paperAttribution", function () {
  it("formats author-year citation labels", function () {
    const label = formatPaperCitationLabel({
      itemId: 1,
      contextItemId: 2,
      title: "Paper",
      firstCreator: "Alice Smith",
      year: "2021",
    });
    assert.equal(label, "Smith et al., 2021");
  });

  it("falls back deterministically when metadata is missing", function () {
    const label = formatOpenChatTextContextLabel({
      itemId: 42,
      contextItemId: 99,
      title: "Untitled",
    });
    assert.equal(label, "Paper 42 - Text Context");
  });
});

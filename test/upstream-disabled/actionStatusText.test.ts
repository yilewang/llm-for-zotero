import { assert } from "chai";
import {
  formatActionLabel,
  resolveActionCompletionStatusText,
} from "../src/modules/contextPanel/actionStatusText";

describe("actionStatusText", function () {
  it("formats snake_case action names for fallback status text", function () {
    assert.equal(formatActionLabel("complete_metadata"), "Complete Metadata");
  });

  it("prefers the last progress summary over the generic completion text", function () {
    assert.equal(
      resolveActionCompletionStatusText({
        actionName: "complete_metadata",
        lastProgressSummary: "0 papers have updatable fields",
      }),
      "0 papers have updatable fields",
    );
  });

  it("falls back to a generic completion message when no summary is available", function () {
    assert.equal(
      resolveActionCompletionStatusText({
        actionName: "auto_tag",
        lastProgressSummary: "   ",
      }),
      "Auto Tag complete",
    );
  });
});

import { assert } from "chai";
import {
  boldLeadSentence,
  tidyReleaseNotesMarkdown,
} from "../src/modules/releaseNotesFormat";

describe("releaseNotesFormat", function () {
  it("turns runs of plain lines into bullets with a bold first sentence", function () {
    const body =
      "## v3.9.12\r\n\r\n### The big ones\r\n\r\nBetter library search. Related words now match.\r\nSiliconFlow is now supported.\r\n\r\n### Fixes\r\n\r\nOne fix only.";
    assert.equal(
      tidyReleaseNotesMarkdown(body, "3.9.12"),
      [
        "### The big ones",
        "",
        "- **Better library search.** Related words now match.",
        "- SiliconFlow is now supported.",
        "",
        "### Fixes",
        "",
        "One fix only.",
      ].join("\n"),
    );
  });

  it("drops headings and bold lines that only name the release", function () {
    const body =
      "### Release note\n\n**LLM for Zotero v3.9.11**\n\nThis release improves things.\n\n- **Item.**\n  More about it.\n  And more.";
    assert.equal(
      tidyReleaseNotesMarkdown(body, "3.9.11"),
      "This release improves things.\n\n- **Item.**\n  More about it.\n  And more.",
    );
  });

  it("leaves code blocks, tables and existing lists alone", function () {
    const body =
      "```\nline one\nline two\n```\n\n| a | b |\n| - | - |\n\n- x\n- y";
    assert.equal(tidyReleaseNotesMarkdown(body, "1.0.0"), body);
  });

  it("bolds only a short first sentence", function () {
    assert.equal(
      boldLeadSentence("Short. Then more."),
      "**Short.** Then more.",
    );
    assert.equal(boldLeadSentence("Only one sentence."), "Only one sentence.");
    assert.equal(
      boldLeadSentence("Already **bold**. Rest."),
      "Already **bold**. Rest.",
    );
  });
});

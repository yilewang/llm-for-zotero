import { assert } from "chai";
import {
  buildPaperQuoteCitationGuidance,
  formatOpenChatTextContextLabel,
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../src/modules/contextPanel/paperAttribution";

describe("paperAttribution", function () {
  it("formats author-year citation labels using Zotero Creator field directly", function () {
    const label = formatPaperCitationLabel({
      itemId: 1,
      contextItemId: 2,
      title: "Paper",
      firstCreator: "Smith et al.",
      year: "2021",
    });
    assert.equal(label, "Smith et al., 2021");
  });

  it("keeps citationKey internal and user label readable", function () {
    const label = formatPaperCitationLabel({
      itemId: 1,
      contextItemId: 2,
      title: "Paper",
      firstCreator: "Smith et al.",
      year: "2021",
      citationKey: "smith2021alpha",
    });
    assert.equal(label, "Smith et al., 2021");
  });

  it("formats parenthetical source labels and quote guidance", function () {
    const paper = {
      itemId: 1,
      contextItemId: 2,
      title: "Paper",
      firstCreator: "Smith et al.",
      year: "2021",
    };
    assert.equal(formatPaperSourceLabel(paper), "(Smith et al., 2021)");
    assert.include(
      buildPaperQuoteCitationGuidance(paper).join("\n"),
      "(Smith et al., 2021)",
    );
    assert.include(
      buildPaperQuoteCitationGuidance(paper).join("\n"),
      "include short blockquotes",
    );
    assert.include(
      buildPaperQuoteCitationGuidance(paper).join("\n"),
      "next non-empty line after the blockquote, before any commentary",
    );
    assert.include(
      buildPaperQuoteCitationGuidance(paper).join("\n"),
      "If quote anchors are provided, use the exact [[quote:<id>]] token",
    );
  });

  it("formats child attachment source labels and quote guidance", function () {
    const attachmentContext = {
      itemId: 1,
      contextItemId: 2,
      title: "Parent Paper",
      attachmentTitle: "test.md",
      firstCreator: "Chandra et al.",
      year: "2025",
      contentSourceMode: "markdown" as const,
    };

    assert.equal(
      formatPaperSourceLabel(attachmentContext),
      "(test.md, attachment under Chandra et al., 2025)",
    );
    const guidance =
      buildPaperQuoteCitationGuidance(attachmentContext).join("\n");
    assert.include(guidance, "quoting this selected attachment");
    assert.include(guidance, "> quoted text from the selected attachment");
    assert.include(
      guidance,
      "(test.md, attachment under Chandra et al., 2025)",
    );
  });

  it("keeps generic quote guidance citation-adjacent", function () {
    const guidance = buildPaperQuoteCitationGuidance().join("\n");

    assert.include(guidance, "> quoted text from the paper\n\n(Author, Year)");
    assert.include(
      guidance,
      "next non-empty line after the blockquote, before any commentary",
    );
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

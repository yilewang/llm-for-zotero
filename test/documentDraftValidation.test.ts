import { assert } from "chai";
import {
  collectDocumentDraftIssues,
  stripHandwrittenReferences,
} from "../src/agent/documents/draftValidation";

describe("document draft validation", function () {
  it("accepts natural scope and limitation headings while reporting quote issues together", function () {
    const issues = collectDocumentDraftIssues({
      markdown: [
        "# Review",
        "",
        "## Introduction and Scope",
        "",
        'The literature calls this "representational drift".',
        "",
        "## Evidence Limitations and Open Questions",
        "",
        "> An unmapped quotation is not publishable.",
      ].join("\n"),
      requiredSections: ["Scope and limitations"],
      requiresCoverageSection: true,
    });

    assert.deepEqual(issues, [
      "Direct quotations must use internal [[quote:Q1]] tokens and host-verifiable quote mappings",
    ]);
  });

  it("reports all independently detectable structural defects in one pass", function () {
    const issues = collectDocumentDraftIssues({
      markdown: "# Review\n\n> Unmapped source language.",
      requiredSections: ["Methods"],
      requiresCoverageSection: true,
    });

    assert.deepEqual(issues, [
      "Document is missing required sections: methods, scope and limitations",
      "Direct quotations must use internal [[quote:Q1]] tokens and host-verifiable quote mappings",
    ]);
  });

  it("recognizes required sections under numbered headings", function () {
    const issues = collectDocumentDraftIssues({
      markdown: [
        "# Review",
        "",
        "## 1. Introduction and review question",
        "",
        "Why the question matters.",
        "",
        "## 2) Scope and method",
        "",
        "Three papers.",
        "",
        "### 3.1 Thematic synthesis",
        "",
        "One theme.",
        "",
        "## IV. Scope and limitations",
        "",
        "Every paper was read in full.",
      ].join("\n"),
      requiredSections: [
        "Introduction and review question",
        "Scope and method",
        "Thematic synthesis",
      ],
      requiresCoverageSection: true,
    });

    assert.deepEqual(issues, []);
  });

  it("treats quoted names and short terms as prose and quoted sentences as direct quotations", function () {
    const validate = (sentence: string) =>
      collectDocumentDraftIssues({
        markdown: `# Review\n\n## Scope and limitations\n\n${sentence}`,
        requiredSections: [],
        requiresCoverageSection: true,
      });

    assert.deepEqual(
      validate(
        'This review covers the "NetworkLoop-net1788968608447" collection and the "slow-speed prior hypothesis" it tests.',
      ),
      [],
      "a quoted identifier or term is not a quotation",
    );
    assert.deepEqual(
      validate(
        'The authors conclude that "the overshoot is a general consequence of optic-flow path integration".',
      ),
      [
        "Direct quotations must use internal [[quote:Q1]] tokens and host-verifiable quote mappings",
      ],
      "a quoted run of prose is a quotation",
    );
    assert.deepEqual(
      validate(
        "They write that \u201cmacaques undershoot at every distance tested\u201d.",
      ),
      [
        "Direct quotations must use internal [[quote:Q1]] tokens and host-verifiable quote mappings",
      ],
      "curly quotes count too",
    );
  });

  it("removes a model-authored bibliography without discarding later sections", function () {
    const draft = [
      "# Review",
      "",
      "Evidence [[cite:C1]].",
      "",
      "## References",
      "",
      "- Hand-written entry",
      "",
      "## Appendix",
      "",
      "Retained appendix.",
    ].join("\n");

    assert.equal(
      stripHandwrittenReferences(draft),
      [
        "# Review",
        "",
        "Evidence [[cite:C1]].",
        "",
        "## Appendix",
        "",
        "Retained appendix.",
      ].join("\n"),
    );
  });
});

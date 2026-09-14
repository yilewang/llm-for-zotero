import { assert } from "chai";
import {
  normalizeRecordPaperInput,
  RECORD_PAPER_EXAMPLE,
} from "../src/agent/research/recordDecoding";

describe("record_papers input normalization", function () {
  it("hoists finding fields written at the paper level", function () {
    const { paper, warnings } = normalizeRecordPaperInput(
      {
        libraryID: 1,
        itemKey: "AAAA1111",
        screeningStatus: "included",
        mainMessage: "Habits arise from a winner-take-all arbitration.",
        confidence: "high",
        findings: ["one"],
        limitations: [],
        method: "model",
        researchQuestion: "q",
        relevance: "r",
      },
      0,
    );
    assert.equal(
      paper.finding?.mainMessage,
      "Habits arise from a winner-take-all arbitration.",
    );
    assert.equal(paper.finding?.confidence, "high");
    assert.deepEqual(paper.finding?.findings, ["one"]);
    assert.isUndefined((paper as Record<string, unknown>).mainMessage);
    assert.deepEqual(warnings, []);
  });

  it("keeps a nested finding field over the same field at the paper level", function () {
    const { paper } = normalizeRecordPaperInput(
      {
        libraryID: 1,
        itemKey: "AAAA1111",
        confidence: "low",
        finding: { confidence: "high" },
      },
      0,
    );
    assert.equal(paper.finding?.confidence, "high");
  });

  it("drops unknown keys and reports them", function () {
    const { paper, warnings } = normalizeRecordPaperInput(
      {
        libraryID: 1,
        itemKey: "AAAA1111",
        finding: { mechanismsNote: "x", confidence: "low" },
      },
      2,
    );
    assert.isUndefined(paper.finding?.mechanismsNote);
    assert.deepEqual(warnings, [
      "papers[2].finding.mechanismsNote was ignored",
    ]);
  });

  it("rejects a paper without identity with an example", function () {
    assert.throws(
      () => normalizeRecordPaperInput({ finding: {} }, 0),
      /papers\[0\]\.libraryID[\s\S]*Example:[\s\S]*"itemKey"/,
    );
  });

  it("publishes a minimal valid example", function () {
    assert.equal(RECORD_PAPER_EXAMPLE.libraryID, 1);
    assert.isString(RECORD_PAPER_EXAMPLE.finding.mainMessage);
  });
});

import { assert } from "chai";
import {
  buildLibraryChatCoverageReceipt,
  completeLibraryChatReadStrategyDiagnostics,
  resolveLibraryChatReadStrategy,
} from "../src/shared/libraryChatReadStrategy";

describe("library chat read strategy", function () {
  it("uses deep synthesis for bounded selected broad synthesis", function () {
    const strategy = resolveLibraryChatReadStrategy({
      intent: "summarize",
      depth: "evidence",
      paperCount: 23,
      scopeType: "items",
      explicitPaperScope: true,
    });

    assert.equal(strategy.resolvedStrategy, "deep_synthesis");
    assert.equal(strategy.answerStyle, "concise_overview");
  });

  it("stages medium-sized synthesis as evidence overview", function () {
    const strategy = resolveLibraryChatReadStrategy({
      intent: "summarize",
      depth: "evidence",
      paperCount: 50,
      scopeType: "collection",
    });

    assert.equal(strategy.resolvedStrategy, "evidence_overview");
  });

  it("keeps large or unbounded synthesis at abstract-map depth first", function () {
    const strategy = resolveLibraryChatReadStrategy({
      intent: "summarize",
      depth: "evidence",
      paperCount: 250,
      scopeType: "library",
    });

    assert.equal(strategy.resolvedStrategy, "abstract_map");
  });

  it("routes exact quote requests to quote verification", function () {
    const strategy = resolveLibraryChatReadStrategy({
      intent: "verify",
      depth: "verify",
      paperCount: 12,
      scopeType: "items",
      explicitPaperScope: true,
    });

    assert.equal(strategy.resolvedStrategy, "quote_verify");
    assert.equal(strategy.answerStyle, "quote_answer");
  });

  it("keeps diagnostic and receipt metadata-only paper counts consistent", function () {
    const diagnostics = completeLibraryChatReadStrategyDiagnostics({
      base: resolveLibraryChatReadStrategy({
        intent: "summarize",
        depth: "evidence",
        paperCount: 4,
        scopeType: "items",
        explicitPaperScope: true,
      }),
      papersPlanned: 4,
      papersBodyRead: 1,
      papersMetadataOnly: 1,
    });
    const receipt = buildLibraryChatCoverageReceipt(diagnostics);

    assert.equal(diagnostics.papersMetadataOnly, 3);
    assert.equal(receipt.papersMetadataOnly, 3);
    assert.include(receipt.text, "Metadata/abstract only: 3");
  });
});

import { assert } from "chai";
import {
  getQuoteValidationDecisionCacheStatsForTests,
  hasQuoteSourceIndexForTests,
  hasQuoteValidationDecisionForTests,
  primeQuoteSourceIndexCacheForTests,
  primeQuoteValidationDecisionCacheForTests,
  resetQuoteValidationDecisionCacheForTests,
} from "../src/modules/contextPanel/chat";

describe("quote validation caches", function () {
  beforeEach(function () {
    resetQuoteValidationDecisionCacheForTests();
  });

  afterEach(function () {
    resetQuoteValidationDecisionCacheForTests();
  });

  it("evicts provenance decisions by entry-aware LRU order", function () {
    for (let index = 0; index < 1_000; index += 1) {
      primeQuoteValidationDecisionCacheForTests(`decision-${index}`);
    }
    primeQuoteValidationDecisionCacheForTests("decision-0");
    primeQuoteValidationDecisionCacheForTests("decision-1000");

    assert.isTrue(hasQuoteValidationDecisionForTests("decision-0"));
    assert.isFalse(hasQuoteValidationDecisionForTests("decision-1"));
    assert.isTrue(hasQuoteValidationDecisionForTests("decision-1000"));
    assert.equal(getQuoteValidationDecisionCacheStatsForTests().entries, 1_000);
  });

  it("evicts provenance decisions by byte budget and rejects oversized records", function () {
    primeQuoteValidationDecisionCacheForTests("large-first", 1_100_000);
    primeQuoteValidationDecisionCacheForTests("large-second", 1_100_000);

    assert.isFalse(hasQuoteValidationDecisionForTests("large-first"));
    assert.isTrue(hasQuoteValidationDecisionForTests("large-second"));
    assert.isAtMost(
      getQuoteValidationDecisionCacheStatsForTests().bytes,
      4 * 1024 * 1024,
    );

    primeQuoteValidationDecisionCacheForTests("oversized", 2_200_000);
    assert.isFalse(hasQuoteValidationDecisionForTests("oversized"));
  });

  it("bounds immutable source indexes without copying oversized scopes", function () {
    const sourceTexts = [
      {
        sourceText:
          "A compact source sentence is enough to exercise immutable index caching.",
        sourceLabel: "(Cache et al., 2026)",
        sourceMatchSource: "pdf-page-text",
        contextItemId: 22,
        itemId: 11,
        pageHintIndex: 0,
        sourceFingerprint: "cache-fingerprint",
      },
    ];
    for (let index = 0; index < 64; index += 1) {
      primeQuoteSourceIndexCacheForTests(`scope-${index}`, sourceTexts);
    }
    primeQuoteSourceIndexCacheForTests("scope-0", sourceTexts);
    primeQuoteSourceIndexCacheForTests("scope-64", sourceTexts);

    assert.isTrue(hasQuoteSourceIndexForTests("scope-0"));
    assert.isFalse(hasQuoteSourceIndexForTests("scope-1"));
    assert.isTrue(hasQuoteSourceIndexForTests("scope-64"));
    assert.equal(
      getQuoteValidationDecisionCacheStatsForTests().sourceIndexEntries,
      64,
    );

    const oversizedSignature = "s".repeat(1_100_000);
    primeQuoteSourceIndexCacheForTests(oversizedSignature, sourceTexts);
    assert.isFalse(hasQuoteSourceIndexForTests(oversizedSignature));
  });
});

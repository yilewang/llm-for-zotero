import { assert } from "chai";
import {
  quoteComparisonKey,
  quoteKeyHash,
} from "../src/services/quotes/quoteKey";
import { buildCitationQuoteHash } from "../src/modules/contextPanel/citationNavigationCache";

describe("quoteKey", function () {
  it("sanitizes, collapses whitespace, trims, and lowercases", function () {
    assert.equal(
      quoteComparisonKey("  The Quick\n\tbrown\u0007 FOX  "),
      "the quick brown fox",
    );
    assert.equal(quoteComparisonKey(""), "");
    assert.equal(quoteComparisonKey("   \n "), "");
    // A lone surrogate becomes U+FFFD; a valid pair is kept.
    assert.equal(quoteComparisonKey("A\ud800B 🧠"), "a�b 🧠");
    assert.equal(quoteComparisonKey(undefined as unknown as string), "");
  });

  it("hashes the comparison key as eight hex characters", function () {
    assert.equal(
      quoteKeyHash("  The Quick\n brown FOX — Zürich – 文献 🧠 naïve"),
      "1776447d",
    );
    assert.equal(quoteKeyHash("the quick brown fox"), "338f85c2");
    assert.equal(
      quoteKeyHash("The   QUICK brown fox"),
      quoteKeyHash("the quick brown fox"),
    );
  });

  it("returns an empty hash for text with no comparable content", function () {
    assert.equal(quoteKeyHash(""), "");
    assert.equal(quoteKeyHash("  \n\t "), "");
  });

  it("is the hash the citation navigation cache stores", function () {
    for (const text of ["", "One quote.", "  Mixed\nCASE  text "]) {
      assert.equal(buildCitationQuoteHash(text), quoteKeyHash(text));
    }
  });
});

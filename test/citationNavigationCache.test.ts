import { assert } from "chai";
import {
  buildCitationQuoteHash,
  clearCitationPageCache,
  lookupCitationPage,
  rememberCitationPage,
  setCitationNavigationCacheNowForTests,
} from "../src/modules/contextPanel/citationNavigationCache";
import { clearPageTextCache } from "../src/modules/contextPanel/livePdfSelectionLocator";

describe("citationNavigationCache", function () {
  afterEach(function () {
    setCitationNavigationCacheNowForTests(null);
    clearCitationPageCache();
    clearPageTextCache();
  });

  it("stores verified citation pages by context id and normalized quote hash", function () {
    const quote = "The same quote text should be normalized before hashing.";
    const noisyQuote =
      "  The same   quote text should be normalized before hashing. ";

    const pageLabel = rememberCitationPage({
      contextItemId: 17,
      quoteText: quote,
      pageIndex: 4,
      pageLabel: "v",
    });
    const cached = lookupCitationPage({
      contextItemId: 17,
      quoteText: noisyQuote,
    });

    assert.equal(pageLabel, "v");
    assert.equal(cached?.contextItemId, 17);
    assert.equal(cached?.quoteHash, buildCitationQuoteHash(noisyQuote));
    assert.equal(cached?.pageIndex, 4);
    assert.equal(cached?.pageLabel, "v");
    assert.match(cached?.quoteHash || "", /^[0-9a-f]{8}$/);
    assert.notInclude(cached?.quoteHash || "", "same quote text");
  });

  it("keeps identical quote hashes separated by context item id", function () {
    const quote = "Context ids should separate identical quotes.";
    rememberCitationPage({
      contextItemId: 17,
      quoteText: quote,
      pageIndex: 4,
      pageLabel: "A-5",
    });
    rememberCitationPage({
      contextItemId: 23,
      quoteText: quote,
      pageIndex: 9,
      pageLabel: "B-10",
    });

    assert.equal(
      lookupCitationPage({ contextItemId: 17, quoteText: quote })?.pageLabel,
      "A-5",
    );
    assert.equal(
      lookupCitationPage({ contextItemId: 23, quoteText: quote })?.pageLabel,
      "B-10",
    );
  });

  it("expires stale citation page entries", function () {
    const quote = "TTL should remove old citation page labels.";
    setCitationNavigationCacheNowForTests(() => 1_000);
    rememberCitationPage({
      contextItemId: 17,
      quoteText: quote,
      pageIndex: 4,
      pageLabel: "5",
    });

    setCitationNavigationCacheNowForTests(() => 24 * 60 * 60 * 1000 + 1_001);

    assert.isNull(lookupCitationPage({ contextItemId: 17, quoteText: quote }));
  });

  it("evicts least-recently-used entries when the cache is full", function () {
    setCitationNavigationCacheNowForTests(() => 1_000);
    for (let index = 0; index < 1000; index += 1) {
      rememberCitationPage({
        contextItemId: index + 1,
        quoteText: `Quote ${index}`,
        pageIndex: index,
        pageLabel: String(index + 1),
      });
    }
    assert.isNotNull(
      lookupCitationPage({ contextItemId: 1, quoteText: "Quote 0" }),
    );

    rememberCitationPage({
      contextItemId: 1001,
      quoteText: "Quote 1000",
      pageIndex: 1000,
      pageLabel: "1001",
    });

    assert.isNull(
      lookupCitationPage({ contextItemId: 2, quoteText: "Quote 1" }),
    );
    assert.equal(
      lookupCitationPage({ contextItemId: 1, quoteText: "Quote 0" })?.pageLabel,
      "1",
    );
  });

  it("clears citation page labels when page-text caches are cleared", function () {
    const quote =
      "A verified page label should share the page cache lifecycle.";
    rememberCitationPage({
      contextItemId: 17,
      quoteText: quote,
      pageIndex: 4,
      pageLabel: "5",
    });

    clearPageTextCache();

    assert.isNull(lookupCitationPage({ contextItemId: 17, quoteText: quote }));
  });
});

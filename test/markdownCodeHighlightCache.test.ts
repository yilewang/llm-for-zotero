import { assert } from "chai";
import {
  __getCodeHighlightCacheStatsForTest,
  __resetCodeHighlightCacheForTest,
  CODE_HIGHLIGHT_CACHE_MAX_ENTRIES,
  renderMarkdown,
} from "../src/utils/markdown";

function fence(lang: string, code: string): string {
  return "```" + lang + "\n" + code + "\n```";
}

describe("code highlight memoization", function () {
  beforeEach(function () {
    __resetCodeHighlightCacheForTest();
  });

  it("returns identical HTML on a repeated render and serves it from cache", function () {
    const source = fence(
      "javascript",
      "const answer = 40 + 2;\nconsole.log(answer);",
    );

    const first = renderMarkdown(source);
    const afterFirst = __getCodeHighlightCacheStatsForTest();
    assert.equal(afterFirst.misses, 1, "first render should be a cache miss");
    assert.equal(afterFirst.hits, 0);
    assert.equal(afterFirst.size, 1);

    const second = renderMarkdown(source);
    const afterSecond = __getCodeHighlightCacheStatsForTest();
    assert.equal(second, first, "repeated render must be byte-identical");
    assert.equal(afterSecond.hits, 1, "second render should be a cache hit");
    assert.equal(afterSecond.misses, 1, "no additional miss on repeat");
    assert.equal(afterSecond.size, 1, "cache should not grow on a hit");
  });

  it("keeps distinct entries for different code and for different languages", function () {
    renderMarkdown(fence("javascript", "const a = 1;"));
    renderMarkdown(fence("javascript", "const b = 2;")); // different code
    renderMarkdown(fence("python", "a = 1")); // different language

    const stats = __getCodeHighlightCacheStatsForTest();
    assert.equal(stats.misses, 3, "each distinct (lang, code) is a miss");
    assert.equal(stats.hits, 0);
    assert.equal(stats.size, 3);
  });

  it("still memoizes fences with no highlightable language", function () {
    const source = fence("", "plain unhighlighted text");

    const first = renderMarkdown(source);
    const second = renderMarkdown(source);
    const stats = __getCodeHighlightCacheStatsForTest();

    assert.equal(second, first);
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
  });

  it("bounds the cache with LRU eviction", function () {
    const overflow = CODE_HIGHLIGHT_CACHE_MAX_ENTRIES + 25;
    for (let i = 0; i < overflow; i += 1) {
      renderMarkdown(fence("javascript", `const unique_${i} = ${i};`));
    }

    const stats = __getCodeHighlightCacheStatsForTest();
    assert.isAtMost(
      stats.size,
      CODE_HIGHLIGHT_CACHE_MAX_ENTRIES,
      "cache must not exceed its entry bound",
    );
    assert.equal(
      stats.misses,
      overflow,
      "every distinct block was computed once",
    );
  });
});

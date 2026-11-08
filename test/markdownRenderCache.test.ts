import { assert } from "chai";
import {
  __getRenderedMarkdownCacheStatsForTest,
  __resetRenderedMarkdownCacheForTest,
  __setMarkdownParserDisabledForTest,
  RENDERED_MARKDOWN_CACHE_MAX_ENTRIES,
  renderMarkdown,
  renderMarkdownForNote,
  renderMarkdownMemoized,
} from "../src/utils/markdown";

const RICH = [
  "## Summary",
  "",
  "Gain $g = 1.5$ and **time constant** $\\tau = 10\\,\\text{ms}$ [Smith, 2020].",
  "",
  "$$",
  "\\frac{dx}{dt} = -\\frac{x}{\\tau} + W\\,\\phi(x)",
  "$$",
  "",
  "```python",
  "x = x + dt * (-x + W @ np.tanh(g * x))",
  "```",
  "",
  "| Metric | Value |",
  "|---|---|",
  "| R2 | 0.82 |",
  "",
  "1. A [link](https://example.com) and <sub>raw</sub> html.",
  "2. ![figure](figure.png)",
].join("\n");

describe("rendered markdown output cache", function () {
  beforeEach(function () {
    __resetRenderedMarkdownCacheForTest();
  });

  after(function () {
    __resetRenderedMarkdownCacheForTest();
    __setMarkdownParserDisabledForTest(false);
  });

  it("returns the same HTML as renderMarkdown, from cache on a repeat", function () {
    const expected = renderMarkdown(RICH);
    const first = renderMarkdownMemoized(RICH);
    const second = renderMarkdownMemoized(RICH);
    assert.equal(first, expected);
    assert.equal(second, expected);
    assert.deepEqual(__getRenderedMarkdownCacheStatsForTest(), {
      size: 1,
      hits: 1,
      misses: 1,
    });
  });

  it("does not serve chat HTML to a note render of the same text", function () {
    const chat = renderMarkdownMemoized(RICH);
    const note = renderMarkdownForNote(RICH);
    assert.notEqual(chat, note);
    assert.equal(renderMarkdownMemoized(RICH), chat);
  });

  it("bypasses the cache while the legacy parser is in use", function () {
    __setMarkdownParserDisabledForTest(true);
    try {
      assert.equal(renderMarkdownMemoized(RICH), renderMarkdown(RICH));
      assert.equal(__getRenderedMarkdownCacheStatsForTest().size, 0);
    } finally {
      __setMarkdownParserDisabledForTest(false);
    }
  });

  it("keeps at most the configured number of entries, evicting the oldest", function () {
    for (let index = 0; index <= RENDERED_MARKDOWN_CACHE_MAX_ENTRIES; index++) {
      renderMarkdownMemoized(`Message ${index} with $x_${index}$.`);
    }
    assert.equal(
      __getRenderedMarkdownCacheStatsForTest().size,
      RENDERED_MARKDOWN_CACHE_MAX_ENTRIES,
    );
    renderMarkdownMemoized("Message 0 with $x_0$.");
    const stats = __getRenderedMarkdownCacheStatsForTest();
    assert.equal(stats.hits, 0, "the oldest entry was evicted");
  });
});

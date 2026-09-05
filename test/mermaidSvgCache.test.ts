import { assert } from "chai";
import { describe, it, beforeEach } from "mocha";

import {
  MERMAID_SVG_CACHE_MAX_BYTES,
  MERMAID_SVG_CACHE_MAX_ENTRIES,
  buildMermaidSvgCacheKey,
  cacheMermaidSvg,
  clearMermaidSvgCache,
  getCachedMermaidSvg,
  getMermaidSvgCacheSizeForTests,
  invalidateMermaidSvg,
} from "../src/modules/contextPanel/mermaidSvgCache";

describe("mermaidSvgCache", function () {
  beforeEach(() => {
    clearMermaidSvgCache();
  });

  it("returns cached SVG for the same version, theme, and source", function () {
    const key = buildMermaidSvgCacheKey("3", "light", "graph TD; A-->B;");
    assert.isUndefined(getCachedMermaidSvg(key));
    cacheMermaidSvg(key, "<svg>diagram</svg>");
    assert.strictEqual(getCachedMermaidSvg(key), "<svg>diagram</svg>");
  });

  it("misses when any key component differs", function () {
    const source = "graph TD; A-->B;";
    cacheMermaidSvg(buildMermaidSvgCacheKey("3", "light", source), "<svg/>");
    assert.isUndefined(
      getCachedMermaidSvg(buildMermaidSvgCacheKey("3", "dark", source)),
    );
    assert.isUndefined(
      getCachedMermaidSvg(buildMermaidSvgCacheKey("4", "light", source)),
    );
    assert.isUndefined(
      getCachedMermaidSvg(buildMermaidSvgCacheKey("3", "light", "graph LR;")),
    );
  });

  it("keeps key components unambiguous", function () {
    // "a" + "bc" must not collide with "ab" + "c".
    cacheMermaidSvg(buildMermaidSvgCacheKey("1", "a", "bc"), "<svg>1</svg>");
    assert.isUndefined(
      getCachedMermaidSvg(buildMermaidSvgCacheKey("1", "ab", "c")),
    );
  });

  it("replaces an existing entry instead of duplicating it", function () {
    const key = buildMermaidSvgCacheKey("3", "light", "graph TD;");
    cacheMermaidSvg(key, "<svg>old</svg>");
    cacheMermaidSvg(key, "<svg>new</svg>");
    assert.strictEqual(getCachedMermaidSvg(key), "<svg>new</svg>");
    assert.strictEqual(getMermaidSvgCacheSizeForTests(), 1);
  });

  it("evicts the least recently used entry past the entry cap", function () {
    for (let i = 0; i < MERMAID_SVG_CACHE_MAX_ENTRIES; i++) {
      cacheMermaidSvg(
        buildMermaidSvgCacheKey("3", "light", `graph ${i};`),
        `<svg>${i}</svg>`,
      );
    }
    // Touch entry 0 so entry 1 becomes the oldest.
    assert.isString(
      getCachedMermaidSvg(buildMermaidSvgCacheKey("3", "light", "graph 0;")),
    );
    cacheMermaidSvg(
      buildMermaidSvgCacheKey("3", "light", "graph overflow;"),
      "<svg>overflow</svg>",
    );
    assert.strictEqual(
      getMermaidSvgCacheSizeForTests(),
      MERMAID_SVG_CACHE_MAX_ENTRIES,
    );
    assert.isString(
      getCachedMermaidSvg(buildMermaidSvgCacheKey("3", "light", "graph 0;")),
    );
    assert.isUndefined(
      getCachedMermaidSvg(buildMermaidSvgCacheKey("3", "light", "graph 1;")),
    );
  });

  it("invalidation removes an entry and reclaims its byte budget", function () {
    const key = buildMermaidSvgCacheKey("3", "light", "graph TD;");
    cacheMermaidSvg(key, "<svg>poisoned</svg>");
    invalidateMermaidSvg(key);
    assert.isUndefined(getCachedMermaidSvg(key));
    assert.strictEqual(getMermaidSvgCacheSizeForTests(), 0);
    // Invalidating a missing key is a harmless no-op, and the reclaimed
    // budget is usable again: refill close to the byte cap without evictions.
    invalidateMermaidSvg(key);
    const half = "x".repeat(Math.floor(MERMAID_SVG_CACHE_MAX_BYTES / 4) - 64);
    cacheMermaidSvg(buildMermaidSvgCacheKey("3", "light", "a"), half);
    cacheMermaidSvg(buildMermaidSvgCacheKey("3", "light", "b"), half);
    assert.strictEqual(getMermaidSvgCacheSizeForTests(), 2);
  });

  it("evicts by byte budget and never stores an oversized diagram", function () {
    const halfBudget = "x".repeat(Math.floor(MERMAID_SVG_CACHE_MAX_BYTES / 4));
    cacheMermaidSvg(buildMermaidSvgCacheKey("3", "light", "big1"), halfBudget);
    cacheMermaidSvg(buildMermaidSvgCacheKey("3", "light", "big2"), halfBudget);
    cacheMermaidSvg(buildMermaidSvgCacheKey("3", "light", "big3"), halfBudget);
    assert.isBelow(getMermaidSvgCacheSizeForTests(), 3);
    assert.isUndefined(
      getCachedMermaidSvg(buildMermaidSvgCacheKey("3", "light", "big1")),
    );

    const oversized = "x".repeat(MERMAID_SVG_CACHE_MAX_BYTES);
    const oversizedKey = buildMermaidSvgCacheKey("3", "light", "huge");
    cacheMermaidSvg(oversizedKey, oversized);
    assert.isUndefined(getCachedMermaidSvg(oversizedKey));
  });
});

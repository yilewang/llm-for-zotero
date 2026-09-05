/**
 * LRU cache for sanitized Mermaid SVG output.
 *
 * Chat refreshes rebuild message DOM from raw markdown, which discards every
 * rendered preview's element state — without a source-keyed cache each rebuild
 * re-invokes the Mermaid renderer for every diagram in the conversation. The
 * cache key must include the render version and theme, since both change the
 * produced SVG for identical source.
 */

export const MERMAID_SVG_CACHE_MAX_ENTRIES = 64;
export const MERMAID_SVG_CACHE_MAX_BYTES = 4 * 1024 * 1024;

const mermaidSvgCache = new Map<string, string>();
let mermaidSvgCacheBytes = 0;

function estimateEntryBytes(key: string, svg: string): number {
  return (key.length + svg.length) * 2;
}

export function buildMermaidSvgCacheKey(
  renderVersion: string,
  themeKey: string,
  source: string,
): string {
  return `${renderVersion}\u0000${themeKey}\u0000${source}`;
}

export function getCachedMermaidSvg(key: string): string | undefined {
  const cached = mermaidSvgCache.get(key);
  if (cached === undefined) return undefined;
  // Refresh recency for LRU ordering.
  mermaidSvgCache.delete(key);
  mermaidSvgCache.set(key, cached);
  return cached;
}

export function cacheMermaidSvg(key: string, svg: string): void {
  const existing = mermaidSvgCache.get(key);
  if (existing !== undefined) {
    mermaidSvgCache.delete(key);
    mermaidSvgCacheBytes -= estimateEntryBytes(key, existing);
  }
  const estimatedBytes = estimateEntryBytes(key, svg);
  // Skip caching a single diagram that would blow the whole byte budget.
  if (estimatedBytes > MERMAID_SVG_CACHE_MAX_BYTES) return;
  mermaidSvgCache.set(key, svg);
  mermaidSvgCacheBytes += estimatedBytes;
  while (
    mermaidSvgCache.size > MERMAID_SVG_CACHE_MAX_ENTRIES ||
    mermaidSvgCacheBytes > MERMAID_SVG_CACHE_MAX_BYTES
  ) {
    const oldestKey = mermaidSvgCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldestSvg = mermaidSvgCache.get(oldestKey);
    mermaidSvgCache.delete(oldestKey);
    mermaidSvgCacheBytes -= estimateEntryBytes(oldestKey, oldestSvg || "");
  }
}

/**
 * Drop an entry whose SVG failed to insert into the document — without this a
 * throw-on-insert entry would be replayed on every rebuild.
 */
export function invalidateMermaidSvg(key: string): void {
  const existing = mermaidSvgCache.get(key);
  if (existing === undefined) return;
  mermaidSvgCache.delete(key);
  mermaidSvgCacheBytes -= estimateEntryBytes(key, existing);
}

export function getMermaidSvgCacheSizeForTests(): number {
  return mermaidSvgCache.size;
}

/** Release all cached SVGs; called from clearAllState on plugin shutdown. */
export function clearMermaidSvgCache(): void {
  mermaidSvgCache.clear();
  mermaidSvgCacheBytes = 0;
}

export type FilterableImage = {
  pageIndex: number;
  width: number;
  height: number;
  contentHash: string;
};

export type EmbeddedImageLimits = {
  minSide: number;
  repeatedPageThreshold: number;
  maxImages: number;
};

export const EMBEDDED_IMAGE_LIMITS: EmbeddedImageLimits = {
  minSide: 100,
  repeatedPageThreshold: 3,
  maxImages: 200,
};

/**
 * Drops icons, logos/backgrounds repeated across pages and duplicate
 * occurrences, then keeps the first `maxImages` in page order.
 */
export function filterExtractedImages<T extends FilterableImage>(
  images: T[],
  limits: EmbeddedImageLimits = EMBEDDED_IMAGE_LIMITS,
): T[] {
  const pagesByHash = new Map<string, Set<number>>();
  for (const entry of images) {
    const pages = pagesByHash.get(entry.contentHash) ?? new Set<number>();
    pages.add(entry.pageIndex);
    pagesByHash.set(entry.contentHash, pages);
  }
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const entry of [...images].sort((a, b) => a.pageIndex - b.pageIndex)) {
    if (Math.min(entry.width, entry.height) < limits.minSide) continue;
    const pages = pagesByHash.get(entry.contentHash)?.size ?? 0;
    if (pages >= limits.repeatedPageThreshold) continue;
    if (seen.has(entry.contentHash)) continue;
    seen.add(entry.contentHash);
    kept.push(entry);
  }
  return kept.slice(0, limits.maxImages);
}

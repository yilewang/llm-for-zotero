import type { MultimodalItem } from "./types";

/**
 * Groups inputs into request batches without reordering them. A batch closes
 * when adding the next input would exceed the item limit, or when the next
 * input is an image and the batch already holds the image limit.
 * Returns the input indexes of each batch.
 */
export function planEmbeddingBatches(
  items: MultimodalItem[],
  limits: { maxItems: number; maxImages: number },
): number[][] {
  const maxItems = Math.max(1, Math.floor(limits.maxItems));
  const maxImages = Math.max(1, Math.floor(limits.maxImages));
  const batches: number[][] = [];
  let current: number[] = [];
  let imagesInCurrent = 0;
  items.forEach((item, index) => {
    const isImage = item.kind === "image";
    if (
      current.length >= maxItems ||
      (isImage && imagesInCurrent >= maxImages)
    ) {
      batches.push(current);
      current = [];
      imagesInCurrent = 0;
    }
    current.push(index);
    if (isImage) imagesInCurrent += 1;
  });
  if (current.length) batches.push(current);
  return batches;
}

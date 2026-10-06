/**
 * Image/screenshot context state — pure state operations with no DOM dependencies.
 */

import { composeContextStore } from "./composeContextStore";
import {
  clearPinnedContextOwner,
  retainPinnedImages,
} from "../setupHandlers/controllers/pinnedContextController";

export function clearSelectedImageState(
  pinnedImageKeys: Map<number, Set<string>>,
  itemId: number,
): void {
  composeContextStore.images.delete(itemId);
  composeContextStore.imagePreviewExpanded.delete(itemId);
  composeContextStore.imagePreviewActiveIndex.delete(itemId);
  clearPinnedContextOwner(pinnedImageKeys, itemId);
}

export function retainPinnedImageState(
  pinnedImageKeys: Map<number, Set<string>>,
  itemId: number,
): void {
  const retained = retainPinnedImages(
    pinnedImageKeys,
    itemId,
    composeContextStore.images.list(itemId),
  );
  if (retained.length) {
    composeContextStore.images.set(itemId, retained);
    const currentActiveIndex =
      composeContextStore.imagePreviewActiveIndex.get(itemId);
    const normalizedActiveIndex =
      typeof currentActiveIndex === "number" &&
      Number.isFinite(currentActiveIndex)
        ? Math.max(
            0,
            Math.min(retained.length - 1, Math.floor(currentActiveIndex)),
          )
        : 0;
    composeContextStore.imagePreviewActiveIndex.set(
      itemId,
      normalizedActiveIndex,
    );
    return;
  }
  composeContextStore.images.delete(itemId);
  composeContextStore.imagePreviewExpanded.delete(itemId);
  composeContextStore.imagePreviewActiveIndex.delete(itemId);
}

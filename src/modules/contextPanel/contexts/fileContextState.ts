/**
 * File attachment context state — pure state operations with no DOM dependencies.
 */

import { composeContextStore } from "./composeContextStore";
import {
  clearPinnedContextOwner,
  retainPinnedFiles,
} from "../setupHandlers/controllers/pinnedContextController";

export function clearSelectedFileState(
  pinnedFileKeys: Map<number, Set<string>>,
  itemId: number,
): void {
  composeContextStore.files.delete(itemId);
  composeContextStore.filePreviewExpanded.delete(itemId);
  clearPinnedContextOwner(pinnedFileKeys, itemId);
}

export function retainPinnedFileState(
  pinnedFileKeys: Map<number, Set<string>>,
  itemId: number,
): void {
  const retained = retainPinnedFiles(
    pinnedFileKeys,
    itemId,
    composeContextStore.files.list(itemId),
  );
  if (retained.length) {
    composeContextStore.files.set(itemId, retained);
    return;
  }
  composeContextStore.files.delete(itemId);
  composeContextStore.filePreviewExpanded.delete(itemId);
}

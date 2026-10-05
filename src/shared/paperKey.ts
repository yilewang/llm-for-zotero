/** The ids that identify one paper: its parent item and the attachment read. */
export type PaperKeyRef = { itemId: number; contextItemId: number };

/**
 * One paper's key, `itemId:contextItemId`, with both ids floored. Paper-keyed
 * maps, sets, and cache entries compare this string, so keep its format.
 */
export function paperKey(ref: PaperKeyRef): string {
  return `${Math.floor(ref.itemId)}:${Math.floor(ref.contextItemId)}`;
}

/**
 * A paper's key inside one conversation owner: `ownerItemId:itemId:contextItemId`.
 * The owner id is written as given, not floored.
 */
export function ownerScopedPaperKey(
  ownerItemId: number,
  ref: PaperKeyRef,
): string {
  return `${ownerItemId}:${paperKey(ref)}`;
}

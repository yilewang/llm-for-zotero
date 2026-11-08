/**
 * The sort keys a library listing accepts, and the one comparison every
 * listing path shares (the index snapshot path and the in-memory target
 * path), so a key cannot order one path and not the other.
 */

export type LibrarySortKey =
  | "dateAdded"
  | "dateModified"
  | "title"
  | "year"
  | "creator";
export type LibrarySortOrder = "asc" | "desc";

export const LIBRARY_SORT_KEYS: readonly LibrarySortKey[] = [
  "dateAdded",
  "dateModified",
  "title",
  "year",
  "creator",
];

export function isLibrarySortKey(value: unknown): value is LibrarySortKey {
  return (
    typeof value === "string" &&
    (LIBRARY_SORT_KEYS as readonly string[]).includes(value)
  );
}

/** Text keys default to A-Z; dates and years to newest first. */
function isTextKey(key: LibrarySortKey): boolean {
  return key === "title" || key === "creator";
}

/**
 * Compares two sort values. An empty value sorts last in BOTH directions, so
 * undated or creator-less items never displace real hits; reversing a sorted
 * array would float them to the top of a descending list.
 */
export function compareSortValues(
  key: LibrarySortKey,
  left: string,
  right: string,
  order: unknown,
): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const compared = isTextKey(key)
    ? left.localeCompare(right)
    : left < right
      ? -1
      : left > right
        ? 1
        : 0;
  const descending = isTextKey(key) ? order === "desc" : order !== "asc";
  return descending ? -compared : compared;
}

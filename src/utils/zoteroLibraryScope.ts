function normalizePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

/**
 * Resolves the library Zotero is currently presenting to the user.
 *
 * The selected pane is authoritative. The selected item's library is a
 * compatibility fallback for panes that do not expose getSelectedLibraryID,
 * followed by the personal library when no pane is available.
 */
export function resolveActiveLibraryID(): number | null {
  try {
    const pane = Zotero.getActiveZoteroPane?.() as
      | {
          getSelectedLibraryID?: () => unknown;
          getSelectedItems?: () => Zotero.Item[];
        }
      | undefined;
    const selectedLibraryID = normalizePositiveInt(
      pane?.getSelectedLibraryID?.(),
    );
    if (selectedLibraryID) return selectedLibraryID;
    const selectedItems = pane?.getSelectedItems?.() || [];
    const firstItemLibrary = normalizePositiveInt(selectedItems[0]?.libraryID);
    if (firstItemLibrary) return firstItemLibrary;
  } catch (_err) {
    void _err;
  }

  return normalizePositiveInt(
    (Zotero as unknown as { Libraries?: { userLibraryID?: unknown } }).Libraries
      ?.userLibraryID,
  );
}

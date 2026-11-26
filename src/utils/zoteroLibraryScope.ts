import { positiveIntOrNull } from "../core/values";

/**
 * Resolves the library Zotero is currently presenting to the user.
 *
 * The selected pane is authoritative. Use the first selected library in
 * sidebar order because callers require a single library. Older Zotero
 * versions expose only getSelectedLibraryID. Fall back to the selected
 * item's library, then the personal library, when no selection is available.
 */
export function resolveActiveLibraryID(): number | null {
  try {
    const pane = Zotero.getActiveZoteroPane?.() as
      | {
          getSelectedLibraryIDs?: () => unknown[];
          getSelectedLibraryID?: () => unknown;
          getSelectedItems?: () => Zotero.Item[];
        }
      | undefined;
    const selectedLibraryID = positiveIntOrNull(
      typeof pane?.getSelectedLibraryIDs === "function"
        ? pane.getSelectedLibraryIDs()[0]
        : pane?.getSelectedLibraryID?.(),
    );
    if (selectedLibraryID) return selectedLibraryID;
    const selectedItems = pane?.getSelectedItems?.() || [];
    const firstItemLibrary = positiveIntOrNull(selectedItems[0]?.libraryID);
    if (firstItemLibrary) return firstItemLibrary;
  } catch (_err) {
    void _err;
  }

  return positiveIntOrNull(
    (Zotero as unknown as { Libraries?: { userLibraryID?: unknown } }).Libraries
      ?.userLibraryID,
  );
}

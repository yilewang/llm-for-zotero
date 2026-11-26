/**
 * The declared object model for the Zotero library, and what may be done to
 * each kind of object.
 *
 * Before this module the ontology was implicit and wrong: `resolveRegularItem`
 * (14 lines, module-private) returned `null` for notes and annotations and
 * silently substituted the **parent** for a child attachment. It governed the
 * tag, collection-membership and metadata write paths, so "file this note
 * into a folder" reported "Item not found" for an item that plainly existed,
 * and "tag this attachment" tagged a different object entirely.
 *
 * The rule here is that every (operation x object kind) pair has exactly two
 * legal answers — allowed, or refused with a specific reason. Never a silent
 * redirect, never a fabricated count. A pair nobody declared is reported as
 * *unmodelled*, which reads as an omission to be fixed rather than a policy
 * decision, and routes to `zotero_script`.
 *
 * Deviation from the plan worth recording: the plan listed stored / linked /
 * imported-URL attachments as separate kinds. They are folded into
 * `standaloneAttachment` / `childAttachment` here, because for every
 * operation in this matrix the answer turns on whether the object is
 * top-level, not on how its file is stored. The storage mode matters for
 * relinking, which lives under `update` and is enforced by the attachment
 * tool itself.
 */

export type LibraryObjectKind =
  | "regularItem"
  | "standaloneNote"
  | "childNote"
  | "standaloneAttachment"
  | "childAttachment"
  | "annotation"
  | "collection"
  | "savedSearch"
  | "tag"
  | "library";

export type LibraryOperation =
  | "create"
  | "read"
  | "update"
  | "trash"
  | "restore"
  | "delete"
  | "addToCollection"
  | "removeFromCollection"
  | "relate"
  | "reparent";

export type CapabilityVerdict =
  | { status: "allowed" }
  | { status: "refused"; reason: string }
  /**
   * Zotero permits this, but no typed tool performs it yet.
   *
   * Previously such cells were marked `allowed`, which made the table a
   * statement of intent rather than of fact — 82 of 100 cells were never
   * consulted at runtime, so nothing caught the difference. Splitting this
   * out keeps `allowed` for the cells a typed tool performs today.
   */
  | { status: "unimplemented"; reason: string }
  /** Declared nowhere. Not a refusal — a gap, routed to the escape hatch. */
  | { status: "unmodelled"; reason: string };

/** Shorthand used to keep the table below readable. */
const A: CapabilityVerdict = { status: "allowed" };
const no = (reason: string): CapabilityVerdict => ({
  status: "refused",
  reason,
});

/**
 * Reasons that state a Zotero data-model fact rather than a plugin
 * limitation. These will not change no matter how much of the plan ships.
 */
const CHILD_NOT_TOP_LEVEL =
  "Zotero collections hold top-level items only; file the parent item instead";
const ANNOTATION_INSIDE_ATTACHMENT =
  "Annotations live inside an attachment and cannot be filed or reparented";
const NOT_AN_ITEM = (kind: string) =>
  `${kind} is not a library item, so item operations do not apply to it`;

type Row = Partial<Record<LibraryOperation, CapabilityVerdict>>;

const MATRIX: Record<LibraryObjectKind, Row> = {
  regularItem: {
    create: A,
    read: A,
    update: A,
    trash: A,
    restore: A,
    delete: no("Permanent erase is not offered; trash the item instead"),
    addToCollection: A,
    removeFromCollection: A,
    relate: A,
    reparent: no("A regular item is already top-level"),
  },
  standaloneNote: {
    create: A,
    read: A,
    update: A,
    trash: A,
    restore: A,
    delete: no("Permanent erase is not offered; trash the note instead"),
    // This is the capability issue #374 was really about.
    addToCollection: A,
    removeFromCollection: A,
    relate: A,
    reparent: A,
  },
  childNote: {
    create: A,
    read: A,
    update: A,
    trash: A,
    restore: A,
    delete: no("Permanent erase is not offered; trash the note instead"),
    addToCollection: no(CHILD_NOT_TOP_LEVEL),
    removeFromCollection: no(CHILD_NOT_TOP_LEVEL),
    relate: A,
    reparent: A,
  },
  standaloneAttachment: {
    create: A,
    read: A,
    update: A,
    trash: A,
    restore: A,
    delete: no("Permanent erase is not offered; trash the attachment instead"),
    addToCollection: A,
    removeFromCollection: A,
    relate: A,
    reparent: A,
  },
  childAttachment: {
    create: A,
    read: A,
    // Zotero attachments carry their own tags; the old filter redirected
    // these writes to the parent, which is a wrong-object write, not a
    // limitation.
    update: A,
    trash: A,
    restore: A,
    delete: no("Permanent erase is not offered; trash the attachment instead"),
    addToCollection: no(CHILD_NOT_TOP_LEVEL),
    removeFromCollection: no(CHILD_NOT_TOP_LEVEL),
    relate: A,
    reparent: A,
  },
  annotation: {
    create: A,
    read: A,
    // library_update kind:'annotation' edits an annotation's comment and
    // colour, and kind:'tags' tags it. Its position is not editable by any
    // tool; this matrix is per-kind rather than per-field.
    update: A,
    trash: A,
    restore: A,
    delete: no("Permanent erase is not offered; trash the annotation instead"),
    addToCollection: no(ANNOTATION_INSIDE_ATTACHMENT),
    removeFromCollection: no(ANNOTATION_INSIDE_ATTACHMENT),
    relate: no("Annotations cannot participate in item relations"),
    reparent: no(ANNOTATION_INSIDE_ATTACHMENT),
  },
  collection: {
    create: A,
    read: A,
    update: A,
    // Zotero has had a collection trash since `deletedCollections`; its own
    // "Delete Collection" sets `deleted = true` and the Trash pane restores
    // it. This previously claimed the opposite and erased instead.
    trash: A,
    restore: A,
    // Permanent erase, behind an explicit `permanent` flag. It has no
    // inverse, so it records no undo.
    delete: A,
    addToCollection: no(NOT_AN_ITEM("A collection")),
    removeFromCollection: no(NOT_AN_ITEM("A collection")),
    relate: no(NOT_AN_ITEM("A collection")),
    reparent: A,
  },
  savedSearch: {
    create: A,
    read: A,
    update: A,
    // Saved searches have `deletedSearches`, the same as collections.
    trash: A,
    restore: A,
    delete: A,
    addToCollection: no(NOT_AN_ITEM("A saved search")),
    removeFromCollection: no(NOT_AN_ITEM("A saved search")),
    relate: no(NOT_AN_ITEM("A saved search")),
    reparent: no("Saved searches are not nested"),
  },
  tag: {
    // Creating a tag means putting it on an item, which library_update does.
    create: A,
    read: A,
    update: A,
    trash: no("Zotero has no trash for tags"),
    restore: no("Zotero has no trash for tags"),
    delete: A,
    addToCollection: no(NOT_AN_ITEM("A tag")),
    removeFromCollection: no(NOT_AN_ITEM("A tag")),
    relate: no(NOT_AN_ITEM("A tag")),
    reparent: no("Tags are not nested"),
  },
  library: {
    create: no("Creating a library is a zotero.org operation, not a local one"),
    read: A,
    update: no("Library settings are not editable from the plugin"),
    trash: no("Libraries cannot be trashed"),
    restore: no("Libraries cannot be trashed"),
    delete: no("Deleting a library is a zotero.org operation"),
    addToCollection: no(NOT_AN_ITEM("A library")),
    removeFromCollection: no(NOT_AN_ITEM("A library")),
    relate: no(NOT_AN_ITEM("A library")),
    reparent: no("Libraries are not nested"),
  },
};

export function checkCapability(
  operation: LibraryOperation,
  kind: LibraryObjectKind,
): CapabilityVerdict {
  const verdict = MATRIX[kind]?.[operation];
  if (verdict) return verdict;
  return {
    status: "unmodelled",
    reason: `"${operation}" on ${kind} is not declared in the capability matrix. Use zotero_script if the Zotero API supports it.`,
  };
}

/**
 * Maps a live Zotero item onto the declared model.
 *
 * Returns `null` only for things that are not items at all. Note the ordering:
 * annotations are checked before attachments because an annotation reports a
 * parent, and notes and attachments are split by whether they are top-level,
 * because that is what collection membership turns on.
 */
export function classifyLibraryItem(
  item: Zotero.Item | null | undefined,
): LibraryObjectKind | null {
  if (!item) return null;
  try {
    if (item.isAnnotation?.()) return "annotation";
    const hasParent = Boolean((item as { parentID?: unknown }).parentID);
    if (item.isNote?.()) return hasParent ? "childNote" : "standaloneNote";
    if (item.isAttachment?.()) {
      return hasParent ? "childAttachment" : "standaloneAttachment";
    }
    if (item.isRegularItem?.()) return "regularItem";
  } catch {
    return null;
  }
  return null;
}

/**
 * Convenience for write paths: classify, then check, and return a reason
 * string when the operation may not proceed. `null` means "go ahead".
 */
export function refusalFor(
  operation: LibraryOperation,
  item: Zotero.Item | null | undefined,
  itemId?: number,
): string | null {
  if (!item) {
    return itemId
      ? `No item with ID ${itemId} exists in this library`
      : "The target item could not be resolved";
  }
  const kind = classifyLibraryItem(item);
  if (!kind) {
    return (
      `Item ${itemId ?? ""}`.trim() +
      " is not a kind of object this operation understands"
    );
  }
  const verdict = checkCapability(operation, kind);
  if (verdict.status === "allowed") return null;
  return verdict.reason;
}

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

export const LIBRARY_OBJECT_KINDS: readonly LibraryObjectKind[] = [
  "regularItem",
  "standaloneNote",
  "childNote",
  "standaloneAttachment",
  "childAttachment",
  "annotation",
  "collection",
  "savedSearch",
  "tag",
  "library",
];

export const LIBRARY_OPERATIONS: readonly LibraryOperation[] = [
  "create",
  "read",
  "update",
  "trash",
  "restore",
  "delete",
  "addToCollection",
  "removeFromCollection",
  "relate",
  "reparent",
];

export type CapabilityVerdict =
  | { status: "allowed" }
  | { status: "refused"; reason: string }
  /**
   * Zotero permits this, but no typed tool performs it yet.
   *
   * Previously such cells were marked `allowed`, which made the table a
   * statement of intent rather than of fact — 82 of 100 cells were never
   * consulted at runtime, so nothing caught the difference. Splitting this
   * out is what lets `allowed` be checkable: every allowed cell must name
   * the tool that implements it (see `IMPLEMENTED_BY`).
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
/** Zotero can do it; the agent has no typed path yet. */
const todo = (reason: string): CapabilityVerdict => ({
  status: "unimplemented",
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
    // Tagging an annotation goes through library_update, so `update` is
    // genuinely implemented. Editing an annotation's own comment, colour or
    // position is not exposed by any tool yet -- that is tracked in the
    // capability census, not here, because this matrix is per-kind rather
    // than per-field.
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

/**
 * The tool that performs each allowed operation.
 *
 * This exists so `allowed` is a checkable claim rather than an aspiration.
 * The matrix previously marked capabilities allowed that no tool implemented
 * — note reparent, item relations, saved-search CRUD, collection rename, tag
 * rename — and nothing noticed, because `refusalFor` has one call site
 * reached with three operations, so 82 of 100 cells were never consulted at
 * runtime. The completeness test certified the table was *total* while
 * checking nothing about whether the cells were true.
 *
 * The accompanying test asserts that every `allowed` cell appears here and
 * names a tool the registry actually exposes, so flipping a cell to `A`
 * without wiring it up fails.
 */
export const IMPLEMENTED_BY: Partial<
  Record<`${LibraryObjectKind}:${LibraryOperation}`, string>
> = {
  "regularItem:create": "library_import",
  "regularItem:read": "library_read",
  "regularItem:update": "library_update",
  "regularItem:trash": "library_delete",
  "regularItem:restore": "library_delete",
  "regularItem:addToCollection": "library_update",
  "regularItem:removeFromCollection": "library_update",
  "regularItem:relate": "library_update",

  "standaloneNote:create": "note_write",
  "standaloneNote:read": "library_read",
  "standaloneNote:update": "note_write",
  "standaloneNote:trash": "library_delete",
  "standaloneNote:restore": "library_delete",
  "standaloneNote:addToCollection": "library_update",
  "standaloneNote:removeFromCollection": "library_update",
  "standaloneNote:relate": "library_update",
  "standaloneNote:reparent": "library_update",

  "childNote:create": "note_write",
  "childNote:read": "library_read",
  "childNote:update": "note_write",
  "childNote:trash": "library_delete",
  "childNote:restore": "library_delete",
  "childNote:relate": "library_update",
  "childNote:reparent": "library_update",

  "standaloneAttachment:create": "library_import",
  "standaloneAttachment:read": "library_read",
  "standaloneAttachment:update": "attachment_update",
  "standaloneAttachment:trash": "library_delete",
  "standaloneAttachment:restore": "library_delete",
  "standaloneAttachment:addToCollection": "library_update",
  "standaloneAttachment:removeFromCollection": "library_update",
  "standaloneAttachment:relate": "library_update",
  "standaloneAttachment:reparent": "library_update",

  "childAttachment:create": "library_import",
  "childAttachment:read": "library_read",
  "childAttachment:update": "attachment_update",
  "childAttachment:trash": "library_delete",
  "childAttachment:restore": "library_delete",
  "childAttachment:relate": "library_update",
  "childAttachment:reparent": "library_update",

  "annotation:create": "annotate_pdf",
  "annotation:read": "library_read",
  "annotation:update": "library_update",
  "annotation:trash": "library_delete",
  "annotation:restore": "library_delete",

  "collection:create": "collection_update",
  "collection:update": "collection_update",
  "collection:reparent": "collection_update",
  "collection:read": "library_search",
  "collection:trash": "collection_update",
  "collection:restore": "library_delete",
  "collection:delete": "collection_update",

  "savedSearch:create": "saved_search_update",
  "savedSearch:read": "library_search",
  "savedSearch:update": "saved_search_update",
  "savedSearch:trash": "saved_search_update",
  "savedSearch:restore": "library_delete",
  "savedSearch:delete": "saved_search_update",

  "tag:create": "library_update",
  "tag:read": "library_search",
  "tag:update": "library_update",
  "tag:delete": "library_update",

  "library:read": "library_search",
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

export function isAllowed(
  operation: LibraryOperation,
  kind: LibraryObjectKind,
): boolean {
  return checkCapability(operation, kind).status === "allowed";
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

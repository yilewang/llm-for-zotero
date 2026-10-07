import type {
  AgentActionCapability,
  AgentActionOperation,
  AgentActionProofDomain,
} from "./types";

export type OperationCatalogEntry = Readonly<{
  capability: AgentActionCapability;
  proofDomain: AgentActionProofDomain;
}>;

/**
 * Single authority for the operation/capability/proof-domain triple used by
 * intent decoding, proposals, contracts, and receipts. `satisfies Record`
 * makes a new operation a compile-time error until its authority is defined.
 */
export const OPERATION_CATALOG = {
  update_metadata: {
    capability: "zotero.metadata",
    proofDomain: "zotero_state",
  },
  apply_tags: { capability: "zotero.tags", proofDomain: "zotero_state" },
  remove_tags: { capability: "zotero.tags", proofDomain: "zotero_state" },
  move_to_collection: {
    capability: "zotero.collections",
    proofDomain: "zotero_state",
  },
  remove_from_collection: {
    capability: "zotero.collections",
    proofDomain: "zotero_state",
  },
  create_collection: {
    capability: "zotero.collections",
    proofDomain: "zotero_state",
  },
  set_item_collections: {
    capability: "zotero.collections",
    proofDomain: "zotero_state",
  },
  save_notes_batch: { capability: "zotero.notes", proofDomain: "zotero_state" },
  save_saved_search: {
    capability: "zotero.collections",
    proofDomain: "zotero_state",
  },
  delete_saved_search: {
    capability: "zotero.collections",
    proofDomain: "zotero_state",
  },
  update_collection: {
    capability: "zotero.collections",
    proofDomain: "zotero_state",
  },
  update_library_tag: {
    capability: "zotero.tags",
    proofDomain: "zotero_state",
  },
  set_item_tags: { capability: "zotero.tags", proofDomain: "zotero_state" },
  create_items: { capability: "zotero.import", proofDomain: "zotero_state" },
  reparent_items: {
    capability: "zotero.metadata",
    proofDomain: "zotero_state",
  },
  relate_items: { capability: "zotero.metadata", proofDomain: "zotero_state" },
  delete_collection: {
    capability: "zotero.collections",
    proofDomain: "zotero_state",
  },
  save_note: { capability: "zotero.notes", proofDomain: "zotero_state" },
  import_identifiers: {
    capability: "zotero.import",
    proofDomain: "zotero_state",
  },
  trash_items: { capability: "zotero.trash", proofDomain: "zotero_state" },
  restore_from_trash: {
    capability: "zotero.trash",
    proofDomain: "zotero_state",
  },
  merge_items: { capability: "zotero.trash", proofDomain: "zotero_state" },
  delete_attachment: {
    capability: "zotero.attachments",
    proofDomain: "zotero_state",
  },
  rename_attachment: {
    capability: "zotero.attachments",
    proofDomain: "zotero_state",
  },
  relink_attachment: {
    capability: "zotero.attachments",
    proofDomain: "zotero_state",
  },
  import_local_files: {
    capability: "zotero.import",
    proofDomain: "zotero_state",
  },
  note_create: { capability: "zotero.notes", proofDomain: "zotero_state" },
  note_edit: { capability: "zotero.notes", proofDomain: "zotero_state" },
  note_append: { capability: "zotero.notes", proofDomain: "zotero_state" },
  annotation_write: {
    capability: "zotero.annotations",
    proofDomain: "zotero_state",
  },
  settings_update: {
    capability: "zotero.settings",
    proofDomain: "zotero_state",
  },
  undo: { capability: "zotero.undo", proofDomain: "zotero_state" },
  revert: { capability: "zotero.undo", proofDomain: "zotero_state" },
  file_write: { capability: "file.write", proofDomain: "file_state" },
  command_execute: { capability: "command.execute", proofDomain: "execution" },
  zotero_script_execute: {
    capability: "zotero.script",
    proofDomain: "execution",
  },
  read_full: { capability: "zotero.read", proofDomain: "zotero_state" },
} as const satisfies Record<AgentActionOperation, OperationCatalogEntry>;

export const ACTION_CAPABILITIES = new Set<AgentActionCapability>(
  Object.values(OPERATION_CATALOG).map((entry) => entry.capability),
);

/**
 * What each operation is called where a person reads it.
 *
 * A receipt states the operation it carried out, and that is the only name of
 * the work that survives the run: the tool that performed it may be renamed,
 * may perform several operations, or may not exist in the build replaying the
 * trace. So the reader's words live beside the operation's authority rather
 * than in the panel, and they are past tense because a receipt reports work
 * that has already happened. `satisfies Record` keeps a new operation a
 * compile error until it has been given words.
 */
export const OPERATION_LABELS = {
  update_metadata: "Updated metadata",
  apply_tags: "Added tags",
  remove_tags: "Removed tags",
  move_to_collection: "Moved to collection",
  remove_from_collection: "Removed from collection",
  create_collection: "Created collection",
  set_item_collections: "Set collections",
  save_notes_batch: "Saved notes",
  save_saved_search: "Saved search",
  delete_saved_search: "Deleted saved search",
  update_collection: "Updated collection",
  update_library_tag: "Updated library tag",
  set_item_tags: "Set tags",
  create_items: "Created items",
  reparent_items: "Reparented items",
  relate_items: "Related items",
  delete_collection: "Deleted collection",
  save_note: "Saved note",
  import_identifiers: "Imported identifiers",
  trash_items: "Moved to trash",
  restore_from_trash: "Restored from trash",
  merge_items: "Merged items",
  delete_attachment: "Deleted attachment",
  rename_attachment: "Renamed attachment",
  relink_attachment: "Relinked attachment",
  import_local_files: "Imported local files",
  note_create: "Created note",
  note_edit: "Edited note",
  note_append: "Appended to note",
  annotation_write: "Wrote annotation",
  settings_update: "Updated settings",
  undo: "Undid change",
  revert: "Reverted change",
  file_write: "Wrote file",
  command_execute: "Ran command",
  zotero_script_execute: "Ran Zotero script",
  read_full: "Read full text",
} as const satisfies Record<AgentActionOperation, string>;

/**
 * The reader's name for an operation, including one this build does not know.
 *
 * Receipts are journaled and replayed, so a trace can name an operation that
 * has since been removed from the catalog. Such a receipt still states what it
 * did, and spelling its own token out plainly says more than dropping the line
 * or calling it unknown.
 */
export function operationLabel(operation: string): string {
  const known = operationCatalogEntry(operation);
  if (known) return OPERATION_LABELS[known.operation];
  const words = operation.replace(/[_-]+/gu, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Action";
}

/**
 * What one receipt did, in the reader's words.
 *
 * A collection operation adds an item to its destination by default.
 * A move also names the collection that the item leaves.
 * Calling an add "Moved to collection" told the reader, and the model
 * reading its own trace, that the paper had left its old folder.
 */
export function receiptOperationLabel(receipt: {
  operation: string;
  normalizedParameters?: { sourceCollectionId?: number | "all" };
}): string {
  if (collectionAddOnly(receipt)) return "Added to collection";
  return operationLabel(receipt.operation);
}

/** Whether a collection receipt added items without moving them. */
export function collectionAddOnly(receipt: {
  operation: string;
  normalizedParameters?: { sourceCollectionId?: number | "all" };
}): boolean {
  return (
    receipt.operation === "move_to_collection" &&
    receipt.normalizedParameters?.sourceCollectionId === undefined
  );
}

export function operationCatalogEntry(
  operation: string,
): (OperationCatalogEntry & { operation: AgentActionOperation }) | null {
  if (!Object.prototype.hasOwnProperty.call(OPERATION_CATALOG, operation)) {
    return null;
  }
  return {
    operation: operation as AgentActionOperation,
    ...OPERATION_CATALOG[operation as AgentActionOperation],
  };
}

export function operationAuthorityIsConsistent(params: {
  operation: string;
  capability: AgentActionCapability;
  proofDomain: AgentActionProofDomain;
}): boolean {
  const entry = operationCatalogEntry(params.operation);
  return Boolean(
    entry &&
    entry.capability === params.capability &&
    entry.proofDomain === params.proofDomain,
  );
}

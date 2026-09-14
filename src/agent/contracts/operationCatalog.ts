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

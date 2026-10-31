import type { AgentActionOperation } from "../../../agent/contracts/types";
import type { ActionCardVerb } from "../../../agent/types";
import { operationCatalogEntry } from "../../../agent/contracts/operationCatalog";

/**
 * How the action card draws an operation, declared beside the card type in
 * `agent/types` so the runtime layer never has to reach into the panel.
 *
 * The reader-facing word is not part of it. `operationLabel()` in the
 * operation catalog is the single vocabulary for naming an operation to a
 * person, and the renderer takes the card's tooltip from it; a second table of
 * words beside the renderer would only drift from the catalog's.
 *
 * A glyph is used only where it says something the object chip cannot: moving
 * (→), adding (+), removing (−), restoring (↺), running (›). Note, file and
 * metadata effects show their chip alone.
 */
export type { ActionCardVerb };

export const OPERATION_VERBS = {
  update_metadata: {},
  change_item_type: {},
  apply_tags: { glyph: "+" },
  remove_tags: { glyph: "−", destructive: true },
  move_to_collection: { glyph: "→" },
  remove_from_collection: { glyph: "−", destructive: true },
  create_collection: { glyph: "+" },
  set_item_collections: { glyph: "→" },
  save_notes_batch: {},
  save_saved_search: { glyph: "+" },
  delete_saved_search: { glyph: "−", destructive: true },
  update_collection: {},
  update_library_tag: {},
  set_item_tags: { glyph: "+" },
  create_items: { glyph: "+" },
  reparent_items: { glyph: "→" },
  relate_items: { glyph: "→" },
  delete_collection: { glyph: "−", destructive: true },
  save_note: {},
  import_identifiers: { glyph: "+" },
  trash_items: { glyph: "→", destructive: true },
  restore_from_trash: { glyph: "↺" },
  merge_items: { glyph: "→" },
  delete_attachment: { glyph: "−", destructive: true },
  rename_attachment: {},
  relink_attachment: { glyph: "→" },
  import_local_files: { glyph: "+" },
  attach_file: { glyph: "+" },
  attach_url: { glyph: "+" },
  find_pdf: { glyph: "+" },
  update_annotation: {},
  note_create: {},
  note_edit: {},
  note_append: {},
  annotation_write: {},
  settings_update: {},
  undo: { glyph: "↺" },
  revert: { glyph: "↺" },
  file_write: {},
  command_execute: { glyph: "›" },
  zotero_script_execute: { glyph: "›" },
  read_full: {},
} as const satisfies Record<AgentActionOperation, ActionCardVerb>;

/**
 * The glyph for an operation. An operation this build no longer knows gets no
 * glyph, and the card falls back to the catalog's spelling of its token.
 */
export function operationVerb(operation: string): ActionCardVerb {
  const known = operationCatalogEntry(operation);
  return known ? OPERATION_VERBS[known.operation] : {};
}

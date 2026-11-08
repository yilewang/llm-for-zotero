import type {
  GeneratedChatImage,
  PaperContextRef,
} from "../../../shared/types";
import type { NativeNoteVerification } from "../../../services/notePersistence";
import type {
  BatchTagAssignment,
  EditableArticleCreator,
  EditableArticleMetadataPatch,
  EditableArticleMetadataSnapshot,
  ItemTypeRecord,
} from "./valueTypes";

type LibraryMutationEffect = "applied" | "partial" | "none";

export type NoteSaveTarget = "item" | "standalone";

export type UpdateMetadataOperation = {
  id?: string;
  type: "update_metadata";
  itemId?: number;
  paperContext?: PaperContextRef;
  metadata: EditableArticleMetadataPatch;
};

/**
 * Changes a regular item's type. Zotero drops the fields the new type lacks,
 * so planning names them and the undo restores the exact prior record.
 */
export type ChangeItemTypeOperation = {
  id?: string;
  type: "change_item_type";
  itemId: number;
  itemType: string;
  /** Set at planning: the fields the approved change drops. */
  droppedFields?: string[];
  /** Set at planning: the creators after Zotero remaps their types. */
  expectedCreators?: EditableArticleCreator[];
  /** Set at planning: the fields that keep a value, as Zotero moves them. */
  expectedFields?: Record<string, string>;
  /** Undo only: the exact fields and creators to put back with the type. */
  restore?: Omit<ItemTypeRecord, "itemType">;
};

export type ApplyTagsOperation = {
  id?: string;
  type: "apply_tags";
  assignments?: BatchTagAssignment[];
  itemIds?: number[];
  tags?: string[];
};

export type RemoveTagsOperation = {
  id?: string;
  type: "remove_tags";
  itemIds: number[];
  tags: string[];
};

export type MoveToCollectionAssignment = {
  itemId: number;
  targetCollectionId?: number;
  targetCollectionName?: string;
  targetCollectionPath?: string;
};

export type MoveToCollectionOperation = {
  id?: string;
  type: "move_to_collection";
  assignments?: MoveToCollectionAssignment[];
  itemIds?: number[];
  targetCollectionId?: number;
  targetCollectionName?: string;
  targetCollectionPath?: string;
  /**
   * `"add"` (the default) files the item and leaves its other collections
   * alone. `"move"` takes it out of `from` as well — until this existed, the
   * tool said "moved" while only ever adding.
   */
  mode?: "add" | "move";
  /** Required for a move: the collection to leave, or `"all"`. */
  from?: number | "all";
};

/**
 * Restores exact collection membership.
 *
 * A move's only correct inverse is the set the item had beforehand.
 * `remove_from_collection` cannot express it: undoing a move with a removal
 * would unfile the item from the destination and never put back the
 * collections the move took it out of.
 */
/**
 * Writes a note onto each of many items in one approved operation.
 *
 * `save_note` takes a single `targetItemId`, so "write a summary note on each
 * of my 50 most recent papers" was 50 tool calls and — because every
 * `note_write mode:'create'` returns its own review card — 50 human
 * approvals. That, not the round budget, is what made the request
 * impractical.
 */
export type SaveSavedSearchOperation = {
  id?: string;
  type: "save_saved_search";
  name: string;
  conditions: Array<{
    condition: string;
    operator: string;
    value?: string | number;
    mode?: string;
    required?: boolean;
  }>;
  joinMode?: "all" | "any";
  savedSearchId?: number;
  libraryID?: number;
};

export type DeleteSavedSearchOperation = {
  id?: string;
  type: "delete_saved_search";
  savedSearchId: number;
  permanent?: boolean;
};

export type UpdateCollectionOperation = {
  id?: string;
  type: "update_collection";
  collectionId: number;
  name?: string;
  /** `null` promotes the collection to top level. */
  parentCollectionId?: number | null;
};

export type UpdateLibraryTagOperation = {
  id?: string;
  type: "update_library_tag";
  action: "rename" | "delete" | "merge" | "setColor";
  tag: string;
  newTag?: string;
  color?: string;
  position?: number;
  libraryID?: number;
};

/**
 * Replaces each item's tags with exactly the given set.
 *
 * The add-only path is why "give my library exactly these 20 tags" drifted:
 * each batch added its own and nothing removed a previous batch's choices.
 */
export type SetItemTagsOperation = {
  id?: string;
  type: "set_item_tags";
  assignments: Array<{ itemId: number; tags: string[] }>;
};

export type SaveNotesBatchOperation = {
  id?: string;
  type: "save_notes_batch";
  /** 'append' adds each body to an existing note instead of creating one. */
  mode?: "create" | "append";
  notes: Array<{
    /** The item the note is written onto; for an append, the note itself. */
    targetItemId: number;
    /** For an append: the note the body is appended to. */
    targetNoteId?: number;
    content: string;
    collections?: number[];
  }>;
  target?: "item" | "standalone";
  modelName?: string;
};

export type CreateItemsOperation = {
  id?: string;
  type: "create_items";
  libraryID?: number;
  items: Array<{
    itemType: string;
    fields?: Record<string, string>;
    creators?: Array<{
      creatorType: string;
      firstName?: string;
      lastName?: string;
      name?: string;
    }>;
    tags?: string[];
    collections?: number[];
  }>;
};

export type ReparentItemsOperation = {
  id?: string;
  type: "reparent_items";
  assignments: Array<{ itemId: number; parentItemId: number | null }>;
};

export type RelateItemsOperation = {
  id?: string;
  type: "relate_items";
  itemId: number;
  relatedItemIds: number[];
  action: "add" | "remove";
};

export type SetItemCollectionsOperation = {
  id?: string;
  type: "set_item_collections";
  assignments: Array<{ itemId: number; collectionIds: number[] }>;
};

export type RemoveFromCollectionOperation = {
  id?: string;
  type: "remove_from_collection";
  itemIds: number[];
  collectionId: number;
};

export type CreateCollectionOperation = {
  id?: string;
  type: "create_collection";
  name: string;
  parentCollectionId?: number;
  libraryID?: number;
};

export type DeleteCollectionOperation = {
  id?: string;
  type: "delete_collection";
  collectionId: number;
  /**
   * Trash the collection's items too. Off by default, matching Zotero, whose
   * "Delete Collection" leaves items in the library and offers "Delete
   * Collection and Items" as a separate command.
   */
  deleteItems?: boolean;
  /**
   * Erase instead of trashing. Irreversible, so it records no undo.
   */
  permanent?: boolean;
};

export type SaveNoteOperation = {
  id?: string;
  type: "save_note";
  content: string;
  target?: NoteSaveTarget;
  targetItemId?: number;
  modelName?: string;
  appendToTrackedNote?: boolean;
  generatedImages?: GeneratedChatImage[];
  /**
   * Collections to file a standalone note into. Only standalone notes can be
   * collection members — a child note belongs to its parent item, and Zotero
   * collections hold top-level items only.
   */
  collections?: number[];
};

export type TrashItemsOperation = {
  id?: string;
  type: "trash_items";
  itemIds: number[];
};

/**
 * Brings items, collections or saved searches back out of the Zotero trash.
 *
 * Restoring was previously reachable only as the inverse of an action the
 * agent itself had just taken, so anything the *user* trashed — or anything
 * trashed in an earlier session — was unreachable.
 */
export type RestoreFromTrashOperation = {
  id?: string;
  type: "restore_from_trash";
  itemIds?: number[];
  collectionIds?: number[];
  savedSearchIds?: number[];
};

export type MergeItemsOperation = {
  id?: string;
  type: "merge_items";
  masterItemId: number;
  otherItemIds: number[];
};

export type DeleteAttachmentOperation = {
  id?: string;
  type: "delete_attachment";
  attachmentId: number;
};

export type RenameAttachmentOperation = {
  id?: string;
  type: "rename_attachment";
  attachmentId: number;
  newName: string;
};

export type RelinkAttachmentOperation = {
  id?: string;
  type: "relink_attachment";
  attachmentId: number;
  newPath: string;
};

/** Attaches a local file to a regular item, as a stored copy or a link. */
export type AttachFileOperation = {
  id?: string;
  type: "attach_file";
  parentItemId: number;
  filePath: string;
  /** Link to the file where it is instead of copying it into Zotero. */
  link?: boolean;
};

/**
 * Saves a web page to a regular item twice: a link to the URL and a stored
 * snapshot of the page, the two attachments the user asked for.
 */
export type AttachUrlOperation = {
  id?: string;
  type: "attach_url";
  parentItemId: number;
  url: string;
};

/**
 * Runs Zotero's own Find Available PDF for one item. Finding nothing is an
 * answer, not a failure: the item keeps the attachments it had.
 */
export type FindPdfOperation = {
  id?: string;
  type: "find_pdf";
  itemId: number;
};

/** Edits an annotation's comment or color; the undo puts the old ones back. */
export type UpdateAnnotationOperation = {
  id?: string;
  type: "update_annotation";
  annotationId: number;
  comment?: string;
  color?: string;
};

export type ImportLocalFilesOperation = {
  id?: string;
  type: "import_local_files";
  filePaths: string[];
  libraryID?: number;
  targetCollectionId?: number;
  /** See ZoteroGateway.importLocalFiles. */
  mode?: "auto" | "translate" | "attach";
  recognize?: boolean;
};

export type ImportIdentifiersOperation = {
  id?: string;
  type: "import_identifiers";
  identifiers: string[];
  libraryID?: number;
  targetCollectionId?: number;
};

export type LibraryMutationOperation =
  | UpdateMetadataOperation
  | ChangeItemTypeOperation
  | ApplyTagsOperation
  | RemoveTagsOperation
  | MoveToCollectionOperation
  | RemoveFromCollectionOperation
  | CreateCollectionOperation
  | SetItemCollectionsOperation
  | SaveNotesBatchOperation
  | SaveSavedSearchOperation
  | DeleteSavedSearchOperation
  | UpdateCollectionOperation
  | UpdateLibraryTagOperation
  | SetItemTagsOperation
  | CreateItemsOperation
  | ReparentItemsOperation
  | RelateItemsOperation
  | DeleteCollectionOperation
  | SaveNoteOperation
  | ImportIdentifiersOperation
  | TrashItemsOperation
  | RestoreFromTrashOperation
  | MergeItemsOperation
  | DeleteAttachmentOperation
  | RenameAttachmentOperation
  | RelinkAttachmentOperation
  | ImportLocalFilesOperation
  | AttachFileOperation
  | AttachUrlOperation
  | FindPdfOperation
  | UpdateAnnotationOperation;

export type LibraryMutationInverse = {
  description: string;
  inverseOperations?: LibraryMutationOperation[];
  irreversibleReason?: string;
};

export type LibraryMutationExecutionResult = {
  operation: LibraryMutationOperation["type"];
  operationId?: string;
  result: unknown;
};

/**
 * One note a write physically created, with the read-back that proves it.
 *
 * An operation that creates several notes in one step -- the durable note
 * batch is the only one today -- has already forced a native re-read of each
 * note it wrote, and the receipt owner needs that re-read to mint the same
 * per-note content fact a single note write mints. It travels here rather
 * than inside the operation's model-facing result because the read-back
 * carries the note's whole HTML twice: fifty notes would put a hundred note
 * bodies into the model's context to prove something only the contract reads.
 */
export type NativeNoteWriteEvidence = {
  noteId: number;
  /** An append to an existing note; absent for a created note. */
  mode?: "append";
  /** The parent the note was created on; absent for a standalone note. */
  parentItemId?: number;
  /** Collections a standalone note was filed into, when it names any. */
  collections?: number[];
  /** The forced native read-back the creation already performed. */
  verification: NativeNoteVerification;
};

export type LibraryMutationExecution = {
  result: LibraryMutationExecutionResult;
  inverse?: LibraryMutationInverse | null;
  effect: LibraryMutationEffect;
  affectedCount: number;
  /** Per-note read-backs, for an operation that creates notes in bulk. */
  noteWrites?: readonly NativeNoteWriteEvidence[];
};

export type LibraryMutationPlan = {
  effect: "write";
  reversibility: "full" | "partial" | "none";
  reason?: string;
  description: string;
  /** Persisted before the forward write whenever the inverse is knowable. */
  inverseOperations?: LibraryMutationOperation[];
  /** Narrow object state used for audit and conflict-safe replay. */
  precondition?: unknown;
  /** Creation/import IDs are not knowable until Zotero commits. */
  deferredInverse?: boolean;
};

export type MutationItemState = {
  itemId: number;
  exists: boolean;
  version?: number;
  dateModified?: string;
  fields?: Record<string, string>;
  creators?: EditableArticleMetadataSnapshot["creators"];
  /** The item type name, captured for a type change. */
  itemType?: string;
  tags?: string[];
  collectionIds?: number[];
  parentItemId?: number | null;
  deleted?: boolean;
  attachmentPath?: string;
  attachmentTitle?: string;
  /** Zotero's link mode, captured for an attachment an attach created. */
  attachmentLinkMode?: number;
  /** The attachment's URL field, captured with its link mode. */
  attachmentUrl?: string;
  childAttachmentIds?: number[];
  childNoteIds?: number[];
  noteHtml?: string;
  noteHtmlChecksum?: string;
  annotation?: {
    type: string;
    text: string;
    comment: string;
    color: string;
    pageLabel: string;
    sortIndex: string;
    position: unknown;
    tags: string[];
  };
};

export type LibraryMutationState = {
  version: 1;
  operation: LibraryMutationOperation["type"];
  items?: MutationItemState[];
  collections?: Array<{
    collectionId: number;
    exists: boolean;
    name?: string;
    parentCollectionId?: number | null;
    deleted?: boolean;
    directItemIds?: number[];
    childCollectionIds?: number[];
  }>;
  savedSearches?: Array<{
    savedSearchId: number;
    exists: boolean;
    libraryID?: number;
    name?: string;
    deleted?: boolean;
    conditions?: Array<Record<string, unknown>>;
  }>;
  libraryTags?: Array<{
    libraryID: number;
    name: string;
    observable: boolean;
    exists: boolean;
    itemIds: number[];
    color?: string;
    position?: number;
  }>;
  relations?: Array<{
    itemId: number;
    relatedItemId: number;
    related: boolean;
    reciprocal: boolean;
  }>;
};

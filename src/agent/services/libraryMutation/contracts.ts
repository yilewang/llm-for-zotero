import type {
  GeneratedChatImage,
  PaperContextRef,
} from "../../../shared/types";
import type {
  BatchTagAssignment,
  EditableArticleMetadataPatch,
  EditableArticleMetadataSnapshot,
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
  notes: Array<{
    targetItemId: number;
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
  | ImportLocalFilesOperation;

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

export type LibraryMutationExecution = {
  result: LibraryMutationExecutionResult;
  inverse?: LibraryMutationInverse | null;
  effect: LibraryMutationEffect;
  affectedCount: number;
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
  tags?: string[];
  collectionIds?: number[];
  parentItemId?: number | null;
  deleted?: boolean;
  attachmentPath?: string;
  attachmentTitle?: string;
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

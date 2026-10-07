/**
 * The papers that attached papers, folders and tags cover, read from the
 * library index snapshot.
 *
 * One union serves retrieval (`ZoteroGateway.resolveLibraryScopeItemIds`),
 * the Task progress listing (`resolveTaskPaperScopeItemIds`) and the
 * plain-chat planner's tag scopes: explicit papers first, then each folder's
 * direct items (subcollections are not expanded), then each tag's items; only
 * live regular items; papers the user removed from the task left out; each
 * paper once, in first-seen order.
 *
 * This module owns the plugin's one tag rule: a tag is looked up by its
 * display name (else its normalized name), compared in Unicode NFC and
 * without case (`normalizeLibraryIndexTagIdentity`).
 *
 * Pure: reads only the snapshot object it is given.
 */
import type { LibraryIndexItem, LibraryIndexSnapshot } from "./contracts";
import { normalizeLibraryIndexTagIdentity } from "./projection";

/** The snapshot fields the scope union reads. */
export type PaperScopeSnapshot = Pick<
  LibraryIndexSnapshot,
  | "itemById"
  | "topLevelItemOrder"
  | "collectionById"
  | "directItemIdsByCollectionId"
  | "collectionPathById"
  | "tagByNormalizedName"
  | "pdfCapableItemIds"
>;

/** A tag, or the "all tagged" / "untagged" aggregate, as a scope names it. */
export type PaperScopeTag = {
  name: string;
  normalizedName?: string;
  scope?: "allTagged" | "untagged";
  includeAutomatic?: boolean;
};

export type PaperScopeRequest = {
  /** Folders of any other library are skipped. */
  libraryID: number;
  itemIds?: readonly number[];
  collectionIds?: readonly number[];
  tagContexts?: readonly PaperScopeTag[];
  /** Papers the user removed from the task: never part of the scope. */
  excludedItemIds?: readonly number[];
  /**
   * Keep only papers with a PDF whose text the plugin can read. Plain chat
   * asks for this because it answers from extracted PDF text; the agent
   * does not, because it can also read other attachments and metadata.
   */
  pdfOnly?: boolean;
};

export type PaperScope = {
  /** Every paper of the scope, in first-seen order. */
  itemIds: number[];
  /** The scope's papers that came from a tag, in tag order. */
  tagItemIds: number[];
  /** Each known folder of the library, by its path (else its name). */
  collectionNames: string[];
  /** Each tag's name, as given. */
  tagNames: string[];
  /**
   * Papers each folder and tag added, summed: a paper reached by two of them
   * counts twice. Explicit papers are not counted.
   */
  summedScopeCount: number;
};

/**
 * Whether an index item is a paper a scope can hold. Retrieval is
 * bibliographic: standalone notes and files remain available to
 * library_search but are not paper resources.
 */
export function isPaperScopeItem(item: LibraryIndexItem | undefined): boolean {
  return Boolean(item && item.kind === "regular" && !item.deleted);
}

export function indexItemMatchesAggregateTagScope(
  item: LibraryIndexItem,
  scope: "allTagged" | "untagged",
  includeAutomatic: boolean,
): boolean {
  const tagged =
    item.tags.length > 0 || (includeAutomatic && item.automaticTags.length > 0);
  return scope === "allTagged" ? tagged : !tagged;
}

/** The items holding a tag, manual holders first. */
export function libraryIndexTagItemIds(
  snapshot: Pick<LibraryIndexSnapshot, "tagByNormalizedName">,
  name: string,
  includeAutomatic: boolean,
): Set<number> {
  const tag = snapshot.tagByNormalizedName.get(
    normalizeLibraryIndexTagIdentity(name),
  );
  if (!tag) return new Set();
  return new Set([
    ...tag.manualItemIds,
    ...(includeAutomatic ? tag.automaticItemIds : []),
  ]);
}

/**
 * The name a scope tag is looked up by: its display name, else its normalized
 * name. The display name is the exact Zotero tag; a stored normalized name
 * can be a legacy fuzzy key (`C++` saved as `c`) that names another tag.
 */
function paperScopeTagLookupName(tag: PaperScopeTag): string {
  return tag.name || tag.normalizedName || "";
}

/**
 * The items a scope tag names, before the paper filter: each item of any
 * kind that holds the tag; for an aggregate, each top-level item that is
 * tagged (or untagged).
 */
export function scopeTagItemIds(
  snapshot: Pick<
    LibraryIndexSnapshot,
    "itemById" | "topLevelItemOrder" | "tagByNormalizedName"
  >,
  tag: PaperScopeTag,
): Set<number> {
  const includeAutomatic = tag.includeAutomatic === true;
  if (tag.scope === "allTagged" || tag.scope === "untagged") {
    const scope = tag.scope;
    return new Set(
      snapshot.topLevelItemOrder.filter((itemId) => {
        const item = snapshot.itemById.get(itemId);
        return Boolean(
          item &&
          indexItemMatchesAggregateTagScope(item, scope, includeAutomatic),
        );
      }),
    );
  }
  return libraryIndexTagItemIds(
    snapshot,
    paperScopeTagLookupName(tag),
    includeAutomatic,
  );
}

/** The papers a request's papers, folders and tags cover. */
export function resolvePaperScope(
  snapshot: PaperScopeSnapshot,
  request: PaperScopeRequest,
): PaperScope {
  const excluded = new Set(request.excludedItemIds || []);
  const union = new Set<number>();
  const tagItemIds = new Set<number>();
  let summedScopeCount = 0;
  const add = (ids: Iterable<number>): number => {
    let count = 0;
    for (const id of ids) {
      if (!isPaperScopeItem(snapshot.itemById.get(id))) continue;
      if (excluded.has(id)) continue;
      if (request.pdfOnly && !snapshot.pdfCapableItemIds.has(id)) continue;
      union.add(id);
      count += 1;
    }
    return count;
  };
  // Zotero item ids are unique across libraries, so a paper from another
  // library is simply absent from this snapshot.
  add(request.itemIds || []);
  const collectionNames: string[] = [];
  for (const collectionId of request.collectionIds || []) {
    const collection = snapshot.collectionById.get(collectionId);
    if (!collection || collection.libraryID !== request.libraryID) continue;
    collectionNames.push(
      snapshot.collectionPathById.get(collectionId) || collection.name,
    );
    summedScopeCount += add(
      snapshot.directItemIdsByCollectionId.get(collectionId) || [],
    );
  }
  const tagNames: string[] = [];
  for (const tag of request.tagContexts || []) {
    const ids = scopeTagItemIds(snapshot, tag);
    tagNames.push(tag.name);
    summedScopeCount += add(ids);
    for (const id of ids) {
      if (snapshot.itemById.get(id)?.kind === "regular") tagItemIds.add(id);
    }
  }
  return {
    itemIds: [...union],
    tagItemIds: [...tagItemIds].filter((id) => union.has(id)),
    collectionNames,
    tagNames,
    summedScopeCount,
  };
}

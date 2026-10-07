/**
 * Collections and saved searches: the collection tree, what is filed where,
 * creating, renaming, trashing and restoring a collection, writing an item's
 * membership as a set, and the saved searches the same executor owns.
 *
 * Split out of `zoteroGateway.ts`. The capability never names the facade:
 * the item and collection lookups these paths used to reach through `this`
 * arrive as constructor dependencies, so a caller (or a test) that supplies
 * its own lookups gets exactly the behaviour it asked for.
 */

import { libraryIndexService } from "../../../services/libraryIndexService";
import {
  buildCollectionPathMap,
  listLibraryCollections,
} from "./internal/collections";
import { resolveMatrixItem } from "./internal/itemResolution";
import {
  orderedGatewayPaperIds,
  orderedIndexIds,
  pageIds,
  planSearchConditions,
  validateSearchConditions,
} from "./internal/libraryIndex";
import { normalizeText } from "./internal/normalize";
import {
  buildPaperTargetFromItem,
  buildPaperTargetsForIds,
} from "./internal/targetBuilders";
import type {
  AgentSearchCondition,
  CollectionSummary,
  ItemLookup,
  LibraryPaperTarget,
} from "./internal/types";

export type CollectionBrowseNode = {
  collectionId: number;
  name: string;
  paperCount: number;
  descendantPaperCount: number;
  childCollections: CollectionBrowseNode[];
};

/** What an add-mode filing tells its caller about the folders it left alone. */
export const ADD_ONLY_NOTE =
  "Added only: no paper was removed from any collection, so each one is still in every collection it was in before. To move papers, call again with mode:'move' and from:<collectionId>.";

export type BatchMoveItemResult = {
  itemId: number;
  title: string;
  status: "moved" | "added" | "skipped" | "missing";
  targetCollectionId?: number;
  targetCollectionName?: string;
  reason?: string;
};

export type BatchMoveAssignment = {
  itemId: number;
  targetCollectionId: number;
};

/**
 * The exact collection membership an item should end up with.
 *
 * This is the primitive a real "move" needs. Membership is a *set*, so the
 * only way to move an item without corrupting it is to state the whole set
 * at once — and the only inverse that restores a move is the set it had
 * before. Expressing a move as add-then-remove cannot do either.
 */
export type ItemCollectionSet = {
  itemId: number;
  collectionIds: number[];
};

/**
 * What the collection and saved-search paths need from the rest of the
 * gateway.
 *
 * All three are the facade's own resolvers rather than the free functions in
 * `internal/` on purpose: the facade passes thunks that call its methods, so
 * an instance-level override still steers these paths — which is exactly
 * what `collectionMoveSemantics.test.ts` does with `getItem` and
 * `getCollectionSummary`. `resolveBibliographicItem` is never called
 * directly here — it completes the `ItemLookup` the shared target builders
 * take, which the gateway satisfied by passing itself.
 */
export type CollectionCapabilityDeps = {
  getItem(itemId: number | undefined): Zotero.Item | null;
  getCollection(collectionId: number | undefined): Zotero.Collection | null;
  getCollectionSummary(
    collectionId: number | undefined,
  ): CollectionSummary | null;
  resolveBibliographicItem(
    item: Zotero.Item | null | undefined,
  ): Zotero.Item | null;
};

export class CollectionCapability {
  constructor(private readonly deps: CollectionCapabilityDeps) {}

  /**
   * The lookups the shared target builders take, forwarded to the same
   * thunks so an instance-level override still reaches them.
   */
  private readonly itemLookup: ItemLookup = {
    getItem: (itemId) => this.deps.getItem(itemId),
    resolveBibliographicItem: (item) =>
      this.deps.resolveBibliographicItem(item),
  };

  /** Uncached native state used to verify collection mutation receipts. */
  getCollectionNativeState(collectionId: number): {
    exists: boolean;
    name: string;
    parentCollectionId: number | null;
    deleted: boolean;
  } {
    const collection = this.deps.getCollection(collectionId);
    return collection
      ? {
          exists: true,
          name: normalizeText(collection.name),
          parentCollectionId:
            Number(collection.parentID) > 0
              ? Number(collection.parentID)
              : null,
          deleted: Boolean(
            (collection as Zotero.Collection & { deleted?: boolean }).deleted,
          ),
        }
      : {
          exists: false,
          name: "",
          parentCollectionId: null,
          deleted: false,
        };
  }

  listCollectionSummaries(libraryID: number): CollectionSummary[] {
    const normalizedLibraryID = Number.isFinite(libraryID)
      ? Math.floor(libraryID)
      : 0;
    if (!normalizedLibraryID) return [];
    const snapshot = libraryIndexService.peekSnapshot(normalizedLibraryID);
    if (snapshot) {
      return [...snapshot.collectionById.values()]
        .filter((collection) => !collection.deleted)
        .map((collection) => ({
          collectionId: collection.collectionId,
          name: collection.name,
          libraryID: collection.libraryID,
          path:
            snapshot.collectionPathById.get(collection.collectionId) ||
            collection.name,
        }))
        .sort((left, right) =>
          (left.path || left.name).localeCompare(
            right.path || right.name,
            undefined,
            { sensitivity: "base" },
          ),
        );
    }
    return this.listCurrentCollectionSummaries(normalizedLibraryID);
  }

  listCurrentCollectionSummaries(libraryID: number): CollectionSummary[] {
    const normalizedLibraryID = Number.isFinite(libraryID)
      ? Math.floor(libraryID)
      : 0;
    if (!normalizedLibraryID) return [];
    const collections = listLibraryCollections(normalizedLibraryID);
    const pathMap = buildCollectionPathMap(collections);
    return collections
      .map((collection) => ({
        collectionId: collection.id,
        name: normalizeText(collection.name) || `Collection ${collection.id}`,
        libraryID: Number(collection.libraryID) || normalizedLibraryID,
        path:
          pathMap.get(collection.id) ||
          normalizeText(collection.name) ||
          `Collection ${collection.id}`,
      }))
      .sort((left, right) =>
        (left.path || left.name).localeCompare(
          right.path || right.name,
          undefined,
          {
            sensitivity: "base",
          },
        ),
      );
  }

  listCurrentCollectionTargetIds(params: {
    libraryID: number;
    collectionId: number;
    targetKind: "papers" | "items";
  }): number[] {
    const collection = this.deps.getCollection(params.collectionId);
    if (!collection || Number(collection.libraryID) !== params.libraryID) {
      return [];
    }
    let memberIds: number[];
    try {
      memberIds = collection.getChildItems?.(true, false) || [];
    } catch (_error) {
      return [];
    }
    const directIds = [
      ...new Set(
        memberIds
          .map(Number)
          .filter((itemId) => Number.isInteger(itemId) && itemId > 0),
      ),
    ];
    if (params.targetKind === "items") return directIds;
    return directIds.filter(
      (itemId) => this.deps.getItem(itemId)?.isRegularItem?.() === true,
    );
  }

  async listCurrentLibraryTargetIds(params: {
    libraryID: number;
    targetKind: "papers" | "items";
  }): Promise<number[]> {
    const items: Zotero.Item[] = await Zotero.Items.getAll(
      params.libraryID,
      true,
      false,
      false,
    );
    return items
      .filter((item) => {
        if (params.targetKind === "papers") return item.isRegularItem?.();
        return Boolean(
          item.isRegularItem?.() || item.isNote?.() || item.isAttachment?.(),
        );
      })
      .map((item) => item.id)
      .filter((itemId) => Number.isInteger(itemId) && itemId > 0);
  }

  async browseCollections(params: { libraryID: number }): Promise<{
    libraryID: number;
    libraryName: string;
    collections: CollectionBrowseNode[];
    unfiled: {
      name: string;
      paperCount: number;
    };
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) {
      throw new Error("No active library available for browsing collections");
    }
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    // Collection membership is bibliographic, not conditional on a PDF.
    const paperIds = new Set(
      orderedIndexIds(snapshot, (item) => item.kind === "regular"),
    );
    const nodes = new Map<number, CollectionBrowseNode>();
    for (const collection of snapshot.collectionById.values()) {
      if (collection.deleted) continue;
      const directIds = snapshot.directItemIdsByCollectionId.get(
        collection.collectionId,
      );
      nodes.set(collection.collectionId, {
        collectionId: collection.collectionId,
        name: collection.name,
        paperCount: directIds
          ? [...directIds].filter((itemId) => paperIds.has(itemId)).length
          : 0,
        descendantPaperCount: 0,
        childCollections: [],
      });
    }
    const countDescendants = (node: CollectionBrowseNode): number => {
      node.descendantPaperCount =
        node.paperCount +
        node.childCollections.reduce(
          (sum, child) => sum + countDescendants(child),
          0,
        );
      return node.descendantPaperCount;
    };
    for (const collection of snapshot.collectionById.values()) {
      const node = nodes.get(collection.collectionId);
      if (!node) continue;
      for (const childId of snapshot.childCollectionIdsByCollectionId.get(
        collection.collectionId,
      ) || []) {
        const child = nodes.get(childId);
        if (child) node.childCollections.push(child);
      }
    }
    const collections = [...snapshot.collectionById.values()]
      .filter(
        (collection) =>
          !collection.deleted &&
          (!collection.parentCollectionId ||
            !nodes.has(collection.parentCollectionId)),
      )
      .map((collection) => nodes.get(collection.collectionId)!)
      .filter(Boolean);
    collections.forEach(countDescendants);
    return {
      libraryID,
      libraryName: snapshot.libraryName,
      collections,
      unfiled: {
        name: "Unfiled",
        paperCount: [...snapshot.unfiledItemIds].filter((itemId) =>
          paperIds.has(itemId),
        ).length,
      },
    };
  }

  async listCollectionPaperTargets(params: {
    libraryID: number;
    collectionId: number;
    limit?: number;
  }): Promise<{
    collection: CollectionSummary;
    papers: LibraryPaperTarget[];
    totalCount: number;
  }> {
    const collection = this.deps.getCollectionSummary(params.collectionId);
    if (!collection) {
      throw new Error("Collection not found");
    }
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) {
      throw new Error(
        "No active library available for listing collection papers",
      );
    }
    if (collection.libraryID && collection.libraryID !== libraryID) {
      throw new Error("Collection does not belong to the active library");
    }
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const memberIds =
      snapshot.directItemIdsByCollectionId.get(collection.collectionId) ||
      new Set<number>();
    const ids = orderedGatewayPaperIds(snapshot).filter((itemId) =>
      memberIds.has(itemId),
    );
    return {
      collection,
      papers: buildPaperTargetsForIds(
        this.itemLookup,
        pageIds(ids, params.limit),
      ),
      totalCount: ids.length,
    };
  }

  async listUnfiledPaperTargets(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    papers: LibraryPaperTarget[];
    totalCount: number;
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) {
      throw new Error("No active library available for listing unfiled papers");
    }
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const ids = orderedGatewayPaperIds(snapshot).filter((itemId) =>
      snapshot.unfiledItemIds.has(itemId),
    );
    return {
      papers: buildPaperTargetsForIds(
        this.itemLookup,
        pageIds(ids, params.limit),
      ),
      totalCount: ids.length,
    };
  }

  /**
   * Returns whether the item was actually removed. It used to return `void`
   * and bail silently on an unresolvable item, while the caller counted every
   * requested id as removed — so a request to unfile ten notes reported
   * "removedCount: 10" having done nothing at all.
   */
  /**
   * Reads an item's real collection membership.
   *
   * The read path used to take this from the paper-target map, which is built
   * by `buildPaperTargetFromItem` and returns `null` for any item without a
   * PDF child — so a book sitting in three collections reported none, and a
   * note reported nothing at all. That is the channel an agent uses to verify
   * a filing operation, so it silently failed exactly where it mattered.
   */
  getItemCollectionIds(itemId: number): number[] {
    const item = this.deps.getItem(itemId);
    if (!item) return [];
    try {
      const ids = (
        item as unknown as { getCollections?: () => number[] }
      ).getCollections?.();
      return Array.isArray(ids)
        ? ids.filter((id) => Number.isFinite(id) && id > 0)
        : [];
    } catch {
      return [];
    }
  }

  async createCollection(params: {
    name: string;
    parentCollectionId?: number;
    libraryID: number;
  }): Promise<CollectionSummary> {
    const normalizedName = normalizeText(params.name).trim();
    if (!normalizedName) {
      throw new Error("Collection name is required");
    }
    const libraryID =
      Number.isFinite(params.libraryID) && params.libraryID > 0
        ? Math.floor(params.libraryID)
        : 0;
    if (!libraryID) {
      throw new Error("No library available for collection creation");
    }
    if (params.parentCollectionId) {
      const parentCollection = this.deps.getCollection(
        params.parentCollectionId,
      );
      if (!parentCollection) {
        throw new Error(
          `Parent collection ${params.parentCollectionId} not found`,
        );
      }
    }
    const collection = new Zotero.Collection();
    (collection as unknown as { libraryID: number }).libraryID = libraryID;
    collection.name = normalizedName;
    if (params.parentCollectionId) {
      collection.parentID = params.parentCollectionId;
    }
    await collection.saveTx();
    const allCollections = listLibraryCollections(libraryID);
    const pathMap = buildCollectionPathMap(allCollections);
    return {
      collectionId: collection.id,
      name: normalizedName,
      libraryID,
      path: pathMap.get(collection.id) || normalizedName,
    };
  }

  /**
   * Moves a collection to the trash, matching what Zotero's own UI does.
   *
   * This used to call `eraseTx()`, which is Zotero's *permanent* erase — it
   * wipes the collection and every descendant with no way back. Zotero has
   * had a collection trash since `deletedCollections` landed, and its own
   * "Delete Collection" sets `deleted = true`; only "Delete Permanently"
   * erases. The agent was therefore more destructive than the UI while
   * telling the user the opposite ("Zotero has no trash for collections").
   *
   * Setting `deleted` routes through `Zotero.Collection.trash()`, which
   * trashes descendant collections too and preserves every id, so a restore
   * brings back the original objects rather than rebuilding lookalikes.
   *
   * Items are left in the library unless `deleteItems` is set — again
   * matching Zotero, whose menu offers "Delete Collection" and "Delete
   * Collection and Items" as separate commands.
   */
  /**
   * Renames a collection, moves it under a different parent, or promotes it
   * to top level.
   *
   * The matrix declared collection update and reparent allowed and nothing
   * implemented them, so the collection tool could only create and delete --
   * a typo in a folder name meant deleting it and rebuilding it, losing the
   * id every filed item referenced.
   */
  async updateCollection(params: {
    collectionId: number;
    name?: string;
    parentCollectionId?: number | null;
  }): Promise<{
    collectionId: number;
    name: string;
    previousName: string;
    previousParentCollectionId: number | null;
    status: "updated" | "unchanged" | "not_found";
    reason?: string;
  }> {
    const collection = this.deps.getCollection(params.collectionId) as
      | (Zotero.Collection & { parentID?: number | false })
      | null;
    if (!collection) {
      return {
        collectionId: params.collectionId,
        name: "",
        previousName: "",
        previousParentCollectionId: null,
        status: "not_found",
      };
    }
    const previousName = normalizeText(collection.name);
    const previousParentRaw = Number(collection.parentID);
    const previousParentCollectionId =
      Number.isFinite(previousParentRaw) && previousParentRaw > 0
        ? previousParentRaw
        : null;

    const nextName = params.name?.trim();
    const wantsReparent = params.parentCollectionId !== undefined;
    const nextParent =
      params.parentCollectionId === null
        ? null
        : params.parentCollectionId === undefined
          ? previousParentCollectionId
          : Math.floor(params.parentCollectionId);

    if (wantsReparent && nextParent !== null) {
      if (nextParent === params.collectionId) {
        return {
          collectionId: params.collectionId,
          name: previousName,
          previousName,
          previousParentCollectionId,
          status: "not_found",
          reason: "A collection cannot be its own parent",
        };
      }
      const target = this.deps.getCollection(nextParent);
      if (!target) {
        return {
          collectionId: params.collectionId,
          name: previousName,
          previousName,
          previousParentCollectionId,
          status: "not_found",
          reason: `No collection with ID ${nextParent} exists in this library`,
        };
      }
      // Zotero would accept this and produce an orphaned cycle that no
      // longer appears anywhere in the tree.
      const descendants = new Set(
        (
          (
            collection as unknown as {
              getDescendents?: (
                nested: boolean,
                type: "collection" | null,
              ) => Array<{ id: number; type: string }>;
            }
          ).getDescendents?.(false, "collection") || []
        ).map((entry) => Number(entry.id)),
      );
      if (descendants.has(nextParent)) {
        return {
          collectionId: params.collectionId,
          name: previousName,
          previousName,
          previousParentCollectionId,
          status: "not_found",
          reason:
            "That collection is inside this one, so moving it there would detach the whole subtree from the library",
        };
      }
    }

    const nameChanged = Boolean(nextName) && nextName !== previousName;
    const parentChanged =
      wantsReparent && nextParent !== previousParentCollectionId;
    if (!nameChanged && !parentChanged) {
      return {
        collectionId: params.collectionId,
        name: previousName,
        previousName,
        previousParentCollectionId,
        status: "unchanged",
      };
    }

    if (nameChanged) collection.name = nextName as string;
    if (parentChanged) {
      (collection as unknown as { parentID: number | false }).parentID =
        nextParent ?? false;
    }
    await (
      collection as unknown as { saveTx: () => Promise<unknown> }
    ).saveTx();
    return {
      collectionId: params.collectionId,
      name: normalizeText(collection.name),
      previousName,
      previousParentCollectionId,
      status: "updated",
    };
  }

  /**
   * Describes a collection before it is deleted.
   *
   * Deleting now trashes rather than erases, so the inverse is a restore by
   * id and this snapshot is no longer load-bearing for undo. It still
   * describes the collection for the confirmation card, and
   * `childCollectionCount` tells the user how much of their tree a delete
   * would take with it. Returns `null` when the collection does not exist.
   */
  snapshotCollectionForDelete(params: { collectionId: number }): {
    name: string;
    parentCollectionId?: number;
    libraryID: number;
    itemIds: number[];
    childCollectionCount: number;
  } | null {
    const collection = this.deps.getCollection(params.collectionId) as
      | (Zotero.Collection & {
          getChildItems?: (asIDs: true, includeDeleted?: boolean) => number[];
          getChildCollections?: (asIDs: true) => number[];
        })
      | null;
    if (!collection) return null;
    let itemIds: number[] = [];
    try {
      itemIds = collection.getChildItems?.(true) || [];
    } catch {
      itemIds = [];
    }
    let childCollectionCount = 0;
    try {
      childCollectionCount = (collection.getChildCollections?.(true) || [])
        .length;
    } catch {
      childCollectionCount = 0;
    }
    const parentID = Number((collection as { parentID?: unknown }).parentID);
    return {
      name:
        normalizeText(collection.name) || `Collection ${params.collectionId}`,
      parentCollectionId:
        Number.isFinite(parentID) && parentID > 0 ? parentID : undefined,
      libraryID: Number(collection.libraryID) || 0,
      itemIds,
      childCollectionCount,
    };
  }

  async deleteCollection(params: {
    collectionId: number;
    deleteItems?: boolean;
    permanent?: boolean;
  }): Promise<void> {
    const collection = this.deps.getCollection(params.collectionId);
    if (!collection) return;
    const libraryID = Number(collection.libraryID) || 0;
    if (params.permanent) {
      await (
        collection as unknown as {
          eraseTx: (options?: { deleteItems?: boolean }) => Promise<void>;
        }
      ).eraseTx({ deleteItems: !!params.deleteItems });
    } else {
      (collection as unknown as { deleted: boolean }).deleted = true;
      await (
        collection as unknown as {
          saveTx: (options?: { deleteItems?: boolean }) => Promise<unknown>;
        }
      ).saveTx({ deleteItems: !!params.deleteItems });
    }
  }

  /**
   * Brings collections back out of the trash.
   *
   * Descendants are restored alongside their parent, mirroring both what
   * `trash()` took down and what Zotero's own "Restore to Library" does
   * (`zoteroPane.js` restores `getDescendents(false, 'collection', true)`).
   * Without that, restoring a parent would leave its subtree stranded in the
   * trash.
   */
  async restoreCollections(params: {
    collectionIds: number[];
  }): Promise<{ restoredCount: number; collectionIds: number[] }> {
    const seen = new Set<number>();
    const restored: number[] = [];
    for (const collectionId of params.collectionIds) {
      const collection = this.deps.getCollection(collectionId) as
        | (Zotero.Collection & {
            deleted?: boolean;
            getDescendents?: (
              nested: boolean,
              type: "collection" | "item" | null,
              includeDeletedItems?: boolean,
            ) => Array<{ id: number; type: string }>;
          })
        | null;
      if (!collection) continue;
      const targets: Array<Zotero.Collection & { deleted?: boolean }> = [
        collection,
      ];
      try {
        for (const descendent of collection.getDescendents?.(
          false,
          "collection",
          true,
        ) || []) {
          const child = this.deps.getCollection(descendent.id) as
            | (Zotero.Collection & { deleted?: boolean })
            | null;
          if (child) targets.push(child);
        }
      } catch {
        // A missing descendant must not block restoring the parent.
      }
      for (const target of targets) {
        const id = Number(target.id);
        if (seen.has(id)) continue;
        seen.add(id);
        if (!target.deleted) continue;
        target.deleted = false;
        await (
          target as unknown as { saveTx: () => Promise<unknown> }
        ).saveTx();
        restored.push(id);
      }
    }
    return { restoredCount: restored.length, collectionIds: restored };
  }

  /**
   * Sets an item's collection membership to exactly the given set.
   *
   * Every other collection write in this file was an add or a single remove,
   * which is why "move" was a lie: `addItemsToCollections` only ever called
   * `addToCollection`, so a move left the item in both the old and the new
   * collection while reporting `status: "moved"`.
   *
   * Membership is a set, so it has to be written as one:
   *
   * - The whole destination set for an item is resolved before any write.
   *   One item can legitimately carry several destinations in a single call,
   *   and applying them pairwise makes the second assignment undo the first.
   * - Both `addToCollection` and `removeFromCollection` are checked against
   *   the capability matrix *before* anything is written. The matrix refuses
   *   child items for removal, so an add-then-refuse would leave the item
   *   filed in both places — the exact corruption this replaces.
   * - Adds and removes for one item share a single `saveTx`, so an item is
   *   never observable in a half-moved state.
   */
  async setItemCollections(params: {
    assignments: ItemCollectionSet[];
  }): Promise<{
    items: BatchMoveItemResult[];
    changedCount: number;
    priorCollections: ItemCollectionSet[];
  }> {
    // Collapse to one destination set per item before touching anything.
    const desired = new Map<number, Set<number>>();
    const order: number[] = [];
    for (const entry of params.assignments) {
      const itemId = Number.isFinite(entry.itemId)
        ? Math.floor(entry.itemId)
        : 0;
      if (!itemId) continue;
      if (!desired.has(itemId)) {
        desired.set(itemId, new Set());
        order.push(itemId);
      }
      const set = desired.get(itemId) as Set<number>;
      for (const raw of entry.collectionIds || []) {
        const collectionId = Number.isFinite(raw) ? Math.floor(raw) : 0;
        if (collectionId > 0) set.add(collectionId);
      }
    }

    const results: BatchMoveItemResult[] = [];
    const priorCollections: ItemCollectionSet[] = [];
    let changedCount = 0;

    for (const itemId of order) {
      const targets = desired.get(itemId) as Set<number>;
      const rawItem = this.deps.getItem(itemId);

      // Check both verbs up front: a move that may not remove must not add.
      const addResolution = resolveMatrixItem(
        rawItem,
        itemId,
        "addToCollection",
      );
      const removeResolution = resolveMatrixItem(
        rawItem,
        itemId,
        "removeFromCollection",
      );
      const blocked =
        "refusal" in addResolution
          ? addResolution.refusal
          : "refusal" in removeResolution
            ? removeResolution.refusal
            : null;
      if (blocked || !("item" in addResolution)) {
        results.push({
          itemId,
          title: rawItem
            ? normalizeText(rawItem.getDisplayTitle?.()) || `Item ${itemId}`
            : `Item ${itemId}`,
          status: "missing",
          targetCollectionId: 0,
          reason: blocked || `Item ${itemId} could not be resolved`,
        });
        continue;
      }
      const item = addResolution.item;

      const prior = this.getItemCollectionIds(Number(item.id));
      const priorSet = new Set(prior);
      const toAdd = [...targets].filter((id) => !priorSet.has(id));
      const toRemove = prior.filter((id) => !targets.has(id));

      const title =
        normalizeText(item.getDisplayTitle?.()) || `Item ${item.id}`;
      const primaryTarget = [...targets][0] ?? 0;
      const targetSummary = primaryTarget
        ? this.deps.getCollectionSummary(primaryTarget)
        : null;

      if (!toAdd.length && !toRemove.length) {
        results.push({
          itemId: Number(item.id),
          title,
          status: "skipped",
          targetCollectionId: primaryTarget,
          targetCollectionName: targetSummary?.path || targetSummary?.name,
          reason: "Already filed exactly here",
        });
        continue;
      }

      try {
        for (const collectionId of toAdd) {
          item.addToCollection(collectionId);
        }
        for (const collectionId of toRemove) {
          item.removeFromCollection(collectionId);
        }
        // One transaction per item: never observable half-moved.
        await item.saveTx();
      } catch (error) {
        results.push({
          itemId: Number(item.id),
          title,
          status: "missing",
          targetCollectionId: primaryTarget,
          targetCollectionName: targetSummary?.path || targetSummary?.name,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      // Recorded per item, so the inverse restores the exact prior set —
      // including items that were in three collections, or in none.
      priorCollections.push({ itemId: Number(item.id), collectionIds: prior });
      changedCount += 1;
      results.push({
        itemId: Number(item.id),
        title,
        status: "moved",
        targetCollectionId: primaryTarget,
        targetCollectionName: targetSummary?.path || targetSummary?.name,
      });
    }

    return { items: results, changedCount, priorCollections };
  }

  /**
   * Files items into collections.
   *
   * `mode: "add"` is the historical behaviour and stays the default: the item
   * gains the destination and keeps everything else.
   *
   * `mode: "move"` actually moves. Until now the vocabulary said "moved"
   * everywhere — the result field, the row status, the button — while the
   * code only ever added, so asking to move a paper left it filed in both
   * the old and the new collection.
   *
   * `from` is required for a move and never inferred: `from: <collectionId>`
   * takes it out of that one collection, `from: "all"` makes the destination
   * set exhaustive. Guessing would silently unfile items from collections the
   * user never mentioned.
   */
  async addItemsToCollections(params: {
    assignments: BatchMoveAssignment[];
    mode?: "add" | "move";
    from?: number | "all";
  }): Promise<{
    selectedCount: number;
    movedCount: number;
    addedCount: number;
    skippedCount: number;
    collections: CollectionSummary[];
    items: BatchMoveItemResult[];
    priorCollections?: ItemCollectionSet[];
    note?: string;
  }> {
    const normalizedAssignments: BatchMoveAssignment[] = [];
    const seen = new Set<string>();
    for (const entry of params.assignments) {
      const itemId = Number.isFinite(entry.itemId)
        ? Math.floor(entry.itemId)
        : 0;
      const targetCollectionId = Number.isFinite(entry.targetCollectionId)
        ? Math.floor(entry.targetCollectionId)
        : 0;
      const key = `${itemId}:${targetCollectionId}`;
      if (!itemId || !targetCollectionId || seen.has(key)) continue;
      seen.add(key);
      normalizedAssignments.push({
        itemId,
        targetCollectionId,
      });
    }
    if (!normalizedAssignments.length) {
      throw new Error("No valid collection assignments were provided");
    }
    const collectionMap = new Map<number, CollectionSummary>();
    for (const assignment of normalizedAssignments) {
      if (collectionMap.has(assignment.targetCollectionId)) continue;
      const collection = this.deps.getCollectionSummary(
        assignment.targetCollectionId,
      );
      if (!collection) {
        throw new Error("Collection not found");
      }
      collectionMap.set(assignment.targetCollectionId, collection);
    }

    if (params.mode === "move") {
      if (params.from == null) {
        throw new Error(
          'A move needs an explicit source: pass from:<collectionId> to take items out of one collection, or from:"all" to replace their collection membership entirely.',
        );
      }
      // Collapse every assignment into one destination set per item first.
      // Handling them pairwise would let the second assignment for an item
      // undo the first.
      const destinations = new Map<number, Set<number>>();
      for (const assignment of normalizedAssignments) {
        const set = destinations.get(assignment.itemId) || new Set<number>();
        set.add(assignment.targetCollectionId);
        destinations.set(assignment.itemId, set);
      }
      const sets: ItemCollectionSet[] = [];
      for (const [itemId, targets] of destinations) {
        const keep =
          params.from === "all"
            ? []
            : this.getItemCollectionIds(itemId).filter(
                (id) => id !== params.from,
              );
        sets.push({
          itemId,
          collectionIds: Array.from(new Set([...keep, ...targets])),
        });
      }
      const outcome = await this.setItemCollections({ assignments: sets });
      return {
        selectedCount: sets.length,
        movedCount: outcome.changedCount,
        addedCount: 0,
        skippedCount: outcome.items.length - outcome.changedCount,
        collections: Array.from(collectionMap.values()),
        items: outcome.items,
        priorCollections: outcome.priorCollections,
      };
    }

    const results: BatchMoveItemResult[] = [];
    let addedCount = 0;
    for (const assignment of normalizedAssignments) {
      const collection = collectionMap.get(assignment.targetCollectionId);
      if (!collection) {
        results.push({
          itemId: assignment.itemId,
          title: `Item ${assignment.itemId}`,
          status: "missing",
          targetCollectionId: assignment.targetCollectionId,
          reason: "Collection not found",
        });
        continue;
      }
      const rawItem = this.deps.getItem(assignment.itemId);
      const resolution = resolveMatrixItem(
        rawItem,
        assignment.itemId,
        "addToCollection",
      );
      const item = "item" in resolution ? resolution.item : null;
      if (!item) {
        // "Item not found" was reported for items that plainly exist — a
        // note, a standalone attachment, a child attachment — because the
        // filter that rejected them could not say why. An agent reading that
        // reason has no way to correct itself, and a user reading it in the
        // trace is simply told something false.
        results.push({
          itemId: assignment.itemId,
          title: rawItem
            ? normalizeText(rawItem.getDisplayTitle?.()) ||
              `Item ${assignment.itemId}`
            : `Item ${assignment.itemId}`,
          status: "missing",
          targetCollectionId: collection.collectionId,
          targetCollectionName: collection.path || collection.name,
          reason:
            "refusal" in resolution
              ? resolution.refusal
              : `Item ${assignment.itemId} could not be resolved`,
        });
        continue;
      }
      const target = buildPaperTargetFromItem(item);
      const title =
        target?.title ||
        normalizeText(item.getDisplayTitle?.()) ||
        `Item ${item.id}`;
      if (item.inCollection?.(collection.collectionId)) {
        results.push({
          itemId: item.id,
          title,
          status: "skipped",
          targetCollectionId: collection.collectionId,
          targetCollectionName: collection.path || collection.name,
          reason: "Paper is already in this collection",
        });
        continue;
      }
      item.addToCollection(collection.collectionId);
      await item.saveTx();
      addedCount += 1;
      results.push({
        itemId: item.id,
        title,
        status: "added",
        targetCollectionId: collection.collectionId,
        targetCollectionName: collection.path || collection.name,
      });
    }
    return {
      selectedCount: normalizedAssignments.length,
      movedCount: 0,
      addedCount,
      skippedCount: results.length - addedCount,
      collections: Array.from(collectionMap.values()),
      items: results,
      // Said outright, because a model that meant to move read "added" as
      // done and told the user the paper had left its old folder.
      note: ADD_ONLY_NOTE,
    };
  }

  async removeItemFromCollection(params: {
    itemId: number;
    collectionId: number;
  }): Promise<{ removed: boolean; reason?: string }> {
    const resolution = resolveMatrixItem(
      this.deps.getItem(params.itemId),
      params.itemId,
      "removeFromCollection",
    );
    if (!("item" in resolution)) {
      return { removed: false, reason: resolution.refusal };
    }
    const item = resolution.item;
    if (!item.inCollection?.(params.collectionId)) {
      return {
        removed: false,
        reason: "The item was not in that collection",
      };
    }
    item.removeFromCollection(params.collectionId);
    await item.saveTx();
    const collection = this.deps.getCollection(params.collectionId);
    return { removed: true };
  }

  /**
   * Lists saved searches and the conditions behind them.
   *
   * Saved searches were entirely invisible: the matrix declared CRUD allowed
   * and nothing implemented any of it, and no query path enumerated them.
   */
  listSavedSearches(libraryID: number): Array<{
    savedSearchId: number;
    name: string;
    conditions: Array<{ condition: string; operator: string; value: string }>;
  }> {
    const searches = (
      Zotero as unknown as {
        Searches?: {
          getByLibrary?: (libraryID: number) => Array<{
            id: number;
            name: string;
            getConditions?: () => Record<
              string,
              { condition: string; operator: string; value: string }
            >;
          }>;
        };
      }
    ).Searches;
    try {
      return (searches?.getByLibrary?.(libraryID) || []).map((search) => ({
        savedSearchId: Number(search.id),
        name: normalizeText(search.name),
        conditions: Object.values(search.getConditions?.() || {}).map(
          (entry) => ({
            condition: String(entry.condition || ""),
            operator: String(entry.operator || ""),
            value: String(entry.value ?? ""),
          }),
        ),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Creates or replaces a saved search from a condition set.
   *
   * A saved search *is* a set of conditions, which is why this had to wait
   * for the condition vocabulary: without it there was nothing to save.
   */
  async saveSavedSearch(params: {
    libraryID: number;
    name: string;
    conditions: AgentSearchCondition[];
    joinMode?: "all" | "any";
    savedSearchId?: number;
  }): Promise<{
    savedSearchId: number;
    name: string;
    status: "created" | "updated";
  }> {
    const errors = validateSearchConditions(params.conditions);
    if (errors.length) {
      const detail = errors
        .map((error) =>
          error.validOperators?.length
            ? `${error.reason}. Valid operators: ${error.validOperators.join(", ")}`
            : error.reason,
        )
        .join("; ");
      throw new Error(`Invalid search conditions: ${detail}`);
    }

    const existing = params.savedSearchId
      ? (
          Zotero as unknown as {
            Searches?: { get?: (id: number) => unknown };
          }
        ).Searches?.get?.(params.savedSearchId)
      : null;

    const search = (existing ||
      new (Zotero as unknown as { Search: new () => unknown }).Search()) as {
      id?: number;
      libraryID: number;
      name: string;
      addCondition: (
        condition: string,
        operator: string,
        value?: string | number,
        required?: boolean,
      ) => void;
      removeCondition: (id: number) => void;
      getConditions?: () => Record<string, unknown>;
      saveTx: () => Promise<unknown>;
    };

    search.libraryID = params.libraryID;
    search.name = params.name;
    // Replace rather than append: updating a saved search means the
    // conditions given, not those plus whatever was there before.
    for (const conditionId of Object.keys(search.getConditions?.() || {})) {
      try {
        search.removeCondition(Number(conditionId));
      } catch {
        // A condition that will not come off must not block the save.
      }
    }
    for (const step of planSearchConditions(params)) {
      search.addCondition(
        step.condition,
        step.operator,
        step.value,
        step.required,
      );
    }
    await search.saveTx();
    return {
      savedSearchId: Number(search.id),
      name: params.name,
      status: existing ? "updated" : "created",
    };
  }

  /** Moves a saved search to the trash. Zotero tracks these in `deletedSearches`. */
  async deleteSavedSearch(params: {
    savedSearchId: number;
    permanent?: boolean;
  }): Promise<{
    savedSearchId: number;
    status: "trashed" | "erased" | "not_found";
  }> {
    const search = (
      Zotero as unknown as {
        Searches?: {
          get?: (id: number) =>
            | (Zotero.Search & {
                deleted?: boolean;
                eraseTx?: () => Promise<void>;
                saveTx?: () => Promise<unknown>;
              })
            | null;
        };
      }
    ).Searches?.get?.(params.savedSearchId);
    if (!search) {
      return { savedSearchId: params.savedSearchId, status: "not_found" };
    }
    if (params.permanent) {
      await search.eraseTx?.();
      return { savedSearchId: params.savedSearchId, status: "erased" };
    }
    (search as unknown as { deleted: boolean }).deleted = true;
    await search.saveTx?.();
    return { savedSearchId: params.savedSearchId, status: "trashed" };
  }

  /**
   * Brings saved searches back out of the trash. Zotero tracks these in
   * `deletedSearches`, exactly as it does collections.
   */
  async restoreSavedSearches(params: {
    savedSearchIds: number[];
  }): Promise<{ restoredCount: number; savedSearchIds: number[] }> {
    const restored: number[] = [];
    for (const savedSearchId of params.savedSearchIds) {
      const search = (
        Zotero.Searches as unknown as {
          get?: (id: number) => (Zotero.Search & { deleted?: boolean }) | null;
        }
      ).get?.(savedSearchId);
      if (!search || !search.deleted) continue;
      (search as unknown as { deleted: boolean }).deleted = false;
      await (search as unknown as { saveTx: () => Promise<unknown> }).saveTx();
      restored.push(savedSearchId);
    }
    return { restoredCount: restored.length, savedSearchIds: restored };
  }
}

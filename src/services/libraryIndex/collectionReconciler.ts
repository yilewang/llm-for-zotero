import type { LibraryIndexCollection, LibraryIndexSnapshot } from "./contracts";
import { patchMap, readonlySet } from "./readonlyCollections";
import { positiveIds, sameNumberMembers, text } from "./projection";
import type { SnapshotDelta } from "./snapshotDraft";

export type CollectionReconciliationPlan = Readonly<{
  delta: SnapshotDelta;
  affectedCollectionCount: number;
  membershipAffectedItemIds: ReadonlySet<number>;
}>;

export function reconcileCollections(
  snapshot: LibraryIndexSnapshot,
  libraryID: number,
  ids: readonly number[],
): CollectionReconciliationPlan {
  const collectionUpdates = new Map<number, LibraryIndexCollection>();
  const collectionDeletes = new Set<number>();
  const directUpdates = new Map<number, ReadonlySet<number>>();
  const directDeletes = new Set<number>();
  const childUpdates = new Map<number, readonly number[]>();
  const childDeletes = new Set<number>();
  const membershipAffectedItemIds = new Set<number>();
  const affected = new Set(ids);
  const childMembershipAffected = new Set<number>();
  const previousCollections = new Map<
    number,
    LibraryIndexCollection | undefined
  >();
  const liveById = new Map<number, Zotero.Collection | null>();
  const getLive = (id: number): Zotero.Collection | null => {
    if (liveById.has(id)) return liveById.get(id) || null;
    let collection: Zotero.Collection | null = null;
    try {
      collection = Zotero.Collections.get(id) || null;
    } catch {
      collection = null;
    }
    liveById.set(id, collection);
    return collection;
  };
  for (const id of ids) {
    const previousCollection = snapshot.collectionById.get(id);
    const liveCollection = getLive(id);
    const oldParent = previousCollection?.parentCollectionId || 0;
    const rawNewParent = Number(liveCollection?.parentID);
    const newParent =
      Number.isFinite(rawNewParent) && rawNewParent > 0
        ? Math.floor(rawNewParent)
        : 0;
    const lifecycleChanged = Boolean(
      previousCollection &&
      liveCollection &&
      previousCollection.deleted !==
        Boolean(
          (liveCollection as Zotero.Collection & { deleted?: unknown }).deleted,
        ),
    );
    if (oldParent && (oldParent !== newParent || lifecycleChanged)) {
      affected.add(oldParent);
      childMembershipAffected.add(oldParent);
    }
    if (newParent && oldParent !== newParent) {
      affected.add(newParent);
      childMembershipAffected.add(newParent);
    }
  }
  for (const id of affected) {
    const collection = getLive(id);
    const previousCollection = snapshot.collectionById.get(id);
    previousCollections.set(id, previousCollection);
    const previousMembers =
      snapshot.directItemIdsByCollectionId.get(id) || new Set<number>();
    if (!collection || Number(collection.libraryID) !== libraryID) {
      previousMembers.forEach((itemId) =>
        membershipAffectedItemIds.add(itemId),
      );
      collectionDeletes.add(id);
      directDeletes.add(id);
      childDeletes.add(id);
      continue;
    }
    const parent = Number(collection.parentID);
    const deleted = Boolean(
      (collection as Zotero.Collection & { deleted?: unknown }).deleted,
    );
    collectionUpdates.set(
      id,
      Object.freeze({
        collectionId: id,
        libraryID,
        name: text(collection.name) || `Collection ${id}`,
        parentCollectionId:
          Number.isFinite(parent) && parent > 0 ? Math.floor(parent) : 0,
        deleted,
      }),
    );
    const deletedChanged =
      Boolean(previousCollection) && previousCollection?.deleted !== deleted;
    if (!previousCollection) {
      directUpdates.set(id, readonlySet(new Set<number>()));
    }
    if (!previousCollection || deletedChanged) {
      // Incremental and cold projections both include trashed item records.
      // Ask Zotero for deleted children too, then refresh those item records
      // so their own collection IDs remain the canonical membership source.
      const currentMembers = positiveIds(
        collection.getChildItems?.(true, true) || [],
      );
      previousMembers.forEach((itemId) =>
        membershipAffectedItemIds.add(itemId),
      );
      currentMembers.forEach((itemId) => membershipAffectedItemIds.add(itemId));
      childMembershipAffected.add(id);
    }
    if (childMembershipAffected.has(id) || !previousCollection) {
      const previousChildren =
        snapshot.childCollectionIdsByCollectionId.get(id) || [];
      const nextChildren = positiveIds(
        collection.getChildCollections?.(true, false) || [],
      );
      if (!sameNumberMembers(previousChildren, nextChildren)) {
        childUpdates.set(id, Object.freeze(nextChildren));
      }
    }
  }
  const pathRoots = new Set<number>();
  for (const id of ids) {
    const before = previousCollections.get(id);
    const after = collectionUpdates.get(id);
    if (
      !before ||
      !after ||
      before.name !== after.name ||
      before.parentCollectionId !== after.parentCollectionId
    ) {
      pathRoots.add(id);
    }
  }
  const pathAffected = new Set<number>();
  const addPathSubtree = (
    root: number,
    childrenByCollectionId: ReadonlyMap<number, readonly number[]>,
  ): void => {
    const pending = [root];
    const visited = new Set<number>();
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      pathAffected.add(current);
      for (const child of childrenByCollectionId.get(current) || []) {
        pending.push(child);
      }
    }
  };
  for (const root of pathRoots) {
    addPathSubtree(root, snapshot.childCollectionIdsByCollectionId);
  }
  const collectionById = patchMap(
    snapshot.collectionById,
    collectionUpdates,
    collectionDeletes,
  );
  const childCollectionIdsByCollectionId = patchMap(
    snapshot.childCollectionIdsByCollectionId,
    childUpdates,
    childDeletes,
  );
  for (const root of pathRoots) {
    addPathSubtree(root, childCollectionIdsByCollectionId);
  }
  const pathUpdates = new Map<number, string>();
  const pathDeletes = new Set<number>();
  const computedPaths = new Map<number, string>();
  const resolvePath = (id: number, seen = new Set<number>()): string => {
    const computed = computedPaths.get(id);
    if (computed !== undefined) return computed;
    const collection = collectionById.get(id);
    if (!collection) return "";
    if (seen.has(id)) return collection.name;
    seen.add(id);
    const parent = collection.parentCollectionId;
    const parentPath =
      parent && collectionById.has(parent)
        ? !pathAffected.has(parent)
          ? snapshot.collectionPathById.get(parent) || resolvePath(parent, seen)
          : resolvePath(parent, seen)
        : "";
    const path = parentPath
      ? `${parentPath} / ${collection.name}`
      : collection.name;
    computedPaths.set(id, path);
    return path;
  };
  for (const id of pathAffected) {
    if (!collectionById.has(id)) {
      pathDeletes.add(id);
      continue;
    }
    const path = resolvePath(id);
    if (snapshot.collectionPathById.get(id) !== path) {
      pathUpdates.set(id, path);
    }
  }
  const collectionPathById = patchMap(
    snapshot.collectionPathById,
    pathUpdates,
    pathDeletes,
  );
  const delta: SnapshotDelta = Object.freeze({
    collectionById,
    directItemIdsByCollectionId: patchMap(
      snapshot.directItemIdsByCollectionId,
      directUpdates,
      directDeletes,
    ),
    childCollectionIdsByCollectionId,
    collectionPathById,
  });

  return {
    delta,
    affectedCollectionCount: affected.size,
    membershipAffectedItemIds,
  };
}

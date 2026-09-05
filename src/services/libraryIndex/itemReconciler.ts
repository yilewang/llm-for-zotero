import type {
  LibraryIndexAttachment,
  LibraryIndexChildNote,
  LibraryIndexItem,
  LibraryIndexSearchableFields,
  LibraryIndexSnapshot,
  LibraryIndexTag,
} from "./contracts";
import { patchMap, patchSet } from "./readonlyCollections";
import {
  normalizeLibraryIndexTagIdentity,
  projectItem,
  sameStringMembers,
  searchable,
} from "./projection";
import type { SnapshotDelta } from "./snapshotDraft";

export type ItemReconciliationPlan = Readonly<{
  delta: SnapshotDelta;
  affectedItemCount: number;
}>;

function sameOrderedValues<T>(
  left: readonly T[] | undefined,
  right: readonly T[],
): boolean {
  return Boolean(
    left &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]),
  );
}

function sameProjectedRecord<T extends object>(
  left: T | undefined,
  right: T,
): boolean {
  if (!left) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord)
    .filter((key) => leftRecord[key] !== undefined)
    .sort();
  const rightKeys = Object.keys(rightRecord)
    .filter((key) => rightRecord[key] !== undefined)
    .sort();
  return (
    sameOrderedValues(leftKeys, rightKeys) &&
    leftKeys.every((key) => {
      const leftValue = leftRecord[key];
      const rightValue = rightRecord[key];
      return Array.isArray(leftValue) && Array.isArray(rightValue)
        ? sameOrderedValues(leftValue, rightValue)
        : leftValue === rightValue;
    })
  );
}

export function reconcileItems(
  snapshot: LibraryIndexSnapshot,
  libraryID: number,
  ids: readonly number[],
): ItemReconciliationPlan {
  const topLevelIds = new Set<number>();
  for (const id of ids) {
    const live = Zotero.Items.get(id) || null;
    const previousParent = snapshot.parentItemIdByChildId.get(id);
    if (previousParent) topLevelIds.add(previousParent);
    // A previously standalone note or attachment may now be a child. Patch
    // its old top-level slot as well as its new parent so the stale standalone
    // record is removed in the same atomic snapshot publication.
    if (snapshot.itemById.has(id)) topLevelIds.add(id);
    const parent = Number(live?.parentID);
    if (Number.isFinite(parent) && parent > 0) topLevelIds.add(parent);
    else topLevelIds.add(id);
  }
  const previousItems = new Map<number, LibraryIndexItem | undefined>();
  for (const id of topLevelIds) {
    previousItems.set(id, snapshot.itemById.get(id));
  }

  type Projection = ReturnType<typeof projectItem>;
  const projections = new Map<number, Projection>();
  for (const id of topLevelIds) {
    const live = Zotero.Items.get(id) || null;
    const projected = live ? projectItem(live) : null;
    projections.set(
      id,
      projected?.item.libraryID === libraryID ? projected : null,
    );
  }

  const itemUpdates = new Map<number, LibraryIndexItem>();
  const itemDeletes = new Set<number>();
  const attachmentUpdates = new Map<number, LibraryIndexAttachment>();
  const attachmentDeletes = new Set<number>();
  const childAttachmentUpdates = new Map<number, readonly number[]>();
  const childAttachmentDeletes = new Set<number>();
  const pdfAttachmentUpdates = new Map<number, readonly number[]>();
  const pdfAttachmentDeletes = new Set<number>();
  const childNoteUpdates = new Map<number, readonly number[]>();
  const childNoteDeletes = new Set<number>();
  const childNoteRecordUpdates = new Map<number, LibraryIndexChildNote>();
  const childNoteRecordDeletes = new Set<number>();
  const childParentUpdates = new Map<number, number>();
  const childParentDeletes = new Set<number>();
  const searchableUpdates = new Map<number, LibraryIndexSearchableFields>();
  const searchableDeletes = new Set<number>();
  const orderAdds: number[] = [];
  const orderDeletes = new Set<number>();

  for (const id of topLevelIds) {
    const previous = previousItems.get(id);
    const projected = projections.get(id) || null;
    const previousAttachmentIds =
      snapshot.childAttachmentIdsByItemId.get(id) || [];
    const previousNoteIds = snapshot.childNoteIdsByItemId.get(id) || [];
    if (!projected) {
      itemDeletes.add(id);
      childAttachmentDeletes.add(id);
      pdfAttachmentDeletes.add(id);
      childNoteDeletes.add(id);
      searchableDeletes.add(id);
      for (const attachmentId of previousAttachmentIds) {
        attachmentDeletes.add(attachmentId);
        childParentDeletes.add(attachmentId);
      }
      for (const noteId of previousNoteIds) {
        childNoteRecordDeletes.add(noteId);
        childParentDeletes.add(noteId);
      }
      if (previous) orderDeletes.add(id);
      continue;
    }
    if (!sameProjectedRecord(previous, projected.item)) {
      itemUpdates.set(id, projected.item);
    }
    const attachmentIds = projected.attachments.map(
      (attachment) => attachment.attachmentId,
    );
    if (!sameOrderedValues(previousAttachmentIds, attachmentIds)) {
      childAttachmentUpdates.set(id, Object.freeze(attachmentIds));
    }
    const pdfAttachmentIds = projected.attachments
      .filter((attachment) => attachment.isContextEligiblePdf)
      .map((attachment) => attachment.attachmentId);
    if (
      !sameOrderedValues(
        snapshot.pdfAttachmentIdsByItemId.get(id),
        pdfAttachmentIds,
      )
    ) {
      pdfAttachmentUpdates.set(id, Object.freeze(pdfAttachmentIds));
    }
    if (
      !sameOrderedValues(
        snapshot.childNoteIdsByItemId.get(id),
        projected.childNoteIds,
      )
    ) {
      childNoteUpdates.set(id, Object.freeze([...projected.childNoteIds]));
    }
    const nextAttachmentIds = new Set(attachmentIds);
    const nextNoteIds = new Set(projected.childNoteIds);
    for (const attachmentId of previousAttachmentIds) {
      if (nextAttachmentIds.has(attachmentId)) continue;
      attachmentDeletes.add(attachmentId);
      childParentDeletes.add(attachmentId);
    }
    for (const noteId of previousNoteIds) {
      if (nextNoteIds.has(noteId)) continue;
      childNoteRecordDeletes.add(noteId);
      childParentDeletes.add(noteId);
    }
    for (const note of projected.childNotes) {
      if (!sameProjectedRecord(snapshot.childNoteById.get(note.noteId), note)) {
        childNoteRecordUpdates.set(note.noteId, note);
      }
      if (snapshot.parentItemIdByChildId.get(note.noteId) !== id) {
        childParentUpdates.set(note.noteId, id);
      }
    }
    for (const attachment of projected.attachments) {
      if (
        !sameProjectedRecord(
          snapshot.attachmentById.get(attachment.attachmentId),
          attachment,
        )
      ) {
        attachmentUpdates.set(attachment.attachmentId, attachment);
      }
      if (
        attachment.parentItemId &&
        snapshot.parentItemIdByChildId.get(attachment.attachmentId) !== id
      ) {
        childParentUpdates.set(attachment.attachmentId, id);
      }
    }
    const nextSearchable = searchable(
      projected.item,
      projected.attachmentTitles,
    );
    if (
      !sameProjectedRecord(
        snapshot.searchableFieldsByItemId.get(id),
        nextSearchable,
      )
    ) {
      searchableUpdates.set(id, nextSearchable);
    }
    if (!previous) orderAdds.push(id);
  }

  let order: readonly number[] = snapshot.topLevelItemOrder;
  if (orderAdds.length || orderDeletes.size) {
    const nextOrder = orderDeletes.size
      ? snapshot.topLevelItemOrder.filter((id) => !orderDeletes.has(id))
      : [...snapshot.topLevelItemOrder];
    const present = new Set(nextOrder);
    for (const id of orderAdds) {
      if (!present.has(id)) {
        present.add(id);
        nextOrder.push(id);
      }
    }
    order = Object.freeze(nextOrder);
  }

  const itemById = patchMap(snapshot.itemById, itemUpdates, itemDeletes);
  const pdfAttachmentIdsByItemId = patchMap(
    snapshot.pdfAttachmentIdsByItemId,
    pdfAttachmentUpdates,
    pdfAttachmentDeletes,
  );

  const unfiledAdds = new Set<number>();
  const unfiledDeletes = new Set<number>();
  const untaggedAdds = new Set<number>();
  const untaggedDeletes = new Set<number>();
  const pdfAdds = new Set<number>();
  const pdfDeletes = new Set<number>();
  const setMembership = (
    base: ReadonlySet<number>,
    adds: Set<number>,
    deletes: Set<number>,
    id: number,
    shouldContain: boolean,
  ): void => {
    if (shouldContain && !base.has(id)) adds.add(id);
    if (!shouldContain && base.has(id)) deletes.add(id);
  };
  for (const id of topLevelIds) {
    const item = itemById.get(id);
    setMembership(
      snapshot.unfiledItemIds,
      unfiledAdds,
      unfiledDeletes,
      id,
      Boolean(item && !item.deleted && !item.collectionIds.length),
    );
    setMembership(
      snapshot.untaggedItemIds,
      untaggedAdds,
      untaggedDeletes,
      id,
      Boolean(
        item &&
        !item.deleted &&
        !item.tags.length &&
        !item.automaticTags.length,
      ),
    );
    setMembership(
      snapshot.pdfCapableItemIds,
      pdfAdds,
      pdfDeletes,
      id,
      Boolean(
        item &&
        !item.deleted &&
        (pdfAttachmentIdsByItemId.get(id)?.length || 0) > 0,
      ),
    );
  }

  type TagMembershipDelta = {
    manualAdds: Set<number>;
    manualDeletes: Set<number>;
    automaticAdds: Set<number>;
    automaticDeletes: Set<number>;
  };
  const tagDeltas = new Map<string, TagMembershipDelta>();
  const ensureTagDelta = (normalizedName: string): TagMembershipDelta => {
    const existing = tagDeltas.get(normalizedName);
    if (existing) return existing;
    const created = {
      manualAdds: new Set<number>(),
      manualDeletes: new Set<number>(),
      automaticAdds: new Set<number>(),
      automaticDeletes: new Set<number>(),
    };
    tagDeltas.set(normalizedName, created);
    return created;
  };
  const tagVariantsByNormalizedName = (
    values: readonly string[],
  ): Map<string, Set<string>> => {
    const variantsByName = new Map<string, Set<string>>();
    for (const value of values) {
      const normalized = normalizeLibraryIndexTagIdentity(value);
      if (!normalized) continue;
      const variants = variantsByName.get(normalized) || new Set<string>();
      variants.add(value);
      variantsByName.set(normalized, variants);
    }
    return variantsByName;
  };
  const recordTagChannelDelta = (
    itemId: number,
    beforeValues: readonly string[],
    afterValues: readonly string[],
    automatic: boolean,
  ): void => {
    if (sameStringMembers(beforeValues, afterValues)) return;
    const beforeVariants = tagVariantsByNormalizedName(beforeValues);
    const afterVariants = tagVariantsByNormalizedName(afterValues);
    for (const normalizedName of new Set([
      ...beforeVariants.keys(),
      ...afterVariants.keys(),
    ])) {
      const previous = beforeVariants.get(normalizedName) || new Set<string>();
      const next = afterVariants.get(normalizedName) || new Set<string>();
      const wasPresent = previous.size > 0;
      const isPresent = next.size > 0;
      // A changed item commonly carries many unchanged co-tags. Rebuilding
      // those identities scans every one of their members, so only record an
      // identity whose membership or exact display variants changed.
      if (
        wasPresent === isPresent &&
        sameStringMembers([...previous], [...next])
      ) {
        continue;
      }
      // Variant-only changes (for example `Foo` -> `foo`) still refresh the
      // display variants and reverse tag-ID mapping even when membership is
      // unchanged after exact identity normalization.
      const delta = ensureTagDelta(normalizedName);
      if (wasPresent === isPresent) continue;
      const adds = automatic ? delta.automaticAdds : delta.manualAdds;
      const deletes = automatic ? delta.automaticDeletes : delta.manualDeletes;
      (isPresent ? adds : deletes).add(itemId);
    }
  };
  for (const id of topLevelIds) {
    const before = previousItems.get(id);
    const after = itemById.get(id);
    const beforeVisible = Boolean(before && !before.deleted);
    const afterVisible = Boolean(after && !after.deleted);
    recordTagChannelDelta(
      id,
      beforeVisible ? before?.tags || [] : [],
      afterVisible ? after?.tags || [] : [],
      false,
    );
    recordTagChannelDelta(
      id,
      beforeVisible ? before?.automaticTags || [] : [],
      afterVisible ? after?.automaticTags || [] : [],
      true,
    );
  }
  const tagUpdates = new Map<string, LibraryIndexTag>();
  const tagDeletes = new Set<string>();
  const tagIdUpdates = new Map<number, string>();
  const tagIdDeletes = new Set<number>();
  const reverseTagIdUpdates = new Map<string, readonly number[]>();
  const reverseTagIdDeletes = new Set<string>();
  for (const [normalizedName, delta] of tagDeltas) {
    const previous = snapshot.tagByNormalizedName.get(normalizedName);
    const previousManual = previous?.manualItemIds || new Set<number>();
    const previousAutomatic = previous?.automaticItemIds || new Set<number>();
    const manual = patchSet(
      previousManual,
      delta.manualAdds,
      delta.manualDeletes,
    );
    const automatic = patchSet(
      previousAutomatic,
      delta.automaticAdds,
      delta.automaticDeletes,
    );
    const variants = new Set<string>();
    for (const itemId of new Set<number>([...manual, ...automatic])) {
      const item = itemById.get(itemId);
      if (!item || item.deleted) continue;
      for (const value of item.tags) {
        if (normalizeLibraryIndexTagIdentity(value) !== normalizedName)
          continue;
        variants.add(value);
      }
      for (const value of item.automaticTags) {
        if (normalizeLibraryIndexTagIdentity(value) !== normalizedName)
          continue;
        variants.add(value);
      }
    }
    if (!manual.size && !automatic.size) {
      tagDeletes.add(normalizedName);
    } else {
      tagUpdates.set(
        normalizedName,
        Object.freeze({
          normalizedName,
          displayVariants: Object.freeze([...variants].sort()),
          manualItemIds: manual,
          automaticItemIds: automatic,
        }),
      );
    }
    for (const tagId of snapshot.tagIdsByNormalizedName.get(normalizedName) ||
      []) {
      tagIdDeletes.add(tagId);
    }
    const nextTagIds = new Set<number>();
    for (const variant of variants) {
      try {
        const tagId = Number(Zotero.Tags.getID(variant));
        if (Number.isFinite(tagId) && tagId > 0) {
          tagIdUpdates.set(tagId, normalizedName);
          nextTagIds.add(tagId);
        }
      } catch {
        // The name-based reverse index remains authoritative.
      }
    }
    if (nextTagIds.size) {
      reverseTagIdUpdates.set(normalizedName, Object.freeze([...nextTagIds]));
    } else {
      reverseTagIdDeletes.add(normalizedName);
    }
  }

  const affectedCollections = new Set<number>();
  const collectionAdds = new Map<number, Set<number>>();
  const collectionDeletes = new Map<number, Set<number>>();
  for (const id of topLevelIds) {
    const before = new Set(previousItems.get(id)?.collectionIds || []);
    const after = new Set(itemById.get(id)?.collectionIds || []);
    for (const collectionId of new Set([...before, ...after])) {
      if (before.has(collectionId) === after.has(collectionId)) continue;
      affectedCollections.add(collectionId);
      const deltas = after.has(collectionId)
        ? collectionAdds
        : collectionDeletes;
      const members = deltas.get(collectionId) || new Set<number>();
      members.add(id);
      deltas.set(collectionId, members);
    }
  }
  const directCollectionUpdates = new Map<number, ReadonlySet<number>>();
  const directCollectionDeletes = new Set<number>();
  for (const collectionId of affectedCollections) {
    const members = patchSet(
      snapshot.directItemIdsByCollectionId.get(collectionId) ||
        new Set<number>(),
      collectionAdds.get(collectionId) || new Set<number>(),
      collectionDeletes.get(collectionId) || new Set<number>(),
    );
    if (!members.size && !snapshot.collectionById.has(collectionId)) {
      directCollectionDeletes.add(collectionId);
    } else {
      directCollectionUpdates.set(collectionId, members);
    }
  }

  const delta: SnapshotDelta = Object.freeze({
    itemById,
    topLevelItemOrder: order,
    attachmentById: patchMap(
      snapshot.attachmentById,
      attachmentUpdates,
      attachmentDeletes,
    ),
    childAttachmentIdsByItemId: patchMap(
      snapshot.childAttachmentIdsByItemId,
      childAttachmentUpdates,
      childAttachmentDeletes,
    ),
    pdfAttachmentIdsByItemId,
    childNoteIdsByItemId: patchMap(
      snapshot.childNoteIdsByItemId,
      childNoteUpdates,
      childNoteDeletes,
    ),
    childNoteById: patchMap(
      snapshot.childNoteById,
      childNoteRecordUpdates,
      childNoteRecordDeletes,
    ),
    parentItemIdByChildId: patchMap(
      snapshot.parentItemIdByChildId,
      childParentUpdates,
      childParentDeletes,
    ),
    searchableFieldsByItemId: patchMap(
      snapshot.searchableFieldsByItemId,
      searchableUpdates,
      searchableDeletes,
    ),
    directItemIdsByCollectionId: patchMap(
      snapshot.directItemIdsByCollectionId,
      directCollectionUpdates,
      directCollectionDeletes,
    ),
    tagByNormalizedName: patchMap(
      snapshot.tagByNormalizedName,
      tagUpdates,
      tagDeletes,
    ),
    normalizedTagNameByTagId: patchMap(
      snapshot.normalizedTagNameByTagId,
      tagIdUpdates,
      tagIdDeletes,
    ),
    tagIdsByNormalizedName: patchMap(
      snapshot.tagIdsByNormalizedName,
      reverseTagIdUpdates,
      reverseTagIdDeletes,
    ),
    unfiledItemIds: patchSet(
      snapshot.unfiledItemIds,
      unfiledAdds,
      unfiledDeletes,
    ),
    untaggedItemIds: patchSet(
      snapshot.untaggedItemIds,
      untaggedAdds,
      untaggedDeletes,
    ),
    pdfCapableItemIds: patchSet(
      snapshot.pdfCapableItemIds,
      pdfAdds,
      pdfDeletes,
    ),
  });

  return {
    delta,
    affectedItemCount: topLevelIds.size,
  };
}

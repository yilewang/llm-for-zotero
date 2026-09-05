import { resolveContextAttachmentSupportFromMetadata } from "../../modules/contextPanel/contextAttachmentSupport";
import { isMineruSyncPackageTitle } from "../../modules/contextPanel/mineruSync";
import type {
  LibraryIndexAttachment,
  LibraryIndexChildNote,
  LibraryIndexCollection,
  LibraryIndexItem,
  LibraryIndexSearchableFields,
  LibraryIndexSnapshot,
  LibraryIndexTag,
} from "./contracts";
import { readonlyMap, readonlySet } from "./readonlyCollections";

type RawTag = string | { tag?: unknown; name?: unknown; type?: unknown };

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function field(item: Zotero.Item, name: string): string {
  try {
    return text(item.getField?.(name as _ZoteroTypes.Item.ItemField));
  } catch {
    return "";
  }
}

function timestamp(value: unknown): number {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function positiveIds(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => Math.floor(Number(value)))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  );
}

export function normalizeLibraryIndexText(value: unknown): string {
  const source = text(value);
  if (!source) return "";
  try {
    return source
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/[\p{P}\p{S}\s]+/gu, " ")
      .trim()
      .replace(/\s+/g, " ");
  } catch {
    return source.toLowerCase().replace(/\s+/g, " ").trim();
  }
}

/**
 * Normalize an exact tag identity without applying fuzzy search folding.
 *
 * Punctuation, symbols, accents, and internal whitespace are meaningful tag
 * content. Removing them would merge distinct Zotero tags such as `C` and
 * `C++`, so only canonical Unicode form, surrounding whitespace, and case are
 * normalized here.
 */
export function normalizeLibraryIndexTagIdentity(value: unknown): string {
  const source = text(value);
  if (!source) return "";
  try {
    return source.normalize("NFC").toLowerCase();
  } catch {
    return source.toLowerCase();
  }
}

export function sameStringMembers(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const members = new Set(left);
  return right.every((value) => members.has(value));
}

export function sameNumberMembers(
  left: readonly number[],
  right: readonly number[],
): boolean {
  if (left.length !== right.length) return false;
  const members = new Set(left);
  return right.every((value) => members.has(value));
}

function itemType(item: Zotero.Item): string {
  const direct = text((item as Zotero.Item & { itemType?: unknown }).itemType);
  if (direct) return direct;
  try {
    const id = Number(
      (item as Zotero.Item & { itemTypeID?: unknown }).itemTypeID,
    );
    const name = (
      Zotero as unknown as {
        ItemTypes?: { getName?: (itemTypeID: number) => unknown };
      }
    ).ItemTypes?.getName?.(id);
    return text(name) || "item";
  } catch {
    return "item";
  }
}

function creators(item: Zotero.Item): string[] {
  const out: string[] = [];
  try {
    for (const creator of item.getCreators?.() || []) {
      const name =
        text((creator as { name?: unknown }).name) ||
        [text(creator.firstName), text(creator.lastName)]
          .filter(Boolean)
          .join(" ");
      const normalized = normalizeLibraryIndexText(name);
      // Preserve creator rows, not just display-name values. Distinct people
      // can legitimately have the same rendered name, and authorship counts
      // are row-based even though search uses the normalized text.
      if (!normalized) continue;
      out.push(name);
    }
  } catch {
    // A malformed creator row should not discard the item.
  }
  return out;
}

function tags(item: Zotero.Item): { manual: string[]; automatic: string[] } {
  const manual = new Set<string>();
  const automatic = new Set<string>();
  try {
    for (const raw of (item.getTags?.() || []) as RawTag[]) {
      const name =
        typeof raw === "string" ? text(raw) : text(raw.tag ?? raw.name);
      if (!name) continue;
      if (typeof raw !== "string" && Number(raw.type) === 1) {
        automatic.add(name);
      } else {
        manual.add(name);
      }
    }
  } catch {
    // Treat malformed tag payloads as no tags.
  }
  const sort = (left: string, right: string) =>
    left.localeCompare(right, undefined, { sensitivity: "base" });
  return {
    manual: [...manual].sort(sort),
    automatic: [...automatic].sort(sort),
  };
}

function collectionIds(item: Zotero.Item): number[] {
  try {
    return positiveIds(item.getCollections?.() || []);
  } catch {
    return [];
  }
}

function noteTitle(item: Zotero.Item): string {
  try {
    return (
      text(
        (
          item as Zotero.Item & { getNoteTitle?: () => unknown }
        ).getNoteTitle?.(),
      ) ||
      text(item.getDisplayTitle?.()) ||
      `Note ${item.id}`
    );
  } catch {
    return `Note ${item.id}`;
  }
}

export function resolveLibraryName(libraryID: number): string {
  try {
    const libraries = (
      Zotero as unknown as {
        Libraries?: {
          getName?: (id: number) => unknown;
          get?: (id: number) => { name?: unknown } | undefined;
        };
      }
    ).Libraries;
    return (
      text(libraries?.getName?.(libraryID)) ||
      text(libraries?.get?.(libraryID)?.name) ||
      "My Library"
    );
  } catch {
    return "My Library";
  }
}

function attachmentRecord(
  attachment: Zotero.Item,
  parentItemId: number | undefined,
  index: number,
  total: number,
): LibraryIndexAttachment {
  const filename = text(
    (attachment as Zotero.Item & { attachmentFilename?: unknown })
      .attachmentFilename,
  );
  const contentType = text(attachment.attachmentContentType);
  const rawTitle = field(attachment, "title");
  const fallback = contentType
    ? (contentType.split("/").pop() || "attachment").toUpperCase()
    : "Attachment";
  const title =
    rawTitle || filename || (total > 1 ? `${fallback} ${index + 1}` : fallback);
  const support = resolveContextAttachmentSupportFromMetadata({
    contentType,
    filename,
  });
  const hasPdfMime = contentType.toLowerCase() === "application/pdf";
  const hasPdfFilename = filename.toLowerCase().endsWith(".pdf");
  const isPdf = hasPdfMime || hasPdfFilename;
  const isMineruPackage =
    isMineruSyncPackageTitle(title) || isMineruSyncPackageTitle(filename);
  return Object.freeze({
    attachmentId: attachment.id,
    libraryID: Number(attachment.libraryID) || 0,
    ...(parentItemId ? { parentItemId } : {}),
    title,
    filename,
    contentType: contentType || "application/octet-stream",
    isStandalone: !parentItemId,
    hasPdfMime,
    hasPdfFilename,
    isPdf,
    isContextEligiblePdf: support?.kind === "pdf" && !isMineruPackage,
    isMineruPackage,
  });
}

export function projectItem(item: Zotero.Item): {
  item: LibraryIndexItem;
  attachments: LibraryIndexAttachment[];
  childNoteIds: number[];
  childNotes: LibraryIndexChildNote[];
  attachmentTitles: string[];
} | null {
  const isStandaloneNote = Boolean(
    (item as Zotero.Item & { isNote?: () => boolean }).isNote?.() &&
    !item.parentID,
  );
  const isStandaloneAttachment = Boolean(
    item.isAttachment?.() && !item.parentID,
  );
  const isRegular = Boolean(item.isRegularItem?.());
  if (!isRegular && !isStandaloneNote && !isStandaloneAttachment) return null;

  const projectedAttachments: LibraryIndexAttachment[] = [];
  const childNoteIds: number[] = [];
  const childNotes: LibraryIndexChildNote[] = [];
  if (isRegular) {
    const ids = positiveIds(item.getAttachments?.() || []);
    ids.forEach((id, index) => {
      const child = Zotero.Items.get(id) || null;
      if (!child?.isAttachment?.()) return;
      projectedAttachments.push(
        attachmentRecord(child, item.id, index, ids.length),
      );
    });
    for (const id of positiveIds(
      (item as Zotero.Item & { getNotes?: () => unknown }).getNotes?.() || [],
    )) {
      const child = Zotero.Items.get(id) || null;
      if (
        child &&
        (child as Zotero.Item & { isNote?: () => boolean }).isNote?.()
      ) {
        childNoteIds.push(id);
        childNotes.push(
          Object.freeze({
            noteId: id,
            libraryID: Number(child.libraryID) || Number(item.libraryID) || 0,
            parentItemId: item.id,
            title: noteTitle(child),
          }),
        );
      }
    }
  } else if (isStandaloneAttachment) {
    projectedAttachments.push(attachmentRecord(item, undefined, 0, 1));
  }

  const creatorNames = isRegular ? creators(item) : [];
  const itemTags = tags(item);
  const date = isRegular ? field(item, "date") : "";
  const indexedYear = isRegular
    ? date.match(/\b(19|20)\d{2}\b/)?.[0] || field(item, "year")
    : "";
  const publicationTitle = isRegular ? field(item, "publicationTitle") : "";
  const venue = isRegular
    ? [
        publicationTitle,
        field(item, "journalAbbreviation"),
        field(item, "proceedingsTitle"),
        field(item, "conferenceName"),
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  const title = isStandaloneNote
    ? noteTitle(item)
    : isStandaloneAttachment
      ? projectedAttachments[0]?.title || `Attachment ${item.id}`
      : field(item, "title") ||
        text(item.getDisplayTitle?.()) ||
        `Item ${item.id}`;
  const dateAdded =
    text((item as Zotero.Item & { dateAdded?: unknown }).dateAdded) ||
    field(item, "dateAdded");
  const dateModified = text(item.dateModified);
  const record: LibraryIndexItem = Object.freeze({
    itemId: item.id,
    libraryID: Number(item.libraryID) || 0,
    itemType: isStandaloneNote
      ? "note"
      : isStandaloneAttachment
        ? "attachment"
        : itemType(item),
    kind: isStandaloneNote
      ? "standalone-note"
      : isStandaloneAttachment
        ? "standalone-attachment"
        : "regular",
    title,
    shortTitle: isRegular ? field(item, "shortTitle") : "",
    citationKey: isRegular ? field(item, "citationKey") : "",
    doi: isRegular ? field(item, "DOI") : "",
    creators: Object.freeze(creatorNames),
    firstCreator: isRegular
      ? text(item.firstCreator) ||
        field(item, "firstCreator") ||
        creatorNames[0] ||
        ""
      : "",
    publicationTitle,
    venue,
    date,
    year: indexedYear,
    abstractNote: isRegular ? field(item, "abstractNote") : "",
    extra: isRegular ? field(item, "extra") : "",
    tags: Object.freeze(itemTags.manual),
    automaticTags: Object.freeze(itemTags.automatic),
    collectionIds: Object.freeze(collectionIds(item)),
    attachmentIds: Object.freeze(
      projectedAttachments.map((attachment) => attachment.attachmentId),
    ),
    childNoteIds: Object.freeze(childNoteIds),
    dateAdded,
    dateModified,
    addedAt: timestamp(dateAdded),
    modifiedAt: timestamp(dateModified),
    deleted: Boolean((item as Zotero.Item & { deleted?: unknown }).deleted),
  });
  return {
    item: record,
    attachments: projectedAttachments,
    childNoteIds,
    childNotes,
    attachmentTitles: projectedAttachments.map(
      (attachment) => attachment.title,
    ),
  };
}

export function searchable(
  item: LibraryIndexItem,
  attachmentTitles: readonly string[],
): LibraryIndexSearchableFields {
  return Object.freeze({
    title: normalizeLibraryIndexText(item.title),
    shortTitle: normalizeLibraryIndexText(item.shortTitle),
    citationKey: normalizeLibraryIndexText(item.citationKey),
    doi: normalizeLibraryIndexText(item.doi),
    creators: normalizeLibraryIndexText(
      [...item.creators, item.firstCreator].filter(Boolean).join(" "),
    ),
    venue: normalizeLibraryIndexText(item.venue),
    date: normalizeLibraryIndexText(item.date),
    year: normalizeLibraryIndexText(item.year),
    tags: normalizeLibraryIndexText(
      [...item.tags, ...item.automaticTags].join(" "),
    ),
    attachmentTitles: normalizeLibraryIndexText(attachmentTitles.join(" ")),
    abstractNote: normalizeLibraryIndexText(item.abstractNote),
    extra: normalizeLibraryIndexText(item.extra),
  });
}

function collectionsForLibrary(libraryID: number): Zotero.Collection[] {
  try {
    return Zotero.Collections.getByLibrary(libraryID, true) || [];
  } catch {
    return [];
  }
}

function buildCollectionProjection(
  libraryID: number,
  items: ReadonlyMap<number, LibraryIndexItem>,
): Pick<
  LibraryIndexSnapshot,
  | "collectionById"
  | "directItemIdsByCollectionId"
  | "childCollectionIdsByCollectionId"
  | "collectionPathById"
> {
  const collectionById = new Map<number, LibraryIndexCollection>();
  const directItemIdsByCollectionId = new Map<number, Set<number>>();
  const childCollectionIdsByCollectionId = new Map<number, readonly number[]>();
  for (const collection of collectionsForLibrary(libraryID)) {
    const parent = Number(collection.parentID);
    collectionById.set(
      collection.id,
      Object.freeze({
        collectionId: collection.id,
        libraryID: Number(collection.libraryID) || libraryID,
        name: text(collection.name) || `Collection ${collection.id}`,
        parentCollectionId:
          Number.isFinite(parent) && parent > 0 ? Math.floor(parent) : 0,
        deleted: Boolean(
          (collection as Zotero.Collection & { deleted?: unknown }).deleted,
        ),
      }),
    );
    directItemIdsByCollectionId.set(
      collection.id,
      new Set(positiveIds(collection.getChildItems?.(true, false) || [])),
    );
    childCollectionIdsByCollectionId.set(
      collection.id,
      Object.freeze(
        positiveIds(collection.getChildCollections?.(true, false) || []),
      ),
    );
  }
  for (const item of items.values()) {
    for (const collectionId of item.collectionIds) {
      const set = directItemIdsByCollectionId.get(collectionId) || new Set();
      set.add(item.itemId);
      directItemIdsByCollectionId.set(collectionId, set);
    }
  }
  const collectionPathById = new Map<number, string>();
  const resolvePath = (id: number, seen = new Set<number>()): string => {
    const cached = collectionPathById.get(id);
    if (cached) return cached;
    const collection = collectionById.get(id);
    if (!collection) return "";
    if (seen.has(id)) return collection.name;
    seen.add(id);
    const parent = collection.parentCollectionId;
    const path =
      parent && collectionById.has(parent)
        ? `${resolvePath(parent, seen)} / ${collection.name}`
        : collection.name;
    collectionPathById.set(id, path);
    return path;
  };
  for (const id of collectionById.keys()) resolvePath(id);
  return {
    collectionById,
    directItemIdsByCollectionId: new Map(
      [...directItemIdsByCollectionId].map(([id, members]) => [
        id,
        readonlySet(members),
      ]),
    ),
    childCollectionIdsByCollectionId,
    collectionPathById,
  };
}

export function rebuildDerived(
  base: Pick<
    LibraryIndexSnapshot,
    | "libraryID"
    | "libraryName"
    | "epoch"
    | "builtAt"
    | "itemById"
    | "topLevelItemOrder"
    | "attachmentById"
    | "childAttachmentIdsByItemId"
    | "pdfAttachmentIdsByItemId"
    | "childNoteIdsByItemId"
    | "childNoteById"
    | "parentItemIdByChildId"
    | "searchableFieldsByItemId"
  >,
  collectionProjection?: ReturnType<typeof buildCollectionProjection>,
): LibraryIndexSnapshot {
  const tagMutable = new Map<
    string,
    { variants: Set<string>; manual: Set<number>; automatic: Set<number> }
  >();
  const unfiledItemIds = new Set<number>();
  const untaggedItemIds = new Set<number>();
  const pdfCapableItemIds = new Set<number>();
  for (const item of base.itemById.values()) {
    // Keep trashed items in the canonical snapshot so restore/trash queries
    // can resolve them, but exclude them from every ordinary derived view.
    if (item.deleted) continue;
    if (!item.collectionIds.length) unfiledItemIds.add(item.itemId);
    if (!item.tags.length && !item.automaticTags.length) {
      untaggedItemIds.add(item.itemId);
    }
    if ((base.pdfAttachmentIdsByItemId.get(item.itemId)?.length || 0) > 0) {
      pdfCapableItemIds.add(item.itemId);
    }
    const addTags = (values: readonly string[], automatic: boolean): void => {
      for (const value of values) {
        const normalized = normalizeLibraryIndexTagIdentity(value);
        if (!normalized) continue;
        const entry = tagMutable.get(normalized) || {
          variants: new Set<string>(),
          manual: new Set<number>(),
          automatic: new Set<number>(),
        };
        entry.variants.add(value);
        (automatic ? entry.automatic : entry.manual).add(item.itemId);
        tagMutable.set(normalized, entry);
      }
    };
    addTags(item.tags, false);
    addTags(item.automaticTags, true);
  }
  const tagByNormalizedName = new Map<string, LibraryIndexTag>();
  const normalizedTagNameByTagId = new Map<number, string>();
  const tagIdsByNormalizedName = new Map<string, readonly number[]>();
  for (const [normalizedName, entry] of tagMutable) {
    tagByNormalizedName.set(
      normalizedName,
      Object.freeze({
        normalizedName,
        displayVariants: Object.freeze([...entry.variants].sort()),
        manualItemIds: readonlySet(entry.manual),
        automaticItemIds: readonlySet(entry.automatic),
      }),
    );
    const tagIds = new Set<number>();
    for (const variant of entry.variants) {
      try {
        const tagId = Number(Zotero.Tags.getID(variant));
        if (Number.isFinite(tagId) && tagId > 0) {
          normalizedTagNameByTagId.set(tagId, normalizedName);
          tagIds.add(tagId);
        }
      } catch {
        // Tag-name reverse lookup is an optimization; item membership remains
        // correct even if an unusual tag cannot be resolved to an ID.
      }
    }
    if (tagIds.size) {
      tagIdsByNormalizedName.set(normalizedName, Object.freeze([...tagIds]));
    }
  }
  const collections =
    collectionProjection ||
    buildCollectionProjection(base.libraryID, base.itemById);
  return Object.freeze({
    ...base,
    ...collections,
    itemById: readonlyMap(base.itemById),
    attachmentById: readonlyMap(base.attachmentById),
    childAttachmentIdsByItemId: readonlyMap(base.childAttachmentIdsByItemId),
    pdfAttachmentIdsByItemId: readonlyMap(base.pdfAttachmentIdsByItemId),
    childNoteIdsByItemId: readonlyMap(base.childNoteIdsByItemId),
    childNoteById: readonlyMap(base.childNoteById),
    parentItemIdByChildId: readonlyMap(base.parentItemIdByChildId),
    searchableFieldsByItemId: readonlyMap(base.searchableFieldsByItemId),
    collectionById: readonlyMap(collections.collectionById),
    directItemIdsByCollectionId: readonlyMap(
      collections.directItemIdsByCollectionId,
    ),
    childCollectionIdsByCollectionId: readonlyMap(
      collections.childCollectionIdsByCollectionId,
    ),
    collectionPathById: readonlyMap(collections.collectionPathById),
    tagByNormalizedName: readonlyMap(tagByNormalizedName),
    normalizedTagNameByTagId: readonlyMap(normalizedTagNameByTagId),
    tagIdsByNormalizedName: readonlyMap(tagIdsByNormalizedName),
    unfiledItemIds: readonlySet(unfiledItemIds),
    untaggedItemIds: readonlySet(untaggedItemIds),
    pdfCapableItemIds: readonlySet(pdfCapableItemIds),
  });
}

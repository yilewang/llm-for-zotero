export type LibraryIndexAttachment = Readonly<{
  attachmentId: number;
  libraryID: number;
  parentItemId?: number;
  title: string;
  filename: string;
  contentType: string;
  isStandalone: boolean;
  hasPdfMime: boolean;
  hasPdfFilename: boolean;
  isPdf: boolean;
  isContextEligiblePdf: boolean;
  isMineruPackage: boolean;
}>;

export type LibraryIndexItem = Readonly<{
  itemId: number;
  libraryID: number;
  itemType: string;
  kind: "regular" | "standalone-note" | "standalone-attachment";
  title: string;
  shortTitle: string;
  citationKey: string;
  doi: string;
  creators: readonly string[];
  firstCreator: string;
  publicationTitle: string;
  venue: string;
  date: string;
  year: string;
  abstractNote: string;
  extra: string;
  tags: readonly string[];
  automaticTags: readonly string[];
  collectionIds: readonly number[];
  attachmentIds: readonly number[];
  childNoteIds: readonly number[];
  dateAdded: string;
  dateModified: string;
  addedAt: number;
  modifiedAt: number;
  deleted: boolean;
}>;

export type LibraryIndexCollection = Readonly<{
  collectionId: number;
  libraryID: number;
  name: string;
  parentCollectionId: number;
  deleted: boolean;
}>;

export type LibraryIndexChildNote = Readonly<{
  noteId: number;
  libraryID: number;
  parentItemId: number;
  title: string;
}>;

export type LibraryIndexTag = Readonly<{
  normalizedName: string;
  displayVariants: readonly string[];
  manualItemIds: ReadonlySet<number>;
  automaticItemIds: ReadonlySet<number>;
}>;

export type LibraryIndexSearchableFields = Readonly<{
  title: string;
  shortTitle: string;
  citationKey: string;
  doi: string;
  creators: string;
  venue: string;
  date: string;
  year: string;
  tags: string;
  attachmentTitles: string;
  abstractNote: string;
  extra: string;
}>;

export type LibraryIndexSnapshot = Readonly<{
  libraryID: number;
  libraryName: string;
  epoch: number;
  builtAt: number;
  itemById: ReadonlyMap<number, LibraryIndexItem>;
  topLevelItemOrder: readonly number[];
  attachmentById: ReadonlyMap<number, LibraryIndexAttachment>;
  childAttachmentIdsByItemId: ReadonlyMap<number, readonly number[]>;
  pdfAttachmentIdsByItemId: ReadonlyMap<number, readonly number[]>;
  childNoteIdsByItemId: ReadonlyMap<number, readonly number[]>;
  childNoteById: ReadonlyMap<number, LibraryIndexChildNote>;
  parentItemIdByChildId: ReadonlyMap<number, number>;
  collectionById: ReadonlyMap<number, LibraryIndexCollection>;
  directItemIdsByCollectionId: ReadonlyMap<number, ReadonlySet<number>>;
  childCollectionIdsByCollectionId: ReadonlyMap<number, readonly number[]>;
  collectionPathById: ReadonlyMap<number, string>;
  tagByNormalizedName: ReadonlyMap<string, LibraryIndexTag>;
  normalizedTagNameByTagId: ReadonlyMap<number, string>;
  tagIdsByNormalizedName: ReadonlyMap<string, readonly number[]>;
  unfiledItemIds: ReadonlySet<number>;
  untaggedItemIds: ReadonlySet<number>;
  pdfCapableItemIds: ReadonlySet<number>;
  searchableFieldsByItemId: ReadonlyMap<number, LibraryIndexSearchableFields>;
}>;

export type LibraryIndexMetrics = Readonly<{
  fullBuilds: number;
  itemsGetAllCalls: number;
  projectedTopLevelItems: number;
  incrementalItemUpdates: number;
  incrementalCollectionUpdates: number;
  coalescedRebuilds: number;
  staleBuildDiscards: number;
}>;

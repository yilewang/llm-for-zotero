export type EditableArticleMetadataField =
  | "title"
  | "shortTitle"
  | "abstractNote"
  | "publicationTitle"
  | "journalAbbreviation"
  | "proceedingsTitle"
  | "date"
  | "volume"
  | "issue"
  | "pages"
  | "DOI"
  | "url"
  | "language"
  | "extra"
  | "ISSN"
  | "ISBN"
  | "publisher"
  | "place";

export type EditableArticleCreator = {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  fieldMode?: 0 | 1;
};

export type EditableArticleMetadataPatch = Partial<
  Record<EditableArticleMetadataField, string>
> & {
  creators?: EditableArticleCreator[];
};

export type EditableArticleMetadataSnapshot = {
  itemId: number;
  itemType: string;
  title: string;
  fields: Record<EditableArticleMetadataField, string>;
  creators: EditableArticleCreator[];
};

/**
 * An item's type with its exact stored fields and creators: what a type
 * change can lose, and what its undo puts back.
 */
export type ItemTypeRecord = {
  itemType: string;
  /** Every non-empty field, by the field name the type itself uses. */
  fields: Record<string, string>;
  /** Creators exactly as `getCreatorsJSON` returns them. */
  creators: EditableArticleCreator[];
};

/** What changing an item's type does, worked out before anything is written. */
export type ItemTypeChangePlan = {
  fromType: string;
  toType: string;
  /** Fields that lose their value, by name. */
  droppedFields: string[];
  /** The record Zotero will hold after the change, creator types remapped. */
  after: ItemTypeRecord;
};

export type BatchTagAssignment = {
  itemId: number;
  tags: string[];
};

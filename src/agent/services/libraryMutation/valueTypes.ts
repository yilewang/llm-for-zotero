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

export type BatchTagAssignment = {
  itemId: number;
  tags: string[];
};

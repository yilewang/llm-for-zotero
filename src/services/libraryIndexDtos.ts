import type { PaperContextRef } from "../shared/types";

export type PaperSearchAttachmentCandidate = {
  contextItemId: number;
  title: string;
  score: number;
  contentType?: string;
};

export type PaperSearchGroupCandidate = Omit<
  PaperContextRef,
  "contextItemId"
> & {
  attachments: PaperSearchAttachmentCandidate[];
  score: number;
  modifiedAt: number;
  addedAt?: number;
  collectionIds: number[];
  tags: string[];
  tagsAuto: string[];
  itemKind?: "standalone-note";
};

export type PaperBrowseCollectionCandidate = {
  collectionId: number;
  name: string;
  childCollections: PaperBrowseCollectionCandidate[];
  papers: PaperSearchGroupCandidate[];
};

export type PaperSearchTagCandidate = {
  name: string;
  normalizedName: string;
  count: number;
  includeAutomatic: boolean;
  isAutomatic: boolean;
  score: number;
};

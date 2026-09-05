import type { PaperContextRef } from "../../shared/types";

export type ZoteroItemIdentity = Readonly<{
  itemId: number;
  libraryID: number;
  key?: string;
  itemType: string;
}>;

export type ZoteroCreator = Readonly<{
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  fieldMode: 0 | 1;
}>;

export type ZoteroSemanticValue = Readonly<{
  value: string;
  sourceField: string;
}>;

export type ZoteroBibliographicSemantics = Readonly<{
  title?: ZoteroSemanticValue;
  abstract?: ZoteroSemanticValue;
  publicationDate?: ZoteroSemanticValue;
  year?: ZoteroSemanticValue;
  citationKey?: ZoteroSemanticValue;
  doi?: ZoteroSemanticValue;
  containerTitle?: ZoteroSemanticValue;
  eventTitle?: ZoteroSemanticValue;
  journalAbbreviation?: ZoteroSemanticValue;
}>;

export type ResolvedBibliographicItem = Readonly<{
  identity: ZoteroItemIdentity;
  bibliography: ZoteroBibliographicSemantics;
  creators: readonly ZoteroCreator[];
  displayTitle?: string;
  firstCreator?: string;
}>;

export type ResolvedAttachmentMetadata = Readonly<{
  identity: ZoteroItemIdentity;
  parentItemId?: number;
  title?: string;
  filename?: string;
  contentType?: string;
}>;

export type ResolvedPaperMetadata =
  | Readonly<{
      bibliographicItem: ResolvedBibliographicItem;
      contentSource?: ResolvedAttachmentMetadata;
    }>
  | Readonly<{
      bibliographicItem?: undefined;
      contentSource: ResolvedAttachmentMetadata;
    }>;

export type ResolvedZoteroSystemMetadata = Readonly<{
  dateAdded?: string;
  dateModified?: string;
  version?: number;
}>;

type ResolvedItemMetadataBase = Readonly<{
  identity: ZoteroItemIdentity;
  title: string;
  fields?: Readonly<Record<string, string>>;
  system?: ResolvedZoteroSystemMetadata;
}>;

export type ResolvedRegularItemMetadata = ResolvedItemMetadataBase &
  Readonly<{
    kind: "regular";
    bibliography: ZoteroBibliographicSemantics;
    creators: readonly ZoteroCreator[];
  }>;

export type ResolvedAttachmentItemMetadata = ResolvedItemMetadataBase &
  Readonly<{
    kind: "attachment";
    parentItemId?: number;
    filename?: string;
    contentType?: string;
  }>;

export type ResolvedNoteMetadata = ResolvedItemMetadataBase &
  Readonly<{
    kind: "note";
    noteKind: "item" | "standalone";
    parentItemId?: number;
  }>;

export type ResolvedItemMetadata =
  | ResolvedRegularItemMetadata
  | ResolvedAttachmentItemMetadata
  | ResolvedNoteMetadata;

export type ZoteroMetadataResolutionWarningCode =
  | "missing_content_source"
  | "invalid_content_source_relationship";

export type ZoteroMetadataResolutionWarning = Readonly<{
  code: ZoteroMetadataResolutionWarningCode;
  message: string;
}>;

export type ZoteroMetadataUnavailableReason =
  | "invalid_item_id"
  | "missing_item"
  | "unsupported_item_kind";

export type ZoteroMetadataResolution<T> =
  | Readonly<{
      status: "resolved";
      value: T;
      warnings: readonly ZoteroMetadataResolutionWarning[];
    }>
  | Readonly<{
      status: "unavailable";
      reason: ZoteroMetadataUnavailableReason;
      warnings: readonly ZoteroMetadataResolutionWarning[];
    }>;

export type ResolvedPaperMetadataResolution =
  ZoteroMetadataResolution<ResolvedPaperMetadata>;

export type ResolvedItemMetadataResolution =
  ZoteroMetadataResolution<ResolvedItemMetadata>;

export type ZoteroMetadataResolver = Readonly<{
  resolvePaperMetadata: (
    ref: PaperContextRef,
  ) => ResolvedPaperMetadataResolution;
  resolveItemMetadata: (
    itemId: number,
    options: {
      detail: "summary" | "complete";
      includeSystemMetadata?: boolean;
    },
  ) => ResolvedItemMetadataResolution;
}>;

export type ProjectedPaperMetadata = Readonly<{
  source: "live" | "stored_fallback";
  itemId: number;
  contextItemId: number;
  title?: string;
  abstract?: string;
  creators: readonly ZoteroCreator[];
  creatorDisplay?: string;
  firstCreator?: string;
  publicationDate?: string;
  year?: string;
  citationKey?: string;
  doi?: string;
  containerTitle?: string;
  containerSourceField?: string;
  eventTitle?: string;
  eventSourceField?: string;
  journalAbbreviation?: string;
  contentSource?: Readonly<{
    itemId: number;
    parentItemId?: number;
    title?: string;
    filename?: string;
    contentType?: string;
  }>;
  warnings: readonly ZoteroMetadataResolutionWarning[];
}>;

export type ZoteroTurnPaperMetadata = Readonly<{
  itemId: number;
  contextItemId: number;
  metadata: ProjectedPaperMetadata;
}>;

export type ZoteroTurnMetadataContext = Readonly<{
  papers: readonly ZoteroTurnPaperMetadata[];
}>;

export type LibraryReadMetadataV1 = Readonly<{
  schemaVersion: 1;
  kind: "regular" | "attachment" | "note";
  itemId: number;
  libraryID: number;
  key?: string;
  itemType: string;
  title: string;
  fields: Readonly<Record<string, string>>;
  creators?: readonly ZoteroCreator[];
  parentItemId?: number;
  filename?: string;
  contentType?: string;
  noteKind?: "item" | "standalone";
  system?: ResolvedZoteroSystemMetadata;
}>;

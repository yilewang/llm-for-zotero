import type {
  CollectionBrowseNode,
  CollectionSummary,
  DuplicateGroup,
  EditableArticleMetadataSnapshot,
  LibraryItemTarget,
  LibraryPaperTarget,
  RelatedPaperResult,
  ZoteroGateway,
} from "./zoteroGateway";

export type QueryLibraryEntity = "items" | "collections" | "notes";
export type QueryLibraryMode = "search" | "list" | "related" | "duplicates";
export type QueryLibraryInclude =
  | "metadata"
  | "attachments"
  | "tags"
  | "collections";

export type QueryLibraryFilters = {
  unfiled?: boolean;
  untagged?: boolean;
  hasPdf?: boolean;
  collectionId?: number;
  author?: string;
  yearFrom?: number;
  yearTo?: number;
  itemType?: string;
};

export type QueryLibraryItemResult = LibraryItemTarget & {
  metadata?: EditableArticleMetadataSnapshot | null;
  collections?: CollectionSummary[];
};


function includeField(
  includes: QueryLibraryInclude[] | undefined,
  field: QueryLibraryInclude,
): boolean {
  return Array.isArray(includes) && includes.includes(field);
}

function buildCollectionSummaries(
  zoteroGateway: ZoteroGateway,
  collectionIds: number[],
): CollectionSummary[] {
  return collectionIds
    .map((collectionId) => zoteroGateway.getCollectionSummary(collectionId))
    .filter((entry): entry is CollectionSummary => Boolean(entry));
}

function enrichPaperTarget(
  target: LibraryPaperTarget,
  zoteroGateway: ZoteroGateway,
  include: QueryLibraryInclude[] | undefined,
): QueryLibraryItemResult {
  const result: QueryLibraryItemResult = {
    itemId: target.itemId,
    itemType: (target as LibraryItemTarget).itemType || "journalArticle",
    title: target.title,
    firstCreator: target.firstCreator,
    year: target.year,
    attachments: includeField(include, "attachments") ? (target.attachments as LibraryItemTarget["attachments"]) : [],
    tags: includeField(include, "tags") ? target.tags : [],
    collectionIds: target.collectionIds,
  };
  if (includeField(include, "metadata")) {
    result.metadata = zoteroGateway.getEditableArticleMetadata(
      zoteroGateway.getItem(target.itemId),
    );
  }
  if (includeField(include, "collections")) {
    result.collections = buildCollectionSummaries(
      zoteroGateway,
      target.collectionIds,
    );
  }
  return result;
}

function enrichItemTarget(
  target: LibraryItemTarget,
  zoteroGateway: ZoteroGateway,
  include: QueryLibraryInclude[] | undefined,
): QueryLibraryItemResult {
  const result: QueryLibraryItemResult = {
    itemId: target.itemId,
    itemType: target.itemType,
    title: target.title,
    firstCreator: target.firstCreator,
    year: target.year,
    attachments: includeField(include, "attachments") ? target.attachments : [],
    tags: includeField(include, "tags") ? target.tags : [],
    collectionIds: target.collectionIds,
    noteKind: target.noteKind,
  };
  if (includeField(include, "metadata")) {
    result.metadata = zoteroGateway.getEditableArticleMetadata(
      zoteroGateway.getItem(target.itemId),
    );
  }
  if (includeField(include, "collections")) {
    result.collections = buildCollectionSummaries(zoteroGateway, target.collectionIds);
  }
  return result;
}


export class LibraryQueryService {
  constructor(private readonly zoteroGateway: ZoteroGateway) {}

  queryCollections(params: {
    libraryID: number;
    mode: "search" | "list";
    text?: string;
    limit?: number;
  }): {
    results: CollectionSummary[];
    warnings: string[];
  } {
    const query = `${params.text || ""}`.trim().toLowerCase();
    let results = this.zoteroGateway.listCollectionSummaries(params.libraryID);
    if (params.mode === "search" && query) {
      results = results.filter((collection) => {
        const haystack = `${collection.name} ${collection.path || ""}`.toLowerCase();
        return haystack.includes(query);
      });
    }
    const limit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit as number))
      : undefined;
    return {
      results: limit && results.length > limit ? results.slice(0, limit) : results,
      warnings: [],
    };
  }

  async listItems(params: {
    libraryID: number;
    filters?: QueryLibraryFilters;
    limit?: number;
    include?: QueryLibraryInclude[];
  }): Promise<{
    results: QueryLibraryItemResult[];
    totalCount: number;
    warnings: string[];
  }> {
    const filters = params.filters || {};
    // When hasPdf is explicitly true, use the PDF-only path for backwards compatibility
    if (filters.hasPdf === true) {
      return this.listPdfOnlyItems(params);
    }
    // Default: broadened path — all item types
    return this.listAllItems(params);
  }

  private async listPdfOnlyItems(params: {
    libraryID: number;
    filters?: QueryLibraryFilters;
    limit?: number;
    include?: QueryLibraryInclude[];
  }): Promise<{
    results: QueryLibraryItemResult[];
    totalCount: number;
    warnings: string[];
  }> {
    const filters = params.filters || {};
    let papersResult:
      | Awaited<ReturnType<ZoteroGateway["listLibraryPaperTargets"]>>
      | Awaited<ReturnType<ZoteroGateway["listCollectionPaperTargets"]>>
      | Awaited<ReturnType<ZoteroGateway["listUnfiledPaperTargets"]>>
      | Awaited<ReturnType<ZoteroGateway["listUntaggedPaperTargets"]>>;
    if (filters.collectionId) {
      papersResult = await this.zoteroGateway.listCollectionPaperTargets({
        libraryID: params.libraryID,
        collectionId: filters.collectionId,
        limit: params.limit,
      });
    } else if (filters.unfiled) {
      papersResult = await this.zoteroGateway.listUnfiledPaperTargets({
        libraryID: params.libraryID,
        limit: params.limit,
      });
    } else if (filters.untagged) {
      papersResult = await this.zoteroGateway.listUntaggedPaperTargets({
        libraryID: params.libraryID,
        limit: params.limit,
      });
    } else {
      papersResult = await this.zoteroGateway.listLibraryPaperTargets({
        libraryID: params.libraryID,
        limit: params.limit,
      });
    }
    let papers = papersResult.papers;
    if (filters.author) {
      const authorLower = filters.author.toLowerCase();
      papers = papers.filter(
        (p) => p.firstCreator?.toLowerCase().includes(authorLower),
      );
    }
    if (filters.yearFrom != null || filters.yearTo != null) {
      papers = papers.filter((p) => {
        const y = parseInt(p.year || "", 10);
        if (isNaN(y)) return false;
        if (filters.yearFrom != null && y < filters.yearFrom) return false;
        if (filters.yearTo != null && y > filters.yearTo) return false;
        return true;
      });
    }
    const enriched = papers.map((paper) =>
      enrichPaperTarget(paper, this.zoteroGateway, params.include),
    );
    return { results: enriched, totalCount: papers.length, warnings: [] };
  }

  async listAllItems(params: {
    libraryID: number;
    filters?: QueryLibraryFilters;
    limit?: number;
    include?: QueryLibraryInclude[];
  }): Promise<{
    results: QueryLibraryItemResult[];
    totalCount: number;
    warnings: string[];
  }> {
    const filters = params.filters || {};
    let itemsResult:
      | Awaited<ReturnType<ZoteroGateway["listLibraryItemTargets"]>>
      | Awaited<ReturnType<ZoteroGateway["listCollectionItemTargets"]>>
      | Awaited<ReturnType<ZoteroGateway["listUnfiledItemTargets"]>>
      | Awaited<ReturnType<ZoteroGateway["listUntaggedItemTargets"]>>;
    if (filters.collectionId) {
      itemsResult = await this.zoteroGateway.listCollectionItemTargets({
        libraryID: params.libraryID,
        collectionId: filters.collectionId,
        limit: params.limit,
        itemType: filters.itemType,
      });
    } else if (filters.unfiled) {
      itemsResult = await this.zoteroGateway.listUnfiledItemTargets({
        libraryID: params.libraryID,
        limit: params.limit,
        itemType: filters.itemType,
      });
    } else if (filters.untagged) {
      itemsResult = await this.zoteroGateway.listUntaggedItemTargets({
        libraryID: params.libraryID,
        limit: params.limit,
        itemType: filters.itemType,
      });
    } else {
      itemsResult = await this.zoteroGateway.listLibraryItemTargets({
        libraryID: params.libraryID,
        limit: params.limit,
        itemType: filters.itemType,
      });
    }
    let items = itemsResult.items;
    if (filters.author) {
      const authorLower = filters.author.toLowerCase();
      items = items.filter((p) => p.firstCreator?.toLowerCase().includes(authorLower));
    }
    if (filters.yearFrom != null || filters.yearTo != null) {
      items = items.filter((p) => {
        const y = parseInt(p.year || "", 10);
        if (isNaN(y)) return false;
        if (filters.yearFrom != null && y < filters.yearFrom) return false;
        if (filters.yearTo != null && y > filters.yearTo) return false;
        return true;
      });
    }
    const enriched = items.map((item) =>
      enrichItemTarget(item, this.zoteroGateway, params.include),
    );
    return { results: enriched, totalCount: items.length, warnings: [] };
  }

  async searchItems(params: {
    libraryID: number;
    text: string;
    limit?: number;
    include?: QueryLibraryInclude[];
    excludeContextItemId?: number | null;
    allItemTypes?: boolean;
  }): Promise<{
    results: QueryLibraryItemResult[];
    warnings: string[];
  }> {
    // Default to broadened search (all item types)
    const results = await this.zoteroGateway.searchAllLibraryItems({
      libraryID: params.libraryID,
      query: params.text,
      limit: params.limit,
    });
    const enriched = results.map((item) =>
      enrichItemTarget(item, this.zoteroGateway, params.include),
    );
    return { results: enriched, warnings: [] };
  }

  async listStandaloneNotes(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    results: QueryLibraryItemResult[];
    totalCount: number;
    warnings: string[];
  }> {
    const result = await this.zoteroGateway.listStandaloneNotes({
      libraryID: params.libraryID,
      limit: params.limit,
    });
    const enriched = result.notes.map((note) => ({
      itemId: note.itemId,
      itemType: note.itemType,
      title: note.title,
      attachments: [],
      tags: note.tags,
      collectionIds: note.collectionIds,
      noteKind: note.noteKind,
    } as QueryLibraryItemResult));
    return { results: enriched, totalCount: result.totalCount, warnings: [] };
  }

  async searchNotes(params: {
    libraryID: number;
    text: string;
    limit?: number;
  }): Promise<{
    results: Array<QueryLibraryItemResult & { parentItemId?: number; parentItemTitle?: string }>;
    warnings: string[];
  }> {
    const results = await this.zoteroGateway.searchAllNotes({
      libraryID: params.libraryID,
      query: params.text,
      limit: params.limit,
    });
    return { results, warnings: [] };
  }

  async findRelatedItems(params: {
    libraryID: number;
    referenceItemId: number;
    limit?: number;
    include?: QueryLibraryInclude[];
  }): Promise<{
    referenceTitle: string;
    results: Array<
      RelatedPaperResult & {
        metadata?: EditableArticleMetadataSnapshot | null;
        collections?: CollectionSummary[];
      }
    >;
    warnings: string[];
  }> {
    const result = await this.zoteroGateway.findRelatedPapersInLibrary({
      libraryID: params.libraryID,
      referenceItemId: params.referenceItemId,
      limit: params.limit,
    });
    return {
      referenceTitle: result.referenceTitle,
      results: result.relatedPapers.map((paper) => ({
        ...paper,
        metadata: includeField(params.include, "metadata")
          ? this.zoteroGateway.getEditableArticleMetadata(
              this.zoteroGateway.getItem(paper.itemId),
            )
          : undefined,
        collections: includeField(params.include, "collections")
          ? buildCollectionSummaries(this.zoteroGateway, paper.collectionIds)
          : undefined,
      })),
      warnings: [],
    };
  }

  async detectDuplicates(params: {
    libraryID: number;
    limit?: number;
    include?: QueryLibraryInclude[];
  }): Promise<{
    totalGroups: number;
    results: Array<
      DuplicateGroup & {
        papers: Array<
          DuplicateGroup["papers"][number] & {
            metadata?: EditableArticleMetadataSnapshot | null;
            collections?: CollectionSummary[];
          }
        >;
      }
    >;
    warnings: string[];
  }> {
    const result = await this.zoteroGateway.detectDuplicatesInLibrary({
      libraryID: params.libraryID,
      limit: params.limit,
    });
    return {
      totalGroups: result.totalGroups,
      results: result.groups.map((group) => ({
        ...group,
        papers: group.papers.map((paper) => ({
          ...paper,
          metadata: includeField(params.include, "metadata")
            ? this.zoteroGateway.getEditableArticleMetadata(
                this.zoteroGateway.getItem(paper.itemId),
              )
            : undefined,
          collections: includeField(params.include, "collections")
            ? buildCollectionSummaries(this.zoteroGateway, paper.collectionIds)
            : undefined,
        })),
      })),
      warnings: [],
    };
  }

  async browseCollectionTree(params: {
    libraryID: number;
  }): Promise<{
    libraryID: number;
    libraryName: string;
    collections: CollectionBrowseNode[];
    unfiled: { name: string; paperCount: number };
  }> {
    return this.zoteroGateway.browseCollections({
      libraryID: params.libraryID,
    });
  }
}

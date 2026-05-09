import type {
  AgentLibraryFilters,
  CollectionBrowseNode,
  CollectionSummary,
  DuplicateGroup,
  EditableArticleMetadataSnapshot,
  LibraryItemTarget,
  LibraryPaperTarget,
  RelatedPaperResult,
  ZoteroGateway,
} from "./zoteroGateway";

export type QueryLibraryEntity =
  | "items"
  | "collections"
  | "notes"
  | "tags"
  | "libraries";
export type QueryLibraryMode = "search" | "list" | "related" | "duplicates";
export type QueryLibraryInclude =
  | "metadata"
  | "attachments"
  | "tags"
  | "collections"
  | "abstract";

export type QueryLibraryFilters = {
  unfiled?: boolean;
  untagged?: boolean;
  hasPdf?: boolean;
  collectionId?: number;
  author?: string;
  yearFrom?: number;
  yearTo?: number;
  itemType?: string;
  tag?: string;
};

export type QueryLibraryItemResult = LibraryItemTarget & {
  metadata?: EditableArticleMetadataSnapshot | null;
  collections?: CollectionSummary[];
  abstract?: string;
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
    attachments: includeField(include, "attachments")
      ? (target.attachments as LibraryItemTarget["attachments"])
      : [],
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
  if (includeField(include, "abstract") && !includeField(include, "metadata")) {
    const item = zoteroGateway.getItem(target.itemId);
    result.abstract = (item?.getField?.("abstractNote") as string) || "";
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
    result.collections = buildCollectionSummaries(
      zoteroGateway,
      target.collectionIds,
    );
  }
  if (includeField(include, "abstract") && !includeField(include, "metadata")) {
    const item = zoteroGateway.getItem(target.itemId);
    result.abstract = (item?.getField?.("abstractNote") as string) || "";
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
        const haystack =
          `${collection.name} ${collection.path || ""}`.toLowerCase();
        return haystack.includes(query);
      });
    }
    const limit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit as number))
      : undefined;
    return {
      results:
        limit && results.length > limit ? results.slice(0, limit) : results,
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
      papers = papers.filter((p) =>
        p.firstCreator?.toLowerCase().includes(authorLower),
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

    // untagged has no Zotero.Search equivalent — keep in-memory path via old gateway method
    if (filters.untagged) {
      const itemsResult = await this.zoteroGateway.listUntaggedItemTargets({
        libraryID: params.libraryID,
        limit: params.limit,
        itemType: filters.itemType,
      });
      let items = itemsResult.items;
      if (filters.author) {
        const q = filters.author.toLowerCase();
        items = items.filter((p) => p.firstCreator?.toLowerCase().includes(q));
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

    // All other filters pushed into Zotero.Search
    const agentFilters: AgentLibraryFilters = {
      collectionId: filters.collectionId,
      unfiled: filters.unfiled,
      itemType: filters.itemType,
      author: filters.author,
      yearFrom: filters.yearFrom,
      yearTo: filters.yearTo,
      tag: filters.tag,
    };
    const result = await this.zoteroGateway.listItemsByFilters({
      libraryID: params.libraryID,
      filters: agentFilters,
      limit: params.limit,
    });
    const enriched = result.items.map((item) =>
      enrichItemTarget(item, this.zoteroGateway, params.include),
    );
    return { results: enriched, totalCount: result.totalCount, warnings: [] };
  }

  async searchItems(params: {
    libraryID: number;
    text: string;
    filters?: QueryLibraryFilters;
    limit?: number;
    include?: QueryLibraryInclude[];
    excludeContextItemId?: number | null;
    allItemTypes?: boolean;
  }): Promise<{
    results: QueryLibraryItemResult[];
    warnings: string[];
  }> {
    const filters = params.filters || {};
    const agentFilters: AgentLibraryFilters | undefined =
      filters.collectionId ||
      filters.unfiled ||
      filters.itemType ||
      filters.author ||
      filters.yearFrom != null ||
      filters.yearTo != null ||
      filters.tag
        ? {
            collectionId: filters.collectionId,
            unfiled: filters.unfiled,
            itemType: filters.itemType,
            author: filters.author,
            yearFrom: filters.yearFrom,
            yearTo: filters.yearTo,
            tag: filters.tag,
          }
        : undefined;
    const results = await this.zoteroGateway.searchAllLibraryItems({
      libraryID: params.libraryID,
      query: params.text,
      filters: agentFilters,
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
    const enriched = result.notes.map(
      (note) =>
        ({
          itemId: note.itemId,
          itemType: note.itemType,
          title: note.title,
          attachments: [],
          tags: note.tags,
          collectionIds: note.collectionIds,
          noteKind: note.noteKind,
        }) as QueryLibraryItemResult,
    );
    return { results: enriched, totalCount: result.totalCount, warnings: [] };
  }

  async searchNotes(params: {
    libraryID: number;
    text: string;
    limit?: number;
  }): Promise<{
    results: Array<
      QueryLibraryItemResult & {
        parentItemId?: number;
        parentItemTitle?: string;
      }
    >;
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

  async queryTags(params: {
    libraryID: number;
    query?: string;
    limit?: number;
  }): Promise<{
    results: { name: string; type: number }[];
    warnings: string[];
  }> {
    const results = await this.zoteroGateway.listLibraryTags(params);
    return { results, warnings: [] };
  }

  async browseCollectionTree(params: { libraryID: number }): Promise<{
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

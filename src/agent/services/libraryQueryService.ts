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
  | "libraries"
  | "itemTypes"
  | "savedSearches";
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
  /**
   * List the trash rather than the library. Zotero excludes trashed items
   * from every search unless told otherwise, so without this nothing could
   * enumerate what was in the trash -- which made restoring anything the
   * user had deleted impossible.
   */
  deleted?: boolean;
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
  const metadataItem = zoteroGateway.getItem(target.itemId);
  const itemType =
    (target as LibraryItemTarget).itemType ||
    zoteroGateway.getEditableArticleMetadata(metadataItem)?.itemType ||
    "journalArticle";
  const result: QueryLibraryItemResult = {
    itemId: target.itemId,
    itemType,
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

function queryItemResultHasPdf(target: LibraryItemTarget): boolean {
  return target.attachments.some((attachment) => {
    const contentType = `${attachment.contentType || ""}`.trim().toLowerCase();
    const title = `${attachment.title || ""}`.trim().toLowerCase();
    return (
      contentType === "application/pdf" ||
      title.endsWith(".pdf") ||
      title === "pdf"
    );
  });
}

function applyLimit<T>(items: T[], limit: unknown): T[] {
  const normalizedLimit =
    Number.isFinite(limit) && Number(limit) > 0
      ? Math.max(1, Math.floor(Number(limit)))
      : undefined;
  return normalizedLimit && items.length > normalizedLimit
    ? items.slice(0, normalizedLimit)
    : items;
}

/**
 * `dateModified` is deliberately absent: neither LibraryPaperTarget nor
 * LibraryItemTarget carries the field, so sorting by it would read "" for
 * every row and silently do nothing. Add the field to those targets before
 * adding the key back.
 */
export type LibrarySortKey = "dateAdded" | "title";
export type LibrarySortOrder = "asc" | "desc";

function readSortValue(entry: unknown, key: LibrarySortKey): string {
  const record =
    entry && typeof entry === "object"
      ? (entry as Record<string, unknown>)
      : {};
  const value = record[key];
  return typeof value === "string" ? value : "";
}

/**
 * Orders results before the window is taken.
 *
 * There was no sort of any kind, and `applyLimit` is a head slice, so "the 50
 * most recently added papers" was simply not expressible — even though
 * `dateAdded` has always been on the item targets and `autoTag` sorts by it
 * internally.
 */
export function applySort<T>(items: T[], sort: unknown, order: unknown): T[] {
  if (sort !== "dateAdded" && sort !== "title") {
    return items;
  }
  const key = sort as LibrarySortKey;
  // Titles default ascending, dates default descending ("most recent first"
  // is what someone asking for recent papers means).
  const descending = key === "title" ? order === "desc" : order !== "asc";
  return [...items].sort((left, right) => {
    const a = readSortValue(left, key);
    const b = readSortValue(right, key);
    // Empty values sort last in BOTH directions, so undated items never
    // displace real hits. Reversing a sorted array would have floated them to
    // the top of a descending list, which is why the direction is applied
    // inside the comparator rather than afterwards.
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    const compared =
      key === "title" ? a.localeCompare(b) : a < b ? -1 : a > b ? 1 : 0;
    return descending ? -compared : compared;
  });
}

/**
 * Takes a window after sorting. Without this every list was a head slice, so
 * a chain could never walk past the first page of its own results.
 */
export function applyOffset<T>(items: T[], offset: unknown): T[] {
  const normalized =
    Number.isFinite(offset) && Number(offset) > 0
      ? Math.floor(Number(offset))
      : 0;
  return normalized > 0 ? items.slice(normalized) : items;
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
    totalCount: number;
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
      totalCount: results.length,
      warnings: [],
    };
  }

  async listItems(params: {
    libraryID: number;
    filters?: QueryLibraryFilters;
    limit?: number;
    offset?: number;
    sort?: LibrarySortKey;
    order?: LibrarySortOrder;
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
    offset?: number;
    sort?: LibrarySortKey;
    order?: LibrarySortOrder;
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
      });
    } else if (filters.unfiled) {
      papersResult = await this.zoteroGateway.listUnfiledPaperTargets({
        libraryID: params.libraryID,
      });
    } else if (filters.untagged) {
      papersResult = await this.zoteroGateway.listUntaggedPaperTargets({
        libraryID: params.libraryID,
      });
    } else {
      papersResult = await this.zoteroGateway.listLibraryPaperTargets({
        libraryID: params.libraryID,
      });
    }
    let papers = papersResult.papers;
    if (filters.itemType) {
      const expectedType = filters.itemType.toLowerCase();
      papers = papers.filter((paper) => {
        const itemType =
          this.zoteroGateway.getEditableArticleMetadata(
            this.zoteroGateway.getItem(paper.itemId),
          )?.itemType || "";
        return itemType.toLowerCase() === expectedType;
      });
    }
    if (filters.author) {
      const authorLower = filters.author.toLowerCase();
      papers = papers.filter((p) =>
        p.firstCreator?.toLowerCase().includes(authorLower),
      );
    }
    if (filters.tag) {
      papers = papers.filter((paper) =>
        paper.tags.some((tag) => tag === filters.tag),
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
    const totalCount = papers.length;
    // The hasPdf:true short-circuit used to drop sort and offset silently, so
    // a schema that advertised them lied on this path.
    const limitedPapers = applyLimit(
      applyOffset(applySort(papers, params.sort, params.order), params.offset),
      params.limit,
    );
    const enriched = limitedPapers.map((paper) =>
      enrichPaperTarget(paper, this.zoteroGateway, params.include),
    );
    return { results: enriched, totalCount, warnings: [] };
  }

  async listAllItems(params: {
    libraryID: number;
    filters?: QueryLibraryFilters;
    limit?: number;
    offset?: number;
    sort?: LibrarySortKey;
    order?: LibrarySortOrder;
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
        itemType: filters.itemType,
      });
      let items = itemsResult.items;
      if (filters.hasPdf !== undefined) {
        items = items.filter(
          (item) => queryItemResultHasPdf(item) === filters.hasPdf,
        );
      }
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
      const totalCount = items.length;
      const windowed = applyLimit(
        applyOffset(applySort(items, params.sort, params.order), params.offset),
        params.limit,
      );
      const enriched = windowed.map((item) =>
        enrichItemTarget(item, this.zoteroGateway, params.include),
      );
      return { results: enriched, totalCount, warnings: [] };
    }

    // All other filters pushed into Zotero.Search
    const agentFilters: AgentLibraryFilters = {
      collectionId: filters.collectionId,
      unfiled: filters.unfiled,
      hasPdf: filters.hasPdf,
      itemType: filters.itemType,
      author: filters.author,
      yearFrom: filters.yearFrom,
      yearTo: filters.yearTo,
      tag: filters.tag,
      deleted: filters.deleted,
    };
    const result = await this.zoteroGateway.listItemsByFilters({
      libraryID: params.libraryID,
      filters: agentFilters,
      limit: params.limit,
      offset: params.offset,
      sort: params.sort,
      order: params.order,
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
    totalCount: number;
    warnings: string[];
  }> {
    const filters = params.filters || {};
    const agentFilters: AgentLibraryFilters | undefined =
      filters.collectionId ||
      filters.unfiled ||
      filters.hasPdf !== undefined ||
      filters.itemType ||
      filters.author ||
      filters.yearFrom != null ||
      filters.yearTo != null ||
      filters.tag
        ? {
            collectionId: filters.collectionId,
            unfiled: filters.unfiled,
            hasPdf: filters.hasPdf,
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
    const enriched = results.items.map((item) =>
      enrichItemTarget(item, this.zoteroGateway, params.include),
    );
    return { results: enriched, totalCount: results.totalCount, warnings: [] };
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

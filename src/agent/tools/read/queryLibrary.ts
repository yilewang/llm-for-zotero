import type { PaperContextRef } from "../../../shared/types";
import type { AgentToolDefinition } from "../../types";
import {
  type LibrarySortKey,
  type LibrarySortOrder,
  LibraryQueryService,
  type QueryLibraryEntity,
  type QueryLibraryFilters,
  type QueryLibraryInclude,
  type QueryLibraryMode,
} from "../../services/libraryQueryService";
import type {
  AgentSearchCondition,
  ZoteroGateway,
} from "../../services/zoteroGateway";
import { fail, normalizePositiveInt, ok, validateObject } from "../shared";

type QueryLibraryInput = {
  entity: QueryLibraryEntity;
  mode: QueryLibraryMode;
  text?: string;
  refs?: Array<number | PaperContextRef>;
  filters?: QueryLibraryFilters;
  limit?: number;
  offset?: number;
  sort?: LibrarySortKey;
  order?: LibrarySortOrder;
  include?: QueryLibraryInclude[];
  view?: "flat" | "tree";
  conditions?: AgentSearchCondition[];
  joinMode?: "all" | "any";
  resolveToParents?: boolean;
  libraryID?: number;
};

const QUERY_LIBRARY_SHAPE_HINT =
  "entity and mode are required. Examples: " +
  "{ entity:'items', mode:'search', text:'memory' }, " +
  "{ entity:'items', mode:'duplicates' }, " +
  "{ entity:'collections', mode:'list', view:'tree' }";

const VALID_INCLUDE = new Set<QueryLibraryInclude>([
  "metadata",
  "attachments",
  "tags",
  "collections",
  "abstract",
]);

function normalizeInclude(value: unknown): QueryLibraryInclude[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const includes = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry): entry is QueryLibraryInclude =>
      VALID_INCLUDE.has(entry as QueryLibraryInclude),
    );
  return includes.length ? Array.from(new Set(includes)) : undefined;
}

/**
 * Reads `conditions[]` without validating the vocabulary.
 *
 * Whether a condition and operator actually pair up is Zotero's question, not
 * ours -- `Zotero.SearchConditions` is the authority and answers it at
 * execution time with the list of valid operators. Duplicating that table
 * here is how the nine hand-written filters came to exist in the first place.
 */
function normalizeConditions(
  value: unknown,
): AgentSearchCondition[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const conditions: AgentSearchCondition[] = [];
  for (const entry of value) {
    if (!validateObject<Record<string, unknown>>(entry)) continue;
    const condition =
      typeof entry.condition === "string" ? entry.condition.trim() : "";
    const operator =
      typeof entry.operator === "string" ? entry.operator.trim() : "";
    if (!condition) continue;
    conditions.push({
      condition,
      operator,
      value:
        typeof entry.value === "string" || typeof entry.value === "number"
          ? entry.value
          : undefined,
      mode: typeof entry.mode === "string" ? entry.mode.trim() : undefined,
      required: entry.required === true ? true : undefined,
    });
  }
  return conditions.length ? conditions : undefined;
}

function normalizeRef(value: unknown): number | PaperContextRef | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (!validateObject<Record<string, unknown>>(value)) return null;
  const itemId = normalizePositiveInt(value.itemId);
  const contextItemId = normalizePositiveInt(value.contextItemId);
  if (itemId && contextItemId) {
    return {
      itemId,
      contextItemId,
      title:
        typeof value.title === "string" && value.title.trim()
          ? value.title.trim()
          : `Paper ${itemId}`,
      attachmentTitle:
        typeof value.attachmentTitle === "string" &&
        value.attachmentTitle.trim()
          ? value.attachmentTitle.trim()
          : undefined,
      citationKey:
        typeof value.citationKey === "string" && value.citationKey.trim()
          ? value.citationKey.trim()
          : undefined,
      firstCreator:
        typeof value.firstCreator === "string" && value.firstCreator.trim()
          ? value.firstCreator.trim()
          : undefined,
      year:
        typeof value.year === "string" && value.year.trim()
          ? value.year.trim()
          : undefined,
    };
  }
  return itemId || null;
}

function normalizeRefs(
  value: unknown,
): Array<number | PaperContextRef> | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value
    .map((entry) => normalizeRef(entry))
    .filter((entry): entry is number | PaperContextRef => Boolean(entry));
  return refs.length ? refs : undefined;
}

function normalizeFilters(value: unknown): QueryLibraryFilters | undefined {
  if (!validateObject<Record<string, unknown>>(value)) return undefined;
  const collectionId = normalizePositiveInt(value.collectionId);
  return {
    unfiled: value.unfiled === true || value.unfiled === "true",
    untagged: value.untagged === true || value.untagged === "true",
    hasPdf:
      value.hasPdf === true || value.hasPdf === false
        ? Boolean(value.hasPdf)
        : undefined,
    collectionId,
    author:
      typeof value.author === "string" && value.author.trim()
        ? value.author.trim()
        : undefined,
    yearFrom:
      typeof value.yearFrom === "number" && Number.isFinite(value.yearFrom)
        ? Math.floor(value.yearFrom)
        : undefined,
    yearTo:
      typeof value.yearTo === "number" && Number.isFinite(value.yearTo)
        ? Math.floor(value.yearTo)
        : undefined,
    itemType:
      typeof value.itemType === "string" && value.itemType.trim()
        ? value.itemType.trim()
        : undefined,
    tag:
      typeof value.tag === "string" && value.tag.trim()
        ? value.tag.trim()
        : undefined,
    deleted: value.deleted === true || value.deleted === "true",
  };
}

function normalizeLegacyQueryLibraryArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...args };
  const query =
    typeof normalized.query === "string" && normalized.query.trim()
      ? normalized.query.trim()
      : "";
  const text =
    typeof normalized.text === "string" && normalized.text.trim()
      ? normalized.text.trim()
      : "";
  const topLevelCollectionId = normalizePositiveInt(normalized.collectionId);

  if (topLevelCollectionId) {
    const filters = validateObject<Record<string, unknown>>(normalized.filters)
      ? { ...normalized.filters }
      : {};
    if (!normalizePositiveInt(filters.collectionId)) {
      filters.collectionId = topLevelCollectionId;
    }
    normalized.filters = filters;
    delete normalized.collectionId;
    if (!normalized.entity && normalized.mode === "list") {
      normalized.entity = "items";
    }
  }

  if (!normalized.entity && !normalized.mode && query) {
    normalized.entity = "items";
    normalized.mode = "search";
    normalized.text = query;
  }
  if (normalized.mode === "query" && (query || text)) {
    if (!normalized.entity) normalized.entity = "items";
    normalized.mode = "search";
    normalized.text = text || query;
  }
  if (!normalized.entity && normalized.mode === "duplicates") {
    normalized.entity = "items";
  }
  if (
    normalized.entity === "collections" &&
    !normalized.mode &&
    normalized.view === "tree"
  ) {
    normalized.mode = "list";
  }
  if (!normalized.text && query && normalized.mode === "search") {
    normalized.text = query;
  }
  delete normalized.query;
  return normalized;
}

function resolveReferenceItemId(
  input: QueryLibraryInput,
  context: Parameters<
    AgentToolDefinition<QueryLibraryInput, unknown>["execute"]
  >[1],
  zoteroGateway: ZoteroGateway,
): number | null {
  const firstRef = input.refs?.[0];
  if (typeof firstRef === "number") return firstRef;
  if (firstRef && typeof firstRef === "object") return firstRef.itemId;
  const contextualPaper = zoteroGateway.listPaperContexts(context.request)[0];
  if (contextualPaper?.itemId) {
    return contextualPaper.itemId;
  }
  if (
    context.request.conversationKind === "global" ||
    context.request.turnPaperScope.collections.length ||
    context.request.turnPaperScope.tags.length
  ) {
    return null;
  }
  const activePaperContext = zoteroGateway.getActivePaperContext(
    context.item || zoteroGateway.getItem(context.request.activeItemId),
  );
  if (activePaperContext?.itemId) {
    return activePaperContext.itemId;
  }
  return normalizePositiveInt(context.request.activeItemId) || null;
}

function withResultCounts<T extends { results: unknown[] }>(
  payload: T,
  params: {
    totalCount?: number;
  } = {},
): T & { totalCount: number; returnedCount: number; limited: boolean } {
  const returnedCount = payload.results.length;
  const totalCount =
    Number.isFinite(params.totalCount) && Number(params.totalCount) >= 0
      ? Math.floor(Number(params.totalCount))
      : returnedCount;
  return {
    ...payload,
    totalCount,
    returnedCount,
    limited: totalCount > returnedCount,
  };
}

export function createQueryLibraryTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<QueryLibraryInput, unknown> {
  const queryService = new LibraryQueryService(zoteroGateway);
  return {
    spec: {
      name: "query_library",
      description:
        "Discover Zotero items and collections. Every call must include entity and mode. Use text, not query, for search terms. Use it to search or list any item type (papers, books, notes, web pages, and more), filter by author/year/collection/itemType, browse the collection tree, find related papers, detect duplicates, or list standalone notes. By default returns all item types; use filters.hasPdf:true for PDF-backed papers only. For 'how many papers/items...' questions, use totalCount/returnedCount/limited instead of hand-counting the returned rows. " +
        "For anything the simple filters cannot express, pass conditions[] — Zotero's own advanced-search vocabulary, covering full text, abstract, DOI, publisher, dates added or modified, note and annotation text, citation key, retraction status and every other condition. Use filters.deleted:true to list the trash.",
      inputSchema: {
        type: "object",
        required: ["entity", "mode"],
        additionalProperties: false,
        properties: {
          entity: {
            type: "string",
            enum: [
              "items",
              "collections",
              "notes",
              "tags",
              "libraries",
              "itemTypes",
              "savedSearches",
            ],
            description:
              "What to query: 'items' for any library item, 'collections' for folders, 'notes' to search/list notes (mode:'search' finds all notes including child notes, mode:'list' lists standalone notes only), 'tags' to list/search all tags in the library, 'libraries' to enumerate all libraries (personal + group), 'itemTypes' to discover Zotero's item types and the exact fields and creator types each one accepts (use this before creating an item or setting an unfamiliar field — a field the type does not have is rejected, not ignored), 'savedSearches' to list the library's saved searches and the conditions behind them.",
          },
          mode: {
            type: "string",
            enum: ["search", "list", "related", "duplicates"],
          },
          text: { type: "string" },
          refs: {
            type: "array",
            items: {
              anyOf: [
                { type: "number" },
                {
                  type: "object",
                  additionalProperties: true,
                },
              ],
            },
          },
          filters: {
            type: "object",
            additionalProperties: false,
            properties: {
              unfiled: { type: "boolean" },
              untagged: { type: "boolean" },
              hasPdf: {
                type: "boolean",
                description:
                  "Set true to count/search PDF-backed paper-style items only; combine with itemType for narrower paper counts.",
              },
              collectionId: { type: "number" },
              author: {
                type: "string",
                description: "Filter by author name (substring match)",
              },
              yearFrom: {
                type: "number",
                description: "Include items from this year onward (inclusive)",
              },
              yearTo: {
                type: "number",
                description: "Include items up to this year (inclusive)",
              },
              itemType: {
                type: "string",
                description:
                  "Filter by Zotero item type, e.g. 'book', 'note', 'webpage', 'journalArticle', 'conferencePaper'. Only used with entity:'items'.",
              },
              tag: {
                type: "string",
                description:
                  "Filter by exact tag name (e.g. 'machine learning'). Only items with this tag are returned.",
              },
              deleted: {
                type: "boolean",
                description:
                  "Set true to list the trash instead of the library. Needed before restoring anything, since nothing else can enumerate what is in the trash.",
              },
            },
          },
          conditions: {
            type: "array",
            description:
              "Advanced search clauses, forwarded to Zotero's own search engine. Use this for anything the nine simple filters cannot express — fulltextContent, abstractNote, DOI, publisher, dateAdded, dateModified, note, annotationText, citationKey, retracted, publications, and every other Zotero search condition. Only valid with entity:'items'.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["condition", "operator"],
              properties: {
                condition: {
                  type: "string",
                  description:
                    "A Zotero search condition, e.g. 'title', 'abstractNote', 'fulltextContent', 'dateAdded', 'DOI', 'itemType', 'tag', 'collection', 'note', 'annotationText', 'citationKey', 'retracted'.",
                },
                operator: {
                  type: "string",
                  description:
                    "An operator the condition accepts, e.g. is, isNot, contains, doesNotContain, beginsWith, isBefore, isAfter, isInTheLast, isLessThan, isGreaterThan, true, false. An invalid pairing is rejected with the list of valid operators for that condition.",
                },
                value: {
                  description: "The value to compare against.",
                  anyOf: [{ type: "string" }, { type: "number" }],
                },
                mode: {
                  type: "string",
                  description:
                    "Sub-mode for conditions that take one, notably fulltextContent with 'phrase' or 'regexp'.",
                },
                required: {
                  type: "boolean",
                  description:
                    "Force this clause to be required even under joinMode:'any'.",
                },
              },
            },
          },
          joinMode: {
            type: "string",
            enum: ["all", "any"],
            description:
              "Whether every condition must match ('all', the default) or any one of them ('any'). Applies to conditions[].",
          },
          resolveToParents: {
            type: "boolean",
            description:
              "Return the parent paper for matches that are child items. Required for conditions that match children — fulltextContent, annotationText and childNote match an attachment or note, and without this those matches are dropped and the search looks empty.",
          },
          libraryID: {
            type: "number",
            description:
              "Search a specific library. Defaults to the active one; a group library ID searches that group instead.",
          },
          view: {
            type: "string",
            enum: ["flat", "tree"],
            description:
              "For entity:'collections' mode:'list': 'flat' returns a list, 'tree' returns the full hierarchy with paper counts. Default: flat.",
          },
          limit: { type: "number" },
          offset: {
            type: "number",
            description:
              "Skip this many results before returning. Use with limit to page through a large result set across several calls. Applies to entity:'items' with mode:'list'.",
          },
          sort: {
            type: "string",
            enum: ["dateAdded", "title"],
            description:
              "Order results before limit/offset are applied. Use sort:'dateAdded' for requests like 'the most recently added papers'. Applies to entity:'items' with mode:'list'; text search returns relevance order and ignores this.",
          },
          order: {
            type: "string",
            enum: ["asc", "desc"],
            description:
              "Sort direction. Defaults to 'desc' for dates (newest first) and 'asc' for title.",
          },
          include: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "metadata",
                "attachments",
                "tags",
                "collections",
                "abstract",
              ],
            },
          },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    guidance: {
      matches: (request) =>
        /\b(unfiled|folder|folders|collection|collections|move|file|organize|organise|categorize|categorise)\b/i.test(
          request.userText,
        ),
      instruction:
        "For library-organization requests, gather the item IDs first with library_search({ entity:'items', mode:'list', filters:{ unfiled:true } }) when needed. If the user wants you to file or move papers and the exact destination collection IDs are not known yet, call library_update with {kind:'collections', action:'add', itemIds:[...]} and let the confirmation card collect the target folders. Use library_search({ entity:'collections', mode:'list', view:'tree' }) when you need the collection hierarchy to prefill or explain choices.",
    },
    presentation: {
      label: "Query Library",
      summaries: {
        onCall: ({ args }) => {
          const entity =
            args && typeof args === "object"
              ? String((args as { entity?: unknown }).entity || "library")
              : "library";
          const mode =
            args && typeof args === "object"
              ? String((args as { mode?: unknown }).mode || "unspecified")
              : "unspecified";
          return `Querying ${entity} (${mode})`;
        },
        onSuccess: ({ content }) => {
          const treeCollections =
            content &&
            typeof content === "object" &&
            Array.isArray((content as { collections?: unknown[] }).collections)
              ? (content as { collections: unknown[] }).collections
              : [];
          const results =
            content &&
            typeof content === "object" &&
            Array.isArray((content as { results?: unknown[] }).results)
              ? (content as { results: unknown[] }).results
              : [];
          if (treeCollections.length > 0) {
            return `Loaded collection tree (${treeCollections.length} top-level folder${
              treeCollections.length === 1 ? "" : "s"
            })`;
          }
          const totalGroups = Number(
            content &&
              typeof content === "object" &&
              (content as { totalGroups?: unknown }).totalGroups
              ? (content as { totalGroups?: unknown }).totalGroups
              : 0,
          );
          if (totalGroups > 0) {
            return `Found ${totalGroups} duplicate group${
              totalGroups === 1 ? "" : "s"
            }`;
          }
          const totalCount = Number(
            content &&
              typeof content === "object" &&
              (content as { totalCount?: unknown }).totalCount
              ? (content as { totalCount?: unknown }).totalCount
              : results.length,
          );
          return totalCount > 0
            ? `Found ${totalCount} result${totalCount === 1 ? "" : "s"}${
                results.length < totalCount ? ` (${results.length} shown)` : ""
              }`
            : "No matching library results";
        },
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const normalizedArgs = normalizeLegacyQueryLibraryArgs(args);
      const entity =
        normalizedArgs.entity === "items" ||
        normalizedArgs.entity === "collections" ||
        normalizedArgs.entity === "notes" ||
        normalizedArgs.entity === "tags" ||
        normalizedArgs.entity === "libraries" ||
        normalizedArgs.entity === "itemTypes" ||
        normalizedArgs.entity === "savedSearches"
          ? (normalizedArgs.entity as QueryLibraryEntity)
          : null;
      const mode =
        normalizedArgs.mode === "search" ||
        normalizedArgs.mode === "list" ||
        normalizedArgs.mode === "related" ||
        normalizedArgs.mode === "duplicates"
          ? (normalizedArgs.mode as QueryLibraryMode)
          : null;
      if (!entity || !mode) {
        return fail(QUERY_LIBRARY_SHAPE_HINT);
      }
      if (entity === "collections" && !["search", "list"].includes(mode)) {
        return fail("collections only support mode:'search' or mode:'list'");
      }
      if (entity === "notes" && !["list", "search"].includes(mode)) {
        return fail("notes only support mode:'list' or mode:'search'");
      }
      if (entity === "tags" && !["list", "search"].includes(mode)) {
        return fail("tags only support mode:'list' or mode:'search'");
      }
      if (entity === "libraries" && mode !== "list") {
        return fail("libraries only support mode:'list'");
      }
      if (entity === "itemTypes" && !["list", "search"].includes(mode)) {
        return fail("itemTypes only support mode:'list' or mode:'search'");
      }
      if (entity === "savedSearches" && !["list", "search"].includes(mode)) {
        return fail("savedSearches only support mode:'list' or mode:'search'");
      }
      const conditions = normalizeConditions(normalizedArgs.conditions);
      if (conditions && entity !== "items") {
        return fail(
          "conditions[] is only valid with entity:'items'. Collections, notes, tags and libraries are not searched through Zotero's condition engine.",
        );
      }
      if (conditions) {
        // hasPdf routes to a different engine entirely and untagged is a JS
        // filter applied after the fact, so neither can honour a condition
        // set. Silently ignoring one of them would return a confidently wrong
        // result.
        const filters = normalizedArgs.filters as
          | Record<string, unknown>
          | undefined;
        const conflicting = ["hasPdf", "untagged"].filter(
          (key) => filters?.[key] !== undefined,
        );
        if (conflicting.length) {
          return fail(
            `filters.${conflicting.join(" and filters.")} cannot be combined with conditions[], because ${conflicting.length === 1 ? "it is" : "they are"} applied outside Zotero's search engine. Express the same thing as a condition, or drop conditions[].`,
          );
        }
      }
      if (
        (entity === "items" || entity === "notes") &&
        mode === "search" &&
        !conditions
      ) {
        const text =
          typeof normalizedArgs.text === "string"
            ? normalizedArgs.text.trim()
            : "";
        if (!text) {
          return fail(
            "text is required for search mode. Use library_search({ entity:'items', mode:'search', text:'<terms>' }), or pass conditions[] for an advanced search.",
          );
        }
      }
      if (mode === "related" && entity !== "items") {
        return fail("mode:'related' is only valid for entity:'items'");
      }
      const view =
        normalizedArgs.view === "tree"
          ? ("tree" as const)
          : normalizedArgs.view === "flat"
            ? ("flat" as const)
            : undefined;
      return ok<QueryLibraryInput>({
        entity,
        mode,
        conditions,
        joinMode:
          normalizedArgs.joinMode === "any" || normalizedArgs.joinMode === "all"
            ? normalizedArgs.joinMode
            : undefined,
        resolveToParents: normalizedArgs.resolveToParents === true,
        libraryID: normalizePositiveInt(normalizedArgs.libraryID),
        text:
          typeof normalizedArgs.text === "string" && normalizedArgs.text.trim()
            ? normalizedArgs.text.trim()
            : undefined,
        refs: normalizeRefs(normalizedArgs.refs),
        filters: normalizeFilters(normalizedArgs.filters),
        limit: normalizePositiveInt(normalizedArgs.limit),
        // offset is deliberately not normalizePositiveInt: 0 is a valid
        // starting offset and that helper rejects it.
        offset:
          Number.isFinite(normalizedArgs.offset) &&
          Number(normalizedArgs.offset) > 0
            ? Math.floor(Number(normalizedArgs.offset))
            : undefined,
        sort:
          normalizedArgs.sort === "dateAdded" || normalizedArgs.sort === "title"
            ? normalizedArgs.sort
            : undefined,
        // Pass the direction through verbatim. Collapsing anything that was
        // not "asc" to undefined made an explicit order:'desc' on a title
        // sort silently return A-Z.
        order:
          normalizedArgs.order === "asc" || normalizedArgs.order === "desc"
            ? normalizedArgs.order
            : undefined,
        include: normalizeInclude(normalizedArgs.include),
        view,
      });
    },
    execute: async (input, context) => {
      const libraryID =
        input.libraryID ||
        zoteroGateway.resolveLibraryID({
          request: context.request,
          item: context.item,
        });
      if (!libraryID) {
        throw new Error("No active library available");
      }
      if (input.conditions) {
        const result = await zoteroGateway.searchItemsByConditions({
          libraryID,
          conditions: input.conditions,
          joinMode: input.joinMode,
          resolveToParents: input.resolveToParents,
          includeTrashed: input.filters?.deleted === true,
          limit: input.limit,
          offset: input.offset,
        });
        return {
          entity: input.entity,
          mode: input.mode,
          results: result.items,
          totalCount: result.totalCount,
          returnedCount: result.returnedCount,
          offset: result.offset,
          // Present only when more remains, so its absence is a reliable
          // signal that the walk is finished.
          nextOffset: result.nextOffset,
          limited: result.nextOffset !== undefined,
          warnings: [],
        };
      }
      if (input.entity === "notes") {
        if (input.mode === "search") {
          const result = await queryService.searchNotes({
            libraryID,
            text: input.text || "",
            limit: input.limit,
          });
          return withResultCounts({
            entity: input.entity,
            mode: input.mode,
            results: result.results,
            warnings: result.warnings,
          });
        }
        // list mode
        const result = await queryService.listStandaloneNotes({
          libraryID,
          limit: input.limit,
        });
        return withResultCounts(
          {
            entity: input.entity,
            mode: input.mode,
            totalCount: result.totalCount,
            results: result.results,
            warnings: result.warnings,
          },
          { totalCount: result.totalCount },
        );
      }
      if (input.entity === "savedSearches") {
        const results = zoteroGateway.listSavedSearches(libraryID);
        const query = (input.text || "").trim().toLowerCase();
        const filtered =
          input.mode === "search" && query
            ? results.filter((entry) =>
                entry.name.toLowerCase().includes(query),
              )
            : results;
        return withResultCounts({
          entity: input.entity,
          mode: input.mode,
          results: filtered,
        });
      }
      if (input.entity === "itemTypes") {
        // Fields come back for a named type only. All ~35 types with their
        // full field lists is a large payload to spend on "what types exist".
        const result = zoteroGateway.listItemTypes({
          itemType: input.filters?.itemType || input.text,
        });
        return withResultCounts({
          entity: input.entity,
          mode: input.mode,
          results: result.itemTypes,
        });
      }
      if (input.entity === "libraries") {
        const results = zoteroGateway.listAllLibraries();
        return withResultCounts({
          entity: input.entity,
          mode: input.mode,
          results,
        });
      }
      if (input.entity === "tags") {
        const result = await queryService.queryTags({
          libraryID,
          query: input.mode === "search" ? input.text : undefined,
          limit: input.limit,
        });
        return withResultCounts({
          entity: input.entity,
          mode: input.mode,
          results: result.results,
          warnings: result.warnings,
        });
      }
      if (input.entity === "collections") {
        if (input.mode === "list" && input.view === "tree") {
          const tree = await queryService.browseCollectionTree({ libraryID });
          return {
            entity: input.entity,
            mode: input.mode,
            view: "tree",
            ...tree,
          };
        }
        const result = queryService.queryCollections({
          libraryID,
          mode: input.mode as "search" | "list",
          text: input.text,
          limit: input.limit,
        });
        return withResultCounts(
          {
            entity: input.entity,
            mode: input.mode,
            results: result.results,
            warnings: result.warnings,
          },
          { totalCount: result.totalCount },
        );
      }
      if (input.mode === "search") {
        const result = await queryService.searchItems({
          libraryID,
          text: input.text || "",
          filters: input.filters,
          limit: input.limit,
          include: input.include,
          excludeContextItemId:
            zoteroGateway.getActiveContextItem(context.item)?.id || null,
        });
        return withResultCounts(
          {
            entity: input.entity,
            mode: input.mode,
            results: result.results,
            warnings: result.warnings,
          },
          { totalCount: result.totalCount },
        );
      }
      if (input.mode === "list") {
        const result = await queryService.listItems({
          libraryID,
          filters: input.filters,
          limit: input.limit,
          offset: input.offset,
          sort: input.sort,
          order: input.order,
          include: input.include,
        });
        return withResultCounts(
          {
            entity: input.entity,
            mode: input.mode,
            totalCount: result.totalCount,
            results: result.results,
            warnings: result.warnings,
          },
          { totalCount: result.totalCount },
        );
      }
      if (input.mode === "related") {
        const referenceItemId = resolveReferenceItemId(
          input,
          context,
          zoteroGateway,
        );
        if (!referenceItemId) {
          throw new Error(
            "A reference paper is required for related-item queries",
          );
        }
        const result = await queryService.findRelatedItems({
          libraryID,
          referenceItemId,
          limit: input.limit,
          include: input.include,
        });
        return {
          entity: input.entity,
          mode: input.mode,
          referenceItemId,
          referenceTitle: result.referenceTitle,
          results: result.results,
          warnings: result.warnings,
        };
      }
      const result = await queryService.detectDuplicates({
        libraryID,
        limit: input.limit,
        include: input.include,
      });
      return {
        entity: input.entity,
        mode: input.mode,
        totalGroups: result.totalGroups,
        results: result.results,
        warnings: result.warnings,
      };
    },
  };
}

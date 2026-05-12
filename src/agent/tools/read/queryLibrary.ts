import type { PaperContextRef } from "../../../shared/types";
import type { AgentToolDefinition } from "../../types";
import {
  LibraryQueryService,
  type QueryLibraryEntity,
  type QueryLibraryFilters,
  type QueryLibraryInclude,
  type QueryLibraryMode,
} from "../../services/libraryQueryService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { fail, normalizePositiveInt, ok, validateObject } from "../shared";

type QueryLibraryInput = {
  entity: QueryLibraryEntity;
  mode: QueryLibraryMode;
  text?: string;
  refs?: Array<number | PaperContextRef>;
  filters?: QueryLibraryFilters;
  limit?: number;
  include?: QueryLibraryInclude[];
  view?: "flat" | "tree";
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

  if (!normalized.entity && !normalized.mode && query) {
    normalized.entity = "items";
    normalized.mode = "search";
    normalized.text = query;
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
        "Discover Zotero items and collections. Every call must include entity and mode. Use text, not query, for search terms. Use it to search or list any item type (papers, books, notes, web pages, and more), filter by author/year/collection/itemType, browse the collection tree, find related papers, detect duplicates, or list standalone notes. By default returns all item types; use filters.hasPdf:true for PDF-backed papers only. For 'how many papers/items...' questions, use totalCount/returnedCount/limited instead of hand-counting the returned rows.",
      inputSchema: {
        type: "object",
        required: ["entity", "mode"],
        additionalProperties: false,
        properties: {
          entity: {
            type: "string",
            enum: ["items", "collections", "notes", "tags", "libraries"],
            description:
              "What to query: 'items' for any library item, 'collections' for folders, 'notes' to search/list notes (mode:'search' finds all notes including child notes, mode:'list' lists standalone notes only), 'tags' to list/search all tags in the library, 'libraries' to enumerate all libraries (personal + group).",
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
            },
          },
          view: {
            type: "string",
            enum: ["flat", "tree"],
            description:
              "For entity:'collections' mode:'list': 'flat' returns a list, 'tree' returns the full hierarchy with paper counts. Default: flat.",
          },
          limit: { type: "number" },
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
              ? String((args as { mode?: unknown }).mode || "query")
              : "query";
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
        normalizedArgs.entity === "libraries"
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
      if ((entity === "items" || entity === "notes") && mode === "search") {
        const text =
          typeof normalizedArgs.text === "string"
            ? normalizedArgs.text.trim()
            : "";
        if (!text) {
          return fail(
            "text is required for search mode. Use library_search({ entity:'items', mode:'search', text:'<terms>' })",
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
        text:
          typeof normalizedArgs.text === "string" && normalizedArgs.text.trim()
            ? normalizedArgs.text.trim()
            : undefined,
        refs: normalizeRefs(normalizedArgs.refs),
        filters: normalizeFilters(normalizedArgs.filters),
        limit: normalizePositiveInt(normalizedArgs.limit),
        include: normalizeInclude(normalizedArgs.include),
        view,
      });
    },
    execute: async (input, context) => {
      const libraryID = zoteroGateway.resolveLibraryID({
        request: context.request,
        item: context.item,
      });
      if (!libraryID) {
        throw new Error("No active library available");
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

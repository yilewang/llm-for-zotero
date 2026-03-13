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
import {
  fail,
  normalizePositiveInt,
  ok,
  validateObject,
} from "../shared";

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

const VALID_INCLUDE = new Set<QueryLibraryInclude>([
  "metadata",
  "attachments",
  "tags",
  "collections",
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
        typeof value.attachmentTitle === "string" && value.attachmentTitle.trim()
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

function normalizeRefs(value: unknown): Array<number | PaperContextRef> | undefined {
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
  };
}

function resolveReferenceItemId(
  input: QueryLibraryInput,
  context: Parameters<AgentToolDefinition<QueryLibraryInput, unknown>["execute"]>[1],
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

export function createQueryLibraryTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<QueryLibraryInput, unknown> {
  const queryService = new LibraryQueryService(zoteroGateway);
  return {
    spec: {
      name: "query_library",
      description:
        "Discover Zotero items and collections. Use it to search or list any item type (papers, books, notes, web pages, and more), filter by author/year/collection/itemType, browse the collection tree, find related papers, detect duplicates, or list standalone notes. By default returns all item types; use filters.hasPdf:true for PDF-backed papers only.",
      inputSchema: {
        type: "object",
        required: ["entity", "mode"],
        additionalProperties: false,
        properties: {
          entity: {
            type: "string",
            enum: ["items", "collections", "notes"],
            description: "What to query: 'items' for any library item, 'collections' for folders, 'notes' to search/list notes. With mode:'search', finds all notes (both standalone and child notes attached to papers). With mode:'list', lists standalone top-level notes only.",
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
              hasPdf: { type: "boolean" },
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
                description: "Filter by Zotero item type, e.g. 'book', 'note', 'webpage', 'journalArticle', 'conferencePaper'. Only used with entity:'items'.",
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
              enum: ["metadata", "attachments", "tags", "collections"],
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
        "For library-organization requests, gather the item IDs first with query_library(entity:'items', mode:'list', filters:{unfiled:true}) when needed. If the user wants you to file or move papers and the exact destination collection IDs are not known yet, call mutate_library with operations:[{type:'move_to_collection', itemIds:[...]}] and let the confirmation card collect the target folders. Use query_library(entity:'collections', mode:'list', view:'tree') when you need the collection hierarchy to prefill or explain choices.",
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
          return results.length > 0
            ? `Found ${results.length} result${results.length === 1 ? "" : "s"}`
            : "No matching library results";
        },
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const entity =
        args.entity === "items" || args.entity === "collections" || args.entity === "notes"
          ? (args.entity as QueryLibraryEntity)
          : null;
      const mode =
        args.mode === "search" ||
        args.mode === "list" ||
        args.mode === "related" ||
        args.mode === "duplicates"
          ? (args.mode as QueryLibraryMode)
          : null;
      if (!entity || !mode) {
        return fail("entity and mode are required");
      }
      if (entity === "collections" && !["search", "list"].includes(mode)) {
        return fail("collections only support mode:'search' or mode:'list'");
      }
      if (entity === "notes" && !["list", "search"].includes(mode)) {
        return fail("notes only support mode:'list' or mode:'search'");
      }
      if ((entity === "items" || entity === "notes") && mode === "search") {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) {
          return fail("text is required for search mode");
        }
      }
      if (mode === "related" && entity !== "items") {
        return fail("mode:'related' is only valid for entity:'items'");
      }
      const view =
        args.view === "tree" ? "tree" as const
          : args.view === "flat" ? "flat" as const
          : undefined;
      return ok<QueryLibraryInput>({
        entity,
        mode,
        text:
          typeof args.text === "string" && args.text.trim()
            ? args.text.trim()
            : undefined,
        refs: normalizeRefs(args.refs),
        filters: normalizeFilters(args.filters),
        limit: normalizePositiveInt(args.limit),
        include: normalizeInclude(args.include),
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
          return {
            entity: input.entity,
            mode: input.mode,
            results: result.results,
            warnings: result.warnings,
          };
        }
        // list mode
        const result = await queryService.listStandaloneNotes({
          libraryID,
          limit: input.limit,
        });
        return {
          entity: input.entity,
          mode: input.mode,
          totalCount: result.totalCount,
          results: result.results,
          warnings: result.warnings,
        };
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
        return {
          entity: input.entity,
          mode: input.mode,
          results: result.results,
          warnings: result.warnings,
        };
      }
      if (input.mode === "search") {
        const result = await queryService.searchItems({
          libraryID,
          text: input.text || "",
          limit: input.limit,
          include: input.include,
          excludeContextItemId:
            zoteroGateway.getActiveContextItem(context.item)?.id || null,
        });
        return {
          entity: input.entity,
          mode: input.mode,
          results: result.results,
          warnings: result.warnings,
        };
      }
      if (input.mode === "list") {
        const result = await queryService.listItems({
          libraryID,
          filters: input.filters,
          limit: input.limit,
          include: input.include,
        });
        return {
          entity: input.entity,
          mode: input.mode,
          totalCount: result.totalCount,
          results: result.results,
          warnings: result.warnings,
        };
      }
      if (input.mode === "related") {
        const referenceItemId = resolveReferenceItemId(input, context, zoteroGateway);
        if (!referenceItemId) {
          throw new Error("A reference paper is required for related-item queries");
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

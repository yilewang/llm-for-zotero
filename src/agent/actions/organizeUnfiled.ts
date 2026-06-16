import type {
  AgentAction,
  ActionExecutionContext,
  ActionResult,
} from "./types";
import { callTool } from "./executor";
import {
  formatActionPageLabel,
  getPagedActionOptions,
  getPagedActionPages,
  getPagedOperationId,
  isUserCancelledToolResult,
  normalizeActionPageSize,
  readToolConfirmationActionId,
  readToolConfirmationData,
  readToolResultError,
  type PagedActionInput,
} from "./pagedWorkflow";
import {
  callActionLlm,
  collectActionLlmBatchResults,
  extractJsonArray,
} from "./llmBatchHelpers";
import type {
  CollectionSummary,
  LibraryItemTarget,
} from "../services/zoteroGateway";

type OrganizeUnfiledInput = PagedActionInput & {
  userQuery?: string;
};

type OrganizeUnfiledOutput = {
  unfiled: number;
  moved: number;
  remaining: number;
  processed?: number;
  stopped?: boolean;
};

type UnfiledItem = {
  itemId: number;
  itemType?: string;
  title: string;
  abstract: string;
  creator: string;
  year: string;
};

type Collection = {
  id: number;
  name: string;
  path: string;
};

const LLM_BATCH_SIZE = 12;

/**
 * Finds unfiled library items and pages through native
 * collection-assignment cards. Each page re-reads collection summaries so new
 * folders created while the workflow is running can be selected later.
 */
export const organizeUnfiledAction: AgentAction<
  OrganizeUnfiledInput,
  OrganizeUnfiledOutput
> = {
  name: "organize_unfiled",
  modes: ["library"],
  description:
    "Find unfiled Zotero items and page through batch-assignment dialogs to move them into collections. " +
    "The agent proposes destinations from fresh collection data; the user reviews each page before edits are applied.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: {
        type: "number",
        description: "Optional total cap across all pages. Default: no limit.",
      },
      pageSize: {
        type: "number",
        description:
          "Items to show per review page. Default: 20; maximum: 100.",
      },
      startOffset: {
        type: "number",
        description:
          "Internal resume offset for paged workflows. Defaults to 0.",
      },
    },
  },

  async execute(
    input: OrganizeUnfiledInput,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult<OrganizeUnfiledOutput>> {
    let options = getPagedActionOptions(input);

    ctx.onProgress({
      type: "step_start",
      step: "Finding unfiled items",
      index: 1,
      total: 2,
    });

    let unfiledItems: UnfiledItem[] = [];
    let pages = getPagedActionPages<UnfiledItem>([], options);
    const reloadUnfiledPages = async (): Promise<void> => {
      invalidateLibraryCaches(ctx);
      unfiledItems = await loadFreshUnfiledItems(ctx);
      pages = getPagedActionPages(unfiledItems, options);
    };
    try {
      await reloadUnfiledPages();
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load unfiled items",
      };
    }

    ctx.onProgress({
      type: "step_done",
      step: "Finding unfiled items",
      summary: `${unfiledItems.length} unfiled item${unfiledItems.length === 1 ? "" : "s"} found`,
    });

    if (!pages.length) {
      return { ok: true, output: { unfiled: 0, moved: 0, remaining: 0 } };
    }

    ctx.onProgress({
      type: "step_start",
      step: "Reviewing pages",
      index: 2,
      total: 2,
    });

    let moved = 0;
    let processed = 0;
    let stopped = false;
    let confirmed = false;

    let pageCursor = 0;
    while (pageCursor < pages.length) {
      const page = pages[pageCursor];
      invalidateLibraryCaches(ctx);
      const collections = await loadFreshCollections(ctx);
      const pageLabel = formatActionPageLabel(page);
      const suggestionsByItemId = new Map<number, number>();

      if (ctx.llm && collections.length) {
        try {
          const suggested = await suggestCollectionsForItems(
            page.items,
            collections,
            input.userQuery,
            ctx,
          );
          for (const entry of suggested) {
            suggestionsByItemId.set(entry.itemId, entry.collectionId);
          }
        } catch (err) {
          ctx.onProgress({
            type: "step_done",
            step: `${pageLabel}: Matching items to collections`,
            summary: `AI matching unavailable (${err instanceof Error ? err.message : "error"}); using deterministic matching`,
          });
        }
      }

      for (const item of page.items) {
        if (suggestionsByItemId.has(item.itemId)) continue;
        const deterministic = suggestCollectionDeterministically(
          item,
          collections,
        );
        if (deterministic) {
          suggestionsByItemId.set(item.itemId, deterministic);
        }
      }

      ctx.onProgress({
        type: "step_start",
        step: `${pageLabel}: Assigning items to collections`,
        index: page.pageIndex,
        total: page.totalPages,
      });

      const includeManualRows = ctx.confirmationMode !== "auto_approve";
      const assignments = page.items.flatMap((item) => {
        const suggestedId = suggestionsByItemId.get(item.itemId);
        return suggestedId
          ? [{ itemId: item.itemId, targetCollectionId: suggestedId }]
          : includeManualRows
            ? [{ itemId: item.itemId }]
            : [];
      });

      if (!assignments.length) {
        processed += page.items.length;
        ctx.onProgress({
          type: "step_done",
          step: `${pageLabel}: Assigning items to collections`,
          summary: "No confident collection assignments for this page",
        });
        pageCursor += 1;
        continue;
      }

      const mutateResult = await callTool(
        "move_to_collection",
        {
          action: "add",
          id: getPagedOperationId("organize_unfiled", page, {
            pageSize: options.pageSize,
          }),
          assignments,
        },
        ctx,
        `${pageLabel}: Assigning unfiled items to collections`,
      );

      const confirmationActionId = readToolConfirmationActionId(mutateResult);
      const confirmationData = readToolConfirmationData(mutateResult);
      const requestedPageSize =
        confirmationData.pageSize !== undefined
          ? normalizeActionPageSize(confirmationData.pageSize)
          : options.pageSize;
      const refreshPages = async (
        nextCursor: number,
        refreshOptions?: { reloadTargets?: boolean },
      ): Promise<void> => {
        options = { ...options, pageSize: requestedPageSize };
        if (refreshOptions?.reloadTargets) {
          await reloadUnfiledPages();
        } else {
          pages = getPagedActionPages(unfiledItems, options);
        }
        pageCursor = Math.max(0, Math.min(nextCursor, pages.length - 1));
      };
      if (confirmationActionId === "previous") {
        await refreshPages(pageCursor - 1);
        continue;
      }
      if (confirmationActionId === "refresh") {
        await refreshPages(pageCursor, { reloadTargets: true });
        continue;
      }
      if (confirmationActionId === "next") {
        await refreshPages(pageCursor + 1);
        continue;
      }
      if (confirmationActionId === "cancel") {
        stopped = true;
        ctx.onProgress({
          type: "step_done",
          step: `${pageLabel}: Assigning items to collections`,
          summary: "Stopped by user",
        });
        break;
      }

      const mutateContent = mutateResult.content as Record<string, unknown>;
      const resultObj = mutateContent.result as
        | Record<string, unknown>
        | undefined;
      const movedCount =
        mutateResult.ok && resultObj ? Number(resultObj.movedCount || 0) : 0;
      const mutateError = readToolResultError(mutateResult);

      if (mutateResult.ok) {
        moved += movedCount;
        processed += page.items.length;
        ctx.onProgress({
          type: "step_done",
          step: `${pageLabel}: Assigning items to collections`,
          summary: `Moved ${movedCount} item${movedCount === 1 ? "" : "s"}`,
        });
        if (confirmationActionId === "confirm") {
          if (pageCursor >= pages.length - 1) {
            confirmed = true;
            break;
          }
          await refreshPages(pageCursor + 1);
          continue;
        }
        if (requestedPageSize !== options.pageSize) {
          await refreshPages(pageCursor + 1);
        } else {
          pageCursor += 1;
        }
        continue;
      }

      stopped = isUserCancelledToolResult(mutateResult);
      ctx.onProgress({
        type: "step_done",
        step: `${pageLabel}: Assigning items to collections`,
        summary: stopped
          ? "Stopped by user"
          : mutateError || "Assignment was denied or failed",
      });

      if (!stopped) {
        return { ok: false, error: mutateError || "Assignment failed" };
      }
      break;
    }

    ctx.onProgress({
      type: "step_done",
      step: "Reviewing pages",
      summary: stopped
        ? `Stopped after ${processed} item${processed === 1 ? "" : "s"}; moved ${moved}`
        : confirmed
          ? `Confirmed ${processed} reviewed item${processed === 1 ? "" : "s"}; moved ${moved}`
          : `Moved ${moved} item${moved === 1 ? "" : "s"} across ${pages.length} page${pages.length === 1 ? "" : "s"}`,
    });

    return {
      ok: true,
      output: {
        unfiled: unfiledItems.length,
        moved,
        remaining: Math.max(0, unfiledItems.length - moved),
        processed,
        stopped: stopped || undefined,
      },
    };
  },
};

function invalidateLibraryCaches(ctx: ActionExecutionContext): void {
  ctx.zoteroGateway.invalidateLibrarySearchCache?.(ctx.libraryID);
}

async function loadFreshUnfiledItems(
  ctx: ActionExecutionContext,
): Promise<UnfiledItem[]> {
  if (typeof ctx.zoteroGateway.listUnfiledItemTargets === "function") {
    const result = await ctx.zoteroGateway.listUnfiledItemTargets({
      libraryID: ctx.libraryID,
    });
    return result.items.map((item) => normalizeUnfiledTarget(item, ctx));
  }

  const queryResult = await callTool(
    "query_library",
    {
      entity: "items",
      mode: "list",
      filters: { unfiled: true },
      include: ["metadata"],
    },
    ctx,
    "Finding unfiled items",
  );
  if (!queryResult.ok) {
    throw new Error(
      `Failed to query library: ${JSON.stringify(queryResult.content)}`,
    );
  }
  const queryContent = queryResult.content as Record<string, unknown>;
  const unfiledRaw = Array.isArray(queryContent.results)
    ? queryContent.results
    : [];
  return normalizeUnfiledItems(unfiledRaw);
}

async function loadFreshCollections(
  ctx: ActionExecutionContext,
): Promise<Collection[]> {
  if (typeof ctx.zoteroGateway.listCollectionSummaries === "function") {
    return ctx.zoteroGateway
      .listCollectionSummaries(ctx.libraryID)
      .map(collectionSummaryToCollection);
  }

  const collectionsResult = await callTool(
    "query_library",
    { entity: "collections", mode: "list" },
    ctx,
    "Loading collections",
  );
  return parseCollections(collectionsResult.content);
}

function collectionSummaryToCollection(summary: CollectionSummary): Collection {
  return {
    id: summary.collectionId,
    name: summary.name,
    path: summary.path || summary.name,
  };
}

function normalizeUnfiledTarget(
  target: LibraryItemTarget,
  ctx: ActionExecutionContext,
): UnfiledItem {
  const snapshot = ctx.zoteroGateway.getEditableArticleMetadata?.(
    ctx.zoteroGateway.getItem?.(target.itemId),
  );
  return {
    itemId: target.itemId,
    itemType: target.itemType,
    title: target.title || snapshot?.title || `Item ${target.itemId}`,
    abstract: snapshot?.fields.abstractNote || "",
    creator: target.firstCreator || "",
    year: target.year || "",
  };
}

function normalizeUnfiledItems(raw: unknown[]): UnfiledItem[] {
  const items: UnfiledItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.itemId !== "number") continue;
    const metadata = record.metadata as
      | { fields?: Record<string, string> }
      | null
      | undefined;
    const fields = metadata?.fields || {};
    const title =
      (typeof record.title === "string" && record.title) ||
      fields.title ||
      `Item ${record.itemId}`;
    const abstract = (fields.abstractNote || "").toString();
    items.push({
      itemId: record.itemId,
      itemType:
        typeof record.itemType === "string" ? record.itemType : undefined,
      title,
      abstract,
      creator:
        typeof record.firstCreator === "string" ? record.firstCreator : "",
      year: typeof record.year === "string" ? record.year : "",
    });
  }
  return items;
}

function parseCollections(content: unknown): Collection[] {
  if (!content || typeof content !== "object") return [];
  const record = content as Record<string, unknown>;
  const results = Array.isArray(record.results) ? record.results : [];
  const collections: Collection[] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const c = entry as Record<string, unknown>;
    const id =
      (typeof c.collectionId === "number" ? c.collectionId : null) ??
      (typeof c.id === "number" ? c.id : null) ??
      (typeof c.collectionID === "number" ? c.collectionID : null);
    if (!id) continue;
    const name = typeof c.name === "string" ? c.name : `${id}`;
    const path = typeof c.path === "string" && c.path ? c.path : name;
    collections.push({ id, name, path });
  }
  return collections;
}

function suggestCollectionDeterministically(
  item: UnfiledItem,
  collections: Collection[],
): number | null {
  const itemTokens = tokenizeForMatching(
    [item.title, item.abstract, item.creator, item.year, item.itemType]
      .filter(Boolean)
      .join(" "),
  );
  if (!itemTokens.size) return null;

  let best: { id: number; score: number } | null = null;
  for (const collection of collections) {
    const collectionText = `${collection.path} ${collection.name}`;
    const collectionTokens = tokenizeForMatching(collectionText);
    let score = 0;
    for (const token of collectionTokens) {
      if (itemTokens.has(token)) score += token.length >= 6 ? 2 : 1;
    }
    const normalizedCollection = normalizeMatchText(collectionText);
    const normalizedItem = normalizeMatchText(`${item.title} ${item.abstract}`);
    if (
      normalizedCollection.length >= 6 &&
      normalizedItem.includes(normalizedCollection)
    ) {
      score += 3;
    }
    if (!best || score > best.score) {
      best = { id: collection.id, score };
    }
  }
  return best && best.score >= 2 ? best.id : null;
}

const MATCH_STOPWORDS = new Set([
  "and",
  "the",
  "for",
  "with",
  "from",
  "into",
  "onto",
  "paper",
  "papers",
  "article",
  "articles",
  "study",
  "studies",
  "research",
  "journal",
  "conference",
  "proceedings",
]);

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenizeForMatching(value: string): Set<string> {
  return new Set(
    normalizeMatchText(value)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(
        (token) =>
          token.length >= 3 &&
          !MATCH_STOPWORDS.has(token) &&
          !/^\d+$/.test(token),
      ),
  );
}

async function suggestCollectionsForItems(
  items: UnfiledItem[],
  collections: Collection[],
  userQuery: string | undefined,
  ctx: ActionExecutionContext,
): Promise<Array<{ itemId: number; collectionId: number }>> {
  if (!ctx.llm || !collections.length) return [];
  return collectActionLlmBatchResults(items, LLM_BATCH_SIZE, (batch) =>
    suggestCollectionsBatch(
      batch,
      collections,
      userQuery,
      ctx,
    ),
  );
}

async function suggestCollectionsBatch(
  batch: UnfiledItem[],
  collections: Collection[],
  userQuery: string | undefined,
  ctx: ActionExecutionContext,
): Promise<Array<{ itemId: number; collectionId: number }>> {
  if (!ctx.llm) return [];
  const prompt = buildCollectionPrompt(batch, collections, userQuery);
  const raw = await callActionLlm({
    ctx,
    prompt,
    maxTokens: 1200,
  });
  return parseCollectionResponse(raw, batch, collections);
}

function buildCollectionPrompt(
  batch: UnfiledItem[],
  collections: Collection[],
  userQuery: string | undefined,
): string {
  const collectionsBlock = collections
    .map((c) => `- id=${c.id} - ${c.path}`)
    .join("\n");
  const itemsBlock = batch
    .map((item) => {
      const abstract = item.abstract
        ? item.abstract.slice(0, 800).replace(/\s+/g, " ").trim()
        : "(no abstract available)";
      const byline = [item.creator, item.year].filter(Boolean).join(" - ");
      return [
        `itemId: ${item.itemId}`,
        `title: ${item.title}`,
        byline ? `byline: ${byline}` : "",
        `abstract: ${abstract}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n---\n\n");

  return [
    "You are organizing unfiled Zotero library items into existing collections (folders).",
    "For each item, pick the single best-matching collection from the list below, or return null if no collection is a clear fit.",
    "Guidelines:",
    "- Choose based on topical fit between the item and the collection's name or path.",
    "- Prefer the most specific collection when nested paths exist.",
    "- Use null when the paper doesn't clearly belong to any of the existing collections; do not force a poor match.",
    "- Use only collection IDs from the list. Do not invent IDs.",
    "",
    userQuery?.trim()
      ? `Extra user instructions for this organize-unfiled action:\n${userQuery.trim()}\n`
      : "",
    "Available collections:",
    collectionsBlock,
    "",
    "Items:",
    itemsBlock,
    "",
    "Respond with ONLY a JSON array, no prose, no code fence. Shape:",
    '[{"itemId": <number>, "collectionId": <number> | null}, ...]',
  ].join("\n");
}

function parseCollectionResponse(
  raw: string,
  batch: UnfiledItem[],
  collections: Collection[],
): Array<{ itemId: number; collectionId: number }> {
  const validItemIds = new Set(batch.map((item) => item.itemId));
  const validCollectionIds = new Set(collections.map((c) => c.id));
  const jsonText = extractJsonArray(raw);
  if (!jsonText) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Array<{ itemId: number; collectionId: number }> = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const itemId = Number(record.itemId);
    const collectionId = Number(record.collectionId);
    if (!Number.isFinite(itemId) || !validItemIds.has(itemId)) continue;
    if (!Number.isFinite(collectionId)) continue;
    if (!validCollectionIds.has(collectionId)) continue;
    out.push({ itemId, collectionId });
  }
  return out;
}

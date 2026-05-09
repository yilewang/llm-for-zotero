import type {
  AgentAction,
  ActionExecutionContext,
  ActionResult,
} from "./types";
import { callTool } from "./executor";
import { callLLM } from "../../utils/llmClient";

type OrganizeUnfiledInput = {
  /** Maximum number of unfiled items to process. Default: no limit. */
  limit?: number;
};

type OrganizeUnfiledOutput = {
  unfiled: number;
  moved: number;
  remaining: number;
};

type UnfiledItem = {
  itemId: number;
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
 * Finds all unfiled papers and presents a collection-assignment HITL card
 * pre-selected with AI-suggested destinations. When an LLM config is
 * available, each paper is matched to the best-fitting existing collection
 * using title + abstract + collection names as context. The user reviews and
 * corrects the dropdowns before the batch move runs. When no LLM config is
 * available (e.g. MCP mode), the card falls back to "Leave untouched" for
 * every row.
 */
export const organizeUnfiledAction: AgentAction<
  OrganizeUnfiledInput,
  OrganizeUnfiledOutput
> = {
  name: "organize_unfiled",
  modes: ["library"],
  description:
    "Find all unfiled Zotero papers and open a batch-assignment dialog to move them into collections. " +
    "The agent proposes a destination collection for each paper based on its title, abstract, and the available collection names; " +
    "the user reviews and adjusts the assignments before they are applied.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: {
        type: "number",
        description:
          "Max number of unfiled items to process per run. Default: no limit.",
      },
    },
  },

  async execute(
    input: OrganizeUnfiledInput,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult<OrganizeUnfiledOutput>> {
    const STEPS = ctx.llm ? 4 : 3;
    let step = 0;

    // Step 1: get unfiled items
    ctx.onProgress({
      type: "step_start",
      step: "Finding unfiled items",
      index: ++step,
      total: STEPS,
    });

    const queryArgs: Record<string, unknown> = {
      entity: "items",
      mode: "list",
      filters: { unfiled: true },
      include: ["metadata"],
    };
    if (input.limit) queryArgs.limit = input.limit;

    const queryResult = await callTool(
      "query_library",
      queryArgs,
      ctx,
      "Finding unfiled items",
    );
    if (!queryResult.ok) {
      return {
        ok: false,
        error: `Failed to query library: ${JSON.stringify(queryResult.content)}`,
      };
    }

    const queryContent = queryResult.content as Record<string, unknown>;
    const unfiledRaw = Array.isArray(queryContent.results)
      ? queryContent.results
      : [];
    const unfiledItems = normalizeUnfiledItems(unfiledRaw);

    ctx.onProgress({
      type: "step_done",
      step: "Finding unfiled items",
      summary: `${unfiledItems.length} unfiled item${unfiledItems.length === 1 ? "" : "s"}`,
    });

    if (!unfiledItems.length) {
      return { ok: true, output: { unfiled: 0, moved: 0, remaining: 0 } };
    }

    // Step 2: get collection options
    ctx.onProgress({
      type: "step_start",
      step: "Loading collections",
      index: ++step,
      total: STEPS,
    });

    const collectionsResult = await callTool(
      "query_library",
      { entity: "collections", mode: "list" },
      ctx,
      "Loading collections",
    );

    const collections = parseCollections(collectionsResult.content);

    ctx.onProgress({
      type: "step_done",
      step: "Loading collections",
      summary: `${collections.length} collection${collections.length === 1 ? "" : "s"} available`,
    });

    // Step 3 (optional): ask the LLM to match items to collections
    const suggestionsByItemId = new Map<number, number>();
    if (ctx.llm && collections.length) {
      ctx.onProgress({
        type: "step_start",
        step: "Matching items to collections",
        index: ++step,
        total: STEPS,
      });
      try {
        const suggested = await suggestCollectionsForItems(
          unfiledItems,
          collections,
          ctx,
        );
        for (const entry of suggested) {
          suggestionsByItemId.set(entry.itemId, entry.collectionId);
        }
        ctx.onProgress({
          type: "step_done",
          step: "Matching items to collections",
          summary: `Proposed destinations for ${suggestionsByItemId.size}/${unfiledItems.length} items`,
        });
      } catch (err) {
        ctx.onProgress({
          type: "step_done",
          step: "Matching items to collections",
          summary: `AI matching unavailable (${err instanceof Error ? err.message : "error"}); falling back to manual assignment`,
        });
      }
    }

    // Final step: batch move via move_to_collection (HITL assignment_table)
    ctx.onProgress({
      type: "step_start",
      step: "Assigning items to collections",
      index: ++step,
      total: STEPS,
    });

    const assignments = unfiledItems.map((item) => {
      const suggestedId = suggestionsByItemId.get(item.itemId);
      return suggestedId
        ? { itemId: item.itemId, targetCollectionId: suggestedId }
        : { itemId: item.itemId };
    });

    const mutateResult = await callTool(
      "move_to_collection",
      {
        action: "add",
        assignments,
      },
      ctx,
      "Assigning unfiled items to collections",
    );

    const mutateContent = mutateResult.content as Record<string, unknown>;
    const resultObj = mutateContent.result as
      | Record<string, unknown>
      | undefined;
    const movedCount =
      mutateResult.ok && resultObj ? Number(resultObj.movedCount || 0) : 0;
    const mutateError =
      !mutateResult.ok && typeof mutateContent.error === "string"
        ? mutateContent.error
        : undefined;

    ctx.onProgress({
      type: "step_done",
      step: "Assigning items to collections",
      summary: mutateResult.ok
        ? `Moved ${movedCount} item${movedCount === 1 ? "" : "s"}`
        : mutateError || "Assignment was denied or failed",
    });

    if (!mutateResult.ok && mutateError) {
      return { ok: false, error: mutateError };
    }

    return {
      ok: true,
      output: {
        unfiled: unfiledItems.length,
        moved: movedCount,
        remaining: unfiledItems.length - movedCount,
      },
    };
  },
};

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

async function suggestCollectionsForItems(
  items: UnfiledItem[],
  collections: Collection[],
  ctx: ActionExecutionContext,
): Promise<Array<{ itemId: number; collectionId: number }>> {
  if (!ctx.llm || !collections.length) return [];
  const results: Array<{ itemId: number; collectionId: number }> = [];
  for (let i = 0; i < items.length; i += LLM_BATCH_SIZE) {
    const batch = items.slice(i, i + LLM_BATCH_SIZE);
    const batchResult = await suggestCollectionsBatch(batch, collections, ctx);
    results.push(...batchResult);
  }
  return results;
}

async function suggestCollectionsBatch(
  batch: UnfiledItem[],
  collections: Collection[],
  ctx: ActionExecutionContext,
): Promise<Array<{ itemId: number; collectionId: number }>> {
  if (!ctx.llm) return [];
  const prompt = buildCollectionPrompt(batch, collections);
  const raw = await callLLM({
    prompt,
    model: ctx.llm.model,
    apiBase: ctx.llm.apiBase,
    apiKey: ctx.llm.apiKey,
    authMode: ctx.llm.authMode,
    providerProtocol: ctx.llm.providerProtocol,
    temperature: 0,
    maxTokens: 1200,
  });
  return parseCollectionResponse(raw, batch, collections);
}

function buildCollectionPrompt(
  batch: UnfiledItem[],
  collections: Collection[],
): string {
  const collectionsBlock = collections
    .map((c) => `- id=${c.id} · ${c.path}`)
    .join("\n");
  const itemsBlock = batch
    .map((item) => {
      const abstract = item.abstract
        ? item.abstract.slice(0, 800).replace(/\s+/g, " ").trim()
        : "(no abstract available)";
      const byline = [item.creator, item.year].filter(Boolean).join(" · ");
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
    "You are organizing unfiled papers into existing Zotero collections (folders).",
    "For each paper, pick the single best-matching collection from the list below, or return null if no collection is a clear fit.",
    "Guidelines:",
    "- Choose based on topical fit between the paper and the collection's name or path.",
    "- Prefer the most specific collection when nested paths exist.",
    "- Use null when the paper doesn't clearly belong to any of the existing collections — do not force a poor match.",
    "- Use only collection IDs from the list. Do not invent IDs.",
    "",
    "Available collections:",
    collectionsBlock,
    "",
    "Papers:",
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

function extractJsonArray(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return trimmed;
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return null;
}

import type {
  AgentAction,
  ActionExecutionContext,
  ActionResult,
} from "./types";
import { callTool } from "./executor";
import { callLLM } from "../../utils/llmClient";

type AutoTagInput = {
  scope?: "all" | "collection";
  collectionId?: number;
  limit?: number;
};

type AutoTagOutput = {
  untagged: number;
  tagged: number;
  skipped: number;
};

type UntaggedItem = {
  itemId: number;
  title: string;
  abstract: string;
  creator: string;
  year: string;
};

const LLM_BATCH_SIZE = 10;
const MAX_TAGS_PER_ITEM = 5;

/**
 * Finds all papers without tags and opens a batch tag-assignment HITL card
 * pre-filled with AI-suggested tags. When an LLM config is available, each
 * paper gets 3-5 topical tags generated from its title + abstract, preferring
 * tags already used in the library so the taxonomy stays consistent. The user
 * reviews and edits the chips before they are applied. When no LLM config is
 * available (e.g. MCP mode), the card falls back to empty chips for manual
 * entry.
 */
export const autoTagAction: AgentAction<AutoTagInput, AutoTagOutput> = {
  name: "auto_tag",
  modes: ["paper", "library"],
  description:
    "Find all Zotero papers without any tags and open a batch tag-assignment dialog. " +
    "The agent proposes tags for each paper based on its title and abstract; " +
    "the user reviews and edits them before they are applied.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: {
        type: "string",
        enum: ["all", "collection"],
        description: "Which items to check. Default: 'all'.",
      },
      collectionId: {
        type: "number",
        description: "Required when scope is 'collection'.",
      },
      limit: {
        type: "number",
        description: "Max number of untagged items to process per run.",
      },
    },
  },

  async execute(
    input: AutoTagInput,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult<AutoTagOutput>> {
    const STEPS = ctx.llm ? 3 : 2;
    let step = 0;

    // Step 1: find untagged items
    ctx.onProgress({
      type: "step_start",
      step: "Finding untagged items",
      index: ++step,
      total: STEPS,
    });

    const queryArgs: Record<string, unknown> = {
      entity: "items",
      mode: "list",
      filters: { untagged: true },
      include: ["metadata"],
    };
    if (input.scope === "collection" && input.collectionId) {
      queryArgs.filters = { untagged: true, collectionId: input.collectionId };
    }
    if (input.limit) queryArgs.limit = input.limit;

    const queryResult = await callTool(
      "query_library",
      queryArgs,
      ctx,
      "Finding untagged items",
    );
    if (!queryResult.ok) {
      return {
        ok: false,
        error: `Failed to query library: ${JSON.stringify(queryResult.content)}`,
      };
    }

    const queryContent = queryResult.content as Record<string, unknown>;
    const untaggedRaw = Array.isArray(queryContent.results)
      ? queryContent.results
      : [];
    const untaggedItems = normalizeUntaggedItems(untaggedRaw);

    ctx.onProgress({
      type: "step_done",
      step: "Finding untagged items",
      summary: `${untaggedItems.length} untagged item${untaggedItems.length === 1 ? "" : "s"}`,
    });

    if (!untaggedItems.length) {
      return { ok: true, output: { untagged: 0, tagged: 0, skipped: 0 } };
    }

    // Step 2 (optional): ask the LLM to suggest tags per item
    const suggestionsByItemId = new Map<number, string[]>();
    if (ctx.llm) {
      ctx.onProgress({
        type: "step_start",
        step: "Suggesting tags",
        index: ++step,
        total: STEPS,
      });

      const existingTags = await fetchExistingLibraryTags(ctx);
      try {
        const suggested = await suggestTagsForItems(
          untaggedItems,
          existingTags,
          ctx,
        );
        for (const entry of suggested) {
          suggestionsByItemId.set(entry.itemId, entry.tags);
        }
        ctx.onProgress({
          type: "step_done",
          step: "Suggesting tags",
          summary: `Suggested tags for ${suggestionsByItemId.size}/${untaggedItems.length} items`,
        });
      } catch (err) {
        ctx.onProgress({
          type: "step_done",
          step: "Suggesting tags",
          summary: `AI suggestions unavailable (${err instanceof Error ? err.message : "error"}); falling back to manual entry`,
        });
      }
    }

    // Final step: apply tags via apply_tags (HITL tag_assignment_table)
    ctx.onProgress({
      type: "step_start",
      step: "Assigning tags to items",
      index: ++step,
      total: STEPS,
    });

    const assignments = untaggedItems.map((item) => ({
      itemId: item.itemId,
      tags: suggestionsByItemId.get(item.itemId) ?? [],
    }));

    const mutateResult = await callTool(
      "apply_tags",
      {
        action: "add",
        assignments,
      },
      ctx,
      "Assigning tags",
    );

    const mutateContent = mutateResult.content as Record<string, unknown>;
    const resultObj = mutateContent.result as
      | Record<string, unknown>
      | undefined;
    const taggedCount =
      mutateResult.ok && resultObj ? Number(resultObj.updatedCount || 0) : 0;
    const mutateError =
      !mutateResult.ok && typeof mutateContent.error === "string"
        ? mutateContent.error
        : undefined;

    ctx.onProgress({
      type: "step_done",
      step: "Assigning tags to items",
      summary: mutateResult.ok
        ? `Tagged ${taggedCount} item${taggedCount === 1 ? "" : "s"}`
        : mutateError || "Tag assignment was denied or failed",
    });

    if (!mutateResult.ok && mutateError) {
      return { ok: false, error: mutateError };
    }

    return {
      ok: true,
      output: {
        untagged: untaggedItems.length,
        tagged: taggedCount,
        skipped: untaggedItems.length - taggedCount,
      },
    };
  },
};

function normalizeUntaggedItems(raw: unknown[]): UntaggedItem[] {
  const items: UntaggedItem[] = [];
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

async function fetchExistingLibraryTags(
  ctx: ActionExecutionContext,
): Promise<string[]> {
  const tagResult = await callTool(
    "query_library",
    { entity: "tags", mode: "list" },
    ctx,
    "Loading existing tags",
  );
  if (!tagResult.ok) return [];
  const content = tagResult.content as Record<string, unknown>;
  const results = Array.isArray(content.results) ? content.results : [];
  const tags = new Set<string>();
  for (const entry of results) {
    if (typeof entry === "string") {
      tags.add(entry);
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const name =
        (typeof record.tag === "string" && record.tag) ||
        (typeof record.name === "string" && record.name) ||
        "";
      if (name) tags.add(name);
    }
  }
  return Array.from(tags);
}

async function suggestTagsForItems(
  items: UntaggedItem[],
  existingTags: string[],
  ctx: ActionExecutionContext,
): Promise<Array<{ itemId: number; tags: string[] }>> {
  if (!ctx.llm) return [];
  const results: Array<{ itemId: number; tags: string[] }> = [];
  for (let i = 0; i < items.length; i += LLM_BATCH_SIZE) {
    const batch = items.slice(i, i + LLM_BATCH_SIZE);
    const batchResult = await suggestTagsBatch(batch, existingTags, ctx);
    results.push(...batchResult);
  }
  return results;
}

async function suggestTagsBatch(
  batch: UntaggedItem[],
  existingTags: string[],
  ctx: ActionExecutionContext,
): Promise<Array<{ itemId: number; tags: string[] }>> {
  if (!ctx.llm) return [];
  const prompt = buildTagPrompt(batch, existingTags);
  const raw = await callLLM({
    prompt,
    model: ctx.llm.model,
    apiBase: ctx.llm.apiBase,
    apiKey: ctx.llm.apiKey,
    authMode: ctx.llm.authMode,
    providerProtocol: ctx.llm.providerProtocol,
    temperature: 0,
    maxTokens: 800,
  });
  return parseTagResponse(raw, batch);
}

function buildTagPrompt(batch: UntaggedItem[], existingTags: string[]): string {
  const vocab = existingTags.length
    ? `Existing tags in this library (prefer these when they fit):\n${existingTags
        .slice(0, 80)
        .map((t) => `- ${t}`)
        .join("\n")}\n\n`
    : "";
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
    "You are tagging scholarly papers for a Zotero library.",
    `For each paper below, propose 3 to ${MAX_TAGS_PER_ITEM} short, topical tags that capture its subject matter, methods, or domain.`,
    "Guidelines:",
    "- Prefer short lowercase phrases (1-3 words).",
    "- Reuse an existing tag from the vocabulary whenever it fits; only invent a new tag when no existing tag is appropriate.",
    "- Do not include generic filler like 'research', 'paper', 'study', 'science'.",
    "- If the paper's subject is unclear, return an empty tags array for it.",
    "",
    vocab,
    "Papers:",
    itemsBlock,
    "",
    "Respond with ONLY a JSON array, no prose, no code fence. Shape:",
    '[{"itemId": <number>, "tags": ["tag1", "tag2"]}, ...]',
  ].join("\n");
}

function parseTagResponse(
  raw: string,
  batch: UntaggedItem[],
): Array<{ itemId: number; tags: string[] }> {
  const validIds = new Set(batch.map((item) => item.itemId));
  const jsonText = extractJsonArray(raw);
  if (!jsonText) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Array<{ itemId: number; tags: string[] }> = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const itemId = Number(record.itemId);
    if (!Number.isFinite(itemId) || !validIds.has(itemId)) continue;
    const rawTags = Array.isArray(record.tags) ? record.tags : [];
    const tags = rawTags
      .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
      .filter((tag): tag is string => tag.length > 0)
      .slice(0, MAX_TAGS_PER_ITEM);
    if (tags.length) out.push({ itemId, tags });
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

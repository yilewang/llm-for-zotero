import type {
  AgentAction,
  ActionExecutionContext,
  ActionResult,
} from "./types";
import { callTool } from "./executor";
import { callLLM } from "../../utils/llmClient";
import type { PaperScopedActionInput } from "./paperScope";
import {
  resolvePaperScopedActionTargets,
  type PaperScopedActionProfile,
  type PaperScopedActionTarget,
} from "./paperScope";

type AutoTagInput = PaperScopedActionInput;

type AutoTagOutput = {
  targeted: number;
  tagged: number;
  skipped: number;
};

type TargetPaper = {
  itemId: number;
  title: string;
  abstract: string;
  creator: string;
  year: string;
  existingTags: string[];
};

const LLM_BATCH_SIZE = 10;
const MAX_TAGS_PER_ITEM = 5;

const autoTagPaperScopeProfile: PaperScopedActionProfile = {
  targetMode: "multi",
  allowedScopes: ["current", "selection", "collection", "all"],
  defaultEmptyInput: "selection_or_prompt",
  paperRequirement: "bibliographic",
  supportsLimit: true,
  scopePromptOptions: {
    first: {
      label: "First 20 papers",
      input: { scope: "all", limit: 20 },
    },
    all: {
      label: "Whole library",
      input: { scope: "all" },
    },
  },
};

export const autoTagAction: AgentAction<AutoTagInput, AutoTagOutput> = {
  name: "auto_tag",
  modes: ["paper", "library"],
  paperScopeProfile: autoTagPaperScopeProfile,
  description:
    "Suggest tags for the targeted Zotero papers and open an editable batch tag-review dialog. " +
    "By default this uses the current paper in paper chat, the selected chat-context papers/collections in library chat, " +
    "or an explicit scope like all library or a specific collection.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      itemId: {
        type: "number",
        description: "Single Zotero paper item ID to target.",
      },
      scope: {
        type: "string",
        enum: ["all", "collection"],
        description: "Which papers to consider when explicit itemIds/collectionIds are not provided.",
      },
      collectionId: {
        type: "number",
        description: "Single collection ID to target.",
      },
      collectionIds: {
        type: "array",
        items: { type: "number" },
        description: "Collection IDs to target.",
      },
      itemIds: {
        type: "array",
        items: { type: "number" },
        description: "Explicit Zotero paper item IDs to target.",
      },
      limit: {
        type: "number",
        description: "Max number of targeted papers to include in this run.",
      },
    },
  },

  async execute(
    input: AutoTagInput,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult<AutoTagOutput>> {
    const steps = ctx.llm ? 3 : 2;
    let step = 0;

    ctx.onProgress({
      type: "step_start",
      step: "Resolving target papers",
      index: ++step,
      total: steps,
    });

    const targetPapers = await resolveTargetPapers(input, ctx);

    ctx.onProgress({
      type: "step_done",
      step: "Resolving target papers",
      summary: `${targetPapers.length} paper${targetPapers.length === 1 ? "" : "s"} targeted`,
    });

    if (!targetPapers.length) {
      return {
        ok: true,
        output: { targeted: 0, tagged: 0, skipped: 0 },
      };
    }

    const suggestionsByItemId = new Map<number, string[]>();
    if (ctx.llm) {
      ctx.onProgress({
        type: "step_start",
        step: "Suggesting tags",
        index: ++step,
        total: steps,
      });

      const existingTags = await fetchExistingLibraryTags(ctx);
      try {
        const suggested = await suggestTagsForItems(targetPapers, existingTags, ctx);
        for (const entry of suggested) {
          suggestionsByItemId.set(entry.itemId, entry.tags);
        }
        ctx.onProgress({
          type: "step_done",
          step: "Suggesting tags",
          summary:
            `Prepared starter tags for ${suggestionsByItemId.size}/${targetPapers.length} paper` +
            `${targetPapers.length === 1 ? "" : "s"}`,
        });
      } catch (err) {
        ctx.onProgress({
          type: "step_done",
          step: "Suggesting tags",
          summary:
            `AI suggestions unavailable (${err instanceof Error ? err.message : "error"}); ` +
            "opening manual tag review",
        });
      }
    }

    ctx.onProgress({
      type: "step_start",
      step: "Preparing tag review",
      index: ++step,
      total: steps,
    });

    const assignments = targetPapers.map((paper) => ({
      itemId: paper.itemId,
      tags: suggestionsByItemId.get(paper.itemId) ?? [],
    }));

    const mutateResult = await callTool(
      "apply_tags",
      {
        action: "add",
        assignments,
      },
      ctx,
      "Preparing tag review",
    );

    const mutateContent = mutateResult.content as Record<string, unknown>;
    const resultObj = mutateContent.result as Record<string, unknown> | undefined;
    const taggedCount = mutateResult.ok && resultObj
      ? Number(resultObj.updatedCount || 0)
      : 0;
    const mutateError =
      !mutateResult.ok && typeof mutateContent.error === "string"
        ? mutateContent.error
        : undefined;

    ctx.onProgress({
      type: "step_done",
      step: "Preparing tag review",
      summary: mutateResult.ok
        ? `Tagged ${taggedCount} paper${taggedCount === 1 ? "" : "s"}`
        : mutateError || "Tag review was denied or failed",
    });

    if (!mutateResult.ok && mutateError) {
      return { ok: false, error: mutateError };
    }

    return {
      ok: true,
      output: {
        targeted: targetPapers.length,
        tagged: taggedCount,
        skipped: Math.max(0, targetPapers.length - taggedCount),
      },
    };
  },
};

async function resolveTargetPapers(
  input: AutoTagInput,
  ctx: ActionExecutionContext,
): Promise<TargetPaper[]> {
  const targets = await resolvePaperScopedActionTargets(
    input,
    ctx,
    autoTagPaperScopeProfile,
  );
  return hydratePaperTargets(targets, ctx);
}

function hydratePaperTargets(
  targets: PaperScopedActionTarget[],
  ctx: ActionExecutionContext,
): TargetPaper[] {
  return targets.map((target) => {
    const metadata = ctx.zoteroGateway.getEditableArticleMetadata(
      ctx.zoteroGateway.getItem(target.itemId),
    );
    const abstract = metadata?.fields.abstractNote || "";
    return {
      itemId: target.itemId,
      title: target.title,
      abstract,
      creator: target.firstCreator || "",
      year: target.year || "",
      existingTags: Array.isArray(target.tags) ? target.tags : [],
    };
  });
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
  items: TargetPaper[],
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
  batch: TargetPaper[],
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

function buildTagPrompt(
  batch: TargetPaper[],
  existingTags: string[],
): string {
  const vocab = existingTags.length
    ? `Existing tags in this library (prefer these when they fit):\n${existingTags
      .slice(0, 80)
      .map((tag) => `- ${tag}`)
      .join("\n")}\n\n`
    : "";
  const itemsBlock = batch
    .map((item) => {
      const abstract = item.abstract
        ? item.abstract.slice(0, 800).replace(/\s+/g, " ").trim()
        : "(no abstract available)";
      const byline = [item.creator, item.year].filter(Boolean).join(" · ");
      const existing = item.existingTags.length
        ? item.existingTags.join(", ")
        : "(none)";
      return [
        `itemId: ${item.itemId}`,
        `title: ${item.title}`,
        byline ? `byline: ${byline}` : "",
        `existing tags: ${existing}`,
        `abstract: ${abstract}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n---\n\n");

  return [
    "You are tagging scholarly papers for a Zotero library.",
    `For each paper below, propose up to ${MAX_TAGS_PER_ITEM} short, topical tags to ADD.`,
    "Guidelines:",
    "- Prefer short lowercase phrases (1-3 words).",
    "- Reuse an existing tag from the library vocabulary whenever it fits.",
    "- Never repeat a tag that already exists on that paper.",
    "- Only suggest tags that add useful new information beyond the paper's current tags.",
    "- Do not include generic filler like 'research', 'paper', 'study', or 'science'.",
    "- If the current tags already cover the paper well, return an empty tags array for it.",
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
  batch: TargetPaper[],
): Array<{ itemId: number; tags: string[] }> {
  const batchByItemId = new Map(batch.map((item) => [item.itemId, item] as const));
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
    const sourceItem = batchByItemId.get(itemId);
    if (!Number.isFinite(itemId) || !sourceItem) continue;
    const seen = new Set(
      sourceItem.existingTags.map((tag) => tag.trim().toLowerCase()),
    );
    const rawTags = Array.isArray(record.tags) ? record.tags : [];
    const tags = rawTags
      .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
      .filter((tag): tag is string => {
        if (!tag) return false;
        const key = tag.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
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

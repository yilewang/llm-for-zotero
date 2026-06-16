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
  normalizeTagsPerPaper,
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
import type { PaperScopedActionInput } from "./paperScope";
import {
  resolvePaperScopedActionTargets,
  type PaperScopedActionProfile,
  type PaperScopedActionTarget,
} from "./paperScope";

type AutoTagInput = PaperScopedActionInput &
  PagedActionInput & {
    userQuery?: string;
    tagsPerPaper?: number;
  };

type AutoTagOutput = {
  targeted: number;
  tagged: number;
  skipped: number;
  processed?: number;
  stopped?: boolean;
};

type TargetPaper = {
  itemId: number;
  title: string;
  abstract: string;
  creator: string;
  year: string;
  existingTags: string[];
  collectionTerms: string[];
  dateAdded?: string;
};

const LLM_BATCH_SIZE = 10;
const DEFAULT_TAGS_PER_ITEM = 5;
const MAX_TAGS_PER_ITEM = 6;

const autoTagPaperScopeProfile: PaperScopedActionProfile = {
  targetMode: "multi",
  allowedScopes: ["current", "selection", "collection", "tag", "all"],
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
    "Suggest tags for Zotero bibliographic items and page through editable batch tag-review dialogs. " +
    "A click with no explicit scope starts on the active library with native review.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      itemId: {
        type: "number",
        description: "Single Zotero item ID to target.",
      },
      scope: {
        type: "string",
        enum: ["all", "collection", "tag"],
        description:
          "Which items to consider when explicit itemIds, collectionIds, or tagNames are not provided.",
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
        description: "Explicit Zotero item IDs to target.",
      },
      tagNames: {
        type: "array",
        items: { type: "string" },
        description: "Tag names whose matching items should be targeted.",
      },
      tagScopes: {
        type: "array",
        items: { type: "string", enum: ["allTagged", "untagged"] },
        description:
          "Special tag scopes whose matching items should be targeted.",
      },
      includeAutomaticTags: {
        type: "boolean",
        description: "Include automatic Zotero tags when resolving tag scopes.",
      },
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
    input: AutoTagInput,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult<AutoTagOutput>> {
    let options = getPagedActionOptions(input);
    let tagsPerPaper = normalizeTagsPerPaper(
      input.tagsPerPaper ?? DEFAULT_TAGS_PER_ITEM,
    );

    ctx.onProgress({
      type: "step_start",
      step: "Resolving target items",
      index: 1,
      total: 2,
    });

    let targetPapers: TargetPaper[] = [];
    let pages = getPagedActionPages<TargetPaper>([], options);
    let pagedTargetCount = 0;
    let existingTags: string[] = [];
    const reloadTargets = async (): Promise<void> => {
      ctx.zoteroGateway.invalidateLibrarySearchCache?.(ctx.libraryID);
      targetPapers = (await resolveTargetPapers(input, ctx)).sort(
        compareTargetPaperDateAddedDesc,
      );
      pages = getPagedActionPages(targetPapers, options);
      pagedTargetCount = pages.reduce(
        (count, page) => count + page.items.length,
        0,
      );
      existingTags = await fetchExistingLibraryTags(ctx);
    };
    await reloadTargets();

    ctx.onProgress({
      type: "step_done",
      step: "Resolving target items",
      summary: `${pagedTargetCount} item${pagedTargetCount === 1 ? "" : "s"} targeted`,
    });

    if (!pages.length) {
      return {
        ok: true,
        output: { targeted: 0, tagged: 0, skipped: 0 },
      };
    }

    ctx.onProgress({
      type: "step_start",
      step: "Reviewing tag pages",
      index: 2,
      total: 2,
    });

    let tagged = 0;
    let processed = 0;
    let skipped = 0;
    let stopped = false;
    let confirmed = false;

    let pageCursor = 0;
    while (pageCursor < pages.length) {
      const page = pages[pageCursor];
      const pageLabel = formatActionPageLabel(page);
      const pageTargets = page.items;
      const suggestionsByItemId = new Map<number, string[]>();

      if (ctx.llm) {
        try {
          const suggested = await suggestTagsForItems(
            pageTargets,
            existingTags,
            tagsPerPaper,
            input.userQuery,
            ctx,
          );
          for (const entry of suggested) {
            suggestionsByItemId.set(entry.itemId, entry.tags);
          }
        } catch (err) {
          ctx.onProgress({
            type: "step_done",
            step: `${pageLabel}: Suggesting tags`,
            summary: `AI suggestions unavailable (${err instanceof Error ? err.message : "error"}); using deterministic fallback`,
          });
        }
      }

      const assignments = pageTargets.map((paper) => {
        const tags =
          suggestionsByItemId.get(paper.itemId) ||
          suggestFallbackTags(paper, existingTags, tagsPerPaper);
        return {
          itemId: paper.itemId,
          tags,
        };
      });

      if (!assignments.length) {
        skipped += pageTargets.length;
        processed += pageTargets.length;
        ctx.onProgress({
          type: "step_done",
          step: `${pageLabel}: Suggesting tags`,
          summary: "No confident tag suggestions for this page",
        });
        pageCursor += 1;
        continue;
      }

      ctx.onProgress({
        type: "step_start",
        step: `${pageLabel}: Reviewing tag suggestions`,
        index: page.pageIndex,
        total: page.totalPages,
      });

      const mutateResult = await callTool(
        "apply_tags",
        {
          action: "add",
          id: getPagedOperationId("auto_tag", page, {
            pageSize: options.pageSize,
            tagsPerPaper,
          }),
          assignments,
        },
        ctx,
        `${pageLabel}: Preparing tag review`,
      );

      const confirmationActionId = readToolConfirmationActionId(mutateResult);
      const confirmationData = readToolConfirmationData(mutateResult);
      const requestedPageSize =
        confirmationData.pageSize !== undefined
          ? normalizeActionPageSize(confirmationData.pageSize)
          : options.pageSize;
      const requestedTagsPerPaper =
        confirmationData.tagsPerPaper !== undefined
          ? normalizeTagsPerPaper(confirmationData.tagsPerPaper)
          : tagsPerPaper;
      const refreshPages = async (
        nextCursor: number,
        refreshOptions?: { reloadTargets?: boolean },
      ): Promise<void> => {
        options = { ...options, pageSize: requestedPageSize };
        tagsPerPaper = requestedTagsPerPaper;
        if (refreshOptions?.reloadTargets) {
          await reloadTargets();
        } else {
          pages = getPagedActionPages(targetPapers, options);
          pagedTargetCount = pages.reduce(
            (count, currentPage) => count + currentPage.items.length,
            0,
          );
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
          step: `${pageLabel}: Reviewing tag suggestions`,
          summary: "Stopped by user",
        });
        break;
      }

      const mutateContent = mutateResult.content as Record<string, unknown>;
      const resultObj = mutateContent.result as
        | Record<string, unknown>
        | undefined;
      const taggedCount =
        mutateResult.ok && resultObj ? Number(resultObj.updatedCount || 0) : 0;
      const mutateError = readToolResultError(mutateResult);

      if (mutateResult.ok) {
        tagged += taggedCount;
        processed += pageTargets.length;
        skipped += Math.max(0, pageTargets.length - taggedCount);
        ctx.onProgress({
          type: "step_done",
          step: `${pageLabel}: Reviewing tag suggestions`,
          summary: `Tagged ${taggedCount} item${taggedCount === 1 ? "" : "s"}`,
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
        step: `${pageLabel}: Reviewing tag suggestions`,
        summary: stopped
          ? "Stopped by user"
          : mutateError || "Tag review was denied or failed",
      });

      if (!stopped) {
        return { ok: false, error: mutateError || "Tag review failed" };
      }
      break;
    }

    ctx.onProgress({
      type: "step_done",
      step: "Reviewing tag pages",
      summary: stopped
        ? `Stopped after ${processed} item${processed === 1 ? "" : "s"}; tagged ${tagged}`
        : confirmed
          ? `Confirmed ${processed} reviewed item${processed === 1 ? "" : "s"}; tagged ${tagged}`
          : `Tagged ${tagged} item${tagged === 1 ? "" : "s"} across ${pages.length} page${pages.length === 1 ? "" : "s"}`,
    });

    const output: AutoTagOutput = {
      targeted: pagedTargetCount,
      tagged,
      skipped,
    };
    if (pages.length > 1 || stopped) {
      output.processed = processed;
    }
    if (stopped) {
      output.stopped = true;
    }
    return { ok: true, output };
  },
};

async function resolveTargetPapers(
  input: AutoTagInput,
  ctx: ActionExecutionContext,
): Promise<TargetPaper[]> {
  const explicitTarget =
    input.itemId ||
    input.itemIds?.length ||
    input.collectionId ||
    input.collectionIds?.length ||
    input.tagNames?.length ||
    input.tagScopes?.length ||
    input.scope;
  const requestContext = ctx.requestContext;
  const hasSelectedContext = Boolean(
    requestContext?.activeItemId ||
    requestContext?.selectedPaperContexts?.length ||
    requestContext?.fullTextPaperContexts?.length ||
    requestContext?.selectedCollectionContexts?.length ||
    requestContext?.selectedTagContexts?.length,
  );
  const shouldDefaultWholeLibrary =
    !explicitTarget &&
    requestContext?.mode === "library" &&
    !hasSelectedContext;
  const scopeInput: PaperScopedActionInput = explicitTarget
    ? { ...input, limit: undefined }
    : shouldDefaultWholeLibrary
      ? { ...input, scope: "all", limit: undefined }
      : { ...input, limit: undefined };
  const targets = await resolvePaperScopedActionTargets(
    scopeInput,
    ctx,
    autoTagPaperScopeProfile,
  );
  return hydratePaperTargets(targets, ctx);
}

function hydratePaperTargets(
  targets: PaperScopedActionTarget[],
  ctx: ActionExecutionContext,
): TargetPaper[] {
  const collectionById = new Map(
    typeof ctx.zoteroGateway.listCollectionSummaries === "function"
      ? ctx.zoteroGateway
          .listCollectionSummaries(ctx.libraryID)
          .map((collection) => [collection.collectionId, collection] as const)
      : [],
  );
  return targets.map((target) => {
    const metadata = ctx.zoteroGateway.getEditableArticleMetadata(
      ctx.zoteroGateway.getItem(target.itemId),
    );
    const abstract = metadata?.fields.abstractNote || "";
    const collectionTerms = target.collectionIds
      .map((collectionId) => collectionById.get(collectionId))
      .filter(
        (
          collection,
        ): collection is NonNullable<ReturnType<typeof collectionById.get>> =>
          Boolean(collection),
      )
      .flatMap((collection) => [
        collection.name,
        collection.path || collection.name,
      ]);
    return {
      itemId: target.itemId,
      title: target.title,
      abstract,
      creator: target.firstCreator || "",
      year: target.year || "",
      existingTags: Array.isArray(target.tags) ? target.tags : [],
      collectionTerms,
      dateAdded: target.dateAdded,
    };
  });
}

function compareTargetPaperDateAddedDesc(
  left: TargetPaper,
  right: TargetPaper,
): number {
  const leftTime = Date.parse(left.dateAdded || "");
  const rightTime = Date.parse(right.dateAdded || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return rightTime - leftTime;
  }
  if (Number.isFinite(rightTime)) return 1;
  if (Number.isFinite(leftTime)) return -1;
  return right.itemId - left.itemId;
}

async function fetchExistingLibraryTags(
  ctx: ActionExecutionContext,
): Promise<string[]> {
  if (typeof ctx.zoteroGateway.listLibraryTags === "function") {
    try {
      const tags = await ctx.zoteroGateway.listLibraryTags({
        libraryID: ctx.libraryID,
      });
      return Array.from(
        new Set(
          tags
            .filter((tag) => tag.type !== 1)
            .map((tag) => tag.name.trim())
            .filter(Boolean),
        ),
      );
    } catch {
      // Fall back to query_library below for tests and older gateways.
    }
  }

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
      const type = Number(record.type);
      if (name && type !== 1) tags.add(name);
    }
  }
  return Array.from(tags);
}

function suggestFallbackTags(
  item: TargetPaper,
  existingLibraryTags: string[],
  maxTags: number,
): string[] {
  const existingKeys = new Set(item.existingTags.map(normalizeTagKey));
  const itemText = [
    item.title,
    item.abstract,
    item.creator,
    item.year,
    ...item.collectionTerms,
  ].join(" ");
  const itemTokenSet = tokenizeTagText(itemText);
  const normalizedItemText = normalizeTagText(itemText);
  const out: string[] = [];
  const seen = new Set(existingKeys);

  const add = (tag: string): void => {
    const normalized = normalizeTagForSuggestion(tag);
    const key = normalizeTagKey(normalized);
    if (!normalized || seen.has(key) || isGenericTag(normalized)) return;
    seen.add(key);
    out.push(normalized);
  };

  for (const tag of existingLibraryTags) {
    if (out.length >= maxTags) break;
    const key = normalizeTagKey(tag);
    if (!key || existingKeys.has(key)) continue;
    const tagTokens = tokenizeTagText(tag);
    const exact = normalizedItemText.includes(normalizeTagText(tag));
    const tokenMatch =
      tagTokens.size > 0 &&
      Array.from(tagTokens).every((token) => itemTokenSet.has(token));
    if (exact || tokenMatch) add(tag);
  }

  for (const phrase of extractTopicalPhrases(item.title, item.abstract)) {
    if (out.length >= maxTags) break;
    add(phrase);
  }

  return out.slice(0, maxTags);
}

const TAG_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "abstract",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "of",
  "on",
  "or",
  "one",
  "paper",
  "research",
  "science",
  "study",
  "studies",
  "the",
  "three",
  "to",
  "two",
  "using",
  "via",
  "with",
]);

function normalizeTagText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeTagKey(value: string): string {
  return normalizeTagText(value).replace(/\s+/g, " ");
}

function normalizeTagForSuggestion(value: string): string {
  return normalizeTagKey(value)
    .split(/\s+/)
    .filter((token) => token && !TAG_STOPWORDS.has(token))
    .slice(0, 3)
    .join(" ");
}

function tokenizeTagText(value: string): Set<string> {
  return new Set(
    normalizeTagText(value)
      .split(/\s+/)
      .filter(
        (token) =>
          token.length >= 3 &&
          !TAG_STOPWORDS.has(token) &&
          !/^\d+$/.test(token),
      ),
  );
}

function isGenericTag(value: string): boolean {
  const tokens = value.split(/\s+/).filter(Boolean);
  return !tokens.length || tokens.every((token) => TAG_STOPWORDS.has(token));
}

function extractTopicalPhrases(title: string, abstract: string): string[] {
  const titleTokens = Array.from(tokenizeTagText(title));
  const phrases: string[] = [];
  for (let i = 0; i < titleTokens.length - 1; i += 1) {
    phrases.push(`${titleTokens[i]} ${titleTokens[i + 1]}`);
  }
  phrases.push(...titleTokens.filter((token) => token.length >= 5));

  const counts = new Map<string, number>();
  for (const token of tokenizeTagText(abstract).values()) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  const abstractTokens = Array.from(counts.entries())
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .map(([token]) => token)
    .filter((token) => token.length >= 5);
  phrases.push(...abstractTokens);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const phrase of phrases) {
    const key = normalizeTagKey(phrase);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

async function suggestTagsForItems(
  items: TargetPaper[],
  existingTags: string[],
  maxTags: number,
  userQuery: string | undefined,
  ctx: ActionExecutionContext,
): Promise<Array<{ itemId: number; tags: string[] }>> {
  if (!ctx.llm) return [];
  return collectActionLlmBatchResults(items, LLM_BATCH_SIZE, (batch) =>
    suggestTagsBatch(
      batch,
      existingTags,
      maxTags,
      userQuery,
      ctx,
    ),
  );
}

async function suggestTagsBatch(
  batch: TargetPaper[],
  existingTags: string[],
  maxTags: number,
  userQuery: string | undefined,
  ctx: ActionExecutionContext,
): Promise<Array<{ itemId: number; tags: string[] }>> {
  if (!ctx.llm) return [];
  const prompt = buildTagPrompt(batch, existingTags, maxTags, userQuery);
  const raw = await callActionLlm({
    ctx,
    prompt,
    maxTokens: 800,
  });
  return parseTagResponse(raw, batch, maxTags);
}

function buildTagPrompt(
  batch: TargetPaper[],
  existingTags: string[],
  maxTags: number,
  userQuery: string | undefined,
): string {
  const vocab = existingTags.length
    ? `Existing manual tags in this library (prefer these when they fit):\n${existingTags
        .slice(0, 80)
        .map((tag) => `- ${tag}`)
        .join("\n")}\n\n`
    : "";
  const itemsBlock = batch
    .map((item) => {
      const abstract = item.abstract
        ? item.abstract.slice(0, 800).replace(/\s+/g, " ").trim()
        : "(no abstract available)";
      const byline = [item.creator, item.year].filter(Boolean).join(" - ");
      const existing = item.existingTags.length
        ? item.existingTags.join(", ")
        : "(none)";
      const collections = item.collectionTerms.length
        ? item.collectionTerms.join(", ")
        : "(none)";
      return [
        `itemId: ${item.itemId}`,
        `title: ${item.title}`,
        byline ? `byline: ${byline}` : "",
        `existing tags: ${existing}`,
        `collections: ${collections}`,
        `abstract: ${abstract}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n---\n\n");

  return [
    "You are tagging scholarly items for a Zotero library.",
    `For each item below, propose up to ${maxTags} short, topical tags to ADD.`,
    "Guidelines:",
    "- Prefer short lowercase phrases (1-3 words).",
    "- Reuse an existing manual tag from the library vocabulary whenever it fits.",
    "- Never repeat a tag that already exists on that item.",
    "- Only suggest tags that add useful new information beyond the current tags.",
    "- Do not include generic filler like research, paper, study, or science.",
    "- If the current tags already cover the item well, return an empty tags array for it.",
    "",
    userQuery?.trim()
      ? `Extra user instructions for this auto-tag action:\n${userQuery.trim()}\n`
      : "",
    vocab,
    "Items:",
    itemsBlock,
    "",
    "Respond with ONLY a JSON array, no prose, no code fence. Shape:",
    '[{"itemId": <number>, "tags": ["tag1", "tag2"]}, ...]',
  ].join("\n");
}

function parseTagResponse(
  raw: string,
  batch: TargetPaper[],
  maxTags: number,
): Array<{ itemId: number; tags: string[] }> {
  const batchByItemId = new Map(
    batch.map((item) => [item.itemId, item] as const),
  );
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
    const seen = new Set(sourceItem.existingTags.map(normalizeTagKey));
    const rawTags = Array.isArray(record.tags) ? record.tags : [];
    const tags = rawTags
      .map((tag) =>
        typeof tag === "string" ? normalizeTagForSuggestion(tag) : "",
      )
      .filter((tag): tag is string => {
        if (!tag) return false;
        const key = normalizeTagKey(tag);
        if (seen.has(key) || isGenericTag(tag)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, maxTags);
    if (tags.length) out.push({ itemId, tags });
  }
  return out;
}

import type {
  AgentAction,
  ActionExecutionContext,
  ActionResult,
} from "./types";

// ── Types ────────────────────────────────────────────────────────────────────

type StatisticsScope = "all" | "collection";

type StatisticsSection =
  | "itemTypes"
  | "yearDistribution"
  | "topAuthors"
  | "topJournals"
  | "collections"
  | "tags"
  | "annotations"
  | "growthTimeline"
  | "authorshipStats"
  | "titleKeywords";

const ALL_SECTIONS: StatisticsSection[] = [
  "itemTypes",
  "yearDistribution",
  "topAuthors",
  "topJournals",
  "collections",
  "tags",
  "annotations",
  "growthTimeline",
  "authorshipStats",
  "titleKeywords",
];

type LibraryStatisticsInput = {
  scope?: StatisticsScope;
  collectionId?: number;
  sections?: StatisticsSection[];
  topN?: number;
};

type CollectionStat = {
  collectionId: number;
  name: string;
  path: string;
  itemCount: number;
};

type AnnotatedItem = {
  itemId: number;
  title: string;
  count: number;
};

type LibraryStatisticsOutput = {
  libraryName: string;
  totalItems: number;
  scopeDescription: string;
  computedAt: string;

  itemTypes?: Record<string, number>;
  yearDistribution?: { year: string; count: number }[];
  topAuthors?: { name: string; count: number }[];
  topJournals?: { name: string; count: number }[];
  collections?: { total: number; tree: CollectionStat[]; unfiledCount: number };
  tags?: {
    totalTags: number;
    totalAssignments: number;
    topTags: { name: string; count: number }[];
    untaggedItemCount: number;
  };
  annotations?: {
    totalAnnotations: number;
    itemsWithAnnotations: number;
    mostAnnotated: AnnotatedItem[];
    annotationsByType: Record<string, number>;
  };
  growthTimeline?: { month: string; count: number }[];
  authorshipStats?: {
    avgAuthorsPerItem: number;
    maxAuthorsPerItem: number;
    minAuthorsPerItem: number;
    singleAuthorCount: number;
    multiAuthorCount: number;
  };
  titleKeywords?: { word: string; count: number }[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeText(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim();
}

function getItemTypeName(item: Zotero.Item): string {
  try {
    const name = (
      Zotero as unknown as {
        ItemTypes?: { getName?: (id: number) => string };
      }
    ).ItemTypes?.getName?.(item.itemTypeID);
    return typeof name === "string" && name.trim() ? name.trim() : "";
  } catch {
    return "";
  }
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) || 0) + 1);
}

function topNFromMap(
  map: Map<string, number>,
  n: number,
): { name: string; count: number }[] {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "as",
  "is",
  "was",
  "are",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "not",
  "no",
  "nor",
  "so",
  "yet",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "than",
  "too",
  "very",
  "its",
  "that",
  "this",
  "these",
  "those",
  "it",
  "we",
  "they",
  "their",
  "our",
  "your",
  "my",
  "his",
  "her",
  "about",
  "above",
  "after",
  "again",
  "all",
  "also",
  "among",
  "any",
  "between",
  "during",
  "into",
  "over",
  "through",
  "under",
  "using",
  "via",
  "based",
  "new",
  "how",
  "what",
  "which",
  "when",
  "where",
  "who",
  "why",
  "upon",
]);

function tokenizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function mapToRecord(map: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of map) out[key] = value;
  return out;
}

// ── Action ───────────────────────────────────────────────────────────────────

export const libraryStatisticsAction: AgentAction<
  LibraryStatisticsInput,
  LibraryStatisticsOutput
> = {
  name: "library_statistics",
  modes: ["library"],
  description:
    "Compute comprehensive summary statistics about the library: item counts by type, " +
    "publication year distribution, top authors, top journals, collection structure, tag usage, " +
    "annotation counts, library growth timeline, authorship patterns, and title keyword frequency.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: {
        type: "string",
        enum: ["all", "collection"],
        description: "Which items to analyze. Default: 'all'.",
      },
      collectionId: {
        type: "number",
        description: "Required when scope is 'collection'.",
      },
      sections: {
        type: "array",
        items: {
          type: "string",
          enum: ALL_SECTIONS,
        },
        description:
          "Which statistics sections to compute. Default: all. " +
          "Available: itemTypes, yearDistribution, topAuthors, topJournals, " +
          "collections, tags, annotations, growthTimeline, authorshipStats, titleKeywords.",
      },
      topN: {
        type: "number",
        description: "How many items to include in 'top N' lists. Default: 15.",
      },
    },
  },

  async execute(
    input: LibraryStatisticsInput,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult<LibraryStatisticsOutput>> {
    const enabled = new Set<StatisticsSection>(
      Array.isArray(input.sections) && input.sections.length > 0
        ? input.sections.filter((s): s is StatisticsSection =>
            ALL_SECTIONS.includes(s as StatisticsSection),
          )
        : ALL_SECTIONS,
    );
    const topN =
      Number.isFinite(input.topN) && (input.topN as number) > 0
        ? Math.floor(input.topN as number)
        : 15;

    const STEPS =
      2 +
      (enabled.has("collections") ? 1 : 0) +
      (enabled.has("annotations") ? 1 : 0) +
      1;
    let step = 0;

    // ── Step 1: Load items ─────────────────────────────────────────────────
    ctx.onProgress({
      type: "step_start",
      step: "Loading library items",
      index: ++step,
      total: STEPS,
    });

    let items: Zotero.Item[];
    try {
      const rawItems: Zotero.Item[] = await Zotero.Items.getAll(
        ctx.libraryID,
        false,
        false,
        false,
      );
      items = rawItems.filter((item) => {
        if ((item as any).isNote?.()) return !item.parentID;
        if (item.isAttachment?.()) return false;
        return item.isRegularItem?.() ?? false;
      });
    } catch (err) {
      return {
        ok: false,
        error: `Failed to load library items: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Filter by collection if scoped
    if (input.scope === "collection" && input.collectionId) {
      const targetCollectionId = Math.floor(input.collectionId);
      items = items.filter((item) => {
        try {
          const colIds = item.getCollections?.() || [];
          return colIds.includes(targetCollectionId);
        } catch {
          return false;
        }
      });
    }

    ctx.onProgress({
      type: "step_done",
      step: "Loading library items",
      summary: `Found ${items.length} item${items.length === 1 ? "" : "s"}`,
    });

    // ── Step 2: Single-pass aggregation ────────────────────────────────────
    ctx.onProgress({
      type: "step_start",
      step: "Computing statistics",
      index: ++step,
      total: STEPS,
    });

    const typeCounts = new Map<string, number>();
    const yearCounts = new Map<string, number>();
    const authorCounts = new Map<string, number>();
    const journalCounts = new Map<string, number>();
    const tagCounts = new Map<string, number>();
    const collectionItemCounts = new Map<number, number>();
    const monthCounts = new Map<string, number>();
    const wordCounts = new Map<string, number>();

    let totalAuthorsSum = 0;
    let itemsWithAuthors = 0;
    let maxAuthors = 0;
    let minAuthors = Infinity;
    let singleAuthorCount = 0;
    let multiAuthorCount = 0;
    let untaggedCount = 0;
    let unfiledCount = 0;
    let totalTagAssignments = 0;

    for (const item of items) {
      // Standalone notes: count type but skip bibliographic stats
      if ((item as any).isNote?.()) {
        if (enabled.has("itemTypes")) increment(typeCounts, "note");
        // growth timeline applies to notes too
        if (enabled.has("growthTimeline")) {
          try {
            const da = normalizeText(item.getField?.("dateAdded"));
            const m = da.match(/^(\d{4}-\d{2})/);
            if (m) increment(monthCounts, m[1]);
          } catch {
            /* ignore */
          }
        }
        continue;
      }

      // ── Item type ──
      if (enabled.has("itemTypes")) {
        increment(typeCounts, getItemTypeName(item) || "unknown");
      }

      // ── Year ──
      if (enabled.has("yearDistribution")) {
        try {
          const dateStr = normalizeText(item.getField?.("date"));
          const yearMatch = dateStr.match(/\b(19|20)\d{2}\b/);
          if (yearMatch) increment(yearCounts, yearMatch[0]);
        } catch {
          /* ignore */
        }
      }

      // ── Authors ──
      if (enabled.has("topAuthors") || enabled.has("authorshipStats")) {
        try {
          const creators: Array<{
            firstName?: string;
            lastName?: string;
            name?: string;
            creatorType?: string;
          }> = (item as any).getCreatorsJSON?.() || [];
          const names: string[] = [];
          for (const c of creators) {
            const name = (
              c.name || [c.firstName, c.lastName].filter(Boolean).join(" ")
            ).trim();
            if (name) names.push(name);
          }
          const numAuthors = names.length;
          if (numAuthors > 0) {
            itemsWithAuthors++;
            totalAuthorsSum += numAuthors;
            if (numAuthors > maxAuthors) maxAuthors = numAuthors;
            if (numAuthors < minAuthors) minAuthors = numAuthors;
            if (numAuthors === 1) singleAuthorCount++;
            if (numAuthors > 1) multiAuthorCount++;
          }
          if (enabled.has("topAuthors")) {
            for (const name of names) increment(authorCounts, name);
          }
        } catch {
          /* ignore */
        }
      }

      // ── Journal / venue ──
      if (enabled.has("topJournals")) {
        try {
          const pubTitle = normalizeText(item.getField?.("publicationTitle"));
          if (pubTitle) increment(journalCounts, pubTitle);
        } catch {
          /* ignore */
        }
      }

      // ── Tags ──
      if (enabled.has("tags")) {
        try {
          const tags: Array<{ tag: string }> = item.getTags?.() || [];
          if (tags.length === 0) untaggedCount++;
          for (const t of tags) {
            const tagName = normalizeText(t?.tag);
            if (tagName) {
              increment(tagCounts, tagName);
              totalTagAssignments++;
            }
          }
        } catch {
          /* ignore */
        }
      }

      // ── Collections (for unfiled count and per-collection item counts) ──
      if (enabled.has("collections")) {
        try {
          const colIds: number[] = item.getCollections?.() || [];
          if (colIds.length === 0) unfiledCount++;
          for (const cid of colIds) {
            const id = Number(cid);
            if (Number.isFinite(id) && id > 0) {
              collectionItemCounts.set(
                id,
                (collectionItemCounts.get(id) || 0) + 1,
              );
            }
          }
        } catch {
          /* ignore */
        }
      }

      // ── Growth timeline ──
      if (enabled.has("growthTimeline")) {
        try {
          const da = normalizeText(item.getField?.("dateAdded"));
          const m = da.match(/^(\d{4}-\d{2})/);
          if (m) increment(monthCounts, m[1]);
        } catch {
          /* ignore */
        }
      }

      // ── Title keywords ──
      if (enabled.has("titleKeywords")) {
        try {
          const title = normalizeText(item.getField?.("title"));
          if (title) {
            for (const word of tokenizeTitle(title)) {
              increment(wordCounts, word);
            }
          }
        } catch {
          /* ignore */
        }
      }
    }

    ctx.onProgress({
      type: "step_done",
      step: "Computing statistics",
      summary: `Processed ${items.length} item${items.length === 1 ? "" : "s"}`,
    });

    // ── Step 3 (conditional): Collection structure ─────────────────────────
    let collectionsResult: LibraryStatisticsOutput["collections"];
    if (enabled.has("collections")) {
      ctx.onProgress({
        type: "step_start",
        step: "Analyzing collections",
        index: ++step,
        total: STEPS,
      });
      try {
        const summaries = ctx.zoteroGateway.listCollectionSummaries(
          ctx.libraryID,
        );
        const tree: CollectionStat[] = summaries.map((s) => ({
          collectionId: s.collectionId,
          name: s.name,
          path: s.path || s.name,
          itemCount: collectionItemCounts.get(s.collectionId) || 0,
        }));
        collectionsResult = {
          total: summaries.length,
          tree,
          unfiledCount,
        };
        ctx.onProgress({
          type: "step_done",
          step: "Analyzing collections",
          summary: `Found ${summaries.length} collection${summaries.length === 1 ? "" : "s"}`,
        });
      } catch {
        collectionsResult = { total: 0, tree: [], unfiledCount };
        ctx.onProgress({
          type: "step_done",
          step: "Analyzing collections",
          summary: "Failed to load collections",
        });
      }
    }

    // ── Step 4 (conditional): Annotation counting ──────────────────────────
    let annotationsResult: LibraryStatisticsOutput["annotations"];
    if (enabled.has("annotations")) {
      ctx.onProgress({
        type: "step_start",
        step: "Counting annotations",
        index: ++step,
        total: STEPS,
      });

      let totalAnnotations = 0;
      let itemsWithAnnotations = 0;
      const annotationsByType = new Map<string, number>();
      const perItemCounts: AnnotatedItem[] = [];

      for (const item of items) {
        if (!item.isRegularItem?.()) continue;
        try {
          const attachmentIds: number[] = item.getAttachments?.() || [];
          let itemAnnotationCount = 0;

          for (const attId of attachmentIds) {
            const att = Zotero.Items.get(attId);
            if (!att?.isAttachment?.()) continue;
            const contentType = normalizeText(att.attachmentContentType);
            if (contentType !== "application/pdf") continue;

            const annotationIds: number[] =
              (
                att as unknown as {
                  getAnnotations?: (includeTrashed?: boolean) => number[];
                }
              ).getAnnotations?.(false) || [];
            for (const annId of annotationIds) {
              const ann = Zotero.Items.get(annId);
              if (!ann?.isAnnotation?.()) continue;
              const annType =
                normalizeText(
                  (ann as unknown as { annotationType?: string })
                    .annotationType,
                ) || "highlight";
              increment(annotationsByType, annType);
              itemAnnotationCount++;
            }
          }

          if (itemAnnotationCount > 0) {
            itemsWithAnnotations++;
            totalAnnotations += itemAnnotationCount;
            perItemCounts.push({
              itemId: item.id,
              title:
                normalizeText(item.getField?.("title")) || `Item ${item.id}`,
              count: itemAnnotationCount,
            });
          }
        } catch {
          /* ignore individual item errors */
        }
      }

      perItemCounts.sort((a, b) => b.count - a.count);
      annotationsResult = {
        totalAnnotations,
        itemsWithAnnotations,
        mostAnnotated: perItemCounts.slice(0, topN),
        annotationsByType: mapToRecord(annotationsByType),
      };

      ctx.onProgress({
        type: "step_done",
        step: "Counting annotations",
        summary: `Found ${totalAnnotations} annotation${totalAnnotations === 1 ? "" : "s"} across ${itemsWithAnnotations} item${itemsWithAnnotations === 1 ? "" : "s"}`,
      });
    }

    // ── Step 5: Compile results ────────────────────────────────────────────
    ctx.onProgress({
      type: "step_start",
      step: "Compiling results",
      index: ++step,
      total: STEPS,
    });

    // Resolve library name
    let libraryName = "My Library";
    try {
      libraryName = Zotero.Libraries.getName(ctx.libraryID) || libraryName;
    } catch {
      /* ignore */
    }

    // Scope description
    let scopeDescription = "entire library";
    if (input.scope === "collection" && input.collectionId) {
      const collName = collectionsResult?.tree.find(
        (c) => c.collectionId === input.collectionId,
      )?.path;
      scopeDescription = collName
        ? `collection: ${collName}`
        : `collection ID ${input.collectionId}`;
    }

    const output: LibraryStatisticsOutput = {
      libraryName,
      totalItems: items.length,
      scopeDescription,
      computedAt: new Date().toISOString(),
    };

    if (enabled.has("itemTypes")) {
      output.itemTypes = mapToRecord(typeCounts);
    }

    if (enabled.has("yearDistribution")) {
      output.yearDistribution = Array.from(yearCounts.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([year, count]) => ({ year, count }));
    }

    if (enabled.has("topAuthors")) {
      output.topAuthors = topNFromMap(authorCounts, topN);
    }

    if (enabled.has("topJournals")) {
      output.topJournals = topNFromMap(journalCounts, topN);
    }

    if (enabled.has("collections") && collectionsResult) {
      output.collections = collectionsResult;
    }

    if (enabled.has("tags")) {
      output.tags = {
        totalTags: tagCounts.size,
        totalAssignments: totalTagAssignments,
        topTags: topNFromMap(tagCounts, topN),
        untaggedItemCount: untaggedCount,
      };
    }

    if (enabled.has("annotations") && annotationsResult) {
      output.annotations = annotationsResult;
    }

    if (enabled.has("growthTimeline")) {
      output.growthTimeline = Array.from(monthCounts.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([month, count]) => ({ month, count }));
    }

    if (enabled.has("authorshipStats") && itemsWithAuthors > 0) {
      output.authorshipStats = {
        avgAuthorsPerItem:
          Math.round((totalAuthorsSum / itemsWithAuthors) * 10) / 10,
        maxAuthorsPerItem: maxAuthors,
        minAuthorsPerItem: minAuthors === Infinity ? 0 : minAuthors,
        singleAuthorCount,
        multiAuthorCount,
      };
    }

    if (enabled.has("titleKeywords")) {
      output.titleKeywords = topNFromMap(wordCounts, topN).map((e) => ({
        word: e.name,
        count: e.count,
      }));
    }

    ctx.onProgress({
      type: "step_done",
      step: "Compiling results",
      summary: "Done",
    });

    return { ok: true, output };
  },
};

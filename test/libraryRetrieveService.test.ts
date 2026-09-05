import { assert } from "chai";
import {
  LibraryRetrieveService as ResolvedLibraryRetrieveService,
  QUICKSEARCH_MAX_PROBES,
  buildQuicksearchProbes,
} from "../src/agent/services/libraryRetrieveService";
import { buildRetrievalQueryPlan } from "../src/modules/contextPanel/retrievalQueryPlan";
import type {
  EditableArticleMetadataSnapshot,
  LibraryItemTarget,
} from "../src/agent/services/zoteroGateway";
import type {
  PaperContextCandidate,
  PdfContext,
} from "../src/modules/contextPanel/types";
import type { PaperContextRef } from "../src/shared/types";
import { normalizeLibraryRetrieveArgs } from "../src/agent/tools/read/libraryRetrieve";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

class LibraryRetrieveService extends ResolvedLibraryRetrieveService {
  override retrieve(
    params: Parameters<ResolvedLibraryRetrieveService["retrieve"]>[0],
  ): ReturnType<ResolvedLibraryRetrieveService["retrieve"]> {
    return super.retrieve({
      ...params,
      request: resolvedAgentRequest(params.request),
    });
  }
}

function makeItem(
  itemId: number,
  title: string,
  abstractNote = "",
  options: { hasPdf?: boolean; collectionIds?: number[]; tags?: string[] } = {},
): {
  target: LibraryItemTarget;
  metadata: EditableArticleMetadataSnapshot;
  paperContext: PaperContextRef | null;
} {
  const hasPdf = options.hasPdf !== false;
  return {
    target: {
      itemId,
      itemType: "journalArticle",
      title,
      firstCreator: "Smith",
      year: "2024",
      attachments: hasPdf
        ? [
            {
              contextItemId: 1000 + itemId,
              title: "PDF",
              contentType: "application/pdf",
            },
          ]
        : [],
      tags: options.tags || [],
      collectionIds: options.collectionIds || [],
    },
    metadata: {
      itemId,
      itemType: "journalArticle",
      title,
      fields: {
        title,
        shortTitle: "",
        abstractNote,
        publicationTitle: "",
        journalAbbreviation: "",
        proceedingsTitle: "",
        date: "2024",
        volume: "",
        issue: "",
        pages: "",
        DOI: "",
        url: "",
        language: "",
        extra: "",
        ISSN: "",
        ISBN: "",
        publisher: "",
        place: "",
      },
      creators: [
        {
          creatorType: "author",
          firstName: "Ada",
          lastName: "Smith",
        },
      ],
    },
    paperContext: hasPdf
      ? {
          itemId,
          contextItemId: 1000 + itemId,
          title,
          firstCreator: "Smith",
          year: "2024",
        }
      : null,
  };
}

function makePdfContext(chunks: string[]): PdfContext {
  return {
    title: "PDF",
    chunks,
    chunkMeta: chunks.map((chunk, index) => ({
      chunkIndex: index,
      text: chunk,
      normalizedText: chunk,
      chunkKind: index === 0 ? "abstract" : "body",
      sectionLabel: index === 0 ? "Abstract" : "Methods",
    })),
    chunkStats: chunks.map((chunk, index) => ({
      index,
      tf: {},
      uniqueTerms: [],
      length: chunk.split(/\s+/).length,
    })),
    docFreq: {},
    avgChunkLength: chunks.length
      ? chunks.join(" ").split(/\s+/).length / chunks.length
      : 0,
    fullLength: chunks.join("\n\n").length,
    sourceType: "zotero-fulltext-cache",
  };
}

function makeGateway(
  entries: ReturnType<typeof makeItem>[],
  options: {
    collectionItems?: ReturnType<typeof makeItem>[];
    quicksearchItemIds?: number[] | ((query: string | undefined) => number[]);
    quicksearchCalls?: Array<{
      limit?: number;
      query?: string;
      filters?: Record<string, unknown>;
      allowedItemIds?: number[];
    }>;
  } = {},
) {
  const byItemId = new Map(
    entries.map((entry) => [entry.target.itemId, entry]),
  );
  const collectionItems = options.collectionItems || entries;
  return {
    resolveLibraryID: () => 1,
    getItem: (itemId: number | undefined) =>
      itemId ? ({ id: itemId } as Zotero.Item) : null,
    getEditableArticleMetadata: (item: Zotero.Item | null | undefined) =>
      item ? byItemId.get((item as { id: number }).id)?.metadata || null : null,
    resolvePaperContextTarget: ({ itemId }: { itemId?: number }) =>
      itemId ? byItemId.get(itemId)?.paperContext || null : null,
    getCollectionSummary: (collectionId: number | undefined) =>
      collectionId
        ? {
            collectionId,
            name: `Collection ${collectionId}`,
            libraryID: 1,
            path: `Root / Collection ${collectionId}`,
          }
        : null,
    listBibliographicItemTargets: async ({ limit }: { limit?: number }) => ({
      items: entries
        .map((entry) => entry.target)
        .slice(0, limit || entries.length),
      totalCount: entries.length,
    }),
    listCollectionItemTargets: async ({
      collectionId,
      limit,
    }: {
      collectionId: number;
      limit?: number;
    }) => ({
      collection: {
        collectionId,
        name: `Collection ${collectionId}`,
        libraryID: 1,
        path: `Root / Collection ${collectionId}`,
      },
      items: collectionItems
        .map((entry) => entry.target)
        .slice(0, limit || collectionItems.length),
      totalCount: collectionItems.length,
    }),
    listTagItemTargets: async ({
      tagContext,
      limit,
    }: {
      tagContext: {
        name: string;
        normalizedName?: string;
        scope?: "allTagged" | "untagged";
      };
      limit?: number;
    }) => {
      const normalizedName = (
        tagContext.normalizedName || tagContext.name
      ).toLowerCase();
      const tagItems = entries.filter((entry) => {
        if (tagContext.scope === "allTagged") {
          return entry.target.tags.length > 0;
        }
        if (tagContext.scope === "untagged") {
          return entry.target.tags.length === 0;
        }
        return entry.target.tags.some(
          (tag) =>
            tag === tagContext.name || tag.toLowerCase() === normalizedName,
        );
      });
      return {
        tagName: tagContext.name,
        items: tagItems
          .map((entry) => entry.target)
          .slice(0, limit || tagItems.length),
        totalCount: tagItems.length,
      };
    },
    resolveLibraryScopeItemIds: async ({
      itemIds = [],
      collectionIds = [],
      tagContexts = [],
    }: {
      itemIds?: number[];
      collectionIds?: number[];
      tagContexts?: Array<{
        name: string;
        normalizedName?: string;
        scope?: "allTagged" | "untagged";
      }>;
    }) => {
      const union = new Set<number>();
      const tagItemIds = new Set<number>();
      let summedScopeCount = 0;
      const add = (
        scopedEntries: ReturnType<typeof makeItem>[],
        tagScope = false,
      ) => {
        for (const entry of scopedEntries) {
          union.add(entry.target.itemId);
          if (tagScope) tagItemIds.add(entry.target.itemId);
        }
        return scopedEntries.length;
      };

      add(
        itemIds
          .map((itemId) => byItemId.get(itemId))
          .filter((entry): entry is ReturnType<typeof makeItem> =>
            Boolean(entry),
          ),
      );

      const collectionNames: string[] = [];
      for (const collectionId of collectionIds) {
        collectionNames.push(`Root / Collection ${collectionId}`);
        const matches = collectionItems.filter((entry) =>
          entry.target.collectionIds.includes(collectionId),
        );
        summedScopeCount += add(matches);
      }

      const tagNames: string[] = [];
      for (const tagContext of tagContexts) {
        tagNames.push(tagContext.name);
        const normalizedName = (
          tagContext.normalizedName || tagContext.name
        ).toLowerCase();
        const matches = entries.filter((entry) => {
          if (tagContext.scope === "allTagged") {
            return entry.target.tags.length > 0;
          }
          if (tagContext.scope === "untagged") {
            return entry.target.tags.length === 0;
          }
          return entry.target.tags.some(
            (tag) =>
              tag === tagContext.name || tag.toLowerCase() === normalizedName,
          );
        });
        summedScopeCount += add(matches, true);
      }

      return {
        itemIds: [...union],
        tagItemIds: [...tagItemIds],
        collectionNames,
        tagNames,
        summedScopeCount,
      };
    },
    getBibliographicItemTargetsByItemIds: (itemIds: number[]) =>
      itemIds
        .map((itemId) => byItemId.get(itemId)?.target)
        .filter((entry): entry is LibraryItemTarget => Boolean(entry)),
    searchAllLibraryItems: async (params: {
      limit?: number;
      query?: string;
      filters?: Record<string, unknown>;
      allowedItemIds?: number[];
    }) => {
      options.quicksearchCalls?.push(params);
      const quicksearchIds =
        typeof options.quicksearchItemIds === "function"
          ? options.quicksearchItemIds(params.query)
          : options.quicksearchItemIds || [];
      const allowedItemIds = Array.isArray(params.allowedItemIds)
        ? new Set(params.allowedItemIds)
        : null;
      const tagFilter =
        typeof params.filters?.tag === "string" ? params.filters.tag : "";
      const collectionFilter =
        typeof params.filters?.collectionId === "number"
          ? params.filters.collectionId
          : 0;
      const matches = quicksearchIds
        .map((itemId) => byItemId.get(itemId)?.target)
        .filter((entry): entry is LibraryItemTarget => Boolean(entry))
        .filter((entry) =>
          allowedItemIds ? allowedItemIds.has(entry.itemId) : true,
        )
        .filter((entry) =>
          collectionFilter
            ? entry.collectionIds.includes(collectionFilter)
            : true,
        )
        .filter((entry) => (tagFilter ? entry.tags.includes(tagFilter) : true));
      const limit = params.limit || matches.length;
      return {
        items: matches.slice(0, limit),
        totalCount: matches.length,
      };
    },
  };
}

describe("LibraryRetrieveService", function () {
  it("metadata mode inspects a 500-paper folder without full-text expansion", async function () {
    const entries = Array.from({ length: 500 }, (_, index) =>
      makeItem(
        index + 1,
        index === 41 ? "Calcium imaging analysis" : `Paper ${index + 1}`,
        index === 41
          ? "This paper studies calcium imaging analysis pipelines."
          : "",
        { hasPdf: true },
      ),
    );
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "calcium imaging analysis",
      depth: "metadata",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Find calcium imaging analysis papers",
        libraryID: 1,
      },
    });

    assert.equal(result.resourcePool.totalItems, 500);
    assert.equal(result.resourcePool.queryCoverage.metadataInspected, 500);
    assert.equal(result.resourcePool.queryCoverage.fullTextSearched, 0);
    assert.equal(result.resourcePool.queryCoverage.indexedTextScanned, 0);
    assert.isAtLeast(result.resourcePool.queryCoverage.matchedMetadata, 1);
    assert.equal(result.candidates[0].itemId, "42");
  });

  it("evidence mode expands only the full-text budget and applies a global snippet cap", async function () {
    const entries = Array.from({ length: 100 }, (_, index) =>
      makeItem(
        index + 1,
        `Denoising paper ${index + 1}`,
        "Denoising methods.",
        {
          hasPdf: true,
        },
      ),
    );
    const calls: number[] = [];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async () =>
          makePdfContext(["Methods\nA denoising model is evaluated."]),
      } as any,
      async (paperContext): Promise<PaperContextCandidate[]> => {
        calls.push(paperContext.itemId);
        return [0, 1, 2].map((index) => ({
          paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
          itemId: paperContext.itemId,
          contextItemId: paperContext.contextItemId,
          title: paperContext.title,
          chunkIndex: index,
          chunkText: `Candidate ${index} denoising evidence for ${paperContext.title}.`,
          chunkKind: "methods",
          estimatedTokens: 10,
          bm25Score: 1,
          embeddingScore: 0,
          hybridScore: 1,
          evidenceScore: 1 - index * 0.1,
        }));
      },
    );

    const result = await service.retrieve({
      query: "denoising",
      depth: "evidence",
      methods: ["metadata", "abstract", "fts"],
      maxFullTextPapers: 2,
      perPaperTopK: 3,
      maxTotalSnippets: 4,
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Find denoising evidence",
        libraryID: 1,
      },
    });

    assert.lengthOf(calls, 2);
    assert.equal(result.resourcePool.queryCoverage.fullTextSearched, 2);
    assert.equal(result.resourcePool.queryCoverage.snippetPapersExpanded, 2);
    assert.lengthOf(result.snippets, 4);
    assert.equal(result.intent, "enumerate");
    assert.equal(result.answerContract.snippetCoverage, "sampled");
    assert.isUndefined(result.quoteCitations);
    assert.notProperty(result.snippets[0], "quoteCitationId");
  });

  it("summarize intent returns snippets as evidence without quote-card anchors", async function () {
    const entries = [
      makeItem(1, "Representational drift overview", "", {
        hasPdf: true,
      }),
    ];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async () =>
          makePdfContext([
            "Abstract\nRepresentational drift appears across multiple neural systems while task-level structure remains usable.",
          ]),
      } as any,
      async (paperContext): Promise<PaperContextCandidate[]> => [
        {
          paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
          itemId: paperContext.itemId,
          contextItemId: paperContext.contextItemId,
          title: paperContext.title,
          chunkIndex: 0,
          chunkText:
            "Representational drift appears across multiple neural systems while task-level structure remains usable.",
          chunkKind: "abstract",
          sectionLabel: "Abstract",
          estimatedTokens: 14,
          bm25Score: 1,
          embeddingScore: 0,
          hybridScore: 1,
          evidenceScore: 1,
        },
      ],
    );

    const result = await service.retrieve({
      query: "commonality of representational drift papers",
      intent: "summarize",
      depth: "evidence",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "What is the commonality of those papers?",
        libraryID: 1,
      },
    });

    assert.lengthOf(result.snippets, 1);
    assert.isUndefined(result.quoteCitations);
    assert.notProperty(result.snippets[0], "quoteCitationId");
  });

  it("treats a bounded selected-paper commonality prompt as deep synthesis, not abstract-only overview", async function () {
    const entries = Array.from({ length: 23 }, (_, index) =>
      makeItem(
        index + 1,
        `Representational drift paper ${index + 1}`,
        "The abstract maps representational drift across repeated measurements.",
        { hasPdf: true },
      ),
    );
    const loadedPaperIds: number[] = [];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async (paperContext: PaperContextRef) => {
          loadedPaperIds.push(paperContext.itemId);
          return makePdfContext([
            `Abstract\nPaper ${paperContext.itemId} introduces representational drift as a long-timescale neural population phenomenon.`,
            `Results\nPaper ${paperContext.itemId} shows body-level evidence that neural codes change while task-relevant structure remains interpretable.`,
            `Discussion\nPaper ${paperContext.itemId} connects the drift evidence to common mechanisms across brain regions.`,
          ]);
        },
      } as any,
      async (paperContext): Promise<PaperContextCandidate[]> => [
        {
          paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
          itemId: paperContext.itemId,
          contextItemId: paperContext.contextItemId,
          title: paperContext.title,
          chunkIndex: 0,
          chunkText: `Abstract\nPaper ${paperContext.itemId} introduces representational drift as a long-timescale neural population phenomenon.`,
          chunkKind: "abstract",
          sectionLabel: "Abstract",
          estimatedTokens: 18,
          bm25Score: 0.5,
          embeddingScore: 0.6,
          hybridScore: 0.6,
          evidenceScore: 0.6,
        },
        {
          paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
          itemId: paperContext.itemId,
          contextItemId: paperContext.contextItemId,
          title: paperContext.title,
          chunkIndex: 1,
          chunkText: `Results\nPaper ${paperContext.itemId} shows body-level evidence that neural codes change while task-relevant structure remains interpretable.`,
          chunkKind: "results",
          sectionLabel: "Results",
          estimatedTokens: 18,
          bm25Score: 0.4,
          embeddingScore: 0.7,
          hybridScore: 0.7,
          evidenceScore: 0.7,
        },
      ],
    );

    const result = await service.retrieve({
      scope: { itemIds: entries.map((entry) => entry.target.itemId) },
      query: "what is the commonality of those representational drift papers",
      intent: "summarize",
      depth: "evidence",
      methods: ["metadata", "abstract", "semantic"],
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "What is the commonality of those papers?",
        libraryID: 1,
      },
    });

    const answerContract = result.answerContract as any;
    assert.equal(answerContract.resolvedStrategy, "deep_synthesis");
    assert.equal(answerContract.papersPlanned, 23);
    assert.equal(answerContract.papersBodyRead, 23);
    assert.equal(answerContract.papersMetadataOnly, 0);
    assert.equal(answerContract.stopReason, "enough_evidence");
    assert.equal(result.resourcePool.queryCoverage.deepReadPapers, 23);
    assert.sameMembers(
      loadedPaperIds,
      entries.map((entry) => entry.target.itemId),
    );
    assert.lengthOf(
      new Set(
        result.snippets
          .filter((snippet) => snippet.sectionLabel === "Results")
          .map((snippet) => snippet.itemId),
      ),
      23,
    );
    assert.isUndefined(result.quoteCitations);
    assert.include(
      (result as any).evidenceLedgerText,
      "Paper coverage ledger:",
    );
    assert.include((result as any).synthesisDigest, "Paper synthesis digest:");
    assert.include((result as any).coverageReceipt?.text, "Reading receipt:");
    assert.equal((result as any).coverageReceipt?.papersPlanned, 23);
    assert.equal((result as any).coverageReceipt?.papersBodyRead, 23);
  });

  it("keeps answer contract and receipt coverage counts consistent for abstract-only and unreadable papers", async function () {
    const entries = [
      makeItem(1, "Body evidence paper", "shared synthesis body evidence", {
        hasPdf: true,
      }),
      makeItem(2, "Abstract-only paper", "shared synthesis abstract evidence", {
        hasPdf: true,
      }),
      makeItem(3, "No snippet paper", "shared synthesis unavailable evidence", {
        hasPdf: true,
      }),
      makeItem(4, "No PDF paper", "shared synthesis metadata evidence", {
        hasPdf: false,
      }),
    ];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async (paperContext: PaperContextRef) =>
          makePdfContext([
            `Abstract\nPaper ${paperContext.itemId} introduces the shared synthesis question.`,
            `Results\nPaper ${paperContext.itemId} gives body evidence for the shared synthesis question.`,
          ]),
      } as any,
      async (paperContext): Promise<PaperContextCandidate[]> => {
        if (paperContext.itemId === 1) {
          return [
            {
              paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
              itemId: paperContext.itemId,
              contextItemId: paperContext.contextItemId,
              title: paperContext.title,
              chunkIndex: 1,
              chunkText:
                "Results\nThe body evidence explains the shared synthesis mechanism across papers.",
              chunkKind: "results",
              sectionLabel: "Results",
              estimatedTokens: 12,
              bm25Score: 0.6,
              embeddingScore: 0.6,
              hybridScore: 0.6,
              evidenceScore: 0.6,
            },
          ];
        }
        if (paperContext.itemId === 2) {
          return [
            {
              paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
              itemId: paperContext.itemId,
              contextItemId: paperContext.contextItemId,
              title: paperContext.title,
              chunkIndex: 0,
              chunkText:
                "Abstract\nThe abstract previews the shared synthesis mechanism without body evidence.",
              chunkKind: "abstract",
              sectionLabel: "Abstract",
              estimatedTokens: 11,
              bm25Score: 0.5,
              embeddingScore: 0.5,
              hybridScore: 0.5,
              evidenceScore: 0.5,
            },
          ];
        }
        return [];
      },
    );

    const result = await service.retrieve({
      scope: { itemIds: entries.map((entry) => entry.target.itemId) },
      query: "what is the commonality of these shared synthesis papers",
      intent: "summarize",
      depth: "evidence",
      methods: ["metadata", "abstract", "semantic"],
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "What is the commonality of these papers?",
        libraryID: 1,
      },
    });

    assert.equal(result.answerContract.papersPlanned, 4);
    assert.equal(result.answerContract.papersBodyRead, 1);
    assert.equal(result.answerContract.papersMetadataOnly, 3);
    assert.equal(
      result.answerContract.papersMetadataOnly,
      result.coverageReceipt.papersMetadataOnly,
    );
    assert.include(result.coverageReceipt.text, "Metadata/abstract only: 3");
    assert.include(
      result.answerContract.unreadableReasons.join("\n"),
      "2: only abstract/front-matter snippets returned",
    );
    assert.include(
      result.answerContract.unreadableReasons.join("\n"),
      "3: no snippet returned",
    );
    assert.include(
      result.answerContract.unreadableReasons.join("\n"),
      "4: no full-text attachment available",
    );
  });

  it("prefers body evidence for 26-paper synthesis when abstracts rank higher", async function () {
    const entries = Array.from({ length: 26 }, (_, index) =>
      makeItem(
        index + 1,
        `Medium synthesis paper ${index + 1}`,
        "The abstract repeats shared synthesis language for ranking.",
        { hasPdf: true },
      ),
    );
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async (paperContext: PaperContextRef) =>
          makePdfContext([
            `Abstract\nPaper ${paperContext.itemId} repeats shared synthesis language and should not be the only evidence.`,
            `Results\nPaper ${paperContext.itemId} provides body evidence explaining the mechanism behind the shared synthesis pattern.`,
          ]),
      } as any,
      async (paperContext): Promise<PaperContextCandidate[]> => [
        {
          paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
          itemId: paperContext.itemId,
          contextItemId: paperContext.contextItemId,
          title: paperContext.title,
          chunkIndex: 0,
          chunkText: `Abstract\nPaper ${paperContext.itemId} repeats shared synthesis language and should not be the only evidence.`,
          chunkKind: "abstract",
          sectionLabel: "Abstract",
          estimatedTokens: 16,
          bm25Score: 1,
          embeddingScore: 0,
          hybridScore: 1,
          evidenceScore: 1,
        },
        {
          paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
          itemId: paperContext.itemId,
          contextItemId: paperContext.contextItemId,
          title: paperContext.title,
          chunkIndex: 1,
          chunkText: `Results\nPaper ${paperContext.itemId} provides body evidence explaining the mechanism behind the shared synthesis pattern.`,
          chunkKind: "results",
          sectionLabel: "Results",
          estimatedTokens: 16,
          bm25Score: 0.1,
          embeddingScore: 0,
          hybridScore: 0.1,
          evidenceScore: 0.1,
        },
      ],
    );

    const result = await service.retrieve({
      scope: { itemIds: entries.map((entry) => entry.target.itemId) },
      query: "summarize the shared synthesis pattern across these papers",
      intent: "summarize",
      depth: "evidence",
      methods: ["metadata", "abstract", "semantic"],
      perPaperTopK: 1,
      maxTotalSnippets: 26,
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Summarize the shared synthesis pattern across these papers",
        libraryID: 1,
      },
    });

    assert.equal(
      (result.answerContract as any).resolvedStrategy,
      "evidence_overview",
    );
    assert.isAbove(result.answerContract.papersBodyRead, 0);
    assert.include(
      result.snippets.map((snippet) => snippet.sectionLabel),
      "Results",
    );
    assert.notEqual(result.coverageReceipt.papersBodyRead, 0);
  });

  it("prefers body snippets for collection-scoped synthesis", async function () {
    const entries = Array.from({ length: 12 }, (_, index) =>
      makeItem(
        index + 1,
        `Collection synthesis paper ${index + 1}`,
        "The abstract mentions collection synthesis and common evidence.",
        { hasPdf: true, collectionIds: [44] },
      ),
    );
    const service = new LibraryRetrieveService(
      makeGateway(entries, { collectionItems: entries }) as any,
      {
        ensurePaperContext: async (paperContext: PaperContextRef) =>
          makePdfContext([
            `Abstract\nPaper ${paperContext.itemId} mentions collection synthesis and common evidence.`,
            `Methods\nPaper ${paperContext.itemId} describes the body-level protocol that supports the synthesis.`,
          ]),
      } as any,
      async (paperContext): Promise<PaperContextCandidate[]> => [
        {
          paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
          itemId: paperContext.itemId,
          contextItemId: paperContext.contextItemId,
          title: paperContext.title,
          chunkIndex: 0,
          chunkText: `Abstract\nPaper ${paperContext.itemId} mentions collection synthesis and common evidence.`,
          chunkKind: "abstract",
          sectionLabel: "Abstract",
          estimatedTokens: 14,
          bm25Score: 1,
          embeddingScore: 0,
          hybridScore: 1,
          evidenceScore: 1,
        },
        {
          paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
          itemId: paperContext.itemId,
          contextItemId: paperContext.contextItemId,
          title: paperContext.title,
          chunkIndex: 1,
          chunkText: `Methods\nPaper ${paperContext.itemId} describes the body-level protocol that supports the synthesis.`,
          chunkKind: "methods",
          sectionLabel: "Methods",
          estimatedTokens: 14,
          bm25Score: 0.2,
          embeddingScore: 0,
          hybridScore: 0.2,
          evidenceScore: 0.2,
        },
      ],
    );

    const result = await service.retrieve({
      query: "summarize collection synthesis common evidence",
      intent: "summarize",
      depth: "evidence",
      methods: ["metadata", "abstract", "semantic"],
      perPaperTopK: 1,
      maxTotalSnippets: 12,
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Summarize this collection",
        libraryID: 1,
        selectedCollectionContexts: [
          { collectionId: 44, name: "Collection 44", libraryID: 1 },
        ],
      },
    });

    assert.equal(result.resourcePool.type, "collection");
    assert.isAbove(result.answerContract.papersBodyRead, 0);
    assert.include(
      result.snippets.map((snippet) => snippet.sectionLabel),
      "Methods",
    );
  });

  it("repairs deep synthesis snippets so body evidence is retained over front matter when the per-paper budget is tight", async function () {
    const entries = [
      makeItem(
        81,
        "Front matter dominated paper",
        "The abstract repeats commonality commonality commonality.",
        { hasPdf: true },
      ),
    ];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async () =>
          makePdfContext([
            "Abstract\ncommonality commonality commonality",
            "Highlights\ncommonality commonality overview",
            "Results\nThe body evidence shows the mechanism that matters for synthesis.",
          ]),
      } as any,
      async (paperContext): Promise<PaperContextCandidate[]> => [
        {
          paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
          itemId: paperContext.itemId,
          contextItemId: paperContext.contextItemId,
          title: paperContext.title,
          chunkIndex: 0,
          chunkText: "Abstract\ncommonality commonality commonality",
          chunkKind: "abstract",
          sectionLabel: "Abstract",
          estimatedTokens: 12,
          bm25Score: 0.9,
          embeddingScore: 0,
          hybridScore: 0.9,
          evidenceScore: 0.9,
        },
        {
          paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
          itemId: paperContext.itemId,
          contextItemId: paperContext.contextItemId,
          title: paperContext.title,
          chunkIndex: 1,
          chunkText: "Highlights\ncommonality commonality overview",
          chunkKind: "unknown",
          sectionLabel: "Highlights",
          estimatedTokens: 12,
          bm25Score: 0.8,
          embeddingScore: 0,
          hybridScore: 0.8,
          evidenceScore: 0.8,
        },
        {
          paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
          itemId: paperContext.itemId,
          contextItemId: paperContext.contextItemId,
          title: paperContext.title,
          chunkIndex: 2,
          chunkText:
            "Results\nThe body evidence shows the mechanism that matters for synthesis.",
          chunkKind: "results",
          sectionLabel: "Results",
          estimatedTokens: 12,
          bm25Score: 0.2,
          embeddingScore: 0,
          hybridScore: 0.2,
          evidenceScore: 0.2,
        },
      ],
    );

    const result = await service.retrieve({
      scope: { itemIds: [81] },
      query: "summarize the commonality",
      intent: "summarize",
      depth: "evidence",
      methods: ["metadata", "abstract", "semantic"],
      perPaperTopK: 2,
      maxTotalSnippets: 2,
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Summarize the commonality",
        libraryID: 1,
      },
    });

    assert.include(
      result.snippets.map((snippet) => snippet.sectionLabel),
      "Results",
    );
    assert.equal(result.answerContract.papersBodyRead, 1);
    assert.notInclude(result.answerContract.coverageFrontier.join("\n"), "81:");
  });

  it("prefers method evidence for selected-paper method comparison questions", async function () {
    const entries = [
      makeItem(82, "Method comparison paper", "", { hasPdf: true }),
    ];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async () =>
          makePdfContext([
            "Abstract\nThe paper studies a benchmark.",
            "Results\nThe result section reports the highest scoring outcome.",
            "Discussion\nThe discussion interprets the benchmark outcome.",
            "Methods\nThe method section explains the controlled ablation protocol.",
          ]),
      } as any,
      async (paperContext): Promise<PaperContextCandidate[]> => [
        {
          paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
          itemId: paperContext.itemId,
          contextItemId: paperContext.contextItemId,
          title: paperContext.title,
          chunkIndex: 1,
          chunkText:
            "Results\nThe result section reports the highest scoring outcome.",
          chunkKind: "results",
          sectionLabel: "Results",
          estimatedTokens: 12,
          bm25Score: 0.9,
          embeddingScore: 0,
          hybridScore: 0.9,
          evidenceScore: 0.9,
        },
        {
          paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
          itemId: paperContext.itemId,
          contextItemId: paperContext.contextItemId,
          title: paperContext.title,
          chunkIndex: 2,
          chunkText:
            "Discussion\nThe discussion interprets the benchmark outcome.",
          chunkKind: "discussion",
          sectionLabel: "Discussion",
          estimatedTokens: 12,
          bm25Score: 0.8,
          embeddingScore: 0,
          hybridScore: 0.8,
          evidenceScore: 0.8,
        },
        {
          paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
          itemId: paperContext.itemId,
          contextItemId: paperContext.contextItemId,
          title: paperContext.title,
          chunkIndex: 3,
          chunkText:
            "Methods\nThe method section explains the controlled ablation protocol.",
          chunkKind: "methods",
          sectionLabel: "Methods",
          estimatedTokens: 12,
          bm25Score: 0.2,
          embeddingScore: 0,
          hybridScore: 0.2,
          evidenceScore: 0.2,
        },
      ],
    );

    const result = await service.retrieve({
      scope: { itemIds: [82] },
      query: "Compare the methods used by this paper",
      intent: "summarize",
      depth: "evidence",
      methods: ["metadata", "abstract", "semantic"],
      perPaperTopK: 2,
      maxTotalSnippets: 2,
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Compare the methods used by this paper",
        libraryID: 1,
      },
    });

    assert.include(
      result.snippets.map((snippet) => snippet.sectionLabel),
      "Methods",
    );
  });

  it("does not return the same chunk as both exact and BM25 evidence", async function () {
    const entries = [
      makeItem(1, "Duplicate evidence phrase paper", "", {
        hasPdf: true,
      }),
    ];
    let candidateBuilderCalled = false;
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async () =>
          makePdfContext([
            "Methods\nThe duplicate evidence phrase appears in this chunk.",
          ]),
      } as any,
      async (paperContext): Promise<PaperContextCandidate[]> => {
        candidateBuilderCalled = true;
        return [
          {
            paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
            itemId: paperContext.itemId,
            contextItemId: paperContext.contextItemId,
            title: paperContext.title,
            chunkIndex: 0,
            chunkText:
              "Methods\nThe duplicate evidence phrase appears in this chunk.",
            chunkKind: "methods",
            estimatedTokens: 10,
            bm25Score: 1,
            embeddingScore: 0,
            hybridScore: 1,
            evidenceScore: 1,
          },
        ];
      },
    );

    const result = await service.retrieve({
      query: "duplicate evidence phrase",
      depth: "evidence",
      perPaperTopK: 3,
      maxTotalSnippets: 3,
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Find duplicate evidence phrase",
        libraryID: 1,
      },
    });

    assert.isTrue(candidateBuilderCalled);
    assert.lengthOf(result.snippets, 1);
    assert.equal(result.snippets[0].matchMethod, "exact");
    assert.equal(result.snippets[0].chunkIndex, 0);
  });

  it("verify mode returns exact snippets without falling back to semantic candidates", async function () {
    const entries = [
      makeItem(1, "Calcium imaging paper", "A method paper.", {
        hasPdf: true,
      }),
    ];
    let candidateBuilderCalled = false;
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async () =>
          makePdfContext([
            "Methods\nThe calcium imaging analysis pipeline used deconvolution.",
          ]),
      } as any,
      async () => {
        candidateBuilderCalled = true;
        return [];
      },
    );

    const result = await service.retrieve({
      query: "calcium imaging analysis",
      depth: "verify",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Verify calcium imaging analysis",
        libraryID: 1,
      },
    });

    assert.isFalse(candidateBuilderCalled);
    assert.equal(result.intent, "verify");
    assert.lengthOf(result.snippets, 1);
    assert.equal(result.snippets[0].matchMethod, "exact");
    assert.isString(result.snippets[0].quoteCitationId);
    assert.equal(result.snippets[0].sourceLabel, "(Smith, 2024)");
    assert.lengthOf(result.quoteCitations || [], 1);
    assert.equal(
      result.snippets[0].quoteCitationId,
      result.quoteCitations?.[0]?.id,
    );
    assert.include(
      result.quoteCitations?.[0]?.quoteText || "",
      "calcium imaging analysis pipeline",
    );
    assert.equal(result.quoteCitations?.[0]?.citationLabel, "(Smith, 2024)");
    assert.equal(result.quoteCitations?.[0]?.sourceMatchKind, "exact");
    assert.equal(result.quoteCitations?.[0]?.sourceMatchSource, "context-text");
    assert.include(result.methodsUsed, "exact");
  });

  it("searches explicit item scopes even when metadata and quicksearch do not match", async function () {
    const entries = [
      makeItem(7, "Unrelated title", "", {
        hasPdf: true,
      }),
    ];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async () =>
          makePdfContext([
            "Results\nThe body contains the rare signature phrase only here.",
          ]),
      } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "rare signature phrase",
      depth: "verify",
      scope: { libraryID: 1, itemIds: [7] },
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Verify rare signature phrase in this item",
        libraryID: 1,
      },
    });

    assert.deepEqual(
      result.candidates.map((candidate) => candidate.itemId),
      ["7"],
    );
    assert.equal(result.resourcePool.queryCoverage.fullTextSearched, 1);
    assert.lengthOf(result.snippets, 1);
    assert.equal(result.snippets[0].itemId, "7");
    assert.equal(result.snippets[0].matchMethod, "exact");
  });

  it("enumerate scans indexed text across the scoped pool while bounding snippet expansion", async function () {
    const entries = Array.from({ length: 95 }, (_, index) =>
      makeItem(index + 1, `Representational drift paper ${index + 1}`, "", {
        hasPdf: true,
        collectionIds: [3],
      }),
    );
    const quicksearchCalls: Array<{ limit?: number; query?: string }> = [];
    const calls: number[] = [];
    const service = new LibraryRetrieveService(
      makeGateway(entries, {
        collectionItems: entries,
        quicksearchItemIds: Array.from({ length: 40 }, (_, index) => index + 1),
        quicksearchCalls,
      }) as any,
      {
        ensurePaperContext: async (paper: PaperContextRef) => {
          calls.push(paper.itemId);
          return makePdfContext([
            `Methods\nPaper ${paper.itemId} contains the requested indexed evidence.`,
          ]);
        },
      } as any,
      async (paperContext): Promise<PaperContextCandidate[]> => [
        {
          paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
          itemId: paperContext.itemId,
          contextItemId: paperContext.contextItemId,
          title: paperContext.title,
          chunkIndex: 0,
          chunkText: `Chunk text for ${paperContext.title}`,
          chunkKind: "methods",
          estimatedTokens: 10,
          bm25Score: 1,
          embeddingScore: 0,
          hybridScore: 1,
          evidenceScore: 1,
        },
      ],
    );

    const result = await service.retrieve({
      query: "requested indexed evidence",
      intent: "enumerate",
      depth: "evidence",
      methods: ["metadata", "abstract", "fts"],
      maxSnippetPapers: 5,
      maxTotalSnippets: 5,
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Which papers contain requested indexed evidence?",
        libraryID: 1,
        selectedCollectionContexts: [
          { collectionId: 3, name: "Collection 3", libraryID: 1 },
        ],
      },
    });

    assert.equal(quicksearchCalls[0]?.limit, 95);
    assert.equal(result.resourcePool.queryCoverage.metadataInspected, 95);
    assert.equal(result.resourcePool.queryCoverage.indexedTextAvailable, 95);
    assert.equal(result.resourcePool.queryCoverage.indexedTextScanned, 95);
    assert.equal(result.resourcePool.queryCoverage.indexedTextMatched, 40);
    assert.equal(result.resourcePool.queryCoverage.snippetPapersExpanded, 5);
    assert.lengthOf(calls, 5);
    assert.lengthOf(result.snippets, 5);
    assert.lengthOf(result.paperMatches, 40);
    assert.equal(result.answerContract.metadataCoverage, "complete");
    assert.equal(result.answerContract.indexedTextCoverage, "complete");
    assert.equal(result.answerContract.snippetCoverage, "sampled");
    assert.equal(result.frontier.stopReason, "budget_limit");
  });

  it("uses query variants for metadata, indexed-text scan, and exact snippets", async function () {
    const variant = "calcium imaging representational drift";
    const entries = [
      makeItem(
        1,
        "English metadata paper",
        "This abstract studies calcium imaging representational drift.",
        { hasPdf: true, collectionIds: [3] },
      ),
      makeItem(2, "Indexed-only paper", "", {
        hasPdf: true,
        collectionIds: [3],
      }),
    ];
    const quicksearchCalls: Array<{ limit?: number; query?: string }> = [];
    const service = new LibraryRetrieveService(
      makeGateway(entries, {
        collectionItems: entries,
        quicksearchCalls,
        quicksearchItemIds: (query) => (query === variant ? [2] : []),
      }) as any,
      {
        ensurePaperContext: async (paper: PaperContextRef) =>
          makePdfContext([
            paper.itemId === 2
              ? "Methods used calcium imaging representational drift assays."
              : "Methods describe a related experiment.",
          ]),
      } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "哪些论文用钙成像研究表征漂移？",
      queryVariants: [variant],
      intent: "enumerate",
      depth: "evidence",
      maxSnippetPapers: 2,
      maxTotalSnippets: 4,
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "哪些论文用钙成像研究表征漂移？",
        libraryID: 1,
        selectedCollectionContexts: [
          { collectionId: 3, name: "Collection 3", libraryID: 1 },
        ],
      },
    });

    assert.deepEqual(result.queryPlan.variants, [variant]);
    const recordedQueries = quicksearchCalls.map((call) => call.query || "");
    assert.include(recordedQueries, variant);
    // The raw CJK sentence is no longer sent verbatim; segmented keyword
    // probes derived from it are.
    assert.notInclude(recordedQueries, result.queryPlan.originalQuery);
    assert.isTrue(recordedQueries.some((query) => /[一-鿿]/.test(query)));
    assert.equal(result.resourcePool.queryCoverage.indexedTextMatched, 1);
    assert.include(result.candidates[0].matchedQueryVariants || [], variant);
    const indexedMatch = result.paperMatches.find(
      (match) => match.itemId === "2",
    );
    assert.include(indexedMatch?.basis || [], "indexed_text");
    assert.include(indexedMatch?.matchedQueryVariants || [], variant);
    assert.include(
      result.snippets.map((snippet) => snippet.matchedQueryVariant),
      variant,
    );
  });

  it("marks large enumerate scopes partial when metadata is capped", async function () {
    const entries = Array.from({ length: 6000 }, (_, index) =>
      makeItem(index + 1, `Large folder paper ${index + 1}`, "", {
        hasPdf: true,
        collectionIds: [9],
      }),
    );
    const service = new LibraryRetrieveService(
      makeGateway(entries, { collectionItems: entries }) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "rare method",
      intent: "enumerate",
      depth: "metadata",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Find all papers using rare method",
        libraryID: 1,
        selectedCollectionContexts: [
          { collectionId: 9, name: "Large", libraryID: 1 },
        ],
      },
    });

    assert.equal(result.resourcePool.totalItems, 6000);
    assert.equal(result.resourcePool.queryCoverage.metadataInspected, 5000);
    assert.equal(result.answerContract.metadataCoverage, "partial");
    assert.include(
      result.answerContract.unsafeClaims.join("\n"),
      "complete coverage",
    );
    assert.equal(result.frontier.stopReason, "budget_limit");
  });

  it("normalizes legacy discover intent to enumerate", async function () {
    const entries = [
      makeItem(1, "Semantic concept paper", "semantic concept", {
        hasPdf: true,
      }),
    ];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async () =>
          makePdfContext([
            "A conceptually related passage without lexical terms.",
          ]),
      } as any,
      async (paperContext): Promise<PaperContextCandidate[]> => [
        {
          paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
          itemId: paperContext.itemId,
          contextItemId: paperContext.contextItemId,
          title: paperContext.title,
          chunkIndex: 0,
          chunkText: "A conceptually related passage without lexical terms.",
          chunkKind: "discussion",
          estimatedTokens: 10,
          bm25Score: 0,
          embeddingScore: 0.9,
          hybridScore: 0.9,
          evidenceScore: 0.9,
        },
      ],
    );

    const result = await service.retrieve({
      query: "semantic concept",
      intent: "discover",
      depth: "evidence",
      methods: ["semantic"],
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Find semantic concept",
        libraryID: 1,
      },
    });

    assert.equal(result.intent, "enumerate");
    assert.lengthOf(result.paperMatches, 1);
    assert.include(result.paperMatches[0]?.basis || [], "abstract");
  });

  it("defaults to selected collection scope instead of active-reader fallback", async function () {
    const active = makeItem(99, "Active reader paper", "active", {
      hasPdf: true,
    });
    const scoped = makeItem(7, "Scoped collection paper", "collection", {
      hasPdf: true,
      collectionIds: [4],
    });
    const service = new LibraryRetrieveService(
      makeGateway([active, scoped], { collectionItems: [scoped] }) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "collection",
      depth: "metadata",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Search this collection",
        libraryID: 1,
        conversationKind: "global",
        activeItemId: 99,
        selectedCollectionContexts: [
          { collectionId: 4, name: "Collection 4", libraryID: 1 },
        ],
      },
    });

    assert.deepEqual(result.resourcePool.scope.collectionIds, [4]);
    assert.equal(result.resourcePool.totalItems, 1);
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.itemId),
      ["7"],
    );
  });

  it("defaults to selected tag scope instead of active-reader fallback", async function () {
    const active = makeItem(99, "Active reader paper", "active", {
      hasPdf: true,
    });
    const scoped = makeItem(7, "Scoped tag paper", "tagged indexed evidence", {
      hasPdf: true,
      tags: ["Stable"],
    });
    const outside = makeItem(8, "Outside tag paper", "outside", {
      hasPdf: true,
      tags: ["Other"],
    });
    const quicksearchCalls: Array<{
      limit?: number;
      query?: string;
      filters?: Record<string, unknown>;
      allowedItemIds?: number[];
    }> = [];
    const service = new LibraryRetrieveService(
      makeGateway([active, scoped, outside], {
        quicksearchCalls,
        quicksearchItemIds: [7, 8],
      }) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "indexed evidence",
      intent: "enumerate",
      depth: "evidence",
      methods: ["metadata", "fts"],
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Search this tag",
        libraryID: 1,
        conversationKind: "global",
        activeItemId: 99,
        selectedTagContexts: [
          {
            name: "Stable",
            normalizedName: "stable",
            libraryID: 1,
          },
        ],
      },
    });

    assert.equal(result.resourcePool.type, "tag");
    assert.deepEqual(result.resourcePool.scope.tagNames, ["Stable"]);
    assert.equal(result.resourcePool.totalItems, 1);
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.itemId),
      ["7"],
    );
    assert.deepEqual(quicksearchCalls[0]?.allowedItemIds, [7]);
    assert.isUndefined(quicksearchCalls[0]?.filters);
    assert.equal(result.resourcePool.queryCoverage.indexedTextMatched, 1);
  });

  it("treats explicit library scope as whole-library even when a tag is selected", async function () {
    const tagged = makeItem(7, "Tagged paper", "shared evidence", {
      hasPdf: true,
      tags: ["Stable"],
    });
    const outside = makeItem(8, "Whole library paper", "shared evidence", {
      hasPdf: true,
      tags: ["Other"],
    });
    const service = new LibraryRetrieveService(
      makeGateway([tagged, outside]) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      scope: { libraryID: 1 },
      query: "shared evidence",
      intent: "enumerate",
      depth: "metadata",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Search the whole library",
        libraryID: 1,
        selectedTagContexts: [
          {
            name: "Stable",
            normalizedName: "stable",
            libraryID: 1,
          },
        ],
      },
    });

    assert.equal(result.resourcePool.type, "library");
    assert.equal(result.resourcePool.totalItems, 2);
    assert.deepEqual(result.resourcePool.scope.tagNames, []);
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.itemId).sort(),
      ["7", "8"],
    );
  });

  it("uses resolved tag item IDs for explicit tag quicksearch", async function () {
    const scoped = makeItem(7, "Stable tag paper", "", {
      hasPdf: true,
      tags: ["Stable"],
    });
    const outside = makeItem(8, "Outside tag paper", "", {
      hasPdf: true,
      tags: ["Other"],
    });
    const quicksearchCalls: Array<{
      limit?: number;
      query?: string;
      filters?: Record<string, unknown>;
      allowedItemIds?: number[];
    }> = [];
    const service = new LibraryRetrieveService(
      makeGateway([scoped, outside], {
        quicksearchCalls,
        quicksearchItemIds: [7, 8],
      }) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      scope: { libraryID: 1, tagNames: ["stable"] },
      query: "indexed evidence",
      intent: "enumerate",
      depth: "evidence",
      methods: ["metadata", "fts"],
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Search stable tag",
        libraryID: 1,
      },
    });

    assert.equal(result.resourcePool.type, "tag");
    assert.deepEqual(result.resourcePool.scope.tagNames, ["stable"]);
    assert.equal(result.resourcePool.totalItems, 1);
    assert.deepEqual(quicksearchCalls[0]?.allowedItemIds, [7]);
    assert.isUndefined(quicksearchCalls[0]?.filters);
    assert.equal(result.resourcePool.queryCoverage.indexedTextMatched, 1);
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.itemId),
      ["7"],
    );
  });

  it("unions selected collection and tag scopes while deduping overlapping papers", async function () {
    const collectionOnly = makeItem(
      4,
      "Collection-only paper",
      "collection evidence",
      {
        hasPdf: true,
        collectionIds: [4],
      },
    );
    const overlap = makeItem(7, "Overlapping paper", "shared evidence", {
      hasPdf: true,
      collectionIds: [4],
      tags: ["Stable"],
    });
    const tagOnly = makeItem(8, "Tag-only paper", "tag evidence", {
      hasPdf: true,
      tags: ["Stable"],
    });
    const outside = makeItem(9, "Outside paper", "outside", {
      hasPdf: true,
      tags: ["Other"],
    });
    const service = new LibraryRetrieveService(
      makeGateway([collectionOnly, overlap, tagOnly, outside], {
        collectionItems: [collectionOnly, overlap],
      }) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "evidence",
      intent: "enumerate",
      depth: "metadata",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Search the selected collection and tag",
        libraryID: 1,
        selectedCollectionContexts: [
          { collectionId: 4, name: "Collection 4", libraryID: 1 },
        ],
        selectedTagContexts: [
          {
            name: "Stable",
            normalizedName: "stable",
            libraryID: 1,
          },
        ],
      },
    });

    assert.equal(result.resourcePool.type, "mixed");
    assert.deepEqual(result.resourcePool.scope.collectionIds, [4]);
    assert.deepEqual(result.resourcePool.scope.tagNames, ["Stable"]);
    assert.equal(result.resourcePool.totalItems, 3);
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.itemId).sort(),
      ["4", "7", "8"],
    );
    assert.include(
      result.warnings,
      "Selected collection and tag totals may include overlapping items; retrieval uses unique item IDs.",
    );
  });

  it("quicksearches a mixed collection/tag scope once per probe", async function () {
    const collectionOnly = makeItem(4, "Collection-only paper", "", {
      hasPdf: true,
      collectionIds: [4],
    });
    const overlap = makeItem(7, "Overlapping paper", "", {
      hasPdf: true,
      collectionIds: [4],
      tags: ["Stable"],
    });
    const tagOnly = makeItem(8, "Tag-only paper", "", {
      hasPdf: true,
      tags: ["Stable"],
    });
    const outside = makeItem(9, "Outside paper", "", {
      hasPdf: true,
      tags: ["Other"],
    });
    const quicksearchCalls: Array<{
      limit?: number;
      query?: string;
      filters?: Record<string, unknown>;
      allowedItemIds?: number[];
    }> = [];
    const service = new LibraryRetrieveService(
      makeGateway([collectionOnly, overlap, tagOnly, outside], {
        collectionItems: [collectionOnly, overlap],
        quicksearchCalls,
        quicksearchItemIds: [8],
      }) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "rare indexed phrase",
      intent: "enumerate",
      depth: "evidence",
      methods: ["metadata", "fts"],
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Search the selected collection and tag",
        libraryID: 1,
        selectedCollectionContexts: [
          { collectionId: 4, name: "Collection 4", libraryID: 1 },
        ],
        selectedTagContexts: [
          {
            name: "Stable",
            normalizedName: "stable",
            libraryID: 1,
          },
        ],
      },
    });

    assert.lengthOf(quicksearchCalls, 1);
    assert.deepEqual(quicksearchCalls[0]?.allowedItemIds, [4, 7, 8]);
    assert.isUndefined(quicksearchCalls[0]?.filters);
    assert.equal(result.resourcePool.type, "mixed");
    assert.equal(result.resourcePool.queryCoverage.indexedTextMatched, 1);
    // With a single direct match the shortlist fallback widens candidates to
    // the top-scored pool slice; the matched record must stay ranked first.
    assert.equal(result.candidates[0]?.itemId, "8");
    assert.isTrue(
      result.warnings.some((warning) => warning.includes("LOW CONFIDENCE")),
    );
    const tagOnlyMatch = result.paperMatches.find(
      (match) => match.itemId === "8",
    );
    assert.include(tagOnlyMatch?.basis || [], "indexed_text");
  });

  it("applies allowed item IDs before limiting quicksearch for untagged scopes", async function () {
    const taggedFirst = makeItem(1, "Tagged first paper", "", {
      hasPdf: true,
      tags: ["Stable"],
    });
    const taggedSecond = makeItem(2, "Tagged second paper", "", {
      hasPdf: true,
      tags: ["Other"],
    });
    const untagged = makeItem(8, "Untagged paper", "", {
      hasPdf: true,
      tags: [],
    });
    const quicksearchCalls: Array<{
      limit?: number;
      query?: string;
      filters?: Record<string, unknown>;
      allowedItemIds?: number[];
    }> = [];
    const service = new LibraryRetrieveService(
      makeGateway([taggedFirst, taggedSecond, untagged], {
        quicksearchCalls,
        quicksearchItemIds: [1, 2, 8],
      }) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "rare untagged indexed phrase",
      intent: "enumerate",
      depth: "evidence",
      methods: ["metadata", "fts"],
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Search untagged papers",
        libraryID: 1,
        conversationKind: "global",
        selectedTagContexts: [
          {
            name: "Untagged",
            libraryID: 1,
            scope: "untagged",
          },
        ],
      },
    });

    assert.deepEqual(quicksearchCalls[0]?.allowedItemIds, [8]);
    assert.isUndefined(quicksearchCalls[0]?.filters);
    assert.equal(result.resourcePool.type, "tag");
    assert.deepEqual(result.resourcePool.scope.tagScopes, ["untagged"]);
    assert.equal(result.resourcePool.queryCoverage.indexedTextMatched, 1);
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.itemId),
      ["8"],
    );
  });

  it("quicksearches explicit items alongside a tag scope in one mixed union", async function () {
    const explicitTagged = makeItem(1, "Explicit tagged paper", "", {
      hasPdf: true,
      tags: ["Stable"],
    });
    const untagged = makeItem(8, "Untagged paper", "", {
      hasPdf: true,
      tags: [],
    });
    const quicksearchCalls: Array<{
      query?: string;
      allowedItemIds?: number[];
    }> = [];
    const service = new LibraryRetrieveService(
      makeGateway([explicitTagged, untagged], {
        quicksearchCalls,
        quicksearchItemIds: [1],
      }) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      scope: {
        libraryID: 1,
        itemIds: [1],
        tagScopes: ["untagged"],
      },
      query: "rare explicit indexed phrase",
      intent: "enumerate",
      depth: "evidence",
      methods: ["metadata", "fts"],
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Search this item and untagged papers",
        libraryID: 1,
      },
    });

    assert.lengthOf(quicksearchCalls, 1);
    assert.deepEqual(quicksearchCalls[0]?.allowedItemIds, [1, 8]);
    assert.equal(result.resourcePool.type, "mixed");
    assert.equal(result.resourcePool.queryCoverage.indexedTextMatched, 1);
    assert.equal(result.candidates[0]?.itemId, "1");
    assert.include(
      result.paperMatches.find((match) => match.itemId === "1")?.basis || [],
      "indexed_text",
    );
  });

  it("normalizes tool budgets to hard caps", function () {
    const input = normalizeLibraryRetrieveArgs({
      query: "calcium",
      maxMetadataItems: 99999,
      maxCandidatePapers: 99999,
      maxFullTextPapers: 99999,
      perPaperTopK: 99,
      maxTotalSnippets: 99999,
    });

    assert.deepInclude(input, {
      maxMetadataItems: 5000,
      maxCandidatePapers: 200,
      maxFullTextPapers: 100,
      perPaperTopK: 5,
      maxTotalSnippets: 200,
    });
  });

  it("normalizes legacy discover tool intent to enumerate", function () {
    const input = normalizeLibraryRetrieveArgs({
      query: "calcium",
      intent: "discover",
    });

    assert.equal(input?.intent, "enumerate");
  });
});

describe("LibraryRetrieveService quicksearch probes", function () {
  it("sends segmented keyword probes for a CJK question, never the raw sentence", async function () {
    const entries = [
      makeItem(1, "神经形态计算综述", "关于神经形态计算的研究。"),
    ];
    const quicksearchCalls: Array<{ query?: string }> = [];
    const service = new LibraryRetrieveService(
      makeGateway(entries, {
        quicksearchCalls,
        quicksearchItemIds: [1],
      }) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    await service.retrieve({
      query: "这个文件夹里哪些论文讨论了神经形态计算？",
      depth: "evidence",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "x",
        libraryID: 1,
      },
    });

    const queries = quicksearchCalls.map((call) => call.query || "");
    assert.isAbove(queries.length, 0);
    for (const query of queries) {
      assert.notMatch(query, /[？?]$/);
      assert.notEqual(query, "这个文件夹里哪些论文讨论了神经形态计算？");
      assert.notEqual(query, "这个文件夹里哪些论文讨论了神经形态计算");
    }
  });

  it("sends English queries whole with terminal punctuation stripped", async function () {
    const entries = [makeItem(1, "Calcium imaging analysis")];
    const quicksearchCalls: Array<{ query?: string }> = [];
    const service = new LibraryRetrieveService(
      makeGateway(entries, {
        quicksearchCalls,
        quicksearchItemIds: [1],
      }) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    await service.retrieve({
      query: "Which papers use calcium imaging?",
      depth: "evidence",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "x",
        libraryID: 1,
      },
    });

    const queries = quicksearchCalls.map((call) => call.query || "");
    assert.include(queries, "Which papers use calcium imaging");
    assert.notInclude(queries, "Which papers use calcium imaging?");
  });

  it("caps the derived probe list at QUICKSEARCH_MAX_PROBES", function () {
    const plan = buildRetrievalQueryPlan({
      query: "神经形态计算的最新研究进展有哪些？",
      queryVariants: [
        "neuromorphic computing",
        "spiking neural networks",
        "类脑计算芯片的研究",
        "brain-inspired chips",
        "event-driven processing",
      ],
    });

    const probes = buildQuicksearchProbes(plan);

    assert.isAtMost(probes.length, QUICKSEARCH_MAX_PROBES);
    assert.isAbove(probes.length, 0);
  });
});

describe("LibraryRetrieveService planner integration", function () {
  it("surfaces query-planner notes into result warnings", async function () {
    const entries = [makeItem(1, "Calcium imaging")];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "calcium imaging",
      queryVariants: ["two-photon imaging"],
      depth: "metadata",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "x",
        libraryID: 1,
      },
    });

    assert.isTrue(
      result.warnings.some((warning) => warning.startsWith("Query planner: ")),
      `warnings were: ${JSON.stringify(result.warnings)}`,
    );
  });

  it("still fails fast when no library is available after the scope-first reorder", async function () {
    const gateway = makeGateway([makeItem(1, "A")]) as any;
    gateway.resolveLibraryID = () => 0;
    const service = new LibraryRetrieveService(
      gateway,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    try {
      await service.retrieve({
        query: "anything",
        request: {
          conversationKey: 1,
          mode: "agent",
          userText: "x",
          libraryID: 1,
        },
      });
      assert.fail("expected retrieve to throw");
    } catch (error) {
      assert.match(
        error instanceof Error ? error.message : String(error),
        /No active library/,
      );
    }
  });
});

describe("LibraryRetrieveService pool BM25", function () {
  it("matches records via normalized tokens that substring scoring misses", async function () {
    const entries = [
      // Full-width text: substring metadata scoring (no NFKC) misses every
      // term; the shared retrieval tokenizer normalizes and matches.
      makeItem(1, "Paper one", "ＧＰＴ４ ｍｏｄｅｌｓ ｄｒｉｆｔ"),
      makeItem(2, "Paper two", "Protein folding kinetics."),
    ];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "gpt4 models drift",
      depth: "metadata",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "x",
        libraryID: 1,
      },
    });

    // BM25 token overlap is reported as its own state, not as a literal
    // metadata match.
    assert.equal(result.resourcePool.queryCoverage.matchedMetadata, 0);
    assert.isAtLeast(result.resourcePool.queryCoverage.matchedBm25, 1);
    const match = result.candidates.find(
      (candidate) => candidate.itemId === "1",
    );
    assert.isOk(
      match,
      `candidates were: ${JSON.stringify(
        result.candidates.map((candidate) => candidate.itemId),
      )}`,
    );
    assert.include(match?.whyMatched || "", "bm25");
  });

  it("keeps exact title-phrase matches ranked above bm25-only overlap", async function () {
    const entries = [
      makeItem(1, "Calcium imaging analysis", "Detailed pipeline."),
      makeItem(
        2,
        "Paper two",
        "ｃａｌｃｉｕｍ ｉｍａｇｉｎｇ ａｎａｌｙｓｉｓ",
      ),
    ];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "calcium imaging analysis",
      depth: "metadata",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "x",
        libraryID: 1,
      },
    });

    assert.equal(result.candidates[0].itemId, "1");
  });

  it("does not count a single weak shared token as a bm25 match", async function () {
    const entries = [makeItem(1, "Paper one", "ｄｒｉｆｔ")];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "representational drift dynamics",
      depth: "metadata",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "x",
        libraryID: 1,
      },
    });

    assert.equal(result.resourcePool.queryCoverage.matchedMetadata, 0);
  });
});

describe("LibraryRetrieveService shortlist fallback", function () {
  const CJK_ENTRIES = () => [
    makeItem(1, "论文一", "关于蛋白质折叠的研究。", { collectionIds: [3] }),
    makeItem(2, "论文二", "细胞分裂机制综述。", { collectionIds: [3] }),
    makeItem(3, "论文三", "神经元发育过程分析。", { collectionIds: [3] }),
    makeItem(4, "论文四", "基因表达调控网络。", { collectionIds: [3] }),
    makeItem(5, "论文五", "免疫系统应答机制。", { collectionIds: [3] }),
    makeItem(6, "论文六", "代谢通路建模方法。", { collectionIds: [3] }),
    makeItem(7, "论文七", "膜蛋白结构解析。", { collectionIds: [3] }),
    makeItem(8, "论文八", "线粒体功能研究。", { collectionIds: [3] }),
  ];

  it("falls back to the top-scored pool slice with a low-confidence warning when nothing matches", async function () {
    const entries = CJK_ENTRIES();
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "quantum entanglement experiments",
      depth: "metadata",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "x",
        libraryID: 1,
        selectedCollectionContexts: [
          { collectionId: 3, name: "Collection 3", libraryID: 1 },
        ],
      },
    });

    assert.isAbove(result.candidates.length, 0);
    assert.isTrue(
      result.warnings.some((warning) => warning.includes("LOW CONFIDENCE")),
      `warnings were: ${JSON.stringify(result.warnings)}`,
    );
  });

  it("keeps the matched ledger when enough records match", async function () {
    const entries = [
      makeItem(1, "Drift analysis one", "Representational drift analysis."),
      makeItem(2, "Drift analysis two", "Representational drift analysis."),
      makeItem(3, "Drift analysis three", "Representational drift analysis."),
      makeItem(4, "Drift analysis four", "Representational drift analysis."),
      makeItem(5, "Drift analysis five", "Representational drift analysis."),
      makeItem(6, "Unrelated", "Protein folding kinetics."),
    ];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "representational drift analysis",
      depth: "metadata",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "x",
        libraryID: 1,
      },
    });

    assert.isFalse(
      result.warnings.some((warning) => warning.includes("LOW CONFIDENCE")),
    );
    assert.isFalse(
      result.candidates.some((candidate) => candidate.itemId === "6"),
    );
  });

  it("leaves explicit item scopes untouched", async function () {
    const entries = CJK_ENTRIES();
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "quantum entanglement experiments",
      depth: "metadata",
      scope: { itemIds: [1, 2, 3] },
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "x",
        libraryID: 1,
      },
    });

    assert.isAbove(result.candidates.length, 0);
    assert.isFalse(
      result.warnings.some((warning) => warning.includes("LOW CONFIDENCE")),
    );
  });
});

describe("LibraryRetrieveService probe loop", function () {
  const UNMATCHED_ENTRIES = () => [
    makeItem(1, "论文甲", "脉冲神经网络芯片研究。"),
    makeItem(2, "论文乙", "蛋白质折叠动力学。"),
  ];
  const REQUEST = {
    conversationKey: 1,
    mode: "agent" as const,
    userText: "x",
    libraryID: 1,
  };

  it("runs one reformulation round when the first pass matches nothing", async function () {
    const quicksearchCalls: Array<{ query?: string }> = [];
    const reformulatorCalls: Array<{ triedProbes: string[] }> = [];
    const entries = [
      ...UNMATCHED_ENTRIES(),
      makeItem(3, "论文丙", "神经形态处理器设计。"),
      makeItem(4, "论文丁", "脉冲编码研究。"),
    ];
    const service = new LibraryRetrieveService(
      makeGateway(entries, {
        quicksearchCalls,
        quicksearchItemIds: (query) =>
          query === "spiking networks" ? [1, 3, 4] : [],
      }) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
      (async (params: { triedProbes: string[] }) => {
        reformulatorCalls.push({ triedProbes: params.triedProbes });
        return { variants: ["spiking networks"], notes: [] };
      }) as any,
    );

    const result = await service.retrieve({
      query: "neuromorphic hardware accelerators",
      queryVariants: ["brain-inspired chips"],
      depth: "evidence",
      apiBase: "https://example.invalid",
      apiKey: "test-key",
      request: REQUEST,
    });

    assert.lengthOf(reformulatorCalls, 1);
    assert.isAbove(reformulatorCalls[0].triedProbes.length, 0);
    assert.include(
      quicksearchCalls.map((call) => call.query),
      "spiking networks",
    );
    assert.equal(result.resourcePool.queryCoverage.probeRounds, 1);
    assert.isAtLeast(result.resourcePool.queryCoverage.variantsTried, 3);
    assert.isTrue(
      result.candidates.some((candidate) => candidate.itemId === "1"),
    );
  });

  it("stops after two extra rounds when nothing ever matches", async function () {
    let calls = 0;
    const service = new LibraryRetrieveService(
      makeGateway(UNMATCHED_ENTRIES(), { quicksearchItemIds: [] }) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
      (async () => {
        calls += 1;
        return { variants: [`fresh probe ${calls}`], notes: [] };
      }) as any,
    );

    const result = await service.retrieve({
      query: "neuromorphic hardware accelerators",
      queryVariants: ["brain-inspired chips"],
      depth: "evidence",
      apiBase: "https://example.invalid",
      apiKey: "test-key",
      request: REQUEST,
    });

    assert.equal(calls, 2);
    assert.equal(result.resourcePool.queryCoverage.probeRounds, 2);
  });

  it("skips the loop entirely without model config", async function () {
    const service = new LibraryRetrieveService(
      makeGateway(UNMATCHED_ENTRIES(), { quicksearchItemIds: [] }) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
      (async () => {
        throw new Error("reformulator must not be called without model config");
      }) as any,
    );

    const result = await service.retrieve({
      query: "neuromorphic hardware accelerators",
      queryVariants: ["brain-inspired chips"],
      depth: "evidence",
      request: REQUEST,
    });

    assert.equal(result.resourcePool.queryCoverage.probeRounds, 0);
  });

  it("degrades silently when reformulation fails", async function () {
    const service = new LibraryRetrieveService(
      makeGateway(UNMATCHED_ENTRIES(), { quicksearchItemIds: [] }) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
      (async () => ({
        variants: [],
        notes: ["Probe reformulation failed; kept the existing probes."],
      })) as any,
    );

    const result = await service.retrieve({
      query: "neuromorphic hardware accelerators",
      queryVariants: ["brain-inspired chips"],
      depth: "evidence",
      apiBase: "https://example.invalid",
      apiKey: "test-key",
      request: REQUEST,
    });

    assert.equal(result.resourcePool.queryCoverage.probeRounds, 0);
    assert.isTrue(
      result.warnings.some((warning) =>
        warning.includes("Probe reformulation failed"),
      ),
    );
  });
});

describe("LibraryRetrieveService evidence triage", function () {
  const POOL_ENTRIES = () =>
    Array.from({ length: 8 }, (_, index) =>
      makeItem(index + 1, `论文${index + 1}`, "与查询无关的摘要内容。", {
        collectionIds: [3],
      }),
    );
  const REQUEST = {
    conversationKey: 1,
    mode: "agent" as const,
    userText: "x",
    libraryID: 1,
    selectedCollectionContexts: [
      { collectionId: 3, name: "Collection 3", libraryID: 1 },
    ],
  };
  const NOOP_REFORMULATOR = (async () => ({
    variants: [],
    notes: [],
  })) as any;

  it("reorders snippet expansion and threads per-paper queries from triage", async function () {
    const builderCalls: Array<{
      itemId: number;
      question: string;
      queryPlan?: { lexicalTerms: string[] };
    }> = [];
    const service = new LibraryRetrieveService(
      makeGateway(POOL_ENTRIES(), { quicksearchItemIds: [] }) as any,
      {
        ensurePaperContext: async () => makePdfContext(["Body chunk text."]),
      } as any,
      (async (
        paperContext: PaperContextRef,
        _pdfContext: unknown,
        question: string,
        apiOptions?: { queryPlan?: { lexicalTerms: string[] } },
      ): Promise<PaperContextCandidate[]> => {
        builderCalls.push({
          itemId: paperContext.itemId,
          question,
          queryPlan: apiOptions?.queryPlan,
        });
        return [
          {
            paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
            itemId: paperContext.itemId,
            contextItemId: paperContext.contextItemId,
            title: paperContext.title,
            chunkIndex: 1,
            chunkText: "Body chunk text.",
            chunkKind: "methods",
            sectionLabel: "Methods",
            estimatedTokens: 10,
            bm25Score: 1,
            embeddingScore: 0,
            hybridScore: 1,
            evidenceScore: 1,
          },
        ];
      }) as any,
      NOOP_REFORMULATOR,
      (async () => ({
        selectedItemIds: ["7", "2"],
        perPaperQueries: { "7": "locate the electrode stimulation protocol" },
      })) as any,
    );

    const result = await service.retrieve({
      query: "stimulation protocols in these papers",
      queryVariants: ["optogenetic stimulation"],
      depth: "evidence",
      maxFullTextPapers: 2,
      apiBase: "https://example.invalid",
      apiKey: "test-key",
      request: REQUEST,
    });

    assert.deepEqual(
      builderCalls.map((call) => call.itemId),
      [7, 2],
    );
    assert.equal(
      builderCalls[0].question,
      "locate the electrode stimulation protocol",
    );
    assert.equal(
      builderCalls[1].question,
      "stimulation protocols in these papers",
    );
    // The per-paper override must keep the shared plan's variants: both the
    // override's own terms and the corpus-language variant terms drive the
    // chunk ranking.
    assert.isOk(builderCalls[0].queryPlan);
    assert.include(builderCalls[0].queryPlan?.lexicalTerms || [], "electrode");
    assert.include(
      builderCalls[0].queryPlan?.lexicalTerms || [],
      "optogenetic",
    );
    assert.equal(result.candidates[0].itemId, "7");
    assert.isTrue(
      result.warnings.some((warning) =>
        warning.includes("Candidate triage refined selection"),
      ),
    );
  });

  it("skips triage when the matched ledger is confident", async function () {
    const entries = Array.from({ length: 6 }, (_, index) =>
      makeItem(index + 1, `Drift analysis ${index + 1}`, "Drift analysis."),
    );
    const service = new LibraryRetrieveService(
      makeGateway(entries, { quicksearchItemIds: [] }) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
      NOOP_REFORMULATOR,
      (async () => {
        throw new Error("triage must not run for a confident ledger");
      }) as any,
    );

    const result = await service.retrieve({
      query: "drift analysis",
      queryVariants: ["representational drift"],
      depth: "evidence",
      apiBase: "https://example.invalid",
      apiKey: "test-key",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "x",
        libraryID: 1,
      },
    });

    assert.isFalse(
      result.warnings.some((warning) => warning.includes("triage")),
    );
  });

  it("keeps lexical order with a warning when triage returns null", async function () {
    const builderCalls: number[] = [];
    const service = new LibraryRetrieveService(
      makeGateway(POOL_ENTRIES(), { quicksearchItemIds: [] }) as any,
      {
        ensurePaperContext: async () => makePdfContext(["Body chunk text."]),
      } as any,
      (async (
        paperContext: PaperContextRef,
      ): Promise<PaperContextCandidate[]> => {
        builderCalls.push(paperContext.itemId);
        return [];
      }) as any,
      NOOP_REFORMULATOR,
      (async () => null) as any,
    );

    const result = await service.retrieve({
      query: "stimulation protocols in these papers",
      queryVariants: ["stimulation protocol"],
      depth: "evidence",
      maxFullTextPapers: 2,
      apiBase: "https://example.invalid",
      apiKey: "test-key",
      request: REQUEST,
    });

    assert.deepEqual(builderCalls, [1, 2]);
    assert.isTrue(
      result.warnings.some((warning) =>
        warning.includes("LLM triage unavailable"),
      ),
    );
  });

  it("runs one bounded rescan from triage-suggested probes", async function () {
    const quicksearchCalls: Array<{ query?: string }> = [];
    const service = new LibraryRetrieveService(
      makeGateway(POOL_ENTRIES(), {
        quicksearchCalls,
        quicksearchItemIds: (query) => (query === "新探针" ? [5] : []),
      }) as any,
      {
        ensurePaperContext: async () => makePdfContext(["Body chunk text."]),
      } as any,
      async () => [],
      NOOP_REFORMULATOR,
      (async () => ({
        selectedItemIds: ["1"],
        suggestedProbes: ["新探针"],
      })) as any,
    );

    const result = await service.retrieve({
      query: "stimulation protocols in these papers",
      queryVariants: ["stimulation protocol"],
      depth: "evidence",
      maxFullTextPapers: 1,
      apiBase: "https://example.invalid",
      apiKey: "test-key",
      request: REQUEST,
    });

    assert.include(
      quicksearchCalls.map((call) => call.query),
      "新探针",
    );
    assert.equal(result.resourcePool.queryCoverage.probeRounds, 1);
    assert.isAtLeast(result.resourcePool.queryCoverage.indexedTextMatched, 1);
    // A paper matched only by the triage-suggested probe must actually enter
    // the returned ledger, not just bump counters.
    assert.isTrue(
      result.candidates.some((candidate) => candidate.itemId === "5"),
      `candidates were: ${JSON.stringify(
        result.candidates.map((candidate) => candidate.itemId),
      )}`,
    );
    assert.isTrue(result.paperMatches.some((match) => match.itemId === "5"));
  });

  it("never displaces a paper the query itself matched", async function () {
    // One paper in the pool genuinely matches the query on its title and
    // abstract; the rest are noise. Probe hits are weaker evidence than that,
    // so they may take the seats of unmatched leads but never this one's.
    const entries = POOL_ENTRIES();
    entries[7] = makeItem(
      8,
      "Stimulation protocol for cortical neurons",
      "A stimulation protocol for cortical neurons is described.",
      { collectionIds: [3] },
    );
    const service = new LibraryRetrieveService(
      makeGateway(entries, {
        quicksearchItemIds: (query) => (query === "新探针" ? [5, 6, 7] : []),
      }) as any,
      {
        ensurePaperContext: async () => makePdfContext(["Body chunk text."]),
      } as any,
      async () => [],
      NOOP_REFORMULATOR,
      (async () => ({
        selectedItemIds: ["1"],
        suggestedProbes: ["新探针"],
      })) as any,
    );

    const result = await service.retrieve({
      query: "stimulation protocols in these papers",
      queryVariants: ["stimulation protocol"],
      depth: "evidence",
      maxCandidatePapers: 3,
      maxFullTextPapers: 2,
      apiBase: "https://example.invalid",
      apiKey: "test-key",
      request: REQUEST,
    });

    assert.isTrue(
      result.candidates.some((candidate) => candidate.itemId === "8"),
      `the matched paper was evicted; candidates were: ${JSON.stringify(
        result.candidates.map((candidate) => candidate.itemId),
      )}`,
    );
    assert.isTrue(
      result.paperMatches.some((match) => match.itemId === "8"),
      "a paper the query matched must stay in the ledger",
    );
  });

  it("ranks rescan hits by relevance, not by library order", async function () {
    // Twenty noise papers, so nothing the probe finds is in the shortlist
    // already. All three hits carry the probe phrase; only the last one is
    // about it, and it is returned last — library order would bury it.
    const entries = Array.from({ length: 20 }, (_, index) =>
      makeItem(index + 1, `论文${index + 1}`, "与查询无关的摘要内容。", {
        collectionIds: [3],
      }),
    );
    // Titles stay uniform: the shortlist tie-breaks on title, and a distinctive
    // one would seat these three before the rescan ever runs.
    const mention = "Kilohertz waveform is mentioned in passing here.";
    entries[14] = makeItem(15, "论文15", mention, { collectionIds: [3] });
    entries[15] = makeItem(16, "论文16", mention, { collectionIds: [3] });
    // Shares no vocabulary with the original query, so it enters only as a
    // discovery — but it is the one the probe is really about.
    entries[16] = makeItem(
      17,
      "论文17",
      "Kilohertz waveform calibration for kilohertz waveform delivery, on a kilohertz waveform schedule.",
      { collectionIds: [3] },
    );
    const service = new LibraryRetrieveService(
      makeGateway(entries, {
        quicksearchItemIds: (query) =>
          query === "kilohertz waveform" ? [15, 16, 17] : [],
      }) as any,
      {
        ensurePaperContext: async () => makePdfContext(["Body chunk text."]),
      } as any,
      async () => [],
      NOOP_REFORMULATOR,
      (async () => ({
        selectedItemIds: ["1"],
        suggestedProbes: ["kilohertz waveform"],
      })) as any,
    );

    const result = await service.retrieve({
      query: "stimulation protocols in these papers",
      queryVariants: ["stimulation protocol"],
      depth: "evidence",
      maxCandidatePapers: 5,
      maxFullTextPapers: 2,
      apiBase: "https://example.invalid",
      apiKey: "test-key",
      request: REQUEST,
    });

    const ids = result.candidates.map((candidate) => candidate.itemId);
    assert.include(ids, "17", `candidates were: ${JSON.stringify(ids)}`);
    assert.isBelow(
      ids.indexOf("17"),
      ids.indexOf("15"),
      `discoveries kept library order; candidates were: ${JSON.stringify(ids)}`,
    );
  });

  it("makes room for a rescan hit when the shortlist is already full", async function () {
    const service = new LibraryRetrieveService(
      makeGateway(POOL_ENTRIES(), {
        quicksearchItemIds: (query) => (query === "新探针" ? [5] : []),
      }) as any,
      {
        ensurePaperContext: async () => makePdfContext(["Body chunk text."]),
      } as any,
      async () => [],
      NOOP_REFORMULATOR,
      (async () => ({
        selectedItemIds: ["1"],
        suggestedProbes: ["新探针"],
      })) as any,
    );

    const result = await service.retrieve({
      query: "stimulation protocols in these papers",
      queryVariants: ["stimulation protocol"],
      depth: "evidence",
      maxCandidatePapers: 3,
      maxFullTextPapers: 1,
      apiBase: "https://example.invalid",
      apiKey: "test-key",
      request: REQUEST,
    });

    // The shortlist is capped, and a pool-fallback shortlist is full of papers
    // nothing matched. A paper the rescan actually matched has to be able to
    // take one of those seats — otherwise the probe round only moves counters
    // and the answer never sees what it found.
    assert.isTrue(
      result.candidates.some((candidate) => candidate.itemId === "5"),
      `candidates were: ${JSON.stringify(
        result.candidates.map((candidate) => candidate.itemId),
      )}`,
    );
    assert.isAtMost(result.candidates.length, 3, "the cap still holds");
  });

  it("reads a rescan hit before the unmatched papers it outranks", async function () {
    const expanded: number[] = [];
    const service = new LibraryRetrieveService(
      makeGateway(POOL_ENTRIES(), {
        quicksearchItemIds: (query) => (query === "新探针" ? [5] : []),
      }) as any,
      {
        ensurePaperContext: async (paperContext: PaperContextRef) => {
          expanded.push(paperContext.itemId);
          return makePdfContext(["Body chunk text."]);
        },
      } as any,
      async () => [],
      NOOP_REFORMULATOR,
      (async () => ({
        selectedItemIds: ["1"],
        suggestedProbes: ["新探针"],
      })) as any,
    );

    await service.retrieve({
      query: "stimulation protocols in these papers",
      queryVariants: ["stimulation protocol"],
      depth: "evidence",
      maxCandidatePapers: 3,
      maxFullTextPapers: 2,
      apiBase: "https://example.invalid",
      apiKey: "test-key",
      request: REQUEST,
    });

    // Snippet slots are handed out in shortlist order, so landing at the tail
    // is the same as never being found. Triage's own pick keeps the first slot.
    assert.include(
      expanded,
      5,
      `papers expanded were: ${JSON.stringify(expanded)}`,
    );
  });
});

describe("LibraryRetrieveService classified intent defaults", function () {
  const run = async (params: {
    intent?: "enumerate" | "verify" | "summarize";
    classifiedIntent?: unknown;
  }) => {
    const entries = [makeItem(1, "Drift paper", "Representational drift.")];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );
    return service.retrieve({
      query: "papers about drift",
      intent: params.intent,
      depth: "metadata",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "x",
        libraryID: 1,
        ...(params.classifiedIntent
          ? { classifiedIntent: params.classifiedIntent }
          : {}),
      } as any,
    });
  };

  it("uses the classified retrieval intent as the default", async function () {
    const result = await run({
      classifiedIntent: { retrievalIntent: "summarize", wantedSections: [] },
    });

    assert.equal(result.intent, "summarize");
  });

  it("lets explicit tool-arg intent beat the classified intent", async function () {
    const result = await run({
      intent: "verify",
      classifiedIntent: { retrievalIntent: "summarize", wantedSections: [] },
    });

    assert.equal(result.intent, "verify");
  });

  it("keeps regex defaulting when no classified intent is present", async function () {
    const result = await run({});

    assert.equal(result.intent, "enumerate");
  });
});

describe("LibraryRetrieveService body-evidence defaults", function () {
  const REQUEST = {
    conversationKey: 1,
    mode: "agent" as const,
    userText: "x",
    libraryID: 1,
  };
  const makeCandidate = (
    paperContext: PaperContextRef,
    input: {
      chunkIndex: number;
      chunkKind: string;
      sectionLabel: string;
      evidenceScore: number;
    },
  ): PaperContextCandidate =>
    ({
      paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
      itemId: paperContext.itemId,
      contextItemId: paperContext.contextItemId,
      title: paperContext.title,
      chunkIndex: input.chunkIndex,
      chunkText: `${input.sectionLabel} text ${input.chunkIndex}`,
      chunkKind: input.chunkKind,
      sectionLabel: input.sectionLabel,
      estimatedTokens: 10,
      bm25Score: 1,
      embeddingScore: 0,
      hybridScore: 1,
      evidenceScore: input.evidenceScore,
    }) as PaperContextCandidate;

  it("caps front-matter to one snippet when body evidence exists at evidence depth", async function () {
    const entries = [makeItem(1, "Drift paper", "Representational drift.")];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async () => makePdfContext(["chunk a", "chunk b"]),
      } as any,
      (async (
        paperContext: PaperContextRef,
      ): Promise<PaperContextCandidate[]> => [
        makeCandidate(paperContext, {
          chunkIndex: 0,
          chunkKind: "abstract",
          sectionLabel: "Abstract",
          evidenceScore: 1,
        }),
        makeCandidate(paperContext, {
          chunkIndex: 3,
          chunkKind: "methods",
          sectionLabel: "Methods",
          evidenceScore: 0.8,
        }),
        makeCandidate(paperContext, {
          chunkIndex: 4,
          chunkKind: "results",
          sectionLabel: "Results",
          evidenceScore: 0.7,
        }),
      ]) as any,
    );

    const result = await service.retrieve({
      query: "drift paper stimulation details",
      depth: "evidence",
      perPaperTopK: 2,
      request: REQUEST,
    });

    assert.isAbove(result.snippets.length, 0);
    for (const snippet of result.snippets) {
      assert.notEqual(snippet.chunkKind, "abstract");
    }
  });

  it("still returns front-matter when a paper has no body candidates", async function () {
    const entries = [makeItem(1, "Drift paper", "Representational drift.")];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async () => makePdfContext(["chunk a"]),
      } as any,
      (async (
        paperContext: PaperContextRef,
      ): Promise<PaperContextCandidate[]> => [
        makeCandidate(paperContext, {
          chunkIndex: 0,
          chunkKind: "abstract",
          sectionLabel: "Abstract",
          evidenceScore: 1,
        }),
        makeCandidate(paperContext, {
          chunkIndex: 1,
          chunkKind: "abstract",
          sectionLabel: "Abstract",
          evidenceScore: 0.9,
        }),
      ]) as any,
    );

    const result = await service.retrieve({
      query: "drift paper stimulation details",
      depth: "evidence",
      perPaperTopK: 2,
      request: REQUEST,
    });

    assert.lengthOf(result.snippets, 1);
    assert.equal(result.snippets[0].chunkKind, "abstract");
  });

  it("steers section ranking from classifier wantedSections for a CJK query", async function () {
    const entries = [makeItem(1, "Drift paper", "Representational drift.")];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async () => makePdfContext(["chunk a", "chunk b"]),
      } as any,
      (async (
        paperContext: PaperContextRef,
      ): Promise<PaperContextCandidate[]> => [
        makeCandidate(paperContext, {
          chunkIndex: 2,
          chunkKind: "results",
          sectionLabel: "Results",
          evidenceScore: 1,
        }),
        makeCandidate(paperContext, {
          chunkIndex: 5,
          chunkKind: "methods",
          sectionLabel: "Methods",
          evidenceScore: 0.5,
        }),
      ]) as any,
    );

    const result = await service.retrieve({
      query: "这些论文用了什么实验手段",
      depth: "evidence",
      perPaperTopK: 1,
      request: {
        ...REQUEST,
        classifiedIntent: {
          retrievalIntent: "enumerate",
          wantedSections: ["methods"],
        },
      } as any,
    });

    assert.equal(result.snippets[0]?.sectionLabel, "Methods");
  });
});

describe("LibraryRetrieveService prototype-key safety", function () {
  it("scores queries containing the token 'constructor' without NaN poisoning", async function () {
    const entries = [
      // Full-width text defeats substring metadata scoring, so the match can
      // only come from BM25 — which prototype-key pollution used to NaN out.
      makeItem(1, "Paper one", "ｃｏｎｓｔｒｕｃｔｏｒ ｎｅｔｗｏｒｋｓ"),
      makeItem(2, "Paper two", "Protein folding kinetics."),
    ];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "constructor networks",
      depth: "metadata",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "x",
        libraryID: 1,
      },
    });

    const match = result.candidates.find(
      (candidate) => candidate.itemId === "1",
    );
    assert.isOk(match);
    assert.include(match?.whyMatched || "", "bm25");
    assert.isTrue(Number.isFinite(match?.score));
  });
});

describe("LibraryRetrieveService review fixes", function () {
  const REQUEST = {
    conversationKey: 1,
    mode: "agent" as const,
    userText: "x",
    libraryID: 1,
  };

  it("sends the long CJK literal verbatim as a probe in verify mode", async function () {
    const quicksearchCalls: Array<{ query?: string }> = [];
    const literal = "这段文字包含一个很长的中文句子作为验证目标";
    const service = new LibraryRetrieveService(
      makeGateway([makeItem(1, "论文甲", "验证目标研究。")], {
        quicksearchCalls,
        quicksearchItemIds: [],
      }) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    await service.retrieve({
      query: literal,
      depth: "verify",
      request: REQUEST,
    });

    assert.include(
      quicksearchCalls.map((call) => call.query),
      literal,
    );
  });

  it("segments long CJK probes returned by the reformulator", async function () {
    const quicksearchCalls: Array<{ query?: string }> = [];
    const longPhrase = "神经形态计算的硬件加速器研究";
    const service = new LibraryRetrieveService(
      makeGateway([makeItem(1, "论文甲", "蛋白质折叠研究。")], {
        quicksearchCalls,
        quicksearchItemIds: [],
      }) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
      (async () => ({ variants: [longPhrase], notes: [] })) as any,
    );

    await service.retrieve({
      query: "unrelated english query",
      queryVariants: ["another probe"],
      depth: "evidence",
      apiBase: "https://example.invalid",
      apiKey: "test-key",
      request: REQUEST,
    });

    const recorded = quicksearchCalls.map((call) => call.query || "");
    assert.notInclude(recorded, longPhrase);
    assert.isTrue(
      recorded.some((query) => /[一-鿿]/.test(query) && query.length <= 6),
      `recorded probes were: ${JSON.stringify(recorded)}`,
    );
  });

  it("does not count ubiquitous shared tokens as a bm25 match", async function () {
    const entries = Array.from({ length: 6 }, (_, index) =>
      makeItem(
        index + 1,
        `Paper ${index + 1}`,
        `ｓｔｕｄｙ ｒｅｓｕｌｔｓ ｕｎｉｑｕｅ${index}`,
        { collectionIds: [3] },
      ),
    );
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "study results comparison",
      depth: "metadata",
      request: {
        ...REQUEST,
        selectedCollectionContexts: [
          { collectionId: 3, name: "C", libraryID: 1 },
        ],
      } as any,
    });

    assert.isTrue(
      result.warnings.some((warning) => warning.includes("LOW CONFIDENCE")),
      `warnings were: ${JSON.stringify(result.warnings)}`,
    );
  });
});

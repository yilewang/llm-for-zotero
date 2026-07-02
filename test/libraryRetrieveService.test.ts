import { assert } from "chai";
import { LibraryRetrieveService } from "../src/agent/services/libraryRetrieveService";
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
    assert.deepEqual(
      quicksearchCalls.map((call) => call.query),
      [result.queryPlan.originalQuery, variant],
    );
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

  it("scans tag quicksearch matches when selected collection and tag scopes are mixed", async function () {
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

    assert.lengthOf(quicksearchCalls, 2);
    assert.equal(quicksearchCalls[0]?.filters?.collectionId, 4);
    assert.deepEqual(quicksearchCalls[1]?.allowedItemIds, [7, 8]);
    assert.isUndefined(quicksearchCalls[1]?.filters);
    assert.equal(result.resourcePool.type, "mixed");
    assert.equal(result.resourcePool.queryCoverage.indexedTextMatched, 1);
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.itemId),
      ["8"],
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

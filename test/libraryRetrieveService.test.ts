import { assert } from "chai";
import {
  LibraryRetrieveService as ResolvedLibraryRetrieveService,
  QUICKSEARCH_MAX_PROBES,
  buildQuicksearchProbes,
} from "../src/agent/services/libraryRetrieveService";
import { buildLibraryRetrieveModelView } from "../src/agent/services/libraryRetrieveModelView";
import { groupPaperWorks } from "../src/agent/services/paperWorkIdentity";
import { buildRetrievalQueryPlan } from "../src/services/retrieval/retrievalQueryPlan";
import type { PaperContextCandidate } from "../src/services/paperContent/types";
import type { PaperContextRef } from "../src/shared/types";
import {
  createLibraryRetrieveTool,
  normalizeLibraryRetrieveArgs,
} from "../src/agent/tools/read/libraryRetrieve";
import {
  EVIDENCE_SECTION_KINDS,
  type EvidenceSectionKind,
} from "../src/shared/libraryChatEvidencePolicy";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { renderAgentPromptEnvelope } from "../src/agent/model/messageBuilder";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import {
  makeGateway,
  makeItem,
  makePdfContext,
} from "./helpers/libraryRetrieveRig";

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

describe("LibraryRetrieveService", function () {
  it("leaves out a folder's papers the user removed in Task progress", async function () {
    const entries = [1, 2, 3].map((itemId) =>
      makeItem(itemId, `Drift paper ${itemId}`, "Representational drift.", {
        hasPdf: true,
        collectionIds: [44],
      }),
    );
    const gateway = makeGateway(entries) as any;
    const resolve = gateway.resolveLibraryScopeItemIds;
    const seen: Array<number[] | undefined> = [];
    gateway.resolveLibraryScopeItemIds = async (params: any) => {
      seen.push(params.excludedItemIds);
      const resolved = await resolve(params);
      const excluded = new Set(params.excludedItemIds || []);
      return {
        ...resolved,
        itemIds: resolved.itemIds.filter((id: number) => !excluded.has(id)),
      };
    };
    const service = new LibraryRetrieveService(
      gateway,
      { ensurePaperContext: async () => makePdfContext([]) } as any,
      async () => [],
    );
    const result = await service.retrieve({
      query: "representational drift",
      depth: "metadata",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "What do these papers say about drift?",
        libraryID: 1,
        selectedCollectionContexts: [
          {
            collectionId: 44,
            name: "Drift",
            libraryID: 1,
            excludedItemIds: [2],
          },
        ],
      },
    });
    assert.deepEqual(seen, [[2]], "the exclusion reaches the scope");
    assert.equal(result.resourcePool.totalItems, 2);
    assert.notInclude(
      result.candidates.map((candidate) => candidate.itemId),
      "2",
    );
  });

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

  describe("a snippet cap smaller than the papers' depth", function () {
    function denoisingService(paperCount: number) {
      const entries = Array.from({ length: paperCount }, (_, index) =>
        makeItem(index + 1, `Denoising paper ${index + 1}`, "Denoising.", {
          hasPdf: true,
        }),
      );
      return new LibraryRetrieveService(
        makeGateway(entries) as any,
        {
          ensurePaperContext: async () =>
            makePdfContext(["Methods\nA denoising model is evaluated."]),
        } as any,
        async (paperContext): Promise<PaperContextCandidate[]> =>
          [0, 1, 2].map((index) => ({
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
          })),
      );
    }
    const retrieveDenoising = (paperCount: number, maxTotalSnippets: number) =>
      denoisingService(paperCount).retrieve({
        query: "denoising",
        depth: "evidence",
        methods: ["metadata", "abstract", "fts"],
        maxFullTextPapers: paperCount,
        perPaperTopK: 3,
        maxTotalSnippets,
        request: {
          conversationKey: 1,
          mode: "agent",
          userText: "Find denoising evidence",
          libraryID: 1,
        },
      });

    it("gives every paper one snippet before any paper a second", async function () {
      const result = await retrieveDenoising(5, 5);
      assert.lengthOf(result.snippets, 5);
      assert.sameMembers(
        result.snippets.map((snippet) => snippet.itemId),
        ["1", "2", "3", "4", "5"],
      );
      const deeper = await retrieveDenoising(5, 7);
      const counts = new Map<string, number>();
      for (const snippet of deeper.snippets)
        counts.set(snippet.itemId, (counts.get(snippet.itemId) || 0) + 1);
      assert.deepEqual(
        ["1", "2", "3", "4", "5"].map((itemId) => counts.get(itemId)),
        [3, 1, 1, 1, 1],
        "the top-up goes to the papers in rank order",
      );
    });

    it("marks a paper the cap left without a snippet as not returned", async function () {
      const result = await retrieveDenoising(7, 5);
      const byId = new Map(
        result.paperMatches.map((match) => [match.itemId, match]),
      );
      for (const itemId of ["1", "2", "3", "4", "5"]) {
        assert.equal(byId.get(itemId)?.returnedSnippetCount, 1, itemId);
        assert.isUndefined(byId.get(itemId)?.passageStatus, itemId);
      }
      for (const itemId of ["6", "7"]) {
        assert.equal(byId.get(itemId)?.returnedSnippetCount, 0, itemId);
        assert.equal(
          byId.get(itemId)?.passageStatus,
          "not_returned_budget",
          itemId,
        );
      }
      assert.equal(result.frontier.stopReason, "budget_limit");
    });
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

  describe("verify mode matches whole words", function () {
    async function verify(query: string, chunk: string) {
      const service = new LibraryRetrieveService(
        makeGateway([
          makeItem(1, "Neutral title", "A method paper.", { hasPdf: true }),
        ]) as any,
        {
          ensurePaperContext: async () => makePdfContext([chunk]),
        } as any,
        async () => [],
      );
      return service.retrieve({
        query,
        depth: "verify",
        request: {
          conversationKey: 1,
          mode: "agent",
          userText: `Verify ${query}`,
          libraryID: 1,
        },
      });
    }

    it("does not match a term inside a longer word", async function () {
      const result = await verify(
        "cell",
        "Results\nThe excellent outcome held.",
      );
      assert.lengthOf(result.snippets, 0);
    });

    it("matches a term that is a whole word", async function () {
      const result = await verify("cell", "Results\nThe cell counts rose.");
      assert.lengthOf(result.snippets, 1);
      assert.equal(result.snippets[0].matchMethod, "exact");
    });

    it("does not match a phrase that occurs only inside longer words", async function () {
      const result = await verify(
        "cell count",
        "Results\nThe excellent counting method held.",
      );
      assert.lengthOf(result.snippets, 0);
    });

    it("matches a hyphenated term case-insensitively", async function () {
      const result = await verify("IL-6", "Results\nSerum il-6 levels rose.");
      assert.lengthOf(result.snippets, 1);
    });

    it("accepts an English plural of a whole word", async function () {
      const result = await verify("neuron", "Results\nNeurons fired in CA1.");
      assert.lengthOf(result.snippets, 1);
    });

    it("rejects other suffixes after a term", async function () {
      assert.lengthOf(
        (await verify("cell", "Results\nA cellular state held.")).snippets,
        0,
      );
      assert.lengthOf(
        (await verify("rat", "Results\nThe rating rose.")).snippets,
        0,
      );
    });

    it("accepts a plural after the last word of a phrase", async function () {
      const result = await verify(
        "place cell",
        "Results\nPlace cells remapped.",
      );
      assert.lengthOf(result.snippets, 1);
    });

    it("keeps substring matching for CJK terms", async function () {
      const result = await verify("神经元", "结果\n海马神经元活动增加。");
      assert.lengthOf(result.snippets, 1);
    });
  });

  describe("verify mode cites a snippet's body text", function () {
    async function verify(query: string, chunk: string) {
      const service = new LibraryRetrieveService(
        makeGateway([
          makeItem(1, "Neutral title", "A method paper.", { hasPdf: true }),
        ]) as any,
        {
          ensurePaperContext: async () => makePdfContext([chunk]),
        } as any,
        async () => [],
      );
      const result = await service.retrieve({
        query,
        depth: "verify",
        request: {
          conversationKey: 1,
          mode: "agent",
          userText: `Verify ${query}`,
          libraryID: 1,
        },
      });
      assert.lengthOf(result.snippets, 1);
      return {
        snippet: result.snippets[0],
        quotes: result.quoteCitations || [],
      };
    }
    const flat = (text: string) => text.replace(/\s+/g, " ").trim();
    const unescapedDollars = (text: string) =>
      (text.match(/(?<!\\)\$/g) || []).length;

    it("starts the quote at the body when the snippet opens with a heading", async function () {
      const body =
        "Organisms continually tune their perceptual systems to the features they encounter in their environment. We have studied how ongoing experience reorganizes the synaptic connectivity of neurons in the olfactory cortex of the mouse.";
      const { snippet, quotes } = await verify(
        "synaptic connectivity",
        `# Summary\n\n${body}`,
      );
      // The model still sees the snippet as before.
      assert.equal(snippet.snippet, `# Summary ${body}`);
      assert.lengthOf(quotes, 1);
      assert.equal(snippet.quoteCitationId, quotes[0].id);
      assert.equal(quotes[0].quoteText, body);
      assert.include(flat(snippet.snippet), flat(quotes[0].quoteText));
    });

    it("starts the quote at the body when a heading line runs straight into it", async function () {
      const body =
        "In the rodent brain, the main olfactory bulb is one of two regions where neurogenesis persists throughout the lifetime of the animal.";
      const { snippet, quotes } = await verify(
        "olfactory bulb",
        `## Introduction\n${body}`,
      );
      assert.equal(snippet.snippet, `## Introduction ${body}`);
      assert.lengthOf(quotes, 1);
      assert.equal(quotes[0].quoteText, body);
    });

    it("never runs a quote across a heading inside the snippet", async function () {
      const before =
        "The recordings were stable across all sessions of the experiment, and the cells kept their place fields.";
      const after =
        "We recorded the activity of hippocampal neurons across many days while mice explored a familiar track.";
      const { snippet, quotes } = await verify(
        "place fields",
        `${before}\n\n# 4 | DISCUSSION\n\n${after}`,
      );
      assert.equal(snippet.snippet, `${before} # 4 | DISCUSSION ${after}`);
      assert.lengthOf(quotes, 1);
      assert.equal(quotes[0].quoteText, before);
    });

    it("drops the tail of a heading the window cut into", async function () {
      const earlier =
        "Earlier sections describe the surgery and the training schedule in full detail for every animal.";
      const heading = "# Summary of the recorded population activity";
      const lead = [1, 2, 3, 4, 5]
        .map(
          (i) => `Session ${i} kept the same decoding performance as before.`,
        )
        .join(" ");
      const body = `${lead} Ongoing experience reorganizes the synaptic connectivity of cortical neurons.`;
      const { snippet, quotes } = await verify(
        "synaptic connectivity",
        `${earlier} ${earlier}\n\n${heading}\n\n${body}`,
      );
      // The window opens inside the heading line.
      assert.isTrue(snippet.snippet.startsWith("..."), snippet.snippet);
      assert.notInclude(snippet.snippet, "# Summary");
      assert.include(snippet.snippet, "population activity");
      assert.lengthOf(quotes, 1);
      assert.isTrue(
        quotes[0].quoteText.startsWith("Session 1"),
        quotes[0].quoteText,
      );
      assert.include(flat(snippet.snippet), flat(quotes[0].quoteText));
    });

    it("mints no quote for a snippet that is only a heading", async function () {
      const { snippet, quotes } = await verify(
        "hippocampal place codes",
        "# Slow drift of hippocampal place codes across many weeks of maze training",
      );
      assert.isEmpty(quotes);
      assert.notProperty(snippet, "quoteCitationId");
    });

    it("trims a quote the snippet window cut inside a formula", async function () {
      const head =
        "The model predicted steering in synthetic settings with high accuracy.";
      const filler = [1, 2, 3, 4, 5]
        .map(
          (i) => ` Session ${i} kept the same decoding performance as before.`,
        )
        .join("");
      // The window ends 360 characters after the match, inside the formula.
      const formula = " $( \\rho = 0 . 7 7$ , $p \\dot < 0 . 0 0 1$ ) for all.";
      const chunk = `${head}${filler}${formula} The fit held for every animal in the second cohort.`;
      const { snippet, quotes } = await verify("predicted steering", chunk);
      assert.equal(
        unescapedDollars(snippet.snippet) % 2,
        1,
        "the window cut the formula",
      );
      assert.lengthOf(quotes, 1);
      const quote = quotes[0].quoteText;
      assert.equal(unescapedDollars(quote) % 2, 0, quote);
      assert.notInclude(quote, "\\rho");
      assert.include(flat(snippet.snippet), flat(quote));
      assert.isTrue(quote.startsWith(head), quote);
      assert.isTrue(quote.endsWith("as before."), quote);
    });

    it("keeps an ordinary snippet as its quote", async function () {
      const chunk =
        "Results\nThe calcium imaging analysis pipeline used deconvolution with $\\tau = 0 . 5$ s and recovered spikes reliably.";
      const { snippet, quotes } = await verify(
        "calcium imaging analysis",
        chunk,
      );
      assert.lengthOf(quotes, 1);
      assert.equal(quotes[0].quoteText, snippet.snippet);
    });

    it("never shows the model the quote's internal source text", async function () {
      const { snippet } = await verify(
        "synaptic connectivity",
        "# Summary\n\nWe have studied how ongoing experience reorganizes the synaptic connectivity of neurons in the cortex.",
      );
      assert.deepEqual(
        Object.keys(snippet).filter((key) => /quoteSource/i.test(key)),
        [],
      );
    });
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

describe("LibraryRetrieveService intent defaults", function () {
  const run = async (params: {
    intent?: "enumerate" | "verify" | "summarize";
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
      } as any,
    });
  };
  it("uses the explicit tool-arg intent", async function () {
    const result = await run({ intent: "verify" });

    assert.equal(result.intent, "verify");
  });

  it("defaults the intent from the query when the tool gives none", async function () {
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

  describe("section steering in any language", function () {
    const QUESTION = "这些论文用了什么方法？";
    const INTRODUCTION = {
      chunkIndex: 1,
      chunkKind: "introduction",
      sectionLabel: "Introduction",
    };
    const METHODS = {
      chunkIndex: 2,
      chunkKind: "methods",
      sectionLabel: "Methods",
    };

    /** The section labels of the one-slot evidence a paper of `chunks`
     * (equally relevant, in paper order) yields for the Chinese question. */
    async function steeredSections(
      args: { queryVariants?: string[]; sections?: EvidenceSectionKind[] },
      chunks: Array<typeof INTRODUCTION> = [INTRODUCTION, METHODS],
    ): Promise<Array<string | undefined>> {
      const entries = [makeItem(1, "Drift paper", "Representational drift.")];
      const service = new LibraryRetrieveService(
        makeGateway(entries) as any,
        {
          ensurePaperContext: async () =>
            makePdfContext(["chunk a", "chunk b", "chunk c"]),
        } as any,
        (async (
          paperContext: PaperContextRef,
        ): Promise<PaperContextCandidate[]> =>
          chunks.map((chunk) =>
            makeCandidate(paperContext, { ...chunk, evidenceScore: 0.5 }),
          )) as any,
      );
      const result = await service.retrieve({
        query: QUESTION,
        ...args,
        scope: { itemIds: [1] },
        depth: "evidence",
        perPaperTopK: 1,
        maxTotalSnippets: 1,
        request: REQUEST,
      });
      return result.snippets.map((snippet) => snippet.sectionLabel);
    }

    it("prefers the sections the model names for a question in any language", async function () {
      assert.deepEqual(await steeredSections({ sections: ["methods"] }), [
        "Methods",
      ]);
    });

    it("reads the section cue from English query variants", async function () {
      assert.deepEqual(
        await steeredSections({ queryVariants: ["methods used"] }),
        ["Methods"],
      );
    });

    it("keeps the base order when nothing names a section", async function () {
      assert.deepEqual(await steeredSections({}), ["Introduction"]);
    });

    it("ranks a directly read chunk by its enclosing section before its subsection title, like the index path", async function () {
      const firstLabel = async (sections: EvidenceSectionKind[]) => {
        const entries = [makeItem(1, "Drift paper", "Representational drift.")];
        const service = new LibraryRetrieveService(
          makeGateway(entries) as any,
          {
            ensurePaperContext: async () =>
              makePdfContext(["chunk a", "chunk b", "chunk c"]),
          } as any,
          (async (
            paperContext: PaperContextRef,
          ): Promise<PaperContextCandidate[]> => [
            makeCandidate(paperContext, {
              ...INTRODUCTION,
              evidenceScore: 0.5,
            }),
            {
              ...makeCandidate(paperContext, {
                chunkIndex: 6,
                chunkKind: "body",
                sectionLabel: "Data analysis",
                evidenceScore: 0.5,
              }),
              enclosingSection: "Materials and methods",
            },
          ]) as any,
        );
        const result = await service.retrieve({
          query: QUESTION,
          sections,
          scope: { itemIds: [1] },
          depth: "evidence",
          perPaperTopK: 1,
          maxTotalSnippets: 1,
          request: REQUEST,
        });
        return result.snippets[0]?.sectionLabel;
      };
      assert.equal(
        await firstLabel(["methods"]),
        "Materials and methods › Data analysis",
        "the snippet names its enclosing section too",
      );
      assert.equal(await firstLabel(["results"]), "Introduction");
    });

    it("admits a named abstract instead of demoting it as front matter", async function () {
      const ABSTRACT = {
        chunkIndex: 0,
        chunkKind: "abstract",
        sectionLabel: "Abstract",
      };
      assert.deepEqual(await steeredSections({}, [ABSTRACT, METHODS]), [
        "Methods",
      ]);
      assert.deepEqual(
        await steeredSections({ sections: ["abstract"] }, [ABSTRACT, METHODS]),
        ["Abstract"],
      );
    });
  });
});

describe("library_retrieve sections argument", function () {
  it("normalizes named sections and rejects an unknown section kind with the accepted ones", function () {
    const tool = createLibraryRetrieveTool({} as never);
    const accepted = tool.validate({
      query: "这些论文用了什么方法？",
      sections: ["Methods", "limitations", "methods"],
    });
    assert.isTrue(accepted.ok);
    assert.deepEqual(accepted.ok && accepted.value.sections, [
      "methods",
      "limitations",
    ]);

    for (const sections of [["method"], "methods", [3]]) {
      const refused = tool.validate({ query: "q", sections });
      assert.isFalse(refused.ok, JSON.stringify(sections));
      const error = refused.ok ? "" : refused.error;
      assert.include(error, "sections");
      assert.include(error, EVIDENCE_SECTION_KINDS.join(", "));
    }
    const named = tool.validate({ query: "q", sections: ["method"] });
    assert.include(named.ok ? "" : named.error, '"method"');
  });

  it("tells the model about sections in the schema and turn guidance it sees", async function () {
    const registry = new AgentToolRegistry();
    registry.register(createLibraryRetrieveTool({} as never));
    const spec = registry
      .listTools()
      .find((entry) => entry.name === "library_retrieve")!;
    const schema = spec.inputSchema as {
      properties: Record<string, unknown>;
    };
    assert.deepEqual(schema.properties.sections, {
      type: "array",
      items: { type: "string" },
    });

    // Parameter descriptions never reach the model; a library-level turn's
    // guidance does, and it names every section kind.
    const rendered = await renderAgentPromptEnvelope(
      resolveAgentRuntimeRequest({
        conversationKey: 1,
        mode: "agent",
        userText: "这些论文用了什么方法？",
        libraryID: 1,
      }),
      registry.listToolDefinitions(),
      [],
    );
    const sectionsLine = rendered.inventory.toolGuidanceInstructions
      .join("\n")
      .split("\n")
      .find((line) => /\bsections\b/.test(line));
    assert.isString(sectionsLine);
    assert.include(sectionsLine, "any language");
    for (const kind of EVIDENCE_SECTION_KINDS) {
      assert.include(sectionsLine, kind);
    }
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

describe("LibraryRetrieveService exact-match ranking", function () {
  it("keeps the strongest exact matches of one paper, not the first in document order", async function () {
    const weak = (n: number) =>
      `Section ${n}\nThe zebrafish cohort was imaged.`;
    const strong = (n: number) =>
      `Section ${n}\nThe zebrafish cohort showed calcium transients in hippocampal neurons during sleep.`;
    const service = new LibraryRetrieveService(
      makeGateway([makeItem(1, "Imaging paper", "", { hasPdf: true })]) as any,
      {
        ensurePaperContext: async () =>
          makePdfContext([
            weak(1),
            weak(2),
            weak(3),
            strong(4),
            strong(5),
            strong(6),
          ]),
      } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query:
        "zebrafish cohort calcium transients hippocampal neurons during sleep",
      depth: "verify",
      perPaperTopK: 3,
      scope: { libraryID: 1, itemIds: [1] },
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Verify the zebrafish calcium claim",
        libraryID: 1,
      },
    });

    const exact = result.snippets.filter(
      (snippet) => snippet.matchMethod === "exact",
    );
    assert.deepEqual(
      exact.map((snippet) => Number(snippet.chunkIndex)).sort((a, b) => a - b),
      [3, 4, 5],
    );
  });

  it("breaks equal-score ties by item id, not by title", async function () {
    const entries = [
      makeItem(7, "Aardvark neuron study", "", { hasPdf: true }),
      makeItem(3, "Zebra neuron study", "", { hasPdf: true }),
    ];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async () =>
          makePdfContext(["Methods\nThe shared quasar phrase appears here."]),
      } as any,
      async () => [],
    );

    const result = await service.retrieve({
      query: "shared quasar phrase",
      depth: "verify",
      scope: { libraryID: 1, itemIds: [7, 3] },
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "Verify the shared quasar phrase",
        libraryID: 1,
      },
    });

    const order = result.snippets.map((snippet) => snippet.itemId);
    assert.deepEqual(order, ["3", "7"]);
  });
});

describe("LibraryRetrieveService abstract-only papers and same-work marking", function () {
  const request = {
    conversationKey: 1,
    mode: "agent" as const,
    userText: "Find the hexagonal spatial map claim",
    libraryID: 1,
  };
  const ROOMY = 1_000_000;

  it("returns a no-PDF paper's matching abstract as one abstract passage that is not body evidence", async function () {
    const entries = [
      makeItem(
        1,
        "Grid cells in entorhinal cortex",
        "Grid cells encode a hexagonal spatial map of the environment.",
        { hasPdf: false },
      ),
      makeItem(2, "Unrelated imaging paper", "", { hasPdf: true }),
    ];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async () =>
          makePdfContext(["Methods\nCalcium imaging of zebrafish larvae."]),
      } as any,
      async () => [],
    );
    const input = {
      query: "hexagonal spatial map",
      depth: "verify" as const,
      scope: { libraryID: 1, itemIds: [1, 2] },
    };
    const result = await service.retrieve({ ...input, request });

    const abstractPassages = result.snippets.filter(
      (snippet) => snippet.itemId === "1",
    );
    assert.lengthOf(abstractPassages, 1);
    const [passage] = abstractPassages;
    assert.equal(passage.sourceKind, "abstract");
    assert.equal(passage.chunkKind, "abstract");
    assert.equal(passage.matchMethod, "metadata");
    assert.include(passage.snippet, "hexagonal spatial map");
    assert.isUndefined(passage.contextItemId, "no attachment to anchor");
    assert.isUndefined(passage.quoteCitationId, "no quote anchor");
    assert.notInclude(
      (result.quoteCitations || []).map((citation) => String(citation.itemId)),
      "1",
    );
    assert.equal(
      result.answerContract.papersBodyRead,
      0,
      "an abstract is not body evidence",
    );

    const content = buildLibraryRetrieveModelView({
      input,
      result,
      roomTokens: ROOMY,
    })!.content as Record<string, any>;
    assert.include(
      content.paperMatches.map((row: { itemId: string }) => row.itemId),
      "1",
    );
    assert.equal(
      content.snippets.find((row: { itemId: string }) => row.itemId === "1")
        ?.sourceKind,
      "abstract",
    );
  });

  it("returns no abstract passage in verify when the abstract lacks the exact phrase, and lists the paper as not read", async function () {
    const entries = [
      makeItem(
        1,
        "Grid cells in entorhinal cortex",
        "Grid cells fire in hexagonal patterns.",
        { hasPdf: false },
      ),
      makeItem(2, "Spatial map paper", "", { hasPdf: true }),
    ];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async () =>
          makePdfContext([
            "Results\nPlace cells form a hexagonal spatial map in this task.",
          ]),
      } as any,
      async () => [],
    );
    const input = {
      query: "hexagonal spatial map",
      depth: "verify" as const,
      scope: { libraryID: 1, itemIds: [1, 2] },
    };
    const result = await service.retrieve({ ...input, request });

    assert.notInclude(
      result.snippets.map((snippet) => snippet.itemId),
      "1",
    );
    const row = result.paperMatches.find((match) => match.itemId === "1");
    assert.equal(row?.passageStatus, "no_pdf_attachment");
    const content = buildLibraryRetrieveModelView({
      input,
      result,
      roomTokens: ROOMY,
    })!.content as Record<string, any>;
    const viewRow = content.paperMatches.find(
      (entry: { itemId: string }) => entry.itemId === "1",
    );
    assert.equal(viewRow?.passageStatus, "no_pdf_attachment");
    assert.equal(viewRow?.title, "Grid cells in entorhinal cortex");
  });

  it("marks a preprint and its journal version as one work, and never groups by a short title alone", async function () {
    const entries = [
      makeItem(1, "Sparse coding of natural images in visual cortex"),
      makeItem(2, "Sparse Coding of Natural Images in Visual Cortex: a model"),
      makeItem(3, "Introduction"),
      makeItem(4, "Introduction"),
      makeItem(5, "Introduction"),
      makeItem(6, "Introduction"),
      makeItem(7, "Attention for sequence models"),
      makeItem(8, "Transformers: the preprint"),
    ];
    entries[0].metadata.fields.DOI = "10.48550/arXiv.2301.00001";
    entries[1].metadata.fields.DOI = "10.1016/j.neuron.2024.01.001";
    entries[1].target.year = "2023";
    entries[3].metadata.creators = [
      { creatorType: "author", firstName: "Bo", lastName: "Jones" },
    ];
    entries[6].metadata.fields.url = "https://arxiv.org/abs/2302.12345v2";
    entries[7].metadata.fields.DOI = "10.48550/arXiv.2302.12345";
    entries[7].metadata.creators = [
      { creatorType: "author", firstName: "Bo", lastName: "Jones" },
    ];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async () =>
          makePdfContext(["Methods\nA model is evaluated."]),
      } as any,
      async (paperContext): Promise<PaperContextCandidate[]> => [
        {
          paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
          itemId: paperContext.itemId,
          contextItemId: paperContext.contextItemId,
          title: paperContext.title,
          chunkIndex: 1,
          chunkText: `Methods\nThe model of paper ${paperContext.itemId} is evaluated.`,
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
      query: "model",
      depth: "evidence",
      methods: ["metadata", "abstract", "fts"],
      scope: {
        libraryID: 1,
        itemIds: entries.map((entry) => entry.target.itemId),
      },
      request,
    });

    const byId = new Map(
      result.paperMatches.map((match) => [match.itemId, match]),
    );
    assert.lengthOf(result.paperMatches, 8, "rows are marked, not merged");
    assert.isString(byId.get("1")?.workGroupId);
    assert.equal(
      byId.get("1")?.workGroupId,
      byId.get("2")?.workGroupId,
      "same title before the subtitle, first creator and close years",
    );
    for (const itemId of ["3", "4", "5", "6"]) {
      assert.notProperty(byId.get(itemId)!, "workGroupId", itemId);
    }
    assert.isString(byId.get("7")?.workGroupId);
    assert.equal(
      byId.get("7")?.workGroupId,
      byId.get("8")?.workGroupId,
      "an arXiv URL and an arXiv DOI name one work",
    );
    assert.notEqual(byId.get("1")?.workGroupId, byId.get("7")?.workGroupId);
    assert.lengthOf(result.snippets, 8, "every item keeps its passage");
    assert.equal(result.resourcePool.queryCoverage.evidencePapers, 8);
    assert.equal(result.resourcePool.queryCoverage.evidenceWorks, 6);

    const content = buildLibraryRetrieveModelView({
      input: {},
      result,
      roomTokens: ROOMY,
    })!.content as Record<string, any>;
    const viewRow = content.paperMatches.find(
      (row: { itemId: string }) => row.itemId === "2",
    );
    assert.equal(viewRow?.workGroupId, byId.get("2")?.workGroupId);
  });
});

describe("abstract-only passages need two distinct query terms", function () {
  const request = {
    conversationKey: 1,
    mode: "agent" as const,
    userText: "q",
    libraryID: 1,
  };
  async function abstractPassageFor(abstract: string, query: string) {
    const entries = [
      makeItem(1, "A paper", abstract, { hasPdf: false }),
      makeItem(2, "Other", "", { hasPdf: true }),
    ];
    const service = new LibraryRetrieveService(
      makeGateway(entries) as any,
      {
        ensurePaperContext: async () => makePdfContext(["Methods\nNothing."]),
      } as any,
      async () => [],
    );
    const result = await service.retrieve({
      query,
      depth: "evidence",
      scope: { libraryID: 1, itemIds: [1, 2] },
      request,
    });
    return result.snippets.filter((snippet) => snippet.itemId === "1");
  }

  it("adds no abstract passage for one shared term out of two", async function () {
    assert.lengthOf(
      await abstractPassageFor(
        "Hexagonal firing patterns appear in many regions.",
        "hexagonal spatial map",
      ),
      0,
    );
  });

  it("adds an abstract passage for two shared terms", async function () {
    assert.lengthOf(
      await abstractPassageFor(
        "Hexagonal firing forms a spatial code.",
        "hexagonal spatial map",
      ),
      1,
    );
  });

  it("does not count a term found only inside a longer word", async function () {
    assert.lengthOf(
      await abstractPassageFor(
        "Excellent hexagonal results were seen.",
        "hexagonal cell",
      ),
      0,
    );
  });
});

describe("groupPaperWorks title and creator key", function () {
  const paper = (itemId: number, title: string, year: string) => ({
    itemId,
    title,
    firstCreatorLastName: "Devlin",
    year,
  });

  it("groups a short main title with a long subtitle by its full title", function () {
    const title =
      "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding";
    const groups = groupPaperWorks([
      paper(1, title, "2018"),
      paper(2, title, "2019"),
    ]);
    assert.equal(groups.get(1), groups.get(2));
    assert.isString(groups.get(1));
  });

  it("groups CJK titles of at least eight letters, not shorter ones", function () {
    const long = groupPaperWorks([
      paper(1, "深度双向变换器的语言理解预训练", "2018"),
      paper(2, "深度双向变换器的语言理解预训练", "2019"),
    ]);
    assert.isString(long.get(1));
    assert.equal(long.get(1), long.get(2));
    const short = groupPaperWorks([
      paper(1, "语言理解预训练", "2018"),
      paper(2, "语言理解预训练", "2019"),
    ]);
    assert.equal(short.size, 0);
  });

  it("keeps Part I, Part II and a review of one series as three works", function () {
    const base = "Neural dynamics of decision making";
    const groups = groupPaperWorks([
      paper(1, `${base}: Part I. Theory`, "2020"),
      paper(2, `${base}: Part II. Experiments`, "2021"),
      paper(3, `${base}: a review`, "2022"),
    ]);
    assert.equal(groups.size, 0);
  });

  it("groups a titled-subtitle version with the bare title one year apart", function () {
    const base = "Neural dynamics of decision making";
    const groups = groupPaperWorks([
      paper(1, `${base}: Part I. Theory`, "2020"),
      paper(2, base, "2021"),
    ]);
    assert.isString(groups.get(1));
    assert.equal(groups.get(1), groups.get(2));
  });

  it("never puts two versions more than two years apart in one group, even through a middle one", function () {
    const title = "Neural dynamics of decision making in animals";
    const groups = groupPaperWorks([
      paper(1, title, "2019"),
      paper(2, title, "2020"),
      paper(3, title, "2022"),
    ]);
    assert.equal(groups.get(1), groups.get(2));
    assert.isUndefined(groups.get(3));
  });

  it("does not group two chapters that share the book's DOI", function () {
    const groups = groupPaperWorks([
      { ...paper(1, "Chapter one on memory", "2020"), doi: "10.1000/book" },
      { ...paper(2, "Chapter two on attention", "2020"), doi: "10.1000/book" },
    ]);
    assert.equal(groups.size, 0);
  });

  it("still groups a preprint (arXiv DOI) with its journal version of the same title", function () {
    const title = "Neural dynamics of decision making in animals";
    const groups = groupPaperWorks([
      { ...paper(1, title, "2020"), doi: "10.48550/arXiv.2001.01234" },
      { ...paper(2, title, "2021"), doi: "10.1000/journal" },
    ]);
    assert.isString(groups.get(1));
    assert.equal(groups.get(1), groups.get(2));
    const byArxiv = groupPaperWorks([
      { ...paper(1, title, "2020"), doi: "10.48550/arXiv.2001.01234" },
      {
        ...paper(2, "Another title", "2024"),
        doi: "10.1000/journal",
        extra: "arXiv: 2001.01234",
      },
    ]);
    assert.equal(byArxiv.get(1), byArxiv.get(2), "arXiv id is unconditional");
  });
});

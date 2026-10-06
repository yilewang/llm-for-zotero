/**
 * Characterizes the two per-paper retrieval loops that share
 * `src/services/retrieval/paperRetriever.ts`: the panel's
 * (`assembleRetrievedMultiPaperContext`) and the agent's
 * (`RetrievalService.retrieveEvidence`). Each keeps its own cache key, cache
 * bound, embedding timing, and per-paper options; these tests pin them.
 */
import { assert } from "chai";
import {
  assembleRetrievedMultiPaperContext,
  clearRetrievalCandidateCache,
} from "../src/modules/contextPanel/multiContextPlanner";
import { RetrievalService } from "../src/agent/services/retrievalService";
import {
  buildChunkMetadata,
  buildPaperKey,
} from "../src/services/paperContent/pdfContext";
import { pdfTextCache } from "../src/services/paperContent/contextCache";
import { paperTextStore } from "../src/services/paperContent/paperTextStore";
import { buildRetrievalQueryPlan } from "../src/services/retrieval/retrievalQueryPlan";
import { RETRIEVAL_TOP_K_PER_PAPER } from "../src/services/retrieval/constants";
import { invalidateRetrievalCandidates } from "../src/services/retrieval/cacheInvalidation";
import { tokenizeRetrievalText } from "../src/services/retrieval/retrievalTokenizer";
import { composeRetrievalCandidateInvalidation } from "./helpers/hostSurfaces";
import type { PaperContextRef } from "../src/shared/types";
import type {
  ChunkStat,
  PaperContextCandidate,
  PdfContext,
} from "../src/services/paperContent/types";

type Globals = typeof globalThis & { Zotero?: unknown; ztoolkit?: unknown };

const PREF_PREFIX = "extensions.zotero.llmforzotero.";

function buildPdfContext(
  title: string,
  chunks: string[],
  sourceType?: PdfContext["sourceType"],
): PdfContext {
  const docFreq: Record<string, number> = {};
  const chunkStats: ChunkStat[] = chunks.map((chunk, index) => {
    const tf: Record<string, number> = {};
    const terms = tokenizeRetrievalText(chunk);
    for (const term of terms) tf[term] = (tf[term] || 0) + 1;
    const uniqueTerms = Object.keys(tf);
    for (const term of uniqueTerms) docFreq[term] = (docFreq[term] || 0) + 1;
    return { index, length: terms.length, tf, uniqueTerms };
  });
  const avgChunkLength = chunkStats.length
    ? chunkStats.reduce((sum, chunk) => sum + chunk.length, 0) /
      chunkStats.length
    : 0;
  return {
    title,
    chunks,
    chunkMeta: buildChunkMetadata(chunks),
    chunkStats,
    docFreq,
    avgChunkLength,
    fullLength: chunks.join("\n\n").length,
    ...(sourceType ? { sourceType } : {}),
  };
}

function plannerEntry(paper: PaperContextRef, pdfContext: PdfContext) {
  return {
    order: 1,
    paperKey: buildPaperKey(paper),
    paperContext: paper,
    contextItem: null,
    pdfContext,
    isActive: false,
    pinKind: "none",
  } as any;
}

/** Fake embedding endpoint: records every input text it is asked to embed. */
function installFakeEmbeddings(prefs: Record<string, unknown>) {
  const embedded: string[][] = [];
  const toolkit = (globalThis as Globals).ztoolkit as Record<string, unknown>;
  toolkit.getGlobal = (name: string) =>
    name === "fetch"
      ? async (_url: string, init: { body: string }) => {
          const { input } = JSON.parse(init.body) as { input: string[] };
          embedded.push(input);
          return {
            ok: true,
            json: async () => ({
              data: input.map((_text, index) => ({
                index,
                embedding: [1, 0, 0],
              })),
            }),
          };
        }
      : undefined;
  const settings: Record<string, unknown> = {
    enableSemanticSearch: true,
    embeddingProvider: "custom",
    embeddingApiBase: "http://embeddings.test",
    embeddingModel: "fake-retriever-model",
  };
  for (const [key, value] of Object.entries(settings)) {
    prefs[`${PREF_PREFIX}${key}`] = value;
  }
  return {
    embedded,
    restore() {
      for (const key of Object.keys(settings)) {
        delete prefs[`${PREF_PREFIX}${key}`];
      }
      delete toolkit.getGlobal;
    },
  };
}

describe("per-paper retrieval callers", function () {
  let originalZotero: unknown;
  let originalZtoolkit: unknown;
  let prefs: Record<string, unknown>;

  before(function () {
    const globals = globalThis as Globals;
    originalZotero = globals.Zotero;
    originalZtoolkit = globals.ztoolkit;
  });

  beforeEach(function () {
    prefs = {};
    const globals = globalThis as Globals;
    globals.ztoolkit = { log: () => undefined };
    globals.Zotero = {
      Items: { get: () => null, getAll: () => [] },
      Collections: { get: () => null },
      Prefs: {
        get: (key: string) => prefs[key],
        set: (key: string, value: unknown) => {
          prefs[key] = value;
        },
      },
    } as unknown;
    clearRetrievalCandidateCache();
  });

  afterEach(function () {
    clearRetrievalCandidateCache();
    pdfTextCache.clear();
  });

  after(function () {
    const globals = globalThis as Globals;
    globals.Zotero = originalZotero;
    globals.ztoolkit = originalZtoolkit;
  });

  describe("panel (assembleRetrievedMultiPaperContext)", function () {
    const paper: PaperContextRef = {
      itemId: 9101,
      contextItemId: 9102,
      title: "Panel Cache Paper",
    };

    async function retrieve(
      pdfContext: PdfContext,
      question: string,
      lockedChunkIndexes?: number[],
    ) {
      return assembleRetrievedMultiPaperContext({
        papers: [plannerEntry(paper, pdfContext)],
        question,
        contextBudgetTokens: 20_000,
        minChunksByPaper: new Map(),
        options: {
          maxChunks: 40,
          ...(lockedChunkIndexes
            ? {
                lockedChunkIndexesByContextItem: new Map([
                  [paper.contextItemId, lockedChunkIndexes],
                ]),
              }
            : {}),
        },
      });
    }

    const FIRST = buildPdfContext("Panel Cache Paper", [
      "FIRST-SOURCE calibration drift is measured across sessions.",
    ]);
    const SECOND = buildPdfContext("Panel Cache Paper", [
      "SECOND-SOURCE calibration drift is measured across sessions.",
    ]);
    const THIRD = buildPdfContext("Panel Cache Paper", [
      "THIRD-SOURCE calibration drift is measured across sessions.",
    ]);

    it("answers a repeated question from the cache, keyed by paper and normalized query", async function () {
      const first = await retrieve(FIRST, "How is calibration drift measured?");
      assert.include(first.contextText, "FIRST-SOURCE");
      // Same paper key, same question up to case and punctuation: the second
      // read reuses the first read's candidates, not the new text.
      const repeated = await retrieve(
        SECOND,
        "how is CALIBRATION drift measured",
      );
      assert.include(repeated.contextText, "FIRST-SOURCE");
      assert.notInclude(repeated.contextText, "SECOND-SOURCE");
      // A different question misses.
      const other = await retrieve(SECOND, "Where is calibration drift?");
      assert.include(other.contextText, "SECOND-SOURCE");
    });

    it("bypasses the cache, for reads and writes, when the paper has locked chunks", async function () {
      const question = "How is calibration drift measured?";
      const locked = await retrieve(FIRST, question, [0]);
      assert.include(locked.contextText, "FIRST-SOURCE");
      // The locked read wrote nothing, so an unlocked read builds afresh.
      const unlocked = await retrieve(SECOND, question);
      assert.include(unlocked.contextText, "SECOND-SOURCE");
      // A locked read ignores the entry the unlocked read just stored.
      const lockedAgain = await retrieve(THIRD, question, [0]);
      assert.include(lockedAgain.contextText, "THIRD-SOURCE");
      // ...and still leaves that entry in place.
      const unlockedAgain = await retrieve(THIRD, question);
      assert.include(unlockedAgain.contextText, "SECOND-SOURCE");
    });

    it("embeds the query before the loop, even when every paper hits the cache", async function () {
      const fake = installFakeEmbeddings(prefs);
      try {
        const question = "How is calibration drift measured?";
        const semanticQuery = buildRetrievalQueryPlan({
          query: question,
        }).semanticQuery;
        const queryEmbeds = () =>
          fake.embedded.filter(
            (input) => input.length === 1 && input[0] === semanticQuery,
          ).length;
        await retrieve(FIRST, question);
        const afterFirst = queryEmbeds();
        assert.isAtLeast(afterFirst, 1);
        const repeated = await retrieve(SECOND, question);
        assert.include(repeated.contextText, "FIRST-SOURCE", "a cache hit");
        assert.equal(
          queryEmbeds(),
          afterFirst + 1,
          "the all-hit read still embedded the query once",
        );
      } finally {
        fake.restore();
      }
    });

    it("asks for RETRIEVAL_TOP_K_PER_PAPER candidates per paper", async function () {
      assert.equal(RETRIEVAL_TOP_K_PER_PAPER, 24);
      const chunks = Array.from(
        { length: 40 },
        (_, index) =>
          `Passage ${index}: calibration drift measured in session ${index}.`,
      );
      const result = await assembleRetrievedMultiPaperContext({
        papers: [plannerEntry(paper, buildPdfContext("Top K", chunks))],
        question: "calibration drift measured session",
        contextBudgetTokens: 200_000,
        minChunksByPaper: new Map([[buildPaperKey(paper), 40]]),
        options: { maxChunks: 40, minTotalChunks: 40 },
      });
      assert.equal(result.selectedChunkCount, RETRIEVAL_TOP_K_PER_PAPER);
    });

    it("keeps 300 entries and evicts the oldest first", async function () {
      this.timeout(30_000);
      const question = (index: number) => `calibration drift probe ${index}`;
      for (let index = 0; index < 301; index += 1) {
        await retrieve(FIRST, question(index));
      }
      // Entry 0 was evicted by entry 300; entry 1 survives.
      const evicted = await retrieve(SECOND, question(0));
      assert.include(evicted.contextText, "SECOND-SOURCE");
      const kept = await retrieve(SECOND, question(2));
      assert.include(kept.contextText, "FIRST-SOURCE");
    });

    it("drops one context item's entries through the invalidation bridge", async function () {
      const restore = composeRetrievalCandidateInvalidation();
      try {
        const question = "How is calibration drift measured?";
        const other: PaperContextRef = {
          itemId: 9103,
          contextItemId: 9104,
          title: "Other Paper",
        };
        const retrieveOther = (pdfContext: PdfContext) =>
          assembleRetrievedMultiPaperContext({
            papers: [plannerEntry(other, pdfContext)],
            question,
            contextBudgetTokens: 20_000,
            minChunksByPaper: new Map(),
            options: { maxChunks: 40 },
          });
        await retrieve(FIRST, question);
        await retrieveOther(FIRST);
        invalidateRetrievalCandidates(paper.contextItemId);
        const after = await retrieve(SECOND, question);
        assert.include(after.contextText, "SECOND-SOURCE");
        const untouched = await retrieveOther(SECOND);
        assert.include(untouched.contextText, "FIRST-SOURCE");
      } finally {
        restore();
      }
    });

    it("serves the old source's candidates after a source-mode switch", async function () {
      // pins current behaviour; suspected bug N10
      // A source-mode switch reloads the paper text but does not invalidate
      // retrieval candidates, and the panel key ignores the source, so the
      // panel keeps answering from the previous source's chunks.
      const restore = composeRetrievalCandidateInvalidation();
      try {
        const question = "How is calibration drift measured?";
        const item = { id: paper.contextItemId } as Zotero.Item;
        pdfTextCache.set(
          paper.contextItemId,
          buildPdfContext(
            "Panel Cache Paper",
            ["PDF-TEXT calibration drift is measured across sessions."],
            "zotero-worker",
          ),
        );
        const before = await retrieve(
          paperTextStore.peek(paper.contextItemId)!,
          question,
        );
        assert.include(before.contextText, "PDF-TEXT");
        await paperTextStore.load(item, { sourceMode: "mineru" }, async () => {
          paperTextStore.write(
            paper.contextItemId,
            buildPdfContext(
              "Panel Cache Paper",
              ["MINERU-TEXT calibration drift is measured across sessions."],
              "mineru",
            ),
          );
        });
        const reloaded = paperTextStore.peek(paper.contextItemId)!;
        assert.equal(reloaded.sourceType, "mineru", "the text did reload");
        const after = await retrieve(reloaded, question);
        assert.include(after.contextText, "PDF-TEXT");
        assert.notInclude(after.contextText, "MINERU-TEXT");
      } finally {
        restore();
      }
    });
  });

  describe("agent (RetrievalService.retrieveEvidence)", function () {
    const papers: PaperContextRef[] = [
      { itemId: 9201, contextItemId: 9202, title: "Agent Paper A" },
      { itemId: 9203, contextItemId: 9204, title: "Agent Paper B" },
    ];
    const sources = new Map<number, PdfContext>(
      papers.map((paper) => [
        paper.contextItemId,
        buildPdfContext(paper.title || "", [
          `${paper.title} measures calibration drift.`,
        ]),
      ]),
    );

    type BuilderCall = {
      paperContext: PaperContextRef;
      apiOverrides: Record<string, unknown> | undefined;
      options: Record<string, any> | undefined;
    };

    function buildService(onBuild?: (call: BuilderCall) => void) {
      const calls: BuilderCall[] = [];
      const service = new RetrievalService(
        {
          ensurePaperContext: async (paper: PaperContextRef) =>
            sources.get(paper.contextItemId),
        } as any,
        async (paperContext, _pdfContext, _question, apiOverrides, options) => {
          const call = {
            paperContext,
            apiOverrides: apiOverrides as Record<string, unknown> | undefined,
            options: options as Record<string, any> | undefined,
          };
          calls.push(call);
          onBuild?.(call);
          return [
            {
              paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
              itemId: paperContext.itemId,
              contextItemId: paperContext.contextItemId,
              title: paperContext.title || "",
              chunkIndex: 0,
              chunkText: `${paperContext.title} measures calibration drift.`,
              estimatedTokens: 6,
              bm25Score: 1,
              embeddingScore: 0,
              hybridScore: paperContext.itemId / 10_000,
              evidenceScore: 1,
            } as PaperContextCandidate,
          ];
        },
      );
      return { service, calls };
    }

    it("answers a repeated question from the instance cache", async function () {
      const { service, calls } = buildService();
      const question = "How is calibration drift measured?";
      const first = await service.retrieveEvidence({ papers, question });
      assert.lengthOf(calls, 2);
      const repeated = await service.retrieveEvidence({ papers, question });
      assert.lengthOf(calls, 2, "no candidate pass for a repeated question");
      assert.deepEqual(repeated, first);
      await service.retrieveEvidence({
        papers,
        question: "How is calibration drift MEASURED?",
      });
      assert.lengthOf(calls, 4, "the agent key keeps the full query identity");
      service.clearEvidenceCache();
      await service.retrieveEvidence({ papers, question });
      assert.lengthOf(calls, 6);
    });

    it("never bounds the cache", async function () {
      this.timeout(30_000);
      const { service, calls } = buildService();
      const one = [papers[0]];
      for (let index = 0; index < 302; index += 1) {
        await service.retrieveEvidence({
          papers: one,
          question: `calibration drift probe ${index}`,
        });
      }
      assert.lengthOf(calls, 302);
      await service.retrieveEvidence({
        papers: one,
        question: "calibration drift probe 0",
      });
      assert.lengthOf(calls, 302, "the oldest entry is still cached");
    });

    it("embeds the query lazily: once per read, and never for an all-hit read", async function () {
      const fake = installFakeEmbeddings(prefs);
      try {
        const { service, calls } = buildService();
        const question = "How is calibration drift measured?";
        await service.retrieveEvidence({ papers, question });
        assert.lengthOf(fake.embedded, 1, "one query embedding for two misses");
        assert.deepEqual(
          calls[0].options?.precomputedQueryEmbedding,
          [1, 0, 0],
        );
        assert.deepEqual(
          calls[1].options?.precomputedQueryEmbedding,
          [1, 0, 0],
        );
        await service.retrieveEvidence({ papers, question });
        assert.lengthOf(fake.embedded, 1, "an all-hit read embeds nothing");
        // One hit and one miss: the miss pays for the embedding.
        await service.retrieveEvidence({
          papers: [papers[0], { ...papers[1], contextItemId: 9299 }],
          question,
        });
        assert.lengthOf(fake.embedded, 2);
      } finally {
        fake.restore();
      }
    });

    it("skips the embedding when semantic search is off", async function () {
      const { service, calls } = buildService();
      await service.retrieveEvidence({
        papers,
        question: "How is calibration drift measured?",
      });
      assert.isUndefined(calls[0].options?.precomputedQueryEmbedding);
    });

    it("asks for 4 evidence candidates per paper with quote anchors off", async function () {
      const { service, calls } = buildService();
      await service.retrieveEvidence({
        papers,
        question: "How is calibration drift measured?",
      });
      for (const call of calls) {
        assert.equal(call.options?.topK, 4);
        assert.equal(call.options?.mode, "evidence");
        assert.equal(call.options?.queryPlan?.quoteAnchorPolicy, "none");
        assert.notProperty(call.options || {}, "sectionIds");
        assert.notProperty(call.apiOverrides || {}, "sectionIds");
        assert.notProperty(call.options || {}, "preferredChunkIndexes");
      }
    });

    it("passes per-paper section ids to both builder arguments and keys on them", async function () {
      const { service, calls } = buildService();
      const question = "How is calibration drift measured?";
      await service.retrieveEvidence({
        papers,
        question,
        sectionIds: ["s1"],
        sectionIdsByPaper: new Map([[papers[1].contextItemId, ["s2", "s3"]]]),
        perPaperTopK: 2,
      });
      assert.deepEqual(calls[0].options?.sectionIds, ["s1"]);
      assert.deepEqual(calls[0].apiOverrides?.sectionIds, ["s1"]);
      assert.deepEqual(calls[1].options?.sectionIds, ["s2", "s3"]);
      assert.deepEqual(calls[1].apiOverrides?.sectionIds, ["s2", "s3"]);
      assert.equal(calls[0].options?.topK, 2);
      await service.retrieveEvidence({
        papers,
        question,
        sectionIds: ["s1"],
        perPaperTopK: 2,
      });
      assert.lengthOf(calls, 3, "only the paper whose sections changed misses");
      assert.equal(calls[2].paperContext.contextItemId, 9204);
    });

    it("propagates a candidate failure and caches nothing for that paper", async function () {
      let fail = true;
      const { service, calls } = buildService((call) => {
        if (fail && call.paperContext.contextItemId === 9204) {
          throw new Error("candidate pass failed");
        }
      });
      const question = "How is calibration drift measured?";
      let error: unknown;
      try {
        await service.retrieveEvidence({ papers, question });
      } catch (caught) {
        error = caught;
      }
      assert.instanceOf(error, Error);
      assert.lengthOf(calls, 2);
      fail = false;
      await service.retrieveEvidence({ papers, question });
      assert.lengthOf(calls, 3, "paper A was cached, paper B was not");
      assert.equal(calls[2].paperContext.contextItemId, 9204);
    });
  });
});

import { assert } from "chai";
import {
  retrievePerPaper,
  type PaperCandidateBuilder,
  type PaperRetrievalTarget,
} from "../src/services/retrieval/paperRetriever";
import type {
  PaperContextCandidate,
  PdfContext,
} from "../src/services/paperContent/types";

function target(id: number): PaperRetrievalTarget & { label: string } {
  return {
    paperContext: { itemId: id, contextItemId: id * 10, title: `P${id}` },
    pdfContext: { title: `P${id}` } as PdfContext,
    label: `paper-${id}`,
  };
}

function candidate(id: number, chunkIndex: number): PaperContextCandidate {
  return {
    paperKey: `${id}:${id * 10}`,
    itemId: id,
    contextItemId: id * 10,
    title: `P${id}`,
    chunkIndex,
    chunkText: `P${id} chunk ${chunkIndex}`,
    estimatedTokens: 3,
    bm25Score: 1,
    embeddingScore: 0,
    hybridScore: 1,
    evidenceScore: 1,
  };
}

function recordingBuilder(fail?: (itemId: number) => boolean) {
  const calls: unknown[][] = [];
  const builder = (async (...args: unknown[]) => {
    calls.push(args);
    const paper = args[0] as { itemId: number };
    if (fail?.(paper.itemId)) throw new Error(`build ${paper.itemId} failed`);
    return [candidate(paper.itemId, 0), candidate(paper.itemId, 1)];
  }) as PaperCandidateBuilder;
  return { builder, calls };
}

function mapCache<Entry>() {
  const store = new Map<string, Entry[]>();
  return {
    store,
    get: (key: string) => store.get(key),
    set: (key: string, entries: Entry[]) => {
      store.set(key, entries);
    },
  };
}

describe("retrievePerPaper", function () {
  it("returns projected entries in paper order and caches them per key", async function () {
    const { builder, calls } = recordingBuilder();
    const cache = mapCache<string>();
    const run = () =>
      retrievePerPaper({
        targets: [target(2), target(1)],
        question: "q",
        cache: { keyFor: (t) => t.label, get: cache.get, set: cache.set },
        resolveQueryEmbedding: async () => undefined,
        builderArguments: () => ({ options: { topK: 3 } }),
        project: (t, candidates) =>
          candidates.map((c) => `${t.label}#${c.chunkIndex}`),
        candidateBuilder: builder,
      });
    const first = await run();
    assert.deepEqual(first, [
      "paper-2#0",
      "paper-2#1",
      "paper-1#0",
      "paper-1#1",
    ]);
    assert.lengthOf(calls, 2);
    assert.deepEqual(cache.store.get("paper-1"), ["paper-1#0", "paper-1#1"]);
    assert.deepEqual(await run(), first);
    assert.lengthOf(calls, 2, "the second run is all hits");
  });

  it("treats a cached empty list as a hit", async function () {
    const { builder, calls } = recordingBuilder();
    const cache = mapCache<PaperContextCandidate>();
    cache.store.set("k", []);
    const entries = await retrievePerPaper({
      targets: [target(1)],
      question: "q",
      cache: { keyFor: () => "k", get: cache.get, set: cache.set },
      resolveQueryEmbedding: async () => undefined,
      builderArguments: () => ({ options: {} }),
      project: (_t, candidates) => candidates,
      candidateBuilder: builder,
    });
    assert.deepEqual(entries, []);
    assert.lengthOf(calls, 0);
  });

  it("neither reads nor stores when the policy returns no key", async function () {
    const { builder, calls } = recordingBuilder();
    let reads = 0;
    let writes = 0;
    await retrievePerPaper({
      targets: [target(1), target(2)],
      question: "q",
      cache: {
        keyFor: (t) => (t.paperContext.itemId === 1 ? undefined : "k2"),
        get: () => {
          reads += 1;
          return undefined;
        },
        set: () => {
          writes += 1;
        },
      },
      resolveQueryEmbedding: async () => undefined,
      builderArguments: () => ({ options: {} }),
      project: (_t, candidates) => candidates,
      candidateBuilder: builder,
    });
    assert.lengthOf(calls, 2);
    assert.equal(reads, 1, "only the keyed paper was looked up");
    assert.equal(writes, 1, "only the keyed paper was stored");
  });

  it("resolves the query embedding once, on the first miss only", async function () {
    const { builder } = recordingBuilder();
    const cache = mapCache<PaperContextCandidate>();
    let resolutions = 0;
    const seen: Array<number[] | undefined> = [];
    const run = () =>
      retrievePerPaper({
        targets: [target(1), target(2), target(3)],
        question: "q",
        cache: {
          keyFor: (t) => t.label,
          get: cache.get,
          set: cache.set,
        },
        resolveQueryEmbedding: async () => {
          resolutions += 1;
          return [0.5, 0.5];
        },
        builderArguments: (_t, embedding) => {
          seen.push(embedding);
          return { options: { precomputedQueryEmbedding: embedding } };
        },
        project: (_t, candidates) => candidates,
        candidateBuilder: builder,
      });
    await run();
    assert.equal(resolutions, 1);
    assert.deepEqual(seen, [
      [0.5, 0.5],
      [0.5, 0.5],
      [0.5, 0.5],
    ]);
    await run();
    assert.equal(resolutions, 1, "an all-hit run never resolves it");
  });

  it("passes options as the fourth argument, or after apiOverrides as the fifth", async function () {
    const { builder, calls } = recordingBuilder();
    const cache = mapCache<PaperContextCandidate>();
    await retrievePerPaper({
      targets: [target(1), target(2)],
      question: "the question",
      cache: { keyFor: () => undefined, get: cache.get, set: cache.set },
      resolveQueryEmbedding: async () => undefined,
      builderArguments: (t) =>
        t.paperContext.itemId === 1
          ? { options: { topK: 24, mode: "evidence" } }
          : {
              apiOverrides: { apiBase: "http://api.test" },
              options: { topK: 4, mode: "evidence" },
            },
      project: (_t, candidates) => candidates,
      candidateBuilder: builder,
    });
    const first = target(1);
    assert.deepEqual(calls[0], [
      first.paperContext,
      first.pdfContext,
      "the question",
      { topK: 24, mode: "evidence" },
    ]);
    assert.lengthOf(calls[1], 5);
    assert.deepEqual(calls[1][3], { apiBase: "http://api.test" });
    assert.deepEqual(calls[1][4], { topK: 4, mode: "evidence" });
  });

  it("propagates a builder failure after caching the papers before it", async function () {
    const { builder } = recordingBuilder((itemId) => itemId === 2);
    const cache = mapCache<PaperContextCandidate>();
    let error: unknown;
    try {
      await retrievePerPaper({
        targets: [target(1), target(2), target(3)],
        question: "q",
        cache: { keyFor: (t) => t.label, get: cache.get, set: cache.set },
        resolveQueryEmbedding: async () => undefined,
        builderArguments: () => ({ options: {} }),
        project: (_t, candidates) => candidates,
        candidateBuilder: builder,
      });
    } catch (caught) {
      error = caught;
    }
    assert.match(String(error), /build 2 failed/);
    assert.deepEqual([...cache.store.keys()], ["paper-1"]);
  });
});

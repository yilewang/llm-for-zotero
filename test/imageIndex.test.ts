import { assert } from "chai";
import {
  createImageIndex,
  type ImageIndexDeps,
} from "../src/services/paperContent/imageIndex";
import {
  IMAGE_EXTRACTION_ALGORITHM_VERSION,
  IMAGE_MANIFEST_VERSION,
  type EmbeddedImageManifest,
} from "../src/services/retrieval/imageStore";
import type { PdfContext } from "../src/services/paperContent/types";
import type { MultimodalItem } from "../src/utils/embedding/types";

const PNG = "data:image/png;base64,AAAA";

function context(): PdfContext {
  return {
    title: "t",
    chunks: ["a", "b"],
    chunkMeta: [],
    chunkStats: [],
    docFreq: {},
    avgChunkLength: 0,
    fullLength: 0,
  };
}

function candidate(pageIndex: number, hash: string) {
  return {
    source: "embedded" as const,
    pageIndex,
    rect: [0, 0, 10, 10] as [number, number, number, number],
    width: 300,
    height: 200,
    contentHash: hash,
    dataUrl: PNG,
  };
}

function mineruCandidate(pageIndex: number, hash: string) {
  return {
    source: "mineru" as const,
    pageIndex,
    contentHash: hash,
    dataUrl: PNG,
    label: "Figure 1",
  };
}

function freshManifest(pdfFingerprint: string): EmbeddedImageManifest {
  return {
    version: IMAGE_MANIFEST_VERSION,
    algorithmVersion: IMAGE_EXTRACTION_ALGORITHM_VERSION,
    pdfFingerprint,
    images: [],
  };
}

function makeDeps(overrides: Partial<ImageIndexDeps> = {}) {
  const store = {
    manifest: null as EmbeddedImageManifest | null,
    files: new Map<string, Uint8Array>(),
    vectors: null as {
      cacheKey: string;
      imageIds: string[];
      vectors: number[][];
    } | null,
  };
  const calls = {
    extract: 0,
    embed: [] as MultimodalItem[][],
    useMineru: [] as boolean[],
  };
  const deps: ImageIndexDeps = {
    isEnabled: () => true,
    getEmbeddingKeys: () => ({ cacheKey: "key-1", attemptKey: "attempt-1" }),
    resolveSource: async (_attachmentId, useMineru) => {
      calls.useMineru.push(useMineru);
      return {
        kind: useMineru ? "mineru" : "pdf",
        fingerprint: useMineru ? "mineru:abc" : "pdf:100:5",
        collect: async () => {
          calls.extract += 1;
          return useMineru
            ? [mineruCandidate(1, "h1"), mineruCandidate(3, "h2")]
            : [candidate(1, "h1"), candidate(3, "h2")];
        },
      };
    },
    compress: async (dataUrl) => dataUrl,
    loadManifest: async () => store.manifest,
    saveManifest: async (_id, manifest) => {
      store.manifest = manifest;
    },
    writeImage: async (_id, fileName, bytes) => {
      store.files.set(fileName, bytes);
    },
    readImage: async (_id, fileName) => store.files.get(fileName) ?? null,
    loadVectors: async (_id, cacheKey, imageIds) =>
      store.vectors &&
      store.vectors.cacheKey === cacheKey &&
      store.vectors.imageIds.join() === imageIds.join()
        ? store.vectors.vectors
        : null,
    saveVectors: async (_id, data) => {
      store.vectors = data;
    },
    embed: async (items) => {
      calls.embed.push(items);
      return items.map((_, index) => [index + 1, 0]);
    },
    ...overrides,
  };
  return { deps, store, calls };
}

describe("image index", function () {
  it("does nothing while image embedding is off", async function () {
    const { deps, calls } = makeDeps({ isEnabled: () => false });
    const index = createImageIndex(deps);
    const ctx = context();
    index.startExtraction(ctx, 7);
    assert.isUndefined(ctx.imageIndex);
    assert.isNull(await index.ensureImageVectors(ctx, 7));
    assert.equal(calls.extract, 0);
  });

  it("extracts, stores files and writes a manifest", async function () {
    const { deps, store } = makeDeps();
    const records = await createImageIndex(deps).ensureImageSet(context(), 7);
    assert.deepEqual(
      records!.map((record) => [
        record.imageId,
        record.pageIndex,
        record.source,
      ]),
      [
        ["h1", 1, "embedded"],
        ["h2", 3, "embedded"],
      ],
    );
    assert.equal(store.manifest?.pdfFingerprint, "pdf:100:5");
    assert.equal(store.files.size, 2);
  });

  it("reuses a fresh manifest without extracting again", async function () {
    const { deps, store, calls } = makeDeps();
    store.manifest = freshManifest("pdf:100:5");
    await createImageIndex(deps).ensureImageSet(context(), 7);
    assert.equal(calls.extract, 0);
  });

  it("re-extracts when the PDF changed", async function () {
    const { deps, store, calls } = makeDeps();
    store.manifest = freshManifest("old");
    await createImageIndex(deps).ensureImageSet(context(), 7);
    assert.equal(calls.extract, 1);
  });

  it("embeds missing image vectors once and caches them", async function () {
    const { deps, store, calls } = makeDeps();
    const index = createImageIndex(deps);
    const ctx = context();
    const first = await index.ensureImageVectors(ctx, 7);
    assert.deepEqual(first!.vectors, [
      [1, 0],
      [2, 0],
    ]);
    assert.lengthOf(calls.embed, 1);
    assert.isTrue(calls.embed[0].every((item) => item.kind === "image"));
    assert.equal(store.vectors?.cacheKey, "key-1");
    await index.ensureImageVectors(ctx, 7);
    assert.lengthOf(calls.embed, 1);
  });

  it("loads cached vectors from disk instead of embedding", async function () {
    const { deps, store, calls } = makeDeps();
    store.vectors = {
      cacheKey: "key-1",
      imageIds: ["h1", "h2"],
      vectors: [[9], [8]],
    };
    const result = await createImageIndex(deps).ensureImageVectors(
      context(),
      7,
    );
    assert.deepEqual(result!.vectors, [[9], [8]]);
    assert.lengthOf(calls.embed, 0);
  });

  it("marks a failure and does not retry under the same attempt key", async function () {
    let attempts = 0;
    const { deps } = makeDeps({
      embed: async () => {
        attempts += 1;
        throw new Error("boom");
      },
    });
    const index = createImageIndex(deps);
    const ctx = context();
    assert.isNull(await index.ensureImageVectors(ctx, 7));
    assert.isNull(await index.ensureImageVectors(ctx, 7));
    assert.equal(attempts, 1);
  });

  it("hands pending images to a joint call and stores their vectors", async function () {
    const { deps, store } = makeDeps();
    const index = createImageIndex(deps);
    const ctx = context();
    const pending = await index.pendingImageInputs(ctx, 7);
    assert.lengthOf(pending, 2);
    assert.match(
      (pending[0].item as { dataUrl: string }).dataUrl,
      /^data:image\/png;base64,/,
    );
    await index.storeImageVectors(ctx, 7, pending, [[5], [6]]);
    assert.deepEqual(store.vectors?.vectors, [[5], [6]]);
    assert.lengthOf(await index.pendingImageInputs(ctx, 7), 0);
  });

  it("extracts again when a cached image file is missing", async function () {
    const { deps, store, calls } = makeDeps();
    const index = createImageIndex(deps);
    await index.ensureImageSet(context(), 7);
    store.files.clear();
    const result = await index.ensureImageVectors(context(), 7);
    assert.equal(calls.extract, 2);
    assert.lengthOf(result!.records, 2);
    assert.lengthOf(result!.vectors, 2);
  });

  it("returns no pending images when the paper has no image source", async function () {
    const { deps } = makeDeps({ resolveSource: async () => null });
    assert.lengthOf(
      await createImageIndex(deps).pendingImageInputs(context(), 7),
      0,
    );
  });

  it("asks for MinerU figures only for a MinerU-backed context", async function () {
    const { deps, calls } = makeDeps();
    const index = createImageIndex(deps);
    await index.ensureImageSet(context(), 7);
    const mineruContext = { ...context(), sourceType: "mineru" as const };
    const records = await index.ensureImageSet(mineruContext, 7);
    assert.deepEqual(calls.useMineru, [false, true]);
    assert.equal(records![0].source, "mineru");
    assert.equal(records![0].label, "Figure 1");
    assert.isUndefined(records![0].rect);
  });
});

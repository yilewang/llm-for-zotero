import { assert } from "chai";
import type { PaperContextRef } from "../src/modules/contextPanel/types";
import type {
  PaperContextCandidate,
  PdfContext,
} from "../src/services/paperContent/types";
import {
  RetrievalService,
  type RetrievalImageDeps,
} from "../src/agent/services/retrievalService";

const paper: PaperContextRef = {
  itemId: 1,
  contextItemId: 11,
  title: "Dynamics",
  firstCreator: "Hoffmann",
  year: "2026",
};

const pdfContext = {
  title: "Dynamics",
  chunks: ["a"],
  chunkMeta: [],
  chunkStats: [],
  docFreq: {},
  avgChunkLength: 0,
  fullLength: 0,
} as PdfContext;

function candidate(
  chunkIndex: number,
  page: number,
  embeddingScore: number,
  text = "text",
): PaperContextCandidate {
  return {
    paperKey: "1:11",
    itemId: 1,
    contextItemId: 11,
    title: "Dynamics",
    chunkIndex,
    chunkText: text,
    pageStart: page,
    pageEnd: page,
    estimatedTokens: 5,
    bm25Score: 1,
    embeddingScore,
    hybridScore: 1 - chunkIndex * 0.1,
    evidenceScore: 1 - chunkIndex * 0.1,
  };
}

function record(imageId: string, pageIndex: number, label?: string) {
  return {
    imageId,
    pageIndex,
    rect: [0, 0, 1, 1] as [number, number, number, number],
    width: 300,
    height: 200,
    fileName: `${imageId}.png`,
    mimeType: "image/png",
    source: "vector" as const,
    ...(label ? { label, caption: `${label}: x` } : {}),
  };
}

function imageDeps(
  overrides: Partial<RetrievalImageDeps> = {},
): RetrievalImageDeps {
  return {
    isImageEmbeddingEnabled: () => true,
    readSettings: () => ({
      textTopK: 4,
      imageTopK: 2,
      imageOutstandingPercent: 80,
    }),
    loadImageVectors: async () => ({
      records: [record("near", 5, "Figure 1"), record("far", 40)],
      vectors: [
        [0.9, Math.sqrt(1 - 0.81)],
        [0.1, Math.sqrt(1 - 0.01)],
      ],
    }),
    embedQuery: async () => [1, 0],
    imagePath: (attachmentId, fileName) =>
      `C:/cache/${attachmentId}/${fileName}`,
    ...overrides,
  };
}

function service(
  deps: RetrievalImageDeps,
  candidates = [candidate(0, 4, 0.6), candidate(1, 20, 0.5)],
) {
  return new RetrievalService(
    { ensurePaperContext: async () => pdfContext } as any,
    async () => candidates,
    deps,
  );
}

describe("RetrievalService images", function () {
  it("returns images selected against the hit chunks", async function () {
    const { results, images } = await service(
      imageDeps(),
    ).retrieveEvidenceWithImages({
      papers: [paper],
      question: "loss curve",
      includeImages: true,
    });
    assert.lengthOf(results, 2);
    assert.deepEqual(
      images.map((entry) => [entry.imageId, entry.why]),
      [["near", "page_window"]],
    );
    assert.equal(images[0].imagePath, "C:/cache/11/near.png");
    assert.equal(images[0].label, "Figure 1");
    assert.equal(images[0].pageIndex, 5);
    assert.equal(images[0].source, "vector");
  });

  it("keeps the outstanding rule working on a cached evidence read", async function () {
    const deps = imageDeps({
      loadImageVectors: async () => ({
        records: [record("far", 40)],
        vectors: [[0.8, 0.6]],
      }),
    });
    const retrieval = service(deps);
    const params = { papers: [paper], question: "q", includeImages: true };
    const first = await retrieval.retrieveEvidenceWithImages(params);
    const second = await retrieval.retrieveEvidenceWithImages(params);
    assert.deepEqual(
      first.images.map((entry) => entry.why),
      ["outstanding"],
    );
    assert.deepEqual(
      second.images.map((entry) => entry.why),
      ["outstanding"],
    );
  });

  it("returns no images when includeImages is false or image embedding is off", async function () {
    for (const [deps, includeImages] of [
      [imageDeps(), false],
      [imageDeps({ isImageEmbeddingEnabled: () => false }), true],
      [
        imageDeps({
          readSettings: () => ({
            textTopK: 4,
            imageTopK: 0,
            imageOutstandingPercent: 80,
          }),
        }),
        true,
      ],
    ] as const) {
      const { images } = await service(deps).retrieveEvidenceWithImages({
        papers: [paper],
        question: "q",
        includeImages,
      });
      assert.lengthOf(images, 0);
    }
  });

  it("keeps the text results identical to retrieveEvidence", async function () {
    const deps = imageDeps();
    const plain = await service(deps).retrieveEvidence({
      papers: [paper],
      question: "q",
    });
    const withImages = await service(deps).retrieveEvidenceWithImages({
      papers: [paper],
      question: "q",
      includeImages: true,
    });
    assert.deepEqual(withImages.results, plain);
  });

  it("uses the text top-K setting as the default per-paper count", async function () {
    let seenTopK: number | undefined;
    const retrieval = new RetrievalService(
      { ensurePaperContext: async () => pdfContext } as any,
      async (_p, _c, _q, _a, options) => {
        seenTopK = options?.topK;
        return [];
      },
      imageDeps({
        readSettings: () => ({
          textTopK: 7,
          imageTopK: 2,
          imageOutstandingPercent: 80,
        }),
      }),
    );
    await retrieval.retrieveEvidence({ papers: [paper], question: "q" });
    assert.equal(seenTopK, 7);
    await retrieval.retrieveEvidence({
      papers: [paper],
      question: "q2",
      perPaperTopK: 3,
    });
    assert.equal(seenTopK, 3);
  });

  it("returns no images when the image index is unavailable", async function () {
    const { images } = await service(
      imageDeps({ loadImageVectors: async () => null }),
    ).retrieveEvidenceWithImages({
      papers: [paper],
      question: "q",
      includeImages: true,
    });
    assert.lengthOf(images, 0);
  });
});

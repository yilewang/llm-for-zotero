import { assert } from "chai";
import {
  computeSectionPageSpans,
  selectRetrievalImages,
  type HitChunk,
} from "../src/services/retrieval/imageSelection";

const query = [1, 0];
/** Vector whose cosine with `query` is exactly `score` (0 ≤ score ≤ 1). */
const withScore = (score: number) => [score, Math.sqrt(1 - score * score)];

const image = (
  imageId: string,
  pageIndex: number,
  score: number,
  label?: string,
) => ({
  imageId,
  pageIndex,
  vector: withScore(score),
  ...(label ? { label } : {}),
});

const chunk = (overrides: Partial<HitChunk> = {}): HitChunk => ({
  text: "body text",
  pageStart: 10,
  pageEnd: 10,
  embeddingScore: 0.5,
  ...overrides,
});

const base = { queryEmbedding: query, topK: 5, outstandingPercent: 80 };

describe("image selection", function () {
  it("selects images within two pages of a hit chunk", function () {
    const picked = selectRetrievalImages({
      ...base,
      outstandingPercent: 0,
      images: [
        image("p8", 8, 0.1),
        image("p12", 12, 0.1),
        image("p7", 7, 0.1),
        image("p13", 13, 0.1),
      ],
      hitChunks: [chunk()],
    });
    assert.deepEqual(picked.map((entry) => entry.image.imageId).sort(), [
      "p12",
      "p8",
    ]);
    assert.isTrue(picked.every((entry) => entry.why === "page_window"));
  });

  it("uses the chunk's page span, not just its first page", function () {
    const picked = selectRetrievalImages({
      ...base,
      outstandingPercent: 0,
      images: [image("p16", 16, 0.1)],
      hitChunks: [chunk({ pageStart: 10, pageEnd: 14 })],
    });
    assert.lengthOf(picked, 1);
  });

  it("skips the page rule for chunks without pages", function () {
    const picked = selectRetrievalImages({
      ...base,
      outstandingPercent: 0,
      images: [image("p10", 10, 0.1)],
      hitChunks: [chunk({ pageStart: undefined, pageEnd: undefined })],
    });
    assert.lengthOf(picked, 0);
  });

  it("selects a labelled figure mentioned by a hit chunk at any distance", function () {
    const picked = selectRetrievalImages({
      ...base,
      outstandingPercent: 0,
      images: [image("fig3", 40, 0.1, "Figure 3")],
      hitChunks: [chunk({ text: "As shown in Fig. 3, the loss drops." })],
    });
    assert.deepEqual(
      picked.map((entry) => entry.why),
      ["figure_label"],
    );
  });

  it("selects an outstanding image at exactly the threshold", function () {
    // min hit-chunk similarity 0.5 × 80% = 0.4
    const picked = selectRetrievalImages({
      ...base,
      images: [image("at", 90, 0.4), image("below", 91, 0.39)],
      hitChunks: [
        chunk({ embeddingScore: 0.5 }),
        chunk({ embeddingScore: 0.9 }),
      ],
    });
    assert.deepEqual(
      picked.map((entry) => [entry.image.imageId, entry.why]),
      [["at", "outstanding"]],
    );
  });

  it("disables the outstanding rule without text similarity or at 0%", function () {
    const images = [image("far", 90, 0.99)];
    for (const hitChunks of [
      [chunk({ embeddingScore: 0 })],
      [chunk({ embeddingScore: undefined })],
      [chunk({ embeddingScore: -0.2 })],
    ]) {
      assert.lengthOf(selectRetrievalImages({ ...base, images, hitChunks }), 0);
    }
    assert.lengthOf(
      selectRetrievalImages({
        ...base,
        outstandingPercent: 0,
        images,
        hitChunks: [chunk()],
      }),
      0,
    );
  });

  it("records the strongest reason and ranks by similarity", function () {
    const picked = selectRetrievalImages({
      ...base,
      images: [image("both", 11, 0.3, "Figure 2"), image("page", 9, 0.6)],
      hitChunks: [chunk({ text: "see Figure 2" })],
    });
    assert.deepEqual(
      picked.map((entry) => [entry.image.imageId, entry.why]),
      [
        ["page", "page_window"],
        ["both", "figure_label"],
      ],
    );
  });

  it("returns at most topK images and nothing for topK 0", function () {
    const images = [
      image("a", 10, 0.9),
      image("b", 10, 0.8),
      image("c", 10, 0.7),
    ];
    const picked = selectRetrievalImages({
      ...base,
      topK: 2,
      images,
      hitChunks: [chunk()],
    });
    assert.deepEqual(
      picked.map((entry) => entry.image.imageId),
      ["a", "b"],
    );
    assert.lengthOf(
      selectRetrievalImages({ ...base, topK: 0, images, hitChunks: [chunk()] }),
      0,
    );
  });
});

describe("MinerU section page spans", function () {
  it("spans from a section's page to the next section's page", function () {
    const spans = computeSectionPageSpans(
      [{ sectionIndex: 0 }, { sectionIndex: 1 }, { sectionIndex: 2 }, {}],
      [{ page: 0 }, { page: 3 }, { page: 7 }],
      12,
    );
    assert.deepEqual(spans, [
      { start: 0, end: 3 },
      { start: 3, end: 7 },
      { start: 7, end: 11 },
      undefined,
    ]);
  });

  it("skips sections without pages when looking for the next one", function () {
    const spans = computeSectionPageSpans(
      [{ sectionIndex: 0 }],
      [{ page: 2 }, {}, { page: 6 }],
      undefined,
    );
    assert.deepEqual(spans, [{ start: 2, end: 6 }]);
  });

  it("ends the last section at its own page when the page count is unknown", function () {
    assert.deepEqual(
      computeSectionPageSpans([{ sectionIndex: 0 }], [{ page: 4 }], undefined),
      [{ start: 4, end: 4 }],
    );
  });
});

import { assert } from "chai";
import { planEmbeddingBatches } from "../src/utils/embedding/batching";
import type { MultimodalItem } from "../src/utils/embedding/types";

const text = (value: string): MultimodalItem => ({ kind: "text", text: value });
const image = (id: string): MultimodalItem => ({
  kind: "image",
  dataUrl: `data:image/png;base64,${id}`,
});

describe("embedding batch planner", function () {
  it("returns no batches for no input", function () {
    assert.deepEqual(
      planEmbeddingBatches([], { maxItems: 16, maxImages: 4 }),
      [],
    );
  });

  it("splits text inputs by the item limit", function () {
    const items = Array.from({ length: 20 }, (_, i) => text(`t${i}`));
    const batches = planEmbeddingBatches(items, { maxItems: 16, maxImages: 4 });
    assert.deepEqual(batches, [
      Array.from({ length: 16 }, (_, i) => i),
      [16, 17, 18, 19],
    ]);
  });

  it("starts a new batch when the image limit is reached", function () {
    const items = [text("a"), image("1"), image("2"), text("b"), image("3")];
    const batches = planEmbeddingBatches(items, { maxItems: 16, maxImages: 2 });
    assert.deepEqual(batches, [[0, 1, 2, 3], [4]]);
  });

  it("puts every input in its own batch when maxItems is 1", function () {
    const items = [text("a"), image("1"), text("b")];
    assert.deepEqual(
      planEmbeddingBatches(items, { maxItems: 1, maxImages: 1 }),
      [[0], [1], [2]],
    );
  });

  it("treats non-positive limits as 1", function () {
    const items = [text("a"), text("b")];
    assert.deepEqual(
      planEmbeddingBatches(items, { maxItems: 0, maxImages: 0 }),
      [[0], [1]],
    );
  });
});

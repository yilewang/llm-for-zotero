import { assert } from "chai";
import {
  IMAGE_EXTRACTION_ALGORITHM_VERSION,
  IMAGE_MANIFEST_VERSION,
  IMAGE_VECTORS_VERSION,
  parseImageManifest,
  parseImageVectors,
} from "../src/services/retrieval/imageStore";

const record = {
  imageId: "300x200-abcd1234",
  pageIndex: 2,
  rect: [0, 0, 10, 10],
  width: 300,
  height: 200,
  fileName: "300x200-abcd1234.png",
  mimeType: "image/png",
};

function manifest(images: unknown[]) {
  return JSON.stringify({
    version: IMAGE_MANIFEST_VERSION,
    algorithmVersion: IMAGE_EXTRACTION_ALGORITHM_VERSION,
    pdfFingerprint: "123:456",
    images,
  });
}

describe("embedded image store", function () {
  it("accepts a well-formed manifest with both sources", function () {
    const images = [
      { ...record, label: "Figure 1", caption: "Figure 1: x" },
      { ...record, imageId: "v-1", fileName: "v-1.png", source: "vector" },
    ];
    assert.deepEqual(parseImageManifest(manifest(images))?.images, images);
  });

  it("rejects manifests with a wrong version or broken records", function () {
    assert.isNull(parseImageManifest("{"));
    assert.isNull(
      parseImageManifest(
        JSON.stringify({
          version: 99,
          algorithmVersion: IMAGE_EXTRACTION_ALGORITHM_VERSION,
          pdfFingerprint: "x",
          images: [],
        }),
      ),
    );
    assert.isNull(
      parseImageManifest(manifest([{ ...record, pageIndex: "2" }])),
    );
    assert.isNull(
      parseImageManifest(manifest([{ ...record, rect: [0, 0, 1] }])),
    );
  });

  it("rejects an unknown image source", function () {
    assert.isNull(
      parseImageManifest(manifest([{ ...record, source: "scan" }])),
    );
  });

  it("accepts vectors aligned with image ids", function () {
    const data = {
      version: IMAGE_VECTORS_VERSION,
      cacheKey: "custom:https://x:m",
      imageIds: ["a", "b"],
      vectors: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    };
    assert.deepEqual(parseImageVectors(JSON.stringify(data)), data);
  });

  it("rejects vectors whose count or dimensions disagree", function () {
    const base = { version: IMAGE_VECTORS_VERSION, cacheKey: "k" };
    assert.isNull(
      parseImageVectors(
        JSON.stringify({ ...base, imageIds: ["a"], vectors: [] }),
      ),
    );
    assert.isNull(
      parseImageVectors(
        JSON.stringify({
          ...base,
          imageIds: ["a", "b"],
          vectors: [[1, 2], [1]],
        }),
      ),
    );
  });
});

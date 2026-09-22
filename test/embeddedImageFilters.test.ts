import { assert } from "chai";
import { filterExtractedImages } from "../src/services/pdf/embeddedImages/filters";

const image = (
  pageIndex: number,
  contentHash: string,
  width = 300,
  height = 200,
) => ({ pageIndex, contentHash, width, height });

describe("embedded image filters", function () {
  it("drops images below the minimum side", function () {
    const kept = filterExtractedImages([
      image(0, "a", 99, 400),
      image(0, "b", 100, 100),
    ]);
    assert.deepEqual(
      kept.map((entry) => entry.contentHash),
      ["b"],
    );
  });

  it("drops images repeated on three or more pages", function () {
    const kept = filterExtractedImages([
      image(0, "logo"),
      image(1, "logo"),
      image(2, "logo"),
      image(1, "plot"),
    ]);
    assert.deepEqual(
      kept.map((entry) => entry.contentHash),
      ["plot"],
    );
  });

  it("keeps only the first occurrence of an image seen on two pages", function () {
    const kept = filterExtractedImages([image(3, "x"), image(4, "x")]);
    assert.deepEqual(
      kept.map((entry) => entry.pageIndex),
      [3],
    );
  });

  it("keeps full-page scans", function () {
    const kept = filterExtractedImages([image(0, "scan0", 2480, 3508)]);
    assert.lengthOf(kept, 1);
  });

  it("caps the total and keeps page order", function () {
    const many = Array.from({ length: 5 }, (_, i) => image(4 - i, `h${i}`));
    const kept = filterExtractedImages(many, {
      minSide: 100,
      repeatedPageThreshold: 3,
      maxImages: 3,
    });
    assert.deepEqual(
      kept.map((entry) => entry.pageIndex),
      [0, 1, 2],
    );
  });
});

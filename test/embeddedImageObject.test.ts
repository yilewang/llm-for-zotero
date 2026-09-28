import { assert } from "chai";
import {
  PDFJS_IMAGE_KIND,
  toRgba,
} from "../src/services/pdf/embeddedImages/imageObject";

describe("embedded image object conversion", function () {
  it("copies RGBA pixels as-is", function () {
    const data = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]);
    const rgba = toRgba({
      width: 2,
      height: 1,
      kind: PDFJS_IMAGE_KIND.RGBA_32BPP,
      data,
    });
    assert.deepEqual(Array.from(rgba!), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("expands RGB to opaque RGBA", function () {
    const rgba = toRgba({
      width: 2,
      height: 1,
      kind: PDFJS_IMAGE_KIND.RGB_24BPP,
      data: new Uint8ClampedArray([10, 20, 30, 40, 50, 60]),
    });
    assert.deepEqual(Array.from(rgba!), [10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it("unpacks 1-bit rows with 1 as white", function () {
    // width 3 → one byte per row; bits 1,0,1 → white, black, white
    const rgba = toRgba({
      width: 3,
      height: 1,
      kind: PDFJS_IMAGE_KIND.GRAYSCALE_1BPP,
      data: new Uint8ClampedArray([0b10100000]),
    });
    assert.deepEqual(
      Array.from(rgba!),
      [255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255],
    );
  });

  it("returns null for short data or an unknown kind", function () {
    assert.isNull(
      toRgba({
        width: 2,
        height: 2,
        kind: PDFJS_IMAGE_KIND.RGB_24BPP,
        data: new Uint8ClampedArray(5),
      }),
    );
    assert.isNull(
      toRgba({ width: 1, height: 1, kind: 9, data: new Uint8ClampedArray(4) }),
    );
    assert.isNull(toRgba({ width: 1, height: 1, kind: 3 }));
  });
});

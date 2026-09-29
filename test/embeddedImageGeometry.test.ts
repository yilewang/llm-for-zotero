import { assert } from "chai";
import { OPS, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  analyzeOperatorList,
  unionRect,
} from "../src/services/pdf/embeddedImages/geometry";

function analyze(fnArray: number[], argsArray: unknown[][]) {
  return analyzeOperatorList({ fnArray, argsArray }, OPS, Util);
}

describe("embedded image geometry", function () {
  it("unions rectangles in pdf.js order", function () {
    assert.deepEqual(
      unionRect(Util, [0, 0, 10, 10], [5, -5, 20, 8]),
      [0, -5, 20, 10],
    );
    assert.deepEqual(unionRect(Util, undefined, [1, 2, 3, 4]), [1, 2, 3, 4]);
  });

  it("tracks save/restore/transform around image draws", function () {
    const { images } = analyze(
      [
        OPS.save,
        OPS.transform,
        OPS.paintImageXObject,
        OPS.restore,
        OPS.paintImageXObject,
      ],
      [[], [100, 0, 0, 50, 10, 20], ["img_p0_1"], [], ["img_p0_2"]],
    );
    assert.deepEqual(images, [
      { objId: "img_p0_1", rect: [10, 20, 110, 70] },
      { objId: "img_p0_2", rect: [0, 0, 1, 1] },
    ]);
  });

  it("maps a rotated image through the transform", function () {
    const { images } = analyze(
      [OPS.transform, OPS.paintImageXObject],
      [[0, 100, -200, 0, 300, 50], ["img"]],
    );
    assert.deepEqual(images[0].rect, [100, 50, 300, 150]);
  });

  it("records form XObject boxes and pops their matrices", function () {
    const graphics = analyze(
      [
        OPS.paintFormXObjectBegin,
        OPS.transform,
        OPS.paintImageXObject,
        OPS.paintFormXObjectEnd,
        OPS.transform,
        OPS.paintImageXObject,
      ],
      [
        [
          [1, 0, 0, 1, 100, 100],
          [0, 0, 50, 20],
        ],
        [10, 0, 0, 10, 0, 0],
        ["g_d0_img1"],
        [],
        [5, 0, 0, 5, 0, 0],
        ["img_p0_3"],
      ],
    );
    assert.deepEqual(graphics.forms, [[100, 100, 150, 120]]);
    assert.deepEqual(graphics.images[0].rect, [100, 100, 110, 110]);
    assert.deepEqual(graphics.images[1].rect, [0, 0, 5, 5]);
  });

  it("records painted path boxes through the current transform", function () {
    const { paths } = analyze(
      [OPS.transform, OPS.constructPath],
      [
        [2, 0, 0, 2, 10, 10],
        [OPS.stroke, [null], new Float32Array([0, 0, 5, 3])],
      ],
    );
    assert.deepEqual(paths, [{ rect: [10, 10, 20, 16], mcids: [] }]);
  });

  it("ignores clipping-only paths and paths without bounds", function () {
    const { paths } = analyze(
      [OPS.constructPath, OPS.constructPath, OPS.constructPath],
      [
        [OPS.endPath, [null], [0, 0, 5, 5]],
        [OPS.fill, [null], null],
        [OPS.fill, [null], [Infinity, Infinity, -Infinity, -Infinity]],
      ],
    );
    assert.lengthOf(paths, 0);
  });

  it("attributes paths and images to every open marked-content id", function () {
    const graphics = analyze(
      [
        OPS.beginMarkedContentProps,
        OPS.constructPath,
        OPS.beginMarkedContentProps,
        OPS.transform,
        OPS.paintImageXObject,
        OPS.endMarkedContent,
        OPS.endMarkedContent,
        OPS.beginMarkedContent,
        OPS.constructPath,
        OPS.endMarkedContent,
      ],
      [
        ["Figure", 3],
        [OPS.fill, [null], [0, 0, 10, 10]],
        ["Span", 4],
        [20, 0, 0, 20, 30, 30],
        ["img_p0_1"],
        [],
        [],
        ["Artifact"],
        [OPS.fill, [null], [0, 0, 1, 1]],
        [],
      ],
    );
    assert.deepEqual(graphics.mcidRects.get(3), [0, 0, 50, 50]);
    assert.deepEqual(graphics.mcidRects.get(4), [30, 30, 50, 50]);
    assert.deepEqual(graphics.paths[0].mcids, [3]);
    assert.deepEqual(graphics.paths[1].mcids, []);
  });

  it("ignores malformed transform arguments and non-string image ids", function () {
    const { images } = analyze(
      [OPS.transform, OPS.paintImageXObject, OPS.paintImageXObject],
      [[1, 2], [42], ["img_ok"]],
    );
    assert.deepEqual(images, [{ objId: "img_ok", rect: [0, 0, 1, 1] }]);
  });
});

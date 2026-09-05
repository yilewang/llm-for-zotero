import { assert } from "chai";
import {
  toPdfRect,
  mergeRectsByLine,
  buildAnnotationSortIndex,
  resolveHighlightColor,
} from "../src/agent/services/pdfAnnotationGeometry";

/**
 * Zotero stores highlight rects in PDF user space — origin bottom-left, y up,
 * in points. Both existing geometry producers in this plugin emit the
 * opposite convention and neither is in points, and one of them asserts in
 * its own struct that its XML units ARE points. That assertion is harmless
 * where it is used today because the consumer cancels the error out; reused
 * here it would put every highlight at two-thirds size in the wrong corner.
 */
describe("pdf annotation geometry", function () {
  describe("toPdfRect", function () {
    it("flips the vertical axis, so the box top becomes the larger y", function () {
      const rect = toPdfRect({
        box: { left: 100, top: 50, width: 200, height: 12 },
        pageHeightPoints: 792,
      });
      assert.deepEqual(rect, [100, 730, 300, 742]);
      assert.isAbove(rect[3], rect[1], "y2 must be the top edge");
    });

    it("divides out the source scale — poppler's default zoom is 1.5", function () {
      const rect = toPdfRect({
        box: { left: 150, top: 75, width: 300, height: 18 },
        pageHeightPoints: 792,
        sourceScale: 1.5,
      });
      assert.deepEqual(
        rect,
        [100, 730, 300, 742],
        "the same physical box as above, expressed in 1.5x units",
      );
    });

    it("treats a missing or nonsensical scale as 1 rather than dividing by zero", function () {
      const box = { left: 10, top: 10, width: 10, height: 10 };
      assert.deepEqual(
        toPdfRect({ box, pageHeightPoints: 100, sourceScale: 0 }),
        toPdfRect({ box, pageHeightPoints: 100 }),
      );
    });

    it("places a box at the very top of the page against the page height", function () {
      const rect = toPdfRect({
        box: { left: 0, top: 0, width: 10, height: 10 },
        pageHeightPoints: 792,
      });
      assert.equal(rect[3], 792);
      assert.equal(rect[1], 782);
    });
  });

  describe("mergeRectsByLine", function () {
    it("merges runs on the same line into one rect", function () {
      const merged = mergeRectsByLine([
        [100, 730, 200, 742],
        [205, 730, 300, 742],
      ]);
      assert.deepEqual(merged, [[100, 730, 300, 742]]);
    });

    it("keeps a wrapped title as separate lines", function () {
      const merged = mergeRectsByLine([
        [100, 730, 400, 742],
        [100, 712, 220, 724],
      ]);
      assert.lengthOf(
        merged,
        2,
        "one bounding box would highlight the whitespace beside the short line",
      );
      assert.deepEqual(merged[0], [100, 730, 400, 742], "top line first");
    });

    it("tolerates a small baseline wobble within a line", function () {
      const merged = mergeRectsByLine([
        [100, 730, 200, 742],
        [205, 729, 300, 741],
      ]);
      assert.lengthOf(merged, 1);
    });

    it("passes through a single rect untouched", function () {
      assert.deepEqual(mergeRectsByLine([[1, 2, 3, 4]]), [[1, 2, 3, 4]]);
      assert.deepEqual(mergeRectsByLine([]), []);
    });
  });

  describe("buildAnnotationSortIndex", function () {
    it("matches the format Zotero validates on save", function () {
      const index = buildAnnotationSortIndex({
        pageIndex: 3,
        charOffset: 128,
        topY: 742,
        pageHeightPoints: 792,
      });
      assert.match(index, /^\d{5}\|\d{6}\|\d{5}$/);
      assert.equal(index, "00003|000128|00050");
    });

    it("defaults the character offset, which only affects sidebar order", function () {
      const index = buildAnnotationSortIndex({
        pageIndex: 0,
        topY: 792,
        pageHeightPoints: 792,
      });
      assert.equal(index, "00000|000000|00000");
    });

    it("never emits a negative field when the rect exceeds the page", function () {
      const index = buildAnnotationSortIndex({
        pageIndex: 0,
        topY: 900,
        pageHeightPoints: 792,
      });
      assert.match(index, /^\d{5}\|\d{6}\|\d{5}$/);
    });
  });

  describe("resolveHighlightColor", function () {
    it("resolves Zotero's palette names", function () {
      assert.equal(resolveHighlightColor("red"), "#ff6666");
      assert.equal(resolveHighlightColor("Yellow"), "#ffd400");
    });

    it("normalizes hex to lowercase, which is what Zotero's validator accepts", function () {
      assert.equal(resolveHighlightColor("#ff6666"), "#ff6666");
      assert.equal(
        resolveHighlightColor("#FF6666"),
        "#ff6666",
        "Zotero's regex is not case-insensitive, so uppercase would throw on save — normalizing is more useful than refusing a colour the user clearly meant",
      );
    });

    it("rejects anything else rather than passing it through to a throw", function () {
      assert.isNull(resolveHighlightColor("crimson"));
      assert.isNull(resolveHighlightColor("#fff"));
      assert.isNull(resolveHighlightColor(undefined));
    });
  });
});

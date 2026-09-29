import { assert } from "chai";
import type { Rect } from "../src/services/pdf/embeddedImages/geometry";
import {
  findCaptionNear,
  groupTextLines,
  toPageTextItems,
} from "../src/services/pdf/embeddedImages/captions";

function item(str: string, x: number, y: number, width = 200, height = 10) {
  return { str, transform: [height, 0, 0, height, x, y], width, height };
}

// Image occupies x 100..400, y 300..500 (PDF user space, y up).
const IMAGE: Rect = [100, 300, 400, 500];

describe("embedded image captions", function () {
  it("groups items on the same baseline into one line", function () {
    const lines = groupTextLines(
      toPageTextItems([
        item("Figure 3:", 100, 280, 40),
        item("Loss curve", 145, 280, 60),
      ]),
    );
    assert.lengthOf(lines, 1);
    assert.equal(lines[0].text, "Figure 3: Loss curve");
  });

  it("finds a caption directly below the image", function () {
    const lines = groupTextLines(
      toPageTextItems([
        item("Figure 3: Training loss over epochs.", 100, 282),
        item("The model converges quickly.", 100, 268),
        item("Unrelated body text.", 100, 150),
      ]),
    );
    assert.deepEqual(findCaptionNear(IMAGE, lines), {
      label: "Figure 3",
      caption:
        "Figure 3: Training loss over epochs. The model converges quickly.",
    });
  });

  it("finds a table caption above the image", function () {
    const lines = groupTextLines(
      toPageTextItems([item("Table 2. Results", 100, 510)]),
    );
    assert.deepEqual(findCaptionNear(IMAGE, lines), {
      label: "Table 2",
      caption: "Table 2. Results",
    });
  });

  it("accepts Fig. and FIGURE spellings", function () {
    const fig = groupTextLines(
      toPageTextItems([item("Fig.5 Setup", 100, 282)]),
    );
    assert.equal(findCaptionNear(IMAGE, fig)?.label, "Figure 5");
    const upper = groupTextLines(
      toPageTextItems([item("FIGURE 7 Setup", 100, 282)]),
    );
    assert.equal(findCaptionNear(IMAGE, upper)?.label, "Figure 7");
  });

  it("ignores caption lines that do not overlap horizontally", function () {
    const lines = groupTextLines(
      toPageTextItems([item("Figure 3: elsewhere", 450, 282, 100)]),
    );
    assert.isNull(findCaptionNear(IMAGE, lines));
  });

  it("ignores lines that mention a figure without starting with it", function () {
    const lines = groupTextLines(
      toPageTextItems([
        item("As shown in Figure 3, the loss drops.", 100, 282),
      ]),
    );
    assert.isNull(findCaptionNear(IMAGE, lines));
  });

  it("ignores captions too far away", function () {
    const lines = groupTextLines(
      toPageTextItems([item("Figure 3: far", 100, 150)]),
    );
    assert.isNull(findCaptionNear(IMAGE, lines));
  });

  it("truncates long captions to 300 characters", function () {
    const long = `Figure 1: ${"x".repeat(400)}`;
    const lines = groupTextLines(toPageTextItems([item(long, 100, 282)]));
    assert.lengthOf(findCaptionNear(IMAGE, lines)!.caption, 300);
  });
});

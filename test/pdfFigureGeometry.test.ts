import { assert } from "chai";
import {
  resolveFigureCropForTarget,
  type PdfFigurePageGeometry,
} from "../src/modules/contextPanel/pdfFigureGeometry";

describe("pdfFigureGeometry", function () {
  function page(
    overrides: Partial<PdfFigurePageGeometry> = {},
  ): PdfFigurePageGeometry {
    return {
      pageNumber: 4,
      width: 820,
      height: 1220,
      textBoxes: [],
      imageBoxes: [],
      inkBoxes: [],
      ...overrides,
    };
  }

  it("ignores tall publisher sidebars and selects the real figure image object", function () {
    const result = resolveFigureCropForTarget({
      target: {
        label: "Fig. 2",
        pageNumber: 4,
        captionBox: { left: 445, top: 625, width: 320, height: 62 },
      },
      page: page({
        imageBoxes: [
          {
            left: 0,
            top: -49,
            width: 29,
            height: 1223,
            role: "image",
          },
          {
            left: 446,
            top: 79,
            width: 366,
            height: 532,
            role: "image",
          },
        ],
      }),
    });

    assert.isNotNull(result.best);
    assert.equal(result.best?.source, "pdf-image-object");
    assert.deepEqual(result.best?.rect, {
      left: 446,
      top: 79,
      width: 366,
      height: 532,
    });
    assert.isAtLeast(result.best?.confidence ?? 0, 0.9);
  });

  it("unions adjacent PDF image objects when they form one compound figure", function () {
    const result = resolveFigureCropForTarget({
      target: {
        label: "Figure 3",
        pageNumber: 5,
        captionBox: { left: 80, top: 510, width: 420, height: 80 },
      },
      page: page({
        pageNumber: 5,
        imageBoxes: [
          { left: 70, top: 130, width: 130, height: 180, role: "image" },
          { left: 220, top: 125, width: 130, height: 185, role: "image" },
          { left: 370, top: 135, width: 145, height: 175, role: "image" },
        ],
      }),
    });

    assert.isNotNull(result.best);
    assert.equal(result.best?.source, "pdf-image-object");
    assert.deepEqual(result.best?.rect, {
      left: 70,
      top: 125,
      width: 445,
      height: 185,
    });
    assert.include(result.best?.reasons.join(" "), "compound");
  });

  it("falls back to rendered ink components when there are no figure image objects", function () {
    const result = resolveFigureCropForTarget({
      target: {
        label: "Fig. 4",
        pageNumber: 6,
        captionBox: { left: 72, top: 590, width: 448, height: 80 },
      },
      page: page({
        pageNumber: 6,
        textBoxes: [
          { left: 40, top: 350, width: 220, height: 18, text: "body text" },
          { left: 72, top: 590, width: 448, height: 80, text: "Fig. 4." },
        ],
        inkBoxes: [
          { left: 72, top: 110, width: 180, height: 180, role: "ink" },
          { left: 278, top: 108, width: 220, height: 182, role: "ink" },
          { left: 42, top: 350, width: 220, height: 18, role: "ink" },
        ],
      }),
    });

    assert.isNotNull(result.best);
    assert.equal(result.best?.source, "rendered-ink");
    assert.deepEqual(result.best?.rect, {
      left: 72,
      top: 108,
      width: 426,
      height: 182,
    });
    assert.isAtLeast(result.best?.confidence ?? 0, 0.7);
  });

  it("penalizes object candidates that include substantial non-caption text", function () {
    const result = resolveFigureCropForTarget({
      target: {
        label: "Figure 5",
        pageNumber: 8,
        captionBox: { left: 64, top: 550, width: 490, height: 70 },
      },
      page: page({
        pageNumber: 8,
        textBoxes: [
          { left: 80, top: 150, width: 410, height: 22, text: "paragraph" },
          { left: 80, top: 178, width: 410, height: 22, text: "paragraph" },
        ],
        imageBoxes: [
          { left: 60, top: 120, width: 500, height: 360, role: "image" },
          { left: 82, top: 250, width: 410, height: 190, role: "image" },
        ],
      }),
    });

    assert.isNotNull(result.best);
    assert.deepEqual(result.best?.rect, {
      left: 82,
      top: 250,
      width: 410,
      height: 190,
    });
    assert.include(result.candidates[0].warnings.join(" "), "text overlap");
  });

  it("prefers rendered ink when a PDF image object is only a small panel", function () {
    const result = resolveFigureCropForTarget({
      target: {
        label: "Figure 1",
        pageNumber: 3,
        captionBox: { left: 70, top: 610, width: 470, height: 72 },
      },
      page: page({
        pageNumber: 3,
        imageBoxes: [
          { left: 330, top: 280, width: 96, height: 90, role: "image" },
        ],
        inkBoxes: [
          { left: 70, top: 120, width: 470, height: 420, role: "ink" },
        ],
      }),
    });

    assert.isNotNull(result.best);
    assert.equal(result.best?.source, "rendered-ink");
    assert.deepEqual(result.best?.rect, {
      left: 70,
      top: 120,
      width: 470,
      height: 420,
    });
  });

  it("prefers a caption-bounded rendered region over a partial image object", function () {
    const result = resolveFigureCropForTarget({
      target: {
        label: "Figure 2",
        pageNumber: 4,
        captionBox: { left: 90, top: 650, width: 720, height: 70 },
      },
      page: page({
        pageNumber: 4,
        imageBoxes: [
          { left: 470, top: 130, width: 205, height: 280, role: "image" },
        ],
        regionBoxes: [
          {
            left: 92,
            top: 88,
            width: 716,
            height: 540,
            role: "ink",
          },
        ],
      }),
    });

    assert.isNotNull(result.best);
    assert.equal(result.best?.source, "caption-bounded-region");
    assert.deepEqual(result.best?.rect, {
      left: 92,
      top: 88,
      width: 716,
      height: 540,
    });
  });

  it("trims leading paragraph text from caption-bounded regions", function () {
    const result = resolveFigureCropForTarget({
      target: {
        label: "Figure 3",
        pageNumber: 5,
        captionBox: { left: 80, top: 620, width: 520, height: 70 },
      },
      page: page({
        pageNumber: 5,
        textBoxes: Array.from({ length: 8 }, (_, index) => ({
          left: 92,
          top: 180 + index * 22,
          width: 350,
          height: 16,
          text: "This paragraph is body text and should not be inside the figure crop.",
        })),
        imageBoxes: [
          { left: 545, top: 240, width: 150, height: 160, role: "image" },
        ],
        regionBoxes: [
          {
            left: 70,
            top: 120,
            width: 650,
            height: 470,
            role: "ink",
          },
        ],
      }),
    });

    assert.isNotNull(result.best);
    assert.equal(result.best?.source, "caption-bounded-region");
    assert.deepEqual(result.best?.rect, {
      left: 70,
      top: 290,
      width: 650,
      height: 300,
    });
    assert.include(
      result.best?.warnings.join(" "),
      "trimmed leading paragraph text",
    );
  });

  it("keeps top-band content when the page header band contains figure evidence", function () {
    const result = resolveFigureCropForTarget({
      target: {
        label: "Figure 1",
        pageNumber: 3,
        captionBox: { left: 160, top: 820, width: 700, height: 70 },
      },
      page: page({
        pageNumber: 3,
        width: 920,
        height: 1220,
        textBoxes: [
          {
            left: 48,
            top: 62,
            width: 100,
            height: 12,
            text: "RESEARCH ARTICLE",
          },
          {
            left: 190,
            top: 76,
            width: 120,
            height: 12,
            text: "High density recordings",
          },
          { left: 340, top: 80, width: 95, height: 12, text: "Behavior" },
          {
            left: 470,
            top: 82,
            width: 110,
            height: 12,
            text: "Quantify dynamics",
          },
          {
            left: 200,
            top: 106,
            width: 130,
            height: 12,
            text: "L2/3 population activity",
          },
          { left: 360, top: 112, width: 95, height: 12, text: "Cell group" },
          { left: 510, top: 118, width: 90, height: 12, text: "Time points" },
          { left: 160, top: 820, width: 700, height: 70, text: "Figure 1." },
        ],
        regionBoxes: [
          {
            left: 160,
            top: 62,
            width: 700,
            height: 746,
            role: "ink",
          },
        ],
      }),
    });

    assert.isNotNull(result.best);
    assert.equal(result.best?.source, "caption-bounded-region");
    assert.deepEqual(result.best?.rect, {
      left: 160,
      top: 62,
      width: 700,
      height: 746,
    });
    assert.notInclude(
      result.best?.warnings.join(" "),
      "trimmed page header band",
    );
  });

  it("trims page furniture when the top band only contains header text", function () {
    const result = resolveFigureCropForTarget({
      target: {
        label: "Figure 1",
        pageNumber: 3,
        captionBox: { left: 64, top: 490, width: 500, height: 70 },
      },
      page: page({
        pageNumber: 3,
        width: 904,
        height: 1174,
        textBoxes: [
          { left: 40, top: 65, width: 105, height: 18, text: "CellPress" },
          { left: 710, top: 72, width: 120, height: 16, text: "OPEN ACCESS" },
          { left: 690, top: 100, width: 90, height: 14, text: "Article" },
          { left: 64, top: 490, width: 500, height: 70, text: "Figure 1." },
        ],
        regionBoxes: [
          {
            left: 35,
            top: 60,
            width: 805,
            height: 420,
            role: "ink",
          },
        ],
      }),
    });

    assert.isNotNull(result.best);
    assert.equal(result.best?.source, "caption-bounded-region");
    assert.closeTo(result.best?.rect.top ?? 0, 129.14, 0.01);
    assert.closeTo(result.best?.rect.height ?? 0, 350.86, 0.01);
    assert.include(result.best?.warnings.join(" "), "trimmed page header band");
  });

  it("prefers a MinerU visual block over a page header near a side caption", function () {
    const result = resolveFigureCropForTarget({
      target: {
        label: "Figure 1",
        pageNumber: 3,
        captionBox: { left: 585, top: 152, width: 230, height: 10 },
        visualBox: { left: 84, top: 124, width: 543, height: 208 },
      },
      page: page({
        pageNumber: 3,
        width: 904,
        height: 1174,
        regionBoxes: [
          {
            left: 688,
            top: 60,
            width: 202,
            height: 56,
            role: "ink",
          },
        ],
      }),
    });

    assert.isNotNull(result.best);
    assert.equal(result.best?.source, "mineru-layout-region");
    assert.deepEqual(result.best?.rect, {
      left: 84,
      top: 124,
      width: 543,
      height: 208,
    });
  });

  it("repairs a too-short MinerU visual block from its extracted image aspect ratio", function () {
    const result = resolveFigureCropForTarget({
      target: {
        label: "Figure 1",
        pageNumber: 3,
        captionBox: { left: 585, top: 152, width: 230, height: 10 },
        visualBox: { left: 84, top: 124, width: 543, height: 208 },
        visualAspectRatio: 909 / 453,
      },
      page: page({
        pageNumber: 3,
        width: 904,
        height: 1174,
        regionBoxes: [
          {
            left: 688,
            top: 60,
            width: 202,
            height: 56,
            role: "ink",
          },
        ],
      }),
    });

    assert.isNotNull(result.best);
    assert.equal(result.best?.source, "mineru-layout-region");
    assert.closeTo(result.best?.rect.height ?? 0, 270.6, 0.02);
    const bottom =
      (result.best?.rect.top ?? 0) + (result.best?.rect.height ?? 0);
    assert.closeTo(bottom, 394.6, 0.02);
  });
});

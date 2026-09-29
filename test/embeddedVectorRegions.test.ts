import { assert } from "chai";
import { Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  PageGraphics,
  Rect,
} from "../src/services/pdf/embeddedImages/geometry";
import {
  clusterRects,
  collectStructFigures,
  findVectorRegions,
  type StructFigure,
} from "../src/services/pdf/embeddedImages/vectorRegions";

// US letter page, PDF points.
const PAGE: Rect = [0, 0, 612, 792];

function graphics(overrides: Partial<PageGraphics> = {}): PageGraphics {
  return {
    images: [],
    paths: [],
    forms: [],
    mcidRects: new Map(),
    ...overrides,
  };
}

/** n path boxes laid out in a row across `area`, 5pt apart. */
function pathsIn(area: Rect, n: number) {
  const width = (area[2] - area[0] - (n - 1) * 5) / n;
  return Array.from({ length: n }, (_, i) => ({
    rect: [
      area[0] + i * (width + 5),
      area[1],
      area[0] + i * (width + 5) + width,
      area[3],
    ] as Rect,
    mcids: [] as number[],
  }));
}

function find(g: PageGraphics, figures: StructFigure[] = []) {
  return findVectorRegions({ graphics: g, figures, page: PAGE, util: Util });
}

describe("vector figure regions", function () {
  describe("collectStructFigures", function () {
    it("reads MCIDs, alt text and bbox from Figure nodes", function () {
      const tree = {
        role: "Root",
        children: [
          {
            role: "Sect",
            children: [
              {
                role: "Figure",
                alt: "Two-link arm",
                children: [
                  { type: "content", id: "p12R_mc3" },
                  {
                    role: "Span",
                    children: [{ type: "content", id: "p12R_mc4" }],
                  },
                ],
              },
              { role: "Figure", bbox: [300, 400, 100, 200], children: [] },
              { role: "P", children: [{ type: "content", id: "p12R_mc9" }] },
            ],
          },
        ],
      };
      assert.deepEqual(collectStructFigures(tree), [
        { mcids: [3, 4], alt: "Two-link arm" },
        { mcids: [], bbox: [100, 200, 300, 400] },
      ]);
    });

    it("returns nothing for an untagged page", function () {
      assert.deepEqual(collectStructFigures(null), []);
      assert.deepEqual(collectStructFigures(undefined), []);
    });
  });

  describe("findVectorRegions", function () {
    it("uses a tagged figure's bbox as-is", function () {
      assert.deepEqual(
        find(graphics(), [
          { mcids: [], bbox: [100, 300, 400, 500], alt: "Arm" },
        ]),
        [{ rect: [100, 300, 400, 500], layer: "tagged", alt: "Arm" }],
      );
    });

    it("pads the union of a tagged figure's MCID rects", function () {
      const regions = find(
        graphics({
          mcidRects: new Map<number, Rect>([
            [3, [100, 300, 250, 450]],
            [4, [240, 320, 400, 500]],
          ]),
        }),
        [{ mcids: [3, 4] }],
      );
      assert.deepEqual(regions[0].rect, [88, 288, 412, 512]);
    });

    it("accepts a form XObject of figure size and rejects a small one", function () {
      assert.deepEqual(
        find(
          graphics({
            forms: [
              [100, 300, 400, 500],
              [10, 10, 40, 40],
            ],
          }),
        ),
        [{ rect: [100, 300, 400, 500], layer: "form" }],
      );
    });

    it("skips a region mostly covered by an embedded image", function () {
      const regions = find(
        graphics({
          forms: [[100, 300, 400, 500]],
          images: [{ objId: "img", rect: [100, 300, 380, 500] }],
        }),
      );
      assert.lengthOf(regions, 0);
    });

    it("clusters nearby paths into a padded region", function () {
      assert.deepEqual(
        find(graphics({ paths: pathsIn([100, 300, 400, 500], 5) })),
        [{ rect: [88, 288, 412, 512], layer: "cluster" }],
      );
    });

    it("needs at least four paths in a cluster", function () {
      assert.lengthOf(
        find(graphics({ paths: pathsIn([100, 300, 400, 500], 3) })),
        0,
      );
    });

    it("keeps far-apart groups as separate clusters", function () {
      const regions = find(
        graphics({
          paths: [
            ...pathsIn([50, 500, 250, 700], 4),
            ...pathsIn([350, 100, 550, 300], 4),
          ],
        }),
      );
      assert.lengthOf(regions, 2);
    });

    it("does not re-cluster paths inside an accepted tagged region", function () {
      const regions = find(
        graphics({ paths: pathsIn([100, 300, 400, 500], 6) }),
        [{ mcids: [], bbox: [90, 290, 410, 510] }],
      );
      assert.deepEqual(
        regions.map((region) => region.layer),
        ["tagged"],
      );
    });

    it("ignores page-sized background paths", function () {
      const regions = find(
        graphics({
          paths: [
            { rect: [0, 0, 612, 792], mcids: [] },
            { rect: [1, 1, 611, 791], mcids: [] },
            { rect: [2, 2, 610, 790], mcids: [] },
            { rect: [3, 3, 609, 789], mcids: [] },
          ],
        }),
      );
      assert.lengthOf(regions, 0);
    });

    it("keeps at most six regions, largest first", function () {
      const forms = Array.from(
        { length: 8 },
        (_, i) => [20, 20 + i * 95, 140 + i * 10, 110 + i * 95] as Rect,
      );
      const regions = find(graphics({ forms }));
      assert.lengthOf(regions, 6);
      const widths = regions.map((region) => region.rect[2] - region.rect[0]);
      assert.deepEqual(
        widths,
        [...widths].sort((a, b) => b - a),
      );
    });
  });

  it("clusterRects merges transitively connected boxes", function () {
    const clusters = clusterRects(
      [
        [0, 0, 10, 10],
        [30, 0, 40, 10],
        [18, 0, 22, 10],
        [200, 0, 210, 10],
      ],
      12,
      Util,
    );
    assert.deepEqual(
      clusters.map((cluster) => [cluster.rect, cluster.count]),
      [
        [[0, 0, 40, 10], 3],
        [[200, 0, 210, 10], 1],
      ],
    );
  });
});

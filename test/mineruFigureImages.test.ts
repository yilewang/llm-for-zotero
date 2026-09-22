import { assert } from "chai";
import { resolveMineruFigureImages } from "../src/services/mineru/mineruFigureImages";
import type { MineruManifest } from "../src/services/mineru/mineruCache";
import type { PdfFigureCropCache } from "../src/services/pdf/pdfFigureCropCache";
import { joinLocalPath } from "../src/utils/localPath";

const ITEM_DIR = "C:/cache/mineru/77";
const inItemDir = (relative: string) =>
  joinLocalPath(ITEM_DIR, ...relative.split("/"));

function figure(
  label: string,
  path: string,
  page: number | undefined,
  caption = `${label}: something`,
) {
  return {
    label,
    baseLabel: label.toLowerCase(),
    path,
    caption,
    section: "Results",
    ...(page === undefined ? {} : { page }),
  };
}

function manifest(overrides: Partial<MineruManifest> = {}): MineruManifest {
  return {
    sections: [],
    allFigures: [figure("Figure 1", "images/a.jpg", 4)],
    allTables: [],
    totalChars: 10,
    totalPages: 12,
    ...overrides,
  } as MineruManifest;
}

function cropCache(
  entries: Array<{
    label: string;
    baseLabel: string;
    cropPath: string;
    pageNumber: number;
  }>,
): PdfFigureCropCache {
  return { entries } as unknown as PdfFigureCropCache;
}

function deps(existing: string[], crops: PdfFigureCropCache | null = null) {
  const present = new Set(existing);
  return {
    itemDir: ITEM_DIR,
    fileExists: async (path: string) => present.has(path),
    readCropCache: async () => crops,
  };
}

describe("MinerU figure images", function () {
  it("resolves manifest figures to files with 0-based pages", async function () {
    const result = await resolveMineruFigureImages({
      manifest: manifest(),
      ...deps([inItemDir("images/a.jpg")]),
    });
    assert.lengthOf(result.figures, 1);
    assert.deepEqual(
      {
        path: result.figures[0].path,
        pageIndex: result.figures[0].pageIndex,
        label: result.figures[0].label,
        caption: result.figures[0].caption,
        fromCrop: result.figures[0].fromCrop,
      },
      {
        path: inItemDir("images/a.jpg"),
        pageIndex: 4,
        label: "Figure 1",
        caption: "Figure 1: something",
        fromCrop: false,
      },
    );
  });

  it("drops MinerU's placeholder labels but keeps the caption", async function () {
    const result = await resolveMineruFigureImages({
      manifest: manifest({
        allFigures: [figure("image-2", "images/a.jpg", 1, "A schematic")],
      } as Partial<MineruManifest>),
      ...deps([inItemDir("images/a.jpg")]),
    });
    assert.isUndefined(result.figures[0].label);
    assert.equal(result.figures[0].caption, "A schematic");
  });

  it("keeps one entry when a figure is listed twice", async function () {
    const result = await resolveMineruFigureImages({
      manifest: manifest({
        sections: [
          { figures: [figure("Figure 1", "images/a.jpg", 4)], tables: [] },
        ],
      } as unknown as Partial<MineruManifest>),
      ...deps([inItemDir("images/a.jpg")]),
    });
    assert.lengthOf(result.figures, 1);
  });

  it("falls back to a figure crop when MinerU's image was pruned", async function () {
    const result = await resolveMineruFigureImages({
      manifest: manifest(),
      ...deps(
        [inItemDir("figure_crops/crops/figure-1.png")],
        cropCache([
          {
            label: "Figure 1",
            baseLabel: "figure 1",
            cropPath: "figure_crops/crops/figure-1.png",
            pageNumber: 5,
          },
        ]),
      ),
    });
    assert.lengthOf(result.figures, 1);
    assert.equal(
      result.figures[0].path,
      inItemDir("figure_crops/crops/figure-1.png"),
    );
    assert.isTrue(result.figures[0].fromCrop);
    // The manifest page wins; crop pageNumber is 1-based.
    assert.equal(result.figures[0].pageIndex, 4);
    assert.equal(result.figures[0].label, "Figure 1");
  });

  it("takes the page from a crop when the manifest has none", async function () {
    const result = await resolveMineruFigureImages({
      manifest: manifest({
        allFigures: [figure("Figure 1", "images/a.jpg", undefined)],
      } as Partial<MineruManifest>),
      ...deps(
        [inItemDir("figure_crops/crops/figure-1.png")],
        cropCache([
          {
            label: "Figure 1",
            baseLabel: "figure 1",
            cropPath: "figure_crops/crops/figure-1.png",
            pageNumber: 5,
          },
        ]),
      ),
    });
    assert.equal(result.figures[0].pageIndex, 4);
  });

  it("skips a figure that has neither an image nor a crop", async function () {
    const result = await resolveMineruFigureImages({
      manifest: manifest(),
      ...deps([]),
    });
    assert.lengthOf(result.figures, 0);
  });

  it("skips a figure with no page anywhere", async function () {
    const result = await resolveMineruFigureImages({
      manifest: manifest({
        allFigures: [figure("Figure 1", "images/a.jpg", undefined)],
      } as Partial<MineruManifest>),
      ...deps([inItemDir("images/a.jpg")]),
    });
    assert.lengthOf(result.figures, 0);
  });

  it("changes the fingerprint when the source switches to crops", async function () {
    const original = await resolveMineruFigureImages({
      manifest: manifest(),
      ...deps([inItemDir("images/a.jpg")]),
    });
    const cropped = await resolveMineruFigureImages({
      manifest: manifest(),
      ...deps(
        [inItemDir("figure_crops/crops/figure-1.png")],
        cropCache([
          {
            label: "Figure 1",
            baseLabel: "figure 1",
            cropPath: "figure_crops/crops/figure-1.png",
            pageNumber: 5,
          },
        ]),
      ),
    });
    assert.notEqual(original.fingerprint, cropped.fingerprint);
    assert.notEqual(original.figures[0].imageId, cropped.figures[0].imageId);
  });

  it("does not read the crop cache when every image is present", async function () {
    let reads = 0;
    await resolveMineruFigureImages({
      manifest: manifest(),
      itemDir: ITEM_DIR,
      fileExists: async () => true,
      readCropCache: async () => {
        reads += 1;
        return null;
      },
    });
    assert.equal(reads, 0);
  });
});

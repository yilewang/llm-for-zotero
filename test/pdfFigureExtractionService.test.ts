import { assert } from "chai";
import { PdfFigureExtractionService } from "../src/agent/services/pdfFigureExtractionService";
import type { AgentToolContext } from "../src/agent/types";

describe("PdfFigureExtractionService", function () {
  const encoder = new TextEncoder();
  const globalScope = globalThis as typeof globalThis & {
    IOUtils?: unknown;
  };
  let originalIOUtils: unknown;
  let files: Map<string, Uint8Array>;
  let writeFile: (path: string, value: string) => void;

  const paperContext = {
    itemId: 11,
    contextItemId: 22,
    title: "Figure Paper",
    firstCreator: "Miller",
    year: "2025",
    mineruCacheDir: "/tmp/mineru-paper",
  };

  const context: AgentToolContext = {
    request: {
      conversationKey: 77,
      mode: "agent",
      userText: "",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.5",
  };

  beforeEach(function () {
    originalIOUtils = globalScope.IOUtils;
    files = new Map<string, Uint8Array>();
    writeFile = (path: string, value: string) =>
      files.set(path, encoder.encode(value));
    writeFile(
      "/tmp/mineru-paper/full.md",
      [
        "# Results",
        "![Figure 1](images/fig1.png)",
        "Figure 1. First precise result.",
        "",
        "![Figure 2](images/fig2.png)",
        "Figure 2. Second precise result.",
        "",
        "![Figure 3](images/fig3.png)",
        "Figure 3. Third precise result.",
      ].join("\n"),
    );
    writeFile(
      "/tmp/mineru-paper/content_list.json",
      JSON.stringify([
        { type: "text", text_level: 1, text: "Results", page_idx: 0 },
        {
          type: "image",
          img_path: "images/fig1.png",
          image_caption: ["Figure 1. First precise result."],
          page_idx: 1,
        },
        {
          type: "image",
          img_path: "images/fig2.png",
          image_caption: ["Figure 2. Second precise result."],
          page_idx: 2,
        },
        {
          type: "image",
          img_path: "images/fig3.png",
          image_caption: ["Figure 3. Third precise result."],
          page_idx: 3,
        },
      ]),
    );
    writeFile(
      "/tmp/mineru-paper/manifest.json",
      JSON.stringify({
        sections: [],
        allFigures: [
          {
            label: "Figure 1",
            baseLabel: "Figure 1",
            path: "images/fig1.png",
            caption: "Figure 1. First precise result.",
            page: 1,
            section: "Results",
          },
          {
            label: "Figure 2",
            baseLabel: "Figure 2",
            path: "images/fig2.png",
            caption: "Figure 2. Second precise result.",
            page: 2,
            section: "Results",
          },
          {
            label: "Figure 3",
            baseLabel: "Figure 3",
            path: "images/fig3.png",
            caption: "Figure 3. Third precise result.",
            page: 3,
            section: "Results",
          },
        ],
        allTables: [],
        totalChars: 100,
      }),
    );
    globalScope.IOUtils = {
      read: async (path: string) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error(`missing ${path}`);
        return bytes;
      },
      write: async (path: string, bytes: Uint8Array) => {
        files.set(path, bytes);
      },
      makeDirectory: async () => undefined,
      getChildren: async (path: string) =>
        path === "/tmp/mineru-paper"
          ? ["/tmp/mineru-paper/content_list.json"]
          : [],
    };
  });

  afterEach(function () {
    if (originalIOUtils === undefined) {
      delete globalScope.IOUtils;
    } else {
      globalScope.IOUtils = originalIOUtils;
    }
  });

  function service() {
    return new PdfFigureExtractionService({
      preparePagesForFigureExtraction: async ({
        pages,
      }: {
        pages: number[];
      }) => ({
        target: { source: "library", title: "Figure Paper" },
        pages: pages.map((pageIndex) => ({
          pageIndex,
          pageLabel: `${pageIndex + 1}`,
          width: 700,
          height: 900,
          textBoxes: [
            {
              left: 80,
              top: 520,
              width: 420,
              height: 18,
              text: `Figure ${pageIndex}. Caption.`,
              role: "text" as const,
            },
          ],
          imageBoxes: [],
          inkBoxes: [
            {
              left: 70,
              top: 90,
              width: 500,
              height: 380,
              role: "ink" as const,
            },
          ],
          cropToPngBytes: async () => new Uint8Array([pageIndex + 1]),
        })),
      }),
    } as never);
  }

  it("uses raw source-PDF extraction before MinerU/layout fallback", async function () {
    let rawCalled = false;
    let fallbackCalled = false;
    const result = await new PdfFigureExtractionService({
      extractFiguresFromSourcePdf: async (params: {
        query: string;
        mineruCacheDir: string;
        pages?: number[];
      }) => {
        rawCalled = true;
        assert.equal(params.query, "explain Figure 1");
        assert.equal(params.mineruCacheDir, "/tmp/mineru-paper");
        assert.deepEqual(params.pages, [1]);
        return [
          {
            id: "figure-1-p2",
            label: "Figure 1",
            baseLabel: "Figure 1",
            pageNumber: 2,
            cropPath: "/tmp/mineru-paper/figure_crops/crops/figure-1-p2.png",
            captionText: "Figure 1. First precise result.",
            rect: { left: 57, top: 80, width: 451, height: 331 },
            confidence: 0.9,
            source: "pdf-image-object" as const,
            warnings: [],
            mineruImagePaths: [],
          },
        ];
      },
      preparePagesForFigureExtraction: async () => {
        fallbackCalled = true;
        throw new Error("old fallback should not be called");
      },
    } as never).extractFigures({
      input: { query: "explain Figure 1", pages: [1] },
      context,
      paperContexts: [paperContext],
    });

    assert.isTrue(rawCalled);
    assert.isFalse(fallbackCalled);
    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => ({
        label: figure.label,
        source: figure.source,
        cropPath: figure.cropPath,
        mineruImagePaths: figure.mineruImagePaths,
      })),
      [
        {
          label: "Figure 1",
          source: "pdf-image-object",
          cropPath: "/tmp/mineru-paper/figure_crops/crops/figure-1-p2.png",
          mineruImagePaths: [],
        },
      ],
    );
    const cacheBytes = files.get(
      "/tmp/mineru-paper/figure_crops/figure_geometry.json",
    );
    assert.instanceOf(cacheBytes, Uint8Array);
    const cache = JSON.parse(new TextDecoder().decode(cacheBytes));
    assert.equal(cache.version, 2);
    assert.equal(cache.algorithmVersion, 9);
    assert.equal(cache.entries[0].source, "pdf-image-object");
  });

  it("returns and caches expected and missing figures from raw source-PDF extraction", async function () {
    const result = await new PdfFigureExtractionService({
      extractFiguresFromSourcePdf: async () => ({
        figures: [
          {
            id: "figure-1-p2",
            label: "Figure 1",
            baseLabel: "Figure 1",
            pageNumber: 2,
            captionPageNumber: 2,
            cropPath: "/tmp/mineru-paper/figure_crops/crops/figure-1-p2.png",
            captionText: "Figure 1. First precise result.",
            rect: { left: 57, top: 80, width: 451, height: 331 },
            confidence: 0.9,
            source: "pdf-image-object" as const,
            warnings: [],
            mineruImagePaths: [],
          },
        ],
        expectedFigures: [
          {
            label: "Figure 1",
            baseLabel: "Figure 1",
            pageNumber: 2,
            captionPageNumber: 2,
            status: "ok",
            cropPath: "/tmp/mineru-paper/figure_crops/crops/figure-1-p2.png",
          },
          {
            label: "Figure 2",
            baseLabel: "Figure 2",
            pageNumber: 4,
            captionPageNumber: 5,
            status: "no_confident_candidate",
          },
        ],
        missingFigures: [
          {
            label: "Figure 2",
            baseLabel: "Figure 2",
            pageNumber: 4,
            captionPageNumber: 5,
            status: "no_confident_candidate",
          },
        ],
        warnings: ["Missing requested figure crops: Figure 2"],
      }),
    } as never).extractFigures({
      input: { query: "explain all figures" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.expectedFigures?.map((figure) => [
        figure.label,
        figure.pageNumber,
        figure.captionPageNumber,
      ]),
      [
        ["Figure 1", 2, 2],
        ["Figure 2", 4, 5],
      ],
    );
    assert.deepEqual(
      result.missingFigures?.map((figure) => figure.label),
      ["Figure 2"],
    );
    assert.include(result.guidance || "", "partial results");
    const cache = JSON.parse(
      new TextDecoder().decode(
        files.get("/tmp/mineru-paper/figure_crops/figure_geometry.json"),
      ),
    );
    assert.deepEqual(
      cache.missingFigures.map((figure: { label: string }) => figure.label),
      ["Figure 2"],
    );
  });

  it("does not silently fall back when raw source-PDF extraction returns no crops", async function () {
    let fallbackCalled = false;
    const result = await new PdfFigureExtractionService({
      extractFiguresFromSourcePdf: async () => [],
      preparePagesForFigureExtraction: async () => {
        fallbackCalled = true;
        return {
          target: { source: "library", title: "Figure Paper" },
          pages: [],
        };
      },
    } as never).extractFigures({
      input: { query: "explain Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "no_figures");
    assert.isFalse(fallbackCalled);
    assert.match(result.warnings?.join("\n") || "", /No requested source-PDF/);
  });

  it("extracts all MinerU-resolved figures only when requested", async function () {
    const result = await service().extractFigures({
      input: { query: "explain all figures to me in this paper" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => figure.label),
      ["Figure 1", "Figure 2", "Figure 3"],
    );
    assert.lengthOf(result.artifacts || [], 3);
  });

  it("resolves all-figure requests to canonical caption targets before raw MinerU blocks", async function () {
    writeFile(
      "/tmp/mineru-paper/full.md",
      [
        "# Significance",
        "A",
        "![](images/fig1-a.jpg)",
        "",
        "B",
        "![](images/fig1-b.jpg)",
        "",
        "Fig. 1. Neural networks.",
        "",
        "![](images/fig2.jpg)",
        "",
        "Fig. 2. Comparison of network performance.",
      ].join("\n"),
    );
    writeFile(
      "/tmp/mineru-paper/content_list.json",
      JSON.stringify([
        { type: "image", img_path: "images/fig1-a.jpg", page_idx: 1 },
        { type: "image", img_path: "images/fig1-b.jpg", page_idx: 1 },
        { type: "image", img_path: "images/fig2.jpg", page_idx: 3 },
      ]),
    );
    writeFile(
      "/tmp/mineru-paper/manifest.json",
      JSON.stringify({
        sections: [],
        allFigures: [],
        allTables: [],
        figureBlocks: [
          {
            blockId: "0:images/fig1-a.jpg",
            kind: "figure",
            imagePaths: ["images/fig1-a.jpg"],
            markdownStart: 16,
            markdownEnd: 39,
            contextStart: 16,
            contextEnd: 39,
            labelHints: [],
            captionHints: ["A"],
            pageStart: 1,
            pageEnd: 1,
            confidence: "high",
            ambiguous: false,
          },
          {
            blockId: "1:images/fig1-b.jpg",
            kind: "figure",
            imagePaths: ["images/fig1-b.jpg"],
            markdownStart: 44,
            markdownEnd: 67,
            contextStart: 44,
            contextEnd: 67,
            labelHints: [],
            captionHints: ["B"],
            pageStart: 1,
            pageEnd: 1,
            confidence: "high",
            ambiguous: false,
          },
          {
            blockId: "2:images/fig2.jpg",
            kind: "image",
            imagePaths: ["images/fig2.jpg"],
            markdownStart: 93,
            markdownEnd: 113,
            contextStart: 93,
            contextEnd: 170,
            labelHints: [],
            captionHints: [],
            pageStart: 3,
            pageEnd: 3,
            confidence: "high",
            ambiguous: false,
          },
        ],
        totalChars: 170,
      }),
    );
    writeFile(
      "/tmp/mineru-paper/figure_crops/figure_geometry.json",
      JSON.stringify({
        version: 1,
        attachmentId: 22,
        manifestHash: "stale",
        pdfFingerprint: "stale",
        renderScale: 1.8,
        algorithmVersion: 5,
        generatedAt: 1,
        entries: [
          {
            id: "0:images/fig1-a.jpg",
            label: "Figure 1",
            baseLabel: "Figure 1",
            pageNumber: 2,
            cropPath: "/tmp/mineru-paper/figure_crops/crops/stale-panel.png",
            rect: { left: 1, top: 1, width: 10, height: 10 },
            confidence: 0.95,
            source: "mineru-layout-region",
            warnings: [],
            mineruImagePaths: [],
          },
        ],
      }),
    );

    const cropCalls: Array<{ id?: string; pageIndex: number }> = [];
    const canonicalService = new PdfFigureExtractionService({
      prepareSourcePdfPagesForFigureExtraction: async ({
        pages,
      }: {
        pages: number[];
      }) => ({
        target: { source: "library", title: "Figure Paper" },
        pages: pages.map((pageIndex) => ({
          pageIndex,
          pageLabel: `${pageIndex + 1}`,
          width: 700,
          height: 900,
          pdfWidth: 700,
          pdfHeight: 900,
          textBoxes: [
            {
              left: 80,
              top: 520,
              width: 120,
              height: 18,
              text: `Fig. ${pageIndex === 1 ? 1 : 2}.`,
              role: "text" as const,
            },
          ],
          imageBoxes: [
            {
              left: 70,
              top: 90,
              width: 500,
              height: 380,
              role: "image" as const,
            },
          ],
          inkBoxes: [],
          cropToPngBytes: async () => {
            throw new Error("live canvas crop should not be used");
          },
        })),
      }),
      cropFigureRegionFromPdf: async ({ pageIndex }: { pageIndex: number }) => {
        cropCalls.push({ pageIndex });
        return {
          bytes: new Uint8Array([pageIndex + 1]),
          rect: { left: 70, top: 90, width: 500, height: 380 },
          warnings: [],
        };
      },
    } as never);

    const result = await canonicalService.extractFigures({
      input: { query: "explain all figures in this paper" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => figure.id),
      ["figure-1-p2", "figure-2-p4"],
    );
    assert.deepEqual(
      result.figures?.map((figure) => figure.label),
      ["Figure 1", "Figure 2"],
    );
    assert.lengthOf(cropCalls, 2);
    const writtenCache = JSON.parse(
      new TextDecoder().decode(
        files.get("/tmp/mineru-paper/figure_crops/figure_geometry.json"),
      ),
    );
    assert.deepEqual(
      writtenCache.entries.map((entry: { id: string }) => entry.id),
      ["figure-1-p2", "figure-2-p4"],
    );
  });

  it("respects figure and page constraints", async function () {
    const result = await service().extractFigures({
      input: { query: "explain Figure 1 in page 2", pages: [1] },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => [figure.label, figure.pageNumber]),
      [["Figure 1", 2]],
    );
  });

  it("extracts multiple requested figures", async function () {
    const result = await service().extractFigures({
      input: { query: "explain Figure 1 and 3" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => figure.label),
      ["Figure 1", "Figure 3"],
    );
  });

  it("returns whole-figure crops with panel hints", async function () {
    const result = await service().extractFigures({
      input: { query: "explain Figure 2c" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => [figure.label, figure.panelHint]),
      [["Figure 2", "c"]],
    );
  });

  it("extracts grouped manifest panel blocks with noncanonical labels", async function () {
    writeFile(
      "/tmp/mineru-paper/full.md",
      [
        "# Significance",
        "A",
        "![](images/a.jpg)",
        "B",
        "![](images/b.jpg)",
        "C",
        "D",
        "![](images/c.jpg)",
        "",
        "Figure 1. Neural networks.",
      ].join("\n"),
    );
    writeFile(
      "/tmp/mineru-paper/content_list.json",
      JSON.stringify([
        { type: "text", text_level: 1, text: "Significance", page_idx: 0 },
        { type: "image", img_path: "images/a.jpg", page_idx: 1 },
        { type: "image", img_path: "images/b.jpg", page_idx: 1 },
        { type: "image", img_path: "images/c.jpg", page_idx: 1 },
      ]),
    );
    writeFile(
      "/tmp/mineru-paper/manifest.json",
      JSON.stringify({
        sections: [],
        allFigures: [
          {
            label: "figure-1",
            baseLabel: "figure-1",
            path: "images/a.jpg",
            caption: "A B C D",
            page: 1,
            section: "Significance",
          },
        ],
        allTables: [],
        figureBlocks: [
          {
            blockId: "0:images/a.jpg",
            kind: "figure",
            imagePaths: ["images/a.jpg", "images/b.jpg", "images/c.jpg"],
            markdownStart: 10,
            markdownEnd: 100,
            contextStart: 10,
            contextEnd: 100,
            labelHints: ["figure-1"],
            captionHints: ["A B C D"],
            sectionHeading: "Significance",
            pageStart: 1,
            pageEnd: 1,
            confidence: "high",
            ambiguous: false,
          },
        ],
        totalChars: 100,
      }),
    );

    const result = await service().extractFigures({
      input: { query: "explain Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => [
        figure.label,
        (figure.mineruImagePaths as string[]).length,
      ]),
      [["Figure 1", 3]],
    );
    assert.include(result.artifacts?.[0]?.storedPath || "", "figure_crops");
    assert.include(result.guidance || "", "call note_write");
  });

  it("uses manifest PDF crop ranges as whole-figure geometry for grouped panel blocks", async function () {
    writeFile(
      "/tmp/mineru-paper/full.md",
      [
        "# Significance",
        "A",
        "![](images/a.jpg)",
        "B",
        "![](images/b.jpg)",
        "C",
        "D",
        "![](images/c.jpg)",
        "",
        "Figure 1. Neural networks.",
      ].join("\n"),
    );
    writeFile(
      "/tmp/mineru-paper/content_list.json",
      JSON.stringify([
        { type: "text", text_level: 1, text: "Significance", page_idx: 0 },
        { type: "image", img_path: "images/a.jpg", page_idx: 1 },
        { type: "image", img_path: "images/b.jpg", page_idx: 1 },
        { type: "image", img_path: "images/c.jpg", page_idx: 1 },
      ]),
    );
    writeFile(
      "/tmp/mineru-paper/manifest.json",
      JSON.stringify({
        sections: [],
        allFigures: [
          {
            label: "figure-1",
            baseLabel: "figure-1",
            path: "images/a.jpg",
            panelPaths: ["images/a.jpg", "images/b.jpg", "images/c.jpg"],
            canonicalPanelPaths: [
              "images/a.jpg",
              "images/b.jpg",
              "images/c.jpg",
            ],
            caption: "A B C D",
            page: 1,
            section: "Significance",
            pdfCropRange: [30, 57, 609, 355],
          },
        ],
        allTables: [],
        figureBlocks: [
          {
            blockId: "0:images/a.jpg",
            kind: "figure",
            imagePaths: ["images/a.jpg", "images/b.jpg", "images/c.jpg"],
            markdownStart: 10,
            markdownEnd: 100,
            contextStart: 10,
            contextEnd: 100,
            labelHints: ["figure-1"],
            captionHints: ["A B C D"],
            sectionHeading: "Significance",
            pageStart: 1,
            pageEnd: 1,
            confidence: "high",
            ambiguous: false,
          },
        ],
        totalChars: 100,
      }),
    );

    const cropRects: unknown[] = [];
    const sparseService = new PdfFigureExtractionService({
      preparePagesForFigureExtraction: async ({
        pages,
      }: {
        pages: number[];
      }) => ({
        target: { source: "library", title: "Figure Paper" },
        pages: pages.map((pageIndex) => ({
          pageIndex,
          pageLabel: `${pageIndex + 1}`,
          width: 1102,
          height: 1426,
          pdfWidth: 612,
          pdfHeight: 792,
          textBoxes: [
            {
              left: 108,
              top: 666,
              width: 900,
              height: 32,
              text: "Figure 1. Neural networks.",
              role: "text" as const,
            },
          ],
          imageBoxes: [],
          inkBoxes: [],
          cropToPngBytes: async (rect: unknown) => {
            cropRects.push(rect);
            return new Uint8Array([7]);
          },
        })),
      }),
    } as never);

    const result = await sparseService.extractFigures({
      input: { query: "help me write a note about Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "ok");
    assert.deepInclude(result.figures?.[0], {
      label: "Figure 1",
      pageNumber: 2,
      source: "mineru-layout-region",
    });
    const cropRect = cropRects[0] as {
      left: number;
      top: number;
      width: number;
      height: number;
    };
    assert.closeTo(cropRect.left, 30 * (1102 / 612), 0.000001);
    assert.closeTo(cropRect.top, 57 * (1426 / 792), 0.000001);
    assert.closeTo(cropRect.width, 579 * (1102 / 612), 0.000001);
    assert.closeTo(cropRect.height, 298 * (1426 / 792), 0.000001);
  });

  it("headlessly crops manifest PDF crop ranges without using live page rendering", async function () {
    writeFile(
      "/tmp/mineru-paper/full.md",
      [
        "# Significance",
        "A",
        "![](images/a.jpg)",
        "B",
        "![](images/b.jpg)",
        "C",
        "D",
        "![](images/c.jpg)",
        "",
        "Figure 1. Neural networks.",
      ].join("\n"),
    );
    writeFile(
      "/tmp/mineru-paper/content_list.json",
      JSON.stringify([
        { type: "text", text_level: 1, text: "Significance", page_idx: 0 },
        { type: "image", img_path: "images/a.jpg", page_idx: 1 },
        { type: "image", img_path: "images/b.jpg", page_idx: 1 },
        { type: "image", img_path: "images/c.jpg", page_idx: 1 },
      ]),
    );
    writeFile(
      "/tmp/mineru-paper/manifest.json",
      JSON.stringify({
        sections: [],
        allFigures: [
          {
            label: "figure-1",
            baseLabel: "figure-1",
            path: "images/a.jpg",
            panelPaths: ["images/a.jpg", "images/b.jpg", "images/c.jpg"],
            caption: "A B C D",
            page: 1,
            section: "Significance",
            pdfCropRange: [30, 57, 609, 355],
          },
        ],
        allTables: [],
        figureBlocks: [
          {
            blockId: "0:images/a.jpg",
            kind: "figure",
            imagePaths: ["images/a.jpg", "images/b.jpg", "images/c.jpg"],
            markdownStart: 10,
            markdownEnd: 100,
            contextStart: 10,
            contextEnd: 100,
            labelHints: ["figure-1"],
            captionHints: ["A B C D"],
            sectionHeading: "Significance",
            pageStart: 1,
            pageEnd: 1,
            confidence: "high",
            ambiguous: false,
          },
        ],
        totalChars: 100,
      }),
    );

    const cropCalls: Array<{
      pageIndex: number;
      rect: { left: number; top: number; width: number; height: number };
      sourcePageSize?: { width: number; height: number };
    }> = [];
    const headlessService = new PdfFigureExtractionService({
      preparePagesForFigureExtraction: async () => {
        throw new Error("live rendering should not be used for manifest crops");
      },
      cropFigureRegionFromPdf: async ({
        pageIndex,
        rect,
      }: {
        pageIndex: number;
        rect: { left: number; top: number; width: number; height: number };
      }) => {
        cropCalls.push({ pageIndex, rect });
        return {
          bytes: new Uint8Array([9, 8, 7]),
          rect,
          warnings: [],
        };
      },
    } as never);

    const result = await headlessService.extractFigures({
      input: { query: "help me write a note about Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "ok");
    assert.deepEqual(cropCalls, [
      {
        pageIndex: 1,
        rect: { left: 30, top: 57, width: 579, height: 298 },
      },
    ]);
    assert.deepInclude(result.figures?.[0], {
      label: "Figure 1",
      pageNumber: 2,
      source: "mineru-layout-region",
      confidence: 0.95,
    });
    assert.deepEqual(
      Array.from(files.get(result.figures?.[0]?.cropPath || "") || []),
      [9, 8, 7],
    );
  });

  it("derives headless PDF crops from layout files when stale manifests lack crop ranges", async function () {
    writeFile(
      "/tmp/mineru-paper/full.md",
      [
        "# Significance",
        "A",
        "![](images/a.jpg)",
        "",
        "B",
        "![](images/b.jpg)",
        "",
        "C",
        "D",
        "![](images/c.jpg)",
        "",
        "## Theoretical Framework",
        "Fig. 1. Neural networks. (A) Stability-plasticity dilemma. (B) Solution manifolds. (C) Phase portrait. (D) Oscillatory behavior.",
      ].join("\n"),
    );
    writeFile(
      "/tmp/mineru-paper/content_list.json",
      JSON.stringify([
        { type: "text", text_level: 1, text: "Significance", page_idx: 0 },
        {
          type: "image",
          img_path: "images/a.jpg",
          image_caption: ["A"],
          bbox: [59, 75, 580, 191],
          page_idx: 1,
        },
        {
          type: "image",
          img_path: "images/b.jpg",
          image_caption: ["B"],
          bbox: [63, 210, 229, 347],
          page_idx: 1,
        },
        {
          type: "image",
          img_path: "images/c.jpg",
          image_caption: ["C", "D"],
          bbox: [241, 205, 441, 351],
          page_idx: 1,
        },
      ]),
    );
    writeFile(
      "/tmp/mineru-paper/layout.json",
      JSON.stringify({
        pdf_info: [
          { preproc_blocks: [] },
          {
            preproc_blocks: [
              { type: "image", bbox: [35, 59, 339, 150] },
              { type: "image", bbox: [37, 165, 134, 272] },
              { type: "image", bbox: [141, 161, 258, 275] },
              {
                type: "text",
                bbox: [348, 122, 543, 276],
                lines: [
                  {
                    spans: [
                      {
                        content:
                          "Fig. 1. Neural networks. (A) Stability-plasticity dilemma.",
                      },
                    ],
                  },
                ],
              },
              { type: "title", bbox: [35, 287, 133, 299] },
            ],
          },
        ],
      }),
    );
    writeFile(
      "/tmp/mineru-paper/manifest.json",
      JSON.stringify({
        sections: [
          {
            heading: "Significance",
            charStart: 0,
            charEnd: 200,
            figures: [
              {
                label: "image-1",
                baseLabel: "image-1",
                path: "images/a.jpg",
                caption: "A",
                page: 1,
              },
              {
                label: "image-2",
                baseLabel: "image-2",
                path: "images/b.jpg",
                caption: "B",
                page: 1,
              },
              {
                label: "image-3",
                baseLabel: "image-3",
                path: "images/c.jpg",
                caption: "C D",
                page: 1,
              },
            ],
            tables: [],
            equationCount: 0,
          },
        ],
        allFigures: [],
        allTables: [],
        figureBlocks: [
          {
            blockId: "0:images/a.jpg",
            kind: "figure",
            imagePaths: ["images/a.jpg"],
            markdownStart: 20,
            markdownEnd: 40,
            contextStart: 20,
            contextEnd: 40,
            labelHints: [],
            captionHints: ["A"],
            sectionHeading: "Significance",
            pageStart: 1,
            pageEnd: 1,
            confidence: "high",
            ambiguous: false,
          },
          {
            blockId: "1:images/b.jpg",
            kind: "figure",
            imagePaths: ["images/b.jpg"],
            markdownStart: 45,
            markdownEnd: 65,
            contextStart: 45,
            contextEnd: 65,
            labelHints: [],
            captionHints: ["B"],
            sectionHeading: "Significance",
            pageStart: 1,
            pageEnd: 1,
            confidence: "high",
            ambiguous: false,
          },
          {
            blockId: "2:images/c.jpg",
            kind: "figure",
            imagePaths: ["images/c.jpg"],
            markdownStart: 70,
            markdownEnd: 90,
            contextStart: 70,
            contextEnd: 90,
            labelHints: [],
            captionHints: ["C", "D"],
            sectionHeading: "Significance",
            pageStart: 1,
            pageEnd: 1,
            confidence: "high",
            ambiguous: false,
          },
        ],
        totalChars: 100,
      }),
    );

    const cropCalls: Array<{
      pageIndex: number;
      rect: { left: number; top: number; width: number; height: number };
    }> = [];
    const headlessService = new PdfFigureExtractionService({
      preparePagesForFigureExtraction: async () => {
        throw new Error("live rendering should not be used for layout crops");
      },
      cropFigureRegionFromPdf: async ({
        pageIndex,
        rect,
      }: {
        pageIndex: number;
        rect: { left: number; top: number; width: number; height: number };
      }) => {
        cropCalls.push({ pageIndex, rect });
        return {
          bytes: new Uint8Array([6, 5, 4]),
          rect,
          warnings: [],
        };
      },
    } as never);

    const result = await headlessService.extractFigures({
      input: { query: "help me write a note about Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "ok");
    assert.lengthOf(cropCalls, 1);
    assert.equal(cropCalls[0].pageIndex, 1);
    assert.closeTo(cropCalls[0].rect.left, 30, 0.01);
    assert.closeTo(cropCalls[0].rect.top, 46.04, 0.01);
    assert.closeTo(cropCalls[0].rect.width, 314, 0.01);
    assert.closeTo(cropCalls[0].rect.height, 237.6, 0.01);
    assert.deepInclude(result.figures?.[0], {
      label: "Figure 1",
      pageNumber: 2,
      source: "mineru-layout-region",
      confidence: 0.95,
    });
  });

  it("prefers source-PDF image objects over a partial MinerU panel box", async function () {
    writeFile(
      "/tmp/mineru-paper/full.md",
      [
        "During training, the center-out task is shown in Fig. 6B.",
        "![A](images/panel-a.jpg)",
        "![B](images/panel-b.jpg)",
        "Fig. 6. (A) Network module. (B) Tuning curve sharpening.",
      ].join("\n"),
    );
    writeFile(
      "/tmp/mineru-paper/content_list.json",
      JSON.stringify([
        {
          type: "image",
          img_path: "images/panel-a.jpg",
          image_caption: ["A"],
          bbox: [68, 774, 395, 897],
          page_idx: 8,
        },
        {
          type: "chart",
          img_path: "images/panel-b.jpg",
          chart_caption: [
            "Fig. 6. (A) Network module. (B) Tuning curve sharpening.",
          ],
          bbox: [416, 767, 648, 915],
          page_idx: 8,
        },
      ]),
    );
    writeFile(
      "/tmp/mineru-paper/layout.json",
      JSON.stringify({
        pdf_info: [
          ...Array.from({ length: 8 }, () => ({ preproc_blocks: [] })),
          {
            preproc_blocks: [
              { type: "image", bbox: [40, 606, 231, 702] },
              { type: "chart", bbox: [243, 600, 379, 716] },
            ],
          },
        ],
      }),
    );
    writeFile(
      "/tmp/mineru-paper/manifest.json",
      JSON.stringify({
        sections: [],
        allFigures: [],
        allTables: [],
        figureBlocks: [
          {
            blockId: "8:images/panel-a.jpg",
            kind: "figure",
            imagePaths: ["images/panel-a.jpg"],
            markdownStart: 60,
            markdownEnd: 80,
            contextStart: 60,
            contextEnd: 80,
            labelHints: [],
            captionHints: ["A"],
            pageStart: 9,
            pageEnd: 9,
            confidence: "high",
            ambiguous: false,
          },
          {
            blockId: "9:images/panel-b.jpg",
            kind: "image",
            imagePaths: ["images/panel-b.jpg"],
            markdownStart: 90,
            markdownEnd: 110,
            contextStart: 90,
            contextEnd: 190,
            labelHints: ["Figure 6"],
            captionHints: [
              "Fig. 6. (A) Network module. (B) Tuning curve sharpening.",
            ],
            pageStart: 9,
            pageEnd: 9,
            confidence: "high",
            ambiguous: false,
          },
        ],
        totalChars: 200,
      }),
    );

    const cropCalls: Array<{
      pageIndex: number;
      rect: { left: number; top: number; width: number; height: number };
    }> = [];
    const sourcePdfService = new PdfFigureExtractionService({
      prepareSourcePdfPagesForFigureExtraction: async ({
        pages,
      }: {
        pages: number[];
      }) => ({
        target: { source: "library", title: "Figure Paper" },
        pages: pages.map((pageIndex) => ({
          pageIndex,
          pageLabel: `${pageIndex + 1}`,
          width: 877,
          height: 1174,
          pdfWidth: 877,
          pdfHeight: 1174,
          textBoxes: [
            {
              left: 589,
              top: 906,
              width: 28,
              height: 10,
              text: "Fig. 6.",
              role: "text" as const,
            },
          ],
          imageBoxes: [
            {
              left: 0,
              top: -49,
              width: 29,
              height: 1223,
              role: "image" as const,
            },
            {
              left: 64,
              top: 904,
              width: 505,
              height: 169,
              role: "image" as const,
            },
          ],
          inkBoxes: [],
          cropToPngBytes: async () => {
            throw new Error("live canvas crop should not be used");
          },
        })),
      }),
      cropFigureRegionFromPdf: async ({
        pageIndex,
        rect,
        sourcePageSize,
      }: {
        pageIndex: number;
        rect: { left: number; top: number; width: number; height: number };
        sourcePageSize?: { width: number; height: number };
      }) => {
        cropCalls.push({ pageIndex, rect, sourcePageSize });
        return {
          bytes: new Uint8Array([6, 6, 6]),
          rect,
          warnings: [],
        };
      },
    } as never);

    const result = await sourcePdfService.extractFigures({
      input: { query: "explain Figure 6" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "ok");
    assert.lengthOf(cropCalls, 1);
    assert.equal(cropCalls[0].pageIndex, 8);
    assert.deepEqual(cropCalls[0].rect, {
      left: 64,
      top: 904,
      width: 505,
      height: 169,
    });
    assert.deepEqual(cropCalls[0].sourcePageSize, {
      width: 877,
      height: 1174,
    });
    assert.deepInclude(result.figures?.[0], {
      label: "Figure 6",
      pageNumber: 9,
      source: "pdf-image-object",
    });
  });

  it("infers a figure target from nearby full.md captions when panel blocks are unlabeled", async function () {
    writeFile(
      "/tmp/mineru-paper/full.md",
      [
        "# Significance",
        "A",
        "![](images/a.jpg)",
        "",
        "B",
        "![](images/b.jpg)",
        "",
        "C",
        "D",
        "![](images/c.jpg)",
        "",
        "## Theoretical Framework",
        "A collection of points in weight space is called a solution manifold.",
        "Fig. 1. Neural networks. (A) Stability-plasticity dilemma. (B) Solution manifolds. (C) Phase portrait. (D) Oscillatory behavior.",
      ].join("\n"),
    );
    writeFile(
      "/tmp/mineru-paper/content_list.json",
      JSON.stringify([
        { type: "text", text_level: 1, text: "Significance", page_idx: 0 },
        {
          type: "image",
          img_path: "images/a.jpg",
          image_caption: ["A"],
          page_idx: 1,
        },
        {
          type: "image",
          img_path: "images/b.jpg",
          image_caption: ["B"],
          page_idx: 1,
        },
        {
          type: "image",
          img_path: "images/c.jpg",
          image_caption: ["C", "D"],
          page_idx: 1,
        },
      ]),
    );
    writeFile(
      "/tmp/mineru-paper/manifest.json",
      JSON.stringify({
        sections: [
          {
            heading: "Significance",
            charStart: 0,
            charEnd: 200,
            figures: [
              {
                label: "image-1",
                baseLabel: "image-1",
                path: "images/a.jpg",
                caption: "A",
                page: 1,
              },
              {
                label: "image-2",
                baseLabel: "image-2",
                path: "images/b.jpg",
                caption: "B",
                page: 1,
              },
              {
                label: "image-3",
                baseLabel: "image-3",
                path: "images/c.jpg",
                caption: "C D",
                page: 1,
              },
            ],
            tables: [],
            equationCount: 0,
          },
        ],
        allFigures: [],
        allTables: [],
        figureBlocks: [
          {
            blockId: "0:images/a.jpg",
            kind: "figure",
            imagePaths: ["images/a.jpg"],
            markdownStart: 20,
            markdownEnd: 40,
            contextStart: 20,
            contextEnd: 40,
            labelHints: [],
            captionHints: ["A"],
            sectionHeading: "Significance",
            pageStart: 2,
            pageEnd: 2,
            confidence: "high",
            ambiguous: false,
          },
          {
            blockId: "1:images/b.jpg",
            kind: "figure",
            imagePaths: ["images/b.jpg"],
            markdownStart: 45,
            markdownEnd: 65,
            contextStart: 45,
            contextEnd: 65,
            labelHints: [],
            captionHints: ["B"],
            sectionHeading: "Significance",
            pageStart: 2,
            pageEnd: 2,
            confidence: "high",
            ambiguous: false,
          },
          {
            blockId: "2:images/c.jpg",
            kind: "figure",
            imagePaths: ["images/c.jpg"],
            markdownStart: 70,
            markdownEnd: 90,
            contextStart: 70,
            contextEnd: 90,
            labelHints: [],
            captionHints: ["C", "D"],
            sectionHeading: "Significance",
            pageStart: 2,
            pageEnd: 2,
            confidence: "high",
            ambiguous: false,
          },
        ],
        totalChars: 100,
      }),
    );

    const result = await service().extractFigures({
      input: { query: "help me write a note about Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => [
        figure.label,
        (figure.mineruImagePaths as string[]).length,
        figure.pageNumber,
      ]),
      [["Figure 1", 3, 2]],
    );
  });

  it("normalizes cached block pages from content_list page_idx when old manifests have no sections", async function () {
    writeFile(
      "/tmp/mineru-paper/full.md",
      [
        "# Significance",
        "A",
        "![](images/a.jpg)",
        "",
        "B",
        "![](images/b.jpg)",
        "",
        "C",
        "D",
        "![](images/c.jpg)",
        "",
        "## Theoretical Framework",
        "A collection of points in weight space is called a solution manifold.",
        "Fig. 1. Neural networks. (A) Stability-plasticity dilemma. (B) Solution manifolds. (C) Phase portrait. (D) Oscillatory behavior.",
      ].join("\n"),
    );
    writeFile(
      "/tmp/mineru-paper/content_list.json",
      JSON.stringify([
        { type: "text", text_level: 1, text: "Significance", page_idx: 0 },
        {
          type: "image",
          img_path: "images/a.jpg",
          image_caption: ["A"],
          page_idx: 1,
        },
        {
          type: "image",
          img_path: "images/b.jpg",
          image_caption: ["B"],
          page_idx: 1,
        },
        {
          type: "image",
          img_path: "images/c.jpg",
          image_caption: ["C", "D"],
          page_idx: 1,
        },
      ]),
    );
    writeFile(
      "/tmp/mineru-paper/manifest.json",
      JSON.stringify({
        noSections: true,
        sections: [],
        allFigures: [],
        allTables: [],
        figureBlocks: [
          {
            blockId: "0:images/a.jpg",
            kind: "figure",
            imagePaths: ["images/a.jpg"],
            markdownStart: 20,
            markdownEnd: 40,
            contextStart: 20,
            contextEnd: 40,
            labelHints: [],
            captionHints: ["A"],
            sectionHeading: "Significance",
            pageStart: 2,
            pageEnd: 2,
            confidence: "high",
            ambiguous: false,
          },
          {
            blockId: "1:images/b.jpg",
            kind: "figure",
            imagePaths: ["images/b.jpg"],
            markdownStart: 45,
            markdownEnd: 65,
            contextStart: 45,
            contextEnd: 65,
            labelHints: [],
            captionHints: ["B"],
            sectionHeading: "Significance",
            pageStart: 2,
            pageEnd: 2,
            confidence: "high",
            ambiguous: false,
          },
          {
            blockId: "2:images/c.jpg",
            kind: "figure",
            imagePaths: ["images/c.jpg"],
            markdownStart: 70,
            markdownEnd: 90,
            contextStart: 70,
            contextEnd: 90,
            labelHints: [],
            captionHints: ["C", "D"],
            sectionHeading: "Significance",
            pageStart: 2,
            pageEnd: 2,
            confidence: "high",
            ambiguous: false,
          },
        ],
        totalChars: 100,
      }),
    );

    const result = await service().extractFigures({
      input: { query: "help me write a note about Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => [
        figure.label,
        (figure.mineruImagePaths as string[]).length,
        figure.pageNumber,
      ]),
      [["Figure 1", 3, 2]],
    );
  });
});

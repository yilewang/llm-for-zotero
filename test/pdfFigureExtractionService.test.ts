import { assert } from "chai";
import { PdfFigureExtractionService } from "../src/agent/services/pdfFigureExtractionService";
import {
  PDF_FIGURE_CROP_ALGORITHM_VERSION,
  PDF_FIGURE_CROP_CACHE_VERSION,
  buildPdfFigureCropManifestHash,
  buildPdfFigureCropPdfFingerprint,
} from "../src/modules/contextPanel/pdfFigureCropCache";
import type { AgentToolContext } from "../src/agent/types";

describe("PdfFigureExtractionService", function () {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const globalScope = globalThis as typeof globalThis & {
    IOUtils?: unknown;
    Zotero?: unknown;
  };
  let originalIOUtils: unknown;
  let originalZotero: unknown;
  let files: Map<string, Uint8Array>;
  let removedPaths: Array<{
    path: string;
    options?: { recursive?: boolean; ignoreAbsent?: boolean };
  }>;
  let writeFile: (path: string, value: string) => void;

  const paperContext = {
    itemId: 11,
    contextItemId: 22,
    title: "Figure Paper",
    firstCreator: "Miller",
    year: "2025",
    mineruCacheDir: "/tmp/mineru-paper",
  };
  const manifest = {
    sections: [],
    allFigures: [
      {
        label: "Figure 1",
        baseLabel: "Figure 1",
        path: "images/fig1.png",
        caption: "Figure 1. First precise result.",
        page: 2,
        section: "Results",
      },
    ],
    allTables: [],
    totalChars: 100,
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
    originalZotero = globalScope.Zotero;
    files = new Map<string, Uint8Array>();
    removedPaths = [];
    writeFile = (path: string, value: string) =>
      files.set(path, encoder.encode(value));
    writeFile("/tmp/mineru-paper/manifest.json", JSON.stringify(manifest));
    globalScope.IOUtils = {
      read: async (path: string) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error(`missing ${path}`);
        return bytes;
      },
      write: async (path: string, bytes: Uint8Array) => {
        files.set(path, bytes);
      },
      remove: async (
        path: string,
        options?: { recursive?: boolean; ignoreAbsent?: boolean },
      ) => {
        removedPaths.push({ path, options });
        for (const existingPath of Array.from(files.keys())) {
          if (existingPath === path || existingPath.startsWith(`${path}/`)) {
            files.delete(existingPath);
          }
        }
      },
      makeDirectory: async () => undefined,
      getChildren: async (path: string) => {
        const prefix = path.endsWith("/") ? path : `${path}/`;
        const children = new Set<string>();
        for (const filePath of files.keys()) {
          if (!filePath.startsWith(prefix) || filePath === path) continue;
          const rest = filePath.slice(prefix.length);
          const childName = rest.split("/")[0];
          if (childName) children.add(`${prefix}${childName}`);
        }
        return [...children];
      },
    };
    globalScope.Zotero = {
      DataDirectory: { dir: "/tmp/zotero" },
    };
  });

  afterEach(function () {
    if (originalIOUtils === undefined) {
      delete globalScope.IOUtils;
    } else {
      globalScope.IOUtils = originalIOUtils;
    }
    if (originalZotero === undefined) {
      delete globalScope.Zotero;
    } else {
      globalScope.Zotero = originalZotero;
    }
  });

  function currentManifestHash(): string {
    return buildPdfFigureCropManifestHash(manifest);
  }

  function currentPdfFingerprint(): string {
    return buildPdfFigureCropPdfFingerprint(paperContext);
  }

  function writeCropCache(cache: Record<string, unknown>): void {
    writeFile(
      "/tmp/mineru-paper/figure_crops/figure_geometry.json",
      JSON.stringify(cache),
    );
  }

  function cachedFigure(cropPath: string) {
    return {
      id: "figure-1-p2",
      label: "Figure 1",
      baseLabel: "Figure 1",
      pageNumber: 2,
      cropPath,
      captionText: "Figure 1. First precise result.",
      rect: { left: 57, top: 80, width: 451, height: 331 },
      confidence: 0.9,
      source: "pdf-image-object" as const,
      warnings: [],
      mineruImagePaths: [],
    };
  }

  function cachedFigureWithLabel(label: string, cropPath: string) {
    const baseLabel = label.replace(/[a-z]$/i, "").trim();
    return {
      ...cachedFigure(cropPath),
      id: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-p2`,
      label,
      baseLabel: baseLabel || label,
      cropPath,
      captionText: `${label}. Cached precise result.`,
    };
  }

  it("returns verified cached crops before source-PDF extraction", async function () {
    const cropPath = "/tmp/mineru-paper/figure_crops/crops/figure-1-p2.png";
    files.set(cropPath, encoder.encode("png"));
    writeCropCache({
      version: PDF_FIGURE_CROP_CACHE_VERSION,
      attachmentId: 22,
      manifestHash: currentManifestHash(),
      pdfFingerprint: currentPdfFingerprint(),
      renderScale: 1.8,
      algorithmVersion: PDF_FIGURE_CROP_ALGORITHM_VERSION,
      generatedAt: 1,
      expectedFigures: [
        {
          label: "Figure 1",
          baseLabel: "Figure 1",
          pageNumber: 2,
          status: "ok",
          cropPath,
        },
      ],
      missingFigures: [],
      entries: [cachedFigure(cropPath)],
    });
    let rawCalled = false;

    const result = await new PdfFigureExtractionService({
      extractFiguresFromSourcePdf: async () => {
        rawCalled = true;
        throw new Error("source extraction should not run for cached crops");
      },
    } as never).extractFigures({
      input: { query: "explain Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.isFalse(rawCalled);
    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => figure.cropPath),
      [cropPath],
    );
    assert.deepEqual(
      result.artifacts?.map((artifact) => artifact.storedPath),
      [cropPath],
    );
  });

  it("does not parse numeric prose after a figure label as another requested figure", async function () {
    const figure1CropPath =
      "/tmp/mineru-paper/figure_crops/crops/figure-1-p2.png";
    const figure2CropPath =
      "/tmp/mineru-paper/figure_crops/crops/figure-2-p4.png";
    files.set(figure1CropPath, encoder.encode("png"));
    files.set(figure2CropPath, encoder.encode("png"));
    writeCropCache({
      version: PDF_FIGURE_CROP_CACHE_VERSION,
      attachmentId: 22,
      manifestHash: currentManifestHash(),
      pdfFingerprint: currentPdfFingerprint(),
      renderScale: 1.8,
      algorithmVersion: PDF_FIGURE_CROP_ALGORITHM_VERSION,
      generatedAt: 1,
      expectedFigures: [
        {
          label: "Figure 1",
          baseLabel: "Figure 1",
          pageNumber: 2,
          status: "ok",
          cropPath: figure1CropPath,
        },
        {
          label: "Figure 2",
          baseLabel: "Figure 2",
          pageNumber: 4,
          status: "ok",
          cropPath: figure2CropPath,
        },
      ],
      missingFigures: [],
      entries: [
        cachedFigureWithLabel("Figure 1", figure1CropPath),
        cachedFigureWithLabel("Figure 2", figure2CropPath),
      ],
    });

    const result = await new PdfFigureExtractionService({
      extractFiguresFromSourcePdf: async () => {
        throw new Error("source extraction should not run for cached crops");
      },
    } as never).extractFigures({
      input: { query: "Figure 1 has 2 panels" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => figure.label),
      ["Figure 1"],
    );
  });

  it("does not reuse a cached crop for a different requested figure", async function () {
    const oldCropPath = "/tmp/mineru-paper/figure_crops/crops/figure-1-p2.png";
    const regeneratedCropPath =
      "/tmp/mineru-paper/figure_crops/crops/figure-2-p4.png";
    files.set(oldCropPath, encoder.encode("png"));
    writeCropCache({
      version: PDF_FIGURE_CROP_CACHE_VERSION,
      attachmentId: 22,
      manifestHash: currentManifestHash(),
      pdfFingerprint: currentPdfFingerprint(),
      renderScale: 1.8,
      algorithmVersion: PDF_FIGURE_CROP_ALGORITHM_VERSION,
      generatedAt: 1,
      expectedFigures: [
        {
          label: "Figure 1",
          baseLabel: "Figure 1",
          pageNumber: 2,
          status: "ok",
          cropPath: oldCropPath,
        },
      ],
      missingFigures: [],
      entries: [cachedFigureWithLabel("Figure 1", oldCropPath)],
    });
    let rawCalled = false;

    const result = await new PdfFigureExtractionService({
      extractFiguresFromSourcePdf: async () => {
        rawCalled = true;
        return [cachedFigureWithLabel("Figure 2", regeneratedCropPath)];
      },
    } as never).extractFigures({
      input: { query: "explain Figure 2" },
      context,
      paperContexts: [paperContext],
    });

    assert.isTrue(rawCalled);
    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => figure.cropPath),
      [regeneratedCropPath],
    );
  });

  it("repairs compatible crop metadata when crop files exist and attachment matches", async function () {
    const cropPath = "/tmp/mineru-paper/figure_crops/crops/figure-1-p2.png";
    const staleExpectedPath =
      "/var/folders/tmp/llm-for-zotero-raw-figures/work/01_figure_1.png";
    files.set(cropPath, encoder.encode("png"));
    writeCropCache({
      version: PDF_FIGURE_CROP_CACHE_VERSION,
      attachmentId: 22,
      manifestHash: currentManifestHash(),
      pdfFingerprint: currentPdfFingerprint(),
      renderScale: 1.8,
      algorithmVersion: PDF_FIGURE_CROP_ALGORITHM_VERSION,
      generatedAt: 1,
      expectedFigures: [
        {
          label: "Figure 1",
          baseLabel: "Figure 1",
          pageNumber: 2,
          status: "ok",
          cropPath: staleExpectedPath,
        },
      ],
      missingFigures: [],
      entries: [cachedFigure(cropPath)],
    });
    let rawCalled = false;

    const result = await new PdfFigureExtractionService({
      extractFiguresFromSourcePdf: async () => {
        rawCalled = true;
        throw new Error(
          "source extraction should not run for compatible crops",
        );
      },
    } as never).extractFigures({
      input: { query: "explain Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.isFalse(rawCalled);
    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => figure.cropPath),
      [cropPath],
    );
    const rewritten = JSON.parse(
      decoder.decode(
        files.get("/tmp/mineru-paper/figure_crops/figure_geometry.json"),
      ),
    );
    assert.equal(rewritten.version, PDF_FIGURE_CROP_CACHE_VERSION);
    assert.equal(rewritten.algorithmVersion, PDF_FIGURE_CROP_ALGORITHM_VERSION);
    assert.equal(rewritten.manifestHash, currentManifestHash());
    assert.equal(rewritten.pdfFingerprint, currentPdfFingerprint());
    assert.equal(rewritten.expectedFigures[0].cropPath, cropPath);
  });

  it("reuses compatible cache when title metadata drifts", async function () {
    const cropPath = "/tmp/mineru-paper/figure_crops/crops/figure-1-p2.png";
    files.set(cropPath, encoder.encode("png"));
    writeCropCache({
      version: PDF_FIGURE_CROP_CACHE_VERSION,
      attachmentId: 22,
      manifestHash: currentManifestHash(),
      pdfFingerprint: buildPdfFigureCropPdfFingerprint({
        ...paperContext,
        title: "Old Display Title",
        attachmentTitle: "Old Attachment Title",
      }),
      renderScale: 1.8,
      algorithmVersion: PDF_FIGURE_CROP_ALGORITHM_VERSION,
      generatedAt: 1,
      expectedFigures: [
        {
          label: "Figure 1",
          baseLabel: "Figure 1",
          pageNumber: 2,
          status: "ok",
          cropPath,
        },
      ],
      missingFigures: [],
      entries: [cachedFigure(cropPath)],
    });
    let rawCalled = false;

    const result = await new PdfFigureExtractionService({
      extractFiguresFromSourcePdf: async () => {
        rawCalled = true;
        throw new Error("source extraction should not run for title drift");
      },
    } as never).extractFigures({
      input: { query: "explain Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.isFalse(rawCalled);
    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => figure.cropPath),
      [cropPath],
    );
  });

  it("regenerates and removes figure crop cache on cache-version mismatch", async function () {
    const oldCropPath = "/tmp/mineru-paper/figure_crops/crops/old-figure.png";
    const regeneratedCropPath =
      "/tmp/mineru-paper/figure_crops/crops/figure-1-p2.png";
    files.set(oldCropPath, encoder.encode("png"));
    writeCropCache({
      version: PDF_FIGURE_CROP_CACHE_VERSION - 1,
      attachmentId: 22,
      manifestHash: currentManifestHash(),
      pdfFingerprint: currentPdfFingerprint(),
      renderScale: 1.8,
      algorithmVersion: PDF_FIGURE_CROP_ALGORITHM_VERSION,
      generatedAt: 1,
      entries: [cachedFigure(oldCropPath)],
    });
    let rawCalled = false;

    const result = await new PdfFigureExtractionService({
      extractFiguresFromSourcePdf: async () => {
        rawCalled = true;
        return [cachedFigure(regeneratedCropPath)];
      },
    } as never).extractFigures({
      input: { query: "explain Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.isTrue(rawCalled);
    assert.deepInclude(removedPaths, {
      path: "/tmp/mineru-paper/figure_crops",
      options: { recursive: true, ignoreAbsent: true },
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => figure.cropPath),
      [regeneratedCropPath],
    );
    const cache = JSON.parse(
      decoder.decode(
        files.get("/tmp/mineru-paper/figure_crops/figure_geometry.json"),
      ),
    );
    assert.equal(cache.version, PDF_FIGURE_CROP_CACHE_VERSION);
    assert.equal(cache.algorithmVersion, PDF_FIGURE_CROP_ALGORITHM_VERSION);
    assert.equal(cache.entries[0].cropPath, regeneratedCropPath);
  });

  it("regenerates and removes figure crop cache on algorithm-version mismatch", async function () {
    const oldCropPath = "/tmp/mineru-paper/figure_crops/crops/old-figure.png";
    const regeneratedCropPath =
      "/tmp/mineru-paper/figure_crops/crops/figure-1-p2.png";
    files.set(oldCropPath, encoder.encode("png"));
    writeCropCache({
      version: PDF_FIGURE_CROP_CACHE_VERSION,
      attachmentId: 22,
      manifestHash: currentManifestHash(),
      pdfFingerprint: currentPdfFingerprint(),
      renderScale: 1.8,
      algorithmVersion: PDF_FIGURE_CROP_ALGORITHM_VERSION - 1,
      generatedAt: 1,
      entries: [cachedFigure(oldCropPath)],
    });
    let rawCalled = false;

    const result = await new PdfFigureExtractionService({
      extractFiguresFromSourcePdf: async () => {
        rawCalled = true;
        return [cachedFigure(regeneratedCropPath)];
      },
    } as never).extractFigures({
      input: { query: "explain Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.isTrue(rawCalled);
    assert.deepInclude(removedPaths, {
      path: "/tmp/mineru-paper/figure_crops",
      options: { recursive: true, ignoreAbsent: true },
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => figure.cropPath),
      [regeneratedCropPath],
    );
    const cache = JSON.parse(
      decoder.decode(
        files.get("/tmp/mineru-paper/figure_crops/figure_geometry.json"),
      ),
    );
    assert.equal(cache.version, PDF_FIGURE_CROP_CACHE_VERSION);
    assert.equal(cache.algorithmVersion, PDF_FIGURE_CROP_ALGORITHM_VERSION);
    assert.equal(cache.entries[0].cropPath, regeneratedCropPath);
  });

  it("regenerates when cached crop files are missing", async function () {
    const staleCropPath =
      "/tmp/mineru-paper/figure_crops/crops/missing-figure-1-p2.png";
    const regeneratedCropPath =
      "/tmp/mineru-paper/figure_crops/crops/figure-1-p2.png";
    writeCropCache({
      version: PDF_FIGURE_CROP_CACHE_VERSION,
      attachmentId: 22,
      manifestHash: currentManifestHash(),
      pdfFingerprint: currentPdfFingerprint(),
      renderScale: 1.8,
      algorithmVersion: PDF_FIGURE_CROP_ALGORITHM_VERSION,
      generatedAt: 1,
      entries: [cachedFigure(staleCropPath)],
    });
    let rawCalled = false;

    const result = await new PdfFigureExtractionService({
      extractFiguresFromSourcePdf: async () => {
        rawCalled = true;
        return [cachedFigure(regeneratedCropPath)];
      },
    } as never).extractFigures({
      input: { query: "explain Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.isTrue(rawCalled);
    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => figure.cropPath),
      [regeneratedCropPath],
    );
  });

  it("regenerates all-figure requests when manifest coverage is unknown", async function () {
    const cachedCropPath =
      "/tmp/mineru-paper/figure_crops/crops/cached-figure-1-p2.png";
    const regeneratedFigure1Path =
      "/tmp/mineru-paper/figure_crops/crops/figure-1-p2.png";
    const regeneratedFigure2Path =
      "/tmp/mineru-paper/figure_crops/crops/figure-2-p4.png";
    files.delete("/tmp/mineru-paper/manifest.json");
    files.set(cachedCropPath, encoder.encode("png"));
    writeCropCache({
      version: PDF_FIGURE_CROP_CACHE_VERSION,
      attachmentId: 22,
      manifestHash: buildPdfFigureCropManifestHash(null),
      pdfFingerprint: currentPdfFingerprint(),
      renderScale: 1.8,
      algorithmVersion: PDF_FIGURE_CROP_ALGORITHM_VERSION,
      generatedAt: 1,
      expectedFigures: [
        {
          label: "Figure 1",
          baseLabel: "Figure 1",
          pageNumber: 2,
          status: "ok",
          cropPath: cachedCropPath,
        },
      ],
      missingFigures: [],
      entries: [cachedFigureWithLabel("Figure 1", cachedCropPath)],
    });
    let rawCalled = false;

    const result = await new PdfFigureExtractionService({
      extractFiguresFromSourcePdf: async () => {
        rawCalled = true;
        return [
          cachedFigureWithLabel("Figure 1", regeneratedFigure1Path),
          cachedFigureWithLabel("Figure 2", regeneratedFigure2Path),
        ];
      },
    } as never).extractFigures({
      input: { query: "explain all figures" },
      context,
      paperContexts: [paperContext],
    });

    assert.isTrue(rawCalled);
    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => figure.cropPath),
      [regeneratedFigure1Path, regeneratedFigure2Path],
    );
  });

  it("uses raw source-PDF extraction as the normal figure path", async function () {
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
    const cache = JSON.parse(decoder.decode(cacheBytes));
    assert.equal(cache.version, 2);
    assert.equal(cache.algorithmVersion, 9);
    assert.equal(cache.entries[0].source, "pdf-image-object");
  });

  it("uses source-PDF extraction for library PDFs without MinerU cache", async function () {
    const pdfOnlyPaperContext = {
      ...paperContext,
      mineruCacheDir: undefined,
    };
    const cropPath =
      "/tmp/zotero/llm-for-zotero-pdf-figure-crops/22/figure_crops/crops/figure-1-p2.png";
    let rawParams: { figureCacheDir?: string; mineruCacheDir?: string } | null =
      null;

    const result = await new PdfFigureExtractionService({
      extractFiguresFromSourcePdf: async (params: {
        query: string;
        figureCacheDir: string;
        mineruCacheDir?: string;
      }) => {
        rawParams = params;
        return [
          {
            id: "figure-1-p2",
            label: "Figure 1",
            baseLabel: "Figure 1",
            pageNumber: 2,
            cropPath,
            captionText: "Figure 1. First precise result.",
            rect: { left: 57, top: 80, width: 451, height: 331 },
            confidence: 0.9,
            source: "pdf-image-object" as const,
            warnings: [],
            mineruImagePaths: [],
          },
        ];
      },
    } as never).extractFigures({
      input: { query: "explain Figure 1" },
      context,
      paperContexts: [pdfOnlyPaperContext],
    });

    assert.equal(result.status, "ok");
    assert.equal(
      rawParams?.figureCacheDir,
      "/tmp/zotero/llm-for-zotero-pdf-figure-crops/22",
    );
    assert.isUndefined(rawParams?.mineruCacheDir);
    assert.notMatch(result.warnings?.join("\n") || "", /MinerU-ready/i);
    const cacheBytes = files.get(
      "/tmp/zotero/llm-for-zotero-pdf-figure-crops/22/figure_crops/figure_geometry.json",
    );
    assert.instanceOf(cacheBytes, Uint8Array);
  });

  it("removes raw MinerU source images after writing a ready crop cache", async function () {
    writeFile(
      "/tmp/mineru-paper/full.md",
      "# Results\nFigure 1. First precise result.",
    );
    writeFile(
      "/tmp/mineru-paper/content_list.json",
      JSON.stringify([
        { type: "text", text_level: 1, text: "Results", page_idx: 1 },
        {
          type: "image",
          img_path: "images/fig1.png",
          image_caption: ["Figure 1. First precise result."],
          page_idx: 1,
        },
      ]),
    );
    files.set("/tmp/mineru-paper/images/fig1.png", encoder.encode("mineru"));
    const cropPath = "/tmp/mineru-paper/figure_crops/crops/figure-1-p2.png";

    const result = await new PdfFigureExtractionService({
      extractFiguresFromSourcePdf: async () => {
        files.set(cropPath, encoder.encode("png"));
        return [
          {
            id: "figure-1-p2",
            label: "Figure 1",
            baseLabel: "Figure 1",
            pageNumber: 2,
            cropPath,
            captionText: "Figure 1. First precise result.",
            rect: { left: 57, top: 80, width: 451, height: 331 },
            confidence: 0.9,
            source: "pdf-image-object" as const,
            warnings: [],
            mineruImagePaths: [],
          },
        ];
      },
    } as never).extractFigures({
      input: { query: "explain Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "ok");
    assert.isFalse(files.has("/tmp/mineru-paper/images/fig1.png"));
    assert.isTrue(files.has(cropPath));
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
      result.missingFigures?.map((figure) => figure.label),
      ["Figure 2"],
    );
    assert.include(result.guidance || "", "partial results");
    const cache = JSON.parse(
      decoder.decode(
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

  it("does not fall back to rendered PDF page crops when source-PDF extraction is unavailable", async function () {
    let fallbackCalled = false;
    const result = await new PdfFigureExtractionService({
      preparePagesForFigureExtraction: async () => {
        fallbackCalled = true;
        return {
          target: { source: "library", title: "Figure Paper" },
          pages: [
            {
              pageIndex: 1,
              pageLabel: "2",
              width: 800,
              height: 1000,
              textBoxes: [],
              imageBoxes: [],
              inkBoxes: [{ left: 40, top: 80, width: 500, height: 320 }],
              cropToPngBytes: async () => encoder.encode("fallback-png"),
            },
          ],
        };
      },
    } as never).extractFigures({
      input: { query: "explain Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "no_figures");
    assert.isFalse(fallbackCalled);
    assert.deepEqual(result.figures, []);
    assert.deepEqual(result.artifacts, []);
    assert.match(
      result.warnings?.join("\n") || "",
      /Source-PDF figure extraction is unavailable/i,
    );
    assert.include(result.guidance || "", "switch to text-only mode");
  });

  it("does not fall back to rendered PDF page crops when source-PDF extraction fails before producing crops", async function () {
    let fallbackCalled = false;
    const result = await new PdfFigureExtractionService({
      extractFiguresFromSourcePdf: async () => {
        throw new Error("fetch HTTP404; Zotero.HTTP404");
      },
      preparePagesForFigureExtraction: async (params: { pages: number[] }) => {
        fallbackCalled = true;
        assert.deepEqual(params.pages, [1]);
        return {
          target: { source: "library", title: "Figure Paper" },
          pages: [
            {
              pageIndex: 1,
              pageLabel: "2",
              width: 800,
              height: 1000,
              textBoxes: [],
              imageBoxes: [],
              inkBoxes: [{ left: 40, top: 80, width: 500, height: 320 }],
              cropToPngBytes: async () => encoder.encode("fallback-png"),
            },
          ],
        };
      },
    } as never).extractFigures({
      input: { query: "explain Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "no_figures");
    assert.isFalse(fallbackCalled);
    assert.deepEqual(result.figures, []);
    assert.deepEqual(result.artifacts, []);
    assert.match(
      result.warnings?.join("\n") || "",
      /Could not run source-PDF figure extraction: fetch HTTP404; Zotero.HTTP404/,
    );
    assert.include(result.guidance || "", "switch to text-only mode");
  });
});

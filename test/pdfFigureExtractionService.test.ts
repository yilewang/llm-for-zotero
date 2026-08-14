import { assert } from "chai";
import { PdfFigureExtractionService } from "../src/agent/services/pdfFigureExtractionService";
import type { AgentToolContext } from "../src/agent/types";

describe("PdfFigureExtractionService", function () {
  const encoder = new TextEncoder();
  const globalScope = globalThis as typeof globalThis & {
    IOUtils?: unknown;
  };
  const cacheDir = "/tmp/mineru-paper";
  const paperContext = {
    itemId: 11,
    contextItemId: 22,
    title: "Figure Paper",
    firstCreator: "Miller",
    year: "2025",
    mineruCacheDir: cacheDir,
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

  let originalIOUtils: unknown;
  let files: Map<string, Uint8Array>;
  let sourcePdfExtractionCalls: number;

  beforeEach(function () {
    originalIOUtils = globalScope.IOUtils;
    files = new Map<string, Uint8Array>();
    sourcePdfExtractionCalls = 0;
    globalScope.IOUtils = {
      read: async (path: string) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error(`missing ${path}`);
        return bytes;
      },
    };
  });

  afterEach(function () {
    if (originalIOUtils === undefined) {
      delete globalScope.IOUtils;
    } else {
      globalScope.IOUtils = originalIOUtils;
    }
  });

  function writeJson(path: string, value: unknown): void {
    files.set(path, encoder.encode(JSON.stringify(value)));
  }

  function figureBlock(params: {
    id: string;
    label: string;
    imagePath: string;
    page: number;
    ambiguous?: boolean;
  }) {
    return {
      blockId: params.id,
      kind: "figure",
      imagePaths: [params.imagePath],
      markdownStart: 100,
      markdownEnd: 120,
      contextStart: 100,
      contextEnd: 240,
      labelHints: [params.label],
      captionHints: [`${params.label}. Precise result.`],
      sectionHeading: "Results",
      pageStart: params.page,
      pageEnd: params.page,
      confidence: params.ambiguous ? "low" : "high",
      ambiguous: Boolean(params.ambiguous),
    };
  }

  function writeManifest(blocks: ReturnType<typeof figureBlock>[]): void {
    writeJson(`${cacheDir}/manifest.json`, {
      sections: [],
      allFigures: [],
      allTables: [],
      figureBlocks: blocks,
      totalChars: 100,
    });
  }

  function createService(): PdfFigureExtractionService {
    return new PdfFigureExtractionService({
      extractFiguresFromSourcePdf: async () => {
        sourcePdfExtractionCalls += 1;
        throw new Error("source-PDF extraction must not run");
      },
    } as never);
  }

  it("returns the MinerU image mapped to the requested figure", async function () {
    const imagePath = `${cacheDir}/images/fig1.jpg`;
    files.set(imagePath, encoder.encode("jpg"));
    writeManifest([
      figureBlock({
        id: "0:images/fig1.jpg",
        label: "Figure 1",
        imagePath: "images/fig1.jpg",
        page: 2,
      }),
    ]);

    const result = await createService().extractFigures({
      input: { query: "explain Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(sourcePdfExtractionCalls, 0);
    assert.equal(result.status, "ok");
    assert.deepInclude(result.figures?.[0], {
      label: "Figure 1",
      imagePath,
      source: "mineru",
      confidence: 1,
    });
    assert.deepInclude(result.artifacts?.[0], {
      storedPath: imagePath,
      mimeType: "image/jpeg",
      title: "Figure 1",
      pageIndex: 1,
    });
  });

  it("returns every mapped MinerU figure for an all-figures request", async function () {
    files.set(`${cacheDir}/images/fig1.png`, encoder.encode("png1"));
    files.set(`${cacheDir}/images/fig2.png`, encoder.encode("png2"));
    writeManifest([
      figureBlock({
        id: "0:images/fig1.png",
        label: "Figure 1",
        imagePath: "images/fig1.png",
        page: 1,
      }),
      figureBlock({
        id: "1:images/fig2.png",
        label: "Figure 2",
        imagePath: "images/fig2.png",
        page: 3,
      }),
    ]);

    const result = await createService().extractFigures({
      input: { query: "show all figures" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.figures?.map((figure) => figure.label),
      ["Figure 1", "Figure 2"],
    );
    assert.equal(result.artifacts?.length, 2);
    assert.equal(sourcePdfExtractionCalls, 0);
  });

  it("keeps the whole MinerU figure for a panel request", async function () {
    const imagePath = `${cacheDir}/images/fig1.png`;
    files.set(imagePath, encoder.encode("png"));
    writeManifest([
      figureBlock({
        id: "0:images/fig1.png",
        label: "Figure 1",
        imagePath: "images/fig1.png",
        page: 1,
      }),
    ]);

    const result = await createService().extractFigures({
      input: { query: "explain Figure 1b" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "ok");
    assert.deepInclude(result.figures?.[0], {
      imagePath,
      panelHint: "b",
    });
  });

  it("reports a missing mapped image without invoking PDF extraction", async function () {
    writeManifest([
      figureBlock({
        id: "0:images/missing.png",
        label: "Figure 1",
        imagePath: "images/missing.png",
        page: 1,
      }),
    ]);

    const result = await createService().extractFigures({
      input: { query: "Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "no_figures");
    assert.equal(sourcePdfExtractionCalls, 0);
    assert.deepInclude(result.missingFigures?.[0], {
      label: "Figure 1",
      status: "missing_image",
      source: "mineru",
    });
    assert.match(result.warnings?.[0] || "", /MinerU image is missing/);
  });

  it("rejects unsafe MinerU image paths", async function () {
    files.set("/tmp/outside.png", encoder.encode("png"));
    writeManifest([
      figureBlock({
        id: "0:unsafe",
        label: "Figure 1",
        imagePath: "../outside.png",
        page: 1,
      }),
    ]);

    const result = await createService().extractFigures({
      input: { query: "Figure 1" },
      context,
      paperContexts: [paperContext],
    });

    assert.equal(result.status, "no_figures");
    assert.equal(result.artifacts?.length, 0);
    assert.equal(sourcePdfExtractionCalls, 0);
  });

  it("requires MinerU instead of falling back to PDF extraction", async function () {
    const result = await createService().extractFigures({
      input: { query: "Figure 1" },
      context,
      paperContexts: [{ ...paperContext, mineruCacheDir: undefined }],
    });

    assert.equal(result.status, "mineru_required");
    assert.equal(sourcePdfExtractionCalls, 0);
    assert.match(result.guidance || "", /MinerU cache is required/);
  });
});

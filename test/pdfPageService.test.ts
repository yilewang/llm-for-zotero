import { assert } from "chai";
import {
  buildPdftoppmCropArguments,
  renderPdfFigurePageToCanvas,
  resolveAddonRootUri,
  resolveRenderablePdfPage,
} from "../src/agent/services/pdfPageService";
import { renderPdfPageToBytes } from "../src/modules/contextPanel/pdfJsPageRenderer";

describe("pdfPageService", function () {
  const globalScope = globalThis as typeof globalThis & {
    rootURI?: string;
    _globalThis?: { rootURI?: string };
    Components?: {
      utils?: {
        cloneInto?: <T extends object>(
          value: T,
          targetScope: unknown,
          options?: { cloneFunctions?: boolean; wrapReflectors?: boolean },
        ) => T & { clonedIntoTarget?: boolean };
      };
    };
  };
  let originalRootURI: string | undefined;
  let hadRootURI: boolean;
  let originalSandboxGlobal: { rootURI?: string } | undefined;
  let hadSandboxGlobal: boolean;
  let originalComponents: typeof globalScope.Components;
  let hadComponents: boolean;

  beforeEach(function () {
    hadRootURI = Object.prototype.hasOwnProperty.call(globalScope, "rootURI");
    originalRootURI = globalScope.rootURI;
    hadSandboxGlobal = Object.prototype.hasOwnProperty.call(
      globalScope,
      "_globalThis",
    );
    originalSandboxGlobal = globalScope._globalThis;
    hadComponents = Object.prototype.hasOwnProperty.call(
      globalScope,
      "Components",
    );
    originalComponents = globalScope.Components;
  });

  afterEach(function () {
    if (hadRootURI) {
      globalScope.rootURI = originalRootURI;
    } else {
      delete globalScope.rootURI;
    }
    if (hadSandboxGlobal) {
      globalScope._globalThis = originalSandboxGlobal;
    } else {
      delete globalScope._globalThis;
    }
    if (hadComponents) {
      globalScope.Components = originalComponents;
    } else {
      delete globalScope.Components;
    }
  });

  it("resolves the addon root URI from the Zotero plugin sandbox global", function () {
    delete globalScope.rootURI;
    globalScope._globalThis = {
      rootURI: "file:///Users/example/plugin/root/",
    };

    assert.equal(resolveAddonRootUri(), "file:///Users/example/plugin/root/");
  });

  it("unwraps nested PDF page proxies from Zotero/Firefox wrappers", function () {
    const renderable = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 100 * scale,
        height: 200 * scale,
      }),
      render: () => ({ promise: Promise.resolve() }),
    };

    assert.equal(resolveRenderablePdfPage(renderable), renderable);
    assert.equal(resolveRenderablePdfPage({ pdfPage: renderable }), renderable);
    assert.equal(
      resolveRenderablePdfPage({
        wrappedJSObject: { pdfPage: renderable },
      }),
      renderable,
    );
  });

  it("builds source-PDF crop arguments for pdftoppm without reader canvas scaling", function () {
    const built = buildPdftoppmCropArguments({
      pdfPath: "/tmp/paper.pdf",
      outputPrefix: "/tmp/crop/figure",
      pageIndex: 1,
      rect: { left: 30, top: 57, width: 579, height: 298 },
      dpi: 216,
    });

    assert.equal(built.dpi, 216);
    assert.deepEqual(built.rect, {
      left: 30,
      top: 57,
      width: 579,
      height: 298,
    });
    assert.deepEqual(built.args, [
      "-png",
      "-r",
      "216",
      "-f",
      "2",
      "-l",
      "2",
      "-x",
      "90",
      "-y",
      "171",
      "-W",
      "1737",
      "-H",
      "894",
      "/tmp/paper.pdf",
      "/tmp/crop/figure",
    ]);
  });

  it("converts pdftohtml XML coordinates with the rendered page ratio", function () {
    const built = buildPdftoppmCropArguments({
      pdfPath: "/tmp/paper.pdf",
      outputPrefix: "/tmp/crop/figure",
      pageIndex: 3,
      rect: { left: 446, top: 79, width: 366, height: 532 },
      dpi: 216,
      sourcePageSize: { width: 877, height: 1174 },
      renderedPageSize: { width: 1755, height: 2349 },
    });

    assert.deepEqual(built.args, [
      "-png",
      "-r",
      "216",
      "-f",
      "4",
      "-l",
      "4",
      "-x",
      "892",
      "-y",
      "158",
      "-W",
      "733",
      "-H",
      "1065",
      "/tmp/paper.pdf",
      "/tmp/crop/figure",
    ]);
  });

  it("scopes PDF.js render parameters for Zotero reader windows", async function () {
    const renderWindow = {
      Object,
      Array,
      document: null as unknown,
    };
    const imageBytes = new Uint8ClampedArray(4 * 4 * 4);
    imageBytes.fill(255);
    const canvas = {
      width: 0,
      height: 0,
      ownerDocument: null as unknown,
      getContext: () => ({
        getImageData: () => ({ data: imageBytes }),
      }),
    };
    const canvasDoc = {
      defaultView: renderWindow,
      createElement: () => canvas,
    };
    renderWindow.document = canvasDoc;
    canvas.ownerDocument = canvasDoc;
    const cloneTargets: unknown[] = [];
    globalScope.Components = {
      utils: {
        cloneInto: (value, targetScope) => {
          cloneTargets.push(targetScope);
          return { ...value, clonedIntoTarget: true };
        },
      },
    };

    let sawClonedRenderParams = false;
    const rendered = await renderPdfFigurePageToCanvas({
      pdfPage: {
        getViewport: ({ scale }: { scale: number }) => ({
          width: 10 * scale,
          height: 20 * scale,
          scale,
        }),
        render: (params: {
          canvasContext?: unknown;
          viewport?: unknown;
          clonedIntoTarget?: boolean;
        }) => {
          sawClonedRenderParams = params.clonedIntoTarget === true;
          assert.exists(params.canvasContext);
          assert.exists(params.viewport);
          return { promise: Promise.resolve() };
        },
        getTextContent: async () => ({ items: [] }),
      },
      canvasDoc: canvasDoc as Document,
      reader: { _iframeWindow: renderWindow },
      pageIndex: 2,
      pageLabel: "3",
      scale: 1.8,
    });

    assert.isTrue(sawClonedRenderParams);
    assert.include(cloneTargets, renderWindow);
    assert.equal(rendered.pageIndex, 2);
    assert.equal(rendered.width, 18);
    assert.equal(rendered.height, 36);
  });

  it("renders model PDF pages through the shared PDF.js offscreen renderer", async function () {
    const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`;
    const nonBlankPixels = new Uint8ClampedArray(128 * 128 * 4);
    for (let index = 0; index < nonBlankPixels.length; index += 4) {
      nonBlankPixels[index] = 0;
      nonBlankPixels[index + 1] = 0;
      nonBlankPixels[index + 2] = 0;
      nonBlankPixels[index + 3] = 255;
    }
    const renderWindow = {
      Object,
      Array,
      document: null as unknown,
    };
    const canvasDoc = {
      defaultView: renderWindow,
      createElement: () => ({
        width: 0,
        height: 0,
        style: {},
        ownerDocument: canvasDoc,
        getContext: () => ({
          save: () => undefined,
          restore: () => undefined,
          setTransform: () => undefined,
          clearRect: () => undefined,
          fillRect: () => undefined,
          drawImage: () => undefined,
          getImageData: () => ({ data: nonBlankPixels }),
        }),
        toDataURL: () => dataUrl,
      }),
      fonts: { status: "loaded" },
    };
    renderWindow.document = canvasDoc;
    let getPageCalls = 0;
    let renderCalls = 0;
    const app = {
      pdfDocument: {
        getPage: async (pageNumber: number) => {
          getPageCalls += 1;
          assert.equal(pageNumber, 2);
          return {
            getViewport: ({ scale }: { scale: number }) => ({
              width: 100 * scale,
              height: 200 * scale,
              scale,
            }),
            render: () => {
              renderCalls += 1;
              return { promise: Promise.resolve() };
            },
            cleanup: () => undefined,
          };
        },
      },
      pdfViewer: { container: { ownerDocument: canvasDoc } },
    };

    const bytes = await renderPdfPageToBytes(
      app,
      { _iframeWindow: { document: canvasDoc } },
      2,
      { allowVisibleCanvasFallback: false, scale: 2.6 },
    );

    assert.equal(getPageCalls, 1);
    assert.equal(renderCalls, 1);
    assert.deepEqual(Buffer.from(bytes || []).toString(), "png-bytes");
  });
});

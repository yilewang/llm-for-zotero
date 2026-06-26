import { assert } from "chai";
import {
  buildPdftoppmCropArguments,
  resolveAddonRootUri,
  resolveRenderablePdfPage,
} from "../src/agent/services/pdfPageService";

describe("pdfPageService", function () {
  const globalScope = globalThis as typeof globalThis & {
    rootURI?: string;
    _globalThis?: { rootURI?: string };
  };
  let originalRootURI: string | undefined;
  let hadRootURI: boolean;
  let originalSandboxGlobal: { rootURI?: string } | undefined;
  let hadSandboxGlobal: boolean;

  beforeEach(function () {
    hadRootURI = Object.prototype.hasOwnProperty.call(globalScope, "rootURI");
    originalRootURI = globalScope.rootURI;
    hadSandboxGlobal = Object.prototype.hasOwnProperty.call(
      globalScope,
      "_globalThis",
    );
    originalSandboxGlobal = globalScope._globalThis;
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
  });

  it("resolves the addon root URI from the Zotero plugin sandbox global", function () {
    delete globalScope.rootURI;
    globalScope._globalThis = {
      rootURI: "file:///Users/yat-lok/plugin/root/",
    };

    assert.equal(
      resolveAddonRootUri(),
      "file:///Users/yat-lok/plugin/root/",
    );
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
});

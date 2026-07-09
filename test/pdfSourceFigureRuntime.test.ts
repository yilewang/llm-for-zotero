import { assert } from "chai";
import { zipSync } from "fflate";
import { PdfPageService } from "../src/agent/services/pdfPageService";
import { getPdfFigureRuntimePlatformKey } from "../src/agent/services/pdfFigureRuntimeService";

const encoder = new TextEncoder();

type SubprocessCall = {
  command: string;
  arguments: string[];
  environment?: Record<string, string>;
};

type TestGlobal = typeof globalThis & {
  ChromeUtils?: unknown;
  fetch?: unknown;
  IOUtils?: unknown;
  Services?: unknown;
  Zotero?: unknown;
  rootURI?: string;
  _globalThis?: { rootURI?: string };
};

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "") || "/";
}

function parentPath(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function addDir(dirs: Set<string>, path: string): void {
  let current = normalizePath(path);
  const ancestors: string[] = [];
  while (current && current !== "/") {
    ancestors.push(current);
    current = parentPath(current);
  }
  ancestors.push("/");
  for (const dir of ancestors.reverse()) dirs.add(dir);
}

function setupMemoryIO(files: Map<string, Uint8Array>, dirs: Set<string>) {
  return {
    exists: async (path: string) => {
      const normalized = normalizePath(path);
      return files.has(normalized) || dirs.has(normalized);
    },
    read: async (path: string) => {
      const data = files.get(normalizePath(path));
      if (!data) throw new Error(`Missing file: ${path}`);
      return data;
    },
    write: async (path: string, bytes: Uint8Array) => {
      const normalized = normalizePath(path);
      addDir(dirs, parentPath(normalized));
      files.set(normalized, bytes);
    },
    makeDirectory: async (path: string) => {
      addDir(dirs, path);
    },
    remove: async (path: string) => {
      const normalized = normalizePath(path);
      for (const key of [...files.keys()]) {
        if (key === normalized || key.startsWith(`${normalized}/`)) {
          files.delete(key);
        }
      }
      for (const key of [...dirs.keys()]) {
        if (key === normalized || key.startsWith(`${normalized}/`)) {
          dirs.delete(key);
        }
      }
    },
    getChildren: async (path: string) => {
      const normalized = normalizePath(path);
      const prefix = normalized === "/" ? "/" : `${normalized}/`;
      return [...files.keys(), ...dirs]
        .filter((entry) => entry.startsWith(prefix) && entry !== normalized)
        .filter((entry) => !entry.slice(prefix.length).includes("/"));
    },
  };
}

describe("PdfPageService source-PDF figure runtime", function () {
  const globalScope = globalThis as TestGlobal;
  let originalChromeUtils: unknown;
  let originalFetch: unknown;
  let originalIOUtils: unknown;
  let originalServices: unknown;
  let originalZotero: unknown;
  let originalRootURI: string | undefined;
  let originalSandboxGlobal: { rootURI?: string } | undefined;
  let capturedCall: SubprocessCall | null;
  let files: Map<string, Uint8Array>;
  let dirs: Set<string>;

  const attachmentItem = {
    id: 22,
    attachmentContentType: "application/pdf",
    attachmentFilename: "paper.pdf",
    getFilePath: () => "/tmp/paper.pdf",
    isAttachment: () => true,
  };

  const paperContext = {
    itemId: 11,
    contextItemId: 22,
    title: "Runtime Paper",
    attachmentTitle: "paper.pdf",
  };

  beforeEach(function () {
    originalChromeUtils = globalScope.ChromeUtils;
    originalFetch = globalScope.fetch;
    originalIOUtils = globalScope.IOUtils;
    originalServices = globalScope.Services;
    originalZotero = globalScope.Zotero;
    originalRootURI = globalScope.rootURI;
    originalSandboxGlobal = globalScope._globalThis;
    capturedCall = null;
    files = new Map<string, Uint8Array>();
    dirs = new Set<string>();
    addDir(dirs, "/tmp");
    addDir(dirs, "/tmp/zotero");
    files.set("/tmp/paper.pdf", encoder.encode("%PDF-1.7\n"));
    files.set(
      "/addon/scripts/pdf_figure_extract.py",
      encoder.encode("print('extract')\n"),
    );
    globalScope.rootURI = "file:///addon/";
    globalScope._globalThis = { rootURI: "file:///addon/" };
    globalScope.IOUtils = setupMemoryIO(files, dirs);
    globalScope.Services = {
      appinfo: { XPCOMABI: "aarch64-gcc3" },
    };
    globalScope.Zotero = {
      DataDirectory: { dir: "/tmp/zotero" },
      isMac: true,
      Items: {
        get: (id: number) => (id === 22 ? attachmentItem : null),
      },
      Prefs: {
        get: () => "",
      },
    };
    globalScope.ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async (options: SubprocessCall) => {
            capturedCall = options;
            const jsonOutIndex = options.arguments.indexOf("--json-out");
            assert.isAtLeast(jsonOutIndex, 0);
            const jsonOut = options.arguments[jsonOutIndex + 1];
            files.set(
              normalizePath(jsonOut),
              encoder.encode(
                JSON.stringify({
                  figures: [],
                  expectedFigures: [],
                  missingFigures: [],
                  warnings: [],
                }),
              ),
            );
            return {
              stdout: { readString: async () => "" },
              stderr: { readString: async () => "" },
              wait: async () => ({ exitCode: 0 }),
            };
          },
        },
      }),
    };
  });

  afterEach(function () {
    globalScope.ChromeUtils = originalChromeUtils;
    globalScope.fetch = originalFetch as typeof fetch;
    globalScope.IOUtils = originalIOUtils;
    globalScope.Services = originalServices;
    globalScope.Zotero = originalZotero;
    if (originalRootURI === undefined) delete globalScope.rootURI;
    else globalScope.rootURI = originalRootURI;
    if (originalSandboxGlobal === undefined) delete globalScope._globalThis;
    else globalScope._globalThis = originalSandboxGlobal;
  });

  async function extractWithService(overrides: Record<string, unknown> = {}) {
    const service = new PdfPageService({} as never, {} as never);
    return service.extractFiguresFromSourcePdf({
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "extract Figure 1",
        libraryID: 1,
      },
      paperContext,
      figureCacheDir: "/tmp/mineru-paper",
      mineruCacheDir: "/tmp/mineru-paper",
      query: "Figure 1",
      dpi: 216,
      ...overrides,
    } as never);
  }

  it("uses an installed managed runtime before any system runtime", async function () {
    const runtimeRoot =
      "/tmp/zotero/llm-for-zotero-runtimes/pdf-figure-extractor/1/macos-arm64";
    files.set(
      `${runtimeRoot}/runtime.json`,
      encoder.encode(
        JSON.stringify({
          kind: "llm-for-zotero/pdf-figure-runtime",
          version: "1",
          platform: "macos-arm64",
          pythonPath: "bin/python3",
          popplerBinDir: "bin",
        }),
      ),
    );
    files.set(`${runtimeRoot}/bin/python3`, encoder.encode("#!/bin/sh\n"));
    files.set(`${runtimeRoot}/bin/pdftoppm`, encoder.encode("#!/bin/sh\n"));
    files.set(`${runtimeRoot}/bin/pdftohtml`, encoder.encode("#!/bin/sh\n"));
    files.set(`${runtimeRoot}/bin/pdfinfo`, encoder.encode("#!/bin/sh\n"));

    await extractWithService();

    assert.equal(capturedCall?.command, `${runtimeRoot}/bin/python3`);
    const popplerArg = capturedCall?.arguments.indexOf("--poppler-bin") ?? -1;
    assert.isAtLeast(popplerArg, 0);
    assert.equal(capturedCall?.arguments[popplerArg + 1], `${runtimeRoot}/bin`);
    assert.match(
      capturedCall?.environment?.PATH || "",
      new RegExp(`^${runtimeRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/bin:`),
    );
  });

  it("enables MinerU manifest and content-list targets for production extraction", async function () {
    const runtimeRoot =
      "/tmp/zotero/llm-for-zotero-runtimes/pdf-figure-extractor/1/macos-arm64";
    files.set(
      `${runtimeRoot}/runtime.json`,
      encoder.encode(
        JSON.stringify({
          kind: "llm-for-zotero/pdf-figure-runtime",
          version: "1",
          platform: "macos-arm64",
          pythonPath: "bin/python3",
          popplerBinDir: "bin",
        }),
      ),
    );
    files.set(`${runtimeRoot}/bin/python3`, encoder.encode("#!/bin/sh\n"));
    files.set(`${runtimeRoot}/bin/pdftoppm`, encoder.encode("#!/bin/sh\n"));
    files.set(`${runtimeRoot}/bin/pdftohtml`, encoder.encode("#!/bin/sh\n"));
    files.set(`${runtimeRoot}/bin/pdfinfo`, encoder.encode("#!/bin/sh\n"));

    await extractWithService();

    assert.include(capturedCall?.arguments || [], "--use-mineru-targets");
    assert.include(capturedCall?.arguments || [], "--mineru-dir");
    const mineruArg = capturedCall?.arguments.indexOf("--mineru-dir") ?? -1;
    assert.equal(capturedCall?.arguments[mineruArg + 1], "/tmp/mineru-paper");
  });

  it("omits MinerU arguments for source PDFs without a MinerU cache", async function () {
    const runtimeRoot =
      "/tmp/zotero/llm-for-zotero-runtimes/pdf-figure-extractor/1/macos-arm64";
    files.set(
      `${runtimeRoot}/runtime.json`,
      encoder.encode(
        JSON.stringify({
          kind: "llm-for-zotero/pdf-figure-runtime",
          version: "1",
          platform: "macos-arm64",
          pythonPath: "bin/python3",
          popplerBinDir: "bin",
        }),
      ),
    );
    files.set(`${runtimeRoot}/bin/python3`, encoder.encode("#!/bin/sh\n"));
    files.set(`${runtimeRoot}/bin/pdftoppm`, encoder.encode("#!/bin/sh\n"));
    files.set(`${runtimeRoot}/bin/pdftohtml`, encoder.encode("#!/bin/sh\n"));
    files.set(`${runtimeRoot}/bin/pdfinfo`, encoder.encode("#!/bin/sh\n"));

    await extractWithService({
      figureCacheDir: "/tmp/pdf-figure-cache/22",
      mineruCacheDir: undefined,
    });

    assert.notInclude(capturedCall?.arguments || [], "--use-mineru-targets");
    assert.notInclude(capturedCall?.arguments || [], "--mineru-dir");
    const cropArg = capturedCall?.arguments.indexOf("--crop-dir") ?? -1;
    assert.isAtLeast(cropArg, 0);
    assert.equal(
      capturedCall?.arguments[cropArg + 1],
      "/tmp/pdf-figure-cache/22/figure_crops/crops",
    );
  });

  it("downloads and installs the managed runtime when it is missing", async function () {
    const runtimeRoot =
      "/tmp/zotero/llm-for-zotero-runtimes/pdf-figure-extractor/1/macos-arm64";
    let fetchedUrl = "";
    globalScope.fetch = async (url: string) => {
      fetchedUrl = url;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          zipSync({
            "runtime.json": encoder.encode(
              JSON.stringify({
                kind: "llm-for-zotero/pdf-figure-runtime",
                version: "1",
                platform: "macos-arm64",
                pythonPath: "bin/python3",
                popplerBinDir: "bin",
              }),
            ),
            "bin/python3": encoder.encode("#!/bin/sh\n"),
            "bin/pdftoppm": encoder.encode("#!/bin/sh\n"),
            "bin/pdftohtml": encoder.encode("#!/bin/sh\n"),
            "bin/pdfinfo": encoder.encode("#!/bin/sh\n"),
          }).buffer,
      };
    };

    await extractWithService();

    assert.equal(
      fetchedUrl,
      "https://github.com/yilewang/llm-for-zotero/releases/download/pdf-figure-runtime-v1/llm-for-zotero-pdf-figure-runtime-v1-macos-arm64.zip",
    );
    assert.isTrue(files.has(`${runtimeRoot}/runtime.json`));
    assert.equal(capturedCall?.command, `${runtimeRoot}/bin/python3`);
    const popplerArg = capturedCall?.arguments.indexOf("--poppler-bin") ?? -1;
    assert.equal(capturedCall?.arguments[popplerArg + 1], `${runtimeRoot}/bin`);
  });

  it("uses the x64 managed runtime on Windows ARM", function () {
    globalScope.Zotero = {
      ...(globalScope.Zotero as Record<string, unknown>),
      isMac: false,
      isWin: true,
    };
    globalScope.Services = {
      appinfo: { XPCOMABI: "aarch64-msvc" },
    };

    assert.equal(getPdfFigureRuntimePlatformKey(), "windows-x64");
  });

  it("uses packaged extractor scripts from Windows file URLs", async function () {
    const runtimeRoot =
      "C:\\zotero\\llm-for-zotero-runtimes\\pdf-figure-extractor\\1\\windows-x64";
    files.clear();
    dirs.clear();
    addDir(dirs, "C:\\");
    addDir(dirs, "C:\\addon");
    addDir(dirs, "C:\\zotero");
    files.set("C:/paper.pdf", encoder.encode("%PDF-1.7\n"));
    files.set(
      "C:/addon/scripts/pdf_figure_extract.py",
      encoder.encode("print('windows extract')\n"),
    );
    globalScope.rootURI = "file:///C:/addon/";
    globalScope._globalThis = { rootURI: "file:///C:/addon/" };
    globalScope.Zotero = {
      DataDirectory: { dir: "C:\\zotero" },
      isMac: false,
      isWin: true,
      Items: {
        get: (id: number) =>
          id === 22
            ? {
                ...attachmentItem,
                getFilePath: () => "C:\\paper.pdf",
              }
            : null,
      },
      Prefs: {
        get: () => "",
      },
    };
    globalScope.Services = {
      appinfo: { XPCOMABI: "aarch64-msvc" },
    };
    let fetchedUrl = "";
    globalScope.fetch = async (url: string) => {
      fetchedUrl = url;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          zipSync({
            "runtime.json": encoder.encode(
              JSON.stringify({
                kind: "llm-for-zotero/pdf-figure-runtime",
                version: "1",
                platform: "windows-x64",
                pythonPath: "python.exe",
                popplerBinDir: "Library/bin",
              }),
            ),
            "python.exe": encoder.encode("@echo off\r\n"),
            "Library/bin/pdftoppm.exe": encoder.encode("@echo off\r\n"),
            "Library/bin/pdftohtml.exe": encoder.encode("@echo off\r\n"),
            "Library/bin/pdfinfo.exe": encoder.encode("@echo off\r\n"),
          }).buffer,
      };
    };

    await extractWithService();

    assert.equal(
      fetchedUrl,
      "https://github.com/yilewang/llm-for-zotero/releases/download/pdf-figure-runtime-v1/llm-for-zotero-pdf-figure-runtime-v1-windows-x64.zip",
    );
    assert.equal(
      capturedCall?.arguments[0],
      "C:\\addon\\scripts\\pdf_figure_extract.py",
    );
    assert.equal(capturedCall?.command, `${runtimeRoot}\\python.exe`);
    const popplerArg = capturedCall?.arguments.indexOf("--poppler-bin") ?? -1;
    assert.equal(
      capturedCall?.arguments[popplerArg + 1],
      `${runtimeRoot}\\Library\\bin`,
    );
  });

  it("ignores runtime package preferences and always uses the project release URL", async function () {
    const runtimeRoot =
      "/tmp/zotero/llm-for-zotero-runtimes/pdf-figure-extractor/1/macos-arm64";
    let fetchedUrl = "";
    globalScope.fetch = async (url: string) => {
      fetchedUrl = url;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          zipSync({
            "runtime.json": encoder.encode(
              JSON.stringify({
                kind: "llm-for-zotero/pdf-figure-runtime",
                version: "1",
                platform: "macos-arm64",
                pythonPath: "bin/python3",
                popplerBinDir: "bin",
              }),
            ),
            "bin/python3": encoder.encode("#!/bin/sh\n"),
            "bin/pdftoppm": encoder.encode("#!/bin/sh\n"),
            "bin/pdftohtml": encoder.encode("#!/bin/sh\n"),
            "bin/pdfinfo": encoder.encode("#!/bin/sh\n"),
          }).buffer,
      };
    };
    globalScope.Zotero = {
      ...(globalScope.Zotero as Record<string, unknown>),
      Prefs: {
        get: (key: string) =>
          key.endsWith(".figureExtractionRuntimePackageUrl")
            ? "https://example.test/not-the-runtime.zip"
            : "",
      },
    };

    await extractWithService();

    assert.equal(
      fetchedUrl,
      "https://github.com/yilewang/llm-for-zotero/releases/download/pdf-figure-runtime-v1/llm-for-zotero-pdf-figure-runtime-v1-macos-arm64.zip",
    );
    assert.equal(capturedCall?.command, `${runtimeRoot}/bin/python3`);
  });

  it("does not use system Python or pip when the managed runtime cannot be downloaded", async function () {
    files.set("/opt/homebrew/bin/python3", encoder.encode("#!/bin/sh\n"));
    files.set("/opt/homebrew/bin/pdftoppm", encoder.encode("#!/bin/sh\n"));
    files.set("/opt/homebrew/bin/pdftohtml", encoder.encode("#!/bin/sh\n"));
    files.set("/opt/homebrew/bin/pdfinfo", encoder.encode("#!/bin/sh\n"));
    const calls: SubprocessCall[] = [];
    let fetchCalls = 0;
    globalScope.fetch = async () => {
      fetchCalls += 1;
      return {
        ok: false,
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };
    globalScope.ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async (options: SubprocessCall) => {
            calls.push(options);
            capturedCall = options;
            return {
              stdout: { readString: async () => "" },
              stderr: { readString: async () => "" },
              wait: async () => ({ exitCode: 0 }),
            };
          },
        },
      }),
    };

    let error: unknown;
    try {
      await extractWithService();
    } catch (caught) {
      error = caught;
    }

    assert.instanceOf(error, Error);
    assert.match((error as Error).message, /fetch HTTP 404/);
    assert.equal(fetchCalls, 1);
    assert.deepEqual(calls, []);
    assert.isNull(capturedCall);
  });

  it("replaces invalid installed runtime manifests with a downloaded managed runtime", async function () {
    const runtimeRoot =
      "/tmp/zotero/llm-for-zotero-runtimes/pdf-figure-extractor/1/macos-arm64";
    files.set(
      `${runtimeRoot}/runtime.json`,
      encoder.encode(
        JSON.stringify({
          kind: "llm-for-zotero/pdf-figure-runtime",
          version: "1",
          platform: "macos-arm64",
          pythonPath: "/usr/bin/python3",
          popplerBinDir: "/usr/bin",
        }),
      ),
    );
    files.set("/usr/bin/python3", encoder.encode("#!/bin/sh\n"));
    files.set("/usr/bin/pdftoppm", encoder.encode("#!/bin/sh\n"));
    files.set("/usr/bin/pdftohtml", encoder.encode("#!/bin/sh\n"));
    files.set("/usr/bin/pdfinfo", encoder.encode("#!/bin/sh\n"));
    let fetched = false;
    globalScope.fetch = async () => {
      fetched = true;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          zipSync({
            "runtime.json": encoder.encode(
              JSON.stringify({
                kind: "llm-for-zotero/pdf-figure-runtime",
                version: "1",
                platform: "macos-arm64",
                pythonPath: "bin/python3",
                popplerBinDir: "bin",
              }),
            ),
            "bin/python3": encoder.encode("#!/bin/sh\n"),
            "bin/pdftoppm": encoder.encode("#!/bin/sh\n"),
            "bin/pdftohtml": encoder.encode("#!/bin/sh\n"),
            "bin/pdfinfo": encoder.encode("#!/bin/sh\n"),
          }).buffer,
      };
    };

    await extractWithService();

    assert.isTrue(fetched);
    assert.equal(capturedCall?.command, `${runtimeRoot}/bin/python3`);
    assert.notEqual(capturedCall?.command, "/usr/bin/python3");
  });

  it("does not use user-specific fallback runtime paths", async function () {
    const legacyHome = ["", "Users", "yat" + "-lok"].join("/");
    const personalPopplerBin = [
      legacyHome,
      ".cache",
      "codex" + "-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "bin",
    ].join("/");
    files.set(
      [legacyHome, "mini" + "conda3", "bin", "python3"].join("/"),
      encoder.encode("#!/bin/sh\n"),
    );
    files.set(`${personalPopplerBin}/pdftoppm`, encoder.encode("#!/bin/sh\n"));
    files.set(`${personalPopplerBin}/pdftohtml`, encoder.encode("#!/bin/sh\n"));
    files.set(`${personalPopplerBin}/pdfinfo`, encoder.encode("#!/bin/sh\n"));
    globalScope.fetch = undefined;

    let error: unknown;
    try {
      await extractWithService();
    } catch (caught) {
      error = caught;
    }

    assert.instanceOf(error, Error);
    assert.match(
      (error as Error).message,
      /No downloader is available|fetch is not a function/i,
    );
    assert.isNull(capturedCall);
  });
});

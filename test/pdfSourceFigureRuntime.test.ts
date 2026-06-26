import { assert } from "chai";
import { zipSync } from "fflate";
import { PdfPageService } from "../src/agent/services/pdfPageService";

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
        get: (key: string) =>
          key.endsWith(".figureExtractionRuntimeAllowSystemFallback")
            ? false
            : "",
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

  async function extractWithService() {
    const service = new PdfPageService({} as never, {} as never);
    return service.extractFiguresFromSourcePdf({
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "extract Figure 1",
        libraryID: 1,
      },
      paperContext,
      mineruCacheDir: "/tmp/mineru-paper",
      query: "Figure 1",
      dpi: 216,
    });
  }

  it("passes the resolved Poppler directory to the packaged extractor", async function () {
    files.set("/opt/homebrew/bin/python3", encoder.encode("#!/bin/sh\n"));
    files.set("/opt/homebrew/bin/pdftoppm", encoder.encode("#!/bin/sh\n"));
    files.set("/opt/homebrew/bin/pdftohtml", encoder.encode("#!/bin/sh\n"));
    files.set("/opt/homebrew/bin/pdfinfo", encoder.encode("#!/bin/sh\n"));
    globalScope.Zotero = {
      ...(globalScope.Zotero as Record<string, unknown>),
      Prefs: {
        get: (key: string) =>
          key.endsWith(".figureExtractionRuntimeAllowSystemFallback")
            ? true
            : "",
      },
    };

    await extractWithService();

    assert.equal(capturedCall?.command, "/opt/homebrew/bin/python3");
    const popplerArg = capturedCall?.arguments.indexOf("--poppler-bin") ?? -1;
    assert.isAtLeast(popplerArg, 0);
    assert.equal(capturedCall?.arguments[popplerArg + 1], "/opt/homebrew/bin");
    assert.match(
      capturedCall?.environment?.PATH || "",
      /^\/opt\/homebrew\/bin:/,
    );
  });

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
    globalScope.Zotero = {
      ...(globalScope.Zotero as Record<string, unknown>),
      Prefs: {
        get: (key: string) =>
          key.endsWith(".figureExtractionRuntimePackageUrl")
            ? "https://example.test/runtime-{platform}.zip"
            : "",
      },
    };

    await extractWithService();

    assert.equal(fetchedUrl, "https://example.test/runtime-macos-arm64.zip");
    assert.isTrue(files.has(`${runtimeRoot}/runtime.json`));
    assert.equal(capturedCall?.command, `${runtimeRoot}/bin/python3`);
    const popplerArg = capturedCall?.arguments.indexOf("--poppler-bin") ?? -1;
    assert.equal(capturedCall?.arguments[popplerArg + 1], `${runtimeRoot}/bin`);
  });

  it("ignores installed runtime manifests that point outside the runtime root", async function () {
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
  });
});

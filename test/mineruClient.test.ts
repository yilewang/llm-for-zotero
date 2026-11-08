import { mineruLegacyHealth } from "./helpers/mineruLegacyHealth";
import { parsePdfWithMineru } from "../src/services/mineru/mineruParser";
import { PDFDocument } from "pdf-lib";
import { createPdfFixture } from "./helpers/pdfFixture";
import {
  installPdfWorkerTestHost,
  closePdfWorkersForTests,
} from "./helpers/pdfWorkerHost";
import { assert } from "chai";
import { readFileSync } from "fs";
import { zipSync } from "fflate";
import {
  buildCloudBatchRequestBody,
  buildMineruCloudProgressMessageForTests,
  getMineruCloudPollDecisionForTests,
  MineruCancelledError,
  MineruPageLimitError,
  parsePdfWithMineruCloud,
  parsePdfWithMineruLocal,
  getMineruParseSettings,
  resetMineruLocalFileParseGateForTests,
  setMineruLocalBusyRetryDelaysForTests,
} from "../src/utils/mineruClient";

const MINUTE_MS = 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LONG_PDF_FILE_NAME =
  "Incorporating DeepLabv3 and object-based image analysis for semantic segmentation of very high resolution remote sensing images-dual.pdf";
const LONG_PDF_PATH = `/tmp/${LONG_PDF_FILE_NAME}`;
const LONG_COMMON_PREFIX = "shared-prefix-".repeat(8);
const LONG_PDF_PATH_A = `/tmp/${LONG_COMMON_PREFIX}first.pdf`;
const LONG_PDF_PATH_B = `/tmp/${LONG_COMMON_PREFIX}second.pdf`;
const LONG_UNICODE_PDF_PATH = `/tmp/${"论文😀".repeat(40)}.pdf`;
const EXACT_LIMIT_PDF_FILE_NAME = `${"a".repeat(76)}.pdf`;
const EXACT_LIMIT_PDF_PATH = `/tmp/${EXACT_LIMIT_PDF_FILE_NAME}`;
const WINDOWS_LEGACY_MAX_PATH_CHARS = 260;
const MINERU_WINDOWS_OUTPUT_ROOT =
  "C:\\Users\\researcher\\Documents\\local-ai-services\\mineru-runtime\\outputs";
const MINERU_TASK_ID = "19e9a6ce-d8ac-48c9-8a4f-8b9e24997d49";

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function createMineruZip(markdown: string): Uint8Array {
  return zipSync({
    "full.md": bytes(markdown),
    "content_list.json": bytes("[]"),
  });
}

function setupLocalMineruClientTest(files: Record<string, string>): void {
  const fileBytes = new Map<string, Uint8Array>();
  for (const [path, value] of Object.entries(files)) {
    fileBytes.set(path, bytes(value));
  }
  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    isWin: false,
    version: "test",
    Prefs: { get: () => undefined },
  };
  (globalThis as unknown as { ztoolkit: unknown }).ztoolkit = {
    getGlobal: (name: string) => {
      if (name === "fetch")
        return (url: string, init: RequestInit) => {
          const health = mineruLegacyHealth(String(url));
          if (health) return Promise.resolve(health);
          return globalThis.fetch(url, init);
        };
      if (name === "AbortController") return AbortController;
      return undefined;
    },
    log: () => {},
  };
  (globalThis as unknown as { IOUtils: unknown }).IOUtils = {
    read: async (path: string) => {
      const data = fileBytes.get(path);
      if (!data) throw new Error("missing");
      return data;
    },
  };
}

function setupChunkingTest(source: Uint8Array): Map<string, Uint8Array> {
  setupLocalMineruClientTest({});
  const files = new Map<string, Uint8Array>([["/tmp/long.pdf", source]]);
  Object.assign((globalThis as any).Zotero, {
    getTempDirectory: () => ({ path: "/tmp" }),
    Prefs: { get: () => "" },
  });
  (globalThis as any).IOUtils = {
    read: async (path: string) => {
      const data = files.get(path.replace(/\\/g, "/"));
      if (!data) throw new Error("missing");
      return data;
    },
    write: async (path: string, data: Uint8Array) => files.set(path, data),
    makeDirectory: async () => {},
    remove: async () => {},
  };
  installPdfWorkerTestHost();
  return files;
}

async function readMultipartTextField(
  body: BodyInit | null | undefined,
  name: string,
): Promise<string> {
  if (!body) return "";
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const value = body.get(name);
    return typeof value === "string" ? value : "";
  }
  const text =
    typeof body === "string"
      ? body
      : body instanceof ArrayBuffer
        ? decoder.decode(new Uint8Array(body))
        : ArrayBuffer.isView(body)
          ? decoder.decode(
              new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
            )
          : await new Response(body).text();
  const nameMarker = `name="${name}"`;
  const fieldIndex = text.indexOf(nameMarker);
  if (fieldIndex < 0) return "";
  const valueStart = text.indexOf("\r\n\r\n", fieldIndex);
  if (valueStart < 0) return "";
  const valueEnd = text.indexOf("\r\n", valueStart + 4);
  return text.slice(valueStart + 4, valueEnd < 0 ? undefined : valueEnd);
}

async function readMultipartFileName(
  body: BodyInit | null | undefined,
  name: string,
): Promise<string> {
  if (!body) return "";
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const value = body.get(name) as { name?: unknown } | null;
    return typeof value?.name === "string" ? value.name : "";
  }
  const text =
    typeof body === "string"
      ? body
      : body instanceof ArrayBuffer
        ? decoder.decode(new Uint8Array(body))
        : ArrayBuffer.isView(body)
          ? decoder.decode(
              new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
            )
          : await new Response(body).text();
  const nameMarker = `name="${name}"`;
  const fieldIndex = text.indexOf(nameMarker);
  if (fieldIndex < 0) return "";
  const headerEnd = text.indexOf("\r\n\r\n", fieldIndex);
  if (headerEnd < 0) return "";
  const header = text.slice(fieldIndex, headerEnd);
  return /filename="([^"]*)"/.exec(header)?.[1] || "";
}

function buildMineruWindowsOutputPath(
  outputRoot: string,
  taskId: string,
  uploadFileName: string,
): string {
  const stem = uploadFileName.replace(/\.pdf$/i, "");
  return `${outputRoot}\\${taskId}\\${stem}\\ocr\\${stem}.md`;
}

describe("mineruClient", function () {
  describe("getMineruParseSettings", function () {
    it("excludes localServerCommand and localServerIdleMinutes so parse progress keys remain stable", function () {
      const originalZotero = (globalThis as any).Zotero;
      (globalThis as any).Zotero = {
        Prefs: {
          get: () => undefined,
          set: () => {},
        },
      };
      try {
        const settings = getMineruParseSettings();
        assert.isUndefined((settings as any).localServerCommand);
        assert.isUndefined((settings as any).localServerIdleMinutes);
      } finally {
        (globalThis as any).Zotero = originalZotero;
      }
    });
  });

  describe("bundled PDF chunking", function () {
    afterEach(async function () {
      await closePdfWorkersForTests();
      delete (globalThis as unknown as { Zotero?: unknown }).Zotero;
      delete (globalThis as unknown as { ztoolkit?: unknown }).ztoolkit;
      delete (globalThis as unknown as { IOUtils?: unknown }).IOUtils;
      delete (globalThis as unknown as { ChromeUtils?: unknown }).ChromeUtils;
      delete (globalThis as unknown as { Components?: unknown }).Components;
      delete (globalThis as unknown as { Services?: unknown }).Services;
    });

    for (const limit of [0, 500, 200]) {
      it(`applies whole-document limit ${limit} before splitting and merges all allowed chunks`, async function () {
        const originalFetch = globalThis.fetch;
        const removed: string[] = [];
        let uploads = 0;
        const files = setupChunkingTest(createPdfFixture(401, 50));
        (globalThis as any).Zotero.Prefs.get = (key: string) => {
          if (key.endsWith(".mineruMode")) return "local";
          if (key.endsWith(".mineruLocalBackend")) return "hybrid";
          if (key.endsWith(".mineruForceOcr")) return true;
          return "";
        };
        (globalThis as any).IOUtils.remove = async (path: string) => {
          removed.push(path);
        };
        globalThis.fetch = (async (_url, init) => {
          uploads++;
          assert.equal(
            await readMultipartTextField(init?.body, "backend"),
            "hybrid-engine",
          );
          assert.equal(
            await readMultipartTextField(init?.body, "parse_method"),
            "ocr",
          );
          return new Response(
            zipSync({
              "full.md": bytes(
                `# Part ${uploads}\n\n![figure](images/figure.png)`,
              ),
              "content_list.json": bytes(
                JSON.stringify([
                  { type: "image", page_idx: 0, img_path: "images/figure.png" },
                ]),
              ),
              "images/figure.png": bytes(`image ${uploads}`),
            }),
            { status: 200 },
          );
        }) as typeof fetch;
        try {
          if (limit === 200) {
            let error: unknown;
            try {
              await parsePdfWithMineru("/tmp/long.pdf", undefined, undefined, {
                maxPages: limit,
              });
            } catch (caught) {
              error = caught;
            }
            assert.instanceOf(error, MineruPageLimitError);
            assert.equal(files.size, 1);
            assert.equal(uploads, 0);
          } else {
            const result = await parsePdfWithMineru(
              "/tmp/long.pdf",
              undefined,
              undefined,
              { maxPages: limit },
            );
            assert.isNotNull(result);
            const pageCounts: number[] = [];
            for (const [path, data] of files) {
              if (path === "/tmp/long.pdf") continue;
              pageCounts.push((await PDFDocument.load(data)).getPageCount());
            }
            assert.deepEqual(pageCounts, [200, 200, 1]);
            assert.equal(uploads, 3);
            assert.isBelow(
              result!.mdContent.indexOf("# Part 1"),
              result!.mdContent.indexOf("# Part 2"),
            );
            assert.isBelow(
              result!.mdContent.indexOf("# Part 2"),
              result!.mdContent.indexOf("# Part 3"),
            );
            const list = JSON.parse(
              decoder.decode(
                result!.files.find(
                  (file) => file.relativePath === "content_list.json",
                )!.data,
              ),
            );
            assert.deepEqual(
              list.map((item: any) => item.page_idx),
              [0, 200, 400],
            );
            for (const chunk of ["001", "002", "003"]) {
              assert.include(
                result!.mdContent,
                `images/chunk-${chunk}/images/figure.png`,
              );
              assert.isTrue(
                result!.files.some(
                  (file) =>
                    file.relativePath ===
                    `images/chunk-${chunk}/images/figure.png`,
                ),
              );
            }
            assert.isTrue(
              removed.some((path) => /mineru-chunks-[^/]+$/.test(path)),
              "cleans temporary chunks after merging",
            );
          }
        } finally {
          globalThis.fetch = originalFetch;
          resetMineruLocalFileParseGateForTests();
        }
      });
    }

    for (const stage of ["Reading PDF page count", "Splitting PDF"]) {
      it(`preserves cancellation during ${stage}`, async function () {
        setupChunkingTest(createPdfFixture(401));
        const removed: string[] = [];
        (globalThis as any).IOUtils.remove = async (path: string) =>
          removed.push(path);
        const controller = new AbortController();
        let error: unknown;
        try {
          await parsePdfWithMineru(
            "/tmp/long.pdf",
            (message) => {
              if (message.startsWith(stage)) controller.abort();
            },
            controller.signal,
          );
        } catch (caught) {
          error = caught;
        }
        assert.instanceOf(error, MineruCancelledError);
        if (stage === "Splitting PDF") {
          assert.lengthOf(removed, 1, "cleans chunks on cancellation");
        }
      });
    }

    it("cleans temporary chunks when an upload fails", async function () {
      const originalFetch = globalThis.fetch;
      setupChunkingTest(createPdfFixture(401));
      (globalThis as any).Zotero.Prefs.get = (key: string) =>
        key.endsWith(".mineruMode") ? "local" : "";
      const removed: string[] = [];
      (globalThis as any).IOUtils.remove = async (path: string) =>
        removed.push(path);
      globalThis.fetch = (async () =>
        new Response("Failure", { status: 400 })) as typeof fetch;
      try {
        assert.isNull(await parsePdfWithMineru("/tmp/long.pdf"));
        assert.lengthOf(removed, 1);
      } finally {
        globalThis.fetch = originalFetch;
        resetMineruLocalFileParseGateForTests();
      }
    });
  });

  describe("cloud poll policy", function () {
    it("includes server-reported page progress for active jobs", function () {
      const message = buildMineruCloudProgressMessageForTests("running", 94, {
        extracted_pages: 37,
        total_pages: 200,
      });

      assert.include(message, "37/200");
      assert.include(message, "94");
    });

    it("times out pending jobs after the pre-processing window", function () {
      const decision = getMineruCloudPollDecisionForTests({
        state: "pending",
        nowMs: 30 * MINUTE_MS,
        pollStartMs: 0,
        lastStatusAtMs: 30 * MINUTE_MS,
        activeStartedAtMs: null,
      });

      assert.equal(decision.action, "timeout");
      if (decision.action === "timeout") {
        assert.equal(decision.reason, "pre_processing");
        assert.equal(decision.phase, "pre_processing");
      }
    });

    it("does not time out active running or converting jobs", function () {
      for (const state of ["running", "converting"]) {
        const decision = getMineruCloudPollDecisionForTests({
          state,
          nowMs: 3 * 60 * MINUTE_MS,
          pollStartMs: 0,
          lastStatusAtMs: 3 * 60 * MINUTE_MS,
          activeStartedAtMs: 5 * MINUTE_MS,
        });

        assert.equal(decision.action, "continue");
        if (decision.action === "continue") {
          assert.equal(decision.phase, "active_processing");
          assert.equal(decision.pollIntervalMs, 60 * 1000);
        }
      }
    });

    it("times out when polling stops returning usable status", function () {
      const noStatusFromStart = getMineruCloudPollDecisionForTests({
        state: null,
        nowMs: 10 * MINUTE_MS,
        pollStartMs: 0,
        lastStatusAtMs: null,
        activeStartedAtMs: null,
      });

      assert.equal(noStatusFromStart.action, "timeout");
      if (noStatusFromStart.action === "timeout") {
        assert.equal(noStatusFromStart.reason, "no_status");
      }

      const malformedAfterStatus = getMineruCloudPollDecisionForTests({
        state: "",
        nowMs: 20 * MINUTE_MS,
        pollStartMs: 0,
        lastStatusAtMs: 10 * MINUTE_MS,
        activeStartedAtMs: null,
      });

      assert.equal(malformedAfterStatus.action, "timeout");
      if (malformedAfterStatus.action === "timeout") {
        assert.equal(malformedAfterStatus.reason, "no_status");
      }
    });

    it("keeps done and failed states terminal", function () {
      for (const state of ["done", "failed"] as const) {
        const decision = getMineruCloudPollDecisionForTests({
          state,
          nowMs: 90 * MINUTE_MS,
          pollStartMs: 0,
          lastStatusAtMs: 90 * MINUTE_MS,
          activeStartedAtMs: null,
        });

        assert.equal(decision.action, "terminal");
        if (decision.action === "terminal") {
          assert.equal(decision.terminalState, state);
        }
      }
    });
  });

  describe("cloud batch request", function () {
    let originalZtoolkit: unknown;

    beforeEach(function () {
      originalZtoolkit = (globalThis as unknown as { ztoolkit?: unknown })
        .ztoolkit;
      (globalThis as unknown as { ztoolkit: unknown }).ztoolkit = {
        log: () => {},
      };
    });

    afterEach(function () {
      if (originalZtoolkit === undefined) {
        delete (globalThis as unknown as { ztoolkit?: unknown }).ztoolkit;
      } else {
        (globalThis as unknown as { ztoolkit: unknown }).ztoolkit =
          originalZtoolkit;
      }
    });

    it("uses the selected cloud model in the batch request body", function () {
      assert.deepEqual(
        buildCloudBatchRequestBody({
          fileName: "paper.pdf",
          modelVersion: "vlm",
        }),
        {
          enable_formula: true,
          enable_table: true,
          language: "ch",
          model_version: "vlm",
          files: [{ name: "paper.pdf", is_ocr: false }],
        },
      );
    });

    it("keeps vlm as the default cloud batch model", function () {
      assert.equal(
        buildCloudBatchRequestBody({ fileName: "paper.pdf" }).model_version,
        "vlm",
      );
    });

    it("sets cloud file is_ocr when force OCR is enabled", function () {
      assert.deepEqual(
        buildCloudBatchRequestBody({
          fileName: "paper.pdf",
          forceOcr: true,
        }).files,
        [{ name: "paper.pdf", is_ocr: true }],
      );
    });

    it("returns a clear key-required result before reading the PDF", async function () {
      const progress: string[] = [];

      const result = await parsePdfWithMineruCloud(
        "/tmp/missing-paper.pdf",
        "   ",
        "pipeline",
        (stage) => progress.push(stage),
      );

      assert.isNull(result);
      assert.deepEqual(progress, [
        "MinerU API key required. Add it in Settings.",
      ]);
    });

    it("does not retain the community proxy fallback", function () {
      const source = readFileSync("src/utils/mineruClient.ts", "utf8");
      assert.notInclude(source, "llm-for-zotero.ylwwayne.workers.dev");
      assert.notInclude(source, "MINERU_PROXY_API_BASE");
      assert.notInclude(source, "testProxyConnection");
    });
  });

  describe("local file_parse", function () {
    let originalFetch: typeof fetch;

    beforeEach(function () {
      originalFetch = globalThis.fetch;
      resetMineruLocalFileParseGateForTests();
      setupLocalMineruClientTest({
        "/tmp/paper.pdf": "%PDF-1.7",
        "/tmp/paper-2.pdf": "%PDF-1.7",
        [LONG_PDF_PATH]: "%PDF-1.7",
        [LONG_PDF_PATH_A]: "%PDF-1.7",
        [LONG_PDF_PATH_B]: "%PDF-1.7",
        [LONG_UNICODE_PDF_PATH]: "%PDF-1.7",
        [EXACT_LIMIT_PDF_PATH]: "%PDF-1.7",
      });
    });

    afterEach(function () {
      globalThis.fetch = originalFetch;
      resetMineruLocalFileParseGateForTests();
      delete (globalThis as unknown as { Zotero?: unknown }).Zotero;
      delete (globalThis as unknown as { ztoolkit?: unknown }).ztoolkit;
      delete (globalThis as unknown as { IOUtils?: unknown }).IOUtils;
    });

    it("retries a transient local HTTP 409 and parses the successful retry", async function () {
      setMineruLocalBusyRetryDelaysForTests([1]);
      const progress: string[] = [];
      let callCount = 0;
      globalThis.fetch = (async () => {
        callCount++;
        if (callCount === 1) {
          return new Response("busy", { status: 409 });
        }
        return new Response(createMineruZip("# Parsed after busy retry"), {
          status: 200,
        });
      }) as typeof fetch;

      const result = await parsePdfWithMineruLocal(
        "/tmp/paper.pdf",
        "http://127.0.0.1:58659",
        "pipeline",
        (stage) => progress.push(stage),
      );

      assert.equal(callCount, 2);
      assert.equal(result?.mdContent, "# Parsed after busy retry");
      assert.isTrue(
        progress.some((stage) =>
          stage.includes("Local MinerU server is busy; retrying in 1s"),
        ),
      );
    });

    it("stops retrying local HTTP 409 after the bounded retry budget", async function () {
      setMineruLocalBusyRetryDelaysForTests([1, 1]);
      const progress: string[] = [];
      let callCount = 0;
      globalThis.fetch = (async () => {
        callCount++;
        return new Response("still busy", { status: 409 });
      }) as typeof fetch;

      const result = await parsePdfWithMineruLocal(
        "/tmp/paper.pdf",
        "http://127.0.0.1:58659",
        "pipeline",
        (stage) => progress.push(stage),
      );

      assert.isNull(result);
      assert.equal(callCount, 3);
      assert.include(
        progress[progress.length - 1],
        "Local MinerU server is still busy after 2 retries",
      );
    });

    it("honors abort while waiting to retry local HTTP 409", async function () {
      setMineruLocalBusyRetryDelaysForTests([1000]);
      const controller = new AbortController();
      globalThis.fetch = (async () =>
        new Response("busy", { status: 409 })) as typeof fetch;

      let thrown: unknown = null;
      try {
        await parsePdfWithMineruLocal(
          "/tmp/paper.pdf",
          "http://127.0.0.1:58659",
          "pipeline",
          (stage) => {
            if (stage.includes("Local MinerU server is busy")) {
              controller.abort();
            }
          },
          controller.signal,
        );
      } catch (error) {
        thrown = error;
      }

      assert.instanceOf(thrown, MineruCancelledError);
    });

    it("sends parse_method=ocr when force OCR is enabled", async function () {
      let submittedBody: BodyInit | null | undefined;
      globalThis.fetch = (async (_url, init) => {
        submittedBody = init?.body;
        return new Response(createMineruZip("# Parsed with OCR"), {
          status: 200,
        });
      }) as typeof fetch;

      const result = await parsePdfWithMineruLocal(
        "/tmp/paper.pdf",
        "http://127.0.0.1:58659",
        "pipeline",
        undefined,
        undefined,
        true,
      );

      assert.equal(result?.mdContent, "# Parsed with OCR");
      assert.equal(
        await readMultipartTextField(submittedBody, "parse_method"),
        "ocr",
      );
    });

    it("uses a hash-only multipart filename for a short ASCII name", async function () {
      let submittedBody: BodyInit | null | undefined;
      globalThis.fetch = (async (_url, init) => {
        submittedBody = init?.body;
        return new Response(createMineruZip("# Parsed short filename"), {
          status: 200,
        });
      }) as typeof fetch;

      const result = await parsePdfWithMineruLocal(
        "/tmp/paper.pdf",
        "http://127.0.0.1:58659",
        "pipeline",
      );

      assert.equal(result?.mdContent, "# Parsed short filename");
      const fileName = await readMultipartFileName(submittedBody, "files");
      assert.equal(encoder.encode(fileName).byteLength, 16);
      assert.match(fileName, /^[a-f0-9]{12}\.pdf$/);
      assert.notEqual(fileName, "paper.pdf");
    });

    it("hashes a filename at the previous byte limit", async function () {
      let submittedBody: BodyInit | null | undefined;
      globalThis.fetch = (async (_url, init) => {
        submittedBody = init?.body;
        return new Response(createMineruZip("# Parsed boundary filename"), {
          status: 200,
        });
      }) as typeof fetch;

      await parsePdfWithMineruLocal(
        EXACT_LIMIT_PDF_PATH,
        "http://127.0.0.1:58659",
        "pipeline",
      );

      const fileName = await readMultipartFileName(submittedBody, "files");
      assert.equal(encoder.encode(fileName).byteLength, 16);
      assert.match(fileName, /^[a-f0-9]{12}\.pdf$/);
      assert.notEqual(fileName, EXACT_LIMIT_PDF_FILE_NAME);
    });

    it("shortens long multipart filenames deterministically", async function () {
      const submittedBodies: Array<BodyInit | null | undefined> = [];
      globalThis.fetch = (async (_url, init) => {
        submittedBodies.push(init?.body);
        return new Response(createMineruZip("# Parsed long filename"), {
          status: 200,
        });
      }) as typeof fetch;

      await parsePdfWithMineruLocal(
        LONG_PDF_PATH,
        "http://127.0.0.1:58659",
        "pipeline",
      );
      await parsePdfWithMineruLocal(
        LONG_PDF_PATH,
        "http://127.0.0.1:58659",
        "pipeline",
      );

      const firstName = await readMultipartFileName(
        submittedBodies[0],
        "files",
      );
      const secondName = await readMultipartFileName(
        submittedBodies[1],
        "files",
      );
      assert.equal(firstName, secondName);
      assert.equal(encoder.encode(firstName).byteLength, 16);
      assert.match(firstName, /^[a-f0-9]{12}\.pdf$/);
      assert.notEqual(firstName, LONG_PDF_FILE_NAME);
    });

    it("hashes the unsafe boundary before building MinerU output paths", async function () {
      let submittedBody: BodyInit | null | undefined;
      globalThis.fetch = (async (_url, init) => {
        submittedBody = init?.body;
        return new Response(createMineruZip("# Parsed nested output path"), {
          status: 200,
        });
      }) as typeof fetch;

      await parsePdfWithMineruLocal(
        EXACT_LIMIT_PDF_PATH,
        "http://127.0.0.1:58659",
        "pipeline",
      );

      const unsafeBoundaryPath = buildMineruWindowsOutputPath(
        MINERU_WINDOWS_OUTPUT_ROOT,
        MINERU_TASK_ID,
        EXACT_LIMIT_PDF_FILE_NAME,
      );
      const submittedName = await readMultipartFileName(submittedBody, "files");
      const fixedPath = buildMineruWindowsOutputPath(
        MINERU_WINDOWS_OUTPUT_ROOT,
        MINERU_TASK_ID,
        submittedName,
      );

      assert.isAtLeast(
        unsafeBoundaryPath.length,
        WINDOWS_LEGACY_MAX_PATH_CHARS,
      );
      assert.match(submittedName, /^[a-f0-9]{12}\.pdf$/);
      assert.notEqual(submittedName, EXACT_LIMIT_PDF_FILE_NAME);
      assert.isBelow(fixedPath.length, WINDOWS_LEGACY_MAX_PATH_CHARS);
    });

    it("keeps distinct hashes for long names with a shared prefix", async function () {
      const submittedBodies: Array<BodyInit | null | undefined> = [];
      globalThis.fetch = (async (_url, init) => {
        submittedBodies.push(init?.body);
        return new Response(createMineruZip("# Parsed shared prefix"), {
          status: 200,
        });
      }) as typeof fetch;

      await parsePdfWithMineruLocal(
        LONG_PDF_PATH_A,
        "http://127.0.0.1:58659",
        "pipeline",
      );
      await parsePdfWithMineruLocal(
        LONG_PDF_PATH_B,
        "http://127.0.0.1:58659",
        "pipeline",
      );

      const firstName = await readMultipartFileName(
        submittedBodies[0],
        "files",
      );
      const secondName = await readMultipartFileName(
        submittedBodies[1],
        "files",
      );
      assert.notEqual(firstName, secondName);
      assert.match(firstName, /^[a-f0-9]{12}\.pdf$/);
      assert.match(secondName, /^[a-f0-9]{12}\.pdf$/);
    });

    it("uses a hash-only multipart filename for long Unicode names", async function () {
      let submittedBody: BodyInit | null | undefined;
      globalThis.fetch = (async (_url, init) => {
        submittedBody = init?.body;
        return new Response(createMineruZip("# Parsed Unicode filename"), {
          status: 200,
        });
      }) as typeof fetch;

      await parsePdfWithMineruLocal(
        LONG_UNICODE_PDF_PATH,
        "http://127.0.0.1:58659",
        "pipeline",
      );

      const fileName = await readMultipartFileName(submittedBody, "files");
      assert.equal(encoder.encode(fileName).byteLength, 16);
      assert.match(fileName, /^[a-f0-9]{12}\.pdf$/);
    });

    it("reports an unavailable SHA-256 implementation for long names", async function () {
      const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        "crypto",
      );
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: undefined,
      });
      let fetchCalled = false;
      const progress: string[] = [];
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return new Response(createMineruZip("# Unexpected parse"), {
          status: 200,
        });
      }) as typeof fetch;

      try {
        const result = await parsePdfWithMineruLocal(
          LONG_PDF_PATH,
          "http://127.0.0.1:58659",
          "pipeline",
          (stage) => progress.push(stage),
        );

        assert.isNull(result);
        assert.isFalse(fetchCalled);
        assert.include(
          progress[progress.length - 1],
          "SHA-256 is unavailable for MinerU filename normalization",
        );
      } finally {
        if (originalCryptoDescriptor) {
          Object.defineProperty(globalThis, "crypto", originalCryptoDescriptor);
        } else {
          delete (globalThis as { crypto?: Crypto }).crypto;
        }
      }
    });

    it("serializes concurrent local file_parse submissions in this process", async function () {
      let fetchCount = 0;
      let activeFetches = 0;
      let maxActiveFetches = 0;
      let releaseFirstFetch: (() => void) | null = null;
      let firstFetchStarted: (() => void) | null = null;
      const firstFetchStartedPromise = new Promise<void>((resolve) => {
        firstFetchStarted = resolve;
      });

      globalThis.fetch = (() => {
        fetchCount++;
        activeFetches++;
        maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
        const markdown = `# Parsed ${fetchCount}`;
        const finish = () => {
          activeFetches--;
          return new Response(createMineruZip(markdown), { status: 200 });
        };
        if (fetchCount === 1) {
          firstFetchStarted?.();
          return new Promise<Response>((resolve) => {
            releaseFirstFetch = () => resolve(finish());
          });
        }
        return Promise.resolve(finish());
      }) as typeof fetch;

      const firstParse = parsePdfWithMineruLocal(
        "/tmp/paper.pdf",
        "http://127.0.0.1:58659",
        "pipeline",
      );
      await firstFetchStartedPromise;

      const secondParse = parsePdfWithMineruLocal(
        "/tmp/paper-2.pdf",
        "http://127.0.0.1:58659",
        "pipeline",
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(fetchCount, 1);
      releaseFirstFetch?.();
      const [firstResult, secondResult] = await Promise.all([
        firstParse,
        secondParse,
      ]);

      assert.equal(maxActiveFetches, 1);
      assert.equal(fetchCount, 2);
      assert.equal(firstResult?.mdContent, "# Parsed 1");
      assert.equal(secondResult?.mdContent, "# Parsed 2");
    });
  });
});

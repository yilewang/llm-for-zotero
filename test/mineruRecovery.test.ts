import { mineruLegacyHealth } from "./helpers/mineruLegacyHealth";
import { mineruResultFixture } from "./helpers/mineruResultFixture";
import {
  getMineruCheckpointDir,
  getMineruCheckpointProgress,
} from "../src/services/mineru/mineruCheckpoint";
import {
  getMineruStatus,
  clearAllStatuses,
  runMineruTaskOnce,
  cancelMineruTaskAndWait,
} from "../src/modules/mineruProcessingStatus";
import {
  readCachedMineruMd,
  readManifest,
  ensureManifest,
  hasCachedMineruMd,
  finalizeExistingMineruCache,
  getMineruItemDir,
  invalidateMineruMd,
} from "../src/services/mineru/mineruCache";
import { buildMineruSyncPackageBytes } from "../src/services/mineru/sync";
import {
  parsePdfWithMineru,
  publishMineruParsedResult,
} from "../src/services/mineru/mineruParser";
import { assert } from "chai";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { zipSync } from "fflate";
import { MineruCancelledError } from "../src/utils/mineruClient";
import { createPdfFixture } from "./helpers/pdfFixture";
import {
  installPdfWorkerTestHost,
  closePdfWorkersForTests,
} from "./helpers/pdfWorkerHost";

const bytes = (s: string) => new TextEncoder().encode(s);
describe("MinerU durable recovery", function () {
  this.timeout(10000);
  let root: string;
  let originalFetch: typeof fetch;
  beforeEach(async function () {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mineru-recovery-"));
    originalFetch = globalThis.fetch;
    (globalThis as any).Zotero = {
      isWin: false,
      version: "test",
      DataDirectory: { dir: root },
      getTempDirectory: () => ({ path: root }),
      Prefs: {
        get: (key: string) => (key.endsWith(".mineruMode") ? "local" : ""),
      },
    };
    (globalThis as any).ztoolkit = {
      log() {},
      getGlobal: (key: string) =>
        key === "fetch"
          ? async (url: string, init: RequestInit) =>
              mineruLegacyHealth(String(url)) ?? globalThis.fetch(url, init)
          : (globalThis as any)[key],
    };
    (globalThis as any).PathUtils = {
      join: path.join,
      parent: path.dirname,
      filename: path.basename,
    };
    (globalThis as any).IOUtils = {
      read: async (p: string) => new Uint8Array(await fs.readFile(p)),
      exists: async (p: string) =>
        fs.access(p).then(
          () => true,
          () => false,
        ),
      makeDirectory: async (p: string) => fs.mkdir(p, { recursive: true }),
      write: async (
        p: string,
        data: Uint8Array,
        options?: { tmpPath?: string },
      ) => {
        await fs.writeFile(options?.tmpPath || p, data);
        if (options?.tmpPath) await fs.rename(options.tmpPath, p);
      },
      remove: async (p: string) => fs.rm(p, { recursive: true, force: true }),
      getChildren: async (p: string) =>
        (await fs.readdir(p)).map((name) => path.join(p, name)),
    };
    installPdfWorkerTestHost();
  });
  afterEach(async function () {
    clearAllStatuses();
    await closePdfWorkersForTests();
    globalThis.fetch = originalFetch;
    for (const key of ["Zotero", "ztoolkit", "IOUtils", "PathUtils"])
      delete (globalThis as any)[key];
    await fs.rm(root, { recursive: true, force: true });
  });
  it("saves completed chunk 1 across cancellation and resumes with chunk 2", async function () {
    const source = path.join(root, "source.pdf");
    await fs.writeFile(source, createPdfFixture(401));
    const uploads: number[] = [];
    let activeChunk = 0;
    globalThis.fetch = (async () => {
      uploads.push(activeChunk);
      return new Response(
        zipSync({
          "full.md": bytes(
            `# Chapter ${activeChunk}\n\nSaved chunk ${activeChunk}.`,
          ),
          "content_list.json": bytes(
            JSON.stringify([
              {
                type: "text",
                text_level: 1,
                text: `Chapter ${activeChunk}`,
                page_idx: 0,
              },
            ]),
          ),
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const controller = new AbortController();
    const progress = (stage: string) => {
      const match = /^Uploading MinerU chunk (\d+)\//.exec(stage);
      if (match) activeChunk = Number(match[1]);
      if (activeChunk === 2) controller.abort();
    };
    let error: unknown;
    try {
      await parsePdfWithMineru(source, progress, controller.signal, {
        attachmentId: 4242,
      });
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, MineruCancelledError);
    assert.deepEqual(uploads, [1]);
    await closePdfWorkersForTests();
    const result = await parsePdfWithMineru(
      source,
      (stage) => {
        const match = /^Uploading MinerU chunk (\d+)\//.exec(stage);
        if (match) activeChunk = Number(match[1]);
      },
      undefined,
      { attachmentId: 4242 },
    );
    assert.isNotNull(result);
    assert.deepEqual(
      uploads,
      [1, 2, 3],
      "completed work survives cancellation and is not uploaded twice",
    );
  });
  async function fixture() {
    const source = path.join(root, "source.pdf");
    await fs.writeFile(source, createPdfFixture(401));
    const item = {
      id: 4242,
      key: "TESTPDF1",
      libraryID: 1,
      attachmentContentType: "application/pdf",
      isAttachment: () => true,
      getFilePathAsync: async () => source,
    } as unknown as Zotero.Item;
    (globalThis as any).Zotero.Items = {
      get: (id: number) => (id === item.id ? item : null),
    };
    const uploads: number[] = [];
    let active = 0;
    globalThis.fetch = (async () => {
      uploads.push(active);
      return new Response(mineruResultFixture(active), { status: 200 });
    }) as typeof fetch;
    const parse = (stopAfter?: number) => {
      const controller = new AbortController();
      return parsePdfWithMineru(
        source,
        (stage) => {
          const match = /^Uploading MinerU chunk (\d+)\//.exec(stage);
          if (match) active = Number(match[1]);
          if (
            stopAfter &&
            stage === `Saved MinerU checkpoint: ${stopAfter * 200}/401 pages`
          )
            controller.abort();
        },
        controller.signal,
        { attachmentId: item.id },
      );
    };
    return { source, item, uploads, parse };
  }

  for (const damage of ["corrupt", "missing"] as const) {
    it(`reuploads only the ${damage} checkpoint, retaining other completed chunks`, async function () {
      const f = await fixture();
      await f
        .parse(2)
        .catch((error) => assert.instanceOf(error, MineruCancelledError));
      const saved = path.join(getMineruCheckpointDir(f.item.id), "chunk-1.zip");
      if (damage === "corrupt") await fs.writeFile(saved, "broken");
      else await fs.rm(saved);
      assert.isNotNull(await f.parse());
      assert.deepEqual(f.uploads, [1, 2, 1, 3]);
    });
  }
  for (const change of ["source", "settings"] as const) {
    it(`invalidates checkpoints when ${change} changes`, async function () {
      const f = await fixture();
      await f
        .parse(1)
        .catch((error) => assert.instanceOf(error, MineruCancelledError));
      if (change === "source")
        await fs.appendFile(f.source, "\n% changed source");
      else
        (globalThis as any).Zotero.Prefs.get = (key: string) =>
          key.endsWith(".mineruMode")
            ? "local"
            : key.endsWith(".mineruForceOcr");
      assert.isNotNull(await f.parse());
      assert.deepEqual(f.uploads, [1, 1, 2, 3]);
    });
  }
  it("withholds failed publication from status, retrieval and sync, then retries without reupload", async function () {
    const f = await fixture();
    const result = await f.parse();
    const io = (globalThis as any).IOUtils;
    const write = io.write;
    io.write = async (p: string, data: Uint8Array, options: unknown) => {
      if (path.basename(p) === "manifest.json")
        throw new Error("simulated disk full");
      return write(p, data, options);
    };
    let failure: unknown;
    try {
      await publishMineruParsedResult(f.item, result!);
    } catch (error) {
      failure = error;
    }
    assert.include(String(failure), "simulated disk full");
    assert.isTrue(
      await io.exists(path.join(getMineruItemDir(f.item.id), "full.md")),
      "failure occurs after Markdown is written",
    );
    assert.equal(await getMineruStatus(f.item.id), "partial");
    assert.isFalse(await hasCachedMineruMd(f.item.id));
    assert.isNull(await readCachedMineruMd(f.item.id));
    assert.isNull(await readManifest(f.item.id));
    assert.isNull(await ensureManifest(f.item.id));
    assert.isFalse(await finalizeExistingMineruCache(f.item.id));
    assert.isNull(await buildMineruSyncPackageBytes(f.item));
    io.write = write;
    await publishMineruParsedResult(f.item, (await f.parse())!);
    assert.deepEqual(f.uploads, [1, 2, 3]);
    assert.equal(await getMineruStatus(f.item.id), "cached");
    assert.isNull(await getMineruCheckpointProgress(f.item.id));
    const md = (await readCachedMineruMd(f.item.id))!;
    const manifest = (await readManifest(f.item.id))!;
    assert.equal(manifest.totalPages, 401);
    assert.equal(manifest.totalChars, md.length);
    assert.deepEqual(
      manifest.sections.map((s) => s.page),
      [0, 200, 400],
    );
    assert.deepEqual(
      manifest.allFigures.map((f) => f.page),
      [0, 200, 400],
    );
    assert.deepEqual(
      manifest.allTables.map((f) => f.page),
      [0, 200, 400],
    );
    for (const [i, section] of manifest.sections.entries()) {
      const text = md.slice(section.charStart, section.charEnd);
      assert.include(text, `CHUNK ${i + 1} START`);
      assert.include(text, `CHUNK ${i + 1} END`);
    }
    assert.isNotNull(await buildMineruSyncPackageBytes(f.item));
  });
  it("does not publish output for a PDF changed during parsing", async function () {
    const f = await fixture();
    const result = await f.parse();
    await fs.appendFile(f.source, "\n% source replaced");
    let error: unknown;
    try {
      await publishMineruParsedResult(f.item, result!);
    } catch (caught) {
      error = caught;
    }
    assert.include(String(error), "PDF changed");
    assert.isFalse(await hasCachedMineruMd(f.item.id));
    assert.isNotNull(await getMineruCheckpointProgress(f.item.id));
  });
  it("does not count an archive as completed if its atomic index write fails", async function () {
    const f = await fixture();
    const io = (globalThis as any).IOUtils;
    const write = io.write;
    let indexWrites = 0;
    io.write = async (p: string, data: Uint8Array, options: unknown) => {
      if (path.basename(p) === "checkpoint.json" && ++indexWrites === 2)
        throw new Error("index write failed");
      return write(p, data, options);
    };
    assert.isNull(await f.parse());
    assert.isNull(await getMineruCheckpointProgress(f.item.id));
    io.write = write;
    assert.isNotNull(await f.parse());
    assert.deepEqual(f.uploads, [1, 1, 2, 3]);
  });
  it("waits for an in-flight checkpoint write before explicit deletion", async function () {
    const f = await fixture();
    const io = (globalThis as any).IOUtils;
    const write = io.write;
    let reached!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    io.write = async (p: string, data: Uint8Array, options: unknown) => {
      if (path.basename(p) === "chunk-1.zip") {
        reached();
        await gate;
      }
      return write(p, data, options);
    };
    const task = runMineruTaskOnce(f.item.id, (_report, signal) =>
      parsePdfWithMineru(f.source, undefined, signal, {
        attachmentId: f.item.id,
      }),
    ).catch((error) => assert.instanceOf(error, MineruCancelledError));
    await started;
    let removed = false;
    const deletion = (async () => {
      await cancelMineruTaskAndWait(f.item.id);
      await invalidateMineruMd(f.item.id);
      removed = true;
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.isFalse(removed, "deletion waits until the writer has stopped");
    release();
    await Promise.all([task, deletion]);
    assert.isFalse(await io.exists(getMineruCheckpointDir(f.item.id)));
    assert.isNull(await getMineruCheckpointProgress(f.item.id));
  });
});

import { assert } from "chai";
import { zipSync } from "fflate";
import {
  flushAutoWatchReadinessRetryForTests,
  getAutoWatchStatus,
  getAutoWatchReadinessRetryCountForTests,
  getAutoWatchQueueSnapshotForTests,
  handleAutoWatchNotificationForTests,
  isAutoWatchQueueEntryCurrentForTests,
  processAutoWatchQueueForTests,
  resetAutoWatchForTests,
  stopAutoWatch,
} from "../src/modules/mineruAutoWatch";
import {
  clearAllStatuses,
  getAllFailedIds,
  getAllProcessingIds,
  getItemStatus,
  runMineruTaskOnce,
  setItemProcessing,
} from "../src/modules/mineruProcessingStatus";
import {
  hasCachedMineruMd,
  readCachedMineruMd,
  writeMineruCacheFiles,
} from "../src/modules/contextPanel/mineruCache";
import { pdfTextCache } from "../src/modules/contextPanel/state";
import { clearMineruEligibilityCacheForTests } from "../src/modules/mineruParseEligibility";
import { MineruCancelledError } from "../src/utils/mineruClient";

const encoder = new TextEncoder();

type MockItem = {
  id: number;
  key: string;
  libraryID: number;
  parentID?: number;
  itemType?: string;
  attachmentContentType?: string;
  attachmentFilename?: string;
  attachmentSyncedHash?: string;
  deleted?: boolean;
  attachmentIDs?: number[];
  isAttachment: () => boolean;
  isRegularItem?: () => boolean;
  getAttachments?: () => number[];
  getCollections?: () => number[];
  getField?: (field: string) => string;
  getFilePathAsync?: () => Promise<string | false>;
};

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function pdfText(pageCount: number): string {
  return `%PDF-1.7
1 0 obj
<< /Type /Pages /Count ${pageCount} /Kids [] >>
endobj`;
}

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

function setupZotero(
  items: Map<number, MockItem>,
  options: { pref?: (key: string) => unknown } = {},
): {
  files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  addDir(dirs, "/tmp/zotero");

  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    isWin: false,
    DataDirectory: { dir: "/tmp/zotero" },
    getTempDirectory: () => ({ path: "/tmp" }),
    Prefs: {
      get: (key: string) => {
        const override = options.pref?.(key);
        if (override !== undefined) return override;
        if (key.endsWith(".mineruGlobalAutoParse")) return true;
        if (key.endsWith(".mineruSyncEnabled")) return false;
        if (key.endsWith(".mineruMaxAutoPages")) return 100;
        if (key.endsWith(".mineruExcludePatterns")) return "";
        return "";
      },
      set: () => {},
    },
    Items: {
      get: (id: number) => items.get(id) || null,
    },
  };
  (globalThis as unknown as { ztoolkit: unknown }).ztoolkit = {
    getGlobal: (name: string) => {
      if (name === "AbortController") return AbortController;
      if (name === "fetch") return globalThis.fetch;
      return undefined;
    },
    log: () => {},
  };
  const io = {
    exists: async (path: string) => {
      const normalized = normalizePath(path);
      return files.has(normalized) || dirs.has(normalized);
    },
    read: async (path: string) => {
      const normalized = normalizePath(path);
      const data = files.get(normalized);
      if (!data) throw new Error("missing");
      return data;
    },
    makeDirectory: async (path: string) => {
      addDir(dirs, path);
    },
    write: async (path: string, data: Uint8Array) => {
      const normalized = normalizePath(path);
      addDir(dirs, parentPath(normalized));
      files.set(normalized, data);
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
  };
  (globalThis as unknown as { IOUtils: unknown }).IOUtils = io;
  return { files };
}

function completedProcess(stdout = "") {
  let stdoutRead = false;
  return {
    stdout: {
      readString: async () => {
        if (stdoutRead) return "";
        stdoutRead = true;
        return stdout;
      },
    },
    stderr: { readString: async () => "" },
    wait: async () => ({ exitCode: 0 }),
    kill: () => {},
  };
}

function installPdftkMock(
  files: Map<string, Uint8Array>,
  originalPageCount: number,
): void {
  const splitPageCounts = new Map<string, number>();
  (globalThis as unknown as { ChromeUtils: unknown }).ChromeUtils = {
    importESModule: () => ({
      Subprocess: {
        call: async ({ command, arguments: args }: any) => {
          if (command === "which") {
            return completedProcess("/mock/pdftk\n");
          }
          if (args[1] === "dump_data") {
            const pageCount =
              splitPageCounts.get(normalizePath(args[0])) ?? originalPageCount;
            files.set(
              normalizePath(args[3]),
              bytes(`NumberOfPages: ${pageCount}\n`),
            );
            return completedProcess();
          }
          if (args[1] === "cat") {
            const range = /^(\d+)-(\d+)$/.exec(args[2]);
            if (!range) throw new Error(`Unexpected page range: ${args[2]}`);
            const outputPath = normalizePath(args[4]);
            splitPageCounts.set(
              outputPath,
              Number(range[2]) - Number(range[1]) + 1,
            );
            files.set(outputPath, bytes("%PDF-1.7"));
            return completedProcess();
          }
          throw new Error(`Unexpected subprocess command: ${command}`);
        },
      },
    }),
  };
}

function createParent(id = 201, attachmentIDs: number[] = [202]): MockItem {
  return {
    id,
    key: `PARENT${id}`,
    libraryID: 1,
    itemType: "journalArticle",
    attachmentIDs,
    isAttachment: () => false,
    isRegularItem: () => true,
    getAttachments() {
      return this.attachmentIDs || [];
    },
    getField: (field) => (field === "title" ? "Parent Paper" : ""),
  };
}

function createPdf(id = 202, parentID = 201): MockItem {
  return {
    id,
    key: `PDF${id}`,
    libraryID: 1,
    parentID,
    itemType: "attachment",
    attachmentContentType: "application/pdf",
    attachmentFilename: "paper.pdf",
    attachmentSyncedHash: "hash-a",
    isAttachment: () => true,
    isRegularItem: () => false,
    getField: (field) => (field === "title" ? "Paper PDF" : ""),
    getFilePathAsync: async () => "/tmp/paper.pdf",
  };
}

function createMineruZip(markdown: string): Uint8Array {
  return zipSync({
    "full.md": bytes(markdown),
    "content_list.json": bytes("[]"),
  });
}

async function waitForAutoWatchStatus(message: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (getAutoWatchStatus().statusMessage.includes(message)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`Timed out waiting for auto-watch status: ${message}`);
}

describe("mineruAutoWatch", function () {
  afterEach(function () {
    resetAutoWatchForTests();
    clearMineruEligibilityCacheForTests();
    clearAllStatuses();
    delete (globalThis as unknown as { Zotero?: unknown }).Zotero;
    delete (globalThis as unknown as { ztoolkit?: unknown }).ztoolkit;
    delete (globalThis as unknown as { IOUtils?: unknown }).IOUtils;
    delete (globalThis as unknown as { ChromeUtils?: unknown }).ChromeUtils;
    pdfTextCache.clear();
  });

  it("removes a newly queued PDF when Zotero later deletes that attachment", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
    ]);
    setupZotero(items);

    await handleAutoWatchNotificationForTests("add", "item", [pdf.id]);
    assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 1);

    items.delete(pdf.id);
    await handleAutoWatchNotificationForTests("delete", "item", [pdf.id]);

    assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 0);
    assert.isUndefined(getItemStatus(pdf.id));
  });

  it("cleans queued, local, and runtime MinerU state when a PDF is trashed", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
    ]);
    setupZotero(items);

    await handleAutoWatchNotificationForTests("add", "item", [pdf.id]);
    assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 1);

    await writeMineruCacheFiles(pdf.id, "# stale", []);
    pdfTextCache.set(pdf.id, {
      title: "stale",
      chunks: ["stale"],
      chunkMeta: [],
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 1,
      fullLength: 7,
      sourceType: "mineru",
    });

    pdf.deleted = true;
    await handleAutoWatchNotificationForTests("trash", "item", [pdf.id]);

    assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 0);
    assert.isUndefined(getItemStatus(pdf.id));
    assert.isFalse(await hasCachedMineruMd(pdf.id));
    assert.isFalse(pdfTextCache.has(pdf.id));
  });

  it("keeps live PDFs queued when a non-deletion remove notification arrives", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
    ]);
    setupZotero(items);

    await handleAutoWatchNotificationForTests("add", "item", [pdf.id]);
    assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 1);

    await handleAutoWatchNotificationForTests("remove", "item", [pdf.id]);

    assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 1);
    assert.isTrue(
      isAutoWatchQueueEntryCurrentForTests(
        getAutoWatchQueueSnapshotForTests()[0],
      ),
    );
  });

  it("skips a queued PDF that no longer exists before processing", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
    ]);
    setupZotero(items);

    await handleAutoWatchNotificationForTests("add", "item", [pdf.id]);
    items.delete(pdf.id);

    await processAutoWatchQueueForTests();

    assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 0);
    assert.deepEqual(getAllProcessingIds(), []);
    assert.deepEqual(getAllFailedIds(), []);
    assert.isUndefined(getItemStatus(pdf.id));
  });

  it("keeps a current valid PDF attachment eligible for auto-parse", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
    ]);
    setupZotero(items);

    await handleAutoWatchNotificationForTests("add", "item", [pdf.id]);

    const queue = getAutoWatchQueueSnapshotForTests();
    assert.lengthOf(queue, 1);
    assert.equal(queue[0].attachmentId, pdf.id);
    assert.isTrue(isAutoWatchQueueEntryCurrentForTests(queue[0]));
    assert.include(
      getAutoWatchStatus().statusMessage,
      "Queued for MinerU auto-parse",
    );
  });

  it("auto-enqueues Zotero book PDFs when they are under the page limit", async function () {
    const parent = createParent();
    parent.itemType = "book";
    const pdf = createPdf();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
    ]);
    const io = setupZotero(items);
    io.files.set("/tmp/paper.pdf", bytes(pdfText(42)));

    await handleAutoWatchNotificationForTests("add", "item", [pdf.id]);

    const queue = getAutoWatchQueueSnapshotForTests();
    assert.lengthOf(queue, 1);
    assert.equal(queue[0].attachmentId, pdf.id);
  });

  it("does not auto-enqueue filename-excluded PDFs", async function () {
    const parent = createParent();
    const pdf = createPdf();
    pdf.attachmentFilename = "paper_translated.pdf";
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
    ]);
    setupZotero(items, {
      pref: (key) =>
        key.endsWith(".mineruExcludePatterns")
          ? JSON.stringify(["translated"])
          : undefined,
    });

    await handleAutoWatchNotificationForTests("add", "item", [pdf.id]);

    assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 0);
  });

  it("does not auto-enqueue PDFs over the configured page limit", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
    ]);
    const io = setupZotero(items);
    io.files.set("/tmp/paper.pdf", bytes(pdfText(150)));

    await handleAutoWatchNotificationForTests("add", "item", [pdf.id]);

    assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 0);
  });

  it("applies the authoritative page count before automatic submission", async function () {
    const firstParent = createParent(201, [202]);
    const firstPdf = createPdf(202, 201);
    firstPdf.getFilePathAsync = async () => "/tmp/missing-count.pdf";
    const secondParent = createParent(301, [302]);
    const secondPdf = createPdf(302, 301);
    secondPdf.getFilePathAsync = async () => "/tmp/under-count.pdf";
    const items = new Map<number, MockItem>([
      [firstParent.id, firstParent],
      [firstPdf.id, firstPdf],
      [secondParent.id, secondParent],
      [secondPdf.id, secondPdf],
    ]);
    const io = setupZotero(items);
    io.files.set("/tmp/missing-count.pdf", bytes("%PDF-1.7"));
    io.files.set("/tmp/under-count.pdf", bytes(pdfText(50)));
    installPdftkMock(io.files, 412);
    let requestCount = 0;
    (globalThis as any).Zotero.HTTP = {
      request: async () => {
        requestCount++;
        return { status: 500, responseText: "" };
      },
    };

    await handleAutoWatchNotificationForTests("add", "item", [
      firstPdf.id,
      secondPdf.id,
    ]);
    assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 2);

    await processAutoWatchQueueForTests();

    assert.equal(requestCount, 0);
    assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 0);
    assert.deepEqual(getAllFailedIds(), []);
  });

  it("pauses and preserves the queue when a chunk hits the daily quota", async function () {
    const firstParent = createParent(201, [202]);
    const firstPdf = createPdf(202, 201);
    firstPdf.getFilePathAsync = async () => "/tmp/first-long.pdf";
    const secondParent = createParent(301, [302]);
    const secondPdf = createPdf(302, 301);
    secondPdf.getFilePathAsync = async () => "/tmp/second-long.pdf";
    const items = new Map<number, MockItem>([
      [firstParent.id, firstParent],
      [firstPdf.id, firstPdf],
      [secondParent.id, secondParent],
      [secondPdf.id, secondPdf],
    ]);
    const io = setupZotero(items, {
      pref: (key) => {
        if (key.endsWith(".mineruMaxAutoPages")) return 500;
        if (key.endsWith(".mineruApiKey")) return "test-key";
        return undefined;
      },
    });
    io.files.set("/tmp/first-long.pdf", bytes(pdfText(401)));
    io.files.set("/tmp/second-long.pdf", bytes(pdfText(401)));
    installPdftkMock(io.files, 401);
    let requestCount = 0;
    (globalThis as any).Zotero.HTTP = {
      request: async () => {
        requestCount++;
        return { status: 429, responseText: "" };
      },
    };

    await handleAutoWatchNotificationForTests("add", "item", [
      firstPdf.id,
      secondPdf.id,
    ]);
    await processAutoWatchQueueForTests();

    assert.equal(requestCount, 1);
    assert.isTrue(getAutoWatchStatus().isPaused);
    assert.sameMembers(
      getAutoWatchQueueSnapshotForTests().map((entry) => entry.attachmentId),
      [firstPdf.id, secondPdf.id],
    );
    assert.equal(getAutoWatchReadinessRetryCountForTests(), 0);
  });

  it("does not enqueue a duplicate PDF while that PDF is actively parsing", async function () {
    const originalFetch = globalThis.fetch;
    let resolveFetch: ((response: Response) => void) | null = null;
    let fetchStarted: (() => void) | null = null;
    const fetchStartedPromise = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    globalThis.fetch = (() => {
      fetchStarted?.();
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    }) as typeof fetch;

    try {
      const parent = createParent();
      const pdf = createPdf();
      const items = new Map<number, MockItem>([
        [parent.id, parent],
        [pdf.id, pdf],
      ]);
      const io = setupZotero(items, {
        pref: (key) => (key.endsWith(".mineruMode") ? "local" : undefined),
      });
      io.files.set("/tmp/paper.pdf", bytes("%PDF-1.7"));

      await handleAutoWatchNotificationForTests("add", "item", [pdf.id]);
      assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 1);

      const processing = processAutoWatchQueueForTests();
      await fetchStartedPromise;
      assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 0);
      assert.include(
        getAutoWatchStatus().statusMessage,
        "Uploading to local server",
      );

      await handleAutoWatchNotificationForTests("add", "item", [pdf.id]);
      assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 0);

      assert.exists(resolveFetch);
      resolveFetch?.(new Response("failed", { status: 500 }));
      await processing;
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("stops waiting immediately when auto-watch joins a batch-owned task", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
    ]);
    setupZotero(items);

    let releaseOwner: (() => void) | null = null;
    let sharedSignal: AbortSignal | undefined;
    const owner = runMineruTaskOnce(pdf.id, async (report, signal) => {
      sharedSignal = signal;
      report("Batch owner running");
      await new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
      return { mdContent: "# batch owner", files: [] };
    });

    await handleAutoWatchNotificationForTests("add", "item", [pdf.id]);
    const auto = processAutoWatchQueueForTests();
    await waitForAutoWatchStatus("Batch owner running");

    stopAutoWatch();
    await auto;

    assert.isFalse(sharedSignal?.aborted ?? false);
    assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 0);
    assert.isFalse(getAutoWatchStatus().isProcessing);

    assert.exists(releaseOwner);
    releaseOwner?.();
    await owner;
  });

  it("deletion cancels a batch-owned task even when auto-watch only joined it", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
    ]);
    setupZotero(items);

    let sharedSignal: AbortSignal | undefined;
    const owner = runMineruTaskOnce(pdf.id, async (report, signal) => {
      sharedSignal = signal;
      report("Batch owner running");
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new MineruCancelledError()),
          { once: true },
        );
      });
      return { mdContent: "# unreachable", files: [] };
    });
    const ownerOutcome = owner.then(
      () => null,
      (error) => error,
    );

    await handleAutoWatchNotificationForTests("add", "item", [pdf.id]);
    const auto = processAutoWatchQueueForTests();
    await waitForAutoWatchStatus("Batch owner running");

    items.delete(pdf.id);
    await handleAutoWatchNotificationForTests("delete", "item", [pdf.id]);
    await auto;

    const ownerError = await ownerOutcome;
    assert.isTrue(sharedSignal?.aborted ?? false);
    assert.instanceOf(ownerError, MineruCancelledError);
    assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 0);
    assert.isUndefined(getItemStatus(pdf.id));
  });

  it("deletion cancels a batch-owned task even when auto-watch never joined it", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
    ]);
    setupZotero(items);

    let sharedSignal: AbortSignal | undefined;
    const owner = runMineruTaskOnce(pdf.id, async (_report, signal) => {
      sharedSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new MineruCancelledError()),
          { once: true },
        );
      });
      return { mdContent: "# unreachable", files: [] };
    });
    const ownerOutcome = owner.then(
      () => null,
      (error) => error,
    );
    await Promise.resolve();
    assert.exists(sharedSignal);

    items.delete(pdf.id);
    await handleAutoWatchNotificationForTests("delete", "item", [pdf.id]);

    const ownerError = await ownerOutcome;
    assert.isTrue(sharedSignal?.aborted ?? false);
    assert.instanceOf(ownerError, MineruCancelledError);
    assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 0);
    assert.isUndefined(getItemStatus(pdf.id));
  });

  it("retries a newly added PDF when Zotero has not resolved its file path yet", async function () {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(createMineruZip("# Parsed after retry"), {
        status: 200,
      })) as typeof fetch;

    try {
      const parent = createParent();
      const pdf = createPdf();
      let fileReady = false;
      pdf.getFilePathAsync = async () => (fileReady ? "/tmp/paper.pdf" : false);
      const items = new Map<number, MockItem>([
        [parent.id, parent],
        [pdf.id, pdf],
      ]);
      const io = setupZotero(items, {
        pref: (key) => (key.endsWith(".mineruMode") ? "local" : undefined),
      });
      io.files.set("/tmp/paper.pdf", bytes("%PDF-1.7"));

      await handleAutoWatchNotificationForTests("add", "item", [pdf.id]);
      await processAutoWatchQueueForTests();

      assert.equal(getAutoWatchReadinessRetryCountForTests(), 1);
      assert.deepEqual(getAllFailedIds(), []);
      assert.equal(getItemStatus(pdf.id)?.status, "processing");

      fileReady = true;
      assert.isTrue(flushAutoWatchReadinessRetryForTests(pdf.id));
      await processAutoWatchQueueForTests();

      assert.isTrue(await hasCachedMineruMd(pdf.id));
      assert.equal(await readCachedMineruMd(pdf.id), "# Parsed after retry");
      assert.equal(getAutoWatchReadinessRetryCountForTests(), 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses a later modify notification to retry a pending file-readiness failure", async function () {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(createMineruZip("# Parsed after modify"), {
        status: 200,
      })) as typeof fetch;

    try {
      const parent = createParent();
      const pdf = createPdf();
      let fileReady = false;
      pdf.getFilePathAsync = async () => (fileReady ? "/tmp/paper.pdf" : false);
      const items = new Map<number, MockItem>([
        [parent.id, parent],
        [pdf.id, pdf],
      ]);
      const io = setupZotero(items, {
        pref: (key) => (key.endsWith(".mineruMode") ? "local" : undefined),
      });
      io.files.set("/tmp/paper.pdf", bytes("%PDF-1.7"));

      await handleAutoWatchNotificationForTests("add", "item", [pdf.id]);
      await processAutoWatchQueueForTests();
      assert.equal(getAutoWatchReadinessRetryCountForTests(), 1);

      fileReady = true;
      await handleAutoWatchNotificationForTests("modify", "item", [pdf.id]);
      assert.equal(getAutoWatchReadinessRetryCountForTests(), 0);
      assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 1);

      await processAutoWatchQueueForTests();

      assert.isTrue(await hasCachedMineruMd(pdf.id));
      assert.equal(await readCachedMineruMd(pdf.id), "# Parsed after modify");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects a PDF that is no longer listed by its parent item", async function () {
    const parent = createParent(201, []);
    const pdf = createPdf();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
    ]);
    setupZotero(items);

    const entry = {
      attachmentId: pdf.id,
      title: "Parent Paper",
      parentItemId: parent.id,
    };

    assert.isFalse(isAutoWatchQueueEntryCurrentForTests(entry));
  });

  it("ignores modified PDFs during auto-watch when a cache already exists", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
    ]);
    setupZotero(items);

    await writeMineruCacheFiles(pdf.id, "# Old parse", [
      { relativePath: "content_list.json", data: bytes("[]") },
    ]);
    pdf.attachmentSyncedHash = "hash-b";

    await handleAutoWatchNotificationForTests("modify", "item", [pdf.id]);

    assert.isTrue(await hasCachedMineruMd(pdf.id));
    assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 0);
  });

  it("ignores modified PDFs that are already being processed", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
    ]);
    setupZotero(items);
    setItemProcessing(pdf.id);

    await handleAutoWatchNotificationForTests("modify", "item", [pdf.id]);

    assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 0);
  });

  it("keeps a modified PDF cache when attachment metadata changes", async function () {
    const parent = createParent();
    const pdf = createPdf();
    const items = new Map<number, MockItem>([
      [parent.id, parent],
      [pdf.id, pdf],
    ]);
    setupZotero(items);

    await writeMineruCacheFiles(pdf.id, "# Current parse", [
      { relativePath: "content_list.json", data: bytes("[]") },
    ]);
    pdf.attachmentFilename = "renamed.pdf";

    await handleAutoWatchNotificationForTests("modify", "item", [pdf.id]);

    assert.isTrue(await hasCachedMineruMd(pdf.id));
    assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 0);
  });
});

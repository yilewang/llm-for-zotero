import { assert } from "chai";
import { zipSync } from "fflate";
import {
  flushAutoWatchReadinessRetryForTests,
  getAutoWatchReadinessRetryCountForTests,
  getAutoWatchQueueSnapshotForTests,
  handleAutoWatchNotificationForTests,
  isAutoWatchQueueEntryCurrentForTests,
  processAutoWatchQueueForTests,
  resetAutoWatchForTests,
} from "../src/modules/mineruAutoWatch";
import {
  clearAllStatuses,
  getAllFailedIds,
  getAllProcessingIds,
  getItemStatus,
} from "../src/modules/mineruProcessingStatus";
import {
  hasCachedMineruMd,
  readCachedMineruMd,
  writeMineruCacheFiles,
} from "../src/modules/contextPanel/mineruCache";

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
    DataDirectory: { dir: "/tmp/zotero" },
    Prefs: {
      get: (key: string) => {
        const override = options.pref?.(key);
        if (override !== undefined) return override;
        if (key.endsWith(".mineruGlobalAutoParse")) return true;
        if (key.endsWith(".mineruSyncEnabled")) return false;
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

describe("mineruAutoWatch", function () {
  afterEach(function () {
    resetAutoWatchForTests();
    clearAllStatuses();
    delete (globalThis as unknown as { Zotero?: unknown }).Zotero;
    delete (globalThis as unknown as { ztoolkit?: unknown }).ztoolkit;
    delete (globalThis as unknown as { IOUtils?: unknown }).IOUtils;
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

      await handleAutoWatchNotificationForTests("add", "item", [pdf.id]);
      assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 0);

      assert.exists(resolveFetch);
      resolveFetch?.(new Response("failed", { status: 500 }));
      await processing;
    } finally {
      globalThis.fetch = originalFetch;
    }
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

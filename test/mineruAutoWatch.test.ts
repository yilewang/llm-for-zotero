import { assert } from "chai";
import {
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
  writeMineruCacheFiles,
  writeMineruSourceProvenanceForAttachment,
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

function setupZotero(items: Map<number, MockItem>): {
  files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  addDir(dirs, "/tmp/zotero");

  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    DataDirectory: { dir: "/tmp/zotero" },
    Prefs: {
      get: (key: string) => {
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
    getGlobal: (name: string) =>
      name === "AbortController" ? AbortController : undefined,
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

  it("invalidates and requeues a modified PDF when its fingerprint changed", async function () {
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
    await writeMineruSourceProvenanceForAttachment(
      pdf as unknown as Zotero.Item,
    );
    pdf.attachmentSyncedHash = "hash-b";

    await handleAutoWatchNotificationForTests("modify", "item", [pdf.id]);

    assert.isFalse(await hasCachedMineruMd(pdf.id));
    const queue = getAutoWatchQueueSnapshotForTests();
    assert.lengthOf(queue, 1);
    assert.equal(queue[0].attachmentId, pdf.id);
  });

  it("keeps a modified PDF cache when the fingerprint is unchanged", async function () {
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
    await writeMineruSourceProvenanceForAttachment(
      pdf as unknown as Zotero.Item,
    );
    pdf.attachmentFilename = "renamed.pdf";

    await handleAutoWatchNotificationForTests("modify", "item", [pdf.id]);

    assert.isTrue(await hasCachedMineruMd(pdf.id));
    assert.lengthOf(getAutoWatchQueueSnapshotForTests(), 0);
  });
});

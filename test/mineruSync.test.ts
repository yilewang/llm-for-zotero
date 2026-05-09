import { assert } from "chai";
import { unzipSync } from "fflate";
import {
  isMineruSyncEnabled,
  setMineruSyncEnabled,
} from "../src/utils/mineruConfig";
import {
  getMineruItemDir,
  hasCachedMineruMd,
  readCachedMineruMd,
  writeMineruCacheFiles,
} from "../src/modules/contextPanel/mineruCache";
import { pdfTextCache } from "../src/modules/contextPanel/state";
import {
  buildMineruSyncPackageBytes,
  cleanSyncedMineruPackages,
  ensureMineruCacheDirForAttachment,
  ensureMineruRuntimeCacheForAttachment,
  getMineruAvailabilityForAttachment,
  MINERU_SYNC_ATTACHMENT_TITLE_PREFIX,
  MINERU_SYNC_METADATA_FILE,
  publishMineruCachePackageForAttachment,
  repairSyncedMineruCacheForAttachment,
  restoreSyncedMineruCacheForAttachment,
  shouldIncludeMineruCachePackageEntry,
} from "../src/modules/contextPanel/mineruSync";
import { createReadLibraryTool } from "../src/agent/tools/read/readLibrary";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type MockItem = {
  id: number;
  key: string;
  libraryID: number;
  parentID?: number;
  attachmentContentType?: string;
  attachmentFilename?: string;
  deleted?: boolean;
  attachmentIDs?: number[];
  isAttachment: () => boolean;
  isRegularItem?: () => boolean;
  getAttachments?: () => number[];
  getField?: (field: string) => string;
  setField?: (field: string, value: string) => void;
  saveTx: () => Promise<void>;
  getFilePathAsync?: () => Promise<string | false>;
};

type MemoryIO = {
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
  remove: (path: string) => Promise<void>;
};

function bytes(value: string | number[]): Uint8Array {
  return typeof value === "string"
    ? encoder.encode(value)
    : new Uint8Array(value);
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

function setupMemoryIO(): MemoryIO {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  addDir(dirs, "/tmp/zotero");
  addDir(dirs, "/tmp/zotero-tmp");

  const remove = async (path: string) => {
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
  };

  const io = {
    exists: async (path: string) => {
      const normalized = normalizePath(path);
      return files.has(normalized) || dirs.has(normalized);
    },
    read: async (path: string) => {
      const normalized = normalizePath(path);
      const data = files.get(normalized);
      if (!data) throw new Error(`Missing file: ${path}`);
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
    remove,
    getChildren: async (path: string) => {
      const normalized = normalizePath(path);
      if (files.has(normalized)) throw new Error("Not a directory");
      const prefix = normalized === "/" ? "/" : `${normalized}/`;
      const children = new Set<string>();
      for (const key of [...dirs, ...files.keys()]) {
        if (!key.startsWith(prefix) || key === normalized) continue;
        const rest = key.slice(prefix.length);
        const childName = rest.split("/")[0];
        if (childName) children.add(`${prefix}${childName}`);
      }
      return [...children];
    },
  };

  (globalThis as unknown as { IOUtils: typeof io }).IOUtils = io;
  return { files, dirs, remove };
}

function setupZotero(items: Map<number, MockItem>, io: MemoryIO): void {
  const prefs = new Map<string, unknown>();
  let nextId = 9000;
  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    DataDirectory: { dir: "/tmp/zotero" },
    Profile: { dir: "/tmp/profile" },
    getTempDirectory: () => ({ path: "/tmp/zotero-tmp" }),
    Prefs: {
      get: (key: string) => prefs.get(key),
      set: (key: string, value: unknown) => {
        prefs.set(key, value);
      },
    },
    Libraries: {
      userLibraryID: 1,
      getAll: () => [{ libraryID: 1, name: "My Library" }],
    },
    Items: {
      get: (id: number) => items.get(id) || null,
      getAll: async (libraryID: number) =>
        [...items.values()].filter((item) => item.libraryID === libraryID),
    },
    Fulltext: {
      getIndexedState: async () => 3,
    },
    Attachments: {
      importFromFile: async (options: {
        file: string | { path?: string };
        parentItemID?: number;
        libraryID?: number;
        title?: string;
        fileBaseName?: string;
        contentType?: string;
      }) => {
        const sourcePath =
          typeof options.file === "string"
            ? options.file
            : options.file.path || "";
        const data = io.files.get(normalizePath(sourcePath));
        if (!data) throw new Error("Missing imported package");
        const id = nextId++;
        const attachmentFilename = `${options.fileBaseName || "package"}.zip`;
        const storedPath = `/tmp/zotero/storage/${id}/${attachmentFilename}`;
        io.files.set(normalizePath(storedPath), data);
        const imported = createAttachment({
          id,
          key: `PKG${id}`,
          parentID: options.parentItemID,
          contentType: options.contentType || "application/zip",
          filename: attachmentFilename,
          filePath: storedPath,
          title: options.title || attachmentFilename,
        });
        items.set(id, imported);
        const parent = options.parentItemID
          ? items.get(options.parentItemID)
          : null;
        parent?.attachmentIDs?.push(id);
        return imported as unknown as Zotero.Item;
      },
    },
  };
  (globalThis as unknown as { ztoolkit: unknown }).ztoolkit = {
    log: () => {},
  };
}

function createAttachment(params: {
  id: number;
  key: string;
  parentID?: number;
  contentType: string;
  filename: string;
  filePath?: string;
  title?: string;
}): MockItem {
  let title = params.title || params.filename;
  return {
    id: params.id,
    key: params.key,
    libraryID: 1,
    parentID: params.parentID,
    attachmentContentType: params.contentType,
    attachmentFilename: params.filename,
    isAttachment: () => true,
    isRegularItem: () => false,
    getField: (field) => (field === "title" ? title : ""),
    setField: (field, value) => {
      if (field === "title") title = value;
    },
    saveTx: async () => {},
    getFilePathAsync: async () => params.filePath || false,
  };
}

function createParent(): MockItem {
  return {
    id: 10,
    key: "PARENTKEY",
    libraryID: 1,
    attachmentIDs: [],
    isAttachment: () => false,
    isRegularItem: () => true,
    getAttachments() {
      return this.attachmentIDs || [];
    },
    getField: (field) => (field === "title" ? "Parent paper" : ""),
    saveTx: async () => {},
  };
}

async function writeSampleCache(attachmentId: number): Promise<void> {
  await writeMineruCacheFiles(
    attachmentId,
    "# Intro\n![Fig](images/fig1.png)\n# Results\ncontent",
    [
      {
        relativePath: "full.md",
        data: bytes("# Intro\n![Fig](images/fig1.png)\n# Results\ncontent"),
      },
      { relativePath: "images/fig1.png", data: bytes([1, 2, 3]) },
      {
        relativePath: "content_list.json",
        data: bytes(
          JSON.stringify([
            { type: "text", text_level: 1, text: "Intro", page_idx: 0 },
            {
              type: "image",
              img_path: "images/fig1.png",
              image_caption: ["Fig. 1 caption"],
              page_idx: 0,
            },
            { type: "text", text_level: 1, text: "Results", page_idx: 1 },
          ]),
        ),
      },
      { relativePath: "layout.json", data: bytes("{}") },
    ],
  );
}

function attachPackage(params: {
  io: MemoryIO;
  items: Map<number, MockItem>;
  parent: MockItem;
  id: number;
  key: string;
  sourceKey: string;
  bytes: Uint8Array;
}): MockItem {
  const packagePath = `/tmp/zotero/package-${params.id}.zip`;
  params.io.files.set(packagePath, params.bytes);
  const packageItem = createAttachment({
    id: params.id,
    key: params.key,
    parentID: params.parent.id,
    contentType: "application/zip",
    filename: `package-${params.id}.zip`,
    filePath: packagePath,
    title: `${MINERU_SYNC_ATTACHMENT_TITLE_PREFIX} ${params.sourceKey}.zip`,
  });
  params.parent.attachmentIDs!.push(packageItem.id);
  params.items.set(packageItem.id, packageItem);
  return packageItem;
}

describe("mineruSync", function () {
  afterEach(function () {
    delete (globalThis as unknown as { IOUtils?: unknown }).IOUtils;
    delete (globalThis as unknown as { Zotero?: unknown }).Zotero;
    delete (globalThis as unknown as { ztoolkit?: unknown }).ztoolkit;
    pdfTextCache.clear();
  });

  it("filters only unsafe entries and layout.json from sync packages", function () {
    assert.isTrue(shouldIncludeMineruCachePackageEntry("full.md"));
    assert.isTrue(shouldIncludeMineruCachePackageEntry("content_list.json"));
    assert.isTrue(shouldIncludeMineruCachePackageEntry("images/figure.png"));
    assert.isFalse(shouldIncludeMineruCachePackageEntry("layout.json"));
    assert.isFalse(shouldIncludeMineruCachePackageEntry("../full.md"));
    assert.isFalse(shouldIncludeMineruCachePackageEntry("/tmp/full.md"));
    assert.isFalse(shouldIncludeMineruCachePackageEntry("__MACOSX/full.md"));
  });

  it("builds a package with full.md, manifest, content_list, and assets", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const parent = createParent();
    const pdf = createAttachment({
      id: 42,
      key: "PDFKEY",
      parentID: parent.id,
      contentType: "application/pdf",
      filename: "paper.pdf",
    });
    parent.attachmentIDs!.push(pdf.id);
    items.set(parent.id, parent);
    items.set(pdf.id, pdf);
    setupZotero(items, io);

    await writeSampleCache(pdf.id);
    const zipBytes = await buildMineruSyncPackageBytes(
      pdf as unknown as Zotero.Item,
    );
    assert.exists(zipBytes);

    const entries = unzipSync(zipBytes!);
    assert.containsAllKeys(entries, [
      MINERU_SYNC_METADATA_FILE,
      "full.md",
      "manifest.json",
      "content_list.json",
      "images/fig1.png",
    ]);
    assert.notProperty(entries, "layout.json");
    const metadata = JSON.parse(
      decoder.decode(entries[MINERU_SYNC_METADATA_FILE]),
    );
    assert.equal(metadata.sourceAttachmentKey, "PDFKEY");
    assert.equal(metadata.parentItemKey, "PARENTKEY");
    assert.match(metadata.cacheContentHash, /^fnv1a32-[a-f0-9]{8}$/);
    assert.equal(metadata.mineruCacheVersion, "mineru-cache-v1");
  });

  it("does not publish a companion ZIP when MinerU sync is disabled", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const pdf = createAttachment({
      id: 42,
      key: "PDFKEY",
      contentType: "application/pdf",
      filename: "paper.pdf",
    });
    items.set(pdf.id, pdf);
    setupZotero(items, io);
    await writeSampleCache(pdf.id);

    const result = await publishMineruCachePackageForAttachment(pdf.id);
    assert.equal(result.status, "disabled");
    assert.equal(
      [...items.values()].filter((item) => item.id >= 9000).length,
      0,
    );
  });

  it("keeps MinerU sync disabled by default", function () {
    const io = setupMemoryIO();
    setupZotero(new Map<number, MockItem>(), io);

    assert.isFalse(isMineruSyncEnabled());
  });

  it("publishes and cleans only plugin-owned MinerU package attachments", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const parent = createParent();
    const pdf = createAttachment({
      id: 42,
      key: "PDFKEY",
      parentID: parent.id,
      contentType: "application/pdf",
      filename: "paper.pdf",
    });
    parent.attachmentIDs!.push(pdf.id);
    items.set(parent.id, parent);
    items.set(pdf.id, pdf);
    setupZotero(items, io);
    setMineruSyncEnabled(true);
    await writeSampleCache(pdf.id);

    const published = await publishMineruCachePackageForAttachment(pdf.id);
    assert.equal(published.status, "published");
    assert.isNumber(published.packageAttachmentId);

    const packageItem = items.get(published.packageAttachmentId!);
    assert.include(
      packageItem?.getField?.("title") || "",
      MINERU_SYNC_ATTACHMENT_TITLE_PREFIX,
    );

    const cleaned = await cleanSyncedMineruPackages();
    assert.equal(cleaned.deleted, 1);
    assert.equal(cleaned.failed, 0);
    assert.isTrue(packageItem?.deleted);
    assert.isFalse(pdf.deleted === true);
  });

  it("publishes and restores MinerU packages for parentless raw PDFs", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const pdf = createAttachment({
      id: 43,
      key: "RAWPDFKEY",
      contentType: "application/pdf",
      filename: "raw.pdf",
    });
    items.set(pdf.id, pdf);
    setupZotero(items, io);
    setMineruSyncEnabled(true);
    await writeSampleCache(pdf.id);

    const published = await publishMineruCachePackageForAttachment(pdf.id);
    assert.equal(published.status, "published");
    const packageItem = items.get(published.packageAttachmentId!);
    assert.exists(packageItem);
    assert.isUndefined(packageItem?.parentID);

    await io.remove(`/tmp/zotero/llm-for-zotero-mineru/${pdf.id}`);
    const restored = await restoreSyncedMineruCacheForAttachment(
      pdf as unknown as Zotero.Item,
    );

    assert.equal(restored.status, "restored");
    assert.equal(
      await readCachedMineruMd(pdf.id),
      "# Intro\n![Fig](images/fig1.png)\n# Results\ncontent",
    );
  });

  it("reports MinerU availability across local and synced package states", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const parent = createParent();
    const pdf = createAttachment({
      id: 51,
      key: "PDFAVAIL",
      parentID: parent.id,
      contentType: "application/pdf",
      filename: "available.pdf",
    });
    parent.attachmentIDs!.push(pdf.id);
    items.set(parent.id, parent);
    items.set(pdf.id, pdf);
    setupZotero(items, io);
    setMineruSyncEnabled(true);

    assert.equal(
      (
        await getMineruAvailabilityForAttachment(
          pdf as unknown as Zotero.Item,
        )
      ).status,
      "missing",
    );

    await writeSampleCache(pdf.id);
    assert.equal(
      (
        await getMineruAvailabilityForAttachment(
          pdf as unknown as Zotero.Item,
        )
      ).status,
      "local",
    );

    const zipBytes = await buildMineruSyncPackageBytes(
      pdf as unknown as Zotero.Item,
    );
    assert.exists(zipBytes);
    attachPackage({
      io,
      items,
      parent,
      id: 89,
      key: "PKGAVAIL",
      sourceKey: "PDFAVAIL",
      bytes: zipBytes!,
    });
    assert.equal(
      (
        await getMineruAvailabilityForAttachment(
          pdf as unknown as Zotero.Item,
        )
      ).status,
      "both",
    );

    await io.remove(`/tmp/zotero/llm-for-zotero-mineru/${pdf.id}`);
    assert.equal(
      (
        await getMineruAvailabilityForAttachment(
          pdf as unknown as Zotero.Item,
        )
      ).status,
      "synced",
    );
  });

  it("does not report synced packages as available when sync is disabled", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const parent = createParent();
    const pdf = createAttachment({
      id: 52,
      key: "PDFDISABLED",
      parentID: parent.id,
      contentType: "application/pdf",
      filename: "disabled-sync.pdf",
    });
    parent.attachmentIDs!.push(pdf.id);
    items.set(parent.id, parent);
    items.set(pdf.id, pdf);
    setupZotero(items, io);

    await writeSampleCache(pdf.id);
    const zipBytes = await buildMineruSyncPackageBytes(
      pdf as unknown as Zotero.Item,
    );
    assert.exists(zipBytes);
    attachPackage({
      io,
      items,
      parent,
      id: 90,
      key: "PKGDISABLED",
      sourceKey: "PDFDISABLED",
      bytes: zipBytes!,
    });
    setMineruSyncEnabled(false);

    const localAvailability = await getMineruAvailabilityForAttachment(
      pdf as unknown as Zotero.Item,
    );
    assert.equal(localAvailability.status, "local");
    assert.isTrue(localAvailability.localCached);
    assert.isFalse(localAvailability.syncedPackage);

    await io.remove(`/tmp/zotero/llm-for-zotero-mineru/${pdf.id}`);
    const syncedOnlyAvailability = await getMineruAvailabilityForAttachment(
      pdf as unknown as Zotero.Item,
    );
    assert.equal(syncedOnlyAvailability.status, "missing");
    assert.isFalse(syncedOnlyAvailability.localCached);
    assert.isFalse(syncedOnlyAvailability.syncedPackage);
  });

  it("does not report unreadable title-matched packages as synced", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const parent = createParent();
    const pdf = createAttachment({
      id: 53,
      key: "PDFINVALID",
      parentID: parent.id,
      contentType: "application/pdf",
      filename: "invalid-package.pdf",
    });
    parent.attachmentIDs!.push(pdf.id);
    items.set(parent.id, parent);
    items.set(pdf.id, pdf);
    setupZotero(items, io);
    setMineruSyncEnabled(true);

    attachPackage({
      io,
      items,
      parent,
      id: 91,
      key: "PKGINVALID",
      sourceKey: "PDFINVALID",
      bytes: bytes("not a zip"),
    });

    const availability = await getMineruAvailabilityForAttachment(
      pdf as unknown as Zotero.Item,
    );
    assert.equal(availability.status, "missing");
    assert.isFalse(availability.localCached);
    assert.isFalse(availability.syncedPackage);
  });

  it("can report title-matched synced packages without reading ZIP bytes", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const parent = createParent();
    const pdf = createAttachment({
      id: 54,
      key: "PDFFAST",
      parentID: parent.id,
      contentType: "application/pdf",
      filename: "fast-availability.pdf",
    });
    parent.attachmentIDs!.push(pdf.id);
    items.set(parent.id, parent);
    items.set(pdf.id, pdf);
    setupZotero(items, io);
    setMineruSyncEnabled(true);

    const packageItem = attachPackage({
      io,
      items,
      parent,
      id: 92,
      key: "PKGFAST",
      sourceKey: "PDFFAST",
      bytes: bytes("not a zip"),
    });
    packageItem.getFilePathAsync = async () => {
      throw new Error("fast availability should not read package bytes");
    };

    const availability = await getMineruAvailabilityForAttachment(
      pdf as unknown as Zotero.Item,
      { validateSyncedPackage: false },
    );
    assert.equal(availability.status, "synced");
    assert.isFalse(availability.localCached);
    assert.isTrue(availability.syncedPackage);
  });

  it("restores a missing local cache from a matching synced package", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const parent = createParent();
    const pdf = createAttachment({
      id: 77,
      key: "PDFRESTORE",
      parentID: parent.id,
      contentType: "application/pdf",
      filename: "restore.pdf",
    });
    parent.attachmentIDs!.push(pdf.id);
    items.set(parent.id, parent);
    items.set(pdf.id, pdf);
    setupZotero(items, io);
    setMineruSyncEnabled(true);

    await writeSampleCache(pdf.id);
    const zipBytes = await buildMineruSyncPackageBytes(
      pdf as unknown as Zotero.Item,
    );
    assert.exists(zipBytes);
    await io.remove(`/tmp/zotero/llm-for-zotero-mineru/${pdf.id}`);

    const packagePath = "/tmp/zotero/package.zip";
    io.files.set(packagePath, zipBytes!);
    const packageItem = createAttachment({
      id: 88,
      key: "PKGRESTORE",
      parentID: parent.id,
      contentType: "application/zip",
      filename: "package.zip",
      filePath: packagePath,
      title: `${MINERU_SYNC_ATTACHMENT_TITLE_PREFIX} PDFRESTORE.zip`,
    });
    parent.attachmentIDs!.push(packageItem.id);
    items.set(packageItem.id, packageItem);

    const restored = await restoreSyncedMineruCacheForAttachment(
      pdf as unknown as Zotero.Item,
    );
    assert.equal(restored.status, "restored");
    assert.equal(
      await readCachedMineruMd(pdf.id),
      "# Intro\n![Fig](images/fig1.png)\n# Results\ncontent",
    );
  });

  it("lazily restores a MinerU cache dir from a synced package and reuses the local cache", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const parent = createParent();
    const pdf = createAttachment({
      id: 80,
      key: "PDFLAZY",
      parentID: parent.id,
      contentType: "application/pdf",
      filename: "lazy.pdf",
    });
    parent.attachmentIDs!.push(pdf.id);
    items.set(parent.id, parent);
    items.set(pdf.id, pdf);
    setupZotero(items, io);
    setMineruSyncEnabled(true);

    await writeSampleCache(pdf.id);
    const zipBytes = await buildMineruSyncPackageBytes(
      pdf as unknown as Zotero.Item,
    );
    assert.exists(zipBytes);
    await io.remove(`/tmp/zotero/llm-for-zotero-mineru/${pdf.id}`);

    const packageItem = attachPackage({
      io,
      items,
      parent,
      id: 93,
      key: "PKGLAZY",
      sourceKey: "PDFLAZY",
      bytes: zipBytes!,
    });
    const readPackagePath = packageItem.getFilePathAsync!.bind(packageItem);
    let packageReads = 0;
    packageItem.getFilePathAsync = async () => {
      packageReads += 1;
      return readPackagePath();
    };
    pdfTextCache.set(pdf.id, {
      title: "Stale Zotero text",
      chunks: ["stale"],
      chunkMeta: [],
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 1,
      fullLength: 5,
      sourceType: "zotero-worker",
    } as any);

    const restoredDir = await ensureMineruCacheDirForAttachment(
      pdf as unknown as Zotero.Item,
    );
    assert.equal(restoredDir, getMineruItemDir(pdf.id));
    assert.equal(packageReads, 1);
    assert.isTrue(await hasCachedMineruMd(pdf.id));
    assert.isUndefined(pdfTextCache.get(pdf.id));

    packageItem.getFilePathAsync = async () => {
      throw new Error("Local cache should skip package reads");
    };
    const reusedDir = await ensureMineruCacheDirForAttachment(
      pdf as unknown as Zotero.Item,
    );
    assert.equal(reusedDir, getMineruItemDir(pdf.id));
  });

  it("exposes mineruCacheDir from read_library after lazy restoring a synced package", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const parent = createParent();
    const pdf = createAttachment({
      id: 81,
      key: "PDFREADLIB",
      parentID: parent.id,
      contentType: "application/pdf",
      filename: "read-library.pdf",
    });
    parent.attachmentIDs!.push(pdf.id);
    items.set(parent.id, parent);
    items.set(pdf.id, pdf);
    setupZotero(items, io);
    setMineruSyncEnabled(true);

    await writeSampleCache(pdf.id);
    const zipBytes = await buildMineruSyncPackageBytes(
      pdf as unknown as Zotero.Item,
    );
    assert.exists(zipBytes);
    await io.remove(`/tmp/zotero/llm-for-zotero-mineru/${pdf.id}`);
    attachPackage({
      io,
      items,
      parent,
      id: 94,
      key: "PKGREADLIB",
      sourceKey: "PDFREADLIB",
      bytes: zipBytes!,
    });

    const tool = createReadLibraryTool(new ZoteroGateway());
    const validated = tool.validate({
      itemIds: [parent.id],
      sections: ["attachments"],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, {
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "summarize",
        activeItemId: parent.id,
        libraryID: 1,
      },
      item: null,
      currentAnswerText: "",
      modelName: "gpt-5.5",
    });
    const entry = (result as { results: Record<string, any> }).results[
      String(parent.id)
    ];
    const pdfAttachment = entry.attachments.find(
      (attachment: { contextItemId: number }) =>
        attachment.contextItemId === pdf.id,
    );
    assert.equal(pdfAttachment?.mineruCacheDir, getMineruItemDir(pdf.id));
    assert.equal(
      await readCachedMineruMd(pdf.id),
      "# Intro\n![Fig](images/fig1.png)\n# Results\ncontent",
    );
  });

  it("does not lazy restore when sync is disabled, package is invalid, or item is not a PDF", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const parent = createParent();
    const pdf = createAttachment({
      id: 82,
      key: "PDFFAILURES",
      parentID: parent.id,
      contentType: "application/pdf",
      filename: "failures.pdf",
    });
    const nonPdf = createAttachment({
      id: 83,
      key: "NONPDF",
      parentID: parent.id,
      contentType: "text/plain",
      filename: "note.txt",
    });
    parent.attachmentIDs!.push(pdf.id, nonPdf.id);
    items.set(parent.id, parent);
    items.set(pdf.id, pdf);
    items.set(nonPdf.id, nonPdf);
    setupZotero(items, io);

    await writeSampleCache(pdf.id);
    const zipBytes = await buildMineruSyncPackageBytes(
      pdf as unknown as Zotero.Item,
    );
    assert.exists(zipBytes);
    await io.remove(`/tmp/zotero/llm-for-zotero-mineru/${pdf.id}`);
    attachPackage({
      io,
      items,
      parent,
      id: 95,
      key: "PKGDISABLEDLZ",
      sourceKey: "PDFFAILURES",
      bytes: zipBytes!,
    });

    setMineruSyncEnabled(false);
    assert.isUndefined(
      await ensureMineruCacheDirForAttachment(pdf as unknown as Zotero.Item),
    );
    assert.isFalse(await hasCachedMineruMd(pdf.id));
    assert.isUndefined(
      await ensureMineruCacheDirForAttachment(nonPdf as unknown as Zotero.Item),
    );

    const invalidPdf = createAttachment({
      id: 84,
      key: "PDFINVALIDLZ",
      parentID: parent.id,
      contentType: "application/pdf",
      filename: "invalid-lazy.pdf",
    });
    parent.attachmentIDs!.push(invalidPdf.id);
    items.set(invalidPdf.id, invalidPdf);
    attachPackage({
      io,
      items,
      parent,
      id: 96,
      key: "PKGINVALIDLZ",
      sourceKey: "PDFINVALIDLZ",
      bytes: bytes("not a zip"),
    });
    setMineruSyncEnabled(true);

    assert.isUndefined(
      await ensureMineruCacheDirForAttachment(
        invalidPdf as unknown as Zotero.Item,
      ),
    );
    assert.isFalse(await hasCachedMineruMd(invalidPdf.id));
  });

  it("skips package reads when runtime cache already exists", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const parent = createParent();
    const pdf = createAttachment({
      id: 78,
      key: "PDFLOCALFIRST",
      parentID: parent.id,
      contentType: "application/pdf",
      filename: "local-first.pdf",
    });
    parent.attachmentIDs!.push(pdf.id);
    items.set(parent.id, parent);
    items.set(pdf.id, pdf);
    setupZotero(items, io);
    setMineruSyncEnabled(true);

    await writeSampleCache(pdf.id);
    const zipBytes = await buildMineruSyncPackageBytes(
      pdf as unknown as Zotero.Item,
    );
    assert.exists(zipBytes);
    const packageItem = attachPackage({
      io,
      items,
      parent,
      id: 79,
      key: "PKGLOCALFIRST",
      sourceKey: "PDFLOCALFIRST",
      bytes: zipBytes!,
    });
    packageItem.getFilePathAsync = async () => {
      throw new Error("Runtime restore should not read package bytes");
    };

    const restored = await ensureMineruRuntimeCacheForAttachment(
      pdf as unknown as Zotero.Item,
    );
    assert.equal(restored.status, "already_cached");
    assert.equal(
      await readCachedMineruMd(pdf.id),
      "# Intro\n![Fig](images/fig1.png)\n# Results\ncontent",
    );
  });

  it("does not republish an unchanged synced package", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const parent = createParent();
    const pdf = createAttachment({
      id: 91,
      key: "PDFDUP",
      parentID: parent.id,
      contentType: "application/pdf",
      filename: "dup.pdf",
    });
    parent.attachmentIDs!.push(pdf.id);
    items.set(parent.id, parent);
    items.set(pdf.id, pdf);
    setupZotero(items, io);
    setMineruSyncEnabled(true);
    await writeSampleCache(pdf.id);

    const first = await publishMineruCachePackageForAttachment(pdf.id);
    assert.equal(first.status, "published");
    const second = await publishMineruCachePackageForAttachment(pdf.id);
    assert.equal(second.status, "up_to_date");
    assert.equal(
      [...items.values()].filter((item) => item.id >= 9000).length,
      1,
    );
  });

  it("prunes duplicate synced packages when an unchanged package is already current", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const parent = createParent();
    const pdf = createAttachment({
      id: 94,
      key: "PDFPRUNE",
      parentID: parent.id,
      contentType: "application/pdf",
      filename: "prune.pdf",
    });
    parent.attachmentIDs!.push(pdf.id);
    items.set(parent.id, parent);
    items.set(pdf.id, pdf);
    setupZotero(items, io);
    setMineruSyncEnabled(true);
    await writeSampleCache(pdf.id);

    const zipBytes = await buildMineruSyncPackageBytes(
      pdf as unknown as Zotero.Item,
    );
    assert.exists(zipBytes);
    const older = attachPackage({
      io,
      items,
      parent,
      id: 95,
      key: "PKGPRUNE1",
      sourceKey: "PDFPRUNE",
      bytes: zipBytes!,
    });
    const newer = attachPackage({
      io,
      items,
      parent,
      id: 96,
      key: "PKGPRUNE2",
      sourceKey: "PDFPRUNE",
      bytes: zipBytes!,
    });

    const result = await publishMineruCachePackageForAttachment(pdf.id);
    assert.equal(result.status, "up_to_date");
    assert.equal(result.packageAttachmentId, newer.id);
    assert.isTrue(older.deleted);
    assert.isFalse(newer.deleted === true);
  });

  it("leaves existing local cache untouched during runtime restore", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const parent = createParent();
    const pdf = createAttachment({
      id: 92,
      key: "PDFAUTH",
      parentID: parent.id,
      contentType: "application/pdf",
      filename: "authoritative.pdf",
    });
    parent.attachmentIDs!.push(pdf.id);
    items.set(parent.id, parent);
    items.set(pdf.id, pdf);
    setupZotero(items, io);
    setMineruSyncEnabled(true);

    await writeMineruCacheFiles(pdf.id, "# Synced source", [
      { relativePath: "content_list.json", data: bytes("[]") },
    ]);
    const zipBytes = await buildMineruSyncPackageBytes(
      pdf as unknown as Zotero.Item,
    );
    assert.exists(zipBytes);
    attachPackage({
      io,
      items,
      parent,
      id: 93,
      key: "PKGAUTH",
      sourceKey: "PDFAUTH",
      bytes: zipBytes!,
    });

    await writeMineruCacheFiles(pdf.id, "# Divergent local", [
      { relativePath: "content_list.json", data: bytes("[]") },
    ]);
    const restored = await restoreSyncedMineruCacheForAttachment(
      pdf as unknown as Zotero.Item,
    );
    assert.equal(restored.status, "already_cached");
    assert.equal(await readCachedMineruMd(pdf.id), "# Divergent local");
  });

  it("repairs over divergent local cache because the selected ZIP is authoritative", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const parent = createParent();
    const pdf = createAttachment({
      id: 192,
      key: "PDFAUTHREPAIR",
      parentID: parent.id,
      contentType: "application/pdf",
      filename: "authoritative-repair.pdf",
    });
    parent.attachmentIDs!.push(pdf.id);
    items.set(parent.id, parent);
    items.set(pdf.id, pdf);
    setupZotero(items, io);
    setMineruSyncEnabled(true);

    await writeMineruCacheFiles(pdf.id, "# Synced source", [
      { relativePath: "content_list.json", data: bytes("[]") },
    ]);
    const zipBytes = await buildMineruSyncPackageBytes(
      pdf as unknown as Zotero.Item,
    );
    assert.exists(zipBytes);
    attachPackage({
      io,
      items,
      parent,
      id: 193,
      key: "PKGAUTHREPAIR",
      sourceKey: "PDFAUTHREPAIR",
      bytes: zipBytes!,
    });

    await writeMineruCacheFiles(pdf.id, "# Divergent local", [
      { relativePath: "content_list.json", data: bytes("[]") },
    ]);
    const restored = await repairSyncedMineruCacheForAttachment(
      pdf as unknown as Zotero.Item,
    );
    assert.equal(restored.status, "restored");
    assert.equal(await readCachedMineruMd(pdf.id), "# Synced source");
  });

  it("uses the latest synced package and prunes older duplicates during repair", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const parent = createParent();
    const pdf = createAttachment({
      id: 97,
      key: "PDFLATEST",
      parentID: parent.id,
      contentType: "application/pdf",
      filename: "latest.pdf",
    });
    parent.attachmentIDs!.push(pdf.id);
    items.set(parent.id, parent);
    items.set(pdf.id, pdf);
    setupZotero(items, io);
    setMineruSyncEnabled(true);

    await writeMineruCacheFiles(pdf.id, "# Older synced", [
      { relativePath: "content_list.json", data: bytes("[]") },
    ]);
    const olderZip = await buildMineruSyncPackageBytes(
      pdf as unknown as Zotero.Item,
    );
    assert.exists(olderZip);
    const older = attachPackage({
      io,
      items,
      parent,
      id: 98,
      key: "PKGLATEST1",
      sourceKey: "PDFLATEST",
      bytes: olderZip!,
    });

    await writeMineruCacheFiles(pdf.id, "# Newer synced", [
      { relativePath: "content_list.json", data: bytes("[]") },
    ]);
    const newerZip = await buildMineruSyncPackageBytes(
      pdf as unknown as Zotero.Item,
    );
    assert.exists(newerZip);
    const newer = attachPackage({
      io,
      items,
      parent,
      id: 99,
      key: "PKGLATEST2",
      sourceKey: "PDFLATEST",
      bytes: newerZip!,
    });
    await io.remove(`/tmp/zotero/llm-for-zotero-mineru/${pdf.id}`);

    const restored = await repairSyncedMineruCacheForAttachment(
      pdf as unknown as Zotero.Item,
    );
    assert.equal(restored.status, "restored");
    assert.equal(restored.packageAttachmentId, newer.id);
    assert.equal(await readCachedMineruMd(pdf.id), "# Newer synced");
    assert.isTrue(older.deleted);
    assert.isFalse(newer.deleted === true);
  });

  it("uses the latest synced package without pruning during runtime restore", async function () {
    const io = setupMemoryIO();
    const items = new Map<number, MockItem>();
    const parent = createParent();
    const pdf = createAttachment({
      id: 197,
      key: "PDFRUNTIMELATEST",
      parentID: parent.id,
      contentType: "application/pdf",
      filename: "runtime-latest.pdf",
    });
    parent.attachmentIDs!.push(pdf.id);
    items.set(parent.id, parent);
    items.set(pdf.id, pdf);
    setupZotero(items, io);
    setMineruSyncEnabled(true);

    await writeMineruCacheFiles(pdf.id, "# Older synced", [
      { relativePath: "content_list.json", data: bytes("[]") },
    ]);
    const olderZip = await buildMineruSyncPackageBytes(
      pdf as unknown as Zotero.Item,
    );
    assert.exists(olderZip);
    const older = attachPackage({
      io,
      items,
      parent,
      id: 198,
      key: "PKGRUNTIMELATEST1",
      sourceKey: "PDFRUNTIMELATEST",
      bytes: olderZip!,
    });

    await writeMineruCacheFiles(pdf.id, "# Newer synced", [
      { relativePath: "content_list.json", data: bytes("[]") },
    ]);
    const newerZip = await buildMineruSyncPackageBytes(
      pdf as unknown as Zotero.Item,
    );
    assert.exists(newerZip);
    const newer = attachPackage({
      io,
      items,
      parent,
      id: 199,
      key: "PKGRUNTIMELATEST2",
      sourceKey: "PDFRUNTIMELATEST",
      bytes: newerZip!,
    });
    await io.remove(`/tmp/zotero/llm-for-zotero-mineru/${pdf.id}`);

    const restored = await ensureMineruRuntimeCacheForAttachment(
      pdf as unknown as Zotero.Item,
    );
    assert.equal(restored.status, "restored");
    assert.equal(restored.packageAttachmentId, newer.id);
    assert.equal(await readCachedMineruMd(pdf.id), "# Newer synced");
    assert.isFalse(older.deleted === true);
    assert.isFalse(newer.deleted === true);
  });
});

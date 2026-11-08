import { assert } from "chai";
import { installLibraryTextIndexSqlite } from "./helpers/libraryTextIndexDb";
import {
  buildFixturePdfContext,
  buildMarkdownPdfContext,
  headingSequenceMarkdown,
  mockPdfAttachment,
  restoreTestGlobals,
  setupMemoryIO,
  setupZoteroGlobals,
  snapshotTestGlobals,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";
import { MANIFEST_STRUCTURE_VERSION } from "../src/services/mineru/mineruCache";
import type { PdfContext } from "../src/services/paperContent/types";
import { LibraryTextIndexStore } from "../src/services/libraryTextIndex/store";
import { openLibraryTextIndexDb } from "../src/services/libraryTextIndex/db";
import {
  buildIndexDocumentFromPdfContext,
  computeChunkerFingerprint,
  estimateDocumentBytes,
  indexAttachment,
  indexSourceFingerprint,
} from "../src/services/libraryTextIndex/indexer";
import {
  INDEX_PRIORITY,
  LIBRARY_TEXT_INDEX_CHUNKER_VERSION,
} from "../src/services/libraryTextIndex/constants";
import { LibraryTextIndexScheduler } from "../src/services/libraryTextIndex/scheduler";
import {
  onPdfContextLoaded,
  pdfTextCache,
} from "../src/services/paperContent/contextCache";
import { buildChunkIndex } from "../src/services/paperContent/pdfContext";
import { searchLibraryTextIndex } from "../src/services/libraryTextIndex/search";

describe("library text indexer", function () {
  let globals: TestGlobalSnapshot;
  let harness: ReturnType<typeof installLibraryTextIndexSqlite>;
  let store: LibraryTextIndexStore;
  before(function () {
    globals = snapshotTestGlobals();
  });
  after(function () {
    restoreTestGlobals(globals);
  });
  beforeEach(async function () {
    // Fresh fixture host per test, so no test depends on files an earlier one wrote.
    setupMemoryIO();
    setupZoteroGlobals();
    harness = installLibraryTextIndexSqlite();
    store = new LibraryTextIndexStore((await openLibraryTextIndexDb())!);
  });
  afterEach(function () {
    harness.close();
    pdfTextCache.clear();
  });

  it("builds a document whose postings reproduce buildChunkIndex term stats, with file state and a byte estimate", async function () {
    const ctx = await buildFixturePdfContext("bioSingleHash", 9001);
    const doc = buildIndexDocumentFromPdfContext({
      attachmentId: 9001,
      attachmentKey: "K9001",
      libraryID: 1,
      parentItemId: 100,
      fileState: { path: "/x.pdf", size: 4096, mtime: 1234 },
      ctx,
    });
    const expected = buildChunkIndex(ctx.chunks);
    assert.equal(doc.chunks.length, ctx.chunks.length);
    doc.chunks.forEach((chunk, i) => {
      assert.deepEqual(chunk.tf, expected.chunkStats[i].tf);
      assert.equal(chunk.tokenCount, expected.chunkStats[i].length);
      assert.equal(chunk.meta.sectionLabel, ctx.chunkMeta[i].sectionLabel);
    });
    assert.equal(doc.sourceType, "mineru");
    assert.equal(doc.sourceFingerprint, indexSourceFingerprint(ctx));
    assert.equal(doc.chunkerVersion, LIBRARY_TEXT_INDEX_CHUNKER_VERSION);
    assert.equal(doc.sourceMtime, 1234);
    assert.equal(doc.sourceSize, 4096);
    assert.equal(doc.byteEstimate, estimateDocumentBytes(doc));
    assert.isAbove(doc.byteEstimate, ctx.chunks.join("").length);
  });

  it("estimates document bytes as UTF-8, so CJK text counts three bytes per character", function () {
    const bytes = (text: string) =>
      estimateDocumentBytes({
        chunks: [
          {
            chunkIndex: 0,
            text,
            tokenCount: 0,
            meta: {} as never,
            tf: {},
          },
        ],
      });
    assert.equal(bytes("abc"), 3);
    assert.equal(bytes("神经元"), 9);
    assert.equal(bytes("é"), 2);
    assert.equal(bytes("𝜶"), 4, "a surrogate pair is one 4-byte code point");
  });

  it("indexes an attachment in the urgent lane, persists it, evicts only what it loaded, and skips an unchanged rewrite", async function () {
    const item = mockPdfAttachment(9001);
    await buildFixturePdfContext("bioSingleHash", 9001);
    pdfTextCache.clear();
    const result = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "urgent",
    });
    assert.equal(result.status, "indexed");
    assert.isAbove(result.chunkCount, 3);
    assert.isFalse(
      pdfTextCache.has(9001),
      "indexing must not grow the TTL cache",
    );
    const row = await store.getDocument(9001);
    assert.equal(row?.chunkCount, result.chunkCount);
    const again = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "urgent",
    });
    assert.equal(
      again.status,
      "unchanged",
      "same fingerprint skips the rewrite",
    );
  });

  const longHeadings = (word: string) =>
    [
      "# 海马位置细胞的表征漂移",
      "## 一、引言",
      "## 二、实验方法",
      "## 三、实验结果",
    ]
      .map((heading) => `${heading}\n\n${word.repeat(40)}`)
      .join("\n\n");
  const shortHeadings = () =>
    ["# 海马位置细胞的表征漂移", "## 摘要", "## 结果"]
      .map(
        (heading) => `${heading}\n\n${"解码准确率高于随机水平。".repeat(30)}`,
      )
      .join("\n\n");

  it("keeps an English MinerU paper's index fingerprint as it was before the structure version", async function () {
    const english = await buildFixturePdfContext("bioSingleHash", 9001);
    assert.equal(english.sourceType, "mineru");
    // The formula before the branch: the text's own fingerprint.
    assert.equal(
      indexSourceFingerprint(english),
      english.chunkMeta[0].sourceFingerprint,
    );
    const doc = buildIndexDocumentFromPdfContext({
      attachmentId: 9001,
      attachmentKey: "K9001",
      libraryID: 1,
      parentItemId: 100,
      fileState: { path: "/x.pdf", size: 4096, mtime: 1234 },
      ctx: english,
    });
    assert.equal(doc.sourceFingerprint, english.chunkMeta[0].sourceFingerprint);
  });

  it("keeps a Chinese MinerU paper's fingerprint when it has only long headings", async function () {
    const ctx = await buildMarkdownPdfContext(longHeadings("位置细胞。"), 9101);
    assert.equal(ctx.sourceType, "mineru");
    assert.equal(
      indexSourceFingerprint(ctx),
      ctx.chunkMeta[0].sourceFingerprint,
    );
  });

  it("gives a Chinese MinerU paper with a ## 结果 heading a new fingerprint, and not a PDF's", async function () {
    const ctx = await buildMarkdownPdfContext(shortHeadings(), 9102);
    assert.equal(ctx.sourceType, "mineru");
    const now = indexSourceFingerprint(ctx);
    assert.include(now, ctx.chunkMeta[0].sourceFingerprint!);
    assert.notEqual(now, ctx.chunkMeta[0].sourceFingerprint);
    assert.notEqual(
      now,
      indexSourceFingerprint(ctx, MANIFEST_STRUCTURE_VERSION - 1),
    );
    const pdf = { ...ctx, sourceType: "zotero-worker" as const };
    assert.equal(
      indexSourceFingerprint(pdf),
      ctx.chunkMeta[0].sourceFingerprint,
    );
  });

  it("gives a Chinese MinerU paper whose figure-label headings are now noise a new fingerprint", async function () {
    for (const [index, label] of ["图12", "表 3", "圖4a"].entries()) {
      const markdown = [
        "# 海马位置细胞的表征漂移",
        `## 一、引言\n\n${"位置细胞。".repeat(40)}`,
        `## ${label}\n\n${"图注文字。".repeat(40)}`,
        `## 二、讨论\n\n${"漂移与解码。".repeat(40)}`,
      ].join("\n\n");
      const ctx = await buildMarkdownPdfContext(markdown, 9110 + index);
      assert.equal(ctx.sourceType, "mineru");
      assert.notEqual(
        indexSourceFingerprint(ctx),
        ctx.chunkMeta[0].sourceFingerprint,
        label,
      );
    }
  });

  it("re-indexes a Chinese MinerU document stored before the short headings were kept, and not an English one", async function () {
    const upsertOld = async (id: number, ctx: PdfContext) => {
      const doc = buildIndexDocumentFromPdfContext({
        attachmentId: id,
        attachmentKey: `K${id}`,
        libraryID: 1,
        parentItemId: 100,
        fileState: { path: "/x.pdf", size: 4096, mtime: 1234 },
        ctx,
      });
      // Stored before the branch: the text's own fingerprint.
      await store.upsertDocument({
        ...doc,
        sourceFingerprint: ctx.chunkMeta[0].sourceFingerprint!,
      });
    };
    const zh = await buildMarkdownPdfContext(shortHeadings(), 9102);
    await upsertOld(9102, zh);
    pdfTextCache.clear();
    const chinese = await indexAttachment({
      item: mockPdfAttachment(9102),
      libraryID: 1,
      store,
      lane: "urgent",
    });
    assert.equal(chinese.status, "indexed");
    assert.equal(
      (await store.getDocument(9102))?.sourceFingerprint,
      indexSourceFingerprint(zh),
    );

    const en = await buildFixturePdfContext("bioSingleHash", 9001);
    await upsertOld(9001, en);
    pdfTextCache.clear();
    const english = await indexAttachment({
      item: mockPdfAttachment(9001),
      libraryID: 1,
      store,
      lane: "urgent",
    });
    assert.equal(english.status, "unchanged");
  });

  it("records a new file stat on an unchanged re-index so reconcile stops flagging it stale", async function () {
    const item = Object.assign(mockPdfAttachment(9001), {
      getFilePathAsync: async () => "/storage/K9001/paper.pdf",
    }) as unknown as Zotero.Item;
    await buildFixturePdfContext("bioSingleHash", 9001);
    pdfTextCache.clear();
    const io = (globalThis as any).IOUtils;
    let lastModified = 1000;
    io.stat = async () => ({ size: 4096, lastModified });
    const first = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "urgent",
    });
    assert.equal(first.status, "indexed");
    assert.equal((await store.getDocument(9001))?.sourceMtime, 1000);
    lastModified = 2000; // file sync re-downloaded identical bytes
    const second = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "urgent",
    });
    assert.equal(second.status, "unchanged");
    const row = await store.getDocument(9001);
    assert.equal(row?.sourceMtime, 2000);
    assert.equal(row?.sourceSize, 4096);
  });

  it("keeps a context the question path already loaded (write-through never evicts the agent's paper)", async function () {
    const item = mockPdfAttachment(9001);
    await buildFixturePdfContext("bioSingleHash", 9001);
    assert.isTrue(pdfTextCache.has(9001));
    const result = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "urgent",
    });
    assert.equal(result.status, "indexed");
    assert.isTrue(
      pdfTextCache.has(9001),
      "a pre-existing context stays cached",
    );
  });

  it("prefers Zotero's full-text cache over PDFWorker in the prefetch lane and upgrades later", async function () {
    // 9002 has no MinerU cache; the fixture host exposes a full-text cache file and a PDFWorker.
    const item = mockPdfAttachment(9002);
    const host = globals as unknown as {
      fulltextCacheText?: Map<number, string>;
      pdfWorkerCalls?: number[];
    };
    // Fixture support: retrievalCorpus.setupZoteroGlobals() exposes Zotero.Fulltext.getItemCacheFile and Zotero.PDFWorker.getFullText
    // backed by two maps on the snapshot; add them there if missing (see Step 7 note).
    host.fulltextCacheText!.set(
      9002,
      "Abstract. The quorvex coefficient was 0.37 in every trial. Methods. We measured it twice.",
    );
    host.pdfWorkerCalls!.length = 0;
    const prefetch = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "prefetch",
    });
    assert.equal(prefetch.status, "indexed");
    assert.equal(prefetch.sourceType, "zotero-fulltext-cache");
    assert.deepEqual(host.pdfWorkerCalls, [], "prefetch never ran pdf.js");
    pdfTextCache.clear();
    const urgent = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "urgent",
    });
    assert.equal(
      urgent.status,
      "indexed",
      "the urgent lane's better source replaces the full-text-cache row",
    );
    assert.equal(urgent.sourceType, "zotero-worker");
    assert.deepEqual(host.pdfWorkerCalls, [9002]);
  });

  it("persists nothing for an attachment with no local file (not downloaded yet)", async function () {
    // No getFilePathAsync: the file is not on disk (sync before download).
    const item = mockPdfAttachment(9999);
    const result = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "prefetch",
    });
    assert.equal(result.status, "skipped");
    assert.isNull(await store.getDocument(9999));
    assert.deepEqual((await store.getCoverage([9999])).missing, [9999]);
  });

  it("indexes a paper synced before its file downloaded once the file arrives (no permanent no-text row)", async function () {
    // Sync adds the item before the file exists: nothing to extract.
    let fileOnDisk = false;
    const item = Object.assign(mockPdfAttachment(9003), {
      key: "K9003",
      libraryID: 1,
      getFilePathAsync: async () =>
        fileOnDisk ? "/storage/K9003/paper.pdf" : false,
    }) as unknown as Zotero.Item;
    const timers: Array<() => void> = [];
    const scheduler = new LibraryTextIndexScheduler({
      setTimer: (cb) => {
        timers.push(cb);
        return cb;
      },
      clearTimer: () => undefined,
      getStore: async () => store,
      getItem: (id) => (id === 9003 ? item : null),
      listLibraryIds: () => [1],
      isEnabled: () => true,
      isUserIdle: () => true,
      isIndexable: () => true,
      hasMineruCache: async () => false,
      currentVectorNamespace: () => null,
    });
    const drain = async () => {
      for (let i = 0; i < 6 && timers.length; i += 1) {
        timers.shift()!();
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const change = (event: "add" | "modify") =>
      scheduler.handleChange({
        event,
        type: "item",
        ids: [9003],
        extraData: {},
        receivedAt: 0,
      });
    scheduler.start();
    try {
      await change("add");
      await drain();
      assert.isNull(
        await store.getDocument(9003),
        "a missing file must not become a permanent no-text row",
      );
      assert.equal((await store.countQueue(1)).queued, 0, "job removed");
      assert.deepEqual((await store.getCoverage([9003])).missing, [9003]);

      // The file arrives: Zotero fires modify on the attachment.
      await buildFixturePdfContext("bioSingleHash", 9003);
      pdfTextCache.clear();
      fileOnDisk = true;
      (globalThis as any).IOUtils.stat = async () => ({
        size: 4096,
        lastModified: 5000,
      });
      await change("modify");
      assert.equal(
        (await store.dequeueNext({ now: Date.now() }))?.priority,
        INDEX_PRIORITY.modified,
        "re-queued in the urgent lane",
      );
      await drain();
      const row = await store.getDocument(9003);
      assert.isAbove(row?.chunkCount ?? 0, 3);
      assert.equal(row?.sourceSize, 4096);
    } finally {
      await scheduler.stop();
    }
  });

  it("rebuilds a document an older chunker indexed: reconcile queues it for idle time and the reindex carries the enclosing section", async function () {
    const markdown = headingSequenceMarkdown(
      ["Introduction", "Materials and methods", "Data analysis", "References"],
      { "Data analysis": "Quorvex traces were deconvolved first." },
    );
    const ctx = await buildMarkdownPdfContext(markdown, 9005);
    const fileState = {
      path: "/storage/K9005/paper.pdf",
      size: 4096,
      mtime: 1234,
    };
    const current = buildIndexDocumentFromPdfContext({
      attachmentId: 9005,
      attachmentKey: "K9005",
      libraryID: 1,
      parentItemId: 100,
      fileState,
      ctx,
    });
    // As the previous chunker stored it: its version, no enclosing section.
    await store.upsertDocument({
      ...current,
      chunkerVersion: LIBRARY_TEXT_INDEX_CHUNKER_VERSION - 2, // 2 would only be re-posted
      chunks: current.chunks.map((chunk) => {
        const { enclosingSection: _dropped, ...meta } = chunk.meta;
        return { ...chunk, meta };
      }),
    });
    pdfTextCache.clear();
    const item = Object.assign(mockPdfAttachment(9005), {
      key: "K9005",
      libraryID: 1,
      getFilePathAsync: async () => fileState.path,
    }) as unknown as Zotero.Item;
    (globalThis as any).IOUtils.stat = async () => ({
      size: fileState.size,
      lastModified: fileState.mtime,
    });
    const timers: Array<() => void> = [];
    const scheduler = new LibraryTextIndexScheduler({
      setTimer: (cb) => {
        timers.push(cb);
        return cb;
      },
      clearTimer: () => undefined,
      getStore: async () => store,
      getItem: (id) => (id === 9005 ? item : null),
      getSnapshot: async () =>
        ({
          pdfAttachmentIdsByItemId: new Map([[100, [9005]]]),
          attachmentById: new Map([
            [9005, { attachmentId: 9005, isContextEligiblePdf: true }],
          ]),
          itemById: new Map([[100, { itemId: 100, addedAt: 1 }]]),
        }) as any,
      readFileState: async () => fileState,
      listLibraryIds: () => [1],
      isEnabled: () => true,
      isUserIdle: () => true,
      isIndexable: () => true,
      hasMineruCache: async () => true,
      currentVectorNamespace: () => null,
    });
    try {
      const result = await scheduler.reconcile(1);
      assert.equal(result.stale, 1, "only the chunker version made it stale");
      const queued = await store.dequeueNext({ now: Date.now() });
      assert.equal(queued?.reason, "chunkerVersion");
      assert.equal(queued?.priority, INDEX_PRIORITY.chunkerVersion);

      scheduler.start();
      for (let i = 0; i < 6 && timers.length; i += 1) {
        timers.shift()!();
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(
        (await store.getDocument(9005))?.chunkerVersion,
        LIBRARY_TEXT_INDEX_CHUNKER_VERSION,
      );
      const hits = await searchLibraryTextIndex({
        store,
        scopeAttachmentIds: [9005],
        queries: ["quorvex"],
        maxPapers: 1,
        perPaperTopK: 5,
      });
      assert.deepEqual(
        hits.chunks.map((hit) => [
          hit.meta.sectionLabel,
          hit.meta.enclosingSection,
        ]),
        [["Data analysis", "Materials and methods"]],
      );
    } finally {
      await scheduler.stop();
    }
  });

  it("reports no_text and writes a zero-chunk row for a readable file with no extractable text", async function () {
    const item = Object.assign(mockPdfAttachment(9999), {
      getFilePathAsync: async () => "/storage/K9999/scan.pdf",
    }) as unknown as Zotero.Item;
    (globalThis as any).IOUtils.stat = async () => ({
      size: 777,
      lastModified: 4242,
    });
    const result = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "prefetch",
    });
    assert.equal(result.status, "no_text");
    // A zero-chunk row, so a scanned PDF is not re-extracted every session;
    // reconcile's stat and MinerU-upgrade checks still re-queue it on change.
    const row = await store.getDocument(9999);
    assert.equal(row?.sourceType, "none");
    assert.equal(row?.chunkCount, 0);
    assert.equal(row?.byteEstimate, 0);
    assert.deepEqual((await store.getCoverage([9999])).missing, []);
  });

  it("records the file state on a no_text row so a changed file is re-queued", async function () {
    const item = Object.assign(mockPdfAttachment(9999), {
      getFilePathAsync: async () => "/storage/K9999/scan.pdf",
    }) as unknown as Zotero.Item;
    (globalThis as any).IOUtils.stat = async () => ({
      size: 777,
      lastModified: 4242,
    });
    const result = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "prefetch",
    });
    assert.equal(result.status, "no_text");
    const row = await store.getDocument(9999);
    assert.equal(row?.sourceMtime, 4242);
    assert.equal(row?.sourceSize, 777);
  });

  it("pins the chunker output so a chunking change forces a version bump", async function () {
    const bio = await buildFixturePdfContext("bioSingleHash", 9001);
    const math = await buildFixturePdfContext("mathDoubleHash", 9002);
    // Update BOTH constants below in the same commit when chunking changes:
    // the fingerprint here and LIBRARY_TEXT_INDEX_CHUNKER_VERSION in constants.ts.
    assert.equal(
      `${computeChunkerFingerprint(bio)}:${computeChunkerFingerprint(math)}`,
      "3cb58673:2c4c17d6",
    );
    assert.equal(LIBRARY_TEXT_INDEX_CHUNKER_VERSION, 3);
    // 3 is 2 plus stemmed postings: the boundaries (fingerprint) are unchanged.
  });
  it("never triggers a write-through listener, in either lane", async function () {
    await buildFixturePdfContext("bioSingleHash", 9001);
    pdfTextCache.clear();
    globals.fulltextCacheText.set(
      9002,
      "Abstract. The quorvex coefficient was 0.37.",
    );
    const seen: number[] = [];
    const off = onPdfContextLoaded((id) => seen.push(id));
    try {
      const urgent = await indexAttachment({
        item: mockPdfAttachment(9001),
        libraryID: 1,
        store,
        lane: "urgent",
      });
      const prefetch = await indexAttachment({
        item: mockPdfAttachment(9002),
        libraryID: 1,
        store,
        lane: "prefetch",
      });
      assert.equal(urgent.status, "indexed");
      assert.equal(prefetch.status, "indexed");
      assert.deepEqual(seen, []);
    } finally {
      off();
    }
  });
});

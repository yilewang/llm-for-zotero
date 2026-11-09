import { assert } from "chai";
import {
  onPdfContextLoaded,
  pdfTextCache,
  pdfTextLoadingTasks,
} from "../src/services/paperContent/contextCache";
import {
  ensureNoteTextCached,
  ensurePDFTextCached,
  invalidateCachedContextText,
} from "../src/services/paperContent/pdfContext";
import { paperTextStore } from "../src/services/paperContent/paperTextStore";
import type { PdfContext } from "../src/services/paperContent/types";
import { configureRetrievalCandidateInvalidator } from "../src/services/retrieval/cacheInvalidation";
import { warmQuoteSourceCachesForPaperContexts } from "../src/modules/contextPanel/quoteValidation/sourceEvidence";
import {
  buildFixturePdfContext,
  mockPdfAttachment,
  restoreTestGlobals,
  setupMemoryIO,
  snapshotTestGlobals,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";

function fakeContext(
  sourceType: PdfContext["sourceType"],
  chunks: string[] = ["seeded text"],
): PdfContext {
  return {
    title: "Seeded",
    chunks,
    chunkMeta: [],
    chunkStats: [],
    docFreq: {},
    avgChunkLength: chunks.length ? 11 : 0,
    fullLength: chunks.join("").length,
    sourceType,
  } as PdfContext;
}

/**
 * The scheduler instance that `invalidateCachedContextText` reaches through its
 * lazy `import()`. Under the test loader a static import yields a different
 * module instance, so spies attach to the dynamically imported one.
 */
async function lazySchedulerModule() {
  return import("../src/services/libraryTextIndex/scheduler");
}

/** Lets fire-and-forget work (lazy imports, quiet file removal) settle. */
async function flushAsyncWork(): Promise<void> {
  await lazySchedulerModule();
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("paper text store", function () {
  let globals: TestGlobalSnapshot;
  before(function () {
    globals = snapshotTestGlobals();
  });
  after(function () {
    restoreTestGlobals(globals);
  });
  // Records the candidate drops of every load; "invalidation" installs its own.
  let loadInvalidated: Array<number | undefined>;
  let restoreLoadInvalidator: () => void;
  beforeEach(function () {
    loadInvalidated = [];
    restoreLoadInvalidator = configureRetrievalCandidateInvalidator((id) =>
      loadInvalidated.push(id),
    );
  });
  afterEach(function () {
    restoreLoadInvalidator();
    pdfTextCache.clear();
    pdfTextLoadingTasks.clear();
  });

  describe("load", function () {
    it("reuses an entry whose source matches the requested mode and reloads a mismatched one", async function () {
      await buildFixturePdfContext("bioSingleHash", 9001);
      const item = mockPdfAttachment(9001);

      const textEntry = fakeContext("zotero-worker");
      pdfTextCache.set(9001, textEntry);
      await ensurePDFTextCached(item, { sourceMode: "pdf" });
      assert.strictEqual(
        pdfTextCache.get(9001),
        textEntry,
        "pdf mode accepts any cached source",
      );
      await ensurePDFTextCached(item);
      assert.strictEqual(
        pdfTextCache.get(9001),
        textEntry,
        "no mode accepts any cached source",
      );
      assert.deepEqual(
        loadInvalidated,
        [],
        "a reused entry keeps its candidates",
      );

      await ensurePDFTextCached(item, { sourceMode: "mineru" });
      const reloaded = pdfTextCache.get(9001);
      assert.notStrictEqual(reloaded, textEntry, "mismatched entry dropped");
      assert.equal(reloaded?.sourceType, "mineru");
      assert.isAbove(reloaded?.chunks.length || 0, 0);
      assert.deepEqual(
        loadInvalidated,
        [9001],
        "the dropped entry's retrieval candidates go with it",
      );
    });

    it("concurrent loads share one in-progress task and notify once", async function () {
      await buildFixturePdfContext("bioSingleHash", 9001);
      pdfTextCache.clear();
      const seen: number[] = [];
      const off = onPdfContextLoaded((id) => seen.push(id));
      try {
        const item = mockPdfAttachment(9001);
        const first = ensurePDFTextCached(item);
        const task = pdfTextLoadingTasks.get(9001);
        assert.exists(task, "the first load registers its task");
        const second = ensurePDFTextCached(item);
        assert.strictEqual(
          pdfTextLoadingTasks.get(9001),
          task,
          "the second load waits on the same task",
        );
        await Promise.all([first, second]);
        assert.deepEqual(seen, [9001]);
        assert.isFalse(pdfTextLoadingTasks.has(9001), "task removed on finish");
        assert.isTrue(pdfTextCache.has(9001));
      } finally {
        off();
      }
    });

    it("a note load reuses any cached entry without a source-mode check", async function () {
      const entry = fakeContext("mineru");
      pdfTextCache.set(9200, entry);
      const note = {
        id: 9200,
        isNote: () => true,
      } as unknown as Zotero.Item;
      await ensureNoteTextCached(note);
      assert.strictEqual(pdfTextCache.get(9200), entry);
    });
  });

  describe("store operations", function () {
    const item = (id: number) => ({ id }) as unknown as Zotero.Item;

    it("peek returns the cached entry whatever source produced it", function () {
      const entry = fakeContext("mineru");
      pdfTextCache.set(9500, entry);
      assert.strictEqual(paperTextStore.peek(9500), entry);
      assert.isUndefined(paperTextStore.peek(9501));
    });

    it("isCachedOrLoading sees a cached entry or an in-progress load", function () {
      assert.isFalse(paperTextStore.isCachedOrLoading(9510));
      pdfTextLoadingTasks.set(9510, Promise.resolve());
      assert.isTrue(paperTextStore.isCachedOrLoading(9510));
      pdfTextLoadingTasks.delete(9510);
      pdfTextCache.set(9510, fakeContext("mineru"));
      assert.isTrue(paperTextStore.isCachedOrLoading(9510));
    });

    it("a waiter whose mode the finished load does not match reloads with its own mode", async function () {
      const modes: Array<string | undefined> = [];
      const extract = async (
        target: Zotero.Item,
        options?: { sourceMode?: string },
      ) => {
        modes.push(options?.sourceMode);
        await Promise.resolve();
        paperTextStore.write(
          target.id,
          fakeContext(
            options?.sourceMode === "mineru" ? "mineru" : "zotero-worker",
          ),
        );
      };
      await Promise.all([
        paperTextStore.load(item(9520), { sourceMode: "text" }, extract),
        paperTextStore.load(item(9520), { sourceMode: "mineru" }, extract),
      ]);
      assert.deepEqual(modes, ["text", "mineru"]);
      assert.equal(paperTextStore.peek(9520)?.sourceType, "mineru");
      assert.deepEqual(
        loadInvalidated,
        [9520],
        "the text-mode candidates dropped",
      );
      assert.isFalse(pdfTextLoadingTasks.has(9520));
    });

    it("a chat load that joins a silent index load of a PDF loads it with its structure", async function () {
      const calls: Array<boolean | undefined> = [];
      const extract = async (
        target: Zotero.Item,
        options?: { silentLoad?: boolean },
      ) => {
        calls.push(options?.silentLoad);
        await Promise.resolve();
        const context = fakeContext("zotero-worker");
        if (!options?.silentLoad)
          context.documentStructure = {
            source: "bookmarks",
          } as PdfContext["documentStructure"];
        paperTextStore.write(target.id, context);
      };
      // The index starts first; the chat arrives while it runs.
      await Promise.all([
        paperTextStore.load(item(9540), { silentLoad: true }, extract),
        paperTextStore.load(item(9540), undefined, extract),
      ]);
      assert.deepEqual(calls, [true, undefined]);
      assert.exists(paperTextStore.peek(9540)?.documentStructure);
      // A silent entry already cached is not served to a chat either.
      pdfTextCache.clear();
      calls.length = 0;
      await paperTextStore.load(item(9541), { silentLoad: true }, extract);
      await paperTextStore.load(item(9541), undefined, extract);
      assert.deepEqual(calls, [true, undefined]);
      assert.exists(paperTextStore.peek(9541)?.documentStructure);
      // The index still reuses a chat's entry, and a chat reuses its own.
      await paperTextStore.load(item(9541), { silentLoad: true }, extract);
      await paperTextStore.load(item(9541), undefined, extract);
      assert.deepEqual(calls, [true, undefined]);
    });

    it("a silent load returns the text it loaded although a chat load replaced it, and its release keeps the chat's entry", async function () {
      const extract = async (target: Zotero.Item) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        paperTextStore.write(target.id, fakeContext("zotero-worker"));
      };
      // The indexer: borrow, load silently, use what the load returns.
      const indexer = (async () => {
        const release = paperTextStore.borrow(9542);
        const loaded = await paperTextStore.load(
          item(9542),
          { silentLoad: true },
          extract,
        );
        release(loaded);
        return loaded;
      })();
      // A chat load arrives while the index load runs.
      await new Promise((resolve) => setTimeout(resolve, 1));
      const chat = paperTextStore.load(item(9542), undefined, extract);
      const [indexed, chatLoaded] = await Promise.all([indexer, chat]);
      assert.deepEqual(indexed?.chunks, ["seeded text"]);
      assert.exists(chatLoaded);
      assert.notStrictEqual(chatLoaded, indexed);
      assert.strictEqual(
        paperTextStore.peek(9542),
        chatLoaded,
        "the chat's entry stays cached",
      );
    });

    it("a chat load reuses a silent entry whose source carries no structure", async function () {
      let loads = 0;
      const extract = async (target: Zotero.Item) => {
        loads += 1;
        paperTextStore.write(target.id, fakeContext("mineru"));
      };
      await paperTextStore.load(item(9545), { silentLoad: true }, extract);
      await paperTextStore.load(item(9545), undefined, extract);
      assert.equal(loads, 1);
    });

    it("a cancelled load stores nothing, and a waiter loads again", async function () {
      const controller = new AbortController();
      let loads = 0;
      const extract = async (
        target: Zotero.Item,
        options?: { signal?: AbortSignal },
      ) => {
        loads += 1;
        await Promise.resolve();
        if (options?.signal?.aborted) return;
        paperTextStore.write(target.id, fakeContext("zotero-worker"));
      };
      const cancelled = paperTextStore.load(
        item(9546),
        { signal: controller.signal },
        extract,
      );
      const waiter = paperTextStore.load(item(9546), undefined, extract);
      controller.abort();
      await Promise.all([cancelled, waiter]);
      assert.equal(loads, 2);
      assert.isTrue(paperTextStore.has(9546));
    });

    it("a silent load or a load without chunks notifies nobody", async function () {
      const seen: number[] = [];
      const off = onPdfContextLoaded((id) => seen.push(id));
      try {
        await paperTextStore.load(item(9530), { silentLoad: true }, async (t) =>
          paperTextStore.write(t.id, fakeContext("zotero-worker")),
        );
        await paperTextStore.load(item(9531), undefined, async (t) =>
          paperTextStore.write(t.id, fakeContext("zotero-worker", [])),
        );
        await paperTextStore.load(item(9532), undefined, async (t) =>
          paperTextStore.write(t.id, fakeContext("zotero-worker")),
        );
        assert.deepEqual(seen, [9532]);
      } finally {
        off();
      }
    });

    it("borrow evicts on release only an entry that was absent when borrowed", async function () {
      const writeFake = async (target: Zotero.Item) => {
        paperTextStore.write(target.id, fakeContext("mineru"));
      };
      const releaseFresh = paperTextStore.borrow(9540);
      const fresh = await paperTextStore.load(
        item(9540),
        { silentLoad: true },
        writeFake,
      );
      releaseFresh(fresh);
      assert.isFalse(
        pdfTextCache.has(9540),
        "the borrower's own load is evicted",
      );

      const held = fakeContext("mineru");
      pdfTextCache.set(9541, held);
      const releaseHeld = paperTextStore.borrow(9541);
      releaseHeld();
      assert.strictEqual(
        pdfTextCache.get(9541),
        held,
        "someone else's load stays",
      );

      // Given the entry it loaded, release evicts only that entry.
      const releaseOwn = paperTextStore.borrow(9543);
      const own = await paperTextStore.load(
        item(9543),
        { silentLoad: true },
        writeFake,
      );
      const other = fakeContext("mineru");
      pdfTextCache.set(9543, other);
      releaseOwn(own);
      assert.strictEqual(
        pdfTextCache.get(9543),
        other,
        "an entry another load wrote stays",
      );
      pdfTextCache.set(9543, own!);
      releaseOwn(own);
      assert.isFalse(pdfTextCache.has(9543), "the borrower's own entry goes");
    });

    it("borrow release keeps a chat's entry when the silent load joined the chat's load", async function () {
      const extract = async (target: Zotero.Item) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        paperTextStore.write(target.id, fakeContext("zotero-worker"));
      };
      const chat = paperTextStore.load(item(9560), undefined, extract);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const release = paperTextStore.borrow(9560);
      const loaded = await paperTextStore.load(
        item(9560),
        { silentLoad: true },
        extract,
      );
      await chat;
      release(loaded);
      assert.strictEqual(
        paperTextStore.peek(9560),
        loaded,
        "the chat's entry stays cached",
      );
    });

    it("borrow release of a load that found no text keeps an entry a chat wrote meanwhile", async function () {
      const release = paperTextStore.borrow(9561);
      const loaded = await paperTextStore.load(
        item(9561),
        { silentLoad: true },
        async () => {},
      );
      assert.isUndefined(loaded);
      await paperTextStore.load(item(9561), undefined, async (target) => {
        paperTextStore.write(target.id, fakeContext("zotero-worker"));
      });
      release(loaded);
      assert.exists(paperTextStore.peek(9561), "the chat's entry stays");
    });

    it("borrow release evicts an entry its own silent load wrote", async function () {
      const release = paperTextStore.borrow(9562);
      const loaded = await paperTextStore.load(
        item(9562),
        { silentLoad: true },
        async (target) => {
          paperTextStore.write(target.id, fakeContext("zotero-worker"));
        },
      );
      assert.exists(loaded);
      release(loaded);
      assert.isFalse(pdfTextCache.has(9562));
    });

    it("discardEmptyEntry drops only an entry without text and leaves its load alone", function () {
      pdfTextCache.set(9550, fakeContext("mineru", ["  ", ""]));
      pdfTextLoadingTasks.set(9550, Promise.resolve());
      const kept = fakeContext("mineru");
      pdfTextCache.set(9551, kept);
      paperTextStore.discardEmptyEntry(9550);
      paperTextStore.discardEmptyEntry(9551);
      paperTextStore.discardEmptyEntry(9552);
      assert.isFalse(pdfTextCache.has(9550));
      assert.isTrue(pdfTextLoadingTasks.has(9550));
      assert.strictEqual(pdfTextCache.get(9551), kept);
    });

    it("clear drops every entry and every in-progress load", function () {
      pdfTextCache.set(9560, fakeContext("mineru"));
      pdfTextLoadingTasks.set(9561, Promise.resolve());
      paperTextStore.clear();
      assert.equal(pdfTextCache.size, 0);
      assert.equal(pdfTextLoadingTasks.size, 0);
    });
  });

  describe("invalidation", function () {
    let enqueued: Array<{ ids: number[]; reason: string }>;
    let invalidated: Array<number | undefined>;
    let scheduler: {
      enqueue: (ids: number[], reason: string) => Promise<void>;
    };
    let originalEnqueue: (ids: number[], reason: string) => Promise<void>;
    let restoreInvalidator: () => void;

    beforeEach(async function () {
      enqueued = [];
      invalidated = [];
      scheduler = (await lazySchedulerModule())
        .libraryTextIndexScheduler as unknown as typeof scheduler;
      originalEnqueue = scheduler.enqueue;
      scheduler.enqueue = async (ids, reason) => {
        enqueued.push({ ids, reason });
      };
      restoreInvalidator = configureRetrievalCandidateInvalidator((id) =>
        invalidated.push(id),
      );
    });
    afterEach(function () {
      scheduler.enqueue = originalEnqueue;
      restoreInvalidator();
    });

    it("full invalidation drops the entry, the in-progress load, retrieval candidates, the embedding cache, and queues a re-index", async function () {
      const io = setupMemoryIO();
      (globalThis as unknown as { Zotero: unknown }).Zotero = {
        DataDirectory: { dir: "/tmp/zotero" },
      };
      const embeddingPath = "/tmp/zotero/llm-for-zotero-embeddings/9300.json";
      io.files.set(embeddingPath, new Uint8Array([1]));
      pdfTextCache.set(9300, fakeContext("mineru"));
      pdfTextLoadingTasks.set(9300, Promise.resolve());

      invalidateCachedContextText(9300.7);
      assert.isFalse(pdfTextCache.has(9300));
      assert.isFalse(pdfTextLoadingTasks.has(9300));
      assert.deepEqual(invalidated, [9300]);
      await flushAsyncWork();
      assert.deepEqual(enqueued, [{ ids: [9300], reason: "textInvalidated" }]);
      assert.isFalse(io.files.has(embeddingPath), "embedding cache removed");
    });

    it("full invalidation ignores ids that are not positive numbers", async function () {
      pdfTextCache.set(1, fakeContext("mineru"));
      invalidateCachedContextText(0);
      invalidateCachedContextText(-3);
      invalidateCachedContextText(Number.NaN);
      await flushAsyncWork();
      assert.isTrue(pdfTextCache.has(1));
      assert.deepEqual(invalidated, []);
      assert.deepEqual(enqueued, []);
    });

    it("quote validation drops an empty entry and reloads it, but keeps an entry with text", async function () {
      const markdownItem = (id: number) =>
        ({
          id,
          parentID: 100,
          attachmentContentType: "text/markdown",
          isAttachment: () => true,
          isNote: () => false,
          getField: (field: string) => (field === "title" ? "Notes" : ""),
        }) as unknown as Zotero.Item;
      const items = new Map<number, Zotero.Item>([
        [9401, markdownItem(9401)],
        [9402, markdownItem(9402)],
      ]);
      (globalThis as unknown as { Zotero: unknown }).Zotero = {
        Items: { get: (id: number) => items.get(id) || null },
      };
      const empty = fakeContext("attachment-markdown", []);
      const withText = fakeContext("attachment-markdown", ["kept text"]);
      pdfTextCache.set(9401, empty);
      pdfTextCache.set(9402, withText);

      await warmQuoteSourceCachesForPaperContexts([
        [
          {
            itemId: 100,
            contextItemId: 9401,
            title: "Empty paper",
            contentSourceMode: "markdown",
          },
          {
            itemId: 100,
            contextItemId: 9402,
            title: "Text paper",
            contentSourceMode: "markdown",
          },
        ],
      ]);

      const retried = pdfTextCache.get(9401);
      assert.exists(retried, "the empty entry was reloaded");
      assert.notStrictEqual(retried, empty, "the empty entry was dropped");
      assert.strictEqual(pdfTextCache.get(9402), withText);
      assert.deepEqual(invalidated, [], "no retrieval clean-up");
      await flushAsyncWork();
      assert.deepEqual(enqueued, [], "no re-index");
    });
  });
});

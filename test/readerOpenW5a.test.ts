import { assert } from "chai";
import { createReaderOpenTool } from "../src/agent/tools/control/readerOpen";
import { getPdfAttachmentPageCount } from "../src/agent/services/pdfPageService";
import type { AgentToolContext } from "../src/agent/types";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

const context: AgentToolContext = {
  request: {
    conversationKey: 5,
    mode: "agent",
    userText: "x",
    libraryID: 1,
  },
  item: null,
  currentAnswerText: "",
  modelName: "test-model",
} as never;

describe("W5-A reader_open", function () {
  const original = globalScope.Zotero;
  let opens: Array<[number, unknown]>;
  let items: Map<number, Record<string, unknown>>;

  function pdf(id: number, parentID: number | false, fileExists = true) {
    return {
      id,
      parentID,
      deleted: false,
      key: `ATT${id}`,
      isAttachment: () => true,
      isRegularItem: () => false,
      isAnnotation: () => false,
      isPDFAttachment: () => true,
      fileExists: async () => fileExists,
      getDisplayTitle: () => `PDF ${id}`,
    };
  }

  beforeEach(function () {
    opens = [];
    items = new Map();
    globalScope.Zotero = {
      Tabs: { selectedID: "library" },
      Reader: {
        getByTabID: () => null,
        open: async (itemID: number, location: unknown) => {
          opens.push([itemID, location]);
          return { itemID };
        },
      },
    };
    items.set(10, {
      id: 10,
      deleted: false,
      isAttachment: () => false,
      isRegularItem: () => true,
      isAnnotation: () => false,
      getAttachments: () => [11, 12],
      getBestAttachment: async () => items.get(12),
    });
    items.set(11, pdf(11, 10));
    items.set(12, pdf(12, 10));
    items.set(20, {
      id: 20,
      deleted: false,
      key: "ANNKEY01",
      parentID: 11,
      isAttachment: () => false,
      isRegularItem: () => false,
      isAnnotation: () => true,
    });
  });
  afterEach(function () {
    globalScope.Zotero = original;
  });

  const tool = () =>
    createReaderOpenTool(
      {
        getItem: (id: number) => items.get(Number(id)) || null,
      } as never,
      40,
    );

  /** A reader whose viewer shows `label` on page number `page`. */
  function readerShowing(label: string | null, page: number) {
    return {
      itemID: 11,
      _internalReader: {
        _primaryView: {
          _iframeWindow: {
            PDFViewerApplication: {
              pdfDocument: {},
              pdfViewer: {
                pagesCount: 3,
                currentPageLabel: label,
                currentPageNumber: page,
              },
            },
          },
        },
      },
    };
  }

  function pageCountIs(totalPages: number | null) {
    const zotero = globalScope.Zotero as any;
    zotero.PDFWorker = {
      getFullText: async () => ({ totalPages }),
    };
  }

  async function run(args: Record<string, unknown>) {
    const t = tool();
    const validated = t.validate(args);
    if (!validated.ok) return { invalid: validated.error };
    return (await t.execute(validated.value, context)) as Record<
      string,
      unknown
    >;
  }

  it("is a control tool with a read-only plan", function () {
    const t = tool();
    assert.equal(t.spec.executionClass, "control");
    const plan = t.planInvocation?.({}, context as never);
    assert.equal(plan?.impact, "read_only");
  });

  it("opens a paper's best PDF at a page", async function () {
    const result = await run({ itemId: 10, pageIndex: 4 });
    assert.equal(result.ok, true);
    assert.equal(result.attachmentId, 12);
    assert.equal(result.itemId, 10);
    assert.deepEqual(opens, [[12, { pageIndex: 4 }]]);
  });

  it("opens a page label", async function () {
    await run({ attachmentId: 11, pageLabel: "iv" });
    assert.deepEqual(opens, [[11, { pageLabel: "iv" }]]);
  });

  it("opens an annotation's parent PDF at the annotation key", async function () {
    const result = await run({ annotationId: 20 });
    assert.equal(result.ok, true);
    assert.equal(result.attachmentId, 11);
    assert.deepEqual(opens, [[11, { annotationID: "ANNKEY01" }]]);
  });

  it("opens with no location when none is named", async function () {
    await run({ attachmentId: 11 });
    assert.deepEqual(opens, [[11, undefined]]);
  });

  it("refuses ambiguous or bad input before it touches the reader", async function () {
    for (const args of [
      {},
      { itemId: 10, attachmentId: 11 },
      { annotationId: 20, pageIndex: 1 },
      { annotationId: 20, itemId: 10 },
      { itemId: 10, pageIndex: 1, pageLabel: "2" },
      { itemId: 10, pageIndex: -1 },
      { itemId: 10, pageIndex: 1.5 },
    ]) {
      const result = await run(args);
      assert.property(result, "invalid", JSON.stringify(args));
    }
    assert.lengthOf(opens, 0);
  });

  it("reports what it cannot open", async function () {
    items.set(13, pdf(13, 10, false));
    const noFile = await run({ attachmentId: 13 });
    assert.equal(noFile.ok, false);
    const notAnnotation = await run({ annotationId: 10 });
    assert.equal(notAnnotation.ok, false);
    const asItem = await run({ itemId: 11 });
    assert.equal(asItem.ok, false);
    assert.lengthOf(opens, 0);
  });

  it("refuses a pageIndex past the last page before it opens anything", async function () {
    pageCountIs(3);
    const past = await run({ attachmentId: 11, pageIndex: 3 });
    assert.equal(past.ok, false);
    assert.match(String(past.error), /3 pages/);
    assert.lengthOf(opens, 0);

    const last = await run({ attachmentId: 11, pageIndex: 2 });
    assert.equal(last.ok, true);
    assert.deepEqual(opens, [[11, { pageIndex: 2 }]]);
  });

  it("still opens when the page count cannot be read", async function () {
    pageCountIs(null);
    const result = await run({ attachmentId: 11, pageIndex: 40 });
    assert.equal(result.ok, true);
    assert.lengthOf(opens, 1);
  });

  it("gives up on the page count when the PDF worker is busy", async function () {
    const zotero = globalScope.Zotero as any;
    zotero.PDFWorker = { getFullText: () => new Promise(() => {}) };
    const started = Date.now();
    assert.isNull(await getPdfAttachmentPageCount(11, 30));
    assert.isBelow(Date.now() - started, 1000);
  });

  it("verifies a page label from the page the reader shows", async function () {
    (globalScope.Zotero as any).Reader.open = async (
      itemID: number,
      location: unknown,
    ) => {
      opens.push([itemID, location]);
      return readerShowing("iv", 4);
    };
    const result = await run({ attachmentId: 11, pageLabel: "iv" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.location, {
      pageLabel: "iv",
      pageLabelVerified: true,
    });
    assert.isUndefined(result.note);
  });

  it("takes the page number as the label of a PDF that has no labels", async function () {
    (globalScope.Zotero as any).Reader.open = async () =>
      readerShowing(null, 2);
    const result = await run({ attachmentId: 11, pageLabel: "2" });
    assert.deepEqual(result.location, {
      pageLabel: "2",
      pageLabelVerified: true,
    });
  });

  it("reports a label the reader did not reach as requested, not verified", async function () {
    (globalScope.Zotero as any).Reader.open = async () =>
      readerShowing(null, 1);
    const result = await run({ attachmentId: 11, pageLabel: "xii" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.location, {
      pageLabel: "xii",
      pageLabelVerified: false,
    });
    assert.match(String(result.note), /requested, not verified/);
    assert.match(String(result.note), /"1"/);
  });

  it("tells the model to open a reader only when the user asks, and that pageIndex starts at 0", function () {
    const { description } = tool().spec;
    assert.include(description, "When the user asks to open or show a PDF");
    assert.include(description, "0-based");
  });
});

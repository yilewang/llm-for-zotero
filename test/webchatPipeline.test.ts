import { assert } from "chai";
import type { PaperContextRef } from "../src/modules/contextPanel/types";

type PipelineModule = typeof import("../src/webchat/pipeline");
type RelayServerModule = typeof import("../src/webchat/relayServer");

describe("webchat PDF pipeline", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (globalThis as typeof globalThis & { ztoolkit?: any })
    .ztoolkit;
  const originalIOUtils = (
    globalThis as typeof globalThis & { IOUtils?: unknown }
  ).IOUtils;
  const items = new Map<number, Zotero.Item>();
  let pipeline: PipelineModule;
  let relayServer: RelayServerModule;

  function attachment(params: {
    id: number;
    parentID?: number;
    path: string | false;
    contentType?: string;
    onPath?: () => void;
  }): Zotero.Item {
    return {
      id: params.id,
      parentID: params.parentID,
      attachmentContentType: params.contentType || "application/pdf",
      isAttachment: () => true,
      getFilePathAsync: async () => {
        params.onPath?.();
        return params.path;
      },
    } as unknown as Zotero.Item;
  }

  function parent(id: number, deleted = false): Zotero.Item {
    return {
      id,
      deleted,
      isRegularItem: () => true,
      isAttachment: () => false,
    } as unknown as Zotero.Item;
  }

  function context(itemId: number, contextItemId: number): PaperContextRef {
    return {
      itemId,
      contextItemId,
      title: `Paper ${itemId}`,
      contentSourceMode: "pdf",
    };
  }

  async function expectRejected(
    promise: Promise<unknown>,
    messageFragment: string,
  ): Promise<void> {
    let error: unknown;
    try {
      await promise;
    } catch (err) {
      error = err;
    }
    assert.instanceOf(error, Error);
    assert.include((error as Error).message, messageFragment);
  }

  before(async function () {
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Items: {
        get: (id: number) => items.get(id),
      },
      Prefs: {
        get: () => 23119,
      },
      Server: {
        Endpoints: {},
      },
    } as unknown as typeof Zotero;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { log: () => void; getGlobal: () => undefined };
      }
    ).ztoolkit = {
      log: () => {},
      getGlobal: () => undefined,
    };
    pipeline = await import("../src/webchat/pipeline");
    relayServer = await import("../src/webchat/relayServer");
  });

  beforeEach(function () {
    items.clear();
    relayServer.relayResetForTests();
    relayServer.relaySetExtensionCapabilitiesForTests([
      relayServer.ATTACHMENT_DELIVERY_CONTRACT_VERSION,
    ]);
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  it("uses the exact selected PDF instead of the first sibling", async function () {
    items.set(10, parent(10));
    items.set(
      101,
      attachment({ id: 101, parentID: 10, path: "/papers/PDF_A.pdf" }),
    );
    items.set(
      102,
      attachment({ id: 102, parentID: 10, path: "/papers/PDF_B.pdf" }),
    );

    const resolved = await pipeline.resolveSelectedWebChatPdfBatch([
      context(10, 102),
    ]);

    assert.deepEqual(resolved, [
      { path: "/papers/PDF_B.pdf", filename: "PDF_B.pdf" },
    ]);
  });

  it("submits only the selected sibling's bytes to the relay", async function () {
    items.set(10, parent(10));
    items.set(
      101,
      attachment({ id: 101, parentID: 10, path: "/papers/PDF_A.pdf" }),
    );
    items.set(
      102,
      attachment({ id: 102, parentID: 10, path: "/papers/PDF_B.pdf" }),
    );
    const readPaths: string[] = [];
    (globalThis as typeof globalThis & { IOUtils?: unknown }).IOUtils = {
      read: async (path: string) => {
        readPaths.push(path);
        return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
      },
    };
    const abortController = new AbortController();
    let send: Promise<unknown> | null = null;
    const seqBeforeSend = relayServer.relayGetStateSnapshot().query.seq;

    try {
      send = pipeline.sendWebChatQuestion({
        item: items.get(102)!,
        question: "Read the selected PDF",
        host: "http://127.0.0.1:23119/llm-for-zotero/webchat",
        sendPdf: true,
        pdfPaperContexts: [context(10, 102)],
        signal: abortController.signal,
        onAnswerSnapshot: () => {},
      });

      let snapshot = relayServer.relayGetStateSnapshot();
      for (
        let attempt = 0;
        attempt < 20 && snapshot.query.seq === seqBeforeSend;
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        snapshot = relayServer.relayGetStateSnapshot();
      }

      assert.deepEqual(readPaths, ["/papers/PDF_B.pdf"]);
      assert.equal(snapshot.query.pdf_filename, "PDF_B.pdf");
      assert.equal(snapshot.query.pdf_base64, "JVBERi0=");
      relayServer.relayRequestStop();
      await send.catch(() => undefined);
    } finally {
      abortController.abort();
      await send?.catch(() => undefined);
      (globalThis as typeof globalThis & { IOUtils?: unknown }).IOUtils =
        originalIOUtils;
    }
  });

  it("preserves selected PDF order across different papers", async function () {
    items.set(20, parent(20));
    items.set(10, parent(10));
    items.set(
      202,
      attachment({ id: 202, parentID: 20, path: "/papers/second.pdf" }),
    );
    items.set(
      101,
      attachment({ id: 101, parentID: 10, path: "/papers/first.pdf" }),
    );

    const resolved = await pipeline.resolveSelectedWebChatPdfBatch([
      context(20, 202),
      context(10, 101),
    ]);

    assert.deepEqual(
      resolved.map((entry) => entry.path),
      ["/papers/second.pdf", "/papers/first.pdf"],
    );
  });

  it("fails the whole batch when one selected identity is invalid", async function () {
    const pathLookups: number[] = [];
    items.set(10, parent(10));
    items.set(
      101,
      attachment({
        id: 101,
        parentID: 10,
        path: "/papers/first.pdf",
        onPath: () => pathLookups.push(101),
      }),
    );
    items.set(
      202,
      attachment({
        id: 202,
        parentID: 999,
        path: "/papers/wrong-parent.pdf",
        onPath: () => pathLookups.push(202),
      }),
    );

    await expectRejected(
      pipeline.resolveSelectedWebChatPdfBatch([
        context(10, 101),
        context(20, 202),
      ]),
      "identity changed",
    );
    assert.deepEqual(pathLookups, [101]);
  });

  it("rejects multiple selected PDFs before reading or submitting one", async function () {
    items.set(10, parent(10));
    items.set(20, parent(20));
    items.set(
      101,
      attachment({ id: 101, parentID: 10, path: "/papers/first.pdf" }),
    );
    items.set(
      202,
      attachment({ id: 202, parentID: 20, path: "/papers/second.pdf" }),
    );
    let readCalls = 0;
    (globalThis as typeof globalThis & { IOUtils?: unknown }).IOUtils = {
      read: async () => {
        readCalls += 1;
        return new Uint8Array([1]);
      },
    };

    try {
      await expectRejected(
        pipeline.sendWebChatQuestion({
          item: items.get(101)!,
          question: "Compare these papers",
          host: "http://127.0.0.1:23119/llm-for-zotero/webchat",
          sendPdf: true,
          pdfPaperContexts: [context(10, 101), context(20, 202)],
          onAnswerSnapshot: () => {},
        }),
        "exactly one selected PDF",
      );
      assert.equal(readCalls, 0);
    } finally {
      (globalThis as typeof globalThis & { IOUtils?: unknown }).IOUtils =
        originalIOUtils;
    }
  });

  it("rejects changed non-PDF bytes before relay submission", async function () {
    items.set(10, parent(10));
    items.set(
      101,
      attachment({ id: 101, parentID: 10, path: "/papers/changed.pdf" }),
    );
    (globalThis as typeof globalThis & { IOUtils?: unknown }).IOUtils = {
      read: async () => new TextEncoder().encode("not a PDF"),
    };
    const seqBeforeSend = relayServer.relayGetStateSnapshot().query.seq;

    try {
      await expectRejected(
        pipeline.sendWebChatQuestion({
          item: items.get(101)!,
          question: "Read the selected PDF",
          host: "http://127.0.0.1:23119/llm-for-zotero/webchat",
          sendPdf: true,
          pdfPaperContexts: [context(10, 101)],
          onAnswerSnapshot: () => {},
        }),
        "not a valid PDF",
      );
      assert.equal(
        relayServer.relayGetStateSnapshot().query.seq,
        seqBeforeSend,
      );
    } finally {
      (globalThis as typeof globalThis & { IOUtils?: unknown }).IOUtils =
        originalIOUtils;
    }
  });

  it("supports an exact standalone PDF identity", async function () {
    items.set(303, attachment({ id: 303, path: "/papers/standalone.pdf" }));

    const resolved = await pipeline.resolveSelectedWebChatPdfBatch([
      context(303, 303),
    ]);

    assert.deepEqual(resolved, [
      { path: "/papers/standalone.pdf", filename: "standalone.pdf" },
    ]);
  });

  it("rejects trashed attachments and trashed parents", async function () {
    const trashedAttachment = attachment({
      id: 101,
      parentID: 10,
      path: "/papers/trashed-attachment.pdf",
    }) as Zotero.Item & { deleted?: boolean };
    trashedAttachment.deleted = true;
    items.set(10, parent(10));
    items.set(101, trashedAttachment);

    await expectRejected(
      pipeline.resolveSelectedWebChatPdfBatch([context(10, 101)]),
      "attachment is in the trash",
    );

    items.set(20, parent(20, true));
    items.set(
      202,
      attachment({
        id: 202,
        parentID: 20,
        path: "/papers/trashed-parent.pdf",
      }),
    );
    await expectRejected(
      pipeline.resolveSelectedWebChatPdfBatch([context(20, 202)]),
      "parent is in the trash",
    );
  });
});

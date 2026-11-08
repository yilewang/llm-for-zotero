import { assert } from "chai";
import {
  AttachmentCapability,
  type AttachmentCapabilityDeps,
} from "../src/agent/services/zotero/attachmentCapability";

/**
 * The attachment paths used to live on `ZoteroGateway` and reached the item
 * lookups through `this`. They now take those lookups as dependencies, so
 * this file drives the capability on its own — the same behaviour
 * `attachmentRenameRelink.test.ts` pins through the facade, asserted here
 * against the seam the facade fills in.
 */
describe("attachment capability", function () {
  let items: Map<number, Record<string, unknown>>;
  let indexed: number[][];

  const globalScope = globalThis as typeof globalThis & {
    Zotero?: unknown;
    ztoolkit?: { log?: (...args: unknown[]) => void };
  };
  const originalZotero = globalScope.Zotero;
  const originalZtoolkit = globalScope.ztoolkit;

  beforeEach(function () {
    items = new Map();
    indexed = [];
    // The failure branches log through the plugin's toolkit, which the host
    // installs on the global scope at startup.
    globalScope.ztoolkit = { log: () => undefined };
  });

  afterEach(function () {
    globalScope.Zotero = originalZotero;
    if (originalZtoolkit) globalScope.ztoolkit = originalZtoolkit;
    else delete globalScope.ztoolkit;
  });

  function installZotero(extra: Record<string, unknown> = {}) {
    globalScope.Zotero = {
      Items: { get: (id: number) => items.get(id) || null },
      Fulltext: {
        indexItems: async (ids: number[]) => {
          indexed.push(ids);
        },
        getIndexedState: async () => 3,
      },
      debug: () => undefined,
      ...extra,
    };
  }

  /** The capability under test, with every dependency answered explicitly. */
  function capability(deps: Partial<AttachmentCapabilityDeps> = {}) {
    return new AttachmentCapability({
      getItem: (itemId) =>
        (items.get(Number(itemId)) as unknown as Zotero.Item) || null,
      resolveBibliographicItem: (item) => item ?? null,
      ...deps,
    });
  }

  function makeAttachment(seed: {
    id: number;
    parentID?: number;
    title?: string;
    filename?: string;
    contentType?: string;
    linkMode?: number;
    hasFile?: boolean;
    extra?: Record<string, unknown>;
  }) {
    const attachment = {
      id: seed.id,
      parentID: seed.parentID,
      isAttachment: () => true,
      isRegularItem: () => false,
      isNote: () => false,
      isPDFAttachment: () => (seed.contentType || "") === "application/pdf",
      attachmentContentType: seed.contentType,
      attachmentFilename: seed.filename,
      attachmentLinkMode: seed.linkMode,
      hasFile: seed.hasFile,
      getField: (name: string) => (name === "title" ? seed.title || "" : ""),
      deleted: false,
      saveTx: async () => true,
      ...(seed.extra || {}),
    };
    items.set(seed.id, attachment as unknown as Record<string, unknown>);
    return attachment;
  }

  function makePaper(seed: { id: number; attachmentIds: number[] }) {
    const paper = {
      id: seed.id,
      isAttachment: () => false,
      isNote: () => false,
      isRegularItem: () => true,
      getAttachments: () => seed.attachmentIds,
    };
    items.set(seed.id, paper as unknown as Record<string, unknown>);
    return paper;
  }

  describe("listing a paper's files", function () {
    it("distinguishes two PDFs with the same display title by their native filenames", async function () {
      makePaper({ id: 1, attachmentIds: [2, 3] });
      for (const [id, filename] of [
        [2, "Geva - Time and experience.pdf"],
        [3, "Lee and Brandon - Commentary.pdf"],
      ] as const) {
        makeAttachment({
          id,
          parentID: 1,
          title: "PDF",
          filename,
          contentType: "application/pdf",
        });
      }
      installZotero();
      const infos = await capability().getAllChildAttachmentInfos(1);
      assert.deepEqual(
        infos.map((info) => info.filename),
        ["Geva - Time and experience.pdf", "Lee and Brandon - Commentary.pdf"],
      );
    });
    it("describes each child attachment and reads the index state of the PDFs", async function () {
      makePaper({ id: 1, attachmentIds: [2, 3] });
      makeAttachment({
        id: 2,
        parentID: 1,
        title: "Main paper",
        contentType: "application/pdf",
      });
      makeAttachment({
        id: 3,
        parentID: 1,
        filename: "supplement.csv",
        contentType: "text/csv",
      });
      installZotero();

      const infos = await capability().getAllChildAttachmentInfos(1);

      assert.deepEqual(
        infos.map((info) => info.contextItemId),
        [2, 3],
      );
      assert.equal(infos[0].title, "Main paper");
      assert.equal(infos[0].indexingState, "indexed");
      assert.equal(infos[1].title, "supplement.csv");
      // Only PDFs carry an indexing state; a CSV has nothing to index.
      assert.isUndefined(infos[1].indexingState);
      assert.isUndefined(infos[1].readableTextChars);
    });

    it("falls back to a content-type name when a file has no title", async function () {
      makePaper({ id: 1, attachmentIds: [2] });
      makeAttachment({ id: 2, parentID: 1, contentType: "application/pdf" });
      installZotero();

      const infos = await capability().getAllChildAttachmentInfos(1);

      assert.equal(infos[0].title, "PDF");
    });

    it("assumes a binary stream when the attachment declares no type", async function () {
      makePaper({ id: 1, attachmentIds: [2] });
      makeAttachment({ id: 2, parentID: 1, title: "Mystery file" });
      installZotero();

      const infos = await capability().getAllChildAttachmentInfos(1);

      assert.equal(infos[0].contentType, "application/octet-stream");
    });

    it("reports a PDF as unavailable rather than failing when the index state cannot be read", async function () {
      makePaper({ id: 1, attachmentIds: [2] });
      makeAttachment({ id: 2, parentID: 1, contentType: "application/pdf" });
      installZotero({
        Fulltext: {
          getIndexedState: async () => {
            throw new Error("index offline");
          },
        },
      });

      const infos = await capability().getAllChildAttachmentInfos(1);

      assert.equal(infos[0].indexingState, "unavailable");
    });

    it("asks the injected resolver for the paper behind a non-regular item", async function () {
      const paper = makePaper({ id: 1, attachmentIds: [2] });
      makeAttachment({
        id: 2,
        parentID: 1,
        title: "Main paper",
        contentType: "application/pdf",
      });
      makeAttachment({ id: 3, parentID: 1, title: "Child" });
      const asked: Array<number | undefined> = [];
      installZotero();

      const infos = await capability({
        resolveBibliographicItem: (item) => {
          asked.push((item as { id?: number } | null | undefined)?.id);
          return paper as unknown as Zotero.Item;
        },
      }).getAllChildAttachmentInfos(3);

      assert.deepEqual(asked, [3], "the capability never resolves it itself");
      assert.deepEqual(
        infos.map((info) => info.contextItemId),
        [2],
      );
    });

    it("returns nothing for an item that does not exist", async function () {
      installZotero();
      assert.deepEqual(await capability().getAllChildAttachmentInfos(404), []);
    });
  });

  describe("describing one attachment", function () {
    it("names the link mode Zotero stores as a number", function () {
      makeAttachment({
        id: 2,
        parentID: 1,
        title: "Paper",
        filename: "paper.pdf",
        contentType: "application/pdf",
        linkMode: 2,
        hasFile: true,
      });
      installZotero();

      const info = capability().getAttachmentInfo({ attachmentId: 2 });

      assert.deepEqual(info, {
        attachmentId: 2,
        parentItemId: 1,
        title: "Paper",
        contentType: "application/pdf",
        filename: "paper.pdf",
        hasFile: true,
        linkMode: "linked_file",
      });
    });

    it("finds the stored file of a native item, which has no hasFile property", function () {
      makeAttachment({
        id: 2,
        parentID: 1,
        filename: "notes.txt",
        contentType: "text/plain",
        linkMode: 0,
        extra: {
          isFileAttachment: () => true,
          getFilePath: () => "/library/storage/AB12/notes.txt",
        },
      });
      makeAttachment({
        id: 3,
        parentID: 1,
        contentType: "text/html",
        linkMode: 3,
        extra: { isFileAttachment: () => false, getFilePath: () => false },
      });
      installZotero();

      assert.isTrue(
        capability().getAttachmentInfo({ attachmentId: 2 })?.hasFile,
      );
      assert.isFalse(
        capability().getAttachmentInfo({ attachmentId: 3 })?.hasFile,
      );
    });

    it("says the link mode is unknown rather than inventing one", function () {
      makeAttachment({ id: 2, title: "Paper" });
      installZotero();

      assert.equal(
        capability().getAttachmentInfo({ attachmentId: 2 })?.linkMode,
        "unknown",
      );
    });

    it("falls back to the filename, then to the id, for the title", function () {
      makeAttachment({ id: 2, filename: "paper.pdf" });
      makeAttachment({ id: 3 });
      installZotero();

      assert.equal(
        capability().getAttachmentInfo({ attachmentId: 2 })?.title,
        "paper.pdf",
      );
      assert.equal(
        capability().getAttachmentInfo({ attachmentId: 3 })?.title,
        "Attachment 3",
      );
    });

    it("returns nothing for an item that is not an attachment", function () {
      makePaper({ id: 1, attachmentIds: [] });
      installZotero();

      assert.isNull(capability().getAttachmentInfo({ attachmentId: 1 }));
      assert.isNull(capability().getAttachmentInfo({ attachmentId: 404 }));
    });
  });

  describe("indexing a PDF", function () {
    it("runs the index and reports the state it reaches", async function () {
      makeAttachment({ id: 2, contentType: "application/pdf" });
      installZotero();

      const result = await capability().indexPdfAttachment({ attachmentId: 2 });

      assert.deepEqual(indexed, [[2]]);
      assert.deepEqual(result, {
        attachmentId: 2,
        indexingState: "indexed",
        triggered: true,
      });
    });

    it("reports the state as unavailable when it cannot be read back", async function () {
      makeAttachment({ id: 2, contentType: "application/pdf" });
      installZotero({
        Fulltext: {
          indexItems: async (ids: number[]) => {
            indexed.push(ids);
          },
          getIndexedState: async () => {
            throw new Error("index offline");
          },
        },
      });

      const result = await capability().indexPdfAttachment({ attachmentId: 2 });

      assert.equal(result.indexingState, "unavailable");
      assert.isTrue(result.triggered);
    });

    it("refuses anything that is not a PDF attachment", async function () {
      makePaper({ id: 1, attachmentIds: [] });
      makeAttachment({ id: 2, contentType: "text/csv" });
      installZotero();

      const messages: string[] = [];
      for (const attachmentId of [1, 2]) {
        try {
          await capability().indexPdfAttachment({ attachmentId });
        } catch (error) {
          messages.push(error instanceof Error ? error.message : String(error));
        }
      }

      assert.deepEqual(messages, [
        "Not an attachment item",
        "Not a PDF attachment",
      ]);
      assert.deepEqual(indexed, [], "nothing was queued for indexing");
    });
  });

  describe("deleting an attachment", function () {
    it("trashes it and reports the filename it had", async function () {
      const attachment = makeAttachment({ id: 2, filename: "paper.pdf" });
      installZotero();

      const result = await capability().deleteAttachment({ attachmentId: 2 });

      assert.deepEqual(result, {
        attachmentId: 2,
        title: "paper.pdf",
        status: "deleted",
      });
      assert.isTrue(attachment.deleted, "the row is only trashed, not erased");
    });

    it("says not_found instead of trashing something that is not an attachment", async function () {
      makePaper({ id: 1, attachmentIds: [] });
      installZotero();

      const result = await capability().deleteAttachment({ attachmentId: 1 });

      assert.equal(result.status, "not_found");
      assert.equal(result.title, "");
    });
  });

  describe("repairing an attachment's file", function () {
    it("reports the name the file actually got when a collision forced a suffix", async function () {
      const renames: string[] = [];
      const attachment = makeAttachment({
        id: 2,
        filename: "paper.pdf",
        linkMode: 1,
        extra: {
          renameAttachmentFile: async (
            newName: string,
            options?: { out?: { titleUpdated?: boolean } },
          ) => {
            renames.push(newName);
            // `unique: true` makes Zotero disambiguate rather than fail.
            attachment.attachmentFilename = "new-1.pdf";
            if (options?.out) options.out.titleUpdated = true;
            return true;
          },
        },
      });
      installZotero();

      const result = await capability().renameAttachment({
        attachmentId: 2,
        newName: "new.pdf",
      });

      assert.deepEqual(renames, ["new.pdf"]);
      assert.equal(result.previousName, "paper.pdf");
      assert.equal(result.newName, "new-1.pdf");
      assert.equal(result.status, "renamed");
      assert.isTrue(result.titleUpdated);
    });

    it("separates a missing file from a name collision", async function () {
      makeAttachment({
        id: 2,
        filename: "paper.pdf",
        linkMode: 1,
        extra: { renameAttachmentFile: async () => false },
      });
      makeAttachment({
        id: 3,
        filename: "paper.pdf",
        linkMode: 1,
        extra: { renameAttachmentFile: async () => -1 },
      });
      installZotero();

      const missing = await capability().renameAttachment({
        attachmentId: 2,
        newName: "new.pdf",
      });
      const collision = await capability().renameAttachment({
        attachmentId: 3,
        newName: "new.pdf",
      });

      assert.equal(missing.status, "no_file");
      assert.equal(collision.status, "error");
      assert.include(collision.reason || "", "already exists");
    });

    it("re-links a stored attachment through Zotero's own method", async function () {
      const relinks: string[] = [];
      const attachment = makeAttachment({
        id: 2,
        // 1 = imported_file: a stored PDF whose file went missing is exactly
        // what "Locate File…" repairs, and it is not a linked file.
        linkMode: 1,
        extra: {
          getFilePathAsync: async () =>
            relinks.length ? relinks[0] : "/old/paper.pdf",
          relinkAttachmentFile: async (path: string) => {
            relinks.push(path);
            return true;
          },
        },
      });
      installZotero();

      const result = await capability().relinkAttachment({
        attachmentId: 2,
        newPath: "/new/paper.pdf",
      });

      assert.deepEqual(relinks, ["/new/paper.pdf"]);
      assert.equal(result.previousPath, "/old/paper.pdf");
      assert.equal(result.newPath, "/new/paper.pdf");
      assert.equal(result.status, "relinked");
      assert.isUndefined(
        (attachment as { attachmentPath?: string }).attachmentPath,
        "the raw path must not be assigned behind Zotero's back",
      );
    });

    it("refuses a linked URL, the one mode Zotero itself rejects", async function () {
      makeAttachment({
        id: 2,
        linkMode: 3,
        extra: { relinkAttachmentFile: async () => true },
      });
      installZotero();

      const result = await capability().relinkAttachment({
        attachmentId: 2,
        newPath: "/new/paper.pdf",
      });

      assert.equal(result.status, "not_linked_file");
      assert.include(result.reason || "", "linked URL");
    });

    it("reports the failure rather than claiming a repair it did not make", async function () {
      makeAttachment({
        id: 2,
        linkMode: 1,
        extra: {
          getFilePathAsync: async () => "/old/paper.pdf",
          relinkAttachmentFile: async () => {
            throw new Error("disk is read-only");
          },
        },
      });
      installZotero();

      const result = await capability().relinkAttachment({
        attachmentId: 2,
        newPath: "/new/paper.pdf",
      });

      assert.equal(result.status, "error");
      assert.equal(result.reason, "disk is read-only");
      assert.equal(result.previousPath, "/old/paper.pdf");
    });
  });

  describe("embedding an image in a note", function () {
    it("returns the key the note HTML has to reference", async function () {
      const imports: Array<{ parentItemID: number }> = [];
      installZotero({
        Attachments: {
          importEmbeddedImage: async (params: { parentItemID: number }) => {
            imports.push(params);
            return { key: "ABCD1234" };
          },
        },
      });

      const result = await capability().importNoteImage({
        noteItemId: 55,
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
      });

      assert.deepEqual(result, { key: "ABCD1234" });
      assert.equal(imports[0].parentItemID, 55);
    });

    it("returns nothing when the build cannot embed images", async function () {
      installZotero({ Attachments: {} });

      const result = await capability().importNoteImage({
        noteItemId: 55,
        bytes: new Uint8Array([1, 2, 3]),
      });

      assert.isNull(result);
    });
  });
});

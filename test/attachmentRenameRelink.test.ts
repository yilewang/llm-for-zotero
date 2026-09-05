import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import { replayLibraryInverse } from "./helpers/replayLibraryInverse";

/**
 * Two attachment defects that reported success while doing nothing, or
 * refused work Zotero itself performs.
 *
 * `renameAttachment` probed `Zotero.Attachments.renameAttachmentFile`, which
 * does not exist — the method is on `Zotero.Item.prototype`. The probe was
 * always false, so every rename fell through to setting the *title* and still
 * returned `status: "renamed"`. The file on disk never moved.
 *
 * `relinkAttachment` refused anything but `linkMode === 2`, so a stored PDF
 * whose file had gone missing — the common repair, and exactly what Zotero's
 * "Locate File…" handles — could not be fixed.
 */
describe("attachment rename and relink", function () {
  type FakeAttachment = {
    id: number;
    attachmentFilename: string;
    attachmentLinkMode: number;
    attachmentPath?: string;
    filePath: string | false;
    title: string;
    renameCalls: Array<{ newName: string; options: unknown }>;
    relinkCalls: string[];
    titleWrites: string[];
    savedTx: number;
    renameOutcome?: boolean | -1 | -2;
    relinkThrows?: string;
    isAttachment: () => boolean;
    getField: (name: string) => string;
    setField: (name: string, value: string) => void;
    saveTx: () => Promise<boolean>;
    getFilePathAsync: () => Promise<string | false>;
    renameAttachmentFile: (
      newName: string,
      options?: {
        unique?: boolean;
        updateTitle?: boolean;
        out?: { noChange?: boolean; titleUpdated?: boolean };
      },
    ) => Promise<boolean | -1 | -2>;
    relinkAttachmentFile: (path: string) => Promise<boolean>;
  };

  function makeAttachment(overrides: Partial<FakeAttachment> = {}) {
    const att: FakeAttachment = {
      id: 55,
      attachmentFilename: "old.pdf",
      // 1 = imported_file (a stored attachment), the usual case.
      attachmentLinkMode: 1,
      filePath: "/Zotero/storage/ABCD/old.pdf",
      title: "old.pdf",
      renameCalls: [],
      relinkCalls: [],
      titleWrites: [],
      savedTx: 0,
      isAttachment: () => true,
      getField: (name: string) => (name === "title" ? att.title : ""),
      setField: (name: string, value: string) => {
        if (name === "title") {
          att.title = value;
          att.titleWrites.push(value);
        }
      },
      saveTx: async () => {
        att.savedTx += 1;
        return true;
      },
      getFilePathAsync: async () => att.filePath,
      renameAttachmentFile: async (newName, options) => {
        att.renameCalls.push({ newName, options });
        const outcome = att.renameOutcome ?? true;
        if (outcome === true) att.attachmentFilename = newName;
        return outcome;
      },
      relinkAttachmentFile: async (path: string) => {
        if (att.relinkThrows) throw new Error(att.relinkThrows);
        att.relinkCalls.push(path);
        att.filePath = path;
        return true;
      },
      ...overrides,
    };
    return att;
  }

  function makeGateway(att: FakeAttachment) {
    const gateway = new ZoteroGateway();
    (gateway as unknown as { getItem: (id: number) => unknown }).getItem = (
      id: number,
    ) => (id === att.id ? att : null);
    return gateway;
  }

  describe("rename", function () {
    it("renames the file on disk instead of quietly retitling", async function () {
      const att = makeAttachment();
      const gateway = makeGateway(att);

      const result = await gateway.renameAttachment({
        attachmentId: 55,
        newName: "new.pdf",
      });

      assert.equal(result.status, "renamed");
      assert.lengthOf(att.renameCalls, 1, "the file rename must actually run");
      assert.equal(att.renameCalls[0].newName, "new.pdf");
      // The old code wrote the title and never touched the file.
      assert.deepEqual(att.titleWrites, []);
    });

    it("reports the real filename when a collision forced a suffix", async function () {
      const att = makeAttachment({
        renameAttachmentFile: async function (this: void, newName, options) {
          att.renameCalls.push({ newName, options });
          // `unique: true` makes Zotero disambiguate rather than fail.
          att.attachmentFilename = "new-1.pdf";
          return true;
        },
      });
      const gateway = makeGateway(att);

      const result = await gateway.renameAttachment({
        attachmentId: 55,
        newName: "new.pdf",
      });

      assert.equal(result.newName, "new-1.pdf");
      assert.equal(
        (att.renameCalls[0].options as { unique?: boolean }).unique,
        true,
      );
    });

    it("says the file is missing rather than claiming a rename", async function () {
      const att = makeAttachment({ renameOutcome: false });
      const gateway = makeGateway(att);

      const result = await gateway.renameAttachment({
        attachmentId: 55,
        newName: "new.pdf",
      });

      assert.equal(result.status, "no_file");
      assert.include(result.reason || "", "missing");
    });

    it("retitles a linked URL, which has no file to rename", async function () {
      const att = makeAttachment({ attachmentLinkMode: 3 });
      const gateway = makeGateway(att);

      const result = await gateway.renameAttachment({
        attachmentId: 55,
        newName: "Reference page",
      });

      assert.equal(result.status, "renamed");
      assert.isTrue(result.titleUpdated);
      assert.deepEqual(att.titleWrites, ["Reference page"]);
      assert.lengthOf(att.renameCalls, 0);
    });

    it("records an undo that renames the file back", async function () {
      const att = makeAttachment();
      const gateway = makeGateway(att);
      const service = new LibraryMutationService(gateway);

      const outcome = await service.executeOperation(
        { type: "rename_attachment", attachmentId: 55, newName: "new.pdf" },
        { request: { conversationKey: 1, libraryID: 1 } } as never,
      );

      assert.exists(outcome.inverse, "renaming recorded no inverse at all");
      assert.deepEqual(outcome.inverse?.inverseOperations, [
        {
          type: "rename_attachment",
          attachmentId: 55,
          newName: "old.pdf",
        },
      ]);
      await replayLibraryInverse(service, outcome);
      assert.equal(att.renameCalls.at(-1)?.newName, "old.pdf");
    });
  });

  describe("relink", function () {
    it("re-links a stored attachment whose file went missing", async function () {
      const att = makeAttachment({ attachmentLinkMode: 1, filePath: false });
      const gateway = makeGateway(att);

      const result = await gateway.relinkAttachment({
        attachmentId: 55,
        newPath: "/Users/me/Papers/found.pdf",
      });

      // The old code refused this outright with "Only linked-file
      // attachments can be re-linked".
      assert.equal(result.status, "relinked");
      assert.deepEqual(att.relinkCalls, ["/Users/me/Papers/found.pdf"]);
    });

    it("delegates to Zotero rather than assigning the path directly", async function () {
      const att = makeAttachment({ attachmentLinkMode: 2 });
      const gateway = makeGateway(att);

      await gateway.relinkAttachment({
        attachmentId: 55,
        newPath: "/Users/me/Papers/moved.pdf",
      });

      // Direct assignment skips filename sanitisation, the copy-into-storage
      // step, the cached file-state refresh and the notifier event.
      assert.deepEqual(att.relinkCalls, ["/Users/me/Papers/moved.pdf"]);
      assert.isUndefined(att.attachmentPath);
    });

    it("still refuses a linked URL, which is what Zotero refuses", async function () {
      const att = makeAttachment({ attachmentLinkMode: 3 });
      const gateway = makeGateway(att);

      const result = await gateway.relinkAttachment({
        attachmentId: 55,
        newPath: "/Users/me/Papers/x.pdf",
      });

      assert.equal(result.status, "not_linked_file");
      assert.lengthOf(att.relinkCalls, 0);
    });

    it("records an undo only when there was a file to go back to", async function () {
      const withFile = makeAttachment();
      const service = new LibraryMutationService(makeGateway(withFile));
      const outcome = await service.executeOperation(
        {
          type: "relink_attachment",
          attachmentId: 55,
          newPath: "/new/path.pdf",
        },
        { request: { conversationKey: 1, libraryID: 1 } } as never,
      );
      assert.exists(outcome.inverse);
      assert.deepEqual(outcome.inverse?.inverseOperations, [
        {
          type: "relink_attachment",
          attachmentId: 55,
          newPath: "/Zotero/storage/ABCD/old.pdf",
        },
      ]);
      await replayLibraryInverse(service, outcome);
      assert.equal(withFile.relinkCalls.at(-1), "/Zotero/storage/ABCD/old.pdf");

      const missing = makeAttachment({ filePath: false });
      const service2 = new LibraryMutationService(makeGateway(missing));
      const outcome2 = await service2.executeOperation(
        {
          type: "relink_attachment",
          attachmentId: 55,
          newPath: "/new/path.pdf",
        },
        { request: { conversationKey: 1, libraryID: 1 } } as never,
      );
      assert.notExists(outcome2.inverse, "nothing to restore, so no inverse");
    });
  });
});

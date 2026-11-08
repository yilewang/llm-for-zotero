import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import { revertActions } from "../src/agent/services/changeReverter";
import { formatReceiptStatus } from "../src/agent/contracts/actionEvaluation";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import type { AgentToolContext, AgentToolResult } from "../src/agent/types";

declare const Zotero: any;
declare const IOUtils: any;
declare const PathUtils: any;
declare const Services: any;
declare const Components: any;

/**
 * W5-C against real Zotero: attach a local file (stored copy and link) and a
 * web page (link and snapshot) to an item, Find Available PDF with a file and
 * with none, an underline and a sticky note at a quoted passage, an edit of an
 * annotation's comment and color, and deleting an annotation, each with its
 * undo. Every check reads Zotero's own tables, not the tool's result.
 *
 * No test reaches the internet. The web page comes from a socket server on
 * 127.0.0.1 that this file starts. Find Available PDF runs Zotero's own
 * command with its own resolvers; only the download at the end of it,
 * `Zotero.Attachments.downloadFirstAvailableFile`, is replaced, because the
 * test library holds no paper with an open-access PDF and the resolvers
 * would ask doi.org and Unpaywall.
 */
describe("workflow: attachments and annotations (W5-C)", function () {
  this.timeout(120000);

  const SUFFIX = `w5c${Date.now()}`;
  const created: number[] = [];
  const files: string[] = [];
  const LINK_MODE = {
    importedFile: 0,
    importedUrl: 1,
    linkedFile: 2,
    linkedUrl: 3,
  };
  let pdfBytes: Uint8Array;

  function libraryID(): number {
    return Zotero.Libraries.userLibraryID;
  }

  function contextFor(
    conversationKey: number,
    userText: string,
  ): AgentToolContext {
    return {
      request: resolvedAgentRequest({
        conversationKey,
        mode: "agent",
        userText,
        libraryID: libraryID(),
        executionContext: {
          version: 1,
          executionId: `w5c:${SUFFIX}:${conversationKey}:${Math.random()}`,
          conversationKey,
          conversationGeneration: 0,
          chatLibraryID: libraryID(),
          permissionOwner: "original_agent",
          workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
          configuredAccess: {
            libraryIDs: [libraryID()],
            outputDirectories: [],
          },
        },
      }),
      item: null,
      modelName: "workflow",
      currentAnswerText: "",
      runId: `w5c-run:${SUFFIX}:${conversationKey}:${Math.random()}`,
    } as AgentToolContext;
  }

  async function withRegistry<T>(
    mode: "safe" | "yolo",
    body: (registry: AgentToolRegistry) => Promise<T>,
  ): Promise<T> {
    const originalMode = getOriginalAgentPermissionMode();
    try {
      await initAgentChangeJournal();
      setOriginalAgentPermissionMode(mode);
      const registry = new AgentToolRegistry(
        new ActionContractService(new ZoteroGateway()),
      );
      for (const name of ["library_update", "library_delete", "annotate_pdf"])
        registry.register(
          Zotero.LLMForZotero.api.agent.getToolDefinition(name),
        );
      return await body(registry);
    } finally {
      setOriginalAgentPermissionMode(originalMode);
    }
  }

  async function runTool(
    name: string,
    args: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<AgentToolResult> {
    return withRegistry("yolo", async (registry) => {
      const prepared = await registry.prepareExecution(
        { id: `${name}:${Math.random()}`, name, arguments: args },
        context,
        { callerKind: "model" },
      );
      assert.equal(prepared.kind, "result");
      if (prepared.kind !== "result") throw new Error("unreachable");
      return prepared.execution.result;
    });
  }

  /** Undo every action this context's run recorded. */
  async function undoRun(context: AgentToolContext) {
    const actions = await listJournalActions({ runId: context.runId });
    assert.isAtLeast(actions.length, 1, "the write recorded an action");
    const undone = await revertActions({
      actions,
      zoteroGateway: new ZoteroGateway(),
      context,
    });
    assert.equal(undone.reverted, actions.length, JSON.stringify(undone));
    return undone;
  }

  function innerResult(result: AgentToolResult): any {
    const content = result.content as any;
    return content?.result?.result ?? content?.result ?? content;
  }

  async function makePaper(title: string, fields: Record<string, string> = {}) {
    const paper = new Zotero.Item("journalArticle");
    paper.libraryID = libraryID();
    paper.setField("title", `${title} ${SUFFIX}`);
    for (const [field, value] of Object.entries(fields))
      paper.setField(field, value);
    await paper.saveTx();
    created.push(paper.id);
    return paper;
  }

  async function writePdf(name: string): Promise<string> {
    const path = PathUtils.join(
      Zotero.getTempDirectory().path,
      `${name}-${SUFFIX}.pdf`,
    );
    await IOUtils.write(path, pdfBytes);
    files.push(path);
    return path;
  }

  /** The attachment rows under `parentItemID`, as Zotero's tables hold them. */
  async function childAttachments(parentItemID: number) {
    const rows = await Zotero.DB.queryAsync(
      `SELECT IA.itemID AS itemID, IA.linkMode AS linkMode,
              IA.contentType AS contentType, IA.path AS path,
              I.key AS key,
              (SELECT V.value FROM itemData D
                 JOIN itemDataValues V USING (valueID)
                 JOIN fields F USING (fieldID)
                WHERE D.itemID = IA.itemID AND F.fieldName = 'url') AS url,
              EXISTS (SELECT 1 FROM deletedItems DI
                       WHERE DI.itemID = IA.itemID) AS trashed
         FROM itemAttachments IA JOIN items I USING (itemID)
        WHERE IA.parentItemID = ?
        ORDER BY IA.itemID`,
      [parentItemID],
    );
    return rows.map((row: any) => ({
      itemID: Number(row.itemID),
      linkMode: Number(row.linkMode),
      contentType: String(row.contentType || ""),
      path: String(row.path || ""),
      key: String(row.key),
      url: row.url === null ? null : String(row.url),
      trashed: Boolean(row.trashed),
    }));
  }

  /** The stored file of a stored attachment, read from Zotero's data folder. */
  function storagePath(key: string, path: string): string {
    return PathUtils.join(
      Zotero.DataDirectory.dir,
      "storage",
      key,
      path.replace(/^storage:/, ""),
    );
  }

  async function annotationRow(itemID: number) {
    const rows = await Zotero.DB.queryAsync(
      `SELECT parentItemID, type, text, comment, color, pageLabel, sortIndex,
              position,
              EXISTS (SELECT 1 FROM deletedItems DI
                       WHERE DI.itemID = A.itemID) AS trashed
         FROM itemAnnotations A WHERE itemID = ?`,
      [itemID],
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      parentItemID: Number(row.parentItemID),
      type: Number(row.type),
      text: row.text === null ? null : String(row.text),
      comment: row.comment === null ? null : String(row.comment),
      color: String(row.color),
      pageLabel: row.pageLabel === null ? null : String(row.pageLabel),
      sortIndex: String(row.sortIndex),
      position: JSON.parse(String(row.position)),
      trashed: Boolean(row.trashed),
    };
  }

  /**
   * A plain HTTP server on 127.0.0.1, so the snapshot never leaves the
   * machine. It answers GET and HEAD for the pages it was given.
   */
  function startPageServer(
    pages: Record<string, { type: string; body: string }>,
  ) {
    const Cc = Components.classes;
    const Ci = Components.interfaces;
    const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(
      Ci.nsIServerSocket,
    );
    server.init(-1, true, -1);
    const requests: string[] = [];
    server.asyncListen({
      onSocketAccepted(_socket: unknown, transport: any) {
        const input = transport
          .openInputStream(0, 0, 0)
          .QueryInterface(Ci.nsIAsyncInputStream);
        let raw = "";
        const reader = {
          onInputStreamReady(stream: any) {
            let available = 0;
            try {
              available = stream.available();
            } catch {
              return;
            }
            const scriptable = Cc[
              "@mozilla.org/scriptableinputstream;1"
            ].createInstance(Ci.nsIScriptableInputStream);
            scriptable.init(stream);
            raw += scriptable.read(available);
            if (!raw.includes("\r\n\r\n")) {
              stream.asyncWait(reader, 0, 0, Services.tm.mainThread);
              return;
            }
            const [method, target] = raw.split(" ");
            requests.push(`${method} ${target}`);
            const page = pages[String(target).split("?")[0]];
            const head = page
              ? `HTTP/1.1 200 OK\r\nContent-Type: ${page.type}\r\nContent-Length: ${page.body.length}\r\nConnection: close\r\n\r\n`
              : "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            const text = head + (page && method !== "HEAD" ? page.body : "");
            const output = transport.openOutputStream(
              Ci.nsITransport.OPEN_BLOCKING,
              0,
              0,
            );
            output.write(text, text.length);
            output.close();
            input.close();
          },
        };
        input.asyncWait(reader, 0, 0, Services.tm.mainThread);
      },
      onStopListening() {},
    });
    return {
      url: (path: string) => `http://127.0.0.1:${server.port}${path}`,
      requests,
      close: () => server.close(),
    };
  }

  before(async function () {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    [
      "Grid cells tile space with a hexagonal lattice",
      "that persists in darkness.",
    ].forEach((line, i) =>
      page.drawText(line, { x: 72, y: 600 - 18 * i, size: 10, font }),
    );
    pdfBytes = await pdf.save();
  });

  after(async function () {
    for (const id of [...created].reverse()) {
      try {
        const reader = Zotero.Reader._readers.find(
          (entry: any) => entry.itemID === id,
        );
        if (reader) await reader.close();
        const item = Zotero.Items.get(id);
        if (item) await item.eraseTx();
      } catch {
        /* best effort */
      }
    }
    for (const path of files)
      await IOUtils.remove(path, { ignoreAbsent: true });
  });

  describe("attaching to an item", function () {
    it("attaches a local file as a stored copy and as a link, and undo trashes each", async function () {
      const paper = await makePaper("Attach file");
      const path = await writePdf("attach-file");
      const stored = contextFor(paper.id, "Attach this PDF");
      const copy = await runTool(
        "library_update",
        {
          kind: "attachment",
          action: "attach_file",
          itemId: paper.id,
          filePath: path,
        },
        stored,
      );
      assert.isTrue(copy.ok, JSON.stringify(copy.content));
      assert.equal(copy.actionReceipts?.[0]?.operation, "attach_file");
      assert.equal(copy.actionReceipts?.[0]?.verification, "verified");
      const linked = contextFor(paper.id, "Link this PDF");
      const link = await runTool(
        "library_update",
        {
          kind: "attachment",
          action: "attach_file",
          itemId: paper.id,
          filePath: path,
          link: true,
        },
        linked,
      );
      assert.isTrue(link.ok, JSON.stringify(link.content));
      assert.equal(link.actionReceipts?.[0]?.verification, "verified");

      const rows = await childAttachments(paper.id);
      assert.lengthOf(rows, 2);
      created.push(...rows.map((row: { itemID: number }) => row.itemID));
      const [storedRow, linkRow] = rows;
      assert.equal(storedRow.linkMode, LINK_MODE.importedFile);
      assert.equal(storedRow.contentType, "application/pdf");
      assert.match(storedRow.path, /^storage:/);
      assert.isTrue(
        await IOUtils.exists(storagePath(storedRow.key, storedRow.path)),
        "the copy is in Zotero's storage folder",
      );
      assert.equal(linkRow.linkMode, LINK_MODE.linkedFile);
      assert.equal(linkRow.path, path, "the link points at the file itself");
      assert.deepEqual(innerResult(copy).attachmentIds, [storedRow.itemID]);

      // A repeat finds each attachment already there and adds nothing.
      for (const extra of [{}, { link: true }]) {
        const again = await runTool(
          "library_update",
          {
            kind: "attachment",
            action: "attach_file",
            itemId: paper.id,
            filePath: path,
            ...extra,
          },
          contextFor(paper.id, "Attach it again"),
        );
        assert.isTrue(again.ok, JSON.stringify(again.content));
        assert.equal(again.effect, "none");
        assert.equal(innerResult(again).status, "already_attached");
        assert.equal(again.actionReceipts?.[0]?.status, "already_satisfied");
        assert.equal(again.actionReceipts?.[0]?.verification, "verified");
      }
      assert.deepEqual(
        await childAttachments(paper.id),
        rows,
        "a repeat adds nothing",
      );

      await undoRun(stored);
      await undoRun(linked);
      const after = await childAttachments(paper.id);
      assert.deepEqual(
        after.map((row: { trashed: boolean }) => row.trashed),
        [true, true],
        "undo trashed both attachments",
      );
      assert.isTrue(await IOUtils.exists(path), "the linked file is untouched");
    });

    it("asks first in safe mode, then saves a web page as a link and a snapshot, and undo trashes both", async function () {
      const paper = await makePaper("Attach web page");
      const marker = `Snapshot marker ${SUFFIX}`;
      const server = startPageServer({
        "/page.html": {
          type: "text/html; charset=utf-8",
          body: `<!doctype html><html><head><title>W5-C page</title></head><body><p>${marker}</p></body></html>`,
        },
      });
      const attachments = Zotero.Attachments;
      const importFromDocument = attachments.importFromDocument;
      const documentImports: Array<{ browser: boolean; document: boolean }> =
        [];
      attachments.importFromDocument = function (options: any) {
        documentImports.push({
          browser: Boolean(options?.browser),
          document: Boolean(options?.document),
        });
        return importFromDocument.call(this, options);
      };
      const url = server.url("/page.html");
      const context = contextFor(paper.id, "Save this page to the paper");
      let result: AgentToolResult;
      try {
        result = await withRegistry("safe", async (registry) => {
          const execution = await registry.prepareExecution(
            {
              id: "attach-url",
              name: "library_update",
              arguments: {
                kind: "attachment",
                action: "attach_url",
                itemId: paper.id,
                url,
              },
            },
            context,
            { callerKind: "model" },
          );
          assert.equal(execution.kind, "confirmation", "safe mode asks first");
          if (execution.kind !== "confirmation") throw new Error("unreachable");
          const fields = JSON.stringify(execution.action.fields);
          assert.include(fields, url, "the card names the address");
          assert.lengthOf(
            await childAttachments(paper.id),
            0,
            "asking wrote nothing",
          );
          const applied = await execution.execute({ approved: true });
          if (applied.kind !== "result") throw new Error("unreachable");
          return applied.execution.result;
        });
      } finally {
        attachments.importFromDocument = importFromDocument;
        server.close();
      }
      assert.isTrue(result.ok, JSON.stringify(result.content));
      assert.equal(result.actionReceipts?.[0]?.operation, "attach_url");
      assert.equal(result.actionReceipts?.[0]?.verification, "verified");

      const rows = await childAttachments(paper.id);
      created.push(...rows.map((row: { itemID: number }) => row.itemID));
      assert.lengthOf(rows, 2, JSON.stringify(rows));
      const link = rows.find(
        (row: { linkMode: number }) => row.linkMode === LINK_MODE.linkedUrl,
      );
      const snapshot = rows.find(
        (row: { linkMode: number }) => row.linkMode === LINK_MODE.importedUrl,
      );
      assert.exists(link, "a link to the address");
      assert.exists(snapshot, "a stored snapshot");
      assert.equal(link.url, url);
      assert.equal(snapshot.contentType, "text/html");
      const html = await IOUtils.readUTF8(
        storagePath(snapshot.key, snapshot.path),
      );
      assert.include(html, marker, "the snapshot holds the page");
      // importFromURL took the text/html path: a hidden browser loaded the
      // page and importFromDocument stored Zotero's snapshot of it.
      assert.deepEqual(documentImports, [{ browser: true, document: false }]);
      Zotero.debug(
        `[w5c] importFromURL path: hidden browser -> importFromDocument; SingleFile mark ${/SingleFile/i.test(html)}; requests ${server.requests.join(", ")}`,
      );
      assert.sameMembers(
        innerResult(result).attachmentIds,
        rows.map((row: { itemID: number }) => row.itemID),
        "the result names both attachments, as the card would",
      );

      await undoRun(context);
      assert.deepEqual(
        (await childAttachments(paper.id)).map(
          (row: { trashed: boolean }) => row.trashed,
        ),
        [true, true],
      );
    });
  });

  describe("retrying a web page attach", function () {
    it("after a crash left only the snapshot, a retry adds only the link, a repeat adds nothing, and another address is attached normally", async function () {
      const paper = await makePaper("Attach web page retry");
      const page = (title: string) => ({
        type: "text/html; charset=utf-8",
        body: `<!doctype html><html><head><title>${title}</title></head><body><p>${title} ${SUFFIX}</p></body></html>`,
      });
      const server = startPageServer({
        "/retry.html": page("Retried page"),
        "/other.html": page("Other page"),
      });
      try {
        const url = server.url("/retry.html");
        // What a crash between the snapshot and the link leaves: Zotero's own
        // snapshot of the page, with no link and no journal step.
        const residue = await Zotero.Attachments.importFromURL({
          libraryID: libraryID(),
          url,
          parentItemID: paper.id,
        });
        created.push(residue.id);
        const retry = contextFor(paper.id, "Save this page to the paper");
        const result = await runTool(
          "library_update",
          { kind: "attachment", action: "attach_url", itemId: paper.id, url },
          retry,
        );
        assert.isTrue(result.ok, JSON.stringify(result.content));
        assert.equal(result.effect, "applied");
        assert.equal(result.actionReceipts?.[0]?.verification, "verified");
        assert.deepEqual(innerResult(result).reusedAttachmentIds, [residue.id]);
        const rows = await childAttachments(paper.id);
        created.push(...rows.map((row: { itemID: number }) => row.itemID));
        assert.deepEqual(
          rows.map((row: { linkMode: number }) => row.linkMode),
          [LINK_MODE.importedUrl, LINK_MODE.linkedUrl],
          "the snapshot it had, and only a new link",
        );
        assert.equal(rows[0].itemID, residue.id);
        assert.equal(rows[1].url, url);

        const repeat = await runTool(
          "library_update",
          { kind: "attachment", action: "attach_url", itemId: paper.id, url },
          contextFor(paper.id, "Save it again"),
        );
        assert.isTrue(repeat.ok, JSON.stringify(repeat.content));
        assert.equal(repeat.effect, "none");
        assert.equal(innerResult(repeat).status, "already_attached");
        assert.equal(repeat.actionReceipts?.[0]?.status, "already_satisfied");
        assert.deepEqual(await childAttachments(paper.id), rows);

        const other = server.url("/other.html");
        const second = await runTool(
          "library_update",
          {
            kind: "attachment",
            action: "attach_url",
            itemId: paper.id,
            url: other,
          },
          contextFor(paper.id, "Save the other page"),
        );
        assert.isTrue(second.ok, JSON.stringify(second.content));
        const after = await childAttachments(paper.id);
        created.push(...after.map((row: { itemID: number }) => row.itemID));
        assert.lengthOf(after, 4);
        assert.sameMembers(
          after
            .filter((row: { url: string | null }) => row.url === other)
            .map((row: { linkMode: number }) => row.linkMode),
          [LINK_MODE.importedUrl, LINK_MODE.linkedUrl],
        );

        // The retry's undo trashes the link it made, not the snapshot it
        // found.
        await undoRun(retry);
        const undone = await childAttachments(paper.id);
        assert.isFalse(
          undone.find((row: { itemID: number }) => row.itemID === residue.id)
            .trashed,
        );
        assert.isTrue(
          undone.find(
            (row: { itemID: number }) => row.itemID === rows[1].itemID,
          ).trashed,
        );
      } finally {
        server.close();
      }
    });
  });

  describe("Find Available PDF", function () {
    let download: unknown;
    let calls: unknown[][];

    beforeEach(function () {
      download = Zotero.Attachments.downloadFirstAvailableFile;
      calls = [];
    });
    afterEach(function () {
      Zotero.Attachments.downloadFirstAvailableFile = download;
    });

    /** Replace only the network download at the end of Zotero's command. */
    function stubDownload(found: boolean) {
      Zotero.Attachments.downloadFirstAvailableFile = async (
        resolvers: unknown[],
        path: string,
      ) => {
        calls.push(resolvers);
        if (!found) return false;
        await IOUtils.write(path, pdfBytes);
        return {
          url: "https://example.org/w5c-open-access.pdf",
          mimeType: "application/pdf",
          props: { accessMethod: "oa" },
        };
      };
    }

    it("attaches the file Zotero's resolvers found, and undo trashes it", async function () {
      const paper = await makePaper("Find PDF", { DOI: "10.5555/w5c.found" });
      stubDownload(true);
      const context = contextFor(paper.id, "Find the PDF");
      const result = await runTool(
        "library_update",
        { kind: "attachment", action: "find_pdf", itemId: paper.id },
        context,
      );
      assert.isTrue(result.ok, JSON.stringify(result.content));
      assert.equal(result.effect, "applied");
      assert.lengthOf(calls, 1);
      // Zotero's own resolvers, built from the item: the DOI page first.
      assert.deepInclude(calls[0] as unknown[], {
        pageURL: "https://doi.org/10.5555/w5c.found",
        accessMethod: "doi",
      });
      const rows = await childAttachments(paper.id);
      created.push(...rows.map((row: { itemID: number }) => row.itemID));
      assert.lengthOf(rows, 1);
      assert.equal(rows[0].contentType, "application/pdf");
      assert.equal(rows[0].linkMode, LINK_MODE.importedUrl);
      assert.equal(rows[0].url, "https://example.org/w5c-open-access.pdf");
      assert.isTrue(
        await IOUtils.exists(storagePath(rows[0].key, rows[0].path)),
      );
      assert.equal(result.actionReceipts?.[0]?.verification, "verified");
      assert.equal(result.actionReceipts?.[0]?.status, "applied");
      assert.deepEqual(innerResult(result).attachmentIds, [rows[0].itemID]);

      await undoRun(context);
      assert.isTrue((await childAttachments(paper.id))[0].trashed);
    });

    it("reports found nothing as no effect and no failure, and changes nothing", async function () {
      const searched = await makePaper("Find nothing", {
        DOI: "10.5555/w5c.none",
      });
      const bare = await makePaper("No identifiers");
      stubDownload(false);
      for (const [paper, searchRan] of [
        [searched, true],
        [bare, false],
      ] as const) {
        const before = await childAttachments(paper.id);
        calls = [];
        const result = await runTool(
          "library_update",
          { kind: "attachment", action: "find_pdf", itemId: paper.id },
          contextFor(paper.id, "Find the PDF"),
        );
        assert.isTrue(result.ok, JSON.stringify(result.content));
        assert.equal(result.effect, "none");
        const inner = innerResult(result);
        assert.equal(inner.status, "not_found");
        assert.isString(inner.reason);
        assert.lengthOf(calls, searchRan ? 1 : 0);
        assert.deepEqual(await childAttachments(paper.id), before);
        const [receipt] = result.actionReceipts || [];
        assert.equal(
          receipt?.verification,
          "verified",
          JSON.stringify(receipt),
        );
        // An answer, not work already done: observed, with the reason, and
        // the item excepted rather than counted as done.
        assert.equal(receipt?.status, "observed", JSON.stringify(receipt));
        assert.match(receipt!.reasons[0], /^No change: /);
        assert.include(receipt!.reasons[0], inner.reason);
        assert.deepEqual(receipt?.rejectedTargets, [`item:${paper.id}`]);
        assert.deepEqual(receipt?.alreadySatisfiedTargets, []);
        const line = formatReceiptStatus(result.actionReceipts || []);
        assert.include(line, "find_pdf — observed 0/1;");
        assert.include(line, `No change: ${inner.reason}`);
      }
    });
  });

  describe("annotations", function () {
    const passage =
      "Grid cells tile space with a hexagonal lattice that persists in darkness.";
    let attachment: any;
    let paper: any;

    before(async function () {
      paper = await makePaper("Annotation types");
      attachment = await Zotero.Attachments.importFromFile({
        file: await writePdf("annotations"),
        parentItemID: paper.id,
      });
      created.push(attachment.id);
    });

    async function annotate(
      args: Record<string, unknown>,
      context: AgentToolContext,
    ) {
      const result = await runTool(
        "annotate_pdf",
        { attachmentId: attachment.id, text: passage, ...args },
        context,
      );
      assert.isTrue(result.ok, JSON.stringify(result.content));
      assert.equal(result.actionReceipts?.[0]?.verification, "verified");
      return Number((result.content as any).annotationId);
    }

    it("puts an underline over the passage's lines and a sticky note at its first line", async function () {
      const highlightId = await annotate(
        { color: "yellow" },
        contextFor(paper.id, "Highlight it"),
      );
      const underlineId = await annotate(
        { annotationType: "underline", color: "blue" },
        contextFor(paper.id, "Underline it"),
      );
      const noteId = await annotate(
        { annotationType: "note", comment: "Check in the dark." },
        contextFor(paper.id, "Put a note there"),
      );
      const highlight = (await annotationRow(highlightId))!;
      const underline = (await annotationRow(underlineId))!;
      const note = (await annotationRow(noteId))!;
      const types = Zotero.Annotations;
      assert.equal(highlight.type, types.ANNOTATION_TYPE_HIGHLIGHT);
      assert.equal(underline.type, types.ANNOTATION_TYPE_UNDERLINE);
      assert.equal(note.type, types.ANNOTATION_TYPE_NOTE);
      for (const row of [underline, note]) {
        assert.equal(row.parentItemID, attachment.id);
        assert.equal(row.position.pageIndex, 0);
      }
      assert.equal(underline.text, passage);
      assert.equal(underline.color, "#2ea8e5");
      assert.deepEqual(
        underline.position.rects,
        highlight.position.rects,
        "an underline covers the same lines as a highlight",
      );
      assert.lengthOf(underline.position.rects, 2);
      const [x, y] = highlight.position.rects[0];
      assert.deepEqual(note.position.rects, [[x, y, x + 22, y + 22]]);
      assert.isNull(note.text, "a sticky note has no text");
      assert.equal(note.comment, "Check in the dark.");
      // A retry finds each one again instead of adding another.
      const again = await runTool(
        "annotate_pdf",
        {
          attachmentId: attachment.id,
          text: passage,
          annotationType: "note",
          comment: "Check in the dark.",
        },
        contextFor(paper.id, "Put a note there"),
      );
      assert.equal((again.content as any).annotationId, noteId);
      assert.equal((again.content as any).status, "already_exists");
    });

    it("edits an annotation's comment and color, and undo puts both back", async function () {
      const annotationId = await annotate(
        { annotationType: "underline", comment: "First reading", color: "red" },
        contextFor(paper.id, "Underline the claim"),
      );
      const before = (await annotationRow(annotationId))!;
      assert.equal(before.color, "#ff6666");
      const context = contextFor(
        paper.id,
        "Change the comment and make it green",
      );
      const result = await runTool(
        "library_update",
        {
          kind: "annotation",
          annotationId,
          comment: "Second reading",
          color: "green",
        },
        context,
      );
      assert.isTrue(result.ok, JSON.stringify(result.content));
      assert.equal(result.actionReceipts?.[0]?.operation, "update_annotation");
      assert.equal(result.actionReceipts?.[0]?.verification, "verified");
      assert.deepInclude(innerResult(result), {
        previous: { comment: "First reading", color: "#ff6666" },
        comment: "Second reading",
        color: "#5fb236",
      });
      const edited = (await annotationRow(annotationId))!;
      assert.equal(edited.comment, "Second reading");
      assert.equal(edited.color, "#5fb236");
      assert.deepEqual(edited.position, before.position, "nothing else moved");
      assert.equal(edited.text, before.text);

      await undoRun(context);
      assert.deepEqual(await annotationRow(annotationId), before);
    });

    it("deletes an annotation through library_delete, and undo restores it", async function () {
      const annotationId = await annotate(
        { annotationType: "note", comment: "Delete me later" },
        contextFor(paper.id, "Add a note"),
      );
      const before = (await annotationRow(annotationId))!;
      assert.isFalse(before.trashed);
      const context = contextFor(paper.id, "Delete that note");
      const result = await runTool(
        "library_delete",
        { mode: "trash", itemIds: [annotationId] },
        context,
      );
      assert.isTrue(result.ok, JSON.stringify(result.content));
      assert.equal(result.actionReceipts?.[0]?.verification, "verified");
      assert.isTrue((await annotationRow(annotationId))!.trashed);
      assert.notInclude(
        Zotero.Items.get(attachment.id).getAnnotations(false, true),
        annotationId,
        "Zotero no longer lists it on the PDF",
      );

      await undoRun(context);
      assert.deepEqual(await annotationRow(annotationId), before);
      assert.include(
        Zotero.Items.get(attachment.id).getAnnotations(false, true),
        annotationId,
      );
    });
  });
});

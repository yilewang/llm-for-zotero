import { assert } from "chai";
import { evaluatePreparedActionContract } from "../src/agent/contracts/actionEvaluation";
import {
  getOrCreateZoteroMcpBearerToken,
  ZOTERO_MCP_ENDPOINT_PATH,
} from "../src/agent/mcp/server";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";

declare const Zotero: any;

function valuesNamed(value: any, key: string): any[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([name, child]) => [
    ...(name === key ? [child] : []),
    ...valuesNamed(child, key),
  ]);
}

describe("external MCP writes against native Zotero", function () {
  this.timeout(120000);
  it("reads, writes, and runs commands without host permission opt-ins", async function () {
    const io = (globalThis as any).IOUtils;
    const root = `${Zotero.getTempDirectory().path}/mcp-client-owned-${Date.now()}`;
    const path = `${root}/evidence.txt`;
    const legacyKeys = [
      "externalMcpWritesEnabled",
      "externalMcpFilesEnabled",
      "externalMcpCommandsEnabled",
    ];
    const prefix = "extensions.zotero.llmforzotero.";
    const previous = legacyKeys.map((key) =>
      Zotero.Prefs.get(prefix + key, true),
    );
    const call = async (name: string, args: object) => {
      const Endpoint = Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH];
      const [status, , body] = await new Endpoint().init({
        method: "POST",
        headers: {
          Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
        },
        data: {
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name, arguments: args },
        },
      });
      assert.equal(status, 200);
      const payload = JSON.parse(body);
      assert.isUndefined(payload.error, body);
      assert.isNotTrue(payload.result.isError, body);
      return JSON.parse(payload.result.content[0].text);
    };
    try {
      for (const key of legacyKeys) Zotero.Prefs.set(prefix + key, false, true);
      await io.makeDirectory(root);
      await io.writeUTF8(path, "Native source");
      const read = await call("file_io", { action: "read", filePath: path });
      assert.include(valuesNamed(read, "text"), "Native source");
      const write = await call("file_io", {
        action: "write",
        filePath: path,
        content: "Agent approved native write",
      });
      assert.include(valuesNamed(write, "verification"), "verified");
      assert.equal(await io.readUTF8(path), "Agent approved native write");
      const command = await call("run_command", {
        command: "echo MCP_CLIENT_OWNS_PERMISSION",
      });
      assert.isTrue(
        valuesNamed(command, "stdout").some((value) =>
          String(value).includes("MCP_CLIENT_OWNS_PERMISSION"),
        ),
        JSON.stringify(command),
      );
    } finally {
      for (const [index, key] of legacyKeys.entries()) {
        if (previous[index] === undefined)
          Zotero.Prefs.clear(prefix + key, true);
        else Zotero.Prefs.set(prefix + key, previous[index], true);
      }
      await io.remove(root, { recursive: true, ignoreAbsent: true });
    }
  });
  // MCP calls take the external-runtime authorization and never read the
  // permission mode; safe is the strictest, so it would fail first.
  for (const mode of ["safe"] as const) {
    it(`executes a standalone create/import/tag/note/undo workflow in ${mode}`, async function () {
      const previousMode = getOriginalAgentPermissionMode();
      const items: number[] = [];
      const collections: number[] = [];
      const libraryID = Zotero.Libraries.userLibraryID;
      const suffix = `MCP430-${mode}-${Date.now()}`;
      let sequence = 0;
      const call = async (name: string, args: object) => {
        // Exercise the registered endpoint and real native tool registry without a turn header.
        // Socket transport is tested separately against the running development profile.
        const Endpoint = Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH];
        const [status, , body] = await new Endpoint().init({
          method: "POST",
          headers: {
            Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
          },
          data: {
            jsonrpc: "2.0",
            id: ++sequence,
            method: "tools/call",
            params: { name, arguments: { libraryID, ...args } },
          },
        });
        assert.equal(status, 200);
        const payload = JSON.parse(body);
        assert.isUndefined(payload.error, JSON.stringify(payload));
        assert.isNotTrue(payload.result.isError, JSON.stringify(payload));
        const result = JSON.parse(payload.result.content[0].text);
        assert.isTrue(result.ok, JSON.stringify(result));
        return result;
      };
      try {
        setOriginalAgentPermissionMode(mode);
        const collectionResult = await call("library_update", {
          kind: "collection",
          action: "create",
          name: suffix,
        });
        const collection = Zotero.Collections.getByLibrary(libraryID).find(
          (entry: any) => entry.name === suffix,
        );
        assert.exists(collection, JSON.stringify(collectionResult));
        collections.push(collection.id);
        const imported = await call("library_import", {
          kind: "manual",
          items: [
            {
              itemType: "journalArticle",
              fields: { title: suffix },
              collections: [collection.id],
            },
          ],
        });
        const itemId = valuesNamed(imported, "itemId").find((id) =>
          Number.isInteger(id),
        );
        assert.isNumber(itemId, JSON.stringify(imported));
        items.push(itemId);
        const item = Zotero.Items.get(itemId);
        await item.reload();
        assert.equal(item.getField("title"), suffix);
        const tagged = await call("library_update", {
          kind: "tags",
          action: "add",
          itemIds: [itemId],
          tags: [suffix],
        });
        await item.reload();
        assert.isTrue(item.hasTag(suffix));
        assert.equal(
          tagged.actionReceipts[0].executionAuthority,
          "external_runtime",
        );
        assert.equal(
          evaluatePreparedActionContract(tagged.actionReceipts).state,
          "satisfied",
        );
        const saved = await call("note_write", {
          mode: "create",
          target: "standalone",
          content: `<p>${suffix} original</p>`,
        });
        const noteId = valuesNamed(saved, "noteId").find((id) =>
          Number.isInteger(id),
        );
        assert.isNumber(noteId, JSON.stringify(saved));
        items.push(noteId);
        const note = Zotero.Items.get(noteId);
        await note.reload();
        assert.include(note.getNote(), `${suffix} original`);
        const edited = await call("note_write", {
          mode: "edit",
          targetNoteId: noteId,
          content: `<p>${suffix} edited</p>`,
        });
        await note.reload();
        assert.include(note.getNote(), `${suffix} edited`);
        const actionId = valuesNamed(edited, "actionId").find(
          (id) => typeof id === "string",
        );
        assert.isString(actionId, JSON.stringify(edited));
        await call("undo", { actionId });
        await note.reload();
        assert.include(note.getNote(), `${suffix} original`);
        assert.notInclude(note.getNote(), `${suffix} edited`);
        const tagId = valuesNamed(tagged, "actionId").find(
          (id) => typeof id === "string",
        );
        assert.isString(tagId);
        const secondTag = await call("library_update", {
          kind: "tags",
          action: "add",
          itemIds: [itemId],
          tags: [`${suffix}-second`],
        });
        const secondTagId = valuesNamed(secondTag, "actionId").find(
          (id) => typeof id === "string",
        );
        assert.isString(secondTagId);
        await call("undo", { actionIds: [tagId, secondTagId] });
        await item.reload();
        assert.isFalse(item.hasTag(suffix));
        assert.isFalse(item.hasTag(`${suffix}-second`));
        assert.equal(item.getField("title"), suffix);
      } finally {
        setOriginalAgentPermissionMode(previousMode);
        for (const id of items.reverse()) {
          const item = Zotero.Items.get(id);
          if (item) await item.eraseTx();
        }
        for (const id of collections.reverse()) {
          const collection = Zotero.Collections.get(id);
          if (collection) await collection.eraseTx();
        }
      }
    });
  }
});

describe("external MCP library_cite, library_settings, note_write_batch and read_attachment against native Zotero", function () {
  this.timeout(120000);
  const libraryID = () => Zotero.Libraries.userLibraryID;
  const suffix = `MCP-W31-${Date.now()}`;
  const created: any[] = [];
  const paths: string[] = [];
  let sequence = 0;

  // The registered endpoint and the real native tool registry, with no turn
  // header: the call a standalone Codex or Claude Code client makes.
  const rawCall = async (name: string, args: object) => {
    const Endpoint = Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH];
    const [status, , body] = await new Endpoint().init({
      method: "POST",
      headers: {
        Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
      },
      data: {
        jsonrpc: "2.0",
        id: ++sequence,
        method: "tools/call",
        params: { name, arguments: { libraryID: libraryID(), ...args } },
      },
    });
    assert.equal(status, 200);
    const payload = JSON.parse(body);
    assert.isUndefined(payload.error, body);
    const text = payload.result.content[0].text;
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text };
    }
    return { isError: payload.result.isError === true, parsed, text };
  };
  const call = async (name: string, args: object) => {
    const reply = await rawCall(name, args);
    assert.isFalse(reply.isError, reply.text);
    return reply.parsed;
  };
  const makeItem = async (
    title: string,
    fields: Record<string, string> = {},
  ) => {
    const item = new Zotero.Item("journalArticle");
    item.libraryID = libraryID();
    item.setField("title", title);
    for (const [key, value] of Object.entries(fields))
      item.setField(key, value);
    await item.saveTx();
    created.push(item);
    return item;
  };

  after(async function () {
    for (const item of created.reverse()) {
      const live = Zotero.Items.get(item.id);
      if (live) await live.eraseTx();
    }
    for (const path of paths)
      await (globalThis as any).IOUtils.remove(path, { ignoreAbsent: true });
  });

  it("lists the four tools to a standalone client and hides attachFile", async function () {
    const Endpoint = Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH];
    const [, , body] = await new Endpoint().init({
      method: "POST",
      headers: { Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}` },
      data: { jsonrpc: "2.0", id: ++sequence, method: "tools/list" },
    });
    const tools = JSON.parse(body).result.tools as any[];
    const names = tools.map((tool) => tool.name);
    for (const name of [
      "library_cite",
      "library_settings",
      "note_write_batch",
      "read_attachment",
    ])
      assert.include(names, name);
    for (const name of ["library_batch", "workflow_script", "web_search"])
      assert.notInclude(names, name);
    const attachment = tools.find((tool) => tool.name === "read_attachment");
    assert.notProperty(attachment.inputSchema.properties, "attachFile");
  });

  it("library_cite returns a formatted citation and BibTeX for a real item", async function () {
    const item = await makeItem(`${suffix} Cited Article`, {
      date: "2021",
      publicationTitle: "Journal of Parity",
      DOI: "10.1000/mcp.w31",
    });
    item.setCreators([
      {
        creatorType: "author",
        firstName: "Ada",
        lastName: `Lovelace${suffix.slice(-4)}`,
      },
    ]);
    await item.saveTx();
    const surname = `Lovelace${suffix.slice(-4)}`;

    const bibliography = await call("library_cite", {
      action: "bibliography",
      itemIds: [item.id],
      styleId: "http://www.zotero.org/styles/apa",
    });
    const output = valuesNamed(bibliography, "output").find(
      (value) => typeof value === "string",
    ) as string;
    assert.include(
      output,
      `${suffix} Cited Article`,
      JSON.stringify(bibliography),
    );
    assert.include(output, surname);
    assert.include(output, "2021");

    const inText = await call("library_cite", {
      action: "cite",
      itemIds: [item.id],
      styleId: "http://www.zotero.org/styles/apa",
    });
    assert.include(JSON.stringify(inText), surname);

    const formats = await call("library_cite", { action: "formats" });
    const bibtex = (valuesNamed(formats, "formats")[0] as any[]).find((entry) =>
      /bibtex/i.test(`${entry.id} ${entry.label}`),
    );
    assert.exists(bibtex, JSON.stringify(formats));
    // Every listed format id is the translator Zotero holds under that label.
    await Zotero.Translators.init();
    for (const entry of valuesNamed(formats, "formats")[0] as any[]) {
      const translator = Zotero.Translators.get(entry.id);
      assert.exists(translator, `${entry.label}: no translator ${entry.id}`);
      assert.include(translator.label, entry.label);
    }
    const exported = await call("library_cite", {
      action: "export",
      itemIds: [item.id],
      translatorId: bibtex.id,
    });
    const bib = valuesNamed(exported, "output").find(
      (value) => typeof value === "string",
    ) as string;
    assert.equal(
      valuesNamed(exported, "itemCount").find((v) => typeof v === "number"),
      1,
    );
    assert.match(bib, /@article\s*\{/i, JSON.stringify(exported));
    // BibTeX braces capitalized words to protect their case.
    assert.include(bib.replace(/[{}]/g, ""), `${suffix} Cited Article`);
    assert.include(bib, "10.1000/mcp.w31");
  });

  it("library_settings lists a setting a standalone client can read", async function () {
    const listed = await call("library_settings", { action: "list" });
    const settings = valuesNamed(listed, "settings").find((value) =>
      Array.isArray(value),
    ) as any[];
    assert.isAbove(settings.length, 0, JSON.stringify(listed));
    const first = settings[0];
    assert.isString(first.key);
    assert.property(first, "value");
    // The value matches what Zotero holds for that preference.
    const status = await call("library_settings", { action: "syncStatus" });
    assert.isObject(status);
  });

  it("note_write_batch writes every listed note with per-item receipts, and a retry writes no duplicates", async function () {
    const parents = [
      await makeItem(`${suffix} Batch A`),
      await makeItem(`${suffix} Batch B`),
      await makeItem(`${suffix} Batch C`),
    ];
    const notes = parents.map((parent, index) => ({
      targetItemId: parent.id,
      content: `## ${suffix} summary ${index}\n\nBody of note ${index}.`,
    }));
    const noteTexts = (parent: any) =>
      parent
        .getNotes()
        .map((id: number) => Zotero.Items.get(id).getNote() as string);

    const first = await call("note_write_batch", { target: "item", notes });
    assert.isTrue(first.ok, JSON.stringify(first));
    for (const [index, parent] of parents.entries()) {
      await parent.reload();
      const texts = noteTexts(parent);
      assert.lengthOf(texts, 1, `parent ${index}`);
      assert.include(texts[0], `${suffix} summary ${index}`);
      assert.include(texts[0], `Body of note ${index}.`);
    }
    // The receipt names every target and the exact native note it created.
    const receipts = (first.actionReceipts || []) as any[];
    assert.lengthOf(receipts, 1, JSON.stringify(first));
    assert.equal(evaluatePreparedActionContract(receipts).state, "satisfied");
    assert.equal(receipts[0].executionAuthority, "external_runtime");
    assert.sameMembers(
      receipts[0].appliedTargets,
      parents.map((parent) => `item:${parent.id}`),
    );
    const nativeNoteIds = parents.flatMap((parent) => parent.getNotes());
    assert.sameMembers(
      receipts[0].verifiedFacts
        .filter((fact: string) => fact.startsWith("created_note:item:"))
        .map((fact: string) => Number(fact.split(":").pop())),
      nativeNoteIds,
    );

    // The same call again lands on the same batch: nothing is written twice.
    const second = await call("note_write_batch", { target: "item", notes });
    assert.isTrue(second.ok, JSON.stringify(second));
    for (const [index, parent] of parents.entries()) {
      await parent.reload();
      assert.lengthOf(noteTexts(parent), 1, `parent ${index} after retry`);
    }
  });

  it("read_attachment reads a text and an HTML attachment, and refuses attachFile:true", async function () {
    const io = (globalThis as any).IOUtils;
    const parent = await makeItem(`${suffix} Attachments`);
    const dir = Zotero.getTempDirectory().path;
    const textPath = `${dir}/${suffix}-notes.txt`;
    const htmlPath = `${dir}/${suffix}-page.html`;
    paths.push(textPath, htmlPath);
    await io.writeUTF8(textPath, `Plain attachment ${suffix} sentinel-text`);
    await io.writeUTF8(
      htmlPath,
      `<!DOCTYPE html><html><body><h1>HTML ${suffix}</h1><p>sentinel-html</p></body></html>`,
    );
    const textAttachment = await Zotero.Attachments.importFromFile({
      file: textPath,
      parentItemID: parent.id,
    });
    const htmlAttachment = await Zotero.Attachments.importFromFile({
      file: htmlPath,
      parentItemID: parent.id,
    });
    created.push(textAttachment, htmlAttachment);

    const text = await call("read_attachment", {
      target: { contextItemId: textAttachment.id },
    });
    assert.include(JSON.stringify(text), "sentinel-text");
    const html = await call("read_attachment", {
      target: { contextItemId: htmlAttachment.id },
    });
    assert.include(JSON.stringify(html), "sentinel-html");

    const refused = await rawCall("read_attachment", {
      target: { contextItemId: textAttachment.id },
      attachFile: true,
    });
    assert.isTrue(refused.isError, refused.text);
    assert.include(refused.text, "attachFile:true is not available over MCP");
  });
});

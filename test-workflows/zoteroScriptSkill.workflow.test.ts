import { assert } from "chai";
import { PDFDocument } from "pdf-lib";
import {
  getOrCreateZoteroMcpBearerToken,
  ZOTERO_MCP_ENDPOINT_PATH,
} from "../src/agent/mcp/server";

declare const Zotero: any;

/**
 * The zotero-script skill against real Zotero, through the registered MCP
 * endpoint and the real tool registry: a read script, a write script and its
 * undo, and the skill's own copy-or-move recipe, run exactly as the profile
 * installed it, from the user library into a disposable group library.
 */

function valuesNamed(value: any, key: string): any[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([name, child]) => [
    ...(name === key ? [child] : []),
    ...valuesNamed(child, key),
  ]);
}

/**
 * The recipe block of the skill as the profile installed it and load_skill
 * returns it, with its three constants set.
 */
function installedRecipe(
  body: string,
  params: {
    sourceItemIds: number[];
    targetLibraryID: number;
    move: boolean;
  },
): string {
  const match =
    /### Copy or move items to another library[\s\S]*?```javascript\n([\s\S]*?)```/.exec(
      body,
    );
  assert.exists(match, "the skill has no recipe block");
  let script = match![1];
  for (const [name, value] of [
    ["sourceItemIds", JSON.stringify(params.sourceItemIds)],
    ["targetLibraryID", String(params.targetLibraryID)],
    ["move", String(params.move)],
  ] as const) {
    const line = new RegExp(`^const ${name} = .*;$`, "m");
    assert.match(script, line, `the recipe sets ${name} first`);
    script = script.replace(line, `const ${name} = ${value};`);
  }
  return script;
}

describe("zotero-script skill against native Zotero", function () {
  this.timeout(120000);
  const libraryID = () => Zotero.Libraries.userLibraryID;
  const suffix = `W32-${Date.now()}`;
  const created: number[] = [];
  const paths: string[] = [];
  let group: any;
  let skillBody = "";
  let sequence = 0;

  const rpc = async (method: string, params?: object) => {
    const Endpoint = Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH];
    const [status, , body] = await new Endpoint().init({
      method: "POST",
      headers: {
        Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
      },
      data: { jsonrpc: "2.0", id: ++sequence, method, params },
    });
    assert.equal(status, 200);
    const payload = JSON.parse(body);
    assert.isUndefined(payload.error, body);
    return payload.result;
  };
  const call = async (name: string, args: object) => {
    const result = await rpc("tools/call", {
      name,
      arguments: { libraryID: libraryID(), ...args },
    });
    const text = result.content[0].text;
    assert.isNotTrue(result.isError, text);
    const parsed = JSON.parse(text);
    assert.isTrue(parsed.ok, text);
    return parsed;
  };
  const script = async (
    access: "library" | "privileged",
    effect: "read" | "write",
    source: string,
  ) => {
    const result = await call("zotero_script", {
      access,
      effect,
      script: source,
      description: `${suffix} ${access} ${effect}`,
    });
    const errors = valuesNamed(result, "error").filter(Boolean);
    assert.isEmpty(errors, JSON.stringify(result));
    const returned = valuesNamed(result, "returnValue");
    assert.lengthOf(returned, 1, JSON.stringify(result));
    const actionId = valuesNamed(result, "actionId").find(
      (id) => typeof id === "string",
    );
    return { result, returnValue: returned[0], actionId };
  };
  const makeItem = async (title: string, tags: string[] = []) => {
    const item = new Zotero.Item("journalArticle");
    item.libraryID = libraryID();
    item.setField("title", title);
    item.setCreators([
      { creatorType: "author", firstName: "Ada", lastName: suffix },
    ]);
    for (const tag of tags) item.addTag(tag);
    await item.saveTx();
    created.push(item.id);
    return item;
  };
  const tempFile = async (name: string, bytes: Uint8Array) => {
    const path = PathUtils.join(
      Zotero.getTempDirectory().path,
      `${suffix}-${name}`,
    );
    await IOUtils.write(path, bytes);
    paths.push(path);
    return path;
  };

  before(async function () {
    group = new Zotero.Group({
      groupID:
        Number(
          await Zotero.DB.valueQueryAsync("SELECT MAX(groupID) FROM groups"),
        ) + 1,
      name: `ScriptCopy-${suffix}`,
      description: "Disposable copy target",
      version: 0,
    });
    group.editable = true;
    group.filesEditable = true;
    await group.saveTx();
  });

  after(async function () {
    for (const id of created.reverse()) {
      const item = Zotero.Items.get(id);
      if (item) await item.eraseTx();
    }
    if (group) await group.eraseTx();
    for (const path of paths)
      await IOUtils.remove(path, { ignoreAbsent: true });
  });

  it("points every MCP client at the skill, and load_skill returns it", async function () {
    const listed = await rpc("tools/list");
    const tool = listed.tools.find(
      (entry: { name: string }) => entry.name === "zotero_script",
    );
    assert.exists(tool);
    assert.include(tool.description, "load_skill('zotero-script')");
    const loaded = await call("load_skill", { id: "zotero-script" });
    const instructions = valuesNamed(loaded, "instructions");
    assert.lengthOf(instructions, 1, JSON.stringify(loaded));
    skillBody = instructions[0];
    assert.include(skillBody, "### Copy or move items to another library");
    assert.include(skillBody, "Never call `item.moveToLibrary()`");
  });

  it("gives a script the globals the skill names", async function () {
    const { returnValue } = await script(
      "privileged",
      "read",
      "return { atob: typeof atob, btoa: typeof btoa, TextEncoder: typeof TextEncoder, TextDecoder: typeof TextDecoder, fetch: typeof fetch, IOUtils: typeof IOUtils, PathUtils: typeof PathUtils, getContentsAsync: typeof Zotero.File.getContentsAsync, putContentsAsync: typeof Zotero.File.putContentsAsync };",
    );
    assert.deepEqual(returnValue, {
      atob: "function",
      btoa: "function",
      TextEncoder: "function",
      TextDecoder: "function",
      fetch: "function",
      IOUtils: "undefined",
      PathUtils: "undefined",
      getContentsAsync: "function",
      putContentsAsync: "function",
    });
  });

  it("runs a read-only library script and returns its data", async function () {
    const item = await makeItem(`${suffix} read`);
    const { returnValue } = await script(
      "library",
      "read",
      `const items = await Zotero.Items.getAll(env.libraryID, false, false, false);
return items.filter((entry) => entry.isRegularItem() && entry.getField('title') === ${JSON.stringify(`${suffix} read`)}).map((entry) => entry.id);`,
    );
    assert.deepEqual(returnValue, [item.id]);
  });

  it("undoes a write script's field and tag change from its snapshot", async function () {
    const title = `${suffix} write`;
    const item = await makeItem(title, [`${suffix}-old`]);
    const { actionId } = await script(
      "library",
      "write",
      `const item = Zotero.Items.get(${item.id});
env.snapshot(item);
item.setField('title', ${JSON.stringify(`${title} changed`)});
item.removeTag(${JSON.stringify(`${suffix}-old`)});
item.addTag(${JSON.stringify(`${suffix}-new`)});
await item.saveTx();
return item.id;`,
    );
    await item.reload();
    assert.equal(item.getField("title"), `${title} changed`);
    assert.isTrue(item.hasTag(`${suffix}-new`));
    assert.isFalse(item.hasTag(`${suffix}-old`));
    assert.isString(actionId);
    await call("undo", { actionId });
    await item.reload();
    assert.equal(item.getField("title"), title);
    assert.isTrue(item.hasTag(`${suffix}-old`));
    assert.isFalse(item.hasTag(`${suffix}-new`));
  });

  describe("the copy-or-move recipe, into a group library", function () {
    let original: any;
    let pdfBytes: Uint8Array;
    let pdfAttachment: any;
    let linkedAttachment: any;
    let note: any;

    before(async function () {
      if (!skillBody) {
        const loaded = await call("load_skill", { id: "zotero-script" });
        skillBody = valuesNamed(loaded, "instructions")[0];
      }
      original = await makeItem(`${suffix} source`, [`${suffix}-tag`]);
      const pdf = await PDFDocument.create();
      pdf.addPage([612, 792]);
      pdfBytes = await pdf.save();
      pdfAttachment = await Zotero.Attachments.importFromFile({
        file: await tempFile("paper.pdf", pdfBytes),
        parentItemID: original.id,
      });
      created.push(pdfAttachment.id);
      linkedAttachment = await Zotero.Attachments.linkFromFile({
        file: await tempFile("linked.txt", new TextEncoder().encode("linked")),
        parentItemID: original.id,
      });
      created.push(linkedAttachment.id);
      note = new Zotero.Item("note");
      note.libraryID = libraryID();
      note.parentID = original.id;
      note.setNote(`<p>${suffix} child note</p>`);
      await note.saveTx();
      created.push(note.id);
    });

    const copiesInGroup = async () =>
      (await Zotero.Items.getAll(group.libraryID, false, true, false)).filter(
        (entry: any) =>
          entry.isRegularItem() &&
          entry.getField("title") === `${suffix} source`,
      );

    async function assertCopy(copy: any) {
      assert.equal(copy.libraryID, group.libraryID);
      assert.isTrue(copy.hasTag(`${suffix}-tag`));
      assert.equal(copy.getCreators()[0].lastName, suffix);
      assert.isEmpty(copy.getCollections());
      const notes = Zotero.Items.get(copy.getNotes());
      assert.lengthOf(notes, 1);
      assert.include(notes[0].getNote(), `${suffix} child note`);
      const attachments = Zotero.Items.get(copy.getAttachments());
      assert.lengthOf(attachments, 1, "only the PDF is copied");
      const [pdf] = attachments;
      assert.equal(
        pdf.attachmentLinkMode,
        Zotero.Attachments.LINK_MODE_IMPORTED_FILE,
      );
      assert.equal(pdf.attachmentContentType, "application/pdf");
      assert.equal(pdf.libraryID, group.libraryID);
      const copiedPath = await pdf.getFilePathAsync();
      assert.isString(copiedPath);
      assert.notEqual(copiedPath, await pdfAttachment.getFilePathAsync());
      assert.deepEqual(
        Array.from(new Uint8Array(await IOUtils.read(copiedPath))),
        Array.from(pdfBytes),
      );
    }

    function assertSkippedLinkedFile(returnValue: any) {
      assert.lengthOf(returnValue, 1, JSON.stringify(returnValue));
      const [entry] = returnValue;
      assert.isTrue(entry.verified, JSON.stringify(entry));
      assert.deepEqual(
        entry.skipped.map((skip: any) => skip.id),
        [linkedAttachment.id],
      );
      assert.match(entry.skipped[0].reason, /linked file/);
      assert.equal(entry.skipped[0].title, linkedAttachment.getField("title"));
    }

    it("copies the item with its PDF and note, names the linked file, and keeps the original", async function () {
      const { returnValue, actionId } = await script(
        "privileged",
        "write",
        installedRecipe(skillBody, {
          sourceItemIds: [original.id],
          targetLibraryID: group.libraryID,
          move: false,
        }),
      );
      assertSkippedLinkedFile(returnValue);
      assert.isFalse(returnValue[0].trashed);
      const copies = await copiesInGroup();
      assert.lengthOf(copies, 1);
      await assertCopy(copies[0]);
      await original.reload();
      assert.isFalse(original.deleted);
      assert.lengthOf(original.getAttachments(), 2);
      assert.lengthOf(original.getNotes(), 1);

      assert.isString(actionId);
      await call("undo", { actionId });
      const copy = Zotero.Items.get(copies[0].id);
      assert.isTrue(copy.deleted, "undo trashes the copy");
      for (const id of [...copy.getNotes(true), ...copy.getAttachments(true)])
        assert.isTrue(Zotero.Items.get(id).deleted, `undo trashes child ${id}`);
    });

    it("moves the item: trashes the original only after its copy is verified, never erases it", async function () {
      const before = new Set(
        (await copiesInGroup()).map((entry: any) => entry.id),
      );
      const { returnValue, actionId } = await script(
        "privileged",
        "write",
        installedRecipe(skillBody, {
          sourceItemIds: [original.id],
          targetLibraryID: group.libraryID,
          move: true,
        }),
      );
      assertSkippedLinkedFile(returnValue);
      assert.isTrue(returnValue[0].trashed);
      const copies = (await copiesInGroup()).filter(
        (entry: any) => !before.has(entry.id),
      );
      assert.lengthOf(copies, 1);
      await assertCopy(copies[0]);

      const trashed = Zotero.Items.get(original.id);
      assert.exists(trashed, "the original is not erased");
      await trashed.reload();
      assert.isTrue(trashed.deleted, "the original is in the trash");
      assert.lengthOf(trashed.getAttachments(true), 2);
      assert.exists(Zotero.Items.get(linkedAttachment.id));

      await call("undo", { actionId });
      await trashed.reload();
      assert.isFalse(trashed.deleted, "undo restores the original");
      assert.isTrue(Zotero.Items.get(copies[0].id).deleted);
    });
  });
});

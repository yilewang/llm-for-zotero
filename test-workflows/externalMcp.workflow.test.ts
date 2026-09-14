import { assert } from "chai";
import { evaluatePreparedActionContract } from "../src/agent/contracts/actionEvaluation";
import {
  getOrCreateZoteroMcpBearerToken,
  ZOTERO_MCP_ENDPOINT_PATH,
} from "../src/agent/mcp/server";
import {
  areExternalMcpWritesEnabled,
  setExternalMcpWritesEnabled,
} from "../src/agent/mcp/prefs";
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
  for (const mode of ["safe", "auto", "yolo"] as const) {
    it(`executes a standalone create/import/tag/note/undo workflow in ${mode}`, async function () {
      const previousEnabled = areExternalMcpWritesEnabled();
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
        setExternalMcpWritesEnabled(true);
        setOriginalAgentPermissionMode(mode);
        const collectionResult = await call("collection_update", {
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
          evaluatePreparedActionContract(
            {
              actionPreparation: {
                state: "needs_input",
                issues: ["Unresolved Original Agent intent"],
              },
            },
            tagged.actionReceipts,
          ).state,
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
        await call("undo_last_action", { actionId });
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
        await call("revert_changes", { actionIds: [tagId, secondTagId] });
        await item.reload();
        assert.isFalse(item.hasTag(suffix));
        assert.isFalse(item.hasTag(`${suffix}-second`));
        assert.equal(item.getField("title"), suffix);
      } finally {
        setExternalMcpWritesEnabled(previousEnabled);
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

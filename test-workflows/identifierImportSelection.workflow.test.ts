import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: identifier import preserves conversation selection", function () {
  this.timeout(60000);

  it("saves native items, child notes and destination membership without selecting the import", async function () {
    const native = Zotero as any;
    const api = native.LLMForZotero.api.workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Import conversation source",
      pages: ["The conversation must stay attached to this paper."],
    });
    const collection = new Zotero.Collection();
    collection.libraryID = Zotero.Libraries.userLibraryID;
    collection.name = `Import selection ${Date.now()}`;
    await collection.saveTx({ skipSelect: true });
    const Search = native.Translate.Search;
    const observed: Array<{ ids: number[]; extraData: Record<string, any> }> =
      [];
    const imported: number[] = [];
    const observer = Zotero.Notifier.registerObserver(
      {
        notify(event, type, ids, extraData) {
          if (event === "add" && type === "item")
            observed.push({ ids: ids.map(Number), extraData });
        },
      },
      ["item"],
      "import-selection-workflow",
    );
    try {
      const before = await api.openStandaloneForItem(fixture.parentItemId);
      const raw = [
        {
          itemType: "journalArticle",
          title: "Selection-safe imported paper",
          notes: [{ note: "A translated child note" }],
          attachments: [],
        },
      ];
      // Only the network translator is substituted. Both the legacy saving
      // route and the repaired route use Zotero's real ItemSaver and notifier.
      native.Translate.Search = class {
        setIdentifier() {}
        async getTranslators() {
          return [{}];
        }
        setTranslator() {}
        async translate(options: { libraryID: number | false }) {
          if (options.libraryID === false) return raw;
          return new native.Translate.ItemSaver({
            libraryID: options.libraryID,
            attachmentMode: native.Translate.ItemSaver.ATTACHMENT_MODE_IGNORE,
          }).saveItems(raw, () => {});
        }
      };
      const result = await new ZoteroGateway().importPapersByIdentifiers(
        ["10.1000/selection-fixture"],
        collection.libraryID,
        collection.id,
      );
      imported.push(...(result.itemIds || []));
      assert.equal(result.succeeded, 1);
      const item = Zotero.Items.get(imported[0]);
      assert.equal(item.getField("title"), raw[0].title);
      assert.deepEqual(item.getCollections(), [collection.id]);
      assert.lengthOf(item.getNotes(), 1);
      const event = observed.find((entry) => entry.ids.includes(item.id));
      assert.isTrue(
        event?.extraData[item.id]?.skipSelect,
        "native import must opt out of automatic tree selection",
      );
      const after = await api.getStandaloneDiagnostics();
      assert.equal(after.conversationKey, before.conversationKey);
      assert.equal(after.basePaperItemId, fixture.parentItemId);
    } finally {
      native.Translate.Search = Search;
      Zotero.Notifier.unregisterObserver(observer);
      await api.reset();
      for (const id of imported) await Zotero.Items.get(id)?.eraseTx();
      await collection.eraseTx();
      await api.cleanupFixture(fixture);
    }
  });
});

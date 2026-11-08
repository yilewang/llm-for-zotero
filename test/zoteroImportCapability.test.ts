import { assert } from "chai";
import {
  ImportCapability,
  type ImportCapabilityDeps,
} from "../src/agent/services/zotero/importCapability";
import type {
  EditableArticleMetadataField,
  EditableArticleMetadataSnapshot,
} from "../src/agent/services/libraryMutation/valueTypes";

/**
 * The import paths used to live on `ZoteroGateway` and reached the item and
 * collection lookups through `this`. They now take those lookups as
 * dependencies, so this file drives the capability on its own — the same
 * behaviour `importTranslateAndIdentifiers.test.ts` pins through the facade,
 * asserted here against the seam the facade fills in.
 */
describe("import capability", function () {
  let translated: Array<{ location: unknown; options: unknown }>;
  let attached: string[];
  let recognized: unknown[][];
  let translatorsAvailable: boolean;

  function install(overrides: Record<string, unknown> = {}) {
    translated = [];
    attached = [];
    recognized = [];
    translatorsAvailable = true;

    class FakeImport {
      private location: unknown;
      setLocation(file: unknown) {
        this.location = file;
      }
      async getTranslators() {
        return translatorsAvailable ? [{ label: "RIS" }] : [];
      }
      setTranslator() {}
      async translate(options: unknown) {
        translated.push({ location: this.location, options });
        return [{ id: 11 }, { id: 12 }];
      }
    }

    (globalThis as Record<string, unknown>).Zotero = {
      Translate: { Import: FakeImport },
      Attachments: {
        importFromFile: async ({ file }: { file: unknown }) => {
          attached.push(String(file));
          return {
            id: 77,
            parentID: false,
            getField: () => "",
            attachmentFilename: "paper.pdf",
            isPDFAttachment: () => true,
            addToCollection: () => undefined,
            saveTx: async () => undefined,
          };
        },
      },
      RecognizeDocument: {
        recognizeItems: async (items: unknown[]) => {
          recognized.push(items);
        },
      },
      Items: { get: () => null },
      Collections: { get: () => null },
      Libraries: { userLibraryID: 1 },
      Utilities: {
        extractIdentifiers: (text: string) => {
          if (/^\d{4}\.\d{4,5}$/.test(text)) return [{ arXiv: text }];
          if (/^\d{8,9}$/.test(text)) return [{ PMID: text }];
          if (/10\.\d{4,}\//.test(text)) {
            const m = text.match(/10\.\d{4,}\/\S+/);
            return m ? [{ DOI: m[0] }] : [];
          }
          return [];
        },
      },
      debug: () => undefined,
      ...overrides,
    };
  }

  afterEach(function () {
    delete (globalThis as Record<string, unknown>).Zotero;
  });

  /** The capability under test, with every dependency answered explicitly. */
  function capability(deps: Partial<ImportCapabilityDeps> = {}) {
    return new ImportCapability({
      getItem: () => null,
      getCollection: () => null,
      getEditableArticleMetadata: () => null,
      ...deps,
    });
  }

  function snapshot(
    fields: Partial<Record<EditableArticleMetadataField, string>>,
    creators: EditableArticleMetadataSnapshot["creators"] = [],
  ): EditableArticleMetadataSnapshot {
    return {
      itemId: 55,
      itemType: "journalArticle",
      title: fields.title || "",
      fields: fields as Record<EditableArticleMetadataField, string>,
      creators,
    };
  }

  describe("bibliography files", function () {
    it("reads the file through the translators and reports the items it made", async function () {
      install();
      const result = await capability().importBibliographyFile({
        filePath: "/tmp/refs.ris",
        libraryID: 1,
      });
      assert.deepEqual(result, { status: "imported", itemIds: [11, 12] });
      assert.lengthOf(translated, 1);
    });

    it("separates 'no translator for this file' from a failure", async function () {
      install();
      translatorsAvailable = false;
      const result = await capability().importBibliographyFile({
        filePath: "/tmp/notes.txt",
        libraryID: 1,
      });
      // The caller falls back to attaching on "unsupported" and gives up on
      // "error", so the two must not collapse into one status.
      assert.equal(result.status, "unsupported");
      assert.deepEqual(result.itemIds, []);
    });

    it("reports the reason when the build has no import translator at all", async function () {
      install({ Translate: {} });
      const result = await capability().importBibliographyFile({
        filePath: "/tmp/refs.ris",
        libraryID: 1,
      });
      assert.equal(result.status, "error");
      assert.include(result.reason || "", "Translate.Import");
    });
  });

  describe("local files", function () {
    it("files references into the collection the injected lookup returns", async function () {
      install();
      const asked: Array<number | undefined> = [];
      const result = await capability({
        getCollection: (collectionId) => {
          asked.push(collectionId);
          return { id: 42, libraryID: 1 } as unknown as Zotero.Collection;
        },
      }).importLocalFiles({
        filePaths: ["/tmp/refs.bib"],
        libraryID: 1,
        targetCollectionId: 42,
      });

      assert.equal(result.succeeded, 1);
      assert.deepEqual(asked, [42], "the capability never resolves it itself");
      assert.deepEqual(
        (translated[0].options as { collections: number[] }).collections,
        [42],
      );
    });

    it("attaches a PDF and runs metadata recognition", async function () {
      install();
      const result = await capability().importLocalFiles({
        filePaths: ["/tmp/paper.pdf"],
        libraryID: 1,
      });
      assert.equal(result.succeeded, 1);
      assert.lengthOf(attached, 1);
      assert.lengthOf(recognized, 1);
    });

    it("files the recognised parent, not the attachment under it", async function () {
      const filed: number[] = [];
      install({
        Attachments: {
          importFromFile: async () => ({
            id: 77,
            // Recognition attaches the PDF to a new parent item.
            parentID: 0,
            getField: () => "",
            attachmentFilename: "paper.pdf",
            isPDFAttachment: () => true,
            addToCollection: () => undefined,
            saveTx: async () => undefined,
          }),
        },
        RecognizeDocument: {
          recognizeItems: async (items: Array<{ parentID: number }>) => {
            items[0].parentID = 500;
          },
        },
      });
      const result = await capability({
        getCollection: () =>
          ({ id: 42, libraryID: 1 }) as unknown as Zotero.Collection,
        getItem: (itemId) =>
          ({
            id: itemId,
            parentID: false,
            addToCollection: (collectionId: number) => filed.push(collectionId),
            saveTx: async () => undefined,
          }) as unknown as Zotero.Item,
      }).importLocalFiles({
        filePaths: ["/tmp/paper.pdf"],
        libraryID: 1,
        targetCollectionId: 42,
      });

      assert.deepEqual(filed, [42]);
      assert.equal(result.items[0].itemId, 500);
    });
  });

  describe("identifiers", function () {
    it("delegates parsing to Zotero's own extractor", function () {
      install();
      const cap = capability();
      assert.deepEqual(cap.parseImportIdentifier("2301.00001"), {
        arXiv: "2301.00001",
      });
      assert.deepEqual(cap.parseImportIdentifier("12345678"), {
        PMID: "12345678",
      });
    });

    it("falls back to its own branches when the extractor finds nothing", function () {
      install({ Utilities: {} });
      const cap = capability();
      assert.deepEqual(cap.parseImportIdentifier("arXiv:2301.00001"), {
        arXiv: "2301.00001",
      });
      assert.deepEqual(cap.parseImportIdentifier("isbn 978-0-306-40615-7"), {
        ISBN: "978-0-306-40615-7",
      });
      assert.deepEqual(
        cap.parseImportIdentifier("https://doi.org/10.1000/example"),
        { DOI: "10.1000/example" },
      );
    });

    it("explains an unimportable page URL and stays quiet otherwise", function () {
      install();
      const cap = capability();
      assert.include(
        cap.describeUnresolvableIdentifier(
          "https://arxiv.org/abs/2301.00001",
        ) || "",
        "page URL",
      );
      assert.isNull(
        cap.describeUnresolvableIdentifier(
          "https://link.springer.com/article/10.1007/s00221-021-06062-3",
        ),
      );
      assert.isNull(cap.describeUnresolvableIdentifier("10.1000/example"));
    });

    it("counts only the regular items the injected lookup confirms", async function () {
      class Search {
        setIdentifier() {}
        async getTranslators() {
          return [{}];
        }
        setTranslator() {}
        async translate() {
          return [{ itemType: "journalArticle" }];
        }
      }
      class ItemSaver {
        static ATTACHMENT_MODE_DOWNLOAD = 1;
        constructor(_options: unknown) {}
        async saveItems() {
          // A paper plus the PDF Zotero downloaded for it.
          return [{ id: 91 }, { id: 92 }];
        }
      }
      install({ Translate: { Search, ItemSaver } });
      const result = await capability({
        getItem: (itemId) =>
          ({
            id: itemId,
            isRegularItem: () => itemId === 91,
          }) as unknown as Zotero.Item,
      }).importPapersByIdentifiers(["10.1000/example"], 1);

      assert.deepEqual(result.itemIds, [91]);
      assert.equal(result.succeeded, 1);
      assert.equal(result.failed, 0);
    });

    it("reports the bare string Zotero rejects a translation with", async function () {
      class Search {
        setIdentifier() {}
        async getTranslators() {
          return [{}];
        }
        setTranslator() {}
        async translate(): Promise<unknown[]> {
          // Zotero rejects with a string, not an Error.
          throw "No items returned from any translator";
        }
      }
      install({ Translate: { Search } });
      const result = await capability().importPapersByIdentifiers([
        "10.1000/example",
      ]);
      assert.equal(result.failed, 1);
      assert.equal(
        result.items[0].reason,
        "No items returned from any translator",
      );
    });

    it("says why a page URL resolved to nothing", async function () {
      class Search {
        setIdentifier() {}
        async getTranslators() {
          return [];
        }
        setTranslator() {}
        async translate() {
          return [];
        }
      }
      install({ Translate: { Search } });
      const result = await capability().importPapersByIdentifiers([
        "https://arxiv.org/abs/2301.00001",
      ]);
      assert.equal(result.items[0].status, "not_found");
      assert.include(result.items[0].reason || "", "page URL");
    });
  });

  describe("metadata by identifier", function () {
    it("turns a translator JSON result into a patch", async function () {
      class Search {
        setIdentifier() {}
        async getTranslators() {
          return [{}];
        }
        setTranslator() {}
        async translate() {
          return [
            {
              title: "  Hippocampal replay  ",
              issue: 4,
              itemType: "journalArticle",
              creators: [{ name: "The Allen Institute" }],
            },
          ];
        }
      }
      install({ Translate: { Search } });
      const patch =
        await capability().fetchMetadataByIdentifier("10.1000/example");
      assert.deepEqual(patch, {
        title: "Hippocampal replay",
        issue: "4",
        creators: [
          {
            creatorType: "author",
            firstName: undefined,
            lastName: undefined,
            name: "The Allen Institute",
            fieldMode: 1,
          },
        ],
      });
    });

    it("reads the temporary item through the injected metadata reader, then erases it", async function () {
      class Search {
        setIdentifier() {}
        async getTranslators() {
          return [{}];
        }
        setTranslator() {}
        async translate(options: { libraryID?: number | false }) {
          // The translator that cannot answer without saving.
          if (options?.libraryID === false) throw new Error("needs a library");
          return [{ id: 55 }];
        }
      }
      install({ Translate: { Search } });
      let erased = false;
      const item = {
        id: 55,
        deleted: false,
        saveTx: async () => undefined,
        eraseTx: async () => {
          erased = true;
        },
      } as unknown as Zotero.Item;

      const patch = await capability({
        getItem: (itemId) => (itemId === 55 ? item : null),
        getEditableArticleMetadata: () =>
          snapshot({ title: "Replay", DOI: "", issue: "4" }, [
            { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
          ]),
      }).fetchMetadataByIdentifier("10.1000/example");

      assert.deepEqual(patch, {
        title: "Replay",
        issue: "4",
        creators: [
          { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
        ],
      });
      assert.isTrue(erased, "the temporary item must not survive the lookup");
    });
  });
});

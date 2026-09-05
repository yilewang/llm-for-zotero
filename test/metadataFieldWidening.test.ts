import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { normalizeMetadataPatch } from "../src/agent/tools/write/mutateLibraryShared";

/**
 * Metadata writes were gated by an 18-name allowlist against Zotero's ~103
 * fields. The gate was not where it looked: `normalizeMetadataPatch` filtered
 * the patch down to those 18 names *before* the gateway saw it, so widening
 * the gateway alone would have changed nothing.
 *
 * The validity check was wrong twice over as well: it compared the *base*
 * field id against the item type, so `publicationTitle` on a book section
 * looked invalid even though `setField` writes it happily as `bookTitle`; and
 * its catch returned `true`, declaring every field valid whenever
 * `Zotero.ItemFields` was missing.
 */
describe("metadata field widening", function () {
  // A small but faithful slice of Zotero's field table, including a base
  // field with type-specific names.
  const FIELD_IDS: Record<string, number> = {
    title: 1,
    publicationTitle: 2,
    bookTitle: 3,
    publisher: 4,
    accessDate: 5,
    numPages: 6,
    abstractNote: 7,
  };
  const NAMES = Object.fromEntries(
    Object.entries(FIELD_IDS).map(([name, id]) => [id, name]),
  );
  // itemTypeID 1 = journalArticle, 2 = bookSection
  const VALID_FOR_TYPE: Record<number, number[]> = {
    1: [1, 2, 4, 5, 7],
    2: [1, 3, 4, 6, 7],
  };

  type FakeItem = {
    id: number;
    itemTypeID: number;
    fields: Record<string, string>;
    writes: Array<[string, string]>;
    isRegularItem: () => boolean;
    isAttachment: () => boolean;
    isNote: () => boolean;
    isAnnotation: () => boolean;
    parentID: false | number;
    getField: (
      name: string,
      unformatted?: boolean,
      baseMapped?: boolean,
    ) => string;
    setField: (name: string, value: string) => boolean;
    getDisplayTitle: () => string;
    getCreatorsJSON: () => unknown[];
    saveTx: () => Promise<boolean>;
  };

  function makeItem(itemTypeID: number, overrides: Partial<FakeItem> = {}) {
    const item: FakeItem = {
      id: 7,
      itemTypeID,
      fields: {},
      writes: [],
      parentID: false,
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
      isAnnotation: () => false,
      getField: (name, _unformatted, baseMapped) => {
        if (baseMapped && name === "publicationTitle" && itemTypeID === 2) {
          return item.fields.bookTitle || "";
        }
        return item.fields[name] || "";
      },
      setField: (name, value) => {
        item.writes.push([name, value]);
        // Mirror Zotero: a value it cannot parse is refused, not thrown.
        if (name === "accessDate" && !/^\d{4}/.test(value)) return false;
        item.fields[name] = value;
        return true;
      },
      getDisplayTitle: () => item.fields.title || "Item 7",
      getCreatorsJSON: () => [],
      saveTx: async () => true,
      ...overrides,
    };
    return item;
  }

  function installZotero(withItemFields = true) {
    (globalThis as Record<string, unknown>).Zotero = {
      Items: { get: () => null },
      debug: () => undefined,
      ItemTypes: {
        getName: (id: number) => (id === 1 ? "journalArticle" : "bookSection"),
        getID: (name: string) => (name === "journalArticle" ? 1 : 2),
        getTypes: () => [
          { id: 1, name: "journalArticle" },
          { id: 2, name: "bookSection" },
        ],
        getLocalizedString: () => "",
      },
      CreatorTypes: {
        itemTypeHasCreators: () => true,
        getTypesForItemType: () => [{ id: 1, name: "author" }],
      },
      ...(withItemFields
        ? {
            ItemFields: {
              getID: (name: string) => FIELD_IDS[name] || false,
              getName: (id: number) => NAMES[id] || "",
              isValidForType: (fieldId: number, typeId: number) =>
                (VALID_FOR_TYPE[typeId] || []).includes(fieldId),
              getFieldIDFromTypeAndBase: (typeId: number, baseId: number) => {
                // publicationTitle -> bookTitle on a book section
                if (typeId === 2 && baseId === FIELD_IDS.publicationTitle) {
                  return FIELD_IDS.bookTitle;
                }
                return baseId;
              },
              getItemTypeFields: (typeId: number) =>
                VALID_FOR_TYPE[typeId] || [],
            },
          }
        : {}),
    };
  }

  function gateway(item: FakeItem) {
    installZotero();
    const g = new ZoteroGateway();
    (g as unknown as { getItem: (id: number) => unknown }).getItem = () => item;
    return g;
  }

  afterEach(function () {
    delete (globalThis as Record<string, unknown>).Zotero;
  });

  describe("the patch normalizer, which was the real gate", function () {
    it("carries fields that were outside the 18-name allowlist", function () {
      const patch = normalizeMetadataPatch({
        numPages: "312",
        archiveLocation: "Box 4",
      });
      // Both were silently dropped before, so the write reported success
      // having changed nothing.
      assert.equal((patch as Record<string, unknown>)?.numPages, "312");
      assert.equal(
        (patch as Record<string, unknown>)?.archiveLocation,
        "Box 4",
      );
    });

    it("still keeps creators out of the field patch", function () {
      const patch = normalizeMetadataPatch({
        title: "T",
        creators: [{ lastName: "Doe", creatorType: "author" }],
      });
      assert.notProperty(patch, "creators_field");
      assert.equal((patch as Record<string, unknown>)?.title, "T");
    });
  });

  describe("validity per item type", function () {
    it("writes a base field under its type-specific name", async function () {
      const item = makeItem(2);
      await gateway(item).updateArticleMetadata({
        item: item as never,
        metadata: { publicationTitle: "The Handbook" } as never,
      });
      // setField does the base mapping itself; the guard must agree with it
      // rather than rejecting the write outright.
      assert.deepEqual(item.writes, [["publicationTitle", "The Handbook"]]);
    });

    it("reads a base field back on a type that stores it elsewhere", function () {
      const item = makeItem(2);
      item.fields.bookTitle = "The Handbook";
      const snapshot = gateway(item).getEditableArticleMetadata(item as never);
      // Without includeBaseMapped this came back empty on nine item types.
      assert.equal(snapshot?.fields.publicationTitle, "The Handbook");
    });

    it("refuses a field the type does not have, and says what it does have", async function () {
      const item = makeItem(1);
      let message = "";
      try {
        await gateway(item).updateArticleMetadata({
          item: item as never,
          metadata: { numPages: "312" } as never,
        });
        assert.fail("expected a refusal");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.include(message, "numPages");
      assert.include(message, "Fields this item type accepts");
    });

    it("refuses computed and provenance fields outright", async function () {
      const item = makeItem(1);
      for (const field of ["dateAdded", "itemType", "key"]) {
        let threw = false;
        try {
          await gateway(item).updateArticleMetadata({
            item: item as never,
            metadata: { [field]: "x" } as never,
          });
        } catch {
          threw = true;
        }
        assert.isTrue(threw, `${field} must not be patchable`);
      }
    });

    it("fails closed when the field schema is unavailable", async function () {
      const item = makeItem(1);
      installZotero(false);
      const g = new ZoteroGateway();
      (g as unknown as { getItem: (id: number) => unknown }).getItem = () =>
        item;

      let threw = false;
      try {
        await g.updateArticleMetadata({
          item: item as never,
          metadata: { title: "T" } as never,
        });
      } catch {
        threw = true;
      }
      // The old catch returned true, declaring every field valid — which
      // turned a typo into a raw throw from setField instead of a clear
      // refusal. No test defined ItemFields, so that branch never ran.
      assert.isTrue(threw);
      assert.deepEqual(item.writes, []);
    });

    it("reports failure when Zotero refuses the value", async function () {
      const item = makeItem(1);
      let message = "";
      try {
        await gateway(item).updateArticleMetadata({
          item: item as never,
          metadata: { accessDate: "yesterday" } as never,
        });
        assert.fail("expected a rejection");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      // setField returns false rather than throwing; the old code ignored
      // that and reported success.
      assert.include(message, "accessDate");
    });
  });

  describe("item type discovery", function () {
    it("lists types, and the fields of a named one", function () {
      const item = makeItem(1);
      const g = gateway(item);

      const all = g.listItemTypes();
      assert.deepEqual(
        all.itemTypes.map((t) => t.itemType),
        ["journalArticle", "bookSection"],
      );
      // Fields are withheld for a bulk listing, which would otherwise be a
      // large payload for "what types exist".
      assert.isUndefined(all.itemTypes[0].fields);

      const one = g.listItemTypes({ itemType: "bookSection" });
      assert.lengthOf(one.itemTypes, 1);
      assert.includeMembers(one.itemTypes[0].fields || [], [
        "bookTitle",
        "numPages",
      ]);
      assert.deepEqual(one.itemTypes[0].creatorTypes, ["author"]);
    });
  });
});

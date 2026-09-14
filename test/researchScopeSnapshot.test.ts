import { assert } from "chai";
import {
  assertResearchScopeTargets,
  resolveResearchScopeItemIds,
} from "../src/agent/research/scopeSnapshot";
import { decodeScopeSnapshotItem } from "../src/agent/research/decoders";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";

describe("research scope resolution", function () {
  const priorZotero = (globalThis as { Zotero?: unknown }).Zotero;

  beforeEach(function () {
    const items = new Map([
      ["AAAA1111", { id: 10, key: "AAAA1111", libraryID: 1 }],
      ["ATTACH01", { id: 20, key: "ATTACH01", libraryID: 1 }],
    ]);
    (globalThis as { Zotero?: unknown }).Zotero = {
      Items: {
        getByLibraryAndKey: (libraryID: number, itemKey: string) => {
          const item = items.get(itemKey);
          return item?.libraryID === libraryID ? item : false;
        },
      },
    };
  });

  after(function () {
    (globalThis as { Zotero?: unknown }).Zotero = priorZotero;
  });

  function gateway(resolvedItemIds: number[] = [10]): ZoteroGateway {
    return {
      listBibliographicItemTargets: async () => ({
        items: [{ itemId: 10 }, { itemId: 11 }],
      }),
      resolveLibraryScopeItemIds: async () => ({
        itemIds: resolvedItemIds,
      }),
    } as unknown as ZoteroGateway;
  }

  it("reports every missing explicit key without enumerating the library", async function () {
    for (const itemKeys of [
      ["MISSING1"],
      ["MISSING1", "MISSING2"],
      ["AAAA1111", "MISSING2"],
    ]) {
      let message = "";
      try {
        await resolveResearchScopeItemIds(gateway(), {
          libraryID: 1,
          kind: "items",
          itemKeys,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.include(message, "unresolved item keys");
      for (const key of itemKeys.filter((key) => key.startsWith("MISSING"))) {
        assert.include(message, key);
      }
    }
  });

  it("fails a zero-item explicit filter but permits legitimate whole-library scope", async function () {
    let emptyMessage = "";
    try {
      await resolveResearchScopeItemIds(gateway([10]), {
        libraryID: 1,
        kind: "items",
        itemKeys: [],
      });
    } catch (error) {
      emptyMessage = error instanceof Error ? error.message : String(error);
    }
    assert.include(emptyMessage, "requires nonempty item keys");
    let message = "";
    try {
      await resolveResearchScopeItemIds(gateway([]), {
        libraryID: 1,
        kind: "collections",
        collectionIds: [5],
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "resolved to zero items");
    assert.deepEqual(
      await resolveResearchScopeItemIds(gateway(), {
        libraryID: 1,
        kind: "library",
      }),
      [10, 11],
    );
  });

  it("rejects an explicit key that disappears during bibliographic normalization", function () {
    assert.throws(
      () =>
        assertResearchScopeTargets({
          scope: {
            libraryID: 1,
            kind: "mixed",
            itemKeys: ["AAAA1111", "ATTACH01"],
            collectionIds: [5],
          },
          targetItemIds: [10],
        }),
      /ATTACH01/,
    );
    assert.doesNotThrow(() =>
      assertResearchScopeTargets({
        scope: { libraryID: 1, kind: "items", itemKeys: ["AAAA1111"] },
        targetItemIds: [10],
      }),
    );
  });

  it("keeps frozen descriptive metadata available after a reading checkpoint", function () {
    const decoded = decodeScopeSnapshotItem({
      snapshotId: "snapshot-1",
      libraryID: 1,
      itemKey: "AAAA1111",
      localItemId: 10,
      title: "A stable title",
      firstCreator: "Author",
      year: "2024",
      ordinal: 0,
    });

    assert.equal(decoded.title, "A stable title");
    assert.equal(decoded.firstCreator, "Author");
    assert.equal(decoded.year, "2024");
  });
});

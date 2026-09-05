import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";

/**
 * The merge was hand-rolled and diverged from Zotero's own in ways that
 * damaged the library. The worst: it never wrote the `dc:replaces` relation
 * onto the survivor, and `integration.js` resolves a Word citation pointing
 * at a merged-away item *only* through that predicate. So after an agent
 * merge, the next citation refresh raised "the item could not be found in
 * your library" and the user hand-picked a replacement per citation.
 *
 * It also skipped PDF dedup by hash, note item-key remapping and the earliest
 * dateAdded, dropped tag types, and ran outside a transaction.
 */
describe("merge delegates to Zotero", function () {
  let mergeCalls: Array<{ master: unknown; others: unknown[] }>;
  let items: Map<number, Record<string, unknown>>;

  function makeItem(id: number, libraryID = 1) {
    return {
      id,
      libraryID,
      getField: (name: string) => (name === "title" ? `Item ${id}` : ""),
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
      isAnnotation: () => false,
      parentID: false,
      getDisplayTitle: () => `Item ${id}`,
    };
  }

  beforeEach(function () {
    mergeCalls = [];
    items = new Map([
      [1, makeItem(1)],
      [2, makeItem(2)],
      [3, makeItem(3)],
      [9, makeItem(9, 2)],
    ]);
    (globalThis as Record<string, unknown>).Zotero = {
      Items: {
        get: (id: number) => items.get(id) || null,
        merge: async (master: unknown, others: unknown[]) => {
          mergeCalls.push({ master, others });
        },
      },
      debug: () => undefined,
    };
  });

  afterEach(function () {
    delete (globalThis as Record<string, unknown>).Zotero;
  });

  function gateway() {
    const g = new ZoteroGateway();
    (g as unknown as { getItem: (id: number) => unknown }).getItem = (
      id: number,
    ) => items.get(id) || null;
    return g;
  }

  it("hands the merge to Zotero rather than reimplementing it", async function () {
    const result = await gateway().mergeItems({
      masterItemId: 1,
      otherItemIds: [2, 3],
    });

    assert.lengthOf(mergeCalls, 1);
    assert.equal((mergeCalls[0].master as { id: number }).id, 1);
    assert.deepEqual(
      mergeCalls[0].others.map((o) => (o as { id: number }).id),
      [2, 3],
    );
    assert.equal(result.mergedCount, 2);
    assert.deepEqual(result.trashedIds, [2, 3]);
  });

  it("never passes the master to itself", async function () {
    await gateway().mergeItems({ masterItemId: 1, otherItemIds: [1, 2] });
    assert.deepEqual(
      mergeCalls[0].others.map((o) => (o as { id: number }).id),
      [2],
    );
  });

  it("refuses a cross-library merge, which Zotero cannot do", async function () {
    let message = "";
    try {
      await gateway().mergeItems({ masterItemId: 1, otherItemIds: [9] });
      assert.fail("expected a refusal");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "different library");
    assert.lengthOf(mergeCalls, 0);
  });

  it("refuses rather than silently merging without dc:replaces", async function () {
    // If a Zotero build has no native merge, falling back to the hand-rolled
    // path would break the user's citations without telling them.
    delete (
      (globalThis as Record<string, any>).Zotero.Items as Record<
        string,
        unknown
      >
    ).merge;

    let message = "";
    try {
      await gateway().mergeItems({ masterItemId: 1, otherItemIds: [2] });
      assert.fail("expected a refusal");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "Zotero.Items.merge");
  });

  it("does nothing when there is no duplicate left to merge", async function () {
    const result = await gateway().mergeItems({
      masterItemId: 1,
      otherItemIds: [],
    });
    assert.equal(result.mergedCount, 0);
    assert.lengthOf(mergeCalls, 0);
  });
});

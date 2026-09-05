import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import { replayLibraryInverse } from "../test/helpers/replayLibraryInverse";

declare const Zotero: any;

/**
 * Every capability added in Stages 0–6, exercised against a REAL Zotero
 * library rather than a fake.
 *
 * This suite exists because a fully green unit suite has twice hidden a
 * completely non-functional capability in this project. Unit tests here use
 * hand-written stand-ins for `Zotero.Search`, `Zotero.ItemFields`,
 * `Zotero.Tags` and the rest — so they prove the code does what I *believe*
 * those APIs do. Only running against Zotero proves the belief.
 *
 * Assertions read Zotero's own database and the filesystem, never the agent's
 * prose.
 */
describe("library operations against real Zotero", function () {
  this.timeout(120000);

  const SUFFIX = `wf${Date.now()}`;
  const created = {
    items: [] as number[],
    collections: [] as number[],
    searches: [] as number[],
    tags: [] as string[],
  };

  function gateway() {
    return new ZoteroGateway();
  }

  function libraryID(): number {
    return Zotero.Libraries.userLibraryID;
  }

  async function makeCollection(name: string, parentID?: number) {
    const collection = new Zotero.Collection();
    collection.libraryID = libraryID();
    collection.name = `${name}-${SUFFIX}`;
    if (parentID) collection.parentID = parentID;
    await collection.saveTx();
    created.collections.push(collection.id);
    return collection;
  }

  async function makeItem(itemType = "journalArticle", title = "Paper") {
    const item = new Zotero.Item(itemType);
    item.libraryID = libraryID();
    item.setField("title", `${title}-${SUFFIX}`);
    await item.saveTx();
    created.items.push(item.id);
    return item;
  }

  after(async function () {
    // Leave the user's library as we found it.
    for (const id of created.searches) {
      try {
        const s = Zotero.Searches.get(id);
        if (s) await s.eraseTx();
      } catch {
        /* best effort */
      }
    }
    for (const id of created.items) {
      try {
        const item = Zotero.Items.get(id);
        if (item) await item.eraseTx();
      } catch {
        /* best effort */
      }
    }
    for (const id of created.collections) {
      try {
        const c = Zotero.Collections.get(id);
        if (c) await c.eraseTx();
      } catch {
        /* best effort */
      }
    }
    for (const tag of created.tags) {
      try {
        const tagID = Zotero.Tags.getID(tag);
        if (tagID) await Zotero.Tags.removeFromLibrary(libraryID(), [tagID]);
      } catch {
        /* best effort */
      }
    }
  });

  // ── Stage 0a/0b ───────────────────────────────────────────────────────────

  describe("collection delete is a trash, not an erase", function () {
    it("puts the collection AND its subcollections in deletedCollections", async function () {
      const parent = await makeCollection("Trash-Parent");
      const child = await makeCollection("Trash-Child", parent.id);

      await gateway().deleteCollection({ collectionId: parent.id });

      // The row must still exist -- eraseTx would have removed it entirely.
      const stillThere = await Zotero.DB.valueQueryAsync(
        "SELECT COUNT(*) FROM collections WHERE collectionID=?",
        [parent.id],
      );
      assert.equal(
        Number(stillThere),
        1,
        "the collection must survive a delete",
      );

      const trashed = await Zotero.DB.columnQueryAsync(
        `SELECT collectionID FROM deletedCollections WHERE collectionID IN (?, ?)`,
        [parent.id, child.id],
      );
      const trashedIds = (trashed || []).map(Number);
      assert.include(trashedIds, parent.id, "parent must be in the trash");
      assert.include(trashedIds, child.id, "subcollections travel with it");
    });

    it("restores the original collection id, not a rebuilt lookalike", async function () {
      const parent = await makeCollection("Restore-Parent");
      const child = await makeCollection("Restore-Child", parent.id);
      const g = gateway();

      await g.deleteCollection({ collectionId: parent.id });
      const result = await g.restoreCollections({ collectionIds: [parent.id] });
      assert.isAtLeast(result.restoredCount, 1);

      const remaining = await Zotero.DB.columnQueryAsync(
        `SELECT collectionID FROM deletedCollections WHERE collectionID IN (?, ?)`,
        [parent.id, child.id],
      );
      assert.lengthOf(
        remaining || [],
        0,
        "parent and descendants both come back",
      );
      // The old undo rebuilt the collection, minting a new id and stranding
      // everything that referenced the old one.
      assert.isOk(Zotero.Collections.get(parent.id));
    });

    it("leaves items in the library unless asked to take them", async function () {
      const collection = await makeCollection("Keep-Items");
      const item = await makeItem();
      item.addToCollection(collection.id);
      await item.saveTx();

      await gateway().deleteCollection({ collectionId: collection.id });

      const fresh = Zotero.Items.get(item.id);
      assert.isFalse(Boolean(fresh.deleted), "items stay out of the trash");
    });
  });

  // ── Stage 5: collection rename / move ─────────────────────────────────────

  describe("collections are renameable and movable", function () {
    it("renames in place, keeping the id items reference", async function () {
      const collection = await makeCollection("Rename-Me");
      const originalId = collection.id;

      const result = await gateway().updateCollection({
        collectionId: originalId,
        name: `Renamed-${SUFFIX}`,
      });

      assert.equal(result.status, "updated");
      assert.equal(result.collectionId, originalId);
      assert.equal(
        Zotero.Collections.get(originalId).name,
        `Renamed-${SUFFIX}`,
      );
    });

    it("moves under a new parent and back to the top level", async function () {
      const a = await makeCollection("Move-A");
      const b = await makeCollection("Move-B");
      const g = gateway();

      await g.updateCollection({
        collectionId: b.id,
        parentCollectionId: a.id,
      });
      assert.equal(Zotero.Collections.get(b.id).parentID, a.id);

      await g.updateCollection({
        collectionId: b.id,
        parentCollectionId: null,
      });
      assert.isNotOk(Zotero.Collections.get(b.id).parentID);
    });

    it("refuses a move that would detach the subtree from the library", async function () {
      const parent = await makeCollection("Cycle-Parent");
      const child = await makeCollection("Cycle-Child", parent.id);

      const result = await gateway().updateCollection({
        collectionId: parent.id,
        parentCollectionId: child.id,
      });

      assert.notEqual(result.status, "updated");
      assert.equal(Zotero.Collections.get(parent.id).parentID, false);
    });
  });

  // ── Stage 0g: true move ───────────────────────────────────────────────────

  describe("moving items between collections", function () {
    it("adds without removing, by default", async function () {
      const from = await makeCollection("Add-From");
      const to = await makeCollection("Add-To");
      const item = await makeItem();
      item.addToCollection(from.id);
      await item.saveTx();

      await gateway().addItemsToCollections({
        assignments: [{ itemId: item.id, targetCollectionId: to.id }],
      });

      const rows = await Zotero.DB.columnQueryAsync(
        "SELECT collectionID FROM collectionItems WHERE itemID=?",
        [item.id],
      );
      assert.sameMembers((rows || []).map(Number), [from.id, to.id]);
    });

    it("actually removes the source when mode is move", async function () {
      const from = await makeCollection("Move-From");
      const to = await makeCollection("Move-To");
      const item = await makeItem();
      item.addToCollection(from.id);
      await item.saveTx();

      await gateway().addItemsToCollections({
        assignments: [{ itemId: item.id, targetCollectionId: to.id }],
        mode: "move",
        from: from.id,
      });

      const rows = await Zotero.DB.columnQueryAsync(
        "SELECT collectionID FROM collectionItems WHERE itemID=?",
        [item.id],
      );
      // The whole point: "move" used to leave the item in both.
      assert.sameMembers((rows || []).map(Number), [to.id]);
    });

    it("keeps every destination when one item has several in one call", async function () {
      const from = await makeCollection("Multi-From");
      const d1 = await makeCollection("Multi-D1");
      const d2 = await makeCollection("Multi-D2");
      const item = await makeItem();
      item.addToCollection(from.id);
      await item.saveTx();

      await gateway().addItemsToCollections({
        assignments: [
          { itemId: item.id, targetCollectionId: d1.id },
          { itemId: item.id, targetCollectionId: d2.id },
        ],
        mode: "move",
        from: "all",
      });

      const rows = await Zotero.DB.columnQueryAsync(
        "SELECT collectionID FROM collectionItems WHERE itemID=?",
        [item.id],
      );
      // Pairwise handling would let the second assignment undo the first.
      assert.sameMembers((rows || []).map(Number), [d1.id, d2.id]);
    });

    it("restores the exact prior membership on undo", async function () {
      const a = await makeCollection("Undo-A");
      const b = await makeCollection("Undo-B");
      const dest = await makeCollection("Undo-Dest");
      const item = await makeItem();
      item.addToCollection(a.id);
      item.addToCollection(b.id);
      await item.saveTx();

      const service = new LibraryMutationService(gateway());
      const context = {
        request: { conversationKey: 1, libraryID: libraryID() },
      } as never;
      const outcome = await service.executeOperation(
        {
          type: "move_to_collection",
          itemIds: [item.id],
          targetCollectionId: dest.id,
          mode: "move",
          from: "all",
        },
        context,
      );

      await replayLibraryInverse(service, outcome, context);
      const rows = await Zotero.DB.columnQueryAsync(
        "SELECT collectionID FROM collectionItems WHERE itemID=?",
        [item.id],
      );
      // The old inverse emitted remove_from_collection, which would have
      // unfiled the item entirely instead of restoring a and b.
      assert.sameMembers((rows || []).map(Number), [a.id, b.id]);
    });
  });

  // ── Stage 1: the search vocabulary ────────────────────────────────────────

  describe("advanced search conditions", function () {
    it("returns the same ids as a raw Zotero.Search", async function () {
      const item = await makeItem("journalArticle", "ConditionProbe");

      const raw = new Zotero.Search({ libraryID: libraryID() });
      raw.addCondition("title", "contains", `ConditionProbe-${SUFFIX}`);
      const rawIds: number[] = await raw.search();

      const viaTool = await gateway().searchItemsByConditions({
        libraryID: libraryID(),
        conditions: [
          {
            condition: "title",
            operator: "contains",
            value: `ConditionProbe-${SUFFIX}`,
          },
        ],
      });

      assert.include(rawIds.map(Number), item.id);
      assert.sameMembers(
        viaTool.items.map((entry) => entry.itemId),
        rawIds.map(Number),
      );
    });

    it("rejects a bad operator with the ones that condition accepts", async function () {
      let message = "";
      try {
        await gateway().searchItemsByConditions({
          libraryID: libraryID(),
          // The exact pairing that silently broke every year-filtered search.
          conditions: [
            { condition: "year", operator: "isGreaterThan", value: "2020" },
          ],
        });
      } catch (error) {
        message = String((error as Error)?.message || error);
      }
      assert.include(message, "Valid operators");
    });

    it("lists the trash, which nothing could enumerate before", async function () {
      const item = await makeItem("journalArticle", "TrashProbe");
      item.deleted = true;
      await item.saveTx();

      const result = await gateway().listItemsByFilters({
        libraryID: libraryID(),
        filters: { deleted: true },
      });
      assert.include(
        result.items.map((entry) => entry.itemId),
        item.id,
        "a trashed item must be reachable, or restore is unusable",
      );
    });
  });

  // ── Stage 0f: the year-filter regression ──────────────────────────────────

  describe("a text search combined with a year filter", function () {
    it("returns matches instead of always reporting none", async function () {
      const item = await makeItem("journalArticle", "YearProbe");
      item.setField("date", "2021-05-01");
      await item.saveTx();

      const result = await gateway().searchAllLibraryItems({
        libraryID: libraryID(),
        query: `YearProbe-${SUFFIX}`,
        filters: { yearFrom: 2020, yearTo: 2023 },
      });

      // Before the fix this was ALWAYS zero, on every library.
      assert.isAtLeast(result.totalCount, 1);
      assert.include(
        result.items.map((entry) => entry.itemId),
        item.id,
      );
    });

    it("still excludes items outside the range", async function () {
      const item = await makeItem("journalArticle", "OldProbe");
      item.setField("date", "1999-01-01");
      await item.saveTx();

      const result = await gateway().searchAllLibraryItems({
        libraryID: libraryID(),
        query: `OldProbe-${SUFFIX}`,
        filters: { yearFrom: 2020 },
      });
      assert.notInclude(
        result.items.map((entry) => entry.itemId),
        item.id,
      );
    });
  });

  // ── Stage 2: metadata beyond the allowlist ────────────────────────────────

  describe("metadata fields", function () {
    it("writes a base field under its type-specific name", async function () {
      const item = await makeItem("bookSection", "BookSection");

      await gateway().updateArticleMetadata({
        item,
        metadata: { publicationTitle: `Handbook-${SUFFIX}` } as never,
      });

      const fresh = Zotero.Items.get(item.id);
      // publicationTitle is stored as bookTitle on a bookSection. The old
      // guard called this invalid; setField maps it happily.
      assert.equal(fresh.getField("bookTitle"), `Handbook-${SUFFIX}`);
    });

    it("reads that base field back rather than returning empty", async function () {
      const item = await makeItem("bookSection", "ReadBack");
      item.setField("bookTitle", `ReadBackHandbook-${SUFFIX}`);
      await item.saveTx();

      const snapshot = gateway().getEditableArticleMetadata(item);
      assert.equal(
        snapshot?.fields.publicationTitle,
        `ReadBackHandbook-${SUFFIX}`,
      );
    });

    it("writes a field that was outside the old 18-name allowlist", async function () {
      const item = await makeItem("book", "PageCount");

      await gateway().updateArticleMetadata({
        item,
        metadata: { numPages: "312" } as never,
      });

      assert.equal(Zotero.Items.get(item.id).getField("numPages"), "312");
    });

    it("refuses a field the type does not have, naming what it accepts", async function () {
      const item = await makeItem("journalArticle", "BadField");
      let message = "";
      try {
        await gateway().updateArticleMetadata({
          item,
          metadata: { numPages: "312" } as never,
        });
      } catch (error) {
        message = String((error as Error)?.message || error);
      }
      assert.include(message, "numPages");
      assert.include(message, "Fields this item type accepts");
    });

    it("lists the real field set for an item type", function () {
      const result = gateway().listItemTypes({ itemType: "thesis" });
      assert.lengthOf(result.itemTypes, 1);
      assert.includeMembers(result.itemTypes[0].fields || [], [
        "title",
        "university",
      ]);
    });
  });

  // ── Stage 2e: create / reparent / relate ──────────────────────────────────

  describe("creating and restructuring items", function () {
    it("creates an item of a type the agent could not produce before", async function () {
      const result = await gateway().createItems({
        libraryID: libraryID(),
        items: [
          {
            itemType: "thesis",
            fields: { title: `Thesis-${SUFFIX}`, university: "Test U" },
            tags: [`wf-tag-${SUFFIX}`],
          },
        ],
      });

      assert.equal(result.createdCount, 1);
      const itemId = result.items[0].itemId as number;
      created.items.push(itemId);
      created.tags.push(`wf-tag-${SUFFIX}`);

      const item = Zotero.Items.get(itemId);
      assert.equal(Zotero.ItemTypes.getName(item.itemTypeID), "thesis");
      assert.equal(item.getField("university"), "Test U");
    });

    it("moves a note onto a paper and detaches it again", async function () {
      const paper = await makeItem();
      const note = new Zotero.Item("note");
      note.libraryID = libraryID();
      note.setNote("<p>workflow note</p>");
      await note.saveTx();
      created.items.push(note.id);

      const g = gateway();
      await g.reparentItems({
        assignments: [{ itemId: note.id, parentItemId: paper.id }],
      });
      assert.equal(Zotero.Items.get(note.id).parentID, paper.id);

      await g.reparentItems({
        assignments: [{ itemId: note.id, parentItemId: null }],
      });
      assert.isNotOk(Zotero.Items.get(note.id).parentID);
    });

    it("relates two items on both sides", async function () {
      const a = await makeItem("journalArticle", "RelA");
      const b = await makeItem("journalArticle", "RelB");

      await gateway().relateItems({
        itemId: a.id,
        relatedItemIds: [b.id],
        action: "add",
      });

      const freshA = Zotero.Items.get(a.id);
      const freshB = Zotero.Items.get(b.id);
      // Zotero relations are bidirectional; writing one side leaves the pair
      // inconsistent.
      assert.include(freshA.relatedItems, freshB.key);
      assert.include(freshB.relatedItems, freshA.key);
    });
  });

  // ── Stage 5: tags as objects ──────────────────────────────────────────────

  describe("tags as library objects", function () {
    it("renames a tag everywhere it is used, in one call", async function () {
      const oldTag = `old-tag-${SUFFIX}`;
      const newTag = `new-tag-${SUFFIX}`;
      created.tags.push(oldTag, newTag);

      const one = await makeItem("journalArticle", "TagOne");
      const two = await makeItem("journalArticle", "TagTwo");
      for (const item of [one, two]) {
        item.addTag(oldTag);
        await item.saveTx();
      }

      const result = await gateway().updateLibraryTag({
        libraryID: libraryID(),
        action: "rename",
        tag: oldTag,
        newTag,
      });
      assert.equal(result.status, "applied");

      for (const item of [one, two]) {
        const tags = Zotero.Items.get(item.id)
          .getTags()
          .map((entry: { tag: string }) => entry.tag);
        assert.include(tags, newTag);
        assert.notInclude(tags, oldTag);
      }
      assert.isNotOk(Zotero.Tags.getID(oldTag), "the old tag is gone");
    });

    it("replaces an item's whole tag set rather than adding to it", async function () {
      const keep = `set-keep-${SUFFIX}`;
      const drop = `set-drop-${SUFFIX}`;
      created.tags.push(keep, drop);

      const item = await makeItem("journalArticle", "TagSet");
      item.addTag(drop);
      await item.saveTx();

      await gateway().setItemTags({
        assignments: [{ itemId: item.id, tags: [keep] }],
      });

      const tags = Zotero.Items.get(item.id)
        .getTags()
        .map((entry: { tag: string }) => entry.tag);
      // Add-only assignment is why "exactly these 20 tags" drifted.
      assert.deepEqual(tags, [keep]);
    });
  });

  // ── Stage 5: saved searches ───────────────────────────────────────────────

  describe("saved searches", function () {
    it("creates one that Zotero can run", async function () {
      const item = await makeItem("journalArticle", "SavedProbe");

      const saved = await gateway().saveSavedSearch({
        libraryID: libraryID(),
        name: `Saved-${SUFFIX}`,
        conditions: [
          {
            condition: "title",
            operator: "contains",
            value: `SavedProbe-${SUFFIX}`,
          },
        ],
      });
      created.searches.push(saved.savedSearchId);
      assert.equal(saved.status, "created");

      const conditionRows = await Zotero.DB.valueQueryAsync(
        "SELECT COUNT(*) FROM savedSearchConditions WHERE savedSearchID=?",
        [saved.savedSearchId],
      );
      assert.isAtLeast(Number(conditionRows), 1, "conditions must persist");

      // Running it must find the item, or the saved search is decoration.
      const search = Zotero.Searches.get(saved.savedSearchId);
      const ids: number[] = await search.search();
      assert.include(ids.map(Number), item.id);
    });

    it("lists saved searches with their conditions", function () {
      const listed = gateway().listSavedSearches(libraryID());
      const mine = listed.find((entry) => entry.name === `Saved-${SUFFIX}`);
      assert.isOk(mine, "the saved search must be discoverable");
      assert.isAtLeast(mine?.conditions.length || 0, 1);
    });
  });

  // ── Stage 6: real citations ───────────────────────────────────────────────

  describe("citations through Zotero's own CSL engine", function () {
    it("formats a bibliography entry containing the real author and year", async function () {
      const item = await makeItem("journalArticle", "CiteProbe");
      item.setCreators([
        { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
      ]);
      item.setField("date", "1843");
      item.setField("publicationTitle", "Notes");
      await item.saveTx();

      const result = gateway().formatBibliography({ itemIds: [item.id] });

      // The whole point: this comes from Zotero, not from the model's memory.
      assert.include(result.output, "Lovelace");
      assert.include(result.output, "1843");
      assert.isOk(result.styleTitle);
    });

    it("refuses an uninstalled style rather than approximating it", function () {
      assert.throws(
        () =>
          gateway().formatBibliography({
            itemIds: created.items.slice(0, 1),
            styleId: "http://example.com/styles/not-real",
          }),
        /not installed/,
      );
    });

    it("lists the installed styles", function () {
      const styles = gateway().listCitationStyles();
      assert.isAtLeast(styles.length, 1);
      assert.isOk(styles[0].id);
    });
  });

  // ── Stage 6: settings ─────────────────────────────────────────────────────

  describe("preferences", function () {
    it("reads and writes an allowlisted preference", async function () {
      const g = gateway();
      const before = Zotero.Prefs.get("recursiveCollections");
      try {
        const result = await g.updateSetting({
          key: "recursiveCollections",
          value: !before,
        });
        assert.equal(result.status, "updated");
        assert.equal(Zotero.Prefs.get("recursiveCollections"), !before);
      } finally {
        Zotero.Prefs.set("recursiveCollections", before);
      }
    });

    it("refuses anything outside the allowlist", async function () {
      const result = await gateway().updateSetting({
        key: "sync.storage.password",
        value: "nope",
      });
      // Zotero.Prefs also holds sync credentials and the data directory.
      assert.equal(result.status, "refused");
    });
  });
});

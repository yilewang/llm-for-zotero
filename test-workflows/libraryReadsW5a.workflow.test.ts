import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  getOrCreateZoteroMcpBearerToken,
  ZOTERO_MCP_ENDPOINT_PATH,
} from "../src/agent/mcp/server";

declare const Zotero: any;
declare const IOUtils: any;
declare const PathUtils: any;

/**
 * W5-A reads against a REAL Zotero library: statistics, tag counts, sort
 * keys, Related links and reader navigation. Every expectation comes from
 * Zotero's own database (SQL) or the reader's own state, never from the
 * tool's output.
 */
describe("W5-A library reads against real Zotero", function () {
  this.timeout(180000);

  const SUFFIX = `w5a${Date.now()}`;
  const created = {
    items: [] as number[],
    collections: [] as number[],
    tags: [] as string[],
  };

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

  async function makeItem(
    itemType: string,
    title: string,
    fields: { date?: string; tags?: string[]; collections?: number[] } = {},
  ) {
    const item = new Zotero.Item(itemType);
    item.libraryID = libraryID();
    item.setField("title", `${title}-${SUFFIX}`);
    if (fields.date) item.setField("date", fields.date);
    for (const tag of fields.tags || []) {
      item.addTag(tag);
      created.tags.push(tag);
    }
    for (const collectionId of fields.collections || []) {
      item.addToCollection(collectionId);
    }
    await item.saveTx();
    created.items.push(item.id);
    return item;
  }

  async function makePdf(pages = 3): Promise<string> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let index = 0; index < pages; index += 1) {
      pdf.addPage([612, 792]).drawText(`Page ${index + 1} of ${SUFFIX}.`, {
        x: 72,
        y: 700,
        size: 12,
        font,
      });
    }
    const path = PathUtils.join(
      Zotero.getTempDirectory().path,
      `w5a-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`,
    );
    await IOUtils.write(path, await pdf.save());
    return path;
  }

  async function attachPdf(parentItemID: number, pages = 3) {
    const path = await makePdf(pages);
    const attachment = await Zotero.Attachments.importFromFile({
      file: path,
      parentItemID,
    });
    await IOUtils.remove(path, { ignoreAbsent: true });
    created.items.push(attachment.id);
    return attachment;
  }

  /** A PDF with no parent item, optionally filed in collections. */
  async function attachStandalonePdf(collections: number[] = [], pages = 2) {
    const path = await makePdf(pages);
    const attachment = await Zotero.Attachments.importFromFile({
      file: path,
      collections,
    });
    await IOUtils.remove(path, { ignoreAbsent: true });
    created.items.push(attachment.id);
    return attachment;
  }

  /** An HTML snapshot under a parent item. */
  async function attachSnapshot(parentItemID: number) {
    const path = PathUtils.join(
      Zotero.getTempDirectory().path,
      `w5a-${Date.now()}-${Math.random().toString(36).slice(2)}.html`,
    );
    await IOUtils.writeUTF8(
      path,
      `<html><head><title>Snapshot ${SUFFIX}</title></head><body><p>Page text.</p></body></html>`,
    );
    const attachment = await Zotero.Attachments.importFromFile({
      file: path,
      parentItemID,
      contentType: "text/html",
    });
    await IOUtils.remove(path, { ignoreAbsent: true });
    created.items.push(attachment.id);
    return attachment;
  }

  async function annotate(
    attachmentId: number,
    type: "highlight" | "note",
    pageIndex: number,
    html = false,
  ) {
    const annotation = new Zotero.Item("annotation");
    annotation.libraryID = libraryID();
    annotation.parentID = attachmentId;
    annotation.annotationType = type;
    if (type === "highlight") annotation.annotationText = "Page text.";
    annotation.annotationColor = "#ffd400";
    annotation.annotationPageLabel = String(pageIndex + 1);
    if (html) {
      // A snapshot annotation is placed by a selector, not a page.
      annotation.annotationSortIndex = "00000000";
      annotation.annotationPosition = JSON.stringify({
        type: "CssSelector",
        value: "p",
      });
    } else {
      annotation.annotationSortIndex = `${String(pageIndex).padStart(5, "0")}|000000|00080`;
      annotation.annotationPosition = JSON.stringify({
        pageIndex,
        rects: [[72, 698, 230, 712]],
      });
    }
    await annotation.saveTx();
    created.items.push(annotation.id);
    return annotation;
  }

  function tool(name: string) {
    return Zotero.LLMForZotero.api.agent.getToolDefinition(name);
  }

  async function call(name: string, args: Record<string, unknown>) {
    const definition = tool(name);
    const parsed = definition.validate({ libraryID: libraryID(), ...args });
    assert.isTrue(parsed.ok, JSON.stringify(parsed));
    return (await definition.execute(parsed.value, {
      request: {
        conversationKey: 1,
        libraryID: libraryID(),
        mode: "agent",
        userText: "W5-A reads",
      },
      item: null,
      modelName: "workflow",
      currentAnswerText: "",
    } as never)) as any;
  }

  async function mcp(method: string, params: Record<string, unknown>) {
    const EndpointClass = Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH];
    const [status, , body] = await new EndpointClass().init({
      method: "POST",
      headers: {
        Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
      },
      data: { jsonrpc: "2.0", id: 1, method, params },
    });
    assert.equal(status, 200);
    return JSON.parse(body).result;
  }

  async function rows(sql: string, params: unknown[] = []) {
    return (await Zotero.DB.queryAsync(sql, params)) || [];
  }

  async function ids(sql: string, params: unknown[] = []): Promise<number[]> {
    return ((await Zotero.DB.columnQueryAsync(sql, params)) || []).map(Number);
  }

  before(function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
  });

  after(async function () {
    for (const reader of [...(Zotero.Reader._readers || [])]) {
      if (created.items.includes(reader.itemID)) await reader.close?.();
    }
    for (const id of [...created.items].reverse()) {
      try {
        const item = Zotero.Items.get(id);
        if (item) await item.eraseTx();
      } catch {
        /* best effort */
      }
    }
    for (const id of [...created.collections].reverse()) {
      try {
        const collection = Zotero.Collections.get(id);
        if (collection) await collection.eraseTx();
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

  describe("library_search entity:'statistics'", function () {
    let collection: any;
    let subcollection: any;
    const tagA = `st-a-${SUFFIX}`;
    const tagB = `st-b-${SUFFIX}`;

    /** Items the statistics count: top-level, live, not a standalone file. */
    const COUNTED = `
      i.libraryID = ?
      AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
      AND (
        it.typeName NOT IN ('attachment', 'annotation', 'note')
        OR (it.typeName = 'note'
            AND i.itemID IN (SELECT itemID FROM itemNotes WHERE parentItemID IS NULL))
      )`;

    before(async function () {
      collection = await makeCollection("Stats");
      subcollection = await makeCollection("Stats-Sub", collection.id);
      const first = await makeItem("journalArticle", "Stats one", {
        date: "2001",
        tags: [tagA],
        collections: [collection.id],
      });
      await makeItem("journalArticle", "Stats two", {
        date: "2001",
        tags: [tagA],
        collections: [collection.id],
      });
      await makeItem("book", "Stats three", {
        date: "2005",
        tags: [tagB],
        collections: [subcollection.id],
      });
      const note = new Zotero.Item("note");
      note.libraryID = libraryID();
      note.setNote(`<p>Stats note ${SUFFIX}</p>`);
      note.addTag(tagA);
      note.addToCollection(collection.id);
      await note.saveTx();
      created.items.push(note.id);
      const trashed = await makeItem("journalArticle", "Stats trashed", {
        date: "2009",
        tags: [tagA],
        collections: [collection.id],
      });
      trashed.deleted = true;
      await trashed.saveTx();
      const attachment = await attachPdf(first.id);
      await annotate(attachment.id, "highlight", 0);
      await annotate(attachment.id, "highlight", 1);
      await annotate(attachment.id, "note", 2);
      // Annotations also sit on a PDF with no parent item and on a snapshot.
      const standalone = await attachStandalonePdf([collection.id]);
      await annotate(standalone.id, "highlight", 0);
      const snapshot = await attachSnapshot(first.id);
      await annotate(snapshot.id, "note", 0, true);
    });

    /** Annotations on live attachments, child or top-level, of any file type. */
    const ANNOTATED = `
      FROM itemAnnotations ia
      JOIN items ai ON ai.itemID = ia.itemID
      JOIN itemAttachments att ON att.itemID = ia.parentItemID
      WHERE ai.libraryID = ?
        AND ai.itemID NOT IN (SELECT itemID FROM deletedItems)
        AND att.itemID NOT IN (SELECT itemID FROM deletedItems)
        AND (att.parentItemID IS NULL
             OR att.parentItemID NOT IN (SELECT itemID FROM deletedItems))`;

    it("counts item types, years, tags and annotations the way Zotero's database does", async function () {
      const result = await call("library_search", {
        entity: "statistics",
        mode: "list",
        limit: 500,
      });
      const stats = result.statistics;

      const typeRows = await rows(
        `SELECT it.typeName AS typeName, COUNT(*) AS n FROM items i
         JOIN itemTypes it USING (itemTypeID) WHERE ${COUNTED}
         GROUP BY it.typeName`,
        [libraryID()],
      );
      const nativeTypes: Record<string, number> = {};
      for (const row of typeRows) nativeTypes[row.typeName] = Number(row.n);
      assert.deepEqual(stats.itemTypes, nativeTypes);
      assert.isAtLeast(nativeTypes.journalArticle, 2);
      assert.equal(nativeTypes.note >= 1, true);

      const yearRows = await rows(
        `SELECT substr(v.value, 1, 4) AS y, COUNT(*) AS n FROM items i
         JOIN itemTypes it USING (itemTypeID)
         JOIN itemData d ON d.itemID = i.itemID
         JOIN itemDataValues v ON v.valueID = d.valueID
         WHERE ${COUNTED} AND it.typeName != 'note'
           AND d.fieldID = (SELECT fieldID FROM fields WHERE fieldName = 'date')
         GROUP BY y`,
        [libraryID()],
      );
      const nativeYears: Record<string, number> = {};
      for (const row of yearRows) nativeYears[row.y] = Number(row.n);
      const reportedYears: Record<string, number> = {};
      for (const row of stats.yearDistribution) {
        reportedYears[row.year] = row.count;
      }
      assert.deepEqual(reportedYears, nativeYears);
      assert.equal(nativeYears["2001"], 2);

      // Tag statistics cover papers; a standalone note's tags are not part
      // of them, so the note holding tagA is left out of its count.
      for (const [tag, expected] of [
        [tagA, 2],
        [tagB, 1],
      ] as const) {
        const [native] = await rows(
          `SELECT COUNT(DISTINCT i.itemID) AS n FROM items i
           JOIN itemTypes it USING (itemTypeID)
           JOIN itemTags tg ON tg.itemID = i.itemID
           JOIN tags t ON t.tagID = tg.tagID
           WHERE ${COUNTED} AND it.typeName != 'note' AND t.name = ?`,
          [libraryID(), tag],
        );
        assert.equal(Number(native.n), expected, `native count of ${tag}`);
        const reported = stats.tags.topTags.find(
          (entry: { name: string }) => entry.name === tag,
        );
        assert.equal(reported?.count, expected, `reported count of ${tag}`);
      }

      const annotationRows = await rows(
        `SELECT ia.type AS type, COUNT(*) AS n ${ANNOTATED} GROUP BY ia.type`,
        [libraryID()],
      );
      // The fixture's file types, so the count below cannot pass by being
      // PDF-only or parent-only.
      const fileKinds = await rows(
        `SELECT att.contentType AS contentType,
                (att.parentItemID IS NULL) AS standalone, COUNT(*) AS n
         ${ANNOTATED} GROUP BY att.contentType, standalone`,
        [libraryID()],
      );
      assert.isTrue(
        fileKinds.some(
          (row: any) =>
            row.contentType === "application/pdf" && Number(row.standalone),
        ),
        "an annotated PDF with no parent item is in the fixture",
      );
      assert.isTrue(
        fileKinds.some((row: any) => row.contentType === "text/html"),
        "an annotated snapshot is in the fixture",
      );
      const typeNames = [
        "",
        "highlight",
        "note",
        "image",
        "ink",
        "underline",
        "text",
      ];
      const nativeAnnotations: Record<string, number> = {};
      for (const row of annotationRows) {
        nativeAnnotations[typeNames[Number(row.type)]] = Number(row.n);
      }
      assert.isAtLeast(nativeAnnotations.highlight, 3);
      assert.deepEqual(stats.annotations.annotationsByType, nativeAnnotations);
      assert.equal(
        stats.annotations.totalAnnotations,
        Object.values(nativeAnnotations).reduce((sum, n) => sum + n, 0),
      );
      assert.isAbove(stats.annotations.totalAnnotations, 0);
    });

    it("scopes to a collection's direct members, not its subcollections, and says so", async function () {
      const result = await call("library_search", {
        entity: "statistics",
        mode: "list",
        sections: ["itemTypes", "tags"],
        filters: { collectionId: collection.id },
      });
      const stats = result.statistics;
      const direct = await ids(
        `SELECT i.itemID FROM collectionItems ci
         JOIN items i ON i.itemID = ci.itemID
         JOIN itemTypes it USING (itemTypeID)
         WHERE ci.collectionID = ? AND ${COUNTED}`,
        [collection.id, libraryID()],
      );
      // One paper, one second paper and one note; the trashed paper and the
      // book in the subcollection are not counted.
      assert.lengthOf(direct, 3);
      assert.equal(stats.totalItems, direct.length);
      assert.deepEqual(stats.itemTypes, { journalArticle: 2, note: 1 });
      assert.include(stats.scopeDescription, "direct members");
      assert.isUndefined(stats.yearDistribution, "only the named sections");

      // Annotations in the collection: the paper's PDF and snapshot and the
      // collection's own parentless PDF.
      const scopedAnnotations = await call("library_search", {
        entity: "statistics",
        mode: "list",
        sections: ["annotations"],
        filters: { collectionId: collection.id },
      });
      const [nativeScoped] = await rows(
        `SELECT COUNT(*) AS n ${ANNOTATED}
         AND COALESCE(att.parentItemID, att.itemID) IN
           (SELECT itemID FROM collectionItems WHERE collectionID = ?)`,
        [libraryID(), collection.id],
      );
      assert.equal(Number(nativeScoped.n), 5);
      assert.equal(
        scopedAnnotations.statistics.annotations.totalAnnotations,
        Number(nativeScoped.n),
      );
      assert.isUndefined(
        stats.tags.topTags.find((e: { name: string }) => e.name === tagB),
        "the subcollection's tag is outside the scope",
      );
    });

    it("is reachable over MCP through the same tool", async function () {
      const listing = await mcp("tools/list", {});
      const search = listing.tools.find(
        (entry: { name: string }) => entry.name === "library_search",
      );
      assert.include(
        search.inputSchema.properties.entity.enum,
        "statistics",
        "the MCP schema offers the new entity",
      );
      const response = await mcp("tools/call", {
        name: "library_search",
        arguments: {
          entity: "statistics",
          mode: "list",
          sections: ["itemTypes"],
          filters: { collectionId: collection.id },
        },
      });
      const payload = JSON.parse(response.content[0].text);
      assert.equal(payload.ok, true);
      assert.equal(payload.result.statistics.totalItems, 3);
    });
  });

  describe("library_read relatedLinks", function () {
    it("returns both sides of a native relation, flags a trashed item and skips a link whose item is gone", async function () {
      const a = await makeItem("journalArticle", "Related A");
      const b = await makeItem("journalArticle", "Related B");
      const trashedRelated = await makeItem("journalArticle", "Related C");
      a.addRelatedItem(b);
      a.addRelatedItem(trashedRelated);
      await a.saveTx();
      trashedRelated.deleted = true;
      await trashedRelated.saveTx();
      b.addRelatedItem(a);
      await b.saveTx();
      const dangling = `${Zotero.URI.getLibraryURI(libraryID())}/items/ZZZZZZZZ`;
      a.addRelation(Zotero.Relations.relatedItemPredicate, dangling);
      await a.saveTx();

      // Native readback: each item records the other's key.
      assert.include(Zotero.Items.get(a.id).relatedItems, b.key);
      assert.include(Zotero.Items.get(b.id).relatedItems, a.key);

      const read = await call("library_read", {
        itemIds: [a.id, b.id],
        sections: ["relatedLinks"],
      });
      assert.isTrue(
        (
          await rows("SELECT 1 FROM deletedItems WHERE itemID = ?", [
            trashedRelated.id,
          ])
        ).length === 1,
        "the third item is in Zotero's trash",
      );
      const linksOfA = [...read.results[String(a.id)].relatedLinks].sort(
        (x: any, y: any) => x.itemId - y.itemId,
      );
      assert.deepEqual(
        linksOfA,
        [
          { itemId: b.id, key: b.key, title: b.getField("title") },
          {
            itemId: trashedRelated.id,
            key: trashedRelated.key,
            title: trashedRelated.getField("title"),
            deleted: true,
          },
        ].sort((x, y) => x.itemId - y.itemId),
      );
      assert.deepEqual(read.results[String(b.id)].relatedLinks, [
        { itemId: a.id, key: a.key, title: a.getField("title") },
      ]);

      const without = await call("library_read", {
        itemIds: [a.id],
        sections: ["collections"],
      });
      assert.isUndefined(without.results[String(a.id)].relatedLinks);

      const listing = await mcp("tools/list", {});
      const reader = listing.tools.find(
        (entry: { name: string }) => entry.name === "library_read",
      );
      assert.include(
        reader.inputSchema.properties.sections.items.enum,
        "relatedLinks",
      );
    });
  });

  describe("tag counts", function () {
    it("counts non-trashed top-level items per tag, the same as listing the items by that tag, in the library and in a collection", async function () {
      const tagA = `cnt-a-${SUFFIX}`;
      const tagB = `cnt-b-${SUFFIX}`;
      const tagC = `cnt-c-${SUFFIX}`;
      const collection = await makeCollection("TagCounts");
      const one = await makeItem("journalArticle", "Count one", {
        tags: [tagA, tagB],
        collections: [collection.id],
      });
      await makeItem("journalArticle", "Count two", {
        tags: [tagA],
        collections: [collection.id],
      });
      const trashed = await makeItem("journalArticle", "Count trashed", {
        tags: [tagA, tagC],
      });
      trashed.deleted = true;
      await trashed.saveTx();
      // A child note, a child attachment and annotations hold the tag too.
      // None of them is a top-level item, so none is counted.
      const child = new Zotero.Item("note");
      child.libraryID = libraryID();
      child.parentID = one.id;
      child.setNote(`<p>child ${SUFFIX}</p>`);
      child.addTag(tagA);
      await child.saveTx();
      created.items.push(child.id);
      const pdf = await attachPdf(one.id, 2);
      pdf.addTag(tagA);
      await pdf.saveTx();
      for (let page = 0; page < 3; page += 1) {
        const annotation = await annotate(pdf.id, "highlight", page % 2);
        annotation.addTag(tagA);
        await annotation.saveTx();
      }

      // Top-level means no parent: not an annotation, and not a note or
      // attachment that has a parent item.
      async function native(name: string, collectionID?: number) {
        const [row] = await rows(
          `SELECT COUNT(DISTINCT tg.itemID) AS n FROM itemTags tg
           JOIN tags t ON t.tagID = tg.tagID
           JOIN items i ON i.itemID = tg.itemID
           JOIN itemTypes it ON it.itemTypeID = i.itemTypeID
           LEFT JOIN itemNotes nt ON nt.itemID = i.itemID
           LEFT JOIN itemAttachments at ON at.itemID = i.itemID
           WHERE t.name = ? AND i.libraryID = ?
             AND it.typeName != 'annotation'
             AND nt.parentItemID IS NULL AND at.parentItemID IS NULL
             AND i.itemID NOT IN (SELECT itemID FROM deletedItems)` +
            (collectionID
              ? ` AND i.itemID IN (SELECT itemID FROM collectionItems WHERE collectionID = ?)`
              : ""),
          collectionID
            ? [name, libraryID(), collectionID]
            : [name, libraryID()],
        );
        return Number(row.n);
      }

      const library = await call("library_search", {
        entity: "tags",
        mode: "search",
        text: `-${SUFFIX}`,
        limit: 100,
      });
      const counts = Object.fromEntries(
        library.results
          .filter((row: any) => [tagA, tagB, tagC].includes(row.name))
          .map((row: any) => [row.name, row.itemCount]),
      );
      assert.deepEqual(counts, {
        [tagA]: await native(tagA),
        [tagB]: await native(tagB),
        [tagC]: await native(tagC),
      });
      assert.deepEqual(
        [counts[tagA], counts[tagB], counts[tagC]],
        [2, 1, 0],
        "the trashed item, the child note, the child file and the annotations add nothing",
      );
      // itemTags holds the tag on 8 items: 2 papers, the trashed paper, the
      // child note, the child file and 3 annotations.
      const [raw] = await rows(
        `SELECT COUNT(DISTINCT tg.itemID) AS n FROM itemTags tg
         JOIN tags t ON t.tagID = tg.tagID WHERE t.name = ?`,
        [tagA],
      );
      assert.equal(Number(raw.n), 8, "the children do hold the tag");
      const listed = await call("library_search", {
        entity: "items",
        mode: "list",
        filters: { tag: tagA },
        limit: 100,
      });
      assert.equal(
        listed.totalCount,
        counts[tagA],
        "listing the items by the tag gives the same count",
      );

      const scoped = await call("library_search", {
        entity: "tags",
        mode: "search",
        text: `-${SUFFIX}`,
        limit: 100,
        filters: { collectionId: collection.id },
      });
      const scopedCounts = Object.fromEntries(
        scoped.results.map((row: any) => [row.name, row.itemCount]),
      );
      assert.deepEqual(scopedCounts, {
        [tagA]: await native(tagA, collection.id),
        [tagB]: await native(tagB, collection.id),
      });
      assert.deepEqual([scopedCounts[tagA], scopedCounts[tagB]], [2, 1]);
      assert.equal(scoped.totalCount, 2, "tags no member holds are not listed");
    });
  });

  describe("sort keys", function () {
    it("orders a known set by year, creator and dateModified, with and without a PDF filter", async function () {
      const collection = await makeCollection("Sorting");
      const specs = [
        { key: "S1", last: "Zhang", date: "2019", modified: "2026-03-01" },
        { key: "S2", last: "Adams", date: "2023", modified: "2026-01-01" },
        { key: "S3", last: "Miller", date: "2021", modified: "2026-02-01" },
        { key: "S4", last: "", date: "", modified: "2025-12-01" },
      ];
      const byKey: Record<string, any> = {};
      for (const spec of specs) {
        const item = await makeItem("journalArticle", `Sort ${spec.key}`, {
          date: spec.date || undefined,
          collections: [collection.id],
        });
        if (spec.last) {
          item.setCreators([
            { creatorType: "author", firstName: "A.", lastName: spec.last },
          ]);
          await item.saveTx();
        }
        await attachPdf(item.id, 1);
        byKey[spec.key] = item;
      }
      for (const spec of specs) {
        const item = Zotero.Items.get(byKey[spec.key].id);
        item.setField("dateModified", `${spec.modified} 00:00:00`);
        await item.saveTx({ skipDateModifiedUpdate: true });
      }
      // Native readback of the values the orders below rest on.
      for (const spec of specs) {
        const [row] = await rows(
          "SELECT dateModified FROM items WHERE itemID = ?",
          [byKey[spec.key].id],
        );
        assert.equal(String(row.dateModified).slice(0, 10), spec.modified);
        assert.equal(
          Zotero.Items.get(byKey[spec.key].id).firstCreator,
          spec.last,
        );
      }

      const idOf = (key: string) => byKey[key].id;
      const expected = (keys: string[]) => keys.map(idOf);
      const cases: Array<[string, string | undefined, string[]]> = [
        ["year", undefined, ["S2", "S3", "S1", "S4"]],
        ["year", "asc", ["S1", "S3", "S2", "S4"]],
        ["creator", undefined, ["S2", "S3", "S1", "S4"]],
        ["creator", "desc", ["S1", "S3", "S2", "S4"]],
        ["dateModified", undefined, ["S1", "S3", "S2", "S4"]],
        ["dateModified", "asc", ["S4", "S2", "S3", "S1"]],
      ];
      for (const withPdfFilter of [false, true]) {
        for (const [sort, order, keys] of cases) {
          const result = await call("library_search", {
            entity: "items",
            mode: "list",
            filters: {
              collectionId: collection.id,
              ...(withPdfFilter ? { hasPdf: true } : {}),
            },
            sort,
            ...(order ? { order } : {}),
          });
          assert.deepEqual(
            result.results.map((row: any) => row.itemId),
            expected(keys),
            `${sort} ${order || "default"} ${withPdfFilter ? "hasPdf" : "all"}`,
          );
        }
      }

      const page = await call("library_search", {
        entity: "items",
        mode: "list",
        filters: { collectionId: collection.id },
        sort: "year",
        limit: 2,
        offset: 1,
      });
      assert.deepEqual(
        page.results.map((row: any) => row.itemId),
        expected(["S3", "S1"]),
      );
    });
  });

  describe("reader_open", function () {
    let paper: any;
    let attachment: any;
    let annotation: any;

    function readerOf(itemId: number): any {
      return (Zotero.Reader._readers || []).find(
        (reader: any) => reader.itemID === itemId,
      );
    }

    function viewerApp(reader: any): any {
      const frame = reader?._internalReader?._primaryView?._iframeWindow;
      return (frame?.wrappedJSObject || frame)?.PDFViewerApplication;
    }

    async function until(check: () => boolean, message: string, ms = 20000) {
      const deadline = Date.now() + ms;
      while (!check() && Date.now() < deadline) {
        await Zotero.Promise.delay(50);
      }
      assert.isTrue(check(), message);
    }

    /** The reader's own page, 1-based, once its PDF is loaded. */
    function readerPage(): number {
      const app = viewerApp(readerOf(attachment.id));
      return app?.pdfViewer?.pagesCount > 0
        ? Number(app.pdfViewer.currentPageNumber)
        : 0;
    }

    async function closeReaders() {
      for (const reader of [...(Zotero.Reader._readers || [])]) {
        if (reader.itemID === attachment.id) await reader.close?.();
      }
      await Zotero.Promise.delay(200);
    }

    function selectedTabId(): string {
      return Zotero.getMainWindow().Zotero_Tabs.selectedID;
    }

    before(async function () {
      paper = await makeItem("journalArticle", "Reader target");
      attachment = await attachPdf(paper.id, 3);
      annotation = await annotate(attachment.id, "highlight", 2);
    });

    after(async function () {
      await closeReaders();
    });

    it("opens the attachment at a page and moves an open reader to another page", async function () {
      await closeReaders();
      const opened = await call("reader_open", {
        attachmentId: attachment.id,
        pageIndex: 1,
      });
      assert.equal(opened.ok, true, JSON.stringify(opened));
      assert.equal(opened.attachmentId, attachment.id);
      assert.equal(opened.itemId, paper.id);
      const reader = readerOf(attachment.id);
      assert.isOk(reader, "Zotero holds a reader for the attachment");
      assert.equal(selectedTabId(), reader.tabID, "its tab is selected");
      await until(() => readerPage() === 2, "the reader shows page index 1");

      const moved = await call("reader_open", {
        itemId: paper.id,
        pageIndex: 2,
      });
      assert.equal(moved.ok, true, JSON.stringify(moved));
      assert.equal(moved.attachmentId, attachment.id, "the paper's PDF");
      assert.equal(readerOf(attachment.id), reader, "no second reader tab");
      await until(() => readerPage() === 3, "the reader shows page index 2");

      const byLabel = await call("reader_open", {
        attachmentId: attachment.id,
        pageLabel: "1",
      });
      assert.equal(byLabel.ok, true, JSON.stringify(byLabel));
      await until(() => readerPage() === 1, "the reader shows page label 1");
      assert.equal(byLabel.location.pageLabelVerified, true, "read back");
      assert.isUndefined(byLabel.note);

      // With the library tab in front, the open reader comes forward at the
      // new page instead of a second reader opening.
      Zotero.getMainWindow().Zotero_Tabs.select("zotero-pane");
      await until(() => selectedTabId() === "zotero-pane", "library tab");
      const back = await call("reader_open", {
        attachmentId: attachment.id,
        pageIndex: 2,
      });
      assert.equal(back.ok, true, JSON.stringify(back));
      assert.equal(readerOf(attachment.id), reader, "the same reader");
      await until(
        () => selectedTabId() === reader.tabID,
        "the reader tab is selected again",
      );
      await until(() => readerPage() === 3, "page index 2 again");
    });

    it("opens at an annotation: its PDF, its page and the annotation selected", async function () {
      await call("reader_open", { attachmentId: attachment.id, pageIndex: 0 });
      await until(() => readerPage() === 1, "starts on the first page");
      const result = await call("reader_open", { annotationId: annotation.id });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.attachmentId, attachment.id);
      const reader = readerOf(attachment.id);
      await until(() => readerPage() === 3, "the annotation's page is shown");
      await until(
        () =>
          (
            reader._internalReader?._state?.selectedAnnotationIDs || []
          ).includes(annotation.key),
        "the reader selects the annotation by its key",
      );
    });

    it("opens a closed reader straight at an annotation", async function () {
      await closeReaders();
      assert.isNotOk(readerOf(attachment.id));
      const result = await call("reader_open", { annotationId: annotation.id });
      assert.equal(result.ok, true, JSON.stringify(result));
      await until(() => Boolean(readerOf(attachment.id)), "a reader opens");
      await until(() => readerPage() === 3, "at the annotation's page");
    });

    it("leaves the library as it was", async function () {
      const stamp = async () => {
        const [row] = await rows(
          "SELECT dateModified, clientDateModified, synced FROM items WHERE itemID = ?",
          [attachment.id],
        );
        return [row.dateModified, row.clientDateModified, row.synced].join("|");
      };
      const before = await stamp();
      await call("reader_open", { attachmentId: attachment.id, pageIndex: 0 });
      await until(() => readerPage() === 1, "on the first page");
      assert.equal(await stamp(), before);
    });

    it("refuses what it cannot open, with no reader change", async function () {
      const notAnAnnotation = await call("reader_open", {
        annotationId: paper.id,
      });
      assert.equal(notAnAnnotation.ok, false);
      const asItem = await call("reader_open", { itemId: attachment.id });
      assert.equal(asItem.ok, false);
    });

    it("refuses a pageIndex past the last page and opens nothing", async function () {
      await closeReaders();
      const tabBefore = selectedTabId();
      // The PDF has 3 pages: index 2 is the last.
      const past = await call("reader_open", {
        attachmentId: attachment.id,
        pageIndex: 3,
      });
      assert.equal(past.ok, false, JSON.stringify(past));
      assert.include(past.error, "3 pages");
      const wayPast = await call("reader_open", {
        itemId: paper.id,
        pageIndex: 400,
      });
      assert.equal(wayPast.ok, false, JSON.stringify(wayPast));
      await Zotero.Promise.delay(500);
      assert.isNotOk(readerOf(attachment.id), "no reader opened");
      assert.equal(selectedTabId(), tabBefore, "the tab did not change");

      const last = await call("reader_open", {
        attachmentId: attachment.id,
        pageIndex: 2,
      });
      assert.equal(last.ok, true, JSON.stringify(last));
      await until(() => readerPage() === 3, "the last page is shown");
    });

    it("reports a page label the reader does not have as requested, not verified", async function () {
      await call("reader_open", { attachmentId: attachment.id, pageIndex: 0 });
      await until(() => readerPage() === 1, "on the first page");
      const missing = await call("reader_open", {
        attachmentId: attachment.id,
        pageLabel: "xii",
      });
      assert.equal(missing.ok, true, JSON.stringify(missing));
      assert.equal(missing.location.pageLabelVerified, false);
      assert.match(missing.note, /requested, not verified/);
      assert.equal(readerPage(), 1, "the reader stayed on page 1");
      const present = await call("reader_open", {
        attachmentId: attachment.id,
        pageLabel: "3",
      });
      assert.equal(present.location.pageLabelVerified, true);
      await until(() => readerPage() === 3, "page label 3 is shown");
    });

    describe("with a conversation in the library tab", function () {
      const layoutPref = "extensions.zotero.llmforzotero.sidebarLayout";
      let originalLayout: unknown;
      let other: any;

      const win = () => Zotero.getMainWindow();
      const details = () =>
        win().document.getElementById("zotero-item-details");
      const section = () =>
        details()?.querySelector(".llm-dedicated-chat-pane") as any;
      const panel = () =>
        section()?.querySelector("#llm-main") as HTMLElement | null;
      const messageTexts = () =>
        Array.from(
          panel()?.querySelectorAll("#llm-chat-box .llm-message-wrapper") || [],
        ).map((node: any) => node.textContent || "");

      async function openChatPane() {
        const d: any = details();
        if (
          win().document.documentElement.getAttribute("data-llm-pane-view") !==
            "chat" ||
          d.sidenav._collapsed
        ) {
          const paneID = section()?.dataset.pane;
          const button = Array.from(
            d.sidenav.querySelectorAll("[data-pane]"),
          ).find((node: any) => node.getAttribute("data-pane") === paneID);
          assert.isOk(button, "chat rail icon exists");
          (button as Element).dispatchEvent(
            new (win() as any).MouseEvent("click", {
              bubbles: true,
              detail: 1,
              button: 0,
            }),
          );
        }
        await until(
          () =>
            !d.sidenav._collapsed &&
            (panel()?.getBoundingClientRect().height || 0) > 0 &&
            Boolean(panel()?.dataset.handlersInitialized),
          "the chat pane is open",
        );
      }

      before(async function () {
        originalLayout = Zotero.Prefs.get(layoutPref, true);
        Zotero.Prefs.set(layoutPref, "independent", true);
        other = await makeItem("journalArticle", "Reader chat other");
      });

      after(function () {
        if (originalLayout === undefined) Zotero.Prefs.clear(layoutPref, true);
        else Zotero.Prefs.set(layoutPref, originalLayout as string, true);
      });

      it("brings the same conversation back, intact, when the user returns from the reader", async function () {
        const api = Zotero.LLMForZotero.api.workflowTest;
        await closeReaders();
        win().Zotero_Tabs.select("zotero-pane");
        await until(() => selectedTabId() === "zotero-pane", "library tab");

        // A conversation on the paper in the library tab's chat.
        await win().ZoteroPane.selectItem(paper.id);
        await openChatPane();
        await until(
          () =>
            panel()?.dataset.basePaperItemId === `${paper.id}` &&
            Number(panel()?.dataset.itemId) > 0,
          "the library chat is on the paper",
        );
        const conversationKey = Number(panel()!.dataset.itemId);
        const stamp = Date.now() - 10000;
        await api.seedStoredConversationTurns(conversationKey, [
          { role: "user", text: `Question ${SUFFIX}`, timestamp: stamp },
          {
            role: "assistant",
            text: `Answer ${SUFFIX}`,
            timestamp: stamp + 1,
          },
        ]);
        // Leave the paper and come back so the pane draws the stored turns.
        await win().ZoteroPane.selectItem(other.id);
        await until(
          () => panel()?.dataset.basePaperItemId === `${other.id}`,
          "the library chat moved to the other paper",
        );
        await win().ZoteroPane.selectItem(paper.id);
        await openChatPane();
        const shown = () =>
          panel()?.dataset.basePaperItemId === `${paper.id}` &&
          messageTexts().length === 2 &&
          messageTexts()[1].includes(`Answer ${SUFFIX}`);
        await until(shown, "the library chat shows the conversation");
        const beforeTexts = messageTexts();
        assert.include(beforeTexts[0], `Question ${SUFFIX}`);

        // The model opens a reader. Its tab comes to the front.
        const opened = await call("reader_open", {
          attachmentId: attachment.id,
          pageIndex: 0,
        });
        assert.equal(opened.ok, true, JSON.stringify(opened));
        const reader = readerOf(attachment.id);
        await until(
          () => selectedTabId() === reader.tabID,
          "the reader tab is selected",
        );

        // The user returns to the library tab.
        win().Zotero_Tabs.select("zotero-pane");
        await until(
          () => selectedTabId() === "zotero-pane",
          "the library tab is selected again",
        );
        await openChatPane();
        await until(shown, "the same conversation is shown again");
        assert.equal(
          Number(panel()!.dataset.itemId),
          conversationKey,
          "the same conversation key",
        );
        assert.deepEqual(
          messageTexts(),
          beforeTexts,
          "its messages are intact",
        );
        assert.isFalse(
          panel()!.querySelector("#llm-chat-box")!.hasAttribute("inert"),
          "the chat takes input again",
        );
        const history = await api.getConversationHistoryTexts(conversationKey);
        assert.deepEqual(
          history.stored.map((entry: { text: string }) => entry.text),
          [`Question ${SUFFIX}`, `Answer ${SUFFIX}`],
          "the stored conversation is unchanged",
        );
      });
    });

    it("is offered over MCP as a read-only tool and opens the reader", async function () {
      const listing = await mcp("tools/list", {});
      const entry = listing.tools.find(
        (candidate: { name: string }) => candidate.name === "reader_open",
      );
      assert.isOk(entry, "reader_open is in the MCP tool list");
      assert.equal(entry.annotations?.readOnlyHint, true);

      await closeReaders();
      const response = await mcp("tools/call", {
        name: "reader_open",
        arguments: { attachmentId: attachment.id, pageIndex: 0 },
      });
      const payload = JSON.parse(response.content[0].text);
      assert.equal(payload.ok, true, response.content[0].text);
      assert.equal(payload.result.attachmentId, attachment.id);
      await until(() => Boolean(readerOf(attachment.id)), "a reader opens");
      await until(() => readerPage() === 1, "on the first page");
    });
  });
});

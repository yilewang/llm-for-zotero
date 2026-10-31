import { assert } from "chai";
import { computeLibraryStatistics } from "../src/agent/actions/libraryStatistics";
import {
  compareSortValues,
  isLibrarySortKey,
} from "../src/agent/services/librarySortKeys";
import { applySort } from "../src/agent/services/libraryQueryService";
import { LibraryReadService } from "../src/agent/services/libraryReadService";
import { sortAndPageIndexIds } from "../src/agent/services/zotero/internal/libraryIndex";
import { ItemCapability } from "../src/agent/services/zotero/itemCapability";
import { TagCapability } from "../src/agent/services/zotero/tagCapability";
import { createLibraryReadTool } from "../src/agent/tools/read/libraryRead";
import { createLibrarySearchTool } from "../src/agent/tools/read/librarySearch";
import { libraryIndexService } from "../src/services/libraryIndexService";
import type { AgentToolContext } from "../src/agent/types";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

const context: AgentToolContext = {
  request: {
    conversationKey: 5,
    mode: "agent",
    userText: "x",
    libraryID: 1,
  },
  item: null,
  currentAnswerText: "",
  modelName: "test-model",
} as never;

describe("W5-A sort keys", function () {
  const rows = [
    {
      itemId: 1,
      year: "2019",
      firstCreator: "Zhang",
      dateModified: "2026-03-01",
    },
    {
      itemId: 2,
      year: "2023",
      firstCreator: "Adams",
      dateModified: "2026-01-01",
    },
    {
      itemId: 3,
      year: "2021",
      firstCreator: "Miller",
      dateModified: "2026-02-01",
    },
    { itemId: 4, year: "", firstCreator: "", dateModified: "" },
  ];
  const ids = (list: Array<{ itemId: number }>) => list.map((r) => r.itemId);

  it("knows the five keys", function () {
    for (const key of ["dateAdded", "dateModified", "title", "year", "creator"])
      assert.isTrue(isLibrarySortKey(key), key);
    assert.isFalse(isLibrarySortKey("itemCount"));
  });

  it("orders year newest first and creator A-Z by default", function () {
    assert.deepEqual(ids(applySort(rows, "year", undefined)), [2, 3, 1, 4]);
    assert.deepEqual(ids(applySort(rows, "creator", undefined)), [2, 3, 1, 4]);
    assert.deepEqual(
      ids(applySort(rows, "dateModified", undefined)),
      [1, 3, 2, 4],
    );
  });

  it("reverses with order, and keeps an empty value last both ways", function () {
    assert.deepEqual(ids(applySort(rows, "year", "asc")), [1, 3, 2, 4]);
    assert.deepEqual(ids(applySort(rows, "creator", "desc")), [1, 3, 2, 4]);
    assert.equal(ids(applySort(rows, "dateModified", "asc")).at(-1), 4);
  });

  it("compares values the same way for every path", function () {
    assert.isBelow(compareSortValues("year", "2023", "2019", undefined), 0);
    assert.isAbove(compareSortValues("creator", "b", "a", "asc"), 0);
    assert.equal(compareSortValues("creator", "", "", "asc"), 0);
  });

  it("sorts and pages the index snapshot by the new keys", function () {
    const snapshot = {
      itemById: new Map(
        rows.map((row) => [
          row.itemId,
          { title: `T${row.itemId}`, dateAdded: "", ...row },
        ]),
      ),
    } as never;
    assert.deepEqual(
      sortAndPageIndexIds(snapshot, [1, 2, 3, 4], { sort: "year" }),
      [2, 3, 1, 4],
    );
    assert.deepEqual(
      sortAndPageIndexIds(snapshot, [1, 2, 3, 4], {
        sort: "creator",
        offset: 1,
        limit: 2,
      }),
      [3, 1],
    );
    assert.deepEqual(
      sortAndPageIndexIds(snapshot, [1, 2, 3, 4], { sort: "dateModified" }),
      [1, 3, 2, 4],
    );
  });

  it("passes the new keys through library_search validation", function () {
    const tool = createLibrarySearchTool({} as never);
    for (const sort of ["year", "creator", "dateModified"]) {
      const validated = tool.validate({ entity: "items", mode: "list", sort });
      assert.isTrue(validated.ok);
      if (validated.ok) assert.equal(validated.value.sort, sort);
    }
    const unknown = tool.validate({
      entity: "items",
      mode: "list",
      sort: "itemCount",
    });
    assert.isTrue(unknown.ok);
    if (unknown.ok) assert.isUndefined(unknown.value.sort);
  });
});

describe("W5-A tag counts", function () {
  const original = globalScope.Zotero;
  let queries: Array<{ sql: string; params: unknown[] }>;

  beforeEach(function () {
    queries = [];
    globalScope.Zotero = {
      Tags: {
        getAll: async () => [
          { tag: "alpha", type: 0 },
          { tag: "beta", type: 0 },
          { tag: "beta", type: 1 },
          { tag: "trashed only", type: 0 },
        ],
      },
      DB: {
        queryAsync: async (sql: string, params: unknown[]) => {
          queries.push({ sql, params });
          return params.length === 2
            ? [{ name: "alpha", type: 0, n: 1 }]
            : [
                { name: "alpha", type: 0, n: 3 },
                { name: "beta", type: 0, n: 2 },
                { name: "beta", type: 1, n: 1 },
              ];
        },
      },
    };
  });
  afterEach(function () {
    globalScope.Zotero = original;
  });

  const capability = () =>
    new TagCapability({
      getItem: () => null,
      resolveBibliographicItem: () => null,
    });

  it("adds itemCount per name and type, 0 for a tag only trashed items hold", async function () {
    const result = await capability().listLibraryTags({
      libraryID: 1,
      withCounts: true,
    });
    assert.deepEqual(result.tags, [
      { name: "alpha", type: 0, itemCount: 3 },
      { name: "beta", type: 0, itemCount: 2 },
      { name: "beta", type: 1, itemCount: 1 },
      { name: "trashed only", type: 0, itemCount: 0 },
    ]);
    assert.include(queries[0].sql, "deletedItems");
    assert.notInclude(queries[0].sql, "collectionItems");
    // Top-level items only: annotations, child notes and child attachments
    // are not counted.
    assert.include(queries[0].sql, "FROM itemAnnotations");
    assert.include(
      queries[0].sql,
      "FROM itemNotes WHERE parentItemID IS NOT NULL",
    );
    assert.include(
      queries[0].sql,
      "FROM itemAttachments WHERE parentItemID IS NOT NULL",
    );
  });

  it("limits the list and the counts to a collection's direct members", async function () {
    const result = await capability().listLibraryTags({
      libraryID: 1,
      collectionId: 7,
    });
    assert.deepEqual(result.tags, [{ name: "alpha", type: 0, itemCount: 1 }]);
    assert.equal(result.totalCount, 1);
    assert.include(queries[0].sql, "collectionItems");
    assert.deepEqual(queries[0].params, [1, 7]);
  });

  it("keeps the plain listing free of counts and queries", async function () {
    const result = await capability().listLibraryTags({ libraryID: 1 });
    assert.isUndefined(result.tags[0].itemCount);
    assert.lengthOf(queries, 0);
  });
});

describe("W5-A relatedLinks", function () {
  it("keeps a related item that is in the trash and marks it deleted", function () {
    const original = globalScope.Zotero;
    const others: Record<string, Record<string, unknown>> = {
      LIVE0001: { id: 2, deleted: false, getField: () => "Live paper" },
      TRASH001: { id: 3, deleted: true, getField: () => "Trashed paper" },
    };
    globalScope.Zotero = {
      Items: {
        getByLibraryAndKey: (_library: number, key: string) =>
          others[key] || null,
      },
    };
    try {
      const capability = new ItemCapability({
        getItem: () => ({
          libraryID: 1,
          relatedItems: ["LIVE0001", "TRASH001", "GONE0001"],
        }),
      } as never);
      assert.deepEqual(capability.getRelatedItemLinks(1), [
        { itemId: 2, key: "LIVE0001", title: "Live paper" },
        { itemId: 3, key: "TRASH001", title: "Trashed paper", deleted: true },
      ]);
    } finally {
      globalScope.Zotero = original;
    }
  });

  it("reads the links through the gateway and leaves them out when not asked", async function () {
    const calls: number[] = [];
    const item = {
      id: 4,
      isNote: () => false,
      isAttachment: () => false,
      getDisplayTitle: () => "Paper",
    };
    const gateway = {
      getPaperTargetsByItemIds: () => [],
      getItem: () => item,
      listPaperContexts: () => [],
      resolveMetadataItem: () => item,
      getItemCollectionIds: () => [],
      getCollectionSummary: () => null,
      getRelatedItemLinks: (itemId: number) => {
        calls.push(itemId);
        return [{ itemId: 9, key: "ABCD1234", title: "Other" }];
      },
    } as never;
    const service = new LibraryReadService(gateway);
    const asked = await service.readItems({
      request: context.request,
      itemIds: [4],
      selectorMode: "explicit",
      sections: ["relatedLinks"],
    });
    assert.deepEqual(asked.results["4"].relatedLinks, [
      { itemId: 9, key: "ABCD1234", title: "Other" },
    ]);
    const notAsked = await service.readItems({
      request: context.request,
      itemIds: [4],
      selectorMode: "explicit",
      sections: ["collections"],
    });
    assert.isUndefined(notAsked.results["4"].relatedLinks);
    assert.deepEqual(calls, [4]);
  });

  it("is a valid library_read section", function () {
    const tool = createLibraryReadTool({} as never);
    const validated = tool.validate({
      itemIds: [4],
      sections: ["relatedLinks"],
    });
    assert.isTrue(validated.ok);
  });
});

describe("W5-A statistics", function () {
  const original = globalScope.Zotero;
  const originalGetSnapshot = libraryIndexService.getSnapshot;

  function indexItem(itemId: number, collectionIds: number[]) {
    return {
      itemId,
      kind: "regular",
      deleted: false,
      itemType: "journalArticle",
      title: `Paper ${itemId}`,
      year: "2022",
      creators: ["Smith"],
      publicationTitle: "J",
      tags: ["t"],
      automaticTags: [],
      collectionIds,
      dateAdded: "2026-01-01 00:00:00",
    };
  }

  afterEach(function () {
    globalScope.Zotero = original;
    libraryIndexService.getSnapshot = originalGetSnapshot;
  });

  it("counts annotations from the annotation items getAnnotations returns", async function () {
    const pdf = (annotations: Array<{ annotationType: string }>) => ({
      isAttachment: () => true,
      deleted: false,
      attachmentContentType: "application/pdf",
      getAnnotations: () => annotations,
    });
    const attachments: Record<number, unknown> = {
      101: pdf([{ annotationType: "highlight" }, { annotationType: "note" }]),
      102: pdf([]),
    };
    globalScope.Zotero = {
      Items: { get: (id: number) => attachments[id] },
      Libraries: { getName: () => "My Library" },
    };
    libraryIndexService.getSnapshot = (async () => ({
      topLevelItemOrder: [1, 2],
      itemById: new Map([
        [1, indexItem(1, [7])],
        [2, indexItem(2, [])],
      ]),
      childAttachmentIdsByItemId: new Map([
        [1, [101]],
        [2, [102]],
      ]),
    })) as never;
    const result = await computeLibraryStatistics({
      libraryID: 1,
      zoteroGateway: {
        getCollectionSummary: () => ({ collectionId: 7, name: "C" }),
        listCollectionSummaries: () => [],
      } as never,
      sections: ["annotations", "itemTypes"],
    });
    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.output.annotations?.annotationsByType, {
      highlight: 1,
      note: 1,
    });
    assert.equal(result.output.annotations?.totalAnnotations, 2);
    assert.equal(result.output.annotations?.itemsWithAnnotations, 1);
    assert.deepEqual(result.output.itemTypes, { journalArticle: 2 });
    assert.isUndefined(result.output.tags);
  });

  it("counts annotations on standalone attachments and on EPUB and snapshot files", async function () {
    const file = (
      type: string,
      annotations: Array<{ annotationType: string }>,
    ) => ({
      isAttachment: () => true,
      isFileAttachment: () => true,
      deleted: false,
      attachmentContentType: type,
      getAnnotations: () => annotations,
    });
    const attachments: Record<number, unknown> = {
      101: file("application/epub+zip", [{ annotationType: "highlight" }]),
      102: file("text/html", [{ annotationType: "note" }]),
      3: file("application/pdf", [
        { annotationType: "highlight" },
        { annotationType: "highlight" },
      ]),
      4: {
        ...file("application/pdf", [{ annotationType: "ink" }]),
        deleted: true,
      },
    };
    globalScope.Zotero = {
      Items: { get: (id: number) => attachments[id] },
      Libraries: { getName: () => "My Library" },
    };
    const standalone = (itemId: number, collectionIds: number[]) => ({
      ...indexItem(itemId, collectionIds),
      kind: "standalone-attachment",
      itemType: "attachment",
    });
    libraryIndexService.getSnapshot = (async () => ({
      topLevelItemOrder: [1, 3, 4],
      itemById: new Map([
        [1, indexItem(1, [])],
        [3, standalone(3, [7])],
        [4, standalone(4, [])],
      ]),
      childAttachmentIdsByItemId: new Map([
        [1, [101, 102]],
        [3, [3]],
        [4, [4]],
      ]),
    })) as never;
    const gateway = {
      getCollectionSummary: () => ({ collectionId: 7, name: "C" }),
    } as never;
    const all = await computeLibraryStatistics({
      libraryID: 1,
      zoteroGateway: gateway,
      sections: ["annotations"],
    });
    assert.isTrue(all.ok);
    if (all.ok) {
      assert.deepEqual(all.output.annotations?.annotationsByType, {
        highlight: 3,
        note: 1,
      });
      assert.equal(all.output.annotations?.totalAnnotations, 4);
    }
    const scoped = await computeLibraryStatistics({
      libraryID: 1,
      zoteroGateway: gateway,
      scope: "collection",
      collectionId: 7,
      sections: ["annotations"],
    });
    assert.isTrue(scoped.ok);
    if (scoped.ok) {
      assert.equal(scoped.output.annotations?.totalAnnotations, 2);
    }
  });

  it("scopes to a collection's direct members and says so", async function () {
    globalScope.Zotero = {
      Items: { get: () => null },
      Libraries: { getName: () => "My Library" },
    };
    libraryIndexService.getSnapshot = (async () => ({
      topLevelItemOrder: [1, 2],
      itemById: new Map([
        [1, indexItem(1, [7])],
        [2, indexItem(2, [])],
      ]),
      childAttachmentIdsByItemId: new Map(),
    })) as never;
    const gateway = {
      getCollectionSummary: (id: number) =>
        id === 7 ? { collectionId: 7, name: "C", path: "Top / C" } : null,
    } as never;
    const scoped = await computeLibraryStatistics({
      libraryID: 1,
      zoteroGateway: gateway,
      scope: "collection",
      collectionId: 7,
      sections: ["itemTypes"],
    });
    assert.isTrue(scoped.ok);
    if (scoped.ok) {
      assert.equal(scoped.output.totalItems, 1);
      assert.include(scoped.output.scopeDescription, "Top / C");
      assert.include(scoped.output.scopeDescription, "direct members");
    }
    const missing = await computeLibraryStatistics({
      libraryID: 1,
      zoteroGateway: gateway,
      scope: "collection",
      collectionId: 99,
    });
    assert.isFalse(missing.ok);
  });

  it("is reached as library_search entity statistics", async function () {
    globalScope.Zotero = {
      Items: { get: () => null },
      Libraries: { getName: () => "My Library" },
    };
    libraryIndexService.getSnapshot = (async () => ({
      topLevelItemOrder: [1],
      itemById: new Map([[1, indexItem(1, [])]]),
      childAttachmentIdsByItemId: new Map(),
    })) as never;
    const tool = createLibrarySearchTool({
      resolveLibraryID: () => 1,
    } as never);
    const validated = tool.validate({
      entity: "statistics",
      mode: "list",
      sections: ["itemTypes", "yearDistribution"],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, context)) as {
      statistics: { itemTypes: Record<string, number>; totalItems: number };
    };
    assert.deepEqual(output.statistics.itemTypes, { journalArticle: 1 });

    assert.isFalse(tool.validate({ entity: "statistics", mode: "search" }).ok);
    assert.isFalse(
      tool.validate({
        entity: "statistics",
        mode: "list",
        sections: ["nonsense"],
      }).ok,
    );
    assert.equal(
      tool.planInvocation?.(validated.value, context as never)?.impact,
      "read_only",
    );
  });

  it("refuses a statistics call that carries a filter or text it would ignore", function () {
    const tool = createLibrarySearchTool({
      resolveLibraryID: () => 1,
    } as never);
    const base = { entity: "statistics", mode: "list" };
    assert.isTrue(tool.validate({ ...base, filters: { collectionId: 7 } }).ok);
    assert.isTrue(
      tool.validate({ ...base, filters: { unfiled: false, untagged: false } })
        .ok,
    );
    for (const filters of [
      { tag: "x" },
      { author: "Smith" },
      { yearFrom: 2020 },
      { yearTo: 2021 },
      { itemType: "book" },
      { hasPdf: false },
      { hasPdf: true },
      { unfiled: true },
      { untagged: true },
      { deleted: true },
    ]) {
      const result = tool.validate({ ...base, filters });
      assert.isFalse(result.ok, JSON.stringify(filters));
      if (!result.ok) {
        assert.include(result.error, `filters.${Object.keys(filters)[0]}`);
      }
    }
    const withText = tool.validate({ ...base, text: "attention" });
    assert.isFalse(withText.ok);
    if (!withText.ok) assert.include(withText.error, "text");
  });

  it("checks sections only for statistics", function () {
    const tool = createLibrarySearchTool({
      resolveLibraryID: () => 1,
    } as never);
    assert.isTrue(
      tool.validate({ entity: "items", mode: "list", sections: ["nonsense"] })
        .ok,
    );
    assert.isFalse(
      tool.validate({
        entity: "statistics",
        mode: "list",
        sections: ["nonsense"],
      }).ok,
    );
  });

  it("names the valid sections as an enum in the schema", function () {
    const tool = createLibrarySearchTool({
      resolveLibraryID: () => 1,
    } as never);
    const sections = (tool.spec.inputSchema as any).properties.sections;
    assert.deepEqual(sections.items.enum, [
      "itemTypes",
      "yearDistribution",
      "topAuthors",
      "topJournals",
      "collections",
      "tags",
      "annotations",
      "growthTimeline",
      "authorshipStats",
      "titleKeywords",
    ]);
  });
});

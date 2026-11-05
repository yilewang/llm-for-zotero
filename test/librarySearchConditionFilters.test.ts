import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { createLibrarySearchTool } from "../src/agent/tools/read/librarySearch";

/**
 * A conditions[] search used to drop collectionId, tag, itemType, author and
 * the year range without a word, so "full text mentions X, in collection Y"
 * answered for the whole library.
 *
 * The filters cannot be added to the condition search itself: a
 * fulltextContent clause matches the child PDF while collectionID matches the
 * parent paper, so one joinMode-all search matches nothing. The two searches
 * run apart and are intersected on the parent ids.
 */
describe("library_search conditions[] with simple filters", function () {
  type Clause = { condition: string; operator: string; value: unknown };

  type FakeItem = {
    id: number;
    parentID: number | false;
    title: string;
    date: string;
    collections: number[];
    tags: string[];
  };

  const ITEMS: FakeItem[] = [
    // Papers: 1 and 3 in collection 10, 4 in collection 10 with no hit.
    {
      id: 1,
      parentID: false,
      title: "Alpha",
      date: "2021-03-01",
      collections: [10],
      tags: ["keep"],
    },
    {
      id: 2,
      parentID: false,
      title: "Beta",
      date: "2015-01-01",
      collections: [],
      tags: [],
    },
    {
      id: 3,
      parentID: false,
      title: "Gamma",
      date: "2010-01-01",
      collections: [10],
      tags: [],
    },
    {
      id: 4,
      parentID: false,
      title: "Delta",
      date: "2022-01-01",
      collections: [10],
      tags: ["keep"],
    },
    // Their PDFs; 11, 12, 13 contain the full-text phrase.
    {
      id: 11,
      parentID: 1,
      title: "Alpha PDF",
      date: "",
      collections: [],
      tags: [],
    },
    {
      id: 12,
      parentID: 2,
      title: "Beta PDF",
      date: "",
      collections: [],
      tags: [],
    },
    {
      id: 13,
      parentID: 3,
      title: "Gamma PDF",
      date: "",
      collections: [],
      tags: [],
    },
  ];
  const FULLTEXT_HITS = [11, 12, 13];

  let items: Map<number, Record<string, unknown>>;
  let searches: Clause[][];

  function makeItem(seed: FakeItem) {
    return {
      id: seed.id,
      parentID: seed.parentID,
      libraryID: 1,
      itemTypeID: 1,
      isAnnotation: () => false,
      isRegularItem: () => !seed.parentID,
      isAttachment: () => Boolean(seed.parentID),
      isNote: () => false,
      getField: (name: string) =>
        name === "title" ? seed.title : name === "date" ? seed.date : "",
      getCreators: () => [],
      getTags: () => seed.tags.map((tag) => ({ tag, type: 0 })),
      getCollections: () => seed.collections,
      getAttachments: () => [],
      getDisplayTitle: () => seed.title,
    };
  }

  /** Answers each clause the way Zotero's SQL would, per search instance. */
  function matches(seed: FakeItem, clause: Clause): boolean {
    switch (clause.condition) {
      case "fulltextContent":
        return FULLTEXT_HITS.includes(seed.id);
      case "title":
        return seed.title
          .toLowerCase()
          .includes(String(clause.value).toLowerCase());
      case "collectionID":
        return seed.collections.includes(Number(clause.value));
      case "tag":
        return seed.tags.includes(String(clause.value));
      case "itemType":
        return String(clause.value) === "journalArticle" && !seed.parentID;
      case "date":
        // The SQL side only narrows; the exact year bound is applied in JS.
        return !seed.parentID;
      case "joinMode":
      case "deleted":
        return true;
      default:
        return false;
    }
  }

  beforeEach(function () {
    items = new Map(ITEMS.map((seed) => [seed.id, makeItem(seed)]));
    searches = [];

    class FakeSearch {
      private clauses: Clause[] = [];
      constructor() {
        searches.push(this.clauses);
      }
      addCondition(condition: string, operator: string, value: unknown) {
        this.clauses.push({ condition, operator, value });
      }
      async search() {
        return ITEMS.filter((seed) =>
          this.clauses.every((clause) => matches(seed, clause)),
        ).map((seed) => seed.id);
      }
    }

    (globalThis as Record<string, unknown>).Zotero = {
      Search: FakeSearch,
      Items: { get: (id: number) => items.get(id) || null },
      ItemTypes: { getName: () => "journalArticle" },
      SearchConditions: {
        get: (name: string) =>
          ({
            fulltextContent: {
              operators: { contains: true, doesNotContain: true },
            },
            title: { operators: { contains: true, is: true } },
            joinMode: { operators: { any: true, all: true } },
            deleted: { operators: { true: true, false: true } },
          })[name],
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

  async function run(args: Record<string, unknown>) {
    const tool = createLibrarySearchTool(gateway());
    const parsed = tool.validate({
      entity: "items",
      mode: "search",
      libraryID: 1,
      conditions: [
        { condition: "fulltextContent", operator: "contains", value: "phrase" },
      ],
      resolveToParents: true,
      ...args,
    });
    assert.isTrue(parsed.ok, JSON.stringify(parsed));
    if (!parsed.ok) throw new Error("validation failed");
    return (await tool.execute(parsed.value, {
      request: {},
      item: null,
    } as never)) as {
      results: Array<{ itemId: number }>;
      totalCount: number;
      returnedCount: number;
      limited: boolean;
      offset: number;
      nextOffset?: number;
    };
  }

  const ids = (result: { results: Array<{ itemId: number }> }) =>
    result.results.map((row) => row.itemId);

  it("keeps only the full-text matches inside the collection", async function () {
    const result = await run({ filters: { collectionId: 10 } });
    // 2 matches the text but sits outside; 4 sits inside with no match.
    assert.sameMembers(ids(result), [1, 3]);
    assert.equal(result.totalCount, 2);
    assert.isFalse(result.limited);
  });

  it("keeps only the full-text matches that carry the tag", async function () {
    const result = await run({ filters: { tag: "keep" } });
    assert.deepEqual(ids(result), [1]);
    assert.equal(result.totalCount, 1);
  });

  it("applies the exact year range to the intersection", async function () {
    const result = await run({
      filters: { collectionId: 10, yearFrom: 2020, yearTo: 2021 },
    });
    // 3 (2010) is in the collection and matches the text, but not the range.
    assert.deepEqual(ids(result), [1]);
    assert.equal(result.totalCount, 1);
  });

  it("pages the intersection with the total, limited and nextOffset contract", async function () {
    const first = await run({ filters: { collectionId: 10 }, limit: 1 });
    assert.equal(first.totalCount, 2);
    assert.equal(first.returnedCount, 1);
    assert.isTrue(first.limited);
    assert.equal(first.nextOffset, 1);

    const second = await run({
      filters: { collectionId: 10 },
      limit: 1,
      offset: 1,
    });
    assert.equal(second.totalCount, 2);
    assert.isFalse(second.limited);
    assert.isUndefined(second.nextOffset);
    assert.sameMembers([...ids(first), ...ids(second)], [1, 3]);
  });

  it("runs the filters as their own search, never inside the condition search", async function () {
    await run({ filters: { collectionId: 10 } });
    const conditionSearch = searches.find((clauses) =>
      clauses.some((clause) => clause.condition === "fulltextContent"),
    );
    assert.isDefined(conditionSearch);
    assert.isFalse(
      conditionSearch!.some((clause) => clause.condition === "collectionID"),
      "one joinMode-all search would require the PDF to be in the collection",
    );
  });

  it("leaves a conditions-only search unchanged", async function () {
    const result = await run({});
    assert.sameMembers(ids(result), [1, 2, 3]);
    assert.equal(searches.length, 1, "no filter search without filters");
  });

  it("still refuses hasPdf and untagged next to conditions", function () {
    const tool = createLibrarySearchTool(gateway());
    for (const filters of [
      { hasPdf: true, collectionId: 10 },
      { untagged: true },
    ]) {
      const parsed = tool.validate({
        entity: "items",
        mode: "search",
        filters,
        conditions: [{ condition: "title", operator: "contains", value: "x" }],
      });
      assert.isFalse(parsed.ok, JSON.stringify(filters));
    }
  });
});

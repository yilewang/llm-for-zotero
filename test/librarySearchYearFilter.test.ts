import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { libraryIndexService } from "../src/services/libraryIndexService";

/**
 * `buildAgentLibrarySearch` called `addCondition("year", "isGreaterThan", …)`.
 * `year` accepts only is/isNot/contains/doesNotContain, and `addCondition`
 * throws on an unsupported operator. Both callers swallowed the throw, so
 * every text search combined with a year filter reported "no matching library
 * results" — always, on any library. The list path fell back to an in-memory
 * filter and quietly worked, which is why nobody noticed.
 *
 * The author filter was a second, independent bug: it opened an OR block, and
 * any block sets `hasQuicksearch`, which makes `joinModeAny` true and flips
 * every other condition in the query from AND to OR.
 */
describe("library search year and author filters", function () {
  const YEAR_OPERATORS = new Set(["is", "isNot", "contains", "doesNotContain"]);
  const DATE_OPERATORS = new Set([
    "is",
    "isNot",
    "isBefore",
    "isAfter",
    "isInTheLast",
  ]);

  type Condition = { condition: string; operator: string; value: unknown };

  let conditions: Condition[];
  let searchResultIds: number[];
  let items: Map<number, Record<string, unknown>>;

  function installFakeZotero() {
    conditions = [];
    class FakeSearch {
      addCondition(condition: string, operator: string, value: unknown) {
        // Mirror Zotero: an operator the condition does not declare throws.
        if (condition === "year" && !YEAR_OPERATORS.has(operator)) {
          throw new Error(
            `Invalid operator '${operator}' for condition 'year'`,
          );
        }
        if (condition === "date" && !DATE_OPERATORS.has(operator)) {
          throw new Error(
            `Invalid operator '${operator}' for condition 'date'`,
          );
        }
        conditions.push({ condition, operator, value });
      }
      async search() {
        return searchResultIds;
      }
    }
    const makeItem = (id: number, year: string, title: string) => ({
      id,
      parentID: false,
      libraryID: 1,
      isAnnotation: () => false,
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
      getField: (name: string) =>
        name === "year" || name === "date"
          ? year
          : name === "title"
            ? title
            : "",
      getCreators: () => [],
      getTags: () => [],
      getCollections: () => [],
      getAttachments: () => [],
      getDisplayTitle: () => title,
    });
    items = new Map([
      [1, makeItem(1, "2019", "Too early")],
      [2, makeItem(2, "2021", "In range")],
      [3, makeItem(3, "2024", "Too late")],
    ]);
    searchResultIds = [1, 2, 3];

    (globalThis as Record<string, unknown>).Zotero = {
      Search: FakeSearch,
      Items: {
        get: (id: number) => items.get(id) || null,
        getAll: async () => [...items.values()],
      },
      Collections: { getByLibrary: () => [] },
      debug: () => undefined,
    };
  }

  beforeEach(function () {
    libraryIndexService.clearForTests();
    installFakeZotero();
  });
  afterEach(function () {
    libraryIndexService.clearForTests();
    delete (globalThis as Record<string, unknown>).Zotero;
  });

  it("returns matches for a text search combined with a year filter", async function () {
    const gateway = new ZoteroGateway();
    (gateway as unknown as { getItem: (id: number) => unknown }).getItem = (
      id: number,
    ) => items.get(id) || null;

    // This is the user-visible bug: the throw was caught and turned into an
    // empty result, so the agent reported "no matching library results" for
    // every text search that carried a year bound.
    const result = await gateway.searchAllLibraryItems({
      libraryID: 1,
      query: "range",
      filters: { yearFrom: 2020, yearTo: 2023 },
    });

    assert.equal(result.totalCount, 1);
    assert.equal(result.items[0].title, "In range");
  });

  it("surfaces a broken query instead of reporting an empty library", async function () {
    const gateway = new ZoteroGateway();
    (gateway as unknown as { getItem: (id: number) => unknown }).getItem = (
      id: number,
    ) => items.get(id) || null;

    // Force the search itself to fail, the way an unsupported operator did.
    const zotero = (globalThis as Record<string, any>).Zotero;
    const Broken = class {
      addCondition() {}
      async search(): Promise<number[]> {
        throw new Error(
          "Invalid operator 'isGreaterThan' for condition 'year'",
        );
      }
    };
    zotero.Search = Broken;

    let message = "";
    try {
      await gateway.searchAllLibraryItems({ libraryID: 1, query: "anything" });
      assert.fail("a broken query must not resolve");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // Previously this returned { items: [], totalCount: 0 }, so the agent
    // told the user their library contained nothing matching.
    assert.include(message, "Invalid operator");
  });

  it("uses a date range rather than an unsupported year operator", async function () {
    const gateway = new ZoteroGateway();
    (gateway as unknown as { getItem: (id: number) => unknown }).getItem = (
      id: number,
    ) => items.get(id) || null;

    await gateway.listItemsByFilters({
      libraryID: 1,
      filters: { yearFrom: 2020, yearTo: 2023 },
    });

    const yearConditions = conditions.filter((c) => c.condition === "year");
    assert.lengthOf(
      yearConditions,
      0,
      "`year` has no range operators, so it must not be used for a range",
    );
    const dateConditions = conditions.filter((c) => c.condition === "date");
    assert.deepEqual(
      dateConditions.map((c) => `${c.operator} ${c.value}`),
      ["isAfter 2019", "isBefore 2024"],
    );
  });

  it("returns the in-range item instead of nothing", async function () {
    const gateway = new ZoteroGateway();
    (gateway as unknown as { getItem: (id: number) => unknown }).getItem = (
      id: number,
    ) => items.get(id) || null;

    const result = await gateway.listItemsByFilters({
      libraryID: 1,
      filters: { yearFrom: 2020, yearTo: 2023 },
    });

    assert.equal(result.totalCount, 1);
    assert.equal(result.items[0].title, "In range");
  });

  it("enforces the exact bound that SQL string comparison cannot", async function () {
    // `date isAfter '2019'` compares against '2019-00-00', so anything later
    // in 2019 leaks through SQL. The JS bound has to catch it.
    items.set(4, {
      id: 4,
      parentID: false,
      libraryID: 1,
      isAnnotation: () => false,
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
      getField: (name: string) =>
        name === "year" ? "2019" : name === "title" ? "Late 2019" : "",
      getCreators: () => [],
      getTags: () => [],
      getCollections: () => [],
      getAttachments: () => [],
      getDisplayTitle: () => "Late 2019",
    });
    searchResultIds = [4];

    const gateway = new ZoteroGateway();
    (gateway as unknown as { getItem: (id: number) => unknown }).getItem = (
      id: number,
    ) => items.get(id) || null;

    const result = await gateway.listItemsByFilters({
      libraryID: 1,
      filters: { yearFrom: 2020 },
    });

    assert.equal(result.totalCount, 0);
  });

  it("filters by author without opening an OR block", async function () {
    const gateway = new ZoteroGateway();
    (gateway as unknown as { getItem: (id: number) => unknown }).getItem = (
      id: number,
    ) => items.get(id) || null;

    await gateway.listItemsByFilters({
      libraryID: 1,
      filters: { author: "Peyrache", collectionId: 7 },
    });

    // A block sets hasQuicksearch, which flips every other condition to OR —
    // so "by Peyrache in collection 7" returned everything by Peyrache plus
    // everything in collection 7.
    assert.notInclude(
      conditions.map((c) => c.condition),
      "blockStart",
    );
    assert.deepEqual(
      conditions.filter((c) => c.condition === "creator"),
      [{ condition: "creator", operator: "contains", value: "Peyrache" }],
    );
  });
});

import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { createLibrarySearchTool } from "../src/agent/tools/read/librarySearch";
import { createSavedSearchTool } from "../src/agent/tools/write/savedSearches";

/**
 * The agent had nine hand-written filters against Zotero's own ~130 search
 * conditions. Growing them one at a time is how it stayed at nine, so
 * `conditions[]` forwards the vocabulary instead of mirroring it.
 */
describe("library_search advanced conditions", function () {
  type Cond = {
    condition: string;
    operator: string;
    value: unknown;
    required?: boolean;
  };
  let added: Cond[];
  let searchIds: number[];
  let items: Map<number, Record<string, unknown>>;
  // Zotero 10 replaced the `required` flag with groupStart/groupEnd markers
  // and throws on the flag; 7-9 accept the flag and know no markers.
  let groupsSupported: boolean;

  // A small slice of Zotero's real condition table, including the operator
  // sets that matter for the tests.
  const CONDITIONS: Record<string, { operators: Record<string, boolean> }> = {
    title: {
      operators: { is: true, isNot: true, contains: true, beginsWith: true },
    },
    year: {
      operators: {
        is: true,
        isNot: true,
        contains: true,
        doesNotContain: true,
      },
    },
    dateAdded: {
      operators: { is: true, isBefore: true, isAfter: true, isInTheLast: true },
    },
    fulltextContent: { operators: { contains: true, doesNotContain: true } },
    joinMode: { operators: { any: true, all: true } },
    deleted: { operators: { true: true, false: true } },
    blockStart: { operators: {} },
  };
  const GROUP_CONDITIONS: Record<
    string,
    { operators: Record<string, boolean> }
  > = {
    groupStart: { operators: { true: true } },
    groupEnd: { operators: { true: true } },
  };

  function makeItem(
    id: number,
    title: string,
    parentID: number | false = false,
  ) {
    return {
      id,
      parentID,
      libraryID: 1,
      isAnnotation: () => false,
      isRegularItem: () => !parentID,
      isAttachment: () => Boolean(parentID),
      isNote: () => false,
      getField: (name: string) => (name === "title" ? title : ""),
      getCreators: () => [],
      getTags: () => [],
      getCollections: () => [],
      getAttachments: () => [],
      getDisplayTitle: () => title,
    };
  }

  beforeEach(function () {
    added = [];
    items = new Map([
      [1, makeItem(1, "Parent paper")],
      [2, makeItem(2, "Its PDF", 1)],
      [3, makeItem(3, "Another paper")],
    ]);
    searchIds = [1, 3];
    groupsSupported = false;

    class FakeSearch {
      id?: number;
      libraryID = 0;
      name = "";
      addCondition(
        condition: string,
        operator: string,
        value: unknown,
        required?: boolean,
      ) {
        if (required && groupsSupported) {
          throw new Error(
            "The 'required' parameter is no longer supported; use a condition group",
          );
        }
        added.push(
          required
            ? { condition, operator, value, required }
            : { condition, operator, value },
        );
      }
      getConditions() {
        return {};
      }
      removeCondition() {}
      async saveTx() {
        this.id = 42;
        return this.id;
      }
      async search() {
        return searchIds;
      }
    }

    (globalThis as Record<string, unknown>).Zotero = {
      Search: FakeSearch,
      Items: { get: (id: number) => items.get(id) || null },
      SearchConditions: {
        get: (name: string) =>
          CONDITIONS[name] ??
          (groupsSupported ? GROUP_CONDITIONS[name] : undefined),
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

  it("forwards conditions straight to Zotero's search engine", async function () {
    const result = await gateway().searchItemsByConditions({
      libraryID: 1,
      conditions: [
        { condition: "title", operator: "contains", value: "paper" },
        { condition: "dateAdded", operator: "isAfter", value: "2024" },
      ],
    });

    assert.deepEqual(added, [
      { condition: "title", operator: "contains", value: "paper" },
      { condition: "dateAdded", operator: "isAfter", value: "2024" },
    ]);
    assert.equal(result.totalCount, 2);
  });

  it("names the valid operators when a pairing is wrong", async function () {
    let message = "";
    try {
      await gateway().searchItemsByConditions({
        libraryID: 1,
        // The exact mistake that broke every year-filtered search.
        conditions: [
          { condition: "year", operator: "isGreaterThan", value: "2020" },
        ],
      });
      assert.fail("an invalid operator must be rejected");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // An error the model cannot act on is as useless as an empty result.
    assert.include(message, "isGreaterThan");
    assert.include(message, "Valid operators");
    assert.include(message, "doesNotContain");
  });

  it("rejects an unknown condition instead of throwing mid-build", async function () {
    let message = "";
    try {
      await gateway().searchItemsByConditions({
        libraryID: 1,
        conditions: [
          { condition: "title", operator: "contains", value: "x" },
          { condition: "notAThing", operator: "is", value: "y" },
        ],
      });
      assert.fail("an unknown condition must be rejected");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "notAThing");
    // Validation runs before anything is added, so no half-built search.
    assert.deepEqual(added, []);
  });

  it("refuses grouping blocks, which flip the whole query to OR", async function () {
    let message = "";
    try {
      await gateway().searchItemsByConditions({
        libraryID: 1,
        conditions: [{ condition: "blockStart", operator: "is" }],
      });
      assert.fail("blocks must not be exposed");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "AND to OR");
  });

  it("resolves child matches to their parent when asked", async function () {
    searchIds = [2];
    const result = await gateway().searchItemsByConditions({
      libraryID: 1,
      conditions: [
        { condition: "fulltextContent", operator: "contains", value: "method" },
      ],
      resolveToParents: true,
    });
    // Without this, a full-text hit on the PDF is dropped and the search
    // looks empty.
    assert.equal(result.totalCount, 1);
    assert.equal(result.items[0].title, "Parent paper");
  });

  it("resolves an annotation match to the paper, not its PDF", async function () {
    // An annotation's parent is the PDF attachment; the paper is one level
    // further up. A one-level walk returned the attachment, which then could
    // not dedupe with the paper's own match or pass a collection filter.
    items.set(4, {
      ...makeItem(4, "Highlight", 2),
      isAnnotation: () => true,
      isAttachment: () => false,
    });
    searchIds = [4, 1];
    const result = await gateway().searchItemsByConditions({
      libraryID: 1,
      conditions: [
        { condition: "fulltextContent", operator: "contains", value: "x" },
      ],
      resolveToParents: true,
    });
    assert.equal(result.totalCount, 1);
    assert.deepEqual(
      result.items.map((item) => item.itemId),
      [1],
    );
  });

  it("drops child matches when parents were not requested", async function () {
    searchIds = [2];
    const result = await gateway().searchItemsByConditions({
      libraryID: 1,
      conditions: [{ condition: "title", operator: "contains", value: "PDF" }],
    });
    assert.equal(result.totalCount, 0);
  });

  it("sets joinMode and the trash flag as conditions", async function () {
    await gateway().searchItemsByConditions({
      libraryID: 1,
      conditions: [{ condition: "title", operator: "contains", value: "x" }],
      joinMode: "any",
      includeTrashed: true,
    });
    assert.deepEqual(added[0], {
      condition: "joinMode",
      operator: "any",
      value: "",
    });
    assert.deepEqual(added[1], {
      condition: "deleted",
      operator: "true",
      value: "",
    });
  });

  it("appends the sub-mode Zotero expects", async function () {
    await gateway().searchItemsByConditions({
      libraryID: 1,
      conditions: [
        {
          condition: "fulltextContent",
          operator: "contains",
          value: "hippocampus",
          mode: "regexp",
        },
      ],
    });
    assert.equal(added[0].condition, "fulltextContent/regexp");
  });

  it("pages the id list before enriching, and reports where to resume", async function () {
    searchIds = Array.from({ length: 500 }, (_v, i) => i + 100);
    for (const id of searchIds) items.set(id, makeItem(id, `Paper ${id}`));

    const result = await gateway().searchItemsByConditions({
      libraryID: 1,
      conditions: [
        { condition: "title", operator: "contains", value: "Paper" },
      ],
      limit: 50,
    });

    assert.equal(result.totalCount, 500);
    assert.equal(result.returnedCount, 50, "only the page is built");
    assert.equal(result.nextOffset, 50);

    const second = await gateway().searchItemsByConditions({
      libraryID: 1,
      conditions: [
        { condition: "title", operator: "contains", value: "Paper" },
      ],
      limit: 50,
      offset: 50,
    });
    assert.equal(second.items[0].title, "Paper 150");
  });

  it("caps the page size so one condition cannot flood the context", async function () {
    searchIds = Array.from({ length: 5000 }, (_v, i) => i + 100);
    for (const id of searchIds) items.set(id, makeItem(id, `P${id}`));
    const result = await gateway().searchItemsByConditions({
      libraryID: 1,
      conditions: [{ condition: "title", operator: "contains", value: "P" }],
      limit: 100000,
    });
    assert.equal(result.returnedCount, 200);
  });

  it("omits nextOffset once the walk is finished", async function () {
    const result = await gateway().searchItemsByConditions({
      libraryID: 1,
      conditions: [
        { condition: "title", operator: "contains", value: "paper" },
      ],
    });
    assert.isUndefined(result.nextOffset);
  });

  describe("required clauses across Zotero versions", function () {
    const conditions = [
      {
        condition: "title",
        operator: "contains",
        value: "must",
        required: true,
      },
      { condition: "title", operator: "contains", value: "may" },
      { condition: "year", operator: "is", value: "2024" },
    ];

    it("forwards the native flag where Zotero still takes it", async function () {
      await gateway().searchItemsByConditions({
        libraryID: 1,
        conditions,
        joinMode: "any",
      });
      assert.deepEqual(added, [
        { condition: "joinMode", operator: "any", value: "" },
        {
          condition: "title",
          operator: "contains",
          value: "must",
          required: true,
        },
        { condition: "title", operator: "contains", value: "may" },
        { condition: "year", operator: "is", value: "2024" },
      ]);
    });

    it("nests the optional clauses in an OR group where the flag is gone", async function () {
      groupsSupported = true;
      await gateway().searchItemsByConditions({
        libraryID: 1,
        conditions,
        joinMode: "any",
        includeTrashed: true,
      });
      // Same meaning as 7-9: must AND (may OR 2024).
      assert.deepEqual(added, [
        { condition: "joinMode", operator: "all", value: "" },
        { condition: "deleted", operator: "true", value: "" },
        { condition: "title", operator: "contains", value: "must" },
        { condition: "groupStart", operator: "true", value: "" },
        { condition: "joinMode", operator: "any", value: "" },
        { condition: "title", operator: "contains", value: "may" },
        { condition: "year", operator: "is", value: "2024" },
        { condition: "groupEnd", operator: "true", value: "" },
      ]);
    });

    it("drops the flag under joinMode all, where it never changed anything", async function () {
      groupsSupported = true;
      await gateway().searchItemsByConditions({
        libraryID: 1,
        conditions,
        joinMode: "all",
      });
      assert.deepEqual(added, [
        { condition: "joinMode", operator: "all", value: "" },
        { condition: "title", operator: "contains", value: "must" },
        { condition: "title", operator: "contains", value: "may" },
        { condition: "year", operator: "is", value: "2024" },
      ]);
    });

    it("opens no group when every clause is required", async function () {
      groupsSupported = true;
      await gateway().searchItemsByConditions({
        libraryID: 1,
        conditions: conditions.slice(0, 1),
        joinMode: "any",
      });
      assert.deepEqual(added, [
        { condition: "joinMode", operator: "all", value: "" },
        { condition: "title", operator: "contains", value: "must" },
      ]);
    });

    it("leaves a plain OR search alone", async function () {
      groupsSupported = true;
      await gateway().searchItemsByConditions({
        libraryID: 1,
        conditions: conditions.slice(1),
        joinMode: "any",
      });
      assert.deepEqual(added, [
        { condition: "joinMode", operator: "any", value: "" },
        { condition: "title", operator: "contains", value: "may" },
        { condition: "year", operator: "is", value: "2024" },
      ]);
    });

    it("persists a saved search with the same group shape", async function () {
      groupsSupported = true;
      const saved = await gateway().saveSavedSearch({
        libraryID: 1,
        name: "Required clause",
        conditions: conditions.slice(0, 2),
        joinMode: "any",
      });
      assert.equal(saved.status, "created");
      assert.deepEqual(
        added.map((entry) => `${entry.condition}:${entry.operator}`),
        [
          "joinMode:all",
          "title:contains",
          "groupStart:true",
          "joinMode:any",
          "title:contains",
          "groupEnd:true",
        ],
      );
    });

    it("refuses raw group markers, which only the builder may place", async function () {
      groupsSupported = true;
      let message = "";
      try {
        await gateway().searchItemsByConditions({
          libraryID: 1,
          conditions: [{ condition: "groupStart", operator: "true" }],
        });
        assert.fail("markers must not be exposed");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.include(message, "isRequired");
      assert.deepEqual(added, []);
    });
  });

  describe("tool-level gating", function () {
    function tool() {
      return createLibrarySearchTool(gateway());
    }

    for (const isRequired of [true, false, undefined]) {
      it(`preserves isRequired=${String(isRequired)} in both search tools`, function () {
        const conditions = [
          {
            condition: "title",
            operator: "contains",
            value: "paper",
            isRequired,
          },
        ];
        const query = tool().validate({
          entity: "items",
          mode: "search",
          conditions,
          joinMode: "any",
        });
        const saved = createSavedSearchTool(gateway()).validate({
          action: "save",
          name: "Required clause",
          conditions,
          joinMode: "any",
        });
        assert.isTrue(query.ok);
        assert.isTrue(saved.ok);
        if (!query.ok || !saved.ok) return;
        assert.equal(
          query.value.conditions?.[0].required,
          isRequired || undefined,
        );
        assert.equal(query.value.joinMode, "any");
        assert.equal(saved.value.operation.type, "save_saved_search");
        if (saved.value.operation.type !== "save_saved_search") return;
        assert.equal(
          saved.value.operation.conditions[0].required,
          isRequired || undefined,
        );
        assert.equal(saved.value.operation.joinMode, "any");
      });
    }

    it("refuses conditions on entities that are not searched that way", function () {
      const result = tool().validate({
        entity: "collections",
        mode: "list",
        conditions: [{ condition: "title", operator: "contains", value: "x" }],
      });
      assert.isFalse(result.ok);
    });

    it("refuses filters that are applied outside the search engine", function () {
      // hasPdf routes to a different engine; untagged is a JS filter. Honouring
      // one and ignoring the other would return a confidently wrong result.
      for (const filters of [{ hasPdf: true }, { untagged: true }]) {
        const result = tool().validate({
          entity: "items",
          mode: "search",
          filters,
          conditions: [
            { condition: "title", operator: "contains", value: "x" },
          ],
        });
        assert.isFalse(result.ok, JSON.stringify(filters));
      }
    });

    it("no longer demands text when conditions are supplied", function () {
      const result = tool().validate({
        entity: "items",
        mode: "search",
        conditions: [{ condition: "title", operator: "contains", value: "x" }],
      });
      assert.isTrue(result.ok);
    });

    it("still demands text for a plain search", function () {
      const result = tool().validate({ entity: "items", mode: "search" });
      assert.isFalse(result.ok);
    });
  });
});

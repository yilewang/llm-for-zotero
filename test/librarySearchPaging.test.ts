import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { createLibrarySearchTool } from "../src/agent/tools/read/librarySearch";

/**
 * Notes search stopped at its limit and reported the page as the whole
 * answer (totalCount = returnedCount, limited false), and neither notes nor
 * text search could be paged. A capped result now says so, with the true
 * total, and offset walks the rest.
 */
describe("library_search paging for notes, tags, duplicates, and text search", function () {
  type Paged = {
    results: Array<{ itemId: number }>;
    totalCount: number;
    returnedCount: number;
    limited: boolean;
    offset: number;
    nextOffset?: number;
  };

  async function run(
    gateway: unknown,
    args: Record<string, unknown>,
  ): Promise<Paged> {
    const tool = createLibrarySearchTool(gateway as never);
    const parsed = tool.validate({ libraryID: 1, ...args });
    assert.isTrue(parsed.ok, JSON.stringify(parsed));
    if (!parsed.ok) throw new Error("validation failed");
    return (await tool.execute(parsed.value, {
      request: {},
      item: null,
    } as never)) as Paged;
  }

  const ids = (result: Paged) => result.results.map((row) => row.itemId);

  describe("notes search", function () {
    function notesGateway(total: number) {
      const all = Array.from({ length: total }, (_v, i) => ({
        itemId: 100 + i,
        itemType: "note",
        title: `Note ${i}`,
        attachments: [],
        tags: [],
        collectionIds: [],
        noteKind: "standalone",
      }));
      const received: Array<Record<string, unknown>> = [];
      return {
        received,
        gateway: {
          searchAllNotesPage: async (params: {
            limit?: number;
            offset?: number;
          }) => {
            received.push(params);
            const offset = params.offset || 0;
            const limit = params.limit || 200;
            return {
              notes: all.slice(offset, offset + limit),
              totalCount: all.length,
            };
          },
          getActiveContextItem: () => null,
        },
      };
    }

    it("reports the true total and limited when the limit caps the matches", async function () {
      const { gateway, received } = notesGateway(7);
      const result = await run(gateway, {
        entity: "notes",
        mode: "search",
        text: "drift",
        limit: 3,
      });
      assert.equal(received[0].limit, 3);
      assert.equal(result.totalCount, 7);
      assert.equal(result.returnedCount, 3);
      assert.isTrue(result.limited);
      assert.equal(result.nextOffset, 3);
    });

    it("pages through every match with offset", async function () {
      const { gateway, received } = notesGateway(7);
      const seen: number[] = [];
      let offset: number | undefined = 0;
      let calls = 0;
      while (offset !== undefined && calls < 5) {
        const page = await run(gateway, {
          entity: "notes",
          mode: "search",
          text: "drift",
          limit: 3,
          offset,
        });
        assert.equal(page.offset, offset);
        seen.push(...ids(page));
        offset = page.nextOffset;
        calls += 1;
      }
      assert.equal(calls, 3);
      assert.deepEqual(
        received.map((params) => params.offset ?? 0),
        [0, 3, 6],
      );
      assert.deepEqual(
        seen,
        Array.from({ length: 7 }, (_v, i) => 100 + i),
      );
    });

    it("says limited is false once the last page is returned", async function () {
      const { gateway } = notesGateway(7);
      const last = await run(gateway, {
        entity: "notes",
        mode: "search",
        text: "drift",
        limit: 3,
        offset: 6,
      });
      assert.equal(last.totalCount, 7);
      assert.equal(last.returnedCount, 1);
      assert.isFalse(last.limited);
      assert.isUndefined(last.nextOffset);
    });
  });

  describe("notes list", function () {
    function listGateway(total: number) {
      const all = Array.from({ length: total }, (_v, i) => ({
        itemId: 200 + i,
        itemType: "note",
        title: `Standalone ${i}`,
        attachments: [],
        tags: [],
        collectionIds: [],
        noteKind: "standalone",
      }));
      const received: Array<Record<string, unknown>> = [];
      return {
        received,
        gateway: {
          listStandaloneNotes: async (params: {
            limit?: number;
            offset?: number;
          }) => {
            received.push(params);
            const offset = params.offset || 0;
            const end = params.limit ? offset + params.limit : undefined;
            return { notes: all.slice(offset, end), totalCount: all.length };
          },
        },
      };
    }

    it("pages every standalone note exactly once", async function () {
      const { gateway, received } = listGateway(5);
      const seen: number[] = [];
      let offset: number | undefined = 0;
      let calls = 0;
      while (offset !== undefined && calls < 5) {
        const page = await run(gateway, {
          entity: "notes",
          mode: "list",
          limit: 2,
          offset,
        });
        assert.equal(page.totalCount, 5);
        assert.equal(page.offset, offset);
        assert.equal(page.limited, page.nextOffset !== undefined);
        seen.push(...ids(page));
        offset = page.nextOffset;
        calls += 1;
      }
      assert.equal(calls, 3);
      assert.deepEqual(
        received.map((params) => params.offset ?? 0),
        [0, 2, 4],
      );
      assert.deepEqual(seen, [200, 201, 202, 203, 204]);
    });
  });

  describe("tag list", function () {
    function tagsGateway(total: number) {
      const all = Array.from({ length: total }, (_v, i) => ({
        name: `tag-${i}`,
        type: 0,
      }));
      const received: Array<Record<string, unknown>> = [];
      return {
        received,
        gateway: {
          listLibraryTagsPage: async (params: {
            limit?: number;
            offset?: number;
          }) => {
            received.push(params);
            const offset = params.offset || 0;
            const end = params.limit ? offset + params.limit : undefined;
            return { tags: all.slice(offset, end), totalCount: all.length };
          },
        },
      };
    }

    type TagPage = Omit<Paged, "results"> & {
      results: Array<{ name: string }>;
    };

    it("reports the true total and pages every tag exactly once", async function () {
      const { gateway, received } = tagsGateway(5);
      const seen: string[] = [];
      let offset: number | undefined = 0;
      let calls = 0;
      while (offset !== undefined && calls < 5) {
        const page = (await run(gateway, {
          entity: "tags",
          mode: "list",
          limit: 2,
          offset,
        })) as unknown as TagPage;
        assert.equal(page.totalCount, 5);
        assert.equal(page.offset, offset);
        assert.equal(page.limited, page.nextOffset !== undefined);
        seen.push(...page.results.map((tag) => tag.name));
        offset = page.nextOffset;
        calls += 1;
      }
      assert.equal(calls, 3);
      assert.deepEqual(
        received.map((params) => params.offset ?? 0),
        [0, 2, 4],
      );
      assert.deepEqual(seen, ["tag-0", "tag-1", "tag-2", "tag-3", "tag-4"]);
    });
  });

  describe("duplicate groups", function () {
    function duplicatesGateway(total: number) {
      const all = Array.from({ length: total }, (_v, i) => ({
        matchReason: `Same DOI: 10.1/${i}`,
        papers: [300 + i * 2, 301 + i * 2].map((itemId) => ({
          itemId,
          itemType: "journalArticle",
          title: `Twin ${i}`,
          attachments: [],
          tags: [],
          collectionIds: [],
        })),
      }));
      const received: Array<Record<string, unknown>> = [];
      return {
        received,
        gateway: {
          detectDuplicatesInLibrary: async (params: {
            limit?: number;
            offset?: number;
          }) => {
            received.push(params);
            const offset = params.offset || 0;
            const limit = params.limit || 20;
            return {
              groups: all.slice(offset, offset + limit),
              totalGroups: all.length,
            };
          },
        },
      };
    }

    type GroupPage = Omit<Paged, "results"> & {
      totalGroups: number;
      results: Array<{ papers: Array<{ itemId: number }> }>;
    };

    it("reports the true group total and pages every group exactly once", async function () {
      const { gateway, received } = duplicatesGateway(7);
      const pages: GroupPage[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined && pages.length < 5) {
        const page = (await run(gateway, {
          entity: "items",
          mode: "duplicates",
          limit: 3,
          offset,
        })) as unknown as GroupPage;
        pages.push(page);
        offset = page.nextOffset;
      }
      assert.deepEqual(
        received.map((params) => [params.limit, params.offset ?? 0]),
        [
          [3, 0],
          [3, 3],
          [3, 6],
        ],
      );
      assert.deepEqual(
        pages.map((page) => [page.totalCount, page.totalGroups]),
        [
          [7, 7],
          [7, 7],
          [7, 7],
        ],
      );
      assert.deepEqual(
        pages.map((page) => page.limited),
        [true, true, false],
      );
      assert.deepEqual(
        pages.map((page) => page.nextOffset),
        [3, 6, undefined],
      );
      const firstIds = pages.flatMap((page) =>
        page.results.map((group) => group.papers[0].itemId),
      );
      assert.deepEqual(
        firstIds,
        Array.from({ length: 7 }, (_v, i) => 300 + i * 2),
      );
    });
  });

  describe("text search", function () {
    let items: Map<number, Record<string, unknown>>;
    const SEARCH_IDS = [11, 12, 13, 14, 15];

    function makeItem(id: number) {
      return {
        id,
        parentID: false,
        libraryID: 1,
        itemTypeID: 1,
        isAnnotation: () => false,
        isRegularItem: () => true,
        isAttachment: () => false,
        isNote: () => false,
        getField: (name: string) => (name === "title" ? `Paper ${id}` : ""),
        getCreators: () => [],
        getTags: () => [],
        getCollections: () => [],
        getAttachments: () => [],
        getDisplayTitle: () => `Paper ${id}`,
      };
    }

    beforeEach(function () {
      items = new Map(SEARCH_IDS.map((id) => [id, makeItem(id)]));
      class FakeSearch {
        addCondition() {}
        async search() {
          return SEARCH_IDS;
        }
      }
      (globalThis as Record<string, unknown>).Zotero = {
        Search: FakeSearch,
        Items: { get: (id: number) => items.get(id) || null },
        ItemTypes: { getName: () => "journalArticle" },
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
      (
        g as unknown as { getActiveContextItem: () => unknown }
      ).getActiveContextItem = () => null;
      return g;
    }

    it("returns the next rows on page 2", async function () {
      const first = await gateway().searchAllLibraryItems({
        libraryID: 1,
        query: "paper",
        limit: 2,
      });
      const second = await gateway().searchAllLibraryItems({
        libraryID: 1,
        query: "paper",
        limit: 2,
        offset: 2,
      });
      assert.deepEqual(
        first.items.map((item) => item.itemId),
        [11, 12],
      );
      assert.deepEqual(
        second.items.map((item) => item.itemId),
        [13, 14],
      );
      assert.equal(second.totalCount, 5);
    });

    it("carries offset and nextOffset through library_search", async function () {
      const second = await run(gateway(), {
        entity: "items",
        mode: "search",
        text: "paper",
        limit: 2,
        offset: 2,
      });
      assert.deepEqual(ids(second), [13, 14]);
      assert.equal(second.totalCount, 5);
      assert.equal(second.offset, 2);
      assert.equal(second.nextOffset, 4);
      assert.isTrue(second.limited);

      const last = await run(gateway(), {
        entity: "items",
        mode: "search",
        text: "paper",
        limit: 2,
        offset: 4,
      });
      assert.deepEqual(ids(last), [15]);
      assert.isFalse(last.limited);
      assert.isUndefined(last.nextOffset);
    });
  });
});

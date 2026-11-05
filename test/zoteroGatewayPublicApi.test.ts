import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";

/**
 * `getZoteroGateway()` hands the gateway to third-party plugins, so a method
 * they already call keeps its return shape. The paged siblings carry the
 * true totals.
 */
describe("ZoteroGateway public return shapes", function () {
  function gatewayWith(capabilities: Record<string, unknown>): ZoteroGateway {
    const gateway = new ZoteroGateway();
    Object.assign(gateway as unknown as Record<string, unknown>, capabilities);
    return gateway;
  }

  it("listLibraryTags still returns the tag array; the Page method adds the total", async function () {
    const page = {
      tags: [{ name: "memory", type: 0 }],
      totalCount: 9,
    };
    const received: unknown[] = [];
    const gateway = gatewayWith({
      tagCapability: {
        listLibraryTags: async (params: unknown) => {
          received.push(params);
          return page;
        },
      },
    });
    const params = { libraryID: 1, query: "mem", limit: 1, offset: 2 };

    const plain = await gateway.listLibraryTags(params);
    assert.isTrue(Array.isArray(plain));
    assert.deepEqual(plain, page.tags);
    assert.deepEqual(await gateway.listLibraryTagsPage(params), page);
    assert.deepEqual(received, [params, params]);
  });

  it("searchAllNotes still returns the note array; the Page method adds the total", async function () {
    const page = {
      notes: [{ itemId: 5 }],
      totalCount: 12,
    };
    const received: unknown[] = [];
    const gateway = gatewayWith({
      noteCapability: {
        searchAllNotes: async (params: unknown) => {
          received.push(params);
          return page;
        },
      },
    });
    const params = { libraryID: 1, query: "needle", limit: 1, offset: 3 };

    const plain = await gateway.searchAllNotes(params);
    assert.isTrue(Array.isArray(plain));
    assert.deepEqual(plain, page.notes);
    assert.deepEqual(await gateway.searchAllNotesPage(params), page);
    assert.deepEqual(received, [params, params]);
  });
});

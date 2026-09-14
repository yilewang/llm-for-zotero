import { assert } from "chai";
import { createQueryLibraryTool } from "../src/agent/tools/read/queryLibrary";

describe("library trash search scope", function () {
  for (const deleted of [true, false]) {
    it(`preserves explicit deleted:${deleted} through the public search tool`, async function () {
      let received: Record<string, any> | undefined;
      const tool = createQueryLibraryTool({
        getActiveContextItem: () => null,
        searchAllLibraryItems: async (params: Record<string, any>) => {
          received = params;
          return { items: [], totalCount: 0 };
        },
      } as never);
      const parsed = tool.validate({
        entity: "items",
        mode: "search",
        libraryID: 1,
        text: "Metadata-only population code",
        filters: { deleted },
        limit: 10,
      });
      assert.isTrue(parsed.ok);
      if (!parsed.ok) return;
      await tool.execute(parsed.value, {} as never);
      assert.deepInclude(received?.filters, { deleted });
    });
  }
});

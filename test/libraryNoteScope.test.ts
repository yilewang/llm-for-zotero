import { assert } from "chai";
import { createQueryLibraryTool } from "../src/agent/tools/read/queryLibrary";

describe("note discovery collection scope", function () {
  for (const mode of ["list", "search"] as const) {
    it(`passes exact collection scope to the native ${mode} owner`, async function () {
      let received: Record<string, unknown> | undefined;
      const tool = createQueryLibraryTool({
        listStandaloneNotes: async (params: Record<string, unknown>) => {
          received = params;
          return { notes: [], totalCount: 0 };
        },
        searchAllNotes: async (params: Record<string, unknown>) => {
          received = params;
          return [];
        },
      } as never);
      const parsed = tool.validate({
        entity: "notes",
        mode,
        libraryID: 1,
        text: "summary",
        filters: { collectionId: 79 },
        limit: 5,
      });
      assert.isTrue(parsed.ok);
      if (!parsed.ok) return;
      await tool.execute(parsed.value, {} as never);
      assert.deepInclude(received, {
        libraryID: 1,
        collectionId: 79,
        limit: 5,
      });
    });
  }
});

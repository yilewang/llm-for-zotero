import { assert } from "chai";
import {
  buildLibraryOverviewSection,
  renderLibraryOverviewSection,
  setLibraryOverviewGateway,
} from "../src/agent/context/libraryOverview";
import {
  applySort,
  applyOffset,
} from "../src/agent/services/libraryQueryService";
import { createQueryLibraryTool } from "../src/agent/tools/read/queryLibrary";
import { buildAgentInitialMessages } from "../src/agent/model/messageBuilder";
import type { AgentToolContext } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

/**
 * The system prompt described the user's machine in concrete detail — shell,
 * path separator, a worked `ls` example — and said nothing about the Zotero
 * library. Every request therefore started with a guess about which folders
 * exist and what they are called, which is why the agent ended up asking
 * users for a collection ID that Zotero itself never displays (issue #374).
 */
describe("library perception", function () {
  afterEach(function () {
    setLibraryOverviewGateway(null);
  });

  const gateway = {
    listAllLibraries: () => [
      { libraryID: 1, name: "My Library", editable: true },
      { libraryID: 4, name: "Lab Group", editable: false },
    ],
    listCollectionSummaries: () => [
      {
        collectionId: 12,
        name: "Neuroscience",
        libraryID: 1,
        path: "Neuroscience",
      },
      {
        collectionId: 13,
        name: "Methods",
        libraryID: 1,
        path: "Neuroscience > Methods",
      },
    ],
  } as never;

  it("names the active library and its collections with IDs", function () {
    const section = buildLibraryOverviewSection(gateway, 1);
    assert.include(section, "My Library");
    assert.include(section, "libraryID=1");
    assert.include(
      section,
      "Neuroscience (id=12)",
      "the ID is what stops the agent asking the user for a number",
    );
  });

  it("flags a read-only library the agent must not try to write to", function () {
    const section = buildLibraryOverviewSection(gateway, 4);
    assert.include(section, "READ-ONLY");
  });

  it("lists top-level collections only, pointing at the tree tool for depth", function () {
    const section = buildLibraryOverviewSection(gateway, 1);
    assert.include(section, "Neuroscience (id=12)");
    assert.notInclude(
      section,
      "Methods (id=13)",
      "nested collections belong to the tree tool, not the standing header",
    );
  });

  it("degrades to nothing when no gateway is registered", function () {
    setLibraryOverviewGateway(null);
    assert.equal(
      renderLibraryOverviewSection(1),
      "",
      "a missing enhancement must never be able to fail a turn",
    );
  });
});

/**
 * "The 50 most recently added papers" was not expressible: there was no sort
 * of any kind, and the limit was a head slice.
 */
describe("library_search ordering and paging", function () {
  const rows = [
    { itemId: 1, dateAdded: "2026-01-01", title: "Beta" },
    { itemId: 2, dateAdded: "2026-08-01", title: "Alpha" },
    { itemId: 3, dateAdded: "2026-04-01", title: "Gamma" },
  ];

  it("sorts newest first by default", function () {
    assert.deepEqual(
      applySort(rows, "dateAdded", undefined).map((r) => r.itemId),
      [2, 3, 1],
    );
  });

  it("honours an ascending request", function () {
    assert.deepEqual(
      applySort(rows, "dateAdded", "asc").map((r) => r.itemId),
      [1, 3, 2],
    );
  });

  it("sorts titles alphabetically", function () {
    assert.deepEqual(
      applySort(rows, "title", undefined).map((r) => r.itemId),
      [2, 1, 3],
    );
  });

  it("leaves the order alone for an unknown sort key", function () {
    assert.deepEqual(
      applySort(rows, "nonsense", undefined).map((r) => r.itemId),
      [1, 2, 3],
    );
  });

  it("sorts undated rows last in both directions", function () {
    const withGap = [...rows, { itemId: 4, dateAdded: "", title: "Delta" }];
    assert.equal(applySort(withGap, "dateAdded", "asc").at(-1)?.itemId, 4);
    assert.equal(applySort(withGap, "dateAdded", "desc").at(-1)?.itemId, 4);
  });

  it("takes a window so a chain can walk past its first page", function () {
    assert.deepEqual(
      applyOffset(rows, 2).map((r) => r.itemId),
      [3],
    );
    assert.deepEqual(
      applyOffset(rows, 0).map((r) => r.itemId),
      [1, 2, 3],
    );
  });
});

/**
 * The unit tests above call applySort/applyOffset directly, which cannot
 * catch a path that never passes them through — and the review found exactly
 * that: hasPdf:true short-circuited into a head slice, and order:'desc' was
 * normalized away before it reached the service. These drive the real tool.
 */
describe("library_search ordering through the tool", function () {
  const context: AgentToolContext = {
    request: {
      conversationKey: 5,
      mode: "agent",
      userText: "recent",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  };

  const targets = [
    {
      itemId: 1,
      title: "Beta",
      dateAdded: "2026-01-01",
      attachments: [
        { contextItemId: 101, title: "PDF", contentType: "application/pdf" },
      ],
      tags: [],
      collectionIds: [],
    },
    {
      itemId: 2,
      title: "Alpha",
      dateAdded: "2026-08-01",
      attachments: [
        { contextItemId: 102, title: "PDF", contentType: "application/pdf" },
      ],
      tags: [],
      collectionIds: [],
    },
    {
      itemId: 3,
      title: "Gamma",
      dateAdded: "2026-04-01",
      attachments: [
        { contextItemId: 103, title: "PDF", contentType: "application/pdf" },
      ],
      tags: [],
      collectionIds: [],
    },
  ];

  function makeTool() {
    return createQueryLibraryTool({
      resolveLibraryID: () => 1,
      listBibliographicItemTargets: async () => ({
        items: targets,
        totalCount: targets.length,
      }),
      listLibraryPaperTargets: async () => ({
        papers: targets,
        totalCount: targets.length,
      }),
      listItemsByFilters: async ({
        sort,
        order,
        offset,
        limit,
      }: {
        sort?: "dateAdded" | "title";
        order?: "asc" | "desc";
        offset?: number;
        limit?: number;
      }) => {
        const sorted = applySort(targets, sort, order);
        const windowed = applyOffset(sorted, offset);
        const items =
          Number.isFinite(limit) && Number(limit) > 0
            ? windowed.slice(0, Math.floor(Number(limit)))
            : windowed;
        return { items, totalCount: targets.length };
      },
      getItemCollectionIds: () => [],
      getItem: () => null,
      getEditableArticleMetadata: () => undefined,
      getCollectionSummary: () => null,
    } as never);
  }

  async function run(args: Record<string, unknown>) {
    const tool = makeTool();
    const validated = tool.validate(args);
    assert.isTrue(validated.ok, JSON.stringify(validated));
    if (!validated.ok) throw new Error("unreachable");
    const output = (await tool.execute(validated.value, context)) as {
      results?: Array<{ itemId: number }>;
    };
    return (output.results || []).map((r) => r.itemId);
  }

  it("sorts newest first on the PDF-only path, which used to head-slice", async function () {
    const ids = await run({
      entity: "items",
      mode: "list",
      filters: { hasPdf: true },
      sort: "dateAdded",
      limit: 2,
    });
    assert.deepEqual(ids, [2, 3], "library order would have returned [1, 2]");
  });

  it("honours an explicit descending title order", async function () {
    const ids = await run({
      entity: "items",
      mode: "list",
      sort: "title",
      order: "desc",
    });
    assert.deepEqual(
      ids,
      [3, 1, 2],
      "order:'desc' used to be normalized away, silently returning A-Z",
    );
  });

  it("pages with offset instead of returning the same first page", async function () {
    const first = await run({
      entity: "items",
      mode: "list",
      sort: "dateAdded",
      limit: 1,
    });
    const second = await run({
      entity: "items",
      mode: "list",
      sort: "dateAdded",
      limit: 1,
      offset: 1,
    });
    assert.notDeepEqual(first, second, "a paging chain would loop forever");
    assert.deepEqual(first, [2]);
    assert.deepEqual(second, [3]);
  });
});

/**
 * The overview names collection ids and a collection count, both of which
 * change the moment the agent creates a folder. The cache breakpoint sits at
 * the last "stable-prefix" system block, so putting this in a system section
 * invalidated the whole cached prefix on the next turn — for Anthropic's
 * explicit caching and for the automatic prefix caching DeepSeek and Kimi do.
 */
describe("library overview stays out of the cached prefix", function () {
  afterEach(function () {
    setLibraryOverviewGateway(null);
  });

  it("is absent from the system prompt", async function () {
    setLibraryOverviewGateway({
      listAllLibraries: () => [
        { libraryID: 1, name: "My Library", editable: true },
      ],
      listCollectionSummaries: () => [
        {
          collectionId: 12,
          name: "Neuroscience",
          libraryID: 1,
          path: "Neuroscience",
        },
      ],
    } as never);

    const messages = await buildAgentInitialMessages(
      resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        userText: "what is in my library",
        libraryID: 1,
      }),
      [],
      [],
    );

    const systemText = messages
      .filter((m) => m.role === "system")
      .map((m) => String(m.content ?? ""))
      .join("\n");
    assert.notInclude(
      systemText,
      "Neuroscience (id=12)",
      "a collection id in the cached prefix invalidates it whenever a folder is created",
    );

    const userText = messages
      .filter((m) => m.role === "user")
      .map((m) => String(m.content ?? ""))
      .join("\n");
    assert.include(
      userText,
      "Neuroscience (id=12)",
      "the agent still has to be able to see it",
    );
  });
});

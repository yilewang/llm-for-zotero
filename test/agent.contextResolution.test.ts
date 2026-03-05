import { assert } from "chai";
import { resolveAgentContext } from "../src/modules/contextPanel/Agent/ToolInfra/context";
import { invalidatePaperSearchCache } from "../src/modules/contextPanel/paperSearch";

type MockCreator = { firstName?: string; lastName?: string };
type MockItem = {
  id: number;
  parentID?: number;
  firstCreator?: string;
  dateModified?: string;
  attachmentContentType?: string;
  isRegularItem: () => boolean;
  isAttachment: () => boolean;
  getAttachments: () => number[];
  getCollections: () => number[];
  getCreators: () => MockCreator[];
  getField: (field: string) => string;
};

function makeAttachment(params: {
  id: number;
  title: string;
  parentID?: number;
}): MockItem {
  return {
    id: params.id,
    parentID: params.parentID,
    attachmentContentType: "application/pdf",
    isRegularItem: () => false,
    isAttachment: () => true,
    getAttachments: () => [],
    getCollections: () => [],
    getCreators: () => [],
    getField: (field: string) => (field === "title" ? params.title : ""),
  };
}

function makeRegularItem(params: {
  id: number;
  title: string;
  firstCreator?: string;
  year?: string;
  abstractNote?: string;
  attachmentIDs: number[];
  dateModified?: string;
}): MockItem {
  return {
    id: params.id,
    firstCreator: params.firstCreator,
    dateModified: params.dateModified || "2025-01-01T00:00:00.000Z",
    isRegularItem: () => true,
    isAttachment: () => false,
    getAttachments: () => [...params.attachmentIDs],
    getCollections: () => [],
    getCreators: () =>
      params.firstCreator
        ? [{ firstName: "", lastName: params.firstCreator }]
        : [],
    getField: (field: string) => {
      switch (field) {
        case "title":
          return params.title;
        case "date":
          return params.year || "";
        case "firstCreator":
          return params.firstCreator || "";
        case "abstractNote":
          return params.abstractNote || "";
        default:
          return "";
      }
    },
  };
}

describe("agent context resolution depth staging", function () {
  const originalZotero = globalThis.Zotero;
  const itemsById = new Map<number, MockItem>();
  let quickSearchResultIDs: number[] = [];
  const addPaper = (params: {
    id: number;
    attachmentId: number;
    title: string;
    firstCreator?: string;
    year?: string;
    abstractNote?: string;
  }) => {
    const regular = makeRegularItem({
      id: params.id,
      title: params.title,
      firstCreator: params.firstCreator,
      year: params.year,
      abstractNote: params.abstractNote,
      attachmentIDs: [params.attachmentId],
    });
    const attachment = makeAttachment({
      id: params.attachmentId,
      title: `${params.title} PDF`,
      parentID: params.id,
    });
    itemsById.set(params.id, regular);
    itemsById.set(params.attachmentId, attachment);
  };

  beforeEach(function () {
    itemsById.clear();
    quickSearchResultIDs = [];
    invalidatePaperSearchCache(1);

    addPaper({
      id: 1,
      attachmentId: 101,
      title: "Hippocampus memory study",
      firstCreator: "Smith",
      year: "2024",
      abstractNote:
        "This study investigates hippocampus pathways and reports major thematic patterns.",
    });

    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Items: {
        get: (id: number) => itemsById.get(id) || null,
        getAll: async () => Array.from(itemsById.values()) as any,
      },
      Collections: {
        getByLibrary: () => [],
      },
      Search: class {
        libraryID?: number;
        addCondition(): void {
          // no-op for tests
        }
        async search(): Promise<number[]> {
          return [...quickSearchResultIDs];
        }
      },
    } as unknown as typeof Zotero;
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("marks metadata count stage as high sufficiency", async function () {
    quickSearchResultIDs = [1];
    const result = await resolveAgentContext({
      question: "How many hippocampus papers are in my library?",
      libraryID: 1,
      conversationMode: "open",
      plan: {
        action: "library-search",
        searchQuery: "hippocampus",
        maxPapersToRead: 6,
        depth: "metadata",
      },
    });

    assert.isNotNull(result);
    assert.equal(result?.depthAchieved, "metadata");
    assert.equal(result?.sufficiency, "high");
    assert.include(result?.contextPrefix || "", "quicksearch regular-item");
    assert.include(
      (result?.traceLines || []).join("\n"),
      "sufficiency=high (metadata count available)",
    );
    assert.include(
      (result?.traceLines || []).join("\n"),
      "Count-only metadata stage: skipped per-paper follow-up candidate selection.",
    );
  });

  it("includes abstract snippets in abstract stage", async function () {
    const result = await resolveAgentContext({
      question: "What themes are common in my hippocampus papers?",
      libraryID: 1,
      conversationMode: "open",
      plan: {
        action: "library-search",
        searchQuery: "hippocampus",
        maxPapersToRead: 6,
        depth: "abstract",
      },
    });

    assert.isNotNull(result);
    assert.equal(result?.depthAchieved, "abstract");
    assert.equal(result?.sufficiency, "high");
    assert.include(result?.contextPrefix || "", "Abstract:");
    assert.include(result?.contextPrefix || "", "hippocampus pathways");
  });

  it("keeps metadata stage abstract-free and recommends abstract tier for thematic queries", async function () {
    const result = await resolveAgentContext({
      question: "What themes are common in my hippocampus papers?",
      libraryID: 1,
      conversationMode: "open",
      plan: {
        action: "library-search",
        searchQuery: "hippocampus",
        maxPapersToRead: 6,
        depth: "metadata",
      },
    });

    assert.isNotNull(result);
    assert.equal(result?.depthAchieved, "metadata");
    assert.equal(result?.sufficiency, "low");
    assert.notInclude(result?.contextPrefix || "", "Abstract:");
    assert.include(
      (result?.traceLines || []).join("\n"),
      "Metadata stage: skipped per-paper follow-up candidate selection.",
    );
    assert.include(
      (result?.traceLines || []).join("\n"),
      "sufficiency=low (abstract tier recommended)",
    );
  });

  it("reports full selected count (not capped to 4) when abstract follow-up candidates exceed 4", async function () {
    addPaper({
      id: 2,
      attachmentId: 102,
      title: "Hippocampus coding study 2",
      firstCreator: "Author2",
      year: "2023",
      abstractNote: "Abstract 2",
    });
    addPaper({
      id: 3,
      attachmentId: 103,
      title: "Hippocampus coding study 3",
      firstCreator: "Author3",
      year: "2023",
      abstractNote: "Abstract 3",
    });
    addPaper({
      id: 4,
      attachmentId: 104,
      title: "Hippocampus coding study 4",
      firstCreator: "Author4",
      year: "2022",
      abstractNote: "Abstract 4",
    });
    addPaper({
      id: 5,
      attachmentId: 105,
      title: "Hippocampus coding study 5",
      firstCreator: "Author5",
      year: "2022",
      abstractNote: "Abstract 5",
    });
    addPaper({
      id: 6,
      attachmentId: 106,
      title: "Hippocampus coding study 6",
      firstCreator: "Author6",
      year: "2021",
      abstractNote: "Abstract 6",
    });

    const result = await resolveAgentContext({
      question: "Read paper details in my hippocampus library set.",
      libraryID: 1,
      conversationMode: "open",
      plan: {
        action: "library-search",
        searchQuery: "hippocampus",
        maxPapersToRead: 6,
        depth: "abstract",
      },
    });

    assert.isNotNull(result);
    const trace = (result?.traceLines || []).join("\n");
    assert.include(trace, "Selected papers (6 of 6 matches):");
    assert.include(trace, "+2 more");
  });
});

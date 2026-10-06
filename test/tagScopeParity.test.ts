import { assert } from "chai";
import { resolveMultiContextPlan } from "../src/modules/contextPanel/multiContextPlanner";
import { resolveTaskPaperScopeItemIds } from "../src/agent/context/taskPaperScopeListing";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { libraryIndexService } from "../src/services/libraryIndexService";
import { pdfTextCache } from "../src/services/paperContent/contextCache";
import { buildChunkMetadata } from "../src/services/paperContent/pdfContext";
import type {
  CollectionContextRef,
  TagContextRef,
} from "../src/modules/contextPanel/types";
import type { PdfContext } from "../src/services/paperContent/types";

/**
 * One library, read by every resolver that turns a tag into papers:
 * - the plain-chat planner (`resolveMultiContextPlan`, its tag manifest);
 * - the snapshot union (`ZoteroGateway.resolveLibraryScopeItemIds` and the
 *   Task progress listing `resolveTaskPaperScopeItemIds`);
 * - the agent's tag listing (`ZoteroGateway.listTagItemTargets`), which
 *   lists items rather than papers.
 * Each case pins what each one returns for the same tag selection.
 */

const NFC_CAFE = "Café";
const NFD_CAFE = "Café";

type Seed = {
  id: number;
  kind?: "regular" | "note" | "attachment";
  parentID?: number;
  title?: string;
  tags?: Array<{ tag: string; type?: number }>;
  collections?: number[];
  attachments?: number[];
  contentType?: string;
  filename?: string;
  deleted?: boolean;
};

/**
 * 101 "Café" (NFC), PDF.            102 "Café" (NFD), PDF.
 * 103 "café", no PDF (HTML only).   104 "CAFÉ", PDF, in the trash.
 * 105 "Café" automatic only, PDF.   107 untagged, its PDF 106 tagged "Café".
 * 108 standalone PDF tagged "Café". 109 standalone note tagged "Café".
 * 110 "Learning", PDF.              111 untagged, PDF.
 * 112 untagged, no attachment.      113 "CAFÉ" (upper case), PDF.
 * Folder 50 holds 101; its child folder 51 holds 110.
 */
function seeds(): Seed[] {
  const pdf = (id: number, parentID: number): Seed => ({
    id,
    kind: "attachment",
    parentID,
    contentType: "application/pdf",
    filename: `${parentID}.pdf`,
  });
  return [
    {
      id: 101,
      title: "NFC Cafe Paper",
      tags: [{ tag: NFC_CAFE }],
      attachments: [1101],
      collections: [50],
    },
    pdf(1101, 101),
    {
      id: 102,
      title: "NFD Cafe Paper",
      tags: [{ tag: NFD_CAFE }],
      attachments: [1102],
    },
    pdf(1102, 102),
    {
      id: 103,
      title: "Lower Cafe No PDF",
      tags: [{ tag: "café" }],
      attachments: [1103],
    },
    {
      id: 1103,
      kind: "attachment",
      parentID: 103,
      contentType: "text/html",
      filename: "snapshot.html",
    },
    {
      id: 104,
      title: "Trashed Cafe Paper",
      tags: [{ tag: "CAFÉ" }],
      attachments: [1104],
      deleted: true,
    },
    pdf(1104, 104),
    {
      id: 105,
      title: "Automatic Cafe Paper",
      tags: [{ tag: NFC_CAFE, type: 1 }],
      attachments: [1105],
    },
    pdf(1105, 105),
    {
      id: 106,
      kind: "attachment",
      parentID: 107,
      contentType: "application/pdf",
      filename: "107.pdf",
      tags: [{ tag: NFC_CAFE }],
    },
    { id: 107, title: "Tagged Child Paper", attachments: [106] },
    {
      id: 108,
      kind: "attachment",
      contentType: "application/pdf",
      filename: "standalone.pdf",
      tags: [{ tag: NFC_CAFE }],
    },
    { id: 109, kind: "note", tags: [{ tag: NFC_CAFE }] },
    {
      id: 110,
      title: "Learning Paper",
      tags: [{ tag: "Learning" }],
      attachments: [1110],
      collections: [51],
    },
    pdf(1110, 110),
    { id: 111, title: "Untagged PDF Paper", attachments: [1111] },
    pdf(1111, 111),
    { id: 112, title: "Untagged Bare Paper" },
    {
      id: 113,
      title: "Upper Cafe Paper",
      tags: [{ tag: "CAFÉ" }],
      attachments: [1113],
    },
    pdf(1113, 113),
  ];
}

function makeItem(seed: Seed): Zotero.Item {
  const kind = seed.kind || "regular";
  return {
    id: seed.id,
    key: `ITEM-${seed.id}`,
    libraryID: 1,
    parentID: seed.parentID || false,
    parentItemID: seed.parentID || false,
    itemType: kind === "regular" ? "journalArticle" : kind,
    attachmentContentType: seed.contentType || "",
    attachmentFilename: seed.filename || "",
    dateAdded: "2026-01-01 00:00:00",
    dateModified: "2026-01-02 00:00:00",
    firstCreator: "",
    get deleted() {
      return seed.deleted === true;
    },
    isRegularItem: () => kind === "regular",
    isNote: () => kind === "note",
    isAttachment: () => kind === "attachment",
    getField: (name: string) =>
      name === "title" ? seed.title || `Item ${seed.id}` : "",
    getDisplayTitle: () => seed.title || `Item ${seed.id}`,
    getNoteTitle: () => seed.title || `Note ${seed.id}`,
    getNote: () => "",
    getCreators: () => [],
    getTags: () => seed.tags || [],
    getCollections: () => seed.collections || [],
    getAttachments: () => seed.attachments || [],
    getNotes: () => [],
  } as unknown as Zotero.Item;
}

function pdfContext(title: string): PdfContext {
  const chunks = [`${title} discusses cafe culture.`];
  return {
    title,
    chunks,
    chunkMeta: buildChunkMetadata(chunks),
    chunkStats: [
      {
        index: 0,
        length: 5,
        tf: { cafe: 1, culture: 1 },
        uniqueTerms: ["cafe", "culture"],
      },
    ],
    docFreq: { cafe: 1, culture: 1 },
    avgChunkLength: 5,
    fullLength: chunks[0].length,
  };
}

type Fixture = { seedById: Map<number, Seed> };

function installFixture(): Fixture {
  const all = seeds();
  const seedById = new Map(all.map((seed) => [seed.id, seed]));
  const itemById = new Map(all.map((seed) => [seed.id, makeItem(seed)]));
  const collections = [
    { id: 50, name: "Cafes", parentID: false, childCollections: [51] },
    { id: 51, name: "Learning", parentID: 50, childCollections: [] },
  ].map((seed) => ({
    id: seed.id,
    libraryID: 1,
    name: seed.name,
    parentID: seed.parentID,
    deleted: false,
    // Live folder membership, read from the items like Zotero does.
    getChildItems: () =>
      all
        .filter((entry) => (entry.collections || []).includes(seed.id))
        .map((entry) => entry.id),
    getChildCollections: () => seed.childCollections,
  }));
  const collectionById = new Map(collections.map((c) => [c.id, c]));
  const prefs: Record<string, unknown> = {};
  (globalThis as { ztoolkit?: unknown }).ztoolkit = { log: () => undefined };
  (globalThis as { Zotero?: unknown }).Zotero = {
    Items: {
      get: (id: number) => itemById.get(Number(id)) || null,
      // Zotero.Items.getAll(libraryID, onlyTopLevel, includeDeleted, asIDs)
      getAll: async (
        libraryID: number,
        onlyTopLevel?: boolean,
        includeDeleted?: boolean,
      ) =>
        (libraryID === 1 ? all : [])
          .filter((seed) => !onlyTopLevel || !seed.parentID)
          .filter((seed) => includeDeleted || !seed.deleted)
          .map((seed) => itemById.get(seed.id)!),
    },
    Collections: {
      get: (id: number) => collectionById.get(Number(id)) || null,
      getByLibrary: (libraryID: number) =>
        libraryID === 1 ? [...collectionById.values()] : [],
    },
    Tags: { getID: () => false, getTagItems: async () => [] },
    Libraries: { getName: () => "Fixture Library" },
    Prefs: {
      get: (key: string) => prefs[key],
      set: (key: string, value: unknown) => {
        prefs[key] = value;
      },
    },
    PDFWorker: {
      getFullText: async (id: number) => ({ text: `Attachment ${id}` }),
    },
    debug: () => undefined,
  };
  for (const seed of all) {
    if (seed.kind === "attachment" && seed.contentType === "application/pdf") {
      pdfTextCache.set(seed.id, pdfContext(`Attachment ${seed.id}`));
    }
  }
  return { seedById };
}

type PlannerScope = { scopeLine: string; itemIds: number[] };

/** The plain-chat planner's tag manifest: its scope line and its papers. */
async function plannerScope(params: {
  tagContexts?: TagContextRef[];
  collectionContexts?: CollectionContextRef[];
}): Promise<PlannerScope> {
  const plan = await resolveMultiContextPlan({
    conversationMode: "open",
    activeContextItem: null,
    question: "What do these papers say about cafes?",
    tagContexts: params.tagContexts,
    collectionContexts: params.collectionContexts,
    paperContexts: [],
    fullTextPaperContexts: [],
    historyPaperContexts: [],
    history: [],
    model: "gpt-4o-mini",
    advanced: {
      temperature: 0.2,
      outputTokenLimit: { mode: "custom", tokens: 512 },
      inputTokenCap: 12_000,
    },
  });
  const text = plan.contextText;
  const scopeLine =
    text
      .split("\n")
      .find((line) => /^- .*\[(tag|tagScope|collectionId)=/.test(line)) || "";
  const manifestStart = text.indexOf("Scope manifest (PDF-backed papers):");
  const manifest =
    manifestStart >= 0 ? text.slice(manifestStart).split("\n\n")[0] : "";
  const itemIds = [...manifest.matchAll(/itemId=(\d+)/g)]
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
  return { scopeLine, itemIds };
}

/** The snapshot union retrieval and Task progress share. */
async function snapshotScope(tag: TagContextRef): Promise<number[]> {
  const gateway = await new ZoteroGateway().resolveLibraryScopeItemIds({
    libraryID: 1,
    tagContexts: [tag],
  });
  const snapshot = await libraryIndexService.getSnapshot(1);
  const listing = resolveTaskPaperScopeItemIds(snapshot, { tags: [tag] });
  assert.deepEqual(
    [...listing].sort((a, b) => a - b),
    [...gateway.itemIds].sort((a, b) => a - b),
    "the Task progress listing and retrieval share one union",
  );
  return [...gateway.itemIds].sort((a, b) => a - b);
}

/** The agent's tag listing: items holding the tag, not only papers. */
async function tagListing(tag: TagContextRef): Promise<number[]> {
  const result = await new ZoteroGateway().listTagItemTargets({
    libraryID: 1,
    tagContext: tag,
  });
  return result.items.map((item) => item.itemId).sort((a, b) => a - b);
}

type Case = {
  name: string;
  tag: TagContextRef;
  planner: { scopeLine: string; itemIds: number[] };
  snapshot: number[];
  tagListing: number[];
};

const CASES: Case[] = [
  {
    // NFC: the planner compares code points, so the decomposed "Café" (102)
    // is a different tag; the index folds both to NFC.
    // PDF-only: the planner keeps only papers with a PDF (103 has HTML).
    // Trash, automatic tags, a tagged child PDF, standalone notes and
    // files: left out by both.
    // Case: both ignore case (113 "CAFÉ").
    name: "composed name, chip-normalized",
    tag: { name: NFC_CAFE, normalizedName: "café", libraryID: 1 },
    planner: {
      scopeLine: `- ${NFC_CAFE} [tag=${NFC_CAFE}, libraryID=1, papers=2]`,
      itemIds: [101, 113],
    },
    snapshot: [101, 102, 103, 113],
    tagListing: [101, 102, 103, 108, 109, 113],
  },
  {
    name: "decomposed name, chip-normalized",
    tag: { name: NFD_CAFE, normalizedName: "café", libraryID: 1 },
    planner: {
      scopeLine: `- ${NFD_CAFE} [tag=${NFD_CAFE}, libraryID=1, papers=1]`,
      itemIds: [102],
    },
    snapshot: [101, 102, 103, 113],
    tagListing: [101, 102, 103, 108, 109, 113],
  },
  {
    name: "automatic tags included",
    tag: {
      name: NFC_CAFE,
      normalizedName: "café",
      libraryID: 1,
      includeAutomatic: true,
    },
    planner: {
      scopeLine: `- ${NFC_CAFE} [tag=${NFC_CAFE}, libraryID=1, papers=3]`,
      itemIds: [101, 105, 113],
    },
    snapshot: [101, 102, 103, 105, 113],
    tagListing: [101, 102, 103, 105, 108, 109, 113],
  },
  {
    // Name priority: the planner looks up the normalized name, the
    // snapshot resolvers look up the display name.
    name: "display name and normalized name disagree",
    tag: { name: "Learning", normalizedName: "café", libraryID: 1 },
    planner: {
      scopeLine: "- Learning [tag=Learning, libraryID=1, papers=2]",
      itemIds: [101, 113],
    },
    snapshot: [110],
    tagListing: [110],
  },
  {
    // An empty display name: the planner drops the tag; the snapshot
    // resolvers fall back to the normalized name.
    name: "empty display name",
    tag: { name: "", normalizedName: "learning", libraryID: 1 },
    planner: { scopeLine: "", itemIds: [] },
    snapshot: [110],
    tagListing: [110],
  },
  {
    // PDF-only: 107 (its PDF is tagged, it is not) and 111 have PDFs; 112
    // has none.
    name: "untagged aggregate",
    tag: { name: "Untagged", libraryID: 1, scope: "untagged" },
    planner: {
      scopeLine: "- Untagged [tagScope=untagged, libraryID=1, papers=3]",
      itemIds: [105, 107, 111],
    },
    snapshot: [105, 107, 111, 112],
    tagListing: [105, 107, 111, 112],
  },
  {
    name: "all-tagged aggregate",
    tag: { name: "All Tagged", libraryID: 1, scope: "allTagged" },
    planner: {
      scopeLine: "- All Tagged [tagScope=allTagged, libraryID=1, papers=4]",
      itemIds: [101, 102, 110, 113],
    },
    snapshot: [101, 102, 103, 110, 113],
    tagListing: [101, 102, 103, 108, 109, 110, 113],
  },
];

describe("tag scope parity: plain-chat planner vs library index snapshot", function () {
  const originalZotero = (globalThis as { Zotero?: unknown }).Zotero;
  const originalZtoolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
  let fixture: Fixture;

  beforeEach(function () {
    libraryIndexService.clearForTests();
    fixture = installFixture();
  });

  afterEach(function () {
    libraryIndexService.clearForTests();
    pdfTextCache.clear();
    (globalThis as { Zotero?: unknown }).Zotero = originalZotero;
    (globalThis as { ztoolkit?: unknown }).ztoolkit = originalZtoolkit;
  });

  for (const testCase of CASES) {
    it(`pins each resolver for: ${testCase.name}`, async function () {
      const planner = await plannerScope({ tagContexts: [testCase.tag] });
      assert.deepEqual(planner, testCase.planner, "plain-chat planner");
      assert.deepEqual(
        await snapshotScope(testCase.tag),
        testCase.snapshot,
        "snapshot union",
      );
      assert.deepEqual(
        await tagListing(testCase.tag),
        testCase.tagListing,
        "agent tag listing",
      );
    });
  }

  it("pins staleness: the planner reads live tags, the snapshot reads the index until notified", async function () {
    const tag: TagContextRef = {
      name: "Learning",
      normalizedName: "learning",
      libraryID: 1,
    };
    assert.deepEqual(await snapshotScope(tag), [110]);
    // Zotero tags 111 "Learning"; the index has not been told yet.
    fixture.seedById.get(111)!.tags = [{ tag: "Learning" }];
    assert.deepEqual(
      (await plannerScope({ tagContexts: [tag] })).itemIds,
      [110, 111],
    );
    assert.deepEqual(await snapshotScope(tag), [110]);
    // The notifier reports the change; the index reconciles before reading.
    await libraryIndexService.handleChange({
      event: "modify",
      type: "item",
      ids: [111],
      extraData: { libraryID: 1 },
      receivedAt: Date.now(),
    });
    assert.deepEqual(await snapshotScope(tag), [110, 111]);
  });

  it("pins folders: the planner expands subfolders, the snapshot union does not", async function () {
    const planner = await plannerScope({
      collectionContexts: [{ collectionId: 50, name: "Cafes", libraryID: 1 }],
    });
    assert.deepEqual(planner, {
      scopeLine: "- Cafes [collectionId=50, libraryID=1, papers=2]",
      itemIds: [101, 110],
    });
    const gateway = await new ZoteroGateway().resolveLibraryScopeItemIds({
      libraryID: 1,
      collectionIds: [50],
    });
    assert.deepEqual(gateway.itemIds, [101]);
  });
});

import { assert } from "chai";
import { pdfTextCache } from "../src/services/paperContent/contextCache";
import {
  buildDocumentOutline,
  ensurePDFTextCached,
} from "../src/services/paperContent/pdfContext";
import { writeMineruCacheFiles } from "../src/services/mineru/mineruCache";
import { documentPageMap } from "../src/agent/tools/read/documentSectionReads";
import { preparePaperPromptContext } from "../src/agent/context/paperPromptContext";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import {
  mockPdfAttachment,
  restoreTestGlobals,
  setupMemoryIO,
  setupZoteroGlobals,
  snapshotTestGlobals,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";

const encoder = new TextEncoder();

describe("MinerU title block in the outline", function () {
  let globals: TestGlobalSnapshot;
  beforeEach(function () {
    globals = snapshotTestGlobals();
    setupMemoryIO();
    setupZoteroGlobals();
    pdfTextCache.clear();
  });
  afterEach(function () {
    pdfTextCache.clear();
    restoreTestGlobals(globals);
  });

  it("keeps a paper flat when its title heads every section's path", async function () {
    const paragraph = (topic: string) =>
      `${topic} is described in plain words over a few sentences. `.repeat(6);
    const md = [
      "# Adaptive Front Tracking for Thin Films",
      "Ada Lovelace, Analytical Engine Institute",
      "## 1 Introduction",
      paragraph("The problem"),
      "## 2 Methods",
      paragraph("The method"),
      "### 2.1 Weak form",
      paragraph("The weak form"),
      "## 3 Results",
      paragraph("The result"),
    ].join("\n\n");
    const contentList = [
      {
        type: "text",
        text: "Adaptive Front Tracking for Thin Films",
        text_level: 1,
        page_idx: 0,
      },
      { type: "text", text: "1 Introduction", text_level: 2, page_idx: 0 },
      { type: "text", text: "2 Methods", text_level: 2, page_idx: 0 },
      { type: "text", text: "2.1 Weak form", text_level: 3, page_idx: 1 },
      { type: "text", text: "3 Results", text_level: 2, page_idx: 1 },
    ];
    await writeMineruCacheFiles(7301, md, [
      { relativePath: "full.md", data: encoder.encode(md) },
      {
        relativePath: "content_list.json",
        data: encoder.encode(JSON.stringify(contentList)),
      },
    ]);
    await ensurePDFTextCached(mockPdfAttachment(7301));
    const context = pdfTextCache.get(7301)!;
    assert.equal(context.sourceType, "mineru");
    const outline = buildDocumentOutline(context);
    assert.isUndefined(outline.chaptered);
    const top = outline.sections.filter((section) => !section.parentId);
    assert.deepEqual(
      top.map((section) => section.title),
      [
        "Adaptive Front Tracking for Thin Films",
        "1 Introduction",
        "2 Methods",
        "3 Results",
      ],
    );
    // The title is not the parent of the paper's sections.
    assert.deepEqual(top[0].childIds, []);
    const methods = top[2];
    assert.deepEqual(
      methods.childIds.map(
        (id) => outline.sections.find((s) => s.sectionId === id)!.title,
      ),
      ["2.1 Weak form"],
    );
  });

  it("gives MinerU text, whose chunks carry their section's start page, no page map", async function () {
    const paragraph = (topic: string) =>
      `${topic} is described in plain words over a few sentences. `.repeat(60);
    const md = [
      "# A Title",
      "## 1 Introduction",
      paragraph("Intro"),
      paragraph("Intro2"),
      "## 2 Methods",
      paragraph("M1"),
      paragraph("M2"),
      paragraph("M3"),
      "## 3 Results",
      paragraph("R"),
    ].join("\n\n");
    const contentList = [
      { type: "text", text: "A Title", text_level: 1, page_idx: 0 },
      { type: "text", text: "1 Introduction", text_level: 2, page_idx: 0 },
      { type: "text", text: "2 Methods", text_level: 2, page_idx: 2 },
      { type: "text", text: "3 Results", text_level: 2, page_idx: 6 },
    ];
    await writeMineruCacheFiles(7302, md, [
      { relativePath: "full.md", data: encoder.encode(md) },
      {
        relativePath: "content_list.json",
        data: encoder.encode(JSON.stringify(contentList)),
      },
    ]);
    await ensurePDFTextCached(mockPdfAttachment(7302));
    const context = pdfTextCache.get(7302)!;
    assert.equal(context.sourceType, "mineru");
    assert.isTrue(
      context.chunkMeta.every((meta) => meta.pageStart !== undefined),
      "the chunks carry page numbers, but only their section's first page",
    );
    assert.isUndefined(context.textPages);
    assert.isNull(documentPageMap(context));
    // A budget the text does not fit keeps today's partial text.
    const paper = {
      libraryID: 1,
      itemId: 100,
      contextItemId: 7302,
      title: "A Title",
    };
    const prepared = await preparePaperPromptContext(
      resolvedAgentRequest({
        conversationKey: 900452,
        mode: "agent",
        libraryID: 1,
        userText: "Explain",
        activePaperContext: paper,
        conversationKind: "paper",
      }),
      { tokenBudget: 400, load: async () => context },
    );
    assert.include(prepared.blocks[0], "Partial text:");
  });
});

/**
 * A long document with chapters is read by its map, in real Zotero, against
 * real PDFs that pdf-lib generates and Zotero's own PDF worker extracts:
 * - with bookmarks, the map comes from them (read by the plugin's pdf-lib
 *   worker, no reader tab); without them, from the numbered headings that
 *   open pages; each chapter's pages match Zotero's own page text;
 * - the paper prompt carries the map (ids, pages, sizes) and no body text,
 *   while a short paper still carries its whole text;
 * - paper_read with sectionIds reads a leaf whole with passage ids, answers
 *   a chapter by its sections, and reads the chapter with whole:true;
 * - an overview gives the map and the picked opening part, never the whole
 *   text;
 * - text that only Zotero's full-text cache holds gets no map and keeps
 *   today's whole-text preload;
 * - a short paper with bookmarks keeps its whole-text preload; one whose
 *   whole text does not fit the context left is preloaded as a page map and
 *   read by its pages, never cut.
 *
 * The section-picking reader is a scripted stub (no live provider); the
 * extraction, the structure, the prompt context and paper_read are the
 * plugin's own.
 */
import { assert } from "chai";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import { namesOf } from "../test/helpers/sectionPickerFixtures";
import {
  createPdfWithOutline,
  type OutlineFixtureEntry,
} from "../test/helpers/outlinePdfFixture";
import { PdfService } from "../src/agent/services/pdfService";
import { PdfPageService } from "../src/agent/services/pdfPageService";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { RetrievalService } from "../src/agent/services/retrievalService";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import { preparePaperPromptContext } from "../src/agent/context/paperPromptContext";
import {
  SECTION_PICK_TASK_LINE,
  clearSectionPickCache,
} from "../src/agent/digests/sectionPicker";
import { buildDocumentOutline } from "../src/services/paperContent/pdfContext";
import { estimateTextTokens } from "../src/utils/modelInputCap";
import type { ReaderAdapterFactories } from "../src/agent/reader/resolveReader";
import type { ReaderCompletion } from "../src/shared/readerCompletion";
import type { AgentToolContext } from "../src/agent/types";
import type { PaperContextRef } from "../src/shared/types";

declare const Zotero: any;
declare const IOUtils: any;
declare const PathUtils: any;

/**
 * Pages as long as a book's: each holds more text than one chunk, so chunks
 * end at page ends, as they do in a real book.
 */
const PAGE_HEIGHT = 1500;
const LINES_PER_PAGE = 44;
const PAGE_TOP = PAGE_HEIGHT - 20;

/** Body lines that name their page, so a read's pages can be told apart. */
function body(topic: string, page: number, count = LINES_PER_PAGE): string[] {
  return Array.from(
    { length: count },
    (_, line) =>
      `${topic} p${page} line ${line + 1}: the guide adds one more point.`,
  );
}

const BOOK_PAGES: string[][] = [
  [
    "A Field Guide to Long Documents",
    "Abstract",
    "This guide explains how long documents are read part by part.",
    ...body("Front", 1, LINES_PER_PAGE - 3),
  ],
  ["Chapter 1: Foundations", ...body("Foundations", 2)],
  ["1.1 Early ideas", ...body("Foundations", 3)],
  [
    ...body("Foundations", 4, LINES_PER_PAGE / 2),
    "1.2 Later ideas",
    ...body("Foundations", 4, LINES_PER_PAGE / 2).map((line) => `More ${line}`),
  ],
  ["Chapter 2: Methods", ...body("Methods", 5)],
  ["2.1 Measurement", ...body("Methods", 6)],
  ["Chapter 3: Results", ...body("Results", 7)],
  [...body("Results", 8)],
];

/** A bookmark title in several scripts: it reaches the map unchanged. */
const RESULTS_BOOKMARK = "Ergebnisse · Результаты · 结果";

const BOOK_BOOKMARKS: OutlineFixtureEntry[] = [
  {
    title: "Foundations",
    page: 1,
    top: PAGE_TOP,
    children: [
      { title: "Early ideas", page: 2, top: PAGE_TOP },
      { title: "Later ideas", page: 3, top: PAGE_HEIGHT / 2, named: true },
    ],
  },
  {
    title: "Methods",
    page: 4,
    top: PAGE_TOP,
    children: [{ title: "Measurement", page: 5, top: PAGE_TOP }],
  },
  { title: RESULTS_BOOKMARK, page: 6, top: PAGE_TOP, named: true },
];

const PAPER_PAGES: string[][] = [
  [
    "Drift in a short paper",
    "1 Introduction",
    ...body("Paper", 1, 5),
    "2 Methods",
    ...body("Paper", 1, 5).map((line) => `Method ${line}`),
  ],
  [
    ...body("Paper", 2, 5),
    "3 Results",
    ...body("Paper", 2, 5).map((line) => `Result ${line}`),
  ],
];

/**
 * The short paper's sections as LaTeX bookmarks them: an /XYZ destination
 * at each heading, mid-page (lines are 32 units apart from y = 560).
 */
const PAPER_BOOKMARKS: OutlineFixtureEntry[] = [
  { title: "1 Introduction", page: 0, top: 540 },
  { title: "2 Methods", page: 0, top: 348 },
  { title: "3 Results", page: 1, top: 412 },
];

type Fixture = {
  paper: PaperContextRef;
  attachmentId: number;
  parentItemId: number;
  path: string;
};

describe("workflow: long documents are read by their map", function () {
  this.timeout(240000);
  const fixtures: Fixture[] = [];
  let bookmarked: Fixture;
  let headed: Fixture;
  let shortPaper: Fixture;
  let bookmarkedPaper: Fixture;
  let cacheOnly: Fixture;
  let articleGuide: Fixture;
  const getFullText = Zotero.PDFWorker.getFullText;

  async function importPdf(
    title: string,
    bytes: Uint8Array,
    parentType = "book",
  ): Promise<Fixture> {
    const parent = new Zotero.Item(parentType);
    parent.libraryID = Zotero.Libraries.userLibraryID;
    parent.setField("title", title);
    const parentItemId = Number(await parent.saveTx());
    const path = PathUtils.join(
      Zotero.getTempDirectory().path,
      `longdoc-${Date.now()}-${fixtures.length}.pdf`,
    );
    await IOUtils.write(path, bytes);
    const attachment = await Zotero.Attachments.importFromFile({
      file: path,
      parentItemID: parentItemId,
      contentType: "application/pdf",
    });
    const fixture: Fixture = {
      paper: {
        libraryID: parent.libraryID,
        itemId: parentItemId,
        contextItemId: attachment.id,
        title,
      },
      attachmentId: attachment.id,
      parentItemId,
      path,
    };
    fixtures.push(fixture);
    return fixture;
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    const stamp = Date.now();
    bookmarked = await importPdf(
      `Field guide with bookmarks ${stamp}`,
      await createPdfWithOutline({
        pages: BOOK_PAGES,
        outline: BOOK_BOOKMARKS,
        pageHeight: PAGE_HEIGHT,
      }),
    );
    headed = await importPdf(
      `Field guide without bookmarks ${stamp}`,
      await createPdfWithOutline({
        pages: BOOK_PAGES,
        pageHeight: PAGE_HEIGHT,
      }),
    );
    shortPaper = await importPdf(
      `Short paper ${stamp}`,
      await createPdfWithOutline({ pages: PAPER_PAGES }),
    );
    bookmarkedPaper = await importPdf(
      `Short paper with bookmarks ${stamp}`,
      await createPdfWithOutline({
        pages: PAPER_PAGES,
        outline: PAPER_BOOKMARKS,
      }),
    );
    // The same chaptered pages under an article parent: no chapter map.
    articleGuide = await importPdf(
      `Field guide as a journal article ${stamp}`,
      await createPdfWithOutline({
        pages: BOOK_PAGES,
        outline: BOOK_BOOKMARKS,
        pageHeight: PAGE_HEIGHT,
      }),
      "journalArticle",
    );
    // Only Zotero's full-text cache holds this copy's text: the PDF worker
    // answers nothing for it.
    cacheOnly = await importPdf(
      `Field guide from the full-text cache ${stamp}`,
      await createPdfWithOutline({
        pages: BOOK_PAGES,
        pageHeight: PAGE_HEIGHT,
      }),
    );
    const cacheItem = Zotero.Items.get(cacheOnly.attachmentId);
    const extracted = await getFullText.call(
      Zotero.PDFWorker,
      cacheOnly.attachmentId,
    );
    await IOUtils.writeUTF8(
      Zotero.Fulltext.getItemCacheFile(cacheItem).path,
      String(extracted.text),
    );
    Zotero.PDFWorker.getFullText = async (...args: unknown[]) =>
      Number(args[0]) === cacheOnly.attachmentId
        ? { text: "", extractedPages: 0, totalPages: BOOK_PAGES.length }
        : getFullText.apply(Zotero.PDFWorker, args);
  });

  after(async function () {
    Zotero.PDFWorker.getFullText = getFullText;
    clearSectionPickCache();
    for (const fixture of fixtures) {
      const parent = Zotero.Items.get(fixture.parentItemId);
      if (parent) await parent.eraseTx();
      await IOUtils.remove(fixture.path, { ignoreAbsent: true });
    }
  });

  /** A reader that picks the text before the first section for the abstract. */
  function stubReader() {
    const picks: string[] = [];
    const complete: ReaderCompletion = async (prompt) => {
      assert.include(prompt, SECTION_PICK_TASK_LINE);
      picks.push(prompt);
      return {
        text: JSON.stringify({
          parts: namesOf(prompt).map((name) =>
            name === "abstract"
              ? { name, kind: "abstract", sections: ["s0"] }
              : { name, none: true },
          ),
        }),
      };
    };
    const factories: ReaderAdapterFactories = {
      turnModel: () => complete,
      codexResponses: () => complete,
      claudeBridge: () => complete,
    };
    return { picks, factories };
  }

  function paperReadTool(factories?: ReaderAdapterFactories) {
    const pdfService = new PdfService();
    const zoteroGateway = new ZoteroGateway();
    return createPaperReadTool(
      pdfService,
      new RetrievalService(pdfService),
      new PdfPageService(pdfService, zoteroGateway),
      zoteroGateway,
      undefined,
      undefined,
      factories ? { readerFactories: factories } : {},
    );
  }

  async function read(
    fixture: Fixture,
    input: Record<string, unknown>,
    factories?: ReaderAdapterFactories,
    options: { contextWindowTokens?: number } = {},
  ): Promise<any> {
    const tool = paperReadTool(factories);
    const validated = tool.validate!({
      targets: [
        {
          itemId: fixture.paper.itemId,
          contextItemId: fixture.paper.contextItemId,
        },
      ],
      ...input,
    });
    assert.isTrue(validated.ok, JSON.stringify(validated));
    if (!validated.ok) throw new Error("invalid input");
    const request = resolvedAgentRequest({
      conversationKey: 0,
      mode: "agent",
      userText: "What does this guide say?",
      libraryID: fixture.paper.libraryID,
      model: "gpt-workflow",
    });
    Object.assign(request, {
      authMode: "codex_app_server",
      providerProtocol: "codex_responses",
      exhaustiveReadBackend: "codex_responses",
      executionContext: { permissionOwner: "external_runtime" },
    });
    if (options.contextWindowTokens !== undefined) {
      request.runtimeContextBudget = {
        contextWindowTokens: options.contextWindowTokens,
        usedContextTokens: 0,
      };
    }
    return tool.execute(validated.value, {
      request,
      item: null,
      currentAnswerText: "",
      modelName: "workflow",
    } as unknown as AgentToolContext);
  }

  function preload(fixture: Fixture, extra: Record<string, unknown> = {}) {
    return preparePaperPromptContext(
      resolvedAgentRequest({
        conversationKey: 0,
        mode: "agent",
        libraryID: fixture.paper.libraryID,
        userText: "Explain this guide",
        activePaperContext: fixture.paper,
        conversationKind: "paper",
        ...extra,
      }),
    );
  }

  /** Zotero's own page text, split at the form feeds between pages. */
  async function zoteroPages(fixture: Fixture): Promise<string[]> {
    const result = await Zotero.PDFWorker.getFullText(fixture.attachmentId);
    return String(result.text).split("\f");
  }

  it("maps a bookmarked document by its bookmarks, on Zotero's own pages", async function () {
    const context = await new PdfService().ensurePaperContext(bookmarked.paper);
    assert.equal(context?.documentStructure?.source, "bookmarks");
    const outline = buildDocumentOutline(context);
    const top = outline.sections.filter((section) => !section.parentId);
    assert.deepEqual(
      top.map((section) => [section.title, section.pageStart, section.pageEnd]),
      [
        ["(before the first section)", 1, 1],
        ["Foundations", 2, 4],
        ["Methods", 5, 6],
        [RESULTS_BOOKMARK, 7, 8],
      ],
    );
    assert.deepEqual(
      top.map((section) => section.childIds.length),
      [0, 2, 1, 0],
    );
    const pages = await zoteroPages(bookmarked);
    for (const [title, heading] of [
      ["Foundations", "Chapter 1: Foundations"],
      ["Methods", "Chapter 2: Methods"],
      [RESULTS_BOOKMARK, "Chapter 3: Results"],
    ]) {
      const section = top.find((entry) => entry.title === title)!;
      assert.match(
        pages[section.pageStart! - 1].trim(),
        new RegExp(`^${heading}`),
      );
    }
  });

  it("maps a document without bookmarks by the numbered headings that open its pages", async function () {
    const context = await new PdfService().ensurePaperContext(headed.paper);
    assert.equal(context?.documentStructure?.source, "headings");
    const outline = buildDocumentOutline(context);
    const top = outline.sections.filter((section) => !section.parentId);
    assert.deepEqual(
      top.map((section) => section.title),
      [
        "(before the first section)",
        "Chapter 1: Foundations",
        "Chapter 2: Methods",
        "Chapter 3: Results",
      ],
    );
    const chapter1 = top[1];
    assert.deepEqual(
      outline.sections
        .filter((section) => section.parentId === chapter1.sectionId)
        .map((section) => section.title),
      ["1.1 Early ideas", "1.2 Later ideas"],
    );
  });

  it("preloads the map and no body text for a document with chapters", async function () {
    const prepared = await preload(bookmarked);
    assert.lengthOf(prepared.blocks, 1);
    const block = prepared.blocks[0];
    assert.match(
      block,
      /s\d+ \| Foundations \| pages 2–4 \| ~\d+ tokens \| 2 sections/,
    );
    assert.include(block, `| ${RESULTS_BOOKMARK} | pages 7–8 | ~`);
    assert.notInclude(block, "Foundations p2 line");
    assert.notInclude(block, "Results p8 line");
    assert.include(block, "`>` blockquote");
    assert.isEmpty(prepared.quoteCitations);
  });

  it("keeps the whole-text preload for a chaptered PDF under an article parent", async function () {
    const context = await new PdfService().ensurePaperContext(
      articleGuide.paper,
    );
    assert.equal(context?.sourceType, "zotero-worker");
    assert.isUndefined(context?.documentStructure);
    const prepared = await preload(articleGuide);
    assert.include(prepared.blocks[0], "Complete extracted paper text");
    assert.include(prepared.blocks[0], "Results p8 line 3");
  });

  it("still preloads a short paper's whole text", async function () {
    const context = await new PdfService().ensurePaperContext(shortPaper.paper);
    assert.isUndefined(context?.documentStructure);
    const prepared = await preload(shortPaper);
    assert.include(prepared.blocks[0], "Complete extracted paper text");
    assert.include(prepared.blocks[0], "Paper p2 line 3");
    assert.isNotEmpty(prepared.quoteCitations);
  });

  it("still preloads a bookmarked short paper's whole text", async function () {
    const context = await new PdfService().ensurePaperContext(
      bookmarkedPaper.paper,
    );
    assert.equal(context?.sourceType, "zotero-worker");
    assert.isUndefined(context?.documentStructure);
    const prepared = await preload(bookmarkedPaper);
    assert.include(prepared.blocks[0], "Complete extracted paper text");
    assert.include(prepared.blocks[0], "Paper p2 line 3");
    assert.isNotEmpty(prepared.quoteCitations);
  });

  it("preloads a page map for a paper whose whole text does not fit, and reads its pages by the same rule", async function () {
    // A small input cap leaves the short paper too little room.
    const prepared = await preload(shortPaper, {
      advanced: { inputTokenCap: 1000 },
    });
    const block = prepared.blocks[0];
    assert.notInclude(block, "Partial text");
    assert.notInclude(block, "Paper p2 line 3");
    assert.match(block, /^page 1 \| ~\d+ tokens \| Drift in a short paper$/m);
    assert.match(block, /^page 2 \| ~\d+ tokens \| Paper p2 line 1: /m);
    assert.include(block, "pages:[4,5,6]");
    assert.isEmpty(prepared.quoteCitations);
    const again = await preload(shortPaper, {
      advanced: { inputTokenCap: 1000 },
      userText: "Another question",
    });
    assert.equal(again.blocks[0], block, "byte-stable for one file state");

    const page = await read(shortPaper, { mode: "targeted", pages: [2] });
    const pageText = page.papers[0].passages
      .map((passage: any) => passage.text)
      .join("\n");
    assert.include(pageText, "Paper p2 line 3");
    assert.notInclude(pageText, "Paper p1 line");
    // The model's maxChars does not cut a page read.
    const capped = await read(shortPaper, {
      mode: "targeted",
      pages: [2],
      maxChars: 40,
    });
    assert.notEqual(capped.papers[0].status, "map");
    assert.include(
      capped.papers[0].passages.map((passage: any) => passage.text).join("\n"),
      "Paper p2 line 3",
    );
    // A page holds about 650 tokens; a 400-token window cannot hold it.
    const over = await read(
      shortPaper,
      { mode: "targeted", pages: [2] },
      undefined,
      { contextWindowTokens: 400 },
    );
    assert.equal(over.papers[0].status, "map");
    assert.isEmpty(over.papers[0].passages);
    assert.match(over.papers[0].map[0], /^page 2 \| ~\d+ tokens \| /);
  });

  it("preloads its bookmarks' section map for a bookmarked paper whose whole text does not fit, and reads a section by its id", async function () {
    const context = await new PdfService().ensurePaperContext(
      bookmarkedPaper.paper,
    );
    assert.isUndefined(context?.documentStructure);
    const prepared = await preload(bookmarkedPaper, {
      advanced: { inputTokenCap: 1000 },
    });
    const block = prepared.blocks[0];
    assert.notInclude(block, "Partial text");
    assert.notInclude(block, "Paper p2 line 3");
    assert.notMatch(block, /^page 1 \| /m);
    assert.match(block, /^s1 \| 1 Introduction \| page 1 \| ~\d+ tokens$/m);
    assert.match(block, /^s2 \| 2 Methods \| pages 1–2 \| ~\d+ tokens$/m);
    assert.match(block, /^s3 \| 3 Results \| page 2 \| ~\d+ tokens$/m);
    assert.include(block, "sectionIds");
    assert.isEmpty(prepared.quoteCitations);
    const again = await preload(bookmarkedPaper, {
      advanced: { inputTokenCap: 1000 },
      userText: "Another question",
    });
    assert.equal(again.blocks[0], block, "byte-stable for one file state");

    const results = await read(bookmarkedPaper, {
      mode: "targeted",
      sectionIds: ["s3"],
    });
    assert.equal(results.papers[0].status, "complete");
    const text = results.papers[0].passages
      .map((passage: any) => passage.text)
      .join("\n");
    assert.include(text, "Result Paper p2 line 3");
    assert.isNotEmpty(results.quoteCitations);
    // The model's maxChars does not cut a section read.
    const capped = await read(bookmarkedPaper, {
      mode: "targeted",
      sectionIds: ["s3"],
      maxChars: 40,
    });
    assert.notEqual(capped.papers[0].status, "map");
    assert.include(
      capped.papers[0].passages.map((passage: any) => passage.text).join("\n"),
      "Result Paper p2 line 3",
    );
    // A 400-token window cannot hold the section's page.
    const over = await read(
      bookmarkedPaper,
      { mode: "targeted", sectionIds: ["s3"] },
      undefined,
      { contextWindowTokens: 400 },
    );
    assert.isEmpty(over.papers[0].passages);
    assert.equal(over.papers[0].map[0].reason, "does_not_fit");
    assert.match(over.papers[0].map[0].lines[0], /^page 2 \| ~\d+ tokens \| /);
  });

  it("reads a leaf whole, answers a chapter by its sections, and reads the chapter whole on request", async function () {
    const outline = buildDocumentOutline(
      await new PdfService().ensurePaperContext(bookmarked.paper),
    );
    const id = (title: string) =>
      outline.sections.find((section) => section.title === title)!.sectionId;

    const leaf = await read(bookmarked, {
      mode: "targeted",
      sectionIds: [id("Early ideas")],
    });
    const leafText = leaf.papers[0].passages
      .map((passage: any) => passage.text)
      .join("\n");
    assert.include(leafText, "Foundations p3 line 12");
    assert.notInclude(leafText, "Foundations p2 line");
    // The section runs on to "1.2 Later ideas", halfway down page 4.
    assert.include(leafText, "Foundations p4 line 1:");
    assert.notInclude(leafText, "Methods p5");
    assert.isTrue(
      leaf.papers[0].passages.every((passage: any) => passage.quoteCitationId),
    );

    const chapter = await read(bookmarked, {
      mode: "targeted",
      sectionIds: [id("Foundations")],
    });
    assert.isEmpty(chapter.papers[0].passages);
    assert.equal(chapter.papers[0].map[0].reason, "has_sections");
    assert.deepEqual(
      chapter.papers[0].map[0].lines.map((line: string) =>
        line.split(" | ").slice(0, 3),
      ),
      [
        [id("Early ideas"), "Early ideas", "pages 3–4"],
        [id("Later ideas"), "Later ideas", "page 4"],
      ],
    );

    const whole = await read(bookmarked, {
      mode: "targeted",
      sectionIds: [id("Foundations")],
      whole: true,
    });
    const wholeText = whole.papers[0].passages
      .map((passage: any) => passage.text)
      .join("\n");
    for (const page of [2, 3, 4])
      assert.include(wholeText, `Foundations p${page} line`);
    assert.notInclude(wholeText, "Methods p5");
  });

  it("reads exactly a section's own text where a chunk crosses its start, and a query scoped to it finds its start", async function () {
    const context = await new PdfService().ensurePaperContext(bookmarked.paper);
    const outline = buildDocumentOutline(context);
    const section = (title: string) =>
      outline.sections.find((entry) => entry.title === title)!;
    // "1.2 Later ideas" starts halfway down page 4, inside a chunk that
    // also holds the end of "Early ideas".
    const later = section("Later ideas");
    const lastEarlyLine = `Foundations p4 line ${LINES_PER_PAGE / 2}:`;
    const crossing = context!.chunks.some(
      (chunk) =>
        chunk.includes("1.2 Later ideas") &&
        chunk.split("\n").some((line) => line.startsWith(lastEarlyLine)),
    );
    assert.isTrue(crossing, "a chunk crosses the section start");
    const linesOf = (output: any): string[] =>
      output.papers[0].passages.flatMap((passage: any) =>
        String(passage.text).split("\n"),
      );
    const tokensOf = (output: any) =>
      output.papers[0].passages.reduce(
        (sum: number, passage: any) => sum + estimateTextTokens(passage.text),
        0,
      );

    const early = await read(bookmarked, {
      mode: "targeted",
      sectionIds: [section("Early ideas").sectionId],
    });
    const earlyLines = linesOf(early);
    assert.isTrue(
      earlyLines.some((line) => line.startsWith(lastEarlyLine)),
      "the last line of Early ideas",
    );
    assert.notInclude(earlyLines.join("\n"), "1.2 Later ideas");
    assert.notInclude(earlyLines.join("\n"), "More Foundations p4");
    const earlyTokens = section("Early ideas").tokens;
    assert.closeTo(tokensOf(early), earlyTokens, earlyTokens * 0.05);

    const own = await read(bookmarked, {
      mode: "targeted",
      sectionIds: [later.sectionId],
    });
    assert.match(own.papers[0].passages[0].text, /^1\.2 Later ideas/);
    assert.isFalse(
      linesOf(own).some((line) => line.startsWith("Foundations p")),
      "no line of Early ideas",
    );
    assert.closeTo(tokensOf(own), later.tokens, later.tokens * 0.05);

    const found = await read(bookmarked, {
      mode: "targeted",
      sectionIds: [later.sectionId],
      query: "Later ideas",
      topK: 2,
    });
    assert.include(
      found.papers[0].passages.map((passage: any) => passage.text).join("\n"),
      "1.2 Later ideas",
    );
  });

  it("lists one level of the map at a time", async function () {
    const top = await read(bookmarked, { mode: "outline" });
    const sections = top.papers[0].outline.sections;
    assert.deepEqual(
      sections.map((section: any) => section.title),
      [
        "(before the first section)",
        "Foundations",
        "Methods",
        RESULTS_BOOKMARK,
      ],
    );
    const methods = sections.find(
      (section: any) => section.title === "Methods",
    );
    const expanded = await read(bookmarked, {
      mode: "outline",
      sectionId: methods.sectionId,
    });
    assert.deepEqual(
      expanded.papers[0].outline.sections.map((section: any) => section.title),
      ["Measurement"],
    );
  });

  it("gives an overview of the map and the picked opening part, never the whole text", async function () {
    const reader = stubReader();
    const output = await read(
      bookmarked,
      { mode: "overview" },
      reader.factories,
    );
    assert.lengthOf(reader.picks, 1, "one pick over the map");
    assert.include(reader.picks[0], "# Foundations |");
    const result = output.results[0];
    assert.match(result.map, /\| Methods \| pages 5–6 \|/);
    assert.include(result.text, "This guide explains how long documents");
    assert.notInclude(result.text, "Foundations p2");
    assert.notInclude(result.text, "Results p7");
  });

  it("keeps the whole-text preload for text only Zotero's full-text cache holds", async function () {
    const context = await new PdfService().ensurePaperContext(cacheOnly.paper);
    assert.equal(context?.sourceType, "zotero-fulltext-cache");
    assert.isUndefined(context?.documentStructure);
    const prepared = await preload(cacheOnly);
    assert.include(prepared.blocks[0], "Complete extracted paper text");
    assert.include(prepared.blocks[0], "Results p8 line 3");
    const outline = await read(cacheOnly, { mode: "outline" });
    assert.isUndefined(outline.papers[0].outline.chaptered);
  });
});

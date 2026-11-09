import { assert } from "chai";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import { RetrievalService } from "../src/agent/services/retrievalService";
import type { AgentToolContext, AgentToolDefinition } from "../src/agent/types";
import {
  buildBookmarkOutline,
  buildChunkIndex,
  buildDocumentOutline,
  chunkPlainPdfText,
} from "../src/services/paperContent/pdfContext";
import type { PdfContext } from "../src/services/paperContent/types";
import { estimateTextTokens } from "../src/utils/modelInputCap";
import { resolveOutputReserve } from "../src/utils/outputTokenPolicy";
import { DISSERTATION_PAGES, joinPages } from "./fixtures/longdoc/pageTexts";
import { headingMatchReader } from "./helpers/sectionPickerFixtures";
import {
  restoreTestGlobals,
  setupMemoryIO,
  setupZoteroGlobals,
  snapshotTestGlobals,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";

const STAND_IN_READER = headingMatchReader();

/** A page's worth of body text, naming its page so reads can be told apart. */
function body(page: number): string {
  return `Page ${page} body: the argument continues with further detail here. `.repeat(
    40,
  );
}

const TEXT = joinPages(
  DISSERTATION_PAGES.map((lines, page) => [...lines, body(page + 1)]),
);

const paper = {
  libraryID: 1,
  itemId: 5100,
  contextItemId: 5101,
  title: "Unveiling Secrets of Brain Function with Generative Modeling",
  firstCreator: "Vafaii",
  year: "2024",
};

function chapteredContext(): PdfContext {
  const parts = chunkPlainPdfText(TEXT, "zotero-worker", {
    layout: { totalPages: DISSERTATION_PAGES.length },
    structure: { bookmarks: null },
  });
  return {
    title: paper.title,
    ...parts,
    ...buildChunkIndex(parts.chunks),
    fullLength: TEXT.length,
    sourceType: "zotero-worker",
  };
}

type MapSection = {
  sectionId: string;
  title: string;
  tokens: number;
  pageStart?: number;
  pageEnd?: number;
  parentId?: string;
  childIds: string[];
};

describe("paper_read on a document with chapters", function () {
  let globalsBefore: TestGlobalSnapshot;
  let ctx: PdfContext;

  before(function () {
    globalsBefore = snapshotTestGlobals();
    setupMemoryIO();
    setupZoteroGlobals();
    ctx = chapteredContext();
  });
  after(function () {
    restoreTestGlobals(globalsBefore);
  });

  function tool(): AgentToolDefinition<never, unknown> {
    return createPaperReadTool(
      {
        ensurePaperContext: async () => ctx,
        getOverviewExcerpt: async () => {
          throw new Error("a chaptered overview never reads the excerpt");
        },
      } as never,
      new RetrievalService({ ensurePaperContext: async () => ctx } as never),
      {} as never,
      {
        listPaperContexts: () => [paper],
        resolvePaperContextTarget: () => paper,
        getItem: () => ({ getField: () => "" }),
      } as never,
      undefined,
      undefined,
      { readerFactories: STAND_IN_READER.factories },
    ) as unknown as AgentToolDefinition<never, unknown>;
  }

  function context(budget?: number): AgentToolContext {
    return {
      request: {
        conversationKey: 91,
        mode: "agent",
        conversationKind: "paper",
        userText: "What does the dissertation say?",
        libraryID: 1,
        activeItemId: paper.itemId,
        model: "deepseek-chat",
        ...(budget
          ? {
              runtimeContextBudget: {
                contextWindowTokens: budget,
                usedContextTokens: 0,
              },
            }
          : {}),
      } as never,
      item: null,
      currentAnswerText: "",
      modelName: "deepseek-chat",
    };
  }

  async function run(
    args: Record<string, unknown>,
    budget?: number,
  ): Promise<any> {
    const definition = tool();
    const validated = definition.validate({
      targets: [{ itemId: paper.itemId, contextItemId: paper.contextItemId }],
      ...args,
    });
    if (!validated.ok) throw new Error(validated.error);
    return definition.execute(validated.value, context(budget));
  }

  function ctxOutlineSection(sectionId: string) {
    return buildDocumentOutline(ctx).sections.find(
      (section) => section.sectionId === sectionId,
    )!;
  }

  it("lists the top level, then one part's sections on request", async function () {
    const top = await run({ mode: "outline" });
    const sections: MapSection[] = top.papers[0].outline.sections;
    assert.deepEqual(
      sections.map((section) => section.title),
      [
        "(before the first section)",
        "Chapter 1:Introduction",
        "Chapter 2:Philosophical and historical background",
        "Chapter 3:Variational Inference & Variational Autoencoders (VAE)",
      ],
    );
    for (const section of sections) {
      assert.isUndefined(section.parentId);
      assert.isAbove(section.tokens, 0);
      assert.isNumber(section.pageStart);
    }
    const chapter1 = sections[1];
    const expanded = await run({
      mode: "outline",
      sectionId: chapter1.sectionId,
    });
    const children: MapSection[] = expanded.papers[0].outline.sections;
    assert.deepEqual(
      children.map((section) => section.sectionId),
      chapter1.childIds,
    );
    assert.deepEqual(
      children.map((section) => section.title),
      [
        "1.1Visual processing and representations in the brain",
        "1.2Hierarchical architecture of the visual cortex",
      ],
    );
    const missing = await run({ mode: "outline", sectionId: "s99" });
    assert.isEmpty(missing.papers[0].outline.sections);
    assert.match((missing.warnings || []).join(" "), /s99/);
  });

  it("reads a leaf section whole, with a passage id per passage", async function () {
    const output = await run({ mode: "targeted", sectionIds: ["s2"] });
    const row = output.papers[0];
    assert.equal(row.status, "complete");
    assert.deepEqual(
      row.sections.map((entry: any) => [entry.sectionId, entry.complete]),
      [["s2", true]],
    );
    const text = row.passages.map((passage: any) => passage.text).join("\n");
    assert.include(text, "1.1Visual processing");
    assert.include(text, "Page 5 body");
    assert.notInclude(text, "Page 9 body");
    assert.isTrue(
      row.passages.every((passage: any) => passage.quoteCitationId),
      "every passage carries its id",
    );
    assert.isNotEmpty(output.quoteCitations);
    assert.isUndefined(row.map);
  });

  it("reads exactly a leaf section's text, at the size the map lists, though a chunk crosses its start", async function () {
    // 1.2 starts mid-page 6, inside the chunk that holds the end of 1.1.
    const before = ctxOutlineSection("s2");
    const after = ctxOutlineSection("s3");
    const tokensOf = (row: any) =>
      row.passages.reduce(
        (sum: number, passage: any) => sum + estimateTextTokens(passage.text),
        0,
      );
    const first = (await run({ mode: "targeted", sectionIds: ["s2"] }))
      .papers[0];
    const firstText = first.passages.map((p: any) => p.text).join("\n");
    assert.include(firstText, "Figure 1.1");
    assert.notInclude(firstText, "1.2Hierarchical");
    assert.notInclude(firstText, "Page 6 body");
    assert.closeTo(tokensOf(first), before.tokens, before.tokens * 0.05);
    const second = (await run({ mode: "targeted", sectionIds: ["s3"] }))
      .papers[0];
    assert.match(second.passages[0].text, /^1\.2Hierarchical/);
    const secondText = second.passages.map((p: any) => p.text).join("\n");
    assert.notInclude(secondText, "Figure 1.1");
    assert.notInclude(secondText, "Page 5 body");
    assert.closeTo(tokensOf(second), after.tokens, after.tokens * 0.05);
    for (const passage of second.passages)
      assert.equal(passage.sectionId, "s3");
    // A leaf over the context left lists only its own text per page.
    const over = await run({ mode: "targeted", sectionIds: ["s2"] }, 1_500);
    const lines: string[] = over.papers[0].map[0].lines;
    const listed = lines.reduce(
      (sum, line) => sum + Number(/~(\d+) tokens/.exec(line)![1]),
      0,
    );
    assert.closeTo(listed, before.tokens, before.tokens * 0.05);
  });

  it("finds text at a section's start when a query is scoped to it", async function () {
    const output = await run({
      mode: "targeted",
      sectionIds: ["s3"],
      query: "Hierarchical architecture of the visual cortex",
      topK: 2,
    });
    const text = output.papers[0].passages
      .map((passage: any) => passage.text)
      .join("\n");
    assert.include(text, "1.2Hierarchical architecture of the visual cortex");
  });

  it("bounds a section read by the reading share of the input limit when the host reports no live context", async function () {
    // An MCP host (Codex native, Claude bridge) sends no live context.
    const part = ctxOutlineSection("s1");
    const reserve = resolveOutputReserve(undefined, "deepseek-chat", {});
    const readWithCap = async (inputTokenCap: number) => {
      const definition = tool();
      const validated = definition.validate({
        targets: [{ itemId: paper.itemId, contextItemId: paper.contextItemId }],
        mode: "targeted",
        sectionIds: ["s1"],
        whole: true,
      });
      if (!validated.ok) throw new Error(validated.error);
      const base = context();
      return (await definition.execute(validated.value, {
        ...base,
        request: { ...base.request, advanced: { inputTokenCap } },
      })) as any;
    };
    const tight = await readWithCap(reserve + Math.ceil(part.tokens * 1.1));
    assert.equal(tight.papers[0].status, "map");
    assert.equal(tight.papers[0].map[0].reason, "does_not_fit");
    const roomy = await readWithCap(
      reserve + Math.ceil((part.tokens * 3) / 0.8),
    );
    assert.equal(roomy.papers[0].status, "complete");
  });

  it("returns the map when the result the model would see does not fit the reading share, though the text does", async function () {
    const leaf = ctxOutlineSection("s8");
    const reserve = resolveOutputReserve(undefined, "deepseek-chat", {});
    const share = Math.ceil(leaf.tokens * 1.02);
    const tight = await run(
      { mode: "targeted", sectionIds: ["s8"] },
      reserve + Math.ceil(share / 0.8),
    );
    assert.equal(tight.papers[0].status, "map");
    assert.isEmpty(tight.quoteCitations);
    const roomy = await run(
      { mode: "targeted", sectionIds: ["s8"] },
      reserve + Math.ceil((leaf.tokens * 2) / 0.8),
    );
    assert.equal(roomy.papers[0].status, "complete");
  });

  it("answers a part with sections by its sections and sizes", async function () {
    const output = await run({ mode: "targeted", sectionIds: ["s1"] });
    const row = output.papers[0];
    assert.isEmpty(row.passages);
    assert.equal(row.status, "map");
    assert.equal(row.map[0].sectionId, "s1");
    assert.equal(row.map[0].reason, "has_sections");
    assert.match(
      row.map[0].lines[0],
      /^s2 \| 1\.1Visual processing .* \| ~\d+ tokens$/,
    );
    assert.lengthOf(row.map[0].lines, 2);
  });

  it("reads a whole part with its sections when asked", async function () {
    const output = await run({
      mode: "targeted",
      sectionIds: ["s1"],
      whole: true,
    });
    const row = output.papers[0];
    assert.equal(row.status, "complete");
    const text = row.passages.map((passage: any) => passage.text).join("\n");
    for (const page of [3, 4, 5, 6]) assert.include(text, `Page ${page} body`);
    assert.notInclude(text, "Page 7 body");
  });

  it("reads the named section when a targeted read gives one sectionId", async function () {
    const output = await run({
      mode: "targeted",
      sectionId: "s1",
      whole: true,
    });
    const row = output.papers[0];
    assert.equal(output.read, "whole_sections");
    assert.equal(row.status, "complete");
    const text = row.passages.map((passage: any) => passage.text).join("\n");
    for (const page of [3, 4, 5, 6]) assert.include(text, `Page ${page} body`);
    assert.notInclude(text, "Page 7 body");
  });

  it("ignores the model's maxChars on a section read and returns the text that fits the context left", async function () {
    const part = ctxOutlineSection("s1");
    const whole = await run({
      mode: "targeted",
      sectionIds: ["s1"],
      whole: true,
      maxChars: part.chars - 1,
    });
    assert.equal(whole.papers[0].status, "complete");
    assert.isNotEmpty(whole.papers[0].passages);
    assert.isUndefined(whole.papers[0].map);
    assert.isUndefined(whole.warnings);
    const leaf = ctxOutlineSection("s8");
    const page = await run({
      mode: "targeted",
      sectionIds: ["s8"],
      maxChars: leaf.chars - 1,
    });
    assert.equal(page.papers[0].status, "complete");
    assert.isNotEmpty(page.papers[0].passages);
    // Several sections: none is held back by a small maxChars.
    const two = await run({
      mode: "targeted",
      sectionIds: ["s8", "s1"],
      whole: true,
      maxChars: 1,
    });
    assert.equal(two.papers[0].status, "complete");
    assert.isUndefined(two.papers[0].map);
  });

  it("still returns sections or a page map when the context left cannot hold the read, whatever maxChars says", async function () {
    const whole = await run(
      {
        mode: "targeted",
        sectionIds: ["s1"],
        whole: true,
        maxChars: 1_000_000,
      },
      9_000,
    );
    assert.equal(whole.papers[0].status, "map");
    assert.equal(whole.papers[0].map[0].reason, "does_not_fit");
    assert.isEmpty(whole.papers[0].passages);
    const warnings = (whole.warnings || []).join(" ");
    assert.include(warnings, "Sections listed in map were not read");
    assert.notInclude(warnings, "whole:true");
    assert.notInclude(warnings, "maxChars");
    // A part named without whole still learns that whole:true reads it all.
    const parts = await run({ mode: "targeted", sectionIds: ["s1"] });
    assert.include((parts.warnings || []).join(" "), "whole:true");
  });

  it("describes maxChars as an overview limit that section and page reads ignore", function () {
    const schema = (tool() as any).spec.inputSchema;
    const description = String(schema.properties.maxChars.description || "");
    assert.match(description, /character/i);
    assert.match(description, /overview/i);
    assert.match(description, /ignore/i);
    assert.match(description, /context left/);
  });

  it("returns sections or a page map when the measured context cannot hold the read", async function () {
    const whole = await run(
      { mode: "targeted", sectionIds: ["s1"], whole: true },
      9_000,
    );
    assert.equal(whole.papers[0].map[0].reason, "does_not_fit");
    assert.isEmpty(whole.papers[0].passages);
    const leaf = await run({ mode: "targeted", sectionIds: ["s8"] }, 4_000);
    const map = leaf.papers[0].map[0];
    assert.equal(map.reason, "does_not_fit");
    assert.match(map.lines[0], /^page 9 \| ~\d+ tokens \| /);
    assert.isEmpty(leaf.papers[0].passages);
  });

  it("searches a part with its sections when a query is given", async function () {
    const output = await run({
      mode: "targeted",
      sectionIds: ["s1"],
      query: "argument continues further detail",
      topK: 8,
    });
    const passages = output.papers[0].passages;
    assert.isNotEmpty(passages);
    for (const passage of passages) {
      assert.match(passage.sectionPath, /^Chapter 1:Introduction/);
      assert.match(passage.sectionId, /^s\d+$/);
    }
    assert.isTrue(
      passages.some((passage: any) => passage.sectionId !== "s1"),
      "subsections are searched",
    );
  });

  it("gives an overview of the map and picked parts, never the whole text", async function () {
    const output = await run({ mode: "overview" });
    const result = output.results[0];
    assert.include(result.map, "s1 | Chapter 1:Introduction | pages 3–6");
    assert.isBelow(String(result.text || "").length, TEXT.length / 2);
    assert.notInclude(String(result.text || ""), "Page 7 body");
  });

  it("gives the overview's read passages ids the answer can cite", async function () {
    // Bookmarks make the abstract a part of its own, so the overview reads it.
    const entry = (title: string, pageIndex: number) => ({
      depth: 0,
      title,
      pageIndex,
      top: null,
      fitsPage: false,
    });
    const parts = chunkPlainPdfText(TEXT, "zotero-worker", {
      layout: { totalPages: DISSERTATION_PAGES.length },
      structure: {
        bookmarks: [
          entry("Abstract", 0),
          entry("Preface", 1),
          entry("Chapter 1:Introduction", 2),
          entry("Chapter 2:Philosophical and historical background", 6),
        ],
      },
    });
    const chaptered = ctx;
    ctx = {
      title: paper.title,
      ...parts,
      ...buildChunkIndex(parts.chunks),
      fullLength: TEXT.length,
      sourceType: "zotero-worker",
    };
    try {
      const output = await run({ mode: "overview" });
      const result = output.results[0];
      assert.isNotEmpty(result.passages);
      const ids = result.passages.map(
        (passage: any) => passage.quoteCitationId,
      );
      assert.isTrue(ids.every((id: unknown) => typeof id === "string"));
      const minted = output.quoteCitations.map((citation: any) => citation.id);
      for (const id of ids) assert.include(minted, id);
      assert.deepEqual(result.quoteCitationIds, ids);
      // Each id carries its own passage's text.
      const citation = output.quoteCitations.find(
        (quote: any) => quote.id === ids[0],
      );
      assert.include(
        result.passages[0].text.replace(/\s+/g, " "),
        citation.quoteText.slice(0, 40),
      );
    } finally {
      ctx = chaptered;
    }
  });

  it("returns the overview's map alone when the built result the model sees does not fit, though the passages alone do", async function () {
    const entry = (title: string, pageIndex: number) => ({
      depth: 0,
      title,
      pageIndex,
      top: null,
      fitsPage: false,
    });
    const parts = chunkPlainPdfText(TEXT, "zotero-worker", {
      layout: { totalPages: DISSERTATION_PAGES.length },
      structure: {
        bookmarks: [
          entry("Abstract", 0),
          entry("Preface", 1),
          entry("Chapter 1:Introduction", 2),
          entry("Chapter 2:Philosophical and historical background", 6),
        ],
      },
    });
    const chaptered = ctx;
    ctx = {
      title: paper.title,
      ...parts,
      ...buildChunkIndex(parts.chunks),
      fullLength: TEXT.length,
      sourceType: "zotero-worker",
    };
    try {
      const roomy = await run({ mode: "overview" });
      const read = roomy.results[0];
      assert.isNotEmpty(read.passages);
      // The model sees `text` and `passages`, both holding the picked text.
      const seen = estimateTextTokens(JSON.stringify(read));
      const passagesOnly = estimateTextTokens(
        JSON.stringify({ passages: read.passages }),
      );
      const room = Math.floor(seen * 0.9);
      assert.isBelow(passagesOnly * 1.2, room, "the passages alone fit");
      const reserve = resolveOutputReserve(undefined, "deepseek-chat", {});
      const tight = await run(
        { mode: "overview" },
        reserve + Math.ceil(room / 0.8),
      );
      const result = tight.results[0];
      assert.equal(result.text, "");
      assert.isEmpty(result.passages);
      assert.include(result.map, "Chapter 1:Introduction");
      assert.isTrue(result.parts.every((part: any) => part.read === "map"));
      assert.isEmpty(tight.quoteCitations);
      // The records stay out of the model's view of an overview of this kind.
      const view = tool().modelContent?.(roomy, {} as never) as any;
      assert.notProperty(view, "quoteCitations");
      assert.isNotEmpty(roomy.quoteCitations);
    } finally {
      ctx = chaptered;
    }
  });

  it("keeps the overview's reads within the model's maxChars, never cut", async function () {
    const entry = (title: string, pageIndex: number) => ({
      depth: 0,
      title,
      pageIndex,
      top: null,
      fitsPage: false,
    });
    const parts = chunkPlainPdfText(TEXT, "zotero-worker", {
      layout: { totalPages: DISSERTATION_PAGES.length },
      structure: {
        bookmarks: [
          entry("Abstract", 0),
          entry("Preface", 1),
          entry("Chapter 1:Introduction", 2),
          entry("Chapter 2:Philosophical and historical background", 6),
        ],
      },
    });
    const chaptered = ctx;
    ctx = {
      title: paper.title,
      ...parts,
      ...buildChunkIndex(parts.chunks),
      fullLength: TEXT.length,
      sourceType: "zotero-worker",
    };
    try {
      const abstract = ctxOutlineSection("s0");
      assert.equal(abstract.title, "Abstract");
      const over = await run({
        mode: "overview",
        maxChars: abstract.chars - 1,
      });
      const result = over.results[0];
      assert.isEmpty(result.passages);
      assert.equal(result.text, "");
      assert.equal(result.parts[0].read, "map");
      assert.equal(result.partMaps[0].reason, "does_not_fit");
      const fits = await run({ mode: "overview", maxChars: abstract.chars });
      assert.isNotEmpty(fits.results[0].passages);
    } finally {
      ctx = chaptered;
    }
  });

  it("lists and searches a bookmark part of an unchaptered document", async function () {
    const text = joinPages([
      [
        "Drift in a bookmarked paper",
        "Abstract",
        "We track.",
        "1 Introduction",
        body(1),
      ],
      [body(2), "2 Methods", body(2), "2.1 Data", body(2)],
      [body(3), "3 Results", body(3)],
    ]);
    const bookmarks = [
      ["1 Introduction", 0, 0],
      ["2 Methods", 1, 0],
      ["2.1 Data", 1, 1],
      ["3 Results", 2, 0],
    ].map(([title, pageIndex, depth]) => ({
      depth: Number(depth),
      title: String(title),
      pageIndex: Number(pageIndex),
      top: null,
      fitsPage: false,
    }));
    const parts = chunkPlainPdfText(text, "zotero-worker", {
      layout: { totalPages: 3 },
      structure: { bookmarks },
    });
    const chaptered = ctx;
    ctx = {
      title: paper.title,
      ...parts,
      ...buildChunkIndex(parts.chunks),
      fullLength: text.length,
      sourceType: "zotero-worker",
    };
    try {
      const outline = await run({ mode: "outline", sectionId: "s2" });
      const listed = outline.papers[0].outline.sections;
      assert.deepEqual(
        listed.map((section: any) => section.sectionId),
        ["s3"],
      );
      const found = await run({
        mode: "targeted",
        sectionIds: ["s4"],
        query: "argument continues further detail",
        topK: 8,
      });
      const passages = found.papers[0].passages;
      assert.isNotEmpty(passages);
      assert.include(
        passages.map((passage: any) => passage.text).join("\n"),
        "Page 3 body",
      );
    } finally {
      ctx = chaptered;
    }
  });

  it("reads an unchaptered document's bookmark sections by sectionIds, under the same rule", async function () {
    const text = joinPages([
      [
        "Drift in a bookmarked paper",
        "Abstract",
        "We track.",
        "1 Introduction",
        body(1),
      ],
      [body(2), "2 Methods", body(2), "2.1 Data", body(2)],
      [body(3), "3 Results", body(3)],
    ]);
    const bookmarks = [
      ["1 Introduction", 0, 0],
      ["2 Methods", 1, 0],
      ["2.1 Data", 1, 1],
      ["3 Results", 2, 0],
    ].map(([title, pageIndex, depth]) => ({
      depth: Number(depth),
      title: String(title),
      pageIndex: Number(pageIndex),
      top: null,
      fitsPage: false,
    }));
    const parts = chunkPlainPdfText(text, "zotero-worker", {
      layout: { totalPages: 3 },
      structure: { bookmarks },
    });
    const chaptered = ctx;
    ctx = {
      title: paper.title,
      ...parts,
      ...buildChunkIndex(parts.chunks),
      fullLength: text.length,
      sourceType: "zotero-worker",
    };
    try {
      assert.isUndefined(ctx.documentStructure);
      const part = await run({ mode: "targeted", sectionIds: ["s2"] });
      assert.equal(part.papers[0].status, "map");
      assert.equal(part.papers[0].map[0].reason, "has_sections");
      assert.match(part.papers[0].map[0].lines[0], /^s3 \| 2\.1 Data \| /);
      const results = await run({ mode: "targeted", sectionIds: ["s4"] });
      assert.equal(results.papers[0].status, "complete");
      const read = results.papers[0].passages
        .map((passage: any) => passage.text)
        .join("\n");
      assert.include(read, "3 Results");
      assert.notInclude(read, "Page 1 body");
      assert.isNotEmpty(results.quoteCitations);
      // The model's maxChars does not hold a leaf back.
      const leaf = buildBookmarkOutline(ctx)!.sections.find(
        (section) => section.sectionId === "s4",
      )!;
      const small = await run({
        mode: "targeted",
        sectionIds: ["s4"],
        maxChars: leaf.chars - 1,
      });
      assert.equal(small.papers[0].status, "complete");
      assert.isNotEmpty(small.papers[0].passages);
      // A leaf over the context left returns its pages, numbered as in the PDF.
      const over = await run(
        { mode: "targeted", sectionIds: ["s4"], maxChars: leaf.chars + 1 },
        400,
      );
      assert.isEmpty(over.papers[0].passages);
      assert.equal(over.papers[0].map[0].reason, "does_not_fit");
      assert.deepEqual(
        over.papers[0].map[0].lines.map((line: string) => line.split(" | ")[0]),
        ["page 3"],
      );
    } finally {
      ctx = chaptered;
    }
  });
});

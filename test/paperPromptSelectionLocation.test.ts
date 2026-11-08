import { assert } from "chai";
import { preparePaperPromptContext } from "../src/agent/context/paperPromptContext";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import type { PdfContext } from "../src/services/paperContent/types";
import { renderAgentPromptEnvelope } from "../src/agent/model/messageBuilder";
import { buildAgentResourceContextPlan } from "../src/agent/context/resourceContextPlan";
import {
  buildBookmarkOutline,
  buildChunkIndex,
  buildDocumentOutline,
  chunkPlainPdfText,
} from "../src/services/paperContent/pdfContext";
import { formatDocumentMapLine } from "../src/services/paperContent/documentMap";
import type { DocumentOutline } from "../src/services/paperContent/types";
import { DISSERTATION_PAGES, joinPages } from "./fixtures/longdoc/pageTexts";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import { renderSelectedTextAnchorContext } from "../src/services/context/selectedTextAnchorFormatting";

const paper = {
  libraryID: 1,
  itemId: 20,
  contextItemId: 21,
  title: "Complete paper",
  firstCreator: "Kim",
  year: "2026",
};

const SELECTED = "The argument continues with further detail on this page.";
/** The paper_read call that reads `page` (from 1) of the paper and one neighbor. */
const PAGE_CALL = (page: number) =>
  `paper_read {"mode":"targeted","target":{"itemId":20,"contextItemId":21},"pages":[${page}],"neighborPages":1}`;
const PAGE_HINT = (page: number) =>
  `If more context is required, read PDF page ${page} with one neighboring page: ${PAGE_CALL(page)}.`;
const ADJACENT = (page: number) =>
  `For only the adjacent text, read page ${page} with one neighboring page: ${PAGE_CALL(page)}.`;

type AnchorShape = {
  contextItemId?: number;
  pageIndex?: number;
  primaryChunkIndex?: number;
  preferredChunkIndexes?: number[];
  sourceType?: "mineru" | "zotero-worker";
};

/** A turn with one PDF selection whose anchor is `anchor`, or none. */
function request(
  anchor?: AnchorShape,
  extra: Record<string, unknown> = {},
): ReturnType<typeof resolvedAgentRequest> {
  const contextItemId = anchor?.contextItemId ?? paper.contextItemId;
  const base = {
    conversationKey: 900452,
    mode: "agent" as const,
    libraryID: 1,
    userText: "How does this fit the section?",
    activePaperContext: paper,
    conversationKind: "paper" as const,
    model: "test-model",
    ...extra,
  };
  if (!anchor) return resolvedAgentRequest(base);
  const hasChunk = anchor.primaryChunkIndex !== undefined;
  return resolvedAgentRequest({
    ...base,
    selectedTextContexts: [
      {
        text: SELECTED,
        source: "pdf" as const,
        contextItemId,
        ...(anchor.pageIndex !== undefined
          ? { pageIndex: anchor.pageIndex }
          : {}),
      },
    ],
    resolvedSelectedTextAnchors: [
      {
        contextIndex: 0,
        contextItemId,
        ...(contextItemId === paper.contextItemId
          ? { paperContext: paper }
          : {}),
        pageIndex: anchor.pageIndex,
        ...(anchor.sourceType ? { sourceType: anchor.sourceType } : {}),
        resolution: hasChunk ? ("chunks" as const) : ("locator-only" as const),
        primaryChunkIndex: anchor.primaryChunkIndex,
        preferredChunkIndexes:
          anchor.preferredChunkIndexes ??
          (hasChunk
            ? [
                anchor.primaryChunkIndex! - 1,
                anchor.primaryChunkIndex!,
                anchor.primaryChunkIndex! + 1,
              ]
            : []),
        contextText: hasChunk ? `${SELECTED} Nearby text.` : undefined,
        injectedChars: hasChunk ? 40 : 0,
      },
    ],
  });
}

/** The chain of map lines for these section ids, as the location names it. */
function chain(outline: DocumentOutline, ids: string[]): string {
  return ids
    .map((id) =>
      formatDocumentMapLine(
        outline.sections.find((section) => section.sectionId === id)!,
      ),
    )
    .join(" › ");
}

async function turnText(
  turn: ReturnType<typeof resolvedAgentRequest>,
  paperContext: Awaited<ReturnType<typeof preparePaperPromptContext>>,
) {
  const plan = buildAgentResourceContextPlan(turn);
  plan.paperContext = paperContext;
  const rendered = await renderAgentPromptEnvelope(turn, [], [], plan);
  return {
    systemMessages: rendered.envelope.systemMessages,
    text: String(rendered.envelope.turnMessage.content),
  };
}

const BODY = `${SELECTED} `.repeat(45);
const dissertationText = joinPages(
  DISSERTATION_PAGES.map((lines) => [...lines, BODY]),
);
const dissertationParts = chunkPlainPdfText(dissertationText, "zotero-worker", {
  layout: { totalPages: DISSERTATION_PAGES.length },
  structure: { bookmarks: null },
});
const chaptered = {
  title: "Dissertation",
  ...dissertationParts,
  ...buildChunkIndex(dissertationParts.chunks),
  fullLength: dissertationText.length,
  sourceType: "zotero-worker",
} as PdfContext;
const chapteredOutline = buildDocumentOutline(chaptered);

describe("a selection in a document read by its map", function () {
  it("names the chain of parts holding the selection's chunk, top level first", async function () {
    // Chunk 13 lies in 2.1.1 only, under 2.1, under Chapter 2. Page 8 alone
    // would also hold 2.1.2, so only the chunk gives this single chain.
    const prepared = await preparePaperPromptContext(
      request({ pageIndex: 7, primaryChunkIndex: 13 }),
      { tokenBudget: 1_000_000, load: async () => chaptered },
    );
    const expected = `Selected text 1 is inside: ${chain(chapteredOutline, [
      "s4",
      "s5",
      "s6",
    ])}. For the selection in its section, read the part the question means by sectionId (a part with sections lists them unless whole:true). ${ADJACENT(8)}`;
    assert.deepEqual(prepared.selectionLocations, [
      { contextIndex: 0, guidance: expected },
    ]);
    assert.include(expected, "s4 | Chapter 2:Philosophical and historical");
    assert.include(expected, "| 2 sections › s6 | 2.1.1Plato");
    const { text } = await turnText(
      request({ pageIndex: 7, primaryChunkIndex: 13 }),
      prepared,
    );
    assert.include(text, expected);
    assert.notInclude(text, "If more context is required");
  });

  it("lists every candidate chain when only the page is known at a section boundary", async function () {
    // Page 6 (pageIndex 5) holds the end of 1.1 and the start of 1.2.
    const prepared = await preparePaperPromptContext(
      request({ pageIndex: 5 }),
      {
        tokenBudget: 1_000_000,
        load: async () => chaptered,
      },
    );
    assert.lengthOf(prepared.selectionLocations || [], 1);
    const { guidance } = prepared.selectionLocations![0];
    assert.equal(
      guidance,
      `Selected text 1 is inside one of: ${chain(chapteredOutline, [
        "s1",
        "s2",
      ])}; ${chain(chapteredOutline, ["s1", "s3"])}. For the selection in its section, read the part the question means by sectionId (a part with sections lists them unless whole:true). ${ADJACENT(6)}`,
    );
  });

  it("keeps only the chunk's parts whose pages hold the selection's page", async function () {
    // Chunk 14 lies in 2.1.1 and 2.1.2; page 7 holds only 2.1.1.
    const prepared = await preparePaperPromptContext(
      request({ pageIndex: 6, primaryChunkIndex: 14 }),
      { tokenBudget: 1_000_000, load: async () => chaptered },
    );
    assert.lengthOf(prepared.selectionLocations || [], 1);
    assert.include(
      prepared.selectionLocations![0].guidance,
      `is inside: ${chain(chapteredOutline, ["s4", "s5", "s6"])}. `,
    );
  });

  it("lists every part of the chunk when the page holds none of them", async function () {
    // Chunk 14 lies in 2.1.1 and 2.1.2; page 1 holds neither.
    const prepared = await preparePaperPromptContext(
      request({ pageIndex: 0, primaryChunkIndex: 14 }),
      { tokenBudget: 1_000_000, load: async () => chaptered },
    );
    assert.include(
      prepared.selectionLocations![0].guidance,
      `is inside one of: ${chain(chapteredOutline, ["s4", "s5", "s6"])}; ${chain(
        chapteredOutline,
        ["s4", "s5", "s7"],
      )}. `,
    );
  });

  it("names no part for a selection in another attachment", async function () {
    const prepared = await preparePaperPromptContext(
      request({ contextItemId: 99, pageIndex: 6, primaryChunkIndex: 13 }),
      { tokenBudget: 1_000_000, load: async () => chaptered },
    );
    assert.isUndefined(prepared.selectionLocations);
  });

  it("names no part when the user attached the document as full text, and keeps the page hint", async function () {
    const turn = request(
      { pageIndex: 6, primaryChunkIndex: 13 },
      { fullTextPaperContexts: [paper] },
    );
    const prepared = await preparePaperPromptContext(turn, {
      tokenBudget: 1_000_000,
      load: async () => chaptered,
    });
    assert.include(prepared.blocks[0], "Complete extracted paper text");
    assert.isUndefined(prepared.selectionLocations);
    const { text } = await turnText(turn, prepared);
    assert.include(text, PAGE_HINT(7));
    assert.notInclude(text, "is inside");
  });

  it("keeps the paper block and every stable-prefix system message identical with and without a selection", async function () {
    const plain = request();
    const selected = request({ pageIndex: 6, primaryChunkIndex: 13 });
    const without = await preparePaperPromptContext(plain, {
      tokenBudget: 1_000_000,
      load: async () => chaptered,
    });
    const withSelection = await preparePaperPromptContext(selected, {
      tokenBudget: 1_000_000,
      load: async () => chaptered,
    });
    assert.deepEqual(withSelection.blocks, without.blocks);
    const a = await turnText(plain, without);
    const b = await turnText(selected, withSelection);
    assert.deepEqual(b.systemMessages, a.systemMessages);
    assert.include(b.text, "Selected text 1 is inside: s4 |");
  });

  it("leaves a turn without a selection unchanged", async function () {
    const prepared = await preparePaperPromptContext(request(), {
      tokenBudget: 1_000_000,
      load: async () => chaptered,
    });
    assert.deepEqual(Object.keys(prepared).sort(), [
      "blocks",
      "quoteCitations",
    ]);
    const { text } = await turnText(request(), prepared);
    assert.notInclude(text, "is inside");
    assert.notInclude(text, "Selected text");
  });

  describe("other document kinds", function () {
    const PAGE_BODY = (page: number) =>
      `Page ${page} reports one more measurement of the drift. `.repeat(30);
    const pagedText = joinPages([
      ["Drift in a short paper", "1 Introduction", PAGE_BODY(1)],
      ["2 Methods", PAGE_BODY(2)],
      ["3 Results", PAGE_BODY(3)],
    ]);
    const pagedParts = chunkPlainPdfText(pagedText, "zotero-worker", {
      layout: { totalPages: 3 },
      structure: { bookmarks: null },
    });
    const paged = {
      title: "Drift",
      ...pagedParts,
      ...buildChunkIndex(pagedParts.chunks),
      fullLength: pagedText.length,
      sourceType: "zotero-worker",
    } as PdfContext;
    const pagedTokens = paged.chunks.reduce(
      (sum, text) => sum + Math.ceil(text.length / 4),
      0,
    );

    it("names no part for a whole-text paper and keeps the page hint", async function () {
      const turn = request({ pageIndex: 1, primaryChunkIndex: 1 });
      const prepared = await preparePaperPromptContext(turn, {
        tokenBudget: 1_000_000,
        load: async () => paged,
      });
      assert.include(prepared.blocks[0], "Complete extracted paper text");
      assert.isUndefined(prepared.selectionLocations);
      const { text } = await turnText(turn, prepared);
      assert.include(text, PAGE_HINT(2));
    });

    it("names no part for a document read by its page map and keeps the page hint", async function () {
      const turn = request({ pageIndex: 1, primaryChunkIndex: 1 });
      const prepared = await preparePaperPromptContext(turn, {
        tokenBudget: Math.floor(pagedTokens / 2),
        load: async () => paged,
      });
      assert.match(prepared.blocks[0], /^page 1 \| /m);
      assert.isUndefined(prepared.selectionLocations);
      const { text } = await turnText(turn, prepared);
      assert.include(text, PAGE_HINT(2));
    });

    const BOOK_BODY = (topic: string) =>
      `The ${topic} adds one more measurement of the drift. `.repeat(30);
    const bookmarkedText = joinPages([
      [
        "Drift in a bookmarked paper",
        "Abstract",
        "We track drift.",
        "1 Introduction",
        BOOK_BODY("introduction"),
      ],
      [
        BOOK_BODY("introduction"),
        "2 Methods",
        BOOK_BODY("method"),
        "2.1 Data",
        BOOK_BODY("data"),
      ],
      [BOOK_BODY("data"), "3 Results", BOOK_BODY("result")],
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
    const bookmarkedParts = chunkPlainPdfText(bookmarkedText, "zotero-worker", {
      layout: { totalPages: 3 },
      structure: { bookmarks },
    });
    const bookmarked = {
      title: "Drift",
      ...bookmarkedParts,
      ...buildChunkIndex(bookmarkedParts.chunks),
      fullLength: bookmarkedText.length,
      sourceType: "zotero-worker",
    } as PdfContext;
    const bookmarkTokens = bookmarked.chunks.reduce(
      (sum, text) => sum + Math.ceil(text.length / 4),
      0,
    );

    it("names the chain from the bookmark map when that map is preloaded", async function () {
      const outline = buildBookmarkOutline(bookmarked)!;
      const data = outline.sections.find(
        (section) => section.title === "2.1 Data",
      )!;
      const chunk = 3;
      assert.isAtLeast(chunk, data.chunkIndexes[0]);
      assert.isAtMost(chunk, data.chunkIndexes[1]);
      const prepared = await preparePaperPromptContext(
        request({ pageIndex: 2, primaryChunkIndex: chunk }),
        {
          tokenBudget: Math.floor(bookmarkTokens / 2),
          load: async () => bookmarked,
        },
      );
      assert.match(prepared.blocks[0], /^s2 \| 2 Methods \| /m);
      assert.deepEqual(prepared.selectionLocations, [
        {
          contextIndex: 0,
          guidance: `Selected text 1 is inside: ${chain(outline, [
            "s2",
            data.sectionId,
          ])}. For the selection in its section, read the part the question means by sectionId (a part with sections lists them unless whole:true). ${ADJACENT(3)}`,
        },
      ]);
    });

    const bookmarkOutline = () => buildBookmarkOutline(bookmarked)!;
    const pageThreeGuidance = () => {
      const outline = bookmarkOutline();
      const data = outline.sections.find(
        (section) => section.title === "2.1 Data",
      )!;
      const results = outline.sections.find(
        (section) => section.title === "3 Results",
      )!;
      return `Selected text 1 is inside one of: ${chain(outline, [
        "s2",
        data.sectionId,
      ])}; ${chain(outline, [results.sectionId])}. For the selection in its section, read the part the question means by sectionId (a part with sections lists them unless whole:true). ${ADJACENT(3)}`;
    };

    it("uses the page when the anchor's chunk index counts a different text", async function () {
      // Chunk 3 alone gives 2.1 Data; page 3 alone gives it and 3 Results.
      const prepared = await preparePaperPromptContext(
        request({ pageIndex: 2, primaryChunkIndex: 3, sourceType: "mineru" }),
        {
          tokenBudget: Math.floor(bookmarkTokens / 2),
          load: async () => bookmarked,
        },
      );
      assert.deepEqual(prepared.selectionLocations, [
        { contextIndex: 0, guidance: pageThreeGuidance() },
      ]);
    });

    it("uses the page when the anchor's chunk index lies beyond the chunks", async function () {
      const prepared = await preparePaperPromptContext(
        request({ pageIndex: 2, primaryChunkIndex: bookmarked.chunks.length }),
        {
          tokenBudget: Math.floor(bookmarkTokens / 2),
          load: async () => bookmarked,
        },
      );
      assert.deepEqual(prepared.selectionLocations, [
        { contextIndex: 0, guidance: pageThreeGuidance() },
      ]);
    });

    it("gives the long-document note no location, since the model saw no map", async function () {
      const prepared = await preparePaperPromptContext(
        request({ pageIndex: 2, primaryChunkIndex: 3 }),
        { tokenBudget: 10, load: async () => bookmarked },
      );
      assert.include(prepared.blocks[0], "This document is long");
      assert.isUndefined(prepared.selectionLocations);
    });

    it("names no part when the bookmarked document's whole text fits", async function () {
      const prepared = await preparePaperPromptContext(
        request({ pageIndex: 2, primaryChunkIndex: 3 }),
        { tokenBudget: 1_000_000, load: async () => bookmarked },
      );
      assert.include(prepared.blocks[0], "Complete extracted paper text");
      assert.isUndefined(prepared.selectionLocations);
    });
  });
});

describe("the read call a selection hint names", function () {
  /** Every paper_read call a text names, as its arguments. */
  function calls(text: string): Record<string, unknown>[] {
    return [...text.matchAll(/paper_read (\{[^\n]*?\})(?=\.(?:\s|$))/g)].map(
      (match) => JSON.parse(match[1]) as Record<string, unknown>,
    );
  }

  function validate(args: Record<string, unknown>) {
    return createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    ).validate(args);
  }

  it("is a valid paper_read call for a selection whose paper is known", async function () {
    const turn = request({ pageIndex: 6, primaryChunkIndex: 13 });
    const prepared = await preparePaperPromptContext(turn, {
      tokenBudget: 1_000_000,
      load: async () => chaptered,
    });
    const { text } = await turnText(turn, prepared);
    const named = calls(text);
    assert.lengthOf(named, 1);
    const validated = validate(named[0]);
    assert.isTrue(validated.ok, validated.ok ? "" : validated.error);
    if (validated.ok) assert.deepEqual(validated.value.pages, [6]);
    const hint = text
      .split("\n")
      .find((line) => line.startsWith("Selected text 1 is inside"))!;
    assert.include(hint, "paper_read {");
    assert.notInclude(hint, "attachmentId");
    assert.notInclude(text, "for attachment");
  });

  it("is a valid paper_read call in the page hint of a whole-text paper", async function () {
    const rendered = renderSelectedTextAnchorContext({
      selectedTextContexts: [
        { text: SELECTED, source: "pdf", contextItemId: 21, pageIndex: 3 },
      ],
      anchors: [
        {
          contextIndex: 0,
          contextItemId: 21,
          paperContext: paper,
          pageIndex: 3,
          resolution: "locator-only",
          preferredChunkIndexes: [],
          injectedChars: 0,
        },
      ],
      readCalls: true,
    });
    assert.include(rendered, PAGE_HINT(4));
    const named = calls(rendered);
    assert.lengthOf(named, 1);
    const validated = validate(named[0]);
    assert.isTrue(validated.ok, validated.ok ? "" : validated.error);
    assert.notInclude(rendered, "attachmentId");
  });

  it("points a targeted call that names an attachmentId at contextItemId", function () {
    const validated = validate({
      mode: "targeted",
      target: { attachmentId: 21 },
      pages: [4],
    });
    assert.isFalse(validated.ok);
    if (!validated.ok) assert.include(validated.error, "contextItemId");
  });

  it("gives only the page when the selection's paper is unknown", function () {
    const rendered = renderSelectedTextAnchorContext({
      selectedTextContexts: [
        { text: SELECTED, source: "pdf", contextItemId: 21, pageIndex: 3 },
      ],
      anchors: [
        {
          contextIndex: 0,
          contextItemId: 21,
          pageIndex: 3,
          resolution: "locator-only",
          preferredChunkIndexes: [],
          injectedChars: 0,
        },
      ],
      readCalls: true,
    });
    assert.include(
      rendered,
      "If more context is required, read PDF page 4 with one neighboring page.",
    );
    assert.deepEqual(calls(rendered), []);
    assert.notInclude(rendered, "for attachment");
  });
});

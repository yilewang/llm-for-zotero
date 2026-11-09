import { assert } from "chai";
import {
  buildChunkIndex,
  buildDocumentOutline,
  allowsChapterMap,
  chunkPlainPdfText,
  sectionTextPieces,
} from "../src/services/paperContent/pdfContext";
import { buildIndexDocumentFromPdfContext } from "../src/services/libraryTextIndex/indexer";
import type { PdfOutlineEntry } from "../src/services/paperContent/documentStructure";
import type {
  PdfChunkMeta,
  PdfContext,
} from "../src/services/paperContent/types";
import {
  BOOK_BOOKMARKS,
  BOOK_LEADING_BLANK_PAGES,
  BOOK_PAGES,
  DISSERTATION_PAGES,
  joinPages,
} from "./fixtures/longdoc/pageTexts";

const PAPER_TEXT = joinPages([
  [
    "Adaptive front tracking for thin films",
    "1 Introduction",
    "Thin films spread over surfaces in many settings.",
  ],
  ["the rate depends on the contact line.", "2 Methods", "We use elements."],
  ["the step follows a bound.", "3 Results", "The front advances."],
]);

function contextOf(
  text: string,
  structure: boolean,
  totalPages: number,
): PdfContext {
  const parts = chunkPlainPdfText(text, "zotero-worker", {
    layout: { totalPages },
    ...(structure ? { structure: { bookmarks: null } } : {}),
  });
  return {
    title: "Fixture",
    ...parts,
    ...buildChunkIndex(parts.chunks),
    fullLength: text.length,
    sourceType: "zotero-worker",
  };
}

function indexRows(ctx: PdfContext): string {
  return JSON.stringify(
    buildIndexDocumentFromPdfContext({
      attachmentId: 7,
      attachmentKey: "KEY",
      libraryID: 1,
      parentItemId: null,
      fileState: { mtime: 1, size: 2 } as never,
      ctx,
    }),
  );
}

/** A page's worth of body text: real pages hold more than one chunk. */
const BODY = "The argument continues with further detail on this page. ".repeat(
  45,
);

describe("document structure on plain PDF chunks", function () {
  const text = joinPages(DISSERTATION_PAGES.map((lines) => [...lines, BODY]));
  const pages = DISSERTATION_PAGES.length;

  it("gives every chunk of a chaptered text its section, path and pages", function () {
    const ctx = contextOf(text, true, pages);
    const structure = ctx.documentStructure;
    assert.equal(structure?.source, "headings");
    assert.equal(structure?.pageCount, pages);
    for (const meta of ctx.chunkMeta) {
      assert.isNumber(meta.sectionIndex, meta.text.slice(0, 40));
      assert.isNumber(meta.pageStart, meta.text.slice(0, 40));
    }
    const chapter2 = ctx.chunkMeta.find((meta) =>
      meta.text.startsWith("Chapter 2:"),
    )!;
    assert.isDefined(chapter2, "a chunk opens chapter 2's page");
    // The chunk starts on the chapter's own heading line, before 2.1.
    assert.equal(
      chapter2.sectionPath,
      "Chapter 2:Philosophical and historical background",
    );
    assert.equal(chapter2.sectionLevel, 1);
    assert.equal(chapter2.pageStart, 6);
    const plato = ctx.chunkMeta.find((meta) =>
      meta.text.startsWith("Figure 2.1:"),
    )!;
    assert.equal(
      plato.sectionPath,
      "Chapter 2:Philosophical and historical background › 2.1The relationship between perception and reality › 2.1.1Plato and the Allegory of the Cave",
    );
    assert.equal(plato.sectionLabel, "2.1.1Plato and the Allegory of the Cave");
  });

  it("keeps the plain chunk metadata beside the structured one", function () {
    const structured = contextOf(text, true, pages);
    const plain = contextOf(text, false, pages);
    assert.deepEqual(
      structured.chunks,
      plain.chunks,
      "chunk text is unchanged",
    );
    assert.deepEqual(
      structured.documentStructure?.plainChunkMeta,
      plain.chunkMeta,
    );
    assert.isUndefined(plain.documentStructure);
  });

  it("stores byte-identical library index rows whoever loaded the text", function () {
    assert.equal(
      indexRows(contextOf(text, true, pages)),
      indexRows(contextOf(text, false, pages)),
    );
  });

  it("stores the same index rows for a chat load with bookmarks and a background load", function () {
    const bookmarks: PdfOutlineEntry[] = [
      ["Chapter 1:Introduction", 2, 0],
      ["1.1Visual processing and representations in the brain", 4, 1],
      ["1.2Hierarchical architecture of the visual cortex", 5, 1],
      ["Chapter 2:Philosophical and historical background", 6, 0],
    ].map(([title, pageIndex, depth]) => ({
      depth: Number(depth),
      title: String(title),
      pageIndex: Number(pageIndex),
      top: null,
      fitsPage: false,
    }));
    const silent = chunkPlainPdfText(text, "zotero-worker", {
      layout: { totalPages: pages },
    });
    for (const chapters of [true, false]) {
      const chat = chunkPlainPdfText(text, "zotero-worker", {
        layout: { totalPages: pages },
        structure: { bookmarks, chapters },
      });
      assert.isDefined(
        chat.documentStructure?.pieces ?? chat.bookmarkSections?.pieces,
      );
      const asContext = (parts: typeof chat): PdfContext => ({
        title: "Fixture",
        ...parts,
        ...buildChunkIndex(parts.chunks),
        fullLength: text.length,
        sourceType: "zotero-worker",
      });
      assert.equal(
        indexRows(asContext(chat)),
        indexRows(asContext(silent)),
        `chapters: ${chapters}`,
      );
    }
  });

  it("gives each leaf section exactly its own text, with LF or CRLF line ends", function () {
    const squash = (value: string) => value.replace(/\s+/g, " ").trim();
    for (const source of [text, text.replace(/\n/g, "\r\n")]) {
      const parts = chunkPlainPdfText(source, "zotero-worker", {
        layout: { totalPages: pages },
        structure: { bookmarks: null },
      });
      const ctx: PdfContext = {
        title: "Fixture",
        ...parts,
        ...buildChunkIndex(parts.chunks),
        fullLength: source.length,
        sourceType: "zotero-worker",
      };
      const sections = parts.documentStructure!.sections;
      const outline = buildDocumentOutline(ctx);
      for (const [index, section] of outline.sections.entries()) {
        if (section.childIds.length) continue;
        const own = sections[index];
        const read = sectionTextPieces(ctx, section)
          .map((piece) => piece.text)
          .join("\n");
        assert.equal(
          squash(read),
          squash(source.slice(own.charStart, own.charEnd)),
          section.title,
        );
      }
    }
  });

  it("keeps a heading with its section when paragraphs are joined across separators longer than a blank line", function () {
    const squash = (value: string) => value.replace(/\s+/g, " ").trim();
    const shortParas = Array.from(
      { length: 20 },
      (_, i) => `Short paragraph number ${i} has some words.`,
    );
    const big = "Long body sentence goes here. ".repeat(100);
    for (const separator of ["\n\n", "\n\n\n", "\n \n"]) {
      const page0 = ["Chapter 1 Alpha", ...shortParas].join(separator);
      const source = `${page0}\n\f` + `Chapter 2 Beta\n\n${big}`;
      const bookmarks = [
        {
          depth: 0,
          title: "Chapter 1 Alpha",
          pageIndex: 0,
          top: null,
          fitsPage: true,
        },
        {
          depth: 0,
          title: "Chapter 2 Beta",
          pageIndex: 1,
          top: null,
          fitsPage: true,
        },
      ];
      const parts = chunkPlainPdfText(source, "zotero-worker", {
        layout: { totalPages: 2 },
        structure: { bookmarks, chapters: true },
      } as never);
      const ctx: PdfContext = {
        title: "Fixture",
        ...parts,
        ...buildChunkIndex(parts.chunks),
        fullLength: source.length,
        sourceType: "zotero-worker",
      };
      const sections = parts.documentStructure!.sections;
      const outline = buildDocumentOutline(ctx);
      assert.equal(outline.sections.length, 2, JSON.stringify(separator));
      for (const [index, section] of outline.sections.entries()) {
        const own = sections[index];
        const read = sectionTextPieces(ctx, section)
          .map((piece) => piece.text)
          .join(" ");
        assert.equal(
          squash(read),
          squash(source.slice(own.charStart, own.charEnd)),
          `${section.title} with ${JSON.stringify(separator)}`,
        );
      }
    }
  });

  it("leaves a paper's chunk metadata as it was", function () {
    const structured = contextOf(PAPER_TEXT, true, 3);
    const plain = contextOf(PAPER_TEXT, false, 3);
    assert.isUndefined(structured.documentStructure);
    assert.deepEqual(structured.chunkMeta, plain.chunkMeta);
  });

  it("builds the map: top level, children, pages from 1, sizes with subsections", function () {
    const outline = buildDocumentOutline(contextOf(text, true, pages));
    assert.isTrue(outline.chaptered);
    assert.equal(outline.pageCount, pages);
    const top = outline.sections.filter((section) => !section.parentId);
    assert.deepEqual(
      top.map((section) => [section.title, section.pageStart, section.pageEnd]),
      [
        ["(before the first section)", 1, 2],
        ["Chapter 1:Introduction", 3, 6],
        ["Chapter 2:Philosophical and historical background", 7, 8],
        [
          "Chapter 3:Variational Inference & Variational Autoencoders (VAE)",
          9,
          10,
        ],
      ],
    );
    const chapter1 = top[1];
    const children = outline.sections.filter(
      (section) => section.parentId === chapter1.sectionId,
    );
    assert.deepEqual(
      chapter1.childIds,
      children.map((section) => section.sectionId),
    );
    assert.lengthOf(children, 2);
    assert.isAbove(chapter1.chars, chapter1.ownChars);
    assert.isAtLeast(
      chapter1.tokens,
      children.reduce((sum, child) => sum + child.tokens, 0),
    );
    assert.isAtMost(chapter1.chunkIndexes[0], children[0].chunkIndexes[0]);
    assert.isAtLeast(chapter1.chunkIndexes[1], children[1].chunkIndexes[1]);
  });
});

describe("MinerU outline hierarchy", function () {
  function mineruContext(
    rows: Array<{ index: number; label: string; path: string; level: number }>,
  ): PdfContext {
    const chunkMeta: PdfChunkMeta[] = rows.map((row, chunkIndex) => ({
      chunkIndex,
      text: `Text of ${row.label}. `.repeat(4),
      normalizedText: "",
      chunkKind: "body",
      sectionIndex: row.index,
      sectionLabel: row.label,
      sectionPath: row.path,
      sectionLevel: row.level,
      sourceType: "mineru",
    }));
    return {
      title: "Paper",
      chunks: chunkMeta.map((meta) => meta.text),
      chunkMeta,
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 0,
      fullLength: 0,
      sourceType: "mineru",
    };
  }

  it("nests sections by their heading paths, the title block aside", function () {
    const outline = buildDocumentOutline(
      mineruContext([
        { index: 0, label: "A Paper Title", path: "A Paper Title", level: 1 },
        { index: 1, label: "1 Introduction", path: "1 Introduction", level: 2 },
        { index: 2, label: "2 Algorithm", path: "2 Algorithm", level: 2 },
        {
          index: 3,
          label: "2.1 Weak form",
          path: "2 Algorithm › 2.1 Weak form",
          level: 3,
        },
        { index: 4, label: "3 Results", path: "3 Results", level: 2 },
      ]),
    );
    assert.isUndefined(outline.chaptered);
    assert.deepEqual(
      outline.sections.map((section) => [
        section.sectionId,
        section.parentId ?? null,
        section.childIds,
      ]),
      [
        ["s0", null, []],
        ["s1", null, []],
        ["s2", null, ["s3"]],
        ["s3", "s2", []],
        ["s4", null, []],
      ],
    );
    const algorithm = outline.sections[2];
    assert.deepEqual(algorithm.chunkIndexes, [2, 3]);
    assert.equal(
      algorithm.chars,
      algorithm.ownChars + outline.sections[3].chars,
    );
  });

  it("keeps a paper with only level-1 headings flat and unchaptered", function () {
    const outline = buildDocumentOutline(
      mineruContext([
        { index: 0, label: "Introduction", path: "Introduction", level: 1 },
        { index: 1, label: "Methods", path: "Methods", level: 1 },
        { index: 2, label: "Results", path: "Results", level: 1 },
      ]),
    );
    assert.isUndefined(outline.chaptered);
    for (const section of outline.sections) {
      assert.isUndefined(section.parentId);
      assert.deepEqual(section.childIds, []);
    }
  });
});

describe("chapter map by item type", function () {
  it("turns the map off for article types only", function () {
    for (const type of [
      "journalArticle",
      "preprint",
      "conferencePaper",
      "magazineArticle",
      "newspaperArticle",
    ]) {
      assert.isFalse(allowsChapterMap(type), type);
    }
    for (const type of ["book", "thesis", "report", undefined]) {
      assert.isTrue(allowsChapterMap(type), String(type));
    }
  });

  it("keeps pages, bookmark sections and the shift when chapters are off", function () {
    const text = joinPages(DISSERTATION_PAGES.map((lines) => [...lines, BODY]));
    const layout = { totalPages: DISSERTATION_PAGES.length };
    const on = chunkPlainPdfText(text, "zotero-worker", {
      layout,
      structure: { bookmarks: null },
    });
    const off = chunkPlainPdfText(text, "zotero-worker", {
      layout,
      structure: { bookmarks: null, chapters: false },
    });
    assert.isDefined(on.documentStructure);
    assert.isUndefined(off.documentStructure);
    assert.deepEqual(off.chunks, on.chunks);
    assert.deepEqual(off.chunkMeta, on.documentStructure?.plainChunkMeta);
    assert.isDefined(off.textPages);
    assert.isUndefined(off.textPageOffset);
  });

  it("keeps the bookmark sections and proven shift of a bookmarked book", function () {
    const text = joinPages(BOOK_PAGES);
    const layout = {
      totalPages: BOOK_PAGES.length + BOOK_LEADING_BLANK_PAGES,
    };
    const base = { layout, structure: { bookmarks: BOOK_BOOKMARKS } };
    const off = chunkPlainPdfText(text, "zotero-worker", {
      ...base,
      structure: { ...base.structure, chapters: false },
    });
    assert.isUndefined(off.documentStructure);
    assert.isDefined(off.bookmarkSections);
    assert.equal(off.textPageOffset?.pageOffset, BOOK_LEADING_BLANK_PAGES);
    assert.isDefined(off.textPages);
  });
});

describe("structure of text that lost pages", function () {
  const chapterPages = (titles: string[]) => {
    const text = joinPages(titles.map((title) => [title, BODY]));
    const bookmark = (pageIndex: number, at: number): PdfOutlineEntry => ({
      depth: 0,
      title: titles[at],
      pageIndex,
      top: null,
      fitsPage: true,
    });
    return { text, bookmark };
  };

  it("has no chapter map, page map or shift when the bookmarks prove no shift", function () {
    // One blank page lost; each chapter title heads every page of its
    // chapter, so shifts 0 and 1 tie.
    const { text, bookmark } = chapterPages([
      "Chapter 1 Origins",
      "Chapter 1 Origins",
      "Chapter 2 Methods",
      "Chapter 2 Methods",
    ]);
    const parts = chunkPlainPdfText(text, "zotero-worker", {
      layout: { totalPages: 5 },
      structure: { bookmarks: [bookmark(1, 0), bookmark(3, 2)] },
    });
    const plain = chunkPlainPdfText(text, "zotero-worker", {
      layout: { totalPages: 5 },
    });
    assert.isUndefined(parts.documentStructure);
    assert.isUndefined(parts.textPages);
    assert.isUndefined(parts.bookmarkSections);
    assert.isUndefined(parts.textPageOffset);
    assert.deepEqual(parts.chunkMeta, plain.chunkMeta);
  });

  it("stores a proven shift of 0 for text that lost only trailing pages", function () {
    const { text, bookmark } = chapterPages([
      "Chapter 1 Origins",
      "Chapter 1 Origins",
      "Chapter 2 Methods",
      "Chapter 2 Methods",
    ]);
    const parts = chunkPlainPdfText(text, "zotero-worker", {
      layout: { totalPages: 6 },
      structure: {
        bookmarks: [bookmark(0, 0), bookmark(2, 2)],
        chapters: false,
      },
    });
    assert.deepEqual(parts.textPageOffset, { pageOffset: 0, textParts: 4 });
    assert.lengthOf(parts.textPages || [], 6);
    assert.equal(parts.textPages?.[4]?.tokens, 0);
  });

  it("places pageChars text by its pageChars: section and chunk pages agree", function () {
    // Fixture assumption: pageChars lists fewer pages than the PDF has.
    const pages = BOOK_PAGES.map((lines) => [...lines, BODY].join("\n") + "\n");
    const layout = {
      pageChars: pages.map((page) => page.length),
      totalPages: BOOK_PAGES.length + BOOK_LEADING_BLANK_PAGES,
    };
    const shifted = chunkPlainPdfText(pages.join(""), "zotero-worker", {
      layout,
      structure: { bookmarks: BOOK_BOOKMARKS },
    });
    assert.equal(shifted.textPageOffset?.pageOffset, 0, "no bookmark shift");
    // Bookmarks that name the pageChars pages chapter the text.
    const parts = chunkPlainPdfText(pages.join(""), "zotero-worker", {
      layout,
      structure: {
        bookmarks: BOOK_BOOKMARKS.map((entry) => ({
          ...entry,
          pageIndex: entry.pageIndex - BOOK_LEADING_BLANK_PAGES,
        })),
      },
    });
    const sections = parts.documentStructure?.sections;
    assert.isDefined(sections);
    for (const meta of parts.chunkMeta) {
      const section = sections![meta.sectionIndex!];
      assert.isAtLeast(meta.pageStart!, section.pageStart, section.title);
      assert.isAtMost(meta.pageStart!, section.pageEnd, section.title);
    }
  });
});

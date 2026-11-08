import { assert } from "chai";
import {
  buildChunkIndex,
  buildDocumentOutline,
  chunkPlainPdfText,
} from "../src/services/paperContent/pdfContext";
import { buildIndexDocumentFromPdfContext } from "../src/services/libraryTextIndex/indexer";
import type {
  PdfChunkMeta,
  PdfContext,
} from "../src/services/paperContent/types";
import { DISSERTATION_PAGES, joinPages } from "./fixtures/longdoc/pageTexts";

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

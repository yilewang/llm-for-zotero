/**
 * Chaptered-document detection on three real PDFs, pinned from fixtures that
 * hold only their bookmarks and, per text page, its first and last line and
 * its bookmark-title lines, long lines cut (test/fixtures/longdoc/corpus;
 * sources and licenses inside).
 */
import { assert } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BEFORE_FIRST_SECTION_TITLE,
  detectDocumentStructure,
  type PdfOutlineEntry,
} from "../src/services/paperContent/documentStructure";

type CorpusFixture = {
  totalPages: number;
  bookmarks: PdfOutlineEntry[];
  pages: string[][];
};

function load(name: string): CorpusFixture {
  return JSON.parse(
    readFileSync(
      join(__dirname, "fixtures", "longdoc", "corpus", `${name}.json`),
      "utf8",
    ),
  );
}

function detect(
  fixture: CorpusFixture,
  bookmarks: PdfOutlineEntry[] = fixture.bookmarks,
) {
  return detectDocumentStructure({
    text: fixture.pages.map((lines) => lines.join("\n")).join("\f"),
    layout: { totalPages: fixture.totalPages },
    bookmarks,
  });
}

function topLevel(structure: ReturnType<typeof detect>): string[] {
  return (structure?.sections || [])
    .filter(
      (section) =>
        section.level === 1 && section.title !== BEFORE_FIRST_SECTION_TITLE,
    )
    .map((section) => section.title);
}

describe("chaptered-document detection on real PDFs", function () {
  it("chapters the dissertation by its bookmarks: 12 top-level parts", function () {
    const structure = detect(load("dissertation"));
    assert.equal(structure?.source, "bookmarks");
    assert.lengthOf(topLevel(structure), 12);
  });

  it("chapters Psychology 2e by its bookmarks: 20 top-level parts", function () {
    const structure = detect(load("psychology2e"));
    assert.equal(structure?.source, "bookmarks");
    assert.equal(structure?.pageOffset, 2);
    assert.lengthOf(topLevel(structure), 20);
  });

  it("chapters Psychology 2e by its text alone: chapter titles close their opening pages", function () {
    const fixture = load("psychology2e");
    // No destination heights: only the titles on the pages can decide.
    const structure = detect(
      fixture,
      fixture.bookmarks.map((entry) => ({ ...entry, top: null })),
    );
    assert.lengthOf(topLevel(structure), 20);
    // The chapter owns its opening page, which closes with its title.
    const chapter = structure!.sections.find(
      (section) => section.title === "Chapter 1 Introduction to Psychology",
    )!;
    assert.equal(chapter.pageStart, 18);
  });

  it('chapters the thesis by its bookmarks: its last part opens with a "Part IV" line', function () {
    // Its "Manuscripts" bookmark sits below the page top; the page opens
    // with a "Part IV" line, then the title.
    const structure = detect(load("thesis-2312.13478"));
    assert.equal(structure?.source, "bookmarks");
    assert.deepEqual(topLevel(structure), [
      "Declaration",
      "Dedication",
      "Contents",
      "Preface",
      "Summary",
      "Synopsis",
      "Manuscripts Information",
      "Outlook",
      "Manuscripts",
    ]);
    const manuscripts = structure!.sections.find(
      (section) => section.title === "Manuscripts",
    )!;
    assert.equal(manuscripts.pageStart, 108);
  });

  it("falls back to the dissertation's headings without its bookmarks", function () {
    const structure = detect(load("dissertation"), []);
    assert.equal(structure?.source, "headings");
  });
});

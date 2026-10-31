import { assert } from "chai";
import {
  READ_SCOPE_JSON_SCHEMA,
  READ_SCOPE_OVERRIDES_JSON_SCHEMA,
  parseReadScope,
  readScopeKey,
  type ReadScope,
} from "../src/agent/digests/readScope";
import {
  selectMineruScopeSections,
  selectPageScope,
  selectPdfChunkScopeSections,
} from "../src/agent/digests/readScopeText";
import { sanitizeGeminiSchema } from "../src/agent/model/geminiNative";
import { readPaperScopeText } from "../src/agent/tools/read/paperRead";
import { buildChunkMetadata } from "../src/services/paperContent/pdfContext";
import type { PdfContext } from "../src/services/paperContent/types";

const MD = [
  "# Drift in place cells",
  "",
  "## Abstract",
  "",
  "We ask whether representational drift impairs decoding of position.",
  "",
  "## 1 Introduction",
  "",
  "Place cells drift slowly across days.",
  "",
  "## 2 Results",
  "",
  "Decoding stayed above chance on every day we recorded.",
  "",
  "### 2.1 Model fit",
  "",
  "The drift model fit the population vectors well.",
  "",
  "## 3 Discussion",
  "",
  "Drift and stable decoding can coexist.",
].join("\n");

/** Plain PDF text with standard headings, as the PDF reader chunks it. */
const HEADED_CHUNKS = [
  "Abstract\nWe ask whether representational drift impairs decoding of position in hippocampus.",
  "1. Introduction\nPlace cells drift slowly across days in many recordings.",
  "3. Results\nDecoding stayed above chance on every recorded day of the study.",
  "Discussion\nDrift and stable decoding can coexist in one network.",
];

/** Plain PDF text with no headings at all. */
const UNHEADED_CHUNKS = [
  "Representational drift was measured over ten days in hippocampal recordings.",
  "Decoding stayed above chance on each of the ten recorded days of the study.",
];

function pdfContext(chunks: string[]): PdfContext {
  return {
    title: "Drift",
    chunks,
    chunkMeta: buildChunkMetadata(chunks, "zotero-worker"),
    chunkStats: [],
    docFreq: {},
    avgChunkLength: 0,
    fullLength: chunks.join("\n\n").length,
  };
}

const scope = (value: unknown): ReadScope => {
  const parsed = parseReadScope(value, "read");
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.scope;
};

describe("read scope", function () {
  describe("tool schema", function () {
    it("keeps per-paper overrides and page ranges as objects through Gemini's schema dialect", function () {
      const overrides: any = sanitizeGeminiSchema(
        READ_SCOPE_OVERRIDES_JSON_SCHEMA,
      );
      assert.equal(overrides.type, "array");
      assert.equal(overrides.items.type, "object");
      assert.deepEqual(Object.keys(overrides.items.properties).sort(), [
        "itemId",
        "read",
      ]);
      assert.equal(overrides.items.properties.itemId.type, "integer");
      const read = overrides.items.properties.read;
      assert.equal(read.type, "object");
      assert.deepEqual(read.properties.sections, {
        type: "array",
        items: { type: "string" },
      });
      assert.equal(read.properties.pages.items.type, "object");
      assert.deepEqual(
        Object.keys(read.properties.pages.items.properties).sort(),
        ["from", "to"],
      );
      assert.equal(read.properties.pages.items.properties.from.type, "integer");
      const alone: any = sanitizeGeminiSchema(READ_SCOPE_JSON_SCHEMA);
      assert.equal(alone.properties.pages.items.properties.to.type, "integer");
    });

    it("says that pages are PDF page numbers, not printed labels", function () {
      assert.match(
        READ_SCOPE_JSON_SCHEMA.properties.pages.description,
        /not printed labels/,
      );
    });
  });

  describe("parseReadScope", function () {
    it("accepts each source and refuses a malformed one with the reason", function () {
      assert.deepEqual(scope({ source: "abstract" }), { source: "abstract" });
      assert.deepEqual(
        scope({
          source: "sections",
          sections: ["Abstract", "abstract", " results "],
        }),
        { source: "sections", sections: ["Abstract", "results"] },
      );
      assert.deepEqual(
        scope({ source: "pages", pages: [{ from: 3, to: 5 }] }),
        {
          source: "pages",
          pages: [{ from: 3, to: 5 }],
        },
      );
      for (const bad of [
        null,
        { source: "everything" },
        { source: "sections" },
        { source: "sections", sections: [] },
        { source: "pages", pages: [{ from: 5, to: 3 }] },
        { source: "pages", pages: [{ from: 0, to: 1 }] },
      ]) {
        const parsed = parseReadScope(bad, "read");
        assert.isFalse(parsed.ok, JSON.stringify(bad));
      }
    });

    it("names the same scope with one key however it was written", function () {
      assert.equal(readScopeKey(undefined), "full");
      assert.equal(readScopeKey({ source: "full" }), "full");
      assert.equal(
        readScopeKey(scope({ source: "sections", sections: ["Results"] })),
        readScopeKey(scope({ source: "sections", sections: ["results"] })),
      );
      assert.notEqual(
        readScopeKey({ source: "abstract" }),
        readScopeKey(undefined),
      );
    });
  });

  describe("section selection", function () {
    it("cuts MinerU text by its exact heading bounds, with descendant sections", function () {
      const selected = selectMineruScopeSections(MD, ["results"]);
      assert.include(selected.text, "## 2 Results");
      assert.include(selected.text, "### 2.1 Model fit");
      assert.include(selected.text, "The drift model fit");
      assert.notInclude(selected.text, "Discussion");
      assert.notInclude(selected.text, "Introduction");
      assert.deepEqual(selected.covered, ["Results"]);
      assert.deepEqual(selected.unmatched, []);
    });

    it("matches a non-standard name only by every word of a heading, never the title", function () {
      const selected = selectMineruScopeSections(MD, ["model fit", "drift"]);
      assert.include(selected.text, "### 2.1 Model fit");
      assert.notInclude(selected.text, "Decoding stayed above chance");
      // "drift" is in the title only: the title never matches.
      assert.deepEqual(selected.unmatched, ["drift"]);
    });

    it("matches a standard section name by heading kind only, not by words in other headings", function () {
      const md = [
        "# Place cells drift",
        "## Abstract",
        "We study drift.",
        "## Methods",
        "Method text.",
        "## Results",
        "### Abstract representations emerge in CA1",
        "Results subsection text.",
        "### Comparison with other methods",
        "More results.",
        "## Discussion",
        "Discussion text.",
      ].join("\n");
      const abstract = selectMineruScopeSections(md, ["abstract"]);
      assert.include(abstract.text, "We study drift.");
      assert.notInclude(abstract.text, "Abstract representations");
      assert.notInclude(abstract.text, "Results subsection text.");
      const methods = selectMineruScopeSections(md, ["methods"]);
      assert.include(methods.text, "Method text.");
      assert.notInclude(methods.text, "Comparison with other methods");
      assert.notInclude(methods.text, "More results.");
      // Names that are not standard sections still match by every word.
      const words = selectMineruScopeSections(md, ["comparison"]);
      assert.include(words.text, "### Comparison with other methods");
      assert.deepEqual(words.covered, ["comparison"]);
    });

    it("cuts plain PDF text by chunk kind and reports names it has no kind for", function () {
      const selected = selectPdfChunkScopeSections(pdfContext(HEADED_CHUNKS), [
        "results",
        "data availability",
      ]);
      assert.include(selected.text, "[chunk 2]");
      assert.include(selected.text, "Decoding stayed above chance");
      assert.notInclude(selected.text, "[chunk 0]");
      assert.notInclude(selected.text, "[chunk 3]");
      assert.deepEqual(selected.covered, ["Results"]);
      assert.deepEqual(selected.unmatched, ["data availability"]);
    });

    it("reads nothing from plain PDF text with no headings", function () {
      const selected = selectPdfChunkScopeSections(
        pdfContext(UNHEADED_CHUNKS),
        ["abstract", "results"],
      );
      assert.equal(selected.text, "");
      assert.deepEqual(selected.covered, []);
      assert.deepEqual(selected.unmatched, ["abstract", "results"]);
    });

    it("cuts page text by the named pages", function () {
      const selected = selectPageScope(
        [
          { pageIndex: 0, text: "First page." },
          { pageIndex: 1, text: "Second page." },
          { pageIndex: 2, text: "Third page." },
        ],
        [
          { from: 2, to: 3 },
          { from: 9, to: 9 },
        ],
      );
      assert.equal(
        selected.text,
        "[page 2]\nSecond page.\n\n[page 3]\nThird page.",
      );
      assert.deepEqual(selected.covered, ["pages 2–3"]);
      assert.deepEqual(selected.unmatched, ["pages 9"]);
    });
  });

  describe("readPaperScopeText", function () {
    const globalScope = globalThis as unknown as Record<string, unknown>;
    let hadIOUtils = false;
    let previousIOUtils: unknown;
    beforeEach(function () {
      hadIOUtils = "IOUtils" in globalScope;
      previousIOUtils = globalScope.IOUtils;
    });
    afterEach(function () {
      if (hadIOUtils) globalScope.IOUtils = previousIOUtils;
      else delete globalScope.IOUtils;
    });

    const paper = { itemId: 1, contextItemId: 101, title: "Drift" };
    const mineruPaper = { ...paper, mineruCacheDir: "/tmp/mineru/101" };
    const withMarkdown = (md: string) => {
      globalScope.IOUtils = { read: async () => new TextEncoder().encode(md) };
    };
    const pdf = (chunks: string[] | null) => ({
      getOverviewExcerpt: async () => {
        throw new Error("a scoped read never reads the overview");
      },
      ensurePaperContext: async () => (chunks ? pdfContext(chunks) : undefined),
    });

    it("reads MinerU sections exactly, the abstract from the Zotero field first", async function () {
      withMarkdown(MD);
      const read = await readPaperScopeText({
        paperContext: mineruPaper,
        scope: scope({
          source: "sections",
          sections: ["abstract", "results"],
        }),
        maxChars: 250_000,
        pdfService: pdf(null),
        readAbstractNote: () => "The Zotero record's own abstract text.",
      });
      assert.exists(read);
      assert.equal(read!.backend, "mineru");
      assert.equal(read!.bounds, "exact");
      assert.isTrue(read!.complete);
      assert.deepEqual(read!.covered, ["Abstract", "Results"]);
      assert.deepEqual(read!.unmatched, []);
      assert.include(read!.source, "Zotero abstract field");
      assert.include(read!.source, "MinerU sections");
      assert.isTrue(
        read!.text.startsWith(
          "## Abstract\nThe Zotero record's own abstract text.",
        ),
      );
      assert.include(read!.text, "### 2.1 Model fit");
      // The MinerU abstract is not read again beside the field's.
      assert.notInclude(read!.text, "We ask whether");
      assert.notInclude(read!.text, "Discussion");
    });

    it("falls back to the PDF abstract when the Zotero field is empty, and names it", async function () {
      withMarkdown(MD);
      const fromMineru = await readPaperScopeText({
        paperContext: mineruPaper,
        scope: { source: "abstract" },
        maxChars: 250_000,
        pdfService: pdf(null),
        readAbstractNote: () => "",
      });
      assert.equal(fromMineru!.source, "PDF abstract");
      assert.equal(fromMineru!.bounds, "exact");
      assert.equal(
        fromMineru!.text,
        "We ask whether representational drift impairs decoding of position.",
      );

      const fromPdf = await readPaperScopeText({
        paperContext: paper,
        scope: { source: "abstract" },
        maxChars: 250_000,
        pdfService: pdf(HEADED_CHUNKS),
        readAbstractNote: () => "",
      });
      assert.equal(fromPdf!.source, "PDF abstract");
      assert.equal(fromPdf!.bounds, "approximate");
      assert.equal(fromPdf!.backend, "pdf");
      assert.include(fromPdf!.text, "We ask whether representational drift");
      assert.notInclude(fromPdf!.text, "[chunk");
      assert.notInclude(fromPdf!.text, "Place cells drift");

      const field = await readPaperScopeText({
        paperContext: paper,
        scope: { source: "abstract" },
        maxChars: 250_000,
        pdfService: pdf(HEADED_CHUNKS),
        readAbstractNote: () => "  Field abstract.  ",
      });
      assert.equal(field!.source, "Zotero abstract field");
      assert.equal(field!.backend, "text");
      assert.equal(field!.text, "Field abstract.");
    });

    it("reads plain PDF sections approximately and names what it did not find", async function () {
      const read = await readPaperScopeText({
        paperContext: paper,
        scope: scope({
          source: "sections",
          sections: ["results", "methods"],
        }),
        maxChars: 250_000,
        pdfService: pdf(HEADED_CHUNKS),
      });
      assert.equal(read!.backend, "pdf");
      assert.equal(read!.bounds, "approximate");
      assert.deepEqual(read!.covered, ["Results"]);
      assert.deepEqual(read!.unmatched, ["methods"]);
      assert.include(read!.text, "Decoding stayed above chance");
      assert.notInclude(read!.text, "Place cells drift");
    });

    it("reads nothing, never the body, from a PDF with no headings", async function () {
      const read = await readPaperScopeText({
        paperContext: paper,
        scope: scope({
          source: "sections",
          sections: ["abstract", "results"],
        }),
        maxChars: 250_000,
        pdfService: pdf(UNHEADED_CHUNKS),
        readAbstractNote: () => "",
      });
      assert.exists(read, "the paper has text, so it is not 'no text'");
      assert.equal(read!.text, "");
      assert.deepEqual(read!.covered, []);
      assert.deepEqual(read!.unmatched, ["abstract", "results"]);

      const onlyAbstract = await readPaperScopeText({
        paperContext: paper,
        scope: { source: "abstract" },
        maxChars: 250_000,
        pdfService: pdf(UNHEADED_CHUNKS),
        readAbstractNote: () => "",
      });
      assert.equal(onlyAbstract!.text, "");
      assert.deepEqual(onlyAbstract!.unmatched, ["abstract"]);
    });

    it("reads the named pages, the notes and the record", async function () {
      const pages = await readPaperScopeText({
        paperContext: paper,
        scope: scope({ source: "pages", pages: [{ from: 2, to: 2 }] }),
        maxChars: 250_000,
        pdfService: pdf(null),
        readPageTexts: async () => [
          { pageIndex: 0, text: "One." },
          { pageIndex: 1, text: "Two." },
        ],
      });
      assert.equal(pages!.text, "[page 2]\nTwo.");
      assert.equal(pages!.source, "PDF page text");

      const notes = await readPaperScopeText({
        paperContext: paper,
        scope: { source: "notes" },
        maxChars: 250_000,
        pdfService: pdf(null),
        readNotes: () => [{ title: "My note", noteText: "Drift matters." }],
      });
      assert.equal(notes!.text, "## My note\nDrift matters.");
      assert.deepEqual(notes!.covered, ["notes"]);

      const metadata = await readPaperScopeText({
        paperContext: paper,
        scope: { source: "metadata" },
        maxChars: 250_000,
        pdfService: pdf(null),
        readMetadata: () => "Title: Drift",
      });
      assert.equal(metadata!.text, "Title: Drift");
    });

    it("reads the full text as before when the scope is full", async function () {
      withMarkdown(MD);
      const read = await readPaperScopeText({
        paperContext: mineruPaper,
        maxChars: 250_000,
        pdfService: pdf(null),
      });
      assert.equal(read!.text, MD);
      assert.isTrue(read!.complete);
      assert.deepEqual(read!.covered, ["full text"]);
    });
  });
});

import { assert } from "chai";
import {
  READ_SCOPE_JSON_SCHEMA,
  READ_SCOPE_OVERRIDES_JSON_SCHEMA,
  parseReadScope,
  readScopeKey,
  requestedPartNames,
  shownPartName,
  userPartNames,
  type ReadScope,
} from "../src/agent/digests/readScope";
import {
  LEAD_ABSTRACT_LABEL,
  RESULTS_SPAN_LABEL,
  selectLeadAbstract,
  selectMineruScopeSections,
  selectPageScope,
  selectPdfChunkScopeSections,
} from "../src/agent/digests/readScopeText";
import { sanitizeGeminiSchema } from "../src/agent/model/geminiNative";
import { readPaperScopeText } from "../src/agent/tools/read/paperRead";
import {
  buildChunkMetadata,
  buildSyntheticManifestSections,
  enclosingStandardSections,
  isBackMatterHeading,
} from "../src/services/paperContent/pdfContext";
import type { PdfContext } from "../src/services/paperContent/types";
import {
  CELL_SHAPE_MD,
  CELL_SUMMARY,
  CELL_SUMMARY_STATISTICS,
  DISCUSSION,
  INTRO_LONG,
  INTRO_SHORT,
  LEAD_ABSTRACT,
  METHODS_TEXT,
  NATURE_SHAPE_MD,
  ONLINE_CONTENT,
  REFERENCE_SPILL,
  RESULTS_A,
  RESULTS_B,
} from "./helpers/unlabelledSectionsMarkdown";

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

describe("read scope: sections a paper does not label", function () {
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
  const paper = {
    itemId: 2,
    contextItemId: 102,
    title: "Replays",
    mineruCacheDir: "/tmp/mineru/102",
  };
  const withMarkdown = (md: string) => {
    globalScope.IOUtils = { read: async () => new TextEncoder().encode(md) };
  };
  const noPdf = {
    getOverviewExcerpt: async () => {
      throw new Error("a scoped read never reads the overview");
    },
    ensurePaperContext: async () => undefined,
  };
  const readOf = (md: string, value: unknown) => {
    withMarkdown(md);
    return readPaperScopeText({
      paperContext: paper,
      scope: scope(value),
      maxChars: 250_000,
      pdfService: noPdf,
      readAbstractNote: () => "",
    });
  };

  it("reads the unheaded lead paragraph of a Nature-shape paper as its abstract, flagged approximate", async function () {
    assert.isAtLeast(LEAD_ABSTRACT.length, 600);
    assert.isAtLeast(INTRO_LONG.length, 600, "a later long paragraph");
    assert.equal(selectLeadAbstract(NATURE_SHAPE_MD), LEAD_ABSTRACT);
    const read = await readOf(NATURE_SHAPE_MD, { source: "abstract" });
    assert.equal(read!.text, LEAD_ABSTRACT);
    assert.equal(read!.bounds, "approximate");
    assert.equal(read!.source, "PDF lead paragraph");
    assert.equal(read!.backend, "mineru");
    assert.deepEqual(read!.covered, [LEAD_ABSTRACT_LABEL]);
    assert.equal(LEAD_ABSTRACT_LABEL, "Abstract (unlabelled lead)");
    assert.deepEqual(read!.unmatched, []);
    for (const other of [INTRO_SHORT, INTRO_LONG, "Ana Author1", "doi.org"])
      assert.notInclude(read!.text, other);
  });

  it("reads the topic sections before the Discussion as the results, flagged approximate", async function () {
    const selected = selectMineruScopeSections(NATURE_SHAPE_MD, ["results"]);
    assert.deepEqual(selected.covered, [RESULTS_SPAN_LABEL]);
    assert.equal(RESULTS_SPAN_LABEL, "Results (unlabelled sections)");
    assert.deepEqual(selected.unmatched, []);
    assert.isTrue(selected.approximate);
    assert.deepEqual(selected.sources, ["MinerU sections by position"]);
    assert.include(selected.text, "# Replays spread across the visual cortex");
    assert.include(selected.text, RESULTS_A);
    assert.include(selected.text, RESULTS_B);
    for (const other of [
      LEAD_ABSTRACT,
      INTRO_SHORT,
      INTRO_LONG,
      "Cortical replays predict",
      DISCUSSION,
      ONLINE_CONTENT,
      REFERENCE_SPILL,
      METHODS_TEXT,
    ])
      assert.notInclude(selected.text, other);

    // With an Introduction heading, the span starts after it.
    const withIntro = NATURE_SHAPE_MD.replace(
      INTRO_LONG,
      `# Introduction\n\n${INTRO_LONG}`,
    );
    const afterIntro = selectMineruScopeSections(withIntro, ["results"]);
    assert.include(afterIntro.text, RESULTS_A);
    assert.notInclude(afterIntro.text, INTRO_LONG);

    // Both names together, through the one scope extractor.
    const read = await readOf(NATURE_SHAPE_MD, {
      source: "sections",
      sections: ["abstract", "results"],
    });
    assert.deepEqual(read!.covered, [LEAD_ABSTRACT_LABEL, RESULTS_SPAN_LABEL]);
    assert.deepEqual(read!.unmatched, []);
    assert.equal(read!.bounds, "approximate");
    assert.equal(read!.backend, "mineru");
    assert.equal(
      read!.source,
      "PDF lead paragraph; MinerU sections by position",
    );
    assert.include(read!.text, `## ${LEAD_ABSTRACT_LABEL}\n${LEAD_ABSTRACT}`);
    assert.include(read!.text, RESULTS_B);
    assert.notInclude(read!.text, DISCUSSION);
    // Every approximate part was found by position.
    assert.isTrue(read!.approximateByPosition);

    // An abstract from PDF chunks is approximate for another reason.
    withMarkdown(
      NATURE_SHAPE_MD.replace(`${LEAD_ABSTRACT}\n\n`, "").replace(
        `${INTRO_LONG}\n\n`,
        "",
      ),
    );
    const chunked = await readPaperScopeText({
      paperContext: paper,
      scope: scope({ source: "sections", sections: ["abstract", "results"] }),
      maxChars: 250_000,
      pdfService: {
        ...noPdf,
        ensurePaperContext: async () => pdfContext(HEADED_CHUNKS),
      },
      readAbstractNote: () => "",
    });
    assert.deepEqual(chunked!.covered, ["Abstract", RESULTS_SPAN_LABEL]);
    assert.equal(chunked!.bounds, "approximate");
    assert.isUndefined(chunked!.approximateByPosition);
  });

  it("never uses a fallback when the paper labels its abstract and its results", async function () {
    // A long paragraph before the Abstract heading is not the abstract.
    const labelled = MD.replace(
      "## Abstract",
      `${LEAD_ABSTRACT}\n\n## Abstract`,
    );
    const abstract = await readOf(labelled, { source: "abstract" });
    assert.equal(abstract!.source, "PDF abstract");
    assert.equal(abstract!.bounds, "exact");
    assert.deepEqual(abstract!.covered, ["Abstract"]);
    assert.equal(
      abstract!.text,
      "We ask whether representational drift impairs decoding of position.",
    );
    const results = selectMineruScopeSections(labelled, ["results"]);
    assert.deepEqual(results.covered, ["Results"]);
    assert.isFalse(results.approximate);
    assert.deepEqual(results.sources, ["MinerU sections"]);
    const read = await readOf(labelled, {
      source: "sections",
      sections: ["abstract", "results"],
    });
    assert.equal(read!.bounds, "exact");
    assert.equal(read!.source, "PDF abstract; MinerU sections");
  });

  it("keeps the results unmatched in a paper with no Discussion heading", async function () {
    const review = [
      "# Replays across the brain: a review",
      "",
      "Ana Author1, Ben Author2",
      "",
      LEAD_ABSTRACT,
      "",
      "# Replays in sleep",
      "",
      RESULTS_A,
      "",
      "# Replays in waking",
      "",
      RESULTS_B,
      "",
      "# Outlook",
      "",
      "More work is needed.",
      "",
      "# References",
      "",
      REFERENCE_SPILL,
    ].join("\n");
    const selected = selectMineruScopeSections(review, ["results"]);
    assert.equal(selected.text, "");
    assert.deepEqual(selected.covered, []);
    assert.deepEqual(selected.unmatched, ["results"]);
    const read = await readOf(review, {
      source: "sections",
      sections: ["results"],
    });
    assert.equal(read!.text, "");
    assert.deepEqual(read!.unmatched, ["results"]);
  });

  it("keeps the abstract unmatched when the title section holds front-matter lines only", async function () {
    const short = [
      "# Cortical replays predict later sensory responses",
      "",
      "https://doi.org/10.1000/example.2024.0001",
      "",
      "Received: 10 October 2022",
      "",
      "Ana Author1, Ben Author2,3, Cy Author1 & Dee Author1",
      "",
      "# Replays spread across the visual cortex",
      "",
      INTRO_LONG,
      "",
      "# Discussion",
      "",
      DISCUSSION,
    ].join("\n");
    assert.equal(selectLeadAbstract(short), "");
    const read = await readOf(short, { source: "abstract" });
    assert.equal(read!.text, "");
    assert.deepEqual(read!.covered, []);
    assert.deepEqual(read!.unmatched, ["abstract"]);

    // A long block of affiliations is front matter, not prose.
    const affiliations = Array.from(
      { length: 12 },
      (_, index) =>
        `${index + 1}Department of Neurobiology, Example University, Boston, MA, USA`,
    ).join(". ");
    assert.isAtLeast(affiliations.length, 600);
    assert.equal(
      selectLeadAbstract(
        short.replace("Received", `${affiliations}\n\nReceived`),
      ),
      "",
    );
  });

  it("reads a Cell-style Summary heading at the start as the abstract, never a summary in the methods", async function () {
    const selected = selectMineruScopeSections(CELL_SHAPE_MD, ["abstract"]);
    assert.deepEqual(selected.covered, ["Abstract"]);
    assert.isFalse(selected.approximate);
    assert.include(selected.text, CELL_SUMMARY);
    assert.notInclude(selected.text, CELL_SUMMARY_STATISTICS);
    assert.notInclude(selected.text, INTRO_SHORT);
    const read = await readOf(CELL_SHAPE_MD, { source: "abstract" });
    assert.equal(read!.text, CELL_SUMMARY);
    assert.equal(read!.source, "PDF abstract");
    assert.equal(read!.bounds, "exact");

    // "Summary." with its punctuation, in any case, still counts.
    const upper = CELL_SHAPE_MD.replace("# Summary\n", "# SUMMARY.\n");
    assert.include(
      selectMineruScopeSections(upper, ["abstract"]).text,
      CELL_SUMMARY,
    );
    // A Summary heading after the Introduction is not the abstract.
    const late = CELL_SHAPE_MD.replace(
      `# Summary\n\n${CELL_SUMMARY}\n\n`,
      "",
    ).replace("# Discussion", `# Summary\n\n${CELL_SUMMARY}\n\n# Discussion`);
    assert.deepEqual(selectMineruScopeSections(late, ["abstract"]).unmatched, [
      "abstract",
    ]);
    // Only "Summary statistics" in the methods: no abstract.
    const methodsOnly = CELL_SHAPE_MD.replace(
      `# Summary\n\n${CELL_SUMMARY}\n\n`,
      "",
    );
    const none = selectMineruScopeSections(methodsOnly, ["abstract"]);
    assert.deepEqual(none.unmatched, ["abstract"]);
    assert.equal(none.text, "");
  });

  it("ends a Discussion read before Online content and the reference list it heads", function () {
    const selected = selectMineruScopeSections(NATURE_SHAPE_MD, ["discussion"]);
    assert.deepEqual(selected.covered, ["Discussion"]);
    assert.isFalse(selected.approximate);
    assert.include(selected.text, DISCUSSION);
    assert.notInclude(selected.text, ONLINE_CONTENT);
    assert.notInclude(selected.text, REFERENCE_SPILL);
    assert.notInclude(selected.text, METHODS_TEXT);
    // "Online content" is back matter: nothing after it inherits Discussion.
    const sections = buildSyntheticManifestSections(NATURE_SHAPE_MD);
    const enclosing = enclosingStandardSections(sections);
    const online = sections.findIndex(
      (section) => section.heading === "Online content",
    );
    assert.isAbove(online, 0);
    assert.isUndefined(enclosing[online]);
    assert.isUndefined(enclosing[online + 1]);
    // The plain PDF reader ends the Discussion there too.
    const chunks = buildChunkMetadata(
      [
        `Discussion\n${DISCUSSION}`,
        `Online content\n${ONLINE_CONTENT}.`,
        REFERENCE_SPILL,
      ],
      "zotero-worker",
    );
    assert.equal(chunks[0].chunkKind, "discussion");
    assert.equal(chunks[1].chunkKind, "body");
    assert.isUndefined(chunks[2].enclosingSection);
  });
});

describe("read scope: the unlabelled fallbacks stay inside their bounds", function () {
  /** Invented prose of about 700 characters, each paragraph its own words. */
  const prose = (word: string) =>
    Array.from(
      { length: 12 },
      (_, index) =>
        `The ${word} paragraph states point ${index + 1} in plain words here.`,
    ).join(" ");
  const md = (...blocks: string[]) => blocks.join("\n\n");
  /** The headings a results read returned, in order. */
  const resultsHeadings = (markdown: string) => {
    const selected = selectMineruScopeSections(markdown, ["results"]);
    return {
      selected,
      headings: (selected.text.match(/^#+ .*$/gm) || []).map((line) =>
        line.replace(/^#+ /, ""),
      ),
    };
  };

  it("starts the span after a Methods section that comes before the results", function () {
    const psychology = md(
      "# Choice under time pressure",
      "# Abstract",
      prose("abstract"),
      "# Introduction",
      prose("introduction"),
      "# Hypotheses",
      prose("hypotheses"),
      "# Method",
      prose("method"),
      "# Study outcomes",
      prose("outcomes"),
      "# Discussion",
      prose("discussion"),
    );
    const { selected, headings } = resultsHeadings(psychology);
    assert.deepEqual(headings, ["Study outcomes"]);
    assert.deepEqual(selected.covered, [RESULTS_SPAN_LABEL]);
    const arxiv = md(
      "# Fast sparse attention",
      "## Abstract",
      prose("abstract"),
      "## 1 Introduction",
      prose("introduction"),
      "## 2 Preliminaries",
      prose("preliminaries"),
      "## 3 Method",
      prose("method"),
      "### 3.1 Encoder",
      prose("encoder"),
      "## 4 Experiments",
      prose("experiments"),
      "### 4.1 Benchmarks",
      prose("benchmarks"),
      "## 5 Discussion",
      prose("discussion"),
    );
    assert.deepEqual(resultsHeadings(arxiv).headings, [
      "4 Experiments",
      "4.1 Benchmarks",
    ]);
  });

  it("finds the title block past a running Article heading or a title split over two headings", function () {
    const front = [
      "https://doi.org/10.1000/example.2024.0002",
      "Received: 1 January 2024",
      "Ana Author1 & Ben Author2",
      prose("lead"),
      prose("introduction"),
    ];
    const body = [
      "# Replays follow images",
      prose("results"),
      "# Discussion",
      prose("discussion"),
      "# Methods",
      prose("methods"),
    ];
    for (const [layout, opening] of [
      ["running Article heading", ["# Article", "# Replay shapes cortex"]],
      [
        "split title",
        ["# Replay in the visual cortex", "# shapes later responses"],
      ],
    ] as const) {
      const markdown = md(...opening, ...front, ...body);
      assert.equal(selectLeadAbstract(markdown), prose("lead"), layout);
      assert.deepEqual(
        resultsHeadings(markdown).headings,
        ["Replays follow images"],
        layout,
      );
      const text = resultsHeadings(markdown).selected.text;
      for (const other of [
        "doi.org",
        "Ana Author1",
        prose("lead"),
        prose("introduction"),
      ])
        assert.notInclude(text, other, layout);
    }
  });

  it("reads a top-level Background heading as the introduction, not as results", function () {
    const background = md(
      "# Replays shape later responses",
      "# Abstract",
      prose("abstract"),
      "# Background",
      prose("background"),
      "# Replays follow images",
      prose("results"),
      "# Discussion",
      prose("discussion"),
      "# Methods",
      prose("methods"),
    );
    assert.deepEqual(resultsHeadings(background).headings, [
      "Replays follow images",
    ]);
    // A Background subsection inside the results stays in the results.
    const nested = md(
      "# Replays shape later responses",
      "## Abstract",
      prose("abstract"),
      "## Introduction",
      prose("introduction"),
      "## Replays follow images",
      prose("results"),
      "### Background",
      prose("background"),
      "## Discussion",
      prose("discussion"),
      "## Methods",
      prose("methods"),
    );
    assert.deepEqual(resultsHeadings(nested).headings, [
      "Replays follow images",
      "Background",
    ]);
  });

  it("keeps the results unmatched in a review with a Discussion but no Methods heading", async function () {
    const review = md(
      "# A review of replay",
      "# Abstract",
      prose("abstract"),
      "# Introduction",
      prose("introduction"),
      "# Replay in the hippocampus",
      prose("hippocampus"),
      "# Replay in the cortex",
      prose("cortex"),
      "# Discussion",
      prose("discussion"),
      "# References",
      REFERENCE_SPILL,
    );
    const { selected } = resultsHeadings(review);
    assert.equal(selected.text, "");
    assert.deepEqual(selected.unmatched, ["results"]);
    // With a Methods heading anywhere, the same layout reads by position.
    const study = review.replace(
      "# References",
      `# Experimental procedures\n\n${prose("methods")}\n\n# References`,
    );
    assert.deepEqual(resultsHeadings(study).headings, [
      "Replay in the hippocampus",
      "Replay in the cortex",
    ]);
  });

  it("ends a section only at a whole Online content heading", function () {
    assert.isTrue(isBackMatterHeading("Online content"));
    assert.isTrue(isBackMatterHeading("Online content:"));
    assert.isFalse(isBackMatterHeading("Online content moderation at scale"));
    const platforms = md(
      "# Moderating platforms",
      "# Introduction",
      prose("introduction"),
      "# Online content moderation at scale",
      prose("moderation"),
      "# Platform responses",
      prose("platforms"),
      "# Discussion",
      prose("discussion"),
      "# Methods",
      prose("methods"),
    );
    assert.deepEqual(resultsHeadings(platforms).headings, [
      "Online content moderation at scale",
      "Platform responses",
    ]);
  });

  it("skips a licence, a publication history or an affiliation block before the lead", function () {
    const licence = `This article is licensed under a Creative Commons Attribution 4.0 International License. ${prose("licence")}`;
    const history = `Received 1 January 2024. Accepted 2 February 2024. ${prose("history")}`;
    const affiliations = Array.from(
      { length: 9 },
      (_, index) =>
        `${index + 1}Department of Neuroscience, University of Example, Boston, MA, Country.`,
    ).join(" ");
    for (const block of [licence, history, affiliations]) {
      assert.isAtLeast(block.length, 600);
      const markdown = md(
        "# Replays shape later responses",
        block,
        prose("lead"),
        "# Replays follow images",
        prose("results"),
      );
      assert.equal(
        selectLeadAbstract(markdown),
        prose("lead"),
        block.slice(0, 30),
      );
    }
  });

  it("keeps an abstract that says licensed, hospital or laboratory as the lead", function () {
    for (const opening of [
      "Two licensed vaccines were compared in a trial.",
      "We studied in-hospital mortality, hospital admission, hospital stay and discharge from hospital.",
      "Laboratory-confirmed infection and laboratory tests were counted in hospital and hospital wards.",
    ]) {
      const abstract = `${opening} ${prose("abstract")}`;
      const markdown = md(
        "# Vaccines and hospital stays",
        "Ana Author1 & Ben Author2",
        abstract,
        prose("introduction"),
        "# Admissions fell",
        prose("results"),
        "# Discussion",
        prose("discussion"),
        "# Methods",
        prose("methods"),
      );
      assert.equal(selectLeadAbstract(markdown), abstract, opening);
    }
  });

  it("skips the numbered subsections of a front section in flat MinerU text", function () {
    const methodsFirst = md(
      "# Choice under time pressure",
      "Ana Author",
      "# Abstract",
      prose("abstract"),
      "# 1 Introduction",
      prose("introduction"),
      "# 2 Method",
      prose("method"),
      "# 2.1 Participants",
      prose("participants"),
      "# 2.2 Procedure",
      prose("procedure"),
      "# 3 Study outcomes",
      prose("outcomes"),
      "# 3.1 Main effect",
      prose("effect"),
      "# 4 Discussion",
      prose("discussion"),
    );
    assert.deepEqual(resultsHeadings(methodsFirst).headings, [
      "3 Study outcomes",
      "3.1 Main effect",
    ]);
    const introductionLast = md(
      "# Replays shape later responses",
      "# Abstract",
      prose("abstract"),
      "# 1 Introduction",
      prose("introduction"),
      "# 1.1 Prior work",
      prose("prior"),
      "# 2 Replays follow images",
      prose("results"),
      "# 3 Discussion",
      prose("discussion"),
      "# 4 Methods",
      prose("methods"),
    );
    assert.deepEqual(resultsHeadings(introductionLast).headings, [
      "2 Replays follow images",
    ]);
  });

  it("ends the title block at a top-level Background or Main heading", function () {
    for (const heading of ["Background", "Main"]) {
      const markdown = md(
        "# Replays shape later responses",
        `# ${heading}`,
        prose("introduction"),
        "# Methods",
        prose("methods"),
        "# Replays follow images",
        prose("results"),
        "# Discussion",
        prose("discussion"),
      );
      assert.equal(selectLeadAbstract(markdown), "", heading);
      assert.deepEqual(
        resultsHeadings(markdown).headings,
        ["Replays follow images"],
        heading,
      );
    }
  });

  it("counts a STAR Methods heading as a Methods heading", function () {
    const cell = (methods: string[]) =>
      md(
        "# Replays shape later responses",
        "# Summary",
        prose("summary"),
        "# Introduction",
        prose("introduction"),
        "# Replays follow images",
        prose("results"),
        "# Discussion",
        prose("discussion"),
        ...methods,
      );
    for (const heading of ["# STAR Methods", "# STAR METHODS"])
      assert.deepEqual(
        resultsHeadings(cell([heading, prose("methods")])).headings,
        ["Replays follow images"],
        heading,
      );
    assert.deepEqual(resultsHeadings(cell([])).selected.unmatched, ["results"]);
  });
});

describe("the part names a user reads", function () {
  it("upper-cases a Latin first letter, writes the abstract as Abstract, and keeps each name once", function () {
    assert.deepEqual(
      userPartNames(["results", "Results", "abstract", "结果", "éléments"]),
      ["Results", "Abstract", "结果", "Éléments"],
    );
  });

  it("keeps a name that contains a comma as one name", function () {
    assert.deepEqual(userPartNames(["methods, results", "discussion"]), [
      "Methods, results",
      "Discussion",
    ]);
  });

  it("shows the two parts found by place as Abstract and Results", function () {
    assert.equal(shownPartName(LEAD_ABSTRACT_LABEL), "Abstract");
    assert.equal(shownPartName(RESULTS_SPAN_LABEL), "Results");
    assert.equal(shownPartName("2 Methods"), "2 Methods");
    assert.deepEqual(
      requestedPartNames([LEAD_ABSTRACT_LABEL, RESULTS_SPAN_LABEL, "Abstract"]),
      ["Abstract", "Results"],
    );
  });
});

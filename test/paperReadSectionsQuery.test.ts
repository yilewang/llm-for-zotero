import { assert } from "chai";
import {
  mockPdfAttachment,
  restoreTestGlobals,
  setupMemoryIO,
  setupZoteroGlobals,
  snapshotTestGlobals,
} from "./helpers/retrievalCorpus";
import {
  getMineruItemDir,
  writeMineruCacheFiles,
} from "../src/services/mineru/mineruCache";
import { ensurePDFTextCached } from "../src/services/paperContent/pdfContext";
import { pdfTextCache } from "../src/services/paperContent/contextCache";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import { RetrievalService } from "../src/agent/services/retrievalService";
import { SECTIONS_NOT_FOUND_RULE } from "../src/agent/digests/readScope";
import {
  CELL_SHAPE_MD,
  NATURE_SHAPE_MD,
} from "./helpers/unlabelledSectionsMarkdown";

/**
 * paper_read with `sections` and a query searches the sections a
 * whole-sections read of the same names reads, found by the same rules:
 * a results span by its place, an unheaded lead abstract, Cell's Summary.
 * A name the paper's text lacks is reported, except an abstract that only
 * the Zotero record holds, which the whole-sections read returns.
 */

/** Nested "Abstract representations" under Methods; no abstract anywhere. */
const NESTED_ABSTRACT_WORDS_MD = [
  "# Grid maps in cortex",
  "",
  "## Introduction",
  "",
  "Grid cells tile space in the entorhinal cortex of rodents.",
  "",
  "## Methods",
  "",
  "### Abstract representations of space",
  "",
  "Grid cells form abstract maps of novelty and drift in the cortex.",
  "",
  "## Results",
  "",
  "Drift of grid maps was slow across days.",
].join("\n");

const filler = (text: string) => `${text} `.repeat(3).trim();

/** Two experiments under the same subsection headings. */
const REPEATED_HEADINGS_MD = [
  "# Two experiments on drift",
  "",
  "## Introduction",
  "",
  filler("Intro about drift in place cells."),
  "",
  "## Experiment 1",
  "",
  "### Participants",
  "",
  "### Procedure",
  "",
  filler("Exp1 procedure used virtual reality corridors."),
  "",
  "### Results",
  "",
  filler("Exp1 results: drift rate was 5 percent per day in corridors."),
  "",
  "## Experiment 2",
  "",
  "### Participants",
  "",
  filler("Exp2 participants were 20 aged mice."),
  "",
  "### Procedure",
  "",
  filler("Exp2 procedure used open arenas."),
  "",
  "### Results",
  "",
  filler("Exp2 results: drift rate was 15 percent per day in arenas."),
  "",
  "## General Discussion",
  "",
  filler("Discussion of both experiments."),
].join("\n");

/**
 * One heading after the title: the plugin chunks it flat, so no chunk
 * names a section.
 */
const ONE_HEADING_MD = [
  "# Short letter on drift",
  "",
  "Lead text of the letter that describes things.",
  "",
  "## Methods",
  "",
  filler("Mice were imaged with two-photon microscopy daily for weeks."),
].join("\n");

// A long flat paper whose one-sentence Methods repeats a sentence of its
// introduction.
const SHORT_REPEAT_MD = [
  "# A long letter on drift",
  "",
  ...Array.from(
    { length: 30 },
    (_, index) =>
      `Paragraph ${index} of the introduction explains why hippocampal place cells drift over days and what that means for memory stability in rodents and primates alike, with references to many prior studies of remapping.${index === 5 ? " Mice were imaged daily." : ""}\n`,
  ),
  "## Methods",
  "",
  "Mice were imaged daily.",
].join("\n");

type Output = {
  read?: string;
  warnings?: string[];
  note?: string;
  papers: Array<{
    status: string;
    covered?: string[];
    passages: Array<{ text: string; sectionLabel?: string }>;
  }>;
};

describe("paper_read sections with a query", function () {
  let previous: ReturnType<typeof snapshotTestGlobals>;
  const papers = [
    { libraryID: 1, itemId: 500, contextItemId: 501, title: "Nature" },
    { libraryID: 1, itemId: 600, contextItemId: 601, title: "Cell" },
    { libraryID: 1, itemId: 700, contextItemId: 701, title: "Nested" },
    { libraryID: 1, itemId: 800, contextItemId: 801, title: "Repeated" },
    { libraryID: 1, itemId: 900, contextItemId: 901, title: "Few" },
    { libraryID: 1, itemId: 1000, contextItemId: 1001, title: "ShortRepeat" },
  ].map((paper) => ({
    ...paper,
    mineruCacheDir: "",
  }));
  const abstractNotes = new Map<number, string>();
  /** Papers whose chunk text the PDF service does not return. */
  const noContext = new Set<number>();

  beforeEach(async function () {
    previous = snapshotTestGlobals();
    setupMemoryIO();
    setupZoteroGlobals();
    pdfTextCache.clear();
    abstractNotes.clear();
    noContext.clear();
    const texts = [
      NATURE_SHAPE_MD,
      CELL_SHAPE_MD,
      NESTED_ABSTRACT_WORDS_MD,
      REPEATED_HEADINGS_MD,
      ONE_HEADING_MD,
      SHORT_REPEAT_MD,
    ];
    for (const [index, paper] of papers.entries()) {
      await writeMineruCacheFiles(paper.contextItemId, texts[index], [
        {
          relativePath: "full.md",
          data: new TextEncoder().encode(texts[index]),
        },
      ]);
      await ensurePDFTextCached(mockPdfAttachment(paper.contextItemId));
      paper.mineruCacheDir = getMineruItemDir(paper.contextItemId);
    }
  });
  afterEach(function () {
    pdfTextCache.clear();
    restoreTestGlobals(previous);
  });

  async function read(
    args: Record<string, unknown>,
    paper: (typeof papers)[number] | Array<(typeof papers)[number]>,
  ): Promise<Output> {
    const targets = Array.isArray(paper) ? paper : [paper];
    const service = {
      ensurePaperContext: async (p: { contextItemId: number }) =>
        noContext.has(p.contextItemId)
          ? undefined
          : pdfTextCache.get(p.contextItemId),
    } as never;
    const tool = createPaperReadTool(
      service,
      new RetrievalService(service),
      {} as never,
      {
        getItem: (itemId: number) => ({
          getField: (field: string) =>
            field === "abstractNote" ? abstractNotes.get(itemId) || "" : "",
        }),
        listPaperContexts: () => papers,
        resolvePaperContextTarget: (target: { itemId?: number }) =>
          papers.find((entry) => entry.itemId === target.itemId),
      } as never,
    );
    const input = tool.validate({
      mode: "targeted",
      targets: targets.map((entry) => ({
        itemId: entry.itemId,
        contextItemId: entry.contextItemId,
      })),
      ...args,
    });
    if (!input.ok) throw new Error(input.error);
    return (await tool.execute(input.value, {
      request: {
        conversationKey: 1,
        mode: "agent",
        conversationKind: "paper",
        userText: "Read the named sections",
        libraryID: 1,
        activeItemId: targets[0].itemId,
      },
      item: null,
      currentAnswerText: "",
      modelName: "test",
    } as never)) as Output;
  }

  const noRule = (output: Output) =>
    assert.notInclude(output.warnings || [], SECTIONS_NOT_FOUND_RULE);

  it("searches the results a Nature-shape paper has under topic headings", async function () {
    const whole = await read({ sections: ["results"] }, papers[0]);
    assert.deepEqual(whole.papers[0].covered, [
      "Results (unlabelled sections)",
    ]);
    const output = await read(
      { sections: ["results"], query: "silencing removed replays" },
      papers[0],
    );
    noRule(output);
    assert.isNotEmpty(output.papers[0].passages);
    for (const passage of output.papers[0].passages)
      assert.match(
        passage.sectionLabel || "",
        /Replays spread across the visual cortex|Local silencing removes replays/,
      );
  });

  it("searches a Nature-shape paper's unheaded lead abstract", async function () {
    const output = await read(
      { sections: ["abstract"], query: "replays during quiet rest" },
      papers[0],
    );
    noRule(output);
    assert.isNotEmpty(output.papers[0].passages);
    assert.include(
      output.papers[0].passages.map((passage) => passage.text).join("\n"),
      "Theories of offline learning",
    );
  });

  it("searches a Cell-shape paper's Summary as its abstract", async function () {
    const output = await read(
      { sections: ["abstract"], query: "replay moves a response" },
      papers[1],
    );
    noRule(output);
    assert.isNotEmpty(output.papers[0].passages);
    for (const passage of output.papers[0].passages)
      assert.match(passage.sectionLabel || "", /^Summary$/);
  });

  it("never takes a nested heading's words for the abstract", async function () {
    const output = await read(
      { sections: ["abstract"], query: "abstract maps of novelty" },
      papers[2],
    );
    assert.isEmpty(output.papers[0].passages);
    assert.include(output.warnings || [], SECTIONS_NOT_FOUND_RULE);
    // The whole-sections read follows the same rule.
    const whole = await read({ sections: ["abstract"] }, papers[2]);
    assert.equal(whole.papers[0].status, "no_matching_sections");
  });

  it("points to the Zotero record when only the record holds the abstract", async function () {
    abstractNotes.set(papers[2].itemId, "An abstract kept in the record.");
    const output = await read(
      { sections: ["abstract"], query: "abstract maps of novelty" },
      papers[2],
    );
    noRule(output);
    assert.isEmpty(output.papers[0].passages);
    assert.notEqual(output.papers[0].status, "no_matching_sections");
    assert.isTrue(
      (output.warnings || []).some((warning) =>
        warning.includes("only in the Zotero record"),
      ),
      JSON.stringify(output.warnings),
    );
  });
  it("searches a section of a MinerU paper whose chunks name no section", async function () {
    const output = await read(
      { sections: ["methods"], query: "two-photon" },
      papers[4],
    );
    noRule(output);
    assert.notEqual(output.papers[0].status, "no_matching_sections");
    assert.include(
      output.papers[0].passages.map((passage) => passage.text).join("\n"),
      "two-photon microscopy",
    );
  });

  it("binds a one-sentence section only to its own chunk, not to a repeat of it", async function () {
    const output = await read(
      { sections: ["methods"], query: "mice imaged daily" },
      papers[5],
    );
    const texts = output.papers[0].passages.map((passage) => passage.text);
    assert.isNotEmpty(texts);
    for (const text of texts) assert.notInclude(text, "Paragraph");
  });

  it("points to the read without a query when no chunk holds a found section", async function () {
    noContext.add(papers[4].contextItemId);
    const output = await read(
      { sections: ["methods"], query: "two-photon" },
      papers[4],
    );
    noRule(output);
    assert.notEqual(output.papers[0].status, "no_matching_sections");
    assert.isTrue(
      (output.warnings || []).some(
        (warning) =>
          warning.includes("methods") && warning.includes("no query"),
      ),
      JSON.stringify(output.warnings),
    );
  });

  it("names nothing read when another name is missing beside a record-only abstract", async function () {
    abstractNotes.set(papers[2].itemId, "An abstract kept in the record.");
    const output = await read(
      { sections: ["abstract", "telescope calibration"], query: "maps" },
      papers[2],
    );
    assert.include(output.warnings || [], SECTIONS_NOT_FOUND_RULE);
    assert.isTrue(
      (output.warnings || []).some((warning) =>
        warning.includes("only in the Zotero record"),
      ),
    );
    assert.equal(output.papers[0].status, "no_matching_sections");
    assert.include(output.note || "", "Nothing read for");
  });

  it("searches the paper that has the section and names the one that does not", async function () {
    const output = await read(
      { sections: ["discussion"], query: "replays adjust responses" },
      [papers[2], papers[1]],
    );
    const [nested, cell] = output.papers;
    assert.equal(nested.status, "no_matching_sections");
    assert.isEmpty(nested.passages);
    assert.isNotEmpty(cell.passages);
    for (const passage of cell.passages)
      assert.match(passage.sectionLabel || "", /Discussion/);
    const notFound = (output.warnings || []).filter((warning) =>
      warning.startsWith("Not found in"),
    );
    assert.lengthOf(notFound, 1);
    assert.include(notFound[0], "Nested");
    assert.equal(
      (output.warnings || []).filter(
        (warning) => warning === SECTIONS_NOT_FOUND_RULE,
      ).length,
      1,
    );
  });

  it("searches every section under a repeated heading", async function () {
    const participants = await read(
      { sections: ["participants"], query: "aged mice" },
      papers[3],
    );
    noRule(participants);
    assert.include(
      participants.papers[0].passages.map((passage) => passage.text).join("\n"),
      "Exp2 participants were 20 aged mice",
    );
    const procedure = await read(
      { sections: ["procedure"], query: "arenas corridors", topK: 8 },
      papers[3],
    );
    noRule(procedure);
    const text = procedure.papers[0].passages
      .map((passage) => passage.text)
      .join("\n");
    assert.include(text, "Exp1 procedure");
    assert.include(text, "Exp2 procedure");
    assert.notInclude(text, "drift rate was");
  });
});

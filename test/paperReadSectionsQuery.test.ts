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
import {
  LEAD_ABSTRACT_LABEL,
  SECTIONS_NOT_FOUND_RULE,
} from "../src/agent/digests/readScope";
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
 * A call that names only the abstract reads it whole, query or not.
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

/** A paper whose abstract stands under its own Abstract heading. */
const HEADED_ABSTRACT_MD = [
  "# Place maps under a heading",
  "",
  "## Abstract",
  "",
  "Headed abstract text: place maps drift slowly across weeks in mice.",
  "",
  "## Introduction",
  "",
  filler("Introduction text about place maps and their drift."),
  "",
  "## Results",
  "",
  filler("Results text: drift was slow across weeks."),
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
  results?: unknown;
  papers: Array<{
    status: string;
    citationLabel?: string;
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
    { libraryID: 1, itemId: 1100, contextItemId: 1101, title: "Headed" },
    { libraryID: 1, itemId: 1200, contextItemId: 1201, title: "Twin" },
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
      HEADED_ABSTRACT_MD,
      NATURE_SHAPE_MD,
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

  const QUERY_IGNORED = "Read the abstract whole; a query does not search it.";
  const leadWarnings = (output: Output) =>
    (output.warnings || []).filter((warning) =>
      warning.includes("no abstract section or Zotero abstract"),
    );
  const passageText = (output: Output, index = 0) =>
    output.papers[index].passages.map((passage) => passage.text).join("\n");

  it("reads a Nature-shape paper's unheaded lead abstract whole and says it was found by position", async function () {
    const output = await read(
      { sections: ["abstract"], query: "replays during quiet rest", topK: 1 },
      papers[0],
    );
    noRule(output);
    assert.equal(output.read, "whole_sections");
    assert.notProperty(output, "results", "no search ran");
    assert.deepEqual(output.papers[0].covered, [LEAD_ABSTRACT_LABEL]);
    assert.include(passageText(output), "Theories of offline learning");
    assert.include(output.warnings || [], QUERY_IGNORED);
    assert.deepEqual(leadWarnings(output), [
      `${output.papers[0].citationLabel}: no abstract section or Zotero abstract; this ${LEAD_ABSTRACT_LABEL} was found by position and may be the introduction.`,
    ]);
  });

  it("reads a Cell-shape paper's Summary whole as its abstract", async function () {
    const output = await read(
      { sections: ["abstract"], query: "replay moves a response" },
      papers[1],
    );
    noRule(output);
    assert.equal(output.read, "whole_sections");
    assert.isNotEmpty(output.papers[0].passages);
    assert.notInclude(output.papers[0].covered || [], LEAD_ABSTRACT_LABEL);
    assert.isEmpty(leadWarnings(output));
    // The whole read of the same name reads the same Summary.
    const whole = await read({ sections: ["abstract"] }, papers[1]);
    assert.equal(passageText(output), passageText(whole));
  });

  it("never takes a nested heading's words for the abstract", async function () {
    const output = await read(
      { sections: ["abstract"], query: "abstract maps of novelty" },
      papers[2],
    );
    assert.equal(output.read, "whole_sections");
    assert.isEmpty(output.papers[0].passages);
    assert.equal(output.papers[0].status, "no_matching_sections");
    assert.include(output.warnings || [], SECTIONS_NOT_FOUND_RULE);
    assert.include(output.note || "", "none of the named sections were found");
    assert.isEmpty(leadWarnings(output));
  });

  it("returns the Zotero record's abstract when only the record holds it", async function () {
    abstractNotes.set(papers[2].itemId, "An abstract kept in the record.");
    const output = await read(
      { sections: ["abstract"], query: "abstract maps of novelty" },
      papers[2],
    );
    noRule(output);
    assert.equal(output.read, "whole_sections");
    assert.equal(output.papers[0].status, "complete");
    assert.include(passageText(output), "An abstract kept in the record.");
    assert.isFalse(
      (output.warnings || []).some((warning) =>
        warning.includes("only in the Zotero record"),
      ),
      JSON.stringify(output.warnings),
    );
    assert.isEmpty(leadWarnings(output));
  });

  it("takes the Zotero abstract over a paper's unheaded lead", async function () {
    abstractNotes.set(papers[0].itemId, "Record abstract of the Nature paper.");
    const output = await read(
      { sections: ["abstract"], query: "replays during quiet rest" },
      papers[0],
    );
    assert.equal(output.read, "whole_sections");
    assert.include(passageText(output), "Record abstract of the Nature paper.");
    assert.notInclude(passageText(output), "Theories of offline learning");
    assert.isEmpty(leadWarnings(output));
  });

  it("reads a MinerU Abstract section whole with no position warning", async function () {
    const output = await read(
      { sections: ["abstract"], query: "drift" },
      papers[6],
    );
    noRule(output);
    assert.equal(output.read, "whole_sections");
    assert.deepEqual(output.papers[0].covered, ["Abstract"]);
    assert.include(passageText(output), "Headed abstract text");
    assert.notInclude(passageText(output), "Introduction text");
    assert.isEmpty(leadWarnings(output));
  });

  it("names each lead-only paper once among several targets", async function () {
    abstractNotes.set(papers[2].itemId, "An abstract kept in the record.");
    const output = await read({ sections: ["abstract"], query: "replays" }, [
      papers[0],
      papers[2],
      papers[7],
      papers[6],
    ]);
    assert.equal(output.read, "whole_sections");
    const labels = output.papers.map((paper) => paper.citationLabel || "");
    const warnings = leadWarnings(output);
    assert.lengthOf(warnings, 2, JSON.stringify(output.warnings));
    assert.isTrue(warnings[0].startsWith(`${labels[0]}:`));
    assert.isTrue(warnings[1].startsWith(`${labels[2]}:`));
    for (const warning of warnings) {
      assert.isFalse(warning.startsWith(`${labels[1]}:`));
      assert.isFalse(warning.startsWith(`${labels[3]}:`));
    }
    assert.include(passageText(output, 1), "An abstract kept in the record.");
    assert.lengthOf(
      (output.warnings || []).filter((warning) => warning === QUERY_IGNORED),
      1,
    );
  });

  it("says a query was ignored only when one was given", async function () {
    const withQuery = await read(
      { sections: ["abstract"], query: "drift" },
      papers[6],
    );
    assert.include(withQuery.warnings || [], QUERY_IGNORED);
    const withoutQuery = await read({ sections: ["abstract"] }, papers[6]);
    assert.equal(withoutQuery.read, "whole_sections");
    assert.notInclude(withoutQuery.warnings || [], QUERY_IGNORED);
    // The lead warning is honest with or without a query.
    const lead = await read({ sections: ["abstract"] }, papers[0]);
    assert.notInclude(lead.warnings || [], QUERY_IGNORED);
    assert.lengthOf(leadWarnings(lead), 1);
  });

  it("still searches a mixed abstract and results call with a query", async function () {
    const output = await read(
      { sections: ["abstract", "results"], query: "silencing removed replays" },
      papers[0],
    );
    assert.notEqual(output.read, "whole_sections");
    assert.notInclude(output.warnings || [], QUERY_IGNORED);
    assert.isEmpty(leadWarnings(output));
    assert.isNotEmpty(output.papers[0].passages);
  });

  it("still searches a Nature-shape unlabelled lead abstract in a mixed call", async function () {
    const output = await read(
      {
        sections: ["abstract", "results"],
        query: "replays during quiet rest",
        topK: 8,
      },
      papers[0],
    );
    noRule(output);
    assert.notEqual(output.read, "whole_sections");
    assert.isNotEmpty(output.papers[0].passages);
    assert.include(passageText(output), "Theories of offline learning");
  });

  it("still searches a Cell-shape Summary in a mixed call", async function () {
    const output = await read(
      {
        sections: ["abstract", "results"],
        query: "replay moves a response",
        topK: 8,
      },
      papers[1],
    );
    noRule(output);
    assert.notEqual(output.read, "whole_sections");
    assert.isNotEmpty(output.papers[0].passages);
    assert.isTrue(
      output.papers[0].passages.some((passage) =>
        /^Summary$/.test(passage.sectionLabel || ""),
      ),
      JSON.stringify(
        output.papers[0].passages.map((passage) => passage.sectionLabel),
      ),
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

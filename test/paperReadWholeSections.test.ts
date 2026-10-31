import { assert } from "chai";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import { buildAgentCoverageEntriesForActivity } from "../src/agent/context/coverageLedger";
import { deriveTaskPaperLedgerDelta } from "../src/agent/context/taskPaperLedger";
import { createTrustedReadObservations } from "../src/agent/context/readObservation";
import { isInDepthRead } from "../src/modules/contextPanel/taskProgress/store";
import { buildChunkMetadata } from "../src/services/paperContent/pdfContext";
import type { PdfContext } from "../src/services/paperContent/types";
import type { QuoteCitation } from "../src/shared/types";
import type { AgentToolContext, AgentToolDefinition } from "../src/agent/types";
import { SECTIONS_NOT_FOUND_RULE } from "../src/agent/digests/readScope";
import {
  DISCUSSION,
  LEAD_ABSTRACT,
  NATURE_SHAPE_MD,
  RESULTS_A,
  RESULTS_B,
} from "./helpers/unlabelledSectionsMarkdown";

/**
 * paper_read with `sections` and no query reads the whole named sections
 * through the one scope extractor (`readPaperScopeText`), not the top-K
 * passages of a ranked search, and gives each passage a citation id.
 */

const MD = [
  "# Drift in place cells",
  "",
  "## Abstract",
  "",
  "We ask whether representational drift impairs decoding of position.",
  "",
  "## 1 Introduction",
  "",
  "Place cells drift slowly across days in every animal we recorded.",
  "",
  "## 2 Results",
  "",
  "Decoding of position stayed above chance on every day we recorded in the study.",
  "",
  "### 2.1 Model fit",
  "",
  "The drift model fit the population vectors well across all ten sessions.",
  "",
  "## 3 Discussion",
  "",
  "Drift and stable decoding can coexist in one hippocampal network.",
].join("\n");

const HEADED_CHUNKS = [
  "Abstract\nWe ask whether representational drift impairs decoding of position in hippocampus.",
  "1. Introduction\nPlace cells drift slowly across days in many recordings of mice.",
  "3. Results\nDecoding stayed above chance on every recorded day of the study in all mice.",
  "Discussion\nDrift and stable decoding can coexist in one network of place cells.",
];

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

const mineruPaper = {
  libraryID: 1,
  itemId: 10,
  contextItemId: 110,
  title: "Drift in place cells",
  firstCreator: "Lee",
  year: "2025",
  mineruCacheDir: "/tmp/mineru/110",
};
const pdfPaper = {
  libraryID: 1,
  itemId: 20,
  contextItemId: 120,
  title: "Drift in plain PDF text",
  firstCreator: "Kim",
  year: "2024",
};
const unheadedPaper = {
  libraryID: 1,
  itemId: 30,
  contextItemId: 130,
  title: "Drift with no headings",
  firstCreator: "Park",
  year: "2023",
};
// A scanned PDF: no MinerU file and no extracted chunks.
const scannedPaper = {
  libraryID: 1,
  itemId: 40,
  contextItemId: 140,
  title: "Drift in a scanned PDF",
  firstCreator: "Ito",
  year: "2022",
};
// A Nature-shape MinerU file: no Abstract or Results heading.
const unlabelledPaper = {
  libraryID: 1,
  itemId: 50,
  contextItemId: 150,
  title: "Cortical replays predict later sensory responses",
  firstCreator: "Nguyen",
  year: "2023",
  mineruCacheDir: "/tmp/mineru/150",
};
const papers = [
  mineruPaper,
  pdfPaper,
  unheadedPaper,
  scannedPaper,
  unlabelledPaper,
];

type Passage = {
  text: string;
  sectionLabel?: string;
  chunkIndex?: number;
  chunkKind?: string;
  quoteCitationId?: string;
};
type SectionRow = {
  section: string;
  complete: boolean;
  characters: number;
  totalCharacters: number;
};
type PaperRow = {
  paperContext: { itemId: number };
  status: string;
  citationLabel: string;
  covered: string[];
  unmatched: string[];
  bounds?: string;
  sections: SectionRow[];
  passages: Passage[];
};
type Output = {
  mode: string;
  read?: string;
  papers: PaperRow[];
  quoteCitations: QuoteCitation[];
  warnings?: string[];
  note?: string;
};

const globalScope = globalThis as unknown as Record<string, unknown>;

function toolContext(
  requestExtra: Record<string, unknown> = {},
): AgentToolContext {
  return {
    request: {
      ...requestExtra,
      conversationKey: 91,
      mode: "agent",
      conversationKind: "paper",
      userText: "Read the abstract and results of these papers",
      libraryID: 1,
    } as never,
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  };
}

function makeTool(options: {
  abstractNotes?: Record<number, string>;
  retrieveCalls?: unknown[];
}) {
  const chunksByContext: Record<number, string[]> = {
    120: HEADED_CHUNKS,
    130: UNHEADED_CHUNKS,
  };
  const byId = new Map(papers.map((paper) => [paper.itemId, paper]));
  const gateway = {
    listPaperContexts: () => papers,
    resolvePaperContextTarget: (target: { itemId?: number }) =>
      byId.get(Number(target.itemId)) || null,
    getItem: (itemId: number) => ({
      libraryID: 1,
      key: `KEY${itemId}`,
      getField: (field: string) =>
        field === "abstractNote" ? options.abstractNotes?.[itemId] || "" : "",
    }),
  } as never;
  return createPaperReadTool(
    {
      ensurePaperContext: async (paper: { contextItemId: number }) =>
        chunksByContext[paper.contextItemId]
          ? pdfContext(chunksByContext[paper.contextItemId])
          : undefined,
      getOverviewExcerpt: async () => {
        throw new Error("a whole-section read never reads the overview");
      },
    } as never,
    {
      retrieveEvidence: async (params: unknown) => {
        options.retrieveCalls?.push(params);
        return [];
      },
    } as never,
    {} as never,
    gateway,
  ) as unknown as AgentToolDefinition<never, unknown>;
}

async function read(
  tool: AgentToolDefinition<never, unknown>,
  args: Record<string, unknown>,
  requestExtra: Record<string, unknown> = {},
): Promise<{ output: Output; input: unknown }> {
  const validated = tool.validate(args);
  if (!validated.ok) throw new Error(validated.error);
  const output = (await tool.execute(
    validated.value,
    toolContext(requestExtra),
  )) as Output;
  return { output, input: validated.value };
}

const rowOf = (output: Output, itemId: number) =>
  output.papers.find((row) => row.paperContext.itemId === itemId)!;

function assertIdsRegistered(output: Output): void {
  const registered = new Set(output.quoteCitations.map((entry) => entry.id));
  for (const row of output.papers)
    for (const passage of row.passages)
      if (passage.quoteCitationId)
        assert.isTrue(
          registered.has(passage.quoteCitationId),
          `shown id ${passage.quoteCitationId} is not registered`,
        );
}

describe("paper_read whole sections", function () {
  let hadIOUtils = false;
  let previousIOUtils: unknown;
  let previousZotero: unknown;
  beforeEach(function () {
    hadIOUtils = "IOUtils" in globalScope;
    previousIOUtils = globalScope.IOUtils;
    previousZotero = globalScope.Zotero;
    // Read observations name a paper by its native Zotero item.
    globalScope.Zotero = {
      Items: {
        get: (id: number) => ({ id, key: `KEY${id}`, libraryID: 1 }),
      },
    };
    globalScope.IOUtils = {
      read: async (filePath: string) => {
        if (filePath.includes("/tmp/mineru/150"))
          return new TextEncoder().encode(NATURE_SHAPE_MD);
        if (!filePath.includes("/tmp/mineru/110"))
          throw new Error(`no file ${filePath}`);
        return new TextEncoder().encode(MD);
      },
    };
  });
  afterEach(function () {
    if (hadIOUtils) globalScope.IOUtils = previousIOUtils;
    else delete globalScope.IOUtils;
    if (previousZotero === undefined) delete globalScope.Zotero;
    else globalScope.Zotero = previousZotero;
  });

  it("returns the whole named MinerU sections by exact bounds, with an id per passage and no ranked search", async function () {
    const retrieveCalls: unknown[] = [];
    const tool = makeTool({
      retrieveCalls,
      abstractNotes: {
        10: "The Zotero record's own abstract says that drift leaves decoding intact.",
      },
    });
    const { output } = await read(tool, {
      mode: "targeted",
      sections: ["abstract", "results"],
      targets: [{ itemId: 10 }],
    });
    assert.lengthOf(retrieveCalls, 0, "no top-K search");
    assert.equal(output.read, "whole_sections");
    const row = rowOf(output, 10);
    assert.equal(row.status, "complete");
    assert.equal(row.bounds, "exact");
    assert.deepEqual(row.covered, ["Abstract", "Results"]);
    assert.deepEqual(
      row.sections.map((section) => [section.section, section.complete]),
      [
        ["Abstract", true],
        ["Results", true],
      ],
    );
    const text = row.passages.map((passage) => passage.text).join("\n");
    assert.include(text, "The Zotero record's own abstract says");
    assert.include(text, "Decoding of position stayed above chance");
    assert.include(text, "The drift model fit the population vectors");
    assert.notInclude(text, "Place cells drift slowly");
    assert.notInclude(text, "Drift and stable decoding");
    for (const passage of row.passages)
      assert.match(passage.quoteCitationId || "", /^Q_/, passage.text);
    assertIdsRegistered(output);
    const abstractCitation = output.quoteCitations.find(
      (entry) => entry.id === row.passages[0].quoteCitationId,
    );
    assert.equal(abstractCitation?.sourceChunkKind, "abstract");
    // Every named section was found: no not-found sentence.
    assert.notInclude(JSON.stringify(output), SECTIONS_NOT_FOUND_RULE);
  });

  it("reads an unlabelled lead abstract and results span, flagged approximate, under their own labels", async function () {
    const tool = makeTool({});
    const { output, input } = await read(tool, {
      mode: "targeted",
      sections: ["abstract", "results"],
      targets: [{ itemId: 50 }],
    });
    const row = rowOf(output, 50) as PaperRow & { textSource?: string };
    assert.equal(row.status, "complete");
    assert.equal(row.bounds, "approximate");
    assert.equal(
      row.textSource,
      "PDF lead paragraph; MinerU sections by position",
    );
    assert.deepEqual(row.covered, [
      "Abstract (unlabelled lead)",
      "Results (unlabelled sections)",
    ]);
    assert.deepEqual(row.unmatched, []);
    const text = row.passages.map((passage) => passage.text).join("\n");
    assert.include(text, LEAD_ABSTRACT.slice(0, 80));
    assert.include(text, RESULTS_A);
    assert.include(text, RESULTS_B);
    assert.notInclude(text, DISCUSSION);
    assert.deepEqual(
      [...new Set(row.passages.map((passage) => passage.chunkKind))],
      ["abstract", "results"],
    );
    assertIdsRegistered(output);
    assert.notInclude(JSON.stringify(output), SECTIONS_NOT_FOUND_RULE);
    // The lead is recorded as the abstract, the span as a section.
    const delta = deriveTaskPaperLedgerDelta({
      toolName: "paper_read",
      callId: "call-unlabelled",
      input,
      content: output,
      libraryID: 1,
    });
    assert.deepEqual(
      (delta?.reads || []).map((entry) => [entry.label, entry.granularity]),
      [
        ["Abstract (unlabelled lead)", "abstract"],
        ["Results (unlabelled sections)", "section"],
      ],
    );
    // A read of the lead alone attests the abstract, not body text.
    const alone = await read(tool, {
      mode: "targeted",
      sections: ["abstract"],
      targets: [{ itemId: 50 }],
    });
    const observations = await createTrustedReadObservations({
      toolName: "paper_read",
      callId: "call-lead",
      input: alone.input,
      result: alone.output,
    });
    assert.deepEqual(observations[0]?.capabilities, ["abstract"]);
  });

  it("reads plain PDF sections by chunk kind, flagged approximate, and reports a name it cannot find", async function () {
    const tool = makeTool({});
    const { output } = await read(tool, {
      mode: "targeted",
      sections: ["results", "acknowledgements"],
      targets: [{ itemId: 20 }],
    });
    const row = rowOf(output, 20);
    assert.equal(row.bounds, "approximate");
    assert.deepEqual(row.covered, ["Results"]);
    assert.deepEqual(row.unmatched, ["acknowledgements"]);
    assert.lengthOf(row.passages, 1);
    assert.equal(row.passages[0].chunkIndex, 2);
    assert.include(row.passages[0].text, "Decoding stayed above chance");
    assert.notInclude(row.passages[0].text, "[chunk");
    assertIdsRegistered(output);
    assert.include(
      (output.warnings || []).join("\n"),
      "acknowledgements",
      "the unmatched name is reported",
    );
    // A partial match names only the missing section, and limits the read.
    assert.include(
      output.warnings || [],
      `Not found in ${row.citationLabel}: acknowledgements.`,
    );
    assert.equal(
      (output.warnings || []).filter((w) => w === SECTIONS_NOT_FOUND_RULE)
        .length,
      1,
    );
  });

  it("names a requested section that has no readable text and does not call the paper complete", async function () {
    const tool = makeTool({
      abstractNotes: { 40: "The record's own abstract of a scanned paper." },
    });
    const { output } = await read(tool, {
      mode: "targeted",
      sections: ["abstract", "results"],
      targets: [{ itemId: 40 }],
    });
    const row = rowOf(output, 40);
    assert.deepEqual(row.covered, ["Abstract"]);
    assert.deepEqual(row.unmatched, ["results"]);
    assert.notEqual(row.status, "complete");
    assert.include((output.warnings || []).join("\n"), "results");
  });

  it("does not call a section without readable text not found", async function () {
    const tool = makeTool({
      abstractNotes: { 40: "The record's own abstract of a scanned paper." },
    });
    const { output } = await read(tool, {
      mode: "targeted",
      sections: ["abstract", "results"],
      targets: [{ itemId: 40 }],
    });
    const row = rowOf(output, 40);
    const warnings = output.warnings || [];
    // The paper has this section: it is "no readable text", never "not found".
    assert.deepEqual(warnings, ["No readable text for Ito, 2022: results."]);
    assert.notInclude(warnings, SECTIONS_NOT_FOUND_RULE);
  });

  it("states the not-found rule once for several papers, and once for a partial and a no-match paper together", async function () {
    const tool = makeTool({
      abstractNotes: {
        10: "The Zotero record's own abstract says that drift leaves decoding intact.",
      },
    });
    const ruleCount = (output: Output) =>
      (output.warnings || []).filter((w) => w === SECTIONS_NOT_FOUND_RULE)
        .length;
    const notFoundLines = (output: Output) =>
      (output.warnings || []).filter((w) => w.startsWith("Not found in"));
    // Two partial-match papers.
    const partial = (
      await read(tool, {
        mode: "targeted",
        sections: ["results", "acknowledgements"],
        targets: [{ itemId: 10 }, { itemId: 20 }],
      })
    ).output;
    assert.equal(rowOf(partial, 10).status, "complete");
    assert.deepEqual(rowOf(partial, 10).unmatched, ["acknowledgements"]);
    assert.deepEqual(rowOf(partial, 20).unmatched, ["acknowledgements"]);
    assert.lengthOf(notFoundLines(partial), 2);
    assert.equal(ruleCount(partial), 1);
    for (const line of notFoundLines(partial))
      assert.notInclude(line, SECTIONS_NOT_FOUND_RULE);
    // One partial-match paper and one with none of the names.
    const mixed = (
      await read(tool, {
        mode: "targeted",
        sections: ["results", "acknowledgements"],
        targets: [{ itemId: 20 }, { itemId: 30 }],
      })
    ).output;
    assert.equal(rowOf(mixed, 20).covered.length, 1);
    assert.equal(rowOf(mixed, 30).status, "no_matching_sections");
    assert.lengthOf(notFoundLines(mixed), 2);
    assert.equal(ruleCount(mixed), 1);
    assert.include(mixed.note || "", "Nothing read for");
    // Every name found: no rule.
    const found = (
      await read(tool, {
        mode: "targeted",
        sections: ["results"],
        targets: [{ itemId: 10 }, { itemId: 20 }],
      })
    ).output;
    assert.equal(ruleCount(found), 0);
  });

  it("caps an explicit maxChars at the adaptive reading budget", async function () {
    const tool = makeTool({
      abstractNotes: {
        10: "The Zotero record's own abstract says that drift leaves decoding intact.",
      },
    });
    const { output } = await read(
      tool,
      {
        mode: "targeted",
        sections: ["abstract", "results"],
        targets: [{ itemId: 10 }],
        maxChars: 1_000_000,
      },
      {
        // About 160 characters for the one paper.
        runtimeContextBudget: {
          contextWindowTokens: 1_000_000,
          usedContextTokens: 0,
          maxTokensPerPaper: 40,
        },
      },
    );
    const row = rowOf(output, 10);
    assert.equal(row.status, "partial");
    const cutWarning = (output.warnings || []).join("\n");
    assert.include(cutWarning, "Cut by the read budget");
    assert.include(cutWarning, "Read that section alone");
    assert.notInclude(cutWarning, "larger maxChars");
  });

  it("reads nothing of a paper with no matching section and names it", async function () {
    const tool = makeTool({});
    const { output } = await read(tool, {
      mode: "targeted",
      sections: ["results"],
      targets: [{ itemId: 20 }, { itemId: 30 }],
    });
    const none = rowOf(output, 30);
    assert.equal(none.status, "no_matching_sections");
    assert.deepEqual(none.passages, []);
    assert.deepEqual(none.sections, []);
    assert.include(output.note || "", "Nothing read for");
    assert.include(output.note || "", "Park");
    // The paper is named with what was not found, and is not read another way.
    assert.include(
      output.warnings || [],
      `Not found in ${none.citationLabel}: results.`,
    );
    assert.equal(
      (output.warnings || []).filter((w) => w === SECTIONS_NOT_FOUND_RULE)
        .length,
      1,
    );
    assert.notInclude(
      JSON.stringify(output),
      "Representational drift was measured",
    );
    assert.equal(rowOf(output, 20).status, "complete");
  });

  it("marks a section the read budget cut as partial, with what was cut, and records only whole sections at section depth", async function () {
    const tool = makeTool({});
    const { output, input } = await read(tool, {
      mode: "targeted",
      sections: ["abstract", "results"],
      targets: [{ itemId: 10 }],
      // The abstract (about 90 characters with its heading) fits; the
      // results (about 190) do not.
      maxChars: 160,
    });
    const row = rowOf(output, 10);
    assert.equal(row.status, "partial");
    const [abstract, results] = row.sections;
    assert.isTrue(abstract.complete);
    assert.isFalse(results.complete);
    assert.isBelow(results.characters, results.totalCharacters);
    assert.include(
      (output.warnings || []).join("\n"),
      `Results: ${results.characters} of ${results.totalCharacters} characters`,
    );
    const delta = deriveTaskPaperLedgerDelta({
      toolName: "paper_read",
      callId: "call-cut",
      input,
      content: output,
      libraryID: 1,
    });
    const reads = (delta?.reads || []).map((entry) => [
      entry.label,
      entry.granularity,
    ]);
    assert.deepEqual(reads, [
      ["Abstract", "abstract"],
      ["Results", "passage"],
    ]);
  });

  it("records a whole section at section depth, which Task progress counts as read in depth, and attests body text", async function () {
    const tool = makeTool({});
    const { output, input } = await read(tool, {
      mode: "targeted",
      sections: ["results"],
      targets: [{ itemId: 10 }],
    });
    const delta = deriveTaskPaperLedgerDelta({
      toolName: "paper_read",
      callId: "call-whole",
      input,
      content: output,
      libraryID: 1,
    });
    assert.deepEqual(
      (delta?.reads || []).map((entry) => [entry.label, entry.granularity]),
      [["Results", "section"]],
    );
    assert.isTrue(isInDepthRead(delta!.reads[0]));
    const observations = await createTrustedReadObservations({
      toolName: "paper_read",
      callId: "call-whole",
      input,
      result: output,
    });
    assert.deepEqual(observations[0]?.capabilities, ["body"]);
  });

  it("attests an abstract-only sections read as the abstract, not body text", async function () {
    const tool = makeTool({});
    const { output, input } = await read(tool, {
      mode: "targeted",
      sections: ["abstract"],
      targets: [{ itemId: 10 }],
    });
    const observations = await createTrustedReadObservations({
      toolName: "paper_read",
      callId: "call-abstract",
      input,
      result: output,
    });
    assert.deepEqual(observations[0]?.capabilities, ["abstract"]);
  });

  it("does not attest body text for a section the read budget left out", async function () {
    const tool = makeTool({
      abstractNotes: {
        10: "The Zotero record's own abstract says drift is benign.",
      },
    });
    const { output, input } = await read(tool, {
      mode: "targeted",
      sections: ["abstract", "results"],
      targets: [{ itemId: 10 }],
    });
    const results = rowOf(output, 10).sections[1];
    assert.equal(results.section, "Results");
    results.characters = 0;
    results.complete = false;
    const observations = await createTrustedReadObservations({
      toolName: "paper_read",
      callId: "call-left-out",
      input,
      result: output,
    });
    assert.deepEqual(observations[0]?.capabilities, ["abstract"]);
  });

  it("records whole sections of PDF text as section reads, not embedding passages", async function () {
    const tool = makeTool({});
    const { output, input } = await read(tool, {
      mode: "targeted",
      sections: ["results"],
      targets: [{ itemId: 20 }],
    });
    const entries = buildAgentCoverageEntriesForActivity({
      toolName: "paper_read",
      input,
      content: output,
      request: {
        userText: "Read the results",
        conversationKey: 91,
      } as never,
      timestamp: 1,
    });
    assert.lengthOf(entries, 1);
    assert.equal(entries[0].sourceKind, "zotero_fulltext");
    assert.equal(entries[0].granularity, "section");
  });

  it("keeps the ranked targeted read when a query is given", async function () {
    const retrieveCalls: unknown[] = [];
    const tool = makeTool({ retrieveCalls });
    const { output } = await read(tool, {
      mode: "targeted",
      query: "decoding accuracy",
      sections: ["results"],
      targets: [{ itemId: 20 }],
    });
    assert.lengthOf(retrieveCalls, 1);
    assert.notEqual(output.read, "whole_sections");
  });

  it("shows the model each passage's id but not the citation records", async function () {
    const tool = makeTool({});
    const { output, input } = await read(tool, {
      mode: "targeted",
      sections: ["results"],
      targets: [{ itemId: 10 }],
    });
    assert.isNotEmpty(output.quoteCitations);
    const view = tool.modelContent!(output, input as never) as Output;
    assert.notProperty(view, "quoteCitations");
    assert.match(view.papers[0].passages[0].quoteCitationId || "", /^Q_/);
  });
});

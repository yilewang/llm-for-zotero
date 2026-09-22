import { assert } from "chai";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import { RetrievalService } from "../src/agent/services/retrievalService";
import { isPaperEvidenceFrontierEligible } from "../src/agent/context/paperEvidenceFrontier";
import type { AgentToolContext, AgentToolDefinition } from "../src/agent/types";
import type { PdfContext } from "../src/services/paperContent/types";
import { classifiedFixture } from "./helpers/semanticIntent";
import {
  buildFixturePdfContext,
  restoreTestGlobals,
  snapshotTestGlobals,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";
import { withImageRetrieval } from "./helpers/retrievalMocks";

type OutlineSection = {
  sectionId: string;
  title: string;
  level: number;
  path: string;
  chunkIndexes: [number, number];
  chars: number;
};

type OutlinePayload = {
  sections: OutlineSection[];
  totalChunks: number;
  structure?: { sectionsBuilt?: number };
};

type OutlineResult = {
  mode: string;
  papers: Array<{
    status: string;
    sourceLabel?: string;
    citationLabel?: string;
    outline: OutlinePayload;
  }>;
  quoteCitations?: unknown[];
};

type TargetedPassage = {
  text?: string;
  chunkIndex?: number;
  sectionLabel?: string;
  sectionPath?: string;
  why?: { bm25Rank?: number };
  quoteAnchors?: string[];
  quoteCitationId?: string;
};

type TargetedResult = {
  mode: string;
  results?: unknown[];
  papers: Array<{
    status: string;
    passages: TargetedPassage[];
    outline?: OutlinePayload;
  }>;
  quoteCitations?: Array<{ id: string }>;
  warnings?: string[];
};

const ATTACHMENT_ID = 9401;
const KINEMATIC_SECTION_TITLE = "2.2 Kinematic condition";

const paper = {
  libraryID: 1,
  itemId: 9400,
  contextItemId: ATTACHMENT_ID,
  title: "Adaptive front tracking for lubrication-type free boundary flows",
  firstCreator: "Nguyen",
  year: "2026",
};

function toolContext(): AgentToolContext {
  return {
    request: {
      classifiedIntent: classifiedFixture(),
      conversationKey: 77,
      mode: "agent",
      conversationKind: "paper",
      userText: "How is the front velocity computed?",
      libraryID: 1,
      activeItemId: paper.itemId,
    } as never,
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  };
}

describe("paper_read outline mode and section ids", function () {
  let globalsBefore: TestGlobalSnapshot;
  let ctx: PdfContext;

  before(async function () {
    globalsBefore = snapshotTestGlobals();
    ctx = await buildFixturePdfContext("mathDoubleHash", ATTACHMENT_ID);
  });

  after(function () {
    restoreTestGlobals(globalsBefore);
  });

  function createTool(): AgentToolDefinition<never, unknown> {
    const pdfService = {
      ensurePaperContext: async () => ctx,
    } as never;
    const retrievalService = new RetrievalService({
      ensurePaperContext: async () => ctx,
    } as never);
    return createPaperReadTool(
      pdfService,
      retrievalService as never,
      {} as never,
      {
        listPaperContexts: () => [paper],
        resolvePaperContextTarget: (target: { itemId?: number }) =>
          target.itemId === paper.itemId ? paper : null,
      } as never,
    ) as unknown as AgentToolDefinition<never, unknown>;
  }

  /**
   * A paper whose second section carries a heading but no text: the section is
   * in the outline, so it can be requested, and it holds no passage.
   */
  const emptySectionContext = {
    title: paper.title,
    chunks: ["The front velocity follows from the kinematic condition."],
    chunkMeta: [
      {
        chunkIndex: 0,
        text: "The front velocity follows from the kinematic condition.",
        normalizedText:
          "the front velocity follows from the kinematic condition.",
        chunkKind: "body",
        sectionIndex: 0,
        sectionLabel: "1 Introduction",
        sectionPath: "1 Introduction",
        sectionLevel: 1,
      },
      {
        chunkIndex: 1,
        text: "",
        normalizedText: "",
        chunkKind: "body",
        sectionIndex: 1,
        sectionLabel: "2 Numerical algorithm",
        sectionPath: "2 Numerical algorithm",
        sectionLevel: 1,
      },
    ],
    chunkStats: [],
    docFreq: {},
    avgChunkLength: 56,
    fullLength: 56,
  } as unknown as PdfContext;

  function emptySectionTool(
    papers: (typeof paper)[],
  ): AgentToolDefinition<never, unknown> {
    return createPaperReadTool(
      { ensurePaperContext: async () => emptySectionContext } as never,
      withImageRetrieval({ retrieveEvidence: async () => [] }) as never,
      {} as never,
      {
        listPaperContexts: () => papers,
        resolvePaperContextTarget: (target: { itemId?: number }) =>
          papers.find((entry) => entry.itemId === target.itemId) || null,
      } as never,
    ) as unknown as AgentToolDefinition<never, unknown>;
  }

  async function run(
    args: Record<string, unknown>,
    tool = createTool(),
  ): Promise<unknown> {
    const validated = tool.validate({
      targets: [{ itemId: paper.itemId, contextItemId: paper.contextItemId }],
      ...args,
    });
    assert.isTrue(
      validated.ok,
      validated.ok ? "" : `validation failed: ${validated.error}`,
    );
    if (!validated.ok) throw new Error(validated.error);
    return tool.execute(validated.value, toolContext());
  }

  async function readOutline(): Promise<OutlineResult> {
    return (await run({ mode: "outline" })) as OutlineResult;
  }

  async function kinematicSectionId(): Promise<string> {
    const outline = await readOutline();
    const section = outline.papers[0].outline.sections.find(
      (entry) => entry.title === KINEMATIC_SECTION_TITLE,
    );
    assert.isDefined(section, "fixture has a kinematic-condition section");
    return section?.sectionId || "";
  }

  it("lists every section with ids, levels, paths, and chunk ranges", async function () {
    const output = await readOutline();
    assert.equal(output.mode, "outline");
    assert.lengthOf(output.papers, 1);
    const group = output.papers[0];
    assert.equal(group.status, "matched");
    assert.equal(group.sourceLabel, "(Nguyen, 2026)");
    const outline = group.outline;
    assert.equal(outline.totalChunks, ctx.chunks.length);
    const titles = outline.sections.map((section) => section.title);
    assert.includeMembers(titles, [
      "1 Introduction and model statement",
      "2 Numerical algorithm",
      KINEMATIC_SECTION_TITLE,
      "5 Conclusion",
    ]);
    for (const section of outline.sections) {
      assert.match(section.sectionId, /^s\d+$/, section.title);
      assert.isAtLeast(section.level, 1, section.title);
      assert.isString(section.path);
      assert.isNotEmpty(section.path, section.title);
      assert.lengthOf(section.chunkIndexes, 2, section.title);
      assert.isAtMost(
        section.chunkIndexes[0],
        section.chunkIndexes[1],
        section.title,
      );
      assert.isAbove(section.chars, 0, section.title);
    }
    const starts = outline.sections.map((section) => section.chunkIndexes[0]);
    assert.deepEqual(
      starts,
      [...starts].sort((left, right) => left - right),
      "sections are listed in document order",
    );
    assert.isAtLeast(outline.structure?.sectionsBuilt || 0, 1);
    assert.isUndefined(output.quoteCitations, "outline reads carry no anchors");
  });

  it("keeps outline reads out of the paper-evidence frontier", function () {
    assert.isFalse(isPaperEvidenceFrontierEligible({ mode: "outline" }));
    assert.isTrue(isPaperEvidenceFrontierEligible({ mode: "targeted" }));
  });

  it("restricts a targeted read to the requested sectionIds", async function () {
    const sectionId = await kinematicSectionId();
    const output = (await run({
      mode: "targeted",
      query: "How is the velocity of the free boundary computed?",
      sectionIds: [sectionId],
    })) as TargetedResult;
    const passages = output.papers[0].passages;
    assert.isNotEmpty(passages);
    for (const passage of passages) {
      assert.isString(passage.sectionPath, passage.text);
      assert.match(
        passage.sectionPath || "",
        new RegExp(`${KINEMATIC_SECTION_TITLE}$`),
      );
      assert.isNumber(passage.why?.bm25Rank, "passages explain their ranking");
    }
  });

  it("drops unknown sectionIds with a warning and still reads the paper", async function () {
    const output = (await run({
      mode: "targeted",
      query: "How is the velocity of the free boundary computed?",
      sectionIds: ["s99"],
    })) as TargetedResult;
    assert.include(output.warnings || [], "Unknown sectionIds ignored: s99");
    assert.isNotEmpty(output.papers[0].passages);
  });

  it("warns when the requested section holds no text", async function () {
    const output = (await run(
      {
        mode: "targeted",
        query: "How is the velocity of the free boundary computed?",
        sectionIds: ["s1"],
      },
      emptySectionTool([paper]),
    )) as TargetedResult;
    assert.include(
      output.warnings || [],
      "Requested sections contain no passages: s1",
      `warnings were ${JSON.stringify(output.warnings)}`,
    );
    assert.equal(output.papers[0].status, "no_matches");
  });

  it("names the paper in the warning when several papers are read", async function () {
    const other = {
      ...paper,
      itemId: 9500,
      contextItemId: 9501,
      title: "A second paper on front tracking",
      firstCreator: "Orion",
      year: "2025",
    };
    const tool = emptySectionTool([paper, other]);
    const validated = tool.validate({
      mode: "targeted",
      query: "How is the velocity of the free boundary computed?",
      sectionIds: ["s1"],
      targets: [
        { itemId: paper.itemId, contextItemId: paper.contextItemId },
        { itemId: other.itemId, contextItemId: other.contextItemId },
      ],
    });
    assert.isTrue(
      validated.ok,
      validated.ok ? "" : `validation failed: ${validated.error}`,
    );
    if (!validated.ok) return;
    const output = (await tool.execute(
      validated.value,
      toolContext(),
    )) as TargetedResult;
    assert.deepEqual(output.warnings, [
      "Requested sections contain no passages: s1 (Nguyen, 2026)",
      "Requested sections contain no passages: s1 (Orion, 2025)",
    ]);
  });

  it("does not warn when a section holds text but the read returns nothing", async function () {
    const sectionId = await kinematicSectionId();
    const tool = createPaperReadTool(
      { ensurePaperContext: async () => ctx } as never,
      withImageRetrieval({ retrieveEvidence: async () => [] }) as never,
      {} as never,
      {
        listPaperContexts: () => [paper],
        resolvePaperContextTarget: (target: { itemId?: number }) =>
          target.itemId === paper.itemId ? paper : null,
      } as never,
    ) as unknown as AgentToolDefinition<never, unknown>;
    const output = (await run(
      {
        mode: "targeted",
        query: "How is the velocity of the free boundary computed?",
        sectionIds: [sectionId],
      },
      tool,
    )) as TargetedResult;
    assert.equal(output.papers[0].status, "no_matches");
    assert.isEmpty(
      (output.warnings || []).filter((warning) =>
        warning.includes("contain no passages"),
      ),
      `warnings were ${JSON.stringify(output.warnings)}`,
    );
  });

  it("converts section names to section ids", async function () {
    const output = (await run({
      mode: "targeted",
      query: "How is the velocity of the free boundary computed?",
      sections: ["kinematic condition"],
    })) as TargetedResult;
    const passages = output.papers[0].passages;
    assert.isNotEmpty(passages);
    for (const passage of passages) {
      assert.match(
        passage.sectionPath || "",
        new RegExp(`${KINEMATIC_SECTION_TITLE}$`),
        passage.text,
      );
    }
  });

  it("warns when a section name matches no outline section", async function () {
    const output = (await run({
      mode: "targeted",
      query: "How is the velocity of the free boundary computed?",
      sections: ["telescope calibration"],
    })) as TargetedResult;
    assert.isTrue(
      (output.warnings || []).some((warning) =>
        warning.includes("telescope calibration"),
      ),
      `warnings were ${JSON.stringify(output.warnings)}`,
    );
    assert.isNotEmpty(output.papers[0].passages);
  });

  it("returns one quote anchor per targeted passage", async function () {
    const output = (await run({
      mode: "targeted",
      query: "How is the velocity of the free boundary computed?",
    })) as TargetedResult;
    const passages = output.papers[0].passages;
    assert.isNotEmpty(passages);
    for (const passage of passages) {
      assert.isAtMost((passage.quoteAnchors || []).length, 1, passage.text);
    }
    assert.isAtMost(
      (output.quoteCitations || []).length,
      passages.length,
      "no more anchors than passages",
    );
    assert.isTrue(
      passages.some((passage) => (passage.quoteAnchors || []).length === 1),
      "targeted passages still carry an anchor",
    );
  });

  it("returns a compact outline with every targeted read", async function () {
    const output = (await run({
      mode: "targeted",
      query: "How is the velocity of the free boundary computed?",
    })) as TargetedResult;
    const outline = output.papers[0].outline;
    assert.isDefined(outline);
    assert.isAtMost(outline?.sections.length || 0, 40);
    for (const section of outline?.sections || []) {
      assert.isAtMost(section.level, 2, section.title);
    }
    assert.include(
      (outline?.sections || []).map((section) => section.title),
      KINEMATIC_SECTION_TITLE,
    );
  });

  it("does not reuse an unfiltered read for a section-filtered one", async function () {
    const tool = createTool();
    const query = "How is the velocity of the free boundary computed?";
    const unfiltered = (await run(
      { mode: "targeted", query },
      tool,
    )) as TargetedResult;
    assert.isNotEmpty(unfiltered.papers[0].passages);
    const sectionId = await kinematicSectionId();
    const filtered = (await run(
      { mode: "targeted", query, sectionIds: [sectionId] },
      tool,
    )) as TargetedResult;
    for (const passage of filtered.papers[0].passages) {
      assert.match(
        passage.sectionPath || "",
        new RegExp(`${KINEMATIC_SECTION_TITLE}$`),
        passage.text,
      );
    }
  });

  it("keeps three quote candidates per overview result", async function () {
    const sentences = [
      "The adaptive front tracking scheme moves every boundary vertex by one explicit Euler step of the extended velocity field.",
      "The mixed finite element system is assembled with the mobility frozen at the previous time level for stability.",
      "A local mesh rebuild is triggered whenever the minimum angle of the deformed triangulation drops below the tolerance.",
    ];
    const tool = createPaperReadTool(
      {
        getOverviewExcerpt: async ({
          paperContext,
        }: {
          paperContext: unknown;
        }) => ({
          backend: "raw_pdf_text",
          text: sentences.join("\n\n"),
          chunkIndexes: [0, 1, 2],
          totalChunks: 3,
          citationLabel: "Nguyen, 2026",
          sourceLabel: "(Nguyen, 2026)",
          paperContext,
        }),
      } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [paper],
        resolvePaperContextTarget: () => paper,
      } as never,
    ) as unknown as AgentToolDefinition<never, unknown>;
    const output = (await run({ mode: "overview" }, tool)) as {
      results?: Array<{ quoteAnchors?: string[] }>;
      quoteCitations?: unknown[];
    };
    assert.lengthOf(output.results?.[0]?.quoteAnchors || [], 3);
    assert.lengthOf(output.quoteCitations || [], 3);
  });

  it("advertises outline mode and sectionIds on the tool schema", function () {
    const schema = createTool().spec.inputSchema as {
      properties: Record<string, Record<string, unknown>>;
    };
    assert.include(schema.properties.mode.enum as string[], "outline");
    assert.deepEqual(schema.properties.sectionIds, {
      type: "array",
      items: { type: "string" },
      description:
        "Section ids from an outline read; restricts a targeted read to those sections",
    });
  });

  it("summarises an outline read by its section count", async function () {
    const tool = createTool();
    const output = await readOutline();
    const onSuccess = tool.presentation?.summaries?.onSuccess;
    assert.isFunction(onSuccess);
    if (typeof onSuccess !== "function") return;
    assert.equal(
      onSuccess({ label: "Read Paper", content: output }),
      `Read outline (${output.papers[0].outline.sections.length} sections)`,
    );
  });
});

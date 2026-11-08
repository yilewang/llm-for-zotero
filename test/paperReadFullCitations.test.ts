import { assert } from "chai";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import { PassageCitationCollector } from "../src/agent/context/passageCitationCollector";
import type { ExhaustiveBatchAnalyzer } from "../src/shared/exhaustiveDocumentReader";
import type { AgentToolContext, AgentToolDefinition } from "../src/agent/types";
import type { PdfContext } from "../src/services/paperContent/types";
import type { QuoteCitation } from "../src/shared/types";

/**
 * paper_read mode:'full' returns the exact chunks its reader found relevant;
 * each now carries a host-minted citation id, as a targeted passage does.
 */

const paper = {
  libraryID: 1,
  itemId: 9800,
  contextItemId: 9801,
  title: "Grid cells in full",
  firstCreator: "Lee",
  year: "2025",
};

const CHUNKS = [
  "Introduction\nGrid cells in the entorhinal cortex fire in a hexagonal lattice across space.",
  "Results\nThe lattice spacing grew along the dorsoventral axis in every animal we recorded.",
  "Discussion\nA modular code of this kind supports path integration over long distances.",
];

const paperContent = {
  title: paper.title,
  chunks: CHUNKS,
  chunkMeta: [],
  chunkStats: [],
  docFreq: {},
  avgChunkLength: 80,
  fullLength: CHUNKS.join("\n\n").length,
} as unknown as PdfContext;

type FullOutput = {
  mode: string;
  status: string;
  papers: Array<{
    exactEvidence: Array<{
      chunkIndex: number;
      text: string;
      quoteCitationId?: string;
    }>;
  }>;
  quoteCitations?: QuoteCitation[];
};

function toolContext(): AgentToolContext {
  return {
    request: {
      conversationKey: 80,
      mode: "agent",
      conversationKind: "paper",
      userText: "Read the paper in full.",
      libraryID: 1,
      activeItemId: paper.itemId,
    } as never,
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  };
}

const analyzer: ExhaustiveBatchAnalyzer = async (input) => ({
  digest: "The paper reports a hexagonal code whose spacing grows ventrally.",
  relevantChunkIds: input.chunks
    .map((chunk) => chunk.chunkIndex)
    .filter((index) => index !== 2),
});

async function fullRead(): Promise<{
  tool: AgentToolDefinition<never, unknown>;
  output: FullOutput;
  input: unknown;
}> {
  const tool = createPaperReadTool(
    { ensurePaperContext: async () => paperContent } as never,
    {} as never,
    {} as never,
    {
      listPaperContexts: () => [paper],
      resolvePaperContextTarget: () => paper,
    } as never,
    undefined,
    analyzer,
  ) as unknown as AgentToolDefinition<never, unknown>;
  const validated = tool.validate({
    mode: "full",
    targets: [{ itemId: paper.itemId, contextItemId: paper.contextItemId }],
  });
  if (!validated.ok) throw new Error(validated.error);
  const output = (await tool.execute(
    validated.value,
    toolContext(),
  )) as FullOutput;
  return { tool, output, input: validated.value };
}

describe("paper_read full citation ids", function () {
  it("gives each exact evidence chunk a registered citation id cut from its own text", async function () {
    const { output } = await fullRead();
    assert.equal(output.status, "complete");
    const evidence = output.papers[0].exactEvidence;
    assert.deepEqual(
      evidence.map((chunk) => chunk.chunkIndex),
      [0, 1],
    );
    const registered = new Map(
      (output.quoteCitations || []).map((entry) => [entry.id, entry]),
    );
    for (const chunk of evidence) {
      assert.match(chunk.quoteCitationId || "", /^Q_/, chunk.text);
      const citation = registered.get(chunk.quoteCitationId!);
      assert.exists(citation, `id ${chunk.quoteCitationId} is registered`);
      assert.include(chunk.text.replace(/\s+/g, " "), citation!.quoteText);
      assert.equal(citation!.itemId, paper.itemId);
      assert.equal(citation!.contextItemId, paper.contextItemId);
    }
  });

  it("shows the model the ids but not the citation records, and the run collects both", async function () {
    const { tool, output, input } = await fullRead();
    const view = tool.modelContent!(output, input as never) as FullOutput;
    assert.notProperty(view, "quoteCitations");
    assert.match(view.papers[0].exactEvidence[0].quoteCitationId || "", /^Q_/);
    const collector = new PassageCitationCollector();
    collector.collect(output);
    const id = output.papers[0].exactEvidence[1].quoteCitationId!;
    assert.include(
      collector.quoteCitations.map((entry) => entry.id),
      id,
    );
    assert.include(
      collector.passageTextByCitationId.get(id) || "",
      "lattice spacing grew",
    );
  });

  describe("quote text cut from MinerU chunks", function () {
    const HEADING =
      "Striatal Direct- and Indirect-Pathway SPNs Are Co-active during Self-Paced Movements";

    async function quotesOf(
      chunks: string[],
    ): Promise<Array<{ text: string; id?: string; quoteText?: string }>> {
      const content = {
        ...paperContent,
        chunks,
        fullLength: chunks.join("\n\n").length,
      } as unknown as PdfContext;
      const tool = createPaperReadTool(
        { ensurePaperContext: async () => content } as never,
        {} as never,
        {} as never,
        {
          listPaperContexts: () => [paper],
          resolvePaperContextTarget: () => paper,
        } as never,
        undefined,
        async (input) => ({
          digest: "Every chunk is relevant.",
          relevantChunkIds: input.chunks.map((chunk) => chunk.chunkIndex),
        }),
      ) as unknown as AgentToolDefinition<never, unknown>;
      const validated = tool.validate({
        mode: "full",
        targets: [{ itemId: paper.itemId, contextItemId: paper.contextItemId }],
      });
      if (!validated.ok) throw new Error(validated.error);
      const output = (await tool.execute(
        validated.value,
        toolContext(),
      )) as FullOutput;
      const byId = new Map(
        (output.quoteCitations || []).map((entry) => [entry.id, entry]),
      );
      return output.papers[0].exactEvidence.map((chunk) => {
        const quoteText = chunk.quoteCitationId
          ? byId.get(chunk.quoteCitationId)?.quoteText
          : undefined;
        if (quoteText)
          assert.include(chunk.text.replace(/\s+/g, " "), quoteText);
        return { text: chunk.text, id: chunk.quoteCitationId, quoteText };
      });
    }

    it("cuts the quote from the body, not from the heading above it", async function () {
      const [blankLine, adjacent] = await quotesOf([
        `# ${HEADING}\n\nTo study neuronal activities in the striatum, we imaged both pathways in freely moving mice.`,
        `# ${HEADING}\nTo study neuronal activities in the striatum, we imaged both pathways in freely moving mice.`,
      ]);
      for (const entry of [blankLine, adjacent]) {
        assert.match(entry.id || "", /^Q_/);
        assert.match(entry.quoteText || "", /^To study neuronal activities/);
        assert.notInclude(entry.quoteText || "", "Self-Paced");
      }
    });

    it("mints no id for a chunk that is only a heading", async function () {
      const [heading, body] = await quotesOf([
        `# ${HEADING}`,
        "The lattice spacing grew along the dorsoventral axis in every animal we recorded.",
      ]);
      assert.isUndefined(heading.id);
      assert.match(body.id || "", /^Q_/);
    });

    it("never cuts a quote inside inline math", async function () {
      const [mixed, mathOnly] = await quotesOf([
        "Mice were anesthetized with isoflurane $1 \\% - 3 \\%$ , plus oxygen at $1 { - } 1 . 5 \\ V \\mathrm { m i n } )$ ) anesthesia during surgery. Mice were then placed in a stereotaxic frame and kept warm on a heating pad.",
        "Mice were anesthetized with isoflurane $1 \\% - 3 \\%$ , plus oxygen at $1 { - } 1 . 5 \\ V \\mathrm { m i n } )$ ) anesthesia during surgery.",
      ]);
      const mixedDollars = (mixed.quoteText || "").split("$").length - 1;
      assert.isAbove(mixedDollars, 0, "the first eligible sentence is quoted");
      assert.equal(mixedDollars % 2, 0, mixed.quoteText);
      assert.match(mixed.quoteText || "", /anesthesia during surgery\.$/);
      const dollars = (mathOnly.quoteText || "").split("$").length - 1;
      assert.isAbove(dollars, 0, "the math sentence is still the fallback");
      assert.equal(dollars % 2, 0, mathOnly.quoteText);
      assert.match(mathOnly.quoteText || "", /anesthesia during surgery\.$/);
    });

    it("treats a heading line inside a block as a boundary, never joining the text around it", async function () {
      const [entry, headingFirst] = await quotesOf([
        "Neurons fired.\n# Results\nSpiny neurons fired in bursts during movement onset in all mice.",
        "# Results\nNeurons fired.\n## Methods\nSpiny neurons fired in bursts during movement onset in all mice.",
      ]);
      for (const chunk of [entry, headingFirst]) {
        assert.equal(
          chunk.quoteText,
          "Spiny neurons fired in bursts during movement onset in all mice.",
        );
        assert.include(chunk.text.replace(/\s+/g, " "), chunk.quoteText!);
      }
    });

    it("keeps the head of a sentence that cites et al.", async function () {
      const [entry] = await quotesOf([
        "Prior work (Smith et al., 2013) showed that striatal neurons encode action sequences during learning.",
      ]);
      assert.equal(
        entry.quoteText,
        "Prior work (Smith et al., 2013) showed that striatal neurons encode action sequences during learning.",
      );
    });

    it("falls back to a shorter sentence when the first one is too long to quote", async function () {
      const longMath = `The model is defined by ${Array.from(
        { length: 30 },
        (_, i) => `$w_{${i}} . x_{${i}}$`,
      ).join(" plus ")} for every trial.`;
      assert.isAbove(longMath.length, 360);
      const [entry] = await quotesOf([
        `${longMath} The fitted weights $w$ were stable across sessions and animals.`,
      ]);
      assert.match(entry.id || "", /^Q_/);
      assert.equal(
        entry.quoteText,
        "The fitted weights $w$ were stable across sessions and animals.",
      );
    });
  });
});

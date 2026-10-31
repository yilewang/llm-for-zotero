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
});

import { assert } from "chai";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import type { AgentToolContext, AgentToolDefinition } from "../src/agent/types";
import type { PdfContext } from "../src/services/paperContent/types";
import type { QuoteCitation } from "../src/shared/types";
import { hasVerifiedQuoteLocation } from "../src/services/quotes/quoteCitations";

const paper = {
  libraryID: 1,
  itemId: 9500,
  contextItemId: 9501,
  title: "Hippocampal subspaces",
  firstCreator: "Lee",
  year: "2025",
};

const paperContent = {
  title: paper.title,
  chunks: ["Body text."],
  chunkMeta: [
    {
      chunkIndex: 0,
      text: "Body text.",
      normalizedText: "body text.",
      chunkKind: "body",
      sectionIndex: 0,
      sectionLabel: "Results",
      sectionPath: "Results",
      sectionLevel: 1,
    },
  ],
  chunkStats: [],
  docFreq: {},
  avgChunkLength: 10,
  fullLength: 10,
} as unknown as PdfContext;

type Passage = {
  text?: string;
  quoteCitationId?: string;
  quoteCitationIds?: string[];
  quoteAnchors?: string[];
};

type ReadOutput = {
  papers?: Array<{ passages: Passage[] }>;
  results?: Array<{ quoteCitationIds?: string[] }>;
  quoteCitations?: QuoteCitation[];
};

function toolContext(): AgentToolContext {
  return {
    request: {
      conversationKey: 78,
      mode: "agent",
      conversationKind: "paper",
      userText: "What do the subspaces do?",
      libraryID: 1,
      activeItemId: paper.itemId,
    } as never,
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  };
}

const gateway = {
  listPaperContexts: () => [paper],
  resolvePaperContextTarget: () => paper,
} as never;

async function runTargeted(
  text: string,
  resultFields: Record<string, unknown> = {},
): Promise<ReadOutput> {
  const tool = createPaperReadTool(
    { ensurePaperContext: async () => paperContent } as never,
    {
      retrieveEvidence: async () => [
        {
          paperContext: paper,
          text,
          chunkIndex: 0,
          chunkKind: "body",
          sectionLabel: "Results",
          score: 1,
          citationLabel: "Lee, 2025",
          sourceLabel: "(Lee, 2025)",
          ...resultFields,
        },
      ],
    } as never,
    {} as never,
    gateway,
  ) as unknown as AgentToolDefinition<never, unknown>;
  const validated = tool.validate({
    mode: "targeted",
    query: "subspaces",
    targets: [{ itemId: paper.itemId, contextItemId: paper.contextItemId }],
  });
  if (!validated.ok) throw new Error(validated.error);
  return (await tool.execute(validated.value, toolContext())) as ReadOutput;
}

/** Every id shown to the model must resolve to a registered citation. */
function assertShownIdsRegistered(output: ReadOutput): void {
  const registered = new Set((output.quoteCitations || []).map((c) => c.id));
  for (const passage of output.papers?.[0]?.passages || []) {
    for (const id of [
      passage.quoteCitationId,
      ...(passage.quoteCitationIds || []),
    ].filter(Boolean)) {
      assert.isTrue(registered.has(id!), `shown id ${id} is not registered`);
    }
    for (const anchor of passage.quoteAnchors || []) {
      const id = /\[\[quote:([^\]]+)\]\]/.exec(anchor)?.[1] || "";
      assert.isTrue(
        registered.has(id),
        `shown anchor ${anchor} is not registered`,
      );
    }
  }
  for (const result of output.results || []) {
    for (const id of result.quoteCitationIds || []) {
      assert.isTrue(registered.has(id), `shown id ${id} is not registered`);
    }
  }
}

describe("paper_read quote anchors", function () {
  it("anchors a targeted passage whose first sentence run is rejected as metadata", async function () {
    const prose =
      "We find that CA1 flexibly reconfigures a shared pool of neurons to integrate distinct inputs from upstream areas.";
    const output = await runTargeted(
      `Published online: 12 April 2023 by Springer Nature Limited, with all rights reserved.\n\n${prose}`,
    );
    const passage = output.papers?.[0]?.passages[0];
    assert.isDefined(passage?.quoteCitationId, "the passage keeps an anchor");
    const citation = output.quoteCitations?.find(
      (entry) => entry.id === passage?.quoteCitationId,
    );
    assert.equal(citation?.quoteText, prose);
    assert.lengthOf(passage?.quoteAnchors || [], 1);
    assertShownIdsRegistered(output);
  });

  it("never shows a targeted passage an id that the returned citations lack", async function () {
    // Four words, long enough for a candidate but short of the merged list's
    // substantive-text rule: the id used to be shown and then dropped.
    const output = await runTargeted(
      "Hippocampal subspaces reconfigure dynamically.",
    );
    assertShownIdsRegistered(output);
  });

  it("never shows an overview result an id that the returned citations lack", async function () {
    const tool = createPaperReadTool(
      {
        getOverviewExcerpt: async ({
          paperContext,
        }: {
          paperContext: unknown;
        }) => ({
          backend: "raw_pdf_text",
          text: [
            "Hippocampal subspaces reconfigure dynamically.",
            "We find that CA1 flexibly reconfigures a shared pool of neurons to integrate distinct inputs from upstream areas.",
          ].join("\n\n"),
          chunkIndexes: [0, 1],
          totalChunks: 2,
          citationLabel: "Lee, 2025",
          sourceLabel: "(Lee, 2025)",
          paperContext,
        }),
      } as never,
      {} as never,
      {} as never,
      gateway,
    ) as unknown as AgentToolDefinition<never, unknown>;
    const validated = tool.validate({
      mode: "overview",
      targets: [{ itemId: paper.itemId, contextItemId: paper.contextItemId }],
    });
    if (!validated.ok) throw new Error(validated.error);
    const output = (await tool.execute(
      validated.value,
      toolContext(),
    )) as ReadOutput;
    assert.isNotEmpty(output.quoteCitations || []);
    assertShownIdsRegistered(output);
  });

  it("mints single-page chunk text as context text with only a page hint", async function () {
    // A MinerU chunk's page is its section heading's page, not proof of where
    // the passage sits; only page-text evidence may claim a PDF location.
    const prose =
      "We find that CA1 flexibly reconfigures a shared pool of neurons to integrate distinct inputs from upstream areas.";
    const output = await runTargeted(prose, {
      pageStart: 4,
      pageEnd: 4,
      pageLabel: "5",
      sourceFingerprint: "fnv1a32-967e9405",
    });
    const citation = output.quoteCitations?.[0];
    assert.isDefined(citation);
    assert.equal(citation!.sourceMatchSource, "context-text");
    assert.equal(citation!.pageHintIndex, 4);
    assert.equal(citation!.pageHintLabel, "5");
    assert.isUndefined(citation!.sourceMatchPageOccurrence);
    assert.isFalse(hasVerifiedQuoteLocation(citation!));
    assertShownIdsRegistered(output);
  });
});
